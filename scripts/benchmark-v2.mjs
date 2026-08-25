#!/usr/bin/env node
/**
 * Bounded APE v2 latency certification ledger.
 *
 * adjusted_ms = raw_ms - test_ms - remote_ci_ms. Certification requires at
 * least 20 observations and 18 passing observations in every host/lane group.
 */
import { randomBytes } from 'node:crypto';
import {
  closeSync,
  constants,
  fchmodSync,
  existsSync,
  fstatSync,
  fsyncSync,
  ftruncateSync,
  linkSync,
  lstatSync,
  openSync,
  opendirSync,
  readFileSync,
  readdirSync,
  readSync,
  renameSync,
  unlinkSync,
  writeSync,
} from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { selectEffectiveRecord } from '../lib/runtime/history.js';
import { runtimePaths } from '../lib/runtime/paths.js';
import { DEFAULT_DEADLINES_MS } from '../lib/runtime/constants.js';

const DEFAULT_FILE = 'benchmarks/reference-runs.json';
const HOSTS = ['claude', 'codex'];
const CERT_LANES = ['mechanical', 'fast', 'full'];
const BUILDING_MODES = ['phase', 'patch'];
const LOCK_LEASE_MS = 60_000;
const LOCK_BYTES = 4 * 1024;

export const BENCHMARK_LIMITS = Object.freeze({
  existingLedgerBytes: 1024 * 1024,
  ledgerRecords: 512,
  ledgerOutputBytes: 2 * 1024 * 1024,
  historyEntries: 2048,
  historyEntryBytes: 256 * 1024,
  historyTotalBytes: 16 * 1024 * 1024,
});

function sameIdentity(left, right) {
  return left.dev === right.dev && left.ino === right.ino;
}

function sameSnapshot(left, right) {
  return sameIdentity(left, right)
    && left.size === right.size
    && left.mtimeMs === right.mtimeMs
    && left.ctimeMs === right.ctimeMs;
}

function lockPath(file) {
  return path.join(path.dirname(file), '.benchmark-ledger.lock');
}

function readLockSnapshot(file) {
  const before = lstatSync(file);
  if (!before.isFile()) return null;
  const fd = openSync(file, constants.O_RDONLY);
  try {
    const opened = fstatSync(fd);
    if (!sameIdentity(before, opened) || opened.size !== before.size) return null;
    if (opened.size > LOCK_BYTES) {
      const after = fstatSync(fd);
      if (!sameSnapshot(opened, after)) return null;
      return { stats: opened, bytes: null };
    }
    const bytes = readHandle(fd, opened.size, 'benchmark writer lock changed while being read');
    const after = fstatSync(fd);
    if (!sameSnapshot(opened, after)) return null;
    return { stats: opened, bytes };
  } finally {
    closeSync(fd);
  }
}

function sameLockSnapshot(left, right) {
  return left && right
    && sameSnapshot(left.stats, right.stats)
    && (left.bytes === null || right.bytes === null
      ? left.bytes === right.bytes
      : left.bytes.equals(right.bytes));
}

function sameReclaimableLock(left, right) {
  return left && right
    && sameIdentity(left.stats, right.stats)
    && left.stats.size === right.stats.size
    && left.stats.mtimeMs === right.stats.mtimeMs
    && (left.bytes === null || right.bytes === null
      ? left.bytes === right.bytes
      : left.bytes.equals(right.bytes));
}

function writeLockMetadata(fd) {
  const bytes = Buffer.from(`${JSON.stringify({ pid: process.pid })}\n`);
  fchmodSync(fd, 0o600);
  ftruncateSync(fd, 0);
  let offset = 0;
  while (offset < bytes.length) offset += writeSync(fd, bytes, offset, bytes.length - offset, offset);
  fsyncSync(fd);
  return { identity: fstatSync(fd), bytes };
}

function acquireReclaimCandidacy(file) {
  const directory = path.dirname(file);
  const prefix = `${path.basename(file)}.reclaimer-`;
  const candidate = path.join(
    directory,
    `${prefix}${String(Date.now()).padStart(13, '0')}-${process.pid}-${randomBytes(16).toString('hex')}`,
  );
  const fd = openSync(candidate, 'wx', 0o600);
  const owned = fstatSync(fd);
  closeSync(fd);
  // Keep the winning candidacy published through the entire in-place
  // transition. A killed reclaimer leaves only a PID-named artifact, so later
  // reclaimers can ignore its confirmed-dead owner instead of being wedged by
  // the fixed hard-link claim.
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);
  const contenders = readdirSync(directory)
    .filter((name) => name.startsWith(prefix))
    .map((name) => {
      const match = name.slice(prefix.length).match(/^(\d{13})-(\d+)-/u);
      if (!match) return null;
      const contender = path.join(directory, name);
      let stats;
      try {
        stats = lstatSync(contender);
      } catch (error) {
        if (error?.code === 'ENOENT') return null;
        throw error;
      }
      if (!stats.isFile()) return null;
      const pid = Number(match[2]);
      try {
        process.kill(pid, 0);
      } catch (error) {
        if (error?.code === 'ESRCH') return null;
      }
      return name;
    })
    .filter((name) => name !== null)
    .sort();
  return { file: candidate, identity: owned, priority: contenders[0] === path.basename(candidate) };
}

function releaseReclaimCandidacy(candidacy) {
  try {
    const current = lstatSync(candidacy.file);
    if (sameIdentity(current, candidacy.identity)) unlinkSync(candidacy.file);
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
}

function tryReclaimLedgerLock(file) {
  let observed;
  try {
    observed = readLockSnapshot(file);
  } catch (error) {
    return null;
  }
  if (!observed) return null;

  let metadata;
  if (observed.bytes !== null) {
    try {
      metadata = JSON.parse(observed.bytes.toString('utf8'));
    } catch {
      metadata = null;
    }
  } else metadata = null;
  const pid = metadata && Number.isSafeInteger(metadata.pid) && metadata.pid > 0
    ? metadata.pid
    : null;
  if (pid !== null) {
    try {
      process.kill(pid, 0);
      return null;
    } catch (error) {
      if (error?.code !== 'ESRCH') return null;
    }
  } else if (Date.now() - observed.stats.mtimeMs < LOCK_LEASE_MS) {
    return null;
  }

  let current;
  const candidacy = acquireReclaimCandidacy(file);
  if (!candidacy.priority) {
    releaseReclaimCandidacy(candidacy);
    return null;
  }

  // Quarantine the stale namespace entry without ever writing through its
  // untrusted inode. The hard-link claim also makes a pre-metadata crash
  // recoverable; only a newly-created private claim is rewritten.
  let claim = `${file}.reclaim`;
  let fd;
  let oldClaimed = false;
  let freshClaimIdentity;
  let primaryPublished = false;
  let writtenMetadata;
  try {
    current = readLockSnapshot(file);
    if (!sameLockSnapshot(current, observed)) return null;
    try {
      linkSync(file, claim);
      oldClaimed = true;
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
      const existingClaim = lstatSync(claim);
      if (sameIdentity(existingClaim, observed.stats)) {
        oldClaimed = true;
      } else {
        claim = `${file}.reclaim-${process.pid}-${randomBytes(16).toString('hex')}`;
        linkSync(file, claim);
        oldClaimed = true;
      }
    }
    const claimedSnapshot = (() => {
      try { return readLockSnapshot(claim); } catch { return null; }
    })();
    current = (() => {
      try { return readLockSnapshot(file); } catch { return null; }
    })();
    if (!sameReclaimableLock(claimedSnapshot, observed)
      || !sameReclaimableLock(current, observed)) {
      throw new Error('benchmark writer lock changed during reclaim');
    }

    // Removing these two lock-namespace links cannot alter any other hard link
    // to the stale inode. A competing normal acquirer may win the empty primary
    // name; the exclusive publish below then fails closed.
    unlinkSync(file);
    current = (() => {
      try { return readLockSnapshot(claim); } catch { return null; }
    })();
    if (!sameReclaimableLock(current, observed)) {
      throw new Error('benchmark writer lock changed during reclaim');
    }
    unlinkSync(claim);
    oldClaimed = false;

    const reserved = openSync(claim, 'wx', 0o600);
    freshClaimIdentity = fstatSync(reserved);
    closeSync(reserved);
    linkSync(claim, file);
    primaryPublished = true;
    fd = openSync(claim, 'r+');
    const openedFresh = fstatSync(fd);
    const publishedFresh = lstatSync(file);
    if (!sameIdentity(openedFresh, freshClaimIdentity)
      || !sameIdentity(publishedFresh, freshClaimIdentity)) {
      throw new Error('benchmark writer lock changed during reclaim');
    }
    writtenMetadata = writeLockMetadata(fd);
    const ownedClaim = readLockSnapshot(claim);
    let ownedPrimary;
    try {
      ownedPrimary = readLockSnapshot(file);
    } catch {
      ownedPrimary = null;
    }
    if (!ownedClaim
      || !sameSnapshot(ownedClaim.stats, writtenMetadata.identity)
      || ownedClaim.bytes === null
      || !ownedClaim.bytes.equals(writtenMetadata.bytes)
      || !ownedPrimary
      || !sameSnapshot(ownedPrimary.stats, writtenMetadata.identity)
      || ownedPrimary.bytes === null
      || !ownedPrimary.bytes.equals(writtenMetadata.bytes)) {
      throw new Error('benchmark writer lock claim changed during reclaim');
    }
    unlinkSync(claim);
    freshClaimIdentity = undefined;
    return { fd, file, identity: fstatSync(fd), bytes: writtenMetadata.bytes };
  } catch (error) {
    if (fd !== undefined) closeSync(fd);
    if (primaryPublished && freshClaimIdentity) {
      try {
        const primary = lstatSync(file);
        if (sameIdentity(primary, freshClaimIdentity)) unlinkSync(file);
      } catch {
        // Preserve a foreign replacement and the original reclaim failure.
      }
    }
    if (freshClaimIdentity) {
      try {
        const freshClaim = lstatSync(claim);
        if (sameIdentity(freshClaim, freshClaimIdentity)) unlinkSync(claim);
      } catch {
        // Preserve a foreign replacement and the original reclaim failure.
      }
    } else if (oldClaimed) {
      try {
        const claimSnapshot = readLockSnapshot(claim);
        if (sameReclaimableLock(claimSnapshot, observed)) unlinkSync(claim);
      } catch {
        // Preserve a foreign replacement and the original reclaim failure.
      }
    }
    if (error?.code === 'EEXIST' || error?.code === 'ENOENT') return null;
    throw error;
  } finally {
    releaseReclaimCandidacy(candidacy);
  }
}

function acquireLedgerLock(file) {
  const lock = lockPath(file);
  const deadline = Date.now() + 30_000;
  while (true) {
    try {
      const fd = openSync(lock, 'wx', 0o600);
      try {
        const metadata = writeLockMetadata(fd);
        return { fd, file: lock, ...metadata };
      } catch (error) {
        const identity = fstatSync(fd);
        closeSync(fd);
        try {
          const current = lstatSync(lock);
          if (sameIdentity(current, identity)) unlinkSync(lock);
        } catch {
          // Preserve the original metadata write failure.
        }
        throw error;
      }
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
      const reclaimed = tryReclaimLedgerLock(lock);
      if (reclaimed) return reclaimed;
      if (Date.now() >= deadline) throw new Error('benchmark writer lock is busy');
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
    }
  }
}

function releaseLedgerLock(lock) {
  closeSync(lock.fd);
  let released;
  try {
    const current = readLockSnapshot(lock.file);
    if (!current
      || !sameSnapshot(current.stats, lock.identity)
      || !current.bytes.equals(lock.bytes)) return;
    released = `${lock.file}.release-${randomBytes(16).toString('hex')}`;
    renameSync(lock.file, released);
    const moved = lstatSync(released);
    if (sameIdentity(moved, lock.identity)) unlinkSync(released);
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  } finally {
    if (released) {
      try {
        const moved = lstatSync(released);
        if (sameIdentity(moved, lock.identity)) unlinkSync(released);
      } catch (error) {
        if (error?.code !== 'ENOENT') throw error;
      }
    }
  }
}

function readHandle(fd, size, changedMessage) {
  const bytes = Buffer.alloc(size);
  let offset = 0;
  while (offset < size) {
    const count = readSync(fd, bytes, offset, size - offset, offset);
    if (count === 0) throw new Error(changedMessage);
    offset += count;
  }
  return bytes;
}

function readLedger(file, options = {}) {
  if (!existsSync(file)) {
    return { records: [], legacyRunIds: [], bytes: null, identity: { exists: false } };
  }
  const before = lstatSync(file);
  if (!before.isFile()) throw new Error('benchmark ledger must be a regular file');
  if (before.size > BENCHMARK_LIMITS.existingLedgerBytes) {
    throw new Error('existing benchmark ledger exceeds byte limit');
  }

  const fd = openSync(file, constants.O_RDONLY);
  try {
    const opened = fstatSync(fd);
    if (!opened.isFile() || !sameIdentity(before, opened)) {
      throw new Error('benchmark ledger changed while being opened');
    }
    if (opened.size > BENCHMARK_LIMITS.existingLedgerBytes) {
      throw new Error('existing benchmark ledger exceeds byte limit');
    }
    const bytes = readHandle(fd, opened.size, 'benchmark ledger changed while being read');
    let records;
    try {
      records = JSON.parse(bytes.toString('utf8'));
    } catch {
      throw new Error('benchmark ledger is not valid JSON');
    }
    if (!Array.isArray(records)) throw new Error('benchmark input must be an array');
    if (records.length > BENCHMARK_LIMITS.ledgerRecords) {
      throw new Error('benchmark ledger record count exceeds limit');
    }
    let normalized;
    try {
      normalized = records.map((record) => validateBenchmarkRecord(record, {
        strict: true,
        allowHistorySource: true,
        allowLegacyRunId: options.allowLegacyRunId === true,
        stampRecordedAt: false,
      }));
    } catch {
      throw new Error('benchmark ledger contains an invalid record');
    }
    return {
      records: normalized,
      legacyRunIds: options.allowLegacyRunId === true
        ? records.map((record) => record.run_id)
        : [],
      bytes,
      identity: {
        exists: true,
        dev: opened.dev,
        ino: opened.ino,
        size: opened.size,
        mtimeMs: opened.mtimeMs,
        ctimeMs: opened.ctimeMs,
      },
    };
  } finally {
    closeSync(fd);
  }
}

function currentDestinationIdentity(file) {
  try {
    const stats = lstatSync(file);
    if (!stats.isFile()) throw new Error('benchmark ledger must be a regular file');
    return {
      exists: true,
      dev: stats.dev,
      ino: stats.ino,
      size: stats.size,
      mtimeMs: stats.mtimeMs,
      ctimeMs: stats.ctimeMs,
    };
  } catch (error) {
    if (error?.code === 'ENOENT') return { exists: false };
    throw error;
  }
}

function currentDestinationSnapshot(file) {
  let before;
  try {
    before = lstatSync(file);
  } catch (error) {
    if (error?.code === 'ENOENT') return { exists: false, bytes: null };
    throw error;
  }
  if (!before.isFile()) throw new Error('benchmark ledger must be a regular file');
  if (before.size > BENCHMARK_LIMITS.ledgerOutputBytes) {
    throw new Error('benchmark ledger changed before replacement');
  }
  const fd = openSync(file, constants.O_RDONLY);
  try {
    const opened = fstatSync(fd);
    if (!opened.isFile() || !sameIdentity(before, opened) || opened.size !== before.size) {
      throw new Error('benchmark ledger changed before replacement');
    }
    const bytes = readHandle(fd, opened.size, 'benchmark ledger changed before replacement');
    const after = fstatSync(fd);
    if (!sameSnapshot(opened, after)) throw new Error('benchmark ledger changed before replacement');
    return { exists: true, ...opened, bytes };
  } finally {
    closeSync(fd);
  }
}

function validateStagedBytes(file, owned, expectedBytes) {
  const before = lstatSync(file);
  if (!before.isFile() || !sameIdentity(before, owned) || before.size !== expectedBytes.length) {
    throw new Error('benchmark staging identity changed');
  }
  const fd = openSync(file, constants.O_RDONLY);
  try {
    const opened = fstatSync(fd);
    if (!sameIdentity(opened, owned) || opened.size !== expectedBytes.length) {
      throw new Error('benchmark staging validation failed');
    }
    const bytes = readHandle(fd, opened.size, 'benchmark staging validation failed');
    const after = fstatSync(fd);
    if (!sameSnapshot(opened, after) || !bytes.equals(expectedBytes)) {
      throw new Error('benchmark staging validation failed');
    }
  } finally {
    closeSync(fd);
  }
}

function validateLedgerForWrite(records) {
  if (!Array.isArray(records)) throw new Error('benchmark input must be an array');
  if (records.length > BENCHMARK_LIMITS.ledgerRecords) {
    throw new Error('benchmark ledger record count exceeds limit');
  }
  for (const record of records) validateBenchmarkRecord(record, {
    strict: true,
    allowHistorySource: true,
  });
}

function atomicWriteLedger(file, records, expectedIdentity, expectedBytes) {
  validateLedgerForWrite(records);
  const serialized = `${JSON.stringify(records, null, 2)}\n`;
  const byteLength = Buffer.byteLength(serialized);
  if (byteLength > BENCHMARK_LIMITS.ledgerOutputBytes) {
    throw new Error('benchmark ledger output exceeds byte limit');
  }

  let staged;
  let fd;
  let owned;
  try {
    for (let attempt = 0; attempt < 16; attempt += 1) {
      staged = path.join(path.dirname(file), `.benchmark-ledger.${randomBytes(16).toString('hex')}.tmp`);
      try {
        fd = openSync(staged, 'wx', 0o600);
        owned = fstatSync(fd);
        break;
      } catch (error) {
        if (error?.code !== 'EEXIST') throw error;
      }
    }
    if (fd === undefined) throw new Error('could not reserve benchmark staging file');
    const content = Buffer.from(serialized);
    let offset = 0;
    while (offset < content.length) offset += writeSync(fd, content, offset, content.length - offset);
    // fsyncSync is the synchronous owned-handle equivalent of FileHandle.sync().
    fsyncSync(fd);
    const stagedStats = fstatSync(fd);
    if (stagedStats.size !== byteLength || stagedStats.size > BENCHMARK_LIMITS.ledgerOutputBytes) {
      throw new Error('benchmark staging validation failed');
    }
    const validationFd = openSync(staged, constants.O_RDONLY);
    try {
      const validationStats = fstatSync(validationFd);
      if (!sameIdentity(validationStats, owned) || validationStats.size !== stagedStats.size) {
        throw new Error('benchmark staging validation failed');
      }
      const stagedBytes = readHandle(validationFd, validationStats.size, 'benchmark staging validation failed');
      if (!stagedBytes.equals(content)) throw new Error('benchmark staging validation failed');
      const parsed = JSON.parse(stagedBytes.toString('utf8'));
      validateLedgerForWrite(parsed);
    } finally {
      closeSync(validationFd);
    }

    const current = currentDestinationSnapshot(file);
    if (current.exists !== expectedIdentity.exists
      || (current.exists && (!sameSnapshot(current, expectedIdentity)
        || !current.bytes.equals(expectedBytes)))) {
      throw new Error('benchmark ledger changed before replacement');
    }
    validateStagedBytes(staged, owned, content);
    renameSync(staged, file);
    const installed = currentDestinationIdentity(file);
    if (!installed.exists || !sameIdentity(installed, owned)) {
      throw new Error('benchmark replacement identity changed');
    }
    closeSync(fd);
    fd = undefined;
    staged = undefined;
  } finally {
    if (fd !== undefined) closeSync(fd);
    if (staged && owned) {
      try {
        const current = lstatSync(staged);
        if (sameIdentity(current, owned)) unlinkSync(staged);
      } catch (error) {
        if (error?.code !== 'ENOENT') throw error;
      }
    }
  }
}

export function percentile(values, ratio) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.max(0, Math.ceil(sorted.length * ratio) - 1)];
}

export function verifyBenchmarks(records) {
  const groups = [];
  let counted = 0;
  for (const host of HOSTS) {
    for (const lane of CERT_LANES) {
      const selected = records.filter((record) => record.host === host && record.lane === lane);
      counted += selected.length;
      const thresholdMs = DEFAULT_DEADLINES_MS[lane];
      const normalized = selected.map((record) => ({
        ...record,
        adjusted_ms: record.raw_ms - (record.test_ms ?? 0) - (record.remote_ci_ms ?? 0),
      }));
      const passingCount = normalized.filter((record) => record.adjusted_ms <= thresholdMs).length;
      const certificationStatus = normalized.length < 20
        ? 'insufficient-records'
        : passingCount < 18 ? 'insufficient-passes' : 'certified';
      groups.push({
        host,
        lane,
        count: normalized.length,
        required_count: 20,
        passing_count: passingCount,
        required_passing: 18,
        threshold_ms: thresholdMs,
        raw_p90_ms: percentile(normalized.map((record) => record.raw_ms), 0.9),
        adjusted_p90_ms: percentile(normalized.map((record) => record.adjusted_ms), 0.9),
        certification_status: certificationStatus,
        passed: certificationStatus === 'certified',
      });
    }
  }
  const unclassified = records.length - counted;
  return {
    passed: groups.every((group) => group.passed),
    groups,
    ...(unclassified > 0 ? { unclassified } : {}),
  };
}

export function validateBenchmarkRecord(record, options = {}) {
  if (!record || typeof record !== 'object' || Array.isArray(record)) {
    throw new Error('benchmark record must be an object');
  }
  if (!HOSTS.includes(record.host)) throw new Error(`record host must be one of: ${HOSTS.join(', ')}`);
  if (!CERT_LANES.includes(record.lane)) throw new Error(`record lane must be one of: ${CERT_LANES.join(', ')}`);
  if (!Number.isFinite(record.raw_ms) || record.raw_ms <= 0) {
    throw new Error('record raw_ms must be a positive number of milliseconds');
  }
  for (const key of ['test_ms', 'remote_ci_ms']) {
    if (record[key] !== undefined && (!Number.isFinite(record[key]) || record[key] < 0)) {
      throw new Error(`record ${key} must be a non-negative number of milliseconds`);
    }
  }
  if ((record.test_ms ?? 0) + (record.remote_ci_ms ?? 0) > record.raw_ms) {
    throw new Error('record timing components exceed raw_ms');
  }
  if (record.recorded_at !== undefined
    && (typeof record.recorded_at !== 'string'
      || !Number.isFinite(Date.parse(record.recorded_at))
      || new Date(record.recorded_at).toISOString() !== record.recorded_at)) {
    throw new Error('record recorded_at must be an ISO timestamp');
  }
  const source = record.source;
  if (source !== undefined && (!options.allowHistorySource || source !== 'history')) {
    throw new Error('benchmark record has an invalid source');
  }
  if (options.allowLegacyRunId === true
    && record.run_id !== undefined
    && (typeof record.run_id !== 'string' || record.run_id.length === 0)) {
    throw new Error('benchmark record has an invalid legacy run identifier');
  }
  if (options.strict) {
    const allowed = new Set([
      'host', 'lane', 'raw_ms', 'test_ms', 'remote_ci_ms', 'recorded_at',
      ...(options.allowHistorySource ? ['source'] : []),
      ...(options.allowLegacyRunId ? ['run_id'] : []),
    ]);
    if (Object.keys(record).some((key) => !allowed.has(key))) {
      throw new Error('benchmark record contains an unknown field');
    }
  }
  return {
    host: record.host,
    lane: record.lane,
    raw_ms: record.raw_ms,
    ...(record.test_ms !== undefined ? { test_ms: record.test_ms } : {}),
    ...(record.remote_ci_ms !== undefined ? { remote_ci_ms: record.remote_ci_ms } : {}),
    ...(record.recorded_at !== undefined
      ? { recorded_at: record.recorded_at }
      : options.stampRecordedAt === false ? {} : { recorded_at: new Date().toISOString() }),
    ...(source === 'history' ? { source } : {}),
  };
}

export function appendBenchmarkRecord(file, record) {
  const normalized = validateBenchmarkRecord(record);
  const lock = acquireLedgerLock(file);
  try {
    const ledger = readLedger(file);
    if (ledger.records.length >= BENCHMARK_LIMITS.ledgerRecords) {
      throw new Error('benchmark ledger record count exceeds limit');
    }
    const records = [...ledger.records, normalized];
    atomicWriteLedger(file, records, ledger.identity, ledger.bytes);
    return { record: normalized, count: records.length };
  } finally {
    releaseLedgerLock(lock);
  }
}

function deriveRawMs(record) {
  const start = Date.parse(record.created_at ?? '');
  const end = Date.parse(record.completed_at ?? '');
  return Number.isFinite(start) && Number.isFinite(end) && end - start >= 0 ? end - start : null;
}

function deriveImportRecord(record) {
  const timing = record.timing ?? {};
  const host = typeof record.host === 'string' && record.host
    ? record.host
    : record.receipts?.[0]?.agent?.host;
  return {
    host,
    lane: record.lane,
    raw_ms: Number.isFinite(timing.raw_ms) ? timing.raw_ms : deriveRawMs(record),
    test_ms: Number.isFinite(timing.test_ms) ? timing.test_ms : 0,
    remote_ci_ms: Number.isFinite(timing.remote_ci_ms) ? timing.remote_ci_ms : 0,
    recorded_at: typeof record.completed_at === 'string' ? record.completed_at : undefined,
  };
}

function incrementReason(reasons, reason) {
  reasons.set(reason, (reasons.get(reason) ?? 0) + 1);
}

function readHistoryFile(file, expected, openedTotal) {
  const fd = openSync(file, constants.O_RDONLY);
  try {
    const opened = fstatSync(fd);
    if (!opened.isFile()) throw new Error('history entry changed while being opened');
    if (opened.size > BENCHMARK_LIMITS.historyEntryBytes) {
      throw new Error('history entry exceeds byte limit');
    }
    openedTotal.bytes += opened.size;
    if (openedTotal.bytes > BENCHMARK_LIMITS.historyTotalBytes) {
      throw new Error('history total exceeds byte limit');
    }
    const changedWhileOpening = !sameSnapshot(expected, opened);
    const bytes = readHandle(fd, opened.size, 'history entry changed while being read');
    const after = fstatSync(fd);
    if (!sameSnapshot(opened, after)) {
      throw new Error('history entry changed while being read');
    }
    if (changedWhileOpening) openedTotal.changedWhileOpening = true;
    return bytes;
  } finally {
    closeSync(fd);
  }
}

function readProjectHistory(projectDir) {
  const dir = runtimePaths(projectDir).history;
  const names = [];
  try {
    const directory = opendirSync(dir);
    let entryCount = 0;
    try {
      for (let entry = directory.readSync(); entry; entry = directory.readSync()) {
        entryCount += 1;
        if (entryCount > BENCHMARK_LIMITS.historyEntries) {
          throw new Error('history entry count exceeds limit');
        }
        if (entry.name.endsWith('.json')) names.push(entry.name);
      }
    } finally {
      directory.closeSync();
    }
    names.sort();
  } catch (error) {
    if (error?.code === 'ENOENT') return { effective: [], reasons: new Map() };
    throw error;
  }
  const metadata = [];
  let totalBytes = 0;
  for (const name of names) {
    const file = path.join(dir, name);
    const stats = lstatSync(file);
    if (!stats.isFile()) throw new Error('history entry must be a regular file');
    if (stats.size > BENCHMARK_LIMITS.historyEntryBytes) {
      throw new Error('history entry exceeds byte limit');
    }
    totalBytes += stats.size;
    if (totalBytes > BENCHMARK_LIMITS.historyTotalBytes) {
      throw new Error('history total exceeds byte limit');
    }
    metadata.push({ file, stats });
  }

  const reasons = new Map();
  const byRun = new Map();
  const openedTotal = { bytes: 0 };
  for (const entry of metadata) {
    let record;
    try {
      record = JSON.parse(readHistoryFile(entry.file, entry.stats, openedTotal).toString('utf8'));
    } catch (error) {
      if (!(error instanceof SyntaxError)) throw error;
      incrementReason(reasons, 'history entry is not valid JSON');
      continue;
    }
    if (!record || typeof record.run_id !== 'string') {
      incrementReason(reasons, 'history entry has no valid run identifier');
      continue;
    }
    if (!byRun.has(record.run_id)) byRun.set(record.run_id, []);
    byRun.get(record.run_id).push(record);
  }
  if (openedTotal.changedWhileOpening) {
    throw new Error('history entry changed while being opened');
  }
  const effective = [];
  for (const group of byRun.values()) {
    const selected = selectEffectiveRecord(group[0], group.slice(1));
    if (selected) effective.push(selected);
  }
  effective.sort((a, b) => a.run_id.localeCompare(b.run_id));
  return { effective, reasons };
}

function canonicalRecords(records) {
  return records.sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
}

export function importBenchmarksFromHistory(projectDir, file) {
  const lock = acquireLedgerLock(file);
  try {
    const ledger = readLedger(file, { allowLegacyRunId: true });
    const existingManual = ledger.records
      .map((record, index) => ({ record, runId: ledger.legacyRunIds[index] }))
      .filter(({ record }) => record?.source !== 'history');
    const { effective, reasons } = readProjectHistory(projectDir);
    const imported = [];
    const importedRunIds = new Set();
    for (const record of effective) {
    if (record.status !== 'completed') {
      incrementReason(reasons, 'run is not completed');
      continue;
    }
    if (typeof record.completed_at !== 'string') {
      incrementReason(reasons, 'completed_at is unavailable; stable completion time is required');
      continue;
    }
    if (!BUILDING_MODES.includes(record.mode)) {
      incrementReason(reasons, 'run mode is not certifiable');
      continue;
    }
    if (!CERT_LANES.includes(record.lane)) {
      incrementReason(reasons, 'run lane is not certifiable');
      continue;
    }
    const derived = deriveImportRecord(record);
    if (!Number.isFinite(derived.raw_ms)) {
      incrementReason(reasons, 'run timing is unavailable');
      continue;
    }
    if (derived.raw_ms - derived.test_ms - derived.remote_ci_ms < 0) {
      incrementReason(reasons, 'run timing components are inconsistent');
      continue;
    }
    try {
      imported.push({ ...validateBenchmarkRecord(derived), source: 'history' });
      importedRunIds.add(record.run_id);
    } catch {
      incrementReason(reasons, 'run timing failed certification validation');
    }
    }

    const manual = existingManual
      .filter(({ runId }) => !importedRunIds.has(runId))
      .map(({ record }) => validateBenchmarkRecord(record, { stampRecordedAt: false }));
    const records = canonicalRecords([...manual, ...imported]);
    if (records.length > BENCHMARK_LIMITS.ledgerRecords) {
      throw new Error('benchmark ledger record count exceeds limit');
    }
    const serialized = `${JSON.stringify(records, null, 2)}\n`;
    if (Buffer.byteLength(serialized) > BENCHMARK_LIMITS.ledgerOutputBytes) {
      throw new Error('benchmark ledger output exceeds byte limit');
    }
    if (!ledger.bytes || !ledger.bytes.equals(Buffer.from(serialized))) {
      atomicWriteLedger(file, records, ledger.identity, ledger.bytes);
    }
    const skipped = [...reasons.entries()]
      .map(([reason, count]) => ({ reason, count }))
      .sort((left, right) => left.reason.localeCompare(right.reason));
    return { imported, skipped, count: records.length };
  } finally {
    releaseLedgerLock(lock);
  }
}

function parseRecordFlags(argv) {
  const flags = parseFlags(argv);
  const numeric = (raw) => (raw === undefined ? undefined : Number(raw));
  return {
    file: flags.file,
    record: {
      host: flags.host,
      lane: flags.lane,
      raw_ms: numeric(flags['raw-ms']),
      test_ms: numeric(flags['test-ms']),
      remote_ci_ms: numeric(flags['remote-ci-ms']),
    },
  };
}

function parseFlags(argv) {
  const flags = {};
  for (let index = 0; index < argv.length; index += 2) {
    const name = argv[index];
    const value = argv[index + 1];
    if (!name?.startsWith('--') || value === undefined) throw new Error('malformed arguments');
    flags[name.slice(2)] = value;
  }
  return flags;
}

function safeErrorMessage(error) {
  const message = typeof error?.message === 'string' ? error.message : '';
  const admitted = [
    /^benchmark /u,
    /^existing benchmark /u,
    /^history /u,
    /^record (?:host|lane|raw_ms|test_ms|remote_ci_ms|recorded_at)/u,
    /^record timing components exceed raw_ms$/u,
    /^malformed arguments$/u,
    /^import requires a project directory$/u,
    /^could not reserve benchmark staging file$/u,
  ];
  return admitted.some((pattern) => pattern.test(message)) ? message : 'benchmark operation failed';
}

function main(argv) {
  if (argv[0] === 'record') {
    const { file, record } = parseRecordFlags(argv.slice(1));
    const appended = appendBenchmarkRecord(path.resolve(file ?? DEFAULT_FILE), record);
    process.stdout.write(`${JSON.stringify({ appended: appended.record, count: appended.count }, null, 2)}\n`);
    return;
  }
  if (argv[0] === 'import') {
    const flags = parseFlags(argv.slice(1));
    if (!flags.project) throw new Error('import requires a project directory');
    const report = importBenchmarksFromHistory(
      path.resolve(flags.project),
      path.resolve(flags.file ?? DEFAULT_FILE),
    );
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    return;
  }
  const fileArg = argv[0] === 'verify' ? argv[1] : argv[0];
  const ledger = readLedger(path.resolve(fileArg ?? DEFAULT_FILE));
  if (ledger.records.length === 0) {
    process.stdout.write(`${JSON.stringify({
      status: 'no-records',
      message: 'no benchmark records yet; append reference runs with record --host <host> --lane <lane> --raw-ms <ms>; certification requires 20 records per host/lane group',
    }, null, 2)}\n`);
    return;
  }
  const report = verifyBenchmarks(ledger.records);
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (!report.passed) process.exitCode = 1;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`benchmark-v2: ${safeErrorMessage(error)}\n`);
    process.exitCode = 1;
  }
}
