import { execFileSync } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { candidatePlanForScope } from '../lib/runtime/plan-contract.js';
import { sha256 } from '../lib/runtime/canonical.js';
import { recordReceipt, startRun } from '../lib/runtime/service.js';
import { runtimePaths } from '../lib/runtime/paths.js';
import { atomicWriteJson, readJson } from '../lib/runtime/storage.js';

const HASH = 'a'.repeat(64);
const cleanups = [];

afterEach(async () => Promise.all(cleanups.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))));

function plan(overrides = {}) {
  return {
    version: 2,
    preflight_hash: HASH,
    requirements: [{ id: 'R1', requirement: 'Change the value', workstreams: ['build'] }],
    workstreams: [{
      id: 'build', outcome: 'The value changes safely',
      paths: [{ path: 'src/value.js', action: 'modify' }],
      steps: ['Change the exported value'],
      acceptance: ['Callers observe the new value'],
      evidence_commands: ['npm test'],
      verification_profiles: ['unit'],
    }],
    risks: [{ risk: 'Compatibility drift', mitigation: 'Run the required profile' }],
    non_goals: ['Changing unrelated exports'],
    ...overrides,
  };
}

const context = {
  preflight_hash: HASH,
  verification_profiles: [
    { id: 'unit', required: true },
    { id: 'docs', required: false },
  ],
};

async function integrationProject() {
  const dir = await mkdtemp(path.join(tmpdir(), 'ape-v2-plan-admission-'));
  cleanups.push(dir);
  await mkdir(path.join(dir, 'src'));
  await mkdir(path.join(dir, 'tests'));
  await writeFile(path.join(dir, 'src', 'value.js'), 'export const value = 1;\n');
  await writeFile(path.join(dir, 'tests', 'value.test.js'), 'throw new Error("red");\n');
  execFileSync('git', ['init', '-q'], { cwd: dir });
  execFileSync('git', ['config', 'user.email', 'ape@example.test'], { cwd: dir });
  execFileSync('git', ['config', 'user.name', 'APE Test'], { cwd: dir });
  execFileSync('git', ['add', '.'], { cwd: dir });
  execFileSync('git', ['commit', '-qm', 'test: baseline'], { cwd: dir });
  await atomicWriteJson(runtimePaths(dir).config, {
    shipping: { auto_merge: false, provider: 'github', required_remote_checks: false },
    test_commands: { full: 'npm test' },
    verification: {
      profiles: [{ id: 'unit', description: 'Run unit tests', command: 'npm test', root: '.', timeout_ms: 30_000 }],
    },
  });
  return dir;
}

describe('plan contract v2 bindings', () => {
  it('binds the exact preflight hash and assigns every required snapped profile', () => {
    expect(candidatePlanForScope(plan(), ['src/value.js'], null, context)).toMatchObject({
      valid: true, value: { plan: { version: 2, preflight_hash: HASH } },
    });
    expect(candidatePlanForScope(plan({ preflight_hash: 'b'.repeat(64) }), ['src/value.js'], null, context))
      .toMatchObject({ valid: false, errors: [expect.stringMatching(/preflight.*hash/i)] });
    const missing = plan();
    missing.workstreams[0].verification_profiles = [];
    expect(candidatePlanForScope(missing, ['src/value.js'], null, context))
      .toMatchObject({ valid: false, errors: [expect.stringMatching(/required.*profile|profile.*unit/i)] });
  });

  it('rejects duplicate and unknown assignments while allowing optional profiles to remain unassigned', () => {
    const duplicate = plan();
    duplicate.workstreams[0].verification_profiles = ['unit', 'unit'];
    expect(candidatePlanForScope(duplicate, ['src/value.js'], null, context).errors.join(' ')).toMatch(/duplicate/i);
    const unknown = plan();
    unknown.workstreams[0].verification_profiles = ['unit', 'missing'];
    expect(candidatePlanForScope(unknown, ['src/value.js'], null, context).errors.join(' ')).toMatch(/unknown.*profile/i);
  });

  it('keeps v1 admission byte compatible when no v2 context is supplied', () => {
    const legacy = plan();
    legacy.version = 1;
    delete legacy.preflight_hash;
    delete legacy.workstreams[0].verification_profiles;
    expect(candidatePlanForScope(legacy, ['src/value.js'])).toMatchObject({ valid: true });
  });

  it('applies v2 hash and required-profile admission at the production planner receipt boundary', async () => {
    const dir = await integrationProject();
    const objective = 'Change the value without breaking callers';
    const started = await startRun(dir, {
      objective, mode: 'phase', lane: 'full', host: 'codex',
      claimed_paths: ['src/value.js'], test_paths: ['tests/value.test.js'],
      requirements: ['R1'], risk_triggers: [], behavioral: true,
      hooks_trusted: true, subagents_available: true, explicit_invocation: true,
      plan_contract_version: 2,
    });
    const artifact = {
      version: 1,
      objective,
      acceptance: ['The new value is observable'],
      non_goals: [],
      baseline: [{ command: 'npm test', observation: 'The focused assertion is red', output_hash: 'c'.repeat(64) }],
      impacted_paths: { read: [], write: ['src/value.js', 'tests/value.test.js'] },
      compatibility: 'Keep the named export stable.',
      rollback: 'Revert the value and focused assertion.',
      verification_profiles: [{ id: 'unit', disposition: 'required', reason: 'Behavior changed.' }],
      questions: [],
    };
    const preflight = await recordReceipt(dir, {
      ticket_id: started.run.tickets[0].ticket_id,
      status: 'passed', agent_identity: 'agent-preflight',
      tests: [{ command: 'npm test', passed: false, exit_code: 1, duration_ms: 10, output_hash: 'c'.repeat(64) }],
      findings: [], evidence: { preflight_artifact: artifact },
      timing: { started_at: started.run.tickets[0].issued_at, duration_ms: 10 },
    });
    expect(preflight.ok, JSON.stringify(preflight.errors)).toBe(true);
    const planner = preflight.run.tickets.find((ticket) => ticket.stage_id === 'plan');
    expect(planner.preflight.artifact_hash).toBe(sha256(artifact));

    const before = await readJson(runtimePaths(dir).active);
    const invalid = plan({ preflight_hash: 'b'.repeat(64) });
    const recorded = await recordReceipt(dir, {
      ticket_id: planner.ticket_id,
      status: 'passed', agent_identity: 'agent-planner', tests: [], findings: [],
      evidence: { candidate_plan: invalid },
      timing: { started_at: planner.issued_at, duration_ms: 10 },
    });
    expect(recorded).toMatchObject({ ok: false, rejected: true });
    expect(recorded.errors.join(' ')).toMatch(/preflight.*hash/i);
    expect(await readJson(runtimePaths(dir).active)).toEqual(before);
  });
});

