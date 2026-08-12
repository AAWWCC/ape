import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { runtimePaths } from '../lib/runtime/paths.js';
import { historyAction, statusRun } from '../lib/runtime/service.js';
import { deriveRoadmap } from '../lib/runtime/roadmap.js';
import { atomicWriteJson, readJson } from '../lib/runtime/storage.js';
import {
  RESPONSE_BUDGET_CHARS,
  projectHistoryResponse,
  projectRunResponse,
} from '../lib/runtime/projection.js';

// Roadmap entry ape-run-status-roadmap-unbounded.
//
// THE CONTRACT THIS SUITE DEFINES (authoritative; the implementer makes it green).
//
// The derived roadmap block reaches the wire on FOUR surfaces through TWO
// different short-circuits, and neither of the two bounds that exist today can
// reach it:
//
//   ape_run status        service.js:2808-2814 returns { ok, active, run,
//                         sealed?, roadmap? } with NO actions key, while the
//                         size-triggered pass lives entirely inside
//                         `if (Array.isArray(projected.actions))`
//                         (projection.js:333-354) — the predicate
//                         short-circuits before the budget is consulted, so
//                         acme PR #361's compaction is structurally unable to bound
//                         a status response.
//   ape_history roadmap-status / -register / -supersede
//                         service.js:3099, :3109 and :3119 each return
//                         { ok, roadmap } with no records key, while
//                         projectHistoryResponse returns its input UNCHANGED
//                         unless `Array.isArray(response.records)`
//                         (projection.js:235).
//
// Both bounds therefore belong at the wire, in projection.js, reached from BOTH
// projectRunResponse and projectHistoryResponse. Persistence and derivation stay
// COMPLETE and AUTHORITATIVE: roadmap.json, deriveRoadmap and the service
// results themselves keep the full text (arms R1-R2 pin exactly that), and the
// status.md renderer — a fifth, non-wire consumer of the same derived roadmap
// (service.js:454-455, status-doc.js:255-276) — is untouched by a wire-only
// bound.
//
//   TRIMMED FIELDS  every `entry.superseded.reason` (the only field on the
//                   derived wire shape with no cap of its own: roadmap.js
//                   LIMITS :26-35 caps id/title/description/acceptance/
//                   depends_on/replaced_by/discovered_by, the derived entry
//                   :269-276 carries neither description nor acceptance, and
//                   supersedeEntries :127-130 validates `reason` for
//                   non-emptiness ONLY — its sole ceiling is the 64 KB
//                   assertSafeInput envelope, so ONE supersede call can put
//                   ~64 KB into one entry) and the ape_run-only corrupt marker
//                   `roadmap.corrupt.reason` (service.js:2802-2807), a second
//                   unbounded prose field an entries-only summarizer misses.
//   UNCONDITIONAL   the trim is NOT gated on the response being over budget.
//                   run.tickets[]/receipts[] are already summarized
//                   unconditionally, so a live status response sits under
//                   RESPONSE_BUDGET_CHARS and a size-triggered-only bound would
//                   never fire — closing the entry while changing nothing. Arm
//                   T3 pins that: a comfortably-under-budget block carrying one
//                   oversized reason must come back TRIMMED and must NOT be
//                   reference-identical to its input.
//   MARKER          a trimmed reason is a verbatim prefix of the stored text
//                   with its final character replaced by U+2026 — the in-tree
//                   `slice(0, N - 1) + '…'` convention (boundedGateSummary,
//                   service.js:87-91; plan_artifact entries,
//                   runtime-v2-plan-artifact-forwarding.test.js:33-35). The
//                   width is FIXED, so a reader's rule is the tight "exactly N
//                   characters ending in U+2026" and not the ambiguous "ends in
//                   U+2026" (this repo's own bounded summaries end in U+2026 and
//                   supersession reasons routinely quote them). Arm T1 pins the
//                   fixed width across two independent responses.
//   KEY-GATED       a response that carries no roadmap block, and a
//                   `{ ok: true, roadmap: null }` RM7 response (roadmap-status
//                   on a roadmap-less project — note `typeof null === 'object'`),
//                   stay byte-identical, and projectHistoryResponse keeps
//                   returning explain/import responses BY IDENTITY
//                   (projection.js:235's fast path). Arms N1-N3.
//   FIXED POINT     projecting an already-projected response changes nothing:
//                   no re-trim, no second marker, no nested marker
//                   (runtime-v2-dispatch-ticket-dedupe.test.js:446 pins the
//                   general property for ape_run). Arm N4.
//   NO MUTATION     the helper CONSTRUCTS new entry objects and a new
//                   `entry.superseded` rather than assigning in place —
//                   roadmap.js:275 spreads the STORED superseded object by
//                   reference, and projection.js:10-11 makes "no in-place
//                   writes" a load-bearing module contract. Arm F8.
//
// STATED THRESHOLDS, all derived from the FIXTURES here and never from live
// repo state (the live store moves inside a session):
//   * TWO fixtures, both a genuine threat and both asserted to exceed twice
//     RESPONSE_BUDGET_CHARS BEFORE the bound is measured. The WIDE one is pure
//     and models the live store's shape — WIDE_ENTRIES = 30 entries of which
//     WIDE_STALE = 8 are stale, each carrying WIDE_REASON_CHARS = 15,000 =
//     120,000 chars of supersession reason from one block, ~2.5x the whole
//     response budget. The STORE one is built through the audited service verbs
//     and models C5's envelope instead — STORE_ENTRIES = 12 entries of which
//     STORE_STALE = 3 are stale, each carrying STORE_REASON_CHARS = 40,000
//     (supersedeEntries caps `reason` at nothing but the 64 KB input envelope),
//     also ~120,000 chars.
//   * A projected response carrying either fixture must serialize under
//     RESPONSE_BUDGET_CHARS (48,000, imported — not restated).
//   * A trimmed reason is at most REASON_TRIM_CEILING = 4,096 characters:
//     8 stale entries (the wide fixture's stale count) at that ceiling is
//     32,768 chars, ~68% of RESPONSE_BUDGET_CHARS, which still leaves room for
//     the projected run state beside it. It is at least REASON_TRIM_FLOOR = 32
//     characters, so the marker cannot be minted over content that is gone.
//   * The corrupt marker may be capped more generously than a supersession
//     reason (it is a derivation error message stored in NO file, so unlike a
//     supersession reason it is recoverable from nowhere on disk — its recovery
//     is `ape_history roadmap-status`, which does NOT catch derivation faults
//     and therefore surfaces the same fault untruncated as an isError; arm N6
//     pins both halves of that asymmetry). Its ceiling here is
//     CORRUPT_TRIM_CEILING = 8,192.
//
// DELIBERATELY NOT PINNED — the design may or may not need them, and pinning
// either way would author the plan rather than the contract: whether an
// entry-dropping ceiling exists on top of the reason trim, its terminal case
// and its tiebreak. No arm asserts that every entry of the WIDE fixture
// survives, and no arm looks a specific entry up inside a WIDE projection.
// What every arm does require is that `counts` and `schema_version` cross
// unchanged: the counts line describes the WHOLE roadmap
// (skills/status/SKILL.md), so a wire bound that recomputed it over the
// survivors would replace a disclosed loss with a silent lie. Every fixture an
// arm DOES index into is sized so that no entry-dropping ceiling can bite: at
// REASON_TRIM_CEILING the STORE fixture projects to ~14 KB and the small pure
// fixtures (T1, T2, T3, F8) to well under 8 KB, so the reason trim alone
// already lands them under any block ceiling the design could adopt.
//
// SATISFIABILITY. One implementation of the contract above answers every
// expectation here; no call is asserted to both succeed and fail, and no
// observation is asserted to be two different values.
//
// WHICH ARMS CARRY THE FILE-LEVEL RED (red admission is file-level, and a
// non-regression guard must never be contorted into a false red):
//   RED on this tree — B1, B2, B3, B4, B5, R1, T1, T2, T3, T4, F8. Each fails
//   solely because the wire bound does not exist yet: today both projections
//   hand the derived roadmap back untouched.
//   GREEN on BOTH trees (non-regression guards, and they must stay green) —
//   N1 (RM7 key-absent byte identity), N2 (RM7 roadmap: null byte identity),
//   N3 (explain/import reference identity), N4 (fixed point), N5 (the
//   service-level results and the store stay complete), N6 (the corrupt marker
//   shape on statusRun, and roadmap-status rejecting the same fault).

const ELLIPSIS = '…';

// See "STATED THRESHOLDS" above.
const REASON_TRIM_CEILING = 4_096;
const REASON_TRIM_FLOOR = 32;
const CORRUPT_TRIM_CEILING = 8_192;

// The wide, pure fixture: the live store's shape (many entries, several stale).
const WIDE_ENTRIES = 30;
const WIDE_STALE = 8;
const WIDE_REASON_CHARS = 15_000;

// The store fixture, built through the audited verbs: C5's envelope shape (few
// entries, each stale reason near the 64 KB input ceiling). Sized so that the
// reason trim ALONE lands it far under any block ceiling, which is what keeps
// the arms that index into it safe whether or not the design drops entries.
const STORE_ENTRIES = 12;
const STORE_STALE = 3;
const STORE_REASON_CHARS = 40_000;

const cleanups = [];
afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function plainDir() {
  const dir = await mkdtemp(path.join(tmpdir(), 'ape-roadmap-bound-'));
  cleanups.push(dir);
  return dir;
}

// Single-spaced, newline-free prose of an EXACT length, free of U+2026. The
// whitespace shape is deliberate: a flatten-then-cap implementation (the
// boundedGateSummary convention) and a plain slice leave the same prefix here,
// so the marker assertions below are valid for either.
function prose(chars, tag) {
  const unit = `supersession rationale ${tag} `;
  const raw = unit.repeat(Math.ceil(chars / unit.length) + 1).slice(0, chars);
  return raw.endsWith(' ') ? `${raw.slice(0, -1)}x` : raw;
}

const wireSize = (value) => JSON.stringify(value).length;

function expectTrimmedWithMarker(trimmed, original, ceiling = REASON_TRIM_CEILING) {
  expect(typeof trimmed).toBe('string');
  expect(trimmed.length).toBeLessThan(original.length);
  expect(trimmed.length).toBeLessThanOrEqual(ceiling);
  // A marker minted over nothing is not a disclosure.
  expect(trimmed.length).toBeGreaterThanOrEqual(REASON_TRIM_FLOOR);
  expect(trimmed.endsWith(ELLIPSIS)).toBe(true);
  // Everything before the marker is verbatim stored text, and the marker is
  // the LAST character and the only one: `slice(0, N - 1) + '…'`.
  expect(original.startsWith(trimmed.slice(0, -1))).toBe(true);
  expect(trimmed.slice(0, -1)).not.toContain(ELLIPSIS);
}

const entryId = (index) => `rm-fixture-${String(index).padStart(3, '0')}`;

// A minimal live run state, shaped like the one statusRun returns.
function runningRun(runId = 'run-roadmap-bound') {
  return {
    version: 2,
    schema_version: '2.0.0',
    run_id: runId,
    status: 'running',
    stage: 'build',
    objective: 'Bound the derived roadmap at the wire',
    mode: 'phase',
    lane: 'fast',
    requirements: [],
    claimed_paths: [],
    test_paths: [],
    tickets: [],
    receipts: [],
    attempts: {},
    created_at: '2026-07-20T00:00:00.000Z',
    updated_at: '2026-07-20T00:00:00.000Z',
  };
}

// --- Pure wire fixtures (the derived shape roadmap.js:269-278 produces).

function derivedEntry(index, reason) {
  return {
    id: entryId(index),
    title: `Roadmap fixture entry ${index}`,
    status: reason === undefined ? 'pending' : 'stale',
    discovered_by: 'operator',
    depends_on: [],
    ...(reason === undefined
      ? {}
      : { superseded: { at: '2026-07-20T00:00:00.000Z', reason, replaced_by: [entryId(99)] } }),
  };
}

function derivedRoadmap(entries) {
  const stale = entries.filter((entry) => entry.superseded).length;
  return {
    schema_version: '2.0.0',
    counts: {
      satisfied: 0,
      in_progress: 0,
      ready: 0,
      pending: entries.length - stale,
      stale,
    },
    entries,
  };
}

function statusResponse(roadmap) {
  return { ok: true, active: true, run: runningRun(), roadmap };
}

function roadmapVerbResponse(roadmap) {
  return { ok: true, roadmap };
}

// --- Real store fixture: STORE_ENTRIES registered entries, STORE_STALE of them
// superseded with one STORE_REASON_CHARS reason, through the audited verbs.

const LONG_REASON = prose(STORE_REASON_CHARS, 'A');

async function seededProject() {
  const dir = await plainDir();
  const paths = runtimePaths(dir);
  const entries = Array.from({ length: STORE_ENTRIES }, (_, index) => ({
    id: entryId(index),
    title: `Roadmap fixture entry ${index}`,
    description: `Fixture description ${index}`,
    acceptance: `Fixture acceptance ${index}`,
    depends_on: [],
  }));
  await historyAction(dir, 'roadmap-register', { entries, reason: 'seed the wire-bound fixture' });
  const staleIds = entries.slice(0, STORE_STALE).map((entry) => entry.id);
  await historyAction(dir, 'roadmap-supersede', { ids: staleIds, reason: LONG_REASON, replaced_by: [] });
  await atomicWriteJson(paths.active, runningRun());
  return { dir, paths, staleIds };
}

function expectBoundedRoadmapBlock(projectedRoadmap, sourceRoadmap) {
  expect(projectedRoadmap).toBeTruthy();
  // The counts line describes the WHOLE roadmap and must survive any bound.
  expect(projectedRoadmap.schema_version).toBe(sourceRoadmap.schema_version);
  expect(projectedRoadmap.counts).toEqual(sourceRoadmap.counts);
  expect(Array.isArray(projectedRoadmap.entries)).toBe(true);
  expect(projectedRoadmap.entries.length).toBeGreaterThan(0);
  for (const entry of projectedRoadmap.entries) {
    if (!entry.superseded) continue;
    expect(entry.superseded.reason.length).toBeLessThanOrEqual(REASON_TRIM_CEILING);
  }
}

describe('ape_run status: the derived roadmap crosses the wire bounded', () => {
  it('B1 [RED] bounds a status response whose roadmap carries stale entries with long reasons', () => {
    const entries = Array.from({ length: WIDE_ENTRIES }, (_, index) => (
      index < WIDE_STALE ? derivedEntry(index, prose(WIDE_REASON_CHARS, `A${index}`)) : derivedEntry(index)
    ));
    const response = statusResponse(derivedRoadmap(entries));

    // Fixture-derived, not repo-derived (the live store moves inside a session):
    // 8 x 15,000 = 120,000 chars of supersession reason on ONE block.
    expect(wireSize(response)).toBeGreaterThan(2 * RESPONSE_BUDGET_CHARS);

    const projected = projectRunResponse(response);
    expect(wireSize(projected)).toBeLessThan(RESPONSE_BUDGET_CHARS);
    expectBoundedRoadmapBlock(projected.roadmap, response.roadmap);
    // The run state beside the roadmap is untouched by this bound.
    expect(projected.run.run_id).toBe(response.run.run_id);
    expect(projected.run.objective).toBe(response.run.objective);
    expect(projected.ok).toBe(true);
    expect(projected.active).toBe(true);
  });

  it('B2 [RED] bounds the real statusRun response end to end', async () => {
    const { dir } = await seededProject();
    const response = await statusRun(dir);
    expect(response.roadmap).toBeTruthy();
    // The service result is COMPLETE — the bound is wire-only.
    const staleFromService = response.roadmap.entries.filter((entry) => entry.superseded);
    expect(staleFromService).toHaveLength(STORE_STALE);
    for (const entry of staleFromService) expect(entry.superseded.reason).toBe(LONG_REASON);
    expect(wireSize(response)).toBeGreaterThan(2 * RESPONSE_BUDGET_CHARS);

    const projected = projectRunResponse(response);
    expect(wireSize(projected)).toBeLessThan(RESPONSE_BUDGET_CHARS);
    expectBoundedRoadmapBlock(projected.roadmap, response.roadmap);
    for (const entry of projected.roadmap.entries) {
      if (entry.superseded) expectTrimmedWithMarker(entry.superseded.reason, LONG_REASON);
    }
  });
});

describe('ape_history roadmap verbs: the same block, the other projection', () => {
  it('B3 [RED] bounds a roadmap-status response', async () => {
    const { dir } = await seededProject();
    const response = await historyAction(dir, 'roadmap-status', {});
    expect(response.ok).toBe(true);
    expect(wireSize(response)).toBeGreaterThan(2 * RESPONSE_BUDGET_CHARS);

    const projected = projectHistoryResponse(response);
    expect(wireSize(projected)).toBeLessThan(RESPONSE_BUDGET_CHARS);
    expect(projected.ok).toBe(true);
    expectBoundedRoadmapBlock(projected.roadmap, response.roadmap);
  });

  it('B4 [RED] bounds a roadmap-register response', async () => {
    const { dir } = await seededProject();
    const response = await historyAction(dir, 'roadmap-register', {
      entries: [{
        id: 'rm-fixture-new',
        title: 'Registered after the stale entries',
        description: 'Fixture description',
        acceptance: 'Fixture acceptance',
        depends_on: [],
      }],
      reason: 'register beside the stale entries',
    });
    expect(response.ok).toBe(true);
    expect(wireSize(response)).toBeGreaterThan(2 * RESPONSE_BUDGET_CHARS);

    const projected = projectHistoryResponse(response);
    expect(wireSize(projected)).toBeLessThan(RESPONSE_BUDGET_CHARS);
    expectBoundedRoadmapBlock(projected.roadmap, response.roadmap);
    // The freshly registered entry is not stale and carries no reason at all.
    const fresh = projected.roadmap.entries.find((entry) => entry.id === 'rm-fixture-new');
    expect(fresh).toEqual({
      id: 'rm-fixture-new',
      title: 'Registered after the stale entries',
      status: 'ready',
      discovered_by: 'operator',
      depends_on: [],
    });
  });

  it('B5 [RED] bounds a roadmap-supersede response', async () => {
    const { dir } = await seededProject();
    const response = await historyAction(dir, 'roadmap-supersede', {
      ids: [entryId(STORE_STALE)],
      reason: LONG_REASON,
      replaced_by: [entryId(STORE_ENTRIES - 1)],
    });
    expect(response.ok).toBe(true);
    expect(wireSize(response)).toBeGreaterThan(2 * RESPONSE_BUDGET_CHARS);

    const projected = projectHistoryResponse(response);
    expect(wireSize(projected)).toBeLessThan(RESPONSE_BUDGET_CHARS);
    expectBoundedRoadmapBlock(projected.roadmap, response.roadmap);
    const justSuperseded = projected.roadmap.entries.find((entry) => entry.id === entryId(STORE_STALE));
    expect(justSuperseded).toBeTruthy();
    expect(justSuperseded.status).toBe('stale');
    expectTrimmedWithMarker(justSuperseded.superseded.reason, LONG_REASON);
    // The replacement pointer is unique information and is never referenced away.
    expect(justSuperseded.superseded.replaced_by).toEqual([entryId(STORE_ENTRIES - 1)]);
  });
});

describe('the recovery path the truncation depends on', () => {
  it('R1 [RED] trims the wire while roadmap.json keeps the full reason verbatim', async () => {
    const { dir, paths, staleIds } = await seededProject();
    const response = await historyAction(dir, 'roadmap-status', {});
    const projected = projectHistoryResponse(response);
    expect(wireSize(projected)).toBeLessThan(RESPONSE_BUDGET_CHARS);
    const trimmed = projected.roadmap.entries.find((entry) => entry.id === staleIds[0]);
    expectTrimmedWithMarker(trimmed.superseded.reason, LONG_REASON);

    // The documented recovery: the store on disk. Per prompts/common.md a bound
    // subagent may read exactly ONE .ape file (its own ticket), so this path
    // belongs to the orchestrator and the operator, not to a running agent.
    const stored = await readJson(path.join(paths.runtime, 'roadmap.json'));
    const storedEntry = stored.entries.find((entry) => entry.id === staleIds[0]);
    expect(storedEntry.superseded.reason).toBe(LONG_REASON);
    expect(storedEntry.superseded.reason.length).toBe(STORE_REASON_CHARS);
  });

  it('N5 the derivation and the service results stay complete and authoritative', async () => {
    const { dir, paths, staleIds } = await seededProject();
    // Internal consumers (persist -> renderStatusDoc, and every in-process
    // caller) read the full text: nothing on the persistence side is bounded.
    const derived = await deriveRoadmap(paths);
    const derivedStale = derived.entries.find((entry) => entry.id === staleIds[0]);
    expect(derivedStale.superseded.reason).toBe(LONG_REASON);

    const verb = await historyAction(dir, 'roadmap-status', {});
    expect(verb.roadmap.entries.find((entry) => entry.id === staleIds[0]).superseded.reason)
      .toBe(LONG_REASON);
    const status = await statusRun(dir);
    expect(status.roadmap.entries.find((entry) => entry.id === staleIds[0]).superseded.reason)
      .toBe(LONG_REASON);
  });
});

describe('the trim itself', () => {
  it('T1 [RED] trims to a FIXED width, marks it, and changes nothing else', () => {
    // Two independent responses, one stale entry each: the width is a constant
    // of the bound, not a per-response computation. One stale entry per block
    // also keeps each projection far under any block ceiling, so nothing here
    // can be dropped rather than trimmed.
    const shortish = prose(6_000, 'B');
    const longer = prose(9_000, 'C');
    const first = roadmapVerbResponse(derivedRoadmap([derivedEntry(0, shortish), derivedEntry(1)]));
    const second = roadmapVerbResponse(derivedRoadmap([derivedEntry(0, longer), derivedEntry(1)]));

    const firstProjected = projectHistoryResponse(first);
    const secondProjected = projectHistoryResponse(second);
    const firstReason = firstProjected.roadmap.entries[0].superseded.reason;
    const secondReason = secondProjected.roadmap.entries[0].superseded.reason;
    expectTrimmedWithMarker(firstReason, shortish);
    expectTrimmedWithMarker(secondReason, longer);
    expect(firstReason.length).toBe(secondReason.length);

    // ONLY the reason changed on the entry: status, provenance, dependencies,
    // the supersession timestamp and the replacement pointer all cross whole.
    expect(firstProjected.roadmap.entries[0]).toEqual({
      ...first.roadmap.entries[0],
      superseded: { ...first.roadmap.entries[0].superseded, reason: firstReason },
    });
    // A non-stale entry crosses byte-identical.
    expect(firstProjected.roadmap.entries[1]).toEqual(first.roadmap.entries[1]);
    expect(firstProjected.roadmap.counts).toEqual(first.roadmap.counts);
    expect(firstProjected.roadmap.entries).toHaveLength(2);
  });

  it('T2 [RED] bounds ONE entry carrying a ~64 KB reason (the assertSafeInput ceiling)', () => {
    // supersedeEntries validates `reason` for non-emptiness only, so a single
    // supersede call can store ~64 KB against one entry.
    const enormous = prose(60_000, 'D');
    const response = statusResponse(derivedRoadmap([derivedEntry(0, enormous)]));
    expect(wireSize(response)).toBeGreaterThan(RESPONSE_BUDGET_CHARS);

    const projected = projectRunResponse(response);
    expect(wireSize(projected)).toBeLessThan(RESPONSE_BUDGET_CHARS);
    expect(projected.roadmap.entries).toHaveLength(1);
    expectTrimmedWithMarker(projected.roadmap.entries[0].superseded.reason, enormous);
  });

  it('T3 [RED] trims an UNDER-budget block and never returns it by identity', () => {
    // The inert-bound defect, pinned: this whole response is ~9.5 KB — under
    // RESPONSE_BUDGET_CHARS and under any plausible roadmap-block ceiling — so
    // a bound gated on "over budget", or a summarizer that returns its input
    // whenever the block is in bounds, would be dead code on every ordinary
    // response. The identity predicate must be "nothing changed", not "in
    // bounds".
    const reason = prose(9_000, 'E');
    const entries = [derivedEntry(0), derivedEntry(1, reason), derivedEntry(2)];
    const response = roadmapVerbResponse(derivedRoadmap(entries));
    expect(wireSize(response)).toBeLessThan(RESPONSE_BUDGET_CHARS);

    const projected = projectHistoryResponse(response);
    expect(projected).not.toBe(response);
    expect(projected.roadmap).not.toBe(response.roadmap);
    expect(projected.roadmap.entries).not.toBe(response.roadmap.entries);
    expectTrimmedWithMarker(projected.roadmap.entries[1].superseded.reason, reason);
    // Nothing is dropped at this size: all three entries survive in order.
    expect(projected.roadmap.entries.map((entry) => entry.id))
      .toEqual(entries.map((entry) => entry.id));
    expect(projected.roadmap.counts).toEqual(response.roadmap.counts);
  });

  it('T4 [RED] trims the ape_run corrupt marker, keeping the marker itself intact', () => {
    // statusRun degrades a derivation fault to { corrupt: true, reason }
    // (service.js:2802-2807). `reason` is an unbounded error message and is a
    // second prose field an entries-only summarizer would walk straight past.
    const reason = prose(20_000, 'F');
    const response = { ok: true, active: false, run: null, roadmap: { corrupt: true, reason } };
    expect(wireSize(response)).toBeGreaterThan(RESPONSE_BUDGET_CHARS / 4);

    const projected = projectRunResponse(response);
    expect(projected.roadmap.corrupt).toBe(true);
    expectTrimmedWithMarker(projected.roadmap.reason, reason, CORRUPT_TRIM_CEILING);
    expect(wireSize(projected)).toBeLessThan(RESPONSE_BUDGET_CHARS);
    // A corrupt marker has no entries; the bound must not invent any.
    expect(projected.roadmap).not.toHaveProperty('entries');
    expect(projected.ok).toBe(true);
    expect(projected.active).toBe(false);
    expect(projected.run).toBeNull();
  });

  it('F8 [RED] constructs new objects and never rewrites the input in place', () => {
    // projection.js:10-11 makes "no in-place writes" load-bearing: callers hand
    // in LIVE runtime objects, and roadmap.js:275 spreads the STORED superseded
    // object by reference, so an in-place trim would corrupt the store's own
    // in-memory copy and the next persist would write the corruption to disk.
    const reason = prose(9_000, 'G');
    const response = statusResponse(derivedRoadmap([derivedEntry(0, reason), derivedEntry(1)]));
    const snapshot = structuredClone(response);

    const projected = projectRunResponse(response);

    // Named field first, so an in-place casualty fails as a short value rather
    // than dumping the whole fixture into the diff.
    expect(response.roadmap.entries[0].superseded.reason).toBe(reason);
    expect(response.roadmap.entries[0].superseded.reason.length).toBe(9_000);
    // ...then the whole-input catch-all: NOTHING in the input moved.
    expect(response).toEqual(snapshot);
    // New objects, not rewritten ones.
    expect(projected.roadmap.entries[0]).not.toBe(response.roadmap.entries[0]);
    expect(projected.roadmap.entries[0].superseded).not.toBe(response.roadmap.entries[0].superseded);
    expect(projected.roadmap.entries[0].superseded.reason).not.toBe(reason);
  });
});

describe('non-regression guards (green on both trees)', () => {
  it('N1 leaves a status response that carries no roadmap byte-identical (RM7)', async () => {
    const dir = await plainDir();
    const paths = runtimePaths(dir);
    await atomicWriteJson(paths.active, runningRun());

    const response = await statusRun(dir);
    expect(response).not.toHaveProperty('roadmap');
    const snapshot = structuredClone(response);
    const projected = projectRunResponse(response);
    expect(projected).not.toHaveProperty('roadmap');
    expect(projected).toEqual(snapshot);
  });

  it('N2 leaves { ok: true, roadmap: null } byte-identical (RM7, typeof null === object)', async () => {
    const dir = await plainDir();
    const response = await historyAction(dir, 'roadmap-status', {});
    expect(response).toEqual({ ok: true, roadmap: null });

    const projected = projectHistoryResponse(response);
    expect(projected).toEqual({ ok: true, roadmap: null });
    expect(Object.keys(projected)).toEqual(['ok', 'roadmap']);
    // Same shape straight from a literal, so the guard is pinned independently
    // of whatever the service happens to construct.
    expect(projectHistoryResponse({ ok: true, roadmap: null })).toEqual({ ok: true, roadmap: null });
  });

  it('N3 keeps returning explain and import responses BY IDENTITY', () => {
    const explain = {
      ok: true,
      text: 'run-x completed',
      record: { run_id: 'run-x', status: 'completed', tickets: [], receipts: [] },
    };
    const importResponse = { ok: true, migration: { imported: 2, skipped: 0 } };
    // projection.js:235's fast path: no records[], no roadmap block, same object.
    expect(projectHistoryResponse(explain)).toBe(explain);
    expect(projectHistoryResponse(importResponse)).toBe(importResponse);
    expect(projectHistoryResponse(null)).toBeNull();
  });

  it('N4 is a fixed point: projecting an already-projected response changes nothing', () => {
    // The WIDE fixture for the whole-response property (no arm indexes into it),
    // where a truncate-with-marker bound is least obviously idempotent.
    const wide = Array.from({ length: WIDE_ENTRIES }, (_, index) => (
      index < WIDE_STALE ? derivedEntry(index, prose(WIDE_REASON_CHARS, `H${index}`)) : derivedEntry(index)
    ));

    const runOnce = projectRunResponse(statusResponse(derivedRoadmap(wide)));
    expect(projectRunResponse(runOnce)).toEqual(runOnce);

    const historyOnce = projectHistoryResponse(roadmapVerbResponse(derivedRoadmap(wide)));
    expect(projectHistoryResponse(historyOnce)).toEqual(historyOnce);

    // No second marker, no nested marker: a trimmed reason survives a second
    // pass character for character. Its own small fixture, so the entry this
    // reads is one no ceiling could have dropped.
    const small = roadmapVerbResponse(derivedRoadmap([derivedEntry(0, prose(9_000, 'I')), derivedEntry(1)]));
    const smallOnce = projectHistoryResponse(small);
    const first = smallOnce.roadmap.entries[0].superseded.reason;
    const second = projectHistoryResponse(smallOnce).roadmap.entries[0].superseded.reason;
    expect(second).toBe(first);
    expect([...second].filter((character) => character === ELLIPSIS))
      .toHaveLength([...first].filter((character) => character === ELLIPSIS).length);
  });

  it('N6 keeps the corrupt marker on statusRun only, and roadmap-status still raises', async () => {
    const dir = await plainDir();
    const paths = runtimePaths(dir);
    await mkdir(paths.runtime, { recursive: true });
    await atomicWriteJson(paths.active, runningRun());
    await writeFile(path.join(paths.runtime, 'roadmap.json'), '{ this is not json', 'utf8');

    // statusRun catches the derivation fault and degrades to a structured marker.
    const status = await statusRun(dir);
    expect(status.ok).toBe(true);
    expect(status.roadmap.corrupt).toBe(true);
    expect(typeof status.roadmap.reason).toBe('string');
    expect(status.roadmap.reason.length).toBeGreaterThan(0);

    // historyAction does NOT catch, so the same fault surfaces there as an
    // error — which is exactly where an untruncated corrupt reason is
    // recoverable from, since it is stored in no file.
    await expect(historyAction(dir, 'roadmap-status', {})).rejects.toThrow();
  });
});
