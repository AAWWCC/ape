import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { currentTreeSha, treeShaSession } from '../lib/runtime/git.js';
import { validateStageReceipt } from '../lib/runtime/receipt-validator.js';
import { finalizeReceipt, finalizeTicket } from '../lib/runtime/schemas.js';
import { SCHEMA_VERSION } from '../lib/runtime/constants.js';

const cleanups = [];
afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

function git(cwd, ...args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

async function project() {
  const dir = await mkdtemp(path.join(tmpdir(), 'ape-tree-memo-'));
  cleanups.push(dir);
  await mkdir(path.join(dir, 'src'));
  await writeFile(path.join(dir, 'src', 'value.js'), 'export const value = 1;\n');
  git(dir, 'init', '-q');
  git(dir, 'config', 'user.email', 'ape@example.test');
  git(dir, 'config', 'user.name', 'APE Test');
  git(dir, 'add', '.');
  git(dir, 'commit', '-qm', 'test: baseline');
  return dir;
}

function ticketFor(baseTreeSha) {
  const issuedAt = new Date(Date.now() - 60_000).toISOString();
  return finalizeTicket({
    schema_version: SCHEMA_VERSION,
    ticket_id: 'run-1:build:ticket-1',
    run_id: 'run-1',
    stage_id: 'build',
    parallel_group: null,
    role: 'implementer',
    objective: 'Change the value',
    claimed_paths: ['src/value.js'],
    test_paths: [],
    model_tier: 'balanced',
    model: { model: 'opus' },
    deadline_at: new Date(Date.now() + 60_000).toISOString(),
    output_schema: {},
    required_checks: [],
    parent_hash: null,
    base_tree_sha: baseTreeSha,
    attempt: 1,
    writable: true,
    issued_at: issuedAt,
  });
}

function receiptFor(ticket, headTreeSha, changedFiles = ['src/value.js']) {
  const completedAt = new Date().toISOString();
  return finalizeReceipt({
    schema_version: SCHEMA_VERSION,
    receipt_id: 'receipt-1',
    run_id: ticket.run_id,
    ticket_id: ticket.ticket_id,
    ticket_hash: ticket.ticket_hash,
    agent: { host: 'claude', role: 'implementer', identity: 'agent-implementer', model: 'opus' },
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

describe('treeShaSession', () => {
  it('computes once per section, recomputes only after invalidate, and never seeds from claims', async () => {
    let computes = 0;
    const session = treeShaSession('/nowhere', async () => {
      computes += 1;
      return `sha-${computes}`;
    });
    // The FIRST read is always a real compute — a session starts empty by
    // construction, so a caller can never observe a value the runtime did
    // not itself derive from the tree.
    await expect(session.current()).resolves.toBe('sha-1');
    await expect(session.current()).resolves.toBe('sha-1');
    await expect(session.current()).resolves.toBe('sha-1');
    expect(computes).toBe(1);
    session.invalidate();
    await expect(session.current()).resolves.toBe('sha-2');
    await expect(session.current()).resolves.toBe('sha-2');
    expect(computes).toBe(2);
  });

  it('does not memoize a failed read: the next current() retries', async () => {
    let computes = 0;
    const session = treeShaSession('/nowhere', async () => {
      computes += 1;
      if (computes === 1) throw new Error('transient git fault');
      return 'sha-ok';
    });
    await expect(session.current()).rejects.toThrow('transient git fault');
    await expect(session.current()).resolves.toBe('sha-ok');
    expect(computes).toBe(2);
  });

  it('tracks the real tree across invalidation in a live repo', async () => {
    const dir = await project();
    const session = treeShaSession(dir);
    const first = await session.current();
    expect(first).toBe(await currentTreeSha(dir));
    await writeFile(path.join(dir, 'src', 'value.js'), 'export const value = 2;\n');
    // Without invalidation the memo intentionally survives (that is the
    // whole point inside a locked section)…
    expect(await session.current()).toBe(first);
    // …and invalidation makes the next read observe the mutation.
    session.invalidate();
    const second = await session.current();
    expect(second).not.toBe(first);
    expect(second).toBe(await currentTreeSha(dir));
  });

  it('memoizes diffs per (base, head) pair — tree objects are immutable', async () => {
    const dir = await project();
    const session = treeShaSession(dir);
    const base = await session.current();
    await writeFile(path.join(dir, 'src', 'value.js'), 'export const value = 2;\n');
    session.invalidate();
    const head = await session.current();
    // Same pair twice returns the memoized promise itself, and its value is
    // the real diff.
    const first = session.diff(base, head);
    expect(session.diff(base, head)).toBe(first);
    await expect(first).resolves.toEqual(['src/value.js']);
    // A different pair is its own entry.
    expect(session.diff(head, base)).not.toBe(first);
    await expect(session.diff(head, base)).resolves.toEqual(['src/value.js']);
  });
});

describe('receipt validation under a shared tree session', () => {
  it('still rejects a receipt whose head tree diverges from the live tree', async () => {
    const dir = await project();
    const base = await currentTreeSha(dir);
    const ticket = ticketFor(base);
    await writeFile(path.join(dir, 'src', 'value.js'), 'export const value = 2;\n');
    const head = await currentTreeSha(dir);
    const receipt = receiptFor(ticket, head);
    // The tree moves on AFTER the receipt was built (an external writer, or a
    // crash-replayed prepared transaction against a changed tree). The
    // session's first read is the LIVE tree — never the receipt's claim — so
    // the independent recompute must still catch the divergence.
    await writeFile(path.join(dir, 'src', 'value.js'), 'export const value = 3;\n');
    const result = await validateStageReceipt({
      project_dir: dir,
      state: { run_id: 'run-1', receipts: [] },
      ticket,
      receipt,
      tree: treeShaSession(dir),
    });
    expect(result.valid).toBe(false);
    expect(result.errors.join(' ')).toMatch(/receipt head tree does not match the current tree/);
  });

  it('admits a truthful receipt with a session and returns the observed tree', async () => {
    const dir = await project();
    const base = await currentTreeSha(dir);
    const ticket = ticketFor(base);
    await writeFile(path.join(dir, 'src', 'value.js'), 'export const value = 2;\n');
    const head = await currentTreeSha(dir);
    const receipt = receiptFor(ticket, head);
    const session = treeShaSession(dir);
    const result = await validateStageReceipt({
      project_dir: dir,
      state: { run_id: 'run-1', receipts: [] },
      ticket,
      receipt,
      tree: session,
    });
    expect(result.valid).toBe(true);
    expect(result.errors).toEqual([]);
    // The validation tree is the session's runtime-observed read.
    expect(result.tree_sha).toBe(head);
    expect(result.actual_files).toEqual(['src/value.js']);
  });

  it('rejects a changed_files claim that does not match the recomputed (memoized) diff', async () => {
    const dir = await project();
    const base = await currentTreeSha(dir);
    const ticket = ticketFor(base);
    await writeFile(path.join(dir, 'src', 'value.js'), 'export const value = 2;\n');
    const head = await currentTreeSha(dir);
    // The claim omits the real change; the session-memoized diff must still
    // be the independently recomputed one, so the mismatch rejects.
    const receipt = receiptFor(ticket, head, []);
    const result = await validateStageReceipt({
      project_dir: dir,
      state: { run_id: 'run-1', receipts: [] },
      ticket,
      receipt,
      tree: treeShaSession(dir),
    });
    expect(result.valid).toBe(false);
    expect(result.errors.join(' ')).toMatch(/changed_files does not match the independently recomputed diff/);
  });
});
