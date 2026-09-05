# Performance baselines

Timings describe a particular commit and environment, not a universal speed
guarantee. Empty or insufficient data is not a certification.

## Reproducible CI wall-clock method

Start with a clean checkout and `npm ci`. Record the commit, lockfile digest,
`.github/test-durations.json` digest, operating system and architecture,
Node.js version, npm version, and worker resources/settings.

Run the production partitions on comparable clean workers:

```sh
node scripts/run-ci-tests.mjs smoke
node scripts/run-ci-tests.mjs shard 1 3
node scripts/run-ci-tests.mjs shard 2 3
node scripts/run-ci-tests.mjs shard 3 3
```

Use a monotonic clock around each process. Report each duration and the interval
from the first start to the last finish. Repeat the measurement and report every
value, command, clock source, and repetition count—not just the fastest result.
Caches, scheduling, virtualization, and provider load can change the outcome.

`npm run test:timings` refreshes the duration snapshot. It runs all supported test
files without file parallelism and replaces the sorted snapshot only after a
successful complete report.

## Runtime latency and adjusted p90

Each run records `raw_ms`, with optional `test_ms` and `remote_ci_ms`:

```text
adjusted_ms = raw_ms - test_ms - remote_ci_ms
```

Negative adjusted values are rejected. Nearest-rank p90 sorts values in ascending
order and selects rank `ceil(0.90 * count)`. Report both raw and adjusted p90.

Measure six groups separately: Claude and Codex, each with `mechanical`, `fast`,
and `full` lanes. Thresholds come from runtime lane deadlines. Each group needs
at least 20 records and 18 passing records. Report count, required count, passing
count, required passing, threshold, both p90 values, and status.
Fewer than 20 records is `insufficient-records`; fewer than 18 passes is
`insufficient-passes` once the record minimum is met.

## Persistence, privacy, and bounds

History import rebuilds the history-derived rows, preserves valid manual rows,
and removes source run identifiers. Diagnostics show aggregate skip reasons—not
identifiers, hashes, filenames, project paths, objectives, or receipts. Importing
unchanged content leaves the ledger byte-identical.

Limits are 1 MiB and 512 records for an existing ledger, 2 MiB for output, and
2,048 history entries of at most 256 KiB each, totaling at most 16 MiB.
Metadata is checked before reading or parsing. Replacements use exclusive private
staging in the same directory, validate and sync before atomic rename, verify
destination identity, and clean up only owned files.

## Cooperative writer and crash-recovery boundary

Safety assumes cooperative writers honor the exclusive lock. Inputs and file
metadata are untrusted; exact bytes and file identity are checked at the final
observable validation boundary before rename.

A PID-bearing lock is reclaimed only for a confirmed-dead owner. Live owners,
`EPERM`, and permission-ambiguous results are retained, not evicted. An empty,
malformed, pre-metadata, or unidentifiable lock has a 60-second lease. This means a
live process paused in the pre-metadata window is lease-bound, not protected
indefinitely.

The final validation-to-rename syscall gap remains outside this guarantee: a
same-UID process or lock-ignoring writer can change bytes during that gap. The
portable implementation does not claim to prevent this on any supported OS.
