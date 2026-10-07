import { chmod, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import * as marketplaceSmoke from '../scripts/smoke-marketplace-install.mjs';
import { afterEach, describe, expect, it } from 'vitest';

// Version-1 executable evidence contract. These synthetic records and injected
// operations test validation and orchestration, never certify a real host refresh.
// The live smoke must use its real operations and independently built expectations.
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');
const phases = ['beforeReinstall', 'afterReinstall', 'afterRefresh'];
const clone = (value) => structuredClone(value);

function refreshContract(mode = 'default', suffix = 'one') {
  const ownedRoot = path.join(tmpdir(), 'ape-refresh-contract-' + suffix);
  const codexHome = path.join(ownedRoot, 'codex-home');
  const oldVersion = '2.13.0+codex.001-old';
  const newVersion = '2.13.0+codex.002-new';
  const marketplaceRoot = path.join(codexHome, 'dev-plugins/ape-dev');
  const oldRoot = path.join(codexHome, 'plugins/cache/ape-dev/ape', oldVersion);
  const source = path.join(marketplaceRoot, 'versions/ape', newVersion);
  const oldSource = path.join(marketplaceRoot, 'versions/ape', oldVersion);
  const selectedRoot = path.join(codexHome, 'plugins/cache/ape-dev/ape', newVersion);
  const file = (relative, bytes) => ({ relative, type: 'file', size: Buffer.byteLength(bytes), sha256: digest(bytes) });
  const baseline = pinnedFiles.map((relative) => ({
    ...file(relative, 'original ' + relative),
    path: path.join(oldRoot, relative),
  }));
  const inventory = [
    file('.codex-plugin/plugin.json', JSON.stringify({ name: 'ape', version: newVersion })),
    ...pinnedFiles.map((relative) => file(relative, 'new ' + relative)),
  ];
  const oldInventory = [
    file('.codex-plugin/plugin.json', JSON.stringify({ name: 'ape', version: oldVersion })),
    ...baseline.map(({ path: _path, ...entry }) => entry),
  ];
  const expected = {
    host: { package: '@openai/codex', version: '0.153.4', command: process.execPath, args: [path.join(ownedRoot, 'host/bin/codex.js'), 'app-server'], shell: false },
    ownedRoot, codexHome, pluginRoot: path.join(ownedRoot, 'plugin'),
    pluginId: 'ape@ape-dev', mode, oldVersion, newVersion, source, selectedRoot,
    baseline, sourceInventory: inventory, oldSource, oldSourceInventory: oldInventory,
    cachebusters: ['001-old', '002-new'],
  };
  const selection = {
    pluginId: expected.pluginId, version: newVersion,
    source: { source: 'local', path: source }, root: selectedRoot,
    manifest: { name: 'ape', version: newVersion }, inventory: clone(inventory),
  };
  const request = { id: 'refresh-2', method: 'plugin/list', params: { cwds: [], marketplaceKinds: ['local'], forceRefetch: true } };
  const evidence = {
    schemaVersion: 1, context: clone(expected), activation: 'unverified',
    refresh: {
      transport: 'app-server-stdio',
      initialize: {
        request: { id: 'initialize-1', method: 'initialize', params: { clientInfo: { name: 'ape-marketplace-smoke', version: '1.0.0' } } },
        response: { id: 'initialize-1', result: { userAgent: 'codex/0.153.4' } },
        initialized: true,
      },
      request,
      response: { id: request.id, result: {
        marketplaces: [{ name: 'ape-dev', path: marketplaceRoot, plugins: [{
          id: 'ape@ape-dev', name: 'ape', installed: true, enabled: true,
          source: { type: 'local', path: source }, localVersion: newVersion,
        }] }],
        marketplaceLoadErrors: [], featuredPluginIds: [],
      } },
      completion: { exitCode: 0, signal: null, timedOut: false, outputOverflow: false, earlyExit: false },
      diagnostics: [],
    },
    observations: phases.map((phase, index) => ({
      phase,
      originals: baseline.map((entry) => index === 0 || mode === 'preserve-open-tasks'
        ? { ...entry, state: 'present' }
        : { path: entry.path, relative: entry.relative, state: 'absent', error: 'ENOENT' }),
      outcome: index === 0 || mode === 'preserve-open-tasks' ? 'retained' : 'absent',
      archive: index === 0 ? null : {
        root: path.join(marketplaceRoot, 'retained-cache/ape', oldVersion),
        inventory: baseline.map(({ path: _path, ...entry }) => entry),
      },
      source: index === 0 ? {
        root: oldSource, manifest: { name: 'ape', version: oldVersion }, inventory: clone(oldInventory),
      } : {
        root: source, manifest: { name: 'ape', version: newVersion }, inventory: clone(inventory),
      },
      selected: index === 0 ? [{
        pluginId: expected.pluginId, version: oldVersion,
        source: { source: 'local', path: oldSource }, root: oldRoot,
        manifest: { name: 'ape', version: oldVersion }, inventory: clone(oldInventory),
      }] : [clone(selection)],
    })),
  };
  return { expected, evidence };
}

async function validate(evidence, expected) {
  expect(marketplaceSmoke.validateCodexRefreshEvidence, 'missing executable refresh evidence validator').toBeTypeOf('function');
  // Success resolves (the return value is intentionally not prescribed); invalid
  // evidence must throw/reject rather than return a failure-shaped value.
  return marketplaceSmoke.validateCodexRefreshEvidence(evidence, expected);
}

describe('pinned Codex refresh evidence validator (synthetic records)', () => {
  it.each(['default', 'preserve-open-tasks'])('accepts complete %s observations without claiming activation', async (mode) => {
    const { expected, evidence } = refreshContract(mode);
    await expect(validate(evidence, expected)).resolves.not.toBe(false);
    expect(evidence.activation).toBe('unverified');
  });

  const faults = [
    ['missing refresh', (e) => { delete e.refresh; }],
    ['plain CLI listing', (e) => { e.refresh.transport = 'cli'; }],
    ['missing forceRefetch', (e) => { delete e.refresh.request.params.forceRefetch; }],
    ['false forceRefetch', (e) => { e.refresh.request.params.forceRefetch = false; }],
    ['remote scope', (e) => { e.refresh.request.params.marketplaceKinds = ['remote']; }],
    ['unbounded cwd scope', (e) => { e.refresh.request.params.cwds = ['/operator']; }],
    ['wrong method', (e) => { e.refresh.request.method = 'plugin/install'; }],
    ['missing correlation', (e) => { delete e.refresh.response.id; }],
    ['wrong correlation', (e) => { e.refresh.response.id = 'another-request'; }],
    ['reused initialize id', (e) => { e.refresh.request.id = e.refresh.response.id = 'initialize-1'; }],
    ['uninitialized host', (e) => { e.refresh.initialize.initialized = false; }],
    ['failed initialization', (e) => { e.refresh.initialize.response = { id: 'initialize-1', error: { code: -1, message: 'failed' } }; }],
    ['error response', (e) => { e.refresh.response.error = { code: -1, message: 'failed' }; }],
    ['missing result', (e) => { delete e.refresh.response.result; }],
    ['malformed marketplaces', (e) => { e.refresh.response.result.marketplaces = {}; }],
    ['missing featured ids', (e) => { delete e.refresh.response.result.featuredPluginIds; }],
    ['load errors', (e) => { e.refresh.response.result.marketplaceLoadErrors = [{ message: 'failed' }]; }],
    ['missing load errors', (e) => { delete e.refresh.response.result.marketplaceLoadErrors; }],
    ['failed child', (e) => { e.refresh.completion.exitCode = 1; }],
    ['timeout', (e) => { e.refresh.completion.timedOut = true; }],
    ['signal', (e) => { e.refresh.completion.signal = 'SIGTERM'; }],
    ['overflow', (e) => { e.refresh.completion.outputOverflow = true; }],
    ['early exit', (e) => { e.refresh.completion.earlyExit = true; }],
    ['missing completion', (e) => { delete e.refresh.completion; }],
    ['swallowed refresh failure', (e) => { e.refresh.diagnostics = ['WARN failed to refresh configured plugin ape@ape-dev']; }],
    ['wrong localVersion despite correct CLI version', (e) => { e.refresh.response.result.marketplaces[0].plugins[0].localVersion = '2.13.0'; }],
    ['missing localVersion', (e) => { delete e.refresh.response.result.marketplaces[0].plugins[0].localVersion; }],
    ['wrong app-server identity', (e) => { e.refresh.response.result.marketplaces[0].plugins[0].id = 'other@ape-dev'; }],
    ['wrong app-server source', (e) => { e.refresh.response.result.marketplaces[0].plugins[0].source.path += '-wrong'; }],
    ['uninstalled app-server selection', (e) => { e.refresh.response.result.marketplaces[0].plugins[0].installed = false; }],
    ['duplicate app-server identity', (e) => { e.refresh.response.result.marketplaces[0].plugins.push(clone(e.refresh.response.result.marketplaces[0].plugins[0])); }],
    ['wrong schema', (e) => { e.schemaVersion = 2; }],
    ['wrong host package', (e) => { e.context.host.package = 'fake-codex'; }],
    ['wrong host version', (e) => { e.context.host.version = '0.153.5'; }],
    ['wrong executable', (e) => { e.context.host.command = '/another/codex'; }],
    ['shell invocation', (e) => { e.context.host.shell = true; }],
    ['changed argv', (e) => { e.context.host.args = ['plugin', 'list']; }],
    ['wrong home', (e) => { e.context.codexHome = '/operator/.codex'; }],
    ['wrong plugin identity', (e) => { e.context.pluginId = 'ape@ape'; }],
    ['wrong mode', (e) => { e.context.mode = 'default'; }],
    ['wrong source context', (e) => { e.context.source += '-other'; }],
    ['wrong version context', (e) => { e.context.newVersion = e.context.oldVersion; }],
    ['missing baseline', (e) => { delete e.context.baseline; }],
    ['missing phase', (e) => { e.observations.splice(1, 1); }],
    ['reordered phases', (e) => { e.observations.reverse(); }],
    ['duplicate phase', (e) => { e.observations[1] = clone(e.observations[0]); }],
    ['missing initial installation', (e) => { e.observations[0].selected = []; }],
    ['missing initial source', (e) => { e.observations[0].source = null; }],
    ['missing after-reinstall source', (e) => { e.observations[1].source = null; }],
    ['after-reinstall byte drift', (e) => { e.observations[1].selected[0].inventory[0].sha256 = digest('changed'); }],
    ['missing original path', (e) => { e.observations[2].originals.pop(); }],
    ['duplicate original path', (e) => { e.observations[2].originals[1] = clone(e.observations[2].originals[0]); }],
    ['archive substituted for original', (e) => { e.observations[2].originals[0].path = path.join(e.observations[2].archive.root, pinnedFiles[0]); }],
    ['source substituted for original', (e) => { e.observations[2].originals[0].path = path.join(e.context.source, pinnedFiles[0]); }],
    ['new cache substituted for original', (e) => { e.observations[2].originals[0].path = path.join(e.context.selectedRoot, pinnedFiles[0]); }],
    ['changed original bytes', (e) => { e.observations[2].originals[0].sha256 = digest('changed'); }],
    ['invalid digest', (e) => { e.observations[2].originals[0].sha256 = 'xyz'; }],
    ['invalid size', (e) => { e.observations[2].originals[0].size = -1; }],
    ['symlink original', (e) => { e.observations[2].originals[0].type = 'symlink'; }],
    ['special file original', (e) => { e.observations[2].originals[0].type = 'fifo'; }],
    ['unreadable original mislabeled absent', (e) => { e.observations[2].originals[0] = { path: e.context.baseline[0].path, relative: pinnedFiles[0], state: 'absent', error: 'EACCES' }; }],
    ['lost preserve path', (e) => { e.observations[2].originals[0] = { path: e.context.baseline[0].path, relative: pinnedFiles[0], state: 'absent', error: 'ENOENT' }; }],
    ['incorrect retention outcome', (e) => { e.observations[2].outcome = 'absent'; }],
    ['wrong selected CLI version', (e) => { e.observations[2].selected[0].version = e.context.oldVersion; }],
    ['wrong selected source', (e) => { e.observations[2].selected[0].source.path += '-wrong'; }],
    ['nonlocal selected source', (e) => { e.observations[2].selected[0].source.source = 'git'; }],
    ['wrong selected identity', (e) => { e.observations[2].selected[0].pluginId = 'ape@ape'; }],
    ['missing selection', (e) => { e.observations[2].selected = []; }],
    ['duplicate selection', (e) => { e.observations[2].selected.push(clone(e.observations[2].selected[0])); }],
    ['wrong disk manifest', (e) => { e.observations[2].selected[0].manifest.version = e.context.oldVersion; }],
    ['source byte drift', (e) => { e.observations[2].source.inventory[1].sha256 = digest('changed'); }],
    ['cache byte drift', (e) => { e.observations[2].selected[0].inventory[1].sha256 = digest('changed'); }],
    ['both inventories lie consistently', (e) => { e.observations[2].source.inventory.pop(); e.observations[2].selected[0].inventory.pop(); }],
    ['archive missing', (e) => { e.observations[2].archive = null; }],
    ['archive byte drift', (e) => { e.observations[2].archive.inventory[0].sha256 = digest('changed'); }],
    ['unsupported retention guarantee', (e) => { e.retentionGuaranteed = true; }],
    ['unverified activation promoted', (e) => { e.activation = 'active'; }],
    ['unknown activation', (e) => { delete e.activation; }],
  ];
  it.each(faults)('rejects %s', async (_name, mutate) => {
    const { expected, evidence } = refreshContract('preserve-open-tasks');
    // Establish a valid control first: a validator that always throws is invalid.
    await validate(evidence, expected);
    mutate(evidence);
    await expect(validate(evidence, expected)).rejects.toThrow();
  });

  it('does not let self-declared context redefine the baseline or authorize an operator home', async () => {
    const { expected, evidence } = refreshContract();
    await validate(evidence, expected);
    evidence.context.baseline[0].sha256 = digest('replacement');
    evidence.observations[0].originals[0].sha256 = digest('replacement');
    await expect(validate(evidence, expected)).rejects.toThrow();
    const unowned = refreshContract();
    unowned.expected.codexHome = unowned.evidence.context.codexHome = '/operator/.codex';
    await expect(validate(unowned.evidence, unowned.expected)).rejects.toThrow();
  });

  it.each(['EACCES', undefined])('requires ENOENT for default-mode absence, rejecting %s', async (error) => {
    const { expected, evidence } = refreshContract();
    await validate(evidence, expected);
    evidence.observations[2].originals[0].error = error;
    await expect(validate(evidence, expected)).rejects.toThrow();
  });
});

// Collector adapter contract: real production defaults implement these same
// side effects; injected operations are solely for deterministic fault tests.
// collectCodexRefreshEvidence({ expected, operations }) returns validated evidence.
function collectorFixture(mode, suffix) {
  const { expected, evidence } = refreshContract(mode, suffix);
  const calls = [];
  const operations = {
    verifyRelease: async (context) => { calls.push(['release', context.codexHome]); },
    reinstall: async (options) => { calls.push(['reinstall', clone(options)]); },
    observe: async (phase, context) => {
      calls.push(['observe', phase, context.codexHome]);
      return clone(evidence.observations.find((entry) => entry.phase === phase));
    },
    refresh: async (request, context) => {
      calls.push(['refresh', clone(request), context.codexHome]);
      expect(request.method).toBe('plugin/list');
      expect(request.params).toEqual({ cwds: [], marketplaceKinds: ['local'], forceRefetch: true });
      return { ...clone(evidence.refresh), request: clone(request), response: { ...clone(evidence.refresh.response), id: request.id } };
    },
    cleanup: async (root) => { calls.push(['cleanup', root]); },
  };
  return { expected, evidence, operations, calls };
}

async function collect(options) {
  expect(marketplaceSmoke.collectCodexRefreshEvidence, 'missing executable refresh evidence collector').toBeTypeOf('function');
  return marketplaceSmoke.collectCodexRefreshEvidence(options);
}

describe('refresh collection ordering and failure boundaries (synthetic operations)', () => {
  it.each(['default', 'preserve-open-tasks'])('collects all stages in order for %s', async (mode) => {
    const f = collectorFixture(mode, mode);
    const result = await collect({ expected: f.expected, operations: f.operations });
    await validate(result, f.expected);
    expect(f.calls.map((entry) => entry[0])).toEqual([
      'release', 'reinstall', 'observe', 'reinstall', 'observe', 'refresh', 'observe', 'cleanup',
    ]);
    expect(f.calls.filter(([op]) => op === 'observe').map((entry) => entry[1])).toEqual(phases);
    const installs = f.calls.filter(([op]) => op === 'reinstall').map((entry) => entry[1]);
    expect(installs.map((options) => options.cachebuster)).toEqual(f.expected.cachebusters);
    for (const options of installs) {
      expect(options.codexHome).toBe(f.expected.codexHome);
      expect(options.pluginRoot).toBe(f.expected.pluginRoot);
      expect(options.codexBin).toBe(f.expected.host.args[0]);
    }
    expect(installs[1].preserveOpenTasks).toBe(mode === 'preserve-open-tasks');
    expect(f.calls.at(-1)).toEqual(['cleanup', f.expected.ownedRoot]);
    expect(result.activation).toBe('unverified');
  });

  it('keeps concurrent mode fixtures and cleanup roots independent', async () => {
    const fixtures = [collectorFixture('default', 'parallel-default'), collectorFixture('preserve-open-tasks', 'parallel-preserve')];
    const results = await Promise.all(fixtures.map((f) => collect({ expected: f.expected, operations: f.operations })));
    expect(new Set(results.map((r) => r.context.codexHome)).size).toBe(2);
    for (const f of fixtures) {
      expect(f.calls.filter(([op]) => op === 'cleanup')).toEqual([['cleanup', f.expected.ownedRoot]]);
      expect(f.calls.filter(([op]) => op === 'observe').every((entry) => entry[2] === f.expected.codexHome)).toBe(true);
    }
  });

  it.each(['verifyRelease', 'reinstall', 'refresh', 'observe'])('suppresses evidence and cleans owned fixtures on %s failure', async (operation) => {
    const f = collectorFixture('default', 'failure-' + operation);
    f.operations[operation] = async () => { f.calls.push(['failure', operation]); throw new Error('injected ' + operation); };
    await expect(collect({ expected: f.expected, operations: f.operations })).rejects.toThrow('injected ' + operation);
    expect(f.calls.at(-1)).toEqual(['cleanup', f.expected.ownedRoot]);
    if (operation === 'verifyRelease') expect(f.calls.some(([op]) => op === 'reinstall')).toBe(false);
    if (operation === 'refresh') expect(f.calls.filter(([op]) => op === 'observe').map((entry) => entry[1])).toEqual(phases.slice(0, 2));
  });

  it('rejects a successful response followed by a fault at the final observation before certification', async () => {
    const f = collectorFixture('preserve-open-tasks', 'final-fault');
    const observe = f.operations.observe;
    f.operations.observe = async (...args) => {
      const observation = await observe(...args);
      if (args[0] === 'afterRefresh') observation.selected[0].inventory[1].sha256 = digest('concurrent replacement');
      return observation;
    };
    await expect(collect({ expected: f.expected, operations: f.operations })).rejects.toThrow();
    expect(f.calls.at(-1)).toEqual(['cleanup', f.expected.ownedRoot]);
  });

  it('can retry in a fresh owned home after an interrupted collection without reusing partial evidence', async () => {
    const interrupted = collectorFixture('default', 'interrupted');
    interrupted.operations.refresh = async () => { throw new Error('host exited before response'); };
    await expect(collect({ expected: interrupted.expected, operations: interrupted.operations })).rejects.toThrow();
    const recovered = collectorFixture('default', 'recovered');
    const result = await collect({ expected: recovered.expected, operations: recovered.operations });
    await validate(result, recovered.expected);
    expect(result.context.codexHome).not.toBe(interrupted.expected.codexHome);
    expect(recovered.calls.filter(([op]) => op === 'observe').map((entry) => entry[1])).toEqual(phases);
  });
});
const REPO_ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const SCRIPT = path.join(REPO_ROOT, 'scripts', 'reinstall-codex-plugin.mjs');
const temporaryRoots = [];

// Exercise real inherited pipes with a synthetic launcher/native-host pair.
// These faults certify subprocess containment, never a Codex refresh outcome.
// appServerRefresh accepts optional timeoutMs for bounded fault injection;
// command already accepts timeoutMs in its options. Both use production spawning.
async function inheritedPipeFixture(fault) {
  const root = await mkdtemp(path.join(tmpdir(), 'ape-refresh-child-tree-'));
  temporaryRoots.push(root);
  const launcher = path.join(root, 'launcher.mjs');
  const native = path.join(root, 'native.mjs');
  const heartbeat = path.join(root, 'heartbeat');
  const pids = path.join(root, 'pids.json');
  await mkdir(path.join(root, 'codex-home'));
  await writeFile(native, `
import { writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
let count = 0;
const pulse = () => writeFileSync(${JSON.stringify(heartbeat)}, String(++count));
pulse();
setInterval(pulse, 20);
// A native process may be stuck and ignore graceful shutdown. Escalation must
// reach it, even though its launcher owns the direct ChildProcess handle.
process.on('SIGTERM', () => {});
process.on('SIGINT', () => {});
const fault = ${JSON.stringify(fault)};
const trigger = () => {
  if (fault === 'malformed') process.stdout.write('not-json\\n');
  if (fault === 'overflow') {
    const chunk = Buffer.alloc(64 * 1024, 120);
    setInterval(() => process.stderr.write(chunk), 1);
  }
};
if (process.argv.includes('app-server')) {
  createInterface({ input: process.stdin }).on('line', line => {
    const request = JSON.parse(line);
    if (request.method === 'initialize') process.stdout.write(JSON.stringify({ id: request.id, result: {} }) + '\\n');
    if (request.method === 'plugin/list') trigger();
  });
} else trigger();
`);
  await writeFile(launcher, `
import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
const child = spawn(process.execPath, [${JSON.stringify(native)}, ...process.argv.slice(2)], { stdio: 'inherit' });
writeFileSync(${JSON.stringify(pids)}, JSON.stringify([process.pid, child.pid]));
for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(signal, () => child.kill(signal));
child.once('exit', () => process.exit(0));
`);
  return { root, launcher, heartbeat, pids };
}

async function assertContainedFailure(f, operation, expectedError) {
  let watchdog;
  try {
    const result = await Promise.race([
      operation().then(() => ({ success: true }), error => ({ error })),
      new Promise(resolve => { watchdog = setTimeout(() => resolve({ stalled: true }), 5000); }),
    ]);
    expect(result.stalled, 'failure must settle after stopping the inherited-pipe child').not.toBe(true);
    expect(result.success, 'a failed host must not certify success').not.toBe(true);
    expect(result.error?.message).toMatch(expectedError);
    // The fixture must have run; an export/launch error is not containment.
    const before = await readFile(f.heartbeat, 'utf8');
    await new Promise(resolve => setTimeout(resolve, 150));
    expect(await readFile(f.heartbeat, 'utf8'), 'native child must stop before caller cleanup').toBe(before);
  } finally {
    clearTimeout(watchdog);
    // Emergency test-only cleanup keeps a broken implementation from leaking
    // its native descendant into later tests. Never signal an unrecorded PID.
    const owned = await readFile(f.pids, 'utf8').then(JSON.parse).catch(() => []);
    for (const pid of owned.reverse()) {
      try { process.kill(pid, 'SIGKILL'); } catch (error) { if (error.code !== 'ESRCH') throw error; }
    }
  }
}

describe('smoke subprocess failure containment (synthetic inherited-pipe host)', () => {
  it.each(['timeout', 'overflow', 'malformed'])('stops native refresh activity on %s before returning failure', async fault => {
    expect(marketplaceSmoke.appServerRefresh, 'production refresh transport must be testable').toBeTypeOf('function');
    const f = await inheritedPipeFixture(fault);
    await assertContainedFailure(f, () => marketplaceSmoke.appServerRefresh(
      { id: 'refresh-2', method: 'plugin/list', params: { cwds: [], marketplaceKinds: ['local'], forceRefetch: true } },
      { ownedRoot: f.root, codexHome: path.join(f.root, 'codex-home'), host: { command: process.execPath, args: [f.launcher, 'app-server'] } },
      { timeoutMs: fault === 'timeout' ? 700 : 2500 },
    ), fault === 'timeout' ? /timed out/i : fault === 'overflow' ? /overflow/i : /JSON|Unexpected token/i);
  }, 10000);

  it.each(['timeout', 'overflow'])('stops helper descendants on %s before returning failure', async fault => {
    expect(marketplaceSmoke.command, 'production helper transport must be testable').toBeTypeOf('function');
    const f = await inheritedPipeFixture(fault);
    await assertContainedFailure(f, () => marketplaceSmoke.command(process.execPath, [f.launcher], {
      cwd: f.root, timeoutMs: fault === 'timeout' ? 700 : 2500,
    }), fault === 'timeout' ? /timed out/i : /overflow/i);
  }, 10000);
});

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

async function fixture({ fail = false, nativeFail = false, sourceType = 'local', omitRuntimeFile = false, omitGateRunner = false, omitFileStats = false } = {}) {
  const root = await mkdtemp(path.join(tmpdir(), 'ape-development-refresh-test-'));
  temporaryRoots.push(root);
  const pluginRoot = path.join(root, 'plugin');
  const codexHome = path.join(root, 'codex-home');
  const cacheRoot = path.join(codexHome, 'plugins', 'cache', 'ape-dev', 'ape');
  const marketplaceRoot = path.join(codexHome, 'dev-plugins', 'ape-dev');
  const marketplaceFile = path.join(marketplaceRoot, '.agents', 'plugins', 'marketplace.json');
  const oldVersion = '2.13.0+codex.zz-old';
  const oldRoot = path.join(cacheRoot, oldVersion);
  const retainedRoot = path.join(marketplaceRoot, 'retained-cache', 'ape');
  const fakeCodex = path.join(root, 'fake-codex.mjs');
  const fakeCodexLog = path.join(root, 'fake-codex.log');

  await mkdir(path.join(pluginRoot, '.codex-plugin'), { recursive: true });
  for (const directory of ['dist', 'hooks', 'lib/runtime', 'prompts', 'skills/run']) {
    await mkdir(path.join(pluginRoot, directory), { recursive: true });
  }
  await mkdir(oldRoot, { recursive: true });
  await mkdir(path.dirname(marketplaceFile), { recursive: true });
  const oldSource = path.join(marketplaceRoot, 'plugins', 'ape');
  await mkdir(path.join(oldSource, '.codex-plugin'), { recursive: true });
  await writeFile(path.join(oldSource, '.codex-plugin', 'plugin.json'), JSON.stringify({ name: 'ape', version: oldVersion }));
  await writeFile(marketplaceFile, JSON.stringify({
    name: 'ape-dev',
    plugins: [{ name: 'ape', source: { source: 'local', path: './plugins/ape' }, policy: { installation: 'AVAILABLE', authentication: 'ON_INSTALL' }, category: 'Engineering' }],
  }));
  await writeFile(path.join(codexHome, 'fake-marketplace.json'), JSON.stringify({ marketplaceRoot, sourceType }));
  await writeFile(path.join(codexHome, 'fake-installed.json'), JSON.stringify({ pluginId: 'ape@ape-dev', version: oldVersion, source: { source: 'local', path: oldSource } }));
  await writeFile(
    path.join(pluginRoot, '.codex-plugin', 'plugin.json'),
    `${JSON.stringify({
      name: 'ape',
      version: oldVersion,
      description: 'fixture plugin',
      mcpServers: './.mcp.json',
    }, null, 2)}\n`,
  );
  await writeFile(
    path.join(pluginRoot, '.mcp.json'),
    `${JSON.stringify({
      mcpServers: {
        ape: {
          command: 'node',
          args: ['./dist/ape-mcp.bundle.mjs', '--host', 'codex'],
          cwd: '.',
        },
      },
    })}\n`,
  );
  if (!omitRuntimeFile) await writeFile(path.join(pluginRoot, 'dist', 'ape-mcp.bundle.mjs'), 'mcp\n');
  await writeFile(path.join(pluginRoot, 'dist', 'ape-hooks.bundle.mjs'), 'hooks\n');
  await writeFile(path.join(pluginRoot, 'dist', 'ape-larp.bundle.mjs'), 'larp\n');
  if (!omitGateRunner) {
    await writeFile(path.join(pluginRoot, 'lib', 'runtime', 'runner.js'), "import './spawn.js';\n");
  }
  await writeFile(path.join(pluginRoot, 'lib', 'runtime', 'spawn.js'), "import './file-stats.js';\nexport const fixture = true;\n");
  if (!omitFileStats) {
    await writeFile(path.join(pluginRoot, 'lib', 'runtime', 'file-stats.js'), 'export const fixture = true;\n');
  }
  await writeFile(path.join(pluginRoot, 'package.json'), '{"name":"ape-fixture","type":"module"}\n');
  await writeFile(path.join(pluginRoot, 'hooks', 'hooks.json'), '{}\n');
  await writeFile(path.join(pluginRoot, 'prompts', 'common.md'), 'common\n');
  await writeFile(path.join(pluginRoot, 'skills', 'run', 'SKILL.md'), '---\nname: run\n---\n');
  await writeFile(path.join(pluginRoot, 'LICENSE'), 'MIT\n');
  await writeFile(path.join(pluginRoot, 'THIRD_PARTY_NOTICES.md'), 'No bundled audio.\n');
  for (const forbidden of ['.git', '.ape', 'agents', 'assets', 'node_modules', '__tests__', 'docs']) {
    await mkdir(path.join(pluginRoot, forbidden), { recursive: true });
    await writeFile(path.join(pluginRoot, forbidden, 'must-not-ship.txt'), 'development only\n');
  }
  await writeFile(path.join(oldRoot, 'old-task-sentinel.txt'), 'still available\n');
  await writeFile(
    fakeCodex,
    `#!/usr/bin/env node
import { appendFileSync, cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
const args = process.argv.slice(2);
if (!statSync(process.env.CODEX_HOME).isDirectory()) process.exit(29);
appendFileSync(process.env.FAKE_CODEX_LOG, JSON.stringify(args) + '\\n');
const descriptorFile = path.join(process.env.CODEX_HOME, 'fake-marketplace.json');
const installedFile = path.join(process.env.CODEX_HOME, 'fake-installed.json');
if (args[0] === 'plugin' && args[1] === 'marketplace' && args[2] === 'list') {
  const descriptor = JSON.parse(readFileSync(descriptorFile));
  const marketplace = JSON.parse(readFileSync(path.join(descriptor.marketplaceRoot, '.agents', 'plugins', 'marketplace.json')));
  console.log(JSON.stringify({ marketplaces: [{ name: marketplace.name, root: descriptor.marketplaceRoot, marketplaceSource: { sourceType: descriptor.sourceType, source: descriptor.marketplaceRoot } }] }));
  process.exit(0);
}
if (args[0] === 'plugin' && args[1] === 'marketplace' && args[2] === 'add') {
  const marketplaceRoot = path.resolve(args[3]);
  const marketplace = JSON.parse(readFileSync(path.join(marketplaceRoot, '.agents', 'plugins', 'marketplace.json')));
  writeFileSync(descriptorFile, JSON.stringify({ marketplaceRoot, sourceType: 'local' }));
  process.exit(0);
}
if (args[0] === 'plugin' && args[1] === 'add') {
  if (process.env.FAKE_CODEX_FAIL === '1') process.exit(17);
  const [pluginName, marketplaceName] = args[2].split('@');
  const descriptor = JSON.parse(readFileSync(descriptorFile));
  const marketplace = JSON.parse(readFileSync(path.join(descriptor.marketplaceRoot, '.agents', 'plugins', 'marketplace.json')));
  if (marketplace.name !== marketplaceName) process.exit(19);
  const entry = marketplace.plugins.find((candidate) => candidate.name === pluginName);
  const pluginRoot = path.resolve(descriptor.marketplaceRoot, entry.source.path);
  const manifest = JSON.parse(readFileSync(path.join(pluginRoot, '.codex-plugin', 'plugin.json')));
  const cache = path.join(process.env.CODEX_HOME, 'plugins', 'cache', marketplaceName, pluginName);
  // Codex 0.153.4 prunes other versions on a supported native install.
  if (existsSync(cache)) for (const version of readdirSync(cache)) rmSync(path.join(cache, version), { recursive: true, force: true });
  if (marketplaceName === 'ape-dev' && process.env.FAKE_CODEX_NATIVE_FAIL === '1') process.exit(31);
  const destination = path.join(cache, manifest.version);
  mkdirSync(destination, { recursive: true });
  cpSync(pluginRoot, destination, { recursive: true });
  writeFileSync(installedFile, JSON.stringify({ pluginId: pluginName + '@' + marketplaceName, version: manifest.version, source: { source: 'local', path: pluginRoot } }));
  process.exit(0);
}
if (args[0] === 'plugin' && args[1] === 'list') {
  const installed = JSON.parse(readFileSync(installedFile));
  const [pluginName, marketplaceName] = installed.pluginId.split('@');
  const cache = path.join(process.env.CODEX_HOME, 'plugins', 'cache', marketplaceName, pluginName);
  // In these fixtures the older metadata sorts later, reproducing the native
  // loader selecting a restored legacy directory instead of the new build.
  installed.version = readdirSync(cache).sort().at(-1);
  const fault = process.env.FAKE_SELECTION_FAULT;
  if (fault === 'version') installed.version = '0.0.0';
  if (fault === 'identity') installed.pluginId = 'other@ape-dev';
  if (fault === 'source') installed.source.path = process.env.CODEX_HOME;
  if (fault === 'source-type') installed.source.source = 'git';
  if (fault === 'missing') { console.log('{}'); process.exit(0); }
  if (fault === 'invalid-json') { console.log('not JSON'); process.exit(0); }
  console.log(JSON.stringify({ installed: [installed] }));
  process.exit(0);
}
process.exit(23);
`,
  );
  await chmod(fakeCodex, 0o755);

  return { cacheRoot, codexHome, fail, nativeFail, fakeCodex, fakeCodexLog, marketplaceFile, marketplaceRoot, oldRoot, oldVersion, pluginRoot, retainedRoot };
}

async function runFixture(context) {
  const args = [
    SCRIPT,
    '--plugin-root',
    context.pluginRoot,
    '--codex-home',
    context.codexHome,
    '--codex-bin',
    context.fakeCodex,
    '--cachebuster',
    context.cachebuster ?? 'retained-test',
    ...(context.preserveOpenTasks ? ['--preserve-open-tasks'] : []),
  ];
  const env = {
    ...process.env,
    CODEX_HOME: context.codexHome,
    FAKE_SELECTION_FAULT: context.selectionFault ?? '',
    FAKE_CODEX_FAIL: context.fail ? '1' : '0',
    FAKE_CODEX_NATIVE_FAIL: context.nativeFail ? '1' : '0',
    FAKE_CODEX_LOG: context.fakeCodexLog,
  };
  return new Promise((resolvePromise, reject) => {
    const child = spawn(process.execPath, args, { env });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    child.once('error', reject);
    child.once('exit', (exitCode, signal) => {
      resolvePromise({ exitCode, signal, stderr, stdout });
    });
  });
}


const pinnedFiles = ['dist/ape-hooks.bundle.mjs', 'lib/runtime/runner.js'];

async function capture(root) {
  return Promise.all(pinnedFiles.map(async (relative) => ({
    relative,
    absolute: path.join(root, relative),
    bytes: await readFile(path.join(root, relative), 'utf8'),
  })));
}

// These are installer orchestration fixtures, not host certification.
// The configured marketplace smoke must supply real pinned-host refresh evidence.
describe('development reinstall exact-path contract (synthetic host)', () => {
  it.each([false, true])('measures original paths separately from archives with preservation=%s', async (preserveOpenTasks) => {
    const context = await fixture();
    const canonical = await readFile(path.join(context.pluginRoot, '.codex-plugin/plugin.json'), 'utf8');
    expect((await runFixture({ ...context, cachebuster: '001-old' })).exitCode).toBe(0);
    const oldVersion = '2.13.0+codex.001-old';
    const oldRoot = path.join(context.cacheRoot, oldVersion);
    const saved = await capture(oldRoot);
    const oldSource = path.join(context.marketplaceRoot, 'versions/ape', oldVersion);
    const oldSourceFiles = await capture(oldSource);
    await writeFile(path.join(context.pluginRoot, pinnedFiles[0]), 'new hooks\n');
    await writeFile(path.join(context.pluginRoot, pinnedFiles[1]), 'new runner\n');
    const result = await runFixture({ ...context, cachebuster: '002-new', preserveOpenTasks });
    expect(result.exitCode, result.stderr).toBe(0);
    expect(result.stdout).toContain('Desktop activation is not verified by this command');
    const nextVersion = '2.13.0+codex.002-new';
    const selected = JSON.parse(await readFile(path.join(context.codexHome, 'fake-installed.json'), 'utf8'));
    const catalog = JSON.parse(await readFile(context.marketplaceFile, 'utf8'));
    const source = path.resolve(context.marketplaceRoot, catalog.plugins[0].source.path);
    expect(selected).toEqual({ pluginId: 'ape@ape-dev', version: nextVersion, source: { source: 'local', path: source } });
    expect(JSON.parse(await readFile(path.join(source, '.codex-plugin/plugin.json'), 'utf8')).version).toBe(nextVersion);
    expect(await readFile(path.join(context.pluginRoot, '.codex-plugin/plugin.json'), 'utf8')).toBe(canonical);
    for (const file of oldSourceFiles) expect(await readFile(file.absolute, 'utf8')).toBe(file.bytes);
    for (const file of saved) {
      expect(path.isAbsolute(file.absolute)).toBe(true);
      expect(await readFile(path.join(context.retainedRoot, oldVersion, file.relative), 'utf8')).toBe(file.bytes);
      if (preserveOpenTasks) expect(await readFile(file.absolute, 'utf8')).toBe(file.bytes);
      else await expect(readFile(file.absolute)).rejects.toMatchObject({ code: 'ENOENT' });
    }
    // An external prune can invalidate restored paths. Keep the saved strings;
    // never replace them with the immutable source, archive or new cache path.
    await rm(oldRoot, { recursive: true, force: true });
    for (const file of saved) {
      await expect(readFile(file.absolute)).rejects.toMatchObject({ code: 'ENOENT' });
      expect(await readFile(path.join(context.retainedRoot, oldVersion, file.relative), 'utf8')).toBe(file.bytes);
    }
    expect(await readFile(path.join(source, pinnedFiles[0]), 'utf8')).toBe('new hooks\n');
    expect(await readFile(path.join(source, pinnedFiles[1]), 'utf8')).toBe('new runner\n');
  });

  it.each(['version', 'identity', 'source', 'source-type', 'missing', 'invalid-json'])(
    'rejects %s selection evidence after native installation',
    async (selectionFault) => {
      const context = await fixture();
      const result = await runFixture({ ...context, selectionFault });
      expect(result.exitCode).toBe(1);
      expect(result.stdout).not.toContain('Verified registered source and selected version');
      expect(result.stdout).not.toContain('Installed development version:');
      expect(result.stderr).toContain(selectionFault === 'invalid-json'
        ? 'Codex returned invalid JSON'
        : 'Codex did not select ape@ape-dev');
      // The failed assertion does not erase recovery copies or mutate canonical bytes.
      expect(await readFile(path.join(context.retainedRoot, context.oldVersion, 'old-task-sentinel.txt'), 'utf8')).toBe('still available\n');
      expect(JSON.parse(await readFile(path.join(context.pluginRoot, '.codex-plugin/plugin.json'), 'utf8')).version).toBe(context.oldVersion);
    },
  );
});
