import { mapInBatches } from './collections.js';
import { createHash, randomUUID } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import { promisify } from 'node:util';
import { gzip, gunzip } from 'node:zlib';
import path from 'node:path';
import {
  link,
  mkdir,
  open,
  readdir,
  realpath,
  rm,
} from 'node:fs/promises';
import { TERMINAL_STATUSES } from './constants.js';
import { appendJsonLine, atomicWriteJson, syncDirectory } from './storage.js';
import { inspectRunLock } from './lock.js';
import { lstatFile, statFileHandle } from './file-stats.js';
import { validateGovernedRuntimeAncestor } from './paths.js';
import { RUNTIME_STATE_MAX_BYTES } from './resource-limits.js';

const gzipAsync = promisify(gzip);
const gunzipAsync = promisify(gunzip);
const SAFE_RUN_ID = /^run-[A-Za-z0-9_-]{1,128}$/;
const DEFAULT_KEEP_RECENT_RUNS = 32;
const DEFAULT_MAX_RUNS_PER_SWEEP = 16;
const MAX_FAILURES_PER_SWEEP = 16;
const FAILURE_REASON_MAX_CHARS = 320;
const RETENTION_STATUS_MAX_BYTES = 32 * 1024;
// Compaction is optional: preserve larger runs loose instead of making an
// unbounded archive/decompression allocation or removing unarchived bytes.
const ARCHIVE_EXPANDED_MAX_BYTES = 64 * 1024 * 1024;
const ARCHIVE_COMPRESSED_MAX_BYTES = ARCHIVE_EXPANDED_MAX_BYTES + 1024 * 1024;
const INVENTORY_FIELDS = ['history_files_read', 'history_bytes_read', 'artifact_files_read', 'artifact_bytes_read'];
const ARTIFACT_DIRECTORIES = Object.freeze({
  run: 'runs', ticket: 'tickets', receipt: 'receipts', 'receipt-transaction': 'receipt-transactions',
});

function artifactRelativePath(kind, file) {
  const directory = Object.hasOwn(ARTIFACT_DIRECTORIES, kind) ? ARTIFACT_DIRECTORIES[kind] : null;
  if (!directory || typeof file !== 'string' || !/^[^/\\\u0000-\u001f]+\.json$/u.test(file) ||
      file === '.json' || file === '..json') throw new Error('invalid retention artifact path or kind');
  return `${directory}/${file}`;
}

function validateArtifactMember(artifact, bytes, runId) {
  if (typeof artifact?.path !== 'string' ||
      artifact.path !== artifactRelativePath(artifact.kind, artifact.path.split('/').at(-1))) {
    throw new Error(`artifact archive member has an invalid kind or path for ${runId}`);
  }
  let value;
  try { value = JSON.parse(bytes.toString('utf8')); }
  catch { throw new Error(`artifact archive member is not JSON for ${runId}`); }
  if (!value || typeof value !== 'object' || Array.isArray(value) || value.run_id !== runId ||
      (artifact.kind === 'receipt-transaction' && value.status !== 'committed')) {
    throw new Error(`artifact archive member does not belong to terminal run ${runId}`);
  }
  const file = artifact.path.split('/')[1];
  const hasId = (key) => typeof value[key] === 'string' && value[key].length > 0;
  if ((artifact.kind === 'run' &&
        (file !== `${runId}.json` || !TERMINAL_STATUSES.has(value.status) ||
          Object.hasOwn(value, 'ticket_id') || Object.hasOwn(value, 'receipt_id'))) ||
      (artifact.kind === 'ticket' &&
        (!hasId('ticket_id') || Object.hasOwn(value, 'receipt_id') ||
          file !== `${value.ticket_id.replaceAll(':', '_')}.json`)) ||
      (artifact.kind === 'receipt' && (!hasId('receipt_id') || file !== `${value.receipt_id}.json`)) ||
      (artifact.kind === 'receipt-transaction' &&
        (!hasId('ticket_id') || !value.receipt || typeof value.receipt !== 'object' || Array.isArray(value.receipt)))) {
    throw new Error(`artifact archive member identity does not match its kind for ${runId}`);
  }
}

async function safeArtifactDirectory(paths, directory) {
  if (!(await validateGovernedRuntimeAncestor(paths))) return false;
  const expected = path.join(await realpath(paths.runtime), directory);
  const absolute = path.join(paths.runtime, directory);
  let metadata;
  try { metadata = await lstatFile(absolute); }
  catch (error) { if (error?.code === 'ENOENT') return false; throw error; }
  if (!metadata.isDirectory() || metadata.isSymbolicLink() || await realpath(absolute) !== expected) {
    throw new Error('retention artifact directory is not a governed plain directory');
  }
  return true;
}

function sameArtifactEntry(left, right) {
  return ['dev', 'ino', 'size', 'mtimeMs', 'ctimeMs', 'nlink'].every((field) => left[field] === right[field]);
}

async function readGovernedRuntimeFile(paths, directory, file, maxBytes = RUNTIME_STATE_MAX_BYTES) {
  if (!file || /[/\\\u0000-\u001f]/u.test(file) || file === '.' || file === '..') {
    throw new Error('invalid retention artifact filename');
  }
  if (!(await safeArtifactDirectory(paths, directory))) return null;
  const absolute = path.join(paths.runtime, directory, file);
  let before;
  try { before = await lstatFile(absolute); }
  catch (error) { if (error?.code === 'ENOENT') return null; throw error; }
  const ordinary = (metadata) => metadata.isFile() && !metadata.isSymbolicLink() &&
    metadata.nlink === 1 && metadata.size <= maxBytes;
  if (!ordinary(before)) throw new Error('retention artifact is not a bounded single-link file');
  const handle = await open(absolute, fsConstants.O_RDONLY |
    (fsConstants.O_NOFOLLOW ?? 0) | (fsConstants.O_NONBLOCK ?? 0));
  try {
    const opened = await statFileHandle(handle);
    if (!ordinary(opened) || !sameArtifactEntry(before, opened)) throw new Error('retention artifact changed during open');
    const bytes = Buffer.alloc(Number(opened.size) + 1);
    let length = 0;
    while (length < bytes.length) {
      const read = await handle.read(bytes, length, bytes.length - length, length);
      if (read.bytesRead === 0) break;
      length += read.bytesRead;
    }
    if (!(await safeArtifactDirectory(paths, directory)) || length !== opened.size ||
        !sameArtifactEntry(opened, await statFileHandle(handle)) ||
        !sameArtifactEntry(opened, await lstatFile(absolute))) throw new Error('retention artifact changed during read');
    return { bytes: bytes.subarray(0, length), metadata: opened, absolute };
  } finally { await handle.close(); }
}

async function readArtifactFile(paths, relative) {
  const [directory, file, extra] = relative.split('/');
  if (extra !== undefined || !Object.values(ARTIFACT_DIRECTORIES).includes(directory)) {
    throw new Error('invalid retention artifact path');
  }
  return readGovernedRuntimeFile(paths, directory, file);
}

async function readArchiveBytes(paths, file) {
  if (path.dirname(file) !== path.join(paths.runtime, 'artifact-archives')) {
    throw new Error('invalid retention archive location');
  }
  const read = await readGovernedRuntimeFile(paths, 'artifact-archives', path.basename(file), ARCHIVE_COMPRESSED_MAX_BYTES);
  if (!read) throw Object.assign(new Error('retention archive is absent'), { code: 'ENOENT' });
  return read.bytes;
}

function inventoryCounts(value) {
  if (!value || !INVENTORY_FIELDS.every((key) => Number.isSafeInteger(value[key]) && value[key] >= 0)) return null;
  return Object.fromEntries(INVENTORY_FIELDS.map((key) => [key, value[key]]));
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function archiveDirectory(paths) {
  return path.join(paths.runtime, 'artifact-archives');
}

function archivePath(paths, runId) {
  return path.join(archiveDirectory(paths), `${runId}.json.gz`);
}

function retentionStatusPath(paths) {
  return paths.artifactRetentionStatus ?? path.join(paths.runtime, 'artifact-retention-status.json');
}

function boundedText(value, maxChars) {
  return String(value ?? '')
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .slice(0, maxChars);
}

export function summarizeArtifactRetentionError(error, runId = null) {
  return {
    ...(SAFE_RUN_ID.test(runId ?? '') ? { run_id: runId } : {}),
    code: boundedText(error?.code ?? 'RETENTION_ERROR', 64) || 'RETENTION_ERROR',
    reason: boundedText(error?.message ?? error ?? 'artifact retention failed', FAILURE_REASON_MAX_CHARS),
  };
}

function normalizeRetentionFailure(failure) {
  return {
    ...(SAFE_RUN_ID.test(failure?.run_id ?? '') ? { run_id: failure.run_id } : {}),
    code: boundedText(failure?.code ?? 'RETENTION_ERROR', 64) || 'RETENTION_ERROR',
    reason: boundedText(
      failure?.reason ?? failure?.message ?? 'artifact retention failed',
      FAILURE_REASON_MAX_CHARS,
    ),
  };
}

// Retention is intentionally best-effort after a terminal transition. Keep a
// single bounded latest-result document so automatic maintenance failures do
// not disappear, without growing another unbounded log or turning the already
// archived run red. The explicit maintenance action additionally writes its
// operator request/result to overrides.ndjson.
export async function recordArtifactRetentionStatus(paths, {
  trigger = 'automatic',
  result = null,
  error = null,
} = {}) {
  const failures = Array.isArray(result?.failures)
    ? result.failures.slice(0, MAX_FAILURES_PER_SWEEP).map(normalizeRetentionFailure)
    : error
      ? [summarizeArtifactRetentionError(error)]
      : [];
  const failureCount = Array.isArray(result?.failures) ? result.failures.length : failures.length;
  const inventory = inventoryCounts(result?.inventory);
  const status = {
    schema_version: '2.0.0',
    updated_at: new Date().toISOString(),
    trigger: trigger === 'manual' ? 'manual' : 'automatic',
    healthy: error === null && result?.skipped === undefined && failures.length === 0,
    compacted_runs: Number.isSafeInteger(result?.compacted_runs) ? result.compacted_runs : 0,
    removed_files: Number.isSafeInteger(result?.removed_files) ? result.removed_files : 0,
    retained_changed_files: Number.isSafeInteger(result?.retained_changed_files)
      ? result.retained_changed_files
      : 0,
    attempted_runs: Number.isSafeInteger(result?.attempted_runs) ? result.attempted_runs : 0,
    ...(typeof result?.skipped === 'string' ? { skipped: boundedText(result.skipped, 120) } : {}),
    ...(result?.candidate_limit_reached === true ? { candidate_limit_reached: true } : {}),
    failures,
    failure_count: failureCount,
    omitted_failures: failureCount - failures.length,
    ...(inventory ? { inventory } : {}),
  };
  try {
    await atomicWriteJson(
      retentionStatusPath(paths),
      status,
    );
  } catch {
    // This status is advisory. A status-write fault must not retroactively fail
    // verified cleanup or the completed run whose archive triggered it.
  }
  return status;
}

// Public read projection for ape_history maintenance-status. Re-validate and
// re-bound the advisory file because an operator or external process can edit
// project-local runtime files between writes; a tampered status must never
// become an unbounded MCP response.
export async function readArtifactRetentionStatus(paths) {
  let bytes;
  let handle;
  try {
    handle = await open(retentionStatusPath(paths), fsConstants.O_RDONLY |
      (fsConstants.O_NOFOLLOW ?? 0) | (fsConstants.O_NONBLOCK ?? 0));
    const before = await handle.stat();
    if (!before.isFile() || before.size > RETENTION_STATUS_MAX_BYTES) {
      throw new Error('artifact retention status exceeds its bounded size or is not a regular file');
    }
    const buffer = Buffer.alloc(RETENTION_STATUS_MAX_BYTES + 1);
    let offset = 0;
    while (offset < buffer.length) {
      const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, offset);
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    const after = await handle.stat();
    if (offset > RETENTION_STATUS_MAX_BYTES || before.size !== offset || after.size !== offset ||
        before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) {
      throw new Error('artifact retention status exceeds its bounded size or changed during read');
    }
    bytes = buffer.subarray(0, offset);
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  } finally {
    await handle?.close();
  }
  if (bytes.length > RETENTION_STATUS_MAX_BYTES) {
    throw new Error('artifact retention status exceeds its bounded size');
  }
  let stored;
  try {
    stored = JSON.parse(bytes.toString('utf8'));
  } catch {
    throw new Error('artifact retention status is invalid JSON');
  }
  if (
    stored === null ||
    typeof stored !== 'object' ||
    Array.isArray(stored) ||
    !['automatic', 'manual'].includes(stored.trigger) ||
    typeof stored.healthy !== 'boolean' ||
    !Array.isArray(stored.failures)
  ) {
    throw new Error('artifact retention status has an invalid shape');
  }
  const count = (value) => Number.isSafeInteger(value) && value >= 0 ? value : 0;
  const failures = stored.failures.slice(0, MAX_FAILURES_PER_SWEEP).map(normalizeRetentionFailure);
  const failureCount = Math.max(stored.failures.length, count(stored.failure_count));
  const inventory = inventoryCounts(stored.inventory);
  return {
    schema_version: '2.0.0',
    updated_at: boundedText(stored.updated_at, 64),
    trigger: stored.trigger,
    healthy: stored.healthy,
    compacted_runs: count(stored.compacted_runs),
    removed_files: count(stored.removed_files),
    retained_changed_files: count(stored.retained_changed_files),
    attempted_runs: count(stored.attempted_runs),
    ...(typeof stored.skipped === 'string' ? { skipped: boundedText(stored.skipped, 120) } : {}),
    ...(stored.candidate_limit_reached === true ? { candidate_limit_reached: true } : {}),
    failures,
    failure_count: failureCount,
    omitted_failures: failureCount - failures.length,
    ...(inventory ? { inventory } : {}),
  };
}

async function listJsonFiles(directory) {
  try {
    return (await readdir(directory)).filter((name) => name.endsWith('.json')).sort();
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
    return [];
  }
}

async function readProtectedRunIds(paths) {
  const protectedIds = new Set();
  let activePresent = false;
  try {
    const read = await readGovernedRuntimeFile(paths, '', path.basename(paths.active));
    const active = read ? JSON.parse(read.bytes.toString('utf8')) : null;
    if (active !== null) {
      if (typeof active !== 'object' || Array.isArray(active) || !SAFE_RUN_ID.test(active.run_id ?? '')) {
        return { safe: false, protectedIds };
      }
      protectedIds.add(active.run_id);
      activePresent = true;
    }
  } catch {
    return { safe: false, protectedIds };
  }
  // Use the cross-platform inspector: directory locks are not JSON files, and
  // an unreadable/orphan lock without matching active state must fail closed.
  try {
    const lock = await inspectRunLock(paths.lock);
    if (lock.present) {
      if (lock.readable !== true || !SAFE_RUN_ID.test(lock.run_id ?? '')) {
        return { safe: false, protectedIds };
      }
      if (activePresent && !protectedIds.has(lock.run_id)) {
        return { safe: false, protectedIds };
      }
      protectedIds.add(lock.run_id);
    }
  } catch { return { safe: false, protectedIds }; }
  return { safe: true, protectedIds };
}

async function immutableHistoryCandidates(paths, inventory) {
  const candidates = [];
  for (const file of await listJsonFiles(paths.history)) {
    const runId = file.slice(0, -5);
    if (!SAFE_RUN_ID.test(runId)) continue; // superseding hash-suffixed records
    const read = await readGovernedRuntimeFile(paths, 'history', file, 2 * RUNTIME_STATE_MAX_BYTES);
    if (!read) continue;
    const bytes = read.bytes;
    inventory.history_files_read += 1;
    inventory.history_bytes_read += bytes.length;
    const record = JSON.parse(bytes.toString('utf8'));
    if (
      record?.run_id !== runId ||
      !TERMINAL_STATUSES.has(record?.status) ||
      typeof record?.record_hash !== 'string' ||
      record.record_hash.length === 0
    ) continue;
    const parsed = Date.parse(record.completed_at ?? '');
    candidates.push({
      runId,
      record,
      completedAt: Number.isFinite(parsed) ? parsed : -Infinity,
    });
  }
  candidates.sort((left, right) =>
    right.completedAt - left.completedAt || right.runId.localeCompare(left.runId));
  return candidates;
}

async function artifactInventory(paths, eligibleIds, inventory) {
  const directories = [
    ['run', paths.runs],
    ['ticket', paths.tickets],
    ['receipt', paths.receipts],
    ['receipt-transaction', paths.receiptTransactions],
  ];
  const byRun = new Map([...eligibleIds].map((runId) => [runId, []]));
  for (const [kind, directory] of directories) {
    if (!(await safeArtifactDirectory(paths, ARTIFACT_DIRECTORIES[kind]))) continue;
    const files = await listJsonFiles(directory);
    const discovered = await mapInBatches(files, 32, async (file) => {
      const absolutePath = path.join(directory, file);
      let payload;
      try {
        const read = await readArtifactFile(paths, artifactRelativePath(kind, file));
        if (!read) return null;
        const { bytes } = read;
        inventory.artifact_files_read += 1;
        inventory.artifact_bytes_read += bytes.length;
        payload = JSON.parse(bytes.toString('utf8'));
      } catch {
        return null; // an unreadable artifact is never eligible for deletion
      }
      if (!eligibleIds.has(payload?.run_id)) return null;
      if (kind === 'receipt-transaction' && payload.status !== 'committed') return null;
      return { absolutePath, file, kind, runId: payload.run_id };
    });
    for (const artifact of discovered.filter(Boolean)) byRun.get(artifact.runId).push(artifact);
  }
  return byRun;
}

async function encodeArchive(paths, candidate, artifacts) {
  const encoded = [];
  const bodies = [];
  let offset = 0;
  for (const artifact of artifacts.sort((left, right) => left.absolutePath.localeCompare(right.absolutePath))) {
    const relative = artifactRelativePath(artifact.kind, artifact.file);
    const read = await readArtifactFile(paths, relative);
    if (!read) throw new Error('retention artifact disappeared before archiving');
    const { bytes } = read;
    if (offset + bytes.length > ARCHIVE_EXPANDED_MAX_BYTES) throw new Error('artifact archive exceeds its bounded expanded size; source files retained');
    validateArtifactMember({ ...artifact, path: relative }, bytes, candidate.runId);
    encoded.push({
      kind: artifact.kind,
      path: relative,
      offset,
      bytes: bytes.length,
      sha256: sha256(bytes),
    });
    bodies.push(bytes);
    offset += bytes.length;
  }
  const payload = {
    schema_version: '2.0.0',
    format: 'ape-artifact-archive-v1',
    run_id: candidate.runId,
    archived_at: new Date().toISOString(),
    immutable_history: {
      record_hash: candidate.record.record_hash,
      status: candidate.record.status,
      completed_at: candidate.record.completed_at,
    },
    artifacts: encoded,
  };
  // One JSON header line followed by the original byte streams. Keeping bodies
  // binary (rather than base64 in JSON) materially improves compression while
  // offsets + lengths + hashes retain exact, independently verifiable recovery.
  const header = Buffer.from(`${JSON.stringify(payload)}\n`);
  if (header.length + offset > ARCHIVE_EXPANDED_MAX_BYTES) throw new Error('artifact archive exceeds its bounded expanded size; source files retained');
  return gzipAsync(Buffer.concat([header, ...bodies]), { level: 6 });
}

function validateArchivePayload(payload, body, runId) {
  if (
    payload?.format !== 'ape-artifact-archive-v1' ||
    payload.run_id !== runId ||
    !Array.isArray(payload.artifacts)
  ) throw new Error(`invalid artifact archive for ${runId}`);
  let expectedOffset = 0;
  const memberPaths = new Set();
  for (const artifact of payload.artifacts) {
    const start = artifact.offset;
    const end = start + artifact.bytes;
    const bytes = body.subarray(start, end);
    if (
      typeof artifact.path !== 'string' ||
      path.isAbsolute(artifact.path) ||
      artifact.path.split('/').includes('..') ||
      !Number.isSafeInteger(start) ||
      start !== expectedOffset ||
      !Number.isSafeInteger(artifact.bytes) ||
      artifact.bytes < 0 ||
      end > body.length ||
      bytes.length !== artifact.bytes ||
      sha256(bytes) !== artifact.sha256
    ) throw new Error(`artifact archive integrity check failed for ${runId}`);
    validateArtifactMember(artifact, bytes, runId);
    if (memberPaths.has(artifact.path)) throw new Error(`duplicate artifact archive member for ${runId}`);
    memberPaths.add(artifact.path);
    expectedOffset = end;
  }
  if (expectedOffset !== body.length) throw new Error(`artifact archive trailing bytes for ${runId}`);
  return payload;
}

async function recoverPublishedArchiveTemporary(paths, file, runId) {
  if (path.basename(file) !== `${runId}.json.gz` ||
      !(await safeArtifactDirectory(paths, 'artifact-archives'))) return;
  let published;
  try { published = await lstatFile(file); }
  catch (error) { if (error?.code === 'ENOENT') return; throw error; }
  if (!published.isFile() || published.isSymbolicLink() || published.nlink <= 1 ||
      published.size > ARCHIVE_COMPRESSED_MAX_BYTES) return;
  const prefix = `.${runId}.`;
  for (const name of await readdir(path.dirname(file))) {
    if (!name.startsWith(prefix) || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.tmp$/.test(name.slice(prefix.length))) continue;
    const temporary = path.join(path.dirname(file), name);
    let entry;
    try { entry = await lstatFile(temporary); }
    catch (error) { if (error?.code === 'ENOENT') continue; throw error; }
    // Publication links only already-written, fsynced bytes. The exact same
    // inode under its recognized staging name can be unlinked even if the
    // publisher died immediately after link(), without guessing a live PID.
    if (entry.isFile() && !entry.isSymbolicLink() && entry.dev === published.dev && entry.ino === published.ino &&
        sameArtifactEntry(entry, await lstatFile(temporary)) &&
        await safeArtifactDirectory(paths, 'artifact-archives')) {
      await rm(temporary, { force: true });
    }
  }
  await syncDirectory(path.dirname(file));
}

async function readArchive(paths, file, runId) {
  await recoverPublishedArchiveTemporary(paths, file, runId);
  const uncompressed = await gunzipAsync(await readArchiveBytes(paths, file), { maxOutputLength: ARCHIVE_EXPANDED_MAX_BYTES });
  const separator = uncompressed.indexOf(0x0a);
  if (separator === -1) throw new Error(`artifact archive header is missing for ${runId}`);
  const payload = JSON.parse(uncompressed.subarray(0, separator).toString('utf8'));
  return validateArchivePayload(payload, uncompressed.subarray(separator + 1), runId);
}

async function atomicWriteArchive(paths, file, compressed, runId) {
  if (!(await safeArtifactDirectory(paths, 'artifact-archives'))) {
    // The governed runtime already exists; never recursively follow a planted
    // archive-directory link while creating the immutable archive sink.
    if (!(await validateGovernedRuntimeAncestor(paths))) {
      throw new Error('retention requires an existing governed runtime directory');
    }
    await mkdir(path.dirname(file), { mode: 0o700 }).catch((error) => {
      if (error?.code !== 'EEXIST') throw error;
    });
  }
  if (!(await safeArtifactDirectory(paths, 'artifact-archives'))) {
    throw new Error('retention archive directory is absent');
  }
  try {
    return await readArchive(paths, file, runId);
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
  const temporary = path.join(path.dirname(file), `.${runId}.${randomUUID()}.tmp`);
  try {
    const handle = await open(temporary, 'wx', 0o600);
    try { await handle.writeFile(compressed); await handle.sync(); }
    finally { await handle.close(); }
    await readArchive(paths, temporary, runId);
    if (!(await safeArtifactDirectory(paths, 'artifact-archives'))) {
      throw new Error('retention archive directory changed before publication');
    }
    // Publish a complete archive without replacing a concurrent publisher.
    // A retry recognizes only this published inode's exact temporary name;
    // unrelated hardlinks still fail closed and retain the loose sources.
    await link(temporary, file).catch((error) => {
      if (error?.code !== 'EEXIST') throw error;
    });
  } finally {
    if (await safeArtifactDirectory(paths, 'artifact-archives').catch(() => false)) {
      await rm(temporary, { force: true });
    }
  }
  await syncDirectory(path.dirname(file));
  return readArchive(paths, file, runId);
}

async function removeArchivedArtifacts(paths, payload) {
  let removed = 0;
  let retainedChanged = 0;
  for (const artifact of payload.artifacts) {
    const read = await readArtifactFile(paths, artifact.path);
    if (!read) continue;
    const current = read.bytes;
    if (current.length !== artifact.bytes || sha256(current) !== artifact.sha256) {
      retainedChanged += 1;
      continue;
    }
    validateArtifactMember(artifact, current, payload.run_id);
    if (!(await safeArtifactDirectory(paths, artifact.path.split('/')[0])) ||
        !sameArtifactEntry(read.metadata, await lstatFile(read.absolute))) {
      throw new Error('retention artifact changed before removal');
    }
    await rm(read.absolute);
    removed += 1;
  }
  return { removed, retainedChanged };
}

async function removableArchivedArtifactCount(paths, payload) {
  let removable = 0;
  for (const artifact of payload.artifacts) {
    const read = await readArtifactFile(paths, artifact.path);
    if (!read) continue;
    const current = read.bytes;
    if (current.length === artifact.bytes && sha256(current) === artifact.sha256) removable += 1;
  }
  return removable;
}

// Compact only artifacts made redundant by an immutable terminal history
// record. The archive is byte-exact, gzip-compressed, verified before removal,
// and retained beside history. The newest runs, active/sealed current run,
// prepared transactions, immutable history, and append-only audit logs remain
// untouched. The sweep bounds compaction attempts and concurrent inventory
// reads; total inventory scanning still grows with retained history/artifacts.
export async function compactArchivedArtifacts(paths, {
  keepRecentRuns = DEFAULT_KEEP_RECENT_RUNS,
  maxRunsPerSweep = DEFAULT_MAX_RUNS_PER_SWEEP,
} = {}) {
  if (!Number.isInteger(keepRecentRuns) || keepRecentRuns < 0) {
    throw new Error('keepRecentRuns must be a non-negative integer');
  }
  if (!Number.isInteger(maxRunsPerSweep) || maxRunsPerSweep < 1) {
    throw new Error('maxRunsPerSweep must be a positive integer');
  }
  const protection = await readProtectedRunIds(paths);
  if (!protection.safe) {
    return { compacted_runs: 0, removed_files: 0, skipped: 'current-run-state-unreadable' };
  }
  const inventory = Object.fromEntries(INVENTORY_FIELDS.map((key) => [key, 0]));
  const candidates = await immutableHistoryCandidates(paths, inventory);
  const eligible = candidates
    .slice(keepRecentRuns)
    .filter((candidate) => !protection.protectedIds.has(candidate.runId));
  const byRun = await artifactInventory(paths, new Set(eligible.map((candidate) => candidate.runId)), inventory);
  let compactedRuns = 0;
  let removedFiles = 0;
  let retainedChanged = 0;
  let attemptedRuns = 0;
  let candidateLimitReached = false;
  const failures = [];
  // A failed candidate does not spend a successful-compaction slot, so one
  // corrupt archive cannot starve every older run. The extra failure allowance
  // still bounds compaction attempts in automatic and manual sweeps. Inventory
  // scanning above is separate from this count and reads all loose artifacts.
  const maxCandidateAttempts = maxRunsPerSweep + MAX_FAILURES_PER_SWEEP;
  for (const candidate of eligible) {
    if (compactedRuns >= maxRunsPerSweep) break;
    const artifacts = byRun.get(candidate.runId) ?? [];
    // A prior successful sweep has no redundant source artifacts left. Skip it
    // before the per-sweep cap so completed archives cannot permanently starve
    // older candidates or append duplicate audit lines on every terminal run.
    if (artifacts.length === 0) continue;
    if (attemptedRuns >= maxCandidateAttempts) {
      candidateLimitReached = true;
      break;
    }
    attemptedRuns += 1;
    try {
      const destination = archivePath(paths, candidate.runId);
      let payload;
      try {
        payload = await readArchive(paths, destination, candidate.runId);
      } catch (error) {
        if (error?.code !== 'ENOENT') throw error;
        payload = await atomicWriteArchive(
          paths,
          destination,
          await encodeArchive(paths, candidate, artifacts),
          candidate.runId,
        );
      }
      if (payload.immutable_history?.record_hash !== candidate.record.record_hash) {
        throw new Error(`artifact archive history hash mismatch for ${candidate.runId}`);
      }
      if (await removableArchivedArtifactCount(paths, payload) === 0) {
        // Every remaining path either appeared after the immutable archive or
        // changed since it was captured. Preserve it without repetitive audit
        // churn; a byte-identical archived path that reappears is retried later.
        continue;
      }
      const archiveBytes = await readArchiveBytes(paths, destination);
      await appendJsonLine(paths.overrideLog, {
        operation: 'artifact-retention',
        phase: 'planned',
        at: new Date().toISOString(),
        run_id: candidate.runId,
        history_record_hash: candidate.record.record_hash,
        archive_sha256: sha256(archiveBytes),
        artifact_count: payload.artifacts.length,
      });
      const removal = await removeArchivedArtifacts(paths, payload);
      await appendJsonLine(paths.overrideLog, {
        operation: 'artifact-retention',
        phase: 'completed',
        at: new Date().toISOString(),
        run_id: candidate.runId,
        removed_files: removal.removed,
        retained_changed_files: removal.retainedChanged,
      });
      compactedRuns += 1;
      removedFiles += removal.removed;
      retainedChanged += removal.retainedChanged;
    } catch (error) {
      failures.push(summarizeArtifactRetentionError(error, candidate.runId));
      continue;
    }
  }
  return {
    compacted_runs: compactedRuns,
    removed_files: removedFiles,
    retained_changed_files: retainedChanged,
    attempted_runs: attemptedRuns,
    failures,
    inventory,
    ...(candidateLimitReached ? { candidate_limit_reached: true } : {}),
  };
}
