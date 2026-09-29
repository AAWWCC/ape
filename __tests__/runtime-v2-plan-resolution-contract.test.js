import { describe, expect, it } from 'vitest';
import { sha256 } from '../lib/runtime/canonical.js';
import { CandidatePlanSchema } from '../lib/runtime/plan-contract.js';
import { receiptDraftJsonSchemaForTicket, receiptDraftSchemaForTicket } from '../lib/runtime/receipt-draft-schema.js';
import { planRecoveryContextForState, validatePlanResolutionEvidence } from '../lib/runtime/recovery-progress.js';
import { finalizeTicket, validateTicket } from '../lib/runtime/schemas.js';
import { historicalExecutionPolicy } from './historical-execution-policy-helper.js';

const candidate = (repaired = false) => {
  const plan = { version: 2, preflight_hash: 'a'.repeat(64), requirements: [{ id: 'R1',
    requirement: 'Acknowledged work survives a restart', workstreams: ['queue'] }],
  workstreams: [{ id: 'queue', outcome: 'Persist queued work', paths: [{ path: 'src/queue.js', action: 'modify' }],
    steps: [repaired ? 'Write and fsync queue state before acknowledgment' : 'Acknowledge, then write queue state'],
    acceptance: [repaired ? 'Crash and restart at both write boundaries and recover acknowledged work' : 'The request returns success'],
    evidence_commands: ['node tests/queue.test.js'], verification_profiles: [] }],
  assurances: [], risks: [], non_goals: [] };
  return CandidatePlanSchema.parse({ plan_hash: sha256(plan), plan });
};
function ticket(version = 4, extra = {}) {
  return finalizeTicket({ schema_version: '2.0.0', ticket_id: 'plan-resolution:judge:1',
    run_id: 'plan-resolution', stage_id: 'plan-judge', role: 'plan_judge', parallel_group: null,
    objective: 'Preserve acknowledged work', claimed_paths: ['src/queue.js'], test_paths: [],
    model_tier: 'balanced', model: {}, deadline_at: version >= 3 ? null : '2026-09-26T15:00:00.000Z',
    output_schema: {}, required_checks: [], parent_hash: null, base_tree_sha: 'a'.repeat(40),
    attempt: 1, writable: false, issued_at: '2026-09-26T14:00:00.000Z',
    ...(version >= 2 ? { execution_limits: version === 4 ? { version: 4 } : historicalExecutionPolicy(version).limits } : {}),
    ...extra });
}
function recoveryTicket() {
  const prior = ticket(4, { candidate_plan: candidate() });
  const recovery = { version: 1, attempt: 1, source_ticket_id: prior.ticket_id, missing_assurances: [{
    id: 'pa-1111111111111111', source_stage: 'plan-judge', requirement_id: 'R1',
    evidence_anchor: 'queue.durability', summary: 'Acknowledgment is not durable',
  }] };
  return ticket(4, { ticket_id: 'plan-resolution:judge:2', candidate_plan: candidate(true),
    plan_recovery: recovery, plan_recovery_context: planRecoveryContextForState({ tickets: [prior], plan_recovery: recovery }) });
}
function draft(value) {
  return { ticket_id: value.ticket_id, status: 'passed', tests: [], findings: [], receipt_capability: 'x'.repeat(40),
    evidence: { verdict: 'disagree', missing_assurances: [{ requirement_id: 'R1',
      evidence_anchor: 'queue.deduplication', summary: 'Duplicate work still needs a rule' }],
    plan_resolutions: { version: 1, previous_plan_hash: value.plan_recovery_context.previous_candidate.plan_hash,
      candidate_plan_hash: value.candidate_plan.plan_hash, resolved: [{
        prior_assurance_id: value.plan_recovery.missing_assurances[0].id,
        implementation_anchors: [{ workstream_id: 'queue', field: 'steps', index: 0 }],
        acceptance_anchors: [{ workstream_id: 'queue', field: 'acceptance', index: 0 }],
        rationale: 'The corrected ordering and crash checks establish acknowledged durability',
      }] } } };
}

describe('immutable v4 independent plan resolutions', () => {
  it('publishes exact candidates and prior blocker membership only for a context-bearing judge', () => {
    const value = recoveryTicket();
    const schema = receiptDraftJsonSchemaForTicket(value);
    const proof = schema.properties.evidence.properties.plan_resolutions;
    expect(proof.properties.previous_plan_hash.const).toBe(value.plan_recovery_context.previous_candidate.plan_hash);
    expect(proof.properties.candidate_plan_hash.const).toBe(value.candidate_plan.plan_hash);
    expect(proof.properties.resolved.items.properties.prior_assurance_id.enum ??
      [proof.properties.resolved.items.properties.prior_assurance_id.const]).toEqual(['pa-1111111111111111']);
    expect(receiptDraftSchemaForTicket(value).safeParse(draft(value)).success).toBe(true);
    expect(validateTicket(JSON.parse(JSON.stringify(value)))).toEqual({ valid: true, value });
    expect(receiptDraftJsonSchemaForTicket(ticket()).properties.evidence.properties).not.toHaveProperty('plan_resolutions');
  });

  it.each(['wrong-current-hash', 'wrong-prior-hash', 'wrong-blocker', 'duplicate-resolution',
    'wrong-anchor-kind', 'missing-anchor', 'unrelated-anchor', 'incomplete-judgment', 'unchanged-coverage',
    'still-unresolved-after-normalization', 'still-unresolved-after-risk-tag'])(
    'rejects %s during ordinary receipt draft validation', (fault) => {
      let value = recoveryTicket();
      if (fault === 'unchanged-coverage') value = { ...value, candidate_plan: candidate() };
      const input = draft(value);
      const proof = input.evidence.plan_resolutions;
      if (fault === 'wrong-current-hash') proof.candidate_plan_hash = 'f'.repeat(64);
      if (fault === 'wrong-prior-hash') proof.previous_plan_hash = 'f'.repeat(64);
      if (fault === 'wrong-blocker') proof.resolved[0].prior_assurance_id = 'pa-2222222222222222';
      if (fault === 'duplicate-resolution') proof.resolved.push(structuredClone(proof.resolved[0]));
      if (fault === 'wrong-anchor-kind') proof.resolved[0].implementation_anchors[0].field = 'acceptance';
      if (fault === 'missing-anchor') proof.resolved[0].acceptance_anchors[0].index = 9;
      if (fault === 'unrelated-anchor') proof.resolved[0].implementation_anchors[0].workstream_id = 'foreign';
      if (fault === 'incomplete-judgment') { input.status = 'failed'; input.evidence.failure_kind = 'protocol'; }
      if (fault === 'still-unresolved-after-normalization') input.evidence.missing_assurances = [{
        requirement_id: 'R1', evidence_anchor: '\u200bqueue.durability', summary: 'The prior durability defect still exists',
      }];
      if (fault === 'still-unresolved-after-risk-tag') input.evidence.missing_assurances = [{
        requirement_id: 'R1', risk_trigger: 'concurrency', evidence_anchor: 'queue.durability',
        summary: 'The prior durability defect still exists with more metadata',
      }];
      expect(receiptDraftSchemaForTicket(value).safeParse(input).success).toBe(false);
      expect(validatePlanResolutionEvidence(value, input).length).toBeGreaterThan(0);
    });

  it('allows an acceptance-only repair while citing existing related implementation coverage', () => {
    const original = candidate();
    const updated = candidate();
    updated.plan.workstreams[0].acceptance = ['Crash and restart after acknowledgment; persisted work must survive'];
    updated.plan_hash = sha256(updated.plan);
    const value = { ...recoveryTicket(), candidate_plan: updated,
      plan_recovery_context: { ...recoveryTicket().plan_recovery_context, previous_candidate: original } };
    expect(receiptDraftSchemaForTicket(value).safeParse(draft(value)).success).toBe(true);
  });

  it('uses typed risk-assurance anchors for an independently resolved design repair', () => {
    const assurance = { id: 'durable', risk_trigger: 'concurrency', threat_model: 'Interrupted writes',
      feasibility: 'Write state asynchronously', failure_modes: ['Acknowledged state is lost'],
      crash_recovery: 'Restart the process', migration: 'Keep the queue format', determinism: 'Stable order',
      executable_tests: ['A write returns success'] };
    const prior = candidate(); prior.plan.assurances = [assurance]; prior.plan_hash = sha256(prior.plan);
    const current = structuredClone(prior);
    current.plan.assurances[0].crash_recovery = 'Replay the durable queue journal before acknowledging recovered work';
    current.plan.assurances[0].executable_tests = ['Crash at each journal boundary and verify exact recovery'];
    current.plan_hash = sha256(current.plan);
    const value = recoveryTicket();
    value.candidate_plan = CandidatePlanSchema.parse(current);
    value.plan_recovery_context.previous_candidate = CandidatePlanSchema.parse(prior);
    delete value.plan_recovery.missing_assurances[0].requirement_id;
    value.plan_recovery.missing_assurances[0].risk_trigger = 'concurrency';
    const input = draft(value);
    input.evidence.plan_resolutions.resolved[0].implementation_anchors = [{ assurance_id: 'durable', field: 'crash_recovery' }];
    input.evidence.plan_resolutions.resolved[0].acceptance_anchors = [{ assurance_id: 'durable', field: 'executable_tests', index: 0 }];
    expect(receiptDraftSchemaForTicket(value).safeParse(input).success).toBe(true);
  });

  it.each([1, 2, 3])('keeps historical v%s schema and ticket bytes unchanged and rejects new ticket context', (version) => {
    const value = ticket(version);
    const bytes = JSON.stringify(value);
    const schema = receiptDraftJsonSchemaForTicket(value);
    expect(schema.properties.evidence.properties).not.toHaveProperty('plan_resolutions');
    // Generated with the unchanged base-commit receipt-draft implementation.
    // Optional ticket context must not alter any historical published schema.
    expect(sha256(schema)).toBe('eed9c36795e6661cecce38c6dbe9016b3382a005e1e8debf7b5e63339c0c6189');
    expect(finalizeTicket(JSON.parse(bytes))).toEqual(value);
    expect(JSON.stringify(value)).toBe(bytes);
    expect(() => ticket(version, { plan_recovery_context: recoveryTicket().plan_recovery_context,
      plan_recovery: recoveryTicket().plan_recovery, candidate_plan: candidate() })).toThrow(/v4 plan judge/);
  });
});
