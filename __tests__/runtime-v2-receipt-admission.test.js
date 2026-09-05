import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { currentTreeSha } from '../lib/runtime/git.js';
import { validateStageReceipt } from '../lib/runtime/receipt-validator.js';
import { finalizeReceipt, finalizeTicket } from '../lib/runtime/schemas.js';
import { SCHEMA_VERSION } from '../lib/runtime/constants.js';
import { runtimePaths } from '../lib/runtime/paths.js';
import { recordReceipt, startRun } from '../lib/runtime/service.js';
import { atomicWriteJson } from '../lib/runtime/storage.js';

const cleanups = [];
afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

function git(cwd, ...args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

async function project() {
  const dir = await mkdtemp(path.join(tmpdir(), 'ape-admission-'));
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

function ticketFor(baseTreeSha, { issuedAt, deadlineAt }) {
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
    deadline_at: deadlineAt,
    output_schema: {},
    required_checks: [],
    parent_hash: null,
    base_tree_sha: baseTreeSha,
    attempt: 1,
    writable: true,
    issued_at: issuedAt,
  });
}

function receiptFor(ticket, headTreeSha, completedAt, changedFiles = ['src/value.js'], status = 'passed') {
  return finalizeReceipt({
    schema_version: SCHEMA_VERSION,
    receipt_id: 'receipt-1',
    run_id: ticket.run_id,
    ticket_id: ticket.ticket_id,
    ticket_hash: ticket.ticket_hash,
    agent: { host: 'claude', role: 'implementer', identity: 'agent-implementer', model: 'opus' },
    status,
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

describe('deadline-aware receipt admission', () => {
  it('admits a late receipt while its head tree still matches the live tree', async () => {
    const dir = await project();
    const base = await currentTreeSha(dir);
    const issuedAt = new Date(Date.now() - 60_000).toISOString();
    const deadlineAt = new Date(Date.now() - 30_000).toISOString();
    const ticket = ticketFor(base, { issuedAt, deadlineAt });

    await writeFile(path.join(dir, 'src', 'value.js'), 'export const value = 2;\n');
    const head = await currentTreeSha(dir);
    const completedAt = new Date().toISOString();
    const receipt = receiptFor(ticket, head, completedAt);

    const result = await validateStageReceipt({
      project_dir: dir,
      state: { run_id: 'run-1', receipts: [] },
      ticket,
      receipt,
    });
    expect(result.valid).toBe(true);
    expect(result.errors).toEqual([]);
    expect(result.deadline_overrun_ms).toBeGreaterThan(0);
  });

  it('rejects a late receipt as both stale and overdue once the tree moves on', async () => {
    const dir = await project();
    const base = await currentTreeSha(dir);
    const issuedAt = new Date(Date.now() - 60_000).toISOString();
    const deadlineAt = new Date(Date.now() - 30_000).toISOString();
    const ticket = ticketFor(base, { issuedAt, deadlineAt });

    await writeFile(path.join(dir, 'src', 'value.js'), 'export const value = 2;\n');
    const head = await currentTreeSha(dir);
    const receipt = receiptFor(ticket, head, new Date().toISOString());

    await writeFile(path.join(dir, 'src', 'value.js'), 'export const value = 3;\n');

    const result = await validateStageReceipt({
      project_dir: dir,
      state: { run_id: 'run-1', receipts: [] },
      ticket,
      receipt,
    });
    expect(result.valid).toBe(false);
    expect(result.errors).toContain(
      "receipt head tree does not match the current tree (diverged: src/value.js); the writer cannot be attributed; preserve the current tree and inspect the state-aware recovery guidance before any operator-authorized lifecycle change",
    );
    expect(result.errors).toContain('stage deadline exceeded');
  });

  it('reports zero overrun for an on-time receipt', async () => {
    const dir = await project();
    const base = await currentTreeSha(dir);
    const issuedAt = new Date(Date.now() - 60_000).toISOString();
    const deadlineAt = new Date(Date.now() + 60_000).toISOString();
    const ticket = ticketFor(base, { issuedAt, deadlineAt });

    await writeFile(path.join(dir, 'src', 'value.js'), 'export const value = 2;\n');
    const head = await currentTreeSha(dir);
    const receipt = receiptFor(ticket, head, new Date().toISOString());

    const result = await validateStageReceipt({
      project_dir: dir,
      state: { run_id: 'run-1', receipts: [] },
      ticket,
      receipt,
    });
    expect(result.valid).toBe(true);
    expect(result.deadline_overrun_ms).toBe(0);
  });
});

describe('contamination diagnostics', () => {
  it('names the files an external writer diverged when the head tree mismatches', async () => {
    const dir = await project();
    const base = await currentTreeSha(dir);
    const issuedAt = new Date(Date.now() - 60_000).toISOString();
    const deadlineAt = new Date(Date.now() + 60_000).toISOString();
    const ticket = ticketFor(base, { issuedAt, deadlineAt });

    await writeFile(path.join(dir, 'src', 'value.js'), 'export const value = 2;\n');
    const head = await currentTreeSha(dir);
    const receipt = receiptFor(ticket, head, new Date().toISOString());

    await writeFile(path.join(dir, 'src', 'extra.js'), 'export const extra = 1;\n');

    const result = await validateStageReceipt({
      project_dir: dir,
      state: { run_id: 'run-1', receipts: [] },
      ticket,
      receipt,
    });
    expect(result.valid).toBe(false);
    expect(result.errors).toContain(
      "receipt head tree does not match the current tree (diverged: src/extra.js); the writer cannot be attributed; preserve the current tree and inspect the state-aware recovery guidance before any operator-authorized lifecycle change",
    );
    expect(result.errors).not.toContain('stage deadline exceeded');
    expect(result.errors.some((e) => e.startsWith('role-boundary violations'))).toBe(false);
  });

  it('flags role-boundary rejections as possible external writes and names the recovery path', async () => {
    const dir = await project();
    const base = await currentTreeSha(dir);
    const issuedAt = new Date(Date.now() - 60_000).toISOString();
    const deadlineAt = new Date(Date.now() + 60_000).toISOString();
    const ticket = ticketFor(base, { issuedAt, deadlineAt });

    await writeFile(path.join(dir, 'src', 'value.js'), 'export const value = 2;\n');
    await writeFile(path.join(dir, 'src', 'rogue.js'), 'export const rogue = 1;\n');
    const head = await currentTreeSha(dir);
    const receipt = receiptFor(ticket, head, new Date().toISOString(), ['src/rogue.js', 'src/value.js']);

    const result = await validateStageReceipt({
      project_dir: dir,
      state: { run_id: 'run-1', receipts: [] },
      ticket,
      receipt,
    });
    expect(result.valid).toBe(false);
    expect(result.errors).toContain('unclaimed write: src/rogue.js');
    expect(result.errors).toContain(
      "role-boundary violations (src/rogue.js) may not be the ticketed agent's own writes; the writer cannot be attributed; preserve the current tree and inspect the state-aware recovery guidance before any operator-authorized lifecycle change",
    );
    expect(result.errors.some((e) => e.startsWith('receipt head tree does not match'))).toBe(false);
  });
});

describe('receipt status enum admission', () => {
  it('rejects a receipt whose status is the dead "cancelled" value with a schema/status error', async () => {
    const dir = await project();
    const base = await currentTreeSha(dir);
    const issuedAt = new Date(Date.now() - 60_000).toISOString();
    const deadlineAt = new Date(Date.now() + 60_000).toISOString();
    const ticket = ticketFor(base, { issuedAt, deadlineAt });

    await writeFile(path.join(dir, 'src', 'value.js'), 'export const value = 2;\n');
    const head = await currentTreeSha(dir);
    const completedAt = new Date().toISOString();

    // 'cancelled' has no producer and no distinct handling in the runtime, so a
    // receipt bearing it silently rides the generic non-passed path and is
    // misclassified as 'failed'. It must instead be rejected LOUDLY at the
    // receipt schema boundary: finalizeReceipt runs StageReceiptSchema, whose
    // status enum is derived from RECEIPT_STATUSES, so dropping the dead value
    // turns admission into a clear status schema error.
    expect(() => receiptFor(ticket, head, completedAt, ['src/value.js'], 'cancelled')).toThrow(/status/i);
  });

  it('still admits receipts with status "passed" or "failed"', async () => {
    const dir = await project();
    const base = await currentTreeSha(dir);
    const issuedAt = new Date(Date.now() - 60_000).toISOString();
    const deadlineAt = new Date(Date.now() + 60_000).toISOString();
    const ticket = ticketFor(base, { issuedAt, deadlineAt });

    await writeFile(path.join(dir, 'src', 'value.js'), 'export const value = 2;\n');
    const head = await currentTreeSha(dir);
    const completedAt = new Date().toISOString();

    for (const status of ['passed', 'failed']) {
      const receipt = receiptFor(ticket, head, completedAt, ['src/value.js'], status);
      const result = await validateStageReceipt({
        project_dir: dir,
        state: { run_id: 'run-1', receipts: [] },
        ticket,
        receipt,
      });
      expect(result.valid).toBe(true);
      expect(result.errors).toEqual([]);
    }
  });
});

describe('receipt completed_at provenance (T5)', () => {
  // A mechanical (docs-only, host codex) run reaches a real recordReceipt with
  // no Claude capability binding required: node --version passes the full-suite
  // gate and the disabled auto-merge then blocks the run, which still ADMITS
  // (ok:true) the implementer receipt we inspect.
  function mechanicalStart() {
    return {
      objective: 'Update the documentation note',
      mode: 'phase',
      lane: 'mechanical',
      host: 'codex',
      claimed_paths: ['docs/note.md'],
      test_paths: [],
      requirements: ['R-T5-TIMING'],
      risk_triggers: [],
      behavioral: false,
      hooks_trusted: true,
      subagents_available: true,
      explicit_invocation: true,
    };
  }

  async function mechanicalProject() {
    const dir = await mkdtemp(path.join(tmpdir(), 'ape-admission-timing-'));
    cleanups.push(dir);
    await mkdir(path.join(dir, 'docs'));
    await writeFile(path.join(dir, 'docs', 'note.md'), '# note\n');
    git(dir, 'init', '-q');
    git(dir, 'config', 'user.email', 'ape@example.test');
    git(dir, 'config', 'user.name', 'APE Test');
    git(dir, 'add', '.');
    git(dir, 'commit', '-qm', 'baseline');
    await atomicWriteJson(runtimePaths(dir).config, {
      shipping: { auto_merge: false, provider: 'github', required_remote_checks: false },
      test_commands: { full: 'node --version' },
    });
    return dir;
  }

  // Drive the REAL service record path (recordReceipt), not the bare
  // validateStageReceipt the deadline tests above exercise: the completed_at
  // stamping this pins lives in recordReceiptLocked, so only an end-to-end
  // record reaches it. The agent supplies an obviously wrong completed_at on the
  // wire; started_at is left defaulting and duration_ms omitted so the runtime
  // derives duration from whichever completed_at survives into the sealed
  // receipt. `before`/`after` bracket the record call so the runtime stamp is
  // pinned to record time.
  async function recordWithWireCompletedAt(dir, wireCompletedAt) {
    const started = await startRun(dir, mechanicalStart());
    expect(started.ok).toBe(true);
    const build = started.run.tickets[0];
    expect(build.role).toBe('implementer');
    await writeFile(path.join(dir, 'docs', 'note.md'), '# note\n\nUpdated.\n');
    const before = Date.now();
    const result = await recordReceipt(dir, {
      ticket_id: build.ticket_id,
      status: 'passed',
      agent_identity: 'agent-implementer',
      tests: [{ command: 'node --version', passed: true, exit_code: 0, duration_ms: 1 }],
      findings: [],
      evidence: { verdict: 'pass' },
      timing: { started_at: build.issued_at, completed_at: wireCompletedAt },
    });
    const after = Date.now();
    return { result, before, after };
  }

  it('rejects contamination without changing the running run or advising an impossible reset', async () => {
    const dir = await mechanicalProject();
    const started = await startRun(dir, mechanicalStart());
    expect(started.ok).toBe(true);
    const ticket = started.run.tickets[0];
    await writeFile(path.join(dir, 'docs', 'rogue.md'), '# unrelated retained work\n');
    const paths = runtimePaths(dir);
    const before = await readFile(paths.active, 'utf8');
    const treeBefore = await currentTreeSha(dir);
    const result = await recordReceipt(dir, {
      ticket_id: ticket.ticket_id,
      status: 'passed',
      agent_identity: 'agent-implementer',
      tests: [], findings: [], evidence: { verdict: 'pass' },
    });
    expect(result.ok).toBe(false);
    expect(result.rejected).toBe(true);
    expect(result.recovery).toMatchObject({
      version: 1, cause: 'receipt-role-boundary', run_status: 'running',
      state_changed: false, operator_required: true, preserves_worktree: true,
      eligible_actions: ['diagnose', 'override-abort'],
    });
    expect(result.recovery.eligible_actions).not.toContain('override-reset');
    expect(result.errors.join(' ')).not.toMatch(/recover with.*reset|restore a clean tree/);
    expect(await readFile(paths.active, 'utf8')).toBe(before);
    expect(await currentTreeSha(dir)).toBe(treeBefore);
    expect(await readFile(path.join(dir, 'docs', 'rogue.md'), 'utf8')).toBe('# unrelated retained work\n');
  });

  it.each([
    ['a far-past wire completed_at', () => '1999-01-01T00:00:00.000Z'],
    ['a one-hour-future wire completed_at', () => new Date(Date.now() + 3_600_000).toISOString()],
  ])('stamps completed_at at record time, discarding %s from the wire', async (_label, makeWire) => {
    const wireCompletedAt = makeWire();
    const dir = await mechanicalProject();
    const { result, before, after } = await recordWithWireCompletedAt(dir, wireCompletedAt);

    // The receipt is admitted (a disabled-auto-merge block still returns ok:true).
    expect(result.ok).toBe(true);
    const admitted = result.receipt;
    // The admitted receipt is the one sealed onto the returned run state.
    expect(result.run.receipts.at(-1).timing.completed_at).toBe(admitted.timing.completed_at);

    // The runtime must stamp completed_at itself at record time; the
    // agent-supplied wire value must NOT survive into the sealed receipt. RED
    // today: recordReceiptLocked defaults `completedAt = raw.timing?.completed_at
    // ?? now()`, so the wire value passes through verbatim.
    expect(admitted.timing.completed_at).not.toBe(wireCompletedAt);
    const stamped = Date.parse(admitted.timing.completed_at);
    expect(Number.isNaN(stamped)).toBe(false);
    expect(stamped).toBeGreaterThanOrEqual(before);
    expect(stamped).toBeLessThanOrEqual(after);

    // duration_ms derived under the stamped completed_at stays non-negative.
    expect(admitted.timing.duration_ms).toBeGreaterThanOrEqual(0);
  });
});
