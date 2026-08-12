import { randomBytes } from 'node:crypto';
import { lstat, mkdir, readFile, readdir, realpath, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import { hashRecord, sha256 } from './canonical.js';
import { withDirLock } from './lock.js';
import {
  TASK_TERMINAL_STATUSES,
  TaskCancellationRequestSchema,
  TaskGcRecordSchema,
  TaskGenerationPatchSchema,
  TaskGenerationSchema,
  TaskIdSchema,
  TaskOperationIdSchema,
  TaskOwnerSchema,
} from './schemas.js';
import { atomicWriteJson } from './storage.js';

const TASK_LOCK_OPTIONS = Object.freeze({
  staleMs: 30_000,
  heartbeatMs: 5_000,
  busyMs: 5_000,
  serializeLocal: true,
  busyMessage: 'APE durable task store is busy; retry the task request',
});
const DEFAULT_TTL_MS = 24 * 60 * 60_000;
const DEFAULT_POLL_INTERVAL_MS = 1_000;
const MAX_GENERATION_FILE_BYTES = 8 * 1_024 * 1_024;
const MAX_TASK_GENERATIONS = 1_025;
const MAX_TASK_DIRECTORIES = 4_096;
const MAX_GC_AUDIT_RECORDS = 4_096;
const GC_AUDIT_RETENTION_MS = 7 * 24 * 60 * 60_000;
const HASH_PLACEHOLDER = '0'.repeat(64);
const GENERATION_FILE_PATTERN = /^(\d{6})\.json$/;

const TERMINAL = new Set(TASK_TERMINAL_STATUSES);
const TRANSITIONS = Object.freeze({
  working: new Set(['working', 'input_required', 'completed', 'failed', 'cancelled']),
  input_required: new Set(['input_required', 'working', 'completed', 'failed', 'cancelled']),
});

// Node exposes POSIX permission bits on every platform, but on Windows they
// are synthesized from the read-only attribute (a freshly created 0600 file
// commonly reports as 0666). Windows access isolation is supplied by the
// inherited NTFS ACL, which Node's mode API cannot inspect or reproduce.
// Enforce owner-only mode where it is meaningful; on Windows retain the
// regular-file, no-symlink, bounded-size, schema, root-binding, and hash-chain
// checks instead of rejecting every journal the runtime just wrote itself.
function hasUnsafePosixMode(metadata) {
  return process.platform !== 'win32' && (metadata.mode & 0o077) !== 0;
}

export class TaskStoreError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'TaskStoreError';
    this.code = code;
  }
}

export function createTaskId() {
  return `task-${randomBytes(32).toString('base64url')}`;
}

export function createOperationId() {
  return `op-${randomBytes(32).toString('base64url')}`;
}

export function isTaskId(value) {
  return TaskIdSchema.safeParse(value).success;
}

export function isTaskOperationId(value) {
  return TaskOperationIdSchema.safeParse(value).success;
}

// Kept private to the MCP task layer instead of widening runtimePaths: tasks
// are an extension-owned journal, not run/receipt authority.
export function taskStorePaths(root) {
  const governedRoot = path.resolve(root);
  const runtime = path.join(governedRoot, '.ape', 'runtime');
  const tasks = path.join(runtime, 'tasks');
  return Object.freeze({
    root: governedRoot,
    runtime,
    tasks,
    gc: path.join(tasks, '.gc'),
    lock: path.join(runtime, 'tasks.lock'),
  });
}

async function ensurePrivateDirectory(directory) {
  try {
    const metadata = await lstat(directory);
    if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
      throw new TaskStoreError('unsafe_store_path', `APE task store path is not a private directory: ${directory}`);
    }
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
    try {
      await mkdir(directory, { mode: 0o700 });
    } catch (mkdirError) {
      // Store preparation precedes tasks-lock acquisition, so two first-use
      // callers can both observe ENOENT. Verify the EEXIST winner instead of
      // rejecting a safe concurrent initialization.
      if (mkdirError?.code !== 'EEXIST') throw mkdirError;
      const metadata = await lstat(directory);
      if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
        throw new TaskStoreError('unsafe_store_path', `APE task store path is not a private directory: ${directory}`);
      }
    }
  }
}

async function prepareStore(root) {
  if (typeof root !== 'string' || root.length === 0) {
    throw new TaskStoreError('invalid_root', 'APE task store requires a governed project root');
  }
  let canonicalRoot;
  try {
    canonicalRoot = await realpath(path.resolve(root));
  } catch (error) {
    throw new TaskStoreError('invalid_root', `APE governed project root is unavailable: ${error.message}`);
  }
  const paths = taskStorePaths(canonicalRoot);
  await ensurePrivateDirectory(path.join(canonicalRoot, '.ape'));
  await ensurePrivateDirectory(paths.runtime);
  await ensurePrivateDirectory(paths.tasks);
  await ensurePrivateDirectory(paths.gc);

  // A pre-planted symlink at any extension-owned level would move state out
  // of the governed root.  Resolve the final directory as a second check so a
  // concurrently changed ancestor fails closed as well.
  if (await realpath(paths.tasks) !== paths.tasks || await realpath(paths.gc) !== paths.gc) {
    throw new TaskStoreError('unsafe_store_path', 'APE task store resolves outside its governed private path');
  }
  try {
    const lockMetadata = await lstat(paths.lock);
    if (lockMetadata.isSymbolicLink() || !lockMetadata.isDirectory()) {
      throw new TaskStoreError('unsafe_store_path', 'APE task lock path is not a private directory');
    }
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
  return { paths, rootBinding: sha256(`ape-task-root-v1:${canonicalRoot}`) };
}

async function withTaskLock(root, callback) {
  const prepared = await prepareStore(root);
  return withPreparedTaskLock(prepared, callback);
}

async function withPreparedTaskLock(prepared, callback) {
  return withDirLock(prepared.paths.lock, () => callback(prepared), TASK_LOCK_OPTIONS);
}

function taskDirectory(paths, taskId) {
  if (!isTaskId(taskId)) {
    throw new TaskStoreError('invalid_task_id', 'APE task id is malformed');
  }
  return path.join(paths.tasks, taskId);
}

function generationFile(directory, generation) {
  return path.join(directory, `${String(generation).padStart(6, '0')}.json`);
}

function finalizeGeneration(value) {
  const materialized = TaskGenerationSchema.parse({ ...value, hash: HASH_PLACEHOLDER });
  return TaskGenerationSchema.parse({ ...materialized, hash: hashRecord(materialized, ['hash']) });
}

function finalizeGcRecord(value) {
  const materialized = TaskGcRecordSchema.parse({ ...value, hash: HASH_PLACEHOLDER });
  return TaskGcRecordSchema.parse({ ...materialized, hash: hashRecord(materialized, ['hash']) });
}

async function parseGenerationFile(file) {
  const metadata = await lstat(file);
  if (
    !metadata.isFile()
    || metadata.isSymbolicLink()
    || hasUnsafePosixMode(metadata)
    || metadata.size > MAX_GENERATION_FILE_BYTES
  ) {
    throw new TaskStoreError('corrupt_task', `APE task generation is unsafe or oversized: ${path.basename(file)}`);
  }
  let raw;
  try {
    raw = JSON.parse(await readFile(file, 'utf8'));
  } catch (error) {
    throw new TaskStoreError('corrupt_task', `APE task generation is unreadable: ${error.message}`);
  }
  const parsed = TaskGenerationSchema.safeParse(raw);
  if (!parsed.success) {
    throw new TaskStoreError('corrupt_task', `APE task generation schema failed: ${parsed.error.message}`);
  }
  if (hashRecord(parsed.data, ['hash']) !== parsed.data.hash) {
    throw new TaskStoreError('corrupt_task', 'APE task generation hash mismatch');
  }
  return parsed.data;
}

function validateGenerationSequence(records, rootBinding, expectedTaskId) {
  let previous = null;
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index];
    if (record.rootBinding !== rootBinding || record.taskId !== expectedTaskId) {
      throw new TaskStoreError('root_binding_mismatch', 'APE task journal belongs to a different governed root or task');
    }
    const expectedPreviousHash = index === 0 ? null : previous.hash;
    if (record.generation !== index || record.previousHash !== expectedPreviousHash) {
      throw new TaskStoreError('corrupt_task', 'APE task journal generation chain is discontinuous');
    }
    if (index === 0) {
      if (record.status !== 'working' || record.result !== null || record.error !== null || record.cancellation !== null) {
        throw new TaskStoreError('corrupt_task', 'APE task generation zero is not a valid working task');
      }
    } else {
      for (const field of [
        'rootBinding', 'taskId', 'operationId', 'action', 'createdAt', 'expiresAt',
        'ttlMs', 'pollIntervalMs', 'request', 'owner',
      ]) {
        if (JSON.stringify(record[field]) !== JSON.stringify(previous[field])) {
          throw new TaskStoreError('corrupt_task', `APE task immutable field changed: ${field}`);
        }
      }
      if (!TRANSITIONS[previous.status]?.has(record.status)) {
        throw new TaskStoreError('corrupt_task', `APE task has an invalid ${previous.status} to ${record.status} transition`);
      }
      if (Date.parse(record.lastUpdatedAt) < Date.parse(previous.lastUpdatedAt)) {
        throw new TaskStoreError('corrupt_task', 'APE task update timestamps moved backwards');
      }
      if (previous.cancellation && JSON.stringify(record.cancellation) !== JSON.stringify(previous.cancellation)) {
        throw new TaskStoreError('corrupt_task', 'APE task cancellation request was changed after persistence');
      }
    }
    if (record.status === 'completed' && record.result === null) {
      throw new TaskStoreError('corrupt_task', 'APE completed task has no durable tool result');
    }
    if (record.status !== 'completed' && record.result !== null) {
      throw new TaskStoreError('corrupt_task', 'APE non-completed task carries a tool result');
    }
    if (record.status === 'failed' && record.error === null) {
      throw new TaskStoreError('corrupt_task', 'APE failed task has no durable JSON-RPC error');
    }
    if (record.status !== 'failed' && record.error !== null) {
      throw new TaskStoreError('corrupt_task', 'APE non-failed task carries a JSON-RPC error');
    }
    if (record.status === 'cancelled' && record.cancellation === null) {
      throw new TaskStoreError('corrupt_task', 'APE cancelled task has no durable cancellation request');
    }
    if (record.cancellation !== null && TERMINAL.has(record.status) && record.status !== 'cancelled') {
      throw new TaskStoreError('corrupt_task', 'APE task completed after a durable cancellation request');
    }
    if (record.status !== 'input_required' && record.inputRequests.length > 0) {
      throw new TaskStoreError('corrupt_task', 'APE task carries input requests outside input_required');
    }
    previous = record;
  }
}

async function readTaskLocked(prepared, taskId) {
  const directory = taskDirectory(prepared.paths, taskId);
  let entries;
  try {
    const directoryMetadata = await lstat(directory);
    if (!directoryMetadata.isDirectory() || directoryMetadata.isSymbolicLink()) {
      throw new TaskStoreError('corrupt_task', 'APE task journal path is not a private directory');
    }
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
  const names = entries.map((entry) => entry.name).sort();
  if (
    names.length === 0
    || names.length > MAX_TASK_GENERATIONS
    || entries.some((entry) => !entry.isFile() || entry.isSymbolicLink() || !GENERATION_FILE_PATTERN.test(entry.name))
  ) {
    throw new TaskStoreError('corrupt_task', 'APE task journal contains unexpected or excessive entries');
  }
  const numbered = names.map((name) => Number(GENERATION_FILE_PATTERN.exec(name)[1]));
  if (numbered.some((number, index) => number !== index)) {
    throw new TaskStoreError('corrupt_task', 'APE task journal generation filenames are discontinuous');
  }
  const records = [];
  for (const name of names) records.push(await parseGenerationFile(path.join(directory, name)));
  validateGenerationSequence(records, prepared.rootBinding, taskId);
  return records.at(-1);
}

async function writeNewGeneration(directory, generation) {
  const file = generationFile(directory, generation.generation);
  if (Buffer.byteLength(JSON.stringify(generation, null, 2), 'utf8') > MAX_GENERATION_FILE_BYTES) {
    throw new TaskStoreError('task_too_large', 'APE task generation exceeds the durable file bound');
  }
  try {
    await lstat(file);
    throw new TaskStoreError('generation_exists', 'APE task generation already exists');
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
  await atomicWriteJson(file, generation);
}

function publicTask(record) {
  // Return a detached plain object so callers cannot mutate any value retained
  // by an in-process validation path.  The service may strip internal fields
  // when forming the protocol result, while recovery keeps all of them.
  return JSON.parse(JSON.stringify(record));
}

export async function createTask(root, {
  operationId,
  action,
  request,
  owner,
  ttlMs = DEFAULT_TTL_MS,
  pollIntervalMs = DEFAULT_POLL_INTERVAL_MS,
  statusMessage = null,
}) {
  const parsedOperationId = TaskOperationIdSchema.parse(operationId);
  const parsedOwner = TaskOwnerSchema.parse(owner);
  const prepared = await prepareStore(root);

  // Generation zero is fully materialized and fsynced in a same-volume
  // staging directory before taking the global task-store lock. On Windows,
  // serializing that durable write behind one lock makes a supported burst of
  // task creation wait on Defender/file-flush latency once per caller. The
  // short locked section below performs only the exact capacity check and an
  // atomic directory rename, so readers can observe either no task or a
  // complete journal—never an empty/partial directory.
  for (let attempt = 0; attempt < 16; attempt += 1) {
    const taskId = createTaskId();
    const directory = taskDirectory(prepared.paths, taskId);
    const stagingDirectory = path.join(prepared.paths.runtime, `.task-create.${taskId}`);
    let stagingCreated = false;
    let installed = false;
    try {
      try {
        await mkdir(stagingDirectory, { mode: 0o700 });
        stagingCreated = true;
      } catch (error) {
        if (error?.code === 'EEXIST') continue;
        throw error;
      }
      const now = Date.now();
      const timestamp = new Date(now).toISOString();
      const generation = finalizeGeneration({
        schemaVersion: 1,
        rootBinding: prepared.rootBinding,
        taskId,
        operationId: parsedOperationId,
        action,
        generation: 0,
        status: 'working',
        statusMessage,
        createdAt: timestamp,
        lastUpdatedAt: timestamp,
        expiresAt: new Date(now + ttlMs).toISOString(),
        ttlMs,
        pollIntervalMs,
        request,
        owner: parsedOwner,
        inputRequests: [],
        result: null,
        error: null,
        cancellation: null,
        lastAcknowledgedInput: null,
        previousHash: null,
      });
      await writeNewGeneration(stagingDirectory, generation);

      const committed = await withPreparedTaskLock(prepared, async () => {
        if ((await taskDirectoryNames(prepared.paths)).length >= MAX_TASK_DIRECTORIES) {
          throw new TaskStoreError('store_capacity', 'APE task store reached its bounded live-task capacity');
        }
        try {
          await lstat(directory);
          return false;
        } catch (error) {
          if (error?.code !== 'ENOENT') throw error;
        }
        await rename(stagingDirectory, directory);
        installed = true;
        return true;
      });
      if (committed) return publicTask(generation);
    } finally {
      if (stagingCreated && !installed) {
        await rm(stagingDirectory, { recursive: true, force: true }).catch(() => {});
      }
    }
  }
  throw new TaskStoreError('id_collision', 'APE could not mint a unique task id');
}

export async function getTask(root, taskId) {
  return withTaskLock(root, async (prepared) => {
    const record = await readTaskLocked(prepared, taskId);
    return record ? publicTask(record) : null;
  });
}

async function appendTaskGenerationLocked(prepared, taskId, rawPatch) {
  const patch = TaskGenerationPatchSchema.parse(rawPatch);
  const { expectedGeneration, allowedStatuses, ...changes } = patch;
  const current = await readTaskLocked(prepared, taskId);
  if (!current) return null;
  if (TERMINAL.has(current.status)) {
    throw new TaskStoreError('task_terminal', `APE task is already ${current.status}`);
  }
  if (expectedGeneration !== undefined && expectedGeneration !== current.generation) {
    throw new TaskStoreError('generation_conflict', 'APE task generation changed before the update committed');
  }
  if (allowedStatuses && !allowedStatuses.includes(current.status)) {
    throw new TaskStoreError('status_conflict', `APE task status ${current.status} does not admit this update`);
  }
  const nextStatus = patch.status ?? current.status;
  if (!TRANSITIONS[current.status]?.has(nextStatus)) {
    throw new TaskStoreError('invalid_transition', `APE task cannot transition from ${current.status} to ${nextStatus}`);
  }
  if (current.cancellation && TERMINAL.has(nextStatus) && nextStatus !== 'cancelled') {
    throw new TaskStoreError('cancellation_pending', 'APE task cancellation won the terminal-result race');
  }
  const nextResult = nextStatus === 'completed' ? (patch.result ?? current.result) : null;
  const nextError = nextStatus === 'failed' ? (patch.error ?? current.error) : null;
  if (nextStatus === 'completed' && nextResult === null) {
    throw new TaskStoreError('invalid_result', 'APE completed task requires a durable tool result');
  }
  if (nextStatus === 'failed' && nextError === null) {
    throw new TaskStoreError('invalid_error', 'APE failed task requires a durable JSON-RPC error');
  }
  if (nextStatus === 'cancelled' && current.cancellation === null) {
    throw new TaskStoreError('invalid_cancellation', 'APE task must persist a cancellation request before cancellation');
  }
  const next = finalizeGeneration({
    ...current,
    ...changes,
    generation: current.generation + 1,
    status: nextStatus,
    lastUpdatedAt: new Date().toISOString(),
    result: nextResult,
    error: nextError,
    inputRequests: patch.inputRequests ?? (nextStatus === 'input_required' ? current.inputRequests : []),
    previousHash: current.hash,
    hash: HASH_PLACEHOLDER,
  });
  const directory = taskDirectory(prepared.paths, taskId);
  await writeNewGeneration(directory, next);
  return publicTask(next);
}

export async function appendTaskGeneration(root, taskId, patch) {
  return withTaskLock(root, (prepared) => appendTaskGenerationLocked(prepared, taskId, patch));
}

export async function requestTaskCancellation(root, taskId, request) {
  const parsed = TaskCancellationRequestSchema.parse(request);
  return withTaskLock(root, async (prepared) => {
    const current = await readTaskLocked(prepared, taskId);
    if (!current || TERMINAL.has(current.status) || current.cancellation) {
      return current ? publicTask(current) : null;
    }
    const cancellation = {
      requestedAt: new Date().toISOString(),
      requester: parsed.requester,
      reason: parsed.reason ?? null,
    };
    const next = finalizeGeneration({
      ...current,
      generation: current.generation + 1,
      statusMessage: parsed.reason ?? 'cancellation requested',
      lastUpdatedAt: cancellation.requestedAt,
      cancellation,
      previousHash: current.hash,
      hash: HASH_PLACEHOLDER,
    });
    await writeNewGeneration(taskDirectory(prepared.paths, taskId), next);
    return publicTask(next);
  });
}

export async function acknowledgeTaskUpdate(root, taskId, input) {
  const parsedInput = TaskGenerationPatchSchema.parse({ lastAcknowledgedInput: input }).lastAcknowledgedInput;
  if (parsedInput === undefined) throw new TaskStoreError('invalid_update', 'APE task update input is required');
  return withTaskLock(root, async (prepared) => {
    const current = await readTaskLocked(prepared, taskId);
    if (!current) return null;
    if (TERMINAL.has(current.status)) return publicTask(current);
    return appendTaskGenerationLocked(prepared, taskId, {
      expectedGeneration: current.generation,
      allowedStatuses: ['working', 'input_required'],
      lastAcknowledgedInput: parsedInput,
    });
  });
}

async function taskDirectoryNames(paths) {
  const entries = await readdir(paths.tasks, { withFileTypes: true });
  const names = [];
  for (const entry of entries) {
    if (entry.name === '.gc' && entry.isDirectory() && !entry.isSymbolicLink()) continue;
    if (!entry.isDirectory() || entry.isSymbolicLink() || !isTaskId(entry.name)) {
      throw new TaskStoreError('corrupt_store', `APE task store contains an unexpected entry: ${entry.name}`);
    }
    names.push(entry.name);
  }
  return names.sort();
}

async function readGcRecord(file, prepared) {
  let raw;
  try {
    const metadata = await lstat(file);
    if (
      !metadata.isFile()
      || metadata.isSymbolicLink()
      || hasUnsafePosixMode(metadata)
      || metadata.size > 64 * 1_024
    ) {
      throw new TaskStoreError('corrupt_store', 'APE task GC audit is unsafe or oversized');
    }
    raw = JSON.parse(await readFile(file, 'utf8'));
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw new TaskStoreError('corrupt_store', `APE task GC audit is unreadable: ${error.message}`);
  }
  const parsed = TaskGcRecordSchema.safeParse(raw);
  if (
    !parsed.success
    || parsed.data.rootBinding !== prepared.rootBinding
    || hashRecord(parsed.data, ['hash']) !== parsed.data.hash
  ) {
    throw new TaskStoreError('corrupt_store', 'APE task GC audit validation failed');
  }
  return parsed.data;
}

async function pruneGcAudits(prepared, timestamp) {
  const entries = await readdir(prepared.paths.gc, { withFileTypes: true });
  const records = [];
  for (const entry of entries) {
    if (!entry.isFile() || entry.isSymbolicLink() || !/^task-[A-Za-z0-9_-]{43}\.json$/.test(entry.name)) {
      throw new TaskStoreError('corrupt_store', `APE task GC store contains an unexpected entry: ${entry.name}`);
    }
    const file = path.join(prepared.paths.gc, entry.name);
    const record = await readGcRecord(file, prepared);
    records.push({ file, record });
  }
  const retained = [];
  for (const entry of records) {
    if (Date.parse(entry.record.collectedAt) + GC_AUDIT_RETENTION_MS <= timestamp) {
      await rm(entry.file, { force: true });
    } else {
      retained.push(entry);
    }
  }
  retained.sort((left, right) => Date.parse(left.record.collectedAt) - Date.parse(right.record.collectedAt));
  for (const entry of retained.slice(0, Math.max(0, retained.length - MAX_GC_AUDIT_RECORDS))) {
    await rm(entry.file, { force: true });
  }
}

export async function collectExpiredTasks(root, { now = Date.now(), limit = 100 } = {}) {
  const timestamp = Number(now);
  if (!Number.isFinite(timestamp) || !Number.isFinite(new Date(timestamp).getTime())) {
    throw new TaskStoreError('invalid_time', 'APE task GC time is invalid');
  }
  if (!Number.isFinite(limit)) throw new TaskStoreError('invalid_limit', 'APE task GC limit is invalid');
  const boundedLimit = Math.max(1, Math.min(1_000, Math.trunc(limit)));
  return withTaskLock(root, async (prepared) => {
    await pruneGcAudits(prepared, timestamp);
    const collected = [];
    for (const taskId of await taskDirectoryNames(prepared.paths)) {
      if (collected.length >= boundedLimit) break;
      const current = await readTaskLocked(prepared, taskId);
      if (Date.parse(current.expiresAt) > timestamp) continue;
      const audit = finalizeGcRecord({
        schemaVersion: 1,
        rootBinding: prepared.rootBinding,
        taskId,
        operationId: current.operationId,
        status: current.status,
        generations: current.generation + 1,
        createdAt: current.createdAt,
        expiredAt: current.expiresAt,
        collectedAt: new Date(timestamp).toISOString(),
        terminalHash: current.hash,
      });
      const auditFile = path.join(prepared.paths.gc, `${taskId}.json`);
      const existing = await readGcRecord(auditFile, prepared);
      if (existing) {
        if (existing.terminalHash !== audit.terminalHash || existing.taskId !== taskId) {
          throw new TaskStoreError('corrupt_store', 'APE task GC audit conflicts with the journal terminal hash');
        }
      } else {
        await atomicWriteJson(auditFile, audit);
      }
      // Audit-before-remove makes an interrupted collection decidable: a
      // surviving audit names the exact chain tail whose directory may remain.
      await rm(taskDirectory(prepared.paths, taskId), { recursive: true, force: true });
      collected.push(publicTask(existing ?? audit));
    }
    await pruneGcAudits(prepared, timestamp);
    return collected;
  });
}

export async function listOwnedTasks(root, owner) {
  const parsedOwner = TaskOwnerSchema.parse(owner);
  return withTaskLock(root, async (prepared) => {
    const owned = [];
    for (const taskId of await taskDirectoryNames(prepared.paths)) {
      const current = await readTaskLocked(prepared, taskId);
      if (
        !TERMINAL.has(current.status)
        && current.owner.processId === parsedOwner.processId
        && current.owner.processStartedAt === parsedOwner.processStartedAt
        && current.owner.instanceId === parsedOwner.instanceId
      ) {
        owned.push(publicTask(current));
      }
    }
    return owned;
  });
}
