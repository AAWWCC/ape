import { gunzipSync } from 'node:zlib';
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { sha256 } from '../lib/runtime/canonical.js';
import { runtimePaths } from '../lib/runtime/paths.js';
import { archiveRun } from '../lib/runtime/history.js';
import { projectHistoryResponse } from '../lib/runtime/projection.js';
import {
  compactArchivedArtifacts,
  recordArtifactRetentionStatus,
} from '../lib/runtime/retention.js';
import { historyAction } from '../lib/runtime/service.js';
import { atomicWriteJson } from '../lib/runtime/storage.js';
import { acquireRunLock, releaseRunLock } from '../lib/runtime/lock.js';

const cleanups = [];
afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function fixturePaths() {
  const root = await mkdtemp(path.join(tmpdir(), 'ape-retention-'));
  cleanups.push(root);
  return runtimePaths(root);
}

function terminalRun(runId, completedAt) {
  return {
    run_id: runId,
    objective: `objective ${runId}`,
    mode: 'phase',
    lane: 'fast',
    requirements: [],
    status: 'completed',
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: completedAt,
    terminal_at: completedAt,
    base_commit_sha: 'a'.repeat(40),
    tree_sha: 'b'.repeat(40),
    tickets: [],
    receipts: [],
  };
}

async function redundantArtifacts(paths, runId, suffix) {
  await Promise.all([
    mkdir(paths.runs, { recursive: true }),
    mkdir(paths.tickets, { recursive: true }),
    mkdir(paths.receipts, { recursive: true }),
    mkdir(paths.receiptTransactions, { recursive: true }),
  ]);
  const ticketId = `${runId}:build:${suffix}`;
  const receiptId = `receipt-${suffix}`;
  const files = {
    run: path.join(paths.runs, `${runId}.json`),
    ticket: path.join(paths.tickets, `${runId}_build_${suffix}.json`),
    receipt: path.join(paths.receipts, `${receiptId}.json`),
    transaction: path.join(paths.receiptTransactions, `${suffix}.json`),
    prepared: path.join(paths.receiptTransactions, `${suffix}-prepared.json`),
  };
  await atomicWriteJson(files.run, { run_id: runId, status: 'completed', detail: 'x'.repeat(4000) });
  await atomicWriteJson(files.ticket, { run_id: runId, ticket_id: ticketId, detail: 'x'.repeat(4000) });
  await atomicWriteJson(files.receipt, { run_id: runId, ticket_id: ticketId, receipt_id: receiptId, detail: 'x'.repeat(4000) });
  await atomicWriteJson(files.transaction, { version: 1, run_id: runId, ticket_id: ticketId, status: 'committed', receipt: { receipt_id: receiptId } });
  await atomicWriteJson(files.prepared, { version: 1, run_id: runId, ticket_id: ticketId, status: 'prepared' });
  return files;
}

describe('archived artifact retention', () => {
  it('keeps compacted history plan references resolvable through record.approved_plan', async () => {
    const paths = await fixturePaths();
    const runId = 'run-retention-approved-plan';
    const plan = {
      version: 1,
      requirements: [{ id: 'R1', requirement: 'Keep history plan references live', workstreams: ['W1'] }],
      workstreams: [{
        id: 'W1',
        outcome: 'Resolve every duplicate through the immutable history response',
        paths: [{ path: 'src/value.js', action: 'modify' }],
        steps: ['Project the archived record'],
        acceptance: ['The full approved plan remains available after artifact compaction'],
        evidence_commands: ['node --test'],
      }],
      risks: [],
      non_goals: [],
    };
    const planHash = sha256(plan);
    const candidatePlan = { plan_hash: planHash, plan };
    const approvedPlan = {
      version: 1,
      plan_hash: planHash,
      approval_route: 'unanimous',
      reviewer_receipt_hashes: ['b'.repeat(64), 'c'.repeat(64)],
      plan,
    };
    const ticket = {
      run_id: runId,
      ticket_id: `${runId}:build:plan`,
      candidate_plan: candidatePlan,
    };
    const archived = await archiveRun(paths, {
      ...terminalRun(runId, '2026-01-01T00:01:00.000Z'),
      lane: 'full',
      plan_contract_version: 1,
      approved_plan: approvedPlan,
      tickets: [ticket],
    });
    const files = await redundantArtifacts(paths, runId, 'plan');
    await atomicWriteJson(files.ticket, ticket);

    const compacted = await compactArchivedArtifacts(paths, {
      keepRecentRuns: 0,
      maxRunsPerSweep: 1,
    });
    expect(compacted).toMatchObject({ compacted_runs: 1, removed_files: 4 });
    await expect(readFile(files.ticket)).rejects.toMatchObject({ code: 'ENOENT' });

    const explained = await historyAction(paths.root, 'explain', { run_id: runId });
    const projected = projectHistoryResponse(explained);
    expect(projected.record.approved_plan).toEqual(approvedPlan);
    expect(projected.record.tickets[0].candidate_plan).toEqual({
      plan_hash: planHash,
      ticket_id: ticket.ticket_id,
      plan_ref: 'record.approved_plan',
    });
    expect(projected.record.tickets[0].candidate_plan).not.toHaveProperty('plan');
    expect(explained.record.tickets[0].candidate_plan).toEqual(candidatePlan);
    expect(explained.record.record_hash).toBe(archived.record_hash);
  });

  it('archives byte-exact redundant artifacts before removing them and preserves history/audit', async () => {
    const paths = await fixturePaths();
    const oldId = 'run-retention-old';
    const newId = 'run-retention-new';
    await archiveRun(paths, terminalRun(oldId, '2026-01-01T00:01:00.000Z'));
    await archiveRun(paths, terminalRun(newId, '2026-01-02T00:01:00.000Z'));
    const oldFiles = await redundantArtifacts(paths, oldId, 'old');
    const newFiles = await redundantArtifacts(paths, newId, 'new');
    const oldBytes = await readFile(oldFiles.run);

    const result = await compactArchivedArtifacts(paths, { keepRecentRuns: 1, maxRunsPerSweep: 10 });

    expect(result).toMatchObject({ compacted_runs: 1, removed_files: 4, retained_changed_files: 0 });
    for (const file of [oldFiles.run, oldFiles.ticket, oldFiles.receipt, oldFiles.transaction]) {
      await expect(readFile(file)).rejects.toMatchObject({ code: 'ENOENT' });
    }
    await expect(readFile(oldFiles.prepared, 'utf8')).resolves.toContain('prepared');
    await expect(readFile(newFiles.run, 'utf8')).resolves.toContain(newId);
    await expect(readFile(path.join(paths.history, `${oldId}.json`), 'utf8')).resolves.toContain(oldId);

    const archiveBytes = gunzipSync(
      await readFile(path.join(paths.runtime, 'artifact-archives', `${oldId}.json.gz`)),
    );
    const separator = archiveBytes.indexOf(0x0a);
    const archive = JSON.parse(archiveBytes.subarray(0, separator).toString('utf8'));
    const archiveBody = archiveBytes.subarray(separator + 1);
    const archivedRun = archive.artifacts.find((artifact) => artifact.kind === 'run');
    expect(Buffer.compare(
      archiveBody.subarray(archivedRun.offset, archivedRun.offset + archivedRun.bytes),
      oldBytes,
    )).toBe(0);
    const audit = await readFile(paths.overrideLog, 'utf8');
    expect(audit).toContain('"operation":"artifact-retention"');
    expect(audit).toContain('"phase":"planned"');
    expect(audit).toContain('"phase":"completed"');
    if (process.platform !== 'win32') {
      const mode = (await stat(path.join(paths.runtime, 'artifact-archives', `${oldId}.json.gz`))).mode & 0o777;
      expect(mode).toBe(0o600);
    }

    const auditBeforeRetry = await readFile(paths.overrideLog, 'utf8');
    const retried = await compactArchivedArtifacts(paths, { keepRecentRuns: 1, maxRunsPerSweep: 10 });
    expect(retried).toMatchObject({ compacted_runs: 0, removed_files: 0 });
    expect(await readFile(paths.overrideLog, 'utf8')).toBe(auditBeforeRetry);
  });

  it('never compacts the active or sealed current run even when it is oldest', async () => {
    const paths = await fixturePaths();
    const activeId = 'run-retention-active';
    const otherId = 'run-retention-other';
    const active = terminalRun(activeId, '2026-01-01T00:01:00.000Z');
    await archiveRun(paths, active);
    await archiveRun(paths, terminalRun(otherId, '2026-01-02T00:01:00.000Z'));
    const activeFiles = await redundantArtifacts(paths, activeId, 'active');
    await redundantArtifacts(paths, otherId, 'other');
    await atomicWriteJson(paths.active, active);

    const result = await compactArchivedArtifacts(paths, { keepRecentRuns: 0, maxRunsPerSweep: 10 });

    expect(result.compacted_runs).toBe(1);
    await expect(readFile(activeFiles.run, 'utf8')).resolves.toContain(activeId);
    await expect(readFile(path.join(paths.runtime, 'artifact-archives', `${activeId}.json.gz`))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('fails closed on unreadable active state and preserves every artifact', async () => {
    const paths = await fixturePaths();
    const runId = 'run-retention-corrupt';
    await archiveRun(paths, terminalRun(runId, '2026-01-01T00:01:00.000Z'));
    const files = await redundantArtifacts(paths, runId, 'corrupt');
    await mkdir(path.dirname(paths.active), { recursive: true });
    await writeFile(paths.active, '{not json', 'utf8');

    const result = await compactArchivedArtifacts(paths, { keepRecentRuns: 0 });

    expect(result.skipped).toBe('current-run-state-unreadable');
    await expect(readFile(files.run, 'utf8')).resolves.toContain(runId);
  });

  it('retains an artifact whose bytes changed after its verified archive was written', async () => {
    const paths = await fixturePaths();
    const runId = 'run-retention-changed';
    await archiveRun(paths, terminalRun(runId, '2026-01-01T00:01:00.000Z'));
    const files = await redundantArtifacts(paths, runId, 'changed');
    const first = await compactArchivedArtifacts(paths, { keepRecentRuns: 0 });
    expect(first.removed_files).toBe(4);
    await atomicWriteJson(files.run, { run_id: runId, changed_after_archive: true });

    const second = await compactArchivedArtifacts(paths, { keepRecentRuns: 0 });

    expect(second).toMatchObject({ compacted_runs: 0, removed_files: 0 });
    await expect(readFile(files.run, 'utf8')).resolves.toContain('changed_after_archive');
  });

  it('compacts beyond the keep window while a sealed current run lock is held', async () => {
    const paths = await fixturePaths();
    const currentId = 'run-retention-held-00';
    for (let index = 0; index < 34; index += 1) {
      const runId = `run-retention-held-${String(index).padStart(2, '0')}`;
      await archiveRun(
        paths,
        terminalRun(runId, `2026-01-01T00:${String(index).padStart(2, '0')}:00.000Z`),
      );
    }
    const currentFiles = await redundantArtifacts(paths, currentId, 'held-current');
    const eligibleId = 'run-retention-held-01';
    const eligibleFiles = await redundantArtifacts(paths, eligibleId, 'held-eligible');
    await atomicWriteJson(paths.active, terminalRun(currentId, '2026-01-01T00:01:00.000Z'));
    await acquireRunLock(paths.lock, currentId);
    try {
      const result = await compactArchivedArtifacts(paths, { keepRecentRuns: 32, maxRunsPerSweep: 10 });
      expect(result.compacted_runs).toBe(1);
      await expect(readFile(currentFiles.run, 'utf8')).resolves.toContain(currentId);
      await expect(readFile(eligibleFiles.run)).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      await releaseRunLock(paths.lock, currentId);
    }
  });

  it('isolates a corrupt archive and still compacts a later eligible run', async () => {
    const paths = await fixturePaths();
    const corruptId = 'run-retention-corrupt-archive';
    const laterId = 'run-retention-after-corrupt';
    await archiveRun(paths, terminalRun(corruptId, '2026-01-03T00:01:00.000Z'));
    await archiveRun(paths, terminalRun(laterId, '2026-01-02T00:01:00.000Z'));
    const corruptFiles = await redundantArtifacts(paths, corruptId, 'corrupt-archive');
    const laterFiles = await redundantArtifacts(paths, laterId, 'after-corrupt');

    // Produce a valid archive for the newest candidate, then recreate its
    // byte-identical redundant sources and corrupt only the archive. The next
    // sweep must retain those sources, report the isolated failure, and use
    // its successful-compaction allowance on the older run instead.
    const seeded = await compactArchivedArtifacts(paths, { keepRecentRuns: 0, maxRunsPerSweep: 1 });
    expect(seeded.compacted_runs).toBe(1);
    await redundantArtifacts(paths, corruptId, 'corrupt-archive');
    await writeFile(
      path.join(paths.runtime, 'artifact-archives', `${corruptId}.json.gz`),
      'not-a-gzip-archive',
      'utf8',
    );

    const result = await compactArchivedArtifacts(paths, { keepRecentRuns: 0, maxRunsPerSweep: 1 });

    expect(result).toMatchObject({ compacted_runs: 1, attempted_runs: 2 });
    expect(result.failures).toEqual([
      expect.objectContaining({ run_id: corruptId, reason: expect.any(String) }),
    ]);
    await expect(readFile(corruptFiles.run, 'utf8')).resolves.toContain(corruptId);
    await expect(readFile(laterFiles.run)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('exposes an audited bounded compact-artifacts maintenance action and latest status', async () => {
    const paths = await fixturePaths();
    const runId = 'run-retention-manual';
    await archiveRun(paths, terminalRun(runId, '2026-01-01T00:01:00.000Z'));
    const files = await redundantArtifacts(paths, runId, 'manual');

    const response = await historyAction(paths.root, 'compact-artifacts', {
      reason: 'operator-approved bounded storage maintenance',
      keep_recent_runs: 0,
      max_runs: 1,
    });

    expect(response).toMatchObject({
      ok: true,
      maintenance: {
        trigger: 'manual',
        healthy: true,
        compacted_runs: 1,
        removed_files: 4,
        failures: [],
      },
      warnings: [],
    });
    await expect(readFile(files.run)).rejects.toMatchObject({ code: 'ENOENT' });
    const persisted = JSON.parse(await readFile(paths.artifactRetentionStatus, 'utf8'));
    expect(persisted).toMatchObject(response.maintenance);
    await expect(historyAction(paths.root, 'maintenance-status', {})).resolves.toEqual({
      ok: true,
      maintenance: persisted,
    });
    const audit = await readFile(paths.overrideLog, 'utf8');
    expect(audit).toContain('"operation":"artifact-retention-maintenance"');
    expect(audit).toContain('"phase":"requested"');
    expect(audit).toContain('"phase":"completed"');
    expect(audit).toContain('operator-approved bounded storage maintenance');
  });

  it('refuses unaudited or over-broad explicit retention before touching artifacts', async () => {
    const paths = await fixturePaths();
    const runId = 'run-retention-refused';
    await archiveRun(paths, terminalRun(runId, '2026-01-01T00:01:00.000Z'));
    const files = await redundantArtifacts(paths, runId, 'refused');

    await expect(historyAction(paths.root, 'compact-artifacts', {
      keep_recent_runs: 0,
      max_runs: 1,
    })).rejects.toThrow(/audit reason/);
    await expect(historyAction(paths.root, 'compact-artifacts', {
      reason: 'too broad',
      keep_recent_runs: 0,
      max_runs: 257,
    })).rejects.toThrow(/between 1 and 256/);
    await expect(readFile(files.run, 'utf8')).resolves.toContain(runId);
    await expect(readFile(paths.overrideLog)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('publicly surfaces a bounded automatic-maintenance failure without running a sweep', async () => {
    const paths = await fixturePaths();
    await expect(historyAction(paths.root, 'maintenance-status', {})).resolves.toEqual({
      ok: true,
      maintenance: null,
    });
    const error = Object.assign(new Error(`automatic failure ${'x'.repeat(5_000)}`), {
      code: 'E_AUTOMATIC_RETENTION',
    });
    await recordArtifactRetentionStatus(paths, { trigger: 'automatic', error });

    const response = await historyAction(paths.root, 'maintenance-status', {});

    expect(response).toMatchObject({
      ok: true,
      maintenance: {
        trigger: 'automatic',
        healthy: false,
        compacted_runs: 0,
        failures: [{ code: 'E_AUTOMATIC_RETENTION' }],
      },
    });
    expect(response.maintenance.failures[0].reason.length).toBe(320);
  });
});
