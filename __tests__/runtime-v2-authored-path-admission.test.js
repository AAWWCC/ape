import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { seedLegacyRun } from './legacy-run-test-helper.js';
import { recordReceipt } from '../lib/runtime/service.js';
import { runtimePaths } from '../lib/runtime/paths.js';
import { atomicWriteJson } from '../lib/runtime/storage.js';

const directories = [];
afterEach(async () => Promise.all(directories.splice(0).map((dir) =>
  rm(dir, { recursive: true, force: true }))));

// A configured fixture runner verifies path routing independently of installed
// Python/Go toolchains. The authored files carry the runner's red/green marker.
async function project(file, multiRunner, commandOverride) {
  const dir = await mkdtemp(path.join(tmpdir(), 'ape-authored-path-'));
  directories.push(dir);
  await mkdir(path.join(dir, 'src'));
  await mkdir(path.dirname(path.join(dir, file)), { recursive: true });
  await writeFile(path.join(dir, '.gitignore'), '.ape/\n');
  await writeFile(path.join(dir, 'src/value.js'), 'export const value = 1;\n');
  await writeFile(path.join(dir, file), 'baseline\n');
  await writeFile(path.join(dir, 'driver.cjs'), commandOverride
    ? `process.exit(process.argv[2] === '' ? 0 : 9);\n`
    : `const fs = require('node:fs'); process.exit(process.argv.slice(2).every(file => fs.readFileSync(file, 'utf8').includes('PASS')) ? 0 : 1);\n`);
  const git = (...args) => execFileSync('git', args, { cwd: dir, encoding: 'utf8',
    env: { ...process.env, GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null',
      GIT_CONFIG_SYSTEM: process.platform === 'win32' ? 'NUL' : '/dev/null' } });
  git('init', '-q');
  git('config', 'user.email', 'ape@example.test');
  git('config', 'user.name', 'APE Test');
  git('add', '.');
  git('commit', '-qm', 'baseline');
  const profile = { full: `"${process.execPath}" driver.cjs ${file}`,
    targeted_template: commandOverride ?? `"${process.execPath}" driver.cjs {paths}` };
  await atomicWriteJson(runtimePaths(dir).config, {
    shipping: { auto_merge: false, provider: 'github', required_remote_checks: false },
    test_commands: profile,
    ...(multiRunner ? { runners: [{ id: 'configured', owns: [file], root: '.', profile }] } : {}),
  });
  return dir;
}

async function start(dir, file, intent = 'red-first') {
  return seedLegacyRun(dir, { objective: 'Verify scoped configured test execution', mode: 'phase',
    lane: 'fast', host: 'codex', claimed_paths: ['src/value.js'], test_paths: [file],
    behavioral: true, test_intent: intent, requirements: [], risk_triggers: [] });
}

function receipt(ticket, overrides = {}) {
  return { ticket_id: ticket.ticket_id, status: 'passed', agent_identity: `fixture-${ticket.role}`,
    tests: [], findings: [], evidence: { verdict: 'pass' },
    timing: { started_at: ticket.issued_at, duration_ms: 10 }, ...overrides };
}

function observationParts(observation, multiRunner) {
  return multiRunner ? observation.participants : [observation];
}

describe('configured authored test paths reach runtime-owned observation', () => {
  const cases = ['test_value.py', 'value_test.go', 'checks/value.js'].flatMap((file) =>
    [false, true].flatMap((multiRunner) => ['red-first', 'green-maintenance'].map((intent) =>
      ({ file, multiRunner, intent }))));

  it.each(cases)('admits $intent for $file (per-runner=$multiRunner)', async ({ file, multiRunner, intent }) => {
    const dir = await project(file, multiRunner);
    const started = await start(dir, file, intent);
    const ticket = started.run.tickets.at(-1);
    const green = intent === 'green-maintenance';
    expect(ticket.required_checks).toEqual([green ? 'green-test' : 'red-test']);
    await writeFile(path.join(dir, file), green ? 'PASS\n' : 'FAIL\n');
    const admitted = await recordReceipt(dir, receipt(ticket));
    expect(admitted.ok, JSON.stringify(admitted.errors)).toBe(true);
    expect(admitted.receipt.changed_files).toEqual([file]);
    const observed = admitted.receipt.evidence[green ? 'green_test' : 'red_test'];
    expect(observed).toMatchObject({ observed: true, passed: green });
    for (const part of observationParts(observed, multiRunner)) {
      expect(part.test_paths).toEqual([file]);
      expect(part.runs.map((run) => run.exit_code)).toEqual(green ? [0, 0] : [1, 1]);
    }
  });

  it.each([false, true])('observes an independently confirmed configured-path correction (per-runner=%s)', async (multiRunner) => {
    const file = 'checks/value.js';
    const dir = await project(file, multiRunner);
    const started = await start(dir, file);
    await writeFile(path.join(dir, file), 'FAIL\n');
    const authored = await recordReceipt(dir, receipt(started.run.tickets.at(-1)));
    expect(authored.ok, JSON.stringify(authored.errors)).toBe(true);
    const build = authored.run.tickets.at(-1);
    await writeFile(path.join(dir, 'src/value.js'), 'export const value = 2;\n');
    const reported = await recordReceipt(dir, receipt(build, { status: 'failed', evidence: {
      failure_kind: 'test-contradiction', summary: 'The configured fixture expects an inconsistent marker.',
      test_contradiction: { summary: 'The fixture marker contradicts the expected result.', test_paths: [file] },
    } }));
    expect(reported.ok, JSON.stringify(reported.errors)).toBe(true);
    expect(reported.run.tickets.at(-1).stage_id).toBe('test-reconcile');
    const reconciled = await recordReceipt(dir, receipt(reported.run.tickets.at(-1), {
      findings: [{ id: 'fixture.inconsistent-marker', file, line: 1,
        title: 'Incorrect expected marker', detail: 'The fixture must expect the passing marker.',
        blocking: true, remediation: { owner: 'test', test_paths: [file] } }], evidence: { verdict: 'fail' },
    }));
    expect(reconciled.ok, JSON.stringify(reconciled.errors)).toBe(true);
    const recheck = reconciled.run.tickets.at(-1);
    expect(recheck).toMatchObject({ stage_id: 'test-recheck', required_checks: ['test-correction'], test_paths: [file] });
    await writeFile(path.join(dir, file), 'PASS\n');
    const corrected = await recordReceipt(dir, receipt(recheck));
    expect(corrected.ok, JSON.stringify(corrected.errors)).toBe(true);
    for (const part of observationParts(corrected.receipt.evidence.test_correction, multiRunner)) {
      expect(part.test_paths).toEqual([file]);
      expect(part.runs.map((run) => run.exit_code)).toEqual([0, 0]);
    }
    expect(corrected.run.tickets.at(-1)).toMatchObject({ stage_id: 'build', attempt: 2 });
  });

  it('refuses false red evidence when a configured empty argument makes the actual command pass', async () => {
    const file = 'checks/value.test.js';
    const dir = await project(file, false, `"${process.execPath}" driver.cjs "" {paths}`);
    const started = await start(dir, file);
    await writeFile(path.join(dir, file), 'authored fixture\n');
    const rejected = await recordReceipt(dir, receipt(started.run.tickets.at(-1)));
    expect(rejected).toMatchObject({ ok: false, rejected: true });
    expect(rejected.errors.join(' ')).toMatch(/red phase was not observed/);
  });
});
