import { randomUUID } from 'node:crypto';
import { sha256 } from './canonical.js';
import { acquireRunLock, releaseRunLock } from './lock.js';
import { withDispatchLock } from './claude-dispatch.js';
import { activeState } from './active-state.js';
import { SEALED_STATUSES } from './constants.js';
import { planTaskRecovery, recoveryObservation, recoveryPlanResponse } from './recovery-planner.js';
import { discoverLegacyRecovery, selectLegacyRecovery, importLegacyCheckpoint } from './legacy-recovery.js';
import { checkpointContinuation, publishRecoveryJournal, readRecoveryJournal, readWorkCheckpoint, restoreWorkCheckpoint, saveWorkCheckpoint } from './work-checkpoints.js';

const stale = (recovery) => ({ ...recoveryPlanResponse(recovery), ok: false, code: 'recovery-plan-changed',
  reason: 'The selected task, files, index, configuration, or ownership changed. Inspect the new recovery plan and confirm its exact digest; nothing was retired.' });

// Caller owns the receipt-effects lock. The run lock also excludes ordinary
// start, while the dispatch lock closes the late-launch/binding race.
export async function confirmTaskRecovery(paths, options, handlers) {
  if (options.explicit_invocation !== true) return { ok: false, reason: 'Recovery requires an explicit APE resume invocation.' };
  return withDispatchLock(paths, async () => {
    const state = await activeState(paths);
    const prior = await readRecoveryJournal(paths, options.expected_recovery_digest);
    if (prior) {
      const continuation = await checkpointContinuation(paths, prior.checkpoint_id);
      if (continuation) return { ok: true, recovered: 'already-continued', run_id: continuation.run_id,
        next_action: { kind: 'inspect_recovery' }, reason: 'This checkpoint already continued. Inspect current status for that execution; do not start another run.' };
      if (state && !SEALED_STATUSES.has(state.status) && state.run_id !== prior.source_run_id) return stale(null);
    }
    const recovery = prior ? null : await planTaskRecovery(paths, state, options);
    if (!prior && recovery?.expected_recovery_digest !== options.expected_recovery_digest) return stale(recovery);
    // Retirement can remove active state before a later cleanup effect fails.
    // Replay must reclaim that journal's exact source ownership, including after
    // a process crash, rather than contend under an unrelated recovery identity.
    const lockId = state && !SEALED_STATUSES.has(state.status) ? state.run_id
      : prior?.source_run_id ?? `run-recovery-${randomUUID()}`;
    const runLock = await acquireRunLock(paths.lock, lockId, { recoverStale: true, reuseOwned: true });
    // A refused/crashed recovery must not drop the blocked run's existing
    // ownership. Once active state is gone, journal replay owns cleanup and must
    // release the reclaimed generation even if restoring the checkpoint fails.
    let retainLock = runLock.reused === true && state !== null && !SEALED_STATUSES.has(state.status);
    try {
      // Re-read after acquiring every lifecycle lock. A journal is a durable
      // intent, never permission to retire a changed execution or new files.
      const current = await activeState(paths);
      if (sha256(current) !== sha256(state)) return stale(null);
      let journal = prior;
      if (!journal) {
        const checked = await planTaskRecovery(paths, current, options);
        if (checked?.expected_recovery_digest !== options.expected_recovery_digest) return stale(checked);
        if (checked.kind === 'regate') {
          const result = await handlers.regate();
          if (result.ok === true) retainLock = ['running', 'gating', 'shipping'].includes(result.run?.status);
          return result;
        }
        if (checked.kind === 'reconcile_shipping') {
          const result = await handlers.shipping(current);
          if (result.ok === true) retainLock = true;
          return result;
        }
        const checkpoint = checked.kind === 'replace_run'
          ? await saveWorkCheckpoint(paths, current)
          : await importLegacyCheckpoint(paths, await selectLegacyRecovery(paths, checked.legacy, options));
        // Do not publish a transition for a snapshot raced by an external editor.
        if (sha256(await recoveryObservation(paths, checked.kind === 'replace_run' ? current.branch : null)) !== sha256(checked.observation)) return stale(null);
        if (checked.kind === 'adopt_legacy') {
          const selection = await selectLegacyRecovery(paths, await discoverLegacyRecovery(paths, { selectedId: options.legacy_candidate_id }), options);
          if (sha256({ version: 1, selection, observation: checked.observation }) !== options.expected_recovery_digest) return stale(null);
        }
        journal = { version: 1, source_run_id: current && !SEALED_STATUSES.has(current.status) ? current.run_id : null,
          source_state_hash: current ? sha256(current) : null, kind: checked.kind,
          checkpoint_id: checkpoint.checkpoint_id, observation: checked.observation };
        await publishRecoveryJournal(paths, options.expected_recovery_digest, journal);
      }
      await readWorkCheckpoint(paths, journal.checkpoint_id);
      if (current && !SEALED_STATUSES.has(current.status)) {
        if (current.run_id !== journal.source_run_id || sha256(current) !== journal.source_state_hash ||
            sha256(await recoveryObservation(paths, current.branch)) !== sha256(journal.observation)) return stale(null);
        // Recheck ownership even on crash replay; a journal cannot assert that
        // a child that bound later has stopped.
        const checked = await planTaskRecovery(paths, current, options);
        if (checked.kind !== 'replace_run') return stale(checked);
        await handlers.retire(current, journal.checkpoint_id);
        retainLock = false;
      }
      return await restoreWorkCheckpoint(paths, journal.checkpoint_id);
    } finally { if (!retainLock) await releaseRunLock(paths.lock, lockId); }
  });
}
