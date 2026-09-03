import { describe, expect, it } from 'vitest';
import { reduceRun } from '../lib/runtime/scheduler.js';

// A capability failure means the immutable ticket lacks required authority, so
// it blocks honestly. A correctable policy syntax mistake uses command-shape
// and gets one bounded same-contract redispatch without consuming a logical
// stage attempt. Review-group capability denials
// wait for convergence, and the capability marker is inert on a pass.

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
    expect(actions[0].patch).toMatchObject({ status: 'blocked', stage: 'build' });
    expect(actions[0].patch.block_reason).toBe(`stage build capability-blocked: attempt 1: ${DENIAL}`);
  });

  it('issues one evidence-backed same-contract redispatch for a correctable command-shape denial', () => {
    const state = run({
      attempts: { build: 1 },
      tickets: [{ ticket_id: 't1', stage_id: 'build' }],
    });
    const actions = reduceRun(state, {
      type: 'RECEIPT_RECORDED',
      ticket: state.tickets[0],
      receipt: { status: 'failed', evidence: { failure_kind: 'command-shape', summary: DENIAL } },
      stage: { id: 'build', role: 'implementer', parallel_group: null },
    });
    expect(actions.map((entry) => entry.type)).toEqual(['transition', 'issue_ticket', 'persist_state']);
    expect(actions[0].patch).not.toHaveProperty('attempts');
    expect(actions[0].patch.worker_protocol_redispatches).toEqual({ build: 1 });
    expect(actions[1]).toMatchObject({
      recovery_kind: 'reissue_same_contract',
      source_ticket_id: 't1',
      failure_domain: 'orchestration',
    });
    expect(actions[1]).not.toHaveProperty('retry_of');
    expect(actions[1].prior_attempts).toEqual([`attempt 1: ${DENIAL}`]);
  });

  it('issues one fresh same-attempt ticket for an exact additive capability claim', () => {
    const source = {
      ticket_id: 't-capability-source',
      stage_id: 'build',
      role: 'implementer',
      parallel_group: null,
      attempt: 1,
      claimed_paths: ['src/value.js'],
      test_paths: ['tests/value.test.js'],
    };
    const state = run({
      claimed_paths: [...source.claimed_paths],
      test_paths: [...source.test_paths],
      attempts: { build: 1 },
      tickets: [source],
    });
    const actions = reduceRun(state, {
      type: 'RECEIPT_RECORDED',
      ticket: source,
      receipt: {
        ticket_id: source.ticket_id,
        status: 'failed',
        evidence: {
          failure_kind: 'capability',
          summary: 'implementation also requires src/helper.js',
          required_claims: { claimed_paths: ['src/helper.js'] },
        },
      },
      stage: { id: 'build', role: 'implementer', parallel_group: null },
    });

    expect(actions.some((entry) => entry.type === 'archive_history')).toBe(false);
    expect(actions.some((entry) => entry.type === 'release_lock')).toBe(false);
    const transition = actions.find((entry) => entry.type === 'transition');
    expect(transition.patch).not.toHaveProperty('status', 'blocked');
    expect(transition.patch).not.toHaveProperty('attempts');
    const successor = actions.find((entry) => entry.type === 'issue_ticket');
    expect(successor).toMatchObject({
      stage: { id: 'build', role: 'implementer' },
      source_ticket_id: source.ticket_id,
      recovery_kind: expect.stringMatching(/capability/i),
    });
    expect(successor).not.toHaveProperty('retry_of');
    expect(successor.prior_attempts).toContain('attempt 1: implementation also requires src/helper.js');
  });

  it('does not mint a third ticket when an automatic capability successor asks to grow again', () => {
    const source = {
      ticket_id: 't-capability-source',
      stage_id: 'build',
      role: 'implementer',
      parallel_group: null,
      attempt: 1,
      claimed_paths: ['src/value.js'],
      test_paths: [],
    };
    const successor = {
      ...source,
      ticket_id: 't-capability-successor',
      claimed_paths: ['src/value.js', 'src/helper.js'],
      recovery_kind: 'capability_scope_expansion',
      source_ticket_id: source.ticket_id,
    };
    const firstReceipt = {
      ticket_id: source.ticket_id,
      status: 'failed',
      evidence: {
        failure_kind: 'capability',
        required_claims: { claimed_paths: ['src/helper.js'] },
      },
    };
    const state = run({
      claimed_paths: [...successor.claimed_paths],
      attempts: { build: 1 },
      tickets: [source, successor],
      receipts: [firstReceipt],
      capability_recoveries: { build: 1 },
    });
    const actions = reduceRun(state, {
      type: 'RECEIPT_RECORDED',
      ticket: successor,
      receipt: {
        ticket_id: successor.ticket_id,
        status: 'failed',
        evidence: {
          failure_kind: 'capability',
          summary: 'a second expansion would churn tickets',
          required_claims: { claimed_paths: ['src/again.js'] },
        },
      },
      stage: { id: 'build', role: 'implementer', parallel_group: null },
    });

    expect(actions.some((entry) => entry.type === 'issue_ticket')).toBe(false);
    expect(actions.find((entry) => entry.type === 'transition').patch).toMatchObject({
      status: 'blocked',
      stage: 'build',
    });
    expect(actions.find((entry) => entry.type === 'transition').patch.attempts).toBeUndefined();
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

  it('blocks actionably after a capability-marked review group settles', () => {
    const ticket = {
      ticket_id: 't-review',
      stage_id: 'review',
      role: 'reviewer',
      parallel_group: 'code-review',
      claimed_paths: [],
      test_paths: [],
    };
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
    expect(actions.some((entry) => entry.type === 'issue_ticket')).toBe(false);
    const transition = actions.find((entry) => entry.type === 'transition');
    expect(transition.patch).toMatchObject({
      status: 'blocked',
      stage: 'review',
      terminal_reason_code: 'capability_blocked',
      blocked_recovery: {
        source_ticket_id: ticket.ticket_id,
        successor_required: true,
        supersession_required: true,
      },
    });
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
