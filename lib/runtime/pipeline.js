import { MAX_STAGE_ATTEMPTS, ROLE_POLICIES } from './constants.js';
import { pipelineLimits, remediationCycleLimit, stageRecoveryLimits } from './pipeline-limits.js';
export { MAX_DIRECTED_REPLANS, pipelineLimits, remediationCycleLimit } from './pipeline-limits.js';
import { normalizeClaimPath, withinTestScope } from './path-scope.js';
import { RECEIPT_INPUT_SCHEMA } from './receipt-input.js';
import {
  REVIEW_CONTRACT_VERSION,
  STRUCTURED_REVIEW_OUTPUT_SCHEMA,
} from './schemas.js';

// Admission, doctor, and preview must project the same persisted run shape.
// Public adapters choose a plan version; omission preserves the legacy path.
export function pipelineRunSpec(input, classification, config) {
  return {
    mode: input.mode,
    lane: classification.lane,
    behavioral: input.behavioral,
    test_intent: input.test_intent,
    high_risk: (classification.risk_triggers ?? []).length > 0,
    plan_contract_version: input.plan_contract_version,
    policy: {
      high_risk_security_review: config.policy?.high_risk_security_review !== false,
      design_assurance_required: config.policy?.design_assurance_required !== false,
      max_remediation_cycles: remediationCycleLimit({ policy: config.policy }),
    },
    remediation_cycles: 0,
    test_paths: input.test_paths,
    claimed_paths: input.claimed_paths,
  };
}

// Security review arms on the run's persisted policy snapshot (threaded in at
// run start), never on live config reads: the reducer and this pipeline stay
// pure and a mid-run config edit cannot silently disarm an armed audit.
function securityReviewArmed(run) {
  return run.high_risk === true && run.policy?.high_risk_security_review !== false;
}

function stage(id, role, options = {}) {
  const policy = ROLE_POLICIES[role];
  const structuredReview = role === 'reviewer' || role === 'security_reviewer';
  return Object.freeze({
    id,
    role,
    model_tier: options.model_tier ?? policy.model_tier,
    writable: options.writable ?? policy.writable,
    parallel_group: options.parallel_group ?? null,
    required_checks: options.required_checks ?? [],
    output_schema: options.output_schema
      ?? (structuredReview ? STRUCTURED_REVIEW_OUTPUT_SCHEMA : RECEIPT_INPUT_SCHEMA),
    ...(structuredReview ? { review_contract_version: REVIEW_CONTRACT_VERSION } : {}),
  });
}

// A mechanical run whose entire claim set is documentation has no runtime
// surface for targeted tests to exercise; demanding that evidence anyway can
// only be satisfied by test theater (collect-only pytest runs attesting a
// markdown edit), which corrodes truthful evidence worse than no stage check.
// The carve-out is deliberately narrow: non-behavioral, no test paths, and
// EVERY claim file-shaped with a documentation extension — a directory claim
// could hold anything, so it keeps the check. The deterministic full-suite
// merge gates still run before auto-merge either way; dropping the stage
// check removes agent-attested theater, not the runtime-executed backstop.
const DOC_EXTENSIONS = /\.(md|markdown|mdx|txt|rst|adoc|asciidoc)$/i;
export function docsOnlyMechanical(run) {
  return (
    run.lane === 'mechanical' &&
    run.behavioral === false &&
    (run.test_paths?.length ?? 0) === 0 &&
    (run.claimed_paths?.length ?? 0) > 0 &&
    run.claimed_paths.every((claim) => DOC_EXTENSIONS.test(claim))
  );
}

function mechanicalBuildChecks(run) {
  return docsOnlyMechanical(run) ? [] : ['targeted-tests'];
}

function phaseBuildChecks(run) {
  return (run.test_paths?.length ?? 0) > 0 ? ['targeted-tests'] : [];
}

function primaryTestCheck(run) {
  return run.test_intent === 'green-maintenance' ? 'green-test' : 'red-test';
}

function primaryTestStage(run, id = 'test') {
  return stage(id, 'test_writer', { required_checks: [primaryTestCheck(run)] });
}

// Green maintenance may be a genuinely test-only change. In that shape the
// independent test writer owns every authorized write and there is no honest
// production task for an implementer to perform. Red-first and non-behavioral
// flows preserve their historical build stage; a green-maintenance run that
// explicitly carries production claims still receives one too.
function primaryBuildNeeded(run) {
  return run.test_intent !== 'green-maintenance' || (run.claimed_paths?.length ?? 0) > 0;
}

function primaryReviewStage(run, { afterBuild = false } = {}) {
  return stage('review', 'reviewer', {
    parallel_group: 'code-review',
    required_checks: afterBuild && run.lane === 'full' ? [] : phaseBuildChecks(run),
  });
}

function primaryReviewStages(run, options = {}) {
  const stages = [primaryReviewStage(run, options)];
  if (securityReviewArmed(run)) {
    stages.push(stage('security-review', 'security_reviewer', { parallel_group: 'code-review' }));
  }
  return stages;
}

function projectedReviewStage(run, projectedLane) {
  const options = { afterBuild: primaryBuildNeeded(run) };
  const projected = primaryReviewStage({ ...run, lane: projectedLane }, options);
  const candidates = [projected.required_checks];
  if (run.lane === 'fast' && projectedLane === 'full') {
    candidates.push(primaryReviewStage(run, options).required_checks);
  }
  const variants = [...new Map(candidates.map((checks) => [JSON.stringify(checks), checks])).values()];
  if (variants.length === 1) return projected;
  // Admission must support every reachable check, while a real ticket keeps
  // the exact check set for its observed preflight/lane branch.
  return Object.freeze({
    ...projected,
    required_checks: Object.freeze([...new Set(variants.flat())]),
    required_check_variants: Object.freeze(variants.map((checks) => Object.freeze([...checks]))),
  });
}

export function initialStages(run) {
  if (run.mode === 'debug') return [stage('debug', 'debugger')];
  if (run.mode === 'spike') return [stage('spike', 'spike_researcher')];
  if (run.mode === 'land') {
    // Gate-and-land (friction #32): the finished diff was validated and sealed
    // at start, so the pipeline is the review machinery plus the merge gates —
    // never a test-writer or implementer. A blocking review outcome takes the
    // standard 'review-disagreed' remediation proposal in nextStages, which
    // the service converts into an honest block: remediation needs a writing
    // stage and this mode has none.
    const stages = [stage('review', 'reviewer', { parallel_group: 'code-review' })];
    if (securityReviewArmed(run)) {
      stages.push(stage('security-review', 'security_reviewer', { parallel_group: 'code-review' }));
    }
    return stages;
  }
  if (run.lane === 'mechanical') {
    return [stage('build', 'implementer', { required_checks: mechanicalBuildChecks(run) })];
  }
  if (
    run.plan_contract_version === 2 &&
    run.mode === 'phase' &&
    run.behavioral === true &&
    (run.lane === 'full' || run.lane === 'fast')
  ) {
    return [stage('preflight', 'preflight_analyst')];
  }
  if (run.lane === 'fast') {
    if (run.behavioral === false) {
      return [stage('build', 'implementer', { required_checks: phaseBuildChecks(run) })];
    }
    return [primaryTestStage(run)];
  }
  return [stage('plan', 'planner')];
}

// Roadmap entry remediation-test-path-role-gap, proven live by
// run-fixture-0d6308c75933 (archived blocked): a blocking review finding
// located in an AUTHORED TEST path could not be remediated at all. The
// review-disagreed arm below hardcoded an implementer stage, the write-time
// hook denies every implementer write to a test-shaped path (hooks.js:587) and
// the receipt validator rejects such a receipt (receipt-validator.js:149-151),
// so that run spent its one remediation cycle and blocked with a zero-risk
// comment-only correction unlanded; acme PR #359 landed it through a separate land
// run — a workaround, not a fix.
//
// The channel is `evidence.test_remediation { test_paths, reason }` on a
// BLOCKING review receipt — the exact structural sibling of
// `evidence.scope_expansion` (service.js extractScopeExpansion), validated at
// the same PRE-DURABLE rejection site so a refusal leaves no receipt, no
// transaction and no audit line and the same review ticket stays recordable.
// No boundary is relaxed anywhere: the editing role stays the test_writer under
// test-writer confinement, and the routing authority is the READ-ONLY reviewer
// (a writing role is refused below, so no writer can summon a test-editing
// stage for itself).
//
// This extractor is the ONE predicate both layers share: service.js imports it
// to refuse a malformed or out-of-contract declaration at record time, and the
// routing scan below re-reads the persisted receipts with it, so an accepted
// declaration and a routed stage can never disagree. It is deliberately a NEW
// function rather than a generalization of extractScopeExpansion: nine of that
// function's error strings are regex-pinned at
// __tests__/runtime-v2-scope-expansion.test.js:229-237, an UNCLAIMED file, so
// ~20 duplicated lines are cheaper than a byte risk this change cannot repair.
//
// RESIDUAL, recorded rather than hidden: a reviewer who simply OMITS the
// declaration gets today's behavior and the finding lands unremediated exactly
// as before. This design makes the correct action available and documents it in
// both review prompts; it does not eliminate that case. Unconditional routing
// would, and is rejected on the merits — and is literally unlandable here: it
// turns __tests__/runtime-v2-scope-expansion.test.js:208-209 red, and that file
// is unclaimed.
const TEST_REMEDIATION_REVIEW_ROLES = new Set(['reviewer', 'security_reviewer']);
// Mirrors groupOutcome's positive set (scheduler.js): a declaration is admitted
// only from a receipt that will actually vote disagree and open remediation.
const POSITIVE_REVIEW_VERDICTS = new Set(['agree', 'pass', 'passed']);
// The FIRST code-review group only. A remediation-* review cannot buy a second
// test stage: MAX_REMEDIATION_CYCLES is 1, so the scheduler blocks before
// nextStages is consulted again (invariant 5), and restricting the scan keeps
// that true by construction rather than by arithmetic.
const FIRST_CODE_REVIEW_STAGES = new Set(['review', 'security-review']);

// Truthful completion (invariant 8), same predicate as groupOutcome: a
// non-passed receipt always votes disagree, and a stray positive verdict string
// inside failed evidence must not count as agreement.
function votesDisagree(receipt) {
  return (
    String(receipt?.status).toLowerCase() !== 'passed' ||
    !POSITIVE_REVIEW_VERDICTS.has(String(receipt?.evidence?.verdict ?? receipt?.status).toLowerCase())
  );
}

// Roadmap entry agent-facing-text-routes-bypassing-the-prose-bound, route
// (a). extractTestRemediation is the declared structural sibling of
// extractScopeExpansion (receipt-validator.js) named throughout this file's comments,
// yet — unlike it — screened no character set on a reviewer's declared
// test_paths: withinTestScope (path-scope.js:81-91) widens a file-shaped
// claim to its directory, so a control/bidi-bearing variant of an in-scope
// authored test name passed every check below and landed its raw bytes on a
// bound test_writer subagent's own remediation-test ticket (claimed_paths and
// test_paths, both derived from this function's output by service.js
// narrowedTestClaims/issueTicket).
//
// SAME ADMISSION SET AND METHOD as receipt-validator.js's scope-expansion
// character policy (policy 2 of the FIVE policies enumerated by receipt-service.js):
// exact code points (never \p{Cf}, for the identical CAP-INVARIANCE reasoning
// recorded there), built from NUMERIC code points only (never a literal byte
// or a `\u` escape in this file's own text, per the roadmap entry's authoring
// hazard), and the SAME one-sided exemption of U+200C/U+200D (ZWNJ/ZWJ) from
// the U+200B-U+200F run, so a legitimately named Persian/Indic joining
// sequence is admitted here too.
//
// DUPLICATED, not imported, and the drift risk is recorded rather than
// hidden: receipt-validator.js imports pipeline.js's role requirements, so the
// reverse edge would cycle. This ~15-line numeric charset is therefore a
// second copy of receipt-validator.js's scope-expansion admission set
// (character policy 2 of the FIVE enumerated by receipt-service.js). A future change to one
// admission set will not automatically reach the other, so the two must be
// updated together by hand. lib/runtime/write-policy.js's WRITE_CONTENT_HAZARD_CHARS
// (policy 5 there) -- DELIBERATELY WIDER than this pair, and NOT a third
// copy of it despite starting from the same base set: it is recorded as its
// own policy because it gates bytes entering executable source rather than
// operator-facing prose, refusing four extra ranges this pair does not (see
// write-policy.js's own comment). Never re-sync write-policy.js's copy down to match this
// pair's narrower set.
//
// NON-GLOBAL, deliberately: driven only through `.test()` below, in a loop,
// across possibly many declared paths — a `/g` regex carries `lastIndex`
// across calls and would alternate accept/refuse on IDENTICAL input (the same
// hazard service.js:2827-2831 records for its own admission-side regex).
function testRemediationControlCharsPattern() {
  const codePoint = (value) => String.fromCharCode(value);
  const range = (from, to) => (to > from ? `${codePoint(from)}-${codePoint(to)}` : codePoint(from));
  const parts = [
    range(0x0000, 0x0008),
    range(0x000e, 0x001f),
    range(0x007f, 0x009f),
    range(0x00ad, 0x00ad),
    range(0x061c, 0x061c),
    // U+200B-U+200F MINUS the U+200C/U+200D exemption: U+200B alone, then
    // U+200E-U+200F, skipping the two ZWNJ/ZWJ code points in between.
    range(0x200b, 0x200b),
    range(0x200e, 0x200f),
    range(0x202a, 0x202e),
    range(0x2060, 0x206f),
    range(0xfff9, 0xfffb),
  ];
  return `[${parts.join('')}]`;
}
const TEST_REMEDIATION_CONTROL_CHARS = new RegExp(testRemediationControlCharsPattern());

// SELF-REFERENTIAL DEFECT, CLOSED (roadmap entry
// agent-facing-text-routes-bypassing-the-prose-bound, review + security
// review): every message in extractTestRemediation's loop below used to
// interpolate `entry` raw -- including the control-character refusal itself,
// which is GUARANTEED to carry the exact byte it refuses (it fires only once
// TEST_REMEDIATION_CONTROL_CHARS has matched), and the non-string/blank-entry
// message (a raw, unbounded JSON.stringify: an object whose own string
// values carried bidi/DEL bytes reached the wire verbatim, with no length
// cap -- assertSafeInput admits 64 KB per field and nothing on this path
// bounded it) -- so a reviewer-supplied bidi override reached the operator's
// terminal in the very message refusing that byte. This is the RENDER-side
// counterpart of TEST_REMEDIATION_CONTROL_CHARS above: it reuses the
// IDENTICAL code points (so whichever byte tripped the admission `.test()`
// above is guaranteed covered by this `.replace()` too), with a `g` flag
// added ONLY for `.replace()` -- never `.test()` -- so the lastIndex hazard
// documented above never applies to it (String.prototype.replace resets a
// global regex's lastIndex to 0 before it scans, per spec, regardless of
// prior state). Mirrors service.js's extractScopeExpansion `shown`
// (boundedGateSummary, 200-char cap -- the same cap testRemediationNotice
// and EXPIRED_PREDECESSOR_PATH_MAX_CHARS use for this class of text,
// plan-critic C6, not a third unexplained number); pipeline.js cannot import
// boundedGateSummary itself (the acyclicity note above), so this is that
// helper's local equivalent, scoped to this function's own error rendering.
const TEST_REMEDIATION_RENDER_CHARS = new RegExp(testRemediationControlCharsPattern(), 'g');
const TEST_REMEDIATION_REPLACEMENT_CHARACTER = String.fromCharCode(0xfffd);
function renderTestRemediationEntry(value) {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  const neutralized = text.replace(TEST_REMEDIATION_RENDER_CHARS, TEST_REMEDIATION_REPLACEMENT_CHARACTER);
  const flat = neutralized.replace(/\s+/g, ' ').trim();
  if (flat === '') return '';
  return flat.length > 200 ? `${flat.slice(0, 199)}…` : flat;
}

// Admission is strict and loud — every malformed or out-of-contract declaration
// rejects the receipt naming the offending field or path — because a silently
// dropped declaration recreates exactly the unfixable-by-design remediation
// this channel exists to kill. Absence is NOT malformation: an absent or null
// value declares nothing and returns cleanly (mirrors extractScopeExpansion).
//
// The result shape is declared explicitly because the early returns would
// otherwise infer an unreduced union and every caller-side read of the
// analysis fields fails to typecheck (precedent: receipt-validator.js:29-45).
/**
 * @returns {{ errors: string[], test_paths: string[], reason: string|null }}
 */
export function extractTestRemediation(ticket, receipt) {
  const raw = receipt?.evidence?.test_remediation;
  // null declares nothing, so it is absence, not a malformed declaration.
  if (raw === undefined || raw === null) return { errors: [], test_paths: [], reason: null };
  const errors = [];
  if (!TEST_REMEDIATION_REVIEW_ROLES.has(ticket?.role)) {
    return {
      errors: [
        `evidence.test_remediation is a review-receipt channel (reviewer or security_reviewer); a ${ticket?.role} receipt may not summon a test-editing stage for itself`,
      ],
      test_paths: [],
      reason: null,
    };
  }
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    return {
      errors: ['evidence.test_remediation must be an object: { test_paths: [..], reason: ".." }'],
      test_paths: [],
      reason: null,
    };
  }
  // An agreeing review has no blocking finding for the correction to answer, so
  // accepting its declaration would open a writing stage with nothing to fix.
  // The reviewer signals "the fix belongs in these tests" WITH the blocking verdict.
  if (!votesDisagree(receipt)) {
    errors.push('test remediation requires a blocking review verdict: record the finding with evidence.verdict fail alongside the declared test paths');
  }
  if (typeof raw.reason !== 'string' || raw.reason.trim() === '') {
    errors.push('test remediation requires a non-empty evidence.test_remediation.reason naming why the correction belongs in the authored test');
  }
  const declared = [];
  if (!Array.isArray(raw.test_paths) || raw.test_paths.length === 0) {
    errors.push('test remediation requires evidence.test_remediation.test_paths: a non-empty array of project-relative authored test paths');
  } else {
    for (const entry of raw.test_paths) {
      // shown: ONE bounded, neutralized rendering of `entry`, used by EVERY
      // message in this loop (see renderTestRemediationEntry above for why).
      const shown = renderTestRemediationEntry(entry);
      if (typeof entry !== 'string' || entry.trim() === '') {
        errors.push(`test_remediation.test_paths entries must be non-empty strings, got ${shown}`);
        continue;
      }
      // INSERTION POINT mirrors extractScopeExpansion's (service.js,
      // discussion point C11): right after the non-empty-string check and
      // BEFORE every path-STRUCTURE predicate below. A control/bidi/format
      // byte is a CHARACTER-level defect, prior to and independent of
      // whatever the path's segments spell, so a doubly-invalid declaration
      // reports THIS refusal first. Tested on the raw `entry`, since none of
      // these code points is touched by the backslash-to-slash normalization
      // one line below.
      if (TEST_REMEDIATION_CONTROL_CHARS.test(entry)) {
        errors.push(`test_remediation path may not contain a control, DEL/C1, or bidi/format character: ${shown}`);
        continue;
      }
      const slashed = entry.replaceAll('\\', '/');
      if (slashed.startsWith('/') || /^[A-Za-z]:/.test(slashed)) {
        errors.push(`test_remediation path must be relative to the project root: ${shown}`);
        continue;
      }
      if (slashed.split('/').includes('..')) {
        errors.push(`test_remediation path may not contain '..' segments: ${shown}`);
        continue;
      }
      const normalized = normalizeClaimPath(slashed);
      if (normalized === '' || normalized === '.') {
        errors.push(`test_remediation path is empty after normalization: ${shown}`);
        continue;
      }
      if (normalized === '.ape' || normalized.startsWith('.ape/')) {
        errors.push(`test_remediation may not claim APE runtime state: ${shown}`);
        continue;
      }
      // J1d: containment is checked with the SAME predicate the write layer
      // applies (hooks.js:584 and receipt-validator.js:136 both call
      // withinTestScope against the ticket's test_paths), so an accepted
      // declaration is exactly what the runtime can honor — never a narrowed
      // ticket whose own writes would be hook-denied. The declaration therefore
      // never GROWS the authored-test claim set; it only points inside it. A run
      // with empty test_paths rejects every declaration and keeps today's
      // behavior. Confinement is only "the declared paths widened to their
      // DIRECTORIES": withinTestScope's file-shaped widening
      // (path-scope.js:81-91) is pinned deliberate at
      // runtime-v2-test-scope-directory-widening.test.js:47-49, so a
      // same-directory sibling stays writable — a recorded residual, not
      // confinement. Its corollary, recorded rather than hidden: a
      // DIRECTORY-shaped declaration ('tests') is admitted when it is exactly a
      // file-shaped claim's parent, and then narrows nothing — the resulting
      // ticket carries the same directory the un-narrowed ticket already
      // widened to. Not an escalation (a directory that is NOT such a parent is
      // refused, so the scope can never exceed the run's own test claims), just
      // a declaration that buys no narrowing.
      if (!withinTestScope(normalized, ticket?.test_paths ?? [])) {
        errors.push(`test_remediation path ${shown} is outside the run's authored test paths: declare a path inside test_paths (a file-shaped claim covers its directory); the declaration may not grow the test claim set`);
        continue;
      }
      declared.push(normalized);
    }
  }
  // prose-bound-exempt: raw.reason is validated as a non-empty string above (or
  // this call's own errors[] carries the malformed-declaration refusal); its
  // only consumer, service.js testRemediationNotice (service.js:378), passes
  // it through boundedGateSummary(declaration.reason, 200) before it reaches
  // the remediation-test ticket -- a downstream reuse, not a new sink.
  return { errors, test_paths: [...new Set(declared)], reason: raw.reason ?? null };
}

// The routing input, unioned over the WHOLE first code-review group rather than
// read off the single receipt nextStages is handed — that receipt is only the
// LAST one to arrive, so a reviewer who disagreed FIRST with a declaration and
// an agreeing security review landing SECOND would silently lose the
// declaration. The group's receipts are readable here because service.js:2563
// threads next_state as the same object whose receipts were pushed at
// service.js:2372, so no scheduler.js change is needed.
//
// Also the narrowing input: service.js issueTicket derives the remediation-test
// ticket's claimed_paths and test_paths from THIS function over RUN STATE, not
// from the frozen stage object — stageFromTicket rebuilds a stage from schema
// fields only (scheduler.js:46-56, service.js:226-236), so a stage-carried
// narrowing would silently re-widen on the retry ticket.
//
// A malformed persisted declaration is treated as ABSENT, so routing fails
// closed to today's remediation-build behavior. RECORDED, not a new concern
// this scan introduces but sharpened by the new TEST_REMEDIATION_CONTROL_
// CHARS refusal above (roadmap entry
// agent-facing-text-routes-bypassing-the-prose-bound): a run already
// in-flight across a runtime upgrade, whose declaration was admitted by the
// PRE-change extractTestRemediation and persisted, is now re-scored by this
// SAME function on every later applyActions chain — if that persisted
// declaration happens to carry a byte the new refusal rejects, this scan's
// errors.length > 0 branch below now drops it as malformed and routing falls
// back to remediation-build instead of remediation-test. Non-blocking (the
// run still proceeds), so this is recorded rather than treated as a defect
// to close.
//
// Both the paths AND the reviewer's `reason` are returned, from ONE scan: the
// reason is what service.js publishes on the remediation-test ticket so the
// writer learns WHY the correction belongs in the test, and a second scan could
// disagree with the routing one.
/**
 * @returns {{ test_paths: string[], reason: string|null }[]}
 */
export function declaredTestRemediations(run) {
  const receipts = run?.receipts ?? [];
  // The run's own authored-test claim set is the containment scope: it is
  // monotone (service.js only ever unions test-writer changed_files into it),
  // so it is a superset of the review ticket snapshot service.js validated the
  // declaration against — this scan can never drop an accepted declaration, and
  // it can never admit one service.js refused, because a refused receipt is
  // never persisted.
  const scope = run?.test_paths ?? [];
  const declared = [];
  for (const ticket of run?.tickets ?? []) {
    if (!FIRST_CODE_REVIEW_STAGES.has(ticket?.stage_id)) continue;
    const receipt = receipts.find((entry) => entry?.ticket_id === ticket?.ticket_id);
    if (!receipt || !votesDisagree(receipt)) continue;
    const declaration = extractTestRemediation({ role: ticket?.role, test_paths: scope }, receipt);
    if (declaration.errors.length > 0) continue;
    // Absence is a clean extraction with no paths: it declares nothing, so it
    // contributes no entry (and no null reason) to the union below.
    if (declaration.test_paths.length === 0) continue;
    // prose-bound-exempt: declaration.reason was validated non-empty by
    // extractTestRemediation above (errors.length === 0 was already checked);
    // service.js testRemediationNotice (service.js:378) passes it through
    // boundedGateSummary(declaration.reason, 200) before it reaches the
    // remediation-test ticket -- a downstream reuse, not a new sink.
    declared.push({ test_paths: declaration.test_paths, reason: declaration.reason });
  }
  return declared;
}

/**
 * @returns {string[]}
 */
export function declaredTestRemediationPaths(run) {
  return [...new Set(declaredTestRemediations(run).flatMap((entry) => entry.test_paths))];
}

// Role-specific receipt requirements for draft validation. Pure, synchronous,
// and derived from the same role constants the pipeline stages use. The
// returned object carries the required_fields list and any role-specific
// evidence requirements so validateReceiptDraft can check them without
// hard-coding role names.
const COMMON_REQUIRED_FIELDS = ['ticket_id', 'status', 'tests', 'findings', 'evidence'];

const ROLE_RECEIPT_REQUIREMENTS = Object.freeze({
  implementer: {
    required_fields: COMMON_REQUIRED_FIELDS,
  },
  test_writer: {
    required_fields: COMMON_REQUIRED_FIELDS,
  },
  planner: {
    required_fields: COMMON_REQUIRED_FIELDS,
    evidence_required: ['candidate_plan'],
  },
  reviewer: {
    required_fields: COMMON_REQUIRED_FIELDS,
    evidence_required: ['verdict'],
    verdict_values: ['pass', 'fail', 'agree', 'disagree'],
  },
  security_reviewer: {
    required_fields: COMMON_REQUIRED_FIELDS,
    evidence_required: ['verdict'],
    verdict_values: ['pass', 'fail', 'agree', 'disagree'],
  },
  preflight_analyst: {
    required_fields: COMMON_REQUIRED_FIELDS,
    evidence_required: ['artifact'],
  },
  plan_checker: {
    required_fields: COMMON_REQUIRED_FIELDS,
    evidence_required: ['verdict'],
    verdict_values: ['pass', 'fail', 'agree', 'disagree'],
  },
  plan_critic: {
    required_fields: COMMON_REQUIRED_FIELDS,
    evidence_required: ['verdict'],
    verdict_values: ['pass', 'fail', 'agree', 'disagree'],
  },
  plan_judge: {
    required_fields: COMMON_REQUIRED_FIELDS,
    evidence_required: ['verdict'],
    verdict_values: ['pass', 'fail', 'agree', 'disagree'],
  },
  debugger: {
    required_fields: COMMON_REQUIRED_FIELDS,
  },
  spike_researcher: {
    required_fields: COMMON_REQUIRED_FIELDS,
  },
});

export function roleReceiptRequirements(role, stageId) {
  return ROLE_RECEIPT_REQUIREMENTS[role] ?? { required_fields: COMMON_REQUIRED_FIELDS };
}

export function nextStages(run, completedStageId, receipt) {
  if (run.mode === 'debug' || run.mode === 'spike') return [];
  if (completedStageId === 'plan-replan-required') {
    return [stage('plan-replan', 'planner')];
  }
  if (completedStageId === 'plan-replan') {
    return [
      stage('plan-check', 'plan_checker', { parallel_group: 'plan-review' }),
      stage('plan-critic', 'plan_critic', { parallel_group: 'plan-review' }),
    ];
  }
  if (completedStageId === 'test-contradiction-reported') {
    return [stage('test-reconcile', 'reviewer')];
  }
  if (completedStageId === 'test-contradiction-confirmed') {
    return [primaryTestStage(run, 'test-recheck')];
  }
  if (completedStageId === 'preflight') {
    if (run.lane === 'full' || run.preflight?.escalated_from === 'fast') {
      return [stage('plan', 'planner')];
    }
    return [primaryTestStage(run)];
  }
  if (completedStageId === 'review-disagreed' && run.remediation_cycles < remediationCycleLimit(run)) {
    // ONE stage, never two (invariant 7 — one active writer): the declared test
    // correction goes first and the remediation-build arm below follows it, so
    // the cycle runs test -> build -> review and still ends on
    // remediation-build's targeted-tests check. remediation_cycles increments
    // exactly once, in the same scheduler arm as today: the counter is the
    // budget, not the stage count (invariant 5).
    if (
      run.remediation_route?.route === 'test'
      || run.remediation_route?.route === 'test-production'
      || declaredTestRemediationPaths(run).length > 0
    ) {
      // required_checks is [] deliberately, and neither alternative is
      // satisfiable. 'red-test' wedges the motivating case — a comment-only
      // correction leaves the suite green, while observeRedTest demands two
      // deterministic failures. 'targeted-tests' wedges the opposite legitimate
      // case — a strengthened assertion is legitimately red until
      // remediation-build lands the production fix. RESIDUAL: with no stage
      // check an empty-diff passed receipt is admissible here; the vote on it is
      // remediation-review, which sees the unchanged tree.
      return [stage('remediation-test', 'test_writer', {
        required_checks: run.remediation_route?.route === 'test-production'
          ? []
          : ['targeted-tests'],
      })];
    }
    return [stage('remediation-build', 'implementer', { required_checks: ['targeted-tests'] })];
  }
  // ORDERING TRAP: this arm must sit ABOVE the `run.lane !== 'full'` branch
  // below. Under it, a fast or mechanical run falls into the lane list, whose
  // findIndex cannot find 'remediation-test', returns [], and the reducer's tail
  // then COMPLETES the run without ever running the merge gates (invariant 9) —
  // worse than stranding it.
  if (completedStageId === 'remediation-test') {
    if (run.remediation_route?.route === 'test') {
      const stages = [stage('remediation-review', 'reviewer', { parallel_group: 'code-review' })];
      if (securityReviewArmed(run)) {
        stages.push(stage('remediation-security-review', 'security_reviewer', {
          parallel_group: 'code-review',
        }));
      }
      return stages;
    }
    return [stage('remediation-build', 'implementer', { required_checks: ['targeted-tests'] })];
  }
  if (completedStageId === 'remediation-build') {
    const stages = [stage('remediation-review', 'reviewer', { parallel_group: 'code-review' })];
    if (securityReviewArmed(run)) {
      stages.push(stage('remediation-security-review', 'security_reviewer', {
        parallel_group: 'code-review',
      }));
    }
    return stages;
  }
  if (run.lane !== 'full') {
    const stages = run.lane === 'mechanical'
      ? [stage('build', 'implementer', { required_checks: mechanicalBuildChecks(run) })]
      : [
          ...(run.behavioral === false
            ? []
            : [primaryTestStage(run)]),
          ...(primaryBuildNeeded(run)
            ? [stage('build', 'implementer', { required_checks: phaseBuildChecks(run) })]
            : []),
          primaryReviewStage(run, { afterBuild: primaryBuildNeeded(run) }),
        ];
    const index = stages.findIndex((item) => item.id === completedStageId);
    return index < 0 ? [] : stages.slice(index + 1, index + 2);
  }

  if (completedStageId === 'plan') {
    return [
      stage('plan-check', 'plan_checker', { parallel_group: 'plan-review' }),
      stage('plan-critic', 'plan_critic', { parallel_group: 'plan-review' }),
    ];
  }
  if (completedStageId === 'plan-review-agreed' || completedStageId === 'plan-judge') {
    if (run.behavioral === false) {
      return [stage('build', 'implementer', { required_checks: phaseBuildChecks(run) })];
    }
    return [primaryTestStage(run)];
  }
  if (completedStageId === 'plan-review-disagreed') {
    return [stage('plan-judge', 'plan_judge')];
  }
  if (completedStageId === 'test') {
    return primaryBuildNeeded(run)
      ? [stage('build', 'implementer', { required_checks: ['targeted-tests'] })]
      : primaryReviewStages(run);
  }
  if (completedStageId === 'build') {
    return primaryReviewStages(run, { afterBuild: true });
  }
  return [];
}

// Late-armed security review (D3/F8): SCOPE_EXPANDED can arm high_risk on the
// FINAL agreeing review receipt (a risk trigger or scope expansion reported by
// the last reviewer) or on a mechanical build receipt — both after the last
// point nextStages could schedule the security-review stage. The scheduler
// re-checks here before entering the gates, because an armed conditional_audits
// gate must always have a schedulable path to the receipt it requires; without
// this the gate fails deterministically, REGATE re-fails it, and only an
// audited abort/reset exits. Satisfaction mirrors the conditional_audits
// predicate in gates.js — a security_reviewer receipt with status 'passed', no
// verdict inspection — with role membership also derivable through the
// receipt's ticket, the scheduler-native mapping (receipt-validator pins
// receipt.agent.role === ticket.role, so both forms admit exactly the same
// runtime-recorded receipts). Stricter than the gate would re-issue a review
// the gate already accepts; looser would run gates that deterministically fail.
export function pendingSecurityReviewStages(run) {
  if (!securityReviewArmed(run)) return [];
  const securityTickets = new Set(
    (run.tickets ?? [])
      .filter((ticket) => ticket.role === 'security_reviewer')
      .map((ticket) => ticket.ticket_id),
  );
  const satisfied = (run.receipts ?? []).some(
    (receipt) =>
      receipt.status === 'passed' &&
      (receipt.agent?.role === 'security_reviewer' || securityTickets.has(receipt.ticket_id)),
  );
  return satisfied
    ? []
    : [stage('security-review', 'security_reviewer', { parallel_group: 'code-review' })];
}

// Describe artifact handoffs of the existing graph, including runtime-owned
// consumers. These annotations issue no tickets and make no scheduling choice.
function projectedArtifacts(run, stages) {
  if (run.mode === 'debug' || run.mode === 'spike') return { runtime_stages: [], artifact_edges: [] };
  const ids = new Set(stages.map((entry) => entry.id));
  const present = (values) => values.filter((id) => ids.has(id));
  const runtime = [];
  const edges = [];
  const node = (id, action, requirements) => runtime.push({ id, action, authority: 'runtime-only', requirements });
  const edge = (artifact, schema, producers, consumers, condition = 'when-reachable-branch-runs') => {
    if (consumers.length) edges.push({ artifact, schema, producers, consumers, condition });
  };
  const planners = present(['plan', 'plan-replan']);
  const planReview = present(['plan-check', 'plan-critic', 'plan-judge']);
  if (planners.length) {
    const structured = [1, 2].includes(run.plan_contract_version);
    if (run.plan_contract_version === 2) edge('preflight-artifact', 'PreflightArtifactSchema:v1', ['preflight'], planners);
    node('runtime:approve-plan', structured ? 'seal_approved_plan' : 'accept_plan_review', ['complete-plan-review-group', 'positive-consensus-or-judge']);
    edge(structured ? 'candidate-plan' : 'legacy-plan-evidence', structured ? `CandidatePlanSchema:v${run.plan_contract_version}` : 'ReceiptEvidenceSchema', planners, [...planReview, 'runtime:approve-plan']);
    edge('planning-verdicts', 'accepted-plan-review-receipts', ['plan-check', 'plan-critic'], ['runtime:approve-plan']);
    edge(structured ? 'approved-plan' : 'planning-approval', structured ? `ApprovedPlanSchema:v${run.plan_contract_version}` : 'plan-review-consensus', ['runtime:approve-plan'], present(['test', 'build', 'review', 'security-review', 'remediation-test', 'remediation-build']));
  }
  for (const producer of stages) {
    for (const check of producer.required_checks.filter((value) => ['red-test', 'green-test'].includes(value))) {
      const id = `runtime:observe-${check}:${producer.id}`;
      node(id, check === 'red-test' ? 'observe_red_test' : 'observe_green_test', ['runtime-execution', 'exact-authored-test-paths', 'tree-bound-observation']);
      edge(`authored-tests:${producer.id}`, 'runtime-observed-test-tree', [producer.id], [id]);
      edge(`${check === 'red-test' ? 'red' : 'green'}-evidence:${producer.id}`, 'runtime-sealed-test-observation', [id], present(['build', 'review', 'remediation-build']));
    }
  }
  if (ids.has('test-reconcile')) {
    edge('test-contradiction', 'receipt-test-contradiction', present(['build', 'remediation-build']), ['test-reconcile']);
    edge('reconciliation-verdict', 'independent-test-reconciliation', ['test-reconcile'], present(['test-recheck', 'build']));
  }
  const reviews = present(['review', 'security-review', 'remediation-review', 'remediation-security-review']);
  edge('review-findings', `StructuredReviewFindingSchema:v${REVIEW_CONTRACT_VERSION}`, reviews, present(['remediation-test', 'remediation-build']));
  node('runtime:merge-gates', 'run_gates', ['accepted-stage-receipts', 'runtime-verification-suite', 'scope-and-tree-integrity', 'armed-security-audits']);
  edge('accepted-work', 'accepted-stage-receipts', reviews.length ? reviews : present(['build']), ['runtime:merge-gates']);
  node('runtime:shipping', 'ship_after_gates', ['passing-merge-gates', 'explicit-shipping-authorization', 'attested-origin-base-and-head', 'observed-merge-before-completion']);
  edge('gate-results', 'runtime-merge-gate-results', ['runtime:merge-gates'], ['runtime:shipping'], 'only-after-green-gates-and-explicit-shipping-authority');
  return {
    runtime_stages: Object.freeze(runtime.map((entry) => Object.freeze(entry))),
    artifact_edges: Object.freeze(edges.map((entry) => Object.freeze(entry))),
  };
}

/**
 * Pure projection of the existing worker graph, runtime artifact handoffs,
 * and deterministic bounds; never an authorization or a second scheduler.
 * @param {object} run
 */
export function projectedPipeline(run = {}) {
  const stages = [];
  const conditionalBranches = [];
  const isArmedSecurity = securityReviewArmed(run);
  // Forecast the deterministic worst-case graph, not only the graph armed at
  // preview time. A valid later receipt may add a risk trigger and set
  // high_risk before gates; unless policy explicitly disables the audit, that
  // same run can still issue security review and security remediation.
  const securityMayArm = run.policy?.high_risk_security_review !== false;
  const securityBranch = () => conditionalBranches.push({
    id: 'security-review',
    label: isArmedSecurity
      ? 'Security review (high-risk audit)'
      : 'Security review (late risk trigger)',
  });
  const isV2Preflight =
    run.plan_contract_version === 2 &&
    run.behavioral === true &&
    (run.lane === 'full' || run.lane === 'fast');
  const preflightMayEscalateLane = isV2Preflight && run.lane === 'fast';
  const projectedLane = preflightMayEscalateLane ? 'full' : run.lane;

  if (run.mode === 'debug') {
    stages.push(stage('debug', 'debugger'));
  } else if (run.mode === 'spike') {
    stages.push(stage('spike', 'spike_researcher'));
  } else if (run.mode === 'land') {
    stages.push(stage('review', 'reviewer', { parallel_group: 'code-review' }));
    if (securityMayArm) {
      stages.push(stage('security-review', 'security_reviewer', { parallel_group: 'code-review' }));
      securityBranch();
    }
    conditionalBranches.push({
      id: 'review-disagreement-block',
      label: 'Review disagreement (terminal block; land mode has no writer)',
    });
  } else if (projectedLane === 'mechanical') {
    stages.push(stage('build', 'implementer', { required_checks: mechanicalBuildChecks(run) }));
    if (securityMayArm) {
      stages.push(stage('security-review', 'security_reviewer', { parallel_group: 'code-review' }));
      securityBranch();
      conditionalBranches.push({ id: 'remediation', label: 'Remediation routing (on security-review disagreement)' });
      stages.push(stage('remediation-test', 'test_writer'));
      stages.push(stage('remediation-build', 'implementer', { required_checks: ['targeted-tests'] }));
      stages.push(stage('remediation-review', 'reviewer', { parallel_group: 'code-review' }));
      stages.push(stage('remediation-security-review', 'security_reviewer', { parallel_group: 'code-review' }));
    }
  } else {
    // phase mode (or default)
    if (isV2Preflight) {
      stages.push(stage('preflight', 'preflight_analyst'));
    }
    if (preflightMayEscalateLane) {
      conditionalBranches.push({
        id: 'lane-escalation',
        label: 'Full-lane planning (preflight escalation)',
      });
    }

    if (projectedLane === 'fast') {
      if (run.behavioral !== false) {
        stages.push(primaryTestStage(run));
      }
      if (primaryBuildNeeded(run)) {
        stages.push(stage('build', 'implementer', { required_checks: phaseBuildChecks(run) }));
      }
      if (run.behavioral !== false && primaryBuildNeeded(run)) {
        conditionalBranches.push({ id: 'test-reconciliation', label: 'Bounded test-contradiction reconciliation' });
        stages.push(stage('test-reconcile', 'reviewer'));
        stages.push(primaryTestStage(run, 'test-recheck'));
      }
      stages.push(projectedReviewStage(run, projectedLane));
      if (securityMayArm) {
        stages.push(stage('security-review', 'security_reviewer', { parallel_group: 'code-review' }));
        securityBranch();
      }
      conditionalBranches.push({ id: 'remediation', label: 'Remediation routing (on review disagreement)' });
      stages.push(stage('remediation-test', 'test_writer'));
      stages.push(stage('remediation-build', 'implementer', { required_checks: ['targeted-tests'] }));
      stages.push(stage('remediation-review', 'reviewer', { parallel_group: 'code-review' }));
      if (securityMayArm) {
        stages.push(stage('remediation-security-review', 'security_reviewer', { parallel_group: 'code-review' }));
      }
    } else {
      // full lane (or default)
      stages.push(stage('plan', 'planner'));
      stages.push(stage('plan-check', 'plan_checker', { parallel_group: 'plan-review' }));
      stages.push(stage('plan-critic', 'plan_critic', { parallel_group: 'plan-review' }));
      conditionalBranches.push({ id: 'plan-judge', label: 'Plan-judge escalation (on plan review disagreement)' });
      stages.push(stage('plan-judge', 'plan_judge'));
      conditionalBranches.push({ id: 'plan-replan', label: 'Up to two converging directed replans (on judge rejection)' });
      stages.push(stage('plan-replan', 'planner'));
      if (run.behavioral !== false) {
        stages.push(primaryTestStage(run));
      }
      if (primaryBuildNeeded(run)) {
        stages.push(stage('build', 'implementer', { required_checks: phaseBuildChecks(run) }));
      }
      if (run.behavioral !== false && primaryBuildNeeded(run)) {
        conditionalBranches.push({ id: 'test-reconciliation', label: 'Bounded test-contradiction reconciliation' });
        stages.push(stage('test-reconcile', 'reviewer'));
        stages.push(primaryTestStage(run, 'test-recheck'));
      }
      stages.push(projectedReviewStage(run, projectedLane));
      if (securityMayArm) {
        stages.push(stage('security-review', 'security_reviewer', { parallel_group: 'code-review' }));
        securityBranch();
      }
      conditionalBranches.push({ id: 'remediation', label: 'Remediation routing (on review disagreement)' });
      stages.push(stage('remediation-test', 'test_writer'));
      stages.push(stage('remediation-build', 'implementer', { required_checks: ['targeted-tests'] }));
      stages.push(stage('remediation-review', 'reviewer', { parallel_group: 'code-review' }));
      if (securityMayArm) {
        stages.push(stage('remediation-security-review', 'security_reviewer', { parallel_group: 'code-review' }));
      }
    }
  }

  const byStage = {};
  const byRole = {};
  const byModelTier = {};
  const physicalByStage = {};
  let total = 0;
  let logicalUpperBound = 0;
  let protocolReplacementUpperBound = 0;
  // Initial plan plus the two strict-subset directed replans admitted by the
  // reducer. Review/judge stage counters are global, so their single retry is
  // added once below rather than once per round.
  const limits = pipelineLimits(run);
  const directedPlanRounds = stages.some((entry) => entry.id === 'plan-replan')
    ? 1 + limits.max_directed_replans : 1;
  const remediationDispatches = limits.max_remediation_cycles + (limits.max_stage_attempts - 1);
  const repeatedRemediationStages = new Set([
    'remediation-test',
    'remediation-build',
    'remediation-review',
    'remediation-security-review',
  ]);

  for (const s of stages) {
    const stageLimits = stageRecoveryLimits(s.id);
    const attempts = stageLimits.max_stage_attempts === 1
      ? 1
      // Plan-check, plan-critic, and plan-judge may each run in both the
      // original and replacement-plan rounds. Their stage attempt counter is
      // global, so exactly one expiry/failure retry can be added across those
      // rounds, not one per round.
      : ['plan-check', 'plan-critic', 'plan-judge'].includes(s.id)
        ? directedPlanRounds + (MAX_STAGE_ATTEMPTS - 1)
        // A distinct anchored finding may consume every configured remediation
        // cycle. Each repeated stage dispatches once per cycle and can spend
        // one additional global retry across the whole run.
        : s.id === 'plan-replan'
          ? limits.max_directed_replans + (limits.max_stage_attempts - 1)
        : repeatedRemediationStages.has(s.id)
          ? remediationDispatches
        : MAX_STAGE_ATTEMPTS;
    byStage[s.id] = (byStage[s.id] ?? 0) + attempts;
    byRole[s.role] = (byRole[s.role] ?? 0) + attempts;
    byModelTier[s.model_tier] = (byModelTier[s.model_tier] ?? 0) + attempts;
    total += attempts;
    const logicalTickets = attempts;
    logicalUpperBound += logicalTickets;
    protocolReplacementUpperBound += stageLimits.max_protocol_redispatches;
    physicalByStage[s.id] = (logicalTickets + stageLimits.max_protocol_redispatches)
      * limits.max_physical_workers_per_ticket;
  }

  const physicalUpperBound = (logicalUpperBound + protocolReplacementUpperBound)
    * limits.max_physical_workers_per_ticket;

  const dispatchBounds = Object.freeze({
    total,
    total_semantics: 'logical-ticket-upper-bound',
    by_stage: Object.freeze(byStage),
    by_role: Object.freeze(byRole),
    by_model_tier: Object.freeze(byModelTier),
    logical_ticket_upper_bound: logicalUpperBound,
    protocol_replacement_ticket_upper_bound: protocolReplacementUpperBound,
    physical_dispatch_upper_bound: physicalUpperBound,
    receipt_validation_submission_upper_bound: physicalUpperBound * limits.max_validation_submissions_per_worker,
    physical_by_stage: Object.freeze(physicalByStage),
    physical_bound_contract: 'receipt-contract-v1',
  });

  return Object.freeze({
    stages: Object.freeze(stages),
    conditional_branches: Object.freeze(conditionalBranches),
    dispatch_bounds: dispatchBounds,
    ...projectedArtifacts(run, stages),
  });
}
