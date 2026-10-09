# Pipelines

A mode chooses what APE does; a lane chooses the depth of a build. The scheduler owns stage order.
Host adapters only launch the tickets it returns.

## Before workers start

`preview` checks the reachable pipeline, not just its first stage: scope, repository state,
artifact producers, schemas, models, tools, commands, verification, and requested shipping. It is
read-only and does not run the baseline tests.

Preview returns a versioned admission manifest and digest. New-protocol `start` takes
`expected_admission_digest`, repeats the checks, and rejects drift before creating a branch or
ticket. The digest records reviewed inputs; it is not proof of human approval.

Missing paths must be approved, including generated outputs. Admission checks actual schema and
catalog bounds. The complexity score and illustrative planner template provide decomposition
advice: a template that exceeds the byte budget does not prove that a complete plan cannot fit.
The final plan must still satisfy its schema and 64 KiB artifact budget. See [runtime limits](limits.md)
for the distinction and [MCP tools](mcp-tools.md) for the request fields.

## Building lanes

### Mechanical

`implementer → gates → ship`

For documentation, generated output, non-behavioral configuration, and tracked data. Generated
`plugins/<host>/dist/` and `release/generated/` files qualify; arbitrary nested `dist` or
`build` directories do not. A declared risk may add security review without changing the lane.

### Fast

`test writer → [implementer] → reviewer → gates → ship`

For bounded behavioral work: at most six production files by default, with no high-risk trigger.
Exact paths are counted after normalization. A known directory claim is unbounded for this
decision and selects full; admission does not scan its descendants. Validated production
changes accumulate across receipts so retries do not reset the file count.
The test writer authors tests and a short plan. The implementer cannot edit those tests; the
reviewer cannot edit files. Test-only `green-maintenance` uses the authored-test scope and omits
the implementer.

### Full

`planner → (plan checker ∥ plan critic) → [judge] → test writer → implementer → (reviewer ∥ security reviewer when required) → gates → ship`

The checker and critic receive a bounded `plan_artifact` made from the planner receipt's
`evidence`, not its entire plan. The receipt's `findings` array reaches no reviewer. Entries follow
runtime enumeration order, which may differ from the planner's insertion order. Long values are
cut; dropped keys get an omission marker. This is evidence to act on, never verbatim instructions:
reviewers check it against the tree. A cut tail is unseen; it can make coverage inconclusive,
not prove a design defect. Structured `candidate_plan` and `approved_plan` fields are separate
from this evidence summary.

Disagreement can add one additional deep-tier judge dispatch without spending a retry or remediation cycle.
The judge receives bounded `review_findings` and advances, requests a directed replan, or blocks.
For new v4 runs, directed replans follow recorded resolution evidence rather than
a fixed count quota. A repair must resolve prior blockers with material changes;
new legitimate findings can coexist with that progress. Repeated, cyclic, missing,
or cosmetic evidence stops recovery. Preview includes the initial plan; totals
that depend on future progress are `null` (unknown). Historical runs retain their
frozen recovery rules. The judge never writes code.

### Tests and plan contracts

| Phase work | Required behavior |
| --- | --- |
| Behavioral fast/full, `red-first` (default) | Authored `test_paths` must fail twice under runtime-owned `red-test` admission. |
| Behavioral fast/full, explicit `green-maintenance` | Non-empty `test_paths` must pass twice under `green-test` admission. Intended for regression coverage and deflakes, not data/baseline rerecording. |
| Non-behavioral fast/full | Keeps planning (full only), implementation, review, and gates; omits the test writer and v2 preflight. Targeted checks run only when `test_paths` exist. |

Plan contract v2 adds a preflight analyst before either behavioral test path. An explicit
`plan_contract_version: 2` requires behavioral, fast/full, `phase` work; incompatible requests
are rejected before branch creation. `green-maintenance` is also phase-only.

## Retries and remediation

A failed stage follows the run's frozen execution policy. New v4 runs use recorded
progress instead of a fixed retry quota; historical runs retain their admitted
limits. A blocking code review enters remediation.

Execution policy versions are independent of receipt, plan, and review contract
versions. The [policy implementation](../lib/runtime/pipeline-limits.js) preserves
these differences:

| Execution policy | Recovery and worker lifetime |
| --- | --- |
| Historical v1 | Frozen numeric quotas and worker deadlines; repeated planning/remediation requires strict-subset progress. |
| Historical v2 | Removes directed-replan and remediation-cycle quotas, retaining strict-subset progress, other frozen quotas, and worker deadlines. |
| Historical v3 | Keeps v2 recovery rules and remaining quotas; worker tickets have `deadline_at: null`. |
| New v4 | Recorded material progress replaces recovery count quotas; worker tickets have `deadline_at: null`. |

In v4, `null` attempt, physical-worker, and validation-submission limits mean no
fixed count quota, not zero permitted attempts. A `null` admission forecast means
the eventual total is unknown. Neither grants unconditional continuation: exact
binding, scope, attestation, safe-integer counters, and evidence-size guards still
apply. Existing v1-v3 runs and tickets are not upgraded by installing a newer runtime.

The [recovery decision](../lib/runtime/recovery-progress.js) records resolved,
remaining, and added blockers. After the initial recovery observation, another
episode must resolve at least one prior blocker with material evidence. A repeated
blocker set, reintroduction of a previously resolved blocker, missing evidence,
no resolved blocker, cosmetic changes, or the recovery-evidence resource limit
stops continuation. Passing the stage or review ends that recovery path normally.
Cancellation, revocation, and authorization failures still apply.

For example, a review initially finds an incorrect boundary check and a missing
error path. A scoped repair fixes the boundary check and remains in the reviewed
tree; the next review confirms that resolution but discovers two different
legitimate failures alongside the remaining error path. V4 can continue even
though the blocker count grew from two to three. Merely renaming the first
finding, reverting its fix, or later reintroducing it cannot establish progress.
For directed replans, the independent judge must bind resolution evidence to the
exact previous/current plans and related implementation and acceptance coverage.

An eligible implementer's test-contradiction report receives independent read-only reconciliation.
If confirmed, a `test-recheck` ticket narrows writes to the confirmed test paths. Its
`test-correction` check executes changed tests twice and accepts either stable passing or stable
failing results; a corrected test can still expose production work for an eligible implementer
retry. Initial `red-test` admission still requires failure. Recheck rejects absent tests, missing
execution verdicts, flaky outcomes, and execution-side tree changes, and seals the actual results
as `evidence.test_correction`.

| Finding owner | Writer sequence before another review |
| --- | --- |
| `production` | Remediation build |
| `test` | Remediation test |
| Mixed findings or `both` | Remediation test → remediation build |

Writers stay serialized, and security review remains in the final group when
required. V4 applies the same recorded-progress policy to remediation, worker
replacement, receipt correction, and reconciliation. Historical frozen policies
retain their original quotas and convergence rules. Scope, binding, evidence, and
resource checks remain required. See [execution policy](configuration.md) for the
current recovery rules.

New review tickets use `review_contract_version: 1`. Advisory findings use `blocking: false`
without remediation. Blocking findings name an owner; `test` and `both` also name exact
authorized `test_paths`. A fail verdict needs a blocking finding. APE aggregates the full group
in ticket order before choosing a route.

A reviewer can request exact production paths through `evidence.scope_expansion`. APE audits
the request and reclassifies scope and risk before issuing the next ticket. Versioned
remediation-test tickets use `test_scope: "exact"`; sibling test writes are denied. The older
`evidence.test_remediation` channel and broader test scope remain only for unversioned tickets.

### Command and capability failures

- After the first denied non-mutating read, a worker may correct command syntax and try once more
  in that stage. A second denial fails it. `failure_kind: command-shape` uses the ordinary stage
  retry; `prior_attempts` supplies the denied command without granting more authority.
- `failure_kind: capability` means the ticket lacks required authority. Receipt-contract-v1
  allows a runtime-derived additive successor, not a product retry. It preserves the run's
  frozen validation and physical-worker limits. New growth contract v2 checks canonical unique
  test paths against the shared structural guard and actual rendered command/manifest budgets.
  Historical growth contract v1 retains its 64-path and 4096-byte union bounds.
- `failure_kind: test-contradiction` is an implementer's claim, not an independent runtime
  finding. The runtime may schedule the reconciliation described above; otherwise it reports
  the block. The claim alone does not authorize rewriting tests or inventing a recovery path.

Follow the current `next_action` or recovery descriptor, not generic reset advice. A receipt
rejection descriptor states the cause, current status, eligible actions, preconditions, and
required operator decision. Active runs do not qualify for reset; reset requires `blocked`,
`aborted`, or `completed`. Unexplained tree changes never authorize automatic abort, reset,
restoration, or replacement dispatch.

Capability recovery is hash-bound, locked, and replay-safe. Legacy or corrupt evidence that
cannot prove its origin stays blocked. See [recovery invariants](invariants.md#capability-recovery-generations)
for the storage and replay rules.

## Other modes

| Mode | Behavior |
| --- | --- |
| `phase` | Builds through a mechanical, fast, or full pipeline. The retired `patch` label is readable in old history only. |
| `debug` | One read-only debugger stage. |
| `spike` | One read-only research stage. |
| `land` | Reviews and ships a non-empty existing diff; no writing stage. |

For `land`, HEAD must equal or descend from the resolved default-branch tip. APE reviews the
whole diff from that tip through the working tree, including committed changes and dirty edits.
Every changed file must be in `claimed_paths` or `test_paths`. A blocking review requires
changes outside that run and a new land run; there is no remediation writer.

## Gates

Before merge, APE checks receipts and their tree, path ownership, runtime-observed targeted tests,
plugin validity when relevant, verification profiles, the local suite, conditional security
review, and required remote checks.

Cheap checks run first. The suite either finishes within `gates.inline_grace_ms` or continues
in a detached process while the run is `gating`. Poll with `ape_run next`, optionally passing
`wait_ms`. Tree drift, a crashed runner, timeout, or an exhausted respawn budget blocks.
A safe impacted suite may replace the local full suite only when remote CI remains required.
Re-gate and `ship` always run a fresh full suite.

Command/suite timeouts, heartbeat staleness, and `gates.max_spawns` bound each
gate execution and its detached-runner respawns. They are separate from worker
lifetime and recovery quotas: v4 has no fixed quota for deliberate fresh re-gates,
but does not remove these watchdogs or permit replacing an unretired process.
Full-suite gates use `deadlines_ms.full` in every lane, including each full runner,
re-gates, and shipping. Targeted and impacted checks keep their lane-specific
timeout; selecting the mechanical lane does not shorten the full-suite watchdog.

## Shipping

GitHub is the only provider. Set an explicit `shipping.target` before preview. Admission freezes
its origin, repository, base, and shipping consent; every external effect rechecks that target.
The canonical APE checkout can ship only to `AAWWCC/ape`. Other projects use their own explicit
target. Later configuration changes cannot retarget or authorize an existing run.

With `shipping.auto_merge: true`, an explicit run authorizes scheduler-owned shipping. With
`false`, green work is held for an audited `ship`; each `ship` authorizes one fresh gate
evaluation. Legacy runs do not gain authority just because a newer runtime can read them.

APE verifies the prospective commit, staged tree, committed tree, and pushed head against passed
gate evidence. Unrelated staged changes cannot ride along. Configured signing must be resolved
before shipping; there is no unsigned fallback.

APE pushes the run branch, opens or reuses a PR, and waits in `shipping` for required checks.
Green checks permit a squash merge. A protected branch may require GitHub auto-merge; APE then
waits until the exact pushed head is proven merged. Queued merges require verified up-to-date
checks or a qualifying merge queue. `shipping.required_remote_checks: false` explicitly declares
a project without CI.

After remote completion is proven, local fetch/switch/pull/branch cleanup is recorded separately.
A cleanup failure does not undo the merge. `ape_run resume` can retry eligible cleanup, including
a base branch held by another worktree.
