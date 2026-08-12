# Native-agent adapters

APE has no workflow-script runtime. Claude uses its Agent tool; Codex uses native subagents. Both
receive the same immutable `StageTicket`, common prompt, role prompt, and runtime-owned model policy.

## Claude

`dispatch.dispatch_intent` supplies a single-use nonce at the start of the Agent prompt. The launch
hook checks the requested model, consumes the nonce, and binds the host-issued subagent identity at
`SubagentStart`. The receipt records the attested requested model; provider fallback means that is
not necessarily the model that executed.

## Codex

The parent inlines the ordered `prompt_paths` and ticket into `spawn_agent.message`, forwards
`dispatch.agent_name` as `task_name`, and also forwards the agent type, model, and reasoning effort.
Multi-Agent V2 exposes the canonical hook tool name as `collaborationspawn_agent`; the generated
task name carries the visible one-time launch capability because the message is encrypted before
PreToolUse.

The launch hook consumes that capability and records a short-lived reservation. `SubagentStart`
then supplies the host-issued child `session_id`, `agent_id`, and `agent_type`; the hook binds them
to the ticket and injects the one-time receipt capability. Spawn calls run sequentially through
this handshake, after which bound agents may work in parallel. No ambient environment binding is
used or trusted.

Only the scheduler may request parallel dispatch: plan checker/critic and normal/security code
review are the current parallel groups.
