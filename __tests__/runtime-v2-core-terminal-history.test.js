import { execFileSync } from 'node:child_process';
import { access, mkdtemp, mkdir, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
// Only the bounded remote-checks poll is mocked; importOriginal keeps the real
// runMergeGates (the auto-merge-HOLD arm tests below still run genuine gates)
// and the real autoMergeGithub.
vi.mock('../lib/runtime/gates.js', async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, pollRemoteChecksAndMerge: vi.fn() };
});
import { reduceRun } from '../lib/runtime/scheduler.js';
import { archiveRun } from '../lib/runtime/history.js';
import { abortRun, historyAction, nextRun, overrideRun, recordReceipt, startRun } from '../lib/runtime/service.js';
import { pollRemoteChecksAndMerge } from '../lib/runtime/gates.js';
import { acquireRunLock } from '../lib/runtime/lock.js';
import { runtimePaths } from '../lib/runtime/paths.js';
import { atomicWriteJson, readJson } from '../lib/runtime/storage.js';

const cleanups = [];
afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

function exists(file) {
  return access(file).then(() => true, () => false);
}

function git(cwd, ...args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

function run(overrides = {}) {
  return {
    run_id: 'run-1',
    mode: 'phase',
    lane: 'fast',
    status: 'running',
    stage: 'dispatch',
    tickets: [],
    receipts: [],
    attempts: {},
    remediation_cycles: 0,
    high_risk: false,
    ...overrides,
  };
}

async function project() {
  const dir = await mkdtemp(path.join(tmpdir(), 'ape-terminal-history-'));
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

function startInput() {
  return {
    objective: 'Exercise terminal-run history archiving',
    mode: 'phase',
    lane: 'fast',
    host: 'codex',
    claimed_paths: ['src/value.js'],
    test_paths: ['tests/value.test.js'],
    requirements: ['R7'],
    risk_triggers: [],
    behavioral: true,
    hooks_trusted: true,
    subagents_available: true,
    explicit_invocation: true,
  };
}

describe('APE v2 blocked runs are exitable and reach history (F7, reducer)', () => {
  it('allows plain ABORT to terminate a blocked run and archives it', () => {
    const actions = reduceRun(run({ status: 'blocked', block_reason: 'gates failed' }), {
      type: 'ABORT',
      reason: 'operator gave up on the blocked run',
    });
    const types = actions.map((entry) => entry.type);
    expect(types).toContain('archive_history');
    expect(actions.find((entry) => entry.type === 'transition').patch.status).toBe('aborted');
  });

  it('still seals completed and aborted runs against plain ABORT', () => {
    for (const status of ['completed', 'aborted']) {
      const actions = reduceRun(run({ status }), { type: 'ABORT', reason: 'nope' });
      expect(actions).toEqual([expect.objectContaining({ type: 'reject', reason: `run is ${status}` })]);
    }
  });

  it('override abort archives the run to history', () => {
    const actions = reduceRun(run(), {
      type: 'OVERRIDE',
      operation: 'abort',
      reason: 'operator override abort',
    });
    const types = actions.map((entry) => entry.type);
    expect(types).toEqual(['audit_override', 'apply_override', 'archive_history', 'release_lock', 'persist_state']);
    // The archive runs after apply_override so the record carries the aborted
    // status, and before persist_state so a crash cannot lose the record.
    expect(types.indexOf('archive_history')).toBeGreaterThan(types.indexOf('apply_override'));
  });

  it('override reset archives before the state is deleted', () => {
    const actions = reduceRun(run({ status: 'blocked', block_reason: 'gates failed' }), {
      type: 'OVERRIDE',
      operation: 'reset',
      reason: 'operator override reset',
    });
    const types = actions.map((entry) => entry.type);
    expect(types).toEqual(['audit_override', 'archive_history', 'apply_override']);
    expect(types.indexOf('archive_history')).toBeLessThan(types.indexOf('apply_override'));
  });

  it('rejects override reset on a non-terminal run before any archive', () => {
    const actions = reduceRun(run({ status: 'running' }), {
      type: 'OVERRIDE',
      operation: 'reset',
      reason: 'too early',
    });
    expect(actions).toEqual([
      expect.objectContaining({ type: 'reject', reason: expect.stringContaining('terminal or blocked') }),
    ]);
  });

  it('rejects override abort on a completed run: truthful completion is immutable', () => {
    const actions = reduceRun(run({ status: 'completed' }), {
      type: 'OVERRIDE',
      operation: 'abort',
      reason: 'rewrite history',
    });
    expect(actions).toEqual([expect.objectContaining({ type: 'reject' })]);
  });

  it('rejects an unknown or missing override operation with no audit action', () => {
    // The old fall-through emitted [audit_override, apply_override], appending
    // a permanent overrides.ndjson line for an override that then threw and
    // was never applied — a falsified entry in an audit log.
    for (const operation of ['bypass-gates', undefined]) {
      const actions = reduceRun(run(), { type: 'OVERRIDE', operation, reason: 'forgot the operation' });
      expect(actions).toEqual([
        expect.objectContaining({
          type: 'reject',
          reason: expect.stringContaining("must be 'abort' or 'reset'"),
        }),
      ]);
    }
  });
});

describe('APE v2 every transition into blocked archives immediately (F7, reducer)', () => {
  const archiveOf = (actions) => actions.find((entry) => entry.type === 'archive_history');
  const types = (actions) => actions.map((entry) => entry.type);

  it('GATES_FAILED archives before releasing the lock', () => {
    const actions = reduceRun(run(), { type: 'GATES_FAILED', reason: 'full suite failed' });
    expect(types(actions)).toEqual(['transition', 'archive_history', 'release_lock', 'persist_state']);
    expect(actions[0].patch.status).toBe('blocked');
    expect(archiveOf(actions).if_absent).toBe(true);
  });

  it('a stage that failed twice archives the blocked run', () => {
    const ticket = { ticket_id: 't1', stage_id: 'build' };
    const actions = reduceRun(run({ attempts: { build: 2 }, tickets: [ticket] }), {
      type: 'RECEIPT_RECORDED',
      ticket,
      receipt: { status: 'failed' },
      stage: { id: 'build', role: 'implementer', parallel_group: null },
    });
    expect(actions[0].patch.status).toBe('blocked');
    // No attempt carried a summary: the reason stays the bare noise-free string.
    expect(actions[0].patch.block_reason).toBe('stage build failed twice');
    expect(archiveOf(actions)).toMatchObject({ if_absent: true });
    expect(types(actions).indexOf('archive_history')).toBeLessThan(types(actions).indexOf('release_lock'));
  });

  it("a stage that failed twice carries both attempts' failure summaries in the block reason", () => {
    const first = { ticket_id: 't1', stage_id: 'build', attempt: 1 };
    const second = { ticket_id: 't2', stage_id: 'build', attempt: 2 };
    const state = run({
      attempts: { build: 2 },
      tickets: [first, second],
      receipts: [{ ticket_id: 't1', status: 'failed', evidence: { summary: 'npm test exited 1: missing module' } }],
    });
    const actions = reduceRun(state, {
      type: 'RECEIPT_RECORDED',
      ticket: second,
      receipt: { ticket_id: 't2', status: 'failed', evidence: { reason: 'npm test exited 1: missing module' } },
      stage: { id: 'build', role: 'implementer', parallel_group: null },
    });
    expect(actions[0].patch.status).toBe('blocked');
    expect(actions[0].patch.block_reason).toBe(
      'stage build failed twice: attempt 1: npm test exited 1: missing module; attempt 2: npm test exited 1: missing module',
    );
  });

  it('attempt summaries are whitespace-flattened and bounded', () => {
    const first = { ticket_id: 't1', stage_id: 'build', attempt: 1 };
    const second = { ticket_id: 't2', stage_id: 'build', attempt: 2 };
    const state = run({
      attempts: { build: 2 },
      tickets: [first, second],
      receipts: [{ ticket_id: 't1', status: 'failed', evidence: { summary: 'line1\nline2  spaced' } }],
    });
    const actions = reduceRun(state, {
      type: 'RECEIPT_RECORDED',
      ticket: second,
      receipt: { ticket_id: 't2', status: 'failed', evidence: { summary: 'x'.repeat(300) } },
      stage: { id: 'build', role: 'implementer', parallel_group: null },
    });
    expect(actions[0].patch.block_reason).toBe(
      `stage build failed twice: attempt 1: line1 line2 spaced; attempt 2: ${'x'.repeat(120)}…`,
    );
    expect(actions[0].patch.block_reason).not.toMatch(/\n/);
  });

  it('a summaryless sibling attempt renders (no summary) when the other attempt is informative', () => {
    const first = { ticket_id: 't1', stage_id: 'build', attempt: 1 };
    const second = { ticket_id: 't2', stage_id: 'build', attempt: 2 };
    const state = run({
      attempts: { build: 2 },
      tickets: [first, second],
      receipts: [{ ticket_id: 't1', status: 'failed', evidence: {} }],
    });
    const actions = reduceRun(state, {
      type: 'RECEIPT_RECORDED',
      ticket: second,
      receipt: { ticket_id: 't2', status: 'failed', evidence: { summary: 'disk full' } },
      stage: { id: 'build', role: 'implementer', parallel_group: null },
    });
    expect(actions[0].patch.block_reason).toBe(
      'stage build failed twice: attempt 1: (no summary); attempt 2: disk full',
    );
  });

  it('an exhausted ticket deadline archives the blocked run', () => {
    const ticket = {
      ticket_id: 't-deadline',
      stage_id: 'build',
      deadline_at: '2026-01-01T00:00:00.000Z',
    };
    const actions = reduceRun(run({ attempts: { build: 2 }, tickets: [ticket] }), {
      type: 'NEXT',
      at: '2026-01-01T01:00:00.000Z',
    });
    expect(actions[0].patch.status).toBe('blocked');
    expect(actions[0].patch.block_reason).toMatch(/deadline expired/);
    expect(archiveOf(actions)).toMatchObject({ if_absent: true });
  });

  it('a review disagreement past the remediation cycle archives the blocked run', () => {
    const ticket = { ticket_id: 't-review', stage_id: 'review', parallel_group: 'code-review', role: 'reviewer' };
    const receipt = { ticket_id: 't-review', status: 'passed', evidence: { verdict: 'disagree' } };
    const state = run({ remediation_cycles: 1, tickets: [ticket] });
    const actions = reduceRun(state, {
      type: 'RECEIPT_RECORDED',
      ticket,
      receipt,
      stage: { id: 'review', role: 'reviewer', parallel_group: 'code-review' },
      next_state: { ...state, receipts: [receipt] },
    });
    expect(actions[0].patch.status).toBe('blocked');
    expect(actions[0].patch.block_reason).toMatch(/remediation cycle/);
    expect(archiveOf(actions)).toMatchObject({ if_absent: true });
  });

  it('plain ABORT archives if-absent so a block-time record is never duplicated', () => {
    const actions = reduceRun(run({ status: 'blocked', block_reason: 'gates failed' }), {
      type: 'ABORT',
      reason: 'operator exits the blocked run',
    });
    expect(archiveOf(actions)).toMatchObject({ if_absent: true });
  });
});

describe('APE v2 idempotent archives (F40, history)', () => {
  function terminalState(overrides = {}) {
    return {
      run_id: 'run-40',
      objective: 'Ship it',
      mode: 'phase',
      lane: 'fast',
      requirements: ['R1'],
      status: 'aborted',
      created_at: '2026-01-01T00:00:00.000Z',
      updated_at: '2026-01-01T00:01:00.000Z',
      terminal_at: '2026-01-01T00:01:00.000Z',
      base_commit_sha: 'a'.repeat(40),
      tree_sha: 'b'.repeat(40),
      tickets: [],
      receipts: [],
      ...overrides,
    };
  }

  it('re-archiving the identical run after a crash-retry re-stamp is a no-op, not a throw', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'ape-history-idem-'));
    cleanups.push(dir);
    const paths = runtimePaths(dir);
    const first = await archiveRun(paths, terminalState());
    // Crash between archive_history and persist_state: the terminal stamp was
    // never persisted, so the retried abort re-stamps a later terminal_at and
    // updated_at. The run content is identical; this must not wedge.
    const retried = await archiveRun(paths, terminalState({
      terminal_at: '2026-01-01T00:05:00.000Z',
      updated_at: '2026-01-01T00:05:00.000Z',
    }));
    expect(retried.record_hash).toBe(first.record_hash);
    // First write wins: the on-disk record keeps the original stamp.
    expect(retried.completed_at).toBe('2026-01-01T00:01:00.000Z');
    const onDisk = await readJson(path.join(paths.history, 'run-40.json'));
    expect(onDisk.completed_at).toBe('2026-01-01T00:01:00.000Z');
  });

  it('derives completed_at from the stable terminal stamp, not the volatile updated_at', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'ape-history-stamp-'));
    cleanups.push(dir);
    const paths = runtimePaths(dir);
    const record = await archiveRun(paths, terminalState({ updated_at: '2026-01-01T00:09:00.000Z' }));
    expect(record.completed_at).toBe('2026-01-01T00:01:00.000Z');
  });

  it('still refuses to shadow a record with genuinely different run content', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'ape-history-guard-'));
    cleanups.push(dir);
    const paths = runtimePaths(dir);
    await archiveRun(paths, terminalState());
    await expect(archiveRun(paths, terminalState({ status: 'completed' })))
      .rejects.toThrow(/immutable history record already exists/);
  });
});

describe('APE v2 blocked runs reach history (F7, service)', () => {
  async function blockedRun() {
    const dir = await project();
    const started = await startRun(dir, startInput());
    expect(started.ok).toBe(true);
    const paths = runtimePaths(dir);
    const state = await readJson(paths.active);
    state.status = 'blocked';
    state.stage = 'gates';
    state.block_reason = 'one or more deterministic merge gates failed';
    state.terminal_at = state.updated_at;
    await atomicWriteJson(paths.active, state);
    return { dir, paths, runId: state.run_id };
  }

  it('plain abort terminates a blocked run and archives it', async () => {
    const { dir, paths, runId } = await blockedRun();
    const aborted = await abortRun(dir, 'exit the gate-blocked run');
    expect(aborted.ok).toBe(true);
    expect(aborted.run.status).toBe('aborted');
    expect(aborted.actions.some((entry) => entry.type === 'history_archived')).toBe(true);
    const record = await readJson(path.join(paths.history, `${runId}.json`));
    expect(record.status).toBe('aborted');
    expect(record.record_hash).toBeTruthy();
  });

  it('override reset archives the blocked run before deleting active state', async () => {
    const { dir, paths, runId } = await blockedRun();
    const reset = await overrideRun(dir, 'reset', 'clear the blocked run');
    expect(reset.ok).toBe(true);
    expect(reset.actions.some((entry) => entry.type === 'history_archived')).toBe(true);
    expect(await exists(paths.active)).toBe(false);
    const record = await readJson(path.join(paths.history, `${runId}.json`));
    expect(record.status).toBe('blocked');
  });

  it('override abort archives a running run to history', async () => {
    const dir = await project();
    const started = await startRun(dir, startInput());
    expect(started.ok).toBe(true);
    const paths = runtimePaths(dir);
    const overridden = await overrideRun(dir, 'abort', 'operator abandons the run');
    expect(overridden.ok).toBe(true);
    expect(overridden.run.status).toBe('aborted');
    const record = await readJson(path.join(paths.history, `${started.run.run_id}.json`));
    expect(record.status).toBe('aborted');
    expect(record.completed_at).toBe(overridden.run.terminal_at);
  });

  it('a rejected override surfaces ok:false and appends nothing to overrides.ndjson', async () => {
    const dir = await project();
    const started = await startRun(dir, startInput());
    expect(started.ok).toBe(true);
    const paths = runtimePaths(dir);
    for (const operation of ['bypass-gates', undefined]) {
      const refused = await overrideRun(dir, operation, 'forgot the operation');
      expect(refused.ok).toBe(false);
      expect(refused.reason).toContain("must be 'abort' or 'reset'");
    }
    // The audit log gains no line for an override that was never applied; no
    // override ran at all, so the file does not even exist.
    expect(await exists(paths.overrideLog)).toBe(false);
    // The run itself is untouched and still running.
    expect((await readJson(paths.active)).status).toBe('running');
  });
});

describe('APE v2 runs archive at the moment they become blocked (F7, service)', () => {
  function mechanicalStart() {
    return {
      objective: 'Update the documentation note',
      mode: 'phase',
      lane: 'mechanical',
      host: 'codex',
      claimed_paths: ['docs/note.md'],
      test_paths: [],
      requirements: ['R7-BLOCKED'],
      risk_triggers: [],
      behavioral: false,
      hooks_trusted: true,
      subagents_available: true,
      explicit_invocation: true,
    };
  }

  async function mechanicalProject(config) {
    const dir = await mkdtemp(path.join(tmpdir(), 'ape-block-archive-'));
    cleanups.push(dir);
    await mkdir(path.join(dir, 'docs'));
    await writeFile(path.join(dir, 'docs', 'note.md'), '# note\n');
    git(dir, 'init', '-q');
    git(dir, 'config', 'user.email', 'ape@example.test');
    git(dir, 'config', 'user.name', 'APE Test');
    git(dir, 'add', '.');
    git(dir, 'commit', '-qm', 'baseline');
    await atomicWriteJson(runtimePaths(dir).config, config);
    return dir;
  }

  async function buildReceipt(dir) {
    const started = await startRun(dir, mechanicalStart());
    expect(started.ok).toBe(true);
    const build = started.run.tickets[0];
    expect(build.role).toBe('implementer');
    await writeFile(path.join(dir, 'docs', 'note.md'), '# note\n\nUpdated.\n');
    return {
      runId: started.run.run_id,
      result: await recordReceipt(dir, {
        ticket_id: build.ticket_id,
        status: 'passed',
        agent_identity: 'agent-implementer',
        tests: [{ command: 'node --version', passed: true, exit_code: 0, duration_ms: 1 }],
        findings: [],
        evidence: { verdict: 'pass' },
        timing: {
          started_at: build.issued_at,
          completed_at: new Date(Date.parse(build.issued_at) + 10).toISOString(),
          duration_ms: 10,
        },
      }),
    };
  }

  it('a GATES_FAILED block is immediately queryable via history, and a later abort neither duplicates nor throws', async () => {
    const dir = await mechanicalProject({
      shipping: { auto_merge: false, provider: 'github', required_remote_checks: false },
      test_commands: { full: 'node -e "process.exit(1)"' },
    });
    const { runId, result } = await buildReceipt(dir);
    expect(result.ok).toBe(true);
    expect(result.run.status).toBe('blocked');
    expect(result.actions.some((entry) => entry.type === 'history_archived')).toBe(true);

    // The blocked run reached immutable history the moment it blocked — no
    // operator abort/reset required (F7).
    const queried = await historyAction(dir, 'query', { run_id: runId });
    expect(queried.records).toHaveLength(1);
    expect(queried.records[0]).toMatchObject({
      run_id: runId,
      status: 'blocked',
      block_reason: 'one or more deterministic merge gates failed',
    });

    // A subsequent plain abort stays idempotent against the block-time record:
    // no throw, no duplicate, first write wins.
    const aborted = await abortRun(dir, 'exit the gate-blocked run');
    expect(aborted.ok).toBe(true);
    expect(aborted.run.status).toBe('aborted');
    const paths = runtimePaths(dir);
    const files = (await readdir(paths.history)).filter((file) => file.endsWith('.json'));
    expect(files).toEqual([`${runId}.json`]);
    const record = await readJson(path.join(paths.history, `${runId}.json`));
    expect(record.status).toBe('blocked');
  });

  it('a run blocked by disabled auto-merge archives immediately', async () => {
    const dir = await mechanicalProject({
      shipping: { auto_merge: false, provider: 'github', required_remote_checks: false },
      test_commands: { full: 'node --version' },
    });
    const { runId, result } = await buildReceipt(dir);
    expect(result.ok).toBe(true);
    expect(result.run.status).toBe('blocked');
    expect(result.run.block_reason).toBe('auto-merge is disabled by configuration');
    expect(result.actions.some((entry) => entry.type === 'history_archived')).toBe(true);
    const queried = await historyAction(dir, 'query', { run_id: runId });
    expect(queried.records).toHaveLength(1);
    expect(queried.records[0]).toMatchObject({
      status: 'blocked',
      block_reason: 'auto-merge is disabled by configuration',
    });
  });

  it('archives the runtime-measured timing block (raw_ms, test_ms) and host on the terminal record, and persists state.timing (T14)', async () => {
    // A real (temp-project) mechanical run to a terminal archive: the runtime
    // genuinely executes the full_suite gate (`node --version`) before the
    // disabled auto-merge blocks it, so it accumulates its OWN measured test
    // wall-clock — never agent-reported receipt timing.
    const dir = await mechanicalProject({
      shipping: { auto_merge: false, provider: 'github', required_remote_checks: false },
      test_commands: { full: 'node --version' },
    });
    const { runId, result } = await buildReceipt(dir);
    expect(result.ok).toBe(true);
    expect(result.run.status).toBe('blocked');

    const paths = runtimePaths(dir);
    const record = await readJson(path.join(paths.history, `${runId}.json`));
    // host is archived as run content; the mechanical run declared host 'codex'.
    expect(record.host).toBe('codex');
    expect(record.timing).toBeDefined();
    // The full_suite gate really ran, so runtime-measured test_ms is > 0.
    expect(record.timing.test_ms).toBeGreaterThan(0);
    // raw_ms is the created_at -> completed_at wall clock of the real run.
    expect(record.timing.raw_ms).toBeGreaterThan(0);
    expect(record.timing).toHaveProperty('remote_ci_ms');

    // The measured durations were accumulated into live run state too, still
    // present because a blocked run remains active until an operator exits it.
    const persisted = await readJson(paths.active);
    expect(persisted.timing).toBeDefined();
    expect(persisted.timing.test_ms).toBeGreaterThan(0);
  });
});

describe('APE v2 shipping-watch poll slices accumulate remote_ci_ms (T14/A7, service)', () => {
  // A run resting in the non-blocking shipping watch; each `ape_run next` is a
  // bounded remote-checks poll slice whose wall-clock accumulates (never resets)
  // into state.timing.remote_ci_ms and, on completion, the archived record.
  function restingShipping(runId, overrides = {}) {
    return {
      version: 2,
      schema_version: '2.0.0',
      run_id: runId,
      status: 'shipping',
      stage: 'merge',
      objective: 'Ship the value bump non-blocking',
      mode: 'phase',
      lane: 'mechanical',
      requested_lane: 'mechanical',
      lane_reasons: [],
      lane_escalated: false,
      behavioral: false,
      high_risk: false,
      policy: { high_risk_security_review: true },
      host: 'codex',
      claimed_paths: ['src/value.js'],
      test_paths: [],
      requirements: ['R-ship'],
      risk_triggers: [],
      branch: 'ape/phase-ship',
      base_commit_sha: 'a'.repeat(40),
      tree_sha: 'b'.repeat(40),
      tickets: [],
      receipts: [{
        receipt_hash: 'a',
        previous_receipt_hash: null,
        status: 'passed',
        agent: { host: 'codex', role: 'implementer' },
        tests: [{ passed: true }],
        changed_files: ['src/value.js'],
        head_tree_sha: 'b'.repeat(40),
      }],
      attempts: {},
      remediation_cycles: 0,
      regate_attempts: 0,
      gates: { passed: true, tree_sha: 'b'.repeat(40) },
      timing: { test_ms: 1_000, remote_ci_ms: 0 },
      shipping_watch: {
        provider: 'github',
        pr_url: 'https://github.com/acme/repo/pull/7',
        branch: 'ape/phase-ship',
        base: 'main',
        head_oid: 'c'.repeat(40),
        created_at: '2026-07-14T00:00:00.000Z',
        last_poll_at: null,
        poll_count: 0,
        last_checks_summary: null,
      },
      created_at: '2026-07-01T00:00:00.000Z',
      updated_at: '2026-07-01T00:00:00.000Z',
      ...overrides,
    };
  }

  it('accumulates runtime-measured remote_ci_ms across two poll slices onto the archived completed record', async () => {
    const dir = await project();
    const paths = runtimePaths(dir);
    const runId = 'run-shipping-ci';
    const baseline = 3_000;
    await atomicWriteJson(paths.active, restingShipping(runId, { timing: { test_ms: 1_000, remote_ci_ms: baseline } }));
    await acquireRunLock(paths.lock, runId);
    const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    pollRemoteChecksAndMerge
      .mockImplementationOnce(async () => { await sleep(25); return { pending: { summary: 'checks pending' } }; })
      .mockImplementationOnce(async () => {
        await sleep(25);
        return {
          merged: {
            provider: 'github',
            url: 'https://github.com/acme/repo/pull/7',
            branch: 'ape/phase-ship',
            base: 'main',
            merged_at: '2026-07-14T04:00:00.000Z',
          },
        };
      });

    const slice1 = await nextRun(dir);
    expect(slice1.ok).toBe(true);
    expect(slice1.run.status).toBe('shipping');
    const afterSlice1 = await readJson(paths.active);
    expect(afterSlice1.timing.remote_ci_ms).toBeGreaterThan(baseline);

    const slice2 = await nextRun(dir);
    expect(slice2.ok).toBe(true);
    expect(slice2.run.status).toBe('completed');
    const queried = await historyAction(dir, 'query', { run_id: runId });
    const completed = queried.records.find((record) => record.status === 'completed');
    expect(completed).toBeDefined();
    expect(completed.timing.remote_ci_ms).toBeGreaterThan(afterSlice1.timing.remote_ci_ms);
  });
});
