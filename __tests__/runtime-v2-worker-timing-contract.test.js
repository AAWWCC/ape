import { describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG } from '../lib/runtime/config.js';
import { executionPolicySnapshot, workerDeadlinesEnabled } from '../lib/runtime/pipeline-limits.js';
import { finalizeTicket, validateTicket } from '../lib/runtime/schemas.js';
import { hashRecord } from '../lib/runtime/canonical.js';
import { assertActiveStateWritable } from '../lib/runtime/active-state.js';
import { projectRunDiagnostic } from '../lib/runtime/diagnostics.js';
import { reduceRun } from '../lib/runtime/reducer.js';

function ticket(version = 3) {
  return {
    schema_version: '2.0.0', ticket_id: 'run-worker-timing:build:ticket', run_id: 'run-worker-timing',
    stage_id: 'build', parallel_group: null, role: 'implementer', objective: 'Finish the task',
    claimed_paths: ['src/value.js'], test_paths: [], model_tier: 'deep', model: {},
    execution_limits: { ...executionPolicySnapshot(DEFAULT_CONFIG).limits, version },
    deadline_at: version === 3 ? null : '2026-09-27T12:00:00.000Z',
    output_schema: {}, required_checks: [], parent_hash: null, base_tree_sha: 'a'.repeat(40),
    attempt: 1, writable: true, issued_at: '2026-09-27T11:00:00.000Z',
  };
}

function state(pending = finalizeTicket(ticket())) {
  return {
    schema_version: '2.0.0', run_id: 'run-worker-timing', mode: 'phase', lane: 'full', host: 'codex',
    status: 'running', stage: 'build', dispatch_state: 'none', tickets: [pending], receipts: [],
    attempts: { build: 1 }, expired_tickets: [], execution_policy: executionPolicySnapshot(DEFAULT_CONFIG),
  };
}

describe('immutable worker timing policy', () => {
  it('requires explicit v3 authority for a null deadline and preserves historical bytes', () => {
    const modern = finalizeTicket(ticket());
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
    expect(() => finalizeTicket({ ...ticket(), deadline_at: '2026-09-27T12:00:00.000Z' }))
      .toThrow(/requires no deadline/);
    expect(() => finalizeTicket({ ...ticket(), deadline_at: undefined })).toThrow();
  });

  it('does not let unknown or inconsistent policy versions disable historical timing', () => {
    expect(() => workerDeadlinesEnabled({ execution_limits: { ...ticket().execution_limits, version: 4 } }))
      .toThrow(/unsupported/);
    expect(() => workerDeadlinesEnabled({ execution_policy: {
      ...executionPolicySnapshot(DEFAULT_CONFIG), version: 2,
    } })).toThrow(/inconsistent/);
    expect(workerDeadlinesEnabled({})).toBe(true);
    expect(workerDeadlinesEnabled({ policy: { version: 3 } })).toBe(true);
  });

  it('persists and diagnoses a live deadline-free run without marking its null timestamp corrupt', () => {
    const run = state();
    expect(() => assertActiveStateWritable(run)).not.toThrow();
    expect(projectRunDiagnostic(run).reason_code).not.toBe('corrupt_state');
    const malformed = structuredClone(run);
    malformed.tickets[0].execution_limits.version = 2;
    expect(() => assertActiveStateWritable(malformed)).toThrow(/invalid shape/);
    expect(projectRunDiagnostic(malformed).reason_code).toBe('corrupt_state');
    malformed.tickets[0].execution_limits.version = 4;
    malformed.tickets[0].deadline_at = '2026-09-27T12:00:00.000Z';
    expect(() => assertActiveStateWritable(malformed)).toThrow(/invalid shape/);
    expect(projectRunDiagnostic(malformed).reason_code).toBe('corrupt_state');
  });

  it('keeps a pending v3 ticket after arbitrary elapsed time without spending a retry', () => {
    const run = state();
    const actions = reduceRun(run, { type: 'NEXT', at: '2099-01-01T00:00:00.000Z' });
    expect(actions).toEqual([{ type: 'dispatch_agent', ticket_id: run.tickets[0].ticket_id }]);
    expect(run.attempts.build).toBe(1);
    expect(run.expired_tickets).toEqual([]);
  });
});
