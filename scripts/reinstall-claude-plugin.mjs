#!/usr/bin/env node
// Install only APE's local development plugin. Publish immutable source versions,
// use Claude's supported commands, and verify the selected package afterwards.
import { cp, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { withDirLock } from '../lib/runtime/lock.js';
import { spawnWithTimeout } from '../lib/runtime/spawn.js';
import { STRICT_SEMVER, assertRegularTree, atomicWrite, exists, promoteInstalledTree, treeDigest } from './dev-plugin-files.mjs';

const REPO_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const PLUGIN_ID = 'ape@ape-dev';
const DIRECTORIES = ['.claude-plugin', 'agents', 'bin', 'dist', 'hooks', 'lib', 'prompts', 'skills'];
const FILES = ['.mcp.json', 'LICENSE', 'THIRD_PARTY_NOTICES.md', 'package.json'];

function parseArgs(argv) {
  const args = {
    pluginRoot: join(REPO_ROOT, 'plugins', 'ape-claude'),
    claudeConfig: process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude'),
    claudeBin: 'claude', projectRoot: process.cwd(), marketplace: 'ape-dev',
    cachebuster: new Date().toISOString().replace(/\D/g, '').slice(0, 14),
  };
  const flags = new Map([
    ['--plugin-root', 'pluginRoot'], ['--claude-config', 'claudeConfig'],
    ['--claude-bin', 'claudeBin'], ['--project-root', 'projectRoot'],
    ['--marketplace', 'marketplace'], ['--cachebuster', 'cachebuster'],
  ]);
  for (let index = 0; index < argv.length; index += 2) {
    const key = flags.get(argv[index]);
    const value = argv[index + 1];
    if (!key || !value || value.startsWith('--')) throw new Error(`invalid installer argument: ${argv[index]}`);
    args[key] = value;
  }
  if (args.marketplace !== 'ape-dev') throw new Error('this installer only updates ape@ape-dev');
  if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(args.cachebuster)) throw new Error('invalid development cachebuster');
  return args;
}

async function cli(args, command, config = args.claudeConfig, isolated = false) {
  const script = /\.m?js$/i.test(args.claudeBin);
  /** @type {NodeJS.ProcessEnv} */
  const env = { ...process.env, CLAUDE_CONFIG_DIR: config };
  if (isolated) env.CLAUDE_CODE_PLUGIN_CACHE_DIR = join(config, 'plugins');
  const result = await spawnWithTimeout(script ? process.execPath : args.claudeBin,
    script ? [args.claudeBin, 'plugin', ...command] : ['plugin', ...command], {
      cwd: args.projectRoot, env, shell: false, supervise: true,
      timeout_ms: 60_000, max_output: 1024 * 1024,
    });
  if (result.exit_code !== 0 || result.timed_out || result.spawn_error || result.signal) {
    throw new Error(`Claude ${command.join(' ')} failed: ${result.timed_out ? 'timed out' : result.combined || result.spawn_error || result.exit_code}`);
  }
  return result.combined;
}

async function inventory(args, command) {
  const result = JSON.parse(await cli(args, [...command, '--json']));
  if (!Array.isArray(result)) throw new Error('Claude returned an invalid plugin inventory');
  return result;
}

async function localInstall(args) {
  const matches = [];
  for (const entry of await inventory(args, ['list'])) {
    if (entry.id !== PLUGIN_ID || entry.scope !== 'local') continue;
    if (typeof entry.projectPath !== 'string') throw new Error('Claude did not identify the local plugin project');
    const project = await realpath(entry.projectPath).catch(error => {
      if (error.code !== 'ENOENT') throw error;
      return null;
    });
    if (project === args.projectRoot) matches.push(entry);
  }
  if (matches.length > 1) throw new Error('ambiguous local ape-dev installation');
  return matches[0] ?? null;
}

async function stage(args, root, version) {
  for (const name of [...DIRECTORIES, ...FILES]) {
    const source = join(args.pluginRoot, name);
    if (await exists(source)) await cp(source, join(root, name), { recursive: true, preserveTimestamps: true });
  }
  const manifestFile = join(root, '.claude-plugin', 'plugin.json');
  const manifest = JSON.parse(await readFile(manifestFile, 'utf8'));
  manifest.version = version;
  await writeFile(manifestFile, `${JSON.stringify(manifest, null, 2)}\n`);
  await assertRegularTree(root);
  for (const file of ['dist/ape-mcp.bundle.mjs', 'dist/ape-hooks.bundle.mjs', 'dist/ape-larp.bundle.mjs',
    'hooks/claude-hooks.json', 'lib/runtime/runner.js', 'lib/runtime/spawn.js', 'lib/runtime/file-stats.js', 'lib/runtime/host-identity.js',
    'skills/run/SKILL.md', 'package.json', 'THIRD_PARTY_NOTICES.md']) {
    if (!(await exists(join(root, file)))) throw new Error(`staged Claude plugin is missing required runtime file: ${file}`);
  }
  const mcp = JSON.parse(await readFile(join(root, '.mcp.json'), 'utf8'))?.mcpServers?.ape;
  if (manifest.hooks !== './hooks/claude-hooks.json' || mcp?.command !== 'node' ||
      JSON.stringify(mcp.args) !== JSON.stringify(['${CLAUDE_PLUGIN_ROOT}/dist/ape-mcp.bundle.mjs', '--host', 'claude'])) {
    throw new Error('staged Claude package must use the local APE hooks and MCP bundle');
  }
}

async function retainCaches(installPath, root) {
  const cacheRoot = dirname(installPath);
  const retained = [];
  for (const entry of await readdir(cacheRoot, { withFileTypes: true })) {
    if (!entry.isDirectory() || !STRICT_SEMVER.test(entry.name)) {
      throw new Error(`unexpected entry in Claude APE cache: ${entry.name}`);
    }
    const pinned = join(cacheRoot, entry.name);
    const manifest = JSON.parse(await readFile(join(pinned, '.claude-plugin', 'plugin.json'), 'utf8'));
    if (manifest.name !== 'ape' || !STRICT_SEMVER.test(manifest.version ?? '')) {
      throw new Error('refusing to retain a non-APE Claude cache');
    }
    // Claude marks superseded versions for eviction. Keep that host bookkeeping
    // out of immutable recovery copies and preserve every open session's path.
    await rm(join(pinned, '.orphaned_at'), { force: true });
    const backup = await promoteInstalledTree(pinned, join(root, 'retained-cache', 'ape'), entry.name);
    retained.push({ pinned, backup: backup.destination });
  }
  return retained;
}

async function install(args, staged, version) {
  const root = join(args.claudeConfig, 'dev-plugins', 'ape-dev');
  const marketplaces = (await inventory(args, ['marketplace', 'list'])).filter(entry => entry.name === 'ape-dev');
  if (marketplaces.length > 1) throw new Error('ambiguous ape-dev marketplace');
  const registered = marketplaces[0];
  if (registered && (registered.source !== 'directory' ||
      typeof registered.path !== 'string' || await realpath(registered.path) !== await realpath(root))) {
    throw new Error('refusing to replace an unrelated ape-dev marketplace');
  }
  const file = join(root, '.claude-plugin', 'marketplace.json');
  const previous = await readFile(file, 'utf8').catch(error => {
    if (error.code !== 'ENOENT') throw error;
    return null;
  });
  const catalog = previous === null
    ? { name: 'ape-dev', owner: { name: 'AAWWCC' }, plugins: [] }
    : JSON.parse(previous);
  if (catalog.name !== 'ape-dev' || !Array.isArray(catalog.plugins) ||
      catalog.plugins.some(entry => entry.name !== 'ape') || catalog.plugins.length > 1) {
    throw new Error('ape-dev must be a dedicated APE development marketplace');
  }
  const published = await promoteInstalledTree(staged, join(root, 'versions', 'ape'), version);
  const old = await localInstall(args);
  let retained = [];
  if (old) {
    if (!STRICT_SEMVER.test(old.version ?? '') || typeof old.installPath !== 'string') {
      throw new Error('invalid existing Claude development installation');
    }
    retained = await retainCaches(old.installPath, root);
  }
  catalog.plugins = [{ name: 'ape', source: `./versions/ape/${version}` }];
  await atomicWrite(file, `${JSON.stringify(catalog, null, 2)}\n`);
  try {
    await cli(args, registered ? ['marketplace', 'update', 'ape-dev'] : ['marketplace', 'add', root, '--scope', 'user']);
    await cli(args, [old ? 'update' : 'install', PLUGIN_ID, '--scope', 'local']);
    const selected = await localInstall(args);
    if (selected?.version !== version || typeof selected.installPath !== 'string' ||
        await treeDigest(selected.installPath) !== await treeDigest(published.destination)) {
      throw new Error('Claude did not select the expected ape-dev version and package bytes');
    }
  } catch (error) {
    if (previous === null) await rm(file, { force: true });
    else await atomicWrite(file, previous);
    throw error;
  } finally {
    for (const { pinned, backup } of retained) {
      await rm(join(pinned, '.orphaned_at'), { force: true });
      await promoteInstalledTree(backup, dirname(pinned), basename(pinned));
    }
  }
  process.stdout.write(`Verified local Claude installation: ${PLUGIN_ID} ${version}\n`);
}

async function main(argv) {
  const args = parseArgs(argv);
  args.pluginRoot = resolve(args.pluginRoot);
  args.claudeConfig = resolve(args.claudeConfig);
  args.projectRoot = await realpath(args.projectRoot);
  const manifest = JSON.parse(await readFile(join(args.pluginRoot, '.claude-plugin', 'plugin.json'), 'utf8'));
  if (manifest.name !== 'ape' || !STRICT_SEMVER.test(manifest.version ?? '')) {
    throw new Error('this installer requires the generated APE Claude package');
  }
  const version = `${manifest.version.split('+', 1)[0]}+claude.${args.cachebuster}`;
  const scratch = await mkdtemp(join(tmpdir(), 'ape-claude-stage-'));
  try {
    const staged = join(scratch, 'plugin');
    const config = join(scratch, 'claude-config');
    await mkdir(staged);
    await mkdir(config);
    await stage(args, staged, version);
    await cli(args, ['validate', staged, '--strict'], config, true);
    const lock = join(args.claudeConfig, 'dev-plugins', '.ape-reinstall-ape-dev.lock');
    await withDirLock(lock, () => install(args, staged, version), {
      staleMs: 30_000, heartbeatMs: 1_000, busyMs: 1_000, requireProcessIdentity: true,
      busyMessage: 'another Claude ape-dev installation is running; retry after it finishes',
    });
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
  process.stdout.write('Open a new Claude session to load the updated runtime; installation does not verify activation in an existing session.\n');
}

main(process.argv.slice(2)).catch(error => {
  process.stderr.write(`reinstall-claude-plugin: ${error?.message ?? String(error)}\n`);
  process.exitCode = 1;
});
