import { execFileSync, spawn } from 'node:child_process';
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { runtimePaths } from '../lib/runtime/paths.js';
import { atomicWriteJson } from '../lib/runtime/storage.js';

// Each hook invocation is a fresh process against a temporary Git repository
// and temporary synthetic runtime. No live run or checkout runtime is touched.
// Sequencing real hook boundaries makes the previous denial observable again
// at the later Agent return, rather than testing only one attribution lookup.
const hookBinary = fileURLToPath(new URL('../bin/ape-hook.mjs', import.meta.url));
const cleanups = [];
let inspectionSequence = 0;
const original = 'export const value = 1;\n';
const parentChange = 'export const value = 20;\n';
const workerChange = 'export const value = 300;\n';

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

function isolatedEnv() {
  return {
    ...Object.fromEntries(Object.entries(process.env).filter(([name]) =>
      !/^(?:APE_|GIT_|CLAUDE_|CODEX_)/.test(name) && name !== 'CLAUDECODE')),
    CLAUDECODE: '1',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_TERMINAL_PROMPT: '0',
  };
}

function git(dir, ...args) {
  return execFileSync('git', args, { cwd: dir, env: isolatedEnv(), encoding: 'utf8' }).trim();
}

async function project() {
  const dir = await realpath(await mkdtemp(path.join(tmpdir(), 'ape-parent-drift-latch-')));
  cleanups.push(dir);
  await mkdir(path.join(dir, 'src'));
  await writeFile(path.join(dir, 'src', 'value.js'), original);
  await writeFile(path.join(dir, 'src', 'worker.js'), 'export const worker = 1;\n');
  git(dir, 'init', '-q');
  git(dir, 'config', 'user.email', 'synthetic@example.invalid');
  git(dir, 'config', 'user.name', 'Synthetic APE Fixture');
  git(dir, 'config', 'commit.gpgsign', 'false');
  git(dir, 'add', 'src');
  git(dir, 'commit', '-qm', 'synthetic baseline');
  const baseline = git(dir, 'rev-parse', 'HEAD^{tree}');
  const ticket = {
    ticket_id: 'run-synthetic-parent-drift:build:worker',
    stage_id: 'build', role: 'implementer', writable: true,
    claimed_paths: ['src'], test_paths: ['tests'], base_tree_sha: baseline,
  };
  await atomicWriteJson(runtimePaths(dir).active, {
    run_id: 'run-synthetic-parent-drift', status: 'running', tree_sha: baseline,
    tickets: [ticket], receipts: [], expired_tickets: [],
  });
  return { dir, ticket };
}

function invokeHook(dir, input) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [hookBinary], {
      cwd: dir, env: isolatedEnv(), stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    const timeout = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error('synthetic hook did not finish within 10 seconds'));
    }, 10_000);
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', (error) => { clearTimeout(timeout); reject(error); });
    child.on('close', (code) => {
      clearTimeout(timeout);
      if (code !== 0) reject(new Error(stderr));
      else {
        try { resolve(JSON.parse(stdout)); } catch (error) { reject(error); }
      }
    });
    child.stdin.end(JSON.stringify({ cwd: dir, session_id: 'synthetic-parent', ...input }));
  });
}

function shellPost(dir, event = 'PostToolUse', command = 'printf changed > src/value.js') {
  return invokeHook(dir, { hook_event_name: event, tool_name: 'Bash', tool_input: { command } });
}

async function inspectGitStatus(dir) {
  const shared = {
    tool_name: 'Bash', tool_use_id: `synthetic-status-${++inspectionSequence}`,
    tool_input: { command: 'git status' },
  };
  const pre = await invokeHook(dir, { hook_event_name: 'PreToolUse', ...shared });
  expect(pre).toMatchObject({ hookSpecificOutput: { permissionDecision: 'allow' } });
  git(dir, 'status');
  return invokeHook(dir, { hook_event_name: 'PostToolUse', ...shared });
}

function agentPost(dir, event = 'PostToolUse') {
  return invokeHook(dir, {
    hook_event_name: event, tool_name: 'Agent',
    tool_input: { subagent_type: 'general', prompt: 'finish the synthetic worker stage' },
  });
}

function expectDriftBlock(response) {
  expect(response).toMatchObject({ decision: 'block' });
  expect(response.reason).not.toMatch(/failed closed|schema-invalid/i);
}

describe('a denied parent-shell change cannot become sole-worker evidence at a later hook', () => {
  it.each(['PostToolUse', 'PostToolUseFailure'])(
    'blocks a later %s Agent return after the parent shell denial', async (event) => {
      const { dir } = await project();
      await writeFile(path.join(dir, 'src', 'value.js'), parentChange);
      expectDriftBlock(await shellPost(dir));
      expect(await readFile(path.join(dir, 'src', 'value.js'), 'utf8')).toBe(parentChange);
      expectDriftBlock(await agentPost(dir, event));
    },
  );

  it('retains the denial from a failed parent-shell post event too', async () => {
    const { dir } = await project();
    await writeFile(path.join(dir, 'src', 'value.js'), parentChange);
    expectDriftBlock(await shellPost(dir, 'PostToolUseFailure'));
    expectDriftBlock(await agentPost(dir));
  });

  it('does not let a later bound-worker stop claim the already-denied bytes', async () => {
    const { dir, ticket } = await project();
    await writeFile(path.join(dir, 'src', 'value.js'), parentChange);
    expectDriftBlock(await shellPost(dir));
    expectDriftBlock(await invokeHook(dir, {
      hook_event_name: 'SubagentStop', is_subagent: true,
      session_id: 'synthetic-worker', ticket_id: ticket.ticket_id,
    }));
  });

  it('keeps Read and git status available for diagnosis without clearing the denial', async () => {
    const { dir } = await project();
    await writeFile(path.join(dir, 'src', 'value.js'), parentChange);
    expectDriftBlock(await shellPost(dir));
    for (const [tool_name, tool_input] of [
      ['Read', { file_path: path.join(dir, 'src', 'value.js') }],
      ['Bash', { command: 'git status' }],
    ]) {
      const response = await invokeHook(dir, { hook_event_name: 'PreToolUse', tool_name, tool_input });
      expect(response).toMatchObject({ hookSpecificOutput: { permissionDecision: 'allow' } });
    }
    expect(await inspectGitStatus(dir)).toEqual({});
    expectDriftBlock(await agentPost(dir));
  });

  it('allows an in-scope worker repair pre-event while un-restored output remains inadmissible', async () => {
    const { dir, ticket } = await project();
    await writeFile(path.join(dir, 'src', 'value.js'), parentChange);
    expectDriftBlock(await shellPost(dir));
    const repair = await invokeHook(dir, {
      hook_event_name: 'PreToolUse', tool_name: 'Edit', is_subagent: true,
      session_id: 'synthetic-worker', ticket_id: ticket.ticket_id,
      tool_input: {
        file_path: path.join(dir, 'src', 'value.js'), old_string: parentChange, new_string: original,
      },
    });
    expect(repair).toMatchObject({ hookSpecificOutput: { permissionDecision: 'allow' } });
    // Editing to a third value is not evidence that the refused bytes were
    // restored. The result remains denied until exact restoration is observed.
    await writeFile(path.join(dir, 'src', 'value.js'), workerChange);
    expect(await inspectGitStatus(dir)).toEqual({});
    expectDriftBlock(await agentPost(dir));
  });

  it('settles exact restoration while preserving unrelated worker changes and subsequent authorized work', async () => {
    const { dir } = await project();
    const unrelated = 'export const worker = 2;\n';
    await writeFile(path.join(dir, 'src', 'worker.js'), unrelated);
    const shared = {
      tool_name: 'Bash', tool_use_id: 'synthetic-parent-change-command',
      tool_input: { command: 'printf changed > src/value.js' },
    };
    // The matched pre snapshot already includes the worker's unrelated bytes.
    // Even a denied pre can be followed by a post after a failure or bypass.
    const pre = await invokeHook(dir, { hook_event_name: 'PreToolUse', ...shared });
    expect(pre).toMatchObject({ hookSpecificOutput: { permissionDecision: 'deny' } });
    await writeFile(path.join(dir, 'src', 'value.js'), parentChange);
    expectDriftBlock(await invokeHook(dir, { hook_event_name: 'PostToolUse', ...shared }));
    await writeFile(path.join(dir, 'src', 'value.js'), original);
    // A real hook observes the restored affected path while the unrelated
    // worker change is still present; no whole-tree revert is required.
    expect(await inspectGitStatus(dir)).toEqual({});
    expect(await readFile(path.join(dir, 'src', 'worker.js'), 'utf8')).toBe(unrelated);
    await writeFile(path.join(dir, 'src', 'value.js'), workerChange);
    expect(await agentPost(dir)).toEqual({});
    expect(await readFile(path.join(dir, 'src', 'worker.js'), 'utf8')).toBe(unrelated);
  });

  it('does not mark pre-existing worker changes as parent drift when the parent inspects them', async () => {
    const { dir } = await project();
    await writeFile(path.join(dir, 'src', 'value.js'), workerChange);
    expect(await inspectGitStatus(dir)).toEqual({});
    expect(await agentPost(dir)).toEqual({});
  });

  it('does not mark pre-existing worker changes when an unknown parent command changes nothing', async () => {
    const { dir } = await project();
    await writeFile(path.join(dir, 'src', 'value.js'), workerChange);
    const shared = {
      tool_name: 'Bash', tool_use_id: 'synthetic-no-change-command',
      tool_input: { command: 'opaque-inspection-command' },
    };
    const pre = await invokeHook(dir, { hook_event_name: 'PreToolUse', ...shared });
    expect(pre).toMatchObject({ hookSpecificOutput: { permissionDecision: 'allow' } });
    expect(await invokeHook(dir, { hook_event_name: 'PostToolUse', ...shared })).toEqual({});
    // Duplicate delivery still refers to the same command observation. It
    // must not fall back to the run baseline or re-diff its old pre snapshot
    // against NEW worker edits that happened after the original result.
    await writeFile(path.join(dir, 'src', 'worker.js'), 'export const worker = 3;\n');
    expect(await invokeHook(dir, { hook_event_name: 'PostToolUse', ...shared })).toEqual({});
    expect(await agentPost(dir)).toEqual({});
  });

  it.each(['PostToolUse', 'PostToolUseFailure'])(
    'preserves ordinary sole-worker attribution at %s when no parent write was denied', async (event) => {
      const { dir } = await project();
      await writeFile(path.join(dir, 'src', 'value.js'), workerChange);
      expect(await agentPost(dir, event)).toEqual({});
    },
  );

  it.each(['spawn_agent', 'collaborationspawn_agent'])(
    'preserves legitimate sole-worker attribution for the native %s dispatch post', async (tool_name) => {
      const { dir } = await project();
      await writeFile(path.join(dir, 'src', 'value.js'), workerChange);
      expect(await invokeHook(dir, {
        hook_event_name: 'PostToolUse', tool_name,
        tool_input: { task_name: 'synthetic-worker', message: 'finish the worker stage' },
      })).toEqual({});
    },
  );

  it.each(['git diff', 'git diff --ext-diff'])(
    'retains real external-helper mutations from a paired parent %s call', async (command) => {
      const { dir } = await project();
      const helper = path.join(dir, '.git', 'synthetic-external-diff.mjs');
      const helperChange = 'export const worker = 777;\n';
      await writeFile(helper,
        `import { writeFileSync } from 'node:fs';\nwriteFileSync('src/worker.js', ${JSON.stringify(helperChange)});\n`);
      const quote = (value) => `'${value.replaceAll("'", "'\\''")}'`;
      git(dir, 'config', 'diff.external', `${quote(process.execPath)} ${quote(helper)}`);
      // The unrelated worker change already exists before the parent's read.
      // Git's configured callback then writes a different claimed source file.
      await writeFile(path.join(dir, 'src', 'value.js'), workerChange);
      const shared = {
        tool_name: 'Bash', tool_use_id: 'synthetic-external-diff-command',
        tool_input: { command },
      };
      const pre = await invokeHook(dir, { hook_event_name: 'PreToolUse', ...shared });
      expect(pre).toMatchObject({ hookSpecificOutput: { permissionDecision: 'allow' } });
      git(dir, ...command.split(' ').slice(1));
      expect(await readFile(path.join(dir, 'src', 'worker.js'), 'utf8')).toBe(helperChange);
      expectDriftBlock(await invokeHook(dir, { hook_event_name: 'PostToolUse', ...shared }));
      expectDriftBlock(await agentPost(dir));
    },
  );
});
