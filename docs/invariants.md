# Invariants

These are APE's core runtime rules, stored as `contracts.post_compaction_rules`. The scheduler,
hooks, and receipt validator enforce them. Session-start guidance explains the rules to agents;
the prose itself is not a security boundary.

## The nine

1. **Runtime-owned transitions.** The scheduler owns stages, retries, models, gates, and completion.
2. **No main-session production writes.** Stage workers edit production files under tickets. The
   parent handles orchestration and prose.
3. **Independent behavioral tests.** Tests check behavior independently of implementation.
   Red-first admission observes fail/fail; green maintenance observes pass/pass. Non-behavioral
   work claims neither.
4. **Tree-bound evidence.** The runtime recomputes the tree SHA and changed files before accepting
   a receipt. A worker's claim alone is insufficient.
5. **Bounded retries and remediation.** Each failed stage gets at most one retry. Further
   remediation requires a strictly smaller blocker set and available budget.
6. **Shared project and host policy.** Claude and Codex use the same core rules. Adapters do not
   decide policy, and project tooling comes from configuration.
7. **Serialized writes.** State changes use locks and atomic writes. Receipt effects and MCP task
   generations use separate locks, never held together. Task and recovery generations are
   append-only and hash-linked.
8. **Truthful completion.** A stage needs independently checked evidence to pass. A worker must
   report failure when it cannot prove success. A proven remote merge stays proven even if local
   cleanup fails.
9. **Authorized, gated shipping.** Merge requires passing gates and either frozen
   `auto_merge_authorized` consent from start or an audited one-shot `SHIP` marker. Every
   external operation rechecks the frozen origin, repository, and base. The canonical APE checkout
   is restricted to `AAWWCC/ape`; other projects need their own explicit target. Protected
   auto-merge remains pending until the exact pushed head is observed merged.

## Where each is enforced

| Invariant | Enforced by |
| --- | --- |
| Runtime-owned transitions | `lib/runtime/scheduler.js`: state + event → actions. |
| No main-session production writes | Ticket/path rules in `lib/runtime/hooks.js`; `prompts/common.md`. |
| Independent behavioral tests | `test_writer` boundary; runtime-owned `red-test` / `green-test` checks; receipt observations. |
| Tree-bound evidence | `lib/runtime/receipt-validator.js`. |
| Bounded retry and remediation | `lib/runtime/constants.js`; reducer finding fingerprints. |
| Shared project and host policy | `lib/runtime/adapters.js`; shared core configuration. |
| Serialized writes | `lib/runtime/lock.js`, `storage.js`, and the separate tasks lock in `task-store.js`. |
| Truthful completion | Receipt hash chain and independent validation. |
| Authorized shipping | `lib/runtime/gates.js`, `github-shipping.js`, and `shipping-target.js`. |

## Capability-recovery generations

A capability successor can add missing authority once for a receipt-contract-v1 ticket. It
cannot reset counters, broaden scope arbitrarily, or treat a worker's draft as an authenticated
receipt. Recovery authority comes from the immutable run contract, never mutable `active.json`
or later configuration.

### Binding and limits

Codex first records a provisional child, then binds it through the trusted `ape_bind` hook.
Provisional evidence and the MCP confirmation grant no authority. Binding checks the actual
model, parent link, immutable ticket, deadline, and single-child ownership before injecting
context. The parent must relay the bootstrap unchanged; APE does not infer a physical
spawn-to-UUID proof from matching turn IDs or transcripts. See [lifecycle hooks](hooks.md).

Before recovery has any effect, the runtime verifies one prepared binding covering:

- Source ticket, receipt, stage, role, attempt, policy, and model.
- Lane, risks, production/test scope, counters, issue time, and deadline.
- Schemas, hashes, field/byte budgets, capability manifest, and run contract.
- Predecessor and successor identities, receipt hash, and recovery lineage.

The successor must have the correct v4 UUID and canonical filename. Missing, extra, stale,
duplicate, forged, or rebound fields are rejected. New preparation and replayed receipt adoption
use the same schema, policy, filesystem, and runtime checks.

Each worker gets at most three validations; each ticket lineage gets at most two workers.
Test paths must be unique, canonical, contained project-relative names. Absolute, parent-relative,
`.ape`-reserved, alias, and option-like paths are rejected. The complete additive union is
checked before mutation: at most 64 paths and 4096 serialized UTF-8 JSON bytes.

### Publishing and replay

1. Write the complete successor, receipt, run contract/schema, transaction, and adopted state to
   a new immutable generation.
2. Check a bounded manifest of exact regular-file names, hashes, byte lengths, and filesystem
   identities. Reject extra directories, hard links, missing files, and substitutions.
3. Publish with a same-filesystem directory rename, recheck it, then append a content-addressed
   selector edge. The selector chain alone chooses the current generation.
4. Update compatibility projections, including `active.json`, only from that verified head.

Zero valid child edges means the current head; one advances it; multiple children are a rejected
fork. Invalid selector slots remain in place as retained semantic evidence. A collision-safe
record binds their path, device/inode, raw bytes/hash, and claimed lineage. Changed or rebound
slots are rescanned.

A crash leaves either the old head or a complete generation that replay can adopt; incomplete
staging data has no authority. The selector head remains the authoritative source of truth.
Replaying an ancestor never rolls back the head or projections.
A validated selectorless legacy generation `N` advances by publishing `N+1`, not rewriting
`N`. Legacy receipt-v1 bytes stay readable and unchanged; incomplete legacy recovery stays blocked.

### Locks and storage bounds

Every file is size-checked before allocation, read through a bounded stream, and counted against
a total byte limit. Directory walks have an entry limit.

Every selector, evidence, projection, state, receipt-binding, and dispatch write rechecks the
lease token and lock-directory device/inode before and after mutation. Evidence recording also
rechecks the retained slot's identity/bytes and never overwrites an existing record. A failed
lease check prevents later effects.

A live lock owner cannot be displaced by another cooperating process. `EPERM` or unknown
process-probe errors keep it alive; `ESRCH` or the local post-callback retiring token permits
stale-lock retirement. A same-privilege process writing files directly outside APE is outside
this lock boundary.

Worker receipts, recovery records, path arrays, lock bytes, and crash timing are untrusted.
Only validated runtime-derived data under a valid lock can be adopted.

## The per-agent slice

`prompts/common.md` gives each worker its ticket rules: stay within the objective and claimed
paths; do not write `.ape/` state, spawn agents, commit, push, merge, weaken tests, or expand
scope. Return failure when success cannot be proved. The runtime checks these claims against the
tree and role boundaries before accepting the receipt.

## Experimental task durability

MCP task handles identify bounded, root-bound journals under `.ape/runtime/tasks/`, not protocol
sessions. Generation zero is durable before a handle is returned; later generations are
serialized, immutable, and linked by hash.

Service effects commit under the receipt-effects lock. Their exact results publish under the
tasks lock only after that first lock is released. Crash recovery links the records without
holding both locks or rerunning committed effects. Operation transactions are private,
root-bound, schema-checked, hashed, size-bounded, and TTL-collected into bounded audit records.

Cancellation acknowledgement records intent, not immediate termination. Only verified
process-local owners may be signalled; attributable gate processes are reaped before publishing
a terminal generation. Foreign or stale ownership is rejected. Expired task bodies may be
removed only after retaining the chain-tail hash; those audit records also have bounded retention.
