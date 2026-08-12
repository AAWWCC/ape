import { createHash, randomUUID } from 'node:crypto';
import { promisify } from 'node:util';
import { gzip, gunzip } from 'node:zlib';
import path from 'node:path';
import {
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises';
import { TERMINAL_STATUSES } from './constants.js';
import { appendJsonLine, atomicWriteJson, readJson } from './storage.js';
import { inspectRunLock } from './lock.js';

const gzipAsync = promisify(gzip);
const gunzipAsync = promisify(gunzip);
const SAFE_RUN_ID = /^run-[A-Za-z0-9_-]{1,128}$/;
const DEFAULT_KEEP_RECENT_RUNS = 32;
const DEFAULT_MAX_RUNS_PER_SWEEP = 16;
const MAX_FAILURES_PER_SWEEP = 16;
const FAILURE_REASON_MAX_CHARS = 320;
const RETENTION_STATUS_MAX_BYTES = 32 * 1024;

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
  try {
    bytes = await readFile(retentionStatusPath(paths));
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
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
    failures: stored.failures.slice(0, MAX_FAILURES_PER_SWEEP).map(normalizeRetentionFailure),
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
    const active = await readJson(paths.active, null);
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
  } catch {
    if (!activePresent) return { safe: false, protectedIds };
  }
  return { safe: true, protectedIds };
}

async function immutableHistoryCandidates(paths) {
  const candidates = [];
  for (const file of await listJsonFiles(paths.history)) {
    const runId = file.slice(0, -5);
    if (!SAFE_RUN_ID.test(runId)) continue; // superseding hash-suffixed records
    const record = await readJson(path.join(paths.history, file), null);
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

async function mapInBatches(values, batchSize, mapper) {
  const output = [];
  for (let offset = 0; offset < values.length; offset += batchSize) {
    output.push(...await Promise.all(values.slice(offset, offset + batchSize).map(mapper)));
  }
  return output;
}

async function artifactInventory(paths, eligibleIds) {
  const directories = [
    ['run', paths.runs],
    ['ticket', paths.tickets],
    ['receipt', paths.receipts],
    ['receipt-transaction', paths.receiptTransactions],
  ];
  const byRun = new Map([...eligibleIds].map((runId) => [runId, []]));
  for (const [kind, directory] of directories) {
    const files = await listJsonFiles(directory);
    const discovered = await mapInBatches(files, 32, async (file) => {
      const absolutePath = path.join(directory, file);
      let payload;
      try {
        payload = JSON.parse(await readFile(absolutePath, 'utf8'));
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
    const bytes = await readFile(artifact.absolutePath);
    encoded.push({
      kind: artifact.kind,
      path: path.relative(paths.runtime, artifact.absolutePath).split(path.sep).join('/'),
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
  return gzipAsync(Buffer.concat([
    Buffer.from(`${JSON.stringify(payload)}\n`),
    ...bodies,
  ]), { level: 6 });
}

function validateArchivePayload(payload, body, runId) {
  if (
    payload?.format !== 'ape-artifact-archive-v1' ||
    payload.run_id !== runId ||
    !Array.isArray(payload.artifacts)
  ) throw new Error(`invalid artifact archive for ${runId}`);
  let expectedOffset = 0;
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
    expectedOffset = end;
  }
  if (expectedOffset !== body.length) throw new Error(`artifact archive trailing bytes for ${runId}`);
  return payload;
}

async function readArchive(file, runId) {
  const uncompressed = await gunzipAsync(await readFile(file));
  const separator = uncompressed.indexOf(0x0a);
  if (separator === -1) throw new Error(`artifact archive header is missing for ${runId}`);
  const payload = JSON.parse(uncompressed.subarray(0, separator).toString('utf8'));
  return validateArchivePayload(payload, uncompressed.subarray(separator + 1), runId);
}

async function atomicWriteArchive(file, compressed, runId) {
  await mkdir(path.dirname(file), { recursive: true });
  try {
    return await readArchive(file, runId);
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
  const temporary = path.join(path.dirname(file), `.${runId}.${randomUUID()}.tmp`);
  try {
    await writeFile(temporary, compressed, { flag: 'wx', mode: 0o600 });
    await readArchive(temporary, runId);
    await rename(temporary, file);
  } finally {
    await rm(temporary, { force: true });
  }
  return readArchive(file, runId);
}

async function removeArchivedArtifacts(paths, payload) {
  let removed = 0;
  let retainedChanged = 0;
  for (const artifact of payload.artifacts) {
    const absolutePath = path.resolve(paths.runtime, ...artifact.path.split('/'));
    const relativePath = path.relative(paths.runtime, absolutePath);
    if (relativePath.startsWith('..') || path.isAbsolute(relativePath)) {
      throw new Error(`artifact archive path escaped runtime root: ${artifact.path}`);
    }
    let current;
    try {
      current = await readFile(absolutePath);
    } catch (error) {
      if (error?.code === 'ENOENT') continue;
      throw error;
    }
    if (current.length !== artifact.bytes || sha256(current) !== artifact.sha256) {
      retainedChanged += 1;
      continue;
    }
    await rm(absolutePath);
    removed += 1;
  }
  return { removed, retainedChanged };
}

async function removableArchivedArtifactCount(paths, payload) {
  let removable = 0;
  for (const artifact of payload.artifacts) {
    const absolutePath = path.resolve(paths.runtime, ...artifact.path.split('/'));
    let current;
    try {
      current = await readFile(absolutePath);
    } catch (error) {
      if (error?.code === 'ENOENT') continue;
      throw error;
    }
    if (current.length === artifact.bytes && sha256(current) === artifact.sha256) removable += 1;
  }
  return removable;
}

// Compact only artifacts made redundant by an immutable terminal history
// record. The archive is byte-exact, gzip-compressed, verified before removal,
// and retained beside history. The newest runs, active/sealed current run,
// prepared transactions, immutable history, and append-only audit logs remain
// untouched. A bounded sweep keeps terminal latency predictable.
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
  const candidates = await immutableHistoryCandidates(paths);
  const eligible = candidates
    .slice(keepRecentRuns)
    .filter((candidate) => !protection.protectedIds.has(candidate.runId));
  const byRun = await artifactInventory(paths, new Set(eligible.map((candidate) => candidate.runId)));
  let compactedRuns = 0;
  let removedFiles = 0;
  let retainedChanged = 0;
  let attemptedRuns = 0;
  let candidateLimitReached = false;
  const failures = [];
  // A failed candidate does not spend a successful-compaction slot, so one
  // corrupt archive cannot starve every older run. The extra failure allowance
  // still gives automatic and manual sweeps a hard I/O bound.
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
        payload = await readArchive(destination, candidate.runId);
      } catch (error) {
        if (error?.code !== 'ENOENT') throw error;
        payload = await atomicWriteArchive(
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
      const archiveBytes = await readFile(destination);
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
    ...(candidateLimitReached ? { candidate_limit_reached: true } : {}),
  };
}
