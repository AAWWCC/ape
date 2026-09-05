---
name: override
description: "Abort or reset APE state with a mandatory audit reason."
---

# APE override

Use only when the user explicitly requests an abort or reset. Require a non-empty audit reason
grounded in that request; ask only if it is unclear, without asking again for an approved action.
Pass the governed project root as `project_dir` on both the status check and override call.

Call `ape_run` with `action: "override"`, operation `abort` or `reset`, the reason, and an optional
run-ID confirmation. After a conversational gap or when the user names a run, call
`ape_status` first and pass the returned `run_id`; a mismatch must fail closed. Do not invent a
run ID or retry an aimed operation as unaimed without user direction.

`reset` is valid only for terminal or blocked runs, or runtime-diagnosed corrupt/orphaned state.
If exact aiming is impossible, explain the diagnostic; an unaimed reset needs direction covering
that recovery, which may already be present in the user's request.
For a running orphaned dispatch, `expire-dispatch` requires explicit authorization, its ticket ID,
and an audit reason. For an automatic-merge-disabled hold, `ship` requires explicit shipping
authorization and an audit reason; an abort/reset request does not authorize either substitute.
Override never makes evidence green, bypasses receipt
validation, skips tests, or bypasses merge gates.
