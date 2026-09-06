import { spawn } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { afterEach, describe, expect, it } from 'vitest';

const runtimeDir = fileURLToPath(new URL('../lib/runtime/', import.meta.url));
const cleanups = [];
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const size = async (file) => (await stat(file).catch(() => null))?.size ?? 0;

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function fixture(layout, mode) {
  const dir = await mkdtemp(path.join(tmpdir(), 'ape-inline-supervisor-'));
  cleanups.push(dir);
  const host = path.join(dir, 'dist', 'host.mjs');
  await mkdir(path.dirname(host), { recursive: true });
  await writeFile(path.join(dir, 'package.json'), '{"type":"module"}');
  await writeFile(path.join(dir, 'worker.mjs'), `
    import { appendFileSync } from 'node:fs';
    process.on('SIGTERM', () => {});
    appendFileSync('beats', 'beat\\n');
    setInterval(() => appendFileSync('beats', 'beat\\n'), 20);
  `);
  await writeFile(path.join(dir, 'suite.mjs'), `
    import { spawn } from 'node:child_process';
    import { appendFileSync, existsSync, writeFileSync } from 'node:fs';
    if (typeof process.send !== 'undefined') process.exit(91);
    process.on('SIGTERM', () => {});
    writeFileSync('suite.pid', String(process.pid));
    const worker = spawn(process.execPath, ['worker.mjs'], { stdio: 'ignore' });
    writeFileSync('worker.pid', String(worker.pid));
    setInterval(() => {
      appendFileSync('suite-beats', 'beat\\n');
      if (${JSON.stringify(mode)} === 'normal' && existsSync('beats')) {
        process.stdout.write('suite-complete\\n', () => process.exit(0));
      }
    }, 20);
  `);
  const contents = `
    import { existsSync } from 'node:fs';
    import { runTestSuite } from ${JSON.stringify(pathToFileURL(path.join(runtimeDir, 'runner.js')).href)};
    const controller = new AbortController();
    const cancel = setInterval(() => {
      if (${JSON.stringify(mode)} === 'cancel' && existsSync('beats')) controller.abort();
    }, 10);
    try {
      const result = await runTestSuite(process.cwd(), {
        override: { command: process.execPath, args: ['suite.mjs'] },
        timeout_ms: ${mode === 'timeout' ? 1500 : 15000},
        kill_grace_ms: 300, drain_ms: 300, signal: controller.signal,
      });
      console.log(JSON.stringify(result));
    } finally { clearInterval(cancel); }
  `;
  if (layout === 'bundled') {
    // Reproduce the shipped dist + lib/runtime layout in scratch space; never
    // rebuild or invoke the repository's committed MCP bundle or live server.
    const built = await build({ stdin: { contents, resolveDir: runtimeDir },
      bundle: true, platform: 'node', format: 'esm', target: 'node22', write: false,
      plugins: [{ name: 'fixture-file-url', setup(builder) {
        builder.onResolve({ filter: /^file:/ }, (args) => ({ path: fileURLToPath(args.path) }));
      } }],
    });
    await writeFile(host, built.outputFiles[0].text);
    await mkdir(path.join(dir, 'lib', 'runtime'), { recursive: true });
    await copyFile(path.join(runtimeDir, 'spawn.js'), path.join(dir, 'lib', 'runtime', 'spawn.js'));
  } else {
    await writeFile(host, contents);
  }
  return { dir, host };
}

async function exercise(dir, host, mode) {
  const child = spawn(process.execPath, [host], { cwd: dir, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  let errors = '';
  child.stdout.on('data', (chunk) => { output += chunk; });
  child.stderr.on('data', (chunk) => { errors += chunk; });
  const exited = new Promise((resolve) => child.once('exit', (code, signal) => resolve({ code, signal })));
  const deadline = setTimeout(() => child.kill('SIGKILL'), 12000);
  try {
    if (mode === 'host-crash') {
      for (let attempts = 0; attempts < 250 && await size(path.join(dir, 'beats')) === 0; attempts += 1) await sleep(20);
      expect(await size(path.join(dir, 'beats'))).toBeGreaterThan(0);
      child.kill('SIGKILL');
    }
    const exit = await exited;
    if (mode === 'host-crash') {
      expect(exit).toEqual({ code: null, signal: 'SIGKILL' });
      expect(output).toBe('');
    } else {
      expect(errors).toBe('');
      expect(exit).toEqual({ code: 0, signal: null });
      const result = JSON.parse(output);
      expect(result.tooling_failure).toBe(false);
      expect(result.passed).toBe(mode === 'normal');
      if (mode === 'normal') {
        expect(result.exit_code).toBe(0);
        expect(result.output).toContain('suite-complete');
        expect(result).not.toHaveProperty('aborted');
        expect(result).not.toHaveProperty('timed_out');
      } else {
        expect(result[mode === 'timeout' ? 'timed_out' : 'aborted']).toBe(true);
      }
    }
    // A process may have one in-flight write at kill time. Once that settles,
    // neither a normal verdict nor a dead owner may leave an ordinary worker.
    await sleep(150);
    const before = await size(path.join(dir, 'beats'));
    expect(before).toBeGreaterThan(0);
    await sleep(250);
    expect(await size(path.join(dir, 'beats'))).toBe(before);
  } finally {
    clearTimeout(deadline);
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    await exited;
    // A changing private heartbeat identifies a still-running fixture; do not
    // signal a recorded PID after its process has exited and could be reused.
    for (const [name, marker] of [['suite.pid', 'suite-beats'], ['worker.pid', 'beats']]) {
      const pid = Number(await readFile(path.join(dir, name), 'utf8').catch(() => ''));
      const before = await size(path.join(dir, marker));
      await sleep(60);
      if (pid > 0 && await size(path.join(dir, marker)) > before) {
        try { process.kill(pid, 'SIGKILL'); } catch { /* already dead */ }
      }
    }
  }
}

describe.skipIf(process.platform === 'win32')('inline suite process ownership', () => {
  it.each(['source', 'bundled'].flatMap((layout) =>
    ['normal', 'timeout', 'cancel', 'host-crash'].map((mode) => ({ layout, mode }))))(
    'cleans ordinary descendants for $layout invocation after $mode', async ({ layout, mode }) => {
      const { dir, host } = await fixture(layout, mode);
      await exercise(dir, host, mode);
    }, 15000,
  );

  it('fails closed without launching the suite when a bundle lacks its supervisor helper', async () => {
    const { dir, host } = await fixture('bundled', 'normal');
    await rm(path.join(dir, 'lib', 'runtime', 'spawn.js'));
    const child = spawn(process.execPath, [host], { cwd: dir, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    child.stdout.on('data', (chunk) => { output += chunk; });
    await new Promise((resolve) => child.once('exit', resolve));
    expect(JSON.parse(output)).toMatchObject({ passed: false, tooling_failure: true, exit_code: null });
    expect(JSON.parse(output).output).toContain('Suite supervisor entry is unavailable');
    expect(await size(path.join(dir, 'suite.pid'))).toBe(0);
  });
});
