# Skills

APE provides the same seven skills in Claude Code and Codex.

| Skill | What it does |
| --- | --- |
| `run` | Establish scope, then start and advance a run. |
| `status` | Show the active run and optional roadmap. |
| `resume` | Resume a task from a live or blocked run, checkpoint, or explicitly selected legacy work, with fresh validation when needed. |
| `history` | Search or explain past runs; import history or compact artifacts. |
| `config` | Read or change settings, check setup, detect test commands, or configure a statusline. |
| `override` | Abort or reset a run with an audit reason. |
| `roadmap` | View, register, or supersede roadmap entries. |

## Invocation

Use `/ape:<skill>`, for example `/ape:run Fix the checkout validation`.
Argument hints such as `[--lane …]` and `[--mode …]` help gather input; they do not
bypass validation.

Only `status` may be selected automatically. The other six skills require explicit
invocation, including `history` and `roadmap`, which also offer state-changing
actions. Their host metadata disables implicit invocation. An explicit run or
resume authorizes its scheduler-owned stages and configured shipping. Ask only
for unresolved choices or actions outside that scope; keep validation and any
intentional shipping hold in place.

These skills govern the requested APE invocation. They do not make APE mandatory
for ordinary repository work or extend worker restrictions to separately requested
maintenance after an invocation ends. Repository instruction files are optional;
APE supplies its own runtime guidance.

## Run intake

APE reads what it can from the repository, then asks for missing decisions.
For a new project, this can include stack, storage, or deployment choices.
It may propose roadmap entries when the objective spans several runs, but does
not register them without approval.

Choose the contract that matches the work:

- Behavioral fast/full phase work needs `test_paths`, defaults to `red-first`,
  and the run skill selects plan contract v2 for new starts. Historical runs retain
  their admitted contract.
- Use `green-maintenance` for green-on-arrival regression coverage or deflaking.
- Pure data or baseline work is non-behavioral: contract v1, no test writer.
  Larger non-behavioral work can still use fast/full lanes.
- `land` accepts committed feature work plus dirty finishing edits only when HEAD
  descends from the resolved default tip and the entire diff is claimed.

## Roadmap

The roadmap tracks work and dependencies; it does not start or sequence runs.
Roadmap-backed runs can start or complete only when their prerequisites are
satisfied. Status comes from active state, requirements, and saved history.

Workers can propose `evidence.roadmap_followups` in a receipt. Registration needs
authorization for those entries and an exact match to the accepted receipt;
receipt acceptance alone does not register them. Reuse an existing request that
already covers those entries.
See [roadmap actions](mcp-tools.md#roadmap-verbs).
