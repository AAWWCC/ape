import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';

// ===========================================================================
// CONTRACT SUITE for test-support/temp-fixtures.js (roadmap entries
// mcp-interleaving-temp-dir-race and gate-sweep-test-fd-pressure). The module
// does not exist yet — this file is this run's RED anchor — and every arm
// below is written against the PUBLIC contract the implementer must satisfy,
// never against an implementation. Three exports:
//
//   mapBounded(items, fn, limit) — applies fn to every item, resolving to
//     results in INPUT order. At no instant may more than `limit` calls be
//     in flight. Rejects if any fn rejects. A limit at or above items.length
//     still behaves correctly.
//
//   killAndWait(child, signal) — sends `signal` to the child and resolves
//     only AFTER the child has actually exited (its exit/close event).
//     Resolves promptly if the child has already exited. Escalates to
//     SIGKILL after a bounded wait if the child ignores the signal, so it
//     must never hang forever.
//
//   removeTreeWithRetry(dir, options) — removes the tree recursively (an
//     async function returning a Promise), tolerating and retrying a bounded
//     number of times on ENOTEMPTY and ENOENT — the two races a
//     concurrently-dying writer produces, including a target that is
//     already fully gone (idempotent, mirroring the rmSync({force:true})
//     call sites it replaces). Throws if it still cannot remove the tree
//     after its attempts, so a genuine leak is never hidden.
//
// A single shared control surface for the mocked 'node:fs/promises' rm below
// (removeTreeWithRetry's only real seam for injecting a deterministic,
// non-flaky race, in place of hoping a real concurrent writer collides with
// the recursive walk on this host). Declared through vi.hoisted so it is
// safely visible from inside the (also hoisted) vi.mock factory, per
// https://vitest.dev/guide/mocking/modules#how-it-works. `queue` drains one
// forced failure per call (proving BOUNDED retry-then-recover);
// `persistentFailureCode`, when set, fails EVERY call (proving retries are
// bounded and a stuck removal is surfaced, never hidden).
// ===========================================================================

const state = vi.hoisted(() => ({ queue: [], persistentFailureCode: null }));

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal();
  const mockedRm = vi.fn(async (...args) => {
    if (state.persistentFailureCode) {
      const error = new Error(state.persistentFailureCode);
      error.code = state.persistentFailureCode;
      throw error;
    }
    if (state.queue.length > 0) {
      const code = state.queue.shift();
      const error = new Error(code);
      error.code = code;
      throw error;
    }
    return actual.rm(...args);
  });
  return { ...actual, rm: mockedRm };
});

import { mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises';

// The module under test does not exist yet (this file's whole reason to
// exist): each test below imports it dynamically, as its own first step,
// rather than through a static top-level import. A static import that
// cannot resolve fails the entire FILE before any test body runs (a
// suite-load error, "0 tests"); importing per-test instead lets every
// authored expectation genuinely execute and fail on its own — the
// unambiguous per-test red this suite is admitted on.
const loadFixtures = () => import('../test-support/temp-fixtures.js');

describe('mapBounded', () => {
  it('resolves to results in input order even when a later item settles first', async () => {
    const { mapBounded } = await loadFixtures();
    const items = [
      { value: 'a', delayMs: 30 },
      { value: 'b', delayMs: 0 },
      { value: 'c', delayMs: 15 },
    ];
    const fn = (item) => new Promise((resolve) => {
      setTimeout(() => resolve(item.value), item.delayMs);
    });
    const result = await mapBounded(items, fn, 2);
    expect(result).toEqual(['a', 'b', 'c']);
  });

  it('never lets more than `limit` calls be in flight at once', async () => {
    const { mapBounded } = await loadFixtures();
    const limit = 3;
    const items = Array.from({ length: 10 }, (_, index) => index);
    let inFlight = 0;
    let peak = 0;
    // Each call increments/records peak SYNCHRONOUSLY the instant mapBounded
    // actually invokes it, then defers its own resolution to a later
    // microtask turn (never immediately) — so a naive
    // Promise.all(items.map(fn)) spikes inFlight to items.length in one
    // synchronous pass and is caught, while any implementation that truly
    // never dispatches beyond `limit` outstanding calls cannot exceed it,
    // regardless of internal scheduling strategy (wave- or queue-based).
    const fn = (item) => new Promise((resolve) => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      queueMicrotask(() => {
        inFlight -= 1;
        resolve(item * 2);
      });
    });
    const result = await mapBounded(items, fn, limit);
    expect(peak).toBeLessThanOrEqual(limit);
    expect(result).toEqual(items.map((item) => item * 2));
  });

  it('behaves correctly when limit is at or above items.length', async () => {
    const { mapBounded } = await loadFixtures();
    const items = [1, 2, 3];
    const result = await mapBounded(items, async (item) => item * 2, items.length + 5);
    expect(result).toEqual([2, 4, 6]);
  });

  it('rejects when any fn call rejects', async () => {
    const { mapBounded } = await loadFixtures();
    const items = [1, 2, 3];
    const fn = async (item) => {
      if (item === 2) throw new Error('boom-mapBounded');
      return item;
    };
    await expect(mapBounded(items, fn, 2)).rejects.toThrow('boom-mapBounded');
  });
});

// ===========================================================================
// Input-validation arms (roadmap: support-tooling-answers-honestly, absorbing
// temp-fixtures-out-of-contract-input-silent). Neither of this module's two
// current call sites ever passes a non-finite/non-positive limit or a
// non-positive-integer maxAttempts (the sweep test passes a literal 64; the
// interleaving test passes no options at all), but the module is shared
// infrastructure importable by every test file in this repo, so an
// out-of-contract input must fail LOUDLY rather than silently degrading:
// mapBounded(items, fn, NaN) must not resolve an all-undefined array with fn
// never called, and removeTreeWithRetry(dir, { maxAttempts: 0 }) must not
// throw `undefined` (today's fall-through: the retry loop never runs, so
// `lastError` stays unset and `throw lastError` throws literal undefined).
// ===========================================================================
describe('mapBounded input validation', () => {
  it('refuses a non-finite limit loudly, naming the offending value, instead of silently resolving an all-undefined array with fn never called', async () => {
    const { mapBounded } = await loadFixtures();
    let called = false;
    const fn = () => { called = true; return 'unreachable'; };
    await expect(mapBounded([1, 2, 3], fn, NaN)).rejects.toThrow(TypeError);
    await expect(mapBounded([1, 2, 3], fn, NaN)).rejects.toThrow(/NaN/);
    expect(called).toBe(false);
  });

  it('refuses a non-positive limit loudly instead of silently resolving with fn never called', async () => {
    const { mapBounded } = await loadFixtures();
    let called = false;
    const fn = () => { called = true; return 'unreachable'; };
    await expect(mapBounded([1, 2, 3], fn, 0)).rejects.toThrow(TypeError);
    await expect(mapBounded([1, 2, 3], fn, -5)).rejects.toThrow(TypeError);
    expect(called).toBe(false);
  });
});

describe('removeTreeWithRetry maxAttempts validation', () => {
  it('refuses an explicit maxAttempts of 0 loudly, naming the offending value, instead of throwing an undefined lastError', async () => {
    const { removeTreeWithRetry } = await loadFixtures();
    const dir = path.join(
      os.tmpdir(),
      `ape-temp-fixtures-maxattempts-zero-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    await expect(removeTreeWithRetry(dir, { maxAttempts: 0 })).rejects.toThrow(TypeError);
    await expect(removeTreeWithRetry(dir, { maxAttempts: 0 })).rejects.toThrow(/0/);
  });

  it('refuses a non-integer maxAttempts loudly instead of admitting a path that can throw undefined', async () => {
    const { removeTreeWithRetry } = await loadFixtures();
    const dir = path.join(
      os.tmpdir(),
      `ape-temp-fixtures-maxattempts-frac-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    await expect(removeTreeWithRetry(dir, { maxAttempts: 1.5 })).rejects.toThrow(TypeError);
    await expect(removeTreeWithRetry(dir, { maxAttempts: -3 })).rejects.toThrow(TypeError);
  });
});

// ===========================================================================
// Roadmap entry outside-input-coerced-not-refused-and-ambient-env-denylist,
// item B: acme PR #401 added a loud TypeError guard for maxAttempts (above) but
// left retryDelayMs taken RAW at `options.retryDelayMs ?? REMOVE_TREE_RETRY_
// DELAY_MS`, reaching sleep()/setTimeout with no validation at all --
// setTimeout coerces a NaN or negative delay to a silently-wrong ~1ms retry
// cadence rather than refusing it. It is the one remaining option in a module
// whose stated contract (this file's own describe block above) is now "fail
// loudly on out-of-contract input", not "fail loudly on SOME out-of-contract
// input". These arms call with a target directory that does not exist so
// that a correct, EAGER guard (mirroring maxAttempts' own eager guard, which
// runs before the retry loop and before any real filesystem call) must fire
// regardless of whether the removal itself would have succeeded trivially.
// ===========================================================================
describe('removeTreeWithRetry retryDelayMs validation', () => {
  it('refuses a non-finite retryDelayMs loudly, naming the offending value, instead of silently retrying at whatever setTimeout(NaN) resolves to', async () => {
    const { removeTreeWithRetry } = await loadFixtures();
    const dir = path.join(
      os.tmpdir(),
      `ape-temp-fixtures-retrydelay-nan-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    await expect(removeTreeWithRetry(dir, { retryDelayMs: NaN })).rejects.toThrow(TypeError);
    await expect(removeTreeWithRetry(dir, { retryDelayMs: NaN })).rejects.toThrow(/NaN/);
  });

  it('refuses a negative retryDelayMs loudly instead of silently coercing it to an immediate retry', async () => {
    const { removeTreeWithRetry } = await loadFixtures();
    const dir = path.join(
      os.tmpdir(),
      `ape-temp-fixtures-retrydelay-neg-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    await expect(removeTreeWithRetry(dir, { retryDelayMs: -5 })).rejects.toThrow(TypeError);
  });

  it('accepts an explicit, valid retryDelayMs and still removes the tree normally', async () => {
    const { removeTreeWithRetry } = await loadFixtures();
    const dir = await mkdtemp(path.join(os.tmpdir(), 'ape-temp-fixtures-retrydelay-valid-'));
    await writeFile(path.join(dir, 'file.txt'), 'x');
    await removeTreeWithRetry(dir, { retryDelayMs: 5 });
    await expect(stat(dir)).rejects.toMatchObject({ code: 'ENOENT' });
  });
});

// ===========================================================================
// ENUMERATION ARM (review finding 6; the run objective's ENUMERATION BAR).
// Acceptance (B) of outside-input-coerced-not-refused-and-ambient-env-
// denylist requires that "a reviewer must be able to confirm this by
// ENUMERATING options" — the two describe blocks above each hard-code one
// option name (maxAttempts, retryDelayMs); neither DERIVES the population
// from test-support/temp-fixtures.js's own REMOVE_TREE_OPTION_SPEC, so a
// third option added to that spec with no matching invalid-value arm here
// would redden nothing. REMOVE_TREE_OPTION_SPEC is not itself exported by
// test-support/temp-fixtures.js (only mapBounded, killAndWait and
// removeTreeWithRetry are), so this arm reads the module's SOURCE TEXT the
// same way __tests__/runtime-v2-hook-matcher-coverage.test.js:70-74 derives
// lib/runtime/hooks.js's WRITE_TOOLS, rather than importing an unexported
// internal -- that is the actual reason, not a claim that this run avoids
// touching temp-fixtures.js: the BUILD stage of this run claims and edits
// test-support/temp-fixtures.js directly (adding the retryDelayMs guard the
// describe block above pins), so "this ticket does not claim or edit it"
// would be false and is not said here.
// ===========================================================================
const TEMP_FIXTURES_SOURCE = readFileSync(
  path.join(path.dirname(path.dirname(fileURLToPath(import.meta.url))), 'test-support', 'temp-fixtures.js'),
  'utf8',
);

// Top-level keys only ("  name: {" at exactly two-space indentation) — never
// a nested `default:`/`valid:`/`describe:` line inside a key's own validator
// body, which sits at four-space indentation in this module's own style.
function extractOptionSpecKeys(source) {
  const match = source.match(/const REMOVE_TREE_OPTION_SPEC = \{([\s\S]*?)\n\};/);
  if (!match) return null;
  return [...match[1].matchAll(/^ {2}(\w+):\s*\{/gm)].map((entry) => entry[1]);
}

const REMOVE_TREE_OPTION_SPEC_KEYS = extractOptionSpecKeys(TEMP_FIXTURES_SOURCE);

// The option names THIS FILE proves guarded, one behavioral invalid-value
// arm each: maxAttempts above ('removeTreeWithRetry maxAttempts validation'),
// retryDelayMs above ('removeTreeWithRetry retryDelayMs validation'). Kept as
// an explicit, hand-maintained set — never re-derived from the same source
// text a line above, or a regex bug in the extractor could rubber-stamp
// itself — so a key present in the spec but absent from this set is a real
// gap, not a tautology.
const OPTION_SPEC_KEYS_WITH_INVALID_VALUE_ARM = new Set(['maxAttempts', 'retryDelayMs']);

describe('removeTreeWithRetry option population is derived from REMOVE_TREE_OPTION_SPEC, with no unguarded key (review finding 6)', () => {
  it('extracts a non-empty REMOVE_TREE_OPTION_SPEC key set from test-support/temp-fixtures.js source', () => {
    expect(
      REMOVE_TREE_OPTION_SPEC_KEYS,
      'const REMOVE_TREE_OPTION_SPEC = {...} literal not found in test-support/temp-fixtures.js',
    ).not.toBeNull();
    expect(REMOVE_TREE_OPTION_SPEC_KEYS.length).toBeGreaterThan(0);
    expect(REMOVE_TREE_OPTION_SPEC_KEYS).toContain('maxAttempts');
    expect(REMOVE_TREE_OPTION_SPEC_KEYS).toContain('retryDelayMs');
  });

  it('every REMOVE_TREE_OPTION_SPEC key has a behavioral invalid-value arm in this file, so a new key added without one reddens here rather than silently reaching sleep()/setTimeout unguarded', () => {
    const untested = (REMOVE_TREE_OPTION_SPEC_KEYS ?? []).filter(
      (key) => !OPTION_SPEC_KEYS_WITH_INVALID_VALUE_ARM.has(key),
    );
    expect(
      untested,
      `REMOVE_TREE_OPTION_SPEC key(s) with no invalid-value arm in this file: ${untested.join(', ')}`,
    ).toEqual([]);
  });
});

describe('killAndWait', () => {
  const children = [];

  afterEach(() => {
    for (const child of children.splice(0)) {
      if (child.exitCode === null && child.signalCode === null) {
        try { child.kill('SIGKILL'); } catch { /* already gone */ }
      }
    }
  });

  function spawnChild(script) {
    return spawn(process.execPath, ['-e', script], { stdio: ['ignore', 'pipe', 'pipe'] });
  }

  // Rendezvous with the child's own readiness (its signal handler installed
  // and its keep-alive armed) BEFORE the test starts timing or signalling —
  // otherwise a slow cold spawn would be conflated with the property under
  // test.
  function waitForReady(child) {
    return new Promise((resolve, reject) => {
      let buffered = '';
      const onData = (chunk) => {
        buffered += chunk;
        if (buffered.includes('READY')) {
          child.stdout.off('data', onData);
          resolve();
        }
      };
      child.stdout.setEncoding('utf8');
      child.stdout.on('data', onData);
      child.once('error', reject);
    });
  }

  it.skipIf(process.platform === 'win32')('resolves only after the child has actually exited, not merely after the signal is sent', async () => {
    const { killAndWait } = await loadFixtures();
    // Politely handles SIGTERM but only exits 300ms later — long enough that
    // an implementation resolving right after calling child.kill() (instead
    // of awaiting the real exit) is caught by the elapsed-time floor below.
    const child = spawnChild(`
      process.on('SIGTERM', () => { setTimeout(() => process.exit(0), 300); });
      console.log('READY');
      setInterval(() => {}, 1000);
    `);
    children.push(child);
    await waitForReady(child);
    const startedAt = Date.now();
    await killAndWait(child, 'SIGTERM');
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(250);
    expect(child.exitCode).toBe(0);
  }, 10_000);

  it.skipIf(process.platform === 'win32')('escalates to SIGKILL after a bounded wait when the child ignores the signal, resolving only once the escalation actually reaps it', async () => {
    const { killAndWait } = await loadFixtures();
    // Installs a SIGTERM handler that does nothing and never exits on its
    // own: the ONLY way this process ever terminates is a forced SIGKILL,
    // so a resolved promise here is direct proof the escalation fired and
    // actually reaped the child (never a false positive from a graceful
    // self-exit).
    const child = spawnChild(`
      process.on('SIGTERM', () => {});
      console.log('READY');
      setInterval(() => {}, 1000);
    `);
    children.push(child);
    await waitForReady(child);
    await killAndWait(child, 'SIGTERM');
    expect(child.signalCode).toBe('SIGKILL');
  }, 30_000);

  it('resolves promptly when the child has already exited', async () => {
    const { killAndWait } = await loadFixtures();
    const child = spawnChild('process.exit(0);');
    children.push(child);
    await new Promise((resolve) => child.once('exit', resolve));
    const startedAt = Date.now();
    await killAndWait(child, 'SIGTERM');
    expect(Date.now() - startedAt).toBeLessThan(2000);
  }, 10_000);

  it('honors the requested signal directly: SIGKILL terminates promptly with no escalation needed', async () => {
    const { killAndWait } = await loadFixtures();
    const child = spawnChild(`
      console.log('READY');
      setInterval(() => {}, 1000);
    `);
    children.push(child);
    await waitForReady(child);
    const startedAt = Date.now();
    await killAndWait(child, 'SIGKILL');
    expect(Date.now() - startedAt).toBeLessThan(2000);
    expect(child.signalCode).toBe('SIGKILL');
  }, 10_000);
});

describe('removeTreeWithRetry', () => {
  let scratchDirs = [];

  afterEach(async () => {
    state.queue = [];
    state.persistentFailureCode = null;
    rm.mockClear();
    await Promise.all(
      scratchDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
    );
  });

  it('resolves without throwing when the target does not exist at all (idempotent)', async () => {
    const { removeTreeWithRetry } = await loadFixtures();
    const missing = path.join(
      os.tmpdir(),
      `ape-temp-fixtures-missing-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    await removeTreeWithRetry(missing);
  });

  it('removes a real nested directory tree', async () => {
    const { removeTreeWithRetry } = await loadFixtures();
    const dir = await mkdtemp(path.join(os.tmpdir(), 'ape-temp-fixtures-basic-'));
    scratchDirs.push(dir);
    await mkdir(path.join(dir, 'nested'), { recursive: true });
    await writeFile(path.join(dir, 'nested', 'file.txt'), 'x');
    await removeTreeWithRetry(dir);
    await expect(stat(dir)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('tolerates a transient ENOTEMPTY then a transient ENOENT and still removes the tree', async () => {
    const { removeTreeWithRetry } = await loadFixtures();
    const dir = await mkdtemp(path.join(os.tmpdir(), 'ape-temp-fixtures-retry-'));
    scratchDirs.push(dir);
    await writeFile(path.join(dir, 'file.txt'), 'x');
    // Exactly two forced failures queued: the tree is only ACTUALLY removed
    // once removeTreeWithRetry calls the underlying rm a third time, so
    // success below is only reachable through a genuine retry, not a lucky
    // first-call passthrough.
    state.queue = ['ENOTEMPTY', 'ENOENT'];
    await removeTreeWithRetry(dir);
    expect(rm.mock.calls.length).toBeGreaterThanOrEqual(3);
    await expect(stat(dir)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('throws rather than hiding a persistent removal failure', async () => {
    const { removeTreeWithRetry } = await loadFixtures();
    const dir = await mkdtemp(path.join(os.tmpdir(), 'ape-temp-fixtures-stuck-'));
    scratchDirs.push(dir);
    await writeFile(path.join(dir, 'file.txt'), 'x');
    state.persistentFailureCode = 'ENOTEMPTY';
    await expect(removeTreeWithRetry(dir)).rejects.toBeTruthy();
    // More than one attempt (a bounded RETRY, not an immediate give-up) yet
    // it still surfaces the failure instead of swallowing it.
    expect(rm.mock.calls.length).toBeGreaterThan(1);
  });
});
