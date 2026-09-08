import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { runMergeGates } from '../lib/runtime/gates.js';
import { startGateSuite, pollGateSuite } from '../lib/runtime/gate-watch.js';
import { evaluateGates } from '../lib/runtime/gate-evaluation.js';
import { currentTreeSha, diffFiles } from '../lib/runtime/git.js';
import { sha256 } from '../lib/runtime/canonical.js';

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


async function detachedGate(project, paths, state, config) {
  const start = await startGateSuite(project, paths, state, config);
  let ready = start.hit;
  if (start.watch) {
    state.gates_watch = start.watch;
    for (let attempt = 0; attempt < 200 && !ready; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 20));
      const result = await pollGateSuite(project, paths, state, config);
      if (result.failed) throw new Error(result.failed);
      if (result.ready) ready = result.ready;
      if (result.pending?.watch) Object.assign(state.gates_watch, result.pending.watch);
    }
  }
  expect(ready).toBeTruthy();
  const verdict = await evaluateGates(project, paths, state, config, {
    ...ready.ctx, full: ready.full, cached: ready.cached,
  });
  delete state.gates_watch;
  return verdict;
}

describe('detached gate runner coverage and cache identity', () => {
  it.skipIf(process.platform === 'win32').each([true, false])('detects the full runner at its own root (root runner present: %s)', async (rootRunner) => {
    const { project, paths } = await harness();
    await mkdir(path.join(project, 'child/script'), {recursive:true});
    const childScript = path.join(project, 'child/script/test');
    await writeFile(childScript, '#!/bin/sh\nexit 1\n'); await chmod(childScript, 0o755);
    if (rootRunner) {
      await mkdir(path.join(project, 'script'));
      const rootScript=path.join(project,'script/test');
      await writeFile(rootScript,'#!/bin/sh\nexit 0\n'); await chmod(rootScript,0o755);
    }
    git(project,'add','.'); git(project,'commit','-qm','distinct root and child suites');
    const treeSha=await currentTreeSha(project);
    const state=stateFor(treeSha); state.receipts[0].changed_files=['child/script/test'];
    const config={deadlines_ms:{mechanical:5000},runners:[{id:'child',root:'child',owns:['child/**'],profile:{full:null}}]};
    const oldKey=`${treeSha}:${sha256({runner:'child',root:path.resolve(project,'child'),command:null})}`;
    await writeFile(path.join(paths.runtime,'suite-cache.json'),JSON.stringify({results:{[oldKey]:{passed:true,result_hash:'wrong-root-old-pass'}}}));
    const result=await detachedGate(project,paths,state,config);
    expect(result.passed).toBe(false);
    expect(result.checks.full_suite.runners).toEqual([expect.objectContaining({id:'child',passed:false,cached:false})]);
    const cache=JSON.parse(await readFile(path.join(paths.runtime,'suite-cache.json'),'utf8'));
    const newResult=Object.entries(cache.results).find(([key])=>key!==oldKey)?.[1];
    expect(newResult.verification.exit_code).toBe(1);
    expect(newResult.verification.tooling_failure).toBe(false);
  });

  it('runs impacted operands relative to the runner root and discards old operand cache entries', async () => {
    const { project, paths } = await harness();
    await mkdir(path.join(project, 'web/tests'), { recursive: true });
    const file = 'web/tests/example space.test.mjs';
    await writeFile(path.join(project, file), "import { test } from 'node:test'; test('passes', () => {});\n");
    git(project, 'add', 'web'); git(project, 'commit', '-qm', 'subdirectory test');
    const treeSha = await currentTreeSha(project);
    const state = stateFor(treeSha);
    state.receipts[0].changed_files = [file];
    const template = 'node --test {paths}';
    const config = { deadlines_ms: { mechanical: 5000 }, shipping: { required_remote_checks: true }, runners: [{
      id: 'web', root: 'web', owns: ['web/**'], profile: { full: 'node --test "tests/example space.test.mjs"', impacted_template: template },
    }] };
    // Old keys attest repository-relative operands executed from this root.
    // They must not answer the corrected invocation, even at the same tree.
    const oldKey = `${treeSha}:${sha256({ runner: 'web', root: path.resolve(project, 'web'), mode: 'impacted', template, paths: [file] })}`;
    await writeFile(path.join(paths.runtime, 'suite-cache.json'), JSON.stringify({
      schema_version: '2.0.0', results: { [oldKey]: { passed: true, result_hash: 'old-operands' } },
    }));
    const first = await detachedGate(project, paths, state, config);
    expect(first.passed).toBe(true);
    expect(first.checks.full_suite.runners).toEqual([
      expect.objectContaining({ id: 'web', passed: true, cached: false, mode: 'impacted', command: 'node --test tests/example space.test.mjs' }),
    ]);
    expect((await detachedGate(project, paths, state, config)).checks.full_suite.runners[0].cached).toBe(true);
    const full = await detachedGate(project, paths, { ...state, regate_attempts: 1 }, config);
    expect(full.passed).toBe(true);
    expect(full.checks.full_suite.runners[0]).toMatchObject({ cached: false, mode: 'full' });
  });

  it.each(['full', 'impacted'])('does not reuse a %s pass after changing runner root', async (mode) => {
    const { project, paths } = await harness();
    for (const name of ['a', 'b']) {
      await mkdir(path.join(project, name));
      await writeFile(path.join(project, name, 'check.cjs'), `process.exit(${name === 'a' ? 0 : 1});`);
    }
    git(project, 'add', 'a', 'b'); git(project, 'commit', '-qm', 'two runner roots');
    const state = stateFor(await currentTreeSha(project));
    const config = (root) => ({ deadlines_ms: { mechanical: 5000 }, runners: [{
      id: 'unit', root, owns: ['**'], profile: {
        full: 'node check.cjs',
        ...(mode === 'impacted' ? { impacted_template: 'node check.cjs {paths}' } : {}),
      },
    }] });
    expect((await detachedGate(project, paths, state, config('a'))).passed).toBe(true);
    const changed = await detachedGate(project, paths, state, config('b'));
    expect(changed.passed).toBe(false);
    expect(changed.checks.full_suite.runners[0]).toMatchObject({ passed: false, cached: false, mode });
  });

  it('runs the suite owning a tracked deletion alongside the suite owning a present edit', async () => {
    const { project, paths } = await harness();
    for (const name of ['a', 'b']) await mkdir(path.join(project, name));
    await writeFile(path.join(project, 'a/value.cjs'), 'module.exports=42;');
    await writeFile(path.join(project, 'a/check.cjs'), "require('./value.cjs');");
    await writeFile(path.join(project, 'b/check.cjs'), 'process.exit(0);');
    git(project, 'add', 'a', 'b'); git(project, 'commit', '-qm', 'two passing suites');
    const before = await currentTreeSha(project);
    await rm(path.join(project, 'a/value.cjs'));
    await writeFile(path.join(project, 'b/check.cjs'), '// unrelated edit\nprocess.exit(0);');
    const after = await currentTreeSha(project);
    const state = stateFor(after);
    state.receipts[0].changed_files = await diffFiles(project, before, after);
    const config = { deadlines_ms: { mechanical: 5000 }, runners: ['a', 'b'].map((id) => ({
      id, root: id, owns: [id + '/**'], profile: { full: 'node check.cjs', impacted_template: 'node check.cjs {paths}' },
    })) };
    const result = await detachedGate(project, paths, state, config);
    expect(result.passed).toBe(false);
    expect(result.checks.full_suite.runners).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'a', passed: false, mode: 'full' }),
      expect.objectContaining({ id: 'b', passed: true }),
    ]));
  });
});

describe('inline multi-runner gate parity', () => {
  it.each(['full', 'impacted'])('requires every configured %s runner and only reuses passing results', async (mode) => {
    const { project, paths } = await harness();
    for (const id of ['a', 'b']) {
      await mkdir(path.join(project, id));
      await writeFile(path.join(project, id, 'check.cjs'), `process.exit(${id === 'a' ? 0 : 1});\n`);
    }
    git(project, 'add', 'a', 'b'); git(project, 'commit', '-qm', 'mixed runner verdicts');
    const state = stateFor(await currentTreeSha(project));
    state.receipts[0].changed_files = ['a/check.cjs', 'b/check.cjs'];
    const config = { deadlines_ms: { mechanical: 5000 }, shipping: { required_remote_checks: true }, runners: ['a', 'b'].map((id) => ({
      id, root: id, owns: [`${id}/**`], profile: { full: 'node check.cjs', ...(mode === 'impacted' ? { impacted_template: 'node {paths}' } : {}) },
    })) };
    const first = await runMergeGates(project, paths, state, config);
    expect(first.passed).toBe(false);
    expect(first.checks.full_suite.runners).toEqual([
      expect.objectContaining({ id: 'a', mode, passed: true, cached: false }),
      expect.objectContaining({ id: 'b', mode, passed: false, cached: false }),
    ]);
    const second = await runMergeGates(project, paths, state, config);
    expect(second.passed).toBe(false);
    expect(second.checks.full_suite.runners).toEqual([
      expect.objectContaining({ id: 'a', mode, passed: true, cached: true }),
      expect.objectContaining({ id: 'b', mode, passed: false, cached: false }),
    ]);
  });
});
