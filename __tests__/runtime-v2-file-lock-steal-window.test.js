import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { hostname, tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { acquireRunLock, releaseRunLock } from '../lib/runtime/lock.js';

// Deterministic reproduction of the FILE-lock steal absence-window race
// (invariant 7) — the stealLockFileByRename sibling of the dir-lock
// rename-away race.
//
// stealLockFileByRename in lib/runtime/lock.js renames a suspected-stale lock
// FILE to a tombstone, verifies the tombstone's bytes against the stale
// content the caller observed, and on mismatch hands the captured file back
// into place. Two observable defects follow from that shape:
//
//   - between the rename-away and the hand-back the lock path is transiently
//     ABSENT, so a concurrent createLockFile (acquireRunLock's atomic
//     no-clobber acquire) can win the vacated path while the stolen-from
//     holder is LIVE — a second concurrent run writer; and
//   - a hand-back that replaces its target CLOBBERS the window winner's live
//     lock file beneath it when a contender did win the vacated path.
//
// The interleavings are driven through the established opt-in per-lock-path
// vi.mock('node:fs/promises') seam (prior art:
// runtime-v2-dir-lock-rename-away.test.js and
// runtime-v2-lock-protocol.test.js): a transparent `...actual` passthrough
// intercepting only the operations a test gates, opted in per lock path.
// Every gate is one-shot and carries a FALLBACK_MS timeout, so a fixed tree
// that restructures the steal (and never performs a gated call) degrades
// transparently instead of hanging.
//
// All assertions are on the PUBLIC acquireRunLock/releaseRunLock contract
// only: at most one contender ever holds the run lock at quiescence; a live
// holder's lock file at the lock path parses and names that holder; every
// losing contender settles within a bounded ceiling and rejects only with a
// documented message (which message a given loser gets is deliberately not
// pinned); after all holders release, the lock path is absent and a fresh
// acquire succeeds (no leaked tombstone wedge). No assertion touches
// tombstone naming, internal call order, or payload byte layout, and no fake
// timers are used — determinism comes from gated promises alone.
const seam = vi.hoisted(() => ({ rename: null, link: null }));

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    rename: async (...args) => (seam.rename ? seam.rename(actual, ...args) : actual.rename(...args)),
    link: async (...args) => (seam.link ? seam.link(actual, ...args) : actual.link(...args)),
  };
});

const FALLBACK_MS = 2_000;
const CONTEND_MS = 750;
const CEILING_MS = 10_000;
const CASE_TIMEOUT_MS = 30_000;

// The documented ways acquireRunLock may reject a losing contender: a live
// holder refusal, the unreadable-lock remedy, or the bounded-attempts churn
// rejection. A window loser may lawfully surface any of them.
const LAWFUL_REJECTION = /another APE writing run|unreadable; use override reset|after 8 attempts/;

const cleanups = [];
afterEach(async () => {
  seam.rename = null;
  seam.link = null;
  await Promise.all(cleanups.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function deferred() {
  let resolve;
  const promise = new Promise((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

async function scratch() {
  const dir = await mkdtemp(path.join(tmpdir(), 'ape-file-lock-steal-window-'));
  cleanups.push(dir);
  return dir;
}

// A pid that is guaranteed dead: the spawned process has already exited.
function deadPid() {
  return spawnSync(process.execPath, ['-e', '']).pid;
}

// A dead holder's lock file, mirroring the acquireRunLock payload shape:
// same-host with a genuinely dead pid, so recovering it under recoverStale is
// legitimate staleness by the file-lock's own criteria (F9).
function staleLockBytes(runId) {
  return `${JSON.stringify({
    version: 1,
    run_id: runId,
    pid: deadPid(),
    host: hostname(),
    acquired_at: new Date(Date.now() - 10 * 60_000).toISOString(),
  })}\n`;
}

// `.then(onFulfilled, onRejected)` fully handles the promise at spawn time so
// neither outcome ever surfaces as an unhandled rejection on either tree.
function settle(promise) {
  return promise.then(
    (value) => ({ kind: 'resolved', value }),
    (error) => ({ kind: 'rejected', message: error?.message, code: error?.code }),
  );
}

// Hard wall-clock ceiling (prior-art Promise.race pattern): an implementation
// that neither completes nor rejects within the ceiling is reported as a
// clean failure, never an infinite hang.
function withCeiling(settledPromise, ms) {
  return Promise.race([settledPromise, sleep(ms).then(() => ({ kind: 'timeout' }))]);
}

// The public contract for any contender's outcome: settle within the ceiling,
// and reject — if at all — only with a documented acquireRunLock message,
// never a raw fs error.
function expectLawfulSettlement(name, outcome) {
  expect(outcome.kind, `${name} must settle (acquire or reject) within the wall-clock ceiling`).not.toBe('timeout');
  if (outcome.kind === 'rejected') {
    expect(
      outcome.message,
      `${name} may reject only with a documented acquireRunLock message, never a raw fs error`,
    ).toMatch(LAWFUL_REJECTION);
  }
}

// Opens the steal absence window deterministically:
//   1. seed the lock path with a genuinely dead holder's stale bytes S;
//   2. launch contender B (recoverStale) and park it at its FIRST rename of
//      the lock path — B has judged S stale and is about to steal;
//   3. let contender A complete a full legitimate recovery — A is now a LIVE
//      holder with a fresh lock file at the lock path;
//   4. release B's parked rename so it captures A's fresh lock file into a
//      tombstone, then park B again immediately before its hand-back (a
//      rename back into the lock path or a no-clobber link, whichever the
//      tree uses — one shared one-shot trigger, so a later contender's own
//      operations never re-trigger it).
// Between B's capture and B's hand-back the lock path is ABSENT while A is
// live: the window. Every gate carries a FALLBACK_MS timeout so a fixed tree
// that restructures the steal degrades transparently.
async function stageAbsenceWindow(lockPath) {
  await writeFile(lockPath, staleLockBytes('run-dead'), { encoding: 'utf8', mode: 0o600 });

  const gates = {
    bParked: deferred(),
    bGo: deferred(),
    captureDone: deferred(),
    handBackParked: deferred(),
    handBackGo: deferred(),
  };
  const flags = {
    stealConsumed: false,
    handBackArmed: false,
    handBackConsumed: false,
    captured: false,
    bParkedFired: false,
  };

  seam.rename = async (actual, source, destination) => {
    // Gate 1 (one-shot): B's steal rename of the lock path itself. B is
    // launched first and parks here before A starts, so A's own later
    // legitimate steal rename passes through untouched.
    if (!flags.stealConsumed && String(source) === lockPath) {
      flags.stealConsumed = true;
      flags.bParkedFired = true;
      gates.bParked.resolve();
      await Promise.race([gates.bGo.promise, sleep(FALLBACK_MS)]);
      try {
        const result = await actual.rename(source, destination);
        flags.captured = true;
        return result;
      } finally {
        gates.captureDone.resolve();
      }
    }
    // Gate 2 (one-shot, armed only after A settled and only when B actually
    // parked): B's hand-back of the captured file into the lock path.
    if (
      flags.handBackArmed &&
      !flags.handBackConsumed &&
      (String(destination) === lockPath || String(source).includes('.stale.'))
    ) {
      flags.handBackConsumed = true;
      gates.handBackParked.resolve();
      await Promise.race([gates.handBackGo.promise, sleep(FALLBACK_MS)]);
    }
    return actual.rename(source, destination);
  };
  // A fixed tree may hand back without clobbering, via a no-clobber link into
  // the lock path: the same one-shot trigger fires on either shape. It is
  // consumed before any window contender is launched, so a contender's own
  // no-clobber create link never re-triggers it.
  seam.link = async (actual, source, destination) => {
    if (flags.handBackArmed && !flags.handBackConsumed && String(destination) === lockPath) {
      flags.handBackConsumed = true;
      gates.handBackParked.resolve();
      await Promise.race([gates.handBackGo.promise, sleep(FALLBACK_MS)]);
    }
    return actual.link(source, destination);
  };

  const settledB = settle(acquireRunLock(lockPath, 'run-b', { recoverStale: true }));
  await Promise.race([gates.bParked.promise, settledB, sleep(FALLBACK_MS)]);

  const settledA = settle(acquireRunLock(lockPath, 'run-a', { recoverStale: true }));
  await Promise.race([settledA, sleep(FALLBACK_MS)]);

  // Arm the hand-back gate only when the window choreography is actually in
  // play (B parked at its steal rename); on a restructured fixed tree that
  // never renames the lock path, nothing else is ever gated.
  if (flags.bParkedFired) flags.handBackArmed = true;
  gates.bGo.resolve();
  await Promise.race([gates.captureDone.promise, settledB, sleep(FALLBACK_MS)]);
  await Promise.race([gates.handBackParked.promise, settledB, sleep(FALLBACK_MS)]);

  return { gates, flags, settledA, settledB };
}

// Quiescence contract shared by both window cases. `named` is a list of
// [label, outcome] pairs for every contender.
async function expectSingleWriterQuiescence(lockPath, named) {
  for (const [name, outcome] of named) expectLawfulSettlement(name, outcome);
  const winners = named.filter(([, outcome]) => outcome.kind === 'resolved');
  expect(
    winners.length,
    'invariant 7: at most one acquireRunLock contender may hold the run lock at quiescence — a second fulfilled, unreleased contender means the steal absence window admitted a second concurrent run writer',
  ).toBeLessThanOrEqual(1);
  if (winners.length === 1) {
    const [name, outcome] = winners[0];
    expect(
      existsSync(lockPath),
      `the surviving holder (${name}) is live, so a lock file must still exist at the lock path`,
    ).toBe(true);
    expect(
      JSON.parse(readFileSync(lockPath, 'utf8')).run_id,
      `the lock file must still name the surviving holder (${name}) — a live winner's lock is never destroyed or replaced beneath it`,
    ).toBe(outcome.value.run_id);
  }
  for (const [, outcome] of winners) {
    await releaseRunLock(lockPath, outcome.value.run_id);
  }
  if (winners.length === 1) {
    expect(existsSync(lockPath), 'the lock path must be absent after the surviving holder releases').toBe(false);
  }
  // No leaked wedge: whatever debris the contention left behind, a fresh
  // acquire with a recovery credit must succeed within the ceiling.
  const finalOutcome = await withCeiling(settle(acquireRunLock(lockPath, 'run-final', { recoverStale: true })), CEILING_MS);
  expect(
    finalOutcome.kind,
    'after every holder released, a fresh acquireRunLock must succeed within the ceiling — no leaked tombstone or debris may wedge the lock',
  ).toBe('resolved');
  await releaseRunLock(lockPath, 'run-final');
  expect(existsSync(lockPath), 'the lock path must be absent after the final holder releases').toBe(false);
}

describe('APE v2 file lock: the steal absence window must never admit a second run writer (invariant 7)', () => {
  // CASE A — the 3-party window admission. B parks mid-steal, A completes a
  // legitimate recovery and holds live, B's released capture rename opens the
  // absence window over A's fresh lock, and C acquires through it. RED today:
  // C fulfills while A holds (two concurrent run writers), and B's later
  // hand-back clobbers C's live lock file with A's captured one. GREEN once
  // the window is unenterable, the hand-back is non-destructive, and debris
  // is swept.
  it('a stale-steal loser never leaves an acquirable absence window over a live holder, nor clobbers the window winner', async () => {
    const dir = await scratch();
    const lockPath = path.join(dir, 'active.lock');
    let staged;
    let settledC;
    try {
      staged = await stageAbsenceWindow(lockPath);
      // The race trigger (mirrors the dir suite's race.swapped check),
      // guarded so a restructured fixed tree that never parked B degrades
      // instead of failing here.
      if (staged.flags.bParkedFired) {
        expect(
          staged.flags.captured,
          "B's released steal rename must have captured the live successor's lock file (the absence window opened)",
        ).toBe(true);
      }
      // C contends inside the open window (no recovery credit: the window
      // itself, not staleness, is what admits it today).
      settledC = settle(acquireRunLock(lockPath, 'run-c', { recoverStale: false }));
      await Promise.race([settledC, sleep(CONTEND_MS)]);
    } finally {
      staged?.gates.bGo.resolve();
      staged?.gates.handBackGo.resolve();
      seam.rename = null;
      seam.link = null;
      await Promise.race([
        Promise.all([staged?.settledA, staged?.settledB, settledC].filter(Boolean)),
        sleep(CEILING_MS),
      ]);
    }

    const aOutcome = await withCeiling(staged.settledA, CEILING_MS);
    const bOutcome = await withCeiling(staged.settledB, CEILING_MS);
    const cOutcome = await withCeiling(settledC, CEILING_MS);
    await expectSingleWriterQuiescence(lockPath, [
      ['contender A (completed stale recovery)', aOutcome],
      ['contender B (parked stealer)', bOutcome],
      ['contender C (window contender)', cOutcome],
    ]);
  }, CASE_TIMEOUT_MS);

  // CASE B — crash mid-steal. B captures A's live lock into its tombstone and
  // then never resumes (a crashed stealer: its hand-back gate is released
  // only in the finally cleanup). RED today: the vacated lock path is simply
  // free, so a later acquirer fulfills while A is live — two concurrent run
  // writers. GREEN once a pending capture keeps the vacated path
  // unacquirable until it is resolved or swept.
  it('a stealer crashed between its capture and its hand-back never leaves the vacated path acquirable beside the live holder', async () => {
    const dir = await scratch();
    const lockPath = path.join(dir, 'active.lock');
    let staged;
    let settledD;
    try {
      staged = await stageAbsenceWindow(lockPath);
      if (staged.flags.bParkedFired) {
        expect(
          staged.flags.captured,
          "B's released steal rename must have captured the live successor's lock file (the absence window opened)",
        ).toBe(true);
      }
      // The later acquirer arrives while the crashed stealer's capture is
      // still pending and A is live.
      settledD = settle(acquireRunLock(lockPath, 'run-d', { recoverStale: false }));
      const dOutcome = await withCeiling(settledD, CEILING_MS);
      const aOutcome = await withCeiling(staged.settledA, CEILING_MS);
      expectLawfulSettlement('contender A (completed stale recovery)', aOutcome);
      expectLawfulSettlement('later acquirer D', dOutcome);
      const windowWinners = [aOutcome, dOutcome].filter((outcome) => outcome.kind === 'resolved');
      expect(
        windowWinners.length,
        'invariant 7: while the stolen-from holder is live and a crashed stealer\'s capture is pending, a later acquirer must not become a second fulfilled run writer',
      ).toBeLessThanOrEqual(1);
    } finally {
      // Settle the never-released gates so nothing hangs on either tree.
      staged?.gates.bGo.resolve();
      staged?.gates.handBackGo.resolve();
      seam.rename = null;
      seam.link = null;
      await Promise.race([
        Promise.all([staged?.settledA, staged?.settledB, settledD].filter(Boolean)),
        sleep(CEILING_MS),
      ]);
    }

    const aOutcome = await withCeiling(staged.settledA, CEILING_MS);
    const bOutcome = await withCeiling(staged.settledB, CEILING_MS);
    const dOutcome = await withCeiling(settledD, CEILING_MS);
    await expectSingleWriterQuiescence(lockPath, [
      ['contender A (completed stale recovery)', aOutcome],
      ['contender B (crashed stealer)', bOutcome],
      ['later acquirer D', dOutcome],
    ]);
  }, CASE_TIMEOUT_MS);

  // GREEN GUARD (F9 over-correction): green pre- AND post-fix. With no seam
  // gating, a genuinely dead-pid stale lock is still recovered under
  // recoverStale, and a live holder is never evicted — even by a contender
  // carrying a recovery credit.
  it('still recovers a genuinely dead-pid stale lock under recoverStale and still refuses a live lock', async () => {
    const dir = await scratch();
    const lockPath = path.join(dir, 'active.lock');
    await writeFile(lockPath, staleLockBytes('run-dead'), { encoding: 'utf8', mode: 0o600 });
    // Without a recovery credit even a dead-pid lock is refused.
    await expect(acquireRunLock(lockPath, 'run-fresh')).rejects.toThrow(/another APE writing run is active/);
    const payload = await acquireRunLock(lockPath, 'run-fresh', { recoverStale: true });
    expect(payload.run_id).toBe('run-fresh');
    expect(JSON.parse(readFileSync(lockPath, 'utf8')).run_id).toBe('run-fresh');
    // The holder is this live process now: a rival with a recovery credit
    // must still be refused (F9 — a live holder is never evicted).
    await expect(acquireRunLock(lockPath, 'run-rival', { recoverStale: true })).rejects.toThrow(
      /another APE writing run is active/,
    );
    await releaseRunLock(lockPath, 'run-fresh');
    expect(existsSync(lockPath)).toBe(false);
  }, 15_000);
});
