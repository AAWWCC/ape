import { execFileSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { configAction } from '../lib/runtime/service.js';
import { loadRuntimeConfig } from '../lib/runtime/config.js';
import { currentTreeSha } from '../lib/runtime/git.js';
import { runMergeGates } from '../lib/runtime/gate-evaluation.js';
import { runtimePaths } from '../lib/runtime/paths.js';

const directories = [];
afterEach(async () => Promise.all(directories.splice(0).map((directory) =>
  rm(directory, { recursive: true, force: true }))));

async function bootstrap(passed = true) {
  const root = await mkdtemp(path.join(tmpdir(), 'ape-bootstrap-gates-'));
  directories.push(root);
  const git = (...args) => execFileSync('git', args, { cwd: root, stdio: 'pipe' });
  git('init', '-b', 'main');
  git('config', 'user.email', 'ape@example.test');
  git('config', 'user.name', 'APE Test');
  const testPath = 'value with spaces.test.mjs';
  const initialized = await configAction(root, 'init', {
    behavioral: true, test_paths: [testPath],
  });
  expect(initialized.init.proposal.proposal_complete).toBe(true);
  await configAction(root, 'init', { behavioral: true, test_paths: [testPath], apply: true });
  const paths = runtimePaths(root);
  const config = await loadRuntimeConfig(paths.config);
  expect(config.test_commands.targeted).toBeNull();
  await writeFile(path.join(root, testPath),
    `import { test } from 'node:test'; test('behavior', () => { ${passed ? '' : "throw new Error('broken');"} });\n`);
  git('add', testPath);
  git('commit', '-m', 'Bootstrap test fixture');
  const treeSha = await currentTreeSha(root);
  const state = {
    lane: 'fast', test_paths: [testPath],
    receipts: [{
      receipt_hash: 'a', previous_receipt_hash: null, status: 'passed',
      agent: { role: 'test_writer' }, tests: [],
      changed_files: [testPath], head_tree_sha: treeSha,
    }],
  };
  return { root, paths, config, state, testPath };
}

describe('blank repository onboarding through final verification', () => {
  it.each([true, false])('executes the installed targeted template and respects its verdict (%s)', async (passed) => {
    const fixture = await bootstrap(passed);
    const result = await runMergeGates(fixture.root, fixture.paths, fixture.state, fixture.config);
    expect(result.passed).toBe(passed);
    expect(result.checks.targeted_tests).toMatchObject({
      verified: true, passed, test_paths: [fixture.testPath],
    });
    expect(result.checks.full_suite.passed).toBe(passed);
    if (!passed) expect(result.checks.full_suite.skipped).toBe(true);
  });

  it.each(['fast', 'mechanical'])('preserves explicit static gate authority when both forms are configured (%s)', async (lane) => {
    const fixture = await bootstrap();
    fixture.state.lane = lane;
    fixture.config.test_commands.targeted = 'node --definitely-invalid-option';
    const result = await runMergeGates(fixture.root, fixture.paths, fixture.state, fixture.config);
    expect(result.passed).toBe(false);
    expect(result.checks.targeted_tests).toMatchObject({
      verified: true, passed: false, command: fixture.config.test_commands.targeted,
    });
    expect(result.checks.full_suite.skipped).toBe(true);
  });

  it.each([false, true])('keeps template-only mechanical work on its full suite (test candidates: %s)', async (hasCandidates) => {
    const fixture = await bootstrap();
    fixture.state.lane = 'mechanical';
    fixture.config.test_commands.targeted_template = 'node --definitely-invalid-option {paths}';
    if (!hasCandidates) {
      fixture.state.test_paths = [];
      fixture.state.receipts[0].changed_files = [];
    }
    const result = await runMergeGates(fixture.root, fixture.paths, fixture.state, fixture.config);
    expect(result.passed).toBe(true);
    expect(result.checks.targeted_tests).toMatchObject({ passed: true, verified: false });
    expect(result.checks.full_suite.passed).toBe(true);
  });

  it.each(['node --test', 'node "unterminated {paths}'])('fails closed on an unusable template: %s', async (template) => {
    const fixture = await bootstrap();
    fixture.config.test_commands.targeted_template = template;
    const result = await runMergeGates(fixture.root, fixture.paths, fixture.state, fixture.config);
    expect(result.passed).toBe(false);
    expect(result.checks.targeted_tests).toMatchObject({ passed: false, verified: false });
    expect(result.checks.targeted_tests.reason).toMatch(/targeted_template/);
    expect(result.checks.full_suite.skipped).toBe(true);
  });
});
