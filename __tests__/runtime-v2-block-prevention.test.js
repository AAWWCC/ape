import { describe, expect, it } from 'vitest';
import { evaluateRunReadiness } from '../lib/runtime/readiness.js';
import { DEFAULT_CONFIG } from '../lib/runtime/config.js';
import { pipelineRunSpec, projectedPipeline } from '../lib/runtime/pipeline.js';

function config() {
  const defaults = structuredClone(DEFAULT_CONFIG);
  return {
    ...defaults,
    policy: { ...defaults.policy, evidence_scripts: [], command_profiles: [] },
    verification: {
      profiles: [
        {
          id: 'unit',
          description: 'Unit verification',
          command: 'npm test',
          root: '.',
          timeout_ms: 30_000,
        },
        {
          id: 'security',
          description: 'Security verification',
          command: 'npm run security',
          root: '.',
          timeout_ms: 30_000,
        },
      ],
    },
    runners: [],
    test_commands: { targeted_template: 'npm test -- {paths}', full: 'npm test' },
  };
}

function readinessFor(input, riskTriggers = []) {
  const configured = config();
  const resolvedInput = {
    host: 'codex', mode: 'phase', lane: 'full', behavioral: false,
    capability_contract_required: true, run_command_profiles: [], required_capabilities: [], ...input,
  };
  const classification = { lane: 'full', risk_triggers: riskTriggers };
  return evaluateRunReadiness({
    input: resolvedInput,
    config: configured,
    classification,
    projection: projectedPipeline(pipelineRunSpec(resolvedInput, classification, configured)),
  });
}

describe('APE v2 deterministic complexity admission', () => {
  it('warns above score 48 without blocking valid work and preserves decomposition guidance', () => {
    const productionClaims = Array.from({ length: 10 }, (_, index) => `src/part-${index}.js`);
    const testPaths = Array.from({ length: 10 }, (_, index) => `tests/part-${index}.test.js`);
    const requirements = Array.from({ length: 5 }, (_, index) => `R${index + 1}`);
    const requiredCapabilities = ['unit', 'security'].map((id) => ({
      kind: 'verification_profile',
      id,
    }));
    const readiness = readinessFor({
      objective: 'Change several independently risky subsystems',
      claimed_paths: productionClaims,
      test_paths: testPaths,
      requirements,
      required_capabilities: requiredCapabilities,
    }, ['security', 'public-api', 'schema', 'concurrency']);

    expect(readiness.ready).toBe(true);
    expect(readiness.blocking).toEqual([]);
    expect(readiness.warnings).toContainEqual(expect.objectContaining({
      code: 'complexity-decomposition-recommended',
      complexity: {
        advisory: true,
        decomposition_recommended: true,
        production_claims: 10,
        test_paths: 10,
        requirements: 5,
        risk_triggers: 4,
        required_verification_profiles: 2,
        total_score: 50,
        score_threshold: 48,
        planning_input_byte_threshold: 8192,
        planning_input_bytes: expect.any(Number),
      },
      decomposition_contract: {
        required_fields: [
          'id',
          'objective',
          'acceptance',
          'claimed_paths',
          'test_paths',
          'requirements',
          'risk_triggers',
          'verification_profile_ids',
          'depends_on',
        ],
        constraints: [
          'acyclic-dependencies',
          'complete-requirement-and-scope-coverage',
          'non-overlapping-writable-ownership',
          'shared-compatibility-and-rollback',
          'each-slice-passes-contract-admission',
        ],
      },
    }));
    expect(readiness).not.toHaveProperty('dispatch');
    expect(readiness).not.toHaveProperty('ticket');
  });

  it('admits a bounded single-subsystem run below both policy thresholds', () => {
    const readiness = readinessFor({
      objective: 'Change one focused value',
      claimed_paths: ['src/value.js'],
      test_paths: ['tests/value.test.js'],
      requirements: ['R1'],
    }, ['public-api']);

    expect(readiness.blocking.find((entry) =>
      entry.code === 'complexity-decomposition-required')).toBeUndefined();
    expect(readiness.complexity_admission).toMatchObject({
      admitted: true,
      total_score: 8,
      score_threshold: 48,
      planning_input_byte_threshold: 8192,
    });
  });

  it('does not treat free-form objective prose as decomposable structural complexity', () => {
    const readiness = readinessFor({
      objective: `Focused change ${'é'.repeat(4_200)}`,
      claimed_paths: ['src/value.js'],
      test_paths: ['tests/value.test.js'],
      requirements: ['R1'],
      plan_contract_version: 1,
    });
    expect(readiness.complexity_admission).toMatchObject({
      admitted: true,
      total_score: 4,
      score_threshold: 48,
      planning_input_byte_threshold: 8192,
    });
  });

  it('warns about aggregate planning bytes without reinstating the retired path-byte blocker', () => {
    const longPath = (kind, index) =>
      `${kind}/${Array.from({ length: 48 }, () => `segment-${index}`).join('/')}.js`;
    const readiness = readinessFor({
      objective: 'Focused change with a verbose but independently sliceable scope',
      claimed_paths: Array.from({ length: 10 }, (_, index) => longPath('src', index)),
      test_paths: Array.from({ length: 10 }, (_, index) => longPath('tests', index)),
      requirements: [],
      plan_contract_version: 1,
    });
    const blocker = readiness.warnings.find((entry) =>
      entry.code === 'complexity-decomposition-recommended');
    expect(readiness.blocking.some((entry) => entry.code === 'capability-test-path-bytes-over-limit')).toBe(false);
    expect(readiness.admission_contract.capability_manifest_checks).toMatchObject({ concrete_initial_and_mutation_checks: true });

    expect(blocker).toMatchObject({
      complexity: {
        total_score: 20,
        score_threshold: 48,
        planning_input_byte_threshold: 8192,
      },
    });
    expect(blocker.complexity.planning_input_bytes).toBeGreaterThan(8192);
  });

  it('warns at the first point above the score boundary without creating a blocker', () => {
    const atBoundary = readinessFor({
      objective: 'Exactly bounded work',
      claimed_paths: Array.from({ length: 16 }, (_, index) => `src/${index}.js`),
      test_paths: Array.from({ length: 16 }, (_, index) => `tests/${index}.test.js`),
      requirements: ['R1', 'R2', 'R3', 'R4'],
    }, ['security', 'schema']);
    expect(atBoundary.complexity_admission).toMatchObject({
      admitted: true,
      total_score: 48,
      score_threshold: 48,
    });

    const aboveBoundary = readinessFor({
      objective: 'One point too broad',
      claimed_paths: Array.from({ length: 17 }, (_, index) => `src/${index}.js`),
      test_paths: Array.from({ length: 16 }, (_, index) => `tests/${index}.test.js`),
      requirements: ['R1', 'R2', 'R3', 'R4'],
    }, ['security', 'schema']);
    expect(aboveBoundary.blocking).toEqual([]);
    expect(aboveBoundary.warnings).toContainEqual(expect.objectContaining({
      code: 'complexity-decomposition-recommended',
      complexity: expect.objectContaining({ total_score: 49 }),
    }));
  });

  it('is order-independent and does not charge duplicate scope or risk identities twice', () => {
    const input = {
      objective: 'Canonical complexity input',
      claimed_paths: ['src/b.js', 'src/a.js', 'src/a.js'],
      test_paths: ['tests/b.test.js', 'tests/a.test.js', 'tests/a.test.js'],
      requirements: ['R2', 'R1', 'R1'],
      required_capabilities: [
        { kind: 'verification_profile', id: 'security' },
        { kind: 'verification_profile', id: 'unit' },
        { kind: 'verification_profile', id: 'unit' },
      ],
    };
    const first = readinessFor(input, ['schema', 'security', 'schema']);
    const second = readinessFor({
      ...input,
      claimed_paths: [...input.claimed_paths].reverse(),
      test_paths: [...input.test_paths].reverse(),
      requirements: [...input.requirements].reverse(),
      required_capabilities: [...input.required_capabilities].reverse(),
    }, ['security', 'schema']);

    expect(first.complexity_admission).toEqual(second.complexity_admission);
    expect(first.complexity_admission).toMatchObject({
      production_claims: 2,
      test_paths: 2,
      requirements: 2,
      risk_triggers: 2,
      required_verification_profiles: 2,
      total_score: 20,
    });
  });
});
