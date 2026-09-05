# MCP tools

Use [skills](skills.md) for ordinary work. This reference is for integrations and
debugging: four orchestration tools, plus two tools used by native workers.

| Tool | Actions |
| --- | --- |
| `ape_run` | `probe`, `probe-status`, `probe-ack`, `preview`, `start`, `next`, `record`, `recover-receipt`, `answer-preflight`, `status`, `resume`, `regate`, `ship`, `expire-dispatch`, `abort`, `override` |
| `ape_bind` | Bind a native Codex child to its authorized launch through trusted hooks. Children only. |
| `ape_status` | Read the current run, pending tickets, lane, and gates. |
| `ape_history` | `query`, `explain`, `metrics`, `import`, `maintenance-status`, `compact-artifacts`, `roadmap-status`, `roadmap-register`, `roadmap-supersede`, `roadmap-attest` |
| `ape_config` | `get`, `set`, `doctor`, `wire`, `unwire`, `init` |
| `ape_validate_receipt` | Validate and attest a bound worker's exact receipt draft. Does not advance the run. |

Inputs have a 64 KiB UTF-8 limit. Responses summarize larger records; full tickets
(worker assignments), receipts (worker results), and run records live in `.ape/runtime/`.

## History observability and metrics

`ape_history explain` shows the saved run record and its lifecycle: dispatches,
retries, remediation, and recovery. The summary keeps preflight question IDs and
counts, not the operator's answer text.

`ape_history metrics` summarizes the newest 256 runs. It accepts inclusive ISO
`since` / `until` timestamps and exact filters for:

- `lane`, `mode`, `host`, `status`;
- `ape_version`, `runtime_version`, `host_plugin_version`;
- Codex `protocol_version` and `envelope_version`;
- `terminal_reason_taxonomy_version` and `terminal_reason_code`.

Invalid values and reversed date ranges are refused. Results report outcomes,
failure reasons, p50/p90/p95/p99 durations, version groups, and legacy-unknown counts
for the processed records matching those filters.

Read the coverage fields before treating a result as complete:

| Field | Meaning |
| --- | --- |
| `coverage.available_runs`, `processed_runs`, `limit`, `truncated` | How much history was examined. |
| `omitted_cohorts`, `omitted_runs` | Version groups omitted beyond the 16 largest. Use an exact version filter to inspect them. |
| `token_dispatches`, `token_attested_dispatches` | Token-count coverage. Missing counts are never estimated. |

Claude's Codex-only protocol fields are `not_applicable`, not unknown.
The `orchestration` block reports first-pass receipt and run rates, corrections,
redispatches, time to first writer, and repair time. Token totals require exact
host-attested counters.

`lineage_outcomes` follows replacement runs and counts their final, unsuperseded
leaves. Branching recovery contributes each leaf; filters apply to those leaves.
Coverage names missing, invalid, self-referential, branching, and cyclic links.
Records in or descended from a cycle are reported separately and omitted from
trusted outcomes. `superseded_runs` counts predecessor records;
`valid_supersession_links` counts links.

`terminal_reason_counts` uses the runtime's terminal stage, not operator prose:
dispatch, preflight, planning, test, implementation, review, gating, shipping, or
investigation. Taxonomy v2 separates `land_review_disagreement` with zero repair
cycles from `review_remediation_exhausted`. Stored v1 codes are not rewritten.

Metrics send no telemetry and change no caches. Separately, the statusline caches
timings from at most the newest 20 history files under `.ape/runtime/`.

## `ape_run`

### Start and advance

1. Call `preview` with the intended run inputs. It checks readiness without running
   tests or creating state, and reports capabilities, dispatch bounds, and deadlines.
2. For the new protocol, review the complete, ready `admission` manifest (version 1).
   Call `start` with the same inputs plus `expected_admission_digest` set to the
   returned `admission_digest`.
3. `start` rechecks repository content and index, configuration, scope, commands,
   pipeline, and authorization before creating a branch or run. Changed inputs are
   refused. The digest confirms reviewed inputs; it is not proof of human consent.
4. Use `record` for worker results and `next` to advance a transition or poll gates
   and shipping. Use `ape_status` to read state, or `resume` to find the next action
   after interruption. `ape_run status` is a deprecated alias.

Preview distinguishes a failing baseline from an unavailable runner. If the whole
manifest cannot fit in the response, it refuses without issuing a usable digest.
Existing legacy runs keep their original contracts.

Start also validates objective, host, mode, lane, paths, requirements, risk, and
available host capabilities. The main input rules are:

| Work | Required contract |
| --- | --- |
| Behavioral fast/full phase | `test_paths`; default `test_intent: "red-first"`. May use plan contract v2. |
| Phase-only `green-maintenance` | Runtime-observed pass/pass. No implementer when `claimed_paths` is empty. |
| Pure data/baseline phase work | `behavioral: false`; no test writer. |
| `land` | Non-empty default-tip-to-working-tree diff, entirely in `claimed_paths` and `test_paths`. HEAD must equal or descend from the resolved default tip. |

`debug` / `spike` can freeze exact `run_command_profiles` for their matching
read-only role, with `effect: "execute"`, an audit reason, and operator approval.
Set `operator_authorized: true` only after approval of the literal command.
See [command profiles](hooks.md#exact-command-profiles).

Generators that modify tracked files need `effect: "write"`, a writable role, and
exact `output_paths` already approved in that role's claims. They cannot double as
verification/test commands. Declaring outputs does not bypass tree checks or make
a read-only worker writable.

`ape_config init` normally detects test commands from manifests. For a blank
metadata-only repository, prospective `behavioral` and `test_paths` values can
identify dependency-free JS/TS or Python commands. During an explicit run, the
parent applies a complete proposal for missing command slots. For a clean Git
repository with no commits, APE creates an empty root commit under the run lock
before creating its branch.

Refused control actions return `ok: false`, not an error hidden inside a successful
`actions` array.

### Receipt validation and recovery

A bound worker calls `ape_validate_receipt` with `{ ticket_id, draft }`.
`ticket_id` must equal `draft.ticket_id`; `draft` must be the complete object the
parent will submit as `ape_run record`'s `receipt`. Apart from the child bootstrap,
this is the worker's only APE tool.

The validator checks the same role contract as `record`: plan structure, profile
IDs, evidence commands, and the 16,384-byte canonical candidate-plan limit. It
returns field corrections and
`budgets.candidate_plan_utf8_bytes.{used_bytes,max_bytes,remaining_bytes}`.
This byte limit bounds storage and model context, not plan quality.

A successful validation attests the normalized draft hash for that physical
dispatch. Changing the draft invalidates it. `record` requires this matching
attestation for new-contract tickets, then verifies identity, tree/test evidence,
hashes, and the next transition. The parent must not reconstruct a worker receipt.

Each worker gets an initial validation and two corrections. One fresh worker may
then be authorized on the same ticket without using a stage attempt. Exhausting
that worker's corrections blocks as `worker_protocol_failure`; it does not count
as reviewer dissent or trigger product remediation, replan, abort, or a new run.

Emergency `recover-receipt` requires operator approval and a native-bound worker
that the host observed stopping without an attestation. Supply the unchanged
`receipt`, the exact `receipt_input_hash` from the refused ordinary `record`, and
a nonblank audit `reason`. Only attestation is waived; all other binding and
receipt checks remain. APE saves the draft/dispatch hashes and reason in the
receipt, completed dispatch intent, and `overrides.ndjson`. An attested draft must
use ordinary `record`.

For Claude's exact validator tool names and required host reachability check, see
[agents](agents.md#tools-and-receipts) and [operational readiness](operational-readiness.md).

### Immutable run contract

New native receipt-contract runs and their tickets carry a `run_contract` pointer:
`{version, revision, ref, hash}`. Its manifest in `.ape/runtime/contracts/` freezes
configuration, objective and preflight hashes, requested/available capabilities,
allowed commands, verification profiles, field/byte limits, and role receipt schemas.

Schemas are stored by content hash, so ticket compaction does not erase them.
Tool responses reference the pointer instead of repeating the full contract.
Existing runs and historical ticket hashes remain unchanged.

### Typed recovery status

Control responses use only these `next_action.kind` values:
`continue_same_agent`, `redispatch_same_ticket`, `stage_retry`, `directed_replan`,
`remediate_product_finding`, `wait`, `answer_preflight`, or `blocked`.
`failure_domain` is `product`, `orchestration`, `configuration`, `infrastructure`,
`operator`, or `unknown`. Protocol/infrastructure failures are not product findings.
A blocked response sets `automatic_successor: false`; a new run needs explicit
operator authorization.

### Long-running calls

Final-stage `record`, `regate`, and `ship` run quick gates, then start the configured
suite in a detached process. After `gates.inline_grace_ms`, a still-running suite
returns state `gating`.

While `gating` or `shipping`, call `next` with optional `wait_ms`. Polling releases
the receipt lock between checks. Limits are `GATE_NEXT_MAX_WAIT_MS` (300000 ms)
and `GATE_NEXT_POLL_FLOOR_MS` (250 ms). If gating enters required-check shipping,
call `next` again to advance that watch.

Long synchronous calls send progress every ten seconds when `_meta.progressToken`
is present. Wait for native workers using the host's agent-wait tool.
`SubagentStop` records termination; an elapsed deadline alone does not authorize
a duplicate worker.

`ship` and `regate` reject a run in the non-blocking watch states `gating` or `shipping` and point
to `ape_run next`, which is the action that advances those states. A gate-blocked run points to
`regate`; a green auto-merge hold points to `ship`.

An explicit public/native run invocation authorizes its configured pipeline. When
`shipping.auto_merge` is true, APE freezes `auto_merge_authorized: true`; callers
normally omit that compatibility field. Continue the admitted stages and shipping
without repeatedly asking the operator to say continue.

Before branch creation, start compares the local remote-tracking base with the
server's branch tip. Shipping repeats the check before its first Git mutation.

### Recovery actions

- `regate`: rerun a failed merge gate within the attempt budget.
- `ship`: release a green run held by `shipping.auto_merge: false`. Requires an audit
  reason and rechecks all gates against the current tree.
- `expire-dispatch`: void an orphaned or wedged dispatch. Requires a pending
  `ticket_id` and audit reason; consumes the attempt and issues a new ticket only
  if the retry budget permits.
- `abort`: seal the current run.
- `override`: reason-audited `abort` or `reset`. An unaimed reset can recover an
  orphaned lock; unexplained tree changes are not a reason to reset automatically.

Terminal `resume` retries local checkout cleanup. A proven remote merge remains
successful even if local conflicts require manual cleanup.

Only `answer-preflight`, `abort`, and `override` accept `run_id`. It confirms the
active run; it does not select another run. A mismatch or explicit `null` is
refused before any effect. If `active.json` is unreadable, an authorized reset
must omit `run_id` because APE cannot confirm it.

### Codex binding preflight

Codex `start` requires a fresh live bootstrap proof:

1. Call `probe`; after doctor checks it returns `dispatch_probe`.
2. Pass `dispatch.spawn_args` unchanged to native `spawn_agent`: exact task name,
   `fork_turns: "none"`, model, optional reasoning effort, and message. APE's logical
   role type is not a Multi-Agent V2 spawn argument. If the response is lost before
   launch, repeating `probe` returns the same saved envelope.
3. The child calls `ape_bind` with the launch message's exact
   `{project_dir, bootstrap_capability}`. Its trusted hook binds the child and
   injects acknowledgement authority. `SubagentStart` alone and the MCP result
   grant no authority. Missing ticket context before this call is expected.
4. On deferred-tool hosts, first search for the bare name `ape_bind`, then call
   the installed tool returned by discovery. Never search for a host-qualified
   alias or include the bootstrap bearer in the search.
5. `probe-status` must show the bound canary awaiting acknowledgement. Send its
   `probe_id` and `probe_capability` to `probe-ack`. `start` consumes this single-use
   proof before its first Git mutation.

Run the parent in the governed project: `project_dir` does not relocate native
children. Hooks derive child identity from the host, not caller-supplied IDs.
Tokens apply to one launch generation; stale tokens cannot select a replacement.

`probe-status` returning `ok: true` means the read succeeded, not that binding did.
An expired `launch_expires_at` or current-generation bootstrap rejection sets
`infrastructure_status` to failed with a blocked `next_action`. The reservation
stays protected until its own expiry; failure does not authorize another child.
Diagnostics contain bounded codes, outcome, and time, not bearers, identities,
or raw exceptions.

Static package wiring does not prove live hooks work. Missing, expired, replayed,
or unbound probes fail before run creation and consume no stage attempt. Claude
uses its own native binding path and does not run this probe.

With no active run, `probe` and `start` can quarantine malformed dispatch evidence
under `.corrupt-*` names, preserving its bytes. Symlinked `.ape` or runtime ancestors
are refused before creating state outside the project. Status reports corrupt
evidence without repairing it. For an active run, reason-audited `abort` performs
the quarantine before sealing.

New Codex stage dispatches use `ticket_projection: "bootstrap-hook-injected"`
and the same child-only binding path. Binding supplies the ticket reference,
receipt envelope, and role schema. Wait for the existing child; do not launch a
duplicate while binding is pending. Resume rechecks child/model identity before
reinjection. Unmarked legacy dispatches keep their old protocol; a pending legacy
probe must expire before replacement. See [hook details](hooks.md#codex-native-bootstrap).

### Behavioral plan preflight evidence

Plan contract v2 starts behavioral fast/full phase runs with a read-only analyst.
Each `evidence.preflight_artifact` baseline needs a receipt test entry with the same
command. Omit `output_hash` from both if raw output is unavailable; never invent it.
If supplied, the two hashes must match exactly.

To answer operator questions, `answer-preflight` requires the returned
`preflight_hash`, the complete `{id, answer}` list, and a nonblank audit `reason`
(at most 4000 characters). Missing fields return action-specific errors without
changing the run.

### External MCP tools

APE does not require or enforce claims for other MCP servers. The host controls
their discovery, connection, permissions, and approval, including newly added
providers. Legacy external-tool fields remain readable in historical records but
grant no authority and are not accepted in new run inputs.

APE still enforces its own tool boundaries and checks repository changes. An
external tool cannot make an out-of-scope edit valid. See
[external MCP pass-through](hooks.md#external-mcp-pass-through).

## Artifact maintenance

Run completion may compact older redundant snapshots while retaining recent ones.
`maintenance-status` reads the last result without changes.

Manual `compact-artifacts` requires an audit `reason`. Defaults:
`keep_recent_runs: 32`, `max_runs: 64` (maximum 256). APE verifies a byte-exact gzip
archive before deleting source files, and only deletes files that still match.
It never removes immutable history, audit logs, prepared transactions, changed
data, or the active/sealed run. A bad candidate is retained and reported; later
candidates can still be processed.

## Roadmap verbs

The optional roadmap lives in `.ape/runtime/roadmap.json`. It tracks dependencies,
not scheduling. A roadmap-backed run may start or complete only when every direct
and indirect dependency is `satisfied`. Refusals identify stale targets and
unsatisfied or unknown dependencies.

| Action | Rules |
| --- | --- |
| `roadmap-status` | Read-only; returns `roadmap: null` if absent. |
| `roadmap-register` | Add up to 64 entries atomically. Each needs `id`, `title`, `description`, `acceptance`; `depends_on` and `discovered_by` are optional. An audit reason is required. Do not send `status`. |
| `roadmap-supersede` | Mark live entries stale without deleting them. Requires a reason; `replaced_by` is optional. Targets and replacements must be unique, known, live, and disjoint. |
| `roadmap-attest` | Satisfy known live requirements using an eligible run. Requires `requirement_ids`, `run_id`, and a non-empty audit `reason`. |

Registration validates the whole proposed dependency graph before changes.
Same-batch forward references work; unknown/stale dependencies, duplicate edges,
self-reference, or cycles reject the batch. Superseding entries must also leave a
valid live graph. Each new entry must explain the behavioral consequence of not
doing it. Reviewers still report all findings; prose-only nits belong in
`doc-and-comment-accuracy-sweep` or are dropped with a reason.

`roadmap-attest` accepts an archived completed run or the exact verified shipping
hold: `blocked` at `merge`, `gates.passed: true`, and the canonical
auto-merge-disabled reason. No other blocked state qualifies. A hold's `completes`
field alone does not satisfy requirements. Attestations are idempotent, update the
requirement index for `query`, and live in `roadmap-attestations.json` without
rewriting the run.

Register/supersede use a single-operation journal with one mutation ID shared by
the entry, journal, and override audit. Retries recover
unapplied, applied-but-unaudited, and committed operations exactly once. A store matching
neither recorded hash is divergent and is never overwritten.

Receipts may propose up to 64 `receipt.evidence.roadmap_followups`, without `status`
or `discovered_by`. A later non-operator `discovered_by` must identify an active or
archived run with an accepted receipt containing the exact declaration. Approval
and a separate `roadmap-register` call are still required.

Derived statuses are `satisfied`, `in_progress`, `ready`, `pending`, and `stale`.
`status_filter` changes returned entries, not whole-roadmap counts.

## `ape_config`

- `get`: read defaults plus overrides.
- `set`: validate known dotted keys and save only overrides.
- `init`: detect test runners and propose commands. `apply: true` saves an approved proposal.
- `doctor`: check state/locks, Git, configuration, bundles, host prerequisites, and
  recognized project types. Does not validate external MCP providers.
- `wire` / `unwire`: configure Claude's APE statusline or Codex's native TUI footer.
  Pass `host` explicitly.

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

Without negotiation, calls keep the synchronous/watch behavior: the client would
otherwise have no way to poll or cancel the task.

Private, project-root-bound task records live in `.ape/runtime/tasks/`; generations
are immutable and hash-chained. Cancellation acknowledgement means the request was
saved, not that execution has stopped. Journals prevent committed effects from
running twice after recovery.

Do not recreate a task whose ID was lost: MCP provides no client idempotency key,
so that creates a distinct intent. Once the ID is known, repeated `tasks/get` is safe.

## Developing this repository

The installed plugin already registers the `ape` MCP server. This repository's `.mcp.json` also
registers a source/development server, so a checkout can expose it twice. For Claude development,
disable the checkout registration in `.claude/settings.local.json` when using the installed copy:

```json
{ "disabledMcpjsonServers": ["ape"] }
```

Regenerate the host packages with `npm run package:plugins`. Codex development updates can then use
`npm run reinstall:codex` after explicit installation approval. Start a new host task to load
the new snapshot; see [loaded bundles](architecture.md#loaded-bundles). Both generated MCP
declarations launch the local bundle over stdio. A hosted APE broker is outside this release.
