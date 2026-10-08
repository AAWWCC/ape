import { spawn } from 'node:child_process';
import { chmod, copyFile, mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { resolveMarketplaceHostInvocation } from '../scripts/marketplace-host-invocation.mjs';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const SCRIPT = path.join(ROOT, 'scripts/reinstall-codex-plugin.mjs');
const scratch = [];

afterEach(async () => {
  await Promise.all(scratch.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

async function fixture() {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), 'ape default launcher ')));
  scratch.push(root);
  const prefix = path.join(root, 'npm prefix & percent% bang! (literal)');
  const packageRoot = path.join(prefix, 'node_modules', '@openai', 'codex');
  const entry = path.join(packageRoot, 'bin', 'codex.cjs');
  const marker = path.join(root, 'entry.json');
  const home = path.join(root, 'target home');
  const plugin = path.join(root, 'plugin');
  const platformImport = path.join(root, 'windows-platform.mjs');
  await mkdir(path.dirname(entry), { recursive: true });
  await mkdir(home);
  await writeFile(path.join(home, 'sentinel'), 'unchanged target home\n');
  for (const directory of ['.codex-plugin', 'dist', 'hooks', 'lib/runtime', 'prompts', 'skills/run']) {
    await mkdir(path.join(plugin, directory), { recursive: true });
  }
  const files = {
    '.codex-plugin/plugin.json': JSON.stringify({ name: 'ape', version: '1.0.0', description: 'launcher fixture', mcpServers: './.mcp.json' }),
    '.mcp.json': JSON.stringify({ mcpServers: { ape: { command: 'node', args: ['./dist/ape-mcp.bundle.mjs', '--host', 'codex'], cwd: '.' } } }),
    'hooks/hooks.json': '{}',
    'package.json': '{"type":"module"}',
    'dist/ape-mcp.bundle.mjs': '',
    'dist/ape-hooks.bundle.mjs': '',
    'dist/ape-larp.bundle.mjs': '',
    'lib/runtime/runner.js': '',
    'lib/runtime/spawn.js': '',
    'lib/runtime/file-stats.js': '',
    'lib/runtime/host-identity.js': '',
    'prompts/common.md': 'fixture',
    'skills/run/SKILL.md': 'fixture',
    'THIRD_PARTY_NOTICES.md': 'fixture',
  };
  for (const [name, contents] of Object.entries(files)) await writeFile(path.join(plugin, name), contents);
  await writeFile(entry, `const fs = require('node:fs');
fs.writeFileSync(process.env.APE_LAUNCHER_MARKER, JSON.stringify({
  entry: fs.realpathSync(__filename), argv: process.argv.slice(2),
  home: process.env.CODEX_HOME, cwd: process.cwd(),
  homeExists: fs.statSync(process.env.CODEX_HOME).isDirectory()
}));
process.exit(41);
`);
  await writeFile(path.join(packageRoot, 'package.json'), JSON.stringify({ name: '@openai/codex', bin: { codex: 'bin/codex.cjs' } }));
  // This is a discovery marker, deliberately NOT an executable implementation.
  // Executing an npm batch shim would produce this diagnostic instead of the JS marker.
  await writeFile(path.join(prefix, 'codex.cmd'), '@echo SHIM_MUST_NOT_EXECUTE 1>&2\r\n@exit /b 73\r\n');
  await writeFile(platformImport, "Object.defineProperty(process, 'platform', { value: 'win32' });\n");
  return { root, prefix, packageRoot, entry: await realpath(entry), marker, home, plugin, platformImport };
}

function environment(context, searchPath = context.prefix) {
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (/^(?:path|pathext|node_options|node_path|codex_home|home|userprofile|temp|tmp|tmpdir)$/i.test(key)) delete env[key];
  }
  // Use the canonical, test-owned root for both native and simulated-platform
  // tmpdir lookup so staging argv and cwd retain the same filesystem spelling.
  return { ...env, PATH: searchPath, PATHEXT: '.COM;.EXE;.BAT;.CMD', HOME: context.home,
    TEMP: context.root, TMP: context.root, TMPDIR: context.root,
    USERPROFILE: context.home, CODEX_HOME: context.home, APE_LAUNCHER_MARKER: context.marker };
}

function runHelper(context, { windowsLookup = false, override, searchPath } = {}) {
  // Only complementary lookup tests simulate Windows on POSIX. The first test
  // below always uses the actual host platform and runs unchanged on Windows CI.
  const args = [
    ...(windowsLookup && process.platform !== 'win32' ? ['--import', context.platformImport] : []),
    SCRIPT, '--plugin-root', context.plugin, '--codex-home', context.home,
    '--cachebuster', 'launcher-test', ...(override ? ['--codex-bin', override] : []),
  ];
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, {
      cwd: context.root, env: environment(context, searchPath), shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => child.kill(), 15_000);
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('close', (code, signal) => { clearTimeout(timer); resolve({ code, signal, stdout, stderr }); });
  });
}

async function untouchedHome(context) {
  expect(await readdir(context.home)).toEqual(['sentinel']);
  expect(await readFile(path.join(context.home, 'sentinel'), 'utf8')).toBe('unchanged target home\n');
}

async function reachedEntrypoint(context, result, entry = context.entry) {
  expect(result.signal).toBeNull();
  expect(result.code).toBe(1);
  expect(result.stderr).toContain('exited with code 41');
  expect(result.stderr).not.toContain('SHIM_MUST_NOT_EXECUTE');
  const observed = JSON.parse(await readFile(context.marker, 'utf8'));
  expect(observed.entry).toBe(await realpath(entry));
  expect(observed.argv).toEqual(['plugin', 'marketplace', 'add', path.join(observed.cwd, 'marketplace'), '--json']);
  expect(observed.home).toBe(path.join(observed.cwd, 'codex-home'));
  expect(observed.home).not.toBe(context.home);
  expect(observed.homeExists).toBe(true);
  await expect(readdir(observed.cwd)).rejects.toMatchObject({ code: 'ENOENT' });
  await untouchedHome(context);
}

describe('reinstall helper default Codex launcher', () => {
  it('executes the real default branch with a spaced npm prefix on the actual host platform', async () => {
    const context = await fixture();
    if (process.platform !== 'win32') {
      // A normal POSIX executable preserves existing PATH behavior. /usr/bin/env
      // finds only our test-owned Node link, never the operator Codex installation.
      await symlink(process.execPath, path.join(context.prefix, 'node'));
      const shim = path.join(context.prefix, 'codex');
      await writeFile(shim, `#!/usr/bin/env node\nrequire(${JSON.stringify(context.entry)});\n`);
      await chmod(shim, 0o755);
    }
    await reachedEntrypoint(context, await runHelper(context));
  });

  it('resolves the Windows npm default directly to its manifest bin (complementary portable coverage)', async () => {
    const context = await fixture();
    await reachedEntrypoint(context, await runHelper(context, { windowsLookup: true }));
  });

  it.each(['.js', '.mjs', '.cjs'])('preserves an explicit %s override with spaces and literal metacharacters', async extension => {
    const context = await fixture();
    const override = path.join(context.root, `explicit & percent% bang!${extension}`);
    // Dynamic import works for all three JavaScript module extensions.
    await writeFile(override, `import(${JSON.stringify(pathToFileURL(context.entry).href)});\n`);
    await reachedEntrypoint(context, await runHelper(context, { override }));
  });

  it('preserves an explicit native executable override', async () => {
    const context = await fixture();
    // Node is a real native executable on every CI host. Its module-loader
    // diagnostic proves the override received the helper's literal plugin argv.
    const result = await runHelper(context, { override: process.execPath });
    expect(result.code).toBe(1);
    expect(result.stderr).toMatch(/Cannot find module .*plugin/);
    expect(result.stderr).toContain('MODULE_NOT_FOUND');
    await untouchedHome(context);
  });

  it('reports missing default executable lookup with an actionable override hint before target mutations', async () => {
    const context = await fixture();
    const empty = path.join(context.root, 'empty PATH');
    await mkdir(empty);
    const result = await runHelper(context, { searchPath: empty });
    expect(result.code).toBe(1);
    expect(result.stderr).toMatch(/codex/i);
    expect(result.stderr).toMatch(/PATH|lookup|find|locat/i);
    expect(result.stderr).toContain('--codex-bin');
    await expect(readFile(context.marker)).rejects.toMatchObject({ code: 'ENOENT' });
    await untouchedHome(context);
  });

  it('selects the first npm installation in Windows PATH order', async () => {
    const first = await fixture();
    const second = await fixture();
    await reachedEntrypoint(first, await runHelper(first, { windowsLookup: true, searchPath: `${first.prefix};${second.prefix}` }));
  });

  it.runIf(process.platform === 'win32').each(['.exe', '.com'])('selects a native Windows %s executable ahead of an npm shim in the same PATH directory', async extension => {
    const context = await fixture();
    await copyFile(process.execPath, path.join(context.prefix, `codex${extension}`));
    const result = await runHelper(context, { windowsLookup: true });
    expect(result.code).toBe(1);
    expect(result.stderr).toMatch(/Cannot find module .*plugin/);
    expect(result.stderr).toContain('MODULE_NOT_FOUND');
    await expect(readFile(context.marker)).rejects.toMatchObject({ code: 'ENOENT' });
    await untouchedHome(context);
  });

  it.each(['wrong identity', 'missing bin', 'missing executable', 'traversal', 'directory bin', 'batch bin', 'missing package'])(
    'rejects an identified npm installation with %s before execution, without falling through PATH', async defect => {
      const context = await fixture();
      const fallback = await fixture();
      const manifest = { name: '@openai/codex', bin: { codex: 'bin/codex.cjs' } };
      if (defect === 'wrong identity') manifest.name = 'other-package';
      if (defect === 'missing bin') delete manifest.bin;
      if (defect === 'missing executable') manifest.bin.codex = 'bin/absent.cjs';
      if (defect === 'traversal') {
        manifest.bin.codex = '../../../outside.cjs';
        await writeFile(path.resolve(context.packageRoot, manifest.bin.codex), 'process.exit(72);');
      }
      if (defect === 'directory bin') manifest.bin.codex = 'bin';
      if (defect === 'batch bin') {
        manifest.bin.codex = 'bin/codex.cmd';
        await writeFile(path.join(context.packageRoot, manifest.bin.codex), '@exit /b 72\r\n');
      }
      await writeFile(path.join(context.packageRoot, 'package.json'), JSON.stringify(manifest));
      if (defect === 'missing package') await rm(context.packageRoot, { recursive: true });
      const result = await runHelper(context, { windowsLookup: true, searchPath: `${context.prefix};${fallback.prefix}` });
      expect(result.code).toBe(1);
      expect(result.stderr).not.toContain('exited with code 41');
      expect(result.stderr).toMatch(/codex|package|executable/i);
      expect(result.stderr).toContain('--codex-bin');
      await expect(readFile(context.marker)).rejects.toMatchObject({ code: 'ENOENT' });
      await untouchedHome(context);
    },
  );

  it('rejects a package bin symlink escaping its real package root', async () => {
    const context = await fixture();
    const outside = path.join(context.root, 'outside.cjs');
    await writeFile(outside, 'process.exit(72);');
    await rm(context.entry);
    try {
      await symlink(outside, context.entry, 'file');
    } catch (error) {
      // Windows file symlinks can require privileges absent from the runner.
      if (process.platform === 'win32' && ['EPERM', 'EACCES'].includes(error.code)) return;
      throw error;
    }
    await expect(resolveMarketplaceHostInvocation({ identity: 'codex', packageName: '@openai/codex',
      modulesRoot: path.join(context.prefix, 'node_modules'), args: [], platform: 'win32' }))
      .rejects.toThrow(/escapes its package root/);
    await untouchedHome(context);
  });
});
