import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { mkdir, mkdtemp, open, readdir, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { hostname, tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { acquireRunLock, releaseRunLock, stealLockFileByRename, withDirLock } from '../lib/runtime/lock.js';
import { overrideRun, startRun } from '../lib/runtime/service.js';
import { atomicWriteJson, replaceFile } from '../lib/runtime/storage.js';
import { runtimePaths } from '../lib/runtime/paths.js';

// Churn interception for the busyMs-bound test below. The module mock is a
// transparent passthrough to the real node:fs/promises until a test opts one
// specific lock dir into the pathological create/remove race by setting
// `churn.lockPath` — so every other test in this file exercises the real
// filesystem completely unchanged.
const churn = vi.hoisted(() => ({ lockPath: null }));
const releaseHold = vi.hoisted(() => ({ lockPath: null, gate: null, entered: 0 }));

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal();
  const codedError = (code, message) => Object.assign(new Error(message), { code });
  // Yield a macrotask before throwing so a buggy acquisition loop cannot starve
  // the timer queue: a genuine hang must stay observable to the wall-clock bound
  // (and to vitest's own test timeout), never wedge the entire worker.
  const yieldToTimers = () => new Promise((resolve) => setImmediate(resolve));
  return {
    ...actual,
    mkdir: async (...args) => {
      const [target] = args;
      if (churn.lockPath !== null && target === churn.lockPath) {
        await yieldToTimers();
        throw codedError('EEXIST', `EEXIST: file already exists, mkdir '${target}'`);
      }
      return actual.mkdir(...args);
    },
    stat: async (...args) => {
      const [target] = args;
      if (churn.lockPath !== null && target === churn.lockPath) {
        await yieldToTimers();
        throw codedError('ENOENT', `ENOENT: no such file or directory, stat '${target}'`);
      }
      return actual.stat(...args);
    },
    rm: async (...args) => {
      const [target] = args;
      if (
        releaseHold.lockPath !== null
        && typeof target === 'string'
        && target.startsWith(`${releaseHold.lockPath}.release.`)
      ) {
        releaseHold.entered += 1;
        await releaseHold.gate;
      }
      return actual.rm(...args);
    },
  };
});

const cleanups = [];
afterEach(async () => {
  releaseHold.lockPath = null;
  releaseHold.gate = null;
  releaseHold.entered = 0;
  await Promise.all(cleanups.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(predicate, timeoutMs = 10_000) {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) throw new Error('condition not reached in time');
    await sleep(10);
  }
}

async function scratch() {
  const dir = await mkdtemp(path.join(tmpdir(), 'ape-lock-protocol-'));
  cleanups.push(dir);
  return dir;
}

// A pid that is guaranteed dead: the spawned process has already exited.
function deadPid() {
  return spawnSync(process.execPath, ['-e', '']).pid;
}

function git(cwd, ...args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

async function project() {
  const dir = await scratch();
  await mkdir(path.join(dir, 'src'));
  await mkdir(path.join(dir, 'tests'));
  await writeFile(path.join(dir, 'src', 'value.js'), 'export const value = 1;\n');
  await writeFile(path.join(dir, 'tests', 'value.test.js'), 'throw new Error("red");\n');
  git(dir, 'init', '-q');
  git(dir, 'config', 'user.email', 'ape@example.test');
  git(dir, 'config', 'user.name', 'APE Test');
  git(dir, 'add', '.');
  git(dir, 'commit', '-qm', 'baseline');
  return dir;
}

function goodConfig() {
  return {
    shipping: { auto_merge: false, provider: 'github', required_remote_checks: false },
    test_commands: { full: 'node --test' },
  };
}

function startInput() {
  return {
    objective: 'Exercise run-lock atomicity',
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

describe.skipIf(process.platform === 'win32')('APE v2 shared dir lock: stale steal is single-winner (invariant 7)', () => {
  it('never admits two concurrent stealers of the same stale lock', { timeout: 120_000 }, async () => {
    const dir = await scratch();
    const lockPath = path.join(dir, 'shared.lock');
    await mkdir(lockPath);
    // A dead holder's lock: no heartbeat has refreshed it for far past staleness.
    const dead = new Date(Date.now() - 10 * 60_000);
    await utimes(lockPath, dead, dead);
    const events = [];
    const options = { staleMs: 500, heartbeatMs: 50, busyMs: 60_000, busyMessage: 'busy' };
    const section = (name) => async () => {
      events.push(`${name}-start`);
      await sleep(400);
      events.push(`${name}-end`);
    };
    // Pre-fix (stat-then-rm), both contenders judged the same dir stale, the
    // second rm deleted the first's fresh lock, and both entered concurrently.
    await Promise.all([
      withDirLock(lockPath, section('a'), options),
      withDirLock(lockPath, section('b'), options),
    ]);
    expect([
      'a-start,a-end,b-start,b-end',
      'b-start,b-end,a-start,a-end',
    ]).toContain(events.join(','));
    expect(existsSync(lockPath)).toBe(false);
  });

  it('a stolen-from holder\'s release leaves the thief\'s lock intact', async () => {
    const dir = await scratch();
    const lockPath = path.join(dir, 'shared.lock');
    const events = [];
    // The holder's heartbeat is effectively disabled, simulating a stalled
    // process whose lock legitimately goes stale mid-critical-section.
    const holder = withDirLock(lockPath, async () => {
      events.push('holder-start');
      await sleep(800);
      events.push('holder-end');
    }, { staleMs: 60_000, heartbeatMs: 600_000, busyMs: 15_000, busyMessage: 'busy' });
    await waitFor(() => events.includes('holder-start'));
    // Backdate the held lock far past the thief's staleness threshold so the
    // steal is deterministic regardless of scheduler timing.
    const dead = new Date(Date.now() - 10 * 60_000);
    await utimes(lockPath, dead, dead);
    const thief = withDirLock(lockPath, async () => {
      events.push('thief-start');
      await sleep(2_000);
      events.push('thief-end');
    }, { staleMs: 500, heartbeatMs: 50, busyMs: 15_000, busyMessage: 'busy' });
    await waitFor(() => events.includes('thief-start'));
    const thiefOwner = readFileSync(path.join(lockPath, 'owner'), 'utf8');
    await holder;
    // Pre-fix the holder's finally unconditionally rm'd the lock path,
    // deleting the thief's live lock and admitting a third writer.
    expect(events).toContain('holder-end');
    expect(existsSync(lockPath)).toBe(true);
    expect(readFileSync(path.join(lockPath, 'owner'), 'utf8')).toBe(thiefOwner);
    await thief;
    expect(existsSync(lockPath)).toBe(false);
  });
});

describe('APE v2 shared dir lock: release-window contention', () => {
  it('does not extend one held release tombstone into a withdrawal chain', async () => {
    const dir = await scratch();
    const lockPath = path.join(dir, 'shared.lock');
    const options = {
      staleMs: 60_000,
      heartbeatMs: 5_000,
      busyMs: 10_000,
      serializeLocal: true,
      busyMessage: 'busy',
    };
    let releaseHeld;
    const gate = new Promise((resolve) => { releaseHeld = resolve; });
    releaseHold.lockPath = lockPath;
    releaseHold.gate = gate;

    const holder = withDirLock(lockPath, async () => 'holder', options);
    await waitFor(() => releaseHold.entered === 1);

    let entered = 0;
    const contenders = Array.from({ length: 16 }, () => withDirLock(lockPath, async () => {
      entered += 1;
    }, options));

    try {
      await sleep(150);
      const releaseTombstones = (await readdir(dir))
        .filter((name) => name.startsWith('shared.lock.release.'));
      expect(entered, 'no contender may enter while release hand-back is unresolved').toBe(0);
      expect(
        releaseTombstones,
        'contenders must wait on the existing tombstone instead of creating a withdrawal chain',
      ).toHaveLength(1);
    } finally {
      releaseHeld();
    }

    await holder;
    await Promise.all(contenders);
    expect(entered).toBe(16);
  }, 30_000);
});

describe('APE v2 run-lock crash recovery (invariant 7)', () => {
  it('recovers a same-host dead-pid lock only under recoverStale, and audits the steal', async () => {
    const dir = await scratch();
    const lock = path.join(dir, 'active.lock');
    writeFileSync(lock, `${JSON.stringify({ version: 1, run_id: 'run-dead', pid: deadPid(), host: hostname() })}\n`);
    await expect(acquireRunLock(lock, 'run-new')).rejects.toThrow(/another APE writing run/);
    const recovered = [];
    const payload = await acquireRunLock(lock, 'run-new', {
      recoverStale: true,
      onRecover: (detail) => recovered.push(detail),
    });
    expect(payload.run_id).toBe('run-new');
    expect(recovered).toEqual([{ kind: 'stale-pid', run_id: 'run-dead' }]);
    expect(JSON.parse(readFileSync(lock, 'utf8')).run_id).toBe('run-new');
    await expect(releaseRunLock(lock, 'run-other')).rejects.toThrow(/refusing to release lock owned by run-new/);
    await releaseRunLock(lock, 'run-new');
    expect(existsSync(lock)).toBe(false);
  });

  it('never steals a cross-host lock even with a locally-unknown pid', async () => {
    const dir = await scratch();
    const lock = path.join(dir, 'active.lock');
    writeFileSync(lock, `${JSON.stringify({ version: 1, run_id: 'run-foreign', pid: deadPid(), host: `${hostname()}-elsewhere` })}\n`);
    await expect(acquireRunLock(lock, 'run-new', { recoverStale: true })).rejects.toThrow(/another APE writing run is active \(run-foreign\)/);
    expect(JSON.parse(readFileSync(lock, 'utf8')).run_id).toBe('run-foreign');
  });

  it('admits exactly one of two concurrent recoveries of the same stale lock', async () => {
    const dir = await scratch();
    const lock = path.join(dir, 'active.lock');
    writeFileSync(lock, `${JSON.stringify({ version: 1, run_id: 'run-dead', pid: deadPid(), host: hostname() })}\n`);
    // Pre-fix (read-then-rm), the second contender's rm could delete the first
    // contender's freshly written lock and both would acquire.
    const results = await Promise.allSettled([
      acquireRunLock(lock, 'run-a', { recoverStale: true }),
      acquireRunLock(lock, 'run-b', { recoverStale: true }),
    ]);
    const winners = results.filter((result) => result.status === 'fulfilled');
    const losers = results.filter((result) => result.status === 'rejected');
    expect(winners).toHaveLength(1);
    expect(losers).toHaveLength(1);
    expect(losers[0].reason.message).toMatch(/another APE writing run/);
    expect(JSON.parse(readFileSync(lock, 'utf8')).run_id).toBe(winners[0].value.run_id);
  });

  // The natural-timing race above is probabilistic; these pin the primitive
  // deterministically. Pre-fix, stealLockFileByRename renamed BY PATH and never
  // checked the tombstone's content, so a contender that observed generation-N's
  // stale bytes would happily delete generation-N+1's FRESH lock a faster
  // contender had already installed — the two-winner reproduction (invariant 7).
  it('stealLockFileByRename refuses to steal when the lock content changed under it', async () => {
    const dir = await scratch();
    const lock = path.join(dir, 'active.lock');
    const stale = `${JSON.stringify({ version: 1, run_id: 'run-dead', pid: deadPid(), host: hostname() })}\n`;
    writeFileSync(lock, stale);
    // A faster contender already recovered and installed a fresh live lock where
    // the stale one was; we still hold the stale bytes we read moments earlier.
    const fresh = `${JSON.stringify({ version: 1, run_id: 'run-winner', pid: process.pid, host: hostname() })}\n`;
    writeFileSync(lock, fresh);
    const won = await stealLockFileByRename(lock, stale);
    expect(won).toBe(false);
    // The winner's fresh lock survives untouched — not deleted out from under it.
    expect(readFileSync(lock, 'utf8')).toBe(fresh);
  });

  it('stealLockFileByRename steals only when the observed bytes still hold', async () => {
    const dir = await scratch();
    const lock = path.join(dir, 'active.lock');
    const stale = `${JSON.stringify({ version: 1, run_id: 'run-dead', pid: deadPid(), host: hostname() })}\n`;
    writeFileSync(lock, stale);
    const won = await stealLockFileByRename(lock, stale);
    expect(won).toBe(true);
    expect(existsSync(lock)).toBe(false);
  });

  it('recovers a 0-byte lock under recoverStale instead of wedging permanently', async () => {
    const dir = await scratch();
    const lock = path.join(dir, 'active.lock');
    writeFileSync(lock, '');
    await expect(acquireRunLock(lock, 'run-new')).rejects.toThrow(/unreadable; use override reset/);
    const recovered = [];
    const payload = await acquireRunLock(lock, 'run-new', {
      recoverStale: true,
      onRecover: (detail) => recovered.push(detail),
    });
    expect(payload.run_id).toBe('run-new');
    expect(recovered).toEqual([{ kind: 'unreadable-lock', run_id: null }]);
    expect(JSON.parse(readFileSync(lock, 'utf8')).run_id).toBe('run-new');
    await releaseRunLock(lock, 'run-new');
  });

  it('releaseRunLock clears an unreadable lock instead of throwing', async () => {
    const dir = await scratch();
    const lock = path.join(dir, 'active.lock');
    writeFileSync(lock, '');
    // Pre-fix this threw SyntaxError, wedging abort's release_lock action
    // after the history archive had already recorded the run as aborted.
    await releaseRunLock(lock, 'run-any');
    expect(existsSync(lock)).toBe(false);
  });
});

describe('APE v2 START failure atomicity (invariant 7)', () => {
  it('releases the run lock when START fails between acquire_lock and persist_state', async () => {
    const dir = await project();
    const paths = runtimePaths(dir);
    // A human-shaped deadline makes ticket issuance throw (RangeError on
    // Invalid Date) after acquire_lock but before active.json persists.
    await atomicWriteJson(paths.config, { ...goodConfig(), deadlines_ms: { fast: '30m' } });
    await expect(startRun(dir, startInput())).rejects.toThrow();
    expect(existsSync(paths.active)).toBe(false);
    // Pre-fix the lock survived here, wedging every future start for the
    // holder's session lifetime while abort/override said 'no active run'.
    expect(existsSync(paths.lock)).toBe(false);
    await atomicWriteJson(paths.config, goodConfig());
    const second = await startRun(dir, startInput());
    expect(second.ok).toBe(true);
  });
});

describe('APE v2 override reset on an orphaned run lock', () => {
  it('reset clears the lock with an audit line; abort still refuses', async () => {
    const dir = await scratch();
    const paths = runtimePaths(dir);
    await acquireRunLock(paths.lock, 'run-orphan');
    // No active.json: the state a crashed start leaves behind.
    const denied = await overrideRun(dir, 'abort', 'abort with no active run');
    expect(denied).toEqual({ ok: false, reason: 'no active run' });
    expect(existsSync(paths.lock)).toBe(true);
    const reset = await overrideRun(dir, 'reset', 'clear orphaned lock after crashed start');
    expect(reset).toMatchObject({ ok: true, recovered: 'orphaned-lock', run: null });
    expect(existsSync(paths.lock)).toBe(false);
    const lines = readFileSync(paths.overrideLog, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
    expect(lines).toContainEqual(expect.objectContaining({
      run_id: 'run-orphan',
      operation: 'reset',
      orphaned_lock: true,
      reason: 'clear orphaned lock after crashed start',
    }));
    // With neither lock nor state there is nothing to recover.
    const nothing = await overrideRun(dir, 'reset', 'nothing to clear');
    expect(nothing).toEqual({ ok: false, reason: 'no active run' });
  });

  it('reset also clears an unreadable (0-byte) orphaned lock, honoring the advertised remedy', async () => {
    const dir = await scratch();
    const paths = runtimePaths(dir);
    await mkdir(paths.runtime, { recursive: true });
    writeFileSync(paths.lock, '');
    const reset = await overrideRun(dir, 'reset', 'clear corrupt lock left by a crash');
    expect(reset).toMatchObject({ ok: true, recovered: 'orphaned-lock' });
    expect(existsSync(paths.lock)).toBe(false);
  });
});

describe('APE v2 atomic replace (D1)', () => {
  it('replaceFile installs the new content and consumes the temp file', async () => {
    const dir = await scratch();
    const file = path.join(dir, 'value.json');
    await atomicWriteJson(file, { generation: 1 });
    const temporary = path.join(dir, 'value.json.tmp');
    writeFileSync(temporary, '{"generation":2}\n');
    await replaceFile(temporary, file);
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({ generation: 2 });
    expect(existsSync(temporary)).toBe(false);
  });

  // Win32-only (D1): the pre-fix fallback deleted the target before renaming,
  // so a reader holding the file open could observe the state path absent (or
  // permanently lose it on a crash between the rm and the rename).
  it.runIf(process.platform === 'win32')('win32: the target path is never observable-absent under a concurrent open handle', async () => {
    const dir = await scratch();
    const file = path.join(dir, 'state.json');
    await atomicWriteJson(file, { generation: 0 });
    const reader = await open(file, 'r');
    // The reader stays open across every replace, so on win32 each rename-over
    // hits the bounded retry-then-copy fallback; with GitHub-runner AV latency
    // per temp file, 50 rounds blew the default timeout. A dozen rounds still
    // proves the property — a delete-before-rename regression fails on the
    // FIRST stat — so keep the count low and the timeout generous.
    const ROUNDS = 12;
    try {
      for (let generation = 1; generation <= ROUNDS; generation += 1) {
        await atomicWriteJson(file, { generation });
        // stat throws ENOENT if the delete-before-rename window reopens.
        await stat(file);
      }
    } finally {
      await reader.close();
    }
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({ generation: ROUNDS });
  }, 60_000);
});

describe('APE v2 shared dir lock: busyMs bounds the acquisition spin (invariant 7 timeout guarantee)', () => {
  afterEach(() => {
    // Disable churn interception between tests; the module mock reverts to a
    // transparent passthrough whenever churn.lockPath is null.
    churn.lockPath = null;
  });

  // Under pathological create/remove churn on the lock dir — mkdir perpetually
  // reports EEXIST while stat perpetually reports ENOENT — the acquisition loop
  // in withDirLock must still honour its busyMs timeout. On the current tree the
  // ENOENT `continue` jumps back to the loop top and SKIPS both the late
  // deadline check and the sleep throttle, so the loop hot-spins without ever
  // timing out (the busyMs guarantee is defeated). This test drives that exact
  // churn against a faked fs and asserts withDirLock REJECTS with busyMessage
  // within a small multiple of busyMs — RED today (it never settles, so the
  // wall-clock bound elapses), GREEN once the deadline check is hoisted to the
  // top of the loop so every path (including the ENOENT continue) is bounded.
  it('rejects with busyMessage within the busyMs bound under mkdir->EEXIST / stat->ENOENT churn', async () => {
    const dir = await scratch();
    const lockPath = path.join(dir, 'churn.lock');
    const busyMs = 150;
    const busyMessage = 'lock acquisition timed out';
    const options = { staleMs: 10_000, heartbeatMs: 50, busyMs, busyMessage };

    // Opt this lock dir into the faked churn: mkdir always EEXIST, stat always
    // ENOENT (the exact codes lock.js branches on).
    churn.lockPath = lockPath;

    const started = Date.now();
    const lockPromise = withDirLock(lockPath, async () => 'acquired', options);
    // `.then(onFulfilled, onRejected)` fully handles the promise, so a loop that
    // only settles later on a buggy tree never surfaces as an unhandled rejection.
    const settled = lockPromise.then(
      (value) => ({ kind: 'resolved', value }),
      (error) => ({ kind: 'rejected', message: error?.message }),
    );
    // Hard wall-clock ceiling well above busyMs: if the loop escapes its deadline
    // it would spin forever, so cap the observation and treat an overrun as the
    // failure (a clean FAIL rather than an infinite hang that stalls the suite).
    const outcome = await Promise.race([
      settled,
      sleep(busyMs * 12).then(() => ({ kind: 'timeout' })),
    ]);
    const elapsed = Date.now() - started;

    try {
      // The callback never runs (the lock is never acquired), so the only correct
      // outcome is a bounded rejection carrying busyMessage.
      expect(outcome.kind, 'withDirLock must settle within the busyMs bound, not hot-spin past its deadline').toBe('rejected');
      expect(outcome.message).toBe(busyMessage);
      expect(elapsed, 'the rejection must land within a small multiple of busyMs').toBeLessThan(busyMs * 10);
    } finally {
      // Turn churn off and let any background loop (buggy tree) terminate cleanly
      // via the now-passthrough fs, so no stray temp lock survives the test.
      churn.lockPath = null;
      await lockPromise.catch(() => {});
    }
  }, 6_000);
});
