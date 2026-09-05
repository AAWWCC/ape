# Native-agent adapters

Claude uses its Agent tool; Codex uses native subagents. Both receive the same immutable
`StageTicket`, common prompt, role prompt, and runtime-selected model. The adapters launch work;
they do not choose stage order or approve results.

## Claude

`dispatch.dispatch_intent` provides a single-use nonce for the start of the Agent prompt. The
launch hook checks the requested model and consumes the nonce. `SubagentStart` binds the
host-issued child identity.

The receipt attests the requested model, not necessarily the executing model: the provider may
fall back to another model. Claude's live certification status is separate from Codex's.

## Codex

Before `start`, the current session must pass the [live binding preflight](mcp-tools.md).
A shipped hook manifest alone is not treated as operational proof: the hooks must actually run.
The proof is fresh, single-use, and consumed before the first Git mutation.

### Launch and bind

1. The parent passes `dispatch.spawn_args` to `spawn_agent` unchanged. It contains the exact
   `task_name`, `fork_turns: "none"`, model, optional reasoning effort, and bootstrap `message`.
   A full-history fork cannot be combined with these model overrides.
2. The launch hook consumes the one-time capability in the task name. `SubagentStart` records
   the host-issued child `session_id`, `agent_id`, type, and actual model as provisional evidence.
   It does not grant stage authority.
3. The child's first APE operation is `ape_bind`, using the separate bootstrap bearer from the
   message. If the tool is deferred, discover it by its bare registered name, `ape_bind`, then
   call the returned tool. Never put the bearer in a search or use project inspection instead.
4. The trusted `ape_bind` hook checks the generation, parent/child identity, model, ticket,
   deadline, and one-child ownership. It injects the complete common and role prompts, the
   hash-bound ticket reference, and the receipt capability. The MCP result alone grants no
   authority. A preflight canary must then acknowledge the injected context.

For new dispatches, `ticket_projection` is `bootstrap-hook-injected`. The child reads the full
ticket from its sanctioned hash-bound path. It must not expect ticket context before binding.
Launches complete this handshake sequentially; bound workers may then run in parallel.

### Transport limits

Codex encrypts the message before the launch hook sees it. The visible task-name capability
authorizes launch; the separate bearer in the message authorizes binding. APE trusts the parent
to relay the message unchanged and does not claim independent proof connecting a physical spawn
to a child UUID. No ambient environment binding is used or trusted.

`agent_name`, `prompt_paths`, and `dispatch.model` are compatibility or diagnostic fields, not
instructions to rebuild `spawn_args`. Its `task_name` equals `dispatch.agent_name`, and its
`message` becomes `spawn_agent.message` unchanged. APE's logical `agent_type` remains
worker/explorer policy; Multi-Agent V2 has no native `agent_type` argument
and reports `default` in the child event. Its hook tool name is `collaborationspawn_agent`.

Only the scheduler requests parallel work: plan checker/critic and code/security review groups.
See [lifecycle hooks](hooks.md#codex-native-bootstrap) for binding checks and legacy behavior.
