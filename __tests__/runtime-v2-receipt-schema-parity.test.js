import { describe, expect, it } from 'vitest';
import { canonicalJson, sha256 } from '../lib/runtime/canonical.js';
import { PLAN_CONTRACT_MAX_BYTES } from '../lib/runtime/plan-contract.js';
import {
  receiptDraftJsonSchemaForTicket,
  receiptDraftSchemaForTicket,
} from '../lib/runtime/receipt-draft-schema.js';
import {
  receiptOutputSchemaForTicket,
  validateReceiptDraft,
} from '../lib/runtime/receipt-validator.js';
import { RECEIPT_INPUT_SCHEMA } from '../lib/runtime/receipt-input.js';
import { initialStages } from '../lib/runtime/pipeline.js';
import {
  RECEIPT_FAILURE_KINDS,
  receiptFailureDomain,
  workerFailureDomain,
} from '../lib/runtime/orchestration-telemetry.js';

const CAPABILITY = 'a'.repeat(32);

function contractTicket(overrides = {}) {
  const manifestBase = {
    allowed_evidence_commands: ['npm test'],
    verification_profiles: [],
    risk_triggers: [],
    design_assurance_required: false,
  };
  const base = {
    ticket_id: 'run-schema:build:ticket-1',
    stage_id: 'build',
    role: 'implementer',
    objective: 'Exercise one generated receipt contract',
    claimed_paths: ['src/x.js'],
    test_paths: [],
    required_checks: [],
    receipt_contract_version: 1,
    capability_manifest: manifestBase,
    ...overrides,
  };
  const outputSchema = receiptOutputSchemaForTicket(base);
  return {
    ...base,
    output_schema: outputSchema,
    capability_manifest: {
      ...manifestBase,
      version: 1,
      objective_hash: sha256(base.objective),
      receipt_schema: { ref: 'ticket.output_schema', hash: sha256(outputSchema) },
    },
  };
}

function validDraft(ticket, overrides = {}) {
  return {
    ticket_id: ticket.ticket_id,
    status: 'passed',
    tests: [],
    findings: [],
    evidence: { summary: 'complete' },
    receipt_capability: CAPABILITY,
    ...overrides,
  };
}

function planAtUtf8Bytes(target) {
  const filled = () => Array.from({ length: 16 }, () => 'x');
  const plan = {
    version: 1,
    requirements: [{ id: 'requirement', requirement: 'required behavior', workstreams: ['work'] }],
    workstreams: [{
      id: 'work',
      outcome: 'implement behavior',
      paths: [{ path: 'src/x.js', action: 'modify' }],
      steps: filled(),
      acceptance: filled(),
      evidence_commands: ['npm test'],
    }],
    risks: [],
    non_goals: filled(),
  };
  let bytes = Buffer.byteLength(canonicalJson(plan), 'utf8');
  for (const values of [plan.workstreams[0].steps, plan.workstreams[0].acceptance, plan.non_goals]) {
    for (let index = 0; index < values.length && bytes < target; index += 1) {
      while (values[index].length < 500 && bytes < target) {
        values[index] += target - bytes === 1 ? 'x' : 'é';
        bytes = Buffer.byteLength(canonicalJson(plan), 'utf8');
      }
    }
  }
  if (bytes !== target) throw new Error(`could not construct ${target}-byte plan (got ${bytes})`);
  return plan;
}

describe('new-run receipt schema parity', () => {
  it('keeps the byte-for-byte legacy schema and legacy stage identity unchanged', () => {
    const before = canonicalJson(RECEIPT_INPUT_SCHEMA);
    expect(initialStages({ mode: 'phase', lane: 'fast' })[0].output_schema)
      .toBe(RECEIPT_INPUT_SCHEMA);
    expect(canonicalJson(RECEIPT_INPUT_SCHEMA)).toBe(before);
  });

  it('generates the worker schema from the same Zod that validates the draft', () => {
    const ticket = contractTicket();
    const schema = receiptDraftJsonSchemaForTicket(ticket);
    expect(schema).toEqual(ticket.output_schema);
    expect(schema).not.toBe(RECEIPT_INPUT_SCHEMA);
    expect(schema.additionalProperties).toBe(false);
    expect(schema.required).toContain('receipt_capability');
    expect(schema.properties.ticket_id.const).toBe(ticket.ticket_id);
    expect(schema.properties.tests.maxItems).toBe(256);
    expect(schema.properties.tests.items.properties.command.enum).toEqual(['npm test']);
    expect(schema.properties.findings.maxItems).toBe(64);
    const capabilityConditional = schema.allOf.find((entry) => entry.else);
    expect(capabilityConditional.then.properties.evidence.required).toEqual(['required_claims']);
    expect(capabilityConditional.else.properties.evidence.not.required).toEqual(['required_claims']);
  });

  it.each([
    ['unknown test key', (ticket) => validDraft(ticket, {
      tests: [{ command: 'npm test', passed: true, exit_code: 0, duration_ms: 1, extra: true }],
    }), /Unrecognized key/u],
    ['missing capability claims', (ticket) => validDraft(ticket, {
      status: 'failed', evidence: { failure_kind: 'capability' },
    }), /required on a failed capability receipt/u],
    ['malformed roadmap follow-up', (ticket) => validDraft(ticket, {
      evidence: { roadmap_followups: [{ id: 'follow-up' }] },
    }), /expected string/u],
    ['unrecognized command', (ticket) => validDraft(ticket, {
      tests: [{ command: 'npm run imaginary', passed: true, exit_code: 0, duration_ms: 1 }],
    }), /Invalid option|exact member/u],
  ])('rejects %s in both the authoritative Zod and canonical validator', (_name, mutate, message) => {
    const ticket = contractTicket();
    const draft = mutate(ticket);
    expect(receiptDraftSchemaForTicket(ticket).safeParse(draft).success).toBe(false);
    const validation = validateReceiptDraft(ticket, draft);
    expect(validation.valid).toBe(false);
    expect(validation.corrections.map((entry) => entry.issue).join(' ')).toMatch(message);
  });

  it('requires structured-review finding IDs for new tickets without changing legacy receipt parsing', () => {
    const ticket = contractTicket({
      ticket_id: 'run-schema:review:ticket-1',
      stage_id: 'review',
      role: 'reviewer',
      review_contract_version: 1,
    });
    const draft = validDraft(ticket, {
      evidence: { verdict: 'pass' },
      findings: [{
        file: 'src/x.js', line: 1, title: 'checked', detail: 'no defect', blocking: false,
      }],
    });
    expect(ticket.output_schema.properties.findings.items.required).toContain('id');
    expect(ticket.output_schema.properties.findings.items.properties.detail.maxLength).toBe(4_000);
    expect(validateReceiptDraft(ticket, draft)).toMatchObject({ valid: false });
  });

  it.each([
    ['command-shape', 'orchestration'],
    ['contract', 'orchestration'],
    ['receipt-contract', 'orchestration'],
    ['protocol', 'orchestration'],
    ['host-transport', 'infrastructure'],
    ['infrastructure', 'infrastructure'],
    ['transport', 'infrastructure'],
  ])('admits failed %s receipts for non-voting %s routing', (failureKind, domain) => {
    const ticket = contractTicket();
    const draft = validDraft(ticket, {
      status: 'failed',
      evidence: { failure_kind: failureKind },
    });
    expect(RECEIPT_FAILURE_KINDS).toContain(failureKind);
    expect(validateReceiptDraft(ticket, draft).valid).toBe(true);
    expect(receiptFailureDomain(draft)).toBe(domain);
    expect(workerFailureDomain(draft, { reviewGroup: true })).toBe(domain);
  });

  it('makes failed new-contract reviews explicit non-product failures, never implicit dissent', () => {
    const ticket = contractTicket({
      ticket_id: 'run-schema:review:failure-ticket',
      stage_id: 'review',
      role: 'reviewer',
      review_contract_version: 1,
    });
    const implicit = validDraft(ticket, { status: 'failed', evidence: {} });
    expect(validateReceiptDraft(ticket, implicit).corrections)
      .toContainEqual(expect.objectContaining({ field: 'evidence.failure_kind' }));

    const infrastructure = validDraft(ticket, {
      status: 'failed',
      evidence: { failure_kind: 'infrastructure' },
    });
    expect(validateReceiptDraft(ticket, infrastructure).valid).toBe(true);
    expect(workerFailureDomain(infrastructure, { reviewGroup: true })).toBe('infrastructure');

    const passedWithFailure = validDraft(ticket, {
      evidence: { verdict: 'pass', failure_kind: 'protocol' },
    });
    expect(validateReceiptDraft(ticket, passedWithFailure).valid).toBe(false);
  });

  it('publishes and validates the immutable ticket plan version exactly', () => {
    const ticket = contractTicket({
      ticket_id: 'run-schema:plan:ticket-1',
      stage_id: 'plan',
      role: 'planner',
      plan_contract_version: 1,
    });
    expect(ticket.output_schema.properties.evidence.properties.candidate_plan.properties.version)
      .toEqual({ type: 'number', const: 1 });
    const wrong = planAtUtf8Bytes(16_383);
    wrong.version = 2;
    expect(validateReceiptDraft(ticket, validDraft(ticket, {
      evidence: { candidate_plan: wrong },
    })).valid).toBe(false);
  });

  it('specializes planner and preflight nested enums from the immutable manifest', () => {
    const planner = contractTicket({
      ticket_id: 'run-schema:plan:ticket-specialized',
      stage_id: 'plan',
      role: 'planner',
      plan_contract_version: 2,
      capability_manifest: {
        allowed_evidence_commands: ['npm test', 'npm run typecheck'],
        verification_profiles: [{ id: 'unit', required: true }, { id: 'types' }],
        preflight_hash: 'b'.repeat(64),
        risk_triggers: [],
        design_assurance_required: false,
      },
    });
    const workstream = planner.output_schema.properties.evidence.properties
      .candidate_plan.properties.workstreams.items.properties;
    expect(workstream.evidence_commands.items.enum)
      .toEqual(['npm test', 'npm run typecheck']);
    expect(workstream.verification_profiles.items.enum).toEqual(['unit', 'types']);

    const preflight = contractTicket({
      ticket_id: 'run-schema:preflight:ticket-specialized',
      stage_id: 'preflight',
      role: 'preflight_analyst',
      objective: 'Inspect this exact objective',
      plan_contract_version: 2,
      capability_manifest: {
        allowed_evidence_commands: ['npm test'],
        verification_profiles: [{ id: 'unit' }],
        risk_triggers: [],
        design_assurance_required: false,
      },
    });
    const artifact = preflight.output_schema.properties.evidence.properties.preflight_artifact;
    expect(artifact.properties.objective.const).toBe('Inspect this exact objective');
    expect(artifact.properties.baseline.items.properties.command.enum).toEqual(['npm test']);
    expect(artifact.properties.verification_profiles.items.properties.id.enum).toEqual(['unit']);
  });

  it('publishes only role-relevant recovery fields and catches record-only declaration failures', () => {
    const implementer = contractTicket();
    const properties = implementer.output_schema.properties.evidence.properties;
    expect(properties).toHaveProperty('required_claims');
    expect(properties).toHaveProperty('test_contradiction');
    expect(properties).not.toHaveProperty('missing_assurances');
    expect(properties).not.toHaveProperty('scope_expansion');
    const claimsSchema = properties.required_claims;
    expect(claimsSchema['x-ape-ticket-specialized-additive-claims']).toBe(true);
    expect(claimsSchema.properties.claimed_paths.uniqueItems).toBe(true);
    expect(claimsSchema.properties.claimed_paths.items.allOf)
      .toEqual(expect.arrayContaining([
        { not: { pattern: '^src/x\\.js(?:/|$)' } },
      ]));
    expect(claimsSchema.properties.required_role.enum).not.toContain('implementer');

    const nonAdditive = validDraft(implementer, {
      status: 'failed',
      evidence: {
        failure_kind: 'capability',
        required_claims: { claimed_paths: ['src/x.js'] },
      },
    });
    const nonAdditiveResult = validateReceiptDraft(implementer, nonAdditive);
    expect(nonAdditiveResult.valid).toBe(false);
    expect(nonAdditiveResult.corrections.map((entry) => entry.issue).join(' '))
      .toMatch(/already on the immutable ticket|genuinely additive/u);
    expect(receiptDraftSchemaForTicket(implementer).safeParse(nonAdditive).success)
      .toBe(false);

    const additive = validDraft(implementer, {
      status: 'failed',
      evidence: {
        failure_kind: 'capability',
        required_claims: { claimed_paths: ['src/helper.js'] },
      },
    });
    expect(receiptDraftSchemaForTicket(implementer).safeParse(additive).success).toBe(true);
    expect(validateReceiptDraft(implementer, additive).valid).toBe(true);

    const reviewer = contractTicket({
      ticket_id: 'run-schema:review:scope-ticket',
      stage_id: 'review',
      role: 'reviewer',
      review_contract_version: 1,
    });
    expect(reviewer.output_schema.properties.evidence.properties).toHaveProperty('scope_expansion');
    expect(reviewer.output_schema.properties.evidence.properties).not.toHaveProperty('test_contradiction');
    const agreeingGrowth = validDraft(reviewer, {
      evidence: {
        verdict: 'pass',
        scope_expansion: { claimed_paths: ['src/helper.js'], reason: 'Needed later' },
      },
    });
    expect(validateReceiptDraft(reviewer, agreeingGrowth).corrections)
      .toEqual(expect.arrayContaining([
        expect.objectContaining({ issue: expect.stringMatching(/blocking review verdict/u) }),
      ]));
  });

  it('binds test contradictions to failed implementers and exact immutable test paths', () => {
    const ticket = contractTicket({
      ticket_id: 'run-schema:build:test-contradiction-ticket',
      test_paths: ['tests/x.test.js', 'checks/contract.js'],
    });
    const contradiction = ticket.output_schema.properties.evidence.properties.test_contradiction;
    expect(contradiction.properties.test_paths.items.enum)
      .toEqual(['tests/x.test.js', 'checks/contract.js']);
    expect(contradiction.properties.test_paths.items['x-ape-enum-ref'])
      .toBe('ticket.test_paths');
    expect(ticket.output_schema.allOf).toEqual(expect.arrayContaining([
      expect.objectContaining({
        if: {
          properties: { evidence: { required: ['test_contradiction'] } },
          required: ['evidence'],
        },
        then: expect.objectContaining({
          properties: expect.objectContaining({
            status: { const: 'failed' },
            evidence: expect.objectContaining({
              properties: { failure_kind: { const: 'test-contradiction' } },
              required: ['failure_kind'],
            }),
          }),
        }),
      }),
    ]));

    const cases = [
      ['valid exact declaration', validDraft(ticket, {
        status: 'failed',
        evidence: {
          failure_kind: 'test-contradiction',
          test_contradiction: {
            test_paths: ['tests/x.test.js'],
            summary: 'The authored expectation conflicts with the ticket objective.',
          },
        },
      }), true],
      ['passed declaration', validDraft(ticket, {
        evidence: {
          test_contradiction: { test_paths: ['tests/x.test.js'] },
        },
      }), false],
      ['wrong failure kind', validDraft(ticket, {
        status: 'failed',
        evidence: {
          failure_kind: 'protocol',
          test_contradiction: { test_paths: ['tests/x.test.js'] },
        },
      }), false],
      ['invented test path', validDraft(ticket, {
        status: 'failed',
        evidence: {
          failure_kind: 'test-contradiction',
          test_contradiction: { test_paths: ['tests/invented.test.js'] },
        },
      }), false],
    ];
    for (const [name, draft, expected] of cases) {
      const workerSchemaAccepted = receiptDraftSchemaForTicket(ticket).safeParse(draft).success;
      const canonicalAccepted = validateReceiptDraft(ticket, draft).valid;
      expect(workerSchemaAccepted, `${name}: worker Zod`).toBe(expected);
      expect(canonicalAccepted, `${name}: canonical validation`).toBe(expected);
      expect(workerSchemaAccepted, `${name}: schema/validator parity`).toBe(canonicalAccepted);
    }
  });

  it('binds scope expansion to a completed negative review with a blocking finding', () => {
    const ticket = contractTicket({
      ticket_id: 'run-schema:review:blocking-scope-ticket',
      stage_id: 'review',
      role: 'reviewer',
      review_contract_version: 1,
    });
    expect(ticket.output_schema.allOf).toEqual(expect.arrayContaining([
      expect.objectContaining({
        if: {
          properties: { evidence: { required: ['scope_expansion'] } },
          required: ['evidence'],
        },
        then: expect.objectContaining({
          properties: expect.objectContaining({
            status: { const: 'passed' },
            evidence: expect.objectContaining({
              properties: { verdict: { const: 'fail' } },
              required: ['verdict'],
            }),
            findings: expect.objectContaining({
              minItems: 1,
              contains: expect.objectContaining({
                properties: { blocking: { const: true } },
              }),
            }),
          }),
        }),
      }),
    ]));

    const blockingFinding = {
      id: 'scope-growth',
      file: 'src/x.js',
      line: 1,
      title: 'Production dependency is outside the ticket scope',
      detail: 'The correction requires a production helper that the immutable ticket does not authorize.',
      blocking: true,
      remediation: { owner: 'production' },
    };
    const expansion = {
      claimed_paths: ['src/helper.js'],
      reason: 'The blocking production correction requires this helper.',
    };
    const cases = [
      ['valid blocking negative review', validDraft(ticket, {
        findings: [blockingFinding],
        evidence: { verdict: 'fail', scope_expansion: expansion },
      }), true],
      ['agreeing review', validDraft(ticket, {
        evidence: { verdict: 'pass', scope_expansion: expansion },
      }), false],
      ['failed non-voting review', validDraft(ticket, {
        status: 'failed',
        evidence: { failure_kind: 'infrastructure', scope_expansion: expansion },
      }), false],
      ['negative review without a blocking finding', validDraft(ticket, {
        evidence: { verdict: 'fail', scope_expansion: expansion },
      }), false],
    ];
    for (const [name, draft, expected] of cases) {
      const workerSchemaAccepted = receiptDraftSchemaForTicket(ticket).safeParse(draft).success;
      const canonicalAccepted = validateReceiptDraft(ticket, draft).valid;
      expect(workerSchemaAccepted, `${name}: worker Zod`).toBe(expected);
      expect(canonicalAccepted, `${name}: canonical validation`).toBe(expected);
      expect(workerSchemaAccepted, `${name}: schema/validator parity`).toBe(canonicalAccepted);
    }
  });

  it('publishes executable review-finding and targeted-test conditionals', () => {
    const review = contractTicket({
      ticket_id: 'run-schema:review:conditional-ticket',
      stage_id: 'review',
      role: 'reviewer',
      review_contract_version: 1,
      required_checks: ['targeted-tests'],
    });
    const conditionals = review.output_schema.allOf;
    expect(conditionals).toEqual(expect.arrayContaining([
      expect.objectContaining({
        if: expect.objectContaining({
          properties: expect.objectContaining({
            evidence: expect.objectContaining({
              properties: { verdict: { enum: ['fail'] } },
            }),
          }),
        }),
        then: { properties: { findings: expect.objectContaining({ contains: expect.any(Object) }) } },
      }),
      expect.objectContaining({
        then: {
          properties: {
            tests: {
              contains: expect.objectContaining({
                properties: { passed: { const: true }, exit_code: { const: 0 } },
              }),
            },
          },
        },
      }),
    ]));
    expect(validateReceiptDraft(review, validDraft(review, {
      evidence: { verdict: 'pass' },
    })).corrections).toEqual(expect.arrayContaining([
      expect.objectContaining({ field: 'tests' }),
    ]));
  });
});

describe('candidate plan UTF-8 byte boundary', () => {
  const cases = [
    [16_383, true],
    [16_384, true],
    [16_385, false],
  ];

  it.each(cases)('measures and enforces a %i-byte Unicode plan', (bytes, accepted) => {
    const ticket = contractTicket({
      ticket_id: `run-schema:plan:ticket-${bytes}`,
      stage_id: 'plan',
      role: 'planner',
      plan_contract_version: 1,
    });
    const candidatePlan = planAtUtf8Bytes(bytes);
    expect(Buffer.byteLength(canonicalJson(candidatePlan), 'utf8')).toBe(bytes);
    const result = validateReceiptDraft(ticket, validDraft(ticket, {
      evidence: { candidate_plan: candidatePlan },
    }));
    expect(result.valid).toBe(accepted);
    expect(result.budgets.candidate_plan_utf8_bytes).toEqual({
      used_bytes: bytes,
      max_bytes: PLAN_CONTRACT_MAX_BYTES,
      remaining_bytes: Math.max(0, PLAN_CONTRACT_MAX_BYTES - bytes),
    });
    if (!accepted) expect(result.corrections.map((entry) => entry.issue).join(' ')).toMatch(/16384 UTF-8 bytes/u);
  });
});
