# Architecture

APE has a deterministic core and thin host adapters.

```text
skill / MCP call
      ↓
service (I/O and effects)
      ↓
scheduler (pure state + event → actions)
      ↓
Claude Agent tool or Codex native subagent
```

The four long-standing runtime entry modules are compatibility facades. They contain direct
re-exports while the domain modules own the implementations:

- `service.js` exports lifecycle orchestration from `lifecycle-service.js`, receipt admission and
  finalization from `receipt-service.js`, and service-facing queries from `status-service.js`.
  `lifecycle-service.js` consumes the receipt and status services; `history.js` remains the
  lower-level immutable history store.
- `hooks.js` exports evidence-command rules from `evidence-policy.js`, write and tree rules from
  `write-policy.js`, lifecycle/binding rules from `lifecycle-policy.js`, and test-path classifiers
  directly from `path-scope.js`.
- `gates.js` exports pure gate decisions from `gate-evaluation.js`, detached-suite observation
  from `gate-watch.js`, and guarded GitHub operations from `github-shipping.js`.
  Watch and shipping code may consume gate evaluation; gate evaluation does not depend on either.
- `scheduler.js` exports the deterministic reducer from `reducer.js` and bounded review evidence
  from `review-evidence.js`. The reducer consumes that one review-evidence API.

Service code continues to import `gates.js` intentionally. That facade is the established test and
host substitution seam even though the physical gate implementations live behind it. Adapters
translate only role/model policy and dispatch shape; they do not make scheduling decisions.

## State

Project state lives under `.ape/runtime/`:

| Path | Purpose |
| --- | --- |
| `active.json` / `active.lock` | The single active run and its exclusive lock. |
| `runs/<id>.json` | Full mutable/sealed run snapshots. |
| `tickets/` / `receipts/` | Immutable stage contracts and results. |
| `receipt-transactions/` | Idempotency records for receipt effects. |
| `dispatch-intents/` | Single-use launch and receipt capabilities. |
| `history/<id>.json` | Immutable terminal history. |
| `artifact-archives/` | Verified gzip archives of redundant old artifacts. |
| `requirement-index.json` | Requirement-to-run completion index. |
| `roadmap.json` | Optional audited project roadmap; statuses are derived, not stored. |
| `roadmap-mutation.json` | Bounded exact-once journal for the latest roadmap mutation. |
| `suite-cache.json` | Passing suite results keyed by tree and resolved command. |
| `status.md` | Human-readable projection of the active run. |
| `overrides.ndjson` | Append-only audit log for override-class operations. |

Writes use same-directory temporary files, `fsync`, and rename. Lock and receipt-effect mutations
are serialized. Roadmap mutations persist a before/after-hash journal, then the store, then a
mutation-ID-deduplicated override audit; recovery refuses divergent durable state. Tickets and
receipts are run-, tree-, role-, and capability-bound.

The roadmap remains optional. When present, registration validates the complete prospective live
dependency graph and accepted-receipt provenance. Run start and completed archival recheck that
every dependency of a roadmap-backed requirement is currently `satisfied`; ordinary requirement
IDs and roadmap-less projects retain their existing path.

## Terminal state and retention

`completed`, `blocked`, and `aborted` are terminal for ordinary scheduling. A blocked run can still
leave through an audited recovery action; completed and aborted runs are sealed. Every terminal
transition is written to immutable history. Recovery that later completes a blocked run creates an
effective superseding record rather than mutating old history.

After history is durable, best-effort retention keeps recent and active artifacts directly
addressable and can archive older snapshots, tickets, receipts, and committed transactions.
Archives are re-read and hash-verified before matching source files are removed. History, audit
logs, prepared transactions, changed files, and active/sealed run data are retained. Use
`ape_history maintenance-status` to inspect the last sweep and `compact-artifacts` for an audited,
bounded catch-up.

## Loaded bundles

Installed hosts execute the bundles they loaded from `dist/`, not live source modules. Rebuilding
this repository does not update an already-running MCP process or hook.

- With a cached install, rebuild/reinstall and start a new host task.
- With the plugin loaded directly from the checkout, rebuild and restart the MCP server/session.

`ape_config doctor` reports `bundle-drift` when the checkout and executing bundle differ. Its
`loaded-module-drift` check can compare a loaded bundle stamp when the current process actually
loaded that candidate. Source execution cannot claim that same proof, so the check reports its
limit instead of inferring freshness.

## Bundle reachability

The shipped artifacts are built from:

- `bin/ape-mcp.mjs` → `dist/ape-mcp.bundle.mjs`
- `bin/ape-hook.mjs` → `dist/ape-hooks.bundle.mjs`
- `bin/ape-larp.mjs` → `dist/ape-larp.bundle.mjs`

Do not infer reachability by grepping minified bundles; tree-shaking can remove names while keeping
behavior. Use:

```bash
npm run bundle:reach -- lib/runtime/runner.js
```

The command uses esbuild metadata. For example, `lib/runtime/runner.js` contributes to the MCP and
LARP bundles, not the hooks bundle.

Release validation checks all eleven domain owners through this metadata, then copies the three
root bundles into both plugin distributions. This proves that the owners required by an entry
point are actually reachable without relying on symbol names surviving tree-shaking.

The lane classifier treats the generated copies under `plugins/<host>/dist/` and staged
`release/generated/` output as mechanical while keeping unrelated nested `dist`/`build` source
trees behavioral. This makes release/package regeneration schedulable without broadening the
generated-path exception across a monorepo.

## Trust boundary

The model proposes work and returns receipt drafts. The runtime independently supplies or verifies
identity, ticket capability, paths, tree hashes, test observations, external-tool effects, receipt
hashes, stage transitions, and merge gates. Agent text never grants authority.

Lifecycle hooks enforce this boundary at tool time. Main-session control-plane calls remain
available, while a bound child may act only within its immutable ticket. Unknown or ambiguous
write/execute paths fail closed during an active run.

Shipping truth and local checkout hygiene are separate. `github-shipping.js` proves the exact
pushed head and remote merge before completion; `receipt-service.js` then reconciles the local
checkout and persists `returned`, `retained_dirty`, or `retained_error`. A local worktree ownership
conflict can therefore be retried without changing immutable remote-merge provenance.
