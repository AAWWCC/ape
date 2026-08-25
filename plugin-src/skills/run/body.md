# APE run

Use this skill only when the user explicitly asks to run APE. Do not infer consent from a coding
request or from plugin availability.

Before `ape_run start`, inspect the repository and compose bounded, cold-reader-complete inputs:

When the host is Google Antigravity / Gemini, pass the exact open project root as `project_dir` on
this and every later APE MCP call.

- `objective`: the observable outcome and acceptance criteria.
- `mode`: `phase`, `debug`, `spike`, or `land` for an already-finished diff.
- `lane`: normally `auto`; `mechanical` is non-behavioral docs/config/generated work, `fast` is a
  bounded behavioral change, and `full` is planned multi-stage work.
- `claimed_paths`: production paths only. Include generated artifacts or obvious documentation
  surfaces only when the objective may require them.
- `test_paths`: independently authored test paths for behavioral work; never put them in
  `claimed_paths`.
- `behavioral`, `requirements`, `completes`, `risk_triggers`, and least-privilege `tool_claims`.
- `plan_contract_version: 2` for every newly started behavioral fast or full `phase` run. Omit it for mechanical and
  non-phase modes, and every resume; explicit version 1 is only for legacy compatibility.

Call `ape_config` with `action: "get"` before starting and inspect `shipping.auto_merge`. When it is
true, explain that this run may push a branch, open a pull request, and merge it, then obtain the
operator's explicit authorization for this run. Only after that authorization may the start include
`auto_merge_authorized: true`. Never infer shipping consent from the APE invocation, a prior run, or
persistent configuration. If authorization is absent, stop before `ape_run start` and offer to set
`shipping.auto_merge` false so the run ends at the audited shipping hold.

Do not invent missing load-bearing product choices. Recommend concrete options and ask only for
decisions that materially change the outcome. If the work clearly spans multiple runs, offer a
roadmap; registration still requires explicit approval.

Treat concurrency, destructive persistence, migration, schema compatibility, authentication, and
security boundaries as independent high-risk subsystems unless they demonstrably share one threat
model, platform primitive, rollback, and executable evidence suite. When two or more do not, offer a
dependency-ordered roadmap before starting one oversized run. A claim that a path-based
check-then-rename sequence is atomic is a feasibility question, not an implementation detail.

Confirm native subagents and APE hooks are available, then call `ape_run` with `action: "start"`,
the host, and `explicit_invocation: true`. Accept the runtime's lane escalation and model choices;
report its reasons instead of retrying with weaker facts.

Host invocation policy is the human-intent boundary. `explicit_invocation: true` is only a
caller-attested defense-in-depth signal, not proof of human intent.

Follow [`references/run-resume-protocol.md`](references/run-resume-protocol.md) for every
returned action. The parent orchestrator owns APE control calls and must not edit production or test
files itself. The runtime alone owns sequencing, retries, remediation, gates, shipping, and history.

When preflight returns `input_required`, collect complete exact answers for every stable question id
and call `ape_run` with `action: "answer-preflight"`, the exact run and preflight hash, a bounded
operator audit `reason`, and only additive `claimed_paths`, `test_paths`, and canonical
`risk_triggers`. Never subtract or reinterpret scope.
