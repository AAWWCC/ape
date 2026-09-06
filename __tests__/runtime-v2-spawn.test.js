import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { GATE_RUNNER_SENTINEL } from '../lib/runtime/runner.js';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { spawnWithTimeout } from '../lib/runtime/spawn.js';

// Audit (runner.js:178): a single SIGTERM with resolve-only-on-'close' hangs
// forever on a SIGTERM-trapping suite or a pipe-holding grandchild, starving
// every lever behind the receipt-effects lock. These tests drive the shared
// spawn helper's liveness guarantees directly: tree kill with escalation,
// the bounded post-exit drain window, and settle-instead-of-reject spawn
// failures.

const cleanups = [];
afterEach(async () => {
  // maxRetries rides out the brief win32 lag between a killed process tree
  // releasing its handles and the fixture directory becoming removable.
  await Promise.all(cleanups.splice(0).map((dir) =>
    rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })));
});

async function fixtureDir() {
  const dir = await mkdtemp(path.join(tmpdir(), 'ape-spawn-'));
  cleanups.push(dir);
  return dir;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fileSize(file) {
  try {
    return (await stat(file)).size;
  } catch {
    return 0;
  }
}

// Grandchild: heartbeats to a file so the test can prove it died with the
// tree instead of orphaning.
const GRAND = [
  "import { appendFileSync } from 'node:fs';",
  "setInterval(() => { appendFileSync(process.argv[2], 'beat\\n'); }, 25);",
  '',
].join('\n');

// Child: traps SIGTERM (a suite that ignores the polite kill) and fans out
// the heartbeating grandchild into the same process group.
const CHILD = [
  "import { spawn } from 'node:child_process';",
  'process.on(\'SIGTERM\', () => {});',
  "spawn(process.execPath, [process.argv[2], process.argv[3]], { stdio: 'ignore' });",
  'setInterval(() => {}, 1000);',
  '',
].join('\n');

async function treeFixture() {
  const dir = await fixtureDir();
  const beat = path.join(dir, 'beats.log');
  await writeFile(path.join(dir, 'grand.mjs'), GRAND);
  await writeFile(path.join(dir, 'child.mjs'), CHILD);
  return { dir, beat };
}

async function expectTreeDead(beat) {
  // Settle any in-flight writes, then require the heartbeat to have stopped.
  await sleep(150);
  const size = await fileSize(beat);
  expect(size).toBeGreaterThan(0);
  await sleep(400);
  expect(await fileSize(beat)).toBe(size);
}

describe.skipIf(process.platform === 'win32')('timeout tree kill (POSIX process group)', () => {
  it('SIGTERM-trapping child and its grandchild both die; the promise settles marked timed_out', async () => {
    const { dir, beat } = await treeFixture();
    const startedAt = Date.now();
    const result = await spawnWithTimeout(
      process.execPath,
      [path.join(dir, 'child.mjs'), path.join(dir, 'grand.mjs'), beat],
      { cwd: dir, timeout_ms: 1_500, kill_grace_ms: 400, drain_ms: 500 },
    );
    expect(Date.now() - startedAt).toBeLessThan(8_000);
    expect(result.timed_out).toBe(true);
    expect(result.spawn_error).toBe(null);
    // The trap ate the group SIGTERM, so only the SIGKILL escalation ends the
    // child: signal death, no exit code.
    expect(result.exit_code).toBe(null);
    expect(result.signal).toBe('SIGKILL');
    await expectTreeDead(beat);
  }, 15_000);
});

// D1: win32 first-class parity — the same tree-death guarantee via
// taskkill /T /F. Executes only on Windows shards; skips cleanly elsewhere.
describe.skipIf(process.platform !== 'win32')('timeout tree kill (win32 taskkill)', () => {
  it('taskkill /T /F ends the child and its heartbeating grandchild; the promise settles marked timed_out', async () => {
    const { dir, beat } = await treeFixture();
    const startedAt = Date.now();
    const result = await spawnWithTimeout(
      process.execPath,
      [path.join(dir, 'child.mjs'), path.join(dir, 'grand.mjs'), beat],
      { cwd: dir, timeout_ms: 1_500, kill_grace_ms: 400, drain_ms: 500 },
    );
    expect(Date.now() - startedAt).toBeLessThan(10_000);
    expect(result.timed_out).toBe(true);
    expect(result.spawn_error).toBe(null);
    await expectTreeDead(beat);
  }, 20_000);
});

describe('post-exit stdio drain window', () => {
  it('a grandchild holding the stdio pipes cannot park the promise after the child exited', async () => {
    const dir = await fixtureDir();
    // The grandchild inherits our pipe fds and sleeps far past the drain
    // window; detached+unref so nothing but the pipes ties it to us. The old
    // resolve-only-on-'close' pattern hung here for the grandchild's whole
    // lifetime.
    await writeFile(path.join(dir, 'holder.mjs'), [
      "import { spawn } from 'node:child_process';",
      "import { tmpdir } from 'node:os';",
      // The grandchild must hold the inherited stdio PIPES (what this test
      // exercises), but it is given a cwd OUTSIDE the fixture: if it also
      // inherited the fixture as its working directory, win32 could not remove
      // that dir in afterEach while the grandchild sleeps.
      "spawn(process.execPath, ['-e', 'setTimeout(() => {}, 10_000)'], { stdio: 'inherit', detached: true, cwd: tmpdir() }).unref();",
      "process.stdout.write('held\\n', () => process.exit(0));",
      '',
    ].join('\n'));
    const startedAt = Date.now();
    const result = await spawnWithTimeout(process.execPath, [path.join(dir, 'holder.mjs')], {
      cwd: dir,
      timeout_ms: 30_000,
      drain_ms: 500,
    });
    expect(Date.now() - startedAt).toBeLessThan(8_000);
    expect(result.exit_code).toBe(0);
    expect(result.timed_out).toBe(false);
    expect(result.spawn_error).toBe(null);
    // Output that arrived before the drain deadline is retained.
    expect(result.combined).toContain('held');
  }, 15_000);
});

describe('settle-instead-of-reject failure modes', () => {
  it('reports a nonexistent command as spawn_error on a resolved result', async () => {
    const dir = await fixtureDir();
    const result = await spawnWithTimeout(path.join(dir, 'no-such-binary-xyz'), [], {
      cwd: dir,
      timeout_ms: 5_000,
    });
    expect(result.spawn_error).toBeTruthy();
    expect(result.exit_code).toBe(null);
    expect(result.timed_out).toBe(false);
  });
});

describe('collection modes', () => {
  it('separate collection keeps stdout and stderr apart for parsers', async () => {
    const result = await spawnWithTimeout(
      process.execPath,
      ['-e', 'console.log("out-marker"); console.error("err-marker");'],
      { timeout_ms: 15_000, collect: 'separate' },
    );
    expect(result.exit_code).toBe(0);
    expect(result.stdout).toContain('out-marker');
    expect(result.stdout).not.toContain('err-marker');
    expect(result.stderr).toContain('err-marker');
  });

  it('merges a provided env over the inherited process env instead of replacing it', async () => {
    const result = await spawnWithTimeout(
      process.execPath,
      ['-e', 'console.log(process.env.APE_SPAWN_PROBE + ":" + (process.env.PATH || process.env.Path ? "inherited" : "lost"))'],
      { timeout_ms: 15_000, env: { APE_SPAWN_PROBE: 'probe-value' } },
    );
    expect(result.combined).toContain('probe-value:inherited');
  });
});


describe.skipIf(process.platform === 'win32')('nested gate suite cleanup', () => {
  it('cleans remaining descendants before publishing a normally exited suite result', async () => {
    const dir = await fixtureDir();
    const marker = path.join(dir, 'exited');
    const beats = path.join(dir, 'beats');
    const pidFile = path.join(dir, 'grand.pid');
    const artifact = path.join(dir, 'artifact.json');
    const jobFile = path.join(dir, 'job.json');
    await writeFile(path.join(dir, 'grand.mjs'), `
      import { appendFileSync } from 'node:fs';
      process.on('SIGTERM', () => {});
      appendFileSync(process.argv[2], 'beat\\n');
      setInterval(() => appendFileSync(process.argv[2], 'beat\\n'), 20);
    `);
    await writeFile(path.join(dir, 'suite.mjs'), `
      import { spawn } from 'node:child_process';
      import { existsSync, writeFileSync } from 'node:fs';
      if (typeof process.send !== 'undefined') process.exit(91);
      const grand = spawn(process.execPath, ['grand.mjs', process.argv[3]], { stdio: 'inherit' });
      writeFileSync(process.argv[4], String(grand.pid));
      setInterval(() => {
        if (existsSync(process.argv[3])) {
          writeFileSync(process.argv[2], 'exited');
          process.exit(0);
        }
      }, 20);
    `);
    await writeFile(jobFile, JSON.stringify({ project_dir: dir,
      artifact_file: artifact, timeout_ms: 60000,
      plan: { command: process.execPath, args: ['suite.mjs', marker, beats, pidFile] },
    }));
    const runner = spawn(process.execPath, [fileURLToPath(new URL('../lib/runtime/runner.js', import.meta.url)), GATE_RUNNER_SENTINEL], {
      cwd: dir, env: { ...process.env, APE_GATE_RUNNER_JOB: jobFile }, detached: true, stdio: 'ignore',
    });
    const exited = new Promise((resolve) => runner.once('exit', resolve));
    let grandPid = null;
    try {
      for (let attempt = 0; attempt < 100 && await fileSize(marker) === 0; attempt += 1) await sleep(20);
      expect(await fileSize(marker)).toBeGreaterThan(0);
      grandPid = Number(await readFile(pidFile, 'utf8'));
      await exited;
      const result = JSON.parse(await readFile(artifact, 'utf8'));
      expect(result.verification.exit_code).toBe(0);
      expect(result.verification.aborted).toBeUndefined();
      expect(result.passed).toBe(true);
      await expectTreeDead(beats);
    } finally {
      if (runner.exitCode === null && runner.signalCode === null) runner.kill('SIGTERM');
      const before = await fileSize(beats);
      await sleep(60);
      if (grandPid && await fileSize(beats) > before) {
        try { process.kill(grandPid, 'SIGKILL'); } catch { /* fixture already exited */ }
      }
    }
  }, 15000);

  it.each(['timeout', 'cancel', 'runner-crash'])('stops suite descendants on gate %s', async (mode) => {
    const dir = await fixtureDir();
    const marker = path.join(dir, 'marker');
    const pidFile = path.join(dir, 'grand.pid');
    const artifact = path.join(dir, 'artifact.json');
    const heartbeat = path.join(dir, 'heartbeat.json');
    await writeFile(path.join(dir, 'grand.mjs'), `
      import { appendFileSync } from 'node:fs';
      process.on('SIGTERM', () => {});
      setInterval(() => appendFileSync(process.argv[2], 'beat\\n'), 20);
    `);
    await writeFile(path.join(dir, 'suite.mjs'), `
      import { spawn } from 'node:child_process';
      import { writeFileSync } from 'node:fs';
      const grand = spawn(process.execPath, ['grand.mjs', process.argv[2]], { stdio: 'inherit' });
      writeFileSync(process.argv[3], String(grand.pid));
      setInterval(() => {}, 1000);
    `);
    const jobFile = path.join(dir, 'job.json');
    await writeFile(jobFile, JSON.stringify({ project_dir: dir,
      heartbeat_file: heartbeat, artifact_file: artifact,
      timeout_ms: mode === 'timeout' ? 1500 : 60000, heartbeat_ms: 50,
      plan: { command: process.execPath, args: ['suite.mjs', marker, pidFile] },
    }));
    const runner = spawn(process.execPath, [fileURLToPath(new URL('../lib/runtime/runner.js', import.meta.url)), GATE_RUNNER_SENTINEL], {
      cwd: dir, env: { ...process.env, APE_GATE_RUNNER_JOB: jobFile }, detached: true, stdio: 'ignore',
    });
    const exited = new Promise((resolve) => runner.once('exit', resolve));
    let grandPid = null;
    try {
      for (let attempt = 0; attempt < 100 && await fileSize(marker) === 0; attempt += 1) await sleep(20);
      expect(await fileSize(marker)).toBeGreaterThan(0);
      grandPid = Number(await readFile(pidFile, 'utf8'));
      if (mode === 'cancel') runner.kill('SIGTERM');
      if (mode === 'runner-crash') runner.kill('SIGKILL');
      await exited;
      if (mode === 'runner-crash') {
        expect(await fileSize(artifact)).toBe(0);
      } else {
        const result = JSON.parse(await readFile(artifact, 'utf8'));
        expect(result.passed).toBe(false);
        if (mode === 'timeout') expect(result.timed_out).toBe(true);
        else expect(result.verification.aborted).toBe(true);
        expect(await fileSize(heartbeat)).toBe(0);
      }
      await expectTreeDead(marker);
    } finally {
      if (runner.exitCode === null && runner.signalCode === null) runner.kill('SIGTERM');
      // Only clean the fixture's still-writing child if a failed assertion left it alive.
      const before = await fileSize(marker);
      await sleep(60);
      if (grandPid && await fileSize(marker) > before) {
        try { process.kill(grandPid, 'SIGKILL'); } catch { /* fixture already exited */ }
      }
    }
  }, 15000);

  it('preserves the real exit status and output without exposing the supervisor IPC endpoint', async () => {
    const result = await spawnWithTimeout(process.execPath, ['-e', `
      console.log(JSON.stringify({ type: 'ape-suite-completion', version: 1, exit_code: 0, signal: null, spawn_error: null }));
      console.error('fixture-stderr');
      process.exit(typeof process.send === 'undefined' ? 7 : 91);
    `], { supervise: true, timeout_ms: 5000, collect: 'separate' });
    expect(result).toMatchObject({ exit_code: 7, signal: null, timed_out: false, spawn_error: null });
    expect(result.stdout).toContain('ape-suite-completion');
    expect(result.stderr).toContain('fixture-stderr');
  });

  it('reports a supervised spawn failure and handles cancellation before launch', async () => {
    const failed = await spawnWithTimeout('/ape-synthetic-missing-command', [], { supervise: true, timeout_ms: 5000 });
    expect(failed.exit_code).toBeNull();
    expect(failed.spawn_error?.code).toBe('ENOENT');
    const controller = new AbortController();
    controller.abort();
    const cancelled = await spawnWithTimeout('/ape-synthetic-missing-command', [], { supervise: true, signal: controller.signal });
    expect(cancelled).toMatchObject({ exit_code: null, aborted: true, timed_out: false, spawn_error: null });
  });
});
