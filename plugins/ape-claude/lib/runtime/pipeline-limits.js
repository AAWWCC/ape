import {
  MAX_REMEDIATION_CYCLES, MAX_STAGE_ATTEMPTS,
  RECEIPT_MAX_PHYSICAL_WORKERS_PER_TICKET, RECEIPT_MAX_SUBMISSIONS_PER_WORKER,
  MAX_REGATE_ATTEMPTS, DEFAULT_DEADLINES_MS, GATE_RUNNER_HEARTBEAT_MS,
  GATE_RUNNER_STALE_MS, GATE_RUNNER_MAX_SPAWNS, GATE_INLINE_GRACE_MS,
  GATE_POLL_RETRY_DELAY_MS, CHECKS_REGISTRATION_WINDOW_MS, CHECKS_REGISTRATION_RETRY_DELAY_MS,
} from './constants.js';

// Shipped policy defaults, shared by scheduler, schemas, and admission.
// This leaf has no schema/pipeline dependency, so consumers cannot form cycles.
export const MAX_DIRECTED_REPLANS = 2;
export const MAX_WORKER_PROTOCOL_REDISPATCHES_PER_STAGE = 1;

export const EXECUTION_POLICY_DEFAULTS = Object.freeze({
  max_stage_attempts: MAX_STAGE_ATTEMPTS,
  max_directed_replans: MAX_DIRECTED_REPLANS,
  max_worker_protocol_redispatches_per_stage: MAX_WORKER_PROTOCOL_REDISPATCHES_PER_STAGE,
  max_remediation_cycles: MAX_REMEDIATION_CYCLES,
  max_regate_attempts: MAX_REGATE_ATTEMPTS,
  max_physical_workers_per_ticket: RECEIPT_MAX_PHYSICAL_WORKERS_PER_TICKET,
  max_validation_submissions_per_worker: RECEIPT_MAX_SUBMISSIONS_PER_WORKER,
  max_reconciliation_stage_attempts: 1,
  max_reconciliation_protocol_redispatches: 0,
});

export const EXECUTION_POSITIVE_COUNTS = new Set([
  'max_stage_attempts', 'max_physical_workers_per_ticket',
  'max_validation_submissions_per_worker', 'max_reconciliation_stage_attempts',
]);

export function assertExecutionPolicy(policy = {}) {
  const value = {};
  for (const [key, fallback] of Object.entries(EXECUTION_POLICY_DEFAULTS)) {
    value[key] = policy[key] === undefined ? fallback : policy[key];
    const minimum = EXECUTION_POSITIVE_COUNTS.has(key) ? 1 : 0;
    if (!Number.isSafeInteger(value[key]) || value[key] < minimum) {
      throw new Error(`execution policy ${key} must be a safe integer of at least ${minimum}`);
    }
  }
  // Counters and admission forecasts must remain exact. This is an arithmetic
  // representation constraint, not a smaller undocumented retry policy.
  const logical = BigInt(value.max_stage_attempts) + BigInt(value.max_directed_replans)
    + BigInt(value.max_remediation_cycles) + BigInt(value.max_worker_protocol_redispatches_per_stage)
    + BigInt(value.max_reconciliation_stage_attempts) + BigInt(value.max_reconciliation_protocol_redispatches);
  if (logical * BigInt(value.max_physical_workers_per_ticket)
      * BigInt(value.max_validation_submissions_per_worker) > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error('execution policy combined dispatch and validation counters exceed safe integer arithmetic');
  }
}

export function stageRecoveryLimits(stageId, run = {}) {
  const singleAttempt = ['test-reconcile', 'test-recheck'].includes(stageId);
  const limits = pipelineLimits(run);
  return {
    max_stage_attempts: singleAttempt ? limits.max_reconciliation_stage_attempts : limits.max_stage_attempts,
    max_protocol_redispatches: singleAttempt ? limits.max_reconciliation_protocol_redispatches : limits.max_worker_protocol_redispatches_per_stage,
  };
}

export function remediationCycleLimit(run) {
  return pipelineLimits(run).max_remediation_cycles;
}

export function pipelineLimits(run = {}) {
  const configured = run.execution_policy?.limits ?? run.execution_limits ?? run.policy ?? {};
  const limits = Object.fromEntries(Object.entries(EXECUTION_POLICY_DEFAULTS)
    .map(([key, fallback]) => [key, configured[key] === undefined ? fallback : configured[key]]));
  assertExecutionPolicy(limits);
  return Object.freeze(limits);
}

export function receiptLimits(ticketOrIntent = {}) {
  ticketOrIntent ??= {};
  const bound = ticketOrIntent.receipt_limits ?? ticketOrIntent.execution_limits;
  const fields = ticketOrIntent.capability_manifest?.field_bounds;
  const limits = {
    max_physical_workers_per_ticket: bound?.max_physical_workers_per_ticket
      ?? fields?.max_physical_workers_per_ticket ?? RECEIPT_MAX_PHYSICAL_WORKERS_PER_TICKET,
    max_validation_submissions_per_worker: bound?.max_validation_submissions_per_worker
      ?? fields?.validation_attempts_per_worker ?? RECEIPT_MAX_SUBMISSIONS_PER_WORKER,
  };
  for (const [key, value] of Object.entries(limits)) {
    if (!Number.isSafeInteger(value) || value < 1) {
      throw new Error(`receipt policy ${key} must be a positive safe integer`);
    }
  }
  // This envelope contains only physical-worker and submission authority.
  // Charging default stage/recovery counts here would reject an admitted run
  // whose explicitly smaller logical policy has a safe exact forecast.
  if (BigInt(limits.max_physical_workers_per_ticket) * BigInt(limits.max_validation_submissions_per_worker)
      > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error('receipt policy combined validation counters exceed safe integer arithmetic');
  }
  return limits;
}

export function executionPolicySnapshot(config) {
  return {
    version: 1,
    limits: pipelineLimits({ policy: config.policy }),
    fast_max_files: config.policy?.fast_max_files ?? 6,
    deadlines_ms: structuredClone({ ...DEFAULT_DEADLINES_MS, ...config.deadlines_ms }),
    gates: {
      heartbeat_ms: config.gates?.heartbeat_ms ?? GATE_RUNNER_HEARTBEAT_MS,
      stale_ms: config.gates?.stale_ms ?? GATE_RUNNER_STALE_MS,
      max_spawns: config.gates?.max_spawns ?? GATE_RUNNER_MAX_SPAWNS,
      inline_grace_ms: config.gates?.inline_grace_ms ?? GATE_INLINE_GRACE_MS,
      poll_retry_delay_ms: config.gates?.poll_retry_delay_ms ?? GATE_POLL_RETRY_DELAY_MS,
    },
    shipping: {
      checks_registration_window_ms: config.shipping?.checks_registration_window_ms ?? CHECKS_REGISTRATION_WINDOW_MS,
      checks_registration_retry_delay_ms: config.shipping?.checks_registration_retry_delay_ms ?? CHECKS_REGISTRATION_RETRY_DELAY_MS,
    },
  };
}

export function executionConfigForRun(config, run) {
  const snapshot = run?.execution_policy;
  if (!snapshot) return config;
  if (snapshot.version !== 1) throw new Error('unsupported immutable execution policy');
  const limits = pipelineLimits(run);
  return {
    ...config,
    policy: { ...config.policy, ...limits, fast_max_files: snapshot.fast_max_files },
    deadlines_ms: structuredClone(snapshot.deadlines_ms),
    gates: { ...config.gates, ...snapshot.gates },
    shipping: { ...config.shipping, ...snapshot.shipping },
  };
}
