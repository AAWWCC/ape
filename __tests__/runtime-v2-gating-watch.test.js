import { execFileSync, spawnSync } from 'node:child_process';
import { access, mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

// The non-blocking merge-gate feature (`gating` status + state.gates_watch)
// mirrors the #261 shipping-watch architecture: recording the final review
// receipt (or a regate/ship) starts the full suite in a DETACHED runner and
// rests the run in the new, non-terminal, non-sealed status `gating` instead of
// holding the MCP call for the whole suite. Each `ape_run next` is ONE bounded
// poll that, when the artifact is ready, evaluates the remaining checks in-call
// and transitions exactly as today (shipping/completed/blocked).
//
// Ship (GitHub) is the only runtime-owned side effect these behavioral tests
// must not perform for real: the auto-merge is mocked (no watch key => merged
// in-call), while runMergeGates, the new detached gate machinery, and the poll
// evaluation run genuinely. importOriginal keeps everything else real.
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
    // pollGateSuite stays a transparent passthrough to the REAL implementation
    // by default (every existing test still exercises the genuine detached
    // runner poll). One test — the shipped-default inline-grace anchor — swaps
    // in a deterministic ready artifact via mockImplementation and afterEach
    // restores this delegating default, so the swap never leaks.
    pollGateSuite: vi.fn((...args) => actual.pollGateSuite(...args)),
  };
});
import { autoMergeGithub, pollGateSuite } from '../lib/runtime/gates.js';
import {
  abortRun,
  nextRun,
  recordReceipt,
  regateRun,
  resumeRun,
  startRun,
} from '../lib/runtime/service.js';
import { evaluateLifecyclePolicy } from '../lib/runtime/hooks.js';
import { renderStatusDoc } from '../lib/runtime/status-doc.js';
import { archiveRun, queryHistory } from '../lib/runtime/history.js';
import { currentTreeSha } from '../lib/runtime/git.js';
import { runtimePaths } from '../lib/runtime/paths.js';
import { atomicWriteJson, readJson } from '../lib/runtime/storage.js';

// These tests do real filesystem work (git init/add/commit, spawned detached
// gate runners) so a loaded runner can legitimately take several seconds; the
// 30s budget keeps the slow-but-honest tests off the 15s default, and the rm
// retry rides out win32 EBUSY that `force` alone does not retry.
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

async function waitFor(predicate, { tries = 120, delay = 50 } = {}) {
  for (let i = 0; i < tries; i += 1) {
    if (await predicate()) return true;
    await sleep(delay);
  }
  return false;
}

// Drive `ape_run next` repeatedly until the gating run leaves the poll (each
// next is one bounded poll). Never reached on the current tree — the earlier
// `status === 'gating'` red anchor throws first — so this only runs against a
// correct implementation.
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

// Per-test spies that MUST NOT leak into sibling suites: the monotonic
// Date.now stub (the inline-grace red mechanism) and the deterministic
// pollGateSuite override. defaultPollImpl captures the factory's delegating
// passthrough once, so afterEach can restore the REAL poll for every other test.
let dateNowSpy = null;
let defaultPollImpl = null;
beforeAll(() => {
  defaultPollImpl = pollGateSuite.getMockImplementation();
});

const cleanups = [];
afterEach(async () => {
  // Restore the virtual clock and the delegating pollGateSuite FIRST so the
  // inflated Date.now and the ready-artifact stub can never bleed into the
  // pid-liveness/rm teardown below or the next test's REAL detached-runner poll.
  if (dateNowSpy) {
    dateNowSpy.mockRestore();
    dateNowSpy = null;
  }
  if (defaultPollImpl) pollGateSuite.mockImplementation(defaultPollImpl);
  autoMergeGithub.mockClear();
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

// A controllable full-suite command whose script lives OUTSIDE the project so
// its executions never perturb the project tree SHA (a gate command that moved
// the tree would fail tree_binding). It records every execution in a counter,
// writes a `started` sentinel carrying its own pid, dumps whether
// APE_GATE_RUNNER_JOB is visible in its environment, and — in `block` mode —
// waits for an `arm` marker (writing a `finished` sentinel on release, or
// failing at a bounded self-timeout). `auto` mode is non-blocking: it passes
// iff the arm marker already exists, else fails fast.
const PROBE_SRC = [
  "const fs = require('node:fs');",
  'const [counter, started, envdump, arm, finished, mode, timeoutStr] = process.argv.slice(2);',
  "try { fs.appendFileSync(counter, 'x'); } catch (e) {}",
  'try { fs.writeFileSync(started, String(process.pid)); } catch (e) {}',
  'try {',
  '  fs.writeFileSync(envdump, JSON.stringify({',
  "    has_job: 'APE_GATE_RUNNER_JOB' in process.env,",
  '    job: process.env.APE_GATE_RUNNER_JOB || null,',
  '  }));',
  '} catch (e) {}',
  "if (mode === 'auto') {",
  "  if (fs.existsSync(arm)) { try { fs.writeFileSync(finished, 'done'); } catch (e) {} process.exit(0); }",
  '  process.exit(1);',
  '}',
  "const deadline = Date.now() + Number(timeoutStr || '5000');",
  'const wait = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);',
  'while (!fs.existsSync(arm)) {',
  '  if (Date.now() >= deadline) { process.exit(1); }',
  '  wait(50);',
  '}',
  "try { fs.writeFileSync(finished, 'done'); } catch (e) {}",
  'process.exit(0);',
].join('\n');

async function makeProject(extraFiles = {}) {
  const dir = await mkdtemp(path.join(tmpdir(), 'ape-gating-'));
  const outside = await mkdtemp(path.join(tmpdir(), 'ape-gating-out-'));
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

function makeSuite(outside, probe, name, mode = 'block', timeoutMs = 5000) {
  const counter = path.join(outside, `${name}.counter`);
  const started = path.join(outside, `${name}.started`);
  const finished = path.join(outside, `${name}.finished`);
  const envdump = path.join(outside, `${name}.env.json`);
  const armPath = path.join(outside, `${name}.arm`);
  return {
    command: `node "${probe}" "${counter}" "${started}" "${envdump}" "${armPath}" "${finished}" ${mode} ${timeoutMs}`,
    arm: () => writeFile(armPath, 'go\n'),
    executions: async () => {
      try {
        return (await readFile(counter, 'utf8')).length;
      } catch {
        return 0;
      }
    },
    startedExists: () => exists(started),
    finishedExists: () => exists(finished),
    startedPid: async () => {
      try {
        return Number((await readFile(started, 'utf8')).trim());
      } catch {
        return null;
      }
    },
    env: async () => {
      try {
        return JSON.parse(await readFile(envdump, 'utf8'));
      } catch {
        return null;
      }
    },
  };
}

// gates.inline_grace_ms=0 forces the deterministic multi-call shape: record
// rests in gating with no inline grace poll, so every poll is an explicit
// `ape_run next`. full_suite_cache=false keeps each gate a real execution so the
// suite's own side effects (the counter) attest re-execution vs. reuse.
async function writeConfig(dir, { full, autoMerge = true, cache = false, graceMs = 0, omitInlineGrace = false, deadlines, staleMs, maxSpawns, pollRetryDelayMs } = {}) {
  const config = {
    shipping: { auto_merge: autoMerge, provider: 'github', required_remote_checks: false },
    policy: { full_suite_cache: cache },
    // omitInlineGrace leaves the gates subtree WITHOUT an inline_grace_ms key, so
    // loadRuntimeConfig merges DEFAULT_CONFIG and the SHIPPED default
    // (GATE_INLINE_GRACE_MS) is what service.js resolves. Every existing caller
    // keeps the explicit inline_grace_ms=0 that forces the multi-call shape.
    gates: omitInlineGrace ? {} : { inline_grace_ms: graceMs },
  };
  // N-e overrides: a lowered stale_ms lets a poll treat a live-but-recorded-dead
  // runner as stale; a max_spawns cap forces spawn exhaustion.
  if (staleMs !== undefined) config.gates.stale_ms = staleMs;
  if (maxSpawns !== undefined) config.gates.max_spawns = maxSpawns;
  // The wait_ms poll-loop tests pin poll_retry_delay_ms=0 so the loop's
  // inter-poll sleep is governed purely by GATE_NEXT_POLL_FLOOR_MS (the pending
  // poll's advisory retry_after_ms falls to 0, exposing the floor). Additive:
  // existing callers omit it, so config.gates stays byte-identical.
  if (pollRetryDelayMs !== undefined) config.gates.poll_retry_delay_ms = pollRetryDelayMs;
  if (full !== undefined) config.test_commands = { full };
  if (deadlines !== undefined) config.deadlines_ms = deadlines;
  await atomicWriteJson(runtimePaths(dir).config, config);
}

// A run blocked at the merge gates (status 'blocked', stage 'gates') with one
// attested receipt bound to the current tree — the state REGATE re-enters
// run_gates from. Mirrors the regate suite's blockedAtGates fixture. The F7
// block-time record is archived so a superseding completion can reference it.
async function seedBlockedAtGates(dir, runId) {
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
    lane: 'mechanical',
    requested_lane: 'mechanical',
    lane_reasons: [],
    lane_escalated: false,
    behavioral: false,
    high_risk: false,
    policy: { high_risk_security_review: true },
    host: 'codex',
    claimed_paths: ['src/value.js'],
    test_paths: [],
    requirements: ['R-gate'],
    risk_triggers: [],
    branch: 'ape/phase-gate',
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
    timing: { test_ms: 1_000, remote_ci_ms: 0 },
    created_at: '2026-07-01T00:00:00.000Z',
    updated_at: '2026-07-01T00:00:00.000Z',
    terminal_at: '2026-07-01T00:00:00.000Z',
  };
  await atomicWriteJson(paths.active, blocked);
  await archiveRun(paths, blocked, { ifAbsent: true });
  return { paths, tree };
}

// Start a mechanical run and record its single build receipt — the reduction
// that drives run_gates on the primary (recordReceipt) path. Mirrors the ship
// suite's buildToHold.
async function buildToGate(dir) {
  const started = track(await startRun(dir, {
    objective: 'Update the documentation note',
    mode: 'phase',
    lane: 'mechanical',
    host: 'codex',
    claimed_paths: ['docs/note.md'],
    test_paths: [],
    requirements: ['R-GATE'],
    risk_triggers: [],
    behavioral: false,
    hooks_trusted: true,
    subagents_available: true,
    explicit_invocation: true,
  }));
  expect(started.ok).toBe(true);
  const build = started.run.tickets[0];
  expect(build.role).toBe('implementer');
  await writeFile(path.join(dir, 'docs', 'note.md'), '# note\n\nUpdated.\n');
  const result = track(await recordReceipt(dir, {
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
  return { runId: started.run.run_id, result };
}

// Locate the spawned gate job descriptor under .ape/runtime/gate-suite/ (the
// detached runner's scratch space). The job is the file carrying a numeric
// suite timeout_ms (A5). Reading the throwaway project's own .ape is ordinary
// test inspection, exactly like reading active.json.
async function readGateJob(paths) {
  const dir = path.join(paths.runtime, 'gate-suite');
  let entries;
  try {
    entries = await readdir(dir);
  } catch {
    return null;
  }
  for (const name of entries) {
    try {
      const data = await readJson(path.join(dir, name), null);
      if (data && typeof data === 'object' && typeof data.timeout_ms === 'number') return data;
    } catch {
      // not a JSON descriptor; skip
    }
  }
  return null;
}

describe('APE v2 gating watch — non-blocking, resumable local merge gates', () => {
  it('records the final receipt without holding the call: rests in gating while the detached suite runs (a, A7)', async () => {
    const { dir, outside, probe } = await makeProject();
    const suite = makeSuite(outside, probe, 'full', 'block', 5000);
    await writeConfig(dir, { full: suite.command });
    const paths = runtimePaths(dir);
    const { runId, result } = await buildToGate(dir);

    // Red anchor: with inline_grace_ms=0 the record MUST rest in the new,
    // non-terminal `gating` status instead of holding the MCP call for the full
    // suite (current tree runs the suite in-call and returns blocked/completed).
    expect(result.ok).toBe(true);
    expect(result.run.status).toBe('gating');
    expect(result.run.stage).toBe('gates');
    expect(result.run.gates_watch).toBeTruthy();

    // The run lock stays held for the poll phase and nothing is archived yet.
    expect(await exists(paths.lock)).toBe(true);
    const early = await queryHistory(paths, { run_id: runId });
    expect(early.some((record) => ['completed', 'blocked'].includes(record.status))).toBe(false);

    // A7 causal proof (no wall-clock ε): the detached suite genuinely STARTED
    // (started-sentinel present) but has NOT finished while the run rests in
    // gating.
    expect(await waitFor(() => suite.startedExists())).toBe(true);
    expect(await suite.finishedExists()).toBe(false);
    expect((await readJson(paths.active)).status).toBe('gating');

    // Resumable poll: once the suite finishes, next evaluates and completes.
    await suite.arm();
    const done = await drivePolls(dir);
    expect(done.ok).toBe(true);
    expect(done.run.status).toBe('completed');
    expect(done.run.gates_watch ?? null).toBe(null);
    expect(await exists(paths.lock)).toBe(false);
    const records = await queryHistory(paths, { run_id: runId });
    expect(records.some((record) => record.status === 'completed')).toBe(true);
  });

  it('each next is one bounded poll: a pending poll rests and records the cursor, a ready poll completes (b, resumable)', async () => {
    const { dir, outside, probe } = await makeProject();
    const suite = makeSuite(outside, probe, 'full', 'block', 5000);
    await writeConfig(dir, { full: suite.command });
    const { paths } = await seedBlockedAtGates(dir, 'run-gate-poll');

    const regate = track(await regateRun(dir));
    expect(regate.ok).toBe(true);
    expect(regate.run.status).toBe('gating'); // red anchor
    expect(regate.run.gates_watch).toBeTruthy();
    expect(await exists(paths.lock)).toBe(true);
    expect(await waitFor(() => suite.startedExists())).toBe(true);

    // One bounded poll while the suite is still running: stays gating, records
    // the poll cursor, archives nothing, keeps the lock.
    const pending = track(await nextRun(dir));
    expect(pending.ok).toBe(true);
    expect(pending.run.status).toBe('gating');
    const active = await readJson(paths.active);
    expect(active.gates_watch.poll_count).toBe(1);
    expect(active.gates_watch.last_poll_at).toBeTruthy();
    expect(await exists(paths.lock)).toBe(true);
    const mid = await queryHistory(paths, { run_id: 'run-gate-poll' });
    expect(mid.some((record) => record.status === 'completed')).toBe(false);

    // resume must not itself drive the poll to completion (guidance arm): the
    // run stays gating.
    const resumed = track(await resumeRun(dir));
    expect(resumed.ok).toBe(true);
    expect((await readJson(paths.active)).status).toBe('gating');

    // Once the suite finishes, a later poll evaluates and completes.
    await suite.arm();
    const done = await drivePolls(dir);
    expect(done.run.status).toBe('completed');
    expect(done.run.gates_watch ?? null).toBe(null);
    expect(await exists(paths.lock)).toBe(false);
  });

  it('fails closed when the working tree changes after the gate suite starts (c, F4 tree-binding)', async () => {
    const { dir, outside, probe } = await makeProject();
    const suite = makeSuite(outside, probe, 'full', 'auto');
    await writeConfig(dir, { full: suite.command });
    await seedBlockedAtGates(dir, 'run-gate-treechange');
    // The suite itself would pass; the tree change is what must block the gate.
    await suite.arm();

    const regate = track(await regateRun(dir));
    expect(regate.run.status).toBe('gating'); // red anchor

    // A tree change between start and completion invalidates the artifact
    // fail-closed: the detached result is bound ONLY to the tree it ran on.
    await writeFile(path.join(dir, 'src', 'value.js'), 'export const value = 999;\n');
    const done = await drivePolls(dir);
    expect(done.ok).toBe(true);
    expect(done.run.status).toBe('blocked');
    expect(done.run.status).not.toBe('completed');
    expect(done.run.stage).toBe('gates');
  });

  it('classifies a failing detached gate honestly as a gate block, never a pass (d, runner-failure honesty)', async () => {
    const { dir, outside, probe } = await makeProject();
    const suite = makeSuite(outside, probe, 'full', 'auto'); // unarmed => fails fast
    await writeConfig(dir, { full: suite.command });
    await seedBlockedAtGates(dir, 'run-gate-fail');

    const regate = track(await regateRun(dir));
    expect(regate.run.status).toBe('gating'); // red anchor

    const done = await drivePolls(dir);
    expect(done.ok).toBe(true);
    expect(done.run.status).toBe('blocked');
    expect(done.run.stage).toBe('gates');
    expect(done.run.status).not.toBe('completed');

    // The honest gate block is regate-recoverable (accepted, not refused).
    const again = track(await regateRun(dir));
    expect(again.ok).toBe(true);
  });

  it('does not respawn a second suite run while the recorded runner is alive (A2 respawn fence)', async () => {
    const { dir, outside, probe } = await makeProject();
    const suite = makeSuite(outside, probe, 'full', 'block', 5000);
    await writeConfig(dir, { full: suite.command });
    await seedBlockedAtGates(dir, 'run-gate-veto');

    const regate = track(await regateRun(dir));
    expect(regate.run.status).toBe('gating'); // red anchor
    expect(await waitFor(() => suite.startedExists())).toBe(true);
    expect(await suite.executions()).toBe(1);

    // A live same-host runner VETOES respawn: polling while it is still working
    // starts no second suite execution.
    const poll = track(await nextRun(dir));
    expect(poll.ok).toBe(true);
    expect(poll.run.status).toBe('gating');
    expect(await suite.executions()).toBe(1);

    // The single runner drives the run to completion — still exactly one run.
    await suite.arm();
    const done = await drivePolls(dir);
    expect(done.run.status).toBe('completed');
    expect(await suite.executions()).toBe(1);
  });

  it('respawns exactly one dead gate runner and completes after arming (N-e, A2 dead-runner respawn)', async () => {
    const { dir, outside, probe } = await makeProject();
    const suite = makeSuite(outside, probe, 'full', 'block', 8000);
    // A stale_ms of 0 makes any recorded heartbeat instantly stale, so the
    // respawn fence hinges purely on the recorded pid being not-alive.
    await writeConfig(dir, { full: suite.command, staleMs: 0 });
    const { paths } = await seedBlockedAtGates(dir, 'run-gate-respawn');

    const regate = track(await regateRun(dir));
    expect(regate.run.status).toBe('gating'); // red anchor (base feature)
    expect(await waitFor(() => suite.startedExists())).toBe(true);
    expect(await suite.executions()).toBe(1);

    // Rewrite the recorded runner to a provably-dead pid and drop its heartbeat:
    // the next poll must treat the runner as dead and respawn once.
    const deadPid = spawnSync(process.execPath, ['-e', '']).pid; // exited, pid is free
    const active = await readJson(paths.active);
    // Ledger the live gen-1 runner pid before the fixture overwrites it with the
    // dead pid, so teardown can kill the still-blocking gen-1 runner.
    trackPid(active.gates_watch?.pid);
    const heartbeatFile = active.gates_watch.heartbeat_file;
    active.gates_watch = { ...active.gates_watch, pid: deadPid };
    await atomicWriteJson(paths.active, active);
    await rm(heartbeatFile, { force: true }).catch(() => {});

    // One poll → exactly one respawn: spawn_attempts increments, a second suite
    // execution starts, and the run stays gating (never a pass without a verdict).
    const poll = track(await nextRun(dir));
    expect(poll.ok).toBe(true);
    expect(poll.run.status).toBe('gating');
    expect(await waitFor(() =>
      readJson(paths.active).then((state) => (state.gates_watch?.spawn_attempts ?? 0) >= 2))).toBe(true);
    expect(await waitFor(() => suite.executions().then((count) => count >= 2))).toBe(true);

    // The respawned runner drives the run to completion — exactly one respawn.
    await suite.arm();
    const done = await drivePolls(dir);
    expect(done.run.status).toBe('completed');
    expect(await suite.executions()).toBe(2);
  });

  it('fails the gate closed on spawn exhaustion, never a pass, and a regate recovers (N-e)', async () => {
    const { dir, outside, probe } = await makeProject();
    const suite = makeSuite(outside, probe, 'full', 'block', 20000);
    // max_spawns:1 means the initial spawn already exhausts the budget: a
    // recorded-dead runner with no artifact can produce no verdict.
    await writeConfig(dir, { full: suite.command, staleMs: 0, maxSpawns: 1 });
    const { paths } = await seedBlockedAtGates(dir, 'run-gate-exhaust');

    const regate = track(await regateRun(dir));
    expect(regate.run.status).toBe('gating'); // red anchor (base feature)
    expect(await waitFor(() => suite.startedExists())).toBe(true);

    const deadPid = spawnSync(process.execPath, ['-e', '']).pid;
    const active = await readJson(paths.active);
    // Ledger the live runner pid before the fixture overwrites it with the dead
    // pid, so teardown can kill the still-blocking runner.
    trackPid(active.gates_watch?.pid);
    const heartbeatFile = active.gates_watch.heartbeat_file;
    active.gates_watch = { ...active.gates_watch, pid: deadPid };
    await atomicWriteJson(paths.active, active);
    await rm(heartbeatFile, { force: true }).catch(() => {});

    // The poll cannot respawn (attempts already at the cap) and has no verdict:
    // it must fail the gate closed with an honest reason, never a pass.
    const done = await drivePolls(dir);
    expect(done.run.status).toBe('blocked');
    expect(done.run.stage).toBe('gates');
    expect(done.run.status).not.toBe('completed');
    expect(done.run.block_reason).toMatch(/spawn attempts|not alive|without.*verdict/i);

    // The honest gate block is regate-recoverable (accepted, not refused).
    const again = track(await regateRun(dir));
    expect(again.ok).toBe(true);
  });

  it('never reuses a prior detached result: a regate re-executes the suite (A1, full_suite_cache=false)', async () => {
    const { dir, outside, probe } = await makeProject();
    const suite = makeSuite(outside, probe, 'full', 'auto');
    await writeConfig(dir, { full: suite.command });
    await seedBlockedAtGates(dir, 'run-gate-a1');

    // First regate: suite unarmed => the detached run fails => gate block.
    const regate1 = track(await regateRun(dir));
    expect(regate1.run.status).toBe('gating'); // red anchor
    const blocked = await drivePolls(dir);
    expect(blocked.run.status).toBe('blocked');
    expect(await suite.executions()).toBe(1);

    // Fix the environment and re-gate: a stale FAILED result at this exact
    // tree+command is NOT adopted — the suite re-executes and can pass.
    await suite.arm();
    const regate2 = track(await regateRun(dir));
    expect(regate2.run.status).toBe('gating');
    const done = await drivePolls(dir);
    expect(done.run.status).toBe('completed');
    expect(await suite.executions()).toBe(2);
  });

  it('auto-detects the runner when test_commands.full is absent and gates green through the detached runner (A3)', async () => {
    const { dir } = await makeProject({
      'package.json': JSON.stringify({ name: 'p', version: '1.0.0', scripts: { test: 'node --version' } }),
    });
    // No test_commands.full: the parent must auto-detect (detectTestRunner ->
    // npm test) and the gate must still work through the detached runner.
    await writeConfig(dir, {});
    await seedBlockedAtGates(dir, 'run-gate-autodetect');

    const regate = track(await regateRun(dir));
    expect(regate.ok).toBe(true);
    expect(regate.run.status).toBe('gating'); // red anchor
    const done = await drivePolls(dir);
    expect(done.ok).toBe(true);
    expect(done.run.status).toBe('completed');
  });

  it('scrubs APE_GATE_RUNNER_JOB from the gate suite environment (A4)', async () => {
    const { dir, outside, probe } = await makeProject();
    const suite = makeSuite(outside, probe, 'full', 'auto');
    await writeConfig(dir, { full: suite.command });
    await seedBlockedAtGates(dir, 'run-gate-envscrub');
    await suite.arm();

    const regate = track(await regateRun(dir));
    expect(regate.run.status).toBe('gating'); // red anchor
    const done = await drivePolls(dir);
    expect(done.run.status).toBe('completed');

    // The runner uses APE_GATE_RUNNER_JOB to find its job, but must scrub it
    // from the suite grandchild's environment.
    const env = await suite.env();
    expect(env).toBeTruthy();
    expect(env.has_job).toBe(false);
  });

  it('spawns the gate job with a finite suite timeout_ms (A5)', async () => {
    const { dir, outside, probe } = await makeProject();
    const suite = makeSuite(outside, probe, 'full', 'block', 5000);
    await writeConfig(dir, { full: suite.command });
    const { paths } = await seedBlockedAtGates(dir, 'run-gate-jobtimeout');

    const regate = track(await regateRun(dir));
    expect(regate.run.status).toBe('gating'); // red anchor

    const job = await readGateJob(paths);
    expect(job).toBeTruthy();
    expect(Number.isFinite(job.timeout_ms)).toBe(true);
    expect(job.timeout_ms).toBeGreaterThan(0);

    // Release the runner so the run does not dangle.
    await suite.arm();
    await drivePolls(dir);
  });

  it('arms the 30-minute suite fallback in the job when the configured deadline is non-finite (A5)', async () => {
    const { dir, outside, probe } = await makeProject();
    const suite = makeSuite(outside, probe, 'full', 'block', 5000);
    await writeConfig(dir, { full: suite.command, deadlines: { mechanical: null } });
    const { paths } = await seedBlockedAtGates(dir, 'run-gate-fallback');

    const regate = track(await regateRun(dir));
    expect(regate.run.status).toBe('gating'); // red anchor

    // A job with a non-finite/absent timeout still gets the 30-minute suite
    // fallback: a hung suite can never pend gating forever.
    const job = await readGateJob(paths);
    expect(job).toBeTruthy();
    expect(job.timeout_ms).toBe(30 * 60 * 1000);

    await suite.arm();
    await drivePolls(dir);
  });

  it('abort from gating kills the recorded runner and seals aborted without invoking gh (f, A6)', async () => {
    const { dir, outside, probe } = await makeProject();
    const suite = makeSuite(outside, probe, 'full', 'block', 5000);
    await writeConfig(dir, { full: suite.command });
    const { paths } = await seedBlockedAtGates(dir, 'run-gate-abortkill');

    const regate = track(await regateRun(dir));
    expect(regate.run.status).toBe('gating'); // red anchor
    expect(await waitFor(() => suite.startedExists())).toBe(true);
    const suitePid = await suite.startedPid();
    expect(alive(suitePid)).toBe(true);

    const aborted = track(await abortRun(dir, 'operator abandons the gating run'));
    expect(aborted.ok).toBe(true);
    expect(aborted.run.status).toBe('aborted');
    expect(autoMergeGithub).not.toHaveBeenCalled();
    expect(await exists(paths.lock)).toBe(false);

    // A6: the recorded runner process tree is killed (best-effort) before
    // sealing, so the detached suite grandchild is gone.
    expect(await waitFor(() => !alive(suitePid))).toBe(true);
  });

  it('a successor run does not adopt a prior gating run’s leftover artifact: it re-executes (A6, A1)', async () => {
    const { dir, outside, probe } = await makeProject();
    const suite = makeSuite(outside, probe, 'full', 'block', 8000);
    await writeConfig(dir, { full: suite.command });
    await suite.arm();

    // Run 1 rests in gating; its detached suite finishes and writes an artifact,
    // but run 1 is aborted before any poll consumes it.
    await seedBlockedAtGates(dir, 'run-gate-owner');
    const regate1 = track(await regateRun(dir));
    expect(regate1.run.status).toBe('gating'); // red anchor
    expect(await waitFor(() => suite.finishedExists())).toBe(true);
    await sleep(250); // let the runner persist its result artifact
    const execsAfterRun1 = await suite.executions();
    expect(execsAfterRun1).toBeGreaterThanOrEqual(1);
    const aborted = track(await abortRun(dir, 'abandon run 1 holding a ready artifact'));
    expect(aborted.run.status).toBe('aborted');

    // A fresh run at the SAME tree+command must NOT adopt the dead run's
    // artifact (artifacts are bound to their issuing run) — it re-executes.
    await seedBlockedAtGates(dir, 'run-gate-successor');
    const regate2 = track(await regateRun(dir));
    expect(regate2.run.status).toBe('gating');
    const done = await drivePolls(dir);
    expect(done.run.status).toBe('completed');
    expect(await suite.executions()).toBeGreaterThan(execsAfterRun1);
  });

  it('denies main-session production writes while gating with a status-specific message (e)', () => {
    const result = evaluateLifecyclePolicy(
      {
        host: 'claude',
        event: 'PreToolUse',
        tool_name: 'Write',
        is_subagent: false,
        file: 'src/value.js',
        out_of_project: false,
        path_safe: true,
      },
      { state: { status: 'gating', gates_watch: { poll_count: 0 } }, ticket: null },
    );
    expect(result.decision).toBe('deny');
    // Red anchor: an actionable, status-specific message (like blocked/shipping)
    // — NOT the generic "no active writing run" the current tree returns.
    expect(result.reason).not.toMatch(/no active writing run/);
    expect(result.reason).toMatch(/gat(e|ing)/i);
  });

  it('resolves a sub-grace gate in-call under the shipped default: the record leaves gating (DEFAULT side — red anchor)', async () => {
    const { dir, outside, probe } = await makeProject();
    // auto+armed: the detached runner the parent spawns exits fast (no lingering
    // process), while the single in-call poll is made deterministic below.
    const suite = makeSuite(outside, probe, 'full', 'auto');
    await suite.arm();
    // No inline_grace_ms override → DEFAULT_CONFIG's GATE_INLINE_GRACE_MS is what
    // service.js resolves: the exact value this ticket raises 10_000 → 300_000.
    await writeConfig(dir, { full: suite.command, omitInlineGrace: true });

    // Start the run and prepare the build receipt BEFORE the virtual clock is
    // installed, so ticket issuance keeps real timestamps.
    const started = track(await startRun(dir, {
      objective: 'Update the documentation note',
      mode: 'phase',
      lane: 'mechanical',
      host: 'codex',
      claimed_paths: ['docs/note.md'],
      test_paths: [],
      requirements: ['R-GATE'],
      risk_triggers: [],
      behavioral: false,
      hooks_trusted: true,
      subagents_available: true,
      explicit_invocation: true,
    }));
    expect(started.ok).toBe(true);
    const build = started.run.tickets[0];
    expect(build.role).toBe('implementer');
    await writeFile(path.join(dir, 'docs', 'note.md'), '# note\n\nUpdated.\n');

    // A MONOTONIC virtual clock whose per-call step (15_000ms) sits STRICTLY
    // between the OLD 10s grace and the NEW 300s grace. In service.js's inline
    // grace loop `graceUntil = Date.now() + graceMs` (call A) is tested by the
    // very next `while (Date.now() < graceUntil)` (call B = A + 15_000):
    //   * OLD default 10_000: A + 15_000 > A + 10_000 → the body never runs →
    //     zero inline polls → the run RESTS in `gating` (the red anchor).
    //   * NEW default 300_000: A + 15_000 < A + 300_000 → the loop enters, polls
    //     the ready artifact, and the gate resolves IN-CALL.
    // Only status-irrelevant timing (test_ms) sees the inflated clock — every
    // receipt/archive timestamp uses `new Date()` (real), so admission and the
    // deadline-overrun bookkeeping are untouched. Restored in afterEach.
    const realNow = Date.now();
    let tick = 0;
    dateNowSpy = vi.spyOn(Date, 'now').mockImplementation(() => realNow + (tick++ * 15_000));

    // Make the single in-call poll deterministic (the NEW-default green path): a
    // tree-bound ready artifact (ctx.treeSha === the receipt's head tree) so the
    // REAL evaluateGates passes. Scoped to THIS test — afterEach restores the
    // delegating default so every other suite keeps the genuine runner poll.
    pollGateSuite.mockImplementation(async () => {
      const treeSha = await currentTreeSha(dir);
      const verification = { passed: true, exit_code: 0, duration_ms: 5, output: 'ok' };
      return {
        ready: {
          ctx: {
            treeSha,
            suiteCommand: suite.command,
            suiteMode: 'full',
            suiteInvocation: null,
            impactedPaths: null,
            impactedTemplate: null,
            cachePath: path.join(runtimePaths(dir).runtime, 'suite-cache.json'),
            cache: { schema_version: '2.0.0', results: {} },
            cacheKey: `${treeSha}:full`,
            cacheReadable: false,
            cachedEntry: null,
          },
          full: {
            passed: true,
            tree_sha: treeSha,
            command: suite.command,
            result_hash: 'a'.repeat(64),
            recorded_at: new Date().toISOString(),
            verification,
          },
          cached: true,
          artifact_duration_ms: 5,
        },
      };
    });

    const result = track(await recordReceipt(dir, {
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

    expect(result.ok).toBe(true);
    // RED ANCHOR: at the base tree (default grace 10_000) the loop is never
    // entered, so the record rests in `gating` and this assertion fails. Once the
    // shipped default becomes 300_000 the gate resolves in the single recording
    // call and the run advances past gating.
    expect(result.run.status).not.toBe('gating');
    expect(['completed', 'blocked', 'shipping']).toContain(result.run.status);
  });

  it('honors an explicit gates.inline_grace_ms=0 verbatim: even a ready gate rests in gating and advances only via next (OVERRIDE side — green pre- and post-fix)', async () => {
    const { dir, outside, probe } = await makeProject();
    const suite = makeSuite(outside, probe, 'full', 'auto');
    // Explicit 0 (writeConfig's default) is the operator override that DISABLES
    // the inline grace loop — independent of whatever the shipped default is.
    await writeConfig(dir, { full: suite.command, graceMs: 0 });
    // Arm first so the detached suite's artifact is ready quickly; the record
    // must STILL rest in gating because 0 disables the in-call poll entirely.
    await suite.arm();

    const { result } = await buildToGate(dir);
    expect(result.ok).toBe(true);
    // 0 honored verbatim: no inline poll runs, so even a ready gate rests in the
    // non-terminal `gating` status at BOTH the base tree and post-fix.
    expect(result.run.status).toBe('gating');
    expect(result.run.gates_watch).toBeTruthy();

    // It advances only via an explicit next (each one bounded poll).
    const done = await drivePolls(dir);
    expect(done.ok).toBe(true);
    expect(done.run.status).toBe('completed');
    expect(done.run.gates_watch ?? null).toBe(null);
  });

  it('renders a bounded Gating section in status.md for a gating run (surface)', () => {
    const doc = renderStatusDoc({
      mode: 'phase',
      lane: 'mechanical',
      status: 'gating',
      stage: 'gates',
      objective: 'Ship the value bump non-blocking',
      branch: 'ape/phase-gating',
      tickets: [],
      receipts: [],
      gates_watch: {
        poll_count: 2,
        last_poll_at: '2026-07-15T00:00:00.000Z',
        last_summary: 'gate suite still running',
      },
    });
    // The status word is lowercase; the red anchor is a dedicated (capitalized)
    // Gating section, absent on the current tree.
    expect(doc).toContain('gating');
    expect(doc).toContain('Gating');
  });

  // A deterministic tree-bound READY artifact mirroring this file's inline-grace
  // ready anchor: ctx.treeSha === the run's attested head tree, full.passed=true,
  // full mode — so the REAL evaluateGates passes (tree_binding + full_suite +
  // mechanical targeted_tests) → GATES_PASSED → the mocked autoMergeGithub →
  // completed. Read at poll time so it binds whatever tree the gating run rests on.
  async function readyGateArtifact(dir, suite) {
    const treeSha = await currentTreeSha(dir);
    const verification = { passed: true, exit_code: 0, duration_ms: 5, output: 'ok' };
    return {
      ready: {
        ctx: {
          treeSha,
          suiteCommand: suite.command,
          suiteMode: 'full',
          suiteInvocation: null,
          impactedPaths: null,
          impactedTemplate: null,
          cachePath: path.join(runtimePaths(dir).runtime, 'suite-cache.json'),
          cache: { schema_version: '2.0.0', results: {} },
          cacheKey: `${treeSha}:full`,
          cacheReadable: false,
          cachedEntry: null,
        },
        full: {
          passed: true,
          tree_sha: treeSha,
          command: suite.command,
          result_hash: 'a'.repeat(64),
          recorded_at: new Date().toISOString(),
          verification,
        },
        cached: true,
        artifact_duration_ms: 5,
      },
    };
  }

  it('waits out a pending gate within wait_ms and resolves in a single next call (wait_ms poll loop — red anchor)', async () => {
    const { dir, outside, probe } = await makeProject();
    // auto+armed: the real detached runner the parent spawns exits fast (no
    // lingering process); the poll the loop actually consumes is the mock below.
    const suite = makeSuite(outside, probe, 'full', 'auto');
    await suite.arm();
    // inline_grace_ms=0 rests the record in gating (buildToGate runs no inline
    // poll); poll_retry_delay_ms=0 makes the pending poll's retry_after_ms 0, so
    // the loop's inter-poll sleep is floored by GATE_NEXT_POLL_FLOOR_MS (250ms).
    await writeConfig(dir, { full: suite.command, graceMs: 0, pollRetryDelayMs: 0 });

    const { result: gated } = await buildToGate(dir);
    expect(gated.run.status).toBe('gating'); // rests in gating (grace 0)

    // CALL-COUNTER poll: PENDING on the first poll (a ready-first mock would be
    // green pre-fix — a false anchor) then a tree-bound READY artifact from the
    // second poll on. Scoped to this test; afterEach restores the delegating
    // default so every other suite keeps the genuine detached-runner poll.
    let polls = 0;
    pollGateSuite.mockImplementation(async () => {
      polls += 1;
      if (polls < 2) return { pending: { summary: 'gate suite still running' } };
      return readyGateArtifact(dir, suite);
    });
    pollGateSuite.mockClear();

    // ONE next carrying an explicit wait_ms. Pre-fix nextRun ignores the 2nd arg
    // → exactly one poll → gating_pending → the run stays gating with a single
    // poll, so BOTH assertions below fail (genuine red). Post-fix the release-
    // around-sleep loop re-polls after ~1 floored 250ms sleep and the ready
    // artifact resolves the gate in this single call.
    const result = track(await nextRun(dir, { wait_ms: 2000 }));
    expect(result.ok).toBe(true);
    expect(result.run.status).not.toBe('gating');
    expect(['completed', 'shipping', 'blocked']).toContain(result.run.status);
    expect(pollGateSuite.mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  it('a next with no wait_ms is exactly one poll: a pending gate rests in gating (byte-identical default)', async () => {
    const { dir, outside, probe } = await makeProject();
    const suite = makeSuite(outside, probe, 'full', 'auto');
    await suite.arm();
    await writeConfig(dir, { full: suite.command, graceMs: 0, pollRetryDelayMs: 0 });

    const { result: gated } = await buildToGate(dir);
    expect(gated.run.status).toBe('gating');

    // Same pending-then-ready counter: a SECOND poll WOULD resolve the gate, so
    // a single poll resting in gating proves the no-arg default never enters the
    // wait loop (byte-identical to today at both the base tree and post-fix).
    let polls = 0;
    pollGateSuite.mockImplementation(async () => {
      polls += 1;
      if (polls < 2) return { pending: { summary: 'gate suite still running' } };
      return readyGateArtifact(dir, suite);
    });
    pollGateSuite.mockClear();

    const result = track(await nextRun(dir)); // NO options => waitMs 0 => one poll
    expect(result.ok).toBe(true);
    expect(result.run.status).toBe('gating');
    expect(pollGateSuite.mock.calls.length).toBe(1);
  });

  it('the wait_ms loop floors each sleep so a sustained-pending gate polls a bounded, multiple number of times (GATE_NEXT_POLL_FLOOR_MS — red anchor)', async () => {
    const { dir, outside, probe } = await makeProject();
    const suite = makeSuite(outside, probe, 'full', 'auto');
    await suite.arm();
    await writeConfig(dir, { full: suite.command, graceMs: 0, pollRetryDelayMs: 0 });

    const { result: gated } = await buildToGate(dir);
    expect(gated.run.status).toBe('gating');

    // Sustained pending: the gate is NEVER ready, so the run can only rest — the
    // loop terminates by exhausting the clamped wait_ms budget, not by resolving.
    pollGateSuite.mockImplementation(async () => ({ pending: { summary: 'gate suite still running' } }));
    pollGateSuite.mockClear();

    // Small wait_ms so the real, floored (250ms) sleeps run in ~sub-second time.
    const result = track(await nextRun(dir, { wait_ms: 800 }));
    expect(result.ok).toBe(true);
    // Never resolves: the run stays gating throughout the bounded loop.
    expect(result.run.status).toBe('gating');
    // Pre-fix the 2nd arg is ignored → exactly one poll → `>= 2` FAILS (the red
    // anchor). Post-fix the loop DID poll multiple times (~wait_ms/250 ≈ 3-4).
    expect(pollGateSuite.mock.calls.length).toBeGreaterThanOrEqual(2);
    // The floor BOUNDS the loop: if a future edit deleted GATE_NEXT_POLL_FLOOR_MS
    // (sleep→Math.max(0, retry_after_ms=0)=0) the count would explode into the
    // hundreds/thousands within 800ms — this ceiling catches that regression.
    expect(pollGateSuite.mock.calls.length).toBeLessThanOrEqual(20);
  });
});
