import { describe, expect, it } from 'vitest';
import { classifyLane } from '../lib/runtime/lane-policy.js';
import { docsOnlyMechanical, initialStages, nextStages } from '../lib/runtime/pipeline.js';
import { reduceRun } from '../lib/runtime/scheduler.js';
import { RunStartInputSchema } from '../lib/runtime/schemas.js';

// F43: the public lane surface accepts every runtime lane and a requested
// fast/mechanical lane is validated — honored inside its bounds, escalated
// with an explicit reason outside them, never silently ignored.
// F23/F8: SCOPE_EXPANDED is a real reducer transition that raises the lane and
// arms the security machinery (high_risk + accumulated risk_triggers).
// F18: security-review issuance honors the run's persisted policy snapshot.

function startInput(overrides = {}) {
  return {
    objective: 'Exercise the lane surface',
    mode: 'phase',
    host: 'codex',
    hooks_trusted: true,
    subagents_available: true,
    explicit_invocation: true,
    ...overrides,
  };
}

describe('run start lane surface (F43)', () => {
  it('accepts the full lane set including mechanical', () => {
    for (const lane of ['auto', 'mechanical', 'fast', 'full']) {
      expect(RunStartInputSchema.parse(startInput({ lane })).lane).toBe(lane);
    }
  });

  it('rejects unknown lanes', () => {
    expect(RunStartInputSchema.safeParse(startInput({ lane: 'turbo' })).success).toBe(false);
  });
});

describe('requested-lane validation (F43)', () => {
  it('honors a requested mechanical lane inside its bounds', () => {
    expect(classifyLane({
      requested_lane: 'mechanical',
      behavioral: false,
      claimed_paths: ['docs/guide.md', 'README.md'],
      risk_triggers: [],
    })).toEqual({ lane: 'mechanical', reasons: ['requested-mechanical'], risk_triggers: [] });
  });

  it('escalates a behavioral requested-mechanical run with an explicit reason', () => {
    const result = classifyLane({
      requested_lane: 'mechanical',
      behavioral: true,
      claimed_paths: ['docs/guide.md'],
      risk_triggers: [],
    });
    expect(result.lane).toBe('fast');
    expect(result.reasons).toContain('requested-mechanical-escalated');
    expect(result.reasons).toContain('behavioral-change');
  });

  it('escalates a requested mechanical lane with production scope', () => {
    const result = classifyLane({
      requested_lane: 'mechanical',
      behavioral: false,
      claimed_paths: ['src/value.js'],
      risk_triggers: [],
    });
    expect(result.lane).toBe('fast');
    expect(result.reasons).toContain('non-mechanical-scope');
  });

  it('escalates a risk-triggered requested mechanical lane straight to full', () => {
    const result = classifyLane({
      requested_lane: 'mechanical',
      behavioral: false,
      claimed_paths: ['docs/guide.md'],
      risk_triggers: ['security'],
    });
    expect(result.lane).toBe('full');
    expect(result.reasons).toEqual(
      expect.arrayContaining(['requested-mechanical-escalated', 'risk:security']),
    );
    expect(result.risk_triggers).toEqual(['security']);
  });

  // D3: operator-DECLARED risk triggers are never silently dropped. The auto
  // path used to return mechanical with risk_triggers hardcoded [], so the
  // security machinery (high_risk, security-review, conditional_audits) never
  // armed for a declared-risk docs/config scope. The lane stays mechanical —
  // full would newly demand test_paths a non-behavioral scope cannot supply —
  // but the triggers must ride through so the caller persists them.
  it('carries declared triggers on an auto-classified mechanical scope instead of dropping them', () => {
    expect(classifyLane({
      requested_lane: 'auto',
      behavioral: false,
      claimed_paths: ['docs/guide.md'],
      risk_triggers: ['security'],
    })).toEqual({
      lane: 'mechanical',
      reasons: ['non-behavioral-mechanical-scope', 'risk:security'],
      risk_triggers: ['security'],
    });
  });

  it('honors a requested fast lane inside its bounds', () => {
    expect(classifyLane({
      requested_lane: 'fast',
      behavioral: true,
      claimed_paths: ['src/a.js'],
      risk_triggers: [],
    })).toEqual({ lane: 'fast', reasons: ['requested-fast'], risk_triggers: [] });
  });

  it('escalates a requested fast lane that exceeds the configured file bound', () => {
    const result = classifyLane({
      requested_lane: 'fast',
      behavioral: true,
      claimed_paths: Array.from({ length: 7 }, (_, index) => `src/${index}.js`),
      risk_triggers: [],
    });
    expect(result.lane).toBe('full');
    expect(result.reasons).toEqual(
      expect.arrayContaining(['requested-fast-escalated', 'scope-over-6-files']),
    );
  });

  it('escalates an unbounded requested fast lane', () => {
    const result = classifyLane({
      requested_lane: 'fast',
      behavioral: true,
      claimed_paths: [],
      risk_triggers: [],
    });
    expect(result.lane).toBe('full');
    expect(result.reasons).toEqual(
      expect.arrayContaining(['requested-fast-escalated', 'unbounded-scope']),
    );
  });

  it('honors the configured fast_max_files for a requested fast lane', () => {
    expect(classifyLane({
      requested_lane: 'fast',
      behavioral: true,
      claimed_paths: Array.from({ length: 8 }, (_, index) => `src/${index}.js`),
      risk_triggers: [],
    }, { fast_max_files: 10 }).lane).toBe('fast');
  });
});

describe('SCOPE_EXPANDED reducer transition (F23/F8)', () => {
  function run(overrides = {}) {
    return {
      run_id: 'run-1',
      mode: 'phase',
      lane: 'fast',
      status: 'running',
      stage: 'test',
      lane_reasons: ['bounded-behavioral-scope'],
      lane_escalated: false,
      high_risk: false,
      risk_triggers: [],
      tickets: [],
      receipts: [],
      attempts: {},
      remediation_cycles: 0,
      ...overrides,
    };
  }

  it('raises the lane and arms high_risk with the reported triggers', () => {
    const actions = reduceRun(run(), {
      type: 'SCOPE_EXPANDED',
      scope: { lane: 'full', lane_reasons: ['risk:security'], risk_triggers: ['security'] },
    });
    expect(actions.map((action) => action.type)).toEqual(['transition', 'persist_state']);
    expect(actions[0].patch).toMatchObject({
      lane: 'full',
      lane_escalated: true,
      high_risk: true,
      risk_triggers: ['security'],
    });
    expect(actions[0].patch.lane_reasons).toContain('risk:security');
  });

  it('accumulates new triggers on an already-full high-risk run', () => {
    const actions = reduceRun(run({
      lane: 'full',
      high_risk: true,
      risk_triggers: ['security'],
    }), {
      type: 'SCOPE_EXPANDED',
      scope: { lane: 'full', lane_reasons: [], risk_triggers: ['migration'] },
    });
    expect(actions[0].type).toBe('transition');
    expect(actions[0].patch.risk_triggers).toEqual(['security', 'migration']);
    expect(actions[0].patch.lane).toBeUndefined();
  });

  it('is a persist-only no-op when nothing expanded', () => {
    const actions = reduceRun(run(), {
      type: 'SCOPE_EXPANDED',
      scope: { lane: 'fast', lane_reasons: [], risk_triggers: [] },
    });
    expect(actions.map((action) => action.type)).toEqual(['persist_state']);
  });

  // D3: a review-proposed scope expansion grows claimed_paths through the same
  // reduced transition, audited BEFORE the transition like every override.
  it('audits then patches claimed_paths for a scope expansion', () => {
    const actions = reduceRun(run({ claimed_paths: ['src/a.js'] }), {
      type: 'SCOPE_EXPANDED',
      scope: {
        lane: 'fast',
        lane_reasons: [],
        risk_triggers: [],
        claimed_paths: ['lib/b.js', 'lib/b.js', 'src/a.js'],
        reason: 'fix requires the helper module',
      },
    });
    expect(actions.map((action) => action.type)).toEqual([
      'audit_override',
      'transition',
      'persist_state',
    ]);
    expect(actions[0]).toMatchObject({
      operation: 'scope-expansion',
      reason: 'fix requires the helper module',
      added_paths: ['lib/b.js'],
    });
    expect(actions[1].patch.claimed_paths).toEqual(['src/a.js', 'lib/b.js']);
  });

  it('emits no audit and no patch when every proposed claim is already held', () => {
    const actions = reduceRun(run({ claimed_paths: ['src/a.js'] }), {
      type: 'SCOPE_EXPANDED',
      scope: {
        lane: 'fast',
        lane_reasons: [],
        risk_triggers: [],
        claimed_paths: ['src/a.js'],
        reason: 'duplicate proposal',
      },
    });
    expect(actions.map((action) => action.type)).toEqual(['persist_state']);
  });
});

describe('security-review policy snapshot (F18)', () => {
  const base = {
    mode: 'phase',
    lane: 'full',
    high_risk: true,
    remediation_cycles: 0,
  };

  it('issues security-review alongside review for a high-risk run by default', () => {
    expect(nextStages({ ...base }, 'build', {}).map((stage) => stage.id))
      .toEqual(['review', 'security-review']);
    expect(nextStages({ ...base, policy: { high_risk_security_review: true } }, 'build', {})
      .map((stage) => stage.id)).toEqual(['review', 'security-review']);
  });

  it('honors a run policy snapshot that disables the high-risk security review', () => {
    const run = { ...base, policy: { high_risk_security_review: false } };
    expect(nextStages(run, 'build', {}).map((stage) => stage.id)).toEqual(['review']);
    expect(nextStages(run, 'remediation-build', {}).map((stage) => stage.id))
      .toEqual(['remediation-review']);
  });
});

// A docs-only mechanical run has no runtime surface for targeted tests, and a
// required check that cannot be truthfully satisfied invites fabricated
// evidence (the friction report's collect-only pytest run attesting a markdown
// edit). The carve-out must stay narrow: any code claim, directory claim,
// behavioral intent, or test path keeps the check.
describe('docs-only mechanical carve-out', () => {
  const docsRun = (overrides = {}) => ({
    mode: 'phase',
    lane: 'mechanical',
    behavioral: false,
    claimed_paths: ['README.md', 'docs/guide.rst', 'NOTES.txt'],
    test_paths: [],
    remediation_cycles: 0,
    ...overrides,
  });

  it('issues the mechanical build stage without targeted-tests for a docs-only scope', () => {
    const [build] = initialStages(docsRun());
    expect(build.id).toBe('build');
    expect(build.required_checks).toEqual([]);
    expect(docsOnlyMechanical(docsRun())).toBe(true);
  });

  it('keeps targeted-tests when any claim is code', () => {
    const run = docsRun({ claimed_paths: ['README.md', 'src/index.js'] });
    expect(initialStages(run)[0].required_checks).toEqual(['targeted-tests']);
  });

  it('keeps targeted-tests for a directory claim, which could hold anything', () => {
    const run = docsRun({ claimed_paths: ['docs'] });
    expect(initialStages(run)[0].required_checks).toEqual(['targeted-tests']);
  });

  it('keeps targeted-tests when the run is behavioral or carries test paths', () => {
    expect(initialStages(docsRun({ behavioral: true }))[0].required_checks)
      .toEqual(['targeted-tests']);
    expect(initialStages(docsRun({ test_paths: ['__tests__/a.test.js'] }))[0].required_checks)
      .toEqual(['targeted-tests']);
  });

  it('keeps targeted-tests for an empty claim set (unbounded scope is not docs-only)', () => {
    expect(initialStages(docsRun({ claimed_paths: [] }))[0].required_checks)
      .toEqual(['targeted-tests']);
  });

  it('never relaxes non-mechanical lanes', () => {
    const run = docsRun({ lane: 'fast', test_paths: ['__tests__/a.test.js'] });
    expect(docsOnlyMechanical(run)).toBe(false);
    expect(initialStages(run)[0].required_checks).toEqual(['red-test']);
  });
});

// Regression: the generated/dist/build/vendor markers reached via classifyLane
// (internal isMechanicalPath) must anchor on whole PATH SEGMENTS, not raw
// substrings. Ordinary production source whose filename or a parent directory
// merely CONTAINS one of those substrings must escalate out of the mechanical
// lane — the mechanical lane has no independent test-writer stage or code-review
// group, so a false-positive there erodes the invariant-3 backstop. A genuine
// dist/build/vendor/generated directory (the marker as a leading segment) must
// still classify mechanical. Asserted only through the exported classifyLane;
// isMechanicalPath is internal and never referenced directly.
describe('mechanical-lane marker segment anchoring', () => {
  const laneFor = (path) =>
    classifyLane({
      requested_lane: 'auto',
      behavioral: false,
      claimed_paths: [path],
      risk_triggers: [],
    }).lane;

  // RED anchors: each production file only CONTAINS a marker substring
  // ('build/', 'generated', 'dist/') and today false-positives into the
  // mechanical lane under the unanchored includes() match. A segment-anchored
  // match must keep them out of the mechanical lane (they escalate instead).
  it('does not classify lookalike production source into the mechanical lane', () => {
    for (const path of [
      'packages/build/src/index.ts', // 'build' is a nested source dir, not a build-output root
      'src/schema-generated.ts', // 'generated' only inside the filename
      'predist/x.js', // 'dist' only inside the 'predist' segment
    ]) {
      expect(laneFor(path), path).not.toBe('mechanical');
    }
  });

  // GREEN under both the current and fixed code: a genuine generated/build/
  // dist/vendor directory (marker as the leading path segment) stays mechanical.
  it('still classifies a genuine generated/build/dist/vendor directory as mechanical', () => {
    for (const path of [
      'dist/bundle.js',
      'build/out.js',
      'vendor/lib.js',
      'generated/schema.js',
    ]) {
      expect(laneFor(path), path).toBe('mechanical');
    }
  });
});
