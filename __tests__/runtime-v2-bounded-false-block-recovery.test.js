import { execFileSync } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { sha256 } from '../lib/runtime/canonical.js';
import { SCHEMA_VERSION } from '../lib/runtime/constants.js';
import { handle as handleMcp } from '../bin/ape-mcp.mjs';
import { reduceRun } from '../lib/runtime/scheduler.js';
import { attemptSummaryList, reviewFindings } from '../lib/runtime/review-evidence.js';
import { compactStatus, previewRun, recordReceipt, startRun, statusRun } from '../lib/runtime/service.js';
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

function structuredBlocker(id, file, line, title, detail = `${title} must be corrected`) {
  return {
    id,
    file,
    line,
    title,
    detail,
    blocking: true,
    remediation: { owner: 'production' },
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

async function walkIntegrationToReview(dir) {
  const started = await startRun(dir, {
    objective: 'Exercise durable remediation convergence recovery',
    mode: 'phase',
    lane: 'fast',
    host: 'codex',
    claimed_paths: ['src/value.js'],
    test_paths: ['tests/value.test.js'],
    requirements: [],
    risk_triggers: [],
    behavioral: true,
    hooks_trusted: true,
    subagents_available: true,
    explicit_invocation: true,
  });
  expect(started.ok).toBe(true);
  const testTicket = started.run.tickets.at(-1);
  expect(testTicket.stage_id).toBe('test');
  await writeFile(
    path.join(dir, 'tests', 'value.test.js'),
    "const { value } = require('../src/value.js');\nif (value !== 2) throw new Error('red');\n",
  );
  const tested = await recordReceipt(dir, receipt(testTicket, {
    tests: [{
      command: 'node tests/value.test.js',
      passed: false,
      exit_code: 1,
      duration_ms: 1,
    }],
  }));
  expect(tested.ok, JSON.stringify(tested.errors ?? [])).toBe(true);
  const buildTicket = tested.run.tickets.at(-1);
  expect(buildTicket.stage_id).toBe('build');
  await writeFile(path.join(dir, 'src', 'value.js'), 'module.exports = { value: 2 };\n');
  const built = await recordReceipt(dir, receipt(buildTicket, {
    tests: [{
      command: 'node tests/value.test.js',
      passed: true,
      exit_code: 0,
      duration_ms: 1,
    }],
  }));
  expect(built.ok, JSON.stringify(built.errors ?? [])).toBe(true);
  const reviewTicket = built.run.tickets.at(-1);
  expect(reviewTicket.stage_id).toBe('review');
  return reviewTicket;
}

describe('APE v2 bounded false-block recovery operational replay corpus', () => {
  it('plan-directed-replan issues a schema-valid second ticket only for strict-subset progress', async () => {
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
        missing_assurances: [
          {
            summary: 'Bind R1 to the unit profile and its expected observation.',
            requirement_id: 'R1',
            evidence_anchor: 'candidate_plan.workstreams.build.acceptance.0',
          },
          {
            summary: 'Add an independent rollback assurance.',
            requirement_id: 'R1',
            evidence_anchor: 'candidate_plan.risks.0.mitigation',
          },
        ],
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
    expect(replan.plan_recovery.missing_assurances).toEqual(expect.arrayContaining([
      expect.objectContaining({
        summary: 'Bind R1 to the unit profile and its expected observation.',
        requirement_id: 'R1',
        evidence_anchor: 'candidate_plan.workstreams.build.acceptance.0',
      }),
      expect.objectContaining({
        summary: 'Add an independent rollback assurance.',
        requirement_id: 'R1',
        evidence_anchor: 'candidate_plan.risks.0.mitigation',
      }),
    ]));
    expect(replan.plan_recovery.missing_assurances).toHaveLength(2);
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
    const secondJudged = await recordReceipt(dir, receipt(secondJudge, {
      evidence: {
        verdict: 'disagree',
        missing_assurances: [{
          summary: 'Add an independent rollback assurance.',
          requirement_id: 'R1',
          evidence_anchor: 'candidate_plan.risks.0.mitigation',
        }],
      },
    }));
    expect(secondJudged.ok, JSON.stringify(secondJudged.errors)).toBe(true);
    expect(secondJudged.run).toMatchObject({
      status: 'running',
      plan_replan_cycles: 2,
    });
    const secondReplan = secondJudged.run.tickets.at(-1);
    expect(secondReplan).toMatchObject({
      stage_id: 'plan-replan',
      role: 'planner',
      plan_recovery: {
        version: 1,
        attempt: 2,
        source_ticket_id: secondJudge.ticket_id,
      },
    });
    expect(secondReplan.plan_recovery.missing_assurances).toHaveLength(1);
    expect(validateTicket(await diskTicket(dir, secondReplan))).toMatchObject({ valid: true });
    expect(secondJudged.run.tickets.filter((ticket) => ticket.stage_id === 'plan-replan'))
      .toHaveLength(2);
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

  it('stable-review-finding-identity ignores local IDs and line drift while preserving raw anchors', () => {
    const firstFinding = {
      id: 'defect.original',
      file: 'src/value.js',
      line: 17,
      title: 'Unchecked redirect accepts external target',
      detail: 'The redirect accepts an external URL without allow-list validation.',
      blocking: true,
      remediation: { owner: 'production' },
    };
    const secondFinding = {
      id: 'defect.reallocated',
      file: 'src/value.js',
      line: 29,
      title: 'UNCHECKED REDIRECT accepts an external target.',
      detail: 'The redirect accepts external URL without allowlist validation!',
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
    expect(secondEvidence[0].evidence_anchor).toBe('src/value.js:L29');

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
      remediation_finding_count: firstFingerprints.length,
      remediation_finding_history: { version: 1, cycles: [firstFingerprints] },
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
        block_reason: expect.stringMatching(/repeat|unchanged|progress/i),
      },
    });
  });

  it('keeps distinct defects in the same file and at the same line as distinct identities', () => {
    const receiptWithDistinctDefects = {
      ticket_id: 'ticket-review-distinct',
      status: 'passed',
      findings: [
        structuredBlocker(
          'cache.stale-read',
          'src/cache.js',
          44,
          'Stale cache read crosses tenant boundary',
          'A tenant can observe a cached record belonging to another tenant.',
        ),
        structuredBlocker(
          'cache.lost-write',
          'src/cache.js',
          44,
          'Concurrent cache write is lost',
          'Two writers can overwrite each other because the update is not atomic.',
        ),
      ],
      evidence: { verdict: 'fail' },
    };

    const identities = reviewFindings.fingerprints([receiptWithDistinctDefects]);
    expect(identities).toHaveLength(2);
    expect(new Set(identities).size).toBe(2);
  });

  it('does not coalesce one distinct newly discovered defect with a similar prior defect', () => {
    const priorReceipt = {
      ticket_id: 'ticket-review-prior-lost-data',
      status: 'passed',
      findings: [structuredBlocker(
        'cache.lost-data',
        'src/cache.js',
        18,
        'Concurrent cache update loses stored data',
        'A cache write can overwrite stored data before the atomic update completes.',
      )],
      evidence: { verdict: 'fail' },
    };
    const currentReceipt = {
      ticket_id: 'ticket-review-current-dirty-read',
      status: 'passed',
      findings: [structuredBlocker(
        'cache.dirty-read',
        'src/cache.js',
        47,
        'Concurrent cache update exposes uncommitted data',
        'A cache read can expose uncommitted data before the atomic update completes.',
      )],
      evidence: { verdict: 'fail' },
    };
    const known = reviewFindings.fingerprints([priorReceipt]);

    const analyzed = reviewFindings.analyzeIdentities(
      [currentReceipt],
      [priorReceipt],
      known,
    );
    expect(analyzed).toMatchObject({ valid: true, fingerprints: [expect.any(String)] });
    expect(analyzed.fingerprints[0]).not.toBe(known[0]);
  });

  it.each([
    ['title', structuredBlocker(
      'compatibility-expansion.title',
      'src/value.js',
      8,
      '\ufdfa'.repeat(200),
      'The redirect target is not validated.',
    )],
    ['detail', structuredBlocker(
      'compatibility-expansion.detail',
      'src/value.js',
      8,
      'Unchecked redirect target',
      '\ufdfa'.repeat(4_000),
    )],
    ['file', structuredBlocker(
      'compatibility-expansion.file',
      '\ufdfa'.repeat(512),
      8,
      'Unchecked redirect target',
      'The redirect target is not validated.',
    )],
  ])('rejects %s identity material whose NFKC form exceeds its bound', (_field, finding) => {
    const analyzed = reviewFindings.analyzeIdentities([{
      ticket_id: `ticket-review-expanded-${_field}`,
      status: 'passed',
      findings: [finding],
      evidence: { verdict: 'fail' },
    }]);

    expect(analyzed).toMatchObject({ valid: false, reason: 'malformed', fingerprints: [] });
  });

  it('rejects an ambiguous many-to-one match instead of collapsing distinct current defects', () => {
    const priorReceipt = {
      ticket_id: 'ticket-review-prior-cache-write',
      status: 'passed',
      findings: [structuredBlocker(
        'cache.prior-lost-write',
        'src/cache.js',
        18,
        'Concurrent cache update loses stored data',
        'A cache write can overwrite stored data before the atomic update completes.',
      )],
      evidence: { verdict: 'fail' },
    };
    const currentReceipt = {
      ticket_id: 'ticket-review-current-cache-defects',
      status: 'passed',
      findings: [
        structuredBlocker(
          'cache.renamed-lost-write',
          'src/cache.js',
          31,
          'Stored data is lost during a concurrent cache update',
          'The atomic update completes after another cache write overwrites stored data.',
        ),
        structuredBlocker(
          'cache.dirty-read',
          'src/cache.js',
          47,
          'Concurrent cache update exposes uncommitted data',
          'A cache read can expose uncommitted data before the atomic update completes.',
        ),
      ],
      evidence: { verdict: 'fail' },
    };
    const known = reviewFindings.fingerprints([priorReceipt]);

    expect(reviewFindings.analyzeIdentities(
      [currentReceipt],
      [priorReceipt],
      known,
    )).toMatchObject({ valid: false, reason: 'ambiguous', fingerprints: [] });
  });

  it.each([
    ['empty finding evidence', []],
    ['malformed finding evidence', [{ blocking: true }]],
    ['control-bearing material', [structuredBlocker(
      'crafted.control',
      'src/value.js',
      8,
      `Unchecked redirect${String.fromCharCode(0x202e)}hidden`,
      'The redirect target is not validated.',
    )]],
    ['oversized collision-prone material', [
      structuredBlocker(
        'crafted.alpha',
        'src/value.js',
        8,
        'Ambiguous validation defect',
        `${'shared bounded identity material '.repeat(200)}alpha-only consequence`,
      ),
      structuredBlocker(
        'crafted.bravo',
        'src/value.js',
        19,
        'Ambiguous validation defect',
        `${'shared bounded identity material '.repeat(200)}bravo-only consequence`,
      ),
    ]],
  ])('blocks %s before issuing the first remediation writer', (_label, findings) => {
    const ticket = {
      ticket_id: 'ticket-incomparable-review',
      stage_id: 'review',
      role: 'reviewer',
      parallel_group: 'code-review',
    };
    const state = pureRun({ stage: 'review', tickets: [ticket] });
    const actions = recordPure(state, ticket, {
      status: 'passed',
      findings,
      evidence: { verdict: 'fail' },
    });

    expect(actions.some((entry) => entry.type === 'issue_ticket')).toBe(false);
    expect(actions.map((entry) => entry.type)).toEqual([
      'transition', 'archive_history', 'release_lock', 'persist_state',
    ]);
    expect(state).toMatchObject({ status: 'blocked', stage: 'remediation' });
    expect(state.block_reason).toMatch(/ambiguous|incomparable|malformed|identity/i);
    expect(state).not.toHaveProperty('remediation_finding_history');
  });

  it('rejects a current finding that can ambiguously match two prior defects', () => {
    const priorFindings = [
      structuredBlocker(
        'redirect.host-only',
        'src/redirect.js',
        18,
        'Redirect allowlist compares only the host',
        'The port is ignored, so a disallowed destination can pass validation.',
      ),
      structuredBlocker(
        'redirect.port-only',
        'src/redirect.js',
        33,
        'Redirect allowlist compares only the port',
        'The host is ignored, so a disallowed destination can pass validation.',
      ),
    ];
    const reviewTicket = {
      ticket_id: 'ticket-ambiguous-initial-review',
      stage_id: 'review',
      role: 'reviewer',
      parallel_group: 'code-review',
    };
    const state = pureRun({ stage: 'review', tickets: [reviewTicket] });
    const started = recordPure(state, reviewTicket, {
      status: 'passed',
      findings: priorFindings,
      evidence: { verdict: 'fail' },
    });
    expect(started.some((entry) => entry.type === 'issue_ticket')).toBe(true);
    recordPure(state, state.tickets.at(-1), {
      status: 'passed', findings: [], evidence: { verdict: 'pass' },
    });

    const blocked = recordPure(state, state.tickets.at(-1), {
      status: 'passed',
      findings: [structuredBlocker(
        'redirect.combined',
        'src/redirect.js',
        51,
        'Redirect allowlist comparison is incomplete',
        'The host or port can bypass destination validation.',
      )],
      evidence: { verdict: 'fail' },
    });
    expect(blocked.some((entry) => entry.type === 'issue_ticket')).toBe(false);
    expect(blocked.map((entry) => entry.type)).toEqual([
      'transition', 'archive_history', 'release_lock', 'persist_state',
    ]);
    expect(state).toMatchObject({ status: 'blocked', stage: 'remediation' });
    expect(state.block_reason).toMatch(/ambiguous|incomparable|identity/i);
    expect(state.remediation_finding_history.cycles).toHaveLength(1);
  });

  it('migrates legacy finding history and replays its prepared successor exactly once after restart', async () => {
    const dir = await integrationProject();
    const reviewTicket = await walkIntegrationToReview(dir);
    const firstFindings = [
      structuredBlocker(
        'value.boundary',
        'src/value.js',
        4,
        'Supported boundary is rejected',
        'The final supported value is rejected by the boundary check.',
      ),
      structuredBlocker(
        'cache.atomicity',
        'src/cache.js',
        9,
        'Cache update is not atomic',
        'Concurrent writers can lose a cache update.',
      ),
    ];
    const firstReview = await recordReceipt(dir, receipt(reviewTicket, {
      tests: [{
        command: 'node tests/value.test.js',
        passed: true,
        exit_code: 0,
        duration_ms: 1,
      }],
      findings: firstFindings,
      evidence: { verdict: 'fail' },
    }));
    expect(firstReview.ok, JSON.stringify(firstReview.errors ?? [])).toBe(true);
    expect(firstReview.run.remediation_finding_history).toMatchObject({
      version: 1,
      cycles: [expect.any(Array)],
    });

    const firstWriter = firstReview.run.tickets.at(-1);
    expect(firstWriter.stage_id).toBe('remediation-build');
    const remediated = await recordReceipt(dir, receipt(firstWriter, {
      tests: [{
        command: 'node tests/value.test.js',
        passed: true,
        exit_code: 0,
        duration_ms: 1,
      }],
    }));
    expect(remediated.ok, JSON.stringify(remediated.errors ?? [])).toBe(true);
    const remediationReview = remediated.run.tickets.at(-1);
    expect(remediationReview.stage_id).toBe('remediation-review');

    const paths = runtimePaths(dir);
    const staleActive = await readJson(paths.active);
    const durablePriorReceipt = staleActive.receipts.find(
      (entry) => entry.ticket_id === reviewTicket.ticket_id,
    );
    expect(durablePriorReceipt?.receipt_hash).toMatch(/^[0-9a-f]{64}$/);
    const legacyIdentity = reviewFindings.analyzeLegacyIdentities([durablePriorReceipt]);
    expect(legacyIdentity).toMatchObject({ valid: true, fingerprints: expect.any(Array) });
    expect(legacyIdentity.fingerprints).toHaveLength(2);
    const embeddedCheckpoint = {
      version: 1,
      cycles: [legacyIdentity.fingerprints],
      aliases: legacyIdentity.aliases,
      provenance: [legacyIdentity.provenance],
    };
    staleActive.remediation_finding_fingerprints = legacyIdentity.fingerprints;
    staleActive.remediation_finding_count = legacyIdentity.fingerprints.length;
    staleActive.remediation_finding_history = structuredClone(embeddedCheckpoint);
    await atomicWriteJson(paths.active, staleActive);
    const reloadedCheckpoint = await statusRun(dir);
    expect(reloadedCheckpoint).toMatchObject({ ok: true, active: true });
    expect(reloadedCheckpoint.run.remediation_finding_history).toEqual(embeddedCheckpoint);
    expect(reloadedCheckpoint.run.remediation_finding_history)
      .not.toHaveProperty('identity_epoch');

    const migration = reviewFindings.migrateLegacyHistory(
      [[durablePriorReceipt]],
      embeddedCheckpoint.cycles,
      embeddedCheckpoint.aliases,
      embeddedCheckpoint.provenance,
    );
    expect(migration).toMatchObject({
      valid: true,
      legacyCycleCount: 1,
      normalizedProvenance: [expect.any(Object)],
    });
    const expectedIdentityEpoch = {
      version: 1,
      legacy_cycle_count: 1,
      legacy_history_hash: sha256({
        cycles: embeddedCheckpoint.cycles,
        aliases: embeddedCheckpoint.aliases,
        provenance: embeddedCheckpoint.provenance,
      }),
      normalized_history_hash: sha256({
        aliases: migration.aliases,
        provenance: migration.normalizedProvenance,
      }),
      normalized_provenance: migration.normalizedProvenance,
    };
    const receiptTransactionsBefore = await readdir(paths.receiptTransactions);
    const replayedDraft = receipt(remediationReview, {
      tests: [{
        command: 'node tests/value.test.js',
        passed: true,
        exit_code: 0,
        duration_ms: 1,
      }],
      findings: [
        structuredBlocker(
          'cache.renumbered',
          'src/cache.js',
          23,
          'Cache update is not atomic.',
          'Concurrent writers can lose a cache update!',
        ),
        structuredBlocker(
          'log.newly-observed',
          'src/log.js',
          12,
          'Audit write can be lost',
          'A crash between the data write and audit append loses the audit record.',
        ),
      ],
      evidence: { verdict: 'fail' },
    });
    const firstRecord = await recordReceipt(dir, replayedDraft);
    expect(firstRecord.ok, JSON.stringify(firstRecord.errors ?? [])).toBe(true);
    expect(firstRecord.run.remediation_cycles).toBe(2);
    const successor = firstRecord.run.tickets.at(-1);
    expect(successor.stage_id).toBe('remediation-build');
    expect(firstRecord.run.remediation_finding_history.cycles).toHaveLength(2);
    expect(firstRecord.run.remediation_finding_history.identity_epoch)
      .toEqual(expectedIdentityEpoch);
    expect(firstRecord.run.remediation_finding_history.cycles[0])
      .toEqual(embeddedCheckpoint.cycles[0]);
    expect(firstRecord.run.remediation_finding_history.provenance[0])
      .toEqual(embeddedCheckpoint.provenance[0]);
    const migratedHistory = structuredClone(firstRecord.run.remediation_finding_history);
    const successorPath = path.join(
      paths.tickets,
      `${successor.ticket_id.replaceAll(':', '_')}.json`,
    );
    const durableBytesBeforeReplay = {
      active: await readFile(paths.active),
      successor: await readFile(successorPath),
    };

    const durableBeforeReplay = {
      tickets: (await readdir(paths.tickets)).sort(),
      receipts: (await readdir(paths.receipts)).sort(),
      transactions: (await readdir(paths.receiptTransactions)).sort(),
    };
    const newReceiptTransactions = durableBeforeReplay.transactions.filter(
      (file) => !receiptTransactionsBefore.includes(file),
    );
    expect(newReceiptTransactions).toHaveLength(1);
    const transactionFile = path.join(paths.receiptTransactions, newReceiptTransactions[0]);
    const preparedTransaction = await readJson(transactionFile);
    expect(preparedTransaction.status).toBe('committed');
    delete preparedTransaction.committed_at;
    preparedTransaction.status = 'prepared';
    await atomicWriteJson(transactionFile, preparedTransaction);
    await atomicWriteJson(paths.active, staleActive);

    const replayed = await recordReceipt(dir, replayedDraft);
    expect(replayed.ok, JSON.stringify(replayed.errors ?? [])).toBe(true);
    expect(replayed.run.remediation_cycles).toBe(2);
    expect(replayed.run.remediation_finding_history).toEqual(migratedHistory);
    expect(replayed.run.tickets.filter((ticket) => ticket.ticket_id === successor.ticket_id))
      .toHaveLength(1);
    expect(replayed.run.receipts.filter((entry) => entry.ticket_id === remediationReview.ticket_id))
      .toHaveLength(1);
    expect(await readFile(paths.active)).toEqual(durableBytesBeforeReplay.active);
    expect(await readFile(successorPath)).toEqual(durableBytesBeforeReplay.successor);
    expect({
      tickets: (await readdir(paths.tickets)).sort(),
      receipts: (await readdir(paths.receipts)).sort(),
      transactions: (await readdir(paths.receiptTransactions)).sort(),
    }).toEqual(durableBeforeReplay);
  }, 30_000);

  it('actionable-scope-denial preserves exact additive paths, role, and successor requirements', () => {
    const ticket = {
      ticket_id: 'ticket-capability-build',
      stage_id: 'build',
      role: 'implementer',
      parallel_group: null,
      claimed_paths: ['src/value.js'],
      test_paths: ['tests/value.test.js'],
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
      failure_domain: 'configuration',
      failure_domain_taxonomy_version: 1,
      blocked_recovery: {
        reason_code: 'capability_denied',
        source_ticket_id: ticket.ticket_id,
        source_stage_id: 'build',
        additive_claims: {
          claimed_paths: ['src/generated/value.js'],
          test_paths: ['tests/generated/value.test.js'],
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
        required_claims: { claimed_paths: ['docs/review.md'] },
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
          additive_claims: { claimed_paths: ['docs/review.md'] },
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
            required_claims: { test_paths: ['tests/generated.test.js'] },
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
            additive_claims: { test_paths: ['tests/generated.test.js'] },
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

  it('accepts a correctable command-shape denial and reissues the same contract without a stage attempt', async () => {
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
    expect(recorded.run.attempts.plan).toBeUndefined();
    expect(recorded.run.worker_protocol_redispatches).toEqual({ plan: 1 });
    expect(recorded.run.tickets.at(-1)).toMatchObject({
      stage_id: 'plan',
      attempt: 1,
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
      ['noncanonical path', { claimed_paths: ['src/../escape.js'] }, /canonical contained project-relative/i],
      ['path already covered by a directory claim', { claimed_paths: ['src/value.js'] }, /already on the immutable ticket/i],
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
        summary: 'The planner needs an additional reviewed project path.',
        required_claims: {
          claimed_paths: ['docs/review.md'],
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
          claimed_paths: ['docs/review.md'],
          required_role: 'plan_checker',
        },
        successor_required: true,
        supersession_required: true,
      },
    });
    expect(admitted.successor_guidance).toEqual({
      version: 2,
      eligible: true,
      predecessor_run_id: admitted.run.run_id,
      retained_tree_sha: admitted.run.tree_sha,
      config_hash: expect.stringMatching(/^[0-9a-f]{64}$/),
      eligibility_reason: 'capability_blocked',
      structured_successor_supported: false,
      unavailable_reason: 'authenticated-host-approval-unavailable',
      recovery_action: 'override-reset',
      required_authorization: 'explicit-operator-override',
      automatic_start: false,
      automatic_ship: false,
      configuration_drift: { changed: false },
    });
    expect(admitted.successor_guidance).not.toHaveProperty('dispatch');
    expect(admitted.successor_guidance).not.toHaveProperty('actions');
    expect((await statusRun(dir)).successor_guidance).toEqual(admitted.successor_guidance);
    expect((await compactStatus(dir)).successor_guidance).toEqual(admitted.successor_guidance);
  }, 30_000);

  it('fails closed when any caller tries to bypass an active blocked run', async () => {
    const dir = await integrationProject();
    const startInput = {
      objective: 'Refuse unauthenticated structured carry-forward',
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
    };
    const started = await startRun(dir, startInput);
    const blocked = await recordReceipt(dir, receipt(started.run.tickets.at(-1), {
      status: 'failed',
      evidence: {
        failure_kind: 'capability',
        summary: 'The next run needs one additional path.',
        required_claims: { claimed_paths: ['docs/review.md'] },
      },
    }));
    const guidance = blocked.successor_guidance;
    const before = await readJson(runtimePaths(dir).active);
    const branchBefore = git(dir, 'branch', '--show-current');

    const legacyResponse = await handleMcp({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: {
        name: 'ape_run',
        arguments: {
          action: 'start',
          project_dir: dir,
          ...startInput,
          supersedes_run: guidance.predecessor_run_id,
        },
      },
    });
    expect(legacyResponse.result.isError).toBe(true);
    expect(JSON.parse(legacyResponse.result.content[0].text).errors.join(' '))
      .toMatch(/audited override reset|ordinary fresh run/i);

    for (const successor of [
      {
        version: guidance.version,
        predecessor_run_id: guidance.predecessor_run_id,
        retained_tree_sha: guidance.retained_tree_sha,
        config_hash: guidance.config_hash,
        authorization: 'explicit-operator-start',
      },
      {
        version: guidance.version,
        predecessor_run_id: guidance.predecessor_run_id,
        retained_tree_sha: guidance.retained_tree_sha,
        config_hash: guidance.config_hash,
        approval_id: 'successor-approval-00000000-0000-4000-8000-000000000001',
      },
    ]) {
      const previewRefused = await previewRun(dir, { ...startInput, successor });
      expect(previewRefused).toMatchObject({ ok: false, blocked: true, attempts_consumed: 0 });
      expect(previewRefused.errors.join(' ')).toMatch(/authenticated user provenance|override reset/i);
      const refused = await startRun(dir, { ...startInput, successor });
      expect(refused).toMatchObject({ ok: false, blocked: true, attempts_consumed: 0 });
      expect(refused.errors.join(' ')).toMatch(/authenticated user provenance|override reset/i);
    }

    expect(await readJson(runtimePaths(dir).active)).toEqual(before);
    expect(git(dir, 'branch', '--show-current')).toBe(branchBefore);
  }, 30_000);

  it('keeps unauthenticated structured successors off the public MCP surface', async () => {
    const listed = await handleMcp({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/list',
      params: {},
    });
    const publicRun = listed.result.tools.find((tool) => tool.name === 'ape_run');
    expect(publicRun.inputSchema.properties).not.toHaveProperty('successor');
    expect(publicRun.inputSchema.properties.action.enum).not.toContain('prepare-successor');
    expect(publicRun.inputSchema.properties.action.description)
      .toMatch(/authenticated human provenance|audited override reset/i);
    expect(JSON.stringify(publicRun.inputSchema)).not.toMatch(/successor-approval|UserPromptSubmit/i);

    const response = await handleMcp({
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/call',
      params: {
        name: 'ape_run',
        arguments: { action: 'prepare-successor', project_dir: process.cwd() },
      },
    });
    expect(response.result.isError).toBe(true);
    expect(response.result.content[0].text).toMatch(/unknown tool or action/i);

    for (const action of ['preview', 'start']) {
      const structured = await handleMcp({
        jsonrpc: '2.0',
        id: action,
        method: 'tools/call',
        params: {
          name: 'ape_run',
          arguments: {
            action,
            project_dir: process.cwd(),
            objective: 'Attempt a structured successor through MCP',
            host: 'codex',
            successor: { version: 2 },
          },
        },
      });
      expect(structured.result.isError, action).toBe(true);
      expect(structured.result.content[0].text, action)
        .toMatch(/authenticated user provenance|audited override reset/i);
    }
  });

  it('omits actionable guidance when a legacy blocked run has no configuration baseline', async () => {
    const dir = await integrationProject();
    const started = await startRun(dir, {
      objective: 'Fail closed without a configuration baseline',
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
    const paths = runtimePaths(dir);
    const legacyState = await readJson(paths.active);
    delete legacyState.start_config_hash;
    delete legacyState.capability_snapshot;
    await atomicWriteJson(paths.active, legacyState);

    const blocked = await recordReceipt(dir, receipt(started.run.tickets.at(-1), {
      status: 'failed',
      evidence: {
        failure_kind: 'capability',
        summary: 'An additional path is required.',
        required_claims: { claimed_paths: ['docs/review.md'] },
      },
    }));
    expect(blocked.ok).toBe(true);
    expect(blocked.run.status).toBe('blocked');
    expect(blocked).not.toHaveProperty('successor_guidance');
  }, 30_000);

  it('reports configuration drift as a boolean fact without disclosing changed configuration', async () => {
    const dir = await integrationProject();
    const started = await startRun(dir, {
      objective: 'Report bounded successor drift',
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
    const paths = runtimePaths(dir);
    const changedConfig = await readJson(paths.config);
    changedConfig.verification.profiles[0].description = 'PRIVATE_CONFIGURATION_DETAIL';
    await atomicWriteJson(paths.config, changedConfig);

    const blocked = await recordReceipt(dir, receipt(started.run.tickets.at(-1), {
      status: 'failed',
      evidence: {
        failure_kind: 'capability',
        summary: 'An additional path is required.',
        required_claims: { claimed_paths: ['docs/review.md'] },
      },
    }));
    expect(blocked.successor_guidance.configuration_drift).toEqual({ changed: true });
    expect(JSON.stringify(blocked.successor_guidance)).not.toContain('PRIVATE_');
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

  it('keeps legacy remediation state readable but refuses to infer missing history', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'ape-remediation-history-legacy-'));
    cleanups.push(dir);
    const priorFinding = structuredBlocker(
      'legacy.value',
      'src/value.js',
      4,
      'Supported boundary is rejected',
      'The final supported value is rejected by the boundary check.',
    );
    const remainingFinding = structuredBlocker(
      'legacy.cache',
      'src/cache.js',
      9,
      'Cache update is not atomic',
      'Concurrent writers can lose a cache update.',
    );
    const priorFingerprints = reviewFindings.fingerprints([{
      ticket_id: 'legacy-review',
      status: 'passed',
      findings: [priorFinding, remainingFinding],
      evidence: { verdict: 'fail' },
    }]);
    const reviewTicket = {
      ticket_id: 'legacy-remediation-review',
      stage_id: 'remediation-review',
      role: 'reviewer',
      parallel_group: 'code-review',
    };
    const legacy = pureRun({
      schema_version: SCHEMA_VERSION,
      host: 'codex',
      stage: 'remediation-review',
      dispatch_state: 'none',
      remediation_cycles: 1,
      remediation_finding_fingerprints: priorFingerprints,
      remediation_finding_count: priorFingerprints.length,
      tickets: [reviewTicket],
    });
    await atomicWriteJson(runtimePaths(dir).active, legacy);

    const status = await statusRun(dir);
    expect(status).toMatchObject({ ok: true, active: true });
    expect(status.run).not.toHaveProperty('remediation_finding_history');

    const actions = recordPure(legacy, reviewTicket, {
      status: 'passed',
      findings: [remainingFinding],
      evidence: { verdict: 'fail' },
    });
    expect(actions.some((entry) => entry.type === 'issue_ticket')).toBe(false);
    expect(actions.map((entry) => entry.type)).toEqual([
      'transition', 'archive_history', 'release_lock', 'persist_state',
    ]);
    expect(legacy).toMatchObject({ status: 'blocked', stage: 'remediation' });
    expect(legacy.block_reason).toMatch(/history|inconsistent|comparable/i);
  });
});

describe('APE v2 remediation identity input bounds and path containment', () => {
  function identityBlocker(id, file, title = 'Unchecked redirect target') {
    return {
      id,
      file,
      line: 12,
      title,
      detail: 'A caller-controlled destination can send the user to an external origin.',
      blocking: true,
      remediation: { owner: 'production' },
    };
  }

  function dissent(ticketId, findings) {
    return {
      ticket_id: ticketId,
      status: 'passed',
      findings,
      evidence: { verdict: 'fail' },
    };
  }

  it('does not mistake bare path wording for encoded-path normalization in one login flow', () => {
    const externalHost = dissent('ticket-login-external-host', [structuredBlocker(
      'login.external-host',
      'src/auth/redirect.js',
      21,
      'Login callback path follows external host',
      'Signin destination path accepts attacker origin',
    )]);
    const encodedBackslash = dissent('ticket-login-encoded-backslash', [structuredBlocker(
      'login.encoded-backslash',
      'src/auth/redirect.js',
      47,
      'Next navigation accepts untrusted encoded backslash path',
      'Login location lets an untrusted path escape normalization',
    )]);

    const known = reviewFindings.fingerprints([externalHost]);
    expect(known).toHaveLength(1);
    const analyzed = reviewFindings.analyzeIdentities(
      [encodedBackslash],
      [externalHost],
      known,
    );
    expect(analyzed).toMatchObject({ valid: true, fingerprints: [expect.any(String)] });
    expect(analyzed.fingerprints[0]).not.toBe(known[0]);
  });

  it('fails closed when one redirect finding names both authority and path-normalization mechanisms', () => {
    const analyzed = reviewFindings.analyzeIdentities([
      dissent('ticket-login-mixed-mechanisms', [structuredBlocker(
        'login.mixed-mechanisms',
        'src/auth/redirect.js',
        63,
        'Login redirect lacks an external host allowlist and encoded backslash normalization',
        'Signin callback accepts an attacker origin after path separator normalization.',
      )]),
    ]);

    expect(analyzed).toMatchObject({
      valid: false,
      reason: 'ambiguous',
      fingerprints: [],
    });
  });

  it.each([
    [
      'symbol insertion',
      'Cache update loses stored value',
      'Atomic writer drops committed record',
      '$ Cache update loses stored value',
      'Atomic writer drops committed record $',
    ],
    [
      'symbol position',
      '$ Cache update loses stored value',
      'Atomic writer $ drops committed record',
      'Cache update $ loses stored value',
      'Atomic writer drops committed $ record',
    ],
    [
      'duplicate-word count',
      'Cache update loses stored value',
      'Atomic writer drops committed record',
      'Cache cache update update loses stored stored value',
      'Atomic writer writer drops committed committed record record',
    ],
  ])('maps cosmetic %s churn to the established root', (
    _label,
    priorTitle,
    priorDetail,
    currentTitle,
    currentDetail,
  ) => {
    const prior = dissent(`ticket-cosmetic-${_label}-prior`, [structuredBlocker(
      `cosmetic.${_label}.prior`,
      'src/cache.js',
      18,
      priorTitle,
      priorDetail,
    )]);
    const current = dissent(`ticket-cosmetic-${_label}-current`, [structuredBlocker(
      `cosmetic.${_label}.current`,
      'src/cache.js',
      52,
      currentTitle,
      currentDetail,
    )]);
    const known = reviewFindings.fingerprints([prior]);

    expect(reviewFindings.analyzeIdentities([current], [prior], known)).toMatchObject({
      valid: true,
      fingerprints: known,
    });
  });

  it('canonicalizes dot segments and platform separators before identity comparison', () => {
    const aliasFindings = [
      identityBlocker('redirect.canonical', 'src/redirect.js'),
      identityBlocker('redirect.dot-segment', 'src/security/../redirect.js'),
      identityBlocker('redirect.backslash', 'src\\redirect.js'),
      identityBlocker('redirect.dot-prefix', './src/redirect.js'),
    ];
    const aliases = dissent('ticket-path-aliases', aliasFindings);

    expect(reviewFindings.fingerprints([aliases])).toHaveLength(1);
    const receiptCycles = aliasFindings.map((finding, index) =>
      dissent(`ticket-path-alias-cycle-${index}`, [finding]));
    const known = reviewFindings.fingerprints([receiptCycles[0]]);
    for (let index = 1; index < receiptCycles.length; index += 1) {
      expect(reviewFindings.analyzeIdentities(
        [receiptCycles[index]],
        receiptCycles.slice(0, index),
        known,
      )).toMatchObject({ valid: true, fingerprints: known });
    }
    const state = {
      tickets: [{
        ticket_id: aliases.ticket_id,
        stage_id: 'review',
        role: 'reviewer',
        parallel_group: 'code-review',
      }],
    };
    expect(reviewFindings.evidence(state, [aliases])).toEqual([
      expect.objectContaining({ evidence_anchor: 'src/redirect.js:L12' }),
    ]);
  });

  it.each([
    ['/absolute path', '/src/redirect.js'],
    ['parent escape', '../src/redirect.js'],
    ['nested parent escape', 'src/../../outside.js'],
    ['drive-qualified path', 'C:\\src\\redirect.js'],
    ['empty segment', 'src//redirect.js'],
    ['trailing separator', 'src/redirect.js/'],
  ])('rejects a non-contained or noncanonical identity %s', (_label, file) => {
    const analyzed = reviewFindings.analyzeIdentities([
      dissent(`ticket-unsafe-${_label}`, [identityBlocker(`unsafe.${_label}`, file)]),
    ]);
    expect(analyzed).toMatchObject({ valid: false, fingerprints: [] });
    expect(analyzed.reason).toMatch(/path|malformed|contain|canonical/i);
  });

  it('rejects a Unicode compatibility separator before it can collide with a real path separator', () => {
    const canonical = identityBlocker(
      'compatibility-separator.canonical',
      'src/auth.js',
      'JWT audience validation is missing',
    );
    const compatibilitySeparator = identityBlocker(
      'compatibility-separator.fullwidth',
      'src\uFF0Fauth.js',
      'JWT audience validation is missing',
    );

    const analyzed = reviewFindings.analyzeIdentities([
      dissent('ticket-compatibility-separator-collision', [
        canonical,
        compatibilitySeparator,
      ]),
    ]);

    expect(analyzed).toMatchObject({ valid: false, fingerprints: [] });
    expect(analyzed.reason).toMatch(/path|canonical|malformed/i);
  });

  it('fails closed when distinct current redirects share only a coarse login-flow tag', () => {
    const analyzed = reviewFindings.analyzeIdentities([
      dissent('ticket-coarse-login-redirects', [
        structuredBlocker(
          'login.next-redirect',
          'src/auth/redirect.js',
          21,
          'Login redirect trusts next',
          'External destination accepted',
        ),
        structuredBlocker(
          'login.return-redirect',
          'src/auth/redirect.js',
          37,
          'Login handler follows return',
          'Untrusted location leaves site',
        ),
      ]),
    ]);

    expect(analyzed).toMatchObject({
      valid: false,
      reason: 'ambiguous',
      fingerprints: [],
    });
  });

  it('rejects an aggregate descriptor overflow before entering nested descriptor work', () => {
    const ordinary = Array.from({ length: 64 }, (_, index) =>
      identityBlocker(`bounded.${index}`, `src/bounded-${index}.js`, `Bounded defect ${index}`));
    const nestedWorkSentinel = new Proxy(identityBlocker(
      'bounded.overflow',
      'src/overflow.js',
      'Overflow descriptor must not be inspected',
    ), {
      get() {
        throw new Error('nested identity work ran before the aggregate descriptor ceiling');
      },
    });
    let analyzed;
    expect(() => {
      analyzed = reviewFindings.analyzeIdentities([
        dissent('ticket-bounded-prefix', ordinary),
        dissent('ticket-bounded-overflow', [nestedWorkSentinel]),
      ]);
    }).not.toThrow();
    expect(analyzed).toMatchObject({ valid: false, fingerprints: [] });
    expect(analyzed.reason).toMatch(/limit|bound|resource|malformed/i);
  });

  it('rejects aggregate normalized-token and serialized-byte history at the maximum item count', () => {
    const findings = Array.from({ length: 64 }, (_, index) => ({
      ...identityBlocker(
        `aggregate.${index}`,
        `src/aggregate-${index}.js`,
        `Aggregate descriptor ${index}`,
      ),
      // Every descriptor is individually admissible (< 4,000 characters),
      // while the 64-item history is intentionally oversized in aggregate.
      detail: `Aggregate descriptor ${index} ${'bounded comparison material '.repeat(120)}`,
    }));
    const analyzed = reviewFindings.analyzeIdentities([
      dissent('ticket-aggregate-maximum', findings),
    ]);
    expect(analyzed).toMatchObject({ valid: false, fingerprints: [] });
    expect(analyzed.reason).toMatch(/limit|bound|resource|malformed/i);
  });

  it('charges both component-building and clique-validation work before maximum-size comparison', () => {
    const ignoredComparisonWords = ['another', 'after', 'before', 'can', 'during', 'only'];
    const equivalent = Array.from({ length: 64 }, (_, index) => {
      const suffix = ignoredComparisonWords
        .filter((_word, bit) => (index & (1 << bit)) !== 0)
        .join(' ');
      return {
        ...identityBlocker(
          `work-bound.${index}`,
          'src/cache.js',
          `Cache transaction loses committed update ${suffix}`,
        ),
        detail: `Concurrent cache transaction loses committed update atomically ${suffix}`,
      };
    });

    const analyzed = reviewFindings.analyzeIdentities([
      dissent('ticket-maximum-clique-work', equivalent),
    ]);
    expect(analyzed).toMatchObject({ valid: false, fingerprints: [] });
    expect(analyzed.reason).toMatch(/limit|bound|resource/i);
  });
});
