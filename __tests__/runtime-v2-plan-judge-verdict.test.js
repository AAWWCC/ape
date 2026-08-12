import { describe, expect, it } from 'vitest';
import { MAX_STAGE_ATTEMPTS } from '../lib/runtime/constants.js';
import { reduceRun } from '../lib/runtime/scheduler.js';

// friction #22: a plan-judge receipt can be status 'passed' (the stage ran to
// completion) while its evidence records verdict 'disagree' (the judge upheld
// the plan-review disagreement). The reducer must block the run instead of
// advancing to the test stage — advancing would build against a plan the
// pipeline's own judge ruled unsound. These tests drive the pure reducer the
// way service.applyActions would, mirroring the harness style of
// runtime-v2-core-remediation-convergence.test.js.

let ticketCounter = 0;

function baseRun(overrides = {}) {
  return {
    run_id: 'run-1',
    mode: 'phase',
    lane: 'full',
    status: 'running',
    stage: 'dispatch',
    high_risk: false,
    tickets: [],
    receipts: [],
    attempts: {},
    remediation_cycles: 0,
    ...overrides,
  };
}

function issue(state, stage) {
  const ticket = {
    ticket_id: `ticket-${(ticketCounter += 1)}`,
    stage_id: stage.id,
    role: stage.role,
    parallel_group: stage.parallel_group ?? null,
  };
  state.tickets.push(ticket);
  state.stage = stage.id;
  return ticket;
}

// Record a receipt and apply the reducer's transition/issue_ticket effects in
// order, mirroring service.applyActions.
function record(state, ticket, overrides = {}) {
  const receipt = {
    ticket_id: ticket.ticket_id,
    status: 'passed',
    evidence: { verdict: 'agree' },
    ...overrides,
  };
  state.receipts.push(receipt);
  const actions = reduceRun(state, {
    type: 'RECEIPT_RECORDED',
    ticket,
    receipt,
    stage: { id: ticket.stage_id, role: ticket.role, parallel_group: ticket.parallel_group },
    next_state: state,
  });
  for (const action of actions) {
    if (action.type === 'transition') Object.assign(state, action.patch);
    if (action.type === 'issue_ticket') issue(state, action.stage);
  }
  return actions;
}

// A full-lane run parked at a pending plan-judge ticket, as if plan-review had
// already disagreed and the judge stage had been issued.
function stateAtPlanJudge(overrides = {}) {
  const state = baseRun(overrides);
  const judgeTicket = issue(state, { id: 'plan-judge', role: 'plan_judge', parallel_group: null });
  return { state, judgeTicket };
}

describe('APE v2 plan-judge verdict handling (friction #22)', () => {
  it('blocks the run when a passed plan-judge receipt records verdict disagree', () => {
    const { state, judgeTicket } = stateAtPlanJudge();
    const actions = record(state, judgeTicket, { evidence: { verdict: 'disagree' } });

    expect(actions.map((action) => action.type)).toEqual([
      'transition',
      'archive_history',
      'release_lock',
      'persist_state',
    ]);
    expect(actions[0].patch.status).toBe('blocked');
    expect(actions[0].patch.stage).toBe('plan-judge');
    expect(actions[0].patch.block_reason).toMatch(/plan judged unsound/);
    expect(actions[1].if_absent).toBe(true);
    expect(actions.some((action) => action.type === 'issue_ticket')).toBe(false);
    expect(actions.some((action) => action.type === 'run_gates')).toBe(false);
    expect(state.status).toBe('blocked');
  });

  it('advances to the test stage when the judge agrees', () => {
    const { state, judgeTicket } = stateAtPlanJudge();
    const actions = record(state, judgeTicket, { evidence: { verdict: 'agree' } });

    const issued = actions.filter((action) => action.type === 'issue_ticket');
    expect(issued).toHaveLength(1);
    expect(issued[0].stage.id).toBe('test');
    expect(issued[0].stage.role).toBe('test_writer');
    expect(actions.some((action) => action.type === 'persist_state')).toBe(true);
    expect(state.status).toBe('running');
  });

  // Recorded policy decision: an ABSENT verdict falls back to the receipt
  // status (groupOutcome semantics), so hosts whose plan-judge receipts signal
  // only via status keep advancing.
  it('advances when a passed receipt carries no verdict (empty evidence)', () => {
    const { state, judgeTicket } = stateAtPlanJudge();
    const actions = record(state, judgeTicket, { evidence: {} });

    const issued = actions.filter((action) => action.type === 'issue_ticket');
    expect(issued).toHaveLength(1);
    expect(issued[0].stage.id).toBe('test');
    expect(state.status).toBe('running');
  });

  it('advances when a passed receipt carries no evidence at all', () => {
    const { state, judgeTicket } = stateAtPlanJudge();
    const actions = record(state, judgeTicket, { evidence: undefined });

    const issued = actions.filter((action) => action.type === 'issue_ticket');
    expect(issued).toHaveLength(1);
    expect(issued[0].stage.id).toBe('test');
    expect(state.status).toBe('running');
  });

  it('treats the verdict case-insensitively: DISAGREE blocks', () => {
    const { state, judgeTicket } = stateAtPlanJudge();
    const actions = record(state, judgeTicket, { evidence: { verdict: 'DISAGREE' } });

    expect(actions[0].type).toBe('transition');
    expect(actions[0].patch.status).toBe('blocked');
    expect(actions[0].patch.block_reason).toMatch(/plan judged unsound/);
    expect(state.status).toBe('blocked');
  });
});

describe('APE v2 plan-judge full-lane lifecycle (friction #22)', () => {
  // Drive a full-lane run from START through a plan-review disagreement to the
  // judge, applying effects the way service.applyActions would.
  function walkToPlanJudge() {
    const startActions = reduceRun(undefined, {
      type: 'START',
      run: { run_id: 'run-1', mode: 'phase', lane: 'full' },
    });
    const state = baseRun();
    for (const action of startActions) {
      if (action.type === 'transition') Object.assign(state, action.patch);
      if (action.type === 'issue_ticket') issue(state, action.stage);
    }
    const planTicket = state.tickets.at(-1);
    expect(planTicket.stage_id).toBe('plan');

    record(state, planTicket);
    const [planCheck, planCritic] = state.tickets.slice(-2);
    expect(planCheck.stage_id).toBe('plan-check');
    expect(planCritic.stage_id).toBe('plan-critic');
    expect(planCheck.parallel_group).toBe('plan-review');
    expect(planCritic.parallel_group).toBe('plan-review');

    record(state, planCheck, { evidence: { verdict: 'agree' } });
    record(state, planCritic, { evidence: { verdict: 'disagree' } });
    const judgeTicket = state.tickets.at(-1);
    expect(judgeTicket.stage_id).toBe('plan-judge');
    expect(judgeTicket.parallel_group).toBe(null);
    return { state, judgeTicket };
  }

  it('a disagreeing judge blocks the run and the block is scheduling-terminal and not gate-recoverable', () => {
    const { state, judgeTicket } = walkToPlanJudge();
    const ticketCountBefore = state.tickets.length;

    record(state, judgeTicket, { evidence: { verdict: 'disagree' } });
    expect(state.status).toBe('blocked');
    expect(state.stage).toBe('plan-judge');
    expect(state.block_reason).toMatch(/plan judged unsound/);
    expect(state.tickets.length).toBe(ticketCountBefore);

    const next = reduceRun(state, { type: 'NEXT', at: new Date().toISOString() });
    expect(next).toHaveLength(1);
    expect(next[0].type).toBe('reject');
    expect(next[0].reason).toBe('run is blocked');

    // A plan block is unsound work, not a broken environment: REGATE must not
    // recover it.
    const regate = reduceRun(state, { type: 'REGATE' });
    expect(regate).toHaveLength(1);
    expect(regate[0].type).toBe('reject');
    expect(regate[0].reason).toBe('re-gate is valid only for a gate-blocked run; recover any other block through the audited OVERRIDE reset or ABORT');
  });

  it('an agreeing judge advances the run to the test stage', () => {
    const { state, judgeTicket } = walkToPlanJudge();
    record(state, judgeTicket, { evidence: { verdict: 'agree' } });

    expect(state.status).toBe('running');
    const testTicket = state.tickets.at(-1);
    expect(testTicket.stage_id).toBe('test');
    expect(testTicket.role).toBe('test_writer');
  });
});

describe('APE v2 plan-judge failed-receipt regression guard (friction #22)', () => {
  it('a failed judge receipt keeps the generic retry path: one retry ticket, no block', () => {
    const { state, judgeTicket } = stateAtPlanJudge({ attempts: { 'plan-judge': 1 } });
    const actions = record(state, judgeTicket, { status: 'failed', evidence: {} });

    const issued = actions.filter((action) => action.type === 'issue_ticket');
    expect(issued).toHaveLength(1);
    expect(issued[0].stage.id).toBe('plan-judge');
    expect(issued[0].retry_of).toBe(judgeTicket.ticket_id);
    expect(actions.some((action) => action.type === 'archive_history')).toBe(false);
    expect(state.status).toBe('running');
    expect(state.attempts['plan-judge']).toBe(2);
  });

  it('a second failed judge receipt blocks via the generic failed-twice arm', () => {
    const { state, judgeTicket } = stateAtPlanJudge({ attempts: { 'plan-judge': 2 } });
    const actions = record(state, judgeTicket, { status: 'failed', evidence: {} });

    expect(actions.some((action) => action.type === 'issue_ticket')).toBe(false);
    expect(state.status).toBe('blocked');
    expect(state.block_reason).toBe('stage plan-judge failed twice');
  });
});

// friction #23 extension: a non-passed plan-check/plan-critic receipt is a dissent vote
// routed to the plan-judge via the plan-review-disagreed synthetic — never a
// verbatim retry, never the failed-twice block, and (friction #36 precedent) never the
// capability/test-contradiction operator block. plan-judge itself keeps the
// generic retry (regression guard above).
describe('APE v2 plan-review dissent routing (friction #23 extension)', () => {
  // A full-lane run parked at pending plan-check and plan-critic tickets, as
  // if the plan stage had just passed.
  function stateAtPlanReview(overrides = {}) {
    const state = baseRun(overrides);
    const planCheck = issue(state, {
      id: 'plan-check',
      role: 'plan_checker',
      parallel_group: 'plan-review',
    });
    const planCritic = issue(state, {
      id: 'plan-critic',
      role: 'plan_critic',
      parallel_group: 'plan-review',
    });
    return { state, planCheck, planCritic };
  }

  it('a failed plan-check with plan-critic outstanding only persists: no retry, no attempt consumed', () => {
    const { state, planCheck } = stateAtPlanReview();
    const actions = record(state, planCheck, { status: 'failed', evidence: {} });

    expect(actions.map((action) => action.type)).toEqual(['persist_state']);
    expect(state.attempts['plan-check']).toBeUndefined();
    expect(state.status).toBe('running');
  });

  it('a failed plan-check plus an agreeing plan-critic issues the plan-judge without a retry', () => {
    const { state, planCheck, planCritic } = stateAtPlanReview();
    record(state, planCheck, { status: 'failed', evidence: {} });
    const actions = record(state, planCritic, { evidence: { verdict: 'agree' } });

    const issued = actions.filter((action) => action.type === 'issue_ticket');
    expect(issued).toHaveLength(1);
    expect(issued[0].stage.id).toBe('plan-judge');
    expect(actions.every((action) => action.retry_of === undefined)).toBe(true);
    expect(actions.some((action) => action.type === 'archive_history')).toBe(false);
    expect(state.status).toBe('running');
    expect(state.remediation_cycles).toBe(0);
  });

  it('an agreeing plan-check plus a failed plan-critic issues the plan-judge without a retry', () => {
    const { state, planCheck, planCritic } = stateAtPlanReview();
    record(state, planCheck, { evidence: { verdict: 'agree' } });
    const actions = record(state, planCritic, { status: 'failed', evidence: {} });

    const issued = actions.filter((action) => action.type === 'issue_ticket');
    expect(issued).toHaveLength(1);
    expect(issued[0].stage.id).toBe('plan-judge');
    expect(actions.every((action) => action.retry_of === undefined)).toBe(true);
    expect(state.status).toBe('running');
  });

  // The exact reported symptom: with the stage's attempts already exhausted, a
  // failed plan-review receipt must still be a vote, never the failed-twice
  // block.
  it('a failed plan-check at MAX_STAGE_ATTEMPTS still routes as a vote, never failed twice', () => {
    const { state, planCheck, planCritic } = stateAtPlanReview({
      attempts: { 'plan-check': MAX_STAGE_ATTEMPTS },
    });
    const first = record(state, planCheck, { status: 'failed', evidence: {} });
    expect(first.map((action) => action.type)).toEqual(['persist_state']);
    expect(state.status).toBe('running');

    const actions = record(state, planCritic, { evidence: { verdict: 'agree' } });
    const issued = actions.filter((action) => action.type === 'issue_ticket');
    expect(issued).toHaveLength(1);
    expect(issued[0].stage.id).toBe('plan-judge');
    expect(state.status).toBe('running');
    expect(state.block_reason).toBeUndefined();
  });

  it('both plan-review receipts failed issues the plan-judge exactly once', () => {
    const { state, planCheck, planCritic } = stateAtPlanReview();
    record(state, planCheck, { status: 'failed', evidence: {} });
    const actions = record(state, planCritic, { status: 'failed', evidence: {} });

    const issued = actions.filter((action) => action.type === 'issue_ticket');
    expect(issued).toHaveLength(1);
    expect(issued[0].stage.id).toBe('plan-judge');
    expect(state.status).toBe('running');
  });

  // Regression guard for the pre-existing encoding: passed + verdict disagree
  // routed to the judge before this fix and must keep doing so.
  it('a passed plan-check with verdict disagree still routes to the plan-judge', () => {
    const { state, planCheck, planCritic } = stateAtPlanReview();
    record(state, planCheck, { evidence: { verdict: 'disagree' } });
    const actions = record(state, planCritic, { evidence: { verdict: 'agree' } });

    const issued = actions.filter((action) => action.type === 'issue_ticket');
    expect(issued).toHaveLength(1);
    expect(issued[0].stage.id).toBe('plan-judge');
    expect(state.status).toBe('running');
  });

  // friction #36 precedent: a marked review-group receipt still votes disagree — for
  // plan-review the judge, not the capability-blocked operator block, weighs
  // the reported malfunction.
  it('a capability-marked failed plan-critic votes disagree instead of capability-blocking', () => {
    const { state, planCheck, planCritic } = stateAtPlanReview();
    record(state, planCheck, { evidence: { verdict: 'agree' } });
    const actions = record(state, planCritic, {
      status: 'failed',
      evidence: { failure_kind: 'capability', summary: 'APE read denied: plan outside project root' },
    });

    const issued = actions.filter((action) => action.type === 'issue_ticket');
    expect(issued).toHaveLength(1);
    expect(issued[0].stage.id).toBe('plan-judge');
    expect(state.status).toBe('running');
    expect(state.block_reason).toBeUndefined();
  });

  it('a test-contradiction-marked failed plan-check votes disagree instead of blocking', () => {
    const { state, planCheck, planCritic } = stateAtPlanReview();
    record(state, planCheck, {
      status: 'failed',
      evidence: { failure_kind: 'test-contradiction', summary: 'claimed contradiction' },
    });
    const actions = record(state, planCritic, { evidence: { verdict: 'agree' } });

    const issued = actions.filter((action) => action.type === 'issue_ticket');
    expect(issued).toHaveLength(1);
    expect(issued[0].stage.id).toBe('plan-judge');
    expect(state.status).toBe('running');
    expect(state.block_reason).toBeUndefined();
  });

  it('full lifecycle: failed plan-check dissent reaches the judge and an agreeing judge advances to test', () => {
    const startActions = reduceRun(undefined, {
      type: 'START',
      run: { run_id: 'run-1', mode: 'phase', lane: 'full' },
    });
    const state = baseRun();
    const recorded = [];
    for (const action of startActions) {
      if (action.type === 'transition') Object.assign(state, action.patch);
      if (action.type === 'issue_ticket') issue(state, action.stage);
    }
    const planTicket = state.tickets.at(-1);
    expect(planTicket.stage_id).toBe('plan');

    recorded.push(...record(state, planTicket));
    const [planCheck, planCritic] = state.tickets.slice(-2);
    expect(planCheck.stage_id).toBe('plan-check');
    expect(planCritic.stage_id).toBe('plan-critic');

    recorded.push(...record(state, planCheck, { status: 'failed', evidence: {} }));
    recorded.push(...record(state, planCritic, { evidence: { verdict: 'agree' } }));
    const judgeTicket = state.tickets.at(-1);
    expect(judgeTicket.stage_id).toBe('plan-judge');
    expect(judgeTicket.parallel_group).toBe(null);

    recorded.push(...record(state, judgeTicket, { evidence: { verdict: 'agree' } }));
    const testTicket = state.tickets.at(-1);
    expect(testTicket.stage_id).toBe('test');
    expect(testTicket.role).toBe('test_writer');
    expect(state.status).toBe('running');
    expect(recorded.every((action) => action.retry_of === undefined)).toBe(true);
    expect(recorded.some((action) => action.type === 'archive_history')).toBe(false);
  });
});
