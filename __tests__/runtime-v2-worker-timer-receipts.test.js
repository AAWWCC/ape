import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

// Exercise ticket publication and receipt-service recovery without spawning a
// host worker. Native launch and binding lifetime are covered at dispatch.
vi.mock('../lib/runtime/claude-dispatch.js', async (importOriginal) => ({
  ...await importOriginal(),
  prepareCodexIntent: vi.fn(async () => null),
  isPreparedUnlaunchedDispatchReplay: vi.fn(async () => false),
}));

import { prepareCodexIntent } from '../lib/runtime/claude-dispatch.js';
import { DEFAULT_CONFIG } from '../lib/runtime/config.js';
import { historicalExecutionPolicy } from './historical-execution-policy-helper.js';
import { executionPolicySnapshot, pipelineLimits } from '../lib/runtime/pipeline-limits.js';
import { runtimePaths } from '../lib/runtime/paths.js';
import { applyActions } from '../lib/runtime/receipt-service.js';
import { validateTicket } from '../lib/runtime/schemas.js';

const directories = [];
afterEach(async () => {
  prepareCodexIntent.mockReset();
  prepareCodexIntent.mockResolvedValue(null);
  await Promise.all(directories.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

const stage = { id: 'build', role: 'implementer', model_tier: 'balanced', writable: true,
  parallel_group: null, output_schema: {}, required_checks: [] };
const tree = { current: async () => 'a'.repeat(40) };

async function fixture(version = 4) {
  const directory = await mkdtemp(path.join(tmpdir(), 'ape-worker-timer-receipts-'));
  directories.push(directory);
  const config = structuredClone(DEFAULT_CONFIG);
  config.deadlines_ms.fast = 12_345;
  const snapshot = version >= 4 ? executionPolicySnapshot(config) : historicalExecutionPolicy(version === 1 ? 2 : version, {}, config);
  if (version === 1) {
    snapshot.version = 1;
    snapshot.limits = pipelineLimits();
  }
  const state = {
    run_id: 'run-worker-timer', objective: 'Preserve worker lifetime across recovery',
    host: 'codex', mode: 'phase', lane: 'fast', status: 'running', stage: 'build',
    claimed_paths: ['src/value.js'], test_paths: [], tickets: [], receipts: [],
    attempts: {}, expired_tickets: [], execution_policy: snapshot,
  };
  const paths = runtimePaths(directory);
  const issued = await applyActions(paths, state, [{ type: 'issue_ticket', stage }], config, tree);
  return { paths, state, config, ticket: issued[0].ticket };
}

describe('receipt-service worker lifetime authority', () => {
  it.each([1, 2, 3, 4])('preserves version %s lifetime when issuing and retrying a stage', async (version) => {
    const { paths, state, config, ticket } = await fixture(version);
    expect(validateTicket(ticket).valid).toBe(true);
    const sourceFile = path.join(paths.tickets, `${ticket.ticket_id.replaceAll(':', '_')}.json`);
    const sourceBytes = await readFile(sourceFile, 'utf8');
    state.attempts.build = 2;
    const retried = await applyActions(paths, state, [{ type: 'issue_ticket', stage,
      retry_of: ticket.ticket_id }], config, tree);
    const successor = retried[0].ticket;
    expect(validateTicket(successor).valid).toBe(true);
    expect(successor.attempt).toBe(2);
    expect(await readFile(sourceFile, 'utf8')).toBe(sourceBytes);
    for (const current of [ticket, successor]) {
      if (version >= 3) expect(current.deadline_at).toBeNull();
      else expect(Date.parse(current.deadline_at) - Date.parse(current.issued_at)).toBe(12_345);
    }
  });

  it.each([2, 3, 4])('uses version %s authority during same-ticket receipt protocol recovery', async (version) => {
    const { paths, state, config, ticket } = await fixture(version);
    prepareCodexIntent.mockClear();
    const before = Date.now();
    await applyActions(paths, state, [{ type: 'dispatch_agent', ticket_id: ticket.ticket_id,
      recovery_kind: 'redispatch_same_ticket' }], config, tree);
    const after = Date.now();
    const options = prepareCodexIntent.mock.calls[0][3];
    if (version >= 3) {
      expect(options).not.toHaveProperty('receipt_protocol_recovery_deadline_at');
    } else {
      expect(Date.parse(options.receipt_protocol_recovery_deadline_at)).toBeGreaterThanOrEqual(before + 12_345);
      expect(Date.parse(options.receipt_protocol_recovery_deadline_at)).toBeLessThanOrEqual(after + 12_345);
    }
  });

  it('describes a pending worker without inventing a null timeout', async () => {
    const { paths, state, config, ticket } = await fixture();
    prepareCodexIntent.mockRejectedValue(new Error('dispatch is already bound'));
    const actions = await applyActions(paths, state, [{ type: 'dispatch_agent', ticket_id: ticket.ticket_id }], config, tree);
    expect(actions[0]).toMatchObject({ type: 'dispatch_pending', deadline_at: null });
    expect(actions[0].reason).toContain('wait for the active worker');
    expect(actions[0].reason).toContain('expire-dispatch');
    expect(actions[0].reason).not.toMatch(/times out|null/);
  });
});
