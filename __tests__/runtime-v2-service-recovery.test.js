import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { access, mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { acquireRunLock } from '../lib/runtime/lock.js';
import {
  abortRun,
  nextRun,
  overrideRun,
  resumeRun,
  startRun,
  statusRun,
} from '../lib/runtime/service.js';
import { runtimePaths } from '../lib/runtime/paths.js';

// In-session corrupt-state recovery (follow-up to #241): every ape_run entry
// point that reads state calls activeState -> readJson(paths.active, null),
// which today rethrows a bare SyntaxError when .ape/runtime/active.json exists
// but is unparseable, BEFORE any reset/null-check arm. These behavioral tests
// pin the target contract: override reset QUARANTINES the corrupt bytes to a
// forensic file (never deletes them), writes the mandatory audit line, clears
// any run lock, and leaves the runtime startable; statusRun reports a
// structured diagnosis instead of throwing; next/resume/abort still refuse but
// with an actionable error naming override reset; and a non-reset override does
// not quarantine. R1-R6 are RED on the base tree (the raw parse exception
// escapes); the guard is GREEN today and must stay GREEN (arm ordering).

const CORRUPT = '{ corrupt';

const cleanups = [];
afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

function exists(file) {
  return access(file).then(() => true, () => false);
}

function git(cwd, ...args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

// Modeled on runtime-v2-lock-protocol.test.js's project(): a real temp git repo
// with one commit plus a runtime config, so startRun (R3) has a committed tree
// and a loadable config to work against.
async function project() {
  const dir = await mkdtemp(path.join(tmpdir(), 'ape-service-recovery-'));
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

// Plant an unparseable active.json (file present, not valid JSON) in the
// runtime dir — the exact state a crash mid-write or a hand-edit leaves behind.
async function corrupt(dir) {
  const paths = runtimePaths(dir);
  await mkdir(paths.runtime, { recursive: true });
  await writeFile(paths.active, CORRUPT);
  return paths;
}

function startInput() {
  return {
    objective: 'Change behavior after recovery',
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

// Resolve to the rejection reason, or fail loudly if the call unexpectedly
// resolves — next/resume/abort on corrupt state must reject, never silently
// return, so a resolution is itself a contract violation for R5.
async function rejection(promise) {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error('expected the call to reject on corrupt state, but it resolved');
}

function overrideLines(paths) {
  return readFileSync(paths.overrideLog, 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line));
}

function forensicFiles(files) {
  return files.filter((file) => /^active\.json\.corrupt-\d+$/.test(file));
}

describe('APE v2 in-session corrupt-state recovery (invariants 7/8)', () => {
  it('R1: override reset quarantines an unparseable active.json with an audit line', async () => {
    const dir = await project();
    const paths = await corrupt(dir);
    const reason = 'clear corrupt state after crash';

    const reset = await overrideRun(dir, 'reset', reason);
    expect(reset).toMatchObject({ ok: true, recovered: 'corrupt-state', run: null });

    // The live state path is gone (moved aside), not merely deleted.
    expect(await exists(paths.active)).toBe(false);

    // Exactly one forensic file, holding the ORIGINAL corrupt bytes verbatim —
    // quarantine preserves evidence, it never destroys the corrupt payload.
    const forensic = forensicFiles(await readdir(paths.runtime));
    expect(forensic).toHaveLength(1);
    expect(readFileSync(path.join(paths.runtime, forensic[0]), 'utf8')).toBe(CORRUPT);

    // The audited ownership change is recorded: operation, corrupt-state flag,
    // the operator's reason, and where the bytes were quarantined.
    expect(overrideLines(paths)).toContainEqual(expect.objectContaining({
      operation: 'reset',
      corrupt_state: true,
      reason,
      quarantined_to: expect.stringMatching(/active\.json\.corrupt-\d+/),
    }));
  });

  it('R2: reset on corrupt state clears an associated run lock and removes status.md', async () => {
    const dir = await project();
    const paths = await corrupt(dir);
    await acquireRunLock(paths.lock, 'run-corrupt');
    const statusDoc = path.join(paths.runtime, 'status.md');
    await writeFile(statusDoc, '# APE run in progress\n');

    const reset = await overrideRun(dir, 'reset', 'clear corrupt state and its lock');
    expect(reset).toMatchObject({ ok: true, recovered: 'corrupt-state' });

    // The run lock is released and the stale projection is gone.
    expect(await exists(paths.lock)).toBe(false);
    expect(await exists(statusDoc)).toBe(false);
  });

  it('R3: startRun succeeds after a corrupt-state reset leaves the runtime startable', async () => {
    const dir = await project();
    await corrupt(dir);

    const reset = await overrideRun(dir, 'reset', 'recover before restarting');
    expect(reset.ok).toBe(true);

    const started = await startRun(dir, startInput());
    expect(started.ok).toBe(true);
  });

  it('R4: statusRun reports a structured corrupt-state diagnosis instead of throwing', async () => {
    const dir = await project();
    await corrupt(dir);

    const status = await statusRun(dir);
    expect(status).toMatchObject({ ok: false, active: false, run: null });
    expect(status.corrupt_state.file).toEqual(expect.any(String));
    expect(status.corrupt_state.parse_error).toBeTruthy();
    // The diagnosis points the operator at the recovery lever by name.
    expect(status.reason).toMatch(/override/i);
    expect(status.reason).toMatch(/reset/i);
  });

  it('R5: next/resume/abort on corrupt state reject with an actionable recovery message', async () => {
    const dir = await project();
    await corrupt(dir);

    const nextErr = await rejection(nextRun(dir));
    expect(nextErr.message).toMatch(/override/i);
    expect(nextErr.message).toMatch(/reset/i);

    const resumeErr = await rejection(resumeRun(dir));
    expect(resumeErr.message).toMatch(/override/i);
    expect(resumeErr.message).toMatch(/reset/i);

    const abortErr = await rejection(abortRun(dir, 'try to abort a corrupt run'));
    expect(abortErr.message).toMatch(/override/i);
    expect(abortErr.message).toMatch(/reset/i);
  });

  it('R6: override abort on corrupt state refuses and never quarantines', async () => {
    const dir = await project();
    const paths = await corrupt(dir);

    const result = await overrideRun(dir, 'abort', 'try to abort a corrupt run');
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/reset/i);

    // A non-reset override leaves the corrupt bytes exactly where they were —
    // no silent quarantine, no forensic file.
    expect(await exists(paths.active)).toBe(true);
    expect(readFileSync(paths.active, 'utf8')).toBe(CORRUPT);
    expect(forensicFiles(await readdir(paths.runtime))).toHaveLength(0);
  });

  it('guard: reset with neither active.json nor lock still reports no active run (green today and after)', async () => {
    const dir = await project();
    const paths = runtimePaths(dir);
    await mkdir(paths.runtime, { recursive: true });

    const result = await overrideRun(dir, 'reset', 'nothing to clear');
    expect(result).toEqual({ ok: false, reason: 'no active run' });
  });
});

// Follow-up 2 (same defect class as the T16 unparseable arm above): activeState
// today tags ONLY a JSON.parse SyntaxError as APE_CORRUPT_ACTIVE_STATE, so an
// active.json that parses cleanly but is NOT a run state — a non-object like 42,
// or an object with no string run_id like {} — flows straight into the reducers.
// The operator then gets a misleading reducer refusal instead of the honest
// corrupt-state diagnosis, and override reset never quarantines it. These tests
// pin the schema-invalid arm to behave EXACTLY like the unparseable arm: after a
// successful parse activeState validates the minimal shape and, on failure,
// throws a corruptStateError VARIANT — same APE_CORRUPT_ACTIVE_STATE code and
// file, but a distinct 'schema-invalid'-flavored message (the existing
// unparseable message pinned by R1-R6 above must stay byte-stable). So statusRun
// diagnoses, next/resume/abort refuse actionably, and override reset quarantines,
// all for free. Every S* test is RED on the base tree ({}/42 reach the reducers)
// and must not disturb the pinned unparseable-arm assertions above.
describe('APE v2 in-session recovery for a schema-invalid active.json (follow-up 2, invariants 7/8)', () => {
  const SCHEMA_INVALID = ['{}', '42'];

  // Plant a parseable-but-schema-invalid active.json: valid JSON, but not a run
  // state object carrying a string run_id — the shape a truncated/hand-edited
  // write or a schema drift leaves behind.
  async function invalid(dir, body) {
    const paths = runtimePaths(dir);
    await mkdir(paths.runtime, { recursive: true });
    await writeFile(paths.active, body);
    return paths;
  }

  for (const body of SCHEMA_INVALID) {
    it(`S4[${body}]: statusRun reports a structured corrupt-state diagnosis instead of admitting the invalid state`, async () => {
      const dir = await project();
      await invalid(dir, body);

      const status = await statusRun(dir);
      expect(status).toMatchObject({ ok: false, active: false, run: null });
      expect(status.corrupt_state.file).toEqual(expect.any(String));
      expect(status.corrupt_state.parse_error).toBeTruthy();
      // The diagnosis points the operator at the recovery lever by name.
      expect(status.reason).toMatch(/override/i);
      expect(status.reason).toMatch(/reset/i);
    });

    it(`S5[${body}]: next/resume/abort reject with the APE_CORRUPT_ACTIVE_STATE schema-invalid variant naming override reset`, async () => {
      const dir = await project();
      await invalid(dir, body);

      // Same tag as the unparseable arm (so every existing consumer works), but
      // a schema-invalid-flavored message; assert on the stable code plus the
      // 'schema-invalid' and reset substrings, never the whole sentence.
      const nextErr = await rejection(nextRun(dir));
      expect(nextErr.code).toBe('APE_CORRUPT_ACTIVE_STATE');
      expect(nextErr.message).toMatch(/schema-invalid/i);
      expect(nextErr.message).toMatch(/reset/i);

      const resumeErr = await rejection(resumeRun(dir));
      expect(resumeErr.code).toBe('APE_CORRUPT_ACTIVE_STATE');
      expect(resumeErr.message).toMatch(/schema-invalid/i);
      expect(resumeErr.message).toMatch(/reset/i);

      const abortErr = await rejection(abortRun(dir, 'try to abort a schema-invalid run'));
      expect(abortErr.code).toBe('APE_CORRUPT_ACTIVE_STATE');
      expect(abortErr.message).toMatch(/schema-invalid/i);
      expect(abortErr.message).toMatch(/reset/i);
    });

    it(`S1[${body}]: override reset quarantines a schema-invalid active.json with an audit line`, async () => {
      const dir = await project();
      const paths = await invalid(dir, body);
      const reason = 'clear schema-invalid state after crash';

      const reset = await overrideRun(dir, 'reset', reason);
      expect(reset).toMatchObject({ ok: true, recovered: 'corrupt-state', run: null });

      // Bytes moved aside, not deleted: exactly one forensic file holding the
      // ORIGINAL schema-invalid payload verbatim.
      expect(await exists(paths.active)).toBe(false);
      const forensic = forensicFiles(await readdir(paths.runtime));
      expect(forensic).toHaveLength(1);
      expect(readFileSync(path.join(paths.runtime, forensic[0]), 'utf8')).toBe(body);

      // The same audited quarantine line the unparseable arm writes.
      expect(overrideLines(paths)).toContainEqual(expect.objectContaining({
        operation: 'reset',
        corrupt_state: true,
        reason,
        quarantined_to: expect.stringMatching(/active\.json\.corrupt-\d+/),
      }));
    });

    it(`S3[${body}]: startRun succeeds after a schema-invalid reset leaves the runtime startable`, async () => {
      const dir = await project();
      await invalid(dir, body);

      const reset = await overrideRun(dir, 'reset', 'recover before restarting');
      expect(reset.ok).toBe(true);

      const started = await startRun(dir, startInput());
      expect(started.ok).toBe(true);
    });
  }
});

// Session-3 nit: the statusRun and non-reset-override corrupt-state RESPONSE
// reasons hardcode "corrupt and unparseable" for BOTH the unparseable arm and
// the schema-invalid arm, so a schema-invalid active.json ({} / 42) is reported
// with the wrong cause (it parses fine — it is not unparseable). The wording
// must be variant-aware: the schema-invalid reason names the schema-invalid
// cause and never claims "unparseable", while the unparseable arm's reason stays
// byte-stable (still says "unparseable"). Both W1/W2 are RED on the base tree
// (the schema-invalid reason says "unparseable"); W3 is a green guard.
describe('APE v2 corrupt-state RESPONSE wording is variant-aware (session-3 nit)', () => {
  // Plant a parseable-but-schema-invalid active.json (valid JSON, not a run
  // state object carrying a string run_id).
  async function invalid(dir, body) {
    const paths = runtimePaths(dir);
    await mkdir(paths.runtime, { recursive: true });
    await writeFile(paths.active, body);
    return paths;
  }

  for (const body of ['{}', '42']) {
    it(`W1[${body}]: statusRun names the schema-invalid cause and never "unparseable"`, async () => {
      const dir = await project();
      await invalid(dir, body);

      const status = await statusRun(dir);
      expect(status.ok).toBe(false);
      expect(status.reason).toMatch(/schema-invalid/i);
      expect(status.reason).not.toMatch(/unparseable/i);
      // Still points at the recovery lever.
      expect(status.reason).toMatch(/override/i);
      expect(status.reason).toMatch(/reset/i);
    });

    it(`W2[${body}]: a non-reset override names the schema-invalid cause and never "unparseable"`, async () => {
      const dir = await project();
      await invalid(dir, body);

      const result = await overrideRun(dir, 'abort', 'try to abort a schema-invalid run');
      expect(result.ok).toBe(false);
      expect(result.reason).toMatch(/schema-invalid/i);
      expect(result.reason).not.toMatch(/unparseable/i);
      expect(result.reason).toMatch(/reset/i);
    });
  }

  it('W3: the unparseable arm keeps its byte-stable "unparseable" statusRun and override wording', async () => {
    const dir = await project();
    await corrupt(dir);

    const status = await statusRun(dir);
    expect(status.reason).toMatch(/unparseable/i);

    const result = await overrideRun(dir, 'abort', 'try to abort a corrupt run');
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/unparseable/i);
  });
});
