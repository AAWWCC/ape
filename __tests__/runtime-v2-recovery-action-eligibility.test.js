import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { AUTO_MERGE_HOLD_REASON, MAX_REGATE_ATTEMPTS } from '../lib/runtime/constants.js';
import { projectRunDiagnostic } from '../lib/runtime/diagnostics.js';
import { runtimePaths } from '../lib/runtime/paths.js';
import { reduceRun } from '../lib/runtime/scheduler.js';
import { compactStatus, regateRun, resumeRun, shipRun } from '../lib/runtime/service.js';
import { attachRuntimeGuidance, loadSessionGuidance } from '../lib/runtime/session-guidance.js';
import { renderStatusDoc } from '../lib/runtime/status-doc.js';
import { atomicWriteJson } from '../lib/runtime/storage.js';

const cleanups = [];
afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

function runState(overrides = {}) {
  return {
    schema_version: '2.0.0', version: 2, run_id: 'run-recovery-action',
    mode: 'phase', lane: 'mechanical', host: 'claude',
    status: 'blocked', stage: 'gates', dispatch_state: 'none',
    tickets: [], receipts: [], expired_tickets: [], attempts: {},
    gates: { passed: false, checks: { full_suite: { passed: false } } },
    ...overrides,
  };
}

async function fixture(state) {
  const dir = await mkdtemp(path.join(tmpdir(), 'ape-recovery-action-'));
  cleanups.push(dir);
  await atomicWriteJson(runtimePaths(dir).active, state);
  return dir;
}

describe('recovery guidance agrees with the lifecycle receiving boundary', () => {
  it.each([
    ['exhausted gate recovery', { regate_attempts: MAX_REGATE_ATTEMPTS }, 'REGATE'],
    ['a retained failed gate outside the gate stage', { stage: 'review' }, 'REGATE'],
    ['a shipping failure after passing gates', {
      stage: 'merge', gates: { passed: true }, block_reason: 'shipping failed: synthetic provider failure',
    }, 'SHIP'],
  ])('does not recommend an ineligible retry for %s', async (_name, overrides, eventType) => {
    const state = runState(overrides);
    const dir = await fixture(state);
    const before = await readFile(runtimePaths(dir).active, 'utf8');
    const refused = eventType === 'REGATE'
      ? await regateRun(dir)
      : await shipRun(dir, 'synthetic explicit operator request');
    expect(refused.ok).toBe(false);
    expect(reduceRun(state, { type: eventType, reason: 'synthetic operator request' }))
      .toContainEqual(expect.objectContaining({ type: 'reject' }));

    const status = await compactStatus(dir);
    expect(status.next_safe_action).toBe('ape_run abort or ape_run override reset');
    expect(status.diagnostic.failed_checks).toEqual(state.gates.passed ? [] : ['full_suite']);
    expect(renderStatusDoc(state)).toContain('Next: ape_run abort or ape_run override reset');
    expect(await loadSessionGuidance(dir, { host: 'claude', source: 'resume' }))
      .toContain('Next safe action: ape_run abort or ape_run override reset');
    for (const event of [{ type: 'ABORT' }, { type: 'OVERRIDE', operation: 'reset', reason: 'synthetic operator request' }]) {
      expect(reduceRun(state, event).some((action) => action.type === 'reject')).toBe(false);
    }
    expect(await readFile(runtimePaths(dir).active, 'utf8')).toBe(before);
  });

  it('retains the last eligible gate retry and the explicit auto-merge hold recovery', () => {
    const gate = runState({ regate_attempts: MAX_REGATE_ATTEMPTS - 1 });
    expect(projectRunDiagnostic(gate).next_safe_action).toBe('ape_run regate');
    expect(reduceRun(gate, { type: 'REGATE' }).some((action) => action.type === 'run_gates')).toBe(true);
    const hold = runState({
      stage: 'merge', gates: { passed: true }, block_reason: AUTO_MERGE_HOLD_REASON,
      regate_attempts: MAX_REGATE_ATTEMPTS,
    });
    expect(projectRunDiagnostic(hold).next_safe_action).toBe('ape_run ship');
    expect(reduceRun(hold, { type: 'SHIP', reason: 'synthetic operator request' })
      .some((action) => action.type === 'run_gates')).toBe(true);
  });

  it.each([AUTO_MERGE_HOLD_REASON, 'shipping failed: synthetic provider failure'])(
    'keeps legacy status documents aligned with durable shipping recovery for %s', (blockReason) => {
      const state = runState({ stage: 'merge', gates: { passed: true }, block_reason: blockReason });
      const legacy = { ...state };
      for (const key of ['schema_version', 'run_id', 'host', 'dispatch_state', 'version']) delete legacy[key];
      const nextLine = (value) => renderStatusDoc(value).split('\n').find((line) => line.startsWith('Next: '));
      expect(nextLine(legacy)).toBe(nextLine(state));
    },
  );

  it.each(['gating', 'shipping'])('preserves the scheduler poll guidance when resuming %s', async (status) => {
    const state = runState({
      status, stage: status === 'gating' ? 'gates' : 'merge', gates: { passed: true },
      ...(status === 'gating' ? { gates_watch: { last_summary: 'synthetic suite pending' } }
        : { shipping_watch: { pr_url: 'https://github.com/acme/repo/pull/1', last_checks_summary: 'synthetic checks pending' } }),
    });
    const dir = await fixture(state);
    const before = await readFile(runtimePaths(dir).active, 'utf8');
    const result = await resumeRun(dir);
    expect(result.ok).toBe(true);
    expect(result.actions).toContainEqual(expect.objectContaining({
      type: 'dispatch_pending', reason: expect.stringContaining('ape_run next'),
    }));
    const guidance = attachRuntimeGuidance(result).runtime_guidance;
    expect(guidance).toContain('Next safe action: ape_run next');
    expect(guidance).not.toContain('expire-dispatch');
    expect(await readFile(runtimePaths(dir).active, 'utf8')).toBe(before);
  });
});
