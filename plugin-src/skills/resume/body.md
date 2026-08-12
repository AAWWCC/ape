# APE resume

Use only when the user explicitly asks to resume APE. Call `ape_run` with `action: "resume"` and
continue from the returned machine state; never reconstruct completed work or pending tickets from
conversation memory.

Follow [`references/run-resume-protocol.md`](references/run-resume-protocol.md) for dispatch,
receipt recording, waiting, and advancement. Never spawn a replacement for an already-bound ticket.
When a dispatch remains active, wait through the host's native agent primitive. Use
`expire-dispatch` only for a genuinely orphaned or wedged flight, with the exact pending ticket ID
and a non-empty user-provided audit reason.

Accept the runtime's current lane, model policy, retry count, remediation state, and gate state.
Do not redo stages, free-hand transitions, or edit files from the parent session.
