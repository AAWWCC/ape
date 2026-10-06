import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cp, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
import { resolveMarketplaceHostInvocation } from '../scripts/marketplace-host-invocation.mjs';

const REPO = dirname(dirname(fileURLToPath(import.meta.url)));
const RUNTIME_PATHS = [
  'dist/ape-hooks.bundle.mjs', 'dist/ape-mcp.bundle.mjs',
  'lib/runtime/runner.js', 'lib/runtime/spawn.js', 'lib/runtime/file-stats.js',
  'package.json', '.codex-plugin/plugin.json', '.mcp.json', 'hooks/hooks.json',
];
const CANONICAL_PATHS = ['.agents/plugins/marketplace.json', 'plugins/ape/.codex-plugin/plugin.json', 'package.json'];

// Deliberately no opt-in/skip: inability to provision the compatibility pin or
// discover a real refresh operation is missing acceptance evidence.
function command(program, args, options, timeout = 60_000) {
  return new Promise((resolveCommand, reject) => {
    const child = spawn(program, args, { ...options, shell: false, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let failure;
    const timer = setTimeout(() => {
      failure = new Error(`${program} ${args.join(' ')} timed out`);
      child.kill('SIGKILL');
    }, timeout);
    const capture = (stream, append) => {
      stream.setEncoding('utf8');
      stream.on('data', chunk => {
        append(chunk);
        if (stdout.length + stderr.length > 4 * 1024 * 1024) {
          failure = new Error('Host diagnostic output exceeded 4 MiB');
          child.kill('SIGKILL');
        }
      });
    };
    capture(child.stdout, chunk => { stdout += chunk; });
    capture(child.stderr, chunk => { stderr += chunk; });
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('close', (code, signal) => {
      clearTimeout(timer);
      if (failure) reject(failure);
      else if (code !== 0) reject(new Error(`${program} ${args.join(' ')} exited ${code}/${signal}: ${stderr.slice(-8000)} ${stdout.slice(-8000)}`));
      else resolveCommand({ stdout, stderr });
    });
  });
}

function isolatedEnv(root, codexHome) {
  const env = {};
  // Do not inherit APE capabilities, session routing, plugin roots, credentials,
  // npm configuration, or the operator's HOME/config directories.
  for (const key of ['PATH', 'Path', 'SystemRoot', 'SYSTEMROOT', 'COMSPEC', 'PATHEXT', 'LANG']) {
    if (process.env[key] !== undefined) env[key] = process.env[key];
  }
  return {
    ...env, HOME: root, USERPROFILE: root, CODEX_HOME: codexHome,
    XDG_CONFIG_HOME: join(root, 'config'), XDG_CACHE_HOME: join(root, 'cache'),
    XDG_DATA_HOME: join(root, 'data'), APPDATA: join(root, 'appdata'),
    LOCALAPPDATA: join(root, 'localappdata'), TMPDIR: join(root, 'tmp'),
    TMP: join(root, 'tmp'), TEMP: join(root, 'tmp'),
    npm_config_cache: join(root, 'npm-cache'),
    npm_config_userconfig: join(root, 'npmrc'), npm_config_globalconfig: join(root, 'global-npmrc'),
    npm_config_ignore_scripts: 'false', npm_config_omit: '', npm_config_optional: 'true',
  };
}

async function snapshot(root, paths = RUNTIME_PATHS) {
  return Object.fromEntries(await Promise.all(paths.map(async name => {
    try {
      const bytes = await readFile(join(root, name));
      return [name, { available: true, sha256: createHash('sha256').update(bytes).digest('hex') }];
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      return [name, { available: false }];
    }
  })));
}

function assertUsable(observation) {
  for (const entry of Object.values(observation)) expect(entry.available).toBe(true);
}

function assertOldPaths(observation, original, available) {
  for (const name of RUNTIME_PATHS) {
    expect(observation[name]).toEqual(available ? original[name] : { available: false });
  }
}

function assertRefreshResult(value) {
  if (!value || typeof value !== 'object') return;
  for (const [key, child] of Object.entries(value)) {
    if (key === 'error' || key === 'errors') {
      expect(child === null || child === '' || child === false ||
        (Array.isArray(child) && child.length === 0), 'host refresh reported an error').toBe(true);
    }
    if (key === 'success' || key === 'ok') expect(child, 'host refresh reported failure').not.toBe(false);
    assertRefreshResult(child);
  }
}

// Version-matched contract, not a heuristic on RPC method names.
// https://raw.githubusercontent.com/openai/codex/3d2ee51ca2d5db578f328aa75e20aa22c0197c9a/codex-rs/app-server/src/request_processors/plugins.rs
// The forced local branch awaits refresh_non_curated_plugin_cache_for_context.
// Equal versions may no-op; the scenario below advances a fixture-owned source.
async function discoverRefresh(host, schemaRoot) {
  const help = await host(['app-server', 'generate-json-schema', '--help']);
  await host(['app-server', 'generate-json-schema', '--out', schemaRoot,
    ...(help.stdout.includes('--experimental') ? ['--experimental'] : [])]);
  const documents = new Map();
  async function readSchemas(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const file = join(directory, entry.name);
      if (entry.isDirectory()) await readSchemas(file);
      else if (entry.isFile() && entry.name.endsWith('.json')) documents.set(file, JSON.parse(await readFile(file, 'utf8')));
    }
  }
  await readSchemas(schemaRoot);
  function dereference(schema, file) {
    if (!schema?.$ref) return { schema, file };
    const [target, fragment = ''] = schema.$ref.split('#');
    const nextFile = target ? resolve(dirname(file), target) : file;
    let value = documents.get(nextFile);
    for (const key of fragment.split('/').filter(Boolean)) value = value?.[key.replaceAll('~1', '/').replaceAll('~0', '~')];
    if (!value) throw new Error('Unresolved generated schema reference: ' + schema.$ref);
    return dereference(value, nextFile);
  }
  const requests = [];
  function visit(node, file) {
    if (!node || typeof node !== 'object') return;
    const method = node.properties?.method;
    if (method?.const === 'plugin/list' || method?.enum?.includes('plugin/list')) {
      requests.push({ params: node.properties.params, file });
    }
    for (const value of Object.values(node)) visit(value, file);
  }
  for (const [file, document] of documents) visit(document, file);
  expect(requests.length, 'generated schema must expose plugin/list').toBeGreaterThan(0);
  // Match actual schema types, resolving references and nullable branches.
  function accepts(schema, file, value) {
    ({ schema, file } = dereference(schema, file));
    if (!schema || typeof schema !== 'object') return false;
    if (schema.anyOf) return schema.anyOf.some(item => accepts(item, file, value));
    if (schema.oneOf) return schema.oneOf.filter(item => accepts(item, file, value)).length === 1;
    if (schema.allOf) return schema.allOf.every(item => accepts(item, file, value));
    if (schema.enum) return schema.enum.includes(value);
    if (Object.hasOwn(schema, 'const')) return schema.const === value;
    const types = Array.isArray(schema.type) ? schema.type : [schema.type];
    if (Array.isArray(value)) return types.includes('array') && value.every(item => accepts(schema.items, file, item));
    return types.includes(typeof value);
  }
  for (const request of requests) {
    const { schema, file } = dereference(request.params, request.file);
    expect(schema.type).toBe('object');
    for (const key of ['cwds', 'marketplaceKinds', 'forceRefetch']) expect(schema.properties).toHaveProperty(key);
    expect(accepts(schema.properties.cwds, file, [schemaRoot])).toBe(true);
    expect(accepts(schema.properties.marketplaceKinds, file, ['local'])).toBe(true);
    expect(accepts(schema.properties.forceRefetch, file, true)).toBe(true);
    expect(accepts(schema.properties.forceRefetch, file, 'true')).toBe(false);
    expect(accepts(schema.properties.marketplaceKinds, file, ['not-a-marketplace-kind'])).toBe(false);
    expect((schema.required ?? []).every(key => ['cwds', 'marketplaceKinds', 'forceRefetch'].includes(key))).toBe(true);
  }
  return { method: 'plugin/list', schema: 'generated ClientRequest and PluginListParams' };
}

function appServer(invocation, options) {
  const child = spawn(invocation.command, [...invocation.args, 'app-server'], { ...options, shell: false, stdio: ['pipe', 'pipe', 'pipe'] });
  const waiting = new Map();
  let nextId = 1;
  let pending = '';
  let stderr = '';
  let failure;
  let closed = false;
  const rejectAll = error => {
    failure = error;
    for (const entry of waiting.values()) { clearTimeout(entry.timer); entry.reject(error); }
    waiting.clear();
  };
  const exited = new Promise(resolveExit => {
    child.once('close', () => {
      closed = true;
      rejectAll(failure ?? new Error('App-server closed: ' + stderr));
      resolveExit();
    });
  });
  child.once('error', rejectAll);
  child.stdin.on('error', error => { rejectAll(error); child.kill('SIGKILL'); });
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-8000); });
  child.stdout.on('data', chunk => {
    pending += chunk;
    if (pending.length > 4 * 1024 * 1024) {
      rejectAll(new Error('App-server response exceeded 4 MiB'));
      child.kill('SIGKILL');
      return;
    }
    let newline;
    while ((newline = pending.indexOf('\n')) >= 0) {
      const line = pending.slice(0, newline);
      pending = pending.slice(newline + 1);
      if (!line.trim()) continue;
      try {
        const message = JSON.parse(line);
        const entry = waiting.get(message.id);
        if (!entry) continue;
        waiting.delete(message.id);
        clearTimeout(entry.timer);
        if (message.error) entry.reject(new Error(JSON.stringify(message.error)));
        else if (!Object.hasOwn(message, 'result')) entry.reject(new Error('RPC response lacks result'));
        else entry.resolve(message.result);
      } catch (error) { rejectAll(error); child.kill('SIGKILL'); }
    }
  });
  const send = message => child.stdin.write(JSON.stringify(message) + '\n');
  const request = (method, params) => new Promise((resolveRpc, reject) => {
    if (failure || closed) { reject(failure ?? new Error('App-server is closed')); return; }
    const id = nextId++;
    const timer = setTimeout(() => {
      rejectAll(new Error(method + ' timed out: ' + stderr));
      child.kill('SIGKILL');
    }, 60_000);
    waiting.set(id, { resolve: resolveRpc, reject, timer });
    send({ id, method, params });
  });
  return {
    request,
    async initialize() {
      await request('initialize', { clientInfo: { name: 'ape-refresh-contract', version: '1.0.0' }, capabilities: { experimentalApi: true } });
      send({ method: 'initialized' });
    },
    async close() {
      if (!closed) child.kill();
      const timer = setTimeout(() => child.kill('SIGKILL'), 2000);
      try { await exited; } finally { clearTimeout(timer); }
    },
  };
}

function listedDevelopment(result, version) {
  expect(result.marketplaceLoadErrors).toEqual([]);
  const marketplace = result.marketplaces.find(entry => entry.name === 'ape-dev');
  expect(marketplace, 'registered development marketplace must be visible').toBeTruthy();
  const selected = marketplace.plugins.filter(entry => entry.name === 'ape' && entry.installed);
  expect(selected).toHaveLength(1);
  expect(selected[0].localVersion).toBe(version);
  assertRefreshResult(result);
  return selected[0];
}

it('keeps immutable development selection through a supported real Codex refresh in isolated homes', async () => {
  const compatibility = JSON.parse(await readFile(join(REPO, 'compatibility.json'), 'utf8'));
  const pin = compatibility.hosts.codex;
  expect(pin.package).toBe('@openai/codex');
  expect(pin.version).toBe('0.153.4');
  const canonicalBefore = await snapshot(REPO, CANONICAL_PATHS);
  assertUsable(canonicalBefore);
  const releaseVersion = JSON.parse(await readFile(join(REPO, 'plugins/ape/.codex-plugin/plugin.json'), 'utf8')).version;
  const root = await mkdtemp(join(tmpdir(), 'ape-real-refresh-'));
  try {
    const toolsRoot = join(root, 'host-tools');
    const bootstrapHome = join(root, 'bootstrap-codex');
    await mkdir(bootstrapHome, { recursive: true, mode: 0o700 });
    await mkdir(join(root, 'tmp'), { mode: 0o700 });
    await writeFile(join(root, 'npmrc'), '');
    await writeFile(join(root, 'global-npmrc'), '');
    const env = isolatedEnv(root, bootstrapHome);
    const npmArgs = ['install', '--no-save', '--prefix', toolsRoot, `${pin.package}@${pin.version}`];
    if (process.env.npm_execpath) {
      await command(process.execPath, [process.env.npm_execpath, ...npmArgs], { cwd: root, env }, 300_000);
    } else {
      if (process.platform === 'win32') throw new Error('Shell-free npm provisioning on Windows requires npm_execpath');
      await command('npm', npmArgs, { cwd: root, env }, 300_000);
    }
    const modulesRoot = join(toolsRoot, 'node_modules');
    const packageManifest = JSON.parse(await readFile(join(modulesRoot, '@openai/codex/package.json'), 'utf8'));
    expect(packageManifest.name).toBe(pin.package);
    expect(packageManifest.version).toBe(pin.version);
    const invocation = await resolveMarketplaceHostInvocation({ identity: 'codex', packageName: pin.package, modulesRoot, args: [] });
    const codexBin = invocation.command === process.execPath ? invocation.args[0] : invocation.command;
    const hostVersion = await command(invocation.command, [...invocation.args, '--version'], { cwd: root, env });
    expect(`${hostVersion.stdout}\n${hostVersion.stderr}`.match(/\d+\.\d+\.\d+/u)?.[0]).toBe(pin.version);
    const summary = { host: pin.package, version: pin.version, platform: process.platform, scenarios: [] };
    const sentinel = join(root, 'outside-installation-sentinel');
    await writeFile(sentinel, 'fixture sibling remains untouched\n');

    for (const preserve of [false, true]) {
      const scenarioRoot = join(root, preserve ? 'preserve' : 'archive');
      const home = join(scenarioRoot, 'codex-home');
      await mkdir(home, { recursive: true, mode: 0o700 });
      const options = { cwd: scenarioRoot, env: { ...env, CODEX_HOME: home } };
      const host = args => command(invocation.command, [...invocation.args, ...args], options);
      const refresh = await discoverRefresh(host, join(scenarioRoot, 'host-schema'));
      await host(['plugin', 'marketplace', 'add', REPO, '--json']);
      await host(['plugin', 'add', 'ape@ape', '--json']);
      const releaseRoot = join(home, 'plugins/cache/ape/ape', releaseVersion);
      const releaseBefore = await snapshot(releaseRoot);
      assertUsable(releaseBefore);
      expect(releaseBefore).toEqual(await snapshot(join(REPO, 'plugins/ape')));
      const inventory = async marketplace => JSON.parse((await host(['plugin', 'list', '--marketplace', marketplace, '--json'])).stdout);
      const releaseSelected = (await inventory('ape')).installed.find(entry => entry.pluginId === 'ape@ape');
      expect(releaseSelected?.version).toBe(releaseVersion);
      expect(releaseSelected?.source?.source).toBe('local');
      expect(await realpath(releaseSelected.source.path)).toBe(await realpath(join(REPO, 'plugins/ape')));
      const base = releaseVersion.split('+', 1)[0];
      const versions = ['refresh-001', 'refresh-002', 'refresh-003'].map(token => `${base}+codex.${token}`);
      const marketplace = join(home, 'dev-plugins/ape-dev');
      const cache = join(home, 'plugins/cache/ape-dev/ape');
      const assertSelection = async (version, expectedBytes = releaseBefore) => {
        const listed = await inventory('ape-dev');
        const selected = listed.installed.filter(entry => entry.pluginId === 'ape@ape-dev');
        expect(selected).toHaveLength(1);
        expect(selected[0].version).toBe(version);
        expect(selected[0].source.source).toBe('local');
        const source = join(marketplace, 'versions/ape', version);
        expect(await realpath(selected[0].source.path)).toBe(await realpath(source));
        const catalog = JSON.parse(await readFile(join(marketplace, '.agents/plugins/marketplace.json'), 'utf8'));
        expect(await realpath(resolve(marketplace, catalog.plugins.find(entry => entry.name === 'ape').source.path))).toBe(await realpath(source));
        const sourceBytes = await snapshot(source);
        assertUsable(sourceBytes);
        for (const name of RUNTIME_PATHS.filter(name => name !== '.codex-plugin/plugin.json')) {
          expect(sourceBytes[name]).toEqual(expectedBytes[name]);
        }
        expect(await snapshot(join(cache, version))).toEqual(sourceBytes);
        expect(JSON.parse(await readFile(join(source, '.codex-plugin/plugin.json'), 'utf8')).version).toBe(version);
        return { version, source: selected[0].source.path };
      };
      const reinstall = token => command(process.execPath, [
        join(REPO, 'scripts/reinstall-codex-plugin.mjs'), '--plugin-root', join(REPO, 'plugins/ape'),
        '--codex-home', home, '--codex-bin', codexBin, '--cachebuster', token,
        ...(preserve ? ['--preserve-open-tasks'] : []),
      ], options, 120_000);
      await reinstall('refresh-001');
      const firstSelection = await assertSelection(versions[0]);
      const oldRoot = join(cache, versions[0]);
      const before = await snapshot(oldRoot);
      assertUsable(before);
      expect(await snapshot(releaseRoot)).toEqual(releaseBefore);
      await reinstall('refresh-002');
      const afterReinstall = await snapshot(oldRoot);
      // Host inventory during a real installation may prune restored old paths.
      // These observations concern original paths, never their recovery copies.
      const retainedAfterReinstall = Object.values(afterReinstall)[0].available;
      assertOldPaths(afterReinstall, before, retainedAfterReinstall);
      if (!preserve) expect(retainedAfterReinstall).toBe(false);
      const afterInstallSelection = await assertSelection(versions[1]);
      const recoveryRoot = join(marketplace, 'retained-cache/ape', versions[0]);
      expect(await snapshot(recoveryRoot)).toEqual(before);
      const immutableBefore = await snapshot(join(marketplace, 'versions/ape', versions[1]));
      const server = appServer(invocation, options);
      let positiveControl;
      try {
        await server.initialize();
        const params = { cwds: [scenarioRoot], marketplaceKinds: ['local'], forceRefetch: true };
        // Complete discovery and its awaited refresh on this same server before
        // changing any source. Matching versions are a legitimate no-op.
        listedDevelopment(await server.request(refresh.method, params), versions[1]);
        const baselineBytes = await snapshot(join(cache, versions[1]));
        expect(baselineBytes).toEqual(immutableBefore);
        const sameVersionPaths = await snapshot(oldRoot);
        assertOldPaths(sameVersionPaths, before, Object.values(sameVersionPaths)[0].available);
        listedDevelopment(await server.request(refresh.method, params), versions[1]);
        expect(await snapshot(join(cache, versions[1]))).toEqual(baselineBytes);
        expect(await snapshot(oldRoot)).toEqual(sameVersionPaths);

        // Publish a new immutable source, then atomically point the registered
        // catalog at it. No install, relaunch, or other host process may run
        // between this publication and verification of the refresh response.
        const source = join(marketplace, 'versions/ape', versions[2]);
        await cp(join(marketplace, 'versions/ape', versions[1]), source, { recursive: true });
        const manifestPath = join(source, '.codex-plugin/plugin.json');
        const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
        await writeFile(manifestPath, JSON.stringify({ ...manifest, version: versions[2] }, null, 2) + '\n');
        const changedPath = 'lib/runtime/runner.js';
        await writeFile(join(source, changedPath), (await readFile(join(source, changedPath), 'utf8')) + '\n// Fixture refresh-003 positive control.\n');
        const newBytes = await snapshot(source);
        assertUsable(newBytes);
        expect(newBytes[changedPath]).not.toEqual(baselineBytes[changedPath]);
        const catalogPath = join(marketplace, '.agents/plugins/marketplace.json');
        const catalog = JSON.parse(await readFile(catalogPath, 'utf8'));
        catalog.plugins.find(entry => entry.name === 'ape').source.path = './versions/ape/' + versions[2];
        await writeFile(catalogPath + '.next', JSON.stringify(catalog, null, 2) + '\n');
        await rename(catalogPath + '.next', catalogPath);
        expect(await snapshot(join(cache, versions[1]))).toEqual(baselineBytes);
        const absent = await snapshot(join(cache, versions[2]));
        for (const entry of Object.values(absent)) expect(entry.available).toBe(false);

        const refreshed = await server.request(refresh.method, params);
        listedDevelopment(refreshed, versions[2]);
        // Inspect bytes BEFORE any other host invocation can reconcile caches.
        expect(await snapshot(join(cache, versions[2]))).toEqual(newBytes);
        expect(await snapshot(source)).toEqual(newBytes);
        const originalPaths = await snapshot(oldRoot);
        assertOldPaths(originalPaths, before, Object.values(originalPaths)[0].available);
        const activeVersions = (await readdir(cache)).sort();
        listedDevelopment(await server.request(refresh.method, params), versions[2]);
        expect(await snapshot(join(cache, versions[2]))).toEqual(newBytes);
        expect(await snapshot(source)).toEqual(newBytes);
        expect(await snapshot(oldRoot)).toEqual(originalPaths);
        expect((await readdir(cache)).sort()).toEqual(activeVersions);
        const selection = await assertSelection(versions[2], newBytes);
        positiveControl = { fromVersion: versions[1], toVersion: versions[2], params,
          before: baselineBytes, after: newBytes, selection, repeatedRefresh: true,
          originalPaths, activeVersions };
      } finally {
        await server.close();
      }
      const afterRefresh = await snapshot(oldRoot);
      // A refresh may prune restored old paths. All missing is a recorded
      // session limitation; partial deletion or altered surviving bytes fails.
      const stillAvailable = Object.values(afterRefresh)[0].available;
      assertOldPaths(afterRefresh, before, stillAvailable);
      if (!preserve) expect(stillAvailable).toBe(false);
      const afterRefreshSelection = positiveControl.selection;
      expect(await snapshot(join(marketplace, 'versions/ape', versions[1]))).toEqual(immutableBefore);
      expect(await snapshot(join(marketplace, 'versions/ape', versions[0]))).toEqual(before);
      expect(await snapshot(recoveryRoot)).toEqual(before);
      expect(await snapshot(releaseRoot)).toEqual(releaseBefore);
      expect((await inventory('ape')).installed.find(entry => entry.pluginId === 'ape@ape')).toEqual(releaseSelected);
      expect(await readFile(sentinel, 'utf8')).toBe('fixture sibling remains untouched\n');
      expect(await snapshot(REPO, CANONICAL_PATHS)).toEqual(canonicalBefore);
      summary.scenarios.push({
        mode: preserve ? 'preserve-open-tasks' : 'archive',
        refresh, positiveControl,
        firstSelection, afterInstallSelection, afterRefreshSelection,
        originalRoot: oldRoot, originalPaths: { before, afterReinstall, afterRefresh },
        releaseRoot, releasePaths: releaseBefore, recoveryRoot, recoveryPaths: before,
        activeCacheVersions: (await readdir(cache)).sort(),
      });
    }
    console.info(`APE_REAL_CODEX_REFRESH ${JSON.stringify(summary)}`);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}, 600_000);
