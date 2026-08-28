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

Before the first attempt, set `user.name` and a GitHub noreply `user.email` in each disposable
repository's local Git config; never inherit release commit identity from global or system config.
Run `npm run release:live-preflight -- --project-dir <disposable-repository>` from the exact source
candidate and require it to pass before launching the host. This prevents GitHub private-email push
protection from turning a clean APE run into a shipping failure.

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

Each of the four pipeline shapes must end with three consecutive clean `completed` attempts on
Codex. A clean attempt has no manual intervention, prompt-assembly failure, receipt
repair, duplicate dispatch, or abort/successor workaround. Earlier failures remain in raw sequence;
do not discard or average them away. A successful protected-branch attempt additionally records a
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
unique archived-record bindings, clean consecutive outcomes, and internal merge proof; it cannot
independently observe or cryptographically prove that an external host or GitHub event occurred.
Retain the archived records and remote release evidence so an auditor can recompute the hashes. Do
not describe this operator-attested ledger as provider-signed execution proof.

Publish the raw ledger and group failures by the runtime's stable terminal reason code and APE
version. A release with no live candidate runs is *untested operationally*, even when every
credential-free gate passes; the release workflow will fail closed rather than convert that absence
into a certification claim.

## Recovery development rule

When dispatch, binding, or ticket orchestration is under repair, make the fix through ordinary
repository development. Resume APE self-hosting only after the credential-free replay gate passes
and the first live mechanical and fast canaries complete without intervention.
