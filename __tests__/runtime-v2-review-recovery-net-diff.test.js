import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { runtimePaths } from '../lib/runtime/paths.js';
import { recordReceipt, startRun } from '../lib/runtime/service.js';
import { atomicWriteJson, readJson } from '../lib/runtime/storage.js';

const cleanups = [];
const baseline = 'module.exports = { value: 1 };\n';
const repaired = 'module.exports = { value: 2 };\n';
const checkCommand = 'node --check src/value.js';

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

function git(dir, ...args) {
  return execFileSync('git', args, { cwd: dir, encoding: 'utf8' }).trim();
}

function finding(id, file = 'src/value.js') {
  return { id, file, line: 1, title: `Unresolved ${id}`, detail: `The scoped ${id} issue remains`,
    blocking: true, remediation: { owner: 'production' } };
}

function receipt(ticket, overrides = {}) {
  return { ticket_id: ticket.ticket_id, status: 'passed',
    agent_identity: `test-agent-${ticket.ticket_id}`, tests: [], findings: [],
    evidence: { summary: 'Completed the scoped fixture work', verdict: 'pass' },
    timing: { started_at: ticket.issued_at, duration_ms: 1 }, ...overrides };
}

function runCheck(dir) {
  const started = Date.now();
  execFileSync(process.execPath, ['--check', 'src/value.js'], { cwd: dir });
  return [{ command: checkCommand, passed: true, exit_code: 0, duration_ms: Date.now() - started }];
}

async function record(dir, ticket, overrides = {}) {
  const result = await recordReceipt(dir, receipt(ticket, overrides));
  expect(result.ok, JSON.stringify(result.errors ?? result)).toBe(true);
  return result;
}

async function fixture() {
  const dir = await mkdtemp(path.join(tmpdir(), 'ape-review-net-diff-'));
  cleanups.push(dir);
  await mkdir(path.join(dir, 'src'));
  await writeFile(path.join(dir, 'src/value.js'), baseline);
  await writeFile(path.join(dir, 'src/other.js'), 'module.exports = { other: 1 };\n');
  git(dir, 'init', '-q');
  git(dir, 'config', 'user.email', 'ape@example.test');
  git(dir, 'config', 'user.name', 'APE Test');
  git(dir, 'add', '.');
  git(dir, 'commit', '-qm', 'fixture baseline');
  const paths = runtimePaths(dir);
  await atomicWriteJson(paths.config, {
    shipping: { auto_merge: false, provider: 'github', required_remote_checks: false },
    test_commands: { full: checkCommand, targeted: checkCommand },
  });
  // Use ordinary host-neutral service admission, as the structured-remediation
  // integration suite does. No run/ticket hashes or tree evidence are forged.
  const started = await startRun(dir, {
    objective: 'Adjust production comments in the value module', mode: 'phase', lane: 'fast', host: 'codex',
    claimed_paths: ['src/value.js', 'src/other.js'], test_paths: [], requirements: [], risk_triggers: [],
    behavioral: false, hooks_trusted: true, subagents_available: true, explicit_invocation: true,
  });
  expect(started.ok, JSON.stringify(started)).toBe(true);
  expect(started.run.execution_policy.version).toBe(4);
  expect(started.run.tickets.at(-1).stage_id).toBe('build');
  const built = await record(dir, started.run.tickets.at(-1), { tests: runCheck(dir) });
  const firstReview = built.run.tickets.at(-1);
  expect(firstReview.stage_id).toBe('review');
  const disputed = await record(dir, firstReview, {
    findings: [finding('A'), finding('B', 'src/other.js')], evidence: { verdict: 'fail' },
  });
  expect(disputed.run.tickets.at(-1).stage_id).toBe('remediation-build');
  expect(disputed.run.remediation_cycles).toBe(1);
  return { dir, paths, disputed,
    reviewedTree: disputed.run.receipts.find((entry) => entry.ticket_id === firstReview.ticket_id).head_tree_sha };
}

async function attemptAndRetry(value, { revert, unrelated = false }) {
  const firstWriter = value.disputed.run.tickets.at(-1);
  await writeFile(path.join(value.dir, 'src/value.js'), repaired);
  const failed = await record(value.dir, firstWriter, {
    status: 'failed', findings: [finding('attempt-incomplete')],
    evidence: { summary: 'A real scoped edit remains, but this attempt did not finish' },
  });
  const firstReceipt = failed.run.receipts.find((entry) => entry.ticket_id === firstWriter.ticket_id);
  expect(firstReceipt.changed_files).toContain('src/value.js');
  expect(firstReceipt.head_tree_sha).not.toBe(firstReceipt.base_tree_sha);
  const retry = failed.run.tickets.at(-1);
  expect(retry.stage_id).toBe('remediation-build');
  expect(retry.ticket_id).not.toBe(firstWriter.ticket_id);
  expect(retry.base_tree_sha).toBe(firstReceipt.head_tree_sha);
  if (revert) await writeFile(path.join(value.dir, 'src/value.js'), baseline);
  if (unrelated) await writeFile(path.join(value.dir, 'src/other.js'), 'module.exports = { other: 2 };\n');
  const built = await record(value.dir, retry, { tests: runCheck(value.dir) });
  const review = built.run.tickets.at(-1);
  expect(review.stage_id).toBe('remediation-review');
  // A fresh service entry reads persisted receipts and the episode boundary.
  const persisted = await readJson(value.paths.active);
  expect(persisted.review_recovery_receipt_boundary).toBe(value.disputed.run.review_recovery_receipt_boundary);
  return { built, review };
}

describe('v4 review recovery uses the retained Git diff of its current episode', () => {
  it.each([
    ['an identical reviewed tree', false],
    ['a reverted blocker file with an unrelated retained edit', true],
  ])('stalls on %s despite temporary validated writer changes', async (_name, unrelated) => {
    const value = await fixture();
    const { built, review } = await attemptAndRetry(value, { revert: true, unrelated });
    expect(await readFile(path.join(value.dir, 'src/value.js'), 'utf8')).toBe(baseline);
    const currentTree = built.run.receipts.at(-1).head_tree_sha;
    expect(git(value.dir, 'diff', '--name-only', value.reviewedTree, currentTree))
      .toBe(unrelated ? 'src/other.js' : '');
    if (!unrelated) expect(currentTree).toBe(value.reviewedTree);
    const judged = await record(value.dir, review, {
      findings: [finding('renamed-A'), finding('B', 'src/other.js')],
      evidence: { verdict: 'fail', review_recovery_diff: {
        base_tree_sha: value.reviewedTree, head_tree_sha: currentTree, changed_files: ['src/value.js'],
      } },
    });
    // Worker-authored evidence cannot replace the service's authoritative diff.
    expect(judged.run.status).toBe('blocked');
    expect(judged.run.terminal_reason_code).toBe('recovery_stalled');
    expect(judged.run.blocked_recovery.reason_code).toBe('stalled_progress');
    expect(judged.run.remediation_cycles).toBe(1);
    expect(judged.run.tickets).toHaveLength(built.run.tickets.length);
    expect((judged.actions ?? []).some((entry) => entry.type === 'dispatch_agent')).toBe(false);
  });

  it('credits a genuinely retained related edit from a failed attempt when the retry completes', async () => {
    const value = await fixture();
    const { built, review } = await attemptAndRetry(value, { revert: false });
    const currentTree = built.run.receipts.at(-1).head_tree_sha;
    expect(git(value.dir, 'diff', '--name-only', value.reviewedTree, currentTree)).toBe('src/value.js');
    expect(built.run.receipts.at(-1).changed_files).toEqual([]);
    const judged = await record(value.dir, review, {
      findings: [finding('C'), finding('B', 'src/other.js')], evidence: { verdict: 'fail' },
    });
    expect(judged.run.status).toBe('running');
    expect(judged.run.remediation_cycles).toBe(2);
    expect(judged.run.tickets.at(-1).stage_id).toBe('remediation-build');
    expect(judged.run.tickets).toHaveLength(built.run.tickets.length + 1);
    expect(judged.run.recovery_progress.review.at(-1).artifact).toBe(currentTree);
  });
});

const testPath = 'tests/value.test.js';
const contradictoryTest = `const { value } = require('../src/value.js');
if (value !== 2) throw new Error('value must equal 2');
if (value !== 3) throw new Error('value must also equal 3');
const { other } = require('../src/other.js');
if (other !== 2) throw new Error('other must equal 2');
if (other !== 3) throw new Error('other must also equal 3');
`;
const correctedTest = contradictoryTest.replace("if (value !== 3) throw new Error('value must also equal 3');\n", '');

function testFinding(id) {
  return { ...finding(id, testPath), remediation: { owner: 'test', test_paths: [testPath] } };
}

function contradiction(id, overrides = {}) {
  return { status: 'failed', findings: [testFinding(id)], evidence: {
    failure_kind: 'test-contradiction', test_contradiction: {
      summary: `The authored test has incompatible expectations for ${id}`, test_paths: [testPath],
    }, ...overrides,
  } };
}

async function contradictionFixture() {
  const dir = await mkdtemp(path.join(tmpdir(), 'ape-contradiction-net-diff-'));
  cleanups.push(dir);
  await mkdir(path.join(dir, 'src'));
  await mkdir(path.join(dir, 'tests'));
  await writeFile(path.join(dir, 'src/value.js'), baseline);
  await writeFile(path.join(dir, 'src/other.js'), 'module.exports = { other: 1 };\n');
  await writeFile(path.join(dir, testPath), 'throw new Error("placeholder");\n');
  git(dir, 'init', '-q');
  git(dir, 'config', 'user.email', 'ape@example.test');
  git(dir, 'config', 'user.name', 'APE Test');
  git(dir, 'add', '.');
  git(dir, 'commit', '-qm', 'fixture baseline');
  const paths = runtimePaths(dir);
  await atomicWriteJson(paths.config, {
    shipping: { auto_merge: false, provider: 'github', required_remote_checks: false },
    test_commands: { full: `node ${testPath}`, targeted: `node ${testPath}` },
  });
  const started = await startRun(dir, {
    objective: 'Set the value and other exports to 2', mode: 'phase', lane: 'auto', host: 'codex',
    claimed_paths: ['src/value.js', 'src/other.js'], test_paths: [testPath], requirements: [], risk_triggers: [],
    behavioral: true, hooks_trusted: true, subagents_available: true, explicit_invocation: true,
  });
  expect(started.ok, JSON.stringify(started)).toBe(true);
  expect(started.run.execution_policy.version).toBe(4);
  const author = started.run.tickets.at(-1);
  expect(author.role).toBe('test_writer');
  await writeFile(path.join(dir, testPath), contradictoryTest);
  // The service observes the real RED command before it admits authored tests.
  const authored = await record(dir, author);
  const source = authored.run.tickets.at(-1);
  expect(source.stage_id).toBe('build');
  const reported = await record(dir, source, contradiction('A'));
  const reconciler = reported.run.tickets.at(-1);
  expect(reconciler.stage_id).toBe('test-reconcile');
  const confirmed = await record(dir, reconciler, {
    findings: [testFinding('A')], evidence: { verdict: 'fail' },
  });
  const correction = confirmed.run.tickets.at(-1);
  expect(correction.stage_id).toBe('test-recheck');
  expect(correction.test_scope).toBe('exact');
  expect(correction.claimed_paths).toEqual([testPath]);
  expect(correction.test_reconciliation.source_ticket_id).toBe(source.ticket_id);
  return { dir, paths, source, confirmed, correction,
    previousTree: reported.run.receipts.find((entry) => entry.ticket_id === source.ticket_id).head_tree_sha };
}

describe('v4 contradiction recovery uses the retained Git diff of its current episode', () => {
  it.each([
    ['a retained exact-scope test repair', false, false],
    ['a reverted repair and identical tree', true, false],
    ['a reverted repair with an unrelated retained production edit', true, true],
  ])('evaluates %s through real service event evidence', async (_name, revert, unrelated) => {
    const value = await contradictionFixture();
    await writeFile(path.join(value.dir, testPath), correctedTest);
    let correction = value.correction;
    if (revert) {
      const attempted = await record(value.dir, correction, {
        status: 'failed', findings: [testFinding('unfinished-check')],
        evidence: { summary: 'The first contradiction was edited, but the writer did not finish' },
      });
      expect(attempted.run.receipts.at(-1).changed_files).toEqual([testPath]);
      correction = attempted.run.tickets.at(-1);
      expect(correction.stage_id).toBe('test-recheck');
      expect(correction.test_reconciliation.source_ticket_id).toBe(value.source.ticket_id);
      await writeFile(path.join(value.dir, testPath), contradictoryTest);
    }
    const corrected = await record(value.dir, correction);
    const sourceRetry = corrected.run.tickets.at(-1);
    expect(sourceRetry.stage_id).toBe('build');
    expect(corrected.run.test_contradiction_resolution).toMatchObject({
      verdict: 'test-corrected', receipt_id: corrected.run.receipts.at(-1).receipt_id,
    });
    const persisted = await readJson(value.paths.active);
    expect(persisted.test_contradiction_recovery_receipt_boundary).toBe(value.source.ticket_id);
    if (unrelated) await writeFile(path.join(value.dir, 'src/other.js'), 'module.exports = { other: 2 };\n');
    const next = await record(value.dir, sourceRetry, contradiction(revert ? 'renamed-A' : 'B', {
      // A worker cannot supply the runtime-only retained-diff event.
      test_contradiction_recovery_diff: {
        base_tree_sha: value.previousTree, head_tree_sha: sourceRetry.base_tree_sha, changed_files: [testPath],
      },
    }));
    const currentTree = next.run.receipts.at(-1).head_tree_sha;
    expect(git(value.dir, 'diff', '--name-only', value.previousTree, currentTree))
      .toBe(revert ? unrelated ? 'src/other.js' : '' : testPath);
    if (revert) {
      expect(next.run.status).toBe('blocked');
      expect(next.run.terminal_reason_code).toBe('recovery_stalled');
      expect(next.run.blocked_recovery.reason_code).toBe('stalled_progress');
      expect(next.run.test_contradiction_reconciliations).toBe(1);
      expect(next.run.tickets).toHaveLength(corrected.run.tickets.length);
      expect((next.actions ?? []).some((entry) => entry.type === 'dispatch_agent')).toBe(false);
    } else {
      expect(next.run.status).toBe('running');
      expect(next.run.test_contradiction_reconciliations).toBe(2);
      expect(next.run.tickets.at(-1).stage_id).toBe('test-reconcile');
      expect(next.run.tickets).toHaveLength(corrected.run.tickets.length + 1);
      expect(next.run.recovery_progress['test-contradiction'].at(-1).artifact).toBe(currentTree);
    }
  });
});
