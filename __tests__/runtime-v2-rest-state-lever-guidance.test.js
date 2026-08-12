import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { reduceRun } from '../lib/runtime/scheduler.js';
import {
  AUTO_MERGE_HOLD_REASON,
  MAX_REGATE_ATTEMPTS,
  TERMINAL_STATUSES,
} from '../lib/runtime/constants.js';
import { DEFAULT_CONFIG } from '../lib/runtime/config.js';
import { runtimePaths } from '../lib/runtime/paths.js';
import { atomicWriteJson, readJson } from '../lib/runtime/storage.js';
import * as service from '../lib/runtime/service.js';

// Roadmap entry inflight-rest-state-lever-misdirection.
//
// A run resting in a non-blocking WATCH is not terminal: TERMINAL_STATUSES is
// exactly {completed, blocked, aborted}, so the reducer's pre-switch terminal
// guard never answers for 'gating' or 'shipping' and control falls through to the
// REGATE and SHIP arms' own validity guards. Both refuse with a reason that names
// no achieved post-condition and directs the operator at "the audited OVERRIDE
// reset or ABORT" — advice that KILLS a healthy detached gate suite ('gating') or
// aborts a run whose PR is open with remote checks mid-flight ('shipping').
//
// These are the states an operator most likely re-issues a lever from: they span
// the multi-minute window the MCP progress heartbeat exists to cover, and the
// stateless MCP revision mandates re-issue as the recovery for a lost response.
//
// The behavioral contract these tests pin, derived from the entry's acceptance:
// a REGATE or SHIP refused while the run rests in either watch must
//   (a) name the rest state and what the watch is waiting on, from state alone,
//   (b) point the caller at `ape_run next` as the way to poll it, and
//   (c) never recommend the audited OVERRIDE reset or ABORT.
// The model is already in-repo: resumeRun answers exactly this way for the same
// two states, so these tests hold the levers to the shape resume already returns
// rather than inventing wording.
//
// Everything the entry says must NOT change is pinned here too: the terminal
// guard, the honest refusals for genuinely blocked runs, the bounded re-gate
// attempt count, and — above all — WHICH operations are admitted. A rest-state
// lever call stays a refusal; only its prose becomes safe to follow.

const REPO_ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

const PR_URL = 'https://github.com/acme/repo/pull/42';
const CHECKS_SUMMARY = '2 of 3 required checks still pending';
const GATE_SUMMARY = 'full_suite still running after 40s';

const cleanups = [];
afterEach(async () => {
  await Promise.all(
    cleanups
      .splice(0)
      .map((dir) => rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })),
  );
});

// A live, non-sealed run whose single build receipt is attested. Mirrors the
// fixtures the regate/gating suites already load through activeState, so the
// shape is proven loadable and the red below is about the reject PROSE, never
// about an unreadable state file (a sanity test asserts that premise directly).
function baseRun(overrides = {}) {
  return {
    version: 2,
    schema_version: '2.0.0',
    run_id: 'run-rest-state',
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
    requirements: ['R-rest'],
    risk_triggers: [],
    branch: 'ape/phase-rest',
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

// A run resting in the non-blocking GATING watch: the full merge-gate suite runs
// in a detached runner, the run lock is still held, block_reason is null, and
// each `ape_run next` is one bounded poll. Reached whenever a detached suite
// outlives gates.inline_grace_ms.
function restingGating(watchOverrides = {}, overrides = {}) {
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

// A run resting in the non-blocking SHIPPING watch: phase 1 pushed the branch and
// opened the PR, required remote checks are mid-flight, the run lock is still
// held, block_reason is null, and no MERGED transition or archive happened. This
// is where the SHIPPED DEFAULT rests every green run.
function restingShipping(watchOverrides = {}, overrides = {}) {
  return baseRun({
    status: 'shipping',
    stage: 'merge',
    block_reason: null,
    gates: { passed: true, tree_sha: 'b'.repeat(40) },
    shipping_watch: {
      provider: 'github',
      pr_url: PR_URL,
      branch: 'ape/phase-rest',
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

// A run genuinely blocked at the merge gates — the ONE state REGATE recovers, and
// the state whose honest refusals this entry must not weaken.
function gateBlocked(overrides = {}) {
  return baseRun({
    status: 'blocked',
    stage: 'gates',
    block_reason: 'one or more deterministic merge gates failed',
    gates: { passed: false, tree_sha: 'b'.repeat(40) },
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

// The three acceptance clauses every rest-state refusal must satisfy.
function expectSafeRestRefusal(reason) {
  expect(typeof reason).toBe('string');
  // (b) The caller is pointed at the poll lever that actually advances the watch.
  expect(reason, 'must point the caller at ape_run next').toMatch(/ape_run next/);
  // (c) It must not steer the operator at a run-destroying recovery. The reducer
  // names these levers in ALL CAPS in its own reject prose (today's misdirection
  // reads "recover ... through the audited OVERRIDE reset or ABORT"), so the
  // forbidden shape is the capitalized lever token plus the lowercase "override
  // reset" spelling; a lowercase cautionary mention is not what is forbidden.
  expect(reason, 'must not recommend the audited OVERRIDE lever').not.toMatch(/OVERRIDE/);
  expect(reason, 'must not recommend ABORT').not.toMatch(/ABORT/);
  expect(reason, 'must not recommend an override reset').not.toMatch(/override reset/i);
  // Guidance derived from state must never leak an absent field.
  expect(reason).not.toMatch(/\b(?:null|undefined)\b/);
}

describe('rest-state lever guidance — the premises this entry rests on, re-derived against the tree', () => {
  it('TERMINAL_STATUSES is exactly {completed, blocked, aborted}, so neither rest state is terminal', () => {
    expect([...TERMINAL_STATUSES].sort()).toEqual(['aborted', 'blocked', 'completed']);
    expect(TERMINAL_STATUSES.has('gating')).toBe(false);
    expect(TERMINAL_STATUSES.has('shipping')).toBe(false);
  });

  it('the pre-switch terminal guard therefore never answers for a resting run: control reaches the lever arms', () => {
    // A terminal status gets the self-disclosing `run is <status>` answer...
    const sealed = rejectOf(reduceRun(
      gateBlocked({ status: 'completed', stage: 'complete' }),
      { type: 'REGATE' },
    ));
    expect(sealed.reason).toMatch(/run is completed/);
    // ...while a resting run does NOT: its refusal comes from the lever's own arm,
    // which is why that arm's prose is what this entry has to fix.
    const resting = rejectOf(reduceRun(restingGating(), { type: 'REGATE' }));
    expect(resting.reason).not.toMatch(/run is gating/);
  });

  it('the shipped default makes the shipping rest state the normal path, not an edge case', () => {
    expect(DEFAULT_CONFIG.shipping.auto_merge).toBe(false);
    expect(DEFAULT_CONFIG.shipping.required_remote_checks).toBe(true);
  });

  it('GATES_PASSED itself routes a green run into the shipping rest state', () => {
    const actions = reduceRun(baseRun({ status: 'running', stage: 'gates' }), { type: 'GATES_PASSED' });
    const transition = actions.find((action) => action.type === 'transition');
    expect(transition.patch.status).toBe('shipping');
    expect(transition.patch.stage).toBe('merge');
    expect(typesOf(actions)).toContain('auto_merge');
  });
});

describe('rest-state lever guidance — REGATE refused while the run rests in a watch', () => {
  it('gating: names the running gate suite and points at ape_run next instead of a run-destroying recovery', () => {
    const reject = rejectOf(reduceRun(restingGating(), { type: 'REGATE' }));
    expectSafeRestRefusal(reject.reason);
    // (a) names the rest state / what the watch waits on.
    expect(reject.reason).toMatch(/gating|gate suite|merge-gate/i);
  });

  it('gating: carries the watch evidence already on state (gates_watch.last_summary)', () => {
    const reject = rejectOf(reduceRun(restingGating(), { type: 'REGATE' }));
    expect(reject.reason).toContain(GATE_SUMMARY);
  });

  it('shipping: names the open PR and its in-flight remote checks, and points at ape_run next', () => {
    const reject = rejectOf(reduceRun(restingShipping(), { type: 'REGATE' }));
    expectSafeRestRefusal(reject.reason);
    // (a) names the rest state / what the watch waits on, from state alone.
    expect(reject.reason).toMatch(/shipping|remote check/i);
    expect(reject.reason).toContain(PR_URL);
  });

  it('shipping: carries the watch evidence already on state (shipping_watch.last_checks_summary)', () => {
    const reject = rejectOf(reduceRun(restingShipping(), { type: 'REGATE' }));
    expect(reject.reason).toContain(CHECKS_SUMMARY);
  });

  it('stays a pure refusal: no lock, no gate run, no transition, no persist', () => {
    expect(typesOf(reduceRun(restingGating(), { type: 'REGATE' }))).toEqual(['reject']);
    expect(typesOf(reduceRun(restingShipping(), { type: 'REGATE' }))).toEqual(['reject']);
  });

  it('does not consume a re-gate attempt from a rest state', () => {
    for (const state of [restingGating(), restingShipping()]) {
      const actions = reduceRun(state, { type: 'REGATE' });
      expect(actions.find((action) => action.type === 'transition')).toBeUndefined();
      expect(state.regate_attempts).toBe(0);
    }
  });
});

describe('rest-state lever guidance — SHIP refused while the run rests in a watch', () => {
  it('gating: names the running gate suite and points at ape_run next', () => {
    const reject = rejectOf(reduceRun(restingGating(), { type: 'SHIP', reason: 're-issued after a lost response' }));
    expectSafeRestRefusal(reject.reason);
    expect(reject.reason).toMatch(/gating|gate suite|merge-gate/i);
    expect(reject.reason).toContain(GATE_SUMMARY);
  });

  it('shipping: names the open PR and its in-flight remote checks, and points at ape_run next', () => {
    const reject = rejectOf(reduceRun(restingShipping(), { type: 'SHIP', reason: 're-issued after a lost response' }));
    expectSafeRestRefusal(reject.reason);
    expect(reject.reason).toMatch(/shipping|remote check/i);
    expect(reject.reason).toContain(PR_URL);
    expect(reject.reason).toContain(CHECKS_SUMMARY);
  });

  it('stays a pure refusal: no lock, no audited ship, no gate run, no transition', () => {
    for (const state of [restingGating(), restingShipping()]) {
      const actions = reduceRun(state, { type: 'SHIP', reason: 'x' });
      expect(typesOf(actions)).toEqual(['reject']);
    }
  });
});

describe('rest-state lever guidance — each refusal describes the state it was actually refused from', () => {
  it('the two rest states get distinct, state-accurate messages', () => {
    const gating = rejectOf(reduceRun(restingGating(), { type: 'REGATE' })).reason;
    const shipping = rejectOf(reduceRun(restingShipping(), { type: 'REGATE' })).reason;
    expect(gating).not.toBe(shipping);
    // A gating run has no PR and no remote checks to wait on; saying otherwise
    // would misdirect exactly as badly as today's message does.
    expect(gating).not.toContain(PR_URL);
    expect(gating).not.toContain(CHECKS_SUMMARY);
    // A shipping run's suite already finished green.
    expect(shipping).not.toContain(GATE_SUMMARY);
  });

  it('stays safe and leaks no placeholder when the watch has not been polled yet', () => {
    const gating = rejectOf(reduceRun(
      restingGating({ last_summary: null, last_poll_at: null, poll_count: 0 }),
      { type: 'REGATE' },
    ));
    expectSafeRestRefusal(gating.reason);
    expect(gating.reason).toMatch(/gating|gate suite|merge-gate/i);

    const shipping = rejectOf(reduceRun(
      restingShipping({ last_checks_summary: null, last_poll_at: null, poll_count: 0 }),
      { type: 'SHIP', reason: 'x' },
    ));
    expectSafeRestRefusal(shipping.reason);
    // The PR is the one thing the caller needs to look at, and it is always set.
    expect(shipping.reason).toContain(PR_URL);
  });

  it('a degenerate rest state carrying no watch is still refused and admits nothing', () => {
    for (const event of [{ type: 'REGATE' }, { type: 'SHIP', reason: 'x' }]) {
      expect(typesOf(reduceRun(
        baseRun({ status: 'gating', stage: 'gates', block_reason: null, gates_watch: null }),
        event,
      ))).toEqual(['reject']);
      expect(typesOf(reduceRun(
        baseRun({ status: 'shipping', stage: 'merge', block_reason: null, shipping_watch: null }),
        event,
      ))).toEqual(['reject']);
    }
  });
});

describe('rest-state lever guidance — the reducer stays pure', () => {
  function deepFreeze(value) {
    if (value && typeof value === 'object' && !Object.isFrozen(value)) {
      Object.freeze(value);
      for (const inner of Object.values(value)) deepFreeze(inner);
    }
    return value;
  }

  it('derives the message from the frozen state object alone, mutating nothing', () => {
    for (const event of [{ type: 'REGATE' }, { type: 'SHIP', reason: 'x' }]) {
      for (const factory of [restingGating, restingShipping]) {
        const state = deepFreeze(factory());
        const first = rejectOf(reduceRun(state, event)).reason;
        const second = rejectOf(reduceRun(state, event)).reason;
        // Deterministic: identical state plus identical event yields identical prose.
        expect(second).toBe(first);
      }
    }
  });

  it('reads no wall clock while refusing from a rest state', () => {
    const clock = vi.spyOn(Date, 'now');
    try {
      reduceRun(restingGating(), { type: 'REGATE' });
      reduceRun(restingShipping(), { type: 'SHIP', reason: 'x' });
      expect(clock).not.toHaveBeenCalled();
    } finally {
      clock.mockRestore();
    }
  });
});

describe('rest-state lever guidance — the honest refusals and guards this entry must not weaken', () => {
  it('a gate-blocked run is still recovered by REGATE and still consumes one bounded attempt', () => {
    const actions = reduceRun(gateBlocked(), { type: 'REGATE' });
    expect(typesOf(actions)).not.toContain('reject');
    expect(typesOf(actions)).toContain('acquire_lock');
    expect(typesOf(actions)).toContain('run_gates');
    expect(actions.find((action) => action.type === 'transition').patch.regate_attempts).toBe(1);
  });

  it('the bounded re-gate attempt limit still refuses with its own honest reason', () => {
    const reject = rejectOf(reduceRun(gateBlocked({ regate_attempts: MAX_REGATE_ATTEMPTS }), { type: 'REGATE' }));
    expect(reject.reason).toMatch(/limit reached/i);
    expect(reject.reason).toContain(String(MAX_REGATE_ATTEMPTS));
    expect(reject.reason).toMatch(/exhaust/i);
  });

  it('a non-gate block still gets today\'s refusal, audited exits included — that advice is correct there', () => {
    const reject = rejectOf(reduceRun(
      gateBlocked({ stage: 'build', block_reason: 'stage build failed twice' }),
      { type: 'REGATE' },
    ));
    expect(reject.reason).toMatch(/gate-?blocked/i);
    expect(reject.reason).toMatch(/OVERRIDE|ABORT/);
  });

  it('a merge hold still gets the shipHint pointing at the SHIP lever', () => {
    const reject = rejectOf(reduceRun(
      gateBlocked({ stage: 'merge', block_reason: AUTO_MERGE_HOLD_REASON }),
      { type: 'REGATE' },
    ));
    expect(reject.reason).toMatch(/SHIP/);
  });

  it('SHIP still names REGATE for a gate block and keeps the audited exits for every other block', () => {
    const gate = rejectOf(reduceRun(gateBlocked(), { type: 'SHIP', reason: 'x' }));
    expect(gate.reason).toMatch(/REGATE/);
    const other = rejectOf(reduceRun(
      gateBlocked({ stage: 'build', block_reason: 'stage build failed twice' }),
      { type: 'SHIP', reason: 'x' },
    ));
    expect(other.reason).toMatch(/OVERRIDE|ABORT/);
  });

  it('the terminal guard still seals completed and aborted runs', () => {
    expect(rejectOf(reduceRun(gateBlocked({ status: 'completed', stage: 'complete' }), { type: 'SHIP', reason: 'x' })).reason)
      .toMatch(/run is completed/);
    expect(rejectOf(reduceRun(gateBlocked({ status: 'aborted', stage: 'complete' }), { type: 'REGATE' })).reason)
      .toMatch(/run is aborted/);
  });

  it('NEXT still owns the rest states: which operations are admitted is unchanged', () => {
    const at = '2026-07-30T00:02:00.000Z';
    expect(typesOf(reduceRun(restingGating(), { type: 'NEXT', at }))).toEqual(['poll_gates']);
    expect(typesOf(reduceRun(restingShipping(), { type: 'NEXT', at }))).toEqual(['poll_shipping']);
  });
});

describe('rest-state lever guidance — the refusal reaches the caller through the service levers', () => {
  // No config file is written on purpose: loadRuntimeConfig falls back to the
  // SHIPPED default, which is precisely what makes these rest states the normal
  // path. A refused lever returns before any effect, so no gate suite is spawned
  // and no GitHub call is made — nothing here needs mocking.
  async function seedProject(state) {
    const dir = await mkdtemp(path.join(tmpdir(), 'ape-rest-lever-'));
    cleanups.push(dir);
    const paths = runtimePaths(dir);
    await atomicWriteJson(paths.active, state);
    return { dir, paths };
  }

  it('fixture premise: both resting fixtures load as live, non-sealed runs', async () => {
    const gating = await seedProject(restingGating());
    const gatingStatus = await service.statusRun(gating.dir);
    expect(gatingStatus.ok).toBe(true);
    expect(gatingStatus.active).toBe(true);
    expect(gatingStatus.sealed ?? false).toBe(false);
    expect(gatingStatus.run.status).toBe('gating');

    const shipping = await seedProject(restingShipping());
    const shippingStatus = await service.statusRun(shipping.dir);
    expect(shippingStatus.ok).toBe(true);
    expect(shippingStatus.active).toBe(true);
    expect(shippingStatus.sealed ?? false).toBe(false);
    expect(shippingStatus.run.status).toBe('shipping');
  });

  it('regateRun surfaces the gating guidance verbatim and changes nothing on disk', async () => {
    const { dir, paths } = await seedProject(restingGating());
    const before = await readJson(paths.active);
    const result = await service.regateRun(dir);
    expect(result.ok).toBe(false);
    expectSafeRestRefusal(result.reason);
    expect(result.reason).toMatch(/gating|gate suite|merge-gate/i);
    expect(result.reason).toContain(GATE_SUMMARY);
    expect(await readJson(paths.active)).toEqual(before);
  });

  it('shipRun surfaces the shipping guidance verbatim and changes nothing on disk', async () => {
    const { dir, paths } = await seedProject(restingShipping());
    const before = await readJson(paths.active);
    const result = await service.shipRun(dir, 'lost the ship response; re-issuing');
    expect(result.ok).toBe(false);
    expectSafeRestRefusal(result.reason);
    expect(result.reason).toContain(PR_URL);
    expect(result.reason).toContain(CHECKS_SUMMARY);
    expect(await readJson(paths.active)).toEqual(before);
  });

  it('regateRun refused from the shipping watch changes nothing and never re-runs the suite', async () => {
    const { dir, paths } = await seedProject(restingShipping());
    const before = await readJson(paths.active);
    const result = await service.regateRun(dir);
    expect(result.ok).toBe(false);
    expectSafeRestRefusal(result.reason);
    expect(result.reason).toContain(PR_URL);
    const after = await readJson(paths.active);
    expect(after).toEqual(before);
    expect(after.regate_attempts).toBe(0);
  });

  it('mirrors the guidance resume already returns for these same two states', async () => {
    const { dir } = await seedProject(restingShipping());
    const resumed = await service.resumeRun(dir);
    expect(resumed.ok).toBe(true);
    const guidance = resumed.actions.find((action) => action.type === 'dispatch_pending');
    expect(guidance).toBeDefined();
    expect(guidance.reason).toContain(PR_URL);
    expect(guidance.reason).toMatch(/ape_run next/);

    // A re-issued lever must answer with the same kind of guidance rather than
    // the run-destroying advice it gives today.
    const refused = await service.shipRun(dir, 'lost the ship response; re-issuing');
    expect(refused.ok).toBe(false);
    expect(refused.reason).toContain(PR_URL);
    expect(refused.reason).toMatch(/ape_run next/);
  });
});

describe('rest-state lever guidance — the documented reject contract', () => {
  it('docs/mcp-tools.md documents the rest-state refusal and where it points', async () => {
    const doc = await readFile(path.join(REPO_ROOT, 'docs', 'mcp-tools.md'), 'utf8');
    const paragraphs = doc.split(/\r?\n\s*\r?\n/);
    const documented = paragraphs.filter((paragraph) =>
      /`ship`|`regate`|\bre-gate\b/.test(paragraph)
      && /`gating`|`shipping`|non-blocking watch/.test(paragraph)
      && /reject|refus/i.test(paragraph)
      && /ape_run next|`next`/.test(paragraph));
    expect(
      documented.length,
      'docs/mcp-tools.md enumerates the states ship/regate are rejected for and where each refusal points; the two non-blocking watch states now point at ape_run next and belong there',
    ).toBeGreaterThan(0);
  });
});
