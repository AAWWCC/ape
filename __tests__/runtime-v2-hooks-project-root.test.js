import { execFileSync, spawn } from 'node:child_process';
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { resolveGovernedRoot, resolveProjectRoot, runtimePaths } from '../lib/runtime/paths.js';
import { normalizeLifecycleEvent } from '../lib/runtime/hooks.js';
import { currentTreeSha } from '../lib/runtime/git.js';
import { atomicWriteJson } from '../lib/runtime/storage.js';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const hookBinary = path.join(root, 'bin', 'ape-hook.mjs');
const mcpBinary = path.join(root, 'bin', 'ape-mcp.mjs');
const cleanups = [];

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

function git(cwd, ...args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

async function project() {
  const dir = await mkdtemp(path.join(tmpdir(), 'ape-project-root-'));
  cleanups.push(dir);
  await mkdir(path.join(dir, 'src', 'nested'), { recursive: true });
  await writeFile(path.join(dir, 'src', 'value.js'), 'export const value = 1;\n');
  git(dir, 'init', '-q');
  git(dir, 'config', 'user.email', 'ape@example.test');
  git(dir, 'config', 'user.name', 'APE Test');
  git(dir, 'add', '.');
  git(dir, 'commit', '-qm', 'test: baseline');
  const baseline = await currentTreeSha(dir);
  await atomicWriteJson(runtimePaths(dir).active, {
    run_id: 'run-project-root',
    status: 'running',
    tree_sha: baseline,
    tickets: [],
    receipts: [],
  });
  return dir;
}

// Environment for spawned binaries: force the Claude host and strip the
// ambient host project hints so only the payload — and any explicitly
// injected override, for the pinned-environment cases production always runs
// under — decides the resolution.
function claudeEnv(overrides = {}) {
  const env = { ...process.env, CLAUDECODE: '1' };
  delete env.CLAUDE_PROJECT_DIR;
  delete env.CODEX_CWD;
  return { ...env, ...overrides };
}

// Codex host: no CLAUDECODE marker and no Claude pin; CODEX_CWD (when a case
// injects it) is the only stable root channel that host provides.
function codexEnv(overrides = {}) {
  const env = { ...process.env };
  delete env.CLAUDECODE;
  delete env.CLAUDE_CODE;
  delete env.CLAUDE_PROJECT_DIR;
  delete env.CODEX_CWD;
  return { ...env, ...overrides };
}

function invokeHook(input, cwd, env = claudeEnv()) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [hookBinary], {
      cwd,
      env,
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

function mcpSession(messages, cwd, env = claudeEnv(), host = 'claude') {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [mcpBinary, '--host', host], {
      cwd,
      env,
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
      else resolve(stdout.trim().split(/\r?\n/).map((line) => JSON.parse(line)));
    });
    child.stdin.end(messages.map((message) => JSON.stringify(message)).join('\n') + '\n');
  });
}

describe('APE v2 project-root resolution (resolveProjectRoot)', () => {
  it('walks up from a nested subdirectory to the nearest .ape ancestor', async () => {
    const dir = await project();
    expect(resolveProjectRoot(path.join(dir, 'src', 'nested'))).toBe(path.resolve(dir));
    expect(resolveProjectRoot(dir)).toBe(path.resolve(dir));
  });

  it('falls back to the input directory when no .ape marker exists', async () => {
    const bare = await mkdtemp(path.join(tmpdir(), 'ape-no-marker-'));
    cleanups.push(bare);
    const nested = path.join(bare, 'a', 'b');
    await mkdir(nested, { recursive: true });
    expect(resolveProjectRoot(nested)).toBe(path.resolve(nested));
  });

  it.skipIf(process.platform === 'win32')('does not walk up to a symlinked .ape marker', async () => {
    const bare = await mkdtemp(path.join(tmpdir(), 'ape-symlink-marker-'));
    const outside = await mkdtemp(path.join(tmpdir(), 'ape-symlink-marker-target-'));
    cleanups.push(bare, outside);
    const nested = path.join(bare, 'src', 'nested');
    await mkdir(nested, { recursive: true });
    await symlink(outside, path.join(bare, '.ape'), 'dir');

    expect(resolveProjectRoot(nested)).toBe(path.resolve(nested));
  });

  it('treats an explicit project dir as the walk-up seed, not a verbatim pin', async () => {
    const dir = await project();
    const other = await mkdtemp(path.join(tmpdir(), 'ape-explicit-'));
    cleanups.push(other);
    // A markerless explicit dir still resolves to itself (fresh project, no
    // APE state yet), outranking the walk-up start entirely...
    expect(resolveProjectRoot(path.join(dir, 'src'), other)).toBe(path.resolve(other));
    // ...but hosts pin the *launch* dir, which may sit below the governed
    // root, so an explicit dir under a `.ape`-bearing ancestor walks up to it
    // rather than splitting the brain against the other entrypoints.
    expect(resolveProjectRoot(path.join(dir, 'src'), path.join(dir, 'src', 'nested')))
      .toBe(path.resolve(dir));
  });

  it('normalizeLifecycleEvent seeds the walk from project_dir, then the env pin, then cwd', async () => {
    const dir = await project();
    const sub = path.join(dir, 'src', 'nested');
    const elsewhere = await mkdtemp(path.join(tmpdir(), 'ape-elsewhere-'));
    cleanups.push(elsewhere);

    const explicit = normalizeLifecycleEvent({ project_dir: dir, cwd: sub }, {});
    expect(explicit.project_dir).toBe(path.resolve(dir));

    const fromEnv = normalizeLifecycleEvent(
      { cwd: sub },
      { CLAUDECODE: '1', CLAUDE_PROJECT_DIR: dir },
    );
    expect(fromEnv.project_dir).toBe(path.resolve(dir));

    // The env pin names the launch dir — possibly a subdirectory — so it must
    // seed the marker walk (and outrank the drifting payload cwd), not be
    // trusted as the root verbatim.
    const pinnedSub = normalizeLifecycleEvent(
      { cwd: elsewhere },
      { CLAUDECODE: '1', CLAUDE_PROJECT_DIR: sub },
    );
    expect(pinnedSub.project_dir).toBe(path.resolve(dir));

    // Codex parity: the stable CODEX_CWD outranks the drifting per-event cwd.
    const codexStable = normalizeLifecycleEvent({ cwd: elsewhere }, { CODEX_CWD: dir });
    expect(codexStable.project_dir).toBe(path.resolve(dir));

    // Host pins are deliberately non-interchangeable. A stale variable left
    // by the other host cannot redirect governance away from the live host's
    // stable root.
    const codexMixed = normalizeLifecycleEvent(
      { cwd: elsewhere },
      { CODEX_CWD: dir, CLAUDE_PROJECT_DIR: elsewhere },
    );
    expect(codexMixed.host).toBe('codex');
    expect(codexMixed.project_dir).toBe(path.resolve(dir));

    const claudeMixed = normalizeLifecycleEvent(
      { cwd: elsewhere },
      { CLAUDECODE: '1', CLAUDE_PROJECT_DIR: dir, CODEX_CWD: elsewhere },
    );
    expect(claudeMixed.host).toBe('claude');
    expect(claudeMixed.project_dir).toBe(path.resolve(dir));

    const walked = normalizeLifecycleEvent({ cwd: sub }, {});
    expect(walked.project_dir).toBe(path.resolve(dir));
  });

  it('lets an explicit adapter host outrank stale host markers', async () => {
    const dir = await project();
    const foreign = await mkdtemp(path.join(tmpdir(), 'ape-stale-host-marker-'));
    cleanups.push(foreign);
    const mixed = {
      CLAUDECODE: '1',
      CLAUDE_PROJECT_DIR: foreign,
      CODEX_CWD: dir,
    };
    expect(resolveGovernedRoot({ cwd: foreign, env: mixed, host: 'codex' })).toBe(path.resolve(dir));
    expect(resolveGovernedRoot({ cwd: foreign, env: mixed, host: 'claude' })).toBe(path.resolve(foreign));
  });
});

describe('APE v2 hook guard under cwd drift', () => {
  it('still resolves the active run and denies a main-session write when cwd is a subdirectory', async () => {
    // Regression guard for F6: the hook used the session cwd as the project
    // root, so a `cd src/` made it find no active run and fail open.
    const dir = await project();
    const sub = path.join(dir, 'src', 'nested');

    const response = await invokeHook({
      hook_event_name: 'PreToolUse',
      cwd: sub,
      session_id: 'drift-parent',
      tool_name: 'Write',
      tool_input: { file_path: path.join(dir, 'src', 'value.js'), content: 'pwned' },
    }, sub);

    expect(response.hookSpecificOutput.permissionDecision).toBe('deny');
    expect(response.hookSpecificOutput.permissionDecisionReason)
      .toMatch(/main-session production writes are forbidden/);
  });

  it('emits the block shape for an unattributed tree change reconciled from a subdirectory', async () => {
    // Combined F5+F6 regression: the change is detected only when the root
    // resolves past the cwd drift, and the denial only lands when the
    // PostToolUse response uses the top-level block shape. The command must
    // be a writing one — the drift guard no longer binds read-only Bash (#28).
    const dir = await project();
    const sub = path.join(dir, 'src', 'nested');
    await writeFile(path.join(dir, 'src', 'value.js'), 'export const value = 2;\n');

    const response = await invokeHook({
      hook_event_name: 'PostToolUse',
      cwd: sub,
      session_id: 'drift-parent',
      tool_name: 'Bash',
      tool_input: { command: 'printf done > out.txt' },
    }, sub);

    expect(response).toEqual({
      decision: 'block',
      reason: expect.stringMatching(/no exact active ticket attribution/),
    });
  });

  it('stays silent on an allowed post event so the host proceeds unchanged', async () => {
    const dir = await project();
    const sub = path.join(dir, 'src', 'nested');

    const response = await invokeHook({
      hook_event_name: 'PostToolUse',
      cwd: sub,
      session_id: 'drift-parent',
      tool_name: 'Bash',
      tool_input: { command: 'printf done' },
    }, sub);

    expect(response).toEqual({});
  });
});

describe('APE v2 MCP server under cwd drift', () => {
  it('resolves the active run when launched from a subdirectory without project_dir', async () => {
    const dir = await project();
    const sub = path.join(dir, 'src', 'nested');

    const responses = await mcpSession([
      {
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name: 'ape_run', arguments: { action: 'status' } },
      },
    ], sub);

    const status = JSON.parse(responses[0].result.content[0].text);
    expect(status.active).toBe(true);
    expect(status.run.run_id).toBe('run-project-root');
  });
});

// Production Claude sessions ALWAYS run the hook with CLAUDE_PROJECT_DIR set
// (to the launch dir, which need not be the governed root), so these cases
// exercise the pinned environment the pin-stripped suites above never see.
describe('APE v2 hook guard under a host env pin', () => {
  it('denies a main-session production write when CLAUDE_PROJECT_DIR pins a subdirectory', async () => {
    // A session opened in repo/src of a repo whose root owns .ape must still
    // be governed by repo/: trusting the pin verbatim made the hook govern
    // repo/src, find no active run there, and fail open while the MCP server
    // drove the run at the root (invariant 2 dissolved).
    const dir = await project();
    const sub = path.join(dir, 'src', 'nested');

    const response = await invokeHook({
      hook_event_name: 'PreToolUse',
      cwd: sub,
      session_id: 'pin-subdir',
      tool_name: 'Write',
      tool_input: { file_path: path.join(dir, 'src', 'value.js'), content: 'pwned' },
    }, sub, claudeEnv({ CLAUDE_PROJECT_DIR: sub }));

    expect(response.hookSpecificOutput.permissionDecision).toBe('deny');
    expect(response.hookSpecificOutput.permissionDecisionReason)
      .toMatch(/main-session production writes are forbidden/);
  });

  it('still denies when CLAUDE_PROJECT_DIR pins the project root itself', async () => {
    // Parity guard: seeding the walk from the pin must not change the answer
    // for the common case where the pin already names the governed root.
    const dir = await project();

    const response = await invokeHook({
      hook_event_name: 'PreToolUse',
      cwd: dir,
      session_id: 'pin-root',
      tool_name: 'Write',
      tool_input: { file_path: path.join(dir, 'src', 'value.js'), content: 'pwned' },
    }, dir, claudeEnv({ CLAUDE_PROJECT_DIR: dir }));

    expect(response.hookSpecificOutput.permissionDecision).toBe('deny');
    expect(response.hookSpecificOutput.permissionDecisionReason)
      .toMatch(/main-session production writes are forbidden/);
  });

  it('hook and MCP server resolve the same root under a subdirectory pin', async () => {
    // Cross-entrypoint agreement: the run the hook denies against must be the
    // run the MCP server reports. The MCP session runs from a neutral
    // directory so only the env pin can name the project.
    const dir = await project();
    const sub = path.join(dir, 'src', 'nested');
    const neutral = await mkdtemp(path.join(tmpdir(), 'ape-neutral-'));
    cleanups.push(neutral);

    const hookResponse = await invokeHook({
      hook_event_name: 'PreToolUse',
      cwd: sub,
      session_id: 'pin-agreement',
      tool_name: 'Write',
      tool_input: { file_path: path.join(dir, 'src', 'value.js'), content: 'pwned' },
    }, sub, claudeEnv({ CLAUDE_PROJECT_DIR: sub }));
    expect(hookResponse.hookSpecificOutput.permissionDecision).toBe('deny');

    const responses = await mcpSession([
      {
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name: 'ape_run', arguments: { action: 'status' } },
      },
    ], neutral, claudeEnv({ CLAUDE_PROJECT_DIR: sub }));

    const status = JSON.parse(responses[0].result.content[0].text);
    expect(status.active).toBe(true);
    expect(status.run.run_id).toBe('run-project-root');
  });
});

describe('APE v2 hook guard under Codex cwd drift', () => {
  it('lets CODEX_CWD outrank a drifted payload cwd so write gating survives a cd out of the project', async () => {
    // Codex has no project_dir channel: the per-event payload cwd used to
    // outrank the stable CODEX_CWD, so one mid-run cd outside the project
    // resolved a rootless dir, found no active run, and disabled the
    // main-session write gate.
    const dir = await project();
    const foreign = await mkdtemp(path.join(tmpdir(), 'ape-foreign-'));
    cleanups.push(foreign);

    const drifted = await invokeHook({
      hook_event_name: 'PreToolUse',
      cwd: foreign,
      session_id: 'codex-drift',
      tool_name: 'Write',
      tool_input: { file_path: path.join(dir, 'src', 'value.js'), content: 'pwned' },
    }, foreign, codexEnv({ CODEX_CWD: dir }));

    expect(drifted.hookSpecificOutput.permissionDecision).toBe('deny');
    expect(drifted.hookSpecificOutput.permissionDecisionReason).toMatch(/main-session production writes are forbidden/);

    // Control: the undrifted payload cwd reaches the same decision.
    const undrifted = await invokeHook({
      hook_event_name: 'PreToolUse',
      cwd: dir,
      session_id: 'codex-drift',
      tool_name: 'Write',
      tool_input: { file_path: path.join(dir, 'src', 'value.js'), content: 'pwned' },
    }, dir, codexEnv({ CODEX_CWD: dir }));

    expect(undrifted.hookSpecificOutput.permissionDecision).toBe('deny');
  });

  it('ignores an ambient Claude project pin while enforcing the Codex root', async () => {
    const dir = await project();
    const foreign = await mkdtemp(path.join(tmpdir(), 'ape-ambient-claude-'));
    cleanups.push(foreign);

    const response = await invokeHook({
      hook_event_name: 'PreToolUse',
      cwd: foreign,
      session_id: 'codex-mixed-env',
      tool_name: 'Write',
      tool_input: { file_path: path.join(dir, 'src', 'value.js'), content: 'pwned' },
    }, foreign, codexEnv({ CODEX_CWD: dir, CLAUDE_PROJECT_DIR: foreign }));

    expect(response.hookSpecificOutput.permissionDecision).toBe('deny');
    expect(response.hookSpecificOutput.permissionDecisionReason)
      .toMatch(/main-session production writes are forbidden/);
  });

  it('keeps MCP status on the Codex root when CLAUDE_PROJECT_DIR is ambient', async () => {
    const dir = await project();
    const foreign = await mkdtemp(path.join(tmpdir(), 'ape-ambient-claude-mcp-'));
    cleanups.push(foreign);
    const responses = await mcpSession([{
      jsonrpc: '2.0', id: 1, method: 'tools/call',
      params: { name: 'ape_run', arguments: { action: 'status' } },
    }], foreign, codexEnv({
      CODEX_CWD: dir,
      CLAUDECODE: '1',
      CLAUDE_PROJECT_DIR: foreign,
    }), 'codex');

    const status = JSON.parse(responses[0].result.content[0].text);
    expect(status.active).toBe(true);
    expect(status.run.run_id).toBe('run-project-root');
  });
});
