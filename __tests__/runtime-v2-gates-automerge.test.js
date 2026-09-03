import { EventEmitter } from 'node:events';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { spawn } from 'node:child_process';
import { currentTreeSha, remoteBranchTip, runGit } from '../lib/runtime/git.js';
import { autoMergeGithub } from '../lib/runtime/gates.js';
// Namespace import so the not-yet-implemented poll export resolves to undefined
// (a red TypeError when called) instead of a module-link error that would
// prevent every pre-existing test in this file from loading.
import * as gatesModule from '../lib/runtime/gates.js';

vi.mock('node:child_process', () => ({ spawn: vi.fn() }));
vi.mock('../lib/runtime/git.js', () => ({
  runGit: vi.fn(),
  currentTreeSha: vi.fn(),
  remoteBranchTip: vi.fn(),
  workingTreeStatus: vi.fn(),
}));

class FakeChild extends EventEmitter {
  constructor() {
    super();
    this.stdout = new EventEmitter();
    this.stdout.setEncoding = () => {};
    this.stderr = new EventEmitter();
    this.stderr.setEncoding = () => {};
  }

  kill() {}
}

const cleanups = [];
afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function project(files = []) {
  const dir = await mkdtemp(path.join(tmpdir(), 'ape-automerge-'));
  cleanups.push(dir);
  for (const file of files) {
    await mkdir(path.dirname(path.join(dir, file)), { recursive: true });
    await writeFile(path.join(dir, file), 'content\n');
  }
  return dir;
}

const GATE_TREE = 'f'.repeat(40);
// The sha `git rev-parse HEAD` answers in the mocked repo; merged-PR probes
// compare it against the PR's headRefOid.
const HEAD_SHA = 'c'.repeat(40);
// The run started at 10:00; merged-PR probes compare mergedAt against it.
const RUN_CREATED_AT = '2026-07-09T10:00:00.000Z';

function stateFor(changedFiles) {
  return {
    run_id: 'run-1',
    objective: 'Ship the feature',
    mode: 'phase',
    lane: 'fast',
    branch: 'feat/thing',
    created_at: RUN_CREATED_AT,
    receipts: [{ changed_files: changedFiles }],
    // The tree the passed merge gates attested; shipping must re-verify it.
    gates: { passed: true, tree_sha: GATE_TREE },
  };
}

const config = { shipping: { provider: 'github', required_remote_checks: false } };

// The PR URL the phase-1 handoff persisted; the poll phase re-enters carrying it
// (and the branch) as explicit selectors so no poll-phase gh call relies on the
// current checkout (A1).
const WATCH_PR = 'https://github.com/acme/repo/pull/7';

// A run resting in the non-blocking shipping watch. shipping_watch carries every
// selector the bounded poll needs: BOTH branch and pr_url (A1), the pushed
// feature-branch head_oid (A2), the base, and the phase-1 created_at that bounds
// the checks-registration window.
function watchState(overrides = {}) {
  return {
    run_id: 'run-1',
    objective: 'Ship the feature',
    mode: 'phase',
    lane: 'fast',
    branch: 'feat/thing',
    base: 'main',
    created_at: RUN_CREATED_AT,
    receipts: [{ changed_files: ['src/kept.js'] }],
    gates: { passed: true, tree_sha: GATE_TREE },
    shipping_watch: {
      provider: 'github',
      pr_url: WATCH_PR,
      branch: 'feat/thing',
      base: 'main',
      head_oid: HEAD_SHA,
      created_at: RUN_CREATED_AT,
      last_poll_at: null,
      poll_count: 0,
      last_checks_summary: null,
    },
    ...overrides,
  };
}

describe('autoMergeGithub', () => {
  let gitCalls;
  let gitResponses;
  let ghResponses;
  let ghCalls;
  let ghRouteCalls;

  beforeEach(() => {
    gitCalls = [];
    ghCalls = [];
    ghRouteCalls = { view: 0, create: 0, checks: 0, merge: 0 };
    ghResponses = {
      // The probe emits `STATE URL MERGED_AT HEAD_OID` (mergedAt is `-` while
      // unmerged). The default is an existing OPEN PR, matching the historical
      // fixtures where `pr view` succeeded.
      view: { code: 0, output: `OPEN https://github.com/acme/repo/pull/7 - ${HEAD_SHA}\n` },
      create: { code: 0, output: 'https://github.com/acme/repo/pull/8\n' },
      checks: { code: 0, output: 'All checks were successful\n' },
      merge: { code: 0, output: '' },
    };
    gitResponses = {
      branch: 'feat/thing',
      head: HEAD_SHA,
      // What `git diff --cached --name-only` reports after the ship `git add`:
      // non-empty on a fresh entry (the run's work is uncommitted), empty on
      // re-entry after a successful commit.
      staged: 'src/kept.js',
      commitErrors: [],
      switchBaseError: null,
      pullBaseError: null,
      remoteBaseTree: GATE_TREE,
    };
    currentTreeSha.mockReset();
    currentTreeSha.mockResolvedValue(GATE_TREE);
    remoteBranchTip.mockReset();
    remoteBranchTip.mockResolvedValue(HEAD_SHA);
    runGit.mockReset();
    runGit.mockImplementation(async (dir, args) => {
      gitCalls.push(args);
      if (args[0] === 'remote') return 'git@github.com:acme/repo.git';
      if (args[0] === 'branch' && args[1] === '--show-current') return gitResponses.branch;
      if (args[0] === 'symbolic-ref') return 'refs/remotes/origin/main';
      if (args[0] === 'ls-files') return ghResponses.tracked ?? '';
      if (args[0] === 'rev-parse' && args[1] === 'refs/remotes/origin/main^{tree}') {
        return gitResponses.remoteBaseTree;
      }
      if (args[0] === 'rev-parse') return gitResponses.head;
      if (args[0] === 'diff') return gitResponses.staged;
      if (args[0] === 'commit' && gitResponses.commitErrors.length > 0) {
        throw new Error(gitResponses.commitErrors.shift());
      }
      if (args[0] === 'switch' && args[1] === 'main' && gitResponses.switchBaseError) {
        throw new Error(gitResponses.switchBaseError);
      }
      if (args[0] === 'pull' && gitResponses.pullBaseError) {
        throw new Error(gitResponses.pullBaseError);
      }
      return '';
    });
    spawn.mockReset();
    spawn.mockImplementation((command, args) => {
      ghCalls.push([command, ...args]);
      const child = new FakeChild();
      const route = ['view', 'create', 'checks', 'merge'].includes(args[1]) ? args[1] : 'merge';
      const configured = ghResponses[route];
      // An array fixture yields per-call responses (the checks-registration
      // retry needs "no checks yet" then "passed"); the last entry repeats.
      const result = Array.isArray(configured)
        ? configured[Math.min(ghRouteCalls[route], configured.length - 1)]
        : configured;
      ghRouteCalls[route] += 1;
      setImmediate(() => {
        if (result.output) child.stdout.emit('data', result.output);
        child.emit('close', result.code);
      });
      return child;
    });
  });

  it('records the PR URL, not the gh JSON blob, when a PR already exists (F38)', async () => {
    const dir = await project(['src/kept.js']);
    ghResponses.tracked = 'src/kept.js\0';
    // Old code asked for `--jq .` and stored the raw JSON object line.
    const result = await autoMergeGithub(dir, stateFor(['src/kept.js']), config);
    expect(result.url).toBe('https://github.com/acme/repo/pull/7');
    const view = ghCalls.find((call) => call[1] === 'pr' && call[2] === 'view');
    // The probe names the branch explicitly (re-entry can run from the base
    // after `gh pr merge --delete-branch` switched the checkout) and asks for
    // the PR state alongside the URL.
    expect(view).toEqual([
      'gh', 'pr', 'view', 'feat/thing',
      '--json', 'url,state,mergedAt,headRefOid',
      '--jq', '[.state, .url, (.mergedAt // "-"), .headRefOid] | join(" ")',
    ]);
    expect(ghCalls.some((call) => call[2] === 'create')).toBe(false);
  });

  it('still extracts the URL when gh interleaves warnings into the output', async () => {
    const dir = await project(['src/kept.js']);
    ghResponses.tracked = 'src/kept.js\0';
    ghResponses.view = {
      code: 0,
      output: `Warning: gh auth token expires soon\nOPEN https://github.com/acme/repo/pull/7 - ${HEAD_SHA}\n`,
    };
    const result = await autoMergeGithub(dir, stateFor(['src/kept.js']), config);
    expect(result.url).toBe('https://github.com/acme/repo/pull/7');
  });

  it('uses the created PR URL when no PR exists', async () => {
    const dir = await project(['src/kept.js']);
    ghResponses.tracked = 'src/kept.js\0';
    ghResponses.view = { code: 1, output: 'no pull requests found for branch "feat/thing"\n' };
    const result = await autoMergeGithub(dir, stateFor(['src/kept.js']), config);
    expect(result.url).toBe('https://github.com/acme/repo/pull/8');
    expect(ghCalls.some((call) => call[2] === 'create')).toBe(true);
  });

  it('filters created-then-deleted untracked paths out of git add (F39)', async () => {
    // ghost.js was created by one stage and deleted by a later one: it is
    // neither tracked nor on disk, so `git add -- ghost.js` would hard-fail.
    const dir = await project(['src/kept.js', 'src/new-untracked.js']);
    ghResponses.tracked = 'src/kept.js\0';
    const state = stateFor(['src/kept.js', 'src/ghost.js', 'src/new-untracked.js']);
    const result = await autoMergeGithub(dir, state, config);
    expect(result.url).toBe('https://github.com/acme/repo/pull/7');
    const add = gitCalls.find((args) => args[0] === 'add');
    expect(add).toEqual(['add', '--', 'src/kept.js', 'src/new-untracked.js']);
  });

  it('keeps a tracked-but-deleted path so its deletion ships', async () => {
    const dir = await project([]);
    ghResponses.tracked = 'src/removed.js\0';
    const result = await autoMergeGithub(dir, stateFor(['src/removed.js']), config);
    expect(result.url).toBe('https://github.com/acme/repo/pull/7');
    const add = gitCalls.find((args) => args[0] === 'add');
    expect(add).toEqual(['add', '--', 'src/removed.js']);
  });

  it('refuses to ship when no changed file is addable', async () => {
    const dir = await project([]);
    ghResponses.tracked = '';
    await expect(autoMergeGithub(dir, stateFor(['src/ghost.js']), config))
      .rejects.toThrow('shipping has no validated changed files');
  });

  it('refuses to ship when the tree changed between gates passing and the merge (F4)', async () => {
    const dir = await project(['src/kept.js']);
    ghResponses.tracked = 'src/kept.js\0';
    // An external write landed after the gates recorded their passed tree.
    currentTreeSha.mockResolvedValue('e'.repeat(40));
    await expect(autoMergeGithub(dir, stateFor(['src/kept.js']), config))
      .rejects.toThrow(/working tree changed after gates passed/);
    // Nothing was staged, committed, or pushed.
    expect(gitCalls.some((args) => ['add', 'commit', 'push'].includes(args[0]))).toBe(false);
  });

  it('refuses to mutate shipping state when the remote base advanced after the run started', async () => {
    const dir = await project(['src/kept.js']);
    ghResponses.tracked = 'src/kept.js\0';
    remoteBranchTip.mockResolvedValue('d'.repeat(40));
    await expect(autoMergeGithub(dir, {
      ...stateFor(['src/kept.js']),
      base_branch: 'main',
      base_commit_sha: HEAD_SHA,
      auto_merge_authorized: true,
    }, config)).rejects.toThrow(/origin\/main advanced.*start a successor run/);
    expect(gitCalls.some((args) => ['add', 'commit', 'push'].includes(args[0]))).toBe(false);
  });

  it('refuses to ship without a recorded passed-gate tree (F4)', async () => {
    const dir = await project(['src/kept.js']);
    ghResponses.tracked = 'src/kept.js\0';
    const state = stateFor(['src/kept.js']);
    delete state.gates;
    await expect(autoMergeGithub(dir, state, config))
      .rejects.toThrow('shipping requires a recorded passed-gate tree');
  });

  // Base derivation: the old `.split('/').at(-1)` truncated slashed default
  // branches and turned an unset origin/HEAD into a raw git error.
  describe('default-base derivation', () => {
    function mockGit({ symbolicRef, presentRefs = [] }) {
      runGit.mockImplementation(async (dir, args) => {
        gitCalls.push(args);
        if (args[0] === 'remote') return 'git@github.com:acme/repo.git';
        if (args[0] === 'branch' && args[1] === '--show-current') return gitResponses.branch;
        if (args[0] === 'symbolic-ref') {
          if (symbolicRef === null) throw new Error('git symbolic-ref refs/remotes/origin/HEAD failed (128): fatal: ref refs/remotes/origin/HEAD is not a symbolic ref');
          return symbolicRef;
        }
        if (args[0] === 'show-ref') {
          if (presentRefs.includes(args.at(-1))) return '';
          throw new Error(`git ${args.join(' ')} failed (1): `);
        }
        if (args[0] === 'ls-files') return ghResponses.tracked ?? '';
        if (args[0] === 'rev-parse') return gitResponses.head;
        if (args[0] === 'diff') return gitResponses.staged;
        return '';
      });
    }

    it('preserves a slashed default branch through PR creation and post-merge cleanup', async () => {
      const dir = await project(['src/kept.js']);
      ghResponses.tracked = 'src/kept.js\0';
      ghResponses.view = { code: 1, output: 'no pull requests found for branch "feat/thing"\n' };
      mockGit({ symbolicRef: 'refs/remotes/origin/release/stable' });
      const result = await autoMergeGithub(dir, stateFor(['src/kept.js']), config);
      expect(result.base).toBe('release/stable');
      const create = ghCalls.find((call) => call[2] === 'create');
      expect(create[create.indexOf('--base') + 1]).toBe('release/stable');
      // The truncated 'stable' would strand the local repo post-merge too.
      expect(gitCalls).toContainEqual(['fetch', 'origin', 'release/stable']);
      expect(gitCalls).toContainEqual([
        'switch',
        '-c',
        'release/stable',
        'refs/remotes/origin/release/stable',
        '--no-track',
      ]);
      expect(gitCalls).toContainEqual(['pull', '--ff-only', 'origin', 'release/stable']);
    });

    it('falls back to origin/main when origin/HEAD is unset', async () => {
      const dir = await project(['src/kept.js']);
      ghResponses.tracked = 'src/kept.js\0';
      mockGit({ symbolicRef: null, presentRefs: ['refs/remotes/origin/main'] });
      const result = await autoMergeGithub(dir, stateFor(['src/kept.js']), config);
      expect(result.base).toBe('main');
    });

    it('falls back to origin/master when only it exists', async () => {
      const dir = await project(['src/kept.js']);
      ghResponses.tracked = 'src/kept.js\0';
      mockGit({ symbolicRef: null, presentRefs: ['refs/remotes/origin/master'] });
      const result = await autoMergeGithub(dir, stateFor(['src/kept.js']), config);
      expect(result.base).toBe('master');
    });

    it('names the remedy when no default branch is determinable, before staging anything', async () => {
      const dir = await project(['src/kept.js']);
      ghResponses.tracked = 'src/kept.js\0';
      mockGit({ symbolicRef: null });
      await expect(autoMergeGithub(dir, stateFor(['src/kept.js']), config))
        .rejects.toThrow(/git remote set-head origin --auto/);
      expect(gitCalls.some((args) => ['add', 'commit', 'push'].includes(args[0]))).toBe(false);
      expect(ghCalls).toEqual([]);
    });
  });

  // Any shipping failure past the commit blocks the run at stage gates, and
  // the runtime's own hinted recovery — REGATE — re-enters autoMergeGithub
  // with some effects already applied. The old flow died at `git commit` on
  // the then-clean tree, burning every bounded re-gate attempt.
  describe('re-entry after a post-commit shipping failure', () => {
    it('commits and pushes on a fresh entry when the work is uncommitted', async () => {
      const dir = await project(['src/kept.js']);
      ghResponses.tracked = 'src/kept.js\0';
      const result = await autoMergeGithub(dir, stateFor(['src/kept.js']), config);
      expect(result.url).toBe('https://github.com/acme/repo/pull/7');
      const commit = gitCalls.find((args) => args[0] === 'commit');
      expect(commit).toEqual(['commit', '-m', 'feat: Ship the feature']);
      expect(gitCalls.some((args) => args[0] === 'push')).toBe(true);
    });

    it('retries an interactive-signing failure as an unsigned automation commit', async () => {
      const dir = await project(['src/kept.js']);
      ghResponses.tracked = 'src/kept.js\0';
      gitResponses.commitErrors.push(
        'Enter passphrase for key /keys/id_ed25519: Load key: incorrect passphrase supplied to decrypt private key; fatal: failed to write commit object',
      );

      const result = await autoMergeGithub(dir, stateFor(['src/kept.js']), config);

      expect(result.url).toBe('https://github.com/acme/repo/pull/7');
      expect(gitCalls.filter((args) => args[0] === 'commit')).toEqual([
        ['commit', '-m', 'feat: Ship the feature'],
        ['commit', '--no-gpg-sign', '-m', 'feat: Ship the feature'],
      ]);
    });

    it('re-entry after the commit skips committing the clean tree and continues shipping', async () => {
      const dir = await project(['src/kept.js']);
      ghResponses.tracked = 'src/kept.js\0';
      // The previous entry already committed: the ship add stages nothing.
      gitResponses.staged = '';
      const result = await autoMergeGithub(dir, stateFor(['src/kept.js']), config);
      expect(result.url).toBe('https://github.com/acme/repo/pull/7');
      expect(gitCalls.some((args) => args[0] === 'commit')).toBe(false);
      // The flow continued past the commit instead of dying on exit 1.
      expect(gitCalls.some((args) => args[0] === 'push')).toBe(true);
      expect(ghCalls.some((call) => call[2] === 'merge')).toBe(true);
    });

    it('re-entry after the push reuses the OPEN PR and merges without creating', async () => {
      const dir = await project(['src/kept.js']);
      ghResponses.tracked = 'src/kept.js\0';
      gitResponses.staged = '';
      const result = await autoMergeGithub(dir, stateFor(['src/kept.js']), config);
      expect(result.url).toBe('https://github.com/acme/repo/pull/7');
      expect(ghCalls.some((call) => call[2] === 'create')).toBe(false);
      expect(ghCalls.some((call) => call[2] === 'merge')).toBe(true);
    });

    it('re-entry after the merge short-circuits to local cleanup without pushing', async () => {
      const dir = await project(['src/kept.js']);
      ghResponses.tracked = 'src/kept.js\0';
      gitResponses.staged = '';
      ghResponses.view = {
        code: 0,
        output: `MERGED https://github.com/acme/repo/pull/7 2026-07-09T12:00:00Z ${HEAD_SHA}\n`,
      };
      const result = await autoMergeGithub(dir, stateFor(['src/kept.js']), config);
      expect(result.url).toBe('https://github.com/acme/repo/pull/7');
      expect(result.merged_at).toBe('2026-07-09T12:00:00Z');
      // The remote branch is gone (--delete-branch): pushing would recreate
      // it, and there is nothing left to commit, create, check, or merge.
      expect(gitCalls.some((args) => ['add', 'commit', 'push'].includes(args[0]))).toBe(false);
      expect(ghCalls.filter((call) => call[1] === 'pr').map((call) => call[2])).toEqual(['view']);
      expect(gitCalls).toContainEqual(['fetch', 'origin', 'main']);
      expect(gitCalls).toContainEqual(['switch', 'main']);
      expect(gitCalls).toContainEqual(['pull', '--ff-only', 'origin', 'main']);
    });

    it('re-entry from the base branch finishes cleanup for the run branch gh already merged and switched away from', async () => {
      const dir = await project(['src/kept.js']);
      ghResponses.tracked = 'src/kept.js\0';
      // gh pr merge --delete-branch switched the checkout to main and deleted
      // feat/thing; the local HEAD is now the squash commit, not the PR head.
      gitResponses.branch = 'main';
      gitResponses.head = 'a'.repeat(40);
      ghResponses.view = {
        code: 0,
        output: `MERGED https://github.com/acme/repo/pull/7 2026-07-09T12:00:00Z ${'d'.repeat(40)}\n`,
      };
      const result = await autoMergeGithub(dir, stateFor(['src/kept.js']), config);
      expect(result.url).toBe('https://github.com/acme/repo/pull/7');
      expect(result.branch).toBe('feat/thing');
      expect(gitCalls.some((args) => args[0] === 'push')).toBe(false);
      expect(gitCalls).toContainEqual(['pull', '--ff-only', 'origin', 'main']);
      expect(gitCalls).toContainEqual(['branch', '-D', 'feat/thing']);
    });

    it('never adopts a stale merged PR from a previous life of a reused branch name', async () => {
      const dir = await project(['src/kept.js']);
      ghResponses.tracked = 'src/kept.js\0';
      // A PR for this branch name merged BEFORE the run started, and its head
      // is not the local HEAD: it cannot be this run's shipped work
      // (invariant 8) — shipping proceeds and a fresh PR is created.
      ghResponses.view = {
        code: 0,
        output: `MERGED https://github.com/acme/repo/pull/5 2026-07-01T00:00:00Z ${'d'.repeat(40)}\n`,
      };
      const result = await autoMergeGithub(dir, stateFor(['src/kept.js']), config);
      expect(result.url).toBe('https://github.com/acme/repo/pull/8');
      expect(gitCalls.some((args) => args[0] === 'commit')).toBe(true);
      expect(ghCalls.some((call) => call[2] === 'create')).toBe(true);
      expect(ghCalls.some((call) => call[2] === 'merge')).toBe(true);
    });

    it('does not reuse a CLOSED PR: a new one is created', async () => {
      const dir = await project(['src/kept.js']);
      ghResponses.tracked = 'src/kept.js\0';
      ghResponses.view = {
        code: 0,
        output: `CLOSED https://github.com/acme/repo/pull/5 - ${'d'.repeat(40)}\n`,
      };
      const result = await autoMergeGithub(dir, stateFor(['src/kept.js']), config);
      expect(result.url).toBe('https://github.com/acme/repo/pull/8');
      expect(ghCalls.some((call) => call[2] === 'create')).toBe(true);
    });

    it('still requires a feature branch when the run branch was never merged', async () => {
      const dir = await project(['src/kept.js']);
      ghResponses.tracked = 'src/kept.js\0';
      // On the base with an OPEN PR for the run branch: committing or pushing
      // from main is forbidden, so the historical fail-closed error stands.
      gitResponses.branch = 'main';
      await expect(autoMergeGithub(dir, stateFor(['src/kept.js']), config))
        .rejects.toThrow('shipping requires a feature branch');
      expect(gitCalls.some((args) => ['add', 'commit', 'push'].includes(args[0]))).toBe(false);
      expect(ghCalls.some((call) => call[2] === 'create')).toBe(false);
    });
  });

  // The synchronous in-call `gh pr checks --watch` loop is gone: with required
  // remote checks, autoMergeGithub now pushes + creates the PR and hands off a
  // NON-BLOCKING watch descriptor, and the bounded remote-checks poll below
  // drives the merge on a later call. required_remote_checks:false keeps the
  // zero-latency in-call merge for no-CI repos (unchanged).
  describe('non-blocking shipping watch handoff (autoMergeGithub)', () => {
    const checksConfig = { shipping: { provider: 'github', required_remote_checks: true } };

    it('returns a watch descriptor after push+create and invokes NO checks or merge', async () => {
      const dir = await project(['src/kept.js']);
      ghResponses.tracked = 'src/kept.js\0';
      ghResponses.view = { code: 1, output: 'no pull requests found for branch "feat/thing"\n' };
      const result = await autoMergeGithub(dir, stateFor(['src/kept.js']), checksConfig);
      // Phase 1 only: no synchronous checks watch and no in-call merge.
      expect(ghCalls.some((call) => call[2] === 'checks')).toBe(false);
      expect(ghCalls.some((call) => call[2] === 'merge')).toBe(false);
      // The run pushed and created the PR before handing off.
      expect(gitCalls.some((args) => args[0] === 'push')).toBe(true);
      expect(ghCalls.some((call) => call[2] === 'create')).toBe(true);
      // The watch descriptor carries every selector the poll phase needs.
      expect(result.watch).toBeDefined();
      expect(result.watch).toMatchObject({
        provider: 'github',
        pr_url: 'https://github.com/acme/repo/pull/8',
        branch: 'feat/thing',
        base: 'main',
        // A2: the pushed feature-branch commit sha, so a MERGED probe can prove
        // idempotent completion vs an external head drift.
        head_oid: HEAD_SHA,
      });
      expect(typeof result.watch.created_at).toBe('string');
      // No in-call merge shape leaked onto the handoff return.
      expect(result.merged_at).toBeUndefined();
    });

    it('with required_remote_checks:false still merges in-call and returns the merge shape (no watch)', async () => {
      const dir = await project(['src/kept.js']);
      ghResponses.tracked = 'src/kept.js\0';
      const result = await autoMergeGithub(dir, stateFor(['src/kept.js']), config);
      expect(result.watch).toBeUndefined();
      expect(result.url).toBe('https://github.com/acme/repo/pull/7');
      expect(ghCalls.some((call) => call[2] === 'merge')).toBe(true);
    });
  });

  // The bounded, resumable poll that replaces the in-call watch loop: ONE
  // non-watch `gh pr checks`, a head-guarded re-probe, then the runtime merge —
  // every gh call carrying a selector persisted in shipping_watch (A1).
  describe('poll-phase remote checks and merge (pollRemoteChecksAndMerge)', () => {
    const checksConfig = { shipping: { provider: 'github', required_remote_checks: true } };
    const carriesSelector = (call) => call.includes('feat/thing') || call.includes(WATCH_PR);

    it('polls checks exactly once WITHOUT --watch and WITH the persisted selector, then merges WITH the selector and cleans up (A1)', async () => {
      const dir = await project(['src/kept.js']);
      ghResponses.tracked = 'src/kept.js\0';
      ghResponses.checks = { code: 0, output: 'All checks were successful\n' };
      ghResponses.view = { code: 0, output: `OPEN ${WATCH_PR} - ${HEAD_SHA}\n` };
      const result = await gatesModule.pollRemoteChecksAndMerge(dir, watchState(), checksConfig);
      expect(result.merged).toBeDefined();
      const checksCalls = ghCalls.filter((call) => call[2] === 'checks');
      expect(checksCalls).toHaveLength(1);
      expect(checksCalls[0]).not.toContain('--watch');
      expect(carriesSelector(checksCalls[0])).toBe(true);
      const mergeCall = ghCalls.find((call) => call[2] === 'merge');
      expect(mergeCall).toBeDefined();
      expect(carriesSelector(mergeCall)).toBe(true);
      // Post-merge local cleanup ran against the persisted base.
      expect(gitCalls).toContainEqual(['switch', 'main']);
    });

    it('reports the proven remote merge even when another worktree owns the local base branch', async () => {
      const dir = await project(['src/kept.js']);
      ghResponses.tracked = 'src/kept.js\0';
      ghResponses.checks = { code: 0, output: 'All checks were successful\n' };
      ghResponses.view = { code: 0, output: `OPEN ${WATCH_PR} - ${HEAD_SHA}\n` };
      gitResponses.switchBaseError = "fatal: 'main' is already used by worktree at '/tmp/other-worktree'";

      const result = await gatesModule.pollRemoteChecksAndMerge(dir, watchState(), checksConfig);

      expect(result.merged).toBeDefined();
      expect(result.failed).toBeUndefined();
      expect(gitCalls).toContainEqual(['switch', 'main']);
      expect(gitCalls).not.toContainEqual(['pull', '--ff-only', 'origin', 'main']);
    });

    it('enables GitHub auto-merge when branch policy rejects an immediate green merge', async () => {
      const dir = await project(['src/kept.js']);
      ghResponses.tracked = 'src/kept.js\0';
      ghResponses.checks = { code: 0, output: 'All checks were successful\n' };
      ghResponses.view = { code: 0, output: `OPEN ${WATCH_PR} - ${HEAD_SHA}\n` };
      ghResponses.merge = [
        {
          code: 1,
          output: 'GraphQL: Base branch policy prohibits the merge. To have the pull request merged after all the requirements have been met, add the `--auto` flag.\n',
        },
        { code: 0, output: '' },
      ];

      const result = await gatesModule.pollRemoteChecksAndMerge(dir, watchState(), checksConfig);

      expect(result.pending).toMatchObject({ reason: 'awaiting auto-merge' });
      expect(result.merged).toBeUndefined();
      const mergeCalls = ghCalls.filter((call) => call[2] === 'merge');
      expect(mergeCalls).toHaveLength(2);
      expect(mergeCalls[1]).toContain('--auto');
      expect(gitCalls).not.toContainEqual(['switch', 'main']);
    });

    it('reconciles a merge-command race when GitHub merged the exact pushed head before reporting not mergeable', async () => {
      const dir = await project(['src/kept.js']);
      ghResponses.tracked = 'src/kept.js\0';
      ghResponses.checks = { code: 0, output: 'All checks were successful\n' };
      ghResponses.view = [
        { code: 0, output: `OPEN ${WATCH_PR} - ${HEAD_SHA}\n` },
        { code: 0, output: `MERGED ${WATCH_PR} 2026-07-09T12:00:00Z ${HEAD_SHA}\n` },
      ];
      ghResponses.merge = {
        code: 1,
        output: 'GraphQL: Pull Request is not mergeable (mergePullRequest)\n',
      };

      const result = await gatesModule.pollRemoteChecksAndMerge(dir, watchState(), checksConfig);

      expect(result.failed).toBeUndefined();
      expect(result.pending).toBeUndefined();
      expect(result.merged).toMatchObject({
        url: WATCH_PR,
        branch: 'feat/thing',
        base: 'main',
        merged_at: '2026-07-09T12:00:00Z',
        provenance: 'observed-after-merge-command',
      });
      expect(ghCalls.filter((call) => call[2] === 'view')).toHaveLength(2);
      expect(ghCalls.filter((call) => call[2] === 'merge')).toHaveLength(1);
      expect(gitCalls).toContainEqual(['switch', 'main']);
    });

    it('does not reconcile a merge-command race when GitHub merged a different head', async () => {
      const dir = await project(['src/kept.js']);
      const driftedHead = 'd'.repeat(40);
      ghResponses.tracked = 'src/kept.js\0';
      ghResponses.checks = { code: 0, output: 'All checks were successful\n' };
      ghResponses.view = [
        { code: 0, output: `OPEN ${WATCH_PR} - ${HEAD_SHA}\n` },
        { code: 0, output: `MERGED ${WATCH_PR} 2026-07-09T12:00:00Z ${driftedHead}\n` },
      ];
      ghResponses.merge = {
        code: 1,
        output: 'GraphQL: Pull Request is not mergeable (mergePullRequest)\n',
      };

      const result = await gatesModule.pollRemoteChecksAndMerge(dir, watchState(), checksConfig);

      expect(result.merged).toBeUndefined();
      expect(result.pending).toBeUndefined();
      expect(result.failed).toMatch(/drifted head.*not the pushed commit/);
      expect(gitCalls).not.toContainEqual(['switch', 'main']);
    });

    it('an already-MERGED probe at the pushed head completes idempotently with observed/external provenance and never re-merges (A2)', async () => {
      const dir = await project(['src/kept.js']);
      ghResponses.tracked = 'src/kept.js\0';
      ghResponses.checks = { code: 0, output: 'All checks were successful\n' };
      ghResponses.view = { code: 0, output: `MERGED ${WATCH_PR} 2026-07-09T12:00:00Z ${HEAD_SHA}\n` };
      const result = await gatesModule.pollRemoteChecksAndMerge(dir, watchState(), checksConfig);
      expect(result.merged).toBeDefined();
      // Provably probe-observed, not runtime-performed: no gh pr merge issued.
      expect(ghCalls.some((call) => call[2] === 'merge')).toBe(false);
      // Explicit provenance marker distinguishes an externally-observed merge.
      expect(JSON.stringify(result.merged)).toMatch(/observ|external/i);
    });

    it('aligns a tree-identical divergent land base to the observed squash commit after ff-only cleanup cannot apply', async () => {
      const dir = await project(['src/kept.js']);
      ghResponses.tracked = 'src/kept.js\0';
      ghResponses.checks = { code: 0, output: 'All checks were successful\n' };
      ghResponses.view = { code: 0, output: `MERGED ${WATCH_PR} 2026-07-09T12:00:00Z ${HEAD_SHA}\n` };
      gitResponses.branch = 'main';
      gitResponses.pullBaseError = 'fatal: Not possible to fast-forward, aborting.';
      currentTreeSha.mockResolvedValue(GATE_TREE);

      const result = await gatesModule.pollRemoteChecksAndMerge(dir, watchState({ mode: 'land' }), checksConfig);

      expect(result.merged).toBeDefined();
      expect(gitCalls).toContainEqual(['pull', '--ff-only', 'origin', 'main']);
      expect(gitCalls).toContainEqual(['rev-parse', 'refs/remotes/origin/main^{tree}']);
      expect(gitCalls).toContainEqual(['reset', '--hard', 'refs/remotes/origin/main']);
    });

    it('never rewrites a divergent base when its checkout tree differs from the observed squash tree', async () => {
      const dir = await project(['src/kept.js']);
      ghResponses.tracked = 'src/kept.js\0';
      ghResponses.checks = { code: 0, output: 'All checks were successful\n' };
      ghResponses.view = { code: 0, output: `MERGED ${WATCH_PR} 2026-07-09T12:00:00Z ${HEAD_SHA}\n` };
      gitResponses.branch = 'main';
      gitResponses.pullBaseError = 'fatal: Not possible to fast-forward, aborting.';
      currentTreeSha.mockResolvedValue('e'.repeat(40));

      const result = await gatesModule.pollRemoteChecksAndMerge(dir, watchState({ mode: 'land' }), checksConfig);

      expect(result.merged).toBeDefined();
      expect(gitCalls).not.toContainEqual(['reset', '--hard', 'refs/remotes/origin/main']);
    });

    it('refuses a drifted-head MERGED probe as an external-merge/head-drift block, never a completion (A2)', async () => {
      const dir = await project(['src/kept.js']);
      ghResponses.tracked = 'src/kept.js\0';
      ghResponses.checks = { code: 0, output: 'All checks were successful\n' };
      ghResponses.view = { code: 0, output: `MERGED ${WATCH_PR} 2026-07-09T12:00:00Z ${'d'.repeat(40)}\n` };
      const result = await gatesModule.pollRemoteChecksAndMerge(dir, watchState(), checksConfig);
      expect(result.merged).toBeUndefined();
      expect(result.pending).toBeUndefined();
      expect(result.failed).toBeDefined();
      expect(String(result.failed)).toMatch(/drift|external/i);
      expect(ghCalls.some((call) => call[2] === 'merge')).toBe(false);
    });

    it('refuses a CLOSED (human-closed) probe as an honest block, never pending-forever (A4)', async () => {
      const dir = await project(['src/kept.js']);
      ghResponses.tracked = 'src/kept.js\0';
      ghResponses.checks = { code: 0, output: 'All checks were successful\n' };
      ghResponses.view = { code: 0, output: `CLOSED ${WATCH_PR} - ${'d'.repeat(40)}\n` };
      const result = await gatesModule.pollRemoteChecksAndMerge(dir, watchState(), checksConfig);
      expect(result.merged).toBeUndefined();
      expect(result.pending).toBeUndefined();
      expect(result.failed).toBeDefined();
      expect(String(result.failed)).toMatch(/close/i);
      expect(ghCalls.some((call) => call[2] === 'merge')).toBe(false);
    });

    it('inside the registration window, a not-yet-registered checks poll returns pending (single non-watch probe, no merge)', async () => {
      const dir = await project(['src/kept.js']);
      ghResponses.tracked = 'src/kept.js\0';
      ghResponses.view = { code: 0, output: `OPEN ${WATCH_PR} - ${HEAD_SHA}\n` };
      ghResponses.checks = { code: 1, output: "no checks reported on the 'feat/thing' branch\n" };
      const fresh = watchState();
      // created_at "just now" → still inside CHECKS_REGISTRATION_WINDOW_MS.
      fresh.shipping_watch.created_at = new Date().toISOString();
      const result = await gatesModule.pollRemoteChecksAndMerge(dir, fresh, checksConfig);
      expect(result.pending).toBeDefined();
      expect(result.merged).toBeUndefined();
      expect(result.failed).toBeUndefined();
      const checksCalls = ghCalls.filter((call) => call[2] === 'checks');
      expect(checksCalls).toHaveLength(1);
      expect(checksCalls[0]).not.toContain('--watch');
      expect(ghCalls.some((call) => call[2] === 'merge')).toBe(false);
    });

    it('past the registration window, a still-empty checks poll fails closed naming the config key', async () => {
      const dir = await project(['src/kept.js']);
      ghResponses.tracked = 'src/kept.js\0';
      ghResponses.view = { code: 0, output: `OPEN ${WATCH_PR} - ${HEAD_SHA}\n` };
      ghResponses.checks = { code: 1, output: "no checks reported on the 'feat/thing' branch\n" };
      // watchState()'s created_at is days in the past → past the window.
      const result = await gatesModule.pollRemoteChecksAndMerge(dir, watchState(), checksConfig);
      expect(result.failed).toBeDefined();
      expect(String(result.failed)).toMatch(/shipping\.required_remote_checks=false/);
      expect(result.merged).toBeUndefined();
      expect(result.pending).toBeUndefined();
      expect(ghCalls.some((call) => call[2] === 'merge')).toBe(false);
    });

    it('a genuinely failing check returns a failed descriptor with the real tail, no retry and no merge', async () => {
      const dir = await project(['src/kept.js']);
      ghResponses.tracked = 'src/kept.js\0';
      ghResponses.view = { code: 0, output: `OPEN ${WATCH_PR} - ${HEAD_SHA}\n` };
      ghResponses.checks = { code: 1, output: 'X  lint  1m2s  https://github.com/acme/repo/runs/1\n' };
      const result = await gatesModule.pollRemoteChecksAndMerge(dir, watchState(), checksConfig);
      expect(result.failed).toBeDefined();
      expect(String(result.failed)).toMatch(/lint/);
      expect(ghCalls.filter((call) => call[2] === 'checks')).toHaveLength(1);
      expect(ghCalls.some((call) => call[2] === 'merge')).toBe(false);
    });
  });

  // Friction #12: the old blind slice(0, 72) shipped mid-word commit subjects
  // and PR titles for any objective longer than ~65 chars.
  describe('commit-subject and PR-title truncation', () => {
    const LONG_OBJECTIVE = 'Add a runtime-owned re-gate recovery operation covering blocked runs everywhere';
    const ONE_WORD = 'x'.repeat(90);

    function longState(objective) {
      const state = stateFor(['src/kept.js']);
      state.objective = objective;
      return state;
    }

    it('truncates the commit subject and PR title at a word boundary with an ellipsis', async () => {
      const dir = await project(['src/kept.js']);
      ghResponses.tracked = 'src/kept.js\0';
      ghResponses.view = { code: 1, output: 'no pull requests found for branch "feat/thing"\n' };
      await autoMergeGithub(dir, longState(LONG_OBJECTIVE), config);
      const subject = gitCalls.find((args) => args[0] === 'commit')[2];
      expect(subject.length).toBeLessThanOrEqual(72);
      expect(subject.endsWith('…')).toBe(true);
      // Word boundary: everything kept is a prefix of the full subject and
      // the very next character was the space the cut removed — no mid-word
      // slicing.
      const fullSubject = `feat: ${LONG_OBJECTIVE}`;
      expect(fullSubject.startsWith(subject.slice(0, -1))).toBe(true);
      expect(fullSubject[subject.length - 1]).toBe(' ');
      const create = ghCalls.find((call) => call[2] === 'create');
      const title = create[create.indexOf('--title') + 1];
      expect(title.length).toBeLessThanOrEqual(72);
      expect(title.endsWith('…')).toBe(true);
      expect(LONG_OBJECTIVE.startsWith(title.slice(0, -1))).toBe(true);
      expect(LONG_OBJECTIVE[title.length - 1]).toBe(' ');
    });

    it('leaves short objectives untouched', async () => {
      const dir = await project(['src/kept.js']);
      ghResponses.tracked = 'src/kept.js\0';
      ghResponses.view = { code: 1, output: 'no pull requests found for branch "feat/thing"\n' };
      await autoMergeGithub(dir, stateFor(['src/kept.js']), config);
      expect(gitCalls.find((args) => args[0] === 'commit')[2]).toBe('feat: Ship the feature');
      const create = ghCalls.find((call) => call[2] === 'create');
      expect(create[create.indexOf('--title') + 1]).toBe('Ship the feature');
    });

    it('falls back to a bounded hard cut for a single overlong word', async () => {
      const dir = await project(['src/kept.js']);
      ghResponses.tracked = 'src/kept.js\0';
      ghResponses.view = { code: 1, output: 'no pull requests found for branch "feat/thing"\n' };
      await autoMergeGithub(dir, longState(ONE_WORD), config);
      const subject = gitCalls.find((args) => args[0] === 'commit')[2];
      expect(subject).toBe(`feat: ${'x'.repeat(65)}…`);
      expect(subject.length).toBe(72);
      const create = ghCalls.find((call) => call[2] === 'create');
      expect(create[create.indexOf('--title') + 1]).toBe(`${'x'.repeat(71)}…`);
    });
  });

  // Session-3 nit (1): the phase-1 MERGED re-entry arm must adopt a merged PR
  // only when it PROVES this run's shipped work. When phase 1 persisted a
  // pushed-head attestation (state.shipping_watch.head_oid), that proof is an
  // EXACT head match — the same A2 rule the poll phase enforces — and the looser
  // time-based mergedDuringRun OR-arm must no longer adopt a drifted merged head.
  // The mergedDuringRun arm survives only for re-entries with NO persisted watch.
  describe('phase-1 MERGED re-entry honors a persisted pushed-head attestation (A2)', () => {
    it('does NOT adopt a MERGED probe whose head drifts from the persisted pushed head, even when it merged during the run', async () => {
      const dir = await project(['src/kept.js']);
      ghResponses.tracked = 'src/kept.js\0';
      // Merged AFTER the run started (mergedDuringRun would be true under the old
      // OR-arm) but at a DIFFERENT head than the persisted shipping_watch.head_oid
      // — someone else's merge over unrelated commits. With a pushed-head
      // attestation present, exact match is required, so this is not adopted
      // (invariant 8): shipping proceeds to a fresh PR for the run's real work.
      ghResponses.view = {
        code: 0,
        output: `MERGED ${WATCH_PR} 2026-07-09T12:00:00Z ${'d'.repeat(40)}\n`,
      };
      // Re-entry after the push: the work is already committed, so the ship add
      // stages nothing.
      gitResponses.staged = '';
      const result = await autoMergeGithub(dir, watchState(), config);
      expect(result.url).toBe('https://github.com/acme/repo/pull/8');
      expect(ghCalls.some((call) => call[2] === 'create')).toBe(true);
      expect(ghCalls.some((call) => call[2] === 'merge')).toBe(true);
    });

    it('adopts a MERGED probe at EXACTLY the persisted pushed head, completing idempotently without creating or merging', async () => {
      const dir = await project(['src/kept.js']);
      ghResponses.tracked = 'src/kept.js\0';
      ghResponses.view = {
        code: 0,
        output: `MERGED ${WATCH_PR} 2026-07-09T12:00:00Z ${HEAD_SHA}\n`,
      };
      gitResponses.staged = '';
      const result = await autoMergeGithub(dir, watchState(), config);
      expect(result.url).toBe(WATCH_PR);
      expect(result.merged_at).toBe('2026-07-09T12:00:00Z');
      expect(ghCalls.some((call) => call[2] === 'create')).toBe(false);
      expect(ghCalls.some((call) => call[2] === 'merge')).toBe(false);
      expect(gitCalls.some((args) => ['add', 'commit', 'push'].includes(args[0]))).toBe(false);
    });
  });

  // Session-3 nit (2): boundedTail whitespace-flattens and bounds the gh tails
  // that reach wire responses, the statusline, and status.md — but it left
  // ANSI/C0/DEL terminal escapes in place. gh colorizes failing check rows, so a
  // failure tail must arrive free of terminal escapes while keeping its
  // human-readable text.
  describe('failure tails reach the wire free of terminal escapes (boundedTail)', () => {
    const checksConfig = { shipping: { provider: 'github', required_remote_checks: true } };

    it('strips ANSI/control escapes from a failing-check descriptor while preserving the visible cause', async () => {
      const dir = await project(['src/kept.js']);
      ghResponses.tracked = 'src/kept.js\0';
      ghResponses.view = { code: 0, output: `OPEN ${WATCH_PR} - ${HEAD_SHA}\n` };
      // A colorized failing row: CSI colour codes, a BEL, and a DEL byte.
      ghResponses.checks = {
        code: 1,
        output: '\x1b[31mX\x1b[0m  lint  \x1b[1m1m2s\x1b[0m  https://github.com/acme/repo/runs/1\x07\x7f\n',
      };
      const result = await gatesModule.pollRemoteChecksAndMerge(dir, watchState(), checksConfig);
      expect(result.failed).toBeDefined();
      // The real, human-readable cause survives the sanitization.
      expect(String(result.failed)).toMatch(/lint/);
      // No ESC (so no ANSI escape), no other C0 control byte, and no DEL reaches
      // the wire tail — only printable text and ordinary spaces survive.
      const controlBytes = [...String(result.failed)].filter((ch) => {
        const code = ch.charCodeAt(0);
        return code < 0x20 || code === 0x7f;
      });
      expect(controlBytes).toEqual([]);
    });
  });
});
