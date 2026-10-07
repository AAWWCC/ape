import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { invokeCodexHook } from './codex-native-test-helper.js';

// Independent public-API contract. Dynamic import deliberately occurs inside
// each test, so a missing implementation is a collected RED, not zero tests.
const load = () => import('../test-support/native-process.js');
const roots = [];
const owners = [];
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const options = { timeoutMs: 3000, killGraceMs: 150, cleanupMs: 2000, maxOutputBytes: 8192 };

async function waitUntil(predicate, ms) {
  const deadline = Date.now() + ms;
  while (!(await predicate())) {
    if (Date.now() >= deadline) throw new Error('fixture watchdog: observation deadline exceeded');
    await delay(20);
  }
}

async function bounded(promise, ms = 10000) {
  let timer;
  try {
    return await Promise.race([promise, new Promise((_, reject) => {
      timer = setTimeout(() => reject(Object.assign(new Error('fixture watchdog: helper did not settle'), {
        code: 'FIXTURE_WATCHDOG',
      })), ms);
    })]);
  } finally { clearTimeout(timer); }
}

async function alive(pid, { kill = process.kill, readStat = readFile, platform = process.platform } = {}) {
  try { kill(pid, 0); } catch (error) {
    if (error.code === 'ESRCH') return false;
    throw error;
  }
  // An orphan zombie cannot execute or retain pipes; Linux init may reap it
  // later. This observation never sends a signal or treats EPERM as absence.
  if (platform === 'linux') {
    try {
      const stat = await readStat(`/proc/${pid}/stat`, 'utf8');
      if (stat.slice(stat.lastIndexOf(')') + 2).startsWith('Z ')) return false;
    } catch (error) { if (error.code === 'ENOENT' || error.code === 'ESRCH') return false; throw error; }
  }
  return true;
}

async function pids(root) {
  return Promise.all((await readdir(root)).filter((name) => name.endsWith('.pid'))
    .map(async (name) => {
      const pid = Number(await readFile(path.join(root, name), 'utf8'));
      if (!Number.isSafeInteger(pid) || pid <= 1) throw new Error(`Invalid fixture PID in ${name}`);
      return pid;
    }));
}

async function retired(root, minimum = 1) {
  const ids = await pids(root);
  expect(ids.length, 'fixture must have actually started').toBeGreaterThanOrEqual(minimum);
  for (const pid of ids) expect(await alive(pid), `owned PID ${pid} survived settlement`).toBe(false);
}

async function ready(root) {
  await waitUntil(async () => {
    try { return await readFile(path.join(root, 'ready'), 'utf8') === 'yes'; }
    catch (error) { if (error.code === 'ENOENT') return false; throw error; }
  }, 2500);
}

async function fixture(source) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'ape-native-supervision-'));
  roots.push(root);
  await mkdir(path.join(root, 'bin'));
  await writeFile(path.join(root, 'bin', 'ape-hook.mjs'), `
    import { writeFileSync } from 'node:fs';
    writeFileSync('command.pid', String(process.pid));
    ${source}
  `);
  return root;
}

function invoke(runNativeJson, root, overrides = {}) {
  return runNativeJson(process.execPath, [path.join(root, 'bin', 'ape-hook.mjs')], {
    ...options, cwd: root, env: { ...process.env }, input: '{}\n', ...overrides,
  });
}

async function failure(promise, pattern) {
  const start = Date.now();
  const result = await bounded(promise.then((value) => ({ value }), (error) => ({ error })));
  expect(Date.now() - start).toBeLessThan(10000);
  expect(result.error).toBeInstanceOf(Error);
  expect(result.error.code).not.toBe('FIXTURE_WATCHDOG');
  expect(result.error.message).toMatch(pattern);
  expect(Buffer.byteLength(result.error.message)).toBeLessThanOrEqual(20000);
  return result.error;
}

afterEach(async () => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  // Assertions above run BEFORE this independently awaited emergency safety
  // net. A leak cannot pass just because afterEach killed it.
  for (const owner of owners.splice(0)) {
    if (owner.exitCode === null && owner.signalCode === null) {
      const exit = new Promise((resolve) => owner.once('exit', resolve));
      owner.kill('SIGKILL');
      await bounded(exit, 5000);
    }
  }
  for (const root of roots.splice(0)) {
    const ids = await pids(root);
    for (const pid of ids) {
      if (await alive(pid)) { try { process.kill(pid, 'SIGKILL'); } catch (e) { if (e.code !== 'ESRCH') throw e; } }
    }
    await waitUntil(async () => !(await Promise.all(ids.map((pid) => alive(pid)))).some(Boolean), 5000);
    await rm(root, { recursive: true, force: true });
  }
});

describe('fixture process liveness observation', () => {
  const pid = 43210;
  const fault = (code) => Object.assign(new Error(`injected ${code}`), { code });

  function observation({ stat = `${pid} (fixture child) S 1 2 3`, readError, signalError } = {}) {
    const calls = [];
    return {
      calls,
      platform: 'linux',
      kill: (observedPid, signal) => {
        calls.push(['signal', observedPid, signal]);
        if (signalError) throw signalError;
      },
      readStat: async (filename, encoding) => {
        calls.push(['read', filename, encoding]);
        if (readError) throw readError;
        return stat;
      },
    };
  }

  const successfulSignalThenRead = [
    ['signal', pid, 0], ['read', `/proc/${pid}/stat`, 'utf8'],
  ];

  it.each(['ENOENT', 'ESRCH'])('observes disappearance on procfs %s after successful signal-0', async (code) => {
    const dependencies = observation({ readError: fault(code) });
    expect(await alive(pid, dependencies)).toBe(false);
    expect(dependencies.calls).toEqual(successfulSignalThenRead);
  });

  it.each([['S', true], ['R', true], ['Z', false]])('observes process state %s as alive=%s', async (state, expected) => {
    const dependencies = observation({ stat: `${pid} (fixture (child)) ${state} 1 2 3` });
    expect(await alive(pid, dependencies)).toBe(expected);
    expect(dependencies.calls).toEqual(successfulSignalThenRead);
  });

  it('observes signal ESRCH without attempting procfs', async () => {
    const dependencies = observation({ signalError: fault('ESRCH') });
    expect(await alive(pid, dependencies)).toBe(false);
    expect(dependencies.calls).toEqual([['signal', pid, 0]]);
  });

  it.each(['EACCES', 'EPERM', 'EIO'])('propagates procfs %s rather than hiding a possible survivor', async (code) => {
    const error = fault(code);
    const dependencies = observation({ readError: error });
    await expect(alive(pid, dependencies)).rejects.toBe(error);
    expect(dependencies.calls).toEqual(successfulSignalThenRead);
  });

  it.each(['EACCES', 'EPERM', 'EIO', 'ENOENT'])('propagates signal %s without attempting procfs', async (code) => {
    const error = fault(code);
    const dependencies = observation({ signalError: error });
    await expect(alive(pid, dependencies)).rejects.toBe(error);
    expect(dependencies.calls).toEqual([['signal', pid, 0]]);
  });

  it('does not consult procfs on platforms without Linux procfs', async () => {
    const dependencies = { ...observation({ readError: fault('EIO') }), platform: 'darwin' };
    expect(await alive(pid, dependencies)).toBe(true);
    expect(dependencies.calls).toEqual([['signal', pid, 0]]);
  });
});

describe('retireChild ownership and lifecycle races', () => {
  const limits = { killGraceMs: 100, cleanupMs: 200 };

  function controlled(pid = 12345) {
    vi.useFakeTimers();
    const child = new EventEmitter();
    Object.assign(child, { pid, exitCode: null, signalCode: null, kill: vi.fn(() => true) });
    const callerListeners = {};
    for (const event of ['spawn', 'exit', 'error']) {
      child.on(event, vi.fn());
      callerListeners[event] = child.listeners(event);
    }
    const exited = () => {
      child.signalCode = 'SIGTERM';
      child.emit('exit', null, 'SIGTERM');
    };
    const released = () => {
      expect(vi.getTimerCount()).toBe(0);
      for (const event of Object.keys(callerListeners)) {
        expect(child.listeners(event)).toEqual(callerListeners[event]);
      }
    };
    const lateEvents = async () => {
      const signals = child.kill.mock.calls.slice();
      child.emit('spawn');
      child.emit('exit', 0, null);
      child.emit('error', new Error('late caller-owned error'));
      child.emit('close', 0, null);
      await vi.advanceTimersByTimeAsync(1000);
      expect(child.kill.mock.calls).toEqual(signals);
      released();
    };
    return { child, exited, released, lateEvents };
  }

  it.each(['exitCode', 'signalCode'])('does not signal or retain resources for an already exited %s', async (key) => {
    const { retireChild } = await load();
    const f = controlled();
    f.child[key] = key === 'exitCode' ? 0 : 'SIGKILL';
    await retireChild(f.child, 'SIGTERM', limits);
    expect(f.child.kill).not.toHaveBeenCalled();
    f.released();
    await f.lateEvents();
  });

  it('bounds missing spawn events without ever signalling an absent handle', async () => {
    const { retireChild } = await load();
    const f = controlled(null);
    const completion = vi.fn();
    const pending = retireChild(f.child, 'SIGTERM', limits).then(
      () => completion('resolved'), (error) => { completion('rejected'); return error; },
    );
    await vi.advanceTimersByTimeAsync(299);
    expect(completion).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect((await pending).message).toMatch(/cleanup.*confirm exit/i);
    expect(completion.mock.calls).toEqual([['rejected']]);
    expect(f.child.kill).not.toHaveBeenCalled();
    f.released();
    await f.lateEvents();
  });

  it('signals deferred spawn exactly once despite repeated spawn events', async () => {
    const { retireChild } = await load();
    const f = controlled(null);
    const pending = retireChild(f.child, 'SIGTERM', limits);
    expect(f.child.kill).not.toHaveBeenCalled();
    f.child.pid = 12345;
    f.child.emit('spawn');
    f.child.emit('spawn');
    expect(f.child.kill.mock.calls).toEqual([['SIGTERM']]);
    f.exited();
    await pending;
    f.released();
  });

  it.each([undefined, null, 0, 1, -1, NaN, 1.5])('never signals an invalid PID %s when spawn fails', async (pid) => {
    const { retireChild } = await load();
    const f = controlled(null);
    f.child.pid = pid;
    const fault = new Error('spawn fixture ENOENT');
    const pending = retireChild(f.child, 'SIGTERM', limits).catch((error) => error);
    await vi.advanceTimersByTimeAsync(100);
    expect(f.child.kill).not.toHaveBeenCalled();
    f.child.emit('error', fault);
    expect(await pending).toBe(fault);
    f.released();
    await f.lateEvents();
  });

  it('clears timers when kill synchronously emits exit and repeats without accumulation', async () => {
    const { retireChild } = await load();
    const f = controlled();
    f.child.kill.mockImplementation(() => { f.exited(); return true; });
    for (let index = 0; index < 4; index++) {
      f.child.signalCode = null;
      await retireChild(f.child, 'SIGTERM', limits);
      expect(f.child.kill).toHaveBeenCalledTimes(index + 1);
      f.released();
    }
    await f.lateEvents();
  });

  it('escalates TERM to KILL but waits for confirmed exit', async () => {
    const { retireChild } = await load();
    const f = controlled();
    const completion = vi.fn();
    const pending = retireChild(f.child, 'SIGTERM', limits).then(completion);
    expect(f.child.kill.mock.calls).toEqual([['SIGTERM']]);
    await vi.advanceTimersByTimeAsync(99);
    expect(f.child.kill).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(f.child.kill.mock.calls).toEqual([['SIGTERM'], ['SIGKILL']]);
    expect(completion).not.toHaveBeenCalled();
    f.exited();
    await pending;
    expect(completion).toHaveBeenCalledTimes(1);
    f.released();
    await f.lateEvents();
  });

  it('initial SIGKILL has only the cleanup deadline and does not signal again', async () => {
    const { retireChild } = await load();
    const f = controlled();
    const pending = retireChild(f.child, 'SIGKILL', limits).catch((error) => error);
    expect(vi.getTimerCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(200);
    expect((await pending).message).toMatch(/cleanup.*confirm exit/i);
    expect(f.child.kill.mock.calls).toEqual([['SIGKILL']]);
    f.released();
    await f.lateEvents();
  });

  it('accepts actual exit after a live-handle error while a sibling keeps its own retirement timers', async () => {
    const { retireChild } = await load();
    const first = controlled();
    const sibling = controlled(12346);
    const firstPending = retireChild(first.child, 'SIGTERM', limits);
    const siblingCompletion = vi.fn();
    const siblingPending = retireChild(sibling.child, 'SIGTERM', limits).then(siblingCompletion);
    first.child.emit('error', new Error('fixture signal failed'));
    first.exited();
    await firstPending;
    expect(vi.getTimerCount()).toBe(2);
    for (const event of ['spawn', 'exit', 'error']) expect(first.child.listenerCount(event)).toBe(1);
    await vi.advanceTimersByTimeAsync(100);
    expect(first.child.kill.mock.calls).toEqual([['SIGTERM']]);
    expect(sibling.child.kill.mock.calls).toEqual([['SIGTERM'], ['SIGKILL']]);
    expect(siblingCompletion).not.toHaveBeenCalled();
    sibling.exited();
    await siblingPending;
    first.released();
    sibling.released();
    await first.lateEvents();
    await sibling.lateEvents();
  });

  it.each(['false', 'throw', 'error', 'true'])('does not confuse kill %s with exit confirmation', async (mode) => {
    const { retireChild } = await load();
    const f = controlled();
    f.child.kill.mockImplementation(() => {
      if (mode === 'throw') throw new Error('fixture EPERM');
      if (mode === 'error') f.child.emit('error', new Error('fixture EPERM'));
      return mode !== 'false';
    });
    for (let index = 0; index < 3; index++) {
      const completion = vi.fn();
      const pending = retireChild(f.child, 'SIGTERM', limits).then(
        () => { completion('resolved'); }, (error) => { completion('rejected'); return error; },
      );
      await vi.advanceTimersByTimeAsync(299);
      expect(completion).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      const error = await pending;
      expect(error).toBeInstanceOf(Error);
      expect(error.message).toMatch(/cleanup.*confirm exit/i);
      if (mode === 'throw' || mode === 'error') expect(error.message).toContain('fixture EPERM');
      expect(completion.mock.calls).toEqual([['rejected']]);
      expect(f.child.kill).toHaveBeenCalledTimes((index + 1) * 2);
      f.released();
    }
    await f.lateEvents();
  });

  it.each([299, 300])('cleans up once when exit arrives at %s ms around the deadline', async (exitAt) => {
    const { retireChild } = await load();
    const f = controlled();
    const completion = vi.fn();
    const pending = retireChild(f.child, 'SIGTERM', limits).then(
      () => completion('resolved'), () => completion('rejected'),
    );
    await vi.advanceTimersByTimeAsync(exitAt);
    f.exited();
    await pending;
    expect(completion.mock.calls).toEqual([[exitAt < 300 ? 'resolved' : 'rejected']]);
    f.released();
    await f.lateEvents();
  });
});

describe('runNativeJson bounded process supervision', () => {
  it('decodes multibyte JSON split across output chunks and forwards exact stdin and environment', async () => {
    const { runNativeJson } = await load();
    const root = await fixture(`
      let input = ''; for await (const chunk of process.stdin) input += chunk;
      const bytes = Buffer.from(JSON.stringify({ input, text: '🦍 café', token: process.env.FIXTURE_TOKEN }));
      for (const byte of bytes) { process.stdout.write(Buffer.from([byte])); await new Promise(r => setTimeout(r, 1)); }
    `);
    expect(await bounded(invoke(runNativeJson, root, {
      input: '{"value":42}\n', env: { ...process.env, FIXTURE_TOKEN: 'complete-env' },
    }))).toEqual({ input: '{"value":42}\n', text: '🦍 café', token: 'complete-env' });
    await retired(root);
  });

  it.each([
    ['empty output', '', /json|empty|parse/i],
    ['malformed JSON', `process.stdout.write('not-json');`, /json|parse/i],
    ['truncated JSON', `process.stdout.write('{"unfinished":');`, /json|parse/i],
    ['truncated UTF-8 JSON', `process.stdout.write(Buffer.from([123,34,120,34,58,34,0xf0,0x9f]));`, /json|utf|parse/i],
    ['nonzero without stderr', 'process.exit(23);', /23/],
    ['nonzero with stderr', `process.stderr.write('fixture-exit-detail'); process.exitCode = 24;`, /24|fixture-exit-detail/],
  ])('rejects %s with bounded diagnostics', async (_, source, pattern) => {
    const { runNativeJson } = await load();
    const root = await fixture(source);
    await failure(invoke(runNativeJson, root), pattern);
    await retired(root);
  });

  it.each(['stdout', 'stderr', 'combined'])('rejects %s overflow, including a single oversized chunk', async (stream) => {
    const { runNativeJson } = await load();
    const source = stream === 'combined'
      ? `process.stdout.write('x'.repeat(5000)); process.stderr.write('y'.repeat(5000));`
      : `process.${stream}.write('x'.repeat(1024 * 1024));`;
    const root = await fixture(`${source} setInterval(() => {}, 1000);`);
    await failure(invoke(runNativeJson, root), /output|overflow|limit/i);
    await retired(root);
  });

  it('catches overflow arriving during final output drain', async () => {
    const { runNativeJson } = await load();
    const root = await fixture(`process.stdout.write('{}'); process.stderr.end('z'.repeat(10000));`);
    await failure(invoke(runNativeJson, root), /output|overflow|limit/i);
    await retired(root);
  });

  it('rejects a never-ending child and confirms retirement', async () => {
    const { runNativeJson } = await load();
    const root = await fixture(`setInterval(() => {}, 1000);`);
    await failure(invoke(runNativeJson, root), /timeout|timed.out|deadline/i);
    await retired(root);
  });

  it.skipIf(process.platform === 'win32')('escalates only after a ready child ignores graceful termination', async () => {
    const { runNativeJson } = await load();
    const root = await fixture(`
      process.on('SIGTERM', () => writeFileSync('term-seen', 'yes'));
      writeFileSync('ready', 'yes'); setInterval(() => {}, 1000);
    `);
    const completion = failure(invoke(runNativeJson, root), /timeout|timed.out|deadline/i);
    await Promise.all([ready(root), completion]);
    expect(await readFile(path.join(root, 'term-seen'), 'utf8')).toBe('yes');
    await retired(root);
  });

  it.skipIf(process.platform === 'win32')('reports signal exit actionably', async () => {
    const { runNativeJson } = await load();
    const root = await fixture(`process.kill(process.pid, 'SIGTERM');`);
    await failure(invoke(runNativeJson, root), /SIGTERM|signal/i);
    await retired(root);
  });

  it.skipIf(process.platform === 'win32')('allows a ready cooperative child to finish graceful shutdown before settlement', async () => {
    const { runNativeJson } = await load();
    const root = await fixture(`
      process.on('SIGTERM', () => setTimeout(() => {
        writeFileSync('graceful-finished', 'yes'); process.exit(0);
      }, 50));
      writeFileSync('ready', 'yes'); setInterval(() => {}, 1000);
    `);
    const completion = failure(invoke(runNativeJson, root, { killGraceMs: 500 }), /timeout|timed.out|deadline/i);
    await Promise.all([ready(root), completion]);
    expect(await readFile(path.join(root, 'graceful-finished'), 'utf8')).toBe('yes');
    await retired(root);
  });

  it('rejects ENOENT and invalid cwd without waiting for an exit event', async () => {
    const { runNativeJson } = await load();
    const root = await fixture('');
    await failure(runNativeJson(path.join(root, 'missing-executable'), [], { ...options, cwd: root }), /spawn|ENOENT|not.found/i);
    await failure(invoke(runNativeJson, root, { cwd: path.join(root, 'missing-dir') }), /spawn|ENOENT|cwd|directory/i);
  });

  it('returns a rejected promise for an invalid spawn command', async () => {
    const { runNativeJson } = await load();
    // A synchronous spawn exception must become a promise rejection too.
    // Deliberately do not wrap the call in Promise.resolve().then(...).
    const completion = runNativeJson(null, [], { ...options });
    expect(typeof completion?.then).toBe('function');
    await failure(completion, /command|file|argument|type|spawn/i);
  });

  it('handles a closed stdin racing an unsuccessful exit without unhandled EPIPE', async () => {
    const { runNativeJson } = await load();
    const root = await fixture(`process.stdin.destroy(); process.exit(29);`);
    await failure(invoke(runNativeJson, root, { input: 'x'.repeat(4 * 1024 * 1024) }), /stdin|EPIPE|29|write|stream/i);
    await retired(root);
  });

  it.each(['timeoutMs', 'killGraceMs', 'cleanupMs', 'maxOutputBytes'])('validates %s before starting a child', async (key) => {
    const { runNativeJson } = await load();
    const root = await fixture(`process.stdout.write('{}');`);
    for (const value of [0, -1, NaN, Infinity, 2 ** 40]) {
      await failure(Promise.resolve().then(() => invoke(runNativeJson, root, { [key]: value })), new RegExp(key, 'i'));
    }
    expect(await pids(root)).toEqual([]);
  });

  it.each(['success', 'timeout', 'overflow'])('retires a resistant pipe-holding descendant after %s (including parent-first exit)', async (outcome) => {
    const { runNativeJson } = await load();
    const root = await fixture(`
      const { spawn } = await import('node:child_process');
      const descendant = spawn(process.execPath, ['-e', ${JSON.stringify(`
        const fs = require('node:fs');
        process.on('SIGTERM', () => {});
        fs.writeFileSync('descendant.pid', String(process.pid));
        process.send('ready'); setInterval(() => {}, 1000);
      `)}], { stdio: ['ignore', 'inherit', 'inherit', 'ipc'] });
      await new Promise((resolve, reject) => { descendant.once('message', resolve); descendant.once('error', reject); });
      descendant.disconnect(); descendant.unref();
      ${outcome === 'success' ? `process.stdout.write('{"ok":true}');` : outcome === 'overflow' ? `process.stdout.write('x'.repeat(10000));` : `setInterval(() => {}, 1000);`}
    `);
    if (outcome === 'success') expect(await bounded(invoke(runNativeJson, root))).toEqual({ ok: true });
    else await failure(invoke(runNativeJson, root), outcome === 'timeout' ? /timeout|timed.out|deadline/i : /output|overflow|limit/i);
    await retired(root, 2);
  });

  it('isolates simultaneous launches and repeated successful/failing calls', async () => {
    const { runNativeJson } = await load();
    const good = await fixture(`await new Promise(r => setTimeout(r, 100)); process.stdout.write('{"ok":true}');`);
    const bad = await fixture(`process.stderr.write('x'.repeat(10000)); setInterval(() => {}, 1000);`);
    const listeners = ['uncaughtException', 'unhandledRejection', 'exit'].map((event) => process.listenerCount(event));
    for (let index = 0; index < 4; index++) {
      const [value] = await Promise.all([bounded(invoke(runNativeJson, good)), failure(invoke(runNativeJson, bad), /output|overflow|limit/i)]);
      expect(value).toEqual({ ok: true });
      await retired(good); await retired(bad);
    }
    expect(['uncaughtException', 'unhandledRejection', 'exit'].map((event) => process.listenerCount(event))).toEqual(listeners);
  }, 45000);

  it('retires owned descendants if the invoking harness exits abruptly', async () => {
    await load();
    const root = await fixture(`
      const { spawn } = await import('node:child_process');
      const child = spawn(process.execPath, ['-e', ${JSON.stringify(`
        const fs = require('node:fs'); process.on('SIGTERM', () => {});
        fs.writeFileSync('descendant.pid', String(process.pid)); process.send('ready');
        setInterval(() => {}, 1000);
      `)}], { stdio: ['ignore', 'inherit', 'inherit', 'ipc'] });
      await new Promise(r => child.once('message', r));
      writeFileSync('ready', 'yes'); setInterval(() => {}, 1000);
    `);
    const implementation = new URL('../test-support/native-process.js', import.meta.url).href;
    const owner = spawn(process.execPath, ['--input-type=module', '-e', `
      import { runNativeJson } from ${JSON.stringify(implementation)};
      runNativeJson(process.execPath, [${JSON.stringify(path.join(root, 'bin', 'ape-hook.mjs'))}], {
        cwd: ${JSON.stringify(root)}, env: process.env, input: '{}\\n', timeoutMs: 60000,
        killGraceMs: 150, cleanupMs: 2000, maxOutputBytes: 8192,
      }).catch(() => {});
    `], { stdio: 'ignore' });
    owners.push(owner);
    await waitUntil(async () => {
      try { await readFile(path.join(root, 'ready')); return true; } catch (e) { if (e.code !== 'ENOENT') throw e; }
      if (owner.exitCode !== null || owner.signalCode !== null) throw new Error('owner exited before fixture readiness');
      return false;
    }, 10000);
    const exit = new Promise((resolve) => owner.once('exit', resolve));
    owner.kill('SIGKILL'); await bounded(exit);
    // There is no helper promise after owner death: give its lifeline a bounded
    // retirement budget, then observe independently before emergency teardown.
    await waitUntil(async () => !(await Promise.all((await pids(root)).map((pid) => alive(pid)))).some(Boolean), 7000);
    await retired(root, 2);
  }, 30000);
});

describe('invokeCodexHook compatibility', () => {
  it('preserves root, argument order, JSON newline input and exactly the four exclusions', async () => {
    const root = await fixture(`
      let input = ''; for await (const chunk of process.stdin) input += chunk;
      process.stdout.write(JSON.stringify({ executable: process.execPath, cwd: process.cwd(), args: process.argv.slice(2), input,
        excluded: ['CLAUDECODE', 'CLAUDE_CODE', 'CLAUDE_PROJECT_DIR', 'CODEX_CWD'].filter(k => k in process.env),
        preserved: process.env.APE_FIXTURE_PRESERVED }));
    `);
    for (const key of ['CLAUDECODE', 'CLAUDE_CODE', 'CLAUDE_PROJECT_DIR', 'CODEX_CWD']) vi.stubEnv(key, 'must-not-leak');
    vi.stubEnv('APE_FIXTURE_PRESERVED', 'keep');
    expect(await bounded(invokeCodexHook(root, { hello: '世界' }, ['--one', 'two words']))).toEqual({
      executable: process.execPath,
      cwd: await import('node:fs/promises').then(({ realpath }) => realpath(root)),
      args: ['--one', 'two words'], input: '{"hello":"世界"}\n', excluded: [], preserved: 'keep',
    });
    await retired(root);
  });

  it('rejects malformed hook output through the returned promise', async () => {
    const root = await fixture(`process.stdout.write('{');`);
    await failure(invokeCodexHook(root, {}), /json|parse/i);
    await retired(root);
  });

  it('rejects unserializable input through the promise without starting a hook', async () => {
    const root = await fixture(`process.stdout.write('{}');`);
    const input = {}; input.circular = input;
    await failure(invokeCodexHook(root, input), /circular|serializ|json/i);
    expect(await pids(root)).toEqual([]);
  });
});
