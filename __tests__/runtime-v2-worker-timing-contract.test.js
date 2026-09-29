import { describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG } from '../lib/runtime/config.js';
import { executionPolicySnapshot, workerDeadlinesEnabled } from '../lib/runtime/pipeline-limits.js';
import { finalizeTicket, validateTicket } from '../lib/runtime/schemas.js';
import { hashRecord } from '../lib/runtime/canonical.js';
import { assertActiveStateWritable } from '../lib/runtime/active-state.js';
import { projectRunDiagnostic } from '../lib/runtime/diagnostics.js';
import { reduceRun } from '../lib/runtime/reducer.js';

function ticket(version = 4) {
  return {
    schema_version: '2.0.0', ticket_id: 'run-worker-timing:build:ticket', run_id: 'run-worker-timing',
    stage_id: 'build', parallel_group: null, role: 'implementer', objective: 'Finish the task',
    claimed_paths: ['src/value.js'], test_paths: [], model_tier: 'deep', model: {},
    execution_limits: version === 4 ? { version: 4 } : {
      version,
      max_stage_attempts: 2,
      max_worker_protocol_redispatches_per_stage: 1,
      max_regate_attempts: 3,
      max_physical_workers_per_ticket: 2,
      max_validation_submissions_per_worker: 3,
      max_reconciliation_stage_attempts: 1,
      max_reconciliation_protocol_redispatches: 0,
    },
    deadline_at: [3, 4].includes(version) ? null : '2026-09-27T12:00:00.000Z',
    output_schema: {}, required_checks: [], parent_hash: null, base_tree_sha: 'a'.repeat(40),
    attempt: 1, writable: true, issued_at: '2026-09-27T11:00:00.000Z',
  };
}

function state(pending = finalizeTicket(ticket())) {
  return {
    schema_version: '2.0.0', run_id: 'run-worker-timing', mode: 'phase', lane: 'full', host: 'codex',
    status: 'running', stage: 'build', dispatch_state: 'none', tickets: [pending], receipts: [],
    attempts: { build: 1 }, expired_tickets: [], execution_policy: {
      version: pending.execution_limits.version, limits: { ...pending.execution_limits },
    },
  };
}

describe('immutable worker timing policy', () => {
  it.each([3, 4])('requires explicit v%s authority for a null deadline and preserves historical bytes', (version) => {
    const modern = finalizeTicket(ticket(version));
    expect(validateTicket(JSON.parse(JSON.stringify(modern)))).toEqual({ valid: true, value: modern });
    expect(workerDeadlinesEnabled(modern)).toBe(false);
    for (const version of [2, undefined]) {
      const old = ticket(2);
      if (version === undefined) delete old.execution_limits;
      old.ticket_hash = hashRecord(old, ['ticket_hash']);
      expect(finalizeTicket(old)).toEqual(old);
      expect(workerDeadlinesEnabled(old)).toBe(true);
      expect(() => finalizeTicket({ ...old, deadline_at: null })).toThrow(/original deadline/);
    }
    expect(() => finalizeTicket({ ...ticket(version), deadline_at: '2026-09-27T12:00:00.000Z' }))
      .toThrow(/requires no deadline/);
    expect(() => finalizeTicket({ ...ticket(version), deadline_at: undefined })).toThrow();
  });

  it('does not let unknown or inconsistent policy versions disable historical timing', () => {
    expect(() => workerDeadlinesEnabled({ execution_limits: { version: 5 } }))
      .toThrow(/unsupported/);
    expect(() => workerDeadlinesEnabled({ execution_policy: {
      ...executionPolicySnapshot(DEFAULT_CONFIG), version: 2,
    } })).toThrow(/inconsistent/);
    expect(workerDeadlinesEnabled({})).toBe(true);
    expect(workerDeadlinesEnabled({ policy: { version: 3 } })).toBe(true);
  });

  it.each([3, 4])('persists and diagnoses a live v%s deadline-free run without marking its null timestamp corrupt', (version) => {
    const run = state(finalizeTicket(ticket(version)));
    expect(() => assertActiveStateWritable(run)).not.toThrow();
    expect(projectRunDiagnostic(run).reason_code).not.toBe('corrupt_state');
    const malformed = structuredClone(run);
    malformed.tickets[0].execution_limits = ticket(2).execution_limits;
    expect(() => assertActiveStateWritable(malformed)).toThrow(/invalid shape/);
    expect(projectRunDiagnostic(malformed).reason_code).toBe('corrupt_state');
    malformed.tickets[0].execution_limits = ticket(version).execution_limits;
    malformed.tickets[0].deadline_at = '2026-09-27T12:00:00.000Z';
    expect(() => assertActiveStateWritable(malformed)).toThrow(/invalid shape/);
    expect(projectRunDiagnostic(malformed).reason_code).toBe('corrupt_state');
  });

  it.each([3, 4])('keeps a pending v%s ticket after arbitrary elapsed time without spending a retry', (version) => {
    const run = state(finalizeTicket(ticket(version)));
    const actions = reduceRun(run, { type: 'NEXT', at: '2099-01-01T00:00:00.000Z' });
    expect(actions).toEqual([{ type: 'dispatch_agent', ticket_id: run.tickets[0].ticket_id }]);
    expect(run.attempts.build).toBe(1);
    expect(run.expired_tickets).toEqual([]);
  });
});
