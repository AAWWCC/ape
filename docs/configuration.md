# Configuration

Use `ape_config` to configure a project. APE stores overrides in `.ape/runtime/config.json`
and merges them over shipped defaults. Do not hand-edit runtime state.

| Action | What it does |
| --- | --- |
| `get` | Shows the effective configuration. |
| `set` | Validates and stores one dotted key. |
| `init` | Inspects project files and proposes test commands and evidence scripts. |
| `doctor` | Checks Git, state, locks, config, bundles, host prerequisites, and recognized project types. |
| `wire` / `unwire` | Enables or removes the host statusline integration. |

MCP discovery and permissions belong to the host, not APE. Initialization does not create or edit
repository instruction files.

<!-- BEGIN GENERATED CONFIG REFERENCE -->
## Complete key reference

`DEFAULT_CONFIG` in `lib/runtime/config.js` is the source of truth. This generated table is
checked byte-for-byte by `npm run docs:check`.

| Key | Type | Default | Purpose |
| --- | --- | --- | --- |
| `version` | number | `2` | Runtime-owned schema version; cannot be set. |
| `shipping.auto_merge` | boolean | `false` | Hold passing work for an audited `ship`; set `true` to merge automatically. |
| `shipping.provider` | string | `"github"` | Shipping provider; GitHub is the only implementation. |
| `shipping.required_remote_checks` | boolean | `true` | Require remote CI; use `false` only for a project intentionally without CI. |
| `shipping.target` | object or null | `null` | Explicit `{origin, repository, base}`, frozen at admission. Required for shipping; the canonical APE checkout can target only AAWWCC/ape. |
| `policy.fast_max_files` | number | `6` | Maximum production-file scope for the fast lane. |
| `policy.high_risk_security_review` | boolean | `true` | Add security review when a risk trigger is armed. |
| `policy.design_assurance_required` | boolean | `true` | Require a feasibility check and executable evidence for each declared risk. |
| `policy.max_remediation_cycles` | number | `3` | Maximum remediation cycles; repeated or non-shrinking blockers stop sooner. |
| `policy.full_suite_cache` | boolean | `true` | Reuse passing suites for the same tree and resolved command. |
| `policy.evidence_scripts` | string array | `[]` | Exact extra package scripts allowed as read-only evidence. |
| `policy.command_profiles` | object array | `[]` | Exact external-tool commands approved by the operator. |
| `deadlines_ms.mechanical` | number | `900000` | Mechanical stage/suite deadline (15 minutes). |
| `deadlines_ms.fast` | number | `1800000` | Fast stage/suite deadline (30 minutes). |
| `deadlines_ms.full` | number | `3600000` | Full stage/suite deadline (60 minutes). |
| `deadlines_ms.debug` | number | `900000` | Read-only debug deadline (15 minutes), independent of lane. |
| `deadlines_ms.spike` | number | `900000` | Read-only spike deadline (15 minutes), independent of lane. |
| `models.claude.fast.model` | string | `"haiku"` | Claude fast-tier model. |
| `models.claude.balanced.model` | string | `"sonnet"` | Claude balanced-tier model. |
| `models.claude.deep.model` | string | `"opus"` | Claude deep-tier model. |
| `models.codex.fast.model` | string | `"gpt-5.4-mini"` | Codex fast-tier model. |
| `models.codex.fast.reasoning_effort` | string | `"low"` | Codex fast-tier reasoning effort. |
| `models.codex.balanced.model` | string | `"gpt-5.5"` | Codex balanced-tier model. |
| `models.codex.balanced.reasoning_effort` | string | `"medium"` | Codex balanced-tier reasoning effort. |
| `models.codex.deep.model` | string | `"gpt-5.5"` | Codex deep-tier model. |
| `models.codex.deep.reasoning_effort` | string | `"high"` | Codex deep-tier reasoning effort. |
| `role_models.security_reviewer.claude.model` | string | `"opus"` | Role override, applied before the tier default. |
| `verification.profiles` | object array | `[]` | Unique shell-free verification commands frozen at start and required as assigned merge gates. |
| `test_commands.targeted` | string or null | `null` | Runtime-owned targeted merge-gate command. |
| `test_commands.targeted_template` | string or null | `null` | Admission command template; `{paths}` expands to authored test files. |
| `test_commands.targeted_shuffle_template` | string or null | `null` | Optional full command template for the second, order-varied admission run. |
| `test_commands.shuffle` | string or null | `null` | Tokens added to the second admission run when no shuffle template is set. |
| `test_commands.impacted_template` | string or null | `null` | Local impacted-suite template; `{paths}` expands to changed files. |
| `test_commands.full` | string or null | `null` | Full local merge-gate test suite. |
| `test_commands.full_serial` | string or null | `null` | Full-suite command for re-gate, used to avoid parallelism flakes. |
| `test_commands.serialize` | string or null | `null` | Tokens added to `full` on re-gate when `full_serial` is unset. |
| `gates.inline_grace_ms` | number | `300000` | Time allowed for a detached suite to finish before returning `gating`. |
| `gates.heartbeat_ms` | number | `5000` | Detached runner heartbeat interval. |
| `gates.stale_ms` | number | `30000` | Age at which a heartbeat may be treated as stale. |
| `gates.max_spawns` | number | `2` | Initial detached runner plus bounded respawns. |
| `gates.poll_retry_delay_ms` | number | `5000` | Suggested delay before polling a pending watch again. |
| `notifications.larp.enabled` | boolean | `false` | Master switch for notification sounds. |
| `notifications.larp.events.boot` | boolean | `true` | Session-start cue. |
| `notifications.larp.events.ask` | boolean | `true` | Question cue (`AskUserQuestion` or Codex `request_user_input`). |
| `notifications.larp.events.stop` | boolean | `true` | Main-session stop cue. |
| `notifications.larp.events.subagent` | boolean | `false` | Subagent-stop cue. |
| `notifications.larp.events.error` | boolean | `true` | APE failure cue (plus generic Claude tool failures). |
| `notifications.larp.events.plan` | boolean | `true` | Passed planning outcome cue. |
| `notifications.larp.events.build` | boolean | `true` | Passed build outcome cue. |
| `notifications.larp.events.ship` | boolean | `true` | Completed run cue. |
| `notifications.larp.files` | object | `{}` | Per-event sound files chosen by the operator. |
| `statusline.refresh_interval_seconds` | number | `5` | Claude command-statusline refresh interval. |
| `runners` | object array | `[]` | Optional per-project test runners, path ownership, and commands. |
<!-- END GENERATED CONFIG REFERENCE -->

## Test commands

Start with `ape_config init`. It recognizes common JavaScript, Python, Go, Rust, Ruby, Maven,
Gradle, and `script/test` layouts. It proposes commands supported by files it finds.

Standalone init only proposes changes unless called with `apply:true`. During an explicit APE
run, the parent applies a complete proposal that fills required empty slots.

For a blank repository containing only Git/APE state and conventional metadata, supply the run's
exact `behavioral` and `test_paths`. A single JavaScript/TypeScript or Python extension family
can use dependency-free `node --test` or `python -m unittest`. Mixed or unsupported extensions
need an explicit toolchain choice. For a clean unborn Git repository, start creates an empty root
commit under the run lock before creating the run branch.

### Command rules

- Behavioral runs need non-empty `test_paths`.
- Red admission runs authored tests twice. Without a shuffle template or modifier, the commands
  are identical.
- `targeted_template` must contain `{paths}`. If a runner cannot select files, provide a wrapper
  that maps paths to its selectors. A whole-suite failure does not prove the authored tests fail.
- `impacted_template` may replace the local full suite only when remote checks are required.
  Invalid or empty impacted input falls back to full. Re-gate and `ship` always use the full suite.
- `full_serial` overrides `serialize`; `targeted_shuffle_template` overrides `shuffle`.
- Commands run without a general shell. Do not use shell expansion, redirection, chaining, or
  environment-variable interpolation.
- Verification commands and write-producing commands are different. Declare generated outputs
  and include them in the writer's approved scope. Read-only workers remain read-only; declarations
  do not replace runtime checks of command results and filesystem effects.

### Monorepos

Each `runners` entry needs a unique `id`, an `owns` glob list, a project-relative `root`,
and a `profile` with the test-command slots above. Leading `!` globs exclude subtrees.
A path belongs to every matching runner. A path matching none is rejected as an orphan.

### Runtime instructions

APE injects versioned guidance through the synchronous `SessionStart` hook on startup, resume,
clear, and compaction. Run-state results from `ape_run` refresh it with the active contract and
next safe action. Hooks and the scheduler enforce policy; immutable tickets hold worker contracts.

`AGENTS.md`, `AGENTS.override.md`, `CLAUDE.md`, and equivalents remain repository-owned.
APE never inserts its operational policy into them.

## Shipping and recovery

Set an explicit target before preview, for example:

```json
{
  "origin": "https://github.com/OWNER/PROJECT.git",
  "repository": "OWNER/PROJECT",
  "base": "main"
}
```

Store this object as `shipping.target`. Admission freezes it. Remote or configuration drift
requires a new reviewed admission; it cannot retarget a running job. The canonical APE checkout
can target only `AAWWCC/ape`. Other projects need their own explicit target.

| Setting | Result |
| --- | --- |
| `shipping.auto_merge: false` | Passing work is held at merge with `auto-merge is disabled by configuration`. |
| `shipping.auto_merge: true` | An explicit APE run authorizes scheduler-owned shipping for that run. |

An audited `ship` rechecks every gate against the current tree and merges only on green. A
failed check returns to the gate-block/`regate` path. Callers normally omit the legacy
`auto_merge_authorized` field; changing config after start cannot grant shipping authority.
Legacy records remain readable without gaining that authority.

A roadmap requirement may close against the exact verified hold only with a reason-audited
`roadmap-attest`. An unattested hold, or any other blocked state, does not satisfy it.

Protected merges may need GitHub's auto-merge path. APE stays in `shipping` until it observes the
exact pushed head merged. Queued merges need proven up-to-date required checks or a qualifying
merge queue. Configured signing must be resolved explicitly; APE does not retry unsigned.

Local cleanup is recorded separately after remote completion. `ape_run resume` can retry
eligible cleanup, such as a base branch held by another worktree. For other failures, follow the
current recovery descriptor and its prerequisites; never automatically reset unexplained edits.

<!-- BEGIN GENERATED LANE REFERENCE -->
## Generated lane classifier reference

Accepted requested lanes: `auto`, `mechanical`, `fast`, `full`.

| Representative input | Requested | Classified | Runtime reasons |
| --- | --- | --- | --- |
| Non-behavioral documentation | `auto` | `mechanical` | `non-behavioral-mechanical-scope` |
| Bounded behavioral source | `auto` | `fast` | `bounded-behavioral-scope` |
| Behavioral scope above fast limit | `auto` | `full` | `scope-over-6-files` |
| Explicit mechanical with behavioral source | `mechanical` | `fast` | `requested-mechanical-escalated`, `behavioral-change`, `non-mechanical-scope` |
| Explicit fast above file limit | `fast` | `full` | `requested-fast-escalated`, `scope-over-6-files` |
| Explicit full | `full` | `full` | `requested-full` |
| Auto mechanical scope with recognized risk | `auto` | `mechanical` | `non-behavioral-mechanical-scope`, `risk:security` |

Canonical start-time `risk_triggers` are:

- `security`
- `authentication`
- `migration`
- `dependency`
- `public-api`
- `schema`
- `concurrency`
- `destructive-operation`

Unknown triggers are rejected. A recognized trigger normally selects the full lane and arms
security review; auto-classified non-behavioral mechanical scope remains mechanical while
retaining the risk trigger and conditional review.
<!-- END GENERATED LANE REFERENCE -->

## Gate watches

APE runs cheap checks before the configured suite. The suite runs in a detached process. If it
outlasts `gates.inline_grace_ms`, the run stays in `gating`.

Poll with `ape_run next`, optionally using `wait_ms` for a bounded wait. Heartbeats, process
identity checks, tree rechecks, and spawn limits prevent stale results from passing. Re-gate
always runs a fresh full suite.

## Statusline

Pass `host` explicitly to `wire` and `unwire`.

- Claude gets APE's command-backed renderer: model, directory, branch, mode/lane, stage,
  milestones, progress, and context use. Existing settings are backed up.
- Codex gets native `[tui].status_line` items: model, directory, branch, `task-progress`,
  and context. It does not support APE's custom renderer; the response says
  `renderer: "codex-native"` and `custom_renderer: false`.

`unwire` restores only APE-owned values and refuses to overwrite later user edits.

Progress estimates use receipt timings from at most the newest 20 history files plus the active
run. Valid numeric samples are cached locally in `.ape/runtime/statusline-cache.json`; there
is no telemetry endpoint. This is separate from [history metrics](mcp-tools.md#history-observability-and-metrics).

## LARP MODE

LARP MODE adds notification sounds. It is off by default, and sound failures never block a run.
Both hosts support BOOT, ASK, STOP, SUBAGENT, ERROR, PLAN, BUILD, and SHIP. Generic tool failures
trigger ERROR only on Claude; explicit APE failures can trigger it on either host.

Environment variables override config: `LARP_MODE`, `LARP_<EVENT>`, and `LARP_FILE_<EVENT>`.
Sound selection is environment → config → optional `assets/sounds/manifest.json`. Public
packages contain no assets, so an unconfigured event is silent.

The optional manifest has this closed shape:

```json
{
  "version": 1,
  "files": {
    "boot": "relative/path.wav"
  }
}
```

Allowed file keys are `boot`, `ask`, `stop`, `subagent`, `error`, `plan`, `build`,
and `ship`. Paths resolve inside the manifest directory, checked both lexically and by realpath.
Invalid manifests, absolute/traversing paths, symlink escapes, missing files, and missing players
all produce silence.

## Windows hosts

APE runs `.mjs` entry points through Node, ends timed-out process trees with `taskkill`, and
retries transient atomic-replace failures. Set repository line endings in `.gitattributes` to
avoid broad LF/CRLF changes.

Batch launchers use `cmd.exe`. APE neutralizes `%VAR%` expansion for `test_commands.*` on
`.cmd`, `.bat`, and bare-shim paths. Machine-enabled delayed `!VAR!` substitution remains a
host limitation: do not use it in configured commands or paths.

## Override provenance

`set` stores only overrides and tracks explicit choices in runtime-owned `explicit_keys`.
A deliberate value stays explicit even if it matches today's default.

`doctor` flags old copied defaults with unclear intent. Re-set the value to claim it, or set the
current default to drop it. Neither `version` nor `explicit_keys` can be set directly.

## Verification profiles

`verification.profiles` contains unique profile IDs, descriptions, exact shell-free command
argv, optional contained project-relative roots, and timeouts. A snapshot freezes the bounded
list at start; later live config changes cannot remove a run's verification obligations.
A v2 plan must assign every required profile. Each is a fail-closed merge gate:
the run cannot pass until the assigned profile succeeds.
