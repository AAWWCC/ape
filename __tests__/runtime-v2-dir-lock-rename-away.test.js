import { existsSync, readFileSync } from 'node:fs';
import { mkdir, mkdtemp, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { withDirLock } from '../lib/runtime/lock.js';

// Deterministic reproduction of the withDirLock rename-away race (invariant 7).
//
// The dir-lock steal in lib/runtime/lock.js renames a suspected-stale lock dir
// to a tombstone and only THEN re-verifies staleness; a stalled release's
// rename does the owner read and the rename as two separate steps. Either
// rename can therefore capture a rival's freshly (re-)created LIVE lock dir by
// path, and even though the mismatch is detected and the dir handed back, the
// transient ABSENCE window between the rename-away and the hand-back is
// observable:
//
//   CASE 1 (failure mode 1): the rival is still mid-write of its owner token
//     when its dir is renamed away, the write fails ENOENT, and withDirLock
//     rejects with the raw fs error instead of re-contending.
//   CASE 2 (failure mode 2): the rival has already entered its critical
//     section; a third contender mkdirs a new lock dir inside the absence
//     window and enters WHILE the rival is still inside — two holders.
//   CASE 3 (release stall): a finished holder stalls between its release's
//     owner read and its release rename; its generation legitimately goes
//     stale (heartbeat stopped) and is stolen; the resumed release rename then
//     captures the thief's LIVE generation, opening the same absence window
//     for a third contender — again two holders, and the live generation is
//     dumped into a tombstone.
//
// The interleavings are driven through the established opt-in per-lock-path
// vi.mock('node:fs/promises') seam (prior art: runtime-v2-lock-protocol.test.js
// and runtime-v2-dir-lock-steal.test.js): a transparent `...actual`
// passthrough that intercepts only the specific operations a test gates, opted
// in per lock path, so unrelated fs traffic is untouched. Every gate carries a
// timeout fallback so a correct implementation that restructures acquisition
// or release (and so never performs a gated call) degrades transparently
// instead of hanging.
//
// All assertions are on the PUBLIC contract only: withDirLock never rejects
// with a raw ENOENT (only callback completion or the configured busyMessage,
// bounded by busyMs), at most one holder is ever inside a critical section, a
// live holder's generation stays installed with its owner token intact while
// it holds, and the lock path is absent after all holders release. No
// assertion requires a specific tombstone name, internal call sequence, or
// that a seam hook fired.
const seam = vi.hoisted(() => ({ rename: null, writeFile: null }));

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    rename: async (...args) => (seam.rename ? seam.rename(actual, ...args) : actual.rename(...args)),
    writeFile: async (...args) => (seam.writeFile ? seam.writeFile(actual, ...args) : actual.writeFile(...args)),
  };
});

// Fresh dirs are never judged stale during a case (only backdated generations
// are), busyMs bounds every contender, and the gate fallbacks/ceilings keep a
// correct restructured implementation from ever hanging on an unfired gate.
const STALE_MS = 60_000;
const HEARTBEAT_MS = 50;
const BUSY_MS = 1_000;
const FALLBACK_MS = 2_000;
const CEILING_MS = 10_000;
const CASE_TIMEOUT_MS = 30_000;

const cleanups = [];
afterEach(async () => {
  seam.rename = null;
  seam.writeFile = null;
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
  const dir = await mkdtemp(path.join(tmpdir(), 'ape-dir-lock-rename-away-'));
  cleanups.push(dir);
  return dir;
}

// A dead holder's lock dir: owner token present, mtime far past every
// staleness threshold used below, i.e. the heartbeat stopped long ago (F9
// staleness — stealing it is legitimate).
async function staleLockDir(lockPath, ownerToken) {
  await mkdir(lockPath);
  await writeFile(path.join(lockPath, 'owner'), ownerToken, { encoding: 'utf8', mode: 0o600 });
  const dead = new Date(Date.now() - 10 * 60_000);
  await utimes(lockPath, dead, dead);
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
// that neither completes nor rejects within a generous multiple of busyMs is
// reported as a clean failure, never an infinite hang.
function withCeiling(settledPromise, ms) {
  return Promise.race([settledPromise, sleep(ms).then(() => ({ kind: 'timeout' }))]);
}

// The public contract for any withDirLock outcome: settle within the ceiling,
// and reject — if at all — only with the configured busyMessage, never a raw
// fs error such as ENOENT.
function expectLawfulOutcome(name, outcome, busyMessage) {
  expect(outcome.kind, `${name} must settle (complete or reject busy) within the wall-clock ceiling`).not.toBe('timeout');
  if (outcome.kind === 'rejected') {
    expect(
      outcome.code,
      `${name} must never reject with a raw ENOENT; the only lawful rejection carries the configured busyMessage`,
    ).not.toBe('ENOENT');
    expect(outcome.message, `${name} may only reject with the configured busyMessage`).toBe(busyMessage);
  }
}

// Critical-section instrumentation shared by all cases: concurrent-holder
// count, an ordered event log, and a per-holder entered signal. A holder with
// a gate parks inside its section until the test releases it; gates are always
// resolved in finally blocks so a failing tree fails cleanly instead of
// hanging.
function tracker() {
  const state = { inside: 0, maxInside: 0, events: [] };
  const entered = {};
  const section = (name, gate) => {
    entered[name] = deferred();
    return async () => {
      state.inside += 1;
      state.maxInside = Math.max(state.maxInside, state.inside);
      state.events.push(`${name}-enter`);
      entered[name].resolve();
      try {
        if (gate) await gate.promise;
        return name;
      } finally {
        state.inside -= 1;
        state.events.push(`${name}-exit`);
      }
    };
  };
  return { state, entered, section };
}

function expectEnteredOnlyAfterExit(events, enteringHolder, priorHolder) {
  const enterIndex = events.indexOf(`${enteringHolder}-enter`);
  if (enterIndex === -1) return;
  const exitIndex = events.indexOf(`${priorHolder}-exit`);
  expect(
    exitIndex,
    `${enteringHolder} entered the critical section but ${priorHolder} never exited before it`,
  ).toBeGreaterThanOrEqual(0);
  expect(
    exitIndex,
    `${enteringHolder} may enter the critical section only strictly after ${priorHolder} exited`,
  ).toBeLessThan(enterIndex);
}

describe('APE v2 dir lock: a steal or release rename must never capture a rival\'s live generation (invariant 7)', () => {
  // CASE 1 — failure mode 1 (liveness/robustness). Contender B is paused
  // between its staleness stat and its steal rename while rival A completes a
  // legitimate steal of the genuinely dead pre-existing generation and
  // re-creates a fresh lock dir; B's rename is released so it lands between
  // A's dir creation and A's owner-token write. Pre-fix, A's owner write fails
  // ENOENT and withDirLock rejects with the raw fs error instead of
  // re-contending.
  it('a fresh acquisition transiently renamed away never surfaces a raw ENOENT rejection', async () => {
    const dir = await scratch();
    const lockPath = path.join(dir, 'shared.lock');
    await staleLockDir(lockPath, 'dead-holder-generation');

    const busyMessage = 'dir lock busy: rename-away case 1';
    const options = { staleMs: STALE_MS, heartbeatMs: HEARTBEAT_MS, busyMs: BUSY_MS, busyMessage };
    const { state, section } = tracker();
    const ownerPath = path.join(lockPath, 'owner');
    const bParked = deferred();
    const bGo = deferred();
    const bRenameDone = deferred();
    let renameGateConsumed = false;
    let writeGateConsumed = false;

    // Gate ONLY the first rename of this lock path: that is B's steal rename
    // (B is started first and parks there before A is started). A's later
    // legitimate steal rename and every release rename pass through untouched.
    seam.rename = async (actual, source, destination) => {
      if (!renameGateConsumed && source === lockPath) {
        renameGateConsumed = true;
        bParked.resolve();
        await Promise.race([bGo.promise, sleep(FALLBACK_MS)]);
        try {
          return await actual.rename(source, destination);
        } finally {
          bRenameDone.resolve();
        }
      }
      return actual.rename(source, destination);
    };
    // Gate ONLY the first owner-token write at this lock path (A's, after its
    // legitimate steal): fire B's parked rename first so the rename-away lands
    // inside A's acquisition, then call through. If a correct implementation
    // never performs this write (staged install elsewhere), the fallback above
    // releases B on its own and this gate simply never fires.
    seam.writeFile = async (actual, ...args) => {
      if (!writeGateConsumed && args[0] === ownerPath) {
        writeGateConsumed = true;
        bGo.resolve();
        await Promise.race([bRenameDone.promise, sleep(FALLBACK_MS)]);
      }
      return actual.writeFile(...args);
    };

    let settledA;
    let settledB;
    try {
      const bPromise = withDirLock(lockPath, section('B'), options);
      settledB = settle(bPromise);
      await Promise.race([bParked.promise, settledB, sleep(FALLBACK_MS)]);

      const aPromise = withDirLock(lockPath, section('A'), options);
      settledA = settle(aPromise);

      const aOutcome = await withCeiling(settledA, CEILING_MS);
      const bOutcome = await withCeiling(settledB, CEILING_MS);

      // RED pre-fix: A rejects with the raw ENOENT from its owner-token write
      // (its fresh dir was transiently renamed away mid-acquisition) instead
      // of completing or rejecting with the configured busyMessage.
      expectLawfulOutcome('contender A', aOutcome, busyMessage);
      expectLawfulOutcome('contender B', bOutcome, busyMessage);
      expect(state.maxInside, 'at most one holder may ever be inside the critical section').toBeLessThanOrEqual(1);
    } finally {
      bGo.resolve();
      bRenameDone.resolve();
      seam.rename = null;
      seam.writeFile = null;
      await Promise.race([Promise.all([settledA, settledB].filter(Boolean)), sleep(CEILING_MS)]);
    }
  }, CASE_TIMEOUT_MS);

  // CASE 2 — failure mode 2 (mutual exclusion). Rival A completes the
  // legitimate steal, re-acquires, and parks inside its critical section; B's
  // gated steal rename then captures A's fresh LIVE dir (the absence window),
  // and contender C mkdirs a new lock dir inside the window. Pre-fix, C enters
  // while A is still inside — two concurrent holders — and A's generation is
  // dumped into a tombstone instead of surviving at the lock path.
  it('a stale-steal loser never opens an absence window over a live rival: single holder, owner intact', async () => {
    const dir = await scratch();
    const lockPath = path.join(dir, 'shared.lock');
    await staleLockDir(lockPath, 'dead-holder-generation');

    const busyMessage = 'dir lock busy: rename-away case 2';
    const options = { staleMs: STALE_MS, heartbeatMs: HEARTBEAT_MS, busyMs: BUSY_MS, busyMessage };
    const { state, entered, section } = tracker();
    const gateA = deferred();
    const gateC = deferred();
    const bParked = deferred();
    const bGo = deferred();
    const windowOpen = deferred();
    const windowUsed = deferred();
    let renameGateConsumed = false;

    // Gate ONLY the first rename of this lock path (B's steal rename, parked
    // before A starts). After it lands, hold B briefly so the window it opened
    // stays observable while C contends; both holds degrade via fallbacks on
    // a tree whose steal path never renames a live generation away.
    seam.rename = async (actual, source, destination) => {
      if (!renameGateConsumed && source === lockPath) {
        renameGateConsumed = true;
        bParked.resolve();
        await Promise.race([bGo.promise, sleep(FALLBACK_MS)]);
        try {
          return await actual.rename(source, destination);
        } finally {
          windowOpen.resolve();
          await Promise.race([windowUsed.promise, sleep(FALLBACK_MS)]);
        }
      }
      return actual.rename(source, destination);
    };

    let settledA;
    let settledB;
    let settledC;
    try {
      const bPromise = withDirLock(lockPath, section('B'), options);
      settledB = settle(bPromise);
      await Promise.race([bParked.promise, settledB, sleep(FALLBACK_MS)]);

      const aPromise = withDirLock(lockPath, section('A', gateA), options);
      settledA = settle(aPromise);
      await Promise.race([entered.A.promise, sleep(FALLBACK_MS)]);
      expect(state.events, 'rival A must have re-acquired and entered its critical section').toContain('A-enter');
      const ownerA = readFileSync(path.join(lockPath, 'owner'), 'utf8');

      // Release B's steal rename against A's live generation, then let C
      // contend during whatever window that opened.
      bGo.resolve();
      await Promise.race([windowOpen.promise, settledB, sleep(FALLBACK_MS)]);
      const cPromise = withDirLock(lockPath, section('C', gateC), options);
      settledC = settle(cPromise);
      await Promise.race([entered.C.promise, sleep(750)]);
      windowUsed.resolve();

      const bOutcome = await withCeiling(settledB, CEILING_MS);
      // Quiesce C's fate (bounded by its own busyMs) before observing.
      await Promise.race([settledC, sleep(BUSY_MS * 2)]);

      // RED pre-fix: C entered through the absence window while A was still
      // inside — two concurrent holders.
      expect(state.maxInside, 'at most one holder may ever be inside the critical section').toBe(1);
      // RED pre-fix: A's live generation was renamed into a tombstone; the
      // lock path now carries C's generation (or nothing) instead of A's.
      expect(existsSync(lockPath), "A's live generation must still be installed at the lock path while A holds").toBe(true);
      expect(
        readFileSync(path.join(lockPath, 'owner'), 'utf8'),
        "the installed lock must still carry A's owner token while A holds",
      ).toBe(ownerA);
      expectLawfulOutcome('contender B', bOutcome, busyMessage);
    } finally {
      bGo.resolve();
      windowUsed.resolve();
      gateC.resolve();
      gateA.resolve();
      seam.rename = null;
      seam.writeFile = null;
      await Promise.race([Promise.all([settledA, settledB, settledC].filter(Boolean)), sleep(CEILING_MS)]);
    }

    const aOutcome = await withCeiling(settledA, CEILING_MS);
    const cOutcome = await withCeiling(settledC, CEILING_MS);
    expect(aOutcome.kind, 'holder A must complete its critical section and release').toBe('resolved');
    expect(aOutcome.value).toBe('A');
    expectLawfulOutcome('contender C', cOutcome, busyMessage);
    expectEnteredOnlyAfterExit(state.events, 'C', 'A');
    expect(existsSync(lockPath), 'the lock dir must be absent after all holders released').toBe(false);
  }, CASE_TIMEOUT_MS);

  // CASE 3 — release stall. Holder H completes its callback and stalls inside
  // its release between the owner read and the release rename; its generation
  // legitimately goes stale (heartbeat stopped), rival B steals it, installs
  // fresh, and enters; H's resumed release rename then captures B's LIVE
  // generation, and contender C contends during the absence window. Pre-fix,
  // B and C are inside concurrently and B's live generation is dumped into a
  // release tombstone.
  it('a stalled release rename never captures a live successor: single holder, live generation not leaked', async () => {
    const dir = await scratch();
    const lockPath = path.join(dir, 'shared.lock');

    const busyMessage = 'dir lock busy: rename-away case 3';
    const options = { staleMs: STALE_MS, heartbeatMs: HEARTBEAT_MS, busyMs: BUSY_MS, busyMessage };
    const { state, entered, section } = tracker();
    const gateB = deferred();
    const gateC = deferred();
    const hParked = deferred();
    const hGo = deferred();
    const windowOpen = deferred();
    const windowUsed = deferred();
    let releaseGateConsumed = false;

    // Gate ONLY the first release-shaped rename of this lock path (H's, the
    // sole holder releasing at that point). B's staleness steal renames to a
    // different tombstone family and passes through untouched, as do all later
    // release renames. Both holds degrade via fallbacks on a tree whose
    // release never exposes an absence window.
    seam.rename = async (actual, source, destination) => {
      if (!releaseGateConsumed && source === lockPath && String(destination).startsWith(`${lockPath}.release.`)) {
        releaseGateConsumed = true;
        hParked.resolve();
        await Promise.race([hGo.promise, sleep(FALLBACK_MS)]);
        try {
          return await actual.rename(source, destination);
        } finally {
          windowOpen.resolve();
          await Promise.race([windowUsed.promise, sleep(FALLBACK_MS)]);
        }
      }
      return actual.rename(source, destination);
    };

    let settledH;
    let settledB;
    let settledC;
    try {
      const hPromise = withDirLock(lockPath, section('H'), options);
      settledH = settle(hPromise);
      await Promise.race([hParked.promise, settledH, sleep(FALLBACK_MS)]);

      // H's callback is done and its heartbeat has stopped, so aging the
      // generation past staleMs is legitimate F9 staleness (guarded: on a tree
      // whose release already completed there is nothing left to age).
      if (existsSync(lockPath)) {
        const dead = new Date(Date.now() - 10 * 60_000);
        await utimes(lockPath, dead, dead).catch(() => {});
      }

      const bPromise = withDirLock(lockPath, section('B', gateB), options);
      settledB = settle(bPromise);
      await Promise.race([entered.B.promise, sleep(FALLBACK_MS)]);
      expect(state.events, 'rival B must have acquired and entered its critical section').toContain('B-enter');
      const ownerB = readFileSync(path.join(lockPath, 'owner'), 'utf8');

      // Resume H's stalled release rename against B's live generation, then
      // let C contend during whatever window that opened.
      hGo.resolve();
      await Promise.race([windowOpen.promise, settledH, sleep(FALLBACK_MS)]);
      const cPromise = withDirLock(lockPath, section('C', gateC), options);
      settledC = settle(cPromise);
      await Promise.race([entered.C.promise, sleep(750)]);
      windowUsed.resolve();

      const hOutcome = await withCeiling(settledH, CEILING_MS);
      // Quiesce C's fate (bounded by its own busyMs) before observing.
      await Promise.race([settledC, sleep(BUSY_MS * 2)]);

      // RED pre-fix: C entered through the release's absence window while B
      // was still inside — two concurrent holders.
      expect(state.maxInside, 'at most one holder may ever be inside the critical section').toBe(1);
      // RED pre-fix: B's live generation was captured into a release
      // tombstone; the lock path no longer carries B's generation while B is
      // still inside its critical section.
      expect(existsSync(lockPath), "B's live generation must still be installed at the lock path while B holds").toBe(true);
      expect(
        readFileSync(path.join(lockPath, 'owner'), 'utf8'),
        "the installed lock must still carry B's owner token while B holds",
      ).toBe(ownerB);
      expect(hOutcome.kind, 'H completed its callback, so its release must complete truthfully').toBe('resolved');
      expect(hOutcome.value).toBe('H');
    } finally {
      hGo.resolve();
      windowUsed.resolve();
      gateC.resolve();
      gateB.resolve();
      seam.rename = null;
      seam.writeFile = null;
      await Promise.race([Promise.all([settledH, settledB, settledC].filter(Boolean)), sleep(CEILING_MS)]);
    }

    const bOutcome = await withCeiling(settledB, CEILING_MS);
    const cOutcome = await withCeiling(settledC, CEILING_MS);
    expect(bOutcome.kind, 'holder B must complete its critical section and release').toBe('resolved');
    expect(bOutcome.value).toBe('B');
    // Convergence: the lock path is not wedged behind the leaked generation —
    // C either completed (strictly after B) or rejected with busyMessage
    // within its bound.
    expectLawfulOutcome('contender C', cOutcome, busyMessage);
    expectEnteredOnlyAfterExit(state.events, 'C', 'B');
    expect(existsSync(lockPath), 'the lock dir must be absent after all holders released').toBe(false);
  }, CASE_TIMEOUT_MS);
});
