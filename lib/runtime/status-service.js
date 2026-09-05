import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { rm } from 'node:fs/promises';
import { activeState, ACTIVE_STATE_MAX_BYTES } from './active-state.js';
import { boundedGateSummary } from './bounded-summary.js';
export { activeState, activeStateDiagnosisMatchesEntry, ACTIVE_STATE_MAX_BYTES } from './active-state.js';
export { boundedGateSummary, BOUNDED_SUMMARY_CONTROL_CHARS, codePointRange, REPLACEMENT_CHARACTER } from './bounded-summary.js';
import { AUTO_MERGE_HOLD_REASON, CHECKS_REGISTRATION_RETRY_DELAY_MS, GATE_INLINE_GRACE_MS, GATE_NEXT_MAX_WAIT_MS, GATE_NEXT_POLL_FLOOR_MS, GATE_POLL_RETRY_DELAY_MS, RISK_TRIGGERS, RUNTIME_VERSION, SCOPE_EXPANSION_REASONS_MAX, SEALED_STATUSES, TERMINAL_STATUSES } from './constants.js';
import { runtimePaths } from './paths.js';
import { atomicWriteJson, appendJsonLine } from './storage.js';
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
import { successorGuidanceForState } from './successor-guidance.js';
import {
  candidatePlanForScope,
  PLAN_CONTRACT_VERSION,
  validatePlanDeviation,
} from './plan-contract.js';
import { renderStatusDoc } from './status-doc.js';
import { isCanonicalRunId, projectRunDiagnostic, safeDiagnosticText, safeModelTier, validatedArchiveSnapshot } from './diagnostics.js';
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

export function checkoutCleanupIncomplete(state) {
  return (
    TERMINAL_STATUSES.has(state?.status) &&
    typeof state?.base_branch === 'string' &&
    state?.checkout_cleanup?.status !== 'returned'
  );
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

export async function dispatchLiveness(paths, state, { tolerateCorrupt = false } = {}) {
  const pending = pendingTicketIds(state);
  const dispatches = state && ['claude', 'codex'].includes(state.host)
    ? await dispatchIntentStatuses(paths, state, { tolerateCorrupt })
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
  const evidenceUnreadable = dispatches.some((dispatch) =>
    dispatch?.status === 'corrupt' || dispatch?.evidence_unreadable === true);
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
      evidenceUnreadable
        ? 'error'
        : liveTicketIds.size === pending.length
          ? 'live'
          : 'needs-redispatch',
    dispatches,
    live_ticket_ids: liveTicketIds,
    pending_ticket_ids: pending,
    live_lock: liveLock,
    ...(evidenceUnreadable ? { evidence_unreadable: true } : {}),
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
          : error.variant === 'unsafe'
            ? 'active run state path is unsafe (it is not a stable regular single-link file); recover with ape_run override operation reset (an audit reason is required) to quarantine the entry without following it and leave the runtime startable'
            : error.variant === 'oversized'
              ? `active run state is oversized (it exceeds the ${ACTIVE_STATE_MAX_BYTES}-byte limit); recover with ape_run override operation reset (an audit reason is required) to quarantine it and leave the runtime startable`
              // prose-bound-exempt: every branch is fixed runtime wording;
              // ACTIVE_STATE_MAX_BYTES is a source constant, never input text.
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
    ? await dispatchLiveness(paths, state, { tolerateCorrupt: true })
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
  if (dispatchState === 'error') return 'ape_run abort';
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
  const dispatchEvidenceUnreadable = dispatchState === 'error';
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
    : corrupt || dispatchEvidenceUnreadable
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
    : dispatchEvidenceUnreadable
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
    const proposal = await proposeTestCommands(paths.root, {
      behavioral: input.behavioral,
      test_paths: input.test_paths,
    });
    if (input.apply !== true) return { ok: true, init: proposal };

    // Repository instruction files belong to the repository and its operator.
    // Older APE clients could ask init to append an operational block to
    // AGENTS.md/AGENTS.override.md; runtime SessionStart guidance replaces that
    // mutable integration surface. Refuse stale apply requests explicitly and
    // before any config write so onboarding can never modify project prose.
    if (
      input.apply_agents !== undefined ||
      input.agents_path !== undefined ||
      input.agents_expected_hash !== undefined
    ) {
      throw new Error(
        'ape_config init no longer installs APE policy in AGENTS.md or AGENTS.override.md; APE supplies runtime-owned SessionStart guidance and leaves repository instructions untouched',
      );
    }

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
    // Refuse an empty effective set BEFORE any write — nothing was detected and
    // the operator supplied nothing to persist. A polyglot tree whose repo root
    // carries no manifest has an empty test_commands proposal but a non-empty
    // runners list, so the guard is relaxed to only refuse when BOTH are empty.
    const slots = whitelist.filter((slot) => slot in effective);
    if (slots.length === 0 && effectiveRunners.length === 0 && effectiveEvidenceScripts.length === 0) {
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
    // value before any config slot is changed. Otherwise crossing the
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
      },
    };
  }
  throw new Error(`unknown config action: ${action}`);
}
