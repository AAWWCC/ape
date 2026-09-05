import {
  MAX_REMEDIATION_CYCLES, MAX_STAGE_ATTEMPTS,
  RECEIPT_MAX_PHYSICAL_WORKERS_PER_TICKET, RECEIPT_MAX_SUBMISSIONS_PER_WORKER,
} from './constants.js';

// Existing policy ceilings, shared by scheduler, schemas, and admission.
// This leaf has no schema/pipeline dependency, so consumers cannot form cycles.
export const MAX_DIRECTED_REPLANS = 2;
export const MAX_WORKER_PROTOCOL_REDISPATCHES_PER_STAGE = 1;

export function stageRecoveryLimits(stageId) {
  const singleAttempt = ['test-reconcile', 'test-recheck'].includes(stageId);
  return {
    max_stage_attempts: singleAttempt ? 1 : MAX_STAGE_ATTEMPTS,
    max_protocol_redispatches: singleAttempt ? 0 : MAX_WORKER_PROTOCOL_REDISPATCHES_PER_STAGE,
  };
}

export function remediationCycleLimit(run) {
  const configured = run?.policy?.max_remediation_cycles;
  return Number.isInteger(configured) && configured >= 1 && configured <= 10
    ? configured
    : MAX_REMEDIATION_CYCLES;
}

export function pipelineLimits(run = {}) {
  return Object.freeze({
    max_directed_replans: MAX_DIRECTED_REPLANS,
    max_remediation_cycles: remediationCycleLimit(run),
    max_stage_attempts: MAX_STAGE_ATTEMPTS,
    max_worker_protocol_redispatches_per_stage: MAX_WORKER_PROTOCOL_REDISPATCHES_PER_STAGE,
    max_physical_workers_per_ticket: RECEIPT_MAX_PHYSICAL_WORKERS_PER_TICKET,
    max_validation_submissions_per_worker: RECEIPT_MAX_SUBMISSIONS_PER_WORKER,
  });
}
