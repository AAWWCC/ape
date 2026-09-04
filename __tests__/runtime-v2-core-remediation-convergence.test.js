import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { reduceRun } from '../lib/runtime/scheduler.js';
import { SCHEMA_VERSION } from '../lib/runtime/constants.js';
import {
  finalizeReceipt,
  finalizeTicket,
  validateReceipt,
  validateTicket,
} from '../lib/runtime/schemas.js';

// F1/F25: drive the pure reducer through the full remediation lifecycle the way
// service.applyActions would, asserting the run converges instead of looping or
// wedging after a review disagreement.

let ticketCounter = 0;

function baseRun(overrides = {}) {
  return {
    run_id: 'run-1',
    mode: 'phase',
    lane: 'fast',
    status: 'running',
    stage: 'dispatch',
    high_risk: false,
    tickets: [],
    receipts: [],
    attempts: {},
    remediation_cycles: 0,
    ...overrides,
  };
}

function issue(state, stage) {
  const ticket = {
    ticket_id: `ticket-${(ticketCounter += 1)}`,
    stage_id: stage.id,
    role: stage.role,
    parallel_group: stage.parallel_group ?? null,
  };
  state.tickets.push(ticket);
  state.stage = stage.id;
  return ticket;
}

// Record a receipt and apply the reducer's transition/issue_ticket effects in
// order, mirroring service.applyActions.
function record(state, ticket, overrides = {}) {
  const receipt = {
    ticket_id: ticket.ticket_id,
    status: 'passed',
    evidence: { verdict: 'agree' },
    ...overrides,
  };
  state.receipts.push(receipt);
  const actions = reduceRun(state, {
    type: 'RECEIPT_RECORDED',
    ticket,
    receipt,
    stage: { id: ticket.stage_id, role: ticket.role, parallel_group: ticket.parallel_group },
    next_state: state,
  });
  for (const action of actions) {
    if (action.type === 'transition') Object.assign(state, action.patch);
    if (action.type === 'issue_ticket') issue(state, action.stage);
  }
  return actions;
}

function blocker(file, title) {
  return {
    file,
    line: 1,
    title,
    detail: `${title} must be remediated`,
    blocking: true,
    remediation: { owner: 'production' },
  };
}

function walkToReview(state) {
  const testTicket = issue(state, { id: 'test', role: 'test_writer' });
  record(state, testTicket);
  const buildTicket = state.tickets.at(-1);
  expect(buildTicket.stage_id).toBe('build');
  record(state, buildTicket);
  const reviewTicket = state.tickets.at(-1);
  expect(reviewTicket.stage_id).toBe('review');
  expect(reviewTicket.parallel_group).toBe('code-review');
  return reviewTicket;
}

describe('APE v2 remediation convergence (F1)', () => {
  it('charges the remediation budget on a verdict disagreement and reaches gates when the remediation review agrees', () => {
    const state = baseRun();
    const reviewTicket = walkToReview(state);

    const disagreed = record(state, reviewTicket, { evidence: { verdict: 'disagree' } });
    expect(state.remediation_cycles).toBe(1);
    expect(disagreed.some((action) => action.type === 'issue_ticket'
      && action.stage.id === 'remediation-build')).toBe(true);

    const remediationBuild = state.tickets.at(-1);
    expect(remediationBuild.stage_id).toBe('remediation-build');
    record(state, remediationBuild);
    const remediationReview = state.tickets.at(-1);
    expect(remediationReview.stage_id).toBe('remediation-review');

    const agreed = record(state, remediationReview, { evidence: { verdict: 'agree' } });
    expect(agreed.some((action) => action.type === 'run_gates')).toBe(true);
    expect(state.remediation_cycles).toBe(1);
    expect(state.status).toBe('running');
  });

  it('continues only when blocking findings are a strict proper subset, then stops repetition', () => {
    const state = baseRun();
    const reviewTicket = walkToReview(state);
    record(state, reviewTicket, {
      evidence: { verdict: 'disagree' },
      findings: [
        blocker('src/value.js', 'Value defect'),
        blocker('src/lock.js', 'Crash recovery defect'),
      ],
    });
    const remediationBuild = state.tickets.at(-1);
    record(state, remediationBuild);
    const remediationReview = state.tickets.at(-1);

    const continued = record(state, remediationReview, {
      evidence: { verdict: 'disagree' },
      findings: [blocker('src/lock.js', 'Crash recovery defect')],
    });
    expect(continued.some((action) => action.type === 'issue_ticket'
      && action.stage.id === 'remediation-build')).toBe(true);
    expect(state.status).toBe('running');
    expect(state.remediation_cycles).toBe(2);

    const secondBuild = state.tickets.at(-1);
    record(state, secondBuild);
    const secondReview = state.tickets.at(-1);
    const blocked = record(state, secondReview, {
      evidence: { verdict: 'disagree' },
      findings: [blocker('src/lock.js', 'Crash recovery defect')],
    });
    expect(blocked.some((action) => action.type === 'issue_ticket')).toBe(false);
    expect(state.status).toBe('blocked');
    expect(state.block_reason).toMatch(/repeated.*remediation/i);
    expect(blocked.some((action) => action.type === 'release_lock')).toBe(true);
  });

  it('terminates when remediation swaps one blocker for a new blocker', () => {
    const state = baseRun();
    const reviewTicket = walkToReview(state);
    record(state, reviewTicket, {
      evidence: { verdict: 'disagree' },
      findings: [
        blocker('src/value.js', 'Value defect'),
        blocker('src/lock.js', 'Crash recovery defect'),
      ],
    });
    record(state, state.tickets.at(-1));

    const actions = record(state, state.tickets.at(-1), {
      evidence: { verdict: 'disagree' },
      findings: [
        blocker('src/lock.js', 'Crash recovery defect'),
        blocker('src/new.js', 'New defect'),
      ],
    });

    expect(actions.some((action) => action.type === 'issue_ticket')).toBe(false);
    expect(state).toMatchObject({
      status: 'blocked',
      stage: 'remediation',
    });
    expect(state.block_reason).toMatch(/strict|progress|expanded|incomparable/i);
  });

  it('deduplicates blocking-finding identities before measuring strict progress', () => {
    const state = baseRun();
    const reviewTicket = walkToReview(state);
    const remaining = blocker('src/lock.js', 'Crash recovery defect');
    record(state, reviewTicket, {
      evidence: { verdict: 'disagree' },
      findings: [
        blocker('src/value.js', 'Value defect'),
        remaining,
        blocker('src/cache.js', 'Cache defect'),
      ],
    });
    record(state, state.tickets.at(-1));

    const actions = record(state, state.tickets.at(-1), {
      evidence: { verdict: 'disagree' },
      findings: [remaining, { ...remaining }],
    });
    expect(actions.some((action) => action.type === 'issue_ticket'
      && action.stage.id === 'remediation-build')).toBe(true);
    expect(state).toMatchObject({ status: 'running', remediation_cycles: 2 });
  });

  it.each([
    ['reordered equality', (prior) => [...prior].reverse()],
    ['empty findings', () => []],
    ['malformed findings', () => [{ blocking: true }]],
  ])('terminates on %s rather than fabricating remediation progress', (_label, nextFor) => {
    const state = baseRun();
    const reviewTicket = walkToReview(state);
    const prior = [
      blocker('src/value.js', 'Value defect'),
      blocker('src/lock.js', 'Crash recovery defect'),
    ];
    record(state, reviewTicket, {
      evidence: { verdict: 'disagree' },
      findings: prior,
    });
    record(state, state.tickets.at(-1));

    const actions = record(state, state.tickets.at(-1), {
      evidence: { verdict: 'disagree' },
      findings: nextFor(prior),
    });
    expect(actions.some((action) => action.type === 'issue_ticket')).toBe(false);
    expect(state).toMatchObject({ status: 'blocked', stage: 'remediation' });
  });

  it('honors a configured remediation-cycle budget even when the next blocker is distinct', () => {
    const state = baseRun({ policy: { max_remediation_cycles: 1 } });
    const reviewTicket = walkToReview(state);
    record(state, reviewTicket, {
      evidence: { verdict: 'disagree' },
      findings: [blocker('src/value.js', 'Initial defect')],
    });
    record(state, state.tickets.at(-1));
    const blocked = record(state, state.tickets.at(-1), {
      evidence: { verdict: 'disagree' },
      findings: [blocker('src/other.js', 'Distinct late defect')],
    });
    expect(blocked.some((action) => action.type === 'issue_ticket')).toBe(false);
    expect(state.status).toBe('blocked');
    expect(state.block_reason).toMatch(/configured remediation budget \(1 cycles\)/);
  });

  // friction #23: the retry-then-remediate sequencing this test used to pin was
  // intentionally removed — a failed review is a verdict on the work, so it
  // routes straight to remediation with no verbatim retry.
  it('a review that fails with findings routes straight to remediation with no verbatim retry (friction #23)', () => {
    const state = baseRun();
    const reviewTicket = walkToReview(state);

    const failed = record(state, reviewTicket, { status: 'failed', evidence: {} });
    expect(failed.some((action) => action.type === 'issue_ticket'
      && action.stage.id === 'review')).toBe(false);
    expect(state.remediation_cycles).toBe(1);
    expect(state.attempts.review).toBeUndefined();
    const remediationBuild = state.tickets.at(-1);
    expect(remediationBuild.stage_id).toBe('remediation-build');
    record(state, remediationBuild);
    const remediationReview = state.tickets.at(-1);
    expect(remediationReview.stage_id).toBe('remediation-review');

    // A failed remediation-review is also a disagree vote: the single
    // remediation cycle is spent, so the run blocks immediately instead of
    // blocking as 'failed twice' after a futile retry.
    const blocked = record(state, remediationReview, { status: 'failed', evidence: {} });
    expect(blocked.some((action) => action.type === 'issue_ticket')).toBe(false);
    expect(state.status).toBe('blocked');
    expect(state.block_reason).toMatch(/repeated.*remediation|remediation cycle/i);
  });

  // friction #23: behavior change is the point — a single failed review record now
  // reaches remediation directly; the old second failure/retry ticket is gone.
  it('remediation receipts supersede a failed review so an agreeing remediation review reaches gates', () => {
    const state = baseRun();
    const reviewTicket = walkToReview(state);
    record(state, reviewTicket, { status: 'failed', evidence: {} });
    const remediationBuild = state.tickets.at(-1);
    expect(remediationBuild.stage_id).toBe('remediation-build');
    record(state, remediationBuild);
    const remediationReview = state.tickets.at(-1);

    const agreed = record(state, remediationReview, { evidence: { verdict: 'agree' } });
    expect(agreed.some((action) => action.type === 'run_gates')).toBe(true);
    expect(state.status).toBe('running');
  });

  it('supersedes both review and security-review receipts on a high-risk run', () => {
    const state = baseRun({ lane: 'full', high_risk: true });
    const buildTicket = issue(state, { id: 'build', role: 'implementer' });
    record(state, buildTicket);
    const [review, securityReview] = state.tickets.slice(-2);
    expect(review.stage_id).toBe('review');
    expect(securityReview.stage_id).toBe('security-review');

    record(state, review, { evidence: { verdict: 'agree' } });
    record(state, securityReview, { evidence: { verdict: 'disagree' } });
    expect(state.remediation_cycles).toBe(1);
    const remediationBuild = state.tickets.at(-1);
    expect(remediationBuild.stage_id).toBe('remediation-build');
    record(state, remediationBuild);

    const [remediationReview, remediationSecurity] = state.tickets.slice(-2);
    expect(remediationReview.stage_id).toBe('remediation-review');
    expect(remediationSecurity.stage_id).toBe('remediation-security-review');
    record(state, remediationReview, { evidence: { verdict: 'agree' } });
    const agreed = record(state, remediationSecurity, { evidence: { verdict: 'agree' } });
    expect(agreed.some((action) => action.type === 'run_gates')).toBe(true);
    expect(state.status).toBe('running');
  });
});

describe('APE v2 phantom verify stage removal (F27)', () => {
  it('NEXT on a run parked at a verify stage reports status instead of re-running gates', () => {
    const state = baseRun({ stage: 'verify' });
    const actions = reduceRun(state, { type: 'NEXT', at: new Date().toISOString() });
    expect(actions.map((action) => action.type)).toEqual(['status']);
  });
});

describe('APE v2 legacy receipt-contract byte stability', () => {
  it('validates an already-materialized legacy ticket and receipt without adding recovery defaults', () => {
    const ticket = finalizeTicket({
      schema_version: SCHEMA_VERSION,
      ticket_id: 'ticket-legacy-byte-stable',
      run_id: 'run-legacy-byte-stable',
      stage_id: 'build',
      parallel_group: null,
      role: 'implementer',
      objective: 'Preserve an already-valid legacy artifact byte for byte',
      claimed_paths: ['src/value.js'],
      test_paths: ['tests/value.test.js'],
      model_tier: 'balanced',
      model: { model: 'legacy-model' },
      deadline_at: '2026-09-03T04:30:00.000Z',
      output_schema: {},
      required_checks: ['targeted-tests'],
      parent_hash: null,
      base_tree_sha: 'a'.repeat(40),
      attempt: 1,
      writable: true,
      issued_at: '2026-09-03T04:00:00.000Z',
    });
    const receipt = finalizeReceipt({
      schema_version: SCHEMA_VERSION,
      receipt_id: 'receipt-legacy-byte-stable',
      run_id: ticket.run_id,
      ticket_id: ticket.ticket_id,
      ticket_hash: ticket.ticket_hash,
      agent: {
        host: 'codex',
        role: ticket.role,
        identity: 'legacy-worker',
        model: null,
      },
      status: 'passed',
      base_tree_sha: ticket.base_tree_sha,
      head_tree_sha: 'b'.repeat(40),
      changed_files: ['src/value.js'],
      tests: [{ command: 'npm test', passed: true, exit_code: 0, duration_ms: 1 }],
      findings: [],
      evidence: { verdict: 'pass' },
      timing: {
        started_at: ticket.issued_at,
        completed_at: '2026-09-03T04:00:01.000Z',
        duration_ms: 1_000,
      },
      previous_receipt_hash: null,
    });
    const ticketBytes = JSON.stringify(ticket);
    const receiptBytes = JSON.stringify(receipt);

    const ticketValidation = validateTicket(JSON.parse(ticketBytes));
    const receiptValidation = validateReceipt(JSON.parse(receiptBytes));
    expect(ticketValidation).toMatchObject({ valid: true });
    expect(receiptValidation).toMatchObject({ valid: true });
    expect(JSON.stringify(ticketValidation.value)).toBe(ticketBytes);
    expect(JSON.stringify(receiptValidation.value)).toBe(receiptBytes);

    for (const artifact of [ticketValidation.value, receiptValidation.value]) {
      expect(artifact).not.toHaveProperty('recovery_generation');
      expect(artifact).not.toHaveProperty('recovery_lineage');
      expect(artifact).not.toHaveProperty('validation_submissions');
      expect(artifact).not.toHaveProperty('physical_workers');
    }
    expect(ticketValidation.value).not.toHaveProperty('receipt_contract_version');
    expect(ticketValidation.value).not.toHaveProperty('capability_manifest');
  });
});

describe('APE v2 retained-selector public documentation', () => {
  it('documents invalid selector slots as retained semantic evidence rather than moved quarantine state', () => {
    const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
    const documents = [
      'docs/invariants.md',
      'docs/operational-readiness.md',
      'docs/pipeline.md',
    ].map((relative) => readFileSync(path.join(root, relative), 'utf8'));
    const publicContract = documents.join('\n');

    expect(publicContract).toMatch(/semantic evidence/i);
    expect(publicContract).toMatch(/invalid selector[\s\S]{0,800}(?:retained|remain(?:s)? in place)/i);
    expect(publicContract).toMatch(/(?:pathname|slot).*?(?:identity|device|inode)/is);
    expect(publicContract).toMatch(/raw bytes|byte hash/i);
    expect(publicContract).toMatch(/lineage/i);
    expect(publicContract).toMatch(/(?:rebound|changed).*?(?:rescan|scan again)/is);
    expect(publicContract).toMatch(/(?:selector|head).*?(?:source of truth|authoritative)/is);
    expect(publicContract).toMatch(/collision|non-clobber/i);
    for (const document of documents) {
      expect(document).not.toMatch(
        /\bmove(?:d|s)?\b[^.\n]{0,120}\b(?:selector|slot|identity)\b|\b(?:selector|slot|identity)\b[^.\n]{0,120}\bmove(?:d|s)?\b/i,
      );
    }
  });
});
