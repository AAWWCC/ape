import { lstat } from 'node:fs/promises';

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

export async function lstatFile(file) {
  return comparableFileStats(await lstat(file, { bigint: process.platform === 'win32' }));
}

export async function statFileHandle(handle) {
  return comparableFileStats(await handle.stat({ bigint: process.platform === 'win32' }));
}
