// Frozen v2/v3 authority. Never derive historical quotas from the current
// admission snapshot: doing so would silently upgrade compatibility fixtures.
export function historicalExecutionPolicy(version = 3, overrides = {}, config = {}) {
  return {
    version,
    limits: {
      version,
      max_stage_attempts: 2,
      max_worker_protocol_redispatches_per_stage: 1,
      max_regate_attempts: 3,
      max_physical_workers_per_ticket: 2,
      max_validation_submissions_per_worker: 3,
      max_reconciliation_stage_attempts: 1,
      max_reconciliation_protocol_redispatches: 0,
      ...overrides,
    },
    fast_max_files: config.policy?.fast_max_files ?? 6,
    deadlines_ms: structuredClone(config.deadlines_ms ?? {}),
    gates: structuredClone(config.gates ?? {}),
    shipping: structuredClone(config.shipping ?? {}),
  };
}
