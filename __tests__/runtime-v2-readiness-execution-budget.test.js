import { afterEach, describe, expect, it } from 'vitest';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { DEFAULT_CONFIG } from '../lib/runtime/config.js';
import { projectedPipeline } from '../lib/runtime/pipeline.js';
import { RunStartInputSchema } from '../lib/runtime/schemas.js';
import { configAction, extendBudget, previewRun, startRun } from '../lib/runtime/service.js';
import { evaluateRunReadiness } from '../lib/runtime/readiness.js';
import { sha256 } from '../lib/runtime/canonical.js';
import { projectRunState } from '../lib/runtime/projection.js';
import {
  clampToExecutionDeadline,
  executionBudgetGuard,
  extendExecutionBudgetState,
  initializeExecutionBudget,
  pauseForExecutionBudget,
  syncExecutionBudgetClock,
} from '../lib/runtime/execution-budget.js';

function runInput(overrides = {}) {
  return RunStartInputSchema.parse({
    objective: 'Implement one bounded behavior',
    mode: 'phase',
    lane: 'fast',
    host: 'codex',
    claimed_paths: ['src/example.js'],
    test_paths: ['src/example.test.js'],
    requirements: [],
    risk_triggers: [],
    behavioral: true,
    hooks_trusted: true,
    subagents_available: true,
    explicit_invocation: true,
    plan_contract_version: 2,
    ...overrides,
  });
}

function readinessFor(input, config = DEFAULT_CONFIG) {
  const classification = { lane: 'fast', risk_triggers: [], reasons: [] };
  const spec = {
    mode: input.mode,
    lane: classification.lane,
    behavioral: input.behavioral,
    high_risk: false,
    plan_contract_version: 2,
    policy: { high_risk_security_review: true },
    remediation_cycles: 0,
    test_paths: input.test_paths,
    claimed_paths: input.claimed_paths,
  };
  return evaluateRunReadiness({
    input,
    config,
    classification,
    projection: projectedPipeline(spec),
    discovered: { targeted: true, full: true },
  });
}

describe('run readiness and execution budgets', () => {
  const dirs = [];
  afterEach(() => dirs.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true })));

  it('reports discovered-but-unapplied runners and a missing required budget as blockers', () => {
    const readiness = readinessFor(runInput({ execution_budget_required: true }));
    expect(readiness.ready).toBe(false);
    expect(readiness.blocking.map((entry) => entry.code)).toEqual(expect.arrayContaining([
      'missing-targeted-test-runner',
      'missing-full-test-runner',
      'missing-execution-budget',
    ]));
    expect(readiness.warnings.map((entry) => entry.code)).toContain('unapplied-runner-proposal');
  });

  it('hard-gates required capabilities and snapshots the complete configured catalog with a config hash', () => {
    const config = structuredClone(DEFAULT_CONFIG);
    config.test_commands.targeted_template = 'npm test -- {paths}';
    config.test_commands.full = 'npm test';
    config.policy.command_profiles = [
      { id: 'editor.batch', command: 'editor --batch', roles: ['implementer'], effect: 'execute' },
      { id: 'audit.read', command: 'audit --read', roles: ['reviewer'], effect: 'read' },
    ];
    config.verification.profiles = [
      { id: 'integration', description: 'integration suite', command: 'npm test', timeout_ms: 1_000 },
    ];
    const input = runInput({
      required_capabilities: [{ kind: 'command_profile', id: 'editor.batch', role: 'implementer' }],
      execution_budget_required: true,
      execution_budget: { max_worker_dispatches: 8, max_active_seconds: 3_600 },
    });
    const readiness = readinessFor(input, config);
    expect(readiness.ready).toBe(true);
    expect(readiness.requested_capabilities).toEqual(input.required_capabilities);
    expect(readiness.derived_capability_requirements).toMatchObject({
      stage_roles: expect.arrayContaining(['preflight_analyst', 'implementer', 'reviewer']),
      stage_checks: expect.arrayContaining(['red-test', 'targeted-tests']),
      test_runner_profiles: ['targeted', 'full'],
    });
    expect(readiness.available_capability_catalog).toMatchObject({
      version: 1,
      config_hash: expect.stringMatching(/^[0-9a-f]{64}$/),
      catalog_hash: expect.stringMatching(/^[0-9a-f]{64}$/),
      declared_tool_claims: [],
    });
    expect(readiness.available_capability_catalog.command_profiles.map((entry) => entry.id))
      .toEqual(['editor.batch', 'audit.read']);
    expect(readiness.capabilities.config_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(readiness.capabilities.required_capabilities).toEqual(input.required_capabilities);
    expect(readiness.capabilities).toMatchObject({
      manifest_growth_contract_version: 1,
      manifest_roles: expect.arrayContaining(['preflight_analyst', 'test_writer', 'implementer', 'reviewer']),
    });
    expect(readiness.capabilities.command_profiles.map((entry) => entry.id)).toEqual(['editor.batch', 'audit.read']);
    expect(readiness.execution_budget.minimum.worker_dispatches).toBe(4);
    expect(readiness.execution_budget.minimum).toMatchObject({
      active_seconds: null,
      active_seconds_observed: false,
      active_seconds_basis: 'unknown',
    });
    expect(readiness.execution_budget.worst_case.worker_dispatches).toBeGreaterThan(4);
    expect(readiness.execution_budget.worst_worker_dispatches)
      .toBe(readiness.execution_budget.worst_case.logical_ticket_dispatches * 2);
    expect(readiness.execution_budget.maximum_receipt_submissions)
      .toBe(readiness.execution_budget.worst_worker_dispatches * 3);
    expect(readiness.execution_budget.covers_minimum_worker_dispatches).toBe(true);
    expect(readiness.execution_budget.covers_minimum_path).toBeNull();
  });

  it('sizes every reachable role for maximal dynamic test paths, required preflight profiles, and late risks', () => {
    const config = structuredClone(DEFAULT_CONFIG);
    config.test_commands.targeted_template = `node ${'x'.repeat(4_500)} {paths}`;
    config.test_commands.full = 'node full-tests.js';
    config.verification.profiles = [{
      id: 'integration',
      description: 'integration verification',
      command: 'node integration.js',
      timeout_ms: 1_000,
    }];
    const readiness = readinessFor(runInput({
      execution_budget_required: true,
      execution_budget: { max_worker_dispatches: 8, max_active_seconds: 3_600 },
    }), config);

    expect(readiness.ready).toBe(false);
    expect(readiness.blocking).toContainEqual(expect.objectContaining({
      code: 'capability-evidence-command-invalid',
      source: expect.stringMatching(/^dynamic-worst-case:/),
    }));
    expect(readiness.derived_capability_requirements).toMatchObject({
      dynamic_test_paths: { max_items: 64, max_serialized_utf8_bytes: 4_096 },
      future_manifest_conditions: {
        required_verification_profile_ids: ['integration'],
        risk_triggers: expect.arrayContaining(['security', 'schema', 'concurrency']),
      },
    });
  });

  it('freezes active time on an input hold, resumes only on explicit extension, and enforces groups atomically', () => {
    const created = '2026-01-01T00:00:00.000Z';
    const state = {
      status: 'running',
      stage: 'build',
      created_at: created,
      execution_budget: initializeExecutionBudget(
        { max_worker_dispatches: 2, max_active_seconds: 10 },
        created,
      ),
    };
    const atFive = '2026-01-01T00:00:05.000Z';
    expect(executionBudgetGuard(state, { at: atFive, dispatches: 3 }).code).toBe('worker-dispatches-exhausted');
    pauseForExecutionBudget(state, executionBudgetGuard(state, { at: atFive, dispatches: 3 }), atFive);
    expect(state.status).toBe('input_required');
    expect(state.execution_budget.active_elapsed_ms).toBe(5_000);
    expect(state.execution_budget.active_since).toBeUndefined();
    expect(state.orchestration.budget_pauses).toBe(1);
    const repeated = pauseForExecutionBudget(
      state,
      { allowed: false, code: 'worker-dispatches-exhausted', reason: 'still paused' },
      '2026-01-01T00:00:06.000Z',
    );
    expect(repeated.idempotent).toBe(true);
    expect(state.orchestration.budget_pauses).toBe(1);
    expect(state.input_required.resume_stage).toBe('build');
    expect(state.input_required.resume_status).toBe('running');
    expect(executionBudgetGuard(state, { at: '2026-01-01T01:00:00.000Z' }).remaining_active_seconds).toBe(5);

    extendExecutionBudgetState(state, { max_worker_dispatches: 4, max_active_seconds: 20 }, '2026-01-01T01:00:00.000Z');
    expect(state.status).toBe('running');
    expect(state.execution_budget.active_since).toBe('2026-01-01T01:00:00.000Z');
    expect(() => extendExecutionBudgetState(
      state,
      { max_worker_dispatches: 3, max_active_seconds: 20 },
      '2026-01-01T01:00:01.000Z',
    )).toThrow(/cannot decrease/);
  });

  it('clamps ticket deadlines to the remaining active budget', () => {
    const now = new Date();
    const state = {
      status: 'running',
      execution_budget: initializeExecutionBudget(
        { max_worker_dispatches: 2, max_active_seconds: 5 },
        now.toISOString(),
      ),
    };
    const candidate = new Date(now.getTime() + 60_000).toISOString();
    expect(Date.parse(clampToExecutionDeadline(state, candidate))).toBeLessThanOrEqual(now.getTime() + 5_100);
  });

  it('preserves and reports active-time overrun instead of clamping elapsed at the cap', () => {
    const created = '2026-01-01T00:00:00.000Z';
    const state = {
      status: 'running',
      execution_budget: initializeExecutionBudget(
        { max_worker_dispatches: 1, max_active_seconds: 10 },
        created,
      ),
    };
    syncExecutionBudgetClock(state, '2026-01-01T00:00:15.000Z');
    expect(state.execution_budget.active_elapsed_ms).toBe(15_000);
    expect(state.execution_budget.overrun_ms).toBe(5_000);
    expect(executionBudgetGuard(state, { at: '2026-01-01T00:00:15.000Z' }).code)
      .toBe('active-time-exhausted');
  });

  it('never pauses or extends a terminal run', () => {
    const created = '2026-01-01T00:00:00.000Z';
    const state = {
      status: 'completed',
      stage: 'complete',
      execution_budget: initializeExecutionBudget(
        { max_worker_dispatches: 1, max_active_seconds: 1 },
        created,
      ),
    };
    const before = structuredClone(state);
    const guard = executionBudgetGuard(state, { at: '2026-01-01T00:00:02.000Z' });
    expect(pauseForExecutionBudget(state, guard, '2026-01-01T00:00:02.000Z')).toBeNull();
    expect(state).toEqual(before);
    expect(() => extendExecutionBudgetState(
      state,
      { max_worker_dispatches: 2, max_active_seconds: 2 },
      '2026-01-01T00:00:02.000Z',
    )).toThrow(/terminal run completed/);
  });

  it('rejects a new-contract start before creating runtime state', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ape-readiness-zero-effect-'));
    dirs.push(dir);
    const result = await startRun(dir, runInput({ execution_budget_required: true }));
    expect(result).toMatchObject({ ok: false, blocked: true, attempts_consumed: 0 });
    expect(existsSync(join(dir, '.ape', 'runtime', 'active.json'))).toBe(false);
  });

  it('reports every unrepresentable capability collection in preview and rejects start with zero side effects', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ape-readiness-manifest-bounds-'));
    dirs.push(dir);
    execFileSync('git', ['init', '-b', 'main'], { cwd: dir, stdio: 'ignore' });
    execFileSync('git', ['config', 'user.email', 'ape@example.test'], { cwd: dir });
    execFileSync('git', ['config', 'user.name', 'APE Test'], { cwd: dir });
    writeFileSync(join(dir, 'README.md'), '# fixture\n');
    execFileSync('git', ['add', 'README.md'], { cwd: dir });
    execFileSync('git', ['commit', '-m', 'init'], { cwd: dir, stdio: 'ignore' });
    const headBefore = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: dir, encoding: 'utf8' }).trim();
    const runtime = join(dir, '.ape', 'runtime');
    mkdirSync(runtime, { recursive: true });
    const commandProfiles = Array.from({ length: 65 }, (_, index) => ({
      id: `command.${index}`,
      command: `tool verify-${index}`,
      roles: ['implementer'],
      effect: 'execute',
    }));
    const verificationProfiles = Array.from({ length: 65 }, (_, index) => ({
      id: `verify.${index}`,
      description: `Verification ${index}`,
      command: `verify suite-${index}`,
      timeout_ms: 1_000,
    }));
    const runners = Array.from({ length: 65 }, (_, index) => ({
      id: `runner-${index}`,
      owns: [`packages/${index}/**`],
      root: `packages/${index}`,
      profile: { full: `runner-${index} full` },
    }));
    writeFileSync(join(runtime, 'config.json'), `${JSON.stringify({
      policy: {
        command_profiles: commandProfiles,
        evidence_scripts: Array.from({ length: 65 }, (_, index) => `verify:${index}`),
      },
      verification: { profiles: verificationProfiles },
      runners,
      test_commands: {
        targeted_template: 'npm test -- {paths}',
        full: 'npm test',
      },
    }, null, 2)}\n`);
    const input = runInput({
      host: 'claude',
      binding_protocol: 'native-v1',
      tool_claims: Array.from({ length: 65 }, (_, index) => `provider:resource-${index}:read`),
      execution_budget_required: true,
      execution_budget: { max_worker_dispatches: 100, max_active_seconds: 100_000 },
    });

    const preview = await previewRun(dir, input);
    const previewCodes = preview.blueprint.readiness.blocking.map((entry) => entry.code);
    expect(previewCodes).toEqual(expect.arrayContaining([
      'capability-command-profiles-over-limit',
      'capability-verification-profiles-over-limit',
      'capability-evidence-scripts-over-limit',
      'capability-runners-over-limit',
      'capability-tool-claims-over-limit',
      'capability-evidence-commands-over-limit',
    ]));
    expect(readdirSync(runtime).sort()).toEqual(['config.json']);

    const started = await startRun(dir, input);
    expect(started).toMatchObject({
      ok: false,
      blocked: true,
      attempts_consumed: 0,
      reason: 'run readiness failed before write',
    });
    expect(started.readiness.blocking.map((entry) => entry.code))
      .toEqual(expect.arrayContaining(previewCodes));
    expect(readdirSync(runtime).sort()).toEqual(['config.json']);
    expect(execFileSync('git', ['branch', '--format=%(refname:short)'], { cwd: dir, encoding: 'utf8' }).trim())
      .toBe('main');
    expect(execFileSync('git', ['rev-parse', 'HEAD'], { cwd: dir, encoding: 'utf8' }).trim())
      .toBe(headBefore);
  });

  it('rejects an over-limit derived command allowlist even when every source collection is within its count bound', () => {
    const config = structuredClone(DEFAULT_CONFIG);
    config.test_commands.targeted_template = 'npm test -- {paths}';
    config.test_commands.full = 'npm test';
    config.runners = Array.from({ length: 64 }, (_, index) => ({
      id: `runner-${index}`,
      owns: [`packages/${index}/**`],
      root: `packages/${index}`,
      profile: {
        targeted: `runner-${index} targeted`,
        full: `runner-${index} full`,
        full_serial: `runner-${index} serial`,
        impacted_template: `runner-${index} impacted`,
      },
    }));
    const readiness = readinessFor(runInput({
      execution_budget_required: true,
      execution_budget: { max_worker_dispatches: 100, max_active_seconds: 100_000 },
    }), config);
    expect(readiness.blocking).toContainEqual(expect.objectContaining({
      code: 'capability-evidence-commands-over-limit',
      provided: 258,
    }));
    expect(readiness.blocking.map((entry) => entry.code))
      .not.toContain('capability-runners-over-limit');
  });

  it('keeps oversized catalog checks informational for a legacy start contract', () => {
    const config = structuredClone(DEFAULT_CONFIG);
    config.test_commands.targeted_template = 'npm test -- {paths}';
    config.test_commands.full = 'npm test';
    config.policy.command_profiles = Array.from({ length: 65 }, (_, index) => ({
      id: `command.${index}`,
      command: `tool verify-${index}`,
      roles: ['implementer'],
      effect: 'execute',
    }));
    const readiness = readinessFor(runInput(), config);
    expect(readiness.blocking.map((entry) => entry.code))
      .not.toContain('capability-command-profiles-over-limit');
  });

  it('refuses newly configured catalogs beyond the immutable manifest ceilings before persisting them', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ape-config-manifest-bounds-'));
    dirs.push(dir);
    await expect(configAction(dir, 'set', {
      key: 'policy.evidence_scripts',
      value: Array.from({ length: 65 }, (_, index) => `verify:${index}`),
    })).rejects.toThrow(/at most 64 package-script names/);
    await expect(configAction(dir, 'set', {
      key: 'policy.command_profiles',
      value: Array.from({ length: 65 }, (_, index) => ({
        id: `command.${index}`,
        command: `tool verify-${index}`,
        roles: ['implementer'],
        effect: 'execute',
      })),
    })).rejects.toThrow(/at most 64 command profile objects/);
    await expect(configAction(dir, 'set', {
      key: 'runners',
      value: Array.from({ length: 65 }, (_, index) => ({
        id: `runner-${index}`,
        owns: [`packages/${index}/**`],
        root: `packages/${index}`,
        profile: { full: `runner-${index} full` },
      })),
    })).rejects.toThrow(/at most 64 runner objects/);
    expect(existsSync(join(dir, '.ape', 'runtime', 'config.json'))).toBe(false);
  });

  it('admits a configured bounded run with a capability manifest and clamped ticket deadline', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ape-readiness-admit-'));
    dirs.push(dir);
    execFileSync('git', ['init', '-b', 'main'], { cwd: dir, stdio: 'ignore' });
    execFileSync('git', ['config', 'user.email', 'ape@example.test'], { cwd: dir });
    execFileSync('git', ['config', 'user.name', 'APE Test'], { cwd: dir });
    writeFileSync(join(dir, 'README.md'), '# fixture\n');
    execFileSync('git', ['add', 'README.md'], { cwd: dir });
    execFileSync('git', ['commit', '-m', 'init'], { cwd: dir, stdio: 'ignore' });
    await configAction(dir, 'set', { key: 'test_commands.targeted_template', value: 'npm test -- {paths}' });
    await configAction(dir, 'set', { key: 'test_commands.full', value: 'npm test' });

    const result = await startRun(dir, runInput({
      host: 'claude',
      binding_protocol: 'native-v1',
      execution_budget_required: true,
      execution_budget: { max_worker_dispatches: 8, max_active_seconds: 30 },
    }));
    expect(result.ok).toBe(true);
    expect(result.run.execution_budget.worker_dispatches_used).toBe(1);
    expect(result.run.capability_snapshot.config_hash).toMatch(/^[0-9a-f]{64}$/);
    const ticket = result.run.tickets[0];
    expect(ticket.receipt_contract_version).toBe(1);
    expect(ticket.capability_manifest.config_hash).toBe(result.run.capability_snapshot.config_hash);
    expect(ticket.capability_manifest.allowed_evidence_commands.some((command) => command.includes('{paths}')))
      .toBe(false);
    expect(ticket.capability_manifest.receipt_schema.hash).toMatch(/^[0-9a-f]{64}$/);
    expect(ticket.capability_manifest.run_contract).toEqual(result.run.run_contract);
    expect(result.run.run_contract).toMatchObject({
      version: 1,
      revision: 2,
      ref: expect.stringMatching(/^\.ape\/runtime\/contracts\/[0-9a-f]{64}\.json$/),
      hash: expect.stringMatching(/^[0-9a-f]{64}$/),
    });
    const contract = JSON.parse(readFileSync(join(dir, result.run.run_contract.ref), 'utf8'));
    expect(sha256(contract)).toBe(result.run.run_contract.hash);
    expect(contract).toMatchObject({
      version: 1,
      revision: 2,
      config_hash: result.run.capability_snapshot.config_hash,
      objective_hash: sha256(result.run.objective),
      preflight_hash: null,
      receipt_contract: {
        version: 1,
        field_bounds: ticket.capability_manifest.field_bounds,
        byte_budgets: ticket.capability_manifest.byte_budgets,
      },
    });
    expect(contract.previous).toMatchObject({ version: 1, revision: 1 });
    expect(contract.capability_catalog).toMatchObject({
      command_profiles: result.run.capability_snapshot.command_profiles,
      verification_profiles: result.run.capability_snapshot.verification_profiles,
      runners: result.run.capability_snapshot.runners,
      test_commands: result.run.capability_snapshot.test_commands,
      tool_claims: [],
    });
    expect(contract.capability_catalog_hash).toBe(sha256(contract.capability_catalog));
    expect(contract.receipt_contract.ticket_contracts).toHaveLength(1);
    expect(contract.receipt_contract.ticket_contracts[0]).toMatchObject({
      ticket_id: ticket.ticket_id,
      stage_id: ticket.stage_id,
      role: ticket.role,
      receipt_contract_version: 1,
      receipt_schema: {
        hash: ticket.capability_manifest.receipt_schema.hash,
        ref: expect.stringMatching(/^\.ape\/runtime\/contracts\/schemas\/[0-9a-f]{64}\.json$/),
        ticket_ref: ticket.capability_manifest.receipt_schema.ref,
      },
    });
    const contractReceiptSchema = contract.receipt_contract.ticket_contracts[0].receipt_schema;
    const archivedSchema = JSON.parse(readFileSync(join(dir, contractReceiptSchema.ref), 'utf8'));
    expect(sha256(archivedSchema)).toBe(contractReceiptSchema.hash);
    expect(archivedSchema).toEqual(ticket.output_schema);
    expect(contract.receipt_contract.ticket_contracts[0].role_view).toMatchObject({
      allowed_evidence_commands: ticket.capability_manifest.allowed_evidence_commands,
      command_profiles: ticket.capability_manifest.command_profiles,
      verification_profiles: ticket.capability_manifest.verification_profiles,
      field_bounds: ticket.capability_manifest.field_bounds,
      byte_budgets: ticket.capability_manifest.byte_budgets,
    });
    expect(readdirSync(join(dir, '.ape', 'runtime', 'contracts')).filter((name) => name.endsWith('.json')))
      .toHaveLength(2);
    const projected = projectRunState(result.run);
    expect(projected.run_contract).toEqual(result.run.run_contract);
    expect(projected.capability_snapshot).not.toHaveProperty('command_profiles');
    expect(projected.tickets[0].capability_manifest).toMatchObject({
      run_contract: result.run.run_contract,
    });
    expect(projected.tickets[0].capability_manifest).not.toHaveProperty('command_profiles');
    expect(Date.parse(ticket.deadline_at)).toBeLessThanOrEqual(Date.parse(result.run.execution_budget.active_deadline_at));

    const activePath = join(dir, '.ape', 'runtime', 'active.json');
    const paused = JSON.parse(readFileSync(activePath, 'utf8'));
    paused.status = 'input_required';
    paused.stage = 'execution-budget';
    paused.input_required = {
      kind: 'execution_budget',
      code: 'worker-dispatches-exhausted',
      reason: 'fixture pause',
      resume_stage: 'preflight',
      paused_at: paused.updated_at,
    };
    delete paused.execution_budget.active_since;
    delete paused.execution_budget.active_deadline_at;
    writeFileSync(activePath, `${JSON.stringify(paused, null, 2)}\n`);
    const extended = await extendBudget(dir, {
      max_worker_dispatches: 10,
      max_active_seconds: 60,
      reason: 'continue the bounded fixture after operator review',
    });
    expect(extended.ok).toBe(true);
    expect(extended.run.status).toBe('running');
    expect(extended.run.execution_budget).toMatchObject({
      max_worker_dispatches: 10,
      max_active_seconds: 60,
      extension_count: 1,
    });
  });

  it('proposes scripts and a managed AGENTS block, then appends only with an exact expected hash', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ape-agents-init-'));
    dirs.push(dir);
    writeFileSync(join(dir, 'package.json'), JSON.stringify({
      scripts: { test: 'vitest run', lint: 'eslint .', build: 'node build.js', dev: 'node dev.js' },
      devDependencies: { vitest: '^4.0.0' },
    }));
    writeFileSync(join(dir, 'AGENTS.md'), '# Project instructions\n\nKeep this text.\n');
    const proposed = (await configAction(dir, 'init', {})).init.proposal;
    expect(proposed.detected_runner.family).toBe('vitest');
    expect(proposed.evidence_scripts.map((entry) => entry.value)).toEqual(['build', 'lint', 'test']);
    expect(proposed.agents).toMatchObject({ path: 'AGENTS.md', status: 'proposed', apply_required: true });

    await configAction(dir, 'init', {
      apply: true,
      apply_agents: true,
      agents_path: proposed.agents.path,
      agents_expected_hash: proposed.agents.source_hash,
    });
    const after = readFileSync(join(dir, 'AGENTS.md'), 'utf8');
    expect(after).toContain('Keep this text.');
    expect(after).toContain('BEGIN APE MANAGED MAIN-SESSION POLICY v1');
  });

  it('never overwrites a human-managed APE policy during init', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ape-agents-human-managed-'));
    dirs.push(dir);
    const original = '# Project instructions\n\nOur APE workflow is maintained by the platform team.\n';
    writeFileSync(join(dir, 'AGENTS.md'), original);
    const proposed = (await configAction(dir, 'init', {})).init.proposal;
    expect(proposed.agents.status).toBe('human-managed');
    await expect(configAction(dir, 'init', {
      apply: true,
      apply_agents: true,
      agents_path: proposed.agents.path,
      agents_expected_hash: proposed.agents.source_hash,
    })).rejects.toThrow(/human-managed/);
    expect(readFileSync(join(dir, 'AGENTS.md'), 'utf8')).toBe(original);
    expect(existsSync(join(dir, '.ape', 'runtime', 'config.json'))).toBe(false);
  });

  it('serializes concurrent AGENTS applies so one exact proposal hash is consumed once', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ape-agents-concurrent-'));
    dirs.push(dir);
    writeFileSync(join(dir, 'package.json'), JSON.stringify({
      scripts: { test: 'vitest run' },
      devDependencies: { vitest: '^4.0.0' },
    }));
    writeFileSync(join(dir, 'AGENTS.md'), '# Project instructions\n');
    const agents = (await configAction(dir, 'init', {})).init.proposal.agents;
    const apply = () => configAction(dir, 'init', {
      apply: true,
      apply_agents: true,
      agents_path: agents.path,
      agents_expected_hash: agents.source_hash,
    });

    const results = await Promise.allSettled([apply(), apply()]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1);
    expect(results.find((result) => result.status === 'rejected').reason.message)
      .toMatch(/source hash changed|target or source hash changed/u);
    const after = readFileSync(join(dir, 'AGENTS.md'), 'utf8');
    expect(after.match(/BEGIN APE MANAGED MAIN-SESSION POLICY v1/gu)).toHaveLength(1);
  });

  it('applies only to AGENTS.override.md when override precedence is active', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ape-agents-override-'));
    dirs.push(dir);
    const ordinary = '# Ordinary instructions\n';
    const override = '# Override instructions\n';
    writeFileSync(join(dir, 'AGENTS.md'), ordinary);
    writeFileSync(join(dir, 'AGENTS.override.md'), override);
    const agents = (await configAction(dir, 'init', {})).init.proposal.agents;
    expect(agents).toMatchObject({ path: 'AGENTS.override.md', source: 'existing-override' });

    await configAction(dir, 'init', {
      apply: true,
      apply_agents: true,
      agents_path: agents.path,
      agents_expected_hash: agents.source_hash,
    });

    expect(readFileSync(join(dir, 'AGENTS.md'), 'utf8')).toBe(ordinary);
    expect(readFileSync(join(dir, 'AGENTS.override.md'), 'utf8'))
      .toContain('BEGIN APE MANAGED MAIN-SESSION POLICY v1');
  });

  it.skipIf(process.platform === 'win32')(
    'leaves config byte-for-byte unchanged when the final AGENTS replacement fails',
    async () => {
      const dir = mkdtempSync(join(tmpdir(), 'ape-agents-no-partial-config-'));
      dirs.push(dir);
      writeFileSync(join(dir, 'package.json'), JSON.stringify({
        scripts: { test: 'vitest run' },
        devDependencies: { vitest: '^4.0.0' },
      }));
      writeFileSync(join(dir, 'AGENTS.md'), '# Project instructions\n');
      await configAction(dir, 'set', { key: 'custom.sentinel', value: 'unchanged' });
      const configPath = join(dir, '.ape', 'runtime', 'config.json');
      const beforeConfig = readFileSync(configPath, 'utf8');
      const agents = (await configAction(dir, 'init', {})).init.proposal.agents;

      // The AGENTS target is in the now-read-only project root, while APE's
      // already-created runtime directory remains writable for its CAS lock.
      // This forces the late atomic replacement failure which used to occur
      // only after config.json had already been changed.
      chmodSync(dir, 0o555);
      try {
        await expect(configAction(dir, 'init', {
          apply: true,
          apply_agents: true,
          agents_path: agents.path,
          agents_expected_hash: agents.source_hash,
        })).rejects.toThrow();
      } finally {
        chmodSync(dir, 0o755);
      }

      expect(readFileSync(configPath, 'utf8')).toBe(beforeConfig);
      expect(readFileSync(join(dir, 'AGENTS.md'), 'utf8'))
        .not.toContain('BEGIN APE MANAGED MAIN-SESSION POLICY v1');
    },
  );
});
