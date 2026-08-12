import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { runMergeGates, startGateSuite } from '../lib/runtime/gates.js';
import { currentTreeSha } from '../lib/runtime/git.js';
import { sha256 } from '../lib/runtime/canonical.js';
import { atomicWriteJson } from '../lib/runtime/storage.js';

const PASS_CMD = 'node -e "process.exit(0)"';
const FAIL_CMD = 'node -e "process.exit(1)"';
// Outlives any lane deadline; exits nonzero when the deadline SIGTERM lands
// (win32's taskkill force-kills with its own code), so without the timed_out
// marker the result would be indistinguishable from an ordinary red suite.
const HANG_CMD = 'node -e "process.on(\'SIGTERM\', () => process.exit(7)); setInterval(() => {}, 1000)"';

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

async function project({ withPluginManifests = false, files = {} } = {}) {
  const dir = await mkdtemp(path.join(tmpdir(), 'ape-gates-'));
  cleanups.push(dir);
  await mkdir(path.join(dir, 'src'));
  await writeFile(path.join(dir, 'src', 'value.js'), 'export const value = 1;\n');
  for (const [file, content] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(dir, file)), { recursive: true });
    await writeFile(path.join(dir, file), content);
  }
  if (withPluginManifests) {
    await mkdir(path.join(dir, '.claude-plugin'));
    await mkdir(path.join(dir, '.codex-plugin'));
    await writeFile(path.join(dir, '.claude-plugin', 'plugin.json'), JSON.stringify({
      name: 'ape-test',
      version: '1.0.0',
      description: 'test plugin',
    }));
    // Deliberately omits `skills`: optional per the official Codex schema.
    await writeFile(path.join(dir, '.codex-plugin', 'plugin.json'), JSON.stringify({
      name: 'ape-test',
      version: '1.0.0',
      mcpServers: { ape: { command: 'node' } },
    }));
  }
  git(dir, 'init', '-q');
  git(dir, 'config', 'user.email', 'ape@example.test');
  git(dir, 'config', 'user.name', 'APE Test');
  git(dir, 'add', '.');
  git(dir, 'commit', '-qm', 'test: baseline');
  const paths = { runtime: path.join(dir, '.ape', 'runtime') };
  await mkdir(paths.runtime, { recursive: true });
  const treeSha = await currentTreeSha(dir);
  return { dir, paths, treeSha };
}

// A recordable npm test target: the project's package.json points `npm test`
// at run-tests.cjs, which records its argv OUTSIDE the project (so executions
// never perturb the tree SHA) and exits 0 only once a marker file exists.
async function derivedRunnerProject() {
  const outside = await mkdtemp(path.join(tmpdir(), 'ape-gates-derived-'));
  cleanups.push(outside);
  const record = path.join(outside, 'argv.json');
  const marker = path.join(outside, 'pass.marker');
  const fixture = await project({
    files: {
      'package.json': JSON.stringify({ name: 'fixture', version: '1.0.0', scripts: { test: 'node run-tests.cjs' } }),
      'run-tests.cjs': [
        "const fs = require('node:fs');",
        `fs.writeFileSync(${JSON.stringify(record)}, JSON.stringify(process.argv.slice(2)));`,
        `process.exit(fs.existsSync(${JSON.stringify(marker)}) ? 0 : 1);`,
      ].join('\n'),
      '__tests__/value.test.js': 'export const covered = true;\n',
    },
  });
  return {
    ...fixture,
    arm: () => writeFile(marker, 'pass\n'),
    recordedArgv: async () => JSON.parse(await readFile(record, 'utf8')),
  };
}

function stateFor(treeSha, {
  changedFiles = ['src/value.js'],
  lane = 'fast',
  highRisk = false,
  policy = undefined,
  regateAttempts = undefined,
} = {}) {
  return {
    lane,
    high_risk: highRisk,
    ...(policy === undefined ? {} : { policy }),
    ...(regateAttempts === undefined ? {} : { regate_attempts: regateAttempts }),
    receipts: [{
      receipt_hash: 'a',
      previous_receipt_hash: null,
      status: 'passed',
      agent: { role: 'implementer' },
      // Agent-asserted passing test evidence — must never satisfy the gate on
      // its own on a behavioral lane (F12).
      tests: [{ command: 'npx vitest run fabricated.test.js', passed: true, exit_code: 0 }],
      changed_files: changedFiles,
      head_tree_sha: treeSha,
    }],
  };
}

function configFor(overrides = {}) {
  return {
    policy: { fast_max_files: 6, full_suite_cache: true, ...(overrides.policy ?? {}) },
    test_commands: { targeted: null, full: PASS_CMD, ...(overrides.test_commands ?? {}) },
    deadlines_ms: {},
  };
}

describe('targeted_tests gate executes test_commands.targeted (F12/F18)', () => {
  it('fails the gate when the configured targeted command fails, despite passing receipt assertions', async () => {
    const { dir, paths, treeSha } = await project();
    const result = await runMergeGates(dir, paths, stateFor(treeSha), configFor({
      test_commands: { targeted: FAIL_CMD },
    }));
    expect(result.checks.targeted_tests.verified).toBe(true);
    expect(result.checks.targeted_tests.passed).toBe(false);
    expect(result.checks.targeted_tests.command).toBe(FAIL_CMD);
    expect(result.passed).toBe(false);
  });

  it('passes the gate as verified evidence when the configured targeted command passes', async () => {
    const { dir, paths, treeSha } = await project();
    const result = await runMergeGates(dir, paths, stateFor(treeSha), configFor({
      test_commands: { targeted: PASS_CMD },
    }));
    expect(result.checks.targeted_tests).toMatchObject({
      passed: true,
      verified: true,
      command: PASS_CMD,
    });
    expect(result.checks.targeted_tests.result_hash).toMatch(/^[0-9a-f]{64}$/);
    // receipt.tests[] is demoted to advisory evidence alongside the execution.
    expect(result.checks.targeted_tests.advisory).toMatchObject({
      source: 'receipt.tests',
      receipts_with_passing_tests: 1,
    });
    expect(result.passed).toBe(true);
  });
});

describe('targeted_tests gate derives a runtime execution when unconfigured (F12)', () => {
  // F12 regression: fabricated receipt.tests[] evidence with no runtime
  // execution can never produce a passing merge evaluation on a behavioral
  // lane. Here nothing is derivable (no runner, no test paths), so the gate
  // must FAIL with a configuration hint — the old code passed it unverified.
  it('fails a behavioral lane outright when no targeted execution can be derived', async () => {
    const { dir, paths, treeSha } = await project();
    const result = await runMergeGates(dir, paths, stateFor(treeSha), configFor());
    expect(result.checks.targeted_tests.passed).toBe(false);
    expect(result.checks.targeted_tests.verified).toBe(false);
    expect(result.checks.targeted_tests.reason).toMatch(/configure test_commands\.targeted/);
    expect(result.passed).toBe(false);
  });

  it('fails when test paths exist but no runner is detectable, telling the operator to configure the command', async () => {
    const { dir, paths } = await project({ files: { '__tests__/value.test.js': 'export const covered = true;\n' } });
    const treeSha = await currentTreeSha(dir);
    const state = stateFor(treeSha, { changedFiles: ['src/value.js', '__tests__/value.test.js'] });
    const result = await runMergeGates(dir, paths, state, configFor());
    expect(result.checks.targeted_tests.passed).toBe(false);
    expect(result.checks.targeted_tests.reason).toMatch(/no test runner detected/);
    expect(result.checks.targeted_tests.reason).toMatch(/configure test_commands\.targeted/);
    expect(result.passed).toBe(false);
  });

  it('derives the detected runner over the receipt-attested test paths and gates on the executed result', async () => {
    const fixture = await derivedRunnerProject();
    const state = stateFor(fixture.treeSha, {
      changedFiles: ['src/value.js', '__tests__/value.test.js'],
    });

    // Unarmed: the derived execution fails, so fabricated receipt assertions
    // cannot ship the run.
    const failing = await runMergeGates(fixture.dir, fixture.paths, state, configFor());
    expect(failing.checks.targeted_tests.verified).toBe(true);
    expect(failing.checks.targeted_tests.derived).toBe(true);
    expect(failing.checks.targeted_tests.passed).toBe(false);
    expect(failing.passed).toBe(false);

    await fixture.arm();
    const passing = await runMergeGates(fixture.dir, fixture.paths, state, configFor());
    expect(passing.checks.targeted_tests).toMatchObject({
      passed: true,
      verified: true,
      derived: true,
    });
    // Windows detects the npm.cmd shim, other platforms plain npm.
    expect(passing.checks.targeted_tests.command).toMatch(
      /^npm(\.cmd)? test -- __tests__\/value\.test\.js$/,
    );
    expect(passing.checks.targeted_tests.result_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(passing.passed).toBe(true);
    // The bounded invocation actually received the validated test paths.
    expect(await fixture.recordedArgv()).toEqual(['__tests__/value.test.js']);
  }, 30_000);

  it('keeps the mechanical lane pass condition without any targeted execution', async () => {
    const { dir, paths, treeSha } = await project();
    const result = await runMergeGates(dir, paths, stateFor(treeSha, { lane: 'mechanical' }), configFor());
    expect(result.checks.targeted_tests).toMatchObject({ passed: true, verified: false });
    expect(result.passed).toBe(true);
  });
});

describe('conditional_audits honors the persisted run policy (F18)', () => {
  it('lets a high-risk run ship without a security receipt when the run policy disabled the review', async () => {
    const { dir, paths, treeSha } = await project();
    const state = stateFor(treeSha, {
      lane: 'mechanical',
      highRisk: true,
      policy: { high_risk_security_review: false },
    });
    const result = await runMergeGates(dir, paths, state, configFor());
    expect(result.checks.conditional_audits).toEqual({ passed: true, required: false });
    expect(result.passed).toBe(true);
  });

  it('still requires the security receipt when the persisted policy leaves the review armed', async () => {
    const { dir, paths, treeSha } = await project();
    const state = stateFor(treeSha, {
      lane: 'mechanical',
      highRisk: true,
      policy: { high_risk_security_review: true },
    });
    const result = await runMergeGates(dir, paths, state, configFor());
    expect(result.checks.conditional_audits).toEqual({ passed: false, required: true });
    expect(result.passed).toBe(false);
  });
});

async function seedPassingCacheEntry(paths, treeSha, command) {
  const cachePath = path.join(paths.runtime, 'suite-cache.json');
  const cacheKey = `${treeSha}:${sha256({ command })}`;
  await atomicWriteJson(cachePath, {
    schema_version: '2.0.0',
    results: {
      [cacheKey]: {
        passed: true,
        tree_sha: treeSha,
        command,
        result_hash: 'seeded',
        recorded_at: new Date().toISOString(),
        verification: { passed: true },
      },
    },
  });
}

describe('policy.full_suite_cache wiring (F18)', () => {
  it('full_suite_cache=false bypasses a cached pass and re-executes the suite', async () => {
    const { dir, paths, treeSha } = await project();
    await seedPassingCacheEntry(paths, treeSha, FAIL_CMD);
    const result = await runMergeGates(dir, paths, stateFor(treeSha, { lane: 'mechanical' }), configFor({
      policy: { full_suite_cache: false },
      test_commands: { full: FAIL_CMD },
    }));
    expect(result.checks.full_suite.cached).toBe(false);
    expect(result.checks.full_suite.passed).toBe(false);
    expect(result.passed).toBe(false);
  });

  it('full_suite_cache=true (default) still serves the cached pass', async () => {
    const { dir, paths, treeSha } = await project();
    await seedPassingCacheEntry(paths, treeSha, FAIL_CMD);
    const result = await runMergeGates(dir, paths, stateFor(treeSha, { lane: 'mechanical' }), configFor({
      test_commands: { full: FAIL_CMD },
    }));
    expect(result.checks.full_suite.cached).toBe(true);
    expect(result.checks.full_suite.passed).toBe(true);
  });
});

describe('full_suite gate serialized re-gate variant (serial re-gate, 2.0.32)', () => {
  it('first evaluation with full_serial configured still runs test_commands.full', async () => {
    const { dir, paths, treeSha } = await project();
    // Had the serial variant run here, the gate would have failed (FAIL_CMD):
    // the serialized shape is a re-gate affordance only, never the first roll.
    const result = await runMergeGates(dir, paths, stateFor(treeSha, { lane: 'mechanical' }), configFor({
      test_commands: { full: PASS_CMD, full_serial: FAIL_CMD },
    }));
    expect(result.checks.full_suite.passed).toBe(true);
    expect(result.checks.full_suite.command).toBe(PASS_CMD);
  });

  it('re-gate evaluations execute the serialized variant in place of test_commands.full', async () => {
    const { dir, paths, treeSha } = await project();
    // The flake-recovery affordance itself: the parallel command would fail
    // again, but the attested-equivalent serialized suite decides the gate.
    // Mechanical lane so the overall result isolates full_suite (a behavioral
    // lane would also demand a targeted execution this bare fixture cannot
    // derive).
    const result = await runMergeGates(
      dir, paths,
      stateFor(treeSha, { lane: 'mechanical', regateAttempts: 1 }),
      configFor({ test_commands: { full: FAIL_CMD, full_serial: PASS_CMD } }),
    );
    expect(result.checks.full_suite.passed).toBe(true);
    expect(result.checks.full_suite.command).toBe(PASS_CMD);
    expect(result.passed).toBe(true);
  });

  it('re-gate without full_serial configured is byte-identical to the first evaluation', async () => {
    const { dir, paths, treeSha } = await project();
    const result = await runMergeGates(
      dir, paths,
      stateFor(treeSha, { lane: 'mechanical', regateAttempts: 1 }),
      configFor({ test_commands: { full: FAIL_CMD } }),
    );
    expect(result.checks.full_suite.passed).toBe(false);
    expect(result.checks.full_suite.command).toBe(FAIL_CMD);
  });

  it('the suite cache never lets full and full_serial results answer for each other', async () => {
    const { dir, paths, treeSha } = await project();
    // A cached pass keyed to the FULL command must not be served for the
    // serial command on re-gate: the cache key hashes the resolved command.
    await seedPassingCacheEntry(paths, treeSha, PASS_CMD);
    const result = await runMergeGates(
      dir, paths,
      stateFor(treeSha, { lane: 'mechanical', regateAttempts: 1 }),
      configFor({ test_commands: { full: PASS_CMD, full_serial: FAIL_CMD } }),
    );
    expect(result.checks.full_suite.cached).toBe(false);
    expect(result.checks.full_suite.passed).toBe(false);
    // No pollution in either direction: the seeded full-command entry is
    // untouched, and the serial command recorded its own failure under its
    // own key.
    const cache = JSON.parse(await readFile(path.join(paths.runtime, 'suite-cache.json'), 'utf8'));
    const fullKey = `${treeSha}:${sha256({ command: PASS_CMD })}`;
    const serialKey = `${treeSha}:${sha256({ command: FAIL_CMD })}`;
    expect(cache.results[fullKey].passed).toBe(true);
    expect(cache.results[fullKey].result_hash).toBe('seeded');
    expect(cache.results[serialKey].passed).toBe(false);
  });
});

describe('deadline-killed gate executions surface timed_out (audit: runner.js:178)', () => {
  it('marks full_suite and targeted checks timed_out when the lane deadline kills them', async () => {
    const { dir, paths, treeSha } = await project();
    const result = await runMergeGates(dir, paths, stateFor(treeSha), {
      ...configFor({ test_commands: { full: HANG_CMD, targeted: HANG_CMD } }),
      deadlines_ms: { fast: 400 },
    });
    // Targeted preflight timed out, so the expensive full suite never starts.
    // The operator still sees the actual timeout on the deciding check.
    expect(result.checks.full_suite).toMatchObject({ passed: false, skipped: true });
    expect(result.checks.targeted_tests).toMatchObject({
      passed: false,
      verified: true,
      timed_out: true,
    });
    expect(result.passed).toBe(false);
  }, 30_000);

  it('does not launch the full suite after a deterministic targeted preflight failure', async () => {
    const outside = await mkdtemp(path.join(tmpdir(), 'ape-gate-order-'));
    cleanups.push(outside);
    const fullMarker = path.join(outside, 'full-ran');
    const fullProbe = path.join(outside, 'full-probe.cjs');
    await writeFile(fullProbe, "require('node:fs').writeFileSync(process.argv[2], 'ran');\n");
    const full = `node "${fullProbe}" "${fullMarker}"`;
    const { dir, paths, treeSha } = await project();
    const result = await runMergeGates(dir, paths, stateFor(treeSha), configFor({
      test_commands: { targeted: FAIL_CMD, full },
    }));
    expect(result.checks.targeted_tests).toMatchObject({ passed: false, verified: true });
    expect(result.checks.full_suite).toMatchObject({ passed: false, skipped: true });
    await expect(readFile(fullMarker, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('returns a synchronous skipped hit instead of arming a detached watch after a red preflight', async () => {
    const { dir, paths, treeSha } = await project();
    const start = await startGateSuite(dir, paths, stateFor(treeSha), configFor({
      test_commands: { targeted: FAIL_CMD, full: PASS_CMD },
    }));
    expect(start.watch).toBeUndefined();
    expect(start.hit?.ctx.preflight).toMatchObject({ passed: false });
    expect(start.hit?.full).toMatchObject({ passed: false, skipped: true });
  });

  it('keeps the timed_out key absent on ordinary verdicts (hash-stable check shape)', async () => {
    const { dir, paths, treeSha } = await project();
    const result = await runMergeGates(dir, paths, stateFor(treeSha), configFor({
      test_commands: { full: PASS_CMD, targeted: FAIL_CMD },
    }));
    expect('timed_out' in result.checks.full_suite).toBe(false);
    expect('timed_out' in result.checks.targeted_tests).toBe(false);
  });
});

describe('plugin validation runs in-process (F13/F42)', () => {
  it('validates both manifests without any vendor CLI and accepts a Codex manifest omitting skills', async () => {
    const { dir, paths, treeSha } = await project({ withPluginManifests: true });
    // Mechanical lane: plugin validation is the behavior under test here; the
    // derived targeted execution has its own suite above.
    const state = stateFor(treeSha, {
      lane: 'mechanical',
      changedFiles: ['src/value.js', '.claude-plugin/plugin.json', '.codex-plugin/plugin.json'],
    });
    const result = await runMergeGates(dir, paths, state, configFor());
    expect(result.checks.plugin_validation.required).toBe(true);
    // Structural in-process results carry the parsed manifest — a spawned CLI
    // result never could, and would fail outright on a host without `claude`.
    expect(result.checks.plugin_validation.claude.errors).toEqual([]);
    expect(result.checks.plugin_validation.claude.manifest.name).toBe('ape-test');
    expect(result.checks.plugin_validation.codex.errors).toEqual([]);
    expect(result.checks.plugin_validation.passed).toBe(true);
    expect(result.passed).toBe(true);
  });

  it('fails the gate on a structurally invalid Claude manifest', async () => {
    const { dir, paths, treeSha } = await project({ withPluginManifests: true });
    await writeFile(path.join(dir, '.claude-plugin', 'plugin.json'), JSON.stringify({
      name: 'Not Valid Name',
      hooks: './hooks/missing.json',
    }));
    git(dir, 'add', '.');
    git(dir, 'commit', '-qm', 'test: break manifest');
    const brokenTree = await currentTreeSha(dir);
    const state = stateFor(brokenTree, {
      lane: 'mechanical',
      changedFiles: ['src/value.js', '.claude-plugin/plugin.json', '.codex-plugin/plugin.json'],
    });
    const result = await runMergeGates(dir, paths, state, configFor());
    expect(result.checks.plugin_validation.passed).toBe(false);
    expect(result.checks.plugin_validation.claude.errors).toContain('invalid plugin name');
    expect(result.checks.plugin_validation.claude.errors).toContain('hooks path does not exist');
    expect(result.passed).toBe(false);
  });

  it('validates a hooks-only plugin-surface change before launching the full suite', async () => {
    const outside = await mkdtemp(path.join(tmpdir(), 'ape-gate-plugin-order-'));
    cleanups.push(outside);
    const fullMarker = path.join(outside, 'full-ran');
    const fullProbe = path.join(outside, 'full-probe.cjs');
    await writeFile(fullProbe, "require('node:fs').writeFileSync(process.argv[2], 'ran');\n");
    const full = `node "${fullProbe}" "${fullMarker}"`;
    const { dir, paths, treeSha } = await project({
      files: {
        '.claude-plugin/plugin.json': JSON.stringify({
          name: 'ape-test',
          version: '1.0.0',
          description: 'test plugin',
          hooks: './hooks/hooks.json',
        }),
        'hooks/hooks.json': JSON.stringify({ hooks: { NotAnEvent: [] } }),
      },
    });
    const state = stateFor(treeSha, {
      lane: 'mechanical',
      changedFiles: ['hooks/hooks.json'],
    });
    const result = await runMergeGates(dir, paths, state, configFor({
      test_commands: { full },
    }));
    expect(result.checks.plugin_validation).toMatchObject({ required: true, passed: false });
    expect(result.checks.plugin_validation.claude.errors).toContain(
      'hooks manifest ./hooks/hooks.json: unknown hook event NotAnEvent',
    );
    expect(result.checks.full_suite).toMatchObject({ passed: false, skipped: true });
    await expect(readFile(fullMarker, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
  });

  // The gate validates each host only when that host's plugin directory
  // exists: .mcp.json is ordinary host MCP config in a plain project, and a
  // Claude-only plugin repo has no .codex-plugin mirror. Demanding both
  // manifests unconditionally made such runs permanently unshippable (every
  // re-gate re-failed on the same ENOENT).
  describe('presence-conditional per host', () => {
    it('does not treat generic hooks or dist directories as a plugin without a manifest', async () => {
      const { dir, paths, treeSha } = await project({
        files: {
          'hooks/hooks.json': '{not-json',
          'dist/app.js': 'export const app = true;\n',
        },
      });
      const state = stateFor(treeSha, {
        lane: 'mechanical',
        changedFiles: ['hooks/hooks.json', 'dist/app.js'],
      });
      const result = await runMergeGates(dir, paths, state, configFor());
      expect(result.checks.plugin_validation).toEqual({ required: false, passed: true });
      expect(result.passed).toBe(true);
    });

    it('passes with a skipped note when .mcp.json changes in a project with no plugin directories', async () => {
      const { dir, paths, treeSha } = await project({
        files: { '.mcp.json': JSON.stringify({ mcpServers: {} }) },
      });
      const state = stateFor(treeSha, {
        lane: 'mechanical',
        changedFiles: ['src/value.js', '.mcp.json'],
      });
      const result = await runMergeGates(dir, paths, state, configFor());
      expect(result.checks.plugin_validation.required).toBe(true);
      expect(result.checks.plugin_validation.passed).toBe(true);
      expect(result.checks.plugin_validation.claude.skipped).toBe(true);
      expect(result.checks.plugin_validation.codex.skipped).toBe(true);
      // Truthful completion: the pass says it validated nothing.
      expect(result.checks.plugin_validation.note).toMatch(/validation skipped/);
      expect(result.passed).toBe(true);
    });

    it('validates the Claude manifest and skips Codex in a Claude-only plugin repo', async () => {
      const { dir, paths, treeSha } = await project({
        files: {
          '.claude-plugin/plugin.json': JSON.stringify({
            name: 'ape-test',
            version: '1.0.0',
            description: 'test plugin',
          }),
        },
      });
      const state = stateFor(treeSha, {
        lane: 'mechanical',
        changedFiles: ['src/value.js', '.claude-plugin/plugin.json'],
      });
      const result = await runMergeGates(dir, paths, state, configFor());
      expect(result.checks.plugin_validation.claude.errors).toEqual([]);
      expect(result.checks.plugin_validation.claude.manifest.name).toBe('ape-test');
      expect(result.checks.plugin_validation.codex.skipped).toBe(true);
      expect(result.checks.plugin_validation.passed).toBe(true);
      // Something real was validated, so no gate-level skip note.
      expect('note' in result.checks.plugin_validation).toBe(false);
      expect(result.passed).toBe(true);
    });

    it('still fails a Claude-only plugin repo on an invalid Claude manifest', async () => {
      const { dir, paths, treeSha } = await project({
        files: { '.claude-plugin/plugin.json': JSON.stringify({ name: 'Not Valid Name' }) },
      });
      const state = stateFor(treeSha, {
        lane: 'mechanical',
        changedFiles: ['src/value.js', '.claude-plugin/plugin.json'],
      });
      const result = await runMergeGates(dir, paths, state, configFor());
      expect(result.checks.plugin_validation.passed).toBe(false);
      expect(result.checks.plugin_validation.claude.errors).toContain('invalid plugin name');
      expect(result.checks.plugin_validation.codex.skipped).toBe(true);
      expect(result.passed).toBe(false);
    });

    it('fails closed when the manifest is deleted while the plugin directory retains components', async () => {
      const { dir, paths } = await project({ withPluginManifests: true });
      await mkdir(path.join(dir, '.claude-plugin', 'commands'), { recursive: true });
      await writeFile(path.join(dir, '.claude-plugin', 'commands', 'build.md'), '# build\n');
      await rm(path.join(dir, '.claude-plugin', 'plugin.json'));
      git(dir, 'add', '.');
      git(dir, 'commit', '-qm', 'test: delete manifest, keep components');
      const treeSha = await currentTreeSha(dir);
      const state = stateFor(treeSha, {
        lane: 'mechanical',
        changedFiles: ['src/value.js', '.claude-plugin/plugin.json'],
      });
      const result = await runMergeGates(dir, paths, state, configFor());
      // Half-deleted plugin surface: the directory still exists, so the
      // validator runs and reports the missing manifest instead of the
      // absence silently passing.
      expect(result.checks.plugin_validation.passed).toBe(false);
      expect(result.checks.plugin_validation.claude.passed).toBe(false);
      expect(result.checks.plugin_validation.claude.errors[0]).toMatch(/cannot read Claude manifest/);
      expect(result.passed).toBe(false);
    });
  });
});
