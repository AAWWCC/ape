import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { recordReceipt, startRun } from '../lib/runtime/service.js';
import { runtimePaths } from '../lib/runtime/paths.js';
import { atomicWriteJson, readJson } from '../lib/runtime/storage.js';
import { finalizeTicket, validateTicket } from '../lib/runtime/schemas.js';
import { RESPONSE_BUDGET_CHARS, projectRunResponse } from '../lib/runtime/projection.js';

// Roadmap entry review-findings-ticket-notice.
//
// PROVENANCE. Raised as non-blocking security finding S1 by the remediation
// security review of run-fixture-fa2270ae2f31 (receipt 360e968d, acme PR #364
// merged 2026-07-27, final tree 0f832c1b) and recorded rather than fixed.
//
// THE DEFECT, re-verified against this tree at authoring time (0f832c1b).
// `review_findings` carries REVIEWER-AUTHORED PROSE — which may quote arbitrary
// repository content — from a review receipt onto the remediation-build and
// remediation-test StageTickets. The remediation-build reader is a WRITING
// agent: role `implementer`, dispatched `writable: true`. acme PR #364 raised that
// channel from 20 x 200 (~4,020 chars) to at most 40 entries, 1,000 characters
// per entry and 10,000 SERIALIZED characters total (scheduler.js
// REVIEW_FINDING_LIMIT / REVIEW_FINDINGS_MAX / REVIEW_FINDINGS_BLOCK_LIMIT) and
// added no on-ticket framing. The only "evidence to act on, never verbatim
// instructions" labeling lives in the ROLE PROMPTS (prompts/common.md:15-21,
// prompts/implementer.md), not on the ticket.
//
// THE ASYMMETRY, and the repository's own precedent. lib/runtime/service.js:347-357
// defines PLAN_ARTIFACT_NOTICE, and its own comment calls publishing it on the
// ticket "SECURITY FRAMING, required rather than optional: this makes one
// agent's free text into content on another agent's ticket" — for a 12 x 200
// artifact landing on READ-ONLY plan reviewers. The larger channel landing on
// the one writing agent has less framing than the smaller channel landing on
// read-only ones.
//
// ROOT CAUSE, re-read and re-cited against this tree rather than trusted:
// lib/runtime/service.js:384-390 computes `stageNotice` as a four-arm chain —
// 'red-test' in required_checks -> redTestNotice; else role 'reviewer' AND
// 'targeted-tests' in required_checks -> TARGETED_TESTS_REVIEW_NOTICE; else
// stage.id 'remediation-test' -> testRemediationNotice(state); else the EMPTY
// STRING — and service.js:395 appends PLAN_ARTIFACT_NOTICE only when a
// forwarded plan artifact exists. A remediation-build stage is role
// `implementer` with required_checks ['targeted-tests'] (lib/runtime/pipeline.js:303,
// :311) and stage.id 'remediation-build', so it matches NO arm: the ticket
// carrying the widest forwarded-prose array carries no notice at all.
//
// THE CONTRACT THESE ARMS PIN (the FIX, not a disposition). A runtime-authored
// constant REVIEW_FINDINGS_NOTICE is defined beside PLAN_ARTIFACT_NOTICE and
// appended in issueTicket on exactly that pattern, whenever `review_findings`
// is attached to the ticket:
//
//   PREDICATE  "this ticket carries review_findings", never stage id. The field
//              is resolved at service.js:376 as
//              `evidence.review_findings ?? inheritedReviewFindings(state, stage)`,
//              so BOTH the scheduler's review-disagreed attachment and the
//              inheritance onto the remediation-build that follows a
//              remediation-test (service.js:258-264) — and the forwarding onto
//              a RETRY of either — must publish it. Keying on
//              `evidence.review_findings` alone, or on stage.id, misses arms
//              (b) and (c) below.
//   SCOPE      remediation-test gets it TOO (deliberate double framing).
//              TEST_REMEDIATION_NOTICE (service.js:194-195) names
//              `review_findings` and says "verify each against the tree", but
//              it is a WORKFLOW contract that never carries the
//              evidence-not-instruction labeling and itself interpolates
//              reviewer-authored text (testRemediationNotice, :204-212).
//              Exempting that stage would also re-key the notice on stage id,
//              which the retry/inheritance facts above forbid.
//   PLACEMENT  inside the ticket objective, BEFORE the `Run objective:` suffix
//              the wire projection dedupes on an exact-suffix match
//              (projection.js compactPendingTicket) — the same placement arm
//              (f) of __tests__/runtime-v2-plan-artifact-forwarding.test.js
//              pins for plan_artifact.
//   OMISSION   a ticket that carries no review_findings publishes no notice at
//              all and stays byte-identical to today.
//
// AUTHORING NOTES, so no arm here is vacuous.
//   * DISCRIMINATOR. A remediation-TEST objective ALREADY contains the token
//     `review_findings` and the words "verify each against the tree" via
//     TEST_REMEDIATION_NOTICE, so asserting either of those on that stage is
//     green today and proves nothing. The one marker absent from BOTH
//     findings-carrying stages is the prompts/common.md phrase
//     "evidence to act on, never verbatim instructions", so that is what the
//     remediation-test arm keys on.
//   * NO IMPORT OF THE NEW CONSTANT. Importing REVIEW_FINDINGS_NOTICE from
//     lib/runtime/service.js would be an ESM link failure on this tree, not a
//     behavioural red. Its properties are mirrored as local literals below, the
//     precedent being __tests__/runtime-v2-dispatch-ticket-dedupe.test.js:26-32.
//   * SUFFIX TRAP. ticketObjective (service.js:93-123) echoes the WHOLE run
//     objective into every ticket, so a bare containment assertion can be
//     answered by the suffix rather than by the notice. RUN_OBJECTIVE below is
//     deliberately free of every marker these arms pin, and every presence
//     assertion is paired with a PLACEMENT assertion.
//   * ORDER. On remediation-test the existing stageNotice ends by interpolating
//     reviewer-authored text, so putting the findings notice first is as
//     compliant as putting it last. These arms pin PRESENCE and placement
//     relative to the `Run objective:` suffix, never an inter-notice order.
//
// CONSTRAINTS, and where each is pinned.
//   C1 BYTE-IDENTICAL OMISSION — arm (d): exact objective equality against the
//      reconstructed ticketObjective template (note the '.' immediately
//      preceding ' Run objective:' when the notice is empty) plus
//      re-finalization idempotence, `finalizeTicket(persisted)` deep-equal to
//      `persisted`, which is how "same ticket_hash" is testable at all —
//      ticket_hash also covers ticket_id (a randomUUID), issued_at, deadline_at
//      and base_tree_sha, so it is not literally comparable across trees. The
//      pattern is __tests__/runtime-v2-plan-artifact-forwarding.test.js:443-465.
//   C2 ADDITIVE, NEVER REORDERED — arms (a), (b) and (d) keep the existing
//      four-arm precedence observable: the empty arm stays byte-identical, the
//      remediation-test arm still carries TEST_REMEDIATION_NOTICE's own text
//      including the reviewer's interpolated reason, and the reviewer
//      targeted-tests arm still carries its own notice. VERIFIED FACT, stated
//      rather than relied on as a correctness argument: today the two notices
//      can never co-occur — planArtifact fires only on plan-check/plan-critic/
//      plan-judge (service.js PLAN_ARTIFACT_STAGES) and findings attach only
//      from the 'review' parallel group — and arm (g) plus arm (a) pin that
//      no ticket in either shape carries both fields.
//   C3 NO NEW INJECTION SURFACE — arms (a) and (e): the reviewer's own finding
//      text never appears in any ticket objective, and two runs whose findings
//      differ entirely produce byte-identical objectives.
//   C5 DETERMINISTIC — arm (e), same shape as C3's pin.
//   C4 WIRE BUDGET — arm (f): the NEW per-ticket cost is measured directly (the
//      notice region of the objective) and bounded, and the projected ape_run
//      response for a remediation dispatch whose review_findings already cross
//      at FULL WIDTH stays inside the imported RESPONSE_BUDGET_CHARS.
//   C6 BUNDLE — out of scope for this suite;
//      __tests__/runtime-v2-bundle-freshness.test.js already enforces that
//      dist/ape-mcp.bundle.mjs matches lib/runtime/service.js.
//   C7 SCOPE FENCE — nothing here asserts on lib/runtime/scheduler.js,
//      prompts/ or docs/; the sibling entries (review-findings-receipt-
//      starvation, unrenderable-findings-uncounted, audit-2026-07-27-review-
//      findings-residue) are deliberately untouched.
//
// SATISFIABILITY. Every expectation is answered by one implementation of the
// contract above. Nothing asserts both a value and its negation; the arms that
// assert ABSENCE (the omission arm, the no-injection arm, the non-co-occurrence
// arm) hold on both trees and are non-regression guards, and the arms that
// assert PRESENCE are red on this tree solely because the constant and its
// append do not exist yet.

const cleanups = [];
afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

function git(cwd, ...args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

// CJS on purpose (no package.json in the scratch project): the configured
// `node tests/value.test.js` targeted command runs the authored test as
// CommonJS during red-test admission.
const VALUE_V1 = 'module.exports = { value: 1 };\n';
const VALUE_V2 = 'module.exports = { value: 2 };\n';
const AUTHORED_TEST =
  "const { value } = require('../src/value.js');\n" +
  "if (value !== 2) { throw new Error('red: value is ' + value); }\n";
const CORRECTED_TEST = `${AUTHORED_TEST}// the asserted boundary now matches the exported contract\n`;

const redTest = [{ command: 'node tests/value.test.js', passed: false, exit_code: 1, duration_ms: 1 }];
const greenTest = [{ command: 'node tests/value.test.js', passed: true, exit_code: 0, duration_ms: 1 }];

const RUN_OBJECTIVE = 'Frame the forwarded reviewer prose on the ticket that carries it';
function expectStructuredFindingsTicket(ticket) {
  expect(ticket.objective).toBe(RUN_OBJECTIVE);
  expect(Array.isArray(ticket.review_findings)).toBe(true);
  expect(ticket.review_findings.length).toBeGreaterThan(0);
  expect(ticket.output_schema.required).toContain('evidence');
}

async function project() {
  const dir = await mkdtemp(path.join(tmpdir(), 'ape-findings-notice-'));
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

function startInput(overrides = {}) {
  return {
    objective: RUN_OBJECTIVE,
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

function readDiskTicket(dir, ticket) {
  const paths = runtimePaths(dir);
  return readJson(path.join(paths.tickets, `${ticket.ticket_id.replaceAll(':', '_')}.json`));
}

// Drive a fast-lane run to its pending review ticket through the REAL service
// surface: authored red observed by the runtime, green build, code-review group
// open. Direct service imports return FULL tickets, so the wire projection can
// never mask or manufacture an objective.
async function walkToReview(dir, overrides = {}) {
  const started = await startRun(dir, startInput(overrides));
  expect(started.ok, JSON.stringify(started.errors ?? [])).toBe(true);
  expect(started.run.lane).toBe('fast');
  const testTicket = started.run.tickets[0];
  expect(testTicket.role).toBe('test_writer');
  await writeFile(path.join(dir, 'tests', 'value.test.js'), AUTHORED_TEST);
  const tested = await recordReceipt(dir, receipt(testTicket, { tests: redTest }));
  expect(tested.ok, JSON.stringify(tested.errors ?? [])).toBe(true);
  const buildTicket = tested.run.tickets.at(-1);
  expect(buildTicket.stage_id).toBe('build');
  expect(buildTicket.role).toBe('implementer');
  await writeFile(path.join(dir, 'src', 'value.js'), VALUE_V2);
  const built = await recordReceipt(dir, receipt(buildTicket, { tests: greenTest }));
  expect(built.ok, JSON.stringify(built.errors ?? [])).toBe(true);
  const reviewTicket = built.run.tickets.at(-1);
  expect(reviewTicket.stage_id).toBe('review');
  expect(reviewTicket.parallel_group).toBe('code-review');
  return { testTicket, buildTicket, reviewTicket };
}

// One blocking review, one remediation-build ticket, in state and on disk.
async function remediateWith(dir, findings, evidence = {}) {
  const walked = await walkToReview(dir);
  const reviewed = await recordReceipt(dir, receipt(walked.reviewTicket, {
    tests: greenTest,
    findings,
    evidence: { verdict: 'fail', summary: REVIEW_PROSE, ...evidence },
  }));
  expect(reviewed.ok, JSON.stringify(reviewed.errors ?? [])).toBe(true);
  expect(reviewed.run.remediation_cycles).toBe(1);
  const remediation = reviewed.run.tickets.at(-1);
  expect(remediation.stage_id).toBe('remediation-build');
  expect(remediation.role).toBe('implementer');
  expect(remediation.writable).toBe(true);
  return { ...walked, reviewed, remediation };
}

// The reviewer's evidence.summary: prose that names no defect, carries none of
// the markers this suite pins, and is long enough that an implementation which
// interpolated it into the objective would be caught by the no-injection arm.
const REVIEW_PROSE =
  'The check ran to completion and the verdict is negative: the changed surface does not hold together under its own stated contract, and each specific defect is recorded as a structured finding rather than restated here.';

// Unique, marker-shaped reviewer text. If ANY of it reaches a ticket objective,
// the notice has become an injection surface (C3).
const ALPHA_MARKER = 'PROSEMARKERALPHA';
const BRAVO_MARKER = 'PROSEMARKERBRAVO';
const BLOCKING_FINDINGS = [
  {
    file: 'src/value.js',
    line: 3,
    summary: `${ALPHA_MARKER} the exported record is mutable across the module boundary`,
  },
  {
    file: 'docs/value.md',
    line: '13-15',
    summary: `${BRAVO_MARKER} the documented default contradicts the exported value`,
  },
];

// A second, entirely different reviewer voice for the determinism arm.
const CHARLIE_MARKER = 'PROSEMARKERCHARLIE';
const OTHER_FINDINGS = [
  {
    file: 'src/other.js',
    line: 91,
    note: `${CHARLIE_MARKER} the accessor hands every caller the same shared reference`,
  },
];

const DECLARATION_REASON =
  'REASONMARKERDELTA the authored assertion pins the wrong boundary, so the correction belongs in the test rather than in the implementation';

describe('APE v2 structured review_findings transport', () => {
  it('(a) the remediation-build ticket carries bounded findings with verbatim intent in state and on disk', async () => {
    const dir = await project();
    const { buildTicket, remediation } = await remediateWith(dir, BLOCKING_FINDINGS);

    // The channel really is carrying reviewer prose on this ticket, so the
    // presence assertions below cannot pass vacuously.
    expect(Array.isArray(remediation.review_findings)).toBe(true);
    expect(remediation.review_findings.length).toBeGreaterThan(0);
    expect(JSON.stringify(remediation.review_findings)).toContain(ALPHA_MARKER);

    expectStructuredFindingsTicket(remediation);

    // C3. The notice is a fixed runtime-authored constant: no finding text, no
    // receipt text, no reviewer prose of any kind reaches the objective.
    for (const leak of [ALPHA_MARKER, BRAVO_MARKER, REVIEW_PROSE]) {
      expect(remediation.objective, 'reviewer-authored text must never reach the ticket objective')
        .not.toContain(leak);
    }

    // C2, non-co-occurrence stated as a verified fact: a findings-carrying
    // ticket carries no plan artifact.
    expect(remediation).not.toHaveProperty('plan_artifact');

    // The on-disk ticket — the one copy prompts/common.md sanctions the bound
    // subagent to read — carries the identical objective and still validates.
    const disk = await readDiskTicket(dir, remediation);
    expect(disk.objective).toBe(remediation.objective);
    expect(disk.review_findings).toEqual(remediation.review_findings);
    expect(validateTicket(disk).valid).toBe(true);

    // C1/C2 on the same walk: the attempt-1 build ticket of this very run
    // carries no findings, takes the EMPTY stageNotice arm, and is therefore
    // byte-identical to a tree without this change.
    expect(buildTicket).not.toHaveProperty('review_findings');
    expect(buildTicket.objective).toBe(RUN_OBJECTIVE);
  }, 60_000);

  it('(b) the remediation-test ticket and its successor both carry the structured findings', async () => {
    const dir = await project();
    const { reviewTicket } = await walkToReview(dir);

    const reviewed = await recordReceipt(dir, receipt(reviewTicket, {
      tests: greenTest,
      findings: BLOCKING_FINDINGS,
      evidence: {
        verdict: 'fail',
        summary: REVIEW_PROSE,
        test_remediation: { test_paths: ['tests/value.test.js'], reason: DECLARATION_REASON },
      },
    }));
    expect(reviewed.ok, JSON.stringify(reviewed.errors ?? [])).toBe(true);

    const remediationTest = reviewed.run.tickets.at(-1);
    expect(remediationTest.stage_id).toBe('remediation-test');
    expect(remediationTest.role).toBe('test_writer');
    expect(remediationTest.review_findings.length).toBeGreaterThan(0);

    expectStructuredFindingsTicket(remediationTest);
    expect(remediationTest.required_checks).toEqual([]);
    expect(remediationTest.test_paths).toEqual(['tests/value.test.js']);
    expect(remediationTest.objective).not.toContain(DECLARATION_REASON);

    const testDisk = await readDiskTicket(dir, remediationTest);
    expect(testDisk.objective).toBe(remediationTest.objective);
    expect(validateTicket(testDisk).valid).toBe(true);

    // The inheritance path (service.js:258-264, consumed at :376): the
    // remediation-build that FOLLOWS a remediation-test receives its findings
    // from run state rather than from the scheduler, so a notice keyed on
    // `evidence.review_findings` alone would miss exactly here.
    await writeFile(path.join(dir, 'tests', 'value.test.js'), CORRECTED_TEST);
    const corrected = await recordReceipt(dir, receipt(remediationTest, {
      evidence: { verdict: 'pass', summary: 'corrected the asserted boundary' },
    }));
    expect(corrected.ok, JSON.stringify(corrected.errors ?? [])).toBe(true);

    const inherited = corrected.run.tickets.at(-1);
    expect(inherited.stage_id).toBe('remediation-build');
    expect(inherited.role).toBe('implementer');
    expect(inherited.review_findings.length).toBeGreaterThan(0);
    expectStructuredFindingsTicket(inherited);
    expect(inherited.objective).not.toContain(ALPHA_MARKER);

    const inheritedDisk = await readDiskTicket(dir, inherited);
    expect(inheritedDisk.objective).toBe(inherited.objective);
    expect(validateTicket(inheritedDisk).valid).toBe(true);
  }, 60_000);

  it('(c) a retry of the remediation-build still carries the same structured findings', async () => {
    const dir = await project();
    const { remediation } = await remediateWith(dir, BLOCKING_FINDINGS);

    const failed = await recordReceipt(dir, receipt(remediation, {
      status: 'failed',
      tests: redTest,
      evidence: { summary: 'remediation attempt failed' },
    }));
    expect(failed.ok, JSON.stringify(failed.errors ?? [])).toBe(true);

    const retry = failed.run.tickets.at(-1);
    expect(retry.stage_id).toBe('remediation-build');
    expect(retry.attempt).toBe(2);
    expect(retry.ticket_id).not.toBe(remediation.ticket_id);
    expect(retry.review_findings).toEqual(remediation.review_findings);
    // Its own retry evidence rides alongside, untouched.
    expect(retry.prior_attempts).toEqual(['attempt 1: remediation attempt failed']);

    expectStructuredFindingsTicket(retry);
    expect(retry.objective).not.toContain(ALPHA_MARKER);
    // Same state, same stage, same config: the notice is the same bytes on the
    // retry as on the first issue.
    expect(retry.objective).toBe(remediation.objective);

    const disk = await readDiskTicket(dir, retry);
    expect(disk.objective).toBe(retry.objective);
    expect(validateTicket(disk).valid).toBe(true);
  }, 60_000);
});

describe('APE v2 review_findings omission, determinism and non-co-occurrence', () => {
  it('(d) C1 — a ticket carrying no review_findings is byte-identical to today and re-finalizes to the same hash', async () => {
    const dir = await project();
    const started = await startRun(dir, startInput({ lane: 'full', requirements: ['R1'] }));
    expect(started.ok, JSON.stringify(started.errors ?? [])).toBe(true);
    expect(started.run.lane).toBe('full');

    const planTicket = started.run.tickets[0];
    expect(planTicket.stage_id).toBe('plan');
    expect(planTicket.role).toBe('planner');
    expect(planTicket).not.toHaveProperty('review_findings');

    expect(planTicket.objective).toBe(RUN_OBJECTIVE);
    expect(planTicket.objective).not.toContain('Run objective:');

    // (ii) Re-finalization idempotence: the persisted ticket, re-finalized,
    // is deep-equal to itself, so ticket_hash is unperturbed. This is the
    // testable form of "same ticket_hash" — the hash also covers ticket_id,
    // issued_at, deadline_at and base_tree_sha, which are not comparable
    // across trees.
    const persisted = await readDiskTicket(dir, planTicket);
    expect(validateTicket(persisted).valid).toBe(true);
    expect(finalizeTicket(persisted)).toEqual(persisted);
    expect(persisted.objective).toBe(RUN_OBJECTIVE);
  }, 30_000);

  it('(e) C3/C5 — different reviewer findings produce identical verbatim objectives and distinct fields', async () => {
    const first = await remediateWith(await project(), BLOCKING_FINDINGS);
    const second = await remediateWith(await project(), OTHER_FINDINGS);

    expectStructuredFindingsTicket(first.remediation);
    expectStructuredFindingsTicket(second.remediation);
    // ...identically, despite carrying different reviewer prose: same state
    // shape, same stage, same config -> same objective bytes, no time,
    // randomness or environment input, and no path from a finding to the
    // objective.
    expect(second.remediation.objective).toBe(first.remediation.objective);
    expect(JSON.stringify(second.remediation.review_findings))
      .not.toBe(JSON.stringify(first.remediation.review_findings));
    for (const leak of [ALPHA_MARKER, BRAVO_MARKER, CHARLIE_MARKER]) {
      expect(first.remediation.objective).not.toContain(leak);
      expect(second.remediation.objective).not.toContain(leak);
    }
  }, 60_000);

  it('(f) C4 — a full-width structured remediation dispatch stays inside the wire budget', async () => {
    const dir = await project();
    // Reviewer prose wide enough that the whole-field bound really fires: each
    // note overruns the per-entry ceiling and the list overruns the block
    // ceiling, so review_findings crosses the wire at its maximum width — the
    // exact response shape C4 names.
    const LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
    const FILLER = 'the same clause repeats so this finding fills the per-entry ceiling on its own. ';
    const wide = Array.from({ length: 30 }, (_, index) => ({
      file: 'src/value.js',
      line: 3,
      note: `WIDEMARK${LETTERS[index % LETTERS.length]} ${FILLER.repeat(20)}`,
    }));

    const { reviewed, remediation } = await remediateWith(dir, wide);
    expectStructuredFindingsTicket(remediation);

    // The field really is at full width on this response.
    const fieldChars = JSON.stringify(remediation.review_findings).length;
    expect(fieldChars).toBeGreaterThan(5_000);

    expect(remediation.objective).toBe(RUN_OBJECTIVE);

    const projected = projectRunResponse({
      ok: true,
      run: reviewed.run,
      actions: [
        {
          type: 'dispatch_agent',
          ticket: remediation,
          dispatch: { ticket_id: remediation.ticket_id, ticket: remediation },
        },
      ],
    });
    expect(JSON.stringify(projected).length).toBeLessThanOrEqual(RESPONSE_BUDGET_CHARS);
  }, 60_000);

  it('(g) C2 — the plan_artifact channel is untouched and the two forwarded-evidence fields never co-occur', async () => {
    const dir = await project();
    const started = await startRun(dir, startInput({ lane: 'full', requirements: ['R1'] }));
    expect(started.ok, JSON.stringify(started.errors ?? [])).toBe(true);
    const planTicket = started.run.tickets[0];
    expect(planTicket.stage_id).toBe('plan');

    const planned = await recordReceipt(dir, receipt(planTicket, {
      evidence: {
        verdict: 'pass',
        summary: 'Define the constant beside PLAN_ARTIFACT_NOTICE and append it on the findings predicate',
      },
    }));
    expect(planned.ok, JSON.stringify(planned.errors ?? [])).toBe(true);

    const planCheck = planned.run.tickets.find((ticket) => ticket.stage_id === 'plan-check');
    const planCritic = planned.run.tickets.find((ticket) => ticket.stage_id === 'plan-critic');
    for (const ticket of [planCheck, planCritic]) {
      expect(ticket.plan_artifact.length).toBeGreaterThan(0);
      // VERIFIED FACT rather than a correctness argument: today the two
      // receipt-derived evidence arrays can never ride the same ticket.
      expect(ticket).not.toHaveProperty('review_findings');
      expect(ticket.objective).toBe(RUN_OBJECTIVE);
      expect(ticket.output_schema.required).toContain('evidence');
      const disk = await readDiskTicket(dir, ticket);
      expect(disk.objective).toBe(ticket.objective);
      expect(validateTicket(disk).valid).toBe(true);
    }
  }, 30_000);
});
