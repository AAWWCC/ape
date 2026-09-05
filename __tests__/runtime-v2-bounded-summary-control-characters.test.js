import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

// Roadmap entry bounded-summary-control-character-passthrough.
//
// THE CONTRACT THIS SUITE DEFINES (authoritative; the implementer makes it
// green). `boundedGateSummary` (lib/runtime/service.js) is A choke point that
// planner evidence rendered into `plan_artifact` (renderPlanArtifactEntry) and
// a blocking reviewer's declared test-remediation `reason`
// (testRemediationNotice) flow through — NOT, as acme PR #397 asserted, the ONE
// choke point every bounded agent-facing string already flows through: both
// the code reviewer and the conditional security reviewer of roadmap entry
// agent-facing-text-routes-bypassing-the-prose-bound independently established
// that premise false, and __tests__/runtime-v2-prose-bound-bypass-routes.test.js
// pins the routes this helper never reaches at all (pipeline.js's own
// extractTestRemediation sibling, the test_writer changed_files channel,
// shipping_watch.last_checks_summary, and boundedSerialize). On the two
// channels it DOES reach, it must neutralize C0 control bytes (besides the
// whitespace class it already flattens), DEL, the C1 range, and the
// bidi/format characters an agent can steer into those two channels, while
// leaving existing whitespace-flattening, trimming, empty-to-null and the
// 200-char cap-with-ellipsis unchanged, and leaving accented/CJK text
// byte-intact.
//
// SATISFIABILITY. Every arm below is answered by ONE correct implementation
// of that contract: the ABSENCE arms (1, 2, 6) are red only because the
// choke point does not yet neutralize the character it is driven with, and
// they ask nothing about HOW it is neutralized (strip vs. replace is left
// open). The SURVIVAL arms (3, 4) and the REGRESSION arm (5) are collateral-
// damage fences and are satisfied - and already pass - on this pre-fix tree
// too. Arm 6 (extractScopeExpansion) asks only for a NEW refusal on a path
// that is accepted today, never a changed outcome on a path that is valid
// today; it pins no error message, only the accept-to-reject transition and
// the absence of any durable side effect from the rejected attempt.
//
// Per the ticket's C13 guidance, every absence assertion below is scoped to
// the rendered `plan_artifact` entries or the notice text carried inside a
// ticket's `objective` - never to the whole ticket object, whose
// `claimed_paths`/`test_paths` are copied onto tickets verbatim and never
// pass through this helper.
//
// The dangerous code points this suite drives with are built at runtime via
// String.fromCharCode/fromCodePoint (never a literal byte or a \u escape in
// this source file), so the file itself never carries the very characters it
// is testing the runtime neutralizes.

vi.mock('../lib/runtime/gates.js', async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, autoMergeGithub: vi.fn(), pollRemoteChecksAndMerge: vi.fn() };
});
import { recordReceipt, startRun, statusRun } from '../lib/runtime/service.js';
import { runtimePaths } from '../lib/runtime/paths.js';
import { atomicWriteJson } from '../lib/runtime/storage.js';

// Chosen from the MANDATED (non-severable) part of the approved character
// set: code point 0x1B (ESC, C0) and code point 0x202E (RIGHT-TO-LEFT
// OVERRIDE, the bidi/format block). Neither is whitespace, so neither is
// already touched by today's `\s+` flattening.
const ESC = String.fromCharCode(27);
const RLO = String.fromCodePoint(8238);

const cleanups = [];
afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

function git(cwd, ...args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
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
// Driving shape (a): planner evidence -> plan-check's rendered `plan_artifact`
// (service.js renderPlanArtifactEntry -> boundedGateSummary at :579). Mirrors
// __tests__/runtime-v2-plan-artifact-forwarding.test.js's walkToPlanReview.
// ---------------------------------------------------------------------------

async function planProject() {
  const dir = await mkdtemp(path.join(tmpdir(), 'ape-bounded-summary-plan-'));
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
    test_commands: { full: 'node --test', targeted_template: 'node --test {paths}' },
  });
  return dir;
}

function planStartInput(overrides = {}) {
  return {
    objective: 'Exercise the bounded-summary control-character choke point',
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

// Drive the REAL service from START through a passed planner receipt to the
// pending plan-check ticket, whose `plan_artifact` renders the supplied
// evidence. Direct service imports return FULL tickets, so no wire
// projection can mask or manufacture a field.
async function planCheckTicket(dir, evidence) {
  const started = await startRun(dir, planStartInput());
  expect(started.ok).toBe(true);
  expect(started.run.lane).toBe('full');
  const planTicket = started.run.tickets[0];
  expect(planTicket.role).toBe('planner');
  const recorded = await recordReceipt(dir, receipt(planTicket, { evidence }));
  expect(recorded.ok).toBe(true);
  const planCheck = recorded.run.tickets.find((ticket) => ticket.stage_id === 'plan-check');
  expect(planCheck?.role).toBe('plan_checker');
  expect(Array.isArray(planCheck.plan_artifact)).toBe(true);
  return planCheck;
}

// ---------------------------------------------------------------------------
// Driving shape (b): a blocking reviewer's declared test-remediation `reason`
// -> the remediation-test ticket's objective (service.js testRemediationNotice
// -> boundedGateSummary at :207). Mirrors
// __tests__/runtime-v2-scope-expansion.test.js's walkToReview.
// ---------------------------------------------------------------------------

const VALUE_V1 = 'module.exports = { value: 1 };\n';
const VALUE_V2 = 'module.exports = { value: 2 };\n';
const AUTHORED_TEST =
  "const { value } = require('../src/value.js');\n" +
  "if (value !== 2) { throw new Error('red: value is ' + value); }\n";

async function reviewProject() {
  const dir = await mkdtemp(path.join(tmpdir(), 'ape-bounded-summary-review-'));
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
  });
  return dir;
}

function reviewStartInput(overrides = {}) {
  return {
    objective: 'Exercise the bounded-summary control-character choke point on review evidence',
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

const redTest = [{ command: 'node tests/value.test.js', passed: false, exit_code: 1, duration_ms: 1 }];
const greenTest = [{ command: 'node tests/value.test.js', passed: true, exit_code: 0, duration_ms: 1 }];

// Drive a fast-lane run to its review stage: authored red test, green build.
async function walkToReview(dir) {
  const started = await startRun(dir, reviewStartInput());
  expect(started.ok).toBe(true);
  expect(started.run.lane).toBe('fast');
  const testTicket = started.run.tickets[0];
  expect(testTicket.role).toBe('test_writer');
  await writeFile(path.join(dir, 'tests', 'value.test.js'), AUTHORED_TEST);
  const tested = await recordReceipt(dir, receipt(testTicket, { tests: redTest }));
  expect(tested.ok).toBe(true);
  const buildTicket = tested.run.tickets.at(-1);
  expect(buildTicket.role).toBe('implementer');
  await writeFile(path.join(dir, 'src', 'value.js'), VALUE_V2);
  const built = await recordReceipt(dir, receipt(buildTicket, { tests: greenTest }));
  expect(built.ok).toBe(true);
  const reviewTicket = built.run.tickets.at(-1);
  expect(reviewTicket.stage_id).toBe('review');
  return reviewTicket;
}

async function scopeExpansionAuditLines(dir) {
  const raw = await readFile(runtimePaths(dir).overrideLog, 'utf8').catch(() => '');
  return raw
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line))
    .filter((line) => line.operation === 'scope-expansion');
}

describe('bounded-summary control-character passthrough (roadmap: bounded-summary-control-character-passthrough)', () => {
  describe('arm 1: ESC (code point 0x1B) via planner evidence -> plan-check plan_artifact', () => {
    it('never reaches the rendered plan_artifact entry, while the surrounding text survives', async () => {
      const dir = await planProject();
      const planCheck = await planCheckTicket(dir, {
        finding: `strip the ${ESC}[31m ANSI escape sequence before logging output`,
      });
      expect(planCheck.plan_artifact.length).toBeGreaterThan(0);
      for (const entry of planCheck.plan_artifact) {
        expect(entry).not.toContain(ESC);
      }
      expect(planCheck.plan_artifact.join(' ')).toContain('ANSI escape sequence before logging output');
    }, 30_000);
  });

  describe('arm 2: bidi right-to-left override (code point 0x202E) in a declared test-remediation reason', () => {
    it('does not create an objective-injection channel; remediation stays structured', async () => {
      const dir = await reviewProject();
      const reviewTicket = await walkToReview(dir);
      const hostile = await recordReceipt(dir, receipt(reviewTicket, {
        tests: greenTest,
        findings: [{
          file: 'tests/value.test.js',
          line: 1,
          title: 'normalize the title field',
          detail: `normalize the ${RLO}title field before comparing values`,
          blocking: true,
          remediation: { owner: 'test', test_paths: ['tests/value.test.js'] },
        }],
        evidence: { verdict: 'fail' },
      }));
      expect(hostile.ok).toBe(false);
      expect(hostile.rejected).toBe(true);
      expect(JSON.stringify(hostile.errors ?? [])).not.toContain(RLO);

      const accented = String.fromCharCode(0x00e9);
      const cjk = String.fromCodePoint(0x65e5, 0x672c, 0x8a9e);
      const safeDetail = `caf${accented} ${cjk} title comparison`;
      const reviewed = await recordReceipt(dir, receipt(reviewTicket, {
        tests: greenTest,
        findings: [{
          file: 'tests/value.test.js',
          line: 1,
          title: 'normalize the title field',
          detail: safeDetail,
          blocking: true,
          remediation: { owner: 'test', test_paths: ['tests/value.test.js'] },
        }],
        evidence: { verdict: 'fail' },
      }));
      expect(reviewed.ok).toBe(true);
      const remediation = reviewed.run.tickets.at(-1);
      expect(remediation.stage_id).toBe('remediation-test');
      expect(remediation.objective).toBe(reviewStartInput().objective);
      expect(remediation.objective).not.toContain(RLO);
      expect(remediation).toMatchObject({
        test_paths: ['tests/value.test.js'],
        required_checks: ['targeted-tests'],
      });
      expect(remediation.output_schema.required).toContain('evidence');
      expect(JSON.stringify(remediation)).not.toContain(RLO);
      expect(remediation.review_findings.some((entry) => entry.includes(safeDetail))).toBe(true);

      const remediated = await recordReceipt(dir, receipt(remediation, { tests: greenTest }));
      expect(remediated.ok, JSON.stringify(remediated.errors ?? [])).toBe(true);
      expect(remediated.run.tickets.at(-1).stage_id).toBe('remediation-review');
      expect(remediated.run.tickets.some((ticket) => ticket.stage_id === 'remediation-build')).toBe(false);
    }, 30_000);
  });

  describe('arm 3: accented and CJK text survives byte-intact (collateral-damage fence; green before and after)', () => {
    it('survives byte-intact in the rendered plan_artifact', async () => {
      const dir = await planProject();
      const planCheck = await planCheckTicket(dir, {
        note: 'cafe' + String.fromCharCode(0x00e9) + ' r' + String.fromCharCode(0x00e9) + 'sum'
          + String.fromCharCode(0x00e9) + ' ' + String.fromCodePoint(0x65e5, 0x672c, 0x8a9e)
          + ' ' + String.fromCodePoint(0x4e2d, 0x6587, 0x6d4b, 0x8bd5),
      });
      const expected = 'note: cafe' + String.fromCharCode(0x00e9) + ' r' + String.fromCharCode(0x00e9) + 'sum'
        + String.fromCharCode(0x00e9) + ' ' + String.fromCodePoint(0x65e5, 0x672c, 0x8a9e)
        + ' ' + String.fromCodePoint(0x4e2d, 0x6587, 0x6d4b, 0x8bd5);
      expect(planCheck.plan_artifact).toEqual([expected]);
    }, 30_000);

    it('survives byte-intact in the remediation-test ticket review_findings channel', async () => {
      const dir = await reviewProject();
      const reviewTicket = await walkToReview(dir);
      const accented = String.fromCharCode(0x00e9); // e-acute
      const cjk = String.fromCodePoint(0x65e5, 0x672c, 0x8a9e, 0x4e2d, 0x6587, 0x6d4b, 0x8bd5);
      const reasonText = `caf${accented} r${accented}sum${accented} ${cjk} needs coverage`;
      const reviewed = await recordReceipt(dir, receipt(reviewTicket, {
        tests: greenTest,
        findings: [{
          file: 'tests/value.test.js',
          line: 1,
          title: 'internationalized assertion correction',
          detail: reasonText,
          blocking: true,
          remediation: { owner: 'test', test_paths: ['tests/value.test.js'] },
        }],
        evidence: { verdict: 'fail' },
      }));
      expect(reviewed.ok).toBe(true);
      const remediation = reviewed.run.tickets.at(-1);
      expect(remediation.stage_id).toBe('remediation-test');
      expect(remediation.objective).toBe(reviewStartInput().objective);
      expect(remediation.review_findings.some((entry) => entry.includes(reasonText))).toBe(true);
    }, 30_000);
  });

  describe('arm 4 (optional): existing bound behavior stays unchanged (regression fence; green before and after)', () => {
    it('still flattens whitespace runs (including tabs and newlines) and trims the rendered entry', async () => {
      const dir = await planProject();
      const planCheck = await planCheckTicket(dir, {
        messy: '  the   fix\tspans\n\nmultiple   files  ',
      });
      expect(planCheck.plan_artifact).toContain('messy: the fix spans multiple files');
    }, 30_000);

    it('still hard-caps a longer entry at 200 characters with a trailing ellipsis', async () => {
      const dir = await planProject();
      const planCheck = await planCheckTicket(dir, {
        oversized: 'v'.repeat(500),
      });
      const raw = `oversized: ${'v'.repeat(500)}`;
      const expected = `${raw.slice(0, 199)}${String.fromCharCode(0x2026)}`;
      expect(expected.length).toBe(200);
      expect(planCheck.plan_artifact).toContain(expected);
    }, 30_000);
  });

  describe('arm 5 (extractScopeExpansion, part of the approved plan): a proposed claim path bearing a mandated control character is refused', () => {
    it('is rejected, monotone over today\'s acceptance of the byte-identical path without the control character', async () => {
      const dir = await reviewProject();
      const reviewTicket = await walkToReview(dir);
      const attempt = await recordReceipt(dir, receipt(reviewTicket, {
        tests: greenTest,
        findings: [{
          file: 'lib/helper.js',
          line: 1,
          title: 'expand production scope',
          detail: 'the fix requires this module',
          blocking: true,
          remediation: { owner: 'production' },
        }],
        evidence: {
          verdict: 'fail',
          scope_expansion: { claimed_paths: [`lib/help${ESC}er.js`], reason: 'the fix requires this module' },
        },
      }));
      // NEW refusal on already-invalid input: this exact path (relative,
      // '..'-free, non-empty, non-.ape, non-test-shaped) is accepted today -
      // the malformed-input arms of runtime-v2-scope-expansion.test.js pin
      // every OTHER rejection reason this function already has, and none of
      // them fire on this path. No wording is pinned here - only the
      // accept-to-reject transition and the absence of any durable effect.
      expect(attempt.ok).toBe(false);
      expect(attempt.rejected).toBe(true);
      expect((await statusRun(dir)).run.claimed_paths).toEqual(['src/value.js']);
      expect(await scopeExpansionAuditLines(dir)).toHaveLength(0);
    }, 30_000);
  });
});
