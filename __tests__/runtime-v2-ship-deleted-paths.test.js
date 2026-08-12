import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { currentTreeSha } from '../lib/runtime/git.js';
import { autoMergeGithub } from '../lib/runtime/gates.js';

// Behavioral contract (derived from the public shape of autoMergeGithub, not its
// internals): a land run whose only validated change is a deletion must be
// shippable. autoMergeGithub receives the run's changed_files via state.receipts
// and stages/commits/pushes them; a `git rm`-staged deletion of a HEAD-tracked
// path is a legitimate, stageable change (`git add -- <path>` stages the
// deletion fine), so shipping must NOT reject it as "no validated changed files".
// It may only reject a path that is unstageable everywhere: never tracked (not in
// HEAD, index, or the worktree).
//
// This suite also pins the RE-ENTRY heuristic that lets a crash-after-commit run
// resume. When a deletions-only commit lands but a later step (push/PR/merge)
// dies, a re-gate re-enters autoMergeGithub with the deletion already committed:
// `shippable` is then empty (the path is gone from index, disk, AND the new
// HEAD), yet the run genuinely did its work, so shipping must recognize the
// landed commit and proceed toward push again rather than throw NO_VALIDATED.
// That recognition must be RUN-BOUND: it is only legitimate when HEAD's tree
// advanced past the tree the run STARTED from (state.base_commit_sha), not merely
// past the global origin/<base> tip — otherwise a phantom-only validated set on a
// branch that was already diverged from origin at first entry would falsely
// proceed to push/PR/merge and ship nothing (an invariant-8 exposure).
//
// Why a REAL git repo (no mocks): the bug is that the addable filter trusts
// `git ls-files` (index-listed) OR on-disk existence. A `git rm`-staged deletion
// is neither — removed from the index AND gone from disk — yet still tracked in
// HEAD. Only real git reproduces `git ls-files` omitting a staged deletion;
// mocking git would let the fixture assert whatever it liked and hide the defect.
//
// No real network side effects: the origin is a github.com-shaped URL for a
// guaranteed-nonexistent repo, so the `gh pr view` probe fails closed (it can
// never return a MERGED PR) and execution reaches the addable filter; and any
// push fails fast because interactive credential prompts are disabled. Shipping
// is therefore exercised up to — and, once past the filter, through the commit to
// — the push against the fake origin, which is exactly the seam this ticket pins.
process.env.GIT_TERMINAL_PROMPT = '0';
process.env.GIT_CONFIG_GLOBAL = '/dev/null';
process.env.GIT_CONFIG_SYSTEM = '/dev/null';

// Real git plumbing, a real (fail-closed) gh probe, and a real currentTreeSha
// make each test do a little genuine work; keep the default 5s cap from tripping.
vi.setConfig({ testTimeout: 45_000, hookTimeout: 45_000 });

const NO_VALIDATED = 'shipping has no validated changed files';
const config = { shipping: { provider: 'github', required_remote_checks: false } };

const cleanups = [];
afterEach(async () => {
  await Promise.all(
    cleanups
      .splice(0)
      .map((dir) => rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })),
  );
});

function git(cwd, ...args) {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' },
  }).trim();
}

async function write(dir, file, body) {
  await mkdir(path.dirname(path.join(dir, file)), { recursive: true });
  await writeFile(path.join(dir, file), body);
}

// A committed baseline on `main`; an `origin/main` remote-tracking ref so
// resolveDefaultBase resolves the base offline (no ls-remote); a github.com
// origin pointing at a guaranteed-nonexistent repo so the PR probe fails closed;
// and a fresh feature branch checked out (shipping requires a feature branch).
// `seed(dir)` writes the files that go into the baseline commit. Returns the
// baseline commit sha as `baseSha` — the run's attested start point, which the
// real runtime always carries as state.base_commit_sha; the re-entry heuristic
// reads it, so every fixture state must set it.
async function baseRepo(seed) {
  const dir = await mkdtemp(path.join(tmpdir(), 'ape-ship-del-'));
  cleanups.push(dir);
  await seed(dir);
  git(dir, 'init', '-q');
  git(dir, 'symbolic-ref', 'HEAD', 'refs/heads/main');
  git(dir, 'config', 'user.email', 'ape@example.test');
  git(dir, 'config', 'user.name', 'APE Test');
  git(dir, 'config', 'commit.gpgsign', 'false');
  git(dir, 'add', '.');
  git(dir, 'commit', '-qm', 'baseline');
  const baseSha = git(dir, 'rev-parse', 'HEAD');
  git(dir, 'update-ref', 'refs/remotes/origin/main', 'refs/heads/main');
  git(dir, 'remote', 'add', 'origin', `https://github.com/ape-ship-fixture-${randomUUID()}/absent.git`);
  const branch = `ape/ship-${randomUUID().slice(0, 8)}`;
  git(dir, 'checkout', '-q', '-b', branch);
  return { dir, branch, baseSha };
}

// Like baseRepo, but the feature branch is PRE-DIVERGED from origin/<base>: after
// pinning origin/main to the baseline commit A, the feature branch adds its own
// commit B (modifying a tracked file) BEFORE shipping runs. So HEAD^{tree} (B)
// already differs from origin/main^{tree} (A) at first entry, while the run's
// attested start point IS B (baseSha === B). This is the shape that breaks a
// heuristic keyed only on the global origin tip: HEAD already sits past origin's
// tree even though the run has committed nothing of its own since it started.
async function divergedRepo(seed) {
  const dir = await mkdtemp(path.join(tmpdir(), 'ape-ship-div-'));
  cleanups.push(dir);
  await seed(dir);
  git(dir, 'init', '-q');
  git(dir, 'symbolic-ref', 'HEAD', 'refs/heads/main');
  git(dir, 'config', 'user.email', 'ape@example.test');
  git(dir, 'config', 'user.name', 'APE Test');
  git(dir, 'config', 'commit.gpgsign', 'false');
  git(dir, 'add', '.');
  git(dir, 'commit', '-qm', 'baseline');
  // origin/main pins to commit A; the feature branch diverges past it below.
  git(dir, 'update-ref', 'refs/remotes/origin/main', 'refs/heads/main');
  git(dir, 'remote', 'add', 'origin', `https://github.com/ape-ship-fixture-${randomUUID()}/absent.git`);
  const branch = `ape/ship-${randomUUID().slice(0, 8)}`;
  git(dir, 'checkout', '-q', '-b', branch);
  // Commit B: the divergence. The working tree ends clean at B, so a later
  // currentTreeSha reads B's tree and the ship-tree guard passes.
  await write(dir, 'keep.txt', 'keep\ndiverged\n');
  git(dir, 'add', '.');
  git(dir, 'commit', '-qm', 'diverged feature commit');
  const baseSha = git(dir, 'rev-parse', 'HEAD');
  return { dir, branch, baseSha };
}

function shipState(branch, changedFiles, treeSha, baseCommitSha) {
  return {
    run_id: 'run-ship-del-test',
    objective: 'Delete stale planning artifacts',
    mode: 'phase',
    lane: 'mechanical',
    branch,
    // The commit the run started at (its attested base). The real runtime always
    // carries it; the re-entry heuristic resolves its tree to keep the
    // already-committed decision run-bound instead of trusting the global origin
    // tip, and fails closed when it cannot be resolved.
    base_commit_sha: baseCommitSha,
    created_at: new Date().toISOString(),
    receipts: [{ changed_files: changedFiles }],
    // The tree the passed merge gates attested; shipping re-verifies it before
    // staging, so it must equal the repo's current tree (staged deletion incl.).
    gates: { passed: true, tree_sha: treeSha },
  };
}

// autoMergeGithub can never truly ship against the fake remote, so it always
// rejects; capture the rejection reason (a resolved value returns null and is a
// harness fault we assert against).
function shipError(dir, state) {
  return autoMergeGithub(dir, state, config).then(() => null, (err) => err);
}

// The terminal failure is the push against the fake origin (runGit surfaces the
// failing argv, so a push death names `git push`), NOT the addable filter's
// NO_VALIDATED throw and NOT a commit-step error. "push-shaped" = reached past
// the filter and the commit, died at the remote.
function expectPushShaped(error) {
  expect(error).not.toBeNull();
  const message = String(error?.message ?? error);
  expect(message).not.toContain(NO_VALIDATED);
  expect(message).toMatch(/git push\b/);
}

function headPaths(dir) {
  const listing = git(dir, 'ls-tree', '-r', '--name-only', 'HEAD');
  return listing === '' ? [] : listing.split('\n');
}

describe('autoMergeGithub ships a deletions-only diff (a git-rm-staged HEAD-tracked deletion is addable)', () => {
  it('clears the addable filter, COMMITS the deletion, and dies push-shaped when the only changed path is a staged deletion', async () => {
    const { dir, branch, baseSha } = await baseRepo(async (d) => {
      await write(d, 'keep.txt', 'keep\n');
      await write(d, '.planning/plan.md', '# plan\n');
    });
    // `git rm` stages the deletion: the path leaves the index AND the worktree,
    // so `git ls-files -- .planning/plan.md` reports nothing and it is absent on
    // disk — yet HEAD still tracks it, so `git add -- .planning/plan.md` stages
    // the deletion. This is the live incident's shape: a .planning deletion.
    git(dir, 'rm', '-q', '.planning/plan.md');
    const treeSha = await currentTreeSha(dir);
    const state = shipState(branch, ['.planning/plan.md'], treeSha, baseSha);

    const error = await shipError(dir, state);
    // It must still fail (the nonexistent remote cannot accept a push), but NOT
    // at the addable filter: a correct implementation recognizes the HEAD-tracked
    // path, proceeds past the filter, commits, and fails later at the push.
    expectPushShaped(error);
    // The deletion actually landed as a commit: HEAD no longer tracks the path
    // and the worktree is clean (the staged deletion was consumed by the commit).
    expect(headPaths(dir)).not.toContain('.planning/plan.md');
    expect(headPaths(dir)).toContain('keep.txt');
    expect(git(dir, 'status', '--porcelain')).toBe('');
  });

  it('still refuses a lone changed path that was never tracked and is absent from disk (guard pin, even with base)', async () => {
    const { dir, branch, baseSha } = await baseRepo(async (d) => {
      await write(d, 'keep.txt', 'keep\n');
    });
    const treeSha = await currentTreeSha(dir);
    // ghost.md was never in HEAD, the index, or the worktree: unstageable
    // everywhere, so `git add` would hard-fail — the error must stand. The
    // feature branch is EVEN WITH its base (no commit of its own), so the
    // already-committed re-entry heuristic never fires: NO_VALIDATED holds both
    // today and after the hardening, pinning that the guard is not simply removed
    // (a stage-created-then-deleted phantom stays correctly excluded).
    const state = shipState(branch, ['.planning/ghost.md'], treeSha, baseSha);

    const error = await shipError(dir, state);
    expect(error).not.toBeNull();
    expect(String(error?.message ?? error)).toContain(NO_VALIDATED);
  });

  it('COMMITS both a staged deletion and a modified existing file when they ship together', async () => {
    const { dir, branch, baseSha } = await baseRepo(async (d) => {
      await write(d, 'keep.txt', 'keep\n');
      await write(d, '.planning/plan.md', '# plan\n');
    });
    git(dir, 'rm', '-q', '.planning/plan.md');
    await write(dir, 'keep.txt', 'keep\nmodified\n');
    const treeSha = await currentTreeSha(dir);
    const state = shipState(branch, ['.planning/plan.md', 'keep.txt'], treeSha, baseSha);

    const error = await shipError(dir, state);
    // Reaches past the filter and dies only at the push — proving the fixture is
    // isolated to the push against the fake origin.
    expectPushShaped(error);
    // BOTH changes committed: the deletion is gone from HEAD and the
    // modification is the committed content of keep.txt; the worktree is clean.
    expect(headPaths(dir)).not.toContain('.planning/plan.md');
    expect(git(dir, 'show', 'HEAD:keep.txt')).toBe('keep\nmodified');
    expect(git(dir, 'status', '--porcelain')).toBe('');
  });

  it('re-enters idempotently: a SECOND ship after the commit+push-death proceeds to push again, never NO_VALIDATED', async () => {
    const { dir, branch, baseSha } = await baseRepo(async (d) => {
      await write(d, 'keep.txt', 'keep\n');
      await write(d, '.planning/plan.md', '# plan\n');
    });
    git(dir, 'rm', '-q', '.planning/plan.md');
    const treeSha = await currentTreeSha(dir);
    const state = shipState(branch, ['.planning/plan.md'], treeSha, baseSha);

    // First call: the deletion is shippable, so it commits and then dies at the
    // push against the fake origin.
    const first = await shipError(dir, state);
    expectPushShaped(first);
    expect(headPaths(dir)).not.toContain('.planning/plan.md');
    expect(git(dir, 'status', '--porcelain')).toBe('');

    // The commit consumed the staged deletion but did NOT touch the working-tree
    // files, so the gate-attested tree still matches — re-entry is admissible
    // under the SAME state (the ship-tree guard will pass again).
    expect(await currentTreeSha(dir)).toBe(treeSha);

    // Second call with the SAME state: `shippable` is now empty (the path is gone
    // from index, disk, AND the new HEAD), but the run genuinely committed its
    // work, so the already-committed re-entry heuristic must recognize the landed
    // commit and proceed to push again — never regress to NO_VALIDATED. HEAD's
    // tree advanced past BOTH origin/main's tree and the run's attested base
    // (state.base_commit_sha), so the run-bound heuristic proceeds.
    const second = await shipError(dir, state);
    expectPushShaped(second);
  });
});

describe('autoMergeGithub keys the already-committed re-entry decision to the run base, not the global origin tip', () => {
  it('refuses a phantom-only validated set on a PRE-DIVERGED branch whose HEAD tree equals the run base tree (RED anchor)', async () => {
    // origin/main pins to A; the feature branch already committed B before
    // shipping, and the run's attested base is B. So HEAD^{tree} (B) != the
    // global origin/main^{tree} (A), but HEAD^{tree} (B) == base_commit_sha^{tree}
    // (B): the run has committed nothing of its OWN since it started.
    const { dir, branch, baseSha } = await divergedRepo(async (d) => {
      await write(d, 'keep.txt', 'keep\n');
    });
    const treeSha = await currentTreeSha(dir);
    // The only validated change is a path that was NEVER tracked and is absent
    // from disk — nothing was staged, nothing was committed by this run. Shipping
    // has genuinely no validated change to land.
    const state = shipState(branch, ['phantom/never-existed.txt'], treeSha, baseSha);

    const error = await shipError(dir, state);
    // A run-bound heuristic sees HEAD's tree has NOT advanced past the run's base
    // tree (both are B), so the empty `shippable` set is a true no-op: it must
    // throw NO_VALIDATED, not proceed to push a phantom ship. A heuristic keyed
    // only on the global origin tip wrongly sees HEAD (B) != origin (A) and
    // proceeds toward the push — that is the invariant-8 exposure this pins.
    expect(error).not.toBeNull();
    expect(String(error?.message ?? error)).toContain(NO_VALIDATED);
  });

  it('still proceeds for a genuine crash-after-commit re-entry on a pre-diverged branch (the ship commit advanced HEAD past its base)', async () => {
    // Same pre-diverged shape, but here the run legitimately committed a deletion
    // of its own AFTER B. HEAD's tree now differs from BOTH origin/main (A) and
    // the run base (B), so the run-bound heuristic must still proceed to push —
    // proving the hardening does not over-refuse legitimate re-entry.
    const { dir, branch } = await divergedRepo(async (d) => {
      await write(d, 'keep.txt', 'keep\n');
      await write(d, '.planning/plan.md', '# plan\n');
    });
    // The run's base is B (the diverged commit that already carries .planning).
    const baseSha = git(dir, 'rev-parse', 'HEAD');
    git(dir, 'rm', '-q', '.planning/plan.md');
    const treeSha = await currentTreeSha(dir);
    const state = shipState(branch, ['.planning/plan.md'], treeSha, baseSha);

    // First call commits the deletion (advancing HEAD past B) and dies at push.
    const first = await shipError(dir, state);
    expectPushShaped(first);
    expect(headPaths(dir)).not.toContain('.planning/plan.md');
    expect(await currentTreeSha(dir)).toBe(treeSha);

    // Re-entry: `shippable` is empty, but HEAD's tree advanced past the run base
    // (B) — a genuine crash-after-commit — so shipping proceeds to push again.
    const second = await shipError(dir, state);
    expectPushShaped(second);
  });
});

// The re-entry emptiness guard fails closed when EITHER base tree is
// unresolvable (origin/<base> tree or the run-bound state.base_commit_sha tree
// resolves to null) while every other idempotency precondition holds (worktree
// equals the gate tree, nothing staged, `shippable` empty). Failing closed is
// correct, but the operator-facing message must diagnose WHICH tree could not be
// resolved and suggest the remedy (fetch the base ref / verify the run's base
// commit exists) instead of the misleading generic NO_VALIDATED. When both trees
// resolve fine the genuine no-op must still throw exactly NO_VALIDATED, so the
// diagnostic is scoped to true unresolvability, never a resolved-but-equal tree.
describe('autoMergeGithub diagnoses an unresolvable re-entry base tree instead of the generic NO_VALIDATED, while keeping the generic throw when trees resolve', () => {
  // A well-formed 40-hex sha that names no object in the repo: `rev-parse
  // <sha>^{tree}` resolves to null (the run base tree is unresolvable) without
  // being a malformed argument.
  const UNRESOLVABLE_SHA = 'deadbeef'.repeat(5);

  it('re-entry with an unresolvable run base commit (state.base_commit_sha) diagnoses that sha and a remedy, not the generic NO_VALIDATED (RED anchor, runBaseTree arm)', async () => {
    const { dir, branch, baseSha } = await baseRepo(async (d) => {
      await write(d, 'keep.txt', 'keep\n');
      await write(d, '.planning/plan.md', '# plan\n');
    });
    git(dir, 'rm', '-q', '.planning/plan.md');
    const treeSha = await currentTreeSha(dir);

    // First ship with a VALID base: the deletion is shippable, so it commits and
    // then dies push-shaped against the fake origin. HEAD now advances past both
    // the origin tip AND the run base — the crash-after-commit shape.
    const first = await shipError(dir, shipState(branch, ['.planning/plan.md'], treeSha, baseSha));
    expectPushShaped(first);
    expect(headPaths(dir)).not.toContain('.planning/plan.md');
    expect(await currentTreeSha(dir)).toBe(treeSha);

    // Re-enter with the SAME state except base_commit_sha is the well-formed but
    // unresolvable sha. origin/<base> tree still resolves (HEAD advanced past
    // it), but the RUN base tree resolves null while `shippable` is empty and
    // nothing is staged. The guard must fail closed with a DIAGNOSTIC that names
    // the unresolvable commit and a remedy — not the generic misdiagnosis, and
    // never a push. The remedy fragment (not the sha, which a raw git rev-parse
    // error also echoes) is the load-bearing part: it survives even if the
    // rev-parse `.catch(() => null)` is stripped.
    const error = await shipError(dir, shipState(branch, ['.planning/plan.md'], treeSha, UNRESOLVABLE_SHA));
    expect(error).not.toBeNull();
    const message = String(error?.message ?? error);
    expect(message).not.toContain(NO_VALIDATED);
    expect(message).not.toMatch(/git push\b/);
    expect(message).toContain(UNRESOLVABLE_SHA);
    expect(message).toMatch(/verify/i);
  });

  it('re-entry when origin/<base> tree is unresolvable (base ref deleted under a dangling symref) diagnoses the base ref and a fetch remedy (RED anchor, origin arm)', async () => {
    const { dir, branch, baseSha } = await baseRepo(async (d) => {
      await write(d, 'keep.txt', 'keep\n');
      await write(d, '.planning/plan.md', '# plan\n');
    });
    // A dangling origin/HEAD symref: resolveDefaultBase reads it FIRST and still
    // answers 'main' via the symref even after refs/remotes/origin/main itself is
    // deleted below — so execution reaches the emptiness guard with the base ref
    // present-by-name but tree-unresolvable (rather than failing earlier in
    // resolveDefaultBase). baseRepo already pins refs/remotes/origin/main to the
    // baseline; point the symref at it.
    git(dir, 'symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/main');
    git(dir, 'rm', '-q', '.planning/plan.md');
    const treeSha = await currentTreeSha(dir);
    const state = shipState(branch, ['.planning/plan.md'], treeSha, baseSha);

    // First ship (origin/main still present) commits the deletion and dies push-shaped.
    const first = await shipError(dir, state);
    expectPushShaped(first);
    expect(headPaths(dir)).not.toContain('.planning/plan.md');
    expect(await currentTreeSha(dir)).toBe(treeSha);

    // Delete the base ref AFTER the ship commit: resolveDefaultBase still resolves
    // 'main' through the dangling symref, but refs/remotes/origin/main^{tree} now
    // resolves null while the VALID run base tree resolves fine — the origin arm
    // in isolation.
    git(dir, 'update-ref', '-d', 'refs/remotes/origin/main');

    const error = await shipError(dir, state);
    expect(error).not.toBeNull();
    const message = String(error?.message ?? error);
    expect(message).not.toContain(NO_VALIDATED);
    expect(message).not.toMatch(/git push\b/);
    expect(message).toContain('origin/main');
    expect(message).toMatch(/fetch/i);
  });

  it('keeps EXACTLY the generic NO_VALIDATED when both base trees resolve but origin/<base> was advanced onto the ship head (origin-tip conjunct pin, GREEN)', async () => {
    const { dir, branch, baseSha } = await baseRepo(async (d) => {
      await write(d, 'keep.txt', 'keep\n');
      await write(d, '.planning/plan.md', '# plan\n');
    });
    git(dir, 'rm', '-q', '.planning/plan.md');
    const treeSha = await currentTreeSha(dir);
    const state = shipState(branch, ['.planning/plan.md'], treeSha, baseSha);

    // First ship commits the deletion (HEAD tree now != baseSha tree) and dies push-shaped.
    const first = await shipError(dir, state);
    expectPushShaped(first);
    const shipHead = git(dir, 'rev-parse', 'HEAD');
    expect(await currentTreeSha(dir)).toBe(treeSha);

    // Point origin/main AT the ship commit: HEAD^{tree} == origin/main^{tree}
    // (the origin-tip conjunct is now false) while HEAD^{tree} != baseSha^{tree}
    // (the run-base conjunct stays true). Both trees resolve fine, so this is a
    // genuine no-op re-entry — NOT an unresolvable-tree case — and must refuse
    // with EXACTLY the generic message. Dropping the origin-tip conjunct alone
    // would satisfy `alreadyCommitted` here and proceed to push instead.
    git(dir, 'update-ref', 'refs/remotes/origin/main', shipHead);

    const error = await shipError(dir, state);
    expect(error).not.toBeNull();
    expect(String(error?.message ?? error)).toBe(NO_VALIDATED);
  });
});
