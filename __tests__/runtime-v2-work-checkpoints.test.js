import { afterEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { access, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { overrideRun, previewRun, resumeRun, startRun } from '../lib/runtime/service.js';
import { compactStatus } from '../lib/runtime/status-service.js';
import { runtimePaths } from '../lib/runtime/paths.js';
import { atomicWriteJson, readJson } from '../lib/runtime/storage.js';
import { discoverWorkCheckpoints, readWorkCheckpoint, saveWorkCheckpoint } from '../lib/runtime/work-checkpoints.js';
import { projectRunResponse, RESPONSE_BUDGET_BYTES } from '../lib/runtime/projection.js';
import { loadSessionGuidance } from '../lib/runtime/session-guidance.js';
import { sha256 } from '../lib/runtime/canonical.js';
import { applyActions } from '../lib/runtime/receipt-service.js';
import { loadRuntimeConfig } from '../lib/runtime/config.js';

const dirs = [];
afterEach(async () => Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))));
const git = (dir, args, options = {}) => execFileSync('git', args, { cwd: dir, encoding: 'utf8', ...options }).trim();
const exists = (file) => access(file).then(() => true, () => false);

async function project() {
  const dir = await mkdtemp(path.join(tmpdir(), 'ape-work-checkpoint-'));
  dirs.push(dir);
  git(dir, ['init', '-q', '-b', 'main']);
  git(dir, ['config', 'user.name', 'APE Test']);
  git(dir, ['config', 'user.email', 'ape@example.test']);
  git(dir, ['config', 'core.autocrlf', 'false']);
  await writeFile(path.join(dir, '.gitignore'), '.ape/\n.env\n');
  await writeFile(path.join(dir, 'README.md'), 'baseline\n');
  await writeFile(path.join(dir, 'deleted.txt'), 'remove me\n');
  git(dir, ['add', '.']);
  git(dir, ['commit', '-qm', 'baseline']);
  await atomicWriteJson(runtimePaths(dir).config, {
    shipping: { auto_merge: false, provider: 'github', required_remote_checks: false },
    test_commands: { full: 'node --test', targeted_template: 'node --test {paths}' },
  });
  return dir;
}

async function blocked(dir, suffix = '') {
  const started = await startRun(dir, {
    objective: `Finish the retained documentation ${suffix}`, mode: 'phase', lane: 'mechanical', host: 'claude',
    claimed_paths: ['README.md', 'new.txt', 'deleted.txt'], test_paths: [], requirements: [], risk_triggers: [], behavioral: false,
    hooks_trusted: true, subagents_available: true, explicit_invocation: true,
  });
  expect(started.ok).toBe(true);
  const state = await readJson(runtimePaths(dir).active);
  state.status = 'blocked';
  state.stage = 'build';
  state.block_reason = 'Synthetic worker failure; inspect before retry';
  await atomicWriteJson(runtimePaths(dir).active, state);
  await writeFile(path.join(dir, 'README.md'), 'staged version\n');
  git(dir, ['add', 'README.md']);
  await writeFile(path.join(dir, 'README.md'), 'retained work\n');
  await writeFile(path.join(dir, 'new.txt'), 'untracked retained work\n');
  await rm(path.join(dir, 'deleted.txt'));
  await writeFile(path.join(dir, '.env'), 'ignored secret\n');
  return state;
}

async function reset(dir) {
  const result = await overrideRun(dir, 'reset', 'Explicit operator recovery');
  expect(result.ok).toBe(true);
  return result.actions.find((action) => action.type === 'work_checkpoint_saved').checkpoint;
}

async function advanceMain(dir, file = 'upstream.txt', content = 'upstream work\n') {
  const scratch = await mkdtemp(path.join(tmpdir(), 'ape-checkpoint-index-'));
  dirs.push(scratch);
  const env = { ...process.env, GIT_INDEX_FILE: path.join(scratch, 'index') };
  const parent = git(dir, ['rev-parse', 'main']);
  git(dir, ['read-tree', parent], { env });
  const blob = git(dir, ['hash-object', '-w', '--stdin'], { input: content });
  git(dir, ['update-index', '--add', '--cacheinfo', `100644,${blob},${file}`], { env });
  const tree = git(dir, ['write-tree'], { env });
  const commit = git(dir, ['commit-tree', tree, '-p', parent, '-m', 'upstream change']);
  git(dir, ['update-ref', 'refs/heads/main', commit, parent]);
  return commit;
}

describe('durable unfinished work recovery', () => {
  it('reset pins modified, deleted, untracked and index-only bytes without changing checkout; survives GC', async () => {
    const dir = await project();
    const state = await blocked(dir);
    const before = git(dir, ['status', '--porcelain=v1']);
    const head = git(dir, ['rev-parse', 'HEAD']);
    const summary = await reset(dir);
    expect(await exists(runtimePaths(dir).active)).toBe(false);
    expect(git(dir, ['status', '--porcelain=v1'])).toBe(before);
    expect(git(dir, ['rev-parse', 'HEAD'])).toBe(head);
    git(dir, ['gc', '--prune=now']);
    const record = await readWorkCheckpoint(runtimePaths(dir), summary.checkpoint_id);
    expect(record.source_run_id).toBe(state.run_id);
    expect(record.start_input.objective).toBe(state.objective);
    expect(git(dir, ['show', `${record.git_ref}:README.md`])).toBe('retained work');
    expect(git(dir, ['show', `${record.git_ref}:new.txt`])).toBe('untracked retained work');
    expect(git(dir, ['show', `${record.git_ref}-index:README.md`])).toBe('staged version');
    const files = git(dir, ['ls-tree', '-r', '--name-only', record.git_ref]);
    expect(files).not.toContain('deleted.txt');
    expect(files).not.toContain('.env');
    expect(files).not.toContain('.ape/');
    const status = await compactStatus(dir);
    expect(status.active).toBe(false);
    expect(status.work_recovery.count).toBe(1);
    expect(status.next_safe_action).toContain('resume');
    expect(JSON.stringify(status)).not.toContain(state.objective);
    const resume = await resumeRun(dir);
    expect(resume.next_action).toEqual({ kind: 'recover_checkpoint', checkpoint_id: record.checkpoint_id });
    expect(projectRunResponse(resume).next_action).toEqual(resume.next_action);
    expect(await loadSessionGuidance(dir, { host: 'claude' })).toContain('unfinished work checkpoints');
    expect(git(dir, ['status', '--porcelain=v1'])).toBe(before);
  });

  it('restores onto updated main and starts a fresh run with new authority and linked history', async () => {
    const dir = await project();
    const previous = await blocked(dir);
    const originalBranch = git(dir, ['branch', '--show-current']);
    const originalHead = git(dir, ['rev-parse', 'HEAD']);
    const checkpoint = await reset(dir);
    const main = await advanceMain(dir);
    const resumed = await resumeRun(dir, { checkpoint_id: checkpoint.checkpoint_id, explicit_invocation: true });
    expect(resumed.ok).toBe(true);
    expect(resumed.next_action.kind).toBe('start_recovered_work');
    expect(projectRunResponse(resumed).next_action).toEqual(resumed.next_action);
    const bounded = projectRunResponse({ ...resumed, start_input: { ...resumed.start_input, objective: 'large context '.repeat(10000) } });
    expect(bounded.next_action).toEqual(resumed.next_action);
    expect(bounded.start_input_ref).toContain(checkpoint.checkpoint_id);
    expect(Buffer.byteLength(JSON.stringify(bounded))).toBeLessThan(RESPONSE_BUDGET_BYTES);
    expect(await readFile(path.join(dir, 'README.md'), 'utf8')).toBe('retained work\n');
    expect(await readFile(path.join(dir, 'new.txt'), 'utf8')).toBe('untracked retained work\n');
    expect(await readFile(path.join(dir, 'upstream.txt'), 'utf8')).toBe('upstream work\n');
    expect(git(dir, ['status', '--porcelain=v1'])).toBe('');
    expect(git(dir, ['rev-parse', originalBranch])).toBe(originalHead);
    expect(git(dir, ['rev-parse', 'HEAD^'])).toBe(main);
    expect(await exists(runtimePaths(dir).active)).toBe(false);
    const head = git(dir, ['rev-parse', 'HEAD']);
    const again = await resumeRun(dir, { checkpoint_id: checkpoint.checkpoint_id, explicit_invocation: true });
    expect(again.start_input).toEqual(resumed.start_input);
    expect(git(dir, ['rev-parse', 'HEAD'])).toBe(head);
    const input = { ...resumed.start_input, hooks_trusted: true, subagents_available: true, explicit_invocation: true };
    const missingPreview = await startRun(dir, input);
    expect(missingPreview.code).toBe('admission-preview-required');
    const preview = await previewRun(dir, input);
    expect(preview.admission.ready, JSON.stringify(preview.admission.blocking)).toBe(true);
    const fresh = await startRun(dir, { ...input, expected_admission_digest: preview.admission_digest });
    expect(fresh.ok).toBe(true);
    expect(fresh.run.run_id).not.toBe(previous.run_id);
    expect(fresh.run.supersedes_run).toBe(previous.run_id);
    expect(fresh.run.checkpoint_id).toBe(checkpoint.checkpoint_id);
    expect(fresh.run.tickets.every((ticket) => ticket.run_id === fresh.run.run_id)).toBe(true);
    expect(fresh.run.receipts).toHaveLength(1);
    expect(fresh.run.receipts[0].evidence.recovery_admission).toBeDefined();
    expect(fresh.run.receipts[0].tests).toEqual([]);
    expect((await discoverWorkCheckpoints(runtimePaths(dir))).count).toBe(0);
  });

  it('offers a choice for multiple unfinished runs and leaves files untouched', async () => {
    const dir = await project();
    const state = await blocked(dir);
    await reset(dir);
    await saveWorkCheckpoint(runtimePaths(dir), { ...state, run_id: 'run-second-fixture', objective: 'Different unfinished task' });
    const before = git(dir, ['status', '--porcelain=v1']);
    const result = await resumeRun(dir);
    expect(result.next_action.kind).toBe('choose_checkpoint');
    expect(result.recovery.count).toBe(2);
    expect(git(dir, ['status', '--porcelain=v1'])).toBe(before);
  });

  it('refuses to overwrite edits made after reset or restore without explicit invocation', async () => {
    const dir = await project();
    await blocked(dir);
    const checkpoint = await reset(dir);
    expect((await resumeRun(dir, { checkpoint_id: checkpoint.checkpoint_id })).ok).toBe(false);
    await writeFile(path.join(dir, 'README.md'), 'newer user work\n');
    const before = git(dir, ['status', '--porcelain=v1']);
    const result = await resumeRun(dir, { checkpoint_id: checkpoint.checkpoint_id, explicit_invocation: true });
    expect(result.code).toBe('recovery-worktree-changed');
    expect(await readFile(path.join(dir, 'README.md'), 'utf8')).toBe('newer user work\n');
    expect(git(dir, ['status', '--porcelain=v1'])).toBe(before);
    expect(await exists(runtimePaths(dir).lock)).toBe(false);
  });

  it('reports a conflict with updated main without touching the original checkout or index', async () => {
    const dir = await project();
    await blocked(dir);
    const checkpoint = await reset(dir);
    await advanceMain(dir, 'README.md', 'conflicting upstream work\n');
    const index = git(dir, ['write-tree']);
    const head = git(dir, ['rev-parse', 'HEAD']);
    const result = await resumeRun(dir, { checkpoint_id: checkpoint.checkpoint_id, explicit_invocation: true });
    expect(result.code).toBe('recovery-base-conflict');
    expect(git(dir, ['rev-parse', 'HEAD'])).toBe(head);
    expect(git(dir, ['write-tree'])).toBe(index);
    expect(await readFile(path.join(dir, 'README.md'), 'utf8')).toBe('retained work\n');
  });

  it('keeps active state if a durable checkpoint cannot be published', async () => {
    const dir = await project();
    const state = await blocked(dir);
    const paths = runtimePaths(dir);
    await writeFile(paths.checkpoints, 'invalid directory');
    const before = git(dir, ['status', '--porcelain=v1']);
    await expect(overrideRun(dir, 'reset', 'Requested reset')).rejects.toThrow('checkpoint directory is unsafe');
    expect((await readJson(paths.active)).run_id).toBe(state.run_id);
    expect(git(dir, ['status', '--porcelain=v1'])).toBe(before);
  });

  it('does not hide corrupt or missing checkpoint data behind no active run', async () => {
    const dir = await project();
    await blocked(dir);
    const checkpoint = await reset(dir);
    git(dir, ['update-ref', '-d', checkpoint.git_ref]);
    const result = await resumeRun(dir);
    expect(result.recovery.unavailable).toBe(1);
    expect(result.reason).toContain('needs inspection');
    await expect(resumeRun(dir, { checkpoint_id: checkpoint.checkpoint_id, explicit_invocation: true })).rejects.toThrow('Git objects are missing');
    expect(await exists(runtimePaths(dir).active)).toBe(false);
  });

  it('refuses redirected checkpoint metadata and invalid selectors', async () => {
    const dir = await project();
    await blocked(dir);
    const checkpoint = await reset(dir);
    const file = path.join(runtimePaths(dir).checkpoints, `${checkpoint.checkpoint_id}.json`);
    const outside = path.join(dir, 'outside.json');
    await writeFile(outside, await readFile(file));
    await rm(file);
    await symlink(outside, file);
    expect((await resumeRun(dir)).recovery.unavailable).toBe(1);
    await expect(resumeRun(dir, { checkpoint_id: '../outside', explicit_invocation: true })).rejects.toThrow('invalid recovery');
  });

  it('does not replace an active run when a checkpoint is selected', async () => {
    const dir = await project();
    const state = await blocked(dir);
    const checkpoint = await saveWorkCheckpoint(runtimePaths(dir), state);
    const result = await resumeRun(dir, { checkpoint_id: checkpoint.checkpoint_id, explicit_invocation: true });
    expect(result.ok).toBe(false);
    expect((await readJson(runtimePaths(dir).active)).run_id).toBe(state.run_id);
  });

  it('recovers from a clean checkout and retries after a prepared-manifest response loss', async () => {
    const dir = await project();
    await blocked(dir);
    const checkpoint = await reset(dir);
    // Simulate the operator separately committing the retained files and moving
    // back to main. The checkpoint must be sufficient to restore all files.
    git(dir, ['add', '-A']);
    git(dir, ['commit', '-qm', 'operator checkpoint']);
    git(dir, ['switch', 'main']);
    expect(await exists(path.join(dir, 'new.txt'))).toBe(false);
    const resumed = await resumeRun(dir, { checkpoint_id: checkpoint.checkpoint_id, explicit_invocation: true });
    const commit = git(dir, ['rev-parse', 'HEAD']);
    await rm(path.join(runtimePaths(dir).checkpoints, `${checkpoint.checkpoint_id}.${resumed.recovery.base_commit}.prepared.json`));
    expect((await resumeRun(dir, { checkpoint_id: checkpoint.checkpoint_id, explicit_invocation: true })).ok).toBe(true);
    expect(git(dir, ['rev-parse', 'HEAD'])).toBe(commit);
    expect(await readFile(path.join(dir, 'new.txt'), 'utf8')).toBe('untracked retained work\n');
  });

  it('rejects narrowed scope and base drift during fresh admission', async () => {
    const dir = await project();
    await blocked(dir);
    const checkpoint = await reset(dir);
    const resumed = await resumeRun(dir, { checkpoint_id: checkpoint.checkpoint_id, explicit_invocation: true });
    const input = { ...resumed.start_input, hooks_trusted: true, subagents_available: true, explicit_invocation: true };
    const narrow = await previewRun(dir, { ...input, claimed_paths: ['README.md'] });
    expect(narrow.admission.ready).toBe(false);
    const preview = await previewRun(dir, input);
    await advanceMain(dir);
    const changed = await startRun(dir, { ...input, expected_admission_digest: preview.admission_digest });
    expect(changed.ok).toBe(false);
    expect(await exists(runtimePaths(dir).active)).toBe(false);
  });

  it('exposes discovery and restoration through the actual MCP boundary', async () => {
    const dir = await project();
    await blocked(dir);
    const checkpoint = await reset(dir);
    const env = { ...process.env };
    delete env.CODEX_CWD;
    delete env.CLAUDE_PROJECT_DIR;
    const tool = (args) => {
      const request = { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'ape_run', arguments: { ...args, project_dir: dir } } };
      const stdout = execFileSync(process.execPath, [fileURLToPath(new URL('../bin/ape-mcp.mjs', import.meta.url))], {
        cwd: dir, env, input: `${JSON.stringify(request)}\n`, encoding: 'utf8', timeout: 20000,
      });
      const response = stdout.trim().split('\n').map((line) => JSON.parse(line)).find((item) => item.id === 1);
      return JSON.parse(response.result.content[0].text);
    };
    expect(tool({ action: 'resume' }).next_action).toEqual({ kind: 'recover_checkpoint', checkpoint_id: checkpoint.checkpoint_id });
    const recovered = tool({ action: 'resume', checkpoint_id: checkpoint.checkpoint_id, explicit_invocation: true });
    expect(recovered.next_action.kind).toBe('start_recovered_work');
    expect(recovered.start_input.checkpoint_id).toBe(checkpoint.checkpoint_id);
  });

  it('keeps task metadata bound to its original checkpoint identity', async () => {
    const dir = await project();
    await blocked(dir);
    const checkpoint = await reset(dir);
    const file = path.join(runtimePaths(dir).checkpoints, `${checkpoint.checkpoint_id}.json`);
    const { record_hash: _old, ...record } = await readJson(file);
    record.start_input.objective = 'Substituted task';
    await atomicWriteJson(file, { ...record, record_hash: sha256(record) });
    await expect(readWorkCheckpoint(runtimePaths(dir), checkpoint.checkpoint_id)).rejects.toThrow('metadata is invalid');
  });

  it('preserves newer commits on a recovery branch when main advances again', async () => {
    const dir = await project();
    await blocked(dir);
    const checkpoint = await reset(dir);
    await resumeRun(dir, { checkpoint_id: checkpoint.checkpoint_id, explicit_invocation: true });
    await writeFile(path.join(dir, 'README.md'), 'additional committed work\n');
    git(dir, ['add', 'README.md']);
    git(dir, ['commit', '-qm', 'additional work']);
    const head = git(dir, ['rev-parse', 'HEAD']);
    await advanceMain(dir);
    const result = await resumeRun(dir, { checkpoint_id: checkpoint.checkpoint_id, explicit_invocation: true });
    expect(result.code).toBe('recovery-branch-changed');
    expect(git(dir, ['rev-parse', 'HEAD'])).toBe(head);
    expect(await readFile(path.join(dir, 'README.md'), 'utf8')).toBe('additional committed work\n');
  });

  it('preserves the original checkpoint when reset runs after returning to main', async () => {
    const dir = await project();
    const state = await blocked(dir);
    const record = await saveWorkCheckpoint(runtimePaths(dir), state);
    state.work_checkpoint_id = record.checkpoint_id;
    state.status = 'aborted';
    await atomicWriteJson(runtimePaths(dir).active, state);
    git(dir, ['add', '-A']);
    git(dir, ['commit', '-qm', 'preserve before returning']);
    git(dir, ['switch', 'main']);
    const summary = await reset(dir);
    expect(summary.checkpoint_id).toBe(record.checkpoint_id);
    expect(git(dir, ['show', `${summary.git_ref}:new.txt`])).toBe('untracked retained work');
  });

  it('retires a blocked checkpoint when the same run later completes', async () => {
    const dir = await project();
    const state = await blocked(dir);
    const record = await saveWorkCheckpoint(runtimePaths(dir), state);
    state.work_checkpoint_id = record.checkpoint_id;
    state.status = 'completed';
    state.stage = 'done';
    await applyActions(runtimePaths(dir), state, [{ type: 'archive_history' }], await loadRuntimeConfig(runtimePaths(dir).config));
    expect((await discoverWorkCheckpoints(runtimePaths(dir))).count).toBe(0);
    expect(git(dir, ['show', `${record.git_ref}:README.md`])).toBe('retained work');
  });

  it('restores all saved files but requires scope review before starting unclaimed changes', async () => {
    const dir = await project();
    await blocked(dir);
    await writeFile(path.join(dir, 'extra.txt'), 'separately authored work\n');
    const checkpoint = await reset(dir);
    const recovered = await resumeRun(dir, { checkpoint_id: checkpoint.checkpoint_id, explicit_invocation: true });
    expect(recovered.next_action.kind).toBe('start_recovered_work');
    expect(await readFile(path.join(dir, 'extra.txt'), 'utf8')).toBe('separately authored work\n');
    const preview = await previewRun(dir, { ...recovered.start_input, hooks_trusted: true, subagents_available: true, explicit_invocation: true });
    expect(preview.admission.ready).toBe(false);
    expect(preview.admission.blocking.some((entry) => entry.code === 'scope-approval-required')).toBe(true);
  });

  it('keeps checkpoint selection usable when Unicode summaries exceed the wire budget', () => {
    const checkpoints = Array.from({ length: 8 }, (_, i) => ({
      checkpoint_id: `checkpoint-${String(i).padStart(32, '0')}`, source_run_id: `run-fixture-${i}`,
      created_at: '2026-10-07T00:00:00.000Z', objective: '🚀'.repeat(1024), failure_reason: '🚀'.repeat(1024),
    }));
    const response = projectRunResponse({ ok: true, active: false, run: null,
      recovery: { count: 8, checkpoints, unavailable: 0, truncated: false }, next_action: { kind: 'choose_checkpoint' } });
    expect(Buffer.byteLength(JSON.stringify(response))).toBeLessThan(RESPONSE_BUDGET_BYTES);
    expect(response.recovery.checkpoints).toHaveLength(8);
    expect(response.recovery.checkpoints[0].manifest_ref).toContain(checkpoints[0].checkpoint_id);
  });

  it('admits reviewed reconciliation commits without replaying the original snapshot over them', async () => {
    const dir = await project();
    await blocked(dir);
    await writeFile(path.join(dir, 'extra.txt'), 'unrelated work\n');
    const checkpoint = await reset(dir);
    await resumeRun(dir, { checkpoint_id: checkpoint.checkpoint_id, explicit_invocation: true });
    // The operator excludes unrelated work from the continuation. The complete
    // original backup remains pinned; admission must inspect the new commit.
    git(dir, ['rm', 'extra.txt']);
    git(dir, ['commit', '-qm', 'reconcile recovery scope']);
    const head = git(dir, ['rev-parse', 'HEAD']);
    const recovered = await resumeRun(dir, { checkpoint_id: checkpoint.checkpoint_id, explicit_invocation: true });
    expect(recovered.ok).toBe(true);
    expect(git(dir, ['rev-parse', 'HEAD'])).toBe(head);
    expect(await exists(path.join(dir, 'extra.txt'))).toBe(false);
    const input = { ...recovered.start_input, hooks_trusted: true, subagents_available: true, explicit_invocation: true };
    const preview = await previewRun(dir, input);
    expect(preview.admission.ready).toBe(true);
    const started = await startRun(dir, { ...input, expected_admission_digest: preview.admission_digest });
    expect(started.ok).toBe(true);
    expect(git(dir, ['rev-parse', 'HEAD'])).toBe(head);
    expect(git(dir, ['show', `${checkpoint.git_ref}:extra.txt`])).toBe('unrelated work');
  });
});
