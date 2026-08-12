import { cp, lstat, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  acknowledgeTaskUpdate,
  appendTaskGeneration,
  collectExpiredTasks,
  createOperationId,
  createTask,
  getTask,
  requestTaskCancellation,
} from '../lib/runtime/task-store.js';

const scratches = [];

async function scratchDir(prefix) {
  const dir = await mkdtemp(path.join(os.tmpdir(), prefix));
  scratches.push(dir);
  return dir;
}

const owner = (suffix = 'owner') => ({
  processId: process.pid,
  processStartedAt: '2026-08-10T12:00:00.000Z',
  instanceId: `test-${suffix}`,
});

async function newTask(root, overrides = {}) {
  return createTask(root, {
    operationId: createOperationId(),
    action: 'next',
    request: { name: 'ape_run', arguments: { action: 'next', wait_ms: 1 } },
    owner: owner(),
    ...overrides,
  });
}

async function expectProtectedRegularFile(file) {
  const metadata = await lstat(file);
  expect(metadata.isFile()).toBe(true);
  expect(metadata.isSymbolicLink()).toBe(false);
  if (process.platform !== 'win32') {
    expect(
      metadata.mode & 0o777,
      'task state must not be readable by another POSIX user',
    ).toBe(0o600);
  }
}

afterEach(async () => {
  await Promise.all(scratches.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('APE v2 durable MCP task storage', () => {
  it('initializes a fresh store safely under concurrent first use', async () => {
    const root = await scratchDir('ape-task-concurrent-init-');
    const tasks = await Promise.all(
      Array.from({ length: 16 }, (_, index) => newTask(root, { owner: owner(`concurrent-${index}`) })),
    );

    expect(new Set(tasks.map((task) => task.taskId))).toHaveLength(16);
    await expect(Promise.all(tasks.map((task) => getTask(root, task.taskId))))
      .resolves.toEqual(tasks);
  }, 60_000);

  it('persists private, resolvable generation zero before createTask returns', async () => {
    const root = await scratchDir('ape-task-durable-create-');
    const task = await newTask(root);

    expect(task.taskId).toMatch(/^task-[A-Za-z0-9_-]{43}$/);
    expect(task.operationId).toMatch(/^op-[A-Za-z0-9_-]{43}$/);
    expect(task).toMatchObject({ generation: 0, status: 'working', previousHash: null });
    expect(task.hash).toMatch(/^[a-f0-9]{64}$/);
    await expect(getTask(root, task.taskId)).resolves.toEqual(task);

    const file = path.join(root, '.ape', 'runtime', 'tasks', task.taskId, '000000.json');
    const stored = JSON.parse(await readFile(file, 'utf8'));
    expect(stored).toEqual(task);
    await expectProtectedRegularFile(file);
  });

  it('serializes concurrent appends into an immutable hash-chained generation journal', async () => {
    const root = await scratchDir('ape-task-generations-');
    const initial = await newTask(root);
    const updates = await Promise.all([
      appendTaskGeneration(root, initial.taskId, { statusMessage: 'poll-a' }),
      appendTaskGeneration(root, initial.taskId, { statusMessage: 'poll-b' }),
    ]);
    expect(updates.map((entry) => entry.generation).sort((a, b) => a - b)).toEqual([1, 2]);

    const directory = path.join(root, '.ape', 'runtime', 'tasks', initial.taskId);
    const names = (await readdir(directory)).sort();
    expect(names).toEqual(['000000.json', '000001.json', '000002.json']);
    const records = await Promise.all(names.map(async (name) => JSON.parse(
      await readFile(path.join(directory, name), 'utf8'),
    )));
    expect(records.map((entry) => entry.generation)).toEqual([0, 1, 2]);
    expect(records[1].previousHash).toBe(records[0].hash);
    expect(records[2].previousHash).toBe(records[1].hash);
    expect(new Set(records.map((entry) => entry.hash))).toHaveLength(3);
    await expect(getTask(root, initial.taskId)).resolves.toEqual(records[2]);
  });

  it('stores every status projection and preserves completed isError results', async () => {
    const root = await scratchDir('ape-task-statuses-');

    const completing = await newTask(root);
    const inputRequired = await appendTaskGeneration(root, completing.taskId, {
      status: 'input_required',
      statusMessage: 'operator input required',
      inputRequests: [{ prompt: 'continue?' }],
    });
    expect(inputRequired).toMatchObject({
      status: 'input_required',
      inputRequests: [{ prompt: 'continue?' }],
    });
    const acknowledged = await acknowledgeTaskUpdate(root, completing.taskId, { answer: 'yes' });
    expect(acknowledged.lastAcknowledgedInput).toEqual({ answer: 'yes' });
    const errorResult = {
      resultType: 'complete',
      isError: true,
      content: [{ type: 'text', text: 'tool-level refusal' }],
    };
    const completed = await appendTaskGeneration(root, completing.taskId, {
      status: 'completed',
      result: errorResult,
    });
    expect(completed).toMatchObject({ status: 'completed', result: errorResult });

    const failing = await newTask(root);
    const failed = await appendTaskGeneration(root, failing.taskId, {
      status: 'failed',
      error: { code: -32603, message: 'execution transport failed', data: { phase: 'dispatch' } },
    });
    expect(failed).toMatchObject({
      status: 'failed',
      error: { code: -32603, message: 'execution transport failed', data: { phase: 'dispatch' } },
    });

    const cancelling = await newTask(root);
    const requested = await requestTaskCancellation(root, cancelling.taskId, {
      requester: owner('requester'),
      reason: 'stop safely',
    });
    expect(requested.cancellation).toMatchObject({ reason: 'stop safely' });
    const cancelled = await appendTaskGeneration(root, cancelling.taskId, {
      status: 'cancelled',
      statusMessage: 'cleanup complete',
    });
    expect(cancelled).toMatchObject({ status: 'cancelled', statusMessage: 'cleanup complete' });
  });

  it('rejects path-like ids, distinguishes unknown safe ids, and binds journals to one root', async () => {
    const left = await scratchDir('ape-task-root-left-');
    const right = await scratchDir('ape-task-root-right-');
    const task = await newTask(left);

    await expect(getTask(left, '../tasks/passwd')).rejects.toMatchObject({ code: 'invalid_task_id' });
    await expect(getTask(left, `${task.taskId}/000000.json`)).rejects.toMatchObject({ code: 'invalid_task_id' });
    await expect(getTask(left, `task-${'A'.repeat(43)}`)).resolves.toBeNull();

    const destination = path.join(right, '.ape', 'runtime', 'tasks', task.taskId);
    await mkdir(path.dirname(destination), { recursive: true });
    await cp(path.join(left, '.ape', 'runtime', 'tasks', task.taskId), destination, { recursive: true });
    await expect(getTask(right, task.taskId)).rejects.toMatchObject({ code: 'root_binding_mismatch' });
  });

  it('fails closed on journal tampering and bounded-field overflow', async () => {
    const root = await scratchDir('ape-task-corruption-');
    const bounded = await newTask(root);
    await expect(appendTaskGeneration(root, bounded.taskId, {
      statusMessage: 'x'.repeat(2_049),
    })).rejects.toThrow();
    expect((await getTask(root, bounded.taskId)).generation).toBe(0);

    const file = path.join(root, '.ape', 'runtime', 'tasks', bounded.taskId, '000000.json');
    const tampered = JSON.parse(await readFile(file, 'utf8'));
    tampered.statusMessage = 'changed without recomputing the immutable hash';
    await writeFile(file, `${JSON.stringify(tampered, null, 2)}\n`, { mode: 0o600 });
    await expect(getTask(root, bounded.taskId)).rejects.toMatchObject({ code: 'corrupt_task' });
  });

  it('collects expired tasks only after writing a private terminal-hash audit record', async () => {
    const root = await scratchDir('ape-task-ttl-');
    const task = await newTask(root, { ttlMs: 60_000 });
    const terminal = await appendTaskGeneration(root, task.taskId, {
      status: 'completed',
      result: { resultType: 'complete', content: [{ type: 'text', text: 'done' }] },
    });

    const collected = await collectExpiredTasks(root, {
      now: Date.parse(task.expiresAt) + 1,
    });
    expect(collected).toHaveLength(1);
    expect(collected[0]).toMatchObject({
      taskId: task.taskId,
      operationId: task.operationId,
      status: 'completed',
      generations: 2,
      terminalHash: terminal.hash,
    });
    await expect(getTask(root, task.taskId)).resolves.toBeNull();

    const auditFile = path.join(root, '.ape', 'runtime', 'tasks', '.gc', `${task.taskId}.json`);
    expect(JSON.parse(await readFile(auditFile, 'utf8'))).toEqual(collected[0]);
    await expectProtectedRegularFile(auditFile);
  });
});
