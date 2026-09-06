import { describe, expect, it } from 'vitest';
import { canonicalJson, sha256 } from '../lib/runtime/canonical.js';
import { DEFAULT_CONFIG } from '../lib/runtime/config.js';
import { RISK_TRIGGERS } from '../lib/runtime/constants.js';
import { compileRunAdmissionContract } from '../lib/runtime/admission-compiler.js';
import { projectedPipeline } from '../lib/runtime/pipeline.js';
import { evaluateRunReadiness } from '../lib/runtime/readiness.js';
import { candidatePlanForScope, LEGACY_PLAN_CONTRACT_LIMITS, PLAN_CONTRACT_LIMITS, PLAN_CONTRACT_MAX_BYTES, planLimitsForTicket, preflightSchemaForTicket } from '../lib/runtime/plan-contract.js';
import { CapabilityManifestSchema } from '../lib/runtime/schemas.js';
import { receiptContractContext, codexInjectedDispatchContext } from '../lib/runtime/adapters.js';
import { receiptOutputSchemaForTicket, validateReceiptDraft } from '../lib/runtime/receipt-validator.js';
import { formatDraftCorrections } from '../lib/runtime/receipt-input.js';
import { RECEIPT_INPUT_MAX_BYTES, assertSafeInput } from '../lib/runtime/input-guard.js';
import { runContractByteBudgets, runContractFieldBounds } from '../lib/runtime/run-contract.js';
import { reviewFindings, REVIEW_FINDINGS_MAX, REVIEW_FINDINGS_BLOCK_LIMIT } from '../lib/runtime/review-evidence.js';

const bytes = (value) => Buffer.byteLength(canonicalJson(value), 'utf8');
const HASH = 'a'.repeat(64);

function ticketFor(overrides = {}, manifestOverrides = {}) {
  const ticket = {
    ticket_id: 'run-audit:plan:ticket', ticket_hash: HASH, stage_id: 'plan', role: 'planner',
    objective: 'Make the complete authorized change', claimed_paths: ['src/value.js'], test_paths: [],
    required_checks: [], receipt_contract_version: 1, plan_contract_version: 2, ...overrides,
  };
  ticket.capability_manifest = {
    version: 1, config_hash: HASH, required_capabilities: [], allowed_evidence_commands: ['npm test'],
    plannable_evidence_commands: ['npm test'], command_profiles: [], verification_profiles: [],
    objective_hash: sha256(ticket.objective), preflight_hash: HASH, risk_triggers: [],
    design_assurance_required: false, field_bounds: runContractFieldBounds(), byte_budgets: runContractByteBudgets(),
    ...manifestOverrides,
  };
  ticket.output_schema = receiptOutputSchemaForTicket(ticket);
  ticket.capability_manifest.receipt_schema = { ref: 'ticket.output_schema', hash: sha256(ticket.output_schema) };
  return ticket;
}

function planFor(command = 'npm test') {
  return { version: 2, preflight_hash: HASH,
    requirements: [{ id: 'R1', requirement: 'Update the value', workstreams: ['W1'] }],
    workstreams: [{ id: 'W1', outcome: 'Value updated', paths: [{ path: 'src/value.js', action: 'modify' }],
      steps: ['Update the value'], acceptance: ['Value is verified'], evidence_commands: [command], verification_profiles: [] }],
    risks: [], non_goals: [],
  };
}

function draftFor(ticket, evidence, tests = []) {
  return { ticket_id: ticket.ticket_id, status: 'passed', tests, findings: [], evidence,
    receipt_capability: 'capability'.repeat(4) };
}

describe('compatible planning, receipt, and feedback limits', () => {
  it('requires an explicit resource budget before widening a historical ticket artifact contract', () => {
    const unidentified = { role: 'preflight_analyst' };
    const modern = ticketFor({ role: 'preflight_analyst', stage_id: 'preflight' });
    expect(planLimitsForTicket(unidentified)).toBe(LEGACY_PLAN_CONTRACT_LIMITS);
    expect(planLimitsForTicket(modern)).toBe(PLAN_CONTRACT_LIMITS);
    expect(planLimitsForTicket({ output_schema: { 'x-ape-receipt-contract': { candidate_plan_utf8_max_bytes: 16_384 } } }))
      .toBe(LEGACY_PLAN_CONTRACT_LIMITS);
    const artifact = { version: 1, objective: 'Observe the baseline', acceptance: ['Covered'], non_goals: [],
      baseline: [{ command: 'npm test', observation: 'Observed' }], impacted_paths: { read: [], write: [] },
      compatibility: 'Compatible', rollback: 'Revert', verification_profiles: [],
      questions: Array.from({ length: 33 }, (_, index) => ({ id: `Q${index}`, question: 'Choose the behavior', rationale: 'Required decision' })) };
    expect(preflightSchemaForTicket(unidentified).safeParse(artifact).success).toBe(false);
    expect(preflightSchemaForTicket(modern).safeParse(artifact).success).toBe(true);
  });

  it('fits a complete plan and its formerly oversized template in the shared artifact budget', () => {
    const config = structuredClone(DEFAULT_CONFIG);
    config.verification.profiles = Array.from({ length: 64 }, (_, index) => ({
      id: `P${String(index).padStart(2, '0')}${'x'.repeat(61)}`,
      description: 'Unit verification', command: 'npm test', timeout_ms: 1000,
    }));
    const risks = RISK_TRIGGERS.slice(0, 7);
    const input = { objective: 'Synthetic bounded scope', host: 'codex', mode: 'phase', lane: 'full',
      behavioral: true, plan_contract_version: 2,
      claimed_paths: Array.from({ length: 19 }, (_, index) =>
        `src/${'x'.repeat(190)}/${'y'.repeat(190)}/${String(index).padStart(2, '0')}.js`),
      test_paths: [`tests/${'x'.repeat(190)}/${'y'.repeat(180)}/t.test.js`],
      requirements: [], required_capabilities: [], risk_triggers: risks,
    };
    const allPaths = [...input.claimed_paths, ...input.test_paths];
    const original = structuredClone(input);
    const result = compileRunAdmissionContract({ input, config,
      classification: { lane: 'full', risk_triggers: risks, reasons: [] },
      projection: projectedPipeline({ ...input, policy: config.policy }), planning_commands: ['npm test'] });
    expect(result.valid).toBe(true);
    expect(result.planner).toMatchObject({ representable: true });
    expect(result.planner.template_utf8_bytes).toBeLessThan(PLAN_CONTRACT_MAX_BYTES);
    expect(result.planner).toHaveProperty('template');
    expect(input).toEqual(original);

    const candidate = { ...planFor(),
      requirements: [{ id: 'R1', requirement: input.objective, workstreams: ['W0', 'W1'] }],
      workstreams: Array.from({ length: 2 }, (_, index) => ({ ...planFor().workstreams[0], id: `W${index}`,
        paths: allPaths.slice(index * 16, (index + 1) * 16).map((path) => ({ path, action: 'modify' })),
        verification_profiles: index === 0 ? config.verification.profiles.map((profile) => profile.id) : [] })),
      assurances: risks.map((risk_trigger, index) => ({ id: `A${index}`, risk_trigger,
        threat_model: 'Boundary audited', feasibility: 'Existing primitive', failure_modes: ['Rejected writes'],
        crash_recovery: 'Restore before image', migration: 'Compatible', determinism: 'Stable ordering',
        executable_tests: ['npm test'] })),
    };
    expect(bytes(candidate)).toBeLessThan(PLAN_CONTRACT_MAX_BYTES);
    expect(candidatePlanForScope(candidate, allPaths, null, { preflight_hash: HASH,
      verification_profiles: config.verification.profiles.map((profile) => ({ id: profile.id, required: true })),
      require_design_assurance: true, risk_triggers: risks, plannable_evidence_commands: ['npm test'] }).valid).toBe(true);
  });

  it('accepts exact catalog commands and detailed prose while rejecting unauthorized commands', () => {
    const command = `node tools/check.js ${'argument'.repeat(100)}`;
    const ticket = ticketFor({}, { allowed_evidence_commands: [command], plannable_evidence_commands: [command] });
    const candidate = planFor(command);
    expect(validateReceiptDraft(ticket, draftFor(ticket, { candidate_plan: candidate })).valid).toBe(true);
    const unauthorized = structuredClone(candidate);
    unauthorized.workstreams[0].evidence_commands[0] += ' extra';
    expect(validateReceiptDraft(ticket, draftFor(ticket, { candidate_plan: unauthorized })).valid).toBe(false);
    const verbose = structuredClone(candidate);
    verbose.workstreams[0].outcome = 'x'.repeat(501);
    expect(validateReceiptDraft(ticket, draftFor(ticket, { candidate_plan: verbose })).valid).toBe(true);
  });

  it('references the complete immutable schema instead of rejecting a valid large command catalog', () => {
    const commands = Array.from({ length: 10 }, (_, index) => `node check${index}.js ${'x'.repeat(5000)}`);
    const profiles = commands.map((command, index) => ({ id: `check${index}`, command,
      roles: ['planner', 'implementer'], effect: 'execute', operator_authorized: true }));
    const ticket = ticketFor({}, { allowed_evidence_commands: [...commands, 'npm test'],
      plannable_evidence_commands: [...commands, 'npm test'], command_profiles: profiles,
      planning_command_profiles: profiles, planning_required_capabilities: [] });
    expect(CapabilityManifestSchema.safeParse(ticket.capability_manifest).success).toBe(true);
    expect(bytes(ticket.output_schema)).toBeGreaterThan(96 * 1024);
    const before = structuredClone(ticket);
    const context = receiptContractContext(ticket);
    const reference = JSON.parse(context.split('Role-specific output_schema excerpt\n\n')[1].split('\n\n')[0]);
    expect(reference).toMatchObject({ projection: 'immutable-ticket-schema-reference-v1',
      path: '.ape/runtime/tickets/run-audit_plan_ticket.json', json_pointer: '/output_schema',
      schema_hash: sha256(ticket.output_schema), required: true });
    expect(Buffer.byteLength(codexInjectedDispatchContext(ticket), 'utf8')).toBeLessThan(160 * 1024);
    expect(ticket).toEqual(before);
    expect(ticket.output_schema.properties.tests.items.properties.command.enum).toEqual([...commands, 'npm test']);
  });

  it('delivers every complete correction at the shared maximum and redacts bearers', () => {
    const bearer = 'sensitive-receipt-capability';
    const corrections = Array.from({ length: 20 }, (_, index) => ({ field: `field${index}`,
      issue: 'i'.repeat(600), correction: `${index}: ${'c'.repeat(590)}` }));
    const text = formatDraftCorrections(corrections, { ticket_id: 't' });
    for (const correction of corrections) expect(text).toContain(`- ${correction.field}: ${correction.issue} -> ${correction.correction}\n`.trimEnd());
    expect(text).not.toContain('[truncated]');
    expect(Buffer.byteLength(text, 'utf8')).toBeLessThan(30_000);
    expect(formatDraftCorrections([{ field: 'evidence', issue: bearer, correction: bearer }],
      { ticket_id: 't' }, bearer)).not.toContain(bearer);
  });

  it('counts its omission marker inside forty entries and discloses the separate identity limit', () => {
    const ticket = { ticket_id: 'r:review:t', stage_id: 'review' };
    const receipt = { ticket_id: ticket.ticket_id, status: 'passed', evidence: { verdict: 'fail' },
      findings: Array.from({ length: 41 }, (_, index) => ({ id: `F${index}`, file: 'a.js', line: index + 1,
        title: `Bug ${index}`, detail: 'Fix the behavior', blocking: true, remediation: { owner: 'production' } })) };
    const state = { tickets: [ticket] };
    const projected = reviewFindings.select(state, [receipt]);
    expect(projected).toHaveLength(REVIEW_FINDINGS_MAX);
    expect(projected.at(-1)).toContain('2 of 41 review findings were dropped');
    expect(projected.at(-1)).toContain('review_finding_evidence list omits 25');
    expect(reviewFindings.evidence(state, [receipt])).toHaveLength(16);
    expect(JSON.stringify(projected).length).toBeLessThanOrEqual(REVIEW_FINDINGS_BLOCK_LIMIT);
    expect(receipt.findings).toHaveLength(41);
  });

  it('accepts a complete 64KiB preflight receipt through the same validator used by stop hooks', () => {
    const artifact = { version: 1, objective: 'Inspect the authorized scope', acceptance: ['a'],
      non_goals: Array.from({ length: 32 }, () => 'n'.repeat(2000)),
      baseline: [{ command: 'npm test', observation: 'Observed passing tests' }],
      impacted_paths: { read: [], write: [] }, compatibility: 'c', rollback: 'r', verification_profiles: [], questions: [] };
    artifact.compatibility = 'c'.repeat(65_536 - bytes(artifact) + 1);
    expect(artifact.compatibility.length).toBeLessThanOrEqual(2000);
    const ticket = ticketFor({ role: 'preflight_analyst', stage_id: 'preflight', objective: artifact.objective });
    const draft = draftFor(ticket, { preflight_artifact: artifact }, [{ command: 'npm test', passed: true,
      exit_code: 0, duration_ms: 1 }]);
    expect(bytes(artifact)).toBe(65_536);
    expect(bytes(draft)).toBeGreaterThan(65_536);
    expect(() => assertSafeInput(draft)).toThrow('input exceeds 65536 UTF-8 bytes');
    expect(validateReceiptDraft(ticket, draft)).toMatchObject({ valid: true, corrections: [] });
  });

  it('rejects oversize or prototype-unsafe receipt JSON before role validation', () => {
    const ticket = ticketFor();
    const oversize = draftFor(ticket, { summary: 'x'.repeat(RECEIPT_INPUT_MAX_BYTES) });
    const result = validateReceiptDraft(ticket, oversize);
    expect(result.valid).toBe(false);
    expect(result.corrections).toHaveLength(1);
    expect(result.corrections[0]).toMatchObject({ field: 'receipt', issue: `input exceeds ${RECEIPT_INPUT_MAX_BYTES} UTF-8 bytes` });
    const unsafe = draftFor(ticket, JSON.parse('{"constructor":"unsafe"}'));
    expect(validateReceiptDraft(ticket, unsafe).corrections[0].issue).toBe('receipt contains a forbidden prototype key');
    let nested = 'leaf';
    for (let index = 0; index < 33; index += 1) nested = { child: nested };
    expect(validateReceiptDraft(ticket, draftFor(ticket, { nested })).corrections[0].issue)
      .toBe('input nesting is too deep');
  });

  it('admits the former alias overflow and reports actual resource overflow before dispatch', () => {
    const config = structuredClone(DEFAULT_CONFIG);
    config.policy.evidence_scripts = ['test', ...Array.from({ length: 63 }, (_, index) => `check${index}`)];
    const input = { objective: 'Inspect aliases', host: 'codex', mode: 'phase', lane: 'full', behavioral: false,
      claimed_paths: ['src/value.js'], test_paths: [], requirements: [], required_capabilities: [], run_command_profiles: [] };
    const evaluate = () => evaluateRunReadiness({ input, config, classification: { lane: 'full', risk_triggers: [] },
      projection: projectedPipeline({ ...input, policy: config.policy }) });
    expect(evaluate().ready).toBe(true);
    config.policy.evidence_scripts = Array.from({ length: 513 }, (_, index) => `check${index}`);
    const overflow = evaluate();
    expect(overflow.ready).toBe(false);
    expect(overflow.blocking).toContainEqual(expect.objectContaining({
      code: 'capability-evidence-command-derivation-failed',
      message: expect.stringContaining('2048-item or 262144-byte capability manifest envelope'),
    }));
  });
});
