import path from 'node:path';
import { lstat, readdir, realpath } from 'node:fs/promises';
import { sha256 } from './canonical.js';
import { boundedGateSummary } from './bounded-summary.js';
import { readBoundedJson } from './bounded-file.js';
import { ensureDir, publishImmutableJson } from './storage.js';
import { validateGovernedRuntimeAncestor } from './paths.js';
import { currentBranch, currentCommitSha, currentTreeSha, diffFiles, resolveBaseBranch, runGit, workingTreeStatus } from './git.js';
import { isCanonicalRunId } from './diagnostics.js';
import { withinClaims } from './path-scope.js';

export const CHECKPOINT_ID = /^checkpoint-[0-9a-f]{32}$/;
const OID = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;
const MAX_BYTES = 128 * 1024;
const MAX_LIST = 8;
const MAX_SCAN = 256;
const userFile = (file) => file !== '.ape' && !file.startsWith('.ape/');
const manifestPath = (paths, id) => path.join(paths.checkpoints, `${id}.json`);
const refName = (id) => `refs/ape/checkpoints/${id}`;

function requireId(id) {
  if (typeof id !== 'string' || !CHECKPOINT_ID.test(id)) throw new Error('invalid recovery checkpoint_id');
}

async function directory(paths, create = false) {
  await validateGovernedRuntimeAncestor(paths);
  const entry = await lstat(paths.checkpoints).catch((error) => {
    if (error.code === 'ENOENT') return null;
    throw error;
  });
  if (entry && (!entry.isDirectory() || entry.isSymbolicLink() ||
      await realpath(paths.checkpoints) !== path.join(await realpath(paths.runtime), 'checkpoints'))) {
    throw new Error('checkpoint directory is unsafe; preserved work was not changed');
  }
  if (!entry && create) await ensureDir(paths.checkpoints);
  return Boolean(entry) || create;
}

async function readFile(paths, file) {
  if (!await directory(paths)) return null;
  return readBoundedJson(file, MAX_BYTES, null);
}

async function publish(paths, file, record) {
  await directory(paths, true);
  if (Buffer.byteLength(JSON.stringify(record)) > MAX_BYTES) throw new Error('checkpoint metadata exceeds its storage limit');
  if (!await publishImmutableJson(file, record)) {
    const prior = await readFile(paths, file);
    if (sha256(prior) !== sha256(record)) throw new Error('checkpoint metadata changed; preserved work was not changed');
  }
}

async function refOid(root, ref) {
  return runGit(root, ['show-ref', '--verify', '--hash', ref]).catch(() => null);
}

// Internal refs keep snapshots reachable through Git GC. They are never moved,
// never pushed by APE, and do not change HEAD, the real index, or working files.
async function pin(root, ref, oid) {
  const existing = await refOid(root, ref);
  if (existing) {
    if (existing !== oid) throw new Error('checkpoint Git ref changed; refusing to replace it');
    return;
  }
  await runGit(root, ['update-ref', ref, oid, '0'.repeat(oid.length)]);
}

export async function saveWorkCheckpoint(paths, state) {
  if (!['blocked', 'aborted'].includes(state.status)) return null;
  if (!isCanonicalRunId(state.run_id)) throw new Error('checkpoint requires a valid source run');
  await directory(paths, true);
  // Abort cleanup can return to main before a later reset. Reuse the saved
  // run checkout instead of replacing its unfinished work with main's tree.
  if (state.work_checkpoint_id && state.branch && await currentBranch(paths.root) !== state.branch) {
    const prior = await readWorkCheckpoint(paths, state.work_checkpoint_id);
    if (prior.source_run_id !== state.run_id) throw new Error('saved checkpoint does not belong to the stopped run');
    return prior;
  }
  const head = await currentCommitSha(paths.root);
  const tree = await currentTreeSha(paths.root);
  const index = await runGit(paths.root, ['write-tree']);
  if (await runGit(paths.root, ['ls-tree', '-r', '--name-only', tree, '--', '.ape'])) {
    throw new Error('checkpoint refuses tracked APE runtime metadata; active run and files remain preserved');
  }
  const startInput = {
    objective: state.objective,
    mode: state.mode,
    lane: state.requested_lane ?? state.lane,
    host: state.host,
    behavioral: state.behavioral ?? true,
    test_intent: state.test_intent ?? 'red-first',
    claimed_paths: state.claimed_paths ?? [],
    test_paths: state.test_paths ?? [],
    requirements: state.requirements ?? [],
    completes: state.completes ?? [],
    risk_triggers: state.risk_triggers ?? [],
  };
  const contents = {
    version: 1, source_run_id: state.run_id, source_status: state.status,
    source_branch: await currentBranch(paths.root), source_head: head,
    source_base: state.base_commit_sha ?? head,
    tree_sha: tree, index_tree_sha: index,
    // Failure prose is evidence to inspect, never a recovery instruction.
    failure_reason: boundedGateSummary(state.block_reason ?? state.abort_reason ?? '', 1024),
    terminal_reason_code: state.terminal_reason_code ?? null,
    start_input: startInput,
  };
  const id = `checkpoint-${sha256(contents).slice(0, 32)}`;
  const existing = await readFile(paths, manifestPath(paths, id));
  if (existing) return readWorkCheckpoint(paths, id);
  const ref = refName(id);
  let commit = await refOid(paths.root, ref);
  if (!commit) {
    commit = await runGit(paths.root, ['-c', 'user.name=APE Recovery', '-c', 'user.email=ape-recovery@localhost',
      'commit-tree', tree, '-p', head, '-m', `APE work checkpoint ${id}`]);
    await pin(paths.root, ref, commit);
  }
  await pin(paths.root, `${ref}-index`, index);
  const record = { ...contents, checkpoint_id: id, created_at: new Date().toISOString(), snapshot_commit: commit, git_ref: ref };
  await publish(paths, manifestPath(paths, id), { ...record, record_hash: sha256(record) });
  return readWorkCheckpoint(paths, id);
}

export async function readWorkCheckpoint(paths, id, { refs = null } = {}) {
  requireId(id);
  const record = await readFile(paths, manifestPath(paths, id));
  if (!record) throw new Error('recovery checkpoint was not found in this project');
  const { record_hash: hash, ...contents } = record;
  const { checkpoint_id: _id, created_at: _created, snapshot_commit: _commit, git_ref: _ref, ...definition } = contents;
  if (hash !== sha256(contents) || record.version !== 1 || record.checkpoint_id !== id ||
      `checkpoint-${sha256(definition).slice(0, 32)}` !== id ||
      typeof record.created_at !== 'string' || !Number.isFinite(Date.parse(record.created_at)) || record.created_at.length > 32 ||
      !isCanonicalRunId(record.source_run_id) || record.git_ref !== refName(id) ||
      ![record.source_head, record.source_base, record.tree_sha, record.index_tree_sha, record.snapshot_commit].every((value) => typeof value === 'string' && OID.test(value))) {
    throw new Error('recovery checkpoint metadata is invalid');
  }
  const snapshotRef = refs ? refs.get(record.git_ref) : await refOid(paths.root, record.git_ref);
  const indexRef = refs ? refs.get(`${record.git_ref}-index`) : await refOid(paths.root, `${record.git_ref}-index`);
  if (snapshotRef !== record.snapshot_commit || indexRef !== record.index_tree_sha ||
      (!refs && (await runGit(paths.root, ['rev-parse', `${record.snapshot_commit}^{tree}`]) !== record.tree_sha ||
        await runGit(paths.root, ['rev-parse', `${record.snapshot_commit}^`]) !== record.source_head))) {
    throw new Error('recovery checkpoint Git objects are missing or changed');
  }
  return record;
}

export function checkpointSummary(record) {
  return {
    checkpoint_id: record.checkpoint_id, source_run_id: record.source_run_id,
    created_at: record.created_at, git_ref: record.git_ref,
    source_branch: boundedGateSummary(record.source_branch, 256),
    objective: boundedGateSummary(record.start_input?.objective ?? '', 512),
    failure_reason: boundedGateSummary(record.failure_reason, 512),
  };
}

async function continued(paths, id) {
  const record = await readFile(paths, path.join(paths.checkpoints, `${id}.continued.json`));
  if (record && (record.checkpoint_id !== id || !isCanonicalRunId(record.run_id))) throw new Error('checkpoint continuation record is invalid');
  return record;
}

export async function discoverWorkCheckpoints(paths) {
  try {
    if (!await directory(paths)) return { count: 0, checkpoints: [], unavailable: 0, truncated: false };
    const files = (await readdir(paths.checkpoints)).filter((name) => CHECKPOINT_ID.test(name.slice(0, -5)) && name.endsWith('.json')).sort();
    // Status is read-only and cheap: batch ref inspection, and validate full
    // object provenance only when a checkpoint is selected for restoration.
    const refs = new Map((await runGit(paths.root, ['for-each-ref', '--format=%(refname) %(objectname)', 'refs/ape/checkpoints/']))
      .split('\n').filter(Boolean).map((line) => { const [ref, oid] = line.split(' '); return [ref, oid]; }));
    const records = [];
    const adopted = new Set();
    let unavailable = 0;
    for (const file of files.slice(0, MAX_SCAN)) {
      try {
        const id = file.slice(0, -5);
        const record = await readWorkCheckpoint(paths, id, { refs });
        if (await continued(paths, id)) adopted.add(record.source_run_id);
        records.push(record);
      } catch { unavailable += 1; }
    }
    records.sort((a, b) => b.created_at.localeCompare(a.created_at) || b.checkpoint_id.localeCompare(a.checkpoint_id));
    // A later snapshot of the same stopped run supersedes its earlier files.
    const latest = [...new Map([...records].reverse().filter((record) => !adopted.has(record.source_run_id)).map((record) => [record.source_run_id, record])).values()].reverse();
    return { count: latest.length, checkpoints: latest.slice(0, MAX_LIST).map(checkpointSummary), unavailable, truncated: files.length > MAX_SCAN || latest.length > MAX_LIST };
  } catch {
    return { count: 0, checkpoints: [], unavailable: 1, truncated: false };
  }
}

export async function checkpointResumeOptions(paths) {
  const recovery = await discoverWorkCheckpoints(paths);
  if (recovery.count === 0 && recovery.unavailable === 0 && !recovery.truncated) return { ok: false, reason: 'no active run' };
  return {
    ok: true, active: false, run: null, recovery,
    next_action: recovery.count === 1 && recovery.unavailable === 0 && !recovery.truncated
      ? { kind: 'recover_checkpoint', checkpoint_id: recovery.checkpoints[0].checkpoint_id }
      : { kind: 'choose_checkpoint' },
    reason: recovery.count ? 'No active run; unfinished work is available in recovery checkpoints.' : 'Recovery checkpoint storage needs inspection; no files were changed.',
  };
}

const preparedPath = (paths, id, base) => path.join(paths.checkpoints, `${id}.${base}.prepared.json`);

async function readPrepared(paths, record, base) {
  const prepared = await readFile(paths, preparedPath(paths, record.checkpoint_id, base));
  if (!prepared) return null;
  const { record_hash: hash, ...contents } = prepared;
  if (hash !== sha256(contents) || prepared.checkpoint_id !== record.checkpoint_id ||
      prepared.source_record_hash !== record.record_hash || prepared.base_commit !== base ||
      !OID.test(prepared.commit) || !OID.test(prepared.tree_sha) ||
      prepared.branch !== `ape/recover-${record.checkpoint_id.slice(-16)}-${base.slice(0, 8)}` ||
      await runGit(paths.root, ['rev-parse', `${prepared.commit}^{tree}`]) !== prepared.tree_sha ||
      await runGit(paths.root, ['rev-parse', `${prepared.commit}^`]) !== base ||
      await refOid(paths.root, `${record.git_ref}-prepared-${base}`) !== prepared.commit) {
    throw new Error('prepared recovery checkpoint is invalid');
  }
  return prepared;
}

export async function restoreWorkCheckpoint(paths, id) {
  const record = await readWorkCheckpoint(paths, id);
  if (await continued(paths, id)) throw new Error('checkpoint already continued in a fresh run; inspect APE status or history');
  const base = await resolveBaseBranch(paths.root);
  const baseCommit = await runGit(paths.root, ['rev-parse', base.start_point]);
  let prepared = await readPrepared(paths, record, baseCommit);
  const head = await currentCommitSha(paths.root);
  const tree = await currentTreeSha(paths.root);
  const branch = await currentBranch(paths.root);
  let keepCurrentTip = false;
  if (branch.startsWith(`ape/recover-${id.slice(-16)}-`)) {
    const preparedHeads = (await runGit(paths.root, ['for-each-ref', '--format=%(objectname)', `${record.git_ref}-prepared-*`])).split('\n');
    if (!preparedHeads.includes(head)) {
      keepCurrentTip = Boolean(prepared && branch === prepared.branch &&
        await runGit(paths.root, ['merge-base', '--is-ancestor', prepared.commit, head]).then(() => true, () => false));
      if (!keepCurrentTip) return { ok: false, code: 'recovery-branch-changed',
        reason: 'This recovery branch contains newer commits. Preserve and review those changes before selecting an older checkpoint; the checkout was not changed.' };
    }
  }
  const dirt = (await workingTreeStatus(paths.root)).map((line) => line.slice(3)).filter(userFile);
  if (dirt.length && tree !== record.tree_sha) {
    return { ok: false, code: 'recovery-worktree-changed', reason: 'Newer working files differ from the checkpoint. Preserve or commit them before recovery; nothing was overwritten.', recovery: checkpointSummary(record) };
  }
  if (await runGit(paths.root, ['ls-files', '--', '.ape'])) throw new Error('recovery refuses tracked APE runtime metadata');
  const originalIndex = await runGit(paths.root, ['write-tree']);
  if (!prepared) {
    let mergedTree;
    try {
      mergedTree = (await runGit(paths.root, ['merge-tree', '--write-tree', baseCommit, record.snapshot_commit])).split('\n')[0];
      if (!OID.test(mergedTree)) throw new Error('invalid merge tree');
    } catch {
      return { ok: false, code: 'recovery-base-conflict', reason: 'The checkpoint could not be merged with the current default branch. Inspect and resolve the conflict before retrying; the checkpoint and working files are unchanged.', recovery: checkpointSummary(record) };
    }
    // A response/process loss after pinning must reuse that exact commit.
    const commit = await refOid(paths.root, `${record.git_ref}-prepared-${baseCommit}`) ??
      await runGit(paths.root, ['commit-tree', mergedTree, '-p', baseCommit, '-m', `Recover unfinished APE work from ${record.source_run_id}`]);
    if (await runGit(paths.root, ['rev-parse', `${commit}^{tree}`]) !== mergedTree ||
        await runGit(paths.root, ['rev-parse', `${commit}^`]) !== baseCommit) throw new Error('prepared checkpoint ref changed; no files were restored');
    await pin(paths.root, `${record.git_ref}-prepared-${baseCommit}`, commit);
    const contents = { checkpoint_id: id, source_record_hash: record.record_hash, base_commit: baseCommit,
      commit, tree_sha: mergedTree, branch: `ape/recover-${id.slice(-16)}-${baseCommit.slice(0, 8)}` };
    prepared = { ...contents, record_hash: sha256(contents) };
    await publish(paths, preparedPath(paths, id, baseCommit), prepared);
  }
  if (!keepCurrentTip && (head !== prepared.commit || branch !== prepared.branch)) {
    if (await refOid(paths.root, `refs/heads/${prepared.branch}`)) {
      if (await refOid(paths.root, `refs/heads/${prepared.branch}`) !== prepared.commit) throw new Error('recovery branch has newer commits; it was not replaced');
    }
    // Recheck immediately before mutation. External editors are not governed by
    // the receipt lock; any observed drift leaves their newer work in place.
    if (await currentCommitSha(paths.root) !== head || await currentTreeSha(paths.root) !== tree ||
        await runGit(paths.root, ['write-tree']) !== originalIndex) throw new Error('working files changed during recovery; retry after writes stop');
    if (dirt.length) {
      // Every byte already matches the pinned snapshot. Staging that same tree
      // lets Git adopt untracked files without force-checkout or deleting them.
      // Save the exact previous index too, including staging-only differences.
      await pin(paths.root, `${record.git_ref}-restore-index-${originalIndex}`, originalIndex);
      await runGit(paths.root, ['read-tree', record.tree_sha]);
      try {
        await runGit(paths.root, ['switch', '--detach', record.snapshot_commit, '--no-overwrite-ignore']);
      } catch (error) {
        await runGit(paths.root, ['read-tree', originalIndex]);
        throw error;
      }
    }
    const exists = await refOid(paths.root, `refs/heads/${prepared.branch}`);
    await runGit(paths.root, ['switch', ...(exists ? [] : ['-c']), prepared.branch,
      ...(exists ? [] : [prepared.commit, '--no-track']), '--no-overwrite-ignore']);
  }
  // Scope approval belongs to the fresh preview. A backup includes all saved
  // files, including work outside the old claim; restoration must still return
  // task context so the caller can review that scope without guessing it.
  if (await currentCommitSha(paths.root) !== (keepCurrentTip ? head : prepared.commit) ||
      (await workingTreeStatus(paths.root)).some((line) => userFile(line.slice(3)))) {
    throw new Error('restored checkout changed; inspect current files before preview');
  }
  return {
    ok: true, active: false, run: null, recovered: 'work-checkpoint',
    recovery: { ...checkpointSummary(record), branch: prepared.branch, base_commit: baseCommit,
      manifest_ref: `.ape/runtime/checkpoints/${id}.json` },
    start_input: { ...record.start_input, checkpoint_id: id, supersedes_run: record.source_run_id },
    next_action: { kind: 'start_recovered_work', checkpoint_id: id },
    reason: 'Saved work is restored on a new branch. Inspect the original failure, then review a fresh preview and complete normal start prerequisites. No prior worker or test evidence is reused.',
  };
}

export async function validateCheckpointStart(paths, input) {
  if (!input.checkpoint_id) return null;
  const record = await readWorkCheckpoint(paths, input.checkpoint_id);
  if (await continued(paths, input.checkpoint_id)) throw new Error('checkpoint already continued in another run');
  if (input.supersedes_run !== record.source_run_id) throw new Error('checkpoint start must name its source run in supersedes_run');
  const base = await resolveBaseBranch(paths.root);
  const baseCommit = await runGit(paths.root, ['rev-parse', base.start_point]);
  const prepared = await readPrepared(paths, record, baseCommit);
  const head = await currentCommitSha(paths.root);
  if (!prepared ||
      !await runGit(paths.root, ['merge-base', '--is-ancestor', prepared.commit, head]).then(() => true, () => false) ||
      await currentBranch(paths.root) !== prepared.branch ||
      (await workingTreeStatus(paths.root)).some((line) => userFile(line.slice(3)))) {
    throw new Error('checkpoint checkout or default branch changed; call resume with checkpoint_id again before preview');
  }
  const baseTree = await runGit(paths.root, ['rev-parse', `${baseCommit}^{tree}`]);
  const headTree = await runGit(paths.root, ['rev-parse', `${head}^{tree}`]);
  const changed = await diffFiles(paths.root, baseTree, headTree);
  if (changed.some((file) => !withinClaims(file, [...input.claimed_paths, ...input.test_paths]))) {
    throw new Error('recovered changes exceed the fresh run scope; review claimed_paths and test_paths before preview');
  }
  return { checkpoint_id: record.checkpoint_id, source_run_id: record.source_run_id,
    commit: head, base_commit: baseCommit, base_tree_sha: baseTree,
    head_tree_sha: headTree, changed_files: changed };
}

export async function markCheckpointContinued(paths, state) {
  if (!state.checkpoint_id) return;
  requireId(state.checkpoint_id);
  await publish(paths, path.join(paths.checkpoints, `${state.checkpoint_id}.continued.json`), {
    checkpoint_id: state.checkpoint_id, run_id: state.run_id,
  });
}

export async function retireCompletedCheckpoint(paths, state) {
  if (state.status !== 'completed' || !state.work_checkpoint_id) return;
  const record = await readWorkCheckpoint(paths, state.work_checkpoint_id);
  if (record.source_run_id !== state.run_id) throw new Error('completed checkpoint does not belong to this run');
  await markCheckpointContinued(paths, { checkpoint_id: state.work_checkpoint_id, run_id: state.run_id });
}
