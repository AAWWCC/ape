import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { classifyLane } from '../lib/runtime/lane-policy.js';
import { initialStages, nextStages, projectedPipeline } from '../lib/runtime/pipeline.js';
import { recordReceipt, startRun } from '../lib/runtime/service.js';
import { runtimePaths } from '../lib/runtime/paths.js';
import { RunStartInputSchema } from '../lib/runtime/schemas.js';
import { atomicWriteJson } from '../lib/runtime/storage.js';

const cleanups = [];
afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((entry) => rm(entry, { recursive: true, force: true })));
});

function git(cwd, ...args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

async function project(config = {}) {
  const dir = await mkdtemp(path.join(tmpdir(), 'ape-green-maintenance-'));
  cleanups.push(dir);
  await mkdir(path.join(dir, 'tests'));
  await writeFile(path.join(dir, 'tests', 'value.test.js'), '// incoming test placeholder\n');
  git(dir, 'init', '-q');
  git(dir, 'config', 'user.email', 'ape@example.test');
  git(dir, 'config', 'user.name', 'APE Test');
  git(dir, 'add', '.');
  git(dir, 'commit', '-qm', 'baseline');
  await atomicWriteJson(runtimePaths(dir).config, {
    shipping: { auto_merge: false, provider: 'github', required_remote_checks: false },
    test_commands: { full: 'node --test', targeted_template: 'node --test {paths}' },
    ...config,
  });
  return dir;
}

function startInput(overrides = {}) {
  return {
    objective: 'Add stable coverage for behavior that already works',
    mode: 'phase',
    lane: 'auto',
    host: 'codex',
    claimed_paths: [],
    test_paths: ['tests/value.test.js'],
    requirements: [],
    risk_triggers: [],
    behavioral: true,
    test_intent: 'green-maintenance',
    hooks_trusted: true,
    subagents_available: true,
    explicit_invocation: true,
    // Keep this fixture on the direct fast path; v2 preflight behavior is
    // independently covered and does not change the test-intent contract.
    plan_contract_version: 1,
    ...overrides,
  };
}

function rawReceipt(ticket, overrides = {}) {
  return {
    ticket_id: ticket.ticket_id,
    status: 'passed',
    agent_identity: 'agent-test-writer',
    tests: [],
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

const PASSING_TEST = [
  "import test from 'node:test';",
  "import assert from 'node:assert/strict';",
  "test('existing behavior remains covered', () => assert.equal(1 + 1, 2));",
  '',
].join('\n');

describe('green-maintenance input and scheduling', () => {
  it('defaults ordinary behavioral work to red-first and validates the explicit green contract', () => {
    expect(RunStartInputSchema.parse({
      ...startInput(),
      test_intent: undefined,
    }).test_intent).toBe('red-first');
    expect(RunStartInputSchema.parse(startInput()).test_intent).toBe('green-maintenance');
    for (const invalid of [
      startInput({ behavioral: false }),
      startInput({ mode: 'debug' }),
      startInput({ test_paths: [] }),
    ]) {
      expect(RunStartInputSchema.safeParse(invalid).success).toBe(false);
    }
  });

  it('uses the bounded test allowlist to classify test-only maintenance and never invents a build', () => {
    const run = {
      ...startInput(),
      lane: 'fast',
      remediation_cycles: 0,
      high_risk: false,
    };
    expect(classifyLane({
      requested_lane: 'auto',
      claimed_paths: [],
      test_paths: run.test_paths,
      test_intent: run.test_intent,
      behavioral: true,
      risk_triggers: [],
    }).lane).toBe('fast');
    expect(initialStages(run)).toEqual([
      expect.objectContaining({
        id: 'test', role: 'test_writer', required_checks: ['green-test'], writable: true,
      }),
    ]);
    expect(nextStages(run, 'test', {}).map((stage) => stage.role)).toEqual(['reviewer']);
    expect(projectedPipeline(run).stages.map((stage) => stage.id)).not.toContain('build');
  });

  it('keeps a production implementer only when green maintenance declares production claims', () => {
    const run = {
      ...startInput({ claimed_paths: ['src/value.js'] }),
      lane: 'fast',
      remediation_cycles: 0,
    };
    expect(nextStages(run, 'test', {})).toEqual([
      expect.objectContaining({ id: 'build', role: 'implementer' }),
    ]);
  });
});

describe('runtime-owned green-maintenance admission', () => {
  it('admits only runtime-observed pass/pass, seals it, and advances directly to review', async () => {
    const dir = await project();
    const started = await startRun(dir, startInput());
    expect(started.ok).toBe(true);
    expect(started.run).toMatchObject({
      lane: 'fast',
      test_intent: 'green-maintenance',
      claimed_paths: [],
    });
    const ticket = started.run.tickets[0];
    expect(ticket).toMatchObject({
      role: 'test_writer',
      test_intent: 'green-maintenance',
      test_scope: 'exact',
      required_checks: ['green-test'],
    });

    await writeFile(path.join(dir, 'tests', 'value.test.js'), PASSING_TEST);
    const result = await recordReceipt(dir, rawReceipt(ticket, {
      // A raw observation has no authority and must be overwritten.
      evidence: { green_test: { observed: true, command: 'forged', passed: true } },
    }));
    expect(result.ok).toBe(true);
    expect(result.receipt.evidence.green_test).toMatchObject({
      observed: true,
      template: true,
      passed: true,
      exit_code: 0,
      test_paths: ['tests/value.test.js'],
      tree_sha: result.receipt.head_tree_sha,
    });
    expect(result.receipt.evidence.green_test.command).not.toBe('forged');
    expect(result.receipt.evidence.green_test.runs).toHaveLength(2);
    expect(result.receipt.evidence.green_test.runs.map((run) => run.exit_code)).toEqual([0, 0]);
    expect(result.actions.filter((action) => action.type === 'dispatch_agent').map((action) =>
      action.ticket.role)).toEqual(['reviewer']);
    expect(result.run.tickets.some((entry) => entry.role === 'implementer')).toBe(false);
  }, 30_000);

  it('rejects fail/fail even when the worker self-reports green evidence', async () => {
    const dir = await project();
    const started = await startRun(dir, startInput());
    const ticket = started.run.tickets[0];
    await writeFile(path.join(dir, 'tests', 'value.test.js'), 'throw new Error("not green");\n');
    const result = await recordReceipt(dir, rawReceipt(ticket, {
      evidence: { green_test: { observed: true, command: 'forged', passed: true } },
    }));
    expect(result).toMatchObject({ ok: false, rejected: true });
    expect(result.errors.join(' ')).toMatch(/green-test failed twice.*pass deterministically/);
    expect(await readdir(runtimePaths(dir).receipts).catch(() => [])).toHaveLength(0);
  });

  it('rejects pass/fail as nondeterministic and restores a created runner artifact', async () => {
    const dir = await project({
      test_commands: {
        full: 'node --test',
        targeted_template: 'node --test {paths}',
      },
    });
    const started = await startRun(dir, startInput());
    const ticket = started.run.tickets[0];
    const marker = path.join(dir, '.green-maintenance-flake');
    await writeFile(path.join(dir, 'tests', 'value.test.js'), [
      "import { existsSync, writeFileSync } from 'node:fs';",
      "const marker = '.green-maintenance-flake';",
      "if (existsSync(marker)) process.exitCode = 1;",
      "else writeFileSync(marker, 'first pass');",
      '',
    ].join('\n'));
    const result = await recordReceipt(dir, rawReceipt(ticket));
    expect(result).toMatchObject({ ok: false, rejected: true });
    expect(result.errors.join(' ')).toMatch(/green-test is nondeterministic.*pass\/pass/);
    expect(existsSync(marker)).toBe(false);
  });

  it('routes green pass/pass through every configured owning runner', async () => {
    const dir = await project({
      test_commands: { full: 'node --test' },
      runners: [{
        id: 'node-tests',
        owns: ['tests/**'],
        root: '.',
        profile: { targeted_template: 'node --test {paths}' },
      }],
    });
    const started = await startRun(dir, startInput());
    const ticket = started.run.tickets[0];
    await writeFile(path.join(dir, 'tests', 'value.test.js'), PASSING_TEST);
    const result = await recordReceipt(dir, rawReceipt(ticket));
    expect(result.ok).toBe(true);
    expect(result.receipt.evidence.green_test).toMatchObject({
      observed: true,
      passed: true,
      participants: [expect.objectContaining({
        id: 'node-tests',
        test_paths: ['tests/value.test.js'],
        runs: [
          expect.objectContaining({ exit_code: 0 }),
          expect.objectContaining({ exit_code: 0 }),
        ],
      })],
    });
  }, 30_000);
});
