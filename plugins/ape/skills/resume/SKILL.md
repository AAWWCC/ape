---
name: resume
description: "Resume an APE task from a live execution, blocked run, checkpoint, or explicitly selected legacy work."
---

# APE resume

Use only when the user explicitly asks to resume APE. Call `ape_run` with `action: "resume"` and
continue from the returned machine state; never reconstruct completed work or pending tickets from
conversation memory.
Pass the governed project root as `project_dir` on every APE MCP call. Inspect `recovery_plan`
and follow the returned action. Discovery preserves files and does not start workers:

- `confirm_recovery`: review the exact source task, blocker, and runtime decision. Under this
  explicit resume invocation, call `resume` with the returned `expected_recovery_digest` and
  `explicit_invocation: true`. Keep any selected `legacy_candidate_id`, `legacy_run_id`, or
  `recovery_context` unchanged. Do not ask separately for a reset. The runtime chooses an eligible
  same-run gate retry, reconciles the existing shipment, or checkpoints and retires the blocked
  execution for fresh validation. A changed digest requires rediscovery; never reuse a stale plan.
- `choose_recovery`: show task objectives, source kinds, branches/stashes, dates, and blockers.
  Ask the user to select the source and associate it with a listed saved task (`legacy_run_id`),
  or supply its missing objective and scope in `recovery_context`. Select only the returned
  `legacy_candidate_id`; rediscover with that selection before confirming its digest. Never apply
  or combine stashes yourself, guess task ownership from names, or import external backups.
- `provide_recovery_context`: obtain the missing objective, mode, lane, host, claimed paths and
  test paths for the selected source, then rediscover. The runtime records user-confirmed legacy
  provenance without inventing an earlier run or validation evidence.
- `inspect_recovery`: follow the concrete reason. Preserve unresolved workers/gates and newer
  edits. An intentional auto-merge hold remains held until an explicit ship request. Uncertain
  shipping must reconcile the existing pull request before creating a replacement execution.

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
  saved input there and include the record's `checkpoint_id` and, if present, `source_run_id` as
  `supersedes_run`. Start uses the restored recovery branch itself.
  Never reuse old tickets, receipts, permissions or test results.

An explicit resume invocation authorizes the returned blocked-run recovery, checkpoint restoration
and fresh validated run, including configured shipping, without another continuation approval.
`explicit_invocation` is the orchestrator's attestation, not authenticated human provenance.
It does not authorize overwriting newer work or choosing between different tasks.
On a recovery conflict or changed working files, preserve both versions and report the concrete
decision needed. If no active run or checkpoint exists, say so; never reconstruct files from memory.

Follow [`references/run-resume-protocol.md`](references/run-resume-protocol.md) for dispatch,
receipt recording, waiting, and advancement, including `redispatch_same_ticket` and
`capability_recovery`. Use only the runtime-returned replacement or successor and follow its
frozen contract. Follow `required_control_action` before a generic continuation label:
recording an identical attested receipt does not require another worker validation.

Drive the recovered execution through every returned transition and configured shipping action
to its next terminal result without asking the user to say continue. A new terminal block ends
this invocation; do not create another execution without a new explicit resume request. Yield
earlier only for input that would change the requested outcome. Completion can leave separately
reported branch cleanup pending; report retained branches and reasons. Checkpoint refs remain.

During the invocation, accept the runtime's lane, model policy, recovery decisions, and gate state;
stage workers own file edits. Do not redo completed stages or invent transitions. After the
invocation ends, follow the user's next request under the protocol's scope boundary.
