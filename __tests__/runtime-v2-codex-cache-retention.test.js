import { localExecutionIdentity } from '../lib/runtime/host-identity.js';
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

const REPO_ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const SCRIPT = path.join(REPO_ROOT, 'scripts', 'reinstall-codex-plugin.mjs');
const temporaryRoots = [];

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

async function fixture({ fail = false, nativeFail = false, sourceType = 'local', unrelatedMarketplace = false, omitRuntimeFile = false, omitGateRunner = false, omitFileStats = false, omitHostIdentity = false } = {}) {
  const root = await mkdtemp(path.join(tmpdir(), 'ape-cache-retention-test-'));
  temporaryRoots.push(root);
  const pluginRoot = path.join(root, 'plugin');
  const codexHome = path.join(root, 'codex-home');
  const cacheRoot = path.join(codexHome, 'plugins', 'cache', 'ape-dev', 'ape');
  const marketplaceRoot = unrelatedMarketplace
    ? path.join(root, 'unrelated-marketplace')
    : path.join(codexHome, 'dev-plugins', 'ape-dev');
  const marketplaceFile = path.join(marketplaceRoot, '.agents', 'plugins', 'marketplace.json');
  const oldVersion = '2.13.0+codex.zz-old';
  const oldRoot = path.join(cacheRoot, oldVersion);
  const retainedRoot = path.join(marketplaceRoot, 'retained-cache', 'ape');
  const fakeCodex = path.join(root, 'fake-codex.mjs');
  const fakeCodexLog = path.join(root, 'fake-codex.log');

  await mkdir(path.join(pluginRoot, '.codex-plugin'), { recursive: true });
  for (const directory of ['dist', 'hooks', 'lib/runtime', 'prompts', 'skills/run']) {
    await mkdir(path.join(pluginRoot, directory), { recursive: true });
  }
  await mkdir(oldRoot, { recursive: true });
  await mkdir(path.dirname(marketplaceFile), { recursive: true });
  const oldSource = path.join(marketplaceRoot, 'plugins', 'ape');
  await mkdir(path.join(oldSource, '.codex-plugin'), { recursive: true });
  await writeFile(path.join(oldSource, '.codex-plugin', 'plugin.json'), JSON.stringify({ name: 'ape', version: oldVersion }));
  await writeFile(marketplaceFile, JSON.stringify({
    name: 'ape-dev',
    plugins: [{ name: 'ape', source: { source: 'local', path: './plugins/ape' }, policy: { installation: 'AVAILABLE', authentication: 'ON_INSTALL' }, category: 'Engineering' }],
  }));
  await writeFile(path.join(codexHome, 'fake-marketplace.json'), JSON.stringify({ marketplaceRoot, sourceType }));
  await writeFile(path.join(codexHome, 'fake-installed.json'), JSON.stringify({ pluginId: 'ape@ape-dev', version: oldVersion, source: { source: 'local', path: oldSource } }));
  await writeFile(
    path.join(pluginRoot, '.codex-plugin', 'plugin.json'),
    `${JSON.stringify({
      name: 'ape',
      version: oldVersion,
      description: 'fixture plugin',
      mcpServers: './.mcp.json',
    }, null, 2)}\n`,
  );
  await writeFile(
    path.join(pluginRoot, '.mcp.json'),
    `${JSON.stringify({
      mcpServers: {
        ape: {
          command: 'node',
          args: ['./dist/ape-mcp.bundle.mjs', '--host', 'codex'],
          cwd: '.',
        },
      },
    })}\n`,
  );
  if (!omitRuntimeFile) await writeFile(path.join(pluginRoot, 'dist', 'ape-mcp.bundle.mjs'), 'mcp\n');
  await writeFile(path.join(pluginRoot, 'dist', 'ape-hooks.bundle.mjs'), 'hooks\n');
  await writeFile(path.join(pluginRoot, 'dist', 'ape-larp.bundle.mjs'), 'larp\n');
  if (!omitGateRunner) {
    await writeFile(path.join(pluginRoot, 'lib', 'runtime', 'runner.js'), "import './spawn.js';\n");
  }
  await writeFile(path.join(pluginRoot, 'lib', 'runtime', 'spawn.js'), "import './file-stats.js';\nimport './host-identity.js';\nexport const fixture = true;\n");
  if (!omitFileStats) {
    await writeFile(path.join(pluginRoot, 'lib', 'runtime', 'file-stats.js'), 'export const fixture = true;\n');
  }
  if (!omitHostIdentity) {
    await writeFile(path.join(pluginRoot, 'lib', 'runtime', 'host-identity.js'), 'export const fixture = true;\n');
  }
  await writeFile(path.join(pluginRoot, 'package.json'), '{"name":"ape-fixture","type":"module"}\n');
  await writeFile(path.join(pluginRoot, 'hooks', 'hooks.json'), '{}\n');
  await writeFile(path.join(pluginRoot, 'prompts', 'common.md'), 'common\n');
  await writeFile(path.join(pluginRoot, 'skills', 'run', 'SKILL.md'), '---\nname: run\n---\n');
  await writeFile(path.join(pluginRoot, 'LICENSE'), 'MIT\n');
  await writeFile(path.join(pluginRoot, 'THIRD_PARTY_NOTICES.md'), 'No bundled audio.\n');
  for (const forbidden of ['.git', '.ape', 'agents', 'assets', 'node_modules', '__tests__', 'docs']) {
    await mkdir(path.join(pluginRoot, forbidden), { recursive: true });
    await writeFile(path.join(pluginRoot, forbidden, 'must-not-ship.txt'), 'development only\n');
  }
  await writeFile(path.join(oldRoot, 'old-task-sentinel.txt'), 'still available\n');
  await writeFile(
    fakeCodex,
    `#!/usr/bin/env node
import { appendFileSync, cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
const args = process.argv.slice(2);
if (!statSync(process.env.CODEX_HOME).isDirectory()) process.exit(29);
appendFileSync(process.env.FAKE_CODEX_LOG, JSON.stringify(args) + '\\n');
const descriptorFile = path.join(process.env.CODEX_HOME, 'fake-marketplace.json');
const installedFile = path.join(process.env.CODEX_HOME, 'fake-installed.json');
if (args[0] === 'plugin' && args[1] === 'marketplace' && args[2] === 'list') {
  const descriptor = JSON.parse(readFileSync(descriptorFile));
  const marketplace = JSON.parse(readFileSync(path.join(descriptor.marketplaceRoot, '.agents', 'plugins', 'marketplace.json')));
  console.log(JSON.stringify({ marketplaces: [{ name: marketplace.name, root: descriptor.marketplaceRoot, marketplaceSource: { sourceType: descriptor.sourceType, source: descriptor.marketplaceRoot } }] }));
  process.exit(0);
}
if (args[0] === 'plugin' && args[1] === 'marketplace' && args[2] === 'add') {
  const marketplaceRoot = path.resolve(args[3]);
  const marketplace = JSON.parse(readFileSync(path.join(marketplaceRoot, '.agents', 'plugins', 'marketplace.json')));
  writeFileSync(descriptorFile, JSON.stringify({ marketplaceRoot, sourceType: 'local' }));
  process.exit(0);
}
if (args[0] === 'plugin' && args[1] === 'add') {
  if (process.env.FAKE_CODEX_FAIL === '1') process.exit(17);
  const [pluginName, marketplaceName] = args[2].split('@');
  const descriptor = JSON.parse(readFileSync(descriptorFile));
  const marketplace = JSON.parse(readFileSync(path.join(descriptor.marketplaceRoot, '.agents', 'plugins', 'marketplace.json')));
  if (marketplace.name !== marketplaceName) process.exit(19);
  const entry = marketplace.plugins.find((candidate) => candidate.name === pluginName);
  const pluginRoot = path.resolve(descriptor.marketplaceRoot, entry.source.path);
  const manifest = JSON.parse(readFileSync(path.join(pluginRoot, '.codex-plugin', 'plugin.json')));
  const cache = path.join(process.env.CODEX_HOME, 'plugins', 'cache', marketplaceName, pluginName);
  // Codex 0.153.4 prunes other versions on a supported native install.
  if (existsSync(cache)) for (const version of readdirSync(cache)) rmSync(path.join(cache, version), { recursive: true, force: true });
  if (marketplaceName === 'ape-dev' && process.env.FAKE_CODEX_NATIVE_FAIL === '1') process.exit(31);
  const destination = path.join(cache, manifest.version);
  mkdirSync(destination, { recursive: true });
  cpSync(pluginRoot, destination, { recursive: true });
  writeFileSync(installedFile, JSON.stringify({ pluginId: pluginName + '@' + marketplaceName, version: manifest.version, source: { source: 'local', path: pluginRoot } }));
  process.exit(0);
}
if (args[0] === 'plugin' && args[1] === 'list') {
  const installed = JSON.parse(readFileSync(installedFile));
  const [pluginName, marketplaceName] = installed.pluginId.split('@');
  const cache = path.join(process.env.CODEX_HOME, 'plugins', 'cache', marketplaceName, pluginName);
  // In these fixtures the older metadata sorts later, reproducing the native
  // loader selecting a restored legacy directory instead of the new build.
  installed.version = readdirSync(cache).sort().at(-1);
  console.log(JSON.stringify({ installed: [installed] }));
  process.exit(0);
}
process.exit(23);
`,
  );
  await chmod(fakeCodex, 0o755);

  return { cacheRoot, codexHome, fail, nativeFail, fakeCodex, fakeCodexLog, marketplaceFile, marketplaceRoot, oldRoot, oldVersion, pluginRoot, retainedRoot };
}

async function runFixture(context) {
  const args = [
    SCRIPT,
    '--plugin-root',
    context.pluginRoot,
    '--codex-home',
    context.codexHome,
    '--codex-bin',
    context.fakeCodex,
    '--cachebuster',
    context.cachebuster ?? 'retained-test',
    ...(context.preserveOpenTasks ? ['--preserve-open-tasks'] : []),
  ];
  const env = {
    ...process.env,
    CODEX_HOME: context.codexHome,
    FAKE_CODEX_FAIL: context.fail ? '1' : '0',
    FAKE_CODEX_NATIVE_FAIL: context.nativeFail ? '1' : '0',
    FAKE_CODEX_LOG: context.fakeCodexLog,
  };
  return new Promise((resolvePromise, reject) => {
    const child = spawn(process.execPath, args, { env });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    child.once('error', reject);
    child.once('exit', (exitCode, signal) => {
      resolvePromise({ exitCode, signal, stderr, stdout });
    });
  });
}

describe('Codex plugin cache retention reinstall', () => {
  it('recovers the reinstall lock after its owner exits', async () => {
    const context = await fixture();
    const child = spawn(process.execPath, ['-e', 'process.exit(0)']);
    const pid = child.pid;
    await new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('exit', resolve);
    });
    const lock = path.join(context.codexHome, 'dev-plugins', '.ape-reinstall-ape-dev.lock');
    await mkdir(lock);
    await writeFile(path.join(lock, 'owner'), 'interrupted-owner');
    await writeFile(path.join(lock, 'process'), JSON.stringify({ version: 1, token: 'interrupted-owner', pid, host: localExecutionIdentity(), state: 'active' }));
    const result = await runFixture(context);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('Verified registered source and selected version');
    await expect(readdir(lock)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('preserves pinned paths while verifying selection of a newer automatic build', async () => {
    const context = await fixture();
    const result = await runFixture({ ...context, preserveOpenTasks: true, cachebuster: 'zzz-new' });
    expect(result.exitCode).toBe(0);
    expect(await readFile(path.join(context.oldRoot, 'old-task-sentinel.txt'), 'utf8')).toBe('still available\n');
    expect((await readdir(context.cacheRoot)).sort()).toEqual([context.oldVersion, '2.13.0+codex.zzz-new']);
    expect(result.stdout).toContain('Verified registered source and selected version: ape@ape-dev 2.13.0+codex.zzz-new');
    expect(result.stdout).toContain('Previous pinned cache paths were restored');
  });

  it('refuses an automatic refresh that would select an older retained snapshot', async () => {
    const context = await fixture();
    const catalog = await readFile(context.marketplaceFile, 'utf8');
    const result = await runFixture({ ...context, preserveOpenTasks: true });
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('newer than all retained cache versions');
    expect(await readFile(context.marketplaceFile, 'utf8')).toBe(catalog);
    expect(await readdir(context.cacheRoot)).toEqual([context.oldVersion]);
  });

  it('installs from a durable matching source and archives old builds outside cache discovery', async () => {
    const context = await fixture();
    const result = await runFixture(context);
    const nextVersion = '2.13.0+codex.retained-test';

    expect(result.exitCode).toBe(0);
    expect(await readFile(path.join(context.retainedRoot, context.oldVersion, 'old-task-sentinel.txt'), 'utf8')).toBe(
      'still available\n',
    );
    await expect(readFile(path.join(context.oldRoot, 'old-task-sentinel.txt'))).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await readdir(context.cacheRoot)).toEqual([nextVersion]);
    expect(
      JSON.parse(await readFile(path.join(context.cacheRoot, nextVersion, '.codex-plugin', 'plugin.json'), 'utf8'))
        .version,
    ).toBe(nextVersion);
    expect(
      JSON.parse(
        await readFile(path.join(context.pluginRoot, '.codex-plugin', 'plugin.json'), 'utf8'),
      ).version,
    ).toBe(context.oldVersion);
    const installed = path.join(context.cacheRoot, nextVersion);
    expect(await readFile(path.join(installed, 'dist', 'ape-mcp.bundle.mjs'), 'utf8')).toBe('mcp\n');
    expect(await readFile(path.join(installed, 'dist', 'ape-larp.bundle.mjs'), 'utf8')).toBe('larp\n');
    expect(await readFile(path.join(installed, 'lib', 'runtime', 'runner.js'), 'utf8')).toBe(
      "import './spawn.js';\n",
    );
    expect(await readFile(path.join(installed, 'lib', 'runtime', 'file-stats.js'), 'utf8')).toBe('export const fixture = true;\n');
    expect(await readFile(path.join(installed, 'lib', 'runtime', 'host-identity.js'), 'utf8')).toBe('export const fixture = true;\n');
    expect(JSON.parse(await readFile(path.join(installed, 'package.json'), 'utf8')).type).toBe('module');
    expect((await readdir(installed)).sort()).toEqual(
      ['.codex-plugin', '.mcp.json', 'LICENSE', 'THIRD_PARTY_NOTICES.md', 'dist', 'hooks', 'lib', 'package.json', 'prompts', 'skills'].sort(),
    );
    for (const forbidden of ['.git', '.ape', 'agents', 'assets', 'node_modules', '__tests__', 'docs']) {
      await expect(readFile(path.join(installed, forbidden, 'must-not-ship.txt'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
    }
    expect(result.stdout).toContain('Installed lean cache');
    expect(result.stdout).toContain('Desktop activation is not verified by this command');
    expect(result.stdout).toContain(`verify that a fresh task loads ${nextVersion}`);
    expect(result.stdout).not.toContain('New Codex tasks use');
    const catalog = JSON.parse(await readFile(context.marketplaceFile, 'utf8'));
    const registeredSource = path.resolve(context.marketplaceRoot, catalog.plugins[0].source.path);
    expect(JSON.parse(await readFile(path.join(registeredSource, '.codex-plugin', 'plugin.json'), 'utf8')).version).toBe(nextVersion);
    expect(await readFile(path.join(registeredSource, 'dist', 'ape-mcp.bundle.mjs'), 'utf8')).toBe('mcp\n');
    expect(result.stdout).toContain(`Verified registered source and selected version: ape@ape-dev ${nextVersion}`);
    expect(result.stdout).toContain('do not reinstall while workers are active');
    expect((await readFile(context.fakeCodexLog, 'utf8')).trim().split('\n')).toHaveLength(6);
  });

  it('archives the first development version when a second native install prunes its cache', async () => {
    const context = await fixture();
    expect((await runFixture(context)).exitCode).toBe(0);
    await writeFile(path.join(context.pluginRoot, 'dist', 'ape-mcp.bundle.mjs'), 'second build\n');
    const result = await runFixture({ ...context, cachebuster: 'second-test' });
    expect(result.exitCode).toBe(0);
    expect(await readFile(path.join(context.retainedRoot, '2.13.0+codex.retained-test', 'dist', 'ape-mcp.bundle.mjs'), 'utf8')).toBe('mcp\n');
    expect(await readFile(path.join(context.retainedRoot, context.oldVersion, 'old-task-sentinel.txt'), 'utf8')).toBe('still available\n');
    expect(await readdir(context.cacheRoot)).toEqual(['2.13.0+codex.second-test']);
    const catalog = JSON.parse(await readFile(context.marketplaceFile, 'utf8'));
    const registeredSource = path.resolve(context.marketplaceRoot, catalog.plugins[0].source.path);
    expect(await readFile(path.join(registeredSource, 'dist', 'ape-mcp.bundle.mjs'), 'utf8')).toBe('second build\n');
    expect(JSON.parse(await readFile(path.join(context.codexHome, 'fake-installed.json'), 'utf8')).version).toBe('2.13.0+codex.second-test');
  });

  it('restores prior cache paths and the source catalog after a native install fails following pruning', async () => {
    const context = await fixture({ nativeFail: true });
    const catalog = await readFile(context.marketplaceFile, 'utf8');
    const result = await runFixture(context);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('exited with code 31');
    expect(await readFile(context.marketplaceFile, 'utf8')).toBe(catalog);
    expect(await readFile(path.join(context.oldRoot, 'old-task-sentinel.txt'), 'utf8')).toBe('still available\n');
    expect(result.stdout).not.toContain('Verified registered source');
  });

  it('refuses to replace a Git marketplace or mutate its installation', async () => {
    const context = await fixture({ sourceType: 'git' });
    const catalog = await readFile(context.marketplaceFile, 'utf8');
    const result = await runFixture(context);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('refusing to replace marketplace ape-dev');
    expect(await readFile(context.marketplaceFile, 'utf8')).toBe(catalog);
    expect(await readdir(context.cacheRoot)).toEqual([context.oldVersion]);
  });

  it('refuses an unrelated local marketplace before replacing its catalog or target cache', async () => {
    const context = await fixture({ unrelatedMarketplace: true });
    const catalog = await readFile(context.marketplaceFile, 'utf8');
    const selected = await readFile(path.join(context.codexHome, 'fake-installed.json'), 'utf8');
    const result = await runFixture(context);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('refusing to replace marketplace ape-dev');
    expect(await readFile(context.marketplaceFile, 'utf8')).toBe(catalog);
    expect(await readFile(path.join(context.codexHome, 'fake-installed.json'), 'utf8')).toBe(selected);
    expect(await readFile(path.join(context.oldRoot, 'old-task-sentinel.txt'), 'utf8')).toBe('still available\n');
    expect(await readdir(context.cacheRoot)).toEqual([context.oldVersion]);
    const calls = (await readFile(context.fakeCodexLog, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
    expect(calls.some(args => args[0] === 'plugin' && args[1] === 'add' && args[2] === 'ape@ape-dev')).toBe(false);
    expect(calls.some(args => args[0] === 'plugin' && args[1] === 'marketplace' && args[2] === 'add' && args[3] === context.marketplaceRoot)).toBe(false);
  });

  it('rejects changed bytes under an already published version without changing selection', async () => {
    const context = await fixture();
    expect((await runFixture(context)).exitCode).toBe(0);
    const catalog = await readFile(context.marketplaceFile, 'utf8');
    const selected = await readFile(path.join(context.codexHome, 'fake-installed.json'), 'utf8');
    await writeFile(path.join(context.pluginRoot, 'dist', 'ape-mcp.bundle.mjs'), 'different bytes\n');
    const result = await runFixture(context);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('already exists with different content');
    expect(await readFile(context.marketplaceFile, 'utf8')).toBe(catalog);
    expect(await readFile(path.join(context.codexHome, 'fake-installed.json'), 'utf8')).toBe(selected);
    expect(await readFile(path.join(context.cacheRoot, '2.13.0+codex.retained-test', 'dist', 'ape-mcp.bundle.mjs'), 'utf8')).toBe('mcp\n');
  });

  it('retains old snapshots and leaves the source manifest unchanged when installation fails', async () => {
    const context = await fixture({ fail: true });
    const result = await runFixture(context);

    expect(result.exitCode).toBe(1);
    expect(await readFile(path.join(context.oldRoot, 'old-task-sentinel.txt'), 'utf8')).toBe(
      'still available\n',
    );
    expect(
      JSON.parse(
        await readFile(path.join(context.pluginRoot, '.codex-plugin', 'plugin.json'), 'utf8'),
      ).version,
    ).toBe(context.oldVersion);
    expect(result.stderr).toContain('exited with code 17');
    await expect(readFile(path.join(context.cacheRoot, '2.13.0+codex.retained-test', '.codex-plugin', 'plugin.json'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('fails preflight before invoking Codex when a required runtime surface is absent', async () => {
    const context = await fixture({ omitRuntimeFile: true });
    const result = await runFixture(context);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('staged plugin is missing required runtime file');
    await expect(readFile(context.fakeCodexLog, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
    expect(
      JSON.parse(await readFile(path.join(context.pluginRoot, '.codex-plugin', 'plugin.json'), 'utf8')).version,
    ).toBe(context.oldVersion);
  });

  it('fails preflight when the detached gate-runner closure is absent', async () => {
    const context = await fixture({ omitGateRunner: true });
    const result = await runFixture(context);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('staged plugin is missing required runtime file: lib/runtime/runner.js');
    await expect(readFile(context.fakeCodexLog, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
    expect(
      JSON.parse(await readFile(path.join(context.pluginRoot, '.codex-plugin', 'plugin.json'), 'utf8')).version,
    ).toBe(context.oldVersion);
  });

  it('fails preflight before invoking Codex when the execution-identity dependency is absent', async () => {
    const context = await fixture({ omitHostIdentity: true });
    const result = await runFixture(context);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('staged plugin is missing required runtime file: lib/runtime/host-identity.js');
    await expect(readFile(context.fakeCodexLog, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await readFile(path.join(context.oldRoot, 'old-task-sentinel.txt'), 'utf8')).toBe('still available\n');
    expect(await readdir(context.cacheRoot)).toEqual([context.oldVersion]);
  });

  it('fails preflight before invoking Codex when the shared file-stat dependency is absent', async () => {
    const context = await fixture({ omitFileStats: true });
    const result = await runFixture(context);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('staged plugin is missing required runtime file: lib/runtime/file-stats.js');
    await expect(readFile(context.fakeCodexLog, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
    expect(
      JSON.parse(await readFile(path.join(context.pluginRoot, '.codex-plugin', 'plugin.json'), 'utf8')).version,
    ).toBe(context.oldVersion);
    expect(await readFile(path.join(context.oldRoot, 'old-task-sentinel.txt'), 'utf8')).toBe('still available\n');
    await expect(readFile(path.join(context.cacheRoot, '2.13.0+codex.retained-test', '.codex-plugin', 'plugin.json'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
  });

});
