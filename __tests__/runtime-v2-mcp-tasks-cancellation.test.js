import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { access, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanupAttributedTaskGate } from '../lib/runtime/service.js';
import { runtimePaths } from '../lib/runtime/paths.js';
import {
  createOperationId,
  createTask,
  getTask,
} from '../lib/runtime/task-store.js';
import {
  createToolCallQueue,
  executeToolCall,
  handle,
  shutdownOwnedTasks,
} from '../bin/ape-mcp.mjs';
import { currentTreeSha } from '../lib/runtime/git.js';
import { archiveRun } from '../lib/runtime/history.js';
import { atomicWriteJson, readJson } from '../lib/runtime/storage.js';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const VERSION_META = 'io.modelcontextprotocol/protocolVersion';
const CLIENT_CAPABILITIES_META = 'io.modelcontextprotocol/clientCapabilities';
const TASKS = 'io.modelcontextprotocol/tasks';
const MODERN = '2026-07-28';
const scratches = [];
vi.setConfig({ testTimeout: 20_000, hookTimeout: 20_000 });

async function scratchDir(prefix) {
  const dir = await mkdtemp(path.join(os.tmpdir(), prefix));
  scratches.push(dir);
  await mkdir(path.join(dir, '.ape'), { recursive: true });
  return dir;
}

afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(scratches.splice(0).map((dir) => rm(dir, {
    recursive: true,
    force: true,
    maxRetries: 10,
    retryDelay: 50,
  })));
});

const taskMeta = (extra = {}) => ({
  [VERSION_META]: MODERN,
  [CLIENT_CAPABILITIES_META]: { extensions: { [TASKS]: {} } },
  ...extra,
});

const exists = (file) => access(file).then(() => true, () => false);

function git(cwd, ...args) {
  execFileSync('git', args, {
    cwd,
    stdio: 'ignore',
    env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' },
  });
}

function killTree(pid) {
  if (!Number.isInteger(pid) || pid <= 1) return;
  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/pid', String(pid), '/T', '/F']);
    return;
  }
  try { process.kill(-pid, 'SIGKILL'); } catch {}
}

function alive(pid) {
  if (!Number.isInteger(pid) || pid <= 1) return false;
  try { process.kill(pid, 0); return true; } catch (error) { return error?.code === 'EPERM'; }
}

function session(messages) {
  return new Promise((resolve, reject) => {
    const env = { ...process.env };
    delete env.CLAUDE_PROJECT_DIR;
    delete env.CODEX_CWD;
    const child = spawn(process.execPath, [path.join(root, 'bin', 'ape-mcp.mjs')], {
      cwd: root,
      env,
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
      else resolve(stdout.trim() ? stdout.trim().split(/\r?\n/).map((line) => JSON.parse(line)) : []);
    });
    child.stdin.end(`${messages.map((message) => JSON.stringify(message)).join('\n')}\n`);
  });
}

describe('APE v2 MCP task cancellation and compatibility', () => {
  it('persists cancellation before acknowledging and never signals stale foreign ownership', async () => {
    const projectDir = await scratchDir('ape-task-cancel-foreign-');
    const task = await createTask(projectDir, {
      operationId: createOperationId(),
      action: 'next',
      request: { name: 'ape_run', arguments: { action: 'next', wait_ms: 1 } },
      owner: {
        processId: 2_147_483_000,
        processStartedAt: '2020-01-01T00:00:00.000Z',
        instanceId: 'dead-foreign-owner',
      },
    });

    const responses = await session([{
      jsonrpc: '2.0',
      id: 1,
      method: 'tasks/cancel',
      params: { project_dir: projectDir, taskId: task.taskId, _meta: taskMeta() },
    }]);
    expect(responses.find((entry) => entry.id === 1)?.result).toEqual({ resultType: 'complete' });

    const persisted = await getTask(projectDir, task.taskId);
    expect(persisted.cancellation).toMatchObject({
      reason: 'client requested task cancellation',
    });
    expect(['working', 'cancelled']).toContain(persisted.status);

    const staleAttribution = await cleanupAttributedTaskGate(projectDir, {
      runId: 'run-owned-by-someone-else',
      watch: { pid: 2_147_483_000, nonce: 'stale', started_at: '2020-01-01T00:00:00.000Z' },
    });
    expect(staleAttribution).toMatchObject({ cleaned: false });
    expect(staleAttribution.reason).toMatch(/no longer belongs|stale|foreign/i);
  });

  it('reaps only an exactly attributable gate suite before reporting cleanup', async () => {
    const projectDir = await scratchDir('ape-task-gate-cleanup-');
    const runtime = path.join(projectDir, '.ape', 'runtime');
    await mkdir(runtime, { recursive: true });
    const watch = {
      pid: null,
      started_at: '2026-08-10T12:00:00.000Z',
      nonce: 'task-gate-nonce',
      job_file: path.join(runtime, 'task-gate-job.json'),
      artifact_file: path.join(runtime, 'task-gate-artifact.json'),
      heartbeat_file: path.join(runtime, 'task-gate-heartbeat.json'),
    };
    await Promise.all([
      writeFile(watch.job_file, '{}\n'),
      writeFile(watch.artifact_file, '{}\n'),
      writeFile(watch.heartbeat_file, '{}\n'),
      writeFile(path.join(runtime, 'active.json'), `${JSON.stringify({
        run_id: 'run-task-gate',
        gates_watch: watch,
      })}\n`),
    ]);

    const stale = await cleanupAttributedTaskGate(projectDir, {
      runId: 'run-task-gate',
      watch: { ...watch, nonce: 'wrong-owner' },
    });
    expect(stale).toMatchObject({ cleaned: false });
    await expect(access(watch.job_file)).resolves.toBeUndefined();

    const cleaned = await cleanupAttributedTaskGate(projectDir, {
      runId: 'run-task-gate',
      watch,
    });
    expect(cleaned).toEqual({ cleaned: true });
    for (const file of [watch.job_file, watch.artifact_file, watch.heartbeat_file]) {
      await expect(access(file)).rejects.toMatchObject({ code: 'ENOENT' });
    }
  });

  it('tasks/cancel reaps the gate suite created by that local task before publishing cancelled', async () => {
    const projectDir = await scratchDir('ape-task-live-gate-cancel-');
    const outside = await scratchDir('ape-task-live-gate-probe-');
    await mkdir(path.join(projectDir, 'src'), { recursive: true });
    await writeFile(path.join(projectDir, 'src', 'value.js'), 'export const value = 1;\n');
    git(projectDir, 'init', '-q');
    git(projectDir, 'config', 'user.email', 'ape@example.test');
    git(projectDir, 'config', 'user.name', 'APE Test');
    git(projectDir, 'add', '.');
    git(projectDir, 'commit', '-qm', 'baseline');

    const started = path.join(outside, 'started');
    const probe = path.join(outside, 'gate.cjs');
    await writeFile(probe, [
      "const fs = require('node:fs');",
      `fs.writeFileSync(${JSON.stringify(started)}, String(process.pid));`,
      'Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 15000);',
    ].join('\n'));
    const paths = runtimePaths(projectDir);
    await mkdir(paths.runtime, { recursive: true });
    await atomicWriteJson(paths.config, {
      shipping: { auto_merge: true, provider: 'github', required_remote_checks: false },
      policy: { full_suite_cache: false },
      // Keep the task's charged effect active after the detached suite starts.
      // The probe below is then a deterministic pre-terminal cancellation
      // barrier instead of racing the task's completed generation.
      gates: { inline_grace_ms: 5_000 },
      test_commands: { full: `node "${probe}"` },
    });
    const tree = await currentTreeSha(projectDir);
    const blocked = {
      version: 2,
      schema_version: '2.0.0',
      run_id: 'run-task-live-gate',
      status: 'blocked',
      stage: 'gates',
      block_reason: 'one or more deterministic merge gates failed',
      objective: 'cancel an attributable task gate',
      mode: 'phase',
      lane: 'mechanical',
      requested_lane: 'mechanical',
      lane_reasons: [],
      lane_escalated: false,
      behavioral: false,
      high_risk: false,
      policy: { high_risk_security_review: true },
      host: 'codex',
      claimed_paths: ['src/value.js'],
      test_paths: [],
      requirements: ['R-task-cancel'],
      risk_triggers: [],
      branch: 'ape/task-cancel',
      base_commit_sha: 'a'.repeat(40),
      tree_sha: tree,
      tickets: [],
      receipts: [{
        receipt_hash: 'a',
        previous_receipt_hash: null,
        status: 'passed',
        agent: { host: 'codex', role: 'implementer' },
        tests: [{ passed: true }],
        changed_files: ['src/value.js'],
        head_tree_sha: tree,
      }],
      attempts: {},
      remediation_cycles: 0,
      regate_attempts: 0,
      gates: { passed: false, tree_sha: tree },
      timing: { test_ms: 1, remote_ci_ms: 0 },
      created_at: '2026-08-10T12:00:00.000Z',
      updated_at: '2026-08-10T12:00:00.000Z',
      terminal_at: '2026-08-10T12:00:00.000Z',
    };
    await atomicWriteJson(paths.active, blocked);
    await archiveRun(paths, blocked, { ifAbsent: true });

    let runnerPid = null;
    try {
      const created = await executeToolCall({
        jsonrpc: '2.0', id: 1, method: 'tools/call',
        params: {
          name: 'ape_run',
          arguments: { action: 'regate', project_dir: projectDir },
          _meta: taskMeta(),
        },
      });
      expect(created.result.resultType).toBe('task');
      for (let index = 0; index < 2_000; index += 1) {
        if (await exists(started)) break;
        await new Promise((resolve) => setTimeout(resolve, 2));
      }
      expect(await exists(started), 'the gate command must start before cancellation').toBe(true);
      const cancelledAck = await handle({
        jsonrpc: '2.0', id: 2, method: 'tasks/cancel',
        params: { project_dir: projectDir, taskId: created.result.taskId, _meta: taskMeta() },
      });
      expect(cancelledAck.result).toEqual({ resultType: 'complete' });

      const liveWatch = (await readJson(paths.active, null))?.gates_watch ?? null;
      expect(liveWatch, 'the task operation must persist the attributable gate watch').toBeTruthy();
      runnerPid = liveWatch.pid;

      let terminal = null;
      for (let index = 0; index < 300; index += 1) {
        terminal = await getTask(projectDir, created.result.taskId);
        if (terminal?.status === 'cancelled') break;
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      expect(terminal).toMatchObject({ status: 'cancelled' });
      for (const file of [liveWatch.job_file, liveWatch.artifact_file, liveWatch.heartbeat_file]) {
        expect(await exists(file)).toBe(false);
      }
      expect(runnerPid, 'the attributable gate watch must name a spawned suite runner').toBeGreaterThan(1);
      expect(alive(runnerPid), 'cancelled must await the local runner handle being reaped').toBe(false);
    } finally {
      killTree(runnerPid);
      await shutdownOwnedTasks('task cancellation test cleanup');
    }
  });

  it('treats STDIO shutdown as cancellation and waits for owned task cleanup', async () => {
    const projectDir = await scratchDir('ape-task-eof-shutdown-');
    const created = await executeToolCall({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: {
        name: 'ape_run',
        arguments: { action: 'regate', project_dir: projectDir },
        _meta: taskMeta(),
      },
    });
    expect(created.result).toMatchObject({ resultType: 'task', status: 'working' });

    await shutdownOwnedTasks('STDIO EOF requested task cleanup');
    const terminal = await getTask(projectDir, created.result.taskId);
    expect(terminal).toMatchObject({
      status: 'cancelled',
      cancellation: { reason: 'STDIO EOF requested task cleanup' },
    });
  });

  it('keeps progress heartbeats for a non-task next even on the modern protocol', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'Date'] });
    const lines = [];
    let release;
    const work = new Promise((resolve) => { release = resolve; });
    const queue = createToolCallQueue({
      execute: async () => work,
      writeLine: (line) => lines.push(line),
      intervalMs: 1_000,
    });
    const pending = queue.enqueue({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: {
        name: 'ape_run',
        arguments: { action: 'next' },
        _meta: { [VERSION_META]: MODERN, progressToken: 'legacy-next-progress' },
      },
    });

    // The queue resolves whether this particular `next` will become a task
    // from durable run state before arming either progress path.
    await new Promise((resolve) => setImmediate(resolve));
    await vi.advanceTimersByTimeAsync(2_000);
    expect(lines.filter((line) => line.method === 'notifications/progress')).toEqual([
      expect.objectContaining({ params: expect.objectContaining({ progressToken: 'legacy-next-progress' }) }),
      expect.objectContaining({ params: expect.objectContaining({ progressToken: 'legacy-next-progress' }) }),
    ]);
    release({ jsonrpc: '2.0', id: 1, result: { resultType: 'complete' } });
    await pending;
  });

  it('keeps progress for an opted-in next that does not actually create a task', async () => {
    const projectDir = await scratchDir('ape-task-progress-short-next-');
    const lines = [];
    let release;
    const work = new Promise((resolve) => { release = resolve; });
    const queue = createToolCallQueue({
      execute: async () => work,
      writeLine: (line) => lines.push(line),
      intervalMs: 10,
    });
    const pending = queue.enqueue({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: {
        name: 'ape_run',
        arguments: { action: 'next', project_dir: projectDir },
        _meta: taskMeta({ progressToken: 'opted-short-next' }),
      },
    });

    await new Promise((resolve) => setTimeout(resolve, 35));
    expect(lines.filter((line) => line.method === 'notifications/progress').length).toBeGreaterThanOrEqual(2);
    release({ jsonrpc: '2.0', id: 1, result: { resultType: 'complete' } });
    await pending;
  });

  it('uses durable task state instead of progress notifications for opted-in task calls', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'Date'] });
    const lines = [];
    let release;
    const work = new Promise((resolve) => { release = resolve; });
    const queue = createToolCallQueue({
      execute: async () => work,
      writeLine: (line) => lines.push(line),
      intervalMs: 1_000,
    });
    const pending = queue.enqueue({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: {
        name: 'ape_run',
        arguments: { action: 'regate' },
        _meta: taskMeta({ progressToken: 'must-not-be-used' }),
      },
    });

    await vi.advanceTimersByTimeAsync(10_000);
    expect(lines).toEqual([]);
    release({ jsonrpc: '2.0', id: 1, result: { resultType: 'task', taskId: `task-${'A'.repeat(43)}` } });
    await pending;
    expect(lines).toHaveLength(1);
    expect(lines[0].result.resultType).toBe('task');
  });
});
