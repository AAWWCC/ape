import { gitFixtureEnv } from '../test-support/git-fixtures.js';
import { afterEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { hostname, tmpdir } from 'node:os';
import path from 'node:path';
import { previewRun, startRun } from '../lib/runtime/service.js';
import { runtimePaths } from '../lib/runtime/paths.js';
import { atomicWriteJson, readJson } from '../lib/runtime/storage.js';
import { acquireRunLock, inspectRunLock } from '../lib/runtime/lock.js';

const cleanups = [];
afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

function git(cwd, ...args) {
  return execFileSync('git', args, { env: gitFixtureEnv(), cwd, encoding: 'utf8' }).trim();
}

async function project() {
  const dir = await mkdtemp(path.join(tmpdir(), 'ape-auto-supersede-'));
  cleanups.push(dir);
  await mkdir(path.join(dir, 'src'));
  await mkdir(path.join(dir, 'tests'));
  await writeFile(path.join(dir, 'src', 'index.js'), 'export const hello = "world";\n');
  await writeFile(path.join(dir, 'tests', 'index.test.js'), 'throw new Error("red");\n');
  git(dir, 'init', '-q', '-b', 'main');
  git(dir, 'config', 'user.email', 'ape@example.test');
  git(dir, 'config', 'user.name', 'APE Test');
  git(dir, 'add', '.');
  git(dir, 'commit', '-qm', 'baseline');
  await atomicWriteJson(runtimePaths(dir).config, {
    shipping: { auto_merge: false, provider: 'github', required_remote_checks: false },
    test_commands: { full: 'node --test', targeted_template: 'node --test {paths}' },
  });
  return dir;
}

function startInput(overrides = {}) {
  return {
    objective: 'Exercise auto-supersede of blocked/aborted runs',
    mode: 'phase',
    lane: 'fast',
    host: 'claude',
    claimed_paths: ['src/index.js'],
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

function blockedState(runId, overrides = {}) {
  return {
    version: 2,
    schema_version: '2.0.0',
    run_id: runId,
    status: 'blocked',
    stage: 'gates',
    block_reason: 'one or more deterministic merge gates failed',
    objective: 'Prior failed execution',
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
    created_at: '2026-10-21T00:00:00.000Z',
    updated_at: '2026-10-21T00:00:00.000Z',
    terminal_at: '2026-10-21T00:00:00.000Z',
    ...overrides,
  };
}

function abortedState(runId, overrides = {}) {
  return {
    ...blockedState(runId),
    status: 'aborted',
    stage: 'dispatch',
    block_reason: null,
    abort_reason: 'Operator cancelled execution',
    ...overrides,
  };
}

function runningState(runId, overrides = {}) {
  return {
    ...blockedState(runId),
    status: 'running',
    stage: 'dispatch',
    block_reason: null,
    terminal_at: undefined,
    ...overrides,
  };
}

async function overrideLogLines(paths) {
  const content = await readFile(paths.overrideLog, 'utf8').catch(() => '');
  return content.trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
}

describe('APE v2 lifecycle auto-supersede of blocked/aborted runs (R1)', () => {
  it('previewRun admits prospective run when active state is blocked', async () => {
    const dir = await project();
    const paths = runtimePaths(dir);
    const priorRunId = 'run-blocked-preview-01';
    await atomicWriteJson(paths.active, blockedState(priorRunId));

    const preview = await previewRun(dir, startInput({ admission_contract_version: 1 }));
    expect(preview.ok).toBe(true);
    expect(preview.admission.ready).toBe(true);
    expect(preview.admission.blocking).toEqual([]);
    expect(preview.admission.request.supersedes_run).toBe(priorRunId);
    expect(typeof preview.admission_digest).toBe('string');
    expect(preview.admission_digest).toMatch(/^[0-9a-f]{64}$/);
  });

  it('startRun auto-retires a blocked run, archives it, breaks lock, and starts fresh run', async () => {
    const dir = await project();
    const paths = runtimePaths(dir);
    const priorRunId = 'run-blocked-retire-01';
    await atomicWriteJson(paths.active, blockedState(priorRunId));
    await acquireRunLock(paths.lock, priorRunId);
    const statusDoc = path.join(paths.runtime, 'status.md');
    await writeFile(statusDoc, '# Previous blocked run status\n');

    const started = await startRun(dir, startInput());
    expect(started.ok).toBe(true);
    expect(started.run.run_id).not.toBe(priorRunId);
    expect(started.run.status).toBe('running');
    expect(started.run.supersedes_run).toBe(priorRunId);

    // active.json reflects the new run
    const currentActive = await readJson(paths.active);
    expect(currentActive.run_id).toBe(started.run.run_id);
    expect(currentActive.supersedes_run).toBe(priorRunId);

    // Overrides log records auto-retirement of the blocked run
    const audits = await overrideLogLines(paths);
    expect(audits).toContainEqual(expect.objectContaining({
      run_id: priorRunId,
      operation: 'auto-retire',
      reason: expect.stringContaining('Superseded by new startRun'),
    }));

    // History archive has the prior blocked run preserved
    const archived = await readJson(path.join(paths.history, `${priorRunId}.json`));
    expect(archived.run_id).toBe(priorRunId);
    expect(archived.status).toBe('blocked');

    // Run lock is now held by the new run, not the prior run
    const lock = await inspectRunLock(paths.lock);
    expect(lock.present).toBe(true);
    expect(lock.run_id).toBe(started.run.run_id);
  });

  it('startRun auto-retires an aborted run with supersedes_run audit and history', async () => {
    const dir = await project();
    const paths = runtimePaths(dir);
    const priorRunId = 'run-aborted-retire-01';
    await atomicWriteJson(paths.active, abortedState(priorRunId));
    await acquireRunLock(paths.lock, priorRunId);

    const started = await startRun(dir, startInput());
    expect(started.ok).toBe(true);
    expect(started.run.supersedes_run).toBe(priorRunId);

    const audits = await overrideLogLines(paths);
    expect(audits).toContainEqual(expect.objectContaining({
      run_id: priorRunId,
      operation: 'auto-retire',
      reason: expect.stringContaining('Superseded by new startRun'),
    }));

    const archived = await readJson(path.join(paths.history, `${priorRunId}.json`));
    expect(archived.run_id).toBe(priorRunId);
    expect(archived.status).toBe('aborted');
  });

  it('startRun with expected_admission_digest from previewRun starts cleanly on blocked state', async () => {
    const dir = await project();
    const paths = runtimePaths(dir);
    const priorRunId = 'run-blocked-preview-digest-01';
    await atomicWriteJson(paths.active, blockedState(priorRunId));

    const input = startInput({ admission_contract_version: 1 });
    const preview = await previewRun(dir, input);
    expect(preview.admission.ready).toBe(true);

    const started = await startRun(dir, {
      ...input,
      expected_admission_digest: preview.admission_digest,
    });
    expect(started.ok).toBe(true);
    expect(started.run.supersedes_run).toBe(priorRunId);
  });

  it('explicit supersedes_run naming an active blocked run is admitted and auto-retires', async () => {
    const dir = await project();
    const paths = runtimePaths(dir);
    const priorRunId = 'run-blocked-explicit-01';
    await atomicWriteJson(paths.active, blockedState(priorRunId));

    // In old code this was rejected with "an active blocked run cannot be superseded by a new start"
    const started = await startRun(dir, startInput({
      supersedes_run: priorRunId,
    }));
    expect(started.ok).toBe(true);
    expect(started.run.supersedes_run).toBe(priorRunId);
  });

  it('startRun breaks live run lock held by prior blocked run', async () => {
    const dir = await project();
    const paths = runtimePaths(dir);
    const priorRunId = 'run-blocked-livelock-01';
    await atomicWriteJson(paths.active, blockedState(priorRunId));
    // Simulate live lock owned by current process PID
    await acquireRunLock(paths.lock, priorRunId);
    const probeBefore = await inspectRunLock(paths.lock);
    expect(probeBefore.present).toBe(true);
    expect(probeBefore.run_id).toBe(priorRunId);

    const started = await startRun(dir, startInput());
    expect(started.ok).toBe(true);
    const probeAfter = await inspectRunLock(paths.lock);
    expect(probeAfter.run_id).toBe(started.run.run_id);
  });

  it('does NOT auto-retire genuine running or gating runs', async () => {
    const dir = await project();
    const paths = runtimePaths(dir);
    const runningRunId = 'run-active-running-01';
    await atomicWriteJson(paths.active, runningState(runningRunId));

    await expect(startRun(dir, startInput())).rejects.toThrow(
      new RegExp(`run ${runningRunId} is already running`),
    );

    // Active state and override log remain untouched
    const active = await readJson(paths.active);
    expect(active.run_id).toBe(runningRunId);
    expect(active.status).toBe('running');
    const audits = await overrideLogLines(paths);
    expect(audits).toEqual([]);
  });

  it('marks work checkpoint continued when auto-retiring superseded run', async () => {
    const dir = await project();
    const paths = runtimePaths(dir);
    const priorRunId = 'run-blocked-checkpoint-01';
    const checkpointId = 'checkpoint-0123456789abcdef0123456789abcdef';
    await mkdir(paths.checkpoints, { recursive: true });
    await atomicWriteJson(path.join(paths.checkpoints, `${checkpointId}.json`), {
      checkpoint_id: checkpointId,
      source_run_id: priorRunId,
    });
    await atomicWriteJson(paths.active, blockedState(priorRunId, {
      checkpoint_id: checkpointId,
    }));

    const started = await startRun(dir, startInput());
    expect(started.ok).toBe(true);

    // Checkpoint continuation marker should exist
    const continuedPath = path.join(paths.checkpoints, `${checkpointId}.continued.json`);
    const exists = await access(continuedPath).then(() => true, () => false);
    expect(exists).toBe(true);
  });

  it('startRun auto-retires a blocked run cleanly even when an orphaned foreign tombstone with live PID exists', async () => {
    const dir = await project();
    const paths = runtimePaths(dir);
    const priorRunId = 'run-blocked-orphan-live-01';
    await atomicWriteJson(paths.active, blockedState(priorRunId));
    await acquireRunLock(paths.lock, priorRunId);

    // Seed orphaned tombstone from unrelated run with same host and living PID
    await mkdir(path.dirname(paths.lock), { recursive: true });
    const orphanTombstone = `${paths.lock}.stale.unrelated-crashed-run-uuid`;
    await writeFile(orphanTombstone, JSON.stringify({
      version: 1,
      run_id: 'unrelated-crashed-run',
      pid: process.pid,
      host: hostname(),
    }));

    const started = await startRun(dir, startInput());
    expect(started.ok).toBe(true);
    expect(started.run.supersedes_run).toBe(priorRunId);

    // Orphaned tombstone must be swept
    const orphanExists = await access(orphanTombstone).then(() => true, () => false);
    expect(orphanExists).toBe(false);

    // Active lock is now held by the new run
    const lock = await inspectRunLock(paths.lock);
    expect(lock.present).toBe(true);
    expect(lock.run_id).toBe(started.run.run_id);
  });
});
