import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, utimes, writeFile } from 'node:fs/promises';
import { hostname, tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { runtimePaths } from '../lib/runtime/paths.js';
import { abortRun, configAction, recordReceipt, resumeRun, startRun, statusRun } from '../lib/runtime/service.js';
import { atomicWriteJson, readJson } from '../lib/runtime/storage.js';
import { existsSync, readFileSync } from 'node:fs';
import { acquireRunLock, releaseRunLock, withDirLock } from '../lib/runtime/lock.js';
import { currentTreeSha } from '../lib/runtime/git.js';
import { archiveRun } from '../lib/runtime/history.js';
import { bindCodexDispatch } from './codex-native-test-helper.js';
import { reconcileTerminalCheckout } from '../lib/runtime/receipt-service.js';
import { FAILURE_DOMAIN_TAXONOMY_VERSION } from '../lib/runtime/orchestration-telemetry.js';
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
  git(dir, 'init', '-q', '-b', 'main');
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

function boundedInitialTestPath(index, bytes) {
  const prefix = `tests/${index}/`;
  const suffix = '.test.js';
  const bodyBytes = bytes - Buffer.byteLength(prefix + suffix, 'utf8');
  return `${prefix}${bodyBytes % 2 === 0 ? '' : 'x'}${'é'.repeat(Math.floor(bodyBytes / 2))}${suffix}`;
}

function initialTestPathsAt4096Bytes(extraBytes = 0) {
  const paths = [
    ...Array.from({ length: 7 }, (_, index) => boundedInitialTestPath(index, 511)),
    boundedInitialTestPath(7, 494 + extraBytes),
  ];
  expect(Buffer.byteLength(JSON.stringify(paths), 'utf8')).toBe(4_096 + extraBytes);
  return paths;
}

async function refusedStart(dir, input) {
  const outcome = await startRun(dir, input).then(
    (value) => ({ value, error: null }),
    (error) => ({ value: null, error }),
  );
  const message = outcome.error?.message ?? outcome.value?.errors?.join(' ') ?? '';
  return { ...outcome, message };
}

async function shippingHarness({
  remotes = ['git@github.com:AAWWCC/ape.git'],
  remoteTree = 'f'.repeat(40),
  gh = {},
} = {}) {
  vi.resetModules();
  const events = [];
  let remoteReads = 0;
  const ghRouteCalls = new Map();
  const runGit = vi.fn(async (_dir, args) => {
    if (args[0] === 'remote' && args[1] === 'get-url') {
      const remote = remotes[Math.min(remoteReads, remotes.length - 1)];
      remoteReads += 1;
      events.push({ kind: 'origin', remote });
      return remote;
    }
    events.push({ kind: 'git', args: [...args] });
    if (args[0] === 'branch' && args[1] === '--show-current') return 'ape/phase-public';
    if (args[0] === 'ls-files') return 'src/value.js\0';
    if (args[0] === 'ls-tree') return 'src/value.js\0';
    if (args[0] === 'diff') return 'src/value.js';
    if (args[0] === 'show-ref') return '';
    if (args[0] === 'rev-parse' && String(args[1]).includes('origin/main') &&
      String(args[1]).endsWith('^{tree}')) return remoteTree;
    if (args[0] === 'rev-parse') return 'c'.repeat(40);
    return '';
  });
  const spawnWithTimeout = vi.fn(async (command, args) => {
    events.push({ kind: 'gh', command, args: [...args] });
    const route = args[1];
    const configured = gh[route] ?? (
      route === 'view'
        ? { exit_code: 1, combined: 'no pull request found\n' }
        : route === 'create'
          ? { exit_code: 0, combined: 'https://github.com/AAWWCC/ape/pull/7\n' }
          : { exit_code: 0, combined: 'passed\n' }
    );
    const callIndex = ghRouteCalls.get(route) ?? 0;
    ghRouteCalls.set(route, callIndex + 1);
    const response = Array.isArray(configured)
      ? configured[Math.min(callIndex, configured.length - 1)]
      : configured;
    return {
      spawn_error: null,
      timed_out: false,
      ...response,
    };
  });
  const currentTreeShaMock = vi.fn(async (_dir, ref = 'HEAD') =>
    String(ref).includes('origin/main') ? remoteTree : 'f'.repeat(40));
  const remoteBranchTipMock = vi.fn(async () => 'c'.repeat(40));

  vi.doMock('../lib/runtime/git.js', () => ({
    currentTreeSha: currentTreeShaMock,
    remoteBranchTip: remoteBranchTipMock,
    runGit,
    workingTreeStatus: vi.fn(async () => ''),
  }));
  vi.doMock('../lib/runtime/spawn.js', () => ({
    spawnDetached: vi.fn(),
    spawnWithTimeout,
  }));
  const shipping = await import('../lib/runtime/github-shipping.js');
  vi.doUnmock('../lib/runtime/git.js');
  vi.doUnmock('../lib/runtime/spawn.js');
  return { ...shipping, events, runGit, spawnWithTimeout };
}

function shippingState(overrides = {}) {
  return {
    run_id: 'run-shipping-remediation',
    objective: 'Ship only the attested public APE tree',
    mode: 'phase',
    lane: 'full',
    branch: 'ape/phase-public',
    base_branch: 'main',
    auto_merge_authorized: true,
    ship_requested: true,
    created_at: '2026-09-03T08:00:00.000Z',
    receipts: [{ changed_files: ['src/value.js'] }],
    gates: { passed: true, tree_sha: 'f'.repeat(40) },
    ...overrides,
  };
}

function shippingWatchState(overrides = {}) {
  return shippingState({
    shipping_watch: {
      provider: 'github',
      pr_url: 'https://github.com/AAWWCC/ape/pull/7',
      branch: 'ape/phase-public',
      base: 'main',
      head_oid: 'c'.repeat(40),
      created_at: '2026-09-03T08:00:00.000Z',
      last_poll_at: null,
      poll_count: 0,
      last_checks_summary: null,
    },
    ...overrides,
  });
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

  it('bootstraps a clean unborn repository with a root commit before creating the APE run branch', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'ape-start-unborn-'));
    cleanups.push(dir);
    git(dir, 'init', '-q', '-b', 'main');
    git(dir, 'config', 'user.email', 'ape@example.test');
    git(dir, 'config', 'user.name', 'APE Test');
    const initialized = await configAction(dir, 'init', {
      apply: true,
      behavioral: true,
      test_paths: ['tests/value.test.js'],
    });
    expect(initialized.init.applied_keys).toEqual([
      'test_commands.targeted_template',
      'test_commands.full',
    ]);

    const started = await startRun(dir, startInput({
      host: 'claude',
      binding_protocol: 'native-v1',
    }));

    expect(started.ok).toBe(true);
    expect(started.run.base_branch).toBe('main');
    expect(started.run.base_commit_sha).toMatch(/^[0-9a-f]{40}$/);
    expect(git(dir, 'rev-parse', 'refs/heads/main')).toBe(started.run.base_commit_sha);
    expect(git(dir, 'show', '-s', '--format=%s', started.run.base_commit_sha))
      .toBe('Initialize repository for APE');
    expect(git(dir, 'rev-list', '--parents', '-n', '1', started.run.base_commit_sha).split(' '))
      .toHaveLength(1);
    expect(git(dir, 'branch', '--show-current')).toBe(started.run.branch);
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

  it('refuses a structured successor without mutating an exact dirty blocked tree', async () => {
    const dir = await project();
    const first = await startRun(dir, startInput());
    const paths = runtimePaths(dir);
    await writeFile(path.join(dir, 'src', 'value.js'), 'export const value = 2;\n');

    const blocked = await readJson(paths.active);
    blocked.status = 'blocked';
    blocked.stage = 'remediation';
    blocked.block_reason = 'review disagreement reached the configured remediation budget';
    blocked.remediation_cycles = 2;
    blocked.terminal_reason_code = 'review_remediation_exhausted';
    blocked.failure_domain = 'product';
    blocked.failure_domain_taxonomy_version = FAILURE_DOMAIN_TAXONOMY_VERSION;
    blocked.tree_sha = await currentTreeSha(dir);
    await atomicWriteJson(paths.active, blocked);
    await archiveRun(paths, blocked);
    await releaseRunLock(paths.lock, blocked.run_id);
    const branchBefore = git(dir, 'branch', '--show-current');

    const refused = await startRun(dir, {
      ...startInput(),
      successor: {
        version: 2,
        predecessor_run_id: blocked.run_id,
        retained_tree_sha: blocked.tree_sha,
        config_hash: blocked.start_config_hash,
        approval_id: 'successor-approval-00000000-0000-4000-8000-000000000001',
      },
    });
    expect(refused).toMatchObject({ ok: false, blocked: true, attempts_consumed: 0 });
    expect(refused.errors.join(' ')).toMatch(/authenticated user provenance|override reset/i);
    expect(await readJson(paths.active)).toEqual(blocked);
    expect(git(dir, 'branch', '--show-current')).toBe(branchBefore);
    expect(await currentTreeSha(dir)).toBe(blocked.tree_sha);
    expect(first.run.run_id).toBe(blocked.run_id);
  });

  it('offers only explicit override-reset guidance for a persisted land review disagreement', async () => {
    const dir = await project();
    await startRun(dir, startInput());
    const paths = runtimePaths(dir);
    await writeFile(path.join(dir, 'src', 'value.js'), 'export const value = 2;\n');

    const blocked = await readJson(paths.active);
    blocked.mode = 'land';
    blocked.status = 'blocked';
    blocked.stage = 'review';
    blocked.block_reason = 'land mode has no writing stage; revise the diff outside APE, then start a new land run';
    blocked.remediation_cycles = 0;
    blocked.terminal_reason_taxonomy_version = 2;
    blocked.terminal_reason_code = 'land_review_disagreement';
    blocked.failure_domain = 'product';
    blocked.failure_domain_taxonomy_version = FAILURE_DOMAIN_TAXONOMY_VERSION;
    blocked.tree_sha = await currentTreeSha(dir);
    await atomicWriteJson(paths.active, blocked);
    await archiveRun(paths, blocked);
    await releaseRunLock(paths.lock, blocked.run_id);

    const status = await statusRun(dir);
    expect(status.successor_guidance).toMatchObject({
      version: 2,
      eligible: true,
      predecessor_run_id: blocked.run_id,
      retained_tree_sha: blocked.tree_sha,
      eligibility_reason: 'land_review_disagreement',
      structured_successor_supported: false,
      unavailable_reason: 'authenticated-host-approval-unavailable',
      recovery_action: 'override-reset',
      required_authorization: 'explicit-operator-override',
      automatic_start: false,
      automatic_ship: false,
    });

    const branchBefore = git(dir, 'branch', '--show-current');
    const refused = await startRun(dir, {
      ...startInput(),
      successor: {
        version: 2,
        predecessor_run_id: blocked.run_id,
        retained_tree_sha: blocked.tree_sha,
        config_hash: status.successor_guidance.config_hash,
        approval_id: 'successor-approval-00000000-0000-4000-8000-000000000001',
      },
    });
    expect(refused).toMatchObject({ ok: false, blocked: true, attempts_consumed: 0 });
    expect(refused.errors.join(' ')).toMatch(/authenticated user provenance|override reset/i);
    expect(await readJson(paths.active)).toEqual(blocked);
    expect(git(dir, 'branch', '--show-current')).toBe(branchBefore);
    expect(await currentTreeSha(dir)).toBe(blocked.tree_sha);
  });

  it('refuses a structured successor without rebasing a clean committed blocked tree', async () => {
    const dir = await project();
    await startRun(dir, startInput());
    const paths = runtimePaths(dir);
    await writeFile(path.join(dir, 'src', 'value.js'), 'export const value = 2;\n');

    const blocked = await readJson(paths.active);
    blocked.status = 'blocked';
    blocked.stage = 'gates';
    blocked.block_reason = 'remote checks failed after shipping committed the run tree';
    blocked.terminal_reason_code = 'stage_failed';
    blocked.failure_domain = 'product';
    blocked.failure_domain_taxonomy_version = FAILURE_DOMAIN_TAXONOMY_VERSION;
    blocked.tree_sha = await currentTreeSha(dir);
    await atomicWriteJson(paths.active, blocked);
    await archiveRun(paths, blocked);
    await releaseRunLock(paths.lock, blocked.run_id);

    git(dir, 'add', 'src/value.js');
    git(dir, 'commit', '-qm', 'runtime-owned shipping commit');
    const commitBefore = git(dir, 'rev-parse', 'HEAD');
    const branchBefore = git(dir, 'branch', '--show-current');

    const refused = await startRun(dir, {
      ...startInput(),
      successor: {
        version: 2,
        predecessor_run_id: blocked.run_id,
        retained_tree_sha: blocked.tree_sha,
        config_hash: blocked.start_config_hash,
        approval_id: 'successor-approval-00000000-0000-4000-8000-000000000001',
      },
    });
    expect(refused).toMatchObject({ ok: false, blocked: true, attempts_consumed: 0 });
    expect(refused.errors.join(' ')).toMatch(/authenticated user provenance|override reset/i);
    expect(await readJson(paths.active)).toEqual(blocked);
    expect(git(dir, 'branch', '--show-current')).toBe(branchBefore);
    expect(git(dir, 'rev-parse', 'HEAD')).toBe(commitBefore);
    expect(await currentTreeSha(dir)).toBe(blocked.tree_sha);
  });

  it('derives automatic shipping authority from the explicit APE invocation and repository config', async () => {
    const dir = await project();
    await atomicWriteJson(runtimePaths(dir).config, {
      shipping: { auto_merge: true, provider: 'github', required_remote_checks: false },
      test_commands: { full: 'node -e "process.exit(0)"', targeted: 'node -e "process.exit(0)"' },
    });

    const started = await startRun(dir, startInput({
      host: 'claude',
      binding_protocol: 'native-v1',
    }));
    expect(started.ok).toBe(true);
    expect(started.run.auto_merge_authorized).toBe(true);
  });

  it('rejects an auto-merge start before branching when origin main is stale', async () => {
    const dir = await project();
    const remote = await mkdtemp(path.join(tmpdir(), 'ape-start-hygiene-remote-'));
    const updater = await mkdtemp(path.join(tmpdir(), 'ape-start-hygiene-updater-'));
    cleanups.push(remote, updater);
    git(remote, 'init', '-q', '--bare', '-b', 'main');
    git(dir, 'remote', 'add', 'origin', remote);
    git(dir, 'push', '-q', '-u', 'origin', 'main');
    git(dir, 'remote', 'set-head', 'origin', 'main');
    const staleTip = git(dir, 'rev-parse', 'refs/remotes/origin/main');

    git(updater, 'clone', '-q', remote, '.');
    git(updater, 'config', 'user.email', 'ape@example.test');
    git(updater, 'config', 'user.name', 'APE Test');
    await writeFile(path.join(updater, 'src', 'remote.js'), 'export const remote = true;\n');
    git(updater, 'add', 'src/remote.js');
    git(updater, 'commit', '-qm', 'advance remote main');
    git(updater, 'push', '-q', 'origin', 'main');
    const remoteTip = git(updater, 'rev-parse', 'HEAD');
    expect(remoteTip).not.toBe(staleTip);

    await atomicWriteJson(runtimePaths(dir).config, {
      shipping: { auto_merge: true, provider: 'github', required_remote_checks: false },
      test_commands: { full: 'node -e "process.exit(0)"', targeted: 'node -e "process.exit(0)"' },
    });
    const branchBefore = git(dir, 'branch', '--show-current');
    await expect(startRun(dir, startInput({
      host: 'claude',
      binding_protocol: 'native-v1',
    }))).rejects.toThrow(/origin\/main is stale.*git fetch origin main/);

    expect((await statusRun(dir)).active).toBe(false);
    expect(git(dir, 'branch', '--show-current')).toBe(branchBefore);
    expect(git(dir, 'branch', '--list', 'ape/*')).toBe('');
    expect(git(dir, 'rev-parse', 'refs/remotes/origin/main')).toBe(staleTip);
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

  it('does not report a completed GitHub checkout returned while local main still diverges from the squash merge', async () => {
    const dir = await project();
    const remote = await mkdtemp(path.join(tmpdir(), 'ape-start-hygiene-remote-'));
    const updater = await mkdtemp(path.join(tmpdir(), 'ape-start-hygiene-updater-'));
    cleanups.push(remote, updater);
    git(remote, 'init', '-q', '--bare', '-b', 'main');
    git(dir, 'remote', 'add', 'origin', remote);
    git(dir, 'push', '-q', '-u', 'origin', 'main');

    await writeFile(path.join(dir, 'docs', 'land.md'), 'landed\n');
    git(dir, 'add', 'docs/land.md');
    git(dir, 'commit', '-qm', 'local land commit');
    const localTip = git(dir, 'rev-parse', 'HEAD');

    git(updater, 'clone', '-q', remote, '.');
    git(updater, 'config', 'user.email', 'ape@example.test');
    git(updater, 'config', 'user.name', 'APE Test');
    await writeFile(path.join(updater, 'docs', 'land.md'), 'landed\n');
    git(updater, 'add', 'docs/land.md');
    git(updater, 'commit', '-qm', 'remote squash commit');
    git(updater, 'push', '-q', 'origin', 'main');
    git(dir, 'fetch', '-q', 'origin', 'main');
    const remoteTip = git(dir, 'rev-parse', 'refs/remotes/origin/main');
    expect(remoteTip).not.toBe(localTip);

    const cleanup = await reconcileTerminalCheckout(runtimePaths(dir), {
      status: 'completed',
      branch: 'ape/land-test',
      base_branch: 'main',
      merge: { provider: 'github' },
    });

    expect(cleanup).toMatchObject({
      status: 'retained_error',
      base_branch: 'main',
      retained: true,
      deleted: false,
    });
    expect(cleanup.reason).toMatch(/not aligned with origin\/main/);
    expect(git(dir, 'rev-parse', 'HEAD')).toBe(localTip);
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
  it('does not accept an untrusted retiring process record as proof that the receipt-lock owner died', async () => {
    const dir = await project();
    const lockPath = runtimePaths(dir).receiptLock;
    const ownerToken = 'forged-retiring-owner';
    await mkdir(lockPath, { recursive: true });
    await writeFile(path.join(lockPath, 'owner'), ownerToken);
    await writeFile(path.join(lockPath, 'process'), `${JSON.stringify({
      version: 1,
      token: ownerToken,
      pid: process.pid,
      host: hostname(),
      state: 'retiring',
    })}\n`);
    const stale = new Date(Date.now() - 60_000);
    await utimes(lockPath, stale, stale);
    let rivalEntered = false;

    const attempted = await withDirLock(lockPath, async () => {
      rivalEntered = true;
    }, {
      staleMs: 5,
      heartbeatMs: 60_000,
      busyMs: 50,
      busyMessage: 'receipt effect lock owner is still authoritative',
      serializeLocal: false,
    }).then(
      (value) => ({ value, error: null }),
      (error) => ({ value: null, error }),
    );

    expect(rivalEntered).toBe(false);
    expect(attempted.error?.message).toMatch(/authoritative|busy|owner|process/i);
    expect(await readFile(path.join(lockPath, 'owner'), 'utf8')).toBe(ownerToken);
  });

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

  it('lands a committed feature-branch diff plus dirty finishing work when both descend from the default tip', async () => {
    const dir = await project();
    // A leftover ape/* checkout with its own unmerged commit.
    git(dir, 'switch', '-q', '-c', 'ape/phase-leftover');
    await writeFile(path.join(dir, 'src', 'leftover.js'), 'export const leftover = 1;\n');
    git(dir, 'add', 'src/leftover.js');
    git(dir, 'commit', '-qm', 'unmerged work from a dead run');
    // A land admission needs a non-empty working-tree diff inside claimed_paths.
    await writeFile(path.join(dir, 'src', 'value.js'), 'export const value = 2;\n');
    const committedTip = git(dir, 'rev-parse', 'HEAD');

    const started = await startRun(dir, startInput({
      mode: 'land',
      lane: 'auto',
      behavioral: false,
      claimed_paths: ['src/leftover.js', 'src/value.js'],
      test_paths: [],
    }));
    expect(started.ok).toBe(true);
    expect(started.run.branch).toMatch(/^ape\/land-/);
    expect(git(dir, 'merge-base', '--is-ancestor', committedTip, 'HEAD')).toBe('');
    expect(started.run.receipts[0].changed_files).toEqual(['src/leftover.js', 'src/value.js']);
    expect(await readFileSync(path.join(dir, 'src', 'leftover.js'), 'utf8')).toContain('leftover = 1');
    expect(await readFileSync(path.join(dir, 'src', 'value.js'), 'utf8')).toContain('value = 2');
  });

  it('refuses land mode when the feature commit does not descend from the resolved default tip', async () => {
    const dir = await project();
    const baseTree = git(dir, 'rev-parse', 'HEAD^{tree}');
    const unrelated = git(dir, 'commit-tree', baseTree, '-m', 'unrelated root');
    git(dir, 'switch', '-q', '-c', 'feature/unrelated', unrelated);
    await writeFile(path.join(dir, 'src', 'value.js'), 'export const value = 2;\n');

    await expect(startRun(dir, startInput({ mode: 'land', lane: 'auto', test_paths: [] })))
      .rejects.toThrow(/requires the finished diff to descend from the resolved default branch tip/);
    expect(apeBranches(dir)).toEqual([]);
    expect(git(dir, 'branch', '--show-current')).toBe('feature/unrelated');
  });
});

describe('APE v2 canonical initial test-path admission', () => {
  it('admits the exact 64-item and 4096-byte boundaries without rewriting order or bytes', async () => {
    const itemDir = await project('ape-start-path-items-');
    const itemBoundary = Array.from(
      { length: 64 },
      (_, index) => `tests/generated-${String(index).padStart(2, '0')}.test.js`,
    );
    const itemStarted = await startRun(itemDir, startInput({ test_paths: itemBoundary }));
    expect(itemStarted.ok).toBe(true);
    expect(itemStarted.run.test_paths).toEqual(itemBoundary);

    const byteDir = await project('ape-start-path-bytes-');
    const byteBoundary = initialTestPathsAt4096Bytes();
    const byteStarted = await startRun(byteDir, startInput({ test_paths: byteBoundary }));
    expect(byteStarted.ok).toBe(true);
    expect(byteStarted.run.test_paths).toEqual(byteBoundary);
  });

  it.each([
    [
      '65 canonical items',
      Array.from(
        { length: 65 },
        (_, index) => `tests/generated-${String(index).padStart(2, '0')}.test.js`,
      ),
      /64.*test_paths|test_paths.*64/i,
    ],
    [
      '4097 serialized UTF-8 bytes',
      initialTestPathsAt4096Bytes(1),
      /4096.*test_paths|test_paths.*4096/i,
    ],
    [
      'a canonical alias duplicate',
      ['tests/value.test.js', 'tests/./value.test.js'],
      /canonical|duplicate|unique/i,
    ],
    [
      'an absolute path outside the governed project',
      ['/tmp/ape-outside.test.js'],
      /canonical|contained|project.relative|outside/i,
    ],
    [
      'a parent-relative path outside the governed project',
      ['../outside.test.js'],
      /canonical|contained|project.relative|outside/i,
    ],
    [
      'a reserved runtime path',
      ['.ape/runtime/forged.test.js'],
      /canonical|reserved|\.ape|runtime/i,
    ],
    [
      'an option-like test-runner argument',
      ['--runInBand'],
      /canonical|option|project.relative|test.path/i,
    ],
    [
      'the project root rather than a test path',
      ['.'],
      /canonical|project.relative|root|test.path/i,
    ],
    [
      'a Windows drive-relative path',
      ['C:relative.test.js'],
      /canonical|drive|windows|project.relative|contained/i,
    ],
    [
      'a Windows UNC path',
      [String.raw`\\server\share\value.test.js`],
      /canonical|UNC|windows|project.relative|contained/i,
    ],
    [
      'a Windows device path',
      [String.raw`\\?\C:\tests\value.test.js`],
      /canonical|device|windows|project.relative|contained/i,
    ],
    [
      'a Windows alternate-data-stream path',
      ['tests/value.test.js:payload'],
      /canonical|alternate.data|stream|windows|project.relative/i,
    ],
    [
      'a case-folded Windows alias of the reserved runtime directory',
      ['.APE/runtime/forged.test.js'],
      /canonical|reserved|\.ape|runtime/i,
    ],
    [
      'a control-character path',
      [`tests/value${String.fromCharCode(1)}.test.js`],
      /control|canonical|project.relative/i,
    ],
  ])('rejects %s before creating state, a lock, or a branch', async (_label, testPaths, error) => {
    const dir = await project('ape-start-path-reject-');
    const branchBefore = git(dir, 'branch', '--show-current');
    const headBefore = git(dir, 'rev-parse', 'HEAD');
    const attempted = await refusedStart(dir, startInput({ test_paths: testPaths }));
    const paths = runtimePaths(dir);

    expect(attempted.value?.ok).not.toBe(true);
    expect(attempted.message).toMatch(error);
    expect(existsSync(paths.active)).toBe(false);
    expect(existsSync(paths.lock)).toBe(false);
    expect(existsSync(paths.receiptLock)).toBe(false);
    expect(existsSync(paths.tickets)).toBe(false);
    expect(existsSync(paths.contracts)).toBe(false);
    expect((await statusRun(dir)).active).toBe(false);
    expect(git(dir, 'branch', '--show-current')).toBe(branchBefore);
    expect(git(dir, 'rev-parse', 'HEAD')).toBe(headBefore);
    expect(git(dir, 'branch', '--list', 'ape/*')).toBe('');
  });
});

describe('APE v2 public-origin and frozen auto-merge authority', () => {
  const config = {
    shipping: {
      auto_merge: true,
      provider: 'github',
      required_remote_checks: false,
    },
  };

  it('rejects a foreign github.com origin before the first Git or GitHub mutation', async () => {
    const harness = await shippingHarness({
      remotes: ['https://github.com/attacker/ape.git'],
    });

    const outcome = await harness.autoMergeGithub('/tmp/ape-public-origin', shippingState(), config)
      .then((value) => ({ value, error: null }), (error) => ({ value: null, error }));

    expect(outcome.value).toBeNull();
    expect(outcome.error?.message).toMatch(/AAWWCC\/ape|public origin|authorized origin/i);
    expect(harness.events.some((entry) =>
      entry.kind === 'git' && ['add', 'commit', 'push'].includes(entry.args[0]))).toBe(false);
    expect(harness.events.some((entry) =>
      entry.kind === 'gh' && ['create', 'merge'].includes(entry.args[1]))).toBe(false);
  });

  it('binds every remote mutation to one immutable public target', async () => {
    const harness = await shippingHarness();

    const result = await harness.autoMergeGithub('/tmp/ape-public-origin', shippingState(), config);
    expect(result.provider).toBe('github');

    expect(harness.events.filter((entry) => entry.kind === 'origin')).toEqual([{
      kind: 'origin',
      remote: 'git@github.com:AAWWCC/ape.git',
    }]);
    expect(harness.events.find((entry) =>
      entry.kind === 'git' && entry.args[0] === 'push')?.args).toEqual([
      'push',
      'git@github.com:AAWWCC/ape.git',
      'HEAD:refs/heads/ape/phase-public',
    ]);
    for (const entry of harness.events.filter((candidate) => candidate.kind === 'gh')) {
      expect(entry.args.slice(-2)).toEqual(['--repo', 'AAWWCC/ape']);
    }
    expect(harness.events.find((entry) =>
      entry.kind === 'gh' && entry.args[1] === 'merge')?.args)
      .toContain('https://github.com/AAWWCC/ape/pull/7');
  });

  it('cannot be retargeted when origin changes after entry but before staging', async () => {
    const harness = await shippingHarness({
      remotes: [
        'git@github.com:AAWWCC/ape.git',
        'git@github.com:attacker/ape.git',
      ],
    });

    const result = await harness.autoMergeGithub(
      '/tmp/ape-public-origin',
      shippingState(),
      config,
    );

    expect(result.provider).toBe('github');
    expect(harness.events.filter((entry) => entry.kind === 'origin')).toHaveLength(1);
    expect(JSON.stringify(harness.events)).not.toContain('attacker/ape');
    expect(harness.events.find((entry) =>
      entry.kind === 'git' && entry.args[0] === 'push')?.args[1])
      .toBe('git@github.com:AAWWCC/ape.git');
  });

  it('pins poll, merge, and auto-merge commands to the persisted PR and public repository', async () => {
    const harness = await shippingHarness({
      remotes: [
        'git@github.com:AAWWCC/ape.git',
        'git@github.com:attacker/ape.git',
      ],
      gh: {
        checks: { exit_code: 0, combined: 'passed\n' },
        view: {
          exit_code: 0,
          combined: `OPEN https://github.com/AAWWCC/ape/pull/7 - ${'c'.repeat(40)}\n`,
        },
        merge: [
          { exit_code: 1, combined: 'branch policy prohibits the merge; add --auto\n' },
          { exit_code: 0, combined: 'auto-merge enabled\n' },
        ],
      },
    });

    const result = await harness.pollRemoteChecksAndMerge(
      '/tmp/ape-public-origin',
      shippingWatchState(),
      config,
    );

    expect(result.pending?.reason).toBe('awaiting auto-merge');
    expect(harness.events.filter((entry) => entry.kind === 'origin')).toHaveLength(1);
    expect(JSON.stringify(harness.events)).not.toContain('attacker/ape');
    for (const entry of harness.events.filter((candidate) => candidate.kind === 'gh')) {
      expect(entry.args).toContain('https://github.com/AAWWCC/ape/pull/7');
      expect(entry.args.slice(-2)).toEqual(['--repo', 'AAWWCC/ape']);
    }
  });

  it.each([
    ['frozen auto-merge consent', { auto_merge_authorized: false, ship_requested: true }],
    ['the audited SHIP marker', { auto_merge_authorized: true, ship_requested: false }],
  ])('does not reach the resumed merge sink without %s', async (_label, overrides) => {
    const harness = await shippingHarness({
      gh: {
        checks: { exit_code: 0, combined: 'passed\n' },
        view: {
          exit_code: 0,
          combined: `OPEN https://github.com/AAWWCC/ape/pull/7 - ${'c'.repeat(40)}\n`,
        },
      },
    });
    const outcome = await harness.pollRemoteChecksAndMerge(
      '/tmp/ape-public-origin',
      shippingWatchState(overrides),
      config,
    ).then((value) => ({ value, error: null }), (error) => ({ value: null, error }));
    const message = outcome.error?.message ?? outcome.value?.failed ?? '';

    expect(message).toMatch(/auto.?merge|authoriz|SHIP|consent/i);
    expect(harness.events.some((entry) =>
      entry.kind === 'gh' && entry.args[1] === 'merge')).toBe(false);
  });

  it('does not report a merge until public origin/main has the attested tree', async () => {
    const harness = await shippingHarness({
      remoteTree: 'd'.repeat(40),
      gh: {
        checks: { exit_code: 0, combined: 'passed\n' },
        view: {
          exit_code: 0,
          combined: `MERGED https://github.com/AAWWCC/ape/pull/7 2026-09-03T09:00:00Z ${'c'.repeat(40)}\n`,
        },
      },
    });

    const outcome = await harness.pollRemoteChecksAndMerge(
      '/tmp/ape-public-origin',
      shippingWatchState(),
      config,
    ).then((value) => ({ value, error: null }), (error) => ({ value: null, error }));
    const message = outcome.error?.message ?? outcome.value?.failed ?? '';

    expect(outcome.value?.merged).toBeUndefined();
    expect(message).toMatch(/origin\/main|attested tree|tree.*drift|merged.*tree/i);
  });
});
