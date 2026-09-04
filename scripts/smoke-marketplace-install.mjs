#!/usr/bin/env node

import { spawn } from 'node:child_process';
import { access, mkdir, mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
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

async function exists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

function command(program, args, options = {}) {
  const { timeoutMs = COMMAND_TIMEOUT_MS, ...spawnOptions } = options;
  return new Promise((resolvePromise, reject) => {
    const child = spawn(program, args, {
      ...spawnOptions,
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`${program} ${args.join(' ')} timed out`));
    }, timeoutMs);
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.once('error', reject);
    child.once('close', (code, signal) => {
      clearTimeout(timer);
      if (signal) reject(new Error(`${program} terminated by ${signal}`));
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

function requestedOptions(argv) {
  let mode = 'blocking';
  let hosts = new Set(Object.keys(compatibility.hosts));
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === '--edge') {
      mode = 'edge';
      continue;
    }
    if (token === '--host' && compatibility.hosts[argv[index + 1]]) {
      hosts = new Set([argv[index + 1]]);
      index += 1;
      continue;
    }
    throw new Error('usage: node scripts/smoke-marketplace-install.mjs [--host codex|claude] [--edge]');
  }
  return { hosts, mode };
}

async function assertHostVersion(identity, mode, modulesRoot) {
  const host = compatibility.hosts[identity];
  const result = await hostCommand(identity, ['--version'], { cwd: REPO_ROOT, env: process.env }, modulesRoot);
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
  const { hosts, mode } = requestedOptions(argv);
  const scratch = await mkdtemp(join(tmpdir(), 'ape-clean-marketplace-'));
  const toolsRoot = join(scratch, 'host-tools');
  const codexHome = join(scratch, 'codex-home');
  const claudeConfig = join(scratch, 'claude-config');
  await mkdir(codexHome, { recursive: true, mode: 0o700 });
  await mkdir(claudeConfig, { recursive: true, mode: 0o700 });
  try {
    let modulesRoot;
    if (mode !== 'edge') {
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
      const rootResult = await npmCommand(['root', '--global'], { cwd: scratch, env: process.env });
      modulesRoot = rootResult.stdout.trim();
      if (!isAbsolute(modulesRoot)) throw new Error('npm root --global did not return an absolute path');
    }
    if (hosts.has('codex')) {
      await assertHostVersion('codex', mode, modulesRoot);
      const codexEnv = { ...process.env, CODEX_HOME: codexHome };
      await hostCommand('codex', ['plugin', 'marketplace', 'add', REPO_ROOT, '--json'], { cwd: scratch, env: codexEnv }, modulesRoot);
      await hostCommand('codex', ['plugin', 'add', 'ape@ape', '--json'], { cwd: scratch, env: codexEnv }, modulesRoot);
      const codexPackage = await findPackage(codexHome, '.codex-plugin');
      await assertNoAssets(codexPackage);
      await initializeInstalled('codex', codexPackage);
      process.stdout.write('Codex clean marketplace install and local stdio MCP initialization passed\n');
    }

    if (hosts.has('claude')) {
      await assertHostVersion('claude', mode, modulesRoot);
      const claudeEnv = { ...process.env, CLAUDE_CONFIG_DIR: claudeConfig };
      await hostCommand('claude', ['plugin', 'marketplace', 'add', REPO_ROOT, '--scope', 'user'], { cwd: scratch, env: claudeEnv }, modulesRoot);
      await hostCommand('claude', ['plugin', 'install', 'ape@ape', '--scope', 'user'], { cwd: scratch, env: claudeEnv }, modulesRoot);
      const claudePackage = await findPackage(claudeConfig, '.claude-plugin');
      await assertNoAssets(claudePackage);
      await initializeInstalled('claude', claudePackage);
      process.stdout.write('Claude clean marketplace install and local stdio MCP initialization passed\n');
    }
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

main().catch((error) => {
  process.stderr.write(`smoke-marketplace-install: ${error?.message ?? String(error)}\n`);
  process.exitCode = 1;
});
