import { describe, expect, it } from 'vitest';
import { reduceRun } from '../lib/runtime/scheduler.js';

// A test-contradiction failure (evidence.failure_kind 'test-contradiction' —
// the independently authored behavioral test is itself faulty) is a verdict
// on the authored test, not the implementer: invariant 3 makes authored tests
// read-only to the implementer, so the verbatim retry would re-issue an
// identical ticket against an identical faulty test and meet an identical
// refusal. The reducer must skip the futile retry and block with a reason
// that ATTRIBUTES the fault claim to the implementer (the marker is
// agent-supplied and unverified, so the runtime must not assert it as fact —
// invariant 8), while review-group receipts keep falling through as disagree
// votes and the marker stays inert on a passed receipt.

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
  it('blocks immediately on a test-contradiction failure with attempts remaining', () => {
    const state = run({
      attempts: { build: 1 },
      tickets: [{ ticket_id: 't1', stage_id: 'build' }],
    });
    const actions = reduceRun(state, {
      type: 'RECEIPT_RECORDED',
      ticket: state.tickets[0],
      receipt: {
        status: 'failed',
        evidence: { failure_kind: 'test-contradiction', summary: CONTRADICTION },
      },
      stage: { id: 'build', role: 'implementer', parallel_group: null },
    });
    expect(actions.map((entry) => entry.type)).toEqual([
      'transition',
      'archive_history',
      'release_lock',
      'persist_state',
    ]);
    expect(actions.some((entry) => entry.type === 'issue_ticket')).toBe(false);
    const { patch } = actions[0];
    expect(patch.status).toBe('blocked');
    expect(patch.stage).toBe('build');
    expect(patch.block_reason).toContain('test-contradiction-blocked');
    // The exact contradiction rides along via the attempt-summary diagnostics;
    // the parenthetical attributes the fault claim to the implementer instead
    // of asserting it in runtime voice — the marker is agent-supplied and the
    // runtime verifies nothing about it (invariant 8), so the archived reason
    // must not state "the test is faulty" as established fact.
    expect(patch.block_reason).toBe(
      `stage build test-contradiction-blocked (implementer reported the authored test contradicts itself or the ticket — an unverified agent claim; confirm it before re-authoring the test or debugging the implementation): attempt 1: ${CONTRADICTION}`,
    );
    expect(actions[1].if_absent).toBe(true);
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
