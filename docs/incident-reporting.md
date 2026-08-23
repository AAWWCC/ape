# Incident reporting

APE incident reports are explicit, local-first, and privacy-preserving. APE has no automatic
telemetry and does not collect, upload, send, or create an issue automatically. Inspect diagnostics
locally first. Submitting a report is opt-in and always a manual action by the operator.

Use the structured GitHub runtime-defect issue form only after you have minimized and reviewed the
evidence. If a suspected vulnerability could put users at risk, follow the
[security policy](../SECURITY.md) instead of opening a public issue.

## Minimal reproduction convention

A minimal reproduction should let a maintainer observe one defect without receiving the original
project or its data:

1. Reproduce the behavior in a new temporary repository or the smallest isolated fixture possible.
2. Replace names, content, paths, and state with synthetic values. Keep every incident-derived
   fixture synthetic and privacy-safe.
3. Record the APE version, host and host version, operating system, Node.js version, lane, and stage.
4. Inspect the diagnostic locally and copy only its bounded projection: `reason_code`,
   `next_safe_action`, `recovery_rationale`, `failed_checks`, and `stage_timing`.
5. Give the shortest ordered steps that reproduce the defect, plus the expected and observed
   behavior. Confirm the steps still reproduce it in the synthetic fixture.

Do not attach archives or broad logs when the minimized steps and bounded projection are enough.
The reproduction must not depend on access to the reporter's original repository, account, or
machine.

## Never submit

Do not submit secrets, tokens, credentials, personal data, private filesystem paths, or private prose.
Also omit:

- raw `.ape` state or runtime directories;
- objectives;
- claimed paths or test paths;
- receipt prose or receipt capabilities;
- prompts;
- command lines or command output; and
- proprietary source, logs, fixtures, or assets.

Review the rendered issue one final time before submission. A value that merely looks harmless can
still disclose a project name, username, customer identifier, or local directory.

## From incident to regression

Maintainers first confirm the report using only the minimized synthetic reproduction. A confirmed
runtime defect then follows the regression-first workflow in [CONTRIBUTING.md](../CONTRIBUTING.md):
land a minimal failing regression test that reproduces the defect before the production fix, keep
the fixture synthetic and privacy-safe, and verify the test passes only after the fix.
