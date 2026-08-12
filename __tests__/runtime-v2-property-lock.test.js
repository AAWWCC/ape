import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rename, rm, utimes, writeFile } from 'node:fs/promises';
import { hostname, tmpdir } from 'node:os';
import path from 'node:path';
import * as fc from 'fast-check';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { acquireRunLock, releaseRunLock, withDirLock } from '../lib/runtime/lock.js';

// Seeded-deterministic property suite over the lock protocol
// (lib/runtime/lock.js) — invariant 7: one active writer and atomic state.
// Determinism comes from generated STRUCTURE (backdated mtimes, dead pids,
// awaited interleavings, driven fs churn), never from wall-clock races: every
// asserted invariant must hold under ANY interleaving of the generated
// contenders, so a recorded failing seed replays the failure exactly.
//
// The dir-lock protocol asserted here is the POST-PR-#321 one (atomic staged
// `.acquire.` install, `.stale.`/`.release.` tombstones, post-acquire barrier,
// steal by identity, bounded hand-backs) — but every assertion is on the
// PUBLIC contract only: at most one holder, settle-within-bound, owner
// integrity, lock path absent-or-owned. No tombstone internals are pinned.
const SEED = 20260722;

// Churn interception for the bounded-acquire test below (prior art:
// runtime-v2-lock-protocol.test.js). Transparent passthrough to the real
// node:fs/promises until a test opts one exact lock path into pathological
// create/remove churn: link() perpetually reports EEXIST (the exclusive create
// keeps losing) while readFile() perpetually reports ENOENT (the lock keeps
// vanishing before it can be read) — the exact codes acquireRunLock branches
// on. Every other test in this file runs against the real filesystem.
const churn = vi.hoisted(() => ({ lockPath: null }));

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal();
  const codedError = (code, message) => Object.assign(new Error(message), { code });
  // Yield a macrotask before throwing so a buggy acquisition loop cannot
  // starve the timer queue; a genuine hang stays observable to the timeout.
  const yieldToTimers = () => new Promise((resolve) => setImmediate(resolve));
  return {
    ...actual,
    link: async (...args) => {
      const [, target] = args;
      if (churn.lockPath !== null && target === churn.lockPath) {
        await yieldToTimers();
        throw codedError('EEXIST', `EEXIST: file already exists, link '${target}'`);
      }
      return actual.link(...args);
    },
    readFile: async (...args) => {
      const [target] = args;
      if (churn.lockPath !== null && target === churn.lockPath) {
        await yieldToTimers();
        throw codedError('ENOENT', `ENOENT: no such file or directory, open '${target}'`);
      }
      return actual.readFile(...args);
    },
  };
});

afterEach(() => {
  churn.lockPath = null;
});

// A pid that is guaranteed dead: the spawned process has already exited.
// Computed once and reused across property iterations (a dead pid stays dead
// for the lifetime of this file).
let cachedDeadPid = null;
function deadPid() {
  if (cachedDeadPid === null) cachedDeadPid = spawnSync(process.execPath, ['-e', '']).pid;
  return cachedDeadPid;
}

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

// `.then(onFulfilled, onRejected)` fully handles the promise at spawn time so
// neither outcome ever surfaces as an unhandled rejection on either tree.
function settle(promise) {
  return promise.then(
    (value) => ({ kind: 'resolved', value }),
    (error) => ({ kind: 'rejected', message: error?.message, code: error?.code }),
  );
}

async function scratch() {
  return mkdtemp(path.join(tmpdir(), 'ape-property-lock-'));
}

const PRE_STATES = ['absent', 'dead-pid', 'live', 'zero-byte', 'garbage'];

const burstArb = fc.record({
  preState: fc.constantFrom(...PRE_STATES),
  contenders: fc.array(fc.record({ recoverStale: fc.boolean() }), { minLength: 2, maxLength: 4 }),
});

describe('APE v2 run-lock properties: generated acquire/release/steal/crash interleavings (invariant 7)', () => {
  it('a concurrent acquire burst admits at most one holder, and only over a provably dead generation', async () => {
    await fc.assert(
      fc.asyncProperty(burstArb, async ({ preState, contenders }) => {
        const dir = await scratch();
        try {
          const lock = path.join(dir, 'active.lock');
          let preContent = null;
          if (preState === 'dead-pid') {
            preContent = `${JSON.stringify({ version: 1, run_id: 'run-dead', pid: deadPid(), host: hostname() })}\n`;
            await writeFile(lock, preContent);
          } else if (preState === 'live') {
            preContent = `${JSON.stringify({ version: 1, run_id: 'run-live', pid: process.pid, host: hostname() })}\n`;
            await writeFile(lock, preContent);
          } else if (preState === 'zero-byte') {
            preContent = '';
            await writeFile(lock, preContent);
          } else if (preState === 'garbage') {
            preContent = 'not json at all';
            await writeFile(lock, preContent);
          }
          const results = await Promise.allSettled(
            contenders.map((contender, index) =>
              acquireRunLock(lock, `run-contender-${index}`, { recoverStale: contender.recoverStale }),
            ),
          );
          const winners = results
            .map((result, index) => ({ result, index }))
            .filter(({ result }) => result.status === 'fulfilled');
          const losers = results.filter((result) => result.status === 'rejected');
          // The core mutual-exclusion property: never two fulfilled acquires.
          expect(winners.length).toBeLessThanOrEqual(1);
          // Every loser settles with an honest, recognized rejection.
          for (const loser of losers) {
            expect(String(loser.reason?.message)).toMatch(
              /another APE writing run|unreadable; use override reset|after 8 attempts/,
            );
          }
          const anyRecover = contenders.some((contender) => contender.recoverStale);
          if (preState === 'live') {
            // A live holder is never stolen, whatever the recoverStale flags.
            expect(winners.length).toBe(0);
            expect(await readFile(lock, 'utf8')).toBe(preContent);
          } else if (preState === 'absent' || anyRecover) {
            // A free lock, or a dead/corrupt generation with a recovery
            // credit in the burst, always yields exactly one winner.
            expect(winners.length).toBe(1);
          } else {
            // Dead or corrupt bytes with no recovery credit: everyone refuses
            // and the observed bytes survive untouched.
            expect(winners.length).toBe(0);
            expect(await readFile(lock, 'utf8')).toBe(preContent);
          }
          // The lock file is always absent-or-complete-valid-JSON, and a
          // winner's lock names exactly the winner.
          if (winners.length === 1) {
            const payload = JSON.parse(readFileSync(lock, 'utf8'));
            expect(payload.run_id).toBe(`run-contender-${winners[0].index}`);
            expect(payload.run_id).toBe(winners[0].result.value.run_id);
            // Release protocol: a wrong-runId release refuses; the owner's
            // release removes the lock.
            await expect(releaseRunLock(lock, 'run-not-the-owner')).rejects.toThrow(
              /refusing to release lock owned by/,
            );
            await releaseRunLock(lock, payload.run_id);
            expect(existsSync(lock)).toBe(false);
          } else if (existsSync(lock)) {
            // No winner: whatever remains must still parse (never torn) unless
            // it is the pre-existing corrupt generation left untouched.
            const raw = readFileSync(lock, 'utf8');
            expect(raw).toBe(preContent);
          }
        } finally {
          await rm(dir, { recursive: true, force: true });
        }
      }),
      { seed: SEED, numRuns: 20, verbose: 2 },
    );
  }, 60_000);

  it.skipIf(process.platform === 'win32')('withDirLock: generated debris/dead-generation contention admits exactly one holder at a time', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.record({
          holders: fc.integer({ min: 2, max: 4 }),
          // Both dead pre-states the staged-install protocol distinguishes:
          //  - 'debris-empty': an EMPTY backdated dir at the lock path —
          //    ownerless debris a POSIX rename atomically absorbs during the
          //    staged install (no steal needed);
          //  - 'dead-with-owner': a dead holder's full generation (owner token
          //    present, heartbeat long stopped) — drives the steal-by-identity
          //    arm: capture owner bytes, rename to a `.stale.` tombstone,
          //    verify still-stale + same identity, then clear.
          preState: fc.constantFrom('none', 'debris-empty', 'dead-with-owner'),
          sectionMs: fc.constantFrom(10, 25),
        }),
        async ({ holders, preState, sectionMs }) => {
          const dir = await scratch();
          try {
            const lockPath = path.join(dir, 'shared.lock');
            if (preState !== 'none') {
              // A dead generation: no heartbeat refreshed it for far past the
              // staleness threshold, so absorbing/stealing is deterministic
              // (mirrors staleLockDir in runtime-v2-dir-lock-rename-away.test.js).
              await mkdir(lockPath);
              if (preState === 'dead-with-owner') {
                await writeFile(path.join(lockPath, 'owner'), 'dead-holder-generation', {
                  encoding: 'utf8',
                  mode: 0o600,
                });
              }
              const dead = new Date(Date.now() - 10 * 60_000);
              await utimes(lockPath, dead, dead);
            }
            let active = 0;
            let maxActive = 0;
            let entries = 0;
            const options = { staleMs: 60_000, heartbeatMs: 50, busyMs: 90_000, busyMessage: 'generated-busy' };
            await Promise.all(
              Array.from({ length: holders }, (_, index) =>
                withDirLock(
                  lockPath,
                  async () => {
                    active += 1;
                    entries += 1;
                    maxActive = Math.max(maxActive, active);
                    await new Promise((resolve) => setTimeout(resolve, sectionMs));
                    active -= 1;
                    return index;
                  },
                  options,
                ),
              ),
            );
            expect(maxActive, 'two holders entered the critical section concurrently').toBe(1);
            expect(entries).toBe(holders);
            // Every holder released: the lock dir is gone.
            expect(existsSync(lockPath)).toBe(false);
          } finally {
            await rm(dir, { recursive: true, force: true });
          }
        },
      ),
      { seed: SEED, numRuns: 12, verbose: 2 },
    );
  }, 300_000);

  it('pathological create/remove churn settles with the bounded 8-attempt rejection, never a hang', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.record({ recoverStale: fc.boolean(), runSuffix: fc.integer({ min: 0, max: 999 }) }),
        async ({ recoverStale, runSuffix }) => {
          const dir = await scratch();
          try {
            const lock = path.join(dir, 'churn.lock');
            churn.lockPath = lock;
            // MAX_ACQUIRE_ATTEMPTS is module-private by design; the bound is
            // pinned BEHAVIORALLY: the acquire settles (within the test
            // timeout) and reports exactly the 8-attempt churn exhaustion.
            await expect(
              acquireRunLock(lock, `run-churn-${runSuffix}`, { recoverStale }),
            ).rejects.toThrow(/after 8 attempts/);
          } finally {
            churn.lockPath = null;
            await rm(dir, { recursive: true, force: true });
          }
        },
      ),
      { seed: SEED, numRuns: 6, verbose: 2 },
    );
  }, 30_000);

  // Property 4 — vacating-rename capture. A `.stale.`/`.release.` rename
  // operates by path, so a stalled vacating renamer can capture a LIVE
  // holder's freshly installed generation, opening a transient absence window
  // at the lock path. The TEST plays that stalled renamer deterministically:
  // while holder H is parked inside its critical section on an awaited gate,
  // the test renames the lock path to a generated tombstone sibling, launches
  // rivals into the window, holds the window open until rival activity is
  // observed (or a bounded fallback elapses), and only then hands the
  // tombstone back with a bounded awaited retry loop — the same
  // race-the-entry-promise-against-a-fallback discipline as
  // runtime-v2-dir-lock-rename-away.test.js. Public contract only: at most
  // one holder ever inside; H's generation with H's owner token is restored
  // while H still holds; each rival either enters strictly after H exits or
  // rejects with exactly the configured busyMessage; the lock path is absent
  // at the end.
  it.skipIf(process.platform === 'win32')('vacating-rename capture: a live generation captured into a tombstone is handed back intact and the absence window admits no rival', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.record({
          tombstoneKind: fc.constantFrom('stale', 'release'),
          rivals: fc.integer({ min: 1, max: 2 }),
          heartbeatMs: fc.constantFrom(25, 40, 50),
        }),
        async ({ tombstoneKind, rivals, heartbeatMs }) => {
          const dir = await scratch();
          try {
            const lockPath = path.join(dir, 'shared.lock');
            const busyMessage = 'generated-busy-capture';
            const options = { staleMs: 60_000, heartbeatMs, busyMs: 5_000, busyMessage };
            const state = { inside: 0, maxInside: 0, events: [] };
            const gateH = deferred();
            const enteredSignals = {};
            const section = (name, gate) => {
              enteredSignals[name] = deferred();
              return async () => {
                state.inside += 1;
                state.maxInside = Math.max(state.maxInside, state.inside);
                state.events.push(`${name}-enter`);
                enteredSignals[name].resolve();
                try {
                  if (gate) await gate.promise;
                  return name;
                } finally {
                  state.inside -= 1;
                  state.events.push(`${name}-exit`);
                }
              };
            };
            let settledH;
            const settledRivals = [];
            const rivalNames = [];
            try {
              settledH = settle(withDirLock(lockPath, section('H', gateH), options));
              await Promise.race([enteredSignals.H.promise, settledH, sleep(2_000)]);
              expect(state.events, 'holder H must have acquired and entered its critical section').toContain('H-enter');
              const ownerH = readFileSync(path.join(lockPath, 'owner'), 'utf8');

              // The stalled vacating renamer strikes: H's LIVE generation is
              // captured into a tombstone sibling, opening the absence window.
              const tombstone = tombstoneKind === 'stale'
                ? `${lockPath}.stale.${randomUUID()}`
                : `${lockPath}.release.${randomUUID()}`;
              await rename(lockPath, tombstone);

              // Rivals contend INTO the window.
              for (let index = 0; index < rivals; index += 1) {
                const name = `R${index}`;
                rivalNames.push(name);
                settledRivals.push(settle(withDirLock(lockPath, section(name), options)));
              }

              // CRITIC-MANDATED ORDERING: the hand-back starts only after a
              // rival's install/withdraw activity is observed at the lock path
              // (or a rival unlawfully ENTERS — the mutant's failure — or the
              // bounded fallback elapses). An immediate hand-back would close
              // the window before any rival met the barrier and the property
              // would lose its discriminating power.
              const anyRivalEntry = Promise.race(
                rivalNames.map((name) => enteredSignals[name].promise),
              ).then(() => 'entered');
              const windowStarted = Date.now();
              while (Date.now() - windowStarted < 750) {
                const raced = await Promise.race([anyRivalEntry, sleep(10).then(() => 'tick')]);
                if (raced === 'entered') break;
                // A rival's transient staged install observed at the lock
                // path: the window has been contended, the barrier is in play.
                if (existsSync(lockPath)) break;
              }

              // The stalled renamer resumes: hand the tombstone back with a
              // bounded awaited retry loop — a window acquirer occupies the
              // lock path only until its own barrier withdraws.
              const handBackStarted = Date.now();
              for (;;) {
                try {
                  await rename(tombstone, lockPath);
                  break;
                } catch {
                  expect(
                    Date.now() - handBackStarted,
                    'the tombstone hand-back must converge within its bound',
                  ).toBeLessThan(10_000);
                  await sleep(10);
                }
              }

              // H's generation with H's owner token, restored while H still
              // holds — never a rival's generation, never absent.
              expect(
                existsSync(lockPath),
                "H's generation must be back at the lock path while H still holds",
              ).toBe(true);
              expect(
                readFileSync(path.join(lockPath, 'owner'), 'utf8'),
                "the restored lock must still carry H's owner token while H holds",
              ).toBe(ownerH);
              expect(state.maxInside, 'no rival may enter the critical section while H holds').toBe(1);
            } finally {
              // Settle every gate in finally so a failing tree fails cleanly.
              gateH.resolve();
              await Promise.race([
                Promise.all([settledH, ...settledRivals].filter(Boolean)),
                sleep(15_000),
              ]);
            }
            const hOutcome = await settledH;
            expect(hOutcome.kind, 'holder H must complete its critical section and release').toBe('resolved');
            expect(hOutcome.value).toBe('H');
            for (const [index, settledRival] of settledRivals.entries()) {
              const name = rivalNames[index];
              const outcome = await settledRival;
              if (outcome.kind === 'rejected') {
                // The only lawful rejection is the configured busy bound.
                expect(
                  outcome.message,
                  `rival ${name} may reject only with the configured busyMessage`,
                ).toBe(busyMessage);
              } else {
                // A rival that entered did so strictly after H exited.
                const enterIndex = state.events.indexOf(`${name}-enter`);
                const exitIndex = state.events.indexOf('H-exit');
                expect(
                  exitIndex,
                  `${name} entered the critical section but H never exited before it`,
                ).toBeGreaterThanOrEqual(0);
                expect(
                  exitIndex,
                  `${name} may enter the critical section only strictly after H exited`,
                ).toBeLessThan(enterIndex);
              }
            }
            expect(state.maxInside, 'at most one holder may ever be inside the critical section').toBe(1);
            expect(existsSync(lockPath), 'the lock path must be absent after all releases').toBe(false);
          } finally {
            await rm(dir, { recursive: true, force: true });
          }
        },
      ),
      { seed: SEED, numRuns: 8, verbose: 2 },
    );
  }, 300_000);
});
