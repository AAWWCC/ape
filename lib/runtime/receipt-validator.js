import { diffFiles, currentTreeSha } from './git.js';
import { looksLikeTest, normalizeClaimPath, withinClaims, withinTestScope } from './path-scope.js';
import { validateReceipt, validateTicket } from './schemas.js';
import { roleReceiptRequirements } from './pipeline.js';

// ---------------------------------------------------------------------------
// Draft receipt validation — pure, synchronous, non-mutating
// ---------------------------------------------------------------------------
// Validates a raw draft receipt against a ticket's output_schema and
// role-specific requirements. Returns bounded field-specific corrections
// without I/O, git access, or state mutation. This runs BEFORE the
// authoritative recordReceiptLocked path and never replaces it.

const DRAFT_CORRECTIONS_CAP = 20;

const VALID_STATUSES = new Set(['passed', 'failed']);
// Status synonyms that normalizeReceiptInput would coerce — flag them as
// correctable rather than rejecting outright.
const STATUS_SYNONYMS = { success: 'passed', complete: 'passed', completed: 'passed', failure: 'failed', error: 'failed' };

function pushCorrection(corrections, field, issue, correction) {
  if (corrections.length < DRAFT_CORRECTIONS_CAP) {
    corrections.push({ field, issue, correction });
  }
}

function validateCommonFields(ticket, draft, corrections) {
  // ticket_id
  if (draft.ticket_id === undefined || draft.ticket_id === null) {
    pushCorrection(corrections, 'ticket_id', 'ticket_id is missing', `set ticket_id to "${ticket.ticket_id}"`);
  } else if (typeof draft.ticket_id !== 'string' || draft.ticket_id === '') {
    pushCorrection(corrections, 'ticket_id', 'ticket_id must be a non-empty string', `set ticket_id to "${ticket.ticket_id}"`);
  } else if (draft.ticket_id !== ticket.ticket_id) {
    pushCorrection(corrections, 'ticket_id', `ticket_id "${draft.ticket_id}" does not match the ticket`, `set ticket_id to "${ticket.ticket_id}"`);
  }

  // status
  if (draft.status === undefined || draft.status === null) {
    pushCorrection(corrections, 'status', 'status is missing', 'set status to "passed" or "failed"');
  } else if (typeof draft.status !== 'string') {
    pushCorrection(corrections, 'status', 'status must be a string', 'set status to "passed" or "failed"');
  } else if (!VALID_STATUSES.has(draft.status)) {
    const synonym = STATUS_SYNONYMS[draft.status.toLowerCase()];
    if (synonym) {
      pushCorrection(corrections, 'status', `status "${draft.status}" is a synonym`, `use the canonical value "${synonym}"`);
    } else {
      pushCorrection(corrections, 'status', `status "${draft.status}" is not a valid value`, 'set status to "passed" or "failed"');
    }
  }

  // tests
  if (draft.tests === undefined || draft.tests === null) {
    pushCorrection(corrections, 'tests', 'tests is missing', 'set tests to an array of test result objects');
  } else if (!Array.isArray(draft.tests)) {
    pushCorrection(corrections, 'tests', 'tests must be an array', 'set tests to an array of test result objects');
  } else {
    for (let i = 0; i < draft.tests.length; i++) {
      const test = draft.tests[i];
      if (!test || typeof test !== 'object' || Array.isArray(test)) {
        pushCorrection(corrections, `tests[${i}]`, 'test entry must be an object', 'provide an object with command, passed, exit_code, duration_ms');
        continue;
      }
      if (typeof test.command !== 'string' || test.command === '') {
        pushCorrection(corrections, `tests[${i}].command`, 'command must be a non-empty string', 'set command to the test command that was executed');
      }
      if (typeof test.passed !== 'boolean') {
        pushCorrection(corrections, `tests[${i}].passed`, 'passed must be a boolean', 'set passed to true or false');
      }
      if (typeof test.exit_code !== 'number' || !Number.isInteger(test.exit_code)) {
        pushCorrection(corrections, `tests[${i}].exit_code`, 'exit_code must be an integer', 'set exit_code to the integer exit code');
      }
      if (typeof test.duration_ms !== 'number' || test.duration_ms < 0) {
        pushCorrection(corrections, `tests[${i}].duration_ms`, 'duration_ms must be a non-negative number', 'set duration_ms to the test duration in milliseconds');
      }
    }
  }

  // findings
  if (draft.findings === undefined || draft.findings === null) {
    pushCorrection(corrections, 'findings', 'findings is missing', 'set findings to an array (empty array if no findings)');
  } else if (!Array.isArray(draft.findings)) {
    pushCorrection(corrections, 'findings', 'findings must be an array', 'set findings to an array of finding objects');
  }

  // evidence
  if (draft.evidence === undefined || draft.evidence === null) {
    pushCorrection(corrections, 'evidence', 'evidence is missing', 'set evidence to an object with at least a summary field');
  } else if (typeof draft.evidence !== 'object' || Array.isArray(draft.evidence)) {
    pushCorrection(corrections, 'evidence', 'evidence must be a plain object, not an array', 'set evidence to an object with at least a summary field');
  }
}

function validateRoleSpecific(ticket, draft, corrections) {
  const role = ticket.role;
  const reqs = roleReceiptRequirements(role, ticket.stage_id);
  if (!reqs.evidence_required) return;
  const evidence = draft.evidence;
  if (!evidence || typeof evidence !== 'object' || Array.isArray(evidence)) return;

  for (const field of reqs.evidence_required) {
    if (field === 'verdict') {
      if (evidence.verdict === undefined || evidence.verdict === null) {
        pushCorrection(corrections, 'evidence.verdict', `${role} receipt requires evidence.verdict`, `set evidence.verdict to one of: ${reqs.verdict_values.join(', ')}`);
      } else if (reqs.verdict_values && !reqs.verdict_values.includes(evidence.verdict)) {
        pushCorrection(corrections, 'evidence.verdict', `evidence.verdict "${evidence.verdict}" is not valid for ${role}`, `set evidence.verdict to one of: ${reqs.verdict_values.join(', ')}`);
      }
    } else if (field === 'candidate_plan') {
      if (evidence.candidate_plan === undefined || evidence.candidate_plan === null) {
        pushCorrection(corrections, 'evidence.candidate_plan', `${role} receipt requires evidence.candidate_plan`, 'set evidence.candidate_plan to the structured plan object');
      }
    } else if (field === 'artifact') {
      const hasArtifact = evidence.artifact !== undefined && evidence.artifact !== null;
      const hasPreflight = evidence.preflight_artifact !== undefined && evidence.preflight_artifact !== null;
      if (!hasArtifact && !hasPreflight) {
        pushCorrection(corrections, 'evidence.artifact', `${role} receipt requires evidence.artifact (preflight artifact)`, 'set evidence.artifact to the preflight artifact object');
      }
    }
  }
}

/**
 * Validates a raw draft receipt against the ticket and role-specific
 * requirements. Pure, synchronous, and non-mutating.
 * @param {object} ticket - The immutable StageTicket
 * @param {object} draft - The raw draft receipt object
 * @returns {{ valid: boolean, corrections: Array<{ field: string, issue: string, correction: string }> }}
 */
export function validateReceiptDraft(ticket, draft) {
  const corrections = [];

  if (!draft || typeof draft !== 'object' || Array.isArray(draft)) {
    pushCorrection(corrections, 'receipt', 'draft must be a plain object', 'return a JSON object with ticket_id, status, tests, findings, and evidence');
    return { valid: false, corrections };
  }

  validateCommonFields(ticket, draft, corrections);
  validateRoleSpecific(ticket, draft, corrections);

  return {
    valid: corrections.length === 0,
    corrections: corrections.slice(0, DRAFT_CORRECTIONS_CAP),
  };
}

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
  // Self-reported tests[] can never carry red-test admission (F12). The
  // service layer (recordReceiptLocked) exclusively executes the authored
  // paths and rejects the receipt unless the runtime observes the red phase;
  // requiring the worker to duplicate that expected-nonzero command creates
  // redundant failure-shaped tool traffic without adding authority.
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
    const exactTestScope = ticket.role === 'test_writer' && ticket.test_scope === 'exact';
    const testWriterScope =
      ticket.role === 'test_writer'
      && withinTestScope(file, ticket.test_paths, exactTestScope);
    // Exact remediation scope is authoritative for test writers. Check it
    // before the generic claimed-path fallback: an authorized file claim must
    // never become a directory prefix that admits an unauthorized descendant.
    if (
      (exactTestScope && !testWriterScope)
      || (!testWriterScope && !withinClaims(file, ticket.claimed_paths))
    ) {
      errors.push(`unclaimed write: ${file}`);
      boundaryViolations.add(file);
    }
    if (
      ticket.role === 'test_writer'
      && (exactTestScope ? !testWriterScope : !test_path_predicate(file))
    ) {
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
