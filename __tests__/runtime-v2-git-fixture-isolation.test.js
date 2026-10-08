import { afterEach, describe, expect, it } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { runNativeJson } from '../test-support/native-process.js';
import { fixtureGit, packagedFixtureEnv } from './recovery-pagination-test-helper.js';

const roots = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const nul = process.platform === 'win32' ? 'NUL' : '/dev/null';
const quote = (value) => JSON.stringify(value.replaceAll('\\', '/'));

async function builder() {
  // A missing implementation must fail a collected assertion, not collection.
  const url = new URL('../test-support/git-fixtures.js', import.meta.url).href;
  const module = await import(/* @vite-ignore */ url).catch(() => ({}));
  expect(module.gitFixtureEnv, 'shared fixture environment API').toBeTypeOf('function');
  return module.gitFixtureEnv;
}

function fixture() {
  const root = mkdtempSync(path.join(tmpdir(), 'ape-git-isolation-'));
  roots.push(root);
  const dir = (name) => { const p = path.join(root, name); mkdirSync(p, { recursive: true }); return p; };
  const home = dir('home');
  const xdg = dir('xdg');
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^GIT_/i.test(key)));
  Object.assign(env, { HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: xdg,
    GIT_CONFIG_GLOBAL: nul, GIT_CONFIG_SYSTEM: nul, GIT_CONFIG_NOSYSTEM: '1',
    GIT_AUTHOR_NAME: 'Control Author', GIT_AUTHOR_EMAIL: 'control@example.invalid',
    GIT_COMMITTER_NAME: 'Control Author', GIT_COMMITTER_EMAIL: 'control@example.invalid',
    GIT_TERMINAL_PROMPT: '0', GIT_TEMPLATE_DIR: '' });
  return { root, dir, env, home, xdg };
}

function git(cwd, env, ...args) {
  return execFileSync('git', args, { cwd, env, encoding: 'utf8', timeout: 10000, stdio: ['ignore', 'pipe', 'pipe'] });
}

function commit(dir, env) {
  git(dir, env, 'init', '-q');
  writeFileSync(path.join(dir, 'payload.txt'), 'fixture bytes\n');
  git(dir, env, 'add', '--', 'payload.txt');
  git(dir, env, 'commit', '-qm', 'fixture');
  git(dir, env, 'branch', 'fixture-branch');
  return {
    branch: git(dir, env, 'branch', '--show-current').trim(),
    identity: git(dir, env, 'log', '-1', '--format=%an <%ae>|%cn <%ce>').trim(),
    contents: git(dir, env, 'show', 'fixture-branch:payload.txt'),
  };
}

function treeBytes(root) {
  const result = {};
  function visit(dir, prefix = '') {
    for (const item of readdirSync(dir, { withFileTypes: true })) {
      const rel = `${prefix}${item.name}`;
      if (item.isDirectory()) visit(path.join(dir, item.name), `${rel}/`);
      else result[rel] = readFileSync(path.join(dir, item.name)).toString('base64');
    }
  }
  visit(root);
  return result;
}

function hostileFiles(f) {
  const hooks = f.dir('hostile hooks');
  const template = f.dir('hostile template');
  const hookMarker = path.join(f.root, 'hook-ran');
  const signerMarker = path.join(f.root, 'signer-ran');
  // Git executes hooks with its shell; marker files are exclusively test-owned.
  const hook = `#!/bin/sh\nprintf ran > '${hookMarker.replaceAll("'", "'\\''")}'\nexit 31\n`;
  writeFileSync(path.join(hooks, 'pre-commit'), hook, { mode: 0o755 });
  chmodSync(path.join(hooks, 'pre-commit'), 0o755);
  mkdirSync(path.join(template, 'hooks'));
  writeFileSync(path.join(template, 'hooks', 'pre-commit'), hook, { mode: 0o755 });
  writeFileSync(path.join(template, 'injected-template'), 'ambient template\n');
  const signer = path.join(f.root, 'hostile-signer');
  writeFileSync(signer, `#!/bin/sh\nprintf ran > '${signerMarker.replaceAll("'", "'\\''")}'\nexit 32\n`, { mode: 0o755 });
  const include = path.join(f.root, 'included-config');
  const config = `[user]\n name = Ambient User\n email = ambient@example.invalid\n[init]\n defaultBranch = ambient-branch\n templateDir = ${quote(template)}\n[core]\n hooksPath = ${quote(hooks)}\n autocrlf = true\n[commit]\n gpgSign = true\n[tag]\n gpgSign = true\n[gpg]\n program = ${quote(signer)}\n`;
  writeFileSync(include, config);
  const global = path.join(f.home, '.gitconfig');
  const system = path.join(f.root, 'system-config');
  const xdg = path.join(f.dir('xdg/git'), 'config');
  for (const file of [global, system, xdg]) writeFileSync(file, `[include]\n path = ${quote(include)}\n`);
  return { hooks, template, signer, hookMarker, signerMarker, global, system,
    configBytes: Object.fromEntries([include, global, system, xdg].map((file) => [file, readFileSync(file, 'utf8')])) };
}

describe('shared Git fixture child environment', () => {
  it.each(['config', 'malformed', 'redirect'])('isolates recovery/pagination Git entry points from %s inputs', async (kind) => {
    const build = await builder();
    const f = fixture();
    const h = hostileFiles(f);
    const decoy = f.dir('decoy');
    commit(decoy, build(f.env));
    const decoyBefore = treeBytes(decoy);
    const parent = { ...process.env };
    const poison = Object.freeze({ ...f.env,
      ...(kind === 'config' ? { GIT_CONFIG_GLOBAL: h.global, GIT_CONFIG_SYSTEM: h.system,
        GIT_CONFIG_NOSYSTEM: '0', GIT_TEMPLATE_DIR: h.template } : {}),
      ...(kind === 'malformed' ? { GIT_CONFIG_COUNT: 'not-a-number' } : {}),
      ...(kind === 'redirect' ? { GIT_DIR: path.join(decoy, '.git'), GIT_WORK_TREE: decoy,
        GIT_INDEX_FILE: path.join(decoy, '.git', 'index'), GIT_OBJECT_DIRECTORY: path.join(decoy, '.git', 'objects') } : {}),
    });
    const before = { ...poison };
    const intended = f.dir('intended');
    const invoke = (...args) => fixtureGit(intended, args, {}, poison);
    try {
      invoke('init', '-q');
      writeFileSync(path.join(intended, 'payload.txt'), 'boundary payload\n');
      invoke('add', 'payload.txt');
      invoke('commit', '-qm', 'boundary');
      invoke('branch', 'boundary-branch');
      expect(invoke('branch', '--show-current')).toBe('main');
      expect(invoke('log', '-1', '--format=%an <%ae>|%cn <%ce>')).toBe(
        'APE Test <ape-test@example.invalid>|APE Test <ape-test@example.invalid>');
      expect(git(intended, build(f.env), 'show', 'boundary-branch:payload.txt')).toBe('boundary payload\n');
      expect(realpathSync(invoke('rev-parse', '--show-toplevel'))).toBe(realpathSync(intended));
      expect(() => invoke('rev-parse', '--verify', 'missing-fixture-ref')).toThrow();
    } finally {
      expect(poison).toEqual(before);
      expect(process.env).toEqual(parent);
      expect(treeBytes(decoy)).toEqual(decoyBefore);
      expect(existsSync(h.hookMarker)).toBe(false);
      expect(existsSync(h.signerMarker)).toBe(false);
      for (const [file, bytes] of Object.entries(h.configBytes)) expect(readFileSync(file, 'utf8')).toBe(bytes);
    }
  });

  it('preserves deliberate recovery/pagination identity and index overrides after sanitization', async () => {
    const f = fixture();
    const parent = { ...process.env };
    const poison = Object.freeze({ ...f.env, GIT_CONFIG_COUNT: 'malformed', GIT_DIR: path.join(f.root, 'missing') });
    const before = { ...poison };
    const dir = f.dir('override-repo');
    const invoke = (...args) => fixtureGit(dir, args, {}, poison);
    invoke('init', '-q');
    writeFileSync(path.join(dir, 'payload.txt'), 'original\n');
    invoke('add', 'payload.txt');
    invoke('commit', '-qm', 'original');
    const originalIndex = readFileSync(path.join(dir, '.git', 'index'));
    const env = Object.freeze({ ...packagedFixtureEnv(poison),
      GIT_INDEX_FILE: path.join(f.root, 'intentional-index'),
      GIT_AUTHOR_NAME: 'Explicit Author', GIT_AUTHOR_EMAIL: 'explicit@example.invalid',
      GIT_COMMITTER_NAME: 'Explicit Committer', GIT_COMMITTER_EMAIL: 'committer@example.invalid' });
    const overrideBefore = { ...env };
    const explicit = (...args) => fixtureGit(dir, args, { env }, poison);
    try {
      explicit('read-tree', 'HEAD');
      writeFileSync(path.join(dir, 'payload.txt'), 'override payload\n');
      explicit('add', 'payload.txt');
      expect(readFileSync(path.join(dir, '.git', 'index'))).toEqual(originalIndex);
      explicit('commit', '-qm', 'explicit override');
      expect(invoke('show', 'HEAD:payload.txt')).toBe('override payload');
      expect(invoke('log', '-1', '--format=%an <%ae>|%cn <%ce>')).toBe(
        'Explicit Author <explicit@example.invalid>|Explicit Committer <committer@example.invalid>');
      expect(readFileSync(path.join(dir, '.git', 'index'))).toEqual(originalIndex);
      expect(() => explicit('rev-parse', '--verify', 'missing-fixture-ref')).toThrow();
    } finally {
      expect(env).toEqual(overrideBefore);
      expect(poison).toEqual(before);
      expect(process.env).toEqual(parent);
    }
  });

  it.each(['ape', 'ape-claude'])('isolates the %s recovery/pagination package launch from ambient repository/config overrides', async (hostPackage) => {
    const build = await builder();
    const f = fixture();
    const h = hostileFiles(f);
    const intended = f.dir('intended');
    const decoy = f.dir('decoy');
    commit(intended, build(f.env));
    commit(decoy, build(f.env));
    const decoyBefore = treeBytes(decoy);
    const intendedBefore = treeBytes(intended);
    const parent = { ...process.env };
    const poison = Object.freeze({ ...f.env, GIT_CONFIG_COUNT: 'malformed', GIT_CONFIG_GLOBAL: h.global,
      GIT_CONFIG_SYSTEM: h.system, GIT_CONFIG_NOSYSTEM: '0', GIT_TEMPLATE_DIR: h.template,
      GIT_CONFIG_PARAMETERS: "'commit.gpgSign=true'", GIT_DIR: path.join(decoy, '.git'),
      GIT_WORK_TREE: decoy, GIT_INDEX_FILE: path.join(decoy, '.git', 'index'),
      CODEX_CWD: decoy, CLAUDE_PROJECT_DIR: decoy });
    const before = { ...poison };
    const env = packagedFixtureEnv(poison);
    expect(env).not.toBe(poison);
    expect(packagedFixtureEnv(poison)).not.toBe(env);
    expect(env.CODEX_CWD).toBeUndefined();
    expect(env.CLAUDE_PROJECT_DIR).toBeUndefined();
    const host = hostPackage === 'ape' ? 'codex' : 'claude';
    const entry = new URL(`../plugins/${hostPackage}/dist/ape-mcp.bundle.mjs`, import.meta.url);
    const { fileURLToPath } = await import('node:url');
    const request = { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'ape_run', arguments: {
      project_dir: intended, action: 'preview', host, objective: 'Review isolated fixture', mode: 'phase', lane: 'mechanical',
      behavioral: false, claimed_paths: ['payload.txt'], test_paths: [], hooks_trusted: true,
      subagents_available: true, explicit_invocation: true, admission_contract_version: 1,
    } } };
    try {
      const output = execFileSync(process.execPath, [fileURLToPath(entry), '--host', host], {
        cwd: intended, env, encoding: 'utf8', input: `${JSON.stringify(request)}\n`, timeout: 20000,
      });
      const response = output.trim().split('\n').map(line => JSON.parse(line)).find(item => item.id === 1);
      expect(response.error).toBeUndefined();
      expect(response.result.isError).not.toBe(true);
      const preview = JSON.parse(response.result.content[0].text);
      expect(preview.admission.ready, JSON.stringify(preview)).toBe(true);
      expect(preview.admission.request.objective).toBe('Review isolated fixture');
    } finally {
      expect(process.env).toEqual(parent);
      expect(poison).toEqual(before);
      expect(treeBytes(decoy)).toEqual(decoyBefore);
      expect(treeBytes(intended)).toEqual(intendedBefore);
      expect(existsSync(h.hookMarker)).toBe(false);
      expect(existsSync(h.signerMarker)).toBe(false);
      for (const [file, bytes] of Object.entries(h.configBytes)) expect(readFileSync(file, 'utf8')).toBe(bytes);
    }
  });

  it('copies inputs freshly, removes arbitrary Git residue and preserves parent state on success and failure', async () => {
    const build = await builder();
    const f = fixture();
    const parent = { ...process.env };
    const input = Object.freeze({ ...f.env, KEEP_FIXTURE_VALUE: 'preserved', GIT_ARBITRARY_RESIDUE: 'poison', GIT_CONFIG_COUNT: 'broken' });
    const before = { ...input };
    const first = build(input);
    const second = build(input);
    expect(first).not.toBe(input);
    expect(second).not.toBe(first);
    expect(first.KEEP_FIXTURE_VALUE).toBe('preserved');
    expect(first.PATH).toBe(input.PATH);
    expect(first.GIT_ARBITRARY_RESIDUE).toBeUndefined();
    first.KEEP_FIXTURE_VALUE = 'changed';
    expect(second.KEEP_FIXTURE_VALUE).toBe('preserved');
    const dir = f.dir('repo');
    commit(dir, second);
    expect(() => git(dir, second, 'rev-parse', '--verify', 'missing-ref')).toThrow();
    expect(input).toEqual(before);
    expect(process.env).toEqual(parent);
    expect(build()).not.toBe(process.env);
  });

  it('removes mixed-case Git overrides before handing the environment to a child', async () => {
    const build = await builder();
    const f = fixture();
    const parent = { ...process.env };
    const residue = {
      git_dir: path.join(f.root, 'missing-repository'),
      Git_WORK_TREE: path.join(f.root, 'missing-worktree'),
      gIt_CONFIG_COUNT: 'malformed',
      git_CONFIG_PARAMETERS: "'commit.gpgSign=true'",
      Git_AUTHOR_NAME: 'Injected Author',
    };
    const input = Object.freeze({ ...f.env, ...residue });
    const before = { ...input };
    const env = build(input);
    // Windows environment keys are case-insensitive; inspect the returned
    // object as well so this boundary is exercised on POSIX test hosts.
    for (const key of Object.keys(residue)) expect(env).not.toHaveProperty(key);
    const dir = f.dir('mixed-case');
    expect(commit(dir, env)).toEqual({
      branch: 'main',
      identity: 'APE Test <ape-test@example.invalid>|APE Test <ape-test@example.invalid>',
      contents: 'fixture bytes\n',
    });
    expect(() => git(dir, env, 'rev-parse', '--verify', 'missing-ref')).toThrow();
    expect(input).toEqual(before);
    expect(process.env).toEqual(parent);
  });

  it('keeps commits and annotated tags isolated when local settings change after environment construction', async () => {
    const build = await builder();
    const f = fixture();
    const h = hostileFiles(f);
    const parent = { ...process.env };
    const input = Object.freeze({ ...f.env });
    const before = { ...input };
    const env = build(input);
    const envBefore = { ...env };
    const dir = f.dir('late-local-config');
    git(dir, env, 'init', '-q');
    const config = path.join(dir, '.git', 'config');
    // Install the hostile include after sanitization, immediately before the
    // write sinks. Command-scope protection must still dominate local config.
    const configBytes = `${readFileSync(config, 'utf8')}\n[include]\n path = ${quote(path.join(f.root, 'included-config'))}\n`;
    writeFileSync(config, configBytes);
    writeFileSync(path.join(dir, 'payload.txt'), 'fixture bytes\n');
    git(dir, env, 'add', 'payload.txt');
    git(dir, env, 'commit', '-qm', 'late local settings');
    git(dir, env, 'branch', 'fixture-branch');
    expect(git(dir, env, 'branch', '--show-current').trim()).toBe('main');
    expect(git(dir, env, 'log', '-1', '--format=%an <%ae>|%cn <%ce>').trim()).toBe(
      'APE Test <ape-test@example.invalid>|APE Test <ape-test@example.invalid>');
    expect(git(dir, env, 'show', 'fixture-branch:payload.txt')).toBe('fixture bytes\n');
    git(dir, env, 'tag', '-a', 'fixture-tag', '-m', 'unsigned fixture tag');
    expect(git(dir, env, 'cat-file', '-t', 'fixture-tag').trim()).toBe('tag');
    expect(git(dir, env, 'rev-parse', 'fixture-tag^{}').trim()).toBe(git(dir, env, 'rev-parse', 'HEAD').trim());
    expect(git(dir, env, 'cat-file', '-p', 'fixture-tag')).not.toContain('BEGIN PGP SIGNATURE');
    expect(existsSync(h.hookMarker)).toBe(false);
    expect(existsSync(h.signerMarker)).toBe(false);
    expect(readFileSync(config, 'utf8')).toBe(configBytes);
    for (const [file, bytes] of Object.entries(h.configBytes)) expect(readFileSync(file, 'utf8')).toBe(bytes);
    expect(env).toEqual(envBefore);
    expect(input).toEqual(before);
    expect(process.env).toEqual(parent);
  });

  it.each(['global', 'system', 'home-xdg', 'count', 'parameters', 'malformed-count', 'template', 'combined'])(
    'isolates commits and branches from %s poisoning', async (kind) => {
      const build = await builder();
      const f = fixture();
      const h = hostileFiles(f);
      const poison = { ...f.env };
      if (['global', 'combined'].includes(kind)) poison.GIT_CONFIG_GLOBAL = h.global;
      if (['system', 'combined'].includes(kind)) { poison.GIT_CONFIG_SYSTEM = h.system; poison.GIT_CONFIG_NOSYSTEM = '0'; }
      if (kind === 'home-xdg') delete poison.GIT_CONFIG_GLOBAL;
      if (['count', 'combined'].includes(kind)) Object.assign(poison, {
        GIT_CONFIG_COUNT: '3', GIT_CONFIG_KEY_0: 'core.hooksPath', GIT_CONFIG_VALUE_0: h.hooks,
        GIT_CONFIG_KEY_1: 'commit.gpgSign', GIT_CONFIG_VALUE_1: 'true',
        GIT_CONFIG_KEY_2: 'init.defaultBranch', GIT_CONFIG_VALUE_2: 'command-scope-branch',
      });
      if (['parameters', 'combined'].includes(kind)) poison.GIT_CONFIG_PARAMETERS = "'init.defaultBranch=parameter-branch' 'commit.gpgSign=true'";
      if (kind === 'malformed-count') poison.GIT_CONFIG_COUNT = 'not-a-number';
      if (['template', 'combined'].includes(kind)) poison.GIT_TEMPLATE_DIR = h.template;
      Object.assign(poison, { GIT_AUTHOR_NAME: 'Injected Author', GIT_AUTHOR_EMAIL: 'injected@example.invalid',
        GIT_COMMITTER_NAME: 'Injected Committer', GIT_COMMITTER_EMAIL: 'injected@example.invalid' });
      const before = { ...poison };
      const expected = commit(f.dir('baseline'), build(f.env));
      expect(expected.branch).toBe('main');
      expect(expected.identity).not.toContain('Control Author');
      expect(expected.identity).not.toContain('Injected');
      expect(expected.identity).toMatch(/.+ <.+@.+>\|.+ <.+@.+>/);
      const intended = f.dir('intended');
      expect(commit(intended, build(poison))).toEqual(expected);
      expect(existsSync(path.join(intended, '.git', 'injected-template'))).toBe(false);
      expect(existsSync(h.hookMarker)).toBe(false);
      expect(existsSync(h.signerMarker)).toBe(false);
      expect(poison).toEqual(before);
      for (const [file, bytes] of Object.entries(h.configBytes)) expect(readFileSync(file, 'utf8')).toBe(bytes);
    },
  );

  it('proves raw Git activates the test-owned config, template, hook and signer controls independently', () => {
    const f = fixture();
    const h = hostileFiles(f);
    const env = { ...f.env, GIT_CONFIG_GLOBAL: h.global };
    delete env.GIT_TEMPLATE_DIR;
    expect(git(f.root, env, 'config', '--get', 'init.defaultBranch').trim()).toBe('ambient-branch');
    const dir = f.dir('control');
    git(dir, env, 'init', '-q');
    expect(existsSync(path.join(dir, '.git', 'injected-template'))).toBe(true);
    writeFileSync(path.join(dir, 'file'), 'control');
    git(dir, env, 'add', 'file');
    const hook = spawnSync('git', ['-c', 'commit.gpgSign=false', 'commit', '-qm', 'hook'], { cwd: dir, env, encoding: 'utf8', timeout: 10000 });
    expect(hook.error).toBeUndefined();
    expect(hook.status).not.toBe(0);
    expect(readFileSync(h.hookMarker, 'utf8')).toBe('ran');
    const signer = spawnSync('git', ['-c', `core.hooksPath=${f.dir('empty-hooks')}`, 'commit', '-qm', 'signer'], { cwd: dir, env, encoding: 'utf8', timeout: 10000 });
    expect(signer.error).toBeUndefined();
    expect(signer.status).not.toBe(0);
    expect(readFileSync(h.signerMarker, 'utf8')).toBe('ran');
  });

  it.each(['GIT_DIR', 'GIT_WORK_TREE', 'GIT_COMMON_DIR', 'GIT_INDEX_FILE', 'GIT_OBJECT_DIRECTORY', 'GIT_ALTERNATE_OBJECT_DIRECTORIES', 'combined'])(
    'keeps %s redirection away from a disposable decoy', async (key) => {
      const build = await builder();
      const f = fixture();
      const decoy = f.dir('decoy');
      commit(decoy, build(f.env));
      const redirects = { GIT_DIR: path.join(decoy, '.git'), GIT_WORK_TREE: decoy,
        GIT_COMMON_DIR: path.join(decoy, '.git'), GIT_INDEX_FILE: path.join(decoy, '.git', 'index'),
        GIT_OBJECT_DIRECTORY: path.join(decoy, '.git', 'objects'),
        GIT_ALTERNATE_OBJECT_DIRECTORIES: path.join(decoy, '.git', 'objects') };
      const before = treeBytes(decoy);
      const env = build({ ...f.env, ...(key === 'combined' ? redirects : { [key]: redirects[key] }) });
      for (const name of Object.keys(redirects)) expect(env[name]).toBeUndefined();
      const intended = f.dir('intended');
      expect(commit(intended, env).contents).toBe('fixture bytes\n');
      expect(realpathSync(git(intended, env, 'rev-parse', '--show-toplevel').trim())).toBe(realpathSync(intended));
      expect(treeBytes(decoy)).toEqual(before);
    },
  );

  it('preserves explicit alternate indexes, local filters and raw porcelain bytes', async () => {
    const build = await builder();
    const f = fixture();
    const dir = f.dir('repo');
    const env = build(f.env);
    commit(dir, env);
    const index = readFileSync(path.join(dir, '.git', 'index'));
    const alternate = { ...env, GIT_INDEX_FILE: path.join(f.root, 'alternate-index') };
    git(dir, alternate, 'read-tree', 'HEAD');
    const filter = path.join(f.root, 'filter.cjs');
    writeFileSync(filter, "process.stdout.write(require('node:fs').readFileSync(0,'utf8').toUpperCase());\n");
    git(dir, env, 'config', 'filter.fixture.clean', `${quote(process.execPath)} ${quote(filter)}`);
    git(dir, env, 'config', 'filter.fixture.required', 'true');
    writeFileSync(path.join(dir, '.gitattributes'), 'payload.txt filter=fixture\n');
    writeFileSync(path.join(dir, 'payload.txt'), 'transformed\n');
    git(dir, alternate, 'add', 'payload.txt');
    expect(git(dir, alternate, 'show', ':payload.txt')).toBe('TRANSFORMED\n');
    expect(readFileSync(path.join(dir, '.git', 'index'))).toEqual(index);
    const name = ' raw café.txt';
    writeFileSync(path.join(dir, name), 'raw\n');
    const bytes = execFileSync('git', ['status', '--porcelain=v1', '-z', '--', name], { cwd: dir, env, timeout: 10000 });
    expect(bytes).toEqual(Buffer.from(`?? ${name}\0`));
  });

  it('isolates the existing Codex fixture child entry point from inherited hostile settings', async () => {
    const build = await builder();
    const f = fixture();
    const h = hostileFiles(f);
    const decoy = f.dir('decoy');
    commit(decoy, build(f.env));
    const before = treeBytes(decoy);
    const root = f.dir('native-root');
    mkdirSync(path.join(root, 'bin'));
    writeFileSync(path.join(root, 'bin', 'ape-hook.mjs'), `
      import { execFileSync } from 'node:child_process';
      import { writeFileSync } from 'node:fs';
      const git = (...args) => execFileSync('git', args, { encoding: 'utf8' });
      git('init', '-q');
      writeFileSync('native.txt', 'native fixture');
      git('add', 'native.txt');
      git('commit', '-qm', 'native fixture');
      git('branch', 'native-branch');
      console.log(JSON.stringify({ branch: git('branch', '--show-current').trim(),
        value: git('show', 'native-branch:native.txt') }));
    `);
    const helper = new URL('./codex-native-test-helper.js', import.meta.url).href;
    const script = `import { invokeCodexHook } from ${JSON.stringify(helper)};
      console.log(JSON.stringify(await invokeCodexHook(${JSON.stringify(root)}, {})));`;
    const poison = { ...f.env, GIT_CONFIG_GLOBAL: h.global, GIT_CONFIG_SYSTEM: h.system,
      GIT_CONFIG_NOSYSTEM: '0', GIT_CONFIG_COUNT: 'malformed', GIT_TEMPLATE_DIR: h.template,
      GIT_CONFIG_PARAMETERS: "'commit.gpgSign=true'",
      GIT_DIR: path.join(decoy, '.git'), GIT_WORK_TREE: decoy,
      GIT_INDEX_FILE: path.join(decoy, '.git', 'index') };
    expect(await runNativeJson(process.execPath, ['--input-type=module', '-e', script], {
      cwd: root, env: poison,
    })).toEqual({ branch: 'main', value: 'native fixture' });
    expect(treeBytes(decoy)).toEqual(before);
    expect(existsSync(h.hookMarker)).toBe(false);
    expect(existsSync(h.signerMarker)).toBe(false);
    for (const [file, bytes] of Object.entries(h.configBytes)) expect(readFileSync(file, 'utf8')).toBe(bytes);
  });

  it('supports concurrent fresh Node children without contaminating their caller', async () => {
    const build = await builder();
    const f = fixture();
    const parent = { ...process.env };
    const env = build({ ...f.env, GIT_CONFIG_COUNT: 'malformed', GIT_DIR: path.join(f.root, 'missing') });
    const script = `const {execFileSync}=require('node:child_process');
      const fs=require('node:fs');
      const git=(...args)=>execFileSync('git',args,{encoding:'utf8'});
      git('init','-q');fs.writeFileSync('child.txt','child');git('add','child.txt');git('commit','-qm','child');
      git('branch','child-branch');console.log(JSON.stringify({branch:git('branch','--show-current').trim(),value:git('show','child-branch:child.txt')}));`;
    const dirs = [f.dir('child-one'), f.dir('child-two')];
    const results = await Promise.all(dirs.map((cwd) => runNativeJson(process.execPath, ['-e', script], { cwd, env })));
    expect(results[0]).toEqual(results[1]);
    expect(results[0].value).toBe('child');
    expect(results[0].branch).toBeTruthy();
    expect(process.env).toEqual(parent);
    const generic = await runNativeJson(process.execPath, ['-e', 'console.log(JSON.stringify({value:process.env.GIT_ARBITRARY_RESIDUE}))'], {
      env: { ...f.env, GIT_ARBITRARY_RESIDUE: 'explicit non-Git child option' },
    });
    expect(generic.value).toBe('explicit non-Git child option');
  });
});
