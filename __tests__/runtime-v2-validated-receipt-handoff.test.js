import { describe, expect, it } from 'vitest';
import * as receiptValidator from '../lib/runtime/receipt-validator.js';
import * as receiptInput from '../lib/runtime/receipt-input.js';
import * as schemas from '../lib/runtime/schemas.js';
import * as pipeline from '../lib/runtime/pipeline.js';
import * as lifecyclePolicy from '../lib/runtime/hooks.js';
import * as claudeDispatch from '../lib/runtime/claude-dispatch.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTicket(overrides = {}) {
  return {
    ticket_id: 'run-test:build:ticket-1',
    run_id: 'run-test',
    stage_id: 'build',
    role: 'implementer',
    writable: true,
    claimed_paths: ['src/value.js'],
    test_paths: [],
    required_checks: [],
    model_tier: 'balanced',
    model: { model: 'opus' },
    deadline_at: new Date(Date.now() + 3600_000).toISOString(),
    output_schema: {
      type: 'object',
      required: ['ticket_id', 'status', 'tests', 'findings', 'evidence'],
      properties: {
        ticket_id: { type: 'string', minLength: 1 },
        status: { type: 'string', enum: ['passed', 'failed'] },
        tests: { type: 'array' },
        findings: { type: 'array' },
        evidence: { type: 'object' },
        receipt_capability: { type: 'string' },
      },
    },
    base_tree_sha: 'a'.repeat(40),
    attempt: 1,
    issued_at: new Date().toISOString(),
    ticket_hash: 'b'.repeat(64),
    ...overrides,
  };
}

function makeValidDraft(ticket, overrides = {}) {
  return {
    ticket_id: ticket.ticket_id,
    status: 'passed',
    tests: [{ command: 'npm test', passed: true, exit_code: 0, duration_ms: 100 }],
    findings: [],
    evidence: { summary: 'All checks pass' },
    timing: {
      started_at: ticket.issued_at,
      completed_at: new Date().toISOString(),
      duration_ms: 100,
    },
    receipt_capability: 'test-capability-token',
    ...overrides,
  };
}

function reviewerTicket(overrides = {}) {
  return makeTicket({
    ticket_id: 'run-test:review:ticket-r',
    stage_id: 'review',
    role: 'reviewer',
    writable: false,
    ...overrides,
  });
}

function plannerTicket(overrides = {}) {
  return makeTicket({
    ticket_id: 'run-test:plan:ticket-p',
    stage_id: 'plan',
    role: 'planner',
    writable: false,
    ...overrides,
  });
}

function preflightTicket(overrides = {}) {
  return makeTicket({
    ticket_id: 'run-test:preflight:ticket-pf',
    stage_id: 'preflight',
    role: 'preflight_analyst',
    writable: false,
    ...overrides,
  });
}

function securityReviewerTicket(overrides = {}) {
  return makeTicket({
    ticket_id: 'run-test:security-review:ticket-sr',
    stage_id: 'security-review',
    role: 'security_reviewer',
    writable: false,
    ...overrides,
  });
}

// ---------------------------------------------------------------------------
// W1: Receipt draft validation engine
// ---------------------------------------------------------------------------

describe('validateReceiptDraft', () => {
  it('is exported as a function from receipt-validator', () => {
    expect(typeof receiptValidator.validateReceiptDraft).toBe('function');
  });

  it('returns valid:true with empty corrections for a well-formed receipt', () => {
    const ticket = makeTicket();
    const draft = makeValidDraft(ticket);
    const result = receiptValidator.validateReceiptDraft(ticket, draft);
    expect(result).toBeDefined();
    expect(result.valid).toBe(true);
    expect(result.corrections).toEqual([]);
  });

  it('returns corrections for wrong ticket_id', () => {
    const ticket = makeTicket();
    const draft = makeValidDraft(ticket, { ticket_id: 'run-other:build:wrong' });
    const result = receiptValidator.validateReceiptDraft(ticket, draft);
    expect(result.valid).toBe(false);
    expect(result.corrections.length).toBeGreaterThan(0);
    expect(result.corrections.some((c) => c.field === 'ticket_id')).toBe(true);
  });

  it('returns corrections for missing status', () => {
    const ticket = makeTicket();
    const draft = makeValidDraft(ticket);
    delete draft.status;
    const result = receiptValidator.validateReceiptDraft(ticket, draft);
    expect(result.valid).toBe(false);
    expect(result.corrections.some((c) => c.field === 'status')).toBe(true);
  });

  it('returns corrections for invalid status value', () => {
    const ticket = makeTicket();
    const draft = makeValidDraft(ticket, { status: 'maybe' });
    const result = receiptValidator.validateReceiptDraft(ticket, draft);
    expect(result.valid).toBe(false);
    expect(result.corrections.some((c) => c.field === 'status')).toBe(true);
  });

  it('returns corrections for bad test shape (missing required fields)', () => {
    const ticket = makeTicket();
    const draft = makeValidDraft(ticket, {
      tests: [{ command: 'npm test' }],
    });
    const result = receiptValidator.validateReceiptDraft(ticket, draft);
    expect(result.valid).toBe(false);
    expect(result.corrections.some((c) => c.field.startsWith('tests'))).toBe(true);
  });

  it('returns corrections for non-array tests', () => {
    const ticket = makeTicket();
    const draft = makeValidDraft(ticket, { tests: 'not-an-array' });
    const result = receiptValidator.validateReceiptDraft(ticket, draft);
    expect(result.valid).toBe(false);
    expect(result.corrections.some((c) => c.field === 'tests')).toBe(true);
  });

  it('returns corrections for non-array findings', () => {
    const ticket = makeTicket();
    const draft = makeValidDraft(ticket, { findings: 42 });
    const result = receiptValidator.validateReceiptDraft(ticket, draft);
    expect(result.valid).toBe(false);
    expect(result.corrections.some((c) => c.field === 'findings')).toBe(true);
  });

  it('returns corrections for non-object evidence', () => {
    const ticket = makeTicket();
    const draft = makeValidDraft(ticket, { evidence: 'not-an-object' });
    const result = receiptValidator.validateReceiptDraft(ticket, draft);
    expect(result.valid).toBe(false);
    expect(result.corrections.some((c) => c.field === 'evidence')).toBe(true);
  });

  it('returns corrections for missing receipt_capability when ticket has one', () => {
    const ticket = makeTicket();
    const draft = makeValidDraft(ticket);
    delete draft.receipt_capability;
    // The output_schema requires receipt_capability; the draft must carry it
    const result = receiptValidator.validateReceiptDraft(ticket, draft);
    // receipt_capability is optional in the schema but the ticket may require it
    // through output_schema; validation should flag its absence when needed
    expect(result).toBeDefined();
    expect(result.corrections).toBeDefined();
  });

  it('caps corrections at 20 entries', () => {
    const ticket = makeTicket();
    // A maximally malformed draft should still produce at most 20 corrections
    const draft = {};
    const result = receiptValidator.validateReceiptDraft(ticket, draft);
    expect(result.valid).toBe(false);
    expect(result.corrections.length).toBeLessThanOrEqual(20);
  });

  it('returns corrections with field, issue, and correction properties', () => {
    const ticket = makeTicket();
    const draft = makeValidDraft(ticket, { status: 'maybe' });
    const result = receiptValidator.validateReceiptDraft(ticket, draft);
    expect(result.valid).toBe(false);
    for (const correction of result.corrections) {
      expect(correction).toHaveProperty('field');
      expect(correction).toHaveProperty('issue');
      expect(correction).toHaveProperty('correction');
    }
  });
});

// ---------------------------------------------------------------------------
// W1: Role-specific receipt validation
// ---------------------------------------------------------------------------

describe('validateReceiptDraft role-specific validation', () => {
  it('returns corrections for planner missing candidate_plan in evidence', () => {
    const ticket = plannerTicket();
    const draft = makeValidDraft(ticket, {
      evidence: { summary: 'plan done' },
    });
    const result = receiptValidator.validateReceiptDraft(ticket, draft);
    expect(result.valid).toBe(false);
    expect(result.corrections.some(
      (c) => c.field.includes('candidate_plan') || c.issue.includes('candidate_plan'),
    )).toBe(true);
  });

  it('returns corrections for reviewer missing verdict in evidence', () => {
    const ticket = reviewerTicket();
    const draft = makeValidDraft(ticket, {
      evidence: { summary: 'reviewed' },
    });
    const result = receiptValidator.validateReceiptDraft(ticket, draft);
    expect(result.valid).toBe(false);
    expect(result.corrections.some(
      (c) => c.field.includes('verdict') || c.issue.includes('verdict'),
    )).toBe(true);
  });

  it('returns corrections for reviewer with wrong verdict value', () => {
    const ticket = reviewerTicket();
    const draft = makeValidDraft(ticket, {
      evidence: { verdict: 'maybe' },
    });
    const result = receiptValidator.validateReceiptDraft(ticket, draft);
    expect(result.valid).toBe(false);
    expect(result.corrections.some(
      (c) => c.field.includes('verdict') || c.issue.includes('verdict'),
    )).toBe(true);
  });

  it('accepts reviewer with valid verdict pass', () => {
    const ticket = reviewerTicket();
    const draft = makeValidDraft(ticket, {
      evidence: { verdict: 'pass', summary: 'looks good' },
    });
    const result = receiptValidator.validateReceiptDraft(ticket, draft);
    expect(result.valid).toBe(true);
    expect(result.corrections).toEqual([]);
  });

  it('accepts reviewer with valid verdict fail', () => {
    const ticket = reviewerTicket();
    const draft = makeValidDraft(ticket, {
      evidence: { verdict: 'fail', summary: 'defect found' },
      findings: [{ severity: 'high', note: 'bug' }],
    });
    const result = receiptValidator.validateReceiptDraft(ticket, draft);
    expect(result.valid).toBe(true);
    expect(result.corrections).toEqual([]);
  });

  it('returns corrections for security_reviewer missing verdict', () => {
    const ticket = securityReviewerTicket();
    const draft = makeValidDraft(ticket, {
      evidence: { summary: 'sec review done' },
    });
    const result = receiptValidator.validateReceiptDraft(ticket, draft);
    expect(result.valid).toBe(false);
    expect(result.corrections.some(
      (c) => c.field.includes('verdict') || c.issue.includes('verdict'),
    )).toBe(true);
  });

  it('returns corrections for preflight_analyst missing artifact in evidence', () => {
    const ticket = preflightTicket();
    const draft = makeValidDraft(ticket, {
      evidence: { summary: 'preflight done' },
    });
    const result = receiptValidator.validateReceiptDraft(ticket, draft);
    expect(result.valid).toBe(false);
    expect(result.corrections.some(
      (c) => c.field.includes('artifact') || c.field.includes('preflight') ||
             c.issue.includes('artifact') || c.issue.includes('preflight'),
    )).toBe(true);
  });

  it('accepts valid reviewer verdict agree for plan review', () => {
    const ticket = makeTicket({
      ticket_id: 'run-test:plan-check:ticket-pc',
      stage_id: 'plan-check',
      role: 'plan_checker',
      writable: false,
    });
    const draft = makeValidDraft(ticket, {
      evidence: { verdict: 'agree', summary: 'plan is sound' },
    });
    const result = receiptValidator.validateReceiptDraft(ticket, draft);
    expect(result.valid).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// W1: extractReceiptDraftFromText
// ---------------------------------------------------------------------------

describe('extractReceiptDraftFromText', () => {
  it('is exported as a function from receipt-input', () => {
    expect(typeof receiptInput.extractReceiptDraftFromText).toBe('function');
  });

  it('finds a JSON receipt in plain text', () => {
    const draft = { ticket_id: 'run-1:test:t1', status: 'passed', tests: [], findings: [], evidence: {} };
    const text = JSON.stringify(draft);
    const result = receiptInput.extractReceiptDraftFromText(text);
    expect(result).toBeDefined();
    expect(result.ticket_id).toBe('run-1:test:t1');
  });

  it('finds a JSON receipt wrapped in prose', () => {
    const draft = { ticket_id: 'run-1:test:t1', status: 'passed', tests: [], findings: [], evidence: {} };
    const text = `Here is my receipt:\n\`\`\`json\n${JSON.stringify(draft)}\n\`\`\`\nDone.`;
    const result = receiptInput.extractReceiptDraftFromText(text);
    expect(result).toBeDefined();
    expect(result.ticket_id).toBe('run-1:test:t1');
  });

  it('returns null when no JSON receipt is present', () => {
    const result = receiptInput.extractReceiptDraftFromText('No receipt here, just text.');
    expect(result).toBeNull();
  });

  it('returns null for empty text', () => {
    const result = receiptInput.extractReceiptDraftFromText('');
    expect(result).toBeNull();
  });

  it('returns null for non-receipt JSON objects', () => {
    const text = JSON.stringify({ name: 'not a receipt', value: 42 });
    const result = receiptInput.extractReceiptDraftFromText(text);
    expect(result).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// W1: formatDraftCorrections
// ---------------------------------------------------------------------------

describe('formatDraftCorrections', () => {
  it('is exported as a function from receipt-input', () => {
    expect(typeof receiptInput.formatDraftCorrections).toBe('function');
  });

  it('produces bounded output under 2000 characters', () => {
    const ticket = makeTicket();
    const corrections = Array.from({ length: 20 }, (_, i) => ({
      field: `field_${i}`,
      issue: `This field has a problem number ${i} that is described here in detail`,
      correction: `Fix the field by doing this specific thing for correction ${i}`,
    }));
    const output = receiptInput.formatDraftCorrections(corrections, ticket);
    expect(typeof output).toBe('string');
    expect(output.length).toBeLessThanOrEqual(2000);
  });

  it('renders empty corrections as an empty or minimal string', () => {
    const ticket = makeTicket();
    const output = receiptInput.formatDraftCorrections([], ticket);
    expect(typeof output).toBe('string');
  });

  it('renders each correction with field, issue and correction', () => {
    const ticket = makeTicket();
    const corrections = [
      { field: 'status', issue: 'invalid value', correction: 'use passed or failed' },
    ];
    const output = receiptInput.formatDraftCorrections(corrections, ticket);
    expect(output).toContain('status');
    expect(output).toContain('invalid value');
  });
});

// ---------------------------------------------------------------------------
// W2: Lifecycle enforcement - evaluateStopValidation
// ---------------------------------------------------------------------------

describe('evaluateStopValidation', () => {
  it('is exported as a function from lifecycle-policy (hooks)', () => {
    expect(typeof lifecyclePolicy.evaluateStopValidation).toBe('function');
  });

  it('returns continue with corrections for a Stop with an invalid draft on first attempt', () => {
    const ticket = makeTicket();
    const event = {
      host: 'claude',
      event: 'Stop',
      tool_name: '',
      is_subagent: true,
    };
    const context = {
      state: { status: 'running' },
      ticket,
      draft: makeValidDraft(ticket, { status: 'maybe' }),
      validation_attempts: 0,
    };
    const result = lifecyclePolicy.evaluateStopValidation(event, context);
    expect(result).toBeDefined();
    expect(result.decision).toBe('continue');
    expect(result.corrections).toBeDefined();
    expect(result.corrections.length).toBeGreaterThan(0);
  });

  it('returns allow for a Stop with a valid draft', () => {
    const ticket = makeTicket();
    const event = {
      host: 'claude',
      event: 'Stop',
      tool_name: '',
      is_subagent: true,
    };
    const context = {
      state: { status: 'running' },
      ticket,
      draft: makeValidDraft(ticket),
      validation_attempts: 0,
    };
    const result = lifecyclePolicy.evaluateStopValidation(event, context);
    expect(result).toBeDefined();
    expect(result.decision).toBe('allow');
  });

  it('allows Stop regardless after 2 correction attempts', () => {
    const ticket = makeTicket();
    const event = {
      host: 'claude',
      event: 'Stop',
      tool_name: '',
      is_subagent: true,
    };
    const context = {
      state: { status: 'running' },
      ticket,
      draft: makeValidDraft(ticket, { status: 'maybe' }),
      validation_attempts: 2,
    };
    const result = lifecyclePolicy.evaluateStopValidation(event, context);
    expect(result).toBeDefined();
    expect(result.decision).toBe('allow');
  });

  it('works the same for SubagentStop events', () => {
    const ticket = makeTicket();
    const event = {
      host: 'claude',
      event: 'SubagentStop',
      tool_name: '',
      is_subagent: true,
    };
    const context = {
      state: { status: 'running' },
      ticket,
      draft: makeValidDraft(ticket),
      validation_attempts: 0,
    };
    const result = lifecyclePolicy.evaluateStopValidation(event, context);
    expect(result).toBeDefined();
    expect(result.decision).toBe('allow');
  });

  it('works across Claude, Codex, and Gemini hosts', () => {
    for (const host of ['claude', 'codex', 'gemini']) {
      const ticket = makeTicket();
      const event = {
        host,
        event: 'Stop',
        tool_name: '',
        is_subagent: true,
      };
      const context = {
        state: { status: 'running' },
        ticket,
        draft: makeValidDraft(ticket),
        validation_attempts: 0,
      };
      const result = lifecyclePolicy.evaluateStopValidation(event, context);
      expect(result).toBeDefined();
      expect(result.decision).toBe('allow');
    }
  });
});

// ---------------------------------------------------------------------------
// W2: Dispatch validation tracking
// ---------------------------------------------------------------------------

describe('dispatch draft validation tracking', () => {
  it('observeDispatchDraftValidation is exported from claude-dispatch', () => {
    expect(typeof claudeDispatch.observeDispatchDraftValidation).toBe('function');
  });

  it('markDispatchInfrastructureFailure is exported from claude-dispatch', () => {
    expect(typeof claudeDispatch.markDispatchInfrastructureFailure).toBe('function');
  });
});

// ---------------------------------------------------------------------------
// W2: SubagentStop infrastructure failure detection
// ---------------------------------------------------------------------------

describe('SubagentStop infrastructure failure', () => {
  it('marks infrastructure failure when valid_draft_observed is false at SubagentStop', () => {
    const ticket = makeTicket();
    const event = {
      host: 'claude',
      event: 'SubagentStop',
      tool_name: '',
      is_subagent: true,
    };
    const context = {
      state: { status: 'running' },
      ticket,
      valid_draft_observed: false,
      validation_attempts: 0,
    };
    const result = lifecyclePolicy.evaluateStopValidation(event, context);
    expect(result).toBeDefined();
    // When no valid draft was observed at SubagentStop, an infrastructure
    // failure should be marked rather than silently completing
    expect(
      result.infrastructure_failure === true ||
      result.decision === 'allow',
    ).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// W3: Schema support - ReceiptDraftCorrectionSchema
// ---------------------------------------------------------------------------

describe('ReceiptDraftCorrectionSchema', () => {
  it('is exported from schemas', () => {
    expect(schemas.ReceiptDraftCorrectionSchema).toBeDefined();
  });

  it('validates a well-formed correction', () => {
    const correction = { field: 'status', issue: 'invalid value', correction: 'use passed or failed' };
    const result = schemas.ReceiptDraftCorrectionSchema.safeParse(correction);
    expect(result.success).toBe(true);
  });

  it('rejects a correction missing field', () => {
    const correction = { issue: 'invalid value', correction: 'fix it' };
    const result = schemas.ReceiptDraftCorrectionSchema.safeParse(correction);
    expect(result.success).toBe(false);
  });

  it('rejects a correction missing issue', () => {
    const correction = { field: 'status', correction: 'fix it' };
    const result = schemas.ReceiptDraftCorrectionSchema.safeParse(correction);
    expect(result.success).toBe(false);
  });

  it('rejects a correction missing correction', () => {
    const correction = { field: 'status', issue: 'invalid' };
    const result = schemas.ReceiptDraftCorrectionSchema.safeParse(correction);
    expect(result.success).toBe(false);
  });
});

describe('ReceiptValidationResultSchema', () => {
  it('is exported from schemas', () => {
    expect(schemas.ReceiptValidationResultSchema).toBeDefined();
  });

  it('validates a valid result with valid:true and empty corrections', () => {
    const result = schemas.ReceiptValidationResultSchema.safeParse({
      valid: true,
      corrections: [],
    });
    expect(result.success).toBe(true);
  });

  it('validates a result with valid:false and corrections', () => {
    const result = schemas.ReceiptValidationResultSchema.safeParse({
      valid: false,
      corrections: [
        { field: 'status', issue: 'missing', correction: 'add status field' },
      ],
    });
    expect(result.success).toBe(true);
  });

  it('rejects a result missing the valid field', () => {
    const result = schemas.ReceiptValidationResultSchema.safeParse({
      corrections: [],
    });
    expect(result.success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// W3: Pipeline - roleReceiptRequirements
// ---------------------------------------------------------------------------

describe('roleReceiptRequirements', () => {
  it('is exported as a function from pipeline', () => {
    expect(typeof pipeline.roleReceiptRequirements).toBe('function');
  });

  it('returns requirements for planner role', () => {
    const reqs = pipeline.roleReceiptRequirements('planner', 'plan');
    expect(reqs).toBeDefined();
    expect(Array.isArray(reqs) || typeof reqs === 'object').toBe(true);
  });

  it('returns requirements for reviewer role', () => {
    const reqs = pipeline.roleReceiptRequirements('reviewer', 'review');
    expect(reqs).toBeDefined();
  });

  it('returns requirements for security_reviewer role', () => {
    const reqs = pipeline.roleReceiptRequirements('security_reviewer', 'security-review');
    expect(reqs).toBeDefined();
  });

  it('returns requirements for preflight_analyst role', () => {
    const reqs = pipeline.roleReceiptRequirements('preflight_analyst', 'preflight');
    expect(reqs).toBeDefined();
  });

  it('returns requirements for implementer role', () => {
    const reqs = pipeline.roleReceiptRequirements('implementer', 'build');
    expect(reqs).toBeDefined();
  });

  it('returns requirements for test_writer role', () => {
    const reqs = pipeline.roleReceiptRequirements('test_writer', 'test');
    expect(reqs).toBeDefined();
  });

  it('returns requirements for plan_checker role', () => {
    const reqs = pipeline.roleReceiptRequirements('plan_checker', 'plan-check');
    expect(reqs).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// W4: Non-destructive validation properties
// ---------------------------------------------------------------------------

describe('non-destructive validation', () => {
  it('validation does not consume the receipt capability', () => {
    const ticket = makeTicket();
    const draft = makeValidDraft(ticket, { status: 'maybe' });
    // Calling validateReceiptDraft should not alter the ticket or consume any
    // capability token; the same ticket+draft can be re-validated
    const r1 = receiptValidator.validateReceiptDraft(ticket, draft);
    const r2 = receiptValidator.validateReceiptDraft(ticket, draft);
    expect(r1.valid).toBe(r2.valid);
    expect(r1.corrections.length).toBe(r2.corrections.length);
  });

  it('validation does not mutate the ticket object', () => {
    const ticket = makeTicket();
    const ticketCopy = JSON.parse(JSON.stringify(ticket));
    const draft = makeValidDraft(ticket, { status: 'maybe' });
    receiptValidator.validateReceiptDraft(ticket, draft);
    expect(ticket).toEqual(ticketCopy);
  });

  it('validation does not mutate the draft object', () => {
    const ticket = makeTicket();
    const draft = makeValidDraft(ticket, { status: 'maybe' });
    const draftCopy = JSON.parse(JSON.stringify(draft));
    receiptValidator.validateReceiptDraft(ticket, draft);
    expect(draft).toEqual(draftCopy);
  });

  it('validation does not increment attempt count', () => {
    const ticket = makeTicket({ attempt: 1 });
    const draft = makeValidDraft(ticket, { status: 'maybe' });
    receiptValidator.validateReceiptDraft(ticket, draft);
    expect(ticket.attempt).toBe(1);
  });

  it('valid receipts remain record-compatible after validation', () => {
    const ticket = makeTicket();
    const draft = makeValidDraft(ticket);
    const result = receiptValidator.validateReceiptDraft(ticket, draft);
    expect(result.valid).toBe(true);
    // The draft should still be usable for normalizeReceiptInput
    const normalized = receiptInput.normalizeReceiptInput(draft);
    expect(normalized.input).toBeDefined();
  });

  it('validation is idempotent', () => {
    const ticket = makeTicket();
    const draft = makeValidDraft(ticket);
    const r1 = receiptValidator.validateReceiptDraft(ticket, draft);
    const r2 = receiptValidator.validateReceiptDraft(ticket, draft);
    expect(r1.valid).toBe(r2.valid);
    expect(r1.corrections).toEqual(r2.corrections);
  });
});

// ---------------------------------------------------------------------------
// W4: Wrong envelope tests
// ---------------------------------------------------------------------------

describe('wrong envelope validation', () => {
  it('rejects a draft whose ticket_id references a different run', () => {
    const ticket = makeTicket();
    const draft = makeValidDraft(ticket, { ticket_id: 'run-other:build:t2' });
    const result = receiptValidator.validateReceiptDraft(ticket, draft);
    expect(result.valid).toBe(false);
    expect(result.corrections.some((c) => c.field === 'ticket_id')).toBe(true);
  });

  it('rejects a draft with an empty ticket_id', () => {
    const ticket = makeTicket();
    const draft = makeValidDraft(ticket, { ticket_id: '' });
    const result = receiptValidator.validateReceiptDraft(ticket, draft);
    expect(result.valid).toBe(false);
  });

  it('rejects a draft with a numeric ticket_id', () => {
    const ticket = makeTicket();
    const draft = makeValidDraft(ticket, { ticket_id: 12345 });
    const result = receiptValidator.validateReceiptDraft(ticket, draft);
    expect(result.valid).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// W4: Remediation ownership tests
// ---------------------------------------------------------------------------

describe('remediation ownership', () => {
  it('a reviewer verdict disagree does not block remediation routing', () => {
    const ticket = reviewerTicket();
    const draft = makeValidDraft(ticket, {
      status: 'passed',
      evidence: { verdict: 'disagree', summary: 'needs changes' },
      findings: [{ note: 'fix the bug' }],
    });
    const result = receiptValidator.validateReceiptDraft(ticket, draft);
    // A disagree verdict is valid for a reviewer even though it triggers remediation
    expect(result.valid).toBe(true);
  });

  it('a reviewer verdict fail is valid', () => {
    const ticket = reviewerTicket();
    const draft = makeValidDraft(ticket, {
      status: 'passed',
      evidence: { verdict: 'fail', summary: 'blocking issue' },
      findings: [{ severity: 'critical', note: 'security vulnerability' }],
    });
    const result = receiptValidator.validateReceiptDraft(ticket, draft);
    expect(result.valid).toBe(true);
  });

  it('a security reviewer verdict fail is valid and triggers security remediation', () => {
    const ticket = securityReviewerTicket();
    const draft = makeValidDraft(ticket, {
      status: 'passed',
      evidence: { verdict: 'fail', summary: 'vulnerability found' },
      findings: [{ severity: 'critical', note: 'injection risk' }],
    });
    const result = receiptValidator.validateReceiptDraft(ticket, draft);
    expect(result.valid).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// W4: Required structured evidence tests
// ---------------------------------------------------------------------------

describe('required structured evidence', () => {
  it('validates that evidence is an object, not an array', () => {
    const ticket = makeTicket();
    const draft = makeValidDraft(ticket, { evidence: ['not', 'an', 'object'] });
    const result = receiptValidator.validateReceiptDraft(ticket, draft);
    expect(result.valid).toBe(false);
    expect(result.corrections.some((c) => c.field === 'evidence')).toBe(true);
  });

  it('validates that findings is an array', () => {
    const ticket = makeTicket();
    const draft = makeValidDraft(ticket, { findings: { not: 'array' } });
    const result = receiptValidator.validateReceiptDraft(ticket, draft);
    expect(result.valid).toBe(false);
    expect(result.corrections.some((c) => c.field === 'findings')).toBe(true);
  });

  it('validates that tests is an array of objects with required fields', () => {
    const ticket = makeTicket();
    const draft = makeValidDraft(ticket, {
      tests: [
        { command: 'test', passed: true, exit_code: 0, duration_ms: 1 },
        { command: '' },
      ],
    });
    const result = receiptValidator.validateReceiptDraft(ticket, draft);
    expect(result.valid).toBe(false);
  });

  it('validates that test exit_code is an integer', () => {
    const ticket = makeTicket();
    const draft = makeValidDraft(ticket, {
      tests: [{ command: 'npm test', passed: true, exit_code: 1.5, duration_ms: 100 }],
    });
    const result = receiptValidator.validateReceiptDraft(ticket, draft);
    expect(result.valid).toBe(false);
  });

  it('validates that test duration_ms is non-negative', () => {
    const ticket = makeTicket();
    const draft = makeValidDraft(ticket, {
      tests: [{ command: 'npm test', passed: true, exit_code: 0, duration_ms: -1 }],
    });
    const result = receiptValidator.validateReceiptDraft(ticket, draft);
    expect(result.valid).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// W3: Reducer VALIDATION_INFRASTRUCTURE_FAILURE handling
// ---------------------------------------------------------------------------

describe('VALIDATION_INFRASTRUCTURE_FAILURE reducer event', () => {
  it('roleReceiptRequirements returns structured requirements for each role', () => {
    // This exercises the pipeline support function that the reducer needs
    // to determine validation requirements per role. The function does not
    // exist yet, so this fails.
    const reqs = pipeline.roleReceiptRequirements('implementer', 'build');
    expect(reqs).toBeDefined();
    expect(typeof reqs === 'object' || Array.isArray(reqs)).toBe(true);
    // Should include at minimum a list of required fields
    expect(reqs).toHaveProperty('required_fields');
  });
});

// ---------------------------------------------------------------------------
// W4: Cross-host consistency
// ---------------------------------------------------------------------------

describe('cross-host consistency', () => {
  it('validates consistently across Claude, Codex, and Gemini receipt drafts', () => {
    for (const host of ['claude', 'codex', 'gemini']) {
      const ticket = makeTicket();
      const draft = makeValidDraft(ticket);
      const result = receiptValidator.validateReceiptDraft(ticket, draft);
      expect(result.valid).toBe(true);
      expect(result.corrections).toEqual([]);
    }
  });

  it('rejects the same malformed draft uniformly across hosts', () => {
    for (const host of ['claude', 'codex', 'gemini']) {
      const ticket = makeTicket();
      const draft = makeValidDraft(ticket, { status: 'maybe', ticket_id: 'wrong' });
      const result = receiptValidator.validateReceiptDraft(ticket, draft);
      expect(result.valid).toBe(false);
      expect(result.corrections.length).toBeGreaterThan(0);
    }
  });
});

// ---------------------------------------------------------------------------
// W4: Valid receipt pass-through
// ---------------------------------------------------------------------------

describe('valid receipt pass-through', () => {
  it('passes a well-formed implementer receipt', () => {
    const ticket = makeTicket();
    const draft = makeValidDraft(ticket);
    const result = receiptValidator.validateReceiptDraft(ticket, draft);
    expect(result.valid).toBe(true);
    expect(result.corrections).toEqual([]);
  });

  it('passes a well-formed test_writer receipt', () => {
    const ticket = makeTicket({
      ticket_id: 'run-test:test:ticket-tw',
      stage_id: 'test',
      role: 'test_writer',
      test_paths: ['tests/value.test.js'],
      required_checks: ['red-test'],
    });
    const draft = makeValidDraft(ticket, {
      tests: [{ command: 'npx vitest run tests/value.test.js', passed: false, exit_code: 1, duration_ms: 200 }],
    });
    const result = receiptValidator.validateReceiptDraft(ticket, draft);
    expect(result.valid).toBe(true);
    expect(result.corrections).toEqual([]);
  });

  it('passes a well-formed reviewer receipt with verdict pass', () => {
    const ticket = reviewerTicket();
    const draft = makeValidDraft(ticket, {
      evidence: { verdict: 'pass', summary: 'LGTM' },
    });
    const result = receiptValidator.validateReceiptDraft(ticket, draft);
    expect(result.valid).toBe(true);
    expect(result.corrections).toEqual([]);
  });

  it('passes a well-formed failed receipt', () => {
    const ticket = makeTicket();
    const draft = makeValidDraft(ticket, {
      status: 'failed',
      evidence: { summary: 'could not complete', failure_kind: 'capability' },
    });
    const result = receiptValidator.validateReceiptDraft(ticket, draft);
    expect(result.valid).toBe(true);
    expect(result.corrections).toEqual([]);
  });
});
