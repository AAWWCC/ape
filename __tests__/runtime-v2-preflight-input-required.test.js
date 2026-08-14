import { describe, expect, it } from 'vitest';
import { reduceRun } from '../lib/runtime/scheduler.js';

const question = {
  id: 'public-api-name',
  question: 'Which existing export name must remain stable?',
  rationale: 'The answer changes compatibility and the test claim.',
};

function state(overrides = {}) {
  return {
    schema_version: '2.0.0', run_id: 'run-preflight-hold', status: 'running', stage: 'preflight',
    mode: 'phase', lane: 'full', behavioral: true, plan_contract_version: 2,
    tickets: [], receipts: [], expired_tickets: [],
    preflight: { version: 1, artifact_hash: 'a'.repeat(64), questions: [question] },
    ...overrides,
  };
}

describe('preflight input_required hold', () => {
  it('enters a durable input_required state before any writer is dispatched', () => {
    const actions = reduceRun(state(), {
      type: 'PREFLIGHT_RECORDED', preflight_hash: 'a'.repeat(64), questions: [question],
    });
    expect(actions).toContainEqual(expect.objectContaining({
      type: 'transition',
      patch: expect.objectContaining({
        status: 'input_required', stage: 'preflight',
        input_required: { preflight_hash: 'a'.repeat(64), questions: [question] },
      }),
    }));
    expect(actions).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'dispatch_agent', ticket: expect.objectContaining({ writable: true }) }),
    ]));
  });

  it('keeps question ids unique and stable across repeated reductions', () => {
    const held = state({ status: 'input_required', input_required: { preflight_hash: 'a'.repeat(64), questions: [question] } });
    const actions = reduceRun(held, { type: 'PREFLIGHT_RECORDED', preflight_hash: 'a'.repeat(64), questions: [question] });
    expect(actions).toEqual([]);
  });

  it('continues immediately when the artifact has no material questions', () => {
    const actions = reduceRun(state({ preflight: { version: 1, artifact_hash: 'a'.repeat(64), questions: [] } }), {
      type: 'PREFLIGHT_RECORDED', preflight_hash: 'a'.repeat(64), questions: [],
    });
    const transition = actions.find((entry) => entry.type === 'transition');
    expect(transition?.patch?.status ?? 'running').toBe('running');
    expect(transition?.patch ?? {}).not.toHaveProperty('input_required');
  });
});

