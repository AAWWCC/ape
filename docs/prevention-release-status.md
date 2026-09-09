# Prevention-first reliability status

**2.25.7 is a review candidate, not a certified release.** It corrects the
catalog request contract used by the certification runner. Codex remains pinned
to 0.153.4 with GPT-6 Astra low/medium/high defaults. Exact-candidate CI and a
newly authorized four-workflow campaign remain required. Earlier failed
campaigns retain their original classification.

## 2.25.6 validation and failed formal campaign

Frozen commit `ed89d972f870a3dbe3c63e252c6c0b58103cc591` passed all 18 jobs in
[CI 34303931274](https://github.com/AAWWCC/ape/actions/runs/34303931274), including
both Windows Node versions. The mechanical workflow completed: all 13 APE
control results succeeded, the worker's sole receipt validation passed, gates
passed, and [synthetic PR #1](https://github.com/AAWWCC/ape-release-validation-20260908/pull/1)
merged under the unchanged protection policy. The exact PR head's required
`Synthetic tests` check succeeded, and its merge rule suite passed. Synthetic
main advanced to `21b23fe7e35383f8f4186a66d6699484ce2159e7`.

The launcher nevertheless exited with code 1 after rejecting the pinned host's
`GET /ps/plugins/installed?limit=200` catalog request. Its stub required a scope
and omitted the host's all-scopes request form. This runner failure disqualifies
the formal campaign; fast, full, and protected-land were not attempted. Owned
processes exited and temporary authentication was removed. The native receipt
handoff and original-child association were verified; equality of decoded
bootstrap-message plaintext remains unverified in the opaque transport records.

The offline correction compares all six allowed routes against the same pinned
host source, including the mutually exclusive installed-plugin query forms,
featured-platform values, and rejection of duplicate query keys. Response
bodies remain deterministic, typed empty results; unknown routes and methods
remain rejected.

## 2.25.5 validation and failed formal campaign

Frozen commit `77bd588683f2336452fabdd885eaf168bb988c18` passed all 18 jobs in
[CI 34301071318](https://github.com/AAWWCC/ape/actions/runs/34301071318), including
both Windows Node versions and 701 operational canaries. The dependency audit
reported zero vulnerabilities. Native model metadata advertised Astra V2 with
all configured efforts, and all four launcher preflight checks passed.

The first mechanical workflow ran for 220.138 seconds. Native worker launch,
binding probe, acknowledgement, and run start succeeded. The worker's first
receipt-validation call omitted `project_dir` and returned `no active run`;
adding only the project path succeeded. The tool description and authoritative
guidance had demonstrated only `ticket_id` and `draft`. The initial failure
still disqualifies the campaign under its first-attempt rule.

The parent accepted the worker receipt and gates passed, but shipping rejected
an index/gate-tree mismatch. A disposable offline reproduction isolated the
cause: gate snapshots removed tracked `.ape/config.json` while shipping
retained that unchanged baseline file. The launcher separately rejected the
host's `/ps/plugins/suggested/codex` catalog route. No PR or merge occurred;
remote main and protection stayed unchanged. Cleanup retained the generated
uncommitted documentation, while the owned processes exited and temporary
authentication was removed. Fast, full, and protected-land were not attempted.
Opaque bootstrap transport records establish matching non-message dispatch
fields, not equality of decoded bootstrap-message text.

## 2.25.4 validation and failed formal campaign

Frozen commit `16c9deb9559b88447bf0366094388f160fd0ad01` passed all 18 jobs in
[CI 34298522391](https://github.com/AAWWCC/ape/actions/runs/34298522391), including
both Windows Node versions and 701 operational canaries. The high-severity audit
gate passed while reporting three moderate entries for one Vitest development-
server advisory; 2.25.5 updates that development tooling.

The first live mechanical attempt failed after 78.877 seconds. Doctor, config,
preview and probe preparation succeeded, but the pinned Codex 0.147.0 host
rejected `gpt-6-astra` at native child launch. Its freshly retrieved model catalog
omitted Astra even though the parent could use the model. No child, binding,
APE run, receipt, branch push, PR or merge occurred. Remote main and protection
remained unchanged. The campaign stopped with zero qualifying completions;
fast, full and protected-land were not started. Exact decoded bootstrap-message
equality was not established from the opaque transport records.

The source fixes retain their narrower validation: the earlier
[Windows CI failure](https://github.com/AAWWCC/ape/actions/runs/34296408215) led to
consistent file-identity helpers, and the subsequent
[cleanup CI failure](https://github.com/AAWWCC/ape/actions/runs/34297564805) led to
bounded temporary-directory removal retries. Both failed runs remain recorded.
The latter error did not reproduce locally; its originating writer or filesystem
condition remains unknown. The successful CI does not establish live completion.

## 2.25.3 validation and failed formal campaign

Frozen commit `65aeda1f388b126c9faa08bfbdfc2ebcb41cbdf4` passed all 18 jobs in
[CI 34237467513](https://github.com/AAWWCC/ape/actions/runs/34237467513).
Its first formal mechanical attempt nevertheless failed when the child attempted
a prohibited command before binding. No run or shipping completed; fast, full,
and protected-land were not completed. The campaign remains failed, and the
candidate changes do not establish the cause of that child's tool choice.
All earlier failed attempts retain their original classification.

## 2.25.3 certification provider request fidelity

Pinned Codex 0.147.0 identifies OpenAI request handling by the selected provider's
exact display name, `OpenAI`. Other labels remove internal message metadata and
function encryption metadata from outgoing history. The launcher previously
accepted any nonempty label; it now rejects labels that select that different
request path. A separate custom provider ID and explicit zero-retry settings
remain required. Endpoint and authentication identity remain separately reviewed
preflight requirements; the name alone does not establish them.

Two offline controls using the exact pinned binary reproduced this difference
with a scripted loopback endpoint and synthetic assignments. Both delivered the
synthetic plaintext assignment correctly. They made no real model or credential
calls and do not prove an explanation or fix for the earlier live failure.
Historical validation below retains its exact version and source attribution.

## 2.25.2 validation and failed formal campaign

Frozen commit `b16941eae308554395505c5592bf81a489ef3f1a` passed all 18 jobs in
[CI 34186530890](https://github.com/AAWWCC/ape/actions/runs/34186530890), including
both Windows Node pins. Its complete source suite passed **5,124 tests across
308 files**, with zero failures and 87 skips. These CI results cover that frozen
commit; this status documentation was updated afterward.

The first formal mechanical attempt failed after **100.247 seconds**, before
`ape_bind` or run start. Its native child attempted a prohibited shell call,
which the hook denied. No PR or merge occurred; remote main and protection
remained unchanged. The campaign stopped with zero qualifying completions,
and fast, full, and protected-land were not started.

The exact revised reserved-probe guidance was delivered before the prohibited
call. Its delivery did not prevent the failure, so an explanation based only
on omitted guidance is unsupported. The child's exact decoded assignment input
remains unknown. Version 2.25.2 corrected conflicting guidance and a misleading
denial diagnostic; no additional source fix is claimed for this formal failure.

A complete macOS ARM64 run on Node 24.15.0 passed **5,124 tests across 308
files**, with zero failures and 87 skips. The focused probe and bootstrap tests
also passed on Node 22.12.0. Type checking, host compatibility, all 52 offline
prompt scenarios, public-safety checks, fresh bundles and package parity passed.
Both Node pins passed packaged MCP smoke, clean marketplace installs on pinned
Codex 0.147.0 and Claude 2.1.228, and package/release reproducibility under each
runtime. The two local runtimes produced different gzip bytes but identical
uncompressed archive bytes; publication uses its separately pinned Ubuntu
toolchain. These local checks and the subsequent CI result do not replace the
required four ordered live certification workflows; the formal campaign failed.

## 2.25.1 remote validation and failed formal campaign

Commit `5c63369826f6e8cc073a88941d3894773164884a` passed all 18 jobs in
[CI 34181947640](https://github.com/AAWWCC/ape/actions/runs/34181947640), including
both Windows Node pins. Its complete source suite passed 5,117 tests across
308 files, with zero failures and 87 skips. Both earlier failed CI runs remain
retained.

The first formal mechanical parent ended after the probe child attempted shell
inspection before `ape_bind`. The hook denied it; the last authoritative state
remained `launched / awaiting_binding`. No run, acknowledgement, receipt, PR or
merge occurred. The campaign stopped with zero qualifying completions. The
same host/model/bootstrap instructions had passed a separate rehearsal; that
rehearsal cannot replace the formal failure. Encrypted assignment storage does
not establish the exact decoded input seen by the child.

Fresh offline fixtures on both Node pins reproduced the generic denial against
a healthy reservation and showed that exact bootstrap binding remained possible.
Those disposable checks diagnose enforcement; they do not repair the campaign.

## 2.25.1 codebase audit remediation

All 13 reproduced audit findings now have source fixes and regression coverage.
The changes repair task cancellation and error persistence, detached launch
failures, bounded receipt and manifest parsing, interrupted statusline setup,
targeted merge gates, globstar ownership, saved evaluation evidence, release
auditing/action pins, worker proof parsing, and receipt-result budgets. The
cleanup removes 11 unused exports and shares duplicate validation and tooling.
State writes retain complete destinations after Windows retry exhaustion and
sync file contents and supported directory entries.

A fresh complete run on macOS ARM64 with Node 24.15.0 passed **4,856 tests across
285 files**, with 86 platform/host skips and zero failures. All 693 operational
canaries passed. Type checking, configuration documentation, host compatibility,
offline prompt checks, public-safety checks, packaged MCP smoke tests, Claude
manifest validation, package parity, and package/release reproducibility passed.
The dependency audit reported zero vulnerabilities. Local 2.25.1 release archives
were regenerated; these results do not replace native CI or live certification.
A concurrent follow-up audit began further source changes after this passing run.
The counts above describe the completed batch; the later edits need their own
verification and regenerated packages.

## 2.25.1 recovery patch

The patch packages validated source-tree handoff across capability recovery,
including unchanged read-only successors and exact published-generation replay.
The recovery fix passed code and security review, 4,665 local tests with 87 skips,
and post-merge CI and CodeQL before this version bump. Those results do not
replace a fresh candidate-bound live certification campaign for 2.25.1.

## 2.25.0 limits audit

The limits overhaul replaces separate plan/prose/count ceilings with shared
resource budgets, makes execution limits configurable and freezes them per run,
and repairs history pagination, storage observers and receipt recovery. Existing
issued contracts retain their exact legacy bounds. See [runtime limits](limits.md)
for each retained policy and its rationale.

The final local verification covers 4,637 passing tests across 276 files, with
87 platform or live-host skips, using the complete suite plus complete reruns of
three corrected files. Type, configuration documentation, bundle freshness,
package parity/reproducibility, both packaged MCP servers, public-safety and
offline prompt checks passed. After the 2.25.0 bump, all 216 version-specific
tests across five files and all 671 operational canaries across 23 files passed.
Native platform CI and fresh candidate-bound live certification are separate
evidence; these local results do not certify a live release. Historical results
below retain their original version attribution.

## Earlier candidate changes

- The 2.24.14 audit repairs fresh preflight audit initialization and answer
  handling, Windows npm/npx launcher and command-name resolution, and npm
  package/script inspection across workspace, shell, environment, and PATH
  selection. Current and baseline inspection share the selected invocation.
- Node 22 hook responses finish writing before exit. Windows file reads compare
  exact identifiers using the same volume-serial representation as corrected
  libuv versions. Missing pathname device identifiers use separately verified
  read-only handles, retaining device, inode, replacement, and mutation checks.
- Task operations capture their own gate ownership while holding the receipt
  lock. Cancellation preserves another operation's watch and already-completed
  results; fresh processes retain durable receipt/task replay boundaries.
- The audit also repairs runner location and deletion routing, required fast-lane
  verification profiles, per-directory cache identity, exact merge evidence,
  interrupted roadmap recovery, and configuration/diagnostic handling. Ordinary
  POSIX suite descendants are supervised through exit, timeout, cancellation,
  and owner loss in source and packaged paths.
- New fixtures execute both copied plugin packages through fresh MCP/hook
  processes and test real process restarts and locks. Required native CI now
  selects ten runtime suites on Linux, macOS, and Windows under Node 22.12.0
  and 24.15.0. The aggregate rejects failed, cancelled, or skipped dependencies.
- Certification preflight now requires the pinned Codex CLI's native V2 agent
  interface explicitly. The 2.24.12 live attempt exposed a setup gap: ordinary
  multi-agent availability did not establish support for APE's launch fields.
  Missing or invalid `features.multi_agent_v2` settings now fail before a parent
  starts; worker envelopes and ordinary runtime gates are unchanged.
- Claude's authenticated validator check is now optional. Codex remains the sole
  required live host, while Claude packaging checks remain in CI and live Claude
  operation remains explicitly unverified. Missing Claude access does not block
  a Codex-certified release.
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
  preserves existing gate/shipping polls. See [shell policy](hooks.md#bound-subagent-shell-policy)
  for supported inspection forms and remaining shell limits.
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

Before the missing-device follow-up, the Node 22 CI repairs passed the complete
macOS / Node 24.15.0 suite: 4,521
tests across 270 files, with 87 existing skips, in 466.79 seconds. The rebuilt
native selection also passed on actual macOS / Node 22.12.0: 167 tests across
ten files, with three Windows-only skips. Both packaged-host lifecycle fixtures
passed, along with the new output-backpressure and Windows file-identity
regressions. Type, compatibility, public-safety, package freshness, package and
release reproducibility, packaged MCP smoke, prompt definitions and verified
public export checks passed. That native Windows run still failed, leading to
the missing-device follow-up below.

The subsequent native Windows diagnostic isolated an omitted pathname device
identifier (`0`), beyond the volume-width discrepancy. The missing-device fix
adds stable-file, cross-device, inode-substitution, and replacement-race controls.
All 80 focused tests across four files passed on macOS / Node 22.12.0, including
the output-drain, active-state, and module-boundary suites. Native Windows CI for
this follow-up remains required.

The complete audited runtime, immediately before the 2.24.14 metadata bump,
passed 4,512 tests across 268 files with 87 skips in 458.79 seconds on macOS and
Node 24.15.0. The new native CI selection passed 158 tests with three Windows-only
skips across eight files. The complete run includes a corrected test-only
cancellation ordering race and an explicit control for cancellation registered
after completion. The 87 skips comprise 80 opt-in Claude-validator comparisons,
three Windows-only cases, and four optional research/fixture checks.

After the 2.24.14 bump, all 328 focused tests across nine files passed, including
version parity, packaged lifecycle, launcher, release-artifact, and certification
validator fixtures. Type, compatibility, public-safety, package freshness, package
and release reproducibility, packaged MCP smoke, prompt-scenario definitions,
and a verified public export also passed for the bumped candidate.

These local results use synthetic host hook inputs and disposable projects. They do
not establish native Windows/Linux execution, live host certification,
or publication. Earlier recorded baselines remain below for provenance.

An earlier 2.24.13 full source run passed all 4,316 tests across 260 files with 86
existing skips in 383.26 seconds, including the seven new native-agent preflight
regressions. An earlier run found a documentation assertion caused by a required
phrase split across two lines. The phrase was restored, its focused recheck
passed, and the complete suite then passed without failures.

The 2.24.13 operational replay passed all 654 tests across 23 files in 79.02
seconds. Type, compatibility, all 52 prompt scenarios, public-safety, both host
package validation/MCP smoke, package/release reproducibility, and verified
public export checks passed. These are offline checks, not live certification.

The earlier candidate's complete baseline remains recorded below:

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

The 2.24.12 mechanical certification parent passed doctor, configuration, preview,
and probe preparation, then stopped because the host exposed the older native
agent interface. No child, binding, run, receipt, or shipping action occurred;
the fast, full, and protected-land attempts were not launched. This is a failed
certification attempt, not a passing run. Its original evidence remains external.

The 2.24.12 Claude worker-validator check could not authenticate on two authorized
attempts. No validator call or passing proof was produced. That check is optional
under the 2.24.13 release policy; the retained failures remain failures.

The tested 2.25.2 candidate passed exact-commit CI, then failed its first formal
mechanical attempt before binding or run start. It has zero qualifying live
completions; fast, full, and protected-land remain unstarted. Confirmed delivery
of the revised guidance did not prevent the prohibited call, and the exact
decoded assignment input remains unknown. No additional source fix or release
certificate is claimed. The successful 2.25.1 CI and failed formal attempt remain
evidence about that earlier candidate; neither certifies 2.25.2. The current
2.25.4 candidate requires its own exact-source CI and authorized live campaign.

The fast, full, and protected-land live scenarios on 2.24.11 remain unverified.
The campaign stopped at the operator's request, and its disposable setup was
removed. A project-trust entry appeared in the isolated profile during launch,
raising a setup
authorization concern; it is not a confirmed APE runtime defect.

Full Claude operation also remains unverified. Its optional candidate-bound
worker-validator reachability check can be run when authorized Claude access is
available; it is not required for publication.

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
