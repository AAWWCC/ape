import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { hashRecord, sha256 } from '../lib/runtime/canonical.js';
import { projectRunDiagnostic, validatedArchiveSnapshot } from '../lib/runtime/diagnostics.js';
import { queryHistoryPage, calculateProjectMetrics, logicalLineageForRun, archiveRun } from '../lib/runtime/history.js';
import { emptyOrchestrationTelemetry, recordFirstWriterLatency, recordRepairCompleted, validatedOrchestrationTelemetry } from '../lib/runtime/orchestration-telemetry.js';
import { pipelineLimits } from '../lib/runtime/pipeline-limits.js';
import { reduceRun } from '../lib/runtime/reducer.js';
import { assertSafeReceiptInput, INPUT_LIMITS } from '../lib/runtime/input-guard.js';
import { receiptOutputSchemaForTicket, validateReceiptDraft } from '../lib/runtime/receipt-validator.js';
import { RUNTIME_STATE_MAX_DEPTH } from '../lib/runtime/resource-limits.js';
import { runtimePaths } from '../lib/runtime/paths.js';
import { projectHistoryResponse, RESPONSE_BUDGET_BYTES } from '../lib/runtime/projection.js';
import { compactArchivedArtifacts, readArtifactRetentionStatus, recordArtifactRetentionStatus } from '../lib/runtime/retention.js';
import { normalizeRoadmapDeclaration, registerEntries, supersedeEntries } from '../lib/runtime/roadmap.js';
import { validatedTerminalRecoveryFields } from '../lib/runtime/terminal-telemetry.js';
import { finalizeReceipt, LegacyRoadmapFollowupSchema, RoadmapFollowupSchema } from '../lib/runtime/schemas.js';

const cleanups = [];
afterEach(async () => { await Promise.all(cleanups.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'ape-storage-policy-'));
  cleanups.push(root);
  const paths = runtimePaths(root);
  await mkdir(paths.history, { recursive: true });
  return paths;
}
function record(id, extra = {}) {
  const value = { schema_version: '2.0.0', run_id: id, objective: id, mode: 'phase', lane: 'fast', host: 'codex',
    status: 'completed', stage: 'completed', dispatch_state: 'none', tickets: [], receipts: [],
    created_at: '2026-01-01T00:00:00.000Z', completed_at: '2026-02-01T00:00:00.000Z', ...extra };
  return { ...value, record_hash: hashRecord(value, ['record_hash', 'completed_at', 'timing']) };
}
async function seed(paths, count, extra = {}) {
  await Promise.all(Array.from({ length: count }, (_, i) => {
    const id = `run-${String(i).padStart(5, '0')}`;
    return writeFile(path.join(paths.history, `${id}.json`), JSON.stringify(record(id, extra)));
  }));
}
function wire(page) {
  const response = { ok: true, records: page.records, pagination: page.pagination };
  Object.defineProperty(response, 'history_record_cursors', { value: page.record_cursors });
  return projectHistoryResponse(response);
}

describe('retained history is pageable within response budgets', () => {
  it('reaches every record beyond 256 without duplicate shifts when a new run arrives', async () => {
    const paths = await fixture();
    await seed(paths, 258);
    const first = await queryHistoryPage(paths);
    expect(first.records).toHaveLength(256);
    expect(first.records[0].run_id).toBe('run-00257');
    await writeFile(path.join(paths.history, 'run-99999.json'), JSON.stringify(record('run-99999')));
    const last = await queryHistoryPage(paths, { cursor: first.pagination.next_cursor });
    expect(last.records.map(item => item.run_id)).toEqual(['run-00001', 'run-00000']);
    expect(last.pagination.has_more).toBe(false);
    await expect(queryHistoryPage(paths, { requirement: 'R1', cursor: first.pagination.next_cursor })).rejects.toThrow(/different filters/);
  });

  it('pages requirement records newest first and preserves each immutable superseding record', async () => {
    const paths = await fixture();
    await seed(paths, 2);
    await writeFile(paths.requirementIndex, JSON.stringify({ requirements: { R1: ['run-00000', 'run-00001'] } }));
    await writeFile(path.join(paths.history, 'run-00001.superseding-1.json'), JSON.stringify(record('run-00001', { supersedes: 'old' })));
    const all = []; let cursor;
    do {
      const page = await queryHistoryPage(paths, { requirement: 'R1', limit: 1, ...(cursor ? { cursor } : {}) });
      all.push(...page.records); cursor = page.pagination.next_cursor;
    } while (cursor);
    expect(all.map(item => item.run_id)).toEqual(['run-00001', 'run-00001', 'run-00000']);
  });

  it('retains all rows when the 48,000-byte wire budget shortens each service page', async () => {
    const paths = await fixture();
    await seed(paths, 24, { block_reason: 'detail '.repeat(700) });
    const ids = []; let cursor;
    do {
      const page = wire(await queryHistoryPage(paths, { ...(cursor ? { cursor } : {}) }));
      expect(Buffer.byteLength(JSON.stringify(page))).toBeLessThanOrEqual(RESPONSE_BUDGET_BYTES);
      expect(page.records.length).toBeGreaterThan(0);
      ids.push(...page.records.map(item => item.run_id)); cursor = page.pagination.next_cursor;
    } while (cursor);
    expect(ids).toHaveLength(24);
    expect(new Set(ids).size).toBe(24);
  });

  it('directly includes an older requested archive and discloses sampled lineage context', async () => {
    const paths = await fixture();
    await seed(paths, 258);
    const lineage = await logicalLineageForRun(paths, 'run-00000');
    expect(lineage).toMatchObject({ complete: false, immutable_run_count: 1,
      coverage: { available_runs: 258, processed_runs: 257, requested_run_included: true, truncated: true } });
    expect(lineage.incomplete_reasons).toContain('history-window-truncated');
    expect(lineage.incomplete_reasons).not.toContain('missing-terminal-archive');
  });

  it('lets metrics inspect older physical runs and binds its cursor to filters', async () => {
    const paths = await fixture();
    await seed(paths, 258);
    const first = await calculateProjectMetrics(paths, { status: 'completed' });
    const last = await calculateProjectMetrics(paths, { status: 'completed', cursor: first.pagination.next_cursor });
    expect(first.total_runs).toBe(256);
    expect(last.total_runs).toBe(2);
    expect(last.coverage).toMatchObject({ available_runs: 258, processed_runs: 2, truncated: true });
    expect(last.pagination.has_more).toBe(false);
    await expect(calculateProjectMetrics(paths, { status: 'blocked', cursor: first.pagination.next_cursor })).rejects.toThrow(/different filters/);
  });
});

describe('runtime state composes the ingress nesting contract', () => {
  it('retains an accepted maximum-depth receipt through finalization, state and immutable archive', async () => {
    let nested = 'leaf';
    for (let index = 0; index < INPUT_LIMITS.maxDepth - 2; index += 1) nested = { nested };
    const ticket = { ticket_id: 'run-depth:build:t', role: 'implementer', stage_id: 'build', objective: 'Observe depth',
      claimed_paths: ['a.js'], test_paths: [], required_checks: [], receipt_contract_version: 1 };
    ticket.capability_manifest = { version: 1, objective_hash: sha256(ticket.objective), allowed_evidence_commands: [] };
    ticket.output_schema = receiptOutputSchemaForTicket(ticket);
    ticket.capability_manifest.receipt_schema = { ref: 'ticket.output_schema', hash: sha256(ticket.output_schema) };
    const draft = { ticket_id: ticket.ticket_id, status: 'passed', tests: [], findings: [],
      evidence: { observation: nested }, receipt_capability: 'a'.repeat(32) };
    expect(() => assertSafeReceiptInput(draft)).not.toThrow();
    expect(validateReceiptDraft(ticket, draft).valid).toBe(true);
    const receipt = finalizeReceipt({ schema_version: '2.0.0', receipt_id: 'receipt-depth', run_id: 'run-depth',
      ticket_id: ticket.ticket_id, ticket_hash: 'a'.repeat(64), agent: { host: 'codex', role: 'implementer', identity: 'fixture', model: null },
      status: draft.status, base_tree_sha: 'b'.repeat(40), head_tree_sha: 'c'.repeat(40), changed_files: [],
      tests: draft.tests, findings: draft.findings, evidence: draft.evidence,
      timing: { started_at: '2026-01-01T00:00:00.000Z', completed_at: '2026-01-01T00:00:01.000Z', duration_ms: 1000 }, previous_receipt_hash: null });
    const state = { ...record('run-depth', { status: 'running', stage: 'build' }), tickets: [ticket], receipts: [receipt] };
    expect(RUNTIME_STATE_MAX_DEPTH).toBe(INPUT_LIMITS.maxDepth + 2);
    expect(projectRunDiagnostic(state).reason_code).toBe('stage_active');
    const archived = await archiveRun(await fixture(), { ...state, status: 'completed', stage: 'completed' });
    expect(archived.receipts[0].evidence).toEqual(draft.evidence);
    expect(validatedArchiveSnapshot(archived)?.hashVerified).toBe(true);
    expect(projectRunDiagnostic(archived, { archived: true }).reason_code).toBe('completed');

    const excessiveDraft = { ...draft, evidence: { observation: { nested } } };
    expect(() => assertSafeReceiptInput(excessiveDraft)).toThrow(/nesting is too deep/);
    expect(validateReceiptDraft(ticket, excessiveDraft).valid).toBe(false);
    const excessiveState = { ...state, receipts: [{ ...receipt, evidence: excessiveDraft.evidence }] };
    expect(projectRunDiagnostic(excessiveState).reason_code).toBe('corrupt_state');
    excessiveState.record_hash = hashRecord(excessiveState, ['record_hash', 'completed_at', 'timing']);
    expect(validatedArchiveSnapshot(excessiveState)).toBeNull();
  });
});

describe('numeric limits represent precision instead of an eleven-day run limit', () => {
  it('preserves a month-long archive and correction/writer durations exactly', () => {
    const start = '2026-01-01T00:00:00.000Z', end = '2026-02-01T00:00:00.000Z';
    const duration = Date.parse(end) - Date.parse(start);
    expect(projectRunDiagnostic(record('run-month', { timing: { raw_ms: duration + 0.5 } }), { archived: true }).stage_timing.duration_ms).toBe(duration + 0.5);
    let telemetry = { ...emptyOrchestrationTelemetry(), repair_started_at: start };
    telemetry = recordRepairCompleted(telemetry, end);
    telemetry = recordFirstWriterLatency(telemetry, start, end);
    expect(telemetry.correction_wall_ms).toBe(duration);
    expect(telemetry.time_to_first_writer_ms).toBe(duration);
    expect(validatedOrchestrationTelemetry(telemetry)).not.toBeNull();
    expect(projectRunDiagnostic(record('run-unsafe', { timing: { raw_ms: Number.MAX_SAFE_INTEGER + 1 } }), { archived: true }).stage_timing.available).toBe(false);
  });
  it('archives zero attempted replans when the operator disables directed recovery', async () => {
    const run = { ...record('run-zero-replans', { status: 'running', stage: 'plan-judge', lane: 'full' }),
      attempts: {}, execution_policy: { version: 1, limits: pipelineLimits({ policy: { max_directed_replans: 0 } }) } };
    const ticket = { ticket_id: 'judge', stage_id: 'plan-judge', role: 'plan_judge' };
    const receipt = { ticket_id: 'judge', status: 'passed', evidence: { verdict: 'disagree', missing_assurances: ['Required behavior has no evidence'] } };
    const actions = reduceRun(run, { type: 'RECEIPT_RECORDED', ticket, receipt, stage: { id: 'plan-judge', role: 'plan_judge' }, next_state: run });
    expect(actions.some(action => action.type === 'issue_ticket')).toBe(false);
    const patch = actions.find(action => action.type === 'transition').patch;
    expect(patch.blocked_recovery.directed_replan_attempts).toBe(0);
    const archived = await archiveRun(await fixture(), { ...run, ...patch });
    expect(archived.blocked_recovery).toEqual(patch.blocked_recovery);
    expect(archived.blocked_recovery.missing_assurances).toHaveLength(1);
  });

  it('retains modern terminal recovery evidence beyond old independent caps', () => {
    const planning_recovery = { reason_code: 'plan_replan_ceiling_exhausted', directed_replan_attempts: 11,
      missing_assurances: Array.from({ length: 17 }, (_, i) => ({ id: `assurance-${i}`, source_stage: 'plan-judge', summary: 's'.repeat(501), evidence_anchor: 'a'.repeat(601) })) };
    const fields = validatedTerminalRecoveryFields({ blocked_recovery: planning_recovery });
    expect(fields.blocked_recovery).toEqual(planning_recovery);
    const blocked_recovery = { reason_code: 'capability_denied', source_ticket_id: 'ticket-1', source_stage_id: 'build',
      claims_reported: true, successor_required: true, supersession_required: true, supersedes_run: 'run-source',
      additive_claims: { claimed_paths: Array.from({ length: 65 }, (_, i) => `src/${i}.js`), test_paths: [] } };
    expect(validatedTerminalRecoveryFields({ blocked_recovery }).blocked_recovery).toEqual(blocked_recovery);
  });

});

describe('retention reports scan work and omitted failures', () => {
  it('preserves exact omission and scan counts in its bounded status', async () => {
    const paths = await fixture();
    const inventory = { history_files_read: 42, history_bytes_read: 100000, artifact_files_read: 90, artifact_bytes_read: 200000 };
    const result = { failures: Array.from({ length: 20 }, (_, i) => ({ code: `FAIL_${i}`, reason: 'fixture' })), inventory };
    await recordArtifactRetentionStatus(paths, { result });
    const status = await readArtifactRetentionStatus(paths);
    expect(status).toMatchObject({ failure_count: 20, omitted_failures: 4, inventory });
    expect(status.failures).toHaveLength(16);
  });

  it('measures inventory reads independently of the compaction action cap', async () => {
    const paths = await fixture();
    await seed(paths, 3);
    const encoded = await readFile(path.join(paths.history, 'run-00000.json'));
    const result = await compactArchivedArtifacts(paths, { keepRecentRuns: 3, maxRunsPerSweep: 1 });
    expect(result.inventory).toEqual({ history_files_read: 3, history_bytes_read: encoded.length * 3, artifact_files_read: 0, artifact_bytes_read: 0 });
  });

  it('refuses oversized files, symlinks and FIFOs before an unbounded read', async () => {
    const paths = await fixture();
    const file = paths.artifactRetentionStatus;
    await writeFile(file, 'x'.repeat(32 * 1024 + 1));
    await expect(readArtifactRetentionStatus(paths)).rejects.toThrow(/bounded size/);
    await rm(file);
    await symlink(path.join(paths.history, 'missing.json'), file);
    await expect(readArtifactRetentionStatus(paths)).rejects.toThrow();
    await rm(file);
    execFileSync('mkfifo', [file]);
    await expect(readArtifactRetentionStatus(paths)).rejects.toThrow(/regular file/);
  });
});

const entry = (id, extra = {}) => ({ id, title: 'Title', description: 'Description', acceptance: 'Acceptance', depends_on: [], ...extra });
describe('roadmap operations share ordinary aggregate input budgets', () => {
  it('accepts more than 64 declarations and 32 dependencies without losing graph checks', async () => {
    const paths = await fixture();
    const entries = Array.from({ length: 65 }, (_, i) => entry(`R${i}`));
    entries.push(entry('dependent', { depends_on: entries.slice(0, 33).map(item => item.id) }));
    const stored = await registerEntries(paths, { entries, reason: 'Test aggregate mutation' });
    expect(stored.entries).toHaveLength(66);
    await expect(registerEntries(paths, { entries: [entry('bad', { depends_on: ['missing'] })], reason: 'Graph remains checked' })).rejects.toThrow(/unknown dependency/);
    const superseded = await supersedeEntries(paths, { ids: entries.map(item => item.id), reason: 'Retire complete graph' });
    expect(superseded.entries.every(item => item.superseded)).toBe(true);
  });

  it('admits longer prose inside 64 KiB, freezes historical fields, and refuses an oversized direct mutation', async () => {
    const declaration = entry('large', { title: 't'.repeat(201), description: 'd'.repeat(4001), acceptance: 'a'.repeat(2001) });
    expect(normalizeRoadmapDeclaration(declaration)).toEqual(declaration);
    expect(RoadmapFollowupSchema.safeParse(declaration).success).toBe(true);
    expect(LegacyRoadmapFollowupSchema.safeParse(declaration).success).toBe(false);
    const paths = await fixture();
    await expect(registerEntries(paths, { entries: [entry('oversize', { description: 'x'.repeat(64 * 1024) })], reason: 'Refuse aggregate overflow' })).rejects.toThrow(/65536 UTF-8 bytes/);
    await expect(readFile(path.join(paths.runtime, 'roadmap.json'))).rejects.toMatchObject({ code: 'ENOENT' });
  });
});
