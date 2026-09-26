import { describe, expect, it } from 'vitest';
import { GENERAL_INPUT_MAX_BYTES } from '../lib/runtime/input-guard.js';
import { reduceRun } from '../lib/runtime/reducer.js';
import { reviewFindings } from '../lib/runtime/review-evidence.js';

function run(overrides = {}) {
  return {
    run_id: 'progress-recovery', mode: 'phase', lane: 'fast', status: 'running',
    stage: 'dispatch', high_risk: false, tickets: [], receipts: [], attempts: {},
    remediation_cycles: 0, plan_replan_cycles: 0,
    execution_policy: { version: 2, limits: { version: 2 } },
    ...overrides,
  };
}

function issue(state, stage) {
  const ticket = {
    ticket_id: `ticket-${state.tickets.length + 1}`,
    stage_id: stage.id,
    role: stage.role,
    parallel_group: stage.parallel_group ?? null,
    capability_manifest: { byte_budgets: { candidate_plan_utf8_bytes: GENERAL_INPUT_MAX_BYTES } },
  };
  state.tickets.push(ticket);
  state.stage = stage.id;
  return ticket;
}

// Apply ordered reducer effects as the service does, allowing the next review
// or judge to compare with the prior cycle's persisted evidence.
function record(state, ticket, overrides = {}) {
  const receipt = {
    ticket_id: ticket.ticket_id, status: 'passed', evidence: { verdict: 'agree' },
    ...overrides,
  };
  state.receipts.push(receipt);
  const actions = reduceRun(state, {
    type: 'RECEIPT_RECORDED', ticket, receipt, next_state: state,
    stage: { id: ticket.stage_id, role: ticket.role, parallel_group: ticket.parallel_group },
  });
  for (const action of actions) {
    if (action.type === 'transition') Object.assign(state, action.patch);
    if (action.type === 'issue_ticket') issue(state, action.stage);
  }
  return actions;
}

function blocker(index) {
  return {
    file: `src/value-${index}.js`, line: 1, title: `Defect ${index}`,
    detail: `Correct defect ${index}`, blocking: true, remediation: { owner: 'production' },
  };
}

function assurance(index) {
  return { summary: `Prove requirement ${index}`, requirement_id: `R${index}` };
}

function review(state) {
  return issue(state, { id: 'review', role: 'reviewer', parallel_group: 'code-review' });
}

function judge(state) {
  return issue(state, { id: 'plan-judge', role: 'plan_judge' });
}

function finishReplan(state) {
  expect(state.tickets.at(-1).stage_id).toBe('plan-replan');
  record(state, state.tickets.at(-1));
  const [check, critic] = state.tickets.slice(-2);
  expect([check.stage_id, critic.stage_id]).toEqual(['plan-check', 'plan-critic']);
  record(state, check);
  record(state, critic, { evidence: { verdict: 'disagree' } });
  expect(state.tickets.at(-1).stage_id).toBe('plan-judge');
  return state.tickets.at(-1);
}

function expectTerminalBlock(state, actions) {
  expect(state.status).toBe('blocked');
  expect(actions.some((action) => action.type === 'issue_ticket')).toBe(false);
  expect(actions.map((action) => action.type)).toEqual([
    'transition', 'archive_history', 'release_lock', 'persist_state',
  ]);
}

describe('progress-based product recovery', () => {
  it('finishes seven strictly shrinking remediation cycles and forwards every remaining finding', () => {
    const state = run();
    let pendingReview = review(state);
    const findings = Array.from({ length: 7 }, (_, index) => blocker(index));
    for (let cycle = 1; cycle <= findings.length; cycle += 1) {
      const remaining = findings.slice(cycle - 1);
      const actions = record(state, pendingReview, {
        evidence: { verdict: 'disagree' }, findings: remaining,
      });
      expect(state).toMatchObject({ status: 'running', remediation_cycles: cycle });
      const recovery = actions.find((action) => action.type === 'issue_ticket');
      expect(recovery).toMatchObject({
        recovery_kind: 'remediate_product_finding', stage: { id: 'remediation-build' },
      });
      expect(recovery.review_findings).toHaveLength(remaining.length);
      for (const finding of remaining) {
        expect(recovery.review_findings).toContain(`${pendingReview.stage_id}: ${finding.file}:1 — ${finding.title} — ${finding.detail}`);
      }
      expect(recovery.review_finding_evidence.map((entry) => entry.evidence_anchor))
        .toEqual(remaining.map((finding) => `${finding.file}:L1`));
      expect(state.remediation_finding_evidence).toEqual(recovery.review_finding_evidence);
      record(state, state.tickets.at(-1));
      pendingReview = state.tickets.at(-1);
      expect(pendingReview.stage_id).toBe('remediation-review');
    }
    const actions = record(state, pendingReview);
    expect(actions.some((action) => action.type === 'run_gates')).toBe(true);
    expect(state.orchestration.remediation_cycles).toBe(7);
    expect(state.status).toBe('running');
  });

  it('finishes seven strictly shrinking directed replans with complete modern assurance feedback', () => {
    const state = run({ lane: 'full' });
    let pendingJudge = judge(state);
    const assurances = Array.from({ length: 25 }, (_, index) => ({
      ...assurance(index), summary: `Prove requirement ${index}: ${'x'.repeat(650)}`,
    }));
    for (let cycle = 1; cycle <= 7; cycle += 1) {
      const remaining = assurances.slice(cycle - 1);
      const actions = record(state, pendingJudge, {
        evidence: { verdict: 'disagree', missing_assurances: remaining },
      });
      expect(state).toMatchObject({ status: 'running', plan_replan_cycles: cycle });
      const recovery = actions.find((action) => action.type === 'issue_ticket');
      expect(recovery).toMatchObject({
        recovery_kind: 'directed_replan', stage: { id: 'plan-replan' },
        plan_recovery: { attempt: cycle },
      });
      expect(recovery.plan_recovery.missing_assurances.map(({ summary, requirement_id }) => ({ summary, requirement_id })))
        .toEqual(remaining);
      expect(state.plan_recovery).toEqual(recovery.plan_recovery);
      pendingJudge = finishReplan(state);
    }
    const actions = record(state, pendingJudge);
    expect(actions).toContainEqual(expect.objectContaining({ type: 'issue_ticket', stage: expect.objectContaining({ id: 'test' }) }));
    expect(state.orchestration.directed_replans).toBe(7);
  });

  it.each([
    ['repeated', (prior) => [...prior].reverse()],
    ['expanded', (prior) => [...prior, blocker(3)]],
    ['incomparable', () => [blocker(3)]],
    ['empty', () => []],
    ['unstructured', () => [{ blocking: true }]],
  ])('blocks %s findings after the former remediation ceiling', (_label, nextFor) => {
    const findings = [blocker(1), blocker(2)];
    const state = run({ remediation_cycles: 5, remediation_finding_fingerprints: reviewFindings.fingerprints([
      { status: 'passed', evidence: { verdict: 'disagree' }, findings },
    ]) });
    const actions = record(state, review(state), {
      evidence: { verdict: 'disagree' }, findings: nextFor(findings),
    });
    expectTerminalBlock(state, actions);
    expect(state.remediation_cycles).toBe(5);
    expect(state.block_reason).toMatch(/progress|comparable/);
    expect(state.block_reason).not.toMatch(/budget/);
  });

  it.each([
    ['repeated', (prior) => [...prior].reverse()],
    ['expanded', (prior) => [...prior, assurance(3)]],
    ['incomparable', () => [assurance(3)]],
    ['empty', () => []],
    ['malformed', () => [{}]],
    ['partly malformed', (prior) => [prior[0], null]],
  ])('blocks %s assurances after the former directed-replan ceiling', (_label, nextFor) => {
    const prior = [assurance(1), assurance(2)];
    const state = run({ lane: 'full', plan_replan_cycles: 5, plan_recovery: { missing_assurances: prior } });
    const actions = record(state, judge(state), {
      evidence: { verdict: 'disagree', missing_assurances: nextFor(prior) },
    });
    expectTerminalBlock(state, actions);
    expect(state.blocked_recovery).toMatchObject({
      reason_code: 'plan_progress_not_strict_subset', directed_replan_attempts: 5,
    });
    expect(state.plan_replan_cycles).toBe(5);
  });

  it.each([
    ['unversioned', undefined],
    ['v1', { version: 1, limits: {} }],
  ])('retains both frozen numeric ceilings on %s runs', (_label, executionPolicy) => {
    const findings = [blocker(1), blocker(2)];
    const remediation = run({ execution_policy: executionPolicy, remediation_cycles: 3,
      remediation_finding_fingerprints: reviewFindings.fingerprints([
        { status: 'passed', evidence: { verdict: 'disagree' }, findings },
      ]) });
    expectTerminalBlock(remediation, record(remediation, review(remediation), {
      evidence: { verdict: 'disagree' }, findings: findings.slice(1),
    }));
    expect(remediation.block_reason).toMatch(/configured remediation budget \(3 cycles\)/);
    const planning = run({ execution_policy: executionPolicy, lane: 'full', plan_replan_cycles: 2,
      plan_recovery: { missing_assurances: [assurance(1), assurance(2)] } });
    expectTerminalBlock(planning, record(planning, judge(planning), {
      evidence: { verdict: 'disagree', missing_assurances: [assurance(2)] },
    }));
    expect(planning.blocked_recovery.reason_code).toBe('plan_replan_ceiling_exhausted');
  });

  it.each(['remediation', 'planning'])('preserves exact %s counters at the safe integer boundary', (kind) => {
    const findings = [blocker(1), blocker(2)];
    const state = run({ lane: 'full', remediation_cycles: Number.MAX_SAFE_INTEGER - 1,
      plan_replan_cycles: Number.MAX_SAFE_INTEGER - 1,
      plan_recovery: { missing_assurances: [assurance(1), assurance(2)] },
      remediation_finding_fingerprints: reviewFindings.fingerprints([
        { status: 'passed', evidence: { verdict: 'disagree' }, findings },
      ]) });
    const recordProgress = () => kind === 'remediation'
      ? record(state, review(state), { evidence: { verdict: 'disagree' }, findings: findings.slice(1) })
      : record(state, judge(state), { evidence: { verdict: 'disagree', missing_assurances: [assurance(2)] } });
    const counter = kind === 'remediation' ? 'remediation_cycles' : 'plan_replan_cycles';
    const continued = recordProgress();
    expect(continued.some((action) => action.type === 'issue_ticket')).toBe(true);
    expect(state[counter]).toBe(Number.MAX_SAFE_INTEGER);
    if (kind === 'planning') expect(state.plan_recovery.attempt).toBe(Number.MAX_SAFE_INTEGER);
    expectTerminalBlock(state, recordProgress());
    expect(state[counter]).toBe(Number.MAX_SAFE_INTEGER);
    expect(state.block_reason).toMatch(/safe integer arithmetic/);
  });

  it.each([
    ['stage attempt', { attempts: { build: 2 } }, {}],
    ['worker protocol redispatch', { worker_protocol_redispatches: { build: 1 } }, { failure_kind: 'protocol' }],
  ])('retains the finite %s limit under progress-based policy', (_label, overrides, evidence) => {
    const state = run(overrides);
    const actions = record(state, issue(state, { id: 'build', role: 'implementer' }), {
      status: 'failed', evidence,
    });
    expectTerminalBlock(state, actions);
    expect(state.remediation_cycles).toBe(0);
    expect(state.plan_replan_cycles).toBe(0);
  });
});
