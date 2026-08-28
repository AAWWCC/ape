# Native-agent adapters

APE has no workflow-script runtime. Claude uses its Agent tool; Codex uses native subagents. Both
receive the same immutable `StageTicket`, common prompt, role prompt, and runtime-owned model policy.

## Claude

`dispatch.dispatch_intent` supplies a single-use nonce at the start of the Agent prompt. The launch
hook checks the requested model, consumes the nonce, and binds the host-issued subagent identity at
`SubagentStart`. The receipt records the attested requested model; provider fallback means that is
not necessarily the model that executed.

## Codex

Before `start`, Codex must complete the live binding preflight described in the MCP tools reference.
This proves that the current host session delivers both the launch hook and `SubagentStart`; a
shipped hook manifest alone is not treated as operational proof. The completed proof is fresh,
single-use, and consumed before the run's first Git mutation.

The runtime returns a versioned `dispatch.spawn_args` object containing the exact native
`task_name`, `fork_turns: "none"`, model, optional reasoning effort, and a fixed transport-only
bootstrap `message`. `fork_turns: "none"` is required because the host's inherited-history default
cannot be combined with model/reasoning overrides. Codex encrypts `message` before the launch hook
can inspect it, so no stage authority travels through that field. The parent passes
`spawn_args` to `spawn_agent` unchanged; `prompt_paths`,
`agent_name`, and the structured `dispatch.model` remain compatibility/diagnostic fields, not an
invitation to reconstruct the launch. The action's `agent_type` remains APE's logical
worker/explorer policy role; Multi-Agent V2 does not expose a native `agent_type` argument.
Concretely, `dispatch.spawn_args.task_name` equals `dispatch.agent_name`, and
`dispatch.spawn_args.message` is the native `spawn_agent.message`.
Multi-Agent V2 exposes the canonical hook tool name as `collaborationspawn_agent`; the generated
task name carries the visible one-time launch capability because the message is encrypted before
PreToolUse.

The launch hook consumes that capability and records a short-lived reservation. `SubagentStart`
then supplies the host-issued child `session_id`, `agent_id`, and effective `agent_type` (`default`
on Multi-Agent V2); the hook binds them to the ticket separately from the logical role. It then
injects the one-time receipt capability plus the authoritative complete common prompt, complete
role prompt, and immutable id/hash/path ticket reference. The runtime hash-binds that context to the
prepared intent and verifies the active ticket hash before injection. `ticket_projection` is
`hook-injected`; the child reads the complete ticket only from the sanctioned hash-bound path.
Spawn calls run sequentially through this handshake, after which bound agents may work in parallel.
No ambient environment binding is used or trusted.

Only the scheduler may request parallel dispatch: plan checker/critic and normal/security code
review are the current parallel groups.
