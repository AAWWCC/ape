import { execFileSync, spawn } from 'node:child_process';
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import {
  evaluateLifecyclePolicy,
  normalizeLifecycleEvent,
  pathResolvesOutsideProject,
} from '../lib/runtime/hooks.js';
import { runtimePaths } from '../lib/runtime/paths.js';
import { currentTreeSha } from '../lib/runtime/git.js';
import { atomicWriteJson } from '../lib/runtime/storage.js';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const hookBinary = path.join(root, 'bin', 'ape-hook.mjs');
const cleanups = [];

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

// A write whose target genuinely resolves outside the project root is outside
// APE's governance: invariant 2 protects production paths, not the host
// scratchpad. Regression guard for the friction case where a blocked run
// denied every out-of-project write with "no active writing run".
//
// NARROWED, NOT RETIRED (roadmap readonly-out-of-project-tool-config-write). A
// BOUND ticket's out-of-project write to an execution-redirecting tool-config or
// shell-startup tail — `$HOME/.npmrc`, `.bashrc`, `.config/git/config`, … — is
// refused ahead of this exemption, because such a file changes what an
// already-admitted evidence command (`npm test`, `git status`) executes with no
// token on the command line. That refusal is target-shaped and owns its own
// suite: __tests__/runtime-v2-readonly-tool-config-write.test.js. Every target
// in THIS file is an ordinary scratchpad path carrying no covered tail, so these
// arms are the over-block guard for that narrowing and must stay green — the
// host directs read-only roles to write their temp files outside the project,
// and a rule that refuses writes near $HOME is exactly the shape that can
// strand a subagent's own scratchpad.
describe('APE v2 out-of-project write exemption (policy ordering)', () => {
  const writeEvent = (overrides = {}) => ({
    host: 'claude',
    event: 'PreToolUse',
    tool_name: 'Write',
    is_subagent: false,
    file: null,
    target_path: '/outside/x',
    ...overrides,
  });
  const writableTicket = {
    ticket_id: 'run-1:build:b',
    role: 'implementer',
    writable: true,
    claimed_paths: ['src'],
    test_paths: ['__tests__'],
  };

  it('allows an out-of-project write while the run is blocked (precedes the no-active-writing-run deny)', () => {
    const result = evaluateLifecyclePolicy(
      writeEvent({ out_of_project: true }),
      { state: { status: 'blocked' }, ticket: null },
    );
    expect(result.decision).toBe('allow');
    expect(result.reason).toMatch(/outside the project root/);
  });

  it('allows an out-of-project write from the main session during a running run (precedes the main-session deny)', () => {
    const result = evaluateLifecyclePolicy(
      writeEvent({ out_of_project: true }),
      { state: { status: 'running' }, ticket: null },
    );
    expect(result.decision).toBe('allow');
    expect(result.reason).toMatch(/outside the project root/);
  });

  it('allows an out-of-project write for a bound writable subagent whose claims would not cover it (precedes claim checks)', () => {
    const result = evaluateLifecyclePolicy(
      writeEvent({ out_of_project: true, is_subagent: true, ape_managed: true }),
      { state: { status: 'running' }, ticket: writableTicket },
    );
    expect(result.decision).toBe('allow');
    expect(result.reason).toMatch(/outside the project root/);
  });

  it('still denies an ape-managed Claude subagent with no binding even for an out-of-project target', () => {
    const result = evaluateLifecyclePolicy(
      writeEvent({ out_of_project: true, is_subagent: true }),
      { state: { status: 'running' }, ticket: null },
    );
    expect(result.decision).toBe('deny');
    expect(result.reason).toMatch(/no exact active binding/);
  });

  it('fails closed when the flag is absent or false', () => {
    const noPath = evaluateLifecyclePolicy(
      writeEvent({ target_path: null, is_subagent: true, ape_managed: true }),
      { state: { status: 'running' }, ticket: writableTicket },
    );
    expect(noPath.decision).toBe('deny');

    const aliasedInside = evaluateLifecyclePolicy(
      writeEvent({ out_of_project: false, is_subagent: true, ape_managed: true }),
      { state: { status: 'running' }, ticket: writableTicket },
    );
    expect(aliasedInside.decision).toBe('deny');

    const blockedRun = evaluateLifecyclePolicy(
      writeEvent(),
      { state: { status: 'blocked' }, ticket: null },
    );
    expect(blockedRun.decision).toBe('deny');
    expect(blockedRun.reason).toMatch(/run is blocked/);
    expect(blockedRun.reason).toMatch(/REGATE/);
    expect(blockedRun.reason).toMatch(/OVERRIDE reset or ABORT/);
  });

  // Truthful completion leaves the sealed run in active.json indefinitely;
  // the guard must not keep governing the host off that record, or every
  // main-session edit is denied from phase completion until the next run.
  it('allows a main-session in-project write once the run is sealed completed', () => {
    const result = evaluateLifecyclePolicy(
      writeEvent({ file: 'docs/notes.md', target_path: 'docs/notes.md' }),
      { state: { status: 'completed' }, ticket: null },
    );
    expect(result.decision).toBe('allow');
    expect(result.reason).toMatch(/sealed completed/);
  });

  it('allows a main-session in-project write once the run is sealed aborted', () => {
    const result = evaluateLifecyclePolicy(
      writeEvent({ file: 'docs/notes.md', target_path: 'docs/notes.md' }),
      { state: { status: 'aborted' }, ticket: null },
    );
    expect(result.decision).toBe('allow');
    expect(result.reason).toMatch(/sealed aborted/);
  });

  it('still denies a main-session in-project write while a run is blocked', () => {
    const result = evaluateLifecyclePolicy(
      writeEvent({ file: 'docs/notes.md', target_path: 'docs/notes.md' }),
      { state: { status: 'blocked' }, ticket: null },
    );
    expect(result.decision).toBe('deny');
    expect(result.reason).toMatch(/run is blocked/);
  });

  // The blocked-run denial names its audited exits, but it must not swallow
  // the generic absent-run message: a present-but-non-blocked, non-sealed
  // status (e.g. transient 'shipping') still reads 'no active writing run'.
  it('names the audited exits for a blocked run without swallowing the generic denial', () => {
    const blocked = evaluateLifecyclePolicy(
      writeEvent({ file: 'docs/notes.md', target_path: 'docs/notes.md' }),
      { state: { status: 'blocked' }, ticket: null },
    );
    expect(blocked.decision).toBe('deny');
    expect(blocked.reason).toMatch(/run is blocked/);
    expect(blocked.reason).toMatch(/REGATE/);

    const shipping = evaluateLifecyclePolicy(
      writeEvent({ file: 'docs/notes.md', target_path: 'docs/notes.md' }),
      { state: { status: 'shipping' }, ticket: null },
    );
    expect(shipping.decision).toBe('deny');
    expect(shipping.reason).toMatch(/no active writing run/);
  });
});

describe('APE v2 normalizeLifecycleEvent target_path disambiguation', () => {
  const projectDir = path.resolve('/proj');

  it('distinguishes no-path payloads from lexically-outside paths', () => {
    const noPath = normalizeLifecycleEvent(
      { project_dir: projectDir, hook_event_name: 'PreToolUse', tool_name: 'Write', tool_input: {} },
      {},
    );
    expect(noPath.file).toBe(null);
    expect(noPath.target_path).toBe(null);

    const outside = normalizeLifecycleEvent(
      {
        project_dir: projectDir,
        hook_event_name: 'PreToolUse',
        tool_name: 'Write',
        tool_input: { file_path: '/outside/x.txt' },
      },
      {},
    );
    expect(outside.file).toBe(null);
    expect(outside.target_path).toBe(path.resolve('/outside/x.txt'));

    const inside = normalizeLifecycleEvent(
      {
        project_dir: projectDir,
        hook_event_name: 'PreToolUse',
        tool_name: 'Write',
        tool_input: { file_path: 'src/a.js' },
      },
      {},
    );
    expect(inside.file).toBe('src/a.js');
    expect(inside.target_path).toBe(path.join(projectDir, 'src', 'a.js'));
  });
});

describe('APE v2 pathResolvesOutsideProject', () => {
  async function dirs() {
    const projectDir = await mkdtemp(path.join(tmpdir(), 'ape-oop-project-'));
    const outside = await mkdtemp(path.join(tmpdir(), 'ape-oop-outside-'));
    cleanups.push(projectDir, outside);
    await mkdir(path.join(projectDir, 'src'), { recursive: true });
    return { projectDir, outside };
  }

  it('is true for existing and not-yet-existing targets outside the project', async () => {
    const { projectDir, outside } = await dirs();
    expect(await pathResolvesOutsideProject(projectDir, outside)).toBe(true);
    expect(await pathResolvesOutsideProject(projectDir, path.join(outside, 'a', 'b', 'c.txt'))).toBe(true);
  });

  it('is false for an in-project path and for the project root itself', async () => {
    const { projectDir } = await dirs();
    expect(await pathResolvesOutsideProject(projectDir, path.join(projectDir, 'src', 'a.js'))).toBe(false);
    expect(await pathResolvesOutsideProject(projectDir, projectDir)).toBe(false);
  });

  it('is false for an outside symlink whose realpath lands inside the project', async () => {
    const { projectDir, outside } = await dirs();
    await symlink(path.join(projectDir, 'src'), path.join(outside, 'link'));
    expect(
      await pathResolvesOutsideProject(projectDir, path.join(outside, 'link', 'value.js')),
    ).toBe(false);
  });
});

function git(cwd, ...args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

async function project(status = 'running') {
  const dir = await mkdtemp(path.join(tmpdir(), 'ape-oop-hook-'));
  cleanups.push(dir);
  await mkdir(path.join(dir, 'src'), { recursive: true });
  await writeFile(path.join(dir, 'src', 'value.js'), 'export const value = 1;\n');
  git(dir, 'init', '-q');
  git(dir, 'config', 'user.email', 'ape@example.test');
  git(dir, 'config', 'user.name', 'APE Test');
  git(dir, 'add', '.');
  git(dir, 'commit', '-qm', 'test: baseline');
  const baseline = await currentTreeSha(dir);
  await atomicWriteJson(runtimePaths(dir).active, {
    run_id: 'run-out-of-project',
    status,
    tree_sha: baseline,
    tickets: [
      {
        ticket_id: 'run-out-of-project:build:b',
        role: 'implementer',
        writable: true,
        claimed_paths: ['src'],
        test_paths: ['__tests__'],
        base_tree_sha: baseline,
      },
    ],
    receipts: [],
  });
  return dir;
}

async function outsideDir() {
  const dir = await mkdtemp(path.join(tmpdir(), 'ape-oop-scratch-'));
  cleanups.push(dir);
  return dir;
}

// Environment for the spawned binary: force the Claude host and strip any
// host-provided project hints so only the payload under test decides.
function claudeEnv() {
  const env = { ...process.env, CLAUDECODE: '1' };
  delete env.CLAUDE_PROJECT_DIR;
  delete env.CODEX_CWD;
  return env;
}

function invokeHook(input, cwd) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [hookBinary], {
      cwd,
      env: claudeEnv(),
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code !== 0) reject(new Error(stderr));
      else resolve(JSON.parse(stdout));
    });
    child.stdin.end(`${JSON.stringify(input)}\n`);
  });
}

function preToolUseWrite(dir, filePath) {
  return {
    hook_event_name: 'PreToolUse',
    project_dir: dir,
    session_id: 's1',
    tool_name: 'Write',
    tool_input: { file_path: filePath, content: 'scratch' },
  };
}

describe('APE v2 hook binary out-of-project writes', () => {
  it('allows a blocked-run main-session write to a scratch dir outside the project', async () => {
    const dir = await project('blocked');
    const scratch = await outsideDir();

    const response = await invokeHook(preToolUseWrite(dir, path.join(scratch, 'notes.md')), dir);

    expect(response.hookSpecificOutput.permissionDecision).toBe('allow');
  });

  it('allows a running-run out-of-project write but still denies the in-project one', async () => {
    const dir = await project();
    const scratch = await outsideDir();

    const outside = await invokeHook(preToolUseWrite(dir, path.join(scratch, 'notes.md')), dir);
    expect(outside.hookSpecificOutput.permissionDecision).toBe('allow');

    const inside = await invokeHook(preToolUseWrite(dir, path.join(dir, 'src', 'value.js')), dir);
    expect(inside.hookSpecificOutput.permissionDecision).toBe('deny');
    expect(inside.hookSpecificOutput.permissionDecisionReason)
      .toMatch(/main-session production writes are forbidden/);
  });

  it('denies a raw-outside path whose realpath lands inside the project (symlink attack A)', async () => {
    const dir = await project();
    const scratch = await outsideDir();
    await symlink(path.join(dir, 'src'), path.join(scratch, 'link'));

    const response = await invokeHook(
      preToolUseWrite(dir, path.join(scratch, 'link', 'value.js')),
      dir,
    );

    expect(response.hookSpecificOutput.permissionDecision).toBe('deny');
  });

  it('denies a raw-inside path whose realpath escapes the project (symlink attack B)', async () => {
    const dir = await project();
    const scratch = await outsideDir();
    await symlink(scratch, path.join(dir, 'esc'));

    const response = await invokeHook(
      preToolUseWrite(dir, path.join(dir, 'esc', 'x.txt')),
      dir,
    );

    expect(response.hookSpecificOutput.permissionDecision).toBe('deny');
  });

  it('denies a no-path Write payload while a run is active', async () => {
    const dir = await project();

    const response = await invokeHook({
      hook_event_name: 'PreToolUse',
      project_dir: dir,
      session_id: 's1',
      tool_name: 'Write',
      tool_input: { content: 'scratch' },
    }, dir);

    expect(response.hookSpecificOutput.permissionDecision).toBe('deny');
  });
});
