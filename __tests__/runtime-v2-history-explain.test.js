import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { runtimePaths } from '../lib/runtime/paths.js';
import { archiveRun, explainRun } from '../lib/runtime/history.js';
import { historyAction } from '../lib/runtime/service.js';
import { atomicWriteJson } from '../lib/runtime/storage.js';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const cleanups = [];

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

function createHistoryRecord(overrides = {}) {
  return {
    schema_version: '2.0.0',
    run_id: 'run-explain-sample',
    objective: 'Implement rich history explanation and lifecycle telemetry',
    mode: 'phase',
    lane: 'fast',
    status: 'completed',
    created_at: '2026-08-01T12:00:00.000Z',
    updated_at: '2026-08-01T12:05:00.000Z',
    completed_at: '2026-08-01T12:05:00.000Z',
    terminal_at: '2026-08-01T12:05:00.000Z',
    base_commit_sha: 'a'.repeat(40),
    tree_sha: 'b'.repeat(40),
    tickets: [
      {
        ticket_id: 'run-explain-sample:test:1',
        stage_id: 'test',
        role: 'test_writer',
        model_tier: 'balanced',
        attempt: 1,
      },
      {
        ticket_id: 'run-explain-sample:implementer:1',
        stage_id: 'implementer',
        role: 'implementer',
        model_tier: 'balanced',
        attempt: 1,
      },
    ],
    receipts: [
      {
        receipt_id: 'r-test',
        ticket_id: 'run-explain-sample:test:1',
        status: 'passed',
        timing: { duration_ms: 1200 },
      },
      {
        receipt_id: 'r-impl',
        ticket_id: 'run-explain-sample:implementer:1',
        status: 'passed',
        timing: { duration_ms: 3400 },
      },
    ],
    merge: {
      url: 'https://github.com/acme/repo/pull/42',
      sha: 'c'.repeat(40),
      method: 'squash',
    },
    ...overrides,
  };
}

describe('APE v2 History Explain & Lifecycle Telemetry Output', () => {
  describe('explainRun detailed lifecycle formatting', () => {
    it('formats a completed run with tier, timing, and gate pass details', () => {
      const record = createHistoryRecord({
        gates: { passed: true, checks_count: 2 },
      });

      const explanation = explainRun(record);
      expect(explanation).toContain('Run run-explain-sample: Implement rich history explanation and lifecycle telemetry');
      expect(explanation).toContain('Status: completed; lane: fast; mode: phase.');
      expect(explanation).toContain('Agents: 2 passed receipts, 0 non-passing receipts.');
      expect(explanation).toContain('Merged: https://github.com/acme/repo/pull/42');
      // Rich telemetry lines required by R2 / W4
      expect(explanation).toMatch(/Tier(s)?:.*balanced/i);
      expect(explanation).toMatch(/Timing|Duration:.*5m|300s|300000ms/i);
      expect(explanation).toMatch(/Gates?:.*passed/i);
    });

    it('formats a blocked run with blocker cause and remediation facts', () => {
      const record = createHistoryRecord({
        status: 'blocked',
        block_reason: 'deterministic test gate failed: 1 failure in test suite',
        remediation_route: {
          route: 'test',
          test_paths: ['tests/calc.test.js'],
          cycle: 1,
        },
        receipts: [
          {
            receipt_id: 'r-fail',
            ticket_id: 'run-explain-sample:test:1',
            status: 'failed',
          },
        ],
        merge: null,
      });

      const explanation = explainRun(record);
      expect(explanation).toContain('Status: blocked');
      expect(explanation).toContain('Block reason: deterministic test gate failed: 1 failure in test suite');
      expect(explanation).toMatch(/Remediation route:.*test/i);
      expect(explanation).toContain('tests/calc.test.js');
    });

    it('formats an aborted run with abort reason and operator attribution', () => {
      const record = createHistoryRecord({
        status: 'aborted',
        abort_reason: 'operator requested abort via ape_run override',
        merge: null,
      });

      const explanation = explainRun(record);
      expect(explanation).toContain('Status: aborted');
      expect(explanation).toContain('Abort reason: operator requested abort via ape_run override');
    });

    it('formats superseding recovery completions and cross-run supersessions', () => {
      const record = createHistoryRecord({
        supersedes: 'hash-block-record-1234',
        supersedes_run: 'run-abandoned-prev-99',
        recovery: {
          type: 'regate',
          original_block: 'gate failure: lint check',
        },
      });

      const explanation = explainRun(record);
      expect(explanation).toContain("Supersedes this run's block-time record (hash-block-record-1234).");
      expect(explanation).toContain('Supersedes abandoned run run-abandoned-prev-99.');
      expect(explanation).toMatch(/Recovery:.*re-?gate/i);
    });

    it('formats input-hold and retry lifecycle facts when present', () => {
      const record = createHistoryRecord({
        retries_count: 2,
        input_hold: {
          occurred: true,
          questions_answered: 2,
        },
      });

      const explanation = explainRun(record);
      expect(explanation).toMatch(/Retr(y|ies):.*2/i);
      expect(explanation).toMatch(/Input[- ]hold:.*answered 2 question/i);
    });

    it('renders legacy imported records truthfully with unknown placeholders', () => {
      const legacyRecord = {
        schema_version: '2.0.0',
        run_id: 'run-legacy-imported',
        objective: 'Legacy imported plan without modern telemetry',
        status: 'completed',
        imported: true,
        source_path: '.planning/phases/01-legacy/PLAN.md',
      };

      const explanation = explainRun(legacyRecord);
      expect(explanation).toContain('Run run-legacy-imported: Legacy imported plan without modern telemetry');
      expect(explanation).toContain('lane: none');
      expect(explanation).toMatch(/Imported from legacy planning:.*\.planning\/phases\/01-legacy\/PLAN\.md/i);
      // Ensures no undefined or null string representations
      expect(explanation).not.toContain('undefined');
      expect(explanation).not.toContain('null');
    });
  });

  describe('historyAction explain end-to-end integration', () => {
    it('returns structured record alongside formatted explain text', async () => {
      const dir = await mkdtemp(path.join(tmpdir(), 'ape-history-explain-'));
      cleanups.push(dir);
      const paths = runtimePaths(dir);
      const record = createHistoryRecord({ run_id: 'run-explain-e2e' });
      await archiveRun(paths, record);

      const res = await historyAction(dir, 'explain', { run_id: 'run-explain-e2e' });
      expect(res.ok).toBe(true);
      expect(res.record).toBeDefined();
      expect(res.record.run_id).toBe('run-explain-e2e');
      expect(res.text).toBeTypeOf('string');
      expect(res.text).toContain('Run run-explain-e2e:');
      expect(res.text).toContain('Status: completed');
      expect(res.text).toMatch(/Timing|Duration/i);
    });
  });
});
