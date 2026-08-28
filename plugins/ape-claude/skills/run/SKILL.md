---
name: run
description: "Start or advance an explicit APE native-agent run."
argument-hint: "[objective] [--lane auto|mechanical|fast|full] [--mode phase|debug|spike|land]"
disable-model-invocation: true
---

# APE run

Use this skill only when the user explicitly asks to run APE. Do not infer consent from a coding
request or from plugin availability.

Before `ape_run start`, inspect the repository and compose cold-reader-complete inputs:

Repository discovery is evidence, not an assertion that optional files exist. Run inspections
separately. Where no match is valid (for example, no `AGENTS.md`), use `|| true`; never place
optional discovery in an `&&` chain. Stop instead of retrying or self-correcting a failed inspection
call. For optional `AGENTS.md` discovery, run this exact standalone command without wrapping it in
another shell or changing its arguments: `rg --files -g 'AGENTS.md' -g '!**/.git/**' || true`.

When the host is Google Antigravity / Gemini, pass the exact open project root as `project_dir` on
this and every later APE MCP call.

- `objective`: the observable outcome and acceptance criteria.
- `mode`: `phase`, `debug`, `spike`, or `land` for an already-finished diff.
- `lane`: normally `auto`; `mechanical` is non-behavioral docs/config/generated work, `fast` is
  bounded behavioral change, and `full` is planned multi-stage work.
- `claimed_paths`: production paths only. Include generated artifacts or
  documentation only when the objective may require them.
- `test_paths`: independently authored test paths for behavioral work; never put them in
  `claimed_paths`.
- `behavioral`, `requirements`, `completes`, `risk_triggers`, and least-privilege `tool_claims`.
- `plan_contract_version: 2` for every newly started behavioral fast/full `phase` run. Omit it for
  mechanical, non-phase modes, and every resume; version 1 is legacy-only.

Before starting, call `ape_config` action `get` and inspect `shipping.auto_merge`. If true, explain
that the run may push, open a pull request, and merge; obtain run-specific operator authorization
before including `auto_merge_authorized: true`. Never infer consent from invocation, prior runs, or
configuration. Without authorization, stop before start and offer `shipping.auto_merge: false` so
the run ends at the audited shipping hold.

Do not invent missing load-bearing product choices. Recommend concrete options and ask only for
decisions that materially change the outcome. If the work clearly spans multiple runs, offer a
roadmap; registration still requires explicit approval.

Treat concurrency, destructive persistence, migration, schema compatibility, authentication, and
security as independent high-risk subsystems unless they share a threat model, platform primitive,
rollback, and executable evidence. Otherwise offer a dependency-ordered roadmap before one
oversized run. Path-based check-then-rename atomicity is a feasibility question, not an
implementation detail.

Confirm native subagents and APE hooks are available, then call `ape_run` with `action: "start"`,
the host, and `explicit_invocation: true`. Accept the runtime's lane escalation and model choices;
report its reasons instead of retrying with weaker facts.

Host invocation policy is the human-intent boundary. `explicit_invocation: true` is only a
caller-attested defense-in-depth signal, not proof of human intent.

Follow [`references/run-resume-protocol.md`](references/run-resume-protocol.md) for every
returned action. The parent orchestrator owns APE control calls and must not edit production or test
files itself. The runtime alone owns sequencing, retries, remediation, gates, shipping, and history.

When preflight returns `input_required`, collect complete exact answers for every question id. Call
`ape_run` action `answer-preflight` with the exact run and hash, bounded audit `reason`, and only
additive `claimed_paths`, `test_paths`, and canonical `risk_triggers`. Never subtract or reinterpret
scope.
