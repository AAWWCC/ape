# Operational readiness

Passing source tests is necessary but does not certify that a host can execute an APE run. APE has
two release gates with deliberately different claims.

## Credential-free replay gate

Run `npm run operational:canary`. It validates the normalized replay corpus in
`evals/operational-replay-corpus.json` and exercises the runtime, native binding, dispatch envelope,
pipeline selection, terminal diagnostics, and shipping simulations. CI and tagged-release jobs run
this gate without host or GitHub credentials.

The replay corpus contains failure classes and recovery contracts only. Never copy objectives,
tickets, receipts, hashes, paths, or prose from `.ape/runtime/` into it.

## Live certification

Before describing a release candidate as operationally healthy, run the candidate package through
these canaries in a disposable repository on every host marked `required` for live certification in
`compatibility.json`. For APE 2.23.0 and later, Codex is the sole required host. Claude remains
packaged and receives pinned structural and marketplace validation, but authenticated Claude live
operation is marked `unverified` and is not part of the release certificate.

Claude packaging nevertheless has an explicit authenticated manual release prerequisite. From the
exact candidate source, retain a proof outside the repository and verify that it still binds the
candidate's manifests, plugin MCP declaration, plugin identity, and canary implementation:

```sh
npm run --silent release:worker-validator-reachability > /secure/path/worker-validator-proof.json
npm run release:worker-validator-proof -- /secure/path/worker-validator-proof.json
```

The canary enumerates every canonical and packaged role, launches each packaged role through Claude
without injecting a tool allowlist, and exits nonzero unless a real call to either supported exact
validator schema reaches the APE service and returns the expected no-active-run sentinel. Its
bounded JSON proof includes the exact candidate validator-surface hash, each role/tool observation,
and a hash of each host transcript; a missing role, stale candidate, or altered observation fails the
proof verifier. Do not proceed with a release candidate when either command fails.

This is a manual prerequisite, not a field consumed by `release:live-certification`; retain its
operator-attested proof beside the other external release evidence. It proves per-role schema
resolution and MCP transport only. It does not certify ticket binding, a complete Claude run, model
effectiveness, or Claude as a required compatibility host, and it is intentionally excluded from
credential-free CI because it uses the operator's authenticated Claude host.

Before the first attempt, set the exact repository-local identity `APE Certification
<ape-certification@users.noreply.github.com>` in each disposable repository's Git config; never
inherit release commit identity from global or system config, substitute another noreply account,
or override the effective author/committer with `GIT_*` environment variables. The parent launcher
rechecks and pins that identity immediately before starting Codex.
Run `npm run release:live-preflight -- --project-dir <disposable-repository>` from the exact source
candidate and require it to pass before launching the host. This prevents GitHub private-email push
protection from turning a clean APE run into a shipping failure.

Launch every non-interactive Codex certification parent through `npm run release:live-parent --
--project-dir <disposable-repository> --codex-home <isolated-home>
--codex-bin <absolute-reviewed-codex-executable> --prompt <attempt-prompt>`. The
launcher fails closed unless the isolated home contains the candidate's complete regular-file
inventory and exact packaged bytes, including its version, and declares zero request retries, zero
stream retries, and WebSockets disabled. Its bounded package digest proves staged byte parity only,
not that a persistent desktop host loaded that snapshot. Verify the actual loaded candidate and
trusted-hook conformance on the exact `compatibility.json` Codex pin before acceptance; a different
desktop diagnostic version is not a substitute. If the pinned host cannot deliver the required
hooks under supported normal permissions, stop readiness for an explicit compatibility decision.

The required `--codex-bin` selects a reviewed absolute executable, not an ambient `PATH` entry.
Before catalog startup or parent execution, its bounded read-only `--version` result must match
the unchanged Codex pin in `compatibility.json`; a mismatch stops preparation without an upgrade.
The checked canonical path is also the launched command. This check follows the
[documented CLI version command](https://learn.chatgpt.com/docs/reference/troubleshooting).
Self-reported version and a resolved path are not binary attestation or protection against an
in-place executable replacement; exact loaded-byte and host-conformance checks remain required.

The launcher parses the isolated `config.toml` and resolves the top-level `model_provider` to its
own custom `model_providers` table. Both retry counts must be TOML integer zero (not a quoted zero
or `0.0`), and `supports_websockets` must be boolean false in that selected table. Unrelated
providers, comments, multiline strings, and misplaced root fields cannot satisfy those checks.
Top-level analytics/features tables are checked as parsed booleans too. Equivalent quoted keys,
dotted keys and inline tables are accepted. Reserved built-in definitions and profile overrides
are refused with explicit correction guidance; flatten reviewed certification settings into the
isolated file instead of relying on unvalidated profile layers.

Configuration input is a stable regular UTF-8 file, at most 256 KiB, with at most 32 nesting levels
and 10,000 parsed value nodes. Symlinks and special files are refused before reading. Parser
failures do not echo configuration content or nearby credentials. This is a bounded
selected-provider/transport guard, not proof that every unrelated setting or effective host
configuration layer is valid; pinned-host loaded configuration and conformance remain separate.
The TOML parser is an exactly pinned development dependency used by this launcher only, not a
new dependency in either distributed plugin runtime.

The launcher uses `--sandbox workspace-write` and does not bypass approvals, sandboxing, or hook
trust. The operator must review and trust the exact candidate hooks through the supported host
workflow; project trust is not evidence of hook trust. Missing trust or permissions is a stop, not
permission to change trust/configuration or relaunch with bypass flags. See the
[official Codex CLI permission guidance](https://learn.chatgpt.com/docs/developer-commands?surface=cli).

`SubagentStart` supplies provisional native identity evidence, not stage authority. Each assigned
child uses its exact per-launch bootstrap arguments in `ape_bind` before stage work. If deferred,
one bounded discovery of the literal registered name `ape_bind` is allowed, without capabilities,
project paths, or task data. Only the authenticated bind hook injects ticket/receipt context. A
probe follows its injected acknowledgement-only exception, with no synthetic-ticket reads or
receipt validation. Missing post-bind context or a child that finishes without binding fails the
attempt; do not replace the child or reconstruct its context from transcripts.

Repository creation, hook trust, installation, push, PR creation, and merge each require their
separate operator authorization. Generated attempt prompts do not establish that authorization.
Use a dedicated synthetic certification repository with explicitly frozen origin/repository/base
identity, not the public APE source repository as a disposable target; protected land targets
`main`. Complete offline regressions, the full source suite, package parity, and public/package
gates before requesting live acceptance. Run at most the four approved Codex attempts below,
sequentially, stopping on the first failure. No replacement attempts or new campaign are authorized
by the launcher or this document.

Prompt preparation validates all four canonical project directories and renders the complete
set before creating its output directory. Invalid inputs leave no partial prompt output; existing
output remains protected from reuse. This is validation-before-write, not filesystem crash
atomicity. The evidence verifier independently requires the sequence below even if every
individual recorded attempt succeeded; renumbering an out-of-order campaign cannot certify it.

1. A non-behavioral mechanical phase.
2. A bounded behavioral fast phase.
3. A behavioral full phase with plan review.
4. A land run targeting protected `main`, with required up-to-date checks enforced for administrators.
   The observed squash path may be immediate or automatic; do not manufacture a policy refusal or
   delay CI to force the automatic path. `shipping.auto_merge = true` is APE's shipping authorization
   setting, not evidence that GitHub's `--auto` path was used.

Retain every attempt, including pre-run probe failures with no run archive, in an external bounded
attempt journal. Never invent a run id, receipt, or archive for such a failure. A failed campaign
cannot produce a release certificate. Record qualifying run evidence in a candidate ledger using
`evals/live-certification.schema.json`. The ledger
is intentionally limited to bounded identifiers, versions, counters, stable terminal reason codes,
booleans, and commit hashes. It has no fields for objectives, ticket text, receipt prose, command
output, provider responses, or repository paths. Do not copy those values into identifiers. Each
ledger names the exact `certified_hosts` and `unverified_hosts` partition required by the tagged
compatibility policy. Every attempt's host version must equal that host's exact `compatibility.json`
pin. Its unique `run_record_sha256` is the SHA-256 of the exact archived APE run-record bytes retained
outside the public repository for audit.

Each of the four pipeline shapes must produce exactly one clean `completed` attempt on Codex. Every
release-gating attempt must be first-pass perfect. Repeatability exercises may run separately as
non-blocking operational monitoring, but they are not added to the release ledger and cannot repair
a failed release attempt. A clean attempt has no manual intervention, prompt-assembly failure, failed
worker tool, failed control call, host transport retry, receipt repair, duplicate dispatch,
remediation, self-correction, or abort/successor workaround. Any such event rejects the candidate:
fix the cause, bump the version, and restart from a fresh clone of the new exact source commit. Never
discard the failed attempt and substitute a later success under the same version. A successful
protected-branch attempt additionally records a schema-v5 proof of GitHub squash with `MERGED` PR
state, the actual `merge_path` (`immediate` or `auto`), required checks passed for the exact pushed
head, an observed PR head equal to that pushed head, a merged tree equal to the passed-gate tree,
and an observed remote head equal to the reported squash merge commit. An accepted queue request,
command exit zero, skipped check, or enabled auto-merge is not completion. Retain the actual command,
PR/check observations and Git trees outside the public ledger; never relabel an immediate merge as
automatic. Old schema-v4 JSON remains readable historical evidence but is not accepted or silently
upgraded by the schema-v5 release gate.

This certification cohort deliberately uses strict required checks, required PRs, administrator
enforcement, and disabled force-pushes/deletion, without bypass. It does not certify every optional
GitHub policy topology; runtime support for ALLGREEN merge queues remains distinct from this
strict-check cohort. Before and after protected shipping, retain the full effective classic
protection and branch-rule observations, including their timestamps and frozen target, outside the
public repository. Use the documented canonical policy digest for `branch_protection.before_sha256`
and `after_sha256`; they must match. A digest commits to retained observations, not independent
proof of continuous enforcement between them. Retain provider audit evidence for that interval and
refuse certification if any bypass, temporary weakening, missing observation or unexplained policy
change occurred. The existing zero-recovery rule remains unchanged.

The pure `certificationProtectionPolicyDigest(rawJson)` export in
`scripts/certification-protection-policy.mjs` defines the policy normalization. Its input is raw
JSON with exactly `{version: 1, target: {origin, repository, base}, classic_protection, branch_rules}`.
The target must be the coherent frozen GitHub origin/repository and `main`; retain the complete
classic protection object (or `null` if genuinely absent) and complete effective branch-rule array.
Never replace an unreadable policy response with `null` or an empty array. Observation timestamps
and raw provider responses are retained alongside this envelope, not discarded from the audit.

The helper sorts object keys and known unordered policy collections; it preserves unknown array
order, duplicates and every provider field. It hashes the UTF-8 domain
`APE certification protection policy v1\n` followed by compact normalized JSON with no trailing
newline. It rejects duplicate decoded keys, invalid or oversized JSON, incoherent targets and
excessive nesting/node counts. This is a deterministic commitment to retained policy content,
not a policy evaluator, GitHub signature or substitute for verifying the proof's explicit guards.

The tagged-release gate is mechanically separate from the live work:

1. Run all live attempts against one exact source commit without changing it.
2. Create one dedicated child commit that only adds or modifies
   `evals/live-certification.json`. Its single parent must be that tested source commit.
3. Tag the certification commit as `v<package.json version>`.
4. Run `npm run release:live-certification -- --head <tag commit> --tag <tag>` locally if desired;
   the tagged-release workflow runs the same offline check before validation or publication.

The verifier reads committed Git objects, not the working tree, performs no network requests, and
rejects non-canonical or oversized ledgers, unknown fields, a changed certified/unverified host
partition, missing required host/pipeline cohorts, unsafe
free-form strings, and a tag that does not point at the certification-only commit. The actual
`evals/live-certification.json` is deliberately absent until real attempts exist. Never create one
from examples or fabricated outcomes.

The repository writer who creates the certification commit is the attesting operator. The offline
gate mechanically verifies the attestation's shape, exact source/tag topology, pinned host versions,
unique archived-record bindings, exact first-pass-perfect outcomes, and internal merge proof; it cannot
independently observe or cryptographically prove that an external host or GitHub event occurred.
Retain the archived records and remote release evidence so an auditor can recompute the hashes. Do
not describe this operator-attested ledger as provider-signed execution proof.

Publish the raw ledger and group failures by the runtime's stable terminal reason code and APE
version. A release with no live candidate runs is *untested operationally*, even when every
credential-free gate passes; the release workflow will fail closed rather than convert that absence
into a certification claim.

## Block-prevention and lineage contract

APE keeps every terminal run as immutable audit evidence while reporting the validated logical
lineage as the primary project outcome. A lineage edge requires both a hash-verified archive and a
hash-bound structured successor attestation. The attestation binds the normalized explicit-start
request hash and successor run id to the predecessor's immutable archive hash, exact retained tree,
and reviewed runtime-configuration digest. The same complete normalized request hash is persisted
independently in the successor archive;
lineage promotion independently verifies that admitted-start hash against the attested request hash,
and any mismatch or missing admitted-start identity fails closed. A legacy `supersedes_run` marker or configuration-less version-1
attestation remains audit-visible and is disclosed as incomplete rather than promoted; only a
version-2 attestation with the successor's exact admitted configuration hash and bounded approval
id can promote the edge. Existing attestations remain readable, but the current runtime does not
mint or accept new structured successor starts because lifecycle-hook stdin does not authenticate
human provenance.
A blocked predecessor with a running attested successor is
`recovering`; a completed successor makes the lineage `recovered`; an unsuperseded blocked leaf is
`unresolved_blocked`. Missing predecessors, self-links, cycles, and malformed links are excluded
from success rates and disclosed as incomplete. Status and wire projections contain bounded
identifiers and lifecycle labels only; history records are never rewritten to manufacture a better
outcome. In the `archive_history`-before-`persist_state` crash window, a hash-verified terminal
archive may replace the stale preterminal active copy only when both share the canonical
admitted-start commitment. That commitment binds the complete normalized request, frozen policy and
capability snapshot, initial run-contract root, shipping authorization, and repository identity.
Any disagreement or partial commitment is `active-archive-conflict`; a mutable terminal state with
no immutable archive is `missing-terminal-archive`. Metrics filters select logical
leaves before lifecycle counters or incomplete diagnostics are accumulated, so excluded components
never leak into the requested cohort.

Eligible blocked leaves may expose versioned recovery guidance containing the predecessor run id,
exact retained tree, terminal reason, exact currently reviewed configuration hash, and a
configuration-drift flag. Guidance explicitly reports that structured successors are unavailable
and names `override-reset` as the recovery action. The runtime derives this bounded object from the
durable blocked state for every eligible terminal writer and recomputes it on both full and compact
status reads, so a later session does not depend on retaining the response that first created the
block. Lifecycle hook JSON is observable input, not an
authentication boundary: a model can invoke the same shipped command with synthetic stdin, so no
prompt literal or hook event can authorize a successor. After explicit operator direction, use the
reason-audited override reset and start an ordinary fresh run. Guidance is advisory. It cannot
dispatch work, consume a product attempt, waive a gate, ship, or mutate the predecessor. A legacy
marker or structured request cannot supersede the active blocked run.

Preview/start admission compiles every reachable role and the worst-case monotone transition
surface. It bounds command and verification profiles, evidence commands, claims, schemas, fields,
and bytes before dispatch. Complexity admission uses the deterministic score `production claims +
test paths + 2*requirements + 4*risks + 2*required verification profiles`; a score above 48 or a
canonical planning input above 8192 UTF-8 bytes requires an acyclic, scope-covering,
non-overlapping decomposition whose slices independently pass admission.

Treat `policy.evidence_scripts` as read-only reviewer commands. Do not advertise baseline
generators, formatters, or other tracked-file writers there: a command that mutates the reviewed
tree cannot be attributed to a read-only ticket and must fail closed. Run such maintenance
deliberately before ticket issuance, then review the resulting stable tree.

Receipt tree-divergence and role-boundary rejections do not attribute the writer or automatically
change run state. Their bounded `recovery` descriptor names the cause, current state, eligible
actions, and operator preconditions. Preserve the current tree and inspect diagnosis first. An
active run cannot be reset; an operator may explicitly choose audited abort, then reassess the
terminal state. Reset is offered only for blocked, aborted, or completed state. No descriptor
authorizes automatic abort/reset, cleanup, receipt repair, or a replacement dispatch.

Receipt contract v1 canonicalizes only object-key order and JSON negative zero for hashing. It does
not trim strings, insert defaults, wrap values, remove nulls, reorder arrays, or reinterpret tests,
findings, paths, commands, verdicts, or evidence. Invalid drafts receive bounded exact correction
deltas. Validation, hook correction, record, recovery, and task-operation responses omit or redact
the `receipt_capability` bearer from every public field name, nested value, issue, correction, and
thrown unsafe-input error before it can reach MCP output, host transcripts, or persisted task
results. Redaction authority comes only from the canonical draft field matching the dispatch
intent's one-way capability hash. A missing, non-string, or substituted canonical field cannot
select a redaction target: hooks and service/task/MCP edges emit fixed non-reflective refusals
instead, so copying the live bearer elsewhere cannot expose it. Directed planning retries and remediation cycles continue only when their normalized
structured assurance/finding identity set is a strict proper subset with no additions. Per-ticket
evidence anchors are provenance rather than semantic assurance identity; equality, expansion,
incomparability, malformed evidence, or the independent two-replan/three-remediation ceilings end in
the existing audited blocked outcome.

Capability recovery is a receipt-contract continuation, not a product-stage retry. Validation and
recording derive the same canonical additive test-path union and reject it before mutation if it is
non-unique, non-project-relative, reserved/option-like, over 64 items, or over 4096 serialized UTF-8
JSON bytes. A recovery lineage carries validation submissions and physical-worker consumption
forward monotonically under the three-submissions-per-worker and two-workers-per-ticket ceilings.

An accepted recovery has one runtime-minted UUID successor and one exact prepared binding over its
schemas, hashes, predecessor, claims, policy, risk/lane, deadlines, capability manifest, run
contract, ceilings, counters, and provenance. Publication stages all authoritative records in an
immutable hash-manifested generation and exposes that generation by one same-filesystem rename
while holding the owner-token receipt lock. Canonical compatibility files land before the atomic
active-state adoption. A crash or response loss is recovered by validating and reusing that same
generation; it cannot regenerate the successor or double-charge the lineage. Live locks exclude a
writer, while stale or corrupt locks are handled by the verified tombstone protocol. Valid legacy
bytes are not rewritten, and malformed or incompletely bound legacy recovery fails loudly.

The generation manifest enumerates the exact regular-file set and binds raw bytes, sizes, and
filesystem identities. Its append-only content-addressed selector edge—not mutable `active.json`
generation metadata—selects the unique recovery head. Invalid selector slots remain in place as
retained semantic evidence: collision-safe records bind the source pathname, device/inode identity,
raw bytes and byte hash, and claimed lineage. A changed or rebound pathname is rescanned;
selector/head semantics remain the authoritative source of truth. Replays reject forks, revalidate
both sides of publication, and repair compatibility projections only from that exact generation.
Every post-selector projection, active-state, receipt-binding, and dispatch mutation is enclosed by
the same token/device/inode lease guard before and after the sink; loss stops all later sinks.
Process probing treats `EPERM` and unknown errors as alive; a stale active owner is never evicted
merely because its heartbeat aged, and a cooperating contender cannot retire a live callback's
generation.

The readiness gate also exercises frozen run-contract authority, full validation on adopted replay,
selectorless `N` to `N+1` migration, non-head replay monotonicity, pre-allocation member/cumulative
and directory-entry bounds, lease-token plus lock-directory identity checks at selector mutations,
and non-clobbering semantic-evidence publication with retained-slot identity verification.

Shipping readiness exercises explicit per-project target binding: admission freezes
`shipping.target.origin`, `repository`, `base`, and the required-check policy. Shipping refuses
missing or drifted targets, uses the frozen URL and repository explicitly, pushes only the verified
commit OID, and merges with an exact head match. Prospective, staged, and committed trees must match
the passed-gate tree. The canonical public APE package retains its separate `AAWWCC/ape` guard;
other projects use their own approved targets. Legacy unbound runs cannot silently acquire shipping
authority from current configuration. Auto-shipping admission verifies non-interactive Git identity,
signing policy, GitHub access, squash availability, and required-check protection with bounded
read-only inspections before dispatch; produce-and-hold explicitly defers remote shipping proof.
Signing failures never retry unsigned. The remote base is rechecked before shipping mutations and
merge requests, with no automatic rebase. Queued auto-merge additionally requires server-enforced
up-to-date checks or an ALLGREEN merge queue with required checks: a local base observation cannot
prove a future merged tree.

## Recovery development rule

When dispatch, binding, or ticket orchestration is under repair, make the fix through ordinary
repository development. Resume APE self-hosting only after the credential-free replay gate passes
and the first live mechanical and fast canaries complete without intervention.
