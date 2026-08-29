import { incrementOrchestration } from './orchestration-telemetry.js';
import { TERMINAL_STATUSES } from './constants.js';

const ISO_MAX_MS = 8_640_000_000_000_000;
const ACTIVE_STATUSES = new Set(['starting', 'running', 'gating', 'shipping']);

function parsedMs(value) {
  const ms = Date.parse(value ?? '');
  return Number.isFinite(ms) ? ms : null;
}

export function initializeExecutionBudget(input, createdAt) {
  if (!input) return null;
  const startedMs = parsedMs(createdAt);
  if (startedMs === null) throw new Error('execution budget requires a valid run creation time');
  const deadlineMs = Math.min(ISO_MAX_MS, startedMs + input.max_active_seconds * 1_000);
  return {
    version: 1,
    max_worker_dispatches: input.max_worker_dispatches,
    max_active_seconds: input.max_active_seconds,
    worker_dispatches_used: 0,
    active_started_at: createdAt,
    active_elapsed_ms: 0,
    overrun_ms: 0,
    active_since: createdAt,
    active_deadline_at: new Date(deadlineMs).toISOString(),
  };
}

export function executionBudgetElapsedMs(state, at = new Date().toISOString()) {
  const budget = state?.execution_budget;
  if (!budget) return null;
  let elapsed = Number.isFinite(budget.active_elapsed_ms) ? budget.active_elapsed_ms : 0;
  const atMs = parsedMs(at);
  const sinceMs = parsedMs(budget.active_since);
  if (atMs !== null && sinceMs !== null && atMs > sinceMs) elapsed += atMs - sinceMs;
  return Math.min(Number.MAX_SAFE_INTEGER, Math.max(0, elapsed));
}

export function executionBudgetRemainingMs(state, at = new Date().toISOString()) {
  const budget = state?.execution_budget;
  if (!budget) return null;
  const elapsed = executionBudgetElapsedMs(state, at);
  return Math.max(0, budget.max_active_seconds * 1_000 - (elapsed ?? 0));
}

// Called by every authoritative persist. It accumulates only statuses in which
// APE is actively progressing, freezing the clock across operator input holds
// and terminal states and re-arming it when an explicit continuation resumes.
export function syncExecutionBudgetClock(state, at = new Date().toISOString()) {
  const budget = state?.execution_budget;
  if (!budget) return;
  const atMs = parsedMs(at);
  if (atMs === null) throw new Error('execution budget sync requires a valid timestamp');
  let elapsed = Number.isFinite(budget.active_elapsed_ms) ? budget.active_elapsed_ms : 0;
  const sinceMs = parsedMs(budget.active_since);
  if (sinceMs !== null && atMs > sinceMs) elapsed += atMs - sinceMs;
  // Preserve a truthful in-flight overrun instead of flattening elapsed at the
  // authorization cap. The safe-integer ceiling bounds malformed/far-future
  // clocks without erasing how far a permitted physical worker ran over.
  budget.active_elapsed_ms = Math.min(Number.MAX_SAFE_INTEGER, Math.max(0, elapsed));
  budget.overrun_ms = Math.max(0, budget.active_elapsed_ms - budget.max_active_seconds * 1_000);
  if (ACTIVE_STATUSES.has(state.status)) {
    budget.active_since = at;
    const remaining = Math.max(0, budget.max_active_seconds * 1_000 - budget.active_elapsed_ms);
    budget.active_deadline_at = new Date(Math.min(ISO_MAX_MS, atMs + remaining)).toISOString();
  } else {
    delete budget.active_since;
    delete budget.active_deadline_at;
  }
}

export function executionBudgetGuard(state, options = {}) {
  const budget = state?.execution_budget;
  if (!budget) return { allowed: true, legacy: true };
  const at = options.at ?? new Date().toISOString();
  const atMs = parsedMs(at);
  if (atMs === null) {
    return { allowed: false, code: 'invalid-budget-clock', reason: 'the execution budget clock is invalid' };
  }
  const remainingMs = executionBudgetRemainingMs(state, at);
  if (remainingMs === null) return { allowed: true, legacy: true };
  if (remainingMs <= 0) {
    const elapsedMs = executionBudgetElapsedMs(state, at) ?? 0;
    return {
      allowed: false,
      code: 'active-time-exhausted',
      reason: `execution budget exhausted after ${budget.max_active_seconds} active seconds`,
      active_elapsed_ms: elapsedMs,
      overrun_ms: Math.max(0, elapsedMs - budget.max_active_seconds * 1_000),
    };
  }
  const dispatches = Number.isInteger(options.dispatches) && options.dispatches > 0 ? options.dispatches : 0;
  const used = Number.isInteger(budget.worker_dispatches_used) ? budget.worker_dispatches_used : 0;
  if (used + dispatches > budget.max_worker_dispatches) {
    return {
      allowed: false,
      code: 'worker-dispatches-exhausted',
      reason: `execution budget permits ${budget.max_worker_dispatches} worker dispatches; ${used} have been used and the next group requires ${dispatches}`,
      worker_dispatches_used: used,
      required_dispatches: dispatches,
    };
  }
  return {
    allowed: true,
    legacy: false,
    remaining_worker_dispatches: budget.max_worker_dispatches - used,
    remaining_active_seconds: Math.max(0, Math.floor(remainingMs / 1_000)),
  };
}

export function recordWorkerDispatch(state, at = new Date().toISOString()) {
  if (!state?.execution_budget) return;
  state.execution_budget.worker_dispatches_used =
    (Number.isInteger(state.execution_budget.worker_dispatches_used)
      ? state.execution_budget.worker_dispatches_used
      : 0) + 1;
  state.execution_budget.last_dispatch_at = at;
}

export function pauseForExecutionBudget(state, guard, at = new Date().toISOString()) {
  if (!state?.execution_budget || guard?.allowed !== false) return null;
  // A budget is an authorization boundary for future work, never a lever that
  // can reopen or rewrite a terminal run.
  if (TERMINAL_STATUSES.has(state.status)) return null;
  if (state.status === 'input_required' && state.input_required?.kind === 'execution_budget') {
    return {
      type: 'budget_paused',
      code: state.input_required.code,
      reason: state.input_required.reason,
      execution_budget: structuredClone(state.execution_budget),
      idempotent: true,
    };
  }
  syncExecutionBudgetClock(state, at);
  const resumeStage = state.stage;
  const resumeStatus = state.status;
  state.status = 'input_required';
  state.stage = 'execution-budget';
  state.input_required = {
    kind: 'execution_budget',
    code: guard.code,
    reason: guard.reason,
    resume_stage: resumeStage,
    resume_status: resumeStatus,
    paused_at: at,
    ...(Number.isInteger(guard.required_dispatches)
      ? { required_dispatches: guard.required_dispatches }
      : {}),
  };
  state.orchestration = incrementOrchestration(state.orchestration, 'budget_pauses');
  state.updated_at = at;
  syncExecutionBudgetClock(state, at);
  return {
    type: 'budget_paused',
    code: guard.code,
    reason: guard.reason,
    execution_budget: structuredClone(state.execution_budget),
  };
}

export function clampToExecutionDeadline(state, candidateIso, at = new Date().toISOString()) {
  const candidate = parsedMs(candidateIso);
  const atMs = parsedMs(at);
  const remainingMs = executionBudgetRemainingMs(state, at);
  if (remainingMs === null || candidate === null || atMs === null) return candidateIso;
  const budgetDeadline = atMs + remainingMs;
  if (candidate <= budgetDeadline) return candidateIso;
  return new Date(Math.min(ISO_MAX_MS, budgetDeadline)).toISOString();
}

export function extendExecutionBudgetState(state, extension, at = new Date().toISOString()) {
  const budget = state?.execution_budget;
  if (!budget) throw new Error('active run has no execution budget to extend');
  if (TERMINAL_STATUSES.has(state.status)) {
    throw new Error(`cannot extend execution budget for terminal run ${state.status}`);
  }
  syncExecutionBudgetClock(state, at);
  const nextDispatches = extension.max_worker_dispatches ?? budget.max_worker_dispatches;
  const nextSeconds = extension.max_active_seconds ?? budget.max_active_seconds;
  if (nextDispatches < budget.max_worker_dispatches || nextSeconds < budget.max_active_seconds) {
    throw new Error('execution budget extension is monotonic; limits cannot decrease');
  }
  if (nextDispatches === budget.max_worker_dispatches && nextSeconds === budget.max_active_seconds) {
    throw new Error('execution budget extension must increase at least one limit');
  }
  if (nextSeconds * 1_000 <= budget.active_elapsed_ms) {
    throw new Error('max_active_seconds must extend the active deadline into the future');
  }
  if (state.input_required?.kind === 'execution_budget' && state.input_required.code === 'worker-dispatches-exhausted') {
    const requiredDispatches = Number.isInteger(state.input_required.required_dispatches)
      ? state.input_required.required_dispatches
      : 1;
    const usedDispatches = Number.isInteger(budget.worker_dispatches_used)
      ? budget.worker_dispatches_used
      : 0;
    if (nextDispatches < usedDispatches + requiredDispatches) {
      throw new Error(
        `max_worker_dispatches must reach at least ${usedDispatches + requiredDispatches} to resume the paused dispatch group`,
      );
    }
  }
  budget.max_worker_dispatches = nextDispatches;
  budget.max_active_seconds = nextSeconds;
  budget.extended_at = at;
  budget.extension_count = (budget.extension_count ?? 0) + 1;
  if (state.input_required?.kind === 'execution_budget') {
    state.status = ACTIVE_STATUSES.has(state.input_required.resume_status)
      ? state.input_required.resume_status
      : 'running';
    state.stage = state.input_required.resume_stage ?? 'resume';
    delete state.input_required;
  }
  state.updated_at = at;
  syncExecutionBudgetClock(state, at);
  return budget;
}
