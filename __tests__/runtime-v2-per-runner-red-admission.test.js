import { execFileSync } from 'node:child_process';
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { recordReceipt } from '../lib/runtime/service.js';
import { seedLegacyRun as startRun } from './legacy-run-test-helper.js';

// These are historical receipt-time fallback/guard fixtures. Missing or
// unscopeable runners are refused before dispatch on new admitted runs;
// retained legacy runs must still execute the same fail-closed receipt checks.
import { runtimePaths } from '../lib/runtime/paths.js';
import { atomicWriteJson } from '../lib/runtime/storage.js';

// Roadmap entry: make red-test admission (observeRedTest, lib/runtime/service.js)
// PER-RUNNER. Today observeRedTest has NO runners branch — a config.runners list
// is IGNORED and the single derived/templated path runs — so the per-runner
// assertions below FAIL at the base tree (RED) and pass once the branch lands.
//
// Public contract (the implementer receives the identical one):
//   config.runners is a list of {id, owns:[glob], root, profile:<test_commands
//   shape>}. observeRedTest gains a branch gated behind config.runners?.length>0
//   (single path byte-identical when runners empty/unset):
//   - Route each runtime-verified authored test path (receipt.changed_files that
//     match TEST_PATH_PATTERN and exist on disk) to its owning runner(s) via the
//     runner `owns` globs. A path owned by NO runner is an ORPHAN. participants =
//     runners owning >=1 authored test path.
//   - Per owning runner resolve a SCOPED invocation for its subset, in order:
//     (1) runner.profile.targeted_template rendered over the subset; (2)
//     runner.profile.targeted (static); (3) a DERIVED targetedInvocation over
//     detectTestRunner(runner.root). No scoped:true invocation -> UNSCOPEABLE.
//   - REFUSE fail-closed BEFORE spawning anything on ANY orphan, ANY unscopeable
//     owning runner, or a malformed template — naming the offending runner id +
//     its exact paths (and orphan paths), never blaming a scopeable runner.
//   - Otherwise run each participating runner's subset through the double-run
//     exit-code-only admission PER RUNNER; admit (ok:true) only when EVERY
//     participant is deterministically red across both runs. Atomic receipt.
//
// The two plan-judge amendments:
//   AMENDMENT 1 (empty-set fail-closed): a NON-EMPTY runners list with an EMPTY
//     routed authored-test set (or zero participants) MUST refuse
//     (/found no runtime-verifiable authored test files/), never admit with
//     nothing run.
//   AMENDMENT 2 (subdir derived-scoping at the runner's own root): a runner whose
//     root is a SUBDIR with no profile.targeted_template but a manifest under that
//     subdir is scoped by detectTestRunner AT THAT SUBDIR and run against its own
//     root — the observed command is scoped to the runner-root-relative path.
//
// RED anchors (fail at base, pass post-fix): cases 1, 2, 5, 6 (also 3, 7).
// GREEN guards (green before and after): cases 4, 8.

const cleanups = [];
afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

function git(cwd, ...args) {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null', GIT_CONFIG_SYSTEM: process.platform === 'win32' ? 'NUL' : '/dev/null' },
  }).trim();
}

// A scratch git project driven entirely through the public service surface:
// baseline fixtures (fake runner scripts, subdir manifests) land in the baseline
// commit; config — including config.runners — goes through the runtime config
// file; admission runs via startRun + recordReceipt. Only authored TEST files are
// written after startRun, so the project tree sha the runtime attests is exactly
// the baseline plus those tests. `executables` get an exec bit so a fake
// `script/test` manifest is spawnable.
async function project({ files = {}, executables = {}, config = {} } = {}) {
  const dir = await mkdtemp(path.join(tmpdir(), 'ape-per-runner-'));
  cleanups.push(dir);
  await mkdir(path.join(dir, 'src'), { recursive: true });
  await writeFile(path.join(dir, 'src', 'value.js'), 'export const value = 1;\n');
  for (const [file, content] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(dir, file)), { recursive: true });
    await writeFile(path.join(dir, file), content);
  }
  for (const [file, content] of Object.entries(executables)) {
    const full = path.join(dir, file);
    await mkdir(path.dirname(full), { recursive: true });
    await writeFile(full, content);
    await chmod(full, 0o755);
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

// An out-of-repo scratch dir for fixture side-effect markers: a spawned fake
// runner writes/toggles a marker OUTSIDE the project so the runtime's red-admission
// tree-stability check stays clean, yet the test can prove whether a spawn happened.
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
    objective: 'Exercise per-runner red-test admission',
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

// A genuinely-failing authored test: a top-level throw fails deterministically
// under the derived `node --test` path (the base-tree single-path behaviour), so
// TODAY every RED anchor is admitted as an ordinary red — exactly the outcome the
// per-runner branch must change.
const THROW_TEST = 'throw new Error("authored red");\n';

// The per-runner breakdown the sealed observation must carry (contract: "e.g. a
// runners/participants array naming that runner"); accept either candidate name.
function participantsOf(observation) {
  const arr = observation?.participants ?? observation?.runners;
  return Array.isArray(arr) ? arr : null;
}

describe('per-runner red-test admission (route-to-owning-runner)', () => {
  // CASE 1 (RED anchor). A scopeable owner (via profile.targeted_template) owning
  // the authored test admits red; the sealed observation carries a per-runner
  // breakdown naming that owner. A second UNSCOPEABLE runner that owns NO authored
  // test path is not a participant and does not block admission.
  it('routes to the owning runner, admits red, and seals a per-runner breakdown (RED)', async () => {
    const dir = await project({
      files: {
        'red-runner.mjs': 'process.exit(1);\n',
        'native/Cargo.toml': '[package]\nname = "fixture"\nversion = "0.0.0"\n',
      },
      config: {
        runners: [
          {
            id: 'app-runner',
            owns: ['app/**'],
            root: '.',
            profile: { targeted_template: 'node red-runner.mjs {paths}' },
          },
          { id: 'native-runner', owns: ['native/**'], root: 'native', profile: { full: 'cargo test' } },
        ],
      },
    });
    const started = await startRun(dir, startInput({ test_paths: ['app/a.test.js'] }));
    expect(started.ok).toBe(true);
    const ticket = started.run.tickets[0];
    expect(ticket.role).toBe('test_writer');
    expect(ticket.required_checks).toContain('red-test');

    await writeTest(dir, 'app/a.test.js', THROW_TEST);
    const result = await recordReceipt(dir, rawReceipt(ticket));
    // Admitted red — the second, non-owning runner never blocks.
    expect(result.ok).toBe(true);
    const obs = result.receipt.evidence.red_test;
    expect(obs.observed).toBe(true);
    expect(obs.passed).toBe(false);
    // RED at base: today the derived `node --test app/a.test.js` runs; post-fix the
    // owning runner's scoped command drives it, so its fixture name appears.
    expect(JSON.stringify(obs)).toContain('red-runner.mjs');
    // RED at base: no per-runner breakdown key exists on the observation today.
    const parts = participantsOf(obs);
    expect(parts).not.toBeNull();
    expect(JSON.stringify(parts)).toContain('app-runner');
  }, 30_000);
});

describe('per-runner red-test admission (fail-closed refusals)', () => {
  // CASE 2 (RED anchor). Two OWNING runners span the authored set: one scopeable,
  // one UNSCOPEABLE (rust family, no targeted_template). Admission refuses
  // fail-closed BEFORE spawning anything, naming the unscopeable runner id + its
  // path, never blaming the scopeable runner.
  it('refuses an unscopeable owning runner, names it and its path, never the scopeable runner, no spawn (RED)', async () => {
    const outside = await outsideDir('ape-per-runner-spy-');
    const spyMarker = path.join(outside, 'app-runner.spawned');
    const dir = await project({
      files: {
        'spy-runner.cjs': [
          "const fs = require('node:fs');",
          `fs.writeFileSync(${JSON.stringify(spyMarker)}, 'spawned\\n');`,
          'process.exit(1);',
          '',
        ].join('\n'),
        'native/Cargo.toml': '[package]\nname = "fixture"\nversion = "0.0.0"\n',
      },
      config: {
        runners: [
          {
            id: 'app-runner',
            owns: ['app/**'],
            root: '.',
            profile: { targeted_template: 'node spy-runner.cjs {paths}' },
          },
          { id: 'native-runner', owns: ['native/**'], root: 'native', profile: { full: 'cargo test' } },
        ],
      },
    });
    const started = await startRun(dir, startInput({ test_paths: ['app/a.test.js', 'native/it.test.rs'] }));
    expect(started.ok).toBe(true);
    const ticket = started.run.tickets[0];

    await writeTest(dir, 'app/a.test.js', THROW_TEST);
    await writeTest(dir, 'native/it.test.rs', 'fn it_fails() { assert!(false); }\n');
    const result = await recordReceipt(dir, rawReceipt(ticket));
    expect(result).toMatchObject({ ok: false, rejected: true });
    const message = (result.errors ?? []).join(' ');
    // RED at base: today's single-path refusal names the detected family, not the
    // configured runner id; post-fix the offending runner id + its path are named.
    expect(message).toMatch(/native-runner/);
    expect(message).toMatch(/native\/it\.test\.rs/);
    // The scopeable runner is never blamed as the cause...
    expect(message).not.toMatch(/app-runner/);
    // ...and never spawned (fail-closed BEFORE any spawn): no tooling no-verdict,
    // and the spy fixture that would fire on spawn left no marker.
    expect(message).not.toMatch(/did not produce a test verdict/);
    expect(existsSync(spyMarker)).toBe(false);
  }, 30_000);

  // CASE 3. An authored test owned by NO runner is an ORPHAN: refuse naming the
  // orphan path, before any spawn.
  it('refuses an orphan authored path, naming it, before any spawn', async () => {
    const dir = await project({
      files: { 'red-runner.mjs': 'process.exit(1);\n' },
      config: {
        runners: [
          {
            id: 'app-runner',
            owns: ['app/**'],
            root: '.',
            profile: { targeted_template: 'node red-runner.mjs {paths}' },
          },
        ],
      },
    });
    const started = await startRun(dir, startInput({ test_paths: ['orphan/z.test.js'] }));
    expect(started.ok).toBe(true);
    const ticket = started.run.tickets[0];

    await writeTest(dir, 'orphan/z.test.js', THROW_TEST);
    const result = await recordReceipt(dir, rawReceipt(ticket));
    // RED at base: today the orphan runs via `node --test` and is admitted.
    expect(result).toMatchObject({ ok: false, rejected: true });
    const message = (result.errors ?? []).join(' ');
    expect(message).toMatch(/orphan\/z\.test\.js/);
    expect(message).not.toMatch(/did not produce a test verdict/);
  }, 30_000);

  // CASE 4 (AMENDMENT 1). A NON-EMPTY runners list with the authored test NOT on
  // disk (empty routed set) must refuse, never admit with nothing run. Green
  // before and after: the single-path empty-set refusal already carries the exact
  // message the runners-branch amendment must preserve.
  it('AMENDMENT 1: a non-empty runners list with an empty routed set refuses, never admits', async () => {
    const dir = await project({
      files: { 'red-runner.mjs': 'process.exit(1);\n' },
      config: {
        runners: [
          {
            id: 'app-runner',
            owns: ['app/**'],
            root: '.',
            profile: { targeted_template: 'node red-runner.mjs {paths}' },
          },
        ],
      },
    });
    const started = await startRun(dir, startInput({ test_paths: ['app/a.test.js'] }));
    expect(started.ok).toBe(true);
    const ticket = started.run.tickets[0];

    // Deliberately author nothing: the routed authored-test set is empty.
    const result = await recordReceipt(dir, rawReceipt(ticket));
    expect(result.ok).not.toBe(true);
    expect(result).toMatchObject({ ok: false, rejected: true });
    const message = (result.errors ?? []).join(' ');
    expect(message).toMatch(/found no runtime-verifiable authored test files/);
    expect(message).not.toMatch(/did not produce a test verdict/);
  }, 30_000);
});

describe('per-runner red-test admission (subdir derived scoping)', () => {
  // CASE 5 (RED anchor, AMENDMENT 2). A subdir runner with no profile.targeted_template
  // but a `script/test` manifest under its root is scoped by detectTestRunner AT
  // THAT SUBDIR and admitted red — the observed command is scoped to the
  // runner-root-relative path, proving the run happened at the runner's own root.
  it.skipIf(process.platform === 'win32')('AMENDMENT 2: a subdir runner scoped at its own root admits red scoped to the runner-root-relative path (RED)', async () => {
    const dir = await project({
      executables: { 'packages/js/script/test': '#!/usr/bin/env node\nprocess.exit(1);\n' },
      config: {
        runners: [
          { id: 'js', owns: ['packages/js/**'], root: 'packages/js', profile: { full: 'node --test' } },
        ],
      },
    });
    const started = await startRun(dir, startInput({ test_paths: ['packages/js/thing.test.js'] }));
    expect(started.ok).toBe(true);
    const ticket = started.run.tickets[0];

    await writeTest(dir, 'packages/js/thing.test.js', THROW_TEST);
    const result = await recordReceipt(dir, rawReceipt(ticket));
    expect(result.ok).toBe(true);
    const obs = result.receipt.evidence.red_test;
    expect(obs.observed).toBe(true);
    expect(obs.passed).toBe(false);
    // Scoped to the runner-root-relative path...
    expect(JSON.stringify(obs)).toContain('thing.test.js');
    // ...NOT the repo-root path. RED at base: today's single path runs
    // `node --test packages/js/thing.test.js` at the repo root.
    expect(JSON.stringify(obs)).not.toContain('packages/js/thing.test.js');
  }, 30_000);
});

describe('per-runner red-test admission (per-runner double-run verdicts)', () => {
  // CASE 6 (RED anchor). A participating runner whose scoped command PASSES (green)
  // blocks admission: the "every participant is red" quantifier is NOT vacuous.
  it('F12 per runner: a green participant blocks admission (RED)', async () => {
    const dir = await project({
      files: { 'green-runner.mjs': 'process.exit(0);\n' },
      config: {
        runners: [
          {
            id: 'app-runner',
            owns: ['app/**'],
            root: '.',
            profile: { targeted_template: 'node green-runner.mjs {paths}' },
          },
        ],
      },
    });
    const started = await startRun(dir, startInput({ test_paths: ['app/a.test.js'] }));
    expect(started.ok).toBe(true);
    const ticket = started.run.tickets[0];

    await writeTest(dir, 'app/a.test.js', THROW_TEST);
    const result = await recordReceipt(dir, rawReceipt(ticket));
    // RED at base: today the throwing file runs via `node --test` and is admitted;
    // post-fix the runner's green scoped command means no red phase was observed.
    expect(result).toMatchObject({ ok: false, rejected: true });
    expect((result.errors ?? []).join(' ')).toMatch(/red phase was not observed/);
  }, 30_000);

  // CASE 7 (RED anchor). A participating runner that fails run A then passes run B
  // is refused as nondeterministic per runner (the double-run flake screen).
  it('double-run flake screen per runner: a fail-then-pass participant is refused nondeterministic (RED)', async () => {
    const outside = await outsideDir('ape-per-runner-flake-');
    const marker = path.join(outside, 'first-run.marker');
    const dir = await project({
      files: {
        'flaky-runner.cjs': [
          "const fs = require('node:fs');",
          `const marker = ${JSON.stringify(marker)};`,
          'if (fs.existsSync(marker)) { process.exit(0); }',
          "fs.writeFileSync(marker, 'seen\\n');",
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
            profile: { targeted_template: 'node flaky-runner.cjs {paths}' },
          },
        ],
      },
    });
    const started = await startRun(dir, startInput({ test_paths: ['app/a.test.js'] }));
    expect(started.ok).toBe(true);
    const ticket = started.run.tickets[0];

    await writeTest(dir, 'app/a.test.js', THROW_TEST);
    const result = await recordReceipt(dir, rawReceipt(ticket));
    // RED at base: today the deterministic throwing file is admitted; post-fix the
    // runner's fail-then-pass double run is a nondeterminism refusal.
    expect(result).toMatchObject({ ok: false, rejected: true });
    const message = (result.errors ?? []).join(' ');
    expect(message).toMatch(/nondeterministic/);
    expect(message).not.toMatch(/red phase was not observed/);
  }, 30_000);
});

describe('per-runner red-test admission (empty-runners byte-identical)', () => {
  // CASE 8. config.runners = [] and unset take the byte-identical single path: a
  // deterministically failing authored test is admitted with the existing sealed
  // observation and NO per-runner breakdown key. Green before and after.
  it.each([
    ['empty runners list', []],
    ['unset runners', undefined],
  ])('%s leaves the single-path admission unchanged with no per-runner breakdown', async (_label, runners) => {
    const config = runners === undefined ? {} : { runners };
    const dir = await project({ config });
    const started = await startRun(dir, startInput({ test_paths: ['app/a.test.js'] }));
    expect(started.ok).toBe(true);
    const ticket = started.run.tickets[0];

    await writeTest(dir, 'app/a.test.js', THROW_TEST);
    const result = await recordReceipt(dir, rawReceipt(ticket));
    expect(result.ok).toBe(true);
    const obs = result.receipt.evidence.red_test;
    expect(obs.observed).toBe(true);
    expect(obs.passed).toBe(false);
    // Byte-identical single path: the per-runner breakdown key is absent.
    expect(obs.participants).toBeUndefined();
    expect(obs.runners).toBeUndefined();
  }, 30_000);
});
