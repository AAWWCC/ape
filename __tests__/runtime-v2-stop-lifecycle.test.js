import { execFileSync, spawn } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { evaluateLifecyclePolicy } from '../lib/runtime/hooks.js';
import { runtimePaths } from '../lib/runtime/paths.js';
import { currentTreeSha } from '../lib/runtime/git.js';
import { atomicWriteJson } from '../lib/runtime/storage.js';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const hookBinary = path.join(root, 'bin', 'ape-hook.mjs');
const cleanups = [];

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

// A Stop/SubagentStop payload carries no tool name: it is the agent's final
// message flush, not a tool call. Regression guard for the bug where every
// read-only subagent (reviewer, planner, ...) was blocked at Stop — writers
// escaped only via the tree-reconciliation pre-computed allow, which read-only
// agents never reach because they never change the tree.
describe('APE v2 lifecycle stop-event policy', () => {
  const state = { status: 'running' };
  const readOnlyTicket = (role) => ({
    ticket_id: `run-1:${role}:r`,
    role,
    writable: false,
    claimed_paths: [],
    test_paths: [],
  });
  const stopEvent = (event, overrides = {}) => ({
    host: 'claude',
    event,
    tool_name: '',
    is_subagent: true,
    ape_managed: true,
    ...overrides,
  });

  it.each([
    ['reviewer', 'SubagentStop'],
    ['reviewer', 'Stop'],
    ['planner', 'SubagentStop'],
    ['planner', 'Stop'],
    ['plan_checker', 'SubagentStop'],
    ['plan_checker', 'Stop'],
  ])('allows a bound read-only %s at %s', (role, event) => {
    const result = evaluateLifecyclePolicy(stopEvent(event), {
      state,
      ticket: readOnlyTicket(role),
    });
    expect(result.decision).toBe('allow');
  });

  it.each(['Stop', 'SubagentStop'])(
    'allows an unbound ape-managed Claude subagent %s (no "no exact active binding" denial)',
    (event) => {
      const result = evaluateLifecyclePolicy(stopEvent(event), { state, ticket: null });
      expect(result.decision).toBe('allow');
    },
  );

  it('allows any lifecycle event whose tool_name is empty, even for a bound claude subagent', () => {
    const result = evaluateLifecyclePolicy(stopEvent('PostToolUse'), {
      state,
      ticket: readOnlyTicket('reviewer'),
    });
    expect(result.decision).toBe('allow');
  });

  it('still denies real tool calls unchanged', () => {
    const indirect = evaluateLifecyclePolicy(
      stopEvent('PreToolUse', { tool_name: 'Agent' }),
      { state, ticket: readOnlyTicket('reviewer') },
    );
    expect(indirect.decision).toBe('deny');
    expect(indirect.reason).toMatch(/indirect channel/);

    const unbound = evaluateLifecyclePolicy(
      stopEvent('PreToolUse', { tool_name: 'Read' }),
      { state, ticket: null },
    );
    expect(unbound.decision).toBe('deny');
    expect(unbound.reason).toMatch(/no exact active binding/);

    const mainWrite = evaluateLifecyclePolicy(
      {
        host: 'claude',
        event: 'PreToolUse',
        tool_name: 'Write',
        is_subagent: false,
        file: 'src/a.js',
      },
      { state, ticket: null },
    );
    expect(mainWrite.decision).toBe('deny');
    expect(mainWrite.reason).toMatch(/main-session production writes/);
  });

  it('main-session Stop with no active ticket stays allowed', () => {
    const result = evaluateLifecyclePolicy(
      { host: 'claude', event: 'Stop', tool_name: '', is_subagent: false },
      { state, ticket: null },
    );
    expect(result.decision).toBe('allow');
  });
});

function git(cwd, ...args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

async function project() {
  const dir = await mkdtemp(path.join(tmpdir(), 'ape-stop-lifecycle-'));
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
    run_id: 'run-stop-lifecycle',
    status: 'running',
    tree_sha: baseline,
    tickets: [
      {
        ticket_id: 'run-stop-lifecycle:build:b',
        stage_id: 'build',
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

describe('APE v2 hook binary at SubagentStop', () => {
  it('emits the silent allow shape for an unbound ape:reviewer SubagentStop on a clean tree', async () => {
    const dir = await project();

    const response = await invokeHook({
      hook_event_name: 'SubagentStop',
      project_dir: dir,
      session_id: 's1',
      agent_id: 'reviewer-1',
      agent_type: 'ape:reviewer',
    }, dir);

    expect(response).toEqual({});
  });

  it('still blocks SubagentStop when the tree changed without attribution', async () => {
    const dir = await project();
    await writeFile(path.join(dir, 'unclaimed.txt'), 'unattributed change\n');

    const response = await invokeHook({
      hook_event_name: 'SubagentStop',
      project_dir: dir,
      session_id: 's1',
      agent_id: 'reviewer-1',
      agent_type: 'ape:reviewer',
    }, dir);

    expect(response).toEqual({
      decision: 'block',
      reason: expect.stringMatching(/no exact active ticket attribution/),
    });
  });
});
