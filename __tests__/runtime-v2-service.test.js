import { execFileSync } from 'node:child_process';
import { access, mkdtemp, mkdir, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
// Ship (GitHub) is the only runtime-owned side effect these behavioral tests
// must not perform for real: the bounded remote-checks poll is mocked while the
// rest of the service runs genuinely. importOriginal keeps runMergeGates and
// autoMergeGithub real for the existing suites (none of which reach shipping).
vi.mock('../lib/runtime/gates.js', async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, autoMergeGithub: vi.fn(), pollRemoteChecksAndMerge: vi.fn() };
});
import {
  abortRun,
  expireDispatch,
  nextRun,
  overrideRun,
  recordReceipt,
  regateRun,
  resumeRun,
  startRun,
  statusRun,
} from '../lib/runtime/service.js';
import { autoMergeGithub, pollRemoteChecksAndMerge } from '../lib/runtime/gates.js';
import { applyActions } from '../lib/runtime/receipt-service.js';
import { sha256 } from '../lib/runtime/canonical.js';
import { queryHistory } from '../lib/runtime/history.js';
import { acquireRunLock } from '../lib/runtime/lock.js';
import { runtimePaths } from '../lib/runtime/paths.js';
import { projectRunResponse, RESPONSE_BUDGET_BYTES } from '../lib/runtime/projection.js';
import { finalizeTicket } from '../lib/runtime/schemas.js';
import { atomicWriteJson, readJson } from '../lib/runtime/storage.js';

function exists(file) {
  return access(file).then(() => true, () => false);
}

const cleanups = [];
afterEach(async () => {
  pollRemoteChecksAndMerge.mockReset();
  autoMergeGithub.mockReset();
  await Promise.all(cleanups.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

function git(cwd, ...args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

async function project() {
  const dir = await mkdtemp(path.join(tmpdir(), 'ape-service-'));
  cleanups.push(dir);
  await mkdir(path.join(dir, 'src'));
  await mkdir(path.join(dir, 'tests'));
  await writeFile(path.join(dir, 'src', 'value.js'), 'export const value = 1;\n');
  await writeFile(path.join(dir, 'tests', 'value.test.js'), 'throw new Error("red");\n');
  git(dir, 'init', '-q');
  git(dir, 'config', 'user.email', 'ape@example.test');
  git(dir, 'config', 'user.name', 'APE Test');
  git(dir, 'add', '.');
  git(dir, 'commit', '-qm', 'test: baseline');
  const paths = runtimePaths(dir);
  await atomicWriteJson(paths.config, {
    shipping: { auto_merge: false, provider: 'github', required_remote_checks: false },
    test_commands: { targeted_template: 'node --test {paths}', full: 'node --test' },
  });
  return dir;
}

function receipt(ticket, overrides = {}) {
  return {
    ticket_id: ticket.ticket_id,
    status: 'passed',
    agent_identity: `agent-${ticket.role}`,
    tests: [],
    findings: [],
    evidence: { verdict: 'pass' },
    timing: {
      started_at: ticket.issued_at,
      completed_at: new Date(Date.parse(ticket.issued_at) + 10).toISOString(),
      duration_ms: 10,
    },
    ...overrides,
  };
}

describe('APE v2 service integration', () => {
  it('blocks before write when hooks or subagents are unavailable', async () => {
    const dir = await project();
    const result = await startRun(dir, {
      objective: 'Change behavior',
      mode: 'phase',
      lane: 'fast',
      host: 'codex',
      claimed_paths: ['src/value.js'],
      test_paths: ['tests/value.test.js'],
      requirements: [],
      risk_triggers: [],
      behavioral: true,
      hooks_trusted: false,
      subagents_available: true,
      explicit_invocation: true,
    });
    expect(result).toMatchObject({ ok: false, blocked: true });
    expect((await statusRun(dir)).active).toBe(false);
  });

  it('keeps every issued ticket objective byte-identical to the immutable run objective', async () => {
    // Friction #8: agents must discover the shell-policy allowlist from the
    // ticket itself, not by trial-and-error denial. The list sits BEFORE the
    // `Run objective:` suffix so the wire projection's objective dedup keeps
    // matching.
    const dir = await project();
    const started = await startRun(dir, {
      objective: 'Change behavior',
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
    });
    expect(started.ok, JSON.stringify({ reason: started.reason, blocking: started.readiness?.blocking })).toBe(true);
    const objective = started.run.tickets[0].objective;
    expect(objective).toBe('Change behavior');
  });

  it('persists tickets, validates role-separated receipts, and advances deterministically', async () => {
    const dir = await project();
    const started = await startRun(dir, {
      objective: 'Change behavior',
      mode: 'phase',
      lane: 'fast',
      host: 'codex',
      claimed_paths: ['src/value.js'],
      test_paths: ['tests/value.test.js'],
      requirements: ['R1'],
      risk_triggers: [],
      behavioral: true,
      hooks_trusted: true,
      subagents_available: true,
      explicit_invocation: true,
    });
    expect(started.ok).toBe(true);
    const testTicket = started.run.tickets[0];
    expect(testTicket.role).toBe('test_writer');
    const resumed = await resumeRun(dir);
    expect(resumed.actions[0]).toMatchObject({
      type: 'dispatch_agent',
      ticket: { ticket_id: testTicket.ticket_id },
    });

    await writeFile(path.join(dir, 'tests', 'value.test.js'), 'throw new Error("still red");\n');
    const testResult = await recordReceipt(dir, receipt(testTicket, {
      tests: [{ command: 'node tests/value.test.js', passed: false, exit_code: 1, duration_ms: 1 }],
    }));
    expect(testResult.ok).toBe(true);
    // An identical retry of a committed receipt (e.g. a lost response) must
    // return the recorded receipt idempotently instead of rejecting (F15).
    const replay = await recordReceipt(dir, receipt(testTicket, {
      tests: [{ command: 'node tests/value.test.js', passed: false, exit_code: 1, duration_ms: 1 }],
    }));
    expect(replay).toMatchObject({ ok: true, idempotent: true });
    expect(replay.receipt.receipt_id).toBe(testResult.receipt.receipt_id);
    expect(replay.run.receipts).toHaveLength(1);
    // A *different* payload for the same ticket is a conflicting replay, not
    // an idempotent retry, and still rejects against the durable transaction.
    const conflicting = await recordReceipt(dir, receipt(testTicket, {
      tests: [{ command: 'node tests/value.test.js', passed: false, exit_code: 2, duration_ms: 2 }],
    }));
    expect(conflicting).toMatchObject({ ok: false, rejected: true });
    expect(conflicting.errors).toContain('receipt replay conflicts with the durable ticket transaction');
    const implementer = testResult.run.tickets.at(-1);
    expect(implementer.role).toBe('implementer');

    await writeFile(path.join(dir, 'src', 'value.js'), 'export const value = 2;\n');
    const buildResult = await recordReceipt(dir, receipt(implementer, {
      tests: [{ command: 'node --test', passed: true, exit_code: 0, duration_ms: 1 }],
    }));
    expect(buildResult.ok).toBe(true);
    expect(buildResult.run.tickets.at(-1).role).toBe('reviewer');

    const aborted = await abortRun(dir, 'integration test cleanup');
    expect(aborted.run.status).toBe('aborted');
    const status = await statusRun(dir);
    expect(status).toMatchObject({ ok: true, active: false, sealed: true });
    expect(status.run.status).toBe('aborted');
  });

  it('rejects a receipt against a terminal run honestly and without durable side effects', async () => {
    const dir = await project();
    const started = await startRun(dir, {
      objective: 'Change behavior',
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
    });
    expect(started.ok).toBe(true);
    const testTicket = started.run.tickets[0];
    const paths = runtimePaths(dir);
    // Simulate the run blocking while this ticket is still outstanding (e.g. a
    // parallel sibling failed twice), then the late subagent submits anyway.
    const state = await readJson(paths.active);
    state.status = 'blocked';
    state.block_reason = 'sibling stage failed twice';
    await atomicWriteJson(paths.active, state);
    await writeFile(path.join(dir, 'tests', 'value.test.js'), 'throw new Error("still red");\n');
    const late = await recordReceipt(dir, receipt(testTicket, {
      tests: [{ command: 'node tests/value.test.js', passed: false, exit_code: 1, duration_ms: 1 }],
    }));
    expect(late).toMatchObject({ ok: false, rejected: true });
    expect(late.errors).toContain('run is blocked');
    const after = await readJson(paths.active);
    expect(after.receipts).toHaveLength(0);
    expect(after.test_paths).toEqual(['tests/value.test.js']);
    expect(await readdir(paths.receipts).catch(() => [])).toHaveLength(0);
    expect(await readdir(paths.receiptTransactions).catch(() => [])).toHaveLength(0);
  });

  it('override reset removes the status.md projection along with the active run', async () => {
    const dir = await project();
    const started = await startRun(dir, {
      objective: 'Change behavior',
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
    });
    expect(started.ok).toBe(true);
    const paths = runtimePaths(dir);
    const statusDoc = path.join(paths.runtime, 'status.md');
    const aborted = await abortRun(dir, 'wedge the run so reset is legal');
    expect(aborted.run.status).toBe('aborted');
    expect(await exists(statusDoc)).toBe(true);
    // The projection is written atomically: no orphaned temp files remain.
    expect((await readdir(paths.runtime)).filter((file) => file.endsWith('.tmp'))).toHaveLength(0);
    const reset = await overrideRun(dir, 'reset', 'clear the terminal run');
    expect(reset.ok).toBe(true);
    expect(await exists(paths.active)).toBe(false);
    expect(await exists(statusDoc)).toBe(false);
    // No run at all: active:false with run:null and no sealed key.
    expect(await statusRun(dir)).toEqual({ ok: true, active: false, run: null });
  });

  it('surfaces refused levers as ok:false with the reducer reason, never ok:true with a buried reject', async () => {
    // One refusal convention across every lever (matching regate/ship/
    // expire-dispatch): an orchestrator checking .ok must never read a refused
    // abort/override/next/resume as success (invariant 8).
    const dir = await project();
    const started = await startRun(dir, {
      objective: 'Change behavior',
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
    });
    expect(started.ok).toBe(true);
    const paths = runtimePaths(dir);
    const state = await readJson(paths.active);
    state.status = 'completed';
    state.stage = 'complete';
    state.checkout_cleanup = {
      status: 'returned',
      base_branch: state.base_branch,
      run_branch: state.branch,
      retained: false,
      deleted: true,
    };
    await atomicWriteJson(paths.active, state);
    const before = await readJson(paths.active);

    // Aborting a sealed completed run is refused and changes nothing on disk.
    const aborted = await abortRun(dir, 'try to rewrite a sealed run');
    expect(aborted).toEqual({ ok: false, reason: 'run is completed' });
    expect(await readJson(paths.active)).toEqual(before);

    // Terminal refusal cannot rewrite or resurrect a sealed run.
    expect(await nextRun(dir)).toEqual({ ok: false, reason: 'run is completed' });
    expect(await readJson(paths.active)).toEqual(before);

    // Override abort of a completed run is refused, naming the real lever.
    const overridden = await overrideRun(dir, 'abort', 'try to rewrite a sealed run');
    expect(overridden.ok).toBe(false);
    expect(overridden.reason).toMatch(/use override reset/);
    expect(await readJson(paths.active)).toEqual(before);

    // next/resume against a blocked run are refused, not "ok".
    state.status = 'blocked';
    state.block_reason = 'stage build failed twice';
    await atomicWriteJson(paths.active, state);
    expect(await nextRun(dir)).toEqual({ ok: false, reason: 'run is blocked' });
    expect(await resumeRun(dir)).toEqual({ ok: false, reason: 'run is blocked' });
  });

  it('reports a sealed completed run as inactive and a blocked run as active', async () => {
    const dir = await project();
    const started = await startRun(dir, {
      objective: 'Change behavior',
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
    });
    expect(started.ok).toBe(true);
    const paths = runtimePaths(dir);
    const state = await readJson(paths.active);
    state.status = 'completed';
    await atomicWriteJson(paths.active, state);
    const completed = await statusRun(dir);
    expect(completed).toMatchObject({ ok: true, active: false, sealed: true });
    expect(completed.run.status).toBe('completed');
    state.status = 'blocked';
    await atomicWriteJson(paths.active, state);
    const blocked = await statusRun(dir);
    expect(blocked).toMatchObject({ ok: true, active: true });
    expect(blocked).not.toHaveProperty('sealed');
  });

  it('preserves preflight questions when NEXT is called during an input hold', async () => {
    const dir = await project();
    const started = await startRun(dir, {
      objective: 'Change behavior',
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
    });
    expect(started.ok).toBe(true);
    const paths = runtimePaths(dir);
    const state = await readJson(paths.active);
    state.status = 'input_required';
    state.stage = 'preflight';
    state.input_required = {
      preflight_hash: 'f'.repeat(64),
      questions: [{ id: 'scope', question: 'Confirm the exact scope' }],
    };
    await atomicWriteJson(paths.active, state);
    const before = await readJson(paths.active);

    const result = await nextRun(dir);
    expect(result).toMatchObject({ ok: true, run: { status: 'input_required' } });
    expect(await readJson(paths.active)).toEqual(before);
  });

  it('automatically retires a legacy execution-budget pause on NEXT', async () => {
    const dir = await project();
    const started = await startRun(dir, {
      objective: 'Change behavior',
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
    });
    expect(started.ok).toBe(true);
    const paths = runtimePaths(dir);
    const state = await readJson(paths.active);
    state.status = 'input_required';
    state.stage = 'execution-budget';
    state.execution_budget = {
      version: 1,
      max_worker_dispatches: 1,
      max_active_seconds: 1,
      worker_dispatches_used: 1,
      active_elapsed_ms: 1_000,
    };
    state.input_required = {
      kind: 'execution_budget',
      code: 'worker-dispatches-exhausted',
      resume_status: 'running',
      resume_stage: state.tickets[0].stage_id,
    };
    await atomicWriteJson(paths.active, state);

    const resumed = await nextRun(dir);
    expect(resumed.ok).toBe(true);
    expect(resumed.run.status).toBe('running');
    expect(resumed.run).not.toHaveProperty('execution_budget');
    expect(resumed.run).not.toHaveProperty('input_required');
    const persisted = await readJson(paths.active);
    expect(persisted.status).toBe('running');
    expect(persisted).not.toHaveProperty('execution_budget');
    expect(persisted).not.toHaveProperty('input_required');
  });

  it('replays a large legacy dispatch continuation in bounded native groups', async () => {
    const dir = await project();
    const started = await startRun(dir, {
      objective: 'Resume every durable legacy dispatch without losing its launch capability',
      mode: 'phase',
      lane: 'fast',
      host: 'claude',
      claimed_paths: ['src/value.js'],
      test_paths: ['tests/value.test.js'],
      requirements: [],
      risk_triggers: [],
      behavioral: true,
      hooks_trusted: true,
      subagents_available: true,
      explicit_invocation: true,
    });
    expect(started.ok).toBe(true);
    const paths = runtimePaths(dir);
    const state = await readJson(paths.active);
    const original = state.tickets[0];
    const { ticket_hash: _oldHash, ...ticketSeed } = original;
    const tickets = Array.from({ length: 64 }, (_, index) => finalizeTicket({
      ...structuredClone(ticketSeed),
      ticket_id: `${original.ticket_id}-legacy-${index}`,
    }));
    await Promise.all(tickets.map((ticket) => atomicWriteJson(
      path.join(paths.tickets, `${ticket.ticket_id.replaceAll(':', '_')}.json`),
      ticket,
    )));
    state.tickets = tickets;
    state.receipts = [];
    state.expired_tickets = [];
    state.status = 'running';
    state.stage = tickets[0].stage_id;
    const actions = tickets.map((ticket) => ({
      type: 'dispatch_agent',
      ticket_id: ticket.ticket_id,
    }));
    const configSnapshot = await readJson(paths.config);
    state.budget_continuation = {
      version: 1,
      source: 'legacy-execution-budget',
      run_id: state.run_id,
      actions,
      actions_hash: sha256(actions),
      config_snapshot: configSnapshot,
      config_hash: sha256(configSnapshot),
    };
    await atomicWriteJson(paths.active, state);
    const beforeIntentNames = new Set(await readdir(paths.dispatchIntents));

    const resumed = await nextRun(dir);
    expect(resumed.ok).toBe(true);
    expect(resumed.actions).toHaveLength(2);
    expect(resumed.actions.every((action) => action.type === 'dispatch_agent')).toBe(true);
    expect(resumed.actions.map((action) => action.ticket.ticket_id)).toEqual(
      tickets.slice(0, 2).map((ticket) => ticket.ticket_id),
    );
    for (const action of resumed.actions) {
      expect(action.dispatch.dispatch_intent.nonce).toMatch(/^[A-Za-z0-9_-]{32,256}$/u);
      expect(action.dispatch.dispatch_intent.prompt)
        .toContain(`APE_DISPATCH_NONCE=${action.dispatch.dispatch_intent.nonce}`);
    }

    const persisted = await readJson(paths.active);
    expect(persisted.budget_continuation.actions).toEqual(actions.slice(2));
    expect(persisted.budget_continuation.actions_hash).toBe(sha256(actions.slice(2)));
    const afterIntentNames = await readdir(paths.dispatchIntents);
    expect(afterIntentNames.filter((name) => !beforeIntentNames.has(name))).toHaveLength(2);

    const projected = projectRunResponse(resumed);
    expect(projected.actions).toHaveLength(2);
    expect(Buffer.byteLength(JSON.stringify(projected), 'utf8'))
      .toBeLessThanOrEqual(RESPONSE_BUDGET_BYTES);

    // The shortened tail is itself a valid durable continuation on the next
    // call; replay does not depend on an in-memory cursor from the first call.
    const resumedAgain = await nextRun(dir);
    expect(resumedAgain.actions.map((action) => action.ticket.ticket_id)).toEqual(
      tickets.slice(2, 4).map((ticket) => ticket.ticket_id),
    );
    let persistedAgain = await readJson(paths.active);
    expect(persistedAgain.budget_continuation.actions).toEqual(actions.slice(4));
    expect(persistedAgain.budget_continuation.actions_hash).toBe(sha256(actions.slice(4)));

    const emittedTicketIds = resumed.actions.concat(resumedAgain.actions)
      .map((action) => action.ticket.ticket_id);
    let batches = 2;
    while (persistedAgain.budget_continuation) {
      const nextBatch = await nextRun(dir);
      batches += 1;
      expect(nextBatch.actions.length).toBeGreaterThan(0);
      expect(nextBatch.actions.length).toBeLessThanOrEqual(2);
      emittedTicketIds.push(...nextBatch.actions.map((action) => action.ticket.ticket_id));
      const projectedBatch = projectRunResponse(nextBatch);
      expect(projectedBatch.actions).toHaveLength(nextBatch.actions.length);
      expect(Buffer.byteLength(JSON.stringify(projectedBatch), 'utf8'))
        .toBeLessThanOrEqual(RESPONSE_BUDGET_BYTES);
      persistedAgain = await readJson(paths.active);
      expect(batches).toBeLessThanOrEqual(32);
    }
    expect(batches).toBe(32);
    expect(emittedTicketIds).toEqual(tickets.map((ticket) => ticket.ticket_id));

    // Even if a caller ignores all 32 returned launch groups and asks NEXT
    // again, the ordinary pending-ticket replay is re-batched before any new
    // intents are minted; it can never recreate one 64-action wire response.
    const replay = await nextRun(dir);
    expect(replay.actions).toHaveLength(2);
    expect(replay.actions.map((action) => action.ticket.ticket_id)).toEqual(
      tickets.slice(0, 2).map((ticket) => ticket.ticket_id),
    );
    const replayState = await readJson(paths.active);
    expect(replayState.budget_continuation).toMatchObject({
      source: 'response-wire-dispatch-batch',
      actions: actions.slice(2),
      actions_hash: sha256(actions.slice(2)),
    });
    const projectedReplay = projectRunResponse(replay);
    expect(projectedReplay.actions).toHaveLength(2);
    expect(Buffer.byteLength(JSON.stringify(projectedReplay), 'utf8'))
      .toBeLessThanOrEqual(RESPONSE_BUDGET_BYTES);
  });
});

describe('APE v2 resting shipping-watch levers (service)', () => {
  // A run resting in the non-blocking shipping watch: phase 1 pushed + created
  // the PR and persisted this progress block, leaving the run in 'shipping' with
  // the run lock held. NEXT is now a bounded remote-checks poll.
  function restingShipping(runId, overrides = {}) {
    return {
      version: 2,
      schema_version: '2.0.0',
      run_id: runId,
      status: 'shipping',
      stage: 'merge',
      objective: 'Ship the value bump non-blocking',
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
      requirements: ['R-ship'],
      risk_triggers: [],
      branch: 'ape/phase-ship',
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
      gates: { passed: true, tree_sha: 'b'.repeat(40) },
      timing: { test_ms: 1_000, remote_ci_ms: 0 },
      shipping_watch: {
        provider: 'github',
        pr_url: 'https://github.com/acme/repo/pull/9',
        branch: 'ape/phase-ship',
        base: 'main',
        head_oid: 'c'.repeat(40),
        created_at: '2026-07-14T00:00:00.000Z',
        last_poll_at: null,
        poll_count: 0,
        last_checks_summary: null,
      },
      created_at: '2026-07-01T00:00:00.000Z',
      updated_at: '2026-07-01T00:00:00.000Z',
      ...overrides,
    };
  }

  it('next: a merged poll completes the run, records the merge, archives, and releases the lock', async () => {
    const dir = await project();
    const paths = runtimePaths(dir);
    const runId = 'run-shipping-merged';
    await atomicWriteJson(paths.active, restingShipping(runId));
    await acquireRunLock(paths.lock, runId);
    pollRemoteChecksAndMerge.mockResolvedValueOnce({
      merged: {
        provider: 'github',
        url: 'https://github.com/acme/repo/pull/9',
        branch: 'ape/phase-ship',
        base: 'main',
        merged_at: '2026-07-14T02:00:00.000Z',
      },
    });
    const result = await nextRun(dir);
    expect(result.ok).toBe(true);
    expect(result.run.status).toBe('completed');
    expect(pollRemoteChecksAndMerge).toHaveBeenCalledTimes(1);
    // The watch cursor is cleared on completion.
    expect(result.run.shipping_watch ?? null).toBe(null);
    const records = await queryHistory(paths, { run_id: runId });
    expect(records.some((record) => record.status === 'completed')).toBe(true);
    expect(await exists(paths.lock)).toBe(false);
  });

  it('next: a pending poll rests in shipping, records the poll cursor, and attempts no merge', async () => {
    const dir = await project();
    const paths = runtimePaths(dir);
    const runId = 'run-shipping-pending';
    await atomicWriteJson(paths.active, restingShipping(runId));
    await acquireRunLock(paths.lock, runId);
    pollRemoteChecksAndMerge.mockResolvedValueOnce({ pending: { summary: '1 of 2 checks pending' } });
    const result = await nextRun(dir);
    expect(result.ok).toBe(true);
    expect(result.run.status).toBe('shipping');
    expect(pollRemoteChecksAndMerge).toHaveBeenCalledTimes(1);
    const active = await readJson(paths.active);
    expect(active.status).toBe('shipping');
    expect(active.shipping_watch.poll_count).toBe(1);
    expect(active.shipping_watch.last_poll_at).toBeTruthy();
    expect(active.shipping_watch.last_checks_summary).toBe('1 of 2 checks pending');
    // No merge, lock still held, nothing archived.
    expect(await exists(paths.lock)).toBe(true);
    const records = await queryHistory(paths, { run_id: runId });
    expect(records.some((record) => record.status === 'completed')).toBe(false);
  });

  it('persists the phase-one no-check submitted-merge watch without declaring completion', async () => {
    const dir = await project();
    const paths = runtimePaths(dir);
    const runId = 'run-shipping-submitted-handoff';
    const state = restingShipping(runId);
    const watch = { ...state.shipping_watch, merge_request_submitted: true };
    state.shipping_watch = null;
    autoMergeGithub.mockResolvedValueOnce({ watch });
    await acquireRunLock(paths.lock, runId);
    const actions = await applyActions(paths, state, [{ type: 'auto_merge' }, { type: 'persist_state' }], {
      shipping: { provider: 'github', auto_merge: true, required_remote_checks: false },
    });
    expect(actions.some((action) => action.type === 'shipping_started')).toBe(true);
    expect((await readJson(paths.active)).shipping_watch.merge_request_submitted).toBe(true);
    expect(state.status).toBe('shipping');
    expect(await exists(paths.lock)).toBe(true);
    expect(await queryHistory(paths, { run_id: runId })).toEqual([]);
    expect(pollRemoteChecksAndMerge).not.toHaveBeenCalled();
  });

  it('next: persists a successful merge submission across later shipping polls without clearing the watch', async () => {
    const dir = await project();
    const paths = runtimePaths(dir);
    const runId = 'run-shipping-submitted';
    await atomicWriteJson(paths.active, restingShipping(runId));
    await acquireRunLock(paths.lock, runId);
    pollRemoteChecksAndMerge.mockResolvedValueOnce({ pending: {
      summary: 'merge request submitted; awaiting the exact PR merge',
      reason: 'awaiting merge', merge_request_submitted: true,
    } });
    const first = await nextRun(dir);
    expect(first.run.status).toBe('shipping');
    expect((await readJson(paths.active)).shipping_watch.merge_request_submitted).toBe(true);
    pollRemoteChecksAndMerge.mockImplementationOnce(async (_root, state) => {
      expect(state.shipping_watch.merge_request_submitted).toBe(true);
      return { pending: { summary: 'awaiting the exact PR merge' } };
    });
    const second = await nextRun(dir);
    expect(second.run.status).toBe('shipping');
    expect((await readJson(paths.active)).shipping_watch.merge_request_submitted).toBe(true);
    expect(await exists(paths.lock)).toBe(true);
    expect(await queryHistory(paths, { run_id: runId })).toEqual([]);
    expect(autoMergeGithub).not.toHaveBeenCalled();
  });

  it('next: a failed-check poll blocks at the gates with the real tail; regate is then accepted', async () => {
    const dir = await project();
    const paths = runtimePaths(dir);
    const runId = 'run-shipping-failed';
    await atomicWriteJson(paths.active, restingShipping(runId));
    await acquireRunLock(paths.lock, runId);
    pollRemoteChecksAndMerge.mockResolvedValueOnce({ failed: 'X  lint  1m2s  https://github.com/acme/repo/runs/1' });
    const result = await nextRun(dir);
    expect(result.ok).toBe(true);
    expect(result.run.status).toBe('blocked');
    expect(result.run.stage).toBe('gates');
    expect(result.run.block_reason).toMatch(/shipping failed:/);
    expect(result.run.block_reason).toMatch(/lint/);
    expect(result.run.shipping_watch ?? null).toBe(null);
    const records = await queryHistory(paths, { run_id: runId });
    expect(records.some((record) => record.status === 'blocked')).toBe(true);
    expect(await exists(paths.lock)).toBe(false);
    // The shipping-failure gate block is regate-recoverable (accepted, not refused).
    const regate = await regateRun(dir);
    expect(regate.ok).toBe(true);
  });

  it('resume: returns without ever driving the poll itself (A3)', async () => {
    const dir = await project();
    const paths = runtimePaths(dir);
    const runId = 'run-shipping-resume';
    await atomicWriteJson(paths.active, restingShipping(runId));
    const resumed = await resumeRun(dir);
    expect(resumed.ok).toBe(true);
    expect(pollRemoteChecksAndMerge).not.toHaveBeenCalled();
    // Still resting in shipping — resume never performs the merge.
    expect((await readJson(paths.active)).status).toBe('shipping');
  });

  it('status: reports a resting shipping run as active with the watch progress visible', async () => {
    const dir = await project();
    const paths = runtimePaths(dir);
    const runId = 'run-shipping-status';
    await atomicWriteJson(paths.active, restingShipping(runId));
    const status = await statusRun(dir);
    expect(status.ok).toBe(true);
    expect(status.active).toBe(true);
    expect(status).not.toHaveProperty('sealed');
    expect(status.run.shipping_watch).toBeDefined();
    expect(status.run.shipping_watch.pr_url).toBe('https://github.com/acme/repo/pull/9');
  });

  it('abort: seals aborted, archives, releases the lock, and invokes no gh (PR stays open)', async () => {
    const dir = await project();
    const paths = runtimePaths(dir);
    const runId = 'run-shipping-abort';
    await atomicWriteJson(paths.active, restingShipping(runId));
    await acquireRunLock(paths.lock, runId);
    const result = await abortRun(dir, 'operator abandons the shipping run; the PR stays open');
    expect(result.ok).toBe(true);
    expect(result.run.status).toBe('aborted');
    expect(pollRemoteChecksAndMerge).not.toHaveBeenCalled();
    expect(autoMergeGithub).not.toHaveBeenCalled();
    const records = await queryHistory(paths, { run_id: runId });
    expect(records.some((record) => record.status === 'aborted')).toBe(true);
    expect(await exists(paths.lock)).toBe(false);
  });

  it('override reset and expire-dispatch are refused on a resting shipping state with honest reasons', async () => {
    const dir = await project();
    const paths = runtimePaths(dir);
    const runId = 'run-shipping-levers';
    await atomicWriteJson(paths.active, restingShipping(runId));
    const reset = await overrideRun(dir, 'reset', 'try to reset a live shipping run');
    expect(reset.ok).toBe(false);
    expect(reset.reason).toMatch(/terminal or blocked/);
    const expired = await expireDispatch(dir, `${runId}:merge:none`, 'try to expire a shipping poll');
    expect(expired.ok).toBe(false);
    expect(expired.reason).toMatch(/running run/);
    // Neither lever polled or shipped.
    expect(pollRemoteChecksAndMerge).not.toHaveBeenCalled();
    expect(autoMergeGithub).not.toHaveBeenCalled();
  });
});
