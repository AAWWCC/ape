import { execFileSync, spawn } from 'node:child_process';
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import {
  extractApplyPatchPaths,
  normalizeLifecycleEvent,
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

function git(cwd, ...args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

function codexEnv() {
  const env = { ...process.env };
  delete env.CLAUDECODE;
  delete env.CLAUDE_CODE;
  delete env.CLAUDE_PROJECT_DIR;
  delete env.CODEX_CWD;
  return env;
}

function decision(response) {
  return response.decision ?? (response.hookSpecificOutput?.permissionDecision === 'deny' ? 'deny' : 'allow');
}

function denyReason(response) {
  return response.reason ?? response.hookSpecificOutput?.permissionDecisionReason ?? '';
}

async function runHook(input, dir) {
  const child = spawn(process.execPath, [hookBinary], {
    cwd: dir,
    env: codexEnv(),
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  child.stdin.end(`${JSON.stringify(input)}\n`);
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk) => { stdout += chunk; });
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  const code = await new Promise((resolve, reject) => {
    child.on('error', reject);
    child.on('close', resolve);
  });
  if (code !== 0) throw new Error(stderr || `hook exited ${code}`);
  return JSON.parse(stdout);
}

async function boundProject() {
  const dir = await mkdtemp(path.join(tmpdir(), 'ape-codex-patch-'));
  cleanups.push(dir);
  await mkdir(path.join(dir, 'src'), { recursive: true });
  await mkdir(path.join(dir, 'docs'), { recursive: true });
  await writeFile(path.join(dir, 'src', 'old.js'), 'export const old = true;\n');
  await writeFile(path.join(dir, 'docs', 'readme.md'), '# docs\n');
  git(dir, 'init', '-q');
  git(dir, 'config', 'user.email', 'ape@example.test');
  git(dir, 'config', 'user.name', 'APE Test');
  git(dir, 'add', '.');
  git(dir, 'commit', '-qm', 'test: baseline');
  const baseline = await currentTreeSha(dir);
  const ticket = {
    ticket_id: 'run-codex-patch:build:t1',
    stage_id: 'build',
    role: 'implementer',
    writable: true,
    claimed_paths: ['src'],
    test_paths: ['__tests__'],
    base_tree_sha: baseline,
  };
  await atomicWriteJson(runtimePaths(dir).active, {
    run_id: 'run-codex-patch',
    status: 'running',
    tree_sha: baseline,
    tickets: [ticket],
    receipts: [],
  });
  return { dir, ticket };
}

function lifecycleCall(dir, ticket, toolInput, hookEventName = 'PreToolUse') {
  return {
    hook_event_name: hookEventName,
    project_dir: dir,
    session_id: 'codex-patch-session',
    is_subagent: true,
    ticket_id: ticket.ticket_id,
    tool_name: 'apply_patch',
    tool_input: toolInput,
  };
}

const multiFilePatch = `*** Begin Patch
*** Update File: src/old.js
@@
-export const old = true;
+export const old = false;
*** Add File: src/new file.js
+export const added = true;
*** Update File: src/old.js
*** Move to: src/moved.js
@@
-export const old = true;
+export const moved = true;
*** Delete File: src/remove.js
*** End Patch`;

describe('Codex freeform apply_patch path extraction', () => {
  it('extracts every add, update, delete, and move target in order without duplicates', () => {
    expect(extractApplyPatchPaths(multiFilePatch)).toEqual([
      'src/old.js',
      'src/new file.js',
      'src/moved.js',
      'src/remove.js',
    ]);
  });

  it('accepts the object and command-array transport variants and ignores hunk-content lookalikes', () => {
    const patch = `*** Update File: docs/before-envelope.md
*** Begin Patch
*** Update File: src/old.js
@@
-old
+*** Update File: docs/not-a-header.md
*** End Patch
*** Add File: docs/after-envelope.md`;
    expect(extractApplyPatchPaths({ input: patch })).toEqual(['src/old.js']);
    expect(extractApplyPatchPaths({ patch })).toEqual(['src/old.js']);
    expect(extractApplyPatchPaths({ command: ['apply_patch', patch] })).toEqual(['src/old.js']);
  });

  it('normalizes native freeform targets without requiring file_path', () => {
    const event = normalizeLifecycleEvent({
      project_dir: '/repo',
      tool_name: 'apply_patch',
      tool_input: multiFilePatch,
    }, {});
    expect(event.files).toEqual([
      'src/old.js',
      'src/new file.js',
      'src/moved.js',
      'src/remove.js',
    ]);
  });

  it('does not let a compatibility file_path hide additional freeform targets', () => {
    const event = normalizeLifecycleEvent({
      project_dir: '/repo',
      tool_name: 'apply_patch',
      tool_input: {
        file_path: '/repo/src/old.js',
        patch: `*** Begin Patch
*** Update File: src/old.js
@@
-old
+new
*** Add File: docs/also-governed.md
+docs
*** End Patch`,
      },
    }, {});
    expect(event.files).toContain('src/old.js');
    expect(event.files).toContain('docs/also-governed.md');
  });
});

describe('Codex freeform apply_patch hook authorization', () => {
  it('allows a multi-file native patch when every derived target is claimed', async () => {
    const { dir, ticket } = await boundProject();
    const response = await runHook(lifecycleCall(dir, ticket, multiFilePatch), dir);
    expect(decision(response)).toBe('allow');
  });

  it('allows a claimed new absolute path through an alias of the governed root', async () => {
    const { dir, ticket } = await boundProject();
    const aliasParent = await mkdtemp(path.join(tmpdir(), 'ape-codex-patch-alias-'));
    cleanups.push(aliasParent);
    const aliasRoot = path.join(aliasParent, 'project-link');
    await symlink(dir, aliasRoot, process.platform === 'win32' ? 'junction' : 'dir');
    const target = path.join(aliasRoot, 'src', 'new-through-alias.js');
    const patch = `*** Begin Patch
*** Add File: ${target}
+export const throughAlias = true;
*** End Patch`;

    const response = await runHook(lifecycleCall(dir, ticket, patch), dir);
    expect(decision(response)).toBe('allow');
  });

  it('still applies ticket claims to a new absolute path through a root alias', async () => {
    const { dir, ticket } = await boundProject();
    const aliasParent = await mkdtemp(path.join(tmpdir(), 'ape-codex-patch-alias-'));
    cleanups.push(aliasParent);
    const aliasRoot = path.join(aliasParent, 'project-link');
    await symlink(dir, aliasRoot, process.platform === 'win32' ? 'junction' : 'dir');
    const target = path.join(aliasRoot, 'docs', 'outside-claim.md');
    const patch = `*** Begin Patch
*** Add File: ${target}
+outside claim
*** End Patch`;

    const response = await runHook(lifecycleCall(dir, ticket, patch), dir);
    expect(decision(response)).toBe('deny');
    expect(denyReason(response)).toMatch(/outside the ticket claims/);
  });

  it.each(['PostToolUse', 'PostToolUseFailure'])(
    'uses the same freeform path authorization for %s',
    async (hookEventName) => {
      const { dir, ticket } = await boundProject();
      const response = await runHook(
        lifecycleCall(dir, ticket, { patch: multiFilePatch }, hookEventName),
        dir,
      );
      expect(decision(response)).toBe('allow');
    },
  );

  it('denies the entire patch when any derived target is outside the ticket claims', async () => {
    const { dir, ticket } = await boundProject();
    const patch = `*** Begin Patch
*** Update File: src/old.js
@@
-old
+new
*** Add File: docs/escape.md
+escape
*** End Patch`;
    const response = await runHook(lifecycleCall(dir, ticket, { input: patch }), dir);
    expect(decision(response)).toBe('deny');
    expect(denyReason(response)).toMatch(/outside the ticket claims/);
  });

  it('denies a move whose destination is outside the ticket claims', async () => {
    const { dir, ticket } = await boundProject();
    const patch = `*** Begin Patch
*** Update File: src/old.js
*** Move to: docs/moved.js
@@
-old
+new
*** End Patch`;
    const response = await runHook(lifecycleCall(dir, ticket, { command: ['apply_patch', patch] }), dir);
    expect(decision(response)).toBe('deny');
    expect(denyReason(response)).toMatch(/outside the ticket claims/);
  });

  it('still fails closed when a freeform payload has no valid patch target header', async () => {
    const { dir, ticket } = await boundProject();
    const response = await runHook(
      lifecycleCall(dir, ticket, '*** Begin Patch\n*** End Patch'),
      dir,
    );
    expect(decision(response)).toBe('deny');
    expect(denyReason(response)).toMatch(/target path is missing/);
  });
});
