import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG, loadRuntimeConfig, setRuntimeConfig } from '../lib/runtime/config.js';
import { hashRecord } from '../lib/runtime/canonical.js';
import { executionPolicySnapshot, pipelineLimits, workerDeadlinesEnabled } from '../lib/runtime/pipeline-limits.js';
import { projectedPipeline } from '../lib/runtime/pipeline.js';
import { ExecutionLimitsSchema, finalizeTicket, validateTicket } from '../lib/runtime/schemas.js';
import { historicalExecutionPolicy } from './historical-execution-policy-helper.js';

const retired = ['max_stage_attempts', 'max_directed_replans', 'max_remediation_cycles',
  'max_worker_protocol_redispatches_per_stage', 'max_regate_attempts',
  'max_physical_workers_per_ticket', 'max_validation_submissions_per_worker',
  'max_reconciliation_stage_attempts', 'max_reconciliation_protocol_redispatches'];
const directories = [];
afterEach(async () => Promise.all(directories.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))));
function ticket(limits, attempt = 1) {
  return { schema_version: '2.0.0', ticket_id: 'recovery:build:1', run_id: 'recovery',
    stage_id: 'build', parallel_group: null, role: 'implementer', objective: 'Repair the fixture',
    claimed_paths: ['src/value.js'], test_paths: ['tests/value.test.js'], model_tier: 'balanced', model: {},
    deadline_at: limits?.version >= 3 ? null : '2026-09-26T15:00:00.000Z', output_schema: {},
    required_checks: [], parent_hash: null, base_tree_sha: 'a'.repeat(40), attempt,
    writable: true, issued_at: '2026-09-26T14:00:00.000Z',
    ...(limits ? { execution_limits: limits } : {}) };
}

describe('v4 recovery authority and immutable historical contracts', () => {
  it('freezes an explicit v4 policy with no count quota, fake unlimited integer, or worker deadline', () => {
    const config = structuredClone(DEFAULT_CONFIG);
    for (const key of retired) config.policy[key] = 1;
    const snapshot = executionPolicySnapshot(config);
    expect(snapshot.version).toBe(4);
    expect(snapshot.limits.version).toBe(4);
    for (const key of retired) expect(snapshot.limits).not.toHaveProperty(key);
    expect(pipelineLimits({ execution_policy: JSON.parse(JSON.stringify(snapshot)) })).toEqual(snapshot.limits);
    expect(workerDeadlinesEnabled({ execution_policy: snapshot })).toBe(false);
    const issued = finalizeTicket(ticket(snapshot.limits, 25));
    expect(issued.attempt).toBe(25);
    expect(issued.deadline_at).toBeNull();
    expect(validateTicket(JSON.parse(JSON.stringify(issued)))).toEqual({ valid: true, value: issued });
    for (const invalid of [0, -1, 1.5, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
      expect(() => finalizeTicket(ticket(snapshot.limits, invalid))).toThrow();
    }
  });

  it.each([undefined, 1, 2, 3])('preserves literal historical version %s bytes, hashes, attempts and deadlines', (version) => {
    const legacyCounts = { max_stage_attempts: 2, max_directed_replans: 2,
      max_worker_protocol_redispatches_per_stage: 1, max_remediation_cycles: 3,
      max_regate_attempts: 3, max_physical_workers_per_ticket: 2,
      max_validation_submissions_per_worker: 3, max_reconciliation_stage_attempts: 1,
      max_reconciliation_protocol_redispatches: 0 };
    const limits = version === undefined ? undefined : version === 1 ? legacyCounts : historicalExecutionPolicy(version).limits;
    const raw = ticket(limits, 2);
    const expectedHash = hashRecord(raw, ['ticket_hash']);
    const bytes = JSON.stringify({ ...raw, ticket_hash: expectedHash });
    const parsed = JSON.parse(bytes);
    expect(validateTicket(parsed)).toEqual({ valid: true, value: parsed });
    expect(finalizeTicket(parsed).ticket_hash).toBe(expectedHash);
    expect(JSON.stringify(parsed)).toBe(bytes);
    expect(() => finalizeTicket(ticket(limits, 3))).toThrow(/attempt/i);
    expect(workerDeadlinesEnabled({ ...(limits ? { execution_limits: limits } : {}) })).toBe(version !== 3);
    if (version) {
      const snapshot = { version, limits };
      const frozen = JSON.stringify(snapshot);
      expect(pipelineLimits({ execution_policy: snapshot }).max_stage_attempts).toBe(2);
      expect(JSON.stringify(snapshot)).toBe(frozen);
    }
  });

  it('rejects unknown, mixed and quota-bearing v4 markers instead of falling back', () => {
    const current = executionPolicySnapshot(DEFAULT_CONFIG);
    const legacy = historicalExecutionPolicy(3);
    for (const limits of [{ version: 999 }, { ...current.limits, version: 999 },
      { ...current.limits, max_stage_attempts: 999999 }, { ...current.limits, max_regate_attempts: null }]) {
      expect(ExecutionLimitsSchema.safeParse(limits).success).toBe(false);
      expect(() => pipelineLimits({ execution_limits: limits })).toThrow();
    }
    for (const snapshot of [{ version: 4 }, { version: 4, limits: legacy.limits },
      { version: 3, limits: current.limits }, { version: 999, limits: current.limits }]) {
      expect(() => pipelineLimits({ execution_policy: snapshot })).toThrow();
    }
  });

  it('does not invent a finite physical dispatch forecast for evidence-dependent continuation', () => {
    const current = executionPolicySnapshot(DEFAULT_CONFIG);
    const projection = projectedPipeline({ mode: 'phase', lane: 'full', behavioral: true, execution_policy: current });
    expect(projection.dispatch_bounds.physical_dispatch_upper_bound).toBeNull();
    expect(projection.dispatch_bounds.by_stage.build).toBeNull();
    expect(projection.stages.map((stage) => stage.role)).toEqual(expect.arrayContaining([
      'implementer', 'test_writer', 'reviewer', 'security_reviewer', 'planner',
    ]));
    const historical = projectedPipeline({ mode: 'debug', execution_policy: historicalExecutionPolicy(3) });
    expect(Number.isSafeInteger(historical.dispatch_bounds.physical_dispatch_upper_bound)).toBe(true);
  });

  it('ignores retired sparse leaves without rewriting disk and removes them on ordinary config writes', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'ape-v4-config-'));
    directories.push(dir);
    const file = path.join(dir, 'config.json');
    const policy = Object.fromEntries(retired.map((key) => [key, 1]));
    const original = JSON.stringify({ policy: { ...policy, fast_max_files: 9 }, gates: { max_spawns: 7 } });
    await writeFile(file, original);
    const loaded = await loadRuntimeConfig(file);
    for (const key of retired) expect(loaded.policy).not.toHaveProperty(key);
    expect(loaded.policy.fast_max_files).toBe(9);
    expect(loaded.gates.max_spawns).toBe(7);
    expect(await readFile(file, 'utf8')).toBe(original);
    for (const key of retired) {
      await expect(setRuntimeConfig(file, `policy.${key}`, 5)).rejects.toThrow(/retired/i);
      expect(await readFile(file, 'utf8')).toBe(original);
    }
    await setRuntimeConfig(file, 'policy.fast_max_files', 10);
    const stored = JSON.parse(await readFile(file, 'utf8'));
    for (const key of retired) expect(stored.policy).not.toHaveProperty(key);
    expect(stored.gates.max_spawns).toBe(7);
    await expect(setRuntimeConfig(file, 'gates.max_spawns', 0)).rejects.toThrow();
  });
});
