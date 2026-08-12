import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { recordReceipt, startRun } from '../lib/runtime/service.js';
import { runtimePaths } from '../lib/runtime/paths.js';
import { atomicWriteJson, readJson } from '../lib/runtime/storage.js';
import { validateTicket } from '../lib/runtime/schemas.js';

// Deterministic, receipt-derived failure evidence threaded onto reissued
// tickets, driven through the PUBLIC service surface (startRun/recordReceipt)
// exactly like __tests__/runtime-v2-service.test.js — a temp git repo, on-disk
// assertions via runtimePaths + readJson, and validateTicket on the persisted
// StageTicket. Two OPTIONAL, no-default ticket fields:
//
//   prior_attempts  — appears on a RETRY ticket when at least one prior attempt
//                     carried an informative evidence.summary; entries read
//                     'attempt N: <=120-char flattened summary'. A failed
//                     receipt with no informative summary yields NO key at all.
//   review_findings — appears on the remediation-build ticket issued after a
//                     review-group disagreement; entries are the disagreeing
//                     receipt's grounded findings, labeled by the voting
//                     receipt's stage, each entry and the whole field hard
//                     bounded, ordered by receipt then findings order, and
//                     FORWARDED unchanged onto a remediation-build retry.
//
// Every assertion below is satisfiable by one correct implementation of that
// contract. First-issue tickets carry NEITHER key (absent, not [] or null), so
// the back-compat cases stay green.
//
// Roadmap entry review-findings-truncated-on-remediation-ticket amended arm (f)
// only: the exact widths (200 chars / 20 entries) moved out of this file,
// because a cap that silently drops a blocking finding is the defect that entry
// closes. Arm (f) now pins the PROPERTIES a cap must keep — bounded, ordered,
// and DISCLOSED rather than silent — while the sibling
// __tests__/runtime-v2-remediation-review-findings.test.js pins that a blocking
// finding stays recoverable (file, line, defect) in the first place. Arms
// (a)-(e) and (g) are unchanged: the classic {file, line, summary} rendering
// (`stage: file:line — text`), the zero-renderable `(no summary)` fallback, and
// unchanged retry forwarding are compatibility anchors that must keep holding.
//
// Arm (f) drives THREE fixtures, one per outcome the bound can produce, so no
// assertion in it is vacuous: a list inside every ceiling (nothing cut, nothing
// dropped, and therefore nothing disclosed), a list past the per-entry WIDTH
// ceiling (the entry is cut and says how much), and a list past the entry-COUNT
// ceiling (a prefix survives and one final entry says how many did not). The
// widths themselves stay the implementer's: each fixture is sized to cross a
// ceiling by a wide margin rather than to equal one.

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

const redTest = [{ command: 'node tests/value.test.js', passed: false, exit_code: 1, duration_ms: 1 }];
const greenTest = [{ command: 'node tests/value.test.js', passed: true, exit_code: 0, duration_ms: 1 }];

async function project() {
  const dir = await mkdtemp(path.join(tmpdir(), 'ape-retry-remediation-'));
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
    objective: 'Thread receipt-derived failure evidence into retry and remediation tickets',
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

// Drive a fast-lane run to its pending attempt-1 build ticket: authored red
// test observed by the runtime, then the implementer ticket issued.
async function walkToBuild(dir) {
  const started = await startRun(dir, startInput());
  expect(started.ok).toBe(true);
  expect(started.run.lane).toBe('fast');
  const testTicket = started.run.tickets[0];
  expect(testTicket.role).toBe('test_writer');
  await writeFile(path.join(dir, 'tests', 'value.test.js'), AUTHORED_TEST);
  const tested = await recordReceipt(dir, receipt(testTicket, { tests: redTest }));
  expect(tested.ok).toBe(true);
  const buildTicket = tested.run.tickets.at(-1);
  expect(buildTicket.stage_id).toBe('build');
  expect(buildTicket.role).toBe('implementer');
  return { testTicket, buildTicket };
}

// Continue to the pending review ticket: green build turns the tree, the
// code-review group opens.
async function walkToReview(dir) {
  const { buildTicket } = await walkToBuild(dir);
  await writeFile(path.join(dir, 'src', 'value.js'), VALUE_V2);
  const built = await recordReceipt(dir, receipt(buildTicket, { tests: greenTest }));
  expect(built.ok).toBe(true);
  const reviewTicket = built.run.tickets.at(-1);
  expect(reviewTicket.stage_id).toBe('review');
  expect(reviewTicket.parallel_group).toBe('code-review');
  return { reviewTicket };
}

// Drive one run to its blocking review and hand back the remediation-build
// ticket's review_findings, asserting on the way that the state copy and the
// on-disk copy are the same array (the ticket_hash covers the field) and that
// the persisted StageTicket still validates.
async function remediationFindings(dir, findings) {
  const { reviewTicket } = await walkToReview(dir);
  const reviewed = await recordReceipt(dir, receipt(reviewTicket, {
    tests: greenTest,
    findings,
    evidence: { verdict: 'fail' },
  }));
  expect(reviewed.ok).toBe(true);

  const remediation = reviewed.run.tickets.at(-1);
  expect(remediation.stage_id).toBe('remediation-build');
  const entries = remediation.review_findings;
  expect(Array.isArray(entries)).toBe(true);
  expect(entries.length).toBeGreaterThan(0);

  const disk = await readDiskTicket(dir, remediation);
  expect(disk.review_findings).toEqual(entries);
  expect(validateTicket(disk).valid).toBe(true);
  return entries;
}

// No path to an unbounded ticket field: one entry can never carry more
// agent-authored prose than the wire already caps a single field at
// (ROADMAP_REASON_CHARS, projection.js), and the whole field can never exceed
// the 64 KB input envelope that admitted the receipt behind it (input-guard.js).
function expectBounded(entries) {
  for (const entry of entries) {
    expect(entry.startsWith('review: ')).toBe(true);
    expect(entry.length).toBeLessThanOrEqual(4_096);
  }
  expect(JSON.stringify(entries).length).toBeLessThanOrEqual(65_536);
}

const BLOCKING_FINDINGS = [
  { file: 'src/value.js', line: 3, summary: 'freeze the exported value' },
  { file: 'src/value.js', summary: 'guard against negative inputs' },
];
const EXPECTED_REVIEW_FINDINGS = [
  'review: src/value.js:3 — freeze the exported value',
  'review: src/value.js — guard against negative inputs',
];

describe('APE v2 retry evidence threading (prior_attempts)', () => {
  it('(a) a failed build receipt with a summary threads prior_attempts onto the attempt-2 ticket, in state and on disk', async () => {
    const dir = await project();
    const { buildTicket } = await walkToBuild(dir);

    const failed = await recordReceipt(dir, receipt(buildTicket, {
      status: 'failed',
      tests: redTest,
      evidence: { summary: 'targeted tests failed' },
    }));
    expect(failed.ok).toBe(true);

    const retry = failed.run.tickets.at(-1);
    expect(retry.stage_id).toBe('build');
    expect(retry.attempt).toBe(2);
    expect(retry.ticket_id).not.toBe(buildTicket.ticket_id);
    expect(retry.prior_attempts).toEqual(['attempt 1: targeted tests failed']);

    const disk = await readDiskTicket(dir, retry);
    expect(disk.prior_attempts).toEqual(['attempt 1: targeted tests failed']);
    expect(validateTicket(disk).valid).toBe(true);
  }, 30_000);

  it('(b) a failed build receipt with empty evidence yields NO prior_attempts key (absent, not empty)', async () => {
    const dir = await project();
    const { buildTicket } = await walkToBuild(dir);

    const failed = await recordReceipt(dir, receipt(buildTicket, {
      status: 'failed',
      tests: redTest,
      evidence: {},
    }));
    expect(failed.ok).toBe(true);

    const retry = failed.run.tickets.at(-1);
    expect(retry.stage_id).toBe('build');
    expect(retry.attempt).toBe(2);
    expect(retry).not.toHaveProperty('prior_attempts');

    const disk = await readDiskTicket(dir, retry);
    expect(disk).not.toHaveProperty('prior_attempts');
    expect(validateTicket(disk).valid).toBe(true);
  }, 30_000);
});

describe('APE v2 remediation evidence threading (review_findings)', () => {
  it('(c) a blocking review threads grounded review_findings onto the remediation-build ticket, in state and on disk', async () => {
    const dir = await project();
    const { reviewTicket } = await walkToReview(dir);

    const reviewed = await recordReceipt(dir, receipt(reviewTicket, {
      tests: greenTest,
      findings: BLOCKING_FINDINGS,
      evidence: { verdict: 'fail' },
    }));
    expect(reviewed.ok).toBe(true);
    expect(reviewed.run.remediation_cycles).toBe(1);

    const remediation = reviewed.run.tickets.at(-1);
    expect(remediation.stage_id).toBe('remediation-build');
    expect(remediation.role).toBe('implementer');
    expect(remediation.review_findings).toEqual(EXPECTED_REVIEW_FINDINGS);

    const disk = await readDiskTicket(dir, remediation);
    expect(disk.review_findings).toEqual(EXPECTED_REVIEW_FINDINGS);
    expect(validateTicket(disk).valid).toBe(true);
  }, 30_000);

  it('(d) a disagreeing review with zero renderable findings emits exactly one (no summary) entry', async () => {
    const dir = await project();
    const { reviewTicket } = await walkToReview(dir);

    const reviewed = await recordReceipt(dir, receipt(reviewTicket, {
      tests: greenTest,
      findings: [],
      evidence: { verdict: 'fail' },
    }));
    expect(reviewed.ok).toBe(true);

    const remediation = reviewed.run.tickets.at(-1);
    expect(remediation.stage_id).toBe('remediation-build');
    expect(remediation.review_findings).toEqual(['review: (no summary)']);

    const disk = await readDiskTicket(dir, remediation);
    expect(disk.review_findings).toEqual(['review: (no summary)']);
    expect(validateTicket(disk).valid).toBe(true);
  }, 30_000);

  it('(e) failing the remediation-build once forwards review_findings unchanged and adds its own prior_attempts', async () => {
    const dir = await project();
    const { reviewTicket } = await walkToReview(dir);

    const reviewed = await recordReceipt(dir, receipt(reviewTicket, {
      tests: greenTest,
      findings: BLOCKING_FINDINGS,
      evidence: { verdict: 'fail' },
    }));
    expect(reviewed.ok).toBe(true);
    const remediation = reviewed.run.tickets.at(-1);
    expect(remediation.stage_id).toBe('remediation-build');

    const failed = await recordReceipt(dir, receipt(remediation, {
      status: 'failed',
      tests: redTest,
      evidence: { summary: 'remediation attempt failed' },
    }));
    expect(failed.ok).toBe(true);

    const retry = failed.run.tickets.at(-1);
    expect(retry.stage_id).toBe('remediation-build');
    expect(retry.attempt).toBe(2);
    expect(retry.ticket_id).not.toBe(remediation.ticket_id);
    // review_findings forwarded unchanged; prior_attempts is its own retry evidence.
    expect(retry.review_findings).toEqual(EXPECTED_REVIEW_FINDINGS);
    expect(retry.prior_attempts).toEqual(['attempt 1: remediation attempt failed']);

    const disk = await readDiskTicket(dir, retry);
    expect(disk.review_findings).toEqual(EXPECTED_REVIEW_FINDINGS);
    expect(disk.prior_attempts).toEqual(['attempt 1: remediation attempt failed']);
    expect(validateTicket(disk).valid).toBe(true);
  }, 30_000);

  it('(f) findings inside every ceiling survive whole; a cut entry and a dropped finding are each DISCLOSED', async () => {
    // Every fixture string in this arm is DIGIT-FREE, so the disclosure checks
    // are mechanical rather than wording checks: a digit in a rendered entry can
    // only be a count the runtime itself added.

    // (i) INSIDE EVERY CEILING — the same 25-finding, 300-character-summary
    // fixture this arm has always used, with the per-finding label changed from
    // `finding <index>` to a digit-free word. Nothing is cut and nothing is
    // dropped here, so this is the control: the block must carry NO count at all,
    // and a runtime that started disclosing losses it did not take would fail.
    const markers = [
      'ALPHA', 'BRAVO', 'CHARLIE', 'DELTA', 'ECHO', 'FOXTROT', 'GOLF', 'HOTEL', 'INDIA',
      'JULIETT', 'KILO', 'LIMA', 'MIKE', 'NOVEMBER', 'OSCAR', 'PAPA', 'QUEBEC', 'ROMEO',
      'SIERRA', 'TANGO', 'UNIFORM', 'VICTOR', 'WHISKEY', 'XRAY', 'YANKEE',
    ];
    const survivors = await remediationFindings(await project(), markers.map((marker) => ({
      file: 'src/value.js',
      summary: `${marker} ${'x'.repeat(300)}`,
    })));
    expectBounded(survivors);
    expect(survivors).toHaveLength(markers.length);
    const survivorBlock = survivors.join('\n');
    // Deterministic and receipt-derived: the reviewer's own findings order, whole.
    expect(markers.filter((marker) => survivorBlock.includes(marker))).toEqual(markers);
    expect(
      /\d/.test(survivorBlock),
      'nothing was cut or dropped, so the ticket must disclose no count',
    ).toBe(false);

    // (ii) PAST THE PER-ENTRY WIDTH CEILING — two findings far wider than any
    // single entry may carry. What the old form of this arm pinned as "exactly
    // 201 characters ending in U+2026" is now the property that matters: the
    // entry stays bounded, it keeps a VERBATIM PREFIX of the reviewer's text, and
    // it states HOW MUCH it dropped instead of a bare marker that discloses
    // nothing about the size of the loss.
    const WIDE_FILLER =
      'the same clause repeats until this entry runs far past any per-entry ceiling. ';
    const wideSummaries = ['WIDEALPHA', 'WIDEBRAVO'].map(
      (marker) => `${marker} ${WIDE_FILLER.repeat(60)}WIDETAILMARKER`);
    const wide = await remediationFindings(await project(), wideSummaries.map((summary) => ({
      file: 'src/value.js',
      summary,
    })));
    expectBounded(wide);
    // A width cut is not a drop: both findings still have an entry of their own.
    expect(wide).toHaveLength(wideSummaries.length);
    wide.forEach((entry, index) => {
      const summary = wideSummaries[index];
      expect(entry.length).toBeLessThan(summary.length);
      expect(entry.startsWith(`review: src/value.js — ${summary.slice(0, 200)}`)).toBe(true);
      expect(entry).not.toContain('WIDETAILMARKER');
      expect(
        /\d/.test(entry),
        'an entry that dropped part of the reviewer\'s text must say how much',
      ).toBe(true);
    });

    // (iii) PAST THE ENTRY-COUNT CEILING — many findings, each comfortably
    // inside the per-entry width, so it is the LIST that overflows rather than
    // any one entry. A prefix of the reviewer's order survives and ONE final
    // entry says how many did not: a cap that silently swallows a blocking
    // finding leaves the remediation agent believing it holds the whole list.
    const LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
    const many = Array.from({ length: 45 }, (_, index) =>
      `MARK${LETTERS[Math.floor(index / LETTERS.length)]}${LETTERS[index % LETTERS.length]}`);
    const capped = await remediationFindings(await project(), many.map((marker) => ({
      file: 'src/value.js',
      summary: `${marker} one short finding`,
    })));
    expectBounded(capped);

    // A kept entry is one carrying a fixture marker; the runtime's own
    // disclosure carries none.
    const carries = (entry) => many.some((marker) => entry.includes(marker));
    const kept = capped.filter(carries);
    expect(kept.length).toBeGreaterThan(0);
    expect(kept.length).toBeLessThan(many.length);
    const cappedBlock = capped.join('\n');
    expect(many.filter((marker) => cappedBlock.includes(marker))).toEqual(many.slice(0, kept.length));

    const disclosure = capped.filter((entry) => !carries(entry));
    expect(disclosure).toHaveLength(1);
    expect(disclosure[0]).toBe(capped.at(-1));
    expect(capped).toHaveLength(kept.length + 1);
    // The kept entries plus the disclosed dropped count account for every
    // finding the reviewer wrote.
    const counts = (disclosure[0].match(/\d+/g) ?? []).map(Number);
    expect(counts, 'the disclosure must state how many findings it dropped')
      .toContain(many.length - kept.length);
    expect(counts, 'the disclosure must state how many findings there were')
      .toContain(many.length);
  }, 60_000);
});

describe('APE v2 evidence-field back-compat', () => {
  it('(g) first-issue tickets carry NEITHER key and still validate via validateTicket', async () => {
    const dir = await project();
    const started = await startRun(dir, startInput());
    expect(started.ok).toBe(true);

    const testTicket = started.run.tickets[0];
    expect(testTicket.stage_id).toBe('test');
    expect(testTicket).not.toHaveProperty('prior_attempts');
    expect(testTicket).not.toHaveProperty('review_findings');
    const diskTest = await readDiskTicket(dir, testTicket);
    expect(diskTest).not.toHaveProperty('prior_attempts');
    expect(diskTest).not.toHaveProperty('review_findings');
    expect(validateTicket(diskTest).valid).toBe(true);

    // The first (attempt-1) build ticket likewise carries neither key.
    await writeFile(path.join(dir, 'tests', 'value.test.js'), AUTHORED_TEST);
    const tested = await recordReceipt(dir, receipt(testTicket, { tests: redTest }));
    expect(tested.ok).toBe(true);
    const buildTicket = tested.run.tickets.at(-1);
    expect(buildTicket.stage_id).toBe('build');
    expect(buildTicket.attempt).toBe(1);
    expect(buildTicket).not.toHaveProperty('prior_attempts');
    expect(buildTicket).not.toHaveProperty('review_findings');
    const diskBuild = await readDiskTicket(dir, buildTicket);
    expect(validateTicket(diskBuild).valid).toBe(true);
  }, 30_000);
});
