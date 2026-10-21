import { gitFixtureEnv } from '../test-support/git-fixtures.js';
import { execFileSync } from 'node:child_process';
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { overrideRun, resumeRun, startRun } from '../lib/runtime/service.js';
import { runtimePaths } from '../lib/runtime/paths.js';
import { atomicWriteJson, readJson } from '../lib/runtime/storage.js';
import {
  discoverWorkCheckpoints,
  markCheckpointContinued,
  pruneWorkCheckpoints,
  readWorkCheckpoint,
  saveWorkCheckpoint,
} from '../lib/runtime/work-checkpoints.js';
import { applyActions } from '../lib/runtime/receipt-service.js';
import { loadRuntimeConfig } from '../lib/runtime/config.js';

const dirs = [];
afterEach(async () => Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))));

const git = (dir, args, options = {}) =>
  execFileSync('git', args, { env: gitFixtureEnv(), cwd: dir, encoding: 'utf8', ...options }).trim();

const fileExists = (file) => access(file).then(() => true, () => false);

async function project() {
  const dir = await mkdtemp(path.join(tmpdir(), 'ape-checkpoint-prune-'));
  dirs.push(dir);
  git(dir, ['init', '-q', '-b', 'main']);
  git(dir, ['config', 'user.name', 'APE Test']);
  git(dir, ['config', 'user.email', 'ape@example.test']);
  git(dir, ['config', 'core.autocrlf', 'false']);
  await writeFile(path.join(dir, '.gitignore'), '.ape/\n');
  await writeFile(path.join(dir, 'README.md'), 'baseline\n');
  git(dir, ['add', '.']);
  git(dir, ['commit', '-qm', 'baseline']);
  await atomicWriteJson(runtimePaths(dir).config, {
    shipping: { auto_merge: false, provider: 'github', required_remote_checks: false },
    test_commands: { full: 'node --test', targeted_template: 'node --test {paths}' },
  });
  return dir;
}

async function createBlockedRun(dir, suffix = '') {
  const started = await startRun(dir, {
    objective: `Unfinished work ${suffix}`,
    mode: 'phase',
    lane: 'mechanical',
    host: 'claude',
    claimed_paths: ['README.md'],
    test_paths: [],
    requirements: [],
    risk_triggers: [],
    behavioral: false,
    hooks_trusted: true,
    subagents_available: true,
    explicit_invocation: true,
  });
  expect(started.ok).toBe(true);
  const state = await readJson(runtimePaths(dir).active);
  state.status = 'blocked';
  state.stage = 'build';
  state.block_reason = 'Worker failed synthetically';
  await atomicWriteJson(runtimePaths(dir).active, state);
  await writeFile(path.join(dir, 'README.md'), 'retained checkpoint work\n');
  return state;
}

describe('R6: Checkpoint auto-retirement and background TTL pruning', () => {
  it('marks checkpoints continued (.continued.json created) when run is superseded', async () => {
    const dir = await project();
    const state = await createBlockedRun(dir, 'supersede-target');
    const checkpoint = await saveWorkCheckpoint(runtimePaths(dir), state);
    expect(checkpoint).toBeDefined();

    const paths = runtimePaths(dir);
    const manifestFile = path.join(paths.checkpoints, `${checkpoint.checkpoint_id}.json`);
    const continuedFile = path.join(paths.checkpoints, `${checkpoint.checkpoint_id}.continued.json`);

    expect(await fileExists(manifestFile)).toBe(true);
    expect(await fileExists(continuedFile)).toBe(false);

    // Revert dirty work in working tree before starting a clean phase run
    git(dir, ['checkout', 'HEAD', '--', 'README.md']);

    // Starting a new run auto-supersedes the blocked run and marks checkpoints continued
    const nextStart = await startRun(dir, {
      objective: 'New run superseding blocked run',
      mode: 'phase',
      lane: 'mechanical',
      host: 'claude',
      claimed_paths: ['README.md'],
      test_paths: [],
      requirements: [],
      risk_triggers: [],
      behavioral: false,
      hooks_trusted: true,
      subagents_available: true,
      explicit_invocation: true,
    });
    expect(nextStart.ok).toBe(true);
    expect(await fileExists(continuedFile)).toBe(true);

    const continuedRecord = await readJson(continuedFile);
    expect(continuedRecord.checkpoint_id).toBe(checkpoint.checkpoint_id);
    expect(continuedRecord.run_id).toBe(state.run_id);
  });

  it('pruneWorkCheckpoints removes checkpoints with .continued.json and deletes Git refs', async () => {
    const dir = await project();
    const state = await createBlockedRun(dir, 'prune-continued');
    const checkpoint = await saveWorkCheckpoint(runtimePaths(dir), state);
    const paths = runtimePaths(dir);

    // Verify Git refs exist before prune
    const refsBefore = git(dir, ['for-each-ref', '--format=%(refname)', `refs/ape/checkpoints/${checkpoint.checkpoint_id}*`]);
    expect(refsBefore).toContain(`refs/ape/checkpoints/${checkpoint.checkpoint_id}`);

    // Mark continued
    await markCheckpointContinued(paths, { checkpoint_id: checkpoint.checkpoint_id, run_id: state.run_id });
    expect(await fileExists(path.join(paths.checkpoints, `${checkpoint.checkpoint_id}.continued.json`))).toBe(true);

    // Run prune
    const result = await pruneWorkCheckpoints(paths);
    expect(result.pruned_count).toBeGreaterThanOrEqual(1);
    expect(result.pruned_checkpoints.some((p) => p.checkpoint_id === checkpoint.checkpoint_id)).toBe(true);

    // Verify files on disk removed
    expect(await fileExists(path.join(paths.checkpoints, `${checkpoint.checkpoint_id}.json`))).toBe(false);
    expect(await fileExists(path.join(paths.checkpoints, `${checkpoint.checkpoint_id}.continued.json`))).toBe(false);

    // Verify Git refs deleted
    const refsAfter = git(dir, ['for-each-ref', '--format=%(refname)', `refs/ape/checkpoints/${checkpoint.checkpoint_id}*`]);
    expect(refsAfter).toBe('');

    // Verify discovery no longer lists pruned checkpoint
    const discovery = await discoverWorkCheckpoints(paths);
    expect(discovery.count).toBe(0);
  });

  it('pruneWorkCheckpoints removes unadopted checkpoints older than 14 days and deletes Git refs', async () => {
    const dir = await project();
    const state = await createBlockedRun(dir, 'prune-expired');
    const checkpoint = await saveWorkCheckpoint(runtimePaths(dir), state);
    const paths = runtimePaths(dir);

    // Checkpoint is NOT marked continued
    expect(await fileExists(path.join(paths.checkpoints, `${checkpoint.checkpoint_id}.continued.json`))).toBe(false);

    // Prune with ttl_ms = 0 to simulate age > 14 days
    const result = await pruneWorkCheckpoints(paths, { ttl_ms: 0 });
    expect(result.pruned_count).toBeGreaterThanOrEqual(1);
    expect(result.pruned_checkpoints.some((p) => p.checkpoint_id === checkpoint.checkpoint_id && p.reason === 'expired')).toBe(true);

    // Verify disk files and Git refs removed
    expect(await fileExists(path.join(paths.checkpoints, `${checkpoint.checkpoint_id}.json`))).toBe(false);
    const refsAfter = git(dir, ['for-each-ref', '--format=%(refname)', `refs/ape/checkpoints/${checkpoint.checkpoint_id}*`]);
    expect(refsAfter).toBe('');
  });

  it('pruneWorkCheckpoints preserves unadopted checkpoints younger than 14 days', async () => {
    const dir = await project();
    const state = await createBlockedRun(dir, 'preserve-young');
    const checkpoint = await saveWorkCheckpoint(runtimePaths(dir), state);
    const paths = runtimePaths(dir);

    // Prune with standard 14 days TTL (14 * 24 * 60 * 60 * 1000 ms)
    const result = await pruneWorkCheckpoints(paths, { ttl_ms: 14 * 24 * 60 * 60 * 1000 });
    expect(result.pruned_count).toBe(0);

    // Verify files and Git refs remain intact
    expect(await fileExists(path.join(paths.checkpoints, `${checkpoint.checkpoint_id}.json`))).toBe(true);
    const refs = git(dir, ['for-each-ref', '--format=%(refname)', `refs/ape/checkpoints/${checkpoint.checkpoint_id}*`]);
    expect(refs).toContain(`refs/ape/checkpoints/${checkpoint.checkpoint_id}`);

    // Still discoverable
    const discovery = await discoverWorkCheckpoints(paths);
    expect(discovery.count).toBe(1);
  });

  it('pruning gracefully handles missing files, partial Git refs, or corrupt manifests without throwing', async () => {
    const dir = await project();
    const paths = runtimePaths(dir);
    await mkdir(paths.checkpoints, { recursive: true });

    // 1. Corrupt manifest JSON
    await writeFile(path.join(paths.checkpoints, 'checkpoint-00000000000000000000000000000001.json'), '{ corrupt json content');

    // 2. Orphan continuation file without manifest
    await writeFile(
      path.join(paths.checkpoints, 'checkpoint-00000000000000000000000000000002.continued.json'),
      JSON.stringify({ checkpoint_id: 'checkpoint-00000000000000000000000000000002', run_id: 'run-fixture' }),
    );

    // 3. Unrelated non-checkpoint file
    await writeFile(path.join(paths.checkpoints, 'notes.txt'), 'some operator notes');

    // Must not throw
    await expect(pruneWorkCheckpoints(paths)).resolves.not.toThrow();

    // Notes file remains untouched
    expect(await fileExists(path.join(paths.checkpoints, 'notes.txt'))).toBe(true);
  });

  it('automatically prunes continued checkpoints during background archiveRun maintenance', async () => {
    const dir = await project();
    const paths = runtimePaths(dir);
    const config = await loadRuntimeConfig(paths.config);

    // Prior run creates a checkpoint and is continued
    const priorState = await createBlockedRun(dir, 'prior');
    const checkpoint = await saveWorkCheckpoint(paths, priorState);
    await markCheckpointContinued(paths, { checkpoint_id: checkpoint.checkpoint_id, run_id: priorState.run_id });
    expect(await fileExists(path.join(paths.checkpoints, `${checkpoint.checkpoint_id}.continued.json`))).toBe(true);

    // A subsequent run finishes and executes archive_history action
    const currentRun = {
      ...priorState,
      run_id: 'run-completed-maintenance',
      status: 'completed',
      stage: 'done',
      work_checkpoint_id: null,
    };
    await applyActions(paths, currentRun, [{ type: 'archive_history' }], config);

    // Background pruning within maintainArchivedArtifacts should have pruned the prior continued checkpoint
    expect(await fileExists(path.join(paths.checkpoints, `${checkpoint.checkpoint_id}.json`))).toBe(false);
    expect(await fileExists(path.join(paths.checkpoints, `${checkpoint.checkpoint_id}.continued.json`))).toBe(false);
    const refsAfter = git(dir, ['for-each-ref', '--format=%(refname)', `refs/ape/checkpoints/${checkpoint.checkpoint_id}*`]);
    expect(refsAfter).toBe('');
  });
});
