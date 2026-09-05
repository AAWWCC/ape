# Contributing to APE

Keep changes focused. Preserve public APIs and include tests for changed behavior.
See the [development commands](README.md#development).

## Runtime defects: regression first

For every confirmed runtime defect, add a minimal failing regression test and
observe it fail before the fix. Then apply the fix and run that test, related
tests, and the required repository checks.

Incident-derived fixtures must be synthetic and privacy-safe. Reproduce the
failure with invented data, not a copy of someone's project or raw `.ape` state.
Do not put private objectives, paths, receipts, prompts, output, secrets, or prose
in tests, commit messages, or PR descriptions.

Use the [incident-reporting guide](docs/incident-reporting.md). APE does not
automatically collect or upload incident data.

## Pull requests

Include:

- The user-visible problem and what changed.
- Tests you ran, with their results.
- Known limits or checks you did not run.

Keep runtime code, tests, and generated output easy to review separately. Do not
include unrelated changes or material from private checkouts.

Before pushing, verify the remote and run the public-safety and package checks.
Publishing a release requires separate maintainer approval and the
[release checks](docs/operational-readiness.md).
