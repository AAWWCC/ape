# APE run

Use this skill only when the user explicitly asks to run APE. Do not infer consent from a coding
request or from plugin availability.

Before `ape_run start`, inspect the repository and compose bounded, cold-reader-complete inputs:

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

Do not invent missing load-bearing product choices. Recommend concrete options and ask only for
decisions that materially change the outcome. If the work clearly spans multiple runs, offer a
roadmap; registration still requires explicit approval.

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
