import { describe, expect, it } from 'vitest';
import { reduceRun } from '../lib/runtime/scheduler.js';
import { reviewFindings } from '../lib/runtime/review-evidence.js';
import { sha256 } from '../lib/runtime/canonical.js';

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
  it('keeps remediation history absent on a run that never enters remediation', () => {
    const state = baseRun();
    const reviewTicket = walkToReview(state);
    const agreed = record(state, reviewTicket, { evidence: { verdict: 'agree' } });
    expect(agreed.some((action) => action.type === 'run_gates')).toBe(true);
    expect(state).not.toHaveProperty('remediation_finding_history');
  });

  it('charges the remediation budget on a verdict disagreement and reaches gates when the remediation review agrees', () => {
    const state = baseRun();
    const reviewTicket = walkToReview(state);

    const disagreed = record(state, reviewTicket, {
      evidence: { verdict: 'disagree' },
      findings: [blocker('src/value.js', 'Value defect')],
    });
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

  it('retains proper-subset progress and then stops an unchanged finding set', () => {
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
    expect(state.remediation_finding_history).toMatchObject({ version: 1 });
    expect(state.remediation_finding_history.cycles).toHaveLength(2);

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

  it('continues when one prior blocker resolves and every added blocker is globally unseen', () => {
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

    expect(actions.some((action) => action.type === 'issue_ticket'
      && action.stage.id === 'remediation-build')).toBe(true);
    expect(state).toMatchObject({ status: 'running', remediation_cycles: 2 });

    record(state, state.tickets.at(-1));
    const thirdCycle = record(state, state.tickets.at(-1), {
      evidence: { verdict: 'disagree' },
      findings: [
        blocker('src/new.js', 'New defect'),
        blocker('src/later.js', 'Later unseen defect'),
      ],
    });
    expect(thirdCycle.some((action) => action.type === 'issue_ticket'
      && action.stage.id === 'remediation-build')).toBe(true);
    expect(state).toMatchObject({ status: 'running', remediation_cycles: 3 });
    expect(state.remediation_finding_history).toMatchObject({ version: 1 });
    expect(state.remediation_finding_history.cycles).toHaveLength(3);
    expect(state.remediation_finding_history.cycles.at(-1))
      .toEqual(state.remediation_finding_fingerprints);
    for (const cycle of state.remediation_finding_history.cycles) {
      expect(cycle).toEqual([...cycle].sort());
      expect(new Set(cycle).size).toBe(cycle.length);
      expect(cycle.every((identity) => /^[0-9a-f]{64}$/.test(identity))).toBe(true);
    }
    expect(state.remediation_finding_count).toBe(2);
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
    ['retain-all growth', (prior) => [...prior, blocker('src/new.js', 'New defect')]],
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

  it('rejects A-to-B-to-A oscillation because a reintroduced identity is globally seen', () => {
    const state = baseRun();
    const reviewTicket = walkToReview(state);
    record(state, reviewTicket, {
      evidence: { verdict: 'disagree' },
      findings: [blocker('src/value.js', 'Value defect')],
    });
    record(state, state.tickets.at(-1));

    const advanced = record(state, state.tickets.at(-1), {
      evidence: { verdict: 'disagree' },
      findings: [blocker('src/cache.js', 'Cache defect')],
    });
    expect(advanced.some((action) => action.type === 'issue_ticket'
      && action.stage.id === 'remediation-build')).toBe(true);
    expect(state.remediation_cycles).toBe(2);

    record(state, state.tickets.at(-1));
    const blocked = record(state, state.tickets.at(-1), {
      evidence: { verdict: 'disagree' },
      findings: [blocker('src/value.js', 'Value defect')],
    });
    expect(blocked.some((action) => action.type === 'issue_ticket')).toBe(false);
    expect(blocked.map((action) => action.type)).toEqual([
      'transition', 'archive_history', 'release_lock', 'persist_state',
    ]);
    expect(state).toMatchObject({
      status: 'blocked',
      stage: 'remediation',
      remediation_cycles: 2,
    });
    expect(state.block_reason).toMatch(/repeat|reintroduc|oscillat|history|progress/i);
    expect(state.remediation_finding_history.cycles).toHaveLength(2);
  });

  it.each([
    ['missing', (state) => { delete state.remediation_finding_history; }],
    ['future-version', (state) => { state.remediation_finding_history.version = 2; }],
    ['empty', (state) => { state.remediation_finding_history.cycles = []; }],
    ['duplicate identity', (state) => {
      const [identity] = state.remediation_finding_history.cycles[0];
      state.remediation_finding_history.cycles[0] = [identity, identity];
    }],
    ['unsorted identity set', (state) => {
      state.remediation_finding_history.cycles[0].reverse();
    }],
    ['latest-set mismatch', (state) => {
      state.remediation_finding_fingerprints = ['f'.repeat(64)];
    }],
  ])('fails closed on %s remediation history instead of inferring progress', (_label, corrupt) => {
    const state = baseRun();
    const reviewTicket = walkToReview(state);
    record(state, reviewTicket, {
      evidence: { verdict: 'disagree' },
      findings: [
        blocker('src/value.js', 'Value defect'),
        blocker('src/lock.js', 'Crash recovery defect'),
      ],
    });
    expect(state.remediation_finding_history).toMatchObject({ version: 1 });
    corrupt(state);
    record(state, state.tickets.at(-1));

    const blocked = record(state, state.tickets.at(-1), {
      evidence: { verdict: 'disagree' },
      findings: [blocker('src/lock.js', 'Crash recovery defect')],
    });
    expect(blocked.some((action) => action.type === 'issue_ticket')).toBe(false);
    expect(blocked.map((action) => action.type)).toEqual([
      'transition', 'archive_history', 'release_lock', 'persist_state',
    ]);
    expect(state).toMatchObject({ status: 'blocked', stage: 'remediation' });
    expect(state.block_reason).toMatch(/history|inconsistent|malformed|comparable/i);
  });

  it('rejects self-consistent history mirrors that are not bound to the prior review receipt', () => {
    const state = baseRun();
    const reviewTicket = walkToReview(state);
    const unchangedFinding = blocker('src/value.js', 'Value defect');
    record(state, reviewTicket, {
      evidence: { verdict: 'disagree' },
      findings: [unchangedFinding],
    });

    // Inject the fault after the canonical first-cycle history is persisted and
    // before the next review consumes it. Shape, count, and latest-set mirrors
    // remain mutually consistent; only their binding to the durable receipt is
    // false, so structural history validation alone must not authorize progress.
    const unrelatedIdentity = 'f'.repeat(64);
    state.remediation_finding_history.cycles[0] = [unrelatedIdentity];
    state.remediation_finding_fingerprints = [unrelatedIdentity];
    state.remediation_finding_count = 1;

    record(state, state.tickets.at(-1));
    const blocked = record(state, state.tickets.at(-1), {
      evidence: { verdict: 'disagree' },
      findings: [unchangedFinding],
    });
    expect(blocked.some((action) => action.type === 'issue_ticket')).toBe(false);
    expect(blocked.map((action) => action.type)).toEqual([
      'transition', 'archive_history', 'release_lock', 'persist_state',
    ]);
    expect(state).toMatchObject({
      status: 'blocked',
      stage: 'remediation',
      remediation_cycles: 1,
    });
    expect(state.block_reason).toMatch(/history|receipt|inconsistent|comparable/i);
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

    const failed = record(state, reviewTicket, {
      status: 'failed',
      evidence: {},
      findings: [blocker('src/value.js', 'Value defect')],
    });
    expect(failed.some((action) => action.type === 'issue_ticket'
      && action.stage.id === 'review')).toBe(false);
    expect(state.remediation_cycles).toBe(1);
    expect(state.attempts.review).toBeUndefined();
    const remediationBuild = state.tickets.at(-1);
    expect(remediationBuild.stage_id).toBe('remediation-build');
    record(state, remediationBuild);
    const remediationReview = state.tickets.at(-1);
    expect(remediationReview.stage_id).toBe('remediation-review');

    // A failed remediation-review is also a disagree vote. Re-reporting the
    // same blocker makes no history progress, so the run blocks immediately
    // instead of retrying the byte-identical review.
    const blocked = record(state, remediationReview, {
      status: 'failed',
      evidence: {},
      findings: [blocker('src/value.js', 'Value defect')],
    });
    expect(blocked.some((action) => action.type === 'issue_ticket')).toBe(false);
    expect(state.status).toBe('blocked');
    expect(state.block_reason).toMatch(/repeated.*remediation|remediation cycle/i);
  });

  // friction #23: behavior change is the point — a single failed review record now
  // reaches remediation directly; the old second failure/retry ticket is gone.
  it('remediation receipts supersede a failed review so an agreeing remediation review reaches gates', () => {
    const state = baseRun();
    const reviewTicket = walkToReview(state);
    record(state, reviewTicket, {
      status: 'failed',
      evidence: {},
      findings: [blocker('src/value.js', 'Value defect')],
    });
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
    record(state, securityReview, {
      evidence: { verdict: 'disagree' },
      findings: [blocker('src/value.js', 'Value defect')],
    });
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

  it('does not coalesce JWT expiration and audience defects despite high lexical overlap', () => {
    const expiration = {
      ticket_id: 'ticket-jwt-expiration',
      status: 'passed',
      findings: [blocker(
        'src/auth/jwt.js',
        'JWT verifier does not validate the token expiration claim',
      )],
      evidence: { verdict: 'fail' },
    };
    expiration.findings[0].detail =
      'JWT validation accepts a token when the expiration claim is invalid because the verifier skips expiration validation.';
    const audience = {
      ticket_id: 'ticket-jwt-audience',
      status: 'passed',
      findings: [blocker(
        'src/auth/jwt.js',
        'JWT verifier does not validate the token audience claim',
      )],
      evidence: { verdict: 'fail' },
    };
    audience.findings[0].detail =
      'JWT validation accepts a token when the audience claim is invalid because the verifier skips audience validation.';

    const known = reviewFindings.fingerprints([expiration]);
    expect(known).toHaveLength(1);
    const analyzed = reviewFindings.analyzeIdentities([audience], [expiration], known);
    expect(analyzed).toMatchObject({ valid: true, fingerprints: [expect.any(String)] });
    expect(analyzed.fingerprints[0]).not.toBe(known[0]);
  });

  it('does not coalesce high-overlap JWT nonce and subject defects outside a fixed claim list', () => {
    const nonce = {
      ticket_id: 'ticket-jwt-nonce',
      status: 'passed',
      findings: [blocker(
        'src/auth/jwt.js',
        'JWT verifier does not validate the token nonce claim',
      )],
      evidence: { verdict: 'fail' },
    };
    nonce.findings[0].detail =
      'JWT validation accepts a token when the nonce claim is invalid because the verifier skips nonce validation.';
    const subject = {
      ticket_id: 'ticket-jwt-subject',
      status: 'passed',
      findings: [blocker(
        'src/auth/jwt.js',
        'JWT verifier does not validate the token subject claim',
      )],
      evidence: { verdict: 'fail' },
    };
    subject.findings[0].detail =
      'JWT validation accepts a token when the subject claim is invalid because the verifier skips subject validation.';

    const known = reviewFindings.fingerprints([nonce]);
    expect(known).toHaveLength(1);
    const analyzed = reviewFindings.analyzeIdentities([subject], [nonce], known);
    expect(analyzed).toMatchObject({ valid: true, fingerprints: [expect.any(String)] });
    expect(analyzed.fingerprints[0]).not.toBe(known[0]);
  });

  it('keeps login-next and logout-return open redirects as distinct same-file defects', () => {
    const loginNext = {
      ticket_id: 'ticket-login-next-redirect',
      status: 'passed',
      findings: [{
        ...blocker(
          'src/auth/redirect.js',
          'Login next parameter permits an open redirect to an external destination',
        ),
        detail: 'The login next parameter accepts an external destination without an origin allowlist.',
      }],
      evidence: { verdict: 'fail' },
    };
    const logoutReturn = {
      ticket_id: 'ticket-logout-return-redirect',
      status: 'passed',
      findings: [{
        ...blocker(
          'src/auth/redirect.js',
          'Logout return parameter permits an open redirect to an external destination',
        ),
        detail: 'The logout return parameter accepts an external destination without an origin allowlist.',
      }],
      evidence: { verdict: 'fail' },
    };

    const known = reviewFindings.fingerprints([loginNext]);
    expect(known).toHaveLength(1);
    const analyzed = reviewFindings.analyzeIdentities([logoutReturn], [loginNext], known);
    expect(analyzed).toMatchObject({ valid: true, fingerprints: [expect.any(String)] });
    expect(analyzed.fingerprints[0]).not.toBe(known[0]);
  });

  it('fails closed when a lone weak prior match cannot prove identity or distinctness', () => {
    const state = baseRun();
    const reviewTicket = walkToReview(state);
    const priorWording = {
      ...blocker('src/cache.js', 'Cache transaction loses committed update'),
      detail: 'Concurrent cache transaction loses committed update before atomic write completes.',
    };
    const uncertainWording = {
      ...blocker('src/cache.js', 'Cache transaction may discard saved update'),
      detail: 'Concurrent cache transaction may discard saved update before atomic commit completes.',
    };

    record(state, reviewTicket, {
      evidence: { verdict: 'disagree' },
      findings: [priorWording, blocker('src/value.js', 'Independent value defect')],
    });
    record(state, state.tickets.at(-1));

    const blocked = record(state, state.tickets.at(-1), {
      evidence: { verdict: 'disagree' },
      findings: [uncertainWording],
    });
    expect(blocked.some((action) => action.type === 'issue_ticket')).toBe(false);
    expect(blocked.map((action) => action.type)).toEqual([
      'transition', 'archive_history', 'release_lock', 'persist_state',
    ]);
    expect(state).toMatchObject({
      status: 'blocked',
      stage: 'remediation',
      remediation_cycles: 1,
    });
    expect(state.block_reason).toMatch(/ambiguous|identity|comparable|progress/i);
  });

  it('retains transitive descriptor aliases across three cycles of wording drift', () => {
    const state = baseRun({ policy: { max_remediation_cycles: 4 } });
    const reviewTicket = walkToReview(state);
    const redirect = (title, detail) => ({
      ...blocker('src/redirect.js', title),
      detail,
    });
    const firstWording = redirect(
      'Open redirect handler accepts external destination without validation',
      'Callback redirect follows external destination without origin allowlist validation',
    );
    const secondWording = redirect(
      'Unsafe redirect handler accepts external destination without validation',
      'Unsafe redirect follows external destination without origin allowlist validation',
    );
    const thirdWording = redirect(
      'Unsafe redirect handler accepts attacker destination without validation',
      'Unsafe redirect follows attacker destination without origin allowlist validation',
    );

    record(state, reviewTicket, {
      receipt_hash: 'a'.repeat(64),
      evidence: { verdict: 'disagree' },
      findings: [firstWording, blocker('src/cache.js', 'Independent cache defect')],
    });
    record(state, state.tickets.at(-1));
    const secondCycle = record(state, state.tickets.at(-1), {
      receipt_hash: 'b'.repeat(64),
      evidence: { verdict: 'disagree' },
      findings: [secondWording],
    });
    expect(secondCycle.some((action) => action.type === 'issue_ticket'
      && action.stage.id === 'remediation-build')).toBe(true);
    expect(state.remediation_cycles).toBe(2);

    record(state, state.tickets.at(-1));
    const thirdCycle = record(state, state.tickets.at(-1), {
      receipt_hash: 'c'.repeat(64),
      evidence: { verdict: 'disagree' },
      findings: [thirdWording],
    });
    expect(thirdCycle.some((action) => action.type === 'issue_ticket')).toBe(false);
    expect(state).toMatchObject({
      status: 'blocked',
      stage: 'remediation',
      remediation_cycles: 2,
    });
    expect(state.block_reason).toMatch(/repeat|progress|identity|history/i);
  });

  it('does not count cosmetic symbol movement as P/N/H remediation progress', () => {
    const state = baseRun();
    const reviewTicket = walkToReview(state);
    const prior = [
      {
        ...blocker('src/cache.js', 'Cache update loses stored value'),
        detail: 'Atomic writer drops committed record',
      },
      {
        ...blocker('src/audit.js', 'Audit append loses durable event'),
        detail: 'Crash recovery omits committed audit record',
      },
    ];
    record(state, reviewTicket, {
      evidence: { verdict: 'disagree' },
      findings: prior,
    });
    const retainedHistory = structuredClone(state.remediation_finding_history);
    record(state, state.tickets.at(-1));

    const actions = record(state, state.tickets.at(-1), {
      evidence: { verdict: 'disagree' },
      findings: [
        {
          ...prior[0],
          id: 'cache.cosmetic-symbol',
          line: 72,
          title: '$ Cache update loses stored value',
          detail: 'Atomic writer drops committed record $',
        },
        {
          ...prior[1],
          id: 'audit.cosmetic-symbol',
          line: 83,
          title: 'Audit append $ loses durable event',
          detail: '$ Crash recovery omits committed audit record',
        },
      ],
    });

    expect(actions.some((entry) => entry.type === 'issue_ticket')).toBe(false);
    expect(state).toMatchObject({
      status: 'blocked',
      stage: 'remediation',
      remediation_cycles: 1,
    });
    expect(state.block_reason).toMatch(/repeat|unchanged|progress/i);
    expect(state.remediation_finding_history).toEqual(retainedHistory);
  });

  it('migrates an embedded checkpoint history and reconstructs it exactly after restart', () => {
    const priorReviewTicket = {
      ticket_id: 'ticket-checkpoint-review',
      stage_id: 'review',
      role: 'reviewer',
      parallel_group: 'code-review',
    };
    const priorBuildTicket = {
      ticket_id: 'ticket-checkpoint-remediation-build',
      stage_id: 'remediation-build',
      role: 'implementer',
      parallel_group: null,
    };
    const currentReviewTicket = {
      ticket_id: 'ticket-checkpoint-remediation-review',
      stage_id: 'remediation-review',
      role: 'reviewer',
      parallel_group: 'code-review',
    };
    const retained = {
      cache: {
        ...blocker('src/cache.js', 'cache update lacks atomicity'),
        detail: 'concurrent writers lose cache updates',
      },
      boundary: {
        ...blocker('src/value.js', 'supported boundary is rejected'),
        detail: 'final supported value fails boundary validation',
      },
    };
    const legacyRoot = (finding) => sha256({
      version: 1,
      file: finding.file,
      title: finding.title,
      detail: finding.detail,
    });
    const cacheRoot = legacyRoot(retained.cache);
    const boundaryRoot = legacyRoot(retained.boundary);
    const legacyRoots = [cacheRoot, boundaryRoot].sort();
    const priorReceiptHash = 'a'.repeat(64);
    const priorReceipt = {
      ticket_id: priorReviewTicket.ticket_id,
      receipt_hash: priorReceiptHash,
      status: 'passed',
      findings: [retained.cache, retained.boundary],
      evidence: { verdict: 'disagree' },
    };
    const checkpointHistory = {
      version: 1,
      cycles: [legacyRoots],
      aliases: legacyRoots.map((root) => ({ descriptor: root, canonical: root })),
      provenance: [{
        receipt_hashes: [priorReceiptHash],
        descriptor_hashes: legacyRoots,
      }],
    };
    const state = baseRun({
      stage: 'remediation-review',
      remediation_cycles: 1,
      remediation_finding_fingerprints: legacyRoots,
      remediation_finding_count: legacyRoots.length,
      remediation_finding_history: structuredClone(checkpointHistory),
      tickets: [priorReviewTicket, priorBuildTicket, currentReviewTicket],
      receipts: [priorReceipt],
      policy: { max_remediation_cycles: 4 },
    });
    const cosmeticallyChangedCache = {
      ...retained.cache,
      id: 'cache.cosmetic-rewrite',
      line: 91,
      title: '$ cache cache update lacks atomicity',
      detail: 'concurrent writers lose cache updates updates $',
    };
    const newlyObserved = {
      ...blocker('src/audit.js', 'audit append can be lost'),
      detail: 'crash recovery can lose the durable audit record',
    };

    const actions = record(state, currentReviewTicket, {
      receipt_hash: 'b'.repeat(64),
      evidence: { verdict: 'disagree' },
      findings: [cosmeticallyChangedCache, newlyObserved],
    });

    expect(actions.some((entry) => entry.type === 'issue_ticket'
      && entry.stage.id === 'remediation-build')).toBe(true);
    expect(state).toMatchObject({ status: 'running', remediation_cycles: 2 });
    expect(state.remediation_finding_history.cycles[0]).toEqual(checkpointHistory.cycles[0]);
    expect(state.remediation_finding_history.provenance[0])
      .toEqual(checkpointHistory.provenance[0]);
    expect(state.remediation_finding_history.cycles[1]).toContain(cacheRoot);
    expect(state.remediation_finding_history.cycles[1]).not.toContain(boundaryRoot);
    expect(state.remediation_finding_history.aliases).toEqual(expect.arrayContaining([
      { descriptor: cacheRoot, canonical: cacheRoot },
      { descriptor: boundaryRoot, canonical: boundaryRoot },
    ]));

    const expectedMigration = reviewFindings.migrateLegacyHistory(
      [[priorReceipt]],
      checkpointHistory.cycles,
      checkpointHistory.aliases,
      checkpointHistory.provenance,
    );
    expect(expectedMigration).toMatchObject({
      valid: true,
      legacyCycleCount: 1,
      normalizedProvenance: [expect.any(Object)],
    });
    const expectedIdentityEpoch = {
      version: 1,
      legacy_cycle_count: 1,
      legacy_history_hash: sha256({
        cycles: checkpointHistory.cycles,
        aliases: checkpointHistory.aliases,
        provenance: checkpointHistory.provenance,
      }),
      normalized_history_hash: sha256({
        aliases: expectedMigration.aliases,
        provenance: expectedMigration.normalizedProvenance,
      }),
      normalized_provenance: expectedMigration.normalizedProvenance,
    };
    expect(state.remediation_finding_history.identity_epoch).toEqual(expectedIdentityEpoch);

    const migratedStateBytes = JSON.stringify(state);
    const resumeFromDurableBytes = () => {
      const resumed = JSON.parse(migratedStateBytes);
      const remediationBuild = resumed.tickets.at(-1);
      expect(remediationBuild.stage_id).toBe('remediation-build');
      record(resumed, remediationBuild);
      const remediationReview = resumed.tickets.at(-1);
      expect(remediationReview.stage_id).toBe('remediation-review');
      const replayed = record(resumed, remediationReview, {
        receipt_hash: 'c'.repeat(64),
        evidence: { verdict: 'disagree' },
        findings: [newlyObserved],
      });
      expect(replayed.some((entry) => entry.type === 'issue_ticket'
        && entry.stage.id === 'remediation-build')).toBe(true);
      return resumed;
    };
    const firstRestart = resumeFromDurableBytes();
    const secondRestart = resumeFromDurableBytes();
    expect(firstRestart.remediation_finding_history)
      .toEqual(secondRestart.remediation_finding_history);
    expect(firstRestart.remediation_finding_history.cycles[0])
      .toEqual(checkpointHistory.cycles[0]);
    expect(firstRestart.remediation_finding_history.provenance[0])
      .toEqual(checkpointHistory.provenance[0]);
    expect(firstRestart.remediation_finding_history.identity_epoch)
      .toEqual(expectedIdentityEpoch);
  });
});

describe('APE v2 phantom verify stage removal (F27)', () => {
  it('NEXT on a run parked at a verify stage reports status instead of re-running gates', () => {
    const state = baseRun({ stage: 'verify' });
    const actions = reduceRun(state, { type: 'NEXT', at: new Date().toISOString() });
    expect(actions.map((action) => action.type)).toEqual(['status']);
  });
});
