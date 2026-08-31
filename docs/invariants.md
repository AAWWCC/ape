# Invariants

APE 2's universal invariants are `contracts.post_compaction_rules` — the load-bearing constraints
of the whole runtime. They are the successor to APE 1's PCRs (`pcr-01…pcr-13`).

The difference is the mechanism. APE 1 re-injected the PCRs as prose into the main session on every
`SessionStart` and trusted the model (plus a fleet of hooks) to obey them. APE 2 **enforces** the
invariants by construction: the deterministic scheduler, the lifecycle hook, and independent receipt
validation make a violation impossible or rejected, rather than merely discouraged. There is no
re-injection step because the machine does not rely on an agent remembering a rule it already
enforces.

## The nine

1. **Runtime-owned transitions.** The scheduler, not any agent, owns stage order, retries, model
   policy, gates, and completion.
2. **No main-session production writes.** Production code flows through a stage ticket; the main
   session authors only orchestration state and prose.
3. **Behavioral test independence.** Tests assert behavior, not the implementation that produced it;
   red-first work observes fail/fail, explicit green maintenance observes pass/pass, and
   non-behavioral work manufactures neither.
4. **Deterministic, tree-bound evidence.** Every receipt is validated against a recomputed tree SHA
   and changed-file set — claims are never trusted as written.
5. **One retry per failed stage and bounded, convergent remediation.** A new blocker set may receive
   another configured cycle; a repeated blocker or exhausted budget blocks immediately.
6. **Project and host agnosticism.** No host policy in an adapter, no hardcoded project tooling; the
   runtime runs identically under Claude and Codex.
7. **Serialized writers and atomic state.** Each runtime state domain has one lock-held writer and
   uses atomic writes. Receipt/service effects and MCP task generations have separate locks with a
   strict no-nesting boundary; task generations are append-only and hash-chained.
8. **Truthful completion.** A stage is complete only when its evidence independently reproduces; an
   agent returns `failed` rather than claiming unearned success. A proven remote merge is not
   rewritten as failed merely because local checkout cleanup must be retried.
9. **Gated auto-merge.** A run merges only after every merge gate passes; protected-branch
   auto-merge remains pending until the exact attested head is observed merged.

## Where each is enforced

| Invariant | Enforced by |
| --- | --- |
| Runtime-owned transitions | `lib/runtime/scheduler.js` — a pure `RunState + Event → Action[]` reducer |
| No main-session production writes | `lib/runtime/hooks.js` ticket / path-claim policy; `prompts/common.md` agent contract |
| Behavioral test independence | `test_writer` role boundary + runtime-owned `required_checks` (`red-test` or `green-test`); receipt observations |
| Deterministic, tree-bound evidence | `lib/runtime/receipt-validator.js` recomputes the tree SHA and changed files |
| One retry + convergent remediation | `lib/runtime/constants.js` bounds plus reducer finding fingerprints |
| Project / host agnosticism | `lib/runtime/adapters.js` (Claude / Codex); no literal tooling in the core |
| Serialized writers + atomic state | `lib/runtime/lock.js` + `storage.js` atomic writes; `lib/runtime/task-store.js` owns the MCP-only tasks lock and immutable generation journal, never nested with the receipt-effects lock |
| Truthful completion | receipt hash chain + independent recompute in `receipt-validator.js` |
| Gated auto-merge | `lib/runtime/gates.js` `runMergeGates` / `autoMergeGithub` |

## The per-agent slice

Each native subagent receives the compressed, enforced subset as the "native-agent contract" in
`prompts/common.md`: work only on the ticket objective and claimed paths; do not write `.ape/`
runtime state; never spawn another agent; do not commit, push, merge, weaken tests, or change scope;
return `failed` rather than claim success. The runtime independently recomputes the tree SHA and
validates role boundaries before accepting the receipt, so an agent that ignores its contract is
caught structurally.

## Experimental task durability

MCP task handles do not weaken invariant 7 or introduce a protocol session. They name a bounded,
root-bound journal below `.ape/runtime/tasks/`. A task's generation zero is atomic and durable
before its handle is returned; every later generation is serialized, immutable, and linked to its
predecessor by hash. Service-side charged effects commit under the existing receipt-effects lock,
then publish their exact result under the tasks lock only after releasing the service lock. Crash
recovery may bridge those two durable records, but it never holds both locks and never reruns an
effect already recorded as committed. Operation transactions are themselves private, root-bound,
schema-validated, hashed, size-bounded, and TTL-collected into bounded audit tombstones.

Cancellation follows the same truthful-completion rule as receipts: a cancellation acknowledgement
records intent, not instantaneous termination. Only verified process-local ownership may be
signalled, attributable gate processes are reaped before the terminal generation is published, and
foreign or stale ownership fails closed. TTL collection may remove expired task bodies only after
preserving an auditable chain-tail hash; those audit records have bounded retention too.
