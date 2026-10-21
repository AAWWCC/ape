import { afterEach, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { resumeRun, startRun } from '../lib/runtime/service.js';
import { runtimePaths } from '../lib/runtime/paths.js';
import * as storage from '../lib/runtime/storage.js';
import * as checkpoints from '../lib/runtime/work-checkpoints.js';
import { codexInjectedDispatchContext } from '../lib/runtime/adapters.js';
import { gitFixtureEnv } from '../test-support/git-fixtures.js';

const dirs = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

const git = (dir, ...args) => execFileSync('git', args, { env: gitFixtureEnv(), cwd: dir, encoding: 'utf8' }).trim();

async function project() {
  const dir = await mkdtemp(path.join(tmpdir(), 'ape-single-step-resume-'));
  dirs.push(dir);
  git(dir, 'init', '-q', '-b', 'main');
  git(dir, 'config', 'user.name', 'APE Test');
  git(dir, 'config', 'user.email', 'ape@example.test');
  git(dir, 'config', 'core.autocrlf', 'false');
  await writeFile(path.join(dir, '.gitignore'), '.ape/\n.env\n');
  await writeFile(path.join(dir, 'README.md'), '# Base documentation\n');
  git(dir, 'add', '.');
  git(dir, 'commit', '-qm', 'baseline');
  await storage.atomicWriteJson(runtimePaths(dir).config, {
    shipping: { auto_merge: false, required_remote_checks: false },
    test_commands: { full: 'node -e "process.exit(0)"', targeted_template: 'node -e "process.exit(0)"' },
  });
  return dir;
}

async function createBlockedRun(dir, { host = 'claude', blockReason = 'Worker failed to complete the documentation: syntax error in index.js' } = {}) {
  const input = {
    objective: 'Implement feature documentation',
    mode: 'phase',
    lane: 'mechanical',
    host,
    behavioral: false,
    claimed_paths: ['README.md', 'docs/feature.md'],
    test_paths: [],
    requirements: [],
    risk_triggers: [],
    hooks_trusted: true,
    subagents_available: true,
    explicit_invocation: true,
  };
  const started = await startRun(dir, input);
  expect(started.ok).toBe(true);
  const paths = runtimePaths(dir);
  const state = await storage.readJson(paths.active);
  state.status = 'blocked';
  state.stage = 'build';
  state.block_reason = blockReason;
  await storage.atomicWriteJson(paths.active, state);
  await storage.atomicWriteJson(path.join(paths.runs, `${state.run_id}.json`), state);

  // Add unstaged and staged edits
  await writeFile(path.join(dir, 'README.md'), '# Modified base documentation\n');
  git(dir, 'add', 'README.md');
  await mkdir(path.join(dir, 'docs'), { recursive: true });
  await writeFile(path.join(dir, 'docs/feature.md'), '# Feature Documentation\nDraft in progress.\n');

  return state;
}

describe('single-step self-healing resume (R2)', () => {
  it('collapses multi-step recovery into a single transition and launches replacement run in-place', async () => {
    const dir = await project();
    const blocked = await createBlockedRun(dir);
    const paths = runtimePaths(dir);

    const result = await resumeRun(dir, { explicit_invocation: true });
    expect(result.ok).toBe(true);
    expect(result.run).toBeDefined();
    expect(result.run.run_id).not.toBe(blocked.run_id);
    expect(result.run.status).toBe('running');
    expect(result.run.supersedes_run).toBe(blocked.run_id);
    expect(result.run.checkpoint_id).toMatch(/^checkpoint-[0-9a-f]{32}$/);

    // Active state matches the new replacement run
    const active = await storage.readJson(paths.active);
    expect(active.run_id).toBe(result.run.run_id);
    expect(active.supersedes_run).toBe(blocked.run_id);

    // Old run is archived in history
    const history = await storage.readJson(path.join(paths.history, `${blocked.run_id}.json`));
    expect(history.run_id).toBe(blocked.run_id);
    expect(history.status).toBe('blocked');
  });

  it('preserves work checkpoint on recovery branch with uncommitted edits intact', async () => {
    const dir = await project();
    const blocked = await createBlockedRun(dir);
    const paths = runtimePaths(dir);

    const result = await resumeRun(dir, { explicit_invocation: true });
    expect(result.ok).toBe(true);

    const checkpointId = result.run.checkpoint_id;
    const checkpoint = await checkpoints.readWorkCheckpoint(paths, checkpointId);
    expect(checkpoint.source_run_id).toBe(blocked.run_id);

    // Checkpoint continuation is marked immediately
    const continued = await access(path.join(paths.checkpoints, `${checkpointId}.continued.json`)).then(() => true, () => false);
    expect(continued).toBe(true);

    // Current branch is recovery branch
    const branch = git(dir, 'branch', '--show-current');
    expect(branch).toMatch(/^ape\/recover-/);

    // Restored files preserve checkpointed edits
    expect(await readFile(path.join(dir, 'README.md'), 'utf8')).toBe('# Modified base documentation\n');
    expect(await readFile(path.join(dir, 'docs/feature.md'), 'utf8')).toBe('# Feature Documentation\nDraft in progress.\n');
  });

  it('injects prior blocker failure reason into Claude worker dispatch prompt', async () => {
    const dir = await project();
    const blockReason = 'Worker failed to complete tests: ReferenceError foo is not defined';
    await createBlockedRun(dir, { host: 'claude', blockReason });

    const result = await resumeRun(dir, { explicit_invocation: true });
    expect(result.ok).toBe(true);

    const ticket = result.run.tickets[0];
    expect(ticket.recovery_feedback).toContain('ReferenceError foo is not defined');

    // Prompt contains prior blocker feedback
    const dispatchAction = result.actions?.find((a) => a.type === 'dispatch_agent');
    const prompt = dispatchAction?.dispatch?.dispatch_intent?.prompt ?? dispatchAction?.dispatch_intent?.prompt ?? dispatchAction?.prompt;
    expect(prompt).toContain('Prior execution blocker feedback:');
    expect(prompt).toContain(blockReason);
  });

  it('renders prior blocker failure reason into Codex authoritative dispatch context', async () => {
    const dir = await project();
    const blockReason = 'SyntaxError: Unexpected token in config.json';
    await createBlockedRun(dir, { host: 'codex', blockReason });

    const result = await resumeRun(dir, { explicit_invocation: true });
    expect(result.ok).toBe(true);

    const ticket = result.run.tickets[0];
    expect(ticket.recovery_feedback).toContain('SyntaxError: Unexpected token in config.json');

    const context = codexInjectedDispatchContext(ticket);
    expect(context).toContain('Prior execution blocker feedback');
    expect(context).toContain(blockReason);
  });

  it('breaks writer lock held by blocked run and secures lock for new run', async () => {
    const dir = await project();
    const blocked = await createBlockedRun(dir);
    const paths = runtimePaths(dir);

    // Lock file is present
    expect(await access(paths.lock).then(() => true, () => false)).toBe(true);

    const result = await resumeRun(dir, { explicit_invocation: true });
    expect(result.ok).toBe(true);

    const lock = await storage.readJson(paths.lock);
    expect(lock.run_id).toBe(result.run.run_id);
  });

  it('delegates to regateRunLocked when gate failure has remaining attempts rather than replacing run', async () => {
    const dir = await project();
    const input = {
      objective: 'Run gated verification',
      mode: 'phase',
      lane: 'mechanical',
      host: 'claude',
      behavioral: false,
      claimed_paths: ['README.md'],
      test_paths: [],
      requirements: [],
      risk_triggers: [],
      hooks_trusted: true,
      subagents_available: true,
      explicit_invocation: true,
    };
    const started = await startRun(dir, input);
    expect(started.ok).toBe(true);
    const paths = runtimePaths(dir);
    const state = await storage.readJson(paths.active);

    state.status = 'blocked';
    state.stage = 'gates';
    state.block_reason = 'Gate test run failed';
    state.regate_attempts = 0;
    await storage.atomicWriteJson(paths.active, state);

    const result = await resumeRun(dir, { explicit_invocation: true });
    expect(result.ok).toBe(true);
    // Same run preserved for regate
    expect(result.run.run_id).toBe(state.run_id);
  });
});
