import {
  AUTO_MERGE_HOLD_REASON,
  LANES,
  MAX_REGATE_ATTEMPTS,
  MAX_STAGE_ATTEMPTS,
  SCOPE_EXPANSION_REASONS_MAX,
  TERMINAL_STATUSES,
} from './constants.js';
import { initialStages, nextStages, pendingSecurityReviewStages, remediationCycleLimit } from './pipeline.js';
import { MAX_DIRECTED_REPLANS, MAX_WORKER_PROTOCOL_REDISPATCHES_PER_STAGE, stageRecoveryLimits } from './pipeline-limits.js';
import {
  approvedPlan,
  CandidatePlanSchema,
  PLAN_CONTRACT_VERSION,
} from './plan-contract.js';
import { reviewFindings } from './review-evidence.js';
import { structuredRemediationRoute } from './schemas.js';
import {
  FAILURE_DOMAIN_TAXONOMY_VERSION,
  incrementOrchestration,
  workerFailureDomain,
} from './orchestration-telemetry.js';

function action(type, payload = {}) {
  return Object.freeze({ type, ...payload });
}

function isStrictProperSubset(nextValues, priorValues) {
  if (!Array.isArray(nextValues) || !Array.isArray(priorValues)) return false;
  const next = new Set(nextValues);
  const prior = new Set(priorValues);
  if (next.size === 0 || next.size >= prior.size) return false;
  return [...next].every((value) => prior.has(value));
}

function assuranceIdentity(entry) {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return null;
  const material = {};
  // evidence_anchor is provenance, not semantic identity: shorthand entries
  // receive a new ticket/index anchor on every judge cycle. Including it makes
  // a normalized strict subset look incomparable solely because time advanced.
  for (const field of ['requirement_id', 'risk_trigger', 'summary']) {
    if (typeof entry[field] === 'string' && entry[field].trim() !== '') {
      material[field] = entry[field].trim();
    }
  }
  return Object.keys(material).length > 0 ? JSON.stringify(material) : null;
}

function assuranceIdentitySet(entries) {
  if (!Array.isArray(entries)) return null;
  const values = entries.map(assuranceIdentity);
  if (values.length === 0 || values.some((value) => value === null)) return null;
  return [...new Set(values)].sort();
}

function declaredAssurancesAreCompletelyNormalized(receipt, recovery) {
  const declared = receipt?.evidence?.missing_assurances;
  if (!Array.isArray(declared)) return true;
  if (declared.length === 0 || recovery?.missing_assurances?.length !== declared.length) {
    return false;
  }
  return declared.every((entry) => {
    if (typeof entry === 'string') return entry.trim() !== '';
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return false;
    return ['summary', 'assurance', 'reason', 'detail', 'title'].some(
      (field) => typeof entry[field] === 'string' && entry[field].trim() !== '',
    );
  });
}

function expiredTicketIds(state) {
  return new Set(state.expired_tickets ?? []);
}

function activeTickets(state, group) {
  const expired = expiredTicketIds(state);
  return state.tickets.filter(
    (ticket) =>
      ticket.parallel_group === group &&
      !expired.has(ticket.ticket_id) &&
      !state.receipts.some((receipt) => receipt.ticket_id === ticket.ticket_id),
  );
}

function completedForGroup(state, group) {
  const latestByStage = new Map();
  for (const ticket of state.tickets.filter((entry) => entry.parallel_group === group)) {
    latestByStage.set(ticket.stage_id, ticket);
  }
  // A remediation stage supersedes the stage it remediates: once the group has
  // been re-reviewed, the original disagreeing/failing receipt no longer votes.
  for (const stageId of [...latestByStage.keys()]) {
    if (stageId.startsWith('remediation-')) {
      latestByStage.delete(stageId.slice('remediation-'.length));
    }
  }
  return [...latestByStage.values()]
    .map((ticket) => state.receipts.find((receipt) => receipt.ticket_id === ticket.ticket_id))
    .filter(Boolean);
}

// Receipt-contract correction is a physical-worker concern, not a logical
// stage attempt. SubagentStop settlement persists this marker only after an
// exhausted worker, or a worker whose correction was cut off by the active
// budget, is observed stopped. It is the durable proof that NEXT may
// redispatch the same immutable ticket once. Check it before the ticket's
// ordinary deadline: the first worker can spend the whole ticket horizon on
// product work and then hit either mechanical boundary at that exact moment.
// Turning that collision into expirePendingTicket would mint a new ticket and
// spend a stage attempt for an orchestration failure. The dispatch-intent
// layer independently enforces the immutable two-physical-worker ceiling.
function pendingReceiptContractRecoveries(state, pending) {
  const marked = new Set(
    Array.isArray(state.receipt_contract_pending_redispatches)
      ? state.receipt_contract_pending_redispatches.filter((ticketId) => typeof ticketId === 'string')
      : [],
  );
  if (marked.size === 0) return [];
  return pending.filter((ticket) =>
    ticket.receipt_contract_version === 1 &&
    marked.has(ticket.ticket_id));
}

function stageFromTicket(ticket) {
  return {
    id: ticket.stage_id,
    role: ticket.role,
    model_tier: ticket.model_tier,
    writable: ticket.writable,
    parallel_group: ticket.parallel_group ?? null,
    required_checks: ticket.required_checks ?? [],
    output_schema: ticket.output_schema,
    ...(ticket.review_contract_version
      ? { review_contract_version: ticket.review_contract_version }
      : {}),
  };
}

function withOrchestrationIncrement(state, field) {
  return incrementOrchestration(state.orchestration, field);
}

// A recorded worker transport/contract failure is not product evidence. Give
// the same stage contract one replacement dispatch without spending its
// product attempt budget; a second failure in that same stage is a stable
// orchestration block. The accepted receipt already consumed its immutable
// ticket id, so this replacement is explicitly a new ticket for the same
// logical attempt. Pre-record contract correction redispatches the original
// ticket and is owned by receipt admission instead.
function workerProtocolRecovery(state, ticket, receipt, { reviewGroup = false } = {}) {
  const failureDomain = workerFailureDomain(receipt, { reviewGroup });
  if (!failureDomain) return null;
  const redispatches = state.worker_protocol_redispatches ?? {};
  const used = Number.isInteger(redispatches[ticket.stage_id])
    ? redispatches[ticket.stage_id]
    : 0;
  if (used < MAX_WORKER_PROTOCOL_REDISPATCHES_PER_STAGE) {
    const { entries: priorAttempts, informative } = reviewFindings.attemptSummaryList(
      state,
      ticket.stage_id,
      ticket.ticket_id,
      receipt,
    );
    return [
      action('transition', {
        patch: {
          worker_protocol_redispatches: {
            ...redispatches,
            [ticket.stage_id]: 1,
          },
          orchestration: withOrchestrationIncrement(state, 'protocol_redispatches'),
        },
      }),
      action('issue_ticket', {
        stage: stageFromTicket(ticket),
        recovery_kind: 'reissue_same_contract',
        source_ticket_id: ticket.ticket_id,
        failure_domain: failureDomain,
        ...(informative && priorAttempts.length ? { prior_attempts: priorAttempts } : {}),
        ...(Array.isArray(ticket.review_findings) && ticket.review_findings.length
          ? { review_findings: ticket.review_findings }
          : {}),
        ...(Array.isArray(ticket.review_finding_evidence) && ticket.review_finding_evidence.length
          ? { review_finding_evidence: ticket.review_finding_evidence }
          : {}),
        ...(ticket.scope_expansion ? { scope_expansion: ticket.scope_expansion } : {}),
        ...(ticket.plan_recovery ? { plan_recovery: ticket.plan_recovery } : {}),
        ...(ticket.test_reconciliation ? { test_reconciliation: ticket.test_reconciliation } : {}),
      }),
      action('persist_state'),
    ];
  }
  return terminalRecoveryBlock(
    ticket.stage_id,
    `stage ${ticket.stage_id} worker protocol failed after its single same-contract redispatch`,
    {
      terminal_reason_code: 'worker_protocol_failure',
      failure_domain: failureDomain,
      failure_domain_taxonomy_version: FAILURE_DOMAIN_TAXONOMY_VERSION,
    },
  );
}

// The remediation ticket's scope-expansion channel, the STATE-DERIVED
// counterpart to reviewFindings above (and to declaredTestRemediationPaths,
// pipeline.js, for its structural sibling channel): a blocking review's
// evidence.scope_expansion is accepted and durably recorded onto
// state.pending_scope_expansions — keyed by the PROPOSING ticket's own
// ticket_id — by the SCOPE_EXPANDED transition below, the moment service.js
// validates it, independent of whether that receipt is also the one that
// completes its review group. Reading it back here from EVERY member of the
// completed group, rather than only the receipt this reduction happens to be
// processing, closes the order-dependent miss a single-receipt read left
// open: a two-member group's FIRST-arriving receipt can propose the growth
// while the SECOND is what actually completes the group and triggers this
// call. Multiple members proposing distinct growth is unioned by path, and
// each member's reason is kept SEPARATE: every entry read back here was
// already bounded individually where it was recorded (service.js's
// SCOPE_EXPANDED dispatch calls boundedGateSummary on the reviewer's reason
// before this module ever sees it), so joining them here cannot let one
// member's reason consume another's budget. That is the same bound-each-then-
// join order testRemediationNotice (service.js) uses, applied one step earlier
// because this module cannot import the helper without a cycle.
function groupScopeExpansion(state, receipts) {
  const pending = state.pending_scope_expansions ?? {};
  const claimedPaths = [];
  const reasons = [];
  for (const receipt of receipts) {
    const entry = pending[receipt.ticket_id];
    if (!entry) continue;
    for (const claim of entry.claimed_paths ?? []) {
      if (!claimedPaths.includes(claim)) claimedPaths.push(claim);
    }
    if (typeof entry.reason === 'string' && entry.reason.trim() !== '') reasons.push(entry.reason);
  }
  if (claimedPaths.length === 0) return null;
  const dropsReasons = reasons.length > SCOPE_EXPANSION_REASONS_MAX;
  const reasonSlots = dropsReasons ? SCOPE_EXPANSION_REASONS_MAX - 1 : SCOPE_EXPANSION_REASONS_MAX;
  const keptReasons = reasons.slice(0, reasonSlots);
  if (dropsReasons) {
    keptReasons.push(
      `[APE runtime] ${reasons.length - reasonSlots} further reviewer reason(s) not listed here`,
    );
  }
  return {
    claimed_paths: claimedPaths,
    // Every entry joined here is a review receipt's own
    // evidence.scope_expansion.reason, validated non-empty by
    // extractScopeExpansion AND bounded individually by the SCOPE_EXPANDED
    // dispatch (both service.js) before it was recorded onto
    // state.pending_scope_expansions, so each contributes at most its own
    // per-reason ceiling to this join and the count above is capped with the
    // runtime's own omission note in the last slot.
    // prose-bound-exempt: joins values that were each neutralized and cut at
    // their recording site, and the whole join is cut again by
    // boundedScopeExpansion (service.js) at a ceiling derived from those same
    // two constants before it reaches a ticket objective.
    reason: keptReasons.length > 0 ? keptReasons.join(' | ') : null,
  };
}

// The single exit for a pending ticket that will never produce a receipt:
// mark it expired, consume the stage attempt, and either issue the retry
// ticket or block with an honest reason. Shared by the NEXT deadline-timeout
// arm and the audited EXPIRE_DISPATCH lever so both exits stay identical.
function expirePendingTicket(state, ticket, blockReason) {
  const attempts = state.attempts[ticket.stage_id] ?? 1;
  const expiredIds = [...(state.expired_tickets ?? []), ticket.ticket_id];
  const singleAttemptRecovery = stageRecoveryLimits(ticket.stage_id).max_stage_attempts === 1;
  if (!singleAttemptRecovery && attempts < MAX_STAGE_ATTEMPTS) {
    // The expiring ticket has no receipt, so prior_attempts is receipt-derived
    // from any earlier recorded attempt only (typically absent); a
    // remediation-build or remediation-test ticket's review_findings and
    // scope_expansion are forwarded onto its retry unchanged. Keys attach
    // only when non-empty so an ordinary retry ticket stays byte-identical.
    const { entries: priorAttempts, informative } = reviewFindings.attemptSummaryList(
      state,
      ticket.stage_id,
      ticket.ticket_id,
      null,
    );
    return [
      action('transition', {
        patch: {
          attempts: { ...state.attempts, [ticket.stage_id]: attempts + 1 },
          expired_tickets: expiredIds,
          orchestration: withOrchestrationIncrement(state, 'stage_retries'),
        },
      }),
      action('issue_ticket', {
        stage: stageFromTicket(ticket),
        retry_of: ticket.ticket_id,
        recovery_kind: 'stage_retry',
        ...(informative && priorAttempts.length ? { prior_attempts: priorAttempts } : {}),
        ...(Array.isArray(ticket.review_findings) && ticket.review_findings.length
          ? { review_findings: ticket.review_findings }
          : {}),
        ...(Array.isArray(ticket.review_finding_evidence) && ticket.review_finding_evidence.length
          ? { review_finding_evidence: ticket.review_finding_evidence }
          : {}),
        ...(ticket.scope_expansion ? { scope_expansion: ticket.scope_expansion } : {}),
        ...(ticket.plan_recovery ? { plan_recovery: ticket.plan_recovery } : {}),
        ...(ticket.test_reconciliation ? { test_reconciliation: ticket.test_reconciliation } : {}),
      }),
      action('persist_state'),
    ];
  }
  return [
    action('transition', {
      patch: {
        status: 'blocked',
        stage: ticket.stage_id,
        ...(singleAttemptRecovery ? { terminal_reason_code: 'test_contradiction' } : {}),
        expired_tickets: expiredIds,
        // prose-bound-exempt: blockReason is always one of this module's own fixed
        // diagnostic templates (see expirePendingTicket's callers); the only
        // agent-authored text this block_reason carries is what
        // attemptSummaries appends, which routes each entry through
        // flattenReviewText (defined below, function-declaration hoisted)
        // before its BLOCK_SUMMARY_LIMIT cap, so it is control/bidi-
        // neutralized and length-capped, never raw.
        block_reason: blockReason + reviewFindings.attemptSummaries(state, ticket.stage_id),
      },
    }),
    // Blocked is a terminal status: every transition into it archives
    // immediately (F7), so the run is queryable in history without an
    // operator abort/reset. if_absent keeps a crash-retry a no-op.
    action('archive_history', { if_absent: true }),
    action('release_lock'),
    action('persist_state'),
  ];
}

function groupOutcome(receipts) {
  const positive = new Set(['agree', 'pass', 'passed']);
  // Truthful completion (invariant 8): a non-passed receipt always votes
  // disagree; a stray positive verdict string inside failed evidence must not
  // count as agreement.
  const verdicts = receipts.map((receipt) =>
    String(receipt.status).toLowerCase() !== 'passed'
      ? 'disagree'
      : String(receipt.evidence?.verdict ?? receipt.status).toLowerCase());
  return verdicts.length > 0 && verdicts.every((verdict) => positive.has(verdict))
    ? 'agreed'
    : 'disagreed';
}

function latestTicketForStage(state, stageId) {
  return [...(state.tickets ?? [])].reverse().find((ticket) => ticket.stage_id === stageId) ?? null;
}

function receiptForTicket(state, ticket) {
  return ticket
    ? (state.receipts ?? []).find((receipt) => receipt.ticket_id === ticket.ticket_id) ?? null
    : null;
}

function isExactPlanAgreement(receipt) {
  return receipt?.status === 'passed' && receipt?.evidence?.verdict === 'agree';
}

// Seal only the exact structured plan the reviewers saw. The checker and
// critic are ordered by role, never receipt arrival; judge approval appends the
// judge hash. A missing/mismatched candidate returns null so the reducer can
// block fail-closed instead of advancing under an invented authority.
function sealApprovedPlan(state, route, judgeReceipt = null) {
  if (![PLAN_CONTRACT_VERSION, 2].includes(state.plan_contract_version)) return undefined;
  const checkTicket = latestTicketForStage(state, 'plan-check');
  const criticTicket = latestTicketForStage(state, 'plan-critic');
  const checkReceipt = receiptForTicket(state, checkTicket);
  const criticReceipt = receiptForTicket(state, criticTicket);
  const checkCandidate = CandidatePlanSchema.safeParse(checkTicket?.candidate_plan);
  const criticCandidate = CandidatePlanSchema.safeParse(criticTicket?.candidate_plan);
  if (!checkReceipt || !criticReceipt || !checkCandidate.success || !criticCandidate.success) return null;
  if (checkCandidate.data.plan_hash !== criticCandidate.data.plan_hash) return null;
  if (route === 'unanimous' && (!isExactPlanAgreement(checkReceipt) || !isExactPlanAgreement(criticReceipt))) {
    return null;
  }
  if (route === 'judge') {
    const judgeTicket = latestTicketForStage(state, 'plan-judge');
    const judgeCandidate = CandidatePlanSchema.safeParse(judgeTicket?.candidate_plan);
    if (
      !judgeReceipt ||
      !isExactPlanAgreement(judgeReceipt) ||
      judgeReceipt.ticket_id !== judgeTicket?.ticket_id ||
      !judgeCandidate.success ||
      judgeCandidate.data.plan_hash !== checkCandidate.data.plan_hash
    ) return null;
  }
  return approvedPlan(
    checkCandidate.data,
    route,
    [
      checkReceipt.receipt_hash,
      criticReceipt.receipt_hash,
      ...(route === 'judge' ? [judgeReceipt.receipt_hash] : []),
    ],
  );
}

function planSealFailureActions() {
  return [
    action('transition', {
      patch: {
        status: 'blocked',
        stage: 'plan-approval',
        block_reason: 'structured plan approval could not be sealed from identical reviewer-visible candidate plans',
      },
    }),
    action('archive_history', { if_absent: true }),
    action('release_lock'),
    action('persist_state'),
  ];
}

function terminalRecoveryBlock(stage, blockReason, patch = {}) {
  return [
    action('transition', {
      patch: {
        status: 'blocked',
        stage,
        // prose-bound-exempt: this helper is private to the reducer and every
        // caller supplies either a fixed runtime diagnostic or the
        // capability diagnostic assembled from attemptSummaries(), whose
        // receipt prose is control/bidi-neutralized and length-capped before
        // interpolation. Keeping this single sink makes that invariant
        // auditable for every bounded recovery exit.
        block_reason: blockReason,
        ...patch,
      },
    }),
    action('archive_history', { if_absent: true }),
    action('release_lock'),
    action('persist_state'),
  ];
}

function capabilityRecoveryBlock(state, ticket, receipt) {
  return terminalRecoveryBlock(
    ticket.stage_id,
    `stage ${ticket.stage_id} capability-blocked${reviewFindings.attemptSummaries(
      state,
      ticket.stage_id,
      ticket.ticket_id,
      receipt,
    )}`,
    {
      terminal_reason_code: 'capability_blocked',
      failure_domain: 'configuration',
      failure_domain_taxonomy_version: FAILURE_DOMAIN_TAXONOMY_VERSION,
      blocked_recovery: reviewFindings.capabilityResolution(state, ticket, receipt),
    },
  );
}

function confirmedContradictionPaths(ticket, receipt) {
  const authorized = new Set(ticket.test_reconciliation?.test_paths ?? []);
  const confirmed = new Set();
  for (const finding of receipt.findings ?? []) {
    if (finding?.blocking !== true) continue;
    if (!['test', 'both'].includes(finding?.remediation?.owner)) continue;
    for (const testPath of finding.remediation?.test_paths ?? []) {
      if (authorized.has(testPath)) confirmed.add(testPath);
    }
  }
  return [...confirmed].sort();
}

function retryContradictionSource(state, resolution = {}) {
  const pending = state.test_contradiction_pending;
  const source = (state.tickets ?? []).find(
    (ticket) => ticket.ticket_id === pending?.source_ticket_id,
  );
  if (!source) {
    return terminalRecoveryBlock(
      'test-reconcile',
      'test contradiction reconciliation lost its immutable source ticket; refusing to guess a writer scope',
      { terminal_reason_code: 'test_contradiction' },
    );
  }
  const attempts = state.attempts[source.stage_id] ?? source.attempt ?? 1;
  if (attempts >= MAX_STAGE_ATTEMPTS) {
    return terminalRecoveryBlock(
      source.stage_id,
      `stage ${source.stage_id} cannot resume after test contradiction reconciliation because its writer attempt budget is exhausted`,
      {
        terminal_reason_code: 'test_contradiction',
        test_contradiction_resolution: resolution,
      },
    );
  }
  const { entries: priorAttempts, informative } = reviewFindings.attemptSummaryList(
    state,
    source.stage_id,
  );
  return [
    action('transition', {
      patch: {
        attempts: { ...state.attempts, [source.stage_id]: attempts + 1 },
        test_contradiction_pending: null,
        test_contradiction_resolution: resolution,
        orchestration: withOrchestrationIncrement(state, 'stage_retries'),
      },
    }),
    action('issue_ticket', {
      stage: stageFromTicket(source),
      retry_of: source.ticket_id,
      recovery_kind: 'stage_retry',
      ...(informative && priorAttempts.length ? { prior_attempts: priorAttempts } : {}),
      ...(Array.isArray(source.review_findings) && source.review_findings.length
        ? { review_findings: source.review_findings }
        : {}),
      ...(Array.isArray(source.review_finding_evidence) && source.review_finding_evidence.length
        ? { review_finding_evidence: source.review_finding_evidence }
        : {}),
      ...(source.scope_expansion ? { scope_expansion: source.scope_expansion } : {}),
      ...(pending?.context ? { test_reconciliation: pending.context } : {}),
    }),
    action('persist_state'),
  ];
}

// Guidance for a recovery lever refused while the run RESTS in a non-blocking
// watch. 'gating' and 'shipping' are absent from TERMINAL_STATUSES, so the
// pre-switch terminal guard never answers in either state and control reaches
// the REGATE and SHIP arms, whose own validity guards refuse — correctly, since
// neither lever applies to a resting run — but whose stock advice ("recover ...
// through the audited OVERRIDE reset or ABORT") would kill a healthy detached
// gate suite ('gating') or abort a run whose PR is open with required remote
// checks mid-flight ('shipping'). Both rest states are the SHIPPED DEFAULT path
// (shipping.required_remote_checks defaults true; auto_merge is explicit opt-in),
// and both span the multi-minute window a lost response is re-issued across, so
// the refusal an operator most often reads must be SAFE TO FOLLOW: name the
// watch, repeat the evidence already on state, and point at the one lever that
// advances it. The wording mirrors the guidance resume already returns for these
// same two states (service.js resumeRun), so both surfaces answer alike.
//
// PURE, like every other reducer path: derived from the state object alone — no
// I/O and no wall-clock read — and it never interpolates an absent field. It
// returns null for every other state, so no other refusal changes, and it never
// admits an operation: the lever stays refused, only its prose becomes usable.
function restStateGuidance(state) {
  const detail = (value) => (typeof value === 'string' && value.trim() !== '' ? ` (${value})` : '');
  if (state.status === 'gating' && state.gates_watch) {
    return `this run rests in the non-blocking gating watch — the merge-gate suite is still running${detail(state.gates_watch.last_summary)}; call ape_run next with wait_ms: 300000 for bounded server-side polling`;
  }
  if (state.status === 'shipping' && state.shipping_watch) {
    const pr = typeof state.shipping_watch.pr_url === 'string' && state.shipping_watch.pr_url.trim() !== ''
      ? ` for ${state.shipping_watch.pr_url}`
      : '';
    return `this run rests in the non-blocking shipping watch — required remote checks are in progress${pr}${detail(state.shipping_watch.last_checks_summary)}; call ape_run next with wait_ms: 300000 for bounded server-side polling`;
  }
  return null;
}

export function reduceRun(state, event) {
  if (event.type !== 'START' && (!state || typeof state !== 'object')) {
    return [action('reject', { reason: 'run state is required' })];
  }
  if (state && TERMINAL_STATUSES.has(state.status)) {
    // `blocked` is terminal for scheduling — no receipts, no NEXT, no new
    // tickets — but it must be exitable: plain ABORT terminates and archives a
    // blocked run (F7), REGATE recovers a gate block (the REGATE arm rejects any
    // non-gate block), and SHIP recovers only the auto-merge-disabled hold at
    // stage 'merge' (the SHIP arm rejects every other block). completed/aborted
    // runs stay sealed except for STATUS/OVERRIDE.
    const allowed = state.status === 'blocked'
      ? ['STATUS', 'OVERRIDE', 'ABORT', 'REGATE', 'SHIP']
      : ['STATUS', 'OVERRIDE'];
    if (!allowed.includes(event.type)) {
      // prose-bound-exempt: fixed diagnostic template; ${state.status} is a
      // fixed enum run status, never agent- or attacker-controlled text.
      return [action('reject', { reason: `run is ${state.status}` })];
    }
  }

  switch (event.type) {
    case 'START': {
      if (state) return [action('reject', { reason: 'an active run already exists' })];
      return [
        action('acquire_lock'),
        action('transition', { patch: { status: 'running', stage: 'dispatch' } }),
        ...initialStages(event.run).map((stage) => action('issue_ticket', { stage })),
        action('persist_state'),
      ];
    }
    case 'NEXT': {
      const expired = expiredTicketIds(state);
      const pending = state.tickets.filter(
        (ticket) =>
          !expired.has(ticket.ticket_id) &&
          !state.receipts.some((receipt) => receipt.ticket_id === ticket.ticket_id),
      );
      const receiptRecoveries = pendingReceiptContractRecoveries(state, pending);
      if (receiptRecoveries.length > 0) {
        return receiptRecoveries.map((ticket) => action('dispatch_agent', {
          ticket_id: ticket.ticket_id,
          recovery_kind: 'redispatch_same_ticket',
          source_ticket_id: ticket.ticket_id,
          failure_domain: 'orchestration',
        }));
      }
      const at = Date.parse(event.at ?? '');
      const timedOut = Number.isFinite(at)
        ? pending.find((ticket) => {
            const deadline = Date.parse(ticket.deadline_at ?? '');
            return Number.isFinite(deadline) && deadline <= at;
          })
        : undefined;
      if (timedOut) {
        return expirePendingTicket(
          state,
          timedOut,
          `stage ${timedOut.stage_id} ticket deadline expired after retry`,
        );
      }
      if (pending.length > 0) return pending.map((ticket) => action('dispatch_agent', { ticket_id: ticket.ticket_id }));
      // A run resting in the non-blocking gating watch: NEXT is ONE bounded
      // gate-suite poll slice (the service's poll_gates handler owns the artifact
      // read, the in-call evaluation, and the pass/fail/pending transition). A
      // 'gating' state with no persisted watch is degenerate — fall through.
      if (state.status === 'gating' && state.gates_watch) {
        return [action('poll_gates')];
      }
      // A run resting in the non-blocking shipping watch: NEXT is ONE bounded
      // remote-checks poll slice (the service's poll_shipping handler owns the
      // single gh call and the merge/pending/failed transition), not the idle
      // status echo. A 'shipping' state with no persisted watch block is
      // degenerate — fall through to the status action.
      if (state.status === 'shipping' && state.shipping_watch) {
        return [action('poll_shipping')];
      }
      return [action('status', { state })];
    }
    case 'PREFLIGHT_RECORDED': {
      const questions = Array.isArray(event.questions) ? event.questions : [];
      if (
        state.status === 'input_required' &&
        state.input_required?.preflight_hash === event.preflight_hash &&
        JSON.stringify(state.input_required?.questions ?? []) === JSON.stringify(questions)
      ) return [];
      if (questions.length > 0) {
        return [action('transition', {
          patch: {
            status: 'input_required',
            stage: 'preflight',
            input_required: {
              preflight_hash: event.preflight_hash,
              questions,
            },
          },
        }), action('persist_state')];
      }
      return [
        action('transition', { patch: { status: 'running', stage: 'preflight' } }),
        ...nextStages(state, 'preflight', event.receipt ?? { status: 'passed', evidence: {} })
          .map((next) => action('issue_ticket', { stage: next })),
        action('persist_state'),
      ];
    }
    case 'PREFLIGHT_ANSWERED': {
      const additions = event.additions ?? {};
      const claimedPaths = [...new Set([...(state.claimed_paths ?? []), ...(additions.claimed_paths ?? [])])];
      const testPaths = [...new Set([...(state.test_paths ?? []), ...(additions.test_paths ?? [])])];
      const riskTriggers = [...new Set([...(state.risk_triggers ?? []), ...(additions.risk_triggers ?? [])])];
      const fallbackEscalated = state.lane === 'fast' && (additions.risk_triggers ?? []).length > 0;
      const lane = event.reclassification?.lane ?? (fallbackEscalated ? 'full' : state.lane);
      const escalated = lane !== state.lane;
      const patch = {
        status: 'running',
        stage: lane === 'full' ? 'plan' : 'test',
        claimed_paths: claimedPaths,
        test_paths: testPaths,
        risk_triggers: riskTriggers,
        lane,
        ...(event.reclassification?.reasons?.length
          ? { lane_reasons: [...new Set([...(state.lane_reasons ?? []), ...event.reclassification.reasons])] }
          : {}),
        high_risk: state.high_risk === true || riskTriggers.length > 0,
        preflight: {
          ...(state.preflight ?? {}),
          answers: event.answers,
          ...(escalated ? { escalated_from: 'fast' } : {}),
        },
        audit: [...(state.audit ?? []), {
          type: 'preflight_answered',
          preflight_hash: event.preflight_hash,
          answer_ids: event.answer_ids ?? [],
          // prose-bound-exempt: answerPreflight neutralizes this operator reason with boundedGateSummary before constructing the event.
          reason: event.reason,
          additions: {
            claimed_paths: additions.claimed_paths ?? [],
            test_paths: additions.test_paths ?? [],
            risk_triggers: additions.risk_triggers ?? [],
          },
          lane,
          ...(escalated ? { escalated_from: 'fast' } : {}),
        }],
      };
      return [
        action('clear_preflight_input'),
        action('transition', { patch }),
        action('audit_override', {
          operation: 'preflight-answer',
          // prose-bound-exempt: answerPreflight neutralizes this operator reason with boundedGateSummary before constructing the event.
          reason: event.reason,
        }),
        ...nextStages({ ...state, ...patch }, 'preflight', { status: 'passed', evidence: {} })
          .map((next) => action('issue_ticket', { stage: next })),
        action('persist_state'),
      ];
    }
    case 'RECEIPT_RECORDED': {
      const { ticket, receipt } = event;
      const nextState = event.next_state ?? state;

      // test-contradiction-verification: one read-only reconciliation, then at
      // most one exact-scope test recheck. These recovery stages are scheduler
      // owned and single-attempt; a failed/expired verifier never falls into
      // the generic retry machinery.
      if (ticket.stage_id === 'test-reconcile') {
        if (receipt.status !== 'passed') {
          if (receipt.evidence?.failure_kind === 'capability') {
            return capabilityRecoveryBlock(nextState, ticket, receipt);
          }
          return terminalRecoveryBlock(
            'test-reconcile',
            'the single independent test-contradiction reconciliation attempt could not complete',
            { terminal_reason_code: 'test_contradiction' },
          );
        }
        if (groupOutcome([receipt]) === 'disagreed') {
          const context = state.test_contradiction_pending?.context
            ?? ticket.test_reconciliation;
          const confirmedTestPaths = confirmedContradictionPaths(ticket, receipt);
          if (!context?.test_paths?.length || confirmedTestPaths.length === 0) {
            return terminalRecoveryBlock(
              'test-reconcile',
              'the reconciler returned a negative verdict without a blocking test-owned finding on an exact authorized reconciliation path',
              { terminal_reason_code: 'test_contradiction' },
            );
          }
          const narrowedContext = { ...context, test_paths: confirmedTestPaths };
          const findings = reviewFindings.select(nextState, [receipt]);
          const findingEvidence = reviewFindings.evidence(nextState, [receipt]);
          return [
            action('transition', {
              patch: {
                test_contradiction_pending: {
                  ...state.test_contradiction_pending,
                  context: narrowedContext,
                },
                test_contradiction_resolution: {
                  verdict: 'test-correction-required',
                  receipt_id: receipt.receipt_id ?? null,
                  confirmed_test_path_count: confirmedTestPaths.length,
                },
              },
            }),
            ...nextStages(nextState, 'test-contradiction-confirmed', receipt).map((stage) =>
              action('issue_ticket', {
                stage,
                test_reconciliation: narrowedContext,
                ...(findings.length ? { review_findings: findings } : {}),
                ...(findingEvidence.length ? { review_finding_evidence: findingEvidence } : {}),
              })),
            action('persist_state'),
          ];
        }
        if ((receipt.findings ?? []).some((finding) => finding?.blocking === true)) {
          return terminalRecoveryBlock(
            'test-reconcile',
            'the reconciler returned a positive verdict with a blocking contradiction finding; refusing inconsistent recovery evidence',
            { terminal_reason_code: 'test_contradiction' },
          );
        }
        return retryContradictionSource(nextState, {
          verdict: 'implementation-correction-required',
          receipt_id: receipt.receipt_id ?? null,
        });
      }

      if (ticket.stage_id === 'test-recheck') {
        if (receipt.status !== 'passed') {
          if (receipt.evidence?.failure_kind === 'capability') {
            return capabilityRecoveryBlock(nextState, ticket, receipt);
          }
          return terminalRecoveryBlock(
            'test-recheck',
            'the single exact-scope test correction attempt failed; refusing an unbounded test-authoring loop',
            { terminal_reason_code: 'test_contradiction' },
          );
        }
        return retryContradictionSource(nextState, {
          verdict: 'test-corrected',
          receipt_id: receipt.receipt_id ?? null,
        });
      }

      // friction #23: a non-passed receipt from a review-group stage falls through to
      // the parallel-group outcome below as a disagree vote instead of
      // consuming the verbatim retry. For code-review (review, security-review,
      // remediation-review, remediation-security-review) the receipt is a
      // verdict on the work, not a stage malfunction — retrying the identical
      // review against a byte-identical tree is provably futile — and dissent
      // enters bounded, strict-subset remediation. For plan-review (plan-check,
      // plan-critic) the runtime cannot distinguish a negative verdict from a
      // malfunction, so the vote routes to the plan-judge via the
      // plan-review-disagreed synthetic — the judge, not a verbatim re-check,
      // adjudicates — consuming no stage attempt and no remediation cycle.
      // The failure_kind carve-outs below are unreachable for review-group
      // receipts by design. Test-contradiction markers remain dissent votes;
      // capability denials are detected after every group member settles and
      // then terminate with structured successor guidance, because neither
      // code remediation nor a plan judge can repair missing immutable
      // authority. plan-judge itself has NO parallel group, so a failed judge
      // receipt keeps the verbatim retry. The explicit group list is
      // deliberate: a future parallel group must decide its routing here
      // rather than inherit it. The verbatim retry remains for stages whose
      // failure means the stage could not do its work.
      const reviewVote = ['code-review', 'plan-review'].includes(event.stage.parallel_group);
      if (receipt.status !== 'passed' && !reviewVote) {
        // A capability failure — evidence.failure_kind 'capability', reported
        // when the immutable ticket lacks required authority — cannot be fixed
        // by replaying that ticket, so it blocks with structured successor
        // guidance. Correctable policy/command syntax mistakes use the distinct
        // `command-shape` failure kind from prompts/common.md and receive the
        // ordinary retry below with the exact denial in prior_attempts. A
        // capability-marked review receipt is handled after group convergence,
        // and the marker is ignored on a passed receipt.
        const capabilityBlocked = receipt.evidence?.failure_kind === 'capability';
        const protocolRecovery = workerProtocolRecovery(nextState, ticket, receipt);
        if (protocolRecovery) return protocolRecovery;
        // A test-contradiction marker is an unverified implementer claim, not a
        // runtime verdict. A verbatim writer retry would be futile, while
        // immediately asserting that the test is faulty would violate truthful
        // completion. Route one read-only reviewer reconciliation instead. If
        // it rejects the claim, the original writer gets its remaining attempt;
        // if it confirms the claim, one exact-scope test_writer recheck runs
        // before that same writer retry. The persisted counter makes the whole
        // route single-cycle: another claim, verifier failure, or recheck
        // failure blocks fail-closed without an authoring loop. Review-group
        // markers remain dissent votes and passed-receipt markers stay inert.
        const testContradiction =
          receipt.evidence?.failure_kind === 'test-contradiction' &&
          ticket.role === 'implementer' &&
          state.behavioral !== false &&
          (ticket.test_paths?.length ?? state.test_paths?.length ?? 0) > 0;
        if (testContradiction) {
          if ((state.test_contradiction_reconciliations ?? 0) >= 1) {
            return terminalRecoveryBlock(
              ticket.stage_id,
              `stage ${ticket.stage_id} reported another test contradiction after the bounded reconciliation cycle`,
              { terminal_reason_code: 'test_contradiction' },
            );
          }
          const context = reviewFindings.testReconciliation(ticket, receipt);
          const findings = reviewFindings.select(nextState, [receipt]);
          return [
            action('transition', {
              patch: {
                test_contradiction_reconciliations: 1,
                test_contradiction_pending: {
                  source_ticket_id: ticket.ticket_id,
                  source_stage_id: ticket.stage_id,
                  context,
                },
              },
            }),
            ...nextStages(nextState, 'test-contradiction-reported', receipt).map((stage) =>
              action('issue_ticket', {
                stage,
                test_reconciliation: context,
                ...(findings.length ? { review_findings: findings } : {}),
              })),
            action('persist_state'),
          ];
        }
        const noRetryFault = capabilityBlocked;
        const attempts = state.attempts[ticket.stage_id] ?? 1;
        if (!noRetryFault && attempts < MAX_STAGE_ATTEMPTS) {
          // Thread receipt-derived failure evidence onto the retry: the bounded
          // per-attempt summaries (this failing receipt included) as
          // prior_attempts when informative, and — for a remediation-build or
          // remediation-test retry — the review group's findings and any
          // accepted scope expansion the failed ticket carried, forwarded
          // unchanged so the grounded evidence survives the retry. Keys
          // attach only when non-empty so an ordinary retry stays
          // byte-identical.
          const { entries: priorAttempts, informative } = reviewFindings.attemptSummaryList(
            state,
            ticket.stage_id,
            ticket.ticket_id,
            receipt,
          );
          return [
            action('transition', {
              patch: {
                attempts: { ...state.attempts, [ticket.stage_id]: attempts + 1 },
                orchestration: withOrchestrationIncrement(state, 'stage_retries'),
              },
            }),
            action('issue_ticket', {
              stage: event.stage,
              retry_of: ticket.ticket_id,
              recovery_kind: 'stage_retry',
              ...(informative && priorAttempts.length ? { prior_attempts: priorAttempts } : {}),
              ...(Array.isArray(ticket.review_findings) && ticket.review_findings.length
                ? { review_findings: ticket.review_findings }
                : {}),
              ...(Array.isArray(ticket.review_finding_evidence) && ticket.review_finding_evidence.length
                ? { review_finding_evidence: ticket.review_finding_evidence }
                : {}),
              ...(ticket.scope_expansion ? { scope_expansion: ticket.scope_expansion } : {}),
              ...(ticket.plan_recovery ? { plan_recovery: ticket.plan_recovery } : {}),
              ...(ticket.test_reconciliation ? { test_reconciliation: ticket.test_reconciliation } : {}),
            }),
            action('persist_state'),
          ];
        }
        return [
          action('transition', {
            patch: {
              status: 'blocked',
              stage: ticket.stage_id,
              // prose-bound-exempt: every branch's fixed template text is never
              // agent-controlled; ${ticket.stage_id} is a fixed schema-declared
              // stage id. The only agent-authored text this block_reason
              // carries is what attemptSummaries appends, which routes each
              // entry through flattenReviewText (below) before its
              // BLOCK_SUMMARY_LIMIT cap, so it is control/bidi-neutralized and
              // length-capped, never raw.
              block_reason: testContradiction
                ? `stage ${ticket.stage_id} test-contradiction-blocked (implementer reported the authored test contradicts itself or the ticket — an unverified agent claim; confirm it before re-authoring the test or debugging the implementation)${reviewFindings.attemptSummaries(state, ticket.stage_id, ticket.ticket_id, receipt)}`
                : capabilityBlocked
                  ? `stage ${ticket.stage_id} capability-blocked${reviewFindings.attemptSummaries(state, ticket.stage_id, ticket.ticket_id, receipt)}`
                  // prose-bound-exempt: every branch above is a fixed
                  // diagnostic template; ${ticket.stage_id} is a fixed
                  // schema-declared stage id; attemptSummaries routes each
                  // entry through flattenReviewText (below) before its
                  // BLOCK_SUMMARY_LIMIT cap, so it is control/bidi-neutralized
                  // and length-capped, never raw agent free text.
                  : `stage ${ticket.stage_id} failed twice${reviewFindings.attemptSummaries(state, ticket.stage_id, ticket.ticket_id, receipt)}`,
              ...(capabilityBlocked
                  ? {
                    terminal_reason_code: 'capability_blocked',
                    failure_domain: 'configuration',
                    failure_domain_taxonomy_version: FAILURE_DOMAIN_TAXONOMY_VERSION,
                    blocked_recovery: reviewFindings.capabilityResolution(state, ticket, receipt),
                  }
                : {}),
            },
          }),
          action('archive_history', { if_absent: true }),
          action('release_lock'),
          action('persist_state'),
        ];
      }

      if (event.stage.parallel_group) {
        const outstanding = activeTickets(event.next_state ?? state, event.stage.parallel_group);
        if (outstanding.length > 0) return [action('persist_state')];
        const receipts = completedForGroup(event.next_state ?? state, event.stage.parallel_group);
        // A capability denial from a read-only group member is an environment /
        // immutable-authority failure, not a review verdict that code
        // remediation or a plan judge can repair. Wait for the group to settle
        // so parallel dispatch remains deterministic, then preserve the exact
        // additive claims and successor guidance in the same terminal envelope
        // used by non-group stages.
        const capabilityReceipt = receipts.find((entry) =>
          entry.status === 'failed' && entry.evidence?.failure_kind === 'capability');
        if (capabilityReceipt) {
          const sourceTicket = (event.next_state ?? state).tickets.find(
            (entry) => entry.ticket_id === capabilityReceipt.ticket_id,
          );
          if (!sourceTicket) {
            return terminalRecoveryBlock(
              event.stage.parallel_group,
              'a parallel reviewer reported a capability denial but its immutable source ticket is unavailable',
              {
                terminal_reason_code: 'capability_blocked',
                failure_domain: 'configuration',
                failure_domain_taxonomy_version: FAILURE_DOMAIN_TAXONOMY_VERSION,
              },
            );
          }
          return capabilityRecoveryBlock(event.next_state ?? state, sourceTicket, capabilityReceipt);
        }
        // A failed group member did not cast a product verdict. Route transport
        // and receipt-contract failures before groupOutcome so they can never
        // vote, trigger a judge, or consume remediation.
        const failedWorkerReceipt = receipts.find((entry) =>
          workerFailureDomain(entry, { reviewGroup: true }) !== null);
        if (failedWorkerReceipt) {
          const sourceTicket = (event.next_state ?? state).tickets.find(
            (entry) => entry.ticket_id === failedWorkerReceipt.ticket_id,
          );
          if (!sourceTicket) {
            return terminalRecoveryBlock(
              event.stage.parallel_group,
              'a parallel worker failed its protocol contract but its immutable source ticket is unavailable',
              {
                terminal_reason_code: 'worker_protocol_failure',
                failure_domain: 'orchestration',
                failure_domain_taxonomy_version: FAILURE_DOMAIN_TAXONOMY_VERSION,
              },
            );
          }
          return workerProtocolRecovery(
            event.next_state ?? state,
            sourceTicket,
            failedWorkerReceipt,
            { reviewGroup: true },
          );
        }
        const outcome = groupOutcome(receipts);
        const synthetic = event.stage.parallel_group === 'plan-review'
          ? `plan-review-${outcome}`
          : `review-${outcome}`;
        if (synthetic === 'plan-review-agreed') {
          const sealed = sealApprovedPlan(event.next_state ?? state, 'unanimous');
          if (sealed === null) return planSealFailureActions();
          return [
            ...(sealed ? [action('transition', { patch: { approved_plan: sealed } })] : []),
            ...nextStages(state, synthetic, receipt).map((stage) => action('issue_ticket', { stage })),
            action('persist_state'),
          ];
        }
        if (synthetic === 'review-agreed') {
          // A risk trigger (or scope expansion) reported on this final
          // agreeing receipt armed high_risk via SCOPE_EXPANDED after the last
          // point nextStages could schedule the security review. Entering the
          // gates now would arm conditional_audits with no schedulable path to
          // the receipt it requires — a REGATE-proof dead end — so the
          // armed-but-unsatisfied review is issued here and the group
          // re-converges through this same exit once its receipt lands
          // (agreed → gates; disagreed → bounded strict-subset remediation). Also
          // covers mode land, whose review-only pipeline shares the gap:
          // security_reviewer is read-only, so the land no-writing-stage guard
          // stays silent.
          const pending = pendingSecurityReviewStages(event.next_state ?? state);
          if (pending.length > 0) {
            return [
              ...pending.map((stage) => action('issue_ticket', { stage })),
              action('persist_state'),
            ];
          }
          return [action('run_gates'), action('persist_state')];
        }
        if (synthetic === 'review-disagreed') {
          const fingerprints = reviewFindings.fingerprints(receipts);
          const previousFingerprints = state.remediation_finding_fingerprints ?? [];
          const remediationInProgress = state.remediation_cycles > 0;
          const effectiveRemediationLimit = remediationCycleLimit(state);
          const strictProgress = remediationInProgress &&
            isStrictProperSubset(fingerprints, previousFingerprints);
          if (
            remediationInProgress &&
            state.remediation_cycles >= effectiveRemediationLimit
          ) {
            return [
              action('transition', {
                patch: {
                  status: 'blocked',
                  stage: 'remediation',
                  // prose-bound-exempt: effectiveRemediationLimit is a runtime-clamped integer.
                  block_reason: `review disagreement reached the configured remediation budget (${effectiveRemediationLimit} cycles)`,
                },
              }),
              action('archive_history', { if_absent: true }),
              action('release_lock'),
              action('persist_state'),
            ];
          }
          if (remediationInProgress && !strictProgress) {
            const repeatedFinding =
              fingerprints.length > 0 &&
              fingerprints.length === new Set(previousFingerprints).size &&
              fingerprints.every((fingerprint) => new Set(previousFingerprints).has(fingerprint));
            return [
              action('transition', {
                patch: {
                  status: 'blocked',
                  stage: 'remediation',
                  // prose-bound-exempt: all branches are fixed runtime diagnostics; no reviewer text is interpolated.
                  block_reason: fingerprints.length === 0
                    ? 'review disagreement persists after a remediation cycle without a comparable structured finding set'
                    : repeatedFinding
                      ? 'a repeated review finding made no remediation progress'
                      : 'review remediation findings did not make strict subset progress and expanded or became incomparable',
                },
              }),
              action('archive_history', { if_absent: true }),
              action('release_lock'),
              action('persist_state'),
            ];
          }
          if (state.remediation_cycles < remediationCycleLimit(state)) {
            // Embed the review group's grounded, stage-labeled findings onto the
            // remediation-build ticket so the remediation works from the
            // reviewer's pinpointed file:line evidence instead of rediscovering
            // it from the diff. Computed from the same completedForGroup receipts
            // that produced the disagreement; the key attaches only when non-empty.
            const findings = reviewFindings.select(event.next_state ?? state, receipts);
            const findingEvidence = reviewFindings.evidence(event.next_state ?? state, receipts);
            // The identical state-derived read for any accepted scope
            // expansion — see groupScopeExpansion above for why reading the
            // whole completed group, rather than only this receipt, is what
            // makes the disclosure survive a multi-member group regardless of
            // arrival order.
            const scopeExpansion = groupScopeExpansion(event.next_state ?? state, receipts);
            const remediationRoute = structuredRemediationRoute(event.next_state ?? state, receipts);
            const routedState = remediationRoute
              ? { ...state, remediation_route: remediationRoute }
              : state;
            return [
              action('transition', {
                patch: {
                  remediation_cycles: state.remediation_cycles + 1,
                  orchestration: withOrchestrationIncrement(state, 'remediation_cycles'),
                  remediation_finding_fingerprints: fingerprints,
                  remediation_finding_count: fingerprints.length,
                  ...(findingEvidence.length
                    ? { remediation_finding_evidence: findingEvidence }
                    : {}),
                  ...(remediationRoute ? { remediation_route: remediationRoute } : {}),
                },
              }),
              ...nextStages(routedState, synthetic, receipt).map((stage) => action('issue_ticket', {
                stage,
                recovery_kind: 'remediate_product_finding',
                ...(findings.length ? { review_findings: findings } : {}),
                ...(findingEvidence.length
                  ? { review_finding_evidence: findingEvidence }
                  : {}),
                ...(scopeExpansion ? { scope_expansion: scopeExpansion } : {}),
              })),
              action('persist_state'),
            ];
          }
          return [
            action('transition', {
              patch: {
                status: 'blocked',
                stage: 'remediation',
                // prose-bound-exempt: remediationCycleLimit returns a runtime-clamped integer from 1 through 10.
                block_reason: `review disagreement reached the configured remediation budget (${remediationCycleLimit(state)} cycles)`,
              },
            }),
            action('archive_history', { if_absent: true }),
            action('release_lock'),
            action('persist_state'),
          ];
        }
        // Roadmap entry forwarded-evidence-and-judge-visibility. plan-judge has
        // no parallel group and spends no remediation cycle (friction #22
        // below), so it never reaches the review-disagreed arm above — but the
        // judge still adjudicates a plan-check/plan-critic disagreement whose
        // own dissent text no channel delivered it (prompts/plan_judge.md tells
        // the judge to weigh "the dissent" while nothing attached it). Reuse
        // the IDENTICAL grounded, stage-labeled findings machinery
        // (reviewFindings / boundReviewFinding / boundReviewFindingsBlock, the
        // same three ceilings) a remediation-build ticket already receives,
        // computed from the same completedForGroup receipts that produced this
        // disagreement — never a second, divergent implementation.
        if (synthetic === 'plan-review-disagreed') {
          const findings = reviewFindings.select(event.next_state ?? state, receipts);
          const findingEvidence = reviewFindings.evidence(event.next_state ?? state, receipts);
          return [
            ...nextStages(state, synthetic, receipt).map((stage) => action('issue_ticket', {
              stage,
              ...(findings.length ? { review_findings: findings } : {}),
              ...(findingEvidence.length
                ? { review_finding_evidence: findingEvidence }
                : {}),
            })),
            action('persist_state'),
          ];
        }
        return [
          ...nextStages(state, synthetic, receipt).map((stage) => action('issue_ticket', { stage })),
          action('persist_state'),
        ];
      }

      // plan-directed-replan: a negative judge verdict is structured direction.
      // After the first cycle, another replan is allowed only when the bounded
      // assurance identity set is a strict proper subset. Two directed replans
      // is the immutable ceiling.
      if (ticket.stage_id === 'plan-judge' && groupOutcome([receipt]) === 'disagreed') {
        const recovery = reviewFindings.planRecovery(nextState, ticket, receipt);
        const cycles = state.plan_replan_cycles ?? 0;
        const priorIdentities = assuranceIdentitySet(
          state.plan_recovery?.missing_assurances,
        );
        const nextIdentities = assuranceIdentitySet(
          recovery.missing_assurances,
        );
        const strictProgress = cycles === 0 || (
          declaredAssurancesAreCompletelyNormalized(receipt, recovery) &&
          priorIdentities !== null &&
          nextIdentities !== null &&
          isStrictProperSubset(nextIdentities, priorIdentities)
        );
        if (cycles < MAX_DIRECTED_REPLANS && strictProgress) {
          recovery.attempt = cycles + 1;
          return [
            action('transition', {
              patch: {
                plan_replan_cycles: cycles + 1,
                plan_recovery: recovery,
                orchestration: withOrchestrationIncrement(state, 'directed_replans'),
              },
            }),
            ...nextStages(nextState, 'plan-replan-required', receipt).map((stage) =>
              action('issue_ticket', {
                stage,
                recovery_kind: 'directed_replan',
                plan_recovery: recovery,
              })),
            action('persist_state'),
          ];
        }
        const ceilingReached = cycles >= MAX_DIRECTED_REPLANS;
        return terminalRecoveryBlock(
          'plan-judge',
          ceilingReached
            ? 'plan judged unsound after the two directed replan ceiling was exhausted'
            : 'plan judged unsound because assurance progress was not a strict proper subset of the prior structured set',
          {
            terminal_reason_code: 'planning_rejected',
            blocked_recovery: {
              reason_code: ceilingReached
                ? 'plan_replan_ceiling_exhausted'
                : 'plan_progress_not_strict_subset',
              directed_replan_attempts: cycles,
              missing_assurances: recovery.missing_assurances,
            },
          },
        );
      }

      const following = nextStages(state, ticket.stage_id, receipt);
      if (following.length > 0) {
        const sealed = ticket.stage_id === 'plan-judge'
          ? sealApprovedPlan(event.next_state ?? state, 'judge', receipt)
          : undefined;
        if (sealed === null) return planSealFailureActions();
        return [
          ...(sealed ? [action('transition', { patch: { approved_plan: sealed } })] : []),
          ...following.map((stage) => action('issue_ticket', { stage })),
          action('persist_state'),
        ];
      }
      if (ticket.stage_id === 'build' && state.lane === 'mechanical') {
        // The mechanical lane schedules no review group, so a trigger declared
        // at start or reported on this build receipt has no build→review point
        // to schedule the security review its armed conditional_audits gate
        // requires. Issue it here instead of running gates that
        // deterministically fail; its receipt re-enters through the
        // code-review group outcome above.
        const pending = pendingSecurityReviewStages(event.next_state ?? state);
        if (pending.length > 0) {
          return [
            ...pending.map((stage) => action('issue_ticket', { stage })),
            action('persist_state'),
          ];
        }
        return [action('run_gates'), action('persist_state')];
      }
      return [
        action('transition', { patch: { status: 'completed', stage: 'complete' } }),
        action('archive_history'),
        action('release_lock'),
        action('persist_state'),
      ];
    }
    case 'GATES_PASSED':
      // 'shipping' is no longer only a transient in-call state: with required
      // remote checks, auto_merge pushes + opens the PR and rests the run HERE
      // (status 'shipping', stage 'merge', a persisted shipping_watch, lock
      // still held), and each later `ape_run next` polls once via the NEXT
      // poll_shipping arm above until the checks go green and the merge lands.
      // required_remote_checks:false still merges in-call, so auto_merge reaches
      // MERGED within this same chain.
      return [
        action('transition', { patch: { status: 'shipping', stage: 'merge' } }),
        action('auto_merge'),
        action('persist_state'),
      ];
    case 'MERGED':
      return [
        action('transition', { patch: { status: 'completed', stage: 'complete', merge: event.merge } }),
        // A run that was re-gated OR held-then-shipped already has an immutable
        // block-time record in history (F7): a re-gate archived a gate-block
        // record, a hold archived its block-at-merge record. Its eventual
        // completion must NOT mutate that record — it is appended as a
        // superseding record that references the block record. A run that
        // reached merge on the uninterrupted first evaluation (no re-gate, no
        // hold-then-ship) archives its first record normally.
        action('archive_history', { superseding: (state.regate_attempts ?? 0) > 0 || state.ship_requested === true }),
        action('release_lock'),
        action('persist_state'),
      ];
    case 'GATES_FAILED': {
      // A ship authorization covers exactly one gate evaluation: clear
      // ship_requested so a later REGATE that goes green re-enters the
      // auto-merge hold instead of silently merging under shipping.auto_merge
      // !== true. Capture it first — a red ship's failed re-gate must reach
      // immutable history truthfully.
      const shipped = state.ship_requested === true;
      return [
        action('transition', {
          // prose-bound-exempt: event.reason on GATES_FAILED is always one of this
          // runtime's own fixed gate-diagnostic strings (the service's
          // reduceRun(GATES_FAILED) callers and gates.js's pollGateSuite failure
          // messages), never agent- or attacker-controlled text.
          patch: { status: 'blocked', stage: 'gates', block_reason: event.reason ?? 'merge gates failed', ship_requested: null },
        }),
        // A gate-blocked run must reach immutable history at the moment it
        // blocks (F7), not only when an operator later aborts or resets it. A
        // red SHIP is the one gate failure whose block-time record already
        // exists — the hold record (status blocked, stage merge, PASSING
        // gates) archived when the run first held. if_absent would keep that
        // stale record and lose the ship's failing-gate evidence (invariants 4
        // and 8), so a shipped failure archives a SUPERSEDING record carrying
        // the real failed gates; a plain first gate block (and a REGATE
        // re-failure, whose block-time record is itself a truthful gate block)
        // stays if_absent.
        action('archive_history', shipped ? { superseding: true } : { if_absent: true }),
        action('release_lock'),
        action('persist_state'),
      ];
    }
    case 'REGATE': {
      // Runtime-owned recovery for a run that blocked at the merge gates: after
      // the operator fixes the environment, re-gate re-runs the FULL gate suite
      // with no bypass and no waiver (invariant 9) — it reacquires the run lock
      // and re-enters the same run_gates path the first evaluation used. It is
      // valid ONLY for a gate block (status 'blocked', stage 'gates'); a
      // stage-failure or remediation block is not recoverable this way. The
      // reject names the audited alternative so the dead end is
      // self-documenting for the operator who tried it. When
      // test_commands.full_serial is configured, the re-gate full-suite run
      // uses the serialized variant (serial re-gate, 2.0.32; gates.js) — same suite, no waiver.
      if (state.status !== 'blocked' || state.stage !== 'gates') {
        // A run resting in a non-blocking watch is refused here too (it is not
        // blocked), and that refusal must not steer the operator at a recovery
        // that destroys healthy in-flight work.
        const resting = restStateGuidance(state);
        if (resting) {
          // prose-bound-exempt: fixed diagnostic template; ${resting} is
          // restStateGuidance's own fixed prose, whose only variable substring
          // (the persisted gate/shipping last_summary) is already bounded via
          // boundedGateSummary at the point it was persisted (service.js).
          return [action('reject', { reason: `re-gate is valid only for a gate-blocked run; ${resting}` })];
        }
        // Point an operator who reflexively re-gated a merge-hold at the correct
        // lever (SHIP) rather than only at the audited abort/reset dead end.
        // Keyed on block_reason, which only a genuinely blocked run carries —
        // both rest states (block_reason null) already returned above, so this
        // key drops no hint that could have applied.
        const shipHint = state.stage === 'merge' && state.block_reason === AUTO_MERGE_HOLD_REASON
          ? '; a run held at merge by disabled auto-merge is gate-and-merged with the audited SHIP lever'
          : '';
        // prose-bound-exempt: fixed diagnostic template; ${shipHint} is one of two
        // fixed string literals set two lines above, never agent-authored text.
        return [action('reject', { reason: `re-gate is valid only for a gate-blocked run; recover any other block through the audited OVERRIDE reset or ABORT${shipHint}` })];
      }
      const regateAttempts = state.regate_attempts ?? 0;
      if (regateAttempts >= MAX_REGATE_ATTEMPTS) {
        return [action('reject', {
          // prose-bound-exempt: fixed diagnostic template; ${MAX_REGATE_ATTEMPTS}
          // is a fixed numeric runtime constant, never agent-authored text.
          reason: `re-gate attempt limit reached (${MAX_REGATE_ATTEMPTS}); the gate block is exhausted`,
        })];
      }
      return [
        action('acquire_lock'),
        action('activate_run_branch'),
        action('transition', {
          patch: {
            status: 'running',
            stage: 'gates',
            // Each recovery consumes one bounded re-gate attempt.
            regate_attempts: regateAttempts + 1,
            // Leaving the terminal 'blocked' status: drop the block reason and
            // the block-time terminal stamp so an eventual completion re-stamps
            // a fresh terminal moment (F40) rather than reusing the block's.
            block_reason: null,
            terminal_at: null,
          },
        }),
        action('run_gates'),
        action('persist_state'),
      ];
    }
    case 'SHIP': {
      // Runtime-owned recovery for a run HELD at the merge gate by disabled
      // auto-merge (shipping.auto_merge !== true): green gates, but real
      // acceptance is out-of-band (hardware validation, manual checks), so the
      // run produced-and-held rather than merged. Ship re-runs the FULL
      // merge-gate suite against the CURRENT tree with no bypass and no waiver
      // (invariant 9 — the tree may have drifted while held, so the gates must
      // re-prove) and, on green, takes the same auto-merge path the first
      // evaluation would have; on red it lands in the ordinary gate block
      // (GATES_FAILED) where REGATE applies. Valid ONLY for the
      // auto-merge-disabled hold at stage 'merge', keyed on the exact reason so
      // no other stage-'merge' block is shippable by construction; the reject
      // names REGATE for a gate block and the audited exits for everything
      // else, mirroring the REGATE arm's self-documenting dead end.
      //
      // No ship attempt cap exists, and that is invariant 5 satisfied, not
      // violated: a green ship terminates the run, and every red exit lands in
      // the MAX_REGATE_ATTEMPTS-bounded gate block, so the hold↔ship↔regate
      // loop is transitively bounded. regate_attempts is left untouched, so a
      // previously-regated run's ship still selects test_commands.full_serial
      // through the existing serial re-gate signal (2.0.32).
      //
      // ship_requested is a ONE-SHOT authorization consumed by exactly one gate
      // evaluation: the service's auto_merge hold passes only while it is set,
      // and GATES_FAILED clears it. On a sealed completed run it persists as a
      // spent marker ("this run was shipped by operator action"), never as a
      // pending ship — MERGED admits no reader of it.
      if (state.status !== 'blocked' || state.stage !== 'merge' || state.block_reason !== AUTO_MERGE_HOLD_REASON) {
        // Same rest-state safety as the REGATE arm: a run already resting in a
        // watch is refused without being pointed at a run-destroying recovery.
        // The 'shipping' rest state is exactly where a re-issued SHIP lands
        // after a lost response, and aborting there kills an open PR.
        const resting = restStateGuidance(state);
        if (resting) {
          // A 'shipping' rest state with ship_requested still true can ONLY be
          // explained by the caller's OWN prior ship: this arm, just below, is
          // the sole place that ever sets it, and only GATES_FAILED (never
          // MERGED, which retains it as a spent marker) ever clears it. The
          // re-issue this covers is the lost-response case: the FIRST ship
          // already succeeded — it set ship_requested, re-ran the gates, and
          // GATES_PASSED rested the run here — so the refusal must attribute
          // the rest state to that prior success rather than lead with the
          // invalid-target prose below, which reads as the ship having done
          // nothing. Derived from state.ship_requested alone, so the reducer
          // stays pure; the ordinary (never-shipped) shipping rest state
          // keeps the unweakened invalid-target prose.
          if (state.status === 'shipping' && state.ship_requested === true) {
            // prose-bound-exempt: fixed diagnostic template; ${resting} is
            // restStateGuidance's own fixed prose (see the REGATE arm above).
            return [action('reject', { reason: `a prior ship on this run already succeeded — ${resting}` })];
          }
          // The 'gating' SIBLING of the case just above, closed together rather
          // than left half-fixed (rest-state ship-self-disclosure ticket, defect
          // 1): SHIP sets ship_requested true and emits run_gates, and a
          // detached gate suite that outlives gates.inline_grace_ms rests the
          // run HERE, in 'gating', with ship_requested still true — the
          // identical lost-response re-issue the shipping case covers, only
          // caught a few seconds earlier, while the very gate re-run this ship
          // triggered is still in flight. Same explanation as above (SHIP is the
          // sole setter of ship_requested, only GATES_FAILED — which this rest
          // state has by definition not yet reached — ever clears it), so the
          // same attribution applies. NOT the same wording, though: unlike the
          // shipping case, GATES_PASSED/GATES_FAILED has not fired yet here, so
          // the very ship that rests the run in this state could still fail its
          // own re-run of the gates. Saying it "already succeeded" would itself
          // be an untruthful disclosure (invariant 8); this says only that a
          // prior ship is why the gate suite is running, never how it ends.
          // Derived from state.ship_requested alone, so the reducer stays pure;
          // the ordinary (never-shipped) gating rest state keeps the unweakened
          // invalid-target prose below, same as the shipping case.
          if (state.status === 'gating' && state.ship_requested === true) {
            // prose-bound-exempt: fixed diagnostic template; ${resting} is
            // restStateGuidance's own fixed prose (see the REGATE arm above).
            return [action('reject', { reason: `a prior ship on this run triggered the gate suite now in progress — ${resting}` })];
          }
          // prose-bound-exempt: fixed diagnostic template; ${resting} is
          // restStateGuidance's own fixed prose (see the REGATE arm above).
          return [action('reject', { reason: `ship is valid only for a run held at merge by disabled auto-merge (shipping.auto_merge); ${resting}` })];
        }
        return [action('reject', { reason: 'ship is valid only for a run held at merge by disabled auto-merge (shipping.auto_merge); recover a gate block with REGATE and any other block through the audited OVERRIDE reset or ABORT' })];
      }
      return [
        action('acquire_lock'),
        action('activate_run_branch'),
        // prose-bound-exempt: constructs the audit_override action at reducer
        // level; the actual persistence sink (service.js's audit_override
        // handler) applies boundedGateSummary before this reason reaches
        // overrides.ndjson.
        action('audit_override', { operation: 'ship', reason: event.reason }),
        action('transition', {
          patch: {
            status: 'running',
            stage: 'gates',
            // One-shot authorization that passes the service auto_merge hold.
            ship_requested: true,
            // Leaving the terminal 'blocked' status: drop the block reason and
            // the block-time terminal stamp so an eventual completion re-stamps
            // a fresh terminal moment (F40) rather than reusing the hold's.
            block_reason: null,
            terminal_at: null,
          },
        }),
        action('run_gates'),
        action('persist_state'),
      ];
    }
    case 'SCOPE_EXPANDED': {
      // Mid-run escalation is a reduced transition, not an ad-hoc state write:
      // the event carries the already-classified lane, validated risk
      // triggers, and (for a review-proposed scope expansion, D3) the
      // service-validated claim paths; this arm derives the full patch —
      // including arming the security machinery (high_risk) — so pipeline
      // security-review and the conditional_audits gate observe every
      // reported trigger.
      const scope = event.scope ?? {};
      const patch = {};
      // Escalate-only at the reducer level: a mid-run scope expansion may raise
      // the lane, never lower it, and a lane the runtime does not recognize is
      // refused outright (indexOf -1, so it never outranks anything). 'auto' is
      // the lowest rank, so the pre-classification sentinel is refused too.
      // Without this guard the patch would write lane_escalated:true over a
      // DOWNGRADE — a lie in durable state. Nothing legitimate is refused:
      // escalateLane only ever escalates strictly upward in LANES, and the sole
      // emitter passes either a strict escalation or the current lane (which an
      // equal rank already excludes).
      if (typeof scope.lane === 'string' && LANES.indexOf(scope.lane) > LANES.indexOf(state.lane)) {
        patch.lane = scope.lane;
        patch.lane_escalated = true;
        patch.lane_reasons = [
          ...new Set([...(state.lane_reasons ?? []), ...(scope.lane_reasons ?? [])]),
        ];
      }
      const mergedTriggers = [
        ...new Set([...(state.risk_triggers ?? []), ...(scope.risk_triggers ?? [])]),
      ];
      // Keyed on trigger NAMES, not array LENGTH: a duplicate already sitting in
      // state.risk_triggers makes the merged (deduped) list no longer than the
      // stored one, which would silently drop a genuinely new trigger. Assigning
      // the deduped merged list also cleans up that pre-existing duplicate.
      if (mergedTriggers.some((trigger) => !(state.risk_triggers ?? []).includes(trigger))) {
        patch.risk_triggers = mergedTriggers;
      }
      if (mergedTriggers.length > 0 && state.high_risk !== true) {
        patch.high_risk = true;
      }
      // Claim growth is an override-class operation: audited BEFORE the
      // transition (the override idiom), so overrides.ndjson carries the
      // reason and exact added paths even if the transition never persists.
      // The next issued writing ticket (remediation-build) inherits the
      // expanded set through ticketClaims, which the write-time hook and
      // drift guard then honor — no hook change needed.
      const addedPaths = [...new Set(scope.claimed_paths ?? [])].filter(
        (claim) => !(state.claimed_paths ?? []).includes(claim),
      );
      if (addedPaths.length > 0) {
        patch.claimed_paths = [...(state.claimed_paths ?? []), ...addedPaths];
        // Roadmap entry forwarded-evidence-and-judge-visibility: record the
        // accepted growth durably, keyed by the PROPOSING ticket's own
        // ticket_id, so groupScopeExpansion (above) can read it back at
        // group-completion time regardless of which receipt in the group
        // arrives last — the state-derived shape declaredTestRemediationPaths
        // (pipeline.js) already uses for its own structural sibling channel.
        if (event.ticket_id) {
          patch.pending_scope_expansions = {
            ...(state.pending_scope_expansions ?? {}),
            [event.ticket_id]: {
              claimed_paths: addedPaths,
              // scope.reason is the reviewer's own scope_expansion reason,
              // forwarded by service.js from extractScopeExpansion's own
              // validated (non-empty) result; its only consumer,
              // issueTicket's scopeExpansionNotice (service.js), passes it
              // through boundedGateSummary via boundedScopeExpansion before
              // it ever reaches a ticket objective.
              // prose-bound-exempt: downstream reuse into an already-bounded
              // sink, not a new one — mirrors the audit_override reason a
              // few lines below.
              reason: scope.reason ?? null,
            },
          };
        }
      }
      if (Object.keys(patch).length === 0) return [action('persist_state')];
      return [
        ...(addedPaths.length > 0
          ? [action('audit_override', {
              operation: 'scope-expansion',
              // prose-bound-exempt: constructs the audit_override action at
              // reducer level; the actual persistence sink (service.js's
              // audit_override handler) applies boundedGateSummary before this
              // reason reaches overrides.ndjson.
              reason: scope.reason ?? 'review-proposed scope expansion',
              added_paths: addedPaths,
            })]
          : []),
        action('transition', { patch }),
        action('persist_state'),
      ];
    }
    case 'EXPIRE_DISPATCH': {
      // Audited operator lever for a wedged dispatch (frictions #27/#30): a bound intent
      // whose parent session died, or whose agent ended with prose instead of
      // the receipt, leaves the ticket pending until its deadline. Expiry takes
      // the deadline-timeout exit early — same retry budget, same honest block
      // — and is valid only for a named pending ticket of a running run.
      if (state.status !== 'running') {
        // prose-bound-exempt: fixed diagnostic template; ${state.status} is a
        // fixed enum run status, never agent- or attacker-controlled text.
        return [action('reject', { reason: `expire-dispatch is valid only for a running run (run is ${state.status})` })];
      }
      const ticket = state.tickets.find((entry) => entry.ticket_id === event.ticket_id);
      if (!ticket) {
        // prose-bound-exempt: fixed diagnostic template echoing the caller's own
        // ticket_id operand back in an unknown-ticket refusal, a known residual
        // (recorded, not closed, by roadmap sink-guard-coverage-and-detection-
        // completeness) — the operand is never persisted and never neutralized
        // on this path.
        return [action('reject', { reason: `expire-dispatch: unknown ticket ${event.ticket_id ?? '(unset)'}` })];
      }
      if (expiredTicketIds(state).has(ticket.ticket_id)) {
        // prose-bound-exempt: fixed diagnostic template; ticket.ticket_id is this
        // run's own runtime-generated ticket id, never agent-authored free text.
        return [action('reject', { reason: `expire-dispatch: ticket ${ticket.ticket_id} is already expired` })];
      }
      if (state.receipts.some((receipt) => receipt.ticket_id === ticket.ticket_id)) {
        // prose-bound-exempt: fixed diagnostic template; ticket.ticket_id is this
        // run's own runtime-generated ticket id, never agent-authored free text.
        return [action('reject', { reason: `expire-dispatch: ticket ${ticket.ticket_id} already has a receipt` })];
      }
      return [
        action('audit_override', {
          operation: 'expire-dispatch',
          ticket_id: ticket.ticket_id,
          // prose-bound-exempt: constructs the audit_override action at reducer
          // level; the actual persistence sink (service.js's audit_override
          // handler) applies boundedGateSummary before this reason reaches
          // overrides.ndjson.
          reason: event.reason,
        }),
        ...expirePendingTicket(
          state,
          ticket,
          `stage ${ticket.stage_id} dispatch expired by operator after retry`,
        ),
      ];
    }
    case 'ABORT':
      return [
        action('transition', { patch: { status: 'aborted', stage: 'aborted', abort_reason: event.reason } }),
        // if_absent: aborting an already-blocked run must not duplicate or
        // conflict with the record archived when the run became blocked (F7);
        // the block-time record wins, matching the override abort/reset paths.
        action('archive_history', { if_absent: true }),
        action('release_lock'),
        action('persist_state'),
      ];
    case 'OVERRIDE': {
      // Override terminations are runtime-owned transitions too: they must
      // archive to history before the run's state is deleted or sealed (F7),
      // so validation happens here — never after an archive already ran. The
      // operation itself validates FIRST: an unknown (or missing) operation
      // used to fall through to [audit_override, apply_override], appending a
      // permanent overrides.ndjson line for an override that then threw and
      // was never applied — a falsified entry in an audit log. applyActions'
      // apply_override throw stays as defense in depth.
      if (event.operation !== 'reset' && event.operation !== 'abort') {
        const got = event.operation === undefined ? '(unset)' : `'${event.operation}'`;
        // prose-bound-exempt: fixed diagnostic template echoing the caller's own
        // invalid operation operand back in the refusal, a known residual
        // (recorded, not closed, by roadmap sink-guard-coverage-and-detection-
        // completeness) — the operand is never persisted and never neutralized
        // on this path.
        return [action('reject', { reason: `override operation must be 'abort' or 'reset'; got ${got} — override cannot bypass evidence or merge gates` })];
      }
      if (event.operation === 'reset' && !TERMINAL_STATUSES.has(state.status)) {
        // friction #29: a running run always has a forward path — name the real levers
        // instead of leaving a wedged operator with an unusable refusal.
        //
        // DECISION, recorded rather than left unexamined (rest-state
        // ship-self-disclosure ticket, defect 2): 'gating' and 'shipping' are
        // absent from TERMINAL_STATUSES, so an override reset issued from
        // either healthy rest state also lands here and reads this same
        // "for a running run use abort" advice — while a detached gate suite
        // is running healthily or an open PR's remote checks are mid-flight.
        // Left AS-IS, deliberately, unlike the REGATE/SHIP rest-state fix
        // above (restStateGuidance): those levers are refused for a run that
        // ISN'T asking to be destroyed, so pointing them at OVERRIDE/ABORT is
        // a misdirection restStateGuidance exists to remove. An override
        // RESET call is the opposite case — the caller has already asked for
        // a destructive exit — so naming abort as the way to get one for a
        // running run is an honest answer to the request actually made, not
        // a misdirection. Routing this refusal through restStateGuidance too
        // would instead suppress the one lever whose entire purpose is to
        // destroy the run, second-guessing an explicit operator choice rather
        // than protecting an operator who never asked to abort anything. An
        // operator who wants the run to keep advancing already has NEXT (and
        // simply not calling OVERRIDE) — this guard only ever answers a call
        // that already chose override reset.
        return [action('reject', { reason: 'override reset is allowed only for a terminal or blocked run; for a running run use abort, or expire-dispatch to void a wedged in-flight dispatch' })];
      }
      if (event.operation === 'abort' && state.status === 'completed') {
        return [action('reject', { reason: 'a completed run cannot be overridden to aborted; use override reset' })];
      }
      // prose-bound-exempt: constructs the audit_override action at reducer
      // level; the actual persistence sink (service.js's audit_override handler)
      // applies boundedGateSummary before this reason reaches overrides.ndjson.
      const audit = action('audit_override', { reason: event.reason, operation: event.operation });
      if (event.operation === 'reset') {
        // Archive before apply_override removes active.json: a reset run must
        // reach history before the only copy of its state is erased (F7).
        return [
          audit,
          action('archive_history', { if_absent: true }),
          action('apply_override', { operation: 'reset' }),
        ];
      }
      return [
        audit,
        action('apply_override', { operation: 'abort' }),
        action('archive_history', { if_absent: true }),
        action('release_lock'),
        action('persist_state'),
      ];
    }
    case 'STATUS':
      return [action('status', { state })];
    default:
      // prose-bound-exempt: fixed diagnostic template; ${event.type} is the
      // internal dispatch event's own type tag, never agent-authored free text.
      return [action('reject', { reason: `unknown event type: ${event.type}` })];
  }
}
