import { describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG } from '../lib/runtime/config.js';
import { compileRunAdmissionContract } from '../lib/runtime/admission-compiler.js';
import { evaluateRunReadiness } from '../lib/runtime/readiness.js';
import { pipelineLimits, pipelineRunSpec, projectedPipeline } from '../lib/runtime/pipeline.js';
import { candidatePlanForScope, PLAN_CONTRACT_LIMITS } from '../lib/runtime/plan-contract.js';
import { canonicalJson, sha256 } from '../lib/runtime/canonical.js';

function fixture(overrides = {}) {
  const input = {
    objective: 'Implement the bounded change', host: 'codex', mode: 'phase',
    lane: 'full', behavioral: true, plan_contract_version: 2,
    claimed_paths: ['src/value.js'], test_paths: ['tests/value.test.js'],
    requirements: [], required_capabilities: [], ...overrides,
  };
  const config = structuredClone(DEFAULT_CONFIG);
  config.test_commands.targeted_template = 'npm test -- {paths}';
  config.test_commands.full = 'npm test';
  const classification = { lane: input.lane, risk_triggers: [], reasons: [] };
  const projection = projectedPipeline({ ...input, policy: config.policy });
  return { input, config, classification, projection, planning_commands: ['npm test'] };
}

describe('prevention-first admission compiler', () => {
  it.each([undefined, 1, 2])('projects the exact plan version %s with one complete policy snapshot', (version) => {
    const args = fixture({ plan_contract_version: version });
    args.config.policy.high_risk_security_review = false;
    args.config.policy.design_assurance_required = false;
    args.config.policy.max_remediation_cycles = 10;
    args.classification.risk_triggers = ['auth'];
    const spec = pipelineRunSpec(args.input, args.classification, args.config);
    expect(spec.plan_contract_version).toBe(version);
    expect(spec.policy).toEqual({
      high_risk_security_review: false, design_assurance_required: false, max_remediation_cycles: 10,
    });
    args.projection = projectedPipeline(spec);
    expect(args.projection.stages.some((entry) => entry.id === 'preflight')).toBe(version === 2);
    expect(args.projection.stages.some((entry) => entry.id === 'security-review')).toBe(false);
    const result = compileRunAdmissionContract(args);
    expect(result.valid).toBe(true);
    expect(result.dispatch_bounds).toEqual(args.projection.dispatch_bounds);
  });

  it('rejects future manifest overflow without an explicit capability request', () => {
    const args = fixture();
    args.config.policy.command_profiles = Array.from({ length: 65 }, (_, index) => ({
      id: `future.${index}`, command: `tool check-${index}`, roles: ['reviewer'], effect: 'read',
    }));
    const result = evaluateRunReadiness(args);
    expect(result.ready).toBe(false);
    expect(result.blocking).toContainEqual(expect.objectContaining({
      code: 'capability-command-profiles-over-limit',
    }));
  });

  it('checks every reachable role model even if the first worker has a valid model', () => {
    const args = fixture();
    delete args.config.models.codex.deep;
    expect(args.config.models.codex.balanced.model).toBeTruthy();
    const result = evaluateRunReadiness(args);
    expect(result.ready).toBe(false);
    expect(result.blocking).toContainEqual(expect.objectContaining({
      code: 'reachable-role-model-invalid', role: 'planner',
    }));
  });

  it('shares the unchanged recovery limits and deterministic dispatch forecast', () => {
    const args = fixture();
    const result = compileRunAdmissionContract(args);
    expect(result.limits).toMatchObject({ max_directed_replans: 2, max_remediation_cycles: 3, max_stage_attempts: 2 });
    expect(result.limits).toEqual(pipelineLimits({ policy: args.config.policy }));
    expect(result.dispatch_bounds).toEqual(args.projection.dispatch_bounds);
    expect(compileRunAdmissionContract(args)).toEqual(result);
    expect(result.planner.template_hash).toBe(sha256(result.planner.template));
  });

  it('separately bounds physical workers including existing retries and receipt correction', () => {
    const forecast = fixture().projection.dispatch_bounds;
    expect(forecast.total).toBe(45);
    expect(forecast.total_semantics).toBe('logical-ticket-upper-bound');
    expect(forecast.logical_ticket_upper_bound).toBe(45);
    expect(forecast.protocol_replacement_ticket_upper_bound).toBe(14);
    expect(forecast.physical_dispatch_upper_bound).toBe(118);
    expect(forecast.receipt_validation_submission_upper_bound).toBe(354);
    expect(forecast.physical_by_stage['test-reconcile']).toBe(2);
    expect(forecast.physical_by_stage['test-recheck']).toBe(2);
    expect(forecast.physical_by_stage['plan-replan']).toBe(8);
  });

  it('publishes runtime artifact producers and consumers through gates and conditional shipping', () => {
    const result = compileRunAdmissionContract(fixture());
    expect(result.valid).toBe(true);
    expect(result.runtime_stages.map((entry) => entry.id)).toEqual(expect.arrayContaining([
      'runtime:approve-plan', 'runtime:merge-gates', 'runtime:shipping',
    ]));
    expect(result.artifact_edges.map((entry) => entry.artifact)).toEqual(expect.arrayContaining([
      'preflight-artifact', 'candidate-plan', 'approved-plan', 'red-evidence:test',
      'test-contradiction', 'reconciliation-verdict', 'review-findings', 'gate-results',
    ]));
  });

  it.each(['preflight', 'plan', 'test', 'plan-check', 'review', 'test-reconcile'])(
    'refuses an actual projection missing the reachable %s producer', (id) => {
      const args = fixture();
      args.projection = structuredClone(args.projection);
      args.projection.stages = args.projection.stages.filter((entry) => entry.id !== id);
      const result = compileRunAdmissionContract(args);
      expect(result.valid).toBe(false);
      expect(result.blocking).toContainEqual(expect.objectContaining({ code: 'pipeline-stage-missing', stage_id: id }));
    },
  );

  it('refuses malformed producer schemas and missing runtime gate producers', () => {
    const args = fixture();
    args.projection = structuredClone(args.projection);
    args.projection.stages.find((entry) => entry.id === 'preflight').output_schema = { type: 'string' };
    args.projection.runtime_stages = args.projection.runtime_stages.filter((entry) => entry.id !== 'runtime:merge-gates');
    const result = compileRunAdmissionContract(args);
    expect(result.valid).toBe(false);
    expect(result.blocking).toContainEqual(expect.objectContaining({ code: 'pipeline-producer-schema-invalid', stage_id: 'preflight' }));
    expect(result.blocking).toContainEqual(expect.objectContaining({ code: 'pipeline-runtime-stage-missing', stage_id: 'runtime:merge-gates' }));
  });

  it('rejects altered artifact schemas and forecasts rather than certifying their producers', () => {
    const args = fixture();
    args.projection = structuredClone(args.projection);
    args.projection.artifact_edges.find((edge) => edge.artifact === 'preflight-artifact').schema = 'incompatible-v99';
    args.projection.dispatch_bounds.total = 1;
    const result = compileRunAdmissionContract(args);
    expect(result.valid).toBe(false);
    expect(result.blocking).toContainEqual({ code: 'pipeline-artifact-contract-mismatch', artifact: 'preflight-artifact' });
    expect(result.blocking).toContainEqual({ code: 'pipeline-forecast-mismatch' });
  });

  it('binds exact branch-sensitive review checks and rejects tampered variants', () => {
    const args = fixture({ lane: 'fast' });
    const review = args.projection.stages.find((entry) => entry.id === 'review');
    expect(review.required_checks).toEqual(['targeted-tests']);
    expect(review.required_check_variants).toEqual([[], ['targeted-tests']]);
    expect(compileRunAdmissionContract(args).valid).toBe(true);
    args.projection = structuredClone(args.projection);
    args.projection.stages.find((entry) => entry.id === 'review').required_check_variants = [[]];
    expect(compileRunAdmissionContract(args).blocking).toContainEqual({
      code: 'pipeline-stage-contract-mismatch', stage_id: 'review', field: 'required_check_variants',
    });
  });

  it('uses the actual green evidence contract and does not add red evidence or writers to read-only modes', () => {
    const green = compileRunAdmissionContract(fixture({ test_intent: 'green-maintenance', claimed_paths: [] }));
    expect(green.valid).toBe(true);
    expect(green.artifact_edges.some((edge) => edge.artifact === 'green-evidence:test')).toBe(true);
    expect(green.artifact_edges.some((edge) => edge.artifact.startsWith('red-evidence:'))).toBe(false);
    for (const mode of ['land', 'debug', 'spike']) {
      const result = compileRunAdmissionContract(fixture({ mode, claimed_paths: [], test_paths: [] }));
      expect(result.valid).toBe(true);
      expect(result.artifact_edges.some((edge) => /^(red|green)-evidence:/.test(edge.artifact))).toBe(false);
      if (mode !== 'land') expect(result.runtime_stages).toEqual([]);
    }
  });

  it('decomposes seventeen exact paths into consumer-valid bounded workstreams', () => {
    const args = fixture({ claimed_paths: Array.from({ length: 17 }, (_, i) => `src/file-${i}.js`), test_paths: [] });
    const result = compileRunAdmissionContract(args);
    expect(result.valid).toBe(true);
    expect(result.planner.template.workstreams.map((entry) => entry.paths.length)).toEqual([16, 1]);
    const accepted = candidatePlanForScope(result.planner.template, args.input.claimed_paths, null, {
      preflight_hash: result.planner.template.preflight_hash,
      verification_profiles: [], risk_triggers: [], require_design_assurance: true,
      plannable_evidence_commands: args.planning_commands,
    });
    expect(accepted.valid).toBe(true);
    expect(result.planner.authority).toBe('template-only');
    expect(result.planner.preflight_hash_required).toBe(true);
    expect(Buffer.byteLength(canonicalJson(result.planner.template))).toBeLessThanOrEqual(PLAN_CONTRACT_LIMITS.candidate_plan_utf8_bytes);
  });

  it('includes complete risk-assurance and required-profile shapes without inventing commands', () => {
    const args = fixture();
    args.classification.risk_triggers = ['security', 'concurrency'];
    args.config.verification.profiles = [{ id: 'unit', command: 'npm test', description: 'Unit suite', timeout_ms: 1000 }];
    args.input.required_capabilities = [{ kind: 'verification_profile', id: 'unit' }];
    const result = compileRunAdmissionContract(args);
    const template = result.planner.template;
    expect(template.assurances.map((entry) => entry.risk_trigger)).toEqual(['security', 'concurrency']);
    expect(template.workstreams[0].verification_profiles).toEqual(['unit']);
    expect(candidatePlanForScope(template, [...args.input.claimed_paths, ...args.input.test_paths], null, {
      preflight_hash: template.preflight_hash,
      verification_profiles: [{ id: 'unit', required: true }],
      risk_triggers: args.classification.risk_triggers, require_design_assurance: true,
      plannable_evidence_commands: args.planning_commands,
    }).valid).toBe(true);
  });

  it('reports decomposition before allocating an impossible candidate and never truncates requirements', () => {
    const args = fixture({ requirements: Array.from({ length: 33 }, (_, i) => `requirement-${i}`) });
    const result = compileRunAdmissionContract(args);
    expect(result.valid).toBe(false);
    expect(result.blocking).toContainEqual(expect.objectContaining({
      code: 'planner-decomposition-required', field: 'requirements', provided: 33, limit: 32,
    }));
    expect(result.planner).not.toHaveProperty('template');
    expect(args.input.requirements).toHaveLength(33);
  });

  it('does not claim a representable plan when no exact evidence command exists', () => {
    const args = fixture();
    args.planning_commands = [];
    const result = compileRunAdmissionContract(args);
    expect(result.valid).toBe(false);
    expect(result.blocking).toContainEqual({ code: 'planner-evidence-command-unavailable' });
    expect(result.planner).not.toHaveProperty('template');
  });

  it('discloses concrete path resolution without rejecting broad approved scope', () => {
    for (const claim of ['.', 'src', 'src/**']) {
      const result = compileRunAdmissionContract(fixture({ claimed_paths: [claim], test_paths: [] }));
      expect(result.valid).toBe(true);
      expect(result.planner.concrete_path_resolution_needed).toBe(true);
      if (claim === '.') {
        expect(result.planner.representable).toBeNull();
        expect(result.planner).not.toHaveProperty('template');
      }
    }
  });

  it('rejects a provably oversized template instead of silently dropping scope', () => {
    const paths = Array.from({ length: 40 }, (_, index) => `src/${'x'.repeat(480)}-${index}.js`);
    const result = compileRunAdmissionContract(fixture({ claimed_paths: paths, test_paths: [] }));
    expect(result.valid).toBe(false);
    expect(result.blocking).toContainEqual(expect.objectContaining({
      code: 'planner-decomposition-required', field: 'candidate_plan_utf8_bytes', limit: 16384,
    }));
    expect(result.planner).not.toHaveProperty('template');
  });

  it('does not add planning or writable authority to ordinary land and read-only investigations', () => {
    for (const mode of ['land', 'debug', 'spike']) {
      const args = fixture({ mode, claimed_paths: [], test_paths: [] });
      args.planning_commands = [];
      const result = compileRunAdmissionContract(args);
      expect(result.valid).toBe(true);
      expect(result.planner).toMatchObject({ applicable: false });
      expect(result.reachable_roles).not.toContain('implementer');
      expect(result.reachable_roles).not.toContain('test_writer');
    }
  });
});
