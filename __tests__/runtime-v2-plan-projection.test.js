import { describe, expect, it } from 'vitest';
import { sha256 } from '../lib/runtime/canonical.js';
import { projectRunResponse, RESPONSE_BUDGET_CHARS, RUN_OBJECTIVE_REFERENCE } from '../lib/runtime/projection.js';

function plan(fill = '') {
  return {
    version: 1,
    requirements: [{ id: 'R1', requirement: 'Keep one canonical wire plan', workstreams: ['wire'] }],
    workstreams: [{
      id: 'wire',
      outcome: 'Duplicate envelopes become resolvable references',
      paths: [{ path: 'src/value.js', action: 'modify' }],
      steps: fill ? Array(16).fill(fill) : ['Project without mutating persistence'],
      acceptance: ['Exactly one full plan crosses the response'],
      evidence_commands: ['node --test'],
    }],
    risks: [],
    non_goals: [],
  };
}

function ticket(ticketId, objective, fields = {}) {
  return {
    ticket_id: ticketId,
    stage_id: ticketId.includes('critic') ? 'plan-critic' : 'plan-check',
    role: ticketId.includes('critic') ? 'plan_critic' : 'plan_checker',
    attempt: 1,
    ticket_hash: 'a'.repeat(64),
    issued_at: '2026-08-11T00:00:00.000Z',
    objective,
    output_schema: { type: 'object' },
    ...fields,
  };
}

function dispatch(ticketValue) {
  return { type: 'dispatch_agent', ticket: ticketValue, dispatch: { ticket: ticketValue } };
}

function occurrences(value, hash) {
  let full = 0;
  const references = [];
  const visit = (current) => {
    if (current === null || typeof current !== 'object') return;
    if (current.plan_hash === hash) {
      if (current.plan && typeof current.plan === 'object') full += 1;
      if (typeof current.plan_ref === 'string') references.push(current);
    }
    for (const child of Object.values(current)) visit(child);
  };
  visit(value);
  return { full, references };
}

describe('APE v2 structured-plan wire projection', () => {
  it('keeps one candidate plan under budget and makes every duplicate round-trip through its ticket', () => {
    const objective = 'Review the structured plan';
    const value = plan();
    const candidate = { plan_hash: sha256(value), plan: value };
    const checker = ticket('run-1:plan-check:checker', objective, { candidate_plan: candidate });
    const critic = ticket('run-1:plan-critic:critic', objective, { candidate_plan: candidate });
    const response = {
      ok: true,
      run: { run_id: 'run-1', objective, tickets: [checker, critic], receipts: [] },
      actions: [dispatch(checker), dispatch(critic)],
    };

    const projected = projectRunResponse(response);
    const found = occurrences(projected, candidate.plan_hash);
    expect(JSON.stringify(projected).length).toBeLessThan(RESPONSE_BUDGET_CHARS);
    expect(found.full).toBe(1);
    expect(found.references).toHaveLength(3);
    for (const reference of found.references) {
      const persisted = response.run.tickets.find((entry) => entry.ticket_id === reference.ticket_id);
      expect(persisted?.candidate_plan).toEqual(candidate);
      expect(reference.plan_ref).toContain('.ape/runtime/tickets/');
    }
    expect(response.run.tickets.every((entry) => entry.candidate_plan === candidate)).toBe(true);
  });

  it('dedupes an over-budget candidate without truncating it, then applies ordinary objective compaction', () => {
    const objective = `Review a large plan. ${'o'.repeat(25_000)}`;
    const value = plan('x'.repeat(500));
    const candidate = { plan_hash: sha256(value), plan: value };
    const checker = ticket('run-2:plan-check:checker', objective, { candidate_plan: candidate });
    const critic = ticket('run-2:plan-critic:critic', objective, { candidate_plan: candidate });
    const response = {
      ok: true,
      run: { run_id: 'run-2', objective, tickets: [checker, critic], receipts: [] },
      actions: [dispatch(checker), dispatch(critic)],
    };
    expect(JSON.stringify(response).length).toBeGreaterThan(RESPONSE_BUDGET_CHARS);

    const projected = projectRunResponse(response);
    const found = occurrences(projected, candidate.plan_hash);
    expect(found.full).toBe(1);
    expect(found.references).toHaveLength(3);
    expect(found.references.every((reference) => reference.plan_hash === candidate.plan_hash)).toBe(true);
    expect(projected.run.tickets[0].candidate_plan.plan).toEqual(value);
    expect(projected.actions.every((action) => action.ticket.objective === RUN_OBJECTIVE_REFERENCE)).toBe(true);
    expect(JSON.stringify(projected).length).toBeLessThan(RESPONSE_BUDGET_CHARS);
  });

  it('keeps approved_plan once at run level and references it from every downstream copy', () => {
    const objective = 'Execute the approved plan';
    const value = plan();
    const approved = {
      version: 1,
      plan_hash: sha256(value),
      approval_route: 'unanimous',
      reviewer_receipt_hashes: ['b'.repeat(64), 'c'.repeat(64)],
      plan: value,
    };
    const downstream = ticket('run-3:test:test', objective, {
      stage_id: 'test',
      role: 'test_writer',
      approved_plan: approved,
    });
    const response = {
      ok: true,
      run: {
        run_id: 'run-3',
        objective,
        approved_plan: approved,
        tickets: [downstream],
        receipts: [],
      },
      actions: [dispatch(downstream)],
    };

    const projected = projectRunResponse(response);
    const found = occurrences(projected, approved.plan_hash);
    expect(found.full).toBe(1);
    expect(projected.run.approved_plan).toEqual(approved);
    expect(found.references).toHaveLength(2);
    expect(found.references.every((reference) =>
      reference.ticket_id === downstream.ticket_id && reference.plan_ref === 'run.approved_plan'))
      .toBe(true);
    expect(response.run.tickets[0].approved_plan).toBe(approved);
  });

  it('uses run.approved_plan as canonical when retained candidate tickets carry the same plan hash', () => {
    const objective = 'Project a post-approval history-shaped state';
    const value = plan();
    const hash = sha256(value);
    const candidate = { plan_hash: hash, plan: value };
    const approved = {
      version: 1,
      plan_hash: hash,
      approval_route: 'judge',
      reviewer_receipt_hashes: ['b'.repeat(64), 'c'.repeat(64), 'd'.repeat(64)],
      plan: value,
    };
    const oldReviewer = ticket('run-4:plan-check:checker', objective, { candidate_plan: candidate });
    const downstream = ticket('run-4:test:test', objective, {
      stage_id: 'test',
      role: 'test_writer',
      approved_plan: approved,
    });
    const response = {
      ok: true,
      run: {
        run_id: 'run-4',
        objective,
        approved_plan: approved,
        tickets: [oldReviewer, downstream],
        receipts: [],
      },
      actions: [dispatch(downstream)],
    };

    const projected = projectRunResponse(response);
    const found = occurrences(projected, hash);
    expect(found.full).toBe(1);
    expect(projected.run.approved_plan).toEqual(approved);
    expect(projected.run.tickets[0].candidate_plan).toMatchObject({
      plan_hash: hash,
      ticket_id: oldReviewer.ticket_id,
      plan_ref: 'run.approved_plan',
    });
    expect(projected.run.tickets[0].candidate_plan).not.toHaveProperty('plan');
    const approvedReference = projected.run.tickets[1].approved_plan;
    expect(approvedReference).toMatchObject({
      version: 1,
      plan_hash: hash,
      approval_route: 'judge',
      reviewer_receipt_hashes: approved.reviewer_receipt_hashes,
      plan_ref: 'run.approved_plan',
    });
    expect(approvedReference).not.toHaveProperty('plan');
  });
});
