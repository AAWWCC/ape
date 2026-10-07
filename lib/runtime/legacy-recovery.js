import path from 'node:path';
import { lstat, mkdtemp, readdir, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { sha256 } from './canonical.js';
import { boundedGateSummary } from './bounded-summary.js';
import { readBoundedJson } from './bounded-file.js';
import { validateGovernedRuntimeAncestor } from './paths.js';
import { isCanonicalRunId } from './diagnostics.js';
import { currentBranch, currentCommitSha, currentTreeSha, runGit, workingTreeStatus } from './git.js';
import { checkpointStartInput, publishWorkCheckpoint } from './work-checkpoints.js';
import { RunStartInputSchema } from './schemas.js';

const MAX_SCAN = 256;
const MAX_LIST = 16;
const candidate = (value) => ({ ...value, legacy_candidate_id: `legacy-${sha256(value).slice(0, 32)}` });

async function savedRuns(paths) {
  await validateGovernedRuntimeAncestor(paths);
  const entry = await lstat(paths.runs).catch((error) => { if (error.code === 'ENOENT') return null; throw error; });
  if (!entry) return { runs: [], unavailable: 0, truncated: false };
  if (!entry.isDirectory() || entry.isSymbolicLink() || await realpath(paths.runs) !== path.join(await realpath(paths.runtime), 'runs')) {
    throw new Error('saved run directory is unsafe');
  }
  const files = (await readdir(paths.runs)).filter((name) => name.endsWith('.json') && isCanonicalRunId(name.slice(0, -5))).sort();
  const runs = [];
  let unavailable = 0;
  for (const file of files.slice(0, MAX_SCAN)) {
    try {
      const state = await readBoundedJson(path.join(paths.runs, file), 4 * 1024 * 1024);
      if (state.run_id !== file.slice(0, -5)) throw new Error('saved run identity mismatch');
      if (['blocked', 'aborted'].includes(state.status)) runs.push(state);
    } catch { unavailable += 1; }
  }
  return { runs, unavailable, truncated: files.length > MAX_SCAN };
}

// Inventory only. Names and stash messages are labels, never task association
// or permission to apply a stash. Only the live reflog is consulted.
export async function discoverLegacyRecovery(paths, { preservedSources = [], selectedId = null } = {}) {
  try {
    const inside = await runGit(paths.root, ['rev-parse', '--is-inside-work-tree']).catch(() => null);
    if (inside !== 'true') return { count: 0, candidates: [], tasks: [], unavailable: 0, truncated: false };
    const { runs, unavailable, truncated } = await savedRuns(paths);
    const candidates = [];
    const branch = await currentBranch(paths.root);
    const dirt = (await workingTreeStatus(paths.root)).filter((line) => line.slice(3) !== '.ape' && !line.slice(3).startsWith('.ape/'));
    if (dirt.length) candidates.push(candidate({ kind: 'worktree', source: branch, head: await currentCommitSha(paths.root),
      tree: await currentTreeSha(paths.root), index: await runGit(paths.root, ['write-tree']) }));
    const branches = (await runGit(paths.root, ['for-each-ref', '--format=%(refname:short)%00%(objectname)%00%(committerdate:iso-strict)', 'refs/heads/'])).split('\n').filter(Boolean);
    for (const line of branches.slice(0, MAX_SCAN)) {
      const [name, head, date] = line.split('\0');
      if (!name.startsWith('ape/') && !runs.some((run) => run.branch === name)) continue;
      if (dirt.length && name === branch) continue;
      candidates.push(candidate({ kind: 'branch', source: name, head, date }));
    }
    const stashes = (await runGit(paths.root, ['stash', 'list', '--format=%H%x00%gd%x00%cI%x00%gs'])).split('\n').filter(Boolean);
    for (const line of stashes.slice(0, MAX_SCAN)) {
      const [head, source, date, label] = line.split('\0');
      candidates.push(candidate({ kind: 'stash', source, head, date, label: boundedGateSummary(label, 160) }));
    }
    const summaries = runs.map((run) => ({ run_id: run.run_id, objective: boundedGateSummary(run.objective, 256),
      branch: boundedGateSummary(run.branch, 256), date: run.terminal_at ?? run.updated_at ?? run.created_at,
      blocker: boundedGateSummary(run.block_reason ?? run.abort_reason ?? '', 256) }));
    const available = candidates.filter((entry) => !preservedSources.some((source) =>
      source.legacy?.legacy_candidate_id === entry.legacy_candidate_id ||
      (entry.kind !== 'stash' && source.branch === entry.source && (source.prepared ||
        (source.head === entry.head && (entry.kind === 'branch' || (source.tree === entry.tree && source.index === entry.index)))))));
    const listed = selectedId ? available.filter((entry) => entry.legacy_candidate_id === selectedId) : available.slice(0, MAX_LIST);
    return { count: available.length, candidates: listed.map((entry) => ({ ...entry,
      suggested_run_ids: summaries.filter((run) => run.branch === entry.source).map((run) => run.run_id).slice(0, MAX_LIST) })),
    tasks: summaries.slice(-MAX_LIST), unavailable,
    truncated: truncated || branches.length > MAX_SCAN || stashes.length > MAX_SCAN || available.length > MAX_LIST || summaries.length > MAX_LIST };
  } catch { return { count: 0, candidates: [], tasks: [], unavailable: 1, truncated: false }; }
}

export async function selectLegacyRecovery(paths, inventory, options) {
  const selected = inventory.candidates.find((entry) => entry.legacy_candidate_id === options.legacy_candidate_id);
  if (!selected) throw new Error('legacy candidate is unavailable or changed; rediscover and select the exact source');
  if (options.legacy_run_id && options.recovery_context) throw new Error('select a saved task or supply recovery_context, not both');
  let sourceRun = null;
  if (options.legacy_run_id) {
    const { runs } = await savedRuns(paths);
    sourceRun = runs.find((entry) => entry.run_id === options.legacy_run_id);
    if (!sourceRun) throw new Error('selected saved task is unavailable; supply its objective and scope as recovery_context');
  }
  const context = sourceRun ? checkpointStartInput(sourceRun) : options.recovery_context;
  if (!context || typeof context.objective !== 'string' || !context.objective.trim() ||
      !Array.isArray(context.claimed_paths) || !context.claimed_paths.length || !Array.isArray(context.test_paths) ||
      !context.host || !context.mode || !context.lane) {
    return { selected, sourceRun, startInput: null };
  }
  const parsed = RunStartInputSchema.parse({ ...context, hooks_trusted: true, subagents_available: true, explicit_invocation: true });
  return { selected, sourceRun, startInput: checkpointStartInput(parsed) };
}

export async function importLegacyCheckpoint(paths, selection) {
  const { selected, sourceRun, startInput } = selection;
  if (!startInput) throw new Error('legacy task objective and scope must be confirmed before import');
  let head = selected.head;
  let tree = selected.tree ?? await runGit(paths.root, ['rev-parse', `${head}^{tree}`]);
  let index = selected.index ?? tree;
  if (selected.kind === 'stash') {
    head = await runGit(paths.root, ['rev-parse', `${selected.head}^1`]);
    index = await runGit(paths.root, ['rev-parse', `${selected.head}^2^{tree}`]);
    const untracked = await runGit(paths.root, ['rev-parse', '--verify', `${selected.head}^3^{tree}`]).catch(() => null);
    if (untracked) {
      const scratch = await mkdtemp(path.join(tmpdir(), 'ape-legacy-index-'));
      const env = { ...process.env, GIT_INDEX_FILE: path.join(scratch, 'index') };
      try {
        await runGit(paths.root, ['read-tree', tree], { env });
        await runGit(paths.root, ['read-tree', '--prefix=', untracked], { env });
        tree = await runGit(paths.root, ['write-tree'], { env });
      } finally { await rm(scratch, { recursive: true, force: true }); }
    }
  }
  return publishWorkCheckpoint(paths, {
    version: 2, source_run_id: sourceRun?.run_id ?? null, source_status: 'legacy',
    provenance: { kind: 'legacy', association: 'user-confirmed', source: selected, run_id: sourceRun?.run_id ?? null },
    parent_checkpoint_id: sourceRun?.checkpoint_id ?? null,
    owned_branch: selected.kind !== 'stash' && sourceRun?.branch === selected.source && selected.source.startsWith('ape/') ? selected.source : null,
    source_branch: selected.kind === 'stash' ? null : selected.source, source_head: head,
    source_base: sourceRun?.base_commit_sha ?? head, tree_sha: tree, index_tree_sha: index,
    failure_reason: boundedGateSummary(sourceRun?.block_reason ?? sourceRun?.abort_reason ?? 'Legacy work; inspect the selected source and confirm remaining work.', 1024),
    terminal_reason_code: sourceRun?.terminal_reason_code ?? null, start_input: startInput,
  });
}
