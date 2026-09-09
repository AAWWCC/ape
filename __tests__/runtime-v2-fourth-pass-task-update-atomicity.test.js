import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { appendTaskGeneration, createOperationId, createTask, getTask } from '../lib/runtime/task-store.js';

const fixtures = [];
afterEach(async () => {
  await Promise.all(fixtures.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), 'ape-fourth-task-update-'));
  fixtures.push(root);
  const task = await createTask(root, {
    operationId: createOperationId(), action: 'next', request: { action: 'next' },
    owner: { processId: process.pid, processStartedAt: new Date().toISOString(), instanceId: 'fourth-pass-fixture' },
  });
  return { root, task, directory: path.join(root, '.ape', 'runtime', 'tasks', task.taskId) };
}

describe('fourth-pass task update publication invariants', () => {
  it.each([
    { status: 'working' },
    { status: 'completed', result: { content: [] } },
    { status: 'failed', error: { code: -32603, message: 'fixture error' } },
  ])('refuses input requests outside input_required before committing $status', async (patch) => {
    const { root, task, directory } = await fixture();
    await expect(appendTaskGeneration(root, task.taskId, {
      ...patch, inputRequests: [{ prompt: 'continue?' }],
    })).rejects.toMatchObject({ code: 'invalid_input_requests' });
    expect(await readdir(directory)).toEqual(['000000.json']);
    expect(await getTask(root, task.taskId)).toEqual(task);
    const completed = await appendTaskGeneration(root, task.taskId, { status: 'completed', result: { content: [] } });
    expect(await getTask(root, task.taskId)).toEqual(completed);
  });

  it('preserves input-required updates and clears their requests when resuming', async () => {
    const { root, task } = await fixture();
    const awaiting = await appendTaskGeneration(root, task.taskId, {
      status: 'input_required', inputRequests: [{ prompt: 'continue?' }],
    });
    expect(await getTask(root, task.taskId)).toEqual(awaiting);
    const resumed = await appendTaskGeneration(root, task.taskId, { status: 'working' });
    expect(resumed.inputRequests).toEqual([]);
    expect(await getTask(root, task.taskId)).toEqual(resumed);
  });
});
