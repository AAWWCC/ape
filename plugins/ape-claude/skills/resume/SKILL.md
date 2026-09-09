---
name: resume
description: "Resume an interrupted APE run from persisted machine state."
disable-model-invocation: true
---

# APE resume

Use only when the user explicitly asks to resume APE. Call `ape_run` with `action: "resume"` and
continue from the returned machine state; never reconstruct completed work or pending tickets from
conversation memory.
Pass the governed project root as `project_dir` on every APE MCP call. If there is no active run,
report that result; a resume request does not authorize a fresh start or reset.

Follow [`references/run-resume-protocol.md`](references/run-resume-protocol.md) for dispatch,
receipt recording, waiting, and advancement. Never spawn a replacement for an already-bound ticket
unless the runtime returns `next_action: {"kind":"redispatch_same_ticket", ...}`; that action authorizes
the returned replacement after the runtime confirms the original has stopped, within the run's frozen policy.
When the runtime instead returns `next_action.kind: "capability_recovery"`, dispatch only the
included runtime-derived successor. It consumes no product attempt and already binds the exact
additive scope, policy, deadlines, manifests, run contract, lineage ceilings, and provenance. Never
mint or alter a successor. If the response was lost, record the identical source receipt again; the
runtime validates and adopts the same complete immutable generation rather than charging another
successor. Follow the issued growth contract and frozen validation/worker limits. New growth
contract v2 checks canonical unique paths against the shared structural guard and actual rendered
command and manifest budgets. Historical growth contract v1 retains its 64-item/4096-byte bounds;
never apply those historical bounds to a current successor or enlarge an issued contract.
The resume invocation authorizes continuous scheduler-owned progress. Drive every returned
transition, wait, review, replan, remediation, gate, and configured shipping action to a terminal
result without asking the user to say continue. Yield only for completion, a terminal block, or
input that would change the requested outcome.
When a dispatch remains active, wait through the host's native agent primitive. Follow returned
`required_control_action` before interpreting a generic continuation label: retrying an identical
attested receipt does not require another worker validation. Use `expire-dispatch` only for an
explicitly authorized orphaned or wedged flight, with the exact pending ticket ID and a non-empty
audit reason grounded in that authorization.

Accept the runtime's current lane, model policy, retry count, remediation state, and gate state.
Do not redo stages, free-hand transitions, or edit files from the parent session.
