import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { reduceRun } from '../lib/runtime/scheduler.js';
import { resumeRun, startRun, statusRun } from '../lib/runtime/service.js';
import { runtimePaths } from '../lib/runtime/paths.js';
import { atomicWriteJson, readJson } from '../lib/runtime/storage.js';

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
    test_commands: { full: 'node --test' },
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
      agent_id: intent.bound_agent_id,
      agent_type: intent.agent_type,
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
    const paths = runtimePaths(dir);
    const [intentFile] = (await readdir(paths.dispatchIntents))
      .filter((name) => name.endsWith('.json'))
      .map((name) => path.join(paths.dispatchIntents, name));
    const intent = await readJson(intentFile, null);
    await atomicWriteJson(intentFile, { ...intent, status: 'bound' });

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
      const [intentFile] = (await readdir(paths.dispatchIntents))
        .filter((name) => name.endsWith('.json'))
        .map((name) => path.join(paths.dispatchIntents, name));
      const original = await readJson(intentFile, null);
      const bound = {
        ...original,
        status: 'bound',
        bound_agent_id: `${host}-physical-agent`,
        ...(host === 'codex'
          ? { bound_session_id: `${host}-child-session` }
          : { parent_session_id: `${host}-parent-session` }),
        capability_hash: 'non-secret-test-digest',
        bound_at: new Date().toISOString(),
        expires_at: PAST,
      };
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
});
