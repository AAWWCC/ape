import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

const faults = vi.hoisted(() => ({ cancel: null, terminal: null, effects: 0 }));
vi.mock('../lib/runtime/task-store.js', async (original) => {
  const actual = await original();
  return { ...actual,
    requestTaskCancellation: async (...args) => {
      await faults.cancel?.(...args);
      return actual.requestTaskCancellation(...args);
    },
    appendTaskGeneration: async (...args) => {
      if (args[2]?.status === 'cancelled') await faults.terminal?.(...args);
      return actual.appendTaskGeneration(...args);
    },
  };
});
vi.mock('../lib/runtime/service.js', async (original) => {
  const actual = await original();
  return { ...actual, executeApeRunTaskOperation: (...args) => {
    faults.effects += 1;
    return actual.executeApeRunTaskOperation(...args);
  } };
});
import { executeToolCall, shutdownOwnedTasks } from '../bin/ape-mcp.mjs';
import { getTask } from '../lib/runtime/task-store.js';

const meta = {
  'io.modelcontextprotocol/protocolVersion': '2026-07-28',
  'io.modelcontextprotocol/clientCapabilities': { extensions: { 'io.modelcontextprotocol/tasks': {} } },
};
const roots = [];
const timers = [];
afterEach(async () => {
  faults.cancel = null;
  faults.terminal = null;
  faults.effects = 0;
  for (const timer of timers.splice(0)) clearTimeout(timer);
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

async function createParkedTasks(count = 1) {
  const callbacks = [];
  const nativeTimeout = globalThis.setTimeout;
  const spy = vi.spyOn(globalThis, 'setTimeout').mockImplementation((fn, ms, ...args) => {
    if (ms !== 0) return nativeTimeout(fn, ms, ...args);
    callbacks.push(() => fn(...args));
    const timer = nativeTimeout(() => {}, 60_000);
    timers.push(timer);
    return timer;
  });
  const tasks = [];
  try {
    for (let index = 0; index < count; index += 1) {
      const root = await realpath(await mkdtemp(path.join(tmpdir(), 'ape-shutdown-store-')));
      roots.push(root);
      await mkdir(path.join(root, '.ape'));
      const response = await executeToolCall({ jsonrpc: '2.0', id: index + 1, method: 'tools/call', params: {
        name: 'ape_run', arguments: { action: 'regate', project_dir: root }, _meta: meta,
      } });
      expect(response.result.resultType).toBe('task');
      tasks.push({ root, id: response.result.taskId });
    }
  } finally { spy.mockRestore(); }
  expect(callbacks).toHaveLength(count);
  return { tasks, callbacks };
}

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

describe('MCP shutdown isolates cancellation persistence failures', () => {
  it('finishes deferred cleanup and cancels another root when terminal publication fails', async () => {
    const { tasks: [broken, healthy] } = await createParkedTasks(2);
    faults.terminal = (root) => {
      if (root === broken.root) throw Object.assign(new Error('private failure detail'), { code: 'EIO' });
    };
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    await shutdownOwnedTasks('test terminal failure');
    const preserved = await getTask(broken.root, broken.id);
    expect(preserved.status).toBe('working');
    expect(preserved.cancellation).toBeTruthy();
    expect((await getTask(healthy.root, healthy.id)).status).toBe('cancelled');
    expect(stderr.mock.calls.flat().join('')).toContain('ape_task_terminal_persistence_failed');
    expect(stderr.mock.calls.flat().join('')).not.toContain('private failure detail');
    expect(faults.effects).toBe(0);
  });

  it('stops an unentered task without inventing cancelled state when the request cannot persist', async () => {
    const { tasks: [broken, healthy] } = await createParkedTasks(2);
    faults.cancel = (root) => {
      if (root === broken.root) throw Object.assign(new Error('injected request failure'), { code: 'EIO' });
    };
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    await shutdownOwnedTasks('test request failure');
    expect(await getTask(broken.root, broken.id)).toMatchObject({ status: 'working', generation: 0 });
    expect((await getTask(healthy.root, healthy.id)).status).toBe('cancelled');
    expect(faults.effects).toBe(0);
  });

  it('gives every runner its cancellation promise before the first store waits', async () => {
    const { tasks: [first, second], callbacks } = await createParkedTasks(2);
    const firstEntered = deferred();
    const releaseFirst = deferred();
    const secondRequested = deferred();
    faults.cancel = async (root) => {
      if (root === first.root) { firstEntered.resolve(); await releaseFirst.promise; }
      if (root === second.root) secondRequested.resolve();
    };
    const shutdown = shutdownOwnedTasks('test independent roots');
    try {
      await firstEntered.promise;
      // A separate store is requested without waiting for the held first one.
      await secondRequested.promise;
      await callbacks[1]();
      expect((await getTask(second.root, second.id)).status).toBe('cancelled');
      expect(faults.effects).toBe(0);
    } finally { releaseFirst.resolve(); await shutdown; }
    expect((await getTask(first.root, first.id)).status).toBe('cancelled');
  });
});
