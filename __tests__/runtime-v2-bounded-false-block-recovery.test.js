import { execFileSync } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { sha256 } from '../lib/runtime/canonical.js';
import { SCHEMA_VERSION } from '../lib/runtime/constants.js';
import { reduceRun } from '../lib/runtime/scheduler.js';
import { attemptSummaryList, reviewFindings } from '../lib/runtime/review-evidence.js';
import { recordReceipt, startRun, statusRun } from '../lib/runtime/service.js';
import { runtimePaths } from '../lib/runtime/paths.js';
import { finalizeTicket, validateTicket } from '../lib/runtime/schemas.js';
import { atomicWriteJson, readJson } from '../lib/runtime/storage.js';

const cleanups = [];

afterEach(async () => Promise.all(
  cleanups.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
));

function git(cwd, ...args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

async function integrationProject() {
  const dir = await mkdtemp(path.join(tmpdir(), 'ape-bounded-recovery-'));
  cleanups.push(dir);
  await mkdir(path.join(dir, 'src'));
  await mkdir(path.join(dir, 'tests'));
  await writeFile(path.join(dir, 'src', 'value.js'), 'export const value = 1;\n');
  await writeFile(path.join(dir, 'tests', 'value.test.js'), 'throw new Error("red");\n');
  await writeFile(path.join(dir, 'tests', 'other.test.js'), 'throw new Error("other");\n');
  git(dir, 'init', '-q', '-b', 'main');
  git(dir, 'config', 'user.email', 'ape@example.test');
  git(dir, 'config', 'user.name', 'APE Test');
  git(dir, 'add', '.');
  git(dir, 'commit', '-qm', 'baseline');
  await atomicWriteJson(runtimePaths(dir).config, {
    shipping: { auto_merge: false, provider: 'github', required_remote_checks: false },
    test_commands: { full: 'npm test', targeted: 'node tests/value.test.js' },
    verification: {
      profiles: [{
        id: 'unit',
        description: 'Run unit tests',
        command: 'npm test',
        root: '.',
        timeout_ms: 30_000,
      }],
    },
  });
  return dir;
}

function receipt(ticket, overrides = {}) {
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
    acceptance: ['The changed value is observable'],
    non_goals: [],
    baseline: [{
      command: 'npm test',
      observation: 'The focused assertion is red',
      output_hash: 'c'.repeat(64),
    }],
    impacted_paths: { read: [], write: ['src/value.js', 'tests/value.test.js'] },
    compatibility: 'Keep the named export stable.',
    rollback: 'Revert the value and focused assertion.',
    verification_profiles: [{ id: 'unit', disposition: 'required', reason: 'Behavior changed.' }],
    questions: [],
  };
}

function candidatePlan(preflightHash, suffix = '') {
  return {
    version: 2,
    preflight_hash: preflightHash,
    requirements: [{ id: 'R1', requirement: 'Change the value', workstreams: ['build'] }],
    workstreams: [{
      id: 'build',
      outcome: 'The value changes safely',
      paths: [{ path: 'src/value.js', action: 'modify' }],
      steps: [`Change the exported value${suffix}`],
      acceptance: ['Callers observe the new value'],
      evidence_commands: ['npm test'],
      verification_profiles: ['unit'],
    }],
    risks: [{ risk: 'Compatibility drift', mitigation: `Run the required profile${suffix}` }],
    non_goals: ['Changing unrelated exports'],
  };
}

async function diskTicket(dir, ticket) {
  return readJson(path.join(
    runtimePaths(dir).tickets,
    `${ticket.ticket_id.replaceAll(':', '_')}.json`,
  ));
}

function pureRun(overrides = {}) {
  return {
    run_id: 'run-bounded-recovery',
    mode: 'phase',
    lane: 'fast',
    status: 'running',
    stage: 'build',
    behavioral: true,
    high_risk: false,
    policy: {},
    claimed_paths: ['src/value.js'],
    test_paths: ['tests/value.test.js'],
    tickets: [],
    receipts: [],
    expired_tickets: [],
    attempts: {},
    remediation_cycles: 0,
    ...overrides,
  };
}

let pureTicketCounter = 0;

function applyPureActions(state, actions) {
  for (const entry of actions) {
    if (entry.type === 'transition') Object.assign(state, entry.patch);
    if (entry.type === 'issue_ticket') {
      const ticket = {
        ticket_id: `pure-ticket-${(pureTicketCounter += 1)}`,
        stage_id: entry.stage.id,
        role: entry.stage.role,
        model_tier: entry.stage.model_tier,
        writable: entry.stage.writable,
        parallel_group: entry.stage.parallel_group ?? null,
        required_checks: entry.stage.required_checks ?? [],
        output_schema: entry.stage.output_schema ?? {},
        attempt: state.attempts[entry.stage.id] ?? 1,
        ...(entry.retry_of ? { retry_of: entry.retry_of } : {}),
        ...(entry.review_findings ? { review_findings: entry.review_findings } : {}),
        ...(entry.review_finding_evidence
          ? { review_finding_evidence: entry.review_finding_evidence }
          : {}),
        ...(entry.test_reconciliation
          ? { test_reconciliation: entry.test_reconciliation }
          : {}),
      };
      state.tickets.push(ticket);
      state.stage = ticket.stage_id;
    }
  }
}

function recordPure(state, ticket, rawReceipt) {
  const normalized = { ticket_id: ticket.ticket_id, ...rawReceipt };
  state.receipts.push(normalized);
  const actions = reduceRun(state, {
    type: 'RECEIPT_RECORDED',
    ticket,
    receipt: normalized,
    stage: {
      id: ticket.stage_id,
      role: ticket.role,
      parallel_group: ticket.parallel_group ?? null,
    },
    next_state: state,
  });
  applyPureActions(state, actions);
  return actions;
}

describe('APE v2 bounded false-block recovery operational replay corpus', () => {
  it('plan-directed-replan admits one structured replacement plan, then terminally rejects a second disagreement', async () => {
    const dir = await integrationProject();
    const objective = 'Change the value without breaking callers';
    const started = await startRun(dir, {
      objective,
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
      plan_contract_version: 2,
    });
    expect(started.ok).toBe(true);

    const preflightTicket = started.run.tickets.at(-1);
    const artifact = preflightArtifact(objective);
    const preflight = await recordReceipt(dir, receipt(preflightTicket, {
      tests: [{
        command: 'npm test',
        passed: false,
        exit_code: 1,
        duration_ms: 10,
        output_hash: 'c'.repeat(64),
      }],
      evidence: { preflight_artifact: artifact },
    }));
    expect(preflight.ok, JSON.stringify(preflight.errors)).toBe(true);

    const planner = preflight.run.tickets.at(-1);
    const initialPlan = candidatePlan(sha256(artifact));
    const planned = await recordReceipt(dir, receipt(planner, {
      evidence: { verdict: 'pass', candidate_plan: initialPlan },
    }));
    expect(planned.ok, JSON.stringify(planned.errors)).toBe(true);
    const initialCheck = planned.run.tickets.find((ticket) => ticket.stage_id === 'plan-check');
    const initialCritic = planned.run.tickets.find((ticket) => ticket.stage_id === 'plan-critic');

    expect((await recordReceipt(dir, receipt(initialCheck, {
      evidence: { verdict: 'agree' },
    }))).ok).toBe(true);
    const criticized = await recordReceipt(dir, receipt(initialCritic, {
      evidence: {
        verdict: 'disagree',
        missing_assurances: [{
          summary: 'R1 is not tied to the observable acceptance criterion.',
          requirement_id: 'R1',
          evidence_anchor: 'candidate_plan.requirements.R1',
        }],
      },
    }));
    expect(criticized.ok, JSON.stringify(criticized.errors)).toBe(true);
    const firstJudge = criticized.run.tickets.at(-1);
    expect(firstJudge.stage_id).toBe('plan-judge');

    const judged = await recordReceipt(dir, receipt(firstJudge, {
      evidence: {
        verdict: 'disagree',
        missing_assurances: [{
          summary: 'Bind R1 to the unit profile and its expected observation.',
          requirement_id: 'R1',
          evidence_anchor: 'candidate_plan.workstreams.build.acceptance.0',
        }],
      },
    }));
    expect(judged.ok, JSON.stringify(judged.errors)).toBe(true);
    expect(judged.run.status).toBe('running');
    expect(judged.run.plan_replan_cycles).toBe(1);
    const replan = judged.run.tickets.at(-1);
    expect(replan).toMatchObject({
      stage_id: 'plan-replan',
      role: 'planner',
      plan_recovery: {
        version: 1,
        attempt: 1,
        source_ticket_id: firstJudge.ticket_id,
      },
    });
    expect(replan.plan_recovery.missing_assurances).toEqual([
      expect.objectContaining({
        summary: 'Bind R1 to the unit profile and its expected observation.',
        requirement_id: 'R1',
        evidence_anchor: 'candidate_plan.workstreams.build.acceptance.0',
      }),
    ]);
    expect(validateTicket(await diskTicket(dir, replan))).toMatchObject({ valid: true });

    // Receipt admission must accept candidate_plan on plan-replan, not only on
    // the original plan stage, and must forward that replacement to a new pair.
    const replacement = candidatePlan(sha256(artifact), ' and assert the exact observation');
    const replanned = await recordReceipt(dir, receipt(replan, {
      evidence: { verdict: 'pass', candidate_plan: replacement },
    }));
    expect(replanned.ok, JSON.stringify(replanned.errors)).toBe(true);
    const replacementHash = sha256(replacement);
    const replacementReview = replanned.run.tickets
      .filter((ticket) => ['plan-check', 'plan-critic'].includes(ticket.stage_id))
      .slice(-2);
    expect(replacementReview.map((ticket) => ticket.stage_id).sort()).toEqual(['plan-check', 'plan-critic']);
    for (const ticket of replacementReview) {
      expect(ticket.candidate_plan).toEqual({ plan_hash: replacementHash, plan: replacement });
      expect(validateTicket(await diskTicket(dir, ticket))).toMatchObject({ valid: true });
    }

    const [replacementCheck, replacementCritic] = replacementReview;
    expect((await recordReceipt(dir, receipt(replacementCheck, {
      evidence: { verdict: 'agree' },
    }))).ok).toBe(true);
    const replacementCriticResult = await recordReceipt(dir, receipt(replacementCritic, {
      evidence: { verdict: 'disagree' },
    }));
    expect(replacementCriticResult.ok).toBe(true);
    const secondJudge = replacementCriticResult.run.tickets.at(-1);
    expect(secondJudge.stage_id).toBe('plan-judge');
    const rejected = await recordReceipt(dir, receipt(secondJudge, {
      evidence: {
        verdict: 'disagree',
        missing_assurances: ['The replacement still lacks independent assurance.'],
      },
    }));
    expect(rejected.ok).toBe(true);
    expect(rejected.run).toMatchObject({
      status: 'blocked',
      stage: 'plan-judge',
      terminal_reason_code: 'planning_rejected',
      blocked_recovery: {
        reason_code: 'plan_rejected_after_directed_replan',
        directed_replan_attempts: 1,
      },
    });
    expect(rejected.run.tickets.filter((ticket) => ticket.stage_id === 'plan-replan')).toHaveLength(1);
  }, 30_000);

  it('test-contradiction-verification reconciles once, rechecks exact test scope, and resumes the original writer', () => {
    const source = {
      ticket_id: 'ticket-build-1',
      stage_id: 'build',
      role: 'implementer',
      model_tier: 'balanced',
      writable: true,
      parallel_group: null,
      required_checks: ['targeted-tests'],
      output_schema: {},
      attempt: 1,
      test_paths: ['tests/value.test.js'],
    };
    const state = pureRun({
      tickets: [source],
      attempts: { build: 1 },
    });
    const contradiction = 'The same input is required to both return zero and throw.';
    const first = recordPure(state, source, {
      status: 'failed',
      findings: [],
      evidence: {
        failure_kind: 'test-contradiction',
        summary: contradiction,
        test_contradiction: {
          summary: contradiction,
          test_paths: ['tests/value.test.js'],
        },
      },
    });
    expect(first.map((entry) => entry.type)).toEqual(['transition', 'issue_ticket', 'persist_state']);
    const reconcile = state.tickets.at(-1);
    expect(reconcile).toMatchObject({
      stage_id: 'test-reconcile',
      role: 'reviewer',
      test_reconciliation: {
        version: 1,
        attempt: 1,
        source_ticket_id: source.ticket_id,
        source_stage_id: 'build',
        report: contradiction,
        test_paths: ['tests/value.test.js'],
      },
    });

    const reconciled = recordPure(state, reconcile, {
      status: 'passed',
      findings: [{
        id: 'contradiction.expectations',
        file: 'tests/value.test.js',
        line: 9,
        title: 'Mutually exclusive expectations',
        detail: contradiction,
        blocking: true,
        remediation: { owner: 'test', test_paths: ['tests/value.test.js'] },
      }],
      evidence: { verdict: 'fail' },
    });
    expect(reconciled.map((entry) => entry.type)).toEqual(['transition', 'issue_ticket', 'persist_state']);
    const recheck = state.tickets.at(-1);
    expect(recheck).toMatchObject({
      stage_id: 'test-recheck',
      role: 'test_writer',
      required_checks: ['red-test'],
      test_reconciliation: { test_paths: ['tests/value.test.js'] },
    });
    expect(recheck.review_finding_evidence).toEqual([
      expect.objectContaining({
        id: expect.stringMatching(/^rf-[0-9a-f]{16}$/),
        evidence_anchor: 'tests/value.test.js:L9',
      }),
    ]);

    const rechecked = recordPure(state, recheck, {
      status: 'passed',
      findings: [],
      evidence: { verdict: 'pass', summary: 'The exact-scope test correction is now coherent.' },
    });
    expect(rechecked.map((entry) => entry.type)).toEqual(['transition', 'issue_ticket', 'persist_state']);
    const resumedBuild = state.tickets.at(-1);
    expect(resumedBuild).toMatchObject({
      stage_id: 'build',
      role: 'implementer',
      retry_of: source.ticket_id,
      attempt: 2,
      test_reconciliation: { test_paths: ['tests/value.test.js'] },
    });
    expect(state).toMatchObject({
      status: 'running',
      stage: 'build',
      test_contradiction_reconciliations: 1,
      test_contradiction_pending: null,
      test_contradiction_resolution: { verdict: 'test-corrected' },
    });

    const repeated = recordPure(state, resumedBuild, {
      status: 'failed',
      findings: [],
      evidence: {
        failure_kind: 'test-contradiction',
        test_contradiction: {
          summary: contradiction,
          test_paths: ['tests/value.test.js'],
        },
      },
    });
    expect(repeated.some((entry) => entry.type === 'issue_ticket')).toBe(false);
    expect(state).toMatchObject({
      status: 'blocked',
      stage: 'build',
      terminal_reason_code: 'test_contradiction',
    });
  });

  it('stable-review-finding-identity converges same-anchor findings despite new IDs and wording', () => {
    const firstFinding = {
      id: 'defect.original',
      file: 'src/value.js',
      line: 17,
      title: 'Incorrect boundary',
      detail: 'The boundary excludes the last supported value.',
      blocking: true,
      remediation: { owner: 'production' },
    };
    const secondFinding = {
      id: 'defect.reallocated',
      file: 'src/value.js',
      line: 17,
      title: 'Final value still rejected',
      detail: 'Rephrased evidence for the same anchored production defect.',
      blocking: true,
      remediation: { owner: 'production' },
    };
    const firstReceipt = {
      ticket_id: 'ticket-review-first',
      status: 'passed',
      findings: [firstFinding],
      evidence: { verdict: 'fail' },
    };
    const secondReceipt = {
      ticket_id: 'ticket-review-second',
      status: 'passed',
      findings: [secondFinding],
      evidence: { verdict: 'fail' },
    };
    const firstState = pureRun({
      stage: 'review',
      tickets: [{
        ticket_id: firstReceipt.ticket_id,
        stage_id: 'review',
        role: 'reviewer',
        parallel_group: 'code-review',
      }],
      receipts: [firstReceipt],
    });
    const secondState = pureRun({
      stage: 'remediation-review',
      tickets: [{
        ticket_id: secondReceipt.ticket_id,
        stage_id: 'remediation-review',
        role: 'reviewer',
        parallel_group: 'code-review',
      }],
      receipts: [secondReceipt],
    });

    const firstFingerprints = reviewFindings.fingerprints([firstReceipt]);
    const secondFingerprints = reviewFindings.fingerprints([secondReceipt]);
    expect(firstFingerprints).toEqual(secondFingerprints);
    const firstEvidence = reviewFindings.evidence(firstState, [firstReceipt]);
    const secondEvidence = reviewFindings.evidence(secondState, [secondReceipt]);
    expect(firstEvidence[0].id).toBe(secondEvidence[0].id);
    expect(firstEvidence[0].evidence_anchor).toBe('src/value.js:L17');

    // Producer/schema round-trip: a file+line anchored finding must yield the
    // exact strict side-channel shape accepted and covered by ticket_hash.
    const anchoredTicket = finalizeTicket({
      schema_version: SCHEMA_VERSION,
      ticket_id: 'ticket-remediation-build',
      run_id: 'run-bounded-recovery',
      stage_id: 'remediation-build',
      parallel_group: null,
      role: 'implementer',
      objective: 'Correct the anchored finding',
      claimed_paths: ['src/value.js'],
      test_paths: ['tests/value.test.js'],
      model_tier: 'balanced',
      model: { model: 'test-model' },
      deadline_at: '2026-08-26T12:30:00.000Z',
      output_schema: {},
      required_checks: ['targeted-tests'],
      parent_hash: null,
      base_tree_sha: 'a'.repeat(40),
      attempt: 1,
      writable: true,
      issued_at: '2026-08-26T12:00:00.000Z',
      review_finding_evidence: firstEvidence,
    });
    expect(validateTicket(anchoredTicket)).toMatchObject({ valid: true });
    expect(anchoredTicket.review_finding_evidence[0]).toEqual({
      id: firstEvidence[0].id,
      source_stage: 'review',
      evidence_anchor: 'src/value.js:L17',
      blocking: true,
    });

    const repeatedState = pureRun({
      stage: 'remediation-review',
      remediation_cycles: 1,
      remediation_finding_fingerprints: firstFingerprints,
      tickets: secondState.tickets,
      receipts: secondState.receipts,
    });
    const actions = reduceRun(repeatedState, {
      type: 'RECEIPT_RECORDED',
      ticket: repeatedState.tickets[0],
      receipt: secondReceipt,
      stage: {
        id: 'remediation-review',
        role: 'reviewer',
        parallel_group: 'code-review',
      },
      next_state: repeatedState,
    });
    expect(actions.some((entry) => entry.type === 'issue_ticket')).toBe(false);
    expect(actions[0]).toMatchObject({
      type: 'transition',
      patch: {
        status: 'blocked',
        stage: 'remediation',
        block_reason: 'a repeated review finding made no remediation progress',
      },
    });
  });

  it('actionable-scope-denial preserves exact additive claims and successor requirements', () => {
    const ticket = {
      ticket_id: 'ticket-capability-build',
      stage_id: 'build',
      role: 'implementer',
      parallel_group: null,
      claimed_paths: ['src/value.js'],
      test_paths: ['tests/value.test.js'],
      tool_claims: ['github:pull-request:read'],
    };
    const state = pureRun({
      run_id: 'run-capability-blocked',
      tickets: [ticket],
      attempts: { build: 1 },
    });
    const actions = reduceRun(state, {
      type: 'RECEIPT_RECORDED',
      ticket,
      receipt: {
        ticket_id: ticket.ticket_id,
        status: 'failed',
        findings: [],
        evidence: {
          failure_kind: 'capability',
          summary: 'The immutable ticket does not authorize the required additions.',
          required_claims: {
            claimed_paths: ['src/generated/value.js'],
            test_paths: ['tests/generated/value.test.js'],
            tool_claims: ['github:pull-request:write'],
            required_role: 'test_writer',
          },
        },
      },
      stage: { id: 'build', role: 'implementer', parallel_group: null },
      next_state: state,
    });
    expect(actions.map((entry) => entry.type)).toEqual([
      'transition',
      'archive_history',
      'release_lock',
      'persist_state',
    ]);
    expect(actions[0].patch).toMatchObject({
      status: 'blocked',
      stage: 'build',
      terminal_reason_code: 'capability_blocked',
      blocked_recovery: {
        reason_code: 'capability_denied',
        source_ticket_id: ticket.ticket_id,
        source_stage_id: 'build',
        additive_claims: {
          claimed_paths: ['src/generated/value.js'],
          test_paths: ['tests/generated/value.test.js'],
          tool_claims: ['github:pull-request:write'],
          required_role: 'test_writer',
        },
        claims_reported: true,
        successor_required: true,
        supersession_required: true,
        supersedes_run: 'run-capability-blocked',
      },
    });
    expect(actions.some((entry) => entry.type === 'issue_ticket')).toBe(false);

    const reviewTicket = {
      ticket_id: 'ticket-capability-review',
      stage_id: 'review',
      role: 'reviewer',
      parallel_group: 'code-review',
      claimed_paths: ['src/value.js'],
      test_paths: ['tests/value.test.js'],
    };
    const securityTicket = {
      ticket_id: 'ticket-capability-security-review',
      stage_id: 'security-review',
      role: 'security_reviewer',
      parallel_group: 'code-review',
      claimed_paths: ['src/value.js'],
      test_paths: ['tests/value.test.js'],
    };
    const capabilityReceipt = {
      ticket_id: reviewTicket.ticket_id,
      status: 'failed',
      findings: [],
      evidence: {
        failure_kind: 'capability',
        required_claims: { tool_claims: ['github:pull-request:read'] },
      },
    };
    const agreeingReceipt = {
      ticket_id: securityTicket.ticket_id,
      status: 'passed',
      findings: [],
      evidence: { verdict: 'agree' },
    };
    const grouped = pureRun({
      run_id: 'run-capability-review-group',
      stage: 'security-review',
      high_risk: true,
      tickets: [reviewTicket, securityTicket],
      receipts: [capabilityReceipt, agreeingReceipt],
    });
    const groupedActions = reduceRun(grouped, {
      type: 'RECEIPT_RECORDED',
      ticket: securityTicket,
      receipt: agreeingReceipt,
      stage: { id: 'security-review', role: 'security_reviewer', parallel_group: 'code-review' },
      next_state: grouped,
    });
    expect(groupedActions.some((entry) => entry.type === 'issue_ticket')).toBe(false);
    expect(groupedActions[0]).toMatchObject({
      type: 'transition',
      patch: {
        status: 'blocked',
        stage: 'review',
        terminal_reason_code: 'capability_blocked',
        blocked_recovery: {
          source_ticket_id: reviewTicket.ticket_id,
          additive_claims: { tool_claims: ['github:pull-request:read'] },
          successor_required: true,
          supersession_required: true,
        },
      },
    });

    for (const [stageId, role] of [
      ['test-reconcile', 'reviewer'],
      ['test-recheck', 'test_writer'],
    ]) {
      const recoveryTicket = {
        ticket_id: `ticket-capability-${stageId}`,
        stage_id: stageId,
        role,
        parallel_group: null,
        claimed_paths: ['tests/value.test.js'],
        test_paths: ['tests/value.test.js'],
        test_reconciliation: {
          version: 1,
          attempt: 1,
          source_ticket_id: 'ticket-build-source',
          source_stage_id: 'build',
          report: 'Reported contradiction',
          test_paths: ['tests/value.test.js'],
        },
      };
      const recoveryState = pureRun({
        run_id: `run-capability-${stageId}`,
        stage: stageId,
        tickets: [recoveryTicket],
      });
      const recoveryActions = reduceRun(recoveryState, {
        type: 'RECEIPT_RECORDED',
        ticket: recoveryTicket,
        receipt: {
          ticket_id: recoveryTicket.ticket_id,
          status: 'failed',
          findings: [],
          evidence: {
            failure_kind: 'capability',
            required_claims: { tool_claims: ['github:pull-request:read'] },
          },
        },
        stage: { id: stageId, role, parallel_group: null },
        next_state: recoveryState,
      });
      expect(recoveryActions[0]).toMatchObject({
        type: 'transition',
        patch: {
          status: 'blocked',
          stage: stageId,
          terminal_reason_code: 'capability_blocked',
          blocked_recovery: {
            additive_claims: { tool_claims: ['github:pull-request:read'] },
            successor_required: true,
          },
        },
      });
    }
  });
});

describe('APE v2 bounded recovery receipt admission', () => {
  it('compacts the first hook command marker without losing nested text or inventing an empty command', () => {
    const state = {
      tickets: [
        { ticket_id: 'nested', stage_id: 'plan', attempt: 1 },
        { ticket_id: 'empty', stage_id: 'build', attempt: 1 },
      ],
      receipts: [
        {
          ticket_id: 'nested',
          evidence: {
            failure_kind: 'command-shape',
            summary: 'Command blocked by PreToolUse hook: denied. Command: cat Command: fake',
          },
        },
        {
          ticket_id: 'empty',
          evidence: {
            failure_kind: 'command-shape',
            summary: 'Command blocked by PreToolUse hook: denied. Command:',
          },
        },
      ],
    };
    expect(attemptSummaryList(state, 'plan').entries).toEqual([
      'attempt 1: command-shape denied: cat Command: fake',
    ]);
    expect(attemptSummaryList(state, 'build').entries).toEqual([
      'attempt 1: Command blocked by PreToolUse hook: denied. Command:',
    ]);
  });

  it('accepts a correctable command-shape denial without invented authority and schedules one retry', async () => {
    const dir = await integrationProject();
    const started = await startRun(dir, {
      objective: 'Retry one correctable policy command shape',
      mode: 'phase',
      lane: 'full',
      host: 'codex',
      claimed_paths: ['src'],
      test_paths: ['tests/value.test.js'],
      requirements: [],
      risk_triggers: [],
      behavioral: true,
      hooks_trusted: true,
      subagents_available: true,
      explicit_invocation: true,
    });
    const planner = started.run.tickets.at(-1);
    const recorded = await recordReceipt(dir, receipt(planner, {
      status: 'failed',
      evidence: {
        failure_kind: 'command-shape',
        summary: 'Command blocked by PreToolUse hook: APE command-shape denied: a bound subagent may run only recognized non-mutating evidence commands. Command: cat app/dashboard/[traceId]/timeline/page.tsx',
      },
    }));
    expect(recorded.ok, JSON.stringify(recorded.errors)).toBe(true);
    expect(recorded.run.status).toBe('running');
    expect(recorded.run.attempts.plan).toBe(2);
    expect(recorded.run.tickets.at(-1)).toMatchObject({
      stage_id: 'plan',
      attempt: 2,
      prior_attempts: [
        'attempt 1: command-shape denied: cat app/dashboard/[traceId]/timeline/page.tsx',
      ],
    });
  }, 30_000);

  it('rejects empty, malformed, noncanonical, and non-additive capability declarations before persistence', async () => {
    const dir = await integrationProject();
    const started = await startRun(dir, {
      objective: 'Exercise capability recovery admission',
      mode: 'phase',
      lane: 'full',
      host: 'codex',
      claimed_paths: ['src'],
      tool_claims: ['github:*:read'],
      test_paths: ['tests/value.test.js'],
      requirements: [],
      risk_triggers: [],
      behavioral: true,
      hooks_trusted: true,
      subagents_available: true,
      explicit_invocation: true,
    });
    expect(started.ok).toBe(true);
    const planner = started.run.tickets.at(-1);
    expect(planner.stage_id).toBe('plan');
    const before = await readJson(runtimePaths(dir).active);
    const invalid = [
      ['missing claims', undefined, /requires evidence\.required_claims/i],
      ['empty claims', {}, /at least one genuinely additive/i],
      ['invalid tool claim', { tool_claims: ['github:pull-request:admin'] }, /canonical provider:resource/i],
      ['noncanonical path', { claimed_paths: ['src/../escape.js'] }, /canonical contained project-relative/i],
      ['path already covered by a directory claim', { claimed_paths: ['src/value.js'] }, /already on the immutable ticket/i],
      ['tool already covered by a wildcard claim', { tool_claims: ['github:pull-request:read'] }, /already on the immutable ticket/i],
      ['undispatchable role', { required_role: 'root' }, /dispatchable APE role/i],
      ['prototype role', { required_role: 'toString' }, /dispatchable APE role/i],
      ['existing role', { required_role: 'planner' }, /already the immutable ticket role/i],
    ];
    for (const [label, requiredClaims, expected] of invalid) {
      const attempted = await recordReceipt(dir, receipt(planner, {
        status: 'failed',
        evidence: {
          failure_kind: 'capability',
          summary: 'APE denied a required operation.',
          ...(requiredClaims === undefined ? {} : { required_claims: requiredClaims }),
        },
      }));
      expect(attempted.ok, label).toBe(false);
      expect(attempted.rejected, label).toBe(true);
      expect(attempted.errors.join(' '), label).toMatch(expected);
      expect(await readJson(runtimePaths(dir).active), label).toEqual(before);
    }

    const admitted = await recordReceipt(dir, receipt(planner, {
      status: 'failed',
      evidence: {
        failure_kind: 'capability',
        summary: 'The planner needs a reviewed external read.',
        required_claims: {
          tool_claims: ['github:pull-request:write'],
          required_role: 'plan_checker',
        },
      },
    }));
    expect(admitted.ok, JSON.stringify(admitted.errors)).toBe(true);
    expect(admitted.run).toMatchObject({
      status: 'blocked',
      terminal_reason_code: 'capability_blocked',
      blocked_recovery: {
        additive_claims: {
          tool_claims: ['github:pull-request:write'],
          required_role: 'plan_checker',
        },
        successor_required: true,
        supersession_required: true,
      },
    });
  }, 30_000);

  it('rejects ungrounded reconciliation and narrows recheck authority to independently confirmed paths', async () => {
    const dir = await integrationProject();
    const started = await startRun(dir, {
      objective: 'Reconcile one reported contradiction without widening test scope',
      mode: 'phase',
      lane: 'fast',
      host: 'codex',
      claimed_paths: ['src/value.js'],
      test_paths: ['tests/value.test.js', 'tests/other.test.js'],
      requirements: [],
      risk_triggers: [],
      behavioral: true,
      hooks_trusted: true,
      subagents_available: true,
      explicit_invocation: true,
    });
    expect(started.ok).toBe(true);
    const testWriter = started.run.tickets.at(-1);
    expect(testWriter.stage_id).toBe('test');
    await writeFile(
      path.join(dir, 'tests', 'value.test.js'),
      'throw new Error("focused contradiction red");\n',
    );
    const tested = await recordReceipt(dir, receipt(testWriter, {
      tests: [{
        command: 'node tests/value.test.js',
        passed: false,
        exit_code: 1,
        duration_ms: 10,
      }],
      evidence: { verdict: 'pass' },
    }));
    expect(tested.ok, JSON.stringify(tested.errors)).toBe(true);
    const build = tested.run.tickets.at(-1);
    expect(build.stage_id).toBe('build');
    const contradicted = await recordReceipt(dir, receipt(build, {
      status: 'failed',
      evidence: {
        failure_kind: 'test-contradiction',
        summary: 'One focused test contains incompatible expectations.',
        test_contradiction: {
          summary: 'One focused test contains incompatible expectations.',
          incompatible_expectations: 'The same call must return and throw.',
          test_paths: ['tests/value.test.js'],
        },
      },
    }));
    expect(contradicted.ok, JSON.stringify(contradicted.errors)).toBe(true);
    const reconcile = contradicted.run.tickets.at(-1);
    expect(reconcile).toMatchObject({
      stage_id: 'test-reconcile',
      test_paths: ['tests/value.test.js', 'tests/other.test.js'],
      test_reconciliation: { test_paths: ['tests/value.test.js'] },
    });
    const before = await readJson(runtimePaths(dir).active);
    const productionOwned = {
      id: 'contradiction.production',
      file: 'tests/value.test.js',
      line: 1,
      title: 'Production change requested',
      detail: 'This does not independently confirm a test-owned contradiction.',
      blocking: true,
      remediation: { owner: 'production' },
    };
    const outsideReportedScope = {
      id: 'contradiction.other-test',
      file: 'tests/other.test.js',
      line: 1,
      title: 'Unreported second test',
      detail: 'This path was never part of the implementer contradiction report.',
      blocking: true,
      remediation: { owner: 'test', test_paths: ['tests/other.test.js'] },
    };
    for (const [label, finding, expected] of [
      ['production-owned', productionOwned, /test- or both-owned/i],
      ['outside reported scope', outsideReportedScope, /outside ticket\.test_reconciliation\.test_paths/i],
    ]) {
      const attempted = await recordReceipt(dir, receipt(reconcile, {
        findings: [finding],
        evidence: { verdict: 'fail' },
      }));
      expect(attempted.ok, label).toBe(false);
      expect(attempted.rejected, label).toBe(true);
      expect(attempted.errors.join(' '), label).toMatch(expected);
      expect(await readJson(runtimePaths(dir).active), label).toEqual(before);
    }

    const confirmedFinding = {
      id: 'contradiction.focused-test',
      file: 'tests/value.test.js',
      line: 1,
      title: 'Focused expectations conflict',
      detail: 'The named test independently requires mutually exclusive outcomes.',
      blocking: true,
      remediation: { owner: 'test', test_paths: ['tests/value.test.js'] },
    };
    const confirmed = await recordReceipt(dir, receipt(reconcile, {
      findings: [confirmedFinding],
      evidence: { verdict: 'fail' },
    }));
    expect(confirmed.ok, JSON.stringify(confirmed.errors)).toBe(true);
    const recheck = confirmed.run.tickets.at(-1);
    expect(recheck).toMatchObject({
      stage_id: 'test-recheck',
      role: 'test_writer',
      test_scope: 'exact',
      claimed_paths: ['tests/value.test.js'],
      test_paths: ['tests/value.test.js'],
      test_reconciliation: { test_paths: ['tests/value.test.js'] },
    });
    expect(validateTicket(await diskTicket(dir, recheck))).toMatchObject({ valid: true });
  }, 30_000);
});

describe('APE v2 recovery-stage active-state compatibility', () => {
  it.each([
    ['plan-replan', 'planner'],
    ['test-reconcile', 'reviewer'],
    ['test-recheck', 'test_writer'],
  ])('persists and reloads an active %s ticket without a corrupt-state diagnosis', async (stage, role) => {
    const dir = await mkdtemp(path.join(tmpdir(), 'ape-recovery-reload-'));
    cleanups.push(dir);
    const state = {
      schema_version: SCHEMA_VERSION,
      run_id: `run-reload-${stage.replaceAll('-', '_')}`,
      objective: 'Reload a bounded recovery stage',
      mode: 'phase',
      lane: 'full',
      host: 'codex',
      status: 'running',
      stage,
      dispatch_state: 'none',
      tickets: [{ ticket_id: `ticket-${stage}`, stage_id: stage, role }],
      receipts: [],
      expired_tickets: [],
    };
    await atomicWriteJson(runtimePaths(dir).active, state);
    const status = await statusRun(dir);
    expect(status).toMatchObject({
      ok: true,
      active: true,
      run: { stage, tickets: [{ stage_id: stage, role }] },
    });
    expect(status.diagnostic?.reason_code).not.toBe('corrupt_state');
  });
});
