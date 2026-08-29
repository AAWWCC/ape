import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../lib/runtime/gates.js', async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, autoMergeGithub: vi.fn(), pollRemoteChecksAndMerge: vi.fn() };
});

import { evaluateLifecyclePolicy } from '../lib/runtime/lifecycle-policy.js';
import { sha256 } from '../lib/runtime/canonical.js';
import { runtimePaths } from '../lib/runtime/paths.js';
import {
  recordReceipt,
  startRun,
  validateReceiptForDispatch,
} from '../lib/runtime/service.js';
import { atomicWriteJson, readJson } from '../lib/runtime/storage.js';
import { bindCodexDispatch } from './codex-native-test-helper.js';

const TYPECHECK = 'npm run typecheck';
const LINT = 'npm run lint';
const PLANNING_ROLES = ['planner', 'plan_checker', 'plan_critic', 'plan_judge'];
const PROFILE_ROLES = ['planner', 'implementer', 'reviewer'];
const COMMAND_PROFILES = [
  {
    id: 'project.typecheck',
    command: TYPECHECK,
    roles: PROFILE_ROLES,
    effect: 'execute',
  },
  {
    id: 'project.lint',
    command: LINT,
    roles: PROFILE_ROLES,
    effect: 'execute',
  },
];
const REQUIRED_CAPABILITIES = [
  { kind: 'command_profile', id: 'project.typecheck', role: 'implementer' },
  { kind: 'command_profile', id: 'project.lint', role: 'reviewer' },
];
const OBJECTIVE = 'Fix the value while preserving the authorized typecheck and lint proof';

function candidatePlan(preflightHash) {
  return {
    version: 2,
    preflight_hash: preflightHash,
    requirements: [{
      id: 'R1',
      requirement: 'Keep typecheck and lint as mandatory downstream proof',
      workstreams: ['implementation'],
    }],
    workstreams: [{
      id: 'implementation',
      outcome: 'The implementation preserves both configured checks',
      paths: [
        { path: 'src/value.js', action: 'modify' },
        { path: 'tests/value.test.js', action: 'modify' },
      ],
      steps: ['Write the focused test, then implement the behavior'],
      acceptance: ['Both configured project checks pass'],
      evidence_commands: [TYPECHECK, LINT],
      verification_profiles: [],
    }],
    risks: [{
      risk: 'A reviewer could mistake its own execution boundary for missing downstream proof',
      mitigation: 'Expose the frozen planning view without widening reviewer execution authority',
    }],
    non_goals: ['Granting plan reviewers shell execution'],
  };
}

function preflightArtifact() {
  return {
    version: 1,
    objective: OBJECTIVE,
    acceptance: ['Both configured project checks remain admitted downstream proof'],
    non_goals: ['Granting plan reviewers shell execution'],
    baseline: [{
      command: 'node tests/value.test.js',
      observation: 'The focused behavior is red before implementation',
    }],
    impacted_paths: {
      read: [],
      write: ['src/value.js', 'tests/value.test.js'],
    },
    compatibility: 'Keep the exported value API stable.',
    rollback: 'Revert the focused source and test changes.',
    verification_profiles: [],
    questions: [],
  };
}

const repoRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const cleanups = [];
const receiptCapabilities = new Map();
let dispatchOrdinal = 0;
afterEach(async () => {
  receiptCapabilities.clear();
  dispatchOrdinal = 0;
  await Promise.all(cleanups.splice(0).map((directory) =>
    rm(directory, { recursive: true, force: true })));
});

function git(cwd, ...args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

async function project() {
  const directory = await mkdtemp(path.join(tmpdir(), 'ape-planning-capability-projection-'));
  cleanups.push(directory);
  await mkdir(path.join(directory, 'src'));
  await mkdir(path.join(directory, 'tests'));
  await writeFile(path.join(directory, 'src', 'value.js'), 'export const value = 1;\n');
  await writeFile(path.join(directory, 'tests', 'value.test.js'), 'throw new Error("red");\n');
  await writeFile(path.join(directory, 'package.json'), `${JSON.stringify({
    scripts: {
      typecheck: 'node --check src/value.js',
      lint: 'node --check src/value.js',
    },
  }, null, 2)}\n`);
  git(directory, 'init', '-q');
  git(directory, 'config', 'user.email', 'ape@example.test');
  git(directory, 'config', 'user.name', 'APE Test');
  git(directory, 'add', '.');
  git(directory, 'commit', '-qm', 'test: baseline');
  await atomicWriteJson(runtimePaths(directory).config, {
    shipping: { auto_merge: false, provider: 'github', required_remote_checks: false },
    test_commands: {
      targeted_template: 'node {paths}',
      full: 'node --test',
    },
    policy: {
      design_assurance_required: false,
      command_profiles: COMMAND_PROFILES,
    },
  });
  return directory;
}

function startInput() {
  return {
    objective: OBJECTIVE,
    mode: 'phase',
    lane: 'full',
    host: 'codex',
    claimed_paths: ['src/value.js'],
    test_paths: ['tests/value.test.js'],
    requirements: ['R1'],
    required_capabilities: REQUIRED_CAPABILITIES,
    risk_triggers: [],
    behavioral: true,
    hooks_trusted: true,
    subagents_available: true,
    explicit_invocation: true,
    binding_protocol: 'native-v1',
    plan_contract_version: 2,
    execution_budget_required: true,
    execution_budget: { max_worker_dispatches: 10, max_active_seconds: 3_600 },
  };
}

function receipt(ticket, overrides = {}) {
  const receiptCapability = receiptCapabilities.get(ticket.ticket_id);
  if (!receiptCapability) throw new Error(`ticket ${ticket.ticket_id} was not bound before receipt`);
  return {
    ticket_id: ticket.ticket_id,
    receipt_capability: receiptCapability,
    status: 'passed',
    agent_identity: `agent-${ticket.role}`,
    tests: [],
    findings: [],
    evidence: { verdict: 'agree' },
    timing: { started_at: ticket.issued_at, duration_ms: 10 },
    ...overrides,
  };
}

async function bindDispatches(directory, result) {
  const actions = result.actions.filter((action) => action.type === 'dispatch_agent');
  for (const action of actions) {
    const capability = await bindCodexDispatch(
      repoRoot,
      directory,
      action,
      dispatchOrdinal += 1,
    );
    receiptCapabilities.set(action.ticket.ticket_id, capability);
  }
}

async function recordValidatedReceipt(directory, draft) {
  const validation = await validateReceiptForDispatch(
    directory,
    draft,
    draft.ticket_id,
  );
  expect(validation.valid, JSON.stringify(validation.corrections ?? validation.errors)).toBe(true);
  expect(validation.attested).toBe(true);
  return recordReceipt(directory, draft);
}

function manifest(ticket) {
  expect(ticket.receipt_contract_version).toBe(1);
  return ticket.capability_manifest;
}

function assertSharedPlanningView(ticket, expected) {
  const capabilityManifest = manifest(ticket);
  expect(PLANNING_ROLES).toContain(ticket.role);
  expect(capabilityManifest.planning_required_capabilities)
    .toEqual(expected.planning_required_capabilities);
  expect(capabilityManifest.plannable_evidence_commands)
    .toEqual(expected.plannable_evidence_commands);
  expect(capabilityManifest.planning_command_profiles)
    .toEqual(expected.planning_command_profiles);
}

function assertPlanReviewerCannotExecuteProfiles(ticket) {
  const capabilityManifest = manifest(ticket);
  expect(['plan_checker', 'plan_critic', 'plan_judge']).toContain(ticket.role);
  expect(capabilityManifest.allowed_evidence_commands).not.toContain(TYPECHECK);
  expect(capabilityManifest.allowed_evidence_commands).not.toContain(LINT);
  expect(capabilityManifest.command_profiles).toEqual([]);
  expect(capabilityManifest.required_capabilities).toEqual([]);
}

function shellEvent(directory, command) {
  return {
    event: 'PreToolUse',
    tool_name: 'Bash',
    command,
    project_dir: directory,
    host: 'codex',
    is_subagent: true,
    ape_managed: true,
  };
}

async function reachPlanReview(directory) {
  const started = await startRun(directory, startInput());
  expect(started.ok, JSON.stringify(started.blocking ?? started.errors)).toBe(true);
  expect(started.run).toMatchObject({
    lane: 'full',
    mode: 'phase',
    binding_protocol: 'native-v1',
    plan_contract_version: 2,
  });
  await bindDispatches(directory, started);
  const preflight = started.run.tickets.at(-1);
  expect(preflight).toMatchObject({ stage_id: 'preflight', role: 'preflight_analyst' });
  const artifact = preflightArtifact();
  const preflighted = await recordValidatedReceipt(directory, receipt(preflight, {
    tests: [{
      command: 'node tests/value.test.js',
      passed: false,
      exit_code: 1,
      duration_ms: 10,
    }],
    evidence: { preflight_artifact: artifact },
  }));
  expect(preflighted.ok, JSON.stringify(preflighted.errors)).toBe(true);
  await bindDispatches(directory, preflighted);
  const planner = preflighted.run.tickets.at(-1);
  expect(planner).toMatchObject({ stage_id: 'plan', role: 'planner' });
  const plan = candidatePlan(sha256(artifact));
  const planned = await recordValidatedReceipt(directory, receipt(planner, {
    evidence: { verdict: 'pass', candidate_plan: plan },
  }));
  expect(planned.ok, JSON.stringify(planned.errors)).toBe(true);
  await bindDispatches(directory, planned);
  const checker = planned.run.tickets.find((ticket) => ticket.stage_id === 'plan-check');
  const critic = planned.run.tickets.find((ticket) => ticket.stage_id === 'plan-critic');
  expect(checker).toMatchObject({ role: 'plan_checker', parallel_group: 'plan-review' });
  expect(critic).toMatchObject({ role: 'plan_critic', parallel_group: 'plan-review' });
  return { started, preflight, preflighted, planner, plan, planned, checker, critic };
}

describe('native full-phase planning capability projection', () => {
  it('lets all planning roles assess downstream proof without granting plan reviewers execution authority', async () => {
    const directory = await project();
    const { planner, planned, checker, critic } = await reachPlanReview(directory);
    const planningView = manifest(planner);

    expect(planningView.planning_required_capabilities).toEqual(REQUIRED_CAPABILITIES);
    expect(planningView.plannable_evidence_commands).toEqual(expect.arrayContaining([
      TYPECHECK,
      LINT,
    ]));
    expect(planningView.planning_command_profiles).toEqual(COMMAND_PROFILES);
    for (const reviewer of [checker, critic]) {
      assertSharedPlanningView(reviewer, planningView);
      assertPlanReviewerCannotExecuteProfiles(reviewer);
      expect(reviewer.candidate_plan.plan.evidence_commands).toBeUndefined();
      expect(reviewer.candidate_plan.plan.workstreams[0].evidence_commands)
        .toEqual([TYPECHECK, LINT]);
    }

    const activeBeforeRejectedReceipt = await readJson(runtimePaths(directory).active);
    const rejectedReceipt = await validateReceiptForDispatch(directory, receipt(checker, {
      tests: [{ command: TYPECHECK, passed: true, exit_code: 0, duration_ms: 10 }],
    }), checker.ticket_id);
    expect(rejectedReceipt).toMatchObject({ valid: false, attested: false });
    expect(rejectedReceipt.corrections.map((entry) => `${entry.field}: ${entry.issue}`).join(' '))
      .toMatch(/allowed_evidence_commands|command/i);
    const activeAfterRejectedReceipt = await readJson(runtimePaths(directory).active);
    expect(activeAfterRejectedReceipt.receipts).toEqual(activeBeforeRejectedReceipt.receipts);
    expect(activeAfterRejectedReceipt.tickets).toEqual(activeBeforeRejectedReceipt.tickets);
    expect(activeAfterRejectedReceipt.stage).toBe(activeBeforeRejectedReceipt.stage);

    expect(evaluateLifecyclePolicy(shellEvent(directory, TYPECHECK), {
      state: planned.run,
      ticket: checker,
    })).toMatchObject({ decision: 'deny' });

    const checked = await recordValidatedReceipt(directory, receipt(checker));
    expect(checked.ok, JSON.stringify(checked.errors)).toBe(true);
    const criticized = await recordValidatedReceipt(directory, receipt(critic));
    expect(criticized.ok, JSON.stringify(criticized.errors)).toBe(true);
    await bindDispatches(directory, criticized);
    expect(criticized.run.approved_plan).toMatchObject({ approval_route: 'unanimous' });
    expect(criticized.run.tickets.some((ticket) =>
      ['plan-judge', 'plan-replan'].includes(ticket.stage_id))).toBe(false);
    const writer = criticized.run.tickets.at(-1);
    expect(writer).toMatchObject({ stage_id: 'test', role: 'test_writer', writable: true });
    const unanimouslyAdvanced = await readJson(runtimePaths(directory).active);
    expect(unanimouslyAdvanced.execution_budget).toMatchObject({
      max_worker_dispatches: 10,
      worker_dispatches_used: expect.any(Number),
    });
    expect(unanimouslyAdvanced.execution_budget.worker_dispatches_used).toBeLessThan(10);
    expect(unanimouslyAdvanced.status).toBe('running');

    await writeFile(
      path.join(directory, 'tests', 'value.test.js'),
      'throw new Error("still red");\n',
    );
    const tested = await recordValidatedReceipt(directory, receipt(writer, {
      tests: [{
        command: 'node tests/value.test.js',
        passed: false,
        exit_code: 1,
        duration_ms: 10,
      }],
    }));
    expect(tested.ok, JSON.stringify(tested.errors)).toBe(true);
    await bindDispatches(directory, tested);
    const implementer = tested.run.tickets.at(-1);
    expect(implementer).toMatchObject({ stage_id: 'build', role: 'implementer', writable: true });
    expect(manifest(implementer).allowed_evidence_commands).toEqual(expect.arrayContaining([
      TYPECHECK,
      LINT,
    ]));
    expect(manifest(implementer).command_profiles).toEqual(COMMAND_PROFILES);
    expect(evaluateLifecyclePolicy(shellEvent(directory, TYPECHECK), {
      state: tested.run,
      ticket: implementer,
    })).toMatchObject({
      decision: 'allow',
      reason: 'exact command profile project.typecheck authorizes execute execution',
    });
  }, 30_000);

  it('gives a dispatched plan judge the same planning view while keeping its execution view narrow', async () => {
    const directory = await project();
    const { planner, checker, critic } = await reachPlanReview(directory);
    const checked = await recordValidatedReceipt(directory, receipt(checker, {
      evidence: {
        verdict: 'disagree',
        missing_assurances: [{
          summary: 'Confirm the downstream typecheck and lint commands remain exact',
          evidence_anchor: 'candidate_plan.workstreams.implementation.evidence_commands',
        }],
      },
    }));
    expect(checked.ok, JSON.stringify(checked.errors)).toBe(true);
    const criticized = await recordValidatedReceipt(directory, receipt(critic));
    expect(criticized.ok, JSON.stringify(criticized.errors)).toBe(true);
    await bindDispatches(directory, criticized);
    const judge = criticized.run.tickets.at(-1);
    expect(judge).toMatchObject({ stage_id: 'plan-judge', role: 'plan_judge' });
    assertSharedPlanningView(judge, manifest(planner));
    assertPlanReviewerCannotExecuteProfiles(judge);
    expect(judge.candidate_plan.plan.workstreams[0].evidence_commands)
      .toEqual([TYPECHECK, LINT]);
    const judged = await recordValidatedReceipt(directory, receipt(judge, {
      evidence: {
        verdict: 'disagree',
        missing_assurances: [{
          summary: 'The replacement plan must preserve both downstream command requirements',
          evidence_anchor: 'candidate_plan.workstreams.implementation.evidence_commands',
        }],
      },
    }));
    expect(judged.ok, JSON.stringify(judged.errors)).toBe(true);
    await bindDispatches(directory, judged);
    const replan = judged.run.tickets.at(-1);
    expect(replan).toMatchObject({ stage_id: 'plan-replan', role: 'planner' });
    assertSharedPlanningView(replan, manifest(planner));
    expect(manifest(replan).allowed_evidence_commands).toEqual(expect.arrayContaining([
      TYPECHECK,
      LINT,
    ]));
    expect(judged.run).toMatchObject({ status: 'running', plan_replan_cycles: 1 });
  }, 30_000);
});
