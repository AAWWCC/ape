import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

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

  it('makes decomposition and explicit successor carry-forward part of the run protocol', () => {
    const run = read('plugin-src/skills/run/body.md');
    const protocol = read('plugin-src/skills/references/run-resume-protocol.md');
    expect(run).toMatch(/independent high-risk subsystems/i);
    expect(run).toMatch(/roadmap/i);
    expect(protocol).toMatch(/supersedes_run/);
    expect(protocol).toMatch(/carr(?:y|ies).*tree.*findings|tree.*findings.*carr/is);
  });

  it('makes readiness, spend bounds, and receipt repair runtime-owned', () => {
    const run = read('plugin-src/skills/run/body.md');
    const resume = read('plugin-src/skills/resume/body.md');
    const protocol = read('plugin-src/skills/references/run-resume-protocol.md');
    expect(run).toMatch(/ape_run preview/i);
    expect(run).toMatch(/max_worker_dispatches[\s\S]*max_active_seconds/i);
    expect(protocol).toMatch(/ape_validate_receipt/i);
    expect(protocol).toMatch(/initial validation plus at most two[\s\S]*corrections/i);
    expect(protocol).toMatch(/redispatch_same_ticket[\s\S]*worker_protocol_failure/i);
    expect(resume).toMatch(/redispatch_same_ticket/i);
  });
});
