import { spawn } from 'node:child_process';
import path from 'node:path';
import {
  acknowledgeBindingProbe,
  prepareBindingProbe,
} from '../lib/runtime/binding-probe.js';
import { runtimePaths } from '../lib/runtime/paths.js';

export function invokeCodexHook(root, input) {
  return new Promise((resolve, reject) => {
    const env = { ...process.env };
    delete env.CLAUDECODE;
    delete env.CLAUDE_CODE;
    delete env.CLAUDE_PROJECT_DIR;
    delete env.CODEX_CWD;
    const child = spawn(process.execPath, [path.join(root, 'bin', 'ape-hook.mjs')], {
      cwd: root,
      env,
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

export async function bindCodexDispatchContext(root, projectDir, action, ordinal = 1) {
  const sessionId = `wire-${ordinal}-${action.ticket.ticket_id}`;
  await invokeCodexHook(root, {
    hook_event_name: 'PreToolUse',
    project_dir: projectDir,
    session_id: sessionId,
    turn_id: 'turn-1',
    tool_use_id: `spawn-${ordinal}`,
    tool_name: 'collaborationspawn_agent',
    tool_input: {
      task_name: action.dispatch.agent_name,
      agent_type: action.dispatch.agent_type,
      message: 'gAAAAABencrypted-v2-message',
      model: action.dispatch.model.model,
      reasoning_effort: action.dispatch.model.reasoning_effort,
    },
  });
  const started = await invokeCodexHook(root, {
    hook_event_name: 'SubagentStart',
    project_dir: projectDir,
    session_id: `${sessionId}-child`,
    turn_id: 'turn-1',
    agent_id: `agent-${ordinal}-${action.ticket.ticket_id}`,
    agent_type: action.dispatch.agent_type,
  });
  const capability = started.hookSpecificOutput?.additionalContext
    ?.match(/APE_RECEIPT_CAPABILITY=([A-Za-z0-9_-]+)/)?.[1];
  if (!capability) throw new Error(`Codex dispatch did not mint a receipt capability for ${action.ticket.ticket_id}`);
  return {
    capability,
    sessionId: `${sessionId}-child`,
    agentId: `agent-${ordinal}-${action.ticket.ticket_id}`,
  };
}

export async function bindCodexDispatch(root, projectDir, action, ordinal = 1) {
  return (await bindCodexDispatchContext(root, projectDir, action, ordinal)).capability;
}

export async function completeCodexBindingProbe(root, projectDir, ordinal = 1) {
  const action = await prepareBindingProbe(runtimePaths(projectDir), {
    host: 'codex',
    model: { model: 'gpt-5.6-terra', reasoning_effort: 'medium' },
  });
  const sessionId = `probe-${ordinal}-${action.probe.probe_id}`;
  const agentId = `probe-agent-${ordinal}`;
  const launch = await invokeCodexHook(root, {
    hook_event_name: 'PreToolUse',
    project_dir: projectDir,
    session_id: sessionId,
    turn_id: 'probe-turn',
    tool_use_id: `probe-spawn-${ordinal}`,
    tool_name: 'collaborationspawn_agent',
    tool_input: {
      task_name: action.dispatch.agent_name,
      agent_type: action.dispatch.agent_type,
      message: 'gAAAAABencrypted-v2-message',
      model: action.dispatch.model.model,
      reasoning_effort: action.dispatch.model.reasoning_effort,
    },
  });
  if (Object.keys(launch).length !== 0) {
    throw new Error(`Codex binding probe launch did not return neutral success JSON: ${JSON.stringify(launch)}`);
  }
  const started = await invokeCodexHook(root, {
    hook_event_name: 'SubagentStart',
    project_dir: projectDir,
    session_id: `${sessionId}-child`,
    turn_id: 'probe-turn',
    agent_id: agentId,
    agent_type: action.dispatch.agent_type,
  });
  const capability = started.hookSpecificOutput?.additionalContext
    ?.match(/APE_PROBE_CAPABILITY=([A-Za-z0-9_-]+)/)?.[1];
  if (!capability) throw new Error(`Codex binding probe did not mint a capability: ${JSON.stringify(started)}`);
  return acknowledgeBindingProbe(runtimePaths(projectDir), {
    probe_id: action.probe.probe_id,
    probe_capability: capability,
  });
}
