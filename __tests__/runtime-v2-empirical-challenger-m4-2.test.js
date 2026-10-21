import { gitFixtureEnv } from '../test-support/git-fixtures.js';
import { execFileSync } from 'node:child_process';
import { access, mkdir, mkdtemp, readFile, rm, writeFile, utimes } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { overrideRun, resumeRun, startRun } from '../lib/runtime/service.js';
import { runtimePaths } from '../lib/runtime/paths.js';
import { atomicWriteJson, readJson } from '../lib/runtime/storage.js';
import {
  discoverWorkCheckpoints,
  markCheckpointContinued,
  markCheckpointsForSupersededRun,
  pruneWorkCheckpoints,
  readWorkCheckpoint,
  restoreWorkCheckpoint,
  saveWorkCheckpoint,
} from '../lib/runtime/work-checkpoints.js';
import { applyActions } from '../lib/runtime/receipt-service.js';
import { loadRuntimeConfig } from '../lib/runtime/config.js';
import { sha256 } from '../lib/runtime/canonical.js';

const dirs = [];
afterEach(async () => Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))));

const git = (dir, args, options = {}) =>
  execFileSync('git', args, { env: gitFixtureEnv(), cwd: dir, encoding: 'utf8', ...options }).trim();

const fileExists = (file) => access(file).then(() => true, () => false);

async function project() {
  const dir = await mkdtemp(path.join(tmpdir(), 'ape-challenger-m4-2-'));
  dirs.push(dir);
  git(dir, ['init', '-q', '-b', 'main']);
  git(dir, ['config', 'user.name', 'APE Challenger']);
  git(dir, ['config', 'user.email', 'challenger@example.test']);
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

async function createBlockedRun(dir, suffix = '', claimed = ['README.md']) {
  const started = await startRun(dir, {
    objective: `Unfinished work ${suffix}`,
    mode: 'phase',
    lane: 'mechanical',
    host: 'claude',
    claimed_paths: claimed,
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
  state.block_reason = `Worker blocked synthetically ${suffix}`;
  await atomicWriteJson(runtimePaths(dir).active, state);
  await writeFile(path.join(dir, claimed[0]), `retained checkpoint work ${suffix}\n`);
  return state;
}

describe('Empirical Challenger M4-2: R6 Checkpoint Auto-Retirement & Background TTL Pruning Stress Test', () => {

  // =========================================================================
  // Challenge 1: Superseded Run Continuation
  // =========================================================================
  describe('1. Superseded run continuation', () => {
    it('marks ALL checkpoints of a superseded run continued (.continued.json), leaving other runs unaffected', async () => {
      const dir = await project();
      const paths = runtimePaths(dir);

      // Run 1: Create state and generate multiple checkpoints
      const state1 = await createBlockedRun(dir, 'run-1');
      const runId1 = state1.run_id;

      // Checkpoint 1a
      const cp1a = await saveWorkCheckpoint(paths, state1);
      expect(cp1a).toBeDefined();

      // Checkpoint 1b: modified work and updated block reason
      state1.block_reason = 'Secondary failure in run-1';
      state1.work_checkpoint_id = null; // allow saving a second checkpoint
      await writeFile(path.join(dir, 'README.md'), 'revision 2 work\n');
      const cp1b = await saveWorkCheckpoint(paths, state1);
      expect(cp1b).toBeDefined();
      expect(cp1b.checkpoint_id).not.toBe(cp1a.checkpoint_id);

      // Checkpoint 1c: third variation
      state1.block_reason = 'Tertiary failure in run-1';
      state1.work_checkpoint_id = null;
      await writeFile(path.join(dir, 'README.md'), 'revision 3 work\n');
      const cp1c = await saveWorkCheckpoint(paths, state1);
      expect(cp1c).toBeDefined();

      // Run 2: Unrelated bystander run checkpoint
      const bystanderRunId = 'run-bystander-000000000000000000000000';
      const state2 = {
        ...state1,
        run_id: bystanderRunId,
        block_reason: 'Unrelated bystander blocker',
        work_checkpoint_id: null,
      };
      await writeFile(path.join(dir, 'README.md'), 'bystander work\n');
      const cp2 = await saveWorkCheckpoint(paths, state2);
      expect(cp2).toBeDefined();

      // Verify all manifests exist and none are continued initially
      for (const cp of [cp1a, cp1b, cp1c, cp2]) {
        expect(await fileExists(path.join(paths.checkpoints, `${cp.checkpoint_id}.json`))).toBe(true);
        expect(await fileExists(path.join(paths.checkpoints, `${cp.checkpoint_id}.continued.json`))).toBe(false);
      }

      // Mark checkpoints continued for Run 1
      await markCheckpointsForSupersededRun(paths, runId1);

      // Verify ALL Run 1 checkpoints are marked continued
      for (const cp of [cp1a, cp1b, cp1c]) {
        const contFile = path.join(paths.checkpoints, `${cp.checkpoint_id}.continued.json`);
        expect(await fileExists(contFile)).toBe(true);
        const contRecord = await readJson(contFile);
        expect(contRecord.checkpoint_id).toBe(cp.checkpoint_id);
        expect(contRecord.run_id).toBe(runId1);
      }

      // Verify bystander run checkpoint remains strictly uncontinued
      expect(await fileExists(path.join(paths.checkpoints, `${cp2.checkpoint_id}.continued.json`))).toBe(false);
    });

    it('honors excludeCheckpointId during superseded run continuation marking', async () => {
      const dir = await project();
      const paths = runtimePaths(dir);
      const state = await createBlockedRun(dir, 'exclude-target');

      const cp1 = await saveWorkCheckpoint(paths, state);
      state.block_reason = 'Different reason';
      state.work_checkpoint_id = null;
      await writeFile(path.join(dir, 'README.md'), 'alt work\n');
      const cp2 = await saveWorkCheckpoint(paths, state);

      // Exclude cp1 while marking run continued
      await markCheckpointsForSupersededRun(paths, state.run_id, { excludeCheckpointId: cp1.checkpoint_id });

      expect(await fileExists(path.join(paths.checkpoints, `${cp1.checkpoint_id}.continued.json`))).toBe(false);
      expect(await fileExists(path.join(paths.checkpoints, `${cp2.checkpoint_id}.continued.json`))).toBe(true);
    });

    it('end-to-end startRun superseding automatically continues all checkpoints of blocked run', async () => {
      const dir = await project();
      const paths = runtimePaths(dir);
      const blockedState = await createBlockedRun(dir, 'e2e-superseded');

      const cp1 = await saveWorkCheckpoint(paths, blockedState);
      blockedState.block_reason = 'Second attempt failed';
      blockedState.work_checkpoint_id = null;
      await writeFile(path.join(dir, 'README.md'), 'updated dirty work\n');
      const cp2 = await saveWorkCheckpoint(paths, blockedState);

      // Revert dirty work to ensure clean start
      git(dir, ['checkout', 'HEAD', '--', 'README.md']);

      // Start new run superseding blockedState
      const newRun = await startRun(dir, {
        objective: 'Fresh superseding execution',
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
      expect(newRun.ok).toBe(true);

      // Both prior checkpoints must be marked continued
      expect(await fileExists(path.join(paths.checkpoints, `${cp1.checkpoint_id}.continued.json`))).toBe(true);
      expect(await fileExists(path.join(paths.checkpoints, `${cp2.checkpoint_id}.continued.json`))).toBe(true);
    });
  });

  // =========================================================================
  // Challenge 2: Complete Git Reference Deletion
  // =========================================================================
  describe('2. Git reference deletion', () => {
    it('deletes primary ref, index ref, prepared-* refs, and restore-index-* refs while preserving other checkpoints', async () => {
      const dir = await project();
      const paths = runtimePaths(dir);
      const state = await createBlockedRun(dir, 'git-ref-comprehensive');
      const checkpoint = await saveWorkCheckpoint(paths, state);
      const id = checkpoint.checkpoint_id;

      // Verify baseline Git refs created by saveWorkCheckpoint
      const baselineRef = `refs/ape/checkpoints/${id}`;
      const indexRef = `refs/ape/checkpoints/${id}-index`;
      expect(git(dir, ['for-each-ref', '--format=%(refname)', baselineRef])).toBe(baselineRef);
      expect(git(dir, ['for-each-ref', '--format=%(refname)', indexRef])).toBe(indexRef);

      // Create auxiliary prepared and restore-index refs as generated by restoreWorkCheckpoint
      const headSha = git(dir, ['rev-parse', 'HEAD']);
      const dummyBase1 = '0123456789abcdef0123456789abcdef01234567';
      const dummyBase2 = '89abcdef0123456789abcdef0123456789abcdef';
      const preparedRef1 = `refs/ape/checkpoints/${id}-prepared-${dummyBase1}`;
      const preparedRef2 = `refs/ape/checkpoints/${id}-prepared-${dummyBase2}`;
      const restoreIdxRef1 = `refs/ape/checkpoints/${id}-restore-index-1111222233334444555566667777888899990000`;
      const restoreIdxRef2 = `refs/ape/checkpoints/${id}-restore-index-aaaaabbbbbcccccdddddeeeeefffff0000011111`;

      git(dir, ['update-ref', preparedRef1, headSha]);
      git(dir, ['update-ref', preparedRef2, headSha]);
      git(dir, ['update-ref', restoreIdxRef1, headSha]);
      git(dir, ['update-ref', restoreIdxRef2, headSha]);

      // Create auxiliary on-disk prepared manifests
      await writeFile(path.join(paths.checkpoints, `${id}.${dummyBase1}.prepared.json`), JSON.stringify({ prepared: 1 }));
      await writeFile(path.join(paths.checkpoints, `${id}.${dummyBase2}.prepared.json`), JSON.stringify({ prepared: 2 }));

      // Create another completely independent uncontinued checkpoint to test blast radius
      const otherState = {
        ...state,
        run_id: 'run-keeper-000000000000000000000000',
        work_checkpoint_id: null,
      };
      await writeFile(path.join(dir, 'README.md'), 'keeper work\n');
      const keeperCheckpoint = await saveWorkCheckpoint(paths, otherState);
      const keeperId = keeperCheckpoint.checkpoint_id;
      const keeperPreparedRef = `refs/ape/checkpoints/${keeperId}-prepared-${dummyBase1}`;
      git(dir, ['update-ref', keeperPreparedRef, headSha]);

      // Confirm all refs exist before pruning
      const targetRefsBefore = git(dir, ['for-each-ref', '--format=%(refname)', `refs/ape/checkpoints/${id}*`]).split('\n');
      expect(targetRefsBefore).toContain(baselineRef);
      expect(targetRefsBefore).toContain(indexRef);
      expect(targetRefsBefore).toContain(preparedRef1);
      expect(targetRefsBefore).toContain(preparedRef2);
      expect(targetRefsBefore).toContain(restoreIdxRef1);
      expect(targetRefsBefore).toContain(restoreIdxRef2);

      const keeperRefsBefore = git(dir, ['for-each-ref', '--format=%(refname)', `refs/ape/checkpoints/${keeperId}*`]).split('\n');
      expect(keeperRefsBefore).toContain(`refs/ape/checkpoints/${keeperId}`);
      expect(keeperRefsBefore).toContain(keeperPreparedRef);

      // Mark target continued
      await markCheckpointContinued(paths, { checkpoint_id: id, run_id: state.run_id });

      // Run pruning
      const pruneResult = await pruneWorkCheckpoints(paths);
      expect(pruneResult.pruned).toContain(id);
      expect(pruneResult.pruned).not.toContain(keeperId);

      // Check that ALL target Git refs are completely deleted from Git storage
      const targetRefsAfter = git(dir, ['for-each-ref', '--format=%(refname)', `refs/ape/checkpoints/${id}*`]);
      expect(targetRefsAfter).toBe('');

      // Check on-disk cleanup
      expect(await fileExists(path.join(paths.checkpoints, `${id}.json`))).toBe(false);
      expect(await fileExists(path.join(paths.checkpoints, `${id}.continued.json`))).toBe(false);
      expect(await fileExists(path.join(paths.checkpoints, `${id}.${dummyBase1}.prepared.json`))).toBe(false);
      expect(await fileExists(path.join(paths.checkpoints, `${id}.${dummyBase2}.prepared.json`))).toBe(false);

      // BLAST RADIUS CHECK: Keeper refs and files MUST be 100% intact
      const keeperRefsAfter = git(dir, ['for-each-ref', '--format=%(refname)', `refs/ape/checkpoints/${keeperId}*`]).split('\n');
      expect(keeperRefsAfter).toContain(`refs/ape/checkpoints/${keeperId}`);
      expect(keeperRefsAfter).toContain(`refs/ape/checkpoints/${keeperId}-index`);
      expect(keeperRefsAfter).toContain(keeperPreparedRef);
      expect(await fileExists(path.join(paths.checkpoints, `${keeperId}.json`))).toBe(true);
    });

    it('exclude_checkpoint_id option protects continued checkpoint and its Git refs from deletion', async () => {
      const dir = await project();
      const paths = runtimePaths(dir);
      const state = await createBlockedRun(dir, 'exclude-protect');
      const checkpoint = await saveWorkCheckpoint(paths, state);
      const id = checkpoint.checkpoint_id;

      await markCheckpointContinued(paths, { checkpoint_id: id, run_id: state.run_id });

      // Prune with exclusion
      const result = await pruneWorkCheckpoints(paths, { exclude_checkpoint_id: id });
      expect(result.pruned_count).toBe(0);

      // Verify files and Git refs remain untouched
      expect(await fileExists(path.join(paths.checkpoints, `${id}.json`))).toBe(true);
      expect(await fileExists(path.join(paths.checkpoints, `${id}.continued.json`))).toBe(true);
      const refs = git(dir, ['for-each-ref', '--format=%(refname)', `refs/ape/checkpoints/${id}*`]);
      expect(refs).toContain(`refs/ape/checkpoints/${id}`);
    });
  });

  // =========================================================================
  // Challenge 3: TTL Expiration Stress Testing
  // =========================================================================
  describe('3. TTL expiration', () => {
    it('prunes unadopted checkpoints >= TTL and deletes their Git refs, while strictly preserving checkpoints < TTL', async () => {
      const dir = await project();
      const paths = runtimePaths(dir);
      const TTL_MS = 14 * 24 * 60 * 60 * 1000;
      const baseNow = Date.now();

      // Checkpoint 1: Old (15 days old) -> MUST be pruned
      const state1 = await createBlockedRun(dir, 'ttl-old');
      const cpOld = await saveWorkCheckpoint(paths, state1);
      const oldManifest = path.join(paths.checkpoints, `${cpOld.checkpoint_id}.json`);
      const { record_hash: _h1, ...oldContents } = await readJson(oldManifest);
      oldContents.created_at = new Date(baseNow - (15 * 24 * 60 * 60 * 1000)).toISOString();
      await writeFile(oldManifest, JSON.stringify({ ...oldContents, record_hash: sha256(oldContents) }));

      // Checkpoint 2: Exact boundary (exactly 14 days old) -> MUST be pruned
      state1.block_reason = 'Exact boundary blocker';
      state1.work_checkpoint_id = null;
      await writeFile(path.join(dir, 'README.md'), 'exact boundary work\n');
      const cpExact = await saveWorkCheckpoint(paths, state1);
      const exactManifest = path.join(paths.checkpoints, `${cpExact.checkpoint_id}.json`);
      const { record_hash: _h2, ...exactContents } = await readJson(exactManifest);
      exactContents.created_at = new Date(baseNow - TTL_MS).toISOString();
      await writeFile(exactManifest, JSON.stringify({ ...exactContents, record_hash: sha256(exactContents) }));

      // Checkpoint 3: Young (13 days old) -> MUST BE PRESERVED
      state1.block_reason = 'Young blocker';
      state1.work_checkpoint_id = null;
      await writeFile(path.join(dir, 'README.md'), 'young work\n');
      const cpYoung = await saveWorkCheckpoint(paths, state1);
      const youngManifest = path.join(paths.checkpoints, `${cpYoung.checkpoint_id}.json`);
      const { record_hash: _h3, ...youngContents } = await readJson(youngManifest);
      youngContents.created_at = new Date(baseNow - (13 * 24 * 60 * 60 * 1000)).toISOString();
      await writeFile(youngManifest, JSON.stringify({ ...youngContents, record_hash: sha256(youngContents) }));

      // None of the three have .continued.json
      expect(await fileExists(path.join(paths.checkpoints, `${cpOld.checkpoint_id}.continued.json`))).toBe(false);
      expect(await fileExists(path.join(paths.checkpoints, `${cpExact.checkpoint_id}.continued.json`))).toBe(false);
      expect(await fileExists(path.join(paths.checkpoints, `${cpYoung.checkpoint_id}.continued.json`))).toBe(false);

      // Execute pruning at baseNow with standard 14 days TTL
      const pruneResult = await pruneWorkCheckpoints(paths, { ttl_ms: TTL_MS, now: baseNow });

      expect(pruneResult.pruned).toContain(cpOld.checkpoint_id);
      expect(pruneResult.pruned).toContain(cpExact.checkpoint_id);
      expect(pruneResult.pruned).not.toContain(cpYoung.checkpoint_id);

      // Old & Exact disk files deleted
      expect(await fileExists(oldManifest)).toBe(false);
      expect(await fileExists(exactManifest)).toBe(false);

      // Old & Exact Git refs deleted
      expect(git(dir, ['for-each-ref', '--format=%(refname)', `refs/ape/checkpoints/${cpOld.checkpoint_id}*`])).toBe('');
      expect(git(dir, ['for-each-ref', '--format=%(refname)', `refs/ape/checkpoints/${cpExact.checkpoint_id}*`])).toBe('');

      // Young checkpoint STRICTLY PRESERVED on disk and in Git
      expect(await fileExists(youngManifest)).toBe(true);
      const youngRefs = git(dir, ['for-each-ref', '--format=%(refname)', `refs/ape/checkpoints/${cpYoung.checkpoint_id}*`]);
      expect(youngRefs).toContain(`refs/ape/checkpoints/${cpYoung.checkpoint_id}`);
      expect(youngRefs).toContain(`refs/ape/checkpoints/${cpYoung.checkpoint_id}-index`);

      // Young checkpoint remains discoverable by recovery APIs
      const discovery = await discoverWorkCheckpoints(paths);
      expect(discovery.count).toBe(1);
      expect(discovery.checkpoints[0].checkpoint_id).toBe(cpYoung.checkpoint_id);
    });

    it('falls back to filesystem mtime when created_at is unparseable', async () => {
      const dir = await project();
      const paths = runtimePaths(dir);
      const state = await createBlockedRun(dir, 'mtime-fallback');
      const cp = await saveWorkCheckpoint(paths, state);
      const manifest = path.join(paths.checkpoints, `${cp.checkpoint_id}.json`);

      // Corrupt the created_at field in manifest
      const data = await readJson(manifest);
      data.created_at = 'invalid-non-date-string';
      await writeFile(manifest, JSON.stringify(data));

      // Set file mtime to 20 days ago
      const twentyDaysAgo = new Date(Date.now() - (20 * 24 * 60 * 60 * 1000));
      await utimes(manifest, twentyDaysAgo, twentyDaysAgo);

      // Prune with 14-day TTL
      const pruneResult = await pruneWorkCheckpoints(paths, { ttl_ms: 14 * 24 * 60 * 60 * 1000, now: Date.now() });
      expect(pruneResult.pruned).toContain(cp.checkpoint_id);
      expect(await fileExists(manifest)).toBe(false);
      expect(git(dir, ['for-each-ref', '--format=%(refname)', `refs/ape/checkpoints/${cp.checkpoint_id}*`])).toBe('');
    });
  });

  // =========================================================================
  // Challenge 4: Error Resilience Under Hostile Conditions
  // =========================================================================
  describe('4. Error resilience', () => {
    it('returns empty result cleanly when checkpoints directory does not exist', async () => {
      const dir = await project();
      const nonExistentPaths = {
        root: dir,
        runtime: path.join(dir, '.ape', 'runtime'),
        checkpoints: path.join(dir, '.ape', 'runtime', 'non_existent_checkpoints'),
      };
      const result = await pruneWorkCheckpoints(nonExistentPaths);
      expect(result).toEqual({ pruned: [], deleted_refs: [], pruned_count: 0, pruned_checkpoints: [] });
    });

    it('survives malformed JSON manifests, 0-byte files, subdirectories, and non-checkpoint files without throwing', async () => {
      const dir = await project();
      const paths = runtimePaths(dir);
      await mkdir(paths.checkpoints, { recursive: true });

      // 1. Malformed JSON manifest
      await writeFile(
        path.join(paths.checkpoints, 'checkpoint-00000000000000000000000000000001.json'),
        '{{{ not valid json',
      );

      // 2. Empty 0-byte manifest
      await writeFile(
        path.join(paths.checkpoints, 'checkpoint-00000000000000000000000000000002.json'),
        '',
      );

      // 3. Orphan continuation file without manifest
      await writeFile(
        path.join(paths.checkpoints, 'checkpoint-00000000000000000000000000000003.continued.json'),
        JSON.stringify({ checkpoint_id: 'checkpoint-00000000000000000000000000000003', run_id: 'run-fixture' }),
      );

      // 4. Orphan prepared manifest without main manifest
      await writeFile(
        path.join(paths.checkpoints, 'checkpoint-00000000000000000000000000000003.deadbeef.prepared.json'),
        JSON.stringify({ prepared: true }),
      );

      // 5. Unrelated operator files and directories
      await writeFile(path.join(paths.checkpoints, 'README.txt'), 'operator notes');
      await mkdir(path.join(paths.checkpoints, 'subfolder'), { recursive: true });

      // 6. Also include a real valid checkpoint that is continued
      const state = await createBlockedRun(dir, 'resilience-valid');
      const validCp = await saveWorkCheckpoint(paths, state);
      await markCheckpointContinued(paths, { checkpoint_id: validCp.checkpoint_id, run_id: state.run_id });

      // Prune must not throw
      let pruneResult;
      await expect((async () => {
        pruneResult = await pruneWorkCheckpoints(paths);
      })()).resolves.not.toThrow();

      // Valid checkpoint was pruned
      expect(pruneResult.pruned).toContain(validCp.checkpoint_id);
      expect(await fileExists(path.join(paths.checkpoints, `${validCp.checkpoint_id}.json`))).toBe(false);

      // Orphan continuation was cleaned up
      expect(await fileExists(path.join(paths.checkpoints, 'checkpoint-00000000000000000000000000000003.continued.json'))).toBe(false);
      expect(await fileExists(path.join(paths.checkpoints, 'checkpoint-00000000000000000000000000000003.deadbeef.prepared.json'))).toBe(false);

      // Operator files and directories were untouched
      expect(await fileExists(path.join(paths.checkpoints, 'README.txt'))).toBe(true);
      expect(await fileExists(path.join(paths.checkpoints, 'subfolder'))).toBe(true);
    });

    it('gracefully handles missing Git references when pruning on-disk records', async () => {
      const dir = await project();
      const paths = runtimePaths(dir);
      const state = await createBlockedRun(dir, 'missing-git-ref');
      const cp = await saveWorkCheckpoint(paths, state);

      // Delete Git refs manually prior to prune to simulate external git ref corruption/pruning
      git(dir, ['update-ref', '-d', `refs/ape/checkpoints/${cp.checkpoint_id}`]);
      git(dir, ['update-ref', '-d', `refs/ape/checkpoints/${cp.checkpoint_id}-index`]);

      // Mark continued
      await markCheckpointContinued(paths, { checkpoint_id: cp.checkpoint_id, run_id: state.run_id });

      // Prune should cleanly delete disk files even though Git refs were already gone
      await expect(pruneWorkCheckpoints(paths)).resolves.not.toThrow();
      expect(await fileExists(path.join(paths.checkpoints, `${cp.checkpoint_id}.json`))).toBe(false);
      expect(await fileExists(path.join(paths.checkpoints, `${cp.checkpoint_id}.continued.json`))).toBe(false);
    });

    it('is fully idempotent across repeated pruning executions', async () => {
      const dir = await project();
      const paths = runtimePaths(dir);
      const state = await createBlockedRun(dir, 'idempotency');
      const cp = await saveWorkCheckpoint(paths, state);
      await markCheckpointContinued(paths, { checkpoint_id: cp.checkpoint_id, run_id: state.run_id });

      // First run prunes
      const run1 = await pruneWorkCheckpoints(paths);
      expect(run1.pruned_count).toBe(1);

      // Second run is a clean no-op
      const run2 = await pruneWorkCheckpoints(paths);
      expect(run2.pruned_count).toBe(0);

      // Third run is also a clean no-op
      const run3 = await pruneWorkCheckpoints(paths);
      expect(run3.pruned_count).toBe(0);
    });
  });
});
