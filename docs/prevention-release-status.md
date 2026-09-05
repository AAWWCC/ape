# Prevention-first reliability status

**2.24.12 is a review candidate, not a certified release.** Reproduced blockers
have fixes and regression tests. The full live acceptance requirement is still
incomplete. This page records the latest results as of September 5, 2026; it does
not authorize more testing, installation, or publication.

## What changed

- One pipeline contract now drives preview, admission, worker tickets, schemas,
  and instructions. It checks reachable stages before workers start.
- Preview checks scope, commands, capabilities, repository state, and shipping
  prerequisites. New-protocol start requires `expected_admission_digest` and
  rejects changed inputs before creating a branch or ticket.
- Generated files need approved writer scope. Read-only workers cannot run
  generators or formatters that change the reviewed tree.
- Input errors identify the missing or invalid fields. Recovery advice lists
  only actions allowed in the current state; it never authorizes an automatic
  reset, abort, or tree restoration.
- Native workers bind their provisional identity with `ape_bind` before receiving
  trusted task authority. Operational instructions remain runtime-owned.
- Shipping freezes each project's approved target and checks the staged,
  committed, pushed, and merged trees against gate evidence. A queued merge is
  pending, not completed; local cleanup failure is separate from remote success.
- Codex response-size and launcher checks now cover reproduced truncation,
  permission-policy, host-pin, and prompt-preparation failures.
- The follow-up sweep repaired stopped-worker settlement after abort, missing
  Node preload and syntax-check prerequisites, and baseline inspection of nested
  package scripts, literal environment prefixes, and npm's default start entry.
- Evidence path checks use the command's actual working directory, including
  an admitted leading `cd`, while still rejecting project and symlink escapes.
- Issued receipt schemas now specialize required tests, authorized claims and
  test paths, and the preflight objective from the same ticket validated later.
  Capability recovery preserves this specialization, while exact historical
  prepared envelopes remain replayable without changing their immutable bytes.
- The friction review aligns prerequisites with the selected workflow: optional
  generators cannot impose unrelated output scope, debug/spike do not inherit
  test-authoring or shipping requirements, and missing optional verification
  roots are disclosed without preventing start or granting execution authority.
- Ordinary searches and file inspection support complete literal quoted words,
  including spaces and regex syntax. Command effects, executable identity, and
  path containment remain checked. Required capabilities retain their checks.
- Preflight reuses settled decisions and treats optional refactors as advisory.
  Receipt retry guidance directs the parent to record the exact attested draft
  without unnecessarily continuing the worker.
- Compact run and ticket references preserve valid plan contract versions. The
  friction suite exposed a legacy start whose successful response omitted its
  version after falling back to references; both ordinary and minimal reference
  paths now retain that bounded contract field.
- The next blocking pass added complete Git branch inspection parsing, quoted
  working directories, informational-command prerequisite handling, and script
  argument boundaries. Recovery guidance now matches retry eligibility and
  preserves existing gate/shipping polls. [Follow-up record](blocking-followup.md)
  separates these reproduced fixes from documented limits and remaining work.
- Parent-tool refusals now retain their affected reference entries independently
  of active state. Result hooks and fresh/prepared receipt admission consult
  those observations; authorized repairs and reads stay available. Matched
  unchanged commands and retained host-call outcomes avoid relabeling worker
  edits, and exact observed restoration clears only the affected entries.
- Retained execution-budget continuations now name `ape_run next` in diagnostics
  and bounded responses. Explicit worker-retirement waits keep precedence.

The admission digest records reviewed inputs; it is not proof of human approval.
Legacy records remain readable without gaining new authority. Retry budgets and
automatic recovery were not expanded. Repair-and-land remains deferred.

## What passed

| Check | Recorded result |
|---|---|
| Full 2.24.12 source suite after merging public main and rebuilding both packages | 4,309 passing tests across 260 files; 86 existing skips |
| 2.24.12 model-free operational replay, including test correction and abort-reason persistence | 654 passing tests across 23 files |
| Supporting checks | Type, compatibility, prompt, public-safety, both host package/MCP smoke, and package/release reproducibility checks passed |
| Previously recorded native Codex mechanical run on 2.24.11, before these follow-up fixes | Completed with first-pass receipt acceptance and a protected test merge; no observed APE failure or recovery |

The 2.24.12 full-suite run includes all operational replay test files and the
new admission, Git inspection, working-directory, receipt-schema, parent-attribution, recovery,
optional-capability, compact-response, public-export, and abort regressions. It completed without
failures in 291.75 seconds. The separate operational replay passed in 104.38 seconds. Both plugin
packages and release artifacts were rebuilt locally; type, compatibility,
prompt, public-safety, package validation, smoke, and reproducibility checks
passed. The installed plugin was not updated.

The first friction run exposed two obsolete quoted-search denial assertions and
a compact-response version omission. The search assertions now cover the intended
allow and deny behavior, reference projections preserve the plan version, and the
complete suite was rerun successfully after those corrections.

The blocking follow-up's first completed full run exposed an archived shipping
fixture using an invented hold reason and a public-export refusal of the approved
project name. The fixture now matches the actual lifecycle hold, with negative
archived cases for unsupported shipping advice. The export checker accepts the
exact project name while retaining other identity checks. The complete suite
passed after both corrections.

The later attribution pass added paired parent-tool observations, retained
host-call outcomes, exact restoration checks, fresh/prepared receipt refusal,
and actionable continuation guidance. Its integration review also reproduced
real external-helper writes from ordinary Git diff commands; Git inspection now
uses paired tree observations. The complete 260-file suite passed after those
changes, including all 58 additional regressions from this pass.

Offline replay uses the scheduler, hooks, MCP boundary, schemas, receipts, and
simulated shipping. Live host certification remains a separate requirement.

## What is still unverified

The 2.24.12 packages require a new candidate-bound live campaign and Claude
worker-validator proof. Earlier version evidence cannot certify these packages.

The fast, full, and protected-land live scenarios on 2.24.11 remain unverified.
The campaign stopped at the operator's request, and its disposable setup was
removed. A project-trust entry appeared in the isolated profile during launch,
raising a setup
authorization concern; it is not a confirmed APE runtime defect.

Full Claude operation also remains unverified. Its candidate-bound worker-validator
reachability check is a separate release prerequisite.

No complete release certificate exists. The release workflow still requires the
clean Codex campaign described in [operational readiness](operational-readiness.md).
Opening a review PR does not require claiming that this gate has passed.
Installation, trust changes, pushes, tags, and publication still need explicit
authorization.

## Historical evidence disposition

The audit accounts for all 180 non-success runs and 44 failed control calls.
Only this aggregate summary and synthetic reproductions belong in the public
repository; original identifiers, objectives, receipts, and evidence stay private.

| Disposition | Runs | Failed control calls |
|---|---:|---:|
| Direct defect-to-regression mapping | 5 | 4 |
| Expected guard; historical merits not certified | 111 | 37 |
| Configuration or external prerequisite | 10 | 2 |
| Recorded operator stop | 5 | 0 |
| Later completion in retained history | 4 | 0 |
| Insufficient incident-to-fix evidence in the original audit | 45 | 1 |
| Total | 180 | 44 |

The directly mapped runs cover preflight scheduling, non-behavioral red-test
scheduling, remote completion versus cleanup failure, and queued protected merges.
The four directly mapped calls cover contradictory reset advice. Guard tests
include both prohibited and authorized cases, but cannot establish whether every
historical refusal was justified.

The original audit's 45-run label meant no individually proven cause-to-fix
mapping, not that every stopping mechanism was unknown. Follow-up inspection
recovered all six missing abort reasons from the override audit log and host
transcripts. Of 20 test-contradiction or fixture incidents, 12 mechanisms were
independently corroborated, one was partly corroborated, and seven remain
supported only by worker receipt chains. Other evidence identifies baseline
and scope mistakes, failed test inventories, external worker errors, and native
context-delivery failures; their underlying causes and release fixes are not
uniformly proven.

The failed call has a retained 300-second MCP timeout. The operation persisted
successfully and its run later completed; the audit had overlooked the error
field. A timeout does not by itself establish a failed run.

The follow-up reproduced one remaining post-build recovery defect: a corrected
test that passed was rejected by inherited red-first admission. The current
candidate now uses runtime-owned `test-correction`, preserving stable passing
and failing corrections before the implementer's remaining retry. Initial RED,
scope, tree stability, and per-runner nondeterminism checks remain enforced.
Override-abort also now preserves its bounded reason in run state and new
history records. Existing immutable history is unchanged. Neither change proves
every historical run fixed or completes native live certification.
