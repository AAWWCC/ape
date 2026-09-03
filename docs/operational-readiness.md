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
--project-dir <disposable-repository> --codex-home <isolated-home> --prompt <attempt-prompt>`. The
launcher fails closed unless the isolated home contains the exact candidate plugin and declares
zero request retries, zero stream retries, and WebSockets disabled. It also supplies Codex's
automation-only `--dangerously-bypass-hook-trust` flag after the candidate hook source has been
vetted. Project trust alone does not authorize lifecycle-hook delivery for this non-interactive
path: omitting the flag leaves `SubagentStart` unable to inject the binding capability and rejects
the infrastructure probe before a run can start.

1. A non-behavioral mechanical phase.
2. A bounded behavioral fast phase.
3. A behavioral full phase with plan review.
4. A land run whose protected base requires the authorized auto-merge path.

Record every attempt in a candidate ledger using `evals/live-certification.schema.json`. The ledger
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
protected-branch attempt additionally records a
GitHub auto-squash with `MERGED` PR state, an observed PR head equal to the exact pushed head, and an
observed remote head equal to the reported squash merge commit.

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

## Recovery development rule

When dispatch, binding, or ticket orchestration is under repair, make the fix through ordinary
repository development. Resume APE self-hosting only after the credential-free replay gate passes
and the first live mechanical and fast canaries complete without intervention.
