import { gitFixtureEnv } from '../test-support/git-fixtures.js';
import { afterEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { access, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { hostname, tmpdir } from 'node:os';
import path from 'node:path';
import { previewRun, startRun, resumeRun } from '../lib/runtime/service.js';
import { runtimePaths } from '../lib/runtime/paths.js';
import { atomicWriteJson, readJson } from '../lib/runtime/storage.js';
import { acquireRunLock, breakRunLock, inspectRunLock, releaseRunLock } from '../lib/runtime/lock.js';
import { archiveRun } from '../lib/runtime/history.js';

const cleanups = [];
afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

function git(cwd, ...args) {
  return execFileSync('git', args, { env: gitFixtureEnv(), cwd, encoding: 'utf8' }).trim();
}

async function createProject() {
  const dir = await mkdtemp(path.join(tmpdir(), 'ape-challenger-m1-'));
  cleanups.push(dir);
  await mkdir(path.join(dir, 'src'));
  await mkdir(path.join(dir, 'tests'));
  await writeFile(path.join(dir, 'src', 'index.js'), 'export const hello = "world";\n');
  await writeFile(path.join(dir, 'src', 'feature.js'), 'export const feat = 1;\n');
  await writeFile(path.join(dir, 'tests', 'index.test.js'), 'throw new Error("red");\n');
  git(dir, 'init', '-q', '-b', 'main');
  git(dir, 'config', 'user.email', 'ape-test@example.com');
  git(dir, 'config', 'user.name', 'APE Challenger');
  git(dir, 'add', '.');
  git(dir, 'commit', '-qm', 'initial commit');
  await atomicWriteJson(runtimePaths(dir).config, {
    shipping: { auto_merge: false, provider: 'github', required_remote_checks: false },
    test_commands: { full: 'node --test', targeted_template: 'node --test {paths}' },
  });
  return dir;
}

function baseStartInput(overrides = {}) {
  return {
    objective: 'Challenger M1 Stress Test',
    mode: 'phase',
    lane: 'fast',
    host: 'claude',
    claimed_paths: ['src/index.js', 'src/feature.js'],
    test_paths: ['tests/index.test.js'],
    requirements: [],
    risk_triggers: [],
    behavioral: true,
    hooks_trusted: true,
    subagents_available: true,
    explicit_invocation: true,
    ...overrides,
  };
}

function makeBlockedState(runId, overrides = {}) {
  return {
    version: 2,
    schema_version: '2.0.0',
    run_id: runId,
    status: 'blocked',
    stage: 'gates',
    block_reason: 'deterministic merge gates failed',
    objective: 'Initial failed run',
    mode: 'phase',
    lane: 'fast',
    host: 'claude',
    claimed_paths: ['src/index.js'],
    test_paths: ['tests/index.test.js'],
    requirements: [],
    risk_triggers: [],
    base_branch: 'main',
    branch: 'ape/test-branch',
    base_commit_sha: 'a'.repeat(40),
    tree_sha: 'b'.repeat(40),
    tickets: [],
    receipts: [],
    attempts: {},
    remediation_cycles: 0,
    regate_attempts: 0,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    terminal_at: new Date().toISOString(),
    ...overrides,
  };
}

describe('Challenger M1 Stress Suite: R1 & R2 Empirical Verification', () => {
  // =========================================================================
  // Challenge 1: Concurrent lock break attempts and rapid restart
  // =========================================================================
  describe('Area 1: Concurrent lock break and rapid restarts', () => {
    it('rapid sequential restarts cleanly chain supersedes_run without locking failure', async () => {
      const dir = await createProject();
      const paths = runtimePaths(dir);

      const r1 = await startRun(dir, baseStartInput({ objective: 'Run 1' }));
      expect(r1.ok).toBe(true);
      const r1Id = r1.run.run_id;

      // Transition R1 to blocked
      const active1 = await readJson(paths.active);
      active1.status = 'blocked';
      active1.stage = 'gates';
      active1.block_reason = 'gate failure 1';
      await atomicWriteJson(paths.active, active1);

      // Rapid start R2 superseding R1
      const r2 = await startRun(dir, baseStartInput({ objective: 'Run 2' }));
      expect(r2.ok).toBe(true);
      expect(r2.run.supersedes_run).toBe(r1Id);
      const r2Id = r2.run.run_id;

      // Transition R2 to blocked
      const active2 = await readJson(paths.active);
      active2.status = 'blocked';
      active2.stage = 'gates';
      active2.block_reason = 'gate failure 2';
      await atomicWriteJson(paths.active, active2);

      // Rapid start R3 superseding R2
      const r3 = await startRun(dir, baseStartInput({ objective: 'Run 3' }));
      expect(r3.ok).toBe(true);
      expect(r3.run.supersedes_run).toBe(r2Id);

      // Verify history contains both R1 and R2
      const h1 = await readJson(path.join(paths.history, `${r1Id}.json`));
      const h2 = await readJson(path.join(paths.history, `${r2Id}.json`));
      expect(h1.status).toBe('blocked');
      expect(h2.status).toBe('blocked');

      // Verify active lock is held by R3
      const lock = await inspectRunLock(paths.lock);
      expect(lock.present).toBe(true);
      expect(lock.run_id).toBe(r3.run.run_id);
    });

    it('concurrent startRun contenders on a blocked run serialize safely: one wins, contender rejects', async () => {
      const dir = await createProject();
      const paths = runtimePaths(dir);
      const priorRunId = 'run-blocked-conc-001';
      await atomicWriteJson(paths.active, makeBlockedState(priorRunId));
      await acquireRunLock(paths.lock, priorRunId);

      // Launch 2 concurrent startRun calls
      const [resA, resB] = await Promise.allSettled([
        startRun(dir, baseStartInput({ objective: 'Contender A' })),
        startRun(dir, baseStartInput({ objective: 'Contender B' })),
      ]);

      const fulfilled = [resA, resB].filter((r) => r.status === 'fulfilled');
      const rejected = [resA, resB].filter((r) => r.status === 'rejected');

      // Exactly one must succeed, the other must be rejected due to active run lock / run in progress
      expect(fulfilled).toHaveLength(1);
      expect(rejected).toHaveLength(1);
      expect(fulfilled[0].value.ok).toBe(true);
      expect(fulfilled[0].value.run.supersedes_run).toBe(priorRunId);
      expect(rejected[0].reason.message).toMatch(/already running/);

      // Verify repository integrity: active.json points to the winner, lock matches winner
      const active = await readJson(paths.active);
      expect(active.run_id).toBe(fulfilled[0].value.run.run_id);
      const lock = await inspectRunLock(paths.lock);
      expect(lock.run_id).toBe(fulfilled[0].value.run.run_id);
    });

    it('concurrent breakRunLock calls resolve idempotently without throwing', async () => {
      const dir = await createProject();
      const paths = runtimePaths(dir);
      const runId = 'run-concurrent-breaks-01';
      await acquireRunLock(paths.lock, runId);

      const breaks = await Promise.allSettled([
        breakRunLock(paths.lock, { runId }),
        breakRunLock(paths.lock, { runId }),
        breakRunLock(paths.lock, { runId }),
      ]);

      for (const res of breaks) {
        expect(res.status).toBe('fulfilled');
      }
      const lock = await inspectRunLock(paths.lock);
      expect(lock.present).toBe(false);
    });
  });

  // =========================================================================
  // Challenge 2: Stale tombstones left on disk and acquireRunLock
  // =========================================================================
  describe('Area 2: Stale tombstones resilience', () => {
    it('stale tombstones matching prior run are swept by breakRunLock during auto-retire', async () => {
      const dir = await createProject();
      const paths = runtimePaths(dir);
      const priorRunId = 'run-blocked-tombstone-01';
      await atomicWriteJson(paths.active, makeBlockedState(priorRunId));

      await mkdir(path.dirname(paths.lock), { recursive: true });
      const tombstonePath = `${paths.lock}.stale.${priorRunId}-uuid`;
      await writeFile(tombstonePath, JSON.stringify({
        version: 1,
        run_id: priorRunId,
        pid: process.pid,
        host: hostname(),
      }));

      const started = await startRun(dir, baseStartInput());
      expect(started.ok).toBe(true);
      expect(started.run.supersedes_run).toBe(priorRunId);

      // Tombstone should have been swept
      const exists = await access(tombstonePath).then(() => true, () => false);
      expect(exists).toBe(false);
    });

    it('dead-pid tombstones do not block acquireRunLock even without breakRunLock', async () => {
      const dir = await createProject();
      const paths = runtimePaths(dir);

      await mkdir(path.dirname(paths.lock), { recursive: true });
      const tombstonePath = `${paths.lock}.stale.deadpid-uuid`;
      await writeFile(tombstonePath, JSON.stringify({
        version: 1,
        run_id: 'ancient-run',
        pid: 99999999, // guaranteed non-existent PID
        host: hostname(),
      }));

      const payload = await acquireRunLock(paths.lock, 'run-fresh-01');
      expect(payload.run_id).toBe('run-fresh-01');
      await releaseRunLock(paths.lock, 'run-fresh-01');
    });

    it('orphaned tombstone from an unrelated run with live PID is swept unconditionally by breakRunLock and allows clean acquire', async () => {
      const dir = await createProject();
      const paths = runtimePaths(dir);
      const priorRunId = 'run-blocked-scoped-01';
      await atomicWriteJson(paths.active, makeBlockedState(priorRunId));

      // Orphaned tombstone from an older crashed run, but created by the same daemon/test-runner PID
      await mkdir(path.dirname(paths.lock), { recursive: true });
      const orphanTombstone = `${paths.lock}.stale.orphan-run-uuid`;
      await writeFile(orphanTombstone, JSON.stringify({
        version: 1,
        run_id: 'older-crashed-run',
        pid: process.pid,
        host: hostname(),
      }));

      // breakRunLock (even when called with options.runId) sweeps ALL tombstones unconditionally
      await breakRunLock(paths.lock, { runId: priorRunId });
      const orphanStillThere = await access(orphanTombstone).then(() => true, () => false);
      expect(orphanStillThere).toBe(false);

      // Now acquireRunLock succeeds cleanly on attempt 0 without churn!
      const acquired = await acquireRunLock(paths.lock, 'new-run-attempt');
      expect(acquired.run_id).toBe('new-run-attempt');
      await releaseRunLock(paths.lock, 'new-run-attempt');
    });
  });

  // =========================================================================
  // Challenge 3: Auto-retiring aborted run, history archives, and locks
  // =========================================================================
  describe('Area 3: Auto-retiring aborted run history and lock hygiene', () => {
    it('auto-retiring an aborted run does not corrupt pre-existing immutable history archive', async () => {
      const dir = await createProject();
      const paths = runtimePaths(dir);
      const abortedRunId = 'run-aborted-history-01';
      const abortedState = makeBlockedState(abortedRunId, {
        status: 'aborted',
        stage: 'dispatch',
        block_reason: null,
        abort_reason: 'Operator cancelled run manually',
      });
      await atomicWriteJson(paths.active, abortedState);

      // Pre-archive the run as if terminal abort had already archived it
      await archiveRun(paths, abortedState);
      const historyFile = path.join(paths.history, `${abortedRunId}.json`);
      const originalHistory = await readJson(historyFile);
      expect(originalHistory.run_id).toBe(abortedRunId);
      expect(originalHistory.abort_reason).toBe('Operator cancelled run manually');

      // Now start a new run that auto-retires this aborted run
      const started = await startRun(dir, baseStartInput());
      expect(started.ok).toBe(true);
      expect(started.run.supersedes_run).toBe(abortedRunId);

      // History file must remain intact and valid
      const preservedHistory = await readJson(historyFile);
      expect(preservedHistory.run_id).toBe(abortedRunId);
      expect(preservedHistory.record_hash).toBe(originalHistory.record_hash);

      // Lock is held by new run, not orphaned
      const lock = await inspectRunLock(paths.lock);
      expect(lock.present).toBe(true);
      expect(lock.run_id).toBe(started.run.run_id);
    });
  });

  // =========================================================================
  // Challenge 4: Single-step resume with dirty working files
  // =========================================================================
  describe('Area 4: Single-step resume dirty worktree preservation', () => {
    it('preserves modified tracked files, staged changes, and untracked files without loss', async () => {
      const dir = await createProject();
      const paths = runtimePaths(dir);

      const started = await startRun(dir, baseStartInput({
        claimed_paths: ['src/index.js', 'src/feature.js', 'src/new_untracked.js'],
      }));
      expect(started.ok).toBe(true);
      const blockedRunId = started.run.run_id;

      // Simulate the run getting blocked during build stage (not gates, so regate doesn't bypass resume)
      const active = await readJson(paths.active);
      active.status = 'blocked';
      active.stage = 'build';
      active.block_reason = 'Compilation error in feature.js: syntax error at line 42';
      await atomicWriteJson(paths.active, active);

      // Create dirty changes in working tree:
      // 1. Modified tracked file
      const modifiedContent = 'export const hello = "modified by worker before block";\n';
      await writeFile(path.join(dir, 'src', 'index.js'), modifiedContent);

      // 2. Staged tracked file
      const stagedContent = 'export const feat = "staged dirty change";\n';
      await writeFile(path.join(dir, 'src', 'feature.js'), stagedContent);
      git(dir, 'add', 'src/feature.js');

      // 3. Brand new untracked file
      const untrackedContent = 'export const newlyAdded = true;\n';
      await writeFile(path.join(dir, 'src', 'new_untracked.js'), untrackedContent);

      // Execute single-step self-healing resume
      const resumed = await resumeRun(dir, { explicit_invocation: true });
      expect(resumed.ok).toBe(true);
      expect(resumed.run.run_id).not.toBe(blockedRunId);
      expect(resumed.run.supersedes_run).toBe(blockedRunId);
      expect(resumed.run.status).toBe('running');

      // Verify all dirty files are preserved exactly on the replacement branch!
      const actualIndex = await readFile(path.join(dir, 'src', 'index.js'), 'utf8');
      const actualFeature = await readFile(path.join(dir, 'src', 'feature.js'), 'utf8');
      const actualUntracked = await readFile(path.join(dir, 'src', 'new_untracked.js'), 'utf8');

      expect(actualIndex).toBe(modifiedContent);
      expect(actualFeature).toBe(stagedContent);
      expect(actualUntracked).toBe(untrackedContent);

      // Verify blocker feedback was propagated
      expect(resumed.run.blocker_feedback).toContain('Compilation error in feature.js');
    });

    it('preserves uncommitted file deletion during single-step resume', async () => {
      const dir = await createProject();
      const paths = runtimePaths(dir);

      const started = await startRun(dir, baseStartInput({
        claimed_paths: ['src/index.js', 'src/feature.js'],
      }));
      expect(started.ok).toBe(true);
      const blockedRunId = started.run.run_id;

      const active = await readJson(paths.active);
      active.status = 'blocked';
      active.stage = 'build';
      active.block_reason = 'Removed feature file broke dependency';
      await atomicWriteJson(paths.active, active);

      // Uncommitted file deletion
      await rm(path.join(dir, 'src', 'feature.js'));

      const resumed = await resumeRun(dir, { explicit_invocation: true });
      expect(resumed.ok).toBe(true);
      expect(resumed.run.supersedes_run).toBe(blockedRunId);

      // Deleted file remains deleted in the resumed checkout
      const exists = await access(path.join(dir, 'src', 'feature.js')).then(() => true, () => false);
      expect(exists).toBe(false);
    });
  });
});
