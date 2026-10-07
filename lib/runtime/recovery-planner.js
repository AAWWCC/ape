import { sha256 } from './canonical.js';
import { AUTO_MERGE_HOLD_REASON, SEALED_STATUSES } from './constants.js';
import { boundedGateSummary } from './bounded-summary.js';
import { currentBranch, currentCommitSha, currentTreeSha, resolveBaseBranch, runGit } from './git.js';
import { loadRuntimeConfig } from './config.js';
import { dispatchIntentStatuses } from './claude-dispatch.js';
import { gateProducersComplete, inspectGateOwnership } from './gate-launch-ownership.js';
import { pipelineLimits } from './pipeline-limits.js';
import { validatedAdmittedStartIdentity } from './admitted-start-identity.js';
import { discoverWorkCheckpoints, readWorkCheckpoint } from './work-checkpoints.js';
import { discoverLegacyRecovery, selectLegacyRecovery } from './legacy-recovery.js';

export async function recoveryObservation(paths, sourceBranch = null) {
  const base = await resolveBaseBranch(paths.root);
  let source;
  if (sourceBranch) {
    await runGit(paths.root, ['check-ref-format', `refs/heads/${sourceBranch}`]);
    source = { branch: sourceBranch, head: await runGit(paths.root, ['rev-parse', '--verify', `refs/heads/${sourceBranch}`]),
      tree: await runGit(paths.root, ['rev-parse', '--verify', `refs/heads/${sourceBranch}^{tree}`]) };
  }
  return { branch: await currentBranch(paths.root), head: await currentCommitSha(paths.root),
    tree: await currentTreeSha(paths.root), index: await runGit(paths.root, ['write-tree']),
    ...(source ? { source } : {}),
    base: { branch: base.branch, head: await runGit(paths.root, ['rev-parse', base.start_point]) },
    config: sha256(await loadRuntimeConfig(paths.config)) };
}

// Include receipted/expired tickets: admission or expiry alone does not prove
// a native process stopped. Holding the dispatch lock during confirmation
// prevents a prepared launch from binding between this check and retirement.
export async function recoveryOwners(paths, state) {
  const dispatches = await dispatchIntentStatuses(paths, { ...state, receipts: [], expired_tickets: [] }, { tolerateCorrupt: true });
  const workers = dispatches.filter((item) => {
    if (item.agent_state === 'observed-stopped') return false;
    if (['prepared', 'expired'].includes(item.status) && item.launch_attempts === 0 && !item.launched_at && !item.bound_at) return false;
    return true;
  });
  const gate = await inspectGateOwnership(paths.root, paths, state, state.gates_watch ?? null);
  const gateSafe = gate.retired || gate.unstarted || gateProducersComplete(gate.proof) || (gate.absent && !state.gates_watch);
  return { clear: workers.length === 0 && Boolean(gateSafe),
    unresolved_worker_count: workers.length,
    workers: workers.slice(0, 16).map((item) => ({ ticket_id: item.ticket_id, status: item.status, agent_state: item.agent_state })),
    gate: { safe: Boolean(gateSafe), generation: gate.record?.generation ?? null,
      phase: gate.record?.phase ?? null, cleanup: gate.proof?.cleanup?.status ?? null,
      producers_complete: gateProducersComplete(gate.proof) } };
}

/** @param {string} kind @param {string} reason @param {Record<string, any>} fields
 * @returns {Record<string, any>} */
function plan(kind, reason, fields = {}) {
  return { version: 1, kind, reason, automatic_successor: false, ...fields };
}

export function recoveryNextAction(recovery) {
  if (!recovery) return null;
  if (recovery.kind === 'continue_run') return null;
  if (['hold', 'wait_for_owners'].includes(recovery.kind)) return { kind: 'blocked', automatic_successor: false };
  if (['replace_run', 'regate', 'reconcile_shipping', 'adopt_legacy'].includes(recovery.kind)) return { kind: 'confirm_recovery' };
  if (recovery.kind === 'recover_checkpoint') return { kind: 'recover_checkpoint', checkpoint_id: recovery.checkpoints[0].checkpoint_id };
  if (recovery.kind === 'choose_work') return { kind: recovery.legacy?.count ? 'choose_recovery' : 'choose_checkpoint' };
  if (recovery.kind === 'legacy_context') return { kind: 'provide_recovery_context' };
  return { kind: 'inspect_recovery' };
}

// The same read-only decision is consumed by resume, status and SessionStart.
// The digest is optimistic concurrency control, not authentication of a human.
export async function planTaskRecovery(paths, state, options = {}) {
  if (state && !SEALED_STATUSES.has(state.status)) {
    if (state.status !== 'blocked') return plan('continue_run', 'Continue the existing execution and its workers.', { source_run_id: state.run_id });
    const context = { source_run_id: state.run_id, objective: boundedGateSummary(state.objective, 512),
      blocker: boundedGateSummary(state.block_reason ?? '', 512) };
    if (state.stage === 'merge' && state.block_reason === AUTO_MERGE_HOLD_REASON) {
      return plan('hold', 'This run is intentionally held by disabled auto-merge. Use the explicit ship action when shipping is wanted.', context);
    }
    try {
      const owners = await recoveryOwners(paths, state);
      if (!owners.clear) return plan('wait_for_owners', 'Worker or gate retirement is unresolved. Wait for native stop evidence or resolve the named ownership before resuming; the existing run is preserved.', { ...context, owners });
      const observation = await recoveryObservation(paths, state.branch);
      let executionTree = observation.tree;
      let executionHead = observation.head;
      if (observation.branch !== state.branch) {
        const checkpoint = state.work_checkpoint_id ? await readWorkCheckpoint(paths, state.work_checkpoint_id) : null;
        const cleanBase = observation.branch === state.base_branch && observation.tree === observation.index &&
          observation.tree === await runGit(paths.root, ['rev-parse', `${observation.head}^{tree}`]);
        if (!cleanBase || !checkpoint || checkpoint.source_run_id !== state.run_id || checkpoint.source_branch !== state.branch ||
            observation.source?.head !== checkpoint.source_head || observation.source?.tree !== checkpoint.tree_sha ||
            checkpoint.tree_sha !== checkpoint.index_tree_sha) {
          return plan('inspect_recovery', 'The checkout or retained run branch changed after the block. Preserve current work and return to the run branch before recovery.', context);
        }
        executionTree = observation.source.tree;
        executionHead = observation.source.head;
      }
      const config = await loadRuntimeConfig(paths.config);
      const reviewedTree = state.receipts?.at(-1)?.head_tree_sha;
      const validAdmission = validatedAdmittedStartIdentity(state) && state.start_config_hash === sha256(config) &&
        state.admission?.version === 1 && state.admission.manifest?.version === 1 &&
        state.admission.manifest.ready === true && sha256(state.admission.manifest) === state.admission.digest;
      const maximum = pipelineLimits(state).max_regate_attempts;
      const attempts = state.regate_attempts ?? 0;
      const regate = state.stage === 'gates' && executionTree === reviewedTree && validAdmission &&
        Number.isSafeInteger(attempts) && attempts >= 0 && attempts < Number.MAX_SAFE_INTEGER &&
        (maximum === undefined || attempts < maximum);
      const watch = state.shipping_watch ?? state.shipping_recovery?.watch;
      const shipping = watch || state.shipping_recovery || state.stage === 'merge' || state.merge?.pr_url ||
        state.block_reason?.startsWith('shipping failed:');
      const kind = shipping ? 'reconcile_shipping' : regate ? 'regate' : 'replace_run';
      if (shipping && !watch) return plan('inspect_recovery', 'Shipping may already have created or merged a pull request. Inspect the existing shipment before selecting new work; this run will not create a duplicate shipment.', context);
      if (watch && (executionHead !== watch.head_oid || executionTree !== await runGit(paths.root, ['rev-parse', `${watch.head_oid}^{tree}`]))) {
        return plan('inspect_recovery', 'Local work differs from the existing shipment. Preserve the new work and inspect that pull request before retrying shipping or replacing the execution.', context);
      }
      const digest = sha256({ version: 1, kind, state, observation, owners });
      return plan(kind, shipping ? 'Reconcile the existing pull request before any further shipping.' : regate
        ? 'Reviewed code and admission are unchanged; retry the full gate suite using this run’s remaining attempts.'
        : 'Preserve the task and current files in a checkpoint, retire this execution, and start fresh validation.',
      { ...context, expected_recovery_digest: digest, observation });
    } catch {
      return plan('inspect_recovery', 'Recovery evidence, checkout, or configuration is unreadable. Resolve it before retrying; the run and files are preserved.', context);
    }
  }
  const recovery = await discoverWorkCheckpoints(paths, { includeSources: true });
  const legacy = await discoverLegacyRecovery(paths, { preservedSources: recovery.preserved_sources ?? [], selectedId: options.legacy_candidate_id ?? null });
  // A checkpoint is already the authoritative source for its branch. Do not
  // offer the identical retained branch again as an unrelated legacy task.
  if (options.legacy_candidate_id) {
    const selection = await selectLegacyRecovery(paths, legacy, options);
    const fields = { legacy, legacy_candidate_id: selection.selected.legacy_candidate_id };
    if (!selection.startInput) return plan('legacy_context', 'Confirm the selected source’s task: supply legacy_run_id from the saved tasks, or recovery_context with objective, mode, lane, host, claimed_paths and test_paths.', fields);
    if (selection.sourceRun && !(await recoveryOwners(paths, selection.sourceRun)).clear) {
      return plan('wait_for_owners', 'The selected saved task still has unresolved worker or gate ownership. Preserve it and resolve that ownership before adoption.', fields);
    }
    const observation = await recoveryObservation(paths);
    return plan('adopt_legacy', 'Import only this selected source into a durable checkpoint with the confirmed task context. The source remains intact.',
      { ...fields, expected_recovery_digest: sha256({ version: 1, selection, observation }), observation });
  }
  if (!recovery.count && !recovery.unavailable && !legacy.count && !legacy.unavailable && !recovery.truncated && !legacy.truncated) return null;
  return plan(recovery.count === 1 && !recovery.unavailable && !recovery.truncated && !legacy.count && !legacy.unavailable && !legacy.truncated ? 'recover_checkpoint' : 'choose_work',
    'Select the unfinished task and source to recover. Legacy sources require an explicit task association; nothing has been applied.',
    { checkpoint_count: recovery.count, checkpoints: recovery.checkpoints, unavailable: recovery.unavailable, truncated: recovery.truncated, legacy });
}

export function recoveryPlanResponse(recovery, state = null) {
  if (!recovery) return { ok: false, reason: 'no active run' };
  return { ok: true, active: Boolean(state) && !SEALED_STATUSES.has(state.status), run: state,
    ...(recovery.checkpoints ? { recovery: { count: recovery.checkpoint_count ?? recovery.checkpoints.length, checkpoints: recovery.checkpoints,
      unavailable: recovery.unavailable, truncated: recovery.truncated },
      reason: recovery.unavailable ? 'Recovery checkpoint storage needs inspection; no files were changed.' : recovery.reason } : {}),
    recovery_plan: recovery, next_action: recoveryNextAction(recovery) ?? { kind: 'wait' } };
}
