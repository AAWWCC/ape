import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { runMergeGates } from '../lib/runtime/gates.js';
import { currentTreeSha } from '../lib/runtime/git.js';

const cleanups = [];
afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

function git(cwd, ...args) {
  execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' },
  });
}

// The probe suite lives OUTSIDE the project so executions never perturb the
// project tree SHA: it appends one byte to a counter file per execution and
// exits 0 only once a marker file exists.
async function harness() {
  const project = await mkdtemp(path.join(tmpdir(), 'ape-gates-project-'));
  const outside = await mkdtemp(path.join(tmpdir(), 'ape-gates-probe-'));
  cleanups.push(project, outside);
  await mkdir(path.join(project, 'src'));
  await writeFile(path.join(project, 'src', 'value.js'), 'export const value = 1;\n');
  git(project, 'init', '-q');
  git(project, 'config', 'user.email', 'ape@example.test');
  git(project, 'config', 'user.name', 'APE Test');
  git(project, 'add', '.');
  git(project, 'commit', '-qm', 'test: baseline');

  const runtime = path.join(project, '.ape', 'runtime');
  await mkdir(runtime, { recursive: true });

  const probe = path.join(outside, 'probe.cjs');
  await writeFile(probe, [
    "const fs = require('node:fs');",
    'const [counter, marker] = process.argv.slice(2);',
    "fs.appendFileSync(counter, 'x');",
    'process.exit(fs.existsSync(marker) ? 0 : 1);',
  ].join('\n'));

  const suite = (name) => {
    const counter = path.join(outside, `${name}.counter`);
    const marker = path.join(outside, `${name}.marker`);
    return {
      command: `node "${probe}" "${counter}" "${marker}"`,
      arm: () => writeFile(marker, 'pass\n'),
      executions: async () => {
        try {
          return (await readFile(counter, 'utf8')).length;
        } catch {
          return 0;
        }
      },
    };
  };

  return { project, paths: { runtime }, suite };
}

// Mechanical lane: these suites exercise full-suite caching and tree binding
// in a project with no detectable test runner; a behavioral lane would fail
// the derived targeted_tests gate (F12), which has its own coverage in
// runtime-v2-gates-verification.test.js.
function stateFor(headTreeSha) {
  return {
    run_id: 'run-1',
    lane: 'mechanical',
    high_risk: false,
    receipts: [{
      receipt_hash: 'a',
      previous_receipt_hash: null,
      status: 'passed',
      agent: { role: 'implementer' },
      tests: [{ passed: true }],
      changed_files: ['src/value.js'],
      head_tree_sha: headTreeSha,
    }],
  };
}

describe('runMergeGates suite cache (F19)', () => {
  it('re-executes instead of serving a cached failure', async () => {
    const { project, paths, suite } = await harness();
    const full = suite('full');
    const config = { test_commands: { full: full.command } };
    const state = stateFor(await currentTreeSha(project));

    const first = await runMergeGates(project, paths, state, config);
    expect(first.checks.full_suite.passed).toBe(false);
    expect(first.checks.full_suite.cached).toBe(false);
    expect(await full.executions()).toBe(1);

    await full.arm();
    const second = await runMergeGates(project, paths, state, config);
    expect(await full.executions()).toBe(2); // old cache served the failure without executing
    expect(second.checks.full_suite.passed).toBe(true);
    expect(second.checks.full_suite.cached).toBe(false);
  });

  it('keys the cache on the resolved command and reports cached provenance truthfully', async () => {
    const { project, paths, suite } = await harness();
    const suiteA = suite('a');
    const suiteB = suite('b');
    await suiteA.arm();
    await suiteB.arm();
    const state = stateFor(await currentTreeSha(project));

    const freshA = await runMergeGates(project, paths, state, { test_commands: { full: suiteA.command } });
    expect(freshA.checks.full_suite.passed).toBe(true);
    expect(freshA.checks.full_suite.cached).toBe(false); // old code always claimed a hit
    expect(await suiteA.executions()).toBe(1);

    // Same tree, different command: must execute the new command, not reuse A's result.
    const freshB = await runMergeGates(project, paths, state, { test_commands: { full: suiteB.command } });
    expect(freshB.checks.full_suite.cached).toBe(false);
    expect(await suiteB.executions()).toBe(1);

    const hitA = await runMergeGates(project, paths, state, { test_commands: { full: suiteA.command } });
    expect(hitA.checks.full_suite.passed).toBe(true);
    expect(hitA.checks.full_suite.cached).toBe(true);
    expect(await suiteA.executions()).toBe(1);
  });
});

describe('runMergeGates tree binding (F4)', () => {
  it('passes when the merge-time tree matches the last attested receipt tree', async () => {
    const { project, paths, suite } = await harness();
    const full = suite('full');
    await full.arm();
    await writeFile(path.join(project, 'src', 'value.js'), 'export const value = 2;\n');
    const state = stateFor(await currentTreeSha(project));

    const gates = await runMergeGates(project, paths, state, { test_commands: { full: full.command } });
    expect(gates.checks.tree_binding.passed).toBe(true);
    expect(gates.passed).toBe(true);
  });

  it('fails when a claimed file is tampered with after the final receipt', async () => {
    const { project, paths, suite } = await harness();
    const full = suite('full');
    await full.arm();
    await writeFile(path.join(project, 'src', 'value.js'), 'export const value = 2;\n');
    const attested = await currentTreeSha(project);
    const state = stateFor(attested);

    // Post-receipt tampering inside an already-claimed path: clean_tree cannot
    // see it (the path is attributed), only the tree binding can.
    await writeFile(path.join(project, 'src', 'value.js'), 'export const value = 666;\n');

    const gates = await runMergeGates(project, paths, state, { test_commands: { full: full.command } });
    expect(gates.checks.clean_tree.passed).toBe(true);
    expect(gates.checks.tree_binding.passed).toBe(false);
    expect(gates.checks.tree_binding.attested_tree_sha).toBe(attested);
    expect(gates.checks.tree_binding.merge_tree_sha).not.toBe(attested);
    expect(gates.passed).toBe(false);
  });

  it('fails when a gate command mutates an already-attributed path mid-gate', async () => {
    const { project, paths } = await harness();
    const state = stateFor(await currentTreeSha(project));

    // The "suite" itself tampers with the claimed file and exits 0: the tree
    // sampled at gate entry (and attested by the receipt) no longer describes
    // the bytes present once the gate commands finish. Only a post-command
    // recompute can see this (F4).
    const mutator = 'node -e "require(\'node:fs\').writeFileSync(\'src/value.js\', \'export const value = 666;\\n\')"';
    const gates = await runMergeGates(project, paths, state, { test_commands: { full: mutator } });
    expect(gates.checks.full_suite.passed).toBe(true);
    expect(gates.checks.clean_tree.passed).toBe(true);
    expect(gates.checks.tree_binding.passed).toBe(false);
    expect(gates.checks.tree_binding.post_gate_tree_sha).not.toBe(gates.checks.tree_binding.attested_tree_sha);
    expect(gates.checks.tree_binding.merge_tree_sha).toBe(gates.checks.tree_binding.attested_tree_sha);
    expect(gates.passed).toBe(false);
  });

  it('never caches a full-suite pass whose execution mutated the tree', async () => {
    const { project, paths } = await harness();
    const outside = await mkdtemp(path.join(tmpdir(), 'ape-gates-poison-'));
    cleanups.push(outside);
    const counter = path.join(outside, 'runs.counter');
    // Mutating "suite": records the execution, tampers with the attributed
    // file, exits 0. Its pass is evidence about mutated bytes, not about the
    // entry tree the cache key names.
    const script = path.join(outside, 'mutate.cjs');
    await writeFile(script, [
      "const fs = require('node:fs');",
      "fs.appendFileSync(process.argv[2], 'x');",
      "fs.writeFileSync('src/value.js', 'export const value = 666;\\n');",
    ].join('\n'));
    const config = { test_commands: { full: `node "${script}" "${counter}"` } };
    const state = stateFor(await currentTreeSha(project));

    const first = await runMergeGates(project, paths, state, config);
    expect(first.checks.full_suite.passed).toBe(true);
    expect(first.checks.tree_binding.passed).toBe(false);
    expect(first.passed).toBe(false);
    expect((await readFile(counter, 'utf8')).length).toBe(1);

    // Restore the tree and re-evaluate the exact same tree+command: the
    // poisoned pass must not have been persisted, so the suite re-executes
    // instead of shipping cached evidence produced against mutated bytes.
    await writeFile(path.join(project, 'src', 'value.js'), 'export const value = 1;\n');
    const second = await runMergeGates(project, paths, state, config);
    expect(second.checks.full_suite.cached).toBe(false);
    expect((await readFile(counter, 'utf8')).length).toBe(2);
  });

  it('fails when the run has no receipts to bind to', async () => {
    const { project, paths, suite } = await harness();
    const full = suite('full');
    await full.arm();
    const state = { run_id: 'run-1', lane: 'mechanical', high_risk: false, receipts: [] };

    const gates = await runMergeGates(project, paths, state, { test_commands: { full: full.command } });
    expect(gates.checks.tree_binding.passed).toBe(false);
    expect(gates.checks.tree_binding.attested_tree_sha).toBe(null);
    expect(gates.passed).toBe(false);
  });
});
