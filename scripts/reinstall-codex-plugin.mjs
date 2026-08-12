#!/usr/bin/env node
/**
 * Reinstall a lean local Codex plugin without invalidating open tasks.
 *
 * The public repository marketplace points at the generated Codex package.
 * This wrapper applies a cache-only build-metadata suffix without mutating the
 * canonical package manifest. It stages that allowlisted package in a temporary marketplace, lets the
 * supported Codex installer validate and install it under an isolated
 * temporary CODEX_HOME, then atomically promotes that exact installed tree to
 * the real personal cache. Existing immutable cache versions are never moved
 * or deleted, so already-open tasks retain their pinned paths.
 */

import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  access,
  cp,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const DEFAULT_PLUGIN_ROOT = join(dirname(SCRIPT_DIR), 'plugins', 'ape');
const SAFE_SEGMENT = /^[a-z0-9][a-z0-9._-]*$/i;
const STRICT_SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-(?:[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

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
// process. Keep that small ESM closure in the lean cache too: runner.js imports
// only spawn.js, and package.json supplies the `type: module` boundary Node
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
  'package.json',
  'prompts/common.md',
  'skills/run/SKILL.md',
  'THIRD_PARTY_NOTICES.md',
]);

class UsageError extends Error {}

function usage() {
  return (
    'usage: node scripts/reinstall-codex-plugin.mjs ' +
    '[--plugin-root <path>] [--marketplace <name>] [--cachebuster <token>] ' +
    '[--codex-home <path>] [--codex-bin <path>]\n'
  );
}

function parseArgs(argv) {
  const values = {
    pluginRoot: DEFAULT_PLUGIN_ROOT,
    marketplace: 'ape',
    cachebuster: defaultCachebuster(),
    codexHome: process.env.CODEX_HOME || join(homedir(), '.codex'),
    codexBin: 'codex',
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

async function exists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function assertRegularTree(root) {
  const entries = await readdir(root, { withFileTypes: true });
  for (const entry of entries) {
    const target = join(root, entry.name);
    const metadata = await lstat(target);
    if (metadata.isSymbolicLink()) {
      throw new UsageError(`staged plugin refuses symbolic link: ${target}`);
    }
    if (metadata.isDirectory()) await assertRegularTree(target);
    else if (!metadata.isFile()) throw new UsageError(`staged plugin refuses special file: ${target}`);
  }
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

function runCodex(codexBin, args, cwd, codexHome) {
  return new Promise((resolvePromise, reject) => {
    const isScript = /\.m?js$/i.test(codexBin);
    const cmd = isScript ? process.execPath : codexBin;
    const commandArgs = isScript ? [codexBin, ...args] : args;
    const child = spawn(cmd, commandArgs, {
      cwd,
      env: { ...process.env, CODEX_HOME: codexHome },
      stdio: 'inherit',
    });
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      if (signal) reject(new Error(`${cmd} terminated by signal ${signal}`));
      else if (code !== 0) reject(new Error(`${cmd} ${args.join(' ')} exited with code ${code}`));
      else resolvePromise();
    });
  });
}

async function treeDigest(root) {
  const hash = createHash('sha256');
  async function visit(directory) {
    const entries = (await readdir(directory, { withFileTypes: true }))
      .sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0);
    for (const entry of entries) {
      const target = join(directory, entry.name);
      const normalized = relative(root, target).split(sep).join('/');
      const metadata = await lstat(target);
      if (metadata.isSymbolicLink()) throw new UsageError(`installed plugin contains symbolic link: ${target}`);
      if (metadata.isDirectory()) {
        hash.update(`d\0${normalized}\0`);
        await visit(target);
      } else if (metadata.isFile()) {
        hash.update(`f\0${normalized}\0`);
        hash.update(await readFile(target));
      } else {
        throw new UsageError(`installed plugin contains special file: ${target}`);
      }
    }
  }
  await visit(root);
  return hash.digest('hex');
}

async function promoteInstalledTree(installedRoot, cacheRoot, nextVersion) {
  await mkdir(cacheRoot, { recursive: true });
  const destination = join(cacheRoot, nextVersion);
  if (await exists(destination)) {
    const [installedDigest, destinationDigest] = await Promise.all([
      treeDigest(installedRoot),
      treeDigest(destination),
    ]);
    if (installedDigest !== destinationDigest) {
      throw new UsageError(`cache version ${nextVersion} already exists with different content; use a new cachebuster`);
    }
    return { destination, reused: true };
  }
  const transactionRoot = await mkdtemp(join(cacheRoot, '.ape-install-'));
  const prepared = join(transactionRoot, 'plugin');
  try {
    await cp(installedRoot, prepared, { recursive: true, preserveTimestamps: true });
    if (await treeDigest(prepared) !== await treeDigest(installedRoot)) {
      throw new Error('prepared cache tree failed content verification');
    }
    try {
      await rename(prepared, destination);
      return { destination, reused: false };
    } catch (error) {
      if (!['EEXIST', 'ENOTEMPTY'].includes(error?.code) || !(await exists(destination))) throw error;
      const [preparedDigest, destinationDigest] = await Promise.all([
        treeDigest(prepared),
        treeDigest(destination),
      ]);
      if (preparedDigest !== destinationDigest) {
        throw new UsageError(`cache version ${nextVersion} was concurrently installed with different content; use a new cachebuster`);
      }
      return { destination, reused: true };
    }
  } finally {
    await rm(transactionRoot, { recursive: true, force: true });
  }
}

async function main(argv) {
  const args = parseArgs(argv);
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

  try {
    // Codex validates CODEX_HOME before it evaluates a plugin subcommand. The
    // isolated home therefore has to exist before the first marketplace call;
    // asking the CLI to create its own missing configuration root fails early.
    await mkdir(temporaryCodexHome, { recursive: true, mode: 0o700 });
    await stagePlugin(pluginRoot, stagedPluginRoot, manifest, nextVersion);
    await createStagingMarketplace(marketplaceRoot, stagingMarketplace, pluginName);
    await runCodex(args.codexBin, ['plugin', 'marketplace', 'add', marketplaceRoot, '--json'], temporaryRoot, temporaryCodexHome);
    await runCodex(args.codexBin, ['plugin', 'add', `${pluginName}@${stagingMarketplace}`, '--json'], temporaryRoot, temporaryCodexHome);
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
    const promoted = await promoteInstalledTree(installedRoot, cacheRoot, nextVersion);
    const fileCount = await countFiles(promoted.destination);
    process.stdout.write(
      `${promoted.reused ? 'Reused' : 'Installed'} lean cache ${nextVersion}: ${fileCount} files.\n`,
    );
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }

  process.stdout.write(`Installed cache version: ${nextVersion} (source remains ${version})\n`);
  process.stdout.write(
    `New Codex tasks use ${nextVersion}; existing cache versions remain available to open tasks.\n`,
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
