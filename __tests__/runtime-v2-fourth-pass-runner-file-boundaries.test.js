import { spawnSync } from 'node:child_process';
import { mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const fixtures = [];
async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), 'ape-fourth-runner-boundaries-'));
  fixtures.push(root);
  return root;
}
afterEach(async () => {
  await Promise.all(fixtures.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function inspectWitness(file) {
  return spawnSync(process.execPath, ['--input-type=module', '-e', `
    import { hostname } from 'node:os';
    import { killProcessTree } from ${JSON.stringify(new URL('../lib/runtime/spawn.js', import.meta.url).href)};
    const calls = [];
    // Never send a real signal from a malformed stored-witness fixture.
    process.kill = (...args) => { calls.push(args); throw Object.assign(new Error('absent'), { code: 'ESRCH' }); };
    await killProcessTree({ host: hostname(), pid: 1234567,
      heartbeat_file: ${JSON.stringify(file)}, created_at: new Date().toISOString(), timeout_ms: 1000 });
    console.log(JSON.stringify(calls));
  `], { timeout: 3000, killSignal: 'SIGKILL', encoding: 'utf8' });
}

describe('fourth-pass detached runner file boundaries', () => {
  it.skipIf(process.platform === 'win32').each(['fifo', 'symlink-to-fifo'])(
    'returns from cancellation with a %s heartbeat without waiting for a writer', async (shape) => {
      const root = await fixture();
      const file = path.join(root, 'heartbeat');
      const fifo = shape === 'fifo' ? file : path.join(root, 'pipe');
      expect(spawnSync('mkfifo', [fifo]).status).toBe(0);
      if (shape === 'symlink-to-fifo') await symlink(fifo, file);
      const result = inspectWitness(file);
      expect(result.error).toBeUndefined();
      expect(result.status).toBe(0);
      expect(result.stdout.trim()).toBe('[]');
    },
  );

  it('refuses an oversized otherwise valid heartbeat without probing its stored PID', async () => {
    const file = path.join(await fixture(), 'heartbeat');
    await writeFile(file, JSON.stringify({ pid: 1234567, beat_at: Date.now(), padding: 'x'.repeat(4096) }));
    const result = inspectWitness(file);
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe('[]');
  });

  it('still probes an ordinary fresh witness before deciding that its group is absent', async () => {
    const file = path.join(await fixture(), 'heartbeat');
    await writeFile(file, JSON.stringify({ pid: 1234567, beat_at: Date.now() }));
    const result = inspectWitness(file);
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual([[-1234567, 0]]);
  });

  it.skipIf(process.platform === 'win32')('exits a gate runner whose job descriptor is a FIFO before suite launch', async () => {
    const job = path.join(await fixture(), 'job');
    expect(spawnSync('mkfifo', [job]).status).toBe(0);
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', `
      import { runGateJob } from ${JSON.stringify(new URL('../lib/runtime/runner.js', import.meta.url).href)};
      await runGateJob();
      console.log('returned');
    `], { env: { ...process.env, APE_GATE_RUNNER_JOB: job }, timeout: 3000,
      killSignal: 'SIGKILL', encoding: 'utf8' });
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe('returned');
  });
});
