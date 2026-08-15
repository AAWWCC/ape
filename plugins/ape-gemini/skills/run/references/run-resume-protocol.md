# Run and resume protocol

The parent orchestrator owns every APE control call. It never performs stage work itself.

1. Before a Codex `start`, complete the runtime's binding probe: call `ape_run probe`, launch the
   returned `dispatch_probe` with its exact native agent name, model, reasoning effort, and message,
   confirm `probe-status` is bound, then acknowledge the returned probe capability with `probe-ack`.
   The returned agent type is APE's logical role, not a Multi-Agent V2 native argument. Stop on any
   mismatch. `start` consumes this fresh, single-use proof. Claude does not use this probe.
2. For each `dispatch_agent`, use the host-native tool and pass the generated name, model, optional
   reasoning effort, and dispatch intent exactly. On Claude, also pass the action's agent type; on
   Codex Multi-Agent V2, that field is APE's logical policy role and is not a native tool argument.
   Never substitute a model, semantic task name, SDK, nested CLI, or API call.
3. Compose the child's context from the complete common prompt, the complete role prompt, and the
   action's immutable ticket. On Codex, inline them after the dispatch-intent prompt in that order,
   labeled `APE common contract`, `APE <role> contract`, and `Immutable StageTicket`. On Claude,
   use the returned plugin agent wrapper, which loads the same prompt files, and append the ticket.
4. Launch distinct tickets as returned. On Codex, finish each spawn call and confirm its dispatch
   is bound before launching the next; bound agents may then run concurrently. Never launch two
   physical agents for one ticket. Wait through the host's native primitive; do not poll unchanged
   status.
5. Require exactly one receipt JSON matching the ticket's `output_schema`, including the exact
   injected `receipt_capability`. Call `ape_run` with `action: "record"` and place that complete
   receipt inside `receipt`. Never repair, fabricate, or omit agent evidence.
6. If recording preflight returns `input_required`, obtain complete exact answers for all question
   ids and submit one aimed `answer-preflight` action with the exact hash, a bounded audit `reason`,
   and additive-only `claimed_paths`, `test_paths`, and canonical `risk_triggers`. Do not dispatch a
   writer while the hold remains.
7. After all receipts in the returned group are recorded, call `ape_run next` and repeat until the
   runtime reports `completed` or `blocked`. Poll `next` while a shipping run reports pending remote
   checks.

If the runtime reports an active bound dispatch, wait. If it reports
`dispatch_retirement_pending`, wait for the original agent unless the flight is genuinely orphaned
or wedged; only then may the user authorize `expire-dispatch` with the exact ticket ID and a
non-empty audit reason. Never free-hand a retry, remediation stage, gate, merge, or history record.
