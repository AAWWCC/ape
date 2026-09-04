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
   strict no-nesting boundary; task and capability-recovery generations are append-only and
   hash-chained.
8. **Truthful completion.** A stage is complete only when its evidence independently reproduces; an
   agent returns `failed` rather than claiming unearned success. A proven remote merge is not
   rewritten as failed merely because local checkout cleanup must be retried.
9. **Gated and authorized auto-merge.** A run merges only after every merge gate passes and the
   shipping sink rechecks either the run's frozen `auto_merge_authorized` bit—derived at start from
   explicit invocation plus configured auto-merge—or its audited, one-shot `SHIP` marker;
   protected-branch auto-merge remains pending until the exact attested head is observed merged.
   Strict shipping resolves `origin` once into an immutable verified remote URL plus the canonical
   `AAWWCC/ape` repository slug; every push and `gh` command receives that target explicitly, so a
   later remote rebind cannot redirect the mutation.

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

## Capability-recovery generations

A receipt-contract-v1 capability denial may request one additive successor rather than consume a
product retry. Before any receipt, ticket, contract, state, audit, history, or shipping sink, the
runtime recomputes and validates one exact prepared-effect binding. It covers the source
ticket/receipt/stage/role/attempt, policy and model, lane and risks, production and test scope,
orchestration counters, issue/deadline times, field and byte budgets, capability manifest, run
contract, recovery lineage, and both the predecessor and successor generation identities.

Those derivation inputs come from the immutable run-contract catalog and its exact ticket recovery
authority, never from mutable `active.json` or a later live configuration. Fresh preparation and
adoption of an already-published receipt run the same schema, binding, policy, filesystem, and
prepared-runtime validation before any selector or compatibility projection changes.

The successor is runtime-derived exactly once. Its v4 UUID ticket id and canonical filename,
receipt/output schemas and hashes, predecessor receipt hash, claims, policy, risk/lane, timing,
manifest/run-contract pointers, ceilings, and runtime provenance must all agree. Missing, extra,
stale, duplicate, replayed, caller-forged, or self-consistently rebound material is rejected before
consumption. Every lineage monotonically retains validation usage: no physical worker may submit
more than three validations and no ticket lineage may consume more than two physical workers.

Initial admission and recovery use the same exact test-path representation. Paths must be unique,
canonical, contained project-relative names; absolute, parent-relative, `.ape`-reserved, alias, and
option-like values are refused. The complete additive union is computed before mutation and is
limited to 64 items and 4096 serialized UTF-8 JSON bytes.

After validation, the runtime writes a complete immutable recovery generation, including the
successor, receipt, run-contract/schema, transaction, and adopted state, beside the generation
store. A single same-filesystem directory rename publishes it under its hash-bound canonical name.
Its bounded exact manifest seals every canonical regular-file name, raw byte hash, byte length, and
filesystem identity; extra directories, hard links, missing members, and substitutions immediately
before or after rename fail loudly. Only then does an append-only content-addressed selector edge
make the generation the unique head. Zero valid children is the head, one advances, and multiple
valid children are a fail-closed fork. Invalid selector source slots remain in place as retained
semantic evidence; a collision-safe evidence record binds the pathname, device/inode identity, raw
bytes and byte hash, and claimed lineage. A changed or rebound pathname is rescanned, and the
validated selector/head chain remains the authoritative source of truth.
Compatibility projections, including `active.json`, are repaired only from that head. A process
death therefore leaves the old head or a complete new generation that retry can adopt; incomplete
staging data is inert. The receipt-effects lock binds its token to process identity and lifecycle:
`EPERM` and unknown probe errors mean an active owner is alive, while `ESRCH` or the locally owned
release path's in-memory retiring token permits atomic retirement of the whole stale directory.
Every post-selector projection replacement, active-state adoption, receipt-binding completion, and
successor-dispatch write uses the same lease-guarded mutation primitive, which verifies token plus
directory device/inode both before and after the sink. A failed check stops every later sink. A
cooperating contender cannot create the apparent final check-to-sink race: a live owner process is
not stealable, and the locally retiring token is set only after its callback returns. A process with
the same filesystem privileges that bypasses APE and writes a destination directly is outside the
lock's trust boundary—it could alter that destination without touching the lock at all.

Every member is size-checked before allocation, read through a bounded stream, and charged against
a cumulative generation limit; directory walking uses an early entry cap. Selector publication and
semantic-evidence recording revalidate the held lock token plus lock-directory device/inode at the
mutation boundary. Evidence recording also revalidates the slot device/inode/bytes, publishes a
non-clobbering record, and verifies that the retained identity is unchanged. A reachable non-head edge cannot roll the
head or projections backward. A validated selectorless legacy generation `N` is migrated by
publishing a new append-only `N+1` generation and selector, never by reusing or rewriting `N`.

Legacy receipt-v1 artifacts remain readable without default insertion or byte rewriting. Legacy
recovery that lacks the complete binding is deliberately non-adoptable. Worker receipts, recovery
payloads, path arrays, persisted recovery records, lock bytes, and crash timing are untrusted; only
runtime-derived canonical material and a validated lock owner cross the adoption boundary.

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
