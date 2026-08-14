# Changelog

## Unreleased

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
