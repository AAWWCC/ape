---
name: history
description: "Query, explain, aggregate, import, or explicitly maintain APE machine history."
---

# APE history

Use only when the user explicitly requests APE history work. Pass the governed project root as
`project_dir`. Call `ape_history` with:

- `query` for a run or requirement ID.
- `explain` for a bounded, privacy-safe explanation of one record.
- `metrics` for aggregate outcomes, with supported time, lane, mode, host, or version filters.
  Distinguish observed token counters from unobserved usage; never estimate missing counters.
- `import` for an explicitly requested legacy planning import.
- `maintenance-status` to read the latest retention outcome.
- `compact-artifacts` only after an explicit maintenance request. Pass a non-empty audit `reason`
  grounded in that request; ask only if the reason is unclear. Optional `keep_recent_runs` defaults
  to 32 and `max_runs` to 64 (maximum 256).

Never describe compaction as deleting immutable history: it verifies an archive before removing
only redundant source artifacts and preserves audit logs, prepared transactions, and active or
sealed runs. Set `delete_legacy: true` only when the user explicitly asks to delete eligible legacy
machine documents. Report every warning and any bounded/truncated response honestly.
