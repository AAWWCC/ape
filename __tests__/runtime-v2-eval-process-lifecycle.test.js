import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { runProcess } from '../evals/prompt-evals.mjs';
import { buildSpawnPlan } from '../lib/runtime/runner.js';

const fixtures = [];
const posix = process.platform !== 'win32';

async function fixture(body) {
  const directory = await mkdtemp(path.join(tmpdir(), 'ape-eval-process-'));
  fixtures.push(directory);
  const script = path.join(directory, 'provider.cjs');
  await writeFile(script, `const fs = require('node:fs');
fs.writeFileSync(${JSON.stringify(path.join(directory, 'parent.pid'))}, String(process.pid));
${body}`);
  return { directory, script };
}

async function pidFrom(directory, name = 'parent') {
  return Number(await readFile(path.join(directory, `${name}.pid`), 'utf8'));
}

function alive(pid) {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

afterEach(async () => {
  for (const directory of fixtures.splice(0)) {
    // Fixture-only cleanup also bounds a regression that leaves a child alive.
    for (const name of ['descendant', 'parent']) {
      const pid = await pidFrom(directory, name).catch(() => null);
      if (!Number.isInteger(pid) || pid <= 1) continue;
      if (posix) { try { process.kill(-pid, 'SIGKILL'); } catch { /* already ended */ } }
      try { process.kill(pid, 'SIGKILL'); } catch { /* already ended */ }
    }
    await rm(directory, { recursive: true, force: true });
  }
});

describe('evaluation provider process lifecycle', () => {
  it('delivers all input, preserves both output streams, and returns nonzero exit status', async () => {
    const { script } = await fixture(`let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => { input += chunk; });
process.stdin.on('end', () => { process.stdout.write(input); process.stderr.write('diagnostic'); process.exitCode = 7; });`);
    const input = 'fixture prompt π\n'.repeat(1000);
    const result = await runProcess(process.execPath, [script], { input, timeoutMs: 3000 });
    expect(result).toEqual({ code: 7, signal: null, stdout: input, stderr: 'diagnostic' });
  });

  it('reports a launch failure without an unhandled stream error', async () => {
    const { directory } = await fixture('');
    await expect(runProcess(path.join(directory, 'missing-provider'), [], { timeoutMs: 3000 }))
      .rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('escalates a TERM-ignoring timeout and settles after the provider has stopped', async () => {
    const { directory, script } = await fixture(`process.on('SIGTERM', () => {});
process.stdin.resume(); setInterval(() => {}, 50);`);
    const started = Date.now();
    await expect(runProcess(process.execPath, [script], {
      timeoutMs: 500, killGraceMs: 100, drainMs: 100,
    })).rejects.toThrow('timed out after 500ms');
    expect(Date.now() - started).toBeLessThan(2500);
    expect(alive(await pidFrom(directory))).toBe(false);
  });

  it('turns a closed input pipe into a bounded evaluation failure', async () => {
    const { directory, script } = await fixture(`fs.closeSync(0);
process.on('SIGTERM', () => {}); setInterval(() => {}, 50);`);
    await expect(runProcess(process.execPath, [script], {
      input: 'x'.repeat(4 * 1024 * 1024), timeoutMs: 3000, killGraceMs: 100, drainMs: 100,
    })).rejects.toThrow('input delivery failed');
    expect(alive(await pidFrom(directory))).toBe(false);
  });

  it('stops the provider before rejecting excessive output', async () => {
    const { directory, script } = await fixture(`process.on('SIGTERM', () => {});
process.stdout.write('x'.repeat(2048)); setInterval(() => {}, 50);`);
    await expect(runProcess(process.execPath, [script], {
      timeoutMs: 3000, killGraceMs: 100, drainMs: 100, maxBytes: 1024,
    })).rejects.toThrow('output exceeded 1024 bytes');
    expect(alive(await pidFrom(directory))).toBe(false);
  });

  it.skipIf(!posix)('closes ordinary inherited pipes when the group leader exits', async () => {
    const { directory, script } = await fixture(`const { spawn } = require('node:child_process');
const descendant = spawn(process.execPath, ['-e', 'setInterval(() => {}, 50)'], { stdio: ['ignore', 'inherit', 'inherit'] });
fs.writeFileSync(require('node:path').join(__dirname, 'descendant.pid'), String(descendant.pid));
descendant.on('spawn', () => process.exit(0));`);
    const result = await runProcess(process.execPath, [script], {
      timeoutMs: 3000, killGraceMs: 100, drainMs: 500,
    });
    expect(result.code).toBe(0);
    expect(alive(await pidFrom(directory))).toBe(false);
  });

  it.skipIf(!posix)('bounds pipe drain even when a descendant leaves the owned process group', async () => {
    const { script } = await fixture(`const { spawn } = require('node:child_process');
const descendant = spawn(process.execPath, ['-e', 'setInterval(() => {}, 50)'], { detached: true, stdio: ['ignore', 'inherit', 'inherit'] });
fs.writeFileSync(require('node:path').join(__dirname, 'descendant.pid'), String(descendant.pid));
descendant.on('spawn', () => process.exit(0));`);
    const started = Date.now();
    await expect(runProcess(process.execPath, [script], {
      timeoutMs: 3000, killGraceMs: 100, drainMs: 100,
    })).rejects.toThrow('output pipes remained open after exit');
    expect(Date.now() - started).toBeLessThan(2500);
  });

  it('routes bare Windows provider shims through the shared argument quoting', () => {
    const args = ['--prompt', 'one argument & special "quoted" text'];
    for (const provider of ['codex', 'claude']) {
      const plan = buildSpawnPlan(provider, args, 'win32');
      const explicitShim = buildSpawnPlan(`${provider}.cmd`, args, 'win32');
      expect(plan).toEqual({ ...explicitShim, command: explicitShim.command.replace(`${provider}.cmd`, provider) });
      expect(plan.shell).toBe(true);
      expect(buildSpawnPlan(`${provider}.exe`, args, 'win32'))
        .toEqual({ command: `${provider}.exe`, args, shell: false });
      expect(buildSpawnPlan(provider, args, 'linux')).toEqual({ command: provider, args, shell: false });
    }
  });
});
