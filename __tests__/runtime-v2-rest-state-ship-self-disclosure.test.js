import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { reduceRun } from '../lib/runtime/scheduler.js';
import { AUTO_MERGE_HOLD_REASON } from '../lib/runtime/constants.js';
import { runtimePaths } from '../lib/runtime/paths.js';
import { atomicWriteJson, readJson } from '../lib/runtime/storage.js';
import * as service from '../lib/runtime/service.js';

// Ticket objective (defect (1) of the run this stage serves): a SHIP re-issued
// while the run already RESTS in the non-blocking 'shipping' watch — reached
// exactly when the caller's OWN prior SHIP succeeded (it set ship_requested,
// re-ran the gates, and GATES_PASSED rested the run here) — still leads its
// refusal with "ship is valid only for a run held at merge by disabled
// auto-merge (shipping.auto_merge)". That reads as "your ship did nothing",
// even though the exact behavioral consequence in the motivating case is that
// the first ship already succeeded and is progressing correctly. An operator
// who trusts that prose may take further, unneeded recovery action against a
// run that needs none.
//
// state.ship_requested is the state-alone signal that distinguishes the two
// cases: SHIP sets it (scheduler.js, SHIP arm), only GATES_FAILED clears it,
// and MERGED retains it as a spent marker — so a 'shipping' rest state with
// ship_requested still true can ONLY be explained by the caller's own prior
// ship, never by the ordinary (never-shipped) auto-merge path. The fix this
// stage's tests pin down: the refusal must attribute the rest state to that
// prior ship, derived from state alone (the reducer stays PURE — no clock
// reads, no I/O), and must NOT lead with the prose that reads as a no-op. The
// existing rest-state guidance contract (naming the watch, pointing at
// `ape_run next`, and recommending neither OVERRIDE nor ABORT) must survive
// unchanged — __tests__/runtime-v2-rest-state-lever-guidance.test.js already
// pins that contract in full and stays untouched by this ticket.

const PR_URL = 'https://github.com/acme/repo/pull/99';
const CHECKS_SUMMARY = '1 of 2 required checks still pending';
const GATE_SUMMARY = 'full_suite still running after 40s';

const cleanups = [];
afterEach(async () => {
  await Promise.all(
    cleanups
      .splice(0)
      .map((dir) => rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })),
  );
});

// A live, non-sealed run whose single build receipt is attested — the same
// minimal shape the existing rest-state-lever-guidance suite loads.
function baseRun(overrides = {}) {
  return {
    version: 2,
    schema_version: '2.0.0',
    run_id: 'run-rest-state-ship-disclosure',
    objective: 'Ship the value bump',
    mode: 'phase',
    lane: 'mechanical',
    requested_lane: 'mechanical',
    lane_reasons: [],
    lane_escalated: false,
    behavioral: false,
    high_risk: false,
    policy: { high_risk_security_review: true },
    host: 'codex',
    claimed_paths: ['src/value.js'],
    test_paths: [],
    requirements: ['R-rest-disclosure'],
    risk_triggers: [],
    branch: 'ape/phase-rest-disclosure',
    base_commit_sha: 'a'.repeat(40),
    tree_sha: 'b'.repeat(40),
    tickets: [],
    receipts: [{
      receipt_hash: 'a',
      previous_receipt_hash: null,
      status: 'passed',
      agent: { host: 'codex', role: 'implementer' },
      tests: [{ passed: true }],
      changed_files: ['src/value.js'],
      head_tree_sha: 'b'.repeat(40),
    }],
    attempts: {},
    remediation_cycles: 0,
    regate_attempts: 0,
    timing: { test_ms: 2_000, remote_ci_ms: 0 },
    created_at: '2026-07-01T00:00:00.000Z',
    updated_at: '2026-07-01T00:00:00.000Z',
    ...overrides,
  };
}

// A run resting in the non-blocking SHIPPING watch: phase 1 pushed the branch
// and opened the PR, required remote checks are mid-flight, the run lock is
// still held, block_reason is null, and no MERGED transition or archive
// happened. `overrides.ship_requested` selects the case this ticket is about:
// true is reachable ONLY through the caller's own prior SHIP (the SHIP arm is
// the sole place that ever sets it); omitted/false is the ordinary path a
// green run reaches on its first, uninterrupted evaluation.
function restingShipping(overrides = {}, watchOverrides = {}) {
  return baseRun({
    status: 'shipping',
    stage: 'merge',
    block_reason: null,
    gates: { passed: true, tree_sha: 'b'.repeat(40) },
    shipping_watch: {
      provider: 'github',
      pr_url: PR_URL,
      branch: 'ape/phase-rest-disclosure',
      base: 'main',
      head_oid: 'c'.repeat(40),
      created_at: '2026-07-30T00:00:00.000Z',
      last_poll_at: '2026-07-30T00:01:00.000Z',
      poll_count: 2,
      last_checks_summary: CHECKS_SUMMARY,
      ...watchOverrides,
    },
    ...overrides,
  });
}

// A run resting in the non-blocking GATING watch: the full merge-gate suite
// runs in a detached runner, the run lock is still held, block_reason is
// null, and no GATES_PASSED/GATES_FAILED transition has fired — the suite is
// STILL RUNNING (reached whenever a detached suite outlives
// gates.inline_grace_ms). `overrides.ship_requested` selects the case this
// ticket's defect (1) is about: true is reachable ONLY through the caller's
// own prior SHIP (the SHIP arm is the sole place that ever sets it, and only
// GATES_FAILED — which this rest state has by definition not yet reached —
// ever clears it); omitted/false is the ordinary path a run reaches on its
// first, uninterrupted gate evaluation.
function restingGating(overrides = {}, watchOverrides = {}) {
  return baseRun({
    status: 'gating',
    stage: 'gates',
    block_reason: null,
    gates_watch: {
      pid: 424_242,
      started_at: '2026-07-30T00:00:00.000Z',
      spawn_attempts: 1,
      poll_count: 3,
      last_poll_at: '2026-07-30T00:01:00.000Z',
      last_summary: GATE_SUMMARY,
      ...watchOverrides,
    },
    ...overrides,
  });
}

// A run genuinely HELD at merge by disabled auto-merge — the one state SHIP
// recovers, used only to pin the premise that SHIP itself sets ship_requested.
function autoMergeHold(overrides = {}) {
  return baseRun({
    status: 'blocked',
    stage: 'merge',
    block_reason: AUTO_MERGE_HOLD_REASON,
    gates: { passed: true, tree_sha: 'b'.repeat(40) },
    terminal_at: '2026-07-01T00:00:00.000Z',
    ...overrides,
  });
}

function typesOf(actions) {
  return actions.map((action) => action.type);
}

function rejectOf(actions) {
  const reject = actions.find((action) => action.type === 'reject');
  expect(reject, 'the lever must still be REFUSED from a rest state').toBeDefined();
  return reject;
}

// The rest-state guidance contract acme PR #377 already established and this
// ticket must not weaken: names the watch, points at ape_run next, and steers
// nobody at a run-destroying recovery.
function expectSafeRestRefusal(reason) {
  expect(typeof reason).toBe('string');
  expect(reason, 'must point the caller at ape_run next').toMatch(/ape_run next/);
  expect(reason, 'must not recommend the audited OVERRIDE lever').not.toMatch(/OVERRIDE/);
  expect(reason, 'must not recommend ABORT').not.toMatch(/ABORT/);
  expect(reason, 'must not recommend an override reset').not.toMatch(/override reset/i);
  expect(reason).not.toMatch(/\b(?:null|undefined)\b/);
}

function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const inner of Object.values(value)) deepFreeze(inner);
  }
  return value;
}

describe('ship self-disclosure — premise re-verified against the tree', () => {
  it('SHIP sets ship_requested true on the run it recovers from an auto-merge hold', () => {
    const actions = reduceRun(autoMergeHold(), { type: 'SHIP', reason: 'operator authorized' });
    expect(typesOf(actions)).not.toContain('reject');
    const transition = actions.find((action) => action.type === 'transition');
    expect(transition, 'a valid ship must transition state').toBeDefined();
    expect(transition.patch.ship_requested).toBe(true);
  });

  it('GATES_PASSED rests a run in the shipping watch without touching ship_requested', () => {
    const shipped = baseRun({ status: 'running', stage: 'gates', ship_requested: true });
    const actions = reduceRun(shipped, { type: 'GATES_PASSED' });
    const transition = actions.find((action) => action.type === 'transition');
    expect(transition.patch.status).toBe('shipping');
    expect(transition.patch).not.toHaveProperty('ship_requested');
  });
});

describe('ship refused from the shipping rest state — attributing the state to the caller\'s own prior ship', () => {
  it('does not lead with the "ship is valid only for..." prose that reads as the ship having done nothing', () => {
    const reject = rejectOf(reduceRun(
      restingShipping({ ship_requested: true }),
      { type: 'SHIP', reason: 're-issued after a lost response' },
    ));
    expect(
      reject.reason.startsWith('ship is valid only for a run held at merge by disabled auto-merge'),
      `expected the disclosed refusal to NOT lead with the invalid-target prose, got: ${reject.reason}`,
    ).toBe(false);
  });

  // Defect (2): the suite above pinned only that the message does NOT start
  // with the invalid-target prose — never that it says anything positive. An
  // implementation that dropped the attribution and returned the bare
  // rest-state guidance (the shipping-watch text alone, with no mention of
  // the caller's own prior ship) for this case would satisfy every assertion
  // above and every assertion below it in this describe block, and the
  // disclosure would have silently disappeared. This assertion is expected to
  // hold against the CURRENT implementation (green from the start) — it is a
  // positive pin on wording already delivered, not a new red anchor — and it
  // must fail against that deliberately weakened bare-guidance response,
  // which names no prior ship at all.
  it('pins the attribution wording itself: names a PRIOR ship, not merely the rest-state guidance', () => {
    const reject = rejectOf(reduceRun(
      restingShipping({ ship_requested: true }),
      { type: 'SHIP', reason: 'x' },
    ));
    expect(
      reject.reason,
      'must attribute the rest state to a PRIOR ship, not merely echo the shipping-watch guidance',
    ).toMatch(/prior ship/i);
  });

  it('still names the open PR and its in-flight remote checks, and still points at ape_run next', () => {
    const reject = rejectOf(reduceRun(
      restingShipping({ ship_requested: true }),
      { type: 'SHIP', reason: 're-issued after a lost response' },
    ));
    expectSafeRestRefusal(reject.reason);
    expect(reject.reason).toContain(PR_URL);
    expect(reject.reason).toContain(CHECKS_SUMMARY);
  });

  it('still recommends neither the audited OVERRIDE reset nor ABORT', () => {
    const reject = rejectOf(reduceRun(
      restingShipping({ ship_requested: true }),
      { type: 'SHIP', reason: 'x' },
    ));
    expectSafeRestRefusal(reject.reason);
  });

  it('the attribution is derived from state.ship_requested alone: differs from the refusal given for the identical rest state when ship_requested is not true', () => {
    const disclosed = rejectOf(reduceRun(
      restingShipping({ ship_requested: true }),
      { type: 'SHIP', reason: 'x' },
    )).reason;
    const ordinary = rejectOf(reduceRun(
      restingShipping(),
      { type: 'SHIP', reason: 'x' },
    )).reason;
    expect(
      disclosed,
      'a caller whose own prior ship rested the run here must read a different refusal than one who never shipped it',
    ).not.toBe(ordinary);
  });

  it('the ordinary (never-shipped) shipping-rest refusal is unchanged: still leads with the invalid-target prose', () => {
    // Regression pin: this ticket narrows the fix to ship_requested === true —
    // a caller who never issued SHIP on this run gets the same honest
    // "ship is valid only for..." refusal as before, unweakened.
    const reject = rejectOf(reduceRun(restingShipping(), { type: 'SHIP', reason: 'x' }));
    expectSafeRestRefusal(reject.reason);
    expect(reject.reason.startsWith('ship is valid only for a run held at merge by disabled auto-merge')).toBe(true);
  });

  it('remains a pure refusal: no lock, no audited ship, no gate run, no transition — only the prose changes', () => {
    expect(typesOf(reduceRun(restingShipping({ ship_requested: true }), { type: 'SHIP', reason: 'x' })))
      .toEqual(['reject']);
  });

  it('stays derived from state alone: deterministic across repeated calls and reads no wall clock', () => {
    const state = deepFreeze(restingShipping({ ship_requested: true }));
    const first = rejectOf(reduceRun(state, { type: 'SHIP', reason: 'x' })).reason;
    const second = rejectOf(reduceRun(state, { type: 'SHIP', reason: 'x' })).reason;
    expect(second).toBe(first);

    const clock = vi.spyOn(Date, 'now');
    try {
      reduceRun(state, { type: 'SHIP', reason: 'x' });
      expect(clock).not.toHaveBeenCalled();
    } finally {
      clock.mockRestore();
    }
  });

  it('never leaks an absent field into the disclosed message when the watch has not been polled yet', () => {
    const reject = rejectOf(reduceRun(
      restingShipping({ ship_requested: true }, { last_checks_summary: null, last_poll_at: null, poll_count: 0 }),
      { type: 'SHIP', reason: 'x' },
    ));
    expectSafeRestRefusal(reject.reason);
    expect(reject.reason).toContain(PR_URL);
  });
});

// Defect (1): the 'gating' sibling of the fix above. SHIP sets ship_requested
// true and emits run_gates; when that detached suite outlives
// gates.inline_grace_ms the run rests in 'gating' with ship_requested STILL
// true — reached exactly when the caller's OWN prior SHIP is the reason the
// gate suite is running at all (the same lost-response re-issue as the
// shipping case, only caught a few seconds earlier, while the re-run gates
// are still in flight). Before this fix a SHIP re-issued there falls through
// to the same generic branch and answers "ship is valid only for ...; this
// run rests in the non-blocking gating watch ..." — the identical
// "your ship did nothing" misreading the shipping fix already closed.
describe('ship refused from the gating rest state — attributing the state to the caller\'s own prior ship', () => {
  it('does not lead with the "ship is valid only for..." prose that reads as the ship having done nothing', () => {
    const reject = rejectOf(reduceRun(
      restingGating({ ship_requested: true }),
      { type: 'SHIP', reason: 're-issued after a lost response' },
    ));
    expect(
      reject.reason.startsWith('ship is valid only for a run held at merge by disabled auto-merge'),
      `expected the disclosed refusal to NOT lead with the invalid-target prose, got: ${reject.reason}`,
    ).toBe(false);
  });

  it('attributes the rest state to a PRIOR ship, not merely to the passing gating-watch guidance', () => {
    const reject = rejectOf(reduceRun(
      restingGating({ ship_requested: true }),
      { type: 'SHIP', reason: 'x' },
    ));
    expect(
      reject.reason,
      'must attribute the rest state to a PRIOR ship, not merely echo the gating-watch guidance',
    ).toMatch(/prior ship/i);
  });

  it('does not falsely claim the ship already succeeded — the gate suite THIS SAME ship triggered has not resolved yet', () => {
    // Truthful completion (invariant 8): while status stays 'gating' the run's
    // GATES_PASSED/GATES_FAILED has not fired, so the very ship that set
    // ship_requested here could still fail its own re-run of the gates.
    // Copying the shipping case's "already succeeded" wording verbatim onto
    // this still-in-flight case would itself be an untruthful disclosure.
    const reject = rejectOf(reduceRun(
      restingGating({ ship_requested: true }),
      { type: 'SHIP', reason: 'x' },
    ));
    expect(reject.reason).not.toMatch(/already succeeded/i);
  });

  it('still names the running gate suite and still points at ape_run next', () => {
    const reject = rejectOf(reduceRun(
      restingGating({ ship_requested: true }),
      { type: 'SHIP', reason: 're-issued after a lost response' },
    ));
    expectSafeRestRefusal(reject.reason);
    expect(reject.reason).toMatch(/gating|gate suite|merge-gate/i);
    expect(reject.reason).toContain(GATE_SUMMARY);
  });

  it('still recommends neither the audited OVERRIDE reset nor ABORT', () => {
    const reject = rejectOf(reduceRun(
      restingGating({ ship_requested: true }),
      { type: 'SHIP', reason: 'x' },
    ));
    expectSafeRestRefusal(reject.reason);
  });

  it('the attribution is derived from state.ship_requested alone: differs from the refusal given for the identical rest state when ship_requested is not true', () => {
    const disclosed = rejectOf(reduceRun(
      restingGating({ ship_requested: true }),
      { type: 'SHIP', reason: 'x' },
    )).reason;
    const ordinary = rejectOf(reduceRun(
      restingGating(),
      { type: 'SHIP', reason: 'x' },
    )).reason;
    expect(
      disclosed,
      'a caller whose own prior ship rested the run here must read a different refusal than one who never shipped it',
    ).not.toBe(ordinary);
  });

  it('the ordinary (never-shipped) gating-rest refusal is unchanged: still leads with the invalid-target prose', () => {
    // Regression pin, mirroring the analogous shipping pin: this ticket
    // narrows the fix to ship_requested === true — a caller who never issued
    // SHIP on this run gets the same honest "ship is valid only for..."
    // refusal as before, unweakened.
    const reject = rejectOf(reduceRun(restingGating(), { type: 'SHIP', reason: 'x' }));
    expectSafeRestRefusal(reject.reason);
    expect(reject.reason.startsWith('ship is valid only for a run held at merge by disabled auto-merge')).toBe(true);
  });

  it('remains a pure refusal: no lock, no audited ship, no gate run, no transition — only the prose changes', () => {
    expect(typesOf(reduceRun(restingGating({ ship_requested: true }), { type: 'SHIP', reason: 'x' })))
      .toEqual(['reject']);
  });

  it('stays derived from state alone: deterministic across repeated calls and reads no wall clock', () => {
    const state = deepFreeze(restingGating({ ship_requested: true }));
    const first = rejectOf(reduceRun(state, { type: 'SHIP', reason: 'x' })).reason;
    const second = rejectOf(reduceRun(state, { type: 'SHIP', reason: 'x' })).reason;
    expect(second).toBe(first);

    const clock = vi.spyOn(Date, 'now');
    try {
      reduceRun(state, { type: 'SHIP', reason: 'x' });
      expect(clock).not.toHaveBeenCalled();
    } finally {
      clock.mockRestore();
    }
  });

  it('never leaks an absent field into the disclosed message when the watch has not been polled yet', () => {
    const reject = rejectOf(reduceRun(
      restingGating({ ship_requested: true }, { last_summary: null, last_poll_at: null, poll_count: 0 }),
      { type: 'SHIP', reason: 'x' },
    ));
    expectSafeRestRefusal(reject.reason);
  });
});

describe('ship self-disclosure — the disclosure reaches the caller through shipRun', () => {
  async function seedProject(state) {
    const dir = await mkdtemp(path.join(tmpdir(), 'ape-ship-disclosure-'));
    cleanups.push(dir);
    const paths = runtimePaths(dir);
    await atomicWriteJson(paths.active, state);
    return { dir, paths };
  }

  it('surfaces the self-disclosing refusal verbatim and changes nothing on disk', async () => {
    const { dir, paths } = await seedProject(restingShipping({ ship_requested: true }));
    const before = await readJson(paths.active);
    const result = await service.shipRun(dir, 're-issued after a lost response');
    expect(result.ok).toBe(false);
    expect(result.reason.startsWith('ship is valid only for a run held at merge by disabled auto-merge')).toBe(false);
    expectSafeRestRefusal(result.reason);
    expect(result.reason).toContain(PR_URL);
    expect(result.reason).toContain(CHECKS_SUMMARY);
    expect(await readJson(paths.active)).toEqual(before);
  });

  it('the ordinary (never-shipped) case is unchanged through shipRun too', async () => {
    const { dir, paths } = await seedProject(restingShipping());
    const before = await readJson(paths.active);
    const result = await service.shipRun(dir, 'x');
    expect(result.ok).toBe(false);
    expect(result.reason.startsWith('ship is valid only for a run held at merge by disabled auto-merge')).toBe(true);
    expect(await readJson(paths.active)).toEqual(before);
  });

  it('surfaces the gating self-disclosing refusal verbatim and changes nothing on disk', async () => {
    const { dir, paths } = await seedProject(restingGating({ ship_requested: true }));
    const before = await readJson(paths.active);
    const result = await service.shipRun(dir, 're-issued after a lost response');
    expect(result.ok).toBe(false);
    expect(result.reason.startsWith('ship is valid only for a run held at merge by disabled auto-merge')).toBe(false);
    expectSafeRestRefusal(result.reason);
    expect(result.reason).toMatch(/gating|gate suite|merge-gate/i);
    expect(result.reason).toContain(GATE_SUMMARY);
    expect(await readJson(paths.active)).toEqual(before);
  });

  it('the ordinary (never-shipped) gating case is unchanged through shipRun too', async () => {
    const { dir, paths } = await seedProject(restingGating());
    const before = await readJson(paths.active);
    const result = await service.shipRun(dir, 'x');
    expect(result.ok).toBe(false);
    expect(result.reason.startsWith('ship is valid only for a run held at merge by disabled auto-merge')).toBe(true);
    expect(await readJson(paths.active)).toEqual(before);
  });
});
