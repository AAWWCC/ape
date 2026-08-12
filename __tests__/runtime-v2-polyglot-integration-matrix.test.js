import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

// Real-world polyglot INTEGRATION MATRIX.
//
// The 2026-07-22 review found that A (merge gate ran every runner at the repo
// root) and B (auto root runner's `owns:['**']` swallowed a sub-runner subtree)
// shipped in 2.9.0 despite 1495 green tests — because NO test stood up an actual
// multi-runner monorepo and ran the real gate against it. This matrix closes
// that blind spot: a small set of fixture repo SHAPES, each driven through the
// ACTUAL onboarding proposal and the ACTUAL detached merge gate, asserting the
// two properties those bugs violated:
//
//   * ROUTING (catches B): a path is owned by exactly the right runner(s); a
//     broad/root runner never swallows a more-specific sub-runner's subtree.
//   * EXECUTION CWD (catches A): each participating runner's suite executes at
//     its OWN root, not the repo root.
//
// Part 1 (proposal matrix) is fast and pure. Part 2 (gate-execution matrix)
// drives the detached gate end-to-end with cwd-recording probes (modeled on
// runtime-v2-sequential-union-gate.test.js). Part 3 pins the Windows launcher
// spawn gap (#1). Part 4 marks the still-open targeted-tests polyglot gap (#4).
//
// To add a shape: append to SHAPES with its layout + expected proposal, and (if
// it has runners) a Part-2 case. Fixtures live under os.tmpdir() mkdtemp so this
// repo's tree SHA is untouched.
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
import { proposeRunners } from '../lib/runtime/config.js';
import { buildSpawnPlan } from '../lib/runtime/runner.js';
import { evaluateTargetedRunners } from '../lib/runtime/gates.js';
import { recordReceipt, nextRun, startRun } from '../lib/runtime/service.js';
import { runtimePaths } from '../lib/runtime/paths.js';
import { atomicWriteJson } from '../lib/runtime/storage.js';

vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ---------------------------------------------------------------------------
// Fixture manifests
// ---------------------------------------------------------------------------
const VITEST_PKG = JSON.stringify({
  name: 'fixture-js',
  version: '1.0.0',
  scripts: { test: 'vitest run' },
  devDependencies: { vitest: '^2.0.0' },
}, null, 2);
const PYTEST_TOML = '[tool.pytest.ini_options]\naddopts = ""\n';

// ---------------------------------------------------------------------------
// The matrix: one entry per repo SHAPE.
//   files:    relative path -> contents (manifests + a routable .md per runner)
//   expect:   proposeRunners contract, keyed by runner root
//   gate:     Part-2 case (omit for shapes with no runners) — which .md files
//             change, and the expected participating runner roots
// ---------------------------------------------------------------------------
const SHAPES = [
  {
    name: 'js-only monorepo (single root runner)',
    files: { 'package.json': VITEST_PKG, 'note.md': '# root\n' },
    expect: [], // one family -> proposeRunners emits no polyglot runners[]
    gate: { single: true, change: ['note.md'] },
  },
  {
    name: 'python-only monorepo (single root runner)',
    files: { 'pyproject.toml': PYTEST_TOML, 'note.md': '# root\n' },
    expect: [],
    gate: { single: true, change: ['note.md'] },
  },
  {
    name: 'web/ (vitest) + api/ (pytest) subdir monorepo',
    files: {
      'web/package.json': VITEST_PKG,
      'web/note.md': '# web\n',
      'api/pyproject.toml': PYTEST_TOML,
      'api/note.md': '# api\n',
    },
    expect: [
      { root: 'api', owns: ['api/**'] },
      { root: 'web', owns: ['web/**'] },
    ],
    gate: { change: ['web/note.md', 'api/note.md'], participants: ['api', 'web'] },
  },
  {
    name: 'root (vitest) + api/ (pytest) — the owns-swallow shape',
    files: {
      'package.json': VITEST_PKG,
      'note.md': '# root\n',
      'api/pyproject.toml': PYTEST_TOML,
      'api/note.md': '# api\n',
    },
    expect: [
      { root: '.', owns: ['**', '!api/**'] },
      { root: 'api', owns: ['api/**'] },
    ],
    // Change ONLY the api subtree: the root (vitest) runner must NOT be dragged
    // in (B), and the api runner must run at api/ (A).
    gate: { change: ['api/note.md'], participants: ['api'] },
  },
];

// ---------------------------------------------------------------------------
// Detached-gate harness (adapted from runtime-v2-sequential-union-gate.test.js)
// ---------------------------------------------------------------------------
const ledger = new Set();
function track(result) {
  const pid = result?.run?.gates_watch?.pid;
  if (Number.isInteger(pid) && pid > 0) ledger.add(pid);
  return result;
}
function alive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (error) { return error.code === 'EPERM'; }
}
function killTree(pid) {
  if (!Number.isInteger(pid) || pid <= 0 || pid === process.pid) return;
  try {
    if (process.platform === 'win32') spawnSync('taskkill', ['/pid', String(pid), '/T', '/F']);
    else { try { process.kill(-pid, 'SIGKILL'); } catch { try { process.kill(pid, 'SIGKILL'); } catch {} } }
  } catch {}
}
const cleanups = [];
afterEach(async () => {
  const pids = [...ledger];
  ledger.clear();
  for (const pid of pids) if (alive(pid)) killTree(pid);
  for (let i = 0; i < 40; i += 1) { if (pids.every((pid) => !alive(pid))) break; await sleep(50); }
  await Promise.all(cleanups.splice(0).map((dir) => rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })));
});

function git(cwd, ...args) {
  execFileSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' } });
}

// Out-of-tree probe: records its execution count and its own process.cwd() so a
// suite run never perturbs the project tree SHA yet WHERE it ran is observable.
const PROBE_SRC = [
  "const fs = require('node:fs');",
  'const [mode, counter, cwddump] = process.argv.slice(2);',
  "try { fs.appendFileSync(counter, 'x'); } catch (e) {}",
  "try { fs.writeFileSync(cwddump, process.cwd()); } catch (e) {}",
  "process.exit(mode === 'fail' ? 1 : 0);",
].join('\n');

function makeProbe(outside, probe, name, mode = 'pass') {
  const counter = path.join(outside, `${name}.count`);
  const cwddump = path.join(outside, `${name}.cwd`);
  return {
    command: `node "${probe}" ${mode} "${counter}" "${cwddump}"`,
    cwd: async () => { try { return (await readFile(cwddump, 'utf8')).trim(); } catch { return null; } },
    executions: async () => { try { return (await readFile(counter, 'utf8')).length; } catch { return 0; } },
  };
}

async function buildFixture(shape) {
  const dir = await mkdtemp(path.join(tmpdir(), 'ape-matrix-'));
  const outside = await mkdtemp(path.join(tmpdir(), 'ape-matrix-out-'));
  cleanups.push(dir, outside);
  for (const [rel, contents] of Object.entries(shape.files)) {
    await mkdir(path.dirname(path.join(dir, rel)), { recursive: true });
    await writeFile(path.join(dir, rel), contents);
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
const settle = (dir, result, opts) => (result.run?.status === 'gating' ? drivePolls(dir, opts) : result);

async function startMechanical(dir, claimed) {
  const started = track(await startRun(dir, {
    objective: 'Update the polyglot workspaces',
    mode: 'phase', lane: 'mechanical', host: 'codex',
    claimed_paths: claimed, test_paths: [], requirements: ['R-MATRIX'], risk_triggers: [],
    behavioral: false, hooks_trusted: true, subagents_available: true, explicit_invocation: true,
  }));
  expect(started.ok).toBe(true);
  return started.run.tickets[0];
}
async function recordBuild(dir, build) {
  return track(await recordReceipt(dir, {
    ticket_id: build.ticket_id, status: 'passed', agent_identity: 'agent-implementer',
    tests: [{ command: 'node --version', passed: true, exit_code: 0, duration_ms: 1 }],
    findings: [], evidence: { verdict: 'pass' },
    timing: { started_at: build.issued_at, completed_at: new Date(Date.parse(build.issued_at) + 10).toISOString(), duration_ms: 10 },
  }));
}
const fullSuiteOf = (result) => result.run?.gates?.checks?.full_suite;
const expectedBasename = (dir, root) => (root === '.' ? path.basename(dir) : path.basename(root));

// ===========================================================================
// PART 1 — proposal matrix (fast, pure): the onboarding proposal per shape.
// ===========================================================================
describe('APE v2 polyglot matrix — onboarding proposal (routing source of truth)', () => {
  for (const shape of SHAPES) {
    it(`proposes correct owns/root for: ${shape.name}`, async () => {
      const { dir } = await buildFixture(shape);
      const runners = await proposeRunners(dir);
      expect(runners.map((runner) => runner.root).sort()).toEqual(shape.expect.map((entry) => entry.root).sort());
      for (const entry of shape.expect) {
        const runner = runners.find((candidate) => candidate.root === entry.root);
        expect(runner, `expected a runner rooted at ${entry.root}`).toBeTruthy();
        expect(runner.owns).toEqual(entry.owns);
      }
    });
  }
});

// ===========================================================================
// PART 2 — gate-execution matrix (integration): the REAL detached merge gate.
// Each participating runner must run at its OWN root; routing must not swallow.
// ===========================================================================
describe('APE v2 polyglot matrix — merge gate runs each runner at its own root', () => {
  for (const shape of SHAPES) {
    if (!shape.gate) continue;
    it(`gates correctly for: ${shape.name}`, async () => {
      const { dir, outside, probe } = await buildFixture(shape);

      // Derive the config from the REAL proposal, swapping each runner's profile
      // for a cwd-recording probe so execution is deterministic and observable.
      const probes = {};
      let runnersConfig = null;
      if (!shape.gate.single) {
        const proposed = await proposeRunners(dir);
        runnersConfig = proposed.map((runner) => {
          const p = makeProbe(outside, probe, runner.id);
          probes[runner.id] = { probe: p, root: runner.root };
          return { id: runner.id, owns: runner.owns, root: runner.root, profile: { full: p.command } };
        });
      }
      const rootProbe = shape.gate.single ? makeProbe(outside, probe, 'single') : null;

      await atomicWriteJson(runtimePaths(dir).config, {
        shipping: { auto_merge: true, provider: 'github', required_remote_checks: true },
        policy: { full_suite_cache: false },
        gates: { inline_grace_ms: 0 },
        test_commands: shape.gate.single ? { full: rootProbe.command } : {},
        ...(runnersConfig ? { runners: runnersConfig } : {}),
      });

      const build = await startMechanical(dir, shape.gate.change);
      for (const rel of shape.gate.change) await writeFile(path.join(dir, rel), `# updated ${rel}\n`);
      const done = await settle(dir, await recordBuild(dir, build));

      expect(done.run.status).toBe('completed');

      if (shape.gate.single) {
        // Single-runner regression: one suite, no runners[] key, at the repo root.
        const full = fullSuiteOf(done);
        expect(full.runners).toBeUndefined();
        expect(full.passed).toBe(true);
        expect(path.basename((await rootProbe.cwd()) ?? '')).toBe(path.basename(dir));
        expect(await rootProbe.executions()).toBe(1);
        return;
      }

      // ROUTING (B): exactly the expected runners participate — no swallow.
      // shape.gate.participants lists runner IDs (== the slug of each root).
      const participantIds = fullSuiteOf(done).runners.map((entry) => entry.id).sort();
      expect(participantIds).toEqual([...shape.gate.participants].sort());

      // EXECUTION CWD (A): every participating runner ran at its OWN root.
      for (const id of participantIds) {
        const { probe: p, root } = probes[id];
        expect(await p.executions(), `${id} should have run exactly once`).toBe(1);
        expect(
          path.basename((await p.cwd()) ?? ''),
          `runner ${id} (root ${root}) must run at its own root, not the repo root`,
        ).toBe(expectedBasename(dir, root));
      }
      // Non-participating runners must not have executed.
      for (const runner of runnersConfig) {
        if (!participantIds.includes(runner.id)) {
          expect(await probes[runner.id].probe.executions(), `${runner.id} must not run`).toBe(0);
        }
      }
    });
  }
});

// ===========================================================================
// PART 3 — spawn platform matrix (#1: Windows launcher spawn, FIXED).
// A bare npm-family / JVM shim launcher on win32 now routes through cmd.exe like
// an explicit .cmd/.bat; real .exe launchers keep the safer argv spawn.
// ===========================================================================
describe('APE v2 polyglot matrix — launcher spawn per platform (#1 fixed)', () => {
  it('a bare `npx` on win32 now routes through cmd.exe as one quoted string', () => {
    expect(buildSpawnPlan('npx', ['vitest', 'run'], 'win32')).toEqual({
      command: 'npx vitest run', args: [], shell: true,
    });
  });
  it('the npm-family and JVM/Ruby shim launchers also route through the shell on win32', () => {
    for (const cmd of ['npm', 'yarn', 'pnpm', 'vitest', 'mvn', 'gradle', 'bundle']) {
      expect(buildSpawnPlan(cmd, ['x'], 'win32').shell, cmd).toBe(true);
    }
  });
  it('a node_modules/.bin path shim still routes through the shell on win32', () => {
    expect(buildSpawnPlan('node_modules/.bin/vitest', ['run'], 'win32').shell).toBe(true);
  });
  it('real .exe launchers keep the safer argv spawn on win32', () => {
    for (const cmd of ['node', 'python', 'cargo', 'go', 'uv', 'deno']) {
      expect(buildSpawnPlan(cmd, ['x'], 'win32').shell, cmd).toBe(false);
    }
  });
  it('posix is unaffected: bare launchers spawn directly', () => {
    expect(buildSpawnPlan('npx', ['vitest'], 'linux')).toEqual({ command: 'npx', args: ['vitest'], shell: false });
  });
});

// ===========================================================================
// PART 4 — targeted-tests gate is now polyglot-aware (#4 FIXED).
// Each test path runs under ITS OWN runner at ITS OWN root — no toolchain runs
// over another's paths. Depth: runtime-v2-per-runner-targeted-gate.test.js.
// ===========================================================================
describe('APE v2 polyglot matrix — targeted-tests gate routes per-runner (#4 fixed)', () => {
  it('runs each test path under its own runner — pytest never receives a .tsx path', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'ape-matrix-t4-'));
    const outside = await mkdtemp(path.join(tmpdir(), 'ape-matrix-t4-out-'));
    cleanups.push(dir, outside);
    await mkdir(path.join(dir, 'web'), { recursive: true });
    await mkdir(path.join(dir, 'api'), { recursive: true });
    const probe = path.join(outside, 'targeted-probe.cjs');
    await writeFile(probe, [
      "const fs = require('node:fs');",
      'const a = process.argv.slice(2);',
      'try { fs.writeFileSync(a[0], JSON.stringify(a.slice(1))); } catch (e) {}',
      'process.exit(0);',
    ].join('\n'));
    const webArgv = path.join(outside, 'web.argv');
    const apiArgv = path.join(outside, 'api.argv');
    const config = { runners: [
      { id: 'web', owns: ['web/**'], root: 'web', profile: { targeted_template: `node "${probe}" "${webArgv}" {paths}` } },
      { id: 'api', owns: ['api/**'], root: 'api', profile: { targeted_template: `node "${probe}" "${apiArgv}" {paths}` } },
    ] };

    const result = await evaluateTargetedRunners(dir, ['web/x.test.tsx', 'api/test_y.py'], config, 30_000, 'tree-x');
    expect(result.passed).toBe(true);
    // The vitest runner got ONLY the .tsx; the pytest runner got ONLY the .py.
    expect(JSON.parse(await readFile(webArgv, 'utf8'))).toEqual(['x.test.tsx']);
    expect(JSON.parse(await readFile(apiArgv, 'utf8'))).toEqual(['test_y.py']);
  });
});
