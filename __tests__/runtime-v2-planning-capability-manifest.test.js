import { describe, expect, it } from 'vitest';
import { ticketCapabilityManifest } from '../lib/runtime/capability-manifest.js';
import { DEFAULT_CONFIG } from '../lib/runtime/config.js';
import { projectedPipeline } from '../lib/runtime/pipeline.js';
import { evaluateRunReadiness } from '../lib/runtime/readiness.js';
import { RunStartInputSchema } from '../lib/runtime/schemas.js';

const PLANNING_ROLES = [
  'planner',
  'plan_checker',
  'plan_critic',
  'plan_judge',
];

function stateFixture() {
  const requiredCapabilities = [
    { kind: 'command_profile', id: 'typecheck', role: 'implementer' },
    { kind: 'command_profile', id: 'lint', role: 'reviewer' },
  ];
  const commandProfiles = [
    {
      id: 'plan-inspect',
      command: 'npm run plan-inspect',
      roles: ['planner'],
      effect: 'read',
    },
    {
      id: 'typecheck',
      command: 'npm run typecheck',
      roles: ['implementer'],
      effect: 'read',
    },
    {
      id: 'lint',
      command: 'npm run lint',
      roles: ['reviewer'],
      effect: 'read',
    },
    {
      id: 'unreachable-debug-command',
      command: 'npm run debug-only',
      roles: ['debugger'],
      effect: 'execute',
    },
  ];
  return {
    binding_protocol: 'native-v1',
    objective: 'Plan and implement a verified change',
    risk_triggers: [],
    policy: { design_assurance_required: true },
    capability_snapshot: {
      version: 1,
      config_hash: 'a'.repeat(64),
      manifest_roles: [
        ...PLANNING_ROLES,
        'implementer',
        'reviewer',
      ],
      required_capabilities: requiredCapabilities,
      command_profiles: commandProfiles,
      verification_profiles: [],
      runners: [],
      test_commands: { full: 'npm test' },
      evidence_scripts: [],
    },
  };
}

describe('planning capability manifests', () => {
  it('publishes one frozen future-role catalog without widening current-role authority', () => {
    const state = stateFixture();
    const views = PLANNING_ROLES.map((role) =>
      ticketCapabilityManifest(state, { role }, []));

    for (const view of views) {
      expect(view.planning_required_capabilities)
        .toEqual(state.capability_snapshot.required_capabilities);
      expect(view.plannable_evidence_commands).toEqual([
        'npm run lint',
        'npm run plan-inspect',
        'npm run typecheck',
        'npm test',
      ]);
      expect(view.planning_command_profiles)
        .toEqual(state.capability_snapshot.command_profiles.slice(0, 3));
    }
    expect(views.slice(1).every((view) =>
      JSON.stringify(view.planning_required_capabilities) ===
        JSON.stringify(views[0].planning_required_capabilities) &&
      JSON.stringify(view.plannable_evidence_commands) ===
        JSON.stringify(views[0].plannable_evidence_commands) &&
      JSON.stringify(view.planning_command_profiles) ===
        JSON.stringify(views[0].planning_command_profiles))).toBe(true);

    expect(views[0].command_profiles.map((profile) => profile.id))
      .toEqual(['plan-inspect']);
    expect(views[0].allowed_evidence_commands)
      .toEqual(['npm run plan-inspect', 'npm test']);
    for (const view of views.slice(1)) {
      expect(view.command_profiles).toEqual([]);
      expect(view.allowed_evidence_commands).toEqual(['npm test']);
    }

    const implementerView = ticketCapabilityManifest(state, { role: 'implementer' }, []);
    expect(implementerView.command_profiles.map((profile) => profile.id))
      .toEqual(['typecheck']);
    expect(implementerView.allowed_evidence_commands)
      .toEqual(['npm run typecheck', 'npm test']);
    expect(implementerView).not.toHaveProperty('planning_required_capabilities');
    expect(implementerView).not.toHaveProperty('plannable_evidence_commands');
    expect(implementerView).not.toHaveProperty('planning_command_profiles');
  });

  it('sizes the combined planning catalog before admitting the run', () => {
    const config = structuredClone(DEFAULT_CONFIG);
    config.test_commands = {
      targeted_template: 'npm test -- {paths}',
      full: 'npm test',
    };
    const executionRoles = ['test_writer', 'implementer', 'reviewer'];
    config.policy.command_profiles = Array.from({ length: 64 }, (_, index) => ({
      id: `large-profile-${index}`,
      command: `node tool.js --profile=${index}-${'x'.repeat(3_000)}`,
      roles: [executionRoles[index % executionRoles.length]],
      effect: 'read',
    }));
    const input = RunStartInputSchema.parse({
      objective: 'Plan and implement a verified change',
      mode: 'phase',
      lane: 'full',
      host: 'codex',
      claimed_paths: ['src/example.js'],
      test_paths: ['src/example.test.js'],
      requirements: [],
      risk_triggers: [],
      behavioral: true,
      hooks_trusted: true,
      subagents_available: true,
      explicit_invocation: true,
      binding_protocol: 'native-v1',
      plan_contract_version: 2,
      execution_budget_required: true,
      execution_budget: {
        max_worker_dispatches: 100,
        max_active_seconds: 100_000,
      },
    });
    const classification = { lane: 'full', risk_triggers: [], reasons: [] };
    const projection = projectedPipeline({
      mode: input.mode,
      lane: classification.lane,
      behavioral: input.behavioral,
      high_risk: false,
      plan_contract_version: 2,
      policy: { high_risk_security_review: true },
      remediation_cycles: 0,
      test_paths: input.test_paths,
      claimed_paths: input.claimed_paths,
    });
    const readiness = evaluateRunReadiness({
      input,
      config,
      classification,
      projection,
      discovered: { targeted: true, full: true },
    });
    const manifestSizeFailures = readiness.blocking.filter((entry) =>
      entry.code === 'capability-manifest-bytes-over-limit');

    expect(readiness.ready).toBe(false);
    expect([...new Set(manifestSizeFailures.map((entry) => entry.role))].sort())
      .toEqual([...PLANNING_ROLES].sort());
  });
});
