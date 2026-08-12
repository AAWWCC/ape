#!/usr/bin/env node

import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const PACKAGES = Object.freeze([
  ['codex', join(REPO_ROOT, 'plugins', 'ape')],
  ['claude', join(REPO_ROOT, 'plugins', 'ape-claude')],
]);

function expandRoot(value, host, pluginRoot) {
  if (host === 'claude') return value.replaceAll('${CLAUDE_PLUGIN_ROOT}', pluginRoot);
  return isAbsolute(value) ? value : resolve(pluginRoot, value);
}

async function smoke(host, pluginRoot) {
  const config = JSON.parse(await readFile(join(pluginRoot, '.mcp.json'), 'utf8'));
  const server = config?.mcpServers?.ape;
  if (server?.command !== 'node' || !Array.isArray(server.args)) {
    throw new Error(`${host} package has no local node MCP declaration`);
  }
  const args = server.args.map((value, index) =>
    index === 0 ? expandRoot(value, host, pluginRoot) : value
  );
  const env = { ...process.env };
  delete env.CLAUDE_PROJECT_DIR;
  delete env.CODEX_CWD;
  if (host === 'claude') env.CLAUDE_PLUGIN_ROOT = pluginRoot;
  else env.PLUGIN_ROOT = pluginRoot;

  const responses = await new Promise((resolvePromise, reject) => {
    const child = spawn(process.execPath, args, {
      cwd: server.cwd ? resolve(pluginRoot, server.cwd) : pluginRoot,
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`${host} package MCP smoke timed out`));
    }, 10_000);
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0) reject(new Error(`${host} package MCP exited ${code}: ${stderr}`));
      else resolvePromise(stdout.trim().split(/\r?\n/u).filter(Boolean).map((line) => JSON.parse(line)));
    });
    child.stdin.end([
      { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } },
      { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} },
    ].map((message) => JSON.stringify(message)).join('\n') + '\n');
  });
  if (responses[0]?.result?.serverInfo?.version !== '2.17.0') {
    throw new Error(`${host} package MCP returned the wrong server version`);
  }
  const tools = responses[1]?.result?.tools?.map((tool) => tool.name);
  if (JSON.stringify(tools) !== JSON.stringify(['ape_run', 'ape_status', 'ape_history', 'ape_config'])) {
    throw new Error(`${host} package MCP returned the wrong tool surface: ${JSON.stringify(tools)}`);
  }
  process.stdout.write(`${host} package local stdio MCP initialized cleanly\n`);
}

for (const [host, pluginRoot] of PACKAGES) await smoke(host, pluginRoot);
