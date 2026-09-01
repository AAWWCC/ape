import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { evaluateRunReadiness } from '../lib/runtime/readiness.js';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const read = (file) => readFileSync(path.join(root, file), 'utf8');

describe('APE prevents late blocker discovery', () => {
  it('requires high-risk plans to settle feasibility and the threat model before writers run', () => {
    const preflight = read('prompts/preflight_analyst.md');
    const planner = read('prompts/planner.md');
    const critic = read('prompts/plan_critic.md');

    expect(preflight).toMatch(/threat model/i);
    expect(preflight).toMatch(/feasib/i);
    expect(preflight).toMatch(/decompos/i);
    expect(planner).toMatch(/assurances/i);
    for (const field of [
      'risk_trigger', 'threat_model', 'feasibility', 'failure_modes',
      'crash_recovery', 'migration', 'determinism', 'executable_tests',
    ]) {
      expect(planner).toContain(`"${field}"`);
    }
    expect(critic).toMatch(/last check.*sink|check.*to.*sink/is);
    expect(critic).toMatch(/same-directory|same directory/i);
  });

  it('requires executable adversarial tests instead of source-token evidence', () => {
    const writer = read('prompts/test_writer.md');
    expect(writer).toMatch(/source-text|source token/i);
    expect(writer).toMatch(/must not count|does not count|do not\s+count/i);
    expect(writer).toMatch(/final.*check.*before.*sink|after.*last.*check/is);
    expect(writer).toMatch(/crash.*recovery/i);
    expect(writer).toMatch(/legacy(?:-data)?.*fixture/is);
  });

  it('makes decomposition and fail-closed blocked recovery part of the run protocol', () => {
    const run = read('plugin-src/skills/run/body.md');
    const protocol = read('plugin-src/skills/references/run-resume-protocol.md');
    const lifecycle = read('lib/runtime/lifecycle-service.js');
    expect(run).toMatch(/independent high-risk subsystems/i);
    expect(run).toMatch(/roadmap/i);
    expect(protocol).toMatch(/authenticated human provenance/i);
    expect(protocol).toMatch(/ape_run override[\s\S]{0,80}operation: "reset"/i);
    expect(protocol).toMatch(/explicitly directs recovery/i);
    expect(protocol).not.toMatch(/prepare-successor|UserPromptSubmit/);
    expect(lifecycle).toContain("landStartPoint ?? baseCommitSha");
    expect(lifecycle).not.toContain("landStartPoint ?? base.start_point");
  });

  it('makes readiness, spend bounds, and receipt repair runtime-owned', () => {
    const run = read('plugin-src/skills/run/body.md');
    const resume = read('plugin-src/skills/resume/body.md');
    const protocol = read('plugin-src/skills/references/run-resume-protocol.md');
    expect(run).toMatch(/ape_run preview/i);
    expect(run).toMatch(/deterministic dispatch bounds/i);
    expect(run).not.toMatch(/max_worker_dispatches|max_active_seconds|extend-budget/i);
    expect(protocol).toMatch(/ape_validate_receipt/i);
    expect(protocol).toMatch(/initial validation plus at most two[\s\S]*corrections/i);
    expect(protocol).toMatch(/redispatch_same_ticket[\s\S]*worker_protocol_failure/i);
    expect(resume).toMatch(/redispatch_same_ticket/i);
  });

  it('compiles every reachable role and future transition surface before dispatch', () => {
    const input = {
      objective: 'Compile the complete reachable surface',
      claimed_paths: ['src/value.js'],
      test_paths: ['tests/value.test.js'],
      requirements: ['R1'],
      behavioral: false,
      capability_contract_required: true,
      required_capabilities: [],
      run_command_profiles: [],
    };
    const config = {
      policy: {
        evidence_scripts: [],
        command_profiles: [{
          id: 'review.audit',
          roles: ['reviewer'],
          command: 'npm run review:audit',
        }],
      },
      verification: {
        profiles: [{
          id: 'unit',
          description: 'Unit verification',
          command: 'npm test',
          root: '.',
          timeout_ms: 30_000,
        }],
      },
      runners: [],
      test_commands: {},
    };
    const projection = {
      stages: [
        { id: 'plan', role: 'planner', required_checks: [] },
        { id: 'build', role: 'implementer', required_checks: ['targeted-tests'] },
        { id: 'review', role: 'reviewer', required_checks: [] },
        { id: 'remediation-review', role: 'reviewer', required_checks: [] },
      ],
    };
    const readiness = evaluateRunReadiness({
      input,
      config,
      classification: { lane: 'full', risk_triggers: ['public-api'] },
      projection,
    });

    expect(readiness.compiled_surface).toEqual({
      version: 1,
      roles: ['planner', 'implementer', 'reviewer'],
      transition_scenarios: ['initial', 'future-monotone-fields'],
      includes: [
        'command_profiles',
        'evidence_commands',
        'path_claims',
        'test_claims',
        'verification_profiles',
        'receipt_schemas',
        'field_bounds',
        'byte_budgets',
      ],
    });
    expect(readiness.derived_capability_requirements.stage_roles)
      .toEqual(['planner', 'implementer', 'reviewer']);
  });
});
