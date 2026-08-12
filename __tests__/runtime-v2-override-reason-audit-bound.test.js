import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { acquireRunLock } from '../lib/runtime/lock.js';
import { abortRun, overrideRun, startRun, statusRun } from '../lib/runtime/service.js';
import { runtimePaths } from '../lib/runtime/paths.js';
import { readJson } from '../lib/runtime/storage.js';

// Roadmap entry sink-guard-coverage-and-detection-completeness, ITEM 2 (the
// live defect the shorthand-blind detector in
// runtime-v2-unbounded-sink-guard.test.js was hiding). bin/ape-mcp.mjs:307
// passes the operator's override `reason` into overrideRun with no
// assertSafeInput envelope (service.js:3731 documents the gap on this exact
// dispatch path), so an operator-authored -- or attacker-crafted -- reason
// reaches overrides.ndjson RAW at TWO sinks: quarantineCorruptState's
// corrupt-state reset audit line (service.js:1680) and the orphaned-lock
// reset audit line (service.js:3977). Both are ES6 SHORTHAND-shaped
// (`reason,`), the exact shape SINK_KEY_LINE's start-anchored, colon-only
// match cannot see and the sibling `audit_override` sink
// (service.js:1505, `reason: action.reason`) is fixed to the SAME
// boundedGateSummary discipline the acme PR #397 hardening already applied to the
// echoed run_id on this identical dispatch path (echoRunId, service.js:3736).
//
// These two drivers are modeled directly on this repo's own harness patterns:
// runtime-v2-service-recovery.test.js's corrupt-state driver (`corrupt()` /
// `project()`) and runtime-v2-lock-protocol.test.js's orphaned-lock driver
// (`overrideRun(dir, 'reset', ...)` against a lock with no active.json).
//
// ITEM 1 (this run, roadmap entry sink-guard-coverage-and-detection-
// completeness): a THIRD, larger hole of the identical class. scheduler.js's
// ABORT case (~:1133) is `action('transition', { patch: { ...,
// abort_reason: event.reason } })`; bin/ape-mcp.mjs passes the operator's
// abort `reason` into abortRun (service.js) with no assertSafeInput envelope
// (the sibling of the override dispatch path service.js documents as
// unenveloped), abortRun screens only `!reason?.trim()`, and the ABORT
// reducer emits NO audit_override action at all -- so none of the three
// boundedGateSummary binds this task's earlier rounds added touches it.
// CORRECTED CLAIM (re-verified against merged main at 69430ccd, per this
// run's own admonition not to trust an earlier receipt's framing): the raw
// operator string reaches active.json AND the persisted per-run record
// (`.ape/runtime/runs/<run_id>.json`, written by the SAME persist_state
// action from the SAME state object) -- NOT the hash-chained immutable
// history record archiveRun/immutableRunRecord writes under
// `.ape/runtime/history/` (history.js), which never reads state.abort_reason
// at all (verified directly: an aborted run's `.ape/runtime/history/
// <run_id>.json` carries no abort_reason key, today or after this fix).
// abort_reason is bound with the SAME boundedGateSummary helper and 400-char
// cap the audit sinks above use.
//
// AUTHORING HAZARD (hit by three prior rounds of this task): this file's own
// bytes must never carry a literal control, DEL, or bidi/format code point.
// The dangerous byte below is synthesized at runtime via String.fromCharCode,
// never pasted.
const BIDI_RIGHT_TO_LEFT_OVERRIDE = String.fromCharCode(0x202e);

// ~1200 printable ASCII characters wrapping one bidi-override code point, so
// the fixture drives both bounds boundedGateSummary enforces: the 400-char
// cap (this reason is roughly 3x that) and the control/bidi neutralization
// (the sink's own defect: this exact byte reaches overrides.ndjson raw today).
function longReasonCarryingBidi() {
  const filler = 'operator-supplied override justification text '.repeat(13); // ~624 chars
  return `${filler}${BIDI_RIGHT_TO_LEFT_OVERRIDE}${filler}`;
}

const cleanups = [];
afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

function git(cwd, ...args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

// Modeled on runtime-v2-service-recovery.test.js's project(): a real temp git
// repo with one commit plus a runtime config, so the recovered runtime is a
// realistic project rather than a bare scratch directory.
async function project() {
  const dir = await mkdtemp(path.join(tmpdir(), 'ape-override-audit-bound-'));
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
  const paths = runtimePaths(dir);
  await mkdir(paths.runtime, { recursive: true });
  await writeFile(paths.config, `${JSON.stringify({
    shipping: { auto_merge: false, provider: 'github', required_remote_checks: false },
    test_commands: { full: 'node --test' },
  })}\n`);
  return dir;
}

// Plant an unparseable active.json (file present, not valid JSON) -- the exact
// state quarantineCorruptState's reset recovers (runtime-v2-service-recovery
// .test.js's own `corrupt()` helper does the same).
async function corrupt(dir) {
  const paths = runtimePaths(dir);
  await mkdir(paths.runtime, { recursive: true });
  await writeFile(paths.active, '{ corrupt');
  return paths;
}

function overrideLines(paths) {
  return readFileSync(paths.overrideLog, 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line));
}

// Modeled on runtime-v2-abort-aiming.test.js's startInput(): a real running
// run for the ABORT driver below, so abortRun exercises the genuine ABORT
// reducer chain (transition -> archive_history -> release_lock ->
// persist_state) instead of a hand-crafted state shape.
function startInput(overrides = {}) {
  return {
    objective: 'Exercise the ABORT audit-reason bound',
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
    ...overrides,
  };
}

describe('APE v2 override-reset audit reason is bounded at every shorthand-shaped sink (roadmap sink-guard-coverage-and-detection-completeness)', () => {
  it('corrupt-state reset: overrides.ndjson records the reason bounded (<=400 chars) and free of the bidi byte', async () => {
    const dir = await project();
    const paths = await corrupt(dir);
    const reason = longReasonCarryingBidi();
    expect(reason.length).toBeGreaterThan(1000);

    const reset = await overrideRun(dir, 'reset', reason);
    expect(reset).toMatchObject({ ok: true, recovered: 'corrupt-state', run: null });

    const line = overrideLines(paths).find((entry) => entry.corrupt_state === true);
    expect(line).toBeDefined();
    expect(typeof line.reason).toBe('string');
    // The live defect: quarantineCorruptState (service.js:1672) writes the raw
    // `reason` argument verbatim at its overrides.ndjson sink (service.js:1680),
    // with no assertSafeInput envelope on this dispatch path (service.js:3731)
    // -- so on the unfixed tree this reason lands at its full ~1200-char
    // length and still carries the raw bidi-override byte.
    expect(line.reason.length).toBeLessThanOrEqual(400);
    expect(line.reason).not.toContain(BIDI_RIGHT_TO_LEFT_OVERRIDE);
  });

  it('orphaned-lock reset: overrides.ndjson records the reason bounded (<=400 chars) and free of the bidi byte', async () => {
    const dir = await project();
    const paths = runtimePaths(dir);
    await acquireRunLock(paths.lock, 'run-orphan');
    const reason = longReasonCarryingBidi();
    expect(reason.length).toBeGreaterThan(1000);

    const reset = await overrideRun(dir, 'reset', reason);
    expect(reset).toMatchObject({ ok: true, recovered: 'orphaned-lock', run: null });

    const line = overrideLines(paths).find((entry) => entry.orphaned_lock === true);
    expect(line).toBeDefined();
    expect(typeof line.reason).toBe('string');
    // The live defect: the orphaned-lock reset arm (service.js:3960-3987)
    // writes the raw `reason` argument verbatim (service.js:3977, `reason,`
    // ES6 shorthand) -- the identical unguarded shape.
    expect(line.reason.length).toBeLessThanOrEqual(400);
    expect(line.reason).not.toContain(BIDI_RIGHT_TO_LEFT_OVERRIDE);
  });

  // Guard, not a red arm: a SHORT, control/bidi-free reason must reach
  // overrides.ndjson byte-identically once the sinks are bounded --
  // boundedGateSummary is a no-op on ordinary ASCII text well under its cap
  // (service-recovery.test.js's own R1/R2 pin the unbounded string
  // 'clear corrupt state after crash' verbatim, so this fixes-forward without
  // disturbing that pinned behavior).
  it('a short, plain-ASCII reset reason still reaches overrides.ndjson unchanged', async () => {
    const dir = await project();
    const paths = await corrupt(dir);
    const reason = 'clear corrupt state after crash';

    await overrideRun(dir, 'reset', reason);

    const line = overrideLines(paths).find((entry) => entry.corrupt_state === true);
    expect(line.reason).toBe(reason);
  });
});

describe('APE v2 ABORT bounds abort_reason before it reaches persisted state (roadmap sink-guard-coverage-and-detection-completeness, ITEM 1)', () => {
  it('a long, bidi-carrying abort reason is bounded (<=400 chars, bidi-free) in active.json and the persisted per-run record', async () => {
    const dir = await project();
    const started = await startRun(dir, startInput());
    expect(started.ok).toBe(true);
    const runId = started.run.run_id;
    const reason = longReasonCarryingBidi();
    expect(reason.length).toBeGreaterThan(1000);

    const result = await abortRun(dir, reason);
    expect(result.ok).toBe(true);

    const paths = runtimePaths(dir);
    const active = await readJson(paths.active, null);
    expect(active.run_id).toBe(runId);
    expect(active.status).toBe('aborted');
    // The live defect: scheduler.js's ABORT case (~:1133) threads the raw
    // `event.reason` straight onto `abort_reason` with no bound at all -- so
    // on the unfixed tree this reads back at its full ~1200-char length and
    // still carries the raw bidi-override byte.
    expect(typeof active.abort_reason).toBe('string');
    expect(active.abort_reason.length).toBeLessThanOrEqual(400);
    expect(active.abort_reason).not.toContain(BIDI_RIGHT_TO_LEFT_OVERRIDE);

    // persist() (service.js) writes BOTH active.json and the per-run record
    // at `.ape/runtime/runs/<run_id>.json` from the SAME state object inside
    // the SAME persist_state action, and no further persist ever touches a
    // sealed (aborted) run's record -- so this is the durable copy of the
    // run's own history, independent of active.json's later lifecycle (e.g.
    // an eventual override reset clears active.json but never this file).
    // It carries the identical unbounded byte today.
    const runsRecord = await readJson(path.join(paths.runs, `${runId}.json`), null);
    expect(typeof runsRecord.abort_reason).toBe('string');
    expect(runsRecord.abort_reason.length).toBeLessThanOrEqual(400);
    expect(runsRecord.abort_reason).not.toContain(BIDI_RIGHT_TO_LEFT_OVERRIDE);
  });

  // Guard, not a red arm: a SHORT, control/bidi-free reason must reach both
  // persisted copies byte-identically once the bind lands (mirrors the
  // sibling reset guard above; runtime-v2-abort-aiming.test.js's own arms
  // already pin ordinary abort reasons verbatim in active.json, so this
  // fixes-forward without disturbing that pinned behavior).
  it('a short, plain-ASCII abort reason still reaches active.json and the per-run record unchanged', async () => {
    const dir = await project();
    const started = await startRun(dir, startInput());
    const runId = started.run.run_id;
    const reason = 'operator cleanup, no aim supplied';

    const result = await abortRun(dir, reason);
    expect(result.ok).toBe(true);

    const paths = runtimePaths(dir);
    const active = await readJson(paths.active, null);
    expect(active.abort_reason).toBe(reason);

    const runsRecord = await readJson(path.join(paths.runs, `${runId}.json`), null);
    expect(runsRecord.abort_reason).toBe(reason);
  });
});

// ITEM 3 (this run, roadmap entry sink-guard-coverage-and-detection-
// completeness): corruptStateError (service.js) sets error.parse_error from
// JSON.parse's own SyntaxError.message, which modern V8 can embed a snippet
// of the OFFENDING INPUT BYTES into -- input this runtime never controls,
// since it is read straight from a corrupt .ape/runtime/active.json. It
// reaches TWO sinks from that ONE bound field: the corrupt-state audit line
// (quarantineCorruptState) and the statusRun wire diagnosis
// (corrupt_state.parse_error). Both are now bounded by construction: the bind
// lives once, at corruptStateError itself, so neither consumer needs its own.
//
// DISCLOSED, NOT HIDDEN, LIMIT ON THIS ARM: empirically verified against this
// runtime's own Node/V8 (see the probing this ticket performed before writing
// this file), JSON.parse's SyntaxError already truncates any quoted input
// snippet to ~10 characters and substitutes a non-printable/bidi byte at that
// position with U+FFFD itself, BEFORE boundedGateSummary ever runs -- so this
// specific arm cannot be driven RED on a tree without the corruptStateError
// bind (the precondition also requires filesystem write access to
// active.json, which the write hook denies every agent). That matches this
// item's own recorded severity (LOW, pre-existing). The remediation-test
// contract this ticket carries explicitly does not require red evidence, so
// this arm pins the CURRENT, CORRECT contract -- a single bounded value
// shared by both sinks -- as the regression fence the review's blocking
// finding asked for, rather than fabricate a misleading red phase this
// engine cannot produce.
describe('APE v2 corrupt-state parse_error is bounded once and shared by every sink (roadmap sink-guard-coverage-and-detection-completeness, ITEM 3)', () => {
  it('parse_error is a bounded (<=400 chars), bidi-neutralized string at both the overrides.ndjson audit line and the statusRun wire diagnosis', async () => {
    const dir = await project();
    const paths = runtimePaths(dir);
    await mkdir(paths.runtime, { recursive: true });
    // The bidi byte sits at the very front of the corrupt bytes -- the one
    // position V8's own truncated context snippet could still show it.
    await writeFile(paths.active, `${BIDI_RIGHT_TO_LEFT_OVERRIDE}not valid JSON at all, by design`);

    const status = await statusRun(dir);
    expect(status).toMatchObject({ ok: false, active: false, run: null });
    expect(typeof status.corrupt_state.parse_error).toBe('string');
    expect(status.corrupt_state.parse_error.length).toBeLessThanOrEqual(400);
    expect(status.corrupt_state.parse_error).not.toContain(BIDI_RIGHT_TO_LEFT_OVERRIDE);

    const reset = await overrideRun(dir, 'reset', 'clear corrupt state to inspect the audited parse_error');
    expect(reset).toMatchObject({ ok: true, recovered: 'corrupt-state', run: null });
    const line = overrideLines(paths).find((entry) => entry.corrupt_state === true);
    expect(line).toBeDefined();
    expect(typeof line.parse_error).toBe('string');
    expect(line.parse_error.length).toBeLessThanOrEqual(400);
    expect(line.parse_error).not.toContain(BIDI_RIGHT_TO_LEFT_OVERRIDE);
  });
});

// ITEM 4 (this run, roadmap entry sink-guard-coverage-and-detection-
// completeness): applyActions' audit_override handler (service.js) used to
// persist a BOUNDED reason to overrides.ndjson but echo the reducer's own
// frozen action object -- carrying the caller's RAW reason -- back onto the
// wire (`emitted.push(action)`). Checked before binding this: no existing
// test pins this response's audit_override reason by exact value (every
// pinned assertion targets the PERSISTED overrides.ndjson line, e.g.
// runtime-v2-fixer-expire-dispatch.test.js and runtime-v2-ship.test.js), so
// closing the asymmetry disturbs no pinned wire behavior. abort/override
// reasons are caller-supplied, so this particular echo leaked nothing NEW;
// expire-dispatch/ship reasons can originate from a subagent's receipt and
// this response is read by the orchestrator, which is why the fix binds the
// wire copy too, from the SAME boundedGateSummary call that feeds the
// persisted line -- a new object, never a mutation of the reducer's frozen
// action.
describe('APE v2 override response audit_override action echoes the SAME bounded reason as overrides.ndjson (roadmap sink-guard-coverage-and-detection-completeness, ITEM 4)', () => {
  it('an override-abort response bounds its audit_override action reason instead of echoing the raw operator string', async () => {
    const dir = await project();
    const started = await startRun(dir, startInput());
    expect(started.ok).toBe(true);
    const reason = longReasonCarryingBidi();
    expect(reason.length).toBeGreaterThan(1000);

    const result = await overrideRun(dir, 'abort', reason);
    expect(result.ok).toBe(true);

    const auditAction = result.actions.find((action) => action.type === 'audit_override');
    expect(auditAction).toBeDefined();
    // The live defect: on the unfixed tree this echoed action.reason at its
    // full ~1200-char length, still carrying the raw bidi-override byte, even
    // though the persisted overrides.ndjson copy below was already bounded.
    expect(typeof auditAction.reason).toBe('string');
    expect(auditAction.reason.length).toBeLessThanOrEqual(400);
    expect(auditAction.reason).not.toContain(BIDI_RIGHT_TO_LEFT_OVERRIDE);

    const paths = runtimePaths(dir);
    const line = overrideLines(paths).find((entry) => entry.operation === 'abort');
    expect(line).toBeDefined();
    // Persisted and wire copies must be the IDENTICAL bounded string -- one
    // boundedGateSummary call feeds both sinks, not two independent binds
    // that could silently diverge.
    expect(line.reason).toBe(auditAction.reason);
  });

  // Guard, not a red arm: a short, plain-ASCII reason still reaches the
  // response unchanged (mirrors the sibling persisted-line guards above;
  // runtime-v2-ship.test.js's own pin on the REDUCER's action.reason reads
  // the action before applyActions runs, so it is untouched by this bind).
  it('a short, plain-ASCII override reason still reaches the audit_override response unchanged', async () => {
    const dir = await project();
    await startRun(dir, startInput());
    const reason = 'operator override, no long text supplied';

    const result = await overrideRun(dir, 'abort', reason);
    expect(result.ok).toBe(true);
    const auditAction = result.actions.find((action) => action.type === 'audit_override');
    expect(auditAction.reason).toBe(reason);
  });
});
