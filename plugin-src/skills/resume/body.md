# APE resume

Use only when the user explicitly asks to resume APE. Call `ape_run` with `action: "resume"` and
continue from the returned machine state; never reconstruct completed work or pending tickets from
conversation memory.
On Google Antigravity / Gemini, pass the exact open project root as `project_dir` on every APE MCP
call.

Follow [`references/run-resume-protocol.md`](references/run-resume-protocol.md) for dispatch,
receipt recording, waiting, and advancement. Never spawn a replacement for an already-bound ticket
unless the runtime returns `next_action: {"kind":"redispatch_same_ticket", ...}`; that action authorizes at most
one fresh worker on the same immutable ticket after receipt-contract correction exhaustion.
When the runtime instead returns `next_action.kind: "capability_recovery"`, dispatch only the
included runtime-derived successor. It consumes no product attempt and already binds the exact
additive scope, policy, deadlines, manifests, run contract, lineage ceilings, and provenance. Never
mint or alter a successor. If the response was lost, record the identical source receipt again; the
runtime validates and adopts the same complete immutable generation rather than charging another
successor. Canonical test-path unions are limited to 64 items and 4096 serialized UTF-8 JSON bytes,
and the lineage remains bounded to three validation submissions per worker and two workers per
ticket.
When a dispatch remains active, wait through the host's native agent primitive. Use
`expire-dispatch` only for a genuinely orphaned or wedged flight, with the exact pending ticket ID
and a non-empty user-provided audit reason.

Accept the runtime's current lane, model policy, retry count, remediation state, and gate state.
Do not redo stages, free-hand transitions, or edit files from the parent session.
