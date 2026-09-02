import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { runtimePaths } from '../lib/runtime/paths.js';
import { archiveRun, calculateProjectMetrics } from '../lib/runtime/history.js';
import { projectHistoryResponse, RESPONSE_BUDGET_CHARS } from '../lib/runtime/projection.js';
import { historyAction } from '../lib/runtime/service.js';
import { atomicWriteJson } from '../lib/runtime/storage.js';
import { createSuccessorAttestation } from '../lib/runtime/successor-attestation.js';
import { admittedStartIdentityHash } from '../lib/runtime/admitted-start-identity.js';

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

const SUCCESSOR_REQUEST_HASH = 'd'.repeat(64);
const SUCCESSOR_CONFIG_HASH = 'c'.repeat(64);

function successorBinding(predecessor, successorRunId, retainedTree = predecessor.final_tree_sha) {
  return {
    start_config_hash: SUCCESSOR_CONFIG_HASH,
    successor_request_hash: SUCCESSOR_REQUEST_HASH,
    successor_attestation: createSuccessorAttestation({
      version: 2,
      predecessor_run_id: predecessor.run_id,
      retained_tree_sha: retainedTree,
      config_hash: SUCCESSOR_CONFIG_HASH,
      approval_id: 'successor-approval-00000000-0000-4000-8000-000000000001',
    }, predecessor.record_hash, successorRunId, SUCCESSOR_REQUEST_HASH),
  };
}

function successorRecord(predecessor, successorRunId, overrides = {}) {
  const state = makeRunRecord(successorRunId, {
    status: 'completed',
    supersedes_run: predecessor.run_id,
    ...successorBinding(predecessor, successorRunId),
    ...overrides,
  });
  state.admitted_start_identity_version = 1;
  state.start_request_hash = overrides.start_request_hash ?? SUCCESSOR_REQUEST_HASH;
  state.admitted_run_contract = null;
  state.admitted_start_identity_hash = admittedStartIdentityHash(state);
  return state;
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

    it('excludes unrelated lineage diagnostics and lifecycle counts from filtered cohorts', async () => {
      const dir = await mkdtemp(path.join(tmpdir(), 'ape-metrics-filtered-lineage-'));
      cleanups.push(dir);
      const paths = runtimePaths(dir);

      await archiveRun(paths, makeRunRecord('run-filtered-codex', {
        host: 'codex',
        status: 'completed',
      }));
      await archiveRun(paths, makeRunRecord('run-filtered-claude-blocked', {
        host: 'claude',
        status: 'blocked',
      }));
      await mkdir(paths.history, { recursive: true });
      await atomicWriteJson(
        path.join(paths.history, 'run-filtered-claude-corrupt.json'),
        {
          ...makeRunRecord('run-filtered-claude-corrupt', { host: 'claude' }),
          record_hash: '0'.repeat(64),
        },
      );

      const metrics = await calculateProjectMetrics(paths, { host: 'codex' });
      expect(metrics.primary_outcome).toEqual({
        basis: 'logical-lineage-v1',
        total: 1,
        outcomes: {
          recovered: 1,
          unresolved_blocked: 0,
          aborted: 0,
          unknown: 0,
        },
        success_rate: 1,
        blocked_rate: 0,
        run_lifecycle: {
          unresolved_blocked: 0,
          superseded: 0,
          recovering: 0,
          recovered: 1,
        },
        incomplete: false,
      });
    });

    it('accepts the protected-branch land mode advertised by the MCP contract', async () => {
      const dir = await mkdtemp(path.join(tmpdir(), 'ape-metrics-land-mode-'));
      cleanups.push(dir);
      const paths = runtimePaths(dir);
      await archiveRun(paths, makeRunRecord('run-land-complete', {
        mode: 'land',
        lane: 'full',
        status: 'completed',
      }));
      await archiveRun(paths, makeRunRecord('run-phase-complete', {
        mode: 'phase',
        lane: 'full',
        status: 'completed',
      }));

      const land = await historyAction(dir, 'metrics', { mode: 'land' });
      expect(land.metrics.total_runs).toBe(1);
      expect(land.metrics.outcomes.completed).toBe(1);
      expect(land.metrics.lineage_outcomes.outcomes.completed).toBe(1);
    });

    it('counts and exactly filters land disagreement separately from exhausted remediation', async () => {
      const dir = await mkdtemp(path.join(tmpdir(), 'ape-metrics-land-review-'));
      cleanups.push(dir);
      const paths = runtimePaths(dir);
      await archiveRun(paths, makeRunRecord('run-land-review-disagreement', {
        mode: 'land',
        status: 'blocked',
        stage: 'review',
        remediation_cycles: 0,
        block_reason: 'land mode has no writing stage; revise the diff outside APE, then start a new land run',
        terminal_reason_taxonomy_version: 2,
        terminal_reason_code: 'land_review_disagreement',
      }));
      await archiveRun(paths, makeRunRecord('run-review-remediation-exhausted', {
        status: 'blocked',
        stage: 'remediation',
        remediation_cycles: 2,
        block_reason: 'review disagreement reached the configured remediation budget (2 cycles)',
        terminal_reason_taxonomy_version: 2,
        terminal_reason_code: 'review_remediation_exhausted',
      }));

      const all = await calculateProjectMetrics(paths);
      expect(all.terminal_reason_counts).toMatchObject({
        land_review_disagreement: 1,
        review_remediation_exhausted: 1,
      });
      expect(all.version_cohorts.terminal_reason_taxonomy_version).toMatchObject({
        2: 2,
      });

      const land = await historyAction(dir, 'metrics', {
        terminal_reason_code: 'land_review_disagreement',
      });
      expect(land.metrics.total_runs).toBe(1);
      expect(land.metrics.terminal_reason_counts).toMatchObject({
        land_review_disagreement: 1,
        review_remediation_exhausted: 0,
      });

      const exhausted = await historyAction(dir, 'metrics', {
        terminal_reason_code: 'review_remediation_exhausted',
      });
      expect(exhausted.metrics.total_runs).toBe(1);
      expect(exhausted.metrics.terminal_reason_counts).toMatchObject({
        land_review_disagreement: 0,
        review_remediation_exhausted: 1,
      });
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

    it('reports unsuperseded leaf outcomes without erasing branched recovery attempts', async () => {
      const dir = await mkdtemp(path.join(tmpdir(), 'ape-metrics-lineages-'));
      cleanups.push(dir);
      const paths = runtimePaths(dir);

      await archiveRun(paths, makeRunRecord('run-lineage-root', { status: 'blocked' }));
      await archiveRun(paths, makeRunRecord('run-lineage-aborted', {
        status: 'aborted',
        supersedes_run: 'run-lineage-root',
      }));
      await archiveRun(paths, makeRunRecord('run-lineage-complete', {
        status: 'completed',
        supersedes_run: 'run-lineage-root',
      }));
      await archiveRun(paths, makeRunRecord('run-lineage-standalone', { status: 'blocked' }));
      await archiveRun(paths, makeRunRecord('run-lineage-partial', {
        status: 'aborted',
        supersedes_run: 'run-lineage-missing',
      }));
      await archiveRun(paths, makeRunRecord('run-lineage-invalid', {
        status: 'aborted',
        supersedes_run: 'run-lineage-invalid',
      }));

      const metrics = await calculateProjectMetrics(paths, {});
      expect(metrics.total_runs).toBe(6);
      expect(metrics.lineage_outcomes).toMatchObject({
        total_lineages: 5,
        outcomes: { completed: 1, blocked: 1, aborted: 3, unknown: 0 },
        coverage: {
          resolved_lineages: 3,
          partial_lineages: 1,
          malformed_lineages: 1,
          superseded_runs: 1,
          valid_supersession_links: 2,
          missing_predecessor_links: 1,
          self_links: 1,
          branching_predecessors: 1,
        },
      });

      const completed = await calculateProjectMetrics(paths, { status: 'completed' });
      expect(completed.lineage_outcomes).toMatchObject({
        total_lineages: 1,
        outcomes: { completed: 1, blocked: 0, aborted: 0, unknown: 0 },
      });
    });

    it('excludes supersession cycles from outcome rates and discloses every uncounted record', async () => {
      const dir = await mkdtemp(path.join(tmpdir(), 'ape-metrics-lineage-cycle-'));
      cleanups.push(dir);
      const paths = runtimePaths(dir);

      await archiveRun(paths, makeRunRecord('run-cycle-one', {
        status: 'blocked',
        supersedes_run: 'run-cycle-two',
      }));
      await archiveRun(paths, makeRunRecord('run-cycle-two', {
        status: 'aborted',
        supersedes_run: 'run-cycle-one',
      }));
      await archiveRun(paths, makeRunRecord('run-cycle-tainted-leaf', {
        status: 'completed',
        supersedes_run: 'run-cycle-one',
      }));

      const metrics = await calculateProjectMetrics(paths, {});
      expect(metrics.lineage_outcomes).toMatchObject({
        total_lineages: 0,
        outcomes: { completed: 0, blocked: 0, aborted: 0, unknown: 0 },
        coverage: {
          cycle_components: 1,
          cycle_runs: 2,
          cycle_tainted_runs: 1,
          uncounted_runs: 3,
          malformed_components: 1,
        },
      });
    });

    it('makes the validated logical lineage the primary aggregate while retaining raw audit counts', async () => {
      const dir = await mkdtemp(path.join(tmpdir(), 'ape-metrics-primary-lineage-'));
      cleanups.push(dir);
      const paths = runtimePaths(dir);

      const predecessor = await archiveRun(
        paths,
        makeRunRecord('run-primary-root', { status: 'blocked' }),
      );
      await archiveRun(paths, successorRecord(predecessor, 'run-primary-successor'));
      await archiveRun(paths, makeRunRecord('run-primary-open', { status: 'blocked' }));

      const metrics = await calculateProjectMetrics(paths, {});
      expect(metrics.outcomes).toEqual({ completed: 1, blocked: 2, aborted: 0 });
      expect(metrics.primary_outcome).toEqual({
        basis: 'logical-lineage-v1',
        total: 2,
        outcomes: {
          recovered: 1,
          unresolved_blocked: 1,
          aborted: 0,
          unknown: 0,
        },
        success_rate: 0.5,
        blocked_rate: 0.5,
        run_lifecycle: {
          unresolved_blocked: 1,
          superseded: 1,
          recovering: 0,
          recovered: 1,
        },
        incomplete: false,
      });
      expect(metrics.audit_outcomes).toEqual({
        total_runs: 3,
        outcomes: { completed: 1, blocked: 2, aborted: 0 },
      });
    });

    it('rejects a self-consistent attestation whose retained tree does not match the predecessor', async () => {
      const dir = await mkdtemp(path.join(tmpdir(), 'ape-metrics-mismatched-attestation-'));
      cleanups.push(dir);
      const paths = runtimePaths(dir);
      const predecessor = await archiveRun(
        paths,
        makeRunRecord('run-mismatch-root', { status: 'blocked' }),
      );
      await archiveRun(paths, successorRecord(
        predecessor,
        'run-mismatch-completed',
        successorBinding(
          predecessor,
          'run-mismatch-completed',
          'c'.repeat(40),
        ),
      ));

      const metrics = await calculateProjectMetrics(paths, {});
      expect(metrics.primary_outcome).toMatchObject({
        total: 1,
        outcomes: { recovered: 0, unresolved_blocked: 1 },
        incomplete: true,
        uncounted_runs: 1,
        incomplete_reasons: ['mismatched-successor-attestation'],
      });
    });

    it('keeps an unattested legacy supersession audit-only and never promotes it as recovered', async () => {
      const dir = await mkdtemp(path.join(tmpdir(), 'ape-metrics-unattested-lineage-'));
      cleanups.push(dir);
      const paths = runtimePaths(dir);

      await archiveRun(paths, makeRunRecord('run-unattested-root', { status: 'blocked' }));
      await archiveRun(paths, makeRunRecord('run-unattested-completed', {
        status: 'completed',
        supersedes_run: 'run-unattested-root',
      }));

      const metrics = await calculateProjectMetrics(paths, {});
      expect(metrics.audit_outcomes).toEqual({
        total_runs: 2,
        outcomes: { completed: 1, blocked: 1, aborted: 0 },
      });
      expect(metrics.primary_outcome).toMatchObject({
        total: 1,
        outcomes: {
          recovered: 0,
          unresolved_blocked: 1,
          aborted: 0,
          unknown: 0,
        },
        incomplete: true,
        uncounted_runs: 1,
        incomplete_reasons: ['unattested-supersession'],
      });
    });

    it('keeps a configuration-unbound version-1 attestation audit-only', async () => {
      const dir = await mkdtemp(path.join(tmpdir(), 'ape-metrics-v1-lineage-'));
      cleanups.push(dir);
      const paths = runtimePaths(dir);
      const predecessor = await archiveRun(
        paths,
        makeRunRecord('run-v1-root', { status: 'blocked' }),
      );
      await archiveRun(paths, makeRunRecord('run-v1-successor', {
        status: 'completed',
        supersedes_run: predecessor.run_id,
        start_config_hash: SUCCESSOR_CONFIG_HASH,
        successor_request_hash: SUCCESSOR_REQUEST_HASH,
        successor_attestation: createSuccessorAttestation({
          version: 1,
          predecessor_run_id: predecessor.run_id,
          retained_tree_sha: predecessor.final_tree_sha,
          authorization: 'explicit-operator-start',
        }, predecessor.record_hash, 'run-v1-successor', SUCCESSOR_REQUEST_HASH),
      }));

      expect((await calculateProjectMetrics(paths, {})).primary_outcome).toMatchObject({
        total: 1,
        outcomes: { recovered: 0, unresolved_blocked: 1 },
        incomplete: true,
        uncounted_runs: 1,
        incomplete_reasons: ['legacy-successor-attestation'],
      });
    });

    it('keeps a self-consistent attestation audit-only when it is not bound to the admitted start request', async () => {
      const dir = await mkdtemp(path.join(tmpdir(), 'ape-metrics-request-hash-mismatch-'));
      cleanups.push(dir);
      const paths = runtimePaths(dir);
      const predecessor = await archiveRun(
        paths,
        makeRunRecord('run-request-hash-root', { status: 'blocked' }),
      );
      const forgedRequestHash = 'e'.repeat(64);
      const binding = {
        start_config_hash: SUCCESSOR_CONFIG_HASH,
        successor_request_hash: forgedRequestHash,
        successor_attestation: createSuccessorAttestation({
          version: 2,
          predecessor_run_id: predecessor.run_id,
          retained_tree_sha: predecessor.final_tree_sha,
          config_hash: SUCCESSOR_CONFIG_HASH,
          approval_id: 'successor-approval-00000000-0000-4000-8000-000000000003',
        }, predecessor.record_hash, 'run-request-hash-successor', forgedRequestHash),
      };
      await archiveRun(paths, successorRecord(
        predecessor,
        'run-request-hash-successor',
        binding,
      ));

      expect((await calculateProjectMetrics(paths, {})).primary_outcome).toMatchObject({
        total: 1,
        outcomes: { recovered: 0, unresolved_blocked: 1 },
        incomplete: true,
        uncounted_runs: 1,
        incomplete_reasons: ['mismatched-successor-start-request'],
      });
    });

    it('keeps a version-2 attestation audit-only when admitted-start identity is absent', async () => {
      const dir = await mkdtemp(path.join(tmpdir(), 'ape-metrics-unbound-start-'));
      cleanups.push(dir);
      const paths = runtimePaths(dir);
      const predecessor = await archiveRun(
        paths,
        makeRunRecord('run-unbound-start-root', { status: 'blocked' }),
      );
      await archiveRun(paths, makeRunRecord('run-unbound-start-successor', {
        status: 'completed',
        supersedes_run: predecessor.run_id,
        ...successorBinding(predecessor, 'run-unbound-start-successor'),
      }));

      expect((await calculateProjectMetrics(paths, {})).primary_outcome).toMatchObject({
        total: 1,
        outcomes: { recovered: 0, unresolved_blocked: 1 },
        incomplete: true,
        uncounted_runs: 1,
        incomplete_reasons: ['unbound-successor-start-request'],
      });
    });

    it('marks a logical result incomplete when a missing predecessor or cycle prevents validation', async () => {
      const dir = await mkdtemp(path.join(tmpdir(), 'ape-metrics-incomplete-lineage-'));
      cleanups.push(dir);
      const paths = runtimePaths(dir);

      await archiveRun(paths, makeRunRecord('run-incomplete-leaf', {
        status: 'completed',
        supersedes_run: 'run-incomplete-missing',
      }));
      await archiveRun(paths, makeRunRecord('run-incomplete-cycle-a', {
        status: 'blocked',
        supersedes_run: 'run-incomplete-cycle-b',
      }));
      await archiveRun(paths, makeRunRecord('run-incomplete-cycle-b', {
        status: 'aborted',
        supersedes_run: 'run-incomplete-cycle-a',
      }));

      const metrics = await calculateProjectMetrics(paths, {});
      expect(metrics.primary_outcome).toMatchObject({
        basis: 'logical-lineage-v1',
        incomplete: true,
        uncounted_runs: 3,
        incomplete_reasons: ['missing-predecessor', 'unattested-supersession'],
      });
      expect(metrics.primary_outcome.outcomes.recovered).toBe(0);
    });

    it('fails closed when one predecessor has multiple competing logical leaves', async () => {
      const dir = await mkdtemp(path.join(tmpdir(), 'ape-metrics-ambiguous-lineage-'));
      cleanups.push(dir);
      const paths = runtimePaths(dir);

      const predecessor = await archiveRun(
        paths,
        makeRunRecord('run-ambiguous-root', { status: 'blocked' }),
      );
      await archiveRun(paths, successorRecord(predecessor, 'run-ambiguous-completed'));
      await archiveRun(paths, successorRecord(predecessor, 'run-ambiguous-aborted', {
        status: 'aborted',
      }));

      const metrics = await calculateProjectMetrics(paths, {});
      expect(metrics.primary_outcome).toMatchObject({
        basis: 'logical-lineage-v1',
        total: 0,
        incomplete: true,
        uncounted_runs: 3,
        incomplete_reasons: ['ambiguous-leaf'],
        outcomes: {
          recovered: 0,
          unresolved_blocked: 0,
          aborted: 0,
          unknown: 0,
        },
      });
      expect(metrics.audit_outcomes).toEqual({
        total_runs: 3,
        outcomes: { completed: 1, blocked: 1, aborted: 1 },
      });
    });

    it('never promotes a corrupt archived record into a successful logical outcome', async () => {
      const dir = await mkdtemp(path.join(tmpdir(), 'ape-metrics-corrupt-lineage-'));
      cleanups.push(dir);
      const paths = runtimePaths(dir);
      await mkdir(paths.history, { recursive: true });
      await atomicWriteJson(
        path.join(paths.history, 'run-corrupt-completed.json'),
        {
          ...makeRunRecord('run-corrupt-completed', { status: 'completed' }),
          record_hash: '0'.repeat(64),
        },
      );

      const metrics = await calculateProjectMetrics(paths, {});
      expect(metrics.primary_outcome).toMatchObject({
        total: 0,
        incomplete: true,
        uncounted_runs: 1,
        incomplete_reasons: ['corrupt-record'],
      });
      expect(metrics.primary_outcome.outcomes.recovered).toBe(0);
    });

    it('treats a missing archive hash as unverified instead of a successful logical outcome', async () => {
      const dir = await mkdtemp(path.join(tmpdir(), 'ape-metrics-missing-hash-lineage-'));
      cleanups.push(dir);
      const paths = runtimePaths(dir);
      await mkdir(paths.history, { recursive: true });
      const unverified = makeRunRecord('run-unverified-completed', { status: 'completed' });
      delete unverified.record_hash;
      await atomicWriteJson(
        path.join(paths.history, 'run-unverified-completed.json'),
        unverified,
      );

      const metrics = await calculateProjectMetrics(paths, {});
      expect(metrics.primary_outcome).toMatchObject({
        total: 0,
        incomplete: true,
        uncounted_runs: 1,
        incomplete_reasons: ['corrupt-record'],
      });
      expect(metrics.primary_outcome.outcomes.recovered).toBe(0);
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
      await expect(historyAction(dir, 'metrics', { ape_version: 'dev' }))
        .rejects.toThrow('metrics ape_version is invalid');
      await expect(historyAction(dir, 'metrics', { protocol_version: 'codex-latest' }))
        .rejects.toThrow('metrics protocol_version is invalid');
      await expect(historyAction(dir, 'metrics', { terminal_reason_code: 'mysterious' }))
        .rejects.toThrow('metrics terminal_reason_code must be one of');
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

    it('bounds high-cardinality version cohorts before the metrics response reaches the wire', async () => {
      const dir = await mkdtemp(path.join(tmpdir(), 'ape-metrics-cohort-bound-'));
      cleanups.push(dir);
      const paths = runtimePaths(dir);
      await mkdir(paths.history, { recursive: true });
      await Promise.all(Array.from({ length: 256 }, (_, index) => {
        const runId = `run-cohort-bound-${String(index).padStart(3, '0')}`;
        return atomicWriteJson(path.join(paths.history, `${runId}.json`), makeRunRecord(runId, {
          ape_version: `2.${index}.0`,
          runtime_version: index + 1,
          host_plugin_version: `3.${index}.0`,
          protocol_version: `ape-codex-dispatch-v${index + 1}`,
          envelope_version: index + 1,
          terminal_reason_taxonomy_version: index + 1,
          terminal_reason_code: 'completed',
        }));
      }));

      const response = projectHistoryResponse({
        ok: true,
        metrics: await calculateProjectMetrics(paths, {}),
      });
      expect(JSON.stringify(response).length).toBeLessThan(RESPONSE_BUDGET_CHARS);
      expect(response.metrics.version_cohorts.ape_version).toMatchObject({
        unknown: 0,
        omitted_cohorts: 240,
        omitted_runs: 240,
      });
      expect(response.metrics.version_cohorts.protocol_version).toMatchObject({
        unknown: 0,
        not_applicable: 0,
        omitted_cohorts: 240,
        omitted_runs: 240,
      });
    });
  });
});
