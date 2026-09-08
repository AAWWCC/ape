import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { link, mkdir, open, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import { lstatFile, statFileHandle } from './file-stats.js';

// Node cannot open directory handles for fsync on Windows. On POSIX, sync
// directory entries as well as file contents; propagate real I/O failures.
export async function syncDirectory(directory) {
  if (process.platform === 'win32') return;
  const handle = await open(directory, 'r');
  try {
    await handle.sync();
  } catch (error) {
    // Some filesystems do not implement directory fsync.
    if (!['EINVAL', 'ENOTSUP', 'EOPNOTSUPP'].includes(error?.code)) throw error;
  } finally {
    await handle.close();
  }
}

export async function ensureDir(dir) {
  const firstCreated = await mkdir(dir, { recursive: true });
  if (firstCreated === undefined) return;
  const first = path.resolve(firstCreated);
  for (let created = path.resolve(dir); ; created = path.dirname(created)) {
    await syncDirectory(path.dirname(created));
    if (created === first || created === path.dirname(created)) break;
  }
}

export async function readJson(file, fallback = undefined) {
  let handle;
  try {
    // Generic ledgers retain their existing size and symlink-to-file
    // contracts. Even those callers must never wait for a FIFO writer or
    // read a device: inspect the nonblocking descriptor before reading JSON.
    handle = await open(file, constants.O_RDONLY | (constants.O_NONBLOCK ?? 0));
    if (!(await handle.stat()).isFile()) {
      throw Object.assign(new Error('JSON storage entry is not a regular file'), { code: 'APE_UNSAFE_FILE' });
    }
    return JSON.parse(await handle.readFile('utf8'));
  } catch (error) {
    if (error?.code === 'ENOENT' && fallback !== undefined) return fallback;
    throw error;
  } finally { await handle?.close(); }
}

const WIN32_TRANSIENT_RENAME_CODES = ['EPERM', 'EACCES', 'EBUSY'];

// Retry transient Windows reader/AV holds, retaining the old complete file
// when the retry budget expires. Never copy in place or delete the target:
// either would allow a failed replacement to damage caller-owned settings.
export async function replaceFile(temporary, file) {
  for (let attempt = 0; ; attempt += 1) {
    try {
      await rename(temporary, file);
      break;
    } catch (error) {
      if (process.platform !== 'win32' || attempt >= 10 ||
          !WIN32_TRANSIENT_RENAME_CODES.includes(error?.code)) throw error;
      await new Promise((resolve) => setTimeout(resolve, 10 * (attempt + 1)));
    }
  }
  await syncDirectory(path.dirname(file));
}

export async function atomicWriteJson(file, value) {
  await atomicReplaceText(file, `${JSON.stringify(value, null, 2)}\n`);
}

// Text replacement preserves the caller's permissions; the default remains
// private for runtime state. A failed write always removes its staged file.
export async function atomicReplaceText(file, text, { mode = 0o600 } = {}) {
  await ensureDir(path.dirname(file));
  const temporary = `${file}.${process.pid}.${Date.now()}.${randomUUID().slice(0, 8)}.tmp`;
  const handle = await open(temporary, 'wx', mode);
  try {
    try {
      // open() filters through umask; chmod preserves the caller's exact mode.
      await handle.chmod(mode);
      await handle.writeFile(text, 'utf8');
      await handle.sync();
    } finally {
      await handle.close();
    }
    await replaceFile(temporary, file);
  } finally {
    await rm(temporary, { force: true }).catch(() => {});
  }
}

// Audit appends sync their bytes before returning. This improves durability;
// it does not make an append atomic across power loss halfway through a write.
export async function appendJsonLine(file, value) {
  const text = `${JSON.stringify(value)}\n`;
  await ensureDir(path.dirname(file));
  const ordinary = (metadata) => metadata.isFile() && !metadata.isSymbolicLink() && metadata.nlink === 1;
  const unsafe = () => Object.assign(new Error('JSON audit entry is not an ordinary single-link file'), {
    code: 'APE_UNSAFE_FILE',
  });
  const before = await lstatFile(file).catch((error) => {
    if (error?.code === 'ENOENT') return null;
    throw error;
  });
  if (before && !ordinary(before)) throw unsafe();
  const handle = await open(file, constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT |
    (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0), 0o600);
  try {
    // Audit sinks are runtime-controlled too. A FIFO must fail before an
    // append can hold a mutation lock waiting for another process to read.
    // A linked sink must never append into another file's shared bytes.
    const opened = await statFileHandle(handle);
    if (!ordinary(opened) || (before && (before.dev !== opened.dev || before.ino !== opened.ino))) throw unsafe();
    await handle.writeFile(text, 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
  await syncDirectory(path.dirname(file));
}

// Publish a fully-written directory without replacing an existing immutable
// generation. A racing publisher must validate/reuse the existing generation.
export async function publishImmutableDirectory(temporary, directory) {
  try {
    await rename(temporary, directory);
  } catch (error) {
    if (['EEXIST', 'ENOTEMPTY', 'EPERM'].includes(error?.code)) return false;
    throw error;
  }
  await syncDirectory(path.dirname(directory));
  return true;
}

// A hard link publishes complete bytes without replacing an existing name.
export async function publishImmutableJson(file, value) {
  await ensureDir(path.dirname(file));
  const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
  const handle = await open(temporary, 'wx', 0o600);
  try {
    try {
      await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, 'utf8');
      await handle.sync();
    } finally {
      await handle.close();
    }
    try {
      await link(temporary, file);
    } catch (error) {
      if (error?.code === 'EEXIST') return false;
      throw error;
    }
    // Recovery selectors require exactly one link. Persist temporary removal
    // together with publication so a crash cannot resurrect a second link.
    await rm(temporary, { force: true });
    await syncDirectory(path.dirname(file));
    return true;
  } finally {
    await rm(temporary, { force: true }).catch(() => {});
  }
}
