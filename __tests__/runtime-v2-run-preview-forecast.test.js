import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile, readdir, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { classifyLane } from '../lib/runtime/lane-policy.js';
import {
  initialStages,
  nextStages,
  pendingSecurityReviewStages,
  // projectedPipeline does not exist yet — deterministic red.
  projectedPipeline,
} from '../lib/runtime/pipeline.js';
// previewRun does not exist yet — deterministic red.
import { previewRun } from '../lib/runtime/lifecycle-service.js';
import {
  MAX_STAGE_ATTEMPTS,
  MAX_REMEDIATION_CYCLES,
  ROLE_POLICIES,
  MODEL_TIERS,
} from '../lib/runtime/constants.js';
import { runtimePaths } from '../lib/runtime/paths.js';
import { atomicWriteJson } from '../lib/runtime/storage.js';

// ------------------------------------------------------------------
// Helpers
// ------------------------------------------------------------------

function git(cwd, ...args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

// A minimal git repository for previewRun tests. Shared across the suite
// because previewRun is read-only and must not mutate it.
let sharedProjectDir = null;

beforeAll(async () => {
  sharedProjectDir = await mkdtemp(path.join(tmpdir(), 'ape-preview-'));
  await mkdir(path.join(sharedProjectDir, 'src'));
  await mkdir(path.join(sharedProjectDir, 'tests'));
  await mkdir(path.join(sharedProjectDir, 'docs'));
  await writeFile(path.join(sharedProjectDir, 'src', 'value.js'), 'export const value = 1;\n');
  await writeFile(path.join(sharedProjectDir, 'tests', 'value.test.js'), 'throw new Error("red");\n');
  await writeFile(path.join(sharedProjectDir, 'docs', 'notes.md'), '# Notes\n');
  git(sharedProjectDir, 'init', '-q', '-b', 'main');
  git(sharedProjectDir, 'config', 'user.email', 'ape@example.test');
  git(sharedProjectDir, 'config', 'user.name', 'APE Test');
  git(sharedProjectDir, 'add', '.');
  git(sharedProjectDir, 'commit', '-qm', 'baseline');
  await atomicWriteJson(runtimePaths(sharedProjectDir).config, {
    shipping: { auto_merge: false, provider: 'github', required_remote_checks: false },
    test_commands: { full: 'node -e "process.exit(0)"', targeted: 'node -e "process.exit(0)"' },
  });
});

afterAll(async () => {
  if (sharedProjectDir) await rm(sharedProjectDir, { recursive: true, force: true });
});

// Run spec for projectedPipeline — mirrors the run-state shape that
// initialStages/nextStages consume. The projection function is pure and
// synchronous, so no I/O or project directory is needed.
function runSpec(overrides = {}) {
  return {
    mode: 'phase',
    lane: 'full',
    behavioral: true,
    high_risk: true,
    plan_contract_version: 2,
    policy: { high_risk_security_review: true },
    remediation_cycles: 0,
    test_paths: ['tests/a.test.js'],
    claimed_paths: ['src/a.js'],
    ...overrides,
  };
}

// Preview input matching RunStartInputSchema for previewRun tests.
function previewInput(overrides = {}) {
  return {
    objective: 'preview forecast test',
    mode: 'phase',
    lane: 'auto',
    host: 'claude',
    claimed_paths: ['src/value.js'],
    test_paths: ['tests/value.test.js'],
    requirements: [],
    risk_triggers: [],
    behavioral: true,
    hooks_trusted: true,
    subagents_available: true,
    explicit_invocation: true,
    ...overrides,
  };
}

// Helper: create an isolated project directory for a single test.
async function isolatedProject() {
  const dir = await mkdtemp(path.join(tmpdir(), 'ape-preview-iso-'));
  await mkdir(path.join(dir, 'src'));
  await mkdir(path.join(dir, 'tests'));
  await writeFile(path.join(dir, 'src', 'value.js'), 'export const value = 1;\n');
  await writeFile(path.join(dir, 'tests', 'value.test.js'), 'throw new Error("red");\n');
  git(dir, 'init', '-q', '-b', 'main');
  git(dir, 'config', 'user.email', 'ape@example.test');
  git(dir, 'config', 'user.name', 'APE Test');
  git(dir, 'add', '.');
  git(dir, 'commit', '-qm', 'baseline');
  await atomicWriteJson(runtimePaths(dir).config, {
    shipping: { auto_merge: false, provider: 'github', required_remote_checks: false },
    test_commands: { full: 'node -e "process.exit(0)"', targeted: 'node -e "process.exit(0)"' },
  });
  return dir;
}

// ==================================================================
// projectedPipeline: export and basic shape
// ==================================================================

describe('projectedPipeline export and shape', () => {
  it('is exported as a function from pipeline.js', () => {
    expect(typeof projectedPipeline).toBe('function');
  });

  it('returns a frozen object with stages, conditional_branches, and dispatch_bounds', () => {
    const result = projectedPipeline(runSpec());
    expect(result).toBeDefined();
    expect(Object.isFrozen(result)).toBe(true);
    expect(result).toHaveProperty('stages');
    expect(result).toHaveProperty('conditional_branches');
    expect(result).toHaveProperty('dispatch_bounds');
  });

  it('is pure: calling twice with identical input produces identical results', () => {
    const spec = runSpec();
    const first = projectedPipeline(spec);
    const second = projectedPipeline(spec);
    expect(first).toEqual(second);
  });
});

// ==================================================================
// projectedPipeline: stage graph for full+high_risk
// ==================================================================

describe('projectedPipeline stage graph (full+high_risk)', () => {
  it('includes all 13 reachable stages', () => {
    const result = projectedPipeline(runSpec());
    const stageIds = result.stages.map((s) => s.id);
    for (const expected of [
      'preflight', 'plan', 'plan-check', 'plan-critic', 'plan-judge',
      'test', 'build', 'review', 'security-review',
      'remediation-test', 'remediation-build',
      'remediation-review', 'remediation-security-review',
    ]) {
      expect(stageIds, `missing stage: ${expected}`).toContain(expected);
    }
  });

  it('assigns each stage a role from ROLE_POLICIES', () => {
    const result = projectedPipeline(runSpec());
    for (const stage of result.stages) {
      expect(ROLE_POLICIES, `unknown role ${stage.role} on stage ${stage.id}`)
        .toHaveProperty(stage.role);
    }
  });

  it('assigns each stage a model_tier from MODEL_TIERS', () => {
    const result = projectedPipeline(runSpec());
    for (const stage of result.stages) {
      expect(MODEL_TIERS, `invalid tier ${stage.model_tier} on stage ${stage.id}`)
        .toContain(stage.model_tier);
    }
  });

  it('does not include debug or spike stages for a phase-mode run', () => {
    const result = projectedPipeline(runSpec());
    const stageIds = result.stages.map((s) => s.id);
    expect(stageIds).not.toContain('debug');
    expect(stageIds).not.toContain('spike');
  });
});

// ==================================================================
// projectedPipeline: forecast bounds
// ==================================================================

describe('projectedPipeline forecast bounds', () => {
  it('full+high_risk worst-case total equals 26', () => {
    const result = projectedPipeline(runSpec());
    expect(result.dispatch_bounds.total).toBe(26);
  });

  it('each stage has max_dispatches equal to MAX_STAGE_ATTEMPTS', () => {
    const result = projectedPipeline(runSpec());
    for (const [stageId, count] of Object.entries(result.dispatch_bounds.by_stage)) {
      expect(count, `stage ${stageId}`).toBe(MAX_STAGE_ATTEMPTS);
    }
  });

  it('full+no_risk omits security-review stages and has a lower total', () => {
    const result = projectedPipeline(runSpec({ high_risk: false }));
    const stageIds = result.stages.map((s) => s.id);
    expect(stageIds).not.toContain('security-review');
    expect(stageIds).not.toContain('remediation-security-review');
    expect(result.dispatch_bounds.total).toBeLessThan(26);
  });

  it('mechanical lane total equals MAX_STAGE_ATTEMPTS', () => {
    const result = projectedPipeline(runSpec({
      lane: 'mechanical',
      behavioral: false,
      high_risk: false,
      plan_contract_version: undefined,
      claimed_paths: ['docs/guide.md'],
      test_paths: [],
    }));
    expect(result.dispatch_bounds.total).toBe(MAX_STAGE_ATTEMPTS);
  });

  it('debug mode total equals MAX_STAGE_ATTEMPTS', () => {
    const result = projectedPipeline(runSpec({
      mode: 'debug',
      lane: 'auto',
      high_risk: false,
      behavioral: false,
    }));
    expect(result.dispatch_bounds.total).toBe(MAX_STAGE_ATTEMPTS);
  });

  it('spike mode total equals MAX_STAGE_ATTEMPTS', () => {
    const result = projectedPipeline(runSpec({
      mode: 'spike',
      lane: 'auto',
      high_risk: false,
      behavioral: false,
    }));
    expect(result.dispatch_bounds.total).toBe(MAX_STAGE_ATTEMPTS);
  });

  it('fast lane total is strictly less than full lane total', () => {
    const fullResult = projectedPipeline(runSpec());
    const fastResult = projectedPipeline(runSpec({
      lane: 'fast',
      high_risk: false,
    }));
    expect(fastResult.dispatch_bounds.total).toBeLessThan(fullResult.dispatch_bounds.total);
    expect(fastResult.dispatch_bounds.total).toBeGreaterThan(MAX_STAGE_ATTEMPTS);
  });

  it('land mode total is bounded by the review group plus remediation', () => {
    const result = projectedPipeline(runSpec({
      mode: 'land',
      lane: 'full',
      high_risk: true,
    }));
    // Land has review + security-review + remediation stages at most.
    // Total must be less than the full building pipeline.
    expect(result.dispatch_bounds.total).toBeLessThan(26);
    expect(result.dispatch_bounds.total).toBeGreaterThanOrEqual(MAX_STAGE_ATTEMPTS * 2);
  });
});

// ==================================================================
// projectedPipeline: dispatch_bounds breakdown
// ==================================================================

describe('projectedPipeline dispatch_bounds breakdown', () => {
  it('by_stage sums to total', () => {
    const result = projectedPipeline(runSpec());
    const stageSum = Object.values(result.dispatch_bounds.by_stage)
      .reduce((sum, count) => sum + count, 0);
    expect(stageSum).toBe(result.dispatch_bounds.total);
  });

  it('by_role sums to total', () => {
    const result = projectedPipeline(runSpec());
    const roleSum = Object.values(result.dispatch_bounds.by_role)
      .reduce((sum, count) => sum + count, 0);
    expect(roleSum).toBe(result.dispatch_bounds.total);
  });

  it('by_model_tier sums to total', () => {
    const result = projectedPipeline(runSpec());
    const tierSum = Object.values(result.dispatch_bounds.by_model_tier)
      .reduce((sum, count) => sum + count, 0);
    expect(tierSum).toBe(result.dispatch_bounds.total);
  });

  it('includes all expected roles for full+high_risk', () => {
    const result = projectedPipeline(runSpec());
    const roles = Object.keys(result.dispatch_bounds.by_role);
    for (const expected of [
      'preflight_analyst', 'planner', 'plan_checker', 'plan_critic',
      'plan_judge', 'test_writer', 'implementer', 'reviewer', 'security_reviewer',
    ]) {
      expect(roles, `missing role: ${expected}`).toContain(expected);
    }
  });

  it('includes all three model tiers for full+high_risk', () => {
    const result = projectedPipeline(runSpec());
    const tiers = Object.keys(result.dispatch_bounds.by_model_tier);
    for (const tier of ['fast', 'balanced', 'deep']) {
      expect(tiers, `missing tier: ${tier}`).toContain(tier);
    }
  });
});

// ==================================================================
// projectedPipeline: conditional branches
// ==================================================================

describe('projectedPipeline conditional branches', () => {
  it('labels security-review as conditional for high_risk runs', () => {
    const result = projectedPipeline(runSpec());
    const labels = result.conditional_branches.map((b) =>
      typeof b === 'string' ? b : b.label ?? b.id ?? String(b));
    expect(labels.some((l) => /security/i.test(l))).toBe(true);
  });

  it('labels plan-judge escalation as conditional for full lane', () => {
    const result = projectedPipeline(runSpec());
    const labels = result.conditional_branches.map((b) =>
      typeof b === 'string' ? b : b.label ?? b.id ?? String(b));
    expect(labels.some((l) => /plan/i.test(l))).toBe(true);
  });

  it('labels remediation routing as conditional', () => {
    const result = projectedPipeline(runSpec());
    const labels = result.conditional_branches.map((b) =>
      typeof b === 'string' ? b : b.label ?? b.id ?? String(b));
    expect(labels.some((l) => /remediation/i.test(l))).toBe(true);
  });

  it('omits plan-judge branch for non-full lanes', () => {
    const result = projectedPipeline(runSpec({ lane: 'fast', high_risk: false }));
    const labels = result.conditional_branches.map((b) =>
      typeof b === 'string' ? b : b.label ?? b.id ?? String(b));
    expect(labels.some((l) => /plan.?judge/i.test(l))).toBe(false);
  });

  it('omits security-review branch for non-high-risk runs', () => {
    const result = projectedPipeline(runSpec({ high_risk: false }));
    const labels = result.conditional_branches.map((b) =>
      typeof b === 'string' ? b : b.label ?? b.id ?? String(b));
    expect(labels.some((l) => /security/i.test(l))).toBe(false);
  });
});

// ==================================================================
// previewRun: export and basic shape
// ==================================================================

describe('previewRun export', () => {
  it('is exported as a function', () => {
    expect(typeof previewRun).toBe('function');
  });
});

describe('previewRun blueprint shape', () => {
  it('returns ok:true with advisory:true', async () => {
    const result = await previewRun(sharedProjectDir, previewInput());
    expect(result.ok).toBe(true);
    expect(result.advisory).toBe(true);
  });

  it('returns a blueprint with readiness, lane, lane_reasons, stages, and dispatch_bounds', async () => {
    const result = await previewRun(sharedProjectDir, previewInput());
    const bp = result.blueprint;
    expect(bp).toHaveProperty('readiness');
    expect(bp).toHaveProperty('lane');
    expect(bp).toHaveProperty('lane_reasons');
    expect(bp).toHaveProperty('stages');
    expect(bp).toHaveProperty('dispatch_bounds');
  });

  it('returns doctor-backed readiness with a healthy flag', async () => {
    const result = await previewRun(sharedProjectDir, previewInput());
    expect(result.blueprint.readiness).toBeDefined();
    expect(result.blueprint.readiness).toHaveProperty('healthy');
  });

  it('returns verification gates', async () => {
    const result = await previewRun(sharedProjectDir, previewInput());
    expect(result.blueprint).toHaveProperty('verification_gates');
  });

  it('returns conditional branches as an array', async () => {
    const result = await previewRun(sharedProjectDir, previewInput());
    expect(result.blueprint).toHaveProperty('conditional_branches');
    expect(Array.isArray(result.blueprint.conditional_branches)).toBe(true);
  });
});

// ==================================================================
// previewRun: advisory enforcement (no enforcement fields)
// ==================================================================

describe('previewRun advisory enforcement', () => {
  it('does not return token, dollar, or elapsed-time enforcement fields', async () => {
    const result = await previewRun(sharedProjectDir, previewInput());
    expect(result).not.toHaveProperty('token_budget');
    expect(result).not.toHaveProperty('cost_budget');
    expect(result).not.toHaveProperty('time_budget');
    expect(result).not.toHaveProperty('enforcement');
    if (result.blueprint) {
      expect(result.blueprint).not.toHaveProperty('token_budget');
      expect(result.blueprint).not.toHaveProperty('cost_budget');
      expect(result.blueprint).not.toHaveProperty('time_budget');
      expect(result.blueprint).not.toHaveProperty('enforcement');
    }
  });

  it('sets advisory:true at the top level', async () => {
    const result = await previewRun(sharedProjectDir, previewInput());
    expect(result.advisory).toBe(true);
  });
});

// ==================================================================
// previewRun: read-only enforcement
// ==================================================================

describe('previewRun read-only enforcement', () => {
  it('does not create state files beyond config.json', async () => {
    const dir = await isolatedProject();
    try {
      const runtimeDir = runtimePaths(dir).runtime;
      const beforeEntries = await readdir(runtimeDir).catch(() => []);

      await previewRun(dir, previewInput());

      const afterEntries = await readdir(runtimeDir).catch(() => []);
      const newEntries = afterEntries.filter((e) => !beforeEntries.includes(e));
      // config.json is pre-existing from setup; nothing else should appear.
      expect(newEntries).toEqual([]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('does not create any git branch', async () => {
    const dir = await isolatedProject();
    try {
      const branchesBefore = git(dir, 'branch', '--list')
        .split('\n').map((l) => l.replace(/^[*+]?\s*/, '').trim()).filter(Boolean).sort();

      await previewRun(dir, previewInput());

      const branchesAfter = git(dir, 'branch', '--list')
        .split('\n').map((l) => l.replace(/^[*+]?\s*/, '').trim()).filter(Boolean).sort();
      expect(branchesAfter).toEqual(branchesBefore);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('does not leave a run lock', async () => {
    const dir = await isolatedProject();
    try {
      const lockPath = runtimePaths(dir).lock;

      await previewRun(dir, previewInput());

      const lockExists = await stat(lockPath).then(() => true, () => false);
      expect(lockExists).toBe(false);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

// ==================================================================
// classifyLane identity: preview classification matches direct
// ==================================================================

// 32 input combinations covering all lane/behavioral/scope/risk dimensions.
// For each, classifyLane is called directly and compared with the lane and
// lane_reasons from previewRun's blueprint. Since previewRun does not exist
// yet, every test in this section fails deterministically.
const IDENTITY_INPUTS = [
  // auto lane: bounded behavioral scope -> fast
  { requested_lane: 'auto', behavioral: true, claimed_paths: ['src/a.js'], risk_triggers: [] },
  { requested_lane: 'auto', behavioral: true, claimed_paths: ['src/a.js', 'src/b.js'], risk_triggers: [] },
  { requested_lane: 'auto', behavioral: true, claimed_paths: ['src/a.js', 'src/b.js', 'src/c.js'], risk_triggers: [] },
  // auto lane: unbounded scope -> full
  { requested_lane: 'auto', behavioral: true, claimed_paths: [], risk_triggers: [] },
  // auto lane: over-limit scope -> full
  { requested_lane: 'auto', behavioral: true, claimed_paths: Array.from({ length: 7 }, (_, i) => `src/${i}.js`), risk_triggers: [] },
  // auto lane: docs/config -> mechanical
  { requested_lane: 'auto', behavioral: false, claimed_paths: ['docs/guide.md'], risk_triggers: [] },
  { requested_lane: 'auto', behavioral: false, claimed_paths: ['README.md', 'CHANGELOG.md'], risk_triggers: [] },
  { requested_lane: 'auto', behavioral: false, claimed_paths: ['.editorconfig'], risk_triggers: [] },
  // auto lane: generated/dist/vendor -> mechanical
  { requested_lane: 'auto', behavioral: false, claimed_paths: ['dist/bundle.js'], risk_triggers: [] },
  { requested_lane: 'auto', behavioral: false, claimed_paths: ['vendor/lib.js'], risk_triggers: [] },
  // auto lane: data in data dir -> mechanical
  { requested_lane: 'auto', behavioral: false, claimed_paths: ['benchmarks/data.json'], risk_triggers: [] },
  // auto lane: risk triggers -> full
  { requested_lane: 'auto', behavioral: true, claimed_paths: ['src/a.js'], risk_triggers: ['security'] },
  { requested_lane: 'auto', behavioral: true, claimed_paths: ['src/a.js'], risk_triggers: ['migration'] },
  { requested_lane: 'auto', behavioral: true, claimed_paths: ['src/a.js'], risk_triggers: ['security', 'migration'] },
  // auto lane: mechanical scope WITH declared triggers
  { requested_lane: 'auto', behavioral: false, claimed_paths: ['docs/guide.md'], risk_triggers: ['security'] },
  // fast lane: inside bounds
  { requested_lane: 'fast', behavioral: true, claimed_paths: ['src/a.js'], risk_triggers: [] },
  { requested_lane: 'fast', behavioral: true, claimed_paths: ['src/a.js', 'src/b.js'], risk_triggers: [] },
  // fast lane: over limit -> escalated to full
  { requested_lane: 'fast', behavioral: true, claimed_paths: Array.from({ length: 7 }, (_, i) => `src/${i}.js`), risk_triggers: [] },
  // fast lane: unbounded -> escalated to full
  { requested_lane: 'fast', behavioral: true, claimed_paths: [], risk_triggers: [] },
  // fast lane: risk trigger -> escalated to full
  { requested_lane: 'fast', behavioral: true, claimed_paths: ['src/a.js'], risk_triggers: ['security'] },
  // mechanical lane: valid docs -> mechanical
  { requested_lane: 'mechanical', behavioral: false, claimed_paths: ['docs/guide.md'], risk_triggers: [] },
  { requested_lane: 'mechanical', behavioral: false, claimed_paths: ['README.md', 'docs/a.md'], risk_triggers: [] },
  // mechanical lane: behavioral -> escalated to fast
  { requested_lane: 'mechanical', behavioral: true, claimed_paths: ['docs/guide.md'], risk_triggers: [] },
  // mechanical lane: non-mechanical scope -> escalated
  { requested_lane: 'mechanical', behavioral: false, claimed_paths: ['src/a.js'], risk_triggers: [] },
  // mechanical lane: unbounded scope -> escalated to full
  { requested_lane: 'mechanical', behavioral: false, claimed_paths: [], risk_triggers: [] },
  // mechanical lane: risk trigger -> escalated to full
  { requested_lane: 'mechanical', behavioral: false, claimed_paths: ['docs/guide.md'], risk_triggers: ['security'] },
  // full lane: always full regardless of scope
  { requested_lane: 'full', behavioral: true, claimed_paths: ['src/a.js'], risk_triggers: [] },
  { requested_lane: 'full', behavioral: true, claimed_paths: ['src/a.js'], risk_triggers: ['security'] },
  { requested_lane: 'full', behavioral: false, claimed_paths: ['docs/guide.md'], risk_triggers: [] },
  { requested_lane: 'full', behavioral: true, claimed_paths: [], risk_triggers: [] },
  // full lane: multiple risk triggers
  { requested_lane: 'full', behavioral: true, claimed_paths: ['src/a.js', 'src/b.js'], risk_triggers: ['security', 'authentication', 'migration'] },
  // edge: production source in a dist-like subdirectory (not truly dist)
  { requested_lane: 'auto', behavioral: true, claimed_paths: ['predist/x.js'], risk_triggers: [] },
];

describe('classifyLane identity: preview classification matches direct classification', () => {
  for (const [index, input] of IDENTITY_INPUTS.entries()) {
    const { requested_lane, behavioral, claimed_paths, risk_triggers } = input;
    const tag = `#${index + 1} lane=${requested_lane} behavioral=${behavioral} paths=${claimed_paths.length} triggers=${risk_triggers.length}`;

    it(`${tag}: previewRun lane matches classifyLane`, async () => {
      const directResult = classifyLane({
        requested_lane,
        behavioral,
        claimed_paths,
        risk_triggers,
      });

      // Construct a valid previewRun input. Behavioral fast/full lanes
      // require test_paths; mechanical can omit them.
      const needsTestPaths = behavioral && directResult.lane !== 'mechanical';
      const result = await previewRun(sharedProjectDir, previewInput({
        lane: requested_lane,
        behavioral,
        claimed_paths,
        risk_triggers,
        test_paths: needsTestPaths ? ['tests/value.test.js'] : [],
      }));

      expect(result.blueprint.lane).toBe(directResult.lane);
      expect(result.blueprint.lane_reasons).toEqual(directResult.reasons);
    });
  }
});
