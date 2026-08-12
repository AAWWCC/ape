import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { currentTreeSha } from '../lib/runtime/git.js';
import { withinTestScope } from '../lib/runtime/path-scope.js';
import { validateStageReceipt } from '../lib/runtime/receipt-validator.js';
import { finalizeReceipt, finalizeTicket } from '../lib/runtime/schemas.js';
import { SCHEMA_VERSION } from '../lib/runtime/constants.js';

// Directory-shaped test claims must not widen to their parent (roadmap
// test-scope-directory-widening-fix, audit finding 1.5, invariant 3).
// withinTestScope's comment scopes parent-directory widening to file-shaped
// claims ('a file-shaped claim (tests/value.test.js) authorizes authoring
// siblings'), but the code applies path.posix.dirname to EVERY claim. With
// test_paths: ['tests/unit'], a write to tests/integration/x.test.js passes
// withinTestScope via the parent 'tests' widening even though it is outside
// the claimed directory — and withinTestScope is the sole test-writer scope
// predicate at receipt admission, where it suppresses the 'unclaimed write'
// error. Contract under test: parent-directory widening is gated on the same
// file-shaped pattern widenedTestClaims uses (/\.(test|spec)\.[^.]+$/i) — a
// directory-shaped claim authorizes only paths within that directory, while a
// file-shaped claim keeps authorizing siblings in its suite directory.

const cleanups = [];
afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('withinTestScope (public contract)', () => {
  it('rejects a sibling directory of a directory-shaped claim: no parent widening', () => {
    // RED today: dirname('tests/unit') === 'tests' widens the claim, so the
    // sibling-suite write passes the predicate.
    expect(withinTestScope('tests/integration/x.test.js', ['tests/unit'])).toBe(false);
  });

  it('rejects a test file placed directly in the parent of a directory-shaped claim', () => {
    // RED today via the same widening: 'tests/x.test.js' startsWith 'tests/'.
    expect(withinTestScope('tests/x.test.js', ['tests/unit'])).toBe(false);
  });

  it('still authorizes paths inside the directory-shaped claim itself', () => {
    expect(withinTestScope('tests/unit/x.test.js', ['tests/unit'])).toBe(true);
  });

  it('keeps sibling widening for a file-shaped claim', () => {
    expect(withinTestScope('tests/extra.test.js', ['tests/value.test.js'])).toBe(true);
  });
});

function git(cwd, ...args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

// Temp project with a committed tests/unit suite as the baseline. The
// admission cases then write the file under test uncommitted, exactly as a
// test writer's tree looks when its receipt is validated.
async function project() {
  const dir = await mkdtemp(path.join(tmpdir(), 'ape-dir-widening-'));
  cleanups.push(dir);
  await mkdir(path.join(dir, 'tests', 'unit'), { recursive: true });
  await writeFile(path.join(dir, 'tests', 'unit', 'value.test.js'), 'process.exit(0);\n');
  git(dir, 'init', '-q');
  git(dir, 'config', 'user.email', 'ape@example.test');
  git(dir, 'config', 'user.name', 'APE Test');
  git(dir, 'add', '.');
  git(dir, 'commit', '-qm', 'baseline');
  return dir;
}

function testWriterTicket(baseTreeSha, testPaths) {
  return finalizeTicket({
    schema_version: SCHEMA_VERSION,
    ticket_id: 'run-1:test:ticket-1',
    run_id: 'run-1',
    stage_id: 'test',
    parallel_group: null,
    role: 'test_writer',
    objective: 'Author the behavioral tests',
    claimed_paths: [...testPaths],
    test_paths: [...testPaths],
    model_tier: 'balanced',
    model: { model: 'fable' },
    deadline_at: new Date(Date.now() + 60_000).toISOString(),
    output_schema: {},
    required_checks: [],
    parent_hash: null,
    base_tree_sha: baseTreeSha,
    attempt: 1,
    writable: true,
    issued_at: new Date().toISOString(),
  });
}

function receiptFor(ticket, headTreeSha, changedFiles) {
  const completedAt = new Date().toISOString();
  return finalizeReceipt({
    schema_version: SCHEMA_VERSION,
    receipt_id: 'receipt-1',
    run_id: ticket.run_id,
    ticket_id: ticket.ticket_id,
    ticket_hash: ticket.ticket_hash,
    agent: { host: 'claude', role: 'test_writer', identity: 'agent-test-writer', model: 'fable' },
    status: 'passed',
    base_tree_sha: ticket.base_tree_sha,
    head_tree_sha: headTreeSha,
    changed_files: changedFiles,
    tests: [],
    findings: [],
    evidence: { verdict: 'pass' },
    timing: {
      started_at: ticket.issued_at,
      completed_at: completedAt,
      duration_ms: Math.max(0, Date.parse(completedAt) - Date.parse(ticket.issued_at)),
    },
    previous_receipt_hash: null,
  });
}

async function admit(dir, ticket, changedFiles) {
  const head = await currentTreeSha(dir);
  const receipt = receiptFor(ticket, head, changedFiles);
  return validateStageReceipt({
    project_dir: dir,
    state: { run_id: 'run-1', receipts: [] },
    ticket,
    receipt,
  });
}

describe('receipt admission: test-writer scope for directory-shaped claims', () => {
  it('rejects a write into a sibling directory of a directory-shaped test claim as an unclaimed write', async () => {
    // RED today: the parent widening of 'tests/unit' to 'tests' makes
    // withinTestScope suppress the unclaimed-write error, so the independent
    // receipt recompute accepts confinement looser than declared.
    const dir = await project();
    const base = await currentTreeSha(dir);
    const ticket = testWriterTicket(base, ['tests/unit']);

    await mkdir(path.join(dir, 'tests', 'integration'), { recursive: true });
    await writeFile(path.join(dir, 'tests', 'integration', 'x.test.js'), 'process.exit(0);\n');

    const result = await admit(dir, ticket, ['tests/integration/x.test.js']);
    expect(result.valid).toBe(false);
    expect(result.errors).toContain('unclaimed write: tests/integration/x.test.js');
  });

  it('still admits a write inside the claimed directory', async () => {
    const dir = await project();
    const base = await currentTreeSha(dir);
    const ticket = testWriterTicket(base, ['tests/unit']);

    await writeFile(path.join(dir, 'tests', 'unit', 'extra.test.js'), 'process.exit(0);\n');

    const result = await admit(dir, ticket, ['tests/unit/extra.test.js']);
    expect(result.valid).toBe(true);
    expect(result.errors).toEqual([]);
  });

  it('still admits sibling authoring next to a file-shaped test claim', async () => {
    // Regression guard on the unchanged half of the contract: the ticket
    // claims only tests/unit/value.test.js, so the sibling extra.test.js is
    // outside claimed_paths and its admission rests entirely on the
    // file-shaped widening inside withinTestScope.
    const dir = await project();
    const base = await currentTreeSha(dir);
    const ticket = testWriterTicket(base, ['tests/unit/value.test.js']);

    await writeFile(path.join(dir, 'tests', 'unit', 'extra.test.js'), 'process.exit(0);\n');

    const result = await admit(dir, ticket, ['tests/unit/extra.test.js']);
    expect(result.valid).toBe(true);
    expect(result.errors).toEqual([]);
  });
});
