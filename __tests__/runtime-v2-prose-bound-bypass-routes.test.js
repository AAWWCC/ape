import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

// Roadmap entry agent-facing-text-routes-bypassing-the-prose-bound.
//
// acme PR #397 hardened `boundedGateSummary` (lib/runtime/service.js) and justified
// fixing that one helper by asserting it is the single choke point every
// bounded agent-facing string passes through. Both the code reviewer and the
// conditional security reviewer independently established that premise is
// false: at least four OTHER agent-facing text routes bypass it entirely. This
// suite pins the four routes named in the run objective plus the
// self-referential defect the investigation surfaced along the way:
//
//   (a) CLOSE  — pipeline.js `extractTestRemediation` (the declared structural
//       sibling of `extractScopeExpansion`) screens no character set on a
//       reviewer's declared `evidence.test_remediation.test_paths`, so a
//       control/bidi-bearing declaration is admitted and its raw bytes land on
//       a bound test_writer subagent's own remediation-test ticket
//       (claimed_paths/test_paths, service.js narrowedTestClaims/issueTicket).
//   (b) RECORD — the test_writer `changed_files` route. Not closed: it is
//       runtime-DERIVED from a real git diff and stamped over whatever the
//       agent supplied (service.js recordReceiptLocked), so it can never carry
//       an injected byte in the first place. Pinned here as a GREEN
//       collateral-damage fence, not a red anchor, so a future change cannot
//       silently start trusting the agent-supplied value.
//   (c) CLOSE — `shipping_watch.last_checks_summary`: assigned raw from a
//       remote-checks poll, emitted raw in the same poll's `shipping_pending`
//       action, and spliced raw into `resumeRun`'s `dispatch_pending` reason on
//       a later call.
//   (d) CLOSE — `boundedSerialize` (service.js): JSON.stringify escapes only
//       U+0000-U+001F, so DEL, soft hyphen and every bidi/format code point
//       pass through intact into a malformed-risk-trigger warning/audit line
//       and into `echoRunId`'s refusal reasons.
//
// SELF-REFERENTIAL DEFECT (CLOSE) — the scope-expansion control-character
// refusal (extractScopeExpansion, service.js) interpolates the OFFENDING PATH
// RAW into its own errors[] entry, so a reviewer-supplied bidi override reaches
// the operator's terminal in the very message refusing that byte; the sibling
// messages in the same loop have the identical unguarded interpolation.
//
// SATISFIABILITY (prompts/test_writer.md): every red arm below asks only for
// an accept-to-reject transition on already-invalid input, or for a byte
// substitution that leaves the surrounding readable text intact — never a
// pinned wording, never a changed outcome on input valid today. No arm asks
// for two contradictory outcomes of the same call.
//
// TEST-AUTHORING HAZARD (do not repeat it — this run supersedes
// run-fixture-b5b7fa9857f7, which blocked exactly here): route (a)'s
// rejected declaration is validated PRE-DURABLY (service.js:3126, before the
// transaction write at :3175 and the receipt write at :3186), so it leaves no
// transaction and no receipt. The arm below therefore records the malformed
// declaration, observes the rejection, and THEN records the corrected
// declaration against the SAME ticket_id directly — no intermediate probe
// receipt is ever recorded against that ticket. The corrected record's success
// is itself the evidence that the rejected attempt left no durable trace: had
// it committed a transaction, the corrected (differently-shaped) record would
// have been refused by the pre-existing per-ticket idempotency guard.
//
// The dangerous code points this suite drives with are built at runtime via
// String.fromCharCode/fromCodePoint (never a literal byte or a \u escape in
// this source file), so the file itself never carries the very characters it
// is testing the runtime neutralizes.

vi.mock('../lib/runtime/gates.js', async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, autoMergeGithub: vi.fn(), pollRemoteChecksAndMerge: vi.fn() };
});
import { autoMergeGithub, pollRemoteChecksAndMerge } from '../lib/runtime/gates.js';
import {
  abortRun,
  nextRun,
  recordReceipt,
  resumeRun,
  startRun,
  statusRun,
} from '../lib/runtime/service.js';
import { runtimePaths } from '../lib/runtime/paths.js';
import { atomicWriteJson } from '../lib/runtime/storage.js';

// C0 control (ESC), DEL, RIGHT-TO-LEFT OVERRIDE (bidi/format), and ZERO WIDTH
// NON-JOINER (format; admitted by extractScopeExpansion's one-sided ZWNJ/ZWJ
// exemption but neutralized by the RENDER-side character set) — built
// numerically per the authoring hazard the run objective names three times.
const ESC = String.fromCharCode(0x1b);
const DEL = String.fromCharCode(0x7f);
const RLO = String.fromCodePoint(0x202e);
const ZWNJ = String.fromCodePoint(0x200c);

const cleanups = [];
afterEach(async () => {
  autoMergeGithub.mockReset();
  pollRemoteChecksAndMerge.mockReset();
  await Promise.all(cleanups.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

function git(cwd, ...args) {
  execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
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
// Shared review-walk fixture for routes (a) and (b) and the self-referential
// defect: a fast-lane run driven for real from start through the review stage,
// whose receipt carries evidence.scope_expansion / evidence.test_remediation.
// ---------------------------------------------------------------------------

const VALUE_V1 = 'module.exports = { value: 1 };\n';
const VALUE_V2 = 'module.exports = { value: 2 };\n';
const AUTHORED_TEST =
  "const { value } = require('../src/value.js');\n" +
  "if (value !== 2) { throw new Error('red: value is ' + value); }\n";

async function reviewProject() {
  const dir = await mkdtemp(path.join(tmpdir(), 'ape-prose-bound-review-'));
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
    objective: 'Exercise the prose-bound bypass routes on review evidence',
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
  return { reviewTicket, testTicket: started.run.tickets[0] };
}

describe('route (a): pipeline.js extractTestRemediation admits a raw control/bidi byte onto the remediation-test ticket claims — CLOSE', () => {
  it(
    'refuses a declared test_paths entry bearing a bidi override, monotone over the byte-identical path without it, and the corrected declaration then succeeds against the SAME ticket — proving no durable side effect from the rejected attempt',
    async () => {
      const dir = await reviewProject();
      const { reviewTicket } = await walkToReview(dir);

      const malformed = await recordReceipt(dir, receipt(reviewTicket, {
        tests: greenTest,
        evidence: {
          verdict: 'fail',
          test_remediation: {
            test_paths: [`tests/mal${RLO}formed.test.js`],
            reason: 'the assertion needs a bidi-safe title comparison',
          },
        },
      }));
      // NEW refusal on already-invalid input: extractTestRemediation admits
      // this exact path today (file-shaped, under the widened test-scope
      // directory, no other defect) — no wording is pinned, only the
      // accept-to-reject transition.
      expect(malformed.ok).toBe(false);
      expect(malformed.rejected).toBe(true);
      // Pin the errors[] channel too, not only the ticket-claims outcome
      // above: a refusal that is byte-clean on this channel is the whole
      // point of the self-referential defect this run closes, so the
      // closure of route (a) must be evidenced here as well.
      expect(Array.isArray(malformed.errors)).toBe(true);
      expect(malformed.errors.length).toBeGreaterThan(0);
      expect(malformed.errors.some((message) => message.includes(RLO))).toBe(false);
      // The readable prose around the neutralized byte must survive intact.
      expect(malformed.errors.some((message) => message.includes('bidi/format character'))).toBe(true);

      // Do NOT record a probe here (the hazard that blocked the superseded
      // run): the rejected attempt above is pre-durable, so the corrected
      // declaration below is recorded directly against the same ticket_id.
      const corrected = await recordReceipt(dir, receipt(reviewTicket, {
        tests: greenTest,
        evidence: {
          verdict: 'fail',
          test_remediation: {
            test_paths: ['tests/value.test.js'],
            reason: 'the assertion needs a bidi-safe title comparison',
          },
        },
      }));
      expect(corrected.ok).toBe(true);
      const remediation = corrected.run.tickets.at(-1);
      expect(remediation.stage_id).toBe('remediation-test');
      expect(remediation.test_paths).toEqual(['tests/value.test.js']);
      expect(remediation.claimed_paths).toEqual(['tests/value.test.js']);
    },
    30_000,
  );
});

describe('self-referential defect: extractScopeExpansion interpolates the offending path RAW into its own refusal message — CLOSE', () => {
  it(
    'the control-character refusal itself does not carry the raw bidi override byte it exists to refuse',
    async () => {
      const dir = await reviewProject();
      const { reviewTicket } = await walkToReview(dir);
      const attempt = await recordReceipt(dir, receipt(reviewTicket, {
        tests: greenTest,
        evidence: {
          verdict: 'fail',
          scope_expansion: { claimed_paths: [`lib/help${RLO}er.js`], reason: 'the fix requires this module' },
        },
      }));
      expect(attempt.ok).toBe(false);
      expect(attempt.rejected).toBe(true);
      expect(Array.isArray(attempt.errors)).toBe(true);
      expect(attempt.errors.length).toBeGreaterThan(0);
      expect(attempt.errors.some((message) => message.includes(RLO))).toBe(false);
    },
    30_000,
  );

  it(
    "a sibling message in the same loop (the '..' segment refusal) is rendered through the same neutralizer for an admitted-but-render-neutralized ZWNJ byte",
    async () => {
      const dir = await reviewProject();
      const { reviewTicket } = await walkToReview(dir);
      const attempt = await recordReceipt(dir, receipt(reviewTicket, {
        tests: greenTest,
        evidence: {
          verdict: 'fail',
          scope_expansion: { claimed_paths: [`lib${ZWNJ}/../evil.js`], reason: 'x' },
        },
      }));
      expect(attempt.ok).toBe(false);
      expect(attempt.rejected).toBe(true);
      // ZWNJ is exempted by the ADMISSION character set, so this path is
      // refused by the '..'-segment check, not the control-character one —
      // proving the sibling message, not the primary one, is under test.
      expect(attempt.errors.some((message) => message.includes("'..' segments"))).toBe(true);
      expect(attempt.errors.some((message) => message.includes(ZWNJ))).toBe(false);
    },
    30_000,
  );
});

describe('route (b): test_writer changed_files is RUNTIME-DERIVED, never agent-supplied — RECORD, not CLOSE (already true today)', () => {
  it(
    'a control/bidi-bearing changed_files value the agent supplies on the receipt never reaches the recorded receipt or state.test_paths: the runtime overwrites it with the real git diff before either is touched',
    async () => {
      const dir = await reviewProject();
      const started = await startRun(dir, reviewStartInput());
      expect(started.ok).toBe(true);
      const testTicket = started.run.tickets[0];
      expect(testTicket.role).toBe('test_writer');
      // A genuine change to the authored test (still red), so the real git
      // diff is non-empty and this arm cannot pass by vacuous absence.
      await writeFile(path.join(dir, 'tests', 'value.test.js'), "throw new Error('red: needs a bidi-safe comparison');\n");
      const attempt = await recordReceipt(dir, receipt(testTicket, {
        tests: redTest,
        // Malicious wire payload: service.js never reads this field (it is
        // absent from RECEIPT_INPUT_SCHEMA's required set on purpose —
        // receipt-input.js says so), so it can never inject a byte here.
        changed_files: [`tests/mal${RLO}icious.test.js`],
      }));
      expect(attempt.ok).toBe(true);
      const recordedReceipt = attempt.run.receipts.at(-1);
      expect(recordedReceipt.changed_files).toEqual(['tests/value.test.js']);
      expect(recordedReceipt.changed_files.some((file) => file.includes(RLO))).toBe(false);
      expect(attempt.run.test_paths).toEqual(['tests/value.test.js']);
    },
    30_000,
  );
});

// ---------------------------------------------------------------------------
// Route (c): shipping_watch.last_checks_summary.
// ---------------------------------------------------------------------------

async function docsProject(shippingOverrides = {}) {
  const dir = await mkdtemp(path.join(tmpdir(), 'ape-prose-bound-docs-'));
  cleanups.push(dir);
  await mkdir(path.join(dir, 'docs'));
  await writeFile(path.join(dir, 'docs', 'note.md'), '# note\n');
  git(dir, 'init', '-q');
  git(dir, 'config', 'user.email', 'ape@example.test');
  git(dir, 'config', 'user.name', 'APE Test');
  git(dir, 'add', '.');
  git(dir, 'commit', '-qm', 'test: baseline');
  await atomicWriteJson(runtimePaths(dir).config, {
    shipping: { auto_merge: false, provider: 'github', required_remote_checks: false, ...shippingOverrides },
    test_commands: { full: 'node --version' },
  });
  return dir;
}

function docsStartInput(overrides = {}) {
  return {
    objective: 'Update the deployment note',
    mode: 'phase',
    lane: 'mechanical',
    host: 'codex',
    claimed_paths: ['docs/note.md'],
    test_paths: [],
    requirements: ['R-PROSE-BOUND'],
    risk_triggers: [],
    behavioral: false,
    hooks_trusted: true,
    subagents_available: true,
    explicit_invocation: true,
    ...overrides,
  };
}

// Drives a docs-only mechanical build for real through green gates and into
// the non-blocking shipping watch: autoMergeGithub is mocked to hand back a
// `watch` (required-remote-checks) shape instead of an in-call merge, exactly
// the A6 discrimination service.js applies on the real GitHub response.
async function buildToShippingWatch(dir, watchOverrides = {}) {
  autoMergeGithub.mockResolvedValueOnce({
    watch: {
      provider: 'github',
      pr_url: 'https://github.com/acme/repo/pull/42',
      branch: 'ape/phase-prose-bound',
      base: 'main',
      head_oid: 'a'.repeat(40),
      created_at: new Date().toISOString(),
      ...watchOverrides,
    },
  });
  const started = await startRun(dir, docsStartInput());
  expect(started.ok).toBe(true);
  const build = started.run.tickets[0];
  expect(build.role).toBe('implementer');
  await writeFile(path.join(dir, 'docs', 'note.md'), '# note\n\nUpdated.\n');
  const result = await recordReceipt(dir, receipt(build, {
    tests: [{ command: 'node --version', passed: true, exit_code: 0, duration_ms: 1 }],
  }));
  expect(result.ok).toBe(true);
  expect(result.run.status).toBe('shipping');
  expect(result.run.shipping_watch).toBeTruthy();
  return result.run;
}

describe('route (c): shipping_watch.last_checks_summary — CLOSE at the assignment plus both emission sites', () => {
  it(
    'neutralizes a control byte in a fresh remote-checks poll summary at both the persisted assignment and the shipping_pending emission',
    async () => {
      const dir = await docsProject({ auto_merge: true, required_remote_checks: true });
      await buildToShippingWatch(dir);
      pollRemoteChecksAndMerge.mockResolvedValueOnce({
        merged: null,
        failed: null,
        pending: { summary: `CI tail ${ESC} still running` },
      });
      const next = await nextRun(dir);
      expect(next.ok).toBe(true);
      const pending = next.actions.find((action) => action.type === 'shipping_pending');
      expect(pending).toBeDefined();
      expect(pending.summary).not.toContain(ESC);
      expect(pending.summary).toContain('CI tail');
      expect(pending.summary).toContain('still running');

      const status = await statusRun(dir);
      expect(status.run.shipping_watch.last_checks_summary).not.toContain(ESC);
      expect(status.run.shipping_watch.last_checks_summary).toContain('CI tail');
    },
    30_000,
  );

  // Defense-in-depth arm for legacy/seeded state (recorded, not this ticket's
  // to fix, that a pre-existing active.json written before this change still
  // renders unbounded through scheduler.js's SHIP rest-state refusal): the
  // SEPARATE resumeRun splice site must independently neutralize whatever it
  // reads, so the fix does not depend on every writer of this field agreeing.
  it(
    "resumeRun neutralizes a raw control byte already sitting in shipping_watch.last_checks_summary before splicing it into the dispatch_pending reason",
    async () => {
      const dir = await mkdtemp(path.join(tmpdir(), 'ape-prose-bound-legacy-'));
      cleanups.push(dir);
      const paths = runtimePaths(dir);
      await atomicWriteJson(paths.active, {
        version: 2,
        schema_version: '2.0.0',
        run_id: 'run-legacy-shipping-watch',
        objective: 'Ship the legacy note',
        mode: 'phase',
        lane: 'mechanical',
        requested_lane: 'mechanical',
        lane_reasons: [],
        lane_escalated: false,
        behavioral: false,
        high_risk: false,
        policy: { high_risk_security_review: true },
        host: 'codex',
        status: 'shipping',
        stage: 'merge',
        block_reason: null,
        claimed_paths: ['docs/note.md'],
        test_paths: [],
        requirements: ['R-legacy'],
        risk_triggers: [],
        branch: 'ape/phase-legacy',
        base_commit_sha: 'a'.repeat(40),
        tree_sha: 'b'.repeat(40),
        tickets: [],
        receipts: [],
        attempts: {},
        remediation_cycles: 0,
        regate_attempts: 0,
        timing: { test_ms: 0, remote_ci_ms: 0 },
        created_at: '2026-07-01T00:00:00.000Z',
        updated_at: '2026-07-01T00:00:00.000Z',
        shipping_watch: {
          provider: 'github',
          pr_url: 'https://github.com/acme/repo/pull/77',
          branch: 'ape/phase-legacy',
          base: 'main',
          head_oid: 'c'.repeat(40),
          created_at: '2026-07-30T00:00:00.000Z',
          last_poll_at: '2026-07-30T00:01:00.000Z',
          poll_count: 2,
          last_checks_summary: `legacy CI tail ${ESC} still pending`,
        },
      });

      const result = await resumeRun(dir);
      expect(result.ok).toBe(true);
      const pending = result.actions.find((action) => action.type === 'dispatch_pending');
      expect(pending).toBeDefined();
      expect(pending.reason).not.toContain(ESC);
      expect(pending.reason).toContain('legacy CI tail');
      expect(pending.reason).toContain('still pending');
    },
    30_000,
  );
});

// ---------------------------------------------------------------------------
// Route (d): boundedSerialize.
// ---------------------------------------------------------------------------

describe('route (d): boundedSerialize passes DEL/soft-hyphen/bidi bytes through JSON.stringify unescaped — CLOSE', () => {
  it(
    'neutralizes DEL and a bidi override byte before they reach a malformed-risk-trigger receipt warning and its overrides.ndjson audit line',
    async () => {
      const dir = await docsProject();
      const started = await startRun(dir, docsStartInput());
      expect(started.ok).toBe(true);
      const build = started.run.tickets[0];
      await writeFile(path.join(dir, 'docs', 'note.md'), '# note\n\nUpdated with a payload.\n');
      const recorded = await recordReceipt(dir, receipt(build, {
        tests: [{ command: 'node --version', passed: true, exit_code: 0, duration_ms: 1 }],
        evidence: {
          verdict: 'pass',
          // A non-string entry: boundedSerialize renders it via
          // JSON.stringify, which escapes neither DEL nor a bidi override.
          risk_triggers: [{ note: `payload ${DEL} then ${RLO} bidi` }],
        },
      }));
      expect(recorded.ok).toBe(true);
      const warning = recorded.warnings?.find((entry) => entry.kind === 'malformed_risk_triggers');
      expect(warning).toBeDefined();
      expect(warning.message).not.toContain(DEL);
      expect(warning.message).not.toContain(RLO);
      expect(warning.message).toContain('payload');

      const overrideLines = (await readFile(runtimePaths(dir).overrideLog, 'utf8'))
        .trim()
        .split(/\r?\n/)
        .filter(Boolean)
        .map((line) => JSON.parse(line));
      const audit = overrideLines.find((entry) => entry.event === 'malformed_risk_triggers');
      expect(audit).toBeDefined();
      expect(audit.reason).not.toContain(DEL);
      expect(audit.reason).not.toContain(RLO);
    },
    30_000,
  );

  it('neutralizes a bidi override byte echoed into an unconfirmable-aim abort refusal (echoRunId)', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'ape-prose-bound-echo-'));
    cleanups.push(dir);
    const maliciousRunId = `run-${RLO}-ghost`;
    const result = await abortRun(dir, 'operator requested cleanup', maliciousRunId);
    expect(result.ok).toBe(false);
    expect(result.reason).not.toContain(RLO);
    expect(result.reason).toContain('no active run');
    expect(result.reason).toContain('ghost');
  });
});
