import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG, loadRuntimeConfig, resolveTicketDeadline, setRuntimeConfig } from '../lib/runtime/config.js';
import { MAX_TIMER_DELAY_MS } from '../lib/runtime/constants.js';
import { classifyLane, resolveLaneScope } from '../lib/runtime/lane-policy.js';
import { sha256 } from '../lib/runtime/canonical.js';
import {
  GENERAL_INPUT_MAX_BYTES,
  RECEIPT_INPUT_MAX_BYTES,
  TASK_REQUEST_MAX_BYTES,
  assertSafeReceiptRecoveryInput,
} from '../lib/runtime/input-guard.js';
import { receiptOutputSchemaForTicket, validateReceiptDraft } from '../lib/runtime/receipt-validator.js';
import { recoverReceiptLocked } from '../lib/runtime/receipt-service.js';
import { executionConfigForRun, executionPolicySnapshot, pipelineLimits, receiptLimits } from '../lib/runtime/pipeline-limits.js';
import { pipelineRunSpec, projectedPipeline } from '../lib/runtime/pipeline.js';
import { evaluateRunReadiness } from '../lib/runtime/readiness.js';
import { reduceRun } from '../lib/runtime/reducer.js';
import { finalizeTicket, validateTicket } from '../lib/runtime/schemas.js';
import { reviewFindings } from '../lib/runtime/review-evidence.js';
import { runtimeGuidanceForState } from '../lib/runtime/session-guidance.js';

const directories = [];
afterEach(async () => Promise.all(directories.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))));
async function fixture() {
  const dir = await mkdtemp(path.join(tmpdir(), 'ape-execution-limits-'));
  directories.push(dir);
  return dir;
}

describe('execution configuration represents the actual runtime domains', () => {
  it.each([
    ['deadlines_ms.fast', MAX_TIMER_DELAY_MS + 1],
    ['deadlines_ms.debug', Number.MAX_VALUE],
    ['deadlines_ms.full', 1.5],
    ['deadlines_ms.spike', -MAX_TIMER_DELAY_MS - 1],
    ['gates.heartbeat_ms', 0],
    ['gates.stale_ms', -1],
    ['gates.inline_grace_ms', -1],
    ['gates.poll_retry_delay_ms', MAX_TIMER_DELAY_MS + 1],
    ['gates.max_spawns', 2.5],
    ['gates.max_spawns', 0],
    ['policy.fast_max_files', 6.9],
    ['policy.fast_max_files', 0],
    ['policy.max_stage_attempts', 0],
    ['policy.max_directed_replans', -1],
    ['policy.max_remediation_cycles', null],
    ['policy.max_physical_workers_per_ticket', 1.5],
    ['policy.max_validation_submissions_per_worker', Number.MAX_SAFE_INTEGER],
    ['shipping.checks_registration_window_ms', -1],
    ['shipping.checks_registration_retry_delay_ms', 0],
  ])('rejects %s=%s before replacing configuration bytes', async (key, value) => {
    const dir = await fixture();
    const file = path.join(dir, 'config.json');
    await setRuntimeConfig(file, 'policy.fast_max_files', 8);
    const before = await readFile(file, 'utf8');
    await expect(setRuntimeConfig(file, key, value)).rejects.toThrow(/integer/);
    expect(await readFile(file, 'utf8')).toBe(before);
  });

  it('checks nested updates and invalid legacy configuration at load', async () => {
    const dir = await fixture();
    const file = path.join(dir, 'config.json');
    await expect(setRuntimeConfig(file, 'gates', { heartbeat_ms: 0 })).rejects.toThrow(/gates\.heartbeat_ms/);
    await writeFile(file, JSON.stringify({ deadlines_ms: { fast: MAX_TIMER_DELAY_MS + 1 } }));
    await expect(loadRuntimeConfig(file)).rejects.toThrow(/deadlines_ms\.fast/);
  });

  it('preserves representable immediate expiry and optional zero waiting', async () => {
    const dir = await fixture();
    const file = path.join(dir, 'config.json');
    for (const deadline of [-MAX_TIMER_DELAY_MS, -1, 0, MAX_TIMER_DELAY_MS]) {
      await setRuntimeConfig(file, 'deadlines_ms.debug', deadline);
      expect(resolveTicketDeadline(await loadRuntimeConfig(file), 'debug', 'full').deadline_ms).toBe(deadline);
    }
    await setRuntimeConfig(file, 'gates.inline_grace_ms', 0);
    await setRuntimeConfig(file, 'gates.poll_retry_delay_ms', 0);
    expect((await loadRuntimeConfig(file)).gates).toMatchObject({ inline_grace_ms: 0, poll_retry_delay_ms: 0 });
    expect(() => resolveTicketDeadline({ deadlines_ms: { fast: MAX_TIMER_DELAY_MS + 1 } }, 'phase', 'fast')).toThrow(/integer/);
  });
});

function policyRun(limits = {}, overrides = {}) {
  const config = structuredClone(DEFAULT_CONFIG);
  Object.assign(config.policy, limits);
  return { run_id: 'run-policy-limits', mode: 'phase', lane: 'fast', status: 'running',
    stage: 'build', tickets: [], receipts: [], attempts: {}, remediation_cycles: 0,
    execution_policy: executionPolicySnapshot(config), ...overrides };
}

function failedStage(run, stageId, evidence = {}) {
  const ticket = { ticket_id: `t-${stageId}`, stage_id: stageId, role: 'implementer',
    ...(stageId === 'test-recheck' ? { test_reconciliation: { version: 1, attempt: 1,
      source_ticket_id: 'source', source_stage_id: 'build', report: 'one contradiction', test_paths: ['t.js'] } } : {}) };
  const receipt = { ticket_id: ticket.ticket_id, status: 'failed', evidence };
  run.tickets = [ticket];
  run.receipts = [receipt];
  return reduceRun(run, { type: 'RECEIPT_RECORDED', ticket, receipt,
    stage: { id: stageId, role: ticket.role }, next_state: run });
}

describe('operator execution policy stays exact across run and ticket boundaries', () => {
  it('freezes counts, lane threshold, deadlines, gate timing and registration timing at admission', () => {
    const config = structuredClone(DEFAULT_CONFIG);
    Object.assign(config.policy, { max_stage_attempts: 4, max_directed_replans: 5,
      max_worker_protocol_redispatches_per_stage: 3, max_remediation_cycles: 12,
      max_regate_attempts: 6, max_physical_workers_per_ticket: 4,
      max_validation_submissions_per_worker: 5, max_reconciliation_stage_attempts: 3,
      max_reconciliation_protocol_redispatches: 2, fast_max_files: 20 });
    config.deadlines_ms.debug = 12345;
    config.gates.max_spawns = 5;
    config.gates.heartbeat_ms = 700;
    config.shipping.checks_registration_window_ms = 999;
    config.shipping.checks_registration_retry_delay_ms = 111;
    const run = { execution_policy: executionPolicySnapshot(config) };
    const changed = structuredClone(DEFAULT_CONFIG);
    const resolved = executionConfigForRun(changed, run);
    expect(resolved.policy).toEqual(config.policy);
    expect(resolved.deadlines_ms).toEqual(config.deadlines_ms);
    expect(resolved.gates).toEqual(config.gates);
    expect(resolved.shipping).toEqual(config.shipping);
    expect(executionConfigForRun(changed, {})).toBe(changed);
    expect(pipelineLimits({ ...run, policy: changed.policy })).toEqual(run.execution_policy.limits);
    const forecast = projectedPipeline({ ...run, mode: 'phase', lane: 'full', behavioral: true });
    expect(forecast.dispatch_bounds.by_stage.build).toBe(4);
    expect(() => projectedPipeline({ mode: 'phase', lane: 'full', policy: {
      max_stage_attempts: Number.MAX_SAFE_INTEGER,
    } })).toThrow(/safe integer/);
  });

  it('retries through a configured third stage attempt and preserves legacy two-attempt behavior', () => {
    const run = policyRun({ max_stage_attempts: 3 }, { attempts: { build: 2 } });
    expect(failedStage(run, 'build')).toContainEqual(expect.objectContaining({ type: 'issue_ticket', recovery_kind: 'stage_retry' }));
    expect(failedStage({ ...run, attempts: { build: 3 } }, 'build').some((entry) => entry.type === 'issue_ticket')).toBe(false);
    delete run.execution_policy;
    expect(failedStage(run, 'build').some((entry) => entry.type === 'issue_ticket')).toBe(false);
  });

  it('does not charge default logical stages again when validating the two receipt counters', () => {
    const limits = pipelineLimits({ policy: { max_stage_attempts: 1, max_directed_replans: 0,
      max_remediation_cycles: 0, max_worker_protocol_redispatches_per_stage: 0,
      max_reconciliation_stage_attempts: 1, max_reconciliation_protocol_redispatches: 0,
      max_physical_workers_per_ticket: 2_000_000_000_000_000, max_validation_submissions_per_worker: 1 } });
    expect(projectedPipeline({ mode: 'debug', execution_limits: limits }).dispatch_bounds.physical_dispatch_upper_bound)
      .toBe(2_000_000_000_000_000);
    expect(receiptLimits({ execution_limits: limits })).toEqual({
      max_physical_workers_per_ticket: 2_000_000_000_000_000, max_validation_submissions_per_worker: 1 });
    expect(() => receiptLimits({ receipt_limits: { max_physical_workers_per_ticket: Number.MAX_SAFE_INTEGER,
      max_validation_submissions_per_worker: 2 } })).toThrow(/safe integer/);
  });

  it('removes disabled recovery branches before capability admission while retaining mandatory work', () => {
    const config = structuredClone(DEFAULT_CONFIG);
    config.policy.max_remediation_cycles = 0;
    config.policy.max_directed_replans = 0;
    // With remediation disabled, this mechanical run cannot issue a test
    // writer and does not need a targeted test command solely for recovery.
    const input = { objective: 'Adjust documentation', host: 'codex', mode: 'phase', lane: 'mechanical',
      behavioral: false, claimed_paths: ['README.md'], test_paths: [], requirements: [], required_capabilities: [] };
    const classification = { lane: 'mechanical', risk_triggers: [], reasons: [] };
    const projection = projectedPipeline(pipelineRunSpec(input, classification, config));
    expect(projection.stages.map((entry) => entry.id)).toEqual(['build', 'security-review']);
    expect(projection.conditional_branches.some((entry) => entry.id === 'remediation')).toBe(false);
    expect(projection.dispatch_bounds.by_role).not.toHaveProperty('test_writer');
    const readiness = evaluateRunReadiness({ input, config, classification, projection });
    expect(readiness.blocking.filter((entry) => /test-command|targeted|test-writer/.test(entry.code))).toEqual([]);
    expect(readiness.ready).toBe(true);
    const full = projectedPipeline({ mode: 'phase', lane: 'full', behavioral: true, policy: config.policy });
    expect(full.stages.map((entry) => entry.id)).toEqual(expect.arrayContaining(['plan', 'plan-check', 'plan-critic',
      'plan-judge', 'test', 'build', 'review', 'security-review']));
    expect(full.stages.some((entry) => entry.id === 'plan-replan' || entry.id.startsWith('remediation-'))).toBe(false);
    expect(full.dispatch_bounds.by_stage).not.toHaveProperty('plan-replan');
  });

  it('allows configured reconciliation retries inside the original nonrecursive contract', () => {
    const run = policyRun({ max_reconciliation_stage_attempts: 2 }, {
      attempts: { 'test-recheck': 1 }, test_contradiction_reconciliations: 1,
    });
    const retry = failedStage(run, 'test-recheck');
    expect(retry).toContainEqual(expect.objectContaining({ type: 'issue_ticket', recovery_kind: 'stage_retry',
      test_reconciliation: expect.objectContaining({ attempt: 1, source_ticket_id: 'source' }) }));
    expect(failedStage({ ...run, attempts: { 'test-recheck': 2 } }, 'test-recheck')
      .some((entry) => entry.type === 'issue_ticket')).toBe(false);
  });

  it('charges every configured protocol redispatch and refuses authority failures without retry', () => {
    const run = policyRun({ max_worker_protocol_redispatches_per_stage: 2 }, {
      worker_protocol_redispatches: { build: 1 },
    });
    const second = failedStage(run, 'build', { failure_kind: 'protocol' });
    expect(second).toContainEqual(expect.objectContaining({ type: 'transition',
      patch: expect.objectContaining({ worker_protocol_redispatches: { build: 2 } }) }));
    expect(second).toContainEqual(expect.objectContaining({ type: 'issue_ticket', recovery_kind: 'reissue_same_contract' }));
    expect(failedStage({ ...run, worker_protocol_redispatches: { build: 2 } }, 'build', { failure_kind: 'protocol' })
      .some((entry) => entry.type === 'issue_ticket')).toBe(false);
    expect(failedStage(run, 'build', { failure_kind: 'capability' })
      .some((entry) => entry.type === 'issue_ticket')).toBe(false);
  });

  it('uses configured regate authority after the third attempt and honors zero optional recovery', () => {
    const run = policyRun({ max_regate_attempts: 4 }, { status: 'blocked', stage: 'gates', regate_attempts: 3 });
    expect(reduceRun(run, { type: 'REGATE' }).some((entry) => entry.type === 'run_gates')).toBe(true);
    expect(reduceRun({ ...run, regate_attempts: 4 }, { type: 'REGATE' })
      .some((entry) => entry.type === 'run_gates')).toBe(false);
    expect(reduceRun(policyRun({ max_regate_attempts: 0 }, { status: 'blocked', stage: 'gates' }),
      { type: 'REGATE' }).some((entry) => entry.type === 'run_gates')).toBe(false);
  });

  it('validates new ticket policy exactly while retaining legacy attempt bounds', () => {
    const ticket = { schema_version: '2.0.0', ticket_id: 'run-policy:build:t', run_id: 'run-policy',
      stage_id: 'build', parallel_group: null, role: 'implementer', objective: 'change one file',
      claimed_paths: ['a.js'], test_paths: [], model_tier: 'balanced', model: {},
      deadline_at: new Date().toISOString(), output_schema: {}, required_checks: [], parent_hash: null,
      base_tree_sha: 'a'.repeat(40), attempt: 3, writable: true, issued_at: new Date().toISOString(),
      execution_limits: pipelineLimits({ policy: { max_stage_attempts: 3 } }) };
    expect(finalizeTicket(ticket).attempt).toBe(3);
    const { execution_limits, ...legacy } = ticket;
    expect(() => finalizeTicket(legacy)).toThrow(/attempt/);
    expect(() => validateTicket({ ...ticket, ticket_hash: 'b'.repeat(64),
      execution_limits: { ...execution_limits, max_stage_attempts: -1 } })).not.toThrow();
  });

  it('retains complete modern assurance feedback and still requires strict progress after two replans', () => {
    const run = policyRun({ max_directed_replans: 3 }, { mode: 'phase', lane: 'full', plan_replan_cycles: 2 });
    const ticket = { ticket_id: 'judge', stage_id: 'plan-judge', role: 'plan_judge',
      capability_manifest: { byte_budgets: { candidate_plan_utf8_bytes: GENERAL_INPUT_MAX_BYTES } } };
    const values = Array.from({ length: 25 }, (_, index) => ({ summary: `assurance ${index} ${'x'.repeat(650)}` }));
    const receipt = { ticket_id: 'judge', status: 'passed', evidence: { verdict: 'disagree', missing_assurances: values } };
    const recovery = reviewFindings.planRecovery(run, ticket, receipt);
    expect(recovery.missing_assurances).toHaveLength(25);
    expect(recovery.missing_assurances[0].summary).toBe(values[0].summary);
    expect(reviewFindings.planRecovery(run, { ...ticket, capability_manifest: undefined }, receipt)
      .missing_assurances).toHaveLength(16);
    run.plan_recovery = recovery;
    const event = { type: 'RECEIPT_RECORDED', ticket, receipt: { ...receipt,
      evidence: { ...receipt.evidence, missing_assurances: values.slice(1) } },
      stage: { id: 'plan-judge', role: 'plan_judge' }, next_state: run };
    expect(reduceRun(run, event)).toContainEqual(expect.objectContaining({ type: 'issue_ticket', recovery_kind: 'directed_replan' }));
    expect(reduceRun(run, { ...event, receipt }).some((entry) => entry.type === 'issue_ticket')).toBe(false);
    expect(reduceRun({ ...run, plan_replan_cycles: 3 }, event).some((entry) => entry.type === 'issue_ticket')).toBe(false);
  });

  it('does not label a long versioned ticket history unversioned in session guidance', () => {
    const run = policyRun({}, { host: 'codex', version: 2, schema_version: '2.0.0',
      tickets: Array.from({ length: 300 }, (_, index) => ({ ticket_id: `t-${index}`,
        stage_id: 'build', role: 'implementer', receipt_contract_version: 1 })) });
    expect(runtimeGuidanceForState(run)).toContain('receipt contract v1');
    expect(runtimeGuidanceForState(run)).not.toContain('receipt contract unversioned');
  });
});

describe('fast lane counts concrete scope without assuming a directory is one file', () => {
  it('deduplicates equivalent concrete paths while preserving prospective files', async () => {
    const dir = await fixture();
    await mkdir(path.join(dir, 'src'));
    await writeFile(path.join(dir, 'src', 'a.js'), 'export const a = 1;\n');
    const claims = ['src/a.js', './src/a.js', 'src/../src/a.js', 'src/b.js', 'src/c.js', 'src/d.js', 'src/e.js', 'src/f.js'];
    const input = await resolveLaneScope(dir, { behavioral: true, claimed_paths: claims });
    expect(classifyLane(input).lane).toBe('fast');
    expect(classifyLane({ ...input, claimed_paths: [...claims, 'src/g.js'] })).toMatchObject({ lane: 'full', reasons: ['scope-over-6-files'] });
  });

  it('keeps broad existing or prospective directory claims out of fast scope', async () => {
    const dir = await fixture();
    await mkdir(path.join(dir, 'src'));
    await writeFile(path.join(dir, 'src', 'a.js'), 'export const a = 1;\n');
    for (const claims of [['src'], ['src', 'src/a.js'], ['future/'], ['future', 'future/a.js']]) {
      const input = await resolveLaneScope(dir, { behavioral: true, requested_lane: 'fast', claimed_paths: claims });
      expect(classifyLane(input)).toMatchObject({ lane: 'full', reasons: ['requested-fast-escalated', 'unbounded-scope'] });
    }
  });
});

describe('receipt recovery preserves the exact draft input allowance', () => {
  it('admits a valid 128 KiB draft with separately bounded recovery metadata', async () => {
    const ticket = { ticket_id: 'r:build:t', role: 'implementer', stage_id: 'build', objective: 'o',
      claimed_paths: ['a.js'], test_paths: [], required_checks: [], receipt_contract_version: 1 };
    ticket.capability_manifest = { version: 1, objective_hash: sha256(ticket.objective), allowed_evidence_commands: [] };
    ticket.output_schema = receiptOutputSchemaForTicket(ticket);
    ticket.capability_manifest.receipt_schema = { ref: 'ticket.output_schema', hash: sha256(ticket.output_schema) };
    const draft = { ticket_id: ticket.ticket_id, status: 'passed', tests: [], findings: [],
      evidence: { observation: '' }, receipt_capability: 'a'.repeat(32) };
    draft.evidence.observation = 'x'.repeat(RECEIPT_INPUT_MAX_BYTES - Buffer.byteLength(JSON.stringify(draft)));
    expect(Buffer.byteLength(JSON.stringify(draft))).toBe(RECEIPT_INPUT_MAX_BYTES);
    expect(validateReceiptDraft(ticket, draft)).toMatchObject({ valid: true, corrections: [] });
    const recovery = { reason: '', receipt_input_hash: '0'.repeat(64) };
    recovery.reason = 'r'.repeat(GENERAL_INPUT_MAX_BYTES - Buffer.byteLength(JSON.stringify({ receipt: null, recovery })));
    expect(Buffer.byteLength(JSON.stringify({ receipt: null, recovery }))).toBe(GENERAL_INPUT_MAX_BYTES);
    const checked = assertSafeReceiptRecoveryInput(draft, recovery);
    expect(checked.receipt).toBe(draft);
    expect(Buffer.byteLength(JSON.stringify(checked))).toBeLessThanOrEqual(TASK_REQUEST_MAX_BYTES);

    // A deliberately mismatched hash stops before any state read or effect,
    // while exercising the recovery service's real ingress guard.
    await expect(recoverReceiptLocked('/unused-receipt-recovery-fixture', draft, recovery)).resolves.toMatchObject({
      ok: false,
      rejected: true,
      errors: ['recover-receipt receipt_input_hash does not match the normalized exact draft'],
    });
    expect(() => assertSafeReceiptRecoveryInput(draft, { ...recovery, reason: `${recovery.reason}x` }))
      .toThrow(`input exceeds ${GENERAL_INPUT_MAX_BYTES} UTF-8 bytes`);
    expect(() => assertSafeReceiptRecoveryInput({ ...draft, extra: 'x' }, {}))
      .toThrow(`input exceeds ${RECEIPT_INPUT_MAX_BYTES} UTF-8 bytes`);
  });

  it('retains prototype, nesting and collection guards for receipt and recovery inputs', () => {
    let deep = 'leaf';
    for (let index = 0; index < 33; index += 1) deep = { nested: deep };
    for (const [invalid, message] of [
      [JSON.parse('{"constructor":"unsafe"}'), 'unsafe prototype key'],
      [deep, 'input nesting is too deep'],
      [{ values: Array(2049).fill(0) }, 'input array is too large'],
      [{ values: Array.from({ length: 6 }, () => Array(2000).fill(0)) }, 'input contains too many values'],
    ]) {
      expect(() => assertSafeReceiptRecoveryInput(invalid, {})).toThrow(message);
      expect(() => assertSafeReceiptRecoveryInput({}, invalid)).toThrow(message);
    }
  });
});
