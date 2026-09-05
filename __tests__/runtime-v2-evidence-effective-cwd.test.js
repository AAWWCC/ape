import { execFileSync, spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { evaluateLifecyclePolicy, snapshotEvidenceExecutables } from '../lib/runtime/hooks.js';
import { currentTreeSha } from '../lib/runtime/git.js';
import { runtimePaths } from '../lib/runtime/paths.js';
import { atomicWriteJson } from '../lib/runtime/storage.js';

const hookBinary = fileURLToPath(new URL('../bin/ape-hook.mjs', import.meta.url));
const cleanups = [];
afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

const cases = [
  ['.', 'cd packages/api && node --test ../../tests/example.test.mjs', 'allow'],
  ['packages/api', 'node --test ../../tests/example.test.mjs', 'allow'],
  ['packages/api', 'cd ../.. && node --test tests/example.test.mjs', 'allow'],
  ['.', 'cd packages/api && node --test ../../../external.test.mjs', 'deny'],
  ['packages/api', 'node --test ../../../external.test.mjs', 'deny'],
  ['packages/api', 'cd ../../.. && node --test external.test.mjs', 'deny'],
  ['.', "cat 'tests/file with spaces.test.mjs'", 'allow'],
  ['.', "cd packages/api && cat '../../tests/file with spaces.test.mjs'", 'allow'],
  ['.', "cat '../external file with spaces.test.mjs'", 'deny'],
  ['.', "cd 'packages/api space' && node --test ../../tests/example.test.mjs", 'allow'],
  ['.', 'cd "packages/api space" && cat ../../tests/example.test.mjs', 'allow'],
  ['.', "cd 'packages/[route]' && cat '../../tests/file with spaces.test.mjs'", 'allow'],
  ['.', "cd 'packages/api space' && cat ../../../external.test.mjs", 'deny'],
  ['.', "cd '../outside folder' && cat external.test.mjs", 'deny'],
];

describe('evidence containment uses the effective command directory', () => {
  it.each(cases)('lexical containment from %s for %s is %s', (cwd, command, expected) => {
    const project = path.resolve(tmpdir(), 'ape-effective-cwd-policy');
    const result = evaluateLifecyclePolicy({
      host: 'codex', event: 'PreToolUse', tool_name: 'Bash', is_subagent: true,
      project_dir: project, command,
      evidence: {
        session_cwd: path.resolve(project, cwd), safe: true, cwd_safe: true, executable_safe: true,
      },
    }, {
      state: { status: 'running' },
      ticket: { ticket_id: 'ticket-effective-cwd', role: 'reviewer', writable: false },
    });
    expect(result.decision).toBe(expected);
  });

  async function fixture() {
    const project = await mkdtemp(path.join(tmpdir(), 'ape-effective-cwd-'));
    cleanups.push(project);
    await mkdir(path.join(project, 'packages', 'api'), { recursive: true });
    await mkdir(path.join(project, 'packages', 'api space'));
    await mkdir(path.join(project, 'packages', '[route]'));
    await mkdir(path.join(project, 'tests'));
    await writeFile(path.join(project, 'tests', 'example.test.mjs'), '// evidence fixture\n');
    await writeFile(path.join(project, 'tests', 'file with spaces.test.mjs'), '// literal path fixture\n');
    for (const args of [
      ['init', '-q'], ['config', 'user.email', 'ape@example.test'],
      ['config', 'user.name', 'APE Test'], ['add', '.'], ['commit', '-qm', 'test: baseline'],
    ]) execFileSync('git', args, { cwd: project });
    const env = { ...process.env, CODEX_CWD: project };
    for (const key of ['APE_HOST', 'APE_TICKET_ID', 'CLAUDECODE', 'CLAUDE_CODE', 'CLAUDE_PROJECT_DIR']) {
      delete env[key];
    }
    await atomicWriteJson(runtimePaths(project).active, {
      run_id: 'run-effective-cwd', status: 'running', host: 'codex',
      tree_sha: await currentTreeSha(project), receipts: [],
      policy: { evidence_executables: snapshotEvidenceExecutables({ cwd: project, env }) },
      tickets: [{
        ticket_id: 'ticket-effective-cwd', stage_id: 'review', role: 'reviewer',
        writable: false, claimed_paths: [], test_paths: [],
      }],
    });
    return {
      project,
      invoke(cwd, command) {
        const result = spawnSync(process.execPath, [hookBinary], {
          cwd: project, env, encoding: 'utf8', timeout: 10_000,
          input: JSON.stringify({
            hook_event_name: 'PreToolUse', project_dir: project,
            cwd: path.resolve(project, cwd), is_subagent: true,
            ticket_id: 'ticket-effective-cwd', tool_name: 'Bash', tool_input: { command },
          }),
        });
        expect(result.error).toBeUndefined();
        expect(result.status, result.stderr).toBe(0);
        return JSON.parse(result.stdout);
      },
    };
  }

  it('the hook admits contained parent operands and rejects actual escapes', async () => {
    const { invoke } = await fixture();
    for (const [cwd, command, expected] of cases) {
      const response = invoke(cwd, command);
      if (expected === 'allow') expect(response, command).toEqual({});
      else expect(response.hookSpecificOutput?.permissionDecision, command).toBe('deny');
    }
  });

  it.skipIf(process.platform === 'win32')('the post-cd realpath check still rejects symlink escapes', async () => {
    const { project, invoke } = await fixture();
    const outside = await mkdtemp(path.join(tmpdir(), 'ape-effective-cwd-outside-'));
    cleanups.push(outside);
    await writeFile(path.join(outside, 'external.test.mjs'), '// external fixture\n');
    await symlink(outside, path.join(project, 'outside-link'), 'dir');
    const response = invoke('.', 'cd packages/api && node --test ../../outside-link/external.test.mjs');
    expect(response.hookSpecificOutput?.permissionDecision).toBe('deny');
    expect(response.hookSpecificOutput?.permissionDecisionReason).toContain('resolves outside the governed project');
    await symlink(outside, path.join(project, 'outside link'), 'dir');
    const relocated = invoke('.', "cd 'outside link' && cat external.test.mjs");
    expect(relocated.hookSpecificOutput?.permissionDecision).toBe('deny');
    expect(relocated.hookSpecificOutput?.permissionDecisionReason).toContain('resolves outside the governed project');
  });
});
