# Changelog

## Unreleased

## 2.19.1 — 2026-08-17

Fixed the `answer-preflight` action MCP input deserialization bug where valid tool calls omitting optional scope fields (`claimed_paths`, `test_paths`, `risk_triggers`) or `run_id` were rejected with `input contains unsupported undefined data`.

Added support for optional `run_id` aim confirmation on `answer-preflight` actions.

Added explicit Gemini host dispatch adapter routing for stage ticket execution in the receipt service.

## 2.19.0 — 2026-08-17

Added the `ape_run preview` action for pure, zero-write pipeline forecasting, lane classification rationale, and deterministic worst-case dispatch bounds without modifying git branches or writing runtime state.

Added schema-guided receipt validation before subagent retirement across Claude, Codex, and Gemini, preventing malformed common, planning, preflight, and structured-review receipts from failing stage handoffs.

## 2.18.3 — 2026-08-15

Review and security findings now use bounded, versioned structures that route remediation to the
production writer, test writer, or a serialized mixed path while preserving advisory and legacy
behavior. Exact test scopes now reject unauthorized descendants before generic path claims can
admit them, including when an authorized file path is replaced by a directory.

Diagnostics and forwarded findings are character-safe, deterministic, atomically validated, and
bounded to their wire budgets. Public documentation, prompts, generated bundles, and all packaged
host variants carry the same structured-remediation contract.

## 2.18.2 — 2026-08-15

Versioned plan reviewers now receive the complete validated candidate plan instead of a truncated
legacy projection, including deterministic forwarding across concurrent review dispatches.

Preflight artifacts can now preserve accepted run objectives longer than 2,000 characters exactly,
while the existing 64 KiB whole-artifact bound and the per-field limits for all other preflight
prose remain enforced. This removes an impossible receipt contract where a valid long run objective
could neither be echoed exactly nor recorded.

## 2.18.1 — 2026-08-15

Fixed Google Antigravity app and `agy` compatibility against the current shared plugin contract.
Gemini hooks now use only supported lifecycle events, normalize Antigravity's camel-case nested
tool payloads, return event-specific response shapes, and resolve bundles from the installed plugin
directory. Native `invoke_subagent` launches now bind the child conversation during
`PreInvocation`, inject receipt capability context before its first model turn, preserve dispatch
liveness in status output, and carry an explicit encoded project root. Generated MCP declarations
and every Gemini skill now require the exact `project_dir`, preventing plugin-install cwd from being
mistaken for the governed checkout.

## 2.18.0 — 2026-08-15

The runtime implementation is now split behind thin, stable service, hook, gate, and scheduler
facades. Exact named exports and persisted behavior remain compatible, while focused internal
modules and an acyclic import graph make lifecycle, evidence, gate, and scheduling changes easier
to isolate and verify.

Behavioral runs now support a structured, read-only preflight analysis before writers start. The
result is hash-bound into the plan, material questions pause for audited operator answers, and
immutable verification profiles snapshot exact commands, roots, and timeouts as named merge gates.
Legacy plan contracts and persisted run data remain compatible.

First-class support for Google Antigravity / Gemini agents (`agy` CLI and Antigravity IDE). APE
now coordinates native subagent dispatches via `invoke_subagent` (mapping writable tickets to
`self` and read-only tickets to `research`), governs Antigravity tool mutations (`write_to_file`,
`replace_file_content`, `multi_replace_file_content`, `run_command`), provides `plugins/ape-gemini/`
packaging with `plugin.json`, `mcp_config.json`, and `hooks/gemini-hooks.json`, and supports model
tier mappings for `flash` (fast/balanced) and `pro` (deep).

## 2.17.4 — 2026-08-14

Codex run start is fail-closed on a fresh, live native-binding preflight again. APE now requires
the canary launch and child binding to be acknowledged, consumes that proof exactly once before
the first Git mutation, and reports missing, expired, replayed, or observed-but-unbound probes as
infrastructure failures without creating a run or consuming a stage attempt. Static hook-manifest
coverage remains a package check but is no longer described as proof of live lifecycle delivery.
Codex Multi-Agent V2 binding now records the host-effective `default` role separately from APE's
logical worker/explorer role, so production `SubagentStart` events bind instead of being rejected.

## 2.17.3 — 2026-08-13

Every APE run now starts on a fresh APE-owned branch created from the resolved default-branch tip,
regardless of the caller's current branch. Terminal runs reconcile the checkout back to that
persisted base branch: completed branches are deleted after clean reconciliation, while blocked and
aborted branches are retained. Dirty or failed cleanup preserves the run branch and exact recovery
details, and `ape_run resume` safely retries cleanup after the operator resolves the working tree.

`land` now refuses to start unless HEAD matches the resolved default tip, preventing feature-only
commits from leaking into a landing run. Shipping and cleanup use the persisted base branch, with a
compatibility fallback for older run state, and never delete a branch APE does not own.

## 2.17.2 — 2026-08-12

Codex runs now start directly and prove native binding on each real stage agent, matching Claude's
workflow instead of spending an extra agent launch on a mandatory pre-run canary. Multi-Agent V2
lifecycle events may omit `agent_type`; APE now uses the unique launched intent plus host-issued
child session and agent IDs in that case, while still rejecting an explicitly mismatched type. The
legacy probe actions remain optional diagnostics and no longer gate or modify run creation.

## 2.17.1 — 2026-08-12

Fix Codex native binding launches when the host omits `agent_type`. The runtime now preserves the
intended explorer role through that host-specific omission and keeps the binding probe and launch
dispatch aligned. This patch also carries the existing deterministic package, marketplace smoke,
and release-artifact guarantees forward under a new immutable plugin version.

## 2.17.0 — 2026-08-11

Initial public release. APE 2.17 introduces deterministic, allowlisted public packages for the
Codex CLI and Claude Code.
The repository marketplaces point to `plugins/ape` and `plugins/ape-claude`; each package starts
the bundled MCP server locally over stdio, and neither package contains private history, benchmark
records, or audio. A reproducibility gate rebuilds both package trees twice and compares every
path, normalized mode, byte count, and SHA-256 digest. A separate public-surface gate rejects private identifiers,
personal email, secrets, symlinks, oversized files, audio by extension or signature, and hosted
MCP transports. Domain-separated protected-blob fingerprints keep that gate effective in fork CI
without publishing private asset hashes. The export helper copies only an explicit source
allowlist and validates the result.
Release automation produces deterministic `ape-codex-2.17.0.tar.gz` and
`ape-claude-2.17.0.tar.gz` archives, `SHA256SUMS`, a machine-readable release manifest, and an SPDX
2.3 SBOM with the bundled Zod dependency and package verification codes, then attaches GitHub
build-provenance attestations. Publication uses a checksum-pinned GitHub CLI. CI pins third-party actions by full
commit and exercises clean package/MCP startup on Node 22 and 24 across Linux, macOS, and Windows.
The fresh public repository preconfigures least-privilege CodeQL scanning and bounded weekly
Dependabot updates for npm and GitHub Actions.
The public source also includes a credential-free, deterministic prompt-evaluation gate covering
36 synthetic scenarios over the declared two-host, three-tier matrix. Live provider calls remain a
separately guarded operator action; supplied result artifacts can be verified offline against
current prompt hashes and exact release thresholds.

Skill entrypoints are now rendered from host-neutral sources. All state-changing skills are
explicit-only; `status` is the sole implicitly discoverable skill. The run/resume protocol is a
shared generated reference so host packages cannot drift. Documentation now scopes test-driven
development precisely to behavioral fast/full phase work and records external-tool capability and
attestation differences instead of claiming blanket host parity.

LARP MODE no longer assumes bundled audio. Operator environment/config paths take precedence over
an optional closed `assets/sounds/manifest.json`, whose relative entries must remain inside its
directory after realpath resolution. An absent, invalid, escaping, or missing entry is silent and
never blocks a run. Public packages omit the entire `assets` directory; the private source overlay
retains its unchanged sound files and manifest.

The Codex development cachebuster now mutates only the staged immutable-cache manifest. The
canonical source manifest remains at `2.17.0`, while each install gets a unique build-metadata
version and previously installed cache trees remain available to open tasks.
