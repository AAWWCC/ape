import { execFileSync, spawn } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { evaluateStartBinding } from '../lib/runtime/hooks.js';

// start-binding-deadline: evaluateStartBinding — the stateless Codex
// SubagentStart binding validator — must refuse a binding whose ticket
// deadline_at has already elapsed, even when the scheduler has not yet moved
// the ticket into expired_tickets. This closes the acme PR #288 security-review
// parity gap with the Claude start handshake.
//
// Public contract under test:
//  - the validator grows an injectable clock:
//      evaluateStartBinding(state, event, at = Date.now())
//  - AFTER the existing 'not active and pending' deny, a finite
//    Date.parse(ticket.deadline_at ?? '') with deadline <= at (INCLUSIVE,
//    matching the scheduler's deadline-timeout predicate) denies with a
//    reason naming the elapsed deadline;
//  - the stateless validator allows an absent or unparseable deadline_at
//    (Number.isFinite guard), while persisted malformed timestamps fail at
//    the active-state reader before the hook can reach this validator;
//  - the sole caller in bin/ape-hook.mjs stays unedited on the default
//    clock, so the e2e arms exercise the seam end-to-end.
//
// Fixed far-past/far-future ISO constants keep the default-clock cases
// deterministic under the real clock; the exact-instant boundary case injects
// `at` so the inclusive <= comparison is pinned without touching real time.
// Deliberately NOT pinned: exact allow-reason strings, bin/ape-hook.mjs
// comment text, and anything in evaluateLifecyclePolicy.

const PAST_DEADLINE = '2001-01-01T00:00:00.000Z';
const FUTURE_DEADLINE = '2101-01-01T00:00:00.000Z';
const BOUNDARY_DEADLINE = '2050-06-15T12:00:00.000Z';

const unitTicket = (ticketId, deadlineAt) => ({
  ticket_id: ticketId,
  role: 'implementer',
  writable: true,
  claimed_paths: ['src'],
  test_paths: ['tests'],
  ...(deadlineAt === undefined ? {} : { deadline_at: deadlineAt }),
});

function unitState(tickets, overrides = {}) {
  return {
    run_id: 'run-1',
    status: 'running',
    tickets,
    expired_tickets: [],
    receipts: [],
    ...overrides,
  };
}

// The validator reads native identity from event.raw and the binding from
// event.ticket_id — the shape normalizeLifecycleEvent delivers for a codex
// SubagentStart carrying a binding payload.
const startEvent = (ticketId, raw = { agent_id: 'codex-agent-1', agent_type: 'worker' }) => ({
  host: 'codex',
  event: 'SubagentStart',
  ticket_id: ticketId,
  raw,
});

describe('APE v2 codex start-binding deadline (unit)', () => {
  // RED anchor R1: a ticket that is still formally pending (present in
  // state.tickets, not in expired_tickets, no receipt) but whose deadline_at
  // is already past must be denied. At base the validator never looks at
  // deadline_at and returns valid:true.
  it('denies a pending, unexpired, unreceipted ticket whose deadline_at is already past (R1)', () => {
    const state = unitState([unitTicket('run-1:build:ticket-past', PAST_DEADLINE)]);
    const result = evaluateStartBinding(state, startEvent('run-1:build:ticket-past'));
    expect(result.valid).toBe(false);
    expect(result.reason).toMatch(/deadline elapsed/);
  });

  // RED anchor R2: the comparison is inclusive (deadline <= at), matching the
  // scheduler's deadline-timeout predicate. At base the third argument is
  // ignored entirely, so the exact-instant deny arm is red.
  it('denies at exactly the deadline instant under an injected clock — inclusive <= (R2)', () => {
    const state = unitState([unitTicket('run-1:build:ticket-boundary', BOUNDARY_DEADLINE)]);
    const result = evaluateStartBinding(
      state,
      startEvent('run-1:build:ticket-boundary'),
      Date.parse(BOUNDARY_DEADLINE),
    );
    expect(result.valid).toBe(false);
    expect(result.reason).toMatch(/deadline elapsed/);
  });

  // R2 companion guardrail (green at base and after): one millisecond before
  // the deadline the binding is still valid.
  it('allows one millisecond before the deadline under an injected clock (R2 guard)', () => {
    const state = unitState([unitTicket('run-1:build:ticket-boundary', BOUNDARY_DEADLINE)]);
    const result = evaluateStartBinding(
      state,
      startEvent('run-1:build:ticket-boundary'),
      Date.parse(BOUNDARY_DEADLINE) - 1,
    );
    expect(result.valid).toBe(true);
  });

  // GREEN guardrail G1: a future deadline allows under the default clock —
  // the added check must not invert into a blanket deny.
  it('allows a pending ticket with a future deadline under the default clock (G1)', () => {
    const state = unitState([unitTicket('run-1:build:ticket-future', FUTURE_DEADLINE)]);
    const result = evaluateStartBinding(state, startEvent('run-1:build:ticket-future'));
    expect(result.valid).toBe(true);
  });

  // GREEN guardrail G2 (seam protector): no deadline_at at all still allows —
  // pins the Number.isFinite guard against expired()'s
  // unparseable-means-elapsed posture leaking in.
  it('still allows a ticket carrying no deadline_at at all (G2)', () => {
    const state = unitState([unitTicket('run-1:build:ticket-bare')]);
    const result = evaluateStartBinding(state, startEvent('run-1:build:ticket-bare'));
    expect(result.valid).toBe(true);
  });

  it('still allows a ticket whose deadline_at is unparseable (G2)', () => {
    const state = unitState([unitTicket('run-1:build:ticket-odd', 'not-a-date')]);
    const result = evaluateStartBinding(state, startEvent('run-1:build:ticket-odd'));
    expect(result.valid).toBe(true);
  });

  // GREEN guardrail G3: the existing denies are unchanged AND ordered — the
  // 'not active and pending' deny fires before any deadline reasoning, for
  // both future and already-elapsed deadlines.
  it.each([
    ['a future', FUTURE_DEADLINE],
    ['an elapsed', PAST_DEADLINE],
  ])('keeps the not-active-and-pending deny for an expired ticket with %s deadline (G3)', (_label, deadlineAt) => {
    const state = unitState([unitTicket('run-1:build:ticket-expired', deadlineAt)], {
      expired_tickets: ['run-1:build:ticket-expired'],
    });
    const result = evaluateStartBinding(state, startEvent('run-1:build:ticket-expired'));
    expect(result.valid).toBe(false);
    expect(result.reason).toMatch(/not active and pending/);
  });

  it.each([
    ['a future', FUTURE_DEADLINE],
    ['an elapsed', PAST_DEADLINE],
  ])('keeps the not-active-and-pending deny for a receipted ticket with %s deadline (G3)', (_label, deadlineAt) => {
    const state = unitState([unitTicket('run-1:build:ticket-receipted', deadlineAt)], {
      receipts: [{ ticket_id: 'run-1:build:ticket-receipted', status: 'passed' }],
    });
    const result = evaluateStartBinding(state, startEvent('run-1:build:ticket-receipted'));
    expect(result.valid).toBe(false);
    expect(result.reason).toMatch(/not active and pending/);
  });

  // GREEN guardrail G3: malformed native identity stays the FIRST deny, even
  // when the named ticket's deadline has elapsed.
  it('keeps the malformed-identity deny for a missing agent_id even when the deadline elapsed (G3)', () => {
    const state = unitState([unitTicket('run-1:build:ticket-past', PAST_DEADLINE)]);
    const result = evaluateStartBinding(
      state,
      startEvent('run-1:build:ticket-past', { agent_type: 'worker' }),
    );
    expect(result.valid).toBe(false);
    expect(result.reason).toMatch(/malformed native identity/);
  });

  it('keeps the malformed-identity deny for an oversized agent_type even when the deadline elapsed (G3)', () => {
    const state = unitState([unitTicket('run-1:build:ticket-past', PAST_DEADLINE)]);
    const result = evaluateStartBinding(
      state,
      startEvent('run-1:build:ticket-past', {
        agent_id: 'codex-agent-1',
        agent_type: 'x'.repeat(600),
      }),
    );
    expect(result.valid).toBe(false);
    expect(result.reason).toMatch(/malformed native identity/);
  });
});

// End-to-end against the SOURCE hook binary (bin/ape-hook.mjs), matching the
// codex-binding-seam suite: the sole caller stays unedited on the default
// clock, so these arms prove the deadline verdict actually reaches the host.
const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const hookBinary = path.join(root, 'bin', 'ape-hook.mjs');
const cleanups = [];

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function codexProject({ includeMalformedDeadline = false } = {}) {
  const dir = await mkdtemp(path.join(tmpdir(), 'ape-start-binding-deadline-'));
  cleanups.push(dir);
  await mkdir(path.join(dir, 'src'), { recursive: true });
  await writeFile(path.join(dir, 'src', 'value.js'), 'export const value = 1;\n');
  execFileSync('git', ['init', '-q'], { cwd: dir });
  execFileSync('git', ['config', 'user.email', 'ape@example.test'], { cwd: dir });
  execFileSync('git', ['config', 'user.name', 'APE Test'], { cwd: dir });
  execFileSync('git', ['add', '.'], { cwd: dir });
  execFileSync('git', ['commit', '-qm', 'baseline'], { cwd: dir });
  const baseTree = execFileSync('git', ['rev-parse', 'HEAD^{tree}'], {
    cwd: dir,
    encoding: 'utf8',
  }).trim();
  const ticket = (ticketId, deadlineAt) => ({
    ticket_id: ticketId,
    stage_id: 'build',
    role: 'implementer',
    writable: true,
    claimed_paths: ['src'],
    test_paths: ['tests'],
    base_tree_sha: baseTree,
    ...(deadlineAt === undefined ? {} : { deadline_at: deadlineAt }),
  });
  await mkdir(path.join(dir, '.ape', 'runtime'), { recursive: true });
  await writeFile(path.join(dir, '.ape', 'runtime', 'active.json'), JSON.stringify({
    run_id: 'run-1',
    status: 'running',
    tree_sha: baseTree,
    tickets: [
      ticket('run-1:build:ticket-past', PAST_DEADLINE),
      ticket('run-1:build:ticket-future', FUTURE_DEADLINE),
      ticket('run-1:build:ticket-bare'),
      ...(includeMalformedDeadline ? [ticket('run-1:build:ticket-odd', 'not-a-date')] : []),
      ticket('run-1:build:ticket-expired', FUTURE_DEADLINE),
      ticket('run-1:build:ticket-receipted', FUTURE_DEADLINE),
    ],
    expired_tickets: ['run-1:build:ticket-expired'],
    receipts: [{ ticket_id: 'run-1:build:ticket-receipted', status: 'passed' }],
  }));
  return dir;
}

// Codex host environment. APE_TICKET_ID is stripped alongside the host
// markers so an ambient export from whoever runs the suite cannot smuggle a
// second binding into the payload-bound cases.
function codexEnv(overrides = {}) {
  const env = { ...process.env };
  delete env.CLAUDECODE;
  delete env.CLAUDE_CODE;
  delete env.CLAUDE_PROJECT_DIR;
  delete env.CODEX_CWD;
  delete env.APE_TICKET_ID;
  return { ...env, ...overrides };
}

function invokeHook(input, env = codexEnv()) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [hookBinary], {
      cwd: root,
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code !== 0) reject(new Error(stderr));
      else resolve(JSON.parse(stdout));
    });
    child.stdin.end(`${JSON.stringify(input)}\n`);
  });
}

const subagentStart = (dir, ticketId) => ({
  hook_event_name: 'SubagentStart',
  project_dir: dir,
  agent_id: 'codex-agent-1',
  agent_type: 'worker',
  ticket_id: ticketId,
});

const startDenied = (response) => typeof response?.systemMessage === 'string';
const startReason = (response) => response?.systemMessage;

describe('APE v2 codex start-binding deadline (source hook binary)', () => {
  // RED anchor R3: a SubagentStart binding a pending ticket whose deadline
  // has elapsed must come back 'deny' through the unedited caller (base:
  // 'allow' — the validator never consults deadline_at).
  it('denies a SubagentStart binding a pending ticket whose deadline has elapsed (R3)', async () => {
    const dir = await codexProject();
    const response = await invokeHook(subagentStart(dir, 'run-1:build:ticket-past'));
    expect(startDenied(response)).toBe(true);
    expect(startReason(response)).toMatch(/deadline elapsed/);
  });

  // GREEN guardrail G1 (e2e): a future deadline allows through the unedited
  // bin/ape-hook.mjs caller under the default clock.
  it('allows a SubagentStart binding a pending ticket with a future deadline (G1)', async () => {
    const dir = await codexProject();
    const response = await invokeHook(subagentStart(dir, 'run-1:build:ticket-future'));
    expect(startDenied(response)).toBe(false);
  });

  // A missing legacy deadline remains compatible; malformed persisted
  // timestamps are corrupt active state and never enter the binding seam.
  it('keeps allowing a SubagentStart binding a pending ticket with no deadline_at (G2)', async () => {
    const dir = await codexProject();
    const response = await invokeHook(subagentStart(dir, 'run-1:build:ticket-bare'));
    expect(startDenied(response)).toBe(false);
  });

  it('fails closed before binding when persisted deadline_at is unparseable', async () => {
    const dir = await codexProject({ includeMalformedDeadline: true });
    const response = await invokeHook(subagentStart(dir, 'run-1:build:ticket-odd'));
    expect(response).toMatchObject({
      decision: 'block',
      reason: expect.stringMatching(/schema-invalid/u),
    });
  });

  // GREEN guardrail G3 (e2e): the existing pending-pool denies survive
  // unchanged for tickets whose deadlines have NOT elapsed.
  it('keeps the expired-ticket deny end-to-end even with a future deadline (G3)', async () => {
    const dir = await codexProject();
    const response = await invokeHook(subagentStart(dir, 'run-1:build:ticket-expired'));
    expect(startDenied(response)).toBe(true);
    expect(startReason(response)).toMatch(/not active and pending/);
  });

  it('keeps the receipted-ticket deny end-to-end even with a future deadline (G3)', async () => {
    const dir = await codexProject();
    const response = await invokeHook(subagentStart(dir, 'run-1:build:ticket-receipted'));
    expect(startDenied(response)).toBe(true);
    expect(startReason(response)).toMatch(/not active and pending/);
  });
});
