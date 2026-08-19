import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { runtimePaths } from '../lib/runtime/paths.js';
import { archiveRun, calculateProjectMetrics } from '../lib/runtime/history.js';
import { historyAction } from '../lib/runtime/service.js';
import { atomicWriteJson } from '../lib/runtime/storage.js';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const cleanups = [];

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

function makeRunRecord(id, overrides = {}) {
  return {
    schema_version: '2.0.0',
    run_id: id,
    objective: `Objective for ${id}`,
    mode: 'phase',
    lane: 'fast',
    host: 'codex',
    status: 'completed',
    created_at: '2026-08-01T00:00:00.000Z',
    updated_at: '2026-08-01T00:05:00.000Z',
    completed_at: '2026-08-01T00:05:00.000Z',
    terminal_at: '2026-08-01T00:05:00.000Z',
    base_commit_sha: 'a'.repeat(40),
    tree_sha: 'b'.repeat(40),
    tickets: [],
    receipts: [
      {
        receipt_id: `receipt-${id}`,
        status: 'passed',
        timing: { duration_ms: 1000 },
      },
    ],
    ...overrides,
  };
}

describe('APE v2 Project Metrics Aggregation & Telemetry', () => {
  describe('calculateProjectMetrics query filtering', () => {
    it('filters records by date range (since and until)', async () => {
      const dir = await mkdtemp(path.join(tmpdir(), 'ape-metrics-date-'));
      cleanups.push(dir);
      const paths = runtimePaths(dir);

      await archiveRun(paths, makeRunRecord('run-july', {
        created_at: '2026-07-15T00:00:00.000Z',
        completed_at: '2026-07-15T00:10:00.000Z',
      }));
      await archiveRun(paths, makeRunRecord('run-aug-1', {
        created_at: '2026-08-01T00:00:00.000Z',
        completed_at: '2026-08-01T00:10:00.000Z',
      }));
      await archiveRun(paths, makeRunRecord('run-aug-2', {
        created_at: '2026-08-15T00:00:00.000Z',
        completed_at: '2026-08-15T00:10:00.000Z',
      }));

      const augOnly = await calculateProjectMetrics(paths, {
        since: '2026-08-01T00:00:00.000Z',
        until: '2026-08-31T23:59:59.999Z',
      });

      expect(augOnly.total_runs).toBe(2);
      expect(augOnly.outcomes.completed).toBe(2);
    });

    it('filters records by lane, mode, host, and status', async () => {
      const dir = await mkdtemp(path.join(tmpdir(), 'ape-metrics-filters-'));
      cleanups.push(dir);
      const paths = runtimePaths(dir);

      await archiveRun(paths, makeRunRecord('run-fast-phase', { lane: 'fast', mode: 'phase', host: 'claude', status: 'completed' }));
      await archiveRun(paths, makeRunRecord('run-full-phase', { lane: 'full', mode: 'phase', host: 'codex', status: 'completed' }));
      await archiveRun(paths, makeRunRecord('run-fast-debug', { lane: 'fast', mode: 'debug', host: 'claude', status: 'blocked' }));
      await archiveRun(paths, makeRunRecord('run-fast-aborted', { lane: 'fast', mode: 'phase', host: 'codex', status: 'aborted' }));

      const fastPhaseClaude = await calculateProjectMetrics(paths, {
        lane: 'fast',
        mode: 'phase',
        host: 'claude',
      });

      expect(fastPhaseClaude.total_runs).toBe(1);
      expect(fastPhaseClaude.outcomes.completed).toBe(1);

      const fastLane = await calculateProjectMetrics(paths, { lane: 'fast' });
      expect(fastLane.total_runs).toBe(3);
      expect(fastLane.outcomes.completed).toBe(1);
      expect(fastLane.outcomes.blocked).toBe(1);
      expect(fastLane.outcomes.aborted).toBe(1);
    });
  });

  describe('calculateProjectMetrics outcome distributions and success rates', () => {
    it('computes outcome distribution counts and fractional success rates', async () => {
      const dir = await mkdtemp(path.join(tmpdir(), 'ape-metrics-outcomes-'));
      cleanups.push(dir);
      const paths = runtimePaths(dir);

      // 6 completed, 3 blocked, 1 aborted = 10 total
      for (let i = 0; i < 6; i++) {
        await archiveRun(paths, makeRunRecord(`run-c-${i}`, { status: 'completed' }));
      }
      for (let i = 0; i < 3; i++) {
        await archiveRun(paths, makeRunRecord(`run-b-${i}`, { status: 'blocked' }));
      }
      await archiveRun(paths, makeRunRecord('run-a-0', { status: 'aborted' }));

      const metrics = await calculateProjectMetrics(paths, {});
      expect(metrics.total_runs).toBe(10);
      expect(metrics.outcomes).toEqual({
        completed: 6,
        blocked: 3,
        aborted: 1,
      });
      expect(metrics.success_rate).toBeCloseTo(0.6, 2);
      expect(metrics.blocked_rate).toBeCloseTo(0.3, 2);
      expect(metrics.aborted_rate).toBeCloseTo(0.1, 2);
    });

    it('handles empty datasets without division by zero errors', async () => {
      const dir = await mkdtemp(path.join(tmpdir(), 'ape-metrics-empty-'));
      cleanups.push(dir);
      const paths = runtimePaths(dir);

      const metrics = await calculateProjectMetrics(paths, {});
      expect(metrics.total_runs).toBe(0);
      expect(metrics.outcomes).toEqual({
        completed: 0,
        blocked: 0,
        aborted: 0,
      });
      expect(metrics.success_rate).toBe(0);
      expect(metrics.durations.p50).toBeNull();
    });
  });

  describe('calculateProjectMetrics latency percentiles (p50, p90, p95, p99)', () => {
    it('accurately calculates duration percentiles over known distribution', async () => {
      const dir = await mkdtemp(path.join(tmpdir(), 'ape-metrics-percentiles-'));
      cleanups.push(dir);
      const paths = runtimePaths(dir);

      // Generate 100 runs with durations 10s, 20s, 30s, ..., 1000s (10,000ms ... 1,000,000ms)
      for (let i = 1; i <= 100; i++) {
        const durationSec = i * 10;
        const start = new Date('2026-08-01T00:00:00.000Z');
        const end = new Date(start.getTime() + durationSec * 1000);
        await archiveRun(paths, makeRunRecord(`run-p-${i}`, {
          created_at: start.toISOString(),
          completed_at: end.toISOString(),
          terminal_at: end.toISOString(),
        }));
      }

      const metrics = await calculateProjectMetrics(paths, {});
      expect(metrics.total_runs).toBe(100);
      expect(metrics.durations).toBeDefined();
      // p50 is ~500,000ms (500s)
      expect(metrics.durations.p50).toBeGreaterThanOrEqual(490_000);
      expect(metrics.durations.p50).toBeLessThanOrEqual(510_000);
      // p90 is ~900,000ms (900s)
      expect(metrics.durations.p90).toBeGreaterThanOrEqual(890_000);
      expect(metrics.durations.p90).toBeLessThanOrEqual(910_000);
      // p95 is ~950,000ms (950s)
      expect(metrics.durations.p95).toBeGreaterThanOrEqual(940_000);
      expect(metrics.durations.p95).toBeLessThanOrEqual(960_000);
      // p99 is ~990,000ms (990s)
      expect(metrics.durations.p99).toBeGreaterThanOrEqual(980_000);
      expect(metrics.durations.p99).toBeLessThanOrEqual(1_000_000);
    });
  });

  describe('explicit legacy-unknown accounting', () => {
    it('accounts for missing fields in legacy records under legacy_unknown without distorting metrics', async () => {
      const dir = await mkdtemp(path.join(tmpdir(), 'ape-metrics-legacy-'));
      cleanups.push(dir);
      const paths = runtimePaths(dir);

      // Modern run with all fields
      await archiveRun(paths, makeRunRecord('run-modern', {
        lane: 'fast',
        host: 'codex',
        created_at: '2026-08-01T00:00:00.000Z',
        completed_at: '2026-08-01T00:02:00.000Z', // 120s duration
        receipts: [{ receipt_id: 'r1', status: 'passed' }],
      }));

      // Legacy imported run without lane, host, created_at/completed_at durations, or receipts
      await archiveRun(paths, {
        schema_version: '2.0.0',
        run_id: 'run-legacy-imported',
        objective: 'Legacy record without modern telemetry',
        status: 'completed',
        imported: true,
      });

      const metrics = await calculateProjectMetrics(paths, {});
      expect(metrics.total_runs).toBe(2);
      expect(metrics.outcomes.completed).toBe(2);

      // Explicit legacy-unknown accounting
      expect(metrics.legacy_unknown).toBeDefined();
      expect(metrics.legacy_unknown.lane).toBe(1);
      expect(metrics.legacy_unknown.host).toBe(1);
      expect(metrics.legacy_unknown.duration).toBe(1);

      // Duration percentiles calculated over valid durations (120,000ms) only
      expect(metrics.durations.p50).toBe(120_000);
    });
  });

  describe('historyAction metrics action integration', () => {
    it('executes metrics action through historyAction returning structured metrics', async () => {
      const dir = await mkdtemp(path.join(tmpdir(), 'ape-metrics-action-'));
      cleanups.push(dir);
      const paths = runtimePaths(dir);

      await archiveRun(paths, makeRunRecord('run-action-1', { lane: 'fast', status: 'completed' }));
      await archiveRun(paths, makeRunRecord('run-action-2', { lane: 'fast', status: 'blocked' }));

      const res = await historyAction(dir, 'metrics', { lane: 'fast' });
      expect(res.ok).toBe(true);
      expect(res.metrics).toBeDefined();
      expect(res.metrics.total_runs).toBe(2);
      expect(res.metrics.outcomes.completed).toBe(1);
      expect(res.metrics.outcomes.blocked).toBe(1);
    });

    it('refuses invalid timestamps, reversed ranges, and unknown enum filters', async () => {
      const dir = await mkdtemp(path.join(tmpdir(), 'ape-metrics-validation-'));
      cleanups.push(dir);

      await expect(historyAction(dir, 'metrics', { since: 'not-a-date' }))
        .rejects.toThrow('metrics since must be a valid ISO timestamp');
      await expect(historyAction(dir, 'metrics', {
        since: '2026-08-02T00:00:00.000Z',
        until: '2026-08-01T00:00:00.000Z',
      })).rejects.toThrow('metrics since must be earlier than or equal to until');
      await expect(historyAction(dir, 'metrics', { lane: 'warp-speed' }))
        .rejects.toThrow('metrics lane must be one of');
      await expect(historyAction(dir, 'metrics', { host: 'remote-cloud' }))
        .rejects.toThrow('metrics host must be one of');
    });

    it('caps work at 256 newest runs and discloses truncated coverage', async () => {
      const dir = await mkdtemp(path.join(tmpdir(), 'ape-metrics-cap-'));
      cleanups.push(dir);
      const paths = runtimePaths(dir);
      await mkdir(paths.history, { recursive: true });
      await Promise.all(Array.from({ length: 260 }, (_, index) => {
        const runId = `run-cap-${String(index).padStart(3, '0')}`;
        return atomicWriteJson(
          path.join(paths.history, `${runId}.json`),
          makeRunRecord(runId),
        );
      }));

      const result = await historyAction(dir, 'metrics', {});
      expect(result.metrics.total_runs).toBe(256);
      expect(result.metrics.coverage).toEqual({
        available_runs: 260,
        processed_runs: 256,
        limit: 256,
        truncated: true,
      });
    });
  });
});
