// Advisory only: constructing this bounded descriptor cannot mutate a run,
// attribute a writer, grant a retry, or authorize an operator action. Never
// accept error prose, paths, identities, or capabilities into this projection.
const ACTIVE_STATUSES = new Set(['starting', 'planning', 'running', 'input_required', 'gating', 'shipping']);
const RESET_STATUSES = new Set(['blocked', 'aborted', 'completed']);
const RECEIPT_CAUSES = new Set(['receipt-invalid', 'receipt-tree-diverged', 'receipt-role-boundary']);

export function receiptRejectionRecovery(state, cause = 'receipt-invalid') {
  const status = state?.status;
  const knownStatus = ACTIVE_STATUSES.has(status) || RESET_STATUSES.has(status);
  return {
    version: 1,
    cause: RECEIPT_CAUSES.has(cause) ? cause : 'receipt-invalid',
    run_status: knownStatus ? status : 'unknown',
    state_changed: false,
    eligible_actions: [
      'diagnose',
      ...(ACTIVE_STATUSES.has(status) ? ['override-abort'] : []),
      ...(RESET_STATUSES.has(status) ? ['override-reset'] : []),
    ],
    preconditions: [
      'inspect-current-run-and-rejection-before-acting',
      'preserve-current-tree-before-lifecycle-change',
      'explicit-operator-direction-and-nonempty-audit-reason',
      'recheck-exact-run-and-current-state-before-mutation',
      'reset-requires-blocked-aborted-or-completed-state',
      'no-automatic-abort-reset-cleanup-or-replacement-dispatch',
    ],
    operator_required: true,
    preserves_worktree: true,
  };
}

export function projectReceiptRejectionRecovery(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      value.version !== 1 || !RECEIPT_CAUSES.has(value.cause) ||
      !(value.run_status === 'unknown' || ACTIVE_STATUSES.has(value.run_status) || RESET_STATUSES.has(value.run_status)) ||
      value.state_changed !== false || value.operator_required !== true || value.preserves_worktree !== true) return null;
  return receiptRejectionRecovery({ status: value.run_status }, value.cause);
}
