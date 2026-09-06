import { spawnSync } from 'node:child_process';
import { access, chmod, copyFile, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { resolveAdmissionExecutableFact } from '../lib/runtime/admission-command-argv.js';

const windows = process.platform === 'win32';
const runtime = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../lib/runtime');
const roots = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })));
});
const exists = (file) => access(file).then(() => true, () => false);
async function put(root, file, content, executable = false) {
  const target = path.join(root, file);
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, typeof content === 'string' ? content : JSON.stringify(content));
  if (executable) await chmod(target, 0o755);
  return target;
}

// This harness inherits an isolated environment and uses the actual platform.
// Its real runner invocation is supervised on POSIX and uses cmd.exe on Windows.
const harness = `
import { readFile, access } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { splitCommand, runTestSuite } from ${JSON.stringify(pathToFileURL(path.join(runtime, 'runner.js')).href)};
import { resolveAdmissionExecutableFact } from ${JSON.stringify(pathToFileURL(path.join(runtime, 'admission-command-argv.js')).href)};
import { inspectAdmissionCommandPrerequisites } from ${JSON.stringify(pathToFileURL(path.join(runtime, 'admission-command-prerequisites.js')).href)};
const input = JSON.parse(await readFile(process.argv[2], 'utf8'));
const argv = splitCommand(input.command);
const fact = await resolveAdmissionExecutableFact(input.cwd, argv[0]);
const blocking = fact ? await inspectAdmissionCommandPrerequisites(input.root,
  [{ id: 'native', command: input.command, root: input.commandRoot }], [{ id: 'native', resolved: fact.resolved }]) : [{ cause: 'outer-executable-missing' }];
const executedBeforeAdmission = await access(input.marker).then(() => true, () => false);
const bash = process.platform === 'win32' ? spawnSync('bash', ['--version'], { timeout: 1000, encoding: 'utf8', windowsHide: true }) : null;
const result = await runTestSuite(input.cwd, { command: input.command, timeout_ms: 12000, kill_grace_ms: 300, drain_ms: 300 });
const records = await readFile(input.marker, 'utf8').then((text) => text.trim().split('\\n').filter(Boolean).map((line) => JSON.parse(line)), () => []);
process.stdout.write(JSON.stringify({ platform: process.platform, fact, blocking, executedBeforeAdmission,
  bashError: bash?.error?.code ?? null, comspec: process.env.ComSpec ?? process.env.COMSPEC ?? null, result, records }));
`;
const entry = `
const fs = require('node:fs');
fs.appendFileSync(process.env.APE_NATIVE_MARKER, JSON.stringify({
  platform: process.platform, cwd: process.cwd(), args: process.argv.slice(2), event: process.env.npm_lifecycle_event ?? null,
}) + '\\n');
process.stdout.write('APE_NATIVE_LOCAL_FIXTURE\\n');
`;

async function fixture() {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), 'ape native platform ')));
  roots.push(root);
  const launchers = path.join(root, 'Node launchers with spaces');
  await mkdir(launchers);
  const installedNpm = await resolveAdmissionExecutableFact(root, windows ? 'npm.cmd' : 'npm');
  const installedNpx = await resolveAdmissionExecutableFact(root, windows ? 'npx.cmd' : 'npx');
  expect(installedNpm, 'the native CI image must provide npm').not.toBeNull();
  expect(installedNpx, 'the native CI image must provide npx').not.toBeNull();
  if (windows) {
    // Copy the real launchers, retaining their adjacent extensionless Unix
    // wrappers. A junction supplies this same installed npm tree without an
    // install, package download, or a privileged Windows file symlink.
    const installedDirectory = path.dirname(installedNpm.resolved);
    await copyFile(installedNpm.resolved, path.join(launchers, 'npm.cmd'));
    await copyFile(installedNpx.resolved, path.join(launchers, 'npx.cmd'));
    await copyFile(path.join(installedDirectory, 'npm'), path.join(launchers, 'npm'));
    await copyFile(path.join(path.dirname(installedNpx.resolved), 'npx'), path.join(launchers, 'npx'));
    await symlink(path.join(installedDirectory, 'node_modules'), path.join(launchers, 'node_modules'), 'junction');
  } else {
    await symlink(installedNpm.resolved, path.join(launchers, 'npm'));
    await symlink(installedNpx.resolved, path.join(launchers, 'npx'));
  }
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^npm_|^path$|^pathext$|^comspec$|^APE_GATE_RUNNER_JOB$/i.test(key)));
  const nodeDirectory = path.dirname(process.execPath);
  if (windows) {
    const systemRoot = process.env.SystemRoot ?? process.env.SYSTEMROOT;
    expect(systemRoot).toBeTruthy();
    const systemDirectory = path.join(systemRoot, 'System32');
    env.ComSpec = path.join(systemDirectory, 'cmd.exe');
    expect(await exists(env.ComSpec)).toBe(true);
    // A CI image may also expose WSL's bash.exe in System32. Keep only native
    // directories without any Bash executable; cmd uses the absolute ComSpec.
    const candidates = [launchers, nodeDirectory, systemDirectory];
    const directories = [];
    for (const directory of candidates) {
      if (!await exists(path.join(directory, 'bash.exe')) && !await exists(path.join(directory, 'bash.cmd'))) directories.push(directory);
    }
    expect(directories).toContain(nodeDirectory);
    env.Path = [...new Set(directories)].join(';');
    env.pAtHeXt = '.cOm;.eXe;.bAt;.cMd';
  } else env.PATH = [launchers, nodeDirectory, '/usr/bin', '/bin'].join(path.delimiter);
  env.npm_config_userconfig = await put(root, 'user.npmrc', '');
  env.npm_config_globalconfig = await put(root, 'global.npmrc', '');
  Object.assign(env, { npm_config_cache: path.join(root, 'npm cache'), npm_config_offline: 'true', npm_config_yes: 'false',
    npm_config_update_notifier: 'false', npm_config_audit: 'false', npm_config_fund: 'false', npm_config_fetch_retries: '0', npm_config_fetch_timeout: '1000',
    APE_NATIVE_MARKER: path.join(root, 'execution records.jsonl') });
  await put(root, 'harness.mjs', harness);
  await put(root, 'package.json', { private: true, name: 'native-root', workspaces: ['packages/*'], scripts: {
    pretest: 'mkdir "generated folder"', test: 'node "check entry.cjs" root "script argument"',
  } });
  await put(root, 'check entry.cjs', entry);
  for (const name of ['app', 'other space']) {
    await put(root, `packages/${name}/package.json`, { name: name === 'app' ? 'native-app' : 'native-other', version: '1.0.0', scripts: { test: `node "check entry.cjs" "${name}"` } });
    await put(root, `packages/${name}/check entry.cjs`, entry);
  }
  await put(root, 'node_modules/ape-native-fixture/package.json', { name: 'ape-native-fixture', version: '1.0.0', bin: { 'ape-native-fixture': 'bin/entry.cjs' } });
  await put(root, 'node_modules/ape-native-fixture/bin/entry.cjs', `#!/usr/bin/env node\n${entry}`, true);
  if (windows) {
    await put(root, 'node_modules/.bin/ape-native-fixture.cmd', '@echo off\r\nnode "%~dp0\\..\\ape-native-fixture\\bin\\entry.cjs" %*\r\n');
    await put(root, 'node_modules/.bin/ape-native-fixture', '#!/bin/sh\nexec node "$(dirname "$0")/../ape-native-fixture/bin/entry.cjs" "$@"\n', true);
  } else {
    await mkdir(path.join(root, 'node_modules/.bin'));
    await symlink('../ape-native-fixture/bin/entry.cjs', path.join(root, 'node_modules/.bin/ape-native-fixture'));
  }
  return { root, env, launchers };
}

async function execute(f, command, commandRoot = '.') {
  const request = await put(f.root, 'request.json', { root: f.root, cwd: path.resolve(f.root, commandRoot), commandRoot, command, marker: f.env.APE_NATIVE_MARKER });
  const child = spawnSync(process.execPath, [path.join(f.root, 'harness.mjs'), request], {
    cwd: f.root, env: f.env, encoding: 'utf8', timeout: 20000, windowsHide: true, maxBuffer: 1024 * 1024,
  });
  expect(child.error, child.stderr).toBeUndefined();
  expect(child.status, child.stderr).toBe(0);
  const result = JSON.parse(child.stdout);
  expect(result.platform).toBe(process.platform);
  expect(result.executedBeforeAdmission).toBe(false);
  if (windows) {
    expect(result.bashError, 'Bash must actually be unavailable in the native child environment').toBe('ENOENT');
    expect(result.comspec.toLowerCase()).toMatch(/\\cmd\.exe$/);
  }
  return result;
}
function expectPass(result, expectedCwd, expectedArgs) {
  expect(result.blocking).toEqual([]);
  expect(result.result).toMatchObject({ passed: true, exit_code: 0, tooling_failure: false });
  expect(result.result.output).toContain('APE_NATIVE_LOCAL_FIXTURE');
  expect(result.records).toHaveLength(1);
  expect(result.records[0].platform).toBe(process.platform);
  const normalize = (value) => windows ? path.resolve(value).toLowerCase() : path.resolve(value);
  expect(normalize(result.records[0].cwd)).toBe(normalize(expectedCwd));
  expect(result.records[0].args).toEqual(expectedArgs);
}

describe('native admission and real npm/npx runner launches', () => {
  it('runs bare npm in a path with spaces, including its native shell and forwarded arguments', async () => {
    const f = await fixture();
    const result = await execute(f, 'npm run --silent test -- "forwarded argument"');
    expectPass(result, f.root, ['root', 'script argument', 'forwarded argument']);
    expect(await exists(path.join(f.root, 'generated folder'))).toBe(true);
    if (windows) expect(result.fact.resolved.toLowerCase()).toBe(path.join(f.launchers, 'npm.cmd').toLowerCase());
  }, 30000);

  it('runs the actual npx launcher against a precreated local bin without installation or network', async () => {
    const f = await fixture();
    const result = await execute(f, 'npx --offline --no-install ape-native-fixture "argument with spaces"');
    expectPass(result, f.root, ['argument with spaces']);
    if (windows) expect(result.fact.resolved.toLowerCase()).toBe(path.join(f.launchers, 'npx.cmd').toLowerCase());
    expect(await exists(path.join(f.root, 'npm cache', '_npx'))).toBe(false);
  }, 30000);

  it('selects a sibling workspace from the configured workspace cwd', async () => {
    const f = await fixture();
    expectPass(await execute(f, 'npm test --workspace=native-other --silent', 'packages/app'), path.join(f.root, 'packages/other space'), ['other space']);
  }, 30000);

  it('preserves the implicit workspace filter when --workspaces is used inside a workspace', async () => {
    const f = await fixture();
    expectPass(await execute(f, 'npm test --workspaces --silent', 'packages/app'), path.join(f.root, 'packages/app'), ['app']);
  }, 30000);

  it('uses an explicit package prefix containing spaces', async () => {
    const f = await fixture();
    expectPass(await execute(f, 'npm --prefix "packages/other space" test --silent'), path.join(f.root, 'packages/other space'), ['other space']);
  }, 30000);

  it('reports a missing script entry that the real npm runner also cannot execute', async () => {
    const f = await fixture();
    await put(f.root, 'package.json', { scripts: { test: 'node "missing entry.cjs"' } });
    const result = await execute(f, windows ? 'NPM.CmD test --silent' : 'npm test --silent');
    expect(result.blocking).toContainEqual(expect.objectContaining({ cause: 'entry-script-missing', expected_path: 'missing entry.cjs', package_script: 'test' }));
    expect(result.result).toMatchObject({ passed: false, exit_code: 1 });
    expect(result.result.output).toContain('MODULE_NOT_FOUND');
    expect(result.records).toEqual([]);
  }, 30000);

  it.skipIf(!windows)('executes explicit mixed-case CMD launchers and a working-directory wrapper with Bash absent', async () => {
    const f = await fixture();
    expectPass(await execute(f, 'npx.CmD --offline --no-install ape-native-fixture "cmd argument"'), f.root, ['cmd argument']);
    await rm(f.env.APE_NATIVE_MARKER);
    await put(f.root, 'mvnw.cmd', `@echo off\r\n"${process.execPath}" "%~dp0check entry.cjs" wrapper %*\r\n`);
    const result = await execute(f, 'mvnw.CmD "wrapper argument"');
    expectPass(result, f.root, ['wrapper', 'wrapper argument']);
    expect(result.fact.resolved.toLowerCase()).toBe(path.join(f.root, 'mvnw.cmd').toLowerCase());
  }, 30000);
});
