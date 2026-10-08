# Contributing to APE

Keep changes focused. Preserve public APIs and include tests for changed behavior.
See the [development commands](README.md#development).

`npm run prompts:budget` reports prompt and skill word counts against editorial
targets. Exceeding a word target is advisory; semantic contracts, package parity,
and prompt evaluations remain required checks.

## Runtime defects: regression first

For every confirmed runtime defect, add a minimal failing regression test and
observe it fail before the fix. Then apply the fix and run that test, related
tests, and the required repository checks.

During an APE run, the test writer authors the regression and the runtime executes
the red admission checks. The writer does not run authored tests itself. Coverage
for behavior that already works uses `green-maintenance`; documentation-only work
does not need an invented failing test.

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
Configured APE shipping is covered by the explicit run or resume invocation.
Publishing a tagged release must be included in the maintainer's request and pass
the [release checks](docs/operational-readiness.md); reuse existing authorization
for that release.
