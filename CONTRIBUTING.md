# Contributing to APE

Thank you for helping improve APE. Keep changes focused, preserve existing public contracts, and
include verification appropriate to the behavior being changed. Development and validation
commands are listed in the [README](README.md#development).

## Runtime defects: regression first

Every confirmed runtime defect must first land with a minimal failing regression test that
reproduces the defect before the fix. The test should fail for the reported behavior, state the
expected public contract, and be as narrow as possible. Apply the production fix only after that
failure has been observed, then run the focused test and the relevant adjacent and repository
gates.

Incident-derived fixtures must remain synthetic and privacy-safe. Never copy a reporter's project,
raw `.ape` state, objectives, paths, receipt material, prompts, command output, secrets, or private
prose into a test, snapshot, commit message, or review description. Reduce the report to the
smallest synthetic input that preserves the defect.

Reporters and maintainers should follow the [incident-reporting guide](docs/incident-reporting.md)
for the local-first, manual opt-in evidence workflow and minimal-reproduction convention. APE does
not automatically collect or upload incident data.

## Pull requests

- Explain the user-visible problem and the contract the change preserves.
- Keep production and test changes within the intended scope; avoid unrelated cleanup.
- Report the exact focused and repository checks you ran.
- Do not include private overlay assets or material from private checkouts.

Before a push, confirm the repository remote and follow the public-safety and package gates in the
[README](README.md#development). Publication and release actions require explicit maintainer intent.
