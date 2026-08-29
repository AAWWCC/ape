// Bounded, runtime-owned orchestration telemetry. This module deliberately
// stores counts and durations only: no prompts, receipt prose, command output,
// paths, or provider payloads may cross into history through this surface.

export const ORCHESTRATION_TELEMETRY_VERSION = 1;
export const FAILURE_DOMAIN_TAXONOMY_VERSION = 1;
export const FAILURE_DOMAINS = Object.freeze([
  'product',
  'orchestration',
  'configuration',
  'infrastructure',
  'operator',
  'unknown',
]);

const FAILURE_DOMAIN_SET = new Set(FAILURE_DOMAINS);
const MAX_COUNTER = 1_000_000_000;
export const PROTOCOL_FAILURE_KINDS = Object.freeze([
  'command-shape',
  'contract',
  'receipt-contract',
  'protocol',
]);
export const INFRASTRUCTURE_FAILURE_KINDS = Object.freeze([
  'host-transport',
  'infrastructure',
  'transport',
]);
export const RECEIPT_FAILURE_KINDS = Object.freeze([
  'capability',
  'test-contradiction',
  ...PROTOCOL_FAILURE_KINDS,
  ...INFRASTRUCTURE_FAILURE_KINDS,
]);
const PROTOCOL_FAILURE_KIND_SET = new Set(PROTOCOL_FAILURE_KINDS);
const INFRASTRUCTURE_FAILURE_KIND_SET = new Set(INFRASTRUCTURE_FAILURE_KINDS);
const COUNTER_FIELDS = Object.freeze([
  'receipt_record_attempts',
  'receipt_accepts',
  'receipt_first_pass_accepts',
  'receipt_rejections',
  'protocol_redispatches',
  'stage_retries',
  'directed_replans',
  'remediation_cycles',
  'budget_pauses',
  'correction_wall_ms',
]);
const REJECTION_CLASSES = Object.freeze(['contract', 'transport', 'policy', 'other']);

function boundedInteger(value) {
  return Number.isSafeInteger(value) && value >= 0 && value <= MAX_COUNTER;
}

function addBounded(left, right = 1) {
  const base = boundedInteger(left) ? left : 0;
  const increment = boundedInteger(right) ? right : 0;
  return Math.min(MAX_COUNTER, base + increment);
}

function optionalDuration(value) {
  return boundedInteger(value) ? value : null;
}

export function isFailureDomain(value) {
  return FAILURE_DOMAIN_SET.has(value);
}

export function receiptFailureKind(receipt) {
  const value = receipt?.evidence?.failure_kind;
  return typeof value === 'string' ? value.trim().toLowerCase() : null;
}

// Only explicit transport/protocol classifications enter worker recovery.
// Legacy failed-review receipts without a failure_kind retain their existing
// product-vote semantics for compatibility.
export function workerFailureDomain(receipt, { reviewGroup = false } = {}) {
  if (String(receipt?.status).toLowerCase() === 'passed') return null;
  const domain = receiptFailureDomain(receipt, { reviewGroup });
  if (domain === 'infrastructure' || domain === 'orchestration') return domain;
  return null;
}

export function receiptFailureDomain(receipt, { reviewGroup = false } = {}) {
  if (String(receipt?.status).toLowerCase() === 'passed') return null;
  const kind = receiptFailureKind(receipt);
  if (kind === 'capability') return 'configuration';
  if (INFRASTRUCTURE_FAILURE_KIND_SET.has(kind)) return 'infrastructure';
  if (PROTOCOL_FAILURE_KIND_SET.has(kind)) return 'orchestration';
  return 'product';
}

export function emptyOrchestrationTelemetry() {
  return {
    version: ORCHESTRATION_TELEMETRY_VERSION,
    receipt_record_attempts: 0,
    receipt_accepts: 0,
    receipt_first_pass_accepts: 0,
    receipt_rejections: 0,
    receipt_rejections_by_class: Object.fromEntries(
      REJECTION_CLASSES.map((name) => [name, 0]),
    ),
    protocol_redispatches: 0,
    stage_retries: 0,
    directed_replans: 0,
    remediation_cycles: 0,
    budget_pauses: 0,
    time_to_first_writer_ms: null,
    repair_started_at: null,
    correction_wall_ms: 0,
    token_usage: {
      dispatches: 0,
      attested_dispatches: 0,
      input_tokens: 0,
      output_tokens: 0,
      total_tokens: 0,
    },
  };
}

export function validatedOrchestrationTelemetry(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  if (value.version !== ORCHESTRATION_TELEMETRY_VERSION) return null;
  if (COUNTER_FIELDS.some((field) =>
    field === 'budget_pauses'
      ? value[field] !== undefined && !boundedInteger(value[field])
      : !boundedInteger(value[field]))) return null;
  const rejectionSource = value.receipt_rejections_by_class;
  if (!rejectionSource || typeof rejectionSource !== 'object' || Array.isArray(rejectionSource)) {
    return null;
  }
  const receiptRejectionsByClass = {};
  for (const name of REJECTION_CLASSES) {
    if (!boundedInteger(rejectionSource[name])) return null;
    receiptRejectionsByClass[name] = rejectionSource[name];
  }
  const tokens = value.token_usage;
  if (!tokens || typeof tokens !== 'object' || Array.isArray(tokens)) return null;
  for (const field of ['dispatches', 'attested_dispatches', 'input_tokens', 'output_tokens', 'total_tokens']) {
    if (!boundedInteger(tokens[field])) return null;
  }
  if (tokens.attested_dispatches > tokens.dispatches) return null;
  const latency = value.time_to_first_writer_ms;
  if (latency !== null && !boundedInteger(latency)) return null;
  const repairStartedAt = value.repair_started_at;
  if (
    repairStartedAt !== null
    && (
      typeof repairStartedAt !== 'string'
      || repairStartedAt.length > 64
      || !Number.isFinite(Date.parse(repairStartedAt))
    )
  ) return null;
  return {
    version: ORCHESTRATION_TELEMETRY_VERSION,
    receipt_record_attempts: value.receipt_record_attempts,
    receipt_accepts: value.receipt_accepts,
    receipt_first_pass_accepts: value.receipt_first_pass_accepts,
    receipt_rejections: value.receipt_rejections,
    protocol_redispatches: value.protocol_redispatches,
    stage_retries: value.stage_retries,
    directed_replans: value.directed_replans,
    remediation_cycles: value.remediation_cycles,
    // Additive within telemetry v1 so a run begun by an immediately prior
    // build remains readable and simply reports no observed pauses.
    budget_pauses: boundedInteger(value.budget_pauses) ? value.budget_pauses : 0,
    correction_wall_ms: value.correction_wall_ms,
    receipt_rejections_by_class: receiptRejectionsByClass,
    time_to_first_writer_ms: latency,
    repair_started_at: repairStartedAt,
    token_usage: {
      dispatches: tokens.dispatches,
      attested_dispatches: tokens.attested_dispatches,
      input_tokens: tokens.input_tokens,
      output_tokens: tokens.output_tokens,
      total_tokens: tokens.total_tokens,
    },
  };
}

function normalizedTelemetry(value) {
  return validatedOrchestrationTelemetry(value) ?? emptyOrchestrationTelemetry();
}

export function incrementOrchestration(value, field, amount = 1) {
  if (!COUNTER_FIELDS.includes(field)) throw new Error(`unknown orchestration counter: ${field}`);
  const telemetry = normalizedTelemetry(value);
  return { ...telemetry, [field]: addBounded(telemetry[field], amount) };
}

export function recordReceiptAttempt(value, input = {}) {
  let telemetry = incrementOrchestration(value, 'receipt_record_attempts');
  if (input.accepted === true) {
    telemetry = incrementOrchestration(telemetry, 'receipt_accepts');
    if (input.first_attempt === true) {
      telemetry = incrementOrchestration(telemetry, 'receipt_first_pass_accepts');
    }
  }
  if (input.accepted !== true) {
    telemetry = incrementOrchestration(telemetry, 'receipt_rejections');
    const classification = REJECTION_CLASSES.includes(input.rejection_class)
      ? input.rejection_class
      : 'other';
    telemetry = {
      ...telemetry,
      receipt_rejections_by_class: {
        ...telemetry.receipt_rejections_by_class,
        [classification]: addBounded(telemetry.receipt_rejections_by_class[classification]),
      },
    };
  }
  if (optionalDuration(input.correction_wall_ms) !== null) {
    telemetry = incrementOrchestration(telemetry, 'correction_wall_ms', input.correction_wall_ms);
  }
  return telemetry;
}

// Aggregate the completed physical dispatch's persisted validation summary at
// receipt commit. This avoids storing a per-ticket map in active/history while
// still distinguishing a first-pass acceptance from one accepted after exact
// contract corrections.
export function recordAcceptedReceipt(value, input = {}) {
  const attempts = boundedInteger(input.validation_attempt) && input.validation_attempt >= 1
    ? input.validation_attempt
    : null;
  if (attempts === null) return normalizedTelemetry(value);
  let telemetry = incrementOrchestration(value, 'receipt_record_attempts', attempts);
  telemetry = incrementOrchestration(telemetry, 'receipt_accepts');
  if (attempts === 1 && telemetry.repair_started_at === null) {
    telemetry = incrementOrchestration(telemetry, 'receipt_first_pass_accepts');
  } else if (attempts > 1) {
    telemetry = incrementOrchestration(telemetry, 'receipt_rejections', attempts - 1);
    telemetry = {
      ...telemetry,
      receipt_rejections_by_class: {
        ...telemetry.receipt_rejections_by_class,
        contract: addBounded(
          telemetry.receipt_rejections_by_class.contract,
          attempts - 1,
        ),
      },
    };
  }
  return recordRepairCompleted(telemetry, input.accepted_at);
}

export function recordReceiptContractExhaustion(value, input = {}) {
  const attempts = boundedInteger(input.validation_attempts) && input.validation_attempts >= 1
    ? input.validation_attempts
    : 3;
  let telemetry = incrementOrchestration(value, 'receipt_record_attempts', attempts);
  telemetry = incrementOrchestration(telemetry, 'receipt_rejections', attempts);
  telemetry = {
    ...telemetry,
    receipt_rejections_by_class: {
      ...telemetry.receipt_rejections_by_class,
      contract: addBounded(telemetry.receipt_rejections_by_class.contract, attempts),
    },
  };
  if (input.redispatched === true) {
    telemetry = incrementOrchestration(telemetry, 'protocol_redispatches');
  }
  if (telemetry.repair_started_at !== null) return telemetry;
  const at = input.at;
  if (typeof at !== 'string' || at.length > 64 || !Number.isFinite(Date.parse(at))) {
    return telemetry;
  }
  return { ...telemetry, repair_started_at: at };
}

export function recordRepairCompleted(value, completedAt) {
  const telemetry = normalizedTelemetry(value);
  if (telemetry.repair_started_at === null) return telemetry;
  const started = Date.parse(telemetry.repair_started_at);
  const completed = Date.parse(completedAt ?? '');
  if (!Number.isFinite(started) || !Number.isFinite(completed) || completed < started) {
    return telemetry;
  }
  const elapsed = Math.min(MAX_COUNTER, completed - started);
  return {
    ...incrementOrchestration(telemetry, 'correction_wall_ms', elapsed),
    repair_started_at: null,
  };
}

export function recordFirstWriterLatency(value, runCreatedAt, writerBoundAt) {
  const telemetry = normalizedTelemetry(value);
  if (telemetry.time_to_first_writer_ms !== null) return telemetry;
  const start = Date.parse(runCreatedAt ?? '');
  const end = Date.parse(writerBoundAt ?? '');
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return telemetry;
  return {
    ...telemetry,
    time_to_first_writer_ms: Math.min(MAX_COUNTER, end - start),
  };
}

// Token totals are admitted only from a host-owned attestation. A missing or
// malformed attestation contributes to coverage (dispatches) but never causes
// estimation or inferred token totals.
export function recordDispatchTokenCoverage(value, attestation = null) {
  const telemetry = normalizedTelemetry(value);
  const tokenUsage = {
    ...telemetry.token_usage,
    dispatches: addBounded(telemetry.token_usage.dispatches),
  };
  if (
    attestation?.host_attested === true
    && boundedInteger(attestation.input_tokens)
    && boundedInteger(attestation.output_tokens)
    && boundedInteger(attestation.total_tokens)
    && attestation.total_tokens === attestation.input_tokens + attestation.output_tokens
  ) {
    tokenUsage.attested_dispatches = addBounded(tokenUsage.attested_dispatches);
    tokenUsage.input_tokens = addBounded(tokenUsage.input_tokens, attestation.input_tokens);
    tokenUsage.output_tokens = addBounded(tokenUsage.output_tokens, attestation.output_tokens);
    tokenUsage.total_tokens = addBounded(tokenUsage.total_tokens, attestation.total_tokens);
  }
  return { ...telemetry, token_usage: tokenUsage };
}
