import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { recordReceipt, startRun } from '../lib/runtime/service.js';
import { runtimePaths } from '../lib/runtime/paths.js';
import { atomicWriteJson } from '../lib/runtime/storage.js';

// Service-level coverage for mid-run lane and risk handling:
// F21 — a mechanical run stays mechanical and goes straight to gates.
// F8  — receipt-reported risk triggers arm high_risk/risk_triggers so the
//       security review is actually issued.
// F22 — mid-run escalation honors the configured policy.fast_max_files.
// F11 — receipts never claim an unobserved model.

const cleanups = [];
afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

function git(cwd, ...args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

async function project(config = {}) {
  const dir = await mkdtemp(path.join(tmpdir(), 'ape-core-escalation-'));
  cleanups.push(dir);
  await mkdir(path.join(dir, 'src'));
  await mkdir(path.join(dir, 'tests'));
  await mkdir(path.join(dir, 'docs'));
  await writeFile(path.join(dir, 'src', 'value.js'), 'export const value = 1;\n');
  await writeFile(path.join(dir, 'tests', 'value.test.js'), 'throw new Error("red");\n');
  await writeFile(path.join(dir, 'docs', 'notes.md'), '# Notes\n');
  git(dir, 'init', '-q');
  git(dir, 'config', 'user.email', 'ape@example.test');
  git(dir, 'config', 'user.name', 'APE Test');
  git(dir, 'add', '.');
  git(dir, 'commit', '-qm', 'test: baseline');
  await atomicWriteJson(runtimePaths(dir).config, {
    shipping: { auto_merge: false, provider: 'github', required_remote_checks: false },
    test_commands: { full: 'node -e "process.exit(0)"', targeted_template: 'node --test {paths}' },
    ...config,
  });
  return dir;
}

function startInput(overrides = {}) {
  return {
    objective: 'Exercise mid-run lane and risk handling',
    mode: 'phase',
    lane: 'auto',
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

function receipt(ticket, overrides = {}) {
  return {
    ticket_id: ticket.ticket_id,
    status: 'passed',
    agent_identity: `agent-${ticket.role}`,
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

const redTest = [{ command: 'node tests/value.test.js', passed: false, exit_code: 1, duration_ms: 1 }];
const greenTest = [{ command: 'node tests/value.test.js', passed: true, exit_code: 0, duration_ms: 1 }];

describe('mechanical runs stay mechanical (F21)', () => {
  it('keeps the persisted non-behavioral classification and runs gates directly', async () => {
    const dir = await project();
    const started = await startRun(dir, startInput({
      behavioral: false,
      claimed_paths: ['docs/notes.md'],
      test_paths: [],
    }));
    expect(started.ok).toBe(true);
    expect(started.run.lane).toBe('mechanical');
    expect(started.run.behavioral).toBe(false);
    expect(started.run.policy).toMatchObject({ high_risk_security_review: true });
    expect(started.run.policy.evidence_executables).toMatchObject({
      version: 'realpath-v1',
      platform: process.platform,
      heads: {
        echo: { kind: 'shell-builtin' },
        pwd: { kind: 'shell-builtin' },
        true: { kind: 'shell-builtin' },
      },
    });
    const build = started.run.tickets[0];
    expect(build.role).toBe('implementer');

    await writeFile(path.join(dir, 'docs', 'notes.md'), '# Notes\n\nUpdated.\n');
    const result = await recordReceipt(dir, receipt(build, { tests: greenTest }));
    expect(result.ok).toBe(true);
    // The run must not self-escalate to fast and must not grow a review or
    // test-writer stage; the build receipt goes straight to the merge gates.
    expect(result.run.lane).toBe('mechanical');
    expect(result.run.lane_escalated).toBe(false);
    expect(result.run.tickets).toHaveLength(1);
    expect(result.actions.some((action) => action.type === 'gates')).toBe(true);
    expect(result.run.gates).toBeTruthy();
  });
});

describe('receipt risk triggers arm the security machinery (F8)', () => {
  it('accumulates risk_triggers, sets high_risk, and issues security-review', async () => {
    const dir = await project();
    const started = await startRun(dir, startInput());
    expect(started.run.lane).toBe('fast');
    const testTicket = started.run.tickets[0];
    expect(testTicket.role).toBe('test_writer');

    await writeFile(path.join(dir, 'tests', 'value.test.js'), 'throw new Error("still red");\n');
    const testResult = await recordReceipt(dir, receipt(testTicket, {
      tests: redTest,
      evidence: { verdict: 'pass', risk_triggers: ['Security'] },
    }));
    expect(testResult.ok).toBe(true);
    expect(testResult.run.lane).toBe('full');
    expect(testResult.run.lane_escalated).toBe(true);
    expect(testResult.run.high_risk).toBe(true);
    expect(testResult.run.risk_triggers).toEqual(['security']);
    // F11: no host attested the executing model, so the receipt must not claim
    // the configured ticket model.
    expect(testResult.receipt.agent.model).toBeNull();
    expect(testResult.receipt.agent.model_attested).toBe(false);

    const buildTicket = testResult.run.tickets.at(-1);
    expect(buildTicket.role).toBe('implementer');
    await writeFile(path.join(dir, 'src', 'value.js'), 'export const value = 2;\n');
    const buildResult = await recordReceipt(dir, receipt(buildTicket, { tests: greenTest }));
    expect(buildResult.ok).toBe(true);
    const issued = buildResult.run.tickets.slice(-2);
    expect(issued.map((ticket) => ticket.stage_id).sort()).toEqual(['review', 'security-review']);
    expect(issued.some((ticket) => ticket.role === 'security_reviewer')).toBe(true);
  });
});

describe('authored test files are not production scope (friction #33)', () => {
  it('keeps a fast run fast after a test_writer receipt adds several test files', async () => {
    const dir = await project();
    const claimed = [
      'src/value.js',
      ...Array.from({ length: 4 }, (_, index) => `src/module-${index}.js`),
    ];
    const testPaths = [
      'tests/value.test.js',
      'tests/extra-a.test.js',
      'tests/extra-b.test.js',
      'tests/extra-c.test.js',
    ];
    const started = await startRun(dir, startInput({
      claimed_paths: claimed,
      test_paths: testPaths,
    }));
    expect(started.ok).toBe(true);
    expect(started.run.lane).toBe('fast');
    const testTicket = started.run.tickets[0];
    expect(testTicket.role).toBe('test_writer');

    await writeFile(path.join(dir, 'tests', 'value.test.js'), 'throw new Error("f33 red");\n');
    for (const name of ['extra-a', 'extra-b', 'extra-c']) {
      await writeFile(path.join(dir, 'tests', `${name}.test.js`), 'throw new Error("f33 red");\n');
    }
    const result = await recordReceipt(dir, receipt(testTicket, { tests: redTest }));
    expect(result.ok).toBe(true);
    // 5 claimed production files + 4 authored test files: counting the tests
    // would push the merge to 9 > fast_max_files (6) and escalate to full
    // citing scope-over-6-files. Authored tests are test-writer-confined, not
    // production scope, so the run stays fast.
    expect(result.run.lane).toBe('fast');
    expect(result.run.lane_escalated).toBe(false);
  });
});

describe('mid-run escalation honors configured policy (F22)', () => {
  it('keeps a fast run fast when the scope is within policy.fast_max_files', async () => {
    const dir = await project({ policy: { fast_max_files: 10 } });
    const claimed = [
      'src/value.js',
      ...Array.from({ length: 7 }, (_, index) => `src/module-${index}.js`),
    ];
    const started = await startRun(dir, startInput({ claimed_paths: claimed }));
    expect(started.ok).toBe(true);
    expect(started.run.lane).toBe('fast');
    const testTicket = started.run.tickets[0];

    await writeFile(path.join(dir, 'tests', 'value.test.js'), 'throw new Error("new red");\n');
    const result = await recordReceipt(dir, receipt(testTicket, { tests: redTest }));
    expect(result.ok).toBe(true);
    // 8 claimed paths (the changed test file is excluded from the escalation
    // count), inside the configured limit of 10; the hardcoded fallback of 6
    // must not force-escalate.
    expect(result.run.lane).toBe('fast');
    expect(result.run.lane_escalated).toBe(false);
  });
});
