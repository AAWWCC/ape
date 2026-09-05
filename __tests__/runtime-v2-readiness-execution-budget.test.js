import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { DEFAULT_CONFIG } from '../lib/runtime/config.js';
import { projectedPipeline } from '../lib/runtime/pipeline.js';
import { RunStartInputSchema } from '../lib/runtime/schemas.js';
import { configAction, previewRun, startRun } from '../lib/runtime/service.js';
import { evaluateRunReadiness } from '../lib/runtime/readiness.js';
import { sha256 } from '../lib/runtime/canonical.js';
import { projectRunState } from '../lib/runtime/projection.js';

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

describe('run readiness and capability manifests', () => {
  const dirs = [];
  afterEach(() => dirs.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true })));

  it('reports discovered-but-unapplied runners as blockers', () => {
    const readiness = readinessFor(runInput());
    expect(readiness.ready).toBe(false);
    expect(readiness.blocking.map((entry) => entry.code)).toEqual(expect.arrayContaining([
      'missing-targeted-test-runner',
      'missing-full-test-runner',
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
    });
    expect(readiness.available_capability_catalog).not.toHaveProperty('declared_tool_claims');
    expect(readiness.available_capability_catalog.command_profiles.map((entry) => entry.id))
      .toEqual(['editor.batch', 'audit.read']);
    expect(readiness.capabilities.config_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(readiness.capabilities.required_capabilities).toEqual(input.required_capabilities);
    expect(readiness.capabilities).toMatchObject({
      manifest_growth_contract_version: 1,
      manifest_roles: expect.arrayContaining(['preflight_analyst', 'test_writer', 'implementer', 'reviewer']),
    });
    expect(readiness.capabilities.command_profiles.map((entry) => entry.id)).toEqual(['editor.batch', 'audit.read']);
    expect(readiness).not.toHaveProperty('execution_budget');
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
    const readiness = readinessFor(runInput({ capability_contract_required: true }), config);

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
      capability_contract_required: true,
    });

    const preview = await previewRun(dir, input);
    const previewCodes = preview.blueprint.readiness.blocking.map((entry) => entry.code);
    expect(previewCodes).toEqual(expect.arrayContaining([
      'capability-command-profiles-over-limit',
      'capability-verification-profiles-over-limit',
      'capability-evidence-scripts-over-limit',
      'capability-runners-over-limit',
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
      required_capabilities: [{ kind: 'evidence_command', id: 'runner-0 full' }],
    }), config);
    expect(readiness.blocking).toContainEqual(expect.objectContaining({
      code: 'capability-evidence-commands-over-limit',
      provided: 258,
    }));
    expect(readiness.blocking.map((entry) => entry.code))
      .not.toContain('capability-runners-over-limit');
  });

  it('enforces reachable manifest ceilings even when no capability contract is explicitly requested', () => {
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
    expect(readiness.ready).toBe(false);
    expect(readiness.blocking.map((entry) => entry.code))
      .toContain('capability-command-profiles-over-limit');
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

  it('admits a configured run with a capability manifest and ordinary ticket deadline', async () => {
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
    await configAction(dir, 'set', {
      key: 'policy.command_profiles',
      value: [{ id: 'audit.read', command: 'true', roles: ['preflight_analyst'], effect: 'read' }],
    });

    const result = await startRun(dir, runInput({
      host: 'claude',
      binding_protocol: 'native-v1',
      required_capabilities: [{ kind: 'command_profile', id: 'audit.read', role: 'preflight_analyst' }],
    }));
    expect(result.ok).toBe(true);
    expect(result.run).not.toHaveProperty('execution_budget');
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
    });
    expect(contract.capability_catalog).not.toHaveProperty('tool_claims');
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
    expect(Date.parse(ticket.deadline_at)).toBeGreaterThan(Date.parse(ticket.issued_at));
  });

  it('proposes and applies grounded config without reading or changing repository instructions', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ape-agents-init-'));
    dirs.push(dir);
    writeFileSync(join(dir, 'package.json'), JSON.stringify({
      scripts: { test: 'vitest run', lint: 'eslint .', build: 'node build.js', dev: 'node dev.js' },
      devDependencies: { vitest: '^4.0.0' },
    }));
    const agents = '# Project instructions\n\nKeep this text.\n';
    const override = '# Operator override\n';
    writeFileSync(join(dir, 'AGENTS.md'), agents);
    writeFileSync(join(dir, 'AGENTS.override.md'), override);
    const proposed = (await configAction(dir, 'init', {})).init.proposal;
    expect(proposed.detected_runner.family).toBe('vitest');
    expect(proposed.evidence_scripts.map((entry) => entry.value)).toEqual(['build', 'lint', 'test']);
    expect(proposed).not.toHaveProperty('agents');

    await configAction(dir, 'init', { apply: true });
    expect(readFileSync(join(dir, 'AGENTS.md'), 'utf8')).toBe(agents);
    expect(readFileSync(join(dir, 'AGENTS.override.md'), 'utf8')).toBe(override);
  });

  it('does not create a repository instruction file during init', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ape-no-agents-init-'));
    dirs.push(dir);
    writeFileSync(join(dir, 'package.json'), JSON.stringify({
      scripts: { test: 'vitest run' },
      devDependencies: { vitest: '^4.0.0' },
    }));
    await configAction(dir, 'init', { apply: true });
    expect(existsSync(join(dir, 'AGENTS.md'))).toBe(false);
    expect(existsSync(join(dir, 'AGENTS.override.md'))).toBe(false);
    expect(existsSync(join(dir, 'CLAUDE.md'))).toBe(false);
  });

  it('rejects retired instruction-policy apply fields before config or instruction writes', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ape-retired-agents-init-'));
    dirs.push(dir);
    const ordinary = '# Ordinary instructions\n';
    const override = '# Override instructions\n';
    writeFileSync(join(dir, 'package.json'), JSON.stringify({
      scripts: { test: 'vitest run' },
      devDependencies: { vitest: '^4.0.0' },
    }));
    writeFileSync(join(dir, 'AGENTS.md'), ordinary);
    writeFileSync(join(dir, 'AGENTS.override.md'), override);
    await expect(configAction(dir, 'init', {
      apply: true,
      apply_agents: true,
      agents_path: 'AGENTS.override.md',
      agents_expected_hash: 'a'.repeat(64),
    })).rejects.toThrow(/no longer installs APE policy/);

    expect(readFileSync(join(dir, 'AGENTS.md'), 'utf8')).toBe(ordinary);
    expect(readFileSync(join(dir, 'AGENTS.override.md'), 'utf8')).toBe(override);
    expect(existsSync(join(dir, '.ape'))).toBe(false);
  });
});
