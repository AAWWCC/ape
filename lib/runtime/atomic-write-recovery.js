import { lstat, readdir, rm } from 'node:fs/promises';
import path from 'node:path';

// Call only while holding the store's writer lock. atomicReplaceText stages
// beside its destination; process termination can bypass its finally cleanup.
// Staged bytes never become a journal generation or transaction: discard only
// that writer's exact private, single-link temporary-file shape, then let the
// caller validate the complete committed inventory as usual.
export async function recoverAtomicWriteDirectory(directory, acceptsTarget, maxBytes) {
  const entries = await readdir(directory, { withFileTypes: true });
  const committed = [];
  for (const entry of entries) {
    const match = /^(.*)\.([1-9]\d{0,9})\.(\d{1,16})\.([a-f0-9]{8})\.tmp$/.exec(entry.name);
    if (!match || !acceptsTarget(match[1])) {
      committed.push(entry);
      continue;
    }
    const file = path.join(directory, entry.name);
    const before = await lstat(file);
    if (!entry.isFile() || entry.isSymbolicLink() || !before.isFile() || before.isSymbolicLink() ||
        before.nlink !== 1 || before.size > maxBytes ||
        (process.platform !== 'win32' && (before.mode & 0o077) !== 0)) {
      throw new Error('atomic write recovery found an unsafe temporary entry');
    }
    const current = await lstat(file);
    if (['dev', 'ino', 'size', 'mtimeMs', 'ctimeMs', 'nlink'].some((key) => before[key] !== current[key])) {
      throw new Error('atomic write recovery temporary entry changed before removal');
    }
    await rm(file);
  }
  return committed;
}
