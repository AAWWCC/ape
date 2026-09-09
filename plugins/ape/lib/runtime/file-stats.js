import { constants, openSync, closeSync, fstatSync, lstatSync } from 'node:fs';
import { lstat, open } from 'node:fs/promises';

// Older Windows libuv uses a 64-bit volume serial for pathname stats and the
// 32-bit serial for handle stats. Match libuv's correction without dropping
// the device or inode from identity checks: https://github.com/libuv/libuv/pull/4698
// Request BigInt first; converting the 64-bit value to Number loses low bits.
export function comparableFileStats(metadata, platform = process.platform) {
  if (platform !== 'win32') return metadata;
  const exactInteger = (value) => {
    if (typeof value === 'bigint') return value;
    if (Number.isSafeInteger(value)) return BigInt(value);
    throw new Error('file identity requires exact integer metadata');
  };
  const result = { ...metadata,
    dev: String(BigInt.asUintN(32, exactInteger(metadata.dev))),
    ino: String(exactInteger(metadata.ino)),
  };
  for (const field of ['mode', 'nlink', 'uid', 'gid', 'rdev', 'size', 'blksize', 'blocks']) {
    result[field] = Number(metadata[field]);
  }
  for (const field of ['atime', 'mtime', 'ctime', 'birthtime']) {
    const ns = metadata[`${field}Ns`];
    result[`${field}Ms`] = typeof ns === 'bigint'
      ? Number(ns / 1_000_000n) + Number(ns % 1_000_000n) / 1_000_000
      : Number(metadata[`${field}Ms`]);
  }
  // BigIntStats predicates must retain their original BigInt mode receiver.
  for (const method of ['isFile', 'isDirectory', 'isSymbolicLink', 'isBlockDevice',
    'isCharacterDevice', 'isFIFO', 'isSocket']) result[method] = metadata[method].bind(metadata);
  return result;
}

function changedPathIdentity() {
  return Object.assign(new Error('file identity changed while inspecting the pathname; retry the operation'), {
    code: 'APE_FILE_IDENTITY_CHANGED',
  });
}

export async function lstatFile(file) {
  const windows = process.platform === 'win32';
  const before = comparableFileStats(await lstat(file, { bigint: windows }));
  if (!windows || before.dev !== '0' || !before.isFile() || before.isSymbolicLink()) return before;

  // Some Windows pathname stat APIs omit the volume identifier entirely.
  // Obtain it from a separate read-only handle, then recheck the pathname.
  // Callers still compare two independently opened device/inode identities;
  // zero is never treated as a wildcard for their descriptor comparison.
  let handle;
  try {
    handle = await open(file, constants.O_RDONLY |
      (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
    const opened = await statFileHandle(handle);
    const after = comparableFileStats(await lstat(file, { bigint: true }));
    const fields = ['ino', 'mode', 'nlink', 'size', 'mtimeNs', 'ctimeNs'];
    if (!opened.isFile() || opened.isSymbolicLink() || !after.isFile() || after.isSymbolicLink() ||
        fields.some(field => before[field] !== opened[field] || before[field] !== after[field]) ||
        (after.dev !== '0' && after.dev !== opened.dev)) {
      throw changedPathIdentity();
    }
    return opened;
  } catch (error) {
    // The first lstat established that the entry exists. Losing it later is
    // contention, not evidence that a live run has disappeared.
    if (['ENOENT', 'ELOOP', 'ENXIO', 'EISDIR'].includes(error?.code)) throw changedPathIdentity();
    throw error;
  } finally {
    await handle?.close();
  }
}

export async function statFileHandle(handle) {
  return comparableFileStats(await handle.stat({ bigint: process.platform === 'win32' }));
}

export function statFileDescriptor(descriptor) {
  return comparableFileStats(fstatSync(descriptor, { bigint: process.platform === 'win32' }));
}

// Synchronous counterpart for hook/status readers. Preserve the same exact
// Windows volume/inode comparison, including zero-volume pathname recovery.
export function lstatFileSync(file) {
  const windows = process.platform === 'win32';
  const before = comparableFileStats(lstatSync(file, { bigint: windows }));
  if (!windows || before.dev !== '0' || !before.isFile() || before.isSymbolicLink()) return before;
  let descriptor;
  try {
    descriptor = openSync(file, constants.O_RDONLY |
      (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
    const opened = statFileDescriptor(descriptor);
    const after = comparableFileStats(lstatSync(file, { bigint: true }));
    const fields = ['ino', 'mode', 'nlink', 'size', 'mtimeNs', 'ctimeNs'];
    if (!opened.isFile() || opened.isSymbolicLink() || !after.isFile() || after.isSymbolicLink() ||
        fields.some(field => before[field] !== opened[field] || before[field] !== after[field]) ||
        (after.dev !== '0' && after.dev !== opened.dev)) {
      throw changedPathIdentity();
    }
    return opened;
  } catch (error) {
    if (['ENOENT', 'ELOOP', 'ENXIO', 'EISDIR'].includes(error?.code)) throw changedPathIdentity();
    throw error;
  } finally { if (descriptor !== undefined) closeSync(descriptor); }
}
