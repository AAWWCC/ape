import { gitFixtureEnv } from '../test-support/git-fixtures.js';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { previewRun, recordReceipt, startRun } from '../lib/runtime/service.js';
import { runtimePaths } from '../lib/runtime/paths.js';
import { atomicWriteJson } from '../lib/runtime/storage.js';
import { isNonExecutablePath } from '../lib/runtime/path-scope.js';
import { RunStartInputSchema } from '../lib/runtime/schemas.js';

const cleanups = [];
afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((entry) => rm(entry, { recursive: true, force: true })));
});

function git(cwd, ...args) {
  return execFileSync('git', args, { env: gitFixtureEnv(), cwd, encoding: 'utf8' }).trim();
}

async function project(config = {}) {
  const dir = await mkdtemp(path.join(tmpdir(), 'ape-non-code-admission-'));
  cleanups.push(dir);
  await mkdir(path.join(dir, 'docs'), { recursive: true });
  await mkdir(path.join(dir, 'prompts'), { recursive: true });
  await mkdir(path.join(dir, 'src'), { recursive: true });
  await mkdir(path.join(dir, 'tests'), { recursive: true });
  await writeFile(path.join(dir, 'README.md'), '# Baseline Project\n');
  await writeFile(path.join(dir, 'docs', 'guide.md'), '# Guide\nInitial guide content.\n');
  await writeFile(path.join(dir, 'prompts', 'common.md'), '# Common Prompts\n');
  await writeFile(path.join(dir, '.editorconfig'), 'root = true\n');
  await writeFile(path.join(dir, 'package.json'), JSON.stringify({ name: 'fixture', version: '1.0.0' }, null, 2));
  await writeFile(path.join(dir, 'tsconfig.json'), JSON.stringify({ compilerOptions: {} }, null, 2));
  await writeFile(path.join(dir, 'src', 'index.js'), 'export const value = 42;\n');
  await writeFile(path.join(dir, 'tests', 'index.test.js'), '// test placeholder\n');

  await writeFile(path.join(dir, '.gitignore'), '.ape/\n');
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

function baseInput(overrides = {}) {
  return {
    objective: 'Non-code documentation and config update',
    mode: 'phase',
    lane: 'auto',
    host: 'codex',
    claimed_paths: ['docs/guide.md', 'README.md'],
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

describe('R5: Non-code path detection and test-intent classification', () => {
  it('identifies non-executable paths correctly', () => {
    expect(isNonExecutablePath('docs/guide.md')).toBe(true);
    expect(isNonExecutablePath('README.md')).toBe(true);
    expect(isNonExecutablePath('.editorconfig')).toBe(true);
    expect(isNonExecutablePath('package.json')).toBe(true);
    expect(isNonExecutablePath('tsconfig.json')).toBe(true);
    expect(isNonExecutablePath('prompts/common.md')).toBe(true);
    expect(isNonExecutablePath('docs/api/reference.txt')).toBe(true);

    expect(isNonExecutablePath('src/index.js')).toBe(false);
    expect(isNonExecutablePath('lib/runtime/service.js')).toBe(false);
    expect(isNonExecutablePath('tests/index.test.js')).toBe(false);
  });

  it('auto-detects markdown documentation modifications as test_intent: green-maintenance', async () => {
    const dir = await project();
    const started = await startRun(dir, baseInput({
      claimed_paths: ['docs/guide.md', 'README.md'],
      test_paths: [],
    }));
    expect(started.ok).toBe(true);
    expect(started.run.test_intent).toBe('green-maintenance');
    expect(started.run.claimed_paths).toEqual(['docs/guide.md', 'README.md']);
  });

  it('auto-detects configuration file modifications as test_intent: green-maintenance', async () => {
    const dir = await project();
    const started = await startRun(dir, baseInput({
      claimed_paths: ['.editorconfig', 'package.json', 'tsconfig.json', 'prompts/common.md'],
      test_paths: [],
    }));
    expect(started.ok).toBe(true);
    expect(started.run.test_intent).toBe('green-maintenance');
  });

  it('auto-detects behavioral: false runs as test_intent: green-maintenance', async () => {
    const dir = await project();
    const started = await startRun(dir, baseInput({
      behavioral: false,
      claimed_paths: ['README.md'],
      test_paths: [],
    }));
    expect(started.ok).toBe(true);
    expect(started.run.test_intent).toBe('green-maintenance');
    expect(started.run.behavioral).toBe(false);
  });

  it('retains standard test_intent (red-first) when claimed paths contain executable files', async () => {
    const dir = await project();
    const started = await startRun(dir, baseInput({
      claimed_paths: ['src/index.js', 'docs/guide.md'],
      test_paths: ['tests/index.test.js'],
    }));
    expect(started.ok).toBe(true);
    expect(started.run.test_intent).toBe('red-first');
  });

  it('respects explicit user-provided test_intent without auto-demotion', async () => {
    const dir = await project();
    const started = await startRun(dir, baseInput({
      claimed_paths: ['docs/guide.md'],
      test_paths: ['tests/index.test.js'],
      test_intent: 'red-first',
    }));
    expect(started.ok).toBe(true);
    expect(started.run.test_intent).toBe('red-first');
  });
});

describe('R5: Zero authored-test admission and execution lifecycle', () => {
  it('cleanly admits zero authored tests for non-code runs with status: passed and no refusal error', async () => {
    const dir = await project();
    const started = await startRun(dir, baseInput({
      claimed_paths: ['docs/guide.md'],
      test_paths: [],
    }));
    expect(started.ok).toBe(true);
    const ticket = started.run.tickets[0];
    expect(ticket.role).toBe('test_writer');
    expect(ticket.test_intent).toBe('green-maintenance');
    expect(ticket.required_checks).toEqual(['green-test']);

    // Worker submits receipt with zero authored tests and no test paths
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

    expect(result.ok).toBe(true);
    expect(result.receipt.status).toBe('passed');
    expect(result.receipt.evidence.green_test).toMatchObject({
      observed: true,
      passed: true,
      test_paths: [],
      non_code: true,
    });
  });

  it('advances execution through build and review cleanly without crashing or loop-blocking', async () => {
    const dir = await project();
    const started = await startRun(dir, baseInput({
      claimed_paths: ['docs/guide.md'],
      test_paths: [],
    }));
    const testWriterTicket = started.run.tickets[0];

    // Stage 1: test_writer submits zero tests
    const testResult = await recordReceipt(dir, {
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
    expect(testResult.ok).toBe(true);

    // Stage 2: implementer stage dispatched
    const implementerTicket = testResult.actions.find(
      (action) => action.type === 'dispatch_agent' && action.ticket.role === 'implementer',
    )?.ticket;
    expect(implementerTicket).toBeDefined();

    // Implementer edits documentation and records receipt
    await writeFile(path.join(dir, 'docs', 'guide.md'), '# Updated Guide\nNew documentation.\n');
    git(dir, 'add', 'docs/guide.md');
    git(dir, 'commit', '-qm', 'update docs');

    const implementerResult = await recordReceipt(dir, {
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
    expect(implementerResult.ok).toBe(true);

    // Stage 3: reviewer stage dispatched
    const reviewerTicket = implementerResult.actions.find(
      (action) => action.type === 'dispatch_agent' && action.ticket.role === 'reviewer',
    )?.ticket;
    expect(reviewerTicket).toBeDefined();

    const reviewerResult = await recordReceipt(dir, {
      ticket_id: reviewerTicket.ticket_id,
      status: 'passed',
      agent_identity: 'agent-reviewer',
      tests: [],
      findings: [],
      evidence: { verdict: 'pass' },
      timing: {
        started_at: reviewerTicket.issued_at,
        completed_at: new Date(Date.parse(reviewerTicket.issued_at) + 10).toISOString(),
        duration_ms: 10,
      },
    });
    expect(reviewerResult.ok).toBe(true);
    expect(reviewerResult.run.gates.passed).toBe(true);
    expect(reviewerResult.run.gates.checks.targeted_tests.passed).toBe(true);
    expect(reviewerResult.run.status).toBe('blocked');
    expect(reviewerResult.run.block_reason).toBe('auto-merge is disabled by configuration');
  }, 30_000);

  it('admits non-code tasks cleanly when multiple test runners are configured', async () => {
    const dir = await project({
      test_commands: { full: 'node --test' },
      runners: [{
        id: 'node-tests',
        owns: ['tests/**'],
        root: '.',
        profile: { targeted_template: 'node --test {paths}' },
      }],
    });
    const started = await startRun(dir, baseInput({
      claimed_paths: ['docs/guide.md'],
      test_paths: [],
    }));
    const ticket = started.run.tickets[0];

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
    expect(result.ok).toBe(true);
    expect(result.receipt.status).toBe('passed');
    expect(result.receipt.evidence.green_test.non_code).toBe(true);
  });
});
