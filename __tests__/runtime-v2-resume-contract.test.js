import { afterEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { access, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { resumeRun, startRun } from '../lib/runtime/service.js';
import { runtimePaths } from '../lib/runtime/paths.js';
import { atomicWriteJson, readJson } from '../lib/runtime/storage.js';

const dirs = [];
afterEach(async () => Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))));
const git = (dir, ...args) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' }).trim();
async function project() {
  const dir = await mkdtemp(path.join(tmpdir(), 'ape-resume-contract-'));
  dirs.push(dir);
  await writeFile(path.join(dir, 'README.md'), '# Synthetic resume fixture\n');
  git(dir, 'init', '-q', '-b', 'main');
  git(dir, 'config', 'user.name', 'APE Test');
  git(dir, 'config', 'user.email', 'ape@example.test');
  git(dir, 'add', 'README.md');
  git(dir, 'commit', '-qm', 'baseline');
  await atomicWriteJson(runtimePaths(dir).config, {
    shipping: { auto_merge: false, provider: 'github', required_remote_checks: false },
    test_commands: { full: 'node --test', targeted_template: 'node --test {paths}' },
  });
  return dir;
}

describe('exact resume service contract', () => {
  it('refuses resume without an active run and creates no run or worker authority', async () => {
    const dir = await project();
    const head = git(dir, 'rev-parse', 'HEAD');
    expect(await resumeRun(dir)).toEqual({ ok: false, reason: 'no active run' });
    expect(await access(runtimePaths(dir).active).then(() => true, () => false)).toBe(false);
    expect(git(dir, 'rev-parse', 'HEAD')).toBe(head);
    expect(git(dir, 'branch', '--show-current')).toBe('main');
  });

  it('resumes the same authorized active run without issuing a new ticket or widening authority', async () => {
    const dir = await project();
    const started = await startRun(dir, {
      objective: 'Read the synthetic fixture', mode: 'debug', lane: 'full', host: 'claude',
      claimed_paths: [], test_paths: [], requirements: [], risk_triggers: [], behavioral: false,
      hooks_trusted: true, subagents_available: true, explicit_invocation: true,
    });
    expect(started.ok).toBe(true);
    const before = await readJson(runtimePaths(dir).active);
    const resumed = await resumeRun(dir);
    expect(resumed.ok).toBe(true);
    expect(resumed.run.run_id).toBe(before.run_id);
    expect(resumed.run.tickets).toEqual(before.tickets);
    expect(resumed.run.claimed_paths).toEqual([]);
    expect(resumed.run.test_paths).toEqual([]);
    expect(resumed.run.tickets.every((ticket) => ticket.writable === false)).toBe(true);
  });
});
