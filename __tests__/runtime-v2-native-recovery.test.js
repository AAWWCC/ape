import { fork } from 'node:child_process';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { runtimePaths } from '../lib/runtime/paths.js';
import { withReceiptLock } from '../lib/runtime/receipt-service.js';
import { atomicWriteJson } from '../lib/runtime/storage.js';
import { getTask } from '../lib/runtime/task-store.js';

// No filesystem, process, clock, or service mocks. Each worker below is an
// ordinary Node process, isolated from Vitest's module cache and globals.
// The synthetic charged effect writes only inside its disposable directory;
// no workflow, host agent, remote service, or real gate command is started.
const scratches = [];
const workers = [];
const moduleUrl = (relative) => JSON.stringify(new URL(relative, import.meta.url).href);
const WORKER = `
import { randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createTask, createOperationId, getTask, appendTaskGeneration } from ${moduleUrl('../lib/runtime/task-store.js')};
import { executeTaskOperationTransaction } from ${moduleUrl('../lib/runtime/receipt-service.js')};
import { atomicWriteJson } from ${moduleUrl('../lib/runtime/storage.js')};
import { executeToolCall, handle, shutdownOwnedTasks } from ${moduleUrl('../bin/ape-mcp.mjs')};

const [mode, root] = process.argv.slice(2);
const meta = {
  'io.modelcontextprotocol/protocolVersion': '2026-07-28',
  'io.modelcontextprotocol/clientCapabilities': { extensions: { 'io.modelcontextprotocol/tasks': {} } },
};
const owner = { processId: process.pid, processStartedAt: new Date().toISOString(), instanceId: randomUUID() };
const send = (value) => new Promise((resolve, reject) => process.send(value, (error) => error ? reject(error) : resolve()));
const taskCall = (method, taskId) => handle({ jsonrpc: '2.0', id: 2, method,
  params: { project_dir: root, taskId, _meta: meta } });
const intentFile = path.join(root, 'intent.json');
const effectFile = path.join(root, 'charged-effect.json');
const expected = { resultType: 'complete', content: [{ type: 'text', text: 'exact durable fixture result' }] };

try {
  if (mode === 'cancel') {
    // Register before advertising task creation so the parent's cancel frame
    // cannot race listener installation.
    const cancel = new Promise((resolve) => process.once('message', resolve));
    const response = await executeToolCall({ jsonrpc: '2.0', id: 1, method: 'tools/call',
      params: { name: 'ape_run', arguments: { project_dir: root, action: 'regate' }, _meta: meta } });
    await send({ type: 'created', response, pid: process.pid });
    await cancel;
    const cancelled = await taskCall('tasks/cancel', response.result.taskId);
    await send({ type: 'cancel-returned' });
    await shutdownOwnedTasks('native fixture finished');
    await send({ type: 'cancelled', response: cancelled, task: await getTask(root, response.result.taskId) });
    process.disconnect();
  } else if (mode.startsWith('prepare-')) {
    const operation = { operationId: createOperationId(), action: 'regate', request: { action: 'regate', reason: 'disposable restart fixture' } };
    const task = await createTask(root, { ...operation, owner });
    await atomicWriteJson(intentFile, { operation, taskId: task.taskId });
    let effectError = null;
    try {
      await executeTaskOperationTransaction(root, operation, async () => {
        await atomicWriteJson(effectFile, { charges: 1, owner });
        if (mode === 'prepare-indeterminate') throw new Error('fixture failed after its durable effect');
        return expected;
      });
    } catch (error) {
      effectError = error.message;
    }
    // The transaction's receipt lease has been released, but no task result
    // has been published. The parent forcibly ends this process here.
    process.on('message', () => {});
    await send({ type: 'prepared', taskId: task.taskId, owner, effectError, expected });
  } else if (mode === 'cancel-restarted') {
    const { taskId } = JSON.parse(await readFile(intentFile, 'utf8'));
    const before = await getTask(root, taskId);
    const response = await taskCall('tasks/cancel', taskId);
    await send({ type: 'cancelled', owner, before, response, task: await getTask(root, taskId),
      wireAfter: await taskCall('tasks/get', taskId) });
    process.disconnect();
  } else if (mode === 'recover') {
    const { operation, taskId } = JSON.parse(await readFile(intentFile, 'utf8'));
    const before = await getTask(root, taskId);
    const wireBefore = await taskCall('tasks/get', taskId);
    let result = null;
    let error = null;
    try {
      result = await executeTaskOperationTransaction(root, operation, async () => {
        // Persist proof if recovery ever enters the charged callback again.
        await writeFile(path.join(root, 'duplicate-effect'), 'effect called twice');
        return { charged: 'again' };
      });
      await appendTaskGeneration(root, taskId, {
        expectedGeneration: before.generation, allowedStatuses: ['working'], status: 'completed', result,
      });
    } catch (cause) {
      error = { code: cause.code, message: cause.message };
      await appendTaskGeneration(root, taskId, {
        expectedGeneration: before.generation, allowedStatuses: ['working'], status: 'failed',
        error: { code: -32603, message: cause.message },
      });
    }
    await send({ type: 'recovered', owner, before, wireBefore, result, error,
      task: await getTask(root, taskId), wireAfter: await taskCall('tasks/get', taskId) });
    process.disconnect();
  } else {
    throw new Error('unknown fixture mode: ' + mode);
  }
} catch (error) {
  await send({ type: 'fatal', message: error.stack ?? String(error) }).catch(() => {});
  process.exitCode = 1;
  process.disconnect?.();
}
`;

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(check, description, timeoutMs = 25_000) {
  const deadline = Date.now() + timeoutMs;
  do {
    const value = await check();
    if (value) return value;
    await delay(25);
  } while (Date.now() < deadline);
  throw new Error(`Timed out waiting for ${description}`);
}

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), 'ape-native-recovery-'));
  scratches.push(root);
  await writeFile(path.join(root, 'worker.mjs'), WORKER);
  return root;
}

function startWorker(root, mode) {
  const env = { ...process.env };
  delete env.CLAUDE_PROJECT_DIR;
  delete env.CODEX_CWD;
  const child = fork(path.join(root, 'worker.mjs'), [mode, root], {
    cwd: root, env, execPath: process.execPath, execArgv: [], silent: true,
  });
  const messages = [];
  const worker = { child, messages, stderr: '', exited: false, exit: null };
  worker.exit = new Promise((resolve) => child.once('close', (code, signal) => {
    worker.exited = true;
    resolve({ code, signal });
  }));
  child.on('message', (message) => messages.push(message));
  child.on('error', (error) => messages.push({ type: 'fatal', message: error.message }));
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk) => { worker.stderr = (worker.stderr + chunk).slice(-16_384); });
  child.stdout.resume();
  workers.push(worker);
  return worker;
}

async function messageFrom(worker, type) {
  return waitFor(() => {
    const fatal = worker.messages.find((message) => message.type === 'fatal');
    if (fatal) throw new Error(fatal.message);
    const message = worker.messages.find((entry) => entry.type === type);
    if (!message && worker.exited) throw new Error(`Fixture exited before ${type}: ${worker.stderr}`);
    return message;
  }, `fixture message ${type}`).catch((error) => {
    throw new Error(`${error.message}; observed messages: ${worker.messages.map((entry) => entry.type).join(', ')}; stderr: ${worker.stderr}`, { cause: error });
  });
}

async function stopWorker(worker) {
  // Only the exact child handle created by this test is signalled. These
  // fixture workers never spawn descendants or own host-agent processes.
  if (!worker.exited) worker.child.kill('SIGKILL');
  await waitFor(() => worker.exited, 'fixture process exit');
  return worker.exit;
}

afterEach(async () => {
  await Promise.all(workers.splice(0).map(stopWorker));
  await Promise.all(scratches.splice(0).map((root) => rm(root, {
    recursive: true, force: true, maxRetries: 10, retryDelay: 100,
  })));
}, 60_000);

describe('native filesystem task recovery across process boundaries', () => {
  it.each(['committed', 'indeterminate'])('preserves the %s effect boundary after actual process loss', async (boundary) => {
    const root = await fixture();
    const original = startWorker(root, `prepare-${boundary}`);
    const prepared = await messageFrom(original, 'prepared');
    expect(prepared.effectError).toBe(boundary === 'indeterminate' ? 'fixture failed after its durable effect' : null);
    expect((await getTask(root, prepared.taskId)).status).toBe('working');
    await stopWorker(original);

    const restarted = startWorker(root, 'recover');
    const recovered = await messageFrom(restarted, 'recovered');
    await waitFor(() => restarted.exited, 'restarted fixture exit');
    expect(await restarted.exit).toEqual({ code: 0, signal: null });
    expect(recovered.owner.instanceId).not.toBe(prepared.owner.instanceId);
    expect(recovered.before).toMatchObject({ status: 'working', generation: 0, owner: prepared.owner });
    expect(recovered.wireBefore.result).toMatchObject({ resultType: 'complete', status: 'working' });
    expect(recovered.task).toMatchObject({ generation: 1, previousHash: recovered.before.hash, owner: prepared.owner });
    expect(JSON.parse(await readFile(path.join(root, 'charged-effect.json'), 'utf8'))).toEqual({ charges: 1, owner: prepared.owner });
    expect(await readdir(root)).not.toContain('duplicate-effect');
    if (boundary === 'committed') {
      expect(recovered.error).toBeNull();
      expect(recovered.result).toEqual(prepared.expected);
      expect(recovered.task).toMatchObject({ status: 'completed', result: prepared.expected });
      expect(recovered.wireAfter.result).toMatchObject({ status: 'completed', result: prepared.expected });
    } else {
      expect(recovered.result).toBeNull();
      expect(recovered.error).toMatchObject({ code: 'APE_TASK_OPERATION_INDETERMINATE' });
      expect(recovered.task).toMatchObject({ status: 'failed', error: { code: -32603, message: recovered.error.message } });
      expect(recovered.wireAfter.result).toMatchObject({ status: 'failed', error: recovered.task.error });
    }
  }, 60_000);

  it.each(['run-before', 'run-after'])('cancellation through another process preserves a foreign watch in %s', async (nextRunId) => {
    const root = await fixture();
    const paths = runtimePaths(root);
    await mkdir(paths.runtime, { recursive: true });
    const before = { schema_version: '2.0.0', run_id: 'run-before', status: 'running', stage: 'test', mode: 'phase', lane: 'fast', host: 'codex', tickets: [], receipts: [] };
    await atomicWriteJson(paths.active, before);
    let release;
    let acquired;
    const ready = new Promise((resolve) => { acquired = resolve; });
    const held = withReceiptLock(paths, async () => {
      acquired();
      await new Promise((resolve) => { release = resolve; });
    });
    await ready;
    try {
      const worker = startWorker(root, 'cancel');
      const created = await messageFrom(worker, 'created');
      expect(created.response.result.resultType).toBe('task');
      const taskId = created.response.result.taskId;
      expect((await getTask(root, taskId)).owner.processId).toBe(created.pid);

      // Another authorized effect changes the selector while the task must
      // wait for this real cross-process receipt lease. A foreign host and
      // null PID ensure the fixture never grants authority to signal anyone.
      const watch = { pid: null, host: 'fixture.invalid', started_at: new Date().toISOString(), nonce: 'another-effect',
        job_file: path.join(paths.runtime, 'foreign-job.json'), artifact_file: path.join(paths.runtime, 'foreign-artifact.json'), heartbeat_file: path.join(paths.runtime, 'foreign-heartbeat.json') };
      const files = [watch.job_file, watch.artifact_file, watch.heartbeat_file];
      for (const file of files) await writeFile(file, 'other operation fixture');
      const current = { ...before, run_id: nextRunId, status: 'gating', stage: 'gates', gates_watch: watch };
      await atomicWriteJson(paths.active, current);
      worker.child.send({ action: 'cancel' });
      // The durable cancellation generation is the synchronization barrier;
      // there are no service observers, fake timers, or scheduler guesses.
      const cancellation = await waitFor(async () => {
        const task = await getTask(root, taskId);
        return task?.cancellation ? task : null;
      }, 'durable cancellation before effect admission');
      expect(cancellation.status).toBe('working');
      release();
      await held;
      const cancelled = await messageFrom(worker, 'cancelled');
      await waitFor(() => worker.exited, 'cancel fixture exit');
      expect(await worker.exit).toEqual({ code: 0, signal: null });
      expect(cancelled.response.result).toEqual({ resultType: 'complete' });
      expect(cancelled.task).toMatchObject({ status: 'cancelled', cancellation: cancellation.cancellation });
      expect(JSON.parse(await readFile(paths.active, 'utf8'))).toEqual(current);
      for (const file of files) expect(await readFile(file, 'utf8')).toBe('other operation fixture');
    } finally {
      release?.();
      await held;
    }
  }, 60_000);

  it('cancels a dead owner’s durable task after restart without adopting the current gate watch', async () => {
    const root = await fixture();
    const original = startWorker(root, 'prepare-committed');
    const prepared = await messageFrom(original, 'prepared');
    expect(prepared.effectError).toBeNull();
    await stopWorker(original);

    const paths = runtimePaths(root);
    const watch = { pid: null, host: 'fixture.invalid', nonce: 'new-owner', started_at: new Date().toISOString(),
      job_file: path.join(paths.runtime, 'new-job.json'), artifact_file: path.join(paths.runtime, 'new-artifact.json'), heartbeat_file: path.join(paths.runtime, 'new-heartbeat.json') };
    const files = [watch.job_file, watch.artifact_file, watch.heartbeat_file];
    for (const file of files) await writeFile(file, 'new owner fixture');
    const active = { run_id: 'new-run', gates_watch: watch };
    await atomicWriteJson(paths.active, active);

    const restarted = startWorker(root, 'cancel-restarted');
    const cancelled = await messageFrom(restarted, 'cancelled');
    await waitFor(() => restarted.exited, 'restarted cancellation fixture exit');
    expect(await restarted.exit).toEqual({ code: 0, signal: null });
    expect(cancelled.before).toMatchObject({ status: 'working', owner: prepared.owner });
    expect(cancelled.owner.instanceId).not.toBe(prepared.owner.instanceId);
    expect(cancelled.response.result).toEqual({ resultType: 'complete' });
    expect(cancelled.task).toMatchObject({ status: 'cancelled', owner: prepared.owner,
      cancellation: { requester: { processId: cancelled.owner.processId }, reason: 'client requested task cancellation' } });
    expect(cancelled.wireAfter.result).toMatchObject({ status: 'cancelled' });
    expect(JSON.parse(await readFile(paths.active, 'utf8'))).toEqual(active);
    expect(JSON.parse(await readFile(path.join(root, 'charged-effect.json'), 'utf8'))).toEqual({ charges: 1, owner: prepared.owner });
    for (const file of files) expect(await readFile(file, 'utf8')).toBe('new owner fixture');
  }, 60_000);
});
