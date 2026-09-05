# Architecture

APE separates decisions from effects. The scheduler chooses the next action; services perform
I/O; host adapters launch native agents.

```text
skill / MCP call
      ↓
service (I/O and effects)
      ↓
scheduler (state + event → actions)
      ↓
Claude Agent tool or Codex native subagent
```

Four public entry modules re-export the implementation modules:

| Entry module | Implementation owners |
| --- | --- |
| `service.js` | `lifecycle-service.js` for orchestration; `receipt-service.js` for receipt processing; `status-service.js` for queries. |
| `hooks.js` | `evidence-policy.js` for commands; `write-policy.js` for writes; `lifecycle-policy.js` for binding; `path-scope.js` for test paths. |
| `gates.js` | `gate-evaluation.js` for decisions; `gate-watch.js` for detached suites; `github-shipping.js` for GitHub effects. |
| `scheduler.js` | `reducer.js` for transitions; `review-evidence.js` for bounded review data. |

Lifecycle services use receipt and status services; `history.js` owns terminal history. Gate
watchers and shipping may use gate evaluation, never the reverse. Service code imports `gates.js`
so tests and hosts can replace that interface. Adapters translate dispatches, not policy.

## State

Project state lives under `.ape/runtime/`. Do not edit it by hand.

| Path | Purpose |
| --- | --- |
| `active.json` / `active.lock` | One active run and its exclusive lock. |
| `runs/<id>.json` | Mutable or sealed run snapshots. |
| `tickets/` / `receipts/` | Immutable stage contracts and results. |
| `receipt-transactions/` | Records that prevent receipt effects from running twice. |
| `dispatch-intents/` | Single-use launch and receipt capabilities. |
| `history/<id>.json` | Immutable terminal history. |
| `artifact-archives/` | Verified gzip archives of older redundant artifacts. |
| `requirement-index.json` | Requirement-to-run completion index. |
| `roadmap.json` | Optional roadmap; statuses are calculated from evidence. |
| `roadmap-mutation.json` | Journal for the latest roadmap change. |
| `suite-cache.json` | Passing suites keyed by tree and resolved command. |
| `status.md` | Human-readable active-run status. |
| `overrides.ndjson` | Append-only override audit. |

Writes use same-directory temporary files, `fsync`, and rename. Locks serialize state and receipt
effects. Tickets and receipts bind the run, tree, role, and capability.

Roadmap changes journal the before/after hashes before updating the store and audit. Recovery
rejects conflicting records. Registration validates the dependency graph and receipt provenance.
Run start and completed archival recheck that dependencies are `satisfied`. Projects without a
roadmap do not need one.

## Terminal state and retention

`completed`, `blocked`, and `aborted` stop ordinary scheduling. Completed and aborted runs are
sealed. A blocked run may allow an audited recovery action. Its later completion adds a
superseding record; it never rewrites the original history.

Once history is durable, retention may archive old snapshots, tickets, receipts, and committed
transactions. Archives are re-read and hash-checked before matching originals are removed.
History, audits, prepared transactions, changed files, and active/sealed state remain available.
Use `ape_history maintenance-status` to inspect retention or `compact-artifacts` for an audited,
bounded cleanup.

## Loaded bundles

Hosts run the bundles they loaded from `dist/`, not the current source. A rebuild alone does not
update a running process.

- Cached plugin: rebuild, explicitly reinstall, then start a new host task.
- Checkout-loaded plugin: rebuild, then restart the MCP server/session.

`ape_config doctor` reports `bundle-drift` between the checkout and executing bundle.
`loaded-module-drift` checks an actual loaded bundle stamp when available. Running source cannot
prove which bundle another process loaded.

## Bundle reachability

| Entry point | Bundle |
| --- | --- |
| `bin/ape-mcp.mjs` | `dist/ape-mcp.bundle.mjs` |
| `bin/ape-hook.mjs` | `dist/ape-hooks.bundle.mjs` |
| `bin/ape-larp.mjs` | `dist/ape-larp.bundle.mjs` |

Check whether a source module reaches a bundle with:

```bash
npm run bundle:reach -- lib/runtime/runner.js
```

This uses esbuild metadata. Searching minified text is unreliable because tree-shaking changes
names. Release validation checks each required implementation module, then copies the three
bundles into both host packages.

The lane classifier treats generated `plugins/<host>/dist/` and `release/generated/` files as
mechanical. It does not give unrelated nested `dist` or `build` directories that exception.

## Trust boundary

Agents propose work and return receipt drafts. The runtime checks identity, capabilities, paths,
tree hashes, test results, receipt hashes, transitions, and gates. Agent text grants no authority;
external MCP permissions remain with the host and operator.

Hooks enforce ticket rules on APE-owned shell, write, dispatch, control, and receipt tools. Bound
children cannot use parent control operations or ambiguous write/execute paths. External MCP calls
still use host permissions; APE checks their repository effects at worker and receipt boundaries.

Remote completion and local cleanup are separate. `github-shipping.js` proves the exact pushed
head was merged. `receipt-service.js` records cleanup as `returned`, `retained_dirty`, or
`retained_error`. A local worktree conflict does not undo a proven merge.
