---
name: resume
description: "Resume an interrupted APE run or recover checkpointed unfinished work into a fresh validated run."
disable-model-invocation: true
---

# APE resume

Use only when the user explicitly asks to resume APE. Call `ape_run` with `action: "resume"` and
continue from the returned machine state; never reconstruct completed work or pending tickets from
conversation memory.
Pass the governed project root as `project_dir` on every APE MCP call. When no active run remains,
follow checkpoint discovery instead of treating unfinished work as missing:

- `recover_checkpoint`: the runtime found one available checkpoint. Call `resume` again with
  its exact `checkpoint_id` and `explicit_invocation: true`.
- `choose_checkpoint`: show the returned objectives, branches, and dates and ask which work to
  recover. Do not guess when several checkpoints exist or storage is incomplete/unreadable.
- `start_recovered_work`: files are restored on a new branch and reconciled with the locally
  resolved default branch. Read the saved failure reason as evidence, inspect what remains to
  be done, and address the original blocker. Use the returned `start_input` as the basis of a
  fresh preview, keeping `checkpoint_id` and `supersedes_run`. Re-establish the current host,
  hooks, capabilities and runner configuration, review complete scope and admission, and perform
  the normal binding probe and start. If the response carries `start_input_ref`, read the complete
  saved input there and include the record's `checkpoint_id` and `source_run_id` as `supersedes_run`.
  Never reuse old tickets, receipts, permissions or test results.

An explicit resume invocation authorizes checkpoint restoration and this fresh validated run,
including configured shipping, without another continuation approval. It does not authorize
resetting an existing blocked run, overwriting newer work, or choosing between different tasks.
On a recovery conflict or changed working files, preserve both versions and report the concrete
decision needed. If no active run or checkpoint exists, say so; never reconstruct files from memory.

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
