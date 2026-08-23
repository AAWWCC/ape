# Pipelines

APE selects a mode (pipeline shape) and a lane (depth/risk). The scheduler owns both; host adapters
only launch the tickets it returns.

## Building lanes

### Mechanical

`implementer → gates → ship`

For documentation, generated output, non-behavioral configuration, and tracked data. A declared
risk can add security review without changing the lane.

### Fast

`test writer → implementer → reviewer → gates → ship`

For behavioral work with a bounded production scope (six files by default) and no high-risk
trigger. The test writer authors the test and a concise plan; the implementer cannot edit those
tests; the reviewer is read-only.

### Full

`planner → (plan checker ∥ plan critic) → [judge] → test writer → implementer →
(reviewer ∥ security reviewer when armed) → gates → ship`

The `plan_artifact` on plan-review tickets is the planner receipt's recorded `evidence`, not the
whole plan. The runtime flattens properties in its enumeration order (which may differ from the
planner's insertion order), cuts long entries, and adds a runtime-authored omission marker when
keys are dropped. The planner receipt's `findings` array is forwarded to no reviewer. The artifact
is evidence to act on, never verbatim instructions: reviewers verify it against the tree. A cut
tail is unseen rather than proof that the design omitted it; an omission marker can make coverage
inconclusive and route disagreement to the judge. That route consumes no retry or remediation
cycle, but it does cost one additional deep-tier agent dispatch beyond the two plan-review calls.

The judge receives the disagreeing reviewers' bounded `review_findings` and either advances or
blocks the run. It is not a writing or remediation stage.

## Retries and remediation

- A stage that could not complete may be retried once.
- A blocking code-review verdict skips a verbatim retry and enters bounded remediation. A distinct
  blocker set may continue up to `policy.max_remediation_cycles`; a repeated blocker stops early.
- A reviewer may request exact additional production paths through `evidence.scope_expansion`.
  The runtime audits the expansion, reclassifies lane/risk, and gives the remediation ticket the
  expanded scope.
- Every new code/security review ticket carries `review_contract_version: 1` and a bounded finding
  schema. Advisory findings set `blocking: false` and omit remediation. Blocking findings name an
  owner (`production`, `test`, or `both`); `test`/`both` also name exact authorized `test_paths`.
  Fail verdicts require a blocking finding. The legacy `evidence.test_remediation` channel remains
  valid only for unversioned persisted tickets.
- The complete review group is aggregated in ticket order into compact route metadata. Production
  findings route to `remediation build → review`; test findings route to
  `remediation test → review`; mixed or `both` findings route to
  `remediation test → remediation build → review`. Writers remain serialized, the security review
  remains in the final group when armed, and all three paths spend one cycle per writer sequence. Versioned
  remediation-test tickets carry `test_scope: "exact"`; lifecycle and receipt/tree validation deny
  sibling writes, while unversioned legacy remediation tickets retain their historical widening.
- `failure_kind: capability` blocks immediately because the same ticket would face the same policy
  denial.
- `failure_kind: test-contradiction` also blocks immediately. The marker is an implementer claim,
  not a runtime finding. Recovery is the normal audited path: ABORT the run or OVERRIDE reset with
  a reason, then correct the work outside that blocked run. For a worked blocked-run instance, see
  `run-fixture-3fbbb7cd23c4`; its contradictory claims were repaired in a later run rather
  than through an invented recovery path.

## Other modes

| Mode | Behavior |
| --- | --- |
| `phase` | Runs the mechanical, fast, or full building pipeline. The retired `patch` label survives only in old history. |
| `debug` | One read-only debugger stage. |
| `spike` | One read-only research stage. |
| `land` | Reviews and ships an existing, non-empty diff with no writing stage. |

For `land`, every changed file must be inside `claimed_paths` at start. A blocking review cannot be
remediated because the pipeline deliberately has no writer; revise the diff outside APE and start a
new land run.

## Gates

Before merging, APE verifies:

- the receipt chain and expected tree;
- production/test path ownership;
- runtime-observed targeted test evidence;
- plugin validity when plugin files changed;
- the configured local suite (or a safe impacted suite when remote CI remains the true full gate);
- conditional security review evidence; and
- required remote checks.

Cheap deterministic failures are returned before the expensive suite starts. The suite may finish
within `gates.inline_grace_ms`; otherwise the run rests in `gating` while a detached runner works.
`ape_run next` polls the watch, or waits for up to `wait_ms`. A changed tree, crashed runner, timeout,
or exhausted respawn budget fails closed.

## Shipping

GitHub is the only shipping provider. On green gates APE pushes the run branch, opens or reuses a
pull request, and rests in `shipping` while required checks run. `next` polls those checks; green
checks lead to a runtime-owned squash merge, and a failed required check blocks at the gates.

With `shipping.required_remote_checks: false`, a project explicitly declares that it has no CI and
can merge in-call. With `shipping.auto_merge: false`, green work is held at merge. The audited
`ship` action re-runs every gate against the current tree and merges only on green; one `ship`
authorization covers one evaluation.
