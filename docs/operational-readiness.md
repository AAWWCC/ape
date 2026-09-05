# Operational readiness

Source tests check APE's code. Live certification checks that an exact package
works on the pinned host. A release needs both. See
[current candidate status](prevention-release-status.md) for recorded results;
this page describes the checks, not permission to run them.

## Credential-free replay gate

Run the following after the final runtime edits and both host package rebuilds:

```sh
npm run bundle
npm run docs:config
npm run package:plugins
npm run test:agent
npm run operational:canary
npm run typecheck
npm run compatibility:check
npm run eval:prompts:check
npm run eval:prompts:plan
npm run public:check
npm run validate:claude
npm run smoke:plugins
npm run package:check
npm run package:reproducible
npm run release:reproducible
```

`operational:canary` checks the synthetic replay corpus and exercises the scheduler,
native binding, dispatch, schemas, receipts, diagnostics, and simulated shipping.
CI runs it without host or GitHub credentials. Never copy objectives, tickets,
receipts, hashes, paths, or prose from `.ape/runtime/` into the corpus.

The prompt plan command does not run model evaluations. Package smoke checks
initialize local MCP services; they do not install plugins or change trust.
Passing these checks is not proof of a working live host.

## Live certification

Codex is the sole required live host from APE 2.23.0 onward, as defined in
[`compatibility.json`](../compatibility.json). Keep its exact Codex CLI 0.147.0 pin.
A host failure requires a compatibility decision, not an implicit upgrade.

Installation, hook trust, repository creation, pushes, PRs, and merges each need
operator authorization. This document and generated prompts grant none of it.
Use a disposable synthetic repository with an approved, frozen origin,
repository, and base. Never use APE's public source repository as the test target.

### Prepare the exact candidate

1. Finish the offline checks and freeze one source commit.
2. Verify the installed package's complete regular-file inventory and exact bytes.
   Separately verify what the host actually loaded and which hooks it trusts.
   Matching version text alone is insufficient.
3. Use an isolated host profile and supported permission/trust workflows. Project
   trust is not hook trust. Stop if permissions or trusted hooks are missing;
   do not change them implicitly or use bypass flags.
4. Set this exact identity in each test repository's local Git config:
   `APE Certification <ape-certification@users.noreply.github.com>`.
   Do not inherit another identity or supply conflicting `GIT_*` overrides.
   The launcher rechecks it and sets the same identity when starting Codex.
5. Run the environment check from the frozen source:

```sh
npm run release:live-preflight -- --project-dir <disposable-repository>
```

This catches prerequisites such as GitHub private-email push protection before
a worker starts.

### Launch requirements

Launch each noninteractive parent through the checked launcher:

```sh
npm run release:live-parent -- \
  --project-dir <disposable-repository> \
  --codex-home <isolated-home> \
  --codex-bin <absolute-reviewed-codex-executable> \
  --prompt <attempt-prompt> \
  --operator-authorized
```

Use `--operator-authorized` only after approval for that attempt and its shipping
actions. It adds a separate caller-attested approval handoff; it is not independent
proof of human approval, permissions, or hook trust.

Before launch, APE checks:

- **Host:** the reviewed absolute executable's `--version` must match the pin.
  That exact path is launched. Version output does not attest binary bytes.
- **Package:** the isolated home must contain the complete candidate package.
- **Transport:** the selected custom `model_providers` table must contain TOML
  integer-zero request and stream retry counts, and boolean-false
  `supports_websockets`. Inactive providers, comments, misplaced fields, quoted
  zeroes, and floats cannot satisfy this check.
- **Configuration:** analytics/features values must be parsed booleans. Reserved
  built-in provider definitions and profile overrides are refused; use reviewed,
  flattened isolated settings.
- **MCP permissions:** `plugins."ape@ape".enabled = true`, with explicit policy
  under `plugins."ape@ape".mcp_servers.ape`. The tools `ape_config`, `ape_run`,
  `ape_bind`, and `ape_validate_receipt` must be enabled by allow/deny lists and
  approved through `approval_mode = "approve"` or an approving
  `default_tools_approval_mode`. Per-tool settings override defaults.
  `auto`, `prompt`, and `writes` do not meet this headless requirement.

Configuration must be a stable regular UTF-8 file, at most 256 KiB, 32 nesting
levels, and 10,000 parsed values. Symlinks and special files are refused. Errors
must not echo configuration or secrets. These file checks do not prove the
host's effective loaded settings or successful tool execution.

The launcher uses `--sandbox workspace-write`; it does not grant permissions,
edit configuration, or bypass approvals. The required tools can mutate state, so
do not label them read-only. A noninteractive parent has no approval UI just
because its config says `on-request`. Use previously authorized settings or an
interactive session. See the official
[permission guidance](https://learn.chatgpt.com/docs/developer-commands?surface=cli)
and [plugin MCP policy](https://learn.chatgpt.com/docs/extend/mcp).

### Native worker handshake

`SubagentStart` gives a child provisional identity, not stage authority. Before
working, it must call `ape_bind` with the exact per-launch bootstrap arguments.
If the tool is deferred, one bounded discovery of the literal name `ape_bind`
is allowed, without capabilities, project paths, or task data.

Only the authenticated bind hook injects task and receipt authority. A probe
follows its acknowledgement-only exception: no synthetic-ticket reads or receipt
validation. Missing injected context or an unbound child fails the attempt.
Never replace the child or reconstruct its authority from transcripts.

### Four runs, in order

Run at most four approved parents, sequentially:

1. Non-behavioral mechanical phase.
2. Bounded behavioral fast phase.
3. Behavioral full phase with plan review.
4. Land onto protected `main`.

Prompt preparation validates all four directories and renders all prompts before
creating output. Invalid input leaves no partial output; existing output cannot
be reused. This is validation-before-write, not crash atomicity. The certificate
verifier rejects reordered campaigns, even if every run otherwise passed.

Each run must reach `completed` on its first attempt. Stop at the first failed
control call, worker tool, bootstrap, prompt assembly, transport retry, receipt
correction, duplicate dispatch, remediation, self-correction, or manual workaround.
Do not reset, abort-and-restart, or substitute another attempt. Fix the cause
offline, bump the version, and obtain approval before a new campaign. Separate
repeatability monitoring cannot repair a failed release campaign.

Record every attempt, including failures before a run exists, in an external
journal. Never invent a run ID, receipt, archive, or certificate for a failed probe.

### Protected shipping evidence

The protected-land test requires PRs, strict up-to-date checks enforced for
administrators, and no force-pushes, deletion, or bypass. It covers this policy,
not every GitHub merge-queue configuration.

A passing schema-v5 shipping record needs all of these:

- A GitHub squash merge with PR state `MERGED`.
- The observed merge path: `immediate` or `auto`.
- Passing required checks and the observed PR head matching the exact pushed head.
- A merged tree matching the passed-gate tree.
- The observed remote head matching the reported squash commit.
- Complete before/after protection observations with equal canonical digests,
  plus retained provider audit evidence for the interval.

A successful command, queued request, skipped check, or enabled auto-merge is not
completion. `shipping.auto_merge = true` also requires per-run authorization and
the frozen repository target; the setting alone grants no shipping authority.
It does not prove GitHub's `--auto` path was used. Do not force a delay to
manufacture that path.

Keep raw PR/check/tree and protection observations, timestamps, and the frozen
target outside the public repository. Reject bypass, temporary weakening,
unexplained policy changes, or missing observations. Equal digests bind the
observations; they do not prove continuous enforcement.

The canonical digest is defined by `certificationProtectionPolicyDigest(rawJson)`
in [the policy helper](../scripts/certification-protection-policy.mjs). Input is:

```text
{version: 1, target: {origin, repository, base}, classic_protection, branch_rules}
```

The target must be coherent and use `main`. Keep the full protection object
(`null` only when genuinely absent) and effective rule array. Never substitute
empty values for unreadable responses. The helper sorts keys and known unordered
collections, retaining unknown array order, duplicates, and provider fields.
It hashes `APE certification protection policy v1\n` plus compact normalized
JSON without a trailing newline. Malformed, duplicate-key, oversized, incoherent,
or excessively nested input is rejected. This is a content digest, not a GitHub
signature or policy evaluator.

### Certificate and release

Use [the ledger schema](../evals/live-certification.schema.json) only for real
qualifying runs. It permits bounded identifiers, versions, counters, reason
codes, booleans, and hashes—not objectives, ticket/receipt prose, output, provider
responses, or repository paths. Do not hide private text inside identifiers.
Each host must match its exact pin and required certified/unverified partition.
Each unique `run_record_sha256` binds the exact archived record retained externally.

After all four clean runs:

1. Create one child commit that changes only `evals/live-certification.json`.
   Its single parent must be the unchanged tested source commit.
2. With separate authorization, tag that certificate commit as `v<package.json version>`.
3. Check it with:

```sh
npm run release:live-certification -- --head <tag commit> --tag <tag>
```

Tagged-release CI runs the same offline gate before publication. It reads
committed Git objects, not working files, and makes no network requests. It
rejects invalid ledgers, missing runs, wrong pins, host partitions, and incorrect
source/tag relationships. Historical schema-v4 records remain readable but
cannot pass the schema-v5 gate or be silently upgraded.

The operator creating the ledger attests that the recorded events happened.
The verifier checks that attestation and its evidence bindings; it cannot
independently prove external host or GitHub events. Retain the evidence for audit
and publish the bounded ledger, never fabricated outcomes. Without a complete
certificate, publication remains blocked even when offline checks pass.

### Separate Claude prerequisite

Claude packaging has a manual authenticated worker-validator reachability check:

```sh
npm run --silent release:worker-validator-reachability > /secure/path/worker-validator-proof.json
npm run release:worker-validator-proof -- /secure/path/worker-validator-proof.json
```

Run it from the exact candidate and retain the proof externally. It launches every
packaged role without an injected tool allowlist and requires a real validator
call to reach APE's no-active-run sentinel. The proof binds candidate manifests,
MCP declaration, plugin identity, canary implementation, role/tool observations,
and transcript hashes. Missing roles, changed evidence, or stale candidates fail.

Both commands must pass before release. This is a separate manual prerequisite,
not part of `release:live-certification` or credential-free CI. It proves schema
resolution and transport—not ticket binding, a full Claude run, or model quality.
Claude live operation remains unverified.

## Block-prevention and lineage contract

Readiness also checks these runtime boundaries. See [pipeline](pipeline.md) and
[invariants](invariants.md) for implementation details.

- **Admission:** preview/start compile reachable roles, artifact producers,
  schemas, field/byte limits, commands, and capabilities before dispatch. Planning
  complexity is `production claims + test paths + 2*requirements + 4*risks +
  2*required verification profiles`. Scores above 48 or canonical inputs above
  8192 UTF-8 bytes require acyclic, non-overlapping, scope-covering slices that
  each pass admission.
- **Verification:** baseline inspection is read-only and does not run tests.
  Missing runners are different from legitimate failing tests. Generators and
  formatters do not belong in read-only `policy.evidence_scripts`; run approved
  maintenance before ticket issuance and review the resulting tree.
- **Recovery advice:** tree-divergence and role-boundary refusals preserve state
  and do not identify the writer. Advice names cause, state, eligible actions,
  and operator decisions. Active runs cannot reset. An explicit audited abort
  may be followed by reassessment; reset is available only in blocked, aborted,
  or completed state. Advice never authorizes automatic cleanup or repair.
- **Receipts:** contract v1 changes only object-key order and JSON negative zero
  for hashing. It does not rewrite content or add defaults. Corrections are
  bounded and exact; parent agents cannot reconstruct authenticated receipts.
  Capability-bearing output is redacted using the verified canonical field.
  Missing, invalid, or substituted authority gets a fixed non-reflective refusal.
- **Convergence:** planning and remediation may continue only when the normalized
  finding set strictly shrinks with no additions. Evidence anchors are provenance,
  not finding identity. Equality, expansion, incomparable or malformed evidence,
  or the two-replan/three-remediation ceilings cause the existing blocked outcome.
- **Capability recovery:** additive test paths must be unique, project-relative,
  non-reserved, at most 64 items and 4096 serialized UTF-8 bytes. Validation rejects
  invalid input before mutation. The lineage retains the limits of three
  submissions per worker and two workers per ticket.
- **Durability:** recovery reuses one hash-bound immutable generation and successor
  after response loss or restart. It does not mint replacements or double-charge
  attempts. Selector edges—not mutable projections—choose the recovery head.
  Invalid selector slots remain in place as semantic evidence, with pathname and
  device/inode identity, raw bytes, and byte hash retained without clobbering.
  Changed or rebound paths are rescanned. Locks, bounds, both sides of publication,
  and every later mutation are revalidated; live or permission-ambiguous owners
  are not evicted for an old heartbeat.
- **Lineage:** immutable archives are never rewritten into success. Only complete,
  verified version-2 attestations may promote an existing successor relationship.
  New structured successor starts remain disabled because hook input does not
  authenticate human approval. Legacy/incomplete links, cycles, and missing
  predecessors are disclosed, not counted as success. Archive adoption requires
  the same complete admitted-start commitment; conflicts fail closed.
- **Shipping:** admission freezes the approved per-project target and check policy.
  All prospective, staged, committed, and merged trees must match gate evidence;
  only the verified commit is pushed. Drift, stale bases, missing identity,
  signing, access, squash, or protection prerequisites block shipping. Never retry
  unsigned or automatically rebase. Legacy unbound runs gain no new authority.
  APE's public package retains its separate `AAWWCC/ape` target restriction.
  Produce-and-hold defers remote proof; queued merges require server-enforced
  up-to-date checks or an ALLGREEN merge queue with required checks.

## Recovery development rule

Fix dispatch, binding, and ticket orchestration through ordinary development.
Resume APE self-hosting only after offline replay and the first live mechanical
and fast checks pass without intervention.
