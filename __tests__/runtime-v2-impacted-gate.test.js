import { execFileSync, spawnSync } from 'node:child_process';
import { access, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

// Impacted-test selection for the LOCAL merge gate (operator-approved feature,
// option 1 of the gate-cost pair) plus the #268 nit list (N-a/N-b/N-d).
//
// test_commands.impacted_template is a {paths} command template — mirroring the
// existing targeted_template contract — that substitutes the LOCAL full-suite
// check so the gate cost scales with the change. INVARIANT-9 HARD RULE: it may
// substitute ONLY when required remote checks are enabled; a no-CI project runs
// the FULL local suite exactly as today. The impacted command flows through the
// #268 detached gating watch (startGateSuite/pollGateSuite/runner) unchanged.
//
// Ship is the only runtime-owned side effect these tests must not perform for
// real: autoMergeGithub is mocked (no watch key => merged in-call) so a passing
// gate completes the run; the impacted resolution, the detached gate machinery,
// and the poll evaluation all run genuinely. importOriginal keeps the impacted
// logic (gateSuiteContext/startGateSuite/evaluateGates/pollGateSuite) real, and
// impactedMergeGuard resolves from the namespace so its absence on the current
// tree surfaces as an undefined-call (a clean per-test red), never a load fault.
vi.mock('../lib/runtime/gates.js', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    autoMergeGithub: vi.fn(async () => ({
      url: 'https://github.com/acme/repo/pull/1',
      sha: 'f'.repeat(40),
      method: 'squash',
    })),
    pollRemoteChecksAndMerge: vi.fn(),
  };
});
import * as gates from '../lib/runtime/gates.js';
import { recordReceipt, regateRun, nextRun, shipRun, startRun } from '../lib/runtime/service.js';
import { runtimePaths } from '../lib/runtime/paths.js';
import { atomicWriteJson, readJson } from '../lib/runtime/storage.js';
import { currentTreeSha } from '../lib/runtime/git.js';
import { sha256 } from '../lib/runtime/canonical.js';
import { archiveRun } from '../lib/runtime/history.js';
import {
  GATE_INLINE_GRACE_MS,
  GATE_POLL_RETRY_DELAY_MS,
} from '../lib/runtime/constants.js';

// Detached gate runners plus real git init/commit take a few honest seconds.
vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function exists(file) {
  return access(file).then(() => true, () => false);
}

// process.kill(pid, 0) probes liveness without signalling: ESRCH => dead,
// EPERM => alive but unsignalable (still alive).
function alive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === 'EPERM';
  }
}

// Spawn-time pid ledger (judge teardown amendment). Every gate-runner
// generation's pid flows synchronously through the returned run object
// (run_gates sets gates_watch = start.watch with pid; every respawn's
// pending.watch {pid,...} is merged and returned), and the runtime erases the
// on-disk record before afterEach can observe it. track() records those pids
// transparently — returning its argument so call sites stay readable — so
// teardown can kill any runner still holding a Windows temp-dir handle.
const ledger = new Set();
function trackPid(pid) {
  if (Number.isInteger(pid) && pid > 0) ledger.add(pid);
}
function track(result) {
  trackPid(result?.run?.gates_watch?.pid);
  return result;
}

// Best-effort kill of a detached runner's whole process tree: the runner is a
// detached group leader and its suite child shares the group. Never throws.
function killTree(pid) {
  if (!Number.isInteger(pid) || pid <= 0 || pid === process.pid) return;
  try {
    if (process.platform === 'win32') {
      spawnSync('taskkill', ['/pid', String(pid), '/T', '/F']);
    } else {
      try {
        process.kill(-pid, 'SIGKILL');
      } catch {
        try {
          process.kill(pid, 'SIGKILL');
        } catch {
          // already gone
        }
      }
    }
  } catch {
    // best-effort only; teardown must never throw
  }
}

// Drive `ape_run next` repeatedly until the gating run leaves the poll.
async function drivePolls(dir, { tries = 150, delay = 100 } = {}) {
  let result = track(await nextRun(dir));
  for (let i = 0; i < tries; i += 1) {
    if (!result.ok) return result;
    if (result.run?.status !== 'gating') return result;
    await sleep(delay);
    result = track(await nextRun(dir));
  }
  return result;
}

const cleanups = [];
afterEach(async () => {
  // Judge amendment: before removing any temp dir, kill every lingering
  // detached gate-runner tree this test ledgered and CONFIRM its exit. An
  // unkilled runner's artifact write does mkdir-recursive and resurrects the
  // deleted dir, racing Windows handle release into EBUSY rmdir. Best-effort:
  // never throw, never fail a green test.
  const pids = [...ledger];
  ledger.clear();
  for (const pid of pids) {
    if (alive(pid)) killTree(pid);
  }
  for (let i = 0; i < 40; i += 1) {
    if (pids.every((pid) => !alive(pid))) break;
    await sleep(50);
  }
  await Promise.all(
    cleanups
      .splice(0)
      .map((dir) => rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })),
  );
});

function git(cwd, ...args) {
  execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' },
  });
}

// A controllable suite command whose script lives OUTSIDE the project so its
// executions never perturb the project tree SHA. It records every execution in
// a counter and dumps the {paths} tail of its own argv (positions >= 6) so a
// test can prove the template expanded at argv level — a path with spaces stays
// ONE argv entry. `pass`/`fail` are unconditional; `auto` passes iff the arm
// marker exists; `block` waits for the arm up to a bounded self-timeout. An
// optional leading sleep makes the suite's own wall-clock measurable.
const PROBE_SRC = [
  "const fs = require('node:fs');",
  'const a = process.argv.slice(2);',
  'const [mode, counter, argvdump, arm, sleepStr, blockStr] = a;',
  'const tail = a.slice(6);',
  'const wait = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);',
  "try { fs.appendFileSync(counter, 'x'); } catch (e) {}",
  'try { fs.writeFileSync(argvdump, JSON.stringify(tail)); } catch (e) {}',
  "const sleepMs = Number(sleepStr || '0');",
  'if (sleepMs > 0) { const end = Date.now() + sleepMs; while (Date.now() < end) wait(25); }',
  "if (mode === 'pass') process.exit(0);",
  "if (mode === 'fail') process.exit(1);",
  "if (mode === 'auto') process.exit(fs.existsSync(arm) ? 0 : 1);",
  "const deadline = Date.now() + Number(blockStr || '4000');",
  'while (!fs.existsSync(arm)) { if (Date.now() >= deadline) process.exit(1); wait(50); }',
  'process.exit(0);',
].join('\n');

async function makeProject(extraFiles = {}) {
  const dir = await mkdtemp(path.join(tmpdir(), 'ape-impacted-'));
  const outside = await mkdtemp(path.join(tmpdir(), 'ape-impacted-out-'));
  cleanups.push(dir, outside);
  await mkdir(path.join(dir, 'src'));
  await mkdir(path.join(dir, 'docs'));
  await writeFile(path.join(dir, 'src', 'value.js'), 'export const value = 1;\n');
  await writeFile(path.join(dir, 'docs', 'note.md'), '# note\n');
  for (const [rel, content] of Object.entries(extraFiles)) {
    await mkdir(path.dirname(path.join(dir, rel)), { recursive: true });
    await writeFile(path.join(dir, rel), content);
  }
  git(dir, 'init', '-q');
  git(dir, 'config', 'user.email', 'ape@example.test');
  git(dir, 'config', 'user.name', 'APE Test');
  git(dir, 'add', '.');
  git(dir, 'commit', '-qm', 'test: baseline');
  const probe = path.join(outside, 'probe.cjs');
  await writeFile(probe, PROBE_SRC);
  return { dir, outside, probe };
}

function makeSuite(outside, probe, name, { mode = 'auto', sleepMs = 0, blockTimeoutMs = 4000, template = false } = {}) {
  const counter = path.join(outside, `${name}.counter`);
  const argvdump = path.join(outside, `${name}.argv.json`);
  const armPath = path.join(outside, `${name}.arm`);
  const base = `node "${probe}" ${mode} "${counter}" "${argvdump}" "${armPath}" ${sleepMs} ${blockTimeoutMs}`;
  return {
    command: template ? `${base} {paths}` : base,
    arm: () => writeFile(armPath, 'go\n'),
    executions: async () => {
      try {
        return (await readFile(counter, 'utf8')).length;
      } catch {
        return 0;
      }
    },
    argv: async () => {
      try {
        return JSON.parse(await readFile(argvdump, 'utf8'));
      } catch {
        return null;
      }
    },
  };
}

// gates.inline_grace_ms=0 forces the deterministic multi-call shape (every poll
// is an explicit `ape_run next`). full_suite_cache defaults false so each gate
// is a real execution the counter attests; the cache-separation tests flip it on.
async function writeConfig(dir, {
  full,
  impactedTemplate,
  targeted,
  fullSerial,
  requiredRemoteChecks = true,
  autoMerge = true,
  cache = false,
  graceMs = 0,
  gates: gatesOverride = {},
} = {}) {
  const config = {
    shipping: { auto_merge: autoMerge, provider: 'github', required_remote_checks: requiredRemoteChecks },
    policy: { full_suite_cache: cache },
    gates: { inline_grace_ms: graceMs, ...gatesOverride },
    test_commands: {},
  };
  if (full !== undefined) config.test_commands.full = full;
  if (impactedTemplate !== undefined) config.test_commands.impacted_template = impactedTemplate;
  if (targeted !== undefined) config.test_commands.targeted = targeted;
  if (fullSerial !== undefined) config.test_commands.full_serial = fullSerial;
  await atomicWriteJson(runtimePaths(dir).config, config);
}

// Start a mechanical run: its single build receipt drives run_gates on the
// PRIMARY (recordReceipt) path, where regate_attempts is 0 and ship_requested
// is unset — the only path on which impacted substitution is eligible.
async function startMechanical(dir, claimed, objective = 'Update the documentation notes') {
  const started = track(await startRun(dir, {
    objective,
    mode: 'phase',
    lane: 'mechanical',
    host: 'codex',
    claimed_paths: claimed,
    test_paths: [],
    requirements: ['R-IMPACT'],
    risk_triggers: [],
    behavioral: false,
    hooks_trusted: true,
    subagents_available: true,
    explicit_invocation: true,
  }));
  expect(started.ok).toBe(true);
  const build = started.run.tickets[0];
  expect(build.role).toBe('implementer');
  return { runId: started.run.run_id, build };
}

async function recordBuild(dir, build) {
  return track(await recordReceipt(dir, {
    ticket_id: build.ticket_id,
    status: 'passed',
    agent_identity: 'agent-implementer',
    tests: [{ command: 'node --version', passed: true, exit_code: 0, duration_ms: 1 }],
    findings: [],
    evidence: { verdict: 'pass' },
    timing: {
      started_at: build.issued_at,
      completed_at: new Date(Date.parse(build.issued_at) + 10).toISOString(),
      duration_ms: 10,
    },
  }));
}

async function buildToGate(dir, claimed, mutate) {
  const { runId, build } = await startMechanical(dir, claimed);
  await mutate();
  const result = await recordBuild(dir, build);
  return { runId, result };
}

// A fast (behavioral) run blocked at the merge gates, so a REGATE re-enters
// run_gates on a lane whose evaluateGates executes test_commands.targeted
// in-call — the slice N-b must count into timing.test_ms. The tree is clean and
// timing starts at zero so the accumulated wall-clock is asserted cleanly.
async function seedFastBlockedAtGates(dir, runId) {
  const paths = runtimePaths(dir);
  const tree = await currentTreeSha(dir);
  const blocked = {
    version: 2,
    schema_version: '2.0.0',
    run_id: runId,
    status: 'blocked',
    stage: 'gates',
    block_reason: 'one or more deterministic merge gates failed',
    objective: 'Ship the value bump after fixing the environment',
    mode: 'phase',
    lane: 'fast',
    requested_lane: 'fast',
    lane_reasons: [],
    lane_escalated: false,
    behavioral: true,
    high_risk: false,
    policy: { high_risk_security_review: true },
    host: 'codex',
    claimed_paths: ['src/value.js'],
    test_paths: ['src/value.test.js'],
    requirements: ['R-gate'],
    risk_triggers: [],
    branch: 'ape/fast-gate',
    base_commit_sha: 'a'.repeat(40),
    tree_sha: tree,
    tickets: [],
    receipts: [{
      receipt_hash: 'a',
      previous_receipt_hash: null,
      status: 'passed',
      agent: { host: 'codex', role: 'implementer' },
      tests: [{ passed: true }],
      changed_files: ['src/value.js'],
      head_tree_sha: tree,
    }],
    attempts: {},
    remediation_cycles: 0,
    regate_attempts: 0,
    gates: { passed: false, tree_sha: tree },
    timing: { test_ms: 0, remote_ci_ms: 0 },
    created_at: '2026-07-01T00:00:00.000Z',
    updated_at: '2026-07-01T00:00:00.000Z',
    terminal_at: '2026-07-01T00:00:00.000Z',
  };
  await atomicWriteJson(paths.active, blocked);
  await archiveRun(paths, blocked, { ifAbsent: true });
  return { paths, tree };
}

describe('APE v2 impacted-test selection for the local merge gate', () => {
  it('substitutes the impacted command for the local full-suite check and reports it honestly with a rendered argv (T1)', async () => {
    const { dir, outside, probe } = await makeProject();
    const impacted = makeSuite(outside, probe, 'impacted', { mode: 'auto', template: true });
    const full = makeSuite(outside, probe, 'full', { mode: 'auto' });
    await impacted.arm();
    await full.arm();
    await writeConfig(dir, { full: full.command, impactedTemplate: impacted.command, requiredRemoteChecks: true });

    const { result } = await buildToGate(dir, ['docs/note.md'], () =>
      writeFile(path.join(dir, 'docs', 'note.md'), '# note\n\nUpdated.\n'));
    expect(result.ok).toBe(true);
    const done = result.run.status === 'gating' ? await drivePolls(dir) : result;
    expect(done.run.status).toBe('completed');

    // The full_suite check says impacted honestly (a distinct shape), never a
    // silent full-suite report, and carries the RESOLVED (rendered) command.
    const fullSuite = done.run.gates.checks.full_suite;
    expect(fullSuite.mode).toBe('impacted');
    expect(fullSuite.impacted_paths).toEqual(['docs/note.md']);
    expect(fullSuite.command).toContain('docs/note.md');
    expect(fullSuite.command).not.toContain('{paths}');

    // The IMPACTED suite (not the full suite) executed, and {paths} expanded at
    // argv level to the changed file as a single argv entry.
    expect(await impacted.executions()).toBe(1);
    expect(await full.executions()).toBe(0);
    expect(await impacted.argv()).toEqual(['docs/note.md']);
  });

  it('expands {paths} at argv level: spaced paths stay one entry each, sorted (T6)', async () => {
    const { dir, outside, probe } = await makeProject({ 'docs/z note.md': '# z\n', 'docs/a note.md': '# a\n' });
    const impacted = makeSuite(outside, probe, 'impacted', { mode: 'auto', template: true });
    const full = makeSuite(outside, probe, 'full', { mode: 'auto' });
    await impacted.arm();
    await full.arm();
    await writeConfig(dir, { full: full.command, impactedTemplate: impacted.command, requiredRemoteChecks: true });

    const { result } = await buildToGate(dir, ['docs/a note.md', 'docs/z note.md'], async () => {
      await writeFile(path.join(dir, 'docs', 'a note.md'), '# a\n\nx\n');
      await writeFile(path.join(dir, 'docs', 'z note.md'), '# z\n\nx\n');
    });
    const done = result.run.status === 'gating' ? await drivePolls(dir) : result;
    expect(done.run.status).toBe('completed');

    // Each spaced path is exactly one argv entry, forward-slashed and sorted.
    expect(await impacted.argv()).toEqual(['docs/a note.md', 'docs/z note.md']);
    expect(done.run.gates.checks.full_suite.impacted_paths).toEqual(['docs/a note.md', 'docs/z note.md']);
    expect(await full.executions()).toBe(0);
  });

  it('never substitutes impacted when required remote checks are disabled — the local FULL suite runs (T2, invariant 9)', async () => {
    const { dir, outside, probe } = await makeProject();
    const impacted = makeSuite(outside, probe, 'impacted', { mode: 'auto', template: true });
    const full = makeSuite(outside, probe, 'full', { mode: 'auto' });
    await impacted.arm();
    await full.arm();
    // required_remote_checks:false => the remote CI full suite does not exist, so
    // the local FULL suite is the only full gate and impacted must NEVER weaken it.
    await writeConfig(dir, { full: full.command, impactedTemplate: impacted.command, requiredRemoteChecks: false });

    const { result } = await buildToGate(dir, ['docs/note.md'], () =>
      writeFile(path.join(dir, 'docs', 'note.md'), '# note\n\nUpdated.\n'));
    const done = result.run.status === 'gating' ? await drivePolls(dir) : result;
    expect(done.run.status).toBe('completed');
    const fullSuite = done.run.gates.checks.full_suite;
    expect(fullSuite.mode ?? null).toBeNull();
    expect(await full.executions()).toBe(1);
    expect(await impacted.executions()).toBe(0);
  });

  describe('fail-safe fallback to the FULL suite, never to skipping (T3)', () => {
    it('falls back when the impacted_template is malformed', async () => {
      const { dir, outside, probe } = await makeProject();
      const full = makeSuite(outside, probe, 'full', { mode: 'auto' });
      await full.arm();
      await writeConfig(dir, {
        full: full.command,
        impactedTemplate: 'node "unterminated {paths}',
        requiredRemoteChecks: true,
      });
      const { result } = await buildToGate(dir, ['docs/note.md'], () =>
        writeFile(path.join(dir, 'docs', 'note.md'), '# note\n\nUpdated.\n'));
      const done = result.run.status === 'gating' ? await drivePolls(dir) : result;
      expect(done.run.status).toBe('completed');
      expect(done.run.gates.checks.full_suite.mode ?? null).toBeNull();
      expect(await full.executions()).toBe(1);
    });

    it('falls back when the impacted_template never mentions {paths}', async () => {
      const { dir, outside, probe } = await makeProject();
      const impactedNoPaths = makeSuite(outside, probe, 'impacted', { mode: 'auto' }); // no {paths}
      const full = makeSuite(outside, probe, 'full', { mode: 'auto' });
      await impactedNoPaths.arm();
      await full.arm();
      await writeConfig(dir, {
        full: full.command,
        impactedTemplate: impactedNoPaths.command,
        requiredRemoteChecks: true,
      });
      const { result } = await buildToGate(dir, ['docs/note.md'], () =>
        writeFile(path.join(dir, 'docs', 'note.md'), '# note\n\nUpdated.\n'));
      const done = result.run.status === 'gating' ? await drivePolls(dir) : result;
      expect(done.run.status).toBe('completed');
      expect(done.run.gates.checks.full_suite.mode ?? null).toBeNull();
      expect(await full.executions()).toBe(1);
    });

    it('falls back when the changed-path set is empty after the existing-on-disk filter', async () => {
      const { dir, outside, probe } = await makeProject({ 'docs/gone.md': '# gone\n' });
      const impacted = makeSuite(outside, probe, 'impacted', { mode: 'auto', template: true });
      const full = makeSuite(outside, probe, 'full', { mode: 'auto' });
      await impacted.arm();
      await full.arm();
      await writeConfig(dir, { full: full.command, impactedTemplate: impacted.command, requiredRemoteChecks: true });
      // The build DELETES its only claimed file: changed_files carries it, but the
      // existing-on-disk filter empties the impacted set → FULL fallback.
      const { result } = await buildToGate(dir, ['docs/gone.md'], () =>
        rm(path.join(dir, 'docs', 'gone.md'), { force: true }));
      const done = result.run.status === 'gating' ? await drivePolls(dir) : result;
      expect(done.run.status).toBe('completed');
      expect(done.run.gates.checks.full_suite.mode ?? null).toBeNull();
      expect(await full.executions()).toBe(1);
      expect(await impacted.executions()).toBe(0);
    });
  });

  it('an impacted pass never satisfies a later FULL gate at the same tree (T4, cache separation)', async () => {
    const { dir, outside, probe } = await makeProject();
    const impacted = makeSuite(outside, probe, 'impacted', { mode: 'auto', template: true });
    const full = makeSuite(outside, probe, 'full', { mode: 'auto' });
    await impacted.arm();
    await full.arm();
    // Cache ON so a wrong (colliding) key would be served; auto_merge OFF so the
    // impacted pass HOLDS at merge (its result cached), then SHIP re-runs FULL
    // (ship_requested forbids impacted) at the SAME tree.
    await writeConfig(dir, {
      full: full.command,
      impactedTemplate: impacted.command,
      requiredRemoteChecks: true,
      autoMerge: false,
      cache: true,
    });

    const { result } = await buildToGate(dir, ['docs/note.md'], () =>
      writeFile(path.join(dir, 'docs', 'note.md'), '# note\n\nUpdated.\n'));
    const held = result.run.status === 'gating' ? await drivePolls(dir) : result;
    expect(held.run.status).toBe('blocked');
    expect(held.run.stage).toBe('merge');
    expect(held.run.gates.checks.full_suite.mode).toBe('impacted');
    expect(await impacted.executions()).toBe(1);
    expect(await full.executions()).toBe(0);

    const shipped = track(await shipRun(dir, 'operator ships after out-of-band acceptance'));
    expect(shipped.ok).toBe(true);
    const done = shipped.run.status === 'gating' ? await drivePolls(dir) : shipped;
    expect(done.run.status).toBe('completed');
    const shipFull = done.run.gates.checks.full_suite;
    expect(shipFull.mode ?? null).toBeNull();
    // The impacted cache entry must NOT satisfy the FULL gate: it executed fresh.
    expect(shipFull.cached).toBe(false);
    expect(await full.executions()).toBe(1);
  });

  it('a FULL pass never satisfies an impacted gate at the same tree (T4, cache separation, reverse)', async () => {
    const { dir, outside, probe } = await makeProject();
    const impacted = makeSuite(outside, probe, 'impacted', { mode: 'auto', template: true });
    const full = makeSuite(outside, probe, 'full', { mode: 'auto' });
    await impacted.arm();
    await full.arm();
    await writeConfig(dir, {
      full: full.command,
      impactedTemplate: impacted.command,
      requiredRemoteChecks: true,
      cache: true,
    });

    const { build } = await startMechanical(dir, ['docs/note.md']);
    await writeFile(path.join(dir, 'docs', 'note.md'), '# note\n\nUpdated.\n');
    // Pre-seed a PASSING FULL-suite cache entry at the post-build tree + full
    // command (the existing full-key shape). An impacted gate must compute a
    // DISTINCT (mode-embedded) key and re-execute — never serve this entry.
    const treeSha = await currentTreeSha(dir);
    const fullKey = `${treeSha}:${sha256({ command: full.command })}`;
    await atomicWriteJson(path.join(runtimePaths(dir).runtime, 'suite-cache.json'), {
      schema_version: '2.0.0',
      results: {
        [fullKey]: {
          passed: true,
          tree_sha: treeSha,
          command: full.command,
          result_hash: 'seeded',
          recorded_at: new Date().toISOString(),
          verification: { passed: true },
        },
      },
    });

    const result = await recordBuild(dir, build);
    const done = result.run.status === 'gating' ? await drivePolls(dir) : result;
    expect(done.run.status).toBe('completed');
    const fullSuite = done.run.gates.checks.full_suite;
    expect(fullSuite.mode).toBe('impacted');
    expect(fullSuite.cached).toBe(false);
    expect(await impacted.executions()).toBe(1);
  });

  it('composes with serial re-gate: a re-gate (regate_attempts>0) never selects impacted (T5)', async () => {
    const { dir, outside, probe } = await makeProject();
    const impacted = makeSuite(outside, probe, 'impacted', { mode: 'auto', template: true });
    const full = makeSuite(outside, probe, 'full', { mode: 'auto' });
    await impacted.arm();
    await full.arm();
    await writeConfig(dir, { full: full.command, impactedTemplate: impacted.command, requiredRemoteChecks: true });
    // seedFastBlockedAtGates rests at a gate block; the very first REGATE
    // increments regate_attempts to 1 before run_gates, so impacted is never
    // eligible on the recovery path — the FULL suite runs.
    await seedFastBlockedAtGates(dir, 'run-impacted-regate');
    await writeConfig(dir, {
      full: full.command,
      impactedTemplate: impacted.command,
      requiredRemoteChecks: true,
      targeted: full.command,
    });
    const regate = track(await regateRun(dir));
    expect(regate.ok).toBe(true);
    const done = regate.run.status === 'gating' ? await drivePolls(dir) : regate;
    expect(done.run.status).toBe('completed');
    expect(done.run.gates.checks.full_suite.mode ?? null).toBeNull();
    expect(await impacted.executions()).toBe(0);
  });
});

describe('APE v2 impacted-mode merge guard (D6-L3 pure predicate)', () => {
  it('refuses a merge whose passing gates ran impacted when remote checks are now off and no ship was authorized', () => {
    const impactedGates = { passed: true, checks: { full_suite: { mode: 'impacted', passed: true } } };
    const fullGates = { passed: true, checks: { full_suite: { passed: true } } };
    // impacted gates + required_remote_checks now false + no ship_requested → REFUSE.
    expect(gates.impactedMergeGuard(
      { gates: impactedGates, ship_requested: false },
      { shipping: { required_remote_checks: false } },
    )).toBe(true);
    // Remote checks still on: the remote CI full suite is the true full gate → allow.
    expect(gates.impactedMergeGuard(
      { gates: impactedGates, ship_requested: false },
      { shipping: { required_remote_checks: true } },
    )).toBe(false);
    // A FULL local gate ran (no impacted mode): allow even with remote checks off.
    expect(gates.impactedMergeGuard(
      { gates: fullGates, ship_requested: false },
      { shipping: { required_remote_checks: false } },
    )).toBe(false);
    // An audited ship re-ran the FULL suite (ship_requested): allow.
    expect(gates.impactedMergeGuard(
      { gates: impactedGates, ship_requested: true },
      { shipping: { required_remote_checks: false } },
    )).toBe(false);
  });
});

describe('APE v2 impacted gate D6 mid-watch drift and #268 nits', () => {
  it('fails a gating poll closed when required_remote_checks flips mid-watch, then a regate completes via FULL (D6-L2)', async () => {
    const { dir, outside, probe } = await makeProject();
    const impacted = makeSuite(outside, probe, 'impacted', { mode: 'block', blockTimeoutMs: 8000, template: true });
    const full = makeSuite(outside, probe, 'full', { mode: 'block', blockTimeoutMs: 8000 });
    await writeConfig(dir, { full: full.command, impactedTemplate: impacted.command, requiredRemoteChecks: true });

    const { result } = await buildToGate(dir, ['docs/note.md'], () =>
      writeFile(path.join(dir, 'docs', 'note.md'), '# note\n\nUpdated.\n'));
    expect(result.run.status).toBe('gating');

    // Flip required_remote_checks OFF while the impacted suite is un-armed: the
    // recomputed selection is now FULL, whose cache key differs from the impacted
    // watch key, so the existing poll drift check must fail closed.
    await writeConfig(dir, { full: full.command, impactedTemplate: impacted.command, requiredRemoteChecks: false });
    const blocked = await drivePolls(dir, { tries: 30, delay: 100 });
    expect(blocked.run.status).toBe('blocked');
    expect(blocked.run.stage).toBe('gates');

    // Recovery: a regate now selects FULL (remote checks off) and completes.
    await full.arm();
    const regate = track(await regateRun(dir));
    expect(regate.ok).toBe(true);
    const done = regate.run.status === 'gating' ? await drivePolls(dir) : regate;
    expect(done.run.status).toBe('completed');
  });

  it('surfaces the configured gates.poll_retry_delay_ms on a pending gate poll, not the bare constant (N-a)', async () => {
    const { dir, outside, probe } = await makeProject();
    const full = makeSuite(outside, probe, 'full', { mode: 'block', blockTimeoutMs: 8000 });
    await writeConfig(dir, {
      full: full.command,
      requiredRemoteChecks: false,
      gates: { poll_retry_delay_ms: 1234 },
    });

    const { result } = await buildToGate(dir, ['docs/note.md'], () =>
      writeFile(path.join(dir, 'docs', 'note.md'), '# note\n\nUpdated.\n'));
    expect(result.run.status).toBe('gating');

    const poll = track(await nextRun(dir));
    expect(poll.ok).toBe(true);
    const pending = poll.actions.find((action) => action.type === 'gating_pending');
    expect(pending).toBeTruthy();
    expect(pending.retry_after_ms).toBe(1234);
    expect(pending.retry_after_ms).not.toBe(GATE_POLL_RETRY_DELAY_MS);

    await full.arm();
    await drivePolls(dir);
  });

  it('counts the in-call evaluation slice into timing.test_ms on the inline-grace ready path (N-b)', async () => {
    const { dir, outside, probe } = await makeProject();
    // A fast full suite ready within the inline grace window (~200ms of its own
    // detached wall-clock), and a long (~800ms) in-call targeted probe that
    // evaluateGates runs on this behavioral lane. The current inline-grace ready
    // path counts only the ~200ms artifact duration (plus the small spawn slice),
    // so the ~800ms in-call evaluation slice is the whole discriminator.
    const full = makeSuite(outside, probe, 'full', { mode: 'pass', sleepMs: 200 });
    const targeted = makeSuite(outside, probe, 'targeted', { mode: 'pass', sleepMs: 800 });
    expect(GATE_INLINE_GRACE_MS).toBeGreaterThan(0); // the grace poll exists
    await writeConfig(dir, {
      full: full.command,
      targeted: targeted.command,
      requiredRemoteChecks: false,
      graceMs: 3000,
    });
    await seedFastBlockedAtGates(dir, 'run-nb-grace');

    const regate = track(await regateRun(dir));
    // The fast suite resolves within the grace window: the run transitions in-call.
    expect(regate.run.status).toBe('completed');
    // test_ms must include BOTH the detached suite's own duration (~200ms) AND the
    // in-call evaluateGates slice (which ran the ~800ms targeted probe) — the
    // explicit poll ready arm counts both, and this arm must match. The bound sits
    // well above the artifact-only floor (~200ms + a small spawn slice) and well
    // below the with-evaluation total (~1000ms). No upper bound.
    expect(Number.isFinite(regate.run.timing.test_ms)).toBe(true);
    expect(regate.run.timing.test_ms).toBeGreaterThanOrEqual(700);
    expect(await targeted.executions()).toBe(1);
  });

  it('does not NaN-poison timing.test_ms on a crafted non-numeric artifact duration (N-d)', async () => {
    const { dir, outside, probe } = await makeProject();
    const full = makeSuite(outside, probe, 'full', { mode: 'block', blockTimeoutMs: 20000 });
    await writeConfig(dir, { full: full.command, requiredRemoteChecks: false });

    const { result } = await buildToGate(dir, ['docs/note.md'], () =>
      writeFile(path.join(dir, 'docs', 'note.md'), '# note\n\nUpdated.\n'));
    expect(result.run.status).toBe('gating');

    const watch = (await readJson(runtimePaths(dir).active)).gates_watch;
    expect(watch).toBeTruthy();
    // Ledger the live runner pid the test reads straight from gates_watch, so
    // teardown can kill this still-blocking runner before removing its dirs.
    trackPid(watch?.pid);
    // Hand-write an adoptable artifact (correct run_id + nonce from the live
    // watch) whose durations are non-numeric strings. Only a Number.isFinite
    // duration may accumulate; a crafted value must not poison timing with NaN.
    await atomicWriteJson(watch.artifact_file, {
      version: 1,
      run_id: result.run.run_id,
      nonce: watch.nonce,
      cache_key: watch.cache_key,
      passed: true,
      duration_ms: '999',
      verification: { passed: true, duration_ms: 'nope' },
      recorded_at: new Date().toISOString(),
    });

    const done = await drivePolls(dir);
    expect(done.run.status).toBe('completed');
    expect(Number.isFinite(done.run.timing.test_ms)).toBe(true);
  });
});
