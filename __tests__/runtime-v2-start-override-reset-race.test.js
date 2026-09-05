import { execFileSync } from 'node:child_process';
import { constants as fsConstants } from 'node:fs';
import { mkdtemp, mkdir, open, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { abortRun, overrideRun, startRun } from '../lib/runtime/service.js';
import { runtimePaths } from '../lib/runtime/paths.js';
import { inspectRunLock } from '../lib/runtime/lock.js';
import { atomicWriteJson, readJson } from '../lib/runtime/storage.js';

// Audit 1.9 (invariant 7: one active writer, atomic state): startRun and
// overrideRun('reset') must be serialized so a reset that validated the
// PREVIOUS sealed run can never destroy a NEWLY started run's only state.
// The raced interleaving this file pins:
//   1. the previous run rests sealed (aborted/completed) in active.json;
//   2. a reset reads and validates that old sealed state;
//   3. before the reset's deletion applies, a concurrent startRun runs to
//      completion and persists a NEW run's active.json (holding the new
//      run's lock);
//   4. the reset's deletion then fires against the new run's state.
// A correct runtime — whichever way it serializes the two writers — leaves
// the new run's active state intact (or refuses the stale reset); it never
// ends with no active.json while the new run's lock and branch live on.
//
// Interleaving technique (deterministic, public surface only): the reset's
// critical section performs an archive step that reads the on-disk tree-index
// scratch file — documented in runtimePaths as a pure cache, "safe to delete
// at any time, rebuilt on the next call" — after it has validated the sealed
// state and before its destructive apply. Replacing that cache file with a
// FIFO lets the test hold the reset at exactly that point and release it by
// closing the write end: the same deterministic hold/release-of-an-on-disk-
// file discipline the sibling lock tests use, with no runtime instrumentation.
// Every assertion below is about the raced OUTCOME (which state survives,
// whether a lock is orphaned), never about which lock either operation held.

const cleanups = [];
afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function git(cwd, ...args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

async function project() {
  const dir = await mkdtemp(path.join(tmpdir(), 'ape-start-reset-race-'));
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
    test_commands: { full: 'node --test', targeted_template: 'node --test {paths}' },
  });
  return dir;
}

function startInput(objective) {
  return {
    objective,
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
  };
}

// Seal a previous run in active.json through the public API alone: a real
// start followed by a real abort leaves the aborted state persisted as sealed
// history with the run lock released — exactly the resting state override
// reset is documented to clear.
async function sealedPreviousRun(dir) {
  const started = await startRun(dir, startInput('first run: becomes the sealed previous run'));
  expect(started.ok).toBe(true);
  const aborted = await abortRun(dir, 'seal the previous run for the reset fixture');
  expect(aborted.run.status).toBe('aborted');
  return started.run.run_id;
}

// Rendezvous with the in-flight reset: a non-blocking write-open of a FIFO
// succeeds only once a reader has it open, i.e. only once the reset has
// validated the sealed state and reached its pre-deletion cache read. Bounded
// retry, no fixed sleeps.
async function openWriteEndWhenReaderArrives(fifoPath, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      return await open(fifoPath, fsConstants.O_WRONLY | fsConstants.O_NONBLOCK);
    } catch (error) {
      if (error?.code !== 'ENXIO') throw error;
      if (Date.now() > deadline) {
        throw new Error('timed out waiting for the reset to reach its pre-deletion read');
      }
      await sleep(10);
    }
  }
}

async function waitFor(probe, timeoutMs, intervalMs = 25) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await probe()) return true;
    if (Date.now() > deadline) return false;
    await sleep(intervalMs);
  }
}

describe('APE v2 startRun vs overrideRun(reset) serialization (audit 1.9, invariant 7)', () => {
  it('control: a plain reset of a sealed run with no concurrent start still succeeds', async () => {
    const dir = await project();
    await sealedPreviousRun(dir);
    const paths = runtimePaths(dir);

    const result = await overrideRun(dir, 'reset', 'control: clear the sealed previous run');

    expect(result.ok).toBe(true);
    expect(await readJson(paths.active, null)).toBeNull();
    expect((await inspectRunLock(paths.lock)).present).toBe(false);
  });

  it.skipIf(process.platform === 'win32')(
    'racing: a reset validated against the previous sealed run never deletes a newly started run\'s state',
    async () => {
      const dir = await project();
      const oldRunId = await sealedPreviousRun(dir);
      const paths = runtimePaths(dir);

      // Plant the deterministic stall point: swap the pure-cache tree-index
      // scratch file for a FIFO so the reset blocks between validating the old
      // sealed state and applying its deletion.
      await rm(paths.treeIndex, { force: true });
      execFileSync('mkfifo', [paths.treeIndex]);

      const overridePromise = overrideRun(
        dir,
        'reset',
        'racing: reset the sealed previous run while a new start is in flight',
      );
      overridePromise.catch(() => {});
      let startPromise = null;
      let writeEnd = null;
      try {
        // The reset has now read + validated the OLD sealed state and is held
        // at its pre-deletion cache read.
        writeEnd = await openWriteEndWhenReaderArrives(paths.treeIndex, 4_000);
        // Restore the documented safe-to-delete cache state (absent) for every
        // other reader; the held reset keeps its already-open descriptor.
        await rm(paths.treeIndex, { force: true });

        startPromise = startRun(dir, startInput('second run: races the in-flight reset'));
        startPromise.catch(() => {});

        // Today the unserialized start persists the NEW run while the reset is
        // still in flight; wait for that persist so the reset's deletion is
        // released strictly after it. A runtime that instead serializes the
        // whole start behind the in-flight reset never persists during this
        // bounded wait — the timeout arm then releases the reset first and the
        // start completes afterwards. Both orderings are covered below.
        const persistedDuringReset = await waitFor(async () => {
          const active = await readJson(paths.active, null).catch(() => null);
          return active !== null && active.run_id !== oldRunId;
        }, 5_000);
        if (persistedDuringReset) await startPromise;
      } finally {
        // Release the held reset (EOF on the cache read) and drain both
        // operations so no promise or descriptor outlives the test.
        if (writeEnd) await writeEnd.close().catch(() => {});
        await Promise.allSettled([overridePromise, startPromise ?? Promise.resolve()]);
      }
      const [overrideSettled, startSettled] = await Promise.allSettled([
        overridePromise,
        startPromise,
      ]);

      // The start itself succeeds under every correct serialization (it either
      // ran to completion first or waited out the reset), so this is shared
      // ground, not the red anchor.
      expect(startSettled.status).toBe('fulfilled');
      const started = startSettled.value;
      expect(started.ok).toBe(true);
      const newRunId = started.run.run_id;
      expect(newRunId).not.toBe(oldRunId);

      // RED anchor (the audited defect): the reset validated the OLD sealed
      // run, so after both operations settle the NEW run's active state must
      // survive — today the reset's deletion fires after the new run persisted
      // and erases the new run's only state.
      const finalActive = await readJson(paths.active, null);
      expect(
        finalActive,
        'a reset validated against the previous sealed run deleted the newly started run\'s active state',
      ).not.toBeNull();
      expect(finalActive.run_id).toBe(newRunId);

      // No orphaned run lock: whatever lock remains must belong to the run the
      // surviving active state names — never a lock for a run whose state is
      // gone.
      const lock = await inspectRunLock(paths.lock);
      if (lock.present) {
        expect(lock.readable).toBe(true);
        expect(lock.run_id).toBe(finalActive.run_id);
      }

      // The reset must settle either as a success that left the new run's
      // state alone (asserted above) or as a stable refusal; either shape is a
      // correct outcome, so only settlement is required here.
      expect(['fulfilled', 'rejected']).toContain(overrideSettled.status);
    },
  );
});
