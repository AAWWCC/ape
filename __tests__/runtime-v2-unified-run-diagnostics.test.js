import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { hashRecord } from '../lib/runtime/canonical.js';
import { archiveRun, explainRun } from '../lib/runtime/history.js';
import { runtimePaths } from '../lib/runtime/paths.js';
import { RESPONSE_BUDGET_CHARS } from '../lib/runtime/projection.js';
import { compactStatus, historyAction, startRun } from '../lib/runtime/service.js';
import { renderStatusDoc } from '../lib/runtime/status-doc.js';
import { atomicWriteJson } from '../lib/runtime/storage.js';
import { bindCodexDispatchContext, invokeCodexHook } from './codex-native-test-helper.js';

const repoRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const statuslineProgram = path.join(repoRoot, 'bin', 'ape-statusline.mjs');
const packageBuilder = path.join(repoRoot, 'scripts', 'build-plugin-packages.mjs');
const cleanups = [];

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});
async function sandbox(prefix = 'ape-diagnostic-contract-') {
  const dir = await mkdtemp(path.join(tmpdir(), prefix));
  cleanups.push(dir);
  await mkdir(runtimePaths(dir).history, { recursive: true });
  return dir;
}

function runState(overrides = {}) {
  return {
    schema_version: '2.0.0',
    run_id: 'run-fixture-diagnostics',
    objective: 'PRIVATE_OBJECTIVE_DO_NOT_RENDER',
    mode: 'phase',
    lane: 'fast',
    host: 'codex',
    status: 'running',
    stage: 'implement',
    dispatch_state: 'none',
    created_at: '2026-08-22T05:00:00.000Z',
    updated_at: '2026-08-22T05:00:04.000Z',
    tickets: [{
      ticket_id: 'run-fixture-diagnostics:implement:ticket',
      stage_id: 'implement',
      role: 'implementer',
    }],
    receipts: [{
      ticket_id: 'run-fixture-diagnostics:implement:ticket',
      status: 'passed',
      timing: {
        started_at: '2026-08-22T05:00:00.000Z',
        completed_at: '2026-08-22T05:00:04.000Z',
      },
    }],
    expired_tickets: [],
    ...overrides,
  };
}

function stableMergeFields(merge) {
  if (!merge || typeof merge !== 'object') return merge;
  const { merged_at: _mergedAt, provenance: _provenance, ...stable } = merge;
  return stable;
}

function withContractHash(record, contract) {
  const copy = { ...record };
  if (contract === 'imported') {
    expect(copy.imported).toBe(true);
    copy.record_hash = hashRecord(copy, ['record_hash', 'imported_at']);
    return copy;
  }
  if (contract === 'historical') expect(copy.mode).toBe('patch');
  else if (contract === 'modern') expect(copy.mode).not.toBe('patch');
  else throw new Error(`unknown archive contract: ${contract}`);
  const hashed = copy.merge ? { ...copy, merge: stableMergeFields(copy.merge) } : copy;
  copy.record_hash = hashRecord(hashed, ['record_hash', 'completed_at', 'timing']);
  return copy;
}

async function statusFor(state) {
  const dir = await sandbox();
  await atomicWriteJson(runtimePaths(dir).active, state);
  return { dir, status: await compactStatus(dir) };
}

function plainStatusline(dir, program = statuslineProgram) {
  const env = {
    ...process.env,
    APE_STATUSLINE_CHARSET: 'unicode',
    APE_STATUSLINE_GIT_TIMEOUT_MS: '5000',
    APE_STATUSLINE_NOW_MS: String(Date.parse('2026-08-22T05:00:05.000Z')),
  };
  delete env.CLAUDE_PROJECT_DIR;
  delete env.CODEX_CWD;
  const rendered = execFileSync('node', [program], {
    input: JSON.stringify({ workspace: { current_dir: dir } }),
    encoding: 'utf8',
    env,
  });
  // eslint-disable-next-line no-control-regex
  return rendered.replace(/\x1b\[[0-9;]*m/g, '');
}

function expectDiagnostic(value, reason, action) {
  expect(value).toMatchObject({
    reason_code: reason,
    next_safe_action: action,
    recovery_rationale: expect.any(String),
    failed_checks: expect.any(Array),
    stage_timing: { available: expect.any(Boolean), source: expect.any(String) },
  });
  expect(value.recovery_rationale.length).toBeLessThanOrEqual(240);
  expect(value.failed_checks.length).toBeLessThanOrEqual(32);
}

describe('unified public run diagnostics', () => {
  it('uses a closed lifecycle vocabulary and fixed recovery action for each observable condition', async () => {
    const cases = [
      [{ status: 'running', stage: 'implement' }, 'stage_active', 'ape_run next'],
      [{ status: 'gating', stage: 'gates' }, 'gating', 'ape_run next'],
      [{ status: 'blocked', stage: 'gates', gates: { passed: false, checks: {} } }, 'gate_failed', 'ape_run regate'],
      [{ status: 'blocked', stage: 'review' }, 'blocked', 'ape_run abort or ape_run override reset'],
      [{ status: 'blocked', stage: 'merge', gates: { passed: true } }, 'shipping_hold', 'ape_run ship'],
      [{ status: 'shipping', stage: 'merge' }, 'shipping', 'ape_run next'],
      [{ status: 'completed', stage: 'completed' }, 'completed', 'ape_run start'],
      [{ status: 'aborted', stage: 'aborted' }, 'aborted', 'ape_run start'],
    ];
    for (const [overrides, reason, action] of cases) {
      const { status } = await statusFor(runState(overrides));
      expectDiagnostic(status.diagnostic, reason, action);
      expect(status.next_safe_action).toBe(action);
    }

    const empty = await sandbox('ape-diagnostic-inactive-');
    expectDiagnostic((await compactStatus(empty)).diagnostic, 'inactive', 'ape_run start');
    expect(explainRun({ run_id: 'run-imported-example', status: 'completed', imported: true }))
      .toContain('Reason code: legacy_record');
    expect(explainRun({ run_id: 'run-incomplete-example', status: 'completed' }))
      .toContain('Reason code: incomplete_record');
  });

  it.each([
    ['missing', undefined],
    ['empty', ''],
    ['safe-looking noncanonical', 'foo'],
    ['malformed', '../PRIVATE_ESCAPE'],
    ['non-string', { hostile: true }],
  ])('gives %s run_id the same bounded corrupt-state treatment across active projections', async (_label, runId) => {
    const dir = await sandbox('ape-diagnostic-run-id-');
    const state = runState();
    if (runId === undefined) delete state.run_id;
    else state.run_id = runId;
    await atomicWriteJson(runtimePaths(dir).active, state);

    const compact = await compactStatus(dir);
    expectDiagnostic(compact.diagnostic, 'corrupt_state', 'ape_run override reset');
    const line = plainStatusline(dir);
    expect(line).toContain('corrupt_state');
    expect(line).toContain('ape_run override reset');
    expect(line).not.toContain('PRIVATE_ESCAPE');
    expect(line.length).toBeLessThan(1024);
    const historyInput = runId === undefined ? {} : { run_id: runId };
    await expect(historyAction(dir, 'explain', historyInput))
      .rejects.toThrow('history explain requires a valid run_id');
  });

  it('rejects an active object with neither run_id nor schema_version', async () => {
    const dir = await sandbox('ape-diagnostic-missing-identity-');
    const state = runState();
    delete state.run_id;
    delete state.schema_version;
    await atomicWriteJson(runtimePaths(dir).active, state);

    const compact = await compactStatus(dir);
    expectDiagnostic(compact.diagnostic, 'corrupt_state', 'ape_run override reset');
    const line = plainStatusline(dir);
    expect(line).toContain('corrupt_state');
    expect(line).not.toContain('stage_active');
    expect(line.length).toBeLessThan(1024);
  });

  it('derives failed checks only from durable failed check objects and hard-caps identifiers', async () => {
    const checks = {};
    for (let index = 39; index >= 0; index -= 1) {
      checks[`gate-${String(index).padStart(2, '0')}`] = {
        passed: false,
        command: `PRIVATE_COMMAND_${index}`,
        output: `PRIVATE_OUTPUT_${index}`,
      };
    }
    checks.success = { passed: true };
    checks.prose = { passed: 'false', summary: 'invented-check failed' };
    checks.alias = { id: 'gate-03', passed: false };
    checks['bad check id'] = { passed: false };
    const { status } = await statusFor(runState({
      status: 'blocked',
      stage: 'gates',
      gates: { passed: false, checks },
      block_reason: 'invented-check failed',
    }));

    const failed = status.diagnostic.failed_checks;
    expect(failed).toHaveLength(32);
    expect(failed).toEqual([...new Set(failed)].sort());
    expect(failed).toContain('gate-03');
    expect(failed).not.toContain('success');
    expect(failed).not.toContain('prose');
    expect(failed).not.toContain('bad check id');
    const serialized = JSON.stringify(status);
    expect(serialized).not.toContain('PRIVATE_COMMAND_');
    expect(serialized).not.toContain('PRIVATE_OUTPUT_');
    expect(serialized).not.toContain('invented-check');
  });

  it('accepts only strict ISO timing and safe non-negative numeric provenance', async () => {
    const { status: valid } = await statusFor(runState());
    expect(valid.diagnostic.stage_timing).toEqual({
      available: true,
      source: 'receipt_timestamps',
      stage_id: 'implement',
      duration_ms: 4000,
    });

    for (const receipts of [
      [],
      [{ ticket_id: 'run-fixture-diagnostics:implement:ticket', timing: { started_at: '2026', completed_at: '2027' } }],
      [{ ticket_id: 'run-fixture-diagnostics:implement:ticket', timing: { started_at: '2026-08-22T05:00:04.000Z', completed_at: '2026-08-22T05:00:00.000Z' } }],
      [{ ticket_id: 'run-fixture-diagnostics:implement:ticket', timing: { started_at: 'bad', completed_at: 'worse', duration_ms: -1 } }],
    ]) {
      const { status } = await statusFor(runState({ receipts }));
      expect(status.diagnostic.stage_timing).toEqual({ available: false, source: 'unavailable' });
    }
  });

  it.each([
    ['unknown schema', (state, secret) => { state.schema_version = secret; }],
    ['missing schema', (state) => { delete state.schema_version; }],
    ['unknown mode', (state, secret) => { state.mode = secret; }],
    ['missing mode', (state) => { delete state.mode; }],
    ['unknown lane', (state, secret) => { state.lane = secret; }],
    ['missing lane', (state) => { delete state.lane; }],
    ['unknown status', (state, secret) => { state.status = secret; }],
    ['missing status', (state) => { delete state.status; }],
    ['unknown stage', (state, secret) => { state.stage = secret; }],
    ['missing stage', (state) => { delete state.stage; }],
    ['unknown host', (state, secret) => { state.host = secret; }],
    ['missing host', (state) => { delete state.host; }],
    ['unknown dispatch', (state, secret) => { state.dispatch_state = secret; }],
    ['missing dispatch', (state) => { delete state.dispatch_state; }],
    ['unknown gate result', (state, secret) => { state.gates = { passed: secret, checks: {} }; }],
    ['missing gate result', (state) => { state.gates = { checks: {} }; }],
    ['unknown remediation route', (state, secret) => { state.remediation_route = { route: secret, cycle: 1 }; }],
    ['missing remediation route', (state) => { state.remediation_route = { cycle: 1 }; }],
    ['unknown ticket stage', (state, secret) => { state.tickets[0].stage_id = secret; }],
    ['unknown ticket role', (state, secret) => { state.tickets[0].role = secret; }],
    ['malformed ticket identifier', (state, secret) => { state.tickets[0].ticket_id = `../${secret}`; }],
    ['unknown receipt status', (state, secret) => { state.receipts[0].status = secret; }],
    ['malformed receipt ticket identifier', (state, secret) => { state.receipts[0].ticket_id = `../${secret}`; }],
    ['malformed expired identifier', (state, secret) => { state.expired_tickets = [`../${secret}`]; }],
    ['oversized pending values', (state, secret) => { state.pending = Array.from({ length: 257 }, () => secret); }],
    ['oversized preflight answers', (state, secret) => { state.preflight = { answers: Array.from({ length: 257 }, () => ({ id: secret })) }; }],
  ])('fails closed for an active state with %s', async (label, mutate) => {
    const secret = `PRIVATE_ACTIVE_${label.replaceAll(' ', '_').toUpperCase()}`;
    const state = runState({ host: 'codex', dispatch_state: 'none' });
    mutate(state, secret);
    const { status } = await statusFor(state);

    expectDiagnostic(status.diagnostic, 'corrupt_state', 'ape_run override reset');
    expect(JSON.stringify(status)).not.toContain(secret);
    expect(JSON.stringify(status).length).toBeLessThan(RESPONSE_BUDGET_CHARS);
  });

  it.each([
    ['unknown schema', (record, secret) => { record.schema_version = secret; }],
    ['missing schema', (record) => { delete record.schema_version; }],
    ['unknown mode', (record, secret) => { record.mode = secret; }],
    ['missing mode', (record) => { delete record.mode; }],
    ['unknown lane', (record, secret) => { record.lane = secret; }],
    ['missing lane', (record) => { delete record.lane; }],
    ['unknown status', (record, secret) => { record.status = secret; }],
    ['missing status', (record) => { delete record.status; }],
    ['unknown stage', (record, secret) => { record.stage = secret; }],
    ['missing stage', (record) => { delete record.stage; }],
    ['unknown host', (record, secret) => { record.host = secret; }],
    ['missing host', (record) => { delete record.host; }],
    ['unknown dispatch', (record, secret) => { record.dispatch_state = secret; }],
    ['missing dispatch', (record) => { delete record.dispatch_state; }],
    ['unknown gate result', (record, secret) => { record.gates = { passed: secret, checks: {} }; }],
    ['missing gate result', (record) => { record.gates = { checks: {} }; }],
    ['unknown remediation route', (record, secret) => { record.remediation_route = { route: secret, cycle: 1 }; }],
    ['missing remediation route', (record) => { record.remediation_route = { cycle: 1 }; }],
    ['unknown ticket stage', (record, secret) => { record.tickets[0].stage_id = secret; }],
    ['unknown ticket role', (record, secret) => { record.tickets[0].role = secret; }],
    ['malformed ticket identifier', (record, secret) => { record.tickets[0].ticket_id = `../${secret}`; }],
    ['unknown receipt status', (record, secret) => { record.receipts[0].status = secret; }],
    ['malformed receipt ticket identifier', (record, secret) => { record.receipts[0].ticket_id = `../${secret}`; }],
    ['malformed expired identifier', (record, secret) => { record.expired_tickets = [`../${secret}`]; }],
    ['oversized pending values', (record, secret) => { record.pending = Array.from({ length: 257 }, () => secret); }],
    ['oversized preflight answers', (record, secret) => { record.preflight = { answers: Array.from({ length: 257 }, () => ({ id: secret })) }; }],
  ])('fails closed for an archived record with %s', (label, mutate) => {
    const secret = `PRIVATE_ARCHIVE_${label.replaceAll(' ', '_').toUpperCase()}`;
    const record = runState({
      host: 'codex',
      dispatch_state: 'none',
      status: 'completed',
      stage: 'completed',
      completed_at: '2026-08-22T05:00:05.000Z',
    });
    mutate(record, secret);
    const explanation = explainRun(record);

    expect(explanation).toContain('Reason code: incomplete_record');
    expect(explanation).toContain('Next safe action: inspect immutable history');
    expect(explanation).not.toContain(secret);
    expect(explanation.length).toBeLessThan(8192);
  });

  it.each([
    '2026-08-22 05:00:00Z',
    '2026-08-22T05:00:00Z trailing',
    '2026-02-30T05:00:00.000Z',
    '2025-02-29T05:00:00.000Z',
    '2026-13-01T05:00:00.000Z',
    '2026-08-22T24:00:00.000Z',
    '2026-08-22T05:00:00.000+24:00',
  ])('rejects permissive or impossible archived timestamp %s', (timestamp) => {
    const record = runState({
      host: 'codex',
      dispatch_state: 'none',
      status: 'completed',
      stage: 'completed',
      created_at: timestamp,
      completed_at: '2026-08-22T05:00:05.000Z',
      receipts: [],
    });
    const explanation = explainRun(record);
    expect(explanation).toContain('Reason code: incomplete_record');
    expect(explanation).toContain('Timing: unavailable');
    expect(explanation).not.toContain(timestamp);
  });

  it.each([
    ['timing.raw_ms', (record, value) => { record.timing = { raw_ms: value }; }],
    ['retries_count', (record, value) => { record.retries_count = value; }],
    ['retry_count', (record, value) => { record.retry_count = value; }],
    ['regate_attempts', (record, value) => { record.regate_attempts = value; }],
    ['remediation_cycles', (record, value) => { record.remediation_cycles = value; }],
    ['remediation_route.cycle', (record, value) => { record.remediation_route = { route: 'test', cycle: value }; }],
    ['input_hold.question_count', (record, value) => { record.input_hold = { occurred: true, question_count: value, question_ids: [] }; }],
    ['gates.checks_count', (record, value) => { record.gates = { passed: true, checks: {}, checks_count: value }; }],
  ])('rejects oversized finite archived numeric fact %s', (label, mutate) => {
    const oversized = Number.MAX_SAFE_INTEGER;
    const record = runState({
      host: 'codex',
      dispatch_state: 'none',
      status: 'completed',
      stage: 'completed',
      completed_at: '2026-08-22T05:00:05.000Z',
      receipts: [],
    });
    mutate(record, oversized);
    const explanation = explainRun(record);
    expect(explanation).toContain('Reason code: incomplete_record');
    expect(explanation).not.toContain(String(oversized));
    expect(explanation.length).toBeLessThan(8192);
  });

  it('rejects oversized archive collections before reading getter-backed tails', () => {
    let tailReads = 0;
    const tickets = Array.from({ length: 257 }, (_, index) => ({
      ticket_id: `run-archive-tail:implement:${index}`,
      stage_id: 'implement',
      role: 'implementer',
    }));
    Object.defineProperty(tickets, 256, {
      enumerable: true,
      get() {
        tailReads += 1;
        throw new Error('PRIVATE_ARCHIVE_TAIL_READ');
      },
    });
    const record = runState({
      run_id: 'run-archive-tail',
      host: 'codex',
      dispatch_state: 'none',
      status: 'completed',
      stage: 'completed',
      completed_at: '2026-08-22T05:00:05.000Z',
      tickets,
      receipts: [],
    });

    const explanation = explainRun(record);
    expect(tailReads).toBe(0);
    expect(explanation).toContain('Reason code: incomplete_record');
    expect(explanation).not.toContain('PRIVATE_ARCHIVE_TAIL_READ');
  });

  it('snapshots a getter-backed run_id once at the historyAction boundary', async () => {
    const dir = await sandbox('ape-diagnostic-history-getter-');
    const runId = 'run-history-getter-boundary';
    await atomicWriteJson(path.join(runtimePaths(dir).history, `${runId}.json`), runState({
      run_id: runId,
      host: 'codex',
      dispatch_state: 'none',
      status: 'completed',
      stage: 'completed',
      completed_at: '2026-08-22T05:00:05.000Z',
    }));
    let reads = 0;
    const input = {};
    Object.defineProperty(input, 'run_id', {
      enumerable: true,
      get() {
        reads += 1;
        if (reads > 1) throw new Error('PRIVATE_HISTORY_RUN_ID_REREAD');
        return runId;
      },
    });

    const explained = await historyAction(dir, 'explain', input);
    expect(reads).toBe(1);
    expect(explained.run).toMatchObject({ run_id: runId, status: 'completed' });
    expect(JSON.stringify(explained)).not.toContain('PRIVATE_HISTORY_RUN_ID_REREAD');
  });

  it('keeps gate semantics identical on status, history, status.md, and statusline', async () => {
    const state = runState({
      status: 'blocked',
      stage: 'gates',
      gates: { passed: false, checks: { lint: { passed: false }, test: { passed: true } } },
    });
    const { dir, status } = await statusFor(state);
    const surfaces = [explainRun(state), renderStatusDoc(state), plainStatusline(dir)];
    expectDiagnostic(status.diagnostic, 'gate_failed', 'ape_run regate');
    for (const surface of surfaces) {
      expect(surface).toContain('gate_failed');
      expect(surface).toContain('ape_run regate');
      expect(surface).toContain('lint');
    }
  });

  it('validates hostile nested collections before traversal and bounds every projection', async () => {
    const bidi = String.fromCharCode(0x202e);
    const isolate = String.fromCharCode(0x2066);
    const secret = 'PRIVATE_NESTED_SENTINEL';
    const state = runState({
      status: 'blocked',
      stage: 'gates',
      objective: `${secret}${bidi}${'z'.repeat(20_000)}`,
      pending: `${secret}${'p'.repeat(20_000)}`,
      gates: {
        passed: false,
        checks: Object.fromEntries(Array.from({ length: 2000 }, (_, index) => [
          index === 0 ? `bad${isolate}id` : `check-${index}`,
          { passed: false, output: `${secret}${index}` },
        ])),
      },
      tickets: Array.from({ length: 2000 }, (_, index) => ({
        ticket_id: `ticket-${index}`,
        receipt_capability: `${secret}-${index}`,
        claimed_paths: [`private/${secret}.wav`],
      })),
      receipts: Array.from({ length: 2000 }, (_, index) => ({
        ticket_id: `ticket-${index}`,
        status: 'failed',
        evidence: { summary: `${secret}-${index}` },
      })),
      expired_tickets: Array.from({ length: 2000 }, (_, index) => `expired-${index}`),
      regate_attempts: Number.MAX_VALUE,
      merge: { url: `https://${secret}:password@example.test/private/repo` },
    });
    const { dir, status } = await statusFor(state);
    const surfaces = [JSON.stringify(status), explainRun(state), renderStatusDoc(state), plainStatusline(dir)];
    for (const surface of surfaces) {
      expect(surface).not.toContain(secret);
      expect(surface).not.toContain(bidi);
      expect(surface).not.toContain(isolate);
      expect(surface).not.toContain(String.fromCharCode(0));
    }
    expect(surfaces[0].length).toBeLessThan(RESPONSE_BUDGET_CHARS);
    expect(surfaces[2].length).toBeLessThan(8192);
    expect(surfaces[3].length).toBeLessThan(1024);
  });

  it('never reads collection tails beyond the diagnostic input caps', async () => {
    const { projectRunDiagnostic } = await import('../lib/runtime/diagnostics.js');
    let tailReads = 0;
    const tickets = Array.from({ length: 2000 }, (_, index) => ({
      ticket_id: `run-tail-cap:implement:${index}`,
      stage_id: 'implement',
    }));
    Object.defineProperty(tickets, 1999, {
      enumerable: true,
      get() {
        tailReads += 1;
        return { ticket_id: 'PRIVATE_TAIL_TICKET', stage_id: 'implement' };
      },
    });
    const receipts = Array.from({ length: 2000 }, (_, index) => ({
      ticket_id: `run-tail-cap:implement:${index}`,
      status: 'passed',
    }));
    Object.defineProperty(receipts, 1999, {
      enumerable: true,
      get() {
        tailReads += 1;
        return { ticket_id: 'PRIVATE_TAIL_RECEIPT', status: 'failed' };
      },
    });
    const expired = Array.from({ length: 2000 }, (_, index) => `run-tail-cap:implement:expired-${index}`);
    Object.defineProperty(expired, 1999, {
      enumerable: true,
      get() {
        tailReads += 1;
        return 'PRIVATE_TAIL_EXPIRED';
      },
    });
    const checks = Object.fromEntries(Array.from({ length: 2000 }, (_, index) => [
      `check-${String(index).padStart(4, '0')}`,
      { passed: index < 32 ? false : true },
    ]));
    Object.defineProperty(checks, 'zzzz-private-tail', {
      enumerable: true,
      get() {
        tailReads += 1;
        return { passed: false };
      },
    });

    const diagnostic = projectRunDiagnostic(runState({
      run_id: 'run-tail-cap',
      status: 'blocked',
      stage: 'gates',
      gates: { passed: false, checks },
      tickets,
      receipts,
      expired_tickets: expired,
    }), { dispatchState: 'none' });

    expect(tailReads).toBe(0);
    expectDiagnostic(diagnostic, 'corrupt_state', 'ape_run override reset');
    expect(diagnostic.failed_checks).toEqual([]);
    expect(JSON.stringify(diagnostic)).not.toContain('PRIVATE_TAIL');
  });

  it('accepts canonical collection maxima and rejects max-plus-one before reading any tail', async () => {
    const { MAX_DIAGNOSTIC_COLLECTION, projectRunDiagnostic } = await import('../lib/runtime/diagnostics.js');
    const tickets = Array.from({ length: MAX_DIAGNOSTIC_COLLECTION }, (_, index) => ({
      ticket_id: `run-collection-boundary:implement:${index}`,
      stage_id: 'implement',
      role: 'implementer',
    }));
    const receipts = tickets.map((ticket) => ({ ticket_id: ticket.ticket_id, status: 'passed' }));
    const expired = Array.from(
      { length: MAX_DIAGNOSTIC_COLLECTION },
      (_, index) => `run-collection-boundary:implement:expired-${index}`,
    );
    const checks = Object.fromEntries(Array.from(
      { length: MAX_DIAGNOSTIC_COLLECTION },
      (_, index) => [`check-${index}`, { passed: index !== 0 }],
    ));
    const boundary = runState({
      run_id: 'run-collection-boundary',
      status: 'blocked',
      stage: 'gates',
      tickets,
      receipts,
      expired_tickets: expired,
      gates: { passed: false, checks },
    });
    expectDiagnostic(projectRunDiagnostic(boundary), 'gate_failed', 'ape_run regate');

    for (const [field, value] of [
      ['tickets', [...tickets, { ticket_id: 'PRIVATE_TICKET_TAIL', stage_id: 'implement', role: 'implementer' }]],
      ['receipts', [...receipts, { ticket_id: 'PRIVATE_RECEIPT_TAIL', status: 'failed' }]],
      ['expired_tickets', [...expired, 'PRIVATE_EXPIRED_TAIL']],
    ]) {
      let reads = 0;
      Object.defineProperty(value, MAX_DIAGNOSTIC_COLLECTION, {
        enumerable: true,
        get() {
          reads += 1;
          throw new Error(`PRIVATE_${field.toUpperCase()}_TAIL_READ`);
        },
      });
      const diagnostic = projectRunDiagnostic({ ...boundary, [field]: value });
      expect(reads).toBe(0);
      expectDiagnostic(diagnostic, 'corrupt_state', 'ape_run override reset');
      expect(JSON.stringify(diagnostic)).not.toContain('PRIVATE_');
    }

    let checkReads = 0;
    const oversizedChecks = { ...checks };
    Object.defineProperty(oversizedChecks, 'zz-private-check-tail', {
      enumerable: true,
      get() {
        checkReads += 1;
        throw new Error('PRIVATE_CHECK_TAIL_READ');
      },
    });
    const checkDiagnostic = projectRunDiagnostic({
      ...boundary,
      gates: { passed: false, checks: oversizedChecks },
    });
    expect(checkReads).toBe(0);
    expectDiagnostic(checkDiagnostic, 'corrupt_state', 'ape_run override reset');
    expect(JSON.stringify(checkDiagnostic)).not.toContain('PRIVATE_CHECK_TAIL_READ');
  });

  it('accepts the canonical maximum run ID and rejects max-plus-one before history probing', async () => {
    const dir = await sandbox('ape-diagnostic-history-id-boundary-');
    const paths = runtimePaths(dir);
    const maxRunId = `run-a${'b'.repeat(123)}`;
    const overlongRunId = `${maxRunId}c`;
    await atomicWriteJson(path.join(paths.history, `${maxRunId}.json`), runState({
      run_id: maxRunId,
      status: 'completed',
      stage: 'completed',
      completed_at: '2026-08-22T05:00:05.000Z',
    }));
    await expect(historyAction(dir, 'explain', { run_id: maxRunId })).resolves.toMatchObject({
      ok: true,
      run: { run_id: maxRunId },
    });

    await rm(paths.history, { recursive: true, force: true });
    await writeFile(paths.history, 'PRIVATE_PROBE_SENTINEL');
    for (const invalid of [overlongRunId, 'run-_suffix', 'run--suffix']) {
      await expect(historyAction(dir, 'explain', { run_id: invalid }))
        .rejects.toThrow('history explain requires a valid run_id');
    }
  });

  it('suppresses invalid archive lifecycle fields from the historyAction summary', async () => {
    const dir = await sandbox('ape-diagnostic-history-summary-');
    const runId = 'run-incomplete-summary';
    const secret = 'PRIVATE_ARCHIVE_STATUS_SENTINEL';
    await atomicWriteJson(path.join(runtimePaths(dir).history, `${runId}.json`), runState({
      run_id: runId,
      status: secret,
      stage: 'completed',
      completed_at: '2026-08-22T05:00:05.000Z',
    }));

    const explained = await historyAction(dir, 'explain', { run_id: runId });
    expectDiagnostic(explained.diagnostic, 'incomplete_record', 'inspect immutable history');
    expect(explained.run?.run_id).toBe(runId);
    expect(JSON.stringify(explained.run)).not.toContain(secret);
    expect(JSON.stringify(explained)).not.toContain(secret);
  });

  it.each([
    ['imported record', { imported: true, status: 'PRIVATE_IMPORTED_STATUS' }],
    ['short record hash', { record_hash: 'short', merge: null }],
    ['record hash with malformed merge', {
      record_hash: 'c'.repeat(64),
      merge: {
        provider: 'PRIVATE_MERGE_PROVIDER',
        url: 'https://example.test/pull/1',
        branch: 'ape/phase-example',
        base: 'main',
        merged_at: '2026-08-22T05:00:05.000Z',
      },
    }],
  ])('does not let %s compatibility evidence bypass archive validation', (_label, overrides) => {
    const record = runState({
      run_id: 'run-archive-compatibility',
      status: 'completed',
      stage: 'completed',
      completed_at: '2026-08-22T05:00:05.000Z',
      ...overrides,
    });
    const explanation = explainRun(record);
    expect(explanation).toContain('Reason code: incomplete_record');
    expect(explanation).not.toContain('PRIVATE_IMPORTED_STATUS');
    expect(explanation).not.toContain('PRIVATE_MERGE_PROVIDER');
  });

  it('rejects an oversized imported archive before reading its getter-backed tail', () => {
    let reads = 0;
    const tickets = Array.from({ length: 257 }, (_, index) => ({
      ticket_id: `run-imported-tail:implement:${index}`,
      stage_id: 'implement',
      role: 'implementer',
    }));
    Object.defineProperty(tickets, 256, {
      enumerable: true,
      get() {
        reads += 1;
        throw new Error('PRIVATE_IMPORTED_TAIL_READ');
      },
    });
    const explanation = explainRun({
      run_id: 'run-imported-tail',
      imported: true,
      status: 'completed',
      tickets,
      receipts: [],
    });
    expect(reads).toBe(0);
    expect(explanation).toContain('Reason code: incomplete_record');
    expect(explanation).not.toContain('PRIVATE_IMPORTED_TAIL_READ');
  });

  it('discards accessor-backed merge evidence at persistence without invoking getters', async () => {
    const dir = await sandbox('ape-diagnostic-merge-persistence-');
    let reads = 0;
    const merge = {
      provider: 'github',
      branch: 'ape/phase-getter-safe',
      base: 'main',
      merged_at: '2026-08-22T05:00:05.000Z',
    };
    Object.defineProperty(merge, 'url', {
      enumerable: true,
      get() {
        reads += 1;
        throw new Error('PRIVATE_MERGE_GETTER_READ');
      },
    });
    const archived = await archiveRun(runtimePaths(dir), runState({
      run_id: 'run-getter-safe-merge',
      status: 'completed',
      stage: 'completed',
      completed_at: '2026-08-22T05:00:05.000Z',
      requirements: [],
      base_commit_sha: 'a'.repeat(40),
      tree_sha: 'b'.repeat(40),
      merge,
    }));
    expect(reads).toBe(0);
    expect(archived.merge).toBeNull();
    expect(JSON.stringify(archived)).not.toContain('PRIVATE_MERGE_GETTER_READ');
  });

  it.each(['branch', 'base'])('does not persist merge evidence missing required %s provenance', async (missing) => {
    const dir = await sandbox(`ape-diagnostic-merge-missing-${missing}-`);
    const merge = {
      provider: 'github',
      url: 'https://example.test/pull/1',
      branch: 'ape/phase-required-merge-fields',
      base: 'main',
      merged_at: '2026-08-22T05:00:05.000Z',
    };
    delete merge[missing];
    const archived = await archiveRun(runtimePaths(dir), runState({
      run_id: `run-merge-missing-${missing}`,
      status: 'completed',
      stage: 'completed',
      completed_at: '2026-08-22T05:00:05.000Z',
      requirements: [],
      base_commit_sha: 'a'.repeat(40),
      tree_sha: 'b'.repeat(40),
      merge,
    }));
    expect(archived.merge).toBeNull();
  });

  it('explains the effective archive through a privacy-safe projection without mutating bytes', async () => {
    const dir = await sandbox('ape-diagnostic-history-');
    const paths = runtimePaths(dir);
    const record = withContractHash(runState({
      run_id: 'run-history-safe-projection',
      status: 'completed',
      stage: 'completed',
      completed_at: '2026-08-22T05:00:05.000Z',
      merge: {
        provider: 'github',
        url: 'https://PRIVATE_USER:PRIVATE_PASSWORD@github.com/private/repo/pull/1',
        branch: 'ape/phase-private-merge',
        base: 'main',
        merged_at: '2026-08-22T05:00:05.000Z',
      },
    }), 'modern');
    const file = path.join(paths.history, `${record.run_id}.json`);
    await atomicWriteJson(file, record);
    const before = await readFile(file, 'utf8');

    const explained = await historyAction(dir, 'explain', { run_id: record.run_id });
    expect(explained).toMatchObject({
      ok: true,
      run: { run_id: record.run_id, status: 'completed' },
      diagnostic: { reason_code: 'completed', next_safe_action: 'ape_run start' },
    });
    expect(explained).not.toHaveProperty('record');
    expect(JSON.stringify(explained)).not.toContain(record.objective);
    expect(JSON.stringify(explained)).not.toContain('PRIVATE_USER');
    expect(await readFile(file, 'utf8')).toBe(before);
  });

  it('degrades malformed active state and incomplete archives without throwing or echoing bytes', async () => {
    const dir = await sandbox('ape-diagnostic-corrupt-');
    await writeFile(runtimePaths(dir).active, '{"objective":"PRIVATE_CORRUPT_BYTES",');
    const compact = await compactStatus(dir);
    expectDiagnostic(compact.diagnostic, 'corrupt_state', 'ape_run override reset');
    expect(JSON.stringify(compact)).not.toContain('PRIVATE_CORRUPT_BYTES');
    expect(plainStatusline(dir)).toContain('corrupt_state');

    const partial = { schema_version: '2.0.0', run_id: 'run-partial-archive', mode: 'phase', tickets: {}, receipts: [] };
    expect(explainRun(partial)).toContain('Reason code: incomplete_record');
    await atomicWriteJson(path.join(runtimePaths(dir).history, 'run-partial-archive.json'), partial);
    const explained = await historyAction(dir, 'explain', { run_id: partial.run_id });
    expect(explained.diagnostic).toMatchObject({
      reason_code: 'incomplete_record',
      next_safe_action: 'inspect immutable history',
    });
  });

  it('builds and executes the actual packaged Claude statusline with its exact local dependency closure', async () => {
    const output = await sandbox('ape-diagnostic-package-');
    execFileSync('node', [packageBuilder, '--output-root', output], { cwd: repoRoot, encoding: 'utf8' });
    const claude = path.join(output, 'ape-claude');
    const expected = [
      path.join(claude, 'bin', 'ape-statusline.mjs'),
      path.join(claude, 'lib', 'runtime', 'diagnostics.js'),
      path.join(claude, 'lib', 'runtime', 'paths.js'),
    ];
    for (const file of expected) await expect(readFile(file, 'utf8')).resolves.toBeTypeOf('string');

    const project = await sandbox('ape-diagnostic-package-project-');
    await atomicWriteJson(runtimePaths(project).active, runState({ status: 'blocked', stage: 'review' }));
    const rendered = plainStatusline(project, expected[0]);
    expect(rendered).toContain('blocked');
    expect(rendered).toContain('ape_run abort or ape_run override reset');
    expect(rendered).not.toContain('PRIVATE_OBJECTIVE_DO_NOT_RENDER');
    expect(rendered.length).toBeLessThan(1024);

    for (const [field, secret] of [
      ['schema_version', 'PRIVATE_CLAUDE_STATUSLINE_SCHEMA'],
      ['mode', 'PRIVATE_CLAUDE_STATUSLINE_MODE'],
      ['lane', 'PRIVATE_CLAUDE_STATUSLINE_LANE'],
      ['status', 'PRIVATE_CLAUDE_STATUSLINE_STATUS'],
      ['stage', 'PRIVATE_CLAUDE_STATUSLINE_STAGE'],
      ['host', 'PRIVATE_CLAUDE_STATUSLINE_HOST'],
      ['dispatch_state', 'PRIVATE_CLAUDE_STATUSLINE_DISPATCH'],
    ]) {
      await atomicWriteJson(runtimePaths(project).active, runState({
        [field]: secret,
        objective: 'PRIVATE_CLAUDE_STATUSLINE_OBJECTIVE',
      }));
      const hostile = plainStatusline(project, expected[0]);
      expect(hostile).toContain('corrupt_state');
      expect(hostile).toContain('ape_run override reset');
      expect(hostile).not.toContain(secret);
      expect(hostile).not.toContain('PRIVATE_CLAUDE_STATUSLINE_OBJECTIVE');
      expect(hostile.length).toBeLessThan(1024);
    }
  }, 30_000);

  it('refreshes persisted status.md after real prepared, bound, and stopped dispatch transitions', async () => {
    const dir = await sandbox('ape-diagnostic-dispatch-owner-');
    await mkdir(path.join(dir, 'src'));
    await mkdir(path.join(dir, 'tests'));
    await writeFile(path.join(dir, 'src', 'value.js'), 'export const value = 1;\n');
    await writeFile(path.join(dir, 'tests', 'value.test.js'), 'throw new Error("red");\n');
    execFileSync('git', ['init', '-q'], { cwd: dir });
    execFileSync('git', ['config', 'user.email', 'ape@example.test'], { cwd: dir });
    execFileSync('git', ['config', 'user.name', 'APE Test'], { cwd: dir });
    execFileSync('git', ['add', '.'], { cwd: dir });
    execFileSync('git', ['commit', '-qm', 'baseline'], { cwd: dir });
    await atomicWriteJson(runtimePaths(dir).config, {
      shipping: { auto_merge: false, provider: 'github', required_remote_checks: false },
      test_commands: { full: 'node --test' },
    });

    const started = await startRun(dir, {
      objective: 'PRIVATE_DISPATCH_OBJECTIVE',
      mode: 'phase',
      lane: 'fast',
      host: 'codex',
      claimed_paths: ['src/value.js'],
      test_paths: ['tests/value.test.js'],
      requirements: ['R1'],
      risk_triggers: [],
      behavioral: true,
      hooks_trusted: true,
      subagents_available: true,
      explicit_invocation: true,
    });
    const dispatch = started.actions.find((action) => action.type === 'dispatch_agent');
    expect(dispatch).toBeTruthy();
    const statusDoc = path.join(runtimePaths(dir).runtime, 'status.md');
    const prepared = await readFile(statusDoc, 'utf8');
    expect(prepared).toContain('dispatch_pending');
    expect(prepared).not.toContain('PRIVATE_DISPATCH_OBJECTIVE');

    const context = await bindCodexDispatchContext(repoRoot, dir, dispatch);
    const bound = await readFile(statusDoc, 'utf8');
    expect(bound).toContain('dispatch_live');
    expect(bound).toContain('wait for pending receipt');

    await invokeCodexHook(repoRoot, {
      hook_event_name: 'SubagentStop',
      project_dir: dir,
      session_id: context.sessionId,
      agent_id: context.agentId,
      agent_type: 'default',
    });
    const stopped = await readFile(statusDoc, 'utf8');
    expect(stopped).toContain('dispatch_stopped');
    expect(stopped).toContain('ape_run resume');
  }, 30_000);

  it('persists merge provenance only for HTTPS credential-free provider hosts and canonical refs', async () => {
    const cases = [
      ['http scheme', {
        provider: 'github',
        url: 'http://github.com/acme/repo/pull/1',
        branch: 'ape/phase-safe',
        base: 'main',
        merged_at: '2026-08-22T05:00:05.000Z',
      }],
      ['credentials', {
        provider: 'github',
        url: 'https://PRIVATE_USER:PRIVATE_PASSWORD@github.com/acme/repo/pull/1',
        branch: 'ape/phase-safe',
        base: 'main',
        merged_at: '2026-08-22T05:00:05.000Z',
      }],
      ['foreign host', {
        provider: 'github',
        url: 'https://PRIVATE_HOST.example/acme/repo/pull/1',
        branch: 'ape/phase-safe',
        base: 'main',
        merged_at: '2026-08-22T05:00:05.000Z',
      }],
      ['provider-host mismatch', {
        provider: 'github',
        url: 'https://gitlab.com/acme/repo/merge_requests/1',
        branch: 'ape/phase-safe',
        base: 'main',
        merged_at: '2026-08-22T05:00:05.000Z',
      }],
      ['noncanonical branch', {
        provider: 'github',
        url: 'https://github.com/acme/repo/pull/1',
        branch: '../PRIVATE_BRANCH',
        base: 'main',
        merged_at: '2026-08-22T05:00:05.000Z',
      }],
      ['noncanonical base', {
        provider: 'github',
        url: 'https://github.com/acme/repo/pull/1',
        branch: 'ape/phase-safe',
        base: 'refs/heads/../PRIVATE_BASE',
        merged_at: '2026-08-22T05:00:05.000Z',
      }],
    ];
    for (const [label, merge] of cases) {
      const dir = await sandbox(`ape-diagnostic-merge-${label.replaceAll(' ', '-')}-`);
      const archived = await archiveRun(runtimePaths(dir), runState({
        run_id: `run-merge-${label.replaceAll(' ', '-')}`,
        status: 'completed',
        stage: 'completed',
        completed_at: '2026-08-22T05:00:05.000Z',
        requirements: [],
        base_commit_sha: 'a'.repeat(40),
        tree_sha: 'b'.repeat(40),
        merge,
      }));
      expect(archived.merge).toBeNull();
      expect(archived.objective).toBe('PRIVATE_OBJECTIVE_DO_NOT_RENDER');
      const explanation = explainRun(archived);
      expect(explanation).toContain('Merge: not recorded.');
      expect(explanation).not.toContain('PRIVATE_');
    }

    const dir = await sandbox('ape-diagnostic-merge-valid-provider-');
    const merge = {
      provider: 'github',
      url: 'https://github.com/acme/repo/pull/7',
      branch: 'ape/phase-safe',
      base: 'main',
      merged_at: '2026-08-22T05:00:05.000Z',
    };
    const archived = await archiveRun(runtimePaths(dir), runState({
      run_id: 'run-merge-valid-provider',
      status: 'completed',
      stage: 'completed',
      completed_at: '2026-08-22T05:00:05.000Z',
      requirements: [],
      base_commit_sha: 'a'.repeat(40),
      tree_sha: 'b'.repeat(40),
      merge,
    }));
    expect(archived.merge).toEqual(merge);
    expect(explainRun(archived)).toContain('Merged: recorded.');
  });

  it('rejects accessor-backed optional archive data before invoking it', async () => {
    const dir = await sandbox('ape-diagnostic-archive-accessor-');
    const archived = await archiveRun(runtimePaths(dir), runState({
      run_id: 'run-archive-accessor',
      status: 'completed',
      stage: 'completed',
      completed_at: '2026-08-22T05:00:05.000Z',
      requirements: [],
      base_commit_sha: 'a'.repeat(40),
      tree_sha: 'b'.repeat(40),
    }));
    let reads = 0;
    Object.defineProperty(archived, 'model_tier', {
      enumerable: true,
      get() {
        reads += 1;
        throw new Error('PRIVATE_OPTIONAL_ARCHIVE_GETTER');
      },
    });

    const explanation = explainRun(archived);
    expect(reads).toBe(0);
    expect(explanation).toContain('Reason code: incomplete_record');
    expect(explanation).not.toContain('PRIVATE_OPTIONAL_ARCHIVE_GETTER');
  });

  it('omits unsupported active, archive, and ticket model tiers without echoing them', async () => {
    const secret = 'PRIVATE_UNSUPPORTED_MODEL_TIER';
    const { status } = await statusFor(runState({
      model_tier: secret,
      tickets: [{
        ticket_id: 'run-fixture-diagnostics:implement:ticket',
        stage_id: 'implement',
        role: 'implementer',
        model_tier: secret,
      }],
    }));
    expectDiagnostic(status.diagnostic, 'stage_active', 'ape_run next');
    expect(JSON.stringify(status)).not.toContain(secret);

    const dir = await sandbox('ape-diagnostic-model-tier-archive-');
    const archived = await archiveRun(runtimePaths(dir), runState({
      run_id: 'run-model-tier-archive',
      status: 'completed',
      stage: 'completed',
      completed_at: '2026-08-22T05:00:05.000Z',
      requirements: [],
      base_commit_sha: 'a'.repeat(40),
      tree_sha: 'b'.repeat(40),
      model_tier: secret,
      tickets: [{
        ticket_id: 'run-model-tier-archive:implement:ticket',
        stage_id: 'implement',
        role: 'implementer',
        model_tier: secret,
      }],
      receipts: [{
        ticket_id: 'run-model-tier-archive:implement:ticket',
        status: 'passed',
      }],
    }));
    const explanation = explainRun(archived);
    expect(explanation).toContain('Reason code: completed');
    expect(explanation).not.toContain(secret);
  });

  it('recomputes archive hashes instead of trusting hash-shaped compatibility evidence', async () => {
    const dir = await sandbox('ape-diagnostic-archive-hash-');
    const persisted = await archiveRun(runtimePaths(dir), runState({
      run_id: 'run-archive-hash-check',
      status: 'completed',
      stage: 'completed',
      completed_at: '2026-08-22T05:00:05.000Z',
      requirements: [],
      base_commit_sha: 'a'.repeat(40),
      tree_sha: 'b'.repeat(40),
    }));
    const archived = withContractHash({ ...persisted, record_hash: undefined }, 'modern');
    expect(archived.record_hash).toMatch(/^[0-9a-f]{64}$/);
    const forged = { ...archived, objective: 'PRIVATE_HASH_TAMPER' };
    const explanation = explainRun(forged);
    expect(explanation).toContain('Reason code: incomplete_record');
    expect(explanation).not.toContain('PRIVATE_HASH_TAMPER');
  });

  it('keeps nested ticket and receipt compatibility exclusive to hash-verified archives', async () => {
    const malformedActive = runState({
      tickets: [{ ticket_id: 'run-fixture-diagnostics:implement:ticket' }],
      receipts: [{ ticket_id: 'run-fixture-diagnostics:implement:ticket' }],
    });
    const { status } = await statusFor(malformedActive);
    expectDiagnostic(status.diagnostic, 'corrupt_state', 'ape_run override reset');

    const dir = await sandbox('ape-diagnostic-legacy-nested-archive-');
    const persisted = await archiveRun(runtimePaths(dir), runState({
      run_id: 'run-legacy-nested-archive',
      status: 'completed',
      stage: 'completed',
      completed_at: '2026-08-22T05:00:05.000Z',
      requirements: [],
      base_commit_sha: 'a'.repeat(40),
      tree_sha: 'b'.repeat(40),
      tickets: [{ ticket_id: 'run-legacy-nested-archive:implement:ticket' }],
      receipts: [{ ticket_id: 'run-legacy-nested-archive:implement:ticket' }],
    }));
    const archived = withContractHash({ ...persisted, record_hash: undefined }, 'modern');
    expect(archived.record_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(explainRun(archived)).toContain('Reason code: completed');

    const unverified = { ...archived, record_hash: 'f'.repeat(64), objective: 'PRIVATE_UNVERIFIED_NESTED' };
    const explanation = explainRun(unverified);
    expect(explanation).toContain('Reason code: incomplete_record');
    expect(explanation).not.toContain('PRIVATE_UNVERIFIED_NESTED');
  });

  it('rejects legacy-looking stage identifiers in active nested tickets', async () => {
    const { status } = await statusFor(runState({
      tickets: [{
        ticket_id: 'run-fixture-diagnostics:stage-123:ticket',
        stage_id: 'stage-123',
        role: 'implementer',
      }],
      receipts: [{
        ticket_id: 'run-fixture-diagnostics:stage-123:ticket',
        status: 'passed',
      }],
    }));

    expectDiagnostic(status.diagnostic, 'corrupt_state', 'ape_run override reset');
    expect(status).not.toHaveProperty('facts');
  });

  it('does not grant compatibility to named hashes or unverified legacy merge shapes', () => {
    const forgedNamedHash = runState({
      run_id: 'run-forged-named-archive-hash',
      status: 'completed',
      record_hash: 'record-hash-forged-compatibility',
      tickets: [{ ticket_id: 'run-forged-named-archive-hash:implement:ticket' }],
      receipts: [{ ticket_id: 'run-forged-named-archive-hash:implement:ticket' }],
    });
    delete forgedNamedHash.stage;
    delete forgedNamedHash.host;
    delete forgedNamedHash.dispatch_state;

    const namedExplanation = explainRun(forgedNamedHash);
    expect(namedExplanation).toContain('Reason code: incomplete_record');
    expect(namedExplanation).not.toContain('completed');

    const legacyMerge = runState({
      run_id: 'run-unverified-legacy-merge',
      status: 'completed',
      stage: 'completed',
      completed_at: '2026-08-22T05:00:05.000Z',
      merge: { url: 'https://github.com/acme/repo/pull/9' },
    });
    const mergeExplanation = explainRun(legacyMerge);
    expect(mergeExplanation).toContain('Reason code: incomplete_record');
    expect(mergeExplanation).toContain('Merge: not recorded.');
  });

  it('rejects imported archives whose retained digest was not recomputed', () => {
    const imported = runState({
      run_id: 'run-imported-retained-digest',
      imported: true,
      mode: 'import',
      status: 'unknown',
      objective: 'PRIVATE_TAMPERED_IMPORTED_OBJECTIVE',
      record_hash: 'a'.repeat(64),
      tickets: [],
      receipts: [],
    });

    const explanation = explainRun(imported);
    expect(explanation).toContain('Reason code: incomplete_record');
    expect(explanation).not.toContain('PRIVATE_TAMPERED_IMPORTED_OBJECTIVE');
    expect(explanation).not.toContain('legacy_record');
  });

  it('accepts only imported archives whose explicit imported contract hash recomputes', () => {
    const imported = withContractHash({
      run_id: 'run-imported-verified-digest',
      imported: true,
      objective: 'Imported legacy planning record docs/legacy.md',
      mode: 'import',
      status: 'unknown',
      requirements: ['R1'],
      source_path: 'docs/legacy.md',
      source_hash: 'a'.repeat(64),
      plan_id: 'legacy-plan',
      evidence_references: [],
      imported_at: '2026-08-22T05:00:05.000Z',
      tickets: [],
      receipts: [],
    }, 'imported');

    expect(explainRun(imported)).toContain('Reason code: legacy_record');
    const mismatched = { ...imported, source_path: 'PRIVATE_IMPORTED_TAMPER' };
    const explanation = explainRun(mismatched);
    expect(explanation).toContain('Reason code: incomplete_record');
    expect(explanation).not.toContain('PRIVATE_IMPORTED_TAMPER');
  });

  it('preserves objective data when invalid merge provenance is discarded at archival', async () => {
    const dir = await sandbox('ape-diagnostic-invalid-merge-objective-');
    const objective = 'Preserve this unrelated immutable objective';
    const archived = await archiveRun(runtimePaths(dir), runState({
      run_id: 'run-invalid-merge-objective',
      objective,
      status: 'completed',
      stage: 'completed',
      completed_at: '2026-08-22T05:00:05.000Z',
      requirements: [],
      base_commit_sha: 'a'.repeat(40),
      tree_sha: 'b'.repeat(40),
      merge: {
        provider: 'github',
        url: 'http://github.com/acme/repo/pull/1',
        branch: 'ape/phase-objective',
        base: 'main',
        merged_at: '2026-08-22T05:00:05.000Z',
      },
    }));

    expect(archived.merge).toBeNull();
    expect(archived.objective).toBe(objective);
  });

  it('omits hostile merge bytes at every projection while retaining independent archive data', async () => {
    const secret = 'PRIVATE_HOSTILE_MERGE_BYTES';
    const merge = {
      provider: 'github',
      url: `https://${secret}:password@github.com/acme/repo/pull/12`,
      branch: 'ape/phase-safe-objective',
      base: 'main',
      merged_at: '2026-08-22T05:00:05.000Z',
    };
    const dir = await sandbox('ape-diagnostic-hostile-merge-surfaces-');
    const active = runState({ objective: 'Safe independent objective', merge });
    await atomicWriteJson(runtimePaths(dir).active, active);

    const compact = await compactStatus(dir);
    expectDiagnostic(compact.diagnostic, 'stage_active', 'ape_run next');
    const rootLine = plainStatusline(dir);
    const statusDoc = renderStatusDoc(active);
    for (const surface of [JSON.stringify(compact), rootLine, statusDoc]) {
      expect(surface).not.toContain(secret);
      expect(surface).not.toContain('password');
    }

    const archived = await archiveRun(runtimePaths(dir), {
      ...active,
      status: 'completed',
      stage: 'completed',
      completed_at: '2026-08-22T05:00:05.000Z',
      requirements: [],
      base_commit_sha: 'a'.repeat(40),
      tree_sha: 'b'.repeat(40),
    });
    expect(archived.objective).toBe('Safe independent objective');
    expect(archived.merge).toBeNull();
    const explained = explainRun(archived);
    expect(explained).toContain('Reason code: completed');
    expect(explained).not.toContain(secret);
    expect(explained).not.toContain('password');

    const output = await sandbox('ape-diagnostic-hostile-merge-package-');
    execFileSync('node', [packageBuilder, '--output-root', output], { cwd: repoRoot, encoding: 'utf8' });
    const packagedLine = plainStatusline(
      dir,
      path.join(output, 'ape-claude', 'bin', 'ape-statusline.mjs'),
    );
    expect(packagedLine).not.toContain(secret);
    expect(packagedLine).not.toContain('password');
  }, 30_000);

  it('validates every diagnostic fact collection before accessing max-plus-one tails', async () => {
    const { MAX_DIAGNOSTIC_COLLECTION, projectRunDiagnostic } = await import('../lib/runtime/diagnostics.js');
    const cases = [
      ['input_required.questions', (state, values) => {
        state.input_required = { questions: values, question_ids: [] };
      }, (index) => ({ id: `Q${index}` })],
      ['input_required.question_ids', (state, values) => {
        state.input_required = { questions: [], question_ids: values };
      }, (index) => `Q${index}`],
      ['input_hold.question_ids', (state, values) => {
        state.input_hold = { occurred: true, question_ids: values };
      }, (index) => `Q${index}`],
      ['preflight.answers', (state, values) => {
        state.preflight = { answers: values };
      }, (index) => ({ id: `Q${index}` })],
      ['preflight.artifact.profiles', (state, values) => {
        state.preflight = { artifact: { profiles: values } };
      }, (index) => ({ id: `profile-${index}` })],
      ['profiles', (state, values) => {
        state.profiles = values;
      }, (index) => ({ id: `profile-${index}` })],
      ['claimed_paths', (state, values) => {
        state.claimed_paths = values;
      }, (index) => `src/path-${index}.js`],
      ['test_paths', (state, values) => {
        state.test_paths = values;
      }, (index) => `tests/path-${index}.test.js`],
      ['verification_profiles', (state, values) => {
        state.verification_profiles = values;
      }, (index) => ({ id: `profile-${index}`, disposition: 'required' })],
      ['preflight.artifact.verification_profiles', (state, values) => {
        state.preflight = { artifact: { verification_profiles: values } };
      }, (index) => ({ id: `profile-${index}`, disposition: 'required' })],
      ['remediation_route.test_paths', (state, values) => {
        state.remediation_route = { route: 'test', cycle: 1, test_paths: values };
      }, (index) => `tests/path-${index}.test.js`],
    ];

    for (const [label, assign, makeValue] of cases) {
      let reads = 0;
      const values = Array.from(
        { length: MAX_DIAGNOSTIC_COLLECTION + 1 },
        (_, index) => makeValue(index),
      );
      Object.defineProperty(values, MAX_DIAGNOSTIC_COLLECTION, {
        enumerable: true,
        get() {
          reads += 1;
          throw new Error(`PRIVATE_${label}_TAIL_READ`);
        },
      });
      const state = runState();
      assign(state, values);
      const diagnostic = projectRunDiagnostic(state);
      expect(reads, label).toBe(0);
      expectDiagnostic(diagnostic, 'corrupt_state', 'ape_run override reset');
      expect(JSON.stringify(diagnostic)).not.toContain('PRIVATE_');
    }

    const sparse = Array(MAX_DIAGNOSTIC_COLLECTION);
    sparse[0] = { id: 'profile-0' };
    const sparseDiagnostic = projectRunDiagnostic(runState({ profiles: sparse }));
    expectDiagnostic(sparseDiagnostic, 'corrupt_state', 'ape_run override reset');
  });

  it('accepts historical patch mode only when its archive hash verifies', async () => {
    const active = await statusFor(runState({ mode: 'patch' }));
    expectDiagnostic(active.status.diagnostic, 'corrupt_state', 'ape_run override reset');

    const dir = await sandbox('ape-diagnostic-patch-archive-');
    const persisted = await archiveRun(runtimePaths(dir), runState({
      run_id: 'run-historical-patch-mode',
      mode: 'patch',
      status: 'completed',
      stage: 'completed',
      completed_at: '2026-08-22T05:00:05.000Z',
      requirements: [],
      base_commit_sha: 'a'.repeat(40),
      tree_sha: 'b'.repeat(40),
    }));
    const archived = withContractHash({ ...persisted, record_hash: undefined }, 'historical');
    expect(archived.record_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(explainRun(archived)).toContain('Reason code: completed');

    const unverified = { ...archived, record_hash: '0'.repeat(64), objective: 'PRIVATE_PATCH_TAMPER' };
    const explanation = explainRun(unverified);
    expect(explanation).toContain('Reason code: incomplete_record');
    expect(explanation).not.toContain('PRIVATE_PATCH_TAMPER');
  });

  it('keeps the default diagnostic payload bounded to stable facts', async () => {
    const sentinels = [
      'PRIVATE_INCIDENT_OBJECTIVE',
      'PRIVATE_CLAIMED_PATH',
      'PRIVATE_TEST_PATH',
      'PRIVATE_RECEIPT_PROSE',
      'PRIVATE_RECEIPT_CAPABILITY',
      'PRIVATE_PROMPT',
      'PRIVATE_COMMAND',
      'PRIVATE_COMMAND_OUTPUT',
    ];
    const { status } = await statusFor(runState({
      objective: sentinels[0],
      claimed_paths: [`src/${sentinels[1]}.js`],
      test_paths: [`tests/${sentinels[2]}.test.js`],
      prompt: sentinels[5],
      status: 'blocked',
      stage: 'implement',
      gates: {
        passed: false,
        checks: {
          'targeted-test': {
            passed: false,
            command: `node ${sentinels[6]}`,
            output: sentinels[7],
          },
        },
      },
      receipts: [{
        ticket_id: 'run-fixture-diagnostics:implement:ticket',
        status: 'failed',
        findings: [{ summary: sentinels[3] }],
        evidence: { summary: sentinels[3] },
        receipt_capability: sentinels[4],
        timing: {
          started_at: '2026-08-22T05:00:00.000Z',
          completed_at: '2026-08-22T05:00:04.000Z',
        },
      }],
    }));

    const diagnostic = status.diagnostic;
    expect(Object.keys(diagnostic).sort()).toEqual([
      'failed_checks',
      'next_safe_action',
      'reason_code',
      'recovery_rationale',
      'stage_timing',
    ]);
    expect(diagnostic).toMatchObject({
      reason_code: 'gate_failed',
      next_safe_action: 'ape_run regate',
      recovery_rationale: expect.any(String),
      failed_checks: ['targeted-test'],
      stage_timing: {
        available: true,
        source: 'receipt_timestamps',
        stage_id: 'implement',
        duration_ms: 4000,
      },
    });
    expect(diagnostic.recovery_rationale.length).toBeLessThanOrEqual(240);
    expect(diagnostic.failed_checks.length).toBeLessThanOrEqual(32);
    const serialized = JSON.stringify(diagnostic);
    for (const sentinel of sentinels) expect(serialized).not.toContain(sentinel);
  });

});
