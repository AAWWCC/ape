import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { runtimePaths } from '../lib/runtime/paths.js';
import { startRun } from '../lib/runtime/service.js';
import { atomicWriteJson } from '../lib/runtime/storage.js';

const cleanups = [];

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

function git(cwd, ...args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

async function project(prefix = 'ape-start-test-paths-') {
  const dir = await mkdtemp(path.join(tmpdir(), prefix));
  cleanups.push(dir);
  await mkdir(path.join(dir, 'src'));
  await mkdir(path.join(dir, 'tests'));
  await mkdir(path.join(dir, 'docs'));
  await writeFile(path.join(dir, 'src', 'value.js'), 'export const value = 1;\n');
  await writeFile(path.join(dir, 'tests', 'value.test.js'), 'throw new Error("red");\n');
  await writeFile(path.join(dir, 'docs', 'notes.md'), '# Notes\n');
  git(dir, 'init', '-q');
  git(dir, 'config', 'user.email', 'ape@example.test');
  git(dir, 'config', 'user.name', 'APE Test');
  git(dir, 'add', '.');
  git(dir, 'commit', '-qm', 'baseline');
  await atomicWriteJson(runtimePaths(dir).config, {
    shipping: { auto_merge: false, provider: 'github', required_remote_checks: false },
    test_commands: { full: 'node --test' },
  });
  return dir;
}

function startInput(overrides = {}) {
  return {
    objective: 'Exercise start-time test_paths validation',
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
    ...overrides,
  };
}

// Behavioral runs still need authored test paths for the test-writer stage.
// Non-behavioral runs deliberately do not schedule that stage and therefore
// must not demand invented red-test evidence merely to satisfy admission.
describe('APE v2 start-time test_paths guard', () => {
  it('accepts a non-behavioral fast-lane start without test_paths and starts at build', async () => {
    const dir = await project();
    const started = await startRun(dir, startInput({
      lane: 'fast',
      behavioral: false,
      claimed_paths: ['src/value.js'],
      test_paths: [],
    }));
    expect(started.ok).toBe(true);
    expect(started.run.tickets[0]).toMatchObject({
      stage_id: 'build',
      role: 'implementer',
      required_checks: [],
    });
  });

  it('accepts an escalated non-behavioral lane and preserves the escalation reasons', async () => {
    const dir = await project();
    const started = await startRun(dir, startInput({
      lane: 'mechanical',
      behavioral: false,
      claimed_paths: ['src/value.js'],
      test_paths: [],
    }));
    expect(started.ok).toBe(true);
    expect(started.run.lane).toBe('fast');
    expect(started.run.lane_reasons).toContain('requested-mechanical-escalated');
    expect(started.run.tickets[0].stage_id).toBe('build');
  });

  it('accepts a non-behavioral full-lane start without test_paths and starts at planning', async () => {
    const dir = await project();
    const started = await startRun(dir, startInput({
      lane: 'full',
      behavioral: false,
      claimed_paths: ['src/value.js'],
      test_paths: [],
    }));
    expect(started.ok).toBe(true);
    expect(started.run.tickets[0]).toMatchObject({ stage_id: 'plan', role: 'planner' });
  });

  it('preserves the mechanical lane start without test_paths', async () => {
    const dir = await project();
    const started = await startRun(dir, startInput({
      lane: 'auto',
      behavioral: false,
      claimed_paths: ['docs/notes.md'],
      test_paths: [],
    }));
    expect(started.ok).toBe(true);
    expect(started.run.lane).toBe('mechanical');
    expect(started.run.tickets[0].role).toBe('implementer');
  });

  it('preserves debug and spike modes without test_paths', async () => {
    const debugDir = await project('ape-start-debug-');
    const debugStart = await startRun(debugDir, startInput({
      mode: 'debug',
      lane: 'auto',
      behavioral: false,
      claimed_paths: [],
      test_paths: [],
    }));
    expect(debugStart.ok).toBe(true);
    expect(debugStart.run.lane).toBe('full');
    expect(debugStart.run.tickets[0].role).toBe('debugger');

    const spikeDir = await project('ape-start-spike-');
    const spikeStart = await startRun(spikeDir, startInput({
      mode: 'spike',
      lane: 'auto',
      behavioral: false,
      claimed_paths: [],
      test_paths: [],
    }));
    expect(spikeStart.ok).toBe(true);
    expect(spikeStart.run.lane).toBe('full');
    expect(spikeStart.run.tickets[0].role).toBe('spike_researcher');
  });

  it('keeps the doctor block, not the guard throw, for behavioral starts with empty test_paths', async () => {
    const dir = await project();
    const result = await startRun(dir, startInput({
      lane: 'fast',
      behavioral: true,
      claimed_paths: ['src/value.js'],
      test_paths: [],
    }));
    expect(result).toMatchObject({ ok: false, blocked: true });
    expect(result.doctor.checks).toContainEqual(
      expect.objectContaining({ name: 'test-path-claims', passed: false }),
    );
  });

  it('still starts a behavioral fast run when test_paths are supplied', async () => {
    const dir = await project();
    const started = await startRun(dir, startInput({
      lane: 'fast',
      test_paths: ['tests/value.test.js'],
    }));
    expect(started.ok).toBe(true);
    const ticket = started.run.tickets[0];
    expect(ticket.role).toBe('test_writer');
    expect(ticket.claimed_paths).toEqual(['tests/value.test.js']);
  });
});
