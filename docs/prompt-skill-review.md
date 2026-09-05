# Agent and skill instruction review

Reviewed September 5, 2026, against the local 2.24.11 runtime candidate.

The review covered the common contract, all eleven role prompts, all eleven
Claude wrappers, all seven canonical skills and their metadata, the shared
run/resume protocol, and the injected receipt-construction guidance. Nine role
prompts and all seven skills needed corrections. The debugger, spike researcher,
and thin agent wrappers already matched their contracts.

## Agent findings

| Area | Result |
|---|---|
| Common contract | Distinguishes a material plan violation from a justified, documented deviation within authorized scope. |
| Preflight analyst | A completed artifact may contain unresolved material questions; the runtime owns the input hold. Settled decisions are reused and optional refactors stay advisory. |
| Planner | Honors green-maintenance and nonbehavioral intent; explicitly selects v1 when required; distinguishes the copied preflight hash from a runtime-generated candidate hash. |
| Plan checker and critic | Check the ticket's test intent, apply version-appropriate assurances, and preserve supplied finding identities. |
| Plan judge | Leaves replan limits to the runtime and asks for corrections that fit the actual schema and command catalog. |
| Test writer | Leaves execution to the runtime for red-test, green-test, and test-correction; executes admitted commands when targeted-tests requires worker evidence. |
| Implementer | Does not assume every incoming test is RED; requests additive scope when a conflicting test is outside its ticket. |
| Reviewer and security reviewer | Fail the review verdict only for blocking findings; advisory findings remain nonblocking. |
| Debugger and spike researcher | Reviewed without changes. Read-only diagnosis and bounded research remain appropriate. |
| Wrappers and receipt guidance | Wrappers remain unchanged. Injected guidance now distinguishes test-evidence ownership and permits only the validator's remaining corrections. |

## Skill findings

| Skill | Result |
|---|---|
| Run | Allows one harmless inspection correction, preserves explicit lane choices and existing configuration, and retains existing authorization. |
| Config | Applies already approved changes without another confirmation; fills missing required slots while preserving policy and script-approval boundaries. |
| History | Documents supported metrics and request-grounded audit reasons. |
| Override | Reuses an unambiguous reason and authorization; does not substitute shipping or dispatch expiry for an abort/reset request. |
| Resume | Handles absent runs and exact receipt recording without unnecessary worker revalidation. |
| Roadmap | Recognizes prior approval for unchanged entries and actions. |
| Status | Distinguishes no active run from retained terminal history. |
| Shared protocol | Accepts a bound worker already observed stopped, preserves cumulative correction limits and runtime-directed recovery, and copies rejection input_hash into recover-receipt's receipt_input_hash. |

Obsolete Antigravity/Gemini instructions were removed. The six explicit skill
invocation policies and status's implicit invocation policy were preserved.

## Verification

- Independent reviewers exercised thirteen new synthetic decision scenarios.
- The offline prompt harness validates fifty-two cases, including corrected test-writer
  execution expectations and cases for every role. No paid provider evaluation ran.
  The friction review added checks that settled decisions and optional refactors
  do not create unnecessary preflight input holds.
- Earlier assertion corrections were followed by complete suite runs. The latest
  attribution/recovery follow-up reran the complete suite after adding parent-tool
  observations and required continuation guidance: 4,307 passes across 260 files,
  with 86 existing skips and no failures. See [the validation record](prevention-release-status.md).
- Prompt/skill limits, type checks, public-safety, compatibility, bundle freshness,
  both package MCP smoke checks, and package/release reproducibility passed.
- Both plugin packages and release artifacts were rebuilt locally.

This review does not update the installed plugin or establish live-host
certification. No installation, push, or publication was performed.
