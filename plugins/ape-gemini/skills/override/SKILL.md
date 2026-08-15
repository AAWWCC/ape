---
name: override
description: "Abort or reset APE state with a mandatory audit reason."
---

# APE override

Use only when the user explicitly requests an abort or reset. Require a non-empty audit reason; ask
for it before calling when absent.

Call `ape_run` with `action: "override"`, operation `abort` or `reset`, the reason, and an optional
run-ID confirmation. After a conversational gap or when the user names a run, call
`ape_status` first and pass the returned `run_id`; a mismatch must fail closed. Do not invent a
run ID or retry an aimed operation as unaimed without user direction.

`reset` is valid only for terminal or blocked runs. For a running orphaned dispatch, use
`expire-dispatch` with its ticket ID and an audit reason. For a run held because automatic merge is
disabled, use `ship` with an audit reason. Override never makes evidence green, bypasses receipt
validation, skips tests, or bypasses merge gates.
