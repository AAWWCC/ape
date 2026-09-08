import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createToolCallQueue } from '../bin/ape-mcp.mjs';
import { getTask } from '../lib/runtime/task-store.js';

const roots = [];
const children = new Set();
afterEach(async () => {
  vi.useRealTimers();
  for (const child of children) child.kill('SIGKILL');
  children.clear();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function disconnectedSession(endInput) {
  const root = await mkdtemp(path.join(tmpdir(), 'ape-fourth-mcp-disconnect-'));
  roots.push(root);
  await mkdir(path.join(root, '.ape'));
  const env = { ...process.env };
  delete env.CODEX_CWD;
  delete env.CLAUDE_PROJECT_DIR;
  const child = spawn(process.execPath, [fileURLToPath(new URL('../bin/ape-mcp.mjs', import.meta.url))], {
    cwd: root, env, stdio: ['pipe', 'pipe', 'pipe'],
  });
  children.add(child);
  let stderr = '';
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  child.stdin.on('error', () => {});
  child.stdout.destroy();
  const message = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: {
    name: 'ape_run', arguments: { action: 'regate', project_dir: root }, _meta: {
      'io.modelcontextprotocol/protocolVersion': '2026-07-28',
      'io.modelcontextprotocol/clientCapabilities': { extensions: { 'io.modelcontextprotocol/tasks': {} } },
    },
  } }) + '\n';
  const exited = new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code, signal) => resolve({ code, signal }));
  });
  if (endInput) child.stdin.end(message);
  else child.stdin.write(message);
  const timer = setTimeout(() => child.kill('SIGKILL'), 5000);
  let exit;
  try { exit = await exited; }
  finally { clearTimeout(timer); children.delete(child); child.stdin.destroy(); }
  const names = await readdir(path.join(root, '.ape', 'runtime', 'tasks')).catch(() => []);
  const tasks = [];
  for (const name of names.filter((name) => name.startsWith('task-'))) tasks.push(await getTask(root, name));
  return { ...exit, stderr, tasks };
}

describe('fourth-pass MCP transport shutdown', () => {
  it.each([true, false])('terminalizes accepted tasks after stdout disconnect (stdin EOF: %s)', async (endInput) => {
    const observed = await disconnectedSession(endInput);
    expect(observed.code).toBe(0);
    expect(observed.signal).toBeNull();
    expect(observed.stderr).not.toMatch(/Unhandled|EPIPE/);
    expect(observed.tasks).toHaveLength(1);
    expect(['completed', 'cancelled', 'failed']).toContain(observed.tasks[0].status);
    if (observed.tasks[0].status === 'cancelled') expect(observed.tasks[0].cancellation).not.toBeNull();
    if (observed.tasks[0].status === 'completed') expect(observed.tasks[0].result).not.toBeNull();
  });

  it('keeps accepted calls serialized when a progress writer throws synchronously', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'Date'] });
    let finishFirst;
    const first = new Promise((resolve) => { finishFirst = resolve; });
    const executed = [];
    const responses = [];
    const queue = createToolCallQueue({ intervalMs: 10,
      execute: async (message) => {
        executed.push(message.id);
        if (message.id === 1) await first;
        return { jsonrpc: '2.0', id: message.id, result: { complete: true } };
      },
      writeLine: (payload) => {
        if (payload.method === 'notifications/progress') throw Object.assign(new Error('disconnected'), { code: 'EPIPE' });
        responses.push(payload);
      },
    });
    queue.enqueue({ id: 1, method: 'tools/call', params: { name: 'ape_run', arguments: { action: 'status' }, _meta: { progressToken: 'fixture' } } });
    queue.enqueue({ id: 2, method: 'tools/call', params: { name: 'ape_run', arguments: { action: 'status' } } });
    try {
      await expect(vi.advanceTimersByTimeAsync(20)).resolves.toBeDefined();
      expect(executed).toEqual([1]);
    } finally { finishFirst(); await queue.drain(); }
    expect(executed).toEqual([1, 2]);
    expect(responses.map((response) => response.id)).toEqual([1, 2]);
  });
});
