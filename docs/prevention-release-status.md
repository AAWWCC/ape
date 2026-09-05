# Prevention-first reliability candidate

This is an implementation and verification record, not a deployment certificate.
The candidate must not be called prevention-release ready until its exact installed
and loaded bytes pass the separately authorized clean acceptance campaign. Passing
source tests, matching version strings, or a successful historical run cannot
substitute for that evidence.

## Current state — read before the historical records

The working tree is not yet a reviewed source commit. Its partially staged index
does not represent the tested candidate and must not be committed as-is. Preserve
the existing staging while reviewing the full final-file scope separately.

Both host packages passed offline checks. A separately authorized isolated Codex
installation now matches the candidate bytes, and its normal authentication setup
is complete. The synthetic repository and protected-main CI were also established
under separate authorization. Do not repeat those completed setup actions merely
because an earlier dated section below describes them as outstanding.

Still required: exact reviewed source freeze; normal hook approval and loaded-byte
conformance on pinned Codex; prepared campaign checkouts/configuration/prompts;
and the separately authorized clean campaign. Full Claude operation remains
unverified, with its candidate-bound validator prerequisite separate. No new live
attempt is authorized by this status record.

## Implemented boundaries

| Boundary | Runtime contract | Direct synthetic coverage |
|---|---|---|
| Pipeline | Canonical run specification, reachable worker/runtime stages, artifact edges, consumer schemas, shared limits, non-authoritative planner skeleton | `runtime-v2-admission-compiler.test.js`, `runtime-v2-prevention-pipeline-matrix.test.js`, readiness and pipeline suites |
| Preview/start | Read-only versioned manifest; reviewed-input digest; scope, repository, command, base, capability, and prerequisite checks before mutation | Admission manifest, baseline, command prerequisites and MCP suites |
| Writer scope | Declared generated outputs must already be approved; generators cannot masquerade as verification or run under read-only authority | Admission manifest, evidence command, receipt tree, and hook suites |
| Input/receipts | Canonical conditional preflight fields, exact bounded corrections, worker-authenticated attestation, no parent reconstruction | Preflight, MCP, receipt contract and binding suites |
| Refusal guidance | State-eligible actions with cause and operator preconditions; no automatic reset/abort/tree restoration | `runtime-v2-receipt-recovery-guidance.test.js`, receipt admission suites |
| Native bootstrap | Provisional identity → exact-name `ape_bind` → trusted injected authority → acknowledgement | Bootstrap hook integration, probe diagnostics, MCP composition and certification launcher suites |
| Shipping | Explicit per-project target and consent frozen in validated admission; observable prerequisites before gates/effects; tested prospective/staged/committed/pushed tree | `runtime-v2-shipping-prevention.test.js`, shipping service, protected merge and cleanup suites |

Public new-protocol starts require `expected_admission_digest`. The commitment
confirms reviewed inputs, not independent human authorization. Existing legacy
records remain readable and are not silently upgraded to the new authority
contract. Historical fallback tests use explicitly seeded legacy fixtures; they
do not bypass admission for new production runs.

No retry budget was expanded. Existing bounded reconciliation/remediation remains
a fallback. Repair-and-land and larger automatic recovery remain deferred.

## Historical evidence disposition

The complete retained register accounts for 180 distinct non-success run IDs and
44 failed control calls. Historical IDs, objectives, receipts and source pointers
remain outside the public checkout. Only synthetic reproductions and this
aggregate summary belong here.

| Retained disposition | Runs | Failed control calls |
|---|---:|---:|
| Direct defect-to-regression mapping | 5 | 4 |
| Expected guard; historical merits not certified | 111 | 37 |
| Configuration or external prerequisite | 10 | 2 |
| Recorded operator stop | 5 | 0 |
| Later completion in retained history | 4 | 0 |
| Insufficient evidence | 45 | 1 |
| Total | 180 | 44 |

The five direct run mappings concern v2 preflight schedulability, non-behavioral
red-test scheduling (two runs), remote completion versus failed local cleanup,
and protected-branch queued merge. Four control calls form two episodes of
contradictory reset advice. Guard families retain prohibited and authorized
counterpart tests. New diagnostic coverage does not retroactively prove an
unknown historical cause fixed, and a test passing for a guard does not prove
that every historical application of that guard was justified.

## Offline verification gate

Run the following on the final candidate, after all runtime edits and both host
package rebuilds. An earlier green result does not cover later source changes.

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

Operational replay composes real model-free scheduler, hook, MCP, schema, receipt
and simulated shipping tests. It is not a paid worker run or a native model
compliance certificate. The prompt plan command does not execute prompt evals.
Package smoke checks initialize each packaged host's local MCP boundary without
installing it or changing trust.

Baseline inspection is read-only and does not execute the project's test suite.
Current command entry scripts, selected package scripts and shebang interpreters
are checked separately from the tracked HEAD-to-base prerequisite comparison.
It distinguishes an unavailable runner from a configured test command that may
legitimately fail. Actual red/green results and filesystem effects still require
runtime observation; declarations cannot establish correctness or write safety.

## Candidate verification record — 2026-09-04

The frozen runtime and rebuilt packages passed all 246 test suites: 3,830 tests
passed and 86 existing tests remained skipped. All 526 model-free operational
replay tests across 20 suites passed. Type checks, compatibility, 37 prompt scenarios, the
18-call prompt plan (not executed), public safety and identity checks, both host
MCP smoke checks, Claude manifest validation (including strict mode), and the
updated Codex skill validators passed. Package checks matched a fresh build;
two isolated builds matched all 129 package inventory entries and five release
artifacts byte-for-byte. Offline verification is complete; installed/loaded-byte
verification and the clean live acceptance campaign have not been performed.

Review runtime changes in `lib/runtime/` and `bin/` separately from synthetic
regressions in `__tests__/`. `plugin-src/` owns the packaged skill instructions;
`dist/` and `plugins/` are generated outputs. Existing staged and unstaged work
was preserved, and this implementation was not committed, pushed, or installed.

## Offline certification follow-up — 2026-09-04

The certification contract now records the protected squash path actually used:
immediate or automatic. Schema v5 requires passing checks for the exact pushed
head, matching passed-gate and merged trees, observed remote completion, no
bypass, and matching before/after protection observations. This cohort requires
strict required checks, a pull request, administrator enforcement, and no
force-pushes or deletion. It does not certify every merge-queue topology.
Schema v4 evidence remains readable but cannot satisfy the new release gate.
These records remain operator attestations, not independent provider proof.

A bounded, pure helper canonically hashes full protection-policy observations.
It rejects malformed, duplicate-key, unsafe-number and oversized input; it only
normalizes explicitly known unordered collections. Unknown fields and unknown
array ordering are retained. Its 39 synthetic tests include a failing-before
regression for an unknown rule type whose ordered array must not be normalized.

The shipping follow-up also fixes a reproduced runtime defect: a successful
merge command can submit a queued merge without completing it. APE now keeps
that state pending, persists the submitted marker, and avoids duplicate normal
poll submissions. Completion and local cleanup require a fresh merged-PR
observation for the admitted head and the passed-gate remote tree. Thirteen
direct regressions cover this boundary and persisted state; missing or invalid
observations cannot become success. This is not an atomic exactly-once
transaction across the external merge command and local persistence: a process
crash between those operations is not claimed solved.

Final verification passed all 247 suites: 3,905 tests passed and 86 existing
tests remained skipped. All 537 operational replay tests across 20 suites
passed. Type checks, compatibility, 37 prompt scenarios, the unexecuted 18-call
prompt plan, public safety and identity checks, both packaged MCP smoke checks,
and strict/non-strict Claude manifest validation passed. Fresh package parity
and isolated reproducibility passed for all 129 inventory entries and five
release artifacts. The first full run exposed a missing CI timing entry and an
unbounded response sink; both were corrected and directly rechecked before
the final complete rerun. Their failed results remain retained outside the
public checkout rather than being replaced by the passing result.

Both host packages were rebuilt after the final runtime edit. The previously
installed isolated snapshot was left unchanged and no longer matches this
candidate. No trust change, native session, live campaign, archive, or
certificate was created by this follow-up. Installation parity, loaded-byte
verification and clean acceptance remain outstanding; the candidate is not
deployment-ready.

## Selected-provider launcher follow-up — 2026-09-04

The launcher no longer accepts matching retry-setting text from an inactive
provider, a misplaced root field, or a multiline string. It parses a bounded
isolated TOML file, selects the declared custom provider's own table, preserves
TOML integer types, and checks parsed analytics/features booleans. Valid quoted,
dotted and inline forms work. Invalid/duplicate TOML, wrong types, reserved
provider definitions, unvalidated profiles, unsafe file types, invalid UTF-8,
oversized files and excessive nesting/value counts receive bounded refusals
without echoing configuration or nearby secrets.

The initial regression run had 15 failures with the old guard. After correction
and additional boundary coverage, all 124 launcher/certification tests passed.
The pinned Codex 0.147.0 parser was separately checked with synthetic configs
through its model-free feature-list command; TOML 1.1 forms and integer/float
distinctions were observed directly. That is parser evidence, not a model,
trusted-hook, loaded-plugin or live-run certificate.

The final full suite passed 3,962 tests with 86 skips across 247 suites
(386.91 seconds). Operational replay passed all 537 tests across 20 suites.
Type checks, prompt checks, compatibility, both packaged MCP smoke tests, Claude
manifest checks, public-safety gates, fresh-package parity and package/release
reproducibility passed. Dependency audit reported zero vulnerabilities. These
are offline results; none substitutes for the remaining live acceptance gates.

This is a source-launcher-only change with one exactly pinned development
dependency. Neither packaged runtime changed, and the separately installed
isolated candidate retains exact package parity. No installation, credential,
trust or live-run changes were made during this follow-up. The check deliberately
does not claim to validate every unrelated setting or merged host configuration
layer; exact-source freeze, normal hook approval, loaded-byte conformance and
the clean acceptance campaign remain required.

## Separate acceptance and deployment gates

Before source freeze, a further offline preparation review reproduced three
harness gaps: ambient-PATH host selection without a pin check, prompt output
created before complete input validation, and acceptance of reordered clean
campaigns. The launcher now requires a checked absolute Codex executable;
prompt inputs are fully validated before output creation; and the verifier
requires the declared mechanical, fast, full, protected-land order. These
corrections do not mutate installed packages or authorize a live attempt.

The candidate's states must be reported separately: source, bundled, packaged,
installed, loaded, trusted, and live-verified. This work authorizes source edits,
synthetic tests, and local packaging only. It does not authorize installation,
trust changes, certification repository creation, push, publish, or tags.

After offline closure, obtain separate authorization for the exact candidate
installation, supported trust setup, and a dedicated synthetic repository with
protected `main`. Never put certification changes on APE public `main`.

Keep the Codex `0.147.0` pin. Host conformance failure stops readiness; it must not
upgrade the host implicitly. Verify installed and loaded candidate bytes rather
than accepting matching version text. Launch through supported permission and
trust mechanisms; do not reintroduce implicit bypass flags.

The single Codex campaign is sequential: mechanical, fast, full, protected-branch
land; at most four parent attempts. Record every attempt, including failures
before a run ID exists. Stop at the first failed control call, bootstrap failure,
receipt correction, recovery, or manual workaround and return to offline work.
Do not fabricate an archive or certificate, replace the failed attempt with a
retry, or automatically alter lifecycle state.

Claude's candidate-bound worker-validator reachability prerequisite remains
separate. Full Claude operation remains explicitly unverified until its own
required evidence exists. Push, publish, tags, and user-plugin reinstallation
remain separate authorization decisions even after acceptance passes.
