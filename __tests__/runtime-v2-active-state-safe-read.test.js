import { execFileSync } from 'node:child_process';
import {
  access,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readlink,
  readdir,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadSessionGuidance } from '../lib/runtime/session-guidance.js';
import { overrideRun, statusRun } from '../lib/runtime/service.js';
import { runtimePaths } from '../lib/runtime/paths.js';
import { ACTIVE_STATE_MAX_BYTES } from '../lib/runtime/status-service.js';

const cleanups = [];
const replacementRace = vi.hoisted(() => ({ active: null, audit: null, point: null, bytes: null, fired: false }));

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal();
  const replace = async () => {
    replacementRace.fired = true;
    await actual.rename(replacementRace.active, `${replacementRace.active}.previous`);
    await actual.writeFile(replacementRace.active, replacementRace.bytes);
  };
  return {
    ...actual,
    open: async (...args) => {
      if (!replacementRace.fired && replacementRace.point === 'open' && args[0] === replacementRace.active) {
        await replace();
      }
      return actual.open(...args);
    },
    writeFile: async (...args) => {
      const result = await actual.writeFile(...args);
      if (!replacementRace.fired && replacementRace.point === 'audit' && args[0] === replacementRace.audit) {
        await replace();
      }
      return result;
    },
    rename: async (...args) => {
      if (!replacementRace.fired && replacementRace.point === 'rename' && args[0] === replacementRace.active) {
        await replace();
      }
      return actual.rename(...args);
    },
  };
});

afterEach(async () => {
  Object.assign(replacementRace, { active: null, audit: null, point: null, bytes: null, fired: false });
  await Promise.all(cleanups.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function project(prefix) {
  const dir = await mkdtemp(path.join(tmpdir(), prefix));
  cleanups.push(dir);
  const paths = runtimePaths(dir);
  await mkdir(paths.runtime, { recursive: true });
  return { dir, paths };
}

function forensicNames(names) {
  return names.filter((name) => /^active\.json\.corrupt-\d+$/.test(name));
}

async function corruptSurfaces(dir, expectedVariant) {
  const status = await statusRun(dir);
  expect(status).toMatchObject({ ok: false, active: false, run: null });
  expect(status.reason).toMatch(/override.*reset/i);
  expect(status.corrupt_state.parse_error).toMatch(expectedVariant);

  // loadSessionGuidance is the SessionStart read path. It must remain prompt
  // and fail closed to the audited reset instead of inventing an active run.
  const guidance = await loadSessionGuidance(dir, { source: 'startup', host: 'codex' });
  expect(guidance).toContain('active state is unavailable or invalid');
  expect(guidance).toContain('Next safe action: ape_run override reset');
  expect(guidance).not.toContain('Active run:');
}

describe('APE v2 active.json descriptor-bound reads and audited recovery', () => {
  it.each(['open', 'audit', 'rename'])('preserves a valid replacement that races the %s boundary and leaves its run lock intact', async (point) => {
    const { dir, paths } = await project('ape-active-replacement-race-');
    const replacementBytes = '{"run_id":"run-replacement-must-survive"}\n';
    await writeFile(paths.active, '{broken');
    await writeFile(paths.lock, 'replacement-run-lock');
    Object.assign(replacementRace, {
      active: paths.active,
      audit: paths.overrideLog,
      point,
      bytes: replacementBytes,
    });

    await expect(overrideRun(dir, 'reset', 'recover the originally diagnosed corrupt entry'))
      .rejects.toThrow(/state changed (after it was diagnosed|during quarantine)/);

    expect(replacementRace.fired).toBe(true);
    expect(await readFile(paths.active, 'utf8')).toBe(replacementBytes);
    expect(await readFile(paths.lock, 'utf8')).toBe('replacement-run-lock');
    expect(forensicNames(await readdir(paths.runtime))).toHaveLength(0);
    expect(await readFile(`${paths.active}.previous`, 'utf8')).toBe('{broken');
  });

  it.skipIf(process.platform === 'win32')('refuses a FIFO without opening it and reset preserves the FIFO node as forensic evidence', async () => {
    const { dir, paths } = await project('ape-active-fifo-');
    execFileSync('mkfifo', [paths.active]);

    await corruptSurfaces(dir, /unsafe/i);

    const reset = await overrideRun(dir, 'reset', 'quarantine planted active-state FIFO');
    expect(reset).toMatchObject({ ok: true, recovered: 'corrupt-state', run: null });
    await expect(access(paths.active)).rejects.toMatchObject({ code: 'ENOENT' });
    const forensic = forensicNames(await readdir(paths.runtime));
    expect(forensic).toHaveLength(1);
    expect((await lstat(path.join(paths.runtime, forensic[0]))).isFIFO()).toBe(true);
  });

  it('refuses an active.json symlink and reset moves the link itself without reading or changing its target', async () => {
    const { dir, paths } = await project('ape-active-symlink-');
    const external = await mkdtemp(path.join(tmpdir(), 'ape-active-external-'));
    cleanups.push(external);
    const target = path.join(external, 'outside.json');
    const targetBytes = '{"run_id":"run-outside-must-not-be-followed"}\n';
    await writeFile(target, targetBytes);
    await symlink(target, paths.active);

    await corruptSurfaces(dir, /unsafe/i);

    const reset = await overrideRun(dir, 'reset', 'quarantine planted active-state symlink');
    expect(reset).toMatchObject({ ok: true, recovered: 'corrupt-state', run: null });
    await expect(lstat(paths.active)).rejects.toMatchObject({ code: 'ENOENT' });
    const forensic = forensicNames(await readdir(paths.runtime));
    expect(forensic).toHaveLength(1);
    const forensicPath = path.join(paths.runtime, forensic[0]);
    expect((await lstat(forensicPath)).isSymbolicLink()).toBe(true);
    expect(await readlink(forensicPath)).toBe(target);
    expect(await readFile(target, 'utf8')).toBe(targetBytes);
  });

  it('bounds an oversized regular active.json before parsing and reset preserves every byte', async () => {
    const { dir, paths } = await project('ape-active-oversized-');
    const bytes = Buffer.alloc(ACTIVE_STATE_MAX_BYTES + 1, 0x20);
    await writeFile(paths.active, bytes);

    await corruptSurfaces(dir, /oversized/i);

    const reset = await overrideRun(dir, 'reset', 'quarantine oversized active state');
    expect(reset).toMatchObject({ ok: true, recovered: 'corrupt-state', run: null });
    const forensic = forensicNames(await readdir(paths.runtime));
    expect(forensic).toHaveLength(1);
    const preserved = await readFile(path.join(paths.runtime, forensic[0]));
    expect(preserved.length).toBe(bytes.length);
    expect(preserved.equals(bytes)).toBe(true);
  });

  it('preserves both ENOENT and literal JSON null as no-active-run sentinels', async () => {
    const { dir, paths } = await project('ape-active-null-');

    await expect(statusRun(dir)).resolves.toMatchObject({ ok: true, active: false, run: null });
    await writeFile(paths.active, 'null\n');
    await expect(statusRun(dir)).resolves.toMatchObject({ ok: true, active: false, run: null });
    const guidance = await loadSessionGuidance(dir, { source: 'resume', host: 'codex' });
    expect(guidance).toContain('no active APE run');
    expect(guidance).not.toContain('active state is unavailable or invalid');
  });
});
