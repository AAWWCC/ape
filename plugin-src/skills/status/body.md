# APE status

Call the dedicated read-only `ape_status` tool. This is the only APE skill that may be selected
implicitly. Do not dispatch agents, advance the run, mutate state, or reinterpret a blocked result.
On Google Antigravity / Gemini, pass the exact open project root as `project_dir`.

Render the current run, pending tickets or dispatches, lane, stage, gates, typed
`next_action.kind`, and `failure_domain` compactly. When present, show exact token-counter coverage
as observed versus unobserved; never turn missing host counters into an estimate. This distinction
is required when explaining whether time and tokens produced product progress or orchestration
repair. When roadmap data is present, show counts only; direct users who need entries to the
explicit `ape:roadmap` skill. Clearly label bounded prose as an excerpt, and do not repeatedly poll
an unchanged active dispatch. The deprecated 2.x `ape_run` status alias may remain for compatibility,
but new calls use `ape_status`.
