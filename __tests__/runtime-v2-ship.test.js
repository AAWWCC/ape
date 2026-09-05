import { execFileSync, spawn } from 'node:child_process';
import { access, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { reduceRun } from '../lib/runtime/scheduler.js';
import { queryHistory } from '../lib/runtime/history.js';
import { runtimePaths } from '../lib/runtime/paths.js';
import { atomicWriteJson, readJson } from '../lib/runtime/storage.js';
import * as service from '../lib/runtime/service.js';
import * as spawning from '../lib/runtime/spawn.js';
import { sha256 } from '../lib/runtime/canonical.js';
import { admittedStartIdentityHash } from '../lib/runtime/admitted-start-identity.js';
import { inspectShippingAdmission } from '../lib/runtime/shipping-target.js';
import { loadRuntimeConfig } from '../lib/runtime/config.js';

// Ship is host-neutral and runtime-owned, so shipping (GitHub) is the only side
// effect these behavioral tests must not perform for real: the merge path is a
// mocked auto-merge while the full merge-gate suite itself runs genuinely (ship
// must re-run the full suite against the current tree with no bypass or waiver).
vi.mock('../lib/runtime/gates.js', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    autoMergeGithub: vi.fn(async () => ({
      url: 'https://github.com/acme/repo/pull/9',
      sha: 'e'.repeat(40),
      method: 'squash',
    })),
  };
});
import { autoMergeGithub } from '../lib/runtime/gates.js';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const HOLD_REASON = 'auto-merge is disabled by configuration';
const SHIPPING_TARGET = { origin: 'https://github.com/acme/repo.git', repository: 'acme/repo', base: 'main' };
let githubInspections = [];
let githubAccess = true;
beforeEach(() => {
  githubInspections = [];
  githubAccess = true;
  const originalSpawn = spawning.spawnWithTimeout;
  vi.spyOn(spawning, 'spawnWithTimeout').mockImplementation((command, args, options) => {
    if (command !== 'gh') return originalSpawn(command, args, options);
    githubInspections.push([...args]);
    if (args[0] !== '--version' && !(args[0] === 'api' && args[1] === 'repos/acme/repo')) {
      throw new Error('offline SHIP harness refused unexpected GitHub command');
    }
    return Promise.resolve({ exit_code: 0, timed_out: false, spawn_error: null, combined: args[0] === '--version' ? 'gh version offline' : JSON.stringify({
      full_name: 'acme/repo', archived: false, disabled: false,
      permissions: { pull: true, push: githubAccess }, allow_squash_merge: true,
    }) });
  });
});

// These tests do real filesystem work — `git init/add/commit` via execFileSync
// and spawned `node` gate probes — so on a loaded Windows CI runner a single
// test can legitimately run several seconds and the temp-dir teardown can race
// a not-yet-released file handle. A 30s budget keeps the slow-but-honest tests
// from tripping the 15s default, and the rm retry rides out the Windows EBUSY/
// EPERM that `force` alone does not retry (force only ignores ENOENT).
vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

const cleanups = [];
afterEach(async () => {
  autoMergeGithub.mockClear();
  vi.restoreAllMocks();
  await Promise.all(
    cleanups
      .splice(0)
      .map((dir) => rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })),
  );
});

function git(cwd, ...args) {
  execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' },
  });
}

function exists(file) {
  return access(file).then(() => true, () => false);
}

// A run HELD at the merge gate by disabled auto-merge (status 'blocked', stage
// 'merge', the exact hold reason) with green gates — the ONLY state ship may
// recover.
function held(overrides = {}) {
  return {
    run_id: 'run-ship-1',
    mode: 'phase',
    lane: 'mechanical',
    status: 'blocked',
    stage: 'merge',
    block_reason: HOLD_REASON,
    tickets: [],
    receipts: [],
    attempts: {},
    remediation_cycles: 0,
    regate_attempts: 0,
    high_risk: false,
    gates: { passed: true },
    ...overrides,
  };
}

describe('APE v2 ship reducer (SHIP event)', () => {
  it('recovers a held run: reacquires the lock, audits the ship, and re-runs the full gate suite', () => {
    const actions = reduceRun(held(), { type: 'SHIP', reason: 'hardware validation passed' });
    const types = actions.map((action) => action.type);
    // No bypass and no waiver: ship must actually re-run the gates.
    expect(types).not.toContain('reject');
    expect(types).toContain('acquire_lock');
    expect(types).toContain('run_gates');
    const audit = actions.find((action) => action.type === 'audit_override');
    expect(audit).toBeDefined();
    expect(audit.operation).toBe('ship');
    expect(audit.reason).toBe('hardware validation passed');
    const transition = actions.find((action) => action.type === 'transition');
    expect(transition).toBeDefined();
    // The run leaves the terminal 'blocked' status so the gate suite can run.
    expect(transition.patch.status).toBeDefined();
    expect(transition.patch.status).not.toBe('blocked');
    // A one-shot authorization that passes the service auto_merge hold, plus the
    // F40 terminal-stamp/reason reset.
    expect(transition.patch.ship_requested).toBe(true);
    expect(transition.patch.block_reason).toBe(null);
    expect(transition.patch.terminal_at).toBe(null);
  });

  it('rejects ship for a gate block and names REGATE as the recovery', () => {
    const actions = reduceRun(
      held({ stage: 'gates', block_reason: 'one or more deterministic merge gates failed' }),
      { type: 'SHIP', reason: 'x' },
    );
    const types = actions.map((action) => action.type);
    expect(types).not.toContain('run_gates');
    expect(types).not.toContain('acquire_lock');
    const reject = actions.find((action) => action.type === 'reject');
    expect(reject).toBeDefined();
    expect(reject.reason).toMatch(/REGATE/);
  });

  it('rejects ship for a stage-failure block', () => {
    const actions = reduceRun(
      held({ stage: 'build', block_reason: 'stage build failed twice' }),
      { type: 'SHIP', reason: 'x' },
    );
    expect(actions.map((action) => action.type)).not.toContain('run_gates');
    expect(actions.find((action) => action.type === 'reject')).toBeDefined();
  });

  it('rejects ship for a running run', () => {
    const actions = reduceRun(held({ status: 'running', stage: 'build' }), { type: 'SHIP', reason: 'x' });
    expect(actions.map((action) => action.type)).not.toContain('run_gates');
    expect(actions.find((action) => action.type === 'reject')).toBeDefined();
  });

  it('rejects ship for a completed run via the terminal guard', () => {
    const actions = reduceRun(held({ status: 'completed', stage: 'complete' }), { type: 'SHIP', reason: 'x' });
    const reject = actions.find((action) => action.type === 'reject');
    expect(reject).toBeDefined();
    expect(reject.reason).toMatch(/completed/);
  });

  it('rejects ship for a merge block whose reason is NOT the auto-merge hold', () => {
    const actions = reduceRun(
      held({ block_reason: 'shipping failed: gh pr merge exited non-zero' }),
      { type: 'SHIP', reason: 'x' },
    );
    expect(actions.map((action) => action.type)).not.toContain('run_gates');
    expect(actions.find((action) => action.type === 'reject')).toBeDefined();
  });

  it('GATES_FAILED clears a spent ship authorization and archives the failed re-gate as a superseding record', () => {
    const gf = reduceRun(
      held({ status: 'running', stage: 'gates', ship_requested: true }),
      { type: 'GATES_FAILED', reason: 'merge gates failed' },
    );
    const transition = gf.find((action) => action.type === 'transition');
    // One ship authorizes exactly one gate evaluation; a later green REGATE must
    // re-enter the hold, never silently merge under disabled config.
    expect(transition.patch.ship_requested).toBe(null);
    // A red ship's block-time record is the PASSING-gates hold record, so the
    // ship's real failed gates must reach immutable history as a superseding
    // record rather than being dropped by if_absent (invariants 4 and 8).
    const archive = gf.find((action) => action.type === 'archive_history');
    expect(archive.superseding).toBe(true);
    expect(archive.if_absent).not.toBe(true);
  });

  it('a plain gate block (no ship) still archives if_absent, not superseding', () => {
    const gf = reduceRun(
      held({ status: 'running', stage: 'gates' }),
      { type: 'GATES_FAILED', reason: 'merge gates failed' },
    );
    const archive = gf.find((action) => action.type === 'archive_history');
    expect(archive.if_absent).toBe(true);
    expect(archive.superseding).not.toBe(true);
  });

  it('a shipped run archives a superseding completion, and a first-pass run archives normally', () => {
    const base = {
      run_id: 'run-ship-merge',
      lane: 'mechanical',
      status: 'shipping',
      stage: 'merge',
      tickets: [],
      receipts: [],
      attempts: {},
      remediation_cycles: 0,
    };
    const shipped = reduceRun(
      { ...base, ship_requested: true, regate_attempts: 0 },
      { type: 'MERGED', merge: { url: 'x' } },
    );
    expect(shipped.find((action) => action.type === 'archive_history').superseding).toBe(true);

    // Neither re-gated nor held-then-shipped: a first, normal completion record.
    const plain = reduceRun(
      { ...base, ship_requested: false, regate_attempts: 0 },
      { type: 'MERGED', merge: { url: 'x' } },
    );
    expect(plain.find((action) => action.type === 'archive_history').superseding).not.toBe(true);
  });
});

describe('APE v2 ship service (shipRun)', () => {
  function mechanicalStart() {
    return {
      objective: 'Update the documentation note',
      mode: 'phase',
      lane: 'mechanical',
      host: 'codex',
      claimed_paths: ['docs/note.md'],
      test_paths: [],
      requirements: ['R-SHIP'],
      risk_triggers: [],
      behavioral: false,
      hooks_trusted: true,
      subagents_available: true,
      explicit_invocation: true,
    };
  }

  // The full-suite probe lives OUTSIDE the project so its executions never
  // perturb the project tree SHA (a gate command that moved the tree would fail
  // tree_binding); it exits 0 only while the operator has "accepted" the hold by
  // arming the marker, and records each execution in a counter.
  async function heldProject() {
    const project = await mkdtemp(path.join(tmpdir(), 'ape-ship-project-'));
    const outside = await mkdtemp(path.join(tmpdir(), 'ape-ship-probe-'));
    cleanups.push(project, outside);
    await mkdir(path.join(project, 'docs'));
    await writeFile(path.join(project, 'docs', 'note.md'), '# note\n');
    git(project, 'init', '-q');
    git(project, 'symbolic-ref', 'HEAD', 'refs/heads/main');
    git(project, 'config', 'user.email', 'ape@example.test');
    git(project, 'config', 'user.name', 'APE Test');
    git(project, 'config', 'commit.gpgsign', 'false');
    git(project, 'add', '.');
    git(project, 'commit', '-qm', 'test: baseline');
    git(project, 'remote', 'add', 'origin', SHIPPING_TARGET.origin);
    git(project, 'update-ref', 'refs/remotes/origin/main', 'HEAD');
    git(project, 'symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/main');

    const probe = path.join(outside, 'probe.cjs');
    await writeFile(probe, [
      "const fs = require('node:fs');",
      'const [counter, marker] = process.argv.slice(2);',
      "fs.appendFileSync(counter, 'x');",
      'process.exit(fs.existsSync(marker) ? 0 : 1);',
    ].join('\n'));
    const counter = path.join(outside, 'full.counter');
    const marker = path.join(outside, 'full.marker');
    const suite = {
      command: `node "${probe}" "${counter}" "${marker}"`,
      arm: () => writeFile(marker, 'pass\n'),
      disarm: () => rm(marker, { force: true }),
      executions: async () => {
        try {
          return (await readFile(counter, 'utf8')).length;
        } catch {
          return 0;
        }
      },
    };
    await atomicWriteJson(runtimePaths(project).config, {
      shipping: { auto_merge: false, provider: 'github', required_remote_checks: false, target: SHIPPING_TARGET },
      // Re-executes the suite on every gate evaluation so a ship's re-run is
      // observable (no cached pass masquerading as a real re-proof).
      policy: { full_suite_cache: false },
      test_commands: { full: suite.command },
    });
    return { project, suite };
  }

  async function buildToHold(dir) {
    const started = await service.startRun(dir, mechanicalStart());
    expect(started.ok).toBe(true);
    // The simulator bypasses host admission, so explicitly construct its
    // test-only commitment before receipt publication. Production SHIP never
    // backfills a missing admission on an already-running/held legacy state.
    const paths = runtimePaths(dir);
    const state = await readJson(paths.active);
    const admission = await inspectShippingAdmission(dir, {}, await loadRuntimeConfig(paths.config));
    expect(admission.ready).toBe(true);
    state.shipping_target = admission.shipping_target;
    const manifest = { version: 1, ready: true, shipping_target: structuredClone(state.shipping_target), repository: { base_branch: state.base_branch, base_commit: state.base_commit_sha } };
    state.admission = { version: 1, manifest, digest: sha256(manifest) };
    state.admitted_start_identity_hash = admittedStartIdentityHash(state);
    await atomicWriteJson(paths.active, state);
    const build = started.run.tickets[0];
    expect(build.role).toBe('implementer');
    await writeFile(path.join(dir, 'docs', 'note.md'), '# note\n\nUpdated.\n');
    const result = await service.recordReceipt(dir, {
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
    });
    return { runId: started.run.run_id, result };
  }

  it('holds a green mechanical run at merge: exact reason, immediate archive, released lock, ship in the status doc', async () => {
    const { project: dir, suite } = await heldProject();
    await suite.arm();
    const { runId, result } = await buildToHold(dir);
    expect(result.ok).toBe(true);
    expect(result.run.status).toBe('blocked');
    expect(result.run.stage).toBe('merge');
    expect(result.run.block_reason).toBe(HOLD_REASON);
    expect(await suite.executions()).toBe(1);

    // F7: the hold reached immutable history the moment it blocked.
    const paths = runtimePaths(dir);
    const records = await queryHistory(paths, { run_id: runId });
    expect(records.some((record) => record.status === 'blocked' && record.block_reason === HOLD_REASON)).toBe(true);

    // The run lock is released while held.
    expect(await exists(paths.lock)).toBe(false);

    // The status-doc Recovery line names ship.
    const statusDoc = await readFile(path.join(paths.runtime, 'status.md'), 'utf8');
    expect(statusDoc).toContain('**Recovery:**');
    expect(statusDoc).toContain('ship');
  });

  it('ships a held run: re-runs the full suite, merges despite auto_merge:false, and appends a superseding completion', async () => {
    const { project: dir, suite } = await heldProject();
    await suite.arm();
    const { runId } = await buildToHold(dir);
    const paths = runtimePaths(dir);
    const beforeDisk = await readJson(path.join(paths.history, `${runId}.json`));
    expect(beforeDisk.status).toBe('blocked');
    const executionsBeforeShip = await suite.executions();
    const targetBeforeShip = (await readJson(paths.active)).shipping_target;

    const result = await service.shipRun(dir, 'hardware validation passed out of band');
    expect(result.ok).toBe(true);
    expect(result.run.status).toBe('completed');
    // No bypass or waiver: the full suite genuinely re-executed.
    expect(await suite.executions()).toBeGreaterThan(executionsBeforeShip);
    // The audited SHIP lever passed the hold that config alone would keep closed.
    expect(autoMergeGithub).toHaveBeenCalledTimes(1);
    expect(result.run.shipping_target).toEqual(targetBeforeShip);
    expect(githubInspections.some((args) => args[1] === 'repos/acme/repo')).toBe(true);

    // The immutable block-time hold record is byte-identical; completion did not
    // mutate it.
    const afterDisk = await readJson(path.join(paths.history, `${runId}.json`));
    expect(afterDisk).toEqual(beforeDisk);

    // A superseding completion was appended and is queryable.
    const records = await queryHistory(paths, { run_id: runId });
    expect(records.some((record) => record.status === 'completed')).toBe(true);

    // The audited ship line is in the override log.
    const overrideLog = await readFile(paths.overrideLog, 'utf8');
    const lines = overrideLog.trim().split(/\r?\n/).map((line) => JSON.parse(line));
    expect(lines.some((line) => line.operation === 'ship' && line.reason === 'hardware validation passed out of band')).toBe(true);
  });

  it('rejects ship without an audit reason', async () => {
    const { project: dir, suite } = await heldProject();
    await suite.arm();
    await buildToHold(dir);
    await expect(service.shipRun(dir, '')).rejects.toThrow(/ship requires an audit reason/);
    await expect(service.shipRun(dir, undefined)).rejects.toThrow(/ship requires an audit reason/);
  });

  it.each(['legacy target absent', 'admission digest changed'])('refuses %s before prerequisite queries or gates and preserves the held state', async (variant) => {
    const { project: dir, suite } = await heldProject();
    await suite.arm();
    await buildToHold(dir);
    const paths = runtimePaths(dir);
    const state = await readJson(paths.active);
    if (variant === 'legacy target absent') delete state.shipping_target;
    else state.admission.digest = 'b'.repeat(64);
    await atomicWriteJson(paths.active, state);
    const before = await readFile(paths.active);
    const executions = await suite.executions();

    const result = await service.shipRun(dir, 'explicit shipping request');

    expect(result).toMatchObject({ ok: false, code: 'shipping-admission-invalid', attempts_consumed: 0 });
    expect(result.reason).toMatch(/fresh reviewed admission with operator approval/);
    expect(await readFile(paths.active)).toEqual(before);
    expect(await suite.executions()).toBe(executions);
    expect(githubInspections).toEqual([]);
    expect(autoMergeGithub).not.toHaveBeenCalled();
  });

  it('refuses an unavailable shipping prerequisite before gates without replacing the admitted target', async () => {
    const { project: dir, suite } = await heldProject();
    await suite.arm();
    await buildToHold(dir);
    const paths = runtimePaths(dir);
    const before = await readFile(paths.active);
    const executions = await suite.executions();
    githubAccess = false;

    const result = await service.shipRun(dir, 'explicit shipping request');

    expect(result).toMatchObject({ ok: false, code: 'shipping-prerequisites-unverified', attempts_consumed: 0 });
    expect(result.blocking.map((entry) => entry.code)).toContain('shipping_repository_access_unverified');
    expect(await readFile(paths.active)).toEqual(before);
    expect(await suite.executions()).toBe(executions);
    expect(autoMergeGithub).not.toHaveBeenCalled();
  });

  it('rejects ship for a gate-blocked run and leaves its state untouched', async () => {
    const { project: dir } = await heldProject();
    // The suite never passes, so the run blocks at the GATES, not the merge hold.
    const { result } = await buildToHold(dir);
    expect(result.run.status).toBe('blocked');
    expect(result.run.stage).toBe('gates');
    const paths = runtimePaths(dir);
    const before = await readJson(paths.active);

    const shipResult = await service.shipRun(dir, 'try to ship a gate block');
    expect(shipResult.ok).toBe(false);
    expect(shipResult.reason).toMatch(/REGATE/);
    expect(githubInspections).toEqual([]);

    const after = await readJson(paths.active);
    expect(after).toEqual(before);
  });

  it('red ship blocks at the gates (REGATE then applies), and a green re-gate re-enters the hold rather than merging under disabled config', async () => {
    const { project: dir, suite } = await heldProject();
    await suite.arm();
    const { runId } = await buildToHold(dir);
    const paths = runtimePaths(dir);

    // The out-of-band environment breaks while the run is held.
    await suite.disarm();
    const redShip = await service.shipRun(dir, 'attempt ship after acceptance');
    expect(redShip.ok).toBe(true);
    expect(redShip.run.status).toBe('blocked');
    expect(redShip.run.stage).toBe('gates');
    // The spent ship authorization is cleared.
    expect(redShip.run.ship_requested ?? null).toBe(null);
    // The failed re-gate reached immutable history alongside the hold record:
    // the hold record keeps the HOLD_REASON, and a superseding record carries
    // the real gate-failure reason (the immutable record stores block_reason,
    // not stage).
    const afterRed = await queryHistory(paths, { run_id: runId });
    expect(afterRed.some((record) => record.status === 'blocked' && record.block_reason === HOLD_REASON)).toBe(true);
    expect(afterRed.some((record) => record.status === 'blocked' && /deterministic merge gates failed/.test(record.block_reason ?? ''))).toBe(true);

    // REGATE is accepted from the gate block; still broken, so it re-fails.
    const redRegate = await service.regateRun(dir);
    expect(redRegate.ok).toBe(true);
    expect(redRegate.run.status).toBe('blocked');
    expect(redRegate.run.stage).toBe('gates');

    // Re-arm; a green re-gate re-enters the HOLD (no silent merge under
    // auto_merge:false), proving one ship authorized exactly one evaluation.
    await suite.arm();
    const greenRegate = await service.regateRun(dir);
    expect(greenRegate.ok).toBe(true);
    expect(greenRegate.run.status).toBe('blocked');
    expect(greenRegate.run.stage).toBe('merge');
    expect(greenRegate.run.block_reason).toBe(HOLD_REASON);
    expect(autoMergeGithub).not.toHaveBeenCalled();

    // A second ship then completes with a superseding record.
    const secondShip = await service.shipRun(dir, 'ship after the re-gate went green');
    expect(secondShip.ok).toBe(true);
    expect(secondShip.run.status).toBe('completed');
    expect(autoMergeGithub).toHaveBeenCalledTimes(1);
    const records = await queryHistory(paths, { run_id: runId });
    expect(records.some((record) => record.status === 'completed')).toBe(true);
  });

  it('a ship whose phase-1 auto-merge returns a watch descriptor rests in shipping: watch persisted, lock held, not archived', async () => {
    const { project: dir, suite } = await heldProject();
    await suite.arm();
    const { runId } = await buildToHold(dir);
    const paths = runtimePaths(dir);
    // Phase 1 hands off a non-blocking watch descriptor instead of a completed
    // merge; the service discriminates on the watch key (A6) and rests the run
    // in 'shipping' rather than treating it as merged.
    autoMergeGithub.mockResolvedValueOnce({
      watch: {
        provider: 'github',
        pr_url: 'https://github.com/acme/repo/pull/9',
        branch: 'feat/ship',
        base: 'main',
        head_oid: 'e'.repeat(40),
        created_at: new Date().toISOString(),
      },
    });
    const result = await service.shipRun(dir, 'ship into the non-blocking watch');
    expect(result.ok).toBe(true);
    expect(result.run.status).toBe('shipping');
    expect(autoMergeGithub).toHaveBeenCalledTimes(1);

    // The watch is persisted on active.json with the pushed head_oid and BOTH
    // selectors (A1/A2), plus a fresh poll cursor.
    const active = await readJson(paths.active);
    expect(active.status).toBe('shipping');
    expect(active.shipping_watch).toMatchObject({
      provider: 'github',
      pr_url: 'https://github.com/acme/repo/pull/9',
      branch: 'feat/ship',
      head_oid: 'e'.repeat(40),
    });
    expect(active.shipping_watch.last_poll_at ?? null).toBe(null);
    expect(active.shipping_watch.poll_count).toBe(0);

    // The record call ended promptly WITHOUT archiving a completion, and the run
    // lock is still held for the poll phase.
    const records = await queryHistory(paths, { run_id: runId });
    expect(records.some((record) => record.status === 'completed')).toBe(false);
    expect(await exists(paths.lock)).toBe(true);
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

describe('APE v2 ship MCP action surface', () => {
  it('exposes a ship action on the ape_run tool', async () => {
    const responses = await session([
      { jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} },
    ]);
    const runTool = responses[0].result.tools.find((tool) => tool.name === 'ape_run');
    expect(runTool).toBeDefined();
    expect(runTool.inputSchema.properties.action.enum).toContain('ship');
  });
});
