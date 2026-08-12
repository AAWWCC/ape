import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { nextStages } from '../lib/runtime/pipeline.js';
import { recordReceipt, startRun } from '../lib/runtime/service.js';
import { runtimePaths } from '../lib/runtime/paths.js';
import { atomicWriteJson } from '../lib/runtime/storage.js';

// Audit finding 1.6 (fast-lane-review-check-contract): the fast-lane review
// stage carries required_checks ['targeted-tests'] (pipeline.js), and receipt
// validation refuses a passed receipt on such a ticket unless tests[] holds a
// passed, exit-0 entry (receipt-validator.js). Because the review convention
// returns even a blocking verdict as status 'passed' with evidence.verdict
// 'fail', EVERY fast-lane review receipt needs that evidence — yet nothing
// tells the reviewer: prompts/reviewer.md says only "run targeted checks when
// useful" and issuance appends a notice for red-test stages alone. A reviewer
// that follows the prompt literally has its receipt rejected, and a retry
// repeating the prompt-sanctioned behavior fails identically. The full-lane
// review stage after build carries no required checks, so the trap is
// fast-lane-only.
//
// Ticket objectives are now immutable run intent. The machine-readable
// StageTicket fields carry this contract: required_checks names targeted-tests,
// output_schema requires receipt test evidence, and receipt validation rejects
// a passed receipt that omits the required passing test entry.

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

const RUN_OBJECTIVE = 'Reconcile the fast-lane review evidence contract';

async function project() {
  const dir = await mkdtemp(path.join(tmpdir(), 'ape-fast-review-contract-'));
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

// Drive a fast-lane run through the public surface to its pending review
// ticket: authored red observed by the runtime, green build turns the tree,
// the code-review group opens.
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
  expect(reviewTicket.role).toBe('reviewer');
  return { reviewTicket };
}

describe('fast-lane review targeted-tests contract (audit 1.6)', () => {
  it('the issued review ticket carries and enforces the targeted-tests evidence demand structurally', async () => {
    const dir = await project();
    const { reviewTicket } = await walkToReview(dir);

    expect(reviewTicket.objective).toBe(RUN_OBJECTIVE);
    expect(reviewTicket.required_checks).toEqual(['targeted-tests']);
    expect(reviewTicket.output_schema.required).toContain('tests');
    expect(reviewTicket.output_schema.properties.tests).toBeTruthy();

    const rejected = await recordReceipt(dir, receipt(reviewTicket));
    expect(rejected).toMatchObject({ ok: false, rejected: true });
    expect(rejected.errors.join(' ')).toMatch(/targeted-tests|passed test evidence/i);
  }, 30_000);

  it('keeps the operator objective verbatim instead of appending transport explanations', async () => {
    const dir = await project();
    const { reviewTicket } = await walkToReview(dir);

    expect(reviewTicket.objective).toBe(RUN_OBJECTIVE);
    expect(reviewTicket.objective).not.toContain('Run objective:');
  }, 30_000);
});

describe('review-stage scheduling parity around the resolution', () => {
  // Green on both trees: the resolution reconciles the fast lane — it must
  // never export the trap to the full lane, whose post-build review stage
  // carries no targeted-tests requirement.
  it('the full-lane review stage after build never requires targeted-tests', () => {
    const [review] = nextStages(
      { mode: 'phase', lane: 'full', high_risk: false, remediation_cycles: 0 },
      'build',
      {},
    );
    expect(review.id).toBe('review');
    expect(review.required_checks).not.toContain('targeted-tests');
  });

  // Green on both trees: neither arm may remove the fast-lane review stage
  // itself — dropping the CHECK is sanctioned, dropping the REVIEW is not.
  it('the fast lane still schedules the code-review stage after build', () => {
    const stages = nextStages({ mode: 'phase', lane: 'fast', remediation_cycles: 0 }, 'build', {});
    expect(stages.map((stage) => stage.id)).toEqual(['review']);
    expect(stages[0].role).toBe('reviewer');
    expect(stages[0].parallel_group).toBe('code-review');
  });
});
