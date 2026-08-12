import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

// ===========================================================================
// GATE-SUITE TEMP SWEEP: CAP-ORDER SHADOWS A GENUINELY STALE TEMP (roadmap
// entry gate-suite-temp-sweep-lex-cap-shadows-stale, run-20260803021825032-
// 3c51015d's non-blocking security/remediation reviews of acme PR #383).
//
// sweepStaleGateSuiteTemps (gates.js:1007-1030), run at every launchGateRunner
// chokepoint, reads the gate-suite directory, filters candidate temp names,
// SORTS THEM LEXICOGRAPHICALLY, then CAPS the sorted list at
// GATE_SUITE_TEMP_SWEEP_SCAN_CAP before stat/rm-ing each survivor:
//
//   const candidates = entries
//     .filter((name) => GATE_SUITE_TEMP_PATTERN.test(name))
//     .sort()
//     .slice(0, GATE_SUITE_TEMP_SWEEP_SCAN_CAP);
//
// The cap therefore bounds a LEXICOGRAPHIC prefix of the candidate names, not
// an age-ordered one. When GATE_SUITE_TEMP_SWEEP_SCAN_CAP-or-more FRESH temps
// (younger than GATE_SUITE_TEMP_SWEEP_STALE_MS, so correctly left alone on
// their own) sort ahead of a name that happens to sort AFTER them, that one
// genuinely stale temp is sliced out of the candidate list entirely and the
// sweep never even stats it, let alone removes it — a launch that should have
// drained the orphan silently does nothing to it. The header comment at
// gates.js:978-981 currently claims the cap means "an unbounded number of
// stray temps can never turn one launch into an unbounded scan", which is true
// of the STAT/RM cost but says nothing about this shadowing failure mode.
//
// THIS ARM proves it behaviorally: it plants more than
// GATE_SUITE_TEMP_SWEEP_SCAN_CAP fresh, correctly-shaped temp candidates whose
// names sort lexicographically AHEAD of one genuinely stale temp candidate (a
// name that sorts after all of them), all inside the real gate-suite
// directory, then drives a REAL launch through the public service.js surface
// (startRun -> recordReceipt, exactly as any other build receipt would) —
// which is the one code path that actually calls launchGateRunner and, via
// it, sweepStaleGateSuiteTemps. It asserts the genuinely stale candidate is
// removed and the fresh candidates all survive.
//
// PRE-FIX this is red: the stale candidate sorts last among 1,000+ candidates,
// the slice(0, CAP) keeps only the fresh prefix, and the stale candidate is
// never examined — it survives the launch untouched, which is the shadowing
// defect in the flesh. A fix that bounds the candidate list by age instead of
// lexicographic name (or bails the filter once CAP genuine matches are
// collected without disturbing which ones those are by an unrelated sort)
// closes this: the stale candidate is found and removed regardless of how
// many fresh candidates happen to sort ahead of it by name.
//
// WHY A REAL LAUNCH, NOT A UNIT CALL. sweepStaleGateSuiteTemps is not exported
// (module-private in gates.js) and is reachable only from inside
// launchGateRunner, which is also module-private — the only sanctioned way to
// exercise it from outside gates.js is to drive an actual gate-suite launch
// through the public service.js surface, exactly as
// __tests__/runtime-v2-gate-heartbeat-lifecycle.test.js already does for the
// sibling orphaned-heartbeat-temp-has-no-sweeper defect. This file targets a
// DIFFERENT observable (the cap's ORDERING, not merely that a stale temp of
// either produced shape is swept at all), so it is a separate, focused
// behavioral test rather than an addition to that file's already-large arm.
//
// WHY LEX-ORDERED NAMES, NOT SHA256 STEMS. The real temp shapes this runtime
// produces are sha256-stemmed (gates.js:958-964), but nothing in
// GATE_SUITE_TEMP_PATTERN requires that — it matches any name ending in the
// two produced suffix shapes. Choosing plain, humanly-sortable prefixes
// ('fresh-000000...' before 'zzzz-stale...') makes the "CAP-or-more fresh
// names sort ahead of the one stale name" precondition exact and readable,
// rather than hoping a sha256 draw lands in the right lexicographic slot.
//
// This drives a real detached child node process (the suite) in the parallel
// `default` vitest project — deliberately NOT added to vitest.config.js's
// SPAWN_SERIAL_FILES, the same accommodation
// __tests__/runtime-v2-gate-heartbeat-lifecycle.test.js already makes — so the
// timeout is raised in-file instead.
// ===========================================================================

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
import { GATE_SUITE_TEMP_SWEEP_SCAN_CAP } from '../lib/runtime/constants.js';

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

function git(cwd, ...args) {
  execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' },
  });
}

async function makeProject() {
  const dir = await mkdtemp(path.join(tmpdir(), 'ape-gate-sweep-cap-'));
  const outside = await mkdtemp(path.join(tmpdir(), 'ape-gate-sweep-cap-out-'));
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

// Unambiguously fresh (just written, mtime untouched) or unambiguously older
// than any sane sweep threshold (utimes-planted, never a sleep) — mirrors
// __tests__/runtime-v2-gate-heartbeat-lifecycle.test.js's plantFile helper.
const STALE_TEMP_AGE_MS = 24 * 60 * 60 * 1000;

async function plantFile(file, { stale }) {
  await writeFile(file, 'planted-by-runtime-v2-gate-suite-temp-sweep-test', 'utf8');
  if (stale) {
    const old = new Date(Date.now() - STALE_TEMP_AGE_MS);
    await utimes(file, old, old);
  }
}

describe('gate-suite temp sweep bounds by age, not by a lexicographic name cap', () => {
  it('removes one genuinely stale temp even when more than GATE_SUITE_TEMP_SWEEP_SCAN_CAP fresh temps sort lexicographically ahead of it, and spares every fresh one (gate-suite-temp-sweep-lex-cap-shadows-stale)', async () => {
    // Imported dynamically (rather than statically at the top of the file)
    // so a missing test-support/temp-fixtures.js fails only this test, not
    // the whole file's collection.
    const { mapBounded } = await import('../test-support/temp-fixtures.js');
    const { dir, outside } = await makeProject();
    const suiteFile = path.join(outside, 'suite-temp-sweep.mjs');
    await writeFile(suiteFile, 'process.exit(0);\n', 'utf8');

    await atomicWriteJson(runtimePaths(dir).config, {
      shipping: { auto_merge: true, provider: 'github', required_remote_checks: true },
      policy: { full_suite_cache: false },
      gates: { inline_grace_ms: 0 },
      test_commands: { full: `node "${suiteFile}"` },
    });

    const gateSuiteDir = path.join(runtimePaths(dir).runtime, 'gate-suite');
    await mkdir(gateSuiteDir, { recursive: true });

    // ONE genuinely stale candidate whose name sorts LAST among every
    // candidate planted here ('z' > 'f' at the first differing byte), so a
    // lexicographic-then-slice cap always excludes it once enough
    // lexicographically-earlier candidates exist.
    const staleFile = path.join(
      gateSuiteDir,
      'zzzz-stale-shadowed.heartbeat.777777.1000000000000.tmp',
    );
    await plantFile(staleFile, { stale: true });

    // MORE than the cap, every one sorting ahead of the stale name above.
    const freshCount = GATE_SUITE_TEMP_SWEEP_SCAN_CAP + 5;
    const freshFiles = Array.from({ length: freshCount }, (_, index) =>
      path.join(
        gateSuiteDir,
        `fresh-${String(index).padStart(6, '0')}.heartbeat.111111.${Date.now()}.tmp`,
      ));
    // Bounded concurrency: planting all 1005 files through a single
    // unbounded Promise.all can exhaust the descriptor table on a host with
    // a low ulimit -n (EMFILE), which has nothing to do with the sweep
    // behavior this test exercises. mapBounded plants the identical file
    // count, just never more than GATE_PLANT_CONCURRENCY open at once.
    const GATE_PLANT_CONCURRENCY = 64;
    await mapBounded(freshFiles, (file) => plantFile(file, { stale: false }), GATE_PLANT_CONCURRENCY);

    const started = track(await startRun(dir, {
      objective: 'Close the gate-suite temp sweep lex-cap shadow defect (sweep-cap drive)',
      mode: 'phase',
      lane: 'mechanical',
      host: 'codex',
      claimed_paths: ['notes/note.md'],
      test_paths: [],
      requirements: ['R-GATE-SWEEP-CAP'],
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

    // The real launch worked (the sweep must never fail a launch): this run's
    // own suite decided passed and the run completed.
    expect(done.run?.gates?.checks?.full_suite?.passed).toBe(true);
    expect(done.run?.status).toBe('completed');

    // THE OBSERVABLE: the stale candidate is found and removed despite
    // sorting after every fresh one, and every fresh candidate survives
    // (each is younger than GATE_SUITE_TEMP_SWEEP_STALE_MS, so a correct
    // sweep — age-bounded, not name-bounded — must never remove them).
    expect(await exists(staleFile)).toBe(false);
    for (const file of [freshFiles[0], freshFiles[Math.floor(freshFiles.length / 2)], freshFiles.at(-1)]) {
      expect(await exists(file)).toBe(true);
    }
  });
});
