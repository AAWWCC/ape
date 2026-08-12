import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

// ===========================================================================
// launchGateRunner's job-descriptor write carries no catch (roadmap entry
// gate-runner-job-write-not-swallowed, run-fixture-ae3561b99c90's
// non-blocking security/remediation reviews of acme PR #383).
//
// launchGateRunner (gates.js:1112-1137) writes the job descriptor with a bare
//   await atomicWriteJson(files.job, job);
// — no .catch, no enclosing try — while every OTHER atomic write landing in
// the same gate-suite directory (the runner's own heartbeat beat and its
// result artifact, both in runner.js) is catch-wrapped. storage.js's
// replaceFile retries only the win32 transient rename codes (EPERM/EACCES/
// EBUSY) and rethrows everything else — including a same-shaped write failure
// on POSIX — so a failed job write PROPAGATES OUT of launchGateRunner as a
// rejected promise instead of returning { launched: false }, the shape every
// OTHER unresolvable-launch path in gates.js already returns and that both of
// its callers (startGateSuite, startGateSuiteMulti) already handle by
// recording an honest tooling-failure gate block (gates.js:1218, 1299, 1409;
// "gate runner entry could not be resolved; cannot run the detached
// merge-gate suite"). Nothing between launchGateRunner and
// service.js's applyActions 'run_gates' handler catches that rejection
// either (service.js:817, `const start = await startGateSuite(...)` is a bare
// await), so today it propagates all the way out of recordReceipt/nextRun as
// an unhandled exception instead of the handled gate-block shape a caller
// already knows how to read.
//
// THIS ARM drives that exact failure through the public service.js surface: a
// real build receipt whose acceptance would ordinarily start the detached
// merge-gate suite, with the job-descriptor write forced to fail
// deterministically and platform-independently (a real DIRECTORY pre-planted
// at the exact path launchGateRunner will write its job descriptor to —
// renaming a file onto an existing directory always fails on every OS and at
// every privilege level, including root, unlike a permission-based block).
//
// PRE-FIX this is red: recordReceipt's returned promise REJECTS instead of
// resolving to the handled ok:true/blocked shape. POST-FIX (wrapping the job
// write so a failure returns { launched: false } through the already-handled
// path) recordReceipt resolves normally and the run blocks on a failed
// full_suite gate check, exactly as the resolveRunnerEntry-null path already
// does — never a thrown exception out of a receipt-recording call.
//
// THE EXACT JOB PATH, DERIVED, NEVER GUESSED. gateSuiteContext's single-suite
// strategy (gates.js:489-516) computes
//   cacheKey = `${treeSha}:${sha256({ command: suiteCommand })}`
// (the plain full-suite case: no regate, no impacted template, no ship) and
// gateSuiteFiles (gates.js:945-955) derives the job file at
//   `${sha256(cacheKey)}.job.json` inside `<runtime>/gate-suite`.
// This arm applies the exact working-tree change the receipt below attests,
// computes treeSha the same way (git.js's currentTreeSha, imported directly —
// never re-implemented), and so lands the blocking directory at the SAME path
// launchGateRunner will target for this run's real launch.
//
// WHY A REAL LAUNCH, NOT A UNIT CALL ON launchGateRunner DIRECTLY.
// launchGateRunner is module-private in gates.js (never exported), so the
// only sanctioned way to drive it is through the public service.js surface
// that recordReceipt exercises for any ordinary build receipt — the same
// discipline __tests__/runtime-v2-gate-heartbeat-lifecycle.test.js already
// uses for the sibling orphaned-heartbeat-temp-has-no-sweeper defect.
//
// This drives real git plumbing (execFileSync) in the parallel `default`
// vitest project — deliberately NOT added to vitest.config.js's
// SPAWN_SERIAL_FILES, the same accommodation the heartbeat-lifecycle file
// already makes — so the timeout is raised in-file instead.
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
import { recordReceipt, startRun } from '../lib/runtime/service.js';
import { runtimePaths } from '../lib/runtime/paths.js';
import { atomicWriteJson } from '../lib/runtime/storage.js';
import { sha256 } from '../lib/runtime/canonical.js';
import { currentTreeSha } from '../lib/runtime/git.js';

vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

const cleanups = [];
afterEach(async () => {
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
  const dir = await mkdtemp(path.join(tmpdir(), 'ape-gate-job-write-'));
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

describe('launchGateRunner job-descriptor write failure', () => {
  it('returns a handled launch failure (gates fail closed) instead of throwing out of recordReceipt when the job-descriptor write fails (gate-runner-job-write-not-swallowed)', async () => {
    const dir = await makeProject();
    // Never actually spawned: the job write fails before spawnDetached is
    // ever reached, so the exact suite behind this command is immaterial.
    const suiteCommand = 'node --version';

    await atomicWriteJson(runtimePaths(dir).config, {
      shipping: { auto_merge: true, provider: 'github', required_remote_checks: true },
      policy: { full_suite_cache: false },
      gates: { inline_grace_ms: 0 },
      test_commands: { full: suiteCommand },
    });

    const started = await startRun(dir, {
      objective: 'Close the gate-runner job-write-not-swallowed defect (job-write drive)',
      mode: 'phase',
      lane: 'mechanical',
      host: 'codex',
      claimed_paths: ['notes/note.md'],
      test_paths: [],
      requirements: ['R-GATE-JOB-WRITE'],
      risk_triggers: [],
      behavioral: false,
      hooks_trusted: true,
      subagents_available: true,
      explicit_invocation: true,
    });
    expect(started.ok).toBe(true);
    const build = started.run.tickets[0];

    // Apply the exact working-tree change the receipt below attests, THEN
    // derive the identical cacheKey/job path gateSuiteContext will compute at
    // evaluation time — see the header note for the exact formula this
    // mirrors (gates.js:499-501, :945-955).
    await writeFile(path.join(dir, 'notes', 'note.md'), '# note\n\nUpdated.\n');
    const treeSha = await currentTreeSha(dir);
    const cacheKey = `${treeSha}:${sha256({ command: suiteCommand })}`;
    const stem = sha256(cacheKey);
    const jobFile = path.join(runtimePaths(dir).runtime, 'gate-suite', `${stem}.job.json`);

    // Force the job write to fail deterministically and platform-/privilege-
    // independently: renaming a file onto an EXISTING DIRECTORY always fails
    // (EISDIR on POSIX) — never bypassable by a root test runner, unlike a
    // permission-based block would be.
    await mkdir(jobFile, { recursive: true });

    const receiptPromise = recordReceipt(dir, {
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
    });

    // THE OBSERVABLE: recordReceipt must resolve to the handled shape, never
    // reject — pre-fix, launchGateRunner's uncaught job-write failure
    // propagates all the way out here as a rejected promise instead.
    await expect(receiptPromise).resolves.toEqual(expect.objectContaining({ ok: true }));
    const recorded = await receiptPromise;

    // The handled shape: gates fail closed exactly as the pre-existing
    // resolveRunnerEntry-null path already does (gates.js:1299) — a genuine
    // gate block, never an unhandled crash out of recordReceipt.
    expect(recorded.run.status).toBe('blocked');
    expect(recorded.run.gates?.passed).toBe(false);
    expect(recorded.run.gates?.checks?.full_suite?.passed).toBe(false);
  });
});
