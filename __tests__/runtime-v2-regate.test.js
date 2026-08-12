import { execFileSync } from 'node:child_process';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { reduceRun } from '../lib/runtime/scheduler.js';
import { archiveRun, queryHistory } from '../lib/runtime/history.js';
import { runtimePaths } from '../lib/runtime/paths.js';
import { atomicWriteJson, readJson } from '../lib/runtime/storage.js';
import { currentTreeSha } from '../lib/runtime/git.js';
import * as service from '../lib/runtime/service.js';

// The re-gate recovery operation is host-neutral and runtime-owned, so shipping
// (GitHub) is the only side effect these behavioral tests must not perform for
// real: the completion path is exercised through a mocked auto-merge while the
// merge gate suite itself runs genuinely (re-gate must re-run the full suite
// with no bypass or waiver).
vi.mock('../lib/runtime/gates.js', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    autoMergeGithub: vi.fn(async () => ({
      url: 'https://github.com/acme/repo/pull/7',
      sha: 'd'.repeat(40),
      method: 'squash',
    })),
    // The bounded remote-checks poll is mocked so the shipping-watch slices
    // accumulate real wall-clock without performing GitHub side effects.
    pollRemoteChecksAndMerge: vi.fn(),
  };
});
import { pollRemoteChecksAndMerge } from '../lib/runtime/gates.js';
import { acquireRunLock } from '../lib/runtime/lock.js';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

const cleanups = [];
afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

function git(cwd, ...args) {
  execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' },
  });
}

// A gate-blocked run: it reached the merge gates, one deterministic gate
// failed, so GATES_FAILED archived it and released the lock (status 'blocked',
// stage 'gates'). This is the ONLY state re-gate may recover.
function gateBlocked(overrides = {}) {
  return {
    run_id: 'run-1',
    mode: 'phase',
    lane: 'mechanical',
    status: 'blocked',
    stage: 'gates',
    block_reason: 'one or more deterministic merge gates failed',
    tickets: [],
    receipts: [{
      receipt_hash: 'a',
      previous_receipt_hash: null,
      status: 'passed',
      agent: { host: 'codex', role: 'implementer' },
      tests: [{ passed: true }],
      changed_files: ['src/value.js'],
      head_tree_sha: 't'.repeat(40),
    }],
    attempts: {},
    remediation_cycles: 0,
    regate_attempts: 0,
    high_risk: false,
    gates: { passed: false, tree_sha: 't'.repeat(40) },
    ...overrides,
  };
}

describe('APE v2 re-gate reducer (REGATE event)', () => {
  it('recovers a gate-blocked run: reacquires the lock and re-runs the full gate suite', () => {
    const actions = reduceRun(gateBlocked(), { type: 'REGATE' });
    const types = actions.map((action) => action.type);
    // No bypass and no waiver: the recovery must actually re-run the gates.
    expect(types).not.toContain('reject');
    expect(types).toContain('acquire_lock');
    expect(types).toContain('run_gates');
    const transition = actions.find((action) => action.type === 'transition');
    expect(transition).toBeDefined();
    // The run must leave the terminal 'blocked' status so the gate suite can run.
    expect(transition.patch.status).toBeDefined();
    expect(transition.patch.status).not.toBe('blocked');
    // Bounded: each recovery consumes one re-gate attempt.
    expect(transition.patch.regate_attempts).toBe(1);
  });

  it('rejects re-gate for a stage-failure block (not a gate block)', () => {
    const actions = reduceRun(
      gateBlocked({ stage: 'build', block_reason: 'stage build failed twice' }),
      { type: 'REGATE' },
    );
    const types = actions.map((action) => action.type);
    expect(types).not.toContain('run_gates');
    expect(types).not.toContain('acquire_lock');
    const reject = actions.find((action) => action.type === 'reject');
    expect(reject).toBeDefined();
    expect(reject.reason).toMatch(/gate-?blocked/i);
  });

  it('rejects re-gate for a remediation block (not a gate block)', () => {
    const actions = reduceRun(
      gateBlocked({
        stage: 'remediation',
        block_reason: 'review disagreement persists after the single remediation cycle',
      }),
      { type: 'REGATE' },
    );
    const types = actions.map((action) => action.type);
    expect(types).not.toContain('run_gates');
    const reject = actions.find((action) => action.type === 'reject');
    expect(reject).toBeDefined();
    expect(reject.reason).toMatch(/gate-?blocked/i);
  });

  it('rejects re-gate once the maximum re-gate attempt count is reached', () => {
    const actions = reduceRun(
      gateBlocked({ regate_attempts: Number.MAX_SAFE_INTEGER }),
      { type: 'REGATE' },
    );
    const types = actions.map((action) => action.type);
    expect(types).not.toContain('run_gates');
    const reject = actions.find((action) => action.type === 'reject');
    expect(reject).toBeDefined();
    expect(reject.reason).toMatch(/max|limit|attempt|exhaust/i);
  });

  it('rejects re-gate for a run that is not blocked at the gates', () => {
    const actions = reduceRun(
      gateBlocked({ status: 'running' }),
      { type: 'REGATE' },
    );
    const types = actions.map((action) => action.type);
    expect(types).not.toContain('run_gates');
    const reject = actions.find((action) => action.type === 'reject');
    expect(reject).toBeDefined();
    expect(reject.reason).toMatch(/gate-?blocked/i);
  });

  it('archives a superseding record on completion of a re-gated run, not the block-time record', () => {
    const base = {
      run_id: 'run-1',
      lane: 'mechanical',
      status: 'shipping',
      stage: 'merge',
      tickets: [],
      receipts: [],
      attempts: {},
      remediation_cycles: 0,
    };
    const regated = reduceRun({ ...base, regate_attempts: 1 }, { type: 'MERGED', merge: { url: 'x' } });
    const supersedingArchive = regated.find((action) => action.type === 'archive_history');
    expect(supersedingArchive).toBeDefined();
    expect(supersedingArchive.superseding).toBe(true);

    // A run that was never re-gated archives normally (a first record, not a
    // superseding one).
    const normal = reduceRun({ ...base, regate_attempts: 0 }, { type: 'MERGED', merge: { url: 'x' } });
    const normalArchive = normal.find((action) => action.type === 'archive_history');
    expect(normalArchive).toBeDefined();
    expect(normalArchive.superseding).not.toBe(true);
  });
});

describe('APE v2 re-gate history archiving (superseding record support)', () => {
  it('appends a superseding completion record without mutating the block-time record', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'ape-regate-history-'));
    cleanups.push(dir);
    const paths = runtimePaths(dir);
    const runId = 'run-regate-hist';
    const blocked = {
      run_id: runId,
      objective: 'Recover the gate block',
      mode: 'phase',
      lane: 'mechanical',
      requirements: ['R-regate'],
      status: 'blocked',
      stage: 'gates',
      block_reason: 'one or more deterministic merge gates failed',
      created_at: '2026-07-01T00:00:00.000Z',
      updated_at: '2026-07-01T00:00:00.000Z',
      terminal_at: '2026-07-01T00:00:00.000Z',
      base_commit_sha: 'a'.repeat(40),
      tree_sha: 'b'.repeat(40),
      tickets: [],
      receipts: [],
      gates: { passed: false },
      regate_attempts: 0,
    };
    // F7: the block-time record is written the moment the run blocks.
    const blockRecord = await archiveRun(paths, blocked, { ifAbsent: true });
    expect(blockRecord.status).toBe('blocked');

    const completed = {
      ...blocked,
      status: 'completed',
      stage: 'complete',
      regate_attempts: 1,
      tree_sha: 'c'.repeat(40),
      merge: { url: 'https://github.com/acme/repo/pull/7' },
    };
    // A plain re-archive must still refuse to overwrite the immutable record.
    await expect(archiveRun(paths, completed)).rejects.toThrow(/already exists/i);

    // A superseding archive appends a NEW record that references the block-time
    // record instead of mutating it.
    const superseding = await archiveRun(paths, completed, { supersedes: blockRecord.record_hash });
    expect(superseding.status).toBe('completed');
    expect(superseding.supersedes).toBe(blockRecord.record_hash);
    expect(superseding.record_hash).not.toBe(blockRecord.record_hash);

    // The block-time record on disk is byte-for-byte unchanged.
    const onDisk = await readJson(path.join(paths.history, `${runId}.json`));
    expect(onDisk.record_hash).toBe(blockRecord.record_hash);
    expect(onDisk.status).toBe('blocked');

    // Both the block-time record and its superseding completion are queryable.
    const records = await queryHistory(paths, { run_id: runId });
    expect(records.some((record) => record.status === 'blocked')).toBe(true);
    expect(records.some((record) => record.status === 'completed')).toBe(true);

    // The default (unfiltered) listing collapses the run to its EFFECTIVE
    // record: exactly one entry, completed, referencing the block-time record
    // it supersedes — a recovered run must never list as blocked forever
    // (invariant 8).
    const listing = await queryHistory(paths, {});
    const listed = listing.filter((record) => record.run_id === runId);
    expect(listed).toHaveLength(1);
    expect(listed[0].status).toBe('completed');
    expect(listed[0].supersedes).toBe(blockRecord.record_hash);
  });
});

describe('APE v2 re-gate service (regateRun)', () => {
  async function bareProject() {
    const dir = await mkdtemp(path.join(tmpdir(), 'ape-regate-svc-'));
    cleanups.push(dir);
    return dir;
  }

  // The full-suite probe lives OUTSIDE the project so its executions never
  // perturb the project tree SHA; it exits 0 only once the operator has "fixed
  // the environment" by creating the marker file.
  async function gitProjectWithProbe() {
    const project = await mkdtemp(path.join(tmpdir(), 'ape-regate-project-'));
    const outside = await mkdtemp(path.join(tmpdir(), 'ape-regate-probe-'));
    cleanups.push(project, outside);
    await mkdir(path.join(project, 'src'));
    await writeFile(path.join(project, 'src', 'value.js'), 'export const value = 1;\n');
    git(project, 'init', '-q');
    git(project, 'config', 'user.email', 'ape@example.test');
    git(project, 'config', 'user.name', 'APE Test');
    git(project, 'add', '.');
    git(project, 'commit', '-qm', 'test: baseline');

    const probe = path.join(outside, 'probe.cjs');
    await writeFile(probe, [
      "const fs = require('node:fs');",
      'const [counter, marker] = process.argv.slice(2);',
      "fs.appendFileSync(counter, 'x');",
      'process.exit(fs.existsSync(marker) ? 0 : 1);',
    ].join('\n'));
    // Two independently armable suites from the same probe binary: `suite`
    // models test_commands.full, `serial` models test_commands.full_serial —
    // the serialized re-gate variant (serial re-gate, 2.0.32). Each records its executions in its
    // own counter so a test can prove exactly which command the gate ran.
    const probeSuite = (name) => {
      const counter = path.join(outside, `${name}.counter`);
      const marker = path.join(outside, `${name}.marker`);
      return {
        command: `node "${probe}" "${counter}" "${marker}"`,
        arm: () => writeFile(marker, 'pass\n'),
        executions: async () => {
          try {
            return (await readFile(counter, 'utf8')).length;
          } catch {
            return 0;
          }
        },
      };
    };
    return { project, suite: probeSuite('full'), serial: probeSuite('serial') };
  }

  // A run blocked at the merge gates (status 'blocked', stage 'gates') with
  // one attested receipt bound to `tree` — the only state re-gate may recover.
  function blockedAtGates(runId, tree) {
    return {
      version: 2,
      schema_version: '2.0.0',
      run_id: runId,
      status: 'blocked',
      stage: 'gates',
      block_reason: 'one or more deterministic merge gates failed',
      objective: 'Ship the value bump after fixing the environment',
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
      requirements: ['R-regate'],
      risk_triggers: [],
      branch: 'ape/phase-regate',
      base_commit_sha: 'a'.repeat(40),
      tree_sha: tree,
      tickets: [],
      receipts: [{
        receipt_hash: 'a',
        previous_receipt_hash: null,
        status: 'passed',
        agent: { host: 'codex', role: 'implementer' },
        tests: [{ passed: true }],
        changed_files: ['src/value.js'],
        head_tree_sha: tree,
      }],
      attempts: {},
      remediation_cycles: 0,
      regate_attempts: 0,
      gates: { passed: false, tree_sha: tree },
      created_at: '2026-07-01T00:00:00.000Z',
      updated_at: '2026-07-01T00:00:00.000Z',
      terminal_at: '2026-07-01T00:00:00.000Z',
    };
  }

  it('rejects re-gate for a run blocked on a stage failure and leaves its state untouched', async () => {
    const dir = await bareProject();
    const paths = runtimePaths(dir);
    await atomicWriteJson(paths.config, {
      shipping: { auto_merge: false, provider: 'github', required_remote_checks: false },
    });
    const blocked = {
      version: 2,
      schema_version: '2.0.0',
      run_id: 'run-regate-stage',
      status: 'blocked',
      stage: 'build',
      block_reason: 'stage build failed twice',
      objective: 'Recover a stage-failure block',
      mode: 'phase',
      lane: 'fast',
      host: 'codex',
      claimed_paths: ['src/value.js'],
      test_paths: ['tests/value.test.js'],
      requirements: [],
      risk_triggers: [],
      tickets: [],
      receipts: [],
      attempts: { build: 2 },
      remediation_cycles: 0,
      regate_attempts: 0,
      created_at: '2026-07-01T00:00:00.000Z',
      updated_at: '2026-07-01T00:00:00.000Z',
      terminal_at: '2026-07-01T00:00:00.000Z',
    };
    await atomicWriteJson(paths.active, blocked);

    const result = await service.regateRun(dir);
    expect(result.ok).toBe(false);
    const reason = result.reason ?? (result.errors ?? []).join(' ');
    expect(reason).toMatch(/gate-?blocked/i);

    // The stage-failure block is untouched: no recovery, no attempt consumed.
    const after = await readJson(paths.active);
    expect(after.status).toBe('blocked');
    expect(after.stage).toBe('build');
    expect(after.regate_attempts ?? 0).toBe(0);
  });

  it('re-runs the full gate suite and, on a fixed environment, completes with a superseding history record', async () => {
    const { project: dir, suite } = await gitProjectWithProbe();
    const paths = runtimePaths(dir);
    await atomicWriteJson(paths.config, {
      shipping: { auto_merge: true, provider: 'github', required_remote_checks: false },
      test_commands: { full: suite.command },
    });
    const tree = await currentTreeSha(dir);
    const runId = 'run-regate-complete';
    const blocked = blockedAtGates(runId, tree);
    await atomicWriteJson(paths.active, blocked);
    // F7: the block-time record already exists in immutable history.
    await archiveRun(paths, blocked, { ifAbsent: true });
    const beforeDisk = await readJson(path.join(paths.history, `${runId}.json`));

    // The operator fixes the environment so the previously failing suite passes.
    await suite.arm();

    const result = await service.regateRun(dir);
    expect(result.ok).toBe(true);
    expect(result.run.status).toBe('completed');
    expect(result.run.regate_attempts).toBe(1);
    // No bypass or waiver: the full suite genuinely re-executed.
    expect(await suite.executions()).toBeGreaterThanOrEqual(1);

    // The block-time record is preserved exactly; completion did not mutate it.
    const afterDisk = await readJson(path.join(paths.history, `${runId}.json`));
    expect(afterDisk).toEqual(beforeDisk);
    expect(afterDisk.status).toBe('blocked');

    // A superseding completion record was appended and is queryable.
    const records = await queryHistory(paths, { run_id: runId });
    expect(records.some((record) => record.status === 'completed')).toBe(true);
  });

  it('re-gate executes the configured serialized variant instead of re-rolling the flaky parallel command (serial re-gate, 2.0.32)', async () => {
    const { project: dir, suite, serial } = await gitProjectWithProbe();
    const paths = runtimePaths(dir);
    await atomicWriteJson(paths.config, {
      shipping: { auto_merge: true, provider: 'github', required_remote_checks: false },
      // `full` is NEVER armed: it models a permanent parallel-execution flake
      // that would fail again on every identical re-roll.
      test_commands: { full: suite.command, full_serial: serial.command },
    });
    const tree = await currentTreeSha(dir);
    const runId = 'run-regate-serial';
    const blocked = blockedAtGates(runId, tree);
    await atomicWriteJson(paths.active, blocked);
    // F7: the block-time record already exists in immutable history.
    await archiveRun(paths, blocked, { ifAbsent: true });

    // Only the serialized suite is armed; the parallel command still fails.
    await serial.arm();

    const result = await service.regateRun(dir);
    // The scheduler-incremented regate_attempts reached gates.js: the run
    // completed past the gates on the serialized suite alone.
    expect(result.ok).toBe(true);
    expect(result.run.status).toBe('completed');
    expect(await serial.executions()).toBe(1);
    // No re-roll of the identical dice throw: the flaky command never ran.
    expect(await suite.executions()).toBe(0);
    // Truthful completion: the persisted gate record names the command that
    // actually decided the full_suite gate.
    const persisted = await readJson(paths.active);
    expect(persisted.gates.checks.full_suite.command).toBe(serial.command);
  });

  it('accumulates runtime-measured test_ms onto the superseding completion instead of resetting the block record baseline (T14)', async () => {
    const { project: dir, suite } = await gitProjectWithProbe();
    const paths = runtimePaths(dir);
    await atomicWriteJson(paths.config, {
      shipping: { auto_merge: true, provider: 'github', required_remote_checks: false },
      test_commands: { full: suite.command },
    });
    const tree = await currentTreeSha(dir);
    const runId = 'run-regate-timing';
    // The block-time state already carries a non-zero measured baseline: the
    // gate suite the runtime ran before the run first blocked.
    const blocked = { ...blockedAtGates(runId, tree), timing: { test_ms: 5_000, remote_ci_ms: 0 } };
    await atomicWriteJson(paths.active, blocked);
    const blockRecord = await archiveRun(paths, blocked, { ifAbsent: true });
    // The immutable block-time record froze that baseline in its timing block.
    expect(blockRecord.timing).toBeDefined();
    expect(blockRecord.timing.test_ms).toBe(5_000);

    // The operator fixes the environment; re-gate genuinely re-runs the suite.
    await suite.arm();
    const result = await service.regateRun(dir);
    expect(result.ok).toBe(true);
    expect(result.run.status).toBe('completed');

    // The superseding completion is a distinct record with its OWN timing; the
    // re-gate's real full-suite run ADDED to the baseline (accumulate, never
    // reset), so its test_ms strictly exceeds the block record's.
    const records = await queryHistory(paths, { run_id: runId });
    const completed = records.find((record) => record.status === 'completed');
    expect(completed).toBeDefined();
    expect(completed.timing).toBeDefined();
    expect(completed.timing.test_ms).toBeGreaterThan(blockRecord.timing.test_ms);
  });

  // A run resting in the non-blocking shipping watch (phase 1 already pushed +
  // created the PR); each `ape_run next` is one bounded remote-checks poll slice.
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
      timing: { test_ms: 2_000, remote_ci_ms: 0 },
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

  it('accumulates runtime-measured remote_ci_ms across two poll slices onto the completed record, never resetting the baseline (T14/A7)', async () => {
    const { project: dir } = await gitProjectWithProbe();
    const paths = runtimePaths(dir);
    await atomicWriteJson(paths.config, {
      shipping: { auto_merge: true, provider: 'github', required_remote_checks: true },
    });
    const runId = 'run-shipping-cislices';
    const baseline = 4_000;
    await atomicWriteJson(paths.active, restingShipping(runId, { timing: { test_ms: 2_000, remote_ci_ms: baseline } }));
    await acquireRunLock(paths.lock, runId);
    const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    pollRemoteChecksAndMerge
      .mockImplementationOnce(async () => { await sleep(25); return { pending: { summary: '1 of 2 checks pending' } }; })
      .mockImplementationOnce(async () => {
        await sleep(25);
        return {
          merged: {
            provider: 'github',
            url: 'https://github.com/acme/repo/pull/7',
            branch: 'ape/phase-ship',
            base: 'main',
            merged_at: '2026-07-14T03:00:00.000Z',
          },
        };
      });

    const slice1 = await service.nextRun(dir);
    expect(slice1.ok).toBe(true);
    expect(slice1.run.status).toBe('shipping');
    const afterSlice1 = await readJson(paths.active);
    // Slice 1 accumulated onto the baseline, never resetting it.
    expect(afterSlice1.timing.remote_ci_ms).toBeGreaterThan(baseline);

    const slice2 = await service.nextRun(dir);
    expect(slice2.ok).toBe(true);
    expect(slice2.run.status).toBe('completed');
    const records = await queryHistory(paths, { run_id: runId });
    const completed = records.find((record) => record.status === 'completed');
    expect(completed).toBeDefined();
    // The archived remote_ci_ms is the SUM over both slices (baseline + slice1 + slice2).
    expect(completed.timing.remote_ci_ms).toBeGreaterThan(afterSlice1.timing.remote_ci_ms);
  });
});

function session(messages) {
  return new Promise((resolve, reject) => {
    // Strip the ambient host project pins so root resolution is driven by
    // the call arguments alone, not the live session env of whoever runs
    // the suite.
    const env = { ...process.env };
    delete env.CLAUDE_PROJECT_DIR;
    delete env.CODEX_CWD;
    const child = spawn(process.execPath, [path.join(root, 'bin', 'ape-mcp.mjs')], {
      cwd: root,
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code !== 0) reject(new Error(stderr));
      else resolve(stdout.trim().split(/\r?\n/).map((line) => JSON.parse(line)));
    });
    child.stdin.end(messages.map((message) => JSON.stringify(message)).join('\n') + '\n');
  });
}

describe('APE v2 re-gate MCP action surface', () => {
  it('exposes a regate action on the ape_run tool', async () => {
    const responses = await session([
      { jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} },
    ]);
    const runTool = responses[0].result.tools.find((tool) => tool.name === 'ape_run');
    expect(runTool).toBeDefined();
    expect(runTool.inputSchema.properties.action.enum).toContain('regate');
  });
});
