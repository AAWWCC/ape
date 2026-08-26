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
import { validateTicket } from '../lib/runtime/schemas.js';
import { projectRunResponse, RESPONSE_BUDGET_CHARS } from '../lib/runtime/projection.js';

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

function concurrencyAssurance() {
  return {
    id: 'A1',
    risk_trigger: 'concurrency',
    threat_model: 'Concurrent cooperating writers may crash or race; unrelated directory writers are outside authority.',
    feasibility: 'An exclusive ownership-checked lock serializes the supported writers on every target platform.',
    failure_modes: ['Crash after lock acquisition', 'Destination replacement immediately before persistence'],
    crash_recovery: 'A successor proves the recorded owner is dead before removing a stale lock.',
    migration: 'Existing unlocked data remains readable and is rewritten only after validation.',
    determinism: 'Equivalent inputs produce byte-identical output independent of writer order.',
    executable_tests: ['Terminate a lock owner and prove a successor proceeds without deleting a live lock.'],
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

function stageReceipt(ticket, overrides = {}) {
  return {
    ticket_id: ticket.ticket_id,
    status: 'passed',
    agent_identity: `agent-${ticket.role}`,
    tests: [],
    findings: [],
    evidence: { verdict: 'pass' },
    timing: { started_at: ticket.issued_at, duration_ms: 10 },
    ...overrides,
  };
}

function preflightArtifact(objective) {
  return {
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
}

async function readDiskTicket(dir, ticket) {
  return readJson(path.join(
    runtimePaths(dir).tickets,
    `${ticket.ticket_id.replaceAll(':', '_')}.json`,
  ));
}

async function walkToV2Review(dir) {
  const objective = 'Change the value without breaking callers';
  const started = await startRun(dir, {
    objective, mode: 'phase', lane: 'full', host: 'codex',
    claimed_paths: ['src/value.js'], test_paths: ['tests/value.test.js'],
    requirements: ['R1'], risk_triggers: [], behavioral: true,
    hooks_trusted: true, subagents_available: true, explicit_invocation: true,
    plan_contract_version: 2,
  });
  expect(started.ok).toBe(true);
  const preflightTicket = started.run.tickets.at(-1);
  expect(preflightTicket.stage_id).toBe('preflight');
  const artifact = preflightArtifact(objective);
  const preflight = await recordReceipt(dir, stageReceipt(preflightTicket, {
    tests: [{ command: 'npm test', passed: false, exit_code: 1, duration_ms: 10, output_hash: 'c'.repeat(64) }],
    evidence: { preflight_artifact: artifact },
  }));
  expect(preflight.ok, JSON.stringify(preflight.errors)).toBe(true);
  const planner = preflight.run.tickets.at(-1);
  expect(planner.stage_id).toBe('plan');
  const admittedPlan = plan({ preflight_hash: sha256(artifact) });
  const candidatePlan = { plan_hash: sha256(admittedPlan), plan: admittedPlan };
  const planned = await recordReceipt(dir, stageReceipt(planner, {
    evidence: { verdict: 'pass', candidate_plan: admittedPlan },
  }));
  expect(planned.ok, JSON.stringify(planned.errors)).toBe(true);
  const planCheck = planned.run.tickets.find((ticket) => ticket.stage_id === 'plan-check');
  const planCritic = planned.run.tickets.find((ticket) => ticket.stage_id === 'plan-critic');
  expect(planCheck?.parallel_group).toBe('plan-review');
  expect(planCritic?.parallel_group).toBe('plan-review');
  return { planned, planner, candidatePlan, planCheck, planCritic };
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

  it('requires a feasibility and failure-mode assurance for every declared risk trigger', () => {
    const riskContext = {
      ...context,
      require_design_assurance: true,
      risk_triggers: ['concurrency'],
    };
    expect(candidatePlanForScope(plan(), ['src/value.js'], null, riskContext)).toMatchObject({
      valid: false,
      errors: [expect.stringMatching(/design assurance.*concurrency/i)],
    });
    expect(candidatePlanForScope(
      plan({ assurances: [concurrencyAssurance()] }),
      ['src/value.js'],
      null,
      riskContext,
    )).toMatchObject({ valid: true });
  });

  it('seals declared risk triggers into v2 preflight and planner tickets', async () => {
    const dir = await integrationProject();
    const objective = 'Change the value behind a least-privilege boundary';
    const started = await startRun(dir, {
      objective, mode: 'phase', lane: 'full', host: 'codex',
      claimed_paths: ['src/value.js'], test_paths: ['tests/value.test.js'],
      requirements: ['R1'], risk_triggers: ['security'], behavioral: true,
      hooks_trusted: true, subagents_available: true, explicit_invocation: true,
      plan_contract_version: 2,
    });
    expect(started.ok).toBe(true);
    const preflightTicket = started.run.tickets.at(-1);
    expect(preflightTicket).toMatchObject({
      stage_id: 'preflight',
      risk_triggers: ['security'],
    });
    expect(await readDiskTicket(dir, preflightTicket)).toMatchObject({
      risk_triggers: ['security'],
    });

    const artifact = preflightArtifact(objective);
    const preflight = await recordReceipt(dir, stageReceipt(preflightTicket, {
      tests: [{ command: 'npm test', passed: false, exit_code: 1, duration_ms: 10, output_hash: 'c'.repeat(64) }],
      evidence: { preflight_artifact: artifact },
    }));
    expect(preflight.ok, JSON.stringify(preflight.errors)).toBe(true);
    const planner = preflight.run.tickets.at(-1);
    expect(planner).toMatchObject({ stage_id: 'plan', risk_triggers: ['security'] });
    const persisted = await readDiskTicket(dir, planner);
    expect(persisted.risk_triggers).toEqual(['security']);
    expect(validateTicket(persisted)).toMatchObject({ valid: true });

    const securityAssurance = {
      ...concurrencyAssurance(),
      id: 'A-security',
      risk_trigger: 'security',
    };
    const admittedPlan = plan({
      preflight_hash: sha256(artifact),
      assurances: [securityAssurance],
    });
    const planned = await recordReceipt(dir, stageReceipt(planner, {
      evidence: { candidate_plan: admittedPlan },
    }));
    expect(planned.ok, JSON.stringify(planned.errors)).toBe(true);
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

describe('plan contract v2 complete candidate forwarding', () => {
  it('forwards the admitted candidate unchanged to both parallel reviewers and their valid disk tickets', async () => {
    const dir = await integrationProject();
    const { planned, candidatePlan, planCheck, planCritic } = await walkToV2Review(dir);

    for (const ticket of [planCheck, planCritic]) {
      expect(ticket.candidate_plan).toEqual(candidatePlan);
      expect(ticket.candidate_plan.plan_hash).toBe(candidatePlan.plan_hash);
      expect(ticket).not.toHaveProperty('plan_artifact');
      const persisted = await readDiskTicket(dir, ticket);
      expect(persisted.candidate_plan).toEqual(candidatePlan);
      expect(persisted).not.toHaveProperty('plan_artifact');
      expect(validateTicket(persisted)).toMatchObject({ valid: true });
    }

    const projected = projectRunResponse(planned);
    expect(JSON.stringify(projected).length).toBeLessThan(RESPONSE_BUDGET_CHARS);
    const wireReviewers = projected.actions
      .filter((action) => action.type === 'dispatch_agent')
      .map((action) => action.ticket);
    expect(wireReviewers).toHaveLength(2);
    const wireCopies = [
      ...projected.run.tickets.filter((ticket) => ticket.stage_id === 'plan-check' || ticket.stage_id === 'plan-critic'),
      ...wireReviewers,
    ];
    expect(wireCopies.filter((ticket) => ticket.candidate_plan?.plan)).toHaveLength(1);
    expect(wireReviewers.every((ticket) => ticket.candidate_plan?.plan_hash === candidatePlan.plan_hash)).toBe(true);
  }, 30_000);

  it('re-derives the complete candidate for a judge retry and keeps it off the following non-plan ticket', async () => {
    const dir = await integrationProject();
    const { candidatePlan, planCheck, planCritic } = await walkToV2Review(dir);
    const checked = await recordReceipt(dir, stageReceipt(planCheck, {
      evidence: { verdict: 'agree' },
    }));
    expect(checked.ok).toBe(true);
    const criticized = await recordReceipt(dir, stageReceipt(planCritic, {
      evidence: { verdict: 'disagree' },
    }));
    expect(criticized.ok).toBe(true);
    const judge = criticized.run.tickets.at(-1);
    expect(judge.stage_id).toBe('plan-judge');
    expect(judge.candidate_plan).toEqual(candidatePlan);
    expect(judge).not.toHaveProperty('plan_artifact');

    const failed = await recordReceipt(dir, stageReceipt(judge, {
      status: 'failed', evidence: { summary: 'judge tooling failed' },
    }));
    expect(failed.ok).toBe(true);
    const retry = failed.run.tickets.at(-1);
    expect(retry).toMatchObject({ stage_id: 'plan-judge', attempt: 2 });
    expect(retry.candidate_plan).toEqual(candidatePlan);
    expect(retry).not.toHaveProperty('plan_artifact');
    const retryDisk = await readDiskTicket(dir, retry);
    expect(retryDisk.candidate_plan).toEqual(candidatePlan);
    expect(validateTicket(retryDisk)).toMatchObject({ valid: true });

    const judged = await recordReceipt(dir, stageReceipt(retry, {
      evidence: { verdict: 'agree' },
    }));
    expect(judged.ok).toBe(true);
    const testTicket = judged.run.tickets.at(-1);
    expect(testTicket.stage_id).toBe('test');
    expect(testTicket).not.toHaveProperty('candidate_plan');
    expect(testTicket).not.toHaveProperty('plan_artifact');
    expect(testTicket.approved_plan).toMatchObject({
      plan_hash: candidatePlan.plan_hash,
      plan: candidatePlan.plan,
    });
  }, 30_000);
});
