import path from 'node:path';
import { lstat, mkdir, readFile, readdir, realpath, rm } from 'node:fs/promises';
import { GATE_NEXT_MAX_WAIT_MS, GATE_NEXT_POLL_FLOOR_MS } from './constants.js';
import { runtimePaths } from './paths.js';
import { atomicWriteJson } from './storage.js';
import { withDirLock } from './lock.js';
import {
  TaskOperationGcRecordSchema,
  TaskOperationIdSchema,
  TaskOperationTransactionSchema,
} from './schemas.js';
import { hashRecord, sha256 } from './canonical.js';

function now() {
  return new Date().toISOString();
}

const RECEIPT_LOCK_STALE_MS = 60_000;
const RECEIPT_LOCK_HEARTBEAT_MS = 15_000;
const RECEIPT_LOCK_BUSY_MS = 15_000;

// Serializes every writer of receipt effects (receipt recording, abort,
// override) behind one on-disk lock. Staleness is judged by the lock's mtime,
// and the critical section legitimately runs for minutes (a full-suite gate
// run) — the remote-checks watch is no longer held here at all: it is now a
// bounded, resumable per-`next` poll (poll_shipping) that rests the run in
// 'shipping' between slices rather than parking this lock for the whole watch.
// A live holder refreshes a heartbeat on the lock, so only a genuinely dead
// holder — one whose heartbeat stopped — is stolen (F9).
// The steal/release protocol (rename tombstone + owner token) lives in the
// shared withDirLock so two contenders can never both enter (invariant 7).
// Exported for tests only; production callers go through the service API.
export async function withReceiptLock(paths, callback, options = {}) {
  return withDirLock(paths.receiptLock, callback, {
    staleMs: options.staleMs ?? RECEIPT_LOCK_STALE_MS,
    heartbeatMs: options.heartbeatMs ?? RECEIPT_LOCK_HEARTBEAT_MS,
    busyMs: options.busyMs ?? RECEIPT_LOCK_BUSY_MS,
    serializeLocal: true,
    busyMessage: options.busyMessage ?? 'receipt effects are busy; retry the identical receipt',
  });
}

// MCP Tasks are durable independently of the process that executes them, but
// the APE effects they wrap are still serialized by receipt-effects.lock. The
// operation journal closes the response-loss window: once an effect returned,
// its exact service result is written before it is exposed to the task store.
// A replay of an effect-committed operation returns those bytes as data and
// never charges the underlying lever a second time.
const TASK_OPERATION_TTL_MS = 7 * 24 * 60 * 60_000;
const TASK_OPERATION_MAX_BYTES = 3 * 1_024 * 1_024;
const TASK_OPERATION_MAX_LIVE_RECORDS = 4_096;
const TASK_OPERATION_MAX_GC_AUDITS = 4_096;
const TASK_OPERATION_GC_RETENTION_MS = 7 * 24 * 60 * 60_000;
const TASK_OPERATION_HASH_PLACEHOLDER = '0'.repeat(64);

function taskOperationStorePaths(paths) {
  const directory = path.join(paths.runtime, 'task-operation-transactions');
  return {
    directory,
    gc: path.join(directory, '.gc'),
  };
}

function taskOperationTransactionPath(paths, operationId) {
  return path.join(taskOperationStorePaths(paths).directory, `${sha256(operationId)}.json`);
}

async function ensurePrivateTaskOperationDirectory(directory) {
  try {
    const metadata = await lstat(directory);
    if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
      throw new Error(`APE task operation store path is unsafe: ${directory}`);
    }
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
    try {
      await mkdir(directory, { mode: 0o700 });
    } catch (mkdirError) {
      if (mkdirError?.code !== 'EEXIST') throw mkdirError;
      const metadata = await lstat(directory);
      if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
        throw new Error(`APE task operation store path is unsafe: ${directory}`);
      }
    }
  }
}

async function prepareGovernedRuntimeAncestor(paths) {
  const canonicalRoot = await realpath(paths.root);
  const apeDirectory = path.join(paths.root, '.ape');
  const expectedApe = path.join(canonicalRoot, '.ape');
  await ensurePrivateTaskOperationDirectory(apeDirectory);
  const apeMetadata = await lstat(apeDirectory);
  if (apeMetadata.isSymbolicLink() || await realpath(apeDirectory) !== expectedApe) {
    throw new Error('APE state path resolves outside the governed private path');
  }
  await ensurePrivateTaskOperationDirectory(paths.runtime);
  const runtimeMetadata = await lstat(paths.runtime);
  const expectedRuntime = path.join(expectedApe, 'runtime');
  if (
    runtimeMetadata.isSymbolicLink()
    || !runtimeMetadata.isDirectory()
    || await realpath(paths.runtime) !== expectedRuntime
  ) {
    throw new Error('APE runtime path resolves outside the governed private path');
  }
  return canonicalRoot;
}

async function prepareTaskOperationStore(paths) {
  const store = taskOperationStorePaths(paths);
  const canonicalRoot = await prepareGovernedRuntimeAncestor(paths);
  // Only create extension-owned descendants after the existing runtime
  // ancestor is proven in-root; a planted parent symlink must have no effect.
  await ensurePrivateTaskOperationDirectory(store.directory);
  await ensurePrivateTaskOperationDirectory(store.gc);
  const expectedDirectory = path.join(canonicalRoot, '.ape', 'runtime', 'task-operation-transactions');
  if (
    await realpath(store.directory) !== expectedDirectory
    || await realpath(store.gc) !== path.join(expectedDirectory, '.gc')
  ) {
    throw new Error('APE task operation store resolves outside the governed private path');
  }
  return { ...store, rootBinding: sha256(`ape-task-operation-root-v1:${canonicalRoot}`) };
}

function finalizeTaskOperationTransaction(record, rootBinding) {
  const materialized = TaskOperationTransactionSchema.parse({
    ...record,
    version: 1,
    root_binding: rootBinding,
    expected_run_id: record.expected_run_id ?? null,
    expires_at: record.expires_at ?? new Date(Date.now() + TASK_OPERATION_TTL_MS).toISOString(),
    record_hash: TASK_OPERATION_HASH_PLACEHOLDER,
  });
  return TaskOperationTransactionSchema.parse({
    ...materialized,
    record_hash: hashRecord(materialized, ['record_hash']),
  });
}

function finalizeTaskOperationGcRecord(record, rootBinding) {
  const materialized = TaskOperationGcRecordSchema.parse({
    ...record,
    version: 1,
    root_binding: rootBinding,
    record_hash: TASK_OPERATION_HASH_PLACEHOLDER,
  });
  return TaskOperationGcRecordSchema.parse({
    ...materialized,
    record_hash: hashRecord(materialized, ['record_hash']),
  });
}

async function readBoundedTaskOperationJson(file, schema, rootBinding, label) {
  let raw;
  try {
    const metadata = await lstat(file);
    if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size > TASK_OPERATION_MAX_BYTES) {
      throw new Error(`${label} is unsafe or oversized`);
    }
    raw = JSON.parse(await readFile(file, 'utf8'));
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
  const parsed = schema.safeParse(raw);
  if (
    !parsed.success
    || parsed.data.root_binding !== rootBinding
    || hashRecord(parsed.data, ['record_hash']) !== parsed.data.record_hash
  ) {
    throw new Error(`${label} failed root, schema, or hash validation`);
  }
  return parsed.data;
}

async function readTaskOperationTransaction(file, store) {
  return readBoundedTaskOperationJson(
    file,
    TaskOperationTransactionSchema,
    store.rootBinding,
    'APE task operation transaction',
  );
}

async function writeTaskOperationTransaction(file, store, record) {
  const finalized = finalizeTaskOperationTransaction(record, store.rootBinding);
  await atomicWriteJson(file, finalized);
  return finalized;
}

async function pruneTaskOperationGc(store, timestamp) {
  const entries = await readdir(store.gc, { withFileTypes: true });
  const retained = [];
  for (const entry of entries) {
    if (!entry.isFile() || entry.isSymbolicLink() || !/^[0-9a-f]{64}\.json$/.test(entry.name)) {
      throw new Error(`APE task operation GC store contains an unexpected entry: ${entry.name}`);
    }
    const file = path.join(store.gc, entry.name);
    const record = await readBoundedTaskOperationJson(
      file,
      TaskOperationGcRecordSchema,
      store.rootBinding,
      'APE task operation GC record',
    );
    if (Date.parse(record.collected_at) + TASK_OPERATION_GC_RETENTION_MS <= timestamp) {
      await rm(file, { force: true });
    } else {
      retained.push({ file, record });
    }
  }
  retained.sort((left, right) => Date.parse(left.record.collected_at) - Date.parse(right.record.collected_at));
  for (const entry of retained.slice(0, Math.max(0, retained.length - TASK_OPERATION_MAX_GC_AUDITS))) {
    await rm(entry.file, { force: true });
  }
}

async function collectExpiredTaskOperationTransactions(paths, store, timestamp = Date.now()) {
  await pruneTaskOperationGc(store, timestamp);
  const entries = await readdir(store.directory, { withFileTypes: true });
  let retained = 0;
  for (const entry of entries) {
    if (entry.name === '.gc' && entry.isDirectory() && !entry.isSymbolicLink()) continue;
    if (!entry.isFile() || entry.isSymbolicLink() || !/^[0-9a-f]{64}\.json$/.test(entry.name)) {
      throw new Error(`APE task operation store contains an unexpected entry: ${entry.name}`);
    }
    const file = path.join(store.directory, entry.name);
    const transaction = await readTaskOperationTransaction(file, store);
    if (Date.parse(transaction.expires_at) > timestamp) {
      retained += 1;
      continue;
    }
    const audit = finalizeTaskOperationGcRecord({
      operation_id: transaction.operation_id,
      action: transaction.action,
      status: transaction.status,
      transaction_hash: transaction.record_hash,
      expired_at: transaction.expires_at,
      collected_at: new Date(timestamp).toISOString(),
    }, store.rootBinding);
    await atomicWriteJson(path.join(store.gc, entry.name), audit);
    await rm(file, { force: true });
  }
  await pruneTaskOperationGc(store, timestamp);
  return retained;
}

export function taskToolError(cause) {
  return { task_tool_error: cause?.message ?? String(cause) };
}

export async function executeTaskOperationTransaction(projectDir, operation, effect) {
  const paths = runtimePaths(projectDir);
  const operationId = operation?.operationId;
  if (!TaskOperationIdSchema.safeParse(operationId).success) {
    throw new Error('task operation requires a valid operationId');
  }
  const inputHash = sha256(JSON.stringify({
    action: operation.action,
    request: operation.request,
    expected_run_id: operation.expectedRunId ?? null,
    preflight_refusal: operation.preflightRefusal ?? null,
  }));
  const transactionFile = taskOperationTransactionPath(paths, operationId);
  await prepareGovernedRuntimeAncestor(paths);
  return withReceiptLock(paths, async () => {
    const store = await prepareTaskOperationStore(paths);
    const retainedTransactions = await collectExpiredTaskOperationTransactions(paths, store);
    const existing = await readTaskOperationTransaction(transactionFile, store);
    if (existing) {
      if (existing.input_hash !== inputHash) {
        throw new Error(`task operation ${operationId} was replayed with different input`);
      }
      if (existing.status === 'effect-committed') {
        return existing.result;
      }
      // A process died after the durable prepare. We cannot prove whether its
      // charged effect ran, so recovery is fail-closed: never guess by running
      // it again. The task records this as a JSON-RPC execution failure.
      const error = Object.assign(
        new Error(`task operation ${operationId} has an indeterminate prepared transaction; refusing to rerun its charged effect`),
        { code: 'APE_TASK_OPERATION_INDETERMINATE' },
      );
      throw error;
    }
    if (retainedTransactions >= TASK_OPERATION_MAX_LIVE_RECORDS) {
      throw new Error('APE task operation store reached its bounded live-transaction capacity');
    }
    let prepared = await writeTaskOperationTransaction(transactionFile, store, {
      version: 1,
      operation_id: operationId,
      action: operation.action,
      input_hash: inputHash,
      expected_run_id: operation.expectedRunId ?? null,
      status: 'prepared',
      prepared_at: now(),
    });
    // effect MUST be a lock-free internal service body. Keeping it in this
    // callback is what makes a concurrent identical operation wait and replay,
    // rather than observe `prepared` and double-charge.
    const value = operation.isCancelled?.()
      ? taskToolError(new Error('task cancellation requested before effect start'))
      : await effect(paths);
    prepared = await writeTaskOperationTransaction(transactionFile, store, {
      ...prepared,
      status: 'effect-committed',
      result: value,
      effect_committed_at: now(),
    });
    return value;
  }, { busyMessage: 'receipt effects are busy; retry the task operation' });
}

// Both injected callbacks are lock-free service bodies. They are called while
// receipt-effects.lock is held so state binding, the charged NEXT transition,
// and the durable poll journal remain one serialized transaction. Keeping the
// callbacks injected avoids a task-operations -> service import cycle.
export async function executeNextTaskOperation(projectDir, operation, {
  taskOperationRunBindingRefusal,
  nextRunLocked,
}) {
  const paths = runtimePaths(projectDir);
  const operationId = operation.operationId;
  if (!TaskOperationIdSchema.safeParse(operationId).success) {
    throw new Error('task operation requires a valid operationId');
  }
  const inputHash = sha256(JSON.stringify({
    action: operation.action,
    request: operation.request,
    expected_run_id: operation.expectedRunId ?? null,
    preflight_refusal: operation.preflightRefusal ?? null,
  }));
  const transactionFile = taskOperationTransactionPath(paths, operationId);
  await prepareGovernedRuntimeAncestor(paths);
  const requestedWait = operation.request?.wait_ms;
  // A task-created gate crossing keeps polling even when the legacy caller did
  // not request an in-call wait. It remains bounded by the same public maximum.
  const waitMs = Number.isFinite(requestedWait) && requestedWait > 0
    ? Math.min(requestedWait, GATE_NEXT_MAX_WAIT_MS)
    : GATE_NEXT_MAX_WAIT_MS;
  let operationStore = null;
  let collectedExpired = false;
  let retainedTransactions = 0;
  while (true) {
    const step = await withReceiptLock(paths, async () => {
      operationStore ??= await prepareTaskOperationStore(paths);
      if (!collectedExpired) {
        retainedTransactions = await collectExpiredTaskOperationTransactions(paths, operationStore);
        collectedExpired = true;
      }
      let transaction = await readTaskOperationTransaction(transactionFile, operationStore);
      if (transaction && transaction.input_hash !== inputHash) {
        throw new Error(`task operation ${operationId} was replayed with different input`);
      }
      if (transaction?.status === 'effect-committed') {
        return { done: true, result: transaction.result };
      }
      if (transaction?.poll_state === 'polling') {
        const error = Object.assign(
          new Error(`task operation ${operationId} stopped during a gate poll; refusing to rerun an uncertain charged transition`),
          { code: 'APE_TASK_OPERATION_INDETERMINATE' },
        );
        throw error;
      }
      if (!transaction) {
        if (retainedTransactions >= TASK_OPERATION_MAX_LIVE_RECORDS) {
          throw new Error('APE task operation store reached its bounded live-transaction capacity');
        }
        const startedAt = now();
        transaction = await writeTaskOperationTransaction(transactionFile, operationStore, {
          version: 1,
          operation_id: operationId,
          action: operation.action,
          input_hash: inputHash,
          expected_run_id: operation.expectedRunId ?? null,
          status: 'prepared',
          poll_state: 'ready',
          prepared_at: startedAt,
          deadline_at: new Date(Date.parse(startedAt) + waitMs).toISOString(),
        });
      }
      if (operation.isCancelled?.()) {
        const value = taskToolError(new Error('task cancellation requested before gate poll'));
        await writeTaskOperationTransaction(transactionFile, operationStore, {
          ...transaction,
          status: 'effect-committed',
          poll_state: 'ready',
          result: value,
          effect_committed_at: now(),
        });
        return { done: true, result: value };
      }
      if (operation.preflightRefusal) {
        await writeTaskOperationTransaction(transactionFile, operationStore, {
          ...transaction,
          status: 'effect-committed',
          poll_state: 'ready',
          result: operation.preflightRefusal,
          effect_committed_at: now(),
        });
        return { done: true, result: operation.preflightRefusal };
      }
      const bindingRefusal = await taskOperationRunBindingRefusal(paths, operation.expectedRunId);
      if (bindingRefusal) {
        await writeTaskOperationTransaction(transactionFile, operationStore, {
          ...transaction,
          status: 'effect-committed',
          poll_state: 'ready',
          result: bindingRefusal,
          effect_committed_at: now(),
        });
        return { done: true, result: bindingRefusal };
      }
      transaction = await writeTaskOperationTransaction(transactionFile, operationStore, {
        ...transaction,
        poll_state: 'polling',
        poll_started_at: now(),
      });
      let value;
      try {
        value = await nextRunLocked(paths);
      } catch (cause) {
        value = taskToolError(cause);
        await writeTaskOperationTransaction(transactionFile, operationStore, {
          ...transaction,
          status: 'effect-committed',
          poll_state: 'ready',
          result: value,
          effect_committed_at: now(),
        });
        return { done: true, result: value };
      }
      const pending = value.ok && value.actions?.find(
        (entry) => entry.type === 'gating_pending' || entry.type === 'shipping_pending',
      );
      if (!pending || Date.now() >= Date.parse(transaction.deadline_at)) {
        await writeTaskOperationTransaction(transactionFile, operationStore, {
          ...transaction,
          status: 'effect-committed',
          poll_state: 'ready',
          result: value,
          effect_committed_at: now(),
        });
        return { done: true, result: value };
      }
      await writeTaskOperationTransaction(transactionFile, operationStore, {
        ...transaction,
        poll_state: 'ready',
        last_poll_result: value,
        last_poll_committed_at: now(),
      });
      return {
        done: false,
        sleepMs: Math.min(
          Math.max(GATE_NEXT_POLL_FLOOR_MS, pending.retry_after_ms ?? 0),
          Math.max(0, Date.parse(transaction.deadline_at) - Date.now()),
        ),
      };
    }, { busyMessage: 'receipt effects are busy; retry the task gate poll' });
    if (step.done) return step.result;
    if (step.sleepMs > 0) await new Promise((resolve) => setTimeout(resolve, step.sleepMs));
  }
}
