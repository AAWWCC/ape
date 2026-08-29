import {
  FAILURE_DOMAINS,
  FAILURE_DOMAIN_TAXONOMY_VERSION,
  isFailureDomain,
  receiptFailureDomain,
} from './orchestration-telemetry.js';

export const TERMINAL_REASON_TAXONOMY_VERSION = 1;

// Privacy-safe, bounded operational outcomes. Codes describe runtime-owned
// lifecycle classes only; no operator/agent prose, paths, command output, or
// provider details are ever copied into this surface.
export const TERMINAL_REASON_CODES = Object.freeze([
  'completed',
  'aborted',
  'aborted_dispatch',
  'aborted_preflight',
  'aborted_planning',
  'aborted_test',
  'aborted_implementation',
  'aborted_review',
  'aborted_gating',
  'aborted_shipping',
  'aborted_investigation',
  'aborted_unclassified',
  'planning_rejected',
  'preflight_failed',
  'test_contradiction',
  'capability_blocked',
  'worker_protocol_failure',
  'dispatch_expired',
  'test_failed',
  'implementation_failed',
  'review_remediation_exhausted',
  'gate_failed',
  'shipping_hold',
  'shipping_failed',
  'stage_failed',
  'blocked_unclassified',
  'legacy_unclassified',
]);

const TERMINAL_REASON_SET = new Set(TERMINAL_REASON_CODES);
const PLANNING_STAGES = new Set(['plan', 'plan-replan', 'plan-check', 'plan-critic', 'plan-judge', 'plan-approval']);
const TEST_STAGES = new Set(['test', 'test-reconcile', 'test-recheck', 'remediation-test']);
const IMPLEMENTATION_STAGES = new Set(['build', 'implement', 'remediation-build']);
const REVIEW_STAGES = new Set([
  'review',
  'security-review',
  'remediation',
  'remediation-review',
  'remediation-security-review',
]);
const KNOWN_STAGES = new Set([
  ...PLANNING_STAGES,
  ...TEST_STAGES,
  ...IMPLEMENTATION_STAGES,
  ...REVIEW_STAGES,
  'preflight',
  'gates',
  'merge',
  'debug',
  'spike',
  'dispatch',
  'start',
]);
const SAFE_RECOVERY_TEXT = /^[^\u0000-\u001f\u007f-\u009f\u00ad\u061c\u200b-\u200f\u202a-\u202e\u2060-\u206f\ufff9-\ufffb]+$/u;
const SAFE_RUN_ID = /^run-[A-Za-z0-9][A-Za-z0-9_-]{0,123}$/;

function boundedRecoveryString(value, max) {
  return typeof value === 'string'
    && value.length > 0
    && value.length <= max
    && SAFE_RECOVERY_TEXT.test(value);
}

function boundedRecoveryList(value, maxItems = 64, maxLength = 512) {
  if (!Array.isArray(value) || value.length > maxItems) return null;
  const output = [];
  for (let index = 0; index < value.length; index += 1) {
    if (!Object.hasOwn(value, index) || !boundedRecoveryString(value[index], maxLength)) return null;
    output.push(value[index]);
  }
  return output;
}

function capabilityRecovery(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  if (
    value.reason_code !== 'capability_denied'
    || !boundedRecoveryString(value.source_ticket_id, 256)
    || !boundedRecoveryString(value.source_stage_id, 64)
    || typeof value.claims_reported !== 'boolean'
    || typeof value.successor_required !== 'boolean'
    || typeof value.supersession_required !== 'boolean'
    || typeof value.supersedes_run !== 'string'
    || !SAFE_RUN_ID.test(value.supersedes_run)
  ) return null;
  const claims = value.additive_claims;
  if (!claims || typeof claims !== 'object' || Array.isArray(claims)) return null;
  const claimedPaths = boundedRecoveryList(claims.claimed_paths);
  const testPaths = boundedRecoveryList(claims.test_paths);
  const toolClaims = boundedRecoveryList(claims.tool_claims);
  if (!claimedPaths || !testPaths || !toolClaims) return null;
  if (claims.required_role !== undefined && !boundedRecoveryString(claims.required_role, 64)) {
    return null;
  }
  return {
    reason_code: value.reason_code,
    source_ticket_id: value.source_ticket_id,
    source_stage_id: value.source_stage_id,
    additive_claims: {
      claimed_paths: claimedPaths,
      test_paths: testPaths,
      tool_claims: toolClaims,
      ...(claims.required_role === undefined ? {} : { required_role: claims.required_role }),
    },
    claims_reported: value.claims_reported,
    successor_required: value.successor_required,
    supersession_required: value.supersession_required,
    supersedes_run: value.supersedes_run,
  };
}

function planningRecovery(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  if (
    value.reason_code !== 'plan_rejected_after_directed_replan'
    || !Number.isInteger(value.directed_replan_attempts)
    || value.directed_replan_attempts < 1
    || value.directed_replan_attempts > 10
    || !Array.isArray(value.missing_assurances)
    || value.missing_assurances.length > 16
  ) return null;
  const missingAssurances = [];
  for (const entry of value.missing_assurances) {
    if (
      !entry
      || typeof entry !== 'object'
      || Array.isArray(entry)
      || !boundedRecoveryString(entry.id, 64)
      || !boundedRecoveryString(entry.source_stage, 64)
      || !boundedRecoveryString(entry.summary, 500)
      || !boundedRecoveryString(entry.evidence_anchor, 600)
      || (entry.requirement_id !== undefined && !boundedRecoveryString(entry.requirement_id, 128))
      || (entry.risk_trigger !== undefined && !boundedRecoveryString(entry.risk_trigger, 64))
    ) return null;
    missingAssurances.push({
      id: entry.id,
      source_stage: entry.source_stage,
      summary: entry.summary,
      evidence_anchor: entry.evidence_anchor,
      ...(entry.requirement_id === undefined ? {} : { requirement_id: entry.requirement_id }),
      ...(entry.risk_trigger === undefined ? {} : { risk_trigger: entry.risk_trigger }),
    });
  }
  return {
    reason_code: value.reason_code,
    directed_replan_attempts: value.directed_replan_attempts,
    missing_assurances: missingAssurances,
  };
}

function testContradictionResolution(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  if (![
    'test-correction-required',
    'implementation-correction-required',
    'test-corrected',
  ].includes(value.verdict)) return null;
  if (
    value.receipt_id !== null
    && value.receipt_id !== undefined
    && !boundedRecoveryString(value.receipt_id, 256)
  ) return null;
  return {
    verdict: value.verdict,
    ...(value.receipt_id === undefined ? {} : { receipt_id: value.receipt_id }),
  };
}

export function validatedTerminalRecoveryFields(record) {
  const blockedRecovery = record?.blocked_recovery?.reason_code === 'capability_denied'
    ? capabilityRecovery(record.blocked_recovery)
    : planningRecovery(record?.blocked_recovery);
  const contradiction = testContradictionResolution(record?.test_contradiction_resolution);
  return {
    ...(blockedRecovery ? { blocked_recovery: blockedRecovery } : {}),
    ...(contradiction ? { test_contradiction_resolution: contradiction } : {}),
  };
}

export function projectTerminalRecovery(record) {
  const validated = validatedTerminalRecoveryFields(record);
  const recovery = validated.blocked_recovery;
  const contradiction = validated.test_contradiction_resolution;
  return {
    ...(recovery
      ? {
          blocked_recovery: {
            reason_code: recovery.reason_code,
            ...(recovery.reason_code === 'capability_denied'
              ? {
                  additive_claim_counts: {
                    claimed_paths: recovery.additive_claims.claimed_paths.length,
                    test_paths: recovery.additive_claims.test_paths.length,
                    tool_claims: recovery.additive_claims.tool_claims.length,
                    required_role: recovery.additive_claims.required_role ? 1 : 0,
                  },
                  claims_reported: recovery.claims_reported,
                  successor_required: recovery.successor_required,
                  supersession_required: recovery.supersession_required,
                  supersedes_run: recovery.supersedes_run,
                }
              : {
                  directed_replan_attempts: recovery.directed_replan_attempts,
                  missing_assurance_count: recovery.missing_assurances.length,
                }),
          },
        }
      : {}),
    ...(contradiction
      ? { test_contradiction_resolution: { verdict: contradiction.verdict } }
      : {}),
  };
}

function persistedCode(record) {
  const value = record?.terminal_reason_code;
  if (!TERMINAL_REASON_SET.has(value)) return null;
  const status = record?.status;
  if (record?.imported === true) return value === 'legacy_unclassified' ? value : null;
  if (status === 'completed') return value === 'completed' ? value : null;
  if (status === 'aborted') return value === 'aborted' || value.startsWith('aborted_') ? value : null;
  if (status === 'blocked') {
    return !value.startsWith('aborted')
      && !['completed', 'legacy_unclassified'].includes(value)
      ? value
      : null;
  }
  return value === 'legacy_unclassified' ? value : null;
}

function terminalStage(record, reason) {
  if (KNOWN_STAGES.has(record?.stage)) return record.stage;
  const stageMatch = /^stage ([a-z][a-z-]{0,63})\b/u.exec(reason);
  if (stageMatch && KNOWN_STAGES.has(stageMatch[1])) return stageMatch[1];
  const tickets = Array.isArray(record?.tickets) ? record.tickets : [];
  for (let index = tickets.length - 1; index >= 0; index -= 1) {
    if (KNOWN_STAGES.has(tickets[index]?.stage_id)) return tickets[index].stage_id;
  }
  return null;
}

export function hasPersistedTerminalReasonCode(record) {
  return persistedCode(record) !== null;
}

export function hasPersistedFailureDomain(record) {
  return record?.status !== 'completed'
    && isFailureDomain(record?.failure_domain)
    && record.failure_domain_taxonomy_version === FAILURE_DOMAIN_TAXONOMY_VERSION;
}

export function terminalReasonCode(record) {
  const stored = persistedCode(record);
  if (stored) return stored;
  if (!record || typeof record !== 'object' || Array.isArray(record) || record.imported === true) {
    return 'legacy_unclassified';
  }

  if (record.status === 'completed') return 'completed';
  if (record.status === 'aborted') {
    const stage = terminalStage(record, '');
    if (stage === 'preflight') return 'aborted_preflight';
    if (PLANNING_STAGES.has(stage)) return 'aborted_planning';
    if (TEST_STAGES.has(stage)) return 'aborted_test';
    if (IMPLEMENTATION_STAGES.has(stage)) return 'aborted_implementation';
    if (REVIEW_STAGES.has(stage)) return 'aborted_review';
    if (stage === 'gates') return 'aborted_gating';
    if (stage === 'merge') return 'aborted_shipping';
    if (stage === 'debug' || stage === 'spike') return 'aborted_investigation';
    if (stage === 'dispatch' || stage === 'start' || stage === null) return 'aborted_dispatch';
    return 'aborted_unclassified';
  }
  if (record.status !== 'blocked') return 'legacy_unclassified';

  // Every matching phrase below is a fixed runtime prefix/marker. Inspect only
  // a bounded prefix and emit an allowlisted code; the source prose never
  // crosses the telemetry boundary.
  const reason = typeof record.block_reason === 'string'
    ? record.block_reason.slice(0, 1_024).toLowerCase()
    : '';
  const stage = terminalStage(record, reason);
  const receipts = Array.isArray(record.receipts) ? record.receipts : [];
  const failureKinds = new Set(
    receipts
      .map((receipt) => receipt?.evidence?.failure_kind)
      .filter((kind) => typeof kind === 'string'),
  );

  if (reason.startsWith('shipping failed:')) return 'shipping_failed';
  if (
    stage === 'gates'
    || record.gates?.passed === false
    || reason.includes('merge gates failed')
    || reason.includes('deterministic merge gates failed')
  ) return 'gate_failed';
  if (
    (stage === 'merge' && record.gates?.passed === true)
    || reason === 'auto-merge is disabled by configuration'
  ) return 'shipping_hold';
  if (reason.includes('test-contradiction-blocked')) return 'test_contradiction';
  if (reason.includes('capability-blocked')) return 'capability_blocked';
  if (reason.includes('worker protocol failed')) return 'worker_protocol_failure';
  if (reason.includes('dispatch expired') || reason.includes('ticket deadline expired')) {
    return 'dispatch_expired';
  }
  if (
    reason.startsWith('plan judged unsound')
    || reason.startsWith('structured plan approval could not be sealed')
    || PLANNING_STAGES.has(stage)
  ) return 'planning_rejected';
  if (
    reason.includes('review disagreement')
    || reason.includes('repeated review finding')
    || REVIEW_STAGES.has(stage)
  ) return 'review_remediation_exhausted';
  // Structural receipt fallbacks are deliberately below the terminal
  // stage/reason families: a capability-marked review vote can legitimately
  // finish as review-remediation exhaustion, and must not be re-labeled as the
  // earlier non-terminal observation.
  if (failureKinds.has('test-contradiction')) return 'test_contradiction';
  if (failureKinds.has('capability')) return 'capability_blocked';
  if (stage === 'preflight') return 'preflight_failed';
  if (TEST_STAGES.has(stage)) return 'test_failed';
  if (IMPLEMENTATION_STAGES.has(stage)) return 'implementation_failed';
  if (stage) return 'stage_failed';
  return 'blocked_unclassified';
}

export function terminalFailureDomain(record) {
  const code = terminalReasonCode(record);
  if (code === 'completed') return null;
  if (hasPersistedFailureDomain(record)) return record.failure_domain;
  if (code === 'aborted' || code.startsWith('aborted_')) return 'operator';
  if (code === 'capability_blocked' || code === 'shipping_hold') return 'configuration';
  if (['dispatch_expired', 'shipping_failed'].includes(code)) return 'infrastructure';
  if (code === 'worker_protocol_failure') {
    const receipts = Array.isArray(record?.receipts) ? record.receipts : [];
    const latestFailure = [...receipts].reverse().find((receipt) => receipt?.status !== 'passed');
    const domain = receiptFailureDomain(latestFailure, { reviewGroup: true });
    return domain === 'infrastructure' ? domain : 'orchestration';
  }
  if ([
    'planning_rejected',
    'test_contradiction',
    'test_failed',
    'implementation_failed',
    'review_remediation_exhausted',
    'gate_failed',
  ].includes(code)) return 'product';
  if (code === 'preflight_failed') return 'configuration';
  return FAILURE_DOMAINS.includes('unknown') ? 'unknown' : null;
}
