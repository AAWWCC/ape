import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { buildSpawnPlan, runTestSuite } from '../lib/runtime/runner.js';
import { spawnWithTimeout } from '../lib/runtime/spawn.js';

const windows = process.platform === 'win32';
const roots = [];
const children = [];
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };
async function waitFor(check, label) {
  for (const end = Date.now() + 25_000; Date.now() < end;) {
    if (await check()) return;
    await delay(25);
  }
  throw new Error(`Native Windows fixture did not reach ${label}`);
}
afterEach(async () => {
  for (const child of children.splice(0)) if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  for (const root of roots.splice(0)) {
    for (const name of await readdir(root)) {
      if (!name.endsWith('.pid')) continue;
      const pid = Number(await readFile(path.join(root, name), 'utf8'));
      try { process.kill(pid, 'SIGKILL'); } catch {}
    }
    await rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  }
});
async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), 'ape Windows ownership café '));
  roots.push(root);
  await writeFile(path.join(root, 'descendant.cjs'), `
    const fs = require('node:fs'); const path = require('node:path');
    const root = process.argv[2];
    fs.writeFileSync(path.join(root, 'descendant.pid'), String(process.pid));
    setInterval(() => fs.appendFileSync(path.join(root, 'beats'), 'x'), 20);
    setTimeout(() => process.exit(94), 60000);
  `);
  await writeFile(path.join(root, 'suite.cjs'), `
    const fs = require('node:fs'); const path = require('node:path'); const {spawn} = require('node:child_process');
    const root = process.argv[2];
    fs.writeFileSync(path.join(root, 'suite.pid'), String(process.pid));
    fs.writeFileSync(path.join(root, 'args.json'), JSON.stringify(process.argv.slice(3)));
    const child = spawn(process.execPath, [path.join(root, 'descendant.cjs'), root], {stdio:'ignore'});
    child.unref();
    const timer = setInterval(() => {
      if (fs.existsSync(path.join(root, 'release')) && fs.existsSync(path.join(root, 'descendant.pid'))) process.exit(0);
    }, 20);
    setTimeout(() => process.exit(93), 60000);
  `);
  return root;
}
async function liveTree(root) {
  await waitFor(() => readFile(path.join(root, 'descendant.pid')).then(() => true, () => false), 'live descendant');
  const suite = Number(await readFile(path.join(root, 'suite.pid'), 'utf8'));
  const descendant = Number(await readFile(path.join(root, 'descendant.pid'), 'utf8'));
  expect(alive(suite)).toBe(true);
  expect(alive(descendant)).toBe(true);
  return { suite, descendant };
}

// The general durable-gate file runs receipt/REGATE/SHIP, both state sinks,
// lock recovery and sequential generations on every native OS. These arms
// specifically require Windows Job Object behavior, not a mocked platform.
describe.skipIf(!windows)('Windows native ownership and completion proof', () => {
  it('normal successful work returns confirmed cleanup rather than permanently unknown', async () => {
    const root = await fixture();
    const pending = spawnWithTimeout(process.execPath, [path.join(root, 'suite.cjs'), root], {
      cwd: root, supervise: true, timeout_ms: 40_000, kill_grace_ms: 200, drain_ms: 100,
    });
    const tree = await liveTree(root);
    await writeFile(path.join(root, 'release'), 'go');
    const result = await pending;
    expect(result).toMatchObject({ exit_code: 0, timed_out: false, spawn_error: null, cleanup: { status: 'confirmed' } });
    expect(alive(tree.suite)).toBe(false);
    expect(alive(tree.descendant), 'the closed-output ordinary descendant must be retired before confirmed').toBe(false);
  }, 50_000);

  it('contains a real CMD wrapper with Unicode/space arguments and does not leak control handles', async () => {
    const root = await fixture();
    await writeFile(path.join(root, 'fixture.cmd'), `@echo off\r\n"${process.execPath}" "%~dp0suite.cjs" "%~dp0." %*\r\n`);
    const plan = buildSpawnPlan(path.join(root, 'fixture.cmd'), ['argument with spaces', 'café']);
    expect(plan.shell).toBe(true);
    const pending = spawnWithTimeout(plan.command, plan.args, { cwd: root, shell: plan.shell,
      supervise: true, timeout_ms: 40_000, kill_grace_ms: 200, drain_ms: 100 });
    const tree = await liveTree(root);
    expect(JSON.parse(await readFile(path.join(root, 'args.json'), 'utf8'))).toEqual(['argument with spaces', 'café']);
    await writeFile(path.join(root, 'release'), 'go');
    const result = await pending;
    expect(result).toMatchObject({ exit_code: 0, cleanup: { status: 'confirmed' } });
    expect(alive(tree.suite)).toBe(false);
    expect(alive(tree.descendant)).toBe(false);
  }, 50_000);

  it('retains ordinary descendants in containment when the suite runner dies abruptly', async () => {
    const root = await fixture();
    const spawnUrl = pathToFileURL(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../lib/runtime/spawn.js')).href;
    const owner = path.join(root, 'owner.mjs');
    await writeFile(owner, `import {spawnWithTimeout} from ${JSON.stringify(spawnUrl)}; await spawnWithTimeout(process.execPath, [${JSON.stringify(path.join(root, 'suite.cjs'))}, ${JSON.stringify(root)}], {cwd:${JSON.stringify(root)},supervise:true,timeout_ms:40000});`);
    const child = spawn(process.execPath, [owner], { cwd: root, stdio: 'ignore' });
    children.push(child);
    const exited = new Promise((resolve) => child.once('exit', resolve));
    const tree = await liveTree(root);
    child.kill('SIGKILL');
    await exited;
    await waitFor(() => !alive(tree.suite) && !alive(tree.descendant), 'retirement after runner death');
    // This assertion precedes fallback cleanup. Killing only the direct
    // runner with taskkill or assuming its exit proves tree death fails here.
    expect(alive(tree.descendant)).toBe(false);
  }, 50_000);

  it('keeps npm script success usable through the same confirmed cleanup path', async () => {
    const root = await fixture();
    await mkdir(path.join(root, 'npm package'));
    await writeFile(path.join(root, 'npm package/package.json'), JSON.stringify({ private: true, scripts: {
      test: `node "${path.join(root, 'suite.cjs').replaceAll('\\', '/')}" "${root.replaceAll('\\', '/')}"`,
    } }));
    const pending = runTestSuite(path.join(root, 'npm package'), { command: 'npm test --silent', timeout_ms: 40_000 });
    const tree = await liveTree(root);
    await writeFile(path.join(root, 'release'), 'go');
    const result = await pending;
    expect(result).toMatchObject({ passed: true, exit_code: 0, tooling_failure: false, cleanup: { status: 'confirmed' } });
    expect(alive(tree.suite)).toBe(false);
    expect(alive(tree.descendant)).toBe(false);
  }, 50_000);
});
