import { execFileSync } from 'node:child_process';
import { access, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

// MERGED archive chain crash-idempotency (roadmap merged-archive-idempotency;
// MEDIUM finding 1.2 in docs/research/2026-07-19-runtime-audit.md; invariants
// 7/8).
//
// The MERGED reducer chain is [transition completed, archive_history,
// release_lock, persist_state] (scheduler.js), and the first-pass archive is
// PLAIN — neither superseding nor if_absent. The immutable history record
// hashes the whole merge object, but that object is NOT stable across a
// crash-retry: a runtime-performed merge stamps merged_at from the local clock
// (gates.js in-call merge and poll-phase merge), while a retry that re-observes
// the already-merged PR builds a different object — merged_at taken from
// GitHub's mergedAt, plus (on the poll path) provenance:'observed-external'.
// A crash between archive_history and persist_state therefore leaves
// active.json at 'shipping' with a live shipping_watch while history already
// holds the completed record; the next `ape_run next` re-observes MERGED,
// re-enters the chain, and archiveRun throws 'immutable history record already
// exists' on every retry. Override reset refuses a shipping run, so a genuinely
// merged run can only be sealed as aborted while history says completed
// (invariant 8).
//
// Crash simulation: the crash window is reproduced EXACTLY on disk by driving
// the real poll-phase merge once (history record archived, lock released) and
// then restoring active.json to the pre-call shipping bytes. Nothing else the
// chain touches before persist_state distinguishes the two states: the last
// persist before the chain wrote the seeded bytes, and the remote_ci_ms
// accumulation lives only in process memory, which the crash loses.
//
// Ship (GitHub) is the only runtime-owned side effect these behavioral tests
// must not perform for real: the bounded remote-checks poll is mocked with the
// exact discriminated shapes gates.js documents; the NEXT reducer, the MERGED
// chain, archiveRun, and persistence all run genuinely.
vi.mock('../lib/runtime/gates.js', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    autoMergeGithub: vi.fn(),
    pollRemoteChecksAndMerge: vi.fn(),
  };
});
import { pollRemoteChecksAndMerge, autoMergeGithub } from '../lib/runtime/gates.js';
import { nextRun } from '../lib/runtime/service.js';
import { queryHistory, selectEffectiveRecord } from '../lib/runtime/history.js';
import { currentTreeSha } from '../lib/runtime/git.js';
import { runtimePaths } from '../lib/runtime/paths.js';
import { atomicWriteJson, readJson } from '../lib/runtime/storage.js';

// Real filesystem + git work; keep the slow-but-honest tests off the 15s
// default, and let teardown ride out win32 EBUSY.
vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

const cleanups = [];
afterEach(async () => {
  pollRemoteChecksAndMerge.mockReset();
  autoMergeGithub.mockReset();
  await Promise.all(
    cleanups
      .splice(0)
      .map((dir) => rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })),
  );
});

function git(cwd, ...args) {
  execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' },
  });
}

function exists(file) {
  return access(file).then(() => true, () => false);
}

const PR_URL = 'https://github.com/acme/repo/pull/7';
const HEAD_OID = 'c'.repeat(40);
const RUN_CREATED_AT = '2026-07-18T10:00:00.000Z';
// What the runtime-performed merge stamped from the LOCAL clock pre-crash...
const RUNTIME_MERGED_AT = '2026-07-18T10:20:00.000Z';
// ...and what GitHub's mergedAt reports for the SAME merge on the retry probe
// (GitHub serves second-resolution timestamps, so even a perfectly synced
// clock cannot reproduce the local stamp).
const GITHUB_MERGED_AT = '2026-07-18T10:19:58Z';

// The runtime-performed poll-phase merge shape (no provenance key).
function runtimePerformedMerge() {
  return {
    provider: 'github',
    url: PR_URL,
    branch: 'ape/phase-merge',
    base: 'main',
    merged_at: RUNTIME_MERGED_AT,
  };
}

// The retry's re-observation of the already-merged PR at the attested head:
// merged_at comes from GitHub and the poll path marks it observed-external.
function observedExternalMerge() {
  return {
    provider: 'github',
    url: PR_URL,
    branch: 'ape/phase-merge',
    base: 'main',
    merged_at: GITHUB_MERGED_AT,
    provenance: 'observed-external',
  };
}

// A run resting in the non-blocking shipping watch — the state the poll phase
// re-enters from, and exactly what a crash between archive_history and
// persist_state leaves in active.json. Mirrors the gating-watch suite's seeded
// state shape.
function shippingState(runId, tree) {
  return {
    version: 2,
    schema_version: '2.0.0',
    run_id: runId,
    status: 'shipping',
    stage: 'merge',
    block_reason: null,
    objective: 'Ship the value bump through the non-blocking watch',
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
    requirements: ['R-merged-archive'],
    risk_triggers: [],
    branch: 'ape/phase-merge',
    base_commit_sha: 'a'.repeat(40),
    tree_sha: tree,
    tickets: [],
    receipts: [{
      receipt_hash: 'a',
      previous_receipt_hash: null,
      status: 'passed',
      agent: { host: 'codex', role: 'implementer' },
      tests: [{ passed: true }],
      changed_files: ['src/value.js'],
      head_tree_sha: tree,
    }],
    attempts: {},
    remediation_cycles: 0,
    regate_attempts: 0,
    gates: { passed: true, tree_sha: tree },
    timing: { test_ms: 1_000, remote_ci_ms: 0 },
    shipping_watch: {
      provider: 'github',
      pr_url: PR_URL,
      branch: 'ape/phase-merge',
      base: 'main',
      head_oid: HEAD_OID,
      created_at: RUN_CREATED_AT,
      last_poll_at: null,
      poll_count: 0,
      last_checks_summary: null,
    },
    created_at: RUN_CREATED_AT,
    updated_at: RUN_CREATED_AT,
  };
}

async function seedShippingRun(runId) {
  const dir = await mkdtemp(path.join(tmpdir(), 'ape-merged-idem-'));
  cleanups.push(dir);
  await mkdir(path.join(dir, 'src'));
  await writeFile(path.join(dir, 'src', 'value.js'), 'export const value = 2;\n');
  git(dir, 'init', '-q');
  git(dir, 'config', 'user.email', 'ape@example.test');
  git(dir, 'config', 'user.name', 'APE Test');
  git(dir, 'add', '.');
  git(dir, 'commit', '-qm', 'test: baseline');
  const paths = runtimePaths(dir);
  await atomicWriteJson(paths.config, {
    shipping: { provider: 'github', auto_merge: true, required_remote_checks: true },
  });
  const state = shippingState(runId, await currentTreeSha(dir));
  await atomicWriteJson(paths.active, state);
  return { dir, paths, state };
}

// nextRun currently rejects when archiveRun throws on the retry; fold a throw
// into a refusal-shaped result so the red assertion shows the wedge message.
function callNext(dir) {
  return nextRun(dir).catch((error) => ({ ok: false, thrown: error.message }));
}

// Drive the REAL pre-crash merge (archive lands, lock releases, state seals),
// then reproduce the crash window by restoring the pre-call shipping bytes.
async function mergeThenCrash(runId, preCrashMerge) {
  const { dir, paths, state } = await seedShippingRun(runId);
  pollRemoteChecksAndMerge.mockResolvedValueOnce({ merged: preCrashMerge });
  const merged = await callNext(dir);
  // Setup sanity (true on the current tree): the uninterrupted poll merge
  // completes the run and archives the plain first-pass record.
  expect(merged).toMatchObject({ ok: true });
  expect(merged.run.status).toBe('completed');
  const primaryBefore = await readJson(path.join(paths.history, `${runId}.json`));
  expect(primaryBefore.status).toBe('completed');
  expect(primaryBefore.merge.url).toBe(PR_URL);
  // The crash: persist_state never ran, so active.json still holds the
  // shipping state with its live watch; the archive and the lock release are
  // already durable.
  await atomicWriteJson(paths.active, state);
  return { dir, paths, primaryBefore };
}

describe('APE v2 MERGED archive chain crash-idempotency (audit 1.2, invariants 7/8)', () => {
  it('converges a crash-retry that re-observes the merged PR (observed-external provenance) instead of wedging on the immutable record', async () => {
    const runId = 'run-merged-idem-a';
    const { dir, paths, primaryBefore } = await mergeThenCrash(runId, runtimePerformedMerge());

    // The retry re-observes the already-merged PR at the attested head: same
    // merge, but merged_at now comes from GitHub and the poll path marks it
    // observed-external. On the current tree archiveRun throws 'immutable
    // history record already exists' here — on every retry.
    pollRemoteChecksAndMerge.mockResolvedValueOnce({ merged: observedExternalMerge() });
    const retry = await callNext(dir);

    // Red anchor: the retry must converge, not wedge (the current tree throws
    // the immutable-record error here, surfaced as retry.thrown).
    expect(retry.thrown ?? null).toBeNull();
    expect(retry).toMatchObject({ ok: true });
    expect(retry.run.status).toBe('completed');
    expect(retry.run.stage).toBe('complete');

    // The run seals truthfully: active state and immutable history agree
    // (invariant 8), and the live watch is gone.
    const active = await readJson(paths.active);
    expect(active.status).toBe('completed');
    expect(active.shipping_watch ?? null).toBe(null);
    expect(active.merge?.url).toBe(PR_URL);
    const records = await queryHistory(paths, { run_id: runId });
    expect(records.length).toBeGreaterThan(0);
    const effective = selectEffectiveRecord(records[0], records.slice(1));
    expect(effective.status).toBe('completed');
    expect(effective.merge?.url).toBe(PR_URL);

    // Immutable means immutable: the first-write record was not rewritten by
    // the retry's volatile provenance.
    const primaryAfter = await readJson(path.join(paths.history, `${runId}.json`));
    expect(primaryAfter).toEqual(primaryBefore);

    // One active writer, atomic state (invariant 7): the converged run holds
    // no lock, and a further next is the ordinary sealed-run refusal, not a
    // re-entry into the archive chain.
    expect(await exists(paths.lock)).toBe(false);
    const echoed = await callNext(dir);
    expect(echoed.ok).toBe(false);
    expect(echoed.reason ?? echoed.thrown).toMatch(/completed/);
    expect(await readJson(path.join(paths.history, `${runId}.json`))).toEqual(primaryBefore);
  });

  it('converges a merged_at-only drift too (in-call merge pre-crash, probe re-observation retry, no provenance key)', async () => {
    const runId = 'run-merged-idem-b';
    // required_remote_checks=false pre-crash shape: the in-call merge stamps
    // merged_at from the local clock, no provenance key.
    const { dir, paths, primaryBefore } = await mergeThenCrash(runId, runtimePerformedMerge());

    // The retry's MERGED-probe arm adopts the merged PR with GitHub's
    // mergedAt and ALSO carries no provenance key: the only drift is the
    // volatile timestamp itself.
    const probeMerge = runtimePerformedMerge();
    probeMerge.merged_at = GITHUB_MERGED_AT;
    pollRemoteChecksAndMerge.mockResolvedValueOnce({ merged: probeMerge });
    const retry = await callNext(dir);

    // Red anchor: convergence must not hinge on the provenance key — the
    // wall-clock timestamp alone must never wedge a genuinely merged run (the
    // current tree throws the immutable-record error here too).
    expect(retry.thrown ?? null).toBeNull();
    expect(retry).toMatchObject({ ok: true });
    expect(retry.run.status).toBe('completed');
    const active = await readJson(paths.active);
    expect(active.status).toBe('completed');
    const records = await queryHistory(paths, { run_id: runId });
    const effective = selectEffectiveRecord(records[0], records.slice(1));
    expect(effective.status).toBe('completed');
    expect(await readJson(path.join(paths.history, `${runId}.json`))).toEqual(primaryBefore);
    expect(await exists(paths.lock)).toBe(false);
  });

  it('still fails closed when the retry evidence drifts on a STABLE field: a different PR never converges silently over the attested record', async () => {
    const runId = 'run-merged-idem-c';
    const { dir, paths, primaryBefore } = await mergeThenCrash(runId, runtimePerformedMerge());

    // Not this run's merge: the stable identity (PR url) differs, so this is
    // external interference, not a crash-retry of the archived merge.
    // Convergence must be scoped to the VOLATILE provenance fields only —
    // adopting this evidence would seal a completion history never attested
    // (invariant 8).
    const foreign = observedExternalMerge();
    foreign.url = 'https://github.com/acme/repo/pull/999';
    pollRemoteChecksAndMerge.mockResolvedValueOnce({ merged: foreign });
    const retry = await callNext(dir);

    // Never a silent completion sealed on drifted stable evidence.
    expect(retry.ok === true && retry.run?.status === 'completed').toBe(false);

    // The immutable record keeps the attested merge, byte for byte.
    const primaryAfter = await readJson(path.join(paths.history, `${runId}.json`));
    expect(primaryAfter.merge.url).toBe(PR_URL);
    expect(primaryAfter.record_hash).toBe(primaryBefore.record_hash);
  });
});
