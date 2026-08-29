# Run and resume protocol

The parent orchestrator owns every APE control call. It never performs stage work itself.

## Start readiness

Before `ape_run start`, call `ape_config doctor`, `get`, and then `ape_run preview` with the exact
prospective run facts and additive `required_capabilities`. Preview and start use the same
deterministic readiness evaluator. Report the minimum/worst-case dispatch bounds and obtain explicit
`execution_budget.max_worker_dispatches` and `execution_budget.max_active_seconds`; start refuses a
worker-dispatch cap below the deterministic minimum and writes no run state on any readiness
failure. Active-time minimum feasibility is honestly unknown (`minimum.active_seconds` and
`covers_minimum_path` are null), so treat the seconds value as an authorization cap rather than a
completion estimate. For behavioral work,
if grounded gate commands are missing, call `ape_config init` for a repository-grounded proposal.
Apply only a complete proposal with operator approval; otherwise stop before any agent dispatch.

Behavioral readiness requires a grounded `test_commands.full` command.
When acceptance requires browser or visual inspection, require either a configured
`verification.profiles` command that records the evidence or an actually callable
browser/Playwright provider covered by least-privilege `tool_claims`. A doctor warning or provider
name in prose does not establish availability. If neither exists, stop before start and report the
concrete configuration requirement.

On Google Antigravity / Gemini, pass the exact open project root as `project_dir` on every APE MCP
call. The plugin process runs from its installed package directory, so its process working directory
is never project authority. Use one native `invoke_subagent` call per returned ticket with the exact
`TypeName`, `Model`, and prompt; keep `Workspace` as `inherit`. The child's supported
`PreInvocation` hook binds its conversation before the first model turn.

1. Before a Codex `start`, complete the runtime's binding probe: call `ape_run probe` with
   `host: "codex"`, `explicit_invocation: true`, `hooks_trusted: true`, and
   `subagents_available: true` (plus the governed `project_dir` when required). These attestations
   are mandatory on the probe call itself; do not make a partial probe call and retry it. Launch the
   returned `dispatch_probe` with its exact native agent name, model, reasoning effort, and message,
   confirm `probe-status` is bound, then acknowledge the returned probe capability with `probe-ack`.
   The returned agent type is APE's logical role, not a Multi-Agent V2 native argument. Stop on any
   mismatch. `start` consumes this fresh, single-use proof. Claude does not use this probe.
2. For each `dispatch_agent`, use the host-native tool and pass the generated name, model, optional
   reasoning effort, and dispatch intent exactly. On Claude, also pass the action's agent type; on
   Codex Multi-Agent V2, that field is APE's logical policy role and is not a native tool argument;
   on Antigravity, pass it as `TypeName` and pass the ticket model as `Model`.
   Never substitute a model, semantic task name, SDK, nested CLI, or API call.
3. On Codex, pass `dispatch.spawn_args` directly to native `spawn_agent` with every key and value
   unchanged. It is the versioned native launch envelope: `message` is a fixed transport-only
   bootstrap because Codex encrypts it before APE can inspect it. It carries no stage authority.
   `ticket_projection: "hook-injected"` means the trusted `SubagentStart` hook injects the complete
   common prompt, complete role prompt, and immutable ticket reference after binding the native
   child. The child must load and verify the complete ticket from the injected sanctioned
   `.ape/runtime/tickets/` path before stage work.
   The exact native arguments include `fork_turns: "none"`: model/reasoning overrides are
   incompatible with the host's inherited-history default, and the worker needs no parent history.
   Never reread `prompt_paths`, assemble a replacement message, or copy the compatibility
   `dispatch.model` object into the native `model` string argument. On Claude, use the returned
   plugin agent wrapper, which loads the same prompt files, and append the ticket. On Antigravity,
   compose its prompt from the complete common prompt, complete role prompt, and immutable ticket.
4. Launch distinct tickets as returned. On Codex, after each native spawn returns, call `ape_run`
   action `status` with only `action` and `project_dir`; never send `run_id` on status. Confirm that
   dispatch is `active-bound` before launching the next. On Antigravity, likewise finish each spawn
   and confirm binding before the next launch. Bound agents may then run concurrently. Never launch
   two physical agents for one ticket unless the runtime explicitly returns
   `next_action: {"kind":"redispatch_same_ticket", ...}`; only that action authorizes one fresh worker on the same
   immutable ticket. Wait through the host's native primitive; do not poll unchanged status.
5. Require exactly one receipt JSON matching the ticket's `output_schema`, including the exact
   injected `receipt_capability`. Before returning it, the worker must call `ape_validate_receipt`
   with `ticket_id` set to the immutable ticket ID and `draft` set to the exact complete receipt. A
   valid result attests the normalized draft hash; the worker must
   return that draft unchanged. Invalid results carry bounded field corrections, plan byte usage,
   and remaining attempts. Each physical worker gets an initial validation plus at most two
   corrections. Call `ape_run` with `action: "record"` and place that complete
   receipt inside `receipt`. At the control-call top level send only `action`, `project_dir`, and
   `receipt`; never send `run_id` on a record call. Never repair,
   fabricate, or omit agent evidence. A ticket with
   `review_contract_version` uses bounded structured findings: advisory entries omit remediation;
   blocking entries declare `production`, `test`, or `both` ownership and exact authorized
   `test_paths` when test-owned. Do not translate these into legacy `evidence.test_remediation`.
   If `record` rejects because exact validation or attestation is absent, do not repair in the
   parent: continue the same physical agent with the exact errors. It has at most two correction
   submissions after its initial validation and must return a complete replacement.
   If `next_action.kind` is `redispatch_same_ticket`, wait for the observed SubagentStop, call
   `ape_run next` (or `resume` during recovery), and launch only the returned same-ticket dispatch;
   this does not consume a logical stage attempt. If that worker exhausts its
   correction allowance, the runtime blocks as `worker_protocol_failure`. Never translate a receipt
   contract or infrastructure failure into a reviewer vote, product remediation, directed replan,
   abort, or successor. Call `next` only after the returned dispatch group is fully recorded.
6. If recording preflight returns `input_required`, obtain complete exact answers for all question
   ids and submit one aimed `answer-preflight` action with the exact hash, a bounded audit `reason`,
   and additive-only `claimed_paths`, `test_paths`, and canonical `risk_triggers`. Do not dispatch a
   writer while the hold remains.
7. After all receipts in the returned group are recorded, call `ape_run next` and repeat until the
runtime reports `completed`, `blocked`, or a budget pause. `next_action: {"kind":"extend_budget"}` requires
an explicit operator-approved monotonic budget extension; send a nonblank audit `reason` and at
least one new top-level `max_worker_dispatches` or `max_active_seconds` value. Never start a
successor automatically.
When it reports `gating_pending` or `shipping_pending`,
make the next call with `wait_ms: 300000` so APE performs bounded server-side polling with progress
heartbeats. On Codex, do not sleep inside a `functions.exec` wrapper before the APE call: starting an
MCP call at the wrapper's yield boundary can expose a host transport retry. If a gating wait returns
`shipping_started`, make a new `next` call with `wait_ms: 300000` for shipping. Remediation routes
are scheduler-owned and serialized: production, test, and mixed/both findings select build; test
then review; or test then build then review respectively.

When a blocked run retains a dirty APE branch and the user explicitly asks APE to keep going, start
one successor with `supersedes_run` set to the exact blocked run id and the same or additive claims.
The runtime admits this only when the checked-out tree exactly matches the blocked tree, the default
tip has not moved, and every dirty path is claimed; it then carries that tree and the latest
unresolved review findings into the successor ticket. Never recreate the diff manually, omit the
supersession link, or use this path for unrelated dirty work.

If the runtime reports an active bound dispatch, wait. If it reports
`dispatch_retirement_pending`, wait for the original agent unless the flight is genuinely orphaned
or wedged; only then may the user authorize `expire-dispatch` with the exact ticket ID and a
non-empty audit reason. Never free-hand a retry, remediation stage, gate, merge, or history record.
