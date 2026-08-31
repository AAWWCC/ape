# APE run

Use only when the user explicitly asks to run APE; never infer consent from coding work or plugin
availability.

Before `ape_run start`, inspect the repository and compose complete inputs. Repository discovery:
no match is valid. Run optional discovery alone with `|| true`; never place optional discovery in an
`&&` chain. Stop instead of retrying or self-correcting a failed inspection call. Discover optional
`AGENTS.md` only with `rg --files -g 'AGENTS.md' -g '!**/.git/**' || true`.

On Google Antigravity/Gemini, pass the open project root as `project_dir` on every APE call.

- `objective`: observable outcome and acceptance. Do not embed an execution budget, dispatch limit,
  or guessed lane duration; preview returns the runtime-owned ticket deadline separately.
- Exact `host` (`codex` or `claude`); include it in preview and start.
- `mode`: `phase`, `debug`, `spike`, or `land`; `lane`: normally `auto`.
- `claimed_paths`: production paths only. Include generated artifacts or
  documentation only when the objective may require them.
- `test_paths`: independently authored test paths; never put them in `claimed_paths`.
- `test_intent`: `red-first` by default; explicit `green-maintenance` only for green-on-arrival
  regression coverage or deflaking. Green maintenance stays `behavioral: true`; pure data/baseline
  work uses `behavioral: false`. Keep preview/start identical.
- `behavioral`, `requirements`, `completes`, and `risk_triggers`.
- `required_capabilities`: exact extra command/verification IDs; never infer availability. The host,
  not APE, discovers and permissions external MCP tools.
- `run_command_profiles`: `debug`/`spike` only, for an exact otherwise-unavailable measurement.
  Declare the literal command, matching read-only role, `effect: execute`, and nonblank reason. Show
  the command; set `operator_authorized: true` only after explicit approval. Preview must freeze it.
- `plan_contract_version: 2` for every newly started behavioral fast/full `phase`; omit it for
  mechanical work, non-phase modes, and every resume. Version 1 is legacy-only.

Call `ape_config` `doctor` and `get`, then `ape_run preview`; preview/start carry identical complete
facts except `action`. Report deadline, readiness failures, and deterministic dispatch bounds; token totals are
host-attested only. Complete gate-command and visual-evidence readiness checks per protocol.

Inspect `shipping.auto_merge`. If true, explain push/PR/merge and obtain run-specific authorization
before `auto_merge_authorized: true`. Never infer consent from invocation, prior runs, or config.
Without authorization, stop before start; offer `shipping.auto_merge: false` for an audited hold.

Never invent product choices; ask only outcome-changing decisions. Offer a roadmap for cross-run
work; registration requires explicit approval.

Treat concurrency, destructive persistence, migration, schema compatibility, authentication, and
security as independent high-risk subsystems unless sharing threat model, platform primitive, rollback,
and executable evidence. Otherwise offer a dependency-ordered roadmap, not one oversized run.
Path-based check-then-rename atomicity is feasibility, not implementation detail.

Confirm native subagents/hooks, then `ape_run start` with host and `explicit_invocation: true`.
Accept runtime lane/model choices and report reasons.

Host invocation policy is the human-intent boundary. `explicit_invocation: true` is a
caller-attested defense-in-depth signal, not proof of human intent.

Follow [`references/run-resume-protocol.md`](references/run-resume-protocol.md) for every action.
The parent owns APE control calls and never edits production/tests; runtime owns sequencing, retries,
remediation, gates, shipping, and history.

When preflight returns `input_required`, collect complete exact answers for every question id. Call
`ape_run answer-preflight` with exact run/hash, bounded audit `reason`, and only additive
`claimed_paths`, `test_paths`, and canonical `risk_triggers`; never subtract/reinterpret scope.
