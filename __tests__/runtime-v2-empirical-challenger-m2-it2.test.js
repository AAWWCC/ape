// __tests__/runtime-v2-empirical-challenger-m2-it2.test.js
import { afterEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { access, chmod, mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { gitFixtureEnv } from '../test-support/git-fixtures.js';
import { runtimePaths } from '../lib/runtime/paths.js';
import { atomicWriteJson, readJson } from '../lib/runtime/storage.js';
import {
  cleanupStagedReceipt,
  cleanupStagedReceipts,
  stagedReceiptPath,
  stageReceiptDraft,
} from '../lib/runtime/receipt-service.js';
import {
  resumeRun,
  startRun,
} from '../lib/runtime/service.js';

const cleanups = [];

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

function git(cwd, ...args) {
  return execFileSync('git', args, { env: gitFixtureEnv(), cwd, encoding: 'utf8' }).trim();
}

async function createRepoFixture() {
  const dir = await mkdtemp(path.join(tmpdir(), 'ape-challenger-m2-it2-'));
  cleanups.push(dir);

  git(dir, 'init', '-q', '-b', 'main');
  git(dir, 'config', 'user.email', 'ape-challenger@example.invalid');
  git(dir, 'config', 'user.name', 'APE Challenger');
  git(dir, 'config', 'core.autocrlf', 'false');

  await writeFile(path.join(dir, '.gitignore'), '.ape/\n.env\n');
  await writeFile(path.join(dir, 'README.md'), '# Initial Documentation\n');
  git(dir, 'add', '.');
  git(dir, 'commit', '-qm', 'initial baseline');

  const paths = runtimePaths(dir);
  await atomicWriteJson(paths.config, {
    version: 1,
    shipping: { auto_merge: false, required_remote_checks: false },
    test_commands: {
      full: 'node -e "process.exit(0)"',
      targeted_template: 'node -e "process.exit(0)"',
    },
  });

  return { dir, paths };
}

describe('Challenger M2 it2: Empirical Edge Case Stress-Testing of Single-Step Resume Staged Receipt Cleanup', () => {
  describe('Dimension 1: Edge cases in state.tickets (empty, missing, corrupt)', () => {
    it('resumes cleanly when state.tickets is an empty array', async () => {
      const { dir, paths } = await createRepoFixture();

      const startResult = await startRun(dir, {
        objective: 'Test empty tickets array in single-step resume',
        mode: 'phase',
        lane: 'mechanical',
        host: 'claude',
        behavioral: false,
        claimed_paths: ['README.md', 'docs/empty-tickets.md'],
        test_paths: [],
        requirements: [],
        risk_triggers: [],
        hooks_trusted: true,
        subagents_available: true,
        explicit_invocation: true,
      });
      expect(startResult.ok).toBe(true);

      const state = await readJson(paths.active);
      state.status = 'blocked';
      state.stage = 'build';
      state.block_reason = 'Empty tickets blocked test';
      state.tickets = []; // Force empty array (schema-valid)

      await atomicWriteJson(paths.active, state);
      await atomicWriteJson(path.join(paths.runs, `${state.run_id}.json`), state);

      // Create edits to allow checkpoint capture
      await mkdir(path.join(dir, 'docs'), { recursive: true });
      await writeFile(path.join(dir, 'docs/empty-tickets.md'), '# Edits\n');

      // Place a stray staged receipt in staging dir
      const stagingDir = paths.receiptsStaging ?? path.join(paths.receipts, 'staging');
      await mkdir(stagingDir, { recursive: true });
      const strayFile = path.join(stagingDir, 'stray-ticket.json');
      await writeFile(strayFile, JSON.stringify({ ticket_id: 'stray-ticket' }), 'utf8');

      const resumeResult = await resumeRun(dir, { explicit_invocation: true });
      expect(resumeResult.ok).toBe(true);
      expect(resumeResult.run).toBeDefined();
      expect(resumeResult.run.run_id).toBeDefined();

      // Because state.tickets was empty, targeted cleanup skips and stray file is untouched
      expect(await readJson(strayFile, null)).toBeTruthy();
    });

    it('resumes cleanly when state.tickets is missing / undefined', async () => {
      const { dir, paths } = await createRepoFixture();

      const startResult = await startRun(dir, {
        objective: 'Test missing tickets in single-step resume',
        mode: 'phase',
        lane: 'mechanical',
        host: 'claude',
        behavioral: false,
        claimed_paths: ['README.md', 'docs/missing-tickets.md'],
        test_paths: [],
        requirements: [],
        risk_triggers: [],
        hooks_trusted: true,
        subagents_available: true,
        explicit_invocation: true,
      });
      expect(startResult.ok).toBe(true);

      const state = await readJson(paths.active);
      state.status = 'blocked';
      state.stage = 'build';
      state.block_reason = 'Missing tickets blocked test';
      delete state.tickets; // Undefined tickets (schema-valid)

      await atomicWriteJson(paths.active, state);
      await atomicWriteJson(path.join(paths.runs, `${state.run_id}.json`), state);

      await mkdir(path.join(dir, 'docs'), { recursive: true });
      await writeFile(path.join(dir, 'docs/missing-tickets.md'), '# Edits\n');

      const resumeResult = await resumeRun(dir, { explicit_invocation: true });
      expect(resumeResult.ok).toBe(true);
      expect(resumeResult.run).toBeDefined();
      expect(resumeResult.run.run_id).toBeDefined();
    });

    it('fails fast at activeState schema validation when state.tickets is null or corrupt non-array type', async () => {
      const { dir, paths } = await createRepoFixture();

      const startResult = await startRun(dir, {
        objective: 'Test corrupt tickets type rejection',
        mode: 'phase',
        lane: 'mechanical',
        host: 'claude',
        behavioral: false,
        claimed_paths: ['README.md', 'docs/null-tickets.md'],
        test_paths: [],
        requirements: [],
        risk_triggers: [],
        hooks_trusted: true,
        subagents_available: true,
        explicit_invocation: true,
      });
      expect(startResult.ok).toBe(true);

      const state = await readJson(paths.active);
      state.status = 'blocked';
      state.stage = 'build';
      state.block_reason = 'Corrupt tickets type test';
      state.tickets = null; // null tickets is schema-invalid

      await atomicWriteJson(paths.active, state);
      await atomicWriteJson(path.join(paths.runs, `${state.run_id}.json`), state);

      await mkdir(path.join(dir, 'docs'), { recursive: true });
      await writeFile(path.join(dir, 'docs/null-tickets.md'), '# Edits\n');

      // Invariant: activeState protects the runtime from schema corruption
      await expect(resumeRun(dir, { explicit_invocation: true })).rejects.toThrow(/schema-invalid/);
    });

    it('fails fast at activeState schema validation when state.tickets contains malformed elements', async () => {
      const { dir, paths } = await createRepoFixture();

      const startResult = await startRun(dir, {
        objective: 'Test corrupt elements inside tickets array',
        mode: 'phase',
        lane: 'mechanical',
        host: 'claude',
        behavioral: false,
        claimed_paths: ['README.md', 'docs/corrupt-elements.md'],
        test_paths: [],
        requirements: [],
        risk_triggers: [],
        hooks_trusted: true,
        subagents_available: true,
        explicit_invocation: true,
      });
      expect(startResult.ok).toBe(true);

      const state = await readJson(paths.active);
      state.status = 'blocked';
      state.stage = 'build';
      state.block_reason = 'Corrupt elements blocked test';
      state.tickets = [null, 12345, { invalid: true }];

      await atomicWriteJson(paths.active, state);
      await atomicWriteJson(path.join(paths.runs, `${state.run_id}.json`), state);

      await mkdir(path.join(dir, 'docs'), { recursive: true });
      await writeFile(path.join(dir, 'docs/corrupt-elements.md'), '# Edits\n');

      await expect(resumeRun(dir, { explicit_invocation: true })).rejects.toThrow(/schema-invalid/);
    });

    it('cleanupStagedReceipts safely ignores corrupt array elements and cleans up valid tickets', async () => {
      const { paths } = await createRepoFixture();
      const stagingDir = paths.receiptsStaging ?? path.join(paths.receipts, 'staging');
      await mkdir(stagingDir, { recursive: true });

      const validFile = path.join(stagingDir, 'valid-ticket-1.json');
      await writeFile(validFile, JSON.stringify({ ticket_id: 'valid-ticket-1', status: 'passed' }), 'utf8');

      // Call cleanupStagedReceipts directly with an array containing mixed corrupt values and the valid ticket
      const mixedTickets = [
        null,
        undefined,
        12345,
        {},
        { ticket_id: null },
        { ticket_id: '' },
        { ticket_id: 'valid-ticket-1' },
      ];

      await cleanupStagedReceipts(paths, mixedTickets);

      // The valid ticket must be removed, corrupt entries must not throw
      await expect(access(validFile)).rejects.toThrow();
    });
  });

  describe('Dimension 2: Multiple tickets in staging directory', () => {
    it('cleans up multiple staged receipts when superseded run had multiple tickets', async () => {
      const { dir, paths } = await createRepoFixture();

      const startResult = await startRun(dir, {
        objective: 'Test multiple tickets staged receipt cleanup',
        mode: 'phase',
        lane: 'mechanical',
        host: 'claude',
        behavioral: false,
        claimed_paths: ['README.md', 'docs/multi.md'],
        test_paths: [],
        requirements: [],
        risk_triggers: [],
        hooks_trusted: true,
        subagents_available: true,
        explicit_invocation: true,
      });
      expect(startResult.ok).toBe(true);

      const state = await readJson(paths.active);
      const ticket1 = state.tickets[0];

      // Simulate a multi-ticket run by synthesizing 3 tickets in state
      const ticket2 = { ...ticket1, ticket_id: `${state.run_id}:build:ticket-2` };
      const ticket3 = { ...ticket1, ticket_id: `${state.run_id}:build:ticket-3` };
      state.tickets = [ticket1, ticket2, ticket3];

      // Stage drafts for all 3 tickets
      const file1 = stagedReceiptPath(paths, ticket1.ticket_id);
      const file2 = stagedReceiptPath(paths, ticket2.ticket_id);
      const file3 = stagedReceiptPath(paths, ticket3.ticket_id);

      await stageReceiptDraft(paths, ticket1, { ticket_id: ticket1.ticket_id, status: 'passed' });
      await stageReceiptDraft(paths, ticket2, { ticket_id: ticket2.ticket_id, status: 'passed' });
      await stageReceiptDraft(paths, ticket3, { ticket_id: ticket3.ticket_id, status: 'passed' });

      expect(await readJson(file1, null)).toBeTruthy();
      expect(await readJson(file2, null)).toBeTruthy();
      expect(await readJson(file3, null)).toBeTruthy();

      state.status = 'blocked';
      state.stage = 'build';
      state.block_reason = 'Multiple tickets blocked run';

      await atomicWriteJson(paths.active, state);
      await atomicWriteJson(path.join(paths.runs, `${state.run_id}.json`), state);

      await mkdir(path.join(dir, 'docs'), { recursive: true });
      await writeFile(path.join(dir, 'docs/multi.md'), '# Edits\n');

      const resumeResult = await resumeRun(dir, { explicit_invocation: true });
      expect(resumeResult.ok).toBe(true);

      // Invariant: ALL 3 staged receipt files must be purged
      await expect(access(file1)).rejects.toThrow();
      await expect(access(file2)).rejects.toThrow();
      await expect(access(file3)).rejects.toThrow();
    });

    it('preserves unrelated staged receipts belonging to other tickets while cleaning superseded run tickets', async () => {
      const { dir, paths } = await createRepoFixture();

      const startResult = await startRun(dir, {
        objective: 'Test isolation of foreign staged receipts',
        mode: 'phase',
        lane: 'mechanical',
        host: 'claude',
        behavioral: false,
        claimed_paths: ['README.md', 'docs/isolation.md'],
        test_paths: [],
        requirements: [],
        risk_triggers: [],
        hooks_trusted: true,
        subagents_available: true,
        explicit_invocation: true,
      });
      expect(startResult.ok).toBe(true);

      const state = await readJson(paths.active);
      const ticket = state.tickets[0];

      // Stage draft for this run's ticket
      const runFile = stagedReceiptPath(paths, ticket.ticket_id);
      await stageReceiptDraft(paths, ticket, { ticket_id: ticket.ticket_id, status: 'passed' });

      // Create an unrelated foreign staged receipt file
      const foreignTicketId = 'foreign-run:stage:ticket-99';
      const foreignFile = stagedReceiptPath(paths, foreignTicketId);
      await atomicWriteJson(foreignFile, { ticket_id: foreignTicketId, status: 'passed' });

      expect(await readJson(runFile, null)).toBeTruthy();
      expect(await readJson(foreignFile, null)).toBeTruthy();

      state.status = 'blocked';
      state.stage = 'build';
      state.block_reason = 'Foreign isolation blocked run';

      await atomicWriteJson(paths.active, state);
      await atomicWriteJson(path.join(paths.runs, `${state.run_id}.json`), state);

      await mkdir(path.join(dir, 'docs'), { recursive: true });
      await writeFile(path.join(dir, 'docs/isolation.md'), '# Edits\n');

      const resumeResult = await resumeRun(dir, { explicit_invocation: true });
      expect(resumeResult.ok).toBe(true);

      // Run's file is wiped, foreign file is preserved
      await expect(access(runFile)).rejects.toThrow();
      expect(await readJson(foreignFile, null)).toBeTruthy();
    });

    it('scales to 30 staged tickets cleaned up simultaneously during single-step resume', async () => {
      const { dir, paths } = await createRepoFixture();

      const startResult = await startRun(dir, {
        objective: 'Test scale cleanup of 30 tickets',
        mode: 'phase',
        lane: 'mechanical',
        host: 'claude',
        behavioral: false,
        claimed_paths: ['README.md', 'docs/scale.md'],
        test_paths: [],
        requirements: [],
        risk_triggers: [],
        hooks_trusted: true,
        subagents_available: true,
        explicit_invocation: true,
      });
      expect(startResult.ok).toBe(true);

      const state = await readJson(paths.active);
      const baseTicket = state.tickets[0];

      // Synthesize 30 tickets
      const tickets = Array.from({ length: 30 }, (_, i) => ({
        ...baseTicket,
        ticket_id: `${state.run_id}:build:ticket-scale-${i}`,
      }));
      state.tickets = tickets;

      // Stage drafts for all 30
      const files = await Promise.all(
        tickets.map(async (t) => {
          const f = stagedReceiptPath(paths, t.ticket_id);
          await stageReceiptDraft(paths, t, { ticket_id: t.ticket_id, status: 'passed', index: t.ticket_id });
          return f;
        }),
      );

      // Verify all exist
      for (const f of files) {
        expect(await readJson(f, null)).toBeTruthy();
      }

      state.status = 'blocked';
      state.stage = 'build';
      state.block_reason = 'Scale test blocked';

      await atomicWriteJson(paths.active, state);
      await atomicWriteJson(path.join(paths.runs, `${state.run_id}.json`), state);

      await mkdir(path.join(dir, 'docs'), { recursive: true });
      await writeFile(path.join(dir, 'docs/scale.md'), '# Edits\n');

      const resumeResult = await resumeRun(dir, { explicit_invocation: true });
      expect(resumeResult.ok).toBe(true);

      // All 30 files must be unlinked
      for (const f of files) {
        await expect(access(f)).rejects.toThrow();
      }
    });
  });

  describe('Dimension 3: cleanupStagedReceipts direct API resilience', () => {
    it('cleanupStagedReceipts with empty array or default wipes whole staging directory', async () => {
      const { paths } = await createRepoFixture();
      const stagingDir = paths.receiptsStaging ?? path.join(paths.receipts, 'staging');
      await mkdir(stagingDir, { recursive: true });

      await writeFile(path.join(stagingDir, 't1.json'), '{}');
      await writeFile(path.join(stagingDir, 't2.json'), '{}');

      // With empty array, it wipes the staging directory
      await cleanupStagedReceipts(paths, []);
      await expect(access(path.join(stagingDir, 't1.json'))).rejects.toThrow();
      await expect(access(path.join(stagingDir, 't2.json'))).rejects.toThrow();
    });

    it('cleanupStagedReceipts accepts string tickets array as well as objects', async () => {
      const { paths } = await createRepoFixture();
      const stagingDir = paths.receiptsStaging ?? path.join(paths.receipts, 'staging');
      await mkdir(stagingDir, { recursive: true });

      const fileA = path.join(stagingDir, 'ticket-a.json');
      const fileB = path.join(stagingDir, 'ticket-b.json');
      await writeFile(fileA, '{}');
      await writeFile(fileB, '{}');

      // Mix string ID and object { ticket_id }
      await cleanupStagedReceipts(paths, ['ticket-a', { ticket_id: 'ticket-b' }]);

      await expect(access(fileA)).rejects.toThrow();
      await expect(access(fileB)).rejects.toThrow();
    });

    it('cleanupStagedReceipt ignores non-string ticket IDs safely', async () => {
      const { paths } = await createRepoFixture();
      await expect(cleanupStagedReceipt(paths, null)).resolves.toBeUndefined();
      await expect(cleanupStagedReceipt(paths, undefined)).resolves.toBeUndefined();
      await expect(cleanupStagedReceipt(paths, 123)).resolves.toBeUndefined();
      await expect(cleanupStagedReceipt(paths, {})).resolves.toBeUndefined();
      await expect(cleanupStagedReceipt(paths, [])).resolves.toBeUndefined();
      await expect(cleanupStagedReceipt(paths, '')).resolves.toBeUndefined();
    });
  });
});
