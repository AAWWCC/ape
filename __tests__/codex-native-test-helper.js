import { spawn } from 'node:child_process';
import path from 'node:path';
import {
  acknowledgeBindingProbe,
  prepareBindingProbe,
} from '../lib/runtime/binding-probe.js';
import { runtimePaths } from '../lib/runtime/paths.js';
import { codexBootstrapOrientation } from '../lib/runtime/codex-bootstrap.js';
export function invokeCodexHook(root, input, args = []) {
  return new Promise((resolve, reject) => {
    const env = { ...process.env };
    delete env.CLAUDECODE;
    delete env.CLAUDE_CODE;
    delete env.CLAUDE_PROJECT_DIR;
    delete env.CODEX_CWD;
    const child = spawn(process.execPath, [path.join(root, 'bin', 'ape-hook.mjs'), ...args], {
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
      fork_turns: 'none',
      message: 'gAAAAABencrypted-v2-message',
      model: action.dispatch.model.model,
      reasoning_effort: action.dispatch.model.reasoning_effort,
    },
  });
  const bootstrap = action.dispatch.bootstrap_protocol === 1;
  const childSessionId = bootstrap ? sessionId : `${sessionId}-child`;
  const childTurnId = bootstrap ? `child-turn-${ordinal}` : 'turn-1';
  let started = await invokeCodexHook(root, {
    hook_event_name: 'SubagentStart',
    project_dir: projectDir,
    session_id: childSessionId,
    turn_id: childTurnId,
    agent_id: `agent-${ordinal}-${action.ticket.ticket_id}`,
    agent_type: 'default',
    model: action.dispatch.model.model,
  });
  if (bootstrap) {
    if (started.hookSpecificOutput?.additionalContext !== codexBootstrapOrientation()) {
      throw new Error('Provisional child start must receive only capability-free orientation');
    }
    started = await invokeCodexHook(root, {
      hook_event_name: 'PreToolUse',
      project_dir: projectDir,
      session_id: childSessionId,
      turn_id: childTurnId,
      tool_use_id: `bootstrap-${ordinal}`,
      tool_name: 'mcp__ape__ape_bind',
      tool_input: action.dispatch.bootstrap_args,
      model: action.dispatch.model.model,
    });
  }
  const capability = started.hookSpecificOutput?.additionalContext
    ?.match(/APE_RECEIPT_CAPABILITY=([A-Za-z0-9_-]+)/)?.[1];
  if (!capability) throw new Error(`Codex dispatch did not mint a receipt capability for ${action.ticket.ticket_id}`);
  return {
    capability,
    sessionId: childSessionId,
    turnId: childTurnId,
    agentId: `agent-${ordinal}-${action.ticket.ticket_id}`,
  };
}

export async function bindCodexDispatch(root, projectDir, action, ordinal = 1) {
  return (await bindCodexDispatchContext(root, projectDir, action, ordinal)).capability;
}

export async function completeCodexBindingProbe(root, projectDir) {
  const paths = runtimePaths(projectDir);
  const action = await prepareBindingProbe(paths, {
    host: 'codex',
    model: { model: 'gpt-5.6-terra', reasoning_effort: 'medium' },
  });
  await invokeCodexHook(root, {
    hook_event_name: 'PreToolUse',
    project_dir: projectDir,
    session_id: 'probe-parent-session',
    turn_id: 'probe-turn',
    tool_use_id: `spawn-${action.probe.probe_id}`,
    tool_name: 'collaborationspawn_agent',
    tool_input: {
      task_name: action.dispatch.agent_name,
      fork_turns: 'none',
      message: 'gAAAAABencrypted-v2-message',
      model: action.dispatch.model.model,
      reasoning_effort: action.dispatch.model.reasoning_effort,
    },
  });
  const started = await invokeCodexHook(root, {
    hook_event_name: 'SubagentStart',
    project_dir: projectDir,
    session_id: 'probe-parent-session',
    turn_id: 'probe-child-turn',
    agent_id: `agent-${action.probe.probe_id}`,
    agent_type: 'default',
    model: action.dispatch.model.model,
  });
  if (started.hookSpecificOutput?.additionalContext !== codexBootstrapOrientation()) {
    throw new Error('Provisional probe start must receive only capability-free orientation');
  }
  const bootstrapped = await invokeCodexHook(root, {
    hook_event_name: 'PreToolUse',
    project_dir: projectDir,
    session_id: 'probe-parent-session',
    turn_id: 'probe-child-turn',
    tool_use_id: `bootstrap-${action.probe.probe_id}`,
    tool_name: 'mcp__ape__ape_bind',
    tool_input: action.dispatch.bootstrap_args,
    model: action.dispatch.model.model,
  });
  const context = bootstrapped.hookSpecificOutput?.additionalContext ?? '';
  const capability = context.match(/APE_PROBE_CAPABILITY=([A-Za-z0-9_-]+)/)?.[1];
  if (!capability) throw new Error(`Codex binding probe did not mint a capability for ${action.probe.probe_id}`);
  await acknowledgeBindingProbe(paths, {
    probe_id: action.probe.probe_id,
    probe_capability: capability,
  });
  return action.probe.probe_id;
}
