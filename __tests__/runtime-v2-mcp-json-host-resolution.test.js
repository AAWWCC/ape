import { execFileSync, spawn } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const claudePackageRoot = path.join(root, 'plugins', 'ape-claude');
const cleanups = [];

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function checkedInSession(messages, envHints, cwd) {
  const declaration = JSON.parse(await readFile(path.join(claudePackageRoot, '.mcp.json'), 'utf8'));
  const server = declaration.mcpServers.ape;
  expect(server.command).toBe('node');
  const argv = server.args.map((arg) => arg.replaceAll('${CLAUDE_PLUGIN_ROOT}', claudePackageRoot));
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, argv, {
      cwd,
      env: { ...process.env, ...envHints },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code !== 0) reject(new Error(stderr));
      else resolve(stdout.trim().split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line)));
    });
    child.stdin.end(`${messages.map((message) => JSON.stringify(message)).join('\n')}\n`);
  });
}

describe('the checked-in Claude MCP declaration has a bounded, executable host-resolution proof', () => {
  it('executes its exact argv and prefers the Claude root hint when Claude and Codex hints diverge', async () => {
    const claudeRoot = await mkdtemp(path.join(os.tmpdir(), 'ape-mcp-claude-root-'));
    const codexRoot = await mkdtemp(path.join(os.tmpdir(), 'ape-mcp-codex-root-'));
    const unrelatedCwd = await mkdtemp(path.join(os.tmpdir(), 'ape-mcp-unrelated-cwd-'));
    cleanups.push(claudeRoot, codexRoot, unrelatedCwd);
    await Promise.all([
      mkdir(path.join(claudeRoot, '.ape'), { recursive: true }),
      mkdir(path.join(codexRoot, '.ape'), { recursive: true }),
    ]);
    execFileSync('git', ['init', '-q'], { cwd: claudeRoot });

    const [response] = await checkedInSession([{
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: 'ape_config', arguments: { action: 'doctor' } },
    }], {
      CLAUDE_PROJECT_DIR: claudeRoot,
      CODEX_CWD: codexRoot,
    }, unrelatedCwd);
    const result = JSON.parse(response.result.content[0].text);
    const gitCheck = result.doctor.checks.find((check) => check.name === 'git-repository');
    expect(gitCheck).toMatchObject({ passed: true });
  });

  it('documents the proof boundary: argv/env execution is not evidence of Claude Code ancestor discovery', async () => {
    const hooks = await readFile(path.join(root, 'docs', 'hooks.md'), 'utf8');
    expect(hooks).toMatch(/checked-in[^.]{0,120}\.mcp\.json[^.]{0,240}(argv|declaration)/is);
    expect(hooks).toMatch(/does not prove|does not establish/i);
    expect(hooks).toMatch(/ancestor[^.]{0,120}(unverified|not verified|not documented)/i);
  });
});
