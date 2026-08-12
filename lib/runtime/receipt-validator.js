import { diffFiles, currentTreeSha } from './git.js';
import { looksLikeTest, normalizeClaimPath, withinClaims, withinTestScope } from './path-scope.js';
import { validateReceipt, validateTicket } from './schemas.js';

// Author-blind diff: the runtime cannot attribute a divergence to a writer,
// so it names the recovery lever instead of adding a disclaim path that would
// weaken the single-writer invariant.
const EXTERNAL_WRITER_HINT =
  'an external or orphaned writer may have mutated the shared tree; recover with ape_run action override operation reset, then restore a clean tree';

// The role-boundary predicates are the shared path-scope matchers, so this
// receipt-time layer accepts exactly what the write-time hook allowed and
// rejects exactly what it denied. The default test predicate is claims-aware
// (looksLikeTest, not the bare name pattern): a test writer whose configured
// test claim is not test-named (a `checks/` suite) was admitted at write time
// and must not be rejected here as a production write.
//
// `tree` is an optional treeShaSession scoped to the caller's receipt-effects
// critical section. It does NOT weaken the independent recompute that
// enforces invariants 4/8 (docs/invariants.md names this module's recompute
// as their enforcement): a session's first read is always a real git read
// and is never seeded from receipt or ticket fields, so the comparison below
// still pits agent claims against a runtime-observed tree — the session only
// dedupes the byte-identical read the service layer performed microseconds
// earlier under the same lock, with no effect in between. Prepared-transaction
// replays keep their load-bearing live-tree check for the same reason: the
// session read IS the live tree.
//
// The result shape is declared explicitly because the admission-failure early
// return carries ONLY {valid, errors}: without a declared shape the two returns
// infer an unreduced union and every caller-side read of the analysis fields
// fails to typecheck. Every field below the first two is therefore OPTIONAL —
// that is the truth on the early-return path — and deadline_stamp_unparseable
// is additionally attached only when a stamp really is unparseable, so a
// well-formed receipt's result object is byte-identical to before.
/**
 * @returns {Promise<{
 *   valid: boolean,
 *   errors: string[],
 *   actual_files?: string[],
 *   tree_sha?: string,
 *   deadline_overrun_ms?: number,
 *   deadline_stamp_unparseable?: string,
 * }>}
 */
export async function validateStageReceipt({
  project_dir,
  state,
  ticket,
  receipt,
  tree = null,
  test_path_predicate = (file) => looksLikeTest(file, ticket.test_paths),
}) {
  const errors = [];
  const ticketResult = validateTicket(ticket);
  const receiptResult = validateReceipt(receipt);
  if (!ticketResult.valid) errors.push(...ticketResult.errors.map((error) => `ticket: ${error.message}`));
  if (!receiptResult.valid) errors.push(...receiptResult.errors.map((error) => `receipt: ${error.message}`));
  if (errors.length > 0) return { valid: false, errors };

  if (receipt.run_id !== state.run_id) errors.push('receipt belongs to a different run');
  if (receipt.ticket_id !== ticket.ticket_id) errors.push('receipt belongs to a different ticket');
  if (receipt.ticket_hash !== ticket.ticket_hash) errors.push('receipt ticket hash mismatch');
  if (receipt.agent.role !== ticket.role) errors.push('agent role does not match ticket role');
  if (receipt.base_tree_sha !== ticket.base_tree_sha) errors.push('receipt base tree is stale');
  if (state.receipts.some((entry) => entry.receipt_id === receipt.receipt_id)) errors.push('replayed receipt id');
  if (state.receipts.some((entry) => entry.receipt_hash === receipt.receipt_hash)) errors.push('replayed receipt hash');
  if (state.receipts.some((entry) => entry.ticket_id === ticket.ticket_id)) errors.push('ticket already has a receipt');
  const previous = state.receipts.at(-1)?.receipt_hash ?? null;
  if (receipt.previous_receipt_hash !== previous) errors.push('receipt hash chain is broken');
  // Shape check only: self-reported tests[] can never carry a red-test
  // admission by itself (F12). The service layer (recordReceiptLocked)
  // executes the authored tests itself and rejects the receipt unless the
  // runtime observes the red phase; this validator stays pure and
  // side-effect free.
  if (
    receipt.status === 'passed' &&
    ticket.required_checks.includes('red-test') &&
    !receipt.tests.some((test) => test.passed === false && test.exit_code !== 0)
  ) {
    errors.push('required red-test evidence is missing');
  }
  if (
    receipt.status === 'passed' &&
    ticket.required_checks.includes('targeted-tests') &&
    !receipt.tests.some((test) => test.passed === true && test.exit_code === 0)
  ) {
    errors.push('required targeted-tests evidence is missing');
  }
  // A stamp that fails Date.parse must not silently DISABLE the lateness path:
  // Math.max(0, NaN) is NaN and `NaN > 0` is false, so an unparseable
  // deadline_at used to cost the state.deadline_overruns record that is its real
  // casualty. Both operands are runtime-generated (deadline_at is minted by
  // finalizeTicket and covered by ticket_hash; completed_at is re-stamped by the
  // service), so an unparseable one means tampering or state corruption: name
  // the offending field so the caller can record it loudly. Deliberately NOT a
  // new admission rejection — the ticket is immutable, so a rejection would
  // re-reject on every identical retry and burn both attempts with no operator
  // lever, guarding an error that is already verdict-redundant. When both stamps
  // parse, the overrun is byte-identical to before.
  let deadlineOverrunMs = 0;
  let deadlineStampUnparseable = null;
  if (receipt.status === 'passed') {
    const deadlineMs = Date.parse(ticket.deadline_at);
    const completedMs = Date.parse(receipt.timing.completed_at);
    const unparseable = [];
    if (Number.isNaN(deadlineMs)) unparseable.push('deadline_at');
    if (Number.isNaN(completedMs)) unparseable.push('completed_at');
    if (unparseable.length > 0) deadlineStampUnparseable = unparseable.join(',');
    else deadlineOverrunMs = Math.max(0, completedMs - deadlineMs);
  }

  const actualTree = tree ? await tree.current() : await currentTreeSha(project_dir);
  const treeConsistent = receipt.head_tree_sha === actualTree;
  if (!treeConsistent) {
    const divergent = tree
      ? await tree.diff(receipt.head_tree_sha, actualTree).catch(() => [])
      : await diffFiles(project_dir, receipt.head_tree_sha, actualTree).catch(() => []);
    errors.push(
      `receipt head tree does not match the current tree (diverged: ${divergent.join(', ') || 'unresolvable'}); ${EXTERNAL_WRITER_HINT}`,
    );
  }
  // A late receipt is admitted while it is still provably valid against the
  // live tree; once the tree has moved on, lateness is staleness and rejects.
  if (deadlineOverrunMs > 0 && !treeConsistent) errors.push('stage deadline exceeded');
  const actualFiles = tree
    ? await tree.diff(receipt.base_tree_sha, receipt.head_tree_sha)
    : await diffFiles(project_dir, receipt.base_tree_sha, receipt.head_tree_sha);
  const claimedFiles = [...receipt.changed_files].map(normalizeClaimPath).sort();
  if (JSON.stringify(actualFiles.map(normalizeClaimPath)) !== JSON.stringify(claimedFiles)) {
    errors.push('receipt changed_files does not match the independently recomputed diff');
  }
  const boundaryViolations = new Set();
  for (const file of actualFiles) {
    const testWriterScope =
      ticket.role === 'test_writer' && withinTestScope(file, ticket.test_paths);
    if (!testWriterScope && !withinClaims(file, ticket.claimed_paths)) {
      errors.push(`unclaimed write: ${file}`);
      boundaryViolations.add(file);
    }
    if (ticket.role === 'test_writer' && !test_path_predicate(file)) {
      errors.push(`test writer modified a production path: ${file}`);
      boundaryViolations.add(file);
    }
    // Same predicate as the write-time hook: an implementer touching anything
    // test-shaped — inside the authored test claims OR name-patterned — was
    // denied at write time, so the exact-file check here (which let a
    // hook-denied write slip through when the hook was absent) widens to match.
    if (ticket.role === 'implementer' && looksLikeTest(file, ticket.test_paths)) {
      errors.push(`implementer modified an authored test: ${file}`);
      boundaryViolations.add(file);
    }
    if (!ticket.writable) {
      errors.push(`read-only ${ticket.role} changed ${file}`);
      boundaryViolations.add(file);
    }
  }
  if (boundaryViolations.size > 0) {
    errors.push(
      `role-boundary violations (${[...boundaryViolations].join(', ')}) may not be the ticketed agent's own writes; ${EXTERNAL_WRITER_HINT}`,
    );
  }
  return {
    valid: errors.length === 0,
    errors,
    actual_files: actualFiles,
    tree_sha: actualTree,
    deadline_overrun_ms: deadlineOverrunMs,
    ...(deadlineStampUnparseable ? { deadline_stamp_unparseable: deadlineStampUnparseable } : {}),
  };
}
