import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadRuntimeConfig, setRuntimeConfig } from '../lib/runtime/config.js';
import { statuslineState, wireStatusline, unwireStatusline } from '../lib/runtime/statusline.js';

const fixture = vi.hoisted(() => ({ home: null }));
vi.mock('node:os', async (original) => ({ ...await original(), homedir: () => {
  if (!fixture.home) throw new Error('disposable fixture home is not initialized');
  return fixture.home;
} }));
let home;
let profile;
const limit = 1024 * 1024;
const statuslineModule = fileURLToPath(new URL('../lib/runtime/statusline.js', import.meta.url));
const configModule = fileURLToPath(new URL('../lib/runtime/config.js', import.meta.url));
beforeEach(async () => {
  home = await mkdtemp(path.join(tmpdir(), 'ape-config-read-boundary-'));
  fixture.home = home;
  vi.stubEnv('CLAUDE_CONFIG_DIR', undefined);
  profile = path.join(home, '.claude');
  await mkdir(profile);
});
afterEach(async () => {
  vi.unstubAllEnvs();
  fixture.home = null;
  await rm(home, { recursive: true, force: true });
});

function childRead(module, expression, env = {}) {
  return spawnSync(process.execPath, ['--input-type=module', '-e',
    `const subject = await import(${JSON.stringify(module)}); try { ${expression}; console.log('unexpected success'); } catch (error) { console.log(error.code); }`,
  ], { encoding: 'utf8', timeout: 3_000, env: { ...process.env, ...env } });
}

describe('configuration files have bounded ordinary-file reads', () => {
  it.skipIf(process.platform === 'win32').each(['settings.json', 'ape-statusline-wire.json', 'settings.json.bak'])(
    'rejects a Claude %s FIFO without waiting for a writer', async (name) => {
      const made = spawnSync('mkfifo', [path.join(profile, name)]);
      expect(made.status).toBe(0);
      const operation = name === 'settings.json' ? 'statuslineState' : 'wireStatusline';
      const child = childRead(statuslineModule, `await subject.${operation}({host:'claude'})`, { CLAUDE_CONFIG_DIR: profile });
      expect(child.error).toBeUndefined();
      expect(child.status).toBe(0);
      expect(child.stdout.trim()).toBe('APE_UNSAFE_FILE');
    },
  );

  it.each(['settings.json', 'ape-statusline-wire.json', 'settings.json.bak'])(
    'rejects oversized Claude %s before changing any file', async (name) => {
      await writeFile(path.join(profile, name), ' '.repeat(limit + 1));
      await expect(wireStatusline()).rejects.toMatchObject({ code: 'APE_UNSAFE_FILE' });
      expect(await readdir(profile)).toEqual([name]);
    },
  );

  it('preserves linked user settings through wire and exact original statusline restoration', async () => {
    const target = path.join(home, 'shared-settings.json');
    const initial = { statusLine: { type: 'command', command: 'my-renderer' }, theme: 'dark' };
    await writeFile(target, JSON.stringify(initial));
    await symlink(target, path.join(profile, 'settings.json'));
    expect((await wireStatusline()).wired).toBe(true);
    expect((await statuslineState()).wired).toBe(true);
    await unwireStatusline();
    expect(JSON.parse(await readFile(target, 'utf8'))).toEqual(initial);
  });

  it.each(['settings growth', 'ownership growth'])('refuses near-limit %s before backup, shim, or settings publication', async (shape) => {
    const settings = shape === 'settings growth'
      ? { padding: 'x'.repeat(limit - 60) }
      : { statusLine: { type: 'command', command: 'x'.repeat(limit - 90) } };
    const original = JSON.stringify(settings);
    expect(Buffer.byteLength(original)).toBeLessThan(limit);
    await writeFile(path.join(profile, 'settings.json'), original);
    await expect(wireStatusline()).rejects.toThrow(/exceeds/);
    expect(await readdir(profile)).toEqual(['settings.json']);
    expect(await readFile(path.join(profile, 'settings.json'), 'utf8')).toBe(original);
  });

  it.skipIf(process.platform === 'win32')('rejects a runtime configuration FIFO promptly', async () => {
    const file = path.join(home, 'config.json');
    expect(spawnSync('mkfifo', [file]).status).toBe(0);
    const child = childRead(configModule, `await subject.loadRuntimeConfig(${JSON.stringify(file)})`);
    expect(child.error).toBeUndefined();
    expect(child.status).toBe(0);
    expect(child.stdout.trim()).toBe('APE_UNSAFE_FILE');
  });

  it('bounds runtime input bytes before parsing while allowing ordinary formatting whitespace', async () => {
    const file = path.join(home, 'config.json');
    await writeFile(file, ' '.repeat(80_000) + '{"test_commands":{"full":"npm test"}}');
    expect((await loadRuntimeConfig(file)).test_commands.full).toBe('npm test');
    await writeFile(file, ' '.repeat(limit + 1));
    await expect(loadRuntimeConfig(file)).rejects.toMatchObject({ code: 'APE_UNSAFE_FILE' });
  });

  it('rejects a merged control payload over the reader budget and preserves the last readable config', async () => {
    const file = path.join(home, 'config.json');
    await setRuntimeConfig(file, 'test_commands.full', 'a'.repeat(33_000));
    const original = await readFile(file, 'utf8');
    await expect(setRuntimeConfig(file, 'test_commands.lint', 'b'.repeat(33_000))).rejects.toThrow(/65536/);
    expect(await readFile(file, 'utf8')).toBe(original);
    const loaded = await loadRuntimeConfig(file);
    expect(loaded.test_commands.full).toHaveLength(33_000);
    expect(loaded.test_commands.lint).toBeUndefined();
  });
});
