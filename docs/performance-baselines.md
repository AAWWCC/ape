# Performance baselines

APE treats CI timing and runtime latency as qualified measurements, not universal performance
claims. An empty ledger or an insufficient sample does not certify anything.

## Reproducible CI wall-clock method

Record the commit SHA and the committed `.github/test-durations.json` snapshot. Start from a clean
checkout with the committed lockfile, record the operating system and architecture, the exact
Node.js version, npm version, and worker setting, and install with `npm ci`. The production CI
partition is one smoke set and three shards:

```text
node scripts/run-ci-tests.mjs smoke
node scripts/run-ci-tests.mjs shard 1 3
node scripts/run-ci-tests.mjs shard 2 3
node scripts/run-ci-tests.mjs shard 3 3
```

Measure each command with monotonic timestamps immediately before process launch and after process
exit. Run the four commands on comparable clean workers, use the wall-clock interval from the first
partition start through the last partition finish, and retain individual partition durations.
Repeat the observation rather than reporting one unusually favorable run. Report the commit,
snapshot digest, OS, Node version, lockfile digest, worker resources/settings, command lines,
monotonic-clock source, repetition count, and every observed value. Results apply only to that
environment and commit; scheduling, caches, virtualization, and provider load can change them.

Refresh the snapshot with `npm run test:timings`. The refresh runs every supported test file without
file parallelism, requires a successful complete report, and atomically replaces the sorted snapshot.

## Runtime latency and adjusted p90

Each reference run records `raw_ms`, optionally `test_ms`, and optionally `remote_ci_ms`.
`adjusted_ms = raw_ms - test_ms - remote_ci_ms`; inconsistent negative adjusted values are rejected.
For both raw and adjusted observations, nearest-rank p90 sorts ascending and selects rank
`ceil(0.90 * count)`. Report raw p90 and adjusted p90 rather than substituting one for the other.

The six independently governed groups are Claude and Codex crossed with the `mechanical`, `fast`,
and `full` lanes. Their thresholds come from the runtime lane deadlines. Every group reports count,
required count, passing count, required passing, threshold, raw p90, adjusted p90, and an explicit
status. Certification requires at least 20 records and at least 18 passing records in every group.
Fewer than 20 records is `insufficient-records`; 20 records with fewer than 18 passes is
`insufficient-passes`. Empty or insufficient data is not a certification.

## Persistence, privacy, and bounds

History import rebuilds the complete current effective history-derived subset, preserves validated
manual rows, and removes source run identifiers before persistence. Diagnostics aggregate skip
reasons and do not print run identifiers, hashes, filenames, project paths, objectives, or receipts.
Re-importing unchanged effective content leaves the ledger byte-identical.

Before parsing, the producer limits an existing ledger to 1 MiB and 512 records. Serialized ledger
output is limited to 2 MiB. History import limits candidates to 2,048 entries, each entry to 256 KiB,
and total history input to 16 MiB. Existing-ledger metadata is checked before a bounded read or JSON
parse. Ledger replacements and duration-snapshot replacements use randomized same-directory,
exclusive private staging, sync and validation before atomic rename, destination identity checks,
and ownership-proven cleanup.

## Cooperative writer and crash-recovery boundary

Replacement safety assumes the current writer and other cooperative writers honor the exclusive
lock. Ledger bytes, timing reports, history entries, destination and staging paths, lock metadata,
PID values, timestamps, and mutations injected at an observable validation boundary are untrusted.
The implementation validates the exact expected bytes and file identity immediately before rename;
rename, unlink, persistent destination bytes, and identifier-free diagnostics are the resulting
sinks.

Each lock records its owner PID. An unchanged metadata-bearing lock is reclaimed only for a
confirmed-dead PID. A live owner, an `EPERM` result, or any other permission-ambiguous liveness
result is retained and not evicted. An unchanged empty, malformed, pre-metadata, or otherwise
unidentifiable lock is retained while young and reclaimed only after a conservative 60-second
lease. Consequently, a live process paused in the pre-metadata window is lease-bound and is not
protected indefinitely after those 60 seconds.

These guarantees cover cooperative lock-honoring writers and mutations observed at the final
validation boundary. They do not cover lock-ignoring writers or an arbitrary same-UID process that
changes destination or staging bytes in the final validation-to-rename syscall gap; that gap is
outside the portable protection available across Ubuntu, macOS, and Windows.
