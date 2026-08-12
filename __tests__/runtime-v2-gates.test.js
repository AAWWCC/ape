import { describe, expect, it } from 'vitest';
import { evaluateMergePrerequisites } from '../lib/runtime/gates.js';

const receipt = {
  receipt_hash: 'a',
  previous_receipt_hash: null,
  status: 'passed',
  agent: { role: 'implementer' },
  tests: [{ passed: true }],
};

const executedTargeted = {
  executed: true,
  passed: true,
  command: 'node run-targeted.js',
  result_hash: 'c'.repeat(64),
};

function input(overrides = {}) {
  return {
    receipts: [receipt],
    lane: 'fast',
    security_review_required: false,
    full_suite: { passed: true },
    unexpected_dirty: [],
    plugin_validation: { passed: true },
    tree_binding: { passed: true },
    targeted: executedTargeted,
    ...overrides,
  };
}

describe('APE v2 auto-merge prerequisites', () => {
  it('requires every independent gate', () => {
    expect(evaluateMergePrerequisites(input()).passed).toBe(true);
    expect(evaluateMergePrerequisites(input({ full_suite: { passed: false } })).passed).toBe(false);
    expect(evaluateMergePrerequisites(input({ unexpected_dirty: ['src/unclaimed.js'] })).passed).toBe(false);
    expect(evaluateMergePrerequisites(input({ plugin_validation: { passed: false } })).passed).toBe(false);
    expect(evaluateMergePrerequisites(input({ tree_binding: { passed: false } })).passed).toBe(false);
    expect(evaluateMergePrerequisites(input({
      targeted: { ...executedTargeted, passed: false },
    })).passed).toBe(false);
  });

  it('reports the tree-binding check independently', () => {
    const result = evaluateMergePrerequisites(input({
      tree_binding: { passed: false, attested_tree_sha: 'a'.repeat(40), merge_tree_sha: 'b'.repeat(40) },
    }));
    expect(result.passed).toBe(false);
    expect(result.checks.tree_binding.passed).toBe(false);
    expect(result.checks.full_suite.passed).toBe(true);
  });

  // F12 regression: agent-fabricated receipt.tests[] evidence with no runtime
  // execution must never satisfy the merge prerequisites on a behavioral lane.
  it('never passes a behavioral lane on unverified receipt-asserted test evidence', () => {
    for (const lane of ['fast', 'full']) {
      const fabricated = evaluateMergePrerequisites(input({ lane, targeted: null }));
      expect(fabricated.passed).toBe(false);
      expect(fabricated.checks.targeted_tests.passed).toBe(false);
      expect(fabricated.checks.targeted_tests.verified).toBe(false);
      expect(fabricated.checks.targeted_tests.reason).toMatch(/test_commands\.targeted/);
      // The fabricated assertions survive only as advisory provenance.
      expect(fabricated.checks.targeted_tests.advisory).toMatchObject({
        source: 'receipt.tests',
        receipts_with_passing_tests: 1,
      });

      const notExecuted = evaluateMergePrerequisites(input({
        lane,
        targeted: { executed: false, reason: 'no test runner detected for derived targeted execution; configure test_commands.targeted' },
      }));
      expect(notExecuted.passed).toBe(false);
      expect(notExecuted.checks.targeted_tests.reason).toMatch(/no test runner detected/);
    }
  });

  it('keeps the mechanical lane pass condition without targeted execution', () => {
    const result = evaluateMergePrerequisites(input({ lane: 'mechanical', targeted: null }));
    expect(result.checks.targeted_tests).toMatchObject({ passed: true, verified: false });
    expect(result.passed).toBe(true);
  });

  it('requires a passing security receipt only when the run policy requires the review (F18)', () => {
    expect(evaluateMergePrerequisites(input({ security_review_required: true })).passed).toBe(false);
    const security = {
      ...receipt,
      receipt_hash: 'b',
      previous_receipt_hash: 'a',
      agent: { role: 'security_reviewer' },
      tests: [],
    };
    expect(evaluateMergePrerequisites(input({
      security_review_required: true,
      receipts: [receipt, security],
    })).passed).toBe(true);
    // High-risk run whose persisted policy disabled the review: no security
    // receipt exists and none is required.
    const waived = evaluateMergePrerequisites(input({ security_review_required: false }));
    expect(waived.checks.conditional_audits).toEqual({ passed: true, required: false });
    expect(waived.passed).toBe(true);
  });
});
