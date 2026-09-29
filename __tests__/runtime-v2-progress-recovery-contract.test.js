import { describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG } from '../lib/runtime/config.js';
import { hashRecord } from '../lib/runtime/canonical.js';
import {
  executionConfigForRun, pipelineLimits,
  directedReplanLimit, remediationCycleLimit, receiptLimits,
} from '../lib/runtime/pipeline-limits.js';
import { ExecutionLimitsSchema, finalizeTicket, validateTicket } from '../lib/runtime/schemas.js';
import { historicalExecutionPolicy } from './historical-execution-policy-helper.js';

// This suite preserves the v3-era contract. New admissions are tested in the
// evidence-recovery-contract suite, independently of these frozen quotas.
function frozenSnapshot(config) {
  const overrides = Object.fromEntries(Object.entries(config.policy ?? {}).filter(([key]) =>
    Object.hasOwn(historicalExecutionPolicy().limits, key)));
  return historicalExecutionPolicy(3, overrides, config);
}

function ticket(execution_limits, attempt = 1) {
  return {
    schema_version: '2.0.0', ticket_id: 'run-progress:plan-replan:ticket', run_id: 'run-progress',
    stage_id: 'plan-replan', parallel_group: null, role: 'planner', objective: 'Complete the admitted scope',
    claimed_paths: ['src/value.js'], test_paths: [], model_tier: 'deep', model: {},
    deadline_at: execution_limits?.version === 3 ? null : '2026-09-26T15:00:00.000Z', output_schema: {}, required_checks: [], parent_hash: null,
    base_tree_sha: 'a'.repeat(40), attempt: 1, writable: false, issued_at: '2026-09-26T14:00:00.000Z',
    ...(execution_limits ? { execution_limits } : {}),
    plan_recovery: { version: 1, attempt, source_ticket_id: 'judge', missing_assurances: [{
      id: 'pa-0123456789abcdef', source_stage: 'plan-judge', summary: 'One remaining assurance',
    }] },
  };
}

describe('immutable progress-based recovery authority', () => {
  it('preserves frozen v3 operating limits even with old config quotas', () => {
    const config = structuredClone(DEFAULT_CONFIG);
    Object.assign(config.policy, { max_directed_replans: 0, max_remediation_cycles: 0,
      max_stage_attempts: 4, max_physical_workers_per_ticket: 5 });
    const snapshot = frozenSnapshot(config);
    expect(snapshot.version).toBe(3);
    expect(snapshot.limits).toMatchObject({ version: 3, max_stage_attempts: 4,
      max_physical_workers_per_ticket: 5 });
    expect(snapshot.limits).not.toHaveProperty('max_directed_replans');
    expect(snapshot.limits).not.toHaveProperty('max_remediation_cycles');
    config.policy.max_stage_attempts = 1;
    const run = { execution_policy: JSON.parse(JSON.stringify(snapshot)), policy: config.policy };
    expect(pipelineLimits(run)).toEqual(snapshot.limits);
    expect(executionConfigForRun(DEFAULT_CONFIG, run).policy.max_stage_attempts).toBe(4);
    expect(directedReplanLimit(run)).toBeNull();
    expect(remediationCycleLimit(run)).toBeNull();
    expect(receiptLimits({ execution_limits: snapshot.limits })).toEqual({
      max_physical_workers_per_ticket: 5, max_validation_submissions_per_worker: 3,
    });
  });

  it('honors historical zero and numeric quotas without changing snapshot bytes', () => {
    const snapshot = { ...frozenSnapshot(DEFAULT_CONFIG), version: 1,
      limits: pipelineLimits({ policy: { max_directed_replans: 0, max_remediation_cycles: 7 } }) };
    const before = JSON.stringify(snapshot);
    const run = { execution_policy: snapshot };
    expect(directedReplanLimit(run)).toBe(0);
    expect(remediationCycleLimit(run)).toBe(7);
    expect(executionConfigForRun(DEFAULT_CONFIG, run).policy).toMatchObject({
      max_directed_replans: 0, max_remediation_cycles: 7,
    });
    expect(JSON.stringify(snapshot)).toBe(before);
    expect(directedReplanLimit({})).toBe(2);
    expect(remediationCycleLimit({})).toBe(3);
  });

  it('carries the new policy through serialized tickets beyond the former replan ceiling', () => {
    const limits = frozenSnapshot(DEFAULT_CONFIG).limits;
    const issued = finalizeTicket(ticket(limits, 25));
    expect(issued.execution_limits).toEqual(limits);
    expect(issued.plan_recovery.attempt).toBe(25);
    const decoded = JSON.parse(JSON.stringify(issued));
    expect(validateTicket(decoded)).toEqual({ valid: true, value: issued });
    const changed = { ...decoded, execution_limits: pipelineLimits() };
    expect(validateTicket(changed).valid).toBe(false);
    expect(() => finalizeTicket(ticket(undefined, 3))).toThrow(/directed replan policy/);
    expect(() => finalizeTicket(ticket(pipelineLimits(), 3))).toThrow(/directed replan policy/);
  });

  it('retains the exact representation and hash of legacy tickets', () => {
    for (const limits of [undefined, pipelineLimits(), historicalExecutionPolicy(2).limits]) {
      const historical = ticket(limits, 2);
      historical.ticket_hash = hashRecord(historical, ['ticket_hash']);
      const bytes = JSON.stringify(historical);
      expect(validateTicket(historical)).toEqual({ valid: true, value: historical });
      expect(finalizeTicket(historical)).toEqual(historical);
      expect(JSON.stringify(historical)).toBe(bytes);
    }
  });

  it('rejects unknown and mixed versions instead of silently broadening old authority', () => {
    const legacy = pipelineLimits();
    const current = frozenSnapshot(DEFAULT_CONFIG).limits;
    for (const limits of [
      { ...legacy, version: 2 }, { ...current, version: 999 },
      { ...current, max_directed_replans: 10 }, { ...current, max_remediation_cycles: null },
    ]) {
      expect(ExecutionLimitsSchema.safeParse(limits).success).toBe(false);
      expect(() => pipelineLimits({ execution_limits: limits })).toThrow();
    }
    for (const snapshot of [
      { version: 2, limits: legacy }, { version: 1, limits: current },
      { version: 999, limits: current }, { version: 2 }, { version: 1 },
      { version: 1, limits: null },
    ]) expect(() => pipelineLimits({ execution_policy: snapshot, execution_limits: current,
      policy: { version: 2 } })).toThrow(/execution policy/);
  });

  it('keeps stage attempt, receipt, and safe-integer protections on new tickets', () => {
    const limits = frozenSnapshot(DEFAULT_CONFIG).limits;
    expect(() => finalizeTicket({ ...ticket(limits, 3), attempt: 3 })).toThrow(/stage attempt policy/);
    for (const attempt of [Number.MAX_SAFE_INTEGER + 1, Infinity, 1.5, 0]) {
      expect(() => finalizeTicket(ticket(limits, attempt))).toThrow();
    }
    expect(() => pipelineLimits({ execution_limits: { ...limits,
      max_physical_workers_per_ticket: Number.MAX_SAFE_INTEGER } })).toThrow(/safe integer/);
  });
});
