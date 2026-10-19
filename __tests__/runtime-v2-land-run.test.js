import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, it, expect, afterEach } from 'vitest';
import { runGit, currentTreeSha, currentCommitSha } from '../lib/runtime/git.js';
import { landRun } from '../lib/runtime/lifecycle-service.js';
import { atomicWriteJson } from '../lib/runtime/storage.js';

describe('APE 1-Click Local Patch Landing (landRun)', () => {
  const tempDirs = [];

  function createTempGitRepo() {
    const dir = mkdtempSync(path.join(tmpdir(), 'ape-land-test-'));
    tempDirs.push(dir);
    return dir;
  }

  afterEach(() => {
    while (tempDirs.length > 0) {
      try {
        rmSync(tempDirs.pop(), { recursive: true, force: true });
      } catch {}
    }
  });

  it('lands verified changes directly to the branch while pruning ephemeral acceptance traps', async () => {
    const repo = createTempGitRepo();
    await runGit(repo, ['init', '-b', 'main']);
    await runGit(repo, ['config', 'user.name', 'Test User']);
    await runGit(repo, ['config', 'user.email', 'test@example.com']);

    // Initial commit
    writeFileSync(path.join(repo, 'README.md'), '# Initial Repo\n', 'utf8');
    await runGit(repo, ['add', 'README.md']);
    await runGit(repo, ['commit', '-m', 'Initial commit']);
    const baseCommit = await currentCommitSha(repo);

    // Create .ape runtime structure
    const apeDir = path.join(repo, '.ape');
    const runtimeDir = path.join(apeDir, 'runtime');
    mkdirSync(runtimeDir, { recursive: true });

    // Now simulate worktree changes: one production file and one ephemeral trap test
    mkdirSync(path.join(repo, 'src'), { recursive: true });
    mkdirSync(path.join(repo, 'tests'), { recursive: true });

    writeFileSync(path.join(repo, 'src', 'calculator.js'), 'export function add(a, b) { return a + b; }\n', 'utf8');
    writeFileSync(path.join(repo, 'tests', 'red_trap.ephemeral.js'), 'test("ephemeral trap", () => {});\n', 'utf8');

    // Create the tree containing these changes
    await runGit(repo, ['add', '-A']);
    const headTreeSha = await currentTreeSha(repo);

    // Reset working tree back to base commit so we can test landing the patch
    await runGit(repo, ['reset', '--hard', baseCommit]);
    expect(existsSync(path.join(repo, 'src', 'calculator.js'))).toBe(false);

    // Write simulated active.json state
    const runId = 'run-test-land-123';
    const state = {
      run_id: runId,
      status: 'completed',
      objective: 'Implement calculator addition function',
      base_commit_sha: baseCommit,
      tickets: [],
      receipts: [
        {
          receipt_id: 'rcpt-1',
          ticket_id: 'tkt-1',
          stage_id: 'implement',
          role: 'implementer',
          head_tree_sha: headTreeSha,
          status: 'passed',
        },
      ],
    };
    await atomicWriteJson(path.join(runtimeDir, 'active.json'), state);

    // Execute landRun with auto-commit
    const result = await landRun(repo, { commit: true });
    expect(result.ok).toBe(true);
    expect(result.landed).toBe(true);
    expect(result.run_id).toBe(runId);

    // Verify production file was landed
    expect(existsSync(path.join(repo, 'src', 'calculator.js'))).toBe(true);

    // Verify ephemeral trap test was PRUNED and NOT landed!
    expect(existsSync(path.join(repo, 'tests', 'red_trap.ephemeral.js'))).toBe(false);

    // Verify commit was created with attribution trailer
    const latestCommitMsg = await runGit(repo, ['log', '-1', '--pretty=%B']);
    expect(latestCommitMsg).toContain('Implement calculator addition function');
    expect(latestCommitMsg).toContain(`Verified-by: APE (${runId})`);
  });
});
