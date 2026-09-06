import { describe, expect, it } from 'vitest';
import { canonicalJson, sha256 } from '../lib/runtime/canonical.js';
import { GENERAL_INPUT_MAX_BYTES } from '../lib/runtime/input-guard.js';
import { receiptOutputSchemaForTicket, validateReceiptDraft } from '../lib/runtime/receipt-validator.js';
import { runContractByteBudgets, runContractFieldBounds } from '../lib/runtime/run-contract.js';

const HASH = 'a'.repeat(64);
const bytes = (value) => Buffer.byteLength(canonicalJson(value), 'utf8');
function ticketFor(claims = ['src/value.js'], maxBytes = GENERAL_INPUT_MAX_BYTES) {
  const ticket = { ticket_id: 'budget:plan:one', role: 'planner', stage_id: 'plan',
    objective: 'Implement the declared change', claimed_paths: claims, test_paths: [], required_checks: [],
    plan_contract_version: 2, receipt_contract_version: 1 };
  ticket.capability_manifest = { version: 1, config_hash: HASH, required_capabilities: [],
    allowed_evidence_commands: ['npm test'], command_profiles: [], verification_profiles: [],
    objective_hash: sha256(ticket.objective), preflight_hash: HASH, risk_triggers: [], design_assurance_required: false,
    field_bounds: runContractFieldBounds(), byte_budgets: { ...runContractByteBudgets(), candidate_plan_utf8_bytes: maxBytes } };
  ticket.output_schema = receiptOutputSchemaForTicket(ticket);
  ticket.capability_manifest.receipt_schema = { ref: 'ticket.output_schema', hash: sha256(ticket.output_schema) };
  return ticket;
}
function planFor() {
  return { version: 2, preflight_hash: HASH,
    requirements: [{ id: 'R1', requirement: 'Preserve the intended behavior', workstreams: ['W1'] }],
    workstreams: [{ id: 'W1', outcome: 'Behavior verified', paths: [{ path: 'src/value.js', action: 'modify' }],
      steps: ['Implement change'], acceptance: ['Tests pass'], evidence_commands: ['npm test'], verification_profiles: [] }],
    risks: [], non_goals: [] };
}
const draftFor = (ticket, plan) => ({ ticket_id: ticket.ticket_id, status: 'passed', tests: [], findings: [],
  evidence: { candidate_plan: plan }, receipt_capability: 'receipt-capability-for-budget-123456789' });

describe('planning uses the shared artifact resource envelope', () => {
  it('accepts complete plans beyond the former prose, count and 16 KiB limits', () => {
    const claims = Array.from({ length: 34 }, (_, i) => `src/value${i}.js`);
    const ticket = ticketFor(claims);
    const plan = planFor();
    plan.requirements = Array.from({ length: 33 }, (_, i) => ({ id: `R${i}`, requirement: `Behavior ${i}`, workstreams: ['W0'] }));
    plan.workstreams = Array.from({ length: 17 }, (_, i) => ({ ...planFor().workstreams[0], id: `W${i}`,
      paths: (i === 0 ? claims.slice(0, 18) : [claims[17 + i]]).map(path => ({ path, action: 'modify' })) }));
    plan.workstreams[0].outcome = 'x'.repeat(20_000);
    plan.workstreams[0].steps = Array.from({ length: 17 }, (_, i) => `Implementation step ${i}`);
    expect(bytes(plan)).toBeGreaterThan(16_384);
    expect(bytes(plan)).toBeLessThan(GENERAL_INPUT_MAX_BYTES);
    expect(validateReceiptDraft(ticket, draftFor(ticket, plan))).toMatchObject({ valid: true, corrections: [] });
  });

  it('accepts the complete artifact allowance and rejects the next UTF-8 byte', () => {
    const ticket = ticketFor();
    const plan = planFor();
    plan.workstreams[0].outcome = 'x';
    plan.workstreams[0].outcome += 'x'.repeat(GENERAL_INPUT_MAX_BYTES - bytes(plan));
    expect(bytes(plan)).toBe(GENERAL_INPUT_MAX_BYTES);
    expect(validateReceiptDraft(ticket, draftFor(ticket, plan))).toMatchObject({ valid: true,
      budgets: { candidate_plan_utf8_bytes: { used_bytes: GENERAL_INPUT_MAX_BYTES, max_bytes: GENERAL_INPUT_MAX_BYTES, remaining_bytes: 0 } } });
    plan.workstreams[0].outcome += 'x';
    expect(validateReceiptDraft(ticket, draftFor(ticket, plan)).valid).toBe(false);
  });

  it('keeps already-issued 16 KiB/500-character ticket contracts intact', () => {
    const ticket = ticketFor(['src/value.js'], 16_384);
    const snapshot = structuredClone(ticket);
    const plan = planFor();
    plan.workstreams[0].outcome = 'x'.repeat(501);
    expect(validateReceiptDraft(ticket, draftFor(ticket, plan)).valid).toBe(false);
    expect(ticket).toEqual(snapshot);
    expect(ticket.output_schema.properties.evidence.properties.candidate_plan['x-ape-utf8-maxBytes']).toBe(16_384);
  });

  it('retains path authority, exact commands and reference integrity within a larger plan', () => {
    const ticket = ticketFor();
    for (const mutate of [
      plan => { plan.workstreams[0].paths[0].path = 'outside/value.js'; },
      plan => { plan.workstreams[0].evidence_commands = ['npm run undeclared']; },
      plan => { plan.requirements[0].workstreams = ['unknown']; },
    ]) {
      const plan = planFor();
      plan.workstreams[0].outcome = 'x'.repeat(1000);
      mutate(plan);
      expect(validateReceiptDraft(ticket, draftFor(ticket, plan)).valid).toBe(false);
    }
  });

  it('preserves the historical command-field bound while new tickets use the catalog allowance', () => {
    const command = `npm run ${'x'.repeat(600)}`;
    for (const maxBytes of [16_384, GENERAL_INPUT_MAX_BYTES]) {
      const ticket = ticketFor(['src/value.js'], maxBytes);
      ticket.capability_manifest.allowed_evidence_commands = [command];
      ticket.capability_manifest.plannable_evidence_commands = [command];
      ticket.output_schema = receiptOutputSchemaForTicket(ticket);
      ticket.capability_manifest.receipt_schema.hash = sha256(ticket.output_schema);
      const plan = planFor();
      plan.workstreams[0].evidence_commands = [command];
      expect(validateReceiptDraft(ticket, draftFor(ticket, plan)).valid).toBe(maxBytes === GENERAL_INPUT_MAX_BYTES);
    }
  });

  it('allows preflight detail and questions within the same artifact envelope', () => {
    const ticket = ticketFor();
    ticket.role = 'preflight_analyst';
    ticket.stage_id = 'preflight';
    ticket.output_schema = receiptOutputSchemaForTicket(ticket);
    ticket.capability_manifest.receipt_schema.hash = sha256(ticket.output_schema);
    const artifact = { version: 1, objective: ticket.objective, acceptance: ['Observable behavior'], non_goals: [],
      baseline: [{ command: 'npm test', observation: 'Passing baseline' }], impacted_paths: { read: [], write: [] },
      compatibility: 'x'.repeat(5_000), rollback: 'Restore the previous implementation', verification_profiles: [],
      questions: Array.from({ length: 33 }, (_, i) => ({ id: `Q${i}`, question: `Required decision ${i}`, rationale: 'Affects correctness' })) };
    const draft = { ticket_id: ticket.ticket_id, status: 'passed',
      tests: [{ command: 'npm test', passed: true, exit_code: 0, duration_ms: 1 }], findings: [],
      evidence: { preflight_artifact: artifact }, receipt_capability: 'receipt-capability-for-budget-123456789' };
    expect(validateReceiptDraft(ticket, draft)).toMatchObject({ valid: true, corrections: [] });
    ticket.capability_manifest.byte_budgets.candidate_plan_utf8_bytes = 16_384;
    ticket.output_schema = receiptOutputSchemaForTicket(ticket);
    ticket.capability_manifest.receipt_schema.hash = sha256(ticket.output_schema);
    expect(validateReceiptDraft(ticket, draft).valid).toBe(false);
  });
});
