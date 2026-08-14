import { describe, expect, it } from 'vitest';
import { initialStages } from '../lib/runtime/pipeline.js';
import { candidatePlanForScope } from '../lib/runtime/plan-contract.js';
import { canonicalJson, sha256 } from '../lib/runtime/canonical.js';

const legacyPlan = {
  version: 1,
  requirements: [{ id: 'R1', requirement: 'Keep legacy behavior', workstreams: ['W1'] }],
  workstreams: [{
    id: 'W1', outcome: 'Legacy callers remain stable',
    paths: [{ path: 'src/value.js', action: 'modify' }],
    steps: ['Change the value'], acceptance: ['The legacy assertion passes'], evidence_commands: ['npm test'],
  }],
  risks: [], non_goals: [],
};

function run(overrides = {}) {
  return {
    mode: 'phase', lane: 'full', behavioral: true,
    claimed_paths: ['src/value.js'], test_paths: [],
    ...overrides,
  };
}

describe('preflight legacy compatibility', () => {
  it('keeps omitted and explicit v1 full runs on the historical planner-first path', () => {
    expect(initialStages(run())[0]).toMatchObject({ id: 'plan', role: 'planner' });
    expect(initialStages(run({ plan_contract_version: 1 }))[0]).toMatchObject({ id: 'plan', role: 'planner' });
    expect(initialStages(run({ plan_contract_version: 2 }))[0]).toMatchObject({ id: 'preflight', role: 'preflight_analyst' });
  });

  it('does not change v1 canonical bytes or hashes', () => {
    const before = canonicalJson(legacyPlan);
    const accepted = candidatePlanForScope(structuredClone(legacyPlan), ['src/value.js']);
    expect(accepted.valid).toBe(true);
    expect(canonicalJson(accepted.value.plan)).toBe(before);
    expect(accepted.value.plan_hash).toBe(sha256(legacyPlan));
    expect(accepted.value.plan).not.toHaveProperty('preflight_hash');
    expect(accepted.value.plan.workstreams[0]).not.toHaveProperty('verification_profiles');
  });
});

