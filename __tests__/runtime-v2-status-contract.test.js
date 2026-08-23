import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { AUTO_MERGE_HOLD_REASON, SCHEMA_VERSION } from '../lib/runtime/constants.js';
import { runtimePaths } from '../lib/runtime/paths.js';
import { compactStatus, resumeRun, startRun, statusRun } from '../lib/runtime/service.js';
import { atomicWriteJson, readJson } from '../lib/runtime/storage.js';
import { bindCodexDispatch } from './codex-native-test-helper.js';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const cleanups = [];

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

function git(cwd, ...args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

async function project() {
  const dir = await mkdtemp(path.join(tmpdir(), 'ape-status-contract-'));
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
  await atomicWriteJson(runtimePaths(dir).config, {
    shipping: { auto_merge: false, provider: 'github', required_remote_checks: false },
    test_commands: { full: 'node --test' },
  });
  return dir;
}

function startInput() {
  return {
    objective: 'Exercise compact status and truthful resume',
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
  };
}

describe('APE v2 compact status and resume liveness contract', () => {
  it('does not treat a pending ticket as live, but does preserve an attested live binding', async () => {
    const dir = await project();
    await startRun(dir, startInput());

    const before = await statusRun(dir);
    expect(before.dispatch_state).toBe('needs-redispatch');
    expect(await compactStatus(dir)).toMatchObject({
      active: true,
      dispatch_state: 'needs-redispatch',
      pending: { ticket_id: startedTicketId(before.run) },
      gate: { state: 'not_run' },
      last_receipt: null,
      next_safe_action: 'ape_run resume',
      diagnostic: {
        reason_code: 'dispatch_pending',
        next_safe_action: 'ape_run resume',
      },
    });

    const recovered = await resumeRun(dir);
    expect(recovered).toMatchObject({
      ok: true,
      dispatch_state: 'needs-redispatch',
      resume_state: 'recovered-orphan',
    });
    const dispatched = recovered.actions.find((action) => action.type === 'dispatch_agent');
    expect(dispatched).toBeTruthy();
    await bindCodexDispatch(root, dir, dispatched);

    const liveStatus = await statusRun(dir);
    expect(liveStatus.dispatch_state).toBe('live');
    expect(await compactStatus(dir)).toMatchObject({
      dispatch_state: 'live',
      next_safe_action: 'wait for pending receipt',
      diagnostic: {
        reason_code: 'dispatch_live',
        next_safe_action: 'wait for pending receipt',
      },
    });
    const alreadyLive = await resumeRun(dir);
    expect(alreadyLive).toMatchObject({
      ok: true,
      dispatch_state: 'live',
      resume_state: 'already-live',
    });
    expect(alreadyLive.actions).toEqual([
      expect.objectContaining({
        type: 'dispatch_pending',
        ticket_id: dispatched.ticket.ticket_id,
      }),
    ]);
    expect(alreadyLive.actions.some((action) => action.type === 'dispatch_agent')).toBe(false);
  }, 30_000);

  it('reports an inactive project without inventing run or ticket detail', async () => {
    const dir = await project();
    expect(await compactStatus(dir)).toMatchObject({
      ok: true,
      active: false,
      dispatch_state: 'none',
      run: null,
      pending: null,
      gate: { state: 'inactive' },
      last_receipt: null,
      next_safe_action: 'ape_run start',
      diagnostic: {
        reason_code: 'inactive',
        next_safe_action: 'ape_run start',
      },
    });
  });

  it('uses a deterministic id list instead of duplicating parallel ticket bodies', async () => {
    const dir = await project();
    await startRun(dir, startInput());
    const paths = runtimePaths(dir);
    const state = await readJson(paths.active, null);
    state.tickets.push({ ...state.tickets[0], ticket_id: `${state.run_id}:parallel:z` });
    await atomicWriteJson(paths.active, state);
    const compact = await compactStatus(dir);
    expect(compact.pending).toEqual({
      ticket_ids: state.tickets.map((ticket) => ticket.ticket_id).sort(),
    });
    expect(compact.pending).not.toHaveProperty('objective');
  }, 30_000);

  it('projects only compact run fields and roadmap counts, deriving the merge hold gate state', async () => {
    const dir = await project();
    const started = await startRun(dir, startInput());
    const paths = runtimePaths(dir);
    const state = await readJson(paths.active, null);
    state.status = 'blocked';
    state.stage = 'merge';
    state.block_reason = AUTO_MERGE_HOLD_REASON;
    state.checkout_cleanup = {
      status: 'returned', base_branch: state.base_branch, run_branch: state.branch, retained: true, deleted: false,
    };
    state.gates = { passed: true };
    state.checkout_cleanup = {
      status: 'returned', base_branch: state.base_branch, run_branch: state.branch, retained: true, deleted: false,
    };
    state.receipts = [{
      receipt_id: 'receipt-status-summary',
      ticket_id: state.tickets[0].ticket_id,
      status: 'passed',
      evidence: { summary: 's'.repeat(500) },
    }];
    await atomicWriteJson(paths.active, state);
    await atomicWriteJson(path.join(paths.runtime, 'roadmap.json'), {
      schema_version: SCHEMA_VERSION,
      entries: [{
        id: 'R1',
        title: 'Runtime contract',
        description: 'Keep status bounded',
        acceptance: 'Only counts cross the compact status boundary',
        depends_on: [],
        discovered_by: 'operator',
        created_at: new Date().toISOString(),
      }],
    });

    const legacy = await statusRun(dir);
    expect(legacy.run.tickets).toEqual(started.run.tickets);
    expect(legacy.roadmap.entries).toHaveLength(1);

    const compact = await compactStatus(dir);
    expect(compact).toMatchObject({
      ok: true,
      active: true,
      dispatch_state: 'none',
      run: {
        run_id: started.run.run_id,
        stage: 'merge',
      },
      pending: null,
      gate: {
        state: 'passed_awaiting_ship',
      },
      last_receipt: {
        receipt_id: 'receipt-status-summary',
        ticket_id: state.tickets[0].ticket_id,
        stage_id: state.tickets[0].stage_id,
        status: 'passed',
      },
      next_safe_action: 'ape_run ship',
      diagnostic: {
        reason_code: 'shipping_hold',
        next_safe_action: 'ape_run ship',
      },
      roadmap: {
        counts: { satisfied: 0, in_progress: 0, ready: 1, pending: 0, stale: 0 },
      },
    });
    expect(compact.run).not.toHaveProperty('tickets');
    expect(compact.run).not.toHaveProperty('receipts');
    expect(compact.roadmap).not.toHaveProperty('entries');
    expect(compact.gate).not.toHaveProperty('blocker');
    expect(compact.last_receipt).not.toHaveProperty('summary');
  }, 30_000);

  it('marks a sealed run inactive and points to a fresh start', async () => {
    const dir = await project();
    const started = await startRun(dir, startInput());
    const paths = runtimePaths(dir);
    const state = await readJson(paths.active, null);
    state.status = 'completed';
    state.stage = 'completed';
    state.gates = { passed: true };
    state.checkout_cleanup = {
      status: 'returned', base_branch: state.base_branch, run_branch: state.branch, retained: false, deleted: true,
    };
    state.receipts = [{
      receipt_id: 'receipt-complete',
      ticket_id: state.tickets[0].ticket_id,
      status: 'passed',
      evidence: { summary: 'done' },
    }];
    await atomicWriteJson(paths.active, state);
    expect(await compactStatus(dir)).toMatchObject({
      active: false,
      run: { run_id: started.run.run_id, stage: 'completed' },
      pending: null,
      dispatch_state: 'none',
      gate: { state: 'passed' },
      next_safe_action: 'ape_run start',
      diagnostic: {
        reason_code: 'completed',
        next_safe_action: 'ape_run start',
      },
    });
  }, 30_000);

  it.each([
    ['absent', undefined],
    ['not returned', {
      status: 'retained',
      base_branch: 'main',
      run_branch: 'ape/phase-terminal-cleanup',
      retained: true,
      deleted: false,
    }],
  ])('projects ape_run resume for terminal checkout cleanup that is %s', async (_label, cleanup) => {
    const dir = await project();
    await startRun(dir, startInput());
    const paths = runtimePaths(dir);
    const state = await readJson(paths.active, null);
    state.status = 'completed';
    state.stage = 'completed';
    state.gates = { passed: true };
    if (cleanup === undefined) delete state.checkout_cleanup;
    else state.checkout_cleanup = cleanup;
    await atomicWriteJson(paths.active, state);

    const compact = await compactStatus(dir);
    expect(compact.next_safe_action).toBe('ape_run resume');
    expect(compact.diagnostic.next_safe_action).toBe('ape_run resume');
    expect(JSON.stringify(compact)).not.toContain('ape_run start');
  }, 30_000);

  it('reports a failed gate blocker and the audited regate action', async () => {
    const dir = await project();
    await startRun(dir, startInput());
    const paths = runtimePaths(dir);
    const state = await readJson(paths.active, null);
    state.status = 'blocked';
    state.stage = 'gates';
    state.gates = { passed: false };
    state.block_reason = 'one or more deterministic merge gates failed';
    state.checkout_cleanup = {
      status: 'returned', base_branch: state.base_branch, run_branch: state.branch, retained: true, deleted: false,
    };
    state.expired_tickets = state.tickets.map((ticket) => ticket.ticket_id);
    await atomicWriteJson(paths.active, state);
    expect(await compactStatus(dir)).toMatchObject({
      active: true,
      pending: null,
      gate: {
        state: 'failed',
      },
      next_safe_action: 'ape_run regate',
      diagnostic: {
        reason_code: 'gate_failed',
        next_safe_action: 'ape_run regate',
      },
    });
    expect((await compactStatus(dir)).gate).not.toHaveProperty('blocker');
  }, 30_000);
});

function startedTicketId(state) {
  return state.tickets[0].ticket_id;
}
