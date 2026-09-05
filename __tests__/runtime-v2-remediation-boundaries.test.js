import { execFileSync } from 'node:child_process';
import { access, mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { runtimePaths } from '../lib/runtime/paths.js';
import {
  configAction,
  historyAction,
  recordReceipt,
  startRun,
  statusRun,
} from '../lib/runtime/service.js';
import { atomicWriteJson } from '../lib/runtime/storage.js';

const cleanups = [];

afterEach(async () => {
  delete Object.prototype.apePolluted;
  await Promise.all(cleanups.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

function git(cwd, ...args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

async function project(prefix = 'ape-remediation-') {
  const dir = await mkdtemp(path.join(tmpdir(), prefix));
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
    test_commands: { full: 'node --test', targeted_template: 'node --test {paths}' },
  });
  return dir;
}

function startInput(overrides = {}) {
  return {
    objective: 'Exercise bounded durable runtime inputs',
    mode: 'phase',
    lane: 'fast',
    host: 'codex',
    claimed_paths: ['src/value.js'],
    test_paths: ['tests/value.test.js'],
    requirements: ['REQ-REM'],
    risk_triggers: [],
    behavioral: true,
    hooks_trusted: true,
    subagents_available: true,
    explicit_invocation: true,
    ...overrides,
  };
}

function passingReceipt(ticket, overrides = {}) {
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

async function rejects(callback) {
  try {
    await callback();
    return false;
  } catch {
    return true;
  }
}

describe('APE v2 bounded and contained public inputs', () => {
  it('rejects recursive prototype keys without mutating Object.prototype', async () => {
    const dir = await project();
    let rejected = false;
    try {
      await configAction(dir, 'set', { key: '__proto__.apePolluted', value: true });
    } catch {
      rejected = true;
    } finally {
      delete Object.prototype.apePolluted;
    }

    expect(rejected).toBe(true);
    expect({}.apePolluted).toBeUndefined();
  });

  it('bounds raw UTF-8 strings before creating a run', async () => {
    const dir = await project();
    expect(await rejects(() => startRun(dir, startInput({
      objective: '🦍'.repeat(17_000),
    })))).toBe(true);
    expect(await access(runtimePaths(dir).active).then(() => true, () => false)).toBe(false);
  });

  it('bounds recursive nesting before persisting config input', async () => {
    const dir = await project();
    let nested = 'leaf';
    for (let index = 0; index < 80; index += 1) nested = { nested };

    expect(await rejects(() => configAction(dir, 'set', {
      key: 'policy.deep',
      value: nested,
    }))).toBe(true);
  });

  it('server-generates a contained receipt id instead of trusting a caller path', async () => {
    const dir = await project();
    const started = await startRun(dir, startInput());
    const ticket = started.run.tickets[0];
    await writeFile(path.join(dir, 'tests', 'value.test.js'), 'throw new Error("new red");\n');

    const result = await recordReceipt(dir, passingReceipt(ticket, {
      receipt_id: '../escaped-receipt',
      tests: [{
        command: 'node tests/value.test.js',
        passed: false,
        exit_code: 1,
        duration_ms: 1,
      }],
    }));

    expect(result.ok).toBe(true);
    expect(result.receipt.receipt_id).not.toBe('../escaped-receipt');
    expect(result.receipt.receipt_id).toMatch(/^[A-Za-z0-9_-]{16,128}$/);
    expect(await access(path.join(runtimePaths(dir).runtime, 'escaped-receipt.json'))
      .then(() => true, () => false)).toBe(false);
  });

  it('contains history ids instead of reading traversal targets', async () => {
    const dir = await project();
    const paths = runtimePaths(dir);
    await atomicWriteJson(path.join(paths.runtime, 'secret.json'), {
      run_id: 'secret-outside-history',
      objective: 'must not be disclosed',
    });

    const result = await historyAction(dir, 'query', { run_id: '../secret' });
    expect(result).toMatchObject({ ok: true, records: [] });
  });

  it('bounds unfiltered history scans', async () => {
    const dir = await project();
    const paths = runtimePaths(dir);
    await Promise.all(Array.from({ length: 300 }, (_, index) =>
      atomicWriteJson(path.join(paths.history, `run-${String(index).padStart(3, '0')}.json`), {
        run_id: `run-${index}`,
      })));

    const result = await historyAction(dir, 'query');
    expect(result.records.length).toBeLessThanOrEqual(256);
  });
});

describe('APE v2 serialized receipt effects', () => {
  it('preserves concurrent distinct receipts in one linear evidence chain', async () => {
    const dir = await project('ape-receipt-serialization-');
    const started = await startRun(dir, startInput({
      mode: 'phase',
      lane: 'full',
      behavioral: false,
      risk_triggers: ['security'],
    }));
    const planTicket = started.run.tickets[0];
    const planned = await recordReceipt(dir, passingReceipt(planTicket));
    expect(planned.ok).toBe(true);
    const parallelTickets = planned.run.tickets.filter(
      (ticket) => ticket.parallel_group === 'plan-review',
    );
    expect(parallelTickets).toHaveLength(2);

    const settled = await Promise.allSettled(
      parallelTickets.map((ticket) => recordReceipt(dir, passingReceipt(ticket))),
    );
    expect(settled.every(
      (result) => result.status === 'fulfilled' && result.value.ok,
    )).toBe(true);

    const state = (await statusRun(dir)).run;
    expect(state.receipts.map((receipt) => receipt.ticket_id)).toEqual(expect.arrayContaining([
      planTicket.ticket_id,
      ...parallelTickets.map((ticket) => ticket.ticket_id),
    ]));
    expect(state.receipts).toHaveLength(3);
    for (let index = 1; index < state.receipts.length; index += 1) {
      expect(state.receipts[index].previous_receipt_hash)
        .toBe(state.receipts[index - 1].receipt_hash);
    }
  });
});
