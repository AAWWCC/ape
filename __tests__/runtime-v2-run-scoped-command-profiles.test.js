import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { DEFAULT_CONFIG, resolveTicketDeadline } from '../lib/runtime/config.js';
import { evaluateLifecyclePolicy } from '../lib/runtime/hooks.js';
import { projectedPipeline } from '../lib/runtime/pipeline.js';
import { evaluateRunReadiness } from '../lib/runtime/readiness.js';
import { RunStartInputSchema } from '../lib/runtime/schemas.js';
import { previewRun, startRun } from '../lib/runtime/service.js';

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
  execFileSync('git', ['init', '-b', 'main'], { cwd: dir, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.email', 'ape@example.test'], { cwd: dir });
  execFileSync('git', ['config', 'user.name', 'APE Test'], { cwd: dir });
  writeFileSync(join(dir, 'README.md'), '# fixture\n');
  execFileSync('git', ['add', 'README.md'], { cwd: dir });
  execFileSync('git', ['commit', '-m', 'init'], { cwd: dir, stdio: 'ignore' });
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

  it('makes the runtime deadline authoritative over timebox prose in the objective', () => {
    const common = readFileSync(new URL('../prompts/common.md', import.meta.url), 'utf8');
    const runSkill = readFileSync(new URL('../plugin-src/skills/run/body.md', import.meta.url), 'utf8');
    expect(common).toMatch(/`deadline_at` is the runtime-issued authorization horizon/iu);
    expect(common).toMatch(/never stop early[\s\S]*because of that prose/iu);
    expect(runSkill).toMatch(/Do not embed an execution budget[\s\S]*ticket deadline separately/iu);
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

  it('merges run-local profiles into readiness and rejects persistent-id ambiguity', () => {
    const input = RunStartInputSchema.parse(spikeInput());
    const classification = { lane: 'full', risk_triggers: [], reasons: ['empty-claims-full'] };
    const projection = projectedPipeline({
      mode: input.mode,
      lane: classification.lane,
      behavioral: input.behavioral,
      high_risk: false,
      plan_contract_version: 1,
      policy: { high_risk_security_review: true },
      remediation_cycles: 0,
      test_paths: [],
      claimed_paths: [],
    });
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

  it('freezes the exact profile and uses the spike-mode deadline despite full classification', async () => {
    const dir = initRepository();
    dirs.push(dir);
    const input = spikeInput();

    const preview = await previewRun(dir, input);
    expect(preview.blueprint).toMatchObject({
      lane: 'full',
      ticket_deadline: { deadline_ms: 900_000, source: 'mode:spike' },
    });

    const started = await startRun(dir, input);
    expect(started.ok).toBe(true);
    expect(started.run.lane).toBe('full');
    expect(started.run.capability_snapshot.command_profiles).toContainEqual(PROFILE);
    const ticket = started.run.tickets[0];
    expect(ticket.role).toBe('spike_researcher');
    expect(ticket.capability_manifest.command_profiles).toEqual([PROFILE]);
    expect(Date.parse(ticket.deadline_at) - Date.parse(ticket.issued_at)).toBe(900_000);

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
