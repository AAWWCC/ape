import { randomUUID } from 'node:crypto';
import { hostname, tmpdir } from 'node:os';
import { link, lstat, mkdir, open, readFile, readdir, rename, rm, stat, utimes, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { ensureDir } from './storage.js';

const FS_LATENCY_BASELINE_MS = 2;
// A one-shot idle probe materially underestimates Windows rename/remove
// latency once Defender and concurrent test or host activity begin touching
// the same temporary volume. Keep the probe adaptive, but give Windows the
// contention headroom its directory-lock implementation needs under load.
// This changes only how long a contender may wait; lock ownership,
// heartbeats, and stale-generation rules are unchanged.
const WINDOWS_FS_LATENCY_MULTIPLIER_FLOOR = 6;
// Calibration measures wall time around asynchronous filesystem work, so
// event-loop starvation can look like arbitrarily slow storage. Preserve a
// bounded contention budget: callers may receive platform headroom, but a
// loaded process cannot silently turn busyMs into an unbounded wait.
const FS_LATENCY_MULTIPLIER_CEILING = 8;
let fsLatencyMultiplier = null;
const win32DirLockQueues = new Map();
const locallyRetiringDirLockTokens = new Set();

function drainWin32DirLockQueue(key, queue) {
  if (queue.running) return;
  const entry = queue.pending.shift();
  if (!entry) {
    if (win32DirLockQueues.get(key) === queue) win32DirLockQueues.delete(key);
    return;
  }
  queue.running = true;
  entry.started = true;
  clearTimeout(entry.timer);
  Promise.resolve()
    .then(entry.callback)
    .then(entry.resolve, entry.reject)
    .finally(() => {
      queue.running = false;
      drainWin32DirLockQueue(key, queue);
    });
}

function withWin32DirLockQueue(lockPath, callback, options) {
  // Windows makes a directory-lock crowd disproportionately expensive: every
  // local contender performs create/rename/stat/remove work and can collide
  // with Defender while only one callback can ever run. Serialize callers in
  // this process before retaining the on-disk lock as the cross-process
  // authority. Waiting remains bounded by the same Windows contention floor.
  const key = path.resolve(lockPath).toLowerCase();
  let queue = win32DirLockQueues.get(key);
  if (!queue) {
    queue = { running: false, pending: [] };
    win32DirLockQueues.set(key, queue);
  }
  return new Promise((resolve, reject) => {
    const entry = {
      callback,
      resolve,
      reject,
      started: false,
      timer: null,
    };
    const waitMs = options.busyMs * WINDOWS_FS_LATENCY_MULTIPLIER_FLOOR;
    entry.timer = setTimeout(() => {
      if (entry.started) return;
      const index = queue.pending.indexOf(entry);
      if (index !== -1) queue.pending.splice(index, 1);
      reject(new Error(options.busyMessage));
      drainWin32DirLockQueue(key, queue);
    }, waitMs);
    entry.timer.unref?.();
    queue.pending.push(entry);
    drainWin32DirLockQueue(key, queue);
  });
}

export function computeFsLatencyMultiplier(elapsedMs, platform = process.platform) {
  const platformFloor = platform === 'win32'
    ? WINDOWS_FS_LATENCY_MULTIPLIER_FLOOR
    : 1;
  const measured = Math.max(1, Math.round(elapsedMs / FS_LATENCY_BASELINE_MS));
  return Math.min(
    FS_LATENCY_MULTIPLIER_CEILING,
    Math.max(platformFloor, measured),
  );
}

async function calibrateFsLatency() {
  if (fsLatencyMultiplier !== null) return fsLatencyMultiplier;
  const probe = path.join(tmpdir(), `.ape-fs-probe-${process.pid}-${randomUUID()}`);
  const t0 = Date.now();
  await mkdir(probe);
  await rm(probe, { recursive: true, force: true });
  const elapsed = Math.max(1, Date.now() - t0);
  fsLatencyMultiplier = computeFsLatencyMultiplier(elapsed);
  return fsLatencyMultiplier;
}

function processExists(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // Only ESRCH proves absence. EPERM and every unfamiliar platform error
    // are fail-closed evidence that the process may still be alive.
    return error?.code !== 'ESRCH';
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Atomic steal of a file lock: rename it to a unique tombstone, then remove
// the tombstone. rename is atomic, so of N concurrent stealers exactly one
// wins; the losers get ENOENT and re-contend against whatever the winner
// creates next. A plain rm here would race — a slow stealer's rm can delete a
// competitor's just-created fresh lock, admitting two writers (invariant 7).
//
// The rename alone is necessary but NOT sufficient. It only makes one winner
// among concurrent stealers of the SAME file; it does not prove the file is
// still the stale one the caller meant to steal. A faster contender may have
// already replaced generation-N's stale bytes with generation-N+1's FRESH lock
// between this caller's read and its rename, and deleting THAT admits two
// writers again (the exact re-check reproduction: a 200ms-stalled loser steals
// the winner's fresh lock). So when the caller passes the exact bytes it
// observed, re-verify them inside the renamed tombstone before deleting —
// releaseDirLock-style — and on mismatch hand the captured generation back and
// report no steal, so the caller re-contends and correctly loses to the
// winner.
//
// The hand-back is NON-CLOBBERING. Between the rename-away and the hand-back
// the lock path is transiently ABSENT, so a concurrent createLockFile can win
// the vacated path while the captured holder is LIVE; a rename hand-back
// would replace — destroy — that window winner's lock beneath it. The
// hand-back therefore link()s the tombstone into place (atomic; fails EEXIST
// while the path is occupied) on a bounded retry: a window occupant withdraws
// at its own post-acquire barrier (see acquireRunLock), a same-host dead-pid
// or unparseable occupant is cleared with a verified steal of the exact bytes
// just read (lawful under F9 — only a provably dead rival generation is ever
// evicted), and a live occupant is waited out. Exhaustion fails closed — the
// tombstone leaks, the path is never clobbered. Only on the no-hard-link
// errno family createLockFile itself degrades on does the hand-back degrade
// to the rename (documented residual on such filesystems).
//
// Caller inventory: acquireRunLock's stale-pid and unreadable-lock steal arms
// pass the observed bytes (a verified steal of a DEAD or garbage generation);
// acquireRunLock's barrier withdraw and releaseRunLock's owner and garbage
// arms pass the bytes just read — a verified rm of LIVE bytes there is lawful
// owner SELF-removal, never an eviction (F9 constrains stealing a RIVAL's
// generation to dead/stale ones); releaseRunLock's read-fault arm (raw ===
// undefined, where content verification is impossible) and the audited
// operator reset (overrideRun in service.js) pass no `expected` and get the
// plain, unverified rename.
//
// Accepted multi-fault residual: a hand-back that exhausts its budget leaks a
// tombstone holding a captured LIVE generation, which keeps same-host
// acquisition pending (the barrier's pending predicate) until the captured
// holder releases or exits, the leaker exits, or a sweep reclaims it — the
// pending predicate's dead-pid ignore plus the release-time and acquire-exit
// sweeps clear it; override reset does not (it targets the lock path, never
// tombstones).
// Returns whether this caller won the steal.
export async function stealLockFileByRename(lockPath, expected) {
  const tombstone = `${lockPath}.stale.${randomUUID()}`;
  try {
    await rename(lockPath, tombstone);
  } catch {
    return false;
  }
  if (expected !== undefined) {
    let renamed;
    try {
      renamed = await readFile(tombstone, 'utf8');
    } catch {
      // Unreadable now (torn or removed under us): treat as a mismatch and hand
      // whatever remains back rather than delete a file we cannot verify.
      renamed = undefined;
    }
    if (renamed !== expected) {
      // A faster contender already installed a different (fresh) lock where
      // our stale one was — or this rename itself captured a LIVE successor
      // by path. Hand the captured generation back and report no steal,
      // WITHOUT ever replacing whatever now occupies the lock path.
      let retryStarted = null;
      for (;;) {
        try {
          await link(tombstone, lockPath);
        } catch (error) {
          if (error?.code === 'ENOENT') {
            // The tombstone vanished under us: its captured owner already
            // reclaimed it (own-bytes sweep). Nothing left to hand back.
            return false;
          }
          if (['EPERM', 'EACCES', 'ENOSYS', 'ENOTSUP', 'EOPNOTSUPP'].includes(error?.code)) {
            // No hard-link support (the same errno family createLockFile
            // degrades on): degrade to the rename hand-back. Residual on such
            // filesystems only: rename replaces its target.
            await rename(tombstone, lockPath).catch(() => {});
            return false;
          }
          if (error?.code === 'EEXIST') {
            // A contender won the vacated path during the absence window.
            // Clear it only when provably dead: a same-host dead-pid or
            // unparseable occupant is removed with a verified steal of the
            // exact bytes just read; a live (or foreign-host) occupant is
            // waited out — its own post-acquire barrier withdraws it.
            let occupant;
            try {
              occupant = await readFile(lockPath, 'utf8');
            } catch {
              occupant = undefined; // vanished under us: just retry the link
            }
            if (occupant !== undefined) {
              let occupantIsLive = false;
              try {
                const parsed = JSON.parse(occupant);
                occupantIsLive = !(parsed?.host === hostname() && !processExists(parsed?.pid));
              } catch {
                occupantIsLive = false;
              }
              if (!occupantIsLive) {
                await stealLockFileByRename(lockPath, occupant);
              }
            }
          }
          // Bounded from the first failed hand-back attempt; exhaustion fails
          // closed — leak the tombstone, never clobber the path.
          if (retryStarted === null) retryStarted = Date.now();
          if (Date.now() - retryStarted > 1_000) return false;
          await sleep(10);
          continue;
        }
        await rm(tombstone, { force: true }).catch(() => {});
        return false;
      }
    }
  }
  // Best-effort cleanup: a leaked tombstone is inert garbage, never a lock.
  await rm(tombstone, { force: true }).catch(() => {});
  return true;
}

// Owner-verified release for withDirLock. Never remove a lock we no longer
// own: if a contender judged us stale and stole the dir while our callback
// stalled, the owner file now holds the thief's token and the dir is theirs.
// The removal itself is steal-shaped — rename to a unique tombstone, re-verify
// ownership inside the renamed dir, then delete — because a plain rm after the
// owner read would reopen the same check-then-act window against a concurrent
// stealer. The `.release.` rename is a vacating operation by path: a release
// that stalls between its owner read and its rename can capture a LIVE
// successor's generation, so an owner mismatch after the rename hands the
// captured generation back with a bounded retry (a contender that acquired
// inside the absence window occupies the lock path only until its own
// post-acquire barrier sees this fresh tombstone and withdraws) instead of
// leaking a live lock in the tombstone forever.
async function releaseDirLock(lockPath, token, busyMs = 1_000) {
  let owner;
  try {
    owner = await readFile(path.join(lockPath, 'owner'), 'utf8');
  } catch {
    // Gone or unreadable: either way it is not verifiably ours to remove.
    return;
  }
  if (owner !== token) return;
  const tombstone = `${lockPath}.release.${token}`;
  try {
    await rename(lockPath, tombstone);
  } catch {
    // A stealer renamed it first; whatever exists now is not ours to touch.
    return;
  }
  let renamedOwner = null;
  try {
    renamedOwner = await readFile(path.join(tombstone, 'owner'), 'utf8');
  } catch {
    // Fall through: unverifiable content is handled as a mismatch below.
  }
  if (renamedOwner !== token) {
    // Stolen and re-acquired between our owner read and our rename: our
    // vacating rename captured the thief's LIVE generation. Hand it back,
    // retrying briefly — a window acquirer holds the lock path only until its
    // barrier withdraws — so the live generation converges back to the lock
    // path instead of leaking. Exhaustion degrades to best-effort: the leaked
    // tombstone is kept fresh by its live holder's heartbeat and is never
    // itself contended for, so it can wedge nothing.
    const handBackStarted = Date.now();
    for (;;) {
      try {
        await rename(tombstone, lockPath);
        return;
      } catch {
        if (Date.now() - handBackStarted > busyMs) return;
        await sleep(10);
      }
    }
  }
  await rm(tombstone, { recursive: true, force: true }).catch(() => {});
}

// Shared advisory dir lock for multi-writer critical sections (receipt
// effects, dispatch intents). Acquisition is an atomic staged install: the
// contender builds a private staging dir (`<lock>.acquire.<token>`) carrying
// its owner token, then renames it into place in one step, so a generation at
// the lock path is never ownerless and never mid-write (an EMPTY dir at the
// lock path is therefore ownerless debris, which a POSIX rename atomically
// absorbs). Staleness is judged by the dir's mtime, which a live holder
// refreshes with a heartbeat, so only a genuinely dead holder — one whose
// heartbeat stopped — is stolen (F9), through a rename tombstone (one winner
// among concurrent stealers) with post-rename verification; release verifies
// an owner token.
//
// BOTH vacating renames — the steal's `.stale.` tombstone and the release's
// `.release.` tombstone — operate by path, so either can transiently capture
// a rival's freshly installed LIVE generation, opening an absence window at
// the lock path. The protocol makes that window unenterable instead of
// pretending it cannot open:
//   - post-acquire barrier: after installing, a contender re-stats the lock
//     path (gone = our install was captured = loss), scans the parent for a
//     FRESH `.stale.`/`.release.` tombstone (fresh = a pending vacating
//     rename whose hand-back needs the path free: withdraw and re-contend),
//     and re-reads its own owner token before entering;
//   - steal by identity: a stealer captures the observed generation's owner
//     bytes before its rename and deletes the tombstone only while it is
//     still stale AND carries the same identity (an identity-less generation
//     stays stealable while still stale); anything else is handed back with
//     a bounded retry against window acquirers that withdraw at their own
//     barrier;
//   - release hand-back: a stalled release whose rename captured a live
//     successor converges the same way (see releaseDirLock);
//   - heartbeat: a live holder freshens the lock path, and when its
//     generation has been captured into a tombstone it freshens THAT, so a
//     captured live generation never ages into staleness at anyone's barrier
//     while the hand-back converges.
// The identity conjunct grants no clock-jump immunity: staleness remains an
// mtime judgment, and the real mitigation is the heartbeat window — the same
// exposure as before.
async function withDirLockFilesystem(lockPath, callback, options) {
  const multiplier = await calibrateFsLatency();
  const { staleMs, heartbeatMs, busyMessage } = options;
  const busyMs = options.busyMs * multiplier;
  const parent = path.dirname(lockPath);
  const requiresProcessIdentity = path.basename(lockPath) === 'receipt-effects.lock';
  await ensureDir(parent);
  const token = randomUUID();
  const processIdentityRecord = {
    version: 1,
    token,
    pid: process.pid,
    host: hostname(),
    state: 'active',
  };
  const processIdentity = `${JSON.stringify(processIdentityRecord)}\n`;
  // Stable per contender, so a release wakes rivals across a small window
  // instead of synchronizing every waiter onto the same 10ms retry edge.
  const retryDelayMs = 10 + (Number.parseInt(token.slice(0, 2), 16) % 41);
  const started = Date.now();
  const stagingPath = `${lockPath}.acquire.${token}`;
  const tombstonePrefixes = [`${path.basename(lockPath)}.stale.`, `${path.basename(lockPath)}.release.`];

  // Every `.stale.`/`.release.` tombstone of THIS lock currently in the
  // parent (tolerant: an unlistable parent simply yields none).
  const listTombstones = async () => {
    let names;
    try {
      names = await readdir(parent);
    } catch {
      return [];
    }
    return names
      .filter((name) => tombstonePrefixes.some((prefix) => name.startsWith(prefix)))
      .map((name) => path.join(parent, name));
  };

  // A tombstone with a fresh mtime is a LIVE generation captured by a pending
  // vacating rename whose hand-back needs the lock path free (ENOENT-tolerant:
  // a tombstone that vanished mid-scan was a completed steal's rm, not a
  // pending hand-back).
  const freshTombstonePresent = async () => {
    for (const tombstone of await listTombstones()) {
      try {
        const metadata = await stat(tombstone);
        if (Date.now() - metadata.mtimeMs <= staleMs) return true;
      } catch {
        // Vanished mid-scan: not a pending hand-back.
      }
    }
    return false;
  };

  // Post-acquire barrier: proves the generation we installed is still ours
  // and not sitting inside a vacating rename's absence window before we
  // enter. Returns true to enter, false to re-contend.
  const barrier = async () => {
    try {
      await stat(lockPath);
    } catch (error) {
      if (error?.code === 'ENOENT') {
        // Our install was captured by a vacating rename: believe the fs and
        // lose. If the capturer hands our generation back, the adoption arm
        // below re-enters it; either way the path stays contended.
        await sleep(retryDelayMs);
        return false;
      }
      throw error;
    }
    if (await freshTombstonePresent()) {
      // We acquired inside a pending vacating-rename's absence window:
      // withdraw our own generation (owner-verified) so the hand-back can
      // land, then re-contend against whatever it restores.
      await releaseDirLock(lockPath, token, Math.max(0, busyMs - (Date.now() - started)));
      await sleep(retryDelayMs);
      return false;
    }
    let owner = null;
    try {
      owner = await readFile(path.join(lockPath, 'owner'), 'utf8');
    } catch {
      // Unreadable: not verifiably ours; re-contend without touching it.
    }
    return owner === token;
  };

  for (;;) {
    // Bound EVERY iteration by busyMs: the check sits at the loop top so all
    // re-contention paths below (steal, hand-back, barrier withdrawal, ENOENT
    // churn) are bounded. Trivially false on the first iteration
    // (started === now), so the fast-path acquire is unaffected.
    if (Date.now() - started > busyMs) {
      throw new Error(busyMessage);
    }
    // A vacating rename temporarily removes the lock path while its release
    // or hand-back tombstone is still live. Entering that absence window only
    // forces the post-acquire barrier to withdraw us, creating another release
    // window; under Windows directory-delete latency, a crowd of contenders
    // can perpetuate that chain until one starves. Wait before installation
    // whenever the barrier marker is already visible. The post-acquire check
    // remains authoritative for the scan/rename race.
    if (await freshTombstonePresent()) {
      await sleep(retryDelayMs);
      continue;
    }
    // ATOMIC STAGED ACQUIRE: build the full generation — dir plus owner
    // token — in a private staging dir, then install it with a single rename.
    // The staging path embeds our per-call token, so any leftover staging
    // debris from an earlier iteration is provably ours to clear first.
    try {
      await rm(stagingPath, { recursive: true, force: true });
      await mkdir(stagingPath, { mode: 0o700 });
      await writeFile(path.join(stagingPath, 'owner'), token, { encoding: 'utf8', mode: 0o600 });
      // Keep the historical opaque owner token byte-for-byte stable while a
      // sibling record binds that token to the local process. A stale mtime is
      // only evidence that heartbeats stopped; it is not proof that a process
      // died (a suspended or permission-isolated process may still be alive).
      await writeFile(path.join(stagingPath, 'process'), processIdentity, {
        encoding: 'utf8',
        mode: 0o600,
      });
    } catch (error) {
      // A failure inside our private staging dir is a genuine fs fault, not
      // contention: clean up our debris and surface it.
      await rm(stagingPath, { recursive: true, force: true }).catch(() => {});
      throw error;
    }
    let installed = false;
    try {
      await rename(stagingPath, lockPath);
      installed = true;
    } catch (error) {
      await rm(stagingPath, { recursive: true, force: true }).catch(() => {});
      // Contention: a live generation (EEXIST/ENOTEMPTY; EPERM on win32) or a
      // non-dir obstruction (ENOTDIR) occupies the lock path — contend below.
      // Anything else is a genuine fs fault.
      if (!['EEXIST', 'ENOTEMPTY', 'EPERM', 'ENOTDIR'].includes(error?.code)) throw error;
    }
    if (installed) {
      if (await barrier()) break;
      continue;
    }
    let metadata;
    try {
      metadata = await stat(lockPath);
    } catch (statError) {
      if (statError?.code === 'ENOENT') {
        // The lock vanished under us (holder released, or create/remove
        // churn). Throttle before re-contending so a pathological churn loop
        // cannot hot-spin; the top-of-loop deadline still bounds it by busyMs.
        await sleep(retryDelayMs);
        continue;
      }
      throw statError;
    }
    if (Date.now() - metadata.mtimeMs > staleMs) {
      // STEAL BY IDENTITY: capture the observed generation's owner bytes
      // BEFORE the vacating rename, so the tombstone can be proven to be the
      // same generation we judged stale — not a rival's fresh replacement
      // captured by path.
      let observedOwner = null;
      try {
        observedOwner = await readFile(path.join(lockPath, 'owner'), 'utf8');
      } catch {
        // No readable identity (pre-protocol or debris generation): a null
        // identity stays stealable while the tombstone is still stale.
      }
      let observedProcess = null;
      let observedProcessBytes = null;
      try {
        observedProcessBytes = await readFile(path.join(lockPath, 'process'), 'utf8');
        const candidate = JSON.parse(observedProcessBytes);
        if (
          candidate?.version === 1 &&
          candidate?.token === observedOwner &&
          Number.isInteger(candidate?.pid) &&
          candidate.pid > 0 &&
          typeof candidate?.host === 'string' &&
          ['active', 'retiring'].includes(candidate?.state)
        ) observedProcess = candidate;
      } catch {
        // Missing or malformed process identity cannot prove death. Keep the
        // complete owner directory in place and fail closed through the
        // caller's bounded contention deadline.
      }
      const processIsRetirable = !requiresProcessIdentity || (
        observedProcess?.host === hostname() &&
        (
          (
            observedProcess.state === 'active' &&
            !processExists(observedProcess.pid)
          ) ||
          (
            observedProcess.state === 'retiring' &&
            locallyRetiringDirLockTokens.has(observedProcess.token)
          )
        )
      );
      if (!processIsRetirable) {
        await sleep(retryDelayMs);
        continue;
      }
      const tombstone = `${lockPath}.stale.${randomUUID()}`;
      let renamed = false;
      try {
        await rename(lockPath, tombstone);
        renamed = true;
      } catch {
        // Lost the steal to a concurrent contender (or the holder released):
        // loop and contend against the fresh lock instead of deleting it.
      }
      if (renamed) {
        // The rename picks one winner among concurrent stealers, but only the
        // conjunction below proves the tombstone holds the dead generation we
        // judged: still stale (rename preserves the dir's own mtime, and a
        // live holder's heartbeat keeps refreshing its generation wherever it
        // sits) AND the same identity we captured before renaming.
        let stillStale = false;
        try {
          const renamedMetadata = await stat(tombstone);
          stillStale = Date.now() - renamedMetadata.mtimeMs > staleMs;
        } catch {
          // Unverifiable (vanished or unreadable under us): hand back below.
        }
        let sameIdentity = false;
        if (stillStale) {
          if (requiresProcessIdentity && observedOwner !== null && observedProcessBytes !== null) {
            let tombstoneOwner = null;
            let tombstoneProcess = null;
            try {
              tombstoneOwner = await readFile(path.join(tombstone, 'owner'), 'utf8');
              tombstoneProcess = await readFile(path.join(tombstone, 'process'), 'utf8');
            } catch {
              // Unreadable now: not provably the generation we judged.
            }
            sameIdentity = tombstoneOwner === observedOwner &&
              tombstoneProcess === observedProcessBytes;
          } else if (!requiresProcessIdentity && observedOwner !== null) {
            let tombstoneOwner = null;
            try {
              tombstoneOwner = await readFile(path.join(tombstone, 'owner'), 'utf8');
            } catch {
              // Unreadable now: not the observed owner generation.
            }
            sameIdentity = tombstoneOwner === observedOwner;
          } else if (!requiresProcessIdentity) {
            sameIdentity = true;
          }
        }
        if (stillStale && sameIdentity) {
          // Best-effort cleanup: a leaked tombstone is inert garbage,
          // never a lock.
          await rm(tombstone, { recursive: true, force: true }).catch(() => {});
        } else {
          // Our rename captured a LIVE generation by path (a rival installed
          // fresh where our stale one was): hand it back. A contender that
          // acquired inside the absence window occupies the lock path only
          // until its barrier sees this fresh tombstone and withdraws, so
          // retry under the same deadline; exhaustion fails closed — the
          // fresh tombstone leaks rather than a second holder entering.
          for (;;) {
            try {
              await rename(tombstone, lockPath);
              break;
            } catch {
              if (Date.now() - started > busyMs) {
                throw new Error(busyMessage);
              }
              await sleep(10);
            }
          }
        }
      }
      continue;
    }
    // ADOPTION ARM: a fresh generation carrying OUR token is our own install,
    // judged lost at the barrier when a vacating rename captured it and since
    // handed back (tokens are per-call uuids, so it is provably ours). Re-run
    // the barrier and enter instead of wedging behind our own orphan.
    let freshOwner = null;
    try {
      freshOwner = await readFile(path.join(lockPath, 'owner'), 'utf8');
    } catch {
      // Absent or unreadable under churn: somebody else's contention.
    }
    if (freshOwner === token) {
      if (await barrier()) break;
      continue;
    }
    await sleep(retryDelayMs);
  }
  const heartbeat = setInterval(() => {
    const timestamp = new Date();
    // Best-effort: a missed beat only matters if every later beat also fails
    // for the full staleness window, i.e. the holder is genuinely dead.
    (async () => {
      await utimes(lockPath, timestamp, timestamp).catch(() => {});
      let owner = null;
      try {
        owner = await readFile(path.join(lockPath, 'owner'), 'utf8');
      } catch {
        // Captured or churning: the tombstone scan below still freshens us.
      }
      if (owner === token) return;
      // Our live generation was captured into a `.stale.`/`.release.`
      // tombstone by a vacating rename: freshen THAT, so a live captured
      // holder never ages into staleness at anyone's barrier while the
      // hand-back converges.
      for (const tombstone of await listTombstones()) {
        let tombstoneOwner = null;
        try {
          tombstoneOwner = await readFile(path.join(tombstone, 'owner'), 'utf8');
        } catch {
          continue;
        }
        if (tombstoneOwner === token) {
          await utimes(tombstone, timestamp, timestamp).catch(() => {});
        }
      }
    })().catch(() => {});
  }, heartbeatMs);
  heartbeat.unref?.();
  const leaseMetadata = await lstat(lockPath);
  const lease = Object.freeze({
    version: 1,
    token,
    identity: Object.freeze({
      dev: String(leaseMetadata.dev),
      ino: String(leaseMetadata.ino),
    }),
  });
  try {
    return await callback(lease);
  } finally {
    clearInterval(heartbeat);
    // The protected callback has ended, so this generation no longer guards a
    // live critical section even if the owning process remains alive and a
    // release syscall stalls. Mark that lifecycle fact before the vacating
    // rename; a stale contender may retire only this explicit retiring owner
    // (or one whose process is proven dead), never an active EPERM owner.
    try {
      const owner = await readFile(path.join(lockPath, 'owner'), 'utf8');
      if (owner === token) {
        locallyRetiringDirLockTokens.add(token);
        await writeFile(
          path.join(lockPath, 'process'),
          `${JSON.stringify({ ...processIdentityRecord, state: 'retiring' })}\n`,
          { encoding: 'utf8', mode: 0o600 },
        );
      }
    } catch {
      // Captured or replaced generations are not ours to update.
    }
    try {
      await releaseDirLock(lockPath, token, busyMs);
    } finally {
      locallyRetiringDirLockTokens.delete(token);
    }
  }
}

export async function assertDirLockLease(lockPath, lease) {
  if (
    lease?.version !== 1 ||
    typeof lease.token !== 'string' ||
    typeof lease.identity?.dev !== 'string' ||
    typeof lease.identity?.ino !== 'string'
  ) {
    throw new Error('directory lock mutation requires a valid held lease');
  }
  let metadata;
  let owner;
  try {
    metadata = await lstat(lockPath);
    owner = await readFile(path.join(lockPath, 'owner'), 'utf8');
  } catch {
    throw new Error('directory lock lease was removed or replaced before mutation');
  }
  if (
    !metadata.isDirectory() || metadata.isSymbolicLink() ||
    String(metadata.dev) !== lease.identity.dev ||
    String(metadata.ino) !== lease.identity.ino ||
    owner !== lease.token
  ) {
    throw new Error('directory lock lease token or filesystem identity was replaced before mutation');
  }
  return true;
}

// Wrap one persistent sink with ownership checks on both sides. The receipt
// lock's process record makes a live cooperative holder non-stealable: a
// contender may retire this generation only after the owning process is dead,
// or after this callback has returned and withDirLock has marked this exact
// token retiring. The second check detects an out-of-protocol pathname rebind
// during the sink and prevents every later sink from running.
//
// This helper deliberately does not claim protection from a same-privilege
// process that writes the destination directly; such a process can bypass the
// lock and every APE API entirely. It closes the APE-writer race and makes the
// check/sink/check boundary mechanically reviewable at each call site.
export async function withDirLockLeaseMutation(lockPath, lease, mutation) {
  if (typeof mutation !== 'function') {
    throw new Error('directory lock mutation requires a callable sink');
  }
  await assertDirLockLease(lockPath, lease);
  const result = await mutation();
  await assertDirLockLease(lockPath, lease);
  return result;
}

export async function withDirLock(lockPath, callback, options) {
  if (process.platform === 'win32' && options.serializeLocal === true) {
    return withWin32DirLockQueue(
      lockPath,
      () => withDirLockFilesystem(lockPath, callback, options),
      options,
    );
  }
  return withDirLockFilesystem(lockPath, callback, options);
}

// Direct exclusive write for filesystems without hard links. The open('wx')
// to write window can expose a partial lock here, so a failed write removes
// its own debris instead of leaving a 0-byte permanent wedge.
async function createLockFileDirect(lockPath, body) {
  let handle;
  try {
    handle = await open(lockPath, 'wx', 0o600);
  } catch (error) {
    if (error?.code === 'EEXIST') return false;
    throw error;
  }
  try {
    await handle.writeFile(body, 'utf8');
    await handle.sync();
  } catch (error) {
    await handle.close().catch(() => {});
    await rm(lockPath, { force: true }).catch(() => {});
    throw error;
  }
  await handle.close();
  return true;
}

// Create the lock file atomically AND exclusively: stage the full payload in
// a temp file, then link() it into place. link is atomic and fails EEXIST on
// contention, so the lock is never observable empty or truncated — a crash or
// ENOSPC mid-write leaves only a temp file, never the 0-byte lock that used
// to wedge every later acquire behind an unrecoverable "unreadable" error.
// Returns true when this caller created the lock, false on contention.
async function createLockFile(lockPath, payload) {
  const body = `${JSON.stringify(payload)}\n`;
  const temporary = `${lockPath}.${process.pid}.${randomUUID()}.tmp`;
  const handle = await open(temporary, 'wx', 0o600);
  try {
    try {
      await handle.writeFile(body, 'utf8');
      await handle.sync();
    } finally {
      await handle.close();
    }
    try {
      await link(temporary, lockPath);
      return true;
    } catch (error) {
      if (error?.code === 'EEXIST') return false;
      if (!['EPERM', 'EACCES', 'ENOSYS', 'ENOTSUP', 'EOPNOTSUPP'].includes(error?.code)) throw error;
      return createLockFileDirect(lockPath, body);
    }
  } finally {
    await rm(temporary, { force: true }).catch(() => {});
  }
}

// Audit hook for stale-lock recovery: callers (the service layer) log the
// steal like an override. Best-effort by design — recovery must not fail on a
// logging fault — and fired only by the contender whose steal actually won.
async function notifyRecover(options, detail) {
  if (typeof options.onRecover !== 'function') return;
  try {
    await options.onRecover(detail);
  } catch {
    // swallow: the audit line is advisory, the recovery already happened
  }
}

// Bounds the acquire loop's re-contention (audit s2.6): the arms that loop —
// the ENOENT vanish race, the two audited post-steal re-contends, and the
// post-acquire barrier's withdraw-and-re-contend — converge within a couple
// of iterations against any real contender, so exhausting this budget means
// pathological create/remove churn (or a pending capture whose hand-back
// never resolves), reported honestly as such.
const MAX_ACQUIRE_ATTEMPTS = 8;

export async function acquireRunLock(lockPath, runId, options = {}) {
  const parent = path.dirname(lockPath);
  await ensureDir(parent);
  // One recovery credit for the whole acquire (a steal consumes it): the steal
  // arms below clear this flag and re-contend inside the same bounded loop —
  // formerly three self-recursion sites, now one frame (audit s2.6).
  let recoverStale = options.recoverStale === true;
  // Every payload this call installed at the lock path, keyed by its exact
  // bytes: the per-attempt nonce makes each generation byte-unique, so "these
  // bytes are OURS" is unambiguous at the barrier, the sweeps, and the
  // adoption arm below.
  const installed = new Map();
  // Whether this call installed a generation and then gave it up (withdrew at
  // the barrier, or lost it to a capture): only then can our debris exist.
  let abandoned = false;
  const tombstonePrefix = `${path.basename(lockPath)}.stale.`;

  // Every `.stale.` tombstone of THIS lock currently in the parent (tolerant:
  // an unlistable parent simply yields none).
  const listTombstones = async () => {
    let names;
    try {
      names = await readdir(parent);
    } catch {
      return [];
    }
    return names.filter((name) => name.startsWith(tombstonePrefix)).map((name) => path.join(parent, name));
  };

  // Acquire-exit sweep: best-effort rm of any tombstone holding a generation
  // THIS call installed and since abandoned — never a rival's bytes, never
  // the generation currently held (keepBytes).
  const sweepOwnDebris = async (keepBytes) => {
    if (!abandoned) return;
    for (const tombstone of await listTombstones()) {
      let bytes;
      try {
        bytes = await readFile(tombstone, 'utf8');
      } catch {
        continue;
      }
      if (bytes !== keepBytes && installed.has(bytes)) {
        await rm(tombstone, { force: true }).catch(() => {});
      }
    }
  };

  // A `.stale.` tombstone is a PENDING capture — a vacating steal renamed a
  // generation away and its non-clobbering hand-back needs the lock path
  // free — iff it parses as a lock payload naming THIS host with an ALIVE pid
  // and is not our own. Dead-pid, foreign-host, unparseable, and
  // vanished-mid-scan tombstones are inert debris (never a pending
  // hand-back); a tombstone holding bytes this call itself installed is our
  // own captured, since-abandoned generation, reclaimed on the spot.
  const pendingTombstonePresent = async () => {
    let pending = false;
    for (const tombstone of await listTombstones()) {
      let bytes;
      try {
        bytes = await readFile(tombstone, 'utf8');
      } catch {
        continue; // vanished mid-scan: a completed steal's rm, not a capture
      }
      if (installed.has(bytes)) {
        await rm(tombstone, { force: true }).catch(() => {});
        continue;
      }
      let parsed;
      try {
        parsed = JSON.parse(bytes);
      } catch {
        continue; // unparseable: inert garbage
      }
      if (parsed?.host === hostname() && processExists(parsed?.pid)) pending = true;
    }
    return pending;
  };

  // Post-acquire barrier (the acme PR #321 dir-lock template re-derived for the
  // file-lock shape): after this call's bytes P landed at the lock path,
  // prove the install is still there and no pending capture's hand-back needs
  // the path free before entering. Returns true to enter, false to lose and
  // re-contend.
  const barrier = async (payloadBytes) => {
    for (;;) {
      let current;
      try {
        current = await readFile(lockPath, 'utf8');
      } catch {
        current = undefined; // absent (captured away) or unreadable
      }
      if (current === payloadBytes) {
        if (!(await pendingTombstonePresent())) return true;
        // We acquired inside a pending capture's absence window: withdraw our
        // own generation — a verified rm of our own LIVE bytes is lawful
        // owner self-removal, never an F9 eviction — so the hand-back can
        // land, then yield and re-contend against whatever it restores.
        await stealLockFileByRename(lockPath, payloadBytes);
        abandoned = true;
        await sleep(10);
        return false;
      }
      // Our install was captured by a vacating rename. Wait out the
      // capturer's bounded hand-back (this budget deliberately exceeds the
      // hand-back's ~1s) for our bytes to return to the path, then re-run the
      // barrier; a lapsed budget is a loss and re-contention.
      const waitStarted = Date.now();
      let restored = false;
      while (Date.now() - waitStarted <= 1_500) {
        await sleep(10);
        try {
          current = await readFile(lockPath, 'utf8');
        } catch {
          current = undefined;
        }
        if (current === payloadBytes) {
          restored = true;
          break;
        }
      }
      if (!restored) {
        abandoned = true;
        return false;
      }
    }
  };

  for (let attempts = 0; attempts < MAX_ACQUIRE_ATTEMPTS; attempts += 1) {
    // Recomputed every iteration: acquired_at must stamp THIS contend attempt,
    // exactly as each recursive call used to build its own payload. The nonce
    // makes this attempt's bytes globally unique; readers of the lock consume
    // only run_id/host/pid, so the extra field is backward-compatible.
    const payload = {
      version: 1,
      run_id: runId,
      pid: process.pid,
      host: hostname(),
      acquired_at: options.now ?? new Date().toISOString(),
      nonce: randomUUID(),
    };
    const payloadBytes = `${JSON.stringify(payload)}\n`;
    if (await createLockFile(lockPath, payload)) {
      installed.set(payloadBytes, payload);
      if (await barrier(payloadBytes)) {
        await sweepOwnDebris(payloadBytes);
        return payload;
      }
      continue;
    }

    // Capture the exact bytes we observe so a later steal can prove the lock has
    // not been replaced by a fresh generation under us (see stealLockFileByRename).
    let raw;
    let existing;
    try {
      raw = await readFile(lockPath, 'utf8');
      existing = JSON.parse(raw);
    } catch (error) {
      if (error?.code === 'ENOENT') {
        // The holder released (or a concurrent steal completed) between our
        // create attempt and this read: yield, then contend for the now-free
        // lock.
        await sleep(10);
        continue;
      }
      // Unreadable lock: a 0-byte or torn file from a legacy crash window.
      // createLockFile never exposes a partial lock, so garbage provably has no
      // live mid-write owner; recoverStale may steal it (audited via onRecover)
      // instead of wedging permanently behind a remedy that cannot run. Pass the
      // observed bytes so a fresh valid lock installed under us is handed back,
      // not deleted; raw is undefined only on a read fault (not a parse failure),
      // where content verification is impossible and the plain steal is used.
      if (recoverStale) {
        if (await stealLockFileByRename(lockPath, raw)) {
          await notifyRecover(options, { kind: 'unreadable-lock', run_id: null });
        }
        recoverStale = false;
        continue;
      }
      await sweepOwnDebris();
      throw new Error('active-run lock exists but is unreadable; use override reset with an audit reason');
    }
    if (installed.has(raw)) {
      // ADOPTION ARM: the path holds a generation WE installed and judged
      // lost at the barrier — a capture since handed back. Re-run the barrier
      // over it and, on pass, adopt it instead of throwing at our own
      // abandoned generation.
      if (await barrier(raw)) {
        const adopted = installed.get(raw);
        await sweepOwnDebris(raw);
        return adopted;
      }
      continue;
    }
    if (existing.host === hostname() && !processExists(existing.pid) && recoverStale) {
      // Steal by rename with content verification, never rm: of two contenders
      // recovering the same stale lock exactly one wins the rename, and verifying
      // the stale bytes survived the rename makes a stalled loser hand back —
      // rather than delete — the winner's FRESH lock. The loser then re-contends
      // and correctly hits "another APE writing run" instead of admitting a
      // second writer (invariant 7).
      if (await stealLockFileByRename(lockPath, raw)) {
        await notifyRecover(options, { kind: 'stale-pid', run_id: existing.run_id ?? null });
      }
      recoverStale = false;
      continue;
    }
    await sweepOwnDebris();
    throw new Error(`another APE writing run is active (${existing.run_id ?? 'unknown'})`);
  }
  // Exhaustion: every iteration saw the lock vanish before it could be read,
  // consumed the steal credit, or installed and then WITHDREW at the barrier
  // (a pending capture's hand-back needed the path free — lawful churn) —
  // never a readable live owner, which throws the live-lock error above.
  // Report the churn honestly; fabricating "another APE writing run" here
  // would name an owner whose bytes nobody ever read.
  await sweepOwnDebris();
  throw new Error(
    `could not acquire the active-run lock after ${MAX_ACQUIRE_ATTEMPTS} attempts of create/remove churn`,
  );
}

// Read-only health probe for doctor: reports whether the active-run lock is
// held, parseable, and whether its holder is still alive on this host.
export async function inspectRunLock(lockPath) {
  let raw;
  try {
    raw = await readFile(lockPath, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') return { present: false };
    throw error;
  }
  let payload;
  try {
    payload = JSON.parse(raw);
  } catch {
    return { present: true, readable: false };
  }
  return {
    present: true,
    readable: true,
    run_id: payload.run_id ?? null,
    stale: payload.host === hostname() && !processExists(payload.pid),
  };
}

export async function releaseRunLock(lockPath, runId) {
  const parent = path.dirname(lockPath);
  const tombstonePrefix = `${path.basename(lockPath)}.stale.`;
  const listTombstones = async () => {
    let names;
    try {
      names = await readdir(parent);
    } catch {
      return [];
    }
    return names.filter((name) => name.startsWith(tombstonePrefix)).map((name) => path.join(parent, name));
  };
  let raw;
  try {
    raw = await readFile(lockPath, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') {
      // Already absent — but our generation may sit captured inside a crashed
      // stealer's leaked tombstone. Sweep any tombstone provably OURS (this
      // runId, this pid, this host) so a leaked capture cannot outlive the
      // run it captured.
      for (const tombstone of await listTombstones()) {
        let bytes;
        try {
          bytes = await readFile(tombstone, 'utf8');
        } catch {
          continue;
        }
        let parsed;
        try {
          parsed = JSON.parse(bytes);
        } catch {
          continue;
        }
        if (parsed?.run_id === runId && parsed?.pid === process.pid && parsed?.host === hostname()) {
          await rm(tombstone, { force: true }).catch(() => {});
        }
      }
      // A concurrent stealer's hand-back (stealLockFileByRename's non-clobbering
      // link) can re-install OUR OWN captured bytes at the lock path AFTER the
      // ENOENT read above — and if it already dropped the tombstone that carried
      // them, the own-bytes sweep just missed it. Left as-is that is an orphaned
      // lock naming a still-live pid (this process), wedging every later acquire
      // until the process exits. Re-read the path and, ONLY when it now holds our
      // own generation, remove it with the same verified owner self-removal the
      // present-lock branch uses (F9 lawful self-removal). The verification
      // inside stealLockFileByRename makes this safe against a further race: a
      // different run_id is a fresh legitimate acquirer and is never touched, and
      // a generation that changes under us fails the byte check and is handed
      // back rather than clobbered.
      let reinstalled;
      try {
        reinstalled = await readFile(lockPath, 'utf8');
      } catch {
        return; // still absent (or unreadable): nothing to reclaim.
      }
      let reParsed;
      try {
        reParsed = JSON.parse(reinstalled);
      } catch {
        return; // not our parseable generation: leave it for the present-lock path.
      }
      if (reParsed?.run_id === runId) {
        await stealLockFileByRename(lockPath, reinstalled);
      }
      return;
    }
    // Read fault (raw unobservable, not a parse failure): content
    // verification is impossible, so the plain, unverified steal clears the
    // path (see the caller inventory on stealLockFileByRename).
    await stealLockFileByRename(lockPath);
    return;
  }
  let existing;
  try {
    existing = JSON.parse(raw);
  } catch {
    // Garbage lock content: ownership is unverifiable, and createLockFile
    // never exposes a partial lock, so there is no live owner to protect.
    // Remove it (atomically, via the rename tombstone, verifying the exact
    // garbage bytes observed) so terminal transitions like abort's
    // release_lock are not wedged behind corrupt bytes they can neither
    // verify nor clear.
    await stealLockFileByRename(lockPath, raw);
    return;
  }
  if (existing.run_id !== runId) {
    throw new Error(`refusing to release lock owned by ${existing.run_id ?? 'unknown'}`);
  }
  // Steal-shaped self-removal: a plain rm after the ownership read would
  // reopen the check-then-act window against a concurrent stealer (the rm
  // could land on a generation installed after ours was renamed away). The
  // verified rm of our own LIVE bytes is lawful owner self-removal (F9
  // constrains evicting RIVALS to dead generations, never the owner itself).
  if (await stealLockFileByRename(lockPath, raw)) {
    // Our removal won: sweep any leaked capture of the very bytes released
    // (a stealer that crashed between its hand-back link and its tombstone
    // rm leaves one behind).
    for (const tombstone of await listTombstones()) {
      let bytes;
      try {
        bytes = await readFile(tombstone, 'utf8');
      } catch {
        continue;
      }
      if (bytes === raw) {
        await rm(tombstone, { force: true }).catch(() => {});
      }
    }
  }
}
