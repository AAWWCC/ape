# MCP tools

APE exposes exactly four tools. Skills are the normal user interface; these actions are the
machine contract behind them.

| Tool | Actions |
| --- | --- |
| `ape_run` | `probe`, `probe-status`, `probe-ack`, `start`, `next`, `record`, `status`, `resume`, `regate`, `ship`, `expire-dispatch`, `abort`, `override` |
| `ape_status` | Dedicated read-only current-run, pending-ticket, lane, and gate snapshot. |
| `ape_history` | `query`, `explain`, `metrics`, `import`, `maintenance-status`, `compact-artifacts`, `roadmap-status`, `roadmap-register`, `roadmap-supersede` |
| `ape_config` | `get`, `set`, `doctor`, `wire`, `unwire`, `init` |

Inputs are bounded at 64 KiB UTF-8. Responses use bounded summaries; full tickets, receipts, and
run records remain under `.ape/runtime/`.

## `ape_run`

### Start and advance

- `start` validates objective, host, mode, lane, path claims, test paths, requirements, risk, host
  capabilities, and explicit invocation before creating a branch or run. Behavioral fast/full runs
  require `test_paths`. `land` additionally requires a non-empty existing diff entirely inside
  `claimed_paths`.
- `record` accepts an agent receipt draft. The runtime adds and verifies identity, tree/test
  evidence, observed external-tool effects, hashes, and the next transition.
- `next` advances one pending transition or polls a `gating`/`shipping` watch.
- `ape_status` is the canonical read-only status tool. The `ape_run` `status` action remains a
  deprecated compatibility alias. `resume` returns the action needed to continue an interrupted
  run.

`ok: false` is a runtime refusal and means the action changed nothing. A refused lever never hides
the error inside a successful `actions` array.

### Long-running calls

Final-stage `record`, `regate`, and `ship` run cheap gate checks first, then launch the configured
suite in a detached process. The call waits for `gates.inline_grace_ms`; if the suite is still live,
it returns with the run in `gating` instead of holding the tool call indefinitely.

`next` accepts optional `wait_ms` while a run rests in `gating` or `shipping`. It repeats the same
bounded poll with the receipt lock released between polls. The budget is clamped by
`GATE_NEXT_MAX_WAIT_MS` (300000 ms) and sleeps are floored by `GATE_NEXT_POLL_FLOOR_MS` (250 ms).
A gating watch that enters required-check `shipping` stops there; call `next` again to drive the
second watch.

Hosts that send `_meta.progressToken` receive a progress notification every ten seconds for a
long synchronous call. Native-agent flights use the host's agent wait primitive instead of status
polling. `SubagentStop` records observed termination; an elapsed deadline alone does not authorize a
duplicate physical agent.

`ship` and `regate` reject a run in the non-blocking watch states `gating` or `shipping` and point
to `ape_run next`, which is the action that advances those states. A gate-blocked run points to
`regate`; a green auto-merge hold points to `ship`.

### Recovery actions

- `regate` re-runs a failed merge gate. The attempt budget is bounded.
- `ship` requires an audit reason and applies only to a green run held because
  `shipping.auto_merge` is false. It re-proves all gates against the current tree.
- `expire-dispatch` requires a pending `ticket_id` and audit reason. It voids a genuinely orphaned
  or wedged dispatch, consumes the attempt, and issues a fresh ticket when the retry budget permits.
- `abort` seals the current run. `override` supports reason-audited `abort` and `reset` operations;
  an unaimed reset can recover an orphaned lock.

`abort` and `override` may include `run_id` as a confirmation, never as a selector. A mismatched or
explicitly null aim refuses before any effect. Other actions reject `run_id`. If `active.json` is
unreadable, use an unaimed `override reset`; the runtime cannot safely confirm an aimed recovery.

### Codex binding preflight

Codex `start` requires a fresh live capability proof:

1. `probe` returns `dispatch_probe` after ordinary doctor checks.
2. Spawn it with the returned task name, model, reasoning effort, and message unchanged. The
   returned type is APE's logical probe role, not a Multi-Agent V2 native argument.
3. PreToolUse consumes the visible task-name capability; `SubagentStart` must bind the host child and
   inject a probe capability.
4. `probe-status` must show a bound canary awaiting acknowledgement.
5. Send its `probe_id` and `probe_capability` to `probe-ack`; `start` atomically consumes the
   completed, single-use proof before its first Git mutation.

Manifest wiring is only a static package check; it does not prove that the current Codex session
delivers lifecycle events. Missing, expired, replayed, or observed-but-unbound probes fail as
infrastructure without creating a run or consuming a stage attempt. Claude uses its existing native
binding path and does not run this preflight.

### External-tool claims

`tool_claims` use `provider:resource:read|write|execute`. They govern already-connected Unity,
Blender, Playwright, GitHub, Codex Security, and explicitly claimed plugin MCP reads; a claim does
not install or connect a provider. Availability and attestation are host-specific:

| External surface | Codex | Claude Code |
| --- | --- | --- |
| Unity, Blender, Playwright exact adapters | Host-neutral policy fixtures cover classification; live availability depends on the connected server. | Same policy implementation, with no claim of live provider parity. |
| GitHub `codex_apps` connector | Exact reviewed read operations are attested; mutations fail closed. | Unavailable as a claimed Claude integration. |
| Reviewed GitHub MCP server identity | Exact read classification is covered; provider connectivity remains external. | Classification exists, but no live Claude attestation is claimed. |
| Codex Security | Read-only triage inspection is attested; mutating lifecycle operations fail closed. | Not attested or advertised. |
| Other namespaced plugin MCP | Exact read-only ticket claims are supported with drift reconciliation. | The policy branch exists, but discovery/connectivity is not attested. |

Examples:

- `unity:console:read`
- `blender:scene:execute`
- `playwright:origin:https://example.com:execute`
- `github:repo:owner/repository:read`
- `github:pull:owner/repository#42:read`
- `codex-security:triage:scan-id:read`
- `my-plugin:tool:get_status:read`

A trailing `*` is a prefix wildcard; otherwise matching is exact. Every resource in a call needs
coverage, and filesystem effects must still fit `claimed_paths` or `test_paths`.

Raw code execution is a separate high-risk capability. Playwright unsafe code, Blender Python, and
Unity raw-code/menu execution require a writable ticket, a high-risk run, and an exact non-wildcard
`<provider>:server-rce:execute` claim. Broad page, scene, editor, or provider claims are insufficient.
GitHub support is intentionally read-only during a governed run. The reviewed adapter classifies
the named GitHub server's repository, issue, pull-request, Actions, notification, discussion,
project, and security inspection tools. It also covers the Codex app connector's
`mcp__codex_apps__github_*` operations with a separate exact read allowlist.
GitHub mutations—including file changes, issue updates, PR creation, reviews, pushes, and merge—
remain unknown and fail closed; APE's gate/ship runtime retains shipping ownership. Codex Security
admits only its read-only triage-result viewer; scan setup, progress, completion, and remediation
updates stay blocked.

An unreviewed namespaced plugin MCP can be used only for a read when the sealed ticket has the exact
`<server>:tool:<operation>:read` claim. Provider, resource, or operation wildcards do not upgrade
an unknown tool, and neither `write` nor `execute` claims can do so. APE conservatively runs its
filesystem drift guard after these claimed plugin reads. This policy support is not a claim that a
particular plugin is installed or available on both hosts. All other unknown operations/providers,
unclaimed resources, main-session mutation, and writes by read-only roles fail closed. Successful
and failed calls are observed by hooks and sealed into the receipt's `tool_effects`; agent-supplied
effects are ignored.

## Artifact maintenance

Terminal transitions keep recent run artifacts and perform bounded best-effort compaction of older
redundant snapshots. `maintenance-status` reads the last result without changing anything.

`compact-artifacts` requires an audit `reason`; `keep_recent_runs` defaults to 32 and `max_runs` to
64 (hard maximum 256). It writes and re-reads a byte-exact gzip archive before deleting only source
files whose bytes still match. Immutable history, audit logs, prepared transactions, changed data,
and the active/sealed run are never removed. A bad candidate is retained and reported without
stopping later candidates.

## Roadmap verbs

The optional roadmap is stored at `.ape/runtime/roadmap.json`. Its statuses are derived from the
store, requirements/history, and the active run. It does not schedule runs, but a live roadmap
target may start or complete only while every transitive dependency is `satisfied`; stale targets
and stale, pending, ready, in-progress, or unknown dependencies fail closed with their IDs.

- `roadmap-status` is read-only and returns `roadmap: null` when no roadmap exists.
- `roadmap-register` atomically adds up to 64 entries with `id`, `title`, `description`,
  `acceptance`, optional `depends_on`/`discovered_by`, and a required audit reason. The complete
  prospective live graph is validated before mutation: same-batch forward references work, while
  unknown/stale dependencies, duplicate edges, self-reference, and cycles reject the whole batch.
  Do not send
  `status`. Each entry must name a behavioral consequence if it is never done. This bar applies to
  entries, not findings: reviewers still report all findings in durable receipts. A prose-only nit
  is folded into `doc-and-comment-accuracy-sweep` or dropped with reasoning rather than promoted to
  its own roadmap item.
- `roadmap-supersede` marks known live entries stale with a reason and optional `replaced_by`; it
  does not delete them. Targets and replacements must be unique, known, live, and disjoint, and the
  remaining live dependency graph must still be valid.

Both mutations use a bounded single-operation journal. The roadmap store lands before the override
audit line, and the same mutation ID appears in the entry audit, journal, and override record.
Retries recover unapplied, applied-but-unaudited, and committed operations exactly once; a store
matching neither recorded hash is divergent and is never overwritten.

`receipt.evidence.roadmap_followups` is the enforceable proposal channel: at most 64 normalized
entry declarations, with no `status` or `discovered_by`. A non-operator `discovered_by` on
registration must name an active or archived run containing an accepted receipt with an exact
declaration match. Receipt acceptance never auto-registers an entry; explicit approval and a
separate `roadmap-register` call remain required.

Derived entries are `satisfied`, `in_progress`, `ready`, `pending`, or `stale`. `status_filter`
limits returned entries without changing whole-roadmap counts.

## `ape_config`

- `get` returns effective defaults plus overrides; `set` validates known dotted keys and keeps the
  persisted overlay sparse.
- `init` detects common project test runners and proposes commands. `apply: true` persists an
  operator-approved proposal.
- `doctor` checks state/lock health, git, configuration, bundles, host preconditions, and known
  editor declarations. A declared MCP provider is not proof of a live editor connection.
- `wire` / `unwire` configure Claude's command-backed APE statusline or Codex's closest native TUI
  footer. Pass `host` explicitly.

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

The tasks extension is deliberately opt-in; a blanket migration of all long calls was not
attempted. A client that never negotiated tasks could not poll or cancel a server-minted handle,
leaving abandoned work, so ordinary calls preserve the synchronous/watch contract.

Task generations are private, root-bound, immutable, hash-chained records under
`.ape/runtime/tasks/`. Cancellation is cooperative: acknowledgement means the request is durable,
not that termination is instantaneous. Operation journals prevent committed effects from running
twice after recovery. Reissuing a task-creating call whose task id was lost is deliberately not
treated as the same intent because MCP supplies no client idempotency key; once the task id is
known, repeated `tasks/get` is safe.

## Developing this repository

The installed plugin already registers the `ape` MCP server. This repository's `.mcp.json` also
registers a source/development server, so a checkout can expose it twice. For Claude development,
disable the checkout registration in `.claude/settings.local.json` when using the installed copy:

```json
{ "disabledMcpjsonServers": ["ape"] }
```

Regenerate the host packages with `npm run package:plugins`. Codex development updates can then use
`npm run reinstall:codex`; see the README for the immutable-cache development flow. Both generated
MCP declarations launch the local bundle over stdio. A hosted APE broker is outside this release.
