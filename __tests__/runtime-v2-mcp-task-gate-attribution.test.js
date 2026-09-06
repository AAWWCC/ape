import { describe, it, expect, vi } from 'vitest';
import { access, chmod, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

const observer = vi.hoisted(() => ({ entered: null, effect: null, collect: null }));
vi.mock('../lib/runtime/receipt-service.js', async (original) => {
  const actual = await original();
  return { ...actual, applyActions: (...args) => observer.effect
    ? observer.effect(...args) : actual.applyActions(...args) };
});
vi.mock('../lib/runtime/service.js', async (original) => {
  const actual = await original();
  return { ...actual, executeApeRunTaskOperation: (...args) => {
    observer.entered?.();
    return actual.executeApeRunTaskOperation(...args);
  } };
});
vi.mock('../lib/runtime/task-store.js', async (original) => {
  const actual = await original();
  return { ...actual, collectExpiredTasks: async (...args) => {
    await observer.collect?.();
    return actual.collectExpiredTasks(...args);
  } };
});
import { executeToolCall, handle, shutdownOwnedTasks } from '../bin/ape-mcp.mjs';
import { withReceiptLock } from '../lib/runtime/receipt-service.js';
import { runtimePaths } from '../lib/runtime/paths.js';
import { atomicWriteJson } from '../lib/runtime/storage.js';
import { getTask } from '../lib/runtime/task-store.js';

const meta = {
  'io.modelcontextprotocol/protocolVersion': '2026-07-28',
  'io.modelcontextprotocol/clientCapabilities': { extensions: { 'io.modelcontextprotocol/tasks': {} } },
};

async function waitForTask(root, taskId, predicate) {
  const deadline = Date.now() + 10_000;
  do {
    const task = await getTask(root, taskId);
    if (predicate(task)) return task;
    await new Promise((resolve) => setTimeout(resolve, 10));
  } while (Date.now() < deadline);
  throw new Error('task did not reach the required durable synchronization barrier');
}

describe('task gate attribution stays inside its charged service effect', () => {
  it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)('preserves an active-state permission error before creating a task', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'ape-task-state-permission-'));
    const paths = runtimePaths(root);
    await mkdir(paths.runtime, { recursive: true });
    await atomicWriteJson(paths.active, { run_id: 'run-unreadable', tickets: [], receipts: [] });
    await chmod(paths.active, 0);
    try {
      const response = await executeToolCall({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'ape_run', arguments: { project_dir: root, action: 'regate' }, _meta: meta } });
      expect(response.result).toMatchObject({ resultType: 'complete', isError: true });
      expect(response.result.content[0].text).toMatch(/EACCES/);
      expect(response.result.content[0].text).not.toMatch(/no active run/);
      await expect(access(path.join(paths.runtime, 'tasks'))).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      await chmod(paths.active, 0o600);
      await rm(root, { recursive: true, force: true });
    }
  });

  it.each(['run-after', 'run-before'])('preserves another operation’s watch in %s when cancellation preceded the effect', async (nextRunId) => {
    const root = await mkdtemp(path.join(tmpdir(), 'ape-task-watch-owner-'));
    const paths = runtimePaths(root);
    await mkdir(paths.runtime, { recursive: true });
    const state = { schema_version: '2.0.0', run_id: 'run-before', status: 'running', stage: 'test', mode: 'phase', lane: 'fast', host: 'codex', tickets: [], receipts: [] };
    await atomicWriteJson(paths.active, state);
    let release;
    let entered;
    const enteredPromise = new Promise((resolve) => { entered = resolve; });
    const held = withReceiptLock(paths, async () => {
      entered();
      await new Promise((resolve) => { release = resolve; });
    });
    await enteredPromise;
    const observedPromise = new Promise((resolve) => { observer.entered = resolve; });
    try {
      const response = await executeToolCall({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'ape_run', arguments: { project_dir: root, action: 'regate' }, _meta: meta } });
      expect(response.result.resultType).toBe('task');
      await observedPromise;
      // This is another effect's persisted state while the cancelled task is
      // still waiting for the receipt lock. The foreign host prevents signals.
      const watch = { pid: 999999, host: 'synthetic.invalid', started_at: '2026-09-06T02:00:00.000Z', nonce: 'another-operation', job_file: path.join(paths.runtime, 'foreign-job.json'), artifact_file: path.join(paths.runtime, 'foreign-artifact.json'), heartbeat_file: path.join(paths.runtime, 'foreign-heartbeat.json') };
      const files = [watch.job_file, watch.artifact_file, watch.heartbeat_file];
      for (const file of files) await writeFile(file, 'foreign gate fixture');
      await atomicWriteJson(paths.active, { ...state, run_id: nextRunId, status: 'gating', stage: 'gates', gates_watch: watch });
      const cancellation = handle({ jsonrpc: '2.0', id: 2, method: 'tasks/cancel', params: { project_dir: root, taskId: response.result.taskId, _meta: meta } });
      // Calling handle starts asynchronous collection before cancellation is
      // registered. Keep the effect locked until the cancellation is durable.
      const requested = await waitForTask(root, response.result.taskId, (task) => task?.cancellation);
      expect(requested.status).toBe('working');
      release();
      await held;
      await cancellation;
      await shutdownOwnedTasks('test teardown');

      expect((await getTask(root, response.result.taskId)).status).toBe('cancelled');
      expect(JSON.parse(await readFile(paths.active, 'utf8'))).toMatchObject({ run_id: nextRunId, gates_watch: watch });
      for (const file of files) expect(await readFile(file, 'utf8')).toBe('foreign gate fixture');
    } finally {
      observer.entered = null;
      release?.();
      await held;
      await shutdownOwnedTasks('test teardown');
      await rm(root, { recursive: true, force: true });
    }
  });

  it.each([
    { name: 'cleans its own persisted watch when a later effect step throws before cancellation settles', late: false },
    { name: 'preserves a completed error result when cancellation registration is delayed until after terminal publication', late: true },
  ])('$name', async ({ late }) => {
    const root = await mkdtemp(path.join(tmpdir(), 'ape-task-watch-fault-'));
    const paths = runtimePaths(root);
    await mkdir(paths.runtime, { recursive: true });
    await atomicWriteJson(paths.active, { schema_version: '2.0.0', run_id: 'run-owned', status: 'blocked', stage: 'gates', mode: 'phase', lane: 'fast', host: 'codex', tickets: [], receipts: [] });
    const watch = { pid: 999999, host: 'synthetic.invalid', started_at: '2026-09-06T02:00:00.000Z', nonce: 'owned-effect', job_file: path.join(paths.runtime, 'owned-job.json'), artifact_file: path.join(paths.runtime, 'owned-artifact.json'), heartbeat_file: path.join(paths.runtime, 'owned-heartbeat.json') };
    const files = [watch.job_file, watch.artifact_file, watch.heartbeat_file];
    let persisted;
    const persistedPromise = new Promise((resolve) => { persisted = resolve; });
    let release;
    const released = new Promise((resolve) => { release = resolve; });
    let registerCancellation;
    observer.effect = async (heldPaths, state) => {
      for (const file of files) await writeFile(file, 'owned gate fixture');
      await atomicWriteJson(heldPaths.active, { ...state, status: 'gating', gates_watch: watch });
      persisted();
      await released;
      throw new Error('synthetic failure after watch persistence');
    };
    try {
      const response = await executeToolCall({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'ape_run', arguments: { project_dir: root, action: 'regate' }, _meta: meta } });
      expect(response.result.resultType).toBe('task');
      await persistedPromise;
      let collectionEntered;
      const collecting = new Promise((resolve) => { collectionEntered = resolve; });
      if (late) {
        const registrationGate = new Promise((resolve) => { registerCancellation = resolve; });
        // Reproduce the former test race deterministically: tasks/cancel has
        // started, but its real collection call has not admitted cancellation.
        observer.collect = async () => { collectionEntered(); await registrationGate; };
      }
      const cancellation = handle({ jsonrpc: '2.0', id: 2, method: 'tasks/cancel', params: { project_dir: root, taskId: response.result.taskId, _meta: meta } });
      if (late) {
        await collecting;
        release();
        const completed = await waitForTask(root, response.result.taskId, (task) => task?.status === 'completed');
        expect(completed.result).toMatchObject({ resultType: 'complete', isError: true });
        expect(completed.cancellation).toBeNull();
        observer.collect = null;
        registerCancellation();
      } else {
        const requested = await waitForTask(root, response.result.taskId, (task) => task?.cancellation);
        expect(requested.status).toBe('working');
        release();
      }
      await cancellation;
      await shutdownOwnedTasks('test teardown');

      const final = await getTask(root, response.result.taskId);
      expect(final.status).toBe(late ? 'completed' : 'cancelled');
      if (late) expect(final.cancellation).toBeNull();
      expect(JSON.parse(await readFile(paths.active, 'utf8')).run_id).toBe('run-owned');
      for (const file of files) {
        if (late) expect(await readFile(file, 'utf8')).toBe('owned gate fixture');
        else await expect(readFile(file)).rejects.toMatchObject({ code: 'ENOENT' });
      }
    } finally {
      observer.collect = null;
      registerCancellation?.();
      release();
      await shutdownOwnedTasks('test teardown');
      observer.effect = null;
      await rm(root, { recursive: true, force: true });
    }
  });
});
