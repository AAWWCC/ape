import { execFileSync } from 'node:child_process';
import { access, mkdtemp, mkdir, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { recordReceipt } from '../lib/runtime/service.js';
import { seedLegacyRun as startRun } from './legacy-run-test-helper.js';

// These are historical receipt-time fallback/guard fixtures. Missing or
// unscopeable runners are refused before dispatch on new admitted runs;
// retained legacy runs must still execute the same fail-closed receipt checks.
import { runtimePaths } from '../lib/runtime/paths.js';
import { atomicWriteJson, readJson } from '../lib/runtime/storage.js';
import { receiptExecutionConfig } from '../lib/runtime/receipt-service.js';

// F12 (red phase, round 3): a test-writer receipt on a `red-test` required
// check must not be admitted purely from self-reported tests[] evidence
// ({command:'never executed', passed:false, exit_code:1}). The runtime itself
// executes the authored tests at admission and must observe them fail; the
// observation is bound into the receipt evidence, durable and tree-bound.

const cleanups = [];
afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

function git(cwd, ...args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

async function project(config = {}) {
  const dir = await mkdtemp(path.join(tmpdir(), 'ape-round3-red-'));
  cleanups.push(dir);
  await mkdir(path.join(dir, 'src'));
  await mkdir(path.join(dir, 'tests'));
  await writeFile(path.join(dir, 'src', 'value.js'), 'export const value = 1;\n');
  await writeFile(path.join(dir, 'tests', 'value.test.js'), 'throw new Error("red");\n');
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

function startInput(overrides = {}) {
  return {
    objective: 'Exercise runtime-owned red-test admission',
    mode: 'phase',
    lane: 'fast',
    host: 'codex',
    claimed_paths: ['src/value.js'],
    test_paths: ['tests/value.test.js'],
    requirements: [],
    risk_triggers: [],
    behavioral: true,
    hooks_trusted: true,
    subagents_available: true,
    explicit_invocation: true,
    ...overrides,
  };
}

// The memo's exact fabricated evidence: a red claim for a command that was
// never executed.
const FABRICATED_RED = [{ command: 'never executed', passed: false, exit_code: 1, duration_ms: 1 }];

function rawReceipt(ticket, overrides = {}) {
  return {
    ticket_id: ticket.ticket_id,
    status: 'passed',
    agent_identity: `agent-${ticket.role}`,
    tests: FABRICATED_RED,
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

describe('runtime-owned red-test execution at test-writer admission (F12)', () => {
  it('uses the immutable run command snapshot for new-contract red-test execution', () => {
    const live = {
      test_commands: { targeted: 'node live-command.js' },
      runners: [{ id: 'live-runner' }],
      deadlines_ms: { fast: 1234 },
    };
    const state = {
      capability_snapshot: {
        version: 1,
        test_commands: { targeted: 'node snapshotted-command.js' },
        runners: [{ id: 'snapshotted-runner' }],
      },
    };
    const resolved = receiptExecutionConfig(
      state,
      { receipt_contract_version: 1 },
      live,
    );
    expect(resolved).toMatchObject({
      test_commands: { targeted: 'node snapshotted-command.js' },
      runners: [{ id: 'snapshotted-runner' }],
      deadlines_ms: { fast: 1234 },
    });
    expect(receiptExecutionConfig(state, {}, live)).toBe(live);
  });

  it('rejects the fabricated red claim when the authored tests actually pass', async () => {
    const dir = await project();
    const started = await startRun(dir, startInput());
    expect(started.ok).toBe(true);
    const ticket = started.run.tickets[0];
    expect(ticket.role).toBe('test_writer');
    expect(ticket.required_checks).toContain('red-test');

    // The test writer commits a GREEN test file but self-reports red evidence
    // for a command that was never executed (the memo's reproduction).
    await writeFile(path.join(dir, 'tests', 'value.test.js'), '// green: no failing assertion\n');
    const result = await recordReceipt(dir, rawReceipt(ticket));
    expect(result).toMatchObject({ ok: false, rejected: true });
    expect(result.errors.join(' ')).toMatch(/red phase was not observed/);

    // Fail closed with no durable side effects: no receipt, no transaction.
    const paths = runtimePaths(dir);
    expect(await readdir(paths.receipts).catch(() => [])).toHaveLength(0);
    expect(await readdir(paths.receiptTransactions).catch(() => [])).toHaveLength(0);
  });

  it('cannot be skipped by forging a red_test observation in the raw evidence', async () => {
    const dir = await project();
    const started = await startRun(dir, startInput());
    const ticket = started.run.tickets[0];

    await writeFile(path.join(dir, 'tests', 'value.test.js'), '// green: no failing assertion\n');
    const result = await recordReceipt(dir, rawReceipt(ticket, {
      evidence: {
        verdict: 'pass',
        red_test: { observed: true, command: 'forged', exit_code: 1, passed: false },
      },
    }));
    expect(result).toMatchObject({ ok: false, rejected: true });
    expect(result.errors.join(' ')).toMatch(/red phase was not observed/);
  });

  it('rejects with a configuration instruction when no red-test command is derivable', async () => {
    const dir = await project();
    const started = await startRun(dir, startInput());
    const ticket = started.run.tickets[0];

    // The only authored change is a non-executable test asset: nothing is
    // derivable and no test_commands.targeted is configured — fail closed.
    await writeFile(path.join(dir, 'tests', 'fixture.txt'), 'not a runnable test\n');
    const result = await recordReceipt(dir, rawReceipt(ticket));
    expect(result).toMatchObject({ ok: false, rejected: true });
    expect(result.errors.join(' ')).toMatch(/configure test_commands\.targeted/);
  });

  it('admits a genuinely red authored test and binds the tree-bound observation', async () => {
    const dir = await project();
    const started = await startRun(dir, startInput());
    const ticket = started.run.tickets[0];

    await writeFile(path.join(dir, 'tests', 'value.test.js'), 'throw new Error("still red");\n');
    // The worker does not duplicate the expected-nonzero execution. Runtime
    // admission owns both red runs and seals their evidence.
    const result = await recordReceipt(dir, rawReceipt(ticket, { tests: [] }));
    expect(result.ok).toBe(true);
    const observation = result.receipt.evidence.red_test;
    expect(observation).toMatchObject({
      observed: true,
      derived: true,
      passed: false,
      test_paths: ['tests/value.test.js'],
      tree_sha: result.receipt.head_tree_sha,
    });
    expect(observation.command).toMatch(/--test/);
    expect(observation.exit_code).not.toBe(0);
    expect(observation.result_hash).toMatch(/^[0-9a-f]{64}$/);

    // The observation is durable: it rides the receipt into the transaction
    // and the receipt file, sealed by the receipt hash.
    const paths = runtimePaths(dir);
    const transactions = await readdir(paths.receiptTransactions);
    expect(transactions).toHaveLength(1);
    expect(result.run.receipts[0].evidence.red_test).toMatchObject({ observed: true });
  });

  it('uses the configured test_commands.targeted when present and requires it to fail', async () => {
    const dir = await project({
      test_commands: { full: 'node --test', targeted: 'node tests/value.test.js' },
    });
    const started = await startRun(dir, startInput());
    const ticket = started.run.tickets[0];

    await writeFile(path.join(dir, 'tests', 'value.test.js'), 'throw new Error("configured red");\n');
    const result = await recordReceipt(dir, rawReceipt(ticket));
    expect(result.ok).toBe(true);
    expect(result.receipt.evidence.red_test).toMatchObject({
      observed: true,
      configured: true,
      command: 'node tests/value.test.js',
      passed: false,
    });
  });

  it('runs the runtime-owned red test without an execution-budget pause', async () => {
    const dir = await project();
    const sentinel = path.join(tmpdir(), `${path.basename(dir)}-red-test-command-ran`);
    cleanups.push(sentinel);
    const command = `node -e "require('fs').writeFileSync('${sentinel}','ran'); process.exit(1)"`;
    await atomicWriteJson(runtimePaths(dir).config, {
      shipping: { auto_merge: false, provider: 'github', required_remote_checks: false },
      test_commands: { full: 'node --test', targeted: command },
    });
    const started = await startRun(dir, startInput());
    expect(started.ok).toBe(true);
    const ticket = started.run.tickets[0];
    await writeFile(path.join(dir, 'tests', 'value.test.js'), 'throw new Error("budgeted red");\n');

    const paths = runtimePaths(dir);
    const recorded = await recordReceipt(dir, rawReceipt(ticket, { tests: [] }));
    expect(recorded.ok).toBe(true);
    await expect(access(sentinel)).resolves.toBeUndefined();
    expect((await readJson(paths.active, null))).not.toHaveProperty('execution_budget');
  });

  it('a deadline-killed red-test execution is no-verdict, never an observed red', async () => {
    // The configured command traps the deadline SIGTERM and exits nonzero —
    // exactly what a hung suite looks like when the runtime kills it. Without
    // the timed_out marker that result (exit_code 7, passed false) is
    // indistinguishable from a genuine red observation and was admitted; on
    // win32 the taskkill'd tree exits 1 with the same ambiguity. A deadline
    // kill proves nothing about the authored tests, so admission must fail
    // closed with the no-verdict message.
    const dir = await project({
      test_commands: { full: 'node --test', targeted: 'node tests/hang.cjs' },
      deadlines_ms: { fast: 400 },
    });
    await writeFile(
      path.join(dir, 'tests', 'hang.cjs'),
      'process.on("SIGTERM", () => process.exit(7));\nsetInterval(() => {}, 1000);\n',
    );
    git(dir, 'add', '.');
    git(dir, 'commit', '-qm', 'fixture: deadline-outliving targeted command');
    const started = await startRun(dir, startInput());
    expect(started.ok).toBe(true);
    const ticket = started.run.tickets[0];
    expect(ticket.required_checks).toContain('red-test');

    await writeFile(path.join(dir, 'tests', 'value.test.js'), 'throw new Error("authored red");\n');
    const result = await recordReceipt(dir, rawReceipt(ticket));
    expect(result).toMatchObject({ ok: false, rejected: true });
    expect(result.errors.join(' ')).toMatch(/did not produce a test verdict/);

    // Fail closed with no durable side effects: no receipt, no transaction.
    const paths = runtimePaths(dir);
    expect(await readdir(paths.receipts).catch(() => [])).toHaveLength(0);
    expect(await readdir(paths.receiptTransactions).catch(() => [])).toHaveLength(0);
  }, 30_000);

  it('rejects a red-test command that mutates the tree, sealing nothing (TOCTOU)', async () => {
    // The command exits nonzero (red observed) but also rewrites a tracked
    // production file, so the observation would attest a head tree that no
    // longer exists. Admission must reject on tree instability — naming the
    // rewritten file, since a modified pre-existing path is never
    // auto-restored — not seal red evidence against the stale SHA.
    const mutating =
      `node -e "require('fs').writeFileSync('src/value.js','export const value = 999;\\n'); process.exit(1)"`;
    const dir = await project({
      test_commands: { full: 'node --test', targeted: mutating },
    });
    const started = await startRun(dir, startInput());
    const ticket = started.run.tickets[0];
    expect(ticket.required_checks).toContain('red-test');

    await writeFile(path.join(dir, 'tests', 'value.test.js'), 'throw new Error("red");\n');
    const result = await recordReceipt(dir, rawReceipt(ticket));
    expect(result).toMatchObject({ ok: false, rejected: true });
    expect(result.errors.join(' ')).toMatch(/modified pre-existing files \(src\/value\.js\).*red evidence must be tree-stable/);

    // Fail closed with no durable side effects: no receipt, no transaction.
    const paths = runtimePaths(dir);
    expect(await readdir(paths.receipts).catch(() => [])).toHaveLength(0);
    expect(await readdir(paths.receiptTransactions).catch(() => [])).toHaveLength(0);
  });
});
