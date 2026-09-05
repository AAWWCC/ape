import { constants } from 'node:fs';
import { lstat, mkdir, open, realpath } from 'node:fs/promises';
import path from 'node:path';
import { sha256 } from './canonical.js';
import { diffFiles } from './git.js';
import { withDirLock, withDirLockLeaseMutation } from './lock.js';
import { atomicWriteJson } from './storage.js';

const MAX_BYTES = 1024 * 1024;
const MAX_STARTS = 128;
const MAX_PATHS = 2048;
const TREE = /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/;
const CALL = /^[a-f0-9]{64}$/;
const error = (detail) => new Error(`APE tree attribution evidence ${detail}; preserve the evidence and restore the identified paths before adopting worker output`);

function storePaths(paths, runId) {
  if (typeof runId !== 'string' || !runId || runId.length > 512) throw error('has an invalid run identity');
  const root = path.resolve(paths.root);
  const runtime = path.join(root, '.ape', 'runtime');
  if (path.resolve(paths.runtime) !== runtime) throw error('has an invalid runtime path');
  const directory = path.join(runtime, 'tree-attribution');
  const key = sha256(runId);
  return { root, runtime, directory, file: path.join(directory, `${key}.json`), lock: path.join(directory, `${key}.lock`) };
}

async function safeDirectory(directory, create) {
  let metadata;
  try { metadata = await lstat(directory); }
  catch (cause) {
    if (cause.code !== 'ENOENT') throw cause;
    if (!create) return false;
    await mkdir(directory, { mode: 0o700 }).catch((cause) => { if (cause.code !== 'EEXIST') throw cause; });
    metadata = await lstat(directory);
  }
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) throw error('has an unsafe directory');
  return true;
}

async function prepareStore(store, create = false) {
  const canonicalRoot = await realpath(store.root);
  for (const relative of ['.ape', '.ape/runtime', '.ape/runtime/tree-attribution']) {
    const directory = path.join(store.root, relative);
    if (!await safeDirectory(directory, create)) return false;
    if (await realpath(directory) !== path.join(canonicalRoot, relative)) throw error('has an unsafe ancestor');
  }
  return true;
}

function sameFile(left, right) {
  return ['dev', 'ino', 'mode', 'nlink', 'size', 'mtimeMs', 'ctimeMs'].every((field) => left[field] === right[field]);
}

function ordinaryFile(metadata) {
  return metadata.isFile() && !metadata.isSymbolicLink() && metadata.nlink === 1 && metadata.size <= MAX_BYTES;
}

function validPath(file) {
  return typeof file === 'string' && file.length > 0 && file.length <= 4096 &&
    !file.includes('\0') && !path.posix.isAbsolute(file) && !path.win32.isAbsolute(file) &&
    file.split('/').every((part) => part && !['.', '..'].includes(part));
}

function validateRecord(value, runId) {
  if (!value || value.version !== 1 || value.run_id !== runId || !Array.isArray(value.starts) ||
      value.starts.length > MAX_STARTS || !Array.isArray(value.paths) || value.paths.length > MAX_PATHS ||
      Object.keys(value).some((key) => !['version', 'run_id', 'starts', 'paths', 'reference_tree_sha', 'overflow'].includes(key)) ||
      (value.reference_tree_sha !== undefined && (typeof value.reference_tree_sha !== 'string' || !TREE.test(value.reference_tree_sha))) ||
      (value.overflow !== undefined && value.overflow !== true) ||
      (value.overflow === true && (!value.reference_tree_sha || value.paths.length > 0))) throw error('is corrupt or belongs to another run');
  const starts = new Set();
  const paths = new Set();
  for (const entry of value.starts) {
    if (!entry || typeof entry.call_key !== 'string' || !CALL.test(entry.call_key) ||
        !(typeof entry.tree_sha === 'string' && TREE.test(entry.tree_sha) ||
          entry.tree_sha === null && typeof entry.completed_changed === 'boolean') || starts.has(entry.call_key) ||
        (entry.completed_changed !== undefined && typeof entry.completed_changed !== 'boolean') ||
        Object.keys(entry).some((key) => !['call_key', 'tree_sha', 'completed_changed'].includes(key))) throw error('contains an invalid tool observation');
    starts.add(entry.call_key);
  }
  for (const entry of value.paths) {
    if (!entry || !validPath(entry.path) || typeof entry.reference_tree_sha !== 'string' ||
        !TREE.test(entry.reference_tree_sha) || paths.has(entry.path) ||
        Object.keys(entry).some((key) => !['path', 'reference_tree_sha'].includes(key))) throw error('contains an invalid rejected path');
    paths.add(entry.path);
  }
  return value;
}

async function readRecord(store, runId) {
  let before;
  try { before = await lstat(store.file); }
  catch (cause) { if (cause.code === 'ENOENT') return null; throw cause; }
  if (!ordinaryFile(before)) throw error('is unsafe or oversized');
  const handle = await open(store.file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
  try {
    const opened = await handle.stat();
    if (!ordinaryFile(opened) || !sameFile(before, opened)) throw error('changed while being read');
    const buffer = Buffer.alloc(Number(opened.size) + 1);
    let offset = 0;
    while (offset < buffer.length) {
      const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, offset);
      if (!bytesRead) break;
      offset += bytesRead;
    }
    const after = await handle.stat();
    const current = await lstat(store.file);
    if (offset !== opened.size || !sameFile(opened, after) || !sameFile(opened, current)) throw error('changed while being read');
    let record;
    try { record = JSON.parse(buffer.subarray(0, offset).toString('utf8')); }
    catch { throw error('is corrupt'); }
    return { record: validateRecord(record, runId), metadata: current };
  } finally { await handle.close(); }
}

async function writeRecord(store, runId, record, previous, lease) {
  validateRecord(record, runId);
  if (Buffer.byteLength(JSON.stringify(record, null, 2)) + 1 > MAX_BYTES) throw error('exceeds its bounded storage limit');
  if (!await prepareStore(store)) throw error('lost its private directory before update');
  const current = await lstat(store.file).catch((cause) => { if (cause.code === 'ENOENT') return null; throw cause; });
  if (previous ? !current || !sameFile(previous.metadata, current) : current !== null) throw error('changed before it could be updated');
  await withDirLockLeaseMutation(store.lock, lease, () => atomicWriteJson(store.file, record));
}

async function locked(store, operation) {
  await prepareStore(store, true);
  const metadata = await lstat(store.lock).catch((cause) => { if (cause.code === 'ENOENT') return null; throw cause; });
  if (metadata && (!metadata.isDirectory() || metadata.isSymbolicLink())) throw error('has an unsafe lock');
  return withDirLock(store.lock, operation, {
    staleMs: 10_000, heartbeatMs: 2_500, busyMs: 2_000, serializeLocal: true,
    busyMessage: 'tree attribution evidence is busy; retry the same operation',
  });
}

function emptyRecord(runId) { return { version: 1, run_id: runId, starts: [], paths: [] }; }
function assertTree(tree) { if (typeof tree !== 'string' || !TREE.test(tree)) throw error('has an invalid tree identity'); }
function assertCall(callKey) { if (typeof callKey !== 'string' || !CALL.test(callKey)) throw error('has an invalid hashed tool identity'); }

export async function rememberParentToolStart(paths, runId, callKey, treeSha) {
  if (callKey === null || callKey === undefined) return;
  assertCall(callKey);
  assertTree(treeSha);
  const store = storePaths(paths, runId);
  await locked(store, async (lease) => {
    const previous = await readRecord(store, runId);
    const record = previous?.record ?? emptyRecord(runId);
    // Replayed pre-events must not replace the original before-tree.
    if (record.starts.some((entry) => entry.call_key === callKey)) return;
    record.starts.push({ call_key: callKey, tree_sha: treeSha });
    // An evicted unmatched start falls back to the caller's conservative
    // baseline. Rejected-path evidence is never subject to this eviction.
    record.starts = record.starts.slice(-MAX_STARTS);
    await writeRecord(store, runId, record, previous, lease);
  });
}

export async function takeParentToolStart(paths, runId, callKey) {
  if (callKey === null || callKey === undefined) return null;
  assertCall(callKey);
  const store = storePaths(paths, runId);
  if (!await prepareStore(store) || !await readRecord(store, runId)) return null;
  return locked(store, async () => {
    const previous = await readRecord(store, runId);
    const record = previous?.record;
    const selected = record?.starts.find((entry) => entry.call_key === callKey);
    if (!selected) return null;
    // Keep the snapshot for duplicate host post-events. The completion lookup
    // below distinguishes a replay from an event that still needs observing.
    return selected.tree_sha ?? null;
  });
}

export async function readParentToolResult(paths, runId, callKey) {
  if (callKey === null || callKey === undefined) return null;
  assertCall(callKey);
  const store = storePaths(paths, runId);
  if (!await prepareStore(store)) return null;
  const previous = await readRecord(store, runId);
  const selected = previous?.record.starts.find((entry) => entry.call_key === callKey);
  return typeof selected?.completed_changed === 'boolean' ? { changed: selected.completed_changed } : null;
}

export async function completeParentToolResult(paths, runId, callKey, changed) {
  if (typeof changed !== 'boolean') throw error('has an invalid completed observation');
  if (callKey === null || callKey === undefined) return { changed };
  assertCall(callKey);
  const store = storePaths(paths, runId);
  return locked(store, async (lease) => {
    const previous = await readRecord(store, runId);
    const record = previous?.record ?? emptyRecord(runId);
    const selected = record.starts.find((entry) => entry.call_key === callKey);
    if (typeof selected?.completed_changed === 'boolean') return { changed: selected.completed_changed };
    if (selected) selected.completed_changed = changed;
    else record.starts.push({ call_key: callKey, tree_sha: null, completed_changed: changed });
    record.starts = record.starts.slice(-MAX_STARTS);
    await writeRecord(store, runId, record, previous, lease);
    return { changed };
  });
}

export async function recordRejectedParentChange(paths, runId, beforeTree, afterTree, changedFiles, callKey = null) {
  assertTree(beforeTree);
  assertTree(afterTree);
  if (callKey !== null && callKey !== undefined) assertCall(callKey);
  if (beforeTree === afterTree || (Array.isArray(changedFiles) && changedFiles.length === 0)) {
    return completeParentToolResult(paths, runId, callKey, false);
  }
  const store = storePaths(paths, runId);
  return locked(store, async (lease) => {
    const previous = await readRecord(store, runId);
    const record = previous?.record ?? emptyRecord(runId);
    const selected = callKey ? record.starts.find((entry) => entry.call_key === callKey) : null;
    if (typeof selected?.completed_changed === 'boolean') return { changed: selected.completed_changed };
    record.reference_tree_sha ??= record.paths[0]?.reference_tree_sha ?? beforeTree;
    const overflow = () => {
      // A bounded refusal must remain durable even when its path list cannot
      // fit. Whole-tree restoration is deliberately conservative and never
      // loses the earliest unresolved reference to a later parent mutation.
      record.overflow = true;
      record.paths = [];
    };
    if (!Array.isArray(changedFiles) || changedFiles.length > MAX_PATHS || !changedFiles.every(validPath)) overflow();
    const known = new Set(record.paths.map((entry) => entry.path));
    for (const file of record.overflow ? [] : changedFiles) if (!known.has(file)) {
      record.paths.push({ path: file, reference_tree_sha: beforeTree });
      known.add(file);
    }
    record.paths.sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0);
    if (callKey) {
      if (selected) selected.completed_changed = true;
      else record.starts.push({ call_key: callKey, tree_sha: null, completed_changed: true });
      record.starts = record.starts.slice(-MAX_STARTS);
    }
    if (record.paths.length > MAX_PATHS || Buffer.byteLength(JSON.stringify(record, null, 2)) + 1 > MAX_BYTES) overflow();
    await writeRecord(store, runId, record, previous, lease);
    return { changed: true };
  });
}

export async function checkTreeAttribution(paths, runId, currentTree) {
  if (typeof currentTree !== 'function') assertTree(currentTree);
  const store = storePaths(paths, runId);
  // Ordinary projects and runs with no observations stay read-only here.
  if (!await prepareStore(store) || !await readRecord(store, runId)) return { blocked: false, affected_paths: [], restoration: [] };
  return locked(store, async (lease) => {
    const previous = await readRecord(store, runId);
    const record = previous?.record;
    if (!record?.paths.length && !record?.overflow) return { blocked: false, affected_paths: [], restoration: [] };
    const observedTree = typeof currentTree === 'function' ? await currentTree() : currentTree;
    assertTree(observedTree);
    if (record.overflow) {
      if (observedTree !== record.reference_tree_sha) return { blocked: true, affected_paths: ['.'],
        restoration: [{ path: '.', reference_tree_sha: record.reference_tree_sha }], restoration_scope: 'tree' };
      delete record.overflow;
      delete record.reference_tree_sha;
      await writeRecord(store, runId, record, previous, lease);
      return { blocked: false, affected_paths: [], restoration: [] };
    }
    const differences = new Map();
    for (const reference of new Set(record.paths.map((entry) => entry.reference_tree_sha))) {
      differences.set(reference, new Set(reference === observedTree ? [] : await diffFiles(store.root, reference, observedTree)));
    }
    const unresolved = record.paths.filter((entry) => differences.get(entry.reference_tree_sha).has(entry.path));
    if (unresolved.length !== record.paths.length) {
      record.paths = unresolved;
      if (!unresolved.length) delete record.reference_tree_sha;
      await writeRecord(store, runId, record, previous, lease);
    }
    return { blocked: unresolved.length > 0, affected_paths: unresolved.map((entry) => entry.path),
      restoration: unresolved.map((entry) => ({ ...entry })) };
  });
}

function quotedPathLabel(value) {
  let label = '';
  let truncated = false;
  for (const character of value) {
    const escaped = JSON.stringify(character).slice(1, -1).replace(/[\p{Cc}\p{Cf}\u2028\u2029]/gu,
      (character) => character.split('').map((unit) => `\\u${unit.charCodeAt(0).toString(16).padStart(4, '0')}`).join(''));
    if (label.length + escaped.length > 155) { truncated = true; break; }
    label += escaped;
  }
  return `"${label}${truncated ? '...' : ''}"`;
}

export function treeAttributionRefusal(observation) {
  const entries = Array.isArray(observation?.restoration) ? observation.restoration : [];
  const count = Array.isArray(observation?.affected_paths) ? observation.affected_paths.length : entries.length;
  const references = entries.slice(0, 4).map((entry) =>
    `${quotedPathLabel(typeof entry?.path === 'string' ? entry.path : 'unknown path')} at ${
      typeof entry?.reference_tree_sha === 'string' && TREE.test(entry.reference_tree_sha) ? entry.reference_tree_sha : 'unavailable reference'}`);
  const recovery = observation?.restoration_scope === 'tree'
    ? 'The bounded path record overflowed; preserve current work and restore the complete tree to the recorded reference through an authorized repair, then retry.'
    : 'Preserve current work. Restore the listed paths to their recorded reference tree entries through an authorized repair, then retry.';
  return 'APE result denied: unresolved parent-tool tree change cannot be attributed to a worker. ' +
    `Affected paths: ${count}${references.length ? `; restore ${references.join('; ')}` : ''}. ` +
    recovery;
}
