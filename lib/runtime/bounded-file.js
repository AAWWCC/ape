import { constants, openSync, closeSync, readSync } from 'node:fs';
import { open } from 'node:fs/promises';
import { lstatFile, statFileHandle, lstatFileSync, statFileDescriptor } from './file-stats.js';

function unsafeFile() {
  return Object.assign(new Error('runtime metadata is not a bounded regular file or changed during read'), {
    code: 'APE_UNSAFE_FILE',
  });
}

// Opening a FIFO can outlive every caller deadline. Check the leaf and open
// nonblocking/no-follow, then bind the bounded read to that exact descriptor.
// Link-count changes are allowed: run-lock publication briefly has two names.
export async function readBoundedFile(file, maxBytes) {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) throw new Error('invalid runtime file byte limit');
  const before = await lstatFile(file);
  const ordinary = (entry) => entry.isFile() && !entry.isSymbolicLink() && entry.size <= maxBytes;
  if (!ordinary(before)) throw unsafeFile();
  const handle = await open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
  try {
    const opened = await statFileHandle(handle);
    if (!ordinary(opened) || before.dev !== opened.dev || before.ino !== opened.ino) throw unsafeFile();
    const bytes = Buffer.alloc(opened.size + 1);
    let offset = 0;
    while (offset < bytes.length) {
      const read = await handle.read(bytes, offset, bytes.length - offset, offset);
      if (read.bytesRead === 0) break;
      offset += read.bytesRead;
    }
    const after = await statFileHandle(handle);
    if (offset !== opened.size || after.size !== opened.size || after.mtimeMs !== opened.mtimeMs) throw unsafeFile();
    return bytes.subarray(0, offset);
  } finally { await handle.close(); }
}

export async function readBoundedJson(file, maxBytes, fallback = undefined) {
  try { return JSON.parse((await readBoundedFile(file, maxBytes)).toString('utf8')); }
  catch (error) {
    if (error?.code === 'ENOENT' && fallback !== undefined) return fallback;
    throw error;
  }
}

// The hook policy is synchronous. Use a nonblocking descriptor with the same
// bounded sentinel read, rather than readFileSync (which waits on a FIFO).
export function readBoundedFileSync(file, maxBytes) {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) throw new Error('invalid runtime file byte limit');
  const before = lstatFileSync(file);
  const ordinary = (entry) => entry.isFile() && !entry.isSymbolicLink() && entry.size <= maxBytes;
  if (!ordinary(before)) throw unsafeFile();
  const descriptor = openSync(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
  try {
    const opened = statFileDescriptor(descriptor);
    if (!ordinary(opened) || before.dev !== opened.dev || before.ino !== opened.ino) throw unsafeFile();
    const bytes = Buffer.alloc(opened.size + 1);
    let offset = 0;
    while (offset < bytes.length) {
      const count = readSync(descriptor, bytes, offset, bytes.length - offset, offset);
      if (count === 0) break;
      offset += count;
    }
    const after = statFileDescriptor(descriptor);
    if (offset !== opened.size || after.size !== opened.size ||
        after.mtimeMs !== opened.mtimeMs || after.ctimeMs !== opened.ctimeMs) throw unsafeFile();
    return bytes.subarray(0, offset);
  } finally { closeSync(descriptor); }
}

export function readBoundedJsonSync(file, maxBytes) {
  return JSON.parse(readBoundedFileSync(file, maxBytes).toString('utf8'));
}
