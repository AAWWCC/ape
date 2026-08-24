#!/usr/bin/env node

import { randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { constants } from 'node:fs';
import { link, lstat, mkdtemp, open, readdir, rename, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPORT_BYTES = 16 * 1024 * 1024;
const OUTPUT_BYTES = 4 * 1024 * 1024;
const LOCK_BYTES = 4 * 1024;
const LOCK_LEASE_MS = 60_000;
const root = dirname(dirname(fileURLToPath(import.meta.url)));
const scratch = await mkdtemp(join(tmpdir(), 'ape-test-timings-'));
const report = join(scratch, 'vitest.json');
const destination = join(root, '.github', 'test-durations.json');

function sameIdentity(left, right) {
  return left.dev === right.dev && left.ino === right.ino;
}

function sameSnapshot(left, right) {
  return sameIdentity(left, right)
    && left.size === right.size
    && left.mtimeMs === right.mtimeMs
    && left.ctimeMs === right.ctimeMs;
}

async function acquireWriterLock() {
  const file = join(dirname(destination), '.test-durations.lock');
  const deadline = Date.now() + 30_000;
  while (true) {
    try {
      const handle = await open(file, 'wx', 0o600);
      try {
        const metadata = await writeLockMetadata(handle);
        return { file, handle, ...metadata };
      } catch (error) {
        const owned = await handle.stat().catch(() => null);
        await handle.close().catch(() => {});
        const current = await lstat(file).catch(() => null);
        if (owned && current && sameIdentity(owned, current)) await rm(file).catch(() => {});
        throw error;
      }
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
      const reclaimed = await tryReclaimWriterLock(file);
      if (reclaimed) return reclaimed;
      if (Date.now() >= deadline) throw new Error('duration writer lock is busy');
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 10));
    }
  }
}

async function writeLockMetadata(handle) {
  const bytes = Buffer.from(`${JSON.stringify({ pid: process.pid })}\n`);
  await handle.chmod(0o600);
  await handle.truncate(0);
  await handle.write(bytes, 0, bytes.length, 0);
  await handle.sync();
  return { identity: await handle.stat(), bytes };
}

async function acquireReclaimCandidacy(file) {
  const directory = dirname(file);
  const prefix = `${basename(file)}.reclaimer-`;
  const candidate = join(
    directory,
    `${prefix}${String(Date.now()).padStart(13, '0')}-${process.pid}-${randomBytes(16).toString('hex')}`,
  );
  const handle = await open(candidate, 'wx', 0o600);
  const owned = await handle.stat();
  await handle.close();
  // Keep the winning candidacy published through the entire in-place
  // transition. A killed reclaimer leaves a PID-named artifact that a later
  // process can ignore once that PID is confirmed dead.
  await new Promise((resolvePromise) => setTimeout(resolvePromise, 100));
  const contenders = [];
  for (const name of await readdir(directory)) {
    if (!name.startsWith(prefix)) continue;
    const match = name.slice(prefix.length).match(/^(\d{13})-(\d+)-/u);
    if (!match) continue;
    const stats = await lstat(join(directory, name)).catch((error) => {
      if (error?.code === 'ENOENT') return null;
      throw error;
    });
    if (!stats?.isFile()) continue;
    const pid = Number(match[2]);
    try {
      process.kill(pid, 0);
    } catch (error) {
      if (error?.code === 'ESRCH') continue;
    }
    contenders.push(name);
  }
  contenders.sort();
  return { file: candidate, identity: owned, priority: contenders[0] === basename(candidate) };
}

async function releaseReclaimCandidacy(candidacy) {
  const current = await lstat(candidacy.file).catch((error) => {
    if (error?.code === 'ENOENT') return null;
    throw error;
  });
  if (current && sameIdentity(current, candidacy.identity)) await rm(candidacy.file);
}

async function readLockSnapshot(file) {
  const before = await fs.promises.lstat(file);
  if (!before.isFile()) return null;
  const handle = await open(file, constants.O_RDONLY);
  try {
    const opened = await handle.stat();
    if (!sameIdentity(before, opened) || opened.size !== before.size) return null;
    if (opened.size > LOCK_BYTES) {
      const after = await handle.stat();
      if (!sameSnapshot(opened, after)) return null;
      return { stats: opened, bytes: null };
    }
    const bytes = Buffer.alloc(opened.size);
    let offset = 0;
    while (offset < bytes.length) {
      const { bytesRead } = await handle.read(bytes, offset, bytes.length - offset, offset);
      if (bytesRead === 0) return null;
      offset += bytesRead;
    }
    const after = await handle.stat();
    if (!sameSnapshot(opened, after)) return null;
    return { stats: opened, bytes };
  } finally {
    await handle.close();
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

async function tryReclaimWriterLock(file) {
  let observed;
  try {
    observed = await readLockSnapshot(file);
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
  const candidacy = await acquireReclaimCandidacy(file);
  if (!candidacy.priority) {
    await releaseReclaimCandidacy(candidacy);
    return null;
  }

  // Quarantine the stale namespace entry without ever writing through its
  // untrusted inode. The hard-link claim also makes a pre-metadata crash
  // recoverable; only a newly-created private claim is rewritten.
  let claim = `${file}.reclaim`;
  let handle;
  let oldClaimed = false;
  let freshClaimIdentity;
  let primaryPublished = false;
  let writtenMetadata;
  try {
    current = await readLockSnapshot(file).catch(() => null);
    if (!sameLockSnapshot(current, observed)) return null;
    try {
      await link(file, claim);
      oldClaimed = true;
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
      const existingClaim = await lstat(claim);
      if (sameIdentity(existingClaim, observed.stats)) {
        oldClaimed = true;
      } else {
        claim = `${file}.reclaim-${process.pid}-${randomBytes(16).toString('hex')}`;
        await link(file, claim);
        oldClaimed = true;
      }
    }
    const claimedSnapshot = await readLockSnapshot(claim).catch(() => null);
    current = await readLockSnapshot(file).catch(() => null);
    if (!sameReclaimableLock(claimedSnapshot, observed)
      || !sameReclaimableLock(current, observed)) {
      throw new Error('duration writer lock changed during reclaim');
    }

    // Removing these two lock-namespace links cannot alter any other hard link
    // to the stale inode. A competing normal acquirer may win the empty primary
    // name; the exclusive publish below then fails closed.
    await rm(file);
    current = await readLockSnapshot(claim).catch(() => null);
    if (!sameReclaimableLock(current, observed)) {
      throw new Error('duration writer lock changed during reclaim');
    }
    await rm(claim);
    oldClaimed = false;

    const reserved = await open(claim, 'wx', 0o600);
    freshClaimIdentity = await reserved.stat();
    await reserved.close();
    await link(claim, file);
    primaryPublished = true;
    handle = await open(claim, 'r+');
    const openedFresh = await handle.stat();
    const publishedFresh = await lstat(file);
    if (!sameIdentity(openedFresh, freshClaimIdentity)
      || !sameIdentity(publishedFresh, freshClaimIdentity)) {
      throw new Error('duration writer lock changed during reclaim');
    }
    writtenMetadata = await writeLockMetadata(handle);
    const ownedClaim = await readLockSnapshot(claim);
    const ownedPrimary = await readLockSnapshot(file).catch(() => null);
    if (!ownedClaim
      || !sameSnapshot(ownedClaim.stats, writtenMetadata.identity)
      || ownedClaim.bytes === null
      || !ownedClaim.bytes.equals(writtenMetadata.bytes)
      || !ownedPrimary
      || !sameSnapshot(ownedPrimary.stats, writtenMetadata.identity)
      || ownedPrimary.bytes === null
      || !ownedPrimary.bytes.equals(writtenMetadata.bytes)) {
      throw new Error('duration writer lock claim changed during reclaim');
    }
    await rm(claim);
    freshClaimIdentity = undefined;
    return { file, handle, identity: await handle.stat(), bytes: writtenMetadata.bytes };
  } catch (error) {
    await handle?.close().catch(() => {});
    if (primaryPublished && freshClaimIdentity) {
      const primary = await lstat(file).catch(() => null);
      if (primary && sameIdentity(primary, freshClaimIdentity)) await rm(file).catch(() => {});
    }
    if (freshClaimIdentity) {
      const freshClaim = await lstat(claim).catch(() => null);
      if (freshClaim && sameIdentity(freshClaim, freshClaimIdentity)) await rm(claim).catch(() => {});
    } else if (oldClaimed) {
      const claimSnapshot = await readLockSnapshot(claim).catch(() => null);
      if (sameReclaimableLock(claimSnapshot, observed)) await rm(claim).catch(() => {});
    }
    if (error?.code === 'EEXIST' || error?.code === 'ENOENT') return null;
    throw error;
  } finally {
    await releaseReclaimCandidacy(candidacy);
  }
}

async function releaseWriterLock(lock) {
  await lock.handle.close();
  const current = await readLockSnapshot(lock.file).catch((error) => {
    if (error?.code === 'ENOENT') return null;
    throw error;
  });
  if (!current
    || !sameSnapshot(current.stats, lock.identity)
    || !current.bytes.equals(lock.bytes)) return;
  const released = `${lock.file}.release-${randomBytes(16).toString('hex')}`;
  await rename(lock.file, released);
  const moved = await lstat(released).catch(() => null);
  if (moved && sameIdentity(moved, lock.identity)) await rm(released);
}

async function identity(file, allowMissing = false) {
  try {
    const stats = await lstat(file);
    if (!stats.isFile()) throw new Error('duration destination must be a regular file');
    return {
      exists: true,
      dev: stats.dev,
      ino: stats.ino,
      size: stats.size,
      mtimeMs: stats.mtimeMs,
      ctimeMs: stats.ctimeMs,
    };
  } catch (error) {
    if (allowMissing && error?.code === 'ENOENT') return { exists: false };
    throw error;
  }
}

async function destinationSnapshot(file, allowMissing = false) {
  let before;
  try {
    before = await lstat(file);
  } catch (error) {
    if (allowMissing && error?.code === 'ENOENT') return { exists: false, bytes: null };
    throw error;
  }
  if (!before.isFile() || before.size > OUTPUT_BYTES) {
    throw new Error('duration destination changed during refresh');
  }
  const handle = await open(file, constants.O_RDONLY);
  try {
    const opened = await handle.stat();
    if (!sameIdentity(before, opened) || opened.size !== before.size) {
      throw new Error('duration destination changed during refresh');
    }
    const bytes = Buffer.alloc(opened.size);
    let offset = 0;
    while (offset < bytes.length) {
      const { bytesRead } = await handle.read(bytes, offset, bytes.length - offset, offset);
      if (bytesRead === 0) throw new Error('duration destination changed during refresh');
      offset += bytesRead;
    }
    const after = await handle.stat();
    if (!sameSnapshot(opened, after)) throw new Error('duration destination changed during refresh');
    return { exists: true, ...opened, bytes };
  } finally {
    await handle.close();
  }
}

async function validateStagedBytes(file, owned, expectedBytes) {
  const before = await lstat(file);
  if (!before.isFile() || !sameIdentity(before, owned) || before.size !== expectedBytes.length) {
    throw new Error('duration staging identity changed');
  }
  const handle = await open(file, constants.O_RDONLY);
  try {
    const opened = await handle.stat();
    if (!sameIdentity(opened, owned) || opened.size !== expectedBytes.length) {
      throw new Error('duration staging validation failed');
    }
    const bytes = Buffer.alloc(opened.size);
    let offset = 0;
    while (offset < bytes.length) {
      const { bytesRead } = await handle.read(bytes, offset, bytes.length - offset, offset);
      if (bytesRead === 0) throw new Error('duration staging validation failed');
      offset += bytesRead;
    }
    const after = await handle.stat();
    if (!sameSnapshot(opened, after) || !bytes.equals(expectedBytes)) {
      throw new Error('duration staging validation failed');
    }
  } finally {
    await handle.close();
  }
}

async function readBoundedJson(file, byteLimit, label) {
  const handle = await open(file, constants.O_RDONLY);
  try {
    const stats = await handle.stat();
    if (!stats.isFile()) throw new Error(`${label} must be a regular file`);
    if (stats.size > byteLimit) throw new Error(`${label} exceeds byte limit`);
    const bytes = Buffer.alloc(stats.size);
    let offset = 0;
    while (offset < bytes.length) {
      const { bytesRead } = await handle.read(bytes, offset, bytes.length - offset, offset);
      if (bytesRead === 0) throw new Error(`${label} changed while being read`);
      offset += bytesRead;
    }
    return JSON.parse(bytes.toString('utf8'));
  } finally {
    await handle.close();
  }
}

async function inventory() {
  const entries = await readdir(join(root, '__tests__'), { recursive: true });
  return entries
    .map((entry) => `__tests__/${String(entry).replaceAll('\\', '/')}`)
    .filter((entry) => entry.endsWith('.test.js'))
    .sort();
}

async function atomicReplace(content, expectedDestination) {
  if (Buffer.byteLength(content) > OUTPUT_BYTES) throw new Error('duration output exceeds byte limit');
  let staged;
  let owned;
  let handle;
  try {
    for (let attempt = 0; attempt < 16; attempt += 1) {
      staged = join(dirname(destination), `.test-durations.${randomBytes(16).toString('hex')}.tmp`);
      try {
        handle = await open(staged, 'wx', 0o600);
        owned = await handle.stat();
        break;
      } catch (error) {
        if (error?.code !== 'EEXIST') throw error;
      }
    }
    if (!handle) throw new Error('could not reserve duration staging file');
    await handle.writeFile(content, 'utf8');
    await handle.sync();
    const stagedStats = await handle.stat();
    if (stagedStats.size !== Buffer.byteLength(content) || stagedStats.size > OUTPUT_BYTES) {
      throw new Error('duration staging validation failed');
    }
    const validationHandle = await open(staged, constants.O_RDONLY);
    try {
      const validationStats = await validationHandle.stat();
      if (!sameIdentity(validationStats, owned) || validationStats.size !== stagedStats.size) {
        throw new Error('duration staging validation failed');
      }
      const bytes = Buffer.alloc(validationStats.size);
      let offset = 0;
      while (offset < bytes.length) {
        const { bytesRead } = await validationHandle.read(bytes, offset, bytes.length - offset, offset);
        if (bytesRead === 0) throw new Error('duration staging validation failed');
        offset += bytesRead;
      }
      JSON.parse(bytes.toString('utf8'));
    } finally {
      await validationHandle.close();
    }
    const currentDestination = await destinationSnapshot(destination, true);
    if (currentDestination.exists !== expectedDestination.exists
      || (currentDestination.exists && (!sameSnapshot(currentDestination, expectedDestination)
        || !currentDestination.bytes.equals(expectedDestination.bytes)))) {
      throw new Error('duration destination changed during refresh');
    }
    await validateStagedBytes(staged, owned, Buffer.from(content));
    await rename(staged, destination);
    const installed = await identity(destination);
    if (!sameIdentity(installed, owned)) throw new Error('duration replacement identity changed');
    await handle.close();
    handle = undefined;
    staged = undefined;
  } finally {
    await handle?.close().catch(() => {});
    if (staged && owned) {
      const current = await lstat(staged).catch(() => null);
      if (current && sameIdentity(current, owned)) await rm(staged).catch(() => {});
    }
  }
}

let writerLock;
try {
  writerLock = await acquireWriterLock();
  const expectedDestination = await destinationSnapshot(destination, true);
  const vitest = join(root, 'node_modules', 'vitest', 'vitest.mjs');
  const run = spawnSync(process.execPath, [
    vitest,
    'run',
    '--no-file-parallelism',
    '--reporter=json',
    `--outputFile=${report}`,
    ...process.argv.slice(2),
  ], { cwd: root, stdio: 'inherit' });
  if (run.error) throw run.error;
  if (run.status !== 0) {
    throw new Error(`timing suite failed with exit code ${run.status}; existing shard weights were not changed`);
  }

  const payload = await readBoundedJson(report, REPORT_BYTES, 'timing report');
  if (!payload || typeof payload !== 'object' || payload.success !== true || !Array.isArray(payload.testResults)) {
    throw new Error('timing report is malformed or unsuccessful');
  }
  const expected = await inventory();
  const expectedSet = new Set(expected);
  const durations = new Map();
  for (const result of payload.testResults) {
    if (!result || typeof result !== 'object' || result.status !== 'passed') {
      throw new Error('timing report contains a failed or malformed test result');
    }
    const absolute = resolve(String(result.name ?? ''));
    const file = relative(root, absolute).split(sep).join('/');
    if (file.startsWith('../') || file === '..' || !expectedSet.has(file)) {
      throw new Error('timing report contains an unexpected test file');
    }
    if (durations.has(file)) throw new Error('timing report contains a duplicate test file');
    const start = Number(result.startTime);
    const end = Number(result.endTime);
    if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) {
      throw new Error('timing report contains invalid timing values');
    }
    const delta = end - start;
    if (!Number.isFinite(delta) || delta <= 0) {
      throw new Error('timing report contains invalid timing values');
    }
    const duration = Math.max(1, Math.round(delta));
    if (!Number.isFinite(duration) || duration <= 0) {
      throw new Error('timing report contains invalid timing values');
    }
    durations.set(file, duration);
  }
  if (durations.size !== expected.length || expected.some((file) => !durations.has(file))) {
    throw new Error('timing report does not exactly cover the test inventory');
  }
  const sorted = Object.fromEntries(expected.map((file) => [file, durations.get(file)]));
  const serialized = `${JSON.stringify(sorted, null, 2)}\n`;
  await atomicReplace(serialized, expectedDestination);
  process.stdout.write(`Updated ${relative(root, destination)} with ${expected.length} test-file durations.\n`);
} finally {
  if (writerLock) await releaseWriterLock(writerLock);
  await rm(scratch, { recursive: true, force: true });
}
