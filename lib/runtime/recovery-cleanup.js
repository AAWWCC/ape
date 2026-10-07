import { boundedGateSummary } from './bounded-summary.js';
import { checkpointPreparedBranches, readWorkCheckpoint } from './work-checkpoints.js';
import { deleteLocalShippingBranch } from './shipping-cleanup.js';

export function recoveryCleanupPending(state) {
  return state?.status === 'completed' && Boolean(state.checkpoint_id) && state.recovery_cleanup?.status !== 'complete';
}

// Checkpoints pin exact source tips as snapshot parents. A branch name alone
// never proves ownership or task membership. Checkpoint refs are retained.
export async function cleanupRecoveryLineage(paths, state) {
  if (state.status !== 'completed' || !state.checkpoint_id) return null;
  const results = [];
  const seen = new Set();
  const branches = new Set();
  let id = state.checkpoint_id;
  try {
    while (id) {
      if (seen.has(id) || seen.size >= 256) throw new Error('recovery lineage is cyclic or exceeds its inspection bound');
      seen.add(id);
      const checkpoint = await readWorkCheckpoint(paths, id);
      const candidates = [{ branch: checkpoint.source_branch, head: checkpoint.source_head,
        owned: checkpoint.owned_branch === checkpoint.source_branch },
      ...(await checkpointPreparedBranches(paths, checkpoint)).map((entry) => ({ branch: entry.branch, head: entry.commit, owned: true }))];
      for (const { branch, head, owned } of candidates) {
        if (!branch || branches.has(branch) || branch === state.branch) continue;
        branches.add(branch);
        if (!owned || !branch.startsWith('ape/')) {
          results.push({ branch, status: 'retained', reason: 'Runtime ownership of this source branch is unproven.' });
        } else {
          try {
            await deleteLocalShippingBranch(paths.root, branch, head);
            results.push({ branch, expected_head: head, status: 'removed' });
          } catch (error) {
            results.push({ branch, expected_head: head, status: 'retained', reason: boundedGateSummary(error.message, 256) });
          }
        }
      }
      id = checkpoint.parent_checkpoint_id ?? null;
    }
    return { status: results.some((item) => item.status === 'retained') ? 'pending' : 'complete', branches: results, updated_at: new Date().toISOString() };
  } catch (error) {
    return { status: 'pending', branches: results, reason: boundedGateSummary(error.message, 256), updated_at: new Date().toISOString() };
  }
}
