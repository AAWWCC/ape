import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { recordReceipt, startRun, statusRun } from '../lib/runtime/service.js';
import { RISK_TRIGGERS } from '../lib/runtime/constants.js';
import { runtimePaths } from '../lib/runtime/paths.js';
import { atomicWriteJson } from '../lib/runtime/storage.js';

// Risk-trigger token hygiene (T9 loud-reject precedent, #251).
//
// The public contract under test, derived from the objective:
//   1. startRun must reject an unrecognized risk_triggers token LOUDLY at
//      admission — throw an error that names the unknown token(s) and the
//      canonical RISK_TRIGGERS list — instead of letting lane-policy.js filter
//      it out silently. Canonical tokens are recognized case-insensitively.
//   2. On the receipt merge path, an unknown token arriving via
//      receipt.evidence.risk_triggers must be SURFACED (returned warnings or an
//      audit/scope event) rather than dropped silently, and must NOT hard-fail
//      the run.
//
// Everything runs through the public service surface (startRun / recordReceipt);
// no production files are touched.

const cleanups = [];
afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

function git(cwd, ...args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

// CJS on purpose: the scratch project has no package.json, so .js files run as
// CommonJS under the configured `node tests/value.test.js` targeted command
// (the red-test observation and the targeted merge gate execute it).
const VALUE_V1 = 'module.exports = { value: 1 };\n';
const VALUE_V2 = 'module.exports = { value: 2 };\n';
const AUTHORED_TEST =
  "const { value } = require('../src/value.js');\n" +
  "if (value !== 2) { throw new Error('red: value is ' + value); }\n";

async function project(config = {}) {
  const dir = await mkdtemp(path.join(tmpdir(), 'ape-risk-trigger-admission-'));
  cleanups.push(dir);
  await mkdir(path.join(dir, 'src'));
  await mkdir(path.join(dir, 'tests'));
  await mkdir(path.join(dir, 'docs'));
  await writeFile(path.join(dir, 'src', 'value.js'), VALUE_V1);
  await writeFile(path.join(dir, 'tests', 'value.test.js'), 'throw new Error("placeholder");\n');
  await writeFile(path.join(dir, 'docs', 'notes.md'), '# Notes\n');
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
    objective: 'Exercise risk-trigger token hygiene at admission',
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

// Drive a clean fast-lane run to its review stage: authored red test, green
// build. The review receipt is where a late risk trigger arrives via
// receipt.evidence.risk_triggers.
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
  expect(buildTicket.role).toBe('implementer');
  await writeFile(path.join(dir, 'src', 'value.js'), VALUE_V2);
  const built = await recordReceipt(dir, receipt(buildTicket, { tests: greenTest }));
  expect(built.ok).toBe(true);
  const reviewTicket = built.run.tickets.at(-1);
  expect(reviewTicket.stage_id).toBe('review');
  return { reviewTicket };
}

async function auditRaw(dir) {
  return readFile(runtimePaths(dir).overrideLog, 'utf8').catch(() => '');
}

describe('startRun rejects unrecognized risk_triggers loudly at admission (T9, #251)', () => {
  it('rejects an unknown risk_trigger token, naming the token and the canonical list, before any run or branch exists', async () => {
    const dir = await project();
    const branchBefore = git(dir, 'rev-parse', '--abbrev-ref', 'HEAD');

    const error = await startRun(dir, startInput({ risk_triggers: ['frobnicate'] }))
      .then(() => null, (thrown) => thrown);
    expect(error).toBeInstanceOf(Error);
    // Names the offending token so the caller can see exactly what was rejected.
    expect(error.message.toLowerCase()).toContain('frobnicate');
    // Names the canonical list so the caller can correct it: every recognized
    // token appears in the message.
    for (const canonical of RISK_TRIGGERS) {
      expect(error.message).toContain(canonical);
    }

    // Rejected at admission: no active run, no branch switch, no ape/* branch.
    expect((await statusRun(dir)).active).toBe(false);
    expect(git(dir, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe(branchBefore);
    expect(git(dir, 'branch', '--list', 'ape/*')).toBe('');
  });

  it('names every unrecognized token when several are unknown', async () => {
    const dir = await project();
    const error = await startRun(dir, startInput({ risk_triggers: ['frobnicate', 'wibble'] }))
      .then(() => null, (thrown) => thrown);
    expect(error).toBeInstanceOf(Error);
    expect(error.message.toLowerCase()).toContain('frobnicate');
    expect(error.message.toLowerCase()).toContain('wibble');
    expect((await statusRun(dir)).active).toBe(false);
  });

  it('rejects when an unknown token rides alongside a canonical one, naming only the unknown', async () => {
    const dir = await project();
    // 'security' is canonical (escalates to full); 'frobnicate' is not. Without
    // the admission guard this start would succeed (full lane has test_paths).
    const error = await startRun(dir, startInput({ risk_triggers: ['security', 'frobnicate'] }))
      .then(() => null, (thrown) => thrown);
    expect(error).toBeInstanceOf(Error);
    expect(error.message.toLowerCase()).toContain('frobnicate');
    expect((await statusRun(dir)).active).toBe(false);
    expect(git(dir, 'branch', '--list', 'ape/*')).toBe('');
  });

  it('accepts canonical tokens case-insensitively and normalizes them to canonical form', async () => {
    const dir = await project();
    const started = await startRun(dir, startInput({ risk_triggers: ['SECURITY', 'Migration'] }));
    expect(started.ok).toBe(true);
    expect(started.run.high_risk).toBe(true);
    // Normalized to the canonical lowercase form, never persisted verbatim.
    expect(started.run.risk_triggers).toContain('security');
    expect(started.run.risk_triggers).toContain('migration');
    expect(started.run.risk_triggers).not.toContain('SECURITY');
    expect(started.run.risk_triggers).not.toContain('Migration');
  });
});

describe('reviewer receipt surfaces unknown risk_triggers without hard-failing (T9, #251)', () => {
  it('surfaces an unknown token from receipt.evidence.risk_triggers instead of dropping it silently, and never hard-fails the run', async () => {
    const dir = await project();
    const { reviewTicket } = await walkToReview(dir);
    const UNKNOWN = 'nonexistent-risk-token';

    const reviewed = await recordReceipt(dir, receipt(reviewTicket, {
      tests: greenTest,
      evidence: { verdict: 'pass', risk_triggers: [UNKNOWN] },
    }));

    // An unknown token on a receipt must NOT hard-fail the run.
    expect(reviewed.ok).toBe(true);

    // ...and it must be surfaced loudly on BOTH channels independently, not just
    // one: the implementation emits the token as a returned warning AND an
    // overrides.ndjson audit line, so a regression that drops either channel must
    // fail. The passive receipt echo (reviewed.receipt / reviewed.run.receipts)
    // does not count — the runtime must emit its own signal, so only dedicated
    // warning fields and the audit log are inspected here.
    const inWarnings = [reviewed.warnings, reviewed.run?.warnings]
      .some((warning) => JSON.stringify(warning ?? null).includes(UNKNOWN));
    const inAudit = (await auditRaw(dir)).includes(UNKNOWN);
    expect(inWarnings).toBe(true);
    expect(inAudit).toBe(true);

    // An unrecognized token is not a real risk trigger: surfacing it must not
    // silently arm high_risk or leak it into the persisted canonical set.
    expect(reviewed.run.high_risk).toBe(false);
    expect(reviewed.run.risk_triggers).not.toContain(UNKNOWN);
  }, 30_000);
});
