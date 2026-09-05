import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { seedLegacyRun } from './legacy-run-test-helper.js';
import { projectedPipeline } from '../lib/runtime/pipeline.js';
import { runtimePaths } from '../lib/runtime/paths.js';
import { recordReceipt } from '../lib/runtime/service.js';
import { atomicWriteJson, readJson } from '../lib/runtime/storage.js';

const cleanups = [];
afterEach(async () => Promise.all(cleanups.splice(0).map((dir) =>
  rm(dir, { recursive: true, force: true }))));

const FAULTY_TEST = [
  "import assert from 'node:assert/strict';",
  "import { value } from '../src/value.js';",
  'assert.equal(value, 2);',
  "assert.equal(['first', 'second'].length, 1);",
  '',
].join('\n');
const CORRECTED_TEST = FAULTY_TEST.replace('.length, 1)', '.length, 2)');

function receipt(ticket, overrides = {}) {
  return {
    ticket_id: ticket.ticket_id,
    status: 'passed',
    agent_identity: `fixture-${ticket.role}`,
    tests: [],
    findings: [],
    evidence: { verdict: 'pass' },
    timing: { started_at: ticket.issued_at, duration_ms: 10 },
    ...overrides,
  };
}

async function write(dir, file, content) {
  await writeFile(path.join(dir, file), content);
}

async function project({ multiRunner = false } = {}) {
  const dir = await mkdtemp(path.join(tmpdir(), 'ape-post-build-recheck-'));
  cleanups.push(dir);
  await mkdir(path.join(dir, 'src'));
  await mkdir(path.join(dir, 'tests'));
  await write(dir, 'package.json', '{"type":"module"}\n');
  await write(dir, '.gitignore', '.ape/\n');
  await write(dir, 'src/value.js', 'export const value = 1;\n');
  await write(dir, 'tests/sibling.test.js', 'export {};\n');
  const git = (...args) => execFileSync('git', args, {
    cwd: dir,
    encoding: 'utf8',
    env: {
      ...process.env,
      GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null',
      GIT_CONFIG_SYSTEM: process.platform === 'win32' ? 'NUL' : '/dev/null',
    },
  });
  git('init', '-q');
  git('config', 'user.email', 'ape@example.test');
  git('config', 'user.name', 'APE Test');
  git('add', '.');
  git('commit', '-qm', 'baseline');
  await atomicWriteJson(runtimePaths(dir).config, {
    shipping: { auto_merge: false, provider: 'github', required_remote_checks: false },
    test_commands: { full: 'node --test', targeted_template: 'node --test {paths}' },
    ...(multiRunner ? {
      runners: ['value', 'sibling'].map((id) => ({
        id,
        owns: [`tests/${id}.test.js`],
        root: '.',
        profile: { targeted_template: 'node --test {paths}' },
      })),
    } : {}),
  });
  return dir;
}

async function confirmedCorrection({ multiRunner = false } = {}) {
  const dir = await project({ multiRunner });
  // Seed historical state without a native worker. Ticket issuance, runtime
  // test execution, independent reconciliation and admission are production code.
  const started = await seedLegacyRun(dir, {
    objective: 'Change the exported value while preserving coherent test fixtures',
    mode: 'phase',
    lane: 'fast',
    host: 'codex',
    behavioral: true,
    test_intent: 'red-first',
    claimed_paths: ['src/value.js'],
    test_paths: ['tests/value.test.js', 'tests/sibling.test.js'],
    requirements: [],
    risk_triggers: [],
  });
  const test = started.run.tickets.at(-1);
  expect(test.required_checks).toEqual(['red-test']);
  await write(dir, 'tests/value.test.js', FAULTY_TEST);
  if (multiRunner) await write(dir, 'tests/sibling.test.js', FAULTY_TEST);
  const authored = await recordReceipt(dir, receipt(test));
  expect(authored.ok, JSON.stringify(authored.errors)).toBe(true);
  const redObservations = multiRunner
    ? authored.receipt.evidence.red_test.participants
    : [authored.receipt.evidence.red_test];
  for (const observation of redObservations) {
    expect(observation.runs.map((run) => run.exit_code)).toEqual([1, 1]);
  }

  const build = authored.run.tickets.at(-1);
  await write(dir, 'src/value.js', 'export const value = 2;\n');
  const reported = await recordReceipt(dir, receipt(build, {
    status: 'failed',
    evidence: {
      failure_kind: 'test-contradiction',
      summary: 'The fixture expects a two-element list to have length one.',
      test_contradiction: {
        summary: 'The fixture expects a two-element list to have length one.',
        test_paths: ['tests/value.test.js', 'tests/sibling.test.js'],
      },
    },
  }));
  expect(reported.ok, JSON.stringify(reported.errors)).toBe(true);
  expect(reported.run.tickets.at(-1).stage_id).toBe('test-reconcile');
  const confirmedPaths = multiRunner
    ? ['tests/value.test.js', 'tests/sibling.test.js']
    : ['tests/value.test.js'];
  const reconciled = await recordReceipt(dir, receipt(reported.run.tickets.at(-1), {
    findings: confirmedPaths.map((file, index) => ({
      id: `fixture.list-length-${index}`,
      file,
      line: 4,
      title: 'Incorrect list length in the fixture',
      detail: 'The literal contains two elements, so the fixture must expect length two.',
      blocking: true,
      remediation: { owner: 'test', test_paths: [file] },
    })),
    evidence: { verdict: 'fail' },
  }));
  expect(reconciled.ok, JSON.stringify(reconciled.errors)).toBe(true);
  const recheck = reconciled.run.tickets.at(-1);
  expect(recheck).toMatchObject({
    stage_id: 'test-recheck',
    role: 'test_writer',
    required_checks: ['test-correction'],
    test_intent: 'red-first',
    test_scope: 'exact',
  });
  expect(recheck.test_paths.toSorted()).toEqual(confirmedPaths.toSorted());
  expect(recheck.claimed_paths.toSorted()).toEqual(confirmedPaths.toSorted());
  return { dir, authored, build, recheck };
}

describe('post-build test correction uses runtime-observed evidence', () => {
  it.each(['fast', 'full'])('projects the correction check while preserving initial red-first in %s', (lane) => {
    const projection = projectedPipeline({
      mode: 'phase', lane, behavioral: true, test_intent: 'red-first',
      claimed_paths: ['src/value.js'], test_paths: ['tests/value.test.js'],
    });
    expect(projection.stages.find((entry) => entry.id === 'test').required_checks)
      .toEqual(['red-test']);
    expect(projection.stages.find((entry) => entry.id === 'test-recheck').required_checks)
      .toEqual(['test-correction']);
    expect(projection.runtime_stages).toContainEqual(expect.objectContaining({
      id: 'runtime:observe-test-correction:test-recheck', action: 'observe_test_correction',
    }));
  });

  it('admits a coherent green correction and resumes the original build without replacing red evidence', async () => {
    const { dir, authored, build, recheck } = await confirmedCorrection();
    await write(dir, 'tests/value.test.js', CORRECTED_TEST);
    const corrected = await recordReceipt(dir, receipt(recheck, {
      evidence: { verdict: 'pass', test_correction: { observed: true, command: 'worker-claim' } },
    }));
    expect(corrected.ok, JSON.stringify(corrected.errors)).toBe(true);
    const observation = corrected.receipt.evidence.test_correction;
    expect(observation).toMatchObject({
      observed: true, passed: true, test_paths: ['tests/value.test.js'],
      tree_sha: corrected.receipt.head_tree_sha,
    });
    expect(observation.command).not.toBe('worker-claim');
    expect(observation.runs.map((run) => run.exit_code)).toEqual([0, 0]);
    expect(corrected.run.receipts.find((entry) => entry.receipt_id === authored.receipt.receipt_id))
      .toEqual(authored.receipt);
    expect(corrected.run.tickets.at(-1)).toMatchObject({
      stage_id: 'build', role: 'implementer', attempt: 2,
      test_reconciliation: { source_ticket_id: build.ticket_id },
    });
    expect(corrected.run).toMatchObject({
      test_contradiction_reconciliations: 1,
      test_contradiction_pending: null,
      test_contradiction_resolution: { verdict: 'test-corrected' },
    });
  });

  it('admits a stable red correction for the resumed implementer without claiming green', async () => {
    const { dir, recheck } = await confirmedCorrection();
    await write(dir, 'tests/value.test.js', CORRECTED_TEST.replace('value, 2)', 'value, 3)'));
    const corrected = await recordReceipt(dir, receipt(recheck, {
      evidence: { verdict: 'pass', test_correction: { observed: true, passed: true } },
    }));
    expect(corrected.ok, JSON.stringify(corrected.errors)).toBe(true);
    expect(corrected.receipt.evidence.test_correction).toMatchObject({ observed: true, passed: false });
    expect(corrected.receipt.evidence.test_correction.runs.map((run) => run.exit_code))
      .toEqual([1, 1]);
    expect(corrected.run.tickets.at(-1)).toMatchObject({
      stage_id: 'build', role: 'implementer', attempt: 2, required_checks: ['targeted-tests'],
    });
    expect(corrected.run.status).toBe('running');
  });

  it.each([false, true])('refuses a correction that passes once and fails once (per-runner=%s)', async (multiRunner) => {
    const { dir, recheck } = await confirmedCorrection({ multiRunner });
    const outside = await mkdtemp(path.join(tmpdir(), 'ape-recheck-flake-'));
    cleanups.push(outside);
    const marker = path.join(outside, 'first-execution');
    await write(dir, 'tests/value.test.js', [
      CORRECTED_TEST,
      "import { existsSync, writeFileSync } from 'node:fs';",
      `const marker = ${JSON.stringify(marker)};`,
      "assert.equal(existsSync(marker), false, 'unstable fixture');",
      "writeFileSync(marker, 'executed');",
      '',
    ].join('\n'));
    if (multiRunner) await write(dir, 'tests/sibling.test.js', CORRECTED_TEST);
    const before = await readJson(runtimePaths(dir).active);
    const rejected = await recordReceipt(dir, receipt(recheck));
    expect(rejected).toMatchObject({ ok: false, rejected: true });
    expect(rejected.errors.join(' ')).toMatch(/nondeterministic/);
    expect(await readJson(runtimePaths(dir).active)).toEqual(before);
  });

  it('records mixed stable runner verdicts without misreporting the correction as green', async () => {
    const { dir, recheck } = await confirmedCorrection({ multiRunner: true });
    await write(dir, 'tests/value.test.js', CORRECTED_TEST);
    await write(dir, 'tests/sibling.test.js', CORRECTED_TEST.replace('value, 2)', 'value, 3)'));
    const corrected = await recordReceipt(dir, receipt(recheck));
    expect(corrected.ok, JSON.stringify(corrected.errors)).toBe(true);
    const observation = corrected.receipt.evidence.test_correction;
    expect(observation).toMatchObject({
      observed: true, passed: false, tree_sha: corrected.receipt.head_tree_sha,
    });
    expect(observation.participants).toHaveLength(2);
    expect(observation.participants.find((entry) => entry.id === 'value').runs
      .map((run) => run.exit_code)).toEqual([0, 0]);
    expect(observation.participants.find((entry) => entry.id === 'sibling').runs
      .map((run) => run.exit_code)).toEqual([1, 1]);
    expect(corrected.run.tickets.at(-1)).toMatchObject({
      stage_id: 'build', role: 'implementer', attempt: 2,
    });
  });

  it.each(['src/value.js', 'tests/sibling.test.js'])('refuses correction writes outside independently confirmed scope: %s', async (file) => {
    const { dir, recheck } = await confirmedCorrection();
    await write(dir, 'tests/value.test.js', CORRECTED_TEST);
    await write(dir, file, 'export const unrelated = true;\n');
    const before = await readJson(runtimePaths(dir).active);
    const rejected = await recordReceipt(dir, receipt(recheck));
    expect(rejected).toMatchObject({ ok: false, rejected: true });
    expect(rejected.errors.join(' ')).toContain(`unclaimed write: ${file}`);
    expect(await readJson(runtimePaths(dir).active)).toEqual(before);
  });
});
