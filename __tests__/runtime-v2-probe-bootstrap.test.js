import { mkdtemp, mkdir, readFile, readdir, rm } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  acknowledgeBindingProbe,
  bindBindingProbe,
  bindingProbeStatus,
  bootstrapBindingProbe,
  consumeBindingProbe,
  isBindingProbeBootstrapInvocation,
  launchBindingProbe,
  prepareBindingProbe,
  resolvesExactBindingProbeIdentity,
} from '../lib/runtime/binding-probe.js';
import { bootstrapCodexSubagent } from '../lib/runtime/claude-dispatch.js';
import { codexBootstrapOrientation } from '../lib/runtime/codex-bootstrap.js';
import { runtimePaths } from '../lib/runtime/paths.js';
import { atomicWriteJson, readJson } from '../lib/runtime/storage.js';

const cleanups = [];
const model = { model: 'gpt-5.6-terra', reasoning_effort: 'medium' };

afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(cleanups.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function fixture() {
  const dir = await mkdtemp(path.join(tmpdir(), 'ape-probe-bootstrap-'));
  cleanups.push(dir);
  const paths = runtimePaths(dir);
  await mkdir(paths.runtime, { recursive: true });
  return paths;
}

const prepare = (paths) => prepareBindingProbe(paths, { host: 'codex', model });

async function launch(paths, action, { turn = 'parent-turn', tool = 'spawn-call' } = {}) {
  const result = await launchBindingProbe(paths, {
    hook_event_name: 'PreToolUse',
    session_id: 'parent-session',
    turn_id: turn,
    tool_use_id: tool,
    tool_name: 'collaborationspawn_agent',
    tool_input: action.dispatch.spawn_args,
  });
  expect(result.valid).toBe(true);
}

async function child(paths, { agent = 'child-agent', turn = 'distinct-child-turn', effectiveModel = model.model } = {}) {
  const event = {
    hook_event_name: 'SubagentStart',
    session_id: 'parent-session',
    turn_id: turn,
    agent_id: agent,
    agent_type: 'default',
    model: effectiveModel,
  };
  expect(await bindBindingProbe(paths, event)).toMatchObject({ matched: true, valid: true, bootstrap_required: true });
  return event;
}

function bootstrap(action, event, { tool = 'first-bootstrap-call', childSession = true } = {}) {
  // Actual child PreToolUse need not repeat agent_id/type: the native child
  // turn and session alias resolve the prior SubagentStart evidence.
  return {
    hook_event_name: 'PreToolUse',
    session_id: childSession ? event.agent_id : event.session_id,
    turn_id: event.turn_id,
    tool_use_id: tool,
    tool_name: 'mcp__ape__ape_bind',
    tool_input: action.dispatch.bootstrap_args,
  };
}

const ack = (binding) => binding.additional_context?.match(/^APE_PROBE_CAPABILITY=(.+)$/m)?.[1];

describe('native probe bootstrap protocol 1', () => {
  it('issues a replayable versioned envelope without changing native spawn arguments', async () => {
    const paths = await fixture();
    const action = await prepare(paths);
    const replay = await prepare(paths);
    expect(action.dispatch.bootstrap_protocol).toBe(1);
    expect(replay.dispatch).toEqual(action.dispatch);
    expect(action.dispatch.spawn_args).toEqual({
      task_name: action.dispatch.agent_name,
      fork_turns: 'none',
      message: action.dispatch.message,
      model: model.model,
      reasoning_effort: model.reasoning_effort,
    });
    expect(action.dispatch.message).toContain(JSON.stringify(action.dispatch.bootstrap_args));
    expect(action.dispatch.message).toContain('ape_bind');
    const discovery = action.dispatch.message.split('\n').find((line) => line.includes('tool_search.tool_search_tool'));
    expect(discovery).toContain('at most one bounded host tool-catalog search');
    expect(discovery).toContain('using only the literal registered tool name ape_bind, not a host-qualified invocation alias');
    expect(discovery).not.toContain('mcp__');
    expect(discovery).not.toContain(action.dispatch.bootstrap_args.bootstrap_capability);
    expect(discovery).not.toContain(paths.root);
    expect(action.dispatch.message).toContain('Your first APE operation must be the installed ape_bind');
    expect(action.dispatch.message).toContain('context is expected to be absent. Do not stop for that absence');
    expect(action.dispatch.message).toContain('Tool discovery and ape_bind are permitted bootstrap operations, not stage work');
    expect(action.dispatch.message.match(/^[123]\./gm)).toEqual(['1.', '2.', '3.']);
    expect(action.dispatch.message.indexOf('1. Execute this assigned bootstrap now')).toBeLessThan(action.dispatch.message.indexOf(discovery));
    expect(action.dispatch.message.indexOf(discovery)).toBeLessThan(action.dispatch.message.indexOf('2. Your first APE operation'));
    expect(action.dispatch.message.indexOf(JSON.stringify(action.dispatch.bootstrap_args))).toBeLessThan(action.dispatch.message.indexOf('3. Only AFTER ape_bind returns'));
    const afterBinding = action.dispatch.message.split('3. Only AFTER ape_bind returns')[1];
    expect(afterBinding).toContain('complete authenticated hook context containing APE_PROBE_CAPABILITY and the exact final acknowledgement JSON');
    expect(afterBinding).toContain('If missing then, stop without acknowledgement');
    expect(afterBinding).toContain('Do not call any tools after ape_bind, including tool discovery');
    expect(afterBinding).toContain('Return only that injected acknowledgement');
    expect(action.dispatch.message).not.toContain('If authoritative context is absent, stop');
    expect(action.dispatch.message).toContain('mcp__ape.ape_bind; normalized alias mcp__ape__ape_bind');
    expect(action.dispatch.message).toContain('never a similarly named tool from another plugin');
    expect(action.dispatch.message).toContain('only to inspect exact-matching ALL_TOOLS metadata for ape_bind or invoke that one installed tool');
    expect(action.dispatch.message).toContain('does not permit functions.exec_command, shell commands');
    expect(action.dispatch.message).toContain('Do not inspect or modify the project, access files, do stage work, or call any other MCP tool');
    expect(action.dispatch.message).toContain('Do not call any tools after ape_bind, including tool discovery');
    expect(action.dispatch.message).toContain('No other tools are permitted');
    expect(action.dispatch.message).toContain('Return only that injected acknowledgement');
    expect(action.dispatch.message).not.toContain('Before any other tool call');
    const record = await readJson(paths.bindingProbe);
    expect(record).toMatchObject({ version: 3, bootstrap_protocol: 1, status: 'prepared' });
    expect(await readFile(paths.bindingProbe, 'utf8')).not.toContain(action.dispatch.bootstrap_args.bootstrap_capability);
    expect((await bindingProbeStatus(paths)).infrastructure_status).toBe('awaiting_launch');
  });

  it('does not bind or acknowledge through SubagentStart alone', async () => {
    const paths = await fixture();
    const action = await prepare(paths);
    await launch(paths, action);
    const event = await child(paths);
    expect(await resolvesExactBindingProbeIdentity(paths, event)).toBe(false);
    expect((await bindingProbeStatus(paths)).infrastructure_status).toBe('awaiting_binding');
    await expect(acknowledgeBindingProbe(paths, {
      probe_id: action.probe.probe_id,
      probe_capability: action.dispatch.bootstrap_args.bootstrap_capability,
    })).rejects.toThrow(/cannot be acknowledged while launched/);
  });

  it('delivers only conditional capability-free orientation through the real SubagentStart hook', async () => {
    const paths = await fixture();
    const action = await prepare(paths);
    await launch(paths, action);
    const env = { ...process.env, CODEX_CWD: paths.root };
    delete env.CLAUDECODE;
    delete env.CLAUDE_CODE;
    delete env.CLAUDE_PROJECT_DIR;
    const invoke = (native) => JSON.parse(execFileSync(process.execPath, [
      fileURLToPath(new URL('../bin/ape-hook.mjs', import.meta.url)),
    ], {
      cwd: paths.root, env, encoding: 'utf8',
      input: JSON.stringify({ hook_event_name: 'SubagentStart', project_dir: paths.root, ...native }),
    }));
    const before = await readFile(paths.bindingProbe, 'utf8');
    const result = invoke({
      session_id: 'parent-session', turn_id: 'oriented-child-turn', agent_id: 'oriented-child',
      agent_type: 'default', model: model.model,
    });
    expect(result).toEqual({ hookSpecificOutput: {
      hookEventName: 'SubagentStart', additionalContext: codexBootstrapOrientation(),
    } });
    const context = result.hookSpecificOutput.additionalContext;
    expect(context).not.toContain(action.dispatch.bootstrap_args.bootstrap_capability);
    expect(context).not.toContain(action.probe.probe_id);
    expect(context).not.toContain(action.dispatch.agent_name);
    expect(context).not.toContain(paths.root);
    expect(context).not.toMatch(/APE_(?:BOUND|RECEIPT|PROBE)_CAPABILITY=|Immutable StageTicket reference/u);
    expect(await readFile(paths.bindingProbe, 'utf8')).toBe(before);
    const malformed = invoke({
      session_id: 'parent-session', turn_id: 'missing-model-turn', agent_id: 'missing-model-child',
      agent_type: 'default',
    });
    expect(malformed.systemMessage).toMatch(/native child identity and model evidence/);
    expect(malformed.hookSpecificOutput?.additionalContext).toBeUndefined();
    expect(await readFile(paths.bindingProbe, 'utf8')).toBe(before);
    expect((await bindingProbeStatus(paths)).status).toBe('launched');
  });

  it('binds distinct child/parent turns through production authority and completes the corroborated lifecycle', async () => {
    const paths = await fixture();
    const action = await prepare(paths);
    await launch(paths, action);
    const event = await child(paths);
    const input = bootstrap(action, event);
    expect(await isBindingProbeBootstrapInvocation(paths, input)).toBe(false);
    const binding = await bootstrapBindingProbe(paths, input);
    expect(binding.valid).toBe(true);
    expect(binding.additional_context).toContain('For this synthetic probe only');
    expect(binding.additional_context).toContain('Do not call any tools after ape_bind');
    expect(binding.additional_context).toContain('Do not load the synthetic ticket and do not call ape_validate_receipt');
    const capability = ack(binding);
    expect(capability).toMatch(/^[A-Za-z0-9_-]{32,256}$/);
    expect(capability).not.toBe(action.dispatch.bootstrap_args.bootstrap_capability);
    expect(await resolvesExactBindingProbeIdentity(paths, event)).toBe(true);
    expect(await isBindingProbeBootstrapInvocation(paths, input)).toBe(true);
    expect((await bindingProbeStatus(paths)).infrastructure_status).toBe('awaiting_acknowledgement');
    expect((await acknowledgeBindingProbe(paths, {
      probe_id: action.probe.probe_id, probe_capability: capability,
    })).status).toBe('completed');
    expect((await bindingProbeStatus(paths)).infrastructure_status).toBe('ready');
    expect(await consumeBindingProbe(paths, 'codex')).toMatchObject({ ok: true, probe: { status: 'consumed' } });
    expect(await resolvesExactBindingProbeIdentity(paths, event)).toBe(true);
  });

  it('admits only the identical first invocation after fencing, not a later tool call or another child', async () => {
    const paths = await fixture();
    const action = await prepare(paths);
    await launch(paths, action);
    const event = await child(paths);
    const input = bootstrap(action, event, { childSession: false });
    expect((await bootstrapBindingProbe(paths, input)).valid).toBe(true);
    const before = await readFile(paths.bindingProbe, 'utf8');
    expect((await bootstrapBindingProbe(paths, input)).valid).toBe(true);
    expect(await isBindingProbeBootstrapInvocation(paths, input)).toBe(true);
    const next = { ...input, tool_use_id: 'later-bootstrap-call' };
    expect(await isBindingProbeBootstrapInvocation(paths, next)).toBe(false);
    expect((await bootstrapBindingProbe(paths, next)).valid).toBe(false);
    const other = await child(paths, { agent: 'other-child', turn: 'other-child-turn' });
    expect((await bootstrapBindingProbe(paths, bootstrap(action, other))).valid).toBe(false);
    const after = await readJson(paths.bindingProbe);
    expect(after.bound_agent_id).toBe(event.agent_id);
    expect(after.bootstrap_invocation.tool_use_id).toBe(input.tool_use_id);
    expect(after.transitions).toEqual(JSON.parse(before).transitions);
  });

  it('retires delayed A by its exact token without poisoning replacement B on the same parent turn', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const paths = await fixture();
    const first = await prepare(paths);
    await launch(paths, first);
    const firstChild = await child(paths, { agent: 'child-A', turn: 'child-turn-A' });
    vi.setSystemTime(Date.now() + 6 * 60_000);
    const second = await prepare(paths);
    await launch(paths, second, { tool: 'replacement-spawn', turn: 'parent-turn' });
    const secondChild = await child(paths, { agent: 'child-B', turn: 'child-turn-B' });
    const before = await readFile(paths.bindingProbe, 'utf8');
    const stale = await bootstrapBindingProbe(paths, bootstrap(first, firstChild));
    expect(stale).toMatchObject({ matched: true, valid: false });
    expect(stale.reason).toContain('retired probe generation');
    expect(await readFile(paths.bindingProbe, 'utf8')).toBe(before);
    expect(await resolvesExactBindingProbeIdentity(paths, firstChild)).toBe(true);
    expect(await resolvesExactBindingProbeIdentity(paths, secondChild)).toBe(false);
    expect((await bootstrapBindingProbe(paths, bootstrap(second, firstChild))).valid).toBe(false);
    expect((await bootstrapBindingProbe(paths, bootstrap(second, secondChild))).valid).toBe(true);
    expect(await readJson(paths.bindingProbe)).toMatchObject({ probe_id: second.probe.probe_id, bound_agent_id: 'child-B' });
    await expect(readdir(paths.bindingProbeRetiredTurns)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('requires native provisional evidence and rejects a parent turn impersonation', async () => {
    const paths = await fixture();
    const action = await prepare(paths);
    await launch(paths, action);
    const event = await child(paths);
    const input = bootstrap(action, event);
    const before = await readFile(paths.bindingProbe, 'utf8');
    for (const forged of [
      { ...input, session_id: 'parent-session', turn_id: 'parent-turn' },
      { ...input, session_id: 'never-observed-child' },
      { ...input, agent_id: 'forged-agent' },
    ]) {
      expect((await bootstrapBindingProbe(paths, forged)).valid).toBe(false);
    }
    const { last_binding_observation: observation, ...unchangedAuthority } = await readJson(paths.bindingProbe);
    expect(unchangedAuthority).toEqual(JSON.parse(before));
    expect(observation).toMatchObject({ outcome: 'rejected', code: 'bootstrap_candidate_invalid' });
    expect(Object.keys(observation).sort()).toEqual(['code', 'observed_at', 'outcome']);
  });

  it('never accepts an acknowledgement when independent production binding evidence disappears', async () => {
    const paths = await fixture();
    const action = await prepare(paths);
    await launch(paths, action);
    const event = await child(paths);
    const binding = await bootstrapBindingProbe(paths, bootstrap(action, event));
    expect(binding.valid).toBe(true);
    const files = (await readdir(paths.dispatchIntents)).filter((name) => name.endsWith('.json'));
    expect(files).toHaveLength(1);
    await rm(path.join(paths.dispatchIntents, files[0]));
    expect((await bindingProbeStatus(paths)).infrastructure_status).toBe('failed');
    await expect(acknowledgeBindingProbe(paths, {
      probe_id: action.probe.probe_id, probe_capability: ack(binding),
    })).rejects.toThrow(/production/);
  });

  it('keeps an exact rejected wrong-model canary fenced without consuming the proper launch', async () => {
    const paths = await fixture();
    const action = await prepare(paths);
    await launch(paths, action);
    const wrong = await child(paths, { agent: 'wrong-model-child', turn: 'wrong-model-turn', effectiveModel: 'gpt-5.4-mini' });
    const rejected = await bootstrapBindingProbe(paths, bootstrap(action, wrong));
    expect(rejected.valid).toBe(false);
    expect(rejected.reason).toContain('model');
    expect(await resolvesExactBindingProbeIdentity(paths, wrong)).toBe(true);
    expect((await bindingProbeStatus(paths)).status).toBe('launched');
    const correct = await child(paths);
    expect((await bootstrapBindingProbe(paths, bootstrap(action, correct))).valid).toBe(true);
    expect(await resolvesExactBindingProbeIdentity(paths, wrong)).toBe(true);
  });

  it('recovers only the admitted call after production binding precedes projection publication', async () => {
    const paths = await fixture();
    const action = await prepare(paths);
    await launch(paths, action);
    const event = await child(paths);
    const input = bootstrap(action, event);
    const record = await readJson(paths.bindingProbe);
    const ticket = await readJson(path.join(paths.tickets, `${record.ticket_id.replaceAll(':', '_')}.json`));
    const production = await bootstrapCodexSubagent(paths, {
      run_id: record.probe_id, host: 'codex', status: 'running', tickets: [ticket], receipts: [], expired_tickets: [],
    }, input);
    expect(production.valid).toBe(true);
    expect((await readJson(paths.bindingProbe)).status).toBe('launched');
    const later = { ...input, tool_use_id: 'later-unadmitted-call' };
    expect((await bootstrapBindingProbe(paths, later)).valid).toBe(false);
    expect(await isBindingProbeBootstrapInvocation(paths, later)).toBe(false);
    expect((await bootstrapBindingProbe(paths, input)).valid).toBe(true);
    expect((await bindingProbeStatus(paths)).infrastructure_status).toBe('awaiting_acknowledgement');
  });

  it('retains exact authenticated canary fencing when the mutable probe projection is corrupt', async () => {
    const paths = await fixture();
    const action = await prepare(paths);
    await launch(paths, action);
    const event = await child(paths);
    await atomicWriteJson(paths.bindingProbe, { torn: true });
    await expect(bootstrapBindingProbe(paths, bootstrap(action, event))).rejects.toThrow(/structurally invalid/);
    await rm(paths.bindingProbe);
    expect(await resolvesExactBindingProbeIdentity(paths, event)).toBe(true);
  });

  it('rejects a bound v3 projection with a torn bootstrap invocation without losing the exact canary fence', async () => {
    const paths = await fixture();
    const action = await prepare(paths);
    await launch(paths, action);
    const event = await child(paths);
    const binding = await bootstrapBindingProbe(paths, bootstrap(action, event));
    expect(binding.valid).toBe(true);
    const record = await readJson(paths.bindingProbe);
    await atomicWriteJson(paths.bindingProbe, { ...record, bootstrap_invocation: {} });
    await expect(bindingProbeStatus(paths)).rejects.toThrow(/structurally invalid/);
    await expect(acknowledgeBindingProbe(paths, {
      probe_id: action.probe.probe_id, probe_capability: ack(binding),
    })).rejects.toThrow(/structurally invalid/);
    expect(await resolvesExactBindingProbeIdentity(paths, event)).toBe(true);
  });

  it('does not turn an unknown bootstrap record marker into SubagentStart blanket quarantine', async () => {
    const paths = await fixture();
    const action = await prepare(paths);
    await launch(paths, action);
    const record = await readJson(paths.bindingProbe);
    await atomicWriteJson(paths.bindingProbe, { ...record, version: 99, bootstrap_protocol: 99 });
    expect(await bindBindingProbe(paths, {
      session_id: 'parent-session', agent_id: 'unrelated-child', turn_id: 'parent-turn', agent_type: 'default',
    })).toEqual({ matched: false });
    await expect(readdir(paths.bindingProbeQuarantine)).rejects.toMatchObject({ code: 'ENOENT' });
  });
});
