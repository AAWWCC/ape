import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { expireDispatch, recordReceipt } from '../lib/runtime/service.js';
import { seedLegacyRun } from './legacy-run-test-helper.js';
import { runtimePaths } from '../lib/runtime/paths.js';
import { atomicWriteJson, readJson } from '../lib/runtime/storage.js';

// Roadmap entry expire-dispatch-orphan-blocks-red-admission.
//
// `ape_run action expire-dispatch` exists so an operator can void a wedged
// dispatch — a dead parent session, or an agent that ended with prose instead
// of the receipt (frictions #27/#30, skills/resume/SKILL.md:14) — and let the
// scheduler retry the stage. `expirePendingTicket` (scheduler.js) issues that
// retry, and service.js's issueTicket mints the retry ticket's base_tree_sha
// from `tree.current()` (service.js ~L686): the LIVE tree, which still holds
// the dead agent's file. The retry therefore INHERITS its predecessor's
// output as its own baseline.
//
// `receipt.changed_files` is never self-reported — it is the runtime's own
// recomputed diff from `ticket.base_tree_sha` to the observed head
// (receipt-validator.js, service.js `recordReceiptLocked`). A retry agent
// that reads the inherited authored test, verifies it satisfies the ticket,
// and reports honestly WITHOUT touching the tree again therefore produces an
// EMPTY diff against its own base. Red-test admission (service.js
// `observeRedTest`) filters that diff down to test paths that exist on disk,
// gets zero, and — on a project (like this one) whose test_commands sets
// neither `targeted` nor `targeted_template` — refuses with: "red-test
// admission found no runtime-verifiable authored test files; configure
// test_commands.targeted_template or test_commands.targeted". That advice is
// a dead end: the cause is the inherited empty diff, not a missing config
// (configuring targeted_template only moves the refusal to the identical
// empty-testPaths cause under different wording, service.js:1412-1419).
// Observed live in run-fixture-75aad5182d37: attempt 1 died holding an
// 18KB authored test; expire-dispatch absorbed it into the retry's baseline;
// attempt 2 verified it and was rejected; only a full byte-changing re-author
// cleared admission.
//
// WHAT DONE LOOKS LIKE (the run objective, verbatim): a retry after
// expire-dispatch reaches admission WITHOUT a gratuitous rewrite of a
// predecessor's already-correct output — OR, if that rewrite requirement is
// kept deliberately, the refusal for the resulting empty authored-test diff
// must name the real, inherited-base cause instead of pointing at
// test_commands.targeted_template. Either way, admission must never weaken:
// a receipt whose authored tests were never actually observed red by the
// runtime must still be refused.
//
// REMEDIATION-TEST AUGMENTATION (blocking review of this ticket's own run).
// The tree already implements the "keep the rewrite requirement, disclose it
// on the retry ticket" arm — expiredPredecessorNotice / expiredPredecessorTicket
// / emptyAuthoredTestPathsRefusal, service.js:297-332 and :1420-1445 — but this
// file asserted only the ABSENCE of the old dead-end string, never the
// disclosure's own presence, placement, or the refusal's positive cause
// (finding 3). Two further defects on that same surface were raised alongside
// it and are asserted here against the CORRECTED behavior, ahead of the
// production fix that lands them (this ticket may not touch service.js):
// the notice must be gated on `stage.writable === true` so a read-only
// stage's expiry retry is never falsely told it authored something and never
// ordered to write (finding 1), and the guidance must stop suggesting a
// byte-identical re-save is sufficient (finding 2) — receipt.changed_files is
// a tree-to-tree diff, so identical bytes recompute to an identical, empty
// diff regardless of intent.

const cleanups = [];
afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

function git(cwd, ...args) {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' },
  }).trim();
}

// Historical configuration: full is set, neither targeted nor its template
// is. seedLegacyRun preserves this old state for receipt/expiry diagnosis;
// mandatory new-run readiness correctly refuses this configuration today.
async function project() {
  const dir = await mkdtemp(path.join(tmpdir(), 'ape-expire-orphan-'));
  cleanups.push(dir);
  await mkdir(path.join(dir, 'src'));
  await mkdir(path.join(dir, 'tests'));
  await writeFile(path.join(dir, 'src', 'value.js'), 'export const value = 1;\n');
  await writeFile(path.join(dir, 'tests', 'value.test.js'), 'throw new Error("placeholder red");\n');
  git(dir, 'init', '-q');
  git(dir, 'config', 'user.email', 'ape@example.test');
  git(dir, 'config', 'user.name', 'APE Test');
  git(dir, 'add', '.');
  git(dir, 'commit', '-qm', 'baseline');
  await atomicWriteJson(runtimePaths(dir).config, {
    shipping: { auto_merge: false, provider: 'github', required_remote_checks: false },
    test_commands: { full: 'node --test' },
  });
  return dir;
}

function startInput(overrides = {}) {
  return {
    objective: 'Exercise expire-dispatch orphan admission',
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

// The retry agent's honest, self-reported receipt: a careful agent that read
// the inherited file, confirmed it satisfies the ticket, and reports without
// rewriting anything. Self-reported tests[] can never carry admission on its
// own (F12) — only the runtime's own execution can — so this shape is
// intentionally identical whether the inherited content is truly red or not.
function rawReceipt(ticket, overrides = {}) {
  return {
    ticket_id: ticket.ticket_id,
    status: 'passed',
    agent_identity: `agent-${ticket.role}`,
    tests: [{ command: 'self-reported', passed: false, exit_code: 1, duration_ms: 1 }],
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

// The exact dead-end advice named in the run objective. Asserted against by
// substring, never by full-string equality: the fix may reword the message
// for the genuinely-no-config case elsewhere, but it must never be the cause
// named for an inherited-base empty diff.
const WRONG_CAUSE_ADVICE = 'configure test_commands.targeted_template or test_commands.targeted';

// Remediation-test augmentation (blocking review of this ticket's run).
//
// FINDING 3 named this exact file: the chosen fix arm keeps the rewrite
// requirement and discloses it on the retry ticket (expiredPredecessorNotice,
// service.js:328-332, appended in issueTicket at :711-714) and the refusal
// itself names the real cause (emptyAuthoredTestPathsRefusal, service.js
// :1434-1445) — yet nothing below asserted the notice's own presence or the
// refusal's positive cause; the only admission assertion was the ABSENCE of
// WRONG_CAUSE_ADVICE, which a cause-naming-nothing refusal would also satisfy.
// The arms added below assert PRESENCE and PLACEMENT directly.
//
// FINDING 1 is a real defect in the same code path, re-verified against the
// tree rather than trusted from the finding text: issueTicket's
// `const expiredPredecessor = retryOf ? expiredPredecessorTicket(state, stage.id) : null`
// (service.js:711) carries no `stage.writable` gate, so a READ-ONLY stage's
// expiry retry (reviewer, security_reviewer, planner, ... — all writable:false
// in ROLE_POLICIES, lib/runtime/constants.js) is handed the identical notice
// naming its whole claimed surface as "its orphaned claimed/authored paths"
// and ending "re-author or re-save ... before submitting a receipt" — false
// and unactionable, since a read-only predecessor authored nothing and the
// write hook denies the read-only retry that instruction anyway. The fix is a
// `stage.writable === true` gate; the arm below is red against today's tree
// and green once that gate lands.
//
// FINDING 2: 're-save' is not an attributable change — receipt.changed_files
// is the tree-to-tree diff (lib/runtime/git.js diffFiles), so rewriting
// identical bytes recomputes to the identical tree and STILL an empty diff.
// The wrong verb rides both the retry-ticket notice (service.js:331) and the
// admission refusal (service.js:1442-1443). The correction is asserted on
// SUBSTANCE, never one exact sentence, so the remediation build has room to
// word it well: the guidance must stop implying a bare re-save is sufficient,
// and must say a content-identical rewrite is indistinguishable from not
// writing at all.
const MISLEADING_RESAVE_ADVICE = /re-save|resave/i;
const CONTENT_CHANGE_REQUIRED = /identical|unchanged/i;

function expectContentChangeGuidance(text, label) {
  expect(
    text,
    `${label} must not tell the agent that re-saving (rewriting identical bytes) satisfies admission — an identical tree recomputes to an identical, empty diff`,
  ).not.toMatch(MISLEADING_RESAVE_ADVICE);
  expect(
    text,
    `${label} must say a content-identical / unchanged rewrite does not register as a diff`,
  ).toMatch(CONTENT_CHANGE_REQUIRED);
}

// Writable expiry retries keep the run objective immutable and disclose their
// exact predecessor through the bounded structured transport field.
function expectPredecessorDisclosure(ticket, predecessor) {
  expect(ticket.objective).toBe(startInput().objective);
  expect(ticket.expired_predecessor).toMatchObject({
    ticket_id: predecessor.ticket_id,
    ticket_hash: predecessor.ticket_hash,
    base_tree_sha: predecessor.base_tree_sha,
    omitted_path_count: 0,
  });
  const inherited = [...new Set([...(predecessor.claimed_paths ?? []), ...(predecessor.test_paths ?? [])])];
  expect(inherited.length, 'fixture must carry inherited paths for this assertion to mean anything')
    .toBeGreaterThan(0);
  expect(ticket.expired_predecessor.inherited_paths).toEqual(inherited);
}

describe('expire-dispatch orphan admission (expire-dispatch-orphan-blocks-red-admission)', () => {
  it('a retry inheriting its dead predecessor\'s authored red test is not refused by blaming test_commands.targeted_template', async () => {
    const dir = await project();
    const started = await seedLegacyRun(dir, startInput());
    expect(started.ok).toBe(true);
    const ticket1 = started.run.tickets[0];
    expect(ticket1.role).toBe('test_writer');
    expect(ticket1.required_checks).toContain('red-test');

    // The dead agent's own output: it wrote a deterministically-failing
    // authored test that satisfies the ticket, then died before returning a
    // receipt (frictions #27/#30) — exactly the field incident this roadmap
    // entry traces (run-fixture-75aad5182d37).
    await writeFile(
      path.join(dir, 'tests', 'value.test.js'),
      'throw new Error("authored red left behind by the dead agent");\n',
    );

    const expired = await expireDispatch(dir, ticket1.ticket_id, 'parent session crashed; flight is dead');
    expect(expired.ok).toBe(true);
    expect(expired.run.status).toBe('running');
    expect(expired.run.expired_tickets).toContain(ticket1.ticket_id);
    const ticket2 = expired.actions.find((action) => action.type === 'dispatch_agent').ticket;
    expect(ticket2.ticket_id).not.toBe(ticket1.ticket_id);
    expect(ticket2.stage_id).toBe(ticket1.stage_id);
    expect(ticket2.role).toBe('test_writer');
    expect(ticket2.required_checks).toContain('red-test');
    expect(ticket2.attempt).toBe(2);
    expect(ticket2.writable).toBe(true);

    expectPredecessorDisclosure(ticket2, ticket1);
    expect(ticket1.objective).toBe(startInput().objective);
    expect(ticket1).not.toHaveProperty('expired_predecessor');

    // The careful retry agent VERIFIES rather than rewrites: it never touches
    // the tree again, so its receipt's changed_files (recomputed by the
    // runtime as the diff from ticket2.base_tree_sha to the observed head)
    // comes out empty — the runtime minted ticket2.base_tree_sha from the
    // live tree that already held the dead agent's file.
    const result = await recordReceipt(dir, rawReceipt(ticket2));

    // RED ANCHOR. Today this receipt is refused, and the refusal blames
    // test_commands.targeted_template/targeted — a dead end, since the real
    // cause is the inherited empty diff, not a missing config (configuring
    // targeted_template only moves the refusal to the identical empty-
    // testPaths cause under different wording). Whichever shape the fix
    // takes — admission recognizing the inherited-but-unattributed path as
    // authorable by ticket2, or ticket2's own base excluding it — this exact
    // receipt must either be admitted, or refused with a message that names
    // the real, inherited-base cause instead of this dead-end advice.
    const refusedNamingWrongCause =
      result.ok === false &&
      (result.errors ?? []).some((error) => error.includes(WRONG_CAUSE_ADVICE));
    expect(refusedNamingWrongCause).toBe(false);

    // FINDING 3(b). Today's implementation chose the "keep the rewrite
    // requirement" arm (expiredPredecessorNotice on the ticket, plus
    // emptyAuthoredTestPathsRefusal at admission), so this exact honest-
    // verify-only receipt IS refused — and the refusal must POSITIVELY name
    // the real, inherited-base cause, not merely avoid the old dead-end
    // string (a refusal naming no cause at all would satisfy the ABSENCE
    // check above but leaves the agent no better informed).
    expect(result.ok).toBe(false);
    const message = (result.errors ?? []).join(' ');
    expect(message, 'the refusal must positively name the expired predecessor whose output was inherited')
      .toContain(ticket1.ticket_id);

    // FINDING 2, on the admission-refusal surface (service.js:1442-1443): the
    // same substance requirement as the ticket notice above.
    expectContentChangeGuidance(message, 'the admission refusal');
  }, 30_000);

  it('FINDING 1: a READ-ONLY stage\'s expiry retry carries no Inherited-base disclosure and is never ordered to re-author', async () => {
    const dir = await project();
    const started = await seedLegacyRun(dir, startInput());
    expect(started.ok).toBe(true);
    const testTicket = started.run.tickets[0];
    expect(testTicket.role).toBe('test_writer');

    // Drive a REAL first attempt through admission (a genuine, non-expired
    // author) so the run legitimately reaches the read-only review stage:
    // the runtime executes this authored test itself and must observe it
    // fail — a real diff from the committed placeholder, not a re-save of it.
    await writeFile(
      path.join(dir, 'tests', 'value.test.js'),
      'throw new Error("authored red for the read-only expiry arm");\n',
    );
    const tested = await recordReceipt(dir, rawReceipt(testTicket));
    expect(tested.ok, JSON.stringify(tested.errors ?? [])).toBe(true);

    const buildTicket = tested.run.tickets.at(-1);
    expect(buildTicket.stage_id).toBe('build');
    expect(buildTicket.role).toBe('implementer');
    // The implementer's targeted-tests check is advisory shape evidence only
    // (service.js: "the implementer's symmetric targeted-tests check stays
    // advisory at admission") — no production file needs to change to reach
    // the review stage this arm is testing.
    const built = await recordReceipt(dir, rawReceipt(buildTicket, {
      tests: [{ command: 'self-reported', passed: true, exit_code: 0, duration_ms: 1 }],
    }));
    expect(built.ok, JSON.stringify(built.errors ?? [])).toBe(true);

    const reviewTicket = built.run.tickets.at(-1);
    expect(reviewTicket.stage_id).toBe('review');
    expect(reviewTicket.role).toBe('reviewer');
    // The fixture really is read-only, so an absence assertion below cannot
    // pass vacuously by accident of a mis-set fixture.
    expect(reviewTicket.writable).toBe(false);

    const expiredReview = await expireDispatch(dir, reviewTicket.ticket_id, 'reviewer agent returned prose, no receipt');
    expect(expiredReview.ok).toBe(true);
    const retryReview = expiredReview.actions.find((action) => action.type === 'dispatch_agent').ticket;
    expect(retryReview.ticket_id).not.toBe(reviewTicket.ticket_id);
    expect(retryReview.stage_id).toBe('review');
    expect(retryReview.role).toBe('reviewer');
    expect(retryReview.attempt).toBe(2);
    // Read-only end to end: expiry never rewrites a stage's own writable
    // policy (ROLE_POLICIES.reviewer.writable is false; stageFromTicket
    // rebuilds it from the expired ticket's own schema fields).
    expect(retryReview.writable).toBe(false);

    expect(retryReview.objective).toBe(startInput().objective);
    expect(retryReview).not.toHaveProperty('expired_predecessor');
  }, 60_000);

  it('never weakens: an inherited test the runtime never actually observed red is still refused, not silently admitted', async () => {
    const dir = await project();
    const started = await seedLegacyRun(dir, startInput());
    expect(started.ok).toBe(true);
    const ticket1 = started.run.tickets[0];

    // The dead agent's orphaned output this time defines no failing
    // assertion at all — the runtime, if it actually executes the inherited
    // file, observes it pass (or, absent an authored failure, the file
    // itself defines no red at all). A retry that only verifies (and never
    // authors a real failing assertion) must never be admitted as an
    // observed red phase: red-test admission's whole purpose is that the
    // runtime OBSERVES the authored tests fail, and there is deliberately no
    // whole-suite or self-reported fallback (F12/D2). This must hold both
    // before and after any fix to the inherited-base defect above — loosening
    // attribution must never loosen OBSERVATION.
    await writeFile(
      path.join(dir, 'tests', 'value.test.js'),
      '// no failing assertion: the dead agent left nothing red behind\n',
    );

    const expired = await expireDispatch(dir, ticket1.ticket_id, 'agent returned prose, no receipt');
    expect(expired.ok).toBe(true);
    const ticket2 = expired.actions.find((action) => action.type === 'dispatch_agent').ticket;

    const result = await recordReceipt(dir, rawReceipt(ticket2));
    expect(result.ok).toBe(false);
    expect(result.rejected).toBe(true);
    expect((result.errors ?? []).length).toBeGreaterThan(0);
  }, 30_000);

  it('green guard: a genuinely empty authored-test diff with no expire-dispatch involved still gets the targeted-config advice', async () => {
    // The contrast case the run objective demands (bullet 3): the dead-end
    // advice is CORRECT for a project that genuinely has no targeted config
    // and authored no test at all — a fix must distinguish that cause from
    // the inherited-base one above, never simply delete or reword the
    // message everywhere.
    const dir = await project();
    const started = await seedLegacyRun(dir, startInput());
    expect(started.ok).toBe(true);
    const ticket1 = started.run.tickets[0];

    // No expire-dispatch, no dead agent, no file touched at all: the
    // test-writer's own receipt carries a genuinely empty diff because
    // nothing was ever authored.
    const result = await recordReceipt(dir, rawReceipt(ticket1));
    expect(result.ok).toBe(false);
    const message = (result.errors ?? []).join(' ');
    expect(message).toContain(WRONG_CAUSE_ADVICE);
  }, 30_000);
});

// Roadmap entry expiry-retry-disclosure-fidelity, closed by this run.
//
// acme PR #392 (run-fixture-924a124e1942) landed the "keep the rewrite
// requirement, disclose it on the retry ticket" arm above — both reviewers of
// that run verified admission did not weaken by one byte, and NOTHING here
// touches that: every arm below inspects only ticket OBJECTIVE text or an
// admission REFUSAL MESSAGE, never the ok:true/false decision or the
// changed_files/whole-suite-fallback/double-execution/both-must-fail
// mechanics pinned by the describe block above. That review's remediation
// review and remediation security review raised four further, non-blocking
// accuracy defects in that same disclosure surface — each one puts a false or
// incomplete statement in front of an agent on its LAST attempt, the exact
// misdiagnosis class the parent entry existed to end. Four arms below, one
// per defect, each red on this pre-fix tree.
describe('expiry-retry-disclosure fidelity (expiry-retry-disclosure-fidelity)', () => {
  it('FINDING (a): more than 20 short inherited paths get an explicit omission marker naming how many were dropped', async () => {
    const dir = await project();
    // Zero-padded and short ON PURPOSE. Two things must both hold for this
    // arm to isolate defect (a) rather than defect (b): every path must be
    // free of a bare "5" or "6" token (a single-digit path index like "5.js"
    // would falsely satisfy the count assertion below even on today's
    // unfixed tree), and the first 20 joined by ', ' must land under 200
    // characters so boundedGateSummary's OWN ellipsis (service.js:87-92)
    // never fires either — otherwise this would be exercising defect (b),
    // not (a). 20 * 't/NN.js' (7 chars) + 19 * ', ' (2 chars) = 178.
    const manyPaths = Array.from({ length: 25 }, (_, i) => `t/${String(i).padStart(2, '0')}.js`);
    const started = await seedLegacyRun(dir, startInput({ test_paths: manyPaths }));
    expect(started.ok).toBe(true);
    const ticket1 = started.run.tickets[0];
    expect(ticket1.test_paths.length).toBe(25);

    const expired = await expireDispatch(dir, ticket1.ticket_id, 'predecessor crashed holding 25 inherited paths');
    expect(expired.ok).toBe(true);
    const ticket2 = expired.actions.find((action) => action.type === 'dispatch_agent').ticket;
    const inherited = [...new Set([...ticket1.claimed_paths, ...ticket1.test_paths])];

    expect(ticket2.objective).toBe(startInput().objective);
    expect(ticket2.expired_predecessor).toMatchObject({
      ticket_id: ticket1.ticket_id,
      ticket_hash: ticket1.ticket_hash,
      base_tree_sha: ticket1.base_tree_sha,
      inherited_paths: inherited.slice(0, 19),
      omitted_path_count: inherited.length - 19,
    });
  }, 30_000);

  it('FINDING (b): one over-long inherited path no longer swallows the genuinely inherited paths listed after it', async () => {
    const dir = await project();
    // testRemediationNotice (service.js:204-211) already bounds each
    // reviewer reason at 200 characters INDIVIDUALLY before joining;
    // expiredPredecessorNotice does not (defect b) — it bounds the JOINED
    // string instead, so nothing caps a single inherited path's own length
    // before the join.
    const longPath = `src/${'x'.repeat(250)}.js`;
    const shortPaths = ['src/short-a.js', 'src/short-b.js', 'src/short-c.js'];
    const started = await seedLegacyRun(dir, startInput({ test_paths: [longPath, ...shortPaths] }));
    expect(started.ok).toBe(true);
    const ticket1 = started.run.tickets[0];

    const expired = await expireDispatch(dir, ticket1.ticket_id, 'predecessor crashed holding one over-long inherited path');
    expect(expired.ok).toBe(true);
    const ticket2 = expired.actions.find((action) => action.type === 'dispatch_agent').ticket;

    expect(ticket2.objective).toBe(startInput().objective);
    expect(ticket2.expired_predecessor.ticket_id).toBe(ticket1.ticket_id);
    const boundedLongPath = ticket2.expired_predecessor.inherited_paths
      .find((entry) => entry.startsWith(`src/${'x'.repeat(20)}`));
    expect(boundedLongPath.length).toBeLessThanOrEqual(200);
    expect(boundedLongPath).not.toBe(longPath);
    for (const shortPath of shortPaths) {
      expect(
        ticket2.expired_predecessor.inherited_paths,
        `${shortPath} was genuinely inherited and must not be swallowed by the single over-long path listed ahead of it`,
      ).toContain(shortPath);
    }
  }, 30_000);

  it('FINDING (c): issueTicket names the retryOf predecessor, never the oldest expired ticket of the same stage', async () => {
    const dir = await project();
    const started = await seedLegacyRun(dir, startInput());
    expect(started.ok).toBe(true);
    const ticket1 = started.run.tickets[0];

    const expired1 = await expireDispatch(dir, ticket1.ticket_id, 'first predecessor crashed');
    expect(expired1.ok).toBe(true);
    const ticket2 = expired1.actions.find((action) => action.type === 'dispatch_agent').ticket;

    // MAX_STAGE_ATTEMPTS = 2 means the scheduler itself can never let a THIRD
    // ticket of one stage coexist with TWO already-expired predecessors of
    // that same stage_id — expiring ticket2 through the public API would
    // BLOCK the run rather than retry it (run objective, defect c: "the
    // scheduler cannot currently produce this, so construct the state
    // directly"). active.json carries no per-ticket schema validation on
    // load (service.js activeState only requires a string run_id), so this
    // rewrites it directly: ticket2 is ALSO marked expired, a fabricated
    // ticket3 (a faithful clone of ticket2 under a fresh ticket_id) becomes
    // the live pending ticket, and the attempt counter is rolled back so
    // expiring ticket3 still falls inside the retry budget instead of
    // blocking the run.
    const paths = runtimePaths(dir);
    const active = await readJson(paths.active, null);
    expect(active).not.toBeNull();
    const ticket3 = { ...ticket2, ticket_id: `${ticket2.ticket_id}-fabricated-attempt-3` };
    active.expired_tickets = [...(active.expired_tickets ?? []), ticket2.ticket_id];
    active.tickets = [...active.tickets, ticket3];
    active.attempts = { ...active.attempts, [ticket2.stage_id]: 1 };
    await atomicWriteJson(paths.active, active);

    const expired2 = await expireDispatch(dir, ticket3.ticket_id, 'second predecessor also crashed');
    expect(expired2.ok, JSON.stringify(expired2)).toBe(true);
    const ticket4 = expired2.actions.find((action) => action.type === 'dispatch_agent').ticket;

    // RED ANCHOR. state.expired_tickets now names TWO tickets of stage
    // 'test' — ticket1 (oldest) and ticket2 — and ticket4 is issued as the
    // retry of ticket3 specifically: issueTicket's own retryOf parameter,
    // threaded from the EXPIRE_DISPATCH reducer's `retry_of:
    // ticket.ticket_id` (scheduler.js expirePendingTicket, :399), always
    // names the EXACT ticket that just expired. Today expiredPredecessorTicket
    // (service.js:315-318) ignores retryOf entirely and returns
    // state.tickets.find's FIRST match — the OLDEST expired ticket of this
    // stage_id (ticket1) — never the one this retry actually follows
    // (ticket3, whose orphaned tree ticket4's own base_tree_sha inherits).
    expectPredecessorDisclosure(ticket4, ticket3);
    expect(ticket4.expired_predecessor.ticket_id).not.toBe(ticket1.ticket_id);
  }, 30_000);

  it('FINDING (d): a predecessor that died before writing anything still gets the targeted-config advice, without asserting output that was never written', async () => {
    const dir = await project(); // test_commands.full only — no targeted, no targeted_template
    const started = await seedLegacyRun(dir, startInput());
    expect(started.ok).toBe(true);
    const ticket1 = started.run.tickets[0];

    // The predecessor dies WITHOUT writing anything at all: tests/value.test.js
    // stays exactly the committed placeholder throughout this whole test —
    // unlike the top-of-file 'a retry inheriting ...' test above, whose
    // predecessor DOES write real (if unattributed) content before dying.
    // Both scenarios reach the identical admission code path
    // (testPaths.length === 0, a real expired predecessor of this stage) and
    // are indistinguishable by the "an expired predecessor of this stage_id
    // exists" provenance predicate alone (run objective, defect d) — a
    // correct fix must satisfy both without keying on any one claimed/test
    // path's own content, which is exactly what keeps this arm and that
    // earlier one mutually satisfiable.
    const expired = await expireDispatch(dir, ticket1.ticket_id, 'agent crashed before writing anything at all');
    expect(expired.ok).toBe(true);
    const ticket2 = expired.actions.find((action) => action.type === 'dispatch_agent').ticket;

    // The retry is equally honest: it never writes anything either, so its
    // reported diff is empty for the same reason the "green guard" test's is.
    const result = await recordReceipt(dir, rawReceipt(ticket2));
    expect(result.ok).toBe(false);
    const message = (result.errors ?? []).join(' ');

    // RED ANCHOR (defect d, run objective bullet 4). Today
    // emptyAuthoredTestPathsRefusal (service.js:1461-1473) keys purely on "an
    // expired predecessor of this stage_id exists" and, once true, drops the
    // fallbackMessage's targeted-config advice ENTIRELY — even though this
    // project genuinely configures neither test_commands.targeted nor
    // targeted_template, so that advice remains fully correct here.
    expect(
      message,
      'the refusal must still carry the targeted-config advice that remains correct when nothing was actually inherited',
    ).toContain(WRONG_CAUSE_ADVICE);

    // Today's message also states, as unconditional present-tense fact, that
    // this ticket's base already "carries the unattributed output of its
    // expired predecessor" — literally nothing here: the predecessor left no
    // content behind at all, and the provenance predicate alone cannot see
    // that (defect d again). The wording must stop asserting output that was
    // never written.
    expect(
      message,
      'the refusal must not assert that unattributed output exists when the expired predecessor wrote nothing at all',
    ).not.toMatch(/already carries the unattributed output/i);
  }, 30_000);
});
