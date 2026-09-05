import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { runGit, currentTreeSha } from '../lib/runtime/git.js';
import * as git from '../lib/runtime/git.js';
import * as spawning from '../lib/runtime/spawn.js';
import * as shipping from '../lib/runtime/github-shipping.js';
import { canonicalJson, sha256 } from '../lib/runtime/canonical.js';
import { admittedStartIdentityHash } from '../lib/runtime/admitted-start-identity.js';
import { resolveFrozenShippingTarget } from '../lib/runtime/shipping-target.js';

const directories = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

const target = { origin: 'https://github.com/acme/project.git', repository: 'acme/project', base: 'main' };
const config = { shipping: { provider: 'github', auto_merge: true, required_remote_checks: true, target } };
function commitShippingFixture(state) {
  const manifest = { version: 1, ready: true, shipping_target: structuredClone(state.shipping_target), repository: { base_branch: state.base_branch, base_commit: state.base_commit_sha } };
  state.admission = { version: 1, manifest, digest: sha256(manifest) };
  state.start_request_hash ??= 'a'.repeat(64);
  state.admitted_start_identity_version = 1;
  state.admitted_start_identity_hash = admittedStartIdentityHash(state);
  return state;
}
async function project() {
  const directory = await mkdtemp(path.join(tmpdir(), 'ape-shipping-prevention-'));
  directories.push(directory);
  await runGit(directory, ['init', '-b', 'main']);
  await runGit(directory, ['config', 'user.name', 'APE Test']);
  await runGit(directory, ['config', 'user.email', 'ape@example.test']);
  await runGit(directory, ['config', 'commit.gpgsign', 'false']);
  await writeFile(path.join(directory, 'value.txt'), 'baseline\n');
  await runGit(directory, ['add', 'value.txt']);
  await runGit(directory, ['commit', '-m', 'baseline']);
  await runGit(directory, ['remote', 'add', 'origin', target.origin]);
  await runGit(directory, ['update-ref', 'refs/remotes/origin/main', 'HEAD']);
  await runGit(directory, ['symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/main']);
  return directory;
}

function stubAdmissionGithub({ repository = {}, rules = null, failed = false } = {}) {
  const calls = [];
  const originalSpawn = spawning.spawnWithTimeout;
  vi.spyOn(spawning, 'spawnWithTimeout').mockImplementation((command, args, options) => {
    if (command !== 'gh') return originalSpawn(command, args, options);
    calls.push([...args]);
    const body = args[0] === '--version' ? 'gh version offline' : args[1] === 'repos/acme/project'
      ? { full_name: 'acme/project', archived: false, disabled: false, permissions: { pull: true, push: true }, allow_squash_merge: true, ...repository }
      : rules ?? [{ type: 'required_status_checks', parameters: { strict_required_status_checks_policy: true, required_status_checks: [{ context: 'test' }] } }];
    return Promise.resolve({ exit_code: failed ? 1 : 0, timed_out: false, spawn_error: null, combined: typeof body === 'string' ? body : JSON.stringify(body) });
  });
  return calls;
}

async function preparedShipping(directory) {
  const admission = await shipping.inspectShippingAdmission(directory, {}, config);
  await runGit(directory, ['switch', '-c', 'ape/test']);
  const head = await runGit(directory, ['rev-parse', 'HEAD']);
  await writeFile(path.join(directory, 'value.txt'), 'approved change\n');
  const state = commitShippingFixture({
    run_id: 'run-offline-shipping', objective: 'Offline shipping fixture', mode: 'phase', lane: 'fast',
    branch: 'ape/test', base_branch: 'main', base_commit_sha: head, auto_merge_authorized: true,
    shipping_target: admission.shipping_target,
    gates: { passed: true, tree_sha: await currentTreeSha(directory) },
    receipts: [{ changed_files: ['value.txt'] }],
  });
  const events = [];
  const originalGit = git.runGit;
  const originalSpawn = spawning.spawnWithTimeout;
  vi.spyOn(git, 'remoteBranchTip').mockResolvedValue(head);
  vi.spyOn(spawning, 'spawnWithTimeout').mockImplementation((command, args, options) => {
    if (command === 'gh') {
      events.push(['gh', ...args]);
      return Promise.resolve({ exit_code: 0, timed_out: false, spawn_error: null, combined: `OPEN https://github.com/acme/project/pull/1 - ${head}\n` });
    }
    return originalSpawn(command, args, options);
  });
  vi.spyOn(git, 'runGit').mockImplementation(async (root, args, options) => {
    events.push([options?.env?.GIT_INDEX_FILE ? 'scratch' : 'git', ...args]);
    if (['push', 'fetch', 'pull', 'ls-remote'].includes(args[0]) && !args.includes('--get-url')) {
      throw new Error('offline network sink intercepted');
    }
    return originalGit(root, args, options);
  });
  return { state, events, originalGit };
}

describe('prevention-first shipping admission', () => {
  it('admits an explicitly configured non-APE project with stubbed prerequisite reads and no repository mutation', async () => {
    const directory = await project();
    const calls = stubAdmissionGithub();
    const before = await readFile(path.join(directory, '.git', 'index'));
    const head = await runGit(directory, ['rev-parse', 'HEAD']);
    const result = await shipping.inspectShippingAdmission(directory, { auto_merge_authorized: true }, config);
    expect(result).toMatchObject({ ready: true, blocking: [], shipping_target: { version: 1, ...target, required_remote_checks: true } });
    expect(result.prerequisites.status).toBe('ready');
    expect(calls.some((args) => args[1] === 'repos/acme/project')).toBe(true);
    expect(await readFile(path.join(directory, '.git', 'index'))).toEqual(before);
    expect(await runGit(directory, ['rev-parse', 'HEAD'])).toBe(head);
  });

  it('separates local produce-and-hold target admission from deferred shipping proof', async () => {
    const directory = await project();
    const calls = stubAdmissionGithub({ failed: true });
    const result = await shipping.inspectShippingAdmission(directory, {}, config);
    expect(result).toMatchObject({ ready: true, prerequisites: { status: 'deferred' } });
    expect(calls).toEqual([]);
  });

  it.each([
    ['unverified authentication', { failed: true }, 'shipping_github_unavailable'],
    ['no push permission', { repository: { permissions: { pull: true, push: false } } }, 'shipping_repository_access_unverified'],
    ['squash disabled', { repository: { allow_squash_merge: false } }, 'shipping_squash_unavailable'],
    ['wrong repository response', { repository: { full_name: 'other/project' } }, 'shipping_repository_access_unverified'],
    ['loose or missing check protection', { rules: [] }, 'shipping_protection_unverified'],
  ])('blocks shipping-requested admission for %s without exposing raw prerequisite data', async (_label, fixture, code) => {
    const directory = await project();
    stubAdmissionGithub(fixture);
    const result = await shipping.inspectShippingAdmission(directory, { auto_merge_authorized: true }, config);
    expect(result.ready).toBe(false);
    expect(result.blocking.map((entry) => entry.code)).toContain(code);
    expect(result.prerequisites.status).toBe('blocked');
    expect(JSON.stringify(result)).not.toContain('ape@example.test');
    expect(JSON.stringify(result)).not.toContain('other/project');
  });

  it('fails before remote queries when configured signing is not non-interactively proven', async () => {
    const directory = await project();
    await runGit(directory, ['config', 'commit.gpgsign', 'true']);
    const calls = stubAdmissionGithub();
    const result = await shipping.inspectShippingAdmission(directory, { auto_merge_authorized: true }, config);
    expect(result.blocking.map((entry) => entry.code)).toContain('shipping_signing_unverified');
    expect(calls).toEqual([]);
  });

  it('blocks missing Git identity before any GitHub prerequisite query', async () => {
    const directory = await project();
    await runGit(directory, ['config', 'user.name', '']);
    const calls = stubAdmissionGithub();
    const result = await shipping.inspectShippingAdmission(directory, { auto_merge_authorized: true }, config);
    expect(result.blocking.map((entry) => entry.code)).toContain('shipping_git_identity_unavailable');
    expect(calls).toEqual([]);
  });

  it('keeps staged bytes, worktree, and HEAD unchanged when signing fails without an unsigned retry', async () => {
    const directory = await project();
    const { state, events, originalGit } = await preparedShipping(directory);
    await originalGit(directory, ['add', 'value.txt']);
    const beforeIndex = await originalGit(directory, ['ls-files', '--stage', '-z'], { raw: true });
    const beforeWorktree = await readFile(path.join(directory, 'value.txt'));
    const beforeHead = await originalGit(directory, ['rev-parse', 'HEAD']);
    const commits = [];
    const guardedGit = git.runGit.getMockImplementation();
    vi.mocked(git.runGit).mockImplementation((root, args, options) => {
      if (args[0] === 'commit') {
        commits.push(args);
        throw new Error('gpg failed to sign the data: /secret/signer/path');
      }
      return guardedGit(root, args, options);
    });
    const error = await shipping.autoMergeGithub(directory, state, config).catch((cause) => cause);
    expect(error.message).toMatch(/no unsigned fallback/);
    expect(error.message).not.toContain('/secret/signer/path');
    expect(commits).toHaveLength(1);
    expect(commits[0]).not.toContain('--no-gpg-sign');
    // Git may refresh its TREE cache; staged paths/modes/blob IDs must not
    // change and no rollback may clobber a concurrent operator's index.
    expect(await originalGit(directory, ['ls-files', '--stage', '-z'], { raw: true })).toEqual(beforeIndex);
    expect(await readFile(path.join(directory, 'value.txt'))).toEqual(beforeWorktree);
    expect(await originalGit(directory, ['rev-parse', 'HEAD'])).toBe(beforeHead);
    expect(events.some((event) => event[0] === 'git' && ['push', 'reset', 'stash'].includes(event[1]))).toBe(false);
  });

  it('refuses missing explicit target and never infers one from origin', async () => {
    const directory = await project();
    const result = await shipping.inspectShippingAdmission(directory, {}, { shipping: { provider: 'github' } });
    expect(result.ready).toBe(false);
    expect(result.blocking.map((entry) => entry.code)).toContain('shipping_target_missing');
  });

  it('refuses mismatched fetch and push origins', async () => {
    const directory = await project();
    await runGit(directory, ['remote', 'set-url', '--push', 'origin', 'https://github.com/other/project.git']);
    const result = await shipping.inspectShippingAdmission(directory, {}, config);
    expect(result.ready).toBe(false);
    expect(result.blocking.map((entry) => entry.code)).toContain('shipping_origin_mismatch');
  });

  it.each(['insteadOf', 'pushInsteadOf'])('refuses a frozen transport redirected by %s while named origin remains correct', async (rewrite) => {
    const directory = await project();
    const sshOrigin = 'git@github.com:acme/project.git';
    await runGit(directory, ['config', `url.https://github.com/other/project.git.${rewrite}`, sshOrigin]);
    const before = await readFile(path.join(directory, '.git', 'config'));
    expect(await runGit(directory, ['remote', 'get-url', 'origin'])).toBe(target.origin);
    const result = await shipping.inspectShippingAdmission(directory, {}, { shipping: { ...config.shipping, target: { ...target, origin: sshOrigin } } });
    expect(result.ready).toBe(false);
    expect(result.blocking.map((entry) => entry.code)).toContain('shipping_origin_mismatch');
    expect(await readFile(path.join(directory, '.git', 'config'))).toEqual(before);
  });

  it('refuses newly redirected frozen transport before GitHub or staging effects', async () => {
    const directory = await project();
    const { state, events, originalGit } = await preparedShipping(directory);
    await originalGit(directory, ['remote', 'set-url', 'origin', 'git@github.com:acme/project.git']);
    await originalGit(directory, ['config', 'url.https://github.com/other/project.git.pushInsteadOf', target.origin]);
    const before = await readFile(path.join(directory, '.git', 'index'));
    await expect(shipping.autoMergeGithub(directory, state, config)).rejects.toThrow(/origin.*frozen target/);
    expect(events.some((event) => event[0] === 'gh' || (event[0] === 'git' && ['add', 'commit', 'push'].includes(event[1])))).toBe(false);
    expect(await readFile(path.join(directory, '.git', 'index'))).toEqual(before);
  });

  it('retains the public APE package guard without imposing it on other projects', async () => {
    const directory = await project();
    await writeFile(path.join(directory, 'package.json'), JSON.stringify({ name: 'ape', repository: { url: 'https://github.com/AAWWCC/ape.git' } }));
    const result = await shipping.inspectShippingAdmission(directory, {}, config);
    expect(result.ready).toBe(false);
    expect(result.blocking.map((entry) => entry.code)).toContain('canonical_ape_target_mismatch');
  });

  it('rejects legacy unbound shipping before any staging or remote access', async () => {
    const directory = await project();
    await runGit(directory, ['switch', '-c', 'ape/test']);
    await writeFile(path.join(directory, 'value.txt'), 'modified\n');
    const before = await readFile(path.join(directory, '.git', 'index'));
    const originalGit = git.runGit;
    vi.spyOn(git, 'runGit').mockImplementation((root, args, options) => {
      if (['add', 'commit', 'push', 'fetch', 'pull', 'ls-remote'].includes(args[0])) {
        throw new Error('offline harness prevented shipping effect');
      }
      return originalGit(root, args, options);
    });
    const originalSpawn = spawning.spawnWithTimeout;
    vi.spyOn(spawning, 'spawnWithTimeout').mockImplementation((command, args, options) => {
      if (command === 'gh') throw new Error('offline harness prevented GitHub access');
      return originalSpawn(command, args, options);
    });
    await expect(shipping.autoMergeGithub(directory, {
      branch: 'ape/test', auto_merge_authorized: true,
      gates: { passed: true, tree_sha: await currentTreeSha(directory) },
      receipts: [{ changed_files: ['value.txt'] }],
    }, config)).rejects.toThrow(/frozen shipping target/i);
    expect(await readFile(path.join(directory, '.git', 'index'))).toEqual(before);
  });

  it.each(['missing admission', 'changed manifest digest', 'retargeted commitment'])('rejects %s before effects even when target fields have a valid shape', async (variant) => {
    const directory = await project();
    const { state, events, originalGit } = await preparedShipping(directory);
    const originalHash = state.admitted_start_identity_hash;
    let shippingConfig = config;
    if (variant === 'missing admission') delete state.admission;
    else if (variant === 'changed manifest digest') state.admission.digest = 'b'.repeat(64);
    else {
      const changed = { origin: 'https://github.com/other/project.git', repository: 'other/project', base: 'main' };
      state.shipping_target = { ...state.shipping_target, ...changed };
      state.admission.manifest.shipping_target = structuredClone(state.shipping_target);
      state.admission.digest = sha256(state.admission.manifest);
      shippingConfig = { shipping: { ...config.shipping, target: changed } };
      await originalGit(directory, ['remote', 'set-url', 'origin', changed.origin]);
    }
    expect(state.admitted_start_identity_hash).toBe(originalHash);
    await expect(shipping.autoMergeGithub(directory, state, shippingConfig)).rejects.toThrow(/admission.*commitment|admitted.start identity/i);
    expect(events.some((event) => event[0] === 'gh' || (event[0] === 'git' && ['add', 'commit', 'push'].includes(event[1])))).toBe(false);
  });

  it.each(['empty unborn baseline', 'nonempty unborn baseline', 'null base without unborn admission'])('checks %s against the full start commitment without inventing a preview SHA', async (variant) => {
    const directory = await project();
    const { state, events, originalGit } = await preparedShipping(directory);
    if (variant === 'empty unborn baseline') {
      const tree = await originalGit(directory, ['mktree']);
      state.base_commit_sha = await originalGit(directory, ['commit-tree', tree, '-m', 'test empty baseline']);
    }
    state.admission.manifest.repository.base_commit = null;
    state.admission.manifest.repository.unborn = variant !== 'null base without unborn admission';
    state.admission.digest = sha256(state.admission.manifest);
    state.admitted_start_identity_hash = admittedStartIdentityHash(state);
    const pending = resolveFrozenShippingTarget(directory, state, config);
    if (variant === 'empty unborn baseline') {
      expect((await pending).repository).toBe(target.repository);
      expect(state.admission.manifest.repository.base_commit).toBeNull();
    } else await expect(pending).rejects.toThrow(/empty commit|admission commitment/);
    expect(events.some((event) => event[0] === 'gh' || (event[0] === 'git' && ['push', 'fetch', 'pull'].includes(event[1])))).toBe(false);
  });

  it('requires a structured admitted target even when a JSON string shares its raw SHA-256 digest', async () => {
    const directory = await project();
    const { state } = await preparedShipping(directory);
    state.admission.manifest.shipping_target = canonicalJson(state.shipping_target);
    expect(sha256(state.admission.manifest.shipping_target)).toBe(sha256(state.shipping_target));
    state.admission.digest = sha256(state.admission.manifest);
    state.admitted_start_identity_hash = admittedStartIdentityHash(state);
    await expect(resolveFrozenShippingTarget(directory, state, config)).rejects.toThrow(/admission commitment/);
  });

  it('refuses untested pre-staged content without changing the real index or committing', async () => {
    const directory = await project();
    await writeFile(path.join(directory, 'shadow.txt'), 'hidden staged version\n');
    await runGit(directory, ['add', 'shadow.txt']);
    await rm(path.join(directory, 'shadow.txt'));
    const { state, events } = await preparedShipping(directory);
    const before = await readFile(path.join(directory, '.git', 'index'));
    await expect(shipping.autoMergeGithub(directory, state, config)).rejects.toThrow(/prospective shipping index/);
    expect(await readFile(path.join(directory, '.git', 'index'))).toEqual(before);
    expect(events.some((event) => event[0] === 'git' && ['add', 'commit', 'push'].includes(event[1]))).toBe(false);
  });

  it('stages the tested working version of an approved partially staged file', async () => {
    const directory = await project();
    await writeFile(path.join(directory, 'value.txt'), 'older staged version\n');
    await runGit(directory, ['add', 'value.txt']);
    const { state, events, originalGit } = await preparedShipping(directory);
    await expect(shipping.autoMergeGithub(directory, state, config)).rejects.toThrow(/offline network sink intercepted/);
    expect(await originalGit(directory, ['rev-parse', 'HEAD^{tree}'])).toBe(state.gates.tree_sha);
    expect(events.some((event) => event[0] === 'git' && event[1] === 'commit')).toBe(true);
    expect(events.some((event) => event[0] === 'git' && event[1] === 'push')).toBe(true);
  });

  it('refuses to push when a commit hook changes the committed tree', async () => {
    const directory = await project();
    const { state, events, originalGit } = await preparedShipping(directory);
    await writeFile(path.join(directory, '.git', 'hooks', 'pre-commit'), '#!/bin/sh\nprintf "hook mutation\\n" > value.txt\ngit add -- value.txt\n', { mode: 0o755 });
    await expect(shipping.autoMergeGithub(directory, state, config)).rejects.toThrow(/committed shipping tree.*push refused/);
    expect(await originalGit(directory, ['rev-parse', 'HEAD^{tree}'])).not.toBe(state.gates.tree_sha);
    expect(events.some((event) => event[0] === 'git' && event[1] === 'push')).toBe(false);
  });

  it('refuses configuration target drift before any GitHub access or staging', async () => {
    const directory = await project();
    const { state, events } = await preparedShipping(directory);
    await expect(shipping.autoMergeGithub(directory, state, { shipping: { ...config.shipping, target: { ...target, base: 'release/stable' } } })).rejects.toThrow(/target or policy drifted/);
    expect(events.some((event) => event[0] === 'gh' || ['add', 'commit', 'push'].includes(event[1]))).toBe(false);
  });

  it('refuses a forged cross-repository watch before polling', async () => {
    const directory = await project();
    const { state, events } = await preparedShipping(directory);
    state.shipping_watch = {
      shipping_target: state.shipping_target, base: 'main', branch: 'ape/test',
      pr_url: 'https://github.com/other/project/pull/1', head_oid: state.base_commit_sha,
    };
    await expect(shipping.pollRemoteChecksAndMerge(directory, state, config)).rejects.toThrow(/watch does not match/);
    expect(events.some((event) => event[0] === 'gh')).toBe(false);
  });

  it('pins the verified commit even if HEAD changes at the intercepted push boundary', async () => {
    const directory = await project();
    const { state, originalGit } = await preparedShipping(directory);
    const previous = git.runGit.getMockImplementation();
    let pinned;
    vi.mocked(git.runGit).mockImplementation(async (root, args, options) => {
      if (args[0] === 'push') {
        pinned = args[2].split(':')[0];
        await originalGit(root, ['update-ref', 'refs/heads/ape/test', state.base_commit_sha]);
        throw new Error('offline push race intercepted');
      }
      return previous(root, args, options);
    });
    await expect(shipping.autoMergeGithub(directory, state, config)).rejects.toThrow(/offline push race intercepted/);
    expect(pinned).toMatch(/^[0-9a-f]{40}$/);
    expect(pinned).not.toBe(await originalGit(directory, ['rev-parse', 'HEAD']));
    expect(await originalGit(directory, ['rev-parse', `${pinned}^{tree}`])).toBe(state.gates.tree_sha);
  });

  it('allows the audited one-shot SHIP consent without claiming admission-time auto consent', async () => {
    const directory = await project();
    const { state } = await preparedShipping(directory);
    state.auto_merge_authorized = false;
    state.ship_requested = true;
    commitShippingFixture(state);
    await expect(shipping.autoMergeGithub(directory, state, { shipping: { ...config.shipping, auto_merge: false } })).rejects.toThrow(/offline network sink intercepted/);
    expect(state.auto_merge_authorized).toBe(false);
  });
});
