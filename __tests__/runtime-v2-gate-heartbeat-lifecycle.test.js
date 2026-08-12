import { execFileSync, spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, open, rename, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { afterEach, describe, expect, it, vi } from 'vitest';

// ===========================================================================
// TWO GATE-RUNNER HEARTBEAT DEFECTS, ONE FILE (roadmap:
// untracked-beat-promise-can-resurrect-a-witness,
// orphaned-heartbeat-temp-has-no-sweeper). Both concern the same file — the
// gate-suite heartbeat — which is simultaneously the liveness signal gates.js
// polls and the identity witness spawn.js keys a SIGKILL on.
//
// DEFECT 1 (arm below: "awaits every started beat..."). runner.js's
// runGateJob() drives beats through `setInterval(beat, heartbeatMs)` and
// discards the returned promise. A beat that entered its atomic write before
// `clearInterval` can still complete its rename AFTER the finish path's
// `rm(heartbeatFile)`, republishing a fresh, freshly-timestamped heartbeat for
// a runner that has already exited — resurrecting stale-witness authority
// downstream (gates.js isHeartbeatFresh, spawn.js's kill witness).
//
// WHY THIS ARM DOES NOT RACE THE REAL CLOCK TO PROVE IT. This repo already
// refuses a nondeterministically-red arm as a red anchor
// (__tests__/runtime-v2-runner.test.js:240-247, the torn-read arm it
// deliberately declines to write). Winning "a beat is in flight exactly when
// clearInterval fires" by timing luck alone would be exactly that mistake.
// Instead this arm drives runGateJob IN-PROCESS (a real child process still
// runs the "suite", but the beat writer is intercepted) and PARKS every
// beat write behind a release trigger, polled rather than slept:
//   release when the heartbeat file is observed MISSING, OR a bounded
//   fallback elapses — whichever comes first.
// This is the one trigger that is deadlock-free in BOTH worlds (plan-critic
// finding C2), and the file header says so explicitly because the two worlds
// pull in opposite directions:
//   PRE-FIX the finish path never awaits an in-flight beat, so it removes the
//   heartbeat immediately after `clearInterval`. A beat parked on this call
//   observes the file go missing within one poll tick and republishes it —
//   Defect 1 in the flesh — which is exactly what makes the assertion below
//   red on the current tree.
//   POST-FIX the finish path must await every started beat BEFORE removing
//   the heartbeat, so the file is NEVER observed missing while a beat is
//   still parked on it — a trigger that waited on absence alone would
//   deadlock forever (the removal can't happen until the beat resolves, and
//   the beat won't resolve until the removal happens). The bounded fallback
//   is what breaks that cycle: after PARK_FALLBACK_MS the parked write
//   proceeds regardless of the file's presence, the finish path's await
//   resolves, and the removal becomes — and stays — the true last write.
// After the drive, the test additionally awaits every parked write settling
// (not just runGateJob's own return) before reading the observable, so the
// race is played out to completion rather than raced past: pre-fix that is
// what lets the republish actually land before the assertion reads the file.
//
// THE SEAM THIS ARM REQUIRES, NAMED SO THE DISCRIMINATOR IS UNAMBIGUOUS.
// runGateJob is not exported today and its ordering cannot be driven
// deterministically from outside a real detached child process, so closing
// Defect 1 is expected to also `export` it and give it one test-only
// injection point for the heartbeat write — the same "injected by tests"
// options-bag convention spawn.js's killProcessTree already uses (stale_ms /
// kill_grace_ms / platform, spawn.js:533): `runGateJob(options = {})` where
// `options.writeHeartbeat(file, text) => Promise<void>` overrides ONLY the
// heartbeat write (never the result artifact) and defaults to the real
// atomic write when omitted, so an unconfigured (production) call stays
// byte-identical to today. A namespace import (below), not a named one, is
// deliberate: on the CURRENT tree `runGateJob` does not exist at all, and a
// named import of a missing export can fail at link time and take the whole
// file red for the wrong reason — the same guard documented at
// __tests__/runtime-v2-kill-process-tree-stale-pid.test.js:6-10.
// DISCRIMINATOR: the seam alone proves nothing. Once it exists, reverting
// ONLY the fix — dropping the await-every-started-beat-before-removal in
// runGateJob's finish path — must turn this arm red again even with the
// injection point intact. A single `inFlight` slot that a newer beat
// overwrites is not enough either (an earlier parked beat could still rename
// after the removal); the requirement is every started beat, tracked.
//
// DEFECT 2 (arm below: "removes stale gate-suite temps..."). atomicWriteFile600
// (runner.js) and atomicWriteJson (storage.js) both write `<file>.<pid>.<ms>.tmp`
// / `<file>.<pid>.<ms>.<hex8>.tmp` then rename into place; a write that never
// reaches the rename leaves the temp behind, and nothing sweeps it. This arm
// needs NO new export: it plants both temp shapes (one stale, one fresh, via
// utimes — never a sleep) in the real gate-suite directory and drives a real
// launch through the public service.js surface, then asserts the stale ones
// are gone, the fresh one survives (it may belong to a live concurrent
// runner), and an UNRELATED cache key's own real heartbeat/job/artifact files
// are untouched.
//
// WHY A FOREIGN STEM, NOT THIS RUN'S OWN FILES (plan-critic finding C9). The
// run objective's "assert the heartbeat/job/artifact files are untouched" is
// unsatisfiable read literally against THIS launch's own files: launchGateRunner
// legitimately rm's its own files.heartbeat before every launch/respawn
// (gates.js:1041) and the caller legitimately rm's the artifact on adoption —
// that is correct, pre-existing behavior, not the defect. Planting an
// unrelated cache key's trio in the SAME directory and asserting IT survives
// is the honest anchor: it catches a sweep that is a bare directory-wide
// age-based rm (which would also delete an unrelated runner's live files) as
// distinct from one correctly scoped to the two temp shapes.
//
// BOTH ARMS DRIVE REAL CHILD NODE PROCESSES IN THE PARALLEL `default` vitest
// project (maxWorkers 3) — this file is deliberately NOT added to
// vitest.config.js's SPAWN_SERIAL_FILES (unclaimed here) and stays out of it,
// so timeouts are raised IN FILE instead, the same accommodation
// __tests__/runtime-v2-gating-watch.test.js:57 and
// __tests__/runtime-v2-per-runner-gate-cwd.test.js:47 already make for a
// starved worker.
// ===========================================================================

// Namespace import: see the DEFECT 1 seam note above for why this must not be
// a named import of `runGateJob`.
import * as runnerModule from '../lib/runtime/runner.js';
import { buildSpawnPlan } from '../lib/runtime/runner.js';

// autoMergeGithub is the one runtime-owned side effect (a real GitHub PR/
// merge) these behavioral tests must never perform for real; everything else
// — gateSuiteContext, startGateSuite, launchGateRunner, pollGateSuite,
// evaluateGates, runMergeGates — runs genuinely. importOriginal keeps it so.
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
import { nextRun, recordReceipt, startRun } from '../lib/runtime/service.js';
import { runtimePaths } from '../lib/runtime/paths.js';
import { atomicWriteJson } from '../lib/runtime/storage.js';
import { sha256 } from '../lib/runtime/canonical.js';

// Detached gate runners plus real git init/commit take a few honest seconds;
// see the header note on why this is raised in-file rather than in
// vitest.config.js.
vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function alive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === 'EPERM';
  }
}

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

const ledger = new Set();
function track(result) {
  const pid = result?.run?.gates_watch?.pid;
  if (Number.isInteger(pid) && pid > 0) ledger.add(pid);
  return result;
}

async function drivePolls(dir, { tries = 150, delayMs = 100 } = {}) {
  let result = track(await nextRun(dir));
  for (let i = 0; i < tries; i += 1) {
    if (!result.ok) return result;
    if (result.run?.status !== 'gating') return result;
    await sleep(delayMs);
    result = track(await nextRun(dir));
  }
  return result;
}

const cleanups = [];
afterEach(async () => {
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

async function fileMissing(file) {
  try {
    await stat(file);
    return false;
  } catch {
    return true;
  }
}

async function exists(file) {
  return !(await fileMissing(file));
}

// ---------------------------------------------------------------------------
// DEFECT 1 — untracked-beat-promise-can-resurrect-a-witness
// ---------------------------------------------------------------------------

// Short beats keep the arm cheap; MIN_BEATS_IN_FLIGHT >= 2 guarantees at
// least one INTERVAL-triggered beat (never the pre-interval initial one) is
// genuinely parked before the suite is released.
const HEARTBEAT_MS = 15;
const MIN_BEATS_IN_FLIGHT = 3;
const OBSERVE_BUDGET_MS = 10_000;
const OBSERVE_POLL_MS = 2;
// Bounded release for a beat parked on "heartbeat absent" — see the header
// note on why this exact trigger is deadlock-free pre- and post-fix.
const PARK_FALLBACK_MS = 2_000;
const PARK_POLL_MS = 5;
const SUITE_SELF_TIMEOUT_MS = 12_000;
const JOB_TIMEOUT_MS = 20_000;

// The "suite" the gate runner supervises: exits the instant the test drops a
// release flag, self-terminates on its own deadline if the test never does,
// so no fixed sleep sets the length of the heartbeating window.
function releaseFlagSuiteSource(releaseFile) {
  return [
    'import { existsSync } from "node:fs";',
    `const release = ${JSON.stringify(releaseFile)};`,
    `const deadline = Date.now() + ${SUITE_SELF_TIMEOUT_MS};`,
    'const timer = setInterval(() => {',
    '  if (existsSync(release) || Date.now() >= deadline) {',
    '    clearInterval(timer);',
    '    process.exit(0);',
    '  }',
    '}, 5);',
    '',
  ].join('\n');
}

// A private, test-owned replica of runner.js's atomicWriteFile600 (temp +
// rename, 0600) — not a re-export, so this arm exercises the SAME observable
// write discipline without depending on an internal helper this run does not
// claim as public surface.
async function atomicWrite600(file, text) {
  await mkdir(path.dirname(file), { recursive: true }).catch(() => {});
  const temporary = `${file}.testwriter.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2, 8)}.tmp`;
  const handle = await open(temporary, 'wx', 0o600);
  try {
    await handle.writeFile(text, 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(temporary, file);
}

// See the header note for the exact release-trigger contract this builds.
function makeParkingHeartbeatWriter() {
  let calls = 0;
  const pending = [];
  const writeHeartbeat = (file, text) => {
    calls += 1;
    const promise = (async () => {
      const budgetAt = Date.now() + PARK_FALLBACK_MS;
      while (!(await fileMissing(file)) && Date.now() < budgetAt) {
        await delay(PARK_POLL_MS);
      }
      await atomicWrite600(file, text);
    })();
    pending.push(promise);
    return promise;
  };
  return {
    writeHeartbeat,
    callCount: () => calls,
    settleAll: () => Promise.all(pending),
  };
}

describe('detached gate-runner heartbeat lifecycle', () => {
  it('awaits every started beat before removing the heartbeat file, so a beat genuinely in flight across the stop can never republish it after runGateJob resolves (untracked-beat-promise-can-resurrect-a-witness)', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'ape-gate-heartbeat-'));
    cleanups.push(dir);
    const heartbeatFile = path.join(dir, 'heartbeat.json');
    const artifactFile = path.join(dir, 'artifact.json');
    const releaseFile = path.join(dir, 'release.flag');
    const suiteFile = path.join(dir, 'suite.mjs');
    const jobFile = path.join(dir, 'job.json');

    await writeFile(suiteFile, releaseFlagSuiteSource(releaseFile), 'utf8');
    await writeFile(jobFile, JSON.stringify({
      version: 1,
      run_id: 'run-gate-heartbeat-lifecycle-arm1',
      nonce: '9f1d6c2a-0000-4000-8000-00000000ab02',
      cache_key: 'gate-heartbeat-lifecycle-arm1',
      tree_sha: '0'.repeat(40),
      plan: buildSpawnPlan(process.execPath, [suiteFile], process.platform),
      timeout_ms: JOB_TIMEOUT_MS,
      heartbeat_ms: HEARTBEAT_MS,
      created_at: new Date().toISOString(),
      project_dir: dir,
      suite_cwd: dir,
      artifact_file: artifactFile,
      heartbeat_file: heartbeatFile,
      host: 'test-host',
    }), 'utf8');

    const { writeHeartbeat, callCount, settleAll } = makeParkingHeartbeatWriter();

    const previousJobEnv = process.env.APE_GATE_RUNNER_JOB;
    process.env.APE_GATE_RUNNER_JOB = jobFile;
    let runPromise;
    try {
      // NAMESPACE property call, deliberately: on the current tree
      // `runnerModule.runGateJob` is undefined and this throws a TypeError —
      // a deterministic, correctly-attributed red (see the header seam note)
      // rather than a link-time failure.
      runPromise = runnerModule.runGateJob({ writeHeartbeat });

      const budgetAt = Date.now() + OBSERVE_BUDGET_MS;
      while (callCount() < MIN_BEATS_IN_FLIGHT && Date.now() < budgetAt) {
        await delay(OBSERVE_POLL_MS);
      }
      // Sanity on the DRIVE, not on the defect: an interval-triggered beat
      // must genuinely be in flight before the suite is released, or this arm
      // would prove nothing either way.
      expect(callCount()).toBeGreaterThanOrEqual(MIN_BEATS_IN_FLIGHT);

      await writeFile(releaseFile, 'release', 'utf8').catch(() => {});
      await runPromise;
    } finally {
      process.env.APE_GATE_RUNNER_JOB = previousJobEnv;
    }

    // Let every started beat — including one still parked at the instant
    // runGateJob resolved — fully settle before reading the observable. This
    // plays the race out to completion instead of reading past it: pre-fix,
    // this is exactly what lets the republish land before the assertion.
    await settleAll();

    expect(await fileMissing(heartbeatFile)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// DEFECT 2 — orphaned-heartbeat-temp-has-no-sweeper
// ---------------------------------------------------------------------------

// Unambiguously older than any sane sweep threshold regardless of the exact
// constant value the fix adds (this run does not claim constants.js's value,
// only the observable file survival), and unambiguously fresh (just written,
// mtime untouched) for the survivor.
const STALE_TEMP_AGE_MS = 24 * 60 * 60 * 1000;

async function plantFile(file, { stale }) {
  await writeFile(file, 'planted-by-runtime-v2-gate-heartbeat-lifecycle-test', 'utf8');
  if (stale) {
    const old = new Date(Date.now() - STALE_TEMP_AGE_MS);
    await utimes(file, old, old);
  }
}

function git(cwd, ...args) {
  execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' },
  });
}

async function makeProject() {
  const dir = await mkdtemp(path.join(tmpdir(), 'ape-gate-sweep-'));
  const outside = await mkdtemp(path.join(tmpdir(), 'ape-gate-sweep-out-'));
  cleanups.push(dir, outside);
  await mkdir(path.join(dir, 'notes'), { recursive: true });
  await writeFile(path.join(dir, 'notes', 'note.md'), '# note\n');
  git(dir, 'init', '-q');
  git(dir, 'config', 'user.email', 'ape@example.test');
  git(dir, 'config', 'user.name', 'APE Test');
  git(dir, 'add', '.');
  git(dir, 'commit', '-qm', 'test: baseline');
  return { dir, outside };
}

describe('gate-suite directory temp sweep at the launch chokepoint', () => {
  it('removes stale gate-suite temps of both produced shapes at launch, spares a fresh temp, and leaves an unrelated cache key\'s own heartbeat/job/artifact files untouched (orphaned-heartbeat-temp-has-no-sweeper)', async () => {
    const { dir, outside } = await makeProject();
    const suiteFile = path.join(outside, 'suite-arm2.mjs');
    await writeFile(suiteFile, 'process.exit(0);\n', 'utf8');

    await atomicWriteJson(runtimePaths(dir).config, {
      shipping: { auto_merge: true, provider: 'github', required_remote_checks: true },
      policy: { full_suite_cache: false },
      gates: { inline_grace_ms: 0 },
      test_commands: { full: `node "${suiteFile}"` },
    });

    // Plant an UNRELATED cache key's gate-suite files before the real launch:
    // see the header's C9 note for why a foreign stem, never this launch's
    // own files, is the honest anchor for "untouched".
    const gateSuiteDir = path.join(runtimePaths(dir).runtime, 'gate-suite');
    await mkdir(gateSuiteDir, { recursive: true });
    const foreignStem = sha256('gate-heartbeat-lifecycle-arm2-foreign-stem');
    const foreignHeartbeat = path.join(gateSuiteDir, `${foreignStem}.heartbeat`);
    const foreignJob = path.join(gateSuiteDir, `${foreignStem}.job.json`);
    const foreignArtifact = path.join(gateSuiteDir, `${foreignStem}.result.json`);
    await plantFile(foreignHeartbeat, { stale: true });
    await plantFile(foreignJob, { stale: true });
    await plantFile(foreignArtifact, { stale: true });

    // The two temp shapes this runtime actually produces in this directory:
    // runner.js's `<file>.<pid>.<ms>.tmp` (the heartbeat/artifact family,
    // runner.js:453) and storage.js's `<file>.<pid>.<ms>.<hex8>.tmp` (used
    // for files.job, storage.js:81). One stale and one fresh of each,
    // utimes-planted — never a sleep.
    const staleHeartbeatTemp = path.join(gateSuiteDir, `${foreignStem}.heartbeat.777777.1000000000000.tmp`);
    const staleJobTemp = path.join(gateSuiteDir, `${foreignStem}.job.json.777777.1000000000000.a1b2c3d4.tmp`);
    const freshHeartbeatTemp = path.join(gateSuiteDir, `${foreignStem}.heartbeat.888888.${Date.now()}.tmp`);
    const freshJobTemp = path.join(gateSuiteDir, `${foreignStem}.job.json.888888.${Date.now()}.e5f6a7b8.tmp`);
    await plantFile(staleHeartbeatTemp, { stale: true });
    await plantFile(staleJobTemp, { stale: true });
    await plantFile(freshHeartbeatTemp, { stale: false });
    await plantFile(freshJobTemp, { stale: false });

    const started = track(await startRun(dir, {
      objective: 'Close the gate-runner heartbeat lifecycle defects (sweep drive)',
      mode: 'phase',
      lane: 'mechanical',
      host: 'codex',
      claimed_paths: ['notes/note.md'],
      test_paths: [],
      requirements: ['R-GATE-SWEEP'],
      risk_triggers: [],
      behavioral: false,
      hooks_trusted: true,
      subagents_available: true,
      explicit_invocation: true,
    }));
    expect(started.ok).toBe(true);
    const build = started.run.tickets[0];
    await writeFile(path.join(dir, 'notes', 'note.md'), '# note\n\nUpdated.\n');

    const recorded = track(await recordReceipt(dir, {
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
    const done = recorded.run?.status === 'gating' ? await drivePolls(dir) : recorded;

    // The real launch worked (the sweep must never fail a launch): the union
    // this run's own suite decides passed and the run completed.
    expect(done.run?.gates?.checks?.full_suite?.passed).toBe(true);
    expect(done.run?.status).toBe('completed');

    // The sweep's observable: bounded by shape and age, never a bare
    // directory-wide rm.
    expect(await exists(staleHeartbeatTemp)).toBe(false);
    expect(await exists(staleJobTemp)).toBe(false);
    expect(await exists(freshHeartbeatTemp)).toBe(true);
    expect(await exists(freshJobTemp)).toBe(true);
    expect(await exists(foreignHeartbeat)).toBe(true);
    expect(await exists(foreignJob)).toBe(true);
    expect(await exists(foreignArtifact)).toBe(true);
  });
});
