import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { EVIDENCE_COMMAND_FAMILIES } from '../lib/runtime/hooks.js';

// ===========================================================================
// Stage-to-stage evidence-channel residuals, audited against this tree AFTER
// the plan-judge dissent forwarding fix landed (__tests__/runtime-v2-
// forwarded-channel-disclosure.test.js). Seven were confirmed; this file arms
// the two the run objective REQUIRES behavioral coverage for — the
// review_findings whole-field prefix starvation (#2) and the unrenderable-
// findings drop-accounting defect (#3) — plus four further, independently
// satisfiable prose/mechanism corrections this audit found still open (#4-#7).
// One residual (#1, the planner findings severance disposition) is already
// fully closed and re-verified GREEN, on this tree, by
// runtime-v2-forwarded-channel-disclosure.test.js's own "planner findings
// array stays SEVERED ... (verify, not redo)" block, so it is deliberately
// NOT re-armed here.
//
// #4, RECORDED DISPOSITION RATHER THAN THE LITERAL SUGGESTION. The run
// objective proposes "a PRIOR_ATTEMPTS_NOTICE analogous to PLAN_ARTIFACT_
// NOTICE and REVIEW_FINDINGS_NOTICE" — a per-TICKET notice, presence-keyed on
// whether `prior_attempts` is attached. That literal shape is UNSATISFIABLE
// on this tree without breaking already-passing, unclaimed coverage:
// __tests__/runtime-v2-review-findings-ticket-notice.test.js arm (c) pins
// `retry.objective === remediation.objective` for a remediation-build RETRY
// (attempt 2, prior_attempts non-empty) against the FIRST issue (attempt 1,
// no prior_attempts at all) — so any notice keyed to prior_attempts's
// presence necessarily makes those two objectives diverge and fails that
// pinned arm; arm (d) separately pins an EMPTY notice region on a first-
// attempt, non-retry ticket, so an unconditional notice fails that arm
// instead. __tests__/runtime-v2-forwarded-channel-disclosure.test.js's own
// "prior_attempts: the one forwarded channel this run cannot disclose on the
// ticket itself" block already reasons through this exact contradiction and
// records the actual, satisfiable disposition: the disclosure lives at the
// ROLE-PROMPT level (prompts/common.md), not the ticket. That block already
// pins the per-entry character cut there; the gap THIS audit found is
// narrower — the same prompt clause never states the ENTRY-COUNT bound — and
// that is the one arm #4 below adds.
//
// SATISFIABILITY (test-writer's own duty, not the runtime's). Every arm below
// asserts one fact about a fixed, deterministic string (a runtime-authored
// notice constant or a checked-in prose file) or one fact about a real
// reducer/service run; nothing asserts a value and its negation about the
// same observation, and every assertion is answered by editing exactly the
// surface it names, independent of the others.
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

const REPO_ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

function readRepoFile(...segments) {
  return readFileSync(path.join(REPO_ROOT, ...segments), 'utf8');
}

// Derive a numeric constant from a source FILE'S OWN TEXT at test-execution
// time rather than pinning a hand-copied literal here, so a future retune of
// the real constant moves this test's expectation with it (the same
// technique __tests__/runtime-v2-forwarded-channel-disclosure.test.js uses).
function deriveIntConst(sourceText, constName) {
  const match = sourceText.match(new RegExp(`const ${constName}\\s*=\\s*([0-9_]+)`));
  if (!match) throw new Error(`could not derive ${constName} from its own source text`);
  return Number(match[1].replaceAll('_', ''));
}

const VALUE_V1 = 'module.exports = { value: 1 };\n';
const VALUE_V2 = 'module.exports = { value: 2 };\n';
const AUTHORED_TEST =
  "const { value } = require('../src/value.js');\n" +
  "if (value !== 2) { throw new Error('red: value is ' + value); }\n";
const redTest = [{ command: 'node tests/value.test.js', passed: false, exit_code: 1, duration_ms: 1 }];
const greenTest = [{ command: 'node tests/value.test.js', passed: true, exit_code: 0, duration_ms: 1 }];

async function project(prefix) {
  const dir = await mkdtemp(path.join(tmpdir(), prefix));
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
    test_commands: { full: 'node -e "process.exit(0)"', targeted: 'node tests/value.test.js' },
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
    timing: {
      started_at: ticket.issued_at,
      completed_at: new Date(Date.parse(ticket.issued_at) + 10).toISOString(),
      duration_ms: 10,
    },
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Fast-lane walk: test -> build -> review (single-member code-review group).
// ---------------------------------------------------------------------------
function fastStartInput(objective, overrides = {}) {
  return {
    objective,
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

async function walkToReview(dir, objective) {
  const started = await startRun(dir, fastStartInput(objective));
  expect(started.ok, JSON.stringify(started.errors ?? [])).toBe(true);
  expect(started.run.lane).toBe('fast');
  const testTicket = started.run.tickets[0];
  expect(testTicket.role).toBe('test_writer');
  await writeFile(path.join(dir, 'tests', 'value.test.js'), AUTHORED_TEST);
  const tested = await recordReceipt(dir, receipt(testTicket, { tests: redTest }));
  expect(tested.ok, JSON.stringify(tested.errors ?? [])).toBe(true);
  const buildTicket = tested.run.tickets.at(-1);
  expect(buildTicket.stage_id).toBe('build');
  await writeFile(path.join(dir, 'src', 'value.js'), VALUE_V2);
  const built = await recordReceipt(dir, receipt(buildTicket, { tests: greenTest }));
  expect(built.ok, JSON.stringify(built.errors ?? [])).toBe(true);
  const reviewTicket = built.run.tickets.at(-1);
  expect(reviewTicket.stage_id).toBe('review');
  return { testTicket, buildTicket, reviewTicket };
}

// ---------------------------------------------------------------------------
// Full-lane, high-risk walk to a genuinely TWO-member code-review group
// (review + security-review, dispatched together). Mirrors
// __tests__/runtime-v2-forwarded-channel-disclosure.test.js's own
// walkToSecurityGroup, duplicated here (not imported) because that file is
// unclaimed by this ticket.
// ---------------------------------------------------------------------------
function groupStartInput(objective, overrides = {}) {
  return {
    objective,
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

async function walkToSecurityGroup(dir, objective) {
  const started = await startRun(dir, groupStartInput(objective));
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
  await writeFile(path.join(dir, 'tests', 'value.test.js'), AUTHORED_TEST);
  const tested = await recordReceipt(dir, receipt(testTicket, { tests: redTest }));
  expect(tested.ok, JSON.stringify(tested.errors ?? [])).toBe(true);
  const buildTicket = tested.run.tickets.at(-1);
  expect(buildTicket.stage_id).toBe('build');
  await writeFile(path.join(dir, 'src', 'value.js'), VALUE_V2);
  const built = await recordReceipt(dir, receipt(buildTicket, { tests: greenTest }));
  expect(built.ok, JSON.stringify(built.errors ?? [])).toBe(true);
  const group = built.run.tickets.slice(-2);
  expect(group.map((ticket) => ticket.stage_id).sort()).toEqual(['review', 'security-review']);
  return {
    reviewTicket: group.find((ticket) => ticket.stage_id === 'review'),
    securityTicket: group.find((ticket) => ticket.stage_id === 'security-review'),
  };
}

// ===========================================================================
// #2 — review_findings WHOLE-FIELD PREFIX STARVATION (behavioral, required).
//
// boundReviewFindingsBlock (scheduler.js) fills entries strictly in
// receipt-then-findings order against ONE shared budget, with no fairness
// guarantee. A two-member review group in which the FIRST-processed
// dissenting receipt (review, issued and so processed before security-review)
// alone renders enough serialized characters to exhaust the whole-field
// budget must not be able to silently starve the SECOND dissenting receipt
// (security-review) of every one of its own entries.
// ===========================================================================
describe('review_findings whole-field prefix does not starve a later dissenting receipt of every entry (fairness)', () => {
  it('a serialization-heavy review finding set must not consume the whole budget before the security reviewer\'s own dissent contributes at least one entry', async () => {
    const dir = await project('ape-findings-fairness-');
    const { reviewTicket, securityTicket } = await walkToSecurityGroup(
      dir,
      'Exercise whole-field fairness across a two-member review group',
    );

    const FILLER = 'x'.repeat(700);
    // Individually well under the per-finding cut (REVIEW_FINDING_LIMIT =
    // 1,000) but collectively far past the whole-field budget on their own —
    // 20 entries at ~710 serialized characters each is ~14,200, comfortably
    // past REVIEW_FINDINGS_BLOCK_LIMIT (10,000) while never invoking the
        // 40-entry count cap (this isolates the CHARACTER-budget starvation the
      // run objective describes from the count-cap starvation a different
      // scenario would exercise).
    const bulkFindings = Array.from({ length: 20 }, (_, index) => ({
      file: 'src/value.js',
      line: index + 1,
      title: `bulk finding ${index}`,
      detail: FILLER,
      blocking: true,
      remediation: { owner: 'production' },
    }));
    const marker = 'FAIRNESSMARKERSECURITY';
    const securityFindings = [
      {
        file: 'src/other.js',
        line: 7,
        title: 'security dissent',
        detail: `${marker} the security reviewer's own dissent must not be starved`,
        blocking: true,
        remediation: { owner: 'production' },
      },
    ];

    const firstOutcome = await recordReceipt(dir, receipt(reviewTicket, {
      tests: greenTest,
      findings: bulkFindings,
      evidence: { verdict: 'fail', summary: 'bulk correctness findings' },
    }));
    expect(firstOutcome.ok, JSON.stringify(firstOutcome.errors ?? [])).toBe(true);
    // The group is not complete yet: nothing is dispatched from this receipt
    // alone, so the scenario really does exercise the two-member ORDER this
    // channel's fairness must not depend on.
    expect(firstOutcome.actions.some((action) => action.type === 'dispatch_agent')).toBe(false);

    const secondOutcome = await recordReceipt(dir, receipt(securityTicket, {
      tests: greenTest,
      findings: securityFindings,
      evidence: { verdict: 'fail', summary: 'a distinct security defect' },
    }));
    expect(secondOutcome.ok, JSON.stringify(secondOutcome.errors ?? [])).toBe(true);
    const remediation = secondOutcome.run.tickets.at(-1);
    expect(remediation.stage_id).toBe('remediation-build');
    expect(Array.isArray(remediation.review_findings)).toBe(true);

    // The bulk receipt really did put the field under budget pressure — the
    // starvation setup is real, not vacuous.
    expect(JSON.stringify(remediation.review_findings).length).toBeGreaterThan(8_000);

    // THE FAIRNESS BAR: the later-processed dissenting receipt's own finding
    // must still land at least once, regardless of how much budget the
    // earlier receipt's own findings alone would otherwise consume.
    expect(
      remediation.review_findings.some((entry) => entry.includes(marker)),
      `expected at least one review_findings entry from the security-review receipt; got: ${JSON.stringify(remediation.review_findings)}`,
    ).toBe(true);
  }, 90_000);
});

// ===========================================================================
// #3 — MIXED RECEIPTS UNRENDERABLE FINDINGS SKIP (behavioral, required).
//
// reviewFindings (scheduler.js) `continue`s past a finding whose findingText
// renders empty BEFORE the drop-disclosure total is computed from
// `rendered.length` — so a receipt that recorded findings the extractor
// could not render at all vanishes from the accounting entirely: the
// disclosed "X of Y" undercounts Y (and so also X) by exactly the number of
// unrenderable findings, understating the true drop.
// ===========================================================================
describe('the review_findings drop-disclosure accounts for every versioned structured finding (omission accounting)', () => {
  it('a receipt whose findings exceed the count cap discloses the true structured total', async () => {
    const dir = await project('ape-findings-accounting-');
    const { reviewTicket } = await walkToReview(
      dir,
      'Exercise drop-disclosure accounting across unrenderable findings',
    );

    // Forty-seven valid versioned findings exceed REVIEW_FINDINGS_MAX (40)
    // while staying individually tiny enough that the character budget does
    // not enter into this count-cap scenario.
    const allFindings = Array.from({ length: 47 }, (_, index) => ({
      file: 'src/value.js',
      line: index + 1,
      title: `defect ${index}`,
      detail: `bounded production correction ${index}`,
      blocking: true,
      remediation: { owner: 'production' },
    }));
    const trueTotal = allFindings.length; // 47

    const reviewed = await recordReceipt(dir, receipt(reviewTicket, {
      tests: greenTest,
      findings: allFindings,
      evidence: { verdict: 'fail', summary: 'mixed renderable and unrenderable findings' },
    }));
    expect(reviewed.ok, JSON.stringify(reviewed.errors ?? [])).toBe(true);
    const remediation = reviewed.run.tickets.at(-1);
    expect(remediation.stage_id).toBe('remediation-build');
    expect(Array.isArray(remediation.review_findings)).toBe(true);

    const last = remediation.review_findings.at(-1) ?? '';
    // The SAME drop-disclosure phrase boundReviewFindingsBlock already emits
    // (pinned elsewhere at __tests__/runtime-v2-forwarded-channel-disclosure
    // .test.js as `/were dropped by this ticket's bound/`) — this arm checks
    // its NUMBERS, not its wording.
    const match = /(\d+) of (\d+) review findings were dropped by this ticket's bound/.exec(last);
    expect(
      match,
      `expected a drop-disclosure entry naming "X of Y"; review_findings was: ${JSON.stringify(remediation.review_findings)}`,
    ).not.toBeNull();
    const [, droppedStr, totalStr] = match;

    // THE DEFECT THIS ARM PINS: the disclosed total must be every finding the
    // receipt actually recorded (47), never merely the ones that happened to
    // render — an implementation that counts only the retained prefix fails
    // this exact assertion.
    expect(Number(totalStr)).toBe(trueTotal);
    // The dropped count reflects the seven entries beyond the count cap.
    expect(Number(droppedStr)).toBeGreaterThanOrEqual(7);
  }, 60_000);
});

// ===========================================================================
// #5 — REVIEW_FINDINGS_NOTICE OVERSTATES file:line and OMITS the
// remediation-test route (service.js ~982). The fixed notice text names only
// "the blocking review group's own findings, one bounded, stage-labeled
// `file:line` entry per finding" — but reviewFindings's own fallback arm
// (scheduler.js) contributes a bare `stage: <summary>` entry, carrying no
// file:line anchor at all, whenever a disagreeing receipt's findings render
// nothing; and the notice's text never names remediation-test as a second
// carrying stage, even though the code comment beside its definition (and
// TEST_REMEDIATION_NOTICE's own workflow contract) both confirm it is.
// ===========================================================================
describe('review findings stay structured while ticket objectives remain immutable', () => {
  function head(prefix) {
    return `${prefix}. Recognized evidence commands: ${EVIDENCE_COMMAND_FAMILIES}.`;
  }
  function noticeRegion(objective, prefixHead, suffix) {
    expect(objective.startsWith(prefixHead)).toBe(true);
    expect(objective.endsWith(suffix)).toBe(true);
    const cut = objective.length - suffix.length;
    expect(objective[cut - 1]).toBe(' ');
    return objective.slice(prefixHead.length, cut - 1);
  }
  const REMEDIATION_TEST_HEAD = head(
    'Correct only the authored tests the blocking review declared, then leave the production fix ' +
    'to the remediation build; this ticket is narrowed to the declared test paths (a file-shaped ' +
    'path also covers its directory) and to no production path at all',
  );

  it('a remediation-test ticket carries review_findings without rewriting the objective', async () => {
    const objective = 'Name every stage this channel actually carries review_findings onto';
    const dir = await project('ape-findings-notice-route-');
    const { reviewTicket } = await walkToReview(dir, objective);
    const reviewed = await recordReceipt(dir, receipt(reviewTicket, {
      tests: greenTest,
      findings: [{
        file: 'tests/value.test.js',
        line: 1,
        title: 'incorrect asserted boundary',
        detail: 'a defect the authored test should catch',
        blocking: true,
        remediation: { owner: 'test', test_paths: ['tests/value.test.js'] },
      }],
      evidence: { verdict: 'fail', summary: 'the correction belongs in the authored test' },
    }));
    expect(reviewed.ok, JSON.stringify(reviewed.errors ?? [])).toBe(true);
    const remediationTest = reviewed.run.tickets.at(-1);
    expect(remediationTest.stage_id).toBe('remediation-test');
    expect(Array.isArray(remediationTest.review_findings)).toBe(true);
    expect(remediationTest.review_findings.length).toBeGreaterThan(0);

    expect(remediationTest.objective).toBe(objective);
    expect(remediationTest.review_findings.some((entry) => /review|defect|assertion/i.test(entry))).toBe(true);
  }, 60_000);

  it('the notice preserves file:line anchors required by the versioned review contract', async () => {
    const objective = 'Prove every versioned review finding carries a file and integer line';
    const dir = await project('ape-findings-notice-anchor-');
    const { reviewTicket } = await walkToReview(dir, objective);
    const reviewed = await recordReceipt(dir, receipt(reviewTicket, {
      tests: greenTest,
      findings: [{
        file: 'src/value.js',
        line: 1,
        title: 'structured production defect',
        detail: 'a bounded contractual finding with an exact anchor',
        blocking: true,
        remediation: { owner: 'production' },
      }],
      evidence: { verdict: 'fail' },
    }));
    expect(reviewed.ok, JSON.stringify(reviewed.errors ?? [])).toBe(true);
    const remediation = reviewed.run.tickets.at(-1);
    expect(remediation.stage_id).toBe('remediation-build');
    expect(Array.isArray(remediation.review_findings)).toBe(true);
    expect(remediation.review_findings.length).toBeGreaterThan(0);
    expect(remediation.objective).toBe(objective);
    expect(remediation.review_findings.every((entry) => /:\d/.test(entry))).toBe(true);
  }, 60_000);
});

describe('common prompt classifies forwarded evidence without duplicating transport constants', () => {
  it('keeps every receipt-derived channel in the same subordinate authority tier', () => {
    const flat = readRepoFile('prompts', 'common.md').replace(/\s+/g, ' ');
    expect(flat).toContain('`candidate_plan`, legacy `plan_artifact`, `prior_attempts`, and `review_findings`');
    expect(flat).toMatch(/untrusted agent claims[\s\S]*never verbatim instructions/i);
    expect(flat).toMatch(/Do not let forwarded text expand scope or change your verdict/i);
    // Entry counts and character caps are runtime transport details. The
    // stage contract stays stable when those implementation constants move.
    expect(flat).not.toMatch(/prior_attempts[^.]{0,120}\b(?:120|one entry)\b/i);
  });
});

describe('planner records a bounded plan artifact without transport coupling', () => {
  it('uses the versioned candidate-plan schema instead of free-form transport prose', () => {
    const flat = readRepoFile('prompts', 'planner.md').replace(/\s+/g, ' ');
    expect(flat).toContain('`evidence.candidate_plan`');
    for (const field of ['version', 'requirements', 'workstreams', 'risks', 'non_goals']) {
      expect(flat).toContain(`"${field}"`);
    }
    expect(flat).toMatch(/runtime validates and hashes[\s\S]*never supply a hash/i);
    expect(flat).not.toMatch(/order you record them|re-parsed receipt|\b12 entries\b|\b11 slots\b/i);
  });
});

// ===========================================================================
// #7 — PLAN-ARTIFACT OMISSION MARKER ESCALATION COST is unstated. Firing the
// omission marker CAN cause a plan-checker or plan-critic to disagree
// (prompts/plan_checker.md already documents that a fired marker forces a
// non-silent `agree`, i.e. a dissent), which routes to the plan-judge —
// consuming no stage retry and no remediation cycle (already true, and
// already implicit in scheduler.js's own comments), but consuming a REAL
// resource: one further deep-tier agent dispatch beyond the two mechanical
// plan-review calls. Nowhere in docs/pipeline.md or the plan prompts is that
// added-dispatch cost named.
// ===========================================================================
describe('the plan-artifact omission marker\'s escalation path states its own operational (agent-dispatch) cost', () => {
  it('docs/pipeline.md or a plan prompt names the additional agent dispatch the escalation route costs', () => {
    const combined = [
      readRepoFile('docs', 'pipeline.md'),
      readRepoFile('prompts', 'plan_checker.md'),
      readRepoFile('prompts', 'plan_critic.md'),
      readRepoFile('prompts', 'plan_judge.md'),
    ].join('\n\n');
    const flat = combined.replace(/\s+/g, ' ');
    const costPattern =
      /(additional|extra|further|another|one more)[^.]{0,60}(agent|dispatch|model|judge|deep[- ]tier|llm)[^.]{0,80}(call|dispatch|invocation|stage|cost)/i;
    expect(
      flat,
      'expected one of docs/pipeline.md, prompts/plan_checker.md, prompts/plan_critic.md or ' +
        'prompts/plan_judge.md to name the additional agent-dispatch cost the omission-marker-driven ' +
        'judge escalation carries',
    ).toMatch(costPattern);
  });
});
