import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { hostname } from 'node:os';
import { access, mkdir, mkdtemp, open, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { constants as fsConstants, realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { sha256 } from './canonical.js';
import {
  CHECKS_REGISTRATION_WINDOW_MS,
  GATE_RUNNER_HEARTBEAT_MS,
  GATE_RUNNER_MAX_SPAWNS,
  GATE_RUNNER_STALE_MS,
  GATE_SUITE_TEMP_SWEEP_SCAN_CAP,
  GATE_SUITE_TEMP_SWEEP_STALE_MS,
} from './constants.js';
import { buildSpawnPlan, detectTestRunner, GATE_RUNNER_SENTINEL, runTestSuite, splitCommand, targetedInvocation, templateInvocation } from './runner.js';
import { atomicWriteJson, readJson } from './storage.js';
import { currentTreeSha, remoteBranchTip, runGit, workingTreeStatus } from './git.js';
import { normalizeClaimPath, TEST_PATH_PATTERN } from './path-scope.js';
import { spawnDetached, spawnWithTimeout } from './spawn.js';
import { validateClaudePlugin, validateCodexPlugin } from './plugin-validation.js';
import { exists } from './gate-evaluation.js';
import { assertQueuedShippingProtection, assertShippingOriginCurrent, resolveFrozenShippingTarget, shippingPrUrlMatches } from './shipping-target.js';
export { inspectShippingAdmission } from './shipping-target.js';

// Bounded helper for non-suite gate commands (`gh pr checks --watch` runs for
// up to 45 minutes). Tree kill with escalation and a drained settle live in
// spawnWithTimeout: a gh invocation that outlives its deadline must never
// park the merge inside the receipt-effects lock. Output stays interleaved
// stdout+stderr by arrival, which the PR-URL scan below relies on.
async function run(command, args, cwd, timeoutMs = 120_000) {
  const result = await spawnWithTimeout(command, args, {
    cwd,
    shell: false,
    collect: 'combined',
    timeout_ms: timeoutMs,
  });
  if (result.spawn_error) {
    return { passed: false, exit_code: null, output: result.spawn_error.message };
  }
  return {
    passed: result.exit_code === 0 && result.timed_out !== true,
    exit_code: result.exit_code,
    output: result.combined,
    ...(result.timed_out === true ? { timed_out: true } : {}),
  };
}

// Word-boundary truncation for commit subjects and PR titles (friction #12):
// the old blind slice(0, 72) shipped `feat: Add a runtime-owned re-gate
// recovery operation: a run blocked at t` — cut mid-word — for every
// objective longer than ~65 chars. Cut at the last space inside the budget
// and mark the cut with an ellipsis. A cut that would keep almost nothing is
// degenerate (one enormous word; `feat: ` alone puts a space at index 5), so
// it falls back to the hard slice: bounded beats pretty there.
function truncateAtWordBoundary(text, max = 72) {
  if (text.length <= max) return text;
  const hard = text.slice(0, max - 1);
  const cut = hard.lastIndexOf(' ');
  if (cut < 8) return `${hard}…`;
  return `${hard.slice(0, cut).trimEnd()}…`;
}

// The one no-checks message `gh pr checks` emits (stable across gh versions:
// "no checks reported on the '<branch>' branch"). Deliberately narrow — any
// other failure text is a real verdict and must never be retried.
const NO_CHECKS_PATTERN = /no checks reported/i;
const AUTO_MERGE_REQUIRED_PATTERN = /branch policy prohibits the merge|add the [`']?--auto[`']? flag/i;
function assertFrozenAutoMergeAuthority(state, config) {
  if (state.ship_requested === true) return;
  if (state.auto_merge_authorized === true && config.shipping?.auto_merge === true) return;
  throw new Error('shipping requires admitted auto-merge authorization or the audited one-shot SHIP consent marker');
}

async function runAuthorizedGitMutation(projectDir, args, options = undefined, target = undefined) {
  if (target) await assertShippingOriginCurrent(projectDir, target);
  return runGit(projectDir, args, options);
}

async function runAuthorizedGithub(projectDir, args, target, timeoutMs = 120_000) {
  await assertShippingOriginCurrent(projectDir, target);
  const commandArgs = target.enforce
    ? [...args, '--repo', target.github_repository]
    : args;
  return run('gh', commandArgs, projectDir, timeoutMs);
}

async function assertShippingBaseCurrent(projectDir, state, target) {
  await assertShippingOriginCurrent(projectDir, target);
  const advertised = await remoteBranchTip(projectDir, target.git_remote, target.base);
  if (advertised !== state.base_commit_sha.toLowerCase()) {
    throw new Error('shipping refused because the remote base advanced from the admitted commit; preserve this run and its work, then deliberately refresh the base and obtain new gate evidence before shipping');
  }
}

function fetchBaseArgs(target, base) {
  return target.enforce
    ? [
        'fetch',
        target.git_remote,
        `+refs/heads/${base}:refs/remotes/origin/${base}`,
      ]
    : ['fetch', 'origin', base];
}

function pullBaseArgs(target, base) {
  return target.enforce
    ? ['pull', '--ff-only', target.git_remote, base]
    : ['pull', '--ff-only', 'origin', base];
}

async function assertMergedTreeAttested(projectDir, state, base, target) {
  const expected = state.gates?.tree_sha ?? null;
  if (!/^[0-9a-f]{40}$/i.test(expected ?? '')) {
    throw new Error('shipping cannot verify the frozen base without the attested gate tree');
  }
  await runAuthorizedGitMutation(
    projectDir,
    fetchBaseArgs(target, base),
    { timeout_ms: 120_000 },
    target,
  );
  const observed = await runGit(projectDir, ['rev-parse', `refs/remotes/origin/${base}^{tree}`]);
  if (observed !== expected) {
    throw new Error(`merged origin/${base} tree ${observed} does not equal the attested tree ${expected}`);
  }
}

// Parse the newest `STATE URL MERGED_AT HEAD_OID` line out of the PR probe.
// run() interleaves stderr by arrival, so scan lines in reverse for the
// shaped one instead of trusting the last line.
function parsePrProbe(output) {
  const line = output.trim().split(/\r?\n/)
    .map((entry) => entry.trim())
    .reverse()
    .find((entry) => /^(OPEN|MERGED|CLOSED) https:\/\/\S+ \S+ \S+$/.test(entry));
  if (!line) return null;
  const [prState, url, mergedAt, headOid] = line.split(' ');
  return { state: prState, url, merged_at: mergedAt === '-' ? null : mergedAt, head_oid: headOid };
}

// Post-merge local cleanup. Idempotent by construction — fetch and switch
// tolerate re-runs, the ff-only pull is a no-op when already current, and the
// branch delete tolerates an already-deleted branch — so the merged-PR
// re-entry path can re-run it safely.
async function finalizeAfterMerge(projectDir, branch, base, target) {
  try {
    await runAuthorizedGitMutation(projectDir, fetchBaseArgs(target, base), { timeout_ms: 120_000 }, target);
    const remoteBase = `refs/remotes/origin/${base}`;
    const localBase = await runGit(
      projectDir,
      ['show-ref', '--verify', '--quiet', `refs/heads/${base}`],
    ).then(() => true, () => false);
    if (localBase) {
      await runAuthorizedGitMutation(projectDir, ['switch', base], { timeout_ms: 120_000 });
    } else {
      await runAuthorizedGitMutation(
        projectDir,
        ['switch', '-c', base, remoteBase, '--no-track'],
        { timeout_ms: 120_000 },
      );
    }
    try {
      await runAuthorizedGitMutation(projectDir, pullBaseArgs(target, base), { timeout_ms: 120_000 }, target);
    } catch (pullError) {
      // A land run starts from an already-committed diff on the local base.
      // GitHub's squash commit has a different identity from that commit even
      // though it materializes the exact same tree, so an ff-only pull cannot
      // align the two histories. The remote merge has already been proven at
      // the run-attested PR head before cleanup reaches this helper. Compare
      // the complete live checkout (including staged/untracked content and
      // excluding APE runtime state) with the fetched squash tree; only an
      // exact match permits moving the local base ref to the observed merge.
      // Any real content drift preserves the old non-destructive failure.
      const [checkoutTree, remoteTree] = await Promise.all([
        currentTreeSha(projectDir),
        runGit(projectDir, ['rev-parse', `${remoteBase}^{tree}`]),
      ]);
      if (checkoutTree !== remoteTree) throw pullError;
      await runAuthorizedGitMutation(projectDir, ['reset', '--hard', remoteBase], { timeout_ms: 120_000 });
    }
    await runAuthorizedGitMutation(projectDir, ['branch', '-D', branch]).catch(() => {});
    return { cleaned: true };
  } catch (error) {
    // The remote merge is already proven before this helper runs. Local
    // checkout hygiene must not rewrite that truth into a shipping failure —
    // most notably when another worktree owns the base branch. Terminal state
    // reconciliation retries independently and records retained_error guidance
    // while the completed run remains truthful.
    return { cleaned: false, reason: boundedTail(error?.message ?? String(error)) };
  }
}

// A PR can cross OPEN -> MERGED after the poll's state probe but before the
// subsequent `gh pr merge` command reaches GitHub. In that race the command
// may fail with "not mergeable" even though GitHub already merged the exact
// pushed head (most commonly because protected auto-merge completed). Re-probe
// after a failed merge command and adopt only the run-attested head; any other
// state falls back to the original failure handling.
async function reconcileMergedAfterCommandFailure(projectDir, selector, watch, state, target) {
  const probe = await runAuthorizedGithub(projectDir, [
    'pr', 'view', selector,
    '--json', 'url,state,mergedAt,headRefOid',
    '--jq', '[.state, .url, (.mergedAt // "-"), .headRefOid] | join(" ")',
  ], target, 120_000);
  const pr = probe.passed ? parsePrProbe(probe.output) : null;
  if (pr?.state !== 'MERGED') return null;
  if (pr.head_oid !== watch.head_oid) {
    return { failed: `pull request ${watch.pr_url} was merged at a drifted head (${pr.head_oid}), not the pushed commit ${watch.head_oid}; refusing to complete this run on an external merge (invariant 8)` };
  }
  await assertMergedTreeAttested(projectDir, state, watch.base, target);
  await finalizeAfterMerge(projectDir, watch.branch, watch.base, target);
  return {
    merged: {
      provider: 'github',
      url: pr.url ?? watch.pr_url,
      branch: watch.branch,
      base: watch.base,
      merged_at: pr.merged_at ?? new Date().toISOString(),
      provenance: 'observed-after-merge-command',
    },
  };
}

// A successful `gh pr merge` can enqueue rather than merge. Command success
// therefore proves submission only; require a fresh exact PR observation
// before checking the merged tree or touching the local checkout. The cursor
// is deny-only: the service persists it to suppress another merge submission.
async function observeSubmittedMerge(projectDir, watch, state, target, reason = 'awaiting merge') {
  const pending = (summary) => ({ pending: {
    summary: boundedTail(summary), reason: boundedTail(reason), merge_request_submitted: true,
  } });
  const probe = await runAuthorizedGithub(projectDir, [
    'pr', 'view', watch.pr_url,
    '--json', 'url,state,mergedAt,headRefOid',
    '--jq', '[.state, .url, (.mergedAt // "-"), .headRefOid] | join(" ")',
  ], target, 120_000);
  if (!probe.passed) return pending('merge request submitted; PR state not yet readable');
  const pr = parsePrProbe(probe.output);
  if (!pr || !/^[0-9a-f]{40}$/i.test(pr.head_oid) ||
      (pr.state === 'MERGED' && !Number.isFinite(Date.parse(pr.merged_at ?? '')))) {
    return { failed: 'submitted merge has a malformed PR observation; no completion or cleanup is authorized' };
  }
  if (!shippingPrUrlMatches(pr.url, target)) return { failed: 'pull request URL does not match the frozen shipping repository' };
  if (pr.head_oid !== watch.head_oid) return { failed: 'submitted merge PR head drifted from the exact pushed head; no completion or cleanup is authorized' };
  if (pr.state === 'CLOSED') return { failed: 'submitted merge PR was closed without merging; no completion or cleanup is authorized' };
  if (pr.state === 'OPEN') return pending('merge request submitted; awaiting the exact PR merge');
  try {
    await assertMergedTreeAttested(projectDir, state, watch.base, target);
  } catch (error) {
    return { failed: boundedTail(error?.message ?? String(error)) };
  }
  await finalizeAfterMerge(projectDir, watch.branch, watch.base, target);
  return {
    merged: {
      provider: 'github', url: pr.url, branch: watch.branch, base: watch.base,
      merged_at: pr.merged_at, provenance: 'observed-after-merge-command',
    },
  };
}

const SIGNING_FAILURE_PATTERN = /enter passphrase|incorrect passphrase|could(?:n't| not) get agent socket|gpg failed to sign|failed to sign the data|ssh-keygen.*sign/i;

async function commitShippingChange(projectDir, subject) {
  try {
    await runAuthorizedGitMutation(projectDir, ['commit', '-m', subject], { timeout_ms: 120_000 });
  } catch (error) {
    if (!SIGNING_FAILURE_PATTERN.test(error?.message ?? String(error))) throw error;
    // Shipping consent never waives an explicitly configured signature. Keep
    // the tested staged content and require a deliberate signing decision;
    // key paths, prompts, and signer output do not belong in recovery guidance.
    throw new Error('shipping commit signing failed; preserve the staged work and explicitly resolve the configured signing policy before retrying; no unsigned fallback was attempted');
  }
}

// Stage into a private COPY of the actual index first. Starting from HEAD
// would hide unrelated pre-staged content that the real commit would include.
// The copy never follows an index symlink or blocks on a special file.
async function assertProspectiveShippingTree(projectDir, toAdd, expectedTree) {
  const indexName = await runGit(projectDir, ['rev-parse', '--git-path', 'index']);
  const indexPath = path.resolve(projectDir, indexName);
  const handle = await open(indexPath, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK);
  let bytes;
  try {
    const metadata = await handle.stat();
    if (!metadata.isFile() || metadata.size > 67_108_864) throw new Error('shipping index is not a bounded regular file');
    bytes = Buffer.alloc(metadata.size);
    let offset = 0;
    while (offset < bytes.length) {
      const result = await handle.read(bytes, offset, bytes.length - offset, offset);
      if (result.bytesRead === 0) throw new Error('shipping index changed during inspection');
      offset += result.bytesRead;
    }
    const after = await handle.stat();
    if (after.size !== metadata.size || after.mtimeMs !== metadata.mtimeMs || after.ctimeMs !== metadata.ctimeMs) {
      throw new Error('shipping index changed during inspection');
    }
  } finally {
    await handle.close();
  }
  const temporary = await mkdtemp(path.join(tmpdir(), 'ape-ship-index-'));
  const scratch = path.join(temporary, 'index');
  try {
    await writeFile(scratch, bytes, { mode: 0o600, flag: 'wx' });
    const options = { env: { GIT_INDEX_FILE: scratch, GIT_OPTIONAL_LOCKS: '0' }, timeout_ms: 120_000 };
    if (toAdd.length > 0) await runGit(projectDir, ['add', '--', ...toAdd], options);
    const prospective = await runGit(projectDir, ['write-tree'], options);
    if (prospective !== expectedTree) {
      throw new Error('prospective shipping index differs from the passed-gate tree; preserve and inspect untested pre-staged content');
    }
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

async function assertIndexTree(projectDir, expectedTree) {
  if (await runGit(projectDir, ['write-tree']) !== expectedTree) {
    throw new Error('staged shipping tree differs from the passed-gate tree; commit refused');
  }
}

async function assertCommittedTree(projectDir, expectedTree) {
  const head = await runGit(projectDir, ['rev-parse', 'HEAD']);
  if (!/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/.test(head) ||
      await runGit(projectDir, ['rev-parse', `${head}^{tree}`]) !== expectedTree) {
    throw new Error('committed shipping tree differs from the passed-gate tree; push refused');
  }
  return head;
}

// Returns the in-call merge shape `{ provider, url, branch, base, merged_at }`
// (required_remote_checks:false, or a re-entry that finds the run's PR already
// merged) OR the non-blocking `{ watch: {...} }` handoff descriptor
// (required_remote_checks !== false). The service discriminates on the `watch`
// key. Fields are optional in the annotation so both shapes assign.
/**
 * @returns {Promise<{
 *   watch?: { provider: string, pr_url: string, branch: string, base: string, head_oid: string, created_at: string, shipping_target: object, merge_request_submitted?: boolean },
 *   provider?: string, url?: string, branch?: string, base?: string, merged_at?: string,
 * }>}
 */
export async function autoMergeGithub(projectDir, state, config) {
  if (config.shipping?.provider !== 'github') throw new Error('unsupported merge provider');
  assertFrozenAutoMergeAuthority(state, config);
  // Resolve only the target frozen at admission. Current configuration and
  // fetch/push origins must still agree; effects use the frozen URL and repo.
  const target = await resolveFrozenShippingTarget(projectDir, state, config);
  // Ship the live branch when it is a feature branch. After a fully-merged PR
  // whose local cleanup failed, the live branch is the base — `gh pr merge
  // --delete-branch` switches the checkout to the default branch before
  // deleting — so the run's recorded branch stands in for the merged-PR probe
  // below. Committing or pushing FROM the base stays forbidden either way.
  const isFeatureBranch = (name) => Boolean(name) && name !== target.base && name !== 'main' && name !== 'master';
  const liveBranch = await runGit(projectDir, ['branch', '--show-current']);
  if (isFeatureBranch(liveBranch) && liveBranch !== state.branch) {
    throw new Error('shipping checkout is not the run-bound feature branch');
  }
  const branch = isFeatureBranch(liveBranch) ? liveBranch
    : isFeatureBranch(state.branch) ? state.branch
      : null;
  if (!branch) throw new Error('shipping requires a feature branch');
  // The full branch name is frozen; no live default-branch inference or
  // legacy target upgrade is allowed at a shipping sink.
  const base = target.base;
  const changedFiles = [...new Set(state.receipts.flatMap((receipt) => receipt.changed_files))];
  if (changedFiles.length === 0) throw new Error('shipping has no validated changed files');
  // Shipping must be re-entrant: any failure past the commit below (push, PR
  // creation, the checks-registration race, the merge call, local cleanup)
  // blocks the run at stage gates, and the runtime's own hinted recovery —
  // REGATE — re-enters this function with some effects already applied. Dying
  // at `git commit` on the then-clean tree burned every bounded re-gate
  // attempt (friction #4/#21). Probe the branch's PR state first; every later
  // step is individually idempotent or probe-guarded.
  const probe = await runAuthorizedGithub(projectDir, [
    'pr', 'view', branch,
    '--json', 'url,state,mergedAt,headRefOid',
    '--jq', '[.state, .url, (.mergedAt // "-"), .headRefOid] | join(" ")',
  ], target, 120_000);
  const existing = probe.passed ? parsePrProbe(probe.output) : null;
  if (existing && !shippingPrUrlMatches(existing.url, target)) throw new Error('pull request URL does not match the frozen shipping repository');
  if (existing?.state === 'MERGED') {
    // gh resolves a branch name to its most recent PR, so MERGED can name a
    // stale PR from a previous life of a reused branch name. Continue only
    // when the PR is provably this run's shipped work. When phase 1 persisted a
    // pushed-head attestation (state.shipping_watch.head_oid), the proof is an
    // EXACT head match — the same A2 rule the poll phase enforces — so a merge
    // that landed at a DIFFERENT head (someone else's merge over unrelated
    // commits) is never adopted, even if it merged during the run. Only when NO
    // watch was persisted does the looser evidence stand: the merged head is the
    // local HEAD (re-entry from the feature branch), or the PR merged after this
    // run started (re-entry after gh already switched the checkout to the base
    // and deleted the branch). A stale/foreign merged PR completing a run that
    // shipped nothing would violate truthful completion (invariant 8).
    const attestedHead = state.shipping_watch?.head_oid ?? null;
    const head = await runGit(projectDir, ['rev-parse', 'HEAD']);
    const mergedDuringRun = Date.parse(existing.merged_at ?? '') >= Date.parse(state.created_at ?? '');
    const provenBySelf = attestedHead
      ? existing.head_oid === attestedHead
      : existing.head_oid === head || mergedDuringRun;
    if (provenBySelf) {
      // Never push on this path: --delete-branch removed the remote branch,
      // and a re-entry push would recreate it. Only local cleanup remains.
      await assertMergedTreeAttested(projectDir, state, base, target);
      await finalizeAfterMerge(projectDir, branch, base, target);
      return {
        provider: 'github',
        url: existing.url,
        branch,
        base,
        merged_at: existing.merged_at ?? new Date().toISOString(),
      };
    }
  }
  if (!isFeatureBranch(liveBranch)) throw new Error('shipping requires a feature branch');
  // Re-prove the run's base immediately before the first shipping mutation.
  // A passing local gate suite is evidence about the tree built on the
  // attested base; if the server's default branch moved meanwhile, pushing or
  // merging that result would ship evidence for a different merge tree.
  await assertShippingBaseCurrent(projectDir, state, target);
  // Split the changed set two ways against git's actual pathspec rules. `git add
  // -- <path>` matches a pathspec against the INDEX and the worktree only, never
  // HEAD (builtin/add.c), so a `git rm`-staged deletion — gone from the index
  // AND the worktree yet still tracked in HEAD — dies "pathspec did not match
  // any files" if handed to `git add`. But a HEAD-tracked path absent from the
  // index IS an already-staged deletion by definition, and it rides into the
  // commit through the index untouched. So `toAdd` (the `git add` argv) takes
  // only pathspecs git can match — index-listed (`git ls-files`) or on disk —
  // while `shippable` (the emptiness guard's set) additionally counts the
  // already-staged deletion. raw: -z output is already NUL-delimited; trim would
  // eat the leading space of a space-prefixed first path before the split.
  const trackedOutput = await runGit(projectDir, ['ls-files', '-z', '--', ...changedFiles], { raw: true });
  const tracked = new Set(trackedOutput.split('\0').filter(Boolean));
  const headOutput = await runGit(projectDir, ['ls-tree', '-r', '--name-only', '-z', 'HEAD', '--', ...changedFiles], { raw: true });
  const headTracked = new Set(headOutput.split('\0').filter(Boolean));
  const toAdd = [];
  const shippable = [];
  for (const file of changedFiles) {
    const inIndex = tracked.has(file);
    const onDisk = await exists(path.join(projectDir, file));
    if (inIndex || onDisk) toAdd.push(file);
    if (inIndex || onDisk || headTracked.has(file)) shippable.push(file);
  }
  // Recompute the tree immediately before staging (F4): an external write in the
  // window between gates passing and the merge would ship bytes no gate and no
  // receipt ever attested. Hoisted above the emptiness guard so the re-entry
  // decision below can read shipTreeSha === gateTreeSha; the guard itself is
  // unchanged, so an out-of-band write still fails closed here with 'working
  // tree changed after gates passed' whether or not the candidate set is empty.
  const gateTreeSha = state.gates?.tree_sha ?? null;
  if (!gateTreeSha) throw new Error('shipping requires a recorded passed-gate tree');
  const shipTreeSha = await currentTreeSha(projectDir);
  if (shipTreeSha !== gateTreeSha) {
    throw new Error(`working tree changed after gates passed (gate tree ${gateTreeSha}, ship tree ${shipTreeSha})`);
  }
  await resolveFrozenShippingTarget(projectDir, state, config);
  await assertProspectiveShippingTree(projectDir, toAdd, gateTreeSha);
  // Stage only the pathspecs git can match; a `git rm`-staged deletion is
  // already in the index and must never reach `git add`. Skipping an empty argv
  // is what lets a deletions-only diff through — a deletion-only path list would
  // otherwise die at the pathspec, taking every re-gate attempt with it.
  if (toAdd.length > 0) {
    await runAuthorizedGitMutation(projectDir, ['add', '--', ...toAdd], { timeout_ms: 120_000 });
  }
  await assertIndexTree(projectDir, gateTreeSha);
  // Idempotent commit: on re-entry after a successful commit `git add` stages
  // nothing and `git commit` on that clean tree exits 1 — which previously
  // killed every re-gate (git prints "nothing to commit" to stdout, so the
  // stderr-carrying error surfaced an empty detail on top). Skipping on empty
  // staging is sound because the ship-tree guard above already proved the
  // working tree holds exactly the gate-attested bytes: nothing staged means
  // HEAD already carries them.
  const staged = await runGit(projectDir, ['diff', '--cached', '--name-only']);
  if (shippable.length === 0) {
    // Re-entrancy: a successful deletions-only commit removes the deleted paths
    // from the index, the worktree, AND the new HEAD, so `shippable` empties on
    // every later re-gate even though the run already did its work. The MERGED
    // probe above only covers a provably-merged PR, so recognize the
    // already-committed case here: the ship-tree guard already proved the
    // worktree still equals the gate tree and nothing is staged, so proceed
    // idempotently to push/PR only when HEAD carries a non-empty commit relative
    // to BOTH the origin base tip AND the run's own attested start
    // (state.base_commit_sha) — a run-bound test, not a purely global one. Every
    // genuine crash-after-commit re-entry clears both conjuncts because the ship
    // commit is always non-empty; but a first-entry phantom-only set on a branch
    // that was ALREADY diverged from origin at first entry cannot look 'already
    // committed', because HEAD's tree still equals the run's start tree even
    // though it differs from the origin tip. Fail closed when either base tree is
    // unresolvable (a missing/invalid base_commit_sha never proceeds
    // idempotently), so a stage-created-then-deleted phantom never ships.
    const headTree = await runGit(projectDir, ['rev-parse', 'HEAD^{tree}']);
    const baseTree = await runGit(projectDir, ['rev-parse', `refs/remotes/origin/${base}^{tree}`]).catch(() => null);
    const runBaseTree = await runGit(projectDir, ['rev-parse', `${state.base_commit_sha}^{tree}`]).catch(() => null);
    const alreadyCommitted = staged === ''
      && baseTree !== null && headTree !== baseTree
      && runBaseTree !== null && headTree !== runBaseTree;
    if (!alreadyCommitted) {
      // Fail closed either way, but tell the two failures apart. A genuine no-op
      // (both base trees resolved, HEAD simply never advanced past them) is the
      // NO_VALIDATED case and must keep that exact message. But an UNRESOLVABLE
      // base tree — origin/<base> or the run's attested base_commit_sha rev-parsed
      // to null — is not "no validated changes": the re-entry decision itself
      // could not be evaluated, and the generic message misdiagnoses it (a low
      // finding on run-20260716000644427/#276). When nothing is staged and a base
      // tree is null, name the unresolvable side and its remedy (fetch the base
      // ref / verify the run's base commit) so the operator can act, without ever
      // implying committed or validated work exists. Single-line and bounded: the
      // message flows verbatim into block_reason surfaces.
      if (staged === '' && (baseTree === null || runBaseTree === null)) {
        const unresolved = [];
        if (baseTree === null) {
          unresolved.push(`origin base ref refs/remotes/origin/${base} (fetch the base ref so its tree resolves)`);
        }
        if (runBaseTree === null) {
          unresolved.push(`run base commit ${state.base_commit_sha} (verify the run's attested base commit exists)`);
        }
        throw new Error(`cannot verify ship re-entry: ${unresolved.join(' and ')} could not be resolved`);
      }
      throw new Error('shipping has no validated changed files');
    }
  } else if (staged !== '') {
    const subject = truncateAtWordBoundary(`feat: ${state.objective}`);
    await resolveFrozenShippingTarget(projectDir, state, config);
    await assertIndexTree(projectDir, gateTreeSha);
    await commitShippingChange(projectDir, subject);
  }
  const committedHead = await assertCommittedTree(projectDir, gateTreeSha);
  await resolveFrozenShippingTarget(projectDir, state, config);
  await assertShippingBaseCurrent(projectDir, state, target);
  // Re-pushing an already-pushed branch is a no-op success.
  const pushArgs = target.enforce
    ? ['push', target.git_remote, `${committedHead}:refs/heads/${branch}`]
    : ['push', '--set-upstream', 'origin', branch];
  await runAuthorizedGitMutation(projectDir, pushArgs, { timeout_ms: 120_000 }, target);
  const title = truncateAtWordBoundary(state.objective);
  const body = [
    `APE v2 run: ${state.run_id}`,
    '',
    `Mode: ${state.mode}`,
    `Lane: ${state.lane}`,
    `Receipts: ${state.receipts.length}`,
  ].join('\n');
  // Re-entry after a successful create reuses the OPEN PR (the push above
  // already updated its head). A CLOSED PR is not reusable — gh pr create
  // starts a fresh one for the same branch.
  let url = existing?.state === 'OPEN' ? existing.url : null;
  if (!url) {
    const created = await runAuthorizedGithub(
      projectDir,
      ['pr', 'create', '--base', base, '--head', branch, '--title', title, '--body', body],
      target,
      120_000,
    );
    if (!created.passed) throw new Error(`failed to create pull request: ${created.output.trim()}`);
    // run() interleaves stderr into output, so take the last URL-shaped line
    // rather than blindly trusting the final line.
    url = created.output.trim().split(/\r?\n/)
      .map((line) => line.trim())
      .reverse()
      .find((line) => /^https:\/\/\S+$/.test(line));
    if (!url) throw new Error(`could not determine pull request URL from gh output: ${created.output.trim()}`);
  }
  if (!shippingPrUrlMatches(url, target)) throw new Error('pull request URL does not match the frozen shipping repository');
  const watch = {
    provider: 'github', pr_url: url, branch, base, head_oid: committedHead,
    created_at: new Date().toISOString(), shipping_target: structuredClone(state.shipping_target),
  };
  if (target.required_remote_checks !== false) {
    // Non-blocking handoff (backlog: make the shipping watch resumable). The
    // synchronous in-call `gh pr checks --watch` loop is GONE: it held the
    // record/regate MCP call and the run lock for the entire 5-8 minute watch,
    // and a watcher that died mid-poll (local ephemeral-port exhaustion)
    // stranded a ship whose checks later passed. Instead capture the pushed
    // feature-branch head and hand a NON-BLOCKING watch descriptor back to the
    // caller, which persists it as state.shipping_watch and rests the run in
    // 'shipping'. The bounded poll (pollRemoteChecksAndMerge) drives the merge
    // on a later `ape_run next`. head_oid lets a later MERGED probe prove
    // idempotent completion vs. an external head drift (invariant 8); pr_url and
    // branch are the poll's PR selectors, so no poll-phase gh call ever depends
    // on the current checkout.
    return { watch };
  }
  // required_remote_checks:false — no CI to watch, so phase 1 proceeds straight
  // to the in-call merge for zero added latency (unchanged), returning the merge
  // shape (no watch key).
  await assertShippingBaseCurrent(projectDir, state, target);
  const merge = await runAuthorizedGithub(
    projectDir,
    ['pr', 'merge', url, '--squash', '--delete-branch', '--match-head-commit', committedHead],
    target,
    120_000,
  );
  if (!merge.passed) throw new Error(`squash merge failed: ${merge.output.trim()}`);
  const observed = await observeSubmittedMerge(projectDir, watch, state, target);
  if (observed.failed) throw new Error(observed.failed);
  if (observed.pending) return { watch: { ...watch, merge_request_submitted: true } };
  return observed.merged;
}

// Whitespace-flatten and bound a gh output tail or a pending summary so a wire
// response or a persisted watch cursor never carries an unbounded multi-line
// blob (≤400 chars). gh colorizes failing check rows, so first strip terminal
// escapes: ANSI/CSI sequences and any remaining non-whitespace C0 control byte
// or DEL — a failure tail reaches wire responses, the statusline, and status.md
// as readable text, never raw escapes. Whitespace controls (tab/newline/CR) are
// left for the flatten pass below to collapse into single spaces.
function boundedTail(text, max = 400) {
  const flat = String(text ?? '')
    // eslint-disable-next-line no-control-regex
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '')
    // eslint-disable-next-line no-control-regex
    .replace(/[\x00-\x08\x0e-\x1f\x7f]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

// The bounded, RESUMABLE remote-checks poll that replaces the in-call
// `gh pr checks --watch` loop. Reads the persisted state.shipping_watch, runs
// exactly ONE non-watch `gh pr checks <selector>` (selector from the watch,
// never the checkout — A1), classifies the result, and on green re-probes the
// PR BY SELECTOR and drives the runtime-owned squash merge. Bounded to seconds:
// a dead/interrupted poll is recovered by simply calling next again. Returns a
// discriminated union:
//   { merged: {...} }                 merged in-call, or observed merged externally at the pushed head
//   { pending: { summary, reason? } } still in progress; call next again
//   { failed: <tail> }                a real check failure or a refused PR state (regate recovers)
// summaries/tails are whitespace-flattened and bounded (≤400).
/**
 * @returns {Promise<{
 *   merged?: object,
 *   pending?: { summary: (string|null), reason?: string, merge_request_submitted?: boolean },
 *   failed?: string,
 * }>}
 */
export async function pollRemoteChecksAndMerge(projectDir, state, config) {
  if (config.shipping?.provider !== 'github') throw new Error('unsupported merge provider');
  assertFrozenAutoMergeAuthority(state, config);
  const target = await resolveFrozenShippingTarget(projectDir, state, config);
  const watch = state.shipping_watch;
  if (!watch) throw new Error('pollRemoteChecksAndMerge requires a persisted shipping_watch');
  if (watch.merge_request_submitted !== undefined && typeof watch.merge_request_submitted !== 'boolean') {
    throw new Error('shipping watch has an invalid merge submission marker');
  }
  if (sha256(watch.shipping_target ?? null) !== sha256(state.shipping_target) ||
      watch.base !== target.base || !shippingPrUrlMatches(watch.pr_url, target)) {
    throw new Error('shipping watch does not match the frozen shipping target');
  }
  // Every poll-phase gh call selects the PR by the persisted URL (A1) — never
  // the current checkout, which may have moved since phase 1.
  const selector = watch.pr_url;
  const checks = target.required_remote_checks === false
    ? { passed: true, exit_code: 0, output: '' }
    : await runAuthorizedGithub(
    projectDir,
    ['pr', 'checks', selector],
    target,
    120_000,
  );
  if (!checks.passed) {
    if (NO_CHECKS_PATTERN.test(checks.output)) {
      // CI registers a just-created PR's check runs asynchronously: inside the
      // registration window this is a pure timing race (pending — call next
      // again); past the window a repository with truly no CI must state that
      // intent explicitly and is failed closed (invariant 9: never auto-pass an
      // unchecked merge).
      const createdAt = Date.parse(watch.created_at ?? '');
      const withinWindow = Number.isFinite(createdAt)
        && Date.now() < createdAt + CHECKS_REGISTRATION_WINDOW_MS;
      if (withinWindow) {
        return { pending: { summary: 'no remote checks registered yet', reason: 'checks not yet registered' } };
      }
      return { failed: `no remote checks registered within ${CHECKS_REGISTRATION_WINDOW_MS / 1000}s of PR creation; inspect the admitted CI configuration; required remote checks are frozen for this run and cannot be waived by changing configuration` };
    }
    // Exit code 1 is gh's "a required check failed" verdict — the real tail
    // blocks the run (regate is the recovery). Any OTHER non-zero/absent code
    // (gh's pending exit 8, or a transient spawn fault such as the ephemeral-
    // port exhaustion this feature exists to survive) is ambiguity → pending,
    // never a false failure and never a green pass.
    if (checks.exit_code === 1) {
      return { failed: boundedTail(checks.output) || 'required remote checks failed' };
    }
    return { pending: { summary: boundedTail(checks.output) || 'remote checks in progress', reason: 'checks running' } };
  }
  if (watch.merge_request_submitted === true) {
    return observeSubmittedMerge(projectDir, watch, state, target);
  }
  // Checks are green: re-probe the PR BY SELECTOR (A1) and let its state decide.
  const probe = await runAuthorizedGithub(projectDir, [
    'pr', 'view', selector,
    '--json', 'url,state,mergedAt,headRefOid',
    '--jq', '[.state, .url, (.mergedAt // "-"), .headRefOid] | join(" ")',
  ], target, 120_000);
  const pr = probe.passed ? parsePrProbe(probe.output) : null;
  if (pr && !shippingPrUrlMatches(pr.url, target)) return { failed: 'pull request URL does not match the frozen shipping repository' };
  if (!pr) {
    // Green checks but an unreadable PR state: never merge blind (invariant 8).
    return { pending: { summary: 'remote checks passed; PR state not yet readable', reason: 'pr probe unreadable' } };
  }
  if (pr.state === 'MERGED') {
    // Idempotent completion ONLY when the merged head is EXACTLY the head phase
    // 1 pushed (A2): a merge that landed out-of-band at our pushed commit
    // between poll slices completes this run truthfully, marked as
    // probe-observed rather than runtime-performed. A drifted merged head is
    // someone else's merge over unrelated commits and must never complete this
    // run as its own (invariant 8) — it blocks as an external-merge/head-drift.
    if (pr.head_oid === watch.head_oid) {
      try {
        await assertMergedTreeAttested(projectDir, state, watch.base, target);
      } catch (error) {
        return { failed: boundedTail(error?.message ?? String(error)) };
      }
      await finalizeAfterMerge(projectDir, watch.branch, watch.base, target);
      return {
        merged: {
          provider: 'github',
          url: pr.url ?? watch.pr_url,
          branch: watch.branch,
          base: watch.base,
          merged_at: pr.merged_at ?? new Date().toISOString(),
          provenance: 'observed-external',
        },
      };
    }
    return { failed: `pull request ${watch.pr_url} was merged at a drifted head (${pr.head_oid}), not the pushed commit ${watch.head_oid}; refusing to complete this run on an external merge (invariant 8)` };
  }
  if (pr.state === 'CLOSED') {
    return { failed: `pull request ${watch.pr_url} was closed without merging; shipping cannot complete — recover with regate or start a new run` };
  }
  if (pr.head_oid !== watch.head_oid) {
    // OPEN but the remote head drifted from the pushed commit: an external push
    // landed un-attested bytes on the branch, so merging would ship what no gate
    // or receipt attested (invariant 8) — fail closed.
    return { failed: `pull request ${watch.pr_url} head drifted from the pushed commit (${pr.head_oid} vs ${watch.head_oid}); refusing to merge un-attested changes — start a fresh run` };
  }
  // OPEN at the pushed head with green checks: the runtime-owned squash merge by
  // selector (A1), then idempotent local cleanup against the persisted base.
  try {
    await assertShippingBaseCurrent(projectDir, state, target);
  } catch (error) {
    return { failed: boundedTail(error?.message ?? String(error)) };
  }
  const merge = await runAuthorizedGithub(
    projectDir,
    ['pr', 'merge', selector, '--squash', '--delete-branch', '--match-head-commit', watch.head_oid],
    target,
    120_000,
  );
  if (!merge.passed) {
    const reconciled = await reconcileMergedAfterCommandFailure(projectDir, selector, watch, state, target);
    if (reconciled) return reconciled;
    if (!AUTO_MERGE_REQUIRED_PATTERN.test(merge.output)) {
      return { failed: boundedTail(merge.output) || 'squash merge failed' };
    }
    // A protected base can reject even a currently-green immediate merge and
    // require GitHub's merge queue/auto-merge path. Enabling it is not proof of
    // completion: persist the watch and let the next bounded poll observe the
    // MERGED state at the exact pushed head before cleaning up locally.
    try {
      await assertQueuedShippingProtection(projectDir, target);
      await assertShippingBaseCurrent(projectDir, state, target);
    } catch (error) {
      return { failed: boundedTail(error?.message ?? String(error)) };
    }
    const auto = await runAuthorizedGithub(
      projectDir,
      ['pr', 'merge', selector, '--squash', '--delete-branch', '--auto', '--match-head-commit', watch.head_oid],
      target,
      120_000,
    );
    if (!auto.passed) {
      const reconciledAuto = await reconcileMergedAfterCommandFailure(
        projectDir,
        selector,
        watch,
        state,
        target,
      );
      if (reconciledAuto) return reconciledAuto;
      return { failed: boundedTail(auto.output) || 'enabling auto-merge failed' };
    }
    return observeSubmittedMerge(projectDir, watch, state, target, 'awaiting auto-merge');
  }
  return observeSubmittedMerge(projectDir, watch, state, target);
}
