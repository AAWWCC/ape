import { describe, expect, it } from 'vitest';
import { reduceRun } from '../lib/runtime/reducer.js';
import { executionPolicySnapshot } from '../lib/runtime/pipeline-limits.js';
import { DEFAULT_CONFIG } from '../lib/runtime/config.js';
import { GENERAL_INPUT_MAX_BYTES } from '../lib/runtime/input-guard.js';
import { hashRecord, sha256 } from '../lib/runtime/canonical.js';
import { CandidatePlanSchema } from '../lib/runtime/plan-contract.js';
import { planRecoveryContextForState } from '../lib/runtime/recovery-progress.js';
import { receiptOutputSchemaForTicket, validateReceiptDraft } from '../lib/runtime/receipt-validator.js';
import { historicalExecutionPolicy } from './historical-execution-policy-helper.js';

// These are runtime-owned reducer inputs, not worker claims. The service
// integration tests separately exercise validation and persistence authority.
const tree = (n) => n.toString(16).padStart(40, '0');
function state(overrides = {}) {
  return { run_id: 'evidence-recovery', mode: 'phase', lane: 'fast', status: 'running',
    stage: 'dispatch', high_risk: false, tickets: [], receipts: [], attempts: {},
    remediation_cycles: 0, plan_replan_cycles: 0, tree_sha: tree(1),
    execution_policy: executionPolicySnapshot(DEFAULT_CONFIG), ...overrides };
}
function issue(run, stage, extra = {}) {
  const ticket = { ticket_id: `ticket-${run.tickets.length + 1}`, stage_id: stage.id,
    role: stage.role, parallel_group: stage.parallel_group ?? null,
    writable: stage.writable ?? ['implementer', 'test_writer'].includes(stage.role),
    claimed_paths: ['src/value.js'], test_paths: ['tests/value.test.js'],
    base_tree_sha: run.tree_sha, attempt: run.attempts[stage.id] ?? 1,
    capability_manifest: { byte_budgets: { candidate_plan_utf8_bytes: GENERAL_INPUT_MAX_BYTES } },
    ...(run.candidate_plan ? { candidate_plan: structuredClone(run.candidate_plan) } : {}),
    ...extra };
  if (stage.id === 'plan-judge') {
    ticket.execution_limits = run.execution_policy.limits;
    if (run.execution_policy.version === 4 && run.plan_recovery) {
      ticket.plan_recovery = structuredClone(run.plan_recovery);
      ticket.plan_recovery_context = planRecoveryContextForState(run);
    }
    ticket.ticket_hash = hashRecord(ticket, ['ticket_hash']);
  }
  run.tickets.push(ticket);
  run.stage = stage.id;
  return ticket;
}
function apply(run, actions) {
  for (const action of actions) {
    if (action.type === 'transition') Object.assign(run, action.patch);
    if (action.type === 'issue_ticket') {
      const { type, stage, ...extra } = action;
      const source = run.tickets.find((ticket) => ticket.ticket_id === (extra.retry_of ?? extra.source_ticket_id));
      issue(run, stage, { ...(source ? { claimed_paths: source.claimed_paths, test_paths: source.test_paths,
        ...(source.test_scope ? { test_scope: source.test_scope } : {}) } : {}), ...extra });
    }
  }
  return actions;
}
function record(run, ticket, overrides = {}, eventOverrides = {}) {
  const receipt = { ticket_id: ticket.ticket_id, receipt_id: `receipt-${ticket.ticket_id}`, status: 'passed',
    base_tree_sha: ticket.base_tree_sha, head_tree_sha: run.tree_sha,
    changed_files: [], findings: [], tests: [], evidence: { verdict: 'agree' }, ...overrides };
  run.receipts.push(receipt);
  const previous = run.recovery_progress?.review?.at(-1);
  const boundary = run.receipts.findIndex((entry) => entry.ticket_id === run.review_recovery_receipt_boundary);
  // Synthetic fixtures retain their declared edits by default. Revert and
  // provenance cases explicitly override this runtime-owned service input.
  const netDiff = previous ? { base_tree_sha: previous.artifact, head_tree_sha: run.tree_sha,
    changed_files: [...new Set(run.receipts.slice(boundary + 1).flatMap((entry) => entry.changed_files ?? []))] } : null;
  const previousContradiction = run.recovery_progress?.['test-contradiction']?.at(-1);
  const contradictionBoundary = run.receipts.findIndex((entry) =>
    entry.ticket_id === run.test_contradiction_recovery_receipt_boundary);
  const contradictionDiff = previousContradiction ? {
    base_tree_sha: previousContradiction.artifact, head_tree_sha: run.tree_sha,
    changed_files: [...new Set(run.receipts.slice(contradictionBoundary + 1)
      .flatMap((entry) => entry.changed_files ?? []))],
  } : null;
  return apply(run, reduceRun(run, { type: 'RECEIPT_RECORDED', ticket, receipt,
    next_state: run, stage: { id: ticket.stage_id, role: ticket.role, parallel_group: ticket.parallel_group },
    review_recovery_diff: netDiff, test_contradiction_recovery_diff: contradictionDiff, ...eventOverrides }));
}
const blocker = (id) => ({ id, file: 'src/value.js', line: 1, title: `Defect ${id}`,
  detail: `A distinct reproducible failure ${id}`, blocking: true, remediation: { owner: 'production' } });
const assurance = (id) => ({ requirement_id: id, evidence_anchor: `requirements.${id}`,
  summary: `Missing assurance for ${id}` });
function candidate(repaired = []) {
  const plan = {
    version: 2, preflight_hash: 'a'.repeat(64),
    requirements: ['A', 'B', 'C', 'D', 'E'].map((id) => ({
      id, requirement: `Address ${id}`, workstreams: [`W_${id}`],
    })),
    workstreams: ['A', 'B', 'C', 'D', 'E'].map((id, index) => ({ id: `W_${id}`, outcome: 'Repair the scoped value implementation',
      paths: [{ path: 'src/value.js', action: 'modify' }],
      steps: [repaired.includes(id)
        ? `Write and fsync state for case ${index + 1} before acknowledging requests`
        : `Acknowledge requests for case ${index + 1}, then write state`],
      acceptance: [repaired.includes(id)
        ? `Crash before and after persistence for case ${index + 1}, restart, and verify acknowledged work is recovered`
        : `Assert requests for case ${index + 1} return success`],
      evidence_commands: ['node tests/value.test.js'], verification_profiles: [] })),
    risks: [], assurances: [], non_goals: [],
  };
  return CandidatePlanSchema.parse({ plan_hash: sha256(plan), plan });
}
function planResolutions(judge, resolved) {
  return { version: 1, previous_plan_hash: judge.plan_recovery_context.previous_candidate.plan_hash,
    candidate_plan_hash: judge.candidate_plan.plan_hash,
    resolved: resolved.map((id) => ({
      prior_assurance_id: judge.plan_recovery.missing_assurances.find((entry) => entry.requirement_id === id).id,
      implementation_anchors: [{ workstream_id: `W_${id}`, field: 'steps', index: 0 }],
      acceptance_anchors: [{ workstream_id: `W_${id}`, field: 'acceptance', index: 0 }],
      rationale: 'Durable persistence now precedes acknowledgment, with crash and restart acceptance coverage',
    })) };
}
function failReview(run, ticket, ids) {
  return record(run, ticket, { findings: ids.map(blocker), evidence: { verdict: 'fail' } });
}
function remediate(run, revision, changedFiles = ['src/value.js']) {
  expect(run.tickets.at(-1).stage_id).toBe('remediation-build');
  run.tree_sha = tree(revision);
  record(run, run.tickets.at(-1), { changed_files: changedFiles });
  expect(run.tickets.at(-1).stage_id).toBe('remediation-review');
  return run.tickets.at(-1);
}
function expectStopped(run, actions) {
  expect(run.status).toBe('blocked');
  expect(actions.some((a) => a.type === 'issue_ticket')).toBe(false);
  expect(`${run.block_reason} ${JSON.stringify(run.blocked_recovery ?? {})}`)
    .toMatch(/progress|stall|repeated|cycle|evidence/i);
  expect(run.block_reason).not.toMatch(/configured attempts|budget|ceiling|quota/i);
  const reloaded = JSON.parse(JSON.stringify(run));
  expect(reduceRun(reloaded, { type: 'NEXT' }).some((a) => a.type === 'issue_ticket')).toBe(false);
}

function reportContradiction(run, ticket, id) {
  return record(run, ticket, { status: 'failed', findings: [{ ...blocker(id),
    file: 'tests/value.test.js', remediation: { owner: 'test', test_paths: ['tests/value.test.js'] } }],
    evidence: { failure_kind: 'test-contradiction', test_contradiction: {
      summary: `Contradictory expectations for ${id}`, test_paths: ['tests/value.test.js'],
    } } });
}

function correctContradiction(run, id, revision) {
  const reconciler = run.tickets.at(-1);
  expect(reconciler.stage_id).toBe('test-reconcile');
  expect(reconciler.test_reconciliation.test_paths).toEqual(['tests/value.test.js']);
  record(run, reconciler, { findings: [{ ...blocker(id), file: 'tests/value.test.js',
    remediation: { owner: 'test', test_paths: ['tests/value.test.js'] } }],
    evidence: { verdict: 'fail' } });
  const writer = run.tickets.at(-1);
  expect(writer.stage_id).toBe('test-recheck');
  expect(writer.test_reconciliation.test_paths).toEqual(['tests/value.test.js']);
  // Model the exact test scope assigned by ticket issuance, not an implementer
  // repairing the independent test itself.
  writer.claimed_paths = ['tests/value.test.js'];
  writer.test_paths = ['tests/value.test.js'];
  writer.test_scope = 'exact';
  run.tree_sha = tree(revision);
  record(run, writer, { changed_files: ['tests/value.test.js'],
    evidence: { summary: `Independent correction of ${id}` } });
  expect(run.tickets.at(-1).stage_id).toBe('build');
  expect(run.test_contradiction_pending).toBeNull();
  return run.tickets.at(-1);
}

describe('evidence-based recovery beyond count ceilings', () => {
  it('admits three distinct independently corrected contradictions after restart, then stops recurrence', () => {
    let run = state({ behavioral: true, attempts: { build: 1 } });
    let writer = issue(run, { id: 'build', role: 'implementer' });
    for (const [index, id] of ['A', 'B', 'C'].entries()) {
      const actions = reportContradiction(run, writer, id);
      expect(run.status).toBe('running');
      expect(actions).toContainEqual(expect.objectContaining({ type: 'issue_ticket',
        stage: expect.objectContaining({ id: 'test-reconcile', role: 'reviewer' }) }));
      expect(run.test_contradiction_reconciliations).toBe(index + 1);
      writer = correctContradiction(run, id, index + 2);
      run = JSON.parse(JSON.stringify(run));
      writer = run.tickets.at(-1);
    }
    expectStopped(run, reportContradiction(run, writer, 'A'));
  });

  it('does not authorize a second contradiction episode from renamed claims without a correction', () => {
    let run = state({ behavioral: true });
    const source = issue(run, { id: 'build', role: 'implementer' });
    reportContradiction(run, source, 'A');
    record(run, run.tickets.at(-1), { evidence: { verdict: 'pass' } });
    expect(run.tickets.at(-1).stage_id).toBe('build');
    run = JSON.parse(JSON.stringify(run));
    expectStopped(run, reportContradiction(run, run.tickets.at(-1), 'renamed-A'));
  });

  it('does not credit a still-open contradiction correction for a retired unrelated blocker', () => {
    let run = state({ behavioral: true });
    const testPaths = ['tests/a.test.js', 'tests/b.test.js'];
    const finding = (id, file) => ({ ...blocker(id), file,
      remediation: { owner: 'test', test_paths: [file] } });
    const source = issue(run, { id: 'build', role: 'implementer' }, { test_paths: testPaths });
    record(run, source, { status: 'failed',
      findings: [finding('A', testPaths[0]), finding('B', testPaths[1])],
      evidence: { failure_kind: 'test-contradiction', test_contradiction: {
        summary: 'Two independently located contradictory tests', test_paths: testPaths,
      } } });
    record(run, run.tickets.at(-1), { findings: [finding('B', testPaths[1])],
      evidence: { verdict: 'fail' } });
    const correction = run.tickets.at(-1);
    expect(correction.stage_id).toBe('test-recheck');
    expect(correction.test_reconciliation.test_paths).toEqual([testPaths[1]]);
    Object.assign(correction, { claimed_paths: [testPaths[1]], test_paths: [testPaths[1]], test_scope: 'exact' });
    run.tree_sha = tree(2);
    record(run, correction, { changed_files: [testPaths[1]] });
    run = JSON.parse(JSON.stringify(run));
    const actions = record(run, run.tickets.at(-1), { status: 'failed',
      findings: [finding('renamed-A', testPaths[0]), finding('B', testPaths[1])],
      evidence: { failure_kind: 'test-contradiction', test_contradiction: {
        summary: 'A is only renamed and B remains unresolved', test_paths: testPaths,
      } } }, { test_contradiction_recovery_diff: {
      base_tree_sha: tree(1), head_tree_sha: tree(2), changed_files: [testPaths[1]],
    } });
    expectStopped(run, actions);
  });

  it('retains a failed test-recheck repair when the successful retry changes another confirmed test', () => {
    let run = state({ behavioral: true });
    const testPaths = ['tests/value.test.js', 'tests/other.test.js'];
    const source = issue(run, { id: 'build', role: 'implementer' }, { test_paths: testPaths });
    record(run, source, { status: 'failed', findings: [{ ...blocker('A'), file: testPaths[0],
      remediation: { owner: 'test', test_paths: testPaths } }],
      evidence: { failure_kind: 'test-contradiction', test_contradiction: {
        summary: 'The two tests have mutually contradictory expectations', test_paths: testPaths,
      } } });
    record(run, run.tickets.at(-1), { findings: [{ ...blocker('A'), file: 'tests/value.test.js',
      remediation: { owner: 'test', test_paths: testPaths } }],
      evidence: { verdict: 'fail' } });
    const correction = run.tickets.at(-1);
    Object.assign(correction, { claimed_paths: testPaths,
      test_paths: testPaths, test_scope: 'exact' });
    run.tree_sha = tree(2);
    record(run, correction, { status: 'failed', changed_files: ['tests/value.test.js'],
      findings: [{ ...blocker('remaining-check'), file: 'tests/value.test.js',
        remediation: { owner: 'test', test_paths: ['tests/value.test.js'] } }] });
    expect(run.tickets.at(-1).stage_id).toBe('test-recheck');
    run.tree_sha = tree(3);
    record(run, run.tickets.at(-1), { changed_files: ['tests/other.test.js'] });
    expect(run.tickets.at(-1).stage_id).toBe('build');
    run = JSON.parse(JSON.stringify(run));
    const actions = reportContradiction(run, run.tickets.at(-1), 'B');
    expect(run.status).toBe('running');
    expect(run.test_contradiction_reconciliations).toBe(2);
    expect(actions).toContainEqual(expect.objectContaining({ type: 'issue_ticket',
      stage: expect.objectContaining({ id: 'test-reconcile', role: 'reviewer' }) }));
  });

  it.each([false, true])('does not credit a test repair reverted before another contradiction (unrelated edit: %s)', (unrelatedEdit) => {
    let run = state({ behavioral: true });
    const source = issue(run, { id: 'build', role: 'implementer' });
    reportContradiction(run, source, 'A');
    record(run, run.tickets.at(-1), { findings: [{ ...blocker('A'), file: 'tests/value.test.js',
      remediation: { owner: 'test', test_paths: ['tests/value.test.js'] } }],
      evidence: { verdict: 'fail' } });
    const correction = run.tickets.at(-1);
    Object.assign(correction, { claimed_paths: ['tests/value.test.js'],
      test_paths: ['tests/value.test.js'], test_scope: 'exact' });
    run.tree_sha = tree(2);
    record(run, correction, { status: 'failed', changed_files: ['tests/value.test.js'],
      findings: [{ ...blocker('remaining-check'), file: 'tests/value.test.js',
        remediation: { owner: 'test', test_paths: ['tests/value.test.js'] } }] });
    run.tree_sha = tree(1);
    record(run, run.tickets.at(-1), { changed_files: ['tests/value.test.js'] });
    expect(run.tickets.at(-1).stage_id).toBe('build');
    if (unrelatedEdit) run.tree_sha = tree(3);
    run = JSON.parse(JSON.stringify(run));
    const actions = record(run, run.tickets.at(-1), { status: 'failed',
      changed_files: unrelatedEdit ? ['src/value.js'] : [],
      findings: [{ ...blocker('renamed-A'), file: 'tests/value.test.js',
        remediation: { owner: 'test', test_paths: ['tests/value.test.js'] } }],
      evidence: { failure_kind: 'test-contradiction', test_contradiction: {
        summary: 'The original contradiction still exists under a new label', test_paths: ['tests/value.test.js'],
      } } }, { test_contradiction_recovery_diff: { base_tree_sha: tree(1), head_tree_sha: run.tree_sha,
      changed_files: unrelatedEdit ? ['src/value.js'] : [] } });
    expectStopped(run, actions);
  });

  it.each([2, 3])('retains the historical v%s one-reconciliation entry ceiling', (version) => {
    const run = state({ behavioral: true, execution_policy: historicalExecutionPolicy(version) });
    const source = issue(run, { id: 'build', role: 'implementer' });
    reportContradiction(run, source, 'A');
    const writer = correctContradiction(run, 'A', 2);
    const actions = reportContradiction(run, writer, 'B');
    expect(run.status).toBe('blocked');
    expect(run.test_contradiction_reconciliations).toBe(1);
    expect(actions.some((entry) => entry.type === 'issue_ticket')).toBe(false);
    expect(run.terminal_reason_code).toBe('test_contradiction');
  });

  it('does not let renamed worker findings and unrelated in-scope edits purchase another retry', () => {
    let run = state();
    const ticket = issue(run, { id: 'build', role: 'implementer' }, { claimed_paths: ['src'] });
    const defect = { ...blocker('original-label'), detail: 'value() still returns the wrong value' };
    record(run, ticket, { status: 'failed', findings: [defect] });
    run = JSON.parse(JSON.stringify(run));
    run.tree_sha = tree(2);
    // The diff is real and authorized, but src/comment.js is not the defect's
    // file and no independent check reports that the failure was repaired.
    expectStopped(run, record(run, run.tickets.at(-1), { status: 'failed',
      changed_files: ['src/comment.js'], findings: [{ ...defect, id: 'new-label' }],
      evidence: { summary: 'A different label and an unrelated comment change' } }));
  });
  it('admits four productive product attempts and then reaches review', () => {
    const run = state({ attempts: { build: 1 } });
    let ticket = issue(run, { id: 'build', role: 'implementer' });
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      run.tree_sha = tree(attempt + 1);
      const actions = record(run, ticket, { status: 'failed', changed_files: ['src/value.js'],
        findings: Array.from({ length: 4 - attempt }, (_, i) => blocker(`remaining-${i}`)),
        tests: [{ command: 'node tests/value.test.js', passed: false, exit_code: 1,
          duration_ms: 1, output_hash: String(attempt).repeat(64) }],
        evidence: { summary: 'A verified partial fix leaves these failures' } });
      expect(actions).toContainEqual(expect.objectContaining({ type: 'issue_ticket', recovery_kind: 'stage_retry' }));
      expect(run.status).toBe('running');
      ticket = run.tickets.at(-1);
    }
    expect(run.attempts.build).toBe(4);
    record(run, ticket);
    expect(run.tickets.at(-1).role).toBe('reviewer');
  });

  it.each(['passed', 'omitted', 'unchanged-tree'])('requires an observed repaired check for tests-only recovery: %s', (kind) => {
    let run = state({ attempts: { build: 1 } });
    const check = (command, passed) => ({ command, passed, exit_code: passed ? 0 : 1, duration_ms: 1 });
    const source = issue(run, { id: 'build', role: 'implementer' });
    record(run, source, { status: 'failed', tests: [check('node tests/a.js', false), check('node tests/b.js', false)] });
    run = JSON.parse(JSON.stringify(run));
    if (kind !== 'unchanged-tree') run.tree_sha = tree(2);
    const actions = record(run, run.tickets.at(-1), { status: 'failed', changed_files: ['src/value.js'],
      tests: [...(kind === 'omitted' ? [] : [check('node tests/a.js', true)]), check('node tests/b.js', false)] });
    if (kind === 'passed') {
      expect(run.status).toBe('running');
      expect(actions.some((entry) => entry.recovery_kind === 'stage_retry')).toBe(true);
    } else expectStopped(run, actions);
  });

  it.each(['protocol', 'command-shape'].flatMap((failureKind) =>
    ['passed', 'omitted'].map((repair) => ({ failureKind, repair }))))(
    'requires an exact observed repaired check for readonly $failureKind recovery: $repair', ({ failureKind, repair }) => {
      let run = state();
      const commands = ['node tests/a.js', 'node tests/b.js'];
      const check = (command, passed) => ({ command, passed, exit_code: passed ? 0 : 1, duration_ms: 1 });
      const ticket = issue(run, { id: 'test-reconcile', role: 'reviewer', writable: false });
      const input = { status: 'failed', findings: [], tests: commands.map((command) => check(command, false)),
        evidence: { failure_kind: failureKind } };
      const validateDraft = (target, draft) => {
        const objective = 'Independently reconcile the exact test claim';
        const bound = { ...target, objective, receipt_contract_version: 1,
          capability_manifest: { ...target.capability_manifest, version: 1,
            objective_hash: sha256(objective), allowed_evidence_commands: commands } };
        bound.output_schema = receiptOutputSchemaForTicket(bound);
        bound.capability_manifest.receipt_schema = { ref: 'ticket.output_schema', hash: sha256(bound.output_schema) };
        return validateReceiptDraft(bound, { ticket_id: target.ticket_id, receipt_capability: 'x'.repeat(40), ...draft });
      };
      expect(validateDraft(ticket, input).valid).toBe(true);
      record(run, ticket, input);
      run = JSON.parse(JSON.stringify(run));
      const retry = run.tickets.at(-1);
      expect(retry.writable).toBe(false);
      const next = { ...input, tests: [...(repair === 'passed' ? [check(commands[0], true)] : []),
        check(commands[1], false)] };
      expect(validateDraft(retry, next).valid).toBe(true);
      const actions = record(run, retry, next);
      expect(run.tree_sha).toBe(tree(1));
      if (repair === 'passed') {
        expect(run.status).toBe('running');
        expect(actions.some((entry) => entry.type === 'issue_ticket')).toBe(true);
      } else expectStopped(run, actions);
    });

  it.each([['build', 'implementer'], ['test-reconcile', 'reviewer'], ['test-recheck', 'test_writer']])(
    'supports three protocol recovery actions for %s when independently observed checks improve', (id, role) => {
      const run = state();
      const writerFile = role === 'test_writer' ? 'tests/value.test.js' : 'src/value.js';
      let ticket = issue(run, { id, role }, { claimed_paths: [writerFile],
        ...(role === 'test_writer' ? { test_scope: 'exact' } : {}),
        test_reconciliation: { version: 1, attempt: 1,
        source_ticket_id: 'source', source_stage_id: 'build', report: 'independent contradiction',
        test_paths: ['tests/value.test.js'] } });
      for (let n = 1; n <= 3; n += 1) {
        const readonly = ticket.writable === false;
        if (!readonly) run.tree_sha = tree(n + 1);
        const actions = record(run, ticket, { status: 'failed', changed_files: readonly ? [] : [writerFile],
          findings: readonly ? [] : Array.from({ length: 4 - n }, (_, i) => ({ ...blocker(`protocol-${i}`), file: writerFile,
            ...(role === 'test_writer' ? { remediation: { owner: 'test', test_paths: [writerFile] } } : {}) })),
          tests: readonly ? Array.from({ length: 4 }, (_, i) => ({ command: `node tests/check-${i}.js`,
            passed: i < n - 1, exit_code: i < n - 1 ? 0 : 1, duration_ms: 1 }))
            : [{ command: 'node tests/value.test.js', passed: false, exit_code: 1,
              duration_ms: 1, output_hash: String(n).repeat(64) }],
          evidence: { failure_kind: 'protocol', summary: 'Observed remaining protocol fault' } });
        expect(actions.some((a) => a.type === 'issue_ticket')).toBe(true);
        expect(run.status).toBe('running');
        ticket = run.tickets.at(-1);
        expect(ticket.test_reconciliation.test_paths).toEqual(['tests/value.test.js']);
        expect(ticket.claimed_paths).toEqual([writerFile]);
      }
      expect(run.worker_protocol_redispatches[id]).toBe(3);
    });

  it('permits five deliberate fresh re-gates without weakening the full gate action', () => {
    const run = state({ status: 'blocked', stage: 'gates', regate_attempts: 0 });
    for (let n = 1; n <= 5; n += 1) {
      const actions = apply(run, reduceRun(run, { type: 'REGATE', reason: 'Operator requests a fresh external observation' }));
      expect(actions.some((a) => a.type === 'run_gates')).toBe(true);
      expect(run.regate_attempts).toBe(n);
      apply(run, reduceRun(run, { type: 'GATES_FAILED', gates: { passed: false, tree_sha: run.tree_sha } }));
      expect(run.status).toBe('blocked');
    }
  });

  it.each([['test-reconcile', 'reviewer'], ['test-recheck', 'test_writer']])(
    'permits three evidenced %s attempts while preserving exact reconciliation scope', (id, role) => {
      const run = state({ attempts: { [id]: 1 } });
      const source = issue(run, { id: 'build', role: 'implementer' });
      const context = { version: 1, attempt: 1, source_ticket_id: source.ticket_id,
        source_stage_id: 'build', report: 'A verified contradiction', test_paths: ['tests/value.test.js'] };
      run.test_contradiction_pending = { source_ticket_id: source.ticket_id, context };
      let ticket = issue(run, { id, role }, { claimed_paths: ['tests/value.test.js'],
        test_paths: ['tests/value.test.js'], test_scope: 'exact', test_reconciliation: context });
      for (let attempt = 1; attempt <= 2; attempt += 1) {
        const readonly = ticket.writable === false;
        if (!readonly) run.tree_sha = tree(attempt + 1);
        const actions = record(run, ticket, { status: 'failed', changed_files: readonly ? [] : ['tests/value.test.js'],
          findings: readonly ? [] : Array.from({ length: 3 - attempt }, (_, i) => ({ ...blocker(`test-${i}`),
            file: 'tests/value.test.js', remediation: { owner: 'test', test_paths: ['tests/value.test.js'] } })),
          tests: readonly ? Array.from({ length: 3 }, (_, i) => ({ command: `node tests/check-${i}.js`,
            passed: i < attempt - 1, exit_code: i < attempt - 1 ? 0 : 1, duration_ms: 1 }))
            : [{ command: 'node tests/value.test.js', passed: false, exit_code: 1, duration_ms: 1,
              output_hash: String(attempt).repeat(64) }], evidence: { summary: 'Independently observed partial test repair' } });
        expect(actions.some((a) => a.type === 'issue_ticket')).toBe(true);
        ticket = run.tickets.at(-1);
        expect(ticket.test_reconciliation.test_paths).toEqual(['tests/value.test.js']);
      }
      expect(run.attempts[id]).toBe(3);
      expect(record(run, ticket).some((a) => a.type === 'issue_ticket')).toBe(true);
      expect(run.tickets.at(-1).stage_id).toBe('build');
    });

  it('stops unchanged product failures even if summaries and ticket IDs change', () => {
    let run = state();
    let ticket = issue(run, { id: 'build', role: 'implementer' });
    record(run, ticket, { status: 'failed', findings: [blocker('A')],
      evidence: { summary: 'first diagnosis' } });
    expect(run.status).toBe('running');
    run = JSON.parse(JSON.stringify(run));
    ticket = run.tickets.at(-1);
    expectStopped(run, record(run, ticket, { status: 'failed', findings: [blocker('A')],
      evidence: { summary: 'new words, same unresolved defect' } }));
  });

  it.each([[['A', 'B'], ['B', 'C']], [['A'], ['B']]])(
    'allows mixed resolved/new review findings %j -> %j and eventual completion', (first, second) => {
      const run = state();
      failReview(run, issue(run, { id: 'review', role: 'reviewer', parallel_group: 'code-review' }), first);
      const actions = failReview(run, remediate(run, 2), second);
      expect(run.status).toBe('running');
      const successor = actions.find((a) => a.type === 'issue_ticket');
      expect(successor.review_finding_evidence).toHaveLength(second.length);
      expect(successor.review_findings.join(' ')).toContain(second.at(-1));
      expect(record(run, remediate(run, 3)).some((a) => a.type === 'run_gates')).toBe(true);
    });

  it('continues six mixed remediation cycles after JSON restart', () => {
    let run = state();
    let review = issue(run, { id: 'review', role: 'reviewer', parallel_group: 'code-review' });
    for (let n = 0; n < 6; n += 1) {
      failReview(run, review, [`finding-${n}`, `finding-${n + 1}`]);
      expect(run.status).toBe('running');
      run = JSON.parse(JSON.stringify(run));
      review = remediate(run, n + 2);
    }
    expect(record(run, review).some((a) => a.type === 'run_gates')).toBe(true);
    expect(run.remediation_cycles).toBe(6);
  });

  it('does not count a still-open blocker file edit as repair of a renamed blocker elsewhere', () => {
    let run = state();
    const finding = (id, file) => ({ ...blocker(id), file });
    const first = issue(run, { id: 'review', role: 'reviewer', parallel_group: 'code-review' });
    record(run, first, { evidence: { verdict: 'fail' },
      findings: [finding('A', 'src/a.js'), finding('B', 'src/b.js')] });
    run = JSON.parse(JSON.stringify(run));
    const writer = run.tickets.at(-1);
    writer.claimed_paths = ['src'];
    run.tree_sha = tree(2);
    record(run, writer, { changed_files: ['src/b.js'] });
    expectStopped(run, record(run, run.tickets.at(-1), { evidence: { verdict: 'fail' },
      findings: [finding('renamed-A', 'src/a.js'), finding('B', 'src/b.js')] }));
  });

  it.each(['missing', 'wrong-base', 'wrong-head', 'reverted', 'unrelated-net'])(
    'requires exact retained review diff evidence: %s', (kind) => {
      const run = state();
      failReview(run, issue(run, { id: 'review', role: 'reviewer', parallel_group: 'code-review' }), ['A']);
      const review = remediate(run, 2);
      const netDiff = kind === 'missing' ? null : {
        base_tree_sha: kind === 'wrong-base' ? tree(9) : tree(1),
        head_tree_sha: kind === 'wrong-head' ? tree(9) : run.tree_sha,
        changed_files: kind === 'reverted' ? [] : kind === 'unrelated-net' ? ['README.md'] : ['src/value.js'],
      };
      expectStopped(run, record(run, review, { findings: [blocker('renamed-A')], evidence: { verdict: 'fail' } },
        { review_recovery_diff: netDiff }));
    });

  it('credits both independent writers in the current mixed remediation episode after restart', () => {
    let run = state({ behavioral: true });
    const testFinding = { ...blocker('test-A'), file: 'tests/value.test.js',
      remediation: { owner: 'test', test_paths: ['tests/value.test.js'] } };
    const first = issue(run, { id: 'review', role: 'reviewer', parallel_group: 'code-review' },
      { review_contract_version: 1 });
    record(run, first, { evidence: { verdict: 'fail' }, findings: [testFinding, blocker('B')] });
    const testWriter = run.tickets.at(-1);
    expect(testWriter.stage_id).toBe('remediation-test');
    testWriter.claimed_paths = ['tests/value.test.js'];
    testWriter.test_paths = ['tests/value.test.js'];
    testWriter.test_scope = 'exact';
    run.tree_sha = tree(2);
    record(run, testWriter, { changed_files: ['tests/value.test.js'] });
    expect(run.tickets.at(-1).stage_id).toBe('remediation-build');
    run.tree_sha = tree(3);
    record(run, run.tickets.at(-1), { changed_files: ['src/value.js'] });
    run = JSON.parse(JSON.stringify(run));
    run.tickets.at(-1).review_contract_version = 1;
    failReview(run, run.tickets.at(-1), ['B']);
    expect(run.status).toBe('running');
    expect(run.remediation_cycles).toBe(2);
    // The next episode cannot borrow the prior episode's test repair.
    const review = remediate(run, 3, []);
    expectStopped(run, failReview(run, review, ['C']));
  });

  it.each(['reordered', 'prose-only', 'unrelated-edit', 'cycle', 'missing'])('stops %s recovery evidence', (kind) => {
    let run = state();
    failReview(run, issue(run, { id: 'review', role: 'reviewer', parallel_group: 'code-review' }), ['A', 'B']);
    let review = remediate(run, 2, kind === 'unrelated-edit' ? ['README.md'] : ['src/value.js']);
    if (kind === 'cycle') {
      failReview(run, review, ['B', 'C']);
      expect(run.status).toBe('running');
      run = JSON.parse(JSON.stringify(run));
      review = remediate(run, 3);
    }
    const findings = kind === 'missing' ? [{ blocking: true }] :
      (kind === 'unrelated-edit' ? ['B', 'C'] : ['B', 'A']).map(blocker);
    if (kind === 'prose-only') for (const finding of findings) {
      finding.title += ' reworded'; finding.detail += ' extra explanation'; finding.line += 50;
    }
    expectStopped(run, record(run, review, { findings, evidence: { verdict: 'fail' } }));
  });

  it('does not skip independent security review after a productive recovery', () => {
    const run = state();
    failReview(run, issue(run, { id: 'review', role: 'reviewer', parallel_group: 'code-review' }), ['A']);
    const review = remediate(run, 2);
    run.high_risk = true;
    run.risk_triggers = ['security'];
    const actions = record(run, review);
    expect(actions.some((a) => a.type === 'run_gates')).toBe(false);
    expect(actions).toContainEqual(expect.objectContaining({ type: 'issue_ticket',
      stage: expect.objectContaining({ role: 'security_reviewer' }) }));
  });

  it('does not let claimed progress reopen capability denial or cancellation', () => {
    const run = state();
    const ticket = issue(run, { id: 'build', role: 'implementer' });
    const actions = record(run, ticket, { status: 'failed', changed_files: ['src/value.js'],
      evidence: { failure_kind: 'capability', summary: 'progress', required_claims: { claimed_paths: ['foreign.js'] } } });
    expect(run.status).toBe('blocked');
    expect(actions.some((a) => a.type === 'issue_ticket')).toBe(false);
    expect(reduceRun({ ...run, status: 'aborted' }, { type: 'NEXT' }).some((a) => a.type === 'issue_ticket')).toBe(false);
  });

  it('permits mixed directed replans and detects a reintroduced requirement after restart', () => {
    let run = state({ lane: 'full', candidate_plan: candidate() });
    let judge = issue(run, { id: 'plan-judge', role: 'plan_judge' });
    const repaired = [];
    for (const ids of [['A', 'B'], ['B', 'C'], ['C', 'D'], ['D', 'E']]) {
      const resolved = judge.plan_recovery?.missing_assurances
        .filter((entry) => !ids.includes(entry.requirement_id)).map((entry) => entry.requirement_id);
      const actions = record(run, judge, { evidence: { verdict: 'disagree', missing_assurances: ids.map(assurance),
        ...(resolved ? { plan_resolutions: planResolutions(judge, resolved) } : {}) } });
      expect(run.status).toBe('running');
      expect(actions.some((a) => a.recovery_kind === 'directed_replan')).toBe(true);
      const planner = run.tickets.at(-1);
      repaired.push(ids[0]);
      run.candidate_plan = candidate(repaired);
      record(run, planner, { evidence: { candidate_plan: run.candidate_plan.plan } });
      const [check, critic] = run.tickets.slice(-2);
      record(run, check);
      record(run, critic, { evidence: { verdict: 'disagree' } });
      judge = run.tickets.at(-1);
      expect(judge.stage_id).toBe('plan-judge');
      run = JSON.parse(JSON.stringify(run));
      judge = run.tickets.at(-1);
    }
    expect(run.plan_replan_cycles).toBe(4);
    expectStopped(run, record(run, judge, { evidence: { verdict: 'disagree',
      missing_assurances: ['A', 'B'].map(assurance) } }));
  });

  it('accepts an independently resolved substantive rewrite without requirement IDs in plan prose', () => {
    let run = state({ lane: 'full', candidate_plan: candidate() });
    record(run, issue(run, { id: 'plan-judge', role: 'plan_judge' }), {
      evidence: { verdict: 'disagree', missing_assurances: ['A', 'B'].map(assurance) } });
    run = JSON.parse(JSON.stringify(run));
    run.candidate_plan = candidate(['A']);
    const judge = issue(run, { id: 'plan-judge', role: 'plan_judge' });
    const actions = record(run, judge, { evidence: { verdict: 'disagree', missing_assurances: ['B'].map(assurance),
      plan_resolutions: planResolutions(judge, ['A']) } });
    expect(run.status).toBe('running');
    expect(run.plan_replan_cycles).toBe(2);
    expect(actions.some((entry) => entry.recovery_kind === 'directed_replan')).toBe(true);
  });

  it.each(['risk-tag', 'fallback-anchor'])(
    'does not let %s drift credit a still-open plan blocker for an unrelated renamed blocker', (kind) => {
      const stillOpen = () => kind === 'fallback-anchor'
        ? { requirement_id: 'A', summary: 'Missing assurance for A' }
        : assurance('A');
      let run = state({ lane: 'full', candidate_plan: candidate() });
      record(run, issue(run, { id: 'plan-judge', role: 'plan_judge' }), {
        evidence: { verdict: 'disagree', missing_assurances: [stillOpen(), assurance('B')] } });
      run = JSON.parse(JSON.stringify(run));
      // Only A's coverage changes. The next judge still reports A, while B's
      // unchanged coverage receives a fresh anchor to manufacture retirement.
      run.candidate_plan = candidate(['A']);
      const judge = issue(run, { id: 'plan-judge', role: 'plan_judge' });
      expectStopped(run, record(run, judge, { evidence: { verdict: 'disagree',
        missing_assurances: [{ ...stillOpen(), ...(kind === 'risk-tag' ? { risk_trigger: 'concurrency' } : {}) },
          { ...assurance('B'), evidence_anchor: 'requirements.B.renamed' }],
        plan_resolutions: planResolutions(judge, ['A']),
      } }));
      expect(run.plan_replan_cycles).toBe(1);
    });

  it.each(['whitespace', 'duplicate', 'unrelated-anchors', 'stale-plan', 'stale-blocker', 'stale-context',
    'still-unresolved', 'changed-requirement', 'wrong-judge-role', 'missing-resolution'])(
    'does not authorize another replan from %s resolution evidence', (kind) => {
      const run = state({ lane: 'full', candidate_plan: candidate() });
      record(run, issue(run, { id: 'plan-judge', role: 'plan_judge' }), {
        evidence: { verdict: 'disagree', missing_assurances: ['A', 'B'].map(assurance) } });
      const plan = structuredClone(candidate(['A']).plan);
      if (kind === 'whitespace' || kind === 'duplicate') {
        const original = candidate().plan.workstreams[0];
        for (const field of ['steps', 'acceptance']) plan.workstreams[0][field] = kind === 'whitespace'
          ? original[field].map((text) => `  ${text.replaceAll(' ', '\n  ')} `)
          : [...original[field], ...original[field]];
      }
      if (kind === 'changed-requirement') plan.requirements[0].requirement = 'Return success without durability';
      run.candidate_plan = CandidatePlanSchema.parse({ plan_hash: sha256(plan), plan });
      const judge = issue(run, { id: 'plan-judge', role: 'plan_judge' });
      const proof = planResolutions(judge, ['A']);
      if (kind === 'unrelated-anchors') proof.resolved[0].implementation_anchors[0].workstream_id = 'W_E';
      if (kind === 'stale-plan') proof.previous_plan_hash = 'b'.repeat(64);
      if (kind === 'stale-blocker') proof.resolved[0].prior_assurance_id = 'pa-0000000000000000';
      if (kind === 'stale-context') judge.plan_recovery_context.source_ticket_hash = 'b'.repeat(64);
      if (kind === 'wrong-judge-role') judge.role = 'planner';
      expectStopped(run, record(run, judge, { evidence: { verdict: 'disagree',
        missing_assurances: (kind === 'still-unresolved' ? ['A', 'B'] : ['B', 'C']).map(assurance),
        ...(kind !== 'missing-resolution' ? { plan_resolutions: proof } : {}) } }));
    });

  it.each(['unchanged', 'cosmetic', 'outcome-prose', 'step-prose', 'acceptance-prose', 'assurance-prose', 'unrelated-requirement'])('does not treat %s plan material as progress when blocker labels change', (kind) => {
    const initial = candidate();
    if (kind === 'assurance-prose') {
      initial.plan.assurances = [{ id: 'A_security', risk_trigger: 'security',
        threat_model: 'Untrusted values reach the value function', feasibility: 'Validate inputs',
        failure_modes: ['Invalid inputs accepted'], crash_recovery: 'Reload saved state',
        migration: 'Preserve old callers', determinism: 'Identical inputs yield identical output',
        executable_tests: ['node tests/value.test.js'] }];
      initial.plan_hash = sha256(initial.plan);
    }
    const run = state({ lane: 'full', candidate_plan: CandidatePlanSchema.parse(initial) });
    const first = issue(run, { id: 'plan-judge', role: 'plan_judge' });
    record(run, first, { evidence: { verdict: 'disagree', missing_assurances: ['A', 'B'].map(assurance) } });
    expect(run.status).toBe('running');
    if (kind !== 'unchanged') {
      const plan = structuredClone(run.candidate_plan.plan);
      if (kind === 'cosmetic') plan.non_goals = ['A differently worded administrative note'];
      if (kind === 'outcome-prose') plan.workstreams[0].outcome = 'Correct the scoped value implementation';
      if (kind === 'step-prose') plan.workstreams[0].steps[0] = 'Examine the scoped implementation';
      if (kind === 'acceptance-prose') plan.workstreams[0].acceptance[0] = 'Check the scoped behavior';
      if (kind === 'assurance-prose') plan.assurances[0].feasibility = 'Check inputs';
      if (kind === 'unrelated-requirement') {
        plan.workstreams[4].steps.push('Repair the unrelated cache behavior');
        plan.workstreams[4].acceptance.push('Verify the unrelated cache regression');
      }
      run.candidate_plan = CandidatePlanSchema.parse({ plan_hash: sha256(plan), plan });
    }
    const judge = issue(run, { id: 'plan-judge', role: 'plan_judge' });
    expectStopped(run, record(run, judge, { evidence: { verdict: 'disagree',
      missing_assurances: ['B', 'C'].map(assurance) } }));
  });
});
