import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../lib/runtime/gates.js', async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, autoMergeGithub: vi.fn(), pollRemoteChecksAndMerge: vi.fn() };
});

import { abortRun, historyAction, recordReceipt, startRun } from '../lib/runtime/service.js';
import { runtimePaths } from '../lib/runtime/paths.js';
import { atomicWriteJson, readJson } from '../lib/runtime/storage.js';
import {
  candidatePlanForScope,
  PLAN_CONTRACT_MAX_BYTES,
  validatePlanDeviation,
} from '../lib/runtime/plan-contract.js';
import { sha256 } from '../lib/runtime/canonical.js';
import { projectRunResponse } from '../lib/runtime/projection.js';

const cleanups = [];
afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

function git(cwd, ...args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

async function project() {
  const dir = await mkdtemp(path.join(tmpdir(), 'ape-plan-contract-'));
  cleanups.push(dir);
  await mkdir(path.join(dir, 'src'));
  await mkdir(path.join(dir, 'tests'));
  await writeFile(path.join(dir, 'src', 'value.js'), 'export const value = 1;\n');
  await writeFile(path.join(dir, 'tests', 'value.test.js'), 'throw new Error("red");\n');
  git(dir, 'init', '-q');
  git(dir, 'config', 'user.email', 'ape@example.test');
  git(dir, 'config', 'user.name', 'APE Test');
  git(dir, 'add', '.');
  git(dir, 'commit', '-qm', 'test: baseline');
  await atomicWriteJson(runtimePaths(dir).config, {
    shipping: { auto_merge: false, provider: 'github', required_remote_checks: false },
    test_commands: { full: 'node --test' },
    policy: { evidence_scripts: ['verify'] },
  });
  return dir;
}

function startInput(overrides = {}) {
  return {
    objective: 'Implement the approved structured plan',
    mode: 'phase',
    lane: 'full',
    host: 'codex',
    claimed_paths: ['src/value.js'],
    test_paths: ['tests/value.test.js'],
    requirements: ['R1'],
    risk_triggers: [],
    behavioral: true,
    hooks_trusted: true,
    subagents_available: true,
    explicit_invocation: true,
    plan_contract_version: 1,
    ...overrides,
  };
}

const PLAN = Object.freeze({
  version: 1,
  requirements: [{ id: 'R1', requirement: 'Update the value safely', workstreams: ['implementation', 'tests'] }],
  workstreams: [
    {
      id: 'implementation',
      outcome: 'The implementation returns the new value',
      paths: [{ path: 'src/value.js', action: 'modify' }],
      steps: ['Change the exported value'],
      acceptance: ['The value is observable by callers'],
      evidence_commands: ['node --test tests/value.test.js'],
    },
    {
      id: 'tests',
      outcome: 'Behavior is covered independently',
      paths: [{ path: 'tests/value.test.js', action: 'modify' }],
      steps: ['Add the failing assertion'],
      acceptance: ['The assertion fails before implementation and passes after'],
      evidence_commands: ['node --test tests/value.test.js'],
    },
  ],
  risks: [{ risk: 'A stale test can pass vacuously', mitigation: 'Run the exact test path' }],
  non_goals: ['Changing unrelated exports'],
});

function receipt(ticket, evidence = { verdict: 'agree' }, status = 'passed') {
  return {
    ticket_id: ticket.ticket_id,
    status,
    agent_identity: `agent-${ticket.role}`,
    tests: [],
    findings: [],
    evidence,
    timing: { started_at: ticket.issued_at, duration_ms: 1 },
  };
}

function fullPlanCount(value, planHash) {
  let count = 0;
  const visit = (current) => {
    if (current === null || typeof current !== 'object') return;
    if (current.plan_hash === planHash && current.plan && typeof current.plan === 'object') count += 1;
    for (const child of Object.values(current)) visit(child);
  };
  visit(value);
  return count;
}

async function reachReview(dir) {
  const started = await startRun(dir, startInput());
  const planner = started.run.tickets[0];
  const recorded = await recordReceipt(dir, receipt(planner, {
    verdict: 'pass',
    candidate_plan: PLAN,
  }));
  expect(recorded.ok, JSON.stringify(recorded.errors)).toBe(true);
  const checker = recorded.run.tickets.find((ticket) => ticket.stage_id === 'plan-check');
  const critic = recorded.run.tickets.find((ticket) => ticket.stage_id === 'plan-critic');
  return { started, checker, critic };
}

describe('versioned structured plan contract', () => {
  it('accepts omitted deviation evidence with or without a plan and rejects array placeholders', () => {
    expect(validatePlanDeviation(undefined, undefined, []).valid).toBe(true);
    expect(validatePlanDeviation(undefined, {}, []).valid).toBe(true);
    expect(validatePlanDeviation([], undefined, []).errors).toContain(
      'evidence.plan_deviation is not allowed without a valid approved_plan on the ticket',
    );
  });

  it('bounds and validates canonical candidate plans before hashing', () => {
    const accepted = candidatePlanForScope(PLAN, ['src/value.js', 'tests/value.test.js']);
    expect(accepted.valid).toBe(true);
    expect(accepted.value.plan_hash).toBe(sha256(PLAN));

    const outside = structuredClone(PLAN);
    outside.workstreams[0].paths[0].path = 'outside/value.js';
    expect(candidatePlanForScope(outside, ['src/value.js', 'tests/value.test.js'])).toMatchObject({
      valid: false,
      errors: [expect.stringMatching(/outside the run/)],
    });

    const duplicate = structuredClone(PLAN);
    duplicate.workstreams[1].id = duplicate.workstreams[0].id;
    expect(candidatePlanForScope(duplicate, ['src/value.js', 'tests/value.test.js']).errors.join(' '))
      .toMatch(/duplicate workstreams id/);

    for (const noncanonical of ['src\\value.js', './src/value.js', 'src/./value.js', 'src/a/../value.js', 'src//value.js', 'src/value.js/', '.']) {
      const plan = structuredClone(PLAN);
      plan.workstreams[0].paths[0].path = noncanonical;
      expect(candidatePlanForScope(plan, ['src/value.js', 'tests/value.test.js']).valid, noncanonical)
        .toBe(false);
    }

    const unlinked = structuredClone(PLAN);
    unlinked.requirements[0].workstreams = [];
    expect(candidatePlanForScope(unlinked, ['src/value.js', 'tests/value.test.js']).errors.join(' '))
      .toMatch(/>=1 items/);

    const vacuous = { version: 1, requirements: [], workstreams: [], risks: [], non_goals: [] };
    expect(candidatePlanForScope(vacuous, []).errors.join(' ')).toMatch(/>=1 items/);

    for (const field of ['paths', 'steps', 'acceptance', 'evidence_commands']) {
      const emptyWork = structuredClone(PLAN);
      emptyWork.workstreams[0][field] = [];
      expect(candidatePlanForScope(emptyWork, ['src/value.js', 'tests/value.test.js']).valid, field)
        .toBe(false);
    }

    const unsafeCommand = structuredClone(PLAN);
    unsafeCommand.workstreams[0].evidence_commands = ['node -e process.exit(0)'];
    expect(candidatePlanForScope(unsafeCommand, ['src/value.js', 'tests/value.test.js']).errors.join(' '))
      .toMatch(/not a recognized non-mutating evidence command/);

    const oversized = structuredClone(PLAN);
    const long = 'x'.repeat(500);
    oversized.workstreams[0].steps = Array(16).fill(long);
    oversized.workstreams[0].acceptance = Array(16).fill(long);
    oversized.workstreams[0].evidence_commands = Array(16).fill(long);
    const rejected = candidatePlanForScope(oversized, ['src/value.js', 'tests/value.test.js']);
    expect(rejected.valid).toBe(false);
    expect(rejected.errors.join(' ')).toContain(`${PLAN_CONTRACT_MAX_BYTES}`);
  });

  it('recognizes a project-declared read-only evidence script at admission', async () => {
    const dir = await project();
    const configured = structuredClone(PLAN);
    configured.workstreams[0].evidence_commands = ['npm run verify'];
    expect(candidatePlanForScope(
      configured,
      ['src/value.js', 'tests/value.test.js'],
      dir,
    ).valid).toBe(true);
  });

  it('sends byte-identical candidates to both reviewers, seals unanimous approval, and forwards it to retries/history', async () => {
    const dir = await project();
    const { checker, critic } = await reachReview(dir);
    expect(checker.candidate_plan).toEqual(critic.candidate_plan);
    expect(checker.candidate_plan).toEqual({ plan_hash: sha256(PLAN), plan: PLAN });
    expect(checker).not.toHaveProperty('plan_artifact');

    const checked = await recordReceipt(dir, receipt(checker));
    expect(checked.ok).toBe(true);
    const critiqued = await recordReceipt(dir, receipt(critic));
    expect(critiqued.ok, JSON.stringify(critiqued.errors)).toBe(true);
    expect(critiqued.run.approved_plan).toMatchObject({
      version: 1,
      plan_hash: sha256(PLAN),
      approval_route: 'unanimous',
      reviewer_receipt_hashes: [checked.receipt.receipt_hash, critiqued.receipt.receipt_hash],
      plan: PLAN,
    });
    const testTicket = critiqued.run.tickets.find((ticket) => ticket.stage_id === 'test');
    expect(testTicket.approved_plan).toEqual(critiqued.run.approved_plan);
    expect(fullPlanCount(projectRunResponse(critiqued), sha256(PLAN))).toBe(1);

    const badDeviation = await recordReceipt(dir, receipt(testTicket, {
      summary: 'cannot proceed',
      plan_deviation: {
        workstream_id: 'implementation',
        reason: 'A different file appears necessary',
        replacement: 'Change that file instead',
        affected_paths: ['outside/value.js'],
        acceptance_impact: 'The same acceptance should hold',
      },
    }, 'failed'));
    expect(badDeviation).toMatchObject({ ok: false, rejected: true });
    expect(badDeviation.errors.join(' ')).toMatch(/outside this ticket/);

    const failed = await recordReceipt(dir, receipt(testTicket, {
      summary: 'test authoring could not complete',
      plan_deviation: {
        workstream_id: 'tests',
        reason: 'The test needs a revised assertion',
        replacement: 'Revise the assertion while preserving intent',
        affected_paths: ['tests/value.test.js'],
        acceptance_impact: 'No acceptance criterion is removed',
      },
    }, 'failed'));
    expect(failed.ok, JSON.stringify(failed.errors)).toBe(true);
    const retry = failed.run.tickets.filter((ticket) => ticket.stage_id === 'test').at(-1);
    expect(retry.approved_plan).toEqual(critiqued.run.approved_plan);

    await abortRun(dir, 'archive the plan contract fixture');
    const archived = await readJson(path.join(runtimePaths(dir).history, `${failed.run.run_id}.json`));
    expect(archived.plan_contract_version).toBe(1);
    expect(archived.approved_plan).toEqual(critiqued.run.approved_plan);
    const explained = await historyAction(dir, 'explain', {
      run_id: failed.run.run_id,
    });
    expect(explained).not.toHaveProperty('record');
    expect(explained.run).toMatchObject({ run_id: failed.run.run_id, status: 'aborted' });
    expect(explained.diagnostic.reason_code).toBe('aborted');
    expect(fullPlanCount(explained, sha256(PLAN))).toBe(0);
    expect(JSON.stringify(explained)).not.toContain('Update the value safely');
    // The immutable archive remains the plan-record channel.
    expect(archived.approved_plan).toEqual(critiqued.run.approved_plan);
  }, 30_000);

  it('seals checker, critic, and judge hashes on the judge approval route', async () => {
    const dir = await project();
    const { checker, critic } = await reachReview(dir);
    const checked = await recordReceipt(dir, receipt(checker, { verdict: 'disagree' }, 'failed'));
    const critiqued = await recordReceipt(dir, receipt(critic, { verdict: 'agree' }));
    const judge = critiqued.run.tickets.find((ticket) => ticket.stage_id === 'plan-judge');
    expect(judge.candidate_plan).toEqual(checker.candidate_plan);
    const judged = await recordReceipt(dir, receipt(judge, { verdict: 'agree' }));
    expect(judged.ok, JSON.stringify(judged.errors)).toBe(true);
    expect(judged.run.approved_plan.approval_route).toBe('judge');
    expect(judged.run.approved_plan.reviewer_receipt_hashes).toEqual([
      checked.receipt.receipt_hash,
      critiqued.receipt.receipt_hash,
      judged.receipt.receipt_hash,
    ]);
    expect(judged.run.tickets.find((ticket) => ticket.stage_id === 'test').approved_plan)
      .toEqual(judged.run.approved_plan);
  }, 30_000);

  it('refuses to seal alternate or missing agreement words', async () => {
    const dir = await project();
    const { checker, critic } = await reachReview(dir);
    await recordReceipt(dir, receipt(checker, { verdict: 'pass' }));
    const result = await recordReceipt(dir, receipt(critic, { verdict: 'passed' }));
    expect(result.ok).toBe(true);
    expect(result.run).not.toHaveProperty('approved_plan');
    expect(result.run).toMatchObject({ status: 'blocked', stage: 'plan-approval' });

    const judgeDir = await project();
    const { checker: judgeChecker, critic: judgeCritic } = await reachReview(judgeDir);
    await recordReceipt(judgeDir, receipt(judgeChecker, { verdict: 'disagree' }));
    const disagreed = await recordReceipt(judgeDir, receipt(judgeCritic, { verdict: 'agree' }));
    const judge = disagreed.run.tickets.find((ticket) => ticket.stage_id === 'plan-judge');
    const judged = await recordReceipt(judgeDir, receipt(judge, { verdict: 'pass' }));
    expect(judged.run).not.toHaveProperty('approved_plan');
    expect(judged.run).toMatchObject({ status: 'blocked', stage: 'plan-approval' });
  }, 30_000);

  it('keeps omission on the legacy path and therefore emits no structured fields', async () => {
    const dir = await project();
    const input = startInput();
    delete input.plan_contract_version;
    const started = await startRun(dir, input);
    expect(started.run).not.toHaveProperty('plan_contract_version');
    const planner = started.run.tickets[0];
    const recorded = await recordReceipt(dir, receipt(planner, { verdict: 'pass', summary: 'legacy plan' }));
    expect(recorded.ok).toBe(true);
    const checker = recorded.run.tickets.find((ticket) => ticket.stage_id === 'plan-check');
    expect(checker).toHaveProperty('plan_artifact');
    expect(checker).not.toHaveProperty('candidate_plan');
    expect(checker).not.toHaveProperty('approved_plan');
    await abortRun(dir, 'archive legacy compatibility fixture');
    const archived = await readJson(path.join(runtimePaths(dir).history, `${recorded.run.run_id}.json`));
    expect(archived).not.toHaveProperty('plan_contract_version');
    expect(archived).not.toHaveProperty('approved_plan');
  }, 30_000);
});
