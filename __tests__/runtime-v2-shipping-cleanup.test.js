import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as git from '../lib/runtime/git.js';
import { assertLocalShippingBranchCurrent, deleteLocalShippingBranch } from '../lib/runtime/shipping-cleanup.js';
import { applyActions, reconcileTerminalCheckout } from '../lib/runtime/receipt-service.js';
import { resumeRun } from '../lib/runtime/lifecycle-service.js';
import { runtimePaths } from '../lib/runtime/paths.js';
import { atomicWriteJson, readJson } from '../lib/runtime/storage.js';
import { refreshCodexAfterShip } from '../lib/runtime/post-ship.js';
import { sha256 } from '../lib/runtime/canonical.js';
import { admittedStartIdentityHash } from '../lib/runtime/admitted-start-identity.js';
import { projectRunDiagnostic } from '../lib/runtime/diagnostics.js';

const roots = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

async function refreshFixture() {
  const context = await fixture();
  const { root, head: base } = context;
  await git.runGit(root, ['remote', 'add', 'origin', 'https://github.com/AAWWCC/ape.git']);
  await mkdir(path.join(root, 'scripts'));
  await mkdir(path.join(root, 'plugins/ape/.codex-plugin'), { recursive: true });
  await writeFile(path.join(root, 'plugins/ape/.codex-plugin/plugin.json'), JSON.stringify({ name: 'ape', version: '2.29.0' }));
  await writeFile(path.join(root, 'scripts/reinstall-codex-plugin.mjs'), `
import { appendFileSync, existsSync, readFileSync } from 'node:fs';
const saved = existsSync('.ape/runtime/active.json')
  ? JSON.parse(readFileSync('.ape/runtime/active.json', 'utf8')).codex_plugin_refresh
  : JSON.parse(readFileSync('.git/refresh-state.json', 'utf8'));
if (saved.status !== 'installing') process.exit(19);
appendFileSync('.git/refresh-calls.ndjson', JSON.stringify(process.argv.slice(2)) + '\\n');
if (existsSync('.git/refresh-fail')) { console.error('synthetic refresh failure'); process.exit(17); }
`);
  await git.runGit(root, ['add', '.']);
  await git.runGit(root, ['commit', '-m', 'shipped installer fixture']);
  const head = await git.runGit(root, ['rev-parse', 'HEAD']);
  const tree = await git.runGit(root, ['rev-parse', 'HEAD^{tree}']);
  await git.runGit(root, ['update-ref', 'refs/remotes/origin/main', head]);
  await git.runGit(root, ['update-ref', `refs/heads/${context.branch}`, head]);
  const target = { origin: 'https://github.com/AAWWCC/ape.git', repository: 'AAWWCC/ape', base: 'main' };
  const config = { shipping: { codex_dev_refresh: true, provider: 'github', required_remote_checks: true, target } };
  const state = {
    schema_version: '2.0.0', version: 2, host: 'codex', run_id: 'run-post-ship-test',
    status: 'completed', stage: 'complete', mode: 'phase', lane: 'full', dispatch_state: 'none',
    objective: 'Ship the test-owned APE fixture', created_at: '2026-10-01T00:00:00.000Z',
    branch: context.branch, base_branch: 'main', base_commit_sha: base,
    tickets: [], receipts: [], checkout_cleanup: { status: 'returned' },
    shipping_target: { version: 1, provider: 'github', ...target, required_remote_checks: true },
    gates: { passed: true, tree_sha: tree },
    merge: { provider: 'github', base: 'main', head_oid: head, url: `https://github.com/${target.repository}/pull/1` },
  };
  const manifest = { version: 1, ready: true, shipping_target: { ...state.shipping_target }, repository: { base_branch: 'main', base_commit: base } };
  state.admission = { version: 1, manifest, digest: sha256(manifest) };
  state.start_request_hash = 'a'.repeat(64);
  state.admitted_start_identity_version = 1;
  state.admitted_start_identity_hash = admittedStartIdentityHash(state);
  const saved = [];
  const save = async () => {
    saved.push(structuredClone(state.codex_plugin_refresh));
    await writeFile(path.join(root, '.git/refresh-state.json'), JSON.stringify(state.codex_plugin_refresh));
  };
  const calls = async () => (await readFile(path.join(root, '.git/refresh-calls.ndjson'), 'utf8'))
    .trim().split('\n').map(line => JSON.parse(line));
  return { ...context, state, config, save, saved, calls };
}

describe('automatic Codex development refresh after shipping', () => {
  it('refreshes on terminal receipt cleanup and resumes a failed install without shipping again', async () => {
    const c = await refreshFixture();
    const paths = runtimePaths(c.root);
    await atomicWriteJson(paths.config, c.config);
    await writeFile(path.join(c.root, '.git/refresh-fail'), 'fail');
    const actions = await applyActions(paths, c.state, [{ type: 'release_lock' }, { type: 'persist_state' }], c.config);
    expect(actions.map(action => action.type)).toEqual(['checkout_cleanup', 'codex_plugin_refresh', 'release_lock']);
    expect(await readJson(paths.active)).toMatchObject({ status: 'completed', checkout_cleanup: { status: 'returned' }, codex_plugin_refresh: { status: 'failed' } });
    const head = await git.runGit(c.root, ['rev-parse', 'HEAD']);
    await rm(path.join(c.root, '.git/refresh-fail'));
    const resumed = await resumeRun(c.root);
    expect(resumed).toMatchObject({ ok: true, dispatch_state: 'none', run: { status: 'completed', codex_plugin_refresh: { status: 'installed' } } });
    expect(resumed.actions.map(action => action.type)).toEqual(['checkout_cleanup', 'codex_plugin_refresh']);
    expect((await c.calls()).map(args => args[3])).toEqual([c.state.codex_plugin_refresh.cachebuster, c.state.codex_plugin_refresh.cachebuster]);
    expect(await git.runGit(c.root, ['rev-parse', 'HEAD'])).toBe(head);
    expect((await readJson(paths.active)).merge).toEqual(c.state.merge);
  });

  it('persists the installation identity before execution and installs the verified shipped tree once', async () => {
    const c = await refreshFixture();
    const result = await refreshCodexAfterShip({ root: c.root }, c.state, c.config, c.save);
    expect(result).toMatchObject({ status: 'installed', plugin_id: 'ape@ape-dev', activation: 'new_session_required', tree_sha: c.state.gates.tree_sha });
    expect(c.saved.map(value => value.status)).toEqual(['installing', 'installed']);
    expect(await c.calls()).toEqual([['--marketplace', 'ape-dev', '--cachebuster', result.cachebuster, '--preserve-open-tasks']]);
    expect(await refreshCodexAfterShip({ root: c.root }, c.state, c.config, c.save)).toBeNull();
    expect(await c.calls()).toHaveLength(1);
  });

  it.each(['disabled', 'claude', 'blocked', 'shipping', 'not-github', 'cleanup-pending'])('does not install for %s', async scenario => {
    const c = await refreshFixture();
    if (scenario === 'disabled') c.config.shipping.codex_dev_refresh = false;
    if (scenario === 'claude') c.state.host = 'claude';
    if (['blocked', 'shipping'].includes(scenario)) c.state.status = scenario;
    if (scenario === 'not-github') c.state.merge.provider = 'other';
    if (scenario === 'cleanup-pending') c.state.checkout_cleanup.status = 'retained_dirty';
    expect(await refreshCodexAfterShip({ root: c.root }, c.state, c.config, c.save)).toBeNull();
    expect(c.saved).toEqual([]);
    await expect(c.calls()).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it.each(['dirty', 'wrong-branch', 'wrong-tree', 'wrong-origin', 'admission-drift'])('refuses installation after %s', async scenario => {
    const c = await refreshFixture();
    if (scenario === 'dirty') await writeFile(path.join(c.root, 'unrelated.txt'), 'new local work');
    if (scenario === 'wrong-branch') await git.runGit(c.root, ['switch', '-c', 'unrelated']);
    if (scenario === 'wrong-tree') c.state.gates.tree_sha = 'f'.repeat(40);
    if (scenario === 'wrong-origin') await git.runGit(c.root, ['remote', 'set-url', 'origin', 'https://github.com/example/other.git']);
    if (scenario === 'admission-drift') c.state.shipping_target.repository = 'example/other';
    const result = await refreshCodexAfterShip({ root: c.root }, c.state, c.config, c.save);
    expect(result.status).toBe('failed');
    expect(c.state.status).toBe('completed');
    await expect(c.calls()).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('reports an installation failure independently of shipping and reuses its version on recovery', async () => {
    const c = await refreshFixture();
    await writeFile(path.join(c.root, '.git/refresh-fail'), 'fail');
    const failed = await refreshCodexAfterShip({ root: c.root }, c.state, c.config, c.save);
    expect(failed).toMatchObject({ status: 'failed', reason: expect.stringContaining('synthetic refresh failure') });
    expect(c.state.status).toBe('completed');
    expect(projectRunDiagnostic(c.state)).toMatchObject({ reason_code: 'post_ship_refresh_pending', next_safe_action: 'ape_run resume' });
    await writeFile(path.join(c.root, 'local-work.txt'), 'preserve local work');
    const retained = await refreshCodexAfterShip({ root: c.root }, c.state, c.config, c.save);
    expect(retained).toMatchObject({ status: 'failed', cachebuster: failed.cachebuster });
    expect(await c.calls()).toHaveLength(1);
    await rm(path.join(c.root, 'local-work.txt'));
    await rm(path.join(c.root, '.git/refresh-fail'));
    const recovered = await refreshCodexAfterShip({ root: c.root }, c.state, c.config, c.save);
    expect(recovered.status).toBe('installed');
    expect(recovered.cachebuster).toBe(failed.cachebuster);
    expect((await c.calls()).map(args => args[3])).toEqual([failed.cachebuster, failed.cachebuster]);
  });
});

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), 'ape-safe-shipping-cleanup-'));
  roots.push(root);
  await git.runGit(root, ['init', '-b', 'main']);
  await git.runGit(root, ['config', 'user.name', 'APE Test']);
  await git.runGit(root, ['config', 'user.email', 'ape@example.test']);
  await git.runGit(root, ['config', 'commit.gpgsign', 'false']);
  await git.runGit(root, ['commit', '--allow-empty', '-m', 'attested head']);
  const head = await git.runGit(root, ['rev-parse', 'HEAD']);
  const branch = 'ape/shipped';
  await git.runGit(root, ['branch', branch]);
  await git.runGit(root, ['update-ref', 'refs/remotes/origin/main', head]);
  const newHead = await git.runGit(root, ['commit-tree', 'HEAD^{tree}', '-p', head, '-m', 'unique later local commit']);
  return { root, branch, head, newHead };
}

describe('local shipping cleanup compare-and-delete', () => {
  it('deletes only the exact unoccupied pushed head and tolerates an already absent branch', async () => {
    const { root, branch, head } = await fixture();
    expect(await deleteLocalShippingBranch(root, branch, head)).toEqual({ present: false });
    expect(await git.runGit(root, ['for-each-ref', '--format=%(refname)', `refs/heads/${branch}`])).toBe('');
    expect(await deleteLocalShippingBranch(root, branch, head)).toEqual({ present: false });
  });

  it('preserves a unique later commit even when its tree is identical to the pushed head', async () => {
    const { root, branch, head, newHead } = await fixture();
    await git.runGit(root, ['update-ref', `refs/heads/${branch}`, newHead]);
    await expect(deleteLocalShippingBranch(root, branch, head)).rejects.toThrow(/tip changed/);
    expect(await git.runGit(root, ['rev-parse', branch])).toBe(newHead);
    expect(await git.runGit(root, ['for-each-ref', '--contains', newHead, '--format=%(refname)'])).toBe(`refs/heads/${branch}`);
  });

  it('atomically refuses a branch update racing the final deletion', async () => {
    const { root, branch, head, newHead } = await fixture();
    const originalGit = git.runGit;
    vi.spyOn(git, 'runGit').mockImplementation(async (directory, args, options) => {
      if (args[0] === 'update-ref' && args.includes('-d')) {
        await originalGit(directory, ['update-ref', `refs/heads/${branch}`, newHead, head]);
      }
      return originalGit(directory, args, options);
    });
    await expect(deleteLocalShippingBranch(root, branch, head)).rejects.toThrow(/cannot lock ref/);
    expect(await originalGit(root, ['rev-parse', branch])).toBe(newHead);
  });

  it('preserves a branch checked out in any worktree', async () => {
    const { root, branch, head } = await fixture();
    const worktree = path.join(root, 'other-worktree');
    await git.runGit(root, ['worktree', 'add', worktree, branch]);
    await expect(deleteLocalShippingBranch(root, branch, head)).rejects.toThrow(/checked out in a worktree/);
    expect(await git.runGit(root, ['rev-parse', branch])).toBe(head);
  });

  it('fails closed on Git read errors instead of treating them as missing branches', async () => {
    const { root, branch, head } = await fixture();
    const originalGit = git.runGit;
    const spy = vi.spyOn(git, 'runGit').mockImplementation((directory, args, options) => {
      if (args[0] === 'for-each-ref') throw new Error('cannot read refs');
      return originalGit(directory, args, options);
    });
    await expect(deleteLocalShippingBranch(root, branch, head)).rejects.toThrow('cannot read refs');
    expect(spy.mock.calls.some(([, args]) => args[0] === 'update-ref')).toBe(false);
    expect(await originalGit(root, ['rev-parse', branch])).toBe(head);
  });

  it.each([undefined, '', 'not-a-commit'])('retains legacy branches without an exact expected head (%s)', async (expectedHead) => {
    const { root, branch, head } = await fixture();
    await expect(assertLocalShippingBranchCurrent(root, branch, expectedHead)).rejects.toThrow(/no exact pushed head/);
    expect(await git.runGit(root, ['rev-parse', branch])).toBe(head);
  });

  it.each(['advanced', 'legacy'])('terminal reconciliation preserves a %s shipment branch before switching the checkout', async (scenario) => {
    const { root, branch, head, newHead } = await fixture();
    if (scenario === 'advanced') await git.runGit(root, ['update-ref', `refs/heads/${branch}`, newHead]);
    await git.runGit(root, ['switch', branch]);
    const state = {
      branch, base_branch: 'main', base_commit_sha: head, status: 'completed',
      merge: { provider: 'github', ...(scenario === 'advanced' ? { head_oid: head } : {}) },
    };
    const result = await reconcileTerminalCheckout({ root }, state);
    expect(result).toMatchObject({ status: 'retained_error', retained: true, deleted: false });
    expect(result.reason).toMatch(scenario === 'advanced' ? /tip changed/ : /no exact pushed head/);
    expect(await git.runGit(root, ['branch', '--show-current'])).toBe(branch);
    expect(await git.runGit(root, ['rev-parse', branch])).toBe(scenario === 'advanced' ? newHead : head);
  });
});
