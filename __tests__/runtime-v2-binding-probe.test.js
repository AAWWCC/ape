import { execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import {
  acknowledgeBindingProbe,
  bindingProbeStatus,
  consumeBindingProbe,
  prepareBindingProbe as prepareBindingProbeImplementation,
} from '../lib/runtime/binding-probe.js';
import { runtimePaths } from '../lib/runtime/paths.js';
import { readJson } from '../lib/runtime/storage.js';
import { abortRun, prepareNativeBindingProbe, startRun } from '../lib/runtime/service.js';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const cleanups = [];

// Retain adversarial coverage of installed legacy probe records. The current
// capability-backed protocol is exercised independently in probe-bootstrap.
const prepareBindingProbe = (paths, options = {}) =>
  prepareBindingProbeImplementation(paths, { ...options, bootstrap_protocol: 0 });

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((entry) => rm(entry, { recursive: true, force: true })));
});

function invokeHook(input, { canaryOnly = false, codexCwd = input.project_dir } = {}) {
  return new Promise((resolve, reject) => {
    const env = { ...process.env };
    if (typeof codexCwd === 'string' && codexCwd.length > 0) env.CODEX_CWD = codexCwd;
    else delete env.CODEX_CWD;
    const args = [path.join(root, 'bin', 'ape-hook.mjs')];
    if (canaryOnly) args.push('--ape-canary-only');
    const child = spawn(process.execPath, args, {
      cwd: root,
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    const timeout = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error('probe hook did not finish within 10 seconds'));
    }, 10_000);
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', (code) => {
      clearTimeout(timeout);
      if (code !== 0) reject(new Error(stderr));
      else resolve(JSON.parse(stdout));
    });
    child.stdin.end(`${JSON.stringify(input)}\n`);
  });
}

function shiftProbeTimestamps(record, deltaMs) {
  const shift = (value) => new Date(Date.parse(value) + deltaMs).toISOString();
  const timestampKeys = [
    'prepared_at',
    'expires_at',
    'launched_at',
    'launch_expires_at',
    'bound_at',
    'completed_at',
    'consumed_at',
    'canary_stopped_at',
  ];
  const shifted = { ...record };
  for (const key of timestampKeys) {
    if (record[key]) shifted[key] = shift(record[key]);
  }
  shifted.transitions = record.transitions.map((transition) => ({
    ...transition,
    at: shift(transition.at),
  }));
  if (record.last_binding_observation) {
    shifted.last_binding_observation = {
      ...record.last_binding_observation,
      observed_at: shift(record.last_binding_observation.observed_at),
    };
  }
  shifted.retired_identities = (record.retired_identities ?? []).map((identity) => ({
    ...identity,
    retired_at: shift(identity.retired_at),
  }));
  return shifted;
}

function legacyV1ProbeRecord({
  status = 'bound',
  sessionId = 'legacy-v1-session',
  agentId = 'legacy-v1-agent',
} = {}) {
  const preparedMs = Date.now() - 1_000;
  const times = {
    prepared: new Date(preparedMs).toISOString(),
    launched: new Date(preparedMs + 10).toISOString(),
    bound: new Date(preparedMs + 20).toISOString(),
    completed: new Date(preparedMs + 30).toISOString(),
    consumed: new Date(preparedMs + 40).toISOString(),
  };
  const statuses = ['prepared', 'launched', 'bound', 'completed', 'consumed'];
  const record = {
    version: 1,
    probe_id: 'probe-legacy-upgrade-fixture',
    host: 'codex',
    agent_type: 'explorer',
    model: { model: 'gpt-5.6-terra', reasoning_effort: 'medium' },
    launch_name_hash: 'a'.repeat(64),
    status,
    prepared_at: times.prepared,
    expires_at: new Date(preparedMs + (5 * 60_000)).toISOString(),
    launch_observations: status === 'prepared' ? 0 : 1,
    transitions: statuses.slice(0, statuses.indexOf(status) + 1).map((entry) => ({
      status: entry,
      at: times[entry],
    })),
  };
  if (status !== 'prepared') {
    Object.assign(record, {
      parent_session_id: 'legacy-v1-parent',
      tool_use_id: 'legacy-v1-tool',
      launched_at: times.launched,
      launch_expires_at: new Date(preparedMs + 60_000).toISOString(),
    });
  }
  if (['bound', 'completed', 'consumed'].includes(status)) {
    Object.assign(record, {
      bound_session_id: sessionId,
      bound_agent_id: agentId,
      capability_hash: 'b'.repeat(64),
      bound_at: times.bound,
    });
  }
  if (['completed', 'consumed'].includes(status)) record.completed_at = times.completed;
  if (status === 'consumed') record.consumed_at = times.consumed;
  return record;
}

async function project({ ape = true, runtime = true } = {}) {
  const dir = await mkdtemp(path.join(tmpdir(), 'ape-binding-probe-'));
  cleanups.push(dir);
  await mkdir(path.join(dir, 'docs'), { recursive: true });
  if (ape) {
    await mkdir(
      runtime ? path.join(dir, '.ape', 'runtime') : path.join(dir, '.ape'),
      { recursive: true },
    );
  }
  await writeFile(path.join(dir, 'docs', 'note.md'), '# Note\n');
  execFileSync('git', ['init', '-q'], { cwd: dir });
  execFileSync('git', ['config', 'user.email', 'ape@example.test'], { cwd: dir });
  execFileSync('git', ['config', 'user.name', 'APE Test'], { cwd: dir });
  execFileSync('git', ['add', '.'], { cwd: dir });
  execFileSync('git', ['commit', '-qm', 'baseline'], { cwd: dir });
  return dir;
}

async function onlyProbeIntentFile(paths) {
  const files = (await readdir(paths.dispatchIntents)).filter((name) => name.endsWith('.json'));
  expect(files).toHaveLength(1);
  return path.join(paths.dispatchIntents, files[0]);
}

async function shardedEntryCount(rootDirectory) {
  let shards;
  try {
    shards = await readdir(rootDirectory);
  } catch (error) {
    if (error?.code === 'ENOENT') return 0;
    throw error;
  }
  const entries = await Promise.all(shards.map(async (shard) => (
    await readdir(path.join(rootDirectory, shard))
  )));
  return entries.flat().filter((name) => name.endsWith('.json')).length;
}

async function quarantineEntryCount(paths) {
  return shardedEntryCount(paths.bindingProbeQuarantine);
}

async function fallbackQuarantineEntryCount(paths) {
  return shardedEntryCount(paths.bindingProbeQuarantineFallback);
}

async function retiredTurnEntryCount(paths) {
  return shardedEntryCount(paths.bindingProbeRetiredTurns);
}

function probeTicketFile(paths, record) {
  return path.join(paths.tickets, `${record.ticket_id.replaceAll(':', '_')}.json`);
}

function startInput() {
  return {
    objective: 'Prove native binding before creating a real run',
    mode: 'phase',
    lane: 'mechanical',
    host: 'codex',
    binding_protocol: 'native-v1',
    binding_probe: 'required-v1',
    claimed_paths: ['docs/note.md'],
    test_paths: [],
    requirements: ['R-BINDING-PROBE'],
    risk_triggers: [],
    behavioral: false,
    hooks_trusted: true,
    subagents_available: true,
    explicit_invocation: true,
  };
}

async function launchAndBindProbe(dir, action, {
  parent = 'probe-parent',
  child = 'probe-child',
  agent = 'probe-agent',
  turn = 'probe-turn',
  tool = 'probe-tool',
} = {}) {
  const launch = await invokeHook({
    hook_event_name: 'PreToolUse',
    project_dir: dir,
    session_id: parent,
    turn_id: turn,
    tool_use_id: tool,
    tool_name: 'collaborationspawn_agent',
    tool_input: action.dispatch.spawn_args,
  });
  expect(launch).toEqual({});
  const binding = await invokeHook({
    hook_event_name: 'SubagentStart',
    project_dir: dir,
    session_id: child,
    turn_id: turn,
    agent_id: agent,
    agent_type: 'default',
  });
  expect(binding.systemMessage).toBeUndefined();
  return binding;
}

async function bootstrapObservedChild(dir, action, { parent, agent, turn }) {
  const observed = await invokeHook({
    hook_event_name: 'SubagentStart',
    project_dir: dir,
    session_id: parent,
    turn_id: turn,
    agent_id: agent,
    agent_type: 'default',
    model: action.dispatch.model.model,
  });
  expect(observed.systemMessage).toBeUndefined();
  expect(observed.hookSpecificOutput?.additionalContext ?? '').not.toContain('APE_RECEIPT_CAPABILITY=');
  return invokeHook({
    hook_event_name: 'PreToolUse',
    project_dir: dir,
    session_id: agent,
    turn_id: turn,
    tool_use_id: `bootstrap-${agent}`,
    tool_name: 'mcp__ape__ape_bind',
    tool_input: action.dispatch.bootstrap_args,
  });
}

describe('APE v2 mandatory pre-run native binding proof', () => {
  it('replays a lost prepared response with the exact durable native spawn envelope', async () => {
    const dir = await project();
    const paths = runtimePaths(dir);
    const first = await prepareBindingProbe(paths, {
      host: 'codex',
      model: { model: 'gpt-5.6-terra', reasoning_effort: 'medium' },
    });
    const second = await prepareBindingProbe(paths, {
      host: 'codex',
      model: { model: 'gpt-5.6-sol', reasoning_effort: 'high' },
    });

    expect(second.probe.probe_id).toBe(first.probe.probe_id);
    expect(second.dispatch).toMatchObject({
      agent_name: first.dispatch.agent_name,
      model: first.dispatch.model,
      spawn_args: {
        task_name: first.dispatch.agent_name,
        fork_turns: 'none',
        model: first.dispatch.model.model,
        reasoning_effort: first.dispatch.model.reasoning_effort,
        message: first.dispatch.message,
      },
    });
    expect(second.dispatch.spawn_args).toEqual(first.dispatch.spawn_args);
    expect((await readdir(paths.dispatchIntents)).filter((name) => name.endsWith('.json'))).toHaveLength(1);
  });

  it.each(['bound', 'completed', 'consumed'])(
    'preserves a shipped v1 %s canary identity across an in-place upgrade',
    async (status) => {
      const dir = await project();
      const paths = runtimePaths(dir);
      const record = legacyV1ProbeRecord({ status });
      await mkdir(paths.runtime, { recursive: true });
      await writeFile(paths.bindingProbe, `${JSON.stringify(record)}\n`);

      const exact = await invokeHook({
        hook_event_name: 'PreToolUse',
        project_dir: dir,
        session_id: record.bound_session_id,
        agent_id: record.bound_agent_id,
        agent_type: 'default',
        tool_name: 'mcp__future_provider__mutate',
        tool_input: {},
      }, { canaryOnly: true });
      expect(exact.hookSpecificOutput?.permissionDecision ?? exact.decision).toBe('deny');
      expect(await quarantineEntryCount(paths)).toBe(1);
      expect(await invokeHook({
        hook_event_name: 'PreToolUse',
        project_dir: dir,
        session_id: `unrelated-${status}-session`,
        agent_id: `unrelated-${status}-agent`,
        agent_type: 'default',
        tool_name: 'mcp__future_provider__mutate',
        tool_input: {},
      }, { canaryOnly: true })).toEqual({});

      await writeFile(paths.bindingProbe, '{legacy-record-now-torn\n');
      const durable = await invokeHook({
        hook_event_name: 'PreToolUse',
        project_dir: dir,
        session_id: record.bound_session_id,
        agent_id: record.bound_agent_id,
        agent_type: 'default',
        tool_name: 'Read',
        tool_input: { file_path: 'docs/note.md' },
      }, { canaryOnly: true });
      expect(durable.hookSpecificOutput?.permissionDecision ?? durable.decision).toBe('deny');
    },
  );

  it('tombstones a shipped v1 bound identity before replacing its legacy record', async () => {
    const dir = await project();
    const paths = runtimePaths(dir);
    const record = legacyV1ProbeRecord({
      status: 'bound',
      sessionId: 'legacy-replacement-session',
      agentId: 'legacy-replacement-agent',
    });
    await mkdir(paths.runtime, { recursive: true });
    await writeFile(paths.bindingProbe, `${JSON.stringify(record)}\n`);
    expect(await quarantineEntryCount(paths)).toBe(0);

    const replacement = await prepareBindingProbe(paths, {
      host: 'codex',
      model: { model: 'gpt-5.6-terra', reasoning_effort: 'medium' },
    });
    expect(replacement.probe.probe_id).not.toBe(record.probe_id);
    expect((await readJson(paths.bindingProbe, null)).version).toBe(2);
    expect(await quarantineEntryCount(paths)).toBe(1);
    const exact = await invokeHook({
      hook_event_name: 'PreToolUse',
      project_dir: dir,
      session_id: record.bound_session_id,
      agent_id: record.bound_agent_id,
      agent_type: 'default',
      tool_name: 'mcp__future_provider__mutate',
      tool_input: {},
    }, { canaryOnly: true });
    expect(exact.hookSpecificOutput?.permissionDecision ?? exact.decision).toBe('deny');
  });

  it('tombstones the bounded child of a still-live earliest-v1 launched probe before denying it', async () => {
    const dir = await project();
    const paths = runtimePaths(dir);
    const record = legacyV1ProbeRecord({ status: 'launched' });
    expect(record).not.toHaveProperty('binding_agent_type');
    await mkdir(paths.runtime, { recursive: true });
    await writeFile(paths.bindingProbe, `${JSON.stringify(record)}\n`);

    const binding = await invokeHook({
      hook_event_name: 'SubagentStart',
      project_dir: dir,
      session_id: 'legacy-v1-late-child',
      agent_id: 'legacy-v1-late-agent',
      agent_type: 'default',
    });
    expect(binding.systemMessage).toMatch(/legacy probe must be replaced/i);
    expect(await quarantineEntryCount(paths)).toBe(1);
    await writeFile(paths.bindingProbe, 'null\n');
    const fenced = await invokeHook({
      hook_event_name: 'PreToolUse',
      project_dir: dir,
      session_id: 'legacy-v1-late-child',
      agent_id: 'legacy-v1-late-agent',
      agent_type: 'default',
      tool_name: 'mcp__future_provider__mutate',
      tool_input: {},
    }, { canaryOnly: true });
    expect(fenced.hookSpecificOutput?.permissionDecision ?? fenced.decision).toBe('deny');
  });

  it('migrates a valid v1 bound identity whose write crossed the legacy TTL boundary', async () => {
    const dir = await project();
    const paths = runtimePaths(dir);
    const record = legacyV1ProbeRecord({
      status: 'bound',
      sessionId: 'legacy-boundary-session',
      agentId: 'legacy-boundary-agent',
    });
    const expiresMs = Date.parse(record.expires_at);
    record.launched_at = new Date(expiresMs + 1).toISOString();
    record.launch_expires_at = record.expires_at;
    record.bound_at = new Date(expiresMs + 2).toISOString();
    record.transitions[1].at = record.launched_at;
    record.transitions[2].at = record.bound_at;
    await mkdir(paths.runtime, { recursive: true });
    await writeFile(paths.bindingProbe, `${JSON.stringify(record)}\n`);

    const replacement = await prepareBindingProbe(paths, {
      host: 'codex',
      model: { model: 'gpt-5.6-terra', reasoning_effort: 'medium' },
    });
    expect(replacement.probe.probe_id).not.toBe(record.probe_id);
    expect(await quarantineEntryCount(paths)).toBe(1);
    const fenced = await invokeHook({
      hook_event_name: 'PreToolUse',
      project_dir: dir,
      session_id: record.bound_session_id,
      agent_id: record.bound_agent_id,
      agent_type: 'default',
      tool_name: 'mcp__future_provider__mutate',
      tool_input: {},
    }, { canaryOnly: true });
    expect(fenced.hookSpecificOutput?.permissionDecision ?? fenced.decision).toBe('deny');
  });

  it('keeps exact expired and replaced canaries quarantined while unrelated children stay neutral', async () => {
    const dir = await project();
    const paths = runtimePaths(dir);
    const first = await prepareBindingProbe(paths, {
      host: 'codex',
      model: { model: 'gpt-5.6-terra', reasoning_effort: 'medium' },
    });
    await launchAndBindProbe(dir, first, {
      child: 'expired-bound-child',
      agent: 'expired-bound-agent',
      turn: 'expired-bound-turn',
    });
    const bound = await readJson(paths.bindingProbe, null);
    await writeFile(
      paths.bindingProbe,
      `${JSON.stringify(shiftProbeTimestamps(bound, -10 * 60_000))}\n`,
    );

    const expiredStart = await invokeHook({
      hook_event_name: 'SubagentStart',
      project_dir: dir,
      session_id: 'expired-bound-child',
      turn_id: 'expired-bound-turn',
      agent_id: 'expired-bound-agent',
      agent_type: 'x'.repeat(2_000),
    });
    expect(expiredStart.systemMessage).toMatch(/canary identity is retired/i);
    for (const toolName of ['Read', 'mcp__future_provider__mutate']) {
      const denied = await invokeHook({
        hook_event_name: 'PreToolUse',
        project_dir: dir,
        session_id: 'expired-bound-child',
        agent_id: 'expired-bound-agent',
        agent_type: 'x'.repeat(2_000),
        tool_name: toolName,
        tool_input: { file_path: 'docs/note.md' },
      }, { canaryOnly: true });
      expect(denied.hookSpecificOutput?.permissionDecision ?? denied.decision).toBe('deny');
    }
    expect(await invokeHook({
      hook_event_name: 'SubagentStart',
      project_dir: dir,
      session_id: 'unrelated-expired-child',
      turn_id: 'unrelated-expired-turn',
      agent_id: 'unrelated-expired-agent',
      agent_type: 'default',
    })).toEqual({});
    expect(await invokeHook({
      hook_event_name: 'PreToolUse',
      project_dir: dir,
      session_id: 'unrelated-expired-child',
      agent_id: 'unrelated-expired-agent',
      agent_type: 'default',
      tool_name: 'mcp__future_provider__mutate',
      tool_input: {},
    }, { canaryOnly: true })).toEqual({});

    const replacement = await prepareBindingProbe(paths, {
      host: 'codex',
      model: { model: 'gpt-5.6-terra', reasoning_effort: 'medium' },
    });
    expect(replacement.probe.probe_id).not.toBe(first.probe.probe_id);
    expect(await invokeHook({
      hook_event_name: 'PreToolUse',
      project_dir: dir,
      session_id: 'expired-bound-child',
      agent_id: 'expired-bound-agent',
      tool_name: 'Read',
      tool_input: { file_path: 'docs/note.md' },
    }, { canaryOnly: true })).not.toEqual({});
  });

  it('quarantines a matching late child from an expired launched probe without blocking another turn', async () => {
    const dir = await project();
    const paths = runtimePaths(dir);
    const action = await prepareBindingProbe(paths, {
      host: 'codex',
      model: { model: 'gpt-5.6-terra', reasoning_effort: 'medium' },
    });
    await invokeHook({
      hook_event_name: 'PreToolUse',
      project_dir: dir,
      session_id: 'late-parent',
      turn_id: 'late-probe-turn',
      tool_use_id: 'late-probe-tool',
      tool_name: 'collaborationspawn_agent',
      tool_input: action.dispatch.spawn_args,
    });
    const launched = await readJson(paths.bindingProbe, null);
    await writeFile(
      paths.bindingProbe,
      `${JSON.stringify(shiftProbeTimestamps(launched, -10 * 60_000))}\n`,
    );

    expect(await invokeHook({
      hook_event_name: 'SubagentStart',
      project_dir: dir,
      session_id: 'other-late-child',
      turn_id: 'different-turn',
      agent_id: 'other-late-agent',
      agent_type: 'default',
    })).toEqual({});
    const late = await invokeHook({
      hook_event_name: 'SubagentStart',
      project_dir: dir,
      session_id: 'late-probe-child',
      turn_id: 'late-probe-turn',
      agent_id: 'late-probe-agent',
      agent_type: 'default',
    });
    expect(late.systemMessage).toMatch(/expired before native identity binding/i);
    const lateTool = await invokeHook({
      hook_event_name: 'PreToolUse',
      project_dir: dir,
      session_id: 'late-probe-child',
      agent_id: 'late-probe-agent',
      tool_name: 'mcp__future_provider__mutate',
      tool_input: {},
    }, { canaryOnly: true });
    expect(lateTool.hookSpecificOutput?.permissionDecision ?? lateTool.decision).toBe('deny');
  });

  it('retains a launched turn after replacement so its late child is denied after the replacement expires', async () => {
    const dir = await project();
    const paths = runtimePaths(dir);
    const first = await prepareBindingProbe(paths, {
      host: 'codex',
      model: { model: 'gpt-5.6-terra', reasoning_effort: 'medium' },
    });
    expect(await invokeHook({
      hook_event_name: 'PreToolUse',
      project_dir: dir,
      session_id: 'retired-turn-parent-a',
      turn_id: 'retired-probe-turn-a',
      tool_use_id: 'retired-turn-tool-a',
      tool_name: 'collaborationspawn_agent',
      tool_input: first.dispatch.spawn_args,
    })).toEqual({});
    const launchedFirst = await readJson(paths.bindingProbe, null);
    await writeFile(
      paths.bindingProbe,
      `${JSON.stringify(shiftProbeTimestamps(launchedFirst, -10 * 60_000))}\n`,
    );

    const second = await prepareBindingProbe(paths, {
      host: 'codex',
      model: { model: 'gpt-5.6-terra', reasoning_effort: 'medium' },
    });
    expect(second.probe.probe_id).not.toBe(first.probe.probe_id);
    expect(await retiredTurnEntryCount(paths)).toBe(1);
    const preparedSecond = await readJson(paths.bindingProbe, null);
    await writeFile(
      paths.bindingProbe,
      `${JSON.stringify(shiftProbeTimestamps(preparedSecond, -10 * 60_000))}\n`,
    );

    expect(await invokeHook({
      hook_event_name: 'SubagentStart',
      project_dir: dir,
      session_id: 'unrelated-child-after-second-expiry',
      turn_id: 'unrelated-turn-after-second-expiry',
      agent_id: 'unrelated-agent-after-second-expiry',
      agent_type: 'default',
    })).toEqual({});
    const lateFirst = await invokeHook({
      hook_event_name: 'SubagentStart',
      project_dir: dir,
      session_id: 'late-retired-turn-child-a',
      turn_id: 'retired-probe-turn-a',
      agent_id: 'late-retired-turn-agent-a',
      agent_type: 'default',
    });
    expect(lateFirst.systemMessage).toMatch(/retired probe launch turn/i);
    expect(await quarantineEntryCount(paths)).toBe(1);
    expect(await fallbackQuarantineEntryCount(paths)).toBe(1);

    for (const toolName of ['Read', 'mcp__future_provider__mutate']) {
      const fenced = await invokeHook({
        hook_event_name: 'PreToolUse',
        project_dir: dir,
        session_id: 'late-retired-turn-child-a',
        agent_id: 'late-retired-turn-agent-a',
        agent_type: 'default',
        tool_name: toolName,
        tool_input: { file_path: 'docs/note.md' },
      }, { canaryOnly: toolName.startsWith('mcp__') });
      expect(fenced.hookSpecificOutput?.permissionDecision ?? fenced.decision).toBe('deny');
    }
  });

  it('requires the launch turn and binds only the native child from that exact turn', async () => {
    const dir = await project();
    const paths = runtimePaths(dir);
    const action = await prepareBindingProbe(paths, {
      host: 'codex',
      model: { model: 'gpt-5.6-terra', reasoning_effort: 'medium' },
    });
    const launchInput = {
      hook_event_name: 'PreToolUse',
      project_dir: dir,
      session_id: 'turn-bound-parent',
      tool_use_id: 'turn-bound-tool',
      tool_name: 'collaborationspawn_agent',
      tool_input: action.dispatch.spawn_args,
    };

    const missingTurn = await invokeHook(launchInput);
    expect(missingTurn.hookSpecificOutput?.permissionDecision ?? missingTurn.decision).toBe('deny');
    expect(await bindingProbeStatus(paths)).toMatchObject({ status: 'prepared' });

    const inheritedHistory = await invokeHook({
      ...launchInput,
      turn_id: 'authorized-probe-turn',
      tool_input: { ...action.dispatch.spawn_args, fork_turns: '1' },
    });
    expect(inheritedHistory.hookSpecificOutput?.permissionDecision ?? inheritedHistory.decision)
      .toBe('deny');
    expect(
      inheritedHistory.hookSpecificOutput?.permissionDecisionReason ?? inheritedHistory.systemMessage,
    ).toMatch(/fork_turns must be exactly 'none'/i);
    expect(await bindingProbeStatus(paths)).toMatchObject({ status: 'prepared' });

    expect(await invokeHook({ ...launchInput, turn_id: 'authorized-probe-turn' })).toEqual({});
    const wrongTurn = await invokeHook({
      hook_event_name: 'SubagentStart',
      project_dir: dir,
      session_id: 'wrong-turn-child',
      turn_id: 'unrelated-turn',
      agent_id: 'wrong-turn-agent',
      agent_type: 'default',
    });
    expect(wrongTurn.systemMessage).toMatch(/does not match the authorized launch/i);
    expect(await bindingProbeStatus(paths)).toMatchObject({ status: 'launched' });

    const rightTurn = await invokeHook({
      hook_event_name: 'SubagentStart',
      project_dir: dir,
      session_id: 'authorized-turn-child',
      turn_id: 'authorized-probe-turn',
      agent_id: 'authorized-turn-agent',
      agent_type: 'default',
    });
    expect(rightTurn.systemMessage).toBeUndefined();
    expect(await bindingProbeStatus(paths)).toMatchObject({
      status: 'bound',
      binding_observation: { outcome: 'accepted' },
    });
    const capability = rightTurn.hookSpecificOutput?.additionalContext.match(
      /APE_PROBE_CAPABILITY=([A-Za-z0-9_-]{32,256})/,
    )?.[1];
    await acknowledgeBindingProbe(paths, {
      probe_id: action.probe.probe_id,
      probe_capability: capability,
    });
    await expect(consumeBindingProbe(paths, 'codex')).resolves.toMatchObject({ ok: true });

    const rejectedInternal = await invokeHook({
      hook_event_name: 'PreToolUse',
      project_dir: dir,
      session_id: 'wrong-turn-child',
      agent_id: 'wrong-turn-agent',
      agent_type: 'default',
      tool_name: 'Read',
      tool_input: { file_path: 'docs/note.md' },
    });
    expect(rejectedInternal.hookSpecificOutput?.permissionDecision ?? rejectedInternal.decision)
      .toBe('deny');
    const rejectedExternal = await invokeHook({
      hook_event_name: 'PreToolUse',
      project_dir: dir,
      session_id: 'wrong-turn-child',
      agent_id: 'wrong-turn-agent',
      agent_type: 'default',
      tool_name: 'mcp__future_provider__mutate',
      tool_input: {},
    }, { canaryOnly: true });
    expect(rejectedExternal.hookSpecificOutput?.permissionDecision ?? rejectedExternal.decision)
      .toBe('deny');

    const replacement = await prepareBindingProbe(paths, {
      host: 'codex',
      model: { model: 'gpt-5.6-terra', reasoning_effort: 'medium' },
    });
    expect(replacement.probe.probe_id).not.toBe(action.probe.probe_id);
    expect(await invokeHook({
      hook_event_name: 'PreToolUse',
      project_dir: dir,
      session_id: 'wrong-turn-child',
      agent_id: 'wrong-turn-agent',
      agent_type: 'default',
      tool_name: 'mcp__future_provider__mutate',
      tool_input: {},
    }, { canaryOnly: true })).not.toEqual({});
  });

  it('validates and launches the probe from the normalized toolCall args container', async () => {
    const dir = await project();
    const paths = runtimePaths(dir);
    const action = await prepareBindingProbe(paths, {
      host: 'codex',
      model: { model: 'gpt-5.6-terra', reasoning_effort: 'medium' },
    });
    expect(await invokeHook({
      hook_event_name: 'PreToolUse',
      project_dir: dir,
      session_id: 'tool-call-probe-parent',
      turn_id: 'tool-call-probe-turn',
      tool_use_id: 'tool-call-probe-spawn',
      tool_name: 'collaborationspawn_agent',
      toolCall: { args: action.dispatch.spawn_args },
    })).toEqual({});
    const binding = await invokeHook({
      hook_event_name: 'SubagentStart',
      project_dir: dir,
      session_id: 'tool-call-probe-child',
      turn_id: 'tool-call-probe-turn',
      agent_id: 'tool-call-probe-agent',
      agent_type: 'default',
    });
    expect(binding.systemMessage).toBeUndefined();
    expect(await bindingProbeStatus(paths)).toMatchObject({ status: 'bound' });
  });

  it('rejects model metadata that no longer matches the hash-bound probe ticket', async () => {
    const dir = await project();
    const paths = runtimePaths(dir);
    const first = await prepareBindingProbe(paths, {
      host: 'codex',
      model: { model: 'gpt-5.6-terra', reasoning_effort: 'medium' },
    });
    const record = await readJson(paths.bindingProbe, null);
    await writeFile(paths.bindingProbe, `${JSON.stringify({
      ...record,
      model: { model: 'gpt-5.6-sol', reasoning_effort: 'high' },
    })}\n`);

    expect(await bindingProbeStatus(paths)).toMatchObject({
      status: 'prepared',
      infrastructure_status: 'failed',
      reason: expect.stringMatching(/authoritative native binding probe ticket unavailable/i),
    });
    const recovered = await prepareBindingProbe(paths, {
      host: 'codex',
      model: { model: 'gpt-5.6-terra', reasoning_effort: 'medium' },
    });
    expect(recovered.probe.probe_id).not.toBe(first.probe.probe_id);
    expect(recovered.dispatch.model).toEqual({
      model: 'gpt-5.6-terra',
      reasoning_effort: 'medium',
    });
  });

  it('migrates more than eight legacy canaries to durable quarantine on exact stop', async () => {
    const dir = await project();
    const paths = runtimePaths(dir);
    await prepareBindingProbe(paths, {
      host: 'codex',
      model: { model: 'gpt-5.6-terra', reasoning_effort: 'medium' },
    });
    const record = await readJson(paths.bindingProbe, null);
    const retiredIdentities = Array.from({ length: 12 }, (_unused, index) => ({
      session_id: `retired-canary-session-${index}`,
      agent_id: `retired-canary-agent-${index}`,
      retired_at: record.prepared_at,
    }));
    await writeFile(paths.bindingProbe, `${JSON.stringify({
      ...record,
      retired_identities: retiredIdentities,
    })}\n`);

    const exactToolInput = {
      hook_event_name: 'PreToolUse',
      project_dir: dir,
      session_id: 'retired-canary-session-0',
      agent_id: 'retired-canary-agent-0',
      agent_type: 'default',
      tool_name: 'Read',
      tool_input: { file_path: 'docs/note.md' },
    };
    const denied = await invokeHook(exactToolInput, { canaryOnly: true });
    expect(denied.hookSpecificOutput?.permissionDecision ?? denied.decision).toBe('deny');
    expect(await bindingProbeStatus(paths)).toMatchObject({ status: 'prepared' });

    expect(await invokeHook({
      hook_event_name: 'SubagentStop',
      project_dir: dir,
      session_id: 'retired-canary-session-0',
      agent_id: 'retired-canary-agent-0',
      agent_type: 'default',
    })).toEqual({});
    const afterStop = await invokeHook(exactToolInput, { canaryOnly: true });
    expect(afterStop.hookSpecificOutput?.permissionDecision ?? afterStop.decision).toBe('deny');
    expect((await readJson(paths.bindingProbe, null)).retired_identities).toHaveLength(11);
  });

  it('retains more than the legacy 256-identity ceiling in the sharded quarantine ledger', async () => {
    const dir = await project();
    const paths = runtimePaths(dir);
    await prepareBindingProbe(paths, {
      host: 'codex',
      model: { model: 'gpt-5.6-terra', reasoning_effort: 'medium' },
    });
    const record = await readJson(paths.bindingProbe, null);
    const retiredIdentities = Array.from({ length: 256 }, (_unused, index) => ({
      session_id: `ceiling-session-${index}`,
      agent_id: `ceiling-agent-${index}`,
      retired_at: record.prepared_at,
    }));
    await writeFile(paths.bindingProbe, `${JSON.stringify(shiftProbeTimestamps({
      ...record,
      retired_identities: retiredIdentities,
    }, -10 * 60_000))}\n`);

    const replacement = await prepareBindingProbe(paths, {
      host: 'codex',
      model: { model: 'gpt-5.6-terra', reasoning_effort: 'medium' },
    });
    expect((await readJson(paths.bindingProbe, null)).retired_identities).toEqual([]);
    expect(await quarantineEntryCount(paths)).toBe(256);

    await launchAndBindProbe(dir, replacement, {
      child: 'ceiling-session-256',
      agent: 'ceiling-agent-256',
      turn: 'ceiling-turn-256',
    });
    expect(await quarantineEntryCount(paths)).toBe(257);
    const earliest = await invokeHook({
      hook_event_name: 'PreToolUse',
      project_dir: dir,
      session_id: 'ceiling-session-0',
      agent_id: 'ceiling-agent-0',
      agent_type: 'default',
      tool_name: 'mcp__future_provider__mutate',
      tool_input: {},
    }, { canaryOnly: true });
    expect(earliest.hookSpecificOutput?.permissionDecision ?? earliest.decision).toBe('deny');
  });

  it('keeps the current canary fenced after stop and retains it across replacement', async () => {
    const dir = await project();
    const paths = runtimePaths(dir);
    const action = await prepareBindingProbe(paths, {
      host: 'codex',
      model: { model: 'gpt-5.6-terra', reasoning_effort: 'medium' },
    });
    const binding = await launchAndBindProbe(dir, action, {
      child: 'stopped-canary-child',
      agent: 'stopped-canary-agent',
      turn: 'stopped-canary-turn',
    });
    const capability = binding.hookSpecificOutput.additionalContext.match(
      /APE_PROBE_CAPABILITY=([A-Za-z0-9_-]{32,256})/,
    )?.[1];
    const toolInput = {
      hook_event_name: 'PreToolUse',
      project_dir: dir,
      session_id: 'stopped-canary-child',
      agent_id: 'stopped-canary-agent',
      agent_type: 'default',
      tool_name: 'mcp__future_provider__mutate',
      tool_input: {},
    };
    const beforeStop = await invokeHook(toolInput, { canaryOnly: true });
    expect(beforeStop.hookSpecificOutput?.permissionDecision ?? beforeStop.decision).toBe('deny');

    expect(await invokeHook({
      hook_event_name: 'SubagentStop',
      project_dir: dir,
      session_id: 'stopped-canary-child',
      turn_id: 'stopped-canary-turn',
      agent_id: 'stopped-canary-agent',
      agent_type: 'default',
    })).toEqual({});
    const afterStop = await invokeHook(toolInput, { canaryOnly: true });
    expect(afterStop.hookSpecificOutput?.permissionDecision ?? afterStop.decision).toBe('deny');
    expect(await bindingProbeStatus(paths)).toMatchObject({
      status: 'bound',
      infrastructure_status: 'awaiting_acknowledgement',
    });
    await expect(acknowledgeBindingProbe(paths, {
      probe_id: action.probe.probe_id,
      probe_capability: capability,
    })).resolves.toMatchObject({ status: 'completed' });
    await expect(consumeBindingProbe(paths, 'codex')).resolves.toMatchObject({ ok: true });

    const replacement = await prepareBindingProbe(paths, {
      host: 'codex',
      model: { model: 'gpt-5.6-terra', reasoning_effort: 'medium' },
    });
    expect(replacement.probe.probe_id).not.toBe(action.probe.probe_id);
    expect((await readJson(paths.bindingProbe, null)).retired_identities).toEqual([]);
    const resumed = await invokeHook({
      hook_event_name: 'SubagentStart',
      project_dir: dir,
      session_id: 'stopped-canary-child',
      turn_id: 'stopped-canary-resume-turn',
      agent_id: 'stopped-canary-agent',
      agent_type: 'default',
    });
    expect(resumed.systemMessage).toMatch(/canary identity is retired/i);
  });

  it('does not advertise an unusable pre-run probe while a blocked run still owns the project', async () => {
    const dir = await project();
    const paths = runtimePaths(dir);
    await mkdir(paths.runtime, { recursive: true });
    await writeFile(paths.active, `${JSON.stringify({
      run_id: 'run-blocked-probe-owner',
      status: 'blocked',
    })}\n`);

    const response = await prepareNativeBindingProbe(dir, {
      host: 'codex',
      hooks_trusted: true,
      subagents_available: true,
      explicit_invocation: true,
    });
    expect(response).toMatchObject({
      ok: false,
      blocked: true,
      infrastructure_failure: true,
      attempts_consumed: 0,
    });
    expect(response.reason).toMatch(/already blocked/i);
    expect(await readJson(paths.bindingProbe, null)).toBeNull();
  });

  it('uses explicit pre-run probe preparation to quarantine stale malformed dispatch evidence', async () => {
    const dir = await project();
    const paths = runtimePaths(dir);
    const staleBytes = '{stale-torn-intent\n';
    await mkdir(paths.dispatchIntents, { recursive: true });
    await writeFile(path.join(paths.dispatchIntents, 'stale.json'), staleBytes);

    const prepared = await prepareNativeBindingProbe(dir, {
      host: 'codex',
      hooks_trusted: true,
      subagents_available: true,
      explicit_invocation: true,
    });
    expect(prepared).toMatchObject({
      ok: true,
      probe: { status: 'prepared' },
    });
    const names = await readdir(paths.dispatchIntents);
    expect(names.filter((name) => name.endsWith('.json'))).toHaveLength(1);
    const quarantined = names.filter((name) => name.startsWith('stale.json.corrupt-'));
    expect(quarantined).toHaveLength(1);
    expect(await readFile(path.join(paths.dispatchIntents, quarantined[0]), 'utf8'))
      .toBe(staleBytes);
  });

  it('rejects a forged visible task-name capability without advancing the probe', async () => {
    const dir = await project();
    const paths = runtimePaths(dir);
    const action = await prepareBindingProbe(paths, {
      host: 'codex',
      model: { model: 'gpt-5.6-terra', reasoning_effort: 'medium' },
    });
    const launch = await invokeHook({
      hook_event_name: 'PreToolUse',
      project_dir: dir,
      session_id: 'parent-session',
      turn_id: 'turn-1',
      tool_use_id: 'spawn-probe-forged',
      tool_name: 'collaborationspawn_agent',
      tool_input: {
        task_name: 'ape_probe_00000000000000000000000000000000',
        fork_turns: 'none',
        agent_type: action.dispatch.agent_type,
        message: 'gAAAAABencrypted-v2-message',
        model: action.dispatch.model.model,
        reasoning_effort: action.dispatch.model.reasoning_effort,
      },
    });
    expect(launch.hookSpecificOutput?.permissionDecision ?? launch.decision).toBe('deny');
    expect(await bindingProbeStatus(paths)).toMatchObject({
      status: 'prepared',
      launch_observations: 0,
    });
  });

  it('rejects an explicit type mismatch even when the probe task-name capability is valid', async () => {
    const dir = await project();
    const paths = runtimePaths(dir);
    const action = await prepareBindingProbe(paths, {
      host: 'codex',
      model: { model: 'gpt-5.6-terra', reasoning_effort: 'medium' },
    });
    const launch = await invokeHook({
      hook_event_name: 'PreToolUse',
      project_dir: dir,
      session_id: 'parent-session',
      turn_id: 'turn-1',
      tool_use_id: 'spawn-probe-wrong-type',
      tool_name: 'collaborationspawn_agent',
      tool_input: {
        task_name: action.dispatch.agent_name,
        fork_turns: 'none',
        agent_type: 'worker',
        message: 'gAAAAABencrypted-v2-message',
        model: action.dispatch.model.model,
        reasoning_effort: action.dispatch.model.reasoning_effort,
      },
    });
    expect(launch.hookSpecificOutput?.permissionDecision ?? launch.decision).toBe('deny');
    expect(await bindingProbeStatus(paths)).toMatchObject({ status: 'prepared', launch_observations: 0 });
  });

  it('does not replace a nonexpired launched probe or lose its later identity fence', async () => {
    const dir = await project();
    const paths = runtimePaths(dir);
    const action = await prepareBindingProbe(paths, {
      host: 'codex',
      model: { model: 'gpt-5.6-terra', reasoning_effort: 'medium' },
    });
    const launch = await invokeHook({
      hook_event_name: 'PreToolUse',
      project_dir: dir,
      session_id: 'first-probe-parent',
      turn_id: 'first-probe-turn',
      tool_use_id: 'first-probe-tool',
      tool_name: 'collaborationspawn_agent',
      tool_input: {
        task_name: action.dispatch.agent_name,
        fork_turns: 'none',
        message: 'gAAAAABencrypted-v2-message',
        model: action.dispatch.model.model,
        reasoning_effort: action.dispatch.model.reasoning_effort,
      },
    });
    expect(launch).toEqual({});
    const launched = await readJson(paths.bindingProbe, null);

    await expect(prepareBindingProbe(paths, {
      host: 'codex',
      model: { model: 'gpt-5.6-terra', reasoning_effort: 'medium' },
    })).rejects.toThrow(/already launched/i);
    expect(await readJson(paths.bindingProbe, null)).toEqual(launched);

    const binding = await invokeHook({
      hook_event_name: 'SubagentStart',
      project_dir: dir,
      session_id: 'first-probe-child',
      turn_id: 'first-probe-turn',
      agent_id: 'first-probe-agent',
      agent_type: 'default',
    });
    expect(binding.systemMessage).toBeUndefined();
    expect(binding.hookSpecificOutput?.additionalContext).toContain(
      'APE native binding infrastructure probe (authoritative)',
    );
  });

  it('keeps a bound probe structurally valid across repeated native resume events', async () => {
    const dir = await project();
    const paths = runtimePaths(dir);
    const action = await prepareBindingProbe(paths, {
      host: 'codex',
      model: { model: 'gpt-5.6-terra', reasoning_effort: 'medium' },
    });
    await invokeHook({
      hook_event_name: 'PreToolUse',
      project_dir: dir,
      session_id: 'resume-probe-parent',
      turn_id: 'resume-probe-turn',
      tool_use_id: 'resume-probe-tool',
      tool_name: 'collaborationspawn_agent',
      tool_input: {
        task_name: action.dispatch.agent_name,
        fork_turns: 'none',
        message: 'gAAAAABencrypted-v2-message',
        model: action.dispatch.model.model,
        reasoning_effort: action.dispatch.model.reasoning_effort,
      },
    });
    let lastContext = '';
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const binding = await invokeHook({
        hook_event_name: 'SubagentStart',
        project_dir: dir,
        session_id: 'resume-probe-child',
        turn_id: attempt === 0 ? 'resume-probe-turn' : `resume-probe-turn-${attempt}`,
        agent_id: 'resume-probe-agent',
        agent_type: 'default',
      });
      expect(binding.systemMessage).toBeUndefined();
      lastContext = binding.hookSpecificOutput?.additionalContext ?? '';
    }
    expect(await bindingProbeStatus(paths)).toMatchObject({
      status: 'bound',
      transitions: [
        { status: 'prepared' },
        { status: 'launched' },
        { status: 'bound' },
      ],
    });
    const stray = await invokeHook({
      hook_event_name: 'SubagentStart',
      project_dir: dir,
      session_id: 'stray-resume-child',
      turn_id: 'stray-resume-turn',
      agent_id: 'stray-resume-agent',
      agent_type: 'default',
    });
    expect(stray.systemMessage).toMatch(/no unique active launched intent/i);
    expect(await bindingProbeStatus(paths)).toMatchObject({
      status: 'bound',
      binding_observation: { outcome: 'accepted' },
    });
    const capability = lastContext.match(
      /APE_PROBE_CAPABILITY=([A-Za-z0-9_-]{32,256})/,
    )?.[1];
    await expect(acknowledgeBindingProbe(paths, {
      probe_id: action.probe.probe_id,
      probe_capability: capability,
    })).resolves.toMatchObject({ status: 'completed' });
  });

  it('reconstructs probe status without unbounded model or transition extras', async () => {
    const dir = await project();
    const paths = runtimePaths(dir);
    await prepareBindingProbe(paths, {
      host: 'codex',
      model: { model: 'gpt-5.6-terra', reasoning_effort: 'medium' },
    });
    const record = await readJson(paths.bindingProbe, null);
    await writeFile(paths.bindingProbe, `${JSON.stringify({
      ...record,
      model: {
        ...record.model,
        native_agent_id: 'private-model-identity',
        oversized: 'x'.repeat(20_000),
      },
      bound_at: 'x'.repeat(20_000),
      completed_at: 'x'.repeat(20_000),
      consumed_at: 'x'.repeat(20_000),
      transitions: record.transitions.map((transition) => ({
        ...transition,
        native_session_id: 'private-transition-identity',
        oversized: 'x'.repeat(20_000),
      })),
    })}\n`);

    const status = await bindingProbeStatus(paths);
    expect(status.model).toEqual({
      model: 'gpt-5.6-terra',
      reasoning_effort: 'medium',
    });
    expect(status.transitions).toEqual([
      { status: 'prepared', at: record.prepared_at },
    ]);
    expect(status).toMatchObject({
      launched_at: null,
      bound_at: null,
      completed_at: null,
      consumed_at: null,
    });
    expect(JSON.stringify(status)).not.toContain('private-');
    expect(Buffer.byteLength(JSON.stringify(status), 'utf8')).toBeLessThan(4_096);
  });

  it('denies a probe launch when its authoritative ticket is corrupt instead of failing open', async () => {
    const dir = await project();
    const paths = runtimePaths(dir);
    const action = await prepareBindingProbe(paths, {
      host: 'codex',
      model: { model: 'gpt-5.6-terra', reasoning_effort: 'medium' },
    });
    const record = await readJson(paths.bindingProbe, null);
    await writeFile(probeTicketFile(paths, record), '{not-json\n');

    const launch = await invokeHook({
      hook_event_name: 'PreToolUse',
      project_dir: dir,
      session_id: 'parent-session',
      turn_id: 'turn-corrupt-ticket',
      tool_use_id: 'spawn-corrupt-ticket',
      tool_name: 'collaborationspawn_agent',
      tool_input: {
        task_name: action.dispatch.agent_name,
        fork_turns: 'none',
        message: 'gAAAAABencrypted-v2-message',
        model: action.dispatch.model.model,
        reasoning_effort: action.dispatch.model.reasoning_effort,
      },
    });

    expect(launch.hookSpecificOutput?.permissionDecision ?? launch.decision).toBe('deny');
    expect(
      launch.hookSpecificOutput?.permissionDecisionReason ?? launch.reason ?? launch.systemMessage,
    ).toMatch(/authoritative probe ticket unavailable/i);
    expect(await bindingProbeStatus(paths)).toMatchObject({
      status: 'prepared',
      infrastructure_status: 'failed',
      launch_observations: 0,
    });
  });

  it('denies every probe-owned hook path when the persisted probe record is corrupt', async () => {
    const dir = await project();
    const paths = runtimePaths(dir);
    const action = await prepareBindingProbe(paths, {
      host: 'codex',
      model: { model: 'gpt-5.6-terra', reasoning_effort: 'medium' },
    });
    await writeFile(paths.bindingProbe, '{not-json\n');

    const launch = await invokeHook({
      hook_event_name: 'PreToolUse',
      project_dir: dir,
      session_id: 'parent-session',
      turn_id: 'turn-corrupt-probe-record',
      tool_use_id: 'spawn-corrupt-probe-record',
      tool_name: 'collaborationspawn_agent',
      tool_input: {
        task_name: action.dispatch.agent_name,
        fork_turns: 'none',
        message: 'gAAAAABencrypted-v2-message',
        model: action.dispatch.model.model,
        reasoning_effort: action.dispatch.model.reasoning_effort,
      },
    });
    expect(launch.hookSpecificOutput?.permissionDecision ?? launch.decision).toBe('deny');
    expect(
      launch.hookSpecificOutput?.permissionDecisionReason ?? launch.reason ?? launch.systemMessage,
    ).toMatch(/probe state validation failed/i);

    const binding = await invokeHook({
      hook_event_name: 'SubagentStart',
      project_dir: dir,
      session_id: 'probe-child-corrupt-record',
      turn_id: 'turn-corrupt-probe-record',
      agent_id: 'probe-agent-corrupt-record',
      agent_type: 'default',
    });
    expect(binding.systemMessage).toMatch(/probe state validation failed/i);

    const toolCall = await invokeHook({
      hook_event_name: 'PreToolUse',
      project_dir: dir,
      session_id: 'probe-child-corrupt-record',
      turn_id: 'turn-corrupt-probe-record',
      agent_id: 'probe-agent-corrupt-record',
      agent_type: 'default',
      tool_name: 'Read',
      tool_input: { file_path: 'docs/note.md' },
    });
    expect(toolCall.hookSpecificOutput?.permissionDecision ?? toolCall.decision).toBe('deny');
    expect(
      toolCall.hookSpecificOutput?.permissionDecisionReason ??
        toolCall.reason ??
        toolCall.systemMessage,
    ).toMatch(/binding canary may not call tools/i);
    const external = await invokeHook({
      hook_event_name: 'PreToolUse',
      project_dir: dir,
      session_id: 'probe-child-corrupt-record',
      agent_id: 'probe-agent-corrupt-record',
      agent_type: 'default',
      tool_name: 'mcp__future_provider__mutate',
      tool_input: {},
    }, { canaryOnly: true });
    expect(external.hookSpecificOutput?.permissionDecision ?? external.decision).toBe('deny');
  });

  it('tombstones an arriving launched canary even when its v2 projection tore first', async () => {
    const dir = await project();
    const paths = runtimePaths(dir);
    const action = await prepareBindingProbe(paths, {
      host: 'codex',
      model: { model: 'gpt-5.6-terra', reasoning_effort: 'medium' },
    });
    expect(await invokeHook({
      hook_event_name: 'PreToolUse',
      project_dir: dir,
      session_id: 'torn-launched-parent',
      turn_id: 'torn-launched-turn',
      tool_use_id: 'torn-launched-tool',
      tool_name: 'collaborationspawn_agent',
      tool_input: action.dispatch.spawn_args,
    })).toEqual({});
    await writeFile(paths.bindingProbe, 'null\n');

    const binding = await invokeHook({
      hook_event_name: 'SubagentStart',
      project_dir: dir,
      session_id: 'torn-launched-child',
      turn_id: 'torn-launched-turn',
      agent_id: 'torn-launched-agent',
      agent_type: 'default',
    });
    expect(binding.systemMessage).toMatch(/probe state validation failed/i);
    expect(await quarantineEntryCount(paths)).toBe(1);
    for (const toolName of ['Read', 'mcp__future_provider__mutate']) {
      const denied = await invokeHook({
        hook_event_name: 'PreToolUse',
        project_dir: dir,
        session_id: 'torn-launched-child',
        agent_id: 'torn-launched-agent',
        agent_type: 'default',
        tool_name: toolName,
        tool_input: { file_path: 'docs/note.md' },
      }, { canaryOnly: true });
      expect(denied.hookSpecificOutput?.permissionDecision ?? denied.decision).toBe('deny');
    }
  });

  it('uses an independent quarantine ledger when the primary directory is a preserved wrong-type artifact', async () => {
    const dir = await project();
    const paths = runtimePaths(dir);
    const action = await prepareBindingProbe(paths, {
      host: 'codex',
      model: { model: 'gpt-5.6-terra', reasoning_effort: 'medium' },
    });
    expect(await invokeHook({
      hook_event_name: 'PreToolUse',
      project_dir: dir,
      session_id: 'primary-quarantine-failure-parent',
      turn_id: 'primary-quarantine-failure-turn',
      tool_use_id: 'primary-quarantine-failure-tool',
      tool_name: 'collaborationspawn_agent',
      tool_input: action.dispatch.spawn_args,
    })).toEqual({});

    const preservedArtifact = 'preserve-primary-quarantine-artifact\n';
    await writeFile(paths.bindingProbeQuarantine, preservedArtifact);
    const rejectedPairs = [
      ['primary-failure-child-a', 'primary-failure-agent-a'],
      ['primary-failure-child-b', 'primary-failure-agent-b'],
    ];
    for (const [sessionId, agentId] of rejectedPairs) {
      const rejected = await invokeHook({
        hook_event_name: 'SubagentStart',
        project_dir: dir,
        session_id: sessionId,
        turn_id: `wrong-${sessionId}`,
        agent_id: agentId,
        agent_type: 'default',
      });
      expect(rejected.systemMessage).toMatch(/does not match the authorized launch/i);
    }
    expect(await readFile(paths.bindingProbeQuarantine, 'utf8')).toBe(preservedArtifact);
    expect(await fallbackQuarantineEntryCount(paths)).toBe(rejectedPairs.length);

    // Remove the mutable projection as authority without touching either
    // append-only quarantine location. The fallback alone must still fence
    // both internal and wildcard/external calls for every observed pair.
    await writeFile(paths.bindingProbe, 'null\n');
    for (const [sessionId, agentId] of rejectedPairs) {
      for (const toolName of ['Read', 'mcp__future_provider__mutate']) {
        const denied = await invokeHook({
          hook_event_name: 'PreToolUse',
          project_dir: dir,
          session_id: sessionId,
          agent_id: agentId,
          agent_type: 'default',
          tool_name: toolName,
          tool_input: { file_path: 'docs/note.md' },
        }, { canaryOnly: toolName.startsWith('mcp__') });
        expect(denied.hookSpecificOutput?.permissionDecision ?? denied.decision).toBe('deny');
      }
    }
    expect(await invokeHook({
      hook_event_name: 'PreToolUse',
      project_dir: dir,
      session_id: 'unrelated-primary-failure-child',
      agent_id: 'unrelated-primary-failure-agent',
      agent_type: 'default',
      tool_name: 'mcp__future_provider__mutate',
      tool_input: {},
    }, { canaryOnly: true })).toEqual({});
    expect(await readFile(paths.bindingProbeQuarantine, 'utf8')).toBe(preservedArtifact);
  });

  it.skipIf(process.platform === 'win32')('does not trust or write binding evidence through symlinked governed ancestors', async () => {
    for (const linkedAncestor of ['ape', 'runtime']) {
      const dir = await project({
        ape: linkedAncestor !== 'ape',
        runtime: false,
      });
      const outside = await mkdtemp(path.join(tmpdir(), `ape-binding-${linkedAncestor}-link-`));
      cleanups.push(outside);
      const redirectedRuntime = linkedAncestor === 'ape'
        ? path.join(outside, 'runtime')
        : outside;
      await mkdir(redirectedRuntime, { recursive: true });
      const sessionId = `symlink-${linkedAncestor}-canary-session`;
      const agentId = `symlink-${linkedAncestor}-canary-agent`;
      const outsideRecord = legacyV1ProbeRecord({
        status: 'bound',
        sessionId,
        agentId,
      });
      const outsideProbe = path.join(redirectedRuntime, 'binding-probe.json');
      const outsideBytes = `${JSON.stringify(outsideRecord)}\n`;
      await writeFile(outsideProbe, outsideBytes);
      await symlink(
        linkedAncestor === 'ape' ? outside : redirectedRuntime,
        linkedAncestor === 'ape'
          ? path.join(dir, '.ape')
          : path.join(dir, '.ape', 'runtime'),
        'dir',
      );

      expect(await invokeHook({
        hook_event_name: 'PreToolUse',
        project_dir: dir,
        session_id: sessionId,
        agent_id: agentId,
        agent_type: 'default',
        tool_name: 'mcp__future_provider__mutate',
        tool_input: {},
      }, { canaryOnly: true })).toEqual({});
      expect(await readFile(outsideProbe, 'utf8')).toBe(outsideBytes);
      expect((await readdir(redirectedRuntime)).sort()).toEqual(['binding-probe.json']);
    }
  });

  it.skipIf(process.platform === 'win32')('fences a child promptly when the mutable probe projection is a FIFO', async () => {
    const dir = await project();
    const paths = runtimePaths(dir);
    execFileSync('mkfifo', [paths.bindingProbe]);
    const identity = { session_id: 'fifo-probe-child', agent_id: 'fifo-probe-agent' };
    const response = await invokeHook({
      hook_event_name: 'SubagentStart', project_dir: dir, ...identity,
      turn_id: 'fifo-probe-turn', agent_type: 'default',
    });
    expect(response.systemMessage).toMatch(/probe state validation failed/i);
    expect(await invokeHook({
      hook_event_name: 'PreToolUse', project_dir: dir, ...identity,
      tool_name: 'mcp__future_provider__mutate', tool_input: {},
    }, { canaryOnly: true })).toMatchObject({
      hookSpecificOutput: { permissionDecision: 'deny' },
    });
    await expect(prepareBindingProbe(paths, {
      host: 'codex', model: { model: 'gpt-5.6-terra', reasoning_effort: 'medium' },
    })).rejects.toThrow(/bounded ordinary file/);
  });

  it.skipIf(process.platform === 'win32')('treats exact FIFO identity and retired-turn slots as deny evidence without opening them', async () => {
    const dir = await project();
    const paths = runtimePaths(dir);
    const sessionId = 'fifo-ledger-child';
    const agentId = 'fifo-ledger-agent';
    const identityHash = createHash('sha256').update(JSON.stringify([sessionId, agentId])).digest('hex');
    const identityShard = path.join(paths.bindingProbeQuarantineFallback, identityHash.slice(0, 2));
    await mkdir(identityShard, { recursive: true });
    execFileSync('mkfifo', [path.join(identityShard, `${identityHash}.json`)]);
    expect(await invokeHook({
      hook_event_name: 'PreToolUse', project_dir: dir,
      session_id: sessionId, agent_id: agentId,
      tool_name: 'mcp__future_provider__mutate', tool_input: {},
    }, { canaryOnly: true })).toMatchObject({
      hookSpecificOutput: { permissionDecision: 'deny' },
    });

    const turnId = 'fifo-retired-probe-turn';
    const turnHash = createHash('sha256').update(turnId).digest('hex');
    const turnShard = path.join(paths.bindingProbeRetiredTurns, turnHash.slice(0, 2));
    await mkdir(turnShard, { recursive: true });
    execFileSync('mkfifo', [path.join(turnShard, `${turnHash}.json`)]);
    const start = await invokeHook({
      hook_event_name: 'SubagentStart', project_dir: dir,
      session_id: 'late-fifo-turn-child', agent_id: 'late-fifo-turn-agent',
      turn_id: turnId, agent_type: 'default',
    });
    expect(start.systemMessage).toMatch(/retired probe launch turn/i);
  });

  it.skipIf(process.platform === 'win32').each(['root', 'shard'])(
    'does not publish identity evidence through a symlinked quarantine %s',
    async (kind) => {
      const dir = await project();
      const paths = runtimePaths(dir);
      await prepareBindingProbe(paths, {
        host: 'codex', model: { model: 'gpt-5.6-terra', reasoning_effort: 'medium' },
      });
      const outside = await mkdtemp(path.join(tmpdir(), 'ape-probe-ledger-link-'));
      cleanups.push(outside);
      const sessionId = `symlink-${kind}-child`;
      const agentId = `symlink-${kind}-agent`;
      const hash = createHash('sha256').update(JSON.stringify([sessionId, agentId])).digest('hex');
      if (kind === 'shard') await mkdir(paths.bindingProbeQuarantine);
      await symlink(outside, kind === 'root'
        ? paths.bindingProbeQuarantine
        : path.join(paths.bindingProbeQuarantine, hash.slice(0, 2)), 'dir');
      await invokeHook({
        hook_event_name: 'SubagentStart', project_dir: dir,
        session_id: sessionId, agent_id: agentId,
        turn_id: 'unlaunched-probe-turn', agent_type: 'default',
      });
      expect(await fallbackQuarantineEntryCount(paths)).toBe(1);
      expect(await readdir(outside)).toEqual([]);
    },
  );

  it('keeps an exact bound canary fenced from wildcard tools after its probe record tears', async () => {
    const dir = await project();
    const paths = runtimePaths(dir);
    const action = await prepareBindingProbe(paths, {
      host: 'codex',
      model: { model: 'gpt-5.6-terra', reasoning_effort: 'medium' },
    });
    await launchAndBindProbe(dir, action, {
      child: 'durably-quarantined-child',
      agent: 'durably-quarantined-agent',
      turn: 'durably-quarantined-turn',
    });
    const [quarantineShard] = await readdir(paths.bindingProbeQuarantine);
    const quarantineDirectory = path.join(paths.bindingProbeQuarantine, quarantineShard);
    const [quarantineName] = await readdir(quarantineDirectory);
    const quarantineFile = path.join(quarantineDirectory, quarantineName);
    for (const falseyJson of ['null\n', 'false\n', '0\n', '""\n']) {
      await writeFile(quarantineFile, falseyJson);
      const denied = await invokeHook({
        hook_event_name: 'PreToolUse',
        project_dir: dir,
        session_id: 'durably-quarantined-child',
        agent_id: 'durably-quarantined-agent',
        agent_type: 'default',
        tool_name: 'mcp__future_provider__mutate',
        tool_input: {},
      }, { canaryOnly: true });
      expect(denied.hookSpecificOutput?.permissionDecision ?? denied.decision).toBe('deny');
    }
    await writeFile(quarantineFile, '{not-json\n');

    for (const toolName of ['Read', 'mcp__future_provider__mutate']) {
      const denied = await invokeHook({
        hook_event_name: 'PreToolUse',
        project_dir: dir,
        session_id: 'durably-quarantined-child',
        agent_id: 'durably-quarantined-agent',
        agent_type: 'default',
        tool_name: toolName,
        tool_input: { file_path: 'docs/note.md' },
      }, { canaryOnly: true });
      expect(denied.hookSpecificOutput?.permissionDecision ?? denied.decision).toBe('deny');
    }

    const { binding_probe: _probeRequirement, ...runInput } = startInput();
    const started = await startRun(dir, runInput);
    const productionAction = started.actions.find((entry) => entry.type === 'dispatch_agent');
    expect(await invokeHook({
      hook_event_name: 'PreToolUse',
      project_dir: dir,
      session_id: 'quarantine-corrupt-production-parent',
      turn_id: 'quarantine-corrupt-production-turn',
      tool_use_id: 'quarantine-corrupt-production-tool',
      tool_name: 'collaborationspawn_agent',
      tool_input: {
        ...productionAction.dispatch.spawn_args,
        message: 'gAAAAABencrypted-v2-message',
      },
    })).toEqual({});
    const stolen = await invokeHook({
      hook_event_name: 'SubagentStart',
      project_dir: dir,
      session_id: 'durably-quarantined-child',
      turn_id: 'quarantine-corrupt-production-turn',
      agent_id: 'durably-quarantined-agent',
      agent_type: 'default',
      ticket_id: productionAction.ticket.ticket_id,
    });
    expect(stolen.systemMessage).toMatch(/may not bind a production ticket/i);
    const realBinding = await bootstrapObservedChild(dir, productionAction, {
      parent: 'quarantine-corrupt-production-parent',
      turn: 'quarantine-corrupt-production-child-turn',
      agent: 'quarantine-corrupt-production-agent',
    });
    expect(realBinding.systemMessage).toBeUndefined();

    await writeFile(paths.bindingProbe, '{not-json\n');
    const deniedAfterBothTear = await invokeHook({
      hook_event_name: 'PreToolUse',
      project_dir: dir,
      session_id: 'durably-quarantined-child',
      agent_id: 'durably-quarantined-agent',
      agent_type: 'default',
      tool_name: 'mcp__future_provider__mutate',
      tool_input: {},
    }, { canaryOnly: true });
    expect(deniedAfterBothTear.hookSpecificOutput?.permissionDecision ?? deniedAfterBothTear.decision)
      .toBe('deny');

    const redirectedDir = await project();
    const redirected = await invokeHook({
      hook_event_name: 'PreToolUse',
      session_id: 'durably-quarantined-child',
      agent_id: 'durably-quarantined-agent',
      agent_type: 'default',
      tool_name: 'mcp__future_provider__mutate',
      tool_input: { project_dir: redirectedDir },
    }, { canaryOnly: true, codexCwd: dir });
    expect(redirected.hookSpecificOutput?.permissionDecision ?? redirected.decision).toBe('deny');
    expect(await invokeHook({
      hook_event_name: 'PreToolUse',
      project_dir: dir,
      session_id: 'unrelated-child-after-probe-tear',
      agent_id: 'unrelated-agent-after-probe-tear',
      agent_type: 'default',
      tool_name: 'mcp__future_provider__mutate',
      tool_input: {},
    }, { canaryOnly: true })).toEqual({});

    const oversizedExact = await invokeHook({
      hook_event_name: 'PreToolUse',
      project_dir: dir,
      tool_name: 'mcp__future_provider__mutate',
      tool_input: {
        payload: 'x'.repeat((8 * 1024 * 1024) + 1024),
        project_dir: redirectedDir,
      },
      // Identity follows the oversized nested value so the bounded streaming
      // extractor must keep scanning after it stops retaining the body.
      session_id: 'durably-quarantined-child',
      agent_id: 'durably-quarantined-agent',
      agent_type: 'default',
    }, { canaryOnly: true, codexCwd: dir });
    expect(oversizedExact.hookSpecificOutput?.permissionDecision ?? oversizedExact.decision)
      .toBe('deny');
    expect(await invokeHook({
      hook_event_name: 'PreToolUse',
      project_dir: dir,
      tool_name: 'mcp__future_provider__mutate',
      tool_input: { payload: 'x'.repeat((8 * 1024 * 1024) + 1024) },
      session_id: 'unrelated-oversized-child',
      agent_id: 'unrelated-oversized-agent',
      agent_type: 'default',
    }, { canaryOnly: true, codexCwd: dir })).toEqual({});
    const workspaceRootedOversized = await invokeHook({
      hook_event_name: 'PreToolUse',
      tool_name: 'mcp__future_provider__mutate',
      tool_input: { payload: 'x'.repeat((8 * 1024 * 1024) + 1024) },
      session_id: 'durably-quarantined-child',
      agent_id: 'durably-quarantined-agent',
      agent_type: 'default',
      workspacePaths: [dir],
    }, { canaryOnly: true, codexCwd: null });
    expect(
      workspaceRootedOversized.hookSpecificOutput?.permissionDecision ??
        workspaceRootedOversized.decision,
    ).toBe('deny');
  });

  it('fails closed for parseable but structurally invalid probe state', async () => {
    const dir = await project();
    const paths = runtimePaths(dir);
    await mkdir(paths.runtime, { recursive: true });
    await writeFile(paths.bindingProbe, '{}\n');

    const binding = await invokeHook({
      hook_event_name: 'SubagentStart',
      project_dir: dir,
      session_id: 'parseable-corrupt-child',
      turn_id: 'parseable-corrupt-turn',
      agent_id: 'parseable-corrupt-agent',
      agent_type: 'default',
    });
    expect(binding.systemMessage).toMatch(/probe state validation failed/i);

    const toolCall = await invokeHook({
      hook_event_name: 'PreToolUse',
      project_dir: dir,
      session_id: 'parseable-corrupt-child',
      turn_id: 'parseable-corrupt-turn',
      agent_id: 'parseable-corrupt-agent',
      agent_type: 'default',
      tool_name: 'Read',
      tool_input: { file_path: 'docs/note.md' },
    });
    expect(toolCall.hookSpecificOutput?.permissionDecision ?? toolCall.decision).toBe('deny');
    expect(
      toolCall.hookSpecificOutput?.permissionDecisionReason ??
        toolCall.reason ??
        toolCall.systemMessage,
    ).toMatch(/binding canary may not call tools/i);
  });

  it('reserves pre-run child lifecycle and tool paths while a prepared probe is live', async () => {
    const dir = await project();
    const paths = runtimePaths(dir);
    await prepareBindingProbe(paths, {
      host: 'codex',
      model: { model: 'gpt-5.6-terra', reasoning_effort: 'medium' },
    });

    const binding = await invokeHook({
      hook_event_name: 'SubagentStart',
      project_dir: dir,
      session_id: 'unrelated-child-during-probe',
      turn_id: 'unrelated-turn-during-probe',
      agent_id: 'unrelated-agent-during-probe',
      agent_type: 'default',
    });
    expect(binding.systemMessage).toMatch(/probe is prepared/i);

    for (const childEvidence of [
      { agent_id: 'unrelated-agent-during-probe', agent_type: 'default' },
      { subagent_id: 'unrelated-subagent-during-probe' },
      { is_subagent: true },
    ]) {
      const toolCall = await invokeHook({
        hook_event_name: 'PreToolUse',
        project_dir: dir,
        session_id: 'unrelated-child-during-probe',
        turn_id: 'unrelated-turn-during-probe',
        ...childEvidence,
        tool_name: 'Read',
        tool_input: { file_path: 'docs/note.md' },
      });
      expect(toolCall.hookSpecificOutput?.permissionDecision ?? toolCall.decision).toBe('deny');
      expect(
        toolCall.hookSpecificOutput?.permissionDecisionReason ??
          toolCall.reason ??
          toolCall.systemMessage,
      ).toMatch(/binding canary may not call tools|probe identity state validation failed/i);
    }
  });

  it('leaves a malformed ordinary child neutral when no probe evidence exists', async () => {
    const dir = await project();
    expect(await invokeHook({
      hook_event_name: 'PreToolUse',
      project_dir: dir,
      session_id: 'ordinary-child-session',
      is_subagent: true,
      agent_type: 'default',
      tool_name: 'Read',
      tool_input: { file_path: 'docs/note.md' },
    })).toEqual({});
  });

  it('ignores a corrupt stale probe record when a live Codex intent is authoritative', async () => {
    const dir = await project();
    const paths = runtimePaths(dir);
    const { binding_probe: _probeRequirement, ...runInput } = startInput();
    const started = await startRun(dir, runInput);
    expect(started.ok).toBe(true);
    const action = started.actions.find((entry) => entry.type === 'dispatch_agent');
    expect(action?.dispatch?.agent_name).toBeTruthy();
    await writeFile(paths.bindingProbe, '{not-json\n');

    const launch = await invokeHook({
      hook_event_name: 'PreToolUse',
      project_dir: dir,
      session_id: 'live-parent-session',
      turn_id: 'live-turn',
      tool_use_id: 'spawn-live-worker',
      tool_name: 'collaborationspawn_agent',
      tool_input: {
        ...action.dispatch.spawn_args,
        message: 'gAAAAABencrypted-v2-message',
      },
    });
    expect(launch).toEqual({});

    const binding = await bootstrapObservedChild(dir, action, {
      parent: 'live-parent-session',
      turn: 'live-child-turn',
      agent: 'live-worker-agent',
    });
    expect(binding.systemMessage).toBeUndefined();
    expect(binding.hookSpecificOutput?.additionalContext).toMatch(
      /APE_RECEIPT_CAPABILITY=[A-Za-z0-9_-]{32,256}/,
    );

    const write = await invokeHook({
      hook_event_name: 'PreToolUse',
      project_dir: dir,
      session_id: 'live-worker-agent',
      turn_id: 'live-child-turn',
      agent_id: 'live-worker-agent',
      agent_type: 'default',
      tool_name: 'Write',
      tool_input: { file_path: 'docs/note.md', content: '# Updated\n' },
    });
    expect(write).toEqual({});
  });

  it('does not let a valid stale launched probe intercept a live Codex worker', async () => {
    const dir = await project();
    const paths = runtimePaths(dir);
    const probe = await prepareBindingProbe(paths, {
      host: 'codex',
      model: { model: 'gpt-5.6-terra', reasoning_effort: 'medium' },
    });
    const probeLaunch = await invokeHook({
      hook_event_name: 'PreToolUse',
      project_dir: dir,
      session_id: 'stale-probe-parent',
      turn_id: 'stale-probe-turn',
      tool_use_id: 'stale-probe-tool',
      tool_name: 'collaborationspawn_agent',
      tool_input: {
        task_name: probe.dispatch.agent_name,
        fork_turns: 'none',
        message: 'gAAAAABencrypted-v2-message',
        model: probe.dispatch.model.model,
        reasoning_effort: probe.dispatch.model.reasoning_effort,
      },
    });
    expect(probeLaunch).toEqual({});
    expect(await bindingProbeStatus(paths)).toMatchObject({ status: 'launched' });

    const { binding_probe: _probeRequirement, ...runInput } = startInput();
    const started = await startRun(dir, runInput);
    expect(started.ok).toBe(true);
    const action = started.actions.find((entry) => entry.type === 'dispatch_agent');
    const launch = await invokeHook({
      hook_event_name: 'PreToolUse',
      project_dir: dir,
      session_id: 'live-parent-after-stale-probe',
      turn_id: 'live-turn-after-stale-probe',
      tool_use_id: 'live-tool-after-stale-probe',
      tool_name: 'collaborationspawn_agent',
      tool_input: {
        ...action.dispatch.spawn_args,
        message: 'gAAAAABencrypted-v2-message',
      },
    });
    expect(launch).toEqual({});

    const binding = await bootstrapObservedChild(dir, action, {
      parent: 'live-parent-after-stale-probe',
      turn: 'live-child-turn-after-stale-probe',
      agent: 'live-agent-after-stale-probe',
    });
    expect(binding.systemMessage).toBeUndefined();
    expect(binding.hookSpecificOutput?.additionalContext).toMatch(
      /APE_RECEIPT_CAPABILITY=[A-Za-z0-9_-]{32,256}/,
    );
  });

  it('continues denying an exact bound canary identity after a production run starts', async () => {
    const dir = await project();
    const paths = runtimePaths(dir);
    const probe = await prepareBindingProbe(paths, {
      host: 'codex',
      model: { model: 'gpt-5.6-terra', reasoning_effort: 'medium' },
    });
    await invokeHook({
      hook_event_name: 'PreToolUse',
      project_dir: dir,
      session_id: 'bound-canary-parent',
      turn_id: 'bound-canary-turn',
      tool_use_id: 'bound-canary-tool',
      tool_name: 'collaborationspawn_agent',
      tool_input: {
        task_name: probe.dispatch.agent_name,
        fork_turns: 'none',
        message: 'gAAAAABencrypted-v2-message',
        model: probe.dispatch.model.model,
        reasoning_effort: probe.dispatch.model.reasoning_effort,
      },
    });
    const bound = await invokeHook({
      hook_event_name: 'SubagentStart',
      project_dir: dir,
      session_id: 'bound-canary-child',
      turn_id: 'bound-canary-turn',
      agent_id: 'bound-canary-agent',
      agent_type: 'default',
    });
    expect(bound.systemMessage).toBeUndefined();
    expect(await bindingProbeStatus(paths)).toMatchObject({ status: 'bound' });
    expect(await invokeHook({
      hook_event_name: 'SubagentStop',
      project_dir: dir,
      session_id: 'bound-canary-child',
      turn_id: 'bound-canary-turn',
      agent_id: 'bound-canary-agent',
      agent_type: 'default',
    })).toEqual({});
    expect(await readJson(paths.bindingProbe, null)).toMatchObject({
      canary_stopped_at: expect.any(String),
    });

    const { binding_probe: _probeRequirement, ...runInput } = startInput();
    const started = await startRun(dir, runInput);
    expect(started.ok).toBe(true);
    const action = started.actions.find((entry) => entry.type === 'dispatch_agent');
    expect(await invokeHook({
      hook_event_name: 'PreToolUse',
      project_dir: dir,
      session_id: 'bound-canary-production-parent',
      turn_id: 'bound-canary-production-turn',
      tool_use_id: 'bound-canary-production-tool',
      tool_name: 'collaborationspawn_agent',
      tool_input: {
        ...action.dispatch.spawn_args,
        message: 'gAAAAABencrypted-v2-message',
      },
    })).toEqual({});
    const stolenBinding = await invokeHook({
      hook_event_name: 'SubagentStart',
      project_dir: dir,
      session_id: 'bound-canary-child',
      turn_id: 'bound-canary-production-turn',
      agent_id: 'bound-canary-agent',
      agent_type: 'default',
      ticket_id: action.ticket.ticket_id,
    });
    expect(stolenBinding.systemMessage).toMatch(/may not bind a production ticket/i);

    const realBinding = await bootstrapObservedChild(dir, action, {
      parent: 'bound-canary-production-parent',
      turn: 'bound-canary-real-worker-child-turn',
      agent: 'bound-canary-real-worker-agent',
    });
    expect(realBinding.systemMessage).toBeUndefined();
    expect(realBinding.hookSpecificOutput?.additionalContext).toMatch(
      /APE_RECEIPT_CAPABILITY=[A-Za-z0-9_-]{32,256}/,
    );

    const toolCall = await invokeHook({
      hook_event_name: 'PreToolUse',
      project_dir: dir,
      session_id: 'bound-canary-child',
      turn_id: 'bound-canary-turn',
      agent_id: 'bound-canary-agent',
      agent_type: 'default',
      tool_name: 'Read',
      tool_input: { file_path: 'docs/note.md' },
    });
    expect(toolCall.hookSpecificOutput?.permissionDecision ?? toolCall.decision).toBe('deny');
    expect(
      toolCall.hookSpecificOutput?.permissionDecisionReason ??
        toolCall.reason ??
        toolCall.systemMessage,
    ).toMatch(/binding canary may not call tools/i);
  });

  it('denies when the production launch validator throws before any run exists', async () => {
    const dir = await project();
    const paths = runtimePaths(dir);
    const action = await prepareBindingProbe(paths, {
      host: 'codex',
      model: { model: 'gpt-5.6-terra', reasoning_effort: 'medium' },
    });
    await writeFile(await onlyProbeIntentFile(paths), '{not-json\n');

    const launch = await invokeHook({
      hook_event_name: 'PreToolUse',
      project_dir: dir,
      session_id: 'parent-session',
      turn_id: 'turn-launch-exception',
      tool_use_id: 'spawn-launch-exception',
      tool_name: 'collaborationspawn_agent',
      tool_input: {
        task_name: action.dispatch.agent_name,
        fork_turns: 'none',
        message: 'gAAAAABencrypted-v2-message',
        model: action.dispatch.model.model,
        reasoning_effort: action.dispatch.model.reasoning_effort,
      },
    });

    expect(launch.hookSpecificOutput?.permissionDecision ?? launch.decision).toBe('deny');
    expect(
      launch.hookSpecificOutput?.permissionDecisionReason ?? launch.reason ?? launch.systemMessage,
    ).toMatch(/production launch validation failed/i);
    expect(await bindingProbeStatus(paths)).toMatchObject({
      status: 'prepared',
      launch_observations: 0,
    });
  });

  it('denies and records a typed observation when the production binder throws', async () => {
    const dir = await project();
    const paths = runtimePaths(dir);
    const action = await prepareBindingProbe(paths, {
      host: 'codex',
      model: { model: 'gpt-5.6-terra', reasoning_effort: 'medium' },
    });
    const launch = await invokeHook({
      hook_event_name: 'PreToolUse',
      project_dir: dir,
      session_id: 'parent-session',
      turn_id: 'turn-bind-exception',
      tool_use_id: 'spawn-bind-exception',
      tool_name: 'collaborationspawn_agent',
      tool_input: {
        task_name: action.dispatch.agent_name,
        fork_turns: 'none',
        message: 'gAAAAABencrypted-v2-message',
        model: action.dispatch.model.model,
        reasoning_effort: action.dispatch.model.reasoning_effort,
      },
    });
    expect(launch).toEqual({});
    await writeFile(await onlyProbeIntentFile(paths), '{not-json\n');

    const binding = await invokeHook({
      hook_event_name: 'SubagentStart',
      project_dir: dir,
      session_id: 'probe-child-bind-exception',
      turn_id: 'turn-bind-exception',
      agent_id: 'probe-agent-bind-exception',
      agent_type: 'default',
    });

    expect(binding.systemMessage).toMatch(/production binding validation failed/i);
    expect(await bindingProbeStatus(paths)).toMatchObject({
      status: 'launched',
      binding_observation: {
        outcome: 'error',
        code: 'production_binding_exception',
      },
    });
  });

  it('preserves an accepted bound observation when a later production binder read throws', async () => {
    const dir = await project();
    const paths = runtimePaths(dir);
    const action = await prepareBindingProbe(paths, {
      host: 'codex',
      model: { model: 'gpt-5.6-terra', reasoning_effort: 'medium' },
    });
    await launchAndBindProbe(dir, action, {
      child: 'bound-before-exception-child',
      agent: 'bound-before-exception-agent',
      turn: 'bound-before-exception-turn',
    });
    const accepted = await readJson(paths.bindingProbe, null);
    expect(accepted.last_binding_observation).toMatchObject({ outcome: 'accepted' });
    await writeFile(await onlyProbeIntentFile(paths), '{not-json\n');

    const resumed = await invokeHook({
      hook_event_name: 'SubagentStart',
      project_dir: dir,
      session_id: 'bound-before-exception-child',
      turn_id: 'bound-before-exception-turn',
      agent_id: 'bound-before-exception-agent',
      agent_type: 'default',
    });
    expect(resumed.systemMessage).toMatch(/production binding validation failed/i);
    expect(await readJson(paths.bindingProbe, null)).toEqual(accepted);
    expect(await bindingProbeStatus(paths)).toMatchObject({
      status: 'bound',
      infrastructure_status: 'failed',
      binding_observation: { outcome: 'accepted' },
    });

    const denied = await invokeHook({
      hook_event_name: 'PreToolUse',
      project_dir: dir,
      session_id: 'bound-before-exception-child',
      agent_id: 'bound-before-exception-agent',
      agent_type: 'default',
      tool_name: 'mcp__future_provider__mutate',
      tool_input: {},
    }, { canaryOnly: true });
    expect(denied.hookSpecificOutput?.permissionDecision ?? denied.decision).toBe('deny');
  });

  it('never constructs or deletes through a crafted persisted probe ticket id', async () => {
    const dir = await project();
    const paths = runtimePaths(dir);
    await prepareBindingProbe(paths, {
      host: 'codex',
      model: { model: 'gpt-5.6-terra', reasoning_effort: 'medium' },
    });
    const record = await readJson(paths.bindingProbe, null);
    const craftedTicketId = '../../binding-probe-sentinel';
    const escapedCandidate = path.resolve(
      paths.tickets,
      `${craftedTicketId.replaceAll(':', '_')}.json`,
    );
    expect(escapedCandidate.startsWith(`${path.resolve(paths.tickets)}${path.sep}`)).toBe(false);
    await writeFile(escapedCandidate, 'must survive\n');
    await writeFile(paths.bindingProbe, `${JSON.stringify({
      ...record,
      ticket_id: craftedTicketId,
      status: 'completed',
      completed_at: new Date().toISOString(),
    }, null, 2)}\n`);

    await expect(consumeBindingProbe(paths, 'codex')).rejects.toThrow(
      /probe state is structurally invalid/i,
    );
    expect(await readFile(escapedCandidate, 'utf8')).toBe('must survive\n');
    expect(await readJson(paths.bindingProbe, null)).toMatchObject({
      status: 'completed',
      ticket_id: craftedTicketId,
    });
  });

  it('never consumes parseable completed-looking state without the launch and binding proof', async () => {
    const dir = await project();
    const paths = runtimePaths(dir);
    await prepareBindingProbe(paths, {
      host: 'codex',
      model: { model: 'gpt-5.6-terra', reasoning_effort: 'medium' },
    });
    const prepared = await readJson(paths.bindingProbe, null);
    const preparedMs = Date.parse(prepared.prepared_at);
    const launchedAt = new Date(preparedMs + 1).toISOString();
    const boundAt = new Date(preparedMs + 2).toISOString();
    const completedAt = new Date(preparedMs + 3).toISOString();
    await writeFile(paths.bindingProbe, `${JSON.stringify({
      ...prepared,
      status: 'completed',
      binding_agent_type: 'default',
      parent_session_id: 'fabricated-parent',
      tool_use_id: 'fabricated-tool',
      launched_at: launchedAt,
      launch_expires_at: new Date(preparedMs + 60_000).toISOString(),
      launch_turn_id_hash: 'e'.repeat(64),
      launch_observations: 1,
      bound_session_id: 'fabricated-child',
      bound_agent_id: 'fabricated-agent',
      capability_hash: 'f'.repeat(64),
      bound_at: boundAt,
      last_binding_observation: {
        observed_at: boundAt,
        outcome: 'accepted',
        code: 'bound',
      },
      completed_at: completedAt,
      transitions: [
        ...prepared.transitions,
        { status: 'completed', at: completedAt },
      ],
    })}\n`);
    const branchBefore = execFileSync('git', ['branch', '--show-current'], {
      cwd: dir,
      encoding: 'utf8',
    }).trim();

    await expect(consumeBindingProbe(paths, 'codex')).rejects.toThrow(
      /probe state is structurally invalid/i,
    );
    await expect(startRun(dir, startInput())).rejects.toThrow(
      /probe state is structurally invalid/i,
    );
    expect(await readJson(paths.active, null)).toBeNull();
    expect(execFileSync('git', ['branch', '--show-current'], {
      cwd: dir,
      encoding: 'utf8',
    }).trim()).toBe(branchBefore);
  });

  it('requires the independent production intent to corroborate a structurally complete probe', async () => {
    const dir = await project();
    const paths = runtimePaths(dir);
    await prepareBindingProbe(paths, {
      host: 'codex',
      model: { model: 'gpt-5.6-terra', reasoning_effort: 'medium' },
    });
    const prepared = await readJson(paths.bindingProbe, null);
    const preparedMs = Date.parse(prepared.prepared_at);
    const launchedAt = new Date(preparedMs + 1).toISOString();
    const boundAt = new Date(preparedMs + 2).toISOString();
    const completedAt = new Date(preparedMs + 3).toISOString();
    const fabricated = {
      ...prepared,
      status: 'completed',
      binding_agent_type: 'default',
      parent_session_id: 'fabricated-parent',
      tool_use_id: 'fabricated-tool',
      launched_at: launchedAt,
      launch_expires_at: new Date(preparedMs + 60_000).toISOString(),
      launch_turn_id_hash: 'e'.repeat(64),
      launch_observations: 1,
      bound_session_id: 'fabricated-child',
      bound_agent_id: 'fabricated-agent',
      capability_hash: 'f'.repeat(64),
      bound_at: boundAt,
      last_binding_observation: {
        observed_at: boundAt,
        outcome: 'accepted',
        code: 'bound',
      },
      completed_at: completedAt,
      transitions: [
        { status: 'prepared', at: prepared.prepared_at },
        { status: 'launched', at: launchedAt },
        { status: 'bound', at: boundAt },
        { status: 'completed', at: completedAt },
      ],
    };
    await writeFile(paths.bindingProbe, `${JSON.stringify(fabricated)}\n`);

    expect(await bindingProbeStatus(paths)).toMatchObject({
      status: 'completed',
      infrastructure_status: 'failed',
      reason: expect.stringMatching(/production binding intent does not corroborate/i),
    });
    await expect(consumeBindingProbe(paths, 'codex')).resolves.toMatchObject({
      ok: false,
      probe: {
        infrastructure_status: 'failed',
        reason: expect.stringMatching(/production binding intent does not corroborate/i),
      },
    });
    await expect(startRun(dir, startInput())).resolves.toMatchObject({
      ok: false,
      blocked: true,
      infrastructure_failure: true,
      attempts_consumed: 0,
      probe: { infrastructure_status: 'failed' },
    });
    expect(await readJson(paths.active, null)).toBeNull();
    const recovered = await prepareBindingProbe(paths, {
      host: 'codex',
      model: { model: 'gpt-5.6-terra', reasoning_effort: 'medium' },
    });
    expect(recovered.probe).toMatchObject({
      status: 'prepared',
      infrastructure_status: 'awaiting_launch',
    });
    expect(recovered.probe.probe_id).not.toBe(fabricated.probe_id);
  });

  it('does not advertise an acknowledged probe as ready after its authoritative ticket is corrupt', async () => {
    const dir = await project();
    const paths = runtimePaths(dir);
    const action = await prepareBindingProbe(paths, {
      host: 'codex',
      model: { model: 'gpt-5.6-terra', reasoning_effort: 'medium' },
    });
    await invokeHook({
      hook_event_name: 'PreToolUse',
      project_dir: dir,
      session_id: 'ticket-corrupt-parent',
      turn_id: 'ticket-corrupt-turn',
      tool_use_id: 'ticket-corrupt-tool',
      tool_name: 'collaborationspawn_agent',
      tool_input: {
        task_name: action.dispatch.agent_name,
        fork_turns: 'none',
        message: 'gAAAAABencrypted-v2-message',
        model: action.dispatch.model.model,
        reasoning_effort: action.dispatch.model.reasoning_effort,
      },
    });
    const binding = await invokeHook({
      hook_event_name: 'SubagentStart',
      project_dir: dir,
      session_id: 'ticket-corrupt-child',
      turn_id: 'ticket-corrupt-turn',
      agent_id: 'ticket-corrupt-agent',
      agent_type: 'default',
    });
    const capability = binding.hookSpecificOutput.additionalContext.match(
      /APE_PROBE_CAPABILITY=([A-Za-z0-9_-]{32,256})/,
    )?.[1];
    await acknowledgeBindingProbe(paths, {
      probe_id: action.probe.probe_id,
      probe_capability: capability,
    });
    const completed = await readJson(paths.bindingProbe, null);
    await writeFile(probeTicketFile(paths, completed), '{not-json\n');

    expect(await bindingProbeStatus(paths)).toMatchObject({
      status: 'completed',
      infrastructure_status: 'failed',
      reason: expect.stringMatching(/authoritative native binding probe ticket unavailable/i),
    });
    await expect(startRun(dir, startInput())).resolves.toMatchObject({
      ok: false,
      blocked: true,
      infrastructure_failure: true,
      attempts_consumed: 0,
      probe: { infrastructure_status: 'failed' },
    });
    expect(await readJson(paths.active, null)).toBeNull();
  });

  it('rejects acknowledgement when the authoritative ticket disappears after binding', async () => {
    const dir = await project();
    const paths = runtimePaths(dir);
    const action = await prepareBindingProbe(paths, {
      host: 'codex',
      model: { model: 'gpt-5.6-terra', reasoning_effort: 'medium' },
    });
    const binding = await launchAndBindProbe(dir, action, {
      child: 'missing-ticket-child',
      agent: 'missing-ticket-agent',
      turn: 'missing-ticket-turn',
    });
    const capability = binding.hookSpecificOutput.additionalContext.match(
      /APE_PROBE_CAPABILITY=([A-Za-z0-9_-]{32,256})/,
    )?.[1];
    const bound = await readJson(paths.bindingProbe, null);
    await writeFile(probeTicketFile(paths, bound), '{not-json\n');

    await expect(acknowledgeBindingProbe(paths, {
      probe_id: action.probe.probe_id,
      probe_capability: capability,
    })).rejects.toThrow(/authoritative ticket is unavailable/i);
    expect(await bindingProbeStatus(paths)).toMatchObject({
      status: 'bound',
      infrastructure_status: 'failed',
      reason: expect.stringMatching(/authoritative native binding probe ticket unavailable/i),
    });
    await expect(prepareBindingProbe(paths, {
      host: 'codex',
      model: { model: 'gpt-5.6-terra', reasoning_effort: 'medium' },
    })).resolves.toMatchObject({ probe: { status: 'prepared' } });
  });

  it('blocks before mutation, then consumes prepared → launched → bound → acknowledged proof exactly once', async () => {
    const dir = await project();
    const paths = runtimePaths(dir);
    const branchBefore = execFileSync('git', ['branch', '--show-current'], { cwd: dir, encoding: 'utf8' }).trim();

    const blocked = await startRun(dir, startInput());
    expect(blocked).toMatchObject({
      ok: false,
      blocked: true,
      infrastructure_failure: true,
      attempts_consumed: 0,
      probe: { status: 'missing', infrastructure_status: 'required' },
    });
    expect(await readJson(paths.active, null)).toBeNull();
    expect(execFileSync('git', ['branch', '--show-current'], { cwd: dir, encoding: 'utf8' }).trim()).toBe(branchBefore);

    const prepared = await prepareNativeBindingProbe(dir, {
      host: 'codex',
      hooks_trusted: true,
      subagents_available: true,
      explicit_invocation: true,
    });
    expect(prepared.ok).toBe(true);
    const action = prepared.actions[0];
    expect(action.probe).toMatchObject({
      status: 'prepared',
      infrastructure_status: 'awaiting_launch',
      attempts_consumed: 0,
    });
    expect(action.dispatch.agent_name).toMatch(/^ape_probe_[a-f0-9]{32}$/u);
    const preparedIntentText = await readFile(await onlyProbeIntentFile(paths), 'utf8');
    const preparedIntent = JSON.parse(preparedIntentText);
    expect(preparedIntent).toMatchObject({
      codex_task_namespace: 'probe',
      launch_seed: expect.stringMatching(/^[a-f0-9]{64}$/u),
      launch_name_hash: expect.stringMatching(/^[a-f0-9]{64}$/u),
    });
    expect(preparedIntentText).not.toContain(action.dispatch.agent_name);

    const launch = await invokeHook({
      hook_event_name: 'PreToolUse',
      project_dir: dir,
      session_id: 'parent-session',
      turn_id: 'turn-1',
      tool_use_id: 'spawn-probe-1',
      // Multi-Agent V2 flattens collaboration.spawn_agent for hook matching
      // and encrypts message before the blocking PreToolUse boundary. The
      // visible task_name is therefore the launch-capability channel.
      tool_name: 'collaborationspawn_agent',
      tool_input: {
        task_name: action.dispatch.agent_name,
        fork_turns: 'none',
        message: 'gAAAAABencrypted-v2-message',
        model: action.dispatch.model.model,
        reasoning_effort: action.dispatch.model.reasoning_effort,
      },
    });
    expect(launch).toEqual({});
    expect(await bindingProbeStatus(paths)).toMatchObject({
      status: 'launched',
      infrastructure_status: 'awaiting_binding',
      launch_observations: 1,
      attempts_consumed: 0,
    });
    expect(await readJson(paths.bindingProbe, null)).toMatchObject({
      agent_type: 'explorer',
      binding_agent_type: 'default',
    });

    const mismatchedBinding = await invokeHook({
      hook_event_name: 'SubagentStart',
      project_dir: dir,
      session_id: 'parent-session',
      turn_id: 'mismatched-child-turn',
      agent_id: 'mismatched-native-probe-agent',
      agent_type: 'worker',
      model: action.dispatch.model.model,
    });
    expect(mismatchedBinding.systemMessage).toBeUndefined();
    expect(mismatchedBinding.hookSpecificOutput?.additionalContext ?? '').not.toContain('APE_PROBE_CAPABILITY=');
    const mismatchedBootstrap = await invokeHook({
      hook_event_name: 'PreToolUse',
      project_dir: dir,
      session_id: 'mismatched-native-probe-agent',
      turn_id: 'mismatched-child-turn',
      tool_use_id: 'mismatched-probe-bootstrap',
      tool_name: 'mcp__ape__ape_bind',
      tool_input: action.dispatch.bootstrap_args,
    });
    expect(mismatchedBootstrap.hookSpecificOutput?.permissionDecision).toBe('deny');
    expect(mismatchedBootstrap.hookSpecificOutput?.permissionDecisionReason).toMatch(/native child type does not satisfy/);
    expect(await bindingProbeStatus(paths)).toMatchObject({
      status: 'launched',
    });

    const binding = await bootstrapObservedChild(dir, action, {
      parent: 'parent-session',
      turn: 'child-turn-1',
      agent: 'native-probe-agent',
    });
    expect(binding.systemMessage).toBeUndefined();
    const context = binding.hookSpecificOutput?.additionalContext ?? '';
    expect(context).toContain('APE trusted native binding context (authoritative)');
    expect(context).toContain('APE preflight_analyst contract');
    expect(context).toContain('Immutable StageTicket reference');
    expect(context).toContain('APE native binding infrastructure probe (authoritative)');
    const capability = context.match(/APE_PROBE_CAPABILITY=([A-Za-z0-9_-]{32,256})/)?.[1];
    expect(capability).toBeTruthy();
    expect(await bindingProbeStatus(paths)).toMatchObject({
      status: 'bound',
      infrastructure_status: 'awaiting_acknowledgement',
      attempts_consumed: 0,
      binding_observation: { outcome: 'accepted', code: 'bound' },
    });
    const forbiddenTool = await invokeHook({
      hook_event_name: 'PreToolUse',
      project_dir: dir,
      session_id: 'parent-session',
      turn_id: 'child-turn-1',
      agent_id: 'native-probe-agent',
      tool_name: 'Read',
      tool_input: { file_path: 'docs/note.md' },
    });
    expect(forbiddenTool.hookSpecificOutput?.permissionDecision).toBe('deny');
    expect(forbiddenTool.hookSpecificOutput?.permissionDecisionReason).toMatch(/canary may not call tools/);

    await expect(acknowledgeBindingProbe(paths, {
      probe_id: action.probe.probe_id,
      probe_capability: 'x'.repeat(43),
    })).rejects.toThrow(/capability mismatch/);
    const acknowledged = await acknowledgeBindingProbe(paths, {
      probe_id: action.probe.probe_id,
      probe_capability: capability,
    });
    expect(acknowledged).toMatchObject({
      status: 'completed',
      infrastructure_status: 'ready',
      attempts_consumed: 0,
    });

    const started = await startRun(dir, startInput());
    expect(started.ok).toBe(true);
    expect(started.binding_probe).toMatchObject({
      probe_id: action.probe.probe_id,
      status: 'consumed',
      infrastructure_status: 'consumed',
      attempts_consumed: 0,
    });
    expect(started.run.attempts).not.toHaveProperty('probe');
    expect(started.actions.find((entry) => entry.type === 'dispatch_agent')?.ticket.attempt).toBe(1);
    expect((await bindingProbeStatus(paths)).status).toBe('consumed');
    await expect(consumeBindingProbe(paths, 'codex')).resolves.toMatchObject({
      ok: false,
      probe: { status: 'consumed', infrastructure_status: 'consumed' },
    });

    expect((await abortRun(dir, 'finish first run before consecutive probe')).run.status).toBe('aborted');
    const unrelatedStart = await invokeHook({
      hook_event_name: 'SubagentStart',
      project_dir: dir,
      session_id: 'unrelated-post-run-child',
      turn_id: 'unrelated-post-run-turn',
      agent_id: 'unrelated-post-run-agent',
      agent_type: 'default',
    });
    expect(unrelatedStart).toEqual({});
    const unrelatedTool = await invokeHook({
      hook_event_name: 'PreToolUse',
      project_dir: dir,
      session_id: 'unrelated-post-run-child',
      turn_id: 'unrelated-post-run-turn',
      agent_id: 'unrelated-post-run-agent',
      agent_type: 'default',
      tool_name: 'Read',
      tool_input: { file_path: 'docs/note.md' },
    });
    expect(unrelatedTool).toEqual({});
    const consumedCanaryTool = await invokeHook({
      hook_event_name: 'PreToolUse',
      project_dir: dir,
      session_id: 'parent-session',
      turn_id: 'child-turn-1',
      agent_id: 'native-probe-agent',
      agent_type: 'default',
      tool_name: 'Read',
      tool_input: { file_path: 'docs/note.md' },
    });
    expect(
      consumedCanaryTool.hookSpecificOutput?.permissionDecision ??
        consumedCanaryTool.decision,
    ).toBe('deny');
    expect(
      consumedCanaryTool.hookSpecificOutput?.permissionDecisionReason ??
        consumedCanaryTool.reason ??
        consumedCanaryTool.systemMessage,
    ).toMatch(/binding canary may not call tools/i);
    const wrongTypeCanaryStart = await invokeHook({
      hook_event_name: 'SubagentStart',
      project_dir: dir,
      session_id: 'parent-session',
      turn_id: 'child-turn-1',
      agent_id: 'native-probe-agent',
      agent_type: 'worker',
    });
    expect(wrongTypeCanaryStart.systemMessage).toMatch(/canary identity is retired/i);
    const wrongTypeCanaryTool = await invokeHook({
      hook_event_name: 'PreToolUse',
      project_dir: dir,
      session_id: 'parent-session',
      turn_id: 'child-turn-1',
      agent_id: 'native-probe-agent',
      agent_type: 'worker',
      tool_name: 'Read',
      tool_input: { file_path: 'docs/note.md' },
    });
    expect(
      wrongTypeCanaryTool.hookSpecificOutput?.permissionDecision ??
        wrongTypeCanaryTool.decision,
    ).toBe('deny');
    expect(
      wrongTypeCanaryTool.hookSpecificOutput?.permissionDecisionReason ??
        wrongTypeCanaryTool.reason ??
        wrongTypeCanaryTool.systemMessage,
    ).toMatch(/binding canary may not call tools|native child identity evidence is unreadable/i);
    const consecutive = await prepareNativeBindingProbe(dir, {
      host: 'codex',
      hooks_trusted: true,
      subagents_available: true,
      explicit_invocation: true,
    });
    expect(consecutive).toMatchObject({
      ok: true,
      probe: { status: 'prepared' },
    });
    expect(consecutive.probe.probe_id).not.toBe(action.probe.probe_id);
  });

  it('reports an observed-but-unbound launch as infrastructure failure and never creates run state', async () => {
    const dir = await project();
    const paths = runtimePaths(dir);
    const branchBefore = execFileSync('git', ['branch', '--show-current'], { cwd: dir, encoding: 'utf8' }).trim();
    const action = await prepareBindingProbe(paths, {
      host: 'codex',
      model: { model: 'gpt-5.6-terra', reasoning_effort: 'medium' },
    });
    await invokeHook({
      hook_event_name: 'PreToolUse',
      project_dir: dir,
      session_id: 'parent-session',
      turn_id: 'turn-1',
      tool_use_id: 'spawn-probe-1',
      tool_name: 'collaborationspawn_agent',
      tool_input: {
        task_name: action.dispatch.agent_name,
        fork_turns: 'none',
        agent_type: action.dispatch.agent_type,
        message: 'gAAAAABencrypted-v2-message',
        model: action.dispatch.model.model,
        reasoning_effort: action.dispatch.model.reasoning_effort,
      },
    });

    const blocked = await startRun(dir, startInput());
    expect(blocked).toMatchObject({
      ok: false,
      blocked: true,
      infrastructure_failure: true,
      attempts_consumed: 0,
      probe: { status: 'launched', infrastructure_status: 'awaiting_binding' },
    });
    expect(await readJson(paths.active, null)).toBeNull();
    expect(execFileSync('git', ['branch', '--show-current'], { cwd: dir, encoding: 'utf8' }).trim()).toBe(branchBefore);
  });

  it('fails the canary when the production authoritative-context hash check fails', async () => {
    const dir = await project();
    const paths = runtimePaths(dir);
    const action = await prepareBindingProbe(paths, {
      host: 'codex',
      model: { model: 'gpt-5.6-terra', reasoning_effort: 'medium' },
    });
    await invokeHook({
      hook_event_name: 'PreToolUse',
      project_dir: dir,
      session_id: 'parent-session',
      turn_id: 'turn-context-tamper',
      tool_use_id: 'spawn-context-tamper',
      tool_name: 'collaborationspawn_agent',
      tool_input: {
        task_name: action.dispatch.agent_name,
        fork_turns: 'none',
        message: 'gAAAAABencrypted-v2-message',
        model: action.dispatch.model.model,
        reasoning_effort: action.dispatch.model.reasoning_effort,
      },
    });
    const intentFile = await onlyProbeIntentFile(paths);
    const intent = JSON.parse(await readFile(intentFile, 'utf8'));
    await writeFile(intentFile, `${JSON.stringify({
      ...intent,
      injected_context_hash: '0'.repeat(64),
    })}\n`);

    const binding = await invokeHook({
      hook_event_name: 'SubagentStart',
      project_dir: dir,
      session_id: 'probe-child-context-tamper',
      turn_id: 'turn-context-tamper',
      agent_id: 'probe-agent-context-tamper',
      agent_type: 'default',
    });
    expect(binding.systemMessage).toMatch(/authoritative context hash mismatch/i);
    expect(await bindingProbeStatus(paths)).toMatchObject({
      status: 'launched',
      infrastructure_status: 'failed',
      binding_observation: {
        outcome: 'rejected',
        code: 'context_hash_mismatch',
      },
    });
  });
});
