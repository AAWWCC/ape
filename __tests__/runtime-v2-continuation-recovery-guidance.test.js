import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { sha256 } from '../lib/runtime/canonical.js';
import { DEFAULT_CONFIG } from '../lib/runtime/config.js';
import { runtimePaths } from '../lib/runtime/paths.js';
import { projectRunResponse, RESPONSE_BUDGET_BYTES } from '../lib/runtime/projection.js';
import { compactStatus, nextRun } from '../lib/runtime/service.js';
import { loadSessionGuidance } from '../lib/runtime/session-guidance.js';
import { atomicWriteJson } from '../lib/runtime/storage.js';

const cleanups = [];
afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

function continuationState(paused) {
  const actions = [{ type: 'transition', patch: { stage: 'build' } }, { type: 'persist_state' }];
  const config = structuredClone(DEFAULT_CONFIG);
  return {
    schema_version: '2.0.0', version: 2, run_id: 'run-continuation-guidance',
    host: 'claude', mode: 'phase', lane: 'mechanical',
    status: paused ? 'input_required' : 'running', stage: paused ? 'execution-budget' : 'test',
    dispatch_state: 'none', tickets: [], receipts: [], attempts: {}, expired_tickets: [],
    ...(paused ? {
      input_required: { kind: 'execution_budget', resume_status: 'running', resume_stage: 'test' },
      execution_budget: { max_worker_dispatches: 1 },
    } : {}),
    budget_continuation: {
      version: 1, source: 'legacy-execution-budget', run_id: 'run-continuation-guidance',
      actions, actions_hash: sha256(actions), config_snapshot: config, config_hash: sha256(config),
    },
  };
}

async function fixture(state) {
  const dir = await mkdtemp(path.join(tmpdir(), 'ape-continuation-guidance-'));
  cleanups.push(dir);
  const git = (...args) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' }).trim();
  await writeFile(path.join(dir, 'sample.txt'), 'baseline\n');
  git('init', '-q');
  git('add', '.');
  git('-c', 'user.name=APE Fixture', '-c', 'user.email=ape@example.test', 'commit', '-qm', 'baseline');
  await atomicWriteJson(runtimePaths(dir).active, state);
  return dir;
}

const CONTINUE = { kind: 'wait', state: 'continuation_pending', required_control_action: 'ape_run_next' };

describe('retained continuation recovery guidance', () => {
  it.each([true, false])('requires NEXT for retained work instead of passive waiting (legacy hold: %s)', async (paused) => {
    const state = continuationState(paused);
    const dir = await fixture(state);
    const paths = runtimePaths(dir);
    const before = await readFile(paths.active, 'utf8');
    const status = await compactStatus(dir);
    expect(status.next_safe_action).toBe('ape_run next');
    expect(status.next_action).toEqual(CONTINUE);
    expect(await loadSessionGuidance(dir, { host: 'claude', source: 'resume' }))
      .toContain('Next safe action: ape_run next');
    expect(await readFile(paths.active, 'utf8')).toBe(before);

    const projected = projectRunResponse({ ok: true, run: state });
    expect(projected.next_action).toEqual(CONTINUE);
    expect(projected.run).not.toHaveProperty('budget_continuation');
    const bounded = projectRunResponse({
      ok: true, run: { ...state, objective: 'x'.repeat(RESPONSE_BUDGET_BYTES * 2) },
    });
    expect(bounded.next_action).toEqual(CONTINUE);
    expect(Buffer.byteLength(JSON.stringify(bounded))).toBeLessThanOrEqual(RESPONSE_BUDGET_BYTES);

    const resumed = await nextRun(dir);
    expect(resumed).toMatchObject({ ok: true, run: { status: 'running', stage: 'build', tickets: [], attempts: {} } });
    expect(resumed.run).not.toHaveProperty('input_required');
    expect(resumed.run).not.toHaveProperty('execution_budget');
    expect(resumed.run).not.toHaveProperty('budget_continuation');
    expect((await compactStatus(dir)).next_action).not.toHaveProperty('required_control_action');
  });

  it('keeps continuation control visible when generic pending-ticket guidance would otherwise hide it', () => {
    const state = continuationState(false);
    state.tickets = [{ ticket_id: 'run-continuation-guidance:test:1', stage_id: 'test', role: 'test_writer' }];
    expect(projectRunResponse({ ok: true, run: state }).next_action).toEqual(CONTINUE);
  });

  it('preserves an explicit worker-retirement wait while retained work cannot proceed', () => {
    const state = continuationState(false);
    state.budget_continuation.source = 'receipt-protocol-budget-recovery';
    const nextAction = { kind: 'wait', ticket_id: 'run-continuation-guidance:test:1', failure_domain: 'orchestration' };
    const projected = projectRunResponse({
      ok: true, run: state, next_action: nextAction,
      actions: [{ type: 'dispatch_retirement_pending', ticket_id: nextAction.ticket_id }],
    });
    expect(projected.next_action).toEqual(nextAction);
  });

  it.each(['receipt_retry', 'preflight'])('keeps %s input ahead of a retained continuation', (hold) => {
    const state = continuationState(false);
    state.status = 'input_required';
    state.stage = hold === 'preflight' ? 'preflight' : 'test';
    state.input_required = hold === 'receipt_retry'
      ? { kind: 'receipt_retry', ticket_id: 'run-continuation-guidance:test:1' }
      : { questions: [] };
    const projected = projectRunResponse({ ok: true, run: state });
    expect(projected.next_action.kind).toBe(hold === 'receipt_retry' ? 'continue_same_agent' : 'answer_preflight');
    expect(projected.next_action.required_control_action).not.toBe('ape_run_next');
  });

  it.each(['blocked', 'aborted', 'completed'])('does not reopen retained work in a %s run', (status) => {
    const state = continuationState(false);
    state.status = status;
    const projected = projectRunResponse({ ok: true, run: state });
    expect(projected.next_action?.required_control_action).not.toBe('ape_run_next');
  });

  it('leaves continuation integrity enforcement at the receiving NEXT boundary', async () => {
    const state = continuationState(false);
    state.budget_continuation.actions_hash = '0'.repeat(64);
    const dir = await fixture(state);
    const before = await readFile(runtimePaths(dir).active, 'utf8');
    await expect(nextRun(dir)).rejects.toThrow('legacy continuation action hash does not match');
    expect(await readFile(runtimePaths(dir).active, 'utf8')).toBe(before);
  });
});
