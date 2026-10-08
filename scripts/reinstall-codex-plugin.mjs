#!/usr/bin/env node
/**
 * Reinstall a lean local Codex development plugin with recoverable old snapshots.
 *
 * The public repository marketplace points at the generated Codex package.
 * Validate an allowlisted package in an isolated home, publish an immutable
 * version in a dedicated local marketplace, then install from that source.
 * Source and selected versions must agree so a host refresh cannot undo the
 * development installation. The canonical package manifest stays unchanged.
 * Codex prunes older caches during installation; archive them outside its active
 * cache so discovery cannot select an older build again. Run while workers are idle.
 * Existing chats can lose their pinned cache paths. This does not hot-reload
 * a running desktop app; verify activation separately in a fresh task.
 */

import { spawn } from 'node:child_process';
import {
  cp,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  writeFile,
} from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { withDirLock } from '../lib/runtime/lock.js';
import { resolveCodexInvocation } from './marketplace-host-invocation.mjs';
import { DevPluginError as UsageError, STRICT_SEMVER, exists, assertRegularTree, atomicWrite, promoteInstalledTree } from './dev-plugin-files.mjs';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const DEFAULT_PLUGIN_ROOT = join(dirname(SCRIPT_DIR), 'plugins', 'ape');
const SAFE_SEGMENT = /^[a-z0-9][a-z0-9._-]*$/i;

// Deliberately top-level and closed. These are the Codex plugin's complete
// shipped runtime surfaces; development state and documentation cannot enter
// the cache merely because a new directory appeared in the checkout.
const STAGED_DIRECTORIES = Object.freeze([
  '.codex-plugin',
  'dist',
  'hooks',
  'lib',
  'prompts',
  'skills',
]);
// The MCP bundle launches the detached merge-gate runner as a sibling runtime
// process. Keep its small ESM closure in the lean cache too: runner.js uses
// spawn.js and its file-stats.js leaf. package.json supplies the `type: module` boundary Node
// needs when the files are executed from an immutable plugin snapshot.
const STAGED_FILES = Object.freeze([
  '.mcp.json',
  'LICENSE',
  'THIRD_PARTY_NOTICES.md',
  'package.json',
]);
const REQUIRED_RUNTIME_FILES = Object.freeze([
  '.codex-plugin/plugin.json',
  '.mcp.json',
  'dist/ape-hooks.bundle.mjs',
  'dist/ape-larp.bundle.mjs',
  'dist/ape-mcp.bundle.mjs',
  'hooks/hooks.json',
  'lib/runtime/runner.js',
  'lib/runtime/spawn.js',
  'lib/runtime/file-stats.js', 'lib/runtime/host-identity.js',
  'package.json',
  'prompts/common.md',
  'skills/run/SKILL.md',
  'THIRD_PARTY_NOTICES.md',
]);

function usage() {
  return (
    'usage: node scripts/reinstall-codex-plugin.mjs ' +
    '[--plugin-root <path>] [--marketplace <name>] [--cachebuster <token>] ' +
    '[--codex-home <path>] [--codex-bin <path>] [--preserve-open-tasks]\n'
  );
}

function parseArgs(argv) {
  const values = {
    pluginRoot: DEFAULT_PLUGIN_ROOT,
    marketplace: 'ape-dev',
    cachebuster: defaultCachebuster(),
    codexHome: process.env.CODEX_HOME || join(homedir(), '.codex'),
    codexBin: undefined,
    preserveOpenTasks: false,
  };
  const flags = new Map([
    ['--plugin-root', 'pluginRoot'],
    ['--marketplace', 'marketplace'],
    ['--cachebuster', 'cachebuster'],
    ['--codex-home', 'codexHome'],
    ['--codex-bin', 'codexBin'],
  ]);

  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === '--preserve-open-tasks') {
      values.preserveOpenTasks = true;
      continue;
    }
    const key = flags.get(flag);
    if (!key) throw new UsageError(`unknown argument: ${flag}`);
    const value = argv[index + 1];
    if (!value || value.startsWith('--')) throw new UsageError(`${flag} requires a value`);
    values[key] = value;
    index += 1;
  }
  return values;
}

function defaultCachebuster() {
  return new Date().toISOString().replace(/[-:T.Z]/g, '').slice(0, 14);
}

function sanitizeCachebuster(value) {
  const sanitized = String(value)
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^-|-$/g, '');
  if (!sanitized) throw new UsageError('cachebuster must contain at least one letter or digit');
  if (sanitized.length > 64) throw new UsageError('cachebuster must be at most 64 characters');
  return sanitized;
}

function withCachebuster(version, cachebuster) {
  return `${version.split('+', 1)[0]}+codex.${cachebuster}`;
}

async function stagePlugin(pluginRoot, stagedPluginRoot, manifest, nextVersion) {
  await mkdir(stagedPluginRoot, { recursive: true });
  for (const directory of STAGED_DIRECTORIES) {
    const source = join(pluginRoot, directory);
    if (!(await exists(source))) throw new UsageError(`required plugin directory is missing: ${source}`);
    await cp(source, join(stagedPluginRoot, directory), {
      recursive: true,
      preserveTimestamps: true,
    });
  }
  for (const file of STAGED_FILES) {
    const source = join(pluginRoot, file);
    if (await exists(source)) {
      const destination = join(stagedPluginRoot, file);
      await mkdir(dirname(destination), { recursive: true });
      await cp(source, destination, { preserveTimestamps: true });
    }
  }
  const stagedManifest = { ...manifest, version: nextVersion };
  await writeFile(
    join(stagedPluginRoot, '.codex-plugin', 'plugin.json'),
    `${JSON.stringify(stagedManifest, null, 2)}\n`,
    'utf8',
  );
  await validateStagedPlugin(stagedPluginRoot, stagedManifest);
}

async function validateStagedPlugin(stagedPluginRoot, manifest) {
  if (!SAFE_SEGMENT.test(manifest?.name ?? '')) {
    throw new UsageError('plugin manifest must contain a filesystem-safe string name');
  }
  if (typeof manifest?.description !== 'string' || !manifest.description.trim()) {
    throw new UsageError('plugin manifest must contain a non-empty description');
  }
  if (!STRICT_SEMVER.test(manifest?.version ?? '')) {
    throw new UsageError('plugin manifest version must be strict semver');
  }
  if (JSON.stringify(manifest).includes('[TODO:')) {
    throw new UsageError('plugin manifest contains a [TODO: ...] placeholder');
  }
  for (const file of REQUIRED_RUNTIME_FILES) {
    if (!(await exists(join(stagedPluginRoot, ...file.split('/'))))) {
      throw new UsageError(`staged plugin is missing required runtime file: ${file}`);
    }
  }
  const hooks = JSON.parse(await readFile(join(stagedPluginRoot, 'hooks', 'hooks.json'), 'utf8'));
  if (hooks === null || typeof hooks !== 'object' || Array.isArray(hooks)) {
    throw new UsageError('hooks/hooks.json must contain a JSON object');
  }
  if (manifest.mcpServers !== './.mcp.json') {
    throw new UsageError('plugin manifest must reference the package-local .mcp.json companion');
  }
  const mcpConfig = JSON.parse(await readFile(join(stagedPluginRoot, '.mcp.json'), 'utf8'));
  const mcp = mcpConfig?.mcpServers?.ape;
  if (
    mcp?.command !== 'node' ||
    !Array.isArray(mcp.args) ||
    mcp.args[0] !== './dist/ape-mcp.bundle.mjs' ||
    mcp.args[1] !== '--host' ||
    mcp.args[2] !== 'codex' ||
    mcp.cwd !== '.'
  ) {
    throw new UsageError('package .mcp.json must launch the local Codex APE bundle with node');
  }
  await assertRegularTree(stagedPluginRoot);
}

async function createStagingMarketplace(root, marketplaceName, pluginName) {
  const marketplaceFile = join(root, '.agents', 'plugins', 'marketplace.json');
  await mkdir(dirname(marketplaceFile), { recursive: true });
  await writeFile(
    marketplaceFile,
    `${JSON.stringify({
      name: marketplaceName,
      interface: { displayName: 'APE staging' },
      plugins: [{
        name: pluginName,
        source: { source: 'local', path: `./plugins/${pluginName}` },
        policy: { installation: 'AVAILABLE', authentication: 'ON_INSTALL' },
        category: 'Engineering',
      }],
    }, null, 2)}\n`,
    'utf8',
  );
}

function runCodex(invocation, args, cwd, codexHome, capture = false) {
  return new Promise((resolvePromise, reject) => {
    const cmd = invocation.command;
    const commandArgs = [...invocation.args, ...args];
    const child = spawn(cmd, commandArgs, {
      shell: false,
      cwd,
      env: { ...process.env, CODEX_HOME: codexHome },
      stdio: ['ignore', capture ? 'pipe' : 'inherit', 'inherit'],
    });
    let output = '';
    let oversized = false;
    if (capture) {
      child.stdout.setEncoding('utf8');
      child.stdout.on('data', (chunk) => {
        if (oversized) return;
        output += chunk;
        if (Buffer.byteLength(output) > 1024 * 1024) {
          oversized = true;
          output = '';
          child.kill();
        }
      });
    }
    child.once('error', error => reject(new Error(
      `Cannot launch Codex executable ${cmd}: ${error.message}. Check its path and permissions or PATH; use --codex-bin with a native executable or JavaScript entrypoint.`,
    )));
    child.once('exit', (code, signal) => {
      if (oversized) reject(new Error('Codex JSON output exceeds 1 MiB'));
      else if (signal) reject(new Error(`${cmd} terminated by signal ${signal}`));
      else if (code !== 0) reject(new Error(`${cmd} ${args.join(' ')} exited with code ${code}`));
      else resolvePromise(output);
    });
  });
}

async function codexJson(invocation, args, cwd, codexHome) {
  const output = await runCodex(invocation, [...args, '--json'], cwd, codexHome, true);
  try {
    return JSON.parse(output);
  } catch {
    throw new Error(`Codex returned invalid JSON for ${args.join(' ')}`);
  }
}

async function prepareDevelopmentMarketplace(args, codexHome, cwd, pluginName, nextVersion) {
  const root = join(codexHome, 'dev-plugins', args.marketplace);
  const listed = await codexJson(args.codexInvocation, ['plugin', 'marketplace', 'list'], cwd, codexHome);
  if (!Array.isArray(listed.marketplaces)) throw new Error('Codex returned no marketplace inventory');
  const matches = listed.marketplaces.filter((entry) => entry.name === args.marketplace);
  if (matches.length > 1) throw new UsageError(`ambiguous marketplace: ${args.marketplace}`);
  const existing = matches[0];
  if (existing) {
    const actual = await realpath(existing.root);
    const expected = await realpath(root).catch((error) => {
      if (error.code !== 'ENOENT') throw error;
      return null;
    });
    if (existing.marketplaceSource?.sourceType !== 'local' || actual !== expected) {
      throw new UsageError(`refusing to replace marketplace ${args.marketplace}; use a dedicated local development marketplace at ${root}`);
    }
  }
  const file = join(root, '.agents', 'plugins', 'marketplace.json');
  const previous = await readFile(file, 'utf8').catch((error) => {
    if (error.code !== 'ENOENT') throw error;
    return null;
  });
  const catalog = previous === null ? {
    name: args.marketplace,
    interface: { displayName: 'APE Local Development' },
    plugins: [],
  } : JSON.parse(previous);
  if (catalog.name !== args.marketplace || !Array.isArray(catalog.plugins)) {
    throw new UsageError(`invalid development marketplace: ${file}`);
  }
  const entries = catalog.plugins.filter((entry) => entry.name === pluginName);
  if (entries.length > 1) throw new UsageError(`duplicate plugin in development marketplace: ${pluginName}`);
  const entry = entries[0] ?? {
    name: pluginName,
    policy: { installation: 'AVAILABLE', authentication: 'ON_INSTALL' },
    category: 'Engineering',
  };
  const updated = { ...entry, source: { source: 'local', path: `./versions/${pluginName}/${nextVersion}` } };
  catalog.plugins = entries.length
    ? catalog.plugins.map((candidate) => candidate.name === pluginName ? updated : candidate)
    : [...catalog.plugins, updated];
  return { root, file, previous, contents: `${JSON.stringify(catalog, null, 2)}\n` };
}

async function retainCache(cacheRoot, backupRoot) {
  const entries = await readdir(cacheRoot, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith('.')) {
      throw new UsageError(`unexpected entry in plugin cache: ${entry.name}`);
    }
    await promoteInstalledTree(join(cacheRoot, entry.name), backupRoot, entry.name);
  }
  return entries.map((entry) => entry.name);
}

async function installDevelopmentSource(args, codexHome, cwd, marketplace, cacheRoot, pluginName, nextVersion) {
  const backupRoot = join(marketplace.root, 'retained-cache', pluginName);
  const versions = await retainCache(cacheRoot, backupRoot);
  await atomicWrite(marketplace.file, marketplace.contents);
  let installError = null;
  try {
    await runCodex(args.codexInvocation, ['plugin', 'marketplace', 'add', marketplace.root, '--json'], cwd, codexHome);
    await runCodex(args.codexInvocation, ['plugin', 'add', `${pluginName}@${args.marketplace}`, '--json'], cwd, codexHome);
  } catch (error) {
    installError = error;
  }
  if (installError) {
    if (marketplace.previous === null) await rm(marketplace.file);
    else await atomicWrite(marketplace.file, marketplace.previous);
    // Recover failed installations without overwriting concurrent edits. On
    // success, restoring old cache directories would make Codex select them
    // again when their version sorts ahead of the new build metadata.
    try {
      for (const version of versions) {
        await promoteInstalledTree(join(backupRoot, version), cacheRoot, version);
      }
    } catch (error) {
      throw new Error(`could not restore caches after installation failure; recovery copies remain at ${backupRoot}: ${error.message}`);
    }
    throw installError;
  }
  if (args.preserveOpenTasks) {
    for (const version of versions) {
      await promoteInstalledTree(join(backupRoot, version), cacheRoot, version);
    }
  }
  const listed = await codexJson(args.codexInvocation, ['plugin', 'list', '--marketplace', args.marketplace], cwd, codexHome);
  const selected = listed.installed?.find((entry) => entry.pluginId === `${pluginName}@${args.marketplace}`);
  const source = join(marketplace.root, 'versions', pluginName, nextVersion);
  if (selected?.version !== nextVersion || selected.source?.source !== 'local' ||
      typeof selected.source.path !== 'string' || await realpath(selected.source.path) !== await realpath(source)) {
    throw new Error(`Codex did not select ${pluginName}@${args.marketplace} version ${nextVersion}; desktop activation is unverified`);
  }
  process.stdout.write(`Verified registered source and selected version: ${pluginName}@${args.marketplace} ${nextVersion}\n`);
  process.stdout.write(`Recovery copies of previous cache versions: ${backupRoot}\n`);
}

async function main(argv) {
  const args = parseArgs(argv);
  args.codexInvocation = await resolveCodexInvocation({ codexBin: args.codexBin });
  const pluginRoot = resolve(args.pluginRoot);
  const codexHome = resolve(args.codexHome);
  const manifestPath = join(pluginRoot, '.codex-plugin', 'plugin.json');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  const pluginName = manifest?.name;
  const version = manifest?.version;

  if (!SAFE_SEGMENT.test(pluginName ?? '')) {
    throw new UsageError(`${manifestPath} must contain a filesystem-safe string name`);
  }
  if (!SAFE_SEGMENT.test(args.marketplace)) {
    throw new UsageError(`invalid marketplace name: ${args.marketplace}`);
  }
  if (typeof version !== 'string' || !STRICT_SEMVER.test(version)) {
    throw new UsageError(`${manifestPath} must contain a strict semver version`);
  }

  const cachebuster = sanitizeCachebuster(args.cachebuster);
  const nextVersion = withCachebuster(version, cachebuster);
  const temporaryRoot = await mkdtemp(join(tmpdir(), `${pluginName}-codex-stage-`));
  const stagingMarketplace = `${pluginName}-stage-${process.pid}-${cachebuster}`.slice(0, 120);
  const marketplaceRoot = join(temporaryRoot, 'marketplace');
  const stagedPluginRoot = join(marketplaceRoot, 'plugins', pluginName);
  const temporaryCodexHome = join(temporaryRoot, 'codex-home');
  const cacheRoot = join(codexHome, 'plugins', 'cache', args.marketplace, pluginName);
  const lock = join(codexHome, 'dev-plugins', `.ape-reinstall-${args.marketplace}.lock`);

  try {
    // Codex validates CODEX_HOME before it evaluates a plugin subcommand. The
    // isolated home therefore has to exist before the first marketplace call;
    // asking the CLI to create its own missing configuration root fails early.
    await mkdir(temporaryCodexHome, { recursive: true, mode: 0o700 });
    await stagePlugin(pluginRoot, stagedPluginRoot, manifest, nextVersion);
    await createStagingMarketplace(marketplaceRoot, stagingMarketplace, pluginName);
    await runCodex(args.codexInvocation, ['plugin', 'marketplace', 'add', marketplaceRoot, '--json'], temporaryRoot, temporaryCodexHome);
    await runCodex(args.codexInvocation, ['plugin', 'add', `${pluginName}@${stagingMarketplace}`, '--json'], temporaryRoot, temporaryCodexHome);
    const installedRoot = join(
      temporaryCodexHome,
      'plugins',
      'cache',
      stagingMarketplace,
      pluginName,
      nextVersion,
    );
    if (!(await exists(installedRoot))) {
      throw new Error(`Codex reported success but installed cache is missing: ${installedRoot}`);
    }
    const installedManifest = JSON.parse(
      await readFile(join(installedRoot, '.codex-plugin', 'plugin.json'), 'utf8'),
    );
    if (installedManifest.name !== pluginName || installedManifest.version !== nextVersion) {
      throw new Error('Codex installed a manifest whose name or version differs from staging');
    }
    await validateStagedPlugin(installedRoot, installedManifest);
    await withDirLock(lock, async () => {
      const marketplace = await prepareDevelopmentMarketplace(args, codexHome, temporaryRoot, pluginName, nextVersion);
      if (args.preserveOpenTasks) {
        const versions = await readdir(cacheRoot).catch(error => {
          if (error.code !== 'ENOENT') throw error;
          return [];
        });
        if (versions.some(version => version > nextVersion && !version.startsWith('.'))) {
          throw new UsageError('preserving open tasks requires a development version newer than all retained cache versions');
        }
      }
      await promoteInstalledTree(installedRoot, join(marketplace.root, 'versions', pluginName), nextVersion);
      const promoted = await promoteInstalledTree(installedRoot, cacheRoot, nextVersion);
      await installDevelopmentSource(args, codexHome, temporaryRoot, marketplace, cacheRoot, pluginName, nextVersion);
      const fileCount = await countFiles(promoted.destination);
      process.stdout.write(
        `${promoted.reused ? 'Reused' : 'Installed'} lean cache ${nextVersion}: ${fileCount} files.\n`,
      );
    }, {
      staleMs: 30_000, heartbeatMs: 1_000, busyMs: 1_000,
      requireProcessIdentity: true,
      busyMessage: `another reinstall holds ${lock}; retry after it finishes`,
    });
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }

  process.stdout.write(`Installed development version: ${nextVersion} (canonical package remains ${version})\n`);
  process.stdout.write(
    args.preserveOpenTasks
      ? 'Previous pinned cache paths were restored and the new selected version was verified.\n'
      : 'Previous versions are archived outside the active cache. Open tasks can lose their pinned paths; a host refresh does not restore those paths; do not reinstall while workers are active.\n',
  );
  process.stdout.write(
    `Desktop activation is not verified by this command. A running app may retain its previous plugin snapshot; verify that a fresh task loads ${nextVersion} before starting an APE run.\n`,
  );
}

async function countFiles(root) {
  let count = 0;
  for (const entry of await readdir(root, { withFileTypes: true })) {
    if (entry.isDirectory()) count += await countFiles(join(root, entry.name));
    else if (entry.isFile()) count += 1;
  }
  return count;
}

main(process.argv.slice(2)).catch((error) => {
  if (error instanceof UsageError) process.stderr.write(usage());
  process.stderr.write(`reinstall-codex-plugin: ${error?.message ?? String(error)}\n`);
  process.exitCode = 1;
});
