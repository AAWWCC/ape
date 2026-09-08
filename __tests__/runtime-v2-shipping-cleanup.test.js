import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as git from '../lib/runtime/git.js';
import { assertLocalShippingBranchCurrent, deleteLocalShippingBranch } from '../lib/runtime/shipping-cleanup.js';
import { reconcileTerminalCheckout } from '../lib/runtime/receipt-service.js';

const roots = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
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
