---
name: history
description: "Query, explain, import, inspect, or explicitly maintain APE machine history."
---

# APE history

Use only when the user explicitly requests APE history work. Call `ape_history` with:

- `query` for a run or requirement ID.
- `explain` for a human-readable rendering of one record.
- `import` for an explicitly requested legacy planning import.
- `maintenance-status` to read the latest retention outcome.
- `compact-artifacts` only after an explicit maintenance request. Pass the user's non-empty audit
  `reason`; optional `keep_recent_runs` defaults to 32 and `max_runs` to 64 (maximum 256).

Never describe compaction as deleting immutable history: it verifies an archive before removing
only redundant source artifacts and preserves audit logs, prepared transactions, and active or
sealed runs. Set `delete_legacy: true` only when the user explicitly asks to delete eligible legacy
machine documents. Report every warning and any bounded/truncated response honestly.
