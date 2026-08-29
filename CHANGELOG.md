# Changelog

## Unreleased

## 2.23.53 — 2026-08-28

APE now canonicalizes complete uniformly single-quoted argv wrappers such as
`'cat' 'tests/unit/graph.test.ts'` under the same positive alphabet as its evidence parser, while
mixed quoting, shell operators, nested quotes, escapes, and unsafe heads remain fail-closed. A first
harmless read command-shape denial receives one corrected same-stage retry before failure; retry
receipts preserve the exact denied command, and the published receipt and prompt-eval schemas now
include `command-shape`. Version 2.23.53 invalidates the prior source certification and starts a
fresh release cycle.

## 2.23.52 — 2026-08-28

APE now treats harmless static quoting on `cat` and `ls` operands as command shape rather than new
authority, while retaining fail-closed parsing for quoted heads, scripts, interpolation, and wider
shell syntax. Planning admits declared package build scripts without granting them to read-only
workers; correctable command-shape denials and malformed receipts receive bounded same-agent
retries, while genuine missing authority still blocks immediately. Run preflight now reports
incomplete gate commands and visual-verification readiness before dispatch, and a corrupt status
snapshot renders `CORRUPT` without a misleading progress bar. Version 2.23.52 invalidates the prior
source certification and starts a fresh release cycle.

## 2.23.51 — 2026-08-28

Every native stage worker now receives an explicit, shared instruction to single-quote complete
Next.js dynamic-route path operands before shell inspection, including every affected operand in a
multi-file command. This closes the planner-side gap that remained after 2.23.50 added the matching
hook-policy support: workers no longer have to learn the safe spelling through a denied command.
Version 2.23.51 invalidates the prior source certification and starts a fresh release cycle.

## 2.23.50 — 2026-08-28

APE's read-only shell policy now supports literal inspection of Next.js dynamic-route paths through
one shell-equivalent form: a complete single-quoted path operand containing `[name]`, `[...name]`,
or `[[...name]]` route segments. The parser removes the exact outer quote pair before operand
containment and executable checks. Unquoted brackets remain denied as glob syntax, and malformed,
partial, double-quoted, embedded-quote, whitespace-bearing, and ordinary quoted forms still fail
closed. Regression coverage includes the exact TRACE//OS inspection command that exposed the bug
and the real hook binary. Version 2.23.50 invalidates the prior source certification and starts a
fresh release cycle.

## 2.23.49 — 2026-08-28

The first 2.23.48 full certification attempt exposed a missing read-only evidence spelling. An
independent reviewer rendered newly added files with `git diff --no-index -- /dev/null <path>`, but
the lifecycle policy's narrow `/dev/null` sentinel exception covered only the equivalent form
without Git's end-of-options separator. The exception now admits either exact shape while retaining
the same containment checks and denying extra separators, extra flags, external companion paths,
two sentinel operands, and near-miss sentinel names. Version 2.23.49 restarts the finite four-cohort
certification cycle from fresh public source.

## 2.23.48 — 2026-08-28

Live release certification now gates on one first-pass-perfect attempt for each required Codex
pipeline shape: mechanical, fast, full, and protected-branch land. The previous policy required
three already-perfect repetitions per shape, turning eight redundant repeatability exercises into
release blockers after correctness had been established. Repeatability can still be monitored
outside the release ledger, while any failure in the four release-gating attempts continues to
reject the candidate. The ledger schema advances to version 4 and is bounded to exactly four raw
attempts.

## 2.23.47 — 2026-08-28

The first 2.23.46 full certification cycle exposed two host-contract defects and rejected that
candidate. Codex's exec wrapper can render an argv vector as adjacent JSON-quoted tokens, so valid
read-only review commands were refused by the shell policy's positive alphabet. The lifecycle
boundary now canonicalizes only that complete, unambiguous spelling; mixed, malformed,
whitespace-bearing, and metacharacter-bearing forms still fail closed. The same cycle showed that
the shipped receipt output schema omitted the runtime's `evidence.required_claims` object shape,
allowing a capability receipt to return an array. The exact additive object is now in the schema and
common prompt. Version 2.23.47 restarts every source gate and live pipeline from fresh public
source.

## 2.23.46 — 2026-08-28

The first 2.23.45 protected-land attempt exposed a Codex orchestration boundary: the shipped run
protocol told the parent to delay before each shipping poll, so the MCP call began at the
`functions.exec` wrapper's yield boundary and the host surfaced a transport failure before
reissuing it. Pending gate and shipping guidance now uses APE's existing bounded `wait_ms`
server-side poll loop with progress heartbeats and explicitly forbids sleeping inside the host
wrapper before the call. Regression coverage pins the shared run protocol and both pending response
paths. Version 2.23.46 restarts every source gate and live pipeline from fresh public source.

## 2.23.45 — 2026-08-28

The protected-land repeatability run exposed a post-merge checkout bug: GitHub's squash commit and
the already-finished local land commit had identical trees but divergent histories, so the
`--ff-only` cleanup could not align local `main` with `origin/main`. Cleanup now compares the full
checkout tree with the fetched squash tree and resets only when they are identical; any content
drift remains non-destructive and terminal reconciliation no longer reports a divergent GitHub base
as returned. Regression coverage pins both the safe alignment and the fail-closed path. Version
2.23.45 restarts every source gate and live pipeline from fresh public source.

## 2.23.44 — 2026-08-28

The first 2.23.43 focused source gate rejected hardcoded prior-version objective filenames in the
prompt generator regression. Those expectations now derive their suffix from the declared package
version, so future version bumps cannot leave the generator test stale. Version 2.23.44 retains the
exact optional-discovery command fix and restarts every source gate and live pipeline from fresh
public source.

## 2.23.43 — 2026-08-28

The third 2.23.42 mechanical parent stopped before run creation after improvising malformed shell
quoting for optional `AGENTS.md` discovery. The public run skill now supplies the exact standalone
fail-closed discovery command and forbids wrapping or argument changes; its packaged-skill contract
pins that command byte-for-byte. Version 2.23.43 restarts every source gate and live pipeline from
fresh public source.

## 2.23.42 — 2026-08-28

The 2.23.41 campaign preflight rejected prompts whose version was updated before their old random
campaign-directory suffix, leaving a stale project path. Live-certification prompts are now
generated from the package version and one canonical campaign root; generation writes all twelve
attempts into a new directory and refuses reuse. Regression coverage pins every attempt name,
version, project root, and objective path. Version 2.23.42 restarts every source gate and live
pipeline from fresh public source.

## 2.23.41 — 2026-08-28

The first 2.23.40 focused source gate rejected a regression fixture that attempted to omit the
remote-check setting by passing `undefined`, which JavaScript correctly replaced with the fixture's
default `false`. The fixture now has an independent field-presence switch, proving that the launcher
rejects an actually absent policy. Version 2.23.41 retains the explicit remote-check preflight and
restarts every source gate and live pipeline from fresh public source.

## 2.23.40 — 2026-08-28

The first 2.23.39 mechanical live attempt was rejected after its no-CI disposable repository
inherited `shipping.required_remote_checks: true` and correctly blocked when no remote check could
register. The live launcher now requires every certification repository to explicitly declare its
remote-check policy instead of inheriting a default: mechanical, fast, and full no-CI fixtures use
`false`, while the protected-land fixture uses `true` with its required workflows. Version 2.23.40
restarts every source gate and live pipeline from fresh public source.

## 2.23.39 — 2026-08-28

The 2.23.38 source candidate was rejected when release preparation called the intentionally
argument-requiring public exporter without its `--out` target. Version 2.23.39 retains the
automatic-shipping preflight and exact Codex user-settings isolation fix, uses a fresh temporary
export directory for the immutable public-tree proof, and restarts every source gate and live
pipeline from fresh public source.

## 2.23.38 — 2026-08-28

The first 2.23.37 mechanical parent was rejected because the disposable repository retained APE's
safe produce-and-hold default (`shipping.auto_merge: false`), and Codex 0.147 also made its pinned
authenticated user-settings request through the isolated ChatGPT origin. The live launcher now
refuses to start unless the governed repository explicitly enables automatic shipping, and its
loopback service returns the schema-valid disabled commit-attribution policy for the exact
`GET /api/codex/settings/user` contract. Unknown methods, routes, and query shapes remain rejected.
Version 2.23.38 restarts every source gate and live pipeline from fresh public source.

## 2.23.37 — 2026-08-28

The first 2.23.36 mechanical parent was rejected before run creation because Codex also derives its
host-owned Apps MCP URL from the global ChatGPT origin. The catalog loopback correctly rejected
those unrelated POST requests, but Codex retried Apps MCP initialization and emitted warnings. The
live launcher now requires and command-line-pins `[features] apps = false` while retaining local APE
plugins and remote catalog mode. This prevents the unrelated Apps MCP transport from starting at
all; version 2.23.37 restarts every source gate and live pipeline from fresh public source.

## 2.23.36 — 2026-08-28

The 2.23.35 source candidate was rejected because release preparation invoked the clean public-tree
export before creating its immutable source commit. Version 2.23.36 makes the release sequence
explicit: pre-commit gates complete first, the exact source is committed, and only then does the
clean-export gate run. All source gates and live pipelines restart from zero.

## 2.23.35 — 2026-08-28

The 2.23.34 source candidate was rejected when release preparation invoked the argument-requiring
bundle reachability helper without a source path. That helper is a targeted development check, not
a zero-argument release gate. Version 2.23.35 keeps the catalog-isolation fix and restarts every
source gate and live pipeline with the documented release commands only.

## 2.23.34 — 2026-08-28

The first 2.23.33 mechanical parent was rejected before APE start because disabling Codex's remote
plugin catalog activates a legacy curated-plugin sync, which loaded an unrelated manifest and
emitted validation warnings. The live launcher now keeps local plugin support and remote mode
enabled while overriding only Codex's optional plugin-catalog origin with a deterministic loopback
service. That service returns schema-valid empty catalog results, audits every request, and rejects
unknown methods, paths, or query shapes; the custom zero-retry model provider continues to use the
real Responses endpoint. Version 2.23.34 restarts every source gate and live pipeline from fresh
public source.

## 2.23.33 — 2026-08-28

The first 2.23.32 focused source gate rejected a stale version fallback in the root executable. The
release bump had updated package and runtime constants before bundling but had not treated
`bin/ape-mcp.mjs` as an independent source surface. Release preparation now bumps that executable
before regenerating the root and plugin bundles. Version 2.23.33 restarts every source gate and live
pipeline; the failed 2.23.32 gate is not rerun.

## 2.23.32 — 2026-08-28

The third 2.23.31 mechanical parent was rejected before APE start when Codex attempted an optional
global remote-plugin catalog refresh and logged a transport failure. The live launcher now also
requires explicit `[features] remote_plugin = false`, preserving the installed local APE plugin
while preventing the unrelated global catalog transport from entering certification. The
requirement is covered by a launch refusal regression, and version 2.23.32 restarts every source
gate and live pipeline from fresh public source.

## 2.23.31 — 2026-08-28

The first 2.23.30 live parent was rejected when Codex's optional analytics client logged a retried
503 event submission during the binding probe. The zero-retry certification launcher now also
requires an explicit `[analytics] enabled = false` section, preventing nonessential event transport
from introducing retry-shaped traffic into a first-pass-perfect run. The requirement is covered by
a launch refusal regression, and version 2.23.31 restarts from fresh public source.

## 2.23.30 — 2026-08-28

The first 2.23.29 live parent was rejected before APE start because its prompt retained a stale
campaign-directory suffix even though the launch arguments targeted the new repository. The
certification parent now parses every prompt-declared `project_dir`, requires it to resolve, and
requires its real path to equal `--project-dir` before Codex can launch. Missing, nonexistent, and
mismatched prompt roots are regression-tested. Version 2.23.30 restarts from fresh public source.

## 2.23.29 — 2026-08-28

The first 2.23.28 live-environment preflight was invoked in an unprepared source checkout and
correctly refused the missing repository-local release identity. Release preparation now sets and
verifies the GitHub noreply identity before the candidate begins. Version 2.23.29 restarts all
source gates and live pipelines rather than reusing that environment-rejected candidate.

## 2.23.28 — 2026-08-28

The first 2.23.27 full suite rejected a stale root MCP bundle and a prompt compression that dropped
the pinned adversarial timing phrase. Release preparation now regenerates both root and plugin
bundles before any gate, and the 220-word test-writer contract retains the exact final-check-before-
sink and crash-recovery requirements. Version 2.23.28 restarts every gate and live pipeline.

## 2.23.27 — 2026-08-28

The first 2.23.26 targeted gate rejected the expanded test-writer contract at 254 words against its
220-word public prompt budget. The same runtime-only red-execution rule is now expressed in exactly
220 words and the prompt regression pins its concise imperative. Version 2.23.27 restarts all source
gates and live certification from zero.

## 2.23.26 — 2026-08-28

The first 2.23.25 source-gate command was rejected before TypeScript started because the fresh
exact-source release checkout had not installed its development dependencies. Release preparation
now installs the locked dependency graph before a candidate's first gate. Version 2.23.26 restarts
the source gates and live campaign from zero instead of reusing the incompletely prepared candidate.

## 2.23.25 — 2026-08-28

The first 2.23.24 fast-lane certification cycle was rejected because the test-writer prompt made
the worker duplicate APE's runtime-owned red-test admission, producing an expected exit-code-1
worker tool result before the implementation stage. Test writers now author and statically inspect
green-reachable tests without executing commands expected to fail, return an empty `tests` array,
and leave both deterministic red executions and their sealed evidence exclusively to the runtime.
The authoritative validator no longer demands redundant self-reported red output. Version 2.23.25
restarts every certification pipeline from fresh exact public source.

## 2.23.24 — 2026-08-28

The first 2.23.23 typecheck rejected an ambiguous tuple inference in the new certification-parent
launcher. Its launch requirements now use named `pattern` and `description` fields, keeping the
runtime check identical while making the type contract explicit. Version 2.23.24 restarts the
candidate with typecheck included in its first targeted gate.

## 2.23.23 — 2026-08-28

The first 2.23.22 live infrastructure probe was rejected before run creation because its
non-interactive Codex parent omitted the automation-only hook-trust flag, so `SubagentStart` could
not inject the probe capability. Live Codex certification parents now launch through a checked-in
wrapper that always supplies the vetted-hook flag and fails closed unless the isolated home
contains the exact candidate plugin with request retries, stream retries, and WebSockets disabled.
The launch contract is regression-tested and documented; version 2.23.23 restarts from a fresh
public source commit rather than retrying the rejected candidate.

## 2.23.22 — 2026-08-28

The first 2.23.21 targeted source gate rejected the module-boundary update because its independent
hooks-facade export-count baseline still expected 34 owned symbols after the manifest gained its
35th. The explicit baseline now advances with the ownership list, and version 2.23.22 restarts the
candidate from its first targeted gate.

## 2.23.21 — 2026-08-28

The first 2.23.20 complete source gate rejected an incomplete runtime ownership manifest: the new
shared evidence-policy helper was exported through the hooks facade but had not been assigned to
its real owner in the explicit module-boundary symbol list. The manifest now owns that symbol in
`lib/runtime/evidence-policy.js`, and version 2.23.21 restarts the candidate rather than reusing the
partially gated 2.23.20 build.

## 2.23.20 — 2026-08-28

The first 2.23.19 fast-lane certification cycle was rejected when its independent reviewer used
the standard read-only `git diff --no-index /dev/null <new-file>` form and APE's generic evidence
containment guard denied the `/dev/null` empty-file sentinel as an out-of-project operand. The
evidence policy and its async hook precompute now share one narrow exception for exactly that
five-token comparison shape, while the companion path still requires ordinary project containment
and near-miss paths, extra flags, redirects, and every other external operand remain denied. Exact
unit and hook-process regressions pin the command that rejected 2.23.19 and the refusal boundary.

## 2.23.19 — 2026-08-28

The first 2.23.18 targeted source gate rejected stale schema-version and cohort-error assertions.
The assertions now pin schema v3, its exact twelve-record bound, and the host-transport-retry field.
Version 2.23.19 restarts the release candidate after that source-gate failure rather than reusing the
2.23.18 candidate.

## 2.23.18 — 2026-08-28

The first 2.23.17 fast-lane certification cycle was rejected when the Codex host's WebSocket
transport disconnected and automatically retried a sampling request. Live release certification
now requires exactly three first-pass-perfect attempts per pipeline: the first proves correctness,
and the next two prove repeatability. Any worker-tool failure, control-call failure, host transport
retry, receipt repair, duplicate dispatch, remediation, self-correction, or successor workaround
rejects the candidate and requires a version bump plus a fresh exact-source campaign. Subsequent
campaigns use an OpenAI-authenticated zero-retry SSE profile so transport loss fails visibly instead
of being hidden by the host's default retry policy.

## 2.23.17 — 2026-08-28

Aligned the test-evidence contract with the shell policy exposed by the first 2.23.12 fast-lane
cycle. Bound workers may now use exact-head `sha256sum` and macOS `shasum` commands with the existing
project-containment, command-shape, and executable-identity guards. The trusted Codex context and
test-writer prompt also make `output_hash` explicitly optional and forbid shell composition or a
standalone checksum probe merely to synthesize it.

The first 2.23.13 source gate rejected an overlong test-writer prompt before publication, and the
first 2.23.14 GitHub check set exposed a silent Windows dependency-install failure before package
tests began. Automated lockfile installs now disable dependency lifecycle scripts and incidental
audit/funding calls; the workflows retain their explicit bundle, smoke, and high-severity audit
gates. The first 2.23.15 local package check correctly rejected a candidate whose versioned plugin
packages had not yet been regenerated. This release keeps the worker contract within the enforced
prompt-size bound and regenerates all package surfaces before gating.

The first 2.23.16 live-certification launch was rejected before APE start because its operator-built
prompt named a stale temporary project root. Version 2.23.17 restarts certification from a newly
generated, exact-root campaign rather than repairing or resuming that attempt.

## 2.23.12 — 2026-08-28

Admitted `git ls-tree` as a recognized read-only evidence command for bound workers while retaining
the existing output-flag and project-path guards. The trusted Codex context now names the exact Git
verbs workers may use, and a regression covers the full commit-and-path command emitted by the
2.23.11 fast-lane reviewer.

## 2.23.11 — 2026-08-28

Canonicalized alternate filesystem spellings before authorizing a host edit target. A claimed new
file addressed through an alias of the governed root, including macOS `/tmp` and `/private/tmp`,
now reaches the existing realpath-grade ticket-claim check instead of being rejected as a missing
target. Unclaimed and genuinely out-of-project paths remain denied.

## 2.23.10 — 2026-08-27

Made the live-certification preflight execute correctly through filesystem path aliases such as
macOS `/tmp` and `/private/tmp`. Direct invocation now compares canonical real paths, with a CLI
regression through a symlinked source root so a skipped preflight cannot report false success.

## 2.23.9 — 2026-08-27

Made live-certification Git identity a checked precondition instead of ambient machine state.
Disposable repositories must now carry a repository-local GitHub noreply identity, and the new
`release:live-preflight` command verifies it without printing the identity. This prevents GitHub
private-email protection from rejecting an otherwise clean first shipping cycle.

## 2.23.8 — 2026-08-27

Made pre-run repository discovery fail-safe on its first execution. The run skill now requires
independent inspection calls, explicitly treats an empty optional search such as a missing
`AGENTS.md` as valid evidence, forbids placing that search in an `&&` chain, and stops instead of
retrying a failed inspection. This removes the parent-command self-correction exposed by the third
2.23.7 mechanical canary.

## 2.23.7 — 2026-08-27

Made post-spawn Codex binding confirmation machine-copyable. Both the shared run protocol and every
returned dispatch now require `ape_run status` with only `action` and `project_dir`, explicitly
forbid `run_id` on status, and direct the caller to wait only after the dispatch is `active-bound`.
This removes the invalid status-call self-correction exposed by the first 2.23.6 mechanical canary.

## 2.23.6 — 2026-08-27

Aligned the hook-injected Codex worker guidance with APE's positive shell-character policy. Workers
are now explicitly told not to run brace-bearing `git rev-parse HEAD^{tree}`; the ticket supplies
`base_tree_sha`, the runtime recomputes tree hashes, and brace-free `git rev-parse HEAD` remains
available for commit evidence. This removes the first test-worker denial observed by the 2.23.5
fast canary.

## 2.23.5 — 2026-08-27

Made the Codex binding-probe contract complete at every model-visible surface. The run protocol and
MCP tool schema now require `host: "codex"`, `explicit_invocation: true`, `hooks_trusted: true`, and
`subagents_available: true` on the initial probe call and explicitly forbid a partial-call retry.
This removes the pre-run self-correction exposed by the first 2.23.4 mechanical canary.

Capped adaptive filesystem-latency scaling so event-loop starvation cannot inflate a directory
lock's configured `busyMs` into an effectively unbounded wait, while retaining the Windows
contention floor.

## 2.23.4 — 2026-08-27

Made the hook-injected Codex worker bootstrap state the executable inspection-command boundary
before the common contract: use native reads or `ls`, `cat`, `pwd`, `which`, and read-only `git`;
never probe with unsupported shell tools such as `rg`, `grep`, `sed`, `find`, or `awk`. This removes
the first bound-worker denial observed by the 2.23.3 mechanical canary.

## 2.23.3 — 2026-08-27

Made Codex dispatch deterministic at the trusted lifecycle boundary. Native launch messages are now
fixed transport-only bootstraps; after binding the host-issued child identity, APE injects the
complete common and role contracts plus a hash-bound immutable ticket reference itself. Binding
fails closed if either the active ticket hash or the prepared authoritative-context hash differs,
so a launcher cannot omit or rewrite receipt fields, stage instructions, or ticket authority.

Documented the bound-worker shell allowlist so agents use native inspection tools or single
recognized evidence commands without avoidable hook denials. Bumped the Codex dispatch protocol and
envelope to v2.

## 2.23.2 — 2026-08-27

Fixed protected GitHub auto-merge reconciliation when a pull request transitions from open to
merged between APE's state probe and merge command. APE now re-probes a failed merge command and
truthfully completes only when GitHub merged the exact run-attested head.

## 2.23.1 — 2026-08-27

Corrected the plugin cache identity after packaged Codex and Claude plugin contents changed during
2.23.0 release preparation. Bumped every source, manifest, bundle, export, and release-artifact
version surface to `2.23.1`; runtime behavior is unchanged from the final 2.23.0 source.

## 2.23.0 — 2026-08-26

Reworked native orchestration around machine-copyable dispatch envelopes so Codex callers no
longer reconstruct common prompts, role prompts, immutable tickets, or follow-up control calls from
conversation memory. Added bounded recovery for correctable plan, test-contract, review-finding,
and scope-policy disputes instead of sealing every first disagreement as an opaque block. Test and
implementation prompts now emit plan-deviation evidence only when an approved plan exists and work
materially deviates, matching the runtime's strict receipt contract.
The preflight role now receives the exact strict artifact shape. Run/resume callers now send only
`action`, `project_dir`, and `receipt` when recording, preventing valid stage evidence from failing
at handoff because of an extraneous `run_id`.

Terminal history now records release/protocol provenance and stable failure reasons suitable for
version-cohort metrics, including stage-specific abort reasons and unsuperseded recovery-lineage
outcomes with explicit malformed/cyclic coverage. A credential-free operational replay corpus and
release canary gate cover the failure classes. Tagged releases now separately fail closed unless a
privacy-safe Codex live ledger is the sole change in a certification commit over the exact tested
source, with three clean completions per pipeline and exact protected-land merge proof. Claude
remains packaged and structurally validated at its pinned CLI version, but authenticated Claude live
operation is explicitly unverified and makes no release-certification claim.

## 2.22.4 — 2026-08-25

Removed several run-start dead ends found in durable blocked and aborted history. Non-behavioral
fast/full phase runs now omit the test-writer and red-test stages, invalid explicit v2 preflight
combinations fail before mutation, generated host/release bundles classify as mechanical output,
and `land` can review a claimed committed feature diff that descends from the current default tip.

Made preflight baseline output hashes optional when a host does not expose the raw command output;
the command must still be receipt-backed, and any supplied hash must match exactly. Forbidden shell
mutations now report the evidence-command policy refusal before executable-pinning diagnostics.

Hardened GitHub shipping recovery. Protected branches can fall back to GitHub auto-merge, signer or
passphrase failures retry only the scheduler-owned feature commit without signing, and a proven
remote merge remains complete when another worktree prevents local base-branch cleanup. Generated
Codex and Claude packages carry the same runtime behavior.

## 2.22.3 — 2026-08-24

Prevented persistent `shipping.auto_merge` configuration from silently authorizing a new public
run. Auto-merge starts now require explicit per-run operator authorization, verify the
server-advertised base branch before creating a run branch, and repeat that freshness check before
the first shipping mutation.

Preserved exact clean committed trees when superseding blocked runs instead of creating an empty
successor from the default branch. Also classified `ape_status` consistently as an
orchestrator-owned control-plane tool across lifecycle policy, hooks, and agent manifests.

## 2.22.2 — 2026-08-23

Moved high-risk design validation earlier by requiring structured threat-model, feasibility,
failure-mode, recovery, migration, determinism, and executable-test assurances in v2 plans. Updated
the planner, test-writer, implementer, and review prompts to require behavioral and fault-injection
evidence instead of source-token assertions, and to decompose unrelated high-risk systems.

Made review remediation bounded and convergent: distinct blocker sets can receive up to three cycles
by default (configurable from one through ten), while repeated findings or absent progress stop
immediately. Explicit successor runs can now inherit an exact blocked tree and its unresolved review
findings through runtime-attested carry-forward admission.

## 2.22.1 — 2026-08-22

Extended exact MCP tool-claim resolution for unreviewed providers to support declared `write` and
`execute` effects in addition to `read`. Existing downstream writable-ticket, high-risk execution,
and conservative-drift policy checks continue to apply.

Added minimality guidance to the test-writer agent prompt: prefer inline values, flat setup, no
comments unless non-obvious, and duplication over premature test utilities.

## 2.22.0 — 2026-08-18

Removed Google Antigravity and Gemini host support across all layers: deleted `plugins/ape-gemini/`,
`hooks/gemini-hooks.json`, `lib/runtime/gemini-host.js`, and all Gemini runtime adapters, dispatches,
statusline renderers, intent bindings, and packaging scripts. APE now strictly focuses on Claude Code
and Codex hosts.

## 2.21.2 — 2026-08-18

Direct hook script execution on Antigravity: replaced inline `node -e` command wrappers in `hooks.json`
with direct CLI bundle invocations (`node ./dist/ape-hooks.bundle.mjs <event>`). Eliminates shell eval
quoting syntax errors where Windows Antigravity host processes passed literal double quotes to Node's
eval parser.

## 2.21.1 — 2026-08-18

Fixed Antigravity / Gemini subagent dispatch failure on Windows caused by CRLF (`\r\n`) line endings
in prompts and JSONL transcripts. Subagent capability extraction and launch checks now handle `\r?\n`
line boundaries seamlessly, preventing false dispatch capability denial at `PreToolUse`.

## 2.21.0 — 2026-08-18

Added `roadmap-attest` action to `ape_history`: closes live roadmap requirements against an
archived completed run without modifying the run's immutable record. Attestations are stored in a
separate overlay that the derivation reads alongside `completes`, with idempotent writes and
audit-logged requirement-index updates. Use when work was merged outside APE or a run completed
before the roadmap existed.

Added `ToolSearch` to all APE subagent manifests so deferred MCP tool schemas can be loaded at
runtime. The `mcp__*` wildcard already granted permission; this enables the discovery step.

## 2.20.2 — 2026-08-17

Claude subagents now inherit the parent session's MCP tools. Their manifests continue to restrict
built-in capabilities by role and deny both supported namespace forms of the orchestrator-owned
`ape_run`, `ape_config`, and `ape_history` tools; APE's ticket `tool_claims` still authorize each
external MCP call at the lifecycle hook.

## 2.20.1 — 2026-08-17

Made archived lifecycle explanations derive dispatch, retry, expiry, remediation, input-hold, and
recovery facts from durable records plus minimal terminal provenance.

Added strict project-metrics filter validation and bounded processing with explicit coverage and
truncation disclosure.

Completed metrics and history-calibrated statusline documentation across public host packages.

## 2.20.0 — 2026-08-17

Derived bounded per-run summaries from durable tickets, receipts, and history projections.

Added safe control character stripping and bounding across per-run summary projections.

Aligned Gemini subagent detection and session start hook handling.

## 2.19.1 — 2026-08-17

Fixed the `answer-preflight` action MCP input deserialization bug where valid tool calls omitting optional scope fields (`claimed_paths`, `test_paths`, `risk_triggers`) or `run_id` were rejected with `input contains unsupported undefined data`.

Added support for optional `run_id` aim confirmation on `answer-preflight` actions.

Added explicit Gemini host dispatch adapter routing for stage ticket execution in the receipt service.

## 2.19.0 — 2026-08-17

Added the `ape_run preview` action for pure, zero-write pipeline forecasting, lane classification rationale, and deterministic worst-case dispatch bounds without modifying git branches or writing runtime state.

Added schema-guided receipt validation before subagent retirement across Claude, Codex, and Gemini, preventing malformed common, planning, preflight, and structured-review receipts from failing stage handoffs.

## 2.18.3 — 2026-08-15

Review and security findings now use bounded, versioned structures that route remediation to the
production writer, test writer, or a serialized mixed path while preserving advisory and legacy
behavior. Exact test scopes now reject unauthorized descendants before generic path claims can
admit them, including when an authorized file path is replaced by a directory.

Diagnostics and forwarded findings are character-safe, deterministic, atomically validated, and
bounded to their wire budgets. Public documentation, prompts, generated bundles, and all packaged
host variants carry the same structured-remediation contract.

## 2.18.2 — 2026-08-15

Versioned plan reviewers now receive the complete validated candidate plan instead of a truncated
legacy projection, including deterministic forwarding across concurrent review dispatches.

Preflight artifacts can now preserve accepted run objectives longer than 2,000 characters exactly,
while the existing 64 KiB whole-artifact bound and the per-field limits for all other preflight
prose remain enforced. This removes an impossible receipt contract where a valid long run objective
could neither be echoed exactly nor recorded.

## 2.18.1 — 2026-08-15

Fixed Google Antigravity app and `agy` compatibility against the current shared plugin contract.
Gemini hooks now use only supported lifecycle events, normalize Antigravity's camel-case nested
tool payloads, return event-specific response shapes, and resolve bundles from the installed plugin
directory. Native `invoke_subagent` launches now bind the child conversation during
`PreInvocation`, inject receipt capability context before its first model turn, preserve dispatch
liveness in status output, and carry an explicit encoded project root. Generated MCP declarations
and every Gemini skill now require the exact `project_dir`, preventing plugin-install cwd from being
mistaken for the governed checkout.

## 2.18.0 — 2026-08-15

The runtime implementation is now split behind thin, stable service, hook, gate, and scheduler
facades. Exact named exports and persisted behavior remain compatible, while focused internal
modules and an acyclic import graph make lifecycle, evidence, gate, and scheduling changes easier
to isolate and verify.

Behavioral runs now support a structured, read-only preflight analysis before writers start. The
result is hash-bound into the plan, material questions pause for audited operator answers, and
immutable verification profiles snapshot exact commands, roots, and timeouts as named merge gates.
Legacy plan contracts and persisted run data remain compatible.

First-class support for Google Antigravity / Gemini agents (`agy` CLI and Antigravity IDE). APE
now coordinates native subagent dispatches via `invoke_subagent` (mapping writable tickets to
`self` and read-only tickets to `research`), governs Antigravity tool mutations (`write_to_file`,
`replace_file_content`, `multi_replace_file_content`, `run_command`), provides `plugins/ape-gemini/`
packaging with `plugin.json`, `mcp_config.json`, and `hooks/gemini-hooks.json`, and supports model
tier mappings for `flash` (fast/balanced) and `pro` (deep).

## 2.17.4 — 2026-08-14

Codex run start is fail-closed on a fresh, live native-binding preflight again. APE now requires
the canary launch and child binding to be acknowledged, consumes that proof exactly once before
the first Git mutation, and reports missing, expired, replayed, or observed-but-unbound probes as
infrastructure failures without creating a run or consuming a stage attempt. Static hook-manifest
coverage remains a package check but is no longer described as proof of live lifecycle delivery.
Codex Multi-Agent V2 binding now records the host-effective `default` role separately from APE's
logical worker/explorer role, so production `SubagentStart` events bind instead of being rejected.

## 2.17.3 — 2026-08-13

Every APE run now starts on a fresh APE-owned branch created from the resolved default-branch tip,
regardless of the caller's current branch. Terminal runs reconcile the checkout back to that
persisted base branch: completed branches are deleted after clean reconciliation, while blocked and
aborted branches are retained. Dirty or failed cleanup preserves the run branch and exact recovery
details, and `ape_run resume` safely retries cleanup after the operator resolves the working tree.

`land` now refuses to start unless HEAD matches the resolved default tip, preventing feature-only
commits from leaking into a landing run. Shipping and cleanup use the persisted base branch, with a
compatibility fallback for older run state, and never delete a branch APE does not own.

## 2.17.2 — 2026-08-12

Codex runs now start directly and prove native binding on each real stage agent, matching Claude's
workflow instead of spending an extra agent launch on a mandatory pre-run canary. Multi-Agent V2
lifecycle events may omit `agent_type`; APE now uses the unique launched intent plus host-issued
child session and agent IDs in that case, while still rejecting an explicitly mismatched type. The
legacy probe actions remain optional diagnostics and no longer gate or modify run creation.

## 2.17.1 — 2026-08-12

Fix Codex native binding launches when the host omits `agent_type`. The runtime now preserves the
intended explorer role through that host-specific omission and keeps the binding probe and launch
dispatch aligned. This patch also carries the existing deterministic package, marketplace smoke,
and release-artifact guarantees forward under a new immutable plugin version.

## 2.17.0 — 2026-08-11

Initial public release. APE 2.17 introduces deterministic, allowlisted public packages for the
Codex CLI and Claude Code.
The repository marketplaces point to `plugins/ape` and `plugins/ape-claude`; each package starts
the bundled MCP server locally over stdio, and neither package contains private history, benchmark
records, or audio. A reproducibility gate rebuilds both package trees twice and compares every
path, normalized mode, byte count, and SHA-256 digest. A separate public-surface gate rejects private identifiers,
personal email, secrets, symlinks, oversized files, audio by extension or signature, and hosted
MCP transports. Domain-separated protected-blob fingerprints keep that gate effective in fork CI
without publishing private asset hashes. The export helper copies only an explicit source
allowlist and validates the result.
Release automation produces deterministic `ape-codex-2.17.0.tar.gz` and
`ape-claude-2.17.0.tar.gz` archives, `SHA256SUMS`, a machine-readable release manifest, and an SPDX
2.3 SBOM with the bundled Zod dependency and package verification codes, then attaches GitHub
build-provenance attestations. Publication uses a checksum-pinned GitHub CLI. CI pins third-party actions by full
commit and exercises clean package/MCP startup on Node 22 and 24 across Linux, macOS, and Windows.
The fresh public repository preconfigures least-privilege CodeQL scanning and bounded weekly
Dependabot updates for npm and GitHub Actions.
The public source also includes a credential-free, deterministic prompt-evaluation gate covering
36 synthetic scenarios over the declared two-host, three-tier matrix. Live provider calls remain a
separately guarded operator action; supplied result artifacts can be verified offline against
current prompt hashes and exact release thresholds.

Skill entrypoints are now rendered from host-neutral sources. All state-changing skills are
explicit-only; `status` is the sole implicitly discoverable skill. The run/resume protocol is a
shared generated reference so host packages cannot drift. Documentation now scopes test-driven
development precisely to behavioral fast/full phase work and records external-tool capability and
attestation differences instead of claiming blanket host parity.

LARP MODE no longer assumes bundled audio. Operator environment/config paths take precedence over
an optional closed `assets/sounds/manifest.json`, whose relative entries must remain inside its
directory after realpath resolution. An absent, invalid, escaping, or missing entry is silent and
never blocks a run. Public packages omit the entire `assets` directory; the private source overlay
retains its unchanged sound files and manifest.

The Codex development cachebuster now mutates only the staged immutable-cache manifest. The
canonical source manifest remains at `2.17.0`, while each install gets a unique build-metadata
version and previously installed cache trees remain available to open tasks.
