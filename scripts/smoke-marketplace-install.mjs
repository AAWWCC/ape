#!/usr/bin/env node

import { spawn } from 'node:child_process';
import { access, cp, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveMarketplaceHostInvocation } from './marketplace-host-invocation.mjs';

const REPO_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

const pkg = JSON.parse(await readFile(join(REPO_ROOT, 'package.json'), 'utf8'));
const compatibility = JSON.parse(await readFile(join(REPO_ROOT, 'compatibility.json'), 'utf8'));
const VERSION = pkg.version;
const COMMAND_TIMEOUT_MS = 60_000;
const HOST_PACKAGE_INSTALL_TIMEOUT_MS = 5 * 60_000;
let childShutdownIncomplete = false;

async function cleanupFixture(root) {
  // Retain scratch evidence if the OS could not confirm owned-child shutdown.
  // Removing files beneath a possibly live host is not safe recovery.
  if (!childShutdownIncomplete) await rm(root, { recursive: true, force: true });
}

const PINNED_FILES = ['dist/ape-hooks.bundle.mjs', 'lib/runtime/runner.js', 'lib/runtime/spawn.js', 'lib/runtime/file-stats.js', 'lib/runtime/host-identity.js'];
const PHASES = ['beforeReinstall', 'afterReinstall', 'afterRefresh'];
const REFRESH_PARAMS = { cwds: [], marketplaceKinds: ['local'], forceRefetch: true };
function requireEvidence(condition, message) {
  if (!condition) throw new Error(`Invalid Codex refresh evidence: ${message}`);
}
function same(actual, expected, message) {
  requireEvidence(isDeepStrictEqual(actual, expected), message);
}
function inventoryValid(entries) {
  requireEvidence(Array.isArray(entries) && entries.length > 0, 'missing inventory');
  const names = new Set();
  for (const entry of entries) {
    requireEvidence(typeof entry.relative === 'string' && entry.relative !== '' &&
      !isAbsolute(entry.relative) && !entry.relative.split(/[\\/]/u).some(p => p === '..' || p === '.') &&
      !names.has(entry.relative) && entry.type === 'file' && Number.isSafeInteger(entry.size) && entry.size >= 0 &&
      /^[a-f0-9]{64}$/u.test(entry.sha256), 'invalid regular-file inventory');
    names.add(entry.relative);
  }
}
function inventoryMatches(actual, expected) {
  inventoryValid(actual);
  inventoryValid(expected);
  same([...actual].sort((a, b) => a.relative.localeCompare(b.relative)),
    [...expected].sort((a, b) => a.relative.localeCompare(b.relative)), 'inventory byte mismatch');
}

function expectedStartupDiagnostic(line, expected) {
  const text = line.replace(/\u001b\[[0-9;]*m/gu, '').trim();
  // These exact diagnostics are emitted by pinned Codex 0.153.4 on Linux
  // before any refresh: disposable /tmp homes cannot create PATH aliases,
  // and a missing system bwrap falls back to Codex's bundled bubblewrap.
  // Bind the path exception to this fixture; other warnings/errors still fail.
  if (expected.codexHome.startsWith('/tmp/') && text ===
      `WARNING: proceeding, even though we could not create PATH aliases: Refusing to create helper binaries under temporary dir "/tmp" (codex_home: AbsolutePathBuf(${JSON.stringify(expected.codexHome)}))`) return true;
  const prefix = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z\s+ERROR\s+codex_app_server:\s+/u;
  if (prefix.test(text) && text.replace(prefix, '') ===
    'Codex could not find bubblewrap on PATH. Install bubblewrap with your OS package manager. See the sandbox prerequisites: https://developers.openai.com/codex/concepts/sandboxing#prerequisites. Codex will use the bundled bubblewrap in the meantime.') return true;
  // The host also warms its optional remote featured-plugin catalog at startup.
  // This probe requests only local marketplaces and verifies their load errors,
  // selected version and bytes independently; remote discovery is out of scope.
  const featuredPrefix = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z\s+WARN\s+codex_core_plugins::manager:\s+/u;
  return featuredPrefix.test(text) && text.replace(featuredPrefix, '').startsWith(
    'failed to warm featured plugin ids cache error=failed to send remote featured plugin request to https://chatgpt.com/backend-api/plugins/featured?platform=codex: ');
}

// Expected context is constructed by the caller from its owned fixture and
// package bytes; self-declared context is never an authority for observations.
export function validateCodexRefreshEvidence(evidence, expected) {
  requireEvidence(expected && isAbsolute(expected.ownedRoot) &&
    expected.codexHome === join(expected.ownedRoot, 'codex-home') &&
    expected.pluginRoot === join(expected.ownedRoot, 'plugin'), 'unowned fixture');
  requireEvidence(expected.host?.package === '@openai/codex' && expected.host.version === '0.153.4' &&
    expected.host.shell === false && isAbsolute(expected.host.command) &&
    Array.isArray(expected.host.args) && expected.host.args.at(-1) === 'app-server', 'unsupported host');
  requireEvidence(expected.pluginId === 'ape@ape-dev' && ['default', 'preserve-open-tasks'].includes(expected.mode) &&
    typeof expected.oldVersion === 'string' && expected.newVersion > expected.oldVersion, 'identity or version order');
  const marketplace = join(expected.codexHome, 'dev-plugins/ape-dev');
  const oldRoot = join(expected.codexHome, 'plugins/cache/ape-dev/ape', expected.oldVersion);
  same(expected.source, join(marketplace, 'versions/ape', expected.newVersion), 'source path');
  same(expected.oldSource, join(marketplace, 'versions/ape', expected.oldVersion), 'old source path');
  same(expected.selectedRoot, join(expected.codexHome, 'plugins/cache/ape-dev/ape', expected.newVersion), 'selected path');
  requireEvidence(expected.baseline?.length === PINNED_FILES.length, 'baseline');
  expected.baseline.forEach((entry, index) => {
    same(entry.relative, PINNED_FILES[index], 'baseline relative path');
    same(entry.path, join(oldRoot, PINNED_FILES[index]), 'baseline absolute path');
  });
  inventoryValid(expected.baseline);
  same(evidence.context, expected, 'context binding');
  requireEvidence(evidence.schemaVersion === 1 && evidence.activation === 'unverified' &&
    !Object.hasOwn(evidence, 'retentionGuaranteed'), 'unsupported evidence claim');
  const refresh = evidence.refresh;
  requireEvidence(refresh?.transport === 'app-server-stdio', 'missing real refresh transport');
  const init = refresh.initialize;
  requireEvidence(init?.initialized === true && init.request?.method === 'initialize' &&
    init.request.id != null && init.response?.id === init.request.id && init.response.result && !init.response.error, 'initialization');
  same(init.request.params, { clientInfo: { name: 'ape-marketplace-smoke', version: '1.0.0' } }, 'initialize parameters');
  requireEvidence(refresh.request?.method === 'plugin/list' && refresh.request.id != null &&
    refresh.request.id !== init.request.id && refresh.response?.id === refresh.request.id && !refresh.response.error, 'refresh correlation');
  same(refresh.request.params, REFRESH_PARAMS, 'refresh scope');
  same(refresh.completion, { exitCode: 0, signal: null, timedOut: false, outputOverflow: false, earlyExit: false }, 'refresh completion');
  requireEvidence(Array.isArray(refresh.diagnostics) && refresh.diagnostics.every(line => typeof line === 'string' &&
    (!/error|warn|failed/iu.test(line) || expectedStartupDiagnostic(line, expected))),
  `refresh diagnostics: ${JSON.stringify(refresh.diagnostics)}`);
  const result = refresh.response.result;
  requireEvidence(Array.isArray(result?.marketplaces) && Array.isArray(result.featuredPluginIds), 'malformed refresh result');
  same(result.marketplaceLoadErrors, [], 'marketplace load errors');
  const matches = result.marketplaces.filter(m => m.name === 'ape-dev');
  // Synthetic adapters use the marketplace root; the pinned wire protocol
  // reports its catalog filename. Both bind to the same exact owned catalog.
  requireEvidence(matches.length === 1 && [marketplace, join(marketplace, '.agents/plugins/marketplace.json')].includes(matches[0].path) &&
    Array.isArray(matches[0].plugins), 'marketplace identity');
  const plugins = matches[0].plugins.filter(p => p.id === expected.pluginId);
  requireEvidence(plugins.length === 1 && plugins[0].name === 'ape' && plugins[0].installed === true &&
    plugins[0].enabled === true && plugins[0].localVersion === expected.newVersion, 'app-server selection');
  same(plugins[0].source, { type: 'local', path: expected.source }, 'app-server source');
  requireEvidence(evidence.observations?.length === 3, 'incomplete phases');
  evidence.observations.forEach((observation, index) => {
    same(observation.phase, PHASES[index], 'phase order');
    const retained = index === 0 || expected.mode === 'preserve-open-tasks';
    same(observation.outcome, retained ? 'retained' : 'absent', 'retention outcome');
    same(observation.originals, expected.baseline.map(entry => retained
      ? { ...entry, state: 'present' }
      : { path: entry.path, relative: entry.relative, state: 'absent', error: 'ENOENT' }), 'original path evidence');
    if (index === 0) same(observation.archive, null, 'initial archive');
    else {
      same(observation.archive?.root, join(marketplace, 'retained-cache/ape', expected.oldVersion), 'archive path');
      inventoryMatches(observation.archive.inventory, expected.baseline.map(({ path: _path, ...entry }) => entry));
    }
    const source = index === 0 ? expected.oldSource : expected.source;
    const version = index === 0 ? expected.oldVersion : expected.newVersion;
    const inventory = index === 0 ? expected.oldSourceInventory : expected.sourceInventory;
    same(observation.source?.root, source, 'source root');
    requireEvidence(observation.source?.manifest?.name === 'ape' && observation.source.manifest.version === version, 'source manifest');
    inventoryMatches(observation.source.inventory, inventory);
    requireEvidence(observation.selected?.length === 1, 'selected cardinality');
    const selected = observation.selected[0];
    requireEvidence(selected.pluginId === expected.pluginId && selected.version === version &&
      selected.manifest?.name === 'ape' && selected.manifest.version === version, 'selected manifest');
    same(selected.source, { source: 'local', path: source }, 'selected source');
    same(selected.root, index === 0 ? oldRoot : expected.selectedRoot, 'selected root');
    inventoryMatches(selected.inventory, inventory);
  });
  return true;
}

export async function collectCodexRefreshEvidence({ expected, operations }) {
  try {
    await operations.verifyRelease(expected);
    const options = { codexHome: expected.codexHome, pluginRoot: expected.pluginRoot,
      codexBin: expected.host.args.length > 1 ? expected.host.args[0] : expected.host.command };
    await operations.reinstall({ ...options, cachebuster: expected.cachebusters[0], preserveOpenTasks: false });
    const observations = [await operations.observe(PHASES[0], expected)];
    await operations.reinstall({ ...options, cachebuster: expected.cachebusters[1], preserveOpenTasks: expected.mode === 'preserve-open-tasks' });
    observations.push(await operations.observe(PHASES[1], expected));
    const refresh = await operations.refresh({ id: 'refresh-2', method: 'plugin/list', params: structuredClone(REFRESH_PARAMS) }, expected);
    observations.push(await operations.observe(PHASES[2], expected));
    const evidence = { schemaVersion: 1, context: structuredClone(expected), activation: 'unverified', refresh, observations };
    validateCodexRefreshEvidence(evidence, expected);
    return evidence;
  } finally {
    await operations.cleanup(expected.ownedRoot);
  }
}

function isolatedEnv(root, codexHome) {
  const env = {};
  for (const key of ['PATH', 'SystemRoot', 'WINDIR', 'TEMP', 'TMP', 'TMPDIR']) {
    if (process.env[key]) env[key] = process.env[key];
  }
  return { ...env, HOME: root, USERPROFILE: root, XDG_CONFIG_HOME: join(root, 'config'),
    XDG_CACHE_HOME: join(root, 'cache'), CODEX_HOME: codexHome, RUST_LOG: 'warn' };
}

async function fileEntry(root, relative) {
  requireEvidence((await lstat(root)).isDirectory(), 'nonregular file root');
  let parent = root;
  for (const component of relative.split('/').slice(0, -1)) {
    parent = join(parent, component);
    requireEvidence((await lstat(parent)).isDirectory(), 'nonregular file ancestor');
  }
  const target = join(root, relative);
  const stat = await lstat(target);
  requireEvidence(stat.isFile(), `nonregular file: ${target}`);
  const bytes = await readFile(target);
  return { relative, type: 'file', size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') };
}
async function treeInventory(root, prefix = '') {
  requireEvidence((await lstat(join(root, prefix))).isDirectory(), 'nonregular directory');
  const result = [];
  for (const entry of await readdir(join(root, prefix), { withFileTypes: true })) {
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) result.push(...await treeInventory(root, relative));
    else result.push(await fileEntry(root, relative));
  }
  return result.sort((a, b) => a.relative.localeCompare(b.relative));
}

// POSIX children lead private process groups, so escalation reaches native
// descendants even when a JavaScript launcher exits or ignores termination.
// Windows uses taskkill's tree operation instead of killing only the launcher.
function stopOwnedTree(child) {
  if (!child.pid) return Promise.resolve();
  if (process.platform === 'win32') {
    return new Promise((resolveStop, rejectStop) => {
      const killer = spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { shell: false, stdio: 'ignore' });
      const timer = setTimeout(() => { killer.kill(); rejectStop(new Error('Process-tree termination timed out')); }, 1500);
      killer.once('error', error => { clearTimeout(timer); rejectStop(error); });
      killer.once('close', code => {
        clearTimeout(timer);
        if (code === 0) resolveStop();
        else rejectStop(new Error(`Process-tree termination failed: ${code}`));
      });
    });
  }
  const signal = name => {
    try { process.kill(-child.pid, name); }
    catch (error) { if (error.code !== 'ESRCH') throw error; }
  };
  return new Promise((resolveStop, rejectStop) => {
    try { signal('SIGTERM'); } catch (error) { rejectStop(error); return; }
    setTimeout(() => {
      try { signal('SIGKILL'); resolveStop(); } catch (error) { rejectStop(error); }
    }, 250);
  });
}

// close confirms inherited pipes have closed; tree escalation also completes
// before callers may clean their fixture. The final deadline bounds broken
// pipe/OS shutdown behavior without retaining unbounded output buffers.
function failureBoundary(child, reject) {
  let stopping;
  const closed = new Promise(resolveClose => child.once('close', resolveClose));
  return error => {
    if (stopping) return;
    stopping = true;
    const deadline = setTimeout(() => {
      childShutdownIncomplete = true;
      child.stdin?.destroy();
      child.stdout.destroy();
      child.stderr.destroy();
      reject(new Error(`${error.message}; process-tree shutdown did not complete`));
    }, 2000);
    Promise.all([stopOwnedTree(child), closed]).then(() => {
      clearTimeout(deadline);
      reject(error);
    }, shutdownError => {
      clearTimeout(deadline);
      childShutdownIncomplete = true;
      child.stdin?.destroy();
      child.stdout.destroy();
      child.stderr.destroy();
      reject(new Error(`${error.message}; ${shutdownError.message}`));
    });
  };
}

export function appServerRefresh(request, context, { timeoutMs = COMMAND_TIMEOUT_MS } = {}) {
  return new Promise((resolvePromise, reject) => {
    const initialize = { request: { id: 'initialize-1', method: 'initialize', params: {
      clientInfo: { name: 'ape-marketplace-smoke', version: '1.0.0' },
    } }, response: null, initialized: false };
    const child = spawn(context.host.command, context.host.args, { shell: false, detached: process.platform !== 'win32',
      cwd: context.ownedRoot, env: isolatedEnv(context.ownedRoot, context.codexHome), stdio: ['pipe', 'pipe', 'pipe'] });
    let buffer = '', diagnostics = '', response, failure;
    let bytes = 0;
    const stop = failureBoundary(child, reject);
    const fail = (error) => {
      if (failure) return;
      failure = error;
      clearTimeout(timer);
      stop(error);
    };
    const timer = setTimeout(() => fail(new Error('Codex refresh timed out')), timeoutMs);
    const send = value => child.stdin.write(`${JSON.stringify(value)}\n`);
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', chunk => {
      if (failure) return;
      bytes += Buffer.byteLength(chunk);
      if (bytes > 8 * 1024 * 1024) { fail(new Error('Codex refresh output overflow')); return; }
      diagnostics += chunk;
    });
    child.stdout.on('data', chunk => {
      if (failure) return;
      bytes += Buffer.byteLength(chunk);
      if (bytes > 8 * 1024 * 1024) { fail(new Error('Codex refresh output overflow')); return; }
      buffer += chunk;
      let newline;
      while ((newline = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        try {
          if (!line.trim()) continue;
          const message = JSON.parse(line);
          if (message.id === initialize.request.id) {
            requireEvidence(!initialize.response && message.result && !message.error, 'host initialization response');
            initialize.response = message;
            send({ method: 'initialized' });
            initialize.initialized = true;
            send(request);
          } else if (message.id === request.id) {
            requireEvidence(initialize.initialized && !response && message.result && !message.error, 'host refresh response');
            response = message;
            child.stdin.end();
          } else if (message.id != null) throw new Error('Unexpected app-server response id');
          // Notifications are separate from correlated operation completion.
        } catch (error) { fail(error); return; }
      }
    });
    child.stdin.on('error', fail);
    child.once('error', fail);
    child.once('close', (exitCode, signal) => {
      clearTimeout(timer);
      if (failure) return;
      else if (!response || exitCode !== 0 || signal || buffer.trim()) reject(new Error(`Incomplete Codex refresh: ${exitCode}/${signal}: ${diagnostics}`));
      else resolvePromise({ transport: 'app-server-stdio', initialize, request, response,
        completion: { exitCode, signal, timedOut: false, outputOverflow: false, earlyExit: false },
        diagnostics: diagnostics.split(/\r?\n/u).filter(Boolean) });
    });
    send(initialize.request);
  });
}

async function smokeDevelopmentRefresh(modulesRoot, mode) {
  const allocated = await mkdtemp(join(tmpdir(), 'ape-codex-refresh-'));
  const ownedRoot = await realpath(allocated);
  const codexHome = join(ownedRoot, 'codex-home');
  const pluginRoot = join(ownedRoot, 'plugin');
  try {
    await mkdir(codexHome, { mode: 0o700 });
    await cp(join(REPO_ROOT, 'plugins/ape'), pluginRoot, { recursive: true });
    const host = compatibility.hosts.codex;
    const invocation = await resolveMarketplaceHostInvocation({ identity: 'codex', packageName: host.package, modulesRoot, args: ['app-server'] });
    const manifest = JSON.parse(await readFile(join(pluginRoot, '.codex-plugin/plugin.json'), 'utf8'));
    const inventory = await treeInventory(pluginRoot);
    const cachebusters = ['001-old', '002-new'];
    const [oldVersion, newVersion] = cachebusters.map(token => `${manifest.version.split('+')[0]}+codex.${token}`);
    const versionInventory = version => inventory.map(entry => {
      if (entry.relative !== '.codex-plugin/plugin.json') return entry;
      const bytes = Buffer.from(`${JSON.stringify({ ...manifest, version }, null, 2)}\n`);
      return { ...entry, size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') };
    });
    const oldRoot = join(codexHome, 'plugins/cache/ape-dev/ape', oldVersion);
    const marketplace = join(codexHome, 'dev-plugins/ape-dev');
    const expected = { host: { package: host.package, version: host.version, ...invocation }, ownedRoot, codexHome, pluginRoot,
      pluginId: 'ape@ape-dev', mode, oldVersion, newVersion, source: join(marketplace, 'versions/ape', newVersion),
      selectedRoot: join(codexHome, 'plugins/cache/ape-dev/ape', newVersion),
      baseline: PINNED_FILES.map(relative => ({ ...inventory.find(entry => entry.relative === relative), path: join(oldRoot, relative) })),
      sourceInventory: versionInventory(newVersion), oldSource: join(marketplace, 'versions/ape', oldVersion),
      oldSourceInventory: versionInventory(oldVersion), cachebusters };
    const options = { cwd: ownedRoot, env: isolatedEnv(ownedRoot, codexHome) };
    const inspectTree = async root => ({ root, manifest: JSON.parse(await readFile(join(root, '.codex-plugin/plugin.json'), 'utf8')), inventory: await treeInventory(root) });
    const operations = {
      verifyRelease: async () => {
        await assertHostVersion('codex', 'blocking', modulesRoot, options);
        await hostCommand('codex', ['plugin', 'marketplace', 'add', REPO_ROOT, '--json'], options, modulesRoot);
        await hostCommand('codex', ['plugin', 'add', 'ape@ape', '--json'], options, modulesRoot);
        await verifyInstalledPackage('codex', await findPackage(codexHome, '.codex-plugin'));
      },
      reinstall: async config => {
        await command(process.execPath, [join(REPO_ROOT, 'scripts/reinstall-codex-plugin.mjs'),
          '--codex-home', config.codexHome, '--plugin-root', config.pluginRoot, '--codex-bin', config.codexBin,
          '--cachebuster', config.cachebuster, ...(config.preserveOpenTasks ? ['--preserve-open-tasks'] : [])], options);
      },
      observe: async phase => {
        const initial = phase === 'beforeReinstall';
        const originals = await Promise.all(expected.baseline.map(async entry => {
          try { return { ...await fileEntry(oldRoot, entry.relative), path: entry.path, state: 'present' }; }
          catch (error) {
            if (error.code !== 'ENOENT') throw error;
            return { relative: entry.relative, path: entry.path, state: 'absent', error: 'ENOENT' };
          }
        }));
        const listing = JSON.parse((await hostCommand('codex', ['plugin', 'list', '--marketplace', 'ape-dev', '--json'], options, modulesRoot)).stdout);
        requireEvidence(Array.isArray(listing.installed), 'CLI installed inventory');
        const selected = await Promise.all(listing.installed.map(async entry => {
          requireEvidence(entry.pluginId === expected.pluginId && [oldVersion, newVersion].includes(entry.version), 'CLI selection identity');
          const root = join(codexHome, 'plugins/cache/ape-dev/ape', entry.version);
          return { pluginId: entry.pluginId, version: entry.version, source: entry.source, ...await inspectTree(root) };
        }));
        const archiveRoot = join(marketplace, 'retained-cache/ape', oldVersion);
        return { phase, originals, outcome: originals.every(entry => entry.state === 'present') ? 'retained' : 'absent',
          archive: initial ? null : { root: archiveRoot, inventory: await Promise.all(PINNED_FILES.map(relative => fileEntry(archiveRoot, relative))) },
          source: await inspectTree(initial ? expected.oldSource : expected.source), selected };
      },
      refresh: appServerRefresh,
      cleanup: async root => {
        requireEvidence(root === ownedRoot, 'cleanup ownership');
        await cleanupFixture(root);
      },
    };
    const evidence = await collectCodexRefreshEvidence({ expected, operations });
    // Keep console evidence bounded; complete inventories were checked above.
    process.stdout.write(`Codex refresh evidence: ${JSON.stringify({ schemaVersion: evidence.schemaVersion,
      host: expected.host, mode, codexHome, activation: evidence.activation,
      request: evidence.refresh.request, completion: evidence.refresh.completion, diagnostics: evidence.refresh.diagnostics,
      observations: evidence.observations.map(({ phase, originals, outcome, archive, source, selected }) => ({
        phase, originals, outcome, archive, source: { root: source.root, version: source.manifest.version, files: source.inventory.length },
        selected: selected.map(entry => ({ pluginId: entry.pluginId, version: entry.version, root: entry.root, source: entry.source, files: entry.inventory.length })),
      })) })}\n`);
  } finally {
    await cleanupFixture(ownedRoot);
  }
}

async function exists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

export function command(program, args, options = {}) {
  const { timeoutMs = COMMAND_TIMEOUT_MS, ...spawnOptions } = options;
  return new Promise((resolvePromise, reject) => {
    const child = spawn(program, args, {
      ...spawnOptions,
      shell: false,
      detached: process.platform !== 'win32',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let failure;
    let bytes = 0;
    const stop = failureBoundary(child, reject);
    const fail = error => {
      if (failure) return;
      failure = error;
      clearTimeout(timer);
      stop(error);
    };
    const timer = setTimeout(() => fail(new Error(`${program} ${args.join(' ')} timed out`)), timeoutMs);
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    const bounded = chunk => {
      if (failure) return false;
      bytes += Buffer.byteLength(chunk);
      if (bytes <= 8 * 1024 * 1024) return true;
      fail(new Error(`${program} output overflow`));
      return false;
    };
    child.stdout.on('data', (chunk) => { if (bounded(chunk)) stdout += chunk; });
    child.stderr.on('data', (chunk) => { if (bounded(chunk)) stderr += chunk; });
    child.once('error', fail);
    child.once('close', (code, signal) => {
      clearTimeout(timer);
      if (failure) return;
      else if (signal) reject(new Error(`${program} terminated by ${signal}`));
      else if (code !== 0) reject(new Error(`${program} ${args.join(' ')} exited ${code}: ${stderr}`));
      else resolvePromise({ stdout, stderr });
    });
  });
}

function npmCommand(args, options = {}) {
  const npmExecPath = options.env?.npm_execpath ?? process.env.npm_execpath;
  if (typeof npmExecPath === 'string' && npmExecPath.trim()) {
    return command(process.execPath, [npmExecPath, ...args], options);
  }
  if (process.platform === 'win32') {
    return Promise.reject(new Error('npm_execpath is required for shell-free npm execution on Windows'));
  }
  return command('npm', args, options);
}

function pinnedNpmEnv(env) {
  return {
    ...env,
    npm_config_ignore_scripts: 'false',
    npm_config_omit: '',
    npm_config_optional: 'true',
  };
}

async function hostCommand(identity, args, options, modulesRoot) {
  const host = compatibility.hosts[identity];
  const invocation = await resolveMarketplaceHostInvocation({
    identity,
    packageName: host.package,
    modulesRoot,
    args,
  });
  return command(invocation.command, invocation.args, options);
}

async function findPackage(root, manifestDirectory) {
  const matches = [];
  async function visit(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const target = join(directory, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        if (entry.name === manifestDirectory) {
          const manifestPath = join(target, 'plugin.json');
          if (await exists(manifestPath)) {
            const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
            if (manifest.name === 'ape' && manifest.version === VERSION) {
              matches.push(dirname(target));
            }
          }
        } else await visit(target);
      }
    }
  }
  await visit(root);
  const cache = matches.filter((candidate) => candidate.split(/[\\/]/u).includes('cache'));
  const selected = cache.length === 1 ? cache[0] : matches.length === 1 ? matches[0] : null;
  if (!selected) throw new Error(`could not identify one installed ${manifestDirectory} APE package in ${root}`);
  return selected;
}

async function assertNoAssets(root) {
  async function visit(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (entry.name === 'assets') throw new Error(`installed package unexpectedly contains assets: ${join(directory, entry.name)}`);
      if (entry.isDirectory()) await visit(join(directory, entry.name));
    }
  }
  await visit(root);
}

function expandBundle(value, host, pluginRoot) {
  if (host === 'claude') return value.replaceAll('${CLAUDE_PLUGIN_ROOT}', pluginRoot);
  return isAbsolute(value) ? value : resolve(pluginRoot, value);
}

async function initializeInstalled(host, pluginRoot) {
  const declaration = JSON.parse(await readFile(join(pluginRoot, '.mcp.json'), 'utf8'))
    ?.mcpServers?.ape;
  if (declaration?.command !== 'node' || !Array.isArray(declaration.args)) {
    throw new Error(`${host} installed package has no local node MCP declaration`);
  }
  const args = declaration.args.map((value, index) =>
    index === 0 ? expandBundle(value, host, pluginRoot) : value
  );
  const env = { ...process.env };
  delete env.CLAUDE_PROJECT_DIR;
  delete env.CODEX_CWD;
  if (host === 'claude') env.CLAUDE_PLUGIN_ROOT = pluginRoot;
  else env.PLUGIN_ROOT = pluginRoot;
  const child = spawn(process.execPath, args, {
    cwd: declaration.cwd ? resolve(pluginRoot, declaration.cwd) : pluginRoot,
    env,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const response = await new Promise((resolvePromise, reject) => {
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`${host} installed MCP initialization timed out`));
    }, 10_000);
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.once('error', reject);
    child.once('close', (code) => {
      clearTimeout(timer);
      if (code !== 0) reject(new Error(`${host} installed MCP exited ${code}: ${stderr}`));
      else resolvePromise(JSON.parse(stdout.trim().split(/\r?\n/u)[0]));
    });
    child.stdin.end(`${JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { protocolVersion: '2025-06-18' },
    })}\n`);
  });
  if (response?.result?.serverInfo?.version !== VERSION) {
    throw new Error(`${host} installed MCP returned the wrong server version`);
  }
}

async function assertMatchingPackage(host, pluginRoot) {
  const directory = { codex: 'ape', claude: 'ape-claude' }[host];
  if (!directory) throw new Error(`unsupported installed package host: ${host}`);
  const candidateRoot = join(REPO_ROOT, 'plugins', directory);
  const refuse = (reason, name = 'package root') => {
    throw new Error(`${host} installed package ${reason}: ${JSON.stringify(name)}`);
  };
  async function visit(candidate, installed, prefix = '') {
    const roots = await Promise.all([lstat(candidate), lstat(installed)]);
    if (roots.some((entry) => !entry.isDirectory())) refuse('requires regular directories without links', prefix || 'package root');
    const [expected, observed] = await Promise.all([
      readdir(candidate, { withFileTypes: true }),
      readdir(installed, { withFileTypes: true }),
    ]);
    const expectedNames = new Set(expected.map((entry) => entry.name));
    const observedByName = new Map(observed.map((entry) => [entry.name, entry]));
    for (const entry of expected) {
      if (!observedByName.has(entry.name)) refuse('is missing a candidate entry', `${prefix}${entry.name}`);
    }
    for (const entry of observed) {
      if (!expectedNames.has(entry.name)) refuse('has an unexpected entry', `${prefix}${entry.name}`);
    }
    for (const entry of expected) {
      const actual = observedByName.get(entry.name);
      const name = `${prefix}${entry.name}`;
      const expectedPath = join(candidate, entry.name);
      const actualPath = join(installed, entry.name);
      if (entry.isDirectory() && actual.isDirectory()) {
        await visit(expectedPath, actualPath, `${name}/`);
      } else if (entry.isFile() && actual.isFile()) {
        const [expectedStat, actualStat] = await Promise.all([lstat(expectedPath), lstat(actualPath)]);
        if (!expectedStat.isFile() || !actualStat.isFile()) refuse('requires regular files without links', name);
        if (expectedStat.size !== actualStat.size) refuse('has modified file bytes', name);
        const [expectedBytes, actualBytes] = await Promise.all([readFile(expectedPath), readFile(actualPath)]);
        if (!expectedBytes.equals(actualBytes)) refuse('has modified file bytes', name);
      } else refuse('has a different entry type or unsupported link/special file', name);
    }
  }
  await visit(candidateRoot, pluginRoot);
}

// This is a staged package check; successful initialization does not establish
// that a persistent host has loaded or trusted the installed hooks.
export async function verifyInstalledPackage(host, pluginRoot) {
  await assertMatchingPackage(host, pluginRoot);
  await assertNoAssets(pluginRoot);
  await initializeInstalled(host, pluginRoot);
}

export function requestedOptions(argv) {
  let mode = 'blocking';
  let linux = false;
  let hosts = new Set(Object.keys(compatibility.hosts));
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === '--linux') { linux = true; continue; }
    if (token === '--edge') {
      if (mode === 'installed') throw new Error('--edge and --installed-hosts are mutually exclusive');
      mode = 'edge';
      continue;
    }
    if (token === '--installed-hosts') {
      if (mode === 'edge') throw new Error('--edge and --installed-hosts are mutually exclusive');
      mode = 'installed';
      continue;
    }
    if (token === '--host' && compatibility.hosts[argv[index + 1]]) {
      hosts = new Set([argv[index + 1]]);
      index += 1;
      continue;
    }
    throw new Error('usage: node scripts/smoke-marketplace-install.mjs [--host codex|claude] [--linux | --edge | --installed-hosts]');
  }
  if (linux && mode !== 'blocking') throw new Error('--linux requires pinned hosts; it cannot combine with --edge or --installed-hosts');
  return { hosts, mode, linux };
}

// Only the public package inputs and this probe's source closure cross into
// Linux. Never mount the checkout, its ancestry, node_modules, or user homes.
const LINUX_INPUTS = Object.freeze([
  'package.json', 'package-lock.json', 'compatibility.json',
  '.agents/plugins/marketplace.json', '.claude-plugin/marketplace.json',
  'plugins/ape', 'plugins/ape-claude', 'lib/runtime',
  'scripts/smoke-marketplace-install.mjs', 'scripts/marketplace-host-invocation.mjs',
  'scripts/reinstall-codex-plugin.mjs', 'scripts/dev-plugin-files.mjs',
]);

export async function linuxMarketplaceSmoke({ hosts = new Set(Object.keys(compatibility.hosts)),
  execute = command, repoRoot = REPO_ROOT } = {}) {
  if ([...hosts].some(host => !Object.hasOwn(compatibility.hosts, host)) || hosts.size === 0) {
    throw new Error('unsupported Linux smoke host');
  }
  // Reserve the final minute of the published 15-minute profile for cleanup.
  const deadline = Date.now() + 840_000;
  const runDocker = (args, limit = COMMAND_TIMEOUT_MS) => execute('docker', args, {
    timeoutMs: Math.max(1, Math.min(limit, deadline - Date.now())),
  });
  // Fail before allocating a snapshot when Docker is unavailable.
  await runDocker(['info', '--format', '{{.ServerVersion}}']);
  const image = `node:${compatibility.node.blocking}-bookworm`;
  await runDocker(['pull', image], 300_000);
  const scratch = await mkdtemp(join(tmpdir(), 'ape-linux-marketplace-'));
  const snapshot = join(scratch, 'public');
  const name = `ape-marketplace-${randomUUID()}`;
  let allocated = false;
  let createAttempted = false;
  let interrupted = false;
  let cleanup;
  const removeContainer = () => cleanup ??= execute('docker', ['rm', '--force', name]).catch(error => {
    if (!allocated && /No such container/iu.test(error.message)) return;
    throw error;
  });
  const onSignal = () => {
    interrupted = true;
    if (allocated) void removeContainer().catch(() => {});
  };
  try {
    for (const relative of LINUX_INPUTS) {
      const destination = join(snapshot, relative);
      await mkdir(dirname(destination), { recursive: true });
      await cp(join(repoRoot, relative), destination, { recursive: true, filter: async source => {
        const entry = await lstat(source);
        if (!entry.isFile() && !entry.isDirectory()) throw new Error('Linux smoke refuses linked or special snapshot inputs');
        return true;
      } });
    }
    const hostArgs = hosts.size === 1 ? ['--host', [...hosts][0]] : [];
    const script = 'mkdir -p "$HOME" /workspace && cp -R /ape-input/. /workspace/ && cd /workspace && ' +
      'npm ci --ignore-scripts --no-audit --no-fund && exec node scripts/smoke-marketplace-install.mjs "$@"';
    process.once('SIGINT', onSignal);
    process.once('SIGTERM', onSignal);
    createAttempted = true;
    await runDocker(['create', '--name', name, '--init',
      '--mount', `type=bind,source=${snapshot},target=/ape-input,readonly`,
      '--env', 'HOME=/tmp/ape-linux-home', image, 'sh', '-ec', script, 'ape-linux-smoke', ...hostArgs]);
    allocated = true;
    if (interrupted) throw new Error('Linux marketplace smoke interrupted');
    const result = await runDocker(['start', '--attach', name], 720_000);
    process.stdout.write(result.stdout);
    if (result.stderr) process.stderr.write(result.stderr);
    const observed = await runDocker(['inspect', '--format', '{{json .State}}', name]);
    const state = JSON.parse(observed.stdout);
    if (interrupted || state.Status !== 'exited' || state.ExitCode !== 0 || state.OOMKilled !== false) {
      throw new Error(`Linux marketplace container did not complete successfully (${state.Status}/${state.ExitCode})`);
    }
    return { platform: 'linux', node: compatibility.node.blocking, hosts: [...hosts] };
  } finally {
    process.removeListener('SIGINT', onSignal);
    process.removeListener('SIGTERM', onSignal);
    // Keep the snapshot if owned-container removal fails; it may still be in use.
    if (createAttempted) await removeContainer();
    await rm(scratch, { recursive: true, force: true });
  }
}

async function assertHostVersion(identity, mode, modulesRoot, options) {
  const host = compatibility.hosts[identity];
  const result = await hostCommand(identity, ['--version'], options, modulesRoot);
  const output = `${result.stdout}\n${result.stderr}`.trim();
  const observed = output.match(/\d+\.\d+\.\d+/u)?.[0];
  if (!observed) throw new Error(`${identity} --version did not report a semantic version: ${output}`);
  if (mode === 'edge') {
    process.stdout.write(`${identity} informational edge version: ${observed}\n`);
  } else if (observed !== host.version) {
    throw new Error(`${identity} version ${observed} does not match compatibility pin ${host.version}`);
  }
}

async function main(argv = process.argv.slice(2)) {
  const { hosts, mode, linux } = requestedOptions(argv);
  if (linux) return linuxMarketplaceSmoke({ hosts });
  const scratch = await mkdtemp(join(tmpdir(), 'ape-clean-marketplace-'));
  const toolsRoot = join(scratch, 'host-tools');
  const codexHome = join(scratch, 'codex-home');
  const claudeConfig = join(scratch, 'claude-config');
  await mkdir(codexHome, { recursive: true, mode: 0o700 });
  await mkdir(claudeConfig, { recursive: true, mode: 0o700 });
  try {
    let modulesRoot;
    if (mode === 'blocking') {
      const packages = [...hosts].map((identity) => {
        const host = compatibility.hosts[identity];
        return `${host.package}@${host.version}`;
      });
      await npmCommand(['install', '--no-save', '--prefix', toolsRoot, ...packages], {
        cwd: scratch,
        env: pinnedNpmEnv(process.env),
        // A cold install downloads the pinned host's platform package. Keep
        // CLI and MCP probes bounded at one minute, but do not classify a
        // merely slow package registry as a broken APE marketplace package.
        timeoutMs: HOST_PACKAGE_INSTALL_TIMEOUT_MS,
      });
      modulesRoot = join(toolsRoot, 'node_modules');
    } else {
      // CI can reuse its explicitly installed toolchain while still enforcing
      // exact host pins. Only the separate edge mode permits newer versions.
      const rootResult = await npmCommand(['root', '--global'], { cwd: scratch, env: process.env });
      modulesRoot = rootResult.stdout.trim();
      if (!isAbsolute(modulesRoot)) throw new Error('npm root --global did not return an absolute path');
    }
    if (hosts.has('codex')) {
      const codexEnv = isolatedEnv(scratch, codexHome);
      await assertHostVersion('codex', mode, modulesRoot, { cwd: scratch, env: codexEnv });
      await hostCommand('codex', ['plugin', 'marketplace', 'add', REPO_ROOT, '--json'], { cwd: scratch, env: codexEnv }, modulesRoot);
      await hostCommand('codex', ['plugin', 'add', 'ape@ape', '--json'], { cwd: scratch, env: codexEnv }, modulesRoot);
      const codexPackage = await findPackage(codexHome, '.codex-plugin');
      await verifyInstalledPackage('codex', codexPackage);
      process.stdout.write('Codex clean marketplace install and local stdio MCP initialization passed\n');
      if (mode !== 'edge') {
        await smokeDevelopmentRefresh(modulesRoot, 'default');
        await smokeDevelopmentRefresh(modulesRoot, 'preserve-open-tasks');
      }
    }

    if (hosts.has('claude')) {
      const claudeEnv = { ...process.env, CLAUDE_CONFIG_DIR: claudeConfig };
      await assertHostVersion('claude', mode, modulesRoot, { cwd: scratch, env: claudeEnv });
      await hostCommand('claude', ['plugin', 'marketplace', 'add', REPO_ROOT, '--scope', 'user'], { cwd: scratch, env: claudeEnv }, modulesRoot);
      await hostCommand('claude', ['plugin', 'install', 'ape@ape', '--scope', 'user'], { cwd: scratch, env: claudeEnv }, modulesRoot);
      const claudePackage = await findPackage(claudeConfig, '.claude-plugin');
      await verifyInstalledPackage('claude', claudePackage);
      process.stdout.write('Claude clean marketplace install and local stdio MCP initialization passed\n');
    }
  } finally {
    await cleanupFixture(scratch);
  }
}

const invokedDirectly = process.argv[1]
  && await realpath(process.argv[1]).catch(() => null) === await realpath(fileURLToPath(import.meta.url));
if (invokedDirectly) main().catch((error) => {
  process.stderr.write(`smoke-marketplace-install: ${error?.message ?? String(error)}\n`);
  process.exitCode = 1;
});
