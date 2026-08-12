import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { recordReceipt, startRun } from '../lib/runtime/service.js';
import { runtimePaths } from '../lib/runtime/paths.js';
import { atomicWriteJson } from '../lib/runtime/storage.js';

// Roadmap entry test-command-modifiers (shuffle half). Public contract under
// test — the composable shuffle modifier for the DOUBLE-RUN red-test admission
// at service.js observeRedTest run B, observed through the sealed
// evidence.red_test observation recordReceipt returns:
//   * A new nullable string slot test_commands.shuffle (null default). At red
//     admission run B is normally run A's exact invocation; when
//     test_commands.targeted_shuffle_template is UNSET but test_commands.shuffle
//     is set, run B is run A's invocation with the shuffle modifier APPENDED, and
//     that second runs[] entry carries a distinct shuffle_modifier marker.
//   * test_commands.targeted_shuffle_template retains precedence as the escape
//     hatch: when set it renders run B in full (existing shuffle_template marker),
//     and the shuffle slot neither wins nor tags.
//   * Backward compatible: with neither the slot nor the template set, run B
//     re-executes run A byte-identically (no marker) — unchanged from today.
//   * A malformed test_commands.shuffle string (one that fails tokenization)
//     refuses admission with a test_commands.shuffle-named error rather than
//     silently admitting.
//   * Red admission stays exit-code-only and exactly two runs: both invocations
//     must fail, so a shuffle modifier that changes order but not outcome still
//     admits a deterministic red.
//
// RED AT THE BASE TREE: today observeRedTest reads only targeted_shuffle_template,
// so the shuffle slot is ignored — run B re-runs run A unmodified with no
// shuffle_modifier marker, and a malformed shuffle string never refuses (anchors
// below). GREEN GUARDS (green today and post-fix): template precedence; the
// byte-identical unset double run.

// A path-agnostic red runner (committed at baseline): it ignores its arguments
// and always exits nonzero, so the double-run red admission observes a
// deterministic red on BOTH invocations regardless of the shuffle-modifier
// tokens run B appends — order changes, outcome does not.
const RED_RUNNER = 'process.exit(1);\n';
const TARGETED_TEMPLATE = 'node red-runner.cjs {paths}';
const RUN_A_COMMAND = 'node red-runner.cjs tests/value.test.js';
const SHUFFLE = '--shuffle-seed=42';

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

// A scratch git project driven through the public service surface: startRun
// issues the test_writer ticket with required_checks ['red-test'], recordReceipt
// triggers the runtime-owned double-run red-test execution at admission.
async function redProject({ testCommands } = {}) {
  const dir = await mkdtemp(path.join(tmpdir(), 'ape-shuffle-red-'));
  cleanups.push(dir);
  await mkdir(path.join(dir, 'src'));
  await mkdir(path.join(dir, 'tests'));
  await writeFile(path.join(dir, 'src', 'value.js'), 'export const value = 1;\n');
  await writeFile(path.join(dir, 'tests', 'value.test.js'), 'throw new Error("placeholder red");\n');
  await writeFile(path.join(dir, 'red-runner.cjs'), RED_RUNNER);
  git(dir, 'init', '-q');
  git(dir, 'config', 'user.email', 'ape@example.test');
  git(dir, 'config', 'user.name', 'APE Test');
  git(dir, 'add', '.');
  git(dir, 'commit', '-qm', 'baseline');
  await atomicWriteJson(runtimePaths(dir).config, {
    shipping: { auto_merge: false, provider: 'github', required_remote_checks: false },
    test_commands: testCommands ?? { full: 'node --test', targeted_template: TARGETED_TEMPLATE },
  });
  return dir;
}

function startInput(overrides = {}) {
  return {
    objective: 'Exercise shuffle-modifier composition at red-test admission',
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

// Issue the test_writer ticket, make the authored test a genuine change vs
// baseline (so its path renders into the red-phase command), then submit the
// receipt to drive the runtime-owned red admission.
async function admit(dir) {
  const started = await startRun(dir, startInput());
  expect(started.ok).toBe(true);
  const ticket = started.run.tickets[0];
  expect(ticket.role).toBe('test_writer');
  expect(ticket.required_checks).toContain('red-test');
  await writeFile(path.join(dir, 'tests', 'value.test.js'), 'throw new Error("authored red for shuffle compose");\n');
  return recordReceipt(dir, rawReceipt(ticket));
}

describe('shuffle-modifier composition at red-test admission (test-command-modifiers)', () => {
  it('RED-AT-BASE: an unset targeted_shuffle_template composes test_commands.shuffle onto run B', async () => {
    const dir = await redProject({
      testCommands: { full: 'node --test', targeted_template: TARGETED_TEMPLATE, shuffle: SHUFFLE },
    });
    const result = await admit(dir);
    // Deterministic red on both runs: admission succeeds.
    expect(result.ok).toBe(true);
    const observation = result.receipt.evidence.red_test;
    expect(observation.observed).toBe(true);
    expect(Array.isArray(observation.runs)).toBe(true);
    expect(observation.runs).toHaveLength(2);
    const [runA, runB] = observation.runs;
    expect(runA.command).toBe(RUN_A_COMMAND);
    expect(runA.exit_code).not.toBe(0);
    expect(runB.exit_code).not.toBe(0);
    // TODAY the shuffle slot is ignored, so run B re-runs run A's exact command
    // with no marker — these two assertions are the red anchors. Post-fix run B
    // is run A's invocation with the shuffle modifier appended, tagged distinctly
    // from the existing full-template shuffle_template marker.
    expect(runB.command).toBe(`${RUN_A_COMMAND} ${SHUFFLE}`);
    expect(runB.shuffle_modifier).toBe(true);
  }, 30_000);

  it('green guard: targeted_shuffle_template retains precedence over the shuffle slot for run B', async () => {
    const dir = await redProject({
      testCommands: {
        full: 'node --test',
        targeted_template: TARGETED_TEMPLATE,
        targeted_shuffle_template: 'node red-runner.cjs {paths} --from-template',
        shuffle: '--from-slot',
      },
    });
    const result = await admit(dir);
    expect(result.ok).toBe(true);
    const runB = result.receipt.evidence.red_test.runs[1];
    // The full-template escape hatch drives run B unchanged (the existing
    // shuffle_template marker); the slot neither wins nor tags when the template
    // is set.
    expect(runB.command).toBe('node red-runner.cjs tests/value.test.js --from-template');
    expect(runB.shuffle_template).toBe(true);
    expect(runB.shuffle_modifier).toBeUndefined();
    expect(runB.command).not.toContain('--from-slot');
  }, 30_000);

  it('green guard: with neither the shuffle slot nor the template set, run B re-executes run A byte-identically', async () => {
    const dir = await redProject({
      testCommands: { full: 'node --test', targeted_template: TARGETED_TEMPLATE },
    });
    const result = await admit(dir);
    expect(result.ok).toBe(true);
    const [runA, runB] = result.receipt.evidence.red_test.runs;
    expect(runB.command).toBe(runA.command);
    expect(runB.shuffle_modifier).toBeUndefined();
    expect(runB.shuffle_template).toBeUndefined();
  }, 30_000);

  it('RED-AT-BASE: a malformed test_commands.shuffle refuses admission with a shuffle-named error', async () => {
    const dir = await redProject({
      testCommands: { full: 'node --test', targeted_template: TARGETED_TEMPLATE, shuffle: '--flag "unterminated' },
    });
    const result = await admit(dir);
    // TODAY the shuffle slot is ignored, so the deterministic red is admitted
    // (ok:true) despite the malformed value — the red anchor. Post-fix the
    // unbalanced quote fails tokenization and admission is refused with a
    // test_commands.shuffle-named error (never silently admitted).
    expect(result.ok).toBe(false);
    expect(result.rejected).toBe(true);
    const message = (result.errors ?? []).join(' ');
    expect(message).toMatch(/test_commands\.shuffle/);
  }, 30_000);
});
