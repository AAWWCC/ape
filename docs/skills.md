# Skills

APE provides the same seven skills in Claude Code and Codex.

| Skill | What it does |
| --- | --- |
| `run` | Confirm scope, then start and advance a run. |
| `status` | Show the active run and optional roadmap. |
| `resume` | Continue an interrupted run. |
| `history` | Search or explain past runs; import history or compact artifacts. |
| `config` | Read or change settings, check setup, detect test commands, or configure a statusline. |
| `override` | Abort, reset, or expire a dispatch with an audit reason. |
| `roadmap` | View, register, or supersede roadmap entries. |

## Invocation

Use `/ape:<skill>`, for example `/ape:run Fix the checkout validation`.
Argument hints such as `[--lane …]` and `[--mode …]` help gather input; they do not
bypass validation.

Only `status` may be selected automatically. The other six skills require explicit
invocation, including `history` and `roadmap`, which also offer state-changing
actions. Their host metadata disables implicit invocation. Invoking a skill does
not waive its approval or validation requirements.

## Run intake

APE reads what it can from the repository, then asks for missing decisions.
For a new project, this can include stack, storage, or deployment choices.
It may propose roadmap entries when the objective spans several runs, but does
not register them without approval.

Choose the contract that matches the work:

- Behavioral fast/full phase work needs `test_paths`, defaults to `red-first`,
  and may use plan contract v2.
- Use `green-maintenance` for green-on-arrival regression coverage or deflaking.
- Pure data or baseline work is non-behavioral: contract v1, no test writer.
  Larger non-behavioral work can still use fast/full lanes.
- `land` accepts committed feature work plus dirty finishing edits only when HEAD
  descends from the resolved default tip and the entire diff is claimed.

## Roadmap

The roadmap tracks work and dependencies; it does not start or sequence runs.
Roadmap-backed runs can start or complete only when their prerequisites are
satisfied. Status comes from active state, requirements, and saved history.

Workers can propose `evidence.roadmap_followups` in a receipt. Registering them
later still needs separate approval and an exact match to the accepted receipt.
See [roadmap actions](mcp-tools.md#roadmap-verbs).
