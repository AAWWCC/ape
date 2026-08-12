import { execFileSync, spawn } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import {
  acknowledgeBindingProbe,
  bindingProbeStatus,
  prepareBindingProbe,
} from '../lib/runtime/binding-probe.js';
import { runtimePaths } from '../lib/runtime/paths.js';
import { readJson } from '../lib/runtime/storage.js';
import { prepareNativeBindingProbe, startRun } from '../lib/runtime/service.js';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const cleanups = [];

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((entry) => rm(entry, { recursive: true, force: true })));
});

function invokeHook(input) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(root, 'bin', 'ape-hook.mjs')], {
      cwd: root,
      env: { ...process.env, CODEX_CWD: input.project_dir },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code !== 0) reject(new Error(stderr));
      else resolve(JSON.parse(stdout));
    });
    child.stdin.end(`${JSON.stringify(input)}\n`);
  });
}

async function project() {
  const dir = await mkdtemp(path.join(tmpdir(), 'ape-binding-probe-'));
  cleanups.push(dir);
  await mkdir(path.join(dir, 'docs'), { recursive: true });
  await writeFile(path.join(dir, 'docs', 'note.md'), '# Note\n');
  execFileSync('git', ['init', '-q'], { cwd: dir });
  execFileSync('git', ['config', 'user.email', 'ape@example.test'], { cwd: dir });
  execFileSync('git', ['config', 'user.name', 'APE Test'], { cwd: dir });
  execFileSync('git', ['add', '.'], { cwd: dir });
  execFileSync('git', ['commit', '-qm', 'baseline'], { cwd: dir });
  return dir;
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

describe('APE v2 pre-run native binding probe', () => {
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
        agent_type: 'worker',
        message: 'gAAAAABencrypted-v2-message',
        model: action.dispatch.model.model,
        reasoning_effort: action.dispatch.model.reasoning_effort,
      },
    });
    expect(launch.hookSpecificOutput?.permissionDecision ?? launch.decision).toBe('deny');
    expect(await bindingProbeStatus(paths)).toMatchObject({ status: 'prepared', launch_observations: 0 });
  });

  it('blocks start without consuming a run attempt, then proves prepared → launched → bound → acknowledged through real Codex event shapes', async () => {
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

    const binding = await invokeHook({
      hook_event_name: 'SubagentStart',
      project_dir: dir,
      session_id: 'codex-child-session',
      turn_id: 'turn-1',
      agent_id: 'native-probe-agent',
      agent_type: action.dispatch.agent_type,
    });
    expect(binding.systemMessage).toBeUndefined();
    const context = binding.hookSpecificOutput?.additionalContext ?? '';
    const capability = context.match(/APE_PROBE_CAPABILITY=([A-Za-z0-9_-]{32,256})/)?.[1];
    expect(capability).toBeTruthy();
    expect(await bindingProbeStatus(paths)).toMatchObject({
      status: 'bound',
      infrastructure_status: 'awaiting_acknowledgement',
      attempts_consumed: 0,
    });
    const forbiddenTool = await invokeHook({
      hook_event_name: 'PreToolUse',
      project_dir: dir,
      session_id: 'codex-child-session',
      turn_id: 'turn-1',
      agent_id: 'native-probe-agent',
      agent_type: action.dispatch.agent_type,
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
  });

  it('reports an unbound launch as infrastructure state and never creates active run state', async () => {
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
      turn_id: 'turn-1',
      tool_use_id: 'spawn-probe-1',
      tool_name: 'collaborationspawn_agent',
      tool_input: {
        task_name: action.dispatch.agent_name,
        agent_type: action.dispatch.agent_type,
        message: 'gAAAAABencrypted-v2-message',
        model: action.dispatch.model.model,
        reasoning_effort: action.dispatch.model.reasoning_effort,
      },
    });

    const blocked = await startRun(dir, startInput());
    expect(blocked).toMatchObject({
      ok: false,
      infrastructure_failure: true,
      attempts_consumed: 0,
      probe: { status: 'launched', infrastructure_status: 'awaiting_binding' },
    });
    expect(await readJson(paths.active, null)).toBeNull();
  });
});
