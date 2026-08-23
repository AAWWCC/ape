import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
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
    host: 'codex',
    status: 'completed',
    stage: 'completed',
    dispatch_state: 'none',
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
        stage_id: 'build',
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
        timing: {
          started_at: '2026-08-01T12:00:00.000Z',
          completed_at: '2026-08-01T12:00:01.200Z',
          duration_ms: 1200,
        },
      },
      {
        receipt_id: 'r-impl',
        ticket_id: 'run-explain-sample:implementer:1',
        status: 'passed',
        timing: {
          started_at: '2026-08-01T12:00:01.200Z',
          completed_at: '2026-08-01T12:00:04.600Z',
          duration_ms: 3400,
        },
      },
    ],
    merge: {
      provider: 'github',
      url: 'https://github.com/acme/repo/pull/42',
      branch: 'ape/phase-explain',
      base: 'main',
      merged_at: '2026-08-01T12:05:00.000Z',
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
      expect(explanation).toContain('Run run-explain-sample');
      expect(explanation).not.toContain('Implement rich history explanation and lifecycle telemetry');
      expect(explanation).toContain('Status: completed; lane: fast; mode: phase.');
      expect(explanation).toContain('Reason code: completed');
      expect(explanation).toContain('Next safe action: ape_run start');
      expect(explanation).toContain('Agents: 2 passed receipts, 0 non-passing receipts.');
      expect(explanation).toContain('Merged:');
      expect(explanation).not.toContain('github.com/acme/repo');
      // Rich telemetry lines required by R2 / W4
      expect(explanation).toMatch(/Tier(s)?:.*balanced/i);
      expect(explanation).toMatch(/Timing|Duration:.*5m|300s|300000ms/i);
      expect(explanation).toMatch(/Gates?:.*passed/i);
    });

    it('formats a blocked run with blocker cause and remediation facts', () => {
      const record = createHistoryRecord({
        status: 'blocked',
        stage: 'review',
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
      expect(explanation).toContain('Reason code: blocked');
      expect(explanation).toContain('Next safe action: ape_run abort or ape_run override reset');
      expect(explanation).not.toContain('deterministic test gate failed: 1 failure in test suite');
      expect(explanation).toMatch(/Remediation route:.*test/i);
      expect(explanation).not.toContain('tests/calc.test.js');
    });

    it('formats an aborted run with abort reason and operator attribution', () => {
      const record = createHistoryRecord({
        status: 'aborted',
        stage: 'aborted',
        abort_reason: 'operator requested abort via ape_run override',
        merge: null,
      });

      const explanation = explainRun(record);
      expect(explanation).toContain('Status: aborted');
      expect(explanation).toContain('Reason code: aborted');
      expect(explanation).not.toContain('operator requested abort via ape_run override');
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
      expect(explanation).toContain('Run run-legacy-imported');
      expect(explanation).not.toContain('Legacy imported plan without modern telemetry');
      expect(explanation).toContain('lane: none');
      expect(explanation).toContain('Reason code: legacy_record');
      expect(explanation).not.toContain('.planning/phases/01-legacy/PLAN.md');
      // Ensures no undefined or null string representations
      expect(explanation).not.toContain('undefined');
      expect(explanation).not.toContain('null');
    });
  });

  describe('historyAction explain end-to-end integration', () => {
    it('does not disclose repository URLs or embedded credentials from merge provenance', async () => {
      const sentinelUrl = 'https://PRIVATE_USER:PRIVATE_PASSWORD@example.test/PRIVATE_ORG/PRIVATE_REPO/pull/42';
      const explanation = explainRun(createHistoryRecord({
        run_id: 'run-private-merge-url',
        merge: {
          provider: 'github',
          url: sentinelUrl,
          branch: 'ape/phase-private',
          base: 'main',
          merged_at: '2026-08-01T12:05:00.000Z',
        },
      }));

      expect(explanation).toContain('Merged:');
      for (const secret of [sentinelUrl, 'PRIVATE_USER', 'PRIVATE_PASSWORD', 'PRIVATE_ORG', 'PRIVATE_REPO']) {
        expect(explanation).not.toContain(secret);
      }
    });

    it.each([
      ['array', []],
      ['empty object', {}],
      ['non-string url', { url: { private: 'PRIVATE_MERGE_SENTINEL' } }],
      ['empty url', { url: '' }],
      ['unknown provider', {
        provider: 'PRIVATE_MERGE_PROVIDER',
        url: 'https://example.test/pull/1',
        branch: 'ape/phase-example',
        base: 'main',
        merged_at: '2026-08-01T12:05:00.000Z',
      }],
      ['missing provider', {
        url: 'https://example.test/pull/1',
        branch: 'ape/phase-example',
        base: 'main',
        merged_at: '2026-08-01T12:05:00.000Z',
      }],
      ['missing merged timestamp', {
        provider: 'github',
        url: 'https://example.test/pull/1',
        branch: 'ape/phase-example',
        base: 'main',
      }],
      ['non-ISO merged timestamp', {
        provider: 'github',
        url: 'https://example.test/pull/1',
        branch: 'ape/phase-example',
        base: 'main',
        merged_at: 'August 1, 2026',
      }],
      ['impossible merged timestamp', {
        provider: 'github',
        url: 'https://example.test/pull/1',
        branch: 'ape/phase-example',
        base: 'main',
        merged_at: '2026-02-30T12:05:00.000Z',
      }],
      ['unknown provenance', {
        provider: 'github',
        url: 'https://example.test/pull/1',
        branch: 'ape/phase-example',
        base: 'main',
        merged_at: '2026-08-01T12:05:00.000Z',
        provenance: 'PRIVATE_MERGE_PROVENANCE',
      }],
    ])('does not report malformed %s merge evidence as recorded', (_label, merge) => {
      const explanation = explainRun(createHistoryRecord({
        run_id: 'run-malformed-merge',
        merge,
      }));
      expect(explanation).toContain('Merge: not recorded.');
      expect(explanation).toContain('Reason code: incomplete_record');
      expect(explanation).not.toContain('Merged: recorded.');
      expect(explanation).not.toContain('PRIVATE_MERGE_SENTINEL');
      expect(explanation).not.toContain('PRIVATE_MERGE_PROVIDER');
      expect(explanation).not.toContain('PRIVATE_MERGE_PROVENANCE');
    });

    it('returns a bounded diagnostic projection and leaves the archived bytes untouched', async () => {
      const dir = await mkdtemp(path.join(tmpdir(), 'ape-history-explain-'));
      cleanups.push(dir);
      const paths = runtimePaths(dir);
      const record = createHistoryRecord({ run_id: 'run-explain-e2e' });
      await archiveRun(paths, record);
      const file = path.join(paths.history, 'run-explain-e2e.json');
      const before = await readFile(file, 'utf8');

      const res = await historyAction(dir, 'explain', { run_id: 'run-explain-e2e' });
      expect(res.ok).toBe(true);
      expect(res).not.toHaveProperty('record');
      expect(res.run).toMatchObject({ run_id: 'run-explain-e2e', status: 'completed' });
      expect(res.diagnostic).toMatchObject({
        reason_code: 'completed',
        next_safe_action: 'ape_run start',
      });
      expect(res.text).toBeTypeOf('string');
      expect(res.text).toContain('Run run-explain-e2e');
      expect(res.text).toContain('Status: completed');
      expect(res.text).toMatch(/Timing|Duration/i);
      expect(res.text).not.toContain(record.objective);
      expect(await readFile(file, 'utf8')).toBe(before);
    });

    it('archives and explains real lifecycle provenance instead of fixture-only fields', async () => {
      const dir = await mkdtemp(path.join(tmpdir(), 'ape-history-provenance-'));
      cleanups.push(dir);
      const paths = runtimePaths(dir);
      const runId = 'run-explain-provenance';
      const firstTicket = {
        ticket_id: `${runId}:remediation-test:1`,
        stage_id: 'remediation-test',
        role: 'test_writer',
        model_tier: 'balanced',
        attempt: 1,
      };
      const retryTicket = {
        ...firstTicket,
        ticket_id: `${runId}:remediation-test:2`,
        attempt: 2,
      };
      await archiveRun(paths, createHistoryRecord({
        run_id: runId,
        tickets: [firstTicket, retryTicket],
        receipts: [{
          receipt_id: 'r-remediation-retry',
          ticket_id: retryTicket.ticket_id,
          status: 'passed',
        }],
        expired_tickets: [firstTicket.ticket_id],
        remediation_route: {
          route: 'test',
          test_paths: ['tests/calc.test.js'],
          cycle: 1,
        },
        remediation_cycles: 1,
        regate_attempts: 1,
        preflight: {
          answers: [
            { id: 'Q1', answer: 'yes' },
            { id: 'Q2', answer: 'Node 24' },
          ],
        },
      }));

      const res = await historyAction(dir, 'explain', { run_id: runId });
      expect(res).not.toHaveProperty('record');
      expect(res.run).toMatchObject({ run_id: runId, status: 'completed' });
      expect(res.diagnostic.reason_code).toBe('completed');
      expect(res.text).toContain('Dispatch: 2 tickets; 1 receipted; 1 expired; 0 pending.');
      expect(res.text).toContain('Retries: 1');
      expect(res.text).toContain('Expired tickets: 1');
      expect(res.text).toContain('Remediation route: test (cycle 1)');
      expect(res.text).not.toContain('tests/calc.test.js');
      expect(res.text).toContain('Recovery: regate; regate attempts: 1');
      expect(res.text).toContain('Input-hold: answered 2 questions');
    });

    it('explains an archived blocked post-gate merge hold as shipping_hold with ape_run ship', async () => {
      const dir = await mkdtemp(path.join(tmpdir(), 'ape-history-shipping-hold-'));
      cleanups.push(dir);
      const paths = runtimePaths(dir);
      const runId = 'run-archived-shipping-hold';
      await archiveRun(paths, createHistoryRecord({
        run_id: runId,
        status: 'blocked',
        stage: 'merge',
        block_reason: 'all local gates passed; explicit shipping approval required',
        gates: { passed: true, checks: {} },
      }));
      const file = path.join(paths.history, `${runId}.json`);
      const before = await readFile(file, 'utf8');

      const explained = await historyAction(dir, 'explain', { run_id: runId });
      expect(explained.diagnostic).toMatchObject({
        reason_code: 'shipping_hold',
        next_safe_action: 'ape_run ship',
      });
      expect(explained.text).toContain('Reason code: shipping_hold');
      expect(explained.text).toContain('Next safe action: ape_run ship');
      expect(await readFile(file, 'utf8')).toBe(before);
    });

    it('removes merge URL query and fragment credential bytes before archive and history exposure', async () => {
      const dir = await mkdtemp(path.join(tmpdir(), 'ape-history-merge-url-secrets-'));
      cleanups.push(dir);
      const paths = runtimePaths(dir);
      const runId = 'run-merge-url-secrets';
      const objective = 'Preserve this safe immutable objective';
      const querySecret = 'PRIVATE_QUERY_CREDENTIAL';
      const fragmentSecret = 'PRIVATE_FRAGMENT_CREDENTIAL';
      const archived = await archiveRun(paths, createHistoryRecord({
        run_id: runId,
        objective,
        merge: {
          provider: 'github',
          url: `https://github.com/acme/repo/pull/17?access_token=${querySecret}#${fragmentSecret}`,
          branch: 'ape/phase-safe',
          base: 'main',
          merged_at: '2026-08-01T12:05:00.000Z',
        },
      }));
      const persisted = await readFile(path.join(paths.history, `${runId}.json`), 'utf8');
      const raw = await historyAction(dir, 'query', { run_id: runId });
      const rendered = await historyAction(dir, 'explain', { run_id: runId });

      for (const surface of [persisted, JSON.stringify(raw), JSON.stringify(rendered)]) {
        expect(surface).not.toContain(querySecret);
        expect(surface).not.toContain(fragmentSecret);
      }
      expect(archived.objective).toBe(objective);
      expect(persisted).toContain(objective);
      expect(JSON.stringify(raw)).toContain(objective);
    });

    it.each([
      ['branch terminal slash', 'ape/phase-safe/', 'main'],
      ['branch terminal dot', 'ape/phase-safe.', 'main'],
      ['base terminal slash', 'ape/phase-safe', 'release/'],
      ['base terminal dot', 'ape/phase-safe', 'release.'],
    ])('rejects canonical merge refs with %s', async (label, branch, base) => {
      const dir = await mkdtemp(path.join(tmpdir(), 'ape-history-merge-ref-'));
      cleanups.push(dir);
      const archived = await archiveRun(runtimePaths(dir), createHistoryRecord({
        run_id: `run-merge-ref-${label.replaceAll(' ', '-')}`,
        merge: {
          provider: 'github',
          url: 'https://github.com/acme/repo/pull/18',
          branch,
          base,
          merged_at: '2026-08-01T12:05:00.000Z',
        },
      }));
      expect(archived.merge).toBeNull();
      expect(archived.objective).toBe('Implement rich history explanation and lifecycle telemetry');
    });
  });
});
