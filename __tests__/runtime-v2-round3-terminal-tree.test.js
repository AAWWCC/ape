import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { abortRun, overrideRun, recordReceipt, startRun } from '../lib/runtime/service.js';
import { currentTreeSha } from '../lib/runtime/git.js';
import { runtimePaths } from '../lib/runtime/paths.js';
import { atomicWriteJson, readJson } from '../lib/runtime/storage.js';

// Round-3 history integrity: archive_history runs before persist_state, and
// persist is where state.tree_sha is refreshed from the live tree, so a
// terminal archive used to copy a stale pre-receipt tree into final_tree_sha
// (reproduced: tree A -> B, archive still records A). Every terminal archive
// must record the tree that actually exists at the terminal moment.

const cleanups = [];
afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

function git(cwd, ...args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

async function fastProject() {
  const dir = await mkdtemp(path.join(tmpdir(), 'ape-round3-tree-'));
  cleanups.push(dir);
  await mkdir(path.join(dir, 'src'));
  await mkdir(path.join(dir, 'tests'));
  await writeFile(path.join(dir, 'src', 'value.js'), 'export const value = 1;\n');
  await writeFile(path.join(dir, 'tests', 'value.test.js'), 'throw new Error("red");\n');
  git(dir, 'init', '-q');
  git(dir, 'config', 'user.email', 'ape@example.test');
  git(dir, 'config', 'user.name', 'APE Test');
  git(dir, 'add', '.');
  git(dir, 'commit', '-qm', 'baseline');
  await atomicWriteJson(runtimePaths(dir).config, {
    shipping: { auto_merge: false, provider: 'github', required_remote_checks: false },
    test_commands: { targeted_template: 'node --test {paths}', full: 'node --test' },
  });
  return dir;
}

function fastStart() {
  return {
    objective: 'Exercise terminal-archive tree freshness',
    mode: 'phase',
    lane: 'fast',
    host: 'codex',
    claimed_paths: ['src/value.js'],
    test_paths: ['tests/value.test.js'],
    requirements: [],
    risk_triggers: [],
    behavioral: true,
    hooks_trusted: true,
    subagents_available: true,
    explicit_invocation: true,
  };
}

async function mechanicalProject(config) {
  const dir = await mkdtemp(path.join(tmpdir(), 'ape-round3-tree-mech-'));
  cleanups.push(dir);
  await mkdir(path.join(dir, 'docs'));
  await writeFile(path.join(dir, 'docs', 'note.md'), '# note\n');
  git(dir, 'init', '-q');
  git(dir, 'config', 'user.email', 'ape@example.test');
  git(dir, 'config', 'user.name', 'APE Test');
  git(dir, 'add', '.');
  git(dir, 'commit', '-qm', 'baseline');
  await atomicWriteJson(runtimePaths(dir).config, config);
  return dir;
}

async function mechanicalBlockedRun(fullCommand) {
  const dir = await mechanicalProject({
    shipping: { auto_merge: false, provider: 'github', required_remote_checks: false },
    test_commands: { full: fullCommand },
  });
  const started = await startRun(dir, {
    objective: 'Update the documentation note',
    mode: 'phase',
    lane: 'mechanical',
    host: 'codex',
    claimed_paths: ['docs/note.md'],
    test_paths: [],
    requirements: [],
    risk_triggers: [],
    behavioral: false,
    hooks_trusted: true,
    subagents_available: true,
    explicit_invocation: true,
  });
  expect(started.ok).toBe(true);
  const build = started.run.tickets[0];
  // The receipt moves the tree from the start-persisted SHA A to SHA B.
  await writeFile(path.join(dir, 'docs', 'note.md'), '# note\n\nUpdated.\n');
  const result = await recordReceipt(dir, {
    ticket_id: build.ticket_id,
    status: 'passed',
    agent_identity: 'agent-implementer',
    tests: [{ command: 'node --version', passed: true, exit_code: 0, duration_ms: 1 }],
    findings: [],
    evidence: { verdict: 'pass' },
    timing: {
      started_at: build.issued_at,
      completed_at: new Date(Date.parse(build.issued_at) + 10).toISOString(),
      duration_ms: 10,
    },
  });
  expect(result.ok).toBe(true);
  expect(result.run.status).toBe('blocked');
  return { dir, runId: started.run.run_id };
}

describe('terminal archives record the live final tree, never a stale one', () => {
  it('a gate-blocked run archives the post-receipt tree', async () => {
    const { dir, runId } = await mechanicalBlockedRun('node -e "process.exit(1)"');
    const record = await readJson(path.join(runtimePaths(dir).history, `${runId}.json`));
    expect(record.status).toBe('blocked');
    expect(record.final_tree_sha).toBe(await currentTreeSha(dir));
  });

  it('a run blocked by disabled auto-merge archives the post-receipt tree', async () => {
    const { dir, runId } = await mechanicalBlockedRun('node --version');
    const record = await readJson(path.join(runtimePaths(dir).history, `${runId}.json`));
    expect(record).toMatchObject({
      status: 'blocked',
      block_reason: 'auto-merge is disabled by configuration',
    });
    expect(record.final_tree_sha).toBe(await currentTreeSha(dir));
  });

  it('an aborted run archives the tree as it exists at the abort', async () => {
    const dir = await fastProject();
    const started = await startRun(dir, fastStart());
    expect(started.ok).toBe(true);
    // The tree moves after the last persist and before the terminal abort.
    await writeFile(path.join(dir, 'tests', 'value.test.js'), 'throw new Error("moved");\n');
    const aborted = await abortRun(dir, 'terminal-tree regression check');
    expect(aborted.ok).toBe(true);
    const record = await readJson(
      path.join(runtimePaths(dir).history, `${started.run.run_id}.json`),
    );
    expect(record.status).toBe('aborted');
    expect(record.final_tree_sha).toBe(await currentTreeSha(dir));
  });

  it('a completed run archived via override reset records the live final tree', async () => {
    const dir = await fastProject();
    const started = await startRun(dir, fastStart());
    expect(started.ok).toBe(true);
    const paths = runtimePaths(dir);
    // Simulate a run that reached completion whose archive is (re)written by
    // the override-reset path, with the tree having moved since the last
    // persist refreshed state.tree_sha.
    const state = await readJson(paths.active);
    state.status = 'completed';
    state.stage = 'complete';
    state.terminal_at = state.updated_at;
    await atomicWriteJson(paths.active, state);
    await writeFile(path.join(dir, 'src', 'value.js'), 'export const value = 99;\n');
    const reset = await overrideRun(dir, 'reset', 'archive the completed run');
    expect(reset.ok).toBe(true);
    const record = await readJson(path.join(paths.history, `${state.run_id}.json`));
    expect(record.status).toBe('completed');
    expect(record.final_tree_sha).toBe(await currentTreeSha(dir));
  });
});
