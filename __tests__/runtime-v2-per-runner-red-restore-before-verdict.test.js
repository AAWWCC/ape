import { execFileSync } from 'node:child_process';
import { access, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { recordReceipt, startRun } from '../lib/runtime/service.js';
import { runtimePaths } from '../lib/runtime/paths.js';
import { atomicWriteJson } from '../lib/runtime/storage.js';

// Objective: prove observeRedTestPerRunner (lib/runtime/service.js) restores the
// tree BEFORE a POST-SPAWN per-runner verdict refusal returns, mirroring the
// single (non-per-runner) red-admission path (observeRedTest, whose restore
// block precedes every verdict check). On the base tree the per-runner
// post-spawn refusals (green "red phase was not observed", divergent/
// nondeterministic, per-run no-verdict, pytest exit 4/5) return from INSIDE the
// participant loop BEFORE the whole-tree stability recompute + created-artifact
// restore block, so a runner that creates an in-tree artifact on a refusal path
// STRANDS that artifact — which then walls the runtime's bounded retry behind a
// misleading unclaimed-write rejection.
//
// CASES 1 & 2 are the RED anchors (fail at base — artifact stranded; green only
// once the restore is reordered ahead of the verdict refusals). CASE 3 is the
// admit-path green guard (green before and after) proving the reorder does not
// regress the admit path's restore + restored_artifacts reporting.
//
// Determinism/tree-stability (so the OUTER runtime's twice-run red admission of
// THIS file is itself deterministic and leaves the repo tree clean): every
// project dir and runner fixture lives in a mkdtemp dir OUTSIDE this repo; the
// CASE-2 nondeterminism toggle marker lives in a SEPARATE mkdtemp dir (outside
// the repo), never under a path that could perturb the repo tree; each test
// mints a fresh mkdtemp so the inner fixture behaviour is identical across both
// outer admission executions and the file's pass/fail is deterministic; the
// participant's run A and run B stay back-to-back (the double-run flake screen).

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

// Disk-state assertion helper (adopted from runtime-v2-red-test-side-effects's
// "restore precedes verdict" single-path case): exists() over fs.access is the
// canonical proxy for whether the attested tree was restored before the verdict
// refusal returned — i.e. whether a subsequent bounded retry is NOT walled by an
// unclaimed-write rejection.
async function exists(file) {
  try {
    await access(file);
    return true;
  } catch {
    return false;
  }
}

// A scratch git project driven entirely through the public service surface:
// baseline fixtures (fake runner scripts) land in the baseline commit; config —
// including config.runners — goes through the runtime config file via
// atomicWriteJson; admission runs via startRun + recordReceipt. Only authored
// TEST files are written after startRun.
async function project({ files = {}, config = {} } = {}) {
  const dir = await mkdtemp(path.join(tmpdir(), 'ape-per-runner-restore-'));
  cleanups.push(dir);
  await mkdir(path.join(dir, 'src'), { recursive: true });
  await writeFile(path.join(dir, 'src', 'value.js'), 'export const value = 1;\n');
  for (const [file, content] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(dir, file)), { recursive: true });
    await writeFile(path.join(dir, file), content);
  }
  git(dir, 'init', '-q');
  git(dir, 'config', 'user.email', 'ape@example.test');
  git(dir, 'config', 'user.name', 'APE Test');
  git(dir, 'add', '.');
  git(dir, 'commit', '-qm', 'baseline');
  await atomicWriteJson(runtimePaths(dir).config, {
    shipping: { auto_merge: false, provider: 'github', required_remote_checks: false },
    test_commands: { full: 'node --test' },
    ...config,
  });
  return dir;
}

// An out-of-repo scratch dir for a fixture's nondeterminism toggle marker: a
// spawned fake runner toggles a marker OUTSIDE the project so the runtime's
// red-admission tree-stability check stays about the repo tree only.
async function outsideDir(prefix) {
  const dir = await mkdtemp(path.join(tmpdir(), prefix));
  cleanups.push(dir);
  return dir;
}

async function writeTest(dir, rel, content) {
  const full = path.join(dir, rel);
  await mkdir(path.dirname(full), { recursive: true });
  await writeFile(full, content);
}

function startInput(overrides = {}) {
  return {
    objective: 'Exercise per-runner red-restore-before-verdict',
    mode: 'phase',
    lane: 'fast',
    host: 'codex',
    claimed_paths: ['src/value.js'],
    test_paths: ['app/a.test.js'],
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

// The authored test file's CONTENT is irrelevant to the observation: the RUNNER
// fixture (not node:test) is what the runtime executes, so any test-pathname
// content works — the fixture ignores its {paths} argument.
const AUTHORED_TEST = '// authored placeholder; the runner fixture drives the verdict\n';

// The in-tree artifact each fixture creates, written relative to the runner cwd
// (runner root '.' === repo root) so it lands in the repo tree and is a "created
// artifact" the restore block must remove.
const ARTIFACT = 'runner-artifact.tmp';

describe('per-runner red-test: restore precedes the post-spawn verdict refusal', () => {
  // CASE 1 (RED anchor). A single owning runner whose fixture WRITES an in-tree
  // artifact on EVERY run then exits 0 (green on both runs of the double-run
  // screen). The per-runner path refuses with "red phase was not observed"; the
  // refusal must leave the tree exactly as the receipt attested — the created
  // artifact removed. On base code the green refusal returns from inside the
  // participant loop BEFORE the restore block, stranding the artifact (exists
  // true) → RED. Post-fix the restore precedes the verdict → exists false.
  it('a green participant that created an in-tree artifact is refused AND the artifact is restored before the refusal (RED)', async () => {
    const dir = await project({
      files: {
        'green-artifact-runner.cjs': [
          "const fs = require('node:fs');",
          `fs.writeFileSync(${JSON.stringify(ARTIFACT)}, 'generated');`,
          'process.exit(0);',
          '',
        ].join('\n'),
      },
      config: {
        runners: [
          {
            id: 'app-runner',
            owns: ['app/**'],
            root: '.',
            profile: { targeted_template: 'node green-artifact-runner.cjs {paths}' },
          },
        ],
      },
    });
    const started = await startRun(dir, startInput({ test_paths: ['app/a.test.js'] }));
    expect(started.ok).toBe(true);
    const ticket = started.run.tickets[0];
    expect(ticket.role).toBe('test_writer');
    expect(ticket.required_checks).toContain('red-test');

    await writeTest(dir, 'app/a.test.js', AUTHORED_TEST);
    const result = await recordReceipt(dir, rawReceipt(ticket));
    // Green participant → the "red phase was not observed" refusal.
    expect(result).toMatchObject({ ok: false, rejected: true });
    expect((result.errors ?? []).join(' ')).toMatch(/red phase was not observed/);
    // RED at base: the green refusal returns before the restore block → the
    // artifact is stranded. exists()===false is the canonical proxy for "a
    // subsequent bounded retry is not walled by an unclaimed-write rejection".
    expect(await exists(path.join(dir, ARTIFACT))).toBe(false);
  }, 30_000);

  // CASE 2 (RED anchor). A single owning runner whose fixture WRITES the in-tree
  // artifact on EVERY run and toggles an OUTSIDE-repo marker (in a separate
  // mkdtemp dir, NEVER under the repo tree) so run A exits 1 (fail) and run B
  // exits 0 (pass) — a per-runner fail-then-pass divergence. The path refuses as
  // nondeterministic; the refusal must still restore the created artifact. On
  // base code the divergent refusal returns before the restore block → stranded
  // (exists true) → RED. Post-fix the restore precedes the verdict → exists false.
  it('a nondeterministic participant that created an in-tree artifact is refused AND the artifact is restored before the refusal (RED)', async () => {
    const outside = await outsideDir('ape-per-runner-restore-flake-');
    const marker = path.join(outside, 'first-run.marker');
    const dir = await project({
      files: {
        'flaky-artifact-runner.cjs': [
          "const fs = require('node:fs');",
          `const marker = ${JSON.stringify(marker)};`,
          // Write the in-tree artifact on EVERY run (before deciding the verdict)
          // so it is stranded on whichever run the loop refuses from.
          `fs.writeFileSync(${JSON.stringify(ARTIFACT)}, 'generated');`,
          // Toggle the OUTSIDE-repo marker: run A (no marker) fails, run B passes.
          'if (fs.existsSync(marker)) { process.exit(0); }',
          "fs.writeFileSync(marker, 'seen');",
          'process.exit(1);',
          '',
        ].join('\n'),
      },
      config: {
        runners: [
          {
            id: 'app-runner',
            owns: ['app/**'],
            root: '.',
            profile: { targeted_template: 'node flaky-artifact-runner.cjs {paths}' },
          },
        ],
      },
    });
    const started = await startRun(dir, startInput({ test_paths: ['app/a.test.js'] }));
    expect(started.ok).toBe(true);
    const ticket = started.run.tickets[0];

    await writeTest(dir, 'app/a.test.js', AUTHORED_TEST);
    const result = await recordReceipt(dir, rawReceipt(ticket));
    // Divergent double run → the nondeterminism refusal (never conflated with
    // the green "red phase was not observed" message).
    expect(result).toMatchObject({ ok: false, rejected: true });
    const message = (result.errors ?? []).join(' ');
    expect(message).toMatch(/nondeterministic/);
    // RED at base: the divergent refusal returns before the restore block → the
    // artifact is stranded. exists()===false is the canonical proxy for "a
    // subsequent bounded retry is not walled by an unclaimed-write rejection".
    expect(await exists(path.join(dir, ARTIFACT))).toBe(false);
  }, 30_000);

  // CASE 3 (green guard, before and after). A single owning runner whose fixture
  // WRITES the in-tree artifact then exits 1 DETERMINISTICALLY (red on both
  // runs). This reaches the admit path, which today already runs the restore
  // block: the created artifact is removed and reported in restored_artifacts.
  // The reorder must not regress this, so it is a green guard — CASES 1 and 2
  // supply the required red anchor.
  it('a deterministically-red participant that created an in-tree artifact is admitted, restores it, and reports restored_artifacts (green guard)', async () => {
    const dir = await project({
      files: {
        'red-artifact-runner.cjs': [
          "const fs = require('node:fs');",
          `fs.writeFileSync(${JSON.stringify(ARTIFACT)}, 'generated');`,
          'process.exit(1);',
          '',
        ].join('\n'),
      },
      config: {
        runners: [
          {
            id: 'app-runner',
            owns: ['app/**'],
            root: '.',
            profile: { targeted_template: 'node red-artifact-runner.cjs {paths}' },
          },
        ],
      },
    });
    const started = await startRun(dir, startInput({ test_paths: ['app/a.test.js'] }));
    expect(started.ok).toBe(true);
    const ticket = started.run.tickets[0];

    await writeTest(dir, 'app/a.test.js', AUTHORED_TEST);
    const result = await recordReceipt(dir, rawReceipt(ticket));
    expect(result.ok).toBe(true);
    const obs = result.receipt.evidence.red_test;
    expect(obs.observed).toBe(true);
    expect(obs.passed).toBe(false);
    // The admit path already reaches the restore block today: the created
    // artifact is removed and reported. exists()===false confirms the tree the
    // receipt attests is exactly restored, and the reorder keeps both.
    expect(obs.restored_artifacts).toContain(ARTIFACT);
    expect(await exists(path.join(dir, ARTIFACT))).toBe(false);
  }, 30_000);
});
