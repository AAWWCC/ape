import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

// Regression anchor for review Bug A (multi-agent runtime review, 2026-07-22),
// found INDEPENDENTLY by two review lanes and unanimous under adversarial verify.
//
// resolveRunnerSet carries each participant's `root` all the way into the gate
// context (gates.js:329/405/516), but the DETACHED multi-runner execution path
// drops it: launchGateRunner hard-codes job.project_dir = projectDir
// (gates.js:916) and spawnDetached uses cwd: projectDir (gates.js:923), and
// runGateJob runs the suite with cwd: job.project_dir (runner.js:338). So a
// polyglot runner whose root is a SUBDIRECTORY has its full suite spawned at the
// REPO ROOT instead of the runner's own root — the exact opposite of the
// red-admission sibling observeRedTestPerRunner, which runs each participant at
// path.join(paths.root, runner.root ?? '.') (service.js:1398).
//
// This test configures a single subdir runner (root: 'web') whose full command
// is a probe that records its own process.cwd() and passes IFF it runs at the
// runner root. The gate must therefore (a) run the suite at <dir>/web and
// (b) pass. Both assertions are RED now — the suite runs at <dir> (repo root),
// the probe exits non-zero, the union fails, and the run blocks. They turn green
// once launchGateRunner threads participant.root into the job cwd.
//
// Modeled on __tests__/runtime-v2-sequential-union-gate.test.js: an mkdtemp
// project driven through the public service surface, out-of-tree probe so a
// suite run never perturbs the project tree SHA, autoMergeGithub mocked so a
// passing gate completes in-call, and the real gate/detached machinery exercised.
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
import { recordReceipt, nextRun, startRun } from '../lib/runtime/service.js';
import { runtimePaths } from '../lib/runtime/paths.js';
import { atomicWriteJson } from '../lib/runtime/storage.js';

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

const ledger = new Set();
function track(result) {
  const pid = result?.run?.gates_watch?.pid;
  if (Number.isInteger(pid) && pid > 0) ledger.add(pid);
  return result;
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
    // best-effort only
  }
}

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

async function settle(dir, result, opts) {
  return result.run?.status === 'gating' ? await drivePolls(dir, opts) : result;
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

function git(cwd, ...args) {
  execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' },
  });
}

// A probe that lives OUTSIDE the project (so its execution never perturbs the
// project tree SHA), records its own process.cwd() to a dump file, and exits 0
// IFF the basename of that cwd matches the expected runner-root basename.
// Basename comparison sidesteps macOS /var -> /private/var symlink resolution:
// a suite correctly run at <dir>/web has basename 'web'; one wrongly run at the
// repo root has the mkdtemp dir's basename.
const CWD_PROBE_SRC = [
  "const fs = require('node:fs');",
  "const path = require('node:path');",
  'const [cwddump, expectBase] = process.argv.slice(2);',
  'const cwd = process.cwd();',
  "try { fs.writeFileSync(cwddump, cwd); } catch (e) {}",
  'process.exit(path.basename(cwd) === expectBase ? 0 : 1);',
].join('\n');

async function makeProject() {
  const dir = await mkdtemp(path.join(tmpdir(), 'ape-gate-cwd-'));
  const outside = await mkdtemp(path.join(tmpdir(), 'ape-gate-cwd-out-'));
  cleanups.push(dir, outside);
  // A subdir runner root 'web' with a .md payload keeps the run on the
  // MECHANICAL lane (isMechanicalPath) so the full-suite union is exactly the
  // gate under test and no behavioral test_paths are demanded.
  await mkdir(path.join(dir, 'web'), { recursive: true });
  await writeFile(path.join(dir, 'web', 'note.md'), '# web\n');
  git(dir, 'init', '-q');
  git(dir, 'config', 'user.email', 'ape@example.test');
  git(dir, 'config', 'user.name', 'APE Test');
  git(dir, 'add', '.');
  git(dir, 'commit', '-qm', 'test: baseline');
  const probe = path.join(outside, 'cwd-probe.cjs');
  await writeFile(probe, CWD_PROBE_SRC);
  const cwddump = path.join(outside, 'web.cwd');
  return { dir, outside, probe, cwddump };
}

async function writeConfig(dir, runners) {
  await atomicWriteJson(runtimePaths(dir).config, {
    shipping: { auto_merge: true, provider: 'github', required_remote_checks: true },
    policy: { full_suite_cache: false },
    gates: { inline_grace_ms: 0 },
    test_commands: {},
    runners,
  });
}

async function startMechanical(dir, claimed) {
  const started = track(await startRun(dir, {
    objective: 'Update the web workspace',
    mode: 'phase',
    lane: 'mechanical',
    host: 'codex',
    claimed_paths: claimed,
    test_paths: [],
    requirements: ['R-CWD'],
    risk_triggers: [],
    behavioral: false,
    hooks_trusted: true,
    subagents_available: true,
    explicit_invocation: true,
  }));
  expect(started.ok).toBe(true);
  return started.run.tickets[0];
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

const fullSuiteOf = (result) => result.run?.gates?.checks?.full_suite;

describe('APE v2 polyglot merge gate runs a subdir runner at its OWN root (review Bug A)', () => {
  it('spawns the web runner suite at <dir>/web and passes the union — not at the repo root', async () => {
    const { dir, outside, probe, cwddump } = await makeProject();
    const web = {
      id: 'web',
      owns: ['web/**'],
      root: 'web',
      profile: { full: `node "${probe}" "${cwddump}" web` },
    };
    await writeConfig(dir, [web]);

    const build = await startMechanical(dir, ['web/note.md']);
    expect(build.role).toBe('implementer');
    await writeFile(path.join(dir, 'web', 'note.md'), '# web\n\nUpdated.\n');
    const result = await recordBuild(dir, build);
    const done = await settle(dir, result);

    // Where did the gate actually run the web runner's suite? Correct: the
    // runner's own root <dir>/web (basename 'web'). Bug: the repo root <dir>
    // (basename = the mkdtemp dir name).
    const actualCwd = (await readFile(cwddump, 'utf8')).trim();
    expect(path.basename(actualCwd)).toBe('web');

    // Consequence: the probe passes only when run at the runner root, so the
    // union gate passes and the run completes. RED now: it runs at the repo
    // root, the probe exits non-zero, the union fails, and the run blocks.
    const fullSuite = fullSuiteOf(done);
    expect(fullSuite.passed).toBe(true);
    expect(done.run.status).toBe('completed');
  });
});
