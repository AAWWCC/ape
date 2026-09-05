# Report a runtime defect

Inspect diagnostics locally first. APE has no automatic telemetry: reporting is
opt-in and manual. For a possible vulnerability, use the
[security policy](../SECURITY.md), not a public issue.

## Minimal reproduction convention

Use the GitHub runtime-defect issue form after preparing a small reproduction:

1. Reproduce one problem in a temporary repository or isolated fixture.
2. Replace real names, paths, content, and state with synthetic, privacy-safe data.
3. Record APE version, host and host version, OS, Node.js version, lane, and stage.
4. Include only the reviewed diagnostic fields: `reason_code`, `next_safe_action`,
   `recovery_rationale`, `failed_checks`, and `stage_timing`.
5. Give the shortest reproducible steps, expected behavior, and actual behavior.

The reproduction must work without your original project, account, or machine.
Do not attach broad logs or archives when these steps are enough.

## Never submit

- Secrets, tokens, credentials, personal data, private filesystem paths, or private prose.
- Raw `.ape` state, objectives, claimed paths, or test paths.
- Receipt prose, receipt capabilities, or prompts.
- Command lines or command output from the original incident.
- Proprietary source, logs, fixtures, or assets.

Review the rendered issue before sending it. Even a short value can expose a
username, project, or customer.

## From incident to regression

Maintainers confirm the defect using the synthetic reproduction, then add a
minimal failing regression test before the fix. The same test must pass after the
fix. See [CONTRIBUTING.md](../CONTRIBUTING.md).
