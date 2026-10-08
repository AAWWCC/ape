import { gitFixtureEnv } from '../test-support/git-fixtures.js';
import { afterEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { DEFAULT_CONFIG, resolveTicketDeadline } from '../lib/runtime/config.js';
import { evaluateLifecyclePolicy } from '../lib/runtime/hooks.js';
import { pipelineRunSpec, projectedPipeline } from '../lib/runtime/pipeline.js';
import { evaluateRunReadiness } from '../lib/runtime/readiness.js';
import { RunStartInputSchema } from '../lib/runtime/schemas.js';
import { executionPolicySnapshot } from '../lib/runtime/pipeline-limits.js';
import { historicalExecutionPolicy } from './historical-execution-policy-helper.js';
import { previewRun, startRun } from '../lib/runtime/service.js';
import { runtimePaths } from '../lib/runtime/paths.js';
import { bindCodexDispatchContext, invokeCodexHook } from './codex-native-test-helper.js';

const PROFILE = Object.freeze({
  id: 'spike.measure.once',
  command: 'uv run python -c "print(1)"',
  roles: ['spike_researcher'],
  effect: 'execute',
  operator_authorized: true,
  reason: 'Measure the requested behavior without changing repository-wide policy.',
});

function spikeInput(overrides = {}) {
  return {
    objective: 'Measure the current implementation and report the observed value.',
    mode: 'spike',
    lane: 'auto',
    host: 'claude',
    claimed_paths: [],
    test_paths: [],
    requirements: [],
    risk_triggers: [],
    behavioral: false,
    hooks_trusted: true,
    subagents_available: true,
    explicit_invocation: true,
    binding_protocol: 'native-v1',
    run_command_profiles: [PROFILE],
    ...overrides,
  };
}

function initRepository() {
  const dir = mkdtempSync(join(tmpdir(), 'ape-run-command-profile-'));
  execFileSync('git', ['init', '-b', 'main'], { env: gitFixtureEnv(), cwd: dir, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.email', 'ape@example.test'], { env: gitFixtureEnv(), cwd: dir });
  execFileSync('git', ['config', 'user.name', 'APE Test'], { env: gitFixtureEnv(), cwd: dir });
  writeFileSync(join(dir, 'README.md'), '# fixture\n');
  execFileSync('git', ['add', 'README.md'], { env: gitFixtureEnv(), cwd: dir });
  execFileSync('git', ['commit', '-m', 'init'], { env: gitFixtureEnv(), cwd: dir, stdio: 'ignore' });
  return dir;
}

describe('run-scoped read-only command profiles', () => {
  const dirs = [];
  afterEach(() => dirs.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true })));

  it('makes every admitted profile an immutable required capability', () => {
    const parsed = RunStartInputSchema.parse(spikeInput());
    expect(parsed.required_capabilities).toContainEqual({
      kind: 'command_profile',
      id: PROFILE.id,
      role: 'spike_researcher',
    });
    expect(RunStartInputSchema.safeParse(spikeInput({ mode: 'phase' })).success).toBe(false);
    expect(RunStartInputSchema.safeParse(spikeInput({ binding_protocol: undefined })).success).toBe(false);
    expect(RunStartInputSchema.safeParse(spikeInput({
      run_command_profiles: [{ ...PROFILE, effect: 'write' }],
    })).success).toBe(false);
    expect(RunStartInputSchema.safeParse(spikeInput({
      run_command_profiles: [{ ...PROFILE, operator_authorized: false }],
    })).success).toBe(false);
    expect(RunStartInputSchema.safeParse(spikeInput({
      run_command_profiles: [{ ...PROFILE, reason: '   ' }],
    })).success).toBe(false);
    expect(RunStartInputSchema.safeParse(spikeInput({
      run_command_profiles: [{ ...PROFILE, roles: ['debugger'] }],
    })).success).toBe(false);
  });

  it('distinguishes unlimited new workers and historical deadlines from timebox prose in the objective', () => {
    const common = readFileSync(new URL('../prompts/common.md', import.meta.url), 'utf8');
    const runSkill = readFileSync(new URL('../plugin-src/skills/run/body.md', import.meta.url), 'utf8');
    expect(common).toMatch(/Execution policy v[34](?: and v4)? workers have `deadline_at: null` and no elapsed-time cutoff/iu);
    expect(common).toMatch(/historical tickets, a non-null `deadline_at` remains the runtime-issued authorization horizon/iu);
    expect(common).toMatch(/never stop early[\s\S]*because of that prose/iu);
    expect(runSkill).toMatch(/Omit execution budgets and dispatch limits[\s\S]*new workers have no duration limit[\s\S]*preview reports `deadline_ms: null`/iu);
    expect(resolveTicketDeadline({ deadlines_ms: { spike: 0, full: 123 } }, 'spike', 'full'))
      .toEqual({ deadline_ms: 0, source: 'mode:spike' });
    expect(resolveTicketDeadline({ deadlines_ms: { debug: 420_000, full: 123 } }, 'debug', 'full'))
      .toEqual({ deadline_ms: 420_000, source: 'mode:debug' });
    expect(resolveTicketDeadline({ deadlines_ms: { full: 123 } }, 'debug', 'full'))
      .toEqual({ deadline_ms: 123, source: 'lane:full' });
    expect(resolveTicketDeadline({ deadlines_ms: { full: -1 } }, 'phase', 'full'))
      .toEqual({ deadline_ms: -1, source: 'lane:full' });
    expect(() => resolveTicketDeadline(
      { deadlines_ms: { debug: '15m', full: 123 } },
      'debug',
      'full',
    )).toThrow(/invalid ticket deadline for mode:debug/iu);
  });

  it('separates new worker authority from frozen command timeouts while retaining legacy deadlines', () => {
    const config = structuredClone(DEFAULT_CONFIG);
    config.deadlines_ms.spike = 0;
    config.deadlines_ms.full = 123;
    const snapshot = executionPolicySnapshot(config);
    expect(snapshot).toMatchObject({ version: 4, limits: { version: 4 } });
    expect(resolveTicketDeadline(config, 'spike', 'full', { execution_policy: snapshot }))
      .toEqual({ deadline_ms: null, source: 'no-worker-deadline' });
    expect(resolveTicketDeadline(config, 'spike', 'full', { execution_limits: snapshot.limits }))
      .toEqual({ deadline_ms: null, source: 'no-worker-deadline' });
    expect(snapshot.deadlines_ms).toEqual(config.deadlines_ms);
    const historical = historicalExecutionPolicy(2, {}, config);
    expect(resolveTicketDeadline(config, 'spike', 'full', { execution_policy: historical }))
      .toEqual({ deadline_ms: 0, source: 'mode:spike' });
    expect(resolveTicketDeadline(config, 'spike', 'full'))
      .toEqual({ deadline_ms: 0, source: 'mode:spike' });
  });

  it('merges run-local profiles into readiness and rejects persistent-id ambiguity', () => {
    const input = RunStartInputSchema.parse(spikeInput());
    const classification = { lane: 'full', risk_triggers: [], reasons: ['empty-claims-full'] };
    const projection = projectedPipeline(pipelineRunSpec(input, classification, DEFAULT_CONFIG));
    const ready = evaluateRunReadiness({ input, config: DEFAULT_CONFIG, classification, projection });
    expect(ready.ready).toBe(true);
    expect(ready.capabilities.command_profiles).toContainEqual(PROFILE);
    expect(ready.available_capability_catalog.command_profiles).toContainEqual(PROFILE);

    const conflictedConfig = structuredClone(DEFAULT_CONFIG);
    conflictedConfig.policy.command_profiles = [{
      ...PROFILE,
      command: 'different command',
    }];
    const conflicted = evaluateRunReadiness({
      input,
      config: conflictedConfig,
      classification,
      projection,
    });
    expect(conflicted.ready).toBe(false);
    expect(conflicted.blocking).toContainEqual({
      code: 'run-command-profile-id-conflict',
      profile_id: PROFILE.id,
    });
  });

  it('authorizes only the frozen verification command with verified paths and executable', async () => {
    const dir = initRepository();
    dirs.push(dir);
    const profile = { id: 'linux-check', description: 'Isolated Linux marketplace verification',
      command: 'node scripts/smoke-marketplace-install.mjs --linux', root: '.', timeout_ms: 900000 };
    const configFile = runtimePaths(dir).config;
    mkdirSync(dirname(configFile), { recursive: true });
    writeFileSync(configFile, JSON.stringify({ verification: { profiles: [profile] } }));
    mkdirSync(join(dir, 'scripts'));
    writeFileSync(join(dir, 'scripts/smoke-marketplace-install.mjs'), 'export const verified = true;\n');
    execFileSync('git', ['add', 'scripts'], { cwd: dir, env: gitFixtureEnv() });
    execFileSync('git', ['commit', '-qm', 'verification fixture'], { cwd: dir, env: gitFixtureEnv() });
    const started = await startRun(dir, spikeInput({ host: 'codex' }));
    expect(started.ok, JSON.stringify(started)).toBe(true);
    const context = { state: started.run, ticket: started.run.tickets[0] };
    expect(context.ticket.capability_manifest.allowed_evidence_commands).toContain(profile.command);
    const event = { host: 'codex', is_subagent: true, ape_managed: true, tool_name: 'Bash',
      project_dir: dir, command: profile.command,
      evidence: { safe: true, cwd_safe: true, executable_safe: true, session_cwd: dir } };
    expect(evaluateLifecyclePolicy(event, context)).toMatchObject({ decision: 'allow' });
    for (const changed of [
      { command: `${profile.command} --host codex` }, { command: 'node scripts/other.mjs' },
      { command: `${profile.command}; touch injected` },
      { evidence: undefined }, { evidence: { ...event.evidence, safe: false } },
      { evidence: { ...event.evidence, executable_safe: false } },
      { evidence: { ...event.evidence, session_cwd: join(dir, 'nested') } },
    ]) expect(evaluateLifecyclePolicy({ ...event, ...changed }, context)).toMatchObject({ decision: 'deny' });
    const changed = structuredClone(context);
    changed.state.capability_snapshot.verification_profiles[0].command = 'node changed.mjs';
    expect(evaluateLifecyclePolicy(event, changed)).toMatchObject({ decision: 'deny' });
    const writer = structuredClone(context);
    writer.state.capability_snapshot.command_profiles.push({ id: 'declared-writer', command: profile.command,
      effect: 'write', roles: ['implementer'], output_paths: ['generated.js'] });
    expect(evaluateLifecyclePolicy(event, writer)).toMatchObject({ decision: 'deny' });
    const root = dirname(dirname(fileURLToPath(import.meta.url)));
    const action = started.actions.find(entry => entry.type === 'dispatch_agent');
    const binding = await bindCodexDispatchContext(root, dir, action);
    const nativeEvent = { hook_event_name: 'PreToolUse', project_dir: dir, cwd: dir,
      session_id: binding.sessionId, turn_id: binding.turnId, agent_id: binding.agentId,
      agent_type: 'default', model: action.ticket.model.model, is_subagent: true,
      tool_name: 'Bash', tool_input: { command: profile.command } };
    expect(await invokeCodexHook(root, nativeEvent)).toEqual({});
    expect(await invokeCodexHook(root, { ...nativeEvent,
      tool_input: { command: `${profile.command} --host codex` } }))
      .toMatchObject({ hookSpecificOutput: { permissionDecision: 'deny' } });
  });

  it('freezes the exact profile without imposing a worker deadline despite full classification', async () => {
    const dir = initRepository();
    dirs.push(dir);
    const input = spikeInput();

    const preview = await previewRun(dir, input);
    expect(preview.blueprint).toMatchObject({
      lane: 'full',
      ticket_deadline: { deadline_ms: null, source: 'no-worker-deadline' },
    });
    expect(preview.admission.ticket_deadline).toEqual(preview.blueprint.ticket_deadline);

    const started = await startRun(dir, input);
    expect(started.ok).toBe(true);
    expect(started.run.lane).toBe('full');
    expect(started.run.capability_snapshot.command_profiles).toContainEqual(PROFILE);
    const ticket = started.run.tickets[0];
    expect(ticket.role).toBe('spike_researcher');
    expect(ticket.capability_manifest.command_profiles).toEqual([PROFILE]);
    expect(ticket.deadline_at).toBeNull();
    expect(ticket.execution_limits.version).toBe(4);

    expect(evaluateLifecyclePolicy({
      host: 'claude',
      is_subagent: true,
      ape_managed: true,
      tool_name: 'Bash',
      command: PROFILE.command,
      project_dir: dir,
    }, { state: started.run, ticket })).toMatchObject({ decision: 'allow' });
    expect(evaluateLifecyclePolicy({
      host: 'claude',
      is_subagent: true,
      ape_managed: true,
      tool_name: 'Bash',
      command: 'date -u',
      project_dir: dir,
    }, { state: started.run, ticket })).toMatchObject({ decision: 'deny' });
  });
});
