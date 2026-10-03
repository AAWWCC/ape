import { EventEmitter } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runGit, remoteBranchTip } from '../lib/runtime/git.js';
import { pollRemoteChecksAndMerge } from '../lib/runtime/github-shipping.js';
import { sha256 } from '../lib/runtime/canonical.js';
import { admittedStartIdentityHash } from '../lib/runtime/admitted-start-identity.js';

vi.mock('node:child_process', () => ({ spawn: vi.fn() }));
vi.mock('../lib/runtime/git.js', () => ({
  runGit: vi.fn(), remoteBranchTip: vi.fn(), currentTreeSha: vi.fn(), workingTreeStatus: vi.fn(),
}));

const BASE = 'a'.repeat(40);
const HEAD = 'b'.repeat(40);
const MERGE = 'c'.repeat(40);
const LATER = 'd'.repeat(40);
const TREE = 'e'.repeat(40);
const URL = 'https://github.com/acme/repo/pull/7';
const NOW = Date.parse('2026-09-01T12:00:00Z');
const target = { version: 1, provider: 'github', origin: 'https://github.com/acme/repo.git', repository: 'acme/repo', base: 'main', required_remote_checks: true };
const config = { shipping: { provider: 'github', auto_merge: true, required_remote_checks: true, target, checks_registration_window_ms: 60_000 } };
const outcomes = [
  { name: 'passing', code: 0, output: 'build pass' },
  { name: 'failed', code: 1, output: 'build fail' },
  { name: 'pending', code: 8, output: 'build pending' },
  { name: 'missing inside window', code: 1, output: 'no checks reported', age: 1_000 },
  { name: 'missing outside window', code: 1, output: 'no checks reported', age: 120_000 },
  { name: 'authentication error', code: 4, output: 'authentication required' },
  { name: 'unavailable', code: 2, output: 'GitHub service unavailable' },
  { name: 'spawn error', error: 'spawn gh EAGAIN' },
];

function stateFor(submitted, outcome = outcomes[0]) {
  const state = {
    run_id: 'terminal-fixture', objective: 'Ship tested bytes', mode: 'phase', lane: 'fast',
    branch: 'feature/tested', auto_merge_authorized: true, base_branch: 'main', base_commit_sha: BASE,
    created_at: '2026-09-01T10:00:00Z', shipping_target: structuredClone(target),
    gates: { passed: true, tree_sha: TREE }, receipts: [],
    shipping_watch: {
      provider: 'github', shipping_target: structuredClone(target), pr_url: URL,
      branch: 'feature/tested', base: 'main', head_oid: HEAD,
      created_at: new Date(NOW - (outcome.age ?? 120_000)).toISOString(),
      poll_count: 3, last_poll_at: null, last_checks_summary: null,
      merge_request_submitted: submitted,
    },
  };
  const manifest = { version: 1, ready: true, shipping_target: structuredClone(target), repository: { base_branch: 'main', base_commit: BASE } };
  state.admission = { version: 1, manifest, digest: sha256(manifest) };
  state.start_request_hash = 'a'.repeat(64);
  state.admitted_start_identity_version = 1;
  state.admitted_start_identity_hash = admittedStartIdentityHash(state);
  return state;
}

class Child extends EventEmitter {
  constructor() {
    super();
    this.stdout = new EventEmitter();
    this.stderr = new EventEmitter();
    this.stdout.setEncoding = this.stderr.setEncoding = () => {};
  }
  kill() {}
}

let dir, fixture, ghCalls, gitCalls;
const prLine = (state = 'MERGED', overrides = {}) => {
  const pr = { state, url: URL, at: state === 'MERGED' ? '2026-09-01T11:00:00Z' : '-', head: HEAD, merge: state === 'MERGED' ? MERGE : '-', base: 'main', ...overrides };
  return `${pr.state} ${pr.url} ${pr.at} ${pr.head} ${pr.merge} ${pr.base}`;
};

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'ape-terminal-fixture-'));
  vi.spyOn(Date, 'now').mockReturnValue(NOW);
  vi.stubEnv('GH_HOST', 'hostile.example');
  vi.stubEnv('GH_REPO', 'hostile.example/other/repository');
  fixture = { checks: outcomes[0], view: { code: 0, output: prLine() }, merge: { code: 0, output: '' }, featureHead: HEAD };
  ghCalls = [];
  gitCalls = [];
  remoteBranchTip.mockReset().mockResolvedValue(BASE);
  // Synthetic Git history: BASE -> MERGE -> LATER. Only MERGE has the
  // attested tree. The current checkout is unrelated to the persisted watch.
  runGit.mockReset().mockImplementation(async (_cwd, args) => {
    gitCalls.push([...args]);
    if (args[0] === 'remote') return fixture.origin ?? target.origin;
    if (args[0] === 'ls-remote' && args[1] === '--get-url') return args[2];
    if (args[0] === 'merge-base') {
      const edge = args.slice(2).join(' ');
      if (edge === `${BASE} ${MERGE}` && !fixture.outsideAdmission) return '';
      if (edge === `${MERGE} refs/remotes/origin/main` && !fixture.outsideFetchedBase) return '';
      throw new Error('not an ancestor');
    }
    if (args[0] === 'rev-parse') {
      if (args[1] === `${MERGE}^{tree}`) return fixture.mergeTree ?? TREE;
      if (args[1] === 'refs/remotes/origin/main') return LATER;
      if (args[1] === 'refs/remotes/origin/main^{tree}') return 'f'.repeat(40);
      throw new Error(`Unexpected rev-parse: ${args.join(' ')}`);
    }
    if (args[0] === 'branch') return 'unrelated/checkout';
    if (args[0] === 'for-each-ref') return `refs/heads/feature/tested ${fixture.featureHead}`;
    if (args[0] === 'worktree') return '';
    if (args[0] === 'update-ref' && fixture.concurrentWriter) throw new Error('cannot lock ref: concurrent writer changed expected old OID');
    if (['fetch', 'switch', 'pull', 'check-ref-format', 'show-ref', 'update-ref'].includes(args[0])) return '';
    throw new Error(`Unexpected Git command: ${args.join(' ')}`);
  });
  spawn.mockReset().mockImplementation((command, args, options) => {
    const child = new Child();
    let response;
    if (command === 'git' && args[0] === 'config') response = { code: 1, output: '' };
    else {
      expect(command).toBe('gh');
      expect(options.shell).toBe(false);
      expect(options.cwd).toBe(dir);
      expect(args[args.indexOf('--repo') + 1]).toBe('github.com/acme/repo');
      expect(args[2]).toBe(URL);
      expect(args).not.toContain('--watch');
      expect(args).not.toContain('--delete-branch');
      ghCalls.push([...args]);
      const route = args[1];
      const configured = fixture[route];
      if (!configured) throw new Error(`Unexpected GitHub route: ${route}`);
      response = typeof configured === 'function' ? configured() : configured;
      if (route === 'checks') fixture.afterChecks?.();
    }
    setImmediate(() => {
      if (response.error) child.emit('error', new Error(response.error));
      else {
        if (response.output) child.stdout.emit('data', response.output);
        child.emit('close', response.code);
      }
    });
    return child;
  });
});

afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  await rm(dir, { recursive: true, force: true });
});

function noSubmission() {
  expect(ghCalls.filter(args => ['merge', 'create'].includes(args[1]))).toEqual([]);
}
function noCleanup() {
  expect(gitCalls.filter(args => ['switch', 'pull', 'update-ref'].includes(args[0]))).toEqual([]);
}
const resume = state => JSON.parse(JSON.stringify(state));
const poll = state => pollRemoteChecksAndMerge(dir, state, config);

describe.each([false, true])('terminal shipping with submitted=%s', submitted => {
  for (const terminal of ['MERGED', 'CLOSED']) {
    for (const persisted of [false, true]) {
      it.each(outcomes)(`${terminal}, JSON-resumed=${persisted}, checks=$name`, async outcome => {
        fixture.checks = outcome;
        fixture.view = { code: 0, output: prLine(terminal) };
        let state = stateFor(submitted, outcome);
        if (persisted) state = resume(state);
        const commitment = JSON.stringify({ target: state.shipping_target, admission: state.admission });
        const result = await poll(state);
        noSubmission();
        expect(ghCalls.some(args => args[1] === 'view')).toBe(true);
        expect(JSON.stringify({ target: state.shipping_target, admission: state.admission })).toBe(commitment);
        if (terminal === 'MERGED') {
          expect(result.merged).toMatchObject({ url: URL, head_oid: HEAD, base: 'main', provenance: submitted ? 'observed-after-merge-command' : 'observed-external', cleanup: { cleaned: true } });
          expect(gitCalls).toContainEqual(['merge-base', '--is-ancestor', BASE, MERGE]);
          expect(gitCalls).toContainEqual(['merge-base', '--is-ancestor', MERGE, 'refs/remotes/origin/main']);
          expect(gitCalls).toContainEqual(['rev-parse', `${MERGE}^{tree}`]);
          expect(gitCalls).toContainEqual(['update-ref', '--no-deref', '-d', 'refs/heads/feature/tested', HEAD]);
        } else {
          expect(result.failed).toMatch(/closed without merging/i);
          expect(result.failed).toMatch(/regate|new run|recover/i);
          expect(result.merged).toBeUndefined();
          noCleanup();
        }
      });
    }
  }

  it.each([
    ['wrong repository', () => { fixture.view.output = prLine('MERGED', { url: 'https://github.com/other/repo/pull/7' }); }],
    ['wrong URL', () => { fixture.view.output = prLine('MERGED', { url: URL.replace('/7', '/8') }); }],
    ['wrong base', () => { fixture.view.output = prLine('MERGED', { base: 'release' }); }],
    ['wrong head', () => { fixture.view.output = prLine('MERGED', { head: LATER }); }],
    ['missing merge OID', () => { fixture.view.output = prLine('MERGED', { merge: '-' }); }],
    ['malformed merge OID', () => { fixture.view.output = prLine('MERGED', { merge: 'not-an-oid' }); }],
    ['missing gate attestation', state => { state.gates = {}; }],
    ['outside admission ancestry', () => { fixture.outsideAdmission = true; }],
    ['outside fetched base ancestry', () => { fixture.outsideFetchedBase = true; }],
    ['wrong merge tree', () => { fixture.mergeTree = 'f'.repeat(40); }],
    ['malformed response', () => { fixture.view.output = 'unparseable PR response'; }],
    ['unreadable response', () => { fixture.view = { code: 1, output: 'cannot read PR' }; }],
  ])('refuses %s with no cleanup', async (_name, corrupt) => {
    const state = stateFor(submitted);
    corrupt(state);
    const result = await poll(resume(state));
    expect(result.merged).toBeUndefined();
    expect(Boolean(result.failed || result.pending)).toBe(true);
    noSubmission();
    noCleanup();
  });

  it.each(outcomes.filter(o => o.name !== 'passing'))('OPEN cannot merge with $name', async outcome => {
    fixture.checks = outcome;
    fixture.view = { code: 0, output: prLine('OPEN') };
    const result = await poll(resume(stateFor(submitted, outcome)));
    expect(result.merged).toBeUndefined();
    expect(Boolean(result.failed || result.pending)).toBe(true);
    noSubmission();
    noCleanup();
    if (!submitted) {
      if (outcome.name === 'failed') expect(result.failed).toBe('build fail');
      if (outcome.name === 'missing inside window') expect(result.pending.reason).toBe('checks not yet registered');
      if (outcome.name === 'missing outside window') expect(result.failed).toMatch(/no remote checks registered/);
      if (['pending', 'authentication error', 'unavailable', 'spawn error'].includes(outcome.name)) expect(result.pending.reason).toBe('checks running');
    }
  });

  it.each(['later local work', 'concurrent ref update'])('preserves proven merge with %s', async kind => {
    if (kind === 'later local work') fixture.featureHead = LATER;
    else fixture.concurrentWriter = true;
    fixture.checks = outcomes[2];
    const result = await poll(resume(stateFor(submitted)));
    expect(result.merged).toMatchObject({ head_oid: HEAD, cleanup: { cleaned: false, remote_branch_retained: true } });
    expect(result.merged.cleanup.reason).toMatch(/changed|concurrent/);
    noSubmission();
    if (kind === 'later local work') noCleanup();
    else expect(gitCalls).toContainEqual(['update-ref', '--no-deref', '-d', 'refs/heads/feature/tested', HEAD]);
  });
});

it('resumes an already submitted OPEN watch into MERGED without another merge request', async () => {
  fixture.view = { code: 0, output: prLine('OPEN') };
  const state = stateFor(true);
  const first = await poll(state);
  expect(first.pending.merge_request_submitted).toBe(true);
  noCleanup();
  fixture.view = { code: 0, output: prLine() };
  fixture.checks = outcomes[7];
  const second = await poll(resume(state));
  expect(second.merged.provenance).toBe('observed-after-merge-command');
  noSubmission();
});

it.each(['MERGED', 'CLOSED', 'head drift', 'base drift'])('rechecks OPEN after passing checks when it changes to %s', async change => {
  fixture.view = { code: 0, output: prLine('OPEN') };
  fixture.afterChecks = () => {
    fixture.view = { code: 0, output: change === 'head drift' ? prLine('OPEN', { head: LATER }) : change === 'base drift' ? prLine('OPEN', { base: 'release' }) : prLine(change) };
  };
  const result = await poll(stateFor(false));
  noSubmission();
  if (change === 'MERGED') expect(result.merged.provenance).toBe('observed-external');
  else {
    expect(result.failed).toMatch(change === 'CLOSED' ? /closed without merging/ : /head|base/);
    noCleanup();
  }
});

it('retains origin validation after observation and before cleanup effects', async () => {
  fixture.view = () => {
    fixture.origin = 'https://github.com/other/repository.git';
    return { code: 0, output: prLine() };
  };
  const result = await poll(stateFor(false));
  expect(result.failed).toMatch(/origin/);
  noSubmission();
  noCleanup();
});

it.each([0, 1])('observes the exact merge after merge command exit %s', async code => {
  fixture.view = { code: 0, output: prLine('OPEN') };
  fixture.merge = () => {
    fixture.view = { code: 0, output: prLine() };
    return { code, output: code === 1 ? 'Pull Request is not mergeable' : '' };
  };
  const result = await poll(stateFor(false));
  expect(result.merged).toMatchObject({ head_oid: HEAD, provenance: 'observed-after-merge-command', cleanup: { cleaned: true } });
  const submissions = ghCalls.filter(args => args[1] === 'merge');
  expect(submissions).toHaveLength(1);
  expect(submissions[0]).toEqual(['pr', 'merge', URL, '--squash', '--match-head-commit', HEAD, '--repo', 'github.com/acme/repo']);
});

it('replays a historical watch without the optional submission marker without changing admission', async () => {
  const state = stateFor(false);
  delete state.shipping_watch.merge_request_submitted;
  const commitment = JSON.stringify(state.admission);
  fixture.checks = outcomes[2];
  const result = await poll(resume(state));
  expect(result.merged.provenance).toBe('observed-external');
  expect(JSON.stringify(state.admission)).toBe(commitment);
  noSubmission();
});
