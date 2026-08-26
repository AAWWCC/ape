# Run and resume protocol

The parent orchestrator owns every APE control call. It never performs stage work itself.

On Google Antigravity / Gemini, pass the exact open project root as `project_dir` on every APE MCP
call. The plugin process runs from its installed package directory, so its process working directory
is never project authority. Use one native `invoke_subagent` call per returned ticket with the exact
`TypeName`, `Model`, and prompt; keep `Workspace` as `inherit`. The child's supported
`PreInvocation` hook binds its conversation before the first model turn.

1. Before a Codex `start`, complete the runtime's binding probe: call `ape_run probe`, launch the
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
   unchanged. It is the versioned, self-contained launch envelope: `message` already contains the
   dispatch-intent prompt, complete common prompt, complete role prompt, and immutable ticket in
   that order, labeled `APE common contract`, `APE <role> contract`, and `Immutable StageTicket`.
   `ticket_projection: "full"` means the complete ticket is inline; `"bounded"` carries only its
   immutable id/hash and explicit sanctioned `.ape/runtime/tickets/` path, so the child must load and
   verify the complete ticket before stage work.
   The exact native arguments include `fork_turns: "none"`: model/reasoning overrides are
   incompatible with the host's inherited-history default, and this message needs no parent history.
   Never reread `prompt_paths`, assemble a replacement message, or copy the compatibility
   `dispatch.model` object into the native `model` string argument. On Claude, use the returned
   plugin agent wrapper, which loads the same prompt files, and append the ticket. On Antigravity,
   compose its prompt from the complete common prompt, complete role prompt, and immutable ticket.
4. Launch distinct tickets as returned. On Codex and Antigravity, finish each spawn call and confirm
   its dispatch is bound before launching the next; bound agents may then run concurrently. Never launch two
   physical agents for one ticket. Wait through the host's native primitive; do not poll unchanged
   status.
5. Require exactly one receipt JSON matching the ticket's `output_schema`, including the exact
   injected `receipt_capability`. Call `ape_run` with `action: "record"` and place that complete
   receipt inside `receipt`. Never repair, fabricate, or omit agent evidence. A ticket with
   `review_contract_version` uses bounded structured findings: advisory entries omit remediation;
   blocking entries declare `production`, `test`, or `both` ownership and exact authorized
   `test_paths` when test-owned. Do not translate these into legacy `evidence.test_remediation`.
   The Codex dispatch's `next_control` states the same handoff compactly: record the returned
   receipt unchanged, then call `ape_run next` after the returned dispatch group is fully recorded.
6. If recording preflight returns `input_required`, obtain complete exact answers for all question
   ids and submit one aimed `answer-preflight` action with the exact hash, a bounded audit `reason`,
   and additive-only `claimed_paths`, `test_paths`, and canonical `risk_triggers`. Do not dispatch a
   writer while the hold remains.
7. After all receipts in the returned group are recorded, call `ape_run next` and repeat until the
runtime reports `completed` or `blocked`. Poll `next` while a shipping run reports pending remote
checks. Remediation routes are scheduler-owned and serialized: production, test, and mixed/both
findings select build; test then review; or test then build then review respectively.

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
