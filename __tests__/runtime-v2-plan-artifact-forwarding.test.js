import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

// Roadmap entry plan-artifact-not-forwarded-to-plan-review.
//
// THE CONTRACT THIS SUITE DEFINES (authoritative; the implementer makes it green).
//
// A new OPTIONAL StageTicket field `plan_artifact` carries the planner
// receipt's own recorded EVIDENCE onto the stages that review the plan, so a
// plan reviewer has the planner's recorded claim rather than only the
// operator's run objective.
//
//              CORRECTED (never deleted) by roadmap entry
//              plan-artifact-forwards-evidence-not-findings: the field carries
//              the planner receipt's `evidence` object and nothing else — the
//              receipt's `findings` array is forwarded to no reviewer by any
//              route, with no marker and no disclosure. That entry changes the
//              reader-facing PROSE only, so every arm below is byte-identical
//              either way; the corrected surfaces are pinned by
//              __tests__/runtime-v2-plan-artifact-evidence-not-plan.test.js.
//
// It sits beside prior_attempts and review_findings and follows their pattern
// exactly:
// `z.array(nonEmpty).optional()`, NO default, spread onto the ticket only when
// non-empty, so every ticket that carries no artifact stays byte-identical and
// every pre-change persisted ticket_hash still validates.
//
//   NAME       plan_artifact
//   STAGES     plan-check, plan-critic and plan-judge only — no other ticket
//              in the tree ever carries it (the post-judge `test` ticket is the
//              pinned negative case).
//   SOURCE     the newest PASSED planner (`plan` stage) receipt of THIS run,
//              read from run state at issue time — so a retry re-derives it
//              instead of inheriting it from the frozen stage object
//              (the stageFromTicket trap documented at narrowedTestClaims).
//   RENDERING  one entry per key of that receipt's free-form `evidence` object,
//              in the order service.js enumerates the re-parsed receipt,
//              rendered `<key>: <value>` where a string value is used raw and
//              any non-string value is JSON-serialized. The WHOLE entry is
//              whitespace-flattened (every whitespace run collapses to one
//              space, then trimmed) and hard-capped at 200 characters — a
//              longer entry is sliced to 199 and suffixed with '…', so a
//              truncated entry is exactly 200 characters, the boundedGateSummary
//              convention. At most 12 entries survive.
//
//              AMENDED (never deleted) by roadmap entry
//              plan-artifact-truncation-not-disclosed-to-readers: the entry cap
//              is unchanged and still hard, but when more keys were recorded
//              than fit, only the first 11 planner entries are rendered and the
//              twelfth slot carries the runtime's own omission marker naming the
//              dropped count. Arm (g) below pins that shape; the marker's
//              content, its unforgeability, the reader-side disclosure and the
//              corrected key-order/per-key promises are pinned by
//              __tests__/runtime-v2-plan-artifact-disclosure.test.js. Every
//              other arm of this suite uses 6-key, empty, no-planner or
//              synthetic evidence and is byte-identical either way.
//   FRAMING    ticket objectives remain the immutable operator intent. The
//              optional plan_artifact/review_findings fields are the explicit
//              transport, while role prompts define how their evidence is
//              interpreted.
//   FAIL-OPEN  no planner receipt, or a planner receipt whose evidence renders
//              to zero entries, omits the field ENTIRELY (absent, never [] or
//              null) and publishes no notice.
//
// WHY 12 x 200. Measured, not inherited. plan-check and plan-critic are issued
// in ONE parallel group, so the artifact crosses a single ape_run response FOUR
// times — on both pending run.tickets[] entries and on both dispatch_agent
// action tickets — and compactPendingTicket dedupes only `objective` and
// `output_schema`, never a new field. The bounding arm below measures that
// duplication factor empirically rather than asserting it. A plan-review
// response with no artifact projects to ~13.8 KB against
// RESPONSE_BUDGET_CHARS = 48,000, leaving ~34 KB. 12 entries x 200 chars is
// ~2.4 KB of text (~2.5 KB serialized) per copy, ~9.8 KB over four copies —
// about 20% of the budget and well inside the headroom. 12 entries also clears
// the largest observed planner evidence (9 keys, 6,872 bytes) without dropping
// any key, and 200 chars is the bound testRemediationNotice already applies to
// forwarded agent-authored text.
//
// SATISFIABILITY. Every expectation here is answered by one implementation of
// that contract. No call is asserted to both succeed and fail; the arms that
// assert ABSENCE (fail-open, no-planner-stage, post-judge test ticket,
// pre-change schema compatibility) are non-regression guards that hold on both
// trees, and the arms that assert PRESENCE are red on this tree solely because
// the field, the rendering, the bound and the notice do not exist yet.

// Shipping is the only runtime-owned side effect a service-driven behavioral
// test must not perform for real. No run here reaches the gates, but the mock
// keeps the harness faithful to runtime-v2-plan-check-rescope.test.js.
vi.mock('../lib/runtime/gates.js', async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, autoMergeGithub: vi.fn(), pollRemoteChecksAndMerge: vi.fn() };
});
import { recordReceipt, startRun } from '../lib/runtime/service.js';
import { runtimePaths } from '../lib/runtime/paths.js';
import { atomicWriteJson, readJson } from '../lib/runtime/storage.js';
import { finalizeTicket, validateTicket } from '../lib/runtime/schemas.js';
import { RESPONSE_BUDGET_CHARS, projectRunResponse } from '../lib/runtime/projection.js';
import { seedLegacyRun } from './legacy-run-test-helper.js';

const PLAN_ARTIFACT_MAX_ENTRIES = 12;
const PLAN_ARTIFACT_MAX_CHARS = 200;
const cleanups = [];
afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

function git(cwd, ...args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

async function project() {
  const dir = await mkdtemp(path.join(tmpdir(), 'ape-plan-artifact-'));
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

const RUN_OBJECTIVE = 'Carry the recorded plan onto the stages that review it';

// Non-blocking review finding: arm (n) below measures the plan-judge wire
// budget against projection.js, but a 54-character RUN_OBJECTIVE contributes
// ~0 to that measurement, so the stated headroom ("28,000 for the single full
// run.objective copy and everything else", scheduler.js:147) went untested at
// a realistic size. Objectives in this repo routinely run 8-10 KB (see a live
// remediation ticket's own objective). Built by repeating an ordinary
// sentence — never embedding literal run prose — so it stays free of every
// marker this suite pins elsewhere (EVIDENCE_NOT_INSTRUCTION, 'stage-labeled',
// 'rediscover it from the diff', the literal 'Run objective: ' prefix).
const REALISTIC_RUN_OBJECTIVE_CHARS = 9_000;
function realisticRunObjective(targetChars) {
  const sentence =
    'Investigate the reported defect, correct it with the smallest change ' +
    'that answers the evidence, and verify the result against the tree ' +
    'before returning a receipt. ';
  let text = '';
  while (text.length < targetChars) text += sentence;
  return text.slice(0, targetChars);
}

function startInput(overrides = {}) {
  return {
    objective: RUN_OBJECTIVE,
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

function readDiskTicket(dir, ticket) {
  const paths = runtimePaths(dir);
  return readJson(path.join(paths.tickets, `${ticket.ticket_id.replaceAll(':', '_')}.json`));
}

function countOccurrences(haystack, needle) {
  let count = 0;
  let index = haystack.indexOf(needle);
  while (index !== -1) {
    count += 1;
    index = haystack.indexOf(needle, index + needle.length);
  }
  return count;
}

// A planner evidence object of the real shape: scalars, a nested object, an
// array, and a multi-line/tabbed string. The nested object's keys are recorded
// in alphabetical order so insertion-order and canonical serialization agree
// and the expected entry is unambiguous.
const PLAN_EVIDENCE = {
  verdict: 'pass',
  summary: 'Forward the recorded plan to every plan-review stage',
  design: { approach: 'derive in service.js from run state', files: ['lib/runtime/service.js'] },
  test_arms: ['plan-check carries it', 'plan-critic carries it', 'plan-judge carries it'],
  risks: '  a reviewer could\ttreat the plan\n\nas an instruction  ',
  residuals: 3,
};

const EXPECTED_PLAN_ARTIFACT = [
  'verdict: pass',
  'summary: Forward the recorded plan to every plan-review stage',
  'design: {"approach":"derive in service.js from run state","files":["lib/runtime/service.js"]}',
  'test_arms: ["plan-check carries it","plan-critic carries it","plan-judge carries it"]',
  'risks: a reviewer could treat the plan as an instruction',
  'residuals: 3',
];

async function startFullLane(dir, overrides = {}, { historical = false } = {}) {
  const started = historical
    ? await seedLegacyRun(dir, startInput(overrides))
    : await startRun(dir, startInput(overrides));
  expect(started.ok, JSON.stringify({ reason: started.reason, blocking: started.readiness?.blocking })).toBe(true);
  expect(started.run.lane).toBe('full');
  const planTicket = started.run.tickets[0];
  expect(planTicket.stage_id).toBe('plan');
  expect(planTicket.role).toBe('planner');
  return { started, planTicket };
}

// Drive the REAL service from START through a passed planner receipt to the
// pending plan-review pair. Direct service imports return FULL tickets, so the
// wire projection can never mask or manufacture a field. `runOverrides` is
// purely ADDITIVE (default `{}` leaves every existing call byte-identical):
// it lets a caller override the run's own `startInput` fields — e.g. a
// realistic-size `objective` — to exercise the wire-budget arms below without
// duplicating this whole walk.
async function walkToPlanReview(dir, evidence = PLAN_EVIDENCE, runOverrides = {}, options = {}) {
  const { planTicket } = await startFullLane(dir, runOverrides, options);
  const recorded = await recordReceipt(dir, receipt(planTicket, { evidence }));
  expect(recorded.ok).toBe(true);
  const planCheck = recorded.run.tickets.find((ticket) => ticket.stage_id === 'plan-check');
  const planCritic = recorded.run.tickets.find((ticket) => ticket.stage_id === 'plan-critic');
  expect(planCheck?.role).toBe('plan_checker');
  expect(planCritic?.role).toBe('plan_critic');
  expect(planCheck.parallel_group).toBe('plan-review');
  expect(planCritic.parallel_group).toBe('plan-review');
  return { recorded, planTicket, planCheck, planCritic };
}

// Continue through a plan-review disagreement to the pending plan-judge
// ticket. `criticReceiptOverrides` is purely ADDITIVE (default `{}` leaves
// every existing call byte-identical): it lets a caller attach `findings` to
// the disagreeing plan-critic receipt to exercise the review_findings
// forwarding arms below without duplicating this whole walk.
async function walkToPlanJudge(dir, evidence = PLAN_EVIDENCE, criticReceiptOverrides = {}) {
  const { planCheck, planCritic } = await walkToPlanReview(dir, evidence);
  const checked = await recordReceipt(dir, receipt(planCheck, { evidence: { verdict: 'agree' } }));
  expect(checked.ok).toBe(true);
  const criticed = await recordReceipt(
    dir,
    receipt(planCritic, { evidence: { verdict: 'disagree' }, ...criticReceiptOverrides }),
  );
  expect(criticed.ok).toBe(true);
  const judge = criticed.run.tickets.at(-1);
  expect(judge.stage_id).toBe('plan-judge');
  expect(judge.role).toBe('plan_judge');
  return { criticed, judge };
}

describe('APE v2 plan artifact forwarding to the plan-review pair', () => {
  it('(a) the plan-check ticket carries the planner\'s recorded evidence as plan_artifact, in state and on disk', async () => {
    const dir = await project();
    const { planCheck } = await walkToPlanReview(dir);

    // One entry per recorded evidence key of this under-cap receipt — nothing
    // drops, so no slot is spent on the omission marker — in the order the
    // runtime enumerates the RE-PARSED receipt rather than the order the
    // planner wrote it: strings raw, non-strings JSON-serialized, whitespace
    // flattened.
    expect(planCheck.plan_artifact).toEqual(EXPECTED_PLAN_ARTIFACT);
    for (const entry of planCheck.plan_artifact) {
      expect(entry.length).toBeLessThanOrEqual(PLAN_ARTIFACT_MAX_CHARS);
      expect(entry).not.toMatch(/[\n\r\t]/);
    }

    const disk = await readDiskTicket(dir, planCheck);
    expect(disk.plan_artifact).toEqual(EXPECTED_PLAN_ARTIFACT);
    expect(validateTicket(disk).valid).toBe(true);
  }, 30_000);

  it('(b) the plan-critic ticket issued in the same parallel group carries the byte-identical artifact', async () => {
    const dir = await project();
    const { planCheck, planCritic } = await walkToPlanReview(dir);

    expect(planCritic.plan_artifact).toEqual(EXPECTED_PLAN_ARTIFACT);
    expect(planCritic.plan_artifact).toEqual(planCheck.plan_artifact);

    const disk = await readDiskTicket(dir, planCritic);
    expect(disk.plan_artifact).toEqual(EXPECTED_PLAN_ARTIFACT);
    expect(validateTicket(disk).valid).toBe(true);
  }, 30_000);

  it('(c) the artifact comes from the NEWEST PASSED planner receipt; a superseded failed attempt contributes nothing', async () => {
    const dir = await project();
    const { planTicket } = await startFullLane(dir);

    // Attempt 1 fails: its evidence is not a plan and must never be forwarded.
    const failed = await recordReceipt(dir, receipt(planTicket, {
      status: 'failed',
      evidence: { summary: 'SUPERSEDED-PLANNER-ATTEMPT abandoned design' },
    }));
    expect(failed.ok).toBe(true);
    const planRetry = failed.run.tickets.at(-1);
    expect(planRetry.stage_id).toBe('plan');
    expect(planRetry.attempt).toBe(2);
    // The planner's own ticket is never a plan-review stage, so it never carries
    // the artifact.
    expect(planRetry).not.toHaveProperty('plan_artifact');

    const recorded = await recordReceipt(dir, receipt(planRetry, { evidence: PLAN_EVIDENCE }));
    expect(recorded.ok).toBe(true);
    const planCheck = recorded.run.tickets.find((ticket) => ticket.stage_id === 'plan-check');
    const planCritic = recorded.run.tickets.find((ticket) => ticket.stage_id === 'plan-critic');

    expect(planCheck.plan_artifact).toEqual(EXPECTED_PLAN_ARTIFACT);
    expect(planCritic.plan_artifact).toEqual(EXPECTED_PLAN_ARTIFACT);
    expect(JSON.stringify(planCheck.plan_artifact)).not.toContain('SUPERSEDED-PLANNER-ATTEMPT');
  }, 30_000);
});

describe('APE v2 plan artifact forwarding to the plan-judge', () => {
  it('(d) the plan-judge ticket carries the artifact, and the post-judge test ticket does not', async () => {
    const dir = await project();
    const { judge } = await walkToPlanJudge(dir);

    expect(judge.plan_artifact).toEqual(EXPECTED_PLAN_ARTIFACT);
    const judgeDisk = await readDiskTicket(dir, judge);
    expect(judgeDisk.plan_artifact).toEqual(EXPECTED_PLAN_ARTIFACT);
    expect(validateTicket(judgeDisk).valid).toBe(true);

    // Scope guard: the field is plan-review/plan-judge only. An agreeing judge
    // advances to the test stage, whose ticket must stay byte-identical to a
    // tree without this feature — no field and no notice.
    const judged = await recordReceipt(dir, receipt(judge, { evidence: { verdict: 'agree' } }));
    expect(judged.ok).toBe(true);
    const testTicket = judged.run.tickets.at(-1);
    expect(testTicket.stage_id).toBe('test');
    expect(testTicket.role).toBe('test_writer');
    expect(testTicket).not.toHaveProperty('plan_artifact');
    expect(testTicket.objective).not.toContain('plan_artifact');
    const testDisk = await readDiskTicket(dir, testTicket);
    expect(testDisk).not.toHaveProperty('plan_artifact');
    expect(validateTicket(testDisk).valid).toBe(true);
  }, 30_000);

  it('(e) a plan-judge RETRY re-derives the artifact from run state and still carries its own prior_attempts', async () => {
    const dir = await project();
    const { judge } = await walkToPlanJudge(dir);

    const failed = await recordReceipt(dir, receipt(judge, {
      status: 'failed',
      evidence: { summary: 'judge tooling failed' },
    }));
    expect(failed.ok).toBe(true);
    const retry = failed.run.tickets.at(-1);
    expect(retry.stage_id).toBe('plan-judge');
    expect(retry.attempt).toBe(2);
    expect(retry.ticket_id).not.toBe(judge.ticket_id);

    // Re-derived from state, never inherited through the rebuilt stage object.
    expect(retry.plan_artifact).toEqual(EXPECTED_PLAN_ARTIFACT);
    expect(retry.prior_attempts).toEqual(['attempt 1: judge tooling failed']);

    const disk = await readDiskTicket(dir, retry);
    expect(disk.plan_artifact).toEqual(EXPECTED_PLAN_ARTIFACT);
    expect(validateTicket(disk).valid).toBe(true);
  }, 30_000);
});

// ===========================================================================
// Roadmap entry forwarded-evidence-and-judge-visibility: a plan-judge ticket
// carries plan_artifact (proven above) but NO review_findings channel at all,
// so the judge adjudicates a plan-check/plan-critic disagreement whose own
// dissent text it has never seen — prompts/plan_judge.md tells the judge to
// weigh "the dissent" no channel actually delivers. The fix reuses the SAME
// machinery a remediation-build ticket already receives (scheduler.js's
// reviewFindings/boundReviewFinding/boundReviewFindingsBlock, the identical
// three ceilings), attached in the plan-review-disagreed arm from the
// plan-check and plan-critic receipts, stage-labeled exactly as a
// remediation ticket's findings are.
// ===========================================================================
describe('APE v2 review_findings forwarding to the plan-judge (roadmap entry forwarded-evidence-and-judge-visibility)', () => {
  it('(k) the plan-judge ticket carries the disagreeing plan-critic\'s findings as review_findings, stage-labeled file:line exactly as a remediation ticket already receives them', async () => {
    const dir = await project();
    const { judge } = await walkToPlanJudge(dir, PLAN_EVIDENCE, {
      findings: [
        {
          file: 'lib/runtime/service.js',
          line: 1320,
          detail: 'splices raw gh stdout into a durable block_reason with no bound at all',
        },
      ],
    });

    expect(Array.isArray(judge.review_findings)).toBe(true);
    expect(judge.review_findings.length).toBeGreaterThan(0);
    const entry = judge.review_findings[0];
    expect(entry).toContain('plan-critic');
    expect(entry).toContain('lib/runtime/service.js:1320');
    expect(entry).toContain('splices raw gh stdout');

    const disk = await readDiskTicket(dir, judge);
    expect(disk.review_findings).toEqual(judge.review_findings);
    expect(validateTicket(disk).valid).toBe(true);
  }, 30_000);

  it('(l) a plan-judge ticket carries both evidence fields without mutating the run objective', async () => {
    const dir = await project();
    const { judge } = await walkToPlanJudge(dir, PLAN_EVIDENCE, {
      findings: [{ file: 'lib/runtime/service.js', line: 1320, detail: 'unbounded interpolation' }],
    });
    expect(judge.objective).toBe(RUN_OBJECTIVE);
    expect(judge.plan_artifact).toEqual(EXPECTED_PLAN_ARTIFACT);
    expect(judge.review_findings).toEqual(expect.arrayContaining([
      expect.stringContaining('plan-critic'),
    ]));
    expect(judge.output_schema.required).toContain('evidence');
  }, 30_000);

  it('(m) an AGREEING plan-check contributes no findings to the judge; only the DISAGREEING plan-critic\'s do', async () => {
    const dir = await project();
    const { planCheck, planCritic } = await walkToPlanReview(dir);
    const checked = await recordReceipt(dir, receipt(planCheck, {
      evidence: { verdict: 'agree' },
      findings: [{ file: 'lib/runtime/service.js', line: 99, detail: 'a finding on an AGREEING receipt must not appear' }],
    }));
    expect(checked.ok).toBe(true);
    const criticed = await recordReceipt(dir, receipt(planCritic, {
      evidence: { verdict: 'disagree' },
      findings: [{ file: 'lib/runtime/pipeline.js', line: 200, detail: 'the disagreeing finding' }],
    }));
    expect(criticed.ok).toBe(true);
    const judge = criticed.run.tickets.at(-1);
    expect(judge.stage_id).toBe('plan-judge');
    expect(Array.isArray(judge.review_findings)).toBe(true);
    const serialized = JSON.stringify(judge.review_findings ?? []);
    expect(serialized).not.toContain('must not appear');
    expect(serialized).toContain('the disagreeing finding');
  }, 30_000);

  it('(n) the projected wire response for the plan-review-disagreed dispatch stays inside RESPONSE_BUDGET_CHARS with review_findings AND plan_artifact both present, AND a realistically sized run objective (measured against projection.js, never asserted by multiplier)', async () => {
    const dir = await project();
    // Near the shared bound: 45 findings, each padded past REVIEW_FINDING_LIMIT,
    // so the block genuinely fills toward REVIEW_FINDINGS_BLOCK_LIMIT (10,000
    // serialized) the same way a remediation ticket's already can.
    const manyFindings = Array.from({ length: 45 }, (_, index) => ({
      file: 'lib/runtime/service.js',
      line: 100 + index,
      detail: 'x'.repeat(300),
    }));
    // Review finding (non-blocking): the run objective this measurement rides
    // on must be realistic-size too, not the suite's bare 54-character
    // stand-in, or the headroom this arm proves is answered by an objective
    // that could never occur on a real run.
    // This retained objective exceeds today's new-run planning bound. The
    // historical record must still traverse and render its plan-review group.
    const { planCheck, planCritic } = await walkToPlanReview(dir, PLAN_EVIDENCE, {
      objective: realisticRunObjective(REALISTIC_RUN_OBJECTIVE_CHARS),
    }, { historical: true });
    const checked = await recordReceipt(dir, receipt(planCheck, { evidence: { verdict: 'agree' } }));
    expect(checked.ok).toBe(true);
    const criticed = await recordReceipt(dir, receipt(planCritic, {
      evidence: { verdict: 'disagree' },
      findings: manyFindings,
    }));
    expect(criticed.ok).toBe(true);
    const judge = criticed.run.tickets.at(-1);
    expect(judge.stage_id).toBe('plan-judge');
    expect(Array.isArray(judge.review_findings)).toBe(true);
    // Bounded exactly like a remediation ticket's field: at most 40 entries
    // and the whole serialized field capped, never blown open just because
    // plan-judge is a single-ticket stage rather than a parallel pair.
    expect(judge.review_findings.length).toBeLessThanOrEqual(40);
    expect(JSON.stringify(judge.review_findings).length).toBeLessThanOrEqual(10_000);

    const projected = projectRunResponse(criticed);
    const wire = JSON.stringify(projected);
    expect(wire.length).toBeLessThan(RESPONSE_BUDGET_CHARS);
  }, 30_000);
});

describe('APE v2 plan artifact evidence framing', () => {
  it('(f) every ticket carries the artifact structurally and keeps the objective verbatim', async () => {
    const dir = await project();
    const { planCheck, planCritic } = await walkToPlanReview(dir);
    const { judge } = await walkToPlanJudge(await project());

    for (const ticket of [planCheck, planCritic, judge]) {
      expect(ticket.objective).toBe(RUN_OBJECTIVE);
      expect(ticket.plan_artifact).toEqual(EXPECTED_PLAN_ARTIFACT);
      expect(ticket.output_schema.required).toContain('evidence');
    }
  }, 30_000);
});

describe('APE v2 plan artifact bounding', () => {
  it('(g) oversized planner evidence still yields at most 12 entries of 200 chars — the last spent on the runtime omission marker — and the projected response stays inside the budget', async () => {
    const dir = await project();
    // 16 keys, each value 2,000 characters (~32 KB of evidence — five times the
    // largest observed planner receipt). k05's KEY is itself oversized, so the
    // 200-char cap is proven to bound the WHOLE entry, not just the value.
    const oversized = {};
    for (let index = 0; index < 16; index += 1) {
      const key = `k${String(index).padStart(2, '0')}${index === 5 ? 'K'.repeat(400) : ''}`;
      oversized[key] = `${'v'.repeat(2000)}`;
    }
    const { recorded, planCheck, planCritic } = await walkToPlanReview(dir, oversized);

    const entries = planCheck.plan_artifact;
    expect(Array.isArray(entries)).toBe(true);
    // The list cap is unchanged and still hard: the marker takes one of the
    // existing slots rather than adding a thirteenth, so the serialized-size
    // and four-copy arithmetic below is untouched.
    expect(entries).toHaveLength(PLAN_ARTIFACT_MAX_ENTRIES);

    // AMENDED, never deleted (see RENDERING above): only the first
    // PLAN_ARTIFACT_MAX_ENTRIES - 1 planner entries are rendered when keys drop.
    const planned = entries.slice(0, PLAN_ARTIFACT_MAX_ENTRIES - 1);
    for (const [index, entry] of planned.entries()) {
      // Every value overruns the cap, so every planner entry is truncated to
      // exactly the cap and carries the trailing ellipsis.
      expect(entry.length).toBe(PLAN_ARTIFACT_MAX_CHARS);
      expect(entry.endsWith('…')).toBe(true);
      expect(entry.startsWith(`k${String(index).padStart(2, '0')}`)).toBe(true);
    }
    // The last slot is runtime-authored: no planner key, no planner value, and
    // inside the same per-entry bound.
    const marker = entries.at(-1);
    expect(marker, 'the last slot is still a planner-derived entry').not.toMatch(/k\d\d/);
    expect(marker.length).toBeGreaterThan(0);
    expect(marker.length).toBeLessThanOrEqual(PLAN_ARTIFACT_MAX_CHARS);
    // The first 11 recorded keys survive; the rest are dropped outright.
    expect(JSON.stringify(entries)).not.toContain('k11');
    expect(JSON.stringify(entries)).not.toContain('k12');
    expect(planCritic.plan_artifact).toEqual(entries);

    // Bounded at source: the serialized artifact is ~2.4 KB of text per copy.
    const artifactChars = JSON.stringify(entries).length;
    expect(artifactChars).toBeLessThanOrEqual(2500);

    // MEASURED, not asserted by multiplier: the artifact really does cross one
    // ape_run response four times — both pending run.tickets[] entries and both
    // dispatch_agent action tickets of the plan-review parallel group, because
    // compactPendingTicket dedupes only `objective` and `output_schema`.
    const projected = projectRunResponse(recorded);
    const wire = JSON.stringify(projected);
    expect(recorded.actions.filter((action) => action.type === 'dispatch_agent')).toHaveLength(2);
    expect(countOccurrences(wire, 'k00')).toBe(4);
    // Four copies stay a fifth of the budget, and the whole projected response
    // stays inside it.
    expect(4 * artifactChars).toBeLessThan(RESPONSE_BUDGET_CHARS / 4);
    expect(wire.length).toBeLessThan(RESPONSE_BUDGET_CHARS);
    // The 32 KB of raw evidence never reaches the wire: receipts are summarized.
    expect(wire).not.toContain('v'.repeat(300));
  }, 30_000);
});

describe('APE v2 plan artifact fail-open and schema compatibility', () => {
  it('(h) a passed planner receipt with empty evidence omits the field and the notice entirely', async () => {
    const dir = await project();
    const { planCheck, planCritic } = await walkToPlanReview(dir, {});

    for (const ticket of [planCheck, planCritic]) {
      expect(ticket).not.toHaveProperty('plan_artifact');
      expect(ticket.objective).not.toContain('plan_artifact');
      const disk = await readDiskTicket(dir, ticket);
      expect(disk).not.toHaveProperty('plan_artifact');
      expect(validateTicket(disk).valid).toBe(true);
    }
  }, 30_000);

  it('(i) a lane with no planner stage at all issues tickets with the field absent and hash-stable', async () => {
    const dir = await project();
    const started = await startRun(dir, startInput({ lane: 'fast' }));
    expect(started.ok).toBe(true);
    expect(started.run.lane).toBe('fast');

    const first = started.run.tickets[0];
    expect(first.stage_id).toBe('test');
    expect(first).not.toHaveProperty('plan_artifact');
    expect(first.objective).not.toContain('plan_artifact');

    const disk = await readDiskTicket(dir, first);
    expect(disk).not.toHaveProperty('plan_artifact');
    expect(validateTicket(disk).valid).toBe(true);
  }, 30_000);

  it('(j) the schema accepts the optional field without perturbing a pre-change ticket', async () => {
    const dir = await project();
    const started = await startRun(dir, startInput({ lane: 'fast' }));
    expect(started.ok).toBe(true);
    const persisted = await readDiskTicket(dir, started.run.tickets[0]);

    // A ticket persisted WITHOUT the field re-finalizes byte-identically: the
    // new field must be optional with no default, or every pre-change
    // ticket_hash on disk would break.
    expect(validateTicket(persisted).valid).toBe(true);
    expect(finalizeTicket(persisted)).toEqual(persisted);

    // A ticket carrying the field validates. The schema is .strict(), so this
    // is exactly the red anchor: today finalizeTicket rejects the unknown key.
    const artifact = ['design: derive in service.js from run state'];
    const minted = finalizeTicket({ ...persisted, plan_artifact: artifact });
    expect(minted.plan_artifact).toEqual(artifact);
    expect(validateTicket(minted).valid).toBe(true);
    // The field participates in the hash like every other ticket field.
    expect(minted.ticket_hash).not.toBe(persisted.ticket_hash);
    // Entries are non-empty strings, exactly like prior_attempts/review_findings.
    expect(() => finalizeTicket({ ...persisted, plan_artifact: [''] })).toThrow();
  }, 30_000);
});
