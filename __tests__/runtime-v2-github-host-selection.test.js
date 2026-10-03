import { EventEmitter } from 'node:events';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { spawn } from 'node:child_process';
import { currentTreeSha, remoteBranchTip, runGit, workingTreeStatus } from '../lib/runtime/git.js';
import { autoMergeGithub } from '../lib/runtime/gates.js';
import * as gatesModule from '../lib/runtime/gates.js';
import { sha256 } from '../lib/runtime/canonical.js';
import { inspectShippingAdmission, resolveFrozenShippingTarget } from '../lib/runtime/shipping-target.js';
import { admittedStartIdentityHash } from '../lib/runtime/admitted-start-identity.js';

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
  vi.unstubAllEnvs();
  await Promise.all(cleanups.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function project(files = []) {
  const dir = await mkdtemp(path.join(tmpdir(), 'ape-automerge-'));
  cleanups.push(dir);
  await mkdir(path.join(dir, '.git'));
  await writeFile(path.join(dir, '.git', 'index'), 'mock-index');
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
const MERGE_SHA = 'e'.repeat(40);
// The run started at 10:00; merged-PR probes compare mergedAt against it.
const RUN_CREATED_AT = '2026-07-09T10:00:00.000Z';

const TARGET = { origin: 'git@github.com:acme/repo.git', repository: 'acme/repo', base: 'main' };
function frozenTarget(requiredRemoteChecks = false, base = 'main') {
  return { version: 1, provider: 'github', ...TARGET, base, required_remote_checks: requiredRemoteChecks };
}
function committedShippingState(state) {
  const manifest = { version: 1, ready: true, shipping_target: structuredClone(state.shipping_target), repository: { base_branch: state.base_branch, base_commit: state.base_commit_sha, ...(state.mode === 'land' ? { branch: state.base_branch, head: HEAD_SHA } : {}) } };
  state.admission = { version: 1, manifest, digest: sha256(manifest) };
  state.start_request_hash = 'a'.repeat(64);
  state.admitted_start_identity_version = 1;
  state.admitted_start_identity_hash = admittedStartIdentityHash(state);
  return state;
}
function stateFor(changedFiles, requiredRemoteChecks = false, base = 'main') {
  return committedShippingState({
    run_id: 'run-1',
    objective: 'Ship the feature',
    mode: 'phase',
    lane: 'fast',
    branch: 'feat/thing',
    auto_merge_authorized: true,
    base_branch: base,
    base_commit_sha: HEAD_SHA,
    shipping_target: frozenTarget(requiredRemoteChecks, base),
    created_at: RUN_CREATED_AT,
    receipts: [{ changed_files: changedFiles }],
    // The tree the passed merge gates attested; shipping must re-verify it.
    gates: { passed: true, tree_sha: GATE_TREE },
  });
}

const config = { shipping: { auto_merge: true, provider: 'github', required_remote_checks: false, target: TARGET } };

// The PR URL the phase-1 handoff persisted; the poll phase re-enters carrying it
// (and the branch) as explicit selectors so no poll-phase gh call relies on the
// current checkout (A1).
const WATCH_PR = 'https://github.com/acme/repo/pull/7';

// A run resting in the non-blocking shipping watch. shipping_watch carries every
// selector the bounded poll needs: BOTH branch and pr_url (A1), the pushed
// feature-branch head_oid (A2), the base, and the phase-1 created_at that bounds
// the checks-registration window.
function watchState(overrides = {}, requiredRemoteChecks = true) {
  return committedShippingState({
    run_id: 'run-1',
    objective: 'Ship the feature',
    mode: 'phase',
    lane: 'fast',
    branch: 'feat/thing',
    auto_merge_authorized: true,
    base_branch: 'main',
    base_commit_sha: HEAD_SHA,
    shipping_target: frozenTarget(requiredRemoteChecks),
    base: 'main',
    created_at: RUN_CREATED_AT,
    receipts: [{ changed_files: ['src/kept.js'] }],
    gates: { passed: true, tree_sha: GATE_TREE },
    shipping_watch: {
      shipping_target: frozenTarget(requiredRemoteChecks),
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
  });
}

// Evaluate CLI targeting independently of any shipping-target helper. Explicit
// host/owner/repo selects the PR repository; an owner/repo selector inherits
// GH_HOST. API endpoints must be concrete and use their own --hostname flag.
function selectedTarget(args, env) {
  const flag = (name) => {
    const index = args.indexOf(name);
    return index < 0 ? undefined : args[index + 1];
  };
  if (args[0] === 'api') {
    const match = /^repos\/([^/]+)\/([^/]+)(?:\/|$)/.exec(args[1]);
    return {
      host: flag('--hostname') ?? env.GH_HOST ?? 'github.com',
      repository: match ? match[1] + '/' + match[2] : null,
      concrete: !/[{}]/.test(args[1]),
      apiRepoFlag: args.includes('--repo'),
    };
  }
  const selector = flag('--repo') ?? env.GH_REPO ?? '';
  const parts = selector.replace(/^https?:\/\//, '').split('/');
  return {
    host: parts.length === 3 ? parts[0] : (env.GH_HOST || 'github.com'),
    repository: parts.slice(-2).join('/'),
  };
}

describe.each([
  ['host override', 'github.evil.example', undefined],
  ['repository override', undefined, 'github.evil.example/other/project'],
  ['both overrides', 'github.evil.example', 'github.evil.example/other/project'],
])('frozen GitHub command target: %s', (_label, hostileHost, hostileRepo) => {
  let violations;
  let targets;
  let gitCalls;
  let gitResponses;
  let ghResponses;
  let ghCalls;
  let ghRouteCalls;
  let observedSuccessfulMerge;
  let observedCreatedPr;

  beforeEach(() => {
    vi.stubEnv('GH_HOST', hostileHost);
    vi.stubEnv('GH_REPO', hostileRepo);
    violations = [];
    targets = [];
    gitCalls = [];
    ghCalls = [];
    observedSuccessfulMerge = null;
    observedCreatedPr = null;
    ghRouteCalls = { view: 0, create: 0, checks: 0, merge: 0, api: 0 };
    ghResponses = {
      // The probe emits `STATE URL MERGED_AT HEAD_OID` (mergedAt is `-` while
      // unmerged). The default is an existing OPEN PR, matching the historical
      // fixtures where `pr view` succeeded.
      view: { code: 0, output: `OPEN https://github.com/acme/repo/pull/7 - ${HEAD_SHA}\n` },
      create: { code: 0, output: 'https://github.com/acme/repo/pull/8\n' },
      checks: { code: 0, output: JSON.stringify([{ name: 'test', bucket: 'pass' }]) },
      merge: { code: 0, output: '' },
      api: { code: 0, output: JSON.stringify([{ type: 'required_status_checks', parameters: { strict_required_status_checks_policy: true, required_status_checks: [{ context: 'test' }] } }]) },
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
      mergeTree: GATE_TREE,
    };
    currentTreeSha.mockReset();
    currentTreeSha.mockResolvedValue(GATE_TREE);
    workingTreeStatus.mockReset();
    workingTreeStatus.mockResolvedValue([]);
    remoteBranchTip.mockReset();
    remoteBranchTip.mockResolvedValue(HEAD_SHA);
    runGit.mockReset();
    runGit.mockImplementation(async (dir, args) => {
      gitCalls.push(args);
      if (args[0] === 'var') return 'Fixture Author <fixture@example.test> 1783591200 +0000';
      if (args[0] === 'config') return 'false';
      if (args[0] === 'ls-remote' && args[1] === '--get-url') return gitResponses.effectiveOrigin ?? args[2];
      if (args[0] === 'remote') return gitResponses.origin ?? 'git@github.com:acme/repo.git';
      if (args[0] === 'for-each-ref') return `${args.at(-1)} ${gitResponses.featureHead ?? HEAD_SHA}`;
      if (args[0] === 'worktree') return '';
      if (args[0] === 'write-tree') return GATE_TREE;
      if (args[0] === 'rev-parse' && args[1] === '--git-path') return path.join(dir, '.git', 'index');
      if (args[0] === 'rev-parse' && args[1] === 'HEAD^{tree}') return GATE_TREE;
      if (args[0] === 'branch' && args[1] === '--show-current') return gitResponses.branch;
      if (args[0] === 'symbolic-ref') return 'refs/remotes/origin/main';
      if (args[0] === 'ls-files') return ghResponses.tracked ?? '';
      if (args[0] === 'rev-parse' && args[1] === 'refs/remotes/origin/main^{tree}') {
        return gitResponses.remoteBaseTree;
      }
      if (args[0] === 'rev-parse' && args[1] === 'refs/remotes/origin/main') return MERGE_SHA;
      if (args[0] === 'rev-parse' && args[1] === `${MERGE_SHA}^{tree}`) return gitResponses.mergeTree;
      if (args[0] === 'rev-parse' && String(args[1]).endsWith('^{tree}')) return GATE_TREE;
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
    spawn.mockImplementation((command, args, options) => {
      if (command === 'git' && args[0] === 'config') {
        const child = new FakeChild();
        setImmediate(() => child.emit('close', 1));
        return child;
      }
      if (command !== 'gh') throw new Error('Unexpected executable: ' + command);
      if (args[0] === '--version') {
        const child = new FakeChild();
        setImmediate(() => { child.stdout.emit('data', 'gh version fixture'); child.emit('close', 0); });
        return child;
      }
      // Inspect the actual child environment after spawnWithTimeout merges it.
      // Check before either simulated create/merge side effect below.
      const selected = selectedTarget(args, options.env);
      const correct = selected.host === 'github.com' && selected.repository === 'acme/repo'
        && (args[0] !== 'api' || (selected.concrete && !selected.apiRepoFlag));
      targets.push({ args: [...args], selected });
      if (!correct) violations.push({ args: [...args], selected });
      if (!correct && ['create', 'merge'].includes(args[1])) {
        const child = new FakeChild();
        setImmediate(() => { child.stderr.emit('data', 'fixture refused wrong-target mutation'); child.emit('close', 93); });
        return child;
      }
      ghCalls.push([command, ...args]);
      const child = new FakeChild();
      const route = args[0] === 'api' ? 'api' : ['view', 'create', 'checks', 'merge'].includes(args[1]) ? args[1] : 'merge';
      const configured = ghResponses[route];
      // An array fixture yields per-call responses (the checks-registration
      // retry needs "no checks yet" then "passed"); the last entry repeats.
      let result = Array.isArray(configured)
        ? configured[Math.min(ghRouteCalls[route], configured.length - 1)]
        : configured;
      if (route === 'create' && result.code === 0) {
        observedCreatedPr = result.output.trim();
        ghResponses.base = args[args.indexOf('--base') + 1];
      }
      if (route === 'view' && observedCreatedPr && args[2] === observedCreatedPr) {
        result = ghResponses.createdPrView ?? {code: 0, output: `OPEN ${observedCreatedPr} - ${HEAD_SHA} -`};
      }
      // Ordinary successful merge fixtures must model GitHub's subsequent
      // MERGED observation, not leave the PR permanently OPEN while returning
      // the future merged tree. Queue/race fixtures explicitly opt out.
      if (route === 'view' && observedSuccessfulMerge && !ghResponses.mergeLeavesOpen) {
        result = { code: 0, output: `MERGED ${observedSuccessfulMerge} 2026-07-09T12:00:00Z ${HEAD_SHA}\n` };
      }
      if (route === 'merge' && result.code === 0 && !args.includes('--auto')) {
        observedSuccessfulMerge = args[2];
      }
      ghRouteCalls[route] += 1;
      setImmediate(() => {
        // Model the immutable mergeCommit.oid supplied by the native gh query.
        // Older scenario declarations omit only this common fixture field.
        const output = result.output?.split('\n').map((line) => {
          const words = line.trim().split(' ');
          if (!['OPEN', 'MERGED', 'CLOSED'].includes(words[0])) return line;
          if (words.length === 4) words.push(words[0] === 'MERGED' ? MERGE_SHA : '-');
          if (words.length === 5 && !ghResponses.omitBase) words.push(ghResponses.base ?? 'main');
          return words.join(' ');
        }).join('\n');
        if (output) child.stdout.emit('data', output);
        child.emit('close', result.code);
      });
      return child;
    });
  });


  const checksConfig = { shipping: { ...config.shipping, required_remote_checks: true } };

  async function checked(action) {
    const result = await action().catch(error => ({ error: error.message }));
    expect(violations, 'command-selected target at process boundary, before mutation').toEqual([]);
    expect(result.error).toBeUndefined();
    expect(targets.length).toBeGreaterThan(0);
    return result;
  }

  it('selects the frozen host before branch lookup, PR creation, immediate merge, and observation', async () => {
    const dir = await project(['src/kept.js']);
    ghResponses.tracked = 'src/kept.js\0';
    ghResponses.view = { code: 1, output: 'no pull requests found\n' };
    const result = await checked(() => autoMergeGithub(dir, stateFor(['src/kept.js']), config));
    expect(result.url).toBe('https://github.com/acme/repo/pull/8');
    expect(observedCreatedPr).toBe(result.url);
    expect(observedSuccessfulMerge).toBe(result.url);
    expect(targets.map(call => call.args[1])).toEqual(['view', 'create', 'view', 'merge', 'view']);
    expect(targets[0].args[2]).toBe('feat/thing');
  });

  it('reuses an existing PR on crash-after-push re-entry without creating another', async () => {
    const dir = await project(['src/kept.js']);
    gitResponses.staged = '';
    ghResponses.tracked = 'src/kept.js\0';
    const state = stateFor(['src/kept.js']);
    const commitment = JSON.stringify({ target: state.shipping_target, admission: state.admission });
    const result = await checked(() => autoMergeGithub(dir, state, config));
    expect(result.url).toBe(WATCH_PR);
    expect(ghRouteCalls.create).toBe(0);
    expect(ghRouteCalls.merge).toBe(1);
    expect(JSON.stringify({ target: state.shipping_target, admission: state.admission })).toBe(commitment);
  });

  it('persists a target-bound handoff and resumes it with a different ambient target', async () => {
    const dir = await project(['src/kept.js']);
    ghResponses.tracked = 'src/kept.js\0';
    ghResponses.view = { code: 1, output: 'no pull requests found\n' };
    const state = stateFor(['src/kept.js'], true);
    const first = await checked(() => autoMergeGithub(dir, state, checksConfig));
    expect(first.watch.shipping_target).toEqual(state.shipping_target);
    expect(ghRouteCalls.merge).toBe(0);
    // JSON round-trip models the persisted cursor; the second process has
    // independent ambient configuration and an unrelated current checkout.
    state.shipping_watch = JSON.parse(JSON.stringify(first.watch));
    vi.stubEnv('GH_HOST', 'second.evil.example');
    vi.stubEnv('GH_REPO', 'second.evil.example/intruder/elsewhere');
    gitResponses.branch = 'main';
    const result = await checked(() => gatesModule.pollRemoteChecksAndMerge(dir, state, checksConfig));
    expect(result.merged.url).toBe(first.watch.pr_url);
    expect(ghRouteCalls.create).toBe(1);
    expect(ghRouteCalls.checks).toBe(1);
    expect(ghRouteCalls.merge).toBe(1);
  });

  it('binds every persisted-watch check, PR read, merge, and post-merge observation', async () => {
    const dir = await project(['src/kept.js']);
    gitResponses.branch = 'main';
    const result = await checked(() => gatesModule.pollRemoteChecksAndMerge(dir, watchState(), checksConfig));
    expect(result.merged.url).toBe(WATCH_PR);
    expect(targets.map(call => call.args[1])).toEqual(['view', 'checks', 'view', 'merge', 'view']);
    for (const call of targets) expect(call.args[2]).toBe(WATCH_PR);
  });

  it.each(['rules', 'classic'])('binds %s protection API reads and the --auto fallback', async (kind) => {
    const dir = await project(['src/kept.js']);
    ghResponses.merge = [{ code: 1, output: 'branch policy prohibits the merge' }, { code: 0, output: '' }];
    if (kind === 'classic') ghResponses.api = [
      { code: 0, output: '[]' },
      { code: 0, output: JSON.stringify({ strict: true, contexts: ['test'], checks: [] }) },
    ];
    const result = await checked(() => gatesModule.pollRemoteChecksAndMerge(dir, watchState(), checksConfig));
    expect(result.pending).toMatchObject({ reason: 'awaiting auto-merge', merge_request_submitted: true });
    const api = targets.filter(call => call.args[0] === 'api');
    expect(api.map(call => call.args[1])).toEqual(kind === 'rules'
      ? ['repos/acme/repo/rules/branches/main']
      : ['repos/acme/repo/rules/branches/main', 'repos/acme/repo/branches/main/protection/required_status_checks']);
    expect(ghCalls.filter(call => call[2] === 'merge')).toHaveLength(2);
    expect(ghCalls.filter(call => call.includes('--auto'))).toHaveLength(1);
  });

  it('binds the reconciliation read after a failed merge command without resubmitting', async () => {
    const dir = await project(['src/kept.js']);
    ghResponses.view = [
      { code: 0, output: 'OPEN ' + WATCH_PR + ' - ' + HEAD_SHA },
      { code: 0, output: 'OPEN ' + WATCH_PR + ' - ' + HEAD_SHA },
      { code: 0, output: 'MERGED ' + WATCH_PR + ' 2026-07-09T12:00:00Z ' + HEAD_SHA },
    ];
    ghResponses.merge = { code: 1, output: 'Pull Request is not mergeable' };
    const result = await checked(() => gatesModule.pollRemoteChecksAndMerge(dir, watchState(), checksConfig));
    expect(result.merged).toMatchObject({ url: WATCH_PR, provenance: 'observed-after-merge-command' });
    expect(ghRouteCalls.merge).toBe(1);
    expect(ghRouteCalls.view).toBe(3);
  });

  it.each(['OPEN', 'MERGED'])('re-enters a submitted merge with a bound %s observation and no second mutation', async (status) => {
    const dir = await project(['src/kept.js']);
    const state = watchState();
    state.shipping_watch.merge_request_submitted = true;
    ghResponses.view = { code: 0, output: status + ' ' + WATCH_PR + ' '
      + (status === 'MERGED' ? '2026-07-09T12:00:00Z' : '-') + ' ' + HEAD_SHA };
    const result = await checked(() => gatesModule.pollRemoteChecksAndMerge(dir, JSON.parse(JSON.stringify(state)), checksConfig));
    if (status === 'MERGED') expect(result.merged.url).toBe(WATCH_PR);
    else expect(result.pending.merge_request_submitted).toBe(true);
    expect(ghRouteCalls.merge).toBe(0);
    expect(ghRouteCalls.create).toBe(0);
    expect(targets.map(call => call.args[1])).toEqual(['view']);
  });

  it('keeps supported historical version-1 commitments byte-stable during merged re-entry', async () => {
    const dir = await project(['src/kept.js']);
    const state = watchState({}, false);
    const before = JSON.stringify(state);
    ghResponses.view = { code: 0, output: 'MERGED ' + WATCH_PR + ' 2026-07-09T12:00:00Z ' + HEAD_SHA };
    const resolved = await resolveFrozenShippingTarget(dir, state, config);
    expect(resolved.repository).toBe('acme/repo');
    const result = await checked(() => autoMergeGithub(dir, state, config));
    expect(result.url).toBe(WATCH_PR);
    expect(JSON.stringify(state)).toBe(before);
    expect(ghRouteCalls.create).toBe(0);
    expect(ghRouteCalls.merge).toBe(0);
    expect(gitCalls.some(args => ['add', 'commit', 'push'].includes(args[0]))).toBe(false);
  });

  it('binds admission repository-access and protection reads without PR effects', async () => {
    const dir = await project();
    ghResponses.api = [
      { code: 0, output: JSON.stringify({ full_name: 'acme/repo', archived: false, disabled: false,
        permissions: { pull: true, push: true }, allow_squash_merge: true }) },
      { code: 0, output: '[]' },
      { code: 0, output: JSON.stringify({ strict: true, contexts: ['test'], checks: [] }) },
    ];
    const result = await checked(() => inspectShippingAdmission(dir, { ship_requested: true }, checksConfig));
    expect(result.ready).toBe(true);
    expect(result.prerequisites.status).toBe('ready');
    expect(targets.map(call => call.args[1])).toEqual([
      'repos/acme/repo', 'repos/acme/repo/rules/branches/main',
      'repos/acme/repo/branches/main/protection/required_status_checks',
    ]);
    expect(ghRouteCalls.create).toBe(0);
    expect(ghRouteCalls.merge).toBe(0);
  });

  it.each([
    ['missing admission', state => { delete state.admission; }],
    ['corrupt admission', state => { state.admission.digest = '0'.repeat(64); }],
    ['unbound legacy target', state => { delete state.shipping_target; }],
    ['unsupported host', state => { state.shipping_target.origin = 'git@enterprise.invalid:acme/repo.git'; }],
    ['missing authority', state => { delete state.auto_merge_authorized; }],
    ['forged watch repository', state => { state.shipping_watch.shipping_target.repository = 'other/repo'; }],
    ['forged watch URL', state => { state.shipping_watch.pr_url = 'https://github.com/other/repo/pull/7'; }],
    ['forged watch base', state => { state.shipping_watch.base = 'other'; }],
  ])('rejects %s before any GitHub command despite ambient overrides', async (_name, corrupt) => {
    const dir = await project();
    const state = watchState();
    corrupt(state);
    await expect(gatesModule.pollRemoteChecksAndMerge(dir, state, checksConfig)).rejects.toThrow();
    expect(targets).toEqual([]);
    expect(observedCreatedPr).toBeNull();
    expect(observedSuccessfulMerge).toBeNull();
  });

  it('rejects remote head drift without submitting a merge', async () => {
    const dir = await project();
    ghResponses.view = { code: 0, output: 'OPEN ' + WATCH_PR + ' - ' + 'd'.repeat(40) };
    const result = await checked(() => gatesModule.pollRemoteChecksAndMerge(dir, watchState(), checksConfig));
    expect(result.failed).toMatch(/head drifted/);
    expect(ghRouteCalls.merge).toBe(0);
  });

  it.each(['origin', 'effectiveOrigin', 'configuration'])('rejects %s drift before a GitHub observation or mutation', async (kind) => {
    const dir = await project();
    const changedConfig = structuredClone(checksConfig);
    if (kind === 'configuration') changedConfig.shipping.target.repository = 'other/repo';
    else gitResponses[kind] = 'git@github.com:other/repo.git';
    await expect(gatesModule.pollRemoteChecksAndMerge(dir, watchState(), changedConfig)).rejects.toThrow();
    expect(targets).toEqual([]);
    expect(observedSuccessfulMerge).toBeNull();
  });

  it.each([
    ['URL', 'https://github.com/other/repo/pull/7', 'main'],
    ['base', WATCH_PR, 'other'],
  ])('rejects a returned PR %s mismatch before merge', async (_kind, url, base) => {
    const dir = await project();
    ghResponses.view = { code: 0, output: 'OPEN ' + url + ' - ' + HEAD_SHA + ' - ' + base };
    const result = await checked(() => gatesModule.pollRemoteChecksAndMerge(dir, watchState(), checksConfig));
    expect(result.failed).toMatch(/does not match the frozen/);
    expect(ghRouteCalls.merge).toBe(0);
    expect(observedSuccessfulMerge).toBeNull();
  });

  it('refuses completion for an observed merge whose tree differs from gate evidence', async () => {
    const dir = await project();
    ghResponses.view = { code: 0, output: 'MERGED ' + WATCH_PR + ' 2026-07-09T12:00:00Z ' + HEAD_SHA };
    gitResponses.mergeTree = 'b'.repeat(40);
    const result = await checked(() => gatesModule.pollRemoteChecksAndMerge(dir, watchState(), checksConfig));
    expect(result.failed).toMatch(/does not equal the attested tree/);
    expect(result.merged).toBeUndefined();
    expect(ghRouteCalls.merge).toBe(0);
  });
});
