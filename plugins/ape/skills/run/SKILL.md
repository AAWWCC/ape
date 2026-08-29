---
name: run
description: "Start or advance an explicit APE native-agent run."
---

# APE run

Use this skill only when the user explicitly asks to run APE. Never infer consent from a coding
request or plugin availability.

Before `ape_run start`, inspect the repository and compose complete inputs. Repository discovery is
evidence; no match is valid. Use `|| true`; never place optional discovery in an `&&` chain.
Stop instead of retrying or self-correcting a failed inspection call. Discover optional `AGENTS.md` only
with the standalone command `rg --files -g 'AGENTS.md' -g '!**/.git/**' || true`.

On Google Antigravity / Gemini, pass the exact open project root as `project_dir` on every APE MCP
call.

- `objective`: the observable outcome and acceptance criteria.
- Exact `host` (`codex` or `claude`); include it in preview and start.
- `mode`: `phase`, `debug`, `spike`, or `land`; `lane`: normally `auto`.
- `claimed_paths`: production paths only. Include generated artifacts or
  documentation only when the objective may require them.
- `test_paths`: independently authored test paths for behavioral work; never put them in
  `claimed_paths`.
- `behavioral`, `requirements`, `completes`, `risk_triggers`, and least-privilege `tool_claims`.
- `required_capabilities`: only exact additionally required capability IDs; never infer availability.
- `plan_contract_version: 2` for every newly started behavioral fast/full `phase` run. Omit it for
  mechanical, non-phase modes, and every resume; version 1 is legacy-only.

Call `ape_config` `doctor` and `get`, then `ape_run preview`. Preview and start carry identical
complete facts except `action`. Report readiness failures and deterministic dispatch bounds; token
totals are host-attested only. Complete the
gate-command and visual-evidence readiness checks in the run/resume protocol.

Inspect `shipping.auto_merge`. If true, explain the run may push, open a pull request, and merge;
obtain run-specific authorization before including `auto_merge_authorized: true`.
Never infer consent from invocation, prior runs, or configuration. Without authorization, stop
before start and offer `shipping.auto_merge: false` so the run ends at the audited shipping hold.

Do not invent product choices. Ask only for outcome-changing decisions. Offer a roadmap for work
that clearly spans runs; registration requires explicit approval.

Treat concurrency, destructive persistence, migration, schema compatibility, authentication, and
security as independent high-risk subsystems unless they share a threat model, platform primitive,
rollback, and executable evidence. Otherwise offer a dependency-ordered roadmap before one
oversized run. Path-based check-then-rename atomicity is a feasibility question, not an
implementation detail.

Confirm native subagents and APE hooks, then call `ape_run` action `start` with the host and
`explicit_invocation: true`. Accept runtime lane/model choices and report their reasons.

Host invocation policy is the human-intent boundary. `explicit_invocation: true` is a
caller-attested defense-in-depth signal, not proof of human intent.

Follow [`references/run-resume-protocol.md`](references/run-resume-protocol.md) for every
returned action. The parent orchestrator owns APE control calls and must not edit production or test
files itself. The runtime alone owns sequencing, retries, remediation, gates, shipping, and history.

When preflight returns `input_required`, collect complete exact answers for every question id. Call
`ape_run` action `answer-preflight` with the exact run and hash, bounded audit `reason`, and only
additive `claimed_paths`, `test_paths`, and canonical `risk_triggers`. Never subtract or reinterpret
scope.
