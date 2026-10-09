import { execFile } from 'node:child_process';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import { APE_VERSION } from '../lib/runtime/versions.js';

const run = promisify(execFile);
const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const roots = [];
afterEach(async () => Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))));

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), 'ape-claude-refresh-test-'));
  roots.push(root);
  const config = path.join(root, 'config');
  const plugin = path.join(root, 'plugin');
  const cli = path.join(root, 'claude.mjs');
  const log = path.join(root, 'commands.ndjson');
  const market = path.join(config, 'dev-plugins', 'ape-dev');
  const catalog = path.join(market, '.claude-plugin', 'marketplace.json');
  await mkdir(config);
  await cp(path.join(ROOT, 'plugins', 'ape-claude'), plugin, { recursive: true });
  await writeFile(cli, `
import { appendFileSync, cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
const args = process.argv.slice(2);
appendFileSync(process.env.FAKE_CLAUDE_LOG, JSON.stringify(args) + '\\n');
const config = process.env.CLAUDE_CONFIG_DIR;
const marketFile = path.join(config, 'marketplace.json');
const installedFile = path.join(config, 'installed.json');
const read = file => existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : [];
if (args[1] === 'validate') process.exit(0);
if (args[1] === 'marketplace' && args[2] === 'list') {
  console.log(JSON.stringify(read(marketFile))); process.exit(0);
}
if (args[1] === 'marketplace' && args[2] === 'add') {
  writeFileSync(marketFile, JSON.stringify([{ name: 'ape-dev', source: 'directory', path: args[3] }])); process.exit(0);
}
if (args[1] === 'marketplace' && args[2] === 'update') process.exit(args[3] === 'ape-dev' ? 0 : 21);
if (args[1] === 'list') { console.log(JSON.stringify(read(installedFile))); process.exit(0); }
if (['install', 'update'].includes(args[1])) {
  if (args[2] !== 'ape@ape-dev' || args[3] !== '--scope' || args[4] !== 'local') process.exit(23);
  const market = read(marketFile)[0].path;
  const catalog = JSON.parse(readFileSync(path.join(market, '.claude-plugin', 'marketplace.json'), 'utf8'));
  const source = path.resolve(market, catalog.plugins[0].source);
  const manifest = JSON.parse(readFileSync(path.join(source, '.claude-plugin', 'plugin.json'), 'utf8'));
  const cache = path.join(config, 'plugins', 'cache', 'ape-dev', 'ape');
  if (existsSync(cache)) for (const name of readdirSync(cache)) {
    if (process.env.FAKE_CLAUDE_ORPHAN === '1') writeFileSync(path.join(cache, name, '.orphaned_at'), String(Date.now()));
    else rmSync(path.join(cache, name), { recursive: true, force: true });
  }
  if (process.env.FAKE_CLAUDE_FAIL === '1') { console.error('synthetic update failure'); process.exit(17); }
  const destination = path.join(cache, manifest.version.replaceAll('+', '-'));
  mkdirSync(destination, { recursive: true });
  cpSync(source, destination, { recursive: true });
  if (process.env.FAKE_CLAUDE_WRONG_BYTES === '1') writeFileSync(path.join(destination, 'dist', 'ape-mcp.bundle.mjs'), 'wrong bytes');
  writeFileSync(installedFile, JSON.stringify([{ id: 'ape@ape-dev', version: manifest.version, scope: 'local', enabled: true, projectPath: process.cwd(), installPath: destination }]));
  process.exit(0);
}
process.exit(25);
`);
  const invoke = async (token = 'first', extra = {}) => {
    try {
      const result = await run(process.execPath, [path.join(ROOT, 'scripts/reinstall-claude-plugin.mjs'),
        '--plugin-root', plugin, '--claude-config', config, '--project-root', root,
        '--claude-bin', cli, '--cachebuster', token], {
        cwd: root, env: { ...process.env, FAKE_CLAUDE_LOG: log, ...extra }, timeout: 30000,
      });
      return { ...result, code: 0 };
    } catch (error) { return error; }
  };
  const selected = async () => JSON.parse(await readFile(path.join(config, 'installed.json'), 'utf8'))[0];
  return { root, config, plugin, log, market, catalog, invoke, selected };
}

describe('Claude APE development installer', () => {
  it('publishes only APE into a dedicated local marketplace and verifies the installation', async () => {
    const c = await fixture();
    const before = await readFile(path.join(c.plugin, '.claude-plugin', 'plugin.json'), 'utf8');
    const result = await c.invoke();
    expect(result.code, result.stderr).toBe(0);
    expect(result.stdout).toContain('Verified local Claude installation: ape@ape-dev');
    expect(await c.selected()).toMatchObject({ id: 'ape@ape-dev', scope: 'local', enabled: true, version: `${APE_VERSION}+claude.first` });
    expect(await readFile(path.join(c.plugin, '.claude-plugin', 'plugin.json'), 'utf8')).toBe(before);
    const commands = (await readFile(c.log, 'utf8')).trim().split('\n').map(JSON.parse);
    expect(commands.filter(command => ['install', 'update'].includes(command[1]))).toEqual([
      ['plugin', 'install', 'ape@ape-dev', '--scope', 'local'],
    ]);
    expect(commands.some(command => ['disable', 'uninstall', 'remove'].includes(command[1]))).toBe(false);
    expect((await c.invoke()).code).toBe(0);
  });

  it.each(['prunes', 'marks for eviction'])('retains all older pinned paths when an update %s the cache', async mode => {
    const c = await fixture();
    expect((await c.invoke()).code).toBe(0);
    const pinned = [];
    for (const token of ['second', 'third']) {
      const old = await c.selected();
      pinned.push({ installPath: old.installPath, bytes: await readFile(path.join(old.installPath, 'dist', 'ape-mcp.bundle.mjs')) });
      await writeFile(path.join(c.plugin, 'dist', 'ape-mcp.bundle.mjs'), `updated fixture build ${token}`);
      expect((await c.invoke(token, { FAKE_CLAUDE_ORPHAN: mode === 'marks for eviction' ? '1' : '0' })).code).toBe(0);
      expect((await c.selected()).version).toBe(`${APE_VERSION}+claude.${token}`);
      for (const previous of pinned) {
        expect(await readFile(path.join(previous.installPath, 'dist', 'ape-mcp.bundle.mjs'))).toEqual(previous.bytes);
        await expect(readFile(path.join(previous.installPath, '.orphaned_at'))).rejects.toMatchObject({ code: 'ENOENT' });
      }
    }
  }, 60_000);

  it('restores the catalog and older pinned path after a failed native update', async () => {
    const c = await fixture();
    expect((await c.invoke()).code).toBe(0);
    const old = await c.selected();
    const catalog = await readFile(c.catalog, 'utf8');
    const result = await c.invoke('second', { FAKE_CLAUDE_FAIL: '1' });
    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain('synthetic update failure');
    expect(await readFile(c.catalog, 'utf8')).toBe(catalog);
    expect(JSON.parse(await readFile(path.join(old.installPath, '.claude-plugin', 'plugin.json'), 'utf8')).version).toBe(old.version);
    expect((await c.invoke('second')).code).toBe(0);
  });

  it('refuses an unrelated marketplace before changing its catalog or installing', async () => {
    const c = await fixture();
    await writeFile(path.join(c.config, 'marketplace.json'), JSON.stringify([{ name: 'ape-dev', source: 'github', path: c.root }]));
    const result = await c.invoke();
    expect(result.stderr).toContain('refusing to replace an unrelated');
    await expect(readFile(c.catalog)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(c.selected()).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('refuses changed bytes under an already published version', async () => {
    const c = await fixture();
    expect((await c.invoke()).code).toBe(0);
    const before = await c.selected();
    await writeFile(path.join(c.plugin, 'dist', 'ape-mcp.bundle.mjs'), 'different bytes');
    const result = await c.invoke();
    expect(result.stderr).toContain('already exists with different content');
    expect(await c.selected()).toEqual(before);
  });

  it('refuses a native installation with different bytes', async () => {
    const c = await fixture();
    const result = await c.invoke('first', { FAKE_CLAUDE_WRONG_BYTES: '1' });
    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain('did not select the expected ape-dev version and package bytes');
    expect(result.stdout).not.toContain('Verified local Claude installation');
  });

  it('rejects a non-APE package before invoking Claude', async () => {
    const c = await fixture();
    const file = path.join(c.plugin, '.claude-plugin', 'plugin.json');
    const manifest = JSON.parse(await readFile(file, 'utf8'));
    await writeFile(file, JSON.stringify({ ...manifest, name: 'unrelated-plugin' }));
    const result = await c.invoke();
    expect(result.stderr).toContain('requires the generated APE Claude package');
    await expect(readFile(c.log)).rejects.toMatchObject({ code: 'ENOENT' });
  });
});
