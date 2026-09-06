import { describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG } from '../lib/runtime/config.js';
import { sha256 } from '../lib/runtime/canonical.js';
import { capabilityTestPathBoundErrors } from '../lib/runtime/capability-contract.js';
import { ticketCapabilityManifest, validateCapabilityManifestGrowth, mergeReceiptCapabilityGrowthResult } from '../lib/runtime/capability-manifest.js';
import { evaluateRunReadiness } from '../lib/runtime/readiness.js';
import { projectedPipeline } from '../lib/runtime/pipeline.js';
import { receiptOutputSchemaForTicket, validateReceiptDraft } from '../lib/runtime/receipt-validator.js';
import { runContractByteBudgets, runContractFieldBounds } from '../lib/runtime/run-contract.js';
import { reviewFindings } from '../lib/runtime/review-evidence.js';
import { GENERAL_INPUT_MAX_BYTES, INPUT_LIMITS, RECEIPT_INPUT_MAX_BYTES } from '../lib/runtime/input-guard.js';

const HASH = 'a'.repeat(64);
const paths = (count, width = 61) => Array.from({ length: count }, (_, index) => {
  const suffix = `${String(index).padStart(4, '0')}.test.js`;
  return `tests/${'x'.repeat(width - 6 - suffix.length)}${suffix}`;
});

function stateFor(version = 2, template = 'node --test {paths}') {
  return { objective: 'Inspect the complete authorized scope', binding_protocol: 'native-v1',
    mode: 'phase', lane: 'fast', behavioral: true, test_paths: ['tests/base.test.js'],
    claimed_paths: ['src/value.js'], risk_triggers: [], policy: { design_assurance_required: false },
    capability_snapshot: { version: 1, config_hash: HASH, manifest_growth_contract_version: version,
      ...(version === 2 ? { artifact_limits_version: 2 } : {}), manifest_roles: ['implementer'],
      command_profiles: [], verification_profiles: [], required_capabilities: [], evidence_scripts: [], runners: [],
      test_commands: { targeted_template: template, full: 'node --test' } } };
}

function ticketFor(role = 'implementer', modern = true, testPaths = []) {
  const state = stateFor(modern ? 2 : 1);
  state.test_paths = testPaths;
  const ticket = { ticket_id: 'run-resource:stage:ticket', ticket_hash: HASH,
    stage_id: role === 'plan_checker' ? 'plan-check' : role,
    role, receipt_contract_version: 1, plan_contract_version: 2,
    objective: state.objective, test_paths: testPaths, claimed_paths: ['src/value.js'], required_checks: [],
    ...(['reviewer', 'security_reviewer'].includes(role) ? { review_contract_version: 1 } : {}),
    capability_manifest: { ...ticketCapabilityManifest(state, { role }, testPaths),
      field_bounds: runContractFieldBounds({ manifest_growth_contract_version: modern ? 2 : 1 }),
      byte_budgets: runContractByteBudgets(state) } };
  ticket.output_schema = receiptOutputSchemaForTicket(ticket);
  ticket.capability_manifest.receipt_schema = { ref: 'ticket.output_schema', hash: sha256(ticket.output_schema) };
  return ticket;
}

function draftFor(ticket, evidence = {}, status = 'passed', findings = [], tests = []) {
  return { ticket_id: ticket.ticket_id, status, evidence, findings, tests,
    receipt_capability: 'resource-contract-capability-token-1234567890' };
}

function readinessFor(config, testPaths = ['tests/base.test.js']) {
  const input = { objective: 'Verify the concrete admitted scope', host: 'codex', mode: 'phase', lane: 'fast',
    behavioral: true, claimed_paths: ['src/value.js'], test_paths: testPaths,
    required_capabilities: [], requirements: [], risk_triggers: [], plan_contract_version: 2 };
  return evaluateRunReadiness({ input, config, classification: { lane: 'fast', risk_triggers: [], reasons: [] },
    projection: projectedPipeline({ ...input, policy: config.policy }), discovered: {} });
}

describe('capability and receipt resource envelopes', () => {
  it('replaces the guessed path budget only for version-two growth contracts', () => {
    const concretePaths = paths(64);
    expect(Buffer.byteLength(JSON.stringify(concretePaths))).toBe(4_097);
    expect(capabilityTestPathBoundErrors(concretePaths, { version: 1 }).valid).toBe(false);
    expect(capabilityTestPathBoundErrors(concretePaths, { version: 2 })).toMatchObject({
      valid: true, usage: { used_items: 64, max_items: INPUT_LIMITS.maxArrayLength, max_bytes: null },
    });
    expect(validateCapabilityManifestGrowth(stateFor(2), { test_paths: concretePaths }).valid).toBe(true);
    expect(validateCapabilityManifestGrowth(stateFor(1), { test_paths: concretePaths }).valid).toBe(false);
    expect(capabilityTestPathBoundErrors(['tests/../bad.js']).valid).toBe(false);
    expect(capabilityTestPathBoundErrors(['tests/a.js', 'tests/a.js']).valid).toBe(false);
    expect(capabilityTestPathBoundErrors(paths(INPUT_LIMITS.maxArrayLength + 1)).valid).toBe(false);
  });

  it('admits the actual command and reports correctable overflow only when paths really grow', () => {
    const template = `node ${'x'.repeat(4_500)} {paths}`;
    const config = structuredClone(DEFAULT_CONFIG);
    config.test_commands = { targeted_template: template, full: 'node --test' };
    expect(readinessFor(config).ready).toBe(true);
    const growth = validateCapabilityManifestGrowth(stateFor(2, template), { test_paths: paths(64) });
    expect(growth).toMatchObject({ valid: false, test_path_bounds_valid: false });
    expect(growth.errors.join(' ')).toContain('8192');
    expect(mergeReceiptCapabilityGrowthResult({ valid: true, corrections: [] }, growth)).toMatchObject({
      capability_growth: { next_action: { kind: 'continue_same_agent', failure_domain: 'orchestration' } },
    });
  });

  it('admits short script aliases and profile collections beyond the old counts within the actual envelope', () => {
    const config = structuredClone(DEFAULT_CONFIG);
    config.test_commands = { targeted_template: 'node --test {paths}', full: 'node --test' };
    config.policy.evidence_scripts = ['test', ...Array.from({ length: 64 }, (_, index) => `check${index}`)];
    config.policy.command_profiles = Array.from({ length: 65 }, (_, index) => ({
      id: `inspect${index}`, roles: ['implementer'], effect: 'read', command: `node --version ${index}`,
    }));
    const readiness = readinessFor(config);
    expect(readiness.ready).toBe(true);
    expect(readiness.capabilities.evidence_scripts).toHaveLength(65);
    const tooLarge = structuredClone(config);
    tooLarge.verification.profiles = Array.from({ length: 8 }, (_, index) => ({
      id: `large${index}`, description: 'x'.repeat(40_000), command: 'node --test', timeout_ms: 1_000,
    }));
    expect(readinessFor(tooLarge).blocking).toContainEqual(expect.objectContaining({
      code: 'capability-manifest-resource-over-limit',
    }));
  });

  it('preserves historical receipt schemas while new complete receipts use the resource envelope', () => {
    const legacy = ticketFor('implementer', false);
    const modern = ticketFor();
    expect(legacy.capability_manifest.byte_budgets.candidate_plan_utf8_bytes).toBe(16_384);
    expect(modern.capability_manifest.byte_budgets.candidate_plan_utf8_bytes).toBe(GENERAL_INPUT_MAX_BYTES);
    expect(legacy.output_schema.properties.tests.maxItems).toBe(256);
    expect(modern.output_schema.properties.tests.maxItems).toBe(INPUT_LIMITS.maxArrayLength);
    const tests = Array.from({ length: 257 }, () => ({ command: 'node --test', passed: true, duration_ms: 0, exit_code: 0 }));
    expect(validateReceiptDraft(modern, draftFor(modern, {}, 'passed', [], tests)).valid).toBe(true);
    expect(validateReceiptDraft(legacy, draftFor(legacy, {}, 'passed', [], tests)).valid).toBe(false);
    const oversized = draftFor(modern, { summary: 'x'.repeat(RECEIPT_INPUT_MAX_BYTES) });
    expect(validateReceiptDraft(modern, oversized).valid).toBe(false);
  });

  it('accepts complete modern findings while retaining exact paths, ownership, and verdict rules', () => {
    const modern = ticketFor('reviewer');
    const legacy = ticketFor('reviewer', false);
    const findings = Array.from({ length: 65 }, (_, index) => ({ id: `F${index}`, file: `src/file${index}.js`,
      line: index === 0 ? 10_000_001 : 1, title: index === 0 ? 't'.repeat(201) : 'Finding',
      detail: index === 0 ? 'd'.repeat(4_001) : 'Observed defect', blocking: true, remediation: { owner: 'production' } }));
    const modernDraft = draftFor(modern, { verdict: 'fail' }, 'passed', findings);
    expect(validateReceiptDraft(modern, modernDraft).valid).toBe(true);
    expect(validateReceiptDraft(legacy, draftFor(legacy, { verdict: 'fail' }, 'passed', findings)).valid).toBe(false);
    modernDraft.findings[0].remediation = { owner: 'test', test_paths: ['tests/not-authorized.test.js'] };
    expect(validateReceiptDraft(modern, modernDraft).valid).toBe(false);
  });

  it('keeps complete modern recovery declarations and exact reconciliation paths', () => {
    const additions = paths(65);
    const modern = ticketFor();
    const legacy = ticketFor('implementer', false);
    const evidence = { failure_kind: 'capability', required_claims: { test_paths: additions } };
    expect(validateReceiptDraft(modern, draftFor(modern, evidence, 'failed')).valid).toBe(true);
    expect(validateReceiptDraft(legacy, draftFor(legacy, evidence, 'failed')).valid).toBe(false);
    const checker = ticketFor('plan_checker');
    expect(validateReceiptDraft(checker, draftFor(checker, { verdict: 'disagree',
      missing_assurances: Array.from({ length: 17 }, (_, index) => `${index}: ${'x'.repeat(501)}`) })).valid).toBe(true);
    const implementer = ticketFor('implementer', true, additions);
    const contradiction = draftFor(implementer, { failure_kind: 'test-contradiction',
      test_contradiction: { test_paths: additions, summary: 'x'.repeat(2_001) } }, 'failed');
    expect(validateReceiptDraft(implementer, contradiction).valid).toBe(true);
    expect(reviewFindings.testReconciliation(implementer, contradiction).test_paths).toEqual(additions);
  });
});
