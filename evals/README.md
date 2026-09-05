# Prompt evaluation

These checks test Claude and Codex instructions against 37 synthetic cases.
They are separate from live pipeline certification.

## Offline checks

```sh
npm run eval:prompts:check
npm run eval:prompts:plan
```

`check` validates case coverage, schemas, prompt hashes, the call matrix, and the
scorer against expected results. `plan` prints the matrix. Neither makes model
calls or needs provider credentials.

## Live prompt evaluation

The matrix is two hosts × three model tiers × three repetitions: **18 paid
calls**. Each call contains all 37 cases. Obtain explicit cost approval first.

```sh
npm run eval:prompts:run -- --live --confirm-paid-eval --results evals/results/release-candidate
```

Both flags are required. Completed calls with current hashes are skipped; recorded
errors are retried on the next invocation. Limit a retry with repeatable
`--call <host>-<tier>-r<n>` arguments.

Claude runs with tools disabled. Codex runs in an empty, read-only, ephemeral
sandbox with user configuration and rules disabled. Both receive only synthetic
evidence and instructions not to use tools.

Verify saved results offline:

```sh
npm run eval:prompts:verify -- --results evals/results/release-candidate
```

Verification checks the hashes and 100% release thresholds. Keep approved result
artifacts in CI or release storage, not in source control.

## Live pipeline certification

This is a different check: real Codex workers must complete the required pipeline
runs. See [operational readiness](../docs/operational-readiness.md) and
`live-certification.schema.json`.

Create `live-certification.json` only from actual attempts. It must be the sole
change in a dedicated tagged certification commit over the tested source.
Do not fabricate attempts or replace failed evidence. Claude remains unverified
and cannot appear as certified attempt evidence.
