import { spawnSync } from 'node:child_process';
import { chmod, link, mkdtemp, readFile, readdir, rm, symlink, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { appendTaskGeneration, collectExpiredTasks, createOperationId, createTask, getTask,
  requestTaskCancellation, taskStorePaths } from '../lib/runtime/task-store.js';
import { executeTaskOperationTransaction, prepareTaskOperationStore, readTaskOperationTransaction,
  withReceiptLock, writeTaskOperationTransaction } from '../lib/runtime/receipt-service.js';
import { runtimePaths } from '../lib/runtime/paths.js';
import { sha256 } from '../lib/runtime/canonical.js';

const fixtures = [];
afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(fixtures.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), 'ape-task-crash-'));
  fixtures.push(root);
  return root;
}
const owner = () => ({ processId: process.pid, processStartedAt: new Date().toISOString(), instanceId: 'crash-fixture' });
const operation = () => ({ operationId: createOperationId(), action: 'next', request: { action: 'next' } });
const taskOptions = () => ({ ...operation(), owner: owner() });
const moduleUrl = (name) => new URL(`../lib/runtime/${name}.js`, import.meta.url).href;
const temporary = (target) => `${target}.12345.1700000000000.1234abcd.tmp`;

async function crashDuringWrite(root, expression, { match, checkpoint = 'before' }) {
  const script = `
    import fs from 'node:fs/promises';
    import { syncBuiltinESMExports } from 'node:module';
    const rename = fs.rename;
    fs.rename = async (source, target) => {
      if (${match}) {
        if (${JSON.stringify(checkpoint)} === 'after') await rename(source, target);
        process.exit(87);
      }
      return rename(source, target);
    };
    syncBuiltinESMExports();
    ${expression}
  `;
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    encoding: 'utf8', timeout: 15_000,
  });
  expect(child.status, child.stderr).toBe(87);
  // The child died while holding its lock. Age only this disposable lock so
  // the next call exercises the ordinary proven-dead/stale recovery path.
  const old = new Date(Date.now() - 120_000);
  for (const name of ['tasks.lock', 'receipt-effects.lock']) {
    await utimes(path.join(taskStorePaths(root).runtime, name), old, old).catch((error) => {
      if (error.code !== 'ENOENT') throw error;
    });
  }
}

describe('task journals survive process termination around atomic publication', () => {
  it.each(['before', 'after'])('recovers the last committed generation after a crash %s rename', async (checkpoint) => {
    const root = await fixture();
    const task = await createTask(root, taskOptions());
    await crashDuringWrite(root, `
      const { appendTaskGeneration } = await import(${JSON.stringify(moduleUrl('task-store'))});
      await appendTaskGeneration(${JSON.stringify(root)}, ${JSON.stringify(task.taskId)}, { statusMessage: 'updated' });
    `, { checkpoint, match: "String(target).endsWith('000001.json')" });
    const recovered = await getTask(root, task.taskId);
    expect(recovered.generation).toBe(checkpoint === 'before' ? 0 : 1);
    expect(recovered.statusMessage).toBe(checkpoint === 'before' ? null : 'updated');
    const cancelled = await requestTaskCancellation(root, task.taskId, { requester: owner() });
    expect(cancelled.cancellation).not.toBeNull();
    expect((await readdir(path.join(taskStorePaths(root).tasks, task.taskId))).every((name) => /^\d{6}\.json$/.test(name))).toBe(true);
  });

  it('recovers an interrupted task GC audit without losing the original journal prematurely', async () => {
    const root = await fixture();
    const task = await createTask(root, taskOptions());
    const collectedAt = Date.parse(task.expiresAt) + 1;
    await crashDuringWrite(root, `
      const { collectExpiredTasks } = await import(${JSON.stringify(moduleUrl('task-store'))});
      await collectExpiredTasks(${JSON.stringify(root)}, { now: ${collectedAt} });
    `, { match: `String(target).includes(${JSON.stringify(`${path.sep}.gc${path.sep}`)}) && String(target).endsWith('.json')` });
    expect((await getTask(root, task.taskId)).hash).toBe(task.hash);
    expect(await collectExpiredTasks(root, { now: collectedAt })).toHaveLength(1);
    expect(await getTask(root, task.taskId)).toBeNull();
  });

  it('does not substitute staged bytes for a missing committed generation', async () => {
    const root = await fixture();
    const task = await createTask(root, taskOptions());
    await appendTaskGeneration(root, task.taskId, { statusMessage: 'one' });
    await appendTaskGeneration(root, task.taskId, { statusMessage: 'two' });
    const directory = path.join(taskStorePaths(root).tasks, task.taskId);
    const missing = path.join(directory, '000001.json');
    await writeFile(path.join(directory, temporary('000001.json')), await readFile(missing), { mode: 0o600 });
    await rm(missing);
    await expect(getTask(root, task.taskId)).rejects.toThrow(/discontinuous/);
  });

  it.each(['unknown', 'near-match', 'hardlink', ...(process.platform === 'win32' ? [] : ['symlink', 'public-mode'])])(
    'preserves and rejects a %s entry instead of treating it as recoverable staging', async (kind) => {
      const root = await fixture();
      const task = await createTask(root, taskOptions());
      const directory = path.join(taskStorePaths(root).tasks, task.taskId);
      const sentinel = path.join(root, 'sentinel');
      await writeFile(sentinel, 'keep me', { mode: 0o600 });
      const name = kind === 'unknown' ? 'notes.json' : kind === 'near-match'
        ? '000001.json.12345.1700000000000.nothexzz.tmp' : temporary('000001.json');
      const destination = path.join(directory, name);
      if (kind === 'hardlink') await link(sentinel, destination);
      else if (kind === 'symlink') await symlink(sentinel, destination);
      else await writeFile(destination, 'keep me', { mode: kind === 'public-mode' ? 0o644 : 0o600 });
      if (kind === 'public-mode') await chmod(destination, 0o644);
      await expect(getTask(root, task.taskId)).rejects.toThrow(/unexpected|unsafe temporary/);
      expect(await readFile(sentinel, 'utf8')).toBe('keep me');
      expect(await readFile(destination, 'utf8')).toBe('keep me');
    });
});

describe('task operation crash staging never supplies effect authority', () => {
  it.each(['prepared', 'effect-committed'])('recovers a crash publishing %s without double executing an effect', async (status) => {
    const root = await fixture();
    const requested = operation();
    const marker = path.join(root, 'effect-count');
    await crashDuringWrite(root, `
      const { executeTaskOperationTransaction } = await import(${JSON.stringify(moduleUrl('receipt-service'))});
      await executeTaskOperationTransaction(${JSON.stringify(root)}, ${JSON.stringify(requested)}, async () => {
        await fs.appendFile(${JSON.stringify(marker)}, 'x'); return { ok: true };
      });
    `, { match: `String(target).endsWith('.json') && String(target).includes('task-operation-transactions') && JSON.parse(await fs.readFile(source, 'utf8')).status === ${JSON.stringify(status)}` });
    let calls = 0;
    const replay = () => executeTaskOperationTransaction(root, requested, async () => { calls += 1; return { ok: true }; });
    if (status === 'prepared') {
      await expect(replay()).resolves.toEqual({ ok: true });
      expect(calls).toBe(1);
      await expect(readFile(marker)).rejects.toMatchObject({ code: 'ENOENT' });
    } else {
      await expect(replay()).rejects.toMatchObject({ code: 'APE_TASK_OPERATION_INDETERMINATE' });
      expect(calls).toBe(0);
      expect(await readFile(marker, 'utf8')).toBe('x');
      await expect(executeTaskOperationTransaction(root, operation(), async () => ({ independent: true })))
        .resolves.toEqual({ independent: true });
    }
    expect((await readdir(path.join(taskStorePaths(root).runtime, 'task-operation-transactions')))
      .some((name) => name.endsWith('.tmp'))).toBe(false);
  });
});

describe('task journal timestamps tolerate wall-clock corrections', () => {
  it.each(['update', 'cancel'])('keeps %s readable after the clock moves backward', async (kind) => {
    const root = await fixture();
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-09-07T12:00:00.000Z'));
    const task = await createTask(root, taskOptions());
    vi.setSystemTime(new Date('2026-09-07T11:59:00.000Z'));
    const updated = kind === 'update'
      ? await appendTaskGeneration(root, task.taskId, { statusMessage: 'progress' })
      : await requestTaskCancellation(root, task.taskId, { requester: owner() });
    expect(updated.lastUpdatedAt).toBe(task.lastUpdatedAt);
    expect((await getTask(root, task.taskId)).hash).toBe(updated.hash);
    vi.setSystemTime(new Date('2026-09-07T12:01:00.000Z'));
    const later = await appendTaskGeneration(root, task.taskId, { statusMessage: 'later' });
    expect(later.lastUpdatedAt).toBe('2026-09-07T12:01:00.000Z');
    expect((await getTask(root, task.taskId)).hash).toBe(later.hash);
  });
});

describe('task producer and reader byte budgets agree', () => {
  it('replays a supported result whose pretty-printed transaction exceeded the old read limit', async () => {
    const root = await fixture();
    const requested = operation();
    const payload = Array(500_000).fill(0);
    let executions = 0;
    await expect(executeTaskOperationTransaction(root, requested, async () => { executions += 1; return payload; }))
      .resolves.toEqual(payload);
    expect((await executeTaskOperationTransaction(root, requested, async () => { executions += 1; return null; })).length)
      .toBe(payload.length);
    expect(executions).toBe(1);
  });

  it('retains the full supported poll snapshot and final result together', async () => {
    const root = await fixture();
    const paths = runtimePaths(root);
    const store = await prepareTaskOperationStore(paths);
    const requested = operation();
    const file = path.join(store.directory, `${sha256(requested.operationId)}.json`);
    await withReceiptLock(paths, async () => {
      const expected = await writeTaskOperationTransaction(file, store, {
        operation_id: requested.operationId, action: 'next', input_hash: 'a'.repeat(64),
        status: 'effect-committed', prepared_at: new Date().toISOString(),
        last_poll_result: 'p'.repeat(2 * 1_024 * 1_024 - 2),
        result: 'r'.repeat(2 * 1_024 * 1_024 - 2),
      });
      const recovered = await readTaskOperationTransaction(file, store);
      expect(recovered.record_hash).toBe(expected.record_hash);
      expect(recovered.last_poll_result).toBe(expected.last_poll_result);
      expect(recovered.result).toBe(expected.result);
    });
  });

  it('persists a schema-valid result without deep pretty-print amplification in the task journal', async () => {
    const root = await fixture();
    const task = await createTask(root, taskOptions());
    const result = { nested: { values: Array(800_000).fill(0) } };
    const completed = await appendTaskGeneration(root, task.taskId, { status: 'completed', result });
    const recovered = await getTask(root, task.taskId);
    expect(recovered.hash).toBe(completed.hash);
    expect(recovered.result.nested.values).toHaveLength(800_000);
  });
});
