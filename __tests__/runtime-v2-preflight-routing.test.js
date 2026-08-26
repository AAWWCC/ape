import { describe, expect, it } from 'vitest';
import { initialStages, nextStages } from '../lib/runtime/pipeline.js';

function run(overrides = {}) {
  return {
    mode: 'phase', lane: 'full', behavioral: true,
    claimed_paths: ['src/value.js'], test_paths: ['tests/value.test.js'],
    plan_contract_version: 2,
    policy: { high_risk_security_review: true },
    ...overrides,
  };
}

describe('structured preflight routing', () => {
  it('places a balanced read-only analyst before full planning', () => {
    expect(initialStages(run())).toEqual([
      expect.objectContaining({ id: 'preflight', role: 'preflight_analyst', model_tier: 'balanced', writable: false }),
    ]);
    expect(nextStages(run(), 'preflight', { status: 'passed', evidence: {} }))
      .toEqual([expect.objectContaining({ id: 'plan', role: 'planner', writable: false })]);
  });

  it('places preflight before behavioral fast work and can escalate it to full planning', () => {
    const fast = run({ lane: 'fast' });
    expect(initialStages(fast)).toEqual([expect.objectContaining({ id: 'preflight', role: 'preflight_analyst' })]);
    expect(nextStages(fast, 'preflight', { status: 'passed', evidence: {} }))
      .toEqual([expect.objectContaining({ id: 'test', role: 'test_writer' })]);

    const escalated = { ...fast, lane: 'full', preflight: { escalated_from: 'fast' } };
    expect(nextStages(escalated, 'preflight', { status: 'passed', evidence: {} }))
      .toEqual([expect.objectContaining({ id: 'plan', role: 'planner' })]);
  });

  it('does not add preflight to non-behavioral fast, mechanical, debug, spike, or land flows', () => {
    expect(initialStages(run({ lane: 'fast', behavioral: false }))[0].id).toBe('build');
    expect(initialStages(run({ lane: 'mechanical' }))[0].id).toBe('build');
    expect(initialStages(run({ mode: 'debug' }))[0].id).toBe('debug');
    expect(initialStages(run({ mode: 'spike' }))[0].id).toBe('spike');
    expect(initialStages(run({ mode: 'land' }))[0].id).toBe('review');
  });
});
