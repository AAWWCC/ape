# APE run

Use only when the user explicitly asks to run APE; never infer consent.

Use applicable repository instructions already supplied by the host. If further discovery is
needed, include `AGENTS.override.md` as well as `AGENTS.md`, including ignored local files.
These files are optional: no match is valid and does not block intake.

- `objective`: outcome and acceptance. Omit execution budgets and dispatch limits;
  new workers have no duration limit, and preview reports `deadline_ms: null`.
- `host` (`codex` or `claude`) in preview/start.
- Include confirmed `hooks_trusted: true`, `subagents_available: true`, and
  `explicit_invocation: true` in preview and unchanged start. Never invent trust or
  availability. Host invocation policy is the human-intent boundary;
  `explicit_invocation: true` is caller-attested defense-in-depth, not proof of human intent.
- `mode`: `phase`, `debug`, `spike`, or `land`; `lane`: `auto` unless explicitly selected.
- `claimed_paths`: production paths only. Include generated artifacts or
  documentation only when the objective may require them.
- `test_paths`: independently authored test paths; never put them in `claimed_paths`.
- `test_intent`: `red-first`, or explicit `green-maintenance` for green-on-arrival coverage/deflaking.
  Nonbehavioral data/baseline work uses `behavioral: false`. Keep preview/start identical.
- `behavioral`, `requirements`, `completes`, and `risk_triggers`.
- `required_capabilities`: exact extra command/verification IDs. External tools remain host-owned.
- `run_command_profiles`: `debug`/`spike` only; declare command, read-only role, `effect: execute`,
  and reason. Set `operator_authorized: true` only after explicit approval.
- `plan_contract_version: 2` for every newly started behavioral fast/full `phase`; omit it for
  mechanical work, non-phase modes, and every resume. Version 1 is legacy-only.

Call `ape_config` doctor/get, then `ape_run preview`. Follow the shared protocol's start-readiness
steps for missing configuration, complete inline or paged admission review, and the binding probe.
Start only after reviewing the complete ready manifest, with unchanged prospective inputs and
`expected_admission_digest` copied from the reviewed preview or paged delivery. Changed inputs
require a fresh preview. Report deterministic
dispatch bounds and complete gate-command and visual-evidence readiness checks.

One explicit APE invocation authorizes the run. When `shipping.auto_merge` is true, runtime
freezes shipping authority; omit legacy `auto_merge_authorized`. Drive every scheduler-owned
transition, wait, and configured shipping action to a terminal result without asking for continue.
Shipping requires the explicitly configured project target and passes that frozen
target to every mutation; the canonical APE checkout separately retains its public-repository guard.

Ask only unresolved outcome-changing decisions; existing explicit approval remains valid within
scope. Offer a roadmap for cross-run work; registration requires explicit approval.
Decompose independent high-risk subsystems per the protocol.

Follow [`references/run-resume-protocol.md`](references/run-resume-protocol.md) for every action.
During the run, the parent owns control calls and stage workers edit production/tests;
the runtime owns sequencing, retries, remediation, gates, and shipping.

When preflight returns `input_required`, collect complete exact answers for every question id. Call
`ape_run answer-preflight` with exact run/hash, bounded audit `reason`, and only additive
`claimed_paths`, `test_paths`, and canonical `risk_triggers`; never subtract/reinterpret scope.
