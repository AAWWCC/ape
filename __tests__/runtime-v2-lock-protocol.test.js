import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { mkdir, mkdtemp, open, readFile, readdir, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { hostname, tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  acquireRunLock,
  computeFsLatencyMultiplier,
  releaseRunLock,
  stealLockFileByRename,
  withDirLock,
} from '../lib/runtime/lock.js';
import { overrideRun, startRun } from '../lib/runtime/service.js';
import { atomicWriteJson, replaceFile } from '../lib/runtime/storage.js';
import { runtimePaths } from '../lib/runtime/paths.js';

// Churn interception for the busyMs-bound test below. The module mock is a
// transparent passthrough to the real node:fs/promises until a test opts one
// specific lock dir into the pathological create/remove race by setting
// `churn.lockPath` — so every other test in this file exercises the real
// filesystem completely unchanged.
const churn = vi.hoisted(() => ({ lockPath: null, onMissing: null }));
const releaseHold = vi.hoisted(() => ({ lockPath: null, gate: null, entered: 0 }));
const releaseFault = vi.hoisted(() => ({ rename: null }));

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal();
  const codedError = (code, message) => Object.assign(new Error(message), { code });
  // Keep timer scheduling live while exercising asynchronous contention; even
  // a broken acquisition loop must remain observable to the test runner.
  const yieldToTimers = () => new Promise((resolve) => setImmediate(resolve));
  return {
    ...actual,
    rename: async (...args) => {
      const [, target] = args;
      if (churn.lockPath !== null && target === churn.lockPath) {
        await yieldToTimers();
        throw codedError('EEXIST', `EEXIST: file already exists, rename to '${target}'`);
      }
      return releaseFault.rename ? releaseFault.rename(actual, ...args) : actual.rename(...args);
    },
    stat: async (...args) => {
      const [target] = args;
      if (churn.lockPath !== null && target === churn.lockPath) {
        await yieldToTimers();
        churn.onMissing?.();
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
  releaseFault.rename = null;
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
    test_commands: { targeted_template: 'node --test {paths}', full: 'node --test' },
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
  it.each(['EPERM', 'EACCES', 'EBUSY'])('retries transient %s during release without orphaning the receipt lock', async (code) => {
    const dir = await scratch();
    const lockPath = path.join(dir, 'receipt-effects.lock');
    const options = { staleMs: 60_000, heartbeatMs: 5_000, busyMs: 1_000, serializeLocal: true, busyMessage: 'busy' };
    let failures = 0;
    releaseFault.rename = async (actual, source, target) => {
      if (source === lockPath && target.startsWith(`${lockPath}.release.`) && failures < 3) {
        failures += 1;
        throw Object.assign(new Error('transient release fault'), { code });
      }
      return actual.rename(source, target);
    };
    await withDirLock(lockPath, async () => 'first', options);
    expect(existsSync(lockPath), 'a completed holder must not leave its retiring lock behind').toBe(false);
    await expect(withDirLock(lockPath, async () => 'next', options)).resolves.toBe('next');
    expect(await readdir(dir)).toEqual([]);
  });

  it('rechecks ownership after a failed release rename before retrying', async () => {
    const dir = await scratch();
    const lockPath = path.join(dir, 'receipt-effects.lock');
    releaseFault.rename = async (actual, source, target) => {
      if (source === lockPath && target.startsWith(`${lockPath}.release.`)) {
        releaseFault.rename = null;
        await actual.rename(source, path.join(dir, 'retired'));
        await actual.mkdir(lockPath);
        await actual.writeFile(path.join(lockPath, 'owner'), 'successor');
        throw Object.assign(new Error('transient release fault'), { code: 'EPERM' });
      }
      return actual.rename(source, target);
    };
    await withDirLock(lockPath, async () => {}, {
      staleMs: 60_000, heartbeatMs: 5_000, busyMs: 1_000, busyMessage: 'busy',
    });
    expect(readFileSync(path.join(lockPath, 'owner'), 'utf8')).toBe('successor');
  });

  it('bounds persistent release denial and leaves the unverifiable lock intact', async () => {
    const dir = await scratch();
    const lockPath = path.join(dir, 'receipt-effects.lock');
    let attempts = 0;
    releaseFault.rename = async (actual, source, target) => {
      if (source === lockPath && target.startsWith(`${lockPath}.release.`)) {
        attempts += 1;
        throw Object.assign(new Error('persistent release denial'), { code: 'EPERM' });
      }
      return actual.rename(source, target);
    };
    await expect(withDirLock(lockPath, async () => 'done', {
      staleMs: 60_000, heartbeatMs: 5_000, busyMs: 20, busyMessage: 'busy',
    })).resolves.toBe('done');
    expect(attempts).toBeGreaterThan(1);
    expect(existsSync(path.join(lockPath, 'owner'))).toBe(true);
  }, 5_000);

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

  it('concurrent readers only observe complete published JSON while replacements are pending', async () => {
    const dir = await scratch();
    const file = path.join(dir, 'state.json');
    const versions = Array.from({ length: 13 }, (_, generation) => ({
      generation, payload: `${generation}:`.repeat(32 * 1024),
    }));
    const documents = versions.map((value) => `${JSON.stringify(value, null, 2)}\n`);
    await atomicWriteJson(file, versions[0]);
    let overlappingObservations = 0;
    for (let generation = 1; generation < versions.length; generation += 1) {
      const completeDocuments = new Set([documents[generation - 1], documents[generation]]);
      let watching = true;
      let publicationPending = false;
      let observations = 0;
      let observerError = null;
      let publicationError = null;
      let attempts = 0;
      releaseFault.rename = async (actual, temporary, destination) => {
        if (destination === file) attempts += 1;
        return actual.rename(temporary, destination);
      };
      const observer = (async () => {
        while (watching) {
          const overlapped = publicationPending;
          const bytes = await readFile(file, 'utf8');
          expect(completeDocuments.has(bytes), `reader observed a partial or unknown ${bytes.length}-byte document`).toBe(true);
          observations += 1;
          if (overlapped) overlappingObservations += 1;
          await sleep(1);
        }
      })().catch((error) => { observerError = error; });
      try {
        await waitFor(() => observations > 0 || observerError !== null);
        publicationPending = true;
        try { await atomicWriteJson(file, versions[generation]); }
        catch (error) { publicationError = error; }
        finally { publicationPending = false; }
      } finally {
        // Repeatedly opening readers can exhaust Windows' bounded rename
        // attempts too. Await every read handle closing before recovery.
        watching = false;
        await observer;
        releaseFault.rename = null;
      }
      expect(observerError).toBeNull();
      if (publicationError !== null) {
        expect(process.platform, 'only a native Windows sharing denial is permitted').toBe('win32');
        expect(publicationError).toMatchObject({
          code: expect.stringMatching(/^(?:EPERM|EACCES|EBUSY)$/u), syscall: 'rename', dest: file,
        });
        expect(attempts).toBe(11);
        expect(await readFile(file, 'utf8')).toBe(documents[generation - 1]);
        expect(await readdir(dir)).toEqual(['state.json']);
        // Recovery must publish this exact generation after the observer has
        // stopped; it cannot pass by accepting denial or dropped writes forever.
        await atomicWriteJson(file, versions[generation]);
      }
      expect(await readFile(file, 'utf8')).toBe(documents[generation]);
      expect(await readdir(dir)).toEqual(['state.json']);
    }
    expect(overlappingObservations).toBeGreaterThan(0);
  }, 30_000);

  // Pinned libuv uses MoveFileExW rather than POSIX replacement semantics.
  // An open destination can therefore deny all bounded rename attempts. That
  // denial must retain the old bytes and descriptor, not copy over or unlink
  // the target. A separate concurrent-publication test covers successful writes.
  it.runIf(process.platform === 'win32')('win32: the target path is never observable-absent under a concurrent open handle', async () => {
    const dir = await scratch();
    const file = path.join(dir, 'state.json');
    const original = { generation: 0, payload: 'original'.repeat(16 * 1024) };
    const replacement = { generation: 1, payload: 'replacement'.repeat(16 * 1024) };
    await atomicWriteJson(file, original);
    const originalBytes = await readFile(file, 'utf8');
    const reader = await open(file, 'r');
    let attempts = 0;
    releaseFault.rename = async (actual, temporary, destination) => {
      if (destination === file) attempts += 1;
      return actual.rename(temporary, destination);
    };
    let watching = true;
    let publicationPending = false;
    let overlappingObservations = 0;
    let observerError = null;
    const observer = (async () => {
      while (watching) {
        const overlapped = publicationPending;
        expect(await readFile(file, 'utf8')).toBe(originalBytes);
        if (overlapped) overlappingObservations += 1;
        await sleep(1);
      }
    })().catch((error) => { observerError = error; });
    try {
      const started = Date.now();
      publicationPending = true;
      try {
        await expect(atomicWriteJson(file, replacement)).rejects.toMatchObject({
          code: expect.stringMatching(/^(?:EPERM|EACCES|EBUSY)$/u), syscall: 'rename', dest: file,
        });
      } finally { publicationPending = false; }
      expect(attempts).toBe(11);
      expect(Date.now() - started).toBeLessThan(10_000);
      expect(await readFile(file, 'utf8')).toBe(originalBytes);
      expect(await reader.readFile('utf8')).toBe(originalBytes);
      expect(await readdir(dir)).toEqual(['state.json']);
    } finally {
      watching = false;
      await observer;
      releaseFault.rename = null;
      await reader.close();
    }
    expect(observerError).toBeNull();
    expect(overlappingObservations).toBeGreaterThan(0);
    // Closing the conflicting reader must restore real publication, not leave
    // a test that passes when every write is broken or silently ignored.
    await atomicWriteJson(file, replacement);
    expect(await readFile(file, 'utf8')).toBe(`${JSON.stringify(replacement, null, 2)}\n`);
    expect(await readdir(dir)).toEqual(['state.json']);
  }, 30_000);
});

describe('APE v2 shared dir lock: busyMs bounds the acquisition spin (invariant 7 timeout guarantee)', () => {
  afterEach(() => {
    // Disable churn interception between tests; the module mock reverts to a
    // transparent passthrough whenever churn.lockPath is null.
    churn.lockPath = null;
    churn.onMissing = null;
  });

  it('caps scheduler-inflated filesystem calibration while preserving the Windows floor', () => {
    expect(computeFsLatencyMultiplier(100_000, 'darwin')).toBe(8);
    expect(computeFsLatencyMultiplier(100_000, 'linux')).toBe(8);
    expect(computeFsLatencyMultiplier(1, 'win32')).toBe(6);
    expect(computeFsLatencyMultiplier(100_000, 'win32')).toBe(8);
  });

  // Drive the current staged-rename acquisition through EEXIST -> ENOENT.
  // Advancing the observed contention clock isolates the budget from cold
  // calibration and scheduler/filesystem latency outside the acquisition loop.
  it('rejects with busyMessage within the busyMs bound under rename->EEXIST / stat->ENOENT churn', async () => {
    const dir = await scratch();
    const lockPath = path.join(dir, 'churn.lock');
    const busyMs = 150;
    const busyMessage = 'lock acquisition timed out';
    const options = { staleMs: 10_000, heartbeatMs: 50, busyMs, busyMessage };
    const maximumBudget = busyMs * 8;
    const clockStep = busyMs;
    const started = Date.now();
    let now = started;
    let missingObservations = 0;
    const clock = vi.spyOn(Date, 'now').mockImplementation(() => now);
    const callback = vi.fn(async () => 'acquired');
    churn.lockPath = lockPath;
    churn.onMissing = () => {
      missingObservations += 1;
      now += clockStep;
      // A removed/bypassed loop deadline gets one observation beyond the
      // maximum budget, then fails explicitly instead of leaving a live spin.
      if (now - started > maximumBudget + clockStep) {
        throw new Error('churn crossed the maximum acquisition deadline');
      }
    };
    try {
      await expect(withDirLock(lockPath, callback, options)).rejects.toThrow(busyMessage);
      expect(callback).not.toHaveBeenCalled();
      expect(missingObservations).toBeGreaterThan(0);
      expect(now - started).toBeGreaterThan(busyMs);
      expect(now - started).toBeLessThanOrEqual(maximumBudget + clockStep);
      expect(await readdir(dir)).toEqual([]);
    } finally {
      churn.lockPath = null;
      churn.onMissing = null;
      clock.mockRestore();
    }
  }, 6_000);
});
