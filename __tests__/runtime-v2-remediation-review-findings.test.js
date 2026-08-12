import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { recordReceipt, startRun } from '../lib/runtime/service.js';
import { runtimePaths } from '../lib/runtime/paths.js';
import { atomicWriteJson, readJson } from '../lib/runtime/storage.js';
import { validateTicket } from '../lib/runtime/schemas.js';
import { projectRunResponse, RESPONSE_BUDGET_CHARS } from '../lib/runtime/projection.js';

// Roadmap entry review-findings-truncated-on-remediation-ticket.
//
// THE PLAN, and the contract these arms pin.
//
// A remediation-build ticket is built from the review group's disagreeing
// receipts. prompts/implementer.md tells the remediation implementer to work
// from `review_findings` instead of rediscovering the defects from the diff, so
// that array is the whole channel: prompts/common.md sanctions exactly ONE
// `.ape` read for a bound subagent — its own ticket file — and the reviewer's
// receipt under `.ape/runtime/receipts/` is therefore unreadable to it.
//
// A regression fixture showed that a review receipt carrying two blocking
// findings could produce a review_findings array of exactly one entry —
// a 200-character slice of the reviewer's evidence.summary prose, naming no
// defect at all. Four independent losses on one path:
//   1. the extractor reads a finding's text from {summary, note} only, so the
//      {file, line, title, detail} shape the reviewer actually used (a shape the
//      free-form receipt schema fully permits and NO role prompt constrains)
//      renders NOTHING and drops to the zero-renderable fallback;
//   2. a `line` that is a RANGE ('13-15') is not an integer, so the anchor is
//      silently dropped and the entry degrades to file-only;
//   3. every entry is hard-cut at 200 characters with a bare U+2026 that
//      discloses nothing about how much was lost;
//   4. entries past the cap are dropped with no disclosure that a cap fired.
//
// WHAT THESE ARMS REQUIRE (the roadmap acceptance), stated as properties rather
// than as one implementation, so the width/shape decisions stay the
// implementer's:
//   R1 RECOVERABLE — for a review receipt with N blocking findings at distinct
//      anchors, ONE entry per finding lets a reader recover that finding's FILE,
//      its LINE (ranges included) and its DEFECT.
//   R2 TOLERANT — the extractor honours every text key the archived receipt
//      corpus actually uses (measured over .ape/runtime/history, 2026-07-27:
//      note 3035, detail 387, summary 313, title 254, description 14 — `detail`
//      and `title` together outnumber `summary`), because the receipt schema's
//      free-form findings record is hash-chained history and must NOT be
//      tightened (a strict shape would invalidate archived receipts).
//   R3 DISCLOSED — any loss is stated, never silent. An entry that drops text
//      says HOW MUCH; a list that drops findings says HOW MANY. Every fixture
//      string in this file is deliberately DIGIT-FREE, so the only digits a
//      rendered entry can carry are ones the runtime itself added (a line
//      anchor, or a count) — that is what makes "disclosed" mechanical here.
//   R4 BOUNDED — reviewer prose lands on a WRITING agent's ticket, so there is
//      no path to an unbounded ticket field: every entry and the whole field
//      stay hard-bounded, and the projected ape_run response stays inside
//      RESPONSE_BUDGET_CHARS with the field's worst case on the wire twice —
//      measured SERIALIZED, the way the host measures it, so characters that
//      are cheap in the ticket and expensive on the wire (a JSON-escaped C0
//      control character costs six) cannot push the response past the cap.
//   R5 DETERMINISTIC — receipt order, then findings order, receipt-derived
//      fields only; and the shape survives forwarding onto a retry ticket.
//   R6 CONTRACTUAL — the finding shape is named where reviewers read it (the
//      reviewer role prompts), and skills/run/SKILL.md stops implying an
//      untruncated on-disk review_findings unless that is made true.
//
// Sibling coverage, deliberately not duplicated here:
// __tests__/runtime-v2-retry-remediation-evidence.test.js keeps the classic
// {file, line, summary} rendering (`stage: file:line — text`), the
// zero-renderable `(no summary)` fallback for a genuinely empty findings array,
// unchanged forwarding onto a retry, and — in its amended arm (f) — the
// bounded/ordered/DISCLOSED behaviour of three lists: one inside every ceiling
// (nothing cut, nothing dropped, nothing disclosed), one past the per-entry
// WIDTH ceiling, and one past the entry-COUNT ceiling.
//
// Every expectation below is satisfiable by one correct implementation: nothing
// asserts both a value and its negation, the two "carried whole OR loss
// disclosed" arms are the roadmap acceptance's own disjunction (a bound may be
// retained if what it drops is stated), and only the missing extractor work
// separates red from green.

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

// R4 ceilings, derived rather than invented, and deliberately generous so they
// forbid UNBOUNDED without dictating the width:
//   ENTRY_MAX_CHARS — one rendered entry may never carry more prose than the
//     wire already caps a single agent-authored field at (ROADMAP_REASON_CHARS,
//     projection.js), so 4,096.
//   BLOCK_MAX_CHARS — the whole field may never exceed the 64 KB input envelope
//     that admitted the receipt it was derived from (input-guard.js).
// The tight bound lives where it is load-bearing: the projected wire response,
// measured against the imported RESPONSE_BUDGET_CHARS.
const ENTRY_MAX_CHARS = 4_096;
const BLOCK_MAX_CHARS = 65_536;

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
  const dir = await mkdtemp(path.join(tmpdir(), 'ape-review-findings-'));
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
    objective: 'Present the blocking review findings on the remediation ticket in a form the implementer can act on',
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

async function walkToReview(dir) {
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
  await writeFile(path.join(dir, 'src', 'value.js'), VALUE_V2);
  const built = await recordReceipt(dir, receipt(buildTicket, { tests: greenTest }));
  expect(built.ok).toBe(true);
  const reviewTicket = built.run.tickets.at(-1);
  expect(reviewTicket.stage_id).toBe('review');
  expect(reviewTicket.parallel_group).toBe('code-review');
  return { reviewTicket };
}

// The reviewer's evidence.summary: real prose from a real blocking review that
// names NO defect, exceeds the 200-character fallback slice, and mentions no
// path or marker any arm below looks for — so an entry derived from it can never
// be mistaken for an entry derived from a finding. Digit-free like every other
// fixture string here.
const REVIEW_PROSE =
  'The review executed against the final tree and the verdict is negative: the changed surface does not yet hold together under its own stated contract, and each specific defect is recorded as a structured finding rather than restated in this prose.';

// Drive one run to its blocking review and return the remediation-build ticket
// the disagreement produced, in state and on disk.
async function remediateWith(dir, findings, evidence = {}) {
  const { reviewTicket } = await walkToReview(dir);
  const reviewed = await recordReceipt(dir, receipt(reviewTicket, {
    tests: greenTest,
    findings,
    evidence: { verdict: 'fail', summary: REVIEW_PROSE, ...evidence },
  }));
  expect(reviewed.ok).toBe(true);
  expect(reviewed.run.remediation_cycles).toBe(1);
  const remediation = reviewed.run.tickets.at(-1);
  expect(remediation.stage_id).toBe('remediation-build');
  expect(remediation.role).toBe('implementer');
  const disk = await readDiskTicket(dir, remediation);
  expect(validateTicket(disk).valid).toBe(true);
  const entries = remediation.review_findings ?? [];
  // The ticket_hash covers the field, so the state copy and the on-disk copy
  // are the same array by construction; assert it rather than assume it.
  expect(disk.review_findings ?? []).toEqual(entries);
  return { reviewed, remediation, disk, entries, block: entries.join('\n') };
}

// Machine-checkable ONLY because every fixture string in this file is
// digit-free: a digit in a rendered block is a count the runtime added.
function disclosesACount(text) {
  return /\d/.test(text);
}

// Worst case on the wire: the pending remediation ticket in run.tickets[] AND
// the canonical dispatch_agent action ticket, exactly the two copies an
// ape_run response carries (projection.js collapses the third, dispatch.ticket,
// to a bare ticket_id on every response).
function wireSize(reviewed, remediation) {
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
  return JSON.stringify(projected).length;
}

function expectBounded(entries) {
  for (const entry of entries) {
    expect(typeof entry).toBe('string');
    expect(entry.length).toBeLessThanOrEqual(ENTRY_MAX_CHARS);
  }
  expect(JSON.stringify(entries).length).toBeLessThanOrEqual(BLOCK_MAX_CHARS);
}

// --- The observed reviewer's own finding shape: {id, severity, file, line,
// title, detail}, two BLOCKING entries at distinct anchors, one of them anchored
// on a line RANGE exactly as the observed V1 was.
const ALPHA_DEFECT = 'exported value is mutable across the module boundary';
const ALPHA_REMEDY = 'REMEDYMARKERALPHA';
const ALPHA_FILLER =
  'the same shared reference escapes through every accessor, so the defect reproduces from any caller in the module graph. ';
const ALPHA_DETAIL =
  `${ALPHA_DEFECT}: the module hands every consumer the same object, so one downstream write silently rewrites the value every other caller reads. ` +
  ALPHA_FILLER.repeat(9) +
  `Remedy: freeze the exported record at construction and return a defensive copy from the accessor, so the mutation surface disappears. ${ALPHA_REMEDY}`;

const BRAVO_DEFECT = 'documented default contradicts the exported value';
const BRAVO_DETAIL =
  `${BRAVO_DEFECT}: the guide still promises the previous default, so a reader who follows it writes code against a value the module no longer returns. Remedy: restate the default and cite the exporting module.`;

const BLOCKING_FINDINGS = [
  {
    id: 'V-alpha',
    severity: 'blocking',
    file: 'src/value.js',
    line: '13-15',
    title: ALPHA_DEFECT,
    detail: ALPHA_DETAIL,
  },
  {
    id: 'V-bravo',
    severity: 'blocking',
    file: 'docs/value.md',
    line: 42,
    title: BRAVO_DEFECT,
    detail: BRAVO_DETAIL,
  },
];

// Exactly one entry must carry all three signals of one finding: a reader who
// holds a single line of review_findings can act on it without the receipt.
function entriesNaming(entries, { file, line, defect }) {
  return entries.filter(
    (entry) => entry.includes(file) && entry.includes(line) && entry.includes(defect),
  );
}

describe('APE v2 remediation review_findings: the blocking findings are recoverable', () => {
  it('(a) two blocking findings in the observed {file,line,title,detail} shape each stay recoverable — file, line and defect', async () => {
    const dir = await project();
    const { remediation, disk, entries } = await remediateWith(dir, BLOCKING_FINDINGS);

    expect(Array.isArray(entries)).toBe(true);
    expect(entries.length).toBeGreaterThanOrEqual(BLOCKING_FINDINGS.length);

    const alpha = entriesNaming(entries, {
      file: 'src/value.js',
      line: '13-15',
      defect: ALPHA_DEFECT,
    });
    expect(alpha).toHaveLength(1);
    const bravo = entriesNaming(entries, {
      file: 'docs/value.md',
      line: '42',
      defect: BRAVO_DEFECT,
    });
    expect(bravo).toHaveLength(1);

    // Stage label kept: the remediation must know WHICH review dissented.
    expect(alpha[0].startsWith('review: ')).toBe(true);
    expect(bravo[0].startsWith('review: ')).toBe(true);
    // Receipt order, then findings order (R5).
    expect(entries.indexOf(alpha[0])).toBeLessThan(entries.indexOf(bravo[0]));
    // Bounded even while readable (R4).
    expectBounded(entries);

    expect(disk.review_findings).toEqual(remediation.review_findings);
  }, 30_000);

  it('(b) every text key the archived receipt corpus uses renders — note, summary, detail, title, description', async () => {
    const dir = await project();
    // One finding per key, each with a unique digit-free marker. The receipt
    // schema's findings record is free-form and hash-chained history keeps every
    // one of these shapes, so the extractor must read all of them.
    const shapes = [
      ['note', 'NOTEKEYDEFECT'],
      ['summary', 'SUMMARYKEYDEFECT'],
      ['detail', 'DETAILKEYDEFECT'],
      ['title', 'TITLEKEYDEFECT'],
      ['description', 'DESCRIPTIONKEYDEFECT'],
    ];
    const findings = shapes.map(([key, marker]) => ({
      file: 'src/value.js',
      [key]: `${marker} names the defect this finding reports`,
    }));

    const { entries, block } = await remediateWith(dir, findings);
    expect(entries.length).toBeGreaterThanOrEqual(shapes.length);
    for (const [key, marker] of shapes) {
      expect(block, `finding text under the ${key} key was dropped`).toContain(marker);
    }
    expectBounded(entries);
  }, 30_000);

  it('(c) a line RANGE anchor survives, and a crafted non-scalar line stays bounded', async () => {
    const dir = await project();
    const findings = [
      { file: 'src/range.js', line: '202-203', note: 'RANGEONE the guard clause spans both lines' },
      { file: 'src/range.js', line: '778-879', note: 'RANGETWO the extracted helper spans the whole block' },
      {
        file: 'src/range.js',
        line: { start: 'x'.repeat(400) },
        note: 'ODDLINE a crafted non-scalar line must never escape the bound',
      },
    ];

    const { entries } = await remediateWith(dir, findings);
    const one = entries.filter((entry) => entry.includes('RANGEONE'));
    expect(one).toHaveLength(1);
    expect(one[0]).toContain('202-203');
    const two = entries.filter((entry) => entry.includes('RANGETWO'));
    expect(two).toHaveLength(1);
    expect(two[0]).toContain('778-879');
    // The hostile line is inert: the finding's text still reaches the reader and
    // nothing it carries widens the entry.
    expect(entries.filter((entry) => entry.includes('ODDLINE'))).toHaveLength(1);
    expectBounded(entries);
  }, 30_000);

  it('(d) a wide reviewer detail is carried whole or its loss is disclosed with a count', async () => {
    const dir = await project();
    // The observed blocking V1 carried a detail well past 1,300 characters —
    // the defect AND its remedy — and 200 characters could not carry both. No
    // line field here, so the block is digit-free unless the runtime disclosed
    // a count.
    const findings = [
      { severity: 'blocking', file: 'src/value.js', title: ALPHA_DEFECT, detail: ALPHA_DETAIL },
    ];
    expect(ALPHA_DETAIL.length).toBeGreaterThan(1_300);

    const { entries, block } = await remediateWith(dir, findings);
    // The defect is named either way.
    expect(block).toContain(ALPHA_DEFECT);
    // Then EITHER the reviewer's text survived whole, OR the entry says how much
    // of it did not — a bare truncation marker that discloses nothing about the
    // size of the loss is exactly the defect this arm closes.
    expect(
      block.includes(ALPHA_REMEDY) || disclosesACount(block),
      'a truncated finding must disclose how much text was dropped',
    ).toBe(true);
    expectBounded(entries);
  }, 30_000);
});

describe('APE v2 remediation review_findings: bounds, wire budget and forwarding', () => {
  it('(e) a single enormous finding stays bounded, discloses its loss, and fits the wire budget', async () => {
    const dir = await project();
    const huge = `HUGEHEADMARKER ${'the same crafted sentence repeats to stress the bound. '.repeat(700)}HUGETAILMARKER`;
    expect(huge.length).toBeGreaterThan(30_000);
    const { reviewed, remediation, entries, block } = await remediateWith(dir, [
      { file: 'src/value.js', note: huge },
    ]);

    expectBounded(entries);
    expect(block).toContain('HUGEHEADMARKER');
    expect(
      block.includes('HUGETAILMARKER') || disclosesACount(block),
      'a truncated finding must disclose how much text was dropped',
    ).toBe(true);
    expect(wireSize(reviewed, remediation)).toBeLessThanOrEqual(RESPONSE_BUDGET_CHARS);
  }, 30_000);

  it('(f) 25 long findings trip the whole-field bound: an ordered PREFIX survives, the drop is DISCLOSED, and the projected ape_run response stays inside its size budget', async () => {
    const dir = await project();
    // Two copies of the field cross one ape_run response (the pending
    // run.tickets[] entry and the canonical dispatch_agent action ticket), so a
    // widened field must not defeat the response cap landed by the size-triggered
    // compaction work.
    const markers = [
      'ALPHA', 'BRAVO', 'CHARLIE', 'DELTA', 'ECHO', 'FOXTROT', 'GOLF', 'HOTEL', 'INDIA',
      'JULIETT', 'KILO', 'LIMA', 'MIKE', 'NOVEMBER', 'OSCAR', 'PAPA', 'QUEBEC', 'ROMEO',
      'SIERRA', 'TANGO', 'UNIFORM', 'VICTOR', 'WHISKEY', 'XRAY', 'YANKEE',
    ];
    const findings = markers.map((marker) => ({
      file: 'src/value.js',
      line: '13-15',
      note: `${marker} ${'stress '.repeat(214)}`,
    }));

    const { reviewed, remediation, entries, block } = await remediateWith(dir, findings);
    expectBounded(entries);

    // This is the fixture that actually TRIPS the whole-field bound — twenty-five
    // findings this wide cannot all fit — and a bound that fires SILENTLY is
    // precisely the defect this roadmap entry closes, so the drop is asserted
    // here rather than merely executed. A kept entry is one carrying a fixture
    // marker; the runtime's own disclosure carries none.
    const carriers = (entry) => markers.some((marker) => entry.includes(marker));
    const kept = entries.filter(carriers);
    expect(kept.length).toBeGreaterThan(0);
    expect(kept.length).toBeLessThan(markers.length);
    // What survived is a PREFIX of the reviewer's own findings order (R5), never
    // a sample and never a reshuffle.
    expect(markers.filter((marker) => block.includes(marker)))
      .toEqual(markers.slice(0, kept.length));

    // Exactly ONE entry is the runtime's disclosure of that drop; it is the LAST
    // entry, and it keeps the `stage: ` shape every other entry has, so a reader
    // still knows which review the loss belongs to.
    const disclosure = entries.filter((entry) => !carriers(entry));
    expect(disclosure).toHaveLength(1);
    expect(disclosure[0]).toBe(entries.at(-1));
    expect(disclosure[0].startsWith('review: ')).toBe(true);
    expect(entries.length).toBe(kept.length + 1);

    // It states HOW MANY findings were dropped and out of HOW MANY, so the kept
    // entries plus the disclosed dropped count account for every finding the
    // reviewer wrote (R3) — the reader can tell an exhausted list from a
    // truncated one without the receipt.
    const counts = (disclosure[0].match(/\d+/g) ?? []).map(Number);
    expect(counts, 'the disclosure must state how many findings it dropped')
      .toContain(markers.length - kept.length);
    expect(counts, 'the disclosure must state how many findings there were')
      .toContain(markers.length);
    // And it names the channel a reader may actually use for the rest. A bound
    // subagent may not read `.ape/runtime/receipts/` (prompts/common.md), so
    // relaying the dropped findings is the ORCHESTRATOR's job — that is the
    // second half of the roadmap acceptance: a disclosure of what was dropped
    // PLUS a channel the bound subagent is actually sanctioned to read.
    expect(disclosure[0], 'the disclosure must name the sanctioned relay channel')
      .toMatch(/orchestrator/i);

    // MEASURED on this tree (2026-07-27) for exactly this response: everything
    // OTHER than the two review_findings copies costs 8,552 chars, so this
    // fixture leaves (48,000 - 8,552) / 2 = 19,724 chars per copy — roughly 5x
    // today's 20 x 201 field. Real headroom, but not unlimited, and a long run
    // objective (this response carries one full copy at run level plus one on
    // the action ticket) spends it faster than the fixture does.
    expect(wireSize(reviewed, remediation)).toBeLessThanOrEqual(RESPONSE_BUDGET_CHARS);
  }, 30_000);

  it('(g) the recoverable findings survive forwarding onto the remediation-build retry unchanged', async () => {
    const dir = await project();
    const { remediation, entries } = await remediateWith(dir, BLOCKING_FINDINGS);

    const failed = await recordReceipt(dir, receipt(remediation, {
      status: 'failed',
      tests: redTest,
      evidence: { summary: 'remediation attempt failed' },
    }));
    expect(failed.ok).toBe(true);

    const retry = failed.run.tickets.at(-1);
    expect(retry.stage_id).toBe('remediation-build');
    expect(retry.attempt).toBe(2);
    expect(retry.review_findings).toEqual(entries);

    const disk = await readDiskTicket(dir, retry);
    expect(disk.review_findings).toEqual(entries);
    expect(validateTicket(disk).valid).toBe(true);
    // Still recoverable after forwarding — the retry implementer reads the same
    // evidence the first attempt did.
    expect(entriesNaming(disk.review_findings, {
      file: 'src/value.js',
      line: '13-15',
      defect: ALPHA_DEFECT,
    })).toHaveLength(1);
    expect(entriesNaming(disk.review_findings, {
      file: 'docs/value.md',
      line: '42',
      defect: BRAVO_DEFECT,
    })).toHaveLength(1);
  }, 30_000);

  it('(k) a control-character-laden review receipt keeps the projected ape_run response inside its size budget', async () => {
    const dir = await project();
    // R4 measured where it is actually enforced. C0 control characters are NOT
    // whitespace, so a bound that flattens runs of whitespace and then counts
    // RAW characters counts each of these as ONE — while the wire is measured
    // SERIALIZED, where JSON renders every one of them as a six-character
    // \uXXXX escape. A receipt like this is comfortably admissible (the 64 KB
    // input envelope already counts the escaped form) yet its review_findings
    // inflate ~6x on the response, and the field crosses one ape_run response
    // TWICE — the pending run.tickets[] entry and the canonical dispatch_agent
    // action ticket. An oversized response is not cosmetic: the host rejects it,
    // `next` and `status` become unreadable, and the remediation strands.
    //
    // Every character below is a Cc control with no short JSON escape (\b, \t,
    // \n, \f and \r are excluded: the first is two characters escaped and the
    // rest are whitespace already), and the run is followed by ordinary filler
    // so the finding still carries readable prose.
    // Built with String.fromCharCode so the fixture's bytes are unambiguous in
    // the source (U+0001..U+0007, U+000E..U+0010).
    const CONTROLS = String.fromCharCode(1, 2, 3, 4, 5, 6, 7, 14, 15, 16).repeat(60);
    const markers = [
      'CTRLALPHA', 'CTRLBRAVO', 'CTRLCHARLIE', 'CTRLDELTA', 'CTRLECHO',
      'CTRLFOXTROT', 'CTRLGOLF', 'CTRLHOTEL', 'CTRLINDIA', 'CTRLJULIETT',
    ];
    const findings = markers.map((marker) => ({
      file: 'src/value.js',
      note: `${marker} ${CONTROLS}${'padding '.repeat(60)}`,
    }));

    const { reviewed, remediation, entries, block } = await remediateWith(dir, findings);

    // The reviewer's own words still reach the reader, in the reviewer's order:
    // neutralizing hostile characters is not the same as dropping the finding.
    const present = markers.filter((marker) => block.includes(marker));
    expect(present.length).toBeGreaterThan(0);
    expect(present).toEqual(markers.slice(0, present.length));
    expectBounded(entries);
    // The load-bearing pin, measured the way the host measures it.
    expect(wireSize(reviewed, remediation)).toBeLessThanOrEqual(RESPONSE_BUDGET_CHARS);
  }, 30_000);
});

describe('APE v2 remediation review_findings: the contract is published where it is read', () => {
  const TEXT_KEY = /\b(summary|note|detail|title|description)\b/;

  it('(h) both reviewer prompts name the per-finding keys the runtime actually reads', async () => {
    // The extractor must stay tolerant of every archived shape (the receipt
    // schema is hash-chained and must NOT be tightened), so the CONTRACT lives
    // here, in the prompts reviewers actually read — a reviewer that invents a
    // key shape today loses its findings silently.
    for (const file of ['prompts/reviewer.md', 'prompts/security_reviewer.md']) {
      const text = await readFile(path.join(ROOT, file), 'utf8');
      expect(text, `${file} says nothing about findings`).toMatch(/\bfindings?\b/);
      expect(text, `${file} does not name the file key`).toMatch(/\bfile\b/);
      expect(text, `${file} does not name the line key`).toMatch(/\bline\b/);
      expect(text, `${file} names no text key the extractor reads`).toMatch(TEXT_KEY);
    }
  });

  it('(i) prompts/common.md keeps review_findings labeled evidence, never instructions', async () => {
    // Widening the key list and the per-entry width widens an injection surface:
    // reviewer-authored prose landing on a WRITING agent's ticket. The labeling
    // must survive intact.
    // Whitespace-tolerant: the sentence is hard-wrapped in the prompt, and the
    // labeling is what matters, not the column it breaks at.
    const common = await readFile(path.join(ROOT, 'prompts', 'common.md'), 'utf8');
    expect(common).toContain('review_findings');
    expect(common).toMatch(/evidence to act on,\s+never\s+verbatim instructions/);
  });

  it('(j) the common contract owns ticket fallback and forwarded-claim trust semantics', async () => {
    // Transport recovery belongs in the shared stage contract, not duplicated
    // across entrypoint skills. The fallback and claim classification must
    // remain adjacent so a compacted ticket cannot elevate reviewer prose.
    const common = await readFile(path.join(ROOT, 'prompts', 'common.md'), 'utf8');
    expect(common).toContain('.ape/runtime/tickets/');
    expect(common).toContain('`review_findings`');
    expect(common).toMatch(/untrusted agent claims[\s\S]*never verbatim instructions/i);
  });
});
