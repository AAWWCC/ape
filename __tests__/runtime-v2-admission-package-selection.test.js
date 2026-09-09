import { execFileSync } from 'node:child_process';
import { chmod, mkdtemp, mkdir, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import { resolveAdmissionExecutableFact, packageScriptEnvironment } from '../lib/runtime/admission-command-argv.js';
import { inspectAdmissionCommandPrerequisites } from '../lib/runtime/admission-command-prerequisites.js';
import { inspectAdmissionBaseline, packageScript, packageShellInvocation, packageInvocationEnvironment } from '../lib/runtime/admission-baseline.js';
import { splitCommand } from '../lib/runtime/runner.js';

const roots = [];
const defaultEnv = () => Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^npm_config_(?:ignore[-_]scripts|if[-_]present|workspaces?|include[-_]workspace[-_]root|script[-_]shell)$/i.test(key)));
// Bound retries to fixture removal; persistent cleanup errors still fail the test.
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, {
  recursive: true, force: true, maxRetries: 3, retryDelay: 50,
}))));
async function put(root, file, content, executable = false) {
  const target = path.join(root, file);
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, content);
  if (executable) await chmod(target, 0o755);
  return target;
}
async function fixture(files = {}) {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), 'ape-admission-selection-')));
  roots.push(root);
  for (const [file, value] of Object.entries(files)) await put(root, file, typeof value === 'string' ? value : JSON.stringify(value));
  return root;
}
async function inspect(root, command, options = {}, commandRoot = '.') {
  options = { env: defaultEnv(), ...options };
  const fact = await resolveAdmissionExecutableFact(path.resolve(root, commandRoot), splitCommand(command)[0], options);
  expect(fact, 'the configured outer command must resolve').not.toBeNull();
  return inspectAdmissionCommandPrerequisites(root, [{ id: 'test:full', command, root: commandRoot }], [{ id: 'test:full', resolved: fact.resolved }], options);
}
const git = (root, ...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' } }).trim();
function commit(root) { git(root, 'add', '.'); git(root, 'commit', '-qm', 'fixture'); return git(root, 'rev-parse', 'HEAD'); }
function baseline(root) {
  git(root, 'init', '-q', '-b', 'main');
  git(root, 'config', 'user.name', 'Synthetic admission');
  git(root, 'config', 'user.email', 'admission@example.test');
  git(root, 'config', 'commit.gpgsign', 'false');
  return commit(root);
}
async function compare(root, base, command, options = {}, commandRoot = '.') {
  options = { env: defaultEnv(), ...options };
  const fact = await resolveAdmissionExecutableFact(path.resolve(root, commandRoot), splitCommand(command)[0], options);
  return inspectAdmissionBaseline(root, { mode: 'phase' }, { root, head: git(root, 'rev-parse', 'HEAD'), base_commit: base },
    [{ id: 'test:full', command, root: commandRoot }], [{ id: 'test:full', resolved: fact?.resolved }], options);
}
const workspaceFixture = () => ({
  'package.json': { name: 'fixture-root', private: true, workspaces: ['packages/*'] },
  'packages/app/package.json': { name: 'fixture-app', scripts: { test: 'node check.js' } },
  'packages/app/check.js': 'throw new Error("availability must not execute this file");\n',
  'packages/other/package.json': { name: 'fixture-other', scripts: { test: 'node other.js' } },
  'packages/other/other.js': 'throw new Error("availability must not execute this file");\n',
});

describe('Windows admission uses the configured launcher contract', () => {
  it('chooses CMD ahead of an adjacent Unix shim without requiring Bash', async () => {
    const root = await fixture();
    const tools = path.join(root, 'tools');
    await put(root, 'tools/npx', '#!/ape-missing-bash\nexit 1\n', true);
    const cmd = await put(root, 'tools/npx.CMD', '@echo off\r\nexit /b 1\r\n', true);
    const options = { platform: 'win32', env: { Path: `"${tools}"`, Pathext: '.COM;.EXE;.BAT;.CMD' } };
    expect(await resolveAdmissionExecutableFact(root, 'npx', options)).toEqual({ declared: cmd, resolved: cmd });
    expect(await inspect(root, 'npx vitest run', options)).toEqual([]);
    await rm(cmd);
    expect(await resolveAdmissionExecutableFact(root, 'npx', options)).toBeNull();
  });

  it.each(['mvnw.cmd', 'gradlew.bat'])('finds configured %s in its working directory before PATH', async (wrapper) => {
    const root = await fixture();
    const local = await put(root, wrapper, '@echo off\r\n', true);
    await put(root, `tools/${wrapper}`, '@echo off\r\n', true);
    const options = { platform: 'win32', env: { PATH: path.join(root, 'tools') } };
    expect((await resolveAdmissionExecutableFact(root, wrapper, options)).resolved).toBe(local);
    expect(await inspect(root, `${wrapper} test`, options)).toEqual([]);
  });

  it('keeps POSIX PATH ordering and does not admit a CMD for a direct Windows launch', async () => {
    const root = await fixture();
    const local = await put(root, 'custom', '#!/bin/sh\n', true);
    const external = await put(root, 'tools/custom', '#!/bin/sh\n', true);
    await put(root, 'tools/custom.CMD', '@echo off\r\n', true);
    expect((await resolveAdmissionExecutableFact(root, 'custom', { platform: 'linux', env: { PATH: path.join(root, 'tools') } })).resolved).toBe(external);
    expect((await resolveAdmissionExecutableFact(root, './custom', { platform: 'linux', env: { PATH: '' } })).resolved).toBe(local);
    expect(await resolveAdmissionExecutableFact(root, 'custom', { platform: 'win32', env: { PATH: path.join(root, 'tools') } })).toBeNull();
  });

  it('recognizes Windows package-shell builtins without inventing executable files', async () => {
    const root = await fixture();
    await put(root, 'tools/npm.CMD', '@echo off\r\n', true);
    const options = { platform: 'win32', env: { PATH: path.join(root, 'tools') } };
    for (const pretest of ['copy /Y fixture.json copy.json', 'mkdir build', 'DIR /b']) {
      await put(root, 'package.json', JSON.stringify({ scripts: { pretest, test: 'echo fixture' } }));
      expect(await inspect(root, 'npm test', options), pretest).toEqual([]);
    }
    expect(packageShellInvocation(['copy', 'a', 'b'], {}, { platform: 'linux' }).builtin).toBe(false);
    expect(packageShellInvocation(['copy', 'a', 'b'], {}, { platform: 'win32', scriptShell: 'bash' }).builtin).toBe(false);
    expect(packageShellInvocation(['NODE_ENV=test', 'node', 'check.js'], {}, { platform: 'win32' }).argv[0]).toBe('NODE_ENV=test');
  });

  it('inspects case-insensitive Windows npm launcher names without changing POSIX names', async () => {
    const root = await fixture({ 'package.json': { scripts: { test: 'node unavailable.js' } } });
    await put(root, 'tools/NPM.CmD', '@echo off\r\n', true);
    await put(root, 'tools/node.EXE', 'synthetic native executable header\n', true);
    const options = { platform: 'win32', env: { PATH: path.join(root, 'tools') } };
    expect(await inspect(root, 'NPM.CmD test', options)).toContainEqual(expect.objectContaining({ cause: 'entry-script-missing', expected_path: 'unavailable.js', package_script: 'test' }));
    expect(packageScript(['NPM.CmD', 'test'], root, {}, { platform: 'linux' })).toBeNull();
    const base = baseline(root);
    await put(root, 'unavailable.js', 'throw new Error("never executed");\n'); commit(root);
    expect(await compare(root, base, 'NPM.CmD test', options)).toContainEqual(expect.objectContaining({ paths: ['unavailable.js'] }));
  });
});

describe('package command selection is shared by current and base inspection', () => {
  it('adds ancestor npm bins in nearest-first order using the platform delimiter', async () => {
    const root = await fixture();
    const packageRoot = path.join(root, 'packages', 'app');
    const env = await packageScriptEnvironment(packageRoot, { Path: '/synthetic/tools', OTHER: 'kept' }, 'win32');
    expect(env.Path).toBeUndefined();
    expect(env.OTHER).toBe('kept');
    expect(env.PATH.split(';').slice(0, 3)).toEqual([
      path.join(packageRoot, 'node_modules', '.bin'), path.join(root, 'packages', 'node_modules', '.bin'), path.join(root, 'node_modules', '.bin'),
    ]);
    expect(env.PATH.split(';').at(-1)).toBe('/synthetic/tools');
  });

  it('resolves a workspace script from hoisted bins and compares the selected tracked entry', async () => {
    const root = await fixture({ 'packages/app/package.json': { scripts: { test: 'ape-fixture-bin' } } });
    await put(root, 'tools/check', '#!/bin/sh\nexit 1\n', true);
    await mkdir(path.join(root, 'node_modules', '.bin'), { recursive: true });
    await symlink('../../tools/check', path.join(root, 'node_modules', '.bin', 'ape-fixture-bin'));
    const base = baseline(root);
    expect(await inspect(root, 'npm test', {}, 'packages/app')).toEqual([]);
    await put(root, 'tools/check', '#!/bin/sh\nexit 2\n', true); commit(root);
    expect(await compare(root, base, 'npm test', {}, 'packages/app')).toContainEqual(expect.objectContaining({ code: 'baseline-command-prerequisite-drift', paths: ['tools/check'] }));
  });

  it.each(['npm test --workspace=packages/app', 'npm --workspace fixture-app test', 'npm -w ./packages/app test', 'npm test --workspaces', 'npm test -ws', 'npm test --workspace=packages'])('selects actual workspace packages for %s', async (command) => {
    const root = await fixture(workspaceFixture());
    const base = baseline(root);
    await put(root, 'README.md', 'unrelated feature\n'); commit(root);
    const index = await readFile(path.join(root, '.git', 'index'));
    expect(await inspect(root, command)).toEqual([]);
    expect(await compare(root, base, command)).toEqual([]);
    expect(await readFile(path.join(root, '.git', 'index'))).toEqual(index);
  });

  it('compares selected workspace entries while ignoring an unselected workspace script', async () => {
    const root = await fixture(workspaceFixture());
    const base = baseline(root);
    await put(root, 'packages/other/other.js', 'throw new Error("changed other");\n'); commit(root);
    expect(await compare(root, base, 'npm test --workspace=fixture-app')).toEqual([]);
    await put(root, 'packages/app/check.js', 'throw new Error("changed selected");\n'); commit(root);
    expect(await compare(root, base, 'npm test --workspace=fixture-app')).toContainEqual(expect.objectContaining({ paths: ['packages/app/check.js'] }));
  });

  it.each([
    'npm test --workspaces --workspace=fixture-app',
    'npm test --workspace=missing --workspace=fixture-app',
  ])('keeps the nonempty workspace filter union for %s', async (command) => {
    const files = workspaceFixture();
    files['packages/other/package.json'].scripts.test = 'node unavailable-other.js';
    const root = await fixture(files);
    const base = baseline(root);
    await put(root, 'packages/other/other.js', 'throw new Error("unselected change");\n'); commit(root);

    expect(await inspect(root, command)).toEqual([]);
    expect(await compare(root, base, command)).toEqual([]);

    await put(root, 'packages/app/check.js', 'throw new Error("selected change");\n'); commit(root);
    expect(await compare(root, base, command)).toContainEqual(expect.objectContaining({ paths: ['packages/app/check.js'] }));
    await rm(path.join(root, 'packages/app/check.js'));
    expect(await inspect(root, command)).toContainEqual(expect.objectContaining({ cause: 'entry-script-missing', expected_path: 'packages/app/check.js' }));
  });

  it('allows an unmatched workspace filter when the requested root makes the selection nonempty', async () => {
    const files = workspaceFixture();
    files['package.json'].scripts = { test: 'node --version' };
    const root = await fixture(files);
    const base = baseline(root);
    await put(root, 'packages/app/check.js', 'throw new Error("unselected change");\n'); commit(root);
    const command = 'npm test --workspace=missing --include-workspace-root';

    expect(await inspect(root, command)).toEqual([]);
    expect(await compare(root, base, command)).toEqual([]);
    expect(await inspect(root, 'npm test --workspace=missing')).toContainEqual(expect.objectContaining({ cause: 'package-workspace-missing' }));
  });

  it('detects a selected workspace missing on the base and identifies missing current scripts', async () => {
    const files = workspaceFixture();
    const root = await fixture({ 'package.json': files['package.json'], 'packages/other/package.json': files['packages/other/package.json'], 'packages/other/other.js': files['packages/other/other.js'] });
    const base = baseline(root);
    await put(root, 'packages/app/package.json', JSON.stringify(files['packages/app/package.json']));
    await put(root, 'packages/app/check.js', files['packages/app/check.js']); commit(root);
    expect(await compare(root, base, 'npm test --workspace=fixture-app')).toContainEqual(expect.objectContaining({ code: 'baseline-command-prerequisite-drift' }));
    await put(root, 'packages/app/package.json', JSON.stringify({ name: 'fixture-app' }));
    expect(await inspect(root, 'npm test --workspace=fixture-app')).toContainEqual(expect.objectContaining({ cause: 'package-script-missing', expected_path: 'packages/app/package.json' }));
    expect(await inspect(root, 'npm test --workspace=missing')).toContainEqual(expect.objectContaining({ cause: 'package-workspace-missing' }));
    expect(await inspect(root, 'npm test --workspace=fixture-app --if-present')).toEqual([]);
  });

  it('includes root scripts only when requested and honors repeated workspace selection', async () => {
    const root = await fixture(workspaceFixture());
    expect(await inspect(root, 'npm test --workspace=fixture-app --workspace=fixture-other')).toEqual([]);
    expect(await inspect(root, 'npm test --workspaces --include-workspace-root')).toContainEqual(expect.objectContaining({ cause: 'package-script-missing', expected_path: 'package.json' }));
    expect(await inspect(root, 'npm test --workspaces --include-workspace-root --if-present')).toEqual([]);
  });

  it('supports bounded workspace globs and exclusions without following outside symlinks', async () => {
    const files = workspaceFixture();
    files['package.json'].workspaces = ['packages/**', '!packages/other'];
    const root = await fixture(files);
    await symlink('app/check.js', path.join(root, 'packages', 'entry-link'));
    expect(await inspect(root, 'npm test --workspaces')).toEqual([]);
    expect(await inspect(root, 'npm test --workspace=fixture-other')).toContainEqual(expect.objectContaining({ cause: 'package-workspace-missing' }));
    const outside = await fixture({ 'package.json': { name: 'outside', scripts: { test: 'echo fixture' } } });
    await symlink(outside, path.join(root, 'packages', 'outside'));
    expect(await inspect(root, 'npm test --workspaces')).toContainEqual(expect.objectContaining({ cause: expect.stringMatching(/unsafe-link/) }));
  });

  it.each([
    ['packages/*', '!packages/app', 'packages/app'],
    ['packages/*', '!packages/*', 'packages/app'],
    ['packages/*', '!!!packages/app', '!!packages/app'],
  ])('honors workspace reinclusion in ordered declarations %j', async (...workspaces) => {
    const files = workspaceFixture();
    files['package.json'].workspaces = workspaces;
    const root = await fixture(files);
    const base = baseline(root);
    await put(root, 'packages/app/check.js', 'throw new Error("reincluded change");\n'); commit(root);

    expect(await inspect(root, 'npm test --workspaces')).toEqual([]);
    expect(await inspect(root, 'npm test --workspace=fixture-app')).toEqual([]);
    expect(await compare(root, base, 'npm test --workspaces')).toContainEqual(expect.objectContaining({ paths: ['packages/app/check.js'] }));
    await rm(path.join(root, 'packages/app/check.js'));
    expect(await inspect(root, 'npm test --workspaces')).toContainEqual(expect.objectContaining({ cause: 'entry-script-missing', expected_path: 'packages/app/check.js' }));
  });

  it('skips suppressed npm pre/post hooks on current and base, including nested invocations', async () => {
    const root = await fixture({ 'package.json': { scripts: {
      pretest: 'node missing-pre.js', test: 'npm run leaf', posttest: 'node missing-post.js',
      preleaf: 'node missing-preleaf.js', leaf: 'node leaf.js', postleaf: 'node missing-postleaf.js',
    } }, 'leaf.js': 'throw new Error("not executed");\n' });
    const base = baseline(root);
    await put(root, 'missing-pre.js', 'throw new Error("changed suppressed hook");\n'); commit(root);
    expect(await inspect(root, 'npm --ignore-scripts test')).toEqual([]);
    expect(await compare(root, base, 'npm --ignore-scripts test')).toEqual([]);
    expect(await inspect(root, 'npm test')).toContainEqual(expect.objectContaining({ cause: 'entry-script-missing', package_script: 'preleaf' }));
    await put(root, 'leaf.js', 'throw new Error("changed active script");\n'); commit(root);
    expect(await compare(root, base, 'npm --ignore-scripts test')).toContainEqual(expect.objectContaining({ paths: ['leaf.js'] }));
  });

  it('does not compare changed hook definitions when ignore-scripts suppresses them', async () => {
    const root = await fixture({ 'package.json': { scripts: { pretest: 'node old-pre.js', test: 'node --version' } } });
    const base = baseline(root);
    await put(root, 'package.json', JSON.stringify({ scripts: { pretest: 'node new-pre.js', test: 'node --version' } })); commit(root);
    expect(await compare(root, base, 'npm test --ignore-scripts')).toEqual([]);
    expect(await compare(root, base, 'npm test --ignore-scripts=false')).toContainEqual(expect.objectContaining({ paths: ['package.json'] }));
  });

  it.each(['NPM_CONFIG_IGNORE_SCRIPTS', 'NpM_ConFiG_Ignore_Scripts'])('honors %s on current and base inspection', async (key) => {
    const root = await fixture({ 'package.json': { scripts: { pretest: 'node unavailable.js', test: 'node check.js' } }, 'check.js': 'throw new Error("not executed");\n' });
    const base = baseline(root);
    await put(root, 'package.json', JSON.stringify({ scripts: { pretest: 'node changed-unavailable.js', test: 'node check.js' } })); commit(root);
    const options = { env: { ...defaultEnv(), [key]: ' true ' } };

    expect(await inspect(root, 'npm test', options)).toEqual([]);
    expect(await compare(root, base, 'npm test', options)).toEqual([]);
    expect(await inspect(root, 'npm test --ignore-scripts=false', options)).toContainEqual(expect.objectContaining({ cause: 'entry-script-missing', package_script: 'pretest' }));
    expect(await compare(root, base, 'npm test --ignore-scripts=false', options)).toContainEqual(expect.objectContaining({ paths: ['package.json'] }));
  });

  it('uses normalized workspace environment filters and lets CLI filters replace them', async () => {
    const files = workspaceFixture();
    files['packages/other/package.json'].scripts.test = 'node unavailable-other.js';
    const root = await fixture(files);
    const base = baseline(root);
    await put(root, 'packages/other/other.js', 'throw new Error("unselected change");\n'); commit(root);
    const options = { env: { ...defaultEnv(), NPM_CONFIG_WORKSPACES: 'true', NPM_CONFIG_WORKSPACE: 'fixture-app', NPM_CONFIG_SCRIPT_SHELL: 'sh' } };

    expect(await inspect(root, 'npm test', options)).toEqual([]);
    expect(await compare(root, base, 'npm test', options)).toEqual([]);
    expect(await inspect(root, 'npm test --workspace=fixture-other', options)).toContainEqual(expect.objectContaining({ cause: 'entry-script-missing', expected_path: 'packages/other/unavailable-other.js' }));
    expect(await inspect(root, 'npm test', { env: { ...options.env, NPM_CONFIG_INCLUDE_WORKSPACE_ROOT: 'true' } })).toContainEqual(expect.objectContaining({ cause: 'package-script-missing', expected_path: 'package.json' }));
    expect(await inspect(root, 'npm test', { env: { ...options.env, NPM_CONFIG_INCLUDE_WORKSPACE_ROOT: 'true', NPM_CONFIG_IF_PRESENT: 'true' } })).toEqual([]);
  });

  it('distinguishes repeated nested commands with different uppercase npm environment settings', async () => {
    const root = await fixture({ 'package.json': { scripts: {
      pretest: 'env NPM_CONFIG_IGNORE_SCRIPTS=true npm run leaf',
      test: 'env NPM_CONFIG_IGNORE_SCRIPTS=false npm run leaf',
      preleaf: 'node unavailable-preleaf.js', leaf: 'node --version',
    } } });

    expect(await inspect(root, 'npm test')).toContainEqual(expect.objectContaining({ cause: 'entry-script-missing', package_script: 'preleaf' }));
  });

  it('matches npm environment spelling precedence and workspace list encoding', () => {
    const parse = (env, command = 'npm test') => packageScript(splitCommand(command), '/fixture', env);
    expect(parse({ npm_config_ignore_scripts: 'false', NPM_CONFIG_IGNORE_SCRIPTS: 'true' }).ignoreScripts).toBe(true);
    expect(parse({ NPM_CONFIG_IGNORE_SCRIPTS: 'true', npm_config_ignore_scripts: 'false' }).ignoreScripts).toBe(false);
    expect(parse({ NPM_CONFIG_IGNORE_SCRIPTS: 'true', npm_config_ignore_scripts: '' }).ignoreScripts).toBe(true);
    expect(parse({ NPM_CONFIG_IGNORE_SCRIPTS: 'true' }, 'npm test --ignore-scripts=false').ignoreScripts).toBe(false);
    expect(parse({ NPM_CONFIG_IF_PRESENT: 'true', NPM_CONFIG_INCLUDE_WORKSPACE_ROOT: 'true', NPM_CONFIG_SCRIPT_SHELL: 'cmd.exe', NPM_CONFIG_WORKSPACE: 'fixture-app\n\nfixture-other' })).toMatchObject({ ifPresent: true, includeWorkspaceRoot: true, scriptShell: 'cmd.exe', workspaces: ['fixture-app', 'fixture-other'] });
    expect(parse({ NPM_CONFIG_WORKSPACE: 'missing' }, 'npm test -w fixture-app -w fixture-other').workspaces).toEqual(['fixture-app', 'fixture-other']);
    expect(() => parse({ NPM_CONFIG_WORKSPACES: 'false', NPM_CONFIG_WORKSPACE: 'fixture-app' })).toThrow('package-workspace-disabled');
    expect(parse({ NPM_CONFIG_WORKSPACES: 'false', NPM_CONFIG_WORKSPACE: 'fixture-app' }, 'npm test --workspaces').allWorkspaces).toBe(true);
  });

  it.each([
    [{ NPM_CONFIG_IGNORE_SCRIPTS: 'true' }, true],
    [{ npm_config_ignore_scripts: 'false', NPM_CONFIG_IGNORE_SCRIPTS: 'true' }, true],
    [{ NPM_CONFIG_IGNORE_SCRIPTS: 'true', npm_config_ignore_scripts: 'false' }, false],
    [{ npm_config_ignore_scripts: 'true' }, false],
  ])('matches npm child config exports with inherited aliases %j', async (env, childIgnores) => {
    const parent = packageScript(splitCommand('npm test --ignore-scripts=false'), '/fixture', env);
    const childEnv = await packageInvocationEnvironment('/fixture', parent, env);
    expect(parent.ignoreScripts).toBe(false);
    expect(packageScript(splitCommand('npm run leaf'), '/fixture', childEnv).ignoreScripts).toBe(childIgnores);
  });

  it('keeps inherited alias suppression for nested npm after a false parent override', async () => {
    const root = await fixture({ 'package.json': { scripts: {
      test: 'npm run leaf', preleaf: 'node unavailable-preleaf.js', leaf: 'node --version',
    } } });
    const base = baseline(root);
    await put(root, 'package.json', JSON.stringify({ scripts: { test: 'npm run leaf', preleaf: 'node changed-unavailable-preleaf.js', leaf: 'node --version' } })); commit(root);
    const options = { env: { ...defaultEnv(), NPM_CONFIG_IGNORE_SCRIPTS: 'true' } };

    expect(await inspect(root, 'npm test --ignore-scripts=false', options)).toEqual([]);
    expect(await compare(root, base, 'npm test --ignore-scripts=false', options)).toEqual([]);
  });

  it('keeps alias order in current and base traversal when it changes a nested command', async () => {
    const scripts = {
      pretest: 'env npm_config_ignore_scripts=false NPM_CONFIG_IGNORE_SCRIPTS=true npm run leaf --ignore-scripts=false',
      test: 'env NPM_CONFIG_IGNORE_SCRIPTS=true npm_config_ignore_scripts=false npm run leaf --ignore-scripts=false',
      leaf: 'npm run deep', predeep: 'node unavailable-deep.js', deep: 'node --version',
    };
    const root = await fixture({ 'package.json': { scripts } });
    const base = baseline(root);
    await put(root, 'package.json', JSON.stringify({ scripts: { ...scripts, predeep: 'node changed-unavailable-deep.js' } })); commit(root);

    expect(await inspect(root, 'npm test')).toContainEqual(expect.objectContaining({ cause: 'entry-script-missing', package_script: 'predeep' }));
    expect(await compare(root, base, 'npm test')).toContainEqual(expect.objectContaining({ paths: ['package.json'] }));
  });

  it('uses flags only before forwarding and preserves explicit boolean overrides', () => {
    const root = '/fixture';
    expect(packageScript(splitCommand('npm test -- --workspace=missing --ignore-scripts'), root, {})).toMatchObject({ workspaces: [], ignoreScripts: false });
    expect(packageScript(splitCommand('npm --ignore-scripts=false test'), root, { npm_config_ignore_scripts: 'true' })).toMatchObject({ ignoreScripts: false });
    expect(packageScript(splitCommand('npm --no-ignore-scripts test'), root, { npm_config_ignore_scripts: 'true' })).toMatchObject({ ignoreScripts: false });
  });

  it.each(['npm run --silent test', 'npm --loglevel silent test', 'npm run --loglevel=warn test', 'npm run -- test', 'npm -- test', 'npm t', 'npm tst', 'npm rum test', 'npm urn test', 'npm runScript test'])('retains script selection through ordinary option placement: %s', async (command) => {
    const root = await fixture({ 'package.json': { scripts: { test: 'node missing.js' } } });
    const base = baseline(root);
    await put(root, 'package.json', JSON.stringify({ scripts: { test: 'node changed-missing.js' } })); commit(root);

    expect(await inspect(root, command)).toContainEqual(expect.objectContaining({ cause: 'entry-script-missing', expected_path: 'changed-missing.js' }));
    expect(await compare(root, base, command)).toContainEqual(expect.objectContaining({ paths: ['package.json'] }));
  });

  it.each(['npm --script-she=/missing test', 'npm test --unknown-option', 'npm run test --loglevel', 'npm --prefix', 'npm test --ignore-scripts=true=false'])('refuses ambiguous or malformed npm options explicitly: %s', async (command) => {
    const root = await fixture({ 'package.json': { scripts: { test: 'node --version' } } });
    expect(() => packageScript(splitCommand(command), root, {})).toThrow('package-option-unrepresentable');
    expect(await inspect(root, command)).toContainEqual(expect.objectContaining({ cause: 'command-unrepresentable' }));
  });

  it.each(['npm tes', 'npm run-s test', 'npm ru test'])('refuses unsupported script-command prefixes without skipping admission: %s', async (command) => {
    const root = await fixture({ 'package.json': { scripts: { test: 'node missing.js' } } });
    const base = baseline(root);
    await put(root, 'README.md', 'changed\n'); commit(root);
    expect(() => packageScript(splitCommand(command), root, {})).toThrow('package-command-unrepresentable');
    expect(await inspect(root, command)).toContainEqual(expect.objectContaining({ cause: 'command-unrepresentable' }));
    expect(await compare(root, base, command)).toContainEqual(expect.objectContaining({ code: 'baseline-prerequisites-unavailable' }));
  });

  it('preserves exact non-script npm commands and overlapping non-script aliases', () => {
    for (const verb of ['install', 'exec', 'cache', 'team', 'token', 'star', 'stars', 'r', 's']) {
      expect(packageScript(splitCommand(`npm ${verb} fixture`), '/fixture', {}), verb).toBeNull();
    }
  });

  it('distinguishes nested PATH aliases while ignoring repeated lookup entries for cycle identity', async () => {
    const root = await fixture({ 'package.json': { scripts: {
      pretest: 'env Path=./a npm run leaf', test: 'env Path=./b npm run leaf', leaf: 'ape-path-choice', cycle: 'npm run cycle',
    } } });
    await put(root, 'a/ape-path-choice', '#!/bin/sh\nexit 0\n', true);
    await put(root, 'b/ape-path-choice', '#!/bin/sh\nexit 0\n', true);
    const env = Object.fromEntries(Object.entries(defaultEnv()).filter(([key]) => !/^path$/i.test(key)));
    env.PATH = process.env.PATH;
    const options = { env };
    const base = baseline(root);
    await put(root, 'b/ape-path-choice', '#!/bin/sh\n# selected change\nexit 0\n', true); commit(root);
    expect(await inspect(root, 'npm test', options)).toEqual([]);
    expect(await compare(root, base, 'npm test', options)).toContainEqual(expect.objectContaining({ paths: ['b/ape-path-choice'] }));
    expect(await inspect(root, 'npm run cycle', options)).toContainEqual(expect.objectContaining({ cause: 'package-script-cycle', package_script: 'cycle' }));
    await rm(path.join(root, 'b/ape-path-choice'));
    expect(await inspect(root, 'npm test', options)).toContainEqual(expect.objectContaining({ cause: 'command-executable-missing', package_script: 'leaf' }));
  });

  it('checks an explicit shell even for builtin script commands and preserves empty no-ops', async () => {
    const root = await fixture({ 'package.json': { scripts: { test: 'echo fixture', empty: '' } } });
    for (const command of ['npm test --script-shell=/ape-synthetic-missing-shell', 'npm test']) {
      const options = command === 'npm test' ? { env: { ...defaultEnv(), npm_config_script_shell: '/ape-synthetic-missing-shell' } } : {};
      expect(await inspect(root, command, options)).toContainEqual(expect.objectContaining({ cause: 'package-shell-missing', package_script: 'test' }));
    }
    expect(await inspect(root, 'npm run empty --script-shell=/ape-synthetic-missing-shell')).toEqual([]);
  });

  it('compares a tracked explicit shell on the base independently of a builtin script head', async () => {
    const root = await fixture({ 'package.json': { scripts: { test: 'echo fixture' } } });
    await put(root, 'tools/shell.sh', '#!/bin/sh\nexec /bin/sh "$@"\n', true);
    const base = baseline(root);
    await put(root, 'tools/shell.sh', '#!/bin/sh\n# changed shell\nexec /bin/sh "$@"\n', true); commit(root);
    const command = 'npm test --script-shell=./tools/shell.sh';
    expect(await inspect(root, command)).toEqual([]);
    expect(await compare(root, base, command)).toContainEqual(expect.objectContaining({ paths: ['tools/shell.sh'] }));
  });

  it('discovers the workspace ancestor from a configured workspace root and selects a sibling', async () => {
    const root = await fixture(workspaceFixture());
    const base = baseline(root);
    await put(root, 'packages/app/check.js', 'throw new Error("unselected change");\n'); commit(root);
    const command = 'npm test --workspace=fixture-other';
    expect(await inspect(root, command, {}, 'packages/app')).toEqual([]);
    expect(await compare(root, base, command, {}, 'packages/app')).toEqual([]);
    await put(root, 'packages/other/other.js', 'throw new Error("selected change");\n'); commit(root);
    expect(await compare(root, base, command, {}, 'packages/app')).toContainEqual(expect.objectContaining({ paths: ['packages/other/other.js'] }));
    await rm(path.join(root, 'packages/other/other.js'));
    expect(await inspect(root, command, {}, 'packages/app')).toContainEqual(expect.objectContaining({ cause: 'entry-script-missing', expected_path: 'packages/other/other.js' }));
  });

  it('retains the implicit nearest workspace filter with --workspaces and honors no-workspaces', async () => {
    const root = await fixture(workspaceFixture());
    const base = baseline(root);
    await put(root, 'packages/other/other.js', 'throw new Error("unselected change");\n'); commit(root);
    expect(await inspect(root, 'npm test --workspaces', {}, 'packages/app')).toEqual([]);
    expect(await compare(root, base, 'npm test --workspaces', {}, 'packages/app')).toEqual([]);
    expect(await inspect(root, 'npm test --no-workspaces', {}, 'packages/app')).toEqual([]);
    await put(root, 'packages/app/check.js', 'throw new Error("selected change");\n'); commit(root);
    expect(await compare(root, base, 'npm test --workspaces', {}, 'packages/app')).toContainEqual(expect.objectContaining({ paths: ['packages/app/check.js'] }));
  });

  it('uses the final CLI prefix relative to the original cwd and does not discover workspaces for a forced prefix', async () => {
    const root = await fixture({
      'package.json': { private: true, workspaces: ['a', 'b'] },
      'a/package.json': { name: 'fixture-a', scripts: { test: 'node missing-a.js' } },
      'b/package.json': { name: 'fixture-b', scripts: { test: 'node check.js' } },
      'b/check.js': 'throw new Error("not executed");\n',
    });
    const base = baseline(root);
    const command = 'npm --prefix a --prefix b test';
    expect(packageScript(splitCommand(command), root, {}).root).toBe(path.join(root, 'b'));
    expect(await inspect(root, command)).toEqual([]);
    expect(await compare(root, base, command)).toEqual([]);
    await put(root, 'b/check.js', 'throw new Error("selected change");\n'); commit(root);
    expect(await compare(root, base, command)).toContainEqual(expect.objectContaining({ paths: ['b/check.js'] }));
    expect(await inspect(root, 'npm --prefix missing test')).toContainEqual(expect.objectContaining({ cause: 'package-manifest-missing', expected_path: 'missing/package.json' }));
  });

  it('allows npm empty script and hook no-ops while preserving an actual missing script diagnostic', async () => {
    const root = await fixture({ 'package.json': { scripts: { test: '', pretest: '', posttest: '' } } });
    const base = baseline(root);
    expect(await inspect(root, 'npm test')).toEqual([]);
    await put(root, 'package.json', JSON.stringify({ scripts: { test: '' } })); commit(root);
    expect(await compare(root, base, 'npm test')).toEqual([]);
    await put(root, 'package.json', JSON.stringify({ scripts: { pretest: '', posttest: '' } }));
    expect(await inspect(root, 'npm test')).toContainEqual(expect.objectContaining({ cause: 'package-script-missing', package_script: 'test' }));
  });

  it('retains the selected npm installation through nested baseline traversal and compares its tracked bundled bin', async () => {
    const root = await fixture({ 'package.json': { scripts: { test: 'npm run leaf', leaf: 'node-gyp --version' } } });
    const installation = 'installation/lib/node_modules/npm';
    await put(root, `${installation}/package.json`, JSON.stringify({ name: 'npm', bin: { npm: 'bin/npm-cli.js' } }));
    await put(root, `${installation}/bin/npm-cli.js`, '#!/usr/bin/env node\nthrow new Error("never execute fixture npm");\n', true);
    const runScript = `${installation}/node_modules/@npmcli/run-script`;
    await put(root, `${runScript}/package.json`, JSON.stringify({ name: '@npmcli/run-script', main: 'index.js' }));
    await put(root, `${runScript}/index.js`, 'throw new Error("never load fixture npm module");\n');
    const bundledBin = `${runScript}/lib/node-gyp-bin/node-gyp`;
    await put(root, bundledBin, '#!/bin/sh\nexit 0\n', true);
    await mkdir(path.join(root, 'tools'));
    await symlink(`../${installation}/bin/npm-cli.js`, path.join(root, 'tools/npm'));
    const options = { env: { ...defaultEnv(), PATH: `${path.join(root, 'tools')}${path.delimiter}${process.env.PATH}` } };
    const base = baseline(root);
    await put(root, bundledBin, '#!/bin/sh\n# changed bundled tool\nexit 0\n', true); commit(root);
    expect(await inspect(root, 'npm test', options)).toEqual([]);
    expect(await compare(root, base, 'npm test', options)).toContainEqual(expect.objectContaining({ paths: [bundledBin] }));
  });
});
