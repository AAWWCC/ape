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

Missing paths must be approved, including generated outputs. The planner skeleton checks whether
the declared work fits the contract and gives decomposition guidance when it does not. It does
not approve the design. See [MCP tools](mcp-tools.md) for the request fields.

## Building lanes

### Mechanical

`implementer → gates → ship`

For documentation, generated output, non-behavioral configuration, and tracked data. Generated
`plugins/<host>/dist/` and `release/generated/` files qualify; arbitrary nested `dist` or
`build` directories do not. A declared risk may add security review without changing the lane.

### Fast

`test writer → [implementer] → reviewer → gates → ship`

For bounded behavioral work: at most six production files by default, with no high-risk trigger.
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
There are at most two directed replans. After the first, the normalized assurance identities must
strictly shrink. Preview includes the initial plan and both possible replans. The judge never
writes code.

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

A failed stage gets at most one retry. A blocking code review instead enters remediation:

| Finding owner | Writer sequence before another review |
| --- | --- |
| `production` | Remediation build |
| `test` | Remediation test |
| Mixed findings or `both` | Remediation test → remediation build |

Writers stay serialized. Each sequence spends one of `policy.max_remediation_cycles`; security
review remains in the final group when required. After the first cycle, normalized blocker
identities must strictly shrink. Repeated, expanded, incomparable, or malformed blocker sets stop.

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
  allows one runtime-derived additive successor, not a product retry. It keeps the same limits:
  three validations per worker, two workers per ticket lineage, and a test-path union of at most
  64 unique project-relative paths and 4096 serialized UTF-8 JSON bytes.
- `failure_kind: test-contradiction` blocks immediately. It is the implementer's claim, not an
  independent runtime finding. It does not authorize rewriting tests or inventing a recovery path.

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
