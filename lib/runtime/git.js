import { randomUUID } from 'node:crypto';
import { mkdtemp, open, readdir, rename, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { runtimePaths } from './paths.js';
import { spawnWithTimeout } from './spawn.js';

export async function runGit(projectDir, args, options = {}) {
  const timeoutMs = options.timeout_ms ?? 30_000;
  const result = await spawnWithTimeout('git', args, {
    cwd: projectDir,
    collect: 'separate',
    env: options.env,
    timeout_ms: timeoutMs,
  });
  if (result.spawn_error) throw result.spawn_error;
  // A deadline kill gets its own message: the exit code is a kill artifact
  // (null on POSIX, a taskkill code on win32), and the old `failed (null)`
  // surface hid the actual cause from the operator.
  if (result.timed_out === true) {
    throw new Error(`git ${args.join(' ')} timed out after ${timeoutMs}ms`);
  }
  if (result.exit_code !== 0) {
    throw new Error(`git ${args.join(' ')} failed (${result.exit_code}): ${result.stderr.trim()}`);
  }
  // `raw` preserves byte-exact stdout — required for fixed-column formats
  // like `git status --porcelain`, where trimming the leading space of the
  // first entry (` M path`) shifts the columns and corrupts path parsing.
  return options.raw ? result.stdout : result.stdout.trim();
}

// Crash hygiene for the warm path below: a killed process (host hook timeout,
// SIGKILL) can abandon a private scratch index or git's transient
// `<scratch>.lock`. Sweep siblings old enough that no live call can still own
// them — runGit bounds each subcommand to 30s, so minutes-old is dead. Age
// comes from the creation timestamp embedded in the scratch NAME, not the file
// mtime: the warm path restores the source index's (possibly minutes-old)
// mtime onto a LIVE scratch, so an mtime check could sweep a running call's
// scratch out from under it (safe — the loser just recomputes cold — but a
// needless cost). The name leads with `${Date.now()}-` precisely so raciness
// restore cannot age it.
async function sweepAbandonedScratchIndexes(runtimeDir, treeIndex) {
  const prefix = `${path.basename(treeIndex)}.`;
  for (const name of await readdir(runtimeDir).catch(() => [])) {
    if (!name.startsWith(prefix)) continue;
    const candidate = path.join(runtimeDir, name);
    // New names are `${Date.now()}-${pid}-${uuid}` (3 `-` segments after the
    // prefix, and `<name>.lock` keeps the same lead segment); parse that
    // creation stamp. Legacy `${pid}-${uuid}` debris (2 segments) predates the
    // embedded stamp — fall back to its file mtime so it still gets cleaned.
    const segments = name.slice(prefix.length).split('-');
    const stamp = segments.length >= 3 ? Number(segments[0]) : Number.NaN;
    const bornAt = Number.isFinite(stamp)
      ? stamp
      : await stat(candidate).then((entry) => entry.mtimeMs, () => Date.now());
    if (Date.now() - bornAt > 15 * 60_000) await rm(candidate, { force: true }).catch(() => {});
  }
}

export async function currentTreeSha(projectDir) {
  const paths = runtimePaths(projectDir);
  // Warm path: a persistent index under .ape/runtime carries git's stat cache
  // across calls, so `add -A` re-hashes only paths whose stat changed instead
  // of the whole worktree — the lifecycle hook computes this tree on Pre AND
  // Post of every write-capable tool while a run is active, and a stat-less
  // throwaway index makes that cost linear in worktree size per call. Gated
  // on .ape/runtime already existing: this function must never create .ape,
  // which is the walk-up marker resolveProjectRoot keys on — planting it
  // would turn a non-APE directory into a project root.
  const warmable = await stat(paths.runtime).then((entry) => entry.isDirectory(), () => false);
  if (warmable) {
    await sweepAbandonedScratchIndexes(paths.runtime, paths.treeIndex).catch(() => {});
    // Each call works on a private same-directory copy of the cache and
    // renames it back only after succeeding. Pointing concurrent callers at
    // the shared file would be wrong, not merely contended: git's own lock
    // serializes individual subcommands, not this four-command sequence, so a
    // parallel caller's read-tree could reset the index between this call's
    // `add` and `write-tree` and both would answer for the wrong state. With
    // private copies nothing interleaves; the rename-back is atomic, and
    // losing that race costs only cache freshness, never correctness —
    // `add -A` re-stats every path on every call.
    //
    // The copy must also inherit the source cache's timestamps. git trusts an
    // index entry when its stat matches, comparing mtime at whole-second
    // granularity by default (USE_NSEC off in stock git); the only safety net
    // for a same-second edit is the racy-index guard, which smudges and
    // re-hashes any entry whose mtime is >= the index FILE's own mtime. A
    // fresh mtime on the scratch would silently defeat that guard: a worktree
    // file edited in the same second as the cache write, at unchanged byte
    // length, would then look clean-and-not-racy and write-tree would answer
    // the stale blob. Restoring the original index's mtime onto the scratch
    // keeps the racy comparison exactly as if git had read the shared cache.
    //
    // The bytes and the restored timestamps MUST come from the same inode. An
    // earlier version copied by path, then stat'd the path separately — but a
    // concurrent caller's atomic rename-back (below) can land in the copy→stat
    // gap: this call then holds old content C0 (git-written at second S0) yet
    // stats the NEWLY renamed index (fresher second S1 > S0) and stamps its C0
    // bytes with S1, re-marking every C0 entry in [S0, S1) non-racy — the exact
    // staleness this restore exists to close, through a narrower window. So we
    // open ONE handle and take both the stat and the bytes from it: same fd,
    // same inode, provably one write-time. The restore is not best-effort —
    // swallowing a stat/read/utimes failure could serve a maybe-stale sha — so
    // any failure after a successful open throws into the outer catch, which
    // drops the cache and answers cold. Only an open ENOENT is benign (no cache
    // yet): the scratch is built from zero and there is nothing to restore.
    const scratch = `${paths.treeIndex}.${Date.now()}-${process.pid}-${randomUUID().slice(0, 8)}`;
    try {
      const handle = await open(paths.treeIndex, 'r').catch((error) => {
        if (error && error.code === 'ENOENT') return null;
        throw error;
      });
      if (handle) {
        try {
          const sourceStat = await handle.stat();
          await writeFile(scratch, await handle.readFile());
          await utimes(scratch, sourceStat.atime, sourceStat.mtime);
        } finally {
          await handle.close();
        }
      }
      const env = { GIT_INDEX_FILE: scratch };
      // Single-tree merge: index content becomes exactly HEAD (re-read every
      // call, so a new commit invalidates automatically), but stat info is
      // preserved for entries whose content matches — the entire speedup.
      // Plain `read-tree HEAD` (the cold path below) zeroes all stat info;
      // on a fresh scratch index the two are identical, which is why warm
      // and cold provably compute the same tree.
      await runGit(projectDir, ['read-tree', '-m', 'HEAD'], { env });
      // The positive `:/` pathspec is required — exclude-only pathspecs are
      // a git error. Excluding .ape keeps the runtime's per-transition state
      // mutations from being re-hashed into loose objects on every call; the
      // `rm --cached` below still covers the edge where HEAD itself tracks
      // .ape paths (read-tree brought them in; the exclude only stops adds).
      await runGit(projectDir, ['add', '-A', '--', ':/', ':(exclude).ape'], { env });
      await runGit(projectDir, ['rm', '-r', '--cached', '--ignore-unmatch', '-q', '--', '.ape'], { env });
      const sha = await runGit(projectDir, ['write-tree'], { env });
      // Persisting the warmed cache is best-effort: a lost rename race (or a
      // win32 open-handle refusal) costs the next call's speedup, nothing else.
      await rename(scratch, paths.treeIndex).catch(() => {});
      return sha;
    } catch {
      // Correctness beats speed: on any warm failure (corrupt cached index, a
      // repo shape the pathspec cannot express) drop the cache — the next
      // call re-seeds it — and answer from the throwaway path below.
      await rm(paths.treeIndex, { force: true }).catch(() => {});
    } finally {
      await rm(scratch, { force: true }).catch(() => {});
    }
  }
  const temporary = await mkdtemp(path.join(tmpdir(), 'ape-index-'));
  const index = path.join(temporary, 'index');
  const env = { GIT_INDEX_FILE: index };
  try {
    await runGit(projectDir, ['read-tree', 'HEAD'], { env });
    await runGit(projectDir, ['add', '-A'], { env });
    await runGit(projectDir, ['rm', '-r', '--cached', '--ignore-unmatch', '-q', '--', '.ape'], { env });
    return await runGit(projectDir, ['write-tree'], { env });
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

// One receipt-effects critical section used to recompute the SAME working
// tree 4-6 times (admission read, validator recompute, ticket issuance,
// archive, persist) with nothing but .ape-scoped writes in between — at four
// git spawns per compute that was most of a receipt's latency (audit:
// ~18-22 spawns per receipt). A session memoizes the tree WITHIN one locked
// critical section. Two rules keep the evidence honest (docs/invariants.md:
// "Deterministic, tree-bound evidence" and "Truthful completion" both hang on
// the validator's independent recompute):
//   1. The first current() after construction or invalidate() is always a
//      real git read. A session is never seeded from a receipt or ticket
//      field, so validation still compares agent claims against a
//      runtime-observed tree — never against themselves.
//   2. Every effect that can change the tree (test execution, merge gates,
//      auto-merge, artifact removal) must invalidate() before the next read.
//      Sharing a session across an effect that was not proven .ape-only or
//      followed by invalidate() is a correctness bug, not a slow path.
// diff() memoizes per (base, head) pair with no invalidation at all: git tree
// objects are immutable, so a diff between two shas can never change.
export function treeShaSession(projectDir, compute = currentTreeSha) {
  let value = null;
  const diffs = new Map();
  return {
    current() {
      if (!value) {
        const fresh = compute(projectDir);
        // Never memoize a failed read: a transient git fault must not poison
        // every later read in paths that recover (e.g. the shipping-failed
        // chain that still archives). Guarded so a late-settling failure can
        // only clear its own memo, never a successor's.
        fresh.catch(() => { if (value === fresh) value = null; });
        value = fresh;
      }
      return value;
    },
    invalidate() {
      value = null;
    },
    diff(baseSha, headSha) {
      const key = `${baseSha}..${headSha}`;
      if (!diffs.has(key)) diffs.set(key, diffFiles(projectDir, baseSha, headSha));
      return diffs.get(key);
    },
  };
}

export async function currentCommitSha(projectDir) {
  return runGit(projectDir, ['rev-parse', 'HEAD']);
}

export async function currentBranch(projectDir) {
  return runGit(projectDir, ['branch', '--show-current']);
}

// The base branch a fresh ape/* run must branch FROM when the current checkout
// is a leftover ape/* branch (a dead run's workspace). Mirrors gates.js
// resolveDefaultBase's remote-first symbolic-ref discipline — the FULL tail
// past refs/remotes/origin/, never `.split('/').at(-1)`, so a slashed default
// like release/stable survives (gates.js:324-331 memorializes that truncation
// bug) — but adds a local-ref fallback because origin-less repos (a
// never-pushed clone, every test fixture) carry no remote-tracking refs.
// Returns BOTH the branch name AND the exact start-point ref to branch from.
// The start-point is load-bearing: when resolution comes from a remote ref it
// is the remote-tracking ref (refs/remotes/origin/<name>), and the caller MUST
// create the branch with `git switch -c <new> <start_point> --no-track` —
// `git switch -c <new> main` resolves to LOCAL main and silently defeats the
// remote-first ordering.
export async function resolveBaseBranch(projectDir) {
  const remotePrefix = 'refs/remotes/origin/';
  const symbolic = await runGit(projectDir, ['symbolic-ref', `${remotePrefix}HEAD`])
    .catch(() => '');
  if (symbolic.startsWith(remotePrefix)) {
    const name = symbolic.slice(remotePrefix.length);
    return { branch: name, start_point: `${remotePrefix}${name}` };
  }
  for (const name of ['main', 'master']) {
    const present = await runGit(
      projectDir,
      ['show-ref', '--verify', '--quiet', `${remotePrefix}${name}`],
    ).then(() => true, () => false);
    if (present) return { branch: name, start_point: `${remotePrefix}${name}` };
  }
  for (const name of ['main', 'master']) {
    const present = await runGit(
      projectDir,
      ['show-ref', '--verify', '--quiet', `refs/heads/${name}`],
    ).then(() => true, () => false);
    if (present) return { branch: name, start_point: `refs/heads/${name}` };
  }
  throw new Error('cannot determine base branch: refs/remotes/origin/HEAD is unset and neither origin/main, origin/master, nor a local main/master branch exists; run `git remote set-head origin --auto` (or create the base branch), then retry');
}

// Read the server-advertised branch tip without mutating local refs. This is
// deliberately not `git fetch`: safety checks may inspect remote freshness,
// but must never rewrite the caller's repository as a side effect.
export async function remoteBranchTip(projectDir, remote, branch) {
  const ref = `refs/heads/${branch}`;
  const output = await runGit(
    projectDir,
    ['ls-remote', '--exit-code', remote, ref],
    { timeout_ms: 120_000 },
  );
  const matches = output.split(/\r?\n/)
    .map((line) => line.trim().split(/\s+/))
    .filter(([sha, advertisedRef]) => /^[0-9a-f]{40,64}$/i.test(sha ?? '') && advertisedRef === ref);
  if (matches.length !== 1) {
    throw new Error(`git ls-remote returned no unique tip for ${remote}/${branch}`);
  }
  return matches[0][0].toLowerCase();
}

export async function diffFiles(projectDir, baseSha, headSha) {
  // -z is the byte-exact contract: the newline format C-quotes any path with
  // non-ASCII, quotes, or control characters ("caf\303\251.js"), which can
  // never match the claimed_paths that receipt validation and the hook drift
  // guard compare against (core.quotePath=false would still quote some).
  // raw keeps a leading/trailing-space filename intact — trim would eat it
  // before the NUL split.
  // The trailing '--' disambiguates the two revision operands from pathspecs:
  // setup_revisions() scans the whole argv for '--' before processing any
  // argument and sets REVARG_CANNOT_BE_FILENAME, the flag that suppresses
  // verify_non_filename(). Without it a resolved rev whose name also matches a
  // worktree path (an untracked file is enough) dies "fatal: ambiguous argument
  // ... both revision and filename". Output is byte-identical either way.
  // currentCommitSha deliberately does NOT get the same treatment: `git
  // rev-parse HEAD --` echoes a literal '--' onto stdout and would corrupt the
  // parsed sha.
  const output = await runGit(
    projectDir,
    ['diff', '--name-only', '--no-renames', '-z', baseSha, headSha, '--'],
    { raw: true },
  );
  return output.split('\0').filter(Boolean).sort();
}

// Does an attested tree contain this exact path? Answered from the object
// database — currentTreeSha's write-tree persisted the tree and every blob it
// references, so a receipt's head_tree_sha is always resolvable even before
// any commit exists. `<tree>:<path>` is a single argv token (no shell), so
// spaces and other special bytes in the path pass through byte-exact. Used to
// partition red-test side-effect writes: a path ABSENT from the attested tree
// was created by the executed command, and deleting it exactly restores the
// attested tree; a present path was modified and is never auto-restored.
export async function treeHasPath(projectDir, treeSha, file) {
  try {
    await runGit(projectDir, ['cat-file', '-e', `${treeSha}:${file}`]);
    return true;
  } catch {
    return false;
  }
}

export async function workingTreeStatus(projectDir) {
  // raw: porcelain entries are fixed-column (`XY path`); a leading space on the
  // first entry (worktree-only change, e.g. ` M path`) must survive so callers
  // that slice the 3-char status prefix recover the exact path. -z emits the
  // path bytes unquoted (the newline format double-quotes spaces/non-ASCII,
  // which slice(3) would surface as a path matching nothing). --no-renames
  // keeps every record single-field — a rename entry would smuggle a second
  // NUL-separated origin path into the stream and garble slice(3) — and
  // mirrors diffFiles, so a staged rename surfaces as separate D/A entries
  // that match the allowed-dirty set the clean_tree gate builds from diffs.
  const output = await runGit(
    projectDir,
    ['status', '--porcelain=v1', '-z', '--untracked-files=all', '--no-renames'],
    { raw: true },
  );
  return output.split('\0').filter(Boolean);
}
