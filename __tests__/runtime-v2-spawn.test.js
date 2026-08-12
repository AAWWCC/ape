import { mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
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
