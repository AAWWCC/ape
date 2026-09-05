import { execFileSync } from 'node:child_process';
import { lstat, mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { reduceRun } from '../lib/runtime/scheduler.js';
import { abortRun, nextRun, resumeRun, startRun, statusRun } from '../lib/runtime/service.js';
import { runtimePaths } from '../lib/runtime/paths.js';
import { compactStatus } from '../lib/runtime/status-service.js';
import { atomicWriteJson, readJson } from '../lib/runtime/storage.js';
import { loadSessionGuidance } from '../lib/runtime/session-guidance.js';
import {
  bindClaudeSubagent,
  bindCodexSubagent,
  bootstrapCodexSubagent,
  launchClaudeIntent,
  launchCodexIntent,
} from '../lib/runtime/claude-dispatch.js';

// F17: an expired pending ticket must move the run forward (retry once, then
// block) instead of emitting un-launchable dispatches forever, and next/resume
// must degrade to a status-style action while a live bound intent exists.

const PAST = '2026-01-01T00:00:00.000Z';
const FUTURE = '2099-01-01T00:00:00.000Z';
const NOW = '2026-07-05T00:00:00.000Z';
const hookBinary = fileURLToPath(new URL('../bin/ape-hook.mjs', import.meta.url));

function run(overrides = {}) {
  return {
    run_id: 'run-1',
    mode: 'phase',
    lane: 'fast',
    status: 'running',
    stage: 'test',
    high_risk: false,
    tickets: [],
    receipts: [],
    attempts: {},
    remediation_cycles: 0,
    ...overrides,
  };
}

function pendingTicket(overrides = {}) {
  return {
    ticket_id: 't-expired',
    stage_id: 'test',
    role: 'test_writer',
    parallel_group: null,
    model_tier: 'balanced',
    writable: true,
    required_checks: ['red-test'],
    deadline_at: PAST,
    ...overrides,
  };
}

describe('APE v2 deadline-expired ticket transition (F17, reducer)', () => {
  it('consumes the stage retry for an expired pending ticket', () => {
    const state = run({ tickets: [pendingTicket()] });
    const actions = reduceRun(state, { type: 'NEXT', at: NOW });
    expect(actions.map((action) => action.type)).toEqual([
      'transition',
      'issue_ticket',
      'persist_state',
    ]);
    expect(actions[0].patch.attempts.test).toBe(2);
    expect(actions[0].patch.expired_tickets).toContain('t-expired');
    expect(actions[1].retry_of).toBe('t-expired');
    expect(actions[1].stage).toMatchObject({ id: 'test', role: 'test_writer' });
  });

  it('blocks when the retried ticket also expires', () => {
    const state = run({
      attempts: { test: 2 },
      expired_tickets: ['t-first'],
      tickets: [pendingTicket({ ticket_id: 't-retry' })],
    });
    const actions = reduceRun(state, { type: 'NEXT', at: NOW });
    const transition = actions.find((action) => action.type === 'transition');
    expect(transition.patch.status).toBe('blocked');
    expect(transition.patch.block_reason).toMatch(/deadline expired/);
    // Both attempts expired without a receipt: the reason stays the bare string.
    expect(transition.patch.block_reason).toBe('stage test ticket deadline expired after retry');
    expect(transition.patch.expired_tickets).toEqual(['t-first', 't-retry']);
    expect(actions.some((action) => action.type === 'release_lock')).toBe(true);
    expect(actions.some((action) => action.type === 'dispatch_agent')).toBe(false);
  });

  it("a deadline block after a failed first attempt carries that attempt's summary", () => {
    const state = run({
      attempts: { test: 2 },
      tickets: [
        pendingTicket({ ticket_id: 't-first', deadline_at: FUTURE }),
        pendingTicket({ ticket_id: 't-retry' }),
      ],
      receipts: [
        { ticket_id: 't-first', status: 'failed', evidence: { summary: 'agent returned prose, no receipt' } },
      ],
    });
    const actions = reduceRun(state, { type: 'NEXT', at: NOW });
    const transition = actions.find((action) => action.type === 'transition');
    expect(transition.patch.status).toBe('blocked');
    // Attempt 2 expired without a receipt and is omitted; attempt 1's failure
    // summary rides along so an operator can see why the stage was retried.
    expect(transition.patch.block_reason).toBe(
      'stage test ticket deadline expired after retry: attempt 1: agent returned prose, no receipt',
    );
  });

  it('still dispatches pending tickets whose deadlines have not elapsed', () => {
    const state = run({ tickets: [pendingTicket({ deadline_at: FUTURE })] });
    const actions = reduceRun(state, { type: 'NEXT', at: NOW });
    expect(actions).toEqual([
      expect.objectContaining({ type: 'dispatch_agent', ticket_id: 't-expired' }),
    ]);
  });

  it('never re-dispatches a ticket already marked expired', () => {
    const state = run({
      attempts: { test: 2 },
      expired_tickets: ['t-expired'],
      tickets: [pendingTicket()],
    });
    const actions = reduceRun(state, { type: 'NEXT', at: NOW });
    expect(actions.map((action) => action.type)).toEqual(['status']);
  });
});

const cleanups = [];
afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

function git(cwd, ...args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

async function project() {
  const dir = await mkdtemp(path.join(tmpdir(), 'ape-deadline-'));
  cleanups.push(dir);
  await mkdir(path.join(dir, 'src'));
  await mkdir(path.join(dir, 'tests'));
  await writeFile(path.join(dir, 'src', 'value.js'), 'export const value = 1;\n');
  await writeFile(path.join(dir, 'tests', 'value.test.js'), 'throw new Error("red");\n');
  git(dir, 'init', '-q');
  git(dir, 'config', 'user.email', 'ape@example.test');
  git(dir, 'config', 'user.name', 'APE Test');
  git(dir, 'add', '.');
  git(dir, 'commit', '-qm', 'baseline');
  await atomicWriteJson(runtimePaths(dir).config, {
    shipping: { auto_merge: false, provider: 'github', required_remote_checks: false },
    test_commands: { targeted_template: 'node --test {paths}', full: 'node --test' },
  });
  return dir;
}

function startInput(overrides = {}) {
  return {
    objective: 'Exercise deadline handling',
    mode: 'phase',
    lane: 'fast',
    host: 'codex',
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

async function expireLatestTicket(dir) {
  const paths = runtimePaths(dir);
  const state = await readJson(paths.active, null);
  const ticket = state.tickets.at(-1);
  ticket.deadline_at = PAST;
  await atomicWriteJson(paths.active, state);
  return ticket;
}

async function bindLatestDispatch(dir, started, host) {
  const paths = runtimePaths(dir);
  const state = await readJson(paths.active, null);
  const action = started.actions.find((entry) => entry.type === 'dispatch_agent');
  const parentSessionId = `${host}-fixture-parent`;
  const turnId = `${host}-fixture-turn`;
  const launchInput = {
    session_id: parentSessionId,
    turn_id: turnId,
    tool_use_id: `${host}-fixture-launch`,
    tool_input: host === 'codex'
      ? action.dispatch.spawn_args
      : {
          subagent_type: action.dispatch.agent_type,
          prompt: action.dispatch.dispatch_intent.prompt,
          model: action.dispatch.model.model,
        },
  };
  const launched = host === 'codex'
    ? await launchCodexIntent(paths, state, launchInput)
    : await launchClaudeIntent(paths, state, launchInput);
  expect(launched.valid).toBe(true);
  const agentId = `${host}-physical-agent`;
  const bindInput = {
    session_id: parentSessionId,
    turn_id: host === 'codex' ? `${host}-fixture-child-turn` : turnId,
    agent_id: agentId,
    agent_type: host === 'codex' ? 'default' : action.dispatch.agent_type,
    ...(host === 'codex' ? { model: action.dispatch.model.model } : {}),
  };
  const observed = host === 'codex'
    ? await bindCodexSubagent(paths, state, bindInput)
    : await bindClaudeSubagent(paths, state, bindInput);
  expect(observed.valid).toBe(true);
  if (host === 'codex') expect(observed.bootstrap_required).toBe(true);
  const bound = host === 'codex'
    ? await bootstrapCodexSubagent(paths, state, {
        ...bindInput,
        session_id: agentId,
        tool_name: 'mcp__ape__ape_bind',
        tool_use_id: `${host}-fixture-bootstrap`,
        tool_input: action.dispatch.bootstrap_args,
      })
    : observed;
  expect(bound.valid).toBe(true);
  const [intentFile] = (await readdir(paths.dispatchIntents))
    .filter((name) => name.endsWith('.json'))
    .map((name) => path.join(paths.dispatchIntents, name));
  return { intentFile, record: await readJson(intentFile, null) };
}

function expireBoundRecord(record) {
  const preparedAt = '2025-12-31T23:56:00.000Z';
  const launchedAt = '2025-12-31T23:57:00.000Z';
  const boundAt = '2025-12-31T23:58:00.000Z';
  const launchExpiresAt = '2025-12-31T23:59:00.000Z';
  return {
    ...record,
    prepared_at: preparedAt,
    launched_at: launchedAt,
    authorized_at: launchedAt,
    bound_at: boundAt,
    ...(record.bootstrap_invocation ? {
      bootstrap_invocation: { ...record.bootstrap_invocation, admitted_at: boundAt },
    } : {}),
    launch_expires_at: launchExpiresAt,
    expires_at: PAST,
    launch_generations: record.launch_generations.map((entry) => (
      entry.generation === record.launch_generation
        ? {
            ...entry,
            prepared_at: preparedAt,
            authorized_at: launchedAt,
            ...(entry.launched_at ? { launched_at: launchedAt } : {}),
            bound_at: boundAt,
            launch_expires_at: launchExpiresAt,
            expires_at: PAST,
          }
        : entry
    )),
  };
}

function observeSubagentStop(dir, host, intent) {
  const sessionId = host === 'codex' ? intent.bound_session_id : intent.parent_session_id;
  const env = { ...process.env };
  delete env.CLAUDECODE;
  delete env.CLAUDE_CODE;
  delete env.CLAUDE_PROJECT_DIR;
  delete env.CODEX_CWD;
  if (host === 'claude') env.CLAUDECODE = '1';
  return JSON.parse(execFileSync(process.execPath, [hookBinary], {
    cwd: dir,
    env,
    input: JSON.stringify({
      hook_event_name: 'SubagentStop',
      project_dir: dir,
      session_id: sessionId,
      ...(host === 'codex' ? { turn_id: `${host}-fixture-child-turn` } : {}),
      agent_id: intent.bound_agent_id,
      agent_type: host === 'codex' ? intent.binding_agent_type : intent.agent_type,
      agent_transcript_path: null,
      stop_hook_active: false,
      last_assistant_message: 'done',
    }),
    encoding: 'utf8',
  }));
}

describe('APE v2 deadline-expired ticket transition (F17, service)', () => {
  it('retries an expired pending ticket once, then blocks the run', async () => {
    const dir = await project();
    const started = await startRun(dir, startInput());
    expect(started.ok).toBe(true);
    const original = await expireLatestTicket(dir);

    const retried = await resumeRun(dir);
    expect(retried.ok).toBe(true);
    const dispatched = retried.actions.find((action) => action.type === 'dispatch_agent');
    expect(dispatched.ticket.ticket_id).not.toBe(original.ticket_id);
    expect(dispatched.ticket.stage_id).toBe(original.stage_id);
    expect(retried.run.attempts[original.stage_id]).toBe(2);
    expect(retried.run.expired_tickets).toContain(original.ticket_id);
    expect(retried.run.status).toBe('running');

    await expireLatestTicket(dir);
    const blocked = await resumeRun(dir);
    expect(blocked.ok).toBe(true);
    expect(blocked.run.status).toBe('blocked');
    expect(blocked.run.block_reason).toMatch(/deadline expired/);
    expect((await statusRun(dir)).run.status).toBe('blocked');
  });

  it('degrades next/resume to a status-style action while a Claude intent is live and bound', async () => {
    const dir = await project();
    const started = await startRun(dir, startInput({ host: 'claude' }));
    expect(started.ok).toBe(true);
    await bindLatestDispatch(dir, started, 'claude');

    const resumed = await resumeRun(dir);
    expect(resumed.ok).toBe(true);
    expect(resumed.actions).toEqual([
      expect.objectContaining({
        type: 'dispatch_pending',
        ticket_id: started.run.tickets[0].ticket_id,
      }),
    ]);
    expect(resumed.run.status).toBe('running');
  });

  it.each(['claude', 'codex'])(
    'waits for an observed %s SubagentStop before automatically retrying an expired bound ticket',
    async (host) => {
      const dir = await project();
      const started = await startRun(dir, startInput({ host }));
      expect(started.ok).toBe(true);
      const paths = runtimePaths(dir);
      const canonical = await bindLatestDispatch(dir, started, host);
      const { intentFile } = canonical;
      const bound = expireBoundRecord(canonical.record);
      await atomicWriteJson(intentFile, bound);
      const state = await readJson(paths.active, null);
      state.tickets.at(-1).deadline_at = PAST;
      await atomicWriteJson(paths.active, state);

      expect((await statusRun(dir)).dispatches).toEqual([
        expect.objectContaining({
          ticket_id: bound.ticket_id,
          status: 'bound',
          agent_state: 'active-bound',
          agent_stopped_at: null,
        }),
      ]);

      const waiting = await resumeRun(dir);
      expect(waiting.ok).toBe(true);
      expect(waiting.actions).toEqual([
        expect.objectContaining({
          type: 'dispatch_retirement_pending',
          ticket_id: bound.ticket_id,
          agent_state: 'active-bound',
          reason: expect.stringMatching(/no observed SubagentStop|expire-dispatch/),
        }),
      ]);
      expect(waiting.run.tickets).toHaveLength(1);
      expect(waiting.run.expired_tickets ?? []).not.toContain(bound.ticket_id);

      expect(observeSubagentStop(dir, host, bound)).toBeTypeOf('object');
      expect((await statusRun(dir)).dispatches).toEqual([
        expect.objectContaining({
          ticket_id: bound.ticket_id,
          status: 'bound',
          agent_state: 'observed-stopped',
          agent_stopped_at: expect.any(String),
        }),
      ]);

      const retried = await resumeRun(dir);
      expect(retried.ok).toBe(true);
      expect(retried.run.expired_tickets).toContain(bound.ticket_id);
      expect(retried.run.tickets).toHaveLength(2);
      expect(retried.actions).toEqual(expect.arrayContaining([
        expect.objectContaining({ type: 'dispatch_agent' }),
      ]));
    },
  );

  it('fails NEXT closed when an elapsed bound intent is corrupt instead of redispatching', async () => {
    const dir = await project();
    const started = await startRun(dir, startInput({ host: 'codex' }));
    expect(started.ok).toBe(true);
    const paths = runtimePaths(dir);
    const [intentFile] = (await readdir(paths.dispatchIntents))
      .filter((name) => name.endsWith('.json'))
      .map((name) => path.join(paths.dispatchIntents, name));
    const original = await readJson(intentFile, null);
    const bound = {
      ...original,
      status: 'bound',
      bound_agent_id: 'codex-physical-agent',
      bound_session_id: 'codex-child-session',
      capability_hash: 'c'.repeat(64),
      bound_at: new Date().toISOString(),
      expires_at: PAST,
    };
    const state = await readJson(paths.active, null);
    state.tickets.at(-1).deadline_at = PAST;
    await atomicWriteJson(paths.active, state);
    // Preserve enough of the former record in the torn bytes to make the
    // regression's premise explicit while ensuring JSON.parse cannot recover
    // it as a merely malformed-but-readable object.
    await writeFile(intentFile, JSON.stringify(bound).slice(0, -1));

    // Read-only status remains available, but its tolerant projection cannot
    // authorize lifecycle work. NEXT performs a strict intent read and stops
    // before the reducer can expire the ticket or issue its retry.
    expect(await statusRun(dir)).toMatchObject({
      dispatch_state: 'error',
      dispatches: [{
        ticket_id: bound.ticket_id,
        status: 'corrupt',
        agent_state: 'evidence-unreadable',
        evidence_unreadable: true,
      }],
    });
    await expect(nextRun(dir)).rejects.toThrow(/unreadable.*abort.*quarantine/iu);

    const unchanged = await readJson(paths.active, null);
    expect(unchanged.tickets).toHaveLength(1);
    expect(unchanged.tickets[0].ticket_id).toBe(bound.ticket_id);
    expect(unchanged.expired_tickets ?? []).not.toContain(bound.ticket_id);
    expect(unchanged.attempts).toEqual(state.attempts);
    expect((await readdir(paths.dispatchIntents)).filter((name) => name.endsWith('.json')))
      .toHaveLength(1);
  });

  it('fails NEXT closed on a parseable field-damaged bound intent without overwriting it', async () => {
    const dir = await project();
    const started = await startRun(dir, startInput({ host: 'codex' }));
    expect(started.ok).toBe(true);
    const paths = runtimePaths(dir);
    const [intentFile] = (await readdir(paths.dispatchIntents))
      .filter((name) => name.endsWith('.json'))
      .map((name) => path.join(paths.dispatchIntents, name));
    const original = await readJson(intentFile, null);
    const formerlyBound = {
      ...original,
      status: 'bound',
      bound_agent_id: 'codex-physical-agent',
      bound_session_id: 'codex-child-session',
      capability_hash: 'c'.repeat(64),
      bound_at: new Date().toISOString(),
      expires_at: PAST,
    };
    // The bytes still parse as an object and still carry the rest of the old
    // binding, but its authoritative native agent identity was torn away.
    const { bound_agent_id: _lostIdentity, ...damaged } = formerlyBound;
    await atomicWriteJson(intentFile, damaged);
    const damagedBytes = await readFile(intentFile, 'utf8');

    const state = await readJson(paths.active, null);
    state.tickets.at(-1).deadline_at = PAST;
    await atomicWriteJson(paths.active, state);

    // Status deliberately stays tolerant and projects no authority from the
    // damaged record. NEXT uses the strict reader and must stop before either
    // expiring the ticket or preparing a replacement over these same bytes.
    expect(await statusRun(dir)).toMatchObject({
      dispatch_state: 'error',
      dispatches: [{
        ticket_id: formerlyBound.ticket_id,
        status: 'corrupt',
        agent_state: 'evidence-unreadable',
        evidence_unreadable: true,
      }],
    });
    expect(await compactStatus(dir)).toMatchObject({
      dispatch_state: 'error',
      next_action: { kind: 'blocked', automatic_successor: false },
      failure_domain: 'orchestration',
      next_safe_action: 'ape_run abort',
      diagnostic: {
        reason_code: 'dispatch_evidence_unreadable',
        next_safe_action: 'ape_run abort',
      },
    });

    // Receipt correction normally routes back to the same worker, but damaged
    // identity evidence makes that continuation unauthoritative. Corruption
    // must outrank the input-required hint on both compact and SessionStart
    // diagnostic surfaces.
    await atomicWriteJson(paths.active, {
      ...state,
      status: 'input_required',
      input_required: {
        kind: 'receipt_retry',
        ticket_id: formerlyBound.ticket_id,
      },
    });
    expect(await compactStatus(dir)).toMatchObject({
      dispatch_state: 'error',
      next_action: { kind: 'blocked', automatic_successor: false },
      next_safe_action: 'ape_run abort',
      diagnostic: {
        reason_code: 'dispatch_evidence_unreadable',
        next_safe_action: 'ape_run abort',
      },
    });
    const receiptRetryGuidance = await loadSessionGuidance(dir, { host: 'codex' });
    expect(receiptRetryGuidance).toContain('Next safe action: ape_run abort');
    expect(receiptRetryGuidance).not.toContain('continue the same agent');
    await atomicWriteJson(paths.active, state);

    await expect(nextRun(dir)).rejects.toThrow(/dispatch intent artifact is .*structurally invalid/);

    expect(await readFile(intentFile, 'utf8')).toBe(damagedBytes);
    const unchanged = await readJson(paths.active, null);
    expect(unchanged.tickets).toHaveLength(1);
    expect(unchanged.tickets[0].ticket_id).toBe(formerlyBound.ticket_id);
    expect(unchanged.expired_tickets ?? []).not.toContain(formerlyBound.ticket_id);
    expect(unchanged.attempts).toEqual(state.attempts);
    expect((await readdir(paths.dispatchIntents)).filter((name) => name.endsWith('.json')))
      .toHaveLength(1);

    // ABORT is the audited escape hatch: it revokes the unreadable authority
    // by moving the canonical JSON path out of the reader namespace before it
    // seals the run, while retaining the inert bytes for forensics.
    const aborted = await abortRun(dir, 'quarantine unreadable dispatch evidence');
    expect(aborted).toMatchObject({ ok: true, run: { status: 'aborted' } });
    await expect(readFile(intentFile, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
    const quarantined = (await readdir(paths.dispatchIntents))
      .filter((name) => name.includes('.json.corrupt-'));
    expect(quarantined).toHaveLength(1);
    expect(await readFile(path.join(paths.dispatchIntents, quarantined[0]), 'utf8'))
      .toBe(damagedBytes);
  });

  it('projects a wrong-shaped intent container as corrupt and abort quarantines it intact', async () => {
    const dir = await project();
    expect((await startRun(dir, startInput({ host: 'codex' }))).ok).toBe(true);
    const paths = runtimePaths(dir);
    const forensicBytes = 'not-a-directory: retained dispatch evidence\n';
    await rm(paths.dispatchIntents, { recursive: true, force: true });
    await writeFile(paths.dispatchIntents, forensicBytes);

    expect(await statusRun(dir)).toMatchObject({
      dispatch_state: 'error',
      dispatches: [{
        status: 'corrupt',
        agent_state: 'evidence-unreadable',
        evidence_unreadable: true,
      }],
    });
    expect(await compactStatus(dir)).toMatchObject({
      dispatch_state: 'error',
      next_safe_action: 'ape_run abort',
      diagnostic: { reason_code: 'dispatch_evidence_unreadable' },
    });
    expect(await loadSessionGuidance(dir, { host: 'codex' }))
      .toContain('Next safe action: ape_run abort');

    const aborted = await abortRun(dir, 'quarantine wrong-shaped dispatch evidence');
    expect(aborted).toMatchObject({ ok: true, run: { status: 'aborted' } });
    const quarantined = (await readdir(paths.runtime))
      .filter((name) => name.startsWith('dispatch-intents.corrupt-'));
    expect(quarantined).toHaveLength(1);
    expect(await readFile(path.join(paths.runtime, quarantined[0]), 'utf8'))
      .toBe(forensicBytes);
  });

  it('treats a ticket-id/filename mismatch as corrupt without mutating retry state', async () => {
    const dir = await project();
    expect((await startRun(dir, startInput({ host: 'codex' }))).ok).toBe(true);
    const paths = runtimePaths(dir);
    const [intentFile] = (await readdir(paths.dispatchIntents))
      .filter((name) => name.endsWith('.json'))
      .map((name) => path.join(paths.dispatchIntents, name));
    const intent = await readJson(intentFile, null);
    await atomicWriteJson(intentFile, {
      ...intent,
      ticket_id: `${intent.ticket_id}:forged-path-mismatch`,
    });
    const state = await readJson(paths.active, null);
    state.tickets.at(-1).deadline_at = PAST;
    await atomicWriteJson(paths.active, state);

    expect(await statusRun(dir)).toMatchObject({ dispatch_state: 'error' });
    await expect(nextRun(dir)).rejects.toThrow(/dispatch intent artifact/);
    const unchanged = await readJson(paths.active, null);
    expect(unchanged.tickets).toHaveLength(1);
    expect(unchanged.expired_tickets ?? []).not.toContain(intent.ticket_id);
    expect(unchanged.attempts).toEqual(state.attempts);
  });

  it('never follows a symlinked intent artifact and abort quarantines the link itself', async () => {
    const dir = await project();
    expect((await startRun(dir, startInput({ host: 'codex' }))).ok).toBe(true);
    const paths = runtimePaths(dir);
    const [intentFile] = (await readdir(paths.dispatchIntents))
      .filter((name) => name.endsWith('.json'))
      .map((name) => path.join(paths.dispatchIntents, name));
    const external = path.join(dir, 'outside-intent.json');
    const externalBytes = await readFile(intentFile, 'utf8');
    await writeFile(external, externalBytes);
    await rm(intentFile);
    await symlink(external, intentFile);

    expect(await statusRun(dir)).toMatchObject({ dispatch_state: 'error' });
    const aborted = await abortRun(dir, 'quarantine symlinked dispatch evidence');
    expect(aborted).toMatchObject({ ok: true, run: { status: 'aborted' } });
    expect(await readFile(external, 'utf8')).toBe(externalBytes);
    const quarantined = (await readdir(paths.dispatchIntents))
      .filter((name) => name.includes('.json.corrupt-'));
    expect(quarantined).toHaveLength(1);
    expect((await lstat(path.join(paths.dispatchIntents, quarantined[0]))).isSymbolicLink())
      .toBe(true);
  });
});
