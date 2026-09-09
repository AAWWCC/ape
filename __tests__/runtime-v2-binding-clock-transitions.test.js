import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { acknowledgeBindingProbe, bindBindingProbe, bindingProbeStatus, bootstrapBindingProbe,
  consumeBindingProbe, launchBindingProbe, observeBindingProbeStop, prepareBindingProbe } from '../lib/runtime/binding-probe.js';
import { completeClaudeReceiptBinding, dispatchIntentStatuses, expireClaudeIntent } from '../lib/runtime/claude-dispatch.js';
import { runtimePaths } from '../lib/runtime/paths.js';

const directories = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(directories.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});
async function fixture(bootstrap_protocol) {
  const root = await mkdtemp(path.join(tmpdir(), 'ape-binding-clock-'));
  directories.push(root);
  const paths = runtimePaths(root);
  await mkdir(paths.runtime, { recursive: true });
  const action = await prepareBindingProbe(paths, { host: 'codex', bootstrap_protocol,
    model: { model: 'gpt-5.6-terra', reasoning_effort: 'medium' } });
  return { paths, action, preparedAt: Date.parse(action.probe.prepared_at) };
}
async function atTime(at, operation) {
  const spy = vi.spyOn(Date, 'now').mockReturnValue(at);
  try { return await operation(); } finally { spy.mockRestore(); }
}
const json = async (file) => JSON.parse(await readFile(file, 'utf8'));
async function probeState(paths) {
  const record = await json(paths.bindingProbe);
  const ticket = await json(path.join(paths.tickets, `${record.ticket_id.replaceAll(':', '_')}.json`));
  return { record, ticket, state: { run_id: record.probe_id, host: 'codex', status: 'running',
    tickets: [ticket], receipts: [], expired_tickets: [] } };
}

describe('native authority transitions after wall-clock rollback', () => {
  it.each([0, 1])('keeps protocol %i launch, binding, completion and consumption readable', async (protocol) => {
    const { paths, action, preparedAt } = await fixture(protocol);
    const launch = await atTime(preparedAt - 5_000, () => launchBindingProbe(paths, {
      session_id: 'clock-parent', tool_use_id: 'clock-spawn', turn_id: 'clock-launch-turn',
      tool_input: action.dispatch.spawn_args,
    }));
    expect(launch.valid).toBe(true);
    const launched = await bindingProbeStatus(paths);
    expect(launched).toMatchObject({ status: 'launched', infrastructure_status: 'awaiting_binding',
      launched_at: action.probe.prepared_at, expires_at: action.probe.expires_at });
    const event = { hook_event_name: 'SubagentStart', session_id: 'clock-parent',
      turn_id: protocol === 1 ? 'clock-child-turn' : 'clock-launch-turn', agent_id: 'clock-child',
      agent_type: 'default', model: 'gpt-5.6-terra' };
    let binding;
    if (protocol === 1) {
      // The host candidate is observed after launch; the wall clock then moves
      // back before the distinct authenticated bootstrap invocation.
      expect(await bindBindingProbe(paths, event)).toMatchObject({ valid: true, bootstrap_required: true });
      binding = await atTime(preparedAt - 10_000, () => bootstrapBindingProbe(paths, {
        hook_event_name: 'PreToolUse', session_id: 'clock-child', turn_id: event.turn_id,
        tool_use_id: 'clock-bootstrap', tool_name: 'mcp__ape__ape_bind',
        tool_input: action.dispatch.bootstrap_args,
      }));
    } else {
      binding = await atTime(preparedAt - 10_000, () => bindBindingProbe(paths, event));
    }
    expect(binding.valid, binding.reason).toBe(true);
    expect(await bindingProbeStatus(paths)).toMatchObject({ status: 'bound', infrastructure_status: 'awaiting_acknowledgement' });
    expect(await atTime(preparedAt - 15_000, () => observeBindingProbeStop(paths, event)))
      .toMatchObject({ matched: true });
    expect(await bindingProbeStatus(paths)).toMatchObject({ status: 'bound' });

    const { record, ticket, state } = await probeState(paths);
    const capability = binding.additional_context.match(/^APE_PROBE_CAPABILITY=(.+)$/m)?.[1];
    expect(await atTime(preparedAt - 25_000, () => acknowledgeBindingProbe(paths, {
      probe_id: record.probe_id, probe_capability: capability,
    }))).toMatchObject({ status: 'completed' });
    expect(await bindingProbeStatus(paths)).toMatchObject({ status: 'completed' });
    expect(await atTime(preparedAt - 30_000, () => consumeBindingProbe(paths, 'codex')))
      .toMatchObject({ ok: true, probe: { status: 'consumed', expires_at: action.probe.expires_at } });
    expect(await bindingProbeStatus(paths)).toMatchObject({ status: 'consumed' });
    expect(await consumeBindingProbe(paths, 'codex')).toMatchObject({ ok: false });
    const final = await json(paths.bindingProbe);
    const times = final.transitions.map(({ at }) => Date.parse(at));
    expect(times).toEqual([...times].sort((a, b) => a - b));

    const intentName = (await readdir(paths.dispatchIntents)).find((name) => name.endsWith('.json'));
    const intentFile = path.join(paths.dispatchIntents, intentName);
    const intent = await json(intentFile);
    await atTime(preparedAt - 20_000, () => completeClaudeReceiptBinding(paths, ticket,
      { file: intentFile, record: intent }, 'a'.repeat(64), { receipt_id: 'receipt-clock', receipt_hash: 'b'.repeat(64) }));
    const statuses = await dispatchIntentStatuses(paths, state);
    expect(statuses).toEqual(expect.arrayContaining([expect.objectContaining({ status: 'completed' })]));
    const completedIntent = await json(intentFile);
    expect(Date.parse(completedIntent.completed_at)).toBeGreaterThanOrEqual(Date.parse(completedIntent.bound_at));

  });

  it('keeps explicitly revoked prepared dispatch evidence readable during clock rollback', async () => {
    const { paths, preparedAt } = await fixture(1);
    const { record, state } = await probeState(paths);
    await atTime(preparedAt - 5_000, () => expireClaudeIntent(paths, record.ticket_id));
    expect(await dispatchIntentStatuses(paths, state))
      .toEqual(expect.arrayContaining([expect.objectContaining({ status: 'expired' })]));
  });
});
