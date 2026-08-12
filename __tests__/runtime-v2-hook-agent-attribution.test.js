import { execFileSync, spawn } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { runtimePaths } from '../lib/runtime/paths.js';
import { currentTreeSha } from '../lib/runtime/git.js';
import { atomicWriteJson } from '../lib/runtime/storage.js';

// Friction #6/#15: the parent's Agent-result lifecycle payload carries no
// agent identity, so a successful writer stage's return reached the drift
// guard unbound and was denied "no exact active ticket attribution" on EVERY
// writer stage — even when the tree diff was exactly the pending ticket's
// claimed work. The sole-unambiguous-match attribution allows precisely that
// case and nothing else; receipt admission re-verifies the same diff.

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const hookBinary = path.join(root, 'bin', 'ape-hook.mjs');
const cleanups = [];

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

function git(cwd, ...args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

function ticket(id, claims) {
  return {
    ticket_id: id,
    stage_id: 'build',
    role: 'implementer',
    writable: true,
    claimed_paths: claims,
    test_paths: ['tests'],
  };
}

// A running run whose baseline tree predates the still-uncommitted change to
// src/value.js, so the hook's reconciliation sees changed = [src/value.js].
async function project(tickets) {
  const dir = await mkdtemp(path.join(tmpdir(), 'ape-agent-attribution-'));
  cleanups.push(dir);
  await mkdir(path.join(dir, 'src'));
  await mkdir(path.join(dir, 'docs'));
  await writeFile(path.join(dir, 'src', 'value.js'), 'export const value = 1;\n');
  await writeFile(path.join(dir, 'docs', 'notes.md'), '# Notes\n');
  git(dir, 'init', '-q');
  git(dir, 'config', 'user.email', 'ape@example.test');
  git(dir, 'config', 'user.name', 'APE Test');
  git(dir, 'add', '.');
  git(dir, 'commit', '-qm', 'test: baseline');
  const baseline = await currentTreeSha(dir);
  await atomicWriteJson(runtimePaths(dir).active, {
    run_id: 'run-attribution',
    status: 'running',
    tree_sha: baseline,
    tickets,
    receipts: [],
    expired_tickets: [],
  });
  await writeFile(path.join(dir, 'src', 'value.js'), 'export const value = 2;\n');
  return dir;
}

// Force the Claude host and strip ambient pins so only the payload decides
// resolution (same shape as runtime-v2-hooks-project-root.test.js).
function claudeEnv() {
  const env = { ...process.env, CLAUDECODE: '1' };
  delete env.CLAUDE_PROJECT_DIR;
  delete env.CODEX_CWD;
  delete env.APE_TICKET_ID;
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

function agentPostEvent(dir, eventName = 'PostToolUse') {
  return {
    hook_event_name: eventName,
    cwd: dir,
    session_id: 'attribution-parent',
    tool_name: 'Agent',
    tool_input: { subagent_type: 'general', prompt: 'finish the stage' },
  };
}

describe('APE v2 sole-ticket attribution for main-session Agent post-events', () => {
  it('allows a PostToolUse:Agent whose tree diff matches exactly one pending ticket', async () => {
    const dir = await project([ticket('run-attribution:build:a', ['src'])]);
    // Allowed post events stay silent so the host proceeds unchanged.
    expect(await invokeHook(agentPostEvent(dir), dir)).toEqual({});
  });

  it('allows the same sole match on PostToolUseFailure:Agent', async () => {
    const dir = await project([ticket('run-attribution:build:a', ['src'])]);
    expect(await invokeHook(agentPostEvent(dir, 'PostToolUseFailure'), dir)).toEqual({});
  });

  it('still denies when two pending tickets both cover the change (ambiguous)', async () => {
    const dir = await project([
      ticket('run-attribution:build:a', ['src']),
      ticket('run-attribution:build:b', ['src/value.js']),
    ]);
    expect(await invokeHook(agentPostEvent(dir), dir)).toEqual({
      decision: 'block',
      reason: expect.stringMatching(/ambiguous ticket attribution/),
    });
  });

  it('still denies when no pending ticket covers the change', async () => {
    const dir = await project([ticket('run-attribution:build:a', ['docs'])]);
    expect(await invokeHook(agentPostEvent(dir), dir)).toEqual({
      decision: 'block',
      reason: expect.stringMatching(/no exact active ticket attribution/),
    });
  });

  it('still denies a bound subagent whose sole candidate is not its own ticket', async () => {
    const dir = await project([
      ticket('run-attribution:build:a', ['src']),
      ticket('run-attribution:build:b', ['docs']),
    ]);
    const response = await invokeHook({
      hook_event_name: 'SubagentStop',
      cwd: dir,
      session_id: 'attribution-subagent',
      is_subagent: true,
      ticket_id: 'run-attribution:build:b',
    }, dir);
    expect(response).toEqual({
      decision: 'block',
      reason: expect.stringMatching(/no exact active ticket attribution/),
    });
  });

  it('still denies a main-session Bash write post-event even with a sole match', async () => {
    // The attribution is scoped to Agent results: a main-session shell write
    // covering the same claims is still unattributed drift.
    const dir = await project([ticket('run-attribution:build:a', ['src'])]);
    const response = await invokeHook({
      hook_event_name: 'PostToolUse',
      cwd: dir,
      session_id: 'attribution-parent',
      tool_name: 'Bash',
      tool_input: { command: 'printf x > src/value.js' },
    }, dir);
    expect(response).toEqual({
      decision: 'block',
      reason: expect.stringMatching(/no exact active ticket attribution/),
    });
  });
});
