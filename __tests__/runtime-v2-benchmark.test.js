import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  appendBenchmarkRecord,
  validateBenchmarkRecord,
  verifyBenchmarks,
} from '../scripts/benchmark-v2.mjs';
import { DEFAULT_DEADLINES_MS } from '../lib/runtime/constants.js';

const SCRIPT = join(process.cwd(), 'scripts', 'benchmark-v2.mjs');

function records(slowPerGroup = 2) {
  return ['claude', 'codex'].flatMap((host) =>
    ['mechanical', 'fast', 'full'].flatMap((lane) =>
      Array.from({ length: 20 }, (_, index) => {
        const limit = DEFAULT_DEADLINES_MS[lane];
        const adjusted = index < 20 - slowPerGroup ? limit - 1 : limit + 1;
        return {
          host,
          lane,
          raw_ms: adjusted + 15_000,
          test_ms: 10_000,
          remote_ci_ms: 5_000,
        };
      }),
    ),
  );
}

function runCli(args) {
  return spawnSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8' });
}

describe('APE v2 latency certification', () => {
  it('requires 20 runs and permits at most two misses per host and lane', () => {
    expect(verifyBenchmarks(records(2)).passed).toBe(true);
    expect(verifyBenchmarks(records(3)).passed).toBe(false);
    expect(verifyBenchmarks(records(2).slice(1)).passed).toBe(false);
  });

  it('thresholds are the runtime lane deadlines, per host/lane group', () => {
    const report = verifyBenchmarks(records(2));
    expect(report.groups).toHaveLength(6);
    for (const group of report.groups) {
      expect(['claude', 'codex']).toContain(group.host);
      expect(['mechanical', 'fast', 'full']).toContain(group.lane);
    }
  });

  it('reports records matching no host/lane group instead of dropping them silently', () => {
    const report = verifyBenchmarks([
      ...records(2),
      // A pre-collapse mode-shaped record has no lane: it must be surfaced.
      { host: 'claude', mode: 'patch', raw_ms: 60_000 },
    ]);
    expect(report.unclassified).toBe(1);
    expect(verifyBenchmarks(records(2))).not.toHaveProperty('unclassified');
  });
});

describe('benchmark record validation', () => {
  it('normalizes a valid record and stamps recorded_at', () => {
    const normalized = validateBenchmarkRecord({ host: 'claude', lane: 'mechanical', raw_ms: 120_000 });
    expect(normalized.host).toBe('claude');
    expect(normalized.raw_ms).toBe(120_000);
    expect(typeof normalized.recorded_at).toBe('string');
    expect(normalized).not.toHaveProperty('test_ms');
  });

  it('rejects unknown hosts, unknown lanes, and non-positive raw_ms', () => {
    expect(() => validateBenchmarkRecord({ host: 'unsupported_host', lane: 'mechanical', raw_ms: 1 })).toThrow(/host/);
    expect(validateBenchmarkRecord({ host: 'codex', lane: 'mechanical', raw_ms: 1000 }).host).toBe('codex');
    expect(() => validateBenchmarkRecord({ host: 'claude', lane: 'spike', raw_ms: 1 })).toThrow(/lane/);
    expect(() => validateBenchmarkRecord({ host: 'claude', mode: 'phase', raw_ms: 1 })).toThrow(/lane/);
    expect(() => validateBenchmarkRecord({ host: 'claude', lane: 'mechanical', raw_ms: 0 })).toThrow(/raw_ms/);
    expect(() => validateBenchmarkRecord({ host: 'claude', lane: 'mechanical', raw_ms: 1, test_ms: -5 })).toThrow(/test_ms/);
  });
});

describe('benchmark CLI', () => {
  let tempRoot;
  let file;
  beforeEach(() => {
    tempRoot = mkdtempSync(join(tmpdir(), 'ape-benchmark-'));
    file = join(tempRoot, 'reference-runs.json');
  });
  afterEach(() => {
    rmSync(tempRoot, { recursive: true, force: true });
  });

  it('verify on an EMPTY ledger exits 0 with a clear no-records report', () => {
    writeFileSync(file, '[]\n');
    const result = runCli(['verify', file]);
    expect(result.status).toBe(0);
    const report = JSON.parse(result.stdout);
    expect(report.status).toBe('no-records');
    expect(report.message).toContain('record --host');
  });

  it('verify still exits 1 when records exist but certification is not met', () => {
    writeFileSync(file, `${JSON.stringify([{ host: 'claude', lane: 'mechanical', raw_ms: 60_000 }])}\n`);
    const result = runCli(['verify', file]);
    expect(result.status).toBe(1);
    expect(JSON.parse(result.stdout).passed).toBe(false);
  });

  it('record appends a validated record that verify then consumes', () => {
    writeFileSync(file, '[]\n');
    const result = runCli([
      'record', '--host', 'claude', '--lane', 'mechanical', '--raw-ms', '120000',
      '--test-ms', '10000', '--file', file,
    ]);
    expect(result.status).toBe(0);
    const stored = JSON.parse(readFileSync(file, 'utf8'));
    expect(stored).toHaveLength(1);
    expect(stored[0]).toMatchObject({ host: 'claude', lane: 'mechanical', raw_ms: 120_000, test_ms: 10_000 });
    expect(typeof stored[0].recorded_at).toBe('string');
    // The appended record is now real (insufficient) data: verify reports it and fails.
    const verify = runCli(['verify', file]);
    expect(verify.status).toBe(1);
    expect(JSON.parse(verify.stdout).groups.find((g) => g.host === 'claude' && g.lane === 'mechanical').count).toBe(1);
  });

  it('record rejects an invalid record without touching the ledger', () => {
    writeFileSync(file, '[]\n');
    const result = runCli(['record', '--host', 'unsupported_host', '--lane', 'mechanical', '--raw-ms', '1000', '--file', file]);
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/host/);
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual([]);
  });
});

describe('appendBenchmarkRecord', () => {
  it('creates the ledger file when absent and accumulates records', () => {
    const tempRoot = mkdtempSync(join(tmpdir(), 'ape-benchmark-append-'));
    const file = join(tempRoot, 'reference-runs.json');
    try {
      const first = appendBenchmarkRecord(file, { host: 'codex', lane: 'full', raw_ms: 1_000_000 });
      expect(first.count).toBe(1);
      const second = appendBenchmarkRecord(file, { host: 'codex', lane: 'full', raw_ms: 2_000_000 });
      expect(second.count).toBe(2);
      expect(JSON.parse(readFileSync(file, 'utf8'))).toHaveLength(2);
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });
});

// T14: the benchmark producer derives certification records from a project's
// machine history on demand. These tests operate on TEMP-DIR ledgers only and
// never touch the tracked benchmarks/reference-runs.json.
describe('benchmark import from run history', () => {
  let projectDir;
  let historyDir;
  let ledgerRoot;
  let file;

  function writeRecord(record) {
    writeFileSync(join(historyDir, `${record.run_id}.json`), `${JSON.stringify(record, null, 2)}\n`);
  }

  beforeEach(() => {
    projectDir = mkdtempSync(join(tmpdir(), 'ape-import-project-'));
    historyDir = join(projectDir, '.ape', 'runtime', 'history');
    mkdirSync(historyDir, { recursive: true });
    ledgerRoot = mkdtempSync(join(tmpdir(), 'ape-import-ledger-'));
    file = join(ledgerRoot, 'reference-runs.json');
    writeFileSync(file, '[]\n');

    // a — completed run archived under the LEGACY 'patch' mode label WITH a
    // runtime timing block and an explicit host: history is immutable, so the
    // old label must stay certifiable. The lane sets its group.
    writeRecord({
      run_id: 'run-aaaa', status: 'completed', mode: 'patch', lane: 'mechanical',
      created_at: '2026-07-01T00:00:00.000Z', completed_at: '2026-07-01T00:05:00.000Z',
      host: 'claude',
      timing: { raw_ms: 300_000, test_ms: 40_000, remote_ci_ms: 20_000 },
      record_hash: 'a'.repeat(64),
    });
    // b — completed phase run PREDATING timing: host falls back to
    // receipts[0].agent.host, test/CI default to 0, raw_ms derives from the
    // timestamps (20 min).
    writeRecord({
      run_id: 'run-bbbb', status: 'completed', mode: 'phase', lane: 'full',
      created_at: '2026-07-01T00:00:00.000Z', completed_at: '2026-07-01T00:20:00.000Z',
      receipts: [{ agent: { host: 'codex', role: 'implementer' } }],
      record_hash: 'b'.repeat(64),
    });
    // c — a blocked run is never certifiable: skipped.
    writeRecord({
      run_id: 'run-cccc', status: 'blocked', mode: 'phase', lane: 'fast',
      created_at: '2026-07-01T00:00:00.000Z', completed_at: '2026-07-01T00:03:00.000Z',
      host: 'claude', record_hash: 'c'.repeat(64),
    });
    // d — a legacy imported record (mode 'import', no wall clock): skipped by
    // the building-mode filter.
    writeRecord({
      run_id: 'run-dddd', status: 'completed', mode: 'import',
      host: 'claude', record_hash: 'd'.repeat(64),
    });
    // e — a corrupt timing block whose test_ms + remote_ci_ms exceeds raw_ms
    // would certify with a NEGATIVE adjusted_ms: skipped WITH a printed reason.
    writeRecord({
      run_id: 'run-eeee', status: 'completed', mode: 'phase', lane: 'mechanical',
      created_at: '2026-07-01T00:00:00.000Z', completed_at: '2026-07-01T00:01:00.000Z',
      host: 'claude',
      timing: { raw_ms: 60_000, test_ms: 50_000, remote_ci_ms: 20_000 },
      record_hash: 'e'.repeat(64),
    });
    // f — a completed building run with no archived lane cannot be grouped:
    // skipped WITH a reason, never guessed into a lane.
    writeRecord({
      run_id: 'run-ffff', status: 'completed', mode: 'phase',
      created_at: '2026-07-01T00:00:00.000Z', completed_at: '2026-07-01T00:02:00.000Z',
      host: 'claude', record_hash: 'f'.repeat(64),
    });
  });

  afterEach(() => {
    rmSync(projectDir, { recursive: true, force: true });
    rmSync(ledgerRoot, { recursive: true, force: true });
  });

  it('imports only certifiable completed building runs, carrying run_id, and skips the rest with reasons', () => {
    const result = runCli(['import', '--project', projectDir, '--file', file]);
    expect(result.status).toBe(0);

    const ledger = JSON.parse(readFileSync(file, 'utf8'));
    expect(ledger).toHaveLength(2);
    const byRun = Object.fromEntries(ledger.map((record) => [record.run_id, record]));
    expect(Object.keys(byRun).sort()).toEqual(['run-aaaa', 'run-bbbb']);
    expect(byRun['run-aaaa']).toMatchObject({
      host: 'claude', lane: 'mechanical', raw_ms: 300_000, test_ms: 40_000, remote_ci_ms: 20_000, run_id: 'run-aaaa',
    });
    // Pre-timing record: host from the receipts fallback, zero-defaulted
    // test/CI, and a raw_ms derived from created_at -> completed_at.
    expect(byRun['run-bbbb']).toMatchObject({
      host: 'codex', lane: 'full', raw_ms: 1_200_000, test_ms: 0, remote_ci_ms: 0, run_id: 'run-bbbb',
    });
    expect(typeof byRun['run-aaaa'].recorded_at).toBe('string');

    // Nothing is refused silently: the negative-adjusted and lane-less records
    // are skipped and their reasons are printed in the report.
    const report = JSON.parse(result.stdout);
    for (const runId of ['run-eeee', 'run-ffff']) {
      const skipped = (report.skipped ?? []).find((entry) => entry.run_id === runId);
      expect(skipped).toBeDefined();
      expect(typeof skipped.reason).toBe('string');
      expect(skipped.reason.length).toBeGreaterThan(0);
    }
  });

  it('is idempotent: a second import over the same history dedupes by run_id and adds nothing', () => {
    expect(runCli(['import', '--project', projectDir, '--file', file]).status).toBe(0);
    expect(runCli(['import', '--project', projectDir, '--file', file]).status).toBe(0);
    const ledger = JSON.parse(readFileSync(file, 'utf8'));
    expect(ledger).toHaveLength(2);
    expect(ledger.filter((record) => record.run_id === 'run-aaaa')).toHaveLength(1);
  });

  it('verifyBenchmarks tolerates the run_id field the importer carries onto records', () => {
    const withRunId = records(2).map((record, index) => ({ ...record, run_id: `run-${index}` }));
    expect(verifyBenchmarks(withRunId).passed).toBe(true);
  });

  it('validateBenchmarkRecord passes a run_id through so imported records keep their dedupe key', () => {
    const normalized = validateBenchmarkRecord({ host: 'claude', lane: 'mechanical', raw_ms: 120_000, run_id: 'run-xyz' });
    expect(normalized.run_id).toBe('run-xyz');
    // A record with no run_id stays byte-identical to the record CLI path.
    expect(validateBenchmarkRecord({ host: 'claude', lane: 'mechanical', raw_ms: 120_000 })).not.toHaveProperty('run_id');
  });
});
