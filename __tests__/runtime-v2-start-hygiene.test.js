import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { runtimePaths } from '../lib/runtime/paths.js';
import { abortRun, recordReceipt, resumeRun, startRun, statusRun } from '../lib/runtime/service.js';
import { atomicWriteJson } from '../lib/runtime/storage.js';
import { existsSync, readFileSync } from 'node:fs';
import { acquireRunLock } from '../lib/runtime/lock.js';
import { bindCodexDispatch } from './codex-native-test-helper.js';

const cleanups = [];
const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

function git(cwd, ...args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

// Config is written AFTER the baseline commit, so .ape/config.json is
// untracked at every start — each passing start exercises the .ape/ exemption.
async function project(prefix = 'ape-start-hygiene-') {
  const dir = await mkdtemp(path.join(tmpdir(), prefix));
  cleanups.push(dir);
  await mkdir(path.join(dir, 'src'));
  await mkdir(path.join(dir, 'tests'));
  await mkdir(path.join(dir, 'docs'));
  await writeFile(path.join(dir, 'src', 'value.js'), 'export const value = 1;\n');
  await writeFile(path.join(dir, 'tests', 'value.test.js'), 'throw new Error("red");\n');
  await writeFile(path.join(dir, 'docs', 'notes.md'), '# Notes\n');
  git(dir, 'init', '-q');
  git(dir, 'config', 'user.email', 'ape@example.test');
  git(dir, 'config', 'user.name', 'APE Test');
  git(dir, 'add', '.');
  git(dir, 'commit', '-qm', 'baseline');
  await atomicWriteJson(runtimePaths(dir).config, {
    shipping: { auto_merge: false, provider: 'github', required_remote_checks: false },
    test_commands: { full: 'node -e "process.exit(0)"', targeted: 'node -e "process.exit(0)"' },
  });
  return dir;
}

function startInput(overrides = {}) {
  return {
    objective: 'Exercise start-time working-tree hygiene',
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

function stageReceipt(ticket, receipt_capability, overrides = {}) {
  return {
    ticket_id: ticket.ticket_id,
    status: 'passed',
    agent_identity: `agent-${ticket.role}`,
    receipt_capability,
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

describe('APE v2 start-time working-tree hygiene', () => {
  it('rejects a dirty non-land start, names every dirty path, and leaves no branch or state', async () => {
    const dir = await project();
    await writeFile(path.join(dir, 'src', 'value.js'), 'export const value = 2;\n');
    await writeFile(path.join(dir, 'src', 'extra.js'), 'export const extra = 1;\n');
    const branchBefore = git(dir, 'rev-parse', '--abbrev-ref', 'HEAD');

    const error = await startRun(dir, startInput()).then(() => null, (thrown) => thrown);
    expect(error).toBeInstanceOf(Error);
    expect(error.message).toMatch(/requires a clean working tree/);
    expect(error.message).toMatch(/src\/value\.js/);
    expect(error.message).toMatch(/src\/extra\.js/);
    expect(error.message).toMatch(/Commit, stash, or revert/);

    expect((await statusRun(dir)).active).toBe(false);
    expect(git(dir, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe(branchBefore);
    expect(git(dir, 'branch', '--list', 'ape/*')).toBe('');
    // Non-destructive: the dirt survives untouched.
    expect(git(dir, 'status', '--porcelain')).toContain('src/extra.js');
  });

  it('exempts .ape/ runtime paths from the hygiene check', async () => {
    const dir = await project();
    const started = await startRun(dir, startInput());
    expect(started.ok).toBe(true);
  });

  it('mode land still starts from the dirty tree it exists to gate', async () => {
    const dir = await project();
    await writeFile(path.join(dir, 'src', 'value.js'), 'export const value = 2;\n');
    const started = await startRun(dir, startInput({ mode: 'land', lane: 'auto', test_paths: [] }));
    expect(started.ok).toBe(true);
    expect(started.run.mode).toBe('land');
    expect(started.run.branch).toMatch(/^ape\/land-/);
    expect(started.run.base_branch).toBe('main');
    expect(git(dir, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe(started.run.branch);
    expect(started.run.receipts[0].changed_files).toEqual(['src/value.js']);
  });

  it("does not inherit a dead run's ape/* branch: an aborted run is followed by a fresh branch", async () => {
    const dir = await project();
    const first = await startRun(dir, startInput());
    expect(first.ok).toBe(true);
    expect(first.run.branch).toMatch(/^ape\/phase-/);
    expect(git(dir, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe(first.run.branch);

    await abortRun(dir, 'simulate a dead run left on its branch');
    expect(git(dir, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('main');
    expect(git(dir, 'branch', '--list', first.run.branch)).toContain(first.run.branch);

    const second = await startRun(dir, startInput());
    expect(second.ok).toBe(true);
    expect(second.run.branch).toMatch(/^ape\/phase-/);
    expect(second.run.branch).not.toBe(first.run.branch);
    expect(git(dir, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe(second.run.branch);
  });

  it.each(['claude', 'codex'])('creates an isolated ape/* branch from the default tip for host %s', async (host) => {
    const dir = await project();
    const baseTip = git(dir, 'rev-parse', 'HEAD');
    git(dir, 'switch', '-q', '-c', 'feat/thing');
    await writeFile(path.join(dir, 'src', 'feature-only.js'), 'export const featureOnly = true;\n');
    git(dir, 'add', 'src/feature-only.js');
    git(dir, 'commit', '-qm', 'feature-only commit');

    const started = await startRun(dir, startInput({ host }));
    expect(started.ok).toBe(true);
    expect(started.run.branch).toMatch(/^ape\/phase-/);
    expect(started.run.base_branch).toBe('main');
    expect(started.run.base_commit_sha).toBe(baseTip);
    expect(git(dir, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe(started.run.branch);
    expect(existsSync(path.join(dir, 'src', 'feature-only.js'))).toBe(false);
  });

  it('keeps dirty aborted work on the run branch and resume returns after the operator cleans it', async () => {
    const dir = await project();
    const started = await startRun(dir, startInput());
    await writeFile(path.join(dir, 'src', 'value.js'), 'export const value = 2;\n');

    const aborted = await abortRun(dir, 'preserve unfinished work');
    expect(aborted.run.checkout_cleanup).toMatchObject({
      status: 'retained_dirty',
      run_branch: started.run.branch,
      base_branch: 'main',
      retained: true,
      deleted: false,
      dirty_paths: ['src/value.js'],
    });
    expect(git(dir, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe(started.run.branch);

    git(dir, 'restore', 'src/value.js');
    const resumed = await resumeRun(dir);
    expect(resumed.ok).toBe(true);
    expect(resumed.resume_state).toBe('checkout-returned');
    expect(resumed.run.checkout_cleanup).toMatchObject({ status: 'returned', retained: true, deleted: false });
    expect(git(dir, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('main');
    expect(git(dir, 'branch', '--list', started.run.branch)).toContain(started.run.branch);
  });

  it('returns a completed read-only run to main and deletes its empty APE branch', async () => {
    const dir = await project();
    const started = await startRun(dir, startInput({
      mode: 'debug',
      lane: 'auto',
      behavioral: false,
      claimed_paths: [],
      test_paths: [],
    }));
    const dispatched = started.actions.find((action) => action.type === 'dispatch_agent');
    const capability = await bindCodexDispatch(root, dir, dispatched);

    const completed = await recordReceipt(dir, stageReceipt(dispatched.ticket, capability));

    expect(completed.run.status).toBe('completed');
    expect(completed.run.checkout_cleanup).toMatchObject({ status: 'returned', retained: false, deleted: true });
    expect(git(dir, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('main');
    expect(git(dir, 'branch', '--list', started.run.branch)).toBe('');
  });

  it('returns a clean blocked run to main while retaining its APE branch', async () => {
    const dir = await project();
    const started = await startRun(dir, startInput({
      mode: 'debug', lane: 'auto', behavioral: false, claimed_paths: [], test_paths: [],
    }));
    const first = started.actions.find((action) => action.type === 'dispatch_agent');
    const firstCapability = await bindCodexDispatch(root, dir, first, 1);
    const retried = await recordReceipt(dir, stageReceipt(first.ticket, firstCapability, {
      status: 'failed', evidence: { verdict: 'fail' },
    }));
    const second = retried.actions.find((action) => action.type === 'dispatch_agent');
    const secondCapability = await bindCodexDispatch(root, dir, second, 2);
    const blocked = await recordReceipt(dir, stageReceipt(second.ticket, secondCapability, {
      status: 'failed', evidence: { verdict: 'fail' },
    }));

    expect(blocked.run.status).toBe('blocked');
    expect(blocked.run.checkout_cleanup).toMatchObject({ status: 'returned', retained: true, deleted: false });
    expect(git(dir, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('main');
    expect(git(dir, 'branch', '--list', started.run.branch)).toContain(started.run.branch);
  });

  it('preserves a slashed default branch through start and abort cleanup', async () => {
    const dir = await project();
    const baseTip = git(dir, 'rev-parse', 'HEAD');
    git(dir, 'update-ref', 'refs/remotes/origin/release/stable', baseTip);
    git(dir, 'symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/release/stable');

    const started = await startRun(dir, startInput());
    expect(started.run.base_branch).toBe('release/stable');
    expect(started.run.base_commit_sha).toBe(baseTip);
    expect(started.run.branch).toMatch(/^ape\/phase-/);

    const aborted = await abortRun(dir, 'exercise slashed-base cleanup');
    expect(aborted.run.checkout_cleanup).toMatchObject({
      status: 'returned', base_branch: 'release/stable', retained: true, deleted: false,
    });
    expect(git(dir, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('release/stable');
    expect(git(dir, 'branch', '--list', started.run.branch)).toContain(started.run.branch);
  });
});

// The ape/* branches in this repo, marker-stripped and sorted, so a test that
// starts ON an ape/* branch can assert no NEW ape/* branch was created.
function apeBranches(dir) {
  return git(dir, 'branch', '--list', 'ape/*')
    .split('\n')
    .map((line) => line.replace(/^[*+]?\s*/, '').trim())
    .filter(Boolean)
    .sort();
}

// Two startRun defects (lib/runtime/service.js): (1) `git switch -c` runs before
// the run lock is acquired, so a losing concurrent start mutates git before
// dying; (2) a new ape/* run branches off a leftover ape/* checkout's tip, so
// the leftover's unmerged commits become the new run's attested baseline.
describe('APE v2 start-time git/lock hygiene (baseline integrity)', () => {
  it('makes no git side effect when the run lock is already held', async () => {
    const dir = await project();
    const paths = runtimePaths(dir);
    // A lock whose active.json matches by run_id and whose pid is LIVE is the
    // one shape that reaches the lock acquisition: startRun admits the aborted
    // existing run, and doctor's lock-health passes (run_id matches, pid alive
    // so not stale). A lock with no matching active.json fails doctor as
    // orphaned and returns before any git; a dead-pid lock is stale-recovered
    // and the start SUCCEEDS — neither would be red.
    await atomicWriteJson(paths.active, { run_id: 'run-X', status: 'aborted', stage: 'aborted' });
    await acquireRunLock(paths.lock, 'run-X');
    const headBefore = git(dir, 'rev-parse', 'HEAD');
    const branchBefore = git(dir, 'rev-parse', '--abbrev-ref', 'HEAD');

    const error = await startRun(dir, startInput()).then(() => null, (thrown) => thrown);
    expect(error).toBeInstanceOf(Error);
    expect(error.message).toMatch(/another APE writing run is active/);

    // A start that cannot get the run lock must not have mutated git: same HEAD,
    // same current branch, and no newly created ape/* branch.
    expect(git(dir, 'rev-parse', 'HEAD')).toBe(headBefore);
    expect(git(dir, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe(branchBefore);
    expect(git(dir, 'branch', '--list', 'ape/*')).toBe('');
    // The loser must not steal or release the winner's lock.
    expect(JSON.parse(readFileSync(paths.lock, 'utf8')).run_id).toBe('run-X');
  });

  it("branches a fresh ape/* run off the base tip, excluding a leftover checkout's extra commit", async () => {
    const dir = await project();
    // The base branch tip and tree, captured before the leftover diverges.
    const baseTip = git(dir, 'rev-parse', 'HEAD');
    const baseTree = git(dir, 'rev-parse', 'HEAD^{tree}');

    // A dead run's leftover ape/* checkout carrying a committed-but-unmerged
    // file (uncommitted would hit the clean-tree rejection instead).
    git(dir, 'switch', '-q', '-c', 'ape/phase-dead0000');
    await writeFile(path.join(dir, 'src', 'dead.js'), 'export const dead = 1;\n');
    git(dir, 'add', 'src/dead.js');
    git(dir, 'commit', '-qm', 'unmerged work from a dead run');
    expect(git(dir, 'rev-parse', 'HEAD')).not.toBe(baseTip);

    const started = await startRun(dir, startInput());
    expect(started.ok).toBe(true);
    // A fresh ape/phase-* branch, never the leftover.
    expect(started.run.branch).toMatch(/^ape\/phase-/);
    expect(started.run.branch).not.toBe('ape/phase-dead0000');
    // Baseline is the base branch tip, not the leftover tip: base_commit_sha,
    // the first ticket's base_tree_sha, and the worktree all exclude the extra
    // commit.
    expect(started.run.base_commit_sha).toBe(baseTip);
    expect(started.run.tickets.length).toBeGreaterThan(0);
    expect(started.run.tickets[0].base_tree_sha).toBe(baseTree);
    expect(existsSync(path.join(dir, 'src', 'dead.js'))).toBe(false);
  });

  it('refuses a land-mode start whose dirty diff is not based on the default tip', async () => {
    const dir = await project();
    // A leftover ape/* checkout with its own unmerged commit.
    git(dir, 'switch', '-q', '-c', 'ape/phase-leftover');
    await writeFile(path.join(dir, 'src', 'leftover.js'), 'export const leftover = 1;\n');
    git(dir, 'add', 'src/leftover.js');
    git(dir, 'commit', '-qm', 'unmerged work from a dead run');
    // A land admission needs a non-empty working-tree diff inside claimed_paths.
    await writeFile(path.join(dir, 'src', 'value.js'), 'export const value = 2;\n');
    const before = apeBranches(dir);
    expect(before).toEqual(['ape/phase-leftover']);

    // Land computes its admission baseline from HEAD before the branch arm, so
    // silently re-basing a validated diff onto a fresh branch is wrong: the
    // start must be refused rather than proceed.
    const outcome = await startRun(dir, startInput({ mode: 'land', lane: 'auto', test_paths: [] }))
      .then((result) => result, (thrown) => thrown);
    expect(outcome?.ok).not.toBe(true);
    expect(outcome.message).toMatch(/requires the finished diff to be based on the resolved default branch tip/);
    // No new ape/* branch: only the leftover remains.
    expect(apeBranches(dir)).toEqual(before);
  });
});
