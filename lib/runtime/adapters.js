const CLAUDE_AGENT_NAMES = Object.freeze({
  planner: 'ape:planner',
  plan_checker: 'ape:plan-checker',
  plan_critic: 'ape:plan-critic',
  plan_judge: 'ape:plan-judge',
  test_writer: 'ape:test-writer',
  implementer: 'ape:implementer',
  reviewer: 'ape:reviewer',
  security_reviewer: 'ape:security-reviewer',
  debugger: 'ape:debugger',
  spike_researcher: 'ape:spike-researcher',
});

export function nativeDispatch(host, ticket, dispatchIntent = null) {
  const promptPath = `prompts/${ticket.role}.md`;
  const promptPaths = ['prompts/common.md', promptPath];
  if (host === 'claude') {
    const dispatch = {
      host,
      native_tool: 'Agent',
      agent_type: CLAUDE_AGENT_NAMES[ticket.role] ?? `ape:${ticket.role.replaceAll('_', '-')}`,
      prompt_path: promptPath,
      prompt_paths: promptPaths,
      model: ticket.model,
      ticket,
    };
    if (dispatchIntent) dispatch.dispatch_intent = dispatchIntent;
    return dispatch;
  }
  if (host === 'codex') {
    const dispatch = {
      host,
      native_tool: 'spawn_agent',
      // Built-in worker/explorer profiles are available wherever the plugin is
      // installed. Project custom agents remain optional: plugins do not need
      // to distribute .codex/agents for the APE role prompt to take effect.
      agent_name: dispatchIntent?.agent_name ?? ticket.role,
      agent_type: ticket.writable ? 'worker' : 'explorer',
      prompt_path: promptPath,
      prompt_paths: promptPaths,
      model: ticket.model,
      // Multi-Agent V2 encrypts message before PreToolUse. A one-time token in
      // agent_name/task_name is therefore the visible launch capability;
      // SubagentStart then binds Codex's host-issued child session and agent_id
      // to this ticket; its session_id is not the parent launch session.
      ticket,
    };
    if (dispatchIntent) dispatch.dispatch_intent = dispatchIntent;
    return dispatch;
  }
  throw new Error(`unsupported host: ${host}`);
}
