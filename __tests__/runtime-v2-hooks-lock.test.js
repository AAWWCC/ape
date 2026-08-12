import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { acquireRunLock, releaseRunLock } from '../lib/runtime/lock.js';
import {
  evaluateLifecyclePolicy,
  evaluateTreePolicy,
  normalizeLifecycleEvent,
} from '../lib/runtime/hooks.js';

const cleanups = [];
afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('APE v2 lifecycle hook policy', () => {
  const state = { status: 'running' };
  const implementer = {
    ticket_id: 't1',
    role: 'implementer',
    writable: true,
    claimed_paths: ['src'],
    test_paths: ['tests'],
  };

  it('denies main-session production writes', () => {
    const event = normalizeLifecycleEvent({
      project_dir: '/repo',
      tool_name: 'Write',
      tool_input: { file_path: '/repo/src/a.js' },
    }, {});
    expect(evaluateLifecyclePolicy(event, { state, ticket: implementer })).toMatchObject({
      decision: 'deny',
    });
  });

  it('enforces claims and role separation', () => {
    const event = normalizeLifecycleEvent({
      project_dir: '/repo',
      tool_name: 'Write',
      tool_input: { file_path: '/repo/tests/a.test.js' },
      agent_id: 'agent-1',
      ticket_id: 't1',
    }, {});
    expect(evaluateLifecyclePolicy(event, { state, ticket: implementer }).reason)
      .toMatch(/implementers may not modify authored tests/);

    const reviewer = { ...implementer, role: 'reviewer', writable: false };
    expect(evaluateLifecyclePolicy(event, { state, ticket: reviewer }).reason)
      .toMatch(/read-only/);
  });

  it('blocks shell-write bypasses and catches unowned tree results', () => {
    const shell = normalizeLifecycleEvent({
      project_dir: '/repo',
      tool_name: 'Bash',
      tool_input: { command: 'printf hacked > src/a.js' },
    }, {});
    expect(evaluateLifecyclePolicy(shell, { state, ticket: implementer }).decision).toBe('deny');
    expect(evaluateTreePolicy(shell, { state, ticket: null }, ['src/a.js']).decision).toBe('deny');
  });
});

describe('APE v2 active-run lock', () => {
  it('allows one owner and rejects a second writing run', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'ape-lock-'));
    cleanups.push(dir);
    const lock = path.join(dir, 'active.lock');
    await acquireRunLock(lock, 'run-1');
    await expect(acquireRunLock(lock, 'run-2')).rejects.toThrow(/another APE writing run/);
    const stored = JSON.parse(await readFile(lock, 'utf8'));
    expect(stored.run_id).toBe('run-1');
    await releaseRunLock(lock, 'run-1');
  });
});
