#!/usr/bin/env node

import { spawn } from 'node:child_process';
import { access, mkdir, mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

async function exists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

function command(program, args, options) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(program, args, { ...options, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`${program} ${args.join(' ')} timed out`));
    }, 60_000);
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
            if (manifest.name === 'ape' && manifest.version === '2.17.3') {
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
  if (response?.result?.serverInfo?.version !== '2.17.3') {
    throw new Error(`${host} installed MCP returned the wrong server version`);
  }
}

function requestedHosts(argv) {
  if (argv.length === 0) return new Set(['codex', 'claude']);
  if (argv.length !== 2 || argv[0] !== '--host' || !['codex', 'claude'].includes(argv[1])) {
    throw new Error('usage: node scripts/smoke-marketplace-install.mjs [--host codex|claude]');
  }
  return new Set([argv[1]]);
}

async function main(argv = process.argv.slice(2)) {
  const hosts = requestedHosts(argv);
  const scratch = await mkdtemp(join(tmpdir(), 'ape-clean-marketplace-'));
  const codexHome = join(scratch, 'codex-home');
  const claudeConfig = join(scratch, 'claude-config');
  await mkdir(codexHome, { recursive: true, mode: 0o700 });
  await mkdir(claudeConfig, { recursive: true, mode: 0o700 });
  try {
    if (hosts.has('codex')) {
      const codexEnv = { ...process.env, CODEX_HOME: codexHome };
      await command('codex', ['plugin', 'marketplace', 'add', REPO_ROOT, '--json'], { cwd: scratch, env: codexEnv });
      await command('codex', ['plugin', 'add', 'ape@ape', '--json'], { cwd: scratch, env: codexEnv });
      const codexPackage = await findPackage(codexHome, '.codex-plugin');
      await assertNoAssets(codexPackage);
      await initializeInstalled('codex', codexPackage);
      process.stdout.write('Codex clean marketplace install and local stdio MCP initialization passed\n');
    }

    if (hosts.has('claude')) {
      const claudeEnv = { ...process.env, CLAUDE_CONFIG_DIR: claudeConfig };
      await command('claude', ['plugin', 'marketplace', 'add', REPO_ROOT, '--scope', 'user'], { cwd: scratch, env: claudeEnv });
      await command('claude', ['plugin', 'install', 'ape@ape', '--scope', 'user'], { cwd: scratch, env: claudeEnv });
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
