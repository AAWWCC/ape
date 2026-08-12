import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

// ===========================================================================
// GATE-LAUNCH-FAILURE-CAUSE-IS-DISCARDED (remediation follow-up raised against
// acme PR #385's gate-suite launch paths, run-fixture-f3fc4361ce27).
//
// launchGateRunner (gates.js) wraps its job-descriptor atomicWriteJson so a
// write failure returns { pid: null, launched: false } instead of throwing —
// correct, fail-closed behavior, but the catch DISCARDS the caught error. Every
// one of the five launch call sites (startGateSuite, startGateSuiteMulti, the
// multi-runner advance, and both pollGateSuite(Multi) respawns) renders the
// SAME fixed string — "gate runner entry could not be resolved" — whether the
// cause is an unresolvable runner entry (resolveRunnerEntry() returned null) OR
// a failed job-descriptor write (an ENOSPC/EACCES/EISDIR on the atomic
// rename). An operator reading that text for a disk/permission fault is
// misdirected to inspect runner resolution (runner.js) instead of the
// gate-suite directory's disk/permission state.
//
// THIS ARM drives the exported startGateSuite directly — the initial
// single-suite launch call site (gates.js, "gate runner entry could not be
// resolved; cannot run the detached merge-gate suite") — with no need to route
// through the full service.js/recordReceipt orchestration, since startGateSuite
// already owns this exact call site as public surface. It proves two things in
// one behavioral pass:
//
//   (1) a job-descriptor write forced to fail (a real DIRECTORY pre-planted at
//       the exact job path launchGateRunner will write to — renaming a file
//       onto an existing directory always fails, EISDIR on POSIX, regardless
//       of privilege level) must surface operator-facing text that NAMES the
//       job-descriptor write and the real underlying cause (EISDIR) — never
//       the generic resolution-failure string alone;
//   (2) a genuine runner-entry resolution failure (resolveRunnerEntry() finds
//       neither candidate path) must still surface the EXISTING fixed message,
//       byte-for-byte — the fix must ADD new information for the write-failure
//       case, never remove the old one for the resolution-failure case.
//
// WHY node:fs's realpathSync IS MOCKED FOR (2). resolveRunnerEntry is
// module-private (never exported) and resolves './runner.js' relative to
// gates.js's OWN loaded location, which — run from this repo's source — always
// exists; there is no way to make the real tree fail that lookup without
// deleting or renaming a committed file, which a test must never do. The mock
// intercepts ONLY realpathSync calls whose target ends in 'runner.js' (exactly
// resolveRunnerEntry's two candidates), and only while a test-local flag is
// set; every other node:fs call, and every other realpathSync target, is
// forwarded to the real implementation untouched — including throughout arm
// (1), which exercises the real resolveRunnerEntry successfully before hitting
// the real, forced job-write failure.
//
// PRE-FIX both message-cases render the identical fixed string, so arm (1)'s
// assertion that the message NAMES the job-descriptor write and EISDIR is red.
// Arm (2) already holds trivially on the pre-fix tree (there is only one
// string to fall back to today) but is retained as an explicit non-regression
// anchor the fix must keep true — post-fix, both must hold simultaneously.
// ===========================================================================

const flags = vi.hoisted(() => ({ forceRunnerEntryMissing: false }));

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    realpathSync: (target, ...rest) => {
      if (
        flags.forceRunnerEntryMissing
        && typeof target === 'string'
        && target.endsWith('runner.js')
      ) {
        const error = new Error(`ENOENT: no such file or directory, realpath '${target}'`);
        error.code = 'ENOENT';
        throw error;
      }
      return actual.realpathSync(target, ...rest);
    },
  };
});

import { startGateSuite } from '../lib/runtime/gates.js';
import { runtimePaths } from '../lib/runtime/paths.js';
import { currentTreeSha } from '../lib/runtime/git.js';
import { sha256 } from '../lib/runtime/canonical.js';

vi.setConfig({ testTimeout: 20_000, hookTimeout: 20_000 });

const OLD_GENERIC_MESSAGE = 'gate runner entry could not be resolved; cannot run the detached merge-gate suite';

const cleanups = [];
afterEach(async () => {
  flags.forceRunnerEntryMissing = false;
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
    env: { ...process.env, GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null', GIT_CONFIG_SYSTEM: process.platform === 'win32' ? 'NUL' : '/dev/null' },
  });
}

async function makeProject() {
  const dir = await mkdtemp(path.join(tmpdir(), 'ape-gate-launch-cause-'));
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

function baseState(overrides = {}) {
  return {
    run_id: 'run-gate-launch-failure-cause-test',
    regate_attempts: 0,
    ship_requested: false,
    receipts: [],
    lane: 'fast',
    ...overrides,
  };
}

describe('gate-launch failure cause is surfaced, not discarded (gate-launch-failure-cause-is-discarded)', () => {
  it('names the job-descriptor write failure and its underlying cause when the job write fails, while a genuine runner-entry resolution failure still surfaces the existing message', async () => {
    const dir = await makeProject();
    // Never actually spawned in either branch below: the job-write branch
    // fails before spawnDetached is ever reached, and the entry-missing
    // branch returns before even attempting the job write.
    const suiteCommand = 'node --version';
    const config = { test_commands: { full: suiteCommand } };
    const paths = runtimePaths(dir);

    // --- (1) job-descriptor write failure ----------------------------------
    // The exact job path, derived the same way gateSuiteContext + the private
    // gateSuiteFiles compute it: cacheKey = `${treeSha}:${sha256({command})}`,
    // stem = sha256(cacheKey), job = `<runtime>/gate-suite/<stem>.job.json`.
    const treeSha = await currentTreeSha(dir);
    const state = baseState({
      lane: 'mechanical',
      receipts: [{
        receipt_hash: 'receipt-1',
        previous_receipt_hash: null,
        status: 'passed',
        agent: { role: 'implementer' },
        tests: [],
        changed_files: ['notes/note.md'],
        head_tree_sha: treeSha,
      }],
    });
    const cacheKey = `${treeSha}:${sha256({ command: suiteCommand })}`;
    const stem = sha256(cacheKey);
    const jobFile = path.join(paths.runtime, 'gate-suite', `${stem}.job.json`);
    // Renaming a file onto an existing DIRECTORY always fails (EISDIR on
    // POSIX), deterministically and independent of privilege level — never
    // bypassable by a root test runner, unlike a permission-based block.
    await mkdir(jobFile, { recursive: true });

    const jobWriteResult = await startGateSuite(dir, paths, state, config);
    expect(jobWriteResult.watch).toBeUndefined();
    expect(jobWriteResult.hit).toBeTruthy();
    const jobWriteMessage = jobWriteResult.hit.full.verification.output;
    expect(typeof jobWriteMessage).toBe('string');
    // Names the job-descriptor write specifically...
    expect(jobWriteMessage.toLowerCase()).toMatch(/job/);
    expect(jobWriteMessage.toLowerCase()).toMatch(/descriptor|job file/);
    expect(jobWriteMessage.toLowerCase()).toMatch(/writ/);
    // ...and the real underlying cause this arm forced, never a bare reuse of
    // the generic resolution-failure string.
    expect(jobWriteMessage).toMatch(/EISDIR|EPERM/);
    expect(jobWriteMessage).not.toBe(OLD_GENERIC_MESSAGE);

    await rm(jobFile, { recursive: true, force: true });

    // --- (2) genuine runner-entry resolution failure -----------------------
    flags.forceRunnerEntryMissing = true;
    let entryMissingResult;
    try {
      entryMissingResult = await startGateSuite(
        dir,
        paths,
        { ...state, run_id: 'run-gate-launch-failure-cause-test-2' },
        config,
      );
    } finally {
      flags.forceRunnerEntryMissing = false;
    }
    expect(entryMissingResult.watch).toBeUndefined();
    expect(entryMissingResult.hit).toBeTruthy();
    const entryMissingMessage = entryMissingResult.hit.full.verification.output;
    // The pre-existing message must survive unchanged: only the job-write
    // branch gains new information, never at the cost of this one.
    expect(entryMissingMessage).toBe(OLD_GENERIC_MESSAGE);
  });
});
