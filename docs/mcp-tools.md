# MCP tools

APE exposes five tools. Skills are the normal user interface; these actions are the
machine contract behind them.

| Tool | Actions |
| --- | --- |
| `ape_run` | `probe`, `probe-status`, `probe-ack`, `preview`, `start`, `next`, `record`, `recover-receipt`, `answer-preflight`, `status`, `resume`, `regate`, `ship`, `expire-dispatch`, `abort`, `override` |
| `ape_status` | Dedicated read-only current-run, pending-ticket, lane, and gate snapshot. |
| `ape_history` | `query`, `explain`, `metrics`, `import`, `maintenance-status`, `compact-artifacts`, `roadmap-status`, `roadmap-register`, `roadmap-supersede`, `roadmap-attest` |
| `ape_config` | `get`, `set`, `doctor`, `wire`, `unwire`, `init` |
| `ape_validate_receipt` | Validate and attest one bound worker's exact final receipt draft without advancing the run. |

Inputs are bounded at 64 KiB UTF-8. Responses use bounded summaries; full tickets, receipts, and
run records remain under `.ape/runtime/`.

## History observability and metrics

`ape_history explain` returns the effective immutable record plus a deterministic lifecycle
summary. Dispatch totals, retry counts, remediation routing, and recovery are derived from durable
tickets, receipts, supersession, and the minimal terminal provenance archived by the runtime.
Preflight input holds retain question IDs/counts only; operator answer text is not copied into the
summary provenance.

`ape_history metrics` aggregates effective terminal records with optional inclusive `since` and
`until` ISO timestamps and exact `lane`, `mode`, `host`, `status`, `ape_version`, `runtime_version`,
`host_plugin_version`, Codex `protocol_version` / `envelope_version`,
`terminal_reason_taxonomy_version`, and `terminal_reason_code` filters. Invalid timestamps, versions,
unknown enum values, and reversed ranges are refused. These exact cohort filters let operators compare
failure reasons and rates across releases without exposing receipt prose. Each call processes the newest
256 runs and returns `coverage.available_runs`, `processed_runs`, `limit`, and `truncated` so a bounded
sample is never presented as complete project history. Outcomes, rates, terminal-reason counts,
version cohorts, p50/p90/p95/p99 duration values, and legacy-unknown counts are computed only over the
processed records matching the filters. Codex protocol/envelope fields are reported as `not_applicable`
for Claude runs rather than as missing legacy telemetry. Each version-cohort map returns at most the
16 most populous cohorts and preserves exact coverage with `omitted_cohorts` and `omitted_runs`; use
an exact cohort filter to inspect an omitted version.

The `orchestration` metrics block reports first-pass receipt acceptance and first-pass-perfect run
rates, validation/correction/redispatch counts, time to first writer, and repair
time. Token totals are included only for host-attested exact counters. Coverage always separates
`token_dispatches`, `token_attested_dispatches`, and unobserved dispatches; APE never estimates a
missing token count.

`lineage_outcomes` collapses recovery history at every unsuperseded effective leaf: a predecessor with
multiple durable successors contributes each successor leaf, rather than causing the entire component
to disappear. Cohort filters apply to those leaves. Coverage separately discloses missing, invalid,
self-referential, branching, and cyclic supersession structure. A leaf whose ancestry enters a cycle
is cycle-tainted rather than trustworthy; cycle-core, tainted, and total omitted record counts are
explicit. `superseded_runs` counts distinct predecessor records, while `valid_supersession_links`
counts edges (so branching does not distort the run count). `terminal_reason_counts` classifies aborts by runtime-owned
terminal stage (dispatch, preflight, planning, test, implementation, review, gating, shipping, or investigation)
without inspecting operator prose. Terminal-reason taxonomy version 2 distinguishes a zero-cycle
`land_review_disagreement` from genuine `review_remediation_exhausted`; persisted version-1 codes
remain authoritative and version cohorts expose both generations without rewriting history.

The statusline already uses recent immutable receipt timings to calibrate its stage-duration bar.
It reads at most the newest 20 history files and caches validated samples under `.ape/runtime/`;
metrics calls do not mutate that cache or send telemetry anywhere.

## `ape_run`

### Start and advance

- `start` validates objective, host, mode, lane, path claims, test paths, requirements, risk, host
  capabilities, and explicit invocation before creating a branch or run. Behavioral fast/full runs
  require `test_paths` and default to `test_intent: "red-first"`. Explicit phase-only
  `"green-maintenance"` instead requires runtime-observed pass/pass and skips the ordinary
  implementer when `claimed_paths` is empty. Non-behavioral phase runs omit the test-writer stage;
  keep `behavioral:false` for pure data/baseline work. Explicit plan contract v2 is limited to
  behavioral fast/full phase runs. `land` additionally requires a
  non-empty default-tip-to-working-tree diff entirely inside `claimed_paths` and `test_paths`, with
  HEAD equal to or descended from the resolved default tip.
- `preview` uses the same readiness resolver and reports derived capability requirements and the
  pipeline's deterministic dispatch bounds plus the resolved ticket deadline before any run state
  is written. `debug`/`spike` may supply exact `run_command_profiles`; each is restricted to the
  matching read-only role with `effect: execute`, requires an operator-approved audit reason, and is
  frozen as a required capability. Do not set `operator_authorized: true` until the operator has
  approved the exact literal command; repository tree reconciliation does not make arbitrary code
  execution intrinsically safe.
- `record` accepts an agent receipt draft. The runtime adds and verifies identity, tree/test
  evidence, hashes, and the next transition. New-contract tickets
  also require a matching `ape_validate_receipt` attestation for the normalized exact draft.
- `recover-receipt` is an emergency operator-only admission for a native-bound receipt-contract
  ticket whose exact physical worker is host-observed as stopped without an attestation. Supply the
  unchanged `receipt`, the exact `receipt_input_hash` returned by the refused ordinary `record`, and
  a nonblank audit `reason`. The runtime still validates the one-time ticket/session/dispatch binding
  and every ordinary receipt contract; only the worker attestation is waived. It seals the exact
  draft and dispatch hashes plus the reason into the immutable receipt, completed dispatch intent,
  and `overrides.ndjson`. An already attested draft must use ordinary `record`.
- `next` advances one pending transition or polls a `gating`/`shipping` watch.
- `ape_status` is the canonical read-only status tool. The `ape_run` `status` action remains a
  deprecated compatibility alias. `resume` returns the action needed to continue an interrupted
  run.

`ok: false` is a runtime refusal and means the action changed nothing. A refused lever never hides
the error inside a successful `actions` array.

### Receipt validation and recovery

`ape_validate_receipt` is the only APE tool callable by a bound worker. It applies the same complete
role-specific mechanical contract used by `record`, including structured planning, profile IDs,
recognized evidence commands, and the 16,384-byte canonical candidate-plan ceiling. It returns
field-specific corrections plus used/maximum/remaining plan bytes. Call it with
`{ ticket_id, draft }`, where `ticket_id` exactly matches `draft.ticket_id` and `draft` is the complete
object that will later be placed in `ape_run record`'s `receipt` field. The 16,384-byte ceiling bounds
the immutable ticket/receipt artifact, MCP response projection, and worker model-context use; it is
not a content-quality judgment. A valid call binds the normalized
draft hash to that physical dispatch; changing the draft invalidates the attestation.
Candidate-plan usage is returned at
`budgets.candidate_plan_utf8_bytes.{used_bytes,max_bytes,remaining_bytes}`.

Every canonical and packaged Claude role names both supported exact host-qualified validators,
`mcp__ape__ape_validate_receipt` and
`mcp__plugin_ape_ape__ape_validate_receipt`, in addition to the external-MCP wildcard. The manual
release prerequisite in `docs/operational-readiness.md` launches each packaged role through the real
Claude host without overriding its tool allowlist, requires a linked validator tool call with an
exact role sentinel, and accepts only the APE service's expected no-active-run response. A prose
mention or a similarly named tool cannot pass.

Each physical worker receives an initial validation and two corrections. One fresh worker may then
be authorized on the same immutable ticket without consuming a stage attempt. A second exhaustion
blocks as `worker_protocol_failure`; it cannot vote in review or trigger product remediation,
directed replan, abort, or successor creation.

### Immutable run contract

Every newly created native receipt-contract run stores a compact `run_contract` pointer with
`{version, revision, ref, hash}`. The content-addressed manifest under `.ape/runtime/contracts/`
binds the run configuration/objective/preflight hashes, requested and available capability
catalogs, command and verification allowlists, recognized commands, field bounds, byte budgets,
and each ticket's role-filtered receipt contract. Role-specific JSON Schemas are retained as
content-addressed schema artifacts referenced by the manifest, so ticket compaction does not erase
the contract. Tickets carry the matching pointer; wire projections refer to it instead of repeating
the full catalog. Existing runs and historical ticket hashes are unchanged.

### Typed recovery status

Control responses use `next_action.kind` from this closed vocabulary:
`continue_same_agent`, `redispatch_same_ticket`, `stage_retry`, `directed_replan`,
`remediate_product_finding`, `wait`, `answer_preflight`, or `blocked`.
Failures use `failure_domain`: `product`, `orchestration`, `configuration`, `infrastructure`,
`operator`, or `unknown`. Protocol and infrastructure failures do not become reviewer dissent or
product remediation. A blocked response states `automatic_successor:false`; starting another run
always requires explicit operator authorization.

### Long-running calls

Final-stage `record`, `regate`, and `ship` run cheap gate checks first, then launch the configured
suite in a detached process. The call waits for `gates.inline_grace_ms`; if the suite is still live,
it returns with the run in `gating` instead of holding the tool call indefinitely.

`next` accepts optional `wait_ms` while a run rests in `gating` or `shipping`. It repeats the same
bounded poll with the receipt lock released between polls. The requested wait duration is clamped by
`GATE_NEXT_MAX_WAIT_MS` (300000 ms) and sleeps are floored by `GATE_NEXT_POLL_FLOOR_MS` (250 ms).
A gating watch that enters required-check `shipping` stops there; call `next` again to drive the
second watch.

Hosts that send `_meta.progressToken` receive a progress notification every ten seconds for a
long synchronous call. Native-agent flights use the host's agent wait primitive instead of status
polling. `SubagentStop` records observed termination; an elapsed deadline alone does not authorize a
duplicate physical agent.

`ship` and `regate` reject a run in the non-blocking watch states `gating` or `shipping` and point
to `ape_run next`, which is the action that advances those states. A gate-blocked run points to
`regate`; a green auto-merge hold points to `ship`.

A public/native `start` also treats shipping authority as run-scoped. If
`shipping.auto_merge` is true, the caller must obtain explicit operator authorization for that run
and send `auto_merge_authorized: true`; persistent configuration alone is not consent. Authorized
starts compare the local remote-tracking base with the server-advertised branch tip before creating
a run branch, and shipping repeats that check before its first Git mutation.

### Recovery actions

- `regate` re-runs a failed merge gate. The attempt budget is bounded.
- `ship` requires an audit reason and applies only to a green run held because
  `shipping.auto_merge` is false. It re-proves all gates against the current tree.
- `expire-dispatch` requires a pending `ticket_id` and audit reason. It voids a genuinely orphaned
  or wedged dispatch, consumes the attempt, and issues a fresh ticket when the retry budget permits.
- `abort` seals the current run. `override` supports reason-audited `abort` and `reset` operations;
  an unaimed reset can recover an orphaned lock.

Terminal `resume` also retries checkout reconciliation. Once an exact remote merge is proven, a
local worktree conflict is stored as retained cleanup guidance rather than changing the run back to
a shipping failure.

`abort` and `override` may include `run_id` as a confirmation, never as a selector. A mismatched or
explicitly null aim refuses before any effect. Other actions reject `run_id`. If `active.json` is
unreadable, use an unaimed `override reset`; the runtime cannot safely confirm an aimed recovery.

### Codex binding preflight

Codex `start` requires a fresh live capability proof:

1. `probe` returns `dispatch_probe` after ordinary doctor checks.
2. Spawn it with the returned task name, model, reasoning effort, and message unchanged. The
   returned type is APE's logical probe role, not a Multi-Agent V2 native argument.
3. PreToolUse consumes the visible task-name capability; `SubagentStart` must bind the host child and
   inject a probe capability.
4. `probe-status` must show a bound canary awaiting acknowledgement.
5. Send its `probe_id` and `probe_capability` to `probe-ack`; `start` atomically consumes the
   completed, single-use proof before its first Git mutation.

Manifest wiring is only a static package check; it does not prove that the current Codex session
delivers lifecycle events. Missing, expired, replayed, or observed-but-unbound probes fail as
infrastructure without creating a run or consuming a stage attempt. Claude uses its existing native
binding path and does not run this preflight.

### Behavioral plan preflight evidence

Plan contract v2 starts with a read-only preflight analyst on behavioral fast/full phase runs. Every
baseline entry in `evidence.preflight_artifact` must be backed by a receipt test entry with the same
command. `output_hash` may be omitted from both entries when the host does not expose enough raw
output to compute it; agents must never invent a digest. When a baseline hash is supplied, the
matching receipt hash is required and must be byte-for-byte identical.

### External MCP tools

New run starts do not advertise, require, persist, or enforce external-tool claims. Non-APE MCP
servers and operations pass through to the host's discovery, connection, permission, and approval
mechanisms without APE classification or interception. This includes providers added after the
installed APE version and operations whose names cannot be known when a run starts. Legacy claim
fields remain parseable only inside immutable historical tickets and manifests; they grant no
authority and are not part of the new run input contract.

APE still owns its own `ape_run`, `ape_status`, `ape_config`, `ape_history`, and
`ape_validate_receipt` boundaries. It also verifies the repository tree at agent and receipt
boundaries, so an external tool cannot make an out-of-scope project change valid merely because the
tool call itself passed through.

## Artifact maintenance

Terminal transitions keep recent run artifacts and perform bounded best-effort compaction of older
redundant snapshots. `maintenance-status` reads the last result without changing anything.

`compact-artifacts` requires an audit `reason`; `keep_recent_runs` defaults to 32 and `max_runs` to
64 (hard maximum 256). It writes and re-reads a byte-exact gzip archive before deleting only source
files whose bytes still match. Immutable history, audit logs, prepared transactions, changed data,
and the active/sealed run are never removed. A bad candidate is retained and reported without
stopping later candidates.

## Roadmap verbs

The optional roadmap is stored at `.ape/runtime/roadmap.json`. Its statuses are derived from the
store, requirements/history, and the active run. It does not schedule runs, but a live roadmap
target may start or complete only while every transitive dependency is `satisfied`; stale targets
and stale, pending, ready, in-progress, or unknown dependencies fail closed with their IDs.

- `roadmap-status` is read-only and returns `roadmap: null` when no roadmap exists.
- `roadmap-register` atomically adds up to 64 entries with `id`, `title`, `description`,
  `acceptance`, optional `depends_on`/`discovered_by`, and a required audit reason. The complete
  prospective live graph is validated before mutation: same-batch forward references work, while
  unknown/stale dependencies, duplicate edges, self-reference, and cycles reject the whole batch.
  Do not send
  `status`. Each entry must name a behavioral consequence if it is never done. This bar applies to
  entries, not findings: reviewers still report all findings in durable receipts. A prose-only nit
  is folded into `doc-and-comment-accuracy-sweep` or dropped with reasoning rather than promoted to
  its own roadmap item.
- `roadmap-supersede` marks known live entries stale with a reason and optional `replaced_by`; it
  does not delete them. Targets and replacements must be unique, known, live, and disjoint, and the
  remaining live dependency graph must still be valid.
- `roadmap-attest` closes live requirements against an archived completed run, or against the exact
  verified produce-and-hold shape (`blocked` at `merge`, `gates.passed: true`, and the canonical
  auto-merge-disabled reason), without modifying the run's immutable record. Pass `requirement_ids`,
  `run_id`, and a non-empty audit `reason`. No other blocked shape is eligible, and a shipping hold's
  `completes` declaration does not satisfy a requirement without this explicit attestation. Each
  requirement must be known and live (not superseded).
  Attestations are idempotent and stored in a separate overlay (`roadmap-attestations.json`) that
  the derivation reads alongside `completes`. The requirement-index is updated so `query` can find
  the relationship.

Register and supersede mutations use a bounded single-operation journal. The roadmap store lands before the override
audit line, and the same mutation ID appears in the entry audit, journal, and override record.
Retries recover unapplied, applied-but-unaudited, and committed operations exactly once; a store
matching neither recorded hash is divergent and is never overwritten.

`receipt.evidence.roadmap_followups` is the enforceable proposal channel: at most 64 normalized
entry declarations, with no `status` or `discovered_by`. A non-operator `discovered_by` on
registration must name an active or archived run containing an accepted receipt with an exact
declaration match. Receipt acceptance never auto-registers an entry; explicit approval and a
separate `roadmap-register` call remain required.

Derived entries are `satisfied`, `in_progress`, `ready`, `pending`, or `stale`. `status_filter`
limits returned entries without changing whole-roadmap counts.

## `ape_config`

- `get` returns effective defaults plus overrides; `set` validates known dotted keys and keeps the
  persisted overlay sparse.
- `init` detects common project test runners and proposes commands. `apply: true` persists an
  operator-approved proposal.
- `doctor` checks state/lock health, git, configuration, bundles, host preconditions, and recognized
  project types. It does not forecast or validate external MCP providers.
- `wire` / `unwire` configure Claude's command-backed APE statusline or Codex's closest native TUI
  footer. Pass `host` explicitly.

See [configuration](configuration.md) for every key.

## Protocol surface

APE supports modern stateless MCP `2026-07-28` and legacy `2025-06-18`.

- Modern requests declare `io.modelcontextprotocol/protocolVersion` in `params._meta`. An unknown
  version fails with `UnsupportedProtocolVersionError` (`-32022`) before tool execution.
- `server/discover` returns `supportedVersions`, capabilities, and server identity in `_meta`.
- Every modern result carries `resultType: "complete"`.
- Cacheable `server/discover` and `tools/list` results carry `ttlMs: 3600000` and
  `cacheScope: "public"`.
- `initialize` and `ping` remain only for pre-2026-07-28 clients. Legacy `initialize` negotiates
  `2025-06-18`; modern clients use per-request metadata and `server/discover`.
- `notifications/progress` remains available when `_meta.progressToken` is present.

### Experimental tasks

A modern request can opt into `io.modelcontextprotocol/tasks`. Eligible `record`, `regate`, `ship`,
and waiting/cross-gate `next` calls may return a durable task. APE implements `tasks/get`,
`tasks/update`, and `tasks/cancel`, not `tasks/list`; every task method independently requires the
request-scoped capability.

The tasks extension is deliberately opt-in; a blanket migration of all long calls was not
attempted. A client that never negotiated tasks could not poll or cancel a server-minted handle,
leaving abandoned work, so ordinary calls preserve the synchronous/watch contract.

Task generations are private, root-bound, immutable, hash-chained records under
`.ape/runtime/tasks/`. Cancellation is cooperative: acknowledgement means the request is durable,
not that termination is instantaneous. Operation journals prevent committed effects from running
twice after recovery. Reissuing a task-creating call whose task id was lost is deliberately not
treated as the same intent because MCP supplies no client idempotency key; once the task id is
known, repeated `tasks/get` is safe.

## Developing this repository

The installed plugin already registers the `ape` MCP server. This repository's `.mcp.json` also
registers a source/development server, so a checkout can expose it twice. For Claude development,
disable the checkout registration in `.claude/settings.local.json` when using the installed copy:

```json
{ "disabledMcpjsonServers": ["ape"] }
```

Regenerate the host packages with `npm run package:plugins`. Codex development updates can then use
`npm run reinstall:codex`; see the README for the immutable-cache development flow. Both generated
MCP declarations launch the local bundle over stdio. A hosted APE broker is outside this release.
