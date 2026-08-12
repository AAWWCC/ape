import { existsSync, readFileSync } from 'node:fs';
import { mkdir, mkdtemp, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { withDirLock } from '../lib/runtime/lock.js';

// Deterministic reproduction of the withDirLock stale-steal two-writer race
// (audit HIGH finding 1.1, invariant 7). The dir-lock steal in lib/runtime/
// lock.js renames a stale lock dir to a tombstone and removes it with no
// post-rename verification. A contender that stalls between its staleness
// stat and its rename can therefore rename a rival's FRESH lock dir to a
// tombstone and delete it, letting two writers hold the critical section at
// once. The fix must mirror the file-lock steal discipline
// (stealLockFileByRename): after the rename, re-verify the renamed dir really
// was the stale generation (tombstone mtime still older than staleMs, or an
// owner token captured with the staleness judgment) and on mismatch rename it
// back and lose the contention.
//
// The module mock below is a transparent passthrough to the real
// node:fs/promises until a test opts one specific lock dir into the race by
// setting `race.lockPath`. The interception fires exactly once, inside the
// loser's staleness stat: it returns the genuinely stale metadata the loser
// observed, but before the loser can act on it a faster contender completes
// the same steal legitimately and installs its own FRESH lock in place —
// exactly the interleaving a scheduling stall produces in production.
const race = vi.hoisted(() => ({ lockPath: null, winnerToken: null, swapped: false }));

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal();
  const { join } = await import('node:path');
  return {
    ...actual,
    stat: async (...args) => {
      const [target] = args;
      if (race.lockPath !== null && target === race.lockPath && !race.swapped) {
        race.swapped = true;
        // The loser's staleness judgment: it genuinely observes the dead
        // holder's stale dir...
        const staleMetadata = await actual.stat(...args);
        // ...then stalls. While it is stalled, a faster contender wins the
        // same steal (rename to its own tombstone, then remove) and acquires
        // a fresh lock of its own, mkdir + owner token, with a current mtime.
        const winnerTombstone = `${target}.stale.winner-simulated`;
        await actual.rename(target, winnerTombstone);
        await actual.rm(winnerTombstone, { recursive: true, force: true });
        await actual.mkdir(target, { mode: 0o700 });
        await actual.writeFile(join(target, 'owner'), race.winnerToken, {
          encoding: 'utf8',
          mode: 0o600,
        });
        // The stalled loser now resumes with pre-swap staleness evidence.
        return staleMetadata;
      }
      return actual.stat(...args);
    },
  };
});

const cleanups = [];
afterEach(async () => {
  race.lockPath = null;
  race.winnerToken = null;
  race.swapped = false;
  await Promise.all(cleanups.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function scratch() {
  const dir = await mkdtemp(path.join(tmpdir(), 'ape-dir-lock-steal-'));
  cleanups.push(dir);
  return dir;
}

// A dead holder's lock dir: owner token present, mtime far past any staleness
// threshold used below, i.e. the heartbeat stopped long ago.
async function staleLockDir(lockPath, ownerToken) {
  await mkdir(lockPath);
  await writeFile(path.join(lockPath, 'owner'), ownerToken, { encoding: 'utf8', mode: 0o600 });
  const dead = new Date(Date.now() - 10 * 60_000);
  await utimes(lockPath, dead, dead);
}

describe('APE v2 dir-lock stale steal verifies the stolen generation (invariant 7)', () => {
  // RED today: the loser's rename-then-rm at lib/runtime/lock.js has no
  // post-rename verification, so it deletes the winner's fresh lock, loops,
  // mkdir succeeds, and it enters the critical section as a second concurrent
  // writer. GREEN once the steal re-verifies the renamed dir was the stale
  // generation and on mismatch renames it back and loses the contention.
  it.skipIf(process.platform === 'win32')('a loser stalled between its staleness stat and its rename never destroys the winner\'s fresh lock or enters alongside it', async () => {
    const dir = await scratch();
    const lockPath = path.join(dir, 'shared.lock');
    await staleLockDir(lockPath, 'dead-holder-token');

    const winnerToken = 'winner-fresh-token';
    race.winnerToken = winnerToken;
    race.lockPath = lockPath;

    const busyMs = 1_000;
    const busyMessage = 'dir lock busy: lost the stale-steal contention';
    const options = { staleMs: 60_000, heartbeatMs: 50, busyMs, busyMessage };

    const secondWriter = { entered: false };
    const loser = withDirLock(lockPath, async () => {
      secondWriter.entered = true;
      return 'entered';
    }, options);
    // `.then(onFulfilled, onRejected)` fully handles the promise so neither
    // outcome surfaces as an unhandled rejection on either tree.
    const settled = loser.then(
      (value) => ({ kind: 'resolved', value }),
      (error) => ({ kind: 'rejected', message: error?.message }),
    );
    // Hard wall-clock ceiling well above busyMs: a fix that loses the
    // contention rejects at ~busyMs; anything still pending here has broken
    // the busyMs bound and is reported as a clean failure, not a hang.
    const outcome = await Promise.race([
      settled,
      sleep(busyMs * 10).then(() => ({ kind: 'timeout' })),
    ]);

    try {
      expect(race.swapped, 'the adversarial interleaving must actually fire').toBe(true);
      // The two-writer admission itself: the winner is (conceptually) inside
      // the critical section under its fresh lock; the stalled loser must not
      // join it.
      expect(
        secondWriter.entered,
        'a loser whose staleness judgment was overtaken must never enter the critical section alongside the winner',
      ).toBe(false);
      // The destruction that admits the second writer: the winner's fresh
      // lock dir must survive the lost steal, handed back intact.
      expect(existsSync(lockPath), "the winner's fresh lock dir must survive the lost steal").toBe(true);
      expect(
        readFileSync(path.join(lockPath, 'owner'), 'utf8'),
        "the surviving lock must still carry the winner's owner token",
      ).toBe(winnerToken);
      // Losing the contention is the loser's only correct outcome: it
      // re-contends against the live fresh lock and times out under busyMs.
      expect(outcome.kind, 'the loser must lose the contention against the live fresh lock').toBe('rejected');
      expect(outcome.message).toBe(busyMessage);
    } finally {
      race.lockPath = null;
      await loser.catch(() => {});
    }
  }, 15_000);

  // Guard against over-correction: with no interference, a genuinely stale
  // dead-holder lock must still be stolen and the contender must acquire. A
  // fix that simply refuses every steal would deadlock recovery (F9). GREEN
  // today and GREEN after the fix.
  it('still steals a genuinely stale dead-holder lock when nothing changed under the steal', async () => {
    const dir = await scratch();
    const lockPath = path.join(dir, 'shared.lock');
    await staleLockDir(lockPath, 'dead-holder-token');

    const events = [];
    const result = await withDirLock(lockPath, async () => {
      events.push('entered');
      return 'ok';
    }, { staleMs: 500, heartbeatMs: 50, busyMs: 15_000, busyMessage: 'busy' });

    expect(result).toBe('ok');
    expect(events).toEqual(['entered']);
    expect(existsSync(lockPath)).toBe(false);
  });
});
