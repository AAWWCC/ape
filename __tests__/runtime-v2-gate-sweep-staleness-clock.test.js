import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

// ===========================================================================
// GATE-SWEEP-STALENESS-CLOCK-DRIFT (remediation follow-up raised against PR
// #385's gate-suite sweep path, run-fixture-f3fc4361ce27).
//
// sweepStaleGateSuiteTemps (gates.js) stats EVERY matching temp in the
// gate-suite directory, collecting each candidate's mtimeMs, THEN sorts
// ascending by age, caps at GATE_SUITE_TEMP_SWEEP_SCAN_CAP, and only THEN
// reads Date.now() — once per removal-loop iteration — to decide each
// candidate's verdict against GATE_SUITE_TEMP_SWEEP_STALE_MS (300_000). Before
// acme PR #385 the age comparison ran immediately after each candidate's OWN stat;
// now the wall clock is read only after the ENTIRE stat pass (and sort)
// completes, so a candidate's measured age is inflated by however long it took
// to stat every OTHER matching temp in the directory — an interval that GROWS
// with the number of matching temps, precisely the case this sweep exists to
// handle. That widens the window in which a live concurrent runner's
// in-progress write (a candidate sitting just inside the stale fence) can be
// judged stale and removed — the exact hazard the surrounding comment says the
// fence exists to prevent.
//
// THIS ARM makes that drift deterministic and platform-independent (never a
// race against real disk speed): it mocks node:fs/promises's `stat`, scoped
// ONLY to paths inside THIS test's own gate-suite directory, to add a fixed
// per-call delay — the real mtime is still read from the real filesystem via
// utimes-planted timestamps; only the CALL is slowed. It plants one candidate
// (nearlyStale) whose age sits comfortably INSIDE the stale fence (a
// multi-second margin under GATE_SUITE_TEMP_SWEEP_STALE_MS) alongside enough
// OTHER matching, correctly-fresh candidates that the O(N) stat pass alone
// (candidate count * the injected per-call delay) measurably exceeds that
// margin several times over, then drives a REAL launch through the exported
// startGateSuite (which calls the module-private launchGateRunner, which
// calls the module-private sweepStaleGateSuiteTemps — the only reachable path
// to it, since neither is exported) and asserts nearlyStale SURVIVES.
//
// PRE-FIX this is red: the stat-pass delay this arm injects, added AFTER every
// candidate's mtime was already read, pushes nearlyStale's Date.now()-at-
// verdict-time comparison past GATE_SUITE_TEMP_SWEEP_STALE_MS, and it is
// wrongly removed. POST-FIX (reading the wall clock ONCE, before the stat
// pass begins) nearlyStale's measured age never includes the injected delay at
// all, so it survives regardless of how many other candidates were stat'd
// first — exactly the fix's own stated correctness criterion ("a candidate's
// verdict does not depend on how many other candidates were stat'd first").
//
// WHY A REAL LAUNCH, NOT A UNIT CALL ON sweepStaleGateSuiteTemps DIRECTLY. It
// is module-private in gates.js (never exported) and reachable only from
// inside launchGateRunner, itself module-private — the sanctioned surface is
// the exported startGateSuite, the same discipline
// __tests__/runtime-v2-gate-suite-temp-sweep.test.js already uses for the
// sibling lex-cap-shadows-stale defect.
//
// This drives a real detached child node process in the parallel `default`
// vitest project — deliberately NOT added to vitest.config.js's
// SPAWN_SERIAL_FILES (unclaimed here), so the timeout is raised in-file
// instead, the same accommodation the sibling gate-suite-temp-sweep and
// gate-heartbeat-lifecycle files already make.
// ===========================================================================

const flags = vi.hoisted(() => ({ slowStatDir: null, slowStatDelayMs: 0 }));

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    stat: async (target, ...rest) => {
      if (
        flags.slowStatDir
        && typeof target === 'string'
        && target.startsWith(flags.slowStatDir)
      ) {
        await new Promise((resolve) => setTimeout(resolve, flags.slowStatDelayMs));
      }
      return actual.stat(target, ...rest);
    },
  };
});

import { startGateSuite } from '../lib/runtime/gates.js';
import { runtimePaths } from '../lib/runtime/paths.js';
import { GATE_SUITE_TEMP_SWEEP_STALE_MS } from '../lib/runtime/constants.js';
import { currentTreeSha } from '../lib/runtime/git.js';

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
      execFileSync('taskkill', ['/pid', String(pid), '/T', '/F']);
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
const cleanups = [];
afterEach(async () => {
  flags.slowStatDir = null;
  flags.slowStatDelayMs = 0;
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

async function makeProject() {
  const dir = await mkdtemp(path.join(tmpdir(), 'ape-gate-sweep-clock-'));
  cleanups.push(dir);
  await mkdir(path.join(dir, 'notes'), { recursive: true });
  await writeFile(path.join(dir, 'notes', 'note.md'), '# note\n');
  git(dir, 'init', '-q');
  git(dir, 'config', 'user.email', 'ape@example.test');
  git(dir, 'config', 'user.name', 'APE Test');
  git(dir, 'add', '.');
  git(dir, 'commit', '-qm', 'test: baseline');
  return dir;
}

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

async function plantFile(file, { ageMs = null } = {}) {
  await writeFile(file, 'planted-by-runtime-v2-gate-sweep-staleness-clock-test', 'utf8');
  if (ageMs != null) {
    const old = new Date(Date.now() - ageMs);
    await utimes(file, old, old);
  }
}

// A multi-second margin under the real stale fence — comfortably survives any
// ordinary (unmocked) function-call overhead between planting and the sweep's
// own clock read, while the injected per-call stat delay below is deliberately
// sized to exceed it several times over regardless of real disk speed.
const MARGIN_MS = 4_000;
const NEARLY_STALE_AGE_MS = GATE_SUITE_TEMP_SWEEP_STALE_MS - MARGIN_MS;
// Enough matching candidates, each carrying an injected per-stat delay, that
// the O(N) stat pass alone reliably exceeds MARGIN_MS several times over.
const OTHER_CANDIDATE_COUNT = 260;
const STAT_DELAY_MS = 30;

describe('gate-suite temp sweep decides staleness from one pre-pass clock read (gate-sweep-staleness-clock-drift)', () => {
  it('spares a candidate whose age sits just inside the stale fence even when enough other candidates make the stat pass measurably slower than the margin', async () => {
    const dir = await makeProject();
    const suiteCommand = 'node --version';
    const config = { test_commands: { full: suiteCommand } };
    const paths = runtimePaths(dir);

    const gateSuiteDir = path.join(paths.runtime, 'gate-suite');
    await mkdir(gateSuiteDir, { recursive: true });

    const nearlyStaleFile = path.join(
      gateSuiteDir,
      'nearly-stale-candidate.heartbeat.424242.1000000000000.tmp',
    );

    const otherFiles = Array.from({ length: OTHER_CANDIDATE_COUNT }, (_, index) =>
      path.join(
        gateSuiteDir,
        `other-candidate-${String(index).padStart(4, '0')}.heartbeat.111111.${Date.now()}.tmp`,
      ));
    await Promise.all(otherFiles.map((file) => plantFile(file)));

    const treeSha = await currentTreeSha(dir);

    // Plant the boundary candidate only after every unrelated setup step.
    // Slow Windows runners can spend more than MARGIN_MS creating the other
    // fixtures and reading the tree, which would make this file genuinely
    // stale before the sweep's pre-pass clock read and turn the regression
    // arm into a host-load race. The injected stat pass below still exceeds
    // the margin and therefore still distinguishes the old per-verdict clock
    // behavior from the fixed single pre-pass clock behavior.
    await plantFile(nearlyStaleFile, { ageMs: NEARLY_STALE_AGE_MS });

    // Slow down ONLY stat calls inside this test's own gate-suite directory —
    // every other node:fs/promises call (elsewhere in the runtime, and any
    // OTHER project's gate-suite directory) is forwarded to the real
    // implementation with no added delay.
    flags.slowStatDir = gateSuiteDir;
    flags.slowStatDelayMs = STAT_DELAY_MS;

    const result = await startGateSuite(dir, paths, {
      run_id: 'run-gate-sweep-staleness-clock-test',
      regate_attempts: 0,
      ship_requested: false,
      receipts: [{
        receipt_hash: 'receipt-1',
        previous_receipt_hash: null,
        status: 'passed',
        agent: { role: 'implementer' },
        tests: [],
        changed_files: [],
        head_tree_sha: treeSha,
      }],
      lane: 'mechanical',
    }, config);

    flags.slowStatDir = null;
    flags.slowStatDelayMs = 0;

    // The real launch worked (the sweep must never fail a launch): a fresh
    // watch was armed, never a synchronous tooling-failure hit.
    expect(result.watch).toBeTruthy();
    if (Number.isInteger(result.watch?.pid) && result.watch.pid > 0) {
      ledger.add(result.watch.pid);
    }

    // THE OBSERVABLE: nearlyStale sat comfortably inside the stale fence at
    // the moment the sweep began and must be spared regardless of how long
    // the O(N) stat pass over the other candidates took.
    expect(await exists(nearlyStaleFile)).toBe(true);
    // Sanity: the fresh candidates were never at risk either way.
    for (const file of [otherFiles[0], otherFiles.at(-1)]) {
      expect(await exists(file)).toBe(true);
    }
  });
});
