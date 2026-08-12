import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { recordReceipt, resumeRun, startRun } from '../lib/runtime/service.js';
import { runtimePaths } from '../lib/runtime/paths.js';
import { atomicWriteJson, readJson } from '../lib/runtime/storage.js';

// Once the deadline-timeout transition marks a ticket expired and issues a
// retry, the expired ticket is superseded: a late receipt for it must be
// rejected instead of advancing the pipeline in parallel with the retry
// (duplicate stage tickets, double progression). Deadline-aware admission
// (state.deadline_overruns) applies only while the runtime has not moved on.

const PAST = '2026-01-01T00:00:00.000Z';

const cleanups = [];
afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

function git(cwd, ...args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

async function project() {
  const dir = await mkdtemp(path.join(tmpdir(), 'ape-expired-receipt-'));
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
  });
  return dir;
}

function startInput() {
  return {
    objective: 'Exercise expired-ticket receipt rejection',
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
  };
}

function receipt(ticket) {
  return {
    ticket_id: ticket.ticket_id,
    status: 'passed',
    agent_identity: `agent-${ticket.role}`,
    tests: [{ command: 'node tests/value.test.js', passed: false, exit_code: 1, duration_ms: 1 }],
    findings: [],
    evidence: { verdict: 'pass' },
    timing: {
      started_at: ticket.issued_at,
      completed_at: new Date(Date.parse(ticket.issued_at) + 10).toISOString(),
      duration_ms: 10,
    },
  };
}

async function expireLatestTicket(dir) {
  const paths = runtimePaths(dir);
  const state = await readJson(paths.active, null);
  const ticket = state.tickets.at(-1);
  ticket.deadline_at = PAST;
  await atomicWriteJson(paths.active, state);
  return ticket;
}

describe('APE v2 late receipt for a deadline-expired, retried ticket', () => {
  it('rejects the expired ticket receipt so only the retry ticket owns the stage', async () => {
    const dir = await project();
    const started = await startRun(dir, startInput());
    expect(started.ok).toBe(true);
    const original = await expireLatestTicket(dir);

    // The timeout transition marks the original expired and issues the retry.
    const retried = await resumeRun(dir);
    expect(retried.ok).toBe(true);
    expect(retried.run.expired_tickets).toContain(original.ticket_id);

    // A still-bound subagent submits a passing, tree-consistent receipt for
    // the expired ticket after the retry was issued.
    await writeFile(path.join(dir, 'tests', 'value.test.js'), 'throw new Error("still red");\n');
    const late = await recordReceipt(dir, receipt(original));
    expect(late).toMatchObject({ ok: false, rejected: true });
    expect(late.errors.join(' ')).toMatch(/expired and was superseded/);

    // No durable side effect and no double progression: no receipt recorded,
    // no follow-on stage issued next to the pending retry ticket.
    const paths = runtimePaths(dir);
    const state = await readJson(paths.active, null);
    expect(state.receipts).toHaveLength(0);
    expect(state.tickets.map((ticket) => ticket.stage_id)).toEqual(['test', 'test']);
    expect(await readdir(paths.receipts).catch(() => [])).toHaveLength(0);
  });
});
