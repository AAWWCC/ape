import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { evaluateLifecyclePolicy } from '../lib/runtime/hooks.js';
import { runtimePaths } from '../lib/runtime/paths.js';
import { reduceRun } from '../lib/runtime/scheduler.js';
import { recordReceipt, startRun, statusRun } from '../lib/runtime/service.js';
import { renderStatusDoc } from '../lib/runtime/status-doc.js';
import { atomicWriteJson } from '../lib/runtime/storage.js';

// Roadmap entry remediation-test-path-role-gap.
//
// THE GAP, proven live by run-fixture-0d6308c75933 (archived blocked): a
// blocking review finding located in an AUTHORED TEST path cannot be remediated.
// pipeline.js:76 hardcodes stage('remediation-build', 'implementer');
// hooks.js:587 denies every implementer write to a test-shaped path and
// receipt-validator.js:149-151 rejects such a receipt, so that run spent its one
// remediation cycle and blocked with a zero-risk comment-only correction
// unlanded. acme PR #359 landed it through a separate land run — a workaround.
//
// THE CONTRACT UNDER TEST. A blocking review declares the target STRUCTURALLY as
// `evidence.test_remediation { test_paths, reason }` — the exact sibling of
// `evidence.scope_expansion` (service.js:1899-1972), validated at the same
// PRE-DURABLE rejection site (service.js:2238-2241) so a refusal leaves no
// receipt, no transaction and no audit line and the same review ticket stays
// recordable. The declaration routes ONE extra test_writer stage
// 'remediation-test' INSIDE the single remediation cycle, ordered
// test -> build -> review. No boundary is relaxed anywhere: the editing role is
// still the test_writer under test-writer confinement, and the routing authority
// is the READ-ONLY reviewer.
//
// Facts this file leans on, verified against the tree at authoring time:
//   * receipt.evidence is already `z.record(z.string(), z.unknown())`
//     (schemas.js:79), so no receipt-schema change is needed.
//   * findings[] carries no reliable file or blocking field (schemas.js:78,
//     receipt-input.js:56-61, scheduler.js:153-167), so routing on findings is
//     impossible — arm A4 pins that it is NOT the routing input.
//   * The routing decision must be unioned over the WHOLE code-review group:
//     scheduler.js:455 passes the group's `state` (service.js:2490 threads
//     next_state as the same object whose receipts were pushed at
//     service.js:2299), so reading only the last receipt silently drops a
//     declaration made by a reviewer that landed FIRST.
//   * The remediation-test ticket must be NARROWED to the declared paths in BOTH
//     ticket.test_paths AND ticket.claimed_paths: narrowing test_paths alone does
//     not enforce, because receipt-validator.js:137 falls back to
//     withinClaims(file, ticket.claimed_paths) and the test-writer production
//     check at :141 still passes for a test-patterned file — the write would be
//     hook-denied but receipt-ADMITTED.
//   * The narrowing applies ONLY to the remediation-test ticket. state.test_paths
//     is never mutated and implementer tickets are never narrowed.
//   * The narrowed set must be derived from RUN STATE, not carried on the frozen
//     stage object: scheduler.js:46-56 stageFromTicket rebuilds the stage from
//     schema fields only, so a non-schema field would vanish on the retry ticket.
//   * Confinement is only "the declared paths widened to their DIRECTORIES".
//     withinTestScope's file-shaped widening (path-scope.js:81-91) is pinned
//     deliberate at runtime-v2-test-scope-directory-widening.test.js:47-49, so
//     a same-directory sibling stays writable — that is the recorded residual,
//     not confinement.
//
// P9 contention: vitest.config.js is unclaimed and this file must not be
// quarantined, so the routing-shape arms run on the PURE reduceRun harness
// (modelled on runtime-v2-core-remediation-convergence.test.js:26-60), which
// spawns nothing. Only the arms that genuinely need the real admission surface
// take a startRun/recordReceipt walk, and those carry an explicit 30s timeout.

const cleanups = [];
afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

// ---------------------------------------------------------------------------
// Pure reducer harness (no child processes): drive reduceRun the way
// service.applyActions does, so routing shape is observable without a project.
// ---------------------------------------------------------------------------

let ticketCounter = 0;

function baseRun(overrides = {}) {
  return {
    run_id: 'run-remediation-test-routing',
    mode: 'phase',
    lane: 'fast',
    status: 'running',
    stage: 'dispatch',
    high_risk: false,
    claimed_paths: ['src/value.js'],
    test_paths: ['tests/value.test.js'],
    tickets: [],
    receipts: [],
    attempts: {},
    remediation_cycles: 0,
    ...overrides,
  };
}

function issue(state, stage, extra = {}) {
  const ticket = {
    ticket_id: `ticket-${(ticketCounter += 1)}`,
    stage_id: stage.id,
    role: stage.role,
    parallel_group: stage.parallel_group ?? null,
    writable: stage.writable,
    required_checks: stage.required_checks ?? [],
    ...extra,
  };
  state.tickets.push(ticket);
  state.stage = stage.id;
  return ticket;
}

// Record a receipt and apply the reducer's transition/issue_ticket effects in
// order, mirroring service.applyActions (including the review_findings the
// review-disagreed arm threads onto the ticket it issues, scheduler.js:452-458).
function record(state, ticket, overrides = {}) {
  const receipt = {
    ticket_id: ticket.ticket_id,
    status: 'passed',
    findings: [],
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
    if (action.type === 'issue_ticket') {
      issue(state, action.stage, action.review_findings ? { review_findings: action.review_findings } : {});
    }
  }
  return actions;
}

function issuedStages(actions) {
  return actions.filter((action) => action.type === 'issue_ticket');
}

function walkToReviewPure(state) {
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

const DECLARATION_REASON =
  'the authored assertion pins the wrong boundary; the correction belongs in the test, not the implementation';

function testRemediation(testPaths, reason = DECLARATION_REASON) {
  return { test_paths: testPaths, reason };
}

function blockingDeclaration(testPaths = ['tests/value.test.js'], extra = {}) {
  return { verdict: 'fail', test_remediation: testRemediation(testPaths), ...extra };
}

describe('remediation-test routing shape (pure reducer)', () => {
  // A3 — invariant 5. The new stage sits INSIDE the one remediation cycle: the
  // counter is the budget, not the stage count.
  it('spends exactly ONE remediation cycle on test -> build -> review, then blocks with no second remediation-test', () => {
    const state = baseRun();
    const reviewTicket = walkToReviewPure(state);

    const routed = record(state, reviewTicket, { evidence: blockingDeclaration() });
    expect(state.remediation_cycles).toBe(1);
    const first = issuedStages(routed);
    expect(first.map((action) => action.stage.id)).toEqual(['remediation-test']);
    expect(first[0].stage.role).toBe('test_writer');
    expect(first[0].stage.writable).toBe(true);
    // P4: neither 'red-test' nor 'targeted-tests' is satisfiable for a
    // correction that may make the suite green or keep it red, so the stage
    // carries no required check; the cycle still ends on remediation-build's
    // targeted-tests check.
    expect(first[0].stage.required_checks).toEqual([]);

    const remediationTest = state.tickets.at(-1);
    expect(remediationTest.stage_id).toBe('remediation-test');
    record(state, remediationTest);
    // The ordering trap: the new arm must sit ABOVE pipeline.js:87's
    // `run.lane !== 'full'` branch. Below it, a fast run falls into the lane
    // findIndex, returns [], and the reducer's tail COMPLETES the run with the
    // remediation unbuilt.
    expect(state.status).toBe('running');
    const remediationBuild = state.tickets.at(-1);
    expect(remediationBuild.stage_id).toBe('remediation-build');
    expect(remediationBuild.role).toBe('implementer');

    record(state, remediationBuild);
    const remediationReview = state.tickets.at(-1);
    expect(remediationReview.stage_id).toBe('remediation-review');

    // A second declaration cannot buy a second cycle.
    const blocked = record(state, remediationReview, { evidence: blockingDeclaration() });
    expect(blocked.some((action) => action.type === 'issue_ticket')).toBe(false);
    expect(state.status).toBe('blocked');
    expect(state.block_reason).toBe('review disagreement persists after the single remediation cycle');
    expect(state.remediation_cycles).toBe(1);
    expect(state.tickets.filter((ticket) => ticket.stage_id === 'remediation-test')).toHaveLength(1);
  });

  // A4 — findings[] is NOT the routing input, and the recorded residual: a
  // reviewer who simply OMITS the declaration gets today's behavior and the
  // test-path finding lands unremediated exactly as before. This design makes
  // the correct action available; it does not eliminate that case.
  it('routes to remediation-build when a blocking review only NAMES a test file:line in findings', () => {
    const state = baseRun();
    const reviewTicket = walkToReviewPure(state);

    const routed = record(state, reviewTicket, {
      evidence: { verdict: 'fail', summary: 'the authored test asserts the wrong boundary' },
      findings: [{ file: 'tests/value.test.js', line: 12, note: 'inverted assertion' }],
    });
    const issued = issuedStages(routed);
    expect(issued.map((action) => action.stage.id)).toEqual(['remediation-build']);
    expect(issued[0].stage.role).toBe('implementer');
    expect(state.remediation_cycles).toBe(1);
  });

  // A9 — both halves. A single blocking review carrying a production finding AND
  // a test-path declaration must not have to choose: the remediation-test ticket
  // carries the whole grounded finding list (the service arm below pins that the
  // same list is inherited onto remediation-build).
  it('carries BOTH the production finding and the test finding onto the remediation-test ticket', () => {
    const state = baseRun();
    const reviewTicket = walkToReviewPure(state);

    const routed = record(state, reviewTicket, {
      evidence: blockingDeclaration(),
      findings: [
        { file: 'src/value.js', line: 3, summary: 'the boundary is off by one' },
        { file: 'tests/value.test.js', line: 12, summary: 'the authored assertion pins the wrong boundary' },
      ],
    });
    const issued = issuedStages(routed);
    expect(issued.map((action) => action.stage.id)).toEqual(['remediation-test']);
    expect(issued[0].review_findings).toEqual(expect.arrayContaining([
      expect.stringContaining('src/value.js:3'),
      expect.stringContaining('tests/value.test.js:12'),
    ]));

    const remediationTest = state.tickets.at(-1);
    expect(remediationTest.review_findings).toEqual(expect.arrayContaining([
      expect.stringContaining('src/value.js:3'),
    ]));
    record(state, remediationTest);
    expect(state.tickets.at(-1).stage_id).toBe('remediation-build');
  });

  // Critic finding 3 / judge J3: the declaring reviewer lands FIRST and the
  // agreeing security review lands SECOND. Reading only the receipt that closed
  // the group silently drops the declaration.
  it('unions the declaration over the whole code-review group when the declaring reviewer lands first', () => {
    const state = baseRun({ lane: 'full', high_risk: true });
    const buildTicket = issue(state, { id: 'build', role: 'implementer' });
    record(state, buildTicket);
    const [review, securityReview] = state.tickets.slice(-2);
    expect(review.stage_id).toBe('review');
    expect(securityReview.stage_id).toBe('security-review');

    // The declaring reviewer disagrees first; the group is still outstanding.
    const held = record(state, review, { evidence: blockingDeclaration() });
    expect(held.some((action) => action.type === 'issue_ticket')).toBe(false);

    // The AGREEING security review closes the group. Its own receipt carries no
    // declaration, so only a group-wide union can still route the test stage.
    const routed = record(state, securityReview, { evidence: { verdict: 'agree' } });
    const issued = issuedStages(routed);
    expect(issued.map((action) => action.stage.id)).toEqual(['remediation-test']);
    expect(issued[0].stage.role).toBe('test_writer');
  });

  // A5 (mechanism half). Mode land has no writing stage, and the service's
  // honest-block conversion (service.js:2499) keys on
  // `issue_ticket.stage.writable === true`. Whatever the pipeline proposes for a
  // land run must therefore stay writable AND non-empty — an empty proposal
  // would slip past the guard and strand the run 'running' with no ticket.
  it('proposes only writable stages on a land run, so the service no-writing-stage guard still fires', () => {
    const state = baseRun({ mode: 'land' });
    const review = issue(state, { id: 'review', role: 'reviewer', parallel_group: 'code-review' });

    const routed = record(state, review, { evidence: blockingDeclaration() });
    const issued = issuedStages(routed);
    expect(issued.length).toBeGreaterThan(0);
    expect(issued.every((action) => action.stage.writable === true)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Real service surface. Three walks, each capped with an explicit 30s timeout.
// ---------------------------------------------------------------------------

function git(cwd, ...args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

// CJS on purpose: the scratch project has no package.json, so .js files run as
// CommonJS under the configured `node tests/value.test.js` targeted command
// (the runtime's own red-test observation executes it).
const VALUE_V1 = 'module.exports = { value: 1 };\n';
const VALUE_V2 = 'module.exports = { value: 2 };\n';
const VALUE_V3 = 'module.exports = { value: 3 };\n';
const AUTHORED_TEST =
  "const { value } = require('../src/value.js');\n" +
  "if (value !== 2) { throw new Error('red: value is ' + value); }\n";
const CORRECTED_TEST =
  "const { value } = require('../src/value.js');\n" +
  "if (value !== 3) { throw new Error('red: value is ' + value); }\n";

async function project(config = {}) {
  const dir = await mkdtemp(path.join(tmpdir(), 'ape-remediation-test-'));
  cleanups.push(dir);
  await mkdir(path.join(dir, 'src'));
  await mkdir(path.join(dir, 'tests'));
  await writeFile(path.join(dir, 'src', 'value.js'), VALUE_V1);
  await writeFile(path.join(dir, 'tests', 'value.test.js'), 'throw new Error("placeholder");\n');
  git(dir, 'init', '-q');
  git(dir, 'config', 'user.email', 'ape@example.test');
  git(dir, 'config', 'user.name', 'APE Test');
  git(dir, 'add', '.');
  git(dir, 'commit', '-qm', 'test: baseline');
  await atomicWriteJson(runtimePaths(dir).config, {
    shipping: { auto_merge: false, provider: 'github', required_remote_checks: false },
    test_commands: {
      full: 'node -e "process.exit(0)"',
      targeted: 'node tests/value.test.js',
    },
    ...config,
  });
  return dir;
}

function startInput(overrides = {}) {
  return {
    objective: 'Close the remediation-test path role gap',
    mode: 'phase',
    lane: 'auto',
    host: 'codex',
    claimed_paths: ['src/value.js'],
    test_paths: ['tests/value.test.js'],
    requirements: [],
    risk_triggers: [],
    behavioral: true,
    hooks_trusted: true,
    subagents_available: true,
    explicit_invocation: true,
    ...overrides,
  };
}

function receipt(ticket, overrides = {}) {
  return {
    ticket_id: ticket.ticket_id,
    status: 'passed',
    agent_identity: `agent-${ticket.role}`,
    tests: [],
    findings: [],
    evidence: { verdict: 'pass' },
    timing: {
      started_at: ticket.issued_at,
      completed_at: new Date(Date.parse(ticket.issued_at) + 10).toISOString(),
      duration_ms: 10,
    },
    ...overrides,
  };
}

const redTest = [{ command: 'node tests/value.test.js', passed: false, exit_code: 1, duration_ms: 1 }];
const greenTest = [{ command: 'node tests/value.test.js', passed: true, exit_code: 0, duration_ms: 1 }];

const editEvent = (file) => ({
  host: 'claude',
  is_subagent: true,
  ape_managed: true,
  event: 'PreToolUse',
  tool_name: 'Edit',
  file,
});

function writePolicy(ticket, file) {
  return evaluateLifecyclePolicy(editEvent(file), { state: { status: 'running' }, ticket });
}

async function overrideLogLines(dir) {
  const raw = await readFile(runtimePaths(dir).overrideLog, 'utf8').catch(() => '');
  return raw.split('\n').filter(Boolean);
}

// Drive a fast-lane run to its review stage: authored red test, green build.
async function walkToReview(dir, overrides = {}) {
  const started = await startRun(dir, startInput(overrides));
  expect(started.ok).toBe(true);
  expect(started.run.lane).toBe('fast');
  const testTicket = started.run.tickets[0];
  expect(testTicket.role).toBe('test_writer');
  await writeFile(path.join(dir, 'tests', 'value.test.js'), AUTHORED_TEST);
  const tested = await recordReceipt(dir, receipt(testTicket, { tests: redTest }));
  expect(tested.ok, JSON.stringify(tested.errors ?? [])).toBe(true);
  const buildTicket = tested.run.tickets.at(-1);
  expect(buildTicket.role).toBe('implementer');
  await writeFile(path.join(dir, 'src', 'value.js'), VALUE_V2);
  const built = await recordReceipt(dir, receipt(buildTicket, { tests: greenTest }));
  expect(built.ok, JSON.stringify(built.errors ?? [])).toBe(true);
  const reviewTicket = built.run.tickets.at(-1);
  expect(reviewTicket.stage_id).toBe('review');
  return { testTicket, buildTicket, reviewTicket };
}

describe('a review finding in an authored TEST path is remediable within the cycle (A1)', () => {
  it('routes a narrowed, writable test_writer stage, then the implementer build that inherits the findings', async () => {
    // The run claims TWO authored test paths so the narrowing is observable: an
    // un-narrowed ticket would carry both.
    const dir = await project();
    const { reviewTicket } = await walkToReview(dir, {
      test_paths: ['tests/value.test.js', 'spec/other.test.js'],
    });

    const reviewed = await recordReceipt(dir, receipt(reviewTicket, {
      tests: greenTest,
      findings: [
        { file: 'src/value.js', line: 3, summary: 'the boundary is off by one' },
        { file: 'tests/value.test.js', line: 2, summary: 'the authored assertion pins the wrong boundary' },
      ],
      evidence: blockingDeclaration(['tests/value.test.js']),
    }));
    expect(reviewed.ok, JSON.stringify(reviewed.errors ?? [])).toBe(true);
    expect(reviewed.run.remediation_cycles).toBe(1);

    const remediationTest = reviewed.run.tickets.at(-1);
    expect(remediationTest.stage_id).toBe('remediation-test');
    expect(remediationTest.role).toBe('test_writer');
    expect(remediationTest.writable).toBe(true);
    // P4: no stage check — neither 'red-test' nor 'targeted-tests' is
    // satisfiable for a correction that may leave the suite red or green.
    expect(remediationTest.required_checks).toEqual([]);
    // J1/J1a: narrowed in BOTH fields. test_paths alone does not enforce —
    // receipt-validator.js:137 falls back to ticket.claimed_paths.
    expect(remediationTest.test_paths).toEqual(['tests/value.test.js']);
    expect(remediationTest.claimed_paths).toEqual(['tests/value.test.js']);
    // A9 (service half): the grounded findings ride the test stage.
    expect(remediationTest.review_findings).toEqual(expect.arrayContaining([
      expect.stringContaining('src/value.js:3'),
      expect.stringContaining('tests/value.test.js:2'),
    ]));
    // J1b: the run's own authored-test claim set is untouched.
    expect(reviewed.run.test_paths).toEqual(['tests/value.test.js', 'spec/other.test.js']);

    // The write-time hook admits the declared correction under this ticket.
    expect(writePolicy(remediationTest, 'tests/value.test.js').decision).toBe('allow');

    await writeFile(path.join(dir, 'tests', 'value.test.js'), CORRECTED_TEST);
    const corrected = await recordReceipt(dir, receipt(remediationTest, {
      evidence: { verdict: 'pass', summary: 'corrected the asserted boundary' },
    }));
    expect(corrected.ok, JSON.stringify(corrected.errors ?? [])).toBe(true);
    expect(corrected.receipt.changed_files).toEqual(['tests/value.test.js']);
    expect(corrected.run.test_paths).toEqual(['tests/value.test.js', 'spec/other.test.js']);

    const remediationBuild = corrected.run.tickets.at(-1);
    expect(remediationBuild.stage_id).toBe('remediation-build');
    expect(remediationBuild.role).toBe('implementer');
    // J1b: the implementer ticket is never narrowed, and it inherits the
    // review's grounded findings (forwarded via service.js issueTicket).
    expect(remediationBuild.claimed_paths).toEqual(['src/value.js']);
    expect(remediationBuild.review_findings).toEqual(expect.arrayContaining([
      expect.stringContaining('src/value.js:3'),
      expect.stringContaining('tests/value.test.js:2'),
    ]));

    // Invariant 3 is untouched: the same file the test writer just corrected is
    // still denied to the implementer (hooks.js:587).
    const denied = writePolicy(remediationBuild, 'tests/value.test.js');
    expect(denied.decision).toBe('deny');
    expect(denied.reason).toMatch(/implementers may not modify authored tests/);

    await writeFile(path.join(dir, 'src', 'value.js'), VALUE_V3);
    const rebuilt = await recordReceipt(dir, receipt(remediationBuild, { tests: greenTest }));
    expect(rebuilt.ok, JSON.stringify(rebuilt.errors ?? [])).toBe(true);
    expect(rebuilt.receipt.changed_files).toEqual(['src/value.js']);
    expect(rebuilt.run.tickets.at(-1).stage_id).toBe('remediation-review');
    expect(rebuilt.run.remediation_cycles).toBe(1);
  }, 30_000);
});

describe('the declaration is validated pre-durably and refused loudly (A2/A7/A8)', () => {
  it('refuses out-of-scope, malformed, non-review and agreeing declarations with no durable side effect, then accepts a corrected one', async () => {
    const dir = await project();
    const started = await startRun(dir, startInput());
    expect(started.ok).toBe(true);
    const testTicket = started.run.tickets[0];

    // A7 (test_writer half): a writing role may not summon a test-editing stage
    // for itself. Rejected before any durable side effect, so the same ticket
    // still records.
    await writeFile(path.join(dir, 'tests', 'value.test.js'), AUTHORED_TEST);
    const writerDeclared = await recordReceipt(dir, receipt(testTicket, {
      tests: redTest,
      evidence: { verdict: 'pass', test_remediation: testRemediation(['tests/value.test.js']) },
    }));
    expect(writerDeclared.ok).toBe(false);
    expect(writerDeclared.rejected).toBe(true);
    expect(writerDeclared.errors.join('; ')).toMatch(/test_remediation/);
    expect(writerDeclared.errors.join('; ')).toMatch(/review/i);
    expect((await statusRun(dir)).run.receipts).toHaveLength(0);

    const tested = await recordReceipt(dir, receipt(testTicket, { tests: redTest }));
    expect(tested.ok, JSON.stringify(tested.errors ?? [])).toBe(true);
    const buildTicket = tested.run.tickets.at(-1);

    // A7 (implementer half).
    await writeFile(path.join(dir, 'src', 'value.js'), VALUE_V2);
    const builderDeclared = await recordReceipt(dir, receipt(buildTicket, {
      tests: greenTest,
      evidence: { verdict: 'pass', test_remediation: testRemediation(['tests/value.test.js']) },
    }));
    expect(builderDeclared.ok).toBe(false);
    expect(builderDeclared.errors.join('; ')).toMatch(/test_remediation/);
    expect(builderDeclared.errors.join('; ')).toMatch(/review/i);

    const built = await recordReceipt(dir, receipt(buildTicket, { tests: greenTest }));
    expect(built.ok, JSON.stringify(built.errors ?? [])).toBe(true);
    const reviewTicket = built.run.tickets.at(-1);
    expect(reviewTicket.stage_id).toBe('review');

    const auditLinesBefore = (await overrideLogLines(dir)).length;

    // A8: a declaration on an AGREEING review is refused, never silently
    // dropped — there is no blocking finding for the correction to answer.
    const agreeing = await recordReceipt(dir, receipt(reviewTicket, {
      tests: greenTest,
      evidence: { verdict: 'pass', test_remediation: testRemediation(['tests/value.test.js']) },
    }));
    expect(agreeing.ok).toBe(false);
    expect(agreeing.errors.join('; ')).toMatch(/blocking/);

    // A2: out-of-contract declarations name the offending path or field.
    // 'spec/other.test.js' is the out-of-claims fixture on purpose:
    // withinTestScope widens a FILE-shaped claim to its DIRECTORY, so
    // 'tests/other.test.js' and 'tests/unit/other.test.js' are both IN scope.
    const attempts = [
      [blockingDeclaration(['spec/other.test.js']), /spec\/other\.test\.js/],
      [blockingDeclaration(['src/value.js']), /src\/value\.js/],
      [blockingDeclaration(['../outside.test.js']), /\.\./],
      [blockingDeclaration(['/etc/passwd.test.js']), /\/etc\/passwd\.test\.js/],
      [blockingDeclaration(['.ape/runtime/hack.test.js']), /\.ape/],
      [blockingDeclaration([]), /test_paths/],
      [{ verdict: 'fail', test_remediation: { test_paths: ['tests/other.test.js'] } }, /reason/],
      [{ verdict: 'fail', test_remediation: { test_paths: 'tests/other.test.js', reason: 'r' } }, /test_paths/],
      [{ verdict: 'fail', test_remediation: 'tests/other.test.js' }, /object/],
    ];
    for (const [evidence, expected] of attempts) {
      const rejected = await recordReceipt(dir, receipt(reviewTicket, { tests: greenTest, evidence }));
      expect(rejected.ok, JSON.stringify(evidence)).toBe(false);
      expect(rejected.rejected).toBe(true);
      expect(rejected.errors.some((error) => expected.test(error)), rejected.errors.join('; ')).toBe(true);
    }

    // No durable side effect: no receipt, the cycle is unspent, no new ticket,
    // and nothing was appended to the audit log.
    const parked = (await statusRun(dir)).run;
    expect(parked.receipts.some((entry) => entry.ticket_id === reviewTicket.ticket_id)).toBe(false);
    expect(parked.remediation_cycles).toBe(0);
    expect(parked.tickets.at(-1).ticket_id).toBe(reviewTicket.ticket_id);
    expect((await overrideLogLines(dir))).toHaveLength(auditLinesBefore);

    // The positive control: the SAME review ticket still records a corrected
    // declaration, and a same-directory sibling of the file-shaped claim is
    // accepted (the pinned directory widening).
    const accepted = await recordReceipt(dir, receipt(reviewTicket, {
      tests: greenTest,
      evidence: blockingDeclaration(['tests/other.test.js']),
    }));
    expect(accepted.ok, JSON.stringify(accepted.errors ?? [])).toBe(true);
    expect(accepted.run.remediation_cycles).toBe(1);
    const remediationTest = accepted.run.tickets.at(-1);
    expect(remediationTest.stage_id).toBe('remediation-test');
    expect(remediationTest.test_paths).toEqual(['tests/other.test.js']);
    expect(remediationTest.claimed_paths).toEqual(['tests/other.test.js']);
    expect(accepted.run.test_paths).toEqual(['tests/value.test.js']);

    // J1c: the narrowed set must be derived from RUN STATE, not carried on the
    // frozen stage object — scheduler.js:46-56 rebuilds the stage from schema
    // fields only, so a stage-borne set would vanish on this retry ticket.
    const failed = await recordReceipt(dir, receipt(remediationTest, {
      status: 'failed',
      evidence: { summary: 'could not author the correction on the first attempt' },
    }));
    expect(failed.ok, JSON.stringify(failed.errors ?? [])).toBe(true);
    const retry = failed.run.tickets.at(-1);
    expect(retry.stage_id).toBe('remediation-test');
    expect(retry.attempt).toBe(2);
    expect(retry.test_paths).toEqual(['tests/other.test.js']);
    expect(retry.claimed_paths).toEqual(['tests/other.test.js']);
  }, 30_000);
});

describe('the narrowed ticket is enforced at BOTH layers (J1f)', () => {
  it('refuses an authored test in a different directory at the write hook and at receipt admission', async () => {
    const dir = await project();
    const { testTicket, reviewTicket } = await walkToReview(dir, {
      test_paths: ['tests/value.test.js', 'spec/other.test.js'],
    });

    // Contrast pin: the un-narrowed test ticket authorizes both directories.
    expect(writePolicy(testTicket, 'spec/other.test.js').decision).toBe('allow');

    const reviewed = await recordReceipt(dir, receipt(reviewTicket, {
      tests: greenTest,
      findings: [{ file: 'tests/value.test.js', line: 2, summary: 'the authored assertion is inverted' }],
      evidence: blockingDeclaration(['tests/value.test.js']),
    }));
    expect(reviewed.ok, JSON.stringify(reviewed.errors ?? [])).toBe(true);
    const remediationTest = reviewed.run.tickets.at(-1);
    expect(remediationTest.stage_id).toBe('remediation-test');

    // Layer 1 — the write-time hook (hooks.js:584).
    const denied = writePolicy(remediationTest, 'spec/other.test.js');
    expect(denied.decision).toBe('deny');
    expect(denied.reason).toMatch(/test writers may modify only claimed test paths/);
    // Positive controls: the declared file is writable, and a same-directory
    // sibling still is too. That widening is the recorded RESIDUAL (pinned at
    // runtime-v2-test-scope-directory-widening.test.js:47-49), not confinement:
    // the enforced confinement is "the declared paths widened to their
    // directories", nothing tighter.
    expect(writePolicy(remediationTest, 'tests/value.test.js').decision).toBe('allow');
    expect(writePolicy(remediationTest, 'tests/sibling.test.js').decision).toBe('allow');

    // Layer 2 — receipt admission. A hook-denied write must also be
    // receipt-REFUSED, or narrowing test_paths alone would leave it admitted
    // through the withinClaims fallback at receipt-validator.js:137.
    await mkdir(path.join(dir, 'spec'), { recursive: true });
    await writeFile(path.join(dir, 'spec', 'other.test.js'), 'process.exit(0);\n');
    const rejected = await recordReceipt(dir, receipt(remediationTest, {
      evidence: { verdict: 'pass', summary: 'authored outside the declared directory' },
    }));
    expect(rejected.ok).toBe(false);
    expect(rejected.rejected).toBe(true);
    expect(rejected.errors).toContain('unclaimed write: spec/other.test.js');

    // Restore the attested tree and record the correction the declaration named,
    // plus its same-directory sibling: both are admitted.
    await rm(path.join(dir, 'spec'), { recursive: true, force: true });
    await writeFile(path.join(dir, 'tests', 'value.test.js'), CORRECTED_TEST);
    await writeFile(path.join(dir, 'tests', 'sibling.test.js'), 'process.exit(0);\n');
    const admitted = await recordReceipt(dir, receipt(remediationTest, {
      evidence: { verdict: 'pass', summary: 'corrected the asserted boundary' },
    }));
    expect(admitted.ok, JSON.stringify(admitted.errors ?? [])).toBe(true);
    expect(admitted.receipt.changed_files).toEqual(['tests/sibling.test.js', 'tests/value.test.js']);
    expect(admitted.run.tickets.at(-1).stage_id).toBe('remediation-build');
  }, 30_000);
});

describe('mode land opens no writer for a declared test remediation (A5)', () => {
  // Placed on the real surface deliberately: the land conversion lives in
  // service.js:2499, not in the reducer, so "the cycle stays unspent and no
  // writable ticket exists" is only observable here. The walk runs no test
  // command and no merge gate — the disagreement blocks before either.
  it('blocks with the no-writing-stage reason, the remediation budget unspent', async () => {
    const dir = await project();
    // Mode land requires the finished diff to be dirty at start, and the judge's
    // precondition: the run must CARRY test_paths covering the declared path, or
    // this exercises the out-of-scope refusal instead and proves the wrong thing.
    await writeFile(path.join(dir, 'src', 'value.js'), VALUE_V2);
    const started = await startRun(dir, startInput({ mode: 'land' }));
    expect(started.ok).toBe(true);
    expect(started.run.test_paths).toEqual(['tests/value.test.js']);
    expect(started.run.tickets.map((ticket) => ticket.stage_id)).toEqual(['review']);
    const review = started.run.tickets[0];

    const reviewed = await recordReceipt(dir, receipt(review, {
      evidence: blockingDeclaration(['tests/value.test.js']),
    }));
    expect(reviewed.ok, JSON.stringify(reviewed.errors ?? [])).toBe(true);
    expect(reviewed.run.status).toBe('blocked');
    expect(reviewed.run.block_reason).toMatch(/no writing stage/);
    expect(reviewed.run.block_reason).toMatch(/revise the diff outside APE/);
    // The declaration bought no writer and spent no cycle.
    expect(reviewed.run.remediation_cycles).toBe(0);
    expect(reviewed.run.tickets).toHaveLength(1);
    expect(reviewed.run.tickets.some((ticket) => ticket.writable === true)).toBe(false);
    expect(reviewed.actions.some((action) => action.type === 'dispatch_agent')).toBe(false);
  }, 30_000);
});

// ---------------------------------------------------------------------------
// A6 — both renderers project ONE machine state and must not drift apart.
// status-doc.js:9-33 STAGE_TO_MILESTONE has no default, so an unmapped stage
// yields currentMilestone null (:66) and currentRank -1 (:161): the document
// renders 'stage 0 of 3' with every box unchecked and 'Next: await scheduler'
// while a ticket is pending — the invariant-8 defect that file's own comment
// records for 'dispatch' and acme PR #354 fixed for 'aborted'.
// ---------------------------------------------------------------------------

const STATUSLINE = fileURLToPath(new URL('../bin/ape-statusline.mjs', import.meta.url));
// eslint-disable-next-line no-control-regex
const stripAnsi = (text) => text.replace(/\x1b\[[0-9;]*m/g, '');

function statuslineMilestoneWord(run) {
  const dir = mkdtempSync(path.join(tmpdir(), 'ape-remediation-test-statusline-'));
  try {
    mkdirSync(path.join(dir, '.ape', 'runtime'), { recursive: true });
    writeFileSync(path.join(dir, '.ape', 'runtime', 'active.json'), JSON.stringify(run));
    const env = {
      ...process.env,
      APE_STATUSLINE_CHARSET: 'unicode',
      APE_STATUSLINE_GIT_TIMEOUT_MS: '5000',
    };
    // The renderer honours host project pins; strip the ambient ones so this
    // repo cannot leak into the scratch project's root resolution.
    delete env.CLAUDE_PROJECT_DIR;
    delete env.CODEX_CWD;
    const out = stripAnsi(execFileSync('node', [STATUSLINE], {
      input: JSON.stringify({ workspace: { current_dir: dir } }),
      encoding: 'utf8',
      env,
    }));
    // unicode charset joins every segment with ' · '; the milestone-carrying
    // stage box is the segment right after the `APE <mode>/<lane>` identity box.
    const parts = out.split(' · ').map((part) => part.trim());
    const identity = parts.findIndex((part) => part.startsWith('APE '));
    return identity >= 0 ? parts[identity + 1] ?? null : null;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe('both renderers place remediation-test at the test milestone (A6)', () => {
  const remediationTestRun = {
    mode: 'phase',
    lane: 'fast',
    status: 'running',
    stage: 'remediation-test',
    tickets: [{ ticket_id: 't1' }, { ticket_id: 't2' }],
    receipts: [{ ticket_id: 't1' }],
  };

  it('renders the run at the test milestone instead of stage 0 with every box unchecked', () => {
    const doc = renderStatusDoc({
      ...remediationTestRun,
      objective: 'Close the remediation-test path role gap',
      branch: 'ape/phase-abc',
    });
    expect(doc).toContain('stage 1 of 3');
    expect(doc).not.toContain('stage 0 of 3');
    expect(doc).toMatch(/- \[ \] test[^\n]*◀/);
    const next = doc.split('\n').find((line) => line.startsWith('Next: '));
    expect(next).toBe('Next: advance to build');
  });

  it('places the run at the same milestone the spawned statusline reports', () => {
    // Ask the statusline itself — spawned exactly as a host spawns it — which
    // milestone a remediation-test run occupies, then require the status doc to
    // agree. Neither renderer can drift alone.
    const word = statuslineMilestoneWord(remediationTestRun);
    expect(word).toBe('test');
    const doc = renderStatusDoc({
      ...remediationTestRun,
      objective: 'Parity',
      branch: 'ape/phase-abc',
    });
    expect(doc).toMatch(new RegExp(`- \\[ \\] ${word}[^\\n]*◀`));
  }, 30_000);
});
