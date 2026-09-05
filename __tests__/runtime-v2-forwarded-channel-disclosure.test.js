import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { EVIDENCE_COMMAND_FAMILIES } from '../lib/runtime/hooks.js';

// ===========================================================================
// Roadmap entry forwarded-evidence-and-judge-visibility. This file arms part
// of that entry and does not by itself satisfy it; the entry spans every
// forwarding channel and its status is derived by the runtime, never asserted
// here. The scope_expansion channel below — this file's own headline gap —
// once reached only a single-member group's first-issue remediation-build. A
// blocking review named three further reachable shapes, and all three are now
// STATE-DERIVED in the runtime and armed by the describe blocks at the end of
// this file: a genuinely two-member group whose growth is proposed by a
// receipt other than the one completing the group (groupScopeExpansion,
// reducer.js), the remediation-test route (the `carried` flag, lifecycle-service.js),
// and a remediation-build retry (both retry arms forward ticket.scope_expansion
// unchanged). This header states the suite's actual coverage rather than the
// entry's status, so it stays true independent of when that entry closes.
// Acceptance clause: "every forwarding channel's own prose must state what it
// drops (per-entry character cut, entry-count cap, and which receipt fields
// are forwarded to which roles at all), verified against the runtime rather
// than asserted, with a behavioral arm per channel that a bounded or absent
// channel is DISCLOSED to the receiving role rather than silently narrowed."
//
// THE POPULATION, DERIVED FROM SOURCE (mechanism, not a pinned count — every
// enumeration of this kind in this codebase has gone stale at least once):
// any receipt-derived, agent-authored evidence a review or plan-review
// receipt can place onto a LATER ticket. Re-derived against the tree at
// authoring time, not merely cited: review_findings (reviewFindings /
// boundReviewFinding / boundReviewFindingsBlock, review-evidence.js), prior_attempts
// (attemptSummaryList, review-evidence.js), plan_artifact (planArtifact,
// receipt-service.js), the test_remediation reason (testRemediationNotice,
// lifecycle-service.js), the expired-predecessor notice (expiredPredecessorNotice,
// lifecycle-service.js), the planner's own `findings` array (SEVERED — forwarded to no
// reviewer by any route), and scope_expansion (extractScopeExpansion,
// receipt-service.js, applied by the SCOPE_EXPANDED reducer arm in reducer.js).
//
// ONE STRUCTURAL SIBLING IS DELIBERATELY EXCLUDED, on the record, by
// mechanism rather than left as an unexplained gap in the count: the
// reviewer-declared test-remediation PATH LIST itself (as opposed to its
// `reason`, which the test_remediation describe block below covers).
// pipeline.js's declaredTestRemediationPaths unions extractTestRemediation's
// validated paths, and narrowedTestClaims (service.js) writes them onto the
// remediation-test ticket's claimed_paths AND test_paths — structurally the
// same shape as scope_expansion's claimed_paths growth. It is excluded here
// because pipeline.js's extractTestRemediation confines every declared path
// to withinTestScope(normalized, ticket.test_paths) before accepting it: the
// declaration can only POINT INSIDE the run's existing test claims, never
// grow them, so — unlike scope_expansion — there is no wider claim set for a
// receiving ticket to be kept ignorant of. __tests__/runtime-v2-prose-bound-
// bypass-routes.test.js:17-19 names this same sibling relationship in its own
// words ("the declared structural sibling of extractScopeExpansion").
//
// WHAT THIS FILE ARMS, BY MECHANISM RATHER THAN A HEADCOUNT. Two channels
// already had their disclosure mechanism landed by an earlier, already-merged
// phase (__tests__/runtime-v2-plan-artifact-forwarding.test.js arms k-n added
// the plan-judge wiring; prompts/plan_judge.md:20-27 carries the prompt side):
// the planner's own `findings` array (SEVERED — first describe block below)
// and the plan-judge's own review_findings channel (second describe block
// below). Both are VERIFY-ONLY here, re-confirmed rather than re-implemented.
// This run adds four more real arms, closing the remaining gaps the previous
// attempt at this entry left open or missed outright:
//   * scope_expansion — the headline gap: extractScopeExpansion admits an
//     UNBOUNDED path count and per-path length, and the claim set really
//     does grow (service.js ticketClaims). A disclosure now names that
//     growth on the next writable ticket's own objective, which the third
//     describe block below both exercises and requires to stay bounded
//     rather than reproducing an adversarial proposal byte for byte. The
//     disclosure is STATE-DERIVED rather than keyed to whichever receipt
//     happens to complete the group, which is what makes the three shapes
//     armed at the end of this file hold: a genuinely two-member group in
//     which the growth is proposed by a receipt that is NOT the one
//     completing the group (groupScopeExpansion reads state.pending_scope_
//     expansions back from every member); a receipt declaring scope_expansion
//     together with test_remediation, which routes to remediation-test — a
//     ticket narrowedTestClaims confines to the declared TEST paths only, so
//     the notice names the remediation-build that follows as the ticket
//     carrying the grown set rather than claiming this one does; and a RETRY
//     of a remediation-build the growth already landed on, which inherits the
//     disclosure alongside the grown claimed_paths because both retry arms
//     forward ticket.scope_expansion, the same way they already re-thread
//     prior_attempts and review_findings. Each member's reason is bounded
//     where it is recorded and only then joined, so a co-reviewer's
//     justification is never swallowed whole by another's.
//   * review_findings — the ticket-facing notice existed (roadmap entry
//     review-findings-ticket-notice) but stated none of the three ceilings
//     scheduler.js actually enforces, unlike PLAN_ARTIFACT_NOTICE's own two
//     interpolated digits. The fourth describe block below derives the real
//     ceilings from scheduler.js's own source text at test time — never a
//     literal pinned here — and requires the notice to state the same ones.
//   * the test_remediation reason — testRemediationNotice already bounds the
//     reviewer's reason (boundedGateSummary) but never told the reader so.
//     The fifth describe block derives the real cut length from service.js's
//     own source text and requires the notice to state it.
//   * prior_attempts — the one channel this run cannot close with a
//     ticket-side notice at all, recorded as an accepted residual rather than
//     silently left asymmetric with its siblings. Every ticket-side notice
//     this file's own first two describe blocks and the two arms above rely
//     on is additive to a FIXED, presence-keyed template
//     (lib/runtime/service.js issueTicket); __tests__/runtime-v2-review-
//     findings-ticket-notice.test.js — UNCLAIMED by this run, not editable —
//     already pins that template shape two ways a prior_attempts notice
//     cannot satisfy simultaneously: its arm (c) requires a remediation-build
//     RETRY's objective to be BYTE-IDENTICAL to the first issue's even though
//     only the retry carries prior_attempts (:486/:492 pin
//     `retry.objective === remediation.objective` alongside a non-empty
//     `retry.prior_attempts`), and its arm (d) requires a first-attempt plan
//     ticket's notice region to be the empty string (:516-517). A
//     presence-keyed prior_attempts notice fails the first; a notice attached
//     unconditionally to EVERY ticket fails the second. A third, narrower
//     shape — attached unconditionally but keyed to one STAGE only, the way
//     TEST_REMEDIATION_NOTICE (service.js) is keyed to remediation-test — is
//     NOT excluded by these two arms alone: keyed to remediation-build it
//     would make (c)'s retry and first issue byte-identical (neither arm
//     depends on prior_attempts actually being present) and would still
//     leave (d)'s PLAN ticket's notice region empty (a plan ticket is never
//     remediation-build). It is set aside on a DIFFERENT ground these two
//     arms cannot test: the generic retry arm (scheduler.js's
//     RECEIPT_RECORDED handling) threads prior_attempts onto a retry of ANY
//     stage whose receipt failed, not only remediation-build, so a notice
//     keyed to one stage would leave every other retryable stage's own
//     prior_attempts exactly as undisclosed as today — the same silent
//     narrowing this entry exists to close, moved rather than fixed. So the
//     disclosure this entry's acceptance clause requires can only be made at
//     the ROLE PROMPT level — the one surface prompts/common.md already
//     partially covers for this exact channel — and the sixth describe block
//     below closes THAT gap: prompts/common.md called prior_attempts merely
//     "bounded" with neither the per-entry cut nor its mechanism stated,
//     unlike its siblings in the same paragraph. This is recorded here as a forced,
//     asymmetric disclosure, not implied to match the uniform per-ticket
//     shape every other channel gets.
//
// Two channels are already fully armed by an EARLIER phase and are
// deliberately NOT re-armed here, so this file stays additive rather than
// duplicating coverage: plan_artifact (12 x 200 + omission marker, ALREADY
// GREEN at __tests__/runtime-v2-plan-artifact-disclosure.test.js) and the
// expired-predecessor notice (20 paths x 200 WITH its own omission marker,
// re-verified against service.js's expiredPredecessorNotice at authoring time
// and found already fully disclosed). Neither should be read as "closed by
// this suite" — each carries its own disclosure obligation from the phase
// that armed it.
//
// THERE IS NO review_findings CHANNEL ONTO plan-check OR plan-critic. An
// earlier plan for this entry asserted one; an arm for it would be red
// forever, which is exactly the unsatisfiable-red authoring fault this
// codebase's own test-writer contract forbids. No such arm exists here.
// ===========================================================================

vi.mock('../lib/runtime/gates.js', async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, autoMergeGithub: vi.fn(), pollRemoteChecksAndMerge: vi.fn() };
});
import { recordReceipt, startRun } from '../lib/runtime/service.js';
import { runtimePaths } from '../lib/runtime/paths.js';
import { atomicWriteJson } from '../lib/runtime/storage.js';

const cleanups = [];
afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

function git(cwd, ...args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

async function project() {
  const dir = await mkdtemp(path.join(tmpdir(), 'ape-channel-disclosure-'));
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
    test_commands: { targeted_template: 'node --test {paths}', full: 'node --test' },
  });
  return dir;
}

function startInput(overrides = {}) {
  return {
    objective: 'Enumerate every forwarding channel and verify its own disclosure',
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

describe('planner findings array stays severed on every plan-review stage', () => {
  it('forwards no planner finding and keeps the immutable objective byte-identical', async () => {
    const dir = await project();
    const started = await startRun(dir, startInput());
    expect(started.ok, JSON.stringify({ reason: started.reason, blocking: started.readiness?.blocking })).toBe(true);
    const planTicket = started.run.tickets[0];
    const recorded = await recordReceipt(dir, receipt(planTicket, {
      evidence: { verdict: 'pass', summary: 'clean plan' },
      findings: [
        { file: 'lib/runtime/service.js', line: 1, detail: 'THIS-MUST-NEVER-REACH-A-REVIEWER' },
      ],
    }));
    expect(recorded.ok).toBe(true);
    const planCheck = recorded.run.tickets.find((ticket) => ticket.stage_id === 'plan-check');
    const planCritic = recorded.run.tickets.find((ticket) => ticket.stage_id === 'plan-critic');
    for (const ticket of [planCheck, planCritic]) {
      expect(JSON.stringify(ticket)).not.toContain('THIS-MUST-NEVER-REACH-A-REVIEWER');
      expect(ticket.objective).toBe(startInput().objective);
      expect(ticket).not.toHaveProperty('review_findings');
    }
  }, 30_000);
});

describe('the plan-judge review_findings channel discloses a truncated bound the SAME way a remediation ticket already does (the one genuinely new channel)', () => {
  it('when the disagreeing plan-critic\'s findings exceed the shared 40-entry cap, the judge\'s review_findings ends with the runtime\'s own drop-disclosure entry', async () => {
    const dir = await project();
    const started = await startRun(dir, startInput());
    expect(started.ok).toBe(true);
    const planTicket = started.run.tickets[0];
    const recorded = await recordReceipt(dir, receipt(planTicket, { evidence: { verdict: 'pass' } }));
    expect(recorded.ok).toBe(true);
    const planCheck = recorded.run.tickets.find((ticket) => ticket.stage_id === 'plan-check');
    const planCritic = recorded.run.tickets.find((ticket) => ticket.stage_id === 'plan-critic');
    const checked = await recordReceipt(dir, receipt(planCheck, { evidence: { verdict: 'agree' } }));
    expect(checked.ok).toBe(true);
    const manyFindings = Array.from({ length: 45 }, (_, index) => ({
      file: 'lib/runtime/service.js',
      line: 100 + index,
      detail: 'x'.repeat(300),
    }));
    const criticed = await recordReceipt(dir, receipt(planCritic, {
      evidence: { verdict: 'disagree' },
      findings: manyFindings,
    }));
    expect(criticed.ok).toBe(true);
    const judge = criticed.run.tickets.at(-1);
    expect(judge.stage_id).toBe('plan-judge');
    expect(Array.isArray(judge.review_findings)).toBe(true);
    const last = judge.review_findings.at(-1) ?? '';
    // The EXACT disclosure phrase scheduler.js's boundReviewFindingsBlock
    // already emits for a remediation ticket's own overflow — proving the
    // judge's channel is the SAME shared mechanism, not a second one that
    // could silently disagree with it about what dropping looks like.
    expect(last).toMatch(/were dropped by this ticket's bound/);
    expect(last).toMatch(/plan-critic/);
  }, 30_000);
});

// ===========================================================================
// The four real arms this run adds, below. Shared helpers first.
// ===========================================================================

const REPO_ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

function readRepoFile(...segments) {
  return readFileSync(path.join(REPO_ROOT, ...segments), 'utf8');
}

function readOwnerFile(owner) {
  const relative = path.posix.join('lib/runtime', owner);
  const absolute = path.join(REPO_ROOT, relative);
  expect(existsSync(absolute), `genuine owner ${relative} exists`).toBe(true);
  return readFileSync(absolute, 'utf8');
}

// Derive a numeric constant from a source FILE'S OWN TEXT at test-execution
// time, rather than pinning a copy of it in this file: a retune of the real
// constant moves this test's expectation with it instead of leaving a stale
// literal that quietly stops proving anything (this run's own objective rule
// against pinning a count that can go stale). Tolerant of the numeric-
// separator underscores this codebase's constants use (`1_000`, `10_000`).
function deriveIntConst(sourceText, constName) {
  const match = sourceText.match(new RegExp(`^export const ${constName}\\s*=\\s*([0-9_]+)`, 'm'));
  expect(match, `genuine owner directly declares ${constName}`).not.toBeNull();
  return Number(match[1].replaceAll('_', ''));
}

// ticketObjective (service.js) renders
// `${prefix}. Recognized evidence commands: ${EVIDENCE_COMMAND_FAMILIES}.${notice} Run objective: ${run.objective}`
// — reconstructed here from the SAME exported constant the runtime uses,
// mirroring __tests__/runtime-v2-review-findings-ticket-notice.test.js's own
// `head`/`noticeRegion` pair, so the notice under test is isolated from the
// (long, unrelated) evidence-commands prose rather than searched for inside
// the whole objective string.
function head(prefix) {
  return `${prefix}. Recognized evidence commands: ${EVIDENCE_COMMAND_FAMILIES}.`;
}
const REMEDIATION_BUILD_HEAD = head('Remediate the grounded review findings');
const REMEDIATION_TEST_HEAD = head(
  'Correct only the authored tests the blocking review declared, then leave the production fix ' +
  'to the remediation build; this ticket is narrowed to the declared test paths (a file-shaped ' +
  'path also covers its directory) and to no production path at all',
);

function noticeRegion(objective, prefixHead, suffix) {
  expect(objective.startsWith(prefixHead)).toBe(true);
  expect(objective.endsWith(suffix)).toBe(true);
  const cut = objective.length - suffix.length;
  expect(objective[cut - 1]).toBe(' ');
  return objective.slice(prefixHead.length, cut - 1);
}

// A dedicated, CJS-based project fixture for the four arms below: they each
// need a real test-writer -> implementer -> reviewer walk (the runtime
// actually re-executes `test_commands`, so the authored fixtures must really
// fail then really pass), which the two describe blocks above never needed.
// Kept separate from `project`/`startInput` above so neither shares mutable
// assumptions with the plan-only walks those blocks perform.
const FLOW_RUN_OBJECTIVE = 'Disclose forwarded evidence honestly to the receiving role';
const FLOW_VALUE_V1 = 'module.exports = { value: 1 };\n';
const FLOW_VALUE_V2 = 'module.exports = { value: 2 };\n';
const FLOW_AUTHORED_TEST =
  "const { value } = require('../src/value.js');\n" +
  "if (value !== 2) { throw new Error('red: value is ' + value); }\n";
const flowRedTest = [{ command: 'node tests/value.test.js', passed: false, exit_code: 1, duration_ms: 1 }];
const flowGreenTest = [{ command: 'node tests/value.test.js', passed: true, exit_code: 0, duration_ms: 1 }];

function flowProductionFinding(file = 'src/value.js', detail = 'apply the bounded production correction') {
  return {
    file,
    line: 1,
    title: 'bounded production correction',
    detail,
    blocking: true,
    remediation: { owner: 'production' },
  };
}

function flowTestFinding(detail = 'correct the authored assertion') {
  return {
    file: 'tests/value.test.js',
    line: 1,
    title: 'authored assertion correction',
    detail,
    blocking: true,
    remediation: { owner: 'test', test_paths: ['tests/value.test.js'] },
  };
}

async function reviewFlowProject() {
  const dir = await mkdtemp(path.join(tmpdir(), 'ape-channel-flow-'));
  cleanups.push(dir);
  await mkdir(path.join(dir, 'src'));
  await mkdir(path.join(dir, 'tests'));
  await writeFile(path.join(dir, 'src', 'value.js'), FLOW_VALUE_V1);
  await writeFile(path.join(dir, 'tests', 'value.test.js'), 'throw new Error("placeholder");\n');
  git(dir, 'init', '-q');
  git(dir, 'config', 'user.email', 'ape@example.test');
  git(dir, 'config', 'user.name', 'APE Test');
  git(dir, 'add', '.');
  git(dir, 'commit', '-qm', 'test: baseline');
  await atomicWriteJson(runtimePaths(dir).config, {
    shipping: { auto_merge: false, provider: 'github', required_remote_checks: false },
    test_commands: { full: 'node -e "process.exit(0)"', targeted: 'node tests/value.test.js' },
  });
  return dir;
}

function flowStartInput(overrides = {}) {
  return {
    objective: FLOW_RUN_OBJECTIVE,
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
    ...overrides,
  };
}

async function walkToReviewFlow(dir, overrides = {}) {
  const started = await startRun(dir, flowStartInput(overrides));
  expect(started.ok, JSON.stringify(started.errors ?? [])).toBe(true);
  expect(started.run.lane).toBe('fast');
  const testTicket = started.run.tickets[0];
  expect(testTicket.role).toBe('test_writer');
  await writeFile(path.join(dir, 'tests', 'value.test.js'), FLOW_AUTHORED_TEST);
  const tested = await recordReceipt(dir, receipt(testTicket, { tests: flowRedTest }));
  expect(tested.ok, JSON.stringify(tested.errors ?? [])).toBe(true);
  const buildTicket = tested.run.tickets.at(-1);
  expect(buildTicket.stage_id).toBe('build');
  await writeFile(path.join(dir, 'src', 'value.js'), FLOW_VALUE_V2);
  const built = await recordReceipt(dir, receipt(buildTicket, { tests: flowGreenTest }));
  expect(built.ok, JSON.stringify(built.errors ?? [])).toBe(true);
  const reviewTicket = built.run.tickets.at(-1);
  expect(reviewTicket.stage_id).toBe('review');
  return { testTicket, buildTicket, reviewTicket };
}

describe('a reviewer-proposed scope expansion is carried structurally to the next writable ticket', () => {
  it('preserves a small proposal and bounds an adversarially large one without rewriting the objective', async () => {
    // Baseline: what a remediation-build ticket's objective looks like with a
    // blocking review and NO scope expansion at all, on this exact tree and
    // config, so the bulk phase below can assert a REAL bound instead of a
    // guessed byte count.
    const dir0 = await reviewFlowProject();
    const { reviewTicket: reviewTicket0 } = await walkToReviewFlow(dir0);
    const reviewed0 = await recordReceipt(dir0, receipt(reviewTicket0, {
      tests: flowGreenTest,
      findings: [flowProductionFinding('src/value.js', 'the change is incomplete')],
      evidence: { verdict: 'fail', summary: 'the change is incomplete' },
    }));
    expect(reviewed0.ok, JSON.stringify(reviewed0.errors ?? [])).toBe(true);
    const remediation0 = reviewed0.run.tickets.at(-1);
    expect(remediation0.stage_id).toBe('remediation-build');
    expect(remediation0.objective).toBe(FLOW_RUN_OBJECTIVE);
    expect(remediation0).not.toHaveProperty('scope_expansion');

    // Phase A: a small proposal needs no truncation at all.
    const dirA = await reviewFlowProject();
    const { reviewTicket: reviewTicketA } = await walkToReviewFlow(dirA);
    const addedPath = 'src/scope-expansion-added-module.js';
    const reason =
      'SCOPEREASONMARKER the fix cannot land without also touching the shared helper module named above';
    const reviewedA = await recordReceipt(dirA, receipt(reviewTicketA, {
      tests: flowGreenTest,
      findings: [flowProductionFinding(addedPath, 'the change is incomplete without an out-of-claims file')],
      evidence: {
        verdict: 'fail',
        summary: 'the change is incomplete without an out-of-claims file',
        scope_expansion: { claimed_paths: [addedPath], reason },
      },
    }));
    expect(reviewedA.ok, JSON.stringify(reviewedA.errors ?? [])).toBe(true);
    const remediationA = reviewedA.run.tickets.at(-1);
    expect(remediationA.stage_id).toBe('remediation-build');
    // The claim set really did grow — sanity, not the gap this run closes.
    expect(remediationA.claimed_paths).toContain(addedPath);
    expect(remediationA.objective).toBe(FLOW_RUN_OBJECTIVE);
    expect(remediationA.scope_expansion).toEqual({ claimed_paths: [addedPath], reason });

    // Phase B: an adversarially large proposal.
    const dirB = await reviewFlowProject();
    const { reviewTicket: reviewTicketB } = await walkToReviewFlow(dirB);
    const filler = 'x'.repeat(300);
    const addedPaths = Array.from(
      { length: 60 },
      (_, index) => `src/scope-bulk-${String(index).padStart(3, '0')}-${filler}.js`,
    );
    const longReason = 'SCOPEREASONBULK-UNIQUE-TAIL '.repeat(150);
    const reviewedB = await recordReceipt(dirB, receipt(reviewTicketB, {
      tests: flowGreenTest,
      findings: [flowProductionFinding(addedPaths[0], 'the change needs a large, out-of-claims rename set')],
      evidence: {
        verdict: 'fail',
        summary: 'the change needs a large, out-of-claims rename set',
        scope_expansion: { claimed_paths: addedPaths, reason: longReason },
      },
    }));
    expect(reviewedB.ok, JSON.stringify(reviewedB.errors ?? [])).toBe(true);
    const remediationB = reviewedB.run.tickets.at(-1);
    expect(remediationB.stage_id).toBe('remediation-build');
    // The write allowlist really did grow by all 60 — this arm is not about
    // that; scope_expansion's own admission is exercised elsewhere.
    for (const claimedPath of addedPaths) expect(remediationB.claimed_paths).toContain(claimedPath);
    const receiptSource = readOwnerFile('receipt-service.js');
    const pathMax = deriveIntConst(receiptSource, 'SCOPE_EXPANSION_PATHS_MAX');
    const pathChars = deriveIntConst(receiptSource, 'SCOPE_EXPANSION_PATH_MAX_CHARS');
    const reasonChars = deriveIntConst(receiptSource, 'SCOPE_EXPANSION_REASON_MAX_CHARS');
    expect(remediationB.objective).toBe(FLOW_RUN_OBJECTIVE);
    expect(remediationB.scope_expansion.claimed_paths.length).toBeLessThanOrEqual(pathMax);
    expect(remediationB.scope_expansion.claimed_paths.every((entry) => entry.length <= pathChars)).toBe(true);
    expect(remediationB.scope_expansion.claimed_paths.at(-1)).toMatch(/not listed here/i);
    expect(remediationB.scope_expansion.reason.length).toBeLessThanOrEqual(reasonChars);
    expect(remediationB.scope_expansion.reason).not.toBe(longReason);
  }, 90_000);
});

describe('the structured review_findings field stays within the scheduler bounds', () => {
  it('carries bounded findings without embedding transport prose in the objective', async () => {
    const reviewEvidenceSource = readOwnerFile('review-evidence.js');
    const maxEntries = deriveIntConst(reviewEvidenceSource, 'REVIEW_FINDINGS_MAX');
    const maxBlockChars = deriveIntConst(reviewEvidenceSource, 'REVIEW_FINDINGS_BLOCK_LIMIT');
    expect(maxBlockChars).toBeGreaterThan(maxEntries);

    const dir = await reviewFlowProject();
    const { reviewTicket } = await walkToReviewFlow(dir);
    const reviewed = await recordReceipt(dir, receipt(reviewTicket, {
      tests: flowGreenTest,
      findings: [flowProductionFinding('src/value.js', 'a defect worth remediating')],
      evidence: { verdict: 'fail', summary: 'a defect worth remediating' },
    }));
    expect(reviewed.ok, JSON.stringify(reviewed.errors ?? [])).toBe(true);
    const remediation = reviewed.run.tickets.at(-1);
    expect(remediation.stage_id).toBe('remediation-build');
    expect(Array.isArray(remediation.review_findings)).toBe(true);
    expect(remediation.review_findings.length).toBeGreaterThan(0);

    expect(remediation.objective).toBe(FLOW_RUN_OBJECTIVE);
    expect(remediation.review_findings.length).toBeLessThanOrEqual(maxEntries);
    expect(JSON.stringify(remediation.review_findings).length).toBeLessThanOrEqual(maxBlockChars);
  }, 60_000);
});

describe('test remediation uses structured review evidence with an immutable objective', () => {
  it('routes to remediation-test without objective decoration', async () => {
    const lifecycleSource = readOwnerFile('lifecycle-service.js');
    const cutMatch = lifecycleSource.match(
      /^function testRemediationNotice\s*\([^)]*\)\s*\{[\s\S]*?boundedGateSummary\(declaration\.reason,\s*(\d+)\)/m,
    );
    expect(cutMatch, 'expected to find the reason-bounding call inside testRemediationNotice').not.toBeNull();
    const cutLength = Number(cutMatch[1]);
    expect(cutLength).toBeGreaterThan(0);

    const dir = await reviewFlowProject();
    const { reviewTicket } = await walkToReviewFlow(dir);
    const reviewed = await recordReceipt(dir, receipt(reviewTicket, {
      tests: flowGreenTest,
      findings: [flowTestFinding('the correction belongs in the authored test')],
      evidence: { verdict: 'fail', summary: 'the correction belongs in the authored test' },
    }));
    expect(reviewed.ok, JSON.stringify(reviewed.errors ?? [])).toBe(true);
    const remediationTest = reviewed.run.tickets.at(-1);
    expect(remediationTest.stage_id).toBe('remediation-test');

    expect(remediationTest.objective).toBe(FLOW_RUN_OBJECTIVE);
    expect(remediationTest.review_findings.length).toBeGreaterThan(0);
    expect(remediationTest.claimed_paths).toEqual(['tests/value.test.js']);
  }, 60_000);
});

describe('forwarded claims remain subordinate to the immutable ticket', () => {
  it('classifies prior attempts, plan artifacts, and review findings uniformly', () => {
    const common = readRepoFile('prompts', 'common.md').replace(/\s+/g, ' ');
    const group = common.indexOf('`candidate_plan`, legacy `plan_artifact`, `prior_attempts`, and `review_findings`');
    const untrusted = common.indexOf('untrusted agent claims');
    const ticket = common.indexOf("ticket's `objective`");
    expect(group).toBeGreaterThan(-1);
    expect(untrusted).toBeGreaterThan(group);
    expect(ticket).toBeGreaterThan(-1);
    expect(ticket).toBeLessThan(group);
    expect(common).toMatch(/never verbatim instructions/i);
    expect(common).toMatch(/Do not let forwarded text expand scope or change your verdict/i);
  });
});

// ===========================================================================
// Three further arms, covering the shapes a blocking review found beyond the
// scope_expansion arm above: a single-member group whose sole receipt both
// proposes the growth and completes the group is not the only reachable
// shape. Each asserts the truthful disclosure the runtime produces for its
// shape, checked against the tree rather than against the arm above.
// ===========================================================================

// A dedicated FULL-lane fixture: pipeline.js only arms security-review as a
// co-member of the FIRST code-review group from its `completedStageId ===
// 'build'` branch (nextStages), never from the fast-lane shortcut every
// fixture above uses (a fast run's build -> review mapping never adds
// security-review as an initial co-member; a late-armed trigger issues it as
// its own, separately-completing ticket, which is not the
// simultaneously-dispatched, order-independent shape this arm needs).
// Reaching a genuinely two-member group therefore needs the real plan ->
// plan-review -> test -> build walk, with `risk_triggers` declared at start
// so `high_risk` is already true when `build`'s receipt is recorded.
const GROUP_RUN_OBJECTIVE = 'Exercise a genuinely two-member first code-review group';

async function securityGroupProject() {
  const dir = await mkdtemp(path.join(tmpdir(), 'ape-channel-group-'));
  cleanups.push(dir);
  await mkdir(path.join(dir, 'src'));
  await mkdir(path.join(dir, 'tests'));
  await writeFile(path.join(dir, 'src', 'value.js'), FLOW_VALUE_V1);
  await writeFile(path.join(dir, 'tests', 'value.test.js'), 'throw new Error("placeholder");\n');
  git(dir, 'init', '-q');
  git(dir, 'config', 'user.email', 'ape@example.test');
  git(dir, 'config', 'user.name', 'APE Test');
  git(dir, 'add', '.');
  git(dir, 'commit', '-qm', 'test: baseline');
  await atomicWriteJson(runtimePaths(dir).config, {
    shipping: { auto_merge: false, provider: 'github', required_remote_checks: false },
    test_commands: { full: 'node -e "process.exit(0)"', targeted: 'node tests/value.test.js' },
  });
  return dir;
}

function securityGroupStartInput(overrides = {}) {
  return {
    objective: GROUP_RUN_OBJECTIVE,
    mode: 'phase',
    lane: 'full',
    host: 'codex',
    claimed_paths: ['src/value.js'],
    test_paths: ['tests/value.test.js'],
    requirements: [],
    risk_triggers: ['security'],
    behavioral: true,
    hooks_trusted: true,
    subagents_available: true,
    explicit_invocation: true,
    ...overrides,
  };
}

// Walks a high_risk, full-lane run to its first code-review group and returns
// BOTH tickets the group dispatched together, unreceipted.
async function walkToSecurityGroup(dir) {
  const started = await startRun(dir, securityGroupStartInput());
  expect(started.ok, JSON.stringify(started.errors ?? [])).toBe(true);
  expect(started.run.lane).toBe('full');
  expect(started.run.high_risk).toBe(true);
  const planTicket = started.run.tickets[0];
  expect(planTicket.stage_id).toBe('plan');
  const planned = await recordReceipt(dir, receipt(planTicket, { evidence: { verdict: 'pass' } }));
  expect(planned.ok, JSON.stringify(planned.errors ?? [])).toBe(true);
  const planCheck = planned.run.tickets.find((ticket) => ticket.stage_id === 'plan-check');
  const planCritic = planned.run.tickets.find((ticket) => ticket.stage_id === 'plan-critic');
  const checked = await recordReceipt(dir, receipt(planCheck, { evidence: { verdict: 'agree' } }));
  expect(checked.ok, JSON.stringify(checked.errors ?? [])).toBe(true);
  const criticed = await recordReceipt(dir, receipt(planCritic, { evidence: { verdict: 'agree' } }));
  expect(criticed.ok, JSON.stringify(criticed.errors ?? [])).toBe(true);
  const testTicket = criticed.run.tickets.at(-1);
  expect(testTicket.stage_id).toBe('test');
  await writeFile(path.join(dir, 'tests', 'value.test.js'), FLOW_AUTHORED_TEST);
  const tested = await recordReceipt(dir, receipt(testTicket, { tests: flowRedTest }));
  expect(tested.ok, JSON.stringify(tested.errors ?? [])).toBe(true);
  const buildTicket = tested.run.tickets.at(-1);
  expect(buildTicket.stage_id).toBe('build');
  await writeFile(path.join(dir, 'src', 'value.js'), FLOW_VALUE_V2);
  const built = await recordReceipt(dir, receipt(buildTicket, { tests: flowGreenTest }));
  expect(built.ok, JSON.stringify(built.errors ?? [])).toBe(true);
  const group = built.run.tickets.slice(-2);
  expect(group.map((ticket) => ticket.stage_id).sort()).toEqual(['review', 'security-review']);
  return {
    reviewTicket: group.find((ticket) => ticket.stage_id === 'review'),
    securityTicket: group.find((ticket) => ticket.stage_id === 'security-review'),
  };
}

describe('a scope expansion proposed by the FIRST-arriving receipt of a genuinely two-member review group is disclosed on the remediation ticket regardless of which receipt completes the group', () => {
  it('the growth and the reason must land on the group\'s remediation-build ticket exactly as they do for a single-member group, regardless of which receipt actually completes the group', async () => {
    const dir = await securityGroupProject();
    const { reviewTicket, securityTicket } = await walkToSecurityGroup(dir);

    const addedPath = 'src/scope-multi-member-added-module.js';
    const reason =
      'MULTIMEMBERSCOPEREASON the fix cannot land without also touching the shared helper module named above';

    // The FIRST-arriving receipt proposes the growth. The group is not
    // complete yet — security-review is still outstanding — so this
    // reduction issues no ticket at all.
    const first = await recordReceipt(dir, receipt(reviewTicket, {
      tests: flowGreenTest,
      findings: [flowProductionFinding(addedPath, 'the change is incomplete without an out-of-claims file')],
      evidence: {
        verdict: 'fail',
        summary: 'the change is incomplete without an out-of-claims file',
        scope_expansion: { claimed_paths: [addedPath], reason },
      },
    }));
    expect(first.ok, JSON.stringify(first.errors ?? [])).toBe(true);
    // The claim set really did grow immediately: SCOPE_EXPANDED patches
    // state.claimed_paths unconditionally and never waits for the group.
    expect(first.run.claimed_paths).toContain(addedPath);
    // Nothing is dispatched yet: the other member is still outstanding.
    expect(first.actions.some((action) => action.type === 'dispatch_agent')).toBe(false);

    // The SECOND-arriving receipt is what actually completes the group and
    // issues the remediation ticket — but it never declared a scope
    // expansion of its own.
    const second = await recordReceipt(dir, receipt(securityTicket, { tests: flowGreenTest }));
    expect(second.ok, JSON.stringify(second.errors ?? [])).toBe(true);
    const remediation = second.run.tickets.at(-1);
    expect(remediation.stage_id).toBe('remediation-build');
    // The grown write allowlist really did reach the remediation ticket...
    expect(remediation.claimed_paths).toContain(addedPath);
    expect(remediation.objective).toBe(GROUP_RUN_OBJECTIVE);
    expect(remediation.scope_expansion.claimed_paths).toContain(addedPath);
    expect(remediation.scope_expansion.reason).toContain('MULTIMEMBERSCOPEREASON');
  }, 90_000);

  // When BOTH members declare an expansion, each one's reason justifies its
  // own paths. Bounding the JOIN rather than each entry would let the
  // first-listed reason consume the whole budget and delete the second
  // member's justification whole — and the order is deterministic (pipeline.js
  // issues review before security-review, and the group read follows issuance
  // order), so it would always be the security reviewer's reason that
  // vanished. The per-reason cut is derived from service.js at test time
  // rather than pinned, so this arm cannot go stale if the ceiling moves.
  it('bounds EACH declaring member\'s reason on its own budget, so an over-long first reason cannot swallow a co-reviewer\'s justification', async () => {
    const dir = await securityGroupProject();
    const { reviewTicket, securityTicket } = await walkToSecurityGroup(dir);

    const receiptSource = readOwnerFile('receipt-service.js');
    const reasonCut = deriveIntConst(receiptSource, 'SCOPE_EXPANSION_REASON_MAX_CHARS');
    expect(Number.isInteger(reasonCut) && reasonCut > 0).toBe(true);

    const reviewPath = 'src/scope-both-members-review-module.js';
    const securityPath = 'src/scope-both-members-security-module.js';
    // The first-listed reason alone exceeds the per-reason ceiling, so a
    // join-then-cut implementation has nothing left for the second.
    const reviewReason = `FIRSTMEMBERREASON ${'x'.repeat(reasonCut * 2)}`;
    const securityReason = 'SECONDMEMBERREASON the security fix needs its own out-of-claims module';

    const first = await recordReceipt(dir, receipt(reviewTicket, {
      tests: flowGreenTest,
      findings: [flowProductionFinding(reviewPath, 'the correctness fix needs an out-of-claims file')],
      evidence: {
        verdict: 'fail',
        summary: 'the correctness fix needs an out-of-claims file',
        scope_expansion: { claimed_paths: [reviewPath], reason: reviewReason },
      },
    }));
    expect(first.ok, JSON.stringify(first.errors ?? [])).toBe(true);

    const second = await recordReceipt(dir, receipt(securityTicket, {
      tests: flowGreenTest,
      findings: [flowProductionFinding(securityPath, 'the security fix needs a different out-of-claims file')],
      evidence: {
        verdict: 'fail',
        summary: 'the security fix needs a different out-of-claims file',
        scope_expansion: { claimed_paths: [securityPath], reason: securityReason },
      },
    }));
    expect(second.ok, JSON.stringify(second.errors ?? [])).toBe(true);

    const remediation = second.run.tickets.at(-1);
    expect(remediation.stage_id).toBe('remediation-build');
    // Both members' paths reached the write allowlist and structured evidence.
    expect(remediation.claimed_paths).toContain(reviewPath);
    expect(remediation.claimed_paths).toContain(securityPath);
    expect(remediation.scope_expansion.claimed_paths).toContain(reviewPath);
    expect(remediation.scope_expansion.claimed_paths).toContain(securityPath);
    // Both justifications survive. The second is the one a join-then-cut
    // implementation destroys, so it is the assertion that matters.
    expect(remediation.scope_expansion.reason).toContain('FIRSTMEMBERREASON');
    expect(remediation.scope_expansion.reason).toContain('SECONDMEMBERREASON');
    // The over-long first reason is still individually cut: its filler must
    // not reach the ticket in full.
    expect(remediation.scope_expansion.reason).not.toContain('x'.repeat(reasonCut * 2));
    expect(remediation.objective).toBe(GROUP_RUN_OBJECTIVE);
  }, 90_000);
});

describe('a receipt declaring scope_expansion together with test_remediation routes to remediation-test, whose own claimed_paths cannot carry the grown production path', () => {
  it('never claims this ticket "already carries" a path its own claimed_paths provably excludes, while still disclosing the growth to the next writable ticket', async () => {
    const dir = await reviewFlowProject();
    const { reviewTicket } = await walkToReviewFlow(dir);

    const addedPath = 'src/scope-test-route-added-module.js';
    const reviewed = await recordReceipt(dir, receipt(reviewTicket, {
      tests: flowGreenTest,
      findings: [
        flowProductionFinding(addedPath, 'the fix needs an out-of-claims module'),
        {
          file: 'tests/value.test.js',
          line: 1,
          title: 'authored assertion correction',
          detail: 'the assertion itself is wrong, not just the implementation',
          blocking: true,
          remediation: { owner: 'test', test_paths: ['tests/value.test.js'] },
        },
      ],
      evidence: {
        verdict: 'fail',
        summary: 'the fix needs an out-of-claims module and the correction belongs in the authored test',
        scope_expansion: {
          claimed_paths: [addedPath],
          reason: 'SCOPETESTROUTEREASON the production fix needs the module named above',
        },
      },
    }));
    expect(reviewed.ok, JSON.stringify(reviewed.errors ?? [])).toBe(true);
    const remediationTest = reviewed.run.tickets.at(-1);
    expect(remediationTest.stage_id).toBe('remediation-test');

    // Narrowing holds regardless of the scope growth: a test_writer ticket
    // never carries a production path (this ticket's own published contract,
    // REMEDIATION_TEST_HEAD above, says so in as many words).
    expect(remediationTest.claimed_paths).not.toContain(addedPath);
    expect(remediationTest.scope_expansion.claimed_paths).toContain(addedPath);
    expect(remediationTest.scope_expansion.reason).toContain('SCOPETESTROUTEREASON');
    expect(remediationTest.objective).toBe(FLOW_RUN_OBJECTIVE);
  }, 60_000);
});

describe('a scope expansion survives a remediation-build RETRY, not just the first issue', () => {
  it('discloses the added path and reason on the retry exactly as it did on the ticket it replaces', async () => {
    const dir = await reviewFlowProject();
    const { reviewTicket } = await walkToReviewFlow(dir);

    const addedPath = 'src/scope-retry-added-module.js';
    const reason = 'RETRYSCOPEREASON the retry must still know the scope grew, not just the first issue';
    const reviewed = await recordReceipt(dir, receipt(reviewTicket, {
      tests: flowGreenTest,
      findings: [flowProductionFinding(addedPath, 'the change is incomplete without an out-of-claims file')],
      evidence: {
        verdict: 'fail',
        summary: 'the change is incomplete without an out-of-claims file',
        scope_expansion: { claimed_paths: [addedPath], reason },
      },
    }));
    expect(reviewed.ok, JSON.stringify(reviewed.errors ?? [])).toBe(true);
    const remediation = reviewed.run.tickets.at(-1);
    expect(remediation.stage_id).toBe('remediation-build');
    expect(remediation.claimed_paths).toContain(addedPath);
    expect(remediation.scope_expansion).toEqual({ claimed_paths: [addedPath], reason });
    expect(remediation.objective).toBe(FLOW_RUN_OBJECTIVE);

    const failed = await recordReceipt(dir, receipt(remediation, {
      status: 'failed',
      tests: flowRedTest,
      evidence: { summary: 'remediation attempt failed' },
    }));
    expect(failed.ok, JSON.stringify(failed.errors ?? [])).toBe(true);
    const retry = failed.run.tickets.at(-1);
    expect(retry.stage_id).toBe('remediation-build');
    expect(retry.attempt).toBe(2);
    expect(retry.ticket_id).not.toBe(remediation.ticket_id);
    // The grown write allowlist persists onto the retry, exactly like
    // prior_attempts and review_findings already do (scheduler.js) ...
    expect(retry.claimed_paths).toContain(addedPath);
    expect(retry.scope_expansion).toEqual(remediation.scope_expansion);
    expect(retry.objective).toBe(FLOW_RUN_OBJECTIVE);
  }, 60_000);
});
