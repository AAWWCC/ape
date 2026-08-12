import { describe, expect, it } from 'vitest';
import { reduceRun } from '../lib/runtime/scheduler.js';

// A capability failure (evidence.failure_kind 'capability' — APE policy itself
// denied a required operation) is a verdict on the environment: the verbatim
// retry would re-dispatch an identical ticket against an identical gate, so
// the reducer must skip it and block honestly, while every unmarked failure
// keeps its one retry, review-group receipts keep falling through as disagree
// votes, and the marker is inert on a passed receipt.

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

const DENIAL = 'APE write denied: target resolves outside the ticket claims';

describe('APE v2 capability-blocked failure (reducer)', () => {
  it('blocks immediately on a capability-marked failure with attempts remaining', () => {
    const state = run({
      attempts: { build: 1 },
      tickets: [{ ticket_id: 't1', stage_id: 'build' }],
    });
    const actions = reduceRun(state, {
      type: 'RECEIPT_RECORDED',
      ticket: state.tickets[0],
      receipt: { status: 'failed', evidence: { failure_kind: 'capability', summary: DENIAL } },
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
    expect(patch.block_reason).toContain('capability-blocked');
    // The exact denial reason rides along via the attempt-summary diagnostics.
    expect(patch.block_reason).toBe(`stage build capability-blocked: attempt 1: ${DENIAL}`);
    expect(actions[1].if_absent).toBe(true);
  });

  it('still issues the verbatim retry for an unmarked failure', () => {
    const state = run({
      attempts: { build: 1 },
      tickets: [{ ticket_id: 't1', stage_id: 'build' }],
    });
    const stage = { id: 'build', role: 'implementer', parallel_group: null };
    const actions = reduceRun(state, {
      type: 'RECEIPT_RECORDED',
      ticket: state.tickets[0],
      receipt: { status: 'failed', evidence: { summary: 'targeted tests failed' } },
      stage,
    });
    expect(actions.map((entry) => entry.type)).toEqual([
      'transition',
      'issue_ticket',
      'persist_state',
    ]);
    expect(actions[0].patch.attempts.build).toBe(2);
    expect(actions[1].retry_of).toBe('t1');
    expect(actions[1].stage).toBe(stage);
  });

  it('treats a capability-marked review receipt as a disagree vote, not an early block', () => {
    const ticket = { ticket_id: 't-review', stage_id: 'review', parallel_group: 'code-review' };
    const receipt = {
      ticket_id: 't-review',
      status: 'failed',
      evidence: { failure_kind: 'capability', summary: DENIAL },
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
      receipt: { status: 'passed', evidence: { failure_kind: 'capability', verdict: 'pass' } },
      stage: { id: 'test', role: 'test_writer', parallel_group: null },
    });
    expect(actions.map((entry) => entry.type)).toEqual(['issue_ticket', 'persist_state']);
    expect(actions[0].stage.id).toBe('build');
  });

  it('reports the capability block reason even when the failure lands on the retry attempt', () => {
    const state = run({
      attempts: { build: 2 },
      tickets: [
        { ticket_id: 't1', stage_id: 'build', attempt: 1 },
        { ticket_id: 't2', stage_id: 'build', attempt: 2 },
      ],
      receipts: [
        { ticket_id: 't1', status: 'failed', evidence: { summary: 'targeted tests failed' } },
      ],
    });
    const actions = reduceRun(state, {
      type: 'RECEIPT_RECORDED',
      ticket: state.tickets[1],
      receipt: { status: 'failed', evidence: { failure_kind: 'capability', summary: DENIAL } },
      stage: { id: 'build', role: 'implementer', parallel_group: null },
    });
    const { patch } = actions.find((entry) => entry.type === 'transition');
    expect(patch.status).toBe('blocked');
    expect(patch.block_reason).toBe(
      `stage build capability-blocked: attempt 1: targeted tests failed; attempt 2: ${DENIAL}`,
    );
  });
});
