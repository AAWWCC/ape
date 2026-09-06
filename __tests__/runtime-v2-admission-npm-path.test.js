import { execFileSync } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import { packageScriptEnvironment, resolveAdmissionExecutableFact } from '../lib/runtime/admission-command-argv.js';
import { inspectAdmissionCommandPrerequisites } from '../lib/runtime/admission-command-prerequisites.js';

const roots = [];
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));
async function fixture() {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), 'ape-npm-script-path-')));
  roots.push(root);
  return root;
}
async function put(root, file, content = '') {
  const target = path.join(root, file);
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, content);
  await chmod(target, 0o755);
  return target;
}
async function npmInstallation(root, { shim = false, hoisted = false } = {}) {
  const npmRoot = path.join(root, shim ? 'node_modules/npm' : 'lib/node_modules/npm');
  await put(npmRoot, 'package.json', JSON.stringify({ name: 'npm', bin: { npm: 'bin/npm-cli.js' } }));
  const cli = await put(npmRoot, 'bin/npm-cli.js', 'throw new Error("admission must never execute npm");\n');
  const runScriptRoot = path.join(hoisted ? root : npmRoot, 'node_modules/@npmcli/run-script');
  await put(runScriptRoot, 'package.json', JSON.stringify({ name: '@npmcli/run-script', main: 'lib/run-script.js' }));
  await put(runScriptRoot, 'lib/run-script.js', 'throw new Error("admission must never load npm modules");\n');
  await put(runScriptRoot, 'lib/node-gyp-bin/node-gyp', '#!/bin/sh\nexit 0\n');
  return {
    executable: shim ? await put(root, 'npm.cmd', '@echo off\r\n') : cli,
    bin: path.join(runScriptRoot, 'lib/node-gyp-bin'),
  };
}

describe('npm admission reproduces the selected installation script PATH', () => {
  it.each([false, true])('resolves vendored or hoisted run-script metadata without loading code (hoisted=%s)', async (hoisted) => {
    const root = await fixture();
    const npm = await npmInstallation(path.join(root, 'installation'), { hoisted });
    const project = path.join(root, 'project/packages/app');
    const env = await packageScriptEnvironment(project, { PATH: '/synthetic/inherited', KEPT: 'yes' }, 'linux', npm.executable);
    const entries = env.PATH.split(path.delimiter);
    expect(entries[0]).toBe(path.join(project, 'node_modules/.bin'));
    expect(entries.slice(-2)).toEqual([npm.bin, '/synthetic/inherited']);
    expect(env.KEPT).toBe('yes');
    expect((await resolveAdmissionExecutableFact(project, 'node-gyp', { env, platform: 'linux' })).resolved).toBe(path.join(npm.bin, 'node-gyp'));
  });

  it('recognizes the standard Windows npm.cmd installation while preserving Windows PATH precedence', async () => {
    const root = await fixture();
    const npm = await npmInstallation(path.join(root, 'Node installation'), { shim: true });
    const env = await packageScriptEnvironment(path.join(root, 'project'), { Path: 'C:\\external;D:\\tools', PATH: 'D:\\tools;E:\\more' }, 'win32', npm.executable);
    expect(env.Path).toBeUndefined();
    expect(env.PATH.split(';').slice(-4)).toEqual([npm.bin, 'C:\\external', 'D:\\tools', 'E:\\more']);
  });

  it('does not borrow a nearby npm installation for an unrelated selected executable', async () => {
    const root = await fixture();
    const npm = await npmInstallation(root, { shim: true });
    const other = await put(root, 'custom-launcher', '#!/bin/sh\n');
    const env = await packageScriptEnvironment(root, { PATH: '/inherited' }, 'linux', other);
    expect(env.PATH).not.toContain(npm.bin);
  });

  it('matches the installed npm script environment and admits its node-gyp without executing it during inspection', async () => {
    const root = await fixture();
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^npm_config_/i.test(key)));
    const npm = await resolveAdmissionExecutableFact(root, 'npm', { env });
    expect(npm).not.toBeNull();
    const cli = /npm-cli\.js$/i.test(npm.resolved) ? npm.resolved : path.join(path.dirname(npm.resolved), 'node_modules/npm/bin/npm-cli.js');
    await put(root, 'package.json', JSON.stringify({ private: true, scripts: { inspect: 'node print-env.cjs', test: 'node-gyp --version' } }));
    await put(root, 'print-env.cjs', 'require("node:fs").writeFileSync("npm-env.json",JSON.stringify(process.env));\n');
    execFileSync(process.execPath, [cli, 'run', '--silent', 'inspect'], { cwd: root, env, timeout: 15_000, stdio: 'pipe' });
    const actualEnv = JSON.parse(await readFile(path.join(root, 'npm-env.json'), 'utf8'));
    const modeledEnv = await packageScriptEnvironment(root, env, process.platform, npm.resolved);
    const actual = await resolveAdmissionExecutableFact(root, 'node-gyp', { env: actualEnv, shell: true });
    const modeled = await resolveAdmissionExecutableFact(root, 'node-gyp', { env: modeledEnv, shell: true });
    expect(actual).not.toBeNull();
    expect(modeled).toEqual(actual);
    expect(modeled.resolved).toContain(`${path.sep}node-gyp-bin${path.sep}`);
    expect(execFileSync(process.execPath, [cli, 'run', '--silent', 'test'], { cwd: root, env, timeout: 15_000, encoding: 'utf8' }).trim()).toMatch(/^v\d+\./);
    await rm(path.join(root, 'npm-env.json'));
    expect(await inspectAdmissionCommandPrerequisites(root, [{ id: 'test:full', command: 'npm test', root: '.' }], [{ id: 'test:full', resolved: npm.resolved }], { env })).toEqual([]);
    await expect(readFile(path.join(root, 'npm-env.json'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it.skipIf(process.platform === 'win32')('matches npm when POSIX inherits different Path and PATH values', async () => {
    const root = await fixture();
    const alias = path.join(root, 'alias-bin');
    const canonical = path.join(root, 'canonical-bin');
    const chosen = await put(alias, 'ape-path-choice', '#!/bin/sh\nexit 0\n');
    await put(canonical, 'ape-path-choice', '#!/bin/sh\nexit 1\n');
    const inherited = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^npm_config_|^path$/i.test(key)));
    const env = { ...inherited, Path: alias, PATH: `${canonical}${path.delimiter}${process.env.PATH}` };
    const npm = await resolveAdmissionExecutableFact(root, 'npm', { env });
    await put(root, 'package.json', JSON.stringify({ scripts: { inspect: 'node print-env.cjs', test: 'ape-path-choice' } }));
    await put(root, 'print-env.cjs', 'require("node:fs").writeFileSync("npm-env.json",JSON.stringify(process.env));\n');
    execFileSync(process.execPath, [npm.resolved, 'run', '--silent', 'inspect'], { cwd: root, env, timeout: 15_000, stdio: 'pipe' });
    const actualEnv = JSON.parse(await readFile(path.join(root, 'npm-env.json'), 'utf8'));
    const modeledEnv = await packageScriptEnvironment(root, env, process.platform, npm.resolved);
    expect(modeledEnv.Path).toBe(modeledEnv.PATH);
    expect(modeledEnv.PATH).toBe(actualEnv.PATH);
    expect((await resolveAdmissionExecutableFact(root, 'ape-path-choice', { env: modeledEnv, shell: true })).resolved).toBe(chosen);
    expect((await resolveAdmissionExecutableFact(root, 'ape-path-choice', { env: actualEnv, shell: true })).resolved).toBe(chosen);
  });
});
