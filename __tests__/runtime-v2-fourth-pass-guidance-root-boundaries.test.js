import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { doctor } from '../lib/runtime/doctor.js';
import { loadSessionGuidance } from '../lib/runtime/session-guidance.js';

const fixtures = [];
afterEach(async () => {
  await Promise.all(fixtures.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});
const state = {
  schema_version: '2.0.0', version: 2, run_id: 'run-outside-project', host: 'claude', mode: 'phase',
  lane: 'full', status: 'blocked', stage: 'preflight', tickets: [], receipts: [], expired_tickets: [],
};

describe('fourth-pass diagnostic runtime ancestor containment', () => {
  it.each(['.ape', 'runtime'])('does not orient a session from a redirected %s directory', async (redirect) => {
    const directory = await mkdtemp(path.join(tmpdir(), 'ape-fourth-guidance-'));
    fixtures.push(directory);
    const project = path.join(directory, 'project');
    const outside = path.join(directory, 'outside');
    const outsideRuntime = redirect === '.ape' ? path.join(outside, 'runtime') : outside;
    await mkdir(project);
    await mkdir(outsideRuntime, { recursive: true });
    const active = path.join(outsideRuntime, 'active.json');
    const sentinel = `${JSON.stringify(state)}\n`;
    await writeFile(active, sentinel);
    if (redirect === 'runtime') await mkdir(path.join(project, '.ape'));
    await symlink(outside, redirect === '.ape' ? path.join(project, '.ape') : path.join(project, '.ape', 'runtime'), 'dir');
    for (const host of ['claude', 'codex']) {
      const guidance = await loadSessionGuidance(project, { host, native_input: { session_id: 'parent', turn_id: 'turn' } });
      expect(guidance).not.toContain(state.run_id);
      expect(guidance).toContain('active state is unavailable or invalid');
      expect(guidance).toContain('restore ordinary governed .ape and .ape/runtime directories within this project');
      expect(guidance).toContain('retry ape_status before invoking APE recovery');
      expect(guidance).not.toContain('ape_run override reset');
    }
    const report = await doctor(project);
    expect(report.checks.find((check) => check.name === 'state-dir').passed).toBe(false);
    expect(JSON.stringify(report)).not.toContain(state.run_id);
    expect(await readFile(active, 'utf8')).toBe(sentinel);
  });

  it('retains supported reset guidance for a corrupt active file under ordinary runtime ancestors', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'ape-fourth-guidance-corrupt-'));
    fixtures.push(directory);
    const runtime = path.join(directory, '.ape', 'runtime');
    await mkdir(runtime, { recursive: true });
    for (const contents of ['{', '{}']) {
      await writeFile(path.join(runtime, 'active.json'), contents);
      const guidance = await loadSessionGuidance(directory, { host: 'claude' });
      expect(guidance).toContain('Next safe action: ape_run override reset');
      expect(guidance).not.toContain('restore ordinary governed');
      expect(await readFile(path.join(runtime, 'active.json'), 'utf8')).toBe(contents);
    }
  });

  it('keeps a canonical project alias readable and an unconfigured project quiet', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'ape-fourth-guidance-alias-'));
    fixtures.push(directory);
    const project = path.join(directory, 'project');
    await mkdir(project);
    expect(await loadSessionGuidance(project)).toBeNull();
    await mkdir(path.join(project, '.ape', 'runtime'), { recursive: true });
    await writeFile(path.join(project, '.ape', 'runtime', 'active.json'), JSON.stringify(state));
    const alias = path.join(directory, 'alias');
    await symlink(project, alias, 'dir');
    expect(await loadSessionGuidance(alias, { host: 'claude' })).toContain(state.run_id);
    expect((await doctor(alias)).checks.find((check) => check.name === 'state-dir').passed).toBe(true);
  });
});
