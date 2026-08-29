import { describe, expect, it } from 'vitest';
import { canonicalJson, sha256 } from '../lib/runtime/canonical.js';
import {
  receiptOutputSchemaForTicket,
  validateReceiptDraft,
} from '../lib/runtime/receipt-validator.js';

const HASH = 'a'.repeat(64);

function contractTicket(overrides = {}) {
  const objective = overrides.objective ?? 'Produce a complete exact contract artifact';
  const base = {
    ticket_id: 'run-contract:plan:ticket-1',
    run_id: 'run-contract',
    stage_id: 'plan',
    role: 'planner',
    objective,
    claimed_paths: ['src/value.js'],
    test_paths: ['tests/value.test.js'],
    required_checks: [],
    plan_contract_version: 2,
    receipt_contract_version: 1,
    ...overrides,
  };
  const outputSchema = receiptOutputSchemaForTicket(base);
  return {
    ...base,
    output_schema: outputSchema,
    capability_manifest: {
      version: 1,
      config_hash: 'c'.repeat(64),
      required_capabilities: [{ kind: 'verification_profile', id: 'unit' }],
      allowed_evidence_commands: ['npm test'],
      command_profiles: [],
      verification_profiles: [{
        id: 'unit',
        description: 'Run unit tests',
        command: 'npm test',
        root: '.',
        timeout_ms: 30_000,
        required: true,
      }],
      objective_hash: sha256(objective),
      preflight_hash: HASH,
      risk_triggers: [],
      design_assurance_required: false,
      receipt_schema: { ref: 'ticket.output_schema', hash: sha256(outputSchema) },
      field_bounds: {
        validation_attempts_per_worker: 3,
        max_physical_workers_per_ticket: 2,
        corrections_per_validation: 20,
      },
      byte_budgets: {
        candidate_plan_utf8_bytes: 16_384,
        preflight_artifact_utf8_bytes: 65_536,
        mcp_projection_utf8_bytes: 48_000,
      },
    },
  };
}

function candidatePlan(overrides = {}) {
  return {
    version: 2,
    preflight_hash: HASH,
    requirements: [{ id: 'R1', requirement: 'Change the value', workstreams: ['build'] }],
    workstreams: [{
      id: 'build',
      outcome: 'The value changes safely',
      paths: [{ path: 'src/value.js', action: 'modify' }],
      steps: ['Change the exported value'],
      acceptance: ['Callers observe the new value'],
      evidence_commands: ['npm test'],
      verification_profiles: ['unit'],
    }],
    risks: [{ risk: 'Compatibility drift', mitigation: 'Run the required profile' }],
    non_goals: ['Changing unrelated exports'],
    ...overrides,
  };
}

function draft(ticket, evidence, tests = []) {
  return {
    ticket_id: ticket.ticket_id,
    status: 'passed',
    tests,
    findings: [],
    evidence,
    receipt_capability: 'receipt-capability-secret-1234567890',
  };
}

describe('canonical receipt draft validator', () => {
  it('accepts a complete planner artifact and rejects hidden command/profile drift', () => {
    const ticket = contractTicket();
    const candidate = candidatePlan();
    expect(validateReceiptDraft(ticket, draft(ticket, { candidate_plan: candidate })))
      .toMatchObject({ valid: true, corrections: [] });

    const wrongCommand = structuredClone(candidate);
    wrongCommand.workstreams[0].evidence_commands = ['npm run secret'];
    const commandResult = validateReceiptDraft(ticket, draft(ticket, { candidate_plan: wrongCommand }));
    expect(commandResult.valid).toBe(false);
    expect(commandResult.corrections.map((entry) => entry.issue).join(' '))
      .toMatch(/allowed_evidence_commands|allowed command manifest/i);

    const missingProfile = structuredClone(candidate);
    missingProfile.workstreams[0].verification_profiles = [];
    const profileResult = validateReceiptDraft(ticket, draft(ticket, { candidate_plan: missingProfile }));
    expect(profileResult.valid).toBe(false);
    expect(profileResult.corrections.map((entry) => entry.issue).join(' '))
      .toMatch(/required.*profile|profile.*unit/i);
  });

  it('reports exact UTF-8 candidate-plan used/max/remaining bytes at the 16,384-byte boundary', () => {
    const ticket = contractTicket();
    const candidate = candidatePlan({
      non_goals: Array.from({ length: 40 }, (_, index) => `${index}-${'界'.repeat(180)}`),
    });
    const result = validateReceiptDraft(ticket, draft(ticket, { candidate_plan: candidate }));
    const used = Buffer.byteLength(canonicalJson(candidate), 'utf8');
    expect(used).toBeGreaterThan(16_384);
    expect(result.budgets.candidate_plan_utf8_bytes).toEqual({
      used_bytes: used,
      max_bytes: 16_384,
      remaining_bytes: 0,
    });
    expect(result.valid).toBe(false);
    expect(result.corrections.map((entry) => entry.issue).join(' ')).toMatch(/16384.*UTF-8 bytes/i);
  });

  it('publishes and enforces exact verdict enums by reviewer role', () => {
    const planChecker = contractTicket({
      ticket_id: 'run-contract:plan-check:ticket-1',
      stage_id: 'plan-check',
      role: 'plan_checker',
      plan_contract_version: undefined,
    });
    expect(planChecker.output_schema.properties.evidence.properties.verdict.enum)
      .toEqual(['agree', 'disagree']);
    expect(validateReceiptDraft(planChecker, draft(planChecker, { verdict: 'pass' })).valid)
      .toBe(false);

    const reviewer = contractTicket({
      ticket_id: 'run-contract:review:ticket-1',
      stage_id: 'review',
      role: 'reviewer',
      plan_contract_version: undefined,
    });
    expect(reviewer.output_schema.properties.evidence.properties.verdict.enum)
      .toEqual(['pass', 'fail']);
    expect(validateReceiptDraft(reviewer, draft(reviewer, { verdict: 'agree' })).valid)
      .toBe(false);
  });

  it('validates the complete preflight artifact against exact ticket evidence', () => {
    const objective = 'Inspect baseline behavior before planning';
    const ticket = contractTicket({
      ticket_id: 'run-contract:preflight:ticket-1',
      stage_id: 'preflight',
      role: 'preflight_analyst',
      objective,
      plan_contract_version: 2,
    });
    const artifact = {
      version: 1,
      objective,
      acceptance: ['The changed value remains compatible'],
      non_goals: [],
      baseline: [{ command: 'npm test', observation: 'Focused behavior is red', output_hash: HASH }],
      impacted_paths: { read: [], write: ['src/value.js', 'tests/value.test.js'] },
      compatibility: 'Keep the exported symbol stable.',
      rollback: 'Revert the focused value and assertion.',
      verification_profiles: [{ id: 'unit', disposition: 'required', reason: 'Behavior changes.' }],
      questions: [],
    };
    const tests = [{ command: 'npm test', passed: false, exit_code: 1, duration_ms: 10, output_hash: HASH }];
    expect(validateReceiptDraft(ticket, draft(ticket, { preflight_artifact: artifact }, tests)).valid)
      .toBe(true);

    const incomplete = structuredClone(artifact);
    delete incomplete.compatibility;
    const result = validateReceiptDraft(ticket, draft(ticket, { preflight_artifact: incomplete }, tests));
    expect(result.valid).toBe(false);
    expect(result.corrections.map((entry) => entry.issue).join(' ')).toMatch(/compatibility/i);
  });
});
