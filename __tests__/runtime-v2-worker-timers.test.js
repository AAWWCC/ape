import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  bindClaudeSubagent, bindCodexSubagent, bootstrapCodexSubagent, codexBootstrapStatus,
  dispatchIntentStatuses, expireClaudeIntent, isPreparedUnlaunchedDispatchReplay,
  launchClaudeIntent, launchCodexIntent, observeClaudeSubagentStop,
  prepareClaudeIntent, prepareCodexIntent, resolveClaudeBindingOutcome,
  resolveCodexBindingOutcome, validateClaudeReceiptBinding,
} from '../lib/runtime/claude-dispatch.js';
import { runtimePaths } from '../lib/runtime/paths.js';
import { CURRENT_EXECUTION_POLICY_DEFAULTS } from '../lib/runtime/pipeline-limits.js';
import { finalizeTicket } from '../lib/runtime/schemas.js';

const cleanups = [];
const model = 'gpt-5.4-mini';
const identity = { session_id: 'parent-session', agent_id: 'child-one', agent_type: 'worker', turn_id: 'parent-turn' };

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(cleanups.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function fixture({ version = 3, host = 'claude' } = {}) {
  const directory = await mkdtemp(path.join(tmpdir(), 'ape-worker-timers-'));
  cleanups.push(directory);
  const paths = runtimePaths(directory);
  const ticket = finalizeTicket({
    schema_version: '2.0.0', run_id: 'run-timers', ticket_id: 'run-timers:build:ticket',
    stage_id: 'build', role: 'implementer', objective: 'Apply the authorized edit',
    claimed_paths: ['value.js'], test_paths: [], model_tier: 'balanced', model: { model },
    issued_at: new Date().toISOString(),
    deadline_at: version === 3 ? null : new Date(Date.now() + 300_000).toISOString(),
    ...(version >= 2 ? { execution_limits: { version, ...CURRENT_EXECUTION_POLICY_DEFAULTS } } : {}),
    output_schema: { type: 'object' }, required_checks: [], parent_hash: null,
    base_tree_sha: '0'.repeat(40), attempt: 1, writable: true,
  });
  const state = { run_id: ticket.run_id, status: 'running', host, tickets: [ticket], receipts: [], expired_tickets: [] };
  const prepared = host === 'codex'
    ? await prepareCodexIntent(paths, ticket, 'worker', { bootstrap_protocol: 1 })
    : await prepareClaudeIntent(paths, ticket, 'worker');
  return { directory, paths, ticket, state, prepared };
}

async function stored(value) {
  const names = (await readdir(value.paths.dispatchIntents)).filter((name) => name.endsWith('.json'));
  expect(names).toHaveLength(1);
  const file = path.join(value.paths.dispatchIntents, names[0]);
  return { file, record: JSON.parse(await readFile(file, 'utf8')) };
}

async function launch(value) {
  const codex = value.state.host === 'codex';
  const input = {
    session_id: identity.session_id, turn_id: 'parent-turn', tool_use_id: 'spawn-one',
    tool_name: codex ? 'collaboration.spawn_agent' : 'Agent',
    tool_input: codex
      ? { task_name: value.prepared.agent_name, fork_turns: 'none', model, message: 'Execute assigned task' }
      : { subagent_type: 'worker', model, prompt: value.prepared.prompt },
  };
  const result = await (codex ? launchCodexIntent : launchClaudeIntent)(value.paths, value.state, input);
  expect(result.valid, result.reason).toBe(true);
}

async function bind(value) {
  await launch(value);
  const result = await bindClaudeSubagent(value.paths, value.state, identity);
  expect(result.valid, result.reason).toBe(true);
  return result;
}

function afterLongElapsedTime() {
  vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 365 * 24 * 60 * 60_000);
}

describe('immutable worker timer policy', () => {
  it('replays the same durable v3 prepared authority after a year without creating a fake deadline', async () => {
    const value = await fixture();
    const before = await stored(value);
    expect(before.record).toMatchObject({ expires_at: null, execution_policy_version: 3 });
    expect(before.record.launch_generations).toMatchObject([{ expires_at: null, execution_policy_version: 3 }]);
    afterLongElapsedTime();
    expect(await isPreparedUnlaunchedDispatchReplay(value.paths, value.state, value.ticket)).toBe(true);
    expect(await prepareClaudeIntent(value.paths, value.ticket, 'worker', { allow_prepared_replay: true }))
      .toEqual(value.prepared);
    expect((await stored(value)).record).toEqual(before.record);
    await launch(value);
    const launched = (await stored(value)).record;
    expect(Date.parse(launched.launch_expires_at) - Date.parse(launched.launched_at)).toBe(60_000);
    expect(launched.expires_at).toBeNull();
  });

  it('keeps a bound v3 worker authorized after long elapsed time, but fences stop, supersession and revocation', async () => {
    const value = await fixture();
    await bind(value);
    afterLongElapsedTime();
    expect((await resolveClaudeBindingOutcome(value.paths, value.state, identity)).record?.ticket_id)
      .toBe(value.ticket.ticket_id);
    expect((await dispatchIntentStatuses(value.paths, value.state))[0]).toMatchObject({ expires_at: null, agent_state: 'active-bound' });
    await observeClaudeSubagentStop(value.paths, value.state, identity);
    expect((await resolveClaudeBindingOutcome(value.paths, value.state, identity)).record).toBeNull();
    expect((await bindClaudeSubagent(value.paths, value.state, identity)).valid).toBe(true);
    expect((await resolveClaudeBindingOutcome(value.paths, value.state, identity)).record).not.toBeNull();
    value.state.expired_tickets.push(value.ticket.ticket_id);
    expect((await resolveClaudeBindingOutcome(value.paths, value.state, identity)).cause).toBe('ticket_not_pending');
    value.state.expired_tickets = [];
    await expireClaudeIntent(value.paths, value.ticket.ticket_id);
    expect((await resolveClaudeBindingOutcome(value.paths, value.state, identity)).record).toBeNull();
  });

  it('keeps the null worker horizon across explicit revocation and a replacement dispatch generation', async () => {
    const value = await fixture();
    await bind(value);
    await observeClaudeSubagentStop(value.paths, value.state, identity);
    await expireClaudeIntent(value.paths, value.ticket.ticket_id);
    const replacement = await prepareClaudeIntent(value.paths, value.ticket, 'worker');
    expect(replacement.nonce).not.toBe(value.prepared.nonce);
    const { record } = await stored(value);
    expect(record).toMatchObject({ status: 'prepared', launch_generation: 2,
      execution_policy_version: 3, expires_at: null });
    expect(record.launch_generations).toMatchObject([
      { generation: 1, status: 'expired', execution_policy_version: 3, expires_at: null },
      { generation: 2, status: 'prepared', execution_policy_version: 3, expires_at: null },
    ]);
    expect(record).not.toHaveProperty('receipt_protocol_recovery');
    expect(await isPreparedUnlaunchedDispatchReplay(value.paths, value.state, value.ticket)).toBe(true);
  });

  it.each([1, 2])('preserves policy v%s worker deadlines and the historical durable record shape', async (version) => {
    const value = await fixture({ version });
    await bind(value);
    const record = (await stored(value)).record;
    expect(record.expires_at).toBe(value.ticket.deadline_at);
    expect(record).not.toHaveProperty('execution_policy_version');
    expect(record.launch_generations[0]).not.toHaveProperty('execution_policy_version');
    afterLongElapsedTime();
    expect(await resolveClaudeBindingOutcome(value.paths, value.state, identity))
      .toEqual({ record: null, cause: 'deadline_elapsed' });
    expect((await bindClaudeSubagent(value.paths, value.state, identity)).valid).toBe(false);
  });

  it('keeps the first native launch claim bounded even when the worker has no deadline', async () => {
    const value = await fixture();
    await launch(value);
    vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 60_001);
    expect((await bindClaudeSubagent(value.paths, value.state, identity)).valid).toBe(false);
    expect((await stored(value)).record.status).toBe('expired');
  });

  it('rejects a widened durable launch claim window even when the worker deadline is null', async () => {
    const value = await fixture();
    await launch(value);
    const { file, record } = await stored(value);
    record.launch_expires_at = new Date(Date.parse(record.launched_at) + 60_001).toISOString();
    record.launch_generations[0].launch_expires_at = record.launch_expires_at;
    await writeFile(file, JSON.stringify(record));
    await expect(bindClaudeSubagent(value.paths, value.state, identity)).rejects.toThrow(/dispatch intent/i);
  });

  it.each([
    ['missing marker', (record) => { delete record.execution_policy_version; }],
    ['unknown marker', (record) => { record.execution_policy_version = 5; }],
    ['missing deadline', (record) => { delete record.expires_at; }],
    ['mismatched generation', (record) => { delete record.launch_generations[0].execution_policy_version; }],
  ])('rejects %s instead of treating invalid durable evidence as timer-free', async (_name, mutate) => {
    const value = await fixture();
    const { file, record } = await stored(value);
    mutate(record);
    await writeFile(file, JSON.stringify(record));
    await expect(isPreparedUnlaunchedDispatchReplay(value.paths, value.state, value.ticket))
      .rejects.toThrow(/dispatch intent/i);
  });

  it('refuses null deadlines on legacy tickets or probe reservations', async () => {
    const value = await fixture({ version: 2 });
    await expect(prepareClaudeIntent(value.paths, { ...value.ticket, deadline_at: null }, 'worker'))
      .rejects.toThrow(/invalid worker deadline/);
    const modern = await fixture({ host: 'codex' });
    await expect(prepareCodexIntent(modern.paths, modern.ticket, 'worker', { codex_task_namespace: 'probe' }))
      .rejects.toThrow(/invalid worker deadline/);
  });

  it('does not let a forged durable v3 marker widen a legacy ticket or receipt authority', async () => {
    const value = await fixture({ version: 2 });
    const binding = await bind(value);
    const capability = binding.additional_context.match(/APE_BOUND_CAPABILITY=([^\n]+)/)?.[1];
    const { file, record } = await stored(value);
    record.execution_policy_version = 3;
    record.expires_at = null;
    for (const generation of record.launch_generations) {
      generation.execution_policy_version = 3;
      generation.expires_at = null;
    }
    await writeFile(file, JSON.stringify(record));
    expect((await resolveClaudeBindingOutcome(value.paths, value.state, identity)).record).toBeNull();
    await expect(dispatchIntentStatuses(value.paths, value.state)).rejects.toThrow(/ticket deadline policy/);
    expect((await dispatchIntentStatuses(value.paths, value.state, { tolerateCorrupt: true }))[0].status).toBe('corrupt');
    expect((await bindClaudeSubagent(value.paths, value.state, identity)).valid).toBe(false);
    expect((await validateClaudeReceiptBinding(value.paths, value.state, value.ticket, capability, 'input-hash')).valid)
      .toBe(false);
  });

  it('keeps a native Codex bootstrap and its bound tools valid after long elapsed time', async () => {
    const value = await fixture({ host: 'codex' });
    await launch(value);
    await bindCodexSubagent(value.paths, value.state, {
      session_id: 'parent-session', turn_id: 'child-turn', agent_id: 'child-one', agent_type: 'default', model,
    });
    const call = {
      session_id: 'child-one', turn_id: 'child-turn', tool_use_id: 'bootstrap-one',
      tool_name: 'mcp__ape__ape_bind', model,
      tool_input: { project_dir: value.directory, bootstrap_capability: value.prepared.bootstrap_capability },
    };
    expect((await bootstrapCodexSubagent(value.paths, value.state, call)).valid).toBe(true);
    afterLongElapsedTime();
    expect(await codexBootstrapStatus(value.paths, value.prepared.bootstrap_capability)).toMatchObject({ ok: true, bound: true });
    expect((await resolveCodexBindingOutcome(value.paths, value.state, { ...call, tool_name: 'Read' })).record)
      .not.toBeNull();
    expect((await bootstrapCodexSubagent(value.paths, value.state, call)).valid).toBe(true);
  });
});
