import { existsSync, readFileSync } from 'node:fs';
import { mkdtemp, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { acquireRunLock, releaseRunLock } from '../lib/runtime/lock.js';

// Deterministic reproduction of review Finding C (invariant 7): releaseRunLock's
// ENOENT arm sweeps its own leaked tombstones but never re-verifies that the
// lock path is still ABSENT. A concurrent stealer's non-clobbering hand-back
// (stealLockFileByRename's link at lib/runtime/lock.js:95) can re-install the
// releasing owner's OWN captured bytes at the lock path AFTER the ENOENT read
// but before/around the sweep — and if the stealer has already dropped the
// tombstone that carried those bytes, the own-bytes sweep finds nothing to
// remove and returns. The result is an ORPHANED lock naming a still-ALIVE pid
// (this process): it wedges every later acquireRunLock with "another APE writing
// run is active" until the process exits, because the live pid defeats both the
// dead-pid ignore and the F9 recoverStale eviction.
//
// The interleaving is forced through a one-shot readdir seam (prior art:
// runtime-v2-file-lock-steal-window.test.js): when releaseRunLock('run-a')
// enters its ENOENT branch and scans the parent dir for its own tombstones, the
// gate re-installs A's own bytes at the lock path (the concurrent hand-back) and
// drops the tombstone, so the sweep sees nothing. Assertions are on the PUBLIC
// contract only: after the owner releases, the lock path is absent and a fresh
// acquire succeeds. Fixtures live under os.tmpdir() mkdtemp.
const seam = vi.hoisted(() => ({ readdir: null }));

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    readdir: async (...args) => (seam.readdir ? seam.readdir(actual, ...args) : actual.readdir(...args)),
  };
});

const cleanups = [];
afterEach(async () => {
  seam.readdir = null;
  await Promise.all(cleanups.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function scratch() {
  const dir = await mkdtemp(path.join(tmpdir(), 'ape-lock-reinstall-'));
  cleanups.push(dir);
  return dir;
}

describe('APE v2 file lock: releaseRunLock must not leave its own re-installed lock orphaned (review Finding C)', () => {
  it('reclaims a hand-back that re-installs the owner bytes during the ENOENT-branch sweep', async () => {
    const dir = await scratch();
    const lockPath = path.join(dir, 'active.lock');

    // A is a LIVE holder (this process): lockPath holds run-a's bytes.
    const aPayload = await acquireRunLock(lockPath, 'run-a');
    expect(aPayload.run_id).toBe('run-a');
    const aBytes = readFileSync(lockPath, 'utf8');

    // Model a stalled stealer that captured A's live bytes: the lock path is
    // transiently ABSENT (renamed into a tombstone) at the instant A releases.
    const tombstone = `${lockPath}.stale.captured`;
    await rename(lockPath, tombstone);
    expect(existsSync(lockPath)).toBe(false);

    // One-shot: when releaseRunLock('run-a') hits its ENOENT branch and scans
    // the parent dir for its own tombstones, let the stalled stealer's hand-back
    // re-install A's OWN bytes at the lock path and drop the tombstone, so the
    // own-bytes sweep finds nothing to remove.
    seam.readdir = async (actual, ...args) => {
      seam.readdir = null;
      await writeFile(lockPath, aBytes, { mode: 0o600 });
      await rm(tombstone, { force: true });
      return actual.readdir(...args);
    };

    await releaseRunLock(lockPath, 'run-a');

    // PUBLIC CONTRACT: after the owner releases, the lock path must be absent —
    // A's re-installed bytes are its own, released generation, not a live rival.
    expect(
      existsSync(lockPath),
      'invariant 7: releaseRunLock left its own re-installed bytes orphaned at the lock path',
    ).toBe(false);

    // And no wedge: a fresh acquire must succeed. Under the bug the orphan names
    // this live process, so even a recovery credit cannot evict it (F9).
    const fresh = await acquireRunLock(lockPath, 'run-fresh');
    expect(fresh.run_id).toBe('run-fresh');
    await releaseRunLock(lockPath, 'run-fresh');
    expect(existsSync(lockPath)).toBe(false);
  }, 15_000);
});
