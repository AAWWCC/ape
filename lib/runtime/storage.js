import { randomUUID } from 'node:crypto';
import { copyFile, mkdir, open, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

export async function ensureDir(dir) {
  await mkdir(dir, { recursive: true });
}

export async function readJson(file, fallback = undefined) {
  try {
    return JSON.parse(await readFile(file, 'utf8'));
  } catch (error) {
    if (error?.code === 'ENOENT' && fallback !== undefined) return fallback;
    throw error;
  }
}

const WIN32_TRANSIENT_RENAME_CODES = ['EPERM', 'EACCES', 'EBUSY'];

// Atomic replace with first-class Windows parity (D1). POSIX rename-over is
// atomic; on win32 renaming onto a path someone holds open (AV scanner,
// statusline/hook reader) fails transiently. The old fallback deleted the
// target before renaming, which breaks atomicity twice over: readers see
// ENOENT mid-replace, and a crash (or a second rename failure while the old
// name is delete-pending) loses the state file entirely on a live system.
// Instead retry the atomic rename with backoff — those holds are transient —
// and only then fall back to copying over the target in place.
//
// TORN-WRITE DISPOSITION (audit 2026-07-24 item 1 — deliberate, accepted risk,
// no behavior change): that win32 copy fallback is NOT atomic. It keeps the
// destination present at every instant, which is the point of copying over a
// delete-then-rename, but an interruption mid-copy can leave the target TORN —
// a mix of old and new bytes — not merely absent, which is what the paragraph
// above used to imply. Containment is ASYMMETRIC. For the runtime's own JSON
// state files a torn write is absorbed downstream: readJson throws rather than
// returning half a record, the doctor classifies corrupt state, and
// receipt-transaction replay plus lock recovery converge. But replaceFile is
// also the tail of atomicReplaceText, whose callers include the HOST's
// caller-owned global settings.json — a torn write THERE has no APE
// convergence machinery behind it, and that is the honest residual, named here
// rather than implied away. Not fixed because no in-process check can observe
// it: win32 rename already IS MoveFileEx (which is why the 10 backoff retries
// precede this line) and fs.copyFile either completes or throws, so a crash
// mid-copy is unobservable from here, and a second temp-then-rename after the
// copy would just reintroduce the rename that has already failed 11 times.
export async function replaceFile(temporary, file) {
  try {
    await rename(temporary, file);
    return;
  } catch (error) {
    if (process.platform !== 'win32') throw error;
    if (!WIN32_TRANSIENT_RENAME_CODES.includes(error?.code)) throw error;
  }
  for (let attempt = 1; attempt <= 10; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 10 * attempt));
    try {
      await rename(temporary, file);
      return;
    } catch (error) {
      if (!WIN32_TRANSIENT_RENAME_CODES.includes(error?.code)) throw error;
    }
  }
  await copyFile(temporary, file);
  await rm(temporary, { force: true });
}

// DURABILITY DISPOSITION (audit 1.13 nit 8 — deliberate, accepted risk, no
// behavior change): neither atomicWriteJson nor appendJsonLine fsyncs the
// PARENT DIRECTORY, and appendJsonLine appends with no fsync at all. An
// OS/power crash at the wrong instant can therefore LOSE — never corrupt —
// the newest state replacement or the newest audit line: rename atomicity
// plus the pre-rename content fsync keep every state file either
// old-complete or new-complete, and a mere process crash loses nothing. The
// runtime already absorbs a lost newest write through receipt-transaction
// replay, lock recovery, and the history store, while a per-write directory
// fsync would tax every hot-path state write and has no Windows equivalent
// (invariant 6: host and project agnosticism) — so the gap is accepted by
// decision, not oversight.
export async function atomicWriteJson(file, value) {
  await ensureDir(path.dirname(file));
  const temporary = `${file}.${process.pid}.${Date.now()}.${randomUUID().slice(0, 8)}.tmp`;
  const handle = await open(temporary, 'wx', 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
  await replaceFile(temporary, file);
}

// Text sibling of atomicWriteJson for files whose mode is caller-owned — e.g.
// the user's global settings.json must keep its existing permissions (default
// 0644), never inherit the runtime's private 0600 state default. Same
// temp-then-atomic-replace discipline (D1).
export async function atomicReplaceText(file, text, { mode = 0o600 } = {}) {
  await ensureDir(path.dirname(file));
  const temporary = `${file}.${process.pid}.${Date.now()}.${randomUUID().slice(0, 8)}.tmp`;
  const handle = await open(temporary, 'wx', mode);
  try {
    // open()'s mode is filtered through the process umask; chmod makes the
    // caller's mode authoritative (a preserved 0664 must not become 0644).
    await handle.chmod(mode);
    await handle.writeFile(text, 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
  await replaceFile(temporary, file);
}

// Unsynced append by design — see the durability disposition above
// atomicWriteJson: a power crash may lose the newest audit line, never
// corrupt the file, and the trade is accepted.
export async function appendJsonLine(file, value) {
  await ensureDir(path.dirname(file));
  await writeFile(file, `${JSON.stringify(value)}\n`, { encoding: 'utf8', flag: 'a', mode: 0o600 });
}
