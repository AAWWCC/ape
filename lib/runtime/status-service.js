import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { access, readFile, rm, stat } from 'node:fs/promises';
import { AUTO_MERGE_HOLD_REASON, CHECKS_REGISTRATION_RETRY_DELAY_MS, GATE_INLINE_GRACE_MS, GATE_NEXT_MAX_WAIT_MS, GATE_NEXT_POLL_FLOOR_MS, GATE_POLL_RETRY_DELAY_MS, RECEIPT_STATUSES, RISK_TRIGGERS, RUNTIME_VERSION, SCHEMA_VERSION, SCOPE_EXPANSION_REASONS_MAX, SEALED_STATUSES, TERMINAL_STATUSES } from './constants.js';
import { runtimePaths } from './paths.js';
import { atomicReplaceText, atomicWriteJson, appendJsonLine, readJson, replaceFile } from './storage.js';
import { acquireRunLock, inspectRunLock, releaseRunLock, stealLockFileByRename, withDirLock } from './lock.js';
import { assertEvidenceScriptsValue, assertRunnersValue, DEFAULT_CONFIG, loadRuntimeConfig, proposeTestCommands, resolveModel, setRuntimeConfig } from './config.js';
import { classifyLane, escalateLane } from './lane-policy.js';
import { declaredTestRemediationPaths, declaredTestRemediations, extractTestRemediation } from './pipeline.js';
import { REVIEW_FINDINGS_BLOCK_LIMIT, REVIEW_FINDINGS_MAX, reduceRun } from './scheduler.js';
import {
  finalizeReceipt,
  finalizeTicket,
  RunStartInputSchema,
} from './schemas.js';
import { currentBranch, currentCommitSha, currentTreeSha, diffFiles, resolveBaseBranch, runGit, treeHasPath, treeShaSession, workingTreeStatus } from './git.js';
import { snapshotEvidenceExecutables } from './hooks.js';
import { TEST_PATH_PATTERN, looksLikeTest, normalizeClaimPath, withinClaims } from './path-scope.js';
import { validateStageReceipt } from './receipt-validator.js';
import { detectTestRunner, isPytestInvocation, runTestSuite, splitCommand, targetedInvocation, templateInvocation } from './runner.js';
import { archiveRun as archiveRunRecord, calculateProjectMetrics, explainRun, logicalLineageForRun, queryHistory, selectEffectiveRecord } from './history.js';
import { importLegacyPlanning } from './importer.js';
import { doctor } from './doctor.js';
import { statuslineState, unwireStatusline, wireStatusline } from './statusline.js';
import { autoMergeGithub, evaluateGates, impactedMergeGuard, pollGateSuite, pollRemoteChecksAndMerge, runnerOwnsFile, startGateSuite } from './gates.js';
import { killProcessTree } from './spawn.js';
import { nativeDispatch } from './adapters.js';
import {
  completeClaudeReceiptBinding,
  dispatchIntentStatuses,
  expireClaudeIntent,
  expireClaudeIntentsForRun,
  prepareCodexIntent,
  prepareClaudeIntent,
  pruneClaudeIntents,
  validateClaudeReceiptBinding,
} from './claude-dispatch.js';
import { assertSafeInput } from './input-guard.js';
import { normalizeReceiptInput } from './receipt-input.js';
import { sha256 } from './canonical.js';
import { successorGuidanceForState } from './successor-guidance.js';
import {
  candidatePlanForScope,
  PLAN_CONTRACT_VERSION,
  validatePlanDeviation,
} from './plan-contract.js';
import { renderStatusDoc } from './status-doc.js';
import { isCanonicalRunId, projectRunDiagnostic, safeDiagnosticText, safeModelTier, strictIsoMs, validatedArchiveSnapshot } from './diagnostics.js';
import {
  projectTerminalRecovery,
  terminalFailureDomain,
  terminalReasonCode,
} from './terminal-telemetry.js';
import { validatedVersionProvenance } from './versions.js';
import { assertRoadmapRequirementsReady, attestRequirements, deriveRoadmap, registerEntries, supersedeEntries } from './roadmap.js';
import {
  compactArchivedArtifacts,
  readArtifactRetentionStatus,
  recordArtifactRetentionStatus,
} from './retention.js';
import {
  acknowledgeBindingProbe,
  bindingProbeStatus,
  consumeBindingProbe,
  prepareBindingProbe,
} from './binding-probe.js';

// Status/history mutations share the receipt-effects lock without importing
// receipt-service.js back into the status owner (receipt-service consumes the
// bounded status helpers below, so that edge would create a module cycle).
function withStatusMutationLock(paths, operation, options = {}) {
  return withDirLock(paths.receiptLock, operation, {
    staleMs: 60_000,
    heartbeatMs: 15_000,
    busyMs: 15_000,
    serializeLocal: true,
    busyMessage: options.busyMessage ?? 'receipt effects are busy; retry the identical operation',
  });
}

export function now() {
  return new Date().toISOString();
}

// Built from NUMERIC code points via String.fromCharCode, never a `\u` regex
// escape literal and never a literal byte typed in this source file: every
// range below is named by its two hex boundaries only, so this file's own
// bytes stay fully printable/auditable ASCII even though the CONSTRUCTED
// pattern matches invisible and bidi-reordering characters. (The mandate
// that the dangerous code points never appear as a literal byte in source is
// binding on the authored test per its own header; it is followed here too,
// on the stronger ground that a raw bidi-override byte sitting in this
// FILE's own text would itself be exactly the hiding/reordering hazard this
// change exists to neutralize, in the one place — source under review — an
// invisible-character defence most needs to hold.)
export function codePointRange(startCodePoint, endCodePoint) {
  const start = String.fromCharCode(startCodePoint);
  return endCodePoint > startCodePoint ? `${start}-${String.fromCharCode(endCodePoint)}` : start;
}

export const REPLACEMENT_CHARACTER = String.fromCharCode(0xfffd);

// Roadmap entry bounded-summary-control-character-passthrough. THE CHARACTER
// SET this helper neutralizes, beyond the whitespace class it already
// flattens: C0 controls minus whitespace (U+0000-U+0008, U+000E-U+001F), DEL
// through the whole C1 block (U+007F-U+009F -- one RANGE, stopping exactly
// one code point below U+00A0 so a NBSP is never caught; see RESIDUALS
// below), soft hyphen (U+00AD), the Arabic Letter Mark (U+061C), the
// zero-width/bidi-mark block (U+200B-U+200F), the bidi embedding/override
// controls (U+202A-U+202E), the invisible-operator/deprecated-bidi block
// (U+2060-U+206F, which contains the LRI/RLI/FSI/PDI isolates U+2066-U+2069)
// and the interlinear-annotation trio (U+FFF9-U+FFFB, used to hide text
// between visible glyphs). U+061C and U+FFF9-U+FFFB EXTEND past the approved
// plan's mandated minimum (roadmap discussion point C6): both are BMP and
// length-safe (see CAP INVARIANCE below), squarely inside the stated
// bidi/hiding threat model, and already refused by this repo's sibling
// evidence-command character policy
// (__tests__/runtime-v2-evidence-character-allowlist.test.js:169's
// UNAUDITABLE_CATEGORY, which refuses the whole \p{Cf} class for the
// identical "invisible, so text becomes unauditable" reason).
//
// EXPLICIT CODE POINTS, NOT \p{C}/\p{Cf}. \p{Cf} would wrongly sweep up
// U+FEFF (BOM, an ordinary stream-start marker rather than a hiding
// technique) -- but the DECISIVE reason (discussion point C3) is CAP
// INVARIANCE: \p{Cf} also contains ASTRAL members (U+110BD, U+13430-U+13440,
// U+1BCA0-U+1BCA3, U+1D173-U+1D17A, U+E0001, U+E0020-U+E007F), each TWO
// UTF-16 units. Replacing a 2-unit match with the 1-unit REPLACEMENT_CHARACTER
// would SHORTEN the string and move the `max`-based slice boundary below --
// a length-changing "sanitizer" would reintroduce, one level up, exactly the
// kind of bug this fix exists to close. Every member of the set actually
// used here is BMP (max U+FFFB) and exactly one UTF-16 unit, matching
// REPLACEMENT_CHARACTER unit-for-unit, so a 1:1 replace can never move that
// boundary.
//
// REPLACE, never STRIP -- recorded here with the reasoning, per the ticket's
// deliverable:
//   - Stripping shortens the surrounding legitimate text with no trace;
//     replacing 1:1 with U+FFFD preserves both the position and the length
//     of everything around the neutralized byte (see CAP INVARIANCE).
//   - THE DECISIVE GROUND (discussion point C17): renderPlanArtifactEntry's
//     collision guard (isPlanArtifactMarkerShaped, below) neutralizes any
//     planner-derived entry that OPENS with the reserved brand
//     '[APE runtime]'. Under REPLACE, a planner value beginning
//     "ESC[APE runtime]..." renders as "U+FFFD[APE runtime]..." and still
//     does not open with the brand -- the guard is never triggered by a byte
//     this function itself introduces. Under STRIP that same input would be
//     PROMOTED into marker shape, wrongly caught by the guard, and wrapped
//     in the collision prefix: a SECOND, compounding byte change that
//     misrepresents a planner entry as the runtime's own omission marker.
//
// ORDER: replace -> flatten -> trim -> empty-to-null -> cap (the last four
// steps are unchanged from today). ORDER INVARIANCE holds: every member of
// this set is disjoint from JS `\s` at every boundary (U+200A|U+200B,
// U+202E|U+202F, U+205F|U+2060, U+009F|U+00A0 -- each exactly one code point
// apart), so replacing first can never change what the flatten step sees on
// input free of this set, and every existing caller's test stays green and
// unmodified.
//
// FIVE DISTINCT CHARACTER POLICIES COEXIST across this codebase -- four of
// them for agent-facing prose, enumerated here so a future reader -- and a
// future "single choke point" claim -- states the true count instead of
// rediscovering it (roadmap entry agent-facing-text-routes-bypassing-the-
// prose-bound: acme PR #397 asserted this helper was the ONE choke point every
// bounded agent-facing string flows through, and both the code reviewer and
// the conditional security reviewer of that entry independently proved the
// premise false). A comment that again under-enumerates this set reproduces
// the exact defect that entry exists to close -- keep the list current when
// any of the five changes:
//   1. BOUNDED_SUMMARY_CONTROL_CHARS (here, RENDER side) -- exact code
//      points, REPLACE with U+FFFD, includes U+200C/U+200D (ZWNJ/ZWJ).
//   2. SCOPE_EXPANSION_CONTROL_CHARS (below, ADMISSION side, and its
//      pipeline.js duplicate TEST_REMEDIATION_CONTROL_CHARS) -- the same
//      code points as policy 1, minus U+200C/U+200D. Deliberate siblings with
//      policy 1, never unify them (doing so starts refusing ZWNJ/ZWJ-bearing
//      paths valid today, or stops neutralizing them wherever policy 1
//      renders one later -- see the ONE-SIDED EXEMPTION residual below).
//   3. scheduler.js REVIEW_TEXT_FLATTEN (`/[\p{Cc}\p{Cf}\s]+/gu`) -- the
//      WHOLE Cc+Cf Unicode category, collapsed (not replaced) to a single
//      space, feeding review_findings. Broader and STRIP-shaped rather than
//      this file's explicit-range REPLACE. CORRECTED CLAIM (re-verified
//      against merged main at 69430ccd, scheduler.js IS claimed by this run):
//      attemptSummaryList (scheduler.js ~:78-85, feeding prior_attempts and
//      the block-reason diagnostic) now calls this SAME flattenReviewText
//      helper, not a bare `/\s+/` that neutralized no control/format
//      character -- the two routes in this module are consistent with each
//      other, not a fifth divergent one.
//   4. gates.js boundedTail -- ANSI/CSI plus C0/DEL only (no C1, no
//      bidi/format block), STRIPPED rather than replaced, feeding a gh output
//      tail into poll.pending.summary/poll.failed before either ever reaches
//      a boundedGateSummary call site below.
//   5. hooks.js WRITE_CONTENT_HAZARD_CHARS (the write-content byte gate) --
//      DELIBERATELY WIDER than policy 2, and NOT a duplicate of it (roadmap
//      entry authored-and-agent-facing-byte-integrity): it is not
//      agent-facing prose at all, but a gate on bytes entering TRACKED SOURCE
//      through a Write/Edit/MultiEdit/NotebookEdit/apply_patch payload, a
//      materially different threat model, so it is recorded here as its OWN
//      policy rather than filed under policy 2. Beyond policy 2's set it also
//      refuses U+2028/U+2029 (LINE/PARAGRAPH SEPARATOR, both ECMAScript
//      LineTerminators), U+FEFF (BOM, ECMAScript WhiteSpace), and the astral
//      TAGS block (U+E0001, U+E0020-U+E007F). Never re-sync it down to
//      policy 2's narrower set -- a maintainer who did would reopen the two
//      bypasses that widening closed. __tests__/runtime-v2-character-policy-
//      divergence.test.js pins this divergence against both the live exports
//      and the registry prose in this file and in pipeline.js.
//
// RESIDUALS RECORDED, NOT FIXED (roadmap discussion points C8/C9/C14, plus
// this entry's own follow-ons -- each asked to be recorded here, not closed):
//   - The `\s+` flatten below still carves out ordinary whitespace (newline,
//     NBSP) exactly as it always has; nothing here narrows that, so a claim
//     path or reason carrying one still lands verbatim wherever a caller
//     does not itself refuse it (e.g. the overrides.ndjson scope-expansion
//     audit line).
//   - ONE-SIDED EXEMPTION (policy 2 above): SCOPE_EXPANSION_CONTROL_CHARS
//     admits U+200C/U+200D whole, but this render-side set still maps them
//     to U+FFFD wherever the SAME path is later shown to an agent (e.g. an
//     inherited-base notice) -- a legitimately valid path admitted whole can
//     still be rendered mangled later. A new misrepresentation of VALID
//     input, left for a future ticket.
//   - extractScopeExpansion (below) and pipeline.js's extractTestRemediation
//     both now screen policy 2's admission set on their respective declared
//     paths; the test_writer `changed_files` route (feeding
//     state.test_paths at ~:3347, then ticketClaims above) needs no such
//     screen -- it is RUNTIME-DERIVED from a real git diff and stamped over
//     the agent-supplied value before either the receipt or state.test_paths
//     is touched (:3190/:3223 below), so it can never carry an injected byte
//     in the first place.
//   - Legacy/seeded state: bounding shipping_watch.last_checks_summary at its
//     assignment (poll_shipping action handler, below) covers only state
//     WRITTEN after this change. A pre-existing active.json persisted before
//     it still carries an unbounded summary, and scheduler.js's SHIP
//     rest-state refusal renders that persisted field verbatim (pinned at
//     __tests__/runtime-v2-rest-state-ship-self-disclosure.test.js:251,:451)
//     -- RE-CORRECTED CLAIM (review, this run): the prior text here ("scheduler.js
//     is claimed by later work — this file's abort_reason bind above") is not
//     evidence of anything: that bind lives in THIS file, below this comment,
//     and is not a scheduler.js change at all. The pinned test is not the
//     obstacle either — it pins CHECKS_SUMMARY, a short printable-ASCII literal
//     on which boundedGateSummary is provably identity, so binding at the
//     render site would not disturb it. The REAL obstacle is module structure:
//     boundedGateSummary is defined below and stays non-exported, and this
//     file already imports reduceRun from scheduler.js (see the import list at
//     the top of the file) — so scheduler.js's restStateGuidance importing it
//     back would create a cycle. Recorded, not closed, for THAT reason, not a
//     claim-set limit: scheduler.js IS claimed by this run.
export const BOUNDED_SUMMARY_CONTROL_CHARS = new RegExp(
  '[' +
    codePointRange(0x0000, 0x0008) +
    codePointRange(0x000e, 0x001f) +
    codePointRange(0x007f, 0x009f) +
    codePointRange(0x00ad, 0x00ad) +
    codePointRange(0x061c, 0x061c) +
    codePointRange(0x200b, 0x200f) +
    codePointRange(0x202a, 0x202e) +
    codePointRange(0x2060, 0x206f) +
    codePointRange(0xfff9, 0xfffb) +
  ']',
  'g',
);

// Bound a persisted gate-poll summary so the watch cursor never carries an
// unbounded blob (≤400): control/bidi-neutralized (see
// BOUNDED_SUMMARY_CONTROL_CHARS above), whitespace-flattened, hard-capped
// with an ellipsis.
export function boundedGateSummary(text, max = 400) {
  const neutralized = String(text ?? '').replace(BOUNDED_SUMMARY_CONTROL_CHARS, REPLACEMENT_CHARACTER);
  const flat = neutralized.replace(/\s+/g, ' ').trim();
  if (flat === '') return null;
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

export function checkoutCleanupIncomplete(state) {
  return (
    TERMINAL_STATUSES.has(state?.status) &&
    typeof state?.base_branch === 'string' &&
    state?.checkout_cleanup?.status !== 'returned'
  );
}

// A present-but-unparseable active.json is an in-session recovery condition,
// not a crash: tag the parse fault (code APE_CORRUPT_ACTIVE_STATE) with an
// actionable message naming the one lever that clears it — override reset — so
// every entry point below can react to the tag instead of leaking a bare
// SyntaxError before its reset/null-check arm (invariant 8, follow-up to #241).
function corruptStateError(file, parseError) {
  // Roadmap entry sink-guard-coverage-and-detection-completeness, ITEM 3:
  // modern V8 embeds a snippet of the OFFENDING INPUT BYTES (the malformed
  // active.json content) in a JSON.parse SyntaxError's own message, so this
  // text is not purely runtime-derived.
  //
  // BLOCKING (security-review, this run): an earlier version of this comment
  // claimed the thrown Error's own human-readable message (just below) is
  // "not a persisted or wire sink" -- that claim was FALSE. statusRun and
  // overrideRun catch APE_CORRUPT_ACTIVE_STATE and build their own wording
  // from error.parse_error, never from error.message -- but every OTHER entry
  // point (resumeRun, abortRun, regateRun, shipRun, expireDispatch, and
  // nextRun by way of resumeRun) does not special-case this code at all and
  // lets the thrown error propagate UNCAUGHT. bin/ape-mcp.mjs's generic
  // tool-fault handling then echoes a thrown error's .message VERBATIM onto
  // the wire (executeToolCall's isError tool result, createToolCallQueue's
  // -32603 frame) -- bypassing projection.js's bounding entirely. That IS a
  // wire sink. Fixed HERE instead of there (bin/ape-mcp.mjs is not claimed by
  // this run): the shared text is bounded ONCE, below, before either the
  // thrown message or error.parse_error embeds it, so it no longer matters
  // which consumer reaches it, caught or uncaught -- nothing downstream needs
  // its own bind.
  //
  // The fixed template wording around the parenthetical stays byte-stable
  // (pinned by the R1-R6/S1-S5/T16/W3 suites, every one of which matches by
  // substring, never the exact embedded snippet) -- only the parenthetical
  // itself is now routed through the same bound, and boundedGateSummary is
  // provably identity on an ordinary V8 SyntaxError message (short, printable
  // ASCII, no repeated internal whitespace), so no currently pinned message is
  // disturbed.
  const boundedParseError = boundedGateSummary(parseError.message);
  const error = /** @type {Error & { code: 'APE_CORRUPT_ACTIVE_STATE', file: string, parse_error: string, variant: 'unparseable' | 'schema-invalid' }} */ (new Error(
    `active run state at ${file} is unparseable (${boundedParseError}); no run operation can read it — recover with ape_run override operation reset (an audit reason is required), which quarantines the corrupt state and leaves the runtime startable`,
  ));
  error.code = 'APE_CORRUPT_ACTIVE_STATE';
  error.file = file;
  error.parse_error = boundedParseError;
  // The variant lets response-wording consumers (statusRun, overrideRun) name
  // the right cause without re-sniffing parse_error; the unparseable message
  // above stays byte-stable.
  error.variant = 'unparseable';
  return error;
}

// A parseable-but-schema-invalid active.json (valid JSON that is NOT a run
// state: a non-object like 42, an array, or an object with no string run_id
// like {}) reads cleanly, so it slips past the SyntaxError arm and drives the
// reducers into a misleading refusal instead of the honest corrupt-state path.
// Tag it with the SAME code and file as the unparseable arm so every consumer
// (statusRun diagnosis, next/resume/abort refusal, override reset quarantine)
// reacts identically, but with a distinct schema-invalid message and a
// synthetic parse_error — the unparseable message above stays byte-stable
// (pinned by the T16 suite).
function schemaInvalidStateError(file) {
  const parseError = 'schema-invalid: not a run state object';
  const error = /** @type {Error & { code: 'APE_CORRUPT_ACTIVE_STATE', file: string, parse_error: string, variant: 'unparseable' | 'schema-invalid' }} */ (new Error(
    `active run state at ${file} is schema-invalid (not a run state object carrying a string run_id); no run operation can read it — recover with ape_run override operation reset (an audit reason is required), which quarantines the corrupt state and leaves the runtime startable`,
  ));
  error.code = 'APE_CORRUPT_ACTIVE_STATE';
  error.file = file;
  error.parse_error = parseError;
  error.variant = 'schema-invalid';
  return error;
}

// The minimal run-state shape every reducer assumes: a plain object (not null,
// not an array) carrying a string run_id. A literal `null` payload is NOT a
// shape violation — it is the ENOENT-equivalent "no active run" sentinel and is
// checked before this guard runs.
function isRunStateShape(value) {
  const maxCollection = 256;
  const canonicalStages = new Set([
    'plan', 'plan-replan', 'preflight', 'plan-check', 'plan-critic', 'plan-judge',
    'test', 'test-reconcile', 'test-recheck', 'build', 'implement',
    'review', 'security-review', 'remediation-test', 'remediation-build',
    'remediation-review', 'remediation-security-review', 'gates', 'merge',
    'dispatch', 'start', 'complete', 'completed', 'aborted', 'debug', 'spike',
  ]);
  const canonicalRoles = new Set([
    'test_writer', 'implementer', 'reviewer', 'security_reviewer', 'planner',
    'preflight_analyst', 'plan_checker', 'plan_critic', 'plan_judge', 'debugger',
    'spike_researcher',
  ]);
  const safeIdentifier = (item) =>
    typeof item === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(item);
  const safeOptionalIdentifier = (item) => item === undefined || safeIdentifier(item);
  const objectArray = (items, validate) =>
    items === undefined || (
      Array.isArray(items) &&
      items.length <= maxCollection &&
      items.every((item) =>
        item && typeof item === 'object' && !Array.isArray(item) && validate(item))
    );
  const ticketArray = (items) => objectArray(items, (ticket) =>
    safeIdentifier(ticket.ticket_id) &&
    canonicalStages.has(ticket.stage_id) &&
    canonicalRoles.has(ticket.role) &&
    safeOptionalIdentifier(ticket.model_tier) &&
    (ticket.attempt === undefined || (Number.isInteger(ticket.attempt) && ticket.attempt > 0)) &&
    (ticket.deadline_at === undefined || strictIsoMs(ticket.deadline_at) !== null));
  const receiptArray = (items) => objectArray(items, (receipt) =>
    safeOptionalIdentifier(receipt.receipt_id) &&
    safeOptionalIdentifier(receipt.ticket_id) &&
    safeOptionalIdentifier(receipt.stage_id) &&
    safeOptionalIdentifier(receipt.role) &&
    RECEIPT_STATUSES.includes(receipt.status));
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    isCanonicalRunId(value.run_id) &&
    ticketArray(value.tickets) &&
    receiptArray(value.receipts) &&
    (value.expired_tickets === undefined || (
      Array.isArray(value.expired_tickets) &&
      value.expired_tickets.length <= maxCollection &&
      value.expired_tickets.every(safeIdentifier)
    ))
  );
}

export async function activeState(paths) {
  let state;
  try {
    state = await readJson(paths.active, null);
  } catch (error) {
    // readJson yields the fallback (null) on ENOENT and only rethrows on a
    // genuine read/parse fault. A JSON.parse SyntaxError means active.json
    // exists but is corrupt — re-tag it so status diagnoses, next/resume/abort
    // refuse actionably, and override reset quarantines, none of them throwing
    // a raw parse exception ahead of their own arms.
    if (error instanceof SyntaxError) throw corruptStateError(paths.active, error);
    throw error;
  }
  // null is "no active run" (ENOENT fallback or a literal `null` payload) — keep
  // its current semantics. A non-null value that is not a run state is
  // schema-invalid corruption: tag it identically to the unparseable arm so the
  // same consumers recover it (follow-up 2).
  if (state !== null && !isRunStateShape(state)) throw schemaInvalidStateError(paths.active);
  return state;
}

function pendingTicketIds(state) {
  const receipted = new Set((state?.receipts ?? []).map((receipt) => receipt.ticket_id));
  const expired = new Set(state?.expired_tickets ?? []);
  return (state?.tickets ?? [])
    .filter((ticket) => !receipted.has(ticket.ticket_id) && !expired.has(ticket.ticket_id))
    .map((ticket) => ticket.ticket_id);
}

function pendingTickets(state) {
  const ids = new Set(pendingTicketIds(state));
  return (state?.tickets ?? []).filter((ticket) => ids.has(ticket.ticket_id));
}

export async function dispatchLiveness(paths, state) {
  const pending = pendingTicketIds(state);
  const dispatches = state && ['claude', 'codex'].includes(state.host)
    ? await dispatchIntentStatuses(paths, state)
    : [];
  const lock = await inspectRunLock(paths.lock);
  const liveLock =
    lock.present === true &&
    lock.readable === true &&
    lock.stale !== true &&
    lock.run_id === state.run_id;
  if (pending.length === 0) {
    return {
      dispatch_state: 'none',
      dispatches,
      live_ticket_ids: new Set(),
      pending_ticket_ids: pending,
      live_lock: liveLock,
    };
  }
  const at = Date.now();
  const liveTicketIds = new Set(
    dispatches
      .filter((dispatch) =>
        dispatch.status === 'bound' &&
        dispatch.agent_state === 'active-bound' &&
        Number.isFinite(Date.parse(dispatch.expires_at ?? '')) &&
        Date.parse(dispatch.expires_at) > at)
      .map((dispatch) => dispatch.ticket_id),
  );
  // Both attestations are required. A pending ticket by itself, a live lock
  // with no bound native identity, or a bound identity whose owner lock died
  // is recovery work, not proof that execution is live.
  if (!liveLock) liveTicketIds.clear();
  return {
    dispatch_state:
      liveTicketIds.size === pending.length ? 'live' : 'needs-redispatch',
    dispatches,
    live_ticket_ids: liveTicketIds,
    pending_ticket_ids: pending,
    live_lock: liveLock,
  };
}

// A sealed terminal run is retained in active.json (truthful completion) but
// is not active: report it active:false and sealed:true so callers can tell a
// sealed run (run object present) from no run at all (run:null). Blocked runs
// stay active — they hold unresolved tickets and are not sealed.
export async function statusRun(projectDir) {
  const paths = runtimePaths(projectDir);
  let state;
  try {
    state = await activeState(paths);
  } catch (error) {
    // A corrupt active.json is a diagnosable condition, not a crash: report a
    // structured corrupt-state shape naming the recovery lever, rather than
    // throwing a bare parse exception (invariant 8). active:false with run:null
    // so a caller distinguishes it from both a live run and a sealed one.
    if (error?.code !== 'APE_CORRUPT_ACTIVE_STATE') throw error;
    // Variant-aware cause: a schema-invalid active.json parses fine, so it is
    // never "unparseable" — say so. The unparseable arm's reason stays
    // byte-stable (pinned by the T16 suite).
    return {
      ok: false,
      active: false,
      run: null,
      reason:
        error.variant === 'schema-invalid'
          ? 'active run state is schema-invalid (valid JSON but not a run state object carrying a string run_id); recover with ape_run override operation reset (an audit reason is required) to quarantine it and leave the runtime startable'
          // prose-bound-exempt: both ternary branches are fixed string literals
          // with no interpolation; the scanner's literal check does not
          // special-case a ternary of two literals.
          : 'active run state is corrupt and unparseable; recover with ape_run override operation reset (an audit reason is required) to quarantine it and leave the runtime startable',
      corrupt_state: {
        file: error.file,
        parse_error: error.parse_error,
        recovery: 'ape_run override operation reset',
      },
    };
  }
  const sealed = Boolean(state) && SEALED_STATUSES.has(state.status);
  const dispatch = state
    ? await dispatchLiveness(paths, state)
    : { dispatch_state: 'none', dispatches: [] };
  // RM5/RM7: attach the derived roadmap ONLY when roadmap.json exists (null →
  // absent → no key, byte-identical to today). A derivation fault degrades to a
  // structured corrupt marker on this read surface rather than throwing — the
  // mutating verbs are the ones that raise actionable errors.
  let roadmap;
  try {
    roadmap = await deriveRoadmap(paths);
  } catch (error) {
    // prose-bound-exempt: error.message here is this runtime's own
    // roadmap-derivation fault (e.g. a JSON parse error), never agent- or
    // attacker-controlled text.
    roadmap = { corrupt: true, reason: error.message };
  }
  let successorGuidance = null;
  if (state?.status === 'blocked') {
    try {
      successorGuidance = successorGuidanceForState(
        state,
        await loadRuntimeConfig(paths.config),
      );
    } catch {
      // Status remains available when the current config cannot be loaded;
      // without a verified current config hash, recovery guidance fails closed.
    }
  }
  return {
    ok: true,
    active: Boolean(state) && !sealed,
    run: state,
    ...(state ? { dispatch_state: dispatch.dispatch_state } : {}),
    ...(state && ['claude', 'codex'].includes(state.host)
      ? { dispatches: dispatch.dispatches }
      : {}),
    ...(sealed ? { sealed: true } : {}),
    ...(roadmap ? { roadmap } : {}),
    ...(successorGuidance ? { successor_guidance: successorGuidance } : {}),
  };
}

function derivedGateState(state) {
  return (
    state?.status === 'blocked' &&
    state?.stage === 'merge' &&
    state?.gates?.passed === true &&
    state?.block_reason === AUTO_MERGE_HOLD_REASON
  ) ? 'passed_awaiting_ship' : undefined;
}

function compactGate(state) {
  if (!state) return { state: 'inactive' };
  const derived = derivedGateState(state);
  if (derived) {
    return {
      state: derived,
      blocker: boundedGateSummary(state.block_reason),
    };
  }
  if (state.status === 'gating') return { state: 'running' };
  if (state.gates?.passed === true) return { state: 'passed' };
  if (state.gates?.passed === false) {
    return {
      state: 'failed',
      ...(state.block_reason ? { blocker: boundedGateSummary(state.block_reason) } : {}),
    };
  }
  if (state.status === 'blocked') {
    return {
      state: 'blocked',
      ...(state.block_reason ? { blocker: boundedGateSummary(state.block_reason) } : {}),
    };
  }
  return { state: 'not_run' };
}

function compactPending(state) {
  const pending = pendingTickets(state);
  if (pending.length === 0) return null;
  if (pending.length > 1) {
    return { ticket_ids: pending.map((ticket) => ticket.ticket_id).sort() };
  }
  const ticket = pending[0];
  return {
    ticket_id: ticket.ticket_id,
    stage_id: ticket.stage_id,
    role: ticket.role,
    attempt: ticket.attempt,
    deadline_at: ticket.deadline_at,
  };
}

function compactLastReceipt(state) {
  const receipt = state?.receipts?.at(-1);
  if (!receipt) return null;
  const ticket = (state.tickets ?? []).find((entry) => entry.ticket_id === receipt.ticket_id);
  const summary = boundedGateSummary(
    receipt.evidence?.summary ?? receipt.findings?.[0]?.message ?? receipt.status,
    240,
  );
  return {
    receipt_id: receipt.receipt_id,
    ticket_id: receipt.ticket_id,
    stage_id: ticket?.stage_id ?? null,
    status: receipt.status,
    // prose-bound-exempt: summary was passed through boundedGateSummary above.
    ...(summary ? { summary } : {}),
  };
}

function nextSafeAction(state, dispatchState) {
  if (checkoutCleanupIncomplete(state)) return 'ape_run resume';
  if (!state || SEALED_STATUSES.has(state.status)) return 'ape_run start';
  if (derivedGateState(state)) return 'ape_run ship';
  if (state.status === 'gating' || state.status === 'shipping') return 'ape_run next';
  if (state.status === 'blocked') {
    return state.gates?.passed === false ? 'ape_run regate' : 'ape_run override';
  }
  if (dispatchState === 'live') return 'wait for pending receipt';
  if (dispatchState === 'needs-redispatch') return 'ape_run resume';
  return 'ape_run next';
}

export function deriveRunFacts(state, options = {}) {
  if (!state || typeof state !== 'object') return null;
  const dispatchState =
    options.dispatchState ??
    state.dispatch_state ??
    (state.status === 'running' ? 'needs-redispatch' : 'none');

  const receiptedIds = new Set((state.receipts ?? []).map((r) => r.ticket_id));
  const expiredIds = new Set(state.expired_tickets ?? []);
  const tickets = Array.isArray(state.tickets) ? state.tickets : [];
  const pending = tickets.filter(
    (t) => !receiptedIds.has(t.ticket_id) && !expiredIds.has(t.ticket_id),
  );
  const activeTicket = pending[0] ?? tickets.at(-1) ?? null;

  const stage = activeTicket?.stage_id ?? state.stage ?? 'unknown';
  const activeRole = activeTicket?.role ?? state.stage ?? 'unknown';
  const modelTier = activeTicket?.model_tier ?? state.model_tier ?? 'balanced';

  // Retry facts
  const attempts = state.attempts ?? {};
  const currentStageAttempt = stage ? attempts[stage] : undefined;
  const rawLatestAttempt = activeTicket?.attempt ?? currentStageAttempt;
  const latestAttempt = Number.isInteger(rawLatestAttempt) && rawLatestAttempt > 0
    ? Math.min(rawLatestAttempt, 1_000_000)
    : 1;
  const retryCount = latestAttempt > 1 ? latestAttempt - 1 : 0;
  const retry = {
    attempt: latestAttempt,
    retry_count: retryCount,
  };

  // Expiration facts
  const expiredTicketList = Array.isArray(state.expired_tickets)
    ? state.expired_tickets.slice(0, 32).map((id) => boundedGateSummary(id, 128))
    : [];
  const expiry = {
    expired_count: Array.isArray(state.expired_tickets) ? state.expired_tickets.length : 0,
    expired_tickets: expiredTicketList,
  };

  // Remediation facts
  const hasRemediation = Boolean(
    state.remediation_route ||
    (typeof stage === 'string' && stage.startsWith('remediation')) ||
    (typeof state.remediation_cycles === 'number' && state.remediation_cycles > 0),
  );
  const remediation = {
    active: hasRemediation,
    route: state.remediation_route?.route ?? null,
    cycle: Number.isInteger(state.remediation_route?.cycle ?? state.remediation_cycles) &&
      (state.remediation_route?.cycle ?? state.remediation_cycles) >= 0
      ? Math.min(state.remediation_route?.cycle ?? state.remediation_cycles, 1_000_000)
      : 0,
    test_paths: Array.isArray(state.remediation_route?.test_paths)
      ? state.remediation_route.test_paths.slice(0, 32).map((p) => boundedGateSummary(p, 256))
      : [],
  };

  // Input hold facts
  const inputReq = state.input_required;
  const hasInputHold = Boolean(inputReq && inputReq.kind !== 'execution_budget');
  const questionIds = Array.isArray(inputReq?.question_ids)
    ? inputReq.question_ids
    : Array.isArray(inputReq?.questions)
      ? inputReq.questions.map((q) => q?.id).filter(Boolean)
      : [];
  const inputHold = {
    active: hasInputHold,
    preflight_hash: inputReq?.preflight_hash ? boundedGateSummary(inputReq.preflight_hash, 64) : null,
    question_count: questionIds.length,
    question_ids: questionIds.slice(0, 32).map((id) => boundedGateSummary(id, 128)),
  };

  // Scope facts
  const claimedPaths = Array.isArray(state.claimed_paths) ? state.claimed_paths : [];
  const testPaths = Array.isArray(state.test_paths) ? state.test_paths : [];
  const scope = {
    claimed_path_count: claimedPaths.length,
    test_path_count: testPaths.length,
  };

  // Profile facts
  const profiles = Array.isArray(state.preflight?.artifact?.verification_profiles)
    ? state.preflight.artifact.verification_profiles
    : Array.isArray(state.verification_profiles)
      ? state.verification_profiles
      : [];
  const requiredProfiles = profiles.filter(
    (p) => p?.disposition === 'required' || p?.required === true,
  );
  const profile = {
    required_profile_count: requiredProfiles.length,
    required_profile_ids: requiredProfiles.slice(0, 32).map((p) => boundedGateSummary(p.id, 64)),
  };

  // Timing facts
  const startMs = Date.parse(state.created_at ?? '');
  const endMs = Date.parse(state.terminal_at ?? state.completed_at ?? state.updated_at ?? '');
  let elapsedMs = 0;
  if (Number.isFinite(startMs)) {
    if (Number.isFinite(endMs) && endMs >= startMs) {
      elapsedMs = endMs - startMs;
    } else {
      elapsedMs = Math.max(0, Date.now() - startMs);
    }
  }
  const timing = {
    started_at: state.created_at ?? null,
    elapsed_ms: elapsedMs,
  };

  // Block facts
  const isBlocked = state.status === 'blocked';
  const block = {
    is_blocked: isBlocked,
    // prose-bound-exempt: block.reason is bounded by boundedGateSummary
    ...(state.block_reason ? { reason: boundedGateSummary(state.block_reason, 400) } : {}),
  };

  return {
    dispatch_state: dispatchState,
    model_tier: modelTier,
    stage,
    active_role: activeRole,
    retry,
    expiry,
    remediation,
    input_hold: inputHold,
    scope,
    profile,
    timing,
    block,
  };
}

// Dedicated read-only, bounded-by-construction status surface. The legacy
// ape_run/status response remains the full compatibility channel; this shape
// intentionally carries neither tickets/receipts nor roadmap entries.
export async function compactStatus(projectDir) {
  const paths = runtimePaths(projectDir);
  const status = /** @type {any} */ (await statusRun(projectDir));
  if (!status.ok) {
    const diagnostic = projectRunDiagnostic(null, { corrupt: true });
    return {
      ok: false,
      active: false,
      run: null,
      pending: null,
      dispatch_state: 'none',
      gate: { state: 'blocked' },
      last_receipt: null,
      next_action: { kind: 'blocked', automatic_successor: false },
      failure_domain: 'unknown',
      next_safe_action: diagnostic.next_safe_action,
      diagnostic,
    };
  }
  const state = status.run;
  const dispatchState = status.dispatch_state ?? 'none';
  const diagnostic = projectRunDiagnostic(state, { dispatchState });
  const corrupt = diagnostic.reason_code === 'corrupt_state';
  const gate = compactGate(state);
  const safeGate = gate && typeof gate === 'object' ? { state: gate.state } : gate;
  const lastReceipt = compactLastReceipt(state);
  const safeLastReceipt = !corrupt && lastReceipt
    ? {
        ...(lastReceipt.receipt_id ? { receipt_id: lastReceipt.receipt_id } : {}),
        ...(lastReceipt.ticket_id ? { ticket_id: lastReceipt.ticket_id } : {}),
        stage_id: lastReceipt.stage_id ?? null,
        status: lastReceipt.status,
      }
    : null;
  const facts = state && !corrupt ? deriveRunFacts(state, { dispatchState }) : null;
  const receiptRedispatch = state
    && !corrupt
    && state.status === 'running'
    && dispatchState === 'needs-redispatch'
    ? (status.dispatches ?? []).find((dispatch) =>
        dispatch?.status === 'expired'
        && dispatch?.agent_state === 'observed-stopped'
        && (state.receipt_contract_exhaustions?.[dispatch.ticket_id] ?? 0) === 1)
    : null;
  const nextAction = !state
    ? null
    : corrupt
      ? { kind: 'blocked', automatic_successor: false }
      : state.status === 'completed'
        ? null
        : state.status === 'input_required'
          ? state.input_required?.kind === 'receipt_retry'
            ? {
                kind: 'continue_same_agent',
                ticket_id: state.input_required.ticket_id,
                failure_domain: 'orchestration',
                required_control_action: 'record_exact_attested_receipt',
              }
            : { kind: state.input_required?.kind === 'execution_budget' ? 'wait' : 'answer_preflight' }
          : ['blocked', 'aborted'].includes(state.status)
            ? {
                kind: 'blocked',
                automatic_successor: false,
                ...(terminalReasonCode(state) === 'capability_blocked'
                  ? { required_operator_action: 'update_configuration_or_start_authorized_run' }
                  : {}),
              }
            : receiptRedispatch
              ? {
                  kind: 'redispatch_same_ticket',
                  ticket_id: receiptRedispatch.ticket_id,
                  failure_domain: 'orchestration',
                }
              : { kind: 'wait' };
  const failureDomain = receiptRedispatch
    ? 'orchestration'
    : state && ['blocked', 'aborted'].includes(state.status)
      ? terminalFailureDomain(state)
      : null;
  const safeFacts = facts
    ? {
        dispatch_state: facts.dispatch_state,
        model_tier: safeModelTier(facts.model_tier),
        stage: safeDiagnosticText(facts.stage, 64) ?? 'unknown',
        active_role: safeDiagnosticText(facts.active_role, 64) ?? 'unknown',
        retry: facts.retry,
        expiry: facts.expiry,
        remediation: facts.remediation
          ? {
              active: facts.remediation.active,
              route: safeDiagnosticText(facts.remediation.route, 64),
              cycle: facts.remediation.cycle,
              test_path_count: Array.isArray(facts.remediation.test_paths)
                ? facts.remediation.test_paths.length
                : 0,
            }
          : facts.remediation,
        input_hold: facts.input_hold,
        scope: facts.scope,
        profile: facts.profile,
        block: { is_blocked: facts.block?.is_blocked === true },
      }
    : null;
  const lineage = state && !corrupt && isCanonicalRunId(state.run_id)
    ? await logicalLineageForRun(paths, state.run_id, state)
    : null;
  const logicalLineage = lineage
    ? {
        version: 1,
        state: lineage.state,
        root_run_id: lineage.root_run_id,
        leaf_run_id: lineage.leaf_run_id,
        complete: lineage.complete,
      }
    : null;
  return {
    ok: true,
    active: status.active,
    dispatch_state: dispatchState,
    run: state && !corrupt
      ? {
          run_id: safeDiagnosticText(state.run_id, 128),
          status: safeDiagnosticText(state.status, 32),
          mode: safeDiagnosticText(state.mode, 32),
          lane: safeDiagnosticText(state.lane, 32),
          stage: safeDiagnosticText(state.stage, 64),
        }
      : null,
    pending: corrupt ? null : compactPending(state),
    gate: corrupt ? { state: safeGate?.state ?? 'blocked' } : safeGate,
    last_receipt: safeLastReceipt,
    ...(nextAction ? { next_action: nextAction } : {}),
    ...(failureDomain ? { failure_domain: failureDomain } : {}),
    next_safe_action: diagnostic.next_safe_action,
    diagnostic,
    ...(logicalLineage ? { logical_lineage: logicalLineage } : {}),
    ...(status.successor_guidance ? { successor_guidance: status.successor_guidance } : {}),
    ...(status.roadmap?.counts ? { roadmap: { counts: status.roadmap.counts } } : {}),
    ...(safeFacts ? { facts: safeFacts } : {}),
  };
}

const MANUAL_RETENTION_DEFAULT_KEEP_RECENT_RUNS = 32;

const MANUAL_RETENTION_DEFAULT_MAX_RUNS = 64;

const MANUAL_RETENTION_MAX_RUNS = 256;

const MANUAL_RETENTION_REASON_MAX_BYTES = 4_096;

function manualRetentionRequest(input) {
  const reason = typeof input?.reason === 'string' ? input.reason.trim() : '';
  if (reason.length === 0) {
    throw new Error('compact-artifacts requires a non-empty audit reason');
  }
  if (Buffer.byteLength(reason, 'utf8') > MANUAL_RETENTION_REASON_MAX_BYTES) {
    throw new Error(`compact-artifacts reason exceeds ${MANUAL_RETENTION_REASON_MAX_BYTES} UTF-8 bytes`);
  }
  const keepRecentRuns = input.keep_recent_runs ?? MANUAL_RETENTION_DEFAULT_KEEP_RECENT_RUNS;
  if (!Number.isInteger(keepRecentRuns) || keepRecentRuns < 0 || keepRecentRuns > 10_000) {
    throw new Error('keep_recent_runs must be an integer between 0 and 10000');
  }
  const maxRunsPerSweep = input.max_runs ?? MANUAL_RETENTION_DEFAULT_MAX_RUNS;
  if (
    !Number.isInteger(maxRunsPerSweep) ||
    maxRunsPerSweep < 1 ||
    maxRunsPerSweep > MANUAL_RETENTION_MAX_RUNS
  ) {
    throw new Error(`max_runs must be an integer between 1 and ${MANUAL_RETENTION_MAX_RUNS}`);
  }
  return {
    reason: boundedGateSummary(reason, MANUAL_RETENTION_REASON_MAX_BYTES),
    keepRecentRuns,
    maxRunsPerSweep,
  };
}

async function compactArtifactsOnDemand(paths, input) {
  const request = manualRetentionRequest(input);
  await appendJsonLine(paths.overrideLog, {
    operation: 'artifact-retention-maintenance',
    phase: 'requested',
    at: now(),
    reason: boundedGateSummary(request.reason, MANUAL_RETENTION_REASON_MAX_BYTES),
    keep_recent_runs: request.keepRecentRuns,
    max_runs: request.maxRunsPerSweep,
  });
  try {
    const result = await compactArchivedArtifacts(paths, {
      keepRecentRuns: request.keepRecentRuns,
      maxRunsPerSweep: request.maxRunsPerSweep,
    });
    const maintenance = await recordArtifactRetentionStatus(paths, {
      trigger: 'manual',
      result,
    });
    const warnings = [...maintenance.failures];
    if (maintenance.skipped) {
      warnings.push({
        code: 'RETENTION_SKIPPED',
        reason: boundedGateSummary(maintenance.skipped, 120),
      });
    }
    if (maintenance.candidate_limit_reached === true) {
      warnings.push({
        code: 'RETENTION_CANDIDATE_LIMIT',
        reason: 'candidate attempt limit reached; run compact-artifacts again to continue',
      });
    }
    await appendJsonLine(paths.overrideLog, {
      operation: 'artifact-retention-maintenance',
      phase: 'completed',
      at: now(),
      healthy: maintenance.healthy,
      compacted_runs: maintenance.compacted_runs,
      removed_files: maintenance.removed_files,
      retained_changed_files: maintenance.retained_changed_files,
      warning_count: warnings.length,
    });
    return { ok: true, maintenance, warnings };
  } catch (error) {
    const maintenance = await recordArtifactRetentionStatus(paths, {
      trigger: 'manual',
      error,
    });
    try {
      await appendJsonLine(paths.overrideLog, {
        operation: 'artifact-retention-maintenance',
        phase: 'failed',
        at: now(),
        failure: maintenance.failures[0],
      });
    } catch {
      // Preserve the original maintenance error if the supplemental audit
      // append also fails. Per-run planned/completed audits remain canonical.
    }
    throw error;
  }
}

export async function historyAction(projectDir, action, input = {}) {
  if (action === 'explain') {
    const descriptor = input && typeof input === 'object' && !Array.isArray(input)
      ? Object.getOwnPropertyDescriptor(input, 'run_id')
      : null;
    const runId = descriptor && 'value' in descriptor ? descriptor.value : descriptor?.get?.call(input);
    if (!isCanonicalRunId(runId)) {
      throw new Error('history explain requires a valid run_id');
    }
    input = { run_id: runId };
  }
  assertSafeInput({ action, input });
  const paths = runtimePaths(projectDir);
  if (action === 'query') return { ok: true, records: await queryHistory(paths, input) };
  if (action === 'explain') {
    const records = await queryHistory(paths, input);
    // A run recovered via re-gate/ship stores its completion as superseding
    // records BESIDE the immutable block-time record, and queryHistory returns
    // the primary first. Rendering records[0] told an auditor a merged run was
    // "blocked / Merge: not recorded" (invariant 8); both the text and the
    // returned record must be the effective record. Only same-run superseding
    // records participate — a requirement-scoped explain never collapses
    // across runs.
    const primary = records[0] ?? null;
    const superseding = records
      .slice(1)
      .filter((record) => record.run_id === primary?.run_id && record.supersedes);
    const effective = selectEffectiveRecord(primary, superseding);
    const validated = validatedArchiveSnapshot(effective);
    const inspected = validated?.snapshot ?? null;
    const diagnostic = projectRunDiagnostic(inspected, {
      archived: true,
      trustedSnapshot: true,
      archiveVerified: validated?.hashVerified === true,
    });
    const archivedDiagnostic = {
      ...diagnostic,
      terminal_reason_code: terminalReasonCode(inspected),
    };
    const logicalLineage = await logicalLineageForRun(paths, input.run_id);
    const recovered = logicalLineage?.complete === true &&
      logicalLineage.state === 'recovered';
    const incompleteLineage = logicalLineage?.complete === false;
    const lineageDiagnostic = recovered
      ? {
          ...archivedDiagnostic,
          logical_outcome: 'recovered',
          next_safe_action: 'ape_run start',
        }
      : incompleteLineage
        ? {
            ...archivedDiagnostic,
            logical_outcome: 'unknown',
            next_safe_action: 'inspect immutable history',
          }
        : archivedDiagnostic;
    const lineageText = recovered
      ? `\nLogical lineage: recovered by ${logicalLineage.leaf_run_id}.` +
        `\nImmutable run outcomes: ${logicalLineage.audit_outcomes.blocked} blocked, ` +
        `${logicalLineage.audit_outcomes.completed} completed.`
      : incompleteLineage
        ? `Logical lineage: unknown/incomplete (${logicalLineage.incomplete_reasons.join(', ')}).`
        : '';
    return {
      ok: true,
      text: incompleteLineage ? lineageText : `${explainRun(effective)}${lineageText}`,
      run: inspected && diagnostic.reason_code !== 'incomplete_record'
        ? {
            ...validatedVersionProvenance(inspected),
            run_id: boundedGateSummary(inspected.run_id, 128),
            status: boundedGateSummary(inspected.status, 64),
            lane: boundedGateSummary(inspected.lane, 32),
            mode: boundedGateSummary(inspected.mode, 32),
            terminal_reason_code: archivedDiagnostic.terminal_reason_code,
            ...projectTerminalRecovery(inspected),
          }
        : inspected && isCanonicalRunId(inspected.run_id)
          ? { run_id: inspected.run_id, status: 'unknown', lane: null, mode: null }
          : null,
      diagnostic: lineageDiagnostic,
      ...(logicalLineage ? { logical_lineage: logicalLineage } : {}),
    };
  }
  if (action === 'import') {
    // The importer read-modify-writes requirement-index.json and history/,
    // the same files archiveRun mutates under the receipt-effects lock; an
    // unlocked import racing a terminal-run archive silently drops the
    // archive's index update. Every index writer serializes on the same lock.
    return {
      ok: true,
      migration: await withStatusMutationLock(
        paths,
        () => importLegacyPlanning(paths.root, paths, input),
        { busyMessage: 'receipt effects are busy; retry the history import' },
      ),
    };
  }
  if (action === 'maintenance-status') {
    return { ok: true, maintenance: await readArtifactRetentionStatus(paths) };
  }
  if (action === 'compact-artifacts') {
    return withStatusMutationLock(
      paths,
      () => compactArtifactsOnDemand(paths, input),
      { busyMessage: 'receipt effects are busy; retry artifact compaction' },
    );
  }
  // RM5 cold-boot status surface: read-only, no lock, and never creates the
  // store — a roadmap-less project (RM7) reports roadmap: null.
  if (action === 'roadmap-status') {
    const roadmap = await deriveRoadmap(paths);
    if (roadmap && Array.isArray(input.status_filter) && input.status_filter.length > 0) {
      const allowed = new Set(input.status_filter);
      roadmap.entries = roadmap.entries.filter((e) => allowed.has(e.status));
    }
    return { ok: true, roadmap };
  }
  // RM1/RM6 register and RM3 supersede are audited store mutations: they
  // read-modify-write roadmap.json and append to overrides.ndjson, the same
  // files archiveRun/import touch, so they serialize on the receipt-effects lock
  // (verb-named busyMessage) like every other index writer.
  if (action === 'roadmap-register') {
    return withStatusMutationLock(
      paths,
      async () => {
        await registerEntries(paths, input);
        return { ok: true, roadmap: await deriveRoadmap(paths) };
      },
      { busyMessage: 'receipt effects are busy; retry the roadmap register' },
    );
  }
  if (action === 'roadmap-supersede') {
    return withStatusMutationLock(
      paths,
      async () => {
        await supersedeEntries(paths, input);
        return { ok: true, roadmap: await deriveRoadmap(paths) };
      },
      { busyMessage: 'receipt effects are busy; retry the roadmap supersede' },
    );
  }
  if (action === 'roadmap-attest') {
    return withStatusMutationLock(
      paths,
      async () => {
        await attestRequirements(paths, input);
        return { ok: true, roadmap: await deriveRoadmap(paths) };
      },
      { busyMessage: 'receipt effects are busy; retry the roadmap attest' },
    );
  }
  if (action === 'metrics') {
    return { ok: true, metrics: await calculateProjectMetrics(paths, input) };
  }
  throw new Error(`unknown history action: ${action}`);
}

// The shipped shape at a dotted config key, or undefined when the key names
// nothing in DEFAULT_CONFIG (an operator extension, or anything beneath an
// array — DEFAULT_CONFIG.runners ships empty, so per-runner command slots are
// deliberately NOT covered here). The non-object cursor check comes BEFORE the
// hasOwnProperty call on purpose: test_commands.full is null, so a naive third
// segment would throw. config.js's own walker is module-private, so this is a
// local read-only walk over the frozen defaults; nothing is exported.
function shippedShapeAt(key) {
  let cursor = DEFAULT_CONFIG;
  for (const segment of String(key).split('.')) {
    if (!cursor || typeof cursor !== 'object' || Array.isArray(cursor)) return undefined;
    if (!Object.prototype.hasOwnProperty.call(cursor, segment)) return undefined;
    cursor = cursor[segment];
  }
  return cursor;
}

// The MCP `value` field is loosely typed, and some clients deliver structured
// values as JSON strings (e.g. '{"model":"opus"}' instead of the object, or
// "6"/"false" for scalars). Stored verbatim, a stringified object corrupts the
// config. Coerce a string that parses as non-string JSON (object/array/number/
// boolean/null) into its real type — but KEY-AWARE, because the shipped shape
// knows better than the text does: a slot whose shipped shape is a string, or
// one of the `string|null` test_commands slots, takes the operator's text
// VERBATIM, so a legitimate test command of `true`/`false`/`42` stays settable
// instead of being coerced and then rejected as the wrong type. The literal
// 'null' still unsets a nullable slot (its documented unset form). A key absent
// from DEFAULT_CONFIG keeps the historical JSON coercion, and so does every
// non-string shape — including every security-relevant knob
// (shipping.auto_merge, shipping.required_remote_checks,
// policy.high_risk_security_review all ship booleans), which therefore cannot be
// set to a truthy string. The hasOwnProperty gate means a '__proto__' /
// 'constructor' / 'prototype' segment can only ever fall back to that same JSON
// coercion, with no pollution window. Known limitation: a string-typed leaf
// (shipping.provider, models.*.model, a role_models entry) set to the text
// 'null' or '6' now persists verbatim rather than coercing-then-rejecting.
function coerceConfigValue(value, key) {
  if (typeof value !== 'string') return value;
  const shape = key === undefined ? undefined : shippedShapeAt(key);
  if (typeof shape === 'string') return value;
  if (shape === null) return value === 'null' ? null : value;
  try {
    const parsed = JSON.parse(value);
    return typeof parsed === 'string' ? value : parsed;
  } catch {
    return value;
  }
}

const AGENTS_BEGIN = '<!-- BEGIN APE MANAGED MAIN-SESSION POLICY v1 -->';
const AGENTS_END = '<!-- END APE MANAGED MAIN-SESSION POLICY v1 -->';
const AGENTS_MANAGED_BLOCK = `${AGENTS_BEGIN}
## APE workflow

When the user explicitly invokes APE, use the installed APE workflow from the main session, inspect the active APE status before manual edits, and leave pipeline stage work to the workers bound by APE. Do not hand-edit \`.ape/runtime/\` or manually imitate a stage receipt.
${AGENTS_END}`;

async function proposeAgentsPolicy(projectDir) {
  const override = path.join(projectDir, 'AGENTS.override.md');
  const ordinary = path.join(projectDir, 'AGENTS.md');
  const overridePresent = await access(override).then(() => true, () => false);
  const ordinaryPresent = await access(ordinary).then(() => true, () => false);
  const target = overridePresent ? override : ordinary;
  const relativePath = overridePresent ? 'AGENTS.override.md' : 'AGENTS.md';
  const text = await readFile(target, 'utf8').catch((error) => {
    if (error?.code === 'ENOENT') return '';
    throw error;
  });
  const begin = text.includes(AGENTS_BEGIN);
  const end = text.includes(AGENTS_END);
  let status = 'proposed';
  if (begin && end && text.includes(AGENTS_MANAGED_BLOCK)) status = 'configured';
  else if (begin || end) status = 'conflict';
  else if (/\bAPE\b|\bape_(?:run|config|status)\b/.test(text)) status = 'human-managed';
  return {
    path: relativePath,
    source: overridePresent ? 'existing-override' : ordinaryPresent ? 'existing-agents' : 'new-agents',
    source_hash: sha256(text),
    status,
    apply_required: status === 'proposed',
    managed_block: AGENTS_MANAGED_BLOCK,
  };
}

async function applyAgentsPolicy(projectDir, expected) {
  expected = { ...expected, hash: expected.hash.toLowerCase() };
  // The proposal hash is a compare-and-swap token, not merely an early
  // advisory check. Serialize the final read/hash/replace as one critical
  // section so two init callers holding the same proposal cannot both report
  // that they applied it. The lock lives in APE runtime state rather than next
  // to AGENTS.md: an existing project root may intentionally be read-only,
  // while `.ape/runtime` is APE's owned coordination surface.
  const lockPath = path.join(projectDir, '.ape', 'runtime', 'agents-policy.lock');
  return withDirLock(
    lockPath,
    async () => {
      // Re-resolve precedence under the lock. Creating AGENTS.override.md
      // after proposal must move the target and fail this exact CAS rather
      // than allowing APE to update the now-shadowed AGENTS.md.
      const proposal = await proposeAgentsPolicy(projectDir);
      if (proposal.path !== expected.path) {
        throw new Error(`ape_config init: AGENTS target changed from ${expected.path} to ${proposal.path}; inspect a fresh proposal`);
      }
      if (proposal.source_hash !== expected.hash) {
        throw new Error('ape_config init: AGENTS source hash changed; inspect a fresh proposal before applying');
      }
      if (proposal.status === 'configured') {
        return { applied: false, already_configured: true, path: proposal.path };
      }
      if (proposal.status !== 'proposed') {
        throw new Error(`ape_config init: ${proposal.path} is ${proposal.status}; APE will not overwrite or merge that policy automatically`);
      }
      const target = path.join(projectDir, proposal.path);
      const before = await readFile(target, 'utf8').catch((error) => {
        if (error?.code === 'ENOENT') return '';
        throw error;
      });
      if (sha256(before) !== expected.hash) {
        throw new Error('ape_config init: AGENTS source changed during apply; no policy write was performed');
      }
      const metadata = await stat(target).catch((error) => {
        if (error?.code === 'ENOENT') return null;
        throw error;
      });
      const separator = before.length === 0 ? '' : before.endsWith('\n\n') ? '' : before.endsWith('\n') ? '\n' : '\n\n';
      await atomicReplaceText(target, `${before}${separator}${AGENTS_MANAGED_BLOCK}\n`, {
        mode: metadata ? metadata.mode & 0o777 : 0o644,
      });
      return { applied: true, path: proposal.path, source_hash: expected.hash };
    },
    {
      staleMs: 60_000,
      heartbeatMs: 15_000,
      busyMs: 15_000,
      serializeLocal: true,
      busyMessage: 'APE AGENTS policy application is busy; retry with a fresh proposal',
    },
  );
}

export async function configAction(projectDir, action, input = {}) {
  assertSafeInput({ action, input });
  const paths = runtimePaths(projectDir);
  if (action === 'get') return { ok: true, config: await loadRuntimeConfig(paths.config) };
  if (action === 'set') {
    if (!input.key) throw new Error('config set requires key');
    return {
      ok: true,
      config: await setRuntimeConfig(paths.config, input.key, coerceConfigValue(input.value, input.key)),
    };
  }
  if (action === 'doctor') {
    const report = await doctor(paths.root, input);
    const statusline = await statuslineState({ host: input.host ?? 'claude' }).catch(() => null);
    return { ok: true, doctor: report, statusline };
  }
  if (action === 'wire') {
    // Thread the WIRED PROJECT's runtime config into the statusline write so
    // the refresh cadence is config-driven (T12): load it the same way every
    // other configAction/service reader does, then hand wireStatusline the
    // resolved statusline.refresh_interval_seconds (undefined when unset → the
    // shipped default). configAction receives the project dir, so this resolves
    // against the project being wired, not the host's global settings.
    const config = await loadRuntimeConfig(paths.config);
    return {
      ok: true,
      statusline: await wireStatusline({
        host: input.host ?? 'claude',
        refreshIntervalSeconds: config.statusline?.refresh_interval_seconds,
      }),
    };
  }
  if (action === 'unwire') return { ok: true, statusline: await unwireStatusline({ host: input.host ?? 'claude' }) };
  if (action === 'init') {
    // Foreign-repo onboarding. `init` (no apply) deterministically inspects the
    // project and returns a grounded PROPOSAL with NO writes; `init` with
    // apply:true persists it through the existing config set/merge machinery
    // (explicit_keys provenance, sparse pruning, set-time validation) after
    // letting operator-supplied values override the proposal.
    const proposal = await proposeTestCommands(paths.root);
    proposal.proposal.agents = await proposeAgentsPolicy(paths.root);
    if (input.apply !== true) return { ok: true, init: proposal };

    // Build the effective value set: proposal values first, then operator
    // input.values wins. Whitelist every operator key to the five shipped
    // test_commands slots and reject an unknown key LOUDLY before any write.
    const whitelist = Object.keys(DEFAULT_CONFIG.test_commands);
    const effective = {};
    for (const [slot, entry] of Object.entries(proposal.proposal.test_commands)) {
      effective[slot] = entry.value;
    }
    const operatorValues =
      input.values && typeof input.values === 'object' && !Array.isArray(input.values) ? input.values : {};
    for (const [slot, rawValue] of Object.entries(operatorValues)) {
      if (!whitelist.includes(slot)) {
        throw new Error(
          `ape_config init: unknown test_commands slot '${slot}'; allowed slots are ${whitelist.join(', ')}`,
        );
      }
      // Same key-aware coercion as `set`, keyed exactly like the persist below,
      // so an operator's literal `true`/`42` test command survives this door too.
      effective[slot] = coerceConfigValue(rawValue, `test_commands.${slot}`);
    }

    // Polyglot runners (onboarding-runners-proposal): the proposal carries a
    // `runners` list only for a polyglot tree; an operator input.runners array
    // overrides it. A single-runner/non-polyglot tree leaves this empty, so the
    // whole runners path below is inert and this apply is byte-identical to today.
    const proposedRunners = Array.isArray(proposal.proposal.runners) ? proposal.proposal.runners : [];
    const effectiveRunners = Array.isArray(input.runners) ? input.runners : proposedRunners;
    const proposedEvidenceScripts = Array.isArray(proposal.proposal.evidence_scripts)
      ? proposal.proposal.evidence_scripts.map((entry) => entry.value)
      : [];
    if (input.evidence_scripts !== undefined && !Array.isArray(input.evidence_scripts)) {
      throw new Error('ape_config init: evidence_scripts must be an array selected from the current proposal');
    }
    const effectiveEvidenceScripts = Array.isArray(input.evidence_scripts) ? input.evidence_scripts : [];
    if (effectiveEvidenceScripts.some((entry) => !proposedEvidenceScripts.includes(entry))) {
      throw new Error('ape_config init: evidence_scripts must be selected from the current discovered proposal');
    }
    const applyAgents = input.apply_agents === true;
    if (applyAgents && (
      typeof input.agents_path !== 'string' ||
      typeof input.agents_expected_hash !== 'string' ||
      !/^[0-9a-fA-F]{64}$/.test(input.agents_expected_hash)
    )) {
      throw new Error('ape_config init: apply_agents requires agents_path and the proposal agents_expected_hash');
    }
    if (applyAgents) {
      const expectedHash = input.agents_expected_hash.toLowerCase();
      const currentAgents = await proposeAgentsPolicy(paths.root);
      if (currentAgents.path !== input.agents_path || currentAgents.source_hash !== expectedHash) {
        throw new Error('ape_config init: AGENTS target or source hash changed; inspect a fresh proposal before applying');
      }
      if (!['proposed', 'configured'].includes(currentAgents.status)) {
        throw new Error(`ape_config init: ${currentAgents.path} is ${currentAgents.status}; no config or policy write was performed`);
      }
    }

    // Refuse an empty effective set BEFORE any write — nothing was detected and
    // the operator supplied nothing to persist. A polyglot tree whose repo root
    // carries no manifest has an empty test_commands proposal but a non-empty
    // runners list, so the guard is relaxed to only refuse when BOTH are empty.
    const slots = whitelist.filter((slot) => slot in effective);
    if (slots.length === 0 && effectiveRunners.length === 0 && effectiveEvidenceScripts.length === 0 && !applyAgents) {
      throw new Error(
        'ape_config init: nothing to apply — no test commands were detected and no operator values were supplied. Run init without apply to inspect the proposal.',
      );
    }
    // PRE-VALIDATE every effective value as a string (or null) BEFORE the first
    // persist, so a type-invalid later slot cannot leave a partial persist.
    for (const slot of slots) {
      const value = effective[slot];
      if (value !== null && typeof value !== 'string') {
        throw new Error(
          `ape_config init: test_commands.${slot} must be a string or null; got ${JSON.stringify(value)}`,
        );
      }
    }
    // PRE-VALIDATE the effective runners list through the same set-time validator
    // (assertRunnersValue) BEFORE the first test_commands persist, so a malformed
    // operator override rejects loudly and can never leave a partial apply.
    assertRunnersValue('runners', effectiveRunners);
    // The persisted evidence list is additive, so validate the exact merged
    // value before AGENTS or any config slot is changed. Otherwise crossing the
    // catalog ceiling could fail only at the final set and leave a partial init.
    const mergedEvidenceScripts = effectiveEvidenceScripts.length > 0
      ? [...new Set([
          ...((await loadRuntimeConfig(paths.config)).policy?.evidence_scripts ?? []),
          ...effectiveEvidenceScripts,
        ])]
      : [];
    if (mergedEvidenceScripts.length > 0) {
      assertEvidenceScriptsValue('policy.evidence_scripts', mergedEvidenceScripts);
    }
    // Apply the independently hash-bound AGENTS proposal before the first
    // config-store mutation. A stale target, changed precedence, lock failure,
    // or atomic replacement failure therefore leaves config.json byte-for-byte
    // unchanged. All config values above have already passed their complete
    // validation before this external-file CAS is attempted.
    const agents = applyAgents
      ? await applyAgentsPolicy(paths.root, {
          path: input.agents_path,
          hash: input.agents_expected_hash,
        })
      : null;
    // Persist each slot through setRuntimeConfig (inherits validation, sparse
    // pruning, explicit_keys provenance, and the serialized config-store
    // read-modify-write — audit 1.10, invariant 7 — so a concurrent
    // `ape_config set` racing this loop is queued, never silently dropped),
    // in stable slot order.
    let config;
    const applied = [];
    for (const slot of slots) {
      config = await setRuntimeConfig(paths.config, `test_commands.${slot}`, effective[slot]);
      applied.push(`test_commands.${slot}`);
    }
    // Persist the polyglot runners list as a single whole-list set, routing
    // through assertValueMatchesDefaults -> assertRunnersValue with explicit_keys
    // provenance. Recorded in applied_keys ONLY when non-empty, so a single-runner
    // apply response stays byte-identical.
    if (effectiveRunners.length > 0) {
      config = await setRuntimeConfig(paths.config, 'runners', effectiveRunners);
      applied.push('runners');
    }
    if (effectiveEvidenceScripts.length > 0) {
      config = await setRuntimeConfig(
        paths.config,
        'policy.evidence_scripts',
        mergedEvidenceScripts,
      );
      applied.push('policy.evidence_scripts');
    }
    return {
      ok: true,
      init: {
        applied: true,
        applied_keys: applied,
        config: config ?? await loadRuntimeConfig(paths.config),
        ...(agents ? { agents } : {}),
      },
    };
  }
  throw new Error(`unknown config action: ${action}`);
}
