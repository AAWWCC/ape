# Configuration

APE stores project overrides in `.ape/runtime/config.json` and merges them over shipped defaults at
load time. Use `ape_config`; do not hand-edit runtime state.

Common actions:

- `get`: return the effective configuration.
- `set`: validate and store one dotted key.
- `init`: inspect project manifests and propose test commands; `apply: true` persists an approved
  proposal.
- `doctor`: check git, state, locks, configuration, bundles, host preconditions, and known external
  editor declarations.
- `wire` / `unwire`: opt a host statusline in or out.

<!-- BEGIN GENERATED CONFIG REFERENCE -->
## Complete key reference

`DEFAULT_CONFIG` in `lib/runtime/config.js` is the source of truth. This generated table is
checked byte-for-byte by `npm run docs:check`.

| Key | Type | Default | Purpose |
| --- | --- | --- | --- |
| `version` | number | `2` | Runtime-owned schema version; cannot be set. |
| `shipping.auto_merge` | boolean | `false` | Hold green work for an explicit audited `ship`; opt in to automatic merging. |
| `shipping.provider` | string | `"github"` | Shipping provider; GitHub is the only implementation. |
| `shipping.required_remote_checks` | boolean | `true` | Require remote CI; set `false` only for repositories intentionally without CI. |
| `policy.fast_max_files` | number | `6` | Maximum production-file scope for the fast lane. |
| `policy.high_risk_security_review` | boolean | `true` | Add security review when a risk trigger is armed. |
| `policy.full_suite_cache` | boolean | `true` | Reuse passing suites for the same tree and resolved command. |
| `policy.evidence_scripts` | string array | `[]` | Extra exact package scripts a read-only agent may run as evidence. |
| `policy.command_profiles` | object array | `[]` | Exact operator-attested external-engine commands. |
| `deadlines_ms.mechanical` | number | `900000` | Mechanical stage/suite deadline (15 minutes). |
| `deadlines_ms.fast` | number | `1800000` | Fast stage/suite deadline (30 minutes). |
| `deadlines_ms.full` | number | `3600000` | Full stage/suite deadline (60 minutes). |
| `models.claude.fast.model` | string | `"haiku"` | Claude fast-tier model. |
| `models.claude.balanced.model` | string | `"sonnet"` | Claude balanced-tier model. |
| `models.claude.deep.model` | string | `"opus"` | Claude deep-tier model. |
| `models.codex.fast.model` | string | `"gpt-5.4-mini"` | Codex fast-tier model. |
| `models.codex.fast.reasoning_effort` | string | `"low"` | Codex fast-tier reasoning effort. |
| `models.codex.balanced.model` | string | `"gpt-5.5"` | Codex balanced-tier model. |
| `models.codex.balanced.reasoning_effort` | string | `"medium"` | Codex balanced-tier reasoning effort. |
| `models.codex.deep.model` | string | `"gpt-5.5"` | Codex deep-tier model. |
| `models.codex.deep.reasoning_effort` | string | `"high"` | Codex deep-tier reasoning effort. |
| `models.gemini.fast.model` | string | `"flash"` | Gemini fast-tier model. |
| `models.gemini.balanced.model` | string | `"flash"` | Gemini balanced-tier model. |
| `models.gemini.deep.model` | string | `"pro"` | Gemini deep-tier model. |
| `role_models.security_reviewer.claude.model` | string | `"opus"` | Per-role override, evaluated before the tier mapping. |
| `verification.profiles` | object array | `[]` | Unique exact shell-free profile commands snapshotted at start and assigned as fail-closed merge gates. |
| `test_commands.targeted` | string or null | `null` | Runtime-owned targeted merge-gate command. |
| `test_commands.targeted_template` | string or null | `null` | Red-admission template; `{paths}` expands to authored test files. |
| `test_commands.targeted_shuffle_template` | string or null | `null` | Optional full template for the second, order-varied red-admission run. |
| `test_commands.shuffle` | string or null | `null` | Tokens appended to the second red-admission run when no shuffle template is set. |
| `test_commands.impacted_template` | string or null | `null` | Local impacted-suite template; `{paths}` expands to changed files. |
| `test_commands.full` | string or null | `null` | Full local merge-gate suite. |
| `test_commands.full_serial` | string or null | `null` | Full-suite command used on re-gate to avoid parallelism flakes. |
| `test_commands.serialize` | string or null | `null` | Tokens appended to `full` on re-gate when `full_serial` is unset. |
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
| `notifications.larp.files` | object | `{}` | Per-event operator-owned sound-file overrides. |
| `statusline.refresh_interval_seconds` | number | `5` | Claude command-statusline refresh interval. |
| `runners` | object array | `[]` | Optional polyglot runner ownership and command profiles. |
<!-- END GENERATED CONFIG REFERENCE -->

The statusline's progress estimate is local and history-calibrated: it samples receipt timings from
at most the newest 20 immutable history files, combines them with the active run, and caches only
validated numeric samples under `.ape/runtime/statusline-cache.json`. This behavior requires no
telemetry endpoint and is independent of `ape_history metrics`, whose bounded coverage is described
in [MCP tools](mcp-tools.md#history-observability-and-metrics).

## Test commands

Run `ape_config init` first. It recognizes common JavaScript, Python, Go, Rust, Ruby, Maven,
Gradle, and `script/test` layouts and proposes only commands grounded in project files. The proposal
is not applied unless the operator approves it.

Important rules:

- Behavioral runs require non-empty `test_paths`.
- Red admission runs the authored tests twice. Without a shuffle template/modifier, both runs are
  identical.
- `targeted_template` must contain `{paths}`. Runners that cannot select test files by path need a
  wrapper that maps paths to the runner's native selectors; APE never substitutes a whole-suite
  failure for proof that the authored test is red.
- `impacted_template` may replace the local full suite only when remote checks are required, so
  remote CI remains the true full gate. Re-gate and `ship` always use the full suite. Invalid or
  empty impacted input falls back to full.
- `full_serial` takes precedence over `serialize`. `targeted_shuffle_template` takes precedence
  over `shuffle`.
- Configured commands are tokenized and spawned without a general shell. Do not rely on shell
  expansion, redirection, chaining, or environment-variable interpolation.

For monorepos, set `runners` to objects with a unique `id`, an `owns` glob list, a project-relative
`root`, and a `profile` containing the same test-command slots. Leading `!` ownership globs exclude
subtrees. A path belongs to every matching runner (union ownership); a path matched by none is an
orphan and fails closed.

## Shipping and recovery

`shipping.auto_merge: false` is produce-and-hold. Green work blocks at merge with
`auto-merge is disabled by configuration`; the audited `ship` action re-proves every gate against
the current tree and merges only on green. A failed proof moves back to the ordinary gate-block /
`regate` path.

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

APE performs cheap deterministic checks before launching the configured suite. The suite runs in a
detached process and either finishes during `gates.inline_grace_ms` or leaves the run in `gating`.
Call `ape_run next` to poll, optionally with `wait_ms` for a bounded server-side wait. Heartbeats,
PID fencing, tree rechecks, and the spawn budget prevent a stale result from being treated as a
pass. Re-gate always executes a fresh full suite.

## Statusline

Pass `host` explicitly to `wire` and `unwire`.

- Claude: installs the command-backed APE powerline renderer and backs up the previous settings.
  It shows model, directory, branch, APE mode/lane, stage, milestones, progress, and context use.
- Codex: writes the closest native `[tui].status_line` using model, directory, branch,
  `task-progress`, and context. Codex currently exposes built-in items only, so the response reports
  `renderer: "codex-native"` and `custom_renderer: false` rather than claiming APE's custom
  renderer is active.

`unwire` restores only values owned by APE and refuses to overwrite later user edits.

## LARP MODE

LARP MODE is a fail-open notification layer. It is off by default and supports BOOT, ASK, STOP,
SUBAGENT, ERROR, PLAN, BUILD, and SHIP cues on both hosts. Codex has no generic
`PostToolUseFailure` event, so arbitrary non-APE tool failures play ERROR only on Claude; an APE run
that positively reports failure can play it on either host.

Environment variables override config: `LARP_MODE`, `LARP_<EVENT>`, and
`LARP_FILE_<EVENT>`. File selection is environment, then config, then an optional package-local
`assets/sounds/manifest.json`. Public packages omit `assets`; with no configured file the event is
silent. The package manifest is the closed object
`{ "version": 1, "files": { "boot|ask|stop|subagent|error|plan|build|ship": "relative path" } }`:
only the named event keys are accepted, entries resolve from the manifest directory, and lexical
plus realpath containment is required. An absent or invalid manifest, an absolute/traversing path,
a symlink escape, a missing file, or a missing player is silent and never blocks policy or a run.

## Windows hosts

Windows is supported. APE launches `.mjs` entry points through Node, terminates timed-out process
trees with `taskkill`, and retries transient atomic-replace failures. Pin line endings in the target
repository with `.gitattributes` to avoid host-wide LF/CRLF rewrites. Batch launchers run through
`cmd.exe`; `%VAR%` expansion in `test_commands.*` is neutralized on that `.cmd`/`.bat` or bare-shim
path so the value reaches the child literally. Machine-enabled delayed `!VAR!` substitution remains
a documented host precondition, so do not put it in configured commands or paths.

## Override provenance

`set` keeps the file sparse and records explicitly chosen keys in runtime-owned `explicit_keys`.
This preserves a deliberate value even when it equals today's default. `doctor` reports old
materialized defaults whose intent is ambiguous; re-set the value to claim it or set the current
default to drop it. `version` and `explicit_keys` cannot be set directly.

# Verification profiles

`verification.profiles` is a bounded list of unique profile ids with a description, exact shell-free
command argv, optional contained project-relative root, and timeout. The runtime snapshots profiles
at run start; later live config changes cannot alter that run's obligations. Every required profile
must be assigned by the v2 plan and executes as a fail-closed merge gate.
