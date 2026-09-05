import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { recordReceipt } from '../lib/runtime/service.js';
import { seedLegacyRun as startRun } from './legacy-run-test-helper.js';

// These are historical receipt-time fallback/guard fixtures. Missing or
// unscopeable runners are refused before dispatch on new admitted runs;
// retained legacy runs must still execute the same fail-closed receipt checks.
import { runMergeGates } from '../lib/runtime/gates.js';
import { runtimePaths } from '../lib/runtime/paths.js';
import { atomicWriteJson } from '../lib/runtime/storage.js';
import { currentTreeSha } from '../lib/runtime/git.js';
import { sha256 } from '../lib/runtime/canonical.js';

// Roadmap entry red-admission-flake-screen (narrowed, language-agnostic form).
// Three-part public contract under test:
//   (i)  DOUBLE-RUN RED ADMISSION: the runtime executes the authored test paths
//        TWICE at red-test admission; admission requires BOTH invocations to
//        fail at the exit-code level. A divergent pair (fail-then-pass) is
//        REJECTED with a NEW refusal naming nondeterminism (/nondeterministic/),
//        distinct from the existing vacuous-red message ('runtime-executed
//        red-test passed: the red phase was not observed'). The sealed
//        evidence.red_test observation gains runs:[...] (2 entries, each with
//        command/exit_code/duration_ms) while keeping its existing top-level
//        fields. A timed-out/tooling-failed run is a per-run NO-VERDICT (the
//        existing /did not produce a test verdict/ refusal), never a flake
//        verdict — a deadline kill proves nothing about writer flakiness.
//   (ii) ORDER-SHUFFLE SEAM, CONFIG-ONLY: test_commands.targeted_shuffle_template
//        (null default) drives only the SECOND run when set; when unset the two
//        resolved run commands are byte-identical.
//   (iii) GATE-LEVEL FLAKE SIGNAL: a fresh PASSING full-suite merge-gate
//        evaluation whose suite cache holds a prior FAILED entry at the SAME
//        cacheKey (with verification tooling_failure!==true and timed_out!==true)
//        carries checks.full_suite.flake_signal:{prior_same_tree_failure:{...}};
//        the key is absent otherwise; the signal is advisory only, never a block.
//
// RED AT THE BASE TREE (the authored red anchors):
//   - anchor A: the nondeterministic first-fail/second-pass fixture is ADMITTED
//     today (the single admission run only ever sees the failing invocation).
//   - anchor B (+ its policy.full_suite_cache:false variant): no flake_signal
//     key exists anywhere in the gate result today.
//   - anchor C (run-B timeout arm): the fast-fail-then-hang fixture is ADMITTED
//     today (the second, hanging invocation never runs).
// GREEN GUARDS (green today and post-fix): deterministic red still admitted;
// seam-unset command equality (conditional on runs existing); no flake_signal
// without a prior genuine failure (including prior tooling-failure/timed-out
// entries, which are excluded by contract).

const PASS_CMD = 'node -e "process.exit(0)"';

const cleanups = [];
afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

function git(cwd, ...args) {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' },
  }).trim();
}

// An out-of-repo scratch directory for fixture marker files: the toggle state
// must live OUTSIDE the project so the runtime's tree-stability check at red
// admission stays clean across invocations.
async function outsideDir(prefix) {
  const dir = await mkdtemp(path.join(tmpdir(), prefix));
  cleanups.push(dir);
  return dir;
}

// ---------------------------------------------------------------------------
// Red-admission harness (prior art: runtime-v2-round3-red-test-admission).
// A scratch git project driven entirely through the public service surface:
// startRun issues the test_writer ticket with required_checks ['red-test'],
// recordReceipt triggers the runtime-owned red-test execution at admission.
// ---------------------------------------------------------------------------

async function redProject({ files = {}, config = {} } = {}) {
  const dir = await mkdtemp(path.join(tmpdir(), 'ape-flake-red-'));
  cleanups.push(dir);
  await mkdir(path.join(dir, 'src'));
  await mkdir(path.join(dir, 'tests'));
  await writeFile(path.join(dir, 'src', 'value.js'), 'export const value = 1;\n');
  await writeFile(path.join(dir, 'tests', 'value.test.js'), 'throw new Error("placeholder red");\n');
  for (const [file, content] of Object.entries(files)) {
    await writeFile(path.join(dir, file), content);
  }
  git(dir, 'init', '-q');
  git(dir, 'config', 'user.email', 'ape@example.test');
  git(dir, 'config', 'user.name', 'APE Test');
  git(dir, 'add', '.');
  git(dir, 'commit', '-qm', 'baseline');
  await atomicWriteJson(runtimePaths(dir).config, {
    shipping: { auto_merge: false, provider: 'github', required_remote_checks: false },
    test_commands: { full: 'node --test' },
    ...config,
  });
  return dir;
}

function startInput(overrides = {}) {
  return {
    objective: 'Exercise double-run red-test admission flake screening',
    mode: 'phase',
    lane: 'fast',
    host: 'codex',
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

function rawReceipt(ticket, overrides = {}) {
  return {
    ticket_id: ticket.ticket_id,
    status: 'passed',
    agent_identity: `agent-${ticket.role}`,
    tests: [{ command: 'self-reported', passed: false, exit_code: 1, duration_ms: 1 }],
    findings: [],
    evidence: { verdict: 'pass' },
    timing: {
      started_at: ticket.issued_at,
      completed_at: new Date(Date.parse(ticket.issued_at) + 10).toISOString(),
      duration_ms: 10,
    },
    ...overrides,
  };
}

// The nondeterministic authored test: red on the FIRST invocation only. The
// marker is an ABSOLUTE out-of-repo path baked into the source, so the toggle
// never perturbs the project tree sha. The scratch repo has no package.json,
// so the file runs as CommonJS under the derived `node --test` invocation.
function markerToggleTestSource(marker) {
  return [
    '// Nondeterministic on purpose: fails only while the out-of-repo marker is absent.',
    "const fs = typeof process.getBuiltinModule === 'function'",
    "  ? process.getBuiltinModule('node:fs')",
    "  : require('node:fs');",
    `const marker = ${JSON.stringify(marker)};`,
    'if (fs.existsSync(marker)) {',
    '  // second invocation: marker present -> no failing assertion, clean exit',
    '} else {',
    "  fs.writeFileSync(marker, 'seen\\n');",
    "  throw new Error('flaky red: fails only on the first invocation');",
    '}',
    '',
  ].join('\n');
}

// The run-B timeout arm fixture runner (driven via targeted_template): first
// invocation fails FAST (create marker, exit 1); second invocation outlives
// the lane deadline until the runtime kills it, trapping SIGTERM to exit
// nonzero — so a naive both-exit-codes-nonzero comparison would wrongly admit
// it, and only the per-run no-verdict (timed_out) guard refuses it honestly.
function hangToggleRunnerSource(marker) {
  return [
    "const fs = require('node:fs');",
    `const marker = ${JSON.stringify(marker)};`,
    'if (fs.existsSync(marker)) {',
    "  process.on('SIGTERM', () => process.exit(7));",
    '  setInterval(() => {}, 1000);',
    '} else {',
    "  fs.writeFileSync(marker, 'seen\\n');",
    '  process.exit(1);',
    '}',
    '',
  ].join('\n');
}

describe('double-run red-test admission flake screening (red-admission-flake-screen)', () => {
  it('green guard: a deterministically failing authored test is still admitted with a sealed observation', async () => {
    const dir = await redProject();
    const started = await startRun(dir, startInput());
    expect(started.ok).toBe(true);
    const ticket = started.run.tickets[0];
    expect(ticket.role).toBe('test_writer');
    expect(ticket.required_checks).toContain('red-test');

    await writeFile(path.join(dir, 'tests', 'value.test.js'), 'throw new Error("deterministic red");\n');
    const result = await recordReceipt(dir, rawReceipt(ticket));
    // Admission only (no regression): a red that fails on every invocation is
    // exactly what the red phase demands, before and after the double-run fix.
    expect(result.ok).toBe(true);
    const observation = result.receipt.evidence.red_test;
    expect(observation).toMatchObject({
      observed: true,
      passed: false,
      test_paths: ['tests/value.test.js'],
      tree_sha: result.receipt.head_tree_sha,
    });
    expect(observation.command).toMatch(/--test/);
    expect(observation.exit_code).not.toBe(0);
    expect(observation.result_hash).toMatch(/^[0-9a-f]{64}$/);
  }, 30_000);

  it('RED-AT-BASE anchor A: a first-fail/second-pass marker-toggle authored test is rejected naming nondeterminism', async () => {
    const outside = await outsideDir('ape-flake-marker-');
    const marker = path.join(outside, 'first-invocation.marker');
    const dir = await redProject();
    const started = await startRun(dir, startInput());
    expect(started.ok).toBe(true);
    const ticket = started.run.tickets[0];
    expect(ticket.required_checks).toContain('red-test');

    await writeFile(path.join(dir, 'tests', 'value.test.js'), markerToggleTestSource(marker));
    const result = await recordReceipt(dir, rawReceipt(ticket));
    // TODAY the single admission run sees only the first (failing) invocation
    // and ADMITS this flaky red — this assertion is the red anchor. Post-fix
    // the divergent pair (fail then pass at the exit-code level) must be
    // REJECTED with an actionable refusal that names nondeterminism, never
    // conflated with the vacuous-red (exit 0) message.
    expect(result).toMatchObject({ ok: false, rejected: true });
    const message = (result.errors ?? []).join(' ');
    expect(message).toMatch(/nondeterministic/);
    expect(message).not.toMatch(/red phase was not observed/);
  }, 30_000);

  it('green guard (seam unset): any observed runs pair resolves byte-identical commands', async () => {
    // No test_commands.targeted_shuffle_template configured: the seam's absence
    // must provably change nothing — both resolved run commands are identical.
    const dir = await redProject();
    const started = await startRun(dir, startInput());
    expect(started.ok).toBe(true);
    const ticket = started.run.tickets[0];

    await writeFile(path.join(dir, 'tests', 'value.test.js'), 'throw new Error("seam-unset deterministic red");\n');
    const result = await recordReceipt(dir, rawReceipt(ticket));
    expect(result.ok).toBe(true);
    const observation = result.receipt.evidence.red_test;
    expect(observation.observed).toBe(true);
    // Green today (no runs key yet) and pins the post-fix shape: exactly two
    // runs, each carrying command/exit_code/duration_ms, and — with the
    // shuffle seam unset — the two commands byte-identical. An admitted red
    // requires BOTH exit codes nonzero.
    if (observation.runs !== undefined) {
      expect(Array.isArray(observation.runs)).toBe(true);
      expect(observation.runs).toHaveLength(2);
      for (const run of observation.runs) {
        expect(typeof run.command).toBe('string');
        expect(run.command.length).toBeGreaterThan(0);
        expect(run.exit_code).not.toBe(0);
        expect(typeof run.duration_ms).toBe('number');
        expect(run.duration_ms).toBeGreaterThanOrEqual(0);
      }
      expect(observation.runs[0].command).toBe(observation.runs[1].command);
    }
  }, 30_000);

  it('RED-AT-BASE anchor C: a fast-fail-then-hang fixture is refused as no-verdict, never admitted and never called flaky', async () => {
    const outside = await outsideDir('ape-flake-hang-');
    const marker = path.join(outside, 'hang-arm.marker');
    const dir = await redProject({
      files: { 'hang-runner.cjs': hangToggleRunnerSource(marker) },
      config: {
        test_commands: { full: 'node --test', targeted_template: 'node hang-runner.cjs {paths}' },
        // Short lane deadline bounds the second (hanging) invocation; the
        // first invocation exits in milliseconds, far inside it.
        deadlines_ms: { fast: 3000 },
      },
    });
    const started = await startRun(dir, startInput());
    expect(started.ok).toBe(true);
    const ticket = started.run.tickets[0];
    expect(ticket.required_checks).toContain('red-test');

    await writeFile(path.join(dir, 'tests', 'value.test.js'), 'throw new Error("authored red for the hang arm");\n');
    const result = await recordReceipt(dir, rawReceipt(ticket));
    // TODAY the single run fails fast and is ADMITTED (the hanging second
    // invocation never runs) — this assertion is the red anchor. Post-fix the
    // second run outlives the lane deadline and is killed: a deadline kill is
    // not writer flakiness and proves nothing about the authored tests, so the
    // receipt must surface the existing no-verdict refusal — never an admitted
    // red (even though the SIGTERM-trapped tree exits nonzero) and never the
    // nondeterminism refusal.
    expect(result.ok).toBe(false);
    expect(result.rejected).toBe(true);
    const message = (result.errors ?? []).join(' ');
    expect(message).toMatch(/did not produce a test verdict/);
    expect(message).not.toMatch(/nondeterministic/);
  }, 45_000);
});

// ---------------------------------------------------------------------------
// Gate-level flake signal harness (prior art: runtime-v2-gates-verification).
// runMergeGates driven against a scratch state/config; the suite cache file is
// seeded RAW (.ape/runtime/suite-cache.json) so the pins hold regardless of
// policy.full_suite_cache — the signal must read the raw cache entry, not the
// policy-gated served entry.
// ---------------------------------------------------------------------------

async function gatesProject() {
  const dir = await mkdtemp(path.join(tmpdir(), 'ape-flake-gates-'));
  cleanups.push(dir);
  await mkdir(path.join(dir, 'src'));
  await writeFile(path.join(dir, 'src', 'value.js'), 'export const value = 1;\n');
  git(dir, 'init', '-q');
  git(dir, 'config', 'user.email', 'ape@example.test');
  git(dir, 'config', 'user.name', 'APE Test');
  git(dir, 'add', '.');
  git(dir, 'commit', '-qm', 'test: baseline');
  const paths = { runtime: path.join(dir, '.ape', 'runtime') };
  await mkdir(paths.runtime, { recursive: true });
  const treeSha = await currentTreeSha(dir);
  return { dir, paths, treeSha };
}

// Mechanical lane isolates the full_suite check: no behavioral targeted
// derivation competes with the assertion under test.
function mechanicalState(treeSha, overrides = {}) {
  return {
    lane: 'mechanical',
    high_risk: false,
    receipts: [{
      receipt_hash: 'a',
      previous_receipt_hash: null,
      status: 'passed',
      agent: { role: 'implementer' },
      tests: [{ command: 'npx vitest run fabricated.test.js', passed: true, exit_code: 0 }],
      changed_files: ['src/value.js'],
      head_tree_sha: treeSha,
    }],
    ...overrides,
  };
}

function gatesConfig(overrides = {}) {
  return {
    policy: { fast_max_files: 6, full_suite_cache: true, ...(overrides.policy ?? {}) },
    test_commands: { targeted: null, full: PASS_CMD, ...(overrides.test_commands ?? {}) },
    deadlines_ms: {},
  };
}

// Invert the seedPassingCacheEntry prior art: a FAILED prior entry at the exact
// cacheKey the resolved passing command will recompute, with a plausible
// verification block (genuine red: tooling_failure false, timed_out absent).
async function seedFailedCacheEntry(paths, treeSha, command, verificationOverrides = {}) {
  const cachePath = path.join(paths.runtime, 'suite-cache.json');
  const cacheKey = `${treeSha}:${sha256({ command })}`;
  await atomicWriteJson(cachePath, {
    schema_version: '2.0.0',
    results: {
      [cacheKey]: {
        passed: false,
        tree_sha: treeSha,
        command,
        result_hash: 'seeded-prior-failure',
        recorded_at: '2026-07-21T10:00:00.000Z',
        verification: {
          passed: false,
          exit_code: 1,
          duration_ms: 42,
          output: 'seeded prior same-tree failure',
          tooling_failure: false,
          ...verificationOverrides,
        },
      },
    },
  });
  return cacheKey;
}

describe('gate-level flake signal on a fresh pass over a prior same-tree failure', () => {
  it('RED-AT-BASE anchor B: a passing full-suite evaluation over a seeded prior failure carries flake_signal', async () => {
    const { dir, paths, treeSha } = await gatesProject();
    await seedFailedCacheEntry(paths, treeSha, PASS_CMD);
    const result = await runMergeGates(dir, paths, mechanicalState(treeSha), gatesConfig());
    // The seeded failure is never SERVED (only passing results are), so the
    // fresh evaluation executes and passes — green today and post-fix.
    expect(result.checks.full_suite.passed).toBe(true);
    expect(result.checks.full_suite.cached).toBe(false);
    // RED ANCHOR: today no flake_signal key exists anywhere in gate evidence.
    // Post-fix the passing check must record the prior same-tree failure as a
    // flake signal instead of silently reading as a clean pass.
    expect(result.checks.full_suite.flake_signal).toBeDefined();
    const prior = result.checks.full_suite.flake_signal.prior_same_tree_failure;
    expect(prior).toBeTruthy();
    expect(typeof prior).toBe('object');
    // Advisory only: the annotation never blocks the passing evaluation.
    expect(result.passed).toBe(true);
  }, 30_000);

  it('RED-AT-BASE anchor B variant: the annotation still fires with policy.full_suite_cache:false (raw cache read)', async () => {
    const { dir, paths, treeSha } = await gatesProject();
    await seedFailedCacheEntry(paths, treeSha, PASS_CMD);
    const result = await runMergeGates(dir, paths, mechanicalState(treeSha), gatesConfig({
      policy: { full_suite_cache: false },
    }));
    expect(result.checks.full_suite.passed).toBe(true);
    expect(result.checks.full_suite.cached).toBe(false);
    // The policy flag gates SERVING cached passes, not the flake signal: the
    // annotation must read the raw suite-cache entry, so disabling the cache
    // read path cannot silence the prior same-tree failure.
    expect(result.checks.full_suite.flake_signal).toBeDefined();
    expect(result.checks.full_suite.flake_signal.prior_same_tree_failure).toBeTruthy();
    expect(result.passed).toBe(true);
  }, 30_000);

  it('green guard: a fresh pass with no prior failure at the key carries no flake_signal key', async () => {
    const { dir, paths, treeSha } = await gatesProject();
    const result = await runMergeGates(dir, paths, mechanicalState(treeSha), gatesConfig());
    expect(result.checks.full_suite.passed).toBe(true);
    // Absent-when-none: the check shape (and its hash) stays byte-identical
    // for every clean pass with no flake history.
    expect('flake_signal' in result.checks.full_suite).toBe(false);
    expect(result.passed).toBe(true);
  }, 30_000);

  it.each([
    ['tooling-failure', { tooling_failure: true, exit_code: null, output: 'seeded tooling fault' }],
    ['timed-out', { timed_out: true, exit_code: 7 }],
  ])('green guard: a prior %s cache entry never fires the flake signal', async (_label, verificationOverrides) => {
    const { dir, paths, treeSha } = await gatesProject();
    await seedFailedCacheEntry(paths, treeSha, PASS_CMD, verificationOverrides);
    const result = await runMergeGates(dir, paths, mechanicalState(treeSha), gatesConfig());
    expect(result.checks.full_suite.passed).toBe(true);
    // A prior tooling fault or deadline kill is not suite flakiness evidence:
    // the contract scopes the signal to prior GENUINE failures
    // (tooling_failure !== true and timed_out !== true).
    expect('flake_signal' in result.checks.full_suite).toBe(false);
    expect(result.passed).toBe(true);
  }, 30_000);
});
