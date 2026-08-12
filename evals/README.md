# Prompt release evaluation

This suite evaluates the shipped Claude and Codex prompt/skill surfaces against synthetic evidence.
One provider call contains all 36 independent cases. The release matrix is two hosts by three
configured model tiers by three repetitions: 18 paid calls total.

No live call is the default:

```sh
npm run eval:prompts:check
npm run eval:prompts:plan
```

`check` validates fixture coverage, response schema, prompt/source hashes, the exact call matrix,
and the scorer against its hidden oracle. It needs no provider credentials. `plan` prints the live
matrix without starting it.

After explicit cost approval, start or resume the matrix with both guards:

```sh
npm run eval:prompts:run -- --live --confirm-paid-eval --results evals/results/release-candidate
```

Completed current-hash calls are skipped. Errors are recorded and retried on the next invocation.
Use repeatable `--call <host>-<tier>-r<n>` arguments for a bounded retry. Claude runs with tools
disabled; Codex runs ephemerally in an empty read-only sandbox with user configuration and rules
disabled. The prompt itself forbids tools and uses only the included synthetic evidence.

Verify an existing artifact offline, including all hashes and 100% release thresholds:

```sh
npm run eval:prompts:verify -- --results evals/results/release-candidate
```

Generated result directories are ignored. Preserve an approved release artifact in external CI or
release storage rather than committing model output to the source tree.
