import { describe, expect, it } from 'vitest';
import { reduceRun } from '../lib/runtime/scheduler.js';

// A test-contradiction failure (evidence.failure_kind 'test-contradiction') is
// an implementer claim, not a runtime verdict. Invariant 3 keeps authored tests
// read-only to the implementer, so the scheduler routes one independent,
// read-only reconciliation rather than retrying blindly or asserting the test
// is faulty. The marker stays inert on passed and review-group receipts.

function run(overrides = {}) {
  return {
    run_id: 'run-1',
    mode: 'phase',
    lane: 'fast',
    status: 'running',
    stage: 'build',
    high_risk: false,
    tickets: [],
    receipts: [],
    attempts: {},
    remediation_cycles: 0,
    ...overrides,
  };
}

const CONTRADICTION =
  'authored test asserts computeTotal(order) both returns 0 and throws for the same input';

describe('APE v2 test-contradiction-blocked failure (reducer)', () => {
  it('routes a behavioral implementer contradiction through one read-only reconciliation', () => {
    const state = run({
      behavioral: true,
      test_paths: ['tests/value.test.js'],
      attempts: { build: 1 },
      tickets: [{
        ticket_id: 't1',
        stage_id: 'build',
        role: 'implementer',
        test_paths: ['tests/value.test.js'],
      }],
    });
    const actions = reduceRun(state, {
      type: 'RECEIPT_RECORDED',
      ticket: state.tickets[0],
      receipt: {
        status: 'failed',
        evidence: {
          failure_kind: 'test-contradiction',
          summary: CONTRADICTION,
          test_contradiction: {
            summary: CONTRADICTION,
            test_paths: ['tests/value.test.js'],
          },
        },
      },
      stage: { id: 'build', role: 'implementer', parallel_group: null },
    });
    expect(actions.map((entry) => entry.type)).toEqual([
      'transition',
      'issue_ticket',
      'persist_state',
    ]);
    const { patch } = actions[0];
    expect(patch.test_contradiction_reconciliations).toBe(1);
    expect(patch.test_contradiction_pending).toMatchObject({
      source_ticket_id: 't1',
      source_stage_id: 'build',
      context: {
        version: 1,
        attempt: 1,
        report: CONTRADICTION,
        test_paths: ['tests/value.test.js'],
      },
    });
    expect(actions[1]).toMatchObject({
      type: 'issue_ticket',
      stage: { id: 'test-reconcile', role: 'reviewer' },
      test_reconciliation: { test_paths: ['tests/value.test.js'] },
    });
    expect(patch.status).toBeUndefined();
  });

  it('ignores the marker on a passed receipt and advances normally', () => {
    const ticket = { ticket_id: 't-test', stage_id: 'test' };
    const state = run({
      stage: 'test',
      attempts: { test: 1 },
      tickets: [ticket],
    });
    const actions = reduceRun(state, {
      type: 'RECEIPT_RECORDED',
      ticket,
      receipt: {
        status: 'passed',
        evidence: { failure_kind: 'test-contradiction', verdict: 'pass' },
      },
      stage: { id: 'test', role: 'test_writer', parallel_group: null },
    });
    expect(actions.map((entry) => entry.type)).toEqual(['issue_ticket', 'persist_state']);
    expect(actions[0].stage.id).toBe('build');
  });

  it('treats a test-contradiction-marked review receipt as a disagree vote, not an early block', () => {
    const ticket = { ticket_id: 't-review', stage_id: 'review', parallel_group: 'code-review' };
    const receipt = {
      ticket_id: 't-review',
      status: 'failed',
      evidence: { failure_kind: 'test-contradiction', summary: CONTRADICTION },
    };
    const state = run({
      stage: 'review',
      attempts: { review: 1 },
      tickets: [ticket],
      receipts: [receipt],
    });
    const actions = reduceRun(state, {
      type: 'RECEIPT_RECORDED',
      ticket,
      receipt,
      stage: { id: 'review', role: 'reviewer', parallel_group: 'code-review' },
      next_state: state,
    });
    // Falls through to the group outcome: one remediation cycle, no block.
    const transition = actions.find((entry) => entry.type === 'transition');
    expect(transition.patch.remediation_cycles).toBe(1);
    expect(transition.patch.status).toBeUndefined();
    const issued = actions.find((entry) => entry.type === 'issue_ticket');
    expect(issued.stage.id).toBe('remediation-build');
  });
});
