import { execFileSync, spawnSync } from 'node:child_process';
import { access, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

// Polyglot MULTI-RUNNER union wired into the local merge gate. Today the gate
// resolves a SINGLE suite (resolveSuiteSelection) and IGNORES config.runners
// entirely: full_suite carries no `runners[]` key and no per-runner suite ever
// executes. Every multi-runner assertion below is therefore RED now and turns
// green only once gateSuiteContext/startGateSuite/pollGateSuite/evaluateGates/
// runMergeGates resolve the participating set via resolveRunnerSet and drive
// each UNCACHED participating runner's suite SEQUENTIALLY (one at a time)
// through the single detached gate watch, then UNION (AND) the verdicts.
//
// Modeled on __tests__/runtime-v2-impacted-gate.test.js: an mkdtemp runtime
// dir, out-of-tree probe scripts as fake suite commands (per-runner execution
// counters + argv dumps + optional block/fail arms) so a suite run never
// perturbs the project tree SHA, config written via a helper, and the gate
// driven by stepping the run through the gating state (manual nextRun / drive
// polls). autoMergeGithub is mocked (no watch key => merged in-call) so a
// passing union completes the run; every gate resolution, the detached
// machinery, and the poll evaluation run genuinely. importOriginal keeps the
// real gate logic and resolves impactedMergeGuard from the namespace so its
// current single-.mode shape surfaces as a per-test red, never a load fault.
//
// EXPECTED OBSERVABLE (the identical contract the implementer receives):
//   state.gates.checks.full_suite === {
//     passed: <AND over participating runners>,
//     tree_sha: <string>,
//     runners: [ { id, passed, cached, command, mode:'full'|'impacted', result_hash } ],
//   }
// A runners-unset run keeps today's single-suite full_suite (NO runners key)
// byte-for-byte — guarded green by the regression test at the end.
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
import { archiveRun } from '../lib/runtime/history.js';
import { loadRuntimeConfig } from '../lib/runtime/config.js';

// Detached gate runners plus real git init/commit take a few honest seconds.
vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

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

// Spawn-time pid ledger: every gate-runner generation's pid flows synchronously
// through the returned run object (state.gates_watch.pid), and the runtime
// erases the on-disk record before afterEach can observe it. track() records
// those pids transparently — returning its argument so call sites stay
// readable — so teardown can kill any runner still holding a temp-dir handle.
// For the SEQUENTIAL union each adopted runner respawns a fresh watch pid, so
// tracking every nextRun result captures every generation.
const ledger = new Set();
function trackPid(pid) {
  if (Number.isInteger(pid) && pid > 0) ledger.add(pid);
}
function track(result) {
  trackPid(result?.run?.gates_watch?.pid);
  return result;
}

// Best-effort kill of a detached runner's whole process tree (the runner is a
// detached group leader and its suite child shares the group). Never throws.
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

// Drive `ape_run next` repeatedly until the gating run leaves the poll. For the
// sequential union the run STAYS 'gating' across every runner's suite (one at a
// time), so this steps through all of them until the union evaluates.
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

// Wait (bounded) for a predicate WITHOUT stepping the runtime: the detached
// runner increments its own counter independently of any nextRun poll.
async function waitFor(predicate, { tries = 120, delay = 100 } = {}) {
  for (let i = 0; i < tries; i += 1) {
    if (await predicate()) return true;
    await sleep(delay);
  }
  return false;
}

// Step `ape_run next` (adopting a completed runner and launching the next one)
// until a predicate holds or the budget is spent.
async function stepUntil(dir, predicate, { tries = 150, delay = 100 } = {}) {
  for (let i = 0; i < tries; i += 1) {
    if (await predicate()) return;
    track(await nextRun(dir));
    await sleep(delay);
  }
}

async function settle(dir, result, opts) {
  return result.run?.status === 'gating' ? await drivePolls(dir, opts) : result;
}

const cleanups = [];
afterEach(async () => {
  // Kill every lingering detached gate-runner tree this test ledgered and
  // confirm exit before removing any temp dir: an unkilled runner's artifact
  // write does mkdir-recursive and can resurrect a deleted dir. Best-effort.
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
// a counter (incremented at process START, before any sleep/block) and dumps
// the {paths} tail of its own argv. `pass`/`fail` are unconditional; `auto`
// passes iff the arm marker exists; `block` waits for the arm up to a bounded
// self-timeout.
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
  const dir = await mkdtemp(path.join(tmpdir(), 'ape-union-'));
  const outside = await mkdtemp(path.join(tmpdir(), 'ape-union-out-'));
  cleanups.push(dir, outside);
  await mkdir(path.join(dir, 'docs', 'api'), { recursive: true });
  await mkdir(path.join(dir, 'docs', 'web'), { recursive: true });
  await writeFile(path.join(dir, 'docs', 'note.md'), '# note\n');
  // Runners are routed by docs subtree. Every routed path is a .md so the run
  // stays on the MECHANICAL lane (isMechanicalPath) — its full-suite union is
  // exactly the gate under test, and no behavioral test_paths are demanded.
  await writeFile(path.join(dir, 'docs', 'api', 'note.md'), '# api\n');
  await writeFile(path.join(dir, 'docs', 'web', 'note.md'), '# web\n');
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

// One config.runners entry: {id, owns:[glob], root, profile:{full, impacted_template?}}
// with a dedicated full-suite probe (its own counter) and, when template=true,
// a dedicated impacted-suite probe. Distinct probes make full-vs-impacted and
// runner-vs-runner execution independently observable.
function makeRunner(outside, probe, { id, owns, root = '.', fullMode = 'pass', template = false, blockTimeoutMs = 15000 }) {
  const full = makeSuite(outside, probe, `${id}-full`, { mode: fullMode, blockTimeoutMs });
  const impacted = template ? makeSuite(outside, probe, `${id}-impacted`, { mode: 'pass', template: true }) : null;
  const config = {
    id,
    owns,
    root,
    profile: { full: full.command, ...(impacted ? { impacted_template: impacted.command } : {}) },
  };
  return { id, config, full, impacted };
}

// gates.inline_grace_ms=0 forces the deterministic multi-call shape (every poll
// is an explicit `ape_run next`). full_suite_cache defaults false so each gate
// is a real execution the counters attest; the cache tests flip it on.
async function writeConfig(dir, {
  full,
  targeted,
  runners,
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
  if (targeted !== undefined) config.test_commands.targeted = targeted;
  if (Array.isArray(runners)) config.runners = runners;
  await atomicWriteJson(runtimePaths(dir).config, config);
}

// A mechanical run drives run_gates on the PRIMARY (recordReceipt) path, where
// regate_attempts is 0 and ship_requested is unset — the only path on which
// per-runner impacted substitution is eligible.
async function startMechanical(dir, claimed, objective = 'Update the polyglot workspaces') {
  const started = track(await startRun(dir, {
    objective,
    mode: 'phase',
    lane: 'mechanical',
    host: 'codex',
    claimed_paths: claimed,
    test_paths: [],
    requirements: ['R-UNION'],
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

async function mutateBoth(dir) {
  await writeFile(path.join(dir, 'docs', 'api', 'note.md'), '# api\n\nUpdated.\n');
  await writeFile(path.join(dir, 'docs', 'web', 'note.md'), '# web\n\nUpdated.\n');
}

const BOTH_CLAIMS = ['docs/api/note.md', 'docs/web/note.md'];
const OWNS_API = ['docs/api/**'];
const OWNS_WEB = ['docs/web/**'];

// A fast (behavioral) run blocked at the merge gates, so a REGATE re-enters
// run_gates with regate_attempts incremented before the first evaluation —
// forcing every participating runner to run FULL (never impacted). Its receipt
// changed_files (recomputed independently by the runtime) route the union.
async function seedBlockedForRegate(dir, runId, changedFiles) {
  const paths = runtimePaths(dir);
  const tree = await currentTreeSha(dir);
  const blocked = {
    version: 2,
    schema_version: '2.0.0',
    run_id: runId,
    status: 'blocked',
    stage: 'gates',
    block_reason: 'one or more deterministic merge gates failed',
    objective: 'Ship the polyglot bump after fixing the environment',
    mode: 'phase',
    lane: 'fast',
    requested_lane: 'fast',
    lane_reasons: [],
    lane_escalated: false,
    behavioral: true,
    high_risk: false,
    policy: { high_risk_security_review: true },
    host: 'codex',
    claimed_paths: changedFiles,
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
      changed_files: changedFiles,
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

function fullSuiteOf(result) {
  return result.run?.gates?.checks?.full_suite;
}

function runnerEntry(fullSuite, id) {
  return (fullSuite?.runners ?? []).find((entry) => entry.id === id);
}

async function recheckHeldFullGate(dir, held) {
  const paths = runtimePaths(dir);
  const original = await readFile(paths.active, 'utf8');
  const merges = gates.autoMergeGithub.mock.calls.length;
  const remotePolls = gates.pollRemoteChecksAndMerge.mock.calls.length;
  // These legacy gate fixtures carry no frozen shipping admission. Refusal
  // must precede effects; the separate ship suite covers an admitted SHIP.
  expect(await shipRun(dir, 'synthetic operator decision')).toMatchObject({
    ok: false, code: 'shipping-admission-invalid', attempts_consumed: 0,
  });
  expect(await readFile(paths.active, 'utf8')).toBe(original);
  // Evaluate cache/runner behavior using an isolated FULL-selection context,
  // without persisting consent, modifying lifecycle state, or merging.
  // Mirror the production detached union path: the compatibility runMergeGates
  // helper evaluates only a single suite and cannot exercise runner_results.
  const isolated = { ...structuredClone(held.run), ship_requested: true };
  const config = await loadRuntimeConfig(paths.config);
  const start = await gates.startGateSuite(dir, paths, isolated, config);
  let ready = start.hit;
  if (!ready) {
    expect(start.watch).toBeDefined();
    isolated.status = 'gating';
    isolated.stage = 'gates';
    isolated.gates_watch = start.watch;
    trackPid(start.watch.pid);
    for (let attempt = 0; attempt < 150 && !ready; attempt += 1) {
      const poll = await gates.pollGateSuite(dir, paths, isolated, config);
      expect(poll.failed).toBeUndefined();
      if (poll.ready) ready = poll.ready;
      if (poll.pending?.watch) {
        isolated.gates_watch = { ...isolated.gates_watch, ...poll.pending.watch };
        trackPid(isolated.gates_watch.pid);
      }
      if (!ready) await sleep(100);
    }
  }
  expect(ready, 'the isolated detached runner union must finish within the poll budget').toBeDefined();
  const evaluated = await gates.evaluateGates(dir, paths, isolated, config, {
    ...ready.ctx, full: ready.full, cached: ready.cached,
  });
  expect(evaluated.passed).toBe(true);
  expect(await readFile(paths.active, 'utf8')).toBe(original);
  expect(gates.autoMergeGithub.mock.calls.length).toBe(merges);
  expect(gates.pollRemoteChecksAndMerge.mock.calls.length).toBe(remotePolls);
  return evaluated.checks.full_suite;
}

describe('APE v2 sequential-union polyglot merge gate', () => {
  it('unions two green runners into a passing gate with a truthful per-runner full_suite.runners[] (T1)', async () => {
    const { dir, outside, probe } = await makeProject();
    const api = makeRunner(outside, probe, { id: 'api', owns: OWNS_API });
    const web = makeRunner(outside, probe, { id: 'web', owns: OWNS_WEB });
    await writeConfig(dir, { runners: [api.config, web.config], requiredRemoteChecks: true });

    const { result } = await buildToGate(dir, BOTH_CLAIMS, () => mutateBoth(dir));
    const done = await settle(dir, result);

    // RED now: config.runners is ignored, the single suite tooling-fails (no
    // test_commands.full) and the run blocks; full_suite has no runners[] key.
    expect(done.run.status).toBe('completed');
    const fullSuite = fullSuiteOf(done);
    expect(fullSuite.passed).toBe(true);
    expect(typeof fullSuite.tree_sha).toBe('string');
    expect(Array.isArray(fullSuite.runners)).toBe(true);
    expect(fullSuite.runners.map((entry) => entry.id).sort()).toEqual(['api', 'web']);
    for (const id of ['api', 'web']) {
      const entry = runnerEntry(fullSuite, id);
      expect(entry.passed).toBe(true);
      expect(entry.cached).toBe(false);
      expect(entry.mode).toBe('full');
      expect(typeof entry.command).toBe('string');
      expect(typeof entry.result_hash).toBe('string');
    }
    expect(await api.full.executions()).toBe(1);
    expect(await web.full.executions()).toBe(1);
  });

  it('runs the participating runners STRICTLY one at a time — B never starts until A is adopted (T2)', async () => {
    const { dir, outside, probe } = await makeProject();
    // Both suites block on their arm, so each holds the single gate watch until
    // released — the one-at-a-time guarantee is observable via the counters.
    const api = makeRunner(outside, probe, { id: 'api', owns: OWNS_API, fullMode: 'block' });
    const web = makeRunner(outside, probe, { id: 'web', owns: OWNS_WEB, fullMode: 'block' });
    await writeConfig(dir, { runners: [api.config, web.config], requiredRemoteChecks: true });

    const { result } = await buildToGate(dir, BOTH_CLAIMS, () => mutateBoth(dir));
    // RED now: without the wiring the run blocks in-call instead of resting in
    // the detached gating watch.
    expect(result.run.status).toBe('gating');

    // Runner A (api, first by sorted id) launches immediately; runner B (web)
    // must NOT have started while A is still holding the watch.
    expect(await waitFor(async () => (await api.full.executions()) >= 1)).toBe(true);
    expect(await api.full.executions()).toBe(1);
    expect(await web.full.executions()).toBe(0);

    // Extra polls while A is still blocking must NOT start B either.
    for (let i = 0; i < 5; i += 1) {
      track(await nextRun(dir));
      await sleep(100);
    }
    expect(await web.full.executions()).toBe(0);

    // Release A: only after A completes and is adopted does B start.
    await api.full.arm();
    await stepUntil(dir, async () => (await web.full.executions()) >= 1);
    expect(await web.full.executions()).toBeGreaterThanOrEqual(1);
    expect(await api.full.executions()).toBe(1); // A did not re-run

    // Release B and let the union complete.
    await web.full.arm();
    const done = await drivePolls(dir);
    expect(done.run.status).toBe('completed');
    expect(fullSuiteOf(done).runners.map((entry) => entry.passed)).toEqual([true, true]);
  });

  it('fails the union closed when the FIRST runner is red — but still runs the second (T3)', async () => {
    const { dir, outside, probe } = await makeProject();
    const api = makeRunner(outside, probe, { id: 'api', owns: OWNS_API, fullMode: 'fail' });
    const web = makeRunner(outside, probe, { id: 'web', owns: OWNS_WEB, fullMode: 'pass' });
    await writeConfig(dir, { runners: [api.config, web.config], requiredRemoteChecks: true });

    const { result } = await buildToGate(dir, BOTH_CLAIMS, () => mutateBoth(dir));
    const done = await settle(dir, result);

    expect(done.run.status).toBe('blocked');
    const fullSuite = fullSuiteOf(done);
    expect(fullSuite.passed).toBe(false);
    // RED now: today's single-suite full_suite carries no runners[] at all.
    expect(Array.isArray(fullSuite.runners)).toBe(true);
    expect(runnerEntry(fullSuite, 'api').passed).toBe(false);
    expect(runnerEntry(fullSuite, 'web').passed).toBe(true);
    // AND join runs every participating runner, then unions — both executed.
    expect(await api.full.executions()).toBe(1);
    expect(await web.full.executions()).toBe(1);
  });

  it('fails the union closed when the SECOND runner is red (reverse order) (T3)', async () => {
    const { dir, outside, probe } = await makeProject();
    const api = makeRunner(outside, probe, { id: 'api', owns: OWNS_API, fullMode: 'pass' });
    const web = makeRunner(outside, probe, { id: 'web', owns: OWNS_WEB, fullMode: 'fail' });
    await writeConfig(dir, { runners: [api.config, web.config], requiredRemoteChecks: true });

    const { result } = await buildToGate(dir, BOTH_CLAIMS, () => mutateBoth(dir));
    const done = await settle(dir, result);

    expect(done.run.status).toBe('blocked');
    const fullSuite = fullSuiteOf(done);
    expect(fullSuite.passed).toBe(false);
    // RED now: today's single-suite full_suite carries no runners[] at all.
    expect(Array.isArray(fullSuite.runners)).toBe(true);
    expect(runnerEntry(fullSuite, 'api').passed).toBe(true);
    expect(runnerEntry(fullSuite, 'web').passed).toBe(false);
    expect(await api.full.executions()).toBe(1);
    expect(await web.full.executions()).toBe(1);
  });

  it('serves EVERY runner cached-green on a re-evaluation at the same tree, with zero new executions (T4)', async () => {
    const { dir, outside, probe } = await makeProject();
    const api = makeRunner(outside, probe, { id: 'api', owns: OWNS_API });
    const web = makeRunner(outside, probe, { id: 'web', owns: OWNS_WEB });
    // cache ON so the passing runners persist; auto_merge OFF so the passing
    // union HOLDS at merge (not merged), letting a FULL gate re-evaluate the SAME
    // tree where every runner must serve cached-green.
    await writeConfig(dir, {
      runners: [api.config, web.config],
      requiredRemoteChecks: true,
      autoMerge: false,
      cache: true,
    });

    const { result } = await buildToGate(dir, BOTH_CLAIMS, () => mutateBoth(dir));
    const held = await settle(dir, result);
    // RED now: the single suite tooling-fails and the run blocks at stage
    // 'gates' with no runners[] — never a passing hold at stage 'merge'.
    const firstFull = fullSuiteOf(held);
    expect(Array.isArray(firstFull.runners)).toBe(true);
    expect(firstFull.runners.length).toBe(2);
    expect(held.run.status).toBe('blocked');
    expect(held.run.stage).toBe('merge');
    for (const id of ['api', 'web']) expect(runnerEntry(firstFull, id).cached).toBe(false);
    expect(await api.full.executions()).toBe(1);
    expect(await web.full.executions()).toBe(1);

    // Re-evaluate at the same tree: every runner is served from its own cache
    // entry — counters stay flat and each runners[] entry reports cached:true.
    const shipFull = await recheckHeldFullGate(dir, held);
    for (const id of ['api', 'web']) expect(runnerEntry(shipFull, id).cached).toBe(true);
    expect(await api.full.executions()).toBe(1);
    expect(await web.full.executions()).toBe(1);
  });

  it('launches ONLY the uncached runner when one is already cache-served (T4/T5, per-runner keys)', async () => {
    const { dir, outside, probe } = await makeProject();
    // api owns both trees so it participates alone in the first gate; web is
    // added for the re-evaluation and is genuinely uncached under any key shape.
    const api = makeRunner(outside, probe, { id: 'api', owns: ['docs/api/**', 'docs/web/**'] });
    const web = makeRunner(outside, probe, { id: 'web', owns: OWNS_WEB });
    await writeConfig(dir, {
      runners: [api.config],
      requiredRemoteChecks: true,
      autoMerge: false,
      cache: true,
    });

    const { result } = await buildToGate(dir, BOTH_CLAIMS, () => mutateBoth(dir));
    const held = await settle(dir, result);
    const firstFull = fullSuiteOf(held);
    expect(Array.isArray(firstFull.runners)).toBe(true);
    expect(held.run.stage).toBe('merge');
    expect(await api.full.executions()).toBe(1);
    expect(await web.full.executions()).toBe(0);

    // Add web and re-evaluate: api serves from cache (counter FLAT), only the
    // uncached web launches. api's cache entry never answers web.
    await writeConfig(dir, {
      runners: [api.config, web.config],
      requiredRemoteChecks: true,
      autoMerge: false,
      cache: true,
    });
    const shipFull = await recheckHeldFullGate(dir, held);
    expect(runnerEntry(shipFull, 'api').cached).toBe(true);
    expect(runnerEntry(shipFull, 'web').cached).toBe(false);
    expect(await api.full.executions()).toBe(1); // served, never re-ran
    expect(await web.full.executions()).toBe(1); // the only fresh execution
  });

  it('never lets a runner IMPACTED cache entry satisfy that runner FULL suite at one tree (T5)', async () => {
    const { dir, outside, probe } = await makeProject();
    // One runner with both a full and an impacted profile; cache ON, auto_merge
    // OFF so the impacted pass HOLDS at merge, then the evaluator re-runs FULL.
    const api = makeRunner(outside, probe, { id: 'api', owns: OWNS_API, template: true });
    await writeConfig(dir, {
      runners: [api.config],
      requiredRemoteChecks: true,
      autoMerge: false,
      cache: true,
    });

    const { result } = await buildToGate(dir, ['docs/api/note.md'], () =>
      writeFile(path.join(dir, 'docs', 'api', 'note.md'), '# api\n\nUpdated.\n'));
    const held = await settle(dir, result);
    const impactedFull = fullSuiteOf(held);
    // RED now: no runners[] and no impacted per-runner mode exist today.
    expect(runnerEntry(impactedFull, 'api')?.mode).toBe('impacted');
    expect(held.run.stage).toBe('merge');
    expect(await api.impacted.executions()).toBe(1);
    expect(await api.full.executions()).toBe(0);

    // The isolated ship-selection context re-runs the runner's FULL suite: the impacted
    // cache entry must NOT satisfy the distinct full key at the same tree.
    const shipEntry = runnerEntry(await recheckHeldFullGate(dir, held), 'api');
    expect(shipEntry.mode).toBe('full');
    expect(shipEntry.cached).toBe(false);
    expect(await api.full.executions()).toBe(1);
  });

  it('forces every participating runner to run its FULL suite serially on a regate — never impacted (T7)', async () => {
    const { dir, outside, probe } = await makeProject();
    const api = makeRunner(outside, probe, { id: 'api', owns: OWNS_API, template: true });
    const web = makeRunner(outside, probe, { id: 'web', owns: OWNS_WEB, template: true });
    const targeted = makeSuite(outside, probe, 'targeted', { mode: 'pass' });
    await seedBlockedForRegate(dir, 'run-union-regate', BOTH_CLAIMS);
    await writeConfig(dir, {
      runners: [api.config, web.config],
      targeted: targeted.command,
      requiredRemoteChecks: true,
    });

    const regate = track(await regateRun(dir));
    expect(regate.ok).toBe(true);
    const done = await settle(dir, regate);

    // RED now: config.runners is ignored, the single suite tooling-fails on the
    // recovery path, and the run stays blocked.
    expect(done.run.status).toBe('completed');
    const fullSuite = fullSuiteOf(done);
    expect(fullSuite.runners.map((entry) => entry.mode).sort()).toEqual(['full', 'full']);
    expect(await api.full.executions()).toBe(1);
    expect(await web.full.executions()).toBe(1);
    // Impacted never runs on a regate, even though both templates are configured.
    expect(await api.impacted.executions()).toBe(0);
    expect(await web.impacted.executions()).toBe(0);
  });

  it('fails the whole union closed on a mid-sequence tree drift and writes no cache entry for that tree (T8, invariant 4)', async () => {
    const { dir, outside, probe } = await makeProject();
    // api runs first (fast pass), web blocks second, giving a window to mutate
    // the tree between runner A completing and runner B being adopted.
    const api = makeRunner(outside, probe, { id: 'api', owns: OWNS_API });
    const web = makeRunner(outside, probe, { id: 'web', owns: OWNS_WEB, fullMode: 'block' });
    await writeConfig(dir, { runners: [api.config, web.config], requiredRemoteChecks: true, cache: true });

    const { result } = await buildToGate(dir, BOTH_CLAIMS, () => mutateBoth(dir));
    // RED now: the run blocks in-call rather than resting in the gating watch.
    expect(result.run.status).toBe('gating');

    // Step until the second runner (web) has started — proving api was adopted.
    await stepUntil(dir, async () => (await web.full.executions()) >= 1);
    expect(await api.full.executions()).toBe(1);
    expect(await web.full.executions()).toBeGreaterThanOrEqual(1);

    const cacheFile = path.join(runtimePaths(dir).runtime, 'suite-cache.json');
    const before = Object.keys((await readJson(cacheFile, { results: {} })).results).length;

    // Invariant 4: mutate the project tree while web still holds the watch. The
    // next poll recomputes the tree, detects the drift, and fails the union
    // closed — no runner's result may be adopted at the drifted tree.
    await writeFile(path.join(dir, 'drift.txt'), 'external write\n');
    const blocked = await drivePolls(dir, { tries: 60, delay: 100 });
    expect(blocked.run.status).toBe('blocked');

    const after = Object.keys((await readJson(cacheFile, { results: {} })).results).length;
    expect(after).toBe(before); // no new suite-cache entry persisted for the drifted tree
  });

  it('fails closed and runs ZERO runner suites when block_on_orphan meets an unowned change (T10)', async () => {
    const { dir, outside, probe } = await makeProject({ 'docs/orphan/note.md': '# orphan\n' });
    const api = makeRunner(outside, probe, { id: 'api', owns: OWNS_API });
    const web = makeRunner(outside, probe, { id: 'web', owns: OWNS_WEB });
    // A plain full-suite pass command makes TODAY's runners-ignored gate PASS —
    // so `blocked` is a clean multi-runner-only red anchor — while the wired
    // gate must fail closed on the orphan (a changed .md owned by no runner)
    // before running any runner suite.
    const fallback = makeSuite(outside, probe, 'fallback', { mode: 'pass' });
    await writeConfig(dir, {
      full: fallback.command,
      runners: [api.config, web.config],
      requiredRemoteChecks: true,
      gates: { block_on_orphan: true },
    });

    const { result } = await buildToGate(dir, ['docs/orphan/note.md'], () =>
      writeFile(path.join(dir, 'docs', 'orphan', 'note.md'), '# orphan\n\nUpdated.\n'));
    const done = await settle(dir, result);

    expect(done.run.status).toBe('blocked');
    expect(await api.full.executions()).toBe(0);
    expect(await web.full.executions()).toBe(0);
  });

  it('is byte-identical to today when config.runners is unset: single-suite full_suite with NO runners[] key (T9 regression)', async () => {
    const { dir, outside, probe } = await makeProject();
    const full = makeSuite(outside, probe, 'full', { mode: 'pass' });
    // No runners configured — the gate must behave EXACTLY as today. This guard
    // is intentionally green both before and after the implementation lands.
    await writeConfig(dir, { full: full.command, requiredRemoteChecks: true });

    const { result } = await buildToGate(dir, ['docs/note.md'], () =>
      writeFile(path.join(dir, 'docs', 'note.md'), '# note\n\nUpdated.\n'));
    const done = await settle(dir, result);

    expect(done.run.status).toBe('completed');
    const fullSuite = fullSuiteOf(done);
    expect(fullSuite.passed).toBe(true);
    expect(fullSuite.cached).toBe(false);
    expect(fullSuite.command).toBe(full.command);
    expect(typeof fullSuite.tree_sha).toBe('string');
    // The single-suite shape carries NO runners[] key.
    expect(fullSuite.runners).toBeUndefined();
    expect(await full.executions()).toBe(1);
  });
});

// Pure predicate (invariant 9 auto-merge guard). Extends today's single-.mode
// refusal to the multi-runner runners[] shape: refuse when ANY participating
// runner ran impacted while required remote checks are off and no ship was
// authorized. The multi-runner refusal case is the red anchor — today's guard
// only inspects full_suite.mode, so a runners[] impacted verdict is (wrongly)
// allowed now.
describe('APE v2 impactedMergeGuard over the multi-runner union (T6)', () => {
  const multi = (modes) => ({
    passed: true,
    tree_sha: 'a'.repeat(40),
    runners: modes.map((mode, index) => ({
      id: `r${index}`,
      passed: true,
      cached: false,
      command: `cmd-${index}`,
      mode,
      result_hash: `h${index}`,
    })),
  });
  const stateWith = (fullSuite, shipRequested = false) => ({
    gates: { passed: true, checks: { full_suite: fullSuite } },
    ship_requested: shipRequested,
  });
  const remoteOff = { shipping: { required_remote_checks: false } };
  const remoteOn = { shipping: { required_remote_checks: true } };

  it('refuses a multi-runner merge whose union contains an impacted runner with remote checks off and no ship', () => {
    // RED now: the current guard reads full_suite.mode (undefined here) and
    // returns false — it does not inspect the per-runner union verdicts.
    expect(gates.impactedMergeGuard(stateWith(multi(['full', 'impacted'])), remoteOff)).toBe(true);
  });

  it('allows the multi-runner union when remote checks are on, a ship is authorized, or every runner ran full', () => {
    expect(gates.impactedMergeGuard(stateWith(multi(['full', 'impacted'])), remoteOn)).toBe(false);
    expect(gates.impactedMergeGuard(stateWith(multi(['full', 'impacted']), true), remoteOff)).toBe(false);
    expect(gates.impactedMergeGuard(stateWith(multi(['full', 'full'])), remoteOff)).toBe(false);
  });

  it('keeps the existing single-suite full_suite.mode behavior intact', () => {
    const impacted = { passed: true, mode: 'impacted' };
    const full = { passed: true };
    expect(gates.impactedMergeGuard(stateWith(impacted), remoteOff)).toBe(true);
    expect(gates.impactedMergeGuard(stateWith(impacted), remoteOn)).toBe(false);
    expect(gates.impactedMergeGuard(stateWith(impacted, true), remoteOff)).toBe(false);
    expect(gates.impactedMergeGuard(stateWith(full), remoteOff)).toBe(false);
  });
});
