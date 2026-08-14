import * as fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { reduceRun } from '../lib/runtime/scheduler.js';
import {
  AUTO_MERGE_HOLD_REASON,
  MAX_REGATE_ATTEMPTS,
  MAX_REMEDIATION_CYCLES,
  MAX_STAGE_ATTEMPTS,
  TERMINAL_STATUSES,
} from '../lib/runtime/constants.js';

// Seeded-deterministic property suite over the pure scheduler reducer
// (reduceRun in lib/runtime/scheduler.js). The seed is pinned so any recorded
// failing run replays the failure exactly: re-run this file unchanged and
// fast-check regenerates the identical scripts.
//
// Three properties over generated event sequences:
//  - purity/replay determinism: reduceRun is a pure action-emitting function —
//    calling it twice on a deep-frozen state yields identical frozen action
//    lists and never mutates its input, and replaying the same generated
//    script from the same initial state reproduces the identical final model
//    state and action log;
//  - invariant 5: stage attempts never exceed MAX_STAGE_ATTEMPTS, each failed
//    stage is retried at most once, remediation cycles never exceed
//    MAX_REMEDIATION_CYCLES, review-group failures vote disagree instead of
//    consuming the stage retry, and capability / test-contradiction failures
//    skip the retry and block honestly;
//  - invariant 8: terminal states are absorbing — completed/aborted admit only
//    STATUS and the sanctioned OVERRIDE arms, and blocked exits only via
//    ABORT, a valid REGATE (stage 'gates', bounded attempts), or a valid SHIP
//    (stage 'merge' under the exact auto-merge hold reason).
const SEED = 20260721;

const TICKET_DEADLINE = '2026-07-21T12:00:00.000Z';
const BEFORE_DEADLINE = '2026-07-21T00:00:00.000Z';
const AFTER_DEADLINE = '2026-07-22T00:00:00.000Z';
const REVIEW_GROUPS = ['code-review', 'plan-review'];

function runTemplate(lane) {
  return {
    run_id: 'run-property',
    mode: 'phase',
    lane,
    status: 'starting',
    stage: 'start',
    behavioral: true,
    high_risk: false,
    policy: { high_risk_security_review: true },
    claimed_paths: ['src/example.js'],
    test_paths: ['tests/example.test.js'],
    risk_triggers: [],
    tickets: [],
    receipts: [],
    attempts: {},
    remediation_cycles: 0,
  };
}

function deepFreeze(value) {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const key of Object.keys(value)) deepFreeze(value[key]);
  }
  return value;
}

// The event convention observed at the service boundary: the recorded receipt
// is already part of the state the reducer sees, and the same state rides as
// event.next_state alongside the ticket's stage projection.
function stageOfTicket(ticket) {
  return {
    id: ticket.stage_id,
    role: ticket.role,
    model_tier: ticket.model_tier ?? 'balanced',
    writable: ticket.writable ?? false,
    parallel_group: ticket.parallel_group ?? null,
    required_checks: ticket.required_checks ?? [],
  };
}

function firstPending(state) {
  if (!state || !Array.isArray(state.tickets)) return null;
  const expired = new Set(state.expired_tickets ?? []);
  return (
    state.tickets.find(
      (ticket) =>
        !expired.has(ticket.ticket_id) &&
        !state.receipts.some((receipt) => receipt.ticket_id === ticket.ticket_id),
    ) ?? null
  );
}

function receiptFor(ticket, command) {
  if (command === 'pass') {
    return {
      ticket_id: ticket.ticket_id,
      status: 'passed',
      evidence: { verdict: 'pass', summary: 'generated pass' },
    };
  }
  if (command === 'fail-capability') {
    return {
      ticket_id: ticket.ticket_id,
      status: 'failed',
      evidence: { failure_kind: 'capability', summary: 'APE write denied: generated capability fault' },
    };
  }
  if (command === 'fail-contradiction') {
    return {
      ticket_id: ticket.ticket_id,
      status: 'failed',
      evidence: { failure_kind: 'test-contradiction', summary: 'generated contradictory authored test claim' },
    };
  }
  return {
    ticket_id: ticket.ticket_id,
    status: 'failed',
    evidence: { verdict: 'fail', summary: 'generated stage failure' },
  };
}

function buildStep(model, command, lane) {
  const state = model.state;
  const pending = firstPending(state);
  switch (command) {
    case 'start':
      return { reduceState: state, event: { type: 'START', run: runTemplate(lane) } };
    case 'pass':
    case 'fail':
    case 'fail-capability':
    case 'fail-contradiction': {
      if (!state || !pending) return { reduceState: state, event: { type: 'STATUS' } };
      const receipt = receiptFor(pending, command);
      const reduceState = { ...state, receipts: [...state.receipts, receipt] };
      return {
        reduceState,
        event: {
          type: 'RECEIPT_RECORDED',
          ticket: pending,
          receipt,
          stage: stageOfTicket(pending),
          next_state: reduceState,
        },
      };
    }
    case 'expire':
      return { reduceState: state, event: { type: 'NEXT', at: AFTER_DEADLINE } };
    case 'next':
      return { reduceState: state, event: { type: 'NEXT', at: BEFORE_DEADLINE } };
    case 'gates-pass':
      return { reduceState: state, event: { type: 'GATES_PASSED' } };
    case 'gates-fail':
      return { reduceState: state, event: { type: 'GATES_FAILED', reason: 'generated gate failure' } };
    case 'merged':
      return { reduceState: state, event: { type: 'MERGED', merge: { merged: true } } };
    case 'regate':
      return { reduceState: state, event: { type: 'REGATE' } };
    case 'ship':
      return { reduceState: state, event: { type: 'SHIP', reason: 'generated ship' } };
    case 'abort':
      return { reduceState: state, event: { type: 'ABORT', reason: 'generated abort' } };
    case 'override-reset':
      return { reduceState: state, event: { type: 'OVERRIDE', operation: 'reset', reason: 'generated reset' } };
    case 'override-abort':
      return { reduceState: state, event: { type: 'OVERRIDE', operation: 'abort', reason: 'generated abort' } };
    case 'scope':
      return {
        reduceState: state,
        event: { type: 'SCOPE_EXPANDED', scope: { risk_triggers: ['security'], reason: 'generated scope' } },
      };
    case 'expire-dispatch':
      return {
        reduceState: state,
        event: {
          type: 'EXPIRE_DISPATCH',
          ticket_id: pending?.ticket_id ?? 'T-unknown',
          reason: 'generated dispatch expiry',
        },
      };
    default:
      return { reduceState: state, event: { type: 'STATUS' } };
  }
}

// Test-local applier that closes the reducer loop: reduceRun only EMITS
// actions, so replay determinism is judged over a deterministic model of the
// state-affecting actions (transition patches, issued tickets, overrides).
function applyModelActions(model, actions) {
  for (const entry of actions) {
    if (entry.type === 'transition') {
      model.state = { ...model.state, ...entry.patch };
    } else if (entry.type === 'issue_ticket') {
      model.counter += 1;
      model.state = {
        ...model.state,
        tickets: [
          ...model.state.tickets,
          {
            ticket_id: `T${model.counter}`,
            stage_id: entry.stage.id,
            role: entry.stage.role,
            model_tier: entry.stage.model_tier,
            writable: entry.stage.writable,
            parallel_group: entry.stage.parallel_group ?? null,
            required_checks: entry.stage.required_checks ?? [],
            deadline_at: TICKET_DEADLINE,
            ...(entry.retry_of ? { retry_of: entry.retry_of } : {}),
            ...(entry.review_findings ? { review_findings: entry.review_findings } : {}),
          },
        ],
      };
    } else if (entry.type === 'apply_override') {
      model.state =
        entry.operation === 'reset' ? null : { ...model.state, status: 'aborted', stage: 'aborted' };
    }
  }
}

function checkStepInvariants(state, actions, tracker, context) {
  const { before, attemptsBefore, event, command } = context;
  // Invariant 5: a block never respawns work in the same reduction.
  if (actions.some((entry) => entry.type === 'transition' && entry.patch?.status === 'blocked')) {
    expect(
      actions.some((entry) => entry.type === 'issue_ticket'),
      'a reduction that blocks the run must not issue further tickets',
    ).toBe(false);
  }
  // Invariant 5: at most one retry ticket per stage per run generation.
  for (const entry of actions) {
    if (entry.type === 'issue_ticket' && entry.retry_of) {
      const count = (tracker.retries.get(entry.stage.id) ?? 0) + 1;
      tracker.retries.set(entry.stage.id, count);
      expect(count, `stage ${entry.stage.id} was retried more than once`).toBeLessThanOrEqual(1);
    }
  }
  if (state && typeof state === 'object') {
    for (const [stageId, attempts] of Object.entries(state.attempts ?? {})) {
      expect(attempts, `attempts for stage ${stageId} exceeded MAX_STAGE_ATTEMPTS`).toBeLessThanOrEqual(
        MAX_STAGE_ATTEMPTS,
      );
    }
    expect(state.remediation_cycles ?? 0).toBeLessThanOrEqual(MAX_REMEDIATION_CYCLES);
  }
  // Review-group failures vote disagree; they never consume the stage retry.
  if (
    event.type === 'RECEIPT_RECORDED' &&
    event.receipt.status !== 'passed' &&
    REVIEW_GROUPS.includes(event.stage.parallel_group) &&
    before &&
    !TERMINAL_STATUSES.has(before.status)
  ) {
    expect(
      actions.some((entry) => entry.type === 'issue_ticket' && entry.retry_of),
      'a failed review-group receipt must vote disagree, never consume the verbatim stage retry',
    ).toBe(false);
    if (state) {
      expect(state.attempts?.[event.stage.id] ?? 1).toBe(attemptsBefore[event.stage.id] ?? 1);
    }
  }
  // Capability / test-contradiction failures on a non-review stage skip the
  // provably futile retry and block honestly.
  if (
    event.type === 'RECEIPT_RECORDED' &&
    event.receipt.status !== 'passed' &&
    !REVIEW_GROUPS.includes(event.stage.parallel_group) &&
    ['capability', 'test-contradiction'].includes(event.receipt.evidence?.failure_kind) &&
    before &&
    !TERMINAL_STATUSES.has(before.status)
  ) {
    expect(actions.some((entry) => entry.type === 'issue_ticket')).toBe(false);
    const transition = actions.find((entry) => entry.type === 'transition');
    expect(transition?.patch?.status).toBe('blocked');
    expect(transition?.patch?.block_reason).toMatch(/capability-blocked|test-contradiction-blocked/);
  }
  // Deadline-expiry consumes the same bounded attempt budget as a failure.
  if (
    (command === 'expire' || command === 'expire-dispatch') &&
    before &&
    before.status === 'running'
  ) {
    const pending = firstPending(before);
    if (pending) {
      const priorAttempts = attemptsBefore[pending.stage_id] ?? 1;
      const transition = actions.find((entry) => entry.type === 'transition');
      expect(transition?.patch?.expired_tickets ?? []).toContain(pending.ticket_id);
      if (priorAttempts < MAX_STAGE_ATTEMPTS) {
        expect(transition?.patch?.attempts?.[pending.stage_id]).toBe(priorAttempts + 1);
        const retry = actions.find(
          (entry) => entry.type === 'issue_ticket' && entry.retry_of === pending.ticket_id,
        );
        expect(retry?.stage?.id).toBe(pending.stage_id);
      } else {
        expect(actions.some((entry) => entry.type === 'issue_ticket')).toBe(false);
        expect(transition?.patch?.status).toBe('blocked');
      }
    }
  }
}

function executeScript(lane, commands) {
  const model = { state: null, counter: 0 };
  const log = [];
  const tracker = { retries: new Map() };
  for (const command of ['start', ...commands]) {
    const before = model.state;
    const attemptsBefore = { ...(before?.attempts ?? {}) };
    const { reduceState, event } = buildStep(model, command, lane);
    const frozen = deepFreeze(reduceState);
    const snapshot = frozen === null ? 'null' : JSON.stringify(frozen);
    const actions = reduceRun(frozen, event);
    // Purity: a second call on the same frozen input yields the identical
    // action list and the input state is never mutated.
    expect(reduceRun(frozen, event)).toEqual(actions);
    expect(frozen === null ? 'null' : JSON.stringify(frozen)).toBe(snapshot);
    log.push(actions);
    const rejected = actions.some((entry) => entry.type === 'reject');
    if (!rejected) {
      if (event.type === 'START') {
        model.state = event.run;
        tracker.retries = new Map();
      } else if (reduceState !== before) {
        // The recorded receipt becomes part of the committed state, exactly as
        // the service records it before reducing.
        model.state = reduceState;
      }
      applyModelActions(model, actions);
      if (model.state === null) tracker.retries = new Map();
    }
    checkStepInvariants(model.state, actions, tracker, { before, attemptsBefore, event, command });
  }
  return { state: model.state, log };
}

const FULL_POOL = [
  'start',
  'pass',
  'fail',
  'fail-capability',
  'fail-contradiction',
  'expire',
  'next',
  'gates-pass',
  'gates-fail',
  'merged',
  'regate',
  'ship',
  'abort',
  'override-reset',
  'override-abort',
  'scope',
  'status',
  'expire-dispatch',
];

// Duplicated entries bias generation toward the failure arms so the bounded
// retry/remediation/expiry machinery is actually exercised.
const FAIL_HEAVY_POOL = [
  'fail',
  'fail',
  'fail',
  'expire',
  'expire',
  'pass',
  'pass',
  'fail-capability',
  'fail-contradiction',
  'next',
  'gates-fail',
  'regate',
  'expire-dispatch',
  'scope',
];

const scriptArb = fc.record({
  lane: fc.constantFrom('fast', 'full'),
  commands: fc.array(fc.constantFrom(...FULL_POOL), { minLength: 1, maxLength: 12 }),
});

const failHeavyScriptArb = fc.record({
  lane: fc.constantFrom('fast', 'full'),
  commands: fc.array(fc.constantFrom(...FAIL_HEAVY_POOL), { minLength: 2, maxLength: 12 }),
});

describe('APE v2 scheduler reducer properties (seeded, deterministic replay)', () => {
  it('replay determinism: the identical generated event script reduces to the identical state and action log', () => {
    fc.assert(
      fc.property(scriptArb, ({ lane, commands }) => {
        const first = executeScript(lane, commands);
        const second = executeScript(lane, commands);
        expect(JSON.stringify(second.state)).toBe(JSON.stringify(first.state));
        expect(JSON.stringify(second.log)).toBe(JSON.stringify(first.log));
      }),
      { seed: SEED, numRuns: 120, verbose: 2 },
    );
  });

  it('invariant 5: attempts, retries, remediation cycles, and expiry stay bounded under fail-heavy scripts', () => {
    fc.assert(
      fc.property(failHeavyScriptArb, ({ lane, commands }) => {
        executeScript(lane, commands);
      }),
      { seed: SEED, numRuns: 150, verbose: 2 },
    );
  });
});

// --- invariant 8: terminal states are absorbing ---------------------------

const terminalStateArb = fc
  .record({
    status: fc.constantFrom('completed', 'aborted', 'blocked'),
    stage: fc.constantFrom('gates', 'merge', 'test', 'remediation', 'complete'),
    block_reason: fc.constantFrom(
      AUTO_MERGE_HOLD_REASON,
      'merge gates failed',
      'stage test failed twice: attempt 1: generated',
    ),
    regate_attempts: fc.integer({ min: 0, max: MAX_REGATE_ATTEMPTS + 1 }),
  })
  .map(({ status, stage, block_reason, regate_attempts }) => ({
    ...runTemplate('fast'),
    status,
    stage,
    block_reason,
    regate_attempts,
  }));

const TERMINAL_EVENTS = [
  { type: 'NEXT', at: BEFORE_DEADLINE },
  { type: 'NEXT', at: AFTER_DEADLINE },
  {
    type: 'RECEIPT_RECORDED',
    ticket: { ticket_id: 'T-terminal', stage_id: 'test' },
    receipt: { ticket_id: 'T-terminal', status: 'passed', evidence: { verdict: 'pass' } },
    stage: { id: 'test', role: 'test_writer', parallel_group: null, required_checks: [] },
  },
  { type: 'GATES_PASSED' },
  { type: 'GATES_FAILED', reason: 'generated' },
  { type: 'MERGED', merge: { merged: true } },
  { type: 'REGATE' },
  { type: 'SHIP', reason: 'generated ship' },
  { type: 'ABORT', reason: 'generated abort' },
  { type: 'OVERRIDE', operation: 'reset', reason: 'generated' },
  { type: 'OVERRIDE', operation: 'abort', reason: 'generated' },
  { type: 'OVERRIDE', operation: 'noop', reason: 'generated' },
  { type: 'STATUS' },
  { type: 'SCOPE_EXPANDED', scope: { risk_triggers: ['security'], reason: 'generated' } },
  { type: 'EXPIRE_DISPATCH', ticket_id: 'T-terminal', reason: 'generated' },
  { type: 'START', run: runTemplate('fast') },
  { type: 'UNKNOWN_EVENT' },
];

// Encodes the sanctioned carve-outs EXACTLY: completed/aborted admit only
// STATUS and OVERRIDE (reset always erases; abort applies only to a
// non-completed run); blocked additionally admits ABORT, a valid REGATE, and
// a valid SHIP. A blanket "reject everything on terminal" claim would be red
// against correct code — these arms are the sanctioned exits.
function assertTerminalAbsorbing(state, event, actions) {
  const allowed =
    state.status === 'blocked' ? ['STATUS', 'OVERRIDE', 'ABORT', 'REGATE', 'SHIP'] : ['STATUS', 'OVERRIDE'];
  if (!allowed.includes(event.type)) {
    expect(actions).toEqual([{ type: 'reject', reason: `run is ${state.status}` }]);
    return;
  }
  if (state.status !== 'blocked') {
    // Sealed runs: no transition action may ever move them; the only exits go
    // through the audited apply_override arms below.
    expect(actions.some((entry) => entry.type === 'transition')).toBe(false);
  }
  switch (event.type) {
    case 'STATUS':
      expect(actions).toEqual([{ type: 'status', state }]);
      break;
    case 'OVERRIDE': {
      if (event.operation === 'reset') {
        expect(actions.map((entry) => entry.type)).toEqual([
          'audit_override',
          'archive_history',
          'apply_override',
        ]);
        expect(actions[2].operation).toBe('reset');
      } else if (event.operation === 'abort') {
        if (state.status === 'completed') {
          expect(actions).toHaveLength(1);
          expect(actions[0].type).toBe('reject');
          expect(actions[0].reason).toMatch(/completed run cannot be overridden to aborted/);
        } else {
          expect(actions.map((entry) => entry.type)).toEqual([
            'audit_override',
            'apply_override',
            'archive_history',
            'release_lock',
            'persist_state',
          ]);
          expect(actions[1].operation).toBe('abort');
        }
      } else {
        expect(actions).toHaveLength(1);
        expect(actions[0].type).toBe('reject');
        expect(actions[0].reason).toMatch(/must be 'abort' or 'reset'/);
      }
      break;
    }
    case 'ABORT': {
      // Reachable only for blocked (the guard filtered completed/aborted).
      const transition = actions.find((entry) => entry.type === 'transition');
      expect(transition?.patch?.status).toBe('aborted');
      expect(actions.some((entry) => entry.type === 'issue_ticket')).toBe(false);
      break;
    }
    case 'REGATE': {
      const valid = state.stage === 'gates' && (state.regate_attempts ?? 0) < MAX_REGATE_ATTEMPTS;
      if (!valid) {
        expect(actions).toHaveLength(1);
        expect(actions[0].type).toBe('reject');
      } else {
        const transition = actions.find((entry) => entry.type === 'transition');
        expect(transition?.patch?.status).toBe('running');
        expect(transition?.patch?.regate_attempts).toBe((state.regate_attempts ?? 0) + 1);
        expect(transition?.patch?.regate_attempts).toBeLessThanOrEqual(MAX_REGATE_ATTEMPTS);
        expect(actions.some((entry) => entry.type === 'run_gates')).toBe(true);
      }
      break;
    }
    case 'SHIP': {
      const valid = state.stage === 'merge' && state.block_reason === AUTO_MERGE_HOLD_REASON;
      if (!valid) {
        expect(actions).toHaveLength(1);
        expect(actions[0].type).toBe('reject');
      } else {
        const transition = actions.find((entry) => entry.type === 'transition');
        expect(transition?.patch?.status).toBe('running');
        expect(transition?.patch?.ship_requested).toBe(true);
        expect(actions.some((entry) => entry.type === 'audit_override')).toBe(true);
        expect(actions.some((entry) => entry.type === 'run_gates')).toBe(true);
      }
      break;
    }
    default:
      throw new Error(`unreachable allowed event ${event.type}`);
  }
}

describe('APE v2 scheduler reducer terminal absorption (invariant 8, seeded)', () => {
  it('terminal states admit only the sanctioned recovery arms; every other event rejects', () => {
    fc.assert(
      fc.property(terminalStateArb, fc.constantFrom(...TERMINAL_EVENTS), (rawState, event) => {
        const state = deepFreeze(rawState);
        const actions = reduceRun(state, event);
        // Purity holds on terminal states too.
        expect(reduceRun(state, event)).toEqual(actions);
        assertTerminalAbsorbing(state, event, actions);
      }),
      { seed: SEED, numRuns: 400, verbose: 2 },
    );
  });
});
