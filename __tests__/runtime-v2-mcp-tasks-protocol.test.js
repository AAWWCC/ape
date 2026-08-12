import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { executeToolCall, shutdownOwnedTasks } from '../bin/ape-mcp.mjs';
import {
  appendTaskGeneration,
  createOperationId,
  createTask,
  getTask,
  requestTaskCancellation,
} from '../lib/runtime/task-store.js';
import { runtimePaths } from '../lib/runtime/paths.js';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const MODERN = '2026-07-28';
const VERSION_META = 'io.modelcontextprotocol/protocolVersion';
const CLIENT_CAPABILITIES_META = 'io.modelcontextprotocol/clientCapabilities';
const TASKS = 'io.modelcontextprotocol/tasks';
const scratches = [];

async function scratchDir(prefix) {
  const dir = await mkdtemp(path.join(os.tmpdir(), prefix));
  scratches.push(dir);
  await mkdir(path.join(dir, '.ape'), { recursive: true });
  return dir;
}

afterEach(async () => {
  vi.useRealTimers();
  // Imported executeToolCall intentionally leaves task work running just as
  // the STDIO server does between requests. Exercise the same shutdown
  // contract before removing governed roots so teardown cannot race a
  // legitimate final task-generation write.
  await shutdownOwnedTasks('protocol test teardown');
  await Promise.all(scratches.splice(0).map((dir) => rm(dir, {
    recursive: true,
    force: true,
    maxRetries: 10,
    retryDelay: 50,
  })));
});

const meta = ({ tasks = false, progressToken } = {}) => ({
  [VERSION_META]: MODERN,
  ...(tasks ? { [CLIENT_CAPABILITIES_META]: { extensions: { [TASKS]: {} } } } : {}),
  ...(progressToken !== undefined ? { progressToken } : {}),
});

const toolCall = (id, projectDir, action, options = {}) => ({
  jsonrpc: '2.0',
  id,
  method: 'tools/call',
  params: {
    name: 'ape_run',
    arguments: { action, project_dir: projectDir, ...(options.arguments ?? {}) },
    _meta: meta(options),
  },
});

const taskCall = (id, method, projectDir, taskId, options = {}) => ({
  jsonrpc: '2.0',
  id,
  method,
  params: {
    project_dir: projectDir,
    taskId,
    ...(options.params ?? {}),
    _meta: meta(options),
  },
});

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

const byId = (responses, id) => responses.find((entry) => entry.id === id);

async function storedTask(projectDir, suffix) {
  return createTask(projectDir, {
    operationId: createOperationId(),
    action: 'next',
    request: { name: 'ape_run', arguments: { action: 'next', wait_ms: 1 } },
    owner: {
      processId: process.pid,
      processStartedAt: '2026-08-10T12:00:00.000Z',
      instanceId: `protocol-${suffix}`,
    },
  });
}

async function waitForTask(projectDir, taskId, predicate, tries = 100) {
  for (let index = 0; index < tries; index += 1) {
    const task = await getTask(projectDir, taskId);
    if (task && predicate(task)) return task;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return getTask(projectDir, taskId);
}

describe('APE v2 experimental MCP task protocol', () => {
  it('advertises the draft extension but deliberately exposes no tasks/list', async () => {
    const projectDir = await scratchDir('ape-task-discover-');
    const responses = await session([
      { jsonrpc: '2.0', id: 1, method: 'server/discover', params: { _meta: meta() } },
      taskCall(2, 'tasks/list', projectDir, undefined, { tasks: true }),
    ]);

    expect(byId(responses, 1).result.capabilities.extensions).toHaveProperty(TASKS);
    expect(byId(responses, 2).error).toMatchObject({ code: -32601 });
  });

  it('isolates the task capability per request and preserves non-opting tool calls', async () => {
    const projectDir = await scratchDir('ape-task-capability-');
    const optedIn = await executeToolCall(toolCall(1, projectDir, 'regate', { tasks: true }));
    expect(optedIn.result).toMatchObject({ resultType: 'task', status: 'working' });
    expect(optedIn.result.taskId).toMatch(/^task-[A-Za-z0-9_-]{43}$/);
    const settledValidationError = await waitForTask(
      projectDir,
      optedIn.result.taskId,
      (task) => ['completed', 'failed', 'cancelled'].includes(task.status),
    );
    expect(settledValidationError).toMatchObject({
      status: 'completed',
      result: { resultType: 'complete', isError: true },
    });
    expect(settledValidationError.error).toBeNull();

    // Capability state belongs to the request, not this imported server
    // process: the next request omits it and must receive the legacy-shaped
    // completed tool result, never a task and never a capability error.
    const notOptedIn = await executeToolCall(toolCall(2, projectDir, 'regate'));
    expect(notOptedIn.error).toBeUndefined();
    expect(notOptedIn.result.resultType).toBe('complete');
    expect(notOptedIn.result.taskId).toBeUndefined();

    // A task capability does not force short operations onto the extension.
    const shortCall = await executeToolCall(toolCall(3, projectDir, 'status', { tasks: true }));
    expect(shortCall.result.resultType).toBe('complete');
    expect(shortCall.result.taskId).toBeUndefined();

    const falseDeclaration = toolCall(31, projectDir, 'regate');
    falseDeclaration.params._meta[CLIENT_CAPABILITIES_META] = { extensions: { [TASKS]: false } };
    const falseOptIn = await executeToolCall(falseDeclaration);
    expect(falseOptIn.result.resultType).toBe('complete');
    expect(falseOptIn.result.taskId).toBeUndefined();

    const waitedLegacyCall = await executeToolCall(toolCall(4, projectDir, 'next', {
      arguments: { wait_ms: 10 },
    }));
    expect(waitedLegacyCall.error).toBeUndefined();
    expect(waitedLegacyCall.result.resultType).toBe('complete');
    expect(waitedLegacyCall.result.taskId).toBeUndefined();
  });

  it('makes generation zero durable and resolvable before returning CreateTaskResult', async () => {
    const projectDir = await scratchDir('ape-task-before-response-');
    const response = await executeToolCall(toolCall(1, projectDir, 'regate', { tasks: true }));
    const taskId = response.result.taskId;
    const generationZeroFile = path.join(
      projectDir, '.ape', 'runtime', 'tasks', taskId, '000000.json',
    );
    const generationZero = JSON.parse(await readFile(generationZeroFile, 'utf8'));

    expect(response.result).toMatchObject({ resultType: 'task', taskId, status: 'working' });
    expect(generationZero).toMatchObject({ taskId, generation: 0, status: 'working' });
    expect(await getTask(projectDir, taskId)).not.toBeNull();
  });

  it('requires opt-in again for every get/update/cancel and rejects unknown or path-like ids', async () => {
    const projectDir = await scratchDir('ape-task-method-capability-');
    const task = await storedTask(projectDir, 'method-capability');
    const unknown = `task-${'A'.repeat(43)}`;
    const responses = await session([
      taskCall(1, 'tasks/get', projectDir, task.taskId),
      taskCall(2, 'tasks/update', projectDir, task.taskId),
      taskCall(3, 'tasks/cancel', projectDir, task.taskId),
      taskCall(4, 'tasks/get', projectDir, unknown, { tasks: true }),
      taskCall(5, 'tasks/get', projectDir, '../escape', { tasks: true }),
      taskCall(6, 'tasks/get', projectDir, task.taskId, { tasks: true }),
      taskCall(7, 'tasks/update', projectDir, task.taskId, {
        tasks: true,
        params: { inputResponses: { answer: 'acknowledged without inventing a workflow' } },
      }),
    ]);

    for (const id of [1, 2, 3]) {
      expect(byId(responses, id).error).toMatchObject({
        code: -32003,
        data: { requiredCapabilities: { extensions: { [TASKS]: {} } } },
      });
    }
    expect(byId(responses, 4).error).toMatchObject({ code: -32602 });
    expect(byId(responses, 4).error.message).toMatch(/not found/i);
    expect(byId(responses, 5).error).toMatchObject({ code: -32602 });
    expect(byId(responses, 5).error.message).toMatch(/invalid|malformed/i);
    expect(byId(responses, 6).result).toMatchObject({
      resultType: 'complete',
      taskId: task.taskId,
      status: 'working',
    });
    expect(byId(responses, 7).result).toEqual({ resultType: 'complete' });
    expect((await getTask(projectDir, task.taskId)).lastAcknowledgedInput).toEqual({
      inputResponses: { answer: 'acknowledged without inventing a workflow' },
    });
  });

  it('keeps task RPCs off the legacy protocol surface even when capability metadata is present', async () => {
    const projectDir = await scratchDir('ape-task-legacy-method-');
    const task = await storedTask(projectDir, 'legacy-method');
    const legacyMeta = {
      [VERSION_META]: '2025-06-18',
      [CLIENT_CAPABILITIES_META]: { extensions: { [TASKS]: {} } },
    };
    const responses = await session([{
      jsonrpc: '2.0',
      id: 1,
      method: 'tasks/get',
      params: { project_dir: projectDir, taskId: task.taskId, _meta: legacyMeta },
    }]);

    expect(byId(responses, 1).error).toMatchObject({ code: -32601 });
  });

  it('binds a deferred no-run task to the no-run observation instead of a later run', async () => {
    const projectDir = await scratchDir('ape-task-no-run-binding-');
    const created = await executeToolCall(toolCall(1, projectDir, 'regate', { tasks: true }));

    const paths = runtimePaths(projectDir);
    // The continuation of the awaited tools/call runs before the deferred
    // timer. A synchronous write makes the later run visible before the task
    // can execute, deterministically reproducing the reorder risk.
    writeFileSync(paths.active, `${JSON.stringify({ run_id: 'run-created-after-task' }, null, 2)}\n`, { mode: 0o600 });
    const terminal = await waitForTask(
      projectDir,
      created.result.taskId,
      (task) => task.status !== 'working',
    );

    expect(terminal).toMatchObject({
      status: 'completed',
      result: { resultType: 'complete', isError: true },
    });
    expect(terminal.result.content[0].text).toMatch(/no active run/i);
  });

  it('preserves a corrupt-state preflight diagnostic instead of masking it as no active run', async () => {
    const projectDir = await scratchDir('ape-task-corrupt-preflight-');
    const paths = runtimePaths(projectDir);
    await mkdir(path.dirname(paths.active), { recursive: true });
    await writeFile(paths.active, '{not-json\n', { mode: 0o600 });

    const created = await executeToolCall(toolCall(1, projectDir, 'regate', { tasks: true }));
    const terminal = await waitForTask(
      projectDir,
      created.result.taskId,
      (task) => task.status !== 'working',
    );
    expect(terminal).toMatchObject({ status: 'completed', result: { isError: true } });
    expect(terminal.result.content[0].text).toMatch(/corrupt|unparseable|quarantine/i);
    expect(terminal.result.content[0].text).not.toMatch(/"reason":"no active run"/i);
  });

  it('makes repeated get polls side-effect free', async () => {
    const projectDir = await scratchDir('ape-task-repeated-polls-');
    const task = await storedTask(projectDir, 'repeated-polls');
    const responses = await session([
      taskCall(1, 'tasks/get', projectDir, task.taskId, { tasks: true }),
      taskCall(2, 'tasks/get', projectDir, task.taskId, { tasks: true }),
      taskCall(3, 'tasks/get', projectDir, task.taskId, { tasks: true }),
    ]);
    expect(byId(responses, 2).result).toEqual(byId(responses, 1).result);
    expect(byId(responses, 3).result).toEqual(byId(responses, 1).result);
    expect((await getTask(projectDir, task.taskId)).generation).toBe(0);
  });

  it('opportunistically collects expired journals when task traffic continues', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-08-10T12:00:00.000Z'));
    const projectDir = await scratchDir('ape-task-opportunistic-gc-');
    const expired = await createTask(projectDir, {
      operationId: createOperationId(),
      action: 'next',
      request: { action: 'next', wait_ms: 1 },
      owner: {
        processId: process.pid,
        processStartedAt: '2026-08-10T12:00:00.000Z',
        instanceId: 'opportunistic-gc',
      },
      ttlMs: 60_000,
    });
    vi.setSystemTime(new Date('2026-08-10T12:01:01.000Z'));

    await executeToolCall(toolCall(1, projectDir, 'regate', { tasks: true }));
    await expect(getTask(projectDir, expired.taskId)).resolves.toBeNull();
  });

  it('projects completed tool errors and failed JSON-RPC errors as distinct states', async () => {
    const projectDir = await scratchDir('ape-task-projections-');
    const completedTask = await storedTask(projectDir, 'completed');
    const completed = await appendTaskGeneration(projectDir, completedTask.taskId, {
      status: 'completed',
      result: {
        resultType: 'complete',
        isError: true,
        content: [{ type: 'text', text: 'ordinary tool refusal' }],
      },
    });
    const failedTask = await storedTask(projectDir, 'failed');
    const failed = await appendTaskGeneration(projectDir, failedTask.taskId, {
      status: 'failed',
      error: { code: -32603, message: 'execution failed before a tool result' },
    });
    const inputTask = await storedTask(projectDir, 'input-required');
    const inputRequired = await appendTaskGeneration(projectDir, inputTask.taskId, {
      status: 'input_required',
      statusMessage: 'answer needed',
      inputRequests: [{ prompt: 'continue?' }],
    });
    const cancelledTask = await storedTask(projectDir, 'cancelled');
    const cancellationRequested = await requestTaskCancellation(projectDir, cancelledTask.taskId, {
      requester: cancelledTask.owner,
      reason: 'cancel projection',
    });
    const cancelled = await appendTaskGeneration(projectDir, cancellationRequested.taskId, {
      status: 'cancelled',
      statusMessage: 'cancelled after cleanup',
    });

    const responses = await session([
      taskCall(1, 'tasks/get', projectDir, completed.taskId, { tasks: true }),
      taskCall(2, 'tasks/get', projectDir, failed.taskId, { tasks: true }),
      taskCall(3, 'tasks/update', projectDir, failed.taskId, {
        tasks: true,
        params: { inputResponses: { answer: 'ignored after terminal' } },
      }),
      taskCall(4, 'tasks/get', projectDir, inputRequired.taskId, { tasks: true }),
      taskCall(5, 'tasks/get', projectDir, cancelled.taskId, { tasks: true }),
    ]);
    expect(byId(responses, 1).result).toMatchObject({
      status: 'completed',
      result: { resultType: 'complete', isError: true },
    });
    expect(byId(responses, 2).result).toMatchObject({
      status: 'failed',
      error: { code: -32603, message: 'execution failed before a tool result' },
    });
    expect(byId(responses, 3).result).toEqual({ resultType: 'complete' });
    expect(byId(responses, 4).result).toMatchObject({
      status: 'input_required',
      statusMessage: 'answer needed',
      inputRequests: [{ prompt: 'continue?' }],
    });
    expect(byId(responses, 5).result).toMatchObject({
      status: 'cancelled',
      statusMessage: 'cancelled after cleanup',
    });
  });
});
