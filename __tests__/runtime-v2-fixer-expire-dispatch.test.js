import { execFileSync } from 'node:child_process';
import { readFile, mkdtemp, mkdir, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { bindClaudeSubagent, launchClaudeIntent } from '../lib/runtime/claude-dispatch.js';
import { runtimePaths } from '../lib/runtime/paths.js';
import {
  compactStatus,
  expireDispatch,
  recordReceipt,
  resumeRun,
  startRun,
  statusRun,
} from '../lib/runtime/service.js';
import { atomicWriteJson, readJson } from '../lib/runtime/storage.js';

// frictions #27/#30: once a Claude dispatch intent is launched/bound, the runtime
// refuses re-issue and next/resume report dispatch_pending until the ticket
// deadline. A dead parent session (friction #27) or an alive agent that returned prose
// instead of the receipt (friction #30) wedges the run with no lever but abort. The
// audited expire-dispatch action voids the flight, mirrors the deadline-
// timeout transition (retry once, then honest block), and revokes the old
// receipt capability.

const cleanups = [];
afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

function git(cwd, ...args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

async function project() {
  const dir = await mkdtemp(path.join(tmpdir(), 'ape-expire-dispatch-'));
  cleanups.push(dir);
  await mkdir(path.join(dir, 'src'));
  await mkdir(path.join(dir, 'tests'));
  await writeFile(path.join(dir, 'src', 'value.js'), 'export const value = 1;\n');
  await writeFile(path.join(dir, 'tests', 'value.test.js'), 'throw new Error("red");\n');
  git(dir, 'init', '-q');
  git(dir, 'config', 'user.email', 'ape@example.test');
  git(dir, 'config', 'user.name', 'APE Test');
  git(dir, 'add', '.');
  git(dir, 'commit', '-qm', 'test: baseline');
  await atomicWriteJson(runtimePaths(dir).config, {
    shipping: { auto_merge: false, provider: 'github', required_remote_checks: false },
    test_commands: { full: 'node --test' },
  });
  return dir;
}

function startInput(overrides = {}) {
  return {
    objective: 'Exercise the audited dispatch-expiry lever',
    mode: 'phase',
    lane: 'fast',
    host: 'claude',
    claimed_paths: ['src/value.js'],
    test_paths: ['tests/value.test.js'],
    requirements: [],
    risk_triggers: [],
    behavioral: true,
    hooks_trusted: true,
    subagents_available: true,
    explicit_invocation: true,
    ...overrides,
  };
}

async function intentForTicket(dir, ticketId) {
  const paths = runtimePaths(dir);
  const names = (await readdir(paths.dispatchIntents)).filter((name) => name.endsWith('.json'));
  for (const name of names) {
    const file = path.join(paths.dispatchIntents, name);
    const record = await readJson(file, null);
    if (record?.ticket_id === ticketId) return { file, record };
  }
  return null;
}

// Wedge the run exactly like the field incidents: launch and bind the intent
// through the runtime, then never record a receipt.
async function bindWedgedFlight(dir, dispatchAction) {
  const paths = runtimePaths(dir);
  const state = await readJson(paths.active, null);
  const launch = await launchClaudeIntent(paths, state, {
    session_id: 'wedged-parent',
    tool_use_id: 'wedged-agent-call',
    tool_input: {
      subagent_type: dispatchAction.dispatch.agent_type,
      prompt: dispatchAction.dispatch.dispatch_intent.prompt,
      model: dispatchAction.dispatch.model.model,
    },
  });
  expect(launch.valid).toBe(true);
  const bound = await bindClaudeSubagent(paths, state, {
    session_id: 'wedged-parent',
    agent_id: 'wedged-agent',
    agent_type: dispatchAction.dispatch.agent_type,
  });
  expect(bound.valid).toBe(true);
  return bound.additional_context.match(/APE_RECEIPT_CAPABILITY=([A-Za-z0-9_-]+)/)[1];
}

describe('APE v2 audited dispatch expiry (frictions #27/#30)', () => {
  it('voids a wedged bound intent, expires the ticket, and issues a retry with a fresh nonce', async () => {
    const dir = await project();
    const started = await startRun(dir, startInput());
    expect(started.ok).toBe(true);
    const dispatchAction = started.actions.find((action) => action.type === 'dispatch_agent');
    const ticket = dispatchAction.ticket;
    const oldNonce = dispatchAction.dispatch.dispatch_intent.prompt
      .match(/APE_DISPATCH_NONCE=([A-Za-z0-9_-]+)/)?.[1];
    const capability = await bindWedgedFlight(dir, dispatchAction);
    expect(capability).toMatch(/^[A-Za-z0-9_-]{32,256}$/);

    // A nonexpired attested binding is already live. Resume reports that
    // truthfully and never issues a duplicate dispatch.
    const pending = await resumeRun(dir);
    expect(pending.ok).toBe(true);
    expect(pending).toMatchObject({
      resume_state: 'already-live',
      dispatch_state: 'live',
    });
    expect(pending.actions).toEqual([
      expect.objectContaining({
        type: 'dispatch_pending',
        ticket_id: ticket.ticket_id,
        agent_state: 'active-bound',
        reason: expect.stringMatching(/already active|did not launch a duplicate/),
      }),
    ]);
    expect(pending.actions[0]).not.toHaveProperty('deadline_at');

    const expired = await expireDispatch(dir, ticket.ticket_id, 'parent session crashed; flight is dead');
    expect(expired.ok).toBe(true);
    expect(expired.run.status).toBe('running');
    expect(expired.run.expired_tickets).toContain(ticket.ticket_id);
    expect(expired.run.attempts[ticket.stage_id]).toBe(2);

    const voided = await intentForTicket(dir, ticket.ticket_id);
    expect(voided.record.status).toBe('expired');
    expect(voided.record.expired_at).toEqual(expect.any(String));

    // The retry ticket is dispatched in the same response with a fresh nonce.
    const retry = expired.actions.find((action) => action.type === 'dispatch_agent');
    expect(retry.ticket.ticket_id).not.toBe(ticket.ticket_id);
    expect(retry.ticket.stage_id).toBe(ticket.stage_id);
    expect(retry.ticket.attempt).toBe(2);
    const freshNonce = retry.dispatch.dispatch_intent.prompt
      .match(/APE_DISPATCH_NONCE=([A-Za-z0-9_-]+)/)?.[1];
    expect(freshNonce).toMatch(/^[A-Za-z0-9_-]{32,256}$/);
    expect(freshNonce).not.toBe(oldNonce);
    const retryIntent = await intentForTicket(dir, retry.ticket.ticket_id);
    expect(retryIntent.record.status).toBe('prepared');

    // A late receipt presenting the voided capability is rejected: the ticket
    // was expired and superseded, so the old flight can no longer vote.
    await writeFile(path.join(dir, 'tests', 'value.test.js'), 'throw new Error("late red");\n');
    const late = await recordReceipt(dir, {
      ticket_id: ticket.ticket_id,
      status: 'passed',
      agent_identity: 'wedged-agent',
      receipt_capability: capability,
      tests: [{ command: 'node tests/value.test.js', passed: false, exit_code: 1, duration_ms: 1 }],
      findings: [],
      evidence: { verdict: 'pass' },
      timing: {
        started_at: ticket.issued_at,
        completed_at: new Date().toISOString(),
        duration_ms: 10,
      },
    });
    expect(late).toMatchObject({ ok: false, rejected: true });
    expect(late.errors.join(' ')).toMatch(/expired and was superseded/);

    // The lever is audited exactly like abort/override.
    const auditLines = (await readFile(runtimePaths(dir).overrideLog, 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    expect(auditLines).toEqual([
      expect.objectContaining({
        run_id: started.run.run_id,
        operation: 'expire-dispatch',
        ticket_id: ticket.ticket_id,
        reason: 'parent session crashed; flight is dead',
      }),
    ]);
  });

  it('blocks the run honestly when the expired stage has no attempts left', async () => {
    const dir = await project();
    const started = await startRun(dir, startInput());
    const first = started.actions.find((action) => action.type === 'dispatch_agent').ticket;

    const retried = await expireDispatch(dir, first.ticket_id, 'orphaned before launch');
    expect(retried.ok).toBe(true);
    const retry = retried.actions.find((action) => action.type === 'dispatch_agent').ticket;

    const blocked = await expireDispatch(dir, retry.ticket_id, 'retry agent returned prose, no receipt');
    expect(blocked.ok).toBe(true);
    expect(blocked.run.status).toBe('blocked');
    expect(blocked.run.block_reason).toMatch(/dispatch expired by operator after retry/);
    expect(blocked.run.expired_tickets).toEqual([first.ticket_id, retry.ticket_id]);
    expect(blocked.actions.some((action) => action.type === 'history_archived')).toBe(true);
    expect(blocked.successor_guidance).toMatchObject({
      version: 2,
      eligible: true,
      predecessor_run_id: blocked.run.run_id,
      retained_tree_sha: blocked.run.tree_sha,
      eligibility_reason: 'dispatch_expired',
      structured_successor_supported: false,
      recovery_action: 'override-reset',
      required_authorization: 'explicit-operator-override',
      automatic_start: false,
      automatic_ship: false,
    });
    expect((await statusRun(dir)).successor_guidance).toEqual(blocked.successor_guidance);
    expect((await compactStatus(dir)).successor_guidance).toEqual(blocked.successor_guidance);

    // Terminal for scheduling: the lever itself is no longer valid.
    const rejected = await expireDispatch(dir, retry.ticket_id, 'run is already blocked');
    expect(rejected).toMatchObject({ ok: false, reason: 'run is blocked' });
  });

  it('rejects unknown, already-expired, and receipted tickets on a host-neutral run', async () => {
    const dir = await project();
    const started = await startRun(dir, startInput({ host: 'codex' }));
    const ticket = started.run.tickets[0];

    const unknown = await expireDispatch(dir, 'no-such-ticket', 'operator typo');
    expect(unknown.ok).toBe(false);
    expect(unknown.reason).toMatch(/unknown ticket no-such-ticket/);

    await writeFile(path.join(dir, 'tests', 'value.test.js'), 'throw new Error("new red");\n');
    const recorded = await recordReceipt(dir, {
      ticket_id: ticket.ticket_id,
      status: 'passed',
      agent_identity: 'codex-agent',
      tests: [{ command: 'node tests/value.test.js', passed: false, exit_code: 1, duration_ms: 1 }],
      findings: [],
      evidence: { verdict: 'pass' },
      timing: {
        started_at: ticket.issued_at,
        completed_at: new Date(Date.parse(ticket.issued_at) + 10).toISOString(),
        duration_ms: 10,
      },
    });
    expect(recorded.ok).toBe(true);
    const receipted = await expireDispatch(dir, ticket.ticket_id, 'stage already receipted');
    expect(receipted.ok).toBe(false);
    expect(receipted.reason).toMatch(/already has a receipt/);

    const build = recorded.run.tickets.at(-1);
    expect(build.role).toBe('implementer');
    const expired = await expireDispatch(dir, build.ticket_id, 'first expiry');
    expect(expired.ok).toBe(true);
    const again = await expireDispatch(dir, build.ticket_id, 'second expiry of the same ticket');
    expect(again.ok).toBe(false);
    expect(again.reason).toMatch(/already expired/);
  });

  it('requires a non-empty audit reason', async () => {
    const dir = await project();
    const started = await startRun(dir, startInput({ host: 'codex' }));
    const ticket = started.run.tickets[0];
    await expect(expireDispatch(dir, ticket.ticket_id, '')).rejects.toThrow(
      /expire-dispatch requires an audit reason/,
    );
    await expect(expireDispatch(dir, ticket.ticket_id, '   ')).rejects.toThrow(
      /expire-dispatch requires an audit reason/,
    );
    // Nothing was expired by the refused calls.
    const state = await readJson(runtimePaths(dir).active, null);
    expect(state.expired_tickets ?? []).toEqual([]);
  });
});
