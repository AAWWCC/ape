import { describe, expect, it } from 'vitest';
import { classifyLane, escalateLane } from '../lib/runtime/lane-policy.js';
import { reduceRun } from '../lib/runtime/scheduler.js';
import { finalizeReceipt, finalizeTicket, validateReceipt, validateTicket } from '../lib/runtime/schemas.js';

const sha40 = 'a'.repeat(40);
const sha64 = 'b'.repeat(64);

function run(overrides = {}) {
  return {
    run_id: 'run-1',
    mode: 'phase',
    lane: 'fast',
    status: 'running',
    stage: 'dispatch',
    tickets: [],
    receipts: [],
    attempts: {},
    remediation_cycles: 0,
    high_risk: false,
    ...overrides,
  };
}

describe('APE v2 lane policy', () => {
  it('classifies mechanical, fast behavioral, and risk-triggered full lanes', () => {
    expect(classifyLane({
      requested_lane: 'auto',
      behavioral: false,
      claimed_paths: ['docs/guide.md'],
      risk_triggers: [],
    }).lane).toBe('mechanical');
    expect(classifyLane({
      requested_lane: 'fast',
      behavioral: true,
      claimed_paths: ['src/a.js', 'src/b.js'],
      risk_triggers: [],
    }).lane).toBe('fast');
    expect(classifyLane({
      requested_lane: 'fast',
      behavioral: true,
      claimed_paths: ['src/auth.js'],
      risk_triggers: ['authentication'],
    }).lane).toBe('full');
  });

  it('escalates but never downgrades', () => {
    expect(escalateLane('fast', {
      behavioral: true,
      claimed_paths: Array.from({ length: 7 }, (_, index) => `src/${index}.js`),
      risk_triggers: [],
    }).lane).toBe('full');
    expect(escalateLane('full', {
      behavioral: false,
      claimed_paths: ['README.md'],
      risk_triggers: [],
    })).toMatchObject({ lane: 'full', escalated: false });
  });
});

describe('APE v2 scheduler reducer', () => {
  it('starts fast behavioral work with only the test writer', () => {
    const actions = reduceRun(null, { type: 'START', run: run() });
    expect(actions.map((entry) => entry.type)).toEqual([
      'acquire_lock',
      'transition',
      'issue_ticket',
      'persist_state',
    ]);
    expect(actions[2].stage.role).toBe('test_writer');
  });

  it('starts full planning with one writer before checker and critic', () => {
    const actions = reduceRun(null, { type: 'START', run: run({ lane: 'full' }) });
    expect(actions.filter((entry) => entry.type === 'issue_ticket')).toHaveLength(1);
    expect(actions[2].stage.role).toBe('planner');
  });

  it('retries one failed stage once and blocks the next failure', () => {
    const state = run({
      attempts: { build: 1 },
      tickets: [{ ticket_id: 't1', stage_id: 'build' }],
    });
    const stage = { id: 'build', role: 'implementer', parallel_group: null };
    const retry = reduceRun(state, {
      type: 'RECEIPT_RECORDED',
      ticket: state.tickets[0],
      receipt: { status: 'failed' },
      stage,
    });
    expect(retry.some((entry) => entry.type === 'issue_ticket')).toBe(true);

    const blocked = reduceRun({ ...state, attempts: { build: 2 } }, {
      type: 'RECEIPT_RECORDED',
      ticket: state.tickets[0],
      receipt: { status: 'failed' },
      stage,
    });
    expect(blocked.find((entry) => entry.type === 'transition').patch.status).toBe('blocked');
  });
});

describe('APE v2 scheduler shipping-watch poll arm (NEXT)', () => {
  // A run resting in the non-blocking shipping watch: phase 1 pushed and created
  // the PR, persisted a shipping_watch progress block, and left the run in the
  // 'shipping' status. NEXT is now a single bounded remote-checks poll, not the
  // idle status echo.
  function shippingWatch(overrides = {}) {
    return {
      provider: 'github',
      pr_url: 'https://github.com/acme/repo/pull/9',
      branch: 'feat/thing',
      base: 'main',
      head_oid: 'c'.repeat(40),
      created_at: '2026-07-14T00:00:00.000Z',
      last_poll_at: null,
      poll_count: 0,
      last_checks_summary: null,
      ...overrides,
    };
  }

  it('reduces NEXT on a resting shipping state carrying a watch block to a single poll action', () => {
    const actions = reduceRun(
      run({ status: 'shipping', stage: 'merge', shipping_watch: shippingWatch() }),
      { type: 'NEXT', at: '2026-07-14T01:00:00.000Z' },
    );
    expect(actions.map((entry) => entry.type)).toEqual(['poll_shipping']);
  });

  it('falls back to the status action for a shipping state with no watch block', () => {
    const actions = reduceRun(
      run({ status: 'shipping', stage: 'merge' }),
      { type: 'NEXT', at: '2026-07-14T01:00:00.000Z' },
    );
    expect(actions.map((entry) => entry.type)).toEqual(['status']);
  });
});

describe('APE v2 ticket and receipt schemas', () => {
  it('detects stale or tampered hashes', () => {
    const ticket = finalizeTicket({
      schema_version: '2.0.0',
      ticket_id: 'ticket-1',
      run_id: 'run-1',
      stage_id: 'review',
      parallel_group: null,
      role: 'reviewer',
      objective: 'Review',
      claimed_paths: ['src/a.js'],
      test_paths: [],
      model_tier: 'deep',
      model: { model: 'gpt-5.5', reasoning_effort: 'high' },
      deadline_at: '2026-01-01T00:00:00.000Z',
      output_schema: { type: 'object' },
      required_checks: [],
      parent_hash: null,
      base_tree_sha: sha40,
      attempt: 1,
      writable: false,
      issued_at: '2026-01-01T00:00:00.000Z',
    });
    expect(validateTicket(ticket).valid).toBe(true);
    expect(validateTicket({ ...ticket, objective: 'Tampered' }).valid).toBe(false);

    const receipt = finalizeReceipt({
      schema_version: '2.0.0',
      receipt_id: 'receipt-1',
      run_id: 'run-1',
      ticket_id: 'ticket-1',
      ticket_hash: ticket.ticket_hash,
      agent: { host: 'codex', role: 'reviewer', identity: 'agent-1', model: 'gpt-5.5' },
      status: 'passed',
      base_tree_sha: sha40,
      head_tree_sha: sha40,
      changed_files: [],
      tests: [],
      findings: [],
      evidence: { verdict: 'pass' },
      timing: {
        started_at: '2026-01-01T00:00:00.000Z',
        completed_at: '2026-01-01T00:00:01.000Z',
        duration_ms: 1000,
      },
      previous_receipt_hash: null,
    });
    expect(validateReceipt(receipt).valid).toBe(true);
    expect(validateReceipt({ ...receipt, previous_receipt_hash: sha64 }).valid).toBe(false);
  });
});
