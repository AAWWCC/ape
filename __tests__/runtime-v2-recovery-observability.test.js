import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { archiveRun, calculateProjectMetrics } from '../lib/runtime/history.js';
import {
  emptyOrchestrationTelemetry,
  FAILURE_DOMAINS,
  FAILURE_DOMAIN_TAXONOMY_VERSION,
  recordAcceptedReceipt,
  recordDispatchTokenCoverage,
  recordReceiptContractExhaustion,
} from '../lib/runtime/orchestration-telemetry.js';
import { runtimePaths } from '../lib/runtime/paths.js';
import {
  NEXT_ACTION_KINDS,
  projectRunResponse,
  RESPONSE_BUDGET_BYTES,
  RESPONSE_BUDGET_CHARS,
} from '../lib/runtime/projection.js';
import { reduceRun } from '../lib/runtime/scheduler.js';

const cleanups = [];
afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

function stageTicket(ticketId, stageId, role, parallelGroup = null) {
  return {
    ticket_id: ticketId,
    stage_id: stageId,
    role,
    parallel_group: parallelGroup,
    model_tier: 'deep',
    writable: false,
    required_checks: [],
    output_schema: {},
  };
}

function runState(tickets) {
  return {
    run_id: 'run-protocol-routing',
    mode: 'phase',
    lane: 'full',
    status: 'running',
    stage: 'plan-check',
    tickets,
    receipts: [],
    attempts: {},
    remediation_cycles: 0,
    orchestration: emptyOrchestrationTelemetry(),
  };
}

function record(state, ticket, receipt) {
  state.receipts.push(receipt);
  return reduceRun(state, {
    type: 'RECEIPT_RECORDED',
    ticket,
    receipt,
    stage: {
      id: ticket.stage_id,
      role: ticket.role,
      parallel_group: ticket.parallel_group,
    },
    next_state: state,
  });
}

describe('typed worker-failure recovery', () => {
  it('keeps command-shape failure out of plan voting, then blocks stably after one same-contract reissue', () => {
    const check = stageTicket('ticket-check-1', 'plan-check', 'plan_checker', 'plan-review');
    const critic = stageTicket('ticket-critic-1', 'plan-critic', 'plan_critic', 'plan-review');
    const state = runState([check, critic]);
    const commandShape = {
      receipt_id: 'receipt-check-1',
      ticket_id: check.ticket_id,
      status: 'failed',
      evidence: { failure_kind: 'command-shape', verdict: 'disagree' },
    };
    expect(record(state, check, commandShape).map((entry) => entry.type)).toEqual(['persist_state']);

    const actions = record(state, critic, {
      receipt_id: 'receipt-critic-1',
      ticket_id: critic.ticket_id,
      status: 'passed',
      evidence: { verdict: 'agree' },
    });
    expect(actions.some((entry) => entry.stage?.id === 'plan-judge')).toBe(false);
    expect(actions.some((entry) => entry.stage?.id === 'plan-replan')).toBe(false);
    expect(actions.find((entry) => entry.type === 'issue_ticket')).toMatchObject({
      stage: { id: 'plan-check' },
      recovery_kind: 'reissue_same_contract',
      source_ticket_id: check.ticket_id,
      failure_domain: 'orchestration',
    });
    expect(actions.find((entry) => entry.type === 'issue_ticket')).not.toHaveProperty('retry_of');
    expect(actions[0].patch.worker_protocol_redispatches).toEqual({ 'plan-check': 1 });
    expect(actions[0].patch.orchestration.protocol_redispatches).toBe(1);
    expect(state.attempts['plan-check']).toBeUndefined();

    Object.assign(state, actions[0].patch);
    const replacement = stageTicket(
      'ticket-check-2',
      'plan-check',
      'plan_checker',
      'plan-review',
    );
    state.tickets.push(replacement);
    const terminal = record(state, replacement, {
      receipt_id: 'receipt-check-2',
      ticket_id: replacement.ticket_id,
      status: 'failed',
      evidence: { failure_kind: 'command-shape' },
    });
    const patch = terminal.find((entry) => entry.type === 'transition').patch;
    expect(patch).toMatchObject({
      status: 'blocked',
      stage: 'plan-check',
      terminal_reason_code: 'worker_protocol_failure',
      failure_domain: 'orchestration',
      failure_domain_taxonomy_version: FAILURE_DOMAIN_TAXONOMY_VERSION,
    });
    expect(terminal.some((entry) => entry.type === 'issue_ticket')).toBe(false);
    expect(terminal.some((entry) => entry.type === 'archive_history')).toBe(true);
    expect(patch).not.toHaveProperty('blocked_recovery');
  });

  it('keeps infrastructure failure out of product remediation', () => {
    const reviewer = stageTicket('ticket-review', 'review', 'reviewer', 'code-review');
    const security = stageTicket(
      'ticket-security',
      'security-review',
      'security_reviewer',
      'code-review',
    );
    const state = runState([reviewer, security]);
    state.stage = 'review';
    record(state, reviewer, {
      receipt_id: 'receipt-review',
      ticket_id: reviewer.ticket_id,
      status: 'failed',
      evidence: { failure_kind: 'infrastructure', verdict: 'disagree' },
    });
    const actions = record(state, security, {
      receipt_id: 'receipt-security',
      ticket_id: security.ticket_id,
      status: 'passed',
      evidence: { verdict: 'agree' },
    });
    expect(actions.find((entry) => entry.type === 'issue_ticket')).toMatchObject({
      stage: { id: 'review' },
      recovery_kind: 'reissue_same_contract',
      failure_domain: 'infrastructure',
    });
    expect(actions.some((entry) => entry.stage?.id === 'remediation-build')).toBe(false);
    expect(state.remediation_cycles).toBe(0);
  });
});

function archivedState(runId, status, orchestration, overrides = {}) {
  return {
    run_id: runId,
    objective: 'Measure bounded orchestration overhead',
    mode: 'phase',
    lane: 'full',
    requirements: ['R1'],
    status,
    stage: status === 'completed' ? 'complete' : 'review',
    created_at: '2026-08-29T00:00:00.000Z',
    updated_at: '2026-08-29T00:01:00.000Z',
    terminal_at: '2026-08-29T00:01:00.000Z',
    base_commit_sha: 'a'.repeat(40),
    tree_sha: 'b'.repeat(40),
    tickets: [],
    receipts: [],
    orchestration,
    ...overrides,
  };
}

describe('bounded orchestration history metrics', () => {
  it('measures first-pass acceptance and host-attested token coverage without estimation', async () => {
    expect(FAILURE_DOMAINS).toEqual([
      'product',
      'orchestration',
      'configuration',
      'infrastructure',
      'operator',
      'unknown',
    ]);
    const dir = await mkdtemp(path.join(tmpdir(), 'ape-orchestration-metrics-'));
    cleanups.push(dir);
    const paths = runtimePaths(dir);

    let first = emptyOrchestrationTelemetry();
    first = recordAcceptedReceipt(first, { validation_attempt: 1 });
    first = recordAcceptedReceipt(first, { validation_attempt: 1 });
    first = recordDispatchTokenCoverage(first, {
      host_attested: true,
      input_tokens: 10,
      output_tokens: 5,
      total_tokens: 15,
    });
    const completed = await archiveRun(paths, archivedState(
      'run-metrics-complete',
      'completed',
      first,
      {
        // A stale/forged failure label must never turn success into a seventh
        // failure-domain outcome.
        failure_domain: 'product',
        failure_domain_taxonomy_version: FAILURE_DOMAIN_TAXONOMY_VERSION,
      },
    ));
    expect(completed).not.toHaveProperty('failure_domain');

    let second = emptyOrchestrationTelemetry();
    second = recordReceiptContractExhaustion(second, {
      validation_attempts: 3,
      redispatched: true,
      at: '2026-08-29T00:00:00.000Z',
    });
    second = recordAcceptedReceipt(second, {
      validation_attempt: 1,
      accepted_at: '2026-08-29T00:00:00.025Z',
    });
    second = recordDispatchTokenCoverage(second, null);
    const blocked = await archiveRun(paths, archivedState(
      'run-metrics-blocked',
      'blocked',
      second,
      {
        terminal_reason_code: 'worker_protocol_failure',
        block_reason: 'stage review worker protocol failed after its single same-contract redispatch',
        failure_domain: 'infrastructure',
        failure_domain_taxonomy_version: FAILURE_DOMAIN_TAXONOMY_VERSION,
      },
    ));
    expect(blocked.failure_domain).toBe('infrastructure');

    let exhaustedOnly = emptyOrchestrationTelemetry();
    exhaustedOnly = recordReceiptContractExhaustion(exhaustedOnly, {
      validation_attempts: 3,
      redispatched: false,
      at: '2026-08-29T00:00:00.000Z',
    });
    await archiveRun(paths, archivedState(
      'run-metrics-no-accepted-receipt',
      'blocked',
      exhaustedOnly,
      {
        terminal_reason_code: 'worker_protocol_failure',
        block_reason: 'both physical workers failed the receipt contract',
        failure_domain: 'orchestration',
        failure_domain_taxonomy_version: FAILURE_DOMAIN_TAXONOMY_VERSION,
      },
    ));

    const metrics = await calculateProjectMetrics(paths);
    expect(metrics.failure_domain_counts.infrastructure).toBe(1);
    expect(metrics.failure_domain_counts.orchestration).toBe(1);
    expect(metrics.failure_domain_coverage).toMatchObject({
      eligible_terminal_failures: 2,
      not_applicable_completed_runs: 1,
      persisted_runs: 2,
    });
    expect(metrics.orchestration.first_pass_receipts).toEqual({
      accepted: 2,
      eligible: 3,
      rate: 2 / 3,
    });
    expect(metrics.orchestration.first_pass_perfect_runs).toEqual({
      perfect: 1,
      eligible: 3,
      rate: 1 / 3,
    });
    expect(metrics.orchestration.receipt_rejections_by_class.contract).toBe(6);
    expect(metrics.orchestration.correction_wall_ms).toBe(25);
    expect(metrics.orchestration.tokens).toMatchObject({
      dispatches: 2,
      attested_dispatches: 1,
      observed_dispatches: 1,
      unobserved_dispatches: 1,
      coverage_rate: 0.5,
      input_tokens: 10,
      output_tokens: 5,
      total_tokens: 15,
      estimated_tokens: null,
    });
  });
});

describe('typed and hard-bounded response projection', () => {
  it('maps recovery metadata to the locked next_action vocabulary', () => {
    expect(NEXT_ACTION_KINDS).toEqual([
      'continue_same_agent',
      'redispatch_same_ticket',
      'stage_retry',
      'directed_replan',
      'remediate_product_finding',
      'wait',
      'answer_preflight',
      'extend_budget',
      'blocked',
    ]);
    const ticket = stageTicket('ticket-retry', 'plan-check', 'plan_checker', 'plan-review');
    const projected = projectRunResponse({
      ok: true,
      run: { run_id: 'run-next-action', status: 'running', tickets: [ticket], receipts: [] },
      actions: [{
        type: 'dispatch_agent',
        recovery_kind: 'reissue_same_contract',
        ticket,
        dispatch: { host: 'codex', ticket: ticket },
      }],
    });
    expect(projected.next_action).toEqual({
      kind: 'stage_retry',
      recovery_kind: 'reissue_same_contract',
      ticket_ids: ['ticket-retry'],
      consumes_product_attempt: false,
      failure_domain: 'orchestration',
    });

    const budget = projectRunResponse({
      ok: true,
      run: {
        run_id: 'run-budget',
        status: 'input_required',
        input_required: { kind: 'execution_budget' },
      },
    });
    expect(budget.next_action).toEqual({ kind: 'extend_budget' });

    const capability = projectRunResponse({
      ok: true,
      run: {
        run_id: 'run-capability',
        status: 'blocked',
        stage: 'build',
        terminal_reason_code: 'capability_blocked',
        failure_domain: 'configuration',
        failure_domain_taxonomy_version: FAILURE_DOMAIN_TAXONOMY_VERSION,
      },
    });
    expect(capability.next_action).toEqual({
      kind: 'blocked',
      terminal_reason_code: 'capability_blocked',
      failure_domain: 'configuration',
      automatic_successor: false,
      required_operator_action: 'update_configuration_or_start_authorized_run',
    });

    const completed = projectRunResponse({
      ok: true,
      run: {
        run_id: 'run-completed',
        status: 'completed',
        failure_domain: 'product',
        failure_domain_taxonomy_version: FAILURE_DOMAIN_TAXONOMY_VERSION,
      },
    });
    expect(completed.run).not.toHaveProperty('failure_domain');
    expect(completed).not.toHaveProperty('next_action');

    const bounded = projectRunResponse({
      ok: true,
      next_action: {
        kind: 'wait',
        ticket_ids: Array.from({ length: 100 }, (_, index) => `ticket-${index}`),
        untrusted_extra: 'x'.repeat(RESPONSE_BUDGET_BYTES * 2),
      },
    });
    expect(bounded.next_action.ticket_ids).toHaveLength(16);
    expect(bounded.next_action).not.toHaveProperty('untrusted_extra');
    expect(Buffer.byteLength(JSON.stringify(bounded), 'utf8')).toBeLessThanOrEqual(
      RESPONSE_BUDGET_BYTES,
    );
  });

  it('enforces the budget in UTF-8 bytes and falls back to authoritative references', () => {
    const objective = '🚨'.repeat(13_000);
    const response = {
      ok: true,
      active: true,
      run: {
        run_id: 'run-utf8-bound',
        status: 'running',
        stage: 'dispatch',
        objective,
        tickets: [],
        receipts: [],
      },
    };
    expect(JSON.stringify(response).length).toBeLessThan(RESPONSE_BUDGET_CHARS);
    expect(Buffer.byteLength(JSON.stringify(response), 'utf8')).toBeGreaterThan(RESPONSE_BUDGET_BYTES);

    const projected = projectRunResponse(response);
    expect(Buffer.byteLength(JSON.stringify(projected), 'utf8')).toBeLessThanOrEqual(
      RESPONSE_BUDGET_BYTES,
    );
    expect(projected.projection).toMatchObject({
      kind: 'reference-only-v1',
      budget_utf8_bytes: RESPONSE_BUDGET_BYTES,
      authoritative_ref: '.ape/runtime/active.json',
    });
    expect(projected.run).toMatchObject({
      run_id: 'run-utf8-bound',
      run_ref: '.ape/runtime/active.json',
    });
    expect(projected.run).not.toHaveProperty('objective');
    expect(response.run.objective).toBe(objective);
  });
});
