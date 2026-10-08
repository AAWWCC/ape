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

Ordinary inputs have a 64 KiB UTF-8 limit. Receipts have a 128 KiB limit so a valid
64 KiB preflight artifact fits alongside its receipt envelope and observations.
Recovery validates the same receipt allowance plus a separate 64 KiB control
envelope, so recovery metadata does not reduce valid receipt capacity. Structural
and artifact-specific bounds still apply. Responses summarize larger records; full tickets
(worker assignments), receipts (worker results), and run records live in `.ape/runtime/`.

## History observability and metrics

`ape_history explain` shows the saved run record and its lifecycle: dispatches,
retries, remediation, and recovery. The summary keeps preflight question IDs and
counts, not the operator's answer text.

`ape_history query` and `metrics` accept `limit` (1–256, default 256) and an opaque
`cursor`. Their `pagination` object contains `limit`, `returned`, `has_more` and
`next_cursor`. Continue with the returned cursor and the same selectors to reach
older records. Cursors use stable record keys so newly inserted records do not
shift an in-progress page. A page may contain fewer records to fit the wire budget;
the next cursor follows the records actually returned.

`ape_history metrics` summarizes one selected page. It accepts inclusive ISO
`since` / `until` timestamps and exact filters for:

- `lane`, `mode`, `host`, `status`;
- `ape_version`, `runtime_version`, `host_plugin_version`;
- Codex `protocol_version` and `envelope_version`;
- `terminal_reason_taxonomy_version` and `terminal_reason_code`.

Invalid values and reversed date ranges are refused. Results report outcomes,
failure reasons, p50/p90/p95/p99 durations, version groups, and legacy-unknown counts
for the processed records matching those filters. Page percentiles and rates are
not whole-history aggregates and must not be averaged to invent global values.

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
   tests or creating state, and reports capabilities, dispatch bounds, and
   `ticket_deadline: { deadline_ms: null, source: 'no-worker-deadline' }` for new runs.
2. For the new protocol, review the complete, ready `admission` manifest (version 1).
   Call `start` with the same inputs plus `expected_admission_digest` set to the
   returned `admission_digest`.
3. `start` rechecks repository content and index, configuration, scope, commands,
   pipeline, and authorization before creating a branch or run. Changed inputs are
   refused. The digest confirms reviewed inputs; it is not proof of human consent.
4. Use `record` for worker results and `next` to advance a transition or poll gates
   and shipping. Use `ape_status` to read state, or `resume` to find the next action
   after interruption. `ape_run status` is a deprecated alias.

Preview distinguishes a failing baseline from an unavailable runner. Large manifests
use read-only pages rather than rejecting the run. Existing legacy runs keep their contracts.

An oversized preview returns `admission_summary: { version, ready }` and
`admission_delivery: { version: 1, kind: "paged", digest, total_utf8_bytes, offset,
next_offset, text, sha256 }`; it does not claim an inline `admission` or issue a top-level
`admission_digest`. Text is a contiguous UTF-8 slice of the manifest's canonical JSON.
Continue with the identical preview inputs plus `admission_page: { digest, offset: next_offset }`.
This optional field is accepted only on preview and never becomes part of the admission hash.

Read each page separately. Check its hash, the shared digest and total length, contiguous
offsets from zero, and final `next_offset: null`. Reconstruct and verify the canonical manifest
without printing it in one tool response. Review the full ready manifest before binding or
dispatch, then use the delivery digest as `expected_admission_digest` and omit `admission_page`.
Missing pages stop the parent protocol; the digest establishes consistency, not proof of reading.
Every page re-evaluates admission without writing preview state. Changed inputs produce
`admission-drift`; restart preview from zero. Malformed, out-of-range, or mid-character offsets
produce `invalid-admission-page`. Retrying an unchanged page is deterministic.
Admission previews fit within 40,000 framed UTF-8 bytes, including metadata and escaped text.
This fits the measured default 10,000-token code-mode wrapper allowance; the general MCP
response ceiling remains 48,000 bytes. Neither value limits the complete admission manifest.

Start also validates objective, host, mode, lane, paths, requirements, risk, and
available host capabilities. The main input rules are:

| Work | Required contract |
| --- | --- |
| Behavioral fast/full phase | `test_paths`; default `test_intent: "red-first"`. May use plan contract v2. |
| Phase-only `green-maintenance` | Runtime-observed pass/pass. No implementer when `claimed_paths` is empty. |
| Pure data/baseline phase work | `behavioral: false`; no test writer. |
| `land` | Non-empty default-tip-to-working-tree diff, entirely in `claimed_paths` and `test_paths`. HEAD must equal or descend from the resolved default tip. |

During independently confirmed post-build test recovery, the runtime issues
`test-recheck` with `required_checks: ["test-correction"]`. It observes exact
changed test paths twice and accepts either stable pass/pass or stable fail/fail
before the implementer retries. This is a scheduler-owned recovery check, not a
new `test_intent` input. Worker-reported observations cannot replace the sealed
`evidence.test_correction` result.

During the initial test stage, capability and worker-transport recovery can carry
unchanged authored tests into a successor's runtime observation. APE verifies the
original test writer's committed receipt, immutable tickets, recovery transaction,
and exact file diff before executing those paths twice against the current tree.
The successor's receipt still attributes only its own writes. Baseline tests,
unrecorded expired-worker output, changed inherited files, and prior-stage results
do not become authored evidence through this handoff.

An implementer in `build` or `remediation-build` can request independent coverage
with a capability receipt naming `required_role: "test_writer"`. Its successor
uses the same runtime-observed `test-correction` check and receives a bounded,
untrusted `test_authoring_handoff` report from the requesting receipt. An unchanged
suite cannot complete authoring. After stable authored-test evidence, APE resumes
the implementation stage with `targeted-tests` before advancing to review.
Diagnostic role changes and retries retain this authoring obligation. A diagnostic
receipt returns to a test writer; requesting implementation cannot skip authoring.
Only runtime-observed stable pass/pass or fail/fail on independently changed tests
permits continuation. A separate immutable completion reference preserves that
result across implementation retries without trusting worker-reported observations.

`debug` / `spike` can freeze exact `run_command_profiles` for their matching
read-only role, with `effect: "execute"`, an audit reason, and operator approval.
Set `operator_authorized: true` only after approval of the literal command.
See [command profiles](hooks.md#exact-command-profiles).

Generators that modify tracked files need `effect: "write"`, a writable role, and
exact `output_paths` already approved in that role's claims. They cannot double as
verification/test commands. Declaring outputs does not bypass tree checks or make
a read-only worker writable.

An unused global generator does not add required output paths to the run. Profiles
outside a role's scope stay cataloged without entering its usable capabilities.
Debug and spike require only prerequisites reached by their own workflow; they do
not inherit test-authoring paths or automatic shipping from a phase run.

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
IDs, evidence commands, and the ticket's canonical candidate-plan allowance
(65,536 bytes for new runs; 16,384 for previously issued contracts). It
returns field corrections and
`budgets.candidate_plan_utf8_bytes.{used_bytes,max_bytes,remaining_bytes}`.
This cap limits the artifact's stored and transmitted size. Model capacity and
plan quality require separate evidence.

A successful validation attests the normalized draft hash for that physical
dispatch. Changing the draft invalidates it. `record` requires this matching
attestation for new-contract tickets, then verifies identity, tree/test evidence,
hashes, and the next transition. The parent must not reconstruct a worker receipt.

Execution policy v4 uses durable correction progress without a submission or
worker-count quota. Removing errors at schema-declared locations can advance;
repeated or reintroduced errors cannot. Follow the returned recovery decision
for same-worker correction or replacement after the exact predecessor retires.
Historical tickets retain their frozen limits, normally three submissions per
worker and two workers. A terminal correction failure blocks as
`worker_protocol_failure`; it does not count as reviewer dissent or trigger
product remediation, replan, abort, or a new run.

Emergency `recover-receipt` requires operator approval and a native-bound worker
that the host observed stopping without an attestation. Supply the unchanged
`receipt`, the exact `receipt_input_hash` from the refused ordinary `record`, and
a nonblank audit `reason`. Only attestation is waived; all other binding and
receipt checks remain. APE saves the draft/dispatch hashes and reason in the
receipt, completed dispatch intent, and `overrides.ndjson`. An attested draft must
use ordinary `record`.

For Claude's exact validator tool names and optional host reachability check, see
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

Execution responses use these `next_action.kind` values:
`continue_same_agent`, `redispatch_same_ticket`, `stage_retry`, `directed_replan`,
`remediate_product_finding`, `wait`, `answer_preflight`, or `blocked`.
Capability expansion can return `capability_recovery`. Resume also returns
source-selection and checkpoint recovery actions described below. Follow a
returned `required_control_action` before interpreting a generic continuation kind.
`failure_domain` is `product`, `orchestration`, `configuration`, `infrastructure`,
`operator`, or `unknown`. Protocol/infrastructure failures are not product findings.
A blocked response sets `automatic_successor: false`; a new run needs explicit
operator authorization.

### Long-running calls

Final-stage `record`, `regate`, and `ship` run quick gates, then start the configured
suite in a detached process. After `gates.inline_grace_ms`, a still-running suite
returns state `gating`.

Tree, preflight, or resolved suite changes invalidate a running gate generation.
Inline and explicit polls record that invalidation before requesting authenticated
broker cancellation. A generation's suite and descendants must have confirmed
retirement before its failure is consumed or a replacement can start. Cancellation
uses the existing bounded escalation; it never relies on a stale PID as proof.
Incomplete cleanup retains ownership and reports recoverable guidance. Restore
broker access and use `next` or `resume`; an audited `regate` cannot bypass unknown
retirement. Invalidation survives restart and a reverted configuration change.
Generation artifacts are removed only after retirement and both state writes.

While `gating` or `shipping`, call `next` with optional `wait_ms`. Polling releases
the receipt lock between checks. Limits are `GATE_NEXT_MAX_WAIT_MS` (300000 ms)
and `GATE_NEXT_POLL_FLOOR_MS` (250 ms). If gating enters required-check shipping,
call `next` again to advance that watch.

Long synchronous calls send progress every ten seconds when `_meta.progressToken`
is present. Wait for native workers using the host's agent-wait tool.
`SubagentStop` records termination. New workers have no elapsed-time cutoff:
their execution policy v3 tickets carry `deadline_at: null`. Explicit cancellation,
revocation and confirmed-stop recovery still apply. Historical tickets keep their
original deadlines; an elapsed historical deadline alone does not authorize a
duplicate worker. Command/suite timeouts, launch-token expiry, lock leases,
polling and shutdown grace periods remain separate operational timers.

`ship` and `regate` reject a run in the non-blocking watch states `gating` or `shipping` and point
to `ape_run next`, which is the action that advances those states. A gate-blocked run points to
`regate`; a green auto-merge hold points to `ship`.

An explicit public/native run invocation authorizes its configured pipeline. When
`shipping.auto_merge` is true, APE freezes `auto_merge_authorized: true`; callers
normally omit that compatibility field. Continue the admitted stages and shipping
without repeatedly asking the operator to say continue.

Before branch creation, start compares the local remote-tracking base with the
server's branch tip. Shipping repeats the check before its first Git mutation.

Repository-scoped GitHub CLI commands explicitly select the admitted `github.com`
repository, regardless of `GH_HOST` or `GH_REPO`. This applies to PR creation,
observations, checks, merges, protection API reads, and resumed shipping watches.
Existing consent and origin, PR URL, base, head, and merge-tree checks still apply.
Stored admission commitments remain unchanged; unsupported hosts and unbound
legacy runs cannot ship.

Each persisted or resumed shipping poll observes the PR before waiting on checks.
MERGED and CLOSED reconcile even when checks fail, remain pending, are missing,
or cannot be read (including authentication errors). Neither terminal state
submits another merge request. MERGED requires the exact frozen repository,
URL, base, pushed head, and observed merge commit ancestry and gate-attested tree;
provenance records whether a merge command had been submitted. CLOSED without
merging blocks with guidance to regate or start a new run. An unsubmitted OPEN
PR needs passing required checks and a fresh matching PR observation before a
merge request; an already submitted watch never resubmits. Guarded local cleanup
follows proven completion and may retain local work without undoing the merge.

Checks polling reads a complete JSON bucket collection from stdout, bounded to
65,536 string units per stream. Only validated failed buckets take the CI-failure
path and require `regate`; only an intact successful all-pass observation can
advance merge admission. Pending checks (exit 8) remain non-authorizing.
Transport errors, malformed/empty output and truncated or oversized evidence
retain the shipping cursor and passed gates: retry `ape_run next`. Authentication
errors (exit 4) require restoring `gh` authentication/access for the admitted
GitHub host/repository before retrying. Status, resume and history report that
distinction without retaining raw error text. A later valid observation clears
the stale error guidance. Older watches without observation metadata remain
retryable.

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

Blocked and aborted runs save unfinished work in `.ape/runtime/checkpoints/` before their
terminal history is archived. Reset verifies that checkpoint before removing the active run.
Protected local Git refs under `refs/ape/checkpoints/` retain the working tree and real index,
including modified, deleted, and non-ignored untracked files. Ignored files are not backed up.
These refs survive Git garbage collection; they are not pushed by ordinary APE shipping.
Checkpoint metadata retains the original objective, scope, requirements, branch, and failure reason.

`ape_status`, resume and session guidance use one runtime recovery planner. A blocked run returns
`recovery_plan` and `confirm_recovery` when it can safely continue. Explicit resume confirms the
exact `expected_recovery_digest` with `explicit_invocation: true`; it needs no separate reset
approval. The digest binds the run, HEAD, files, index, configuration and worker/gate ownership.
Unchanged reviewed code with valid admission uses the existing gate retry policy. Code changes,
new admission needs or exhausted recovery preserve the task in a checkpoint and retire the old
execution. A durable journal precedes retirement so a retry after a lost response reuses that
checkpoint and continuation. Unresolved workers/gates prevent retirement. Healthy runs retain
their workers. Existing shipping watches are reconciled first; intentional auto-merge holds stay
held. A new terminal block ends the invocation rather than creating another replacement.

The execution diagnostic retains its historical manual recovery levers for compatibility;
the task recovery plan and returned `next_action` govern an explicit resume request.

Receipt draft validation verifies the immutable contract; authored-test admission additionally
requires runtime-observed provenance, routing and test verdicts. A deterministic refusal of an
exact native-attested draft is durably blocked, with a bounded admission reason and checkpoint
recovery guidance. Repeated record, next and resume calls preserve that refusal without accepting
the receipt or launching a replacement worker. Inspect the cause and use resume to review recovery;
preserve existing authored coverage and never manufacture cosmetic test edits. Transient runner
failures retain exact-receipt retry, and prepared or committed successful receipts retain idempotent
replay. Ordinary validation rejection remains advisory and does not change run state.

`ape_status` reports `work_recovery` counts separately from the active run. With no active run,
`ape_run resume` returns `recover_checkpoint` for one available checkpoint or `choose_checkpoint`
when checkpoint selection or storage inspection is needed. If legacy sources also exist, it returns
`choose_recovery`. Discovery does not restore files or start workers.
To recover a selected checkpoint, call `resume` with `checkpoint_id` and `explicit_invocation: true`.
It merges saved work with the locally resolved default tip and restores it onto a new branch.
Existing branches are retained until successful task completion. Newer dirty files, merge conflicts, and damaged checkpoint data
stop recovery without overwriting the original working files. Fetch current remote refs before
recovery when needed; normal shipping admission still checks remote freshness.

Successful recovery returns `start_recovered_work` and `start_input`. Inspect the original blocker,
then preview/start with complete current host attestations and the returned `checkpoint_id` and
`supersedes_run` when present. Preview checks the restored checkout, base, and complete changed-file scope.
Start adopts the recovery branch itself, with a new run ID, current policy, fresh native binding,
new workers, and new validation; it does not create a second phase branch.
The runtime records recovered file provenance, not inherited test results or worker receipts.
A checkpoint stops appearing as unfinished after its fresh run starts durably; its Git backup remains.

`choose_recovery` also inventories older saved tasks, APE branches, current changes and the live
Git stash list. Select `legacy_candidate_id` and explicitly associate it with `legacy_run_id`, or
supply missing objective/scope in `recovery_context`. Rediscovery returns the digest to confirm.
Imports preserve tracked, staged, deleted and untracked bytes without dropping the source stash
or branch. Legacy provenance is user-confirmed; absent run IDs are never invented. External backup
bundles are not inspected, and sources are never automatically combined based on names/messages.

An explicit resume request authorizes this recovery flow, including a replacement for a blocked
execution. `explicit_invocation` is the existing orchestrator attestation, not authenticated human
proof. It does not authorize discarding newer edits or selecting one task among several.
After successful task completion, cleanup traverses recorded checkpoint lineage and conditionally
deletes only proven APE branches whose exact tips remain preserved, are unchanged and are not
checked out in any worktree. `recovery_cleanup` reports retained branches and reasons separately
from task success; resume can retry it. Checkpoint Git refs remain available. Manual reset, regate
and ship still work, as do existing checkpoint resume clients.

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
| `roadmap-register` | Add entries atomically within the shared 64 KiB input and structural guards. Each needs `id`, `title`, `description`, `acceptance`; `depends_on` and `discovered_by` are optional. An audit reason is required. Do not send `status`. |
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

Receipts may propose `receipt.evidence.roadmap_followups` within their shared
receipt resource envelope (historical tickets retain their 64-entry contract), without `status`
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

Regenerate the host packages with `npm run package:plugins`. Development updates can use
`npm run reinstall:codex` or `npm run reinstall:claude` after explicit installation approval.
Both use the dedicated `ape-dev` local marketplace; Claude installs at local scope for the
current checkout and preserves existing user-scope installations.
For this public development checkout, enable `shipping.codex_dev_refresh` and
`shipping.claude_dev_refresh` once. A successful Codex or Claude shipment automatically
updates only that host's `ape@ape-dev` from the verified merged build. Other repositories
and plugins cannot trigger it. The run reports `codex_plugin_refresh` or
`claude_plugin_refresh`; a failed refresh is retried with `ape_run resume` without
repeating the shipment. Start a new host session and verify the new loaded snapshot; a running
desktop app may require a restart. Codex recovery copies do not guarantee that existing
chats retain their original hook or runner paths, even with `--preserve-open-tasks`.
See the [Codex refresh contract](architecture.md#codex-development-refresh-contract)
for the supported pinned-host request and path limits. Both generated MCP
declarations launch the local bundle over stdio. A hosted APE broker is outside this release.
