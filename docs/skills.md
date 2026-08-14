# Skills

APE packages the same seven skills for Claude Code and Codex:

| Skill | Behavior |
| --- | --- |
| `run` | Gather scope and start/advance a run. |
| `status` | Read the active run and optional roadmap projection. |
| `resume` | Continue an interrupted native-agent loop. |
| `history` | Query/explain history, import legacy history, and inspect or compact artifacts. |
| `config` | Get/set config, run doctor, initialize test commands, or wire/unwire statuslines. |
| `override` | Use audited abort, reset, or dispatch-expiry recovery. |
| `roadmap` | Inspect, register, or supersede optional roadmap entries. |

## Invocation

`run`, `resume`, `config`, and `override` declare `disable-model-invocation: true`. They start agents
or mutate state and therefore load only after an explicit `/ape:<skill>` invocation. `status`, the
read-only history paths, and roadmap views may be loaded when the host decides they are relevant;
their mutating actions still require the same runtime validation and explicit approval described by
the skill.

Argument hints such as `/ape:run [objective] [--lane …] [--mode …]` help intake but do not bypass
runtime validation.

## Run intake

For a greenfield project, `run` asks only for constraints the repository cannot answer and proposes
undetermined stack, storage, or deployment choices. If one objective clearly spans several runs and
the project has no roadmap, it may propose roadmap entries; registration still waits for operator
approval.

The roadmap is an optional audited ledger above the scheduler. It never starts or sequences runs,
but it gates roadmap-backed start and completion on satisfied prerequisites. Entry status is
derived from active state, requirements, and immutable history. A receipt can declare bounded
`evidence.roadmap_followups`; exact accepted-receipt provenance is required before a later,
separately approved registration can name the discovering run.
