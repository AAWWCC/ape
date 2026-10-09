import { afterEach, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { previewRun, resumeRun, startRun } from '../lib/runtime/service.js';
import { statusRun, compactStatus } from '../lib/runtime/status-service.js';
import { runtimePaths } from '../lib/runtime/paths.js';
import * as storage from '../lib/runtime/storage.js';
import * as checkpoints from '../lib/runtime/work-checkpoints.js';
import * as gateOwnership from '../lib/runtime/gate-launch-ownership.js';
import { releaseRunLock } from '../lib/runtime/lock.js';
import { cleanupRecoveryLineage } from '../lib/runtime/recovery-cleanup.js';
import { planTaskRecovery } from '../lib/runtime/recovery-planner.js';
import { sha256 } from '../lib/runtime/canonical.js';
import { admittedStartIdentityHash } from '../lib/runtime/admitted-start-identity.js';
import { currentTreeSha } from '../lib/runtime/git.js';
import { loadSessionGuidance } from '../lib/runtime/session-guidance.js';
import { projectRunResponse, RESPONSE_BUDGET_BYTES } from '../lib/runtime/projection.js';
import { fixtureGit, packagedFixtureEnv } from './recovery-pagination-test-helper.js';

const dirs = [];
afterEach(async () => { vi.restoreAllMocks(); await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))); });
const git = (dir, args, options = {}) => fixtureGit(dir, args, options);
const input = { objective: 'Recover the unfinished documentation', mode: 'phase', lane: 'mechanical', host: 'claude',
  behavioral: false, claimed_paths: ['README.md', 'new.txt', 'deleted.txt'], test_paths: [], requirements: [], risk_triggers: [],
  hooks_trusted: true, subagents_available: true, explicit_invocation: true };
async function project() {
  const dir = await mkdtemp(path.join(tmpdir(), 'ape-task-resume-')); dirs.push(dir);
  git(dir, ['init', '-q', '-b', 'main']);
  git(dir, ['config', 'user.name', 'APE Test']); git(dir, ['config', 'user.email', 'ape@example.test']);
  git(dir, ['config', 'core.autocrlf', 'false']);
  await writeFile(path.join(dir, '.gitignore'), '.ape/\n.env\n');
  await writeFile(path.join(dir, 'README.md'), 'base\n'); await writeFile(path.join(dir, 'deleted.txt'), 'old\n');
  git(dir, ['add', '.']); git(dir, ['commit', '-qm', 'base']);
  await storage.atomicWriteJson(runtimePaths(dir).config, { shipping: { auto_merge: false, required_remote_checks: false },
    test_commands: { full: 'node --test', targeted_template: 'node --test {paths}' } });
  return dir;
}
async function blocked(dir, { dirt = true, retainLock = false } = {}) {
  expect((await startRun(dir, input)).ok).toBe(true);
  const paths = runtimePaths(dir);
  const state = await storage.readJson(paths.active);
  state.status = 'blocked'; state.stage = 'build'; state.block_reason = 'Worker failed to complete the documentation';
  await storage.atomicWriteJson(paths.active, state);
  await storage.atomicWriteJson(path.join(paths.runs, `${state.run_id}.json`), state);
  if (!retainLock) await releaseRunLock(paths.lock, state.run_id);
  if (dirt) {
    await writeFile(path.join(dir, 'README.md'), 'staged\n'); git(dir, ['add', 'README.md']);
    await writeFile(path.join(dir, 'README.md'), 'work\n');
    await writeFile(path.join(dir, 'new.txt'), 'new\n'); await rm(path.join(dir, 'deleted.txt'));
  }
  return state;
}
const confirm = (plan, extra = {}) => ({ expected_recovery_digest: plan.recovery_plan.expected_recovery_digest, explicit_invocation: true, ...extra });
async function freshStart(dir, restored) {
  const request = { ...restored.start_input, hooks_trusted: true, subagents_available: true, explicit_invocation: true };
  const preview = await previewRun(dir, request);
  expect(preview.admission.ready, JSON.stringify(preview.admission.blocking)).toBe(true);
  return startRun(dir, { ...request, expected_admission_digest: preview.admission_digest });
}

describe('explicit resume recovers a task with fresh execution', () => {
  it('recovers a blocked run that retained its own live-process writer lock', async () => {
    const dir = await project();
    const state = await blocked(dir, { retainLock: true });
    const paths = runtimePaths(dir);
    const lock = await readFile(paths.lock, 'utf8');
    const plan = await resumeRun(dir);
    expect(plan.recovery_plan.kind).toBe('replace_run');
    expect(await readFile(paths.lock, 'utf8')).toBe(lock);
    const restored = await resumeRun(dir, confirm(plan));
    expect(restored.next_action.kind).toBe('start_recovered_work');
    expect(restored.start_input.supersedes_run).toBe(state.run_id);
    expect(await readFile(path.join(dir, 'README.md'), 'utf8')).toBe('work\n');
    const checkpoint = await checkpoints.readWorkCheckpoint(paths, restored.start_input.checkpoint_id);
    expect(git(dir, ['show', `${checkpoint.git_ref}-index:README.md`])).toBe('staged');
    await expect(readFile(paths.lock)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('retains the owned writer lock when checkpoint publication fails, then recovers on retry', async () => {
    const dir = await project();
    const state = await blocked(dir, { retainLock: true });
    const paths = runtimePaths(dir);
    const lock = await readFile(paths.lock, 'utf8');
    const plan = await resumeRun(dir);
    vi.spyOn(checkpoints, 'saveWorkCheckpoint').mockRejectedValueOnce(new Error('checkpoint unavailable'));
    await expect(resumeRun(dir, confirm(plan))).rejects.toThrow('checkpoint unavailable');
    expect(await readFile(paths.lock, 'utf8')).toBe(lock);
    expect((await storage.readJson(paths.active)).run_id).toBe(state.run_id);
    const restored = await resumeRun(dir, confirm(plan));
    expect(restored.next_action.kind).toBe('start_recovered_work');
    await expect(readFile(paths.lock)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it.each(['ape', 'ape-claude'])('recovers through the %s packaged MCP boundary and rejects recovery fields on other actions', async (hostPackage) => {
    const dir = await project(); await blocked(dir);
    const env = packagedFixtureEnv();
    const tool = (args) => {
      const request = { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'ape_run', arguments: { ...args, project_dir: dir } } };
      const output = execFileSync(process.execPath, [fileURLToPath(new URL(`../plugins/${hostPackage}/dist/ape-mcp.bundle.mjs`, import.meta.url))], {
        cwd: dir, env, input: `${JSON.stringify(request)}\n`, encoding: 'utf8', timeout: 20_000,
      });
      const result = output.trim().split('\n').map((line) => JSON.parse(line)).find((item) => item.id === 1).result;
      return result.isError ? result.content[0].text : JSON.parse(result.content[0].text);
    };
    const plan = tool({ action: 'resume' });
    expect(plan.recovery_plan.kind).toBe('replace_run');
    expect(JSON.stringify(tool({ action: 'next', expected_recovery_digest: plan.recovery_plan.expected_recovery_digest }))).toContain('accepted only by resume');
    const restored = tool({ action: 'resume', ...confirm(plan) });
    expect(restored.next_action.kind).toBe('start_recovered_work');
    expect(restored.start_input.objective).toBe(input.objective);
    expect((await checkpoints.readWorkCheckpoint(runtimePaths(dir), restored.start_input.checkpoint_id)).version).toBe(2);

    // Recovery and pagination must coexist in each installed host package.
    // A package built from either development branch alone cannot serve this flow.
    const request = { ...restored.start_input, action: 'preview',
      objective: `Review ${'\\\n🙂'.repeat(4000)}`,
      hooks_trusted: true, subagents_available: true, explicit_invocation: true };
    const before = { head: git(dir, ['rev-parse', 'HEAD']), status: git(dir, ['status', '--porcelain']) };
    const chunks = [];
    let page = tool(request);
    expect(page.admission_delivery?.kind).toBe('paged');
    const { digest, total_utf8_bytes } = page.admission_delivery;
    let offset = 0;
    for (;;) {
      const delivery = page.admission_delivery;
      expect(delivery).toMatchObject({ version: 1, kind: 'paged', digest, total_utf8_bytes, offset });
      expect(delivery.sha256).toBe(sha256(delivery.text));
      chunks.push(delivery.text);
      offset += Buffer.byteLength(delivery.text);
      expect(chunks.length).toBeLessThan(100);
      if (delivery.next_offset === null) break;
      expect(delivery.next_offset).toBe(offset);
      page = tool({ ...request, admission_page: { digest, offset } });
    }
    const manifestText = chunks.join('');
    expect(offset).toBe(total_utf8_bytes);
    expect(sha256(manifestText)).toBe(digest);
    expect(JSON.parse(manifestText)).toMatchObject({ ready: true,
      request: { checkpoint_id: restored.start_input.checkpoint_id, objective: request.objective } });
    expect({ head: git(dir, ['rev-parse', 'HEAD']), status: git(dir, ['status', '--porcelain']) }).toEqual(before);
  });

  it('discovers without mutation, preserves the task, uses one recovery branch and never reuses worker evidence', async () => {
    const dir = await project(); const old = await blocked(dir);
    const before = git(dir, ['status', '--porcelain']);
    const plan = await resumeRun(dir);
    expect(plan.recovery_plan.kind).toBe('replace_run');
    expect((await statusRun(dir)).recovery_plan).toEqual(plan.recovery_plan);
    expect((await compactStatus(dir)).next_action.kind).toBe('confirm_recovery');
    expect(await loadSessionGuidance(dir, { host: 'claude' })).toContain('replace_run');
    expect(git(dir, ['status', '--porcelain'])).toBe(before);
    expect((await resumeRun(dir, { expected_recovery_digest: plan.recovery_plan.expected_recovery_digest })).ok).toBe(false);
    const restored = await resumeRun(dir, confirm(plan));
    expect(restored.next_action.kind).toBe('start_recovered_work');
    expect(restored.start_input.supersedes_run).toBe(old.run_id);
    const cp = await checkpoints.readWorkCheckpoint(runtimePaths(dir), restored.start_input.checkpoint_id);
    expect(git(dir, ['show', `${cp.git_ref}-index:README.md`])).toBe('staged');
    expect(git(dir, ['show', `${cp.git_ref}:new.txt`])).toBe('new');
    const branch = git(dir, ['branch', '--show-current']);
    const count = git(dir, ['branch', '--list']).split('\n').length;
    const fresh = await freshStart(dir, restored);
    expect(fresh.run.run_id).not.toBe(old.run_id);
    expect(fresh.run.branch).toBe(branch);
    expect(git(dir, ['branch', '--list']).split('\n')).toHaveLength(count);
    expect(fresh.run.tickets.some((ticket) => old.tickets.some((prior) => prior.ticket_id === ticket.ticket_id))).toBe(false);
    expect(fresh.run.receipts.every((receipt) => receipt.agent.identity === 'ape-runtime' && receipt.tests.length === 0)).toBe(true);
    expect(fresh.run.tickets[0].task_recovery).toMatchObject({ blocker: old.block_reason, evidence_only: true });
    const replay = await resumeRun(dir, confirm(plan));
    expect(replay.recovered).toBe('already-continued'); expect(replay.run_id).toBe(fresh.run.run_id);
  });

  it.each(['files', 'index', 'configuration'])('rejects a stale digest after %s drift', async (drift) => {
    const dir = await project(); const old = await blocked(dir); const plan = await resumeRun(dir);
    if (drift === 'files') await writeFile(path.join(dir, 'new.txt'), 'newer\n');
    if (drift === 'index') git(dir, ['add', 'README.md']);
    if (drift === 'configuration') await storage.atomicWriteJson(runtimePaths(dir).config, { shipping: { auto_merge: false }, test_commands: { full: 'node --test changed' } });
    const result = await resumeRun(dir, confirm(plan));
    expect(result.code).toBe('recovery-plan-changed');
    expect((await storage.readJson(runtimePaths(dir).active)).run_id).toBe(old.run_id);
    expect(git(dir, ['branch', '--show-current'])).toBe(old.branch);
  });

  it.each(['journal-publication', 'post-reset'])('replays a crash at %s without losing context or making another branch', async (point) => {
    const dir = await project(); await blocked(dir); const plan = await resumeRun(dir);
    if (point === 'journal-publication') {
      const publish = storage.publishImmutableJson;
      vi.spyOn(storage, 'publishImmutableJson').mockImplementation(async (file, data) => {
        const result = await publish(file, data);
        if (file.endsWith('.recovery.json')) throw new Error('simulated crash after durable journal');
        return result;
      });
    } else vi.spyOn(checkpoints, 'restoreWorkCheckpoint').mockRejectedValueOnce(new Error('simulated crash after reset'));
    await expect(resumeRun(dir, confirm(plan))).rejects.toThrow('simulated crash');
    vi.restoreAllMocks();
    const [restored, replay] = await Promise.all([resumeRun(dir, confirm(plan)), resumeRun(dir, confirm(plan))]);
    expect(restored.ok).toBe(true); expect(replay.start_input).toEqual(restored.start_input);
    expect(git(dir, ['branch', '--list', 'ape/recover-*']).split('\n')).toHaveLength(1);
    git(dir, ['gc', '--prune=now']);
    expect(await readFile(path.join(dir, 'README.md'), 'utf8')).toBe('work\n');
  });

  it('does not retire a native launch with unknown stop evidence, including after discovery', async () => {
    const dir = await project(); const old = await blocked(dir); const plan = await resumeRun(dir);
    const paths = runtimePaths(dir);
    const file = path.join(paths.dispatchIntents, (await readdir(paths.dispatchIntents)).find((name) => name.endsWith('.json')));
    const record = await storage.readJson(file);
    // A damaged launch is uncertainty, never proof of retirement.
    await storage.atomicWriteJson(file, { ...record, status: 'launched', launch_attempts: 1, launched_at: new Date().toISOString() });
    const changed = await resumeRun(dir, confirm(plan));
    expect(changed.ok).toBe(false);
    expect((await resumeRun(dir)).recovery_plan.kind).toBe('wait_for_owners');
    expect((await storage.readJson(paths.active)).run_id).toBe(old.run_id);
  });

  it('keeps gate uncertainty and an intentional shipping hold out of replacement', async () => {
    const dir = await project(); const state = await blocked(dir);
    state.gates_watch = { nonce: 'missing-owner' };
    await storage.atomicWriteJson(runtimePaths(dir).active, state);
    expect((await resumeRun(dir)).recovery_plan.kind).toBe('wait_for_owners');
    state.stage = 'merge'; state.block_reason = 'auto-merge is disabled by configuration';
    await storage.atomicWriteJson(runtimePaths(dir).active, state);
    expect((await resumeRun(dir)).recovery_plan.kind).toBe('hold');
    delete state.gates_watch; state.block_reason = 'Shipping response lost';
    await storage.atomicWriteJson(runtimePaths(dir).active, state);
    expect((await resumeRun(dir)).recovery_plan.kind).toBe('inspect_recovery');
  });

  it('restores the existing shipment under recovery locks without creating a new run or branch', async () => {
    const dir = await project(); const state = await blocked(dir, { dirt: false });
    const paths = runtimePaths(dir);
    const target = { version: 1, provider: 'github', origin: 'https://github.com/acme/repo.git',
      repository: 'acme/repo', base: 'main', required_remote_checks: false };
    git(dir, ['remote', 'add', 'origin', target.origin]);
    const config = await storage.readJson(paths.config);
    config.shipping = { ...config.shipping, provider: 'github', target };
    await storage.atomicWriteJson(paths.config, config);
    state.stage = 'merge'; state.block_reason = 'Shipping response lost'; state.shipping_target = target;
    state.admission = { version: 1, manifest: { version: 1, ready: true, shipping_target: target,
      repository: { base_branch: state.base_branch, base_commit: state.base_commit_sha } } };
    state.admission.digest = sha256(state.admission.manifest);
    state.admitted_start_identity_hash = admittedStartIdentityHash(state);
    const watch = { provider: 'github', shipping_target: target, pr_url: 'https://github.com/acme/repo/pull/7',
      branch: state.branch, base: 'main', head_oid: git(dir, ['rev-parse', 'HEAD']), merge_request_submitted: true };
    state.shipping_recovery = { status: 'needs-reconciliation', watch };
    await storage.atomicWriteJson(paths.active, state);
    const plan = await resumeRun(dir);
    expect(plan.recovery_plan.kind).toBe('reconcile_shipping');
    const restored = await resumeRun(dir, confirm(plan));
    expect(restored.run).toMatchObject({ run_id: state.run_id, status: 'shipping', shipping_watch: watch });
    expect((await resumeRun(dir, confirm(plan))).code).toBe('recovery-plan-changed');
    expect(git(dir, ['branch', '--list', 'ape/recover-*'])).toBe('');
    expect((await storage.readJson(paths.active)).shipping_watch).toEqual(watch);
    await releaseRunLock(paths.lock, state.run_id);
  });

  it('requires gate result and heartbeat producers to finish as well as process retirement', async () => {
    const dir = await project(); const state = await blocked(dir);
    const proof = { cleanup: { status: 'confirmed' }, producers: { result_published: true, heartbeat_drained: false } };
    vi.spyOn(gateOwnership, 'inspectGateOwnership').mockResolvedValue({ proof });
    expect((await planTaskRecovery(runtimePaths(dir), state)).kind).toBe('wait_for_owners');
    proof.producers.heartbeat_drained = true;
    expect((await planTaskRecovery(runtimePaths(dir), state)).kind).toBe('replace_run');
  });

  it('chooses same-run gates only for unchanged reviewed code, valid admission and remaining attempts', async () => {
    const dir = await project(); const state = await blocked(dir, { dirt: false });
    state.stage = 'gates'; state.receipts = [{ head_tree_sha: await currentTreeSha(dir), ticket_id: state.tickets[0].ticket_id }];
    state.admission = { version: 1, manifest: { version: 1, ready: true } }; state.admission.digest = sha256(state.admission.manifest);
    state.admitted_start_identity_hash = admittedStartIdentityHash(state);
    expect((await planTaskRecovery(runtimePaths(dir), state)).kind).toBe('regate');
    await writeFile(path.join(dir, 'README.md'), 'needs review\n');
    expect((await planTaskRecovery(runtimePaths(dir), state)).kind).toBe('replace_run');
    git(dir, ['restore', 'README.md']);
    state.regate_attempts = Number.MAX_SAFE_INTEGER;
    expect((await planTaskRecovery(runtimePaths(dir), state)).kind).toBe('replace_run');
  });

  it('recovers a blocked task after terminal cleanup returned the checkout to main', async () => {
    const dir = await project(); const state = await blocked(dir, { dirt: false });
    const checkpoint = await checkpoints.saveWorkCheckpoint(runtimePaths(dir), state);
    state.work_checkpoint_id = checkpoint.checkpoint_id;
    await storage.atomicWriteJson(runtimePaths(dir).active, state);
    git(dir, ['switch', 'main']);
    const plan = await resumeRun(dir);
    expect(plan.recovery_plan.kind).toBe('replace_run');
    const restored = await resumeRun(dir, confirm(plan));
    expect(restored.start_input.checkpoint_id).toBe(checkpoint.checkpoint_id);
    expect(restored.start_input.supersedes_run).toBe(state.run_id);
  });

  it('confirms a same-run gate retry under the recovery locks without a replacement branch', async () => {
    const dir = await project(); const state = await blocked(dir, { dirt: false });
    state.stage = 'gates'; state.receipts = [{ head_tree_sha: await currentTreeSha(dir), ticket_id: state.tickets[0].ticket_id,
      status: 'passed', agent: { role: 'implementer', host: 'claude' }, changed_files: [], tests: [], findings: [],
      receipt_hash: 'a'.repeat(64), previous_receipt_hash: null }];
    state.admission = { version: 1, manifest: { version: 1, ready: true } }; state.admission.digest = sha256(state.admission.manifest);
    state.admitted_start_identity_hash = admittedStartIdentityHash(state);
    await storage.atomicWriteJson(runtimePaths(dir).active, state);
    const plan = await resumeRun(dir);
    expect(plan.recovery_plan.kind).toBe('regate');
    const result = await resumeRun(dir, confirm(plan));
    expect(result.ok).toBe(true);
    expect(result.run.run_id).toBe(state.run_id);
    expect(result.run.regate_attempts).toBe(1);
    expect(git(dir, ['branch', '--list', 'ape/recover-*'])).toBe('');
  });
});

describe('guided legacy adoption and task branch cleanup', () => {
  it('requires source selection and context, imports stash staged/deleted/untracked bytes, and keeps the stash', async () => {
    const dir = await project();
    await writeFile(path.join(dir, 'README.md'), 'staged\n'); git(dir, ['add', 'README.md']);
    await writeFile(path.join(dir, 'README.md'), 'working\n');
    await writeFile(path.join(dir, 'new.txt'), 'untracked\n'); await rm(path.join(dir, 'deleted.txt'));
    git(dir, ['stash', 'push', '-u', '-m', 'Resume any task -- untrusted label']);
    const stash = git(dir, ['rev-parse', 'stash@{0}']);
    const discovery = await resumeRun(dir);
    expect(discovery.next_action.kind).toBe('choose_recovery');
    const legacy_candidate_id = discovery.recovery_plan.legacy.candidates[0].legacy_candidate_id;
    expect((await resumeRun(dir, { legacy_candidate_id })).next_action.kind).toBe('provide_recovery_context');
    const options = { legacy_candidate_id, recovery_context: input };
    const plan = await resumeRun(dir, options);
    const result = await resumeRun(dir, confirm(plan, options));
    expect(result.start_input.supersedes_run).toBeUndefined();
    const cp = await checkpoints.readWorkCheckpoint(runtimePaths(dir), result.start_input.checkpoint_id);
    expect(cp.source_run_id).toBeNull(); expect(cp.provenance.association).toBe('user-confirmed');
    expect(git(dir, ['show', `${cp.git_ref}-index:README.md`])).toBe('staged');
    expect(await readFile(path.join(dir, 'README.md'), 'utf8')).toBe('working\n');
    expect(await readFile(path.join(dir, 'new.txt'), 'utf8')).toBe('untracked\n');
    expect(git(dir, ['ls-tree', '--name-only', 'HEAD'])).not.toContain('deleted.txt');
    expect(git(dir, ['rev-parse', 'stash@{0}'])).toBe(stash);
    expect((await freshStart(dir, result)).ok).toBe(true);
  });

  it('rejects a changed stash selector and preserves unrelated working files on import', async () => {
    const dir = await project(); await writeFile(path.join(dir, 'README.md'), 'saved\n'); git(dir, ['stash', 'push', '-m', 'old']);
    const discovery = await resumeRun(dir);
    const options = { legacy_candidate_id: discovery.recovery_plan.legacy.candidates[0].legacy_candidate_id, recovery_context: input };
    const plan = await resumeRun(dir, options);
    await writeFile(path.join(dir, 'README.md'), 'newer\n'); git(dir, ['stash', 'push', '-m', 'new']);
    await expect(resumeRun(dir, confirm(plan, options))).rejects.toThrow('legacy candidate');
    expect(git(dir, ['stash', 'list']).split('\n')).toHaveLength(2);
    const current = await resumeRun(dir); options.legacy_candidate_id = current.recovery_plan.legacy.candidates[0].legacy_candidate_id;
    await writeFile(path.join(dir, 'new.txt'), 'independent work\n');
    const next = await resumeRun(dir, options);
    const result = await resumeRun(dir, confirm(next, options));
    expect(result.code).toBe('recovery-worktree-changed');
    expect(await readFile(path.join(dir, 'new.txt'), 'utf8')).toBe('independent work\n');
  });

  it('removes superseded branches only after completion, retaining moved tips, checked-out and user branches', async () => {
    const dir = await project(); const old = await blocked(dir);
    const first = await checkpoints.saveWorkCheckpoint(runtimePaths(dir), old);
    git(dir, ['add', 'README.md', 'new.txt', 'deleted.txt']); git(dir, ['commit', '-qm', 'retained changes']);
    git(dir, ['switch', '-c', 'ape/recovery-second']);
    const later = { ...old, branch: 'ape/recovery-second', checkpoint_id: first.checkpoint_id };
    const second = await checkpoints.saveWorkCheckpoint(runtimePaths(dir), later);
    const completed = { status: 'completed', checkpoint_id: second.checkpoint_id };
    expect(await cleanupRecoveryLineage(runtimePaths(dir), { ...completed, status: 'blocked' })).toBeNull();
    const pending = await cleanupRecoveryLineage(runtimePaths(dir), completed);
    expect(pending.status).toBe('pending');
    expect(pending.branches.every((entry) => entry.status === 'retained')).toBe(true);
    git(dir, ['switch', 'main']);
    const finish = await cleanupRecoveryLineage(runtimePaths(dir), completed);
    expect(finish.branches.find((entry) => entry.branch === later.branch).status).toBe('removed');
    expect(finish.branches.find((entry) => entry.branch === old.branch).status).toBe('retained');
    expect(git(dir, ['show-ref', '--verify', first.git_ref])).toContain(first.snapshot_commit);
    git(dir, ['branch', 'user-work']); git(dir, ['switch', 'user-work']);
    const user = await checkpoints.saveWorkCheckpoint(runtimePaths(dir), { ...old, branch: 'user-work', checkpoint_id: second.checkpoint_id });
    git(dir, ['switch', 'main']);
    const untouched = await cleanupRecoveryLineage(runtimePaths(dir), { ...completed, checkpoint_id: user.checkpoint_id });
    expect(untouched.branches.find((entry) => entry.branch === 'user-work').status).toBe('retained');
  });

  it('retains a source checked out in another worktree and retries cleanup after it is released', async () => {
    const dir = await project(); const old = await blocked(dir, { dirt: false });
    const cp = await checkpoints.saveWorkCheckpoint(runtimePaths(dir), old);
    git(dir, ['switch', 'main']);
    const parent = await mkdtemp(path.join(tmpdir(), 'ape-checked-out-recovery-')); dirs.push(parent);
    const other = path.join(parent, 'worktree'); git(dir, ['worktree', 'add', other, old.branch]);
    const state = { status: 'completed', checkpoint_id: cp.checkpoint_id };
    const retained = await cleanupRecoveryLineage(runtimePaths(dir), state);
    expect(retained.branches[0]).toMatchObject({ status: 'retained', reason: expect.stringContaining('checked out') });
    git(dir, ['worktree', 'remove', other]);
    expect((await cleanupRecoveryLineage(runtimePaths(dir), state)).status).toBe('complete');
    expect((await cleanupRecoveryLineage(runtimePaths(dir), state)).status).toBe('complete');
  });

  it('reports retained cleanup separately and still offers other unfinished tasks after completion', async () => {
    const dir = await project(); const state = await blocked(dir, { dirt: false });
    git(dir, ['switch', '-c', 'user-saved']);
    const cp = await checkpoints.saveWorkCheckpoint(runtimePaths(dir), { ...state, branch: 'user-saved' });
    git(dir, ['switch', 'main']); git(dir, ['branch', 'ape/legacy-extra']);
    await storage.atomicWriteJson(runtimePaths(dir).active, { ...state, status: 'completed', stage: 'complete',
      checkpoint_id: cp.checkpoint_id, checkout_cleanup: { status: 'returned' } });
    const result = await resumeRun(dir);
    expect(result.run.status).toBe('completed');
    expect(result.run.recovery_cleanup.status).toBe('pending');
    expect(result.recovery_plan.legacy.candidates.some((entry) => entry.source === 'ape/legacy-extra')).toBe(true);
    expect(result.next_action.kind).toBe('choose_recovery');
  });

  it('keeps bounded recovery selectors and digests actionable on an oversized status', () => {
    const response = projectRunResponse({ ok: true, active: true, run: { run_id: 'run-test-abc', status: 'blocked', objective: '😀'.repeat(30_000) },
      recovery_plan: { version: 1, kind: 'replace_run', expected_recovery_digest: 'a'.repeat(64), reason: 'Inspect the original blocker' }, next_action: { kind: 'confirm_recovery' } });
    expect(Buffer.byteLength(JSON.stringify(response))).toBeLessThanOrEqual(RESPONSE_BUDGET_BYTES);
    expect(response.recovery_plan.expected_recovery_digest).toBe('a'.repeat(64));
    expect(response.next_action.kind).toBe('confirm_recovery');
  });
});
