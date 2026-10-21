import { gitFixtureEnv } from '../test-support/git-fixtures.js';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { previewRun, recordReceipt, startRun } from '../lib/runtime/service.js';
import { runtimePaths } from '../lib/runtime/paths.js';
import { atomicWriteJson } from '../lib/runtime/storage.js';
import { isNonExecutablePath, isNonExecutableTask } from '../lib/runtime/path-scope.js';
import { RunStartInputSchema } from '../lib/runtime/schemas.js';

const cleanups = [];
afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((entry) => rm(entry, { recursive: true, force: true })));
});

function git(cwd, ...args) {
  return execFileSync('git', args, { env: gitFixtureEnv(), cwd, encoding: 'utf8' }).trim();
}

async function createProject(config = {}) {
  const dir = await mkdtemp(path.join(tmpdir(), 'ape-challenger-m4-1-'));
  cleanups.push(dir);
  await mkdir(path.join(dir, 'docs'), { recursive: true });
  await mkdir(path.join(dir, 'src'), { recursive: true });
  await mkdir(path.join(dir, 'tests'), { recursive: true });
  await writeFile(path.join(dir, 'README.md'), '# Baseline\n');
  await writeFile(path.join(dir, 'docs', 'guide.md'), '# Guide\nInitial docs.\n');
  await writeFile(path.join(dir, 'src', 'code.js'), 'export const val = 1;\n');
  await writeFile(path.join(dir, 'tests', 'index.test.js'), '// test file\n');

  await writeFile(path.join(dir, '.gitignore'), '.ape/\n');
  git(dir, 'init', '-q');
  git(dir, 'config', 'user.email', 'ape-challenger@example.test');
  git(dir, 'config', 'user.name', 'APE Challenger');
  git(dir, 'add', '.');
  git(dir, 'commit', '-qm', 'baseline');

  await atomicWriteJson(runtimePaths(dir).config, {
    shipping: { auto_merge: false, provider: 'github', required_remote_checks: false },
    test_commands: { full: 'node --test', targeted_template: 'node --test {paths}' },
    ...config,
  });
  return dir;
}

function baseInput(overrides = {}) {
  return {
    objective: 'Challenger R5 test necessity stress test',
    mode: 'phase',
    lane: 'auto',
    host: 'codex',
    claimed_paths: ['docs/guide.md'],
    test_paths: [],
    requirements: [],
    risk_triggers: [],
    behavioral: true,
    hooks_trusted: true,
    subagents_available: true,
    explicit_invocation: true,
    plan_contract_version: 1,
    ...overrides,
  };
}

describe('Challenger M4 1: R5 Test Necessity Stress Test', () => {
  describe('1. Mixed claim paths boundary & bypass prevention', () => {
    it('does not classify mixed code/doc paths as non-executable task', () => {
      expect(isNonExecutablePath('docs/guide.md')).toBe(true);
      expect(isNonExecutablePath('src/code.js')).toBe(false);

      expect(isNonExecutableTask({ claimed_paths: ['docs/guide.md', 'src/code.js'], behavioral: true })).toBe(false);
      expect(isNonExecutableTask({ claimed_paths: ['docs/guide.md', 'src/code.js'] })).toBe(false);
      expect(isNonExecutableTask({ claimed_paths: ['README.md', 'package.json', 'src/code.js'] })).toBe(false);
    });

    it('defaults mixed claim paths to red-first in schema parse, preview, and run start', async () => {
      // 1. Schema parse
      const parsed = RunStartInputSchema.parse(baseInput({
        claimed_paths: ['docs/guide.md', 'src/code.js'],
        test_paths: ['tests/index.test.js'],
        test_intent: undefined,
      }));
      expect(parsed.test_intent).toBe('red-first');

      // 2. PreviewRun
      const dir = await createProject();
      const preview = await previewRun(dir, baseInput({
        claimed_paths: ['docs/guide.md', 'src/code.js'],
        test_paths: ['tests/index.test.js'],
      }));
      expect(preview.ok).toBe(true);
      const testStage = preview.blueprint.stages.find((s) => s.id === 'test');
      expect(testStage.role).toBe('test_writer');
      expect(testStage.required_checks).toEqual(['red-test']);
      const buildStage = preview.blueprint.stages.find((s) => s.id === 'build');
      expect(buildStage.required_checks).toEqual(['targeted-tests']);

      // 3. StartRun
      const started = await startRun(dir, baseInput({
        claimed_paths: ['docs/guide.md', 'src/code.js'],
        test_paths: ['tests/index.test.js'],
      }));
      expect(started.ok).toBe(true);
      expect(started.run.test_intent).toBe('red-first');
      const ticket = started.run.tickets[0];
      expect(ticket.role).toBe('test_writer');
      expect(ticket.test_intent).toBe('red-first');
      expect(ticket.required_checks).toEqual(['red-test']);
    });

    it('refuses empty authored tests when claimed paths contain executable files', async () => {
      const dir = await createProject();
      // Even if an operator attempts to force green-maintenance on mixed claims with empty test_paths
      const started = await startRun(dir, baseInput({
        claimed_paths: ['docs/guide.md', 'src/code.js'],
        test_paths: [],
        test_intent: 'green-maintenance',
      }));
      expect(started.ok).toBe(true);
      const ticket = started.run.tickets[0];
      expect(ticket.role).toBe('test_writer');

      // Test writer submits zero authored tests
      const receiptRes = await recordReceipt(dir, {
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
      });

      // Must be rejected: mixed claims do NOT qualify for non-code zero-test admission
      expect(receiptRes.ok).toBe(false);
      expect(receiptRes.rejected).toBe(true);
      expect(receiptRes.errors[0]).toContain('admission found no runtime-verifiable authored test files');
    });
  });

  describe('2. Explicit user intent preservation', () => {
    it('strictly preserves explicit test_intent: red-first on non-code files across schema, preview, and start', async () => {
      // 1. Schema parse
      const parsed = RunStartInputSchema.parse(baseInput({
        claimed_paths: ['docs/guide.md', 'README.md'],
        test_paths: ['tests/index.test.js'],
        test_intent: 'red-first',
      }));
      expect(parsed.test_intent).toBe('red-first');

      // 2. PreviewRun
      const dir = await createProject();
      const preview = await previewRun(dir, baseInput({
        claimed_paths: ['docs/guide.md', 'README.md'],
        test_paths: ['tests/index.test.js'],
        test_intent: 'red-first',
      }));
      expect(preview.ok).toBe(true);
      const testStage = preview.blueprint.stages.find((s) => s.id === 'test');
      expect(testStage.role).toBe('test_writer');
      expect(testStage.required_checks).toEqual(['red-test']);

      // 3. StartRun
      const started = await startRun(dir, baseInput({
        claimed_paths: ['docs/guide.md', 'README.md'],
        test_paths: ['tests/index.test.js'],
        test_intent: 'red-first',
      }));
      expect(started.ok).toBe(true);
      expect(started.run.test_intent).toBe('red-first');

      const ticket = started.run.tickets[0];
      expect(ticket.role).toBe('test_writer');
      expect(ticket.test_intent).toBe('red-first');
      expect(ticket.required_checks).toEqual(['red-test']);
    });

    it('strictly preserves explicit test_intent: red-first even when behavioral is false', async () => {
      const parsed = RunStartInputSchema.parse(baseInput({
        claimed_paths: ['docs/guide.md'],
        test_paths: ['tests/index.test.js'],
        behavioral: false,
        test_intent: 'red-first',
      }));
      expect(parsed.test_intent).toBe('red-first');
    });

    it('prevents starting red-first run without test paths, and refuses empty test submission', async () => {
      const dir = await createProject();

      // Attempting to start red-first run with empty test_paths is blocked by doctor/readiness
      const blockedStart = await startRun(dir, baseInput({
        claimed_paths: ['docs/guide.md'],
        test_paths: [],
        test_intent: 'red-first',
      }));
      expect(blockedStart.ok).toBe(false);
      expect(blockedStart.blocked).toBe(true);
      expect(blockedStart.reason).toBe('runtime doctor failed before write');

      // Starting with declared test_paths succeeds, but submitting tests: [] is refused
      const started = await startRun(dir, baseInput({
        claimed_paths: ['docs/guide.md'],
        test_paths: ['tests/index.test.js'],
        test_intent: 'red-first',
      }));
      expect(started.ok).toBe(true);
      const ticket = started.run.tickets[0];
      expect(ticket.test_intent).toBe('red-first');
      expect(ticket.required_checks).toEqual(['red-test']);

      // Submitting zero authored tests on red-first is refused
      const result = await recordReceipt(dir, {
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
      });
      expect(result.ok).toBe(false);
      expect(result.rejected).toBe(true);
      expect(result.errors[0]).toContain('red-test admission found no runtime-verifiable authored test files');
    });
  });

  describe('3. Empty authored test set admission & implementer build transition', () => {
    it('admits tests: [] on non-code tasks with status: passed and advances to implementer build with required_checks: []', async () => {
      const dir = await createProject();
      const started = await startRun(dir, baseInput({
        claimed_paths: ['docs/guide.md'],
        test_paths: [],
      }));
      expect(started.ok).toBe(true);
      const testWriterTicket = started.run.tickets[0];
      expect(testWriterTicket.role).toBe('test_writer');
      expect(testWriterTicket.test_intent).toBe('green-maintenance');
      expect(testWriterTicket.required_checks).toEqual(['green-test']);

      // Submit empty tests
      const testReceiptResult = await recordReceipt(dir, {
        ticket_id: testWriterTicket.ticket_id,
        status: 'passed',
        agent_identity: 'agent-test-writer',
        tests: [],
        findings: [],
        evidence: { verdict: 'pass' },
        timing: {
          started_at: testWriterTicket.issued_at,
          completed_at: new Date(Date.parse(testWriterTicket.issued_at) + 10).toISOString(),
          duration_ms: 10,
        },
      });

      expect(testReceiptResult.ok).toBe(true);
      expect(testReceiptResult.receipt.status).toBe('passed');
      expect(testReceiptResult.receipt.errors ?? []).toEqual([]);
      expect(testReceiptResult.receipt.evidence.green_test).toMatchObject({
        observed: true,
        passed: true,
        command: 'none',
        exit_code: 0,
        test_paths: [],
        non_code: true,
      });

      // Verify stage advances to implementer build with required_checks: []
      const dispatchAction = testReceiptResult.actions.find(
        (action) => action.type === 'dispatch_agent' && action.ticket.role === 'implementer',
      );
      expect(dispatchAction).toBeDefined();
      expect(dispatchAction.ticket.stage_id).toBe('build');
      expect(dispatchAction.ticket.required_checks).toEqual([]);
      expect(dispatchAction.ticket.required_checks.length).toBe(0);
    });

    it('directly transitions to implementer build with required_checks: [] on behavioral: false tasks', async () => {
      const dir = await createProject();
      const started = await startRun(dir, baseInput({
        claimed_paths: ['src/code.js'],
        test_paths: [],
        behavioral: false,
      }));
      expect(started.ok).toBe(true);
      expect(started.run.test_intent).toBe('green-maintenance');

      // Behavioral: false bypasses test_writer and starts directly at implementer
      const implementerTicket = started.run.tickets[0];
      expect(implementerTicket.role).toBe('implementer');
      expect(implementerTicket.stage_id).toBe('build');
      expect(implementerTicket.required_checks).toEqual([]);

      // Implementer modifies code and records receipt with zero tests
      await writeFile(path.join(dir, 'src', 'code.js'), 'export const val = 2;\n');
      git(dir, 'add', 'src/code.js');
      git(dir, 'commit', '-qm', 'update val');

      const implementerReceiptResult = await recordReceipt(dir, {
        ticket_id: implementerTicket.ticket_id,
        status: 'passed',
        agent_identity: 'agent-implementer',
        tests: [],
        findings: [],
        evidence: { verdict: 'pass' },
        timing: {
          started_at: implementerTicket.issued_at,
          completed_at: new Date(Date.parse(implementerTicket.issued_at) + 10).toISOString(),
          duration_ms: 10,
        },
      });

      expect(implementerReceiptResult.ok).toBe(true);
      expect(implementerReceiptResult.receipt.status).toBe('passed');
      // Stage advances to reviewer
      const reviewerAction = implementerReceiptResult.actions.find(
        (action) => action.type === 'dispatch_agent' && action.ticket.role === 'reviewer',
      );
      expect(reviewerAction).toBeDefined();
    });
  });

  describe('4. Schema validation boundaries for test_intent and modes', () => {
    it('cleanly accepts valid combinations of phase mode, green-maintenance, behavioral: false, and empty test_paths', () => {
      const validCases = [
        { mode: 'phase', test_intent: 'green-maintenance', behavioral: false, test_paths: [] },
        { mode: 'phase', test_intent: 'green-maintenance', behavioral: true, test_paths: [] },
        { mode: 'phase', test_intent: 'green-maintenance', behavioral: true, test_paths: ['tests/foo.test.js'] },
        { mode: 'phase', test_intent: 'red-first', behavioral: false, test_paths: [] },
      ];

      for (const validCase of validCases) {
        const result = RunStartInputSchema.safeParse(baseInput(validCase));
        expect(result.success, `Expected validCase ${JSON.stringify(validCase)} to succeed`).toBe(true);
        if (validCase.test_intent) {
          expect(result.data.test_intent).toBe(validCase.test_intent);
        }
      }
    });

    it('rejects green-maintenance on non-phase modes', () => {
      const invalidModes = ['debug', 'spike', 'land'];

      for (const invalidMode of invalidModes) {
        const result = RunStartInputSchema.safeParse(baseInput({
          mode: invalidMode,
          test_intent: 'green-maintenance',
        }));
        expect(result.success, `Expected mode ${invalidMode} with green-maintenance to fail`).toBe(false);
        const issue = result.error.issues.find((i) => i.path.includes('test_intent'));
        expect(issue).toBeDefined();
        expect(issue.message).toContain('green-maintenance test intent is allowed only for phase mode');
      }
    });

    it('rejects unrecognized modes and invalid test_intent values', () => {
      expect(RunStartInputSchema.safeParse(baseInput({ mode: 'unsupported_mode' })).success).toBe(false);
      expect(RunStartInputSchema.safeParse(baseInput({ mode: 'remediation', test_intent: 'green-maintenance' })).success).toBe(false);
      expect(RunStartInputSchema.safeParse(baseInput({ test_intent: 'yellow' })).success).toBe(false);
      expect(RunStartInputSchema.safeParse(baseInput({ test_intent: '' })).success).toBe(false);
    });
  });
});
