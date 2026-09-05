# Prevention-first reliability status

**2.24.11 is a review candidate, not a certified release.** Reproduced blockers
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

The admission digest records reviewed inputs; it is not proof of human approval.
Legacy records remain readable without gaining new authority. Retry budgets and
automatic recovery were not expanded. Repair-and-land remains deferred.

## What passed

| Check | Recorded result |
|---|---|
| Runtime source suite before the version-only bump | 4,063 passing tests; 86 existing skips |
| Model-free operational replay | 586 passing checks |
| 2.24.11 version-only follow-up | 213 focused passing tests |
| Supporting checks | Type, compatibility, prompt, public-safety, both host package/MCP smoke, and package/release reproducibility checks passed |
| Native Codex mechanical run on 2.24.11 | Completed with first-pass receipt acceptance and a protected test merge; no observed APE failure or recovery |

The full suite was not rerun after the version-only bump. These results describe
the tested candidate, not later edits. Offline replay uses the scheduler, hooks,
MCP boundary, schemas, receipts, and simulated shipping; it is not a live host
certificate.

## What is still unverified

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
| Insufficient evidence | 45 | 1 |
| Total | 180 | 44 |

The directly mapped runs cover preflight scheduling, non-behavioral red-test
scheduling, remote completion versus cleanup failure, and queued protected merges.
The four directly mapped calls cover contradictory reset advice. Guard tests
include both prohibited and authorized cases, but cannot establish whether every
historical refusal was justified.

**45 runs and one failed call remain unexplained.** Better diagnostics do not prove
those historical causes fixed, and not every blocked run was a software bug.
