import { describe, expect, it } from 'vitest';
import { receiptRejectionRecovery } from '../lib/runtime/recovery-guidance.js';
import { projectRunResponse, RESPONSE_BUDGET_BYTES } from '../lib/runtime/projection.js';
import { reduceRun } from '../lib/runtime/scheduler.js';

function assertAdvertisedActionsAreEligible(state, guidance) {
  for (const advertised of guidance.eligible_actions) {
    const event = advertised === 'diagnose' ? { type: 'STATUS' } : {
      type: 'OVERRIDE', operation: advertised.slice('override-'.length), reason: 'explicit synthetic operator decision',
    };
    // Exercise the real lifecycle receiving boundary, not a duplicate list of
    // status names. Recommendation must remain valid when that policy changes.
    const actions = reduceRun(state, event);
    expect(actions.some((entry) => entry.type === 'reject'), `${state.status}: ${advertised}`).toBe(false);
  }
}

describe('bounded receipt rejection recovery guidance', () => {
  it.each(['starting', 'planning', 'running', 'input_required', 'gating', 'shipping'])('never offers reset for %s', (status) => {
    const state = Object.freeze({ status });
    const result = receiptRejectionRecovery(state, 'receipt-tree-diverged');
    expect(result).toMatchObject({
      version: 1, cause: 'receipt-tree-diverged', run_status: status,
      state_changed: false, eligible_actions: ['diagnose', 'override-abort'],
      operator_required: true, preserves_worktree: true,
    });
    expect(result.preconditions).toContain('explicit-operator-direction-and-nonempty-audit-reason');
    expect(result.preconditions).toContain('preserve-current-tree-before-lifecycle-change');
    expect(result.preconditions).toContain('reset-requires-blocked-aborted-or-completed-state');
    assertAdvertisedActionsAreEligible(state, result);
    expect(reduceRun(state, { type: 'OVERRIDE', operation: 'reset', reason: 'synthetic prohibited reset' }))
      .toContainEqual(expect.objectContaining({ type: 'reject' }));
  });

  it.each(['blocked', 'aborted', 'completed'])('offers only operator-audited reset for %s', (status) => {
    const state = Object.freeze({ status });
    const result = receiptRejectionRecovery(state, 'receipt-role-boundary');
    expect(result).toMatchObject({
      cause: 'receipt-role-boundary', run_status: status,
      eligible_actions: ['diagnose', 'override-reset'],
      state_changed: false, operator_required: true, preserves_worktree: true,
    });
    assertAdvertisedActionsAreEligible(state, result);
  });

  it('bounds unknown input without copying identifiers, paths, errors, or capabilities', () => {
    const secret = 'private bearer and path';
    const result = receiptRejectionRecovery({ status: secret, objective: secret }, secret);
    expect(result.run_status).toBe('unknown');
    expect(result.cause).toBe('receipt-invalid');
    expect(result.eligible_actions).toEqual(['diagnose']);
    expect(JSON.stringify(result)).not.toContain(secret);
    expect(JSON.stringify(result).length).toBeLessThan(1500);
    expect(receiptRejectionRecovery(null, null)).toEqual(result);
  });

  it('retains safe recovery guidance through the emergency MCP response budget', () => {
    const recovery = receiptRejectionRecovery({ status: 'running' }, 'receipt-role-boundary');
    const input = { ok: false, rejected: true, recovery, errors: ['x'.repeat(500_000)] };
    const projected = projectRunResponse(input);
    expect(projected.recovery).toEqual(recovery);
    expect(projected.recovery.eligible_actions).not.toContain('override-reset');
    expect(Buffer.byteLength(JSON.stringify(projected))).toBeLessThan(25_000);
  });

  it('drops malformed recovery objects and strips untrusted prose from valid descriptors', () => {
    expect(projectRunResponse({ recovery: { version: 1, cause: 'secret' } })).not.toHaveProperty('recovery');
    const recovery = receiptRejectionRecovery({ status: 'running' }, 'receipt-invalid');
    expect(projectRunResponse({ recovery: { ...recovery, secret: 'private bearer' } }).recovery).toEqual(recovery);
    const legacy = { recovery: { active: false, type: null, regate_attempts: 0 } };
    expect(projectRunResponse(legacy)).toEqual(legacy);
  });

  it('keeps the complete admission manifest and digest when only unrelated preview prose exceeds the budget', () => {
    const admission = { version: 1, ready: true, request: { objective: 'synthetic' } };
    const response = { ok: true, advisory: true, blueprint: {}, admission,
      admission_digest: 'a'.repeat(64), padding: 'x'.repeat(RESPONSE_BUDGET_BYTES * 2) };
    const projected = projectRunResponse(response);
    expect(projected.admission).toEqual(admission);
    expect(projected.admission_digest).toBe(response.admission_digest);
    expect(projected.projection).toBeDefined();
  });

  it('refuses an oversized admission manifest without a usable digest or truncated ready claim', () => {
    const response = { ok: true, advisory: true, blueprint: {},
      admission: { version: 1, ready: true, request: { objective: 'x'.repeat(RESPONSE_BUDGET_BYTES * 2) } },
      admission_digest: 'a'.repeat(64) };
    const projected = projectRunResponse(response);
    expect(projected).toMatchObject({ ok: false, blocked: true, code: 'admission-response-too-large',
      attempts_consumed: 0, admission: { version: 1, ready: false } });
    expect(projected).not.toHaveProperty('admission_digest');
    expect(projected.reason).toMatch(/decompos/i);
    expect(Buffer.byteLength(JSON.stringify(projected))).toBeLessThan(RESPONSE_BUDGET_BYTES);
    expect(response.admission.ready).toBe(true);
  });
});
