#!/usr/bin/env node
/**
 * APE v2 latency certification harness.
 *
 * Records live in `benchmarks/reference-runs.json` as an array of:
 *
 *   { "host": "claude"|"codex", "lane": "mechanical"|"fast"|"full",
 *     "raw_ms": <wall-clock ms>, "test_ms": <ms, optional>,
 *     "remote_ci_ms": <ms, optional>, "recorded_at": <ISO timestamp> }
 *
 * `adjusted_ms = raw_ms - test_ms - remote_ci_ms` is compared against the
 * lane deadline (DEFAULT_DEADLINES_MS: mechanical 15 min, fast 30 min, full
 * 60 min). Certification groups by host and lane — the lane is what sets a
 * run's latency budget; mode never did (the former patch/phase mode split
 * proxied for lanes and was collapsed into the one building mode `phase`).
 * Certification requires >= 20 records per host/lane group with >= 18 passing.
 *
 * Usage:
 *   node scripts/benchmark-v2.mjs [verify] [file]   — verify (default action).
 *     With ZERO records this reports "no records yet" and exits 0: an empty
 *     ledger is the honest pre-certification state, not a failure. With records
 *     present it exits 1 unless every group is certified.
 *   node scripts/benchmark-v2.mjs record --host <claude|codex> --lane <mechanical|fast|full>
 *     --raw-ms <ms> [--test-ms <ms>] [--remote-ci-ms <ms>] [--file <path>]
 *     — validate and append one measured run. This is the producer path:
 *     append a record after each timed reference run.
 *   node scripts/benchmark-v2.mjs import --project <dir> [--file <path>]
 *     — derive certification records from a project's runtime history
 *     (.ape/runtime/history) on demand and append the new ones. Idempotent
 *     (dedupes by run_id) and never silent (prints what it imported/skipped and
 *     why). This is an EXPLICIT operator command — the runtime never writes the
 *     tracked ledger itself, so the resulting diff is one the operator commits
 *     deliberately.
 */
import { readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import path from 'node:path';
// Import the REAL effective-record selector so the producer's supersession
// semantics (completed beats blocked; latest completed_at; hash tiebreak) can
// never drift from the runtime's history reader (T14). scripts/ is not bundled
// and not in the tsc program, so this cross-import is runtime-only.
import { selectEffectiveRecord } from '../lib/runtime/history.js';
// The one encoding of where a project keeps its runtime history, shared with
// the runtime so the import path can never drift from where archiveRun writes.
import { runtimePaths } from '../lib/runtime/paths.js';
// The runtime's OWN lane deadlines are the certification thresholds, imported
// so the two can never drift.
import { DEFAULT_DEADLINES_MS } from '../lib/runtime/constants.js';

const DEFAULT_FILE = 'benchmarks/reference-runs.json';
const HOSTS = ['claude', 'codex', 'gemini'];
const CERT_LANES = ['mechanical', 'fast', 'full'];
// Runs certifiable for latency: the building mode, plus the legacy `patch`
// label that archived history keeps verbatim from before the mode collapse.
// Debug/spike/land runs never certify.
const BUILDING_MODES = ['phase', 'patch'];

export function percentile(values, ratio) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.max(0, Math.ceil(sorted.length * ratio) - 1)];
}

export function verifyBenchmarks(records) {
  const groups = [];
  let counted = 0;
  for (const host of HOSTS) {
    for (const lane of CERT_LANES) {
      const selected = records.filter((record) => record.host === host && record.lane === lane);
      counted += selected.length;
      const thresholdMs = DEFAULT_DEADLINES_MS[lane];
      const normalized = selected.map((record) => ({
        ...record,
        adjusted_ms: record.raw_ms - (record.test_ms ?? 0) - (record.remote_ci_ms ?? 0),
      }));
      const passing = normalized.filter((record) => record.adjusted_ms <= thresholdMs).length;
      groups.push({
        host,
        lane,
        count: normalized.length,
        required_count: 20,
        passing,
        required_passing: 18,
        raw_p90_ms: percentile(normalized.map((record) => record.raw_ms), 0.9),
        adjusted_p90_ms: percentile(normalized.map((record) => record.adjusted_ms), 0.9),
        passed: normalized.length >= 20 && passing >= 18,
      });
    }
  }
  // A record that matches no host/lane group (e.g. a pre-collapse mode-shaped
  // record) must never vanish silently from the report.
  const unclassified = records.length - counted;
  return {
    passed: groups.every((group) => group.passed),
    groups,
    ...(unclassified > 0 ? { unclassified } : {}),
  };
}

export function validateBenchmarkRecord(record) {
  if (!record || typeof record !== 'object' || Array.isArray(record)) {
    throw new Error('benchmark record must be an object');
  }
  if (!HOSTS.includes(record.host)) throw new Error(`record host must be one of: ${HOSTS.join(', ')}`);
  if (!CERT_LANES.includes(record.lane)) throw new Error(`record lane must be one of: ${CERT_LANES.join(', ')}`);
  if (!Number.isFinite(record.raw_ms) || record.raw_ms <= 0) {
    throw new Error('record raw_ms must be a positive number of milliseconds');
  }
  for (const key of ['test_ms', 'remote_ci_ms']) {
    if (record[key] !== undefined && (!Number.isFinite(record[key]) || record[key] < 0)) {
      throw new Error(`record ${key} must be a non-negative number of milliseconds`);
    }
  }
  return {
    host: record.host,
    lane: record.lane,
    raw_ms: record.raw_ms,
    ...(record.test_ms !== undefined ? { test_ms: record.test_ms } : {}),
    ...(record.remote_ci_ms !== undefined ? { remote_ci_ms: record.remote_ci_ms } : {}),
    recorded_at: record.recorded_at ?? new Date().toISOString(),
    // Optional dedupe key carried by history-derived import records (T14); the
    // record CLI never passes it, so those records stay byte-identical.
    // verifyBenchmarks already ignores unknown fields, so it survives verify.
    ...(typeof record.run_id === 'string' ? { run_id: record.run_id } : {}),
  };
}

function readRecords(file) {
  const records = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : [];
  if (!Array.isArray(records)) throw new Error('benchmark input must be an array');
  return records;
}

export function appendBenchmarkRecord(file, record) {
  const normalized = validateBenchmarkRecord(record);
  const records = readRecords(file);
  records.push(normalized);
  writeFileSync(file, `${JSON.stringify(records, null, 2)}\n`);
  return { record: normalized, count: records.length };
}

// raw_ms for a record that predates the runtime timing block: the run's own
// created_at -> completed_at wall clock, the SAME expression terminalRecord
// derives its archived raw_ms from, so an imported legacy record and a freshly
// archived one agree. Returns null when the stamps are missing or inverted.
function deriveRawMs(record) {
  const start = Date.parse(record.created_at ?? '');
  const end = Date.parse(record.completed_at ?? '');
  return Number.isFinite(start) && Number.isFinite(end) && end - start >= 0 ? end - start : null;
}

// Project a runtime history record into a certification record. host is run
// content when present; a record predating the host field falls back to the
// first receipt's attested host (receipts[0].agent.host). The timing block is
// used when archived; otherwise raw_ms derives from the timestamps and the
// test/CI subtrahends default to 0 (a conservative adjusted_ms that never
// over-credits a legacy run). run_id rides along as the dedupe key.
function deriveImportRecord(record) {
  const timing = record.timing ?? {};
  const host =
    typeof record.host === 'string' && record.host ? record.host : record.receipts?.[0]?.agent?.host;
  return {
    host,
    lane: record.lane,
    raw_ms: Number.isFinite(timing.raw_ms) ? timing.raw_ms : deriveRawMs(record),
    test_ms: Number.isFinite(timing.test_ms) ? timing.test_ms : 0,
    remote_ci_ms: Number.isFinite(timing.remote_ci_ms) ? timing.remote_ci_ms : 0,
    recorded_at: typeof record.completed_at === 'string' ? record.completed_at : undefined,
    run_id: record.run_id,
  };
}

// Read every history record file for a project and collapse each run to its one
// effective record (a re-gated completion supersedes its block-time record) via
// the runtime's OWN selector, so certification measures the run's final truth.
function readProjectHistory(projectDir) {
  const dir = runtimePaths(projectDir).history;
  let files;
  try {
    files = readdirSync(dir).filter((name) => name.endsWith('.json'));
  } catch (error) {
    if (error?.code === 'ENOENT') return [];
    throw error;
  }
  const byRun = new Map();
  for (const name of files) {
    let record;
    try {
      record = JSON.parse(readFileSync(path.join(dir, name), 'utf8'));
    } catch {
      // A torn or non-JSON history file is skipped, not fatal: import is a
      // best-effort read of an append-only ledger, never a validator of it.
      continue;
    }
    if (!record || typeof record.run_id !== 'string') continue;
    byRun.set(record.run_id, [...(byRun.get(record.run_id) ?? []), record]);
  }
  const effective = [];
  for (const group of byRun.values()) {
    const record = selectEffectiveRecord(group[0], group.slice(1));
    if (record) effective.push(record);
  }
  // Deterministic order so the appended ledger and the printed report are
  // stable across platforms (readdir order is not).
  return effective.sort((a, b) => a.run_id.localeCompare(b.run_id));
}

// Append the project's newly-certifiable runs to the ledger. Idempotent: a run
// already in the ledger (by run_id) is skipped, so re-import adds nothing.
// Refuses nothing silently — every non-imported run is reported with a reason.
export function importBenchmarksFromHistory(projectDir, file) {
  const records = readRecords(file);
  const seen = new Set(
    records.filter((record) => typeof record.run_id === 'string').map((record) => record.run_id),
  );
  const imported = [];
  const skipped = [];
  for (const record of readProjectHistory(projectDir)) {
    const run_id = record.run_id;
    if (record.status !== 'completed') {
      skipped.push({ run_id, reason: `run status is '${record.status}', not a completed run` });
      continue;
    }
    if (!BUILDING_MODES.includes(record.mode)) {
      skipped.push({ run_id, reason: `mode '${record.mode}' is not a certifiable building-mode run (phase, or legacy patch)` });
      continue;
    }
    if (!CERT_LANES.includes(record.lane)) {
      skipped.push({ run_id, reason: `lane '${record.lane}' is not a certifiable lane (${CERT_LANES.join('|')})` });
      continue;
    }
    if (seen.has(run_id)) {
      skipped.push({ run_id, reason: 'already imported (run_id present in the ledger)' });
      continue;
    }
    const derived = deriveImportRecord(record);
    if (!Number.isFinite(derived.raw_ms)) {
      skipped.push({ run_id, reason: 'raw_ms is not derivable (missing or inverted created_at/completed_at and no timing block)' });
      continue;
    }
    const adjusted = derived.raw_ms - derived.test_ms - derived.remote_ci_ms;
    if (adjusted < 0) {
      // A timing block whose test+CI exceeds raw certifies a negative duration —
      // an inconsistent measurement, never a real sub-zero run. Skip it loudly
      // rather than poison the ledger.
      skipped.push({
        run_id,
        reason: `adjusted_ms would be negative (${adjusted}ms = raw ${derived.raw_ms} - test ${derived.test_ms} - remote_ci ${derived.remote_ci_ms}); the timing block is inconsistent, so the run is not certifiable`,
      });
      continue;
    }
    let normalized;
    try {
      normalized = validateBenchmarkRecord(derived);
    } catch (error) {
      skipped.push({ run_id, reason: `record failed certification validation: ${error.message}` });
      continue;
    }
    records.push(normalized);
    seen.add(run_id);
    imported.push(normalized);
  }
  // Only touch the tracked ledger when there is something new: a re-import that
  // adds nothing leaves the file byte-identical (no spurious diff to commit).
  if (imported.length > 0) writeFileSync(file, `${JSON.stringify(records, null, 2)}\n`);
  return { imported, skipped, file, count: records.length };
}

function parseRecordFlags(argv) {
  const flags = {};
  for (let index = 0; index < argv.length; index += 2) {
    const name = argv[index];
    const value = argv[index + 1];
    if (!name?.startsWith('--') || value === undefined) {
      throw new Error(`malformed record arguments near '${name ?? ''}'`);
    }
    flags[name.slice(2)] = value;
  }
  const numeric = (raw) => (raw === undefined ? undefined : Number(raw));
  return {
    file: flags.file,
    record: {
      host: flags.host,
      lane: flags.lane,
      raw_ms: numeric(flags['raw-ms']),
      test_ms: numeric(flags['test-ms']),
      remote_ci_ms: numeric(flags['remote-ci-ms']),
    },
  };
}

function parseFlags(argv) {
  const flags = {};
  for (let index = 0; index < argv.length; index += 2) {
    const name = argv[index];
    const value = argv[index + 1];
    if (!name?.startsWith('--') || value === undefined) {
      throw new Error(`malformed arguments near '${name ?? ''}'`);
    }
    flags[name.slice(2)] = value;
  }
  return flags;
}

function main(argv) {
  if (argv[0] === 'record') {
    const { file, record } = parseRecordFlags(argv.slice(1));
    const target = path.resolve(file ?? DEFAULT_FILE);
    const appended = appendBenchmarkRecord(target, record);
    process.stdout.write(`${JSON.stringify({ appended: appended.record, count: appended.count, file: target }, null, 2)}\n`);
    return;
  }
  if (argv[0] === 'import') {
    const flags = parseFlags(argv.slice(1));
    if (!flags.project) {
      throw new Error('import requires --project <dir> (the project whose .ape/runtime/history is read)');
    }
    const target = path.resolve(flags.file ?? DEFAULT_FILE);
    const report = importBenchmarksFromHistory(path.resolve(flags.project), target);
    // The whole report is the only thing written to stdout so an operator (or a
    // test) can parse it: { imported: [..], skipped: [{run_id, reason}], file, count }.
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    return;
  }
  const fileArg = argv[0] === 'verify' ? argv[1] : argv[0];
  const file = path.resolve(fileArg ?? DEFAULT_FILE);
  const records = readRecords(file);
  if (records.length === 0) {
    // An empty ledger means certification has not started — report that
    // honestly and exit 0 instead of failing a check no run has fed yet.
    process.stdout.write(`${JSON.stringify({
      status: 'no-records',
      message: `no benchmark records yet in ${file}; append reference runs with \`node scripts/benchmark-v2.mjs record --host <claude|codex> --lane <mechanical|fast|full> --raw-ms <ms> [--test-ms <ms>] [--remote-ci-ms <ms>]\` — certification requires 20 records per host/lane group`,
    }, null, 2)}\n`);
    return;
  }
  const report = verifyBenchmarks(records);
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (!report.passed) process.exitCode = 1;
}

if (import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`benchmark-v2: ${error.message}\n`);
    process.exitCode = 1;
  }
}
