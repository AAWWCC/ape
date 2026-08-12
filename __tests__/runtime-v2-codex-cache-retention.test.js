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

async function fixture({ fail = false, omitRuntimeFile = false, omitGateRunner = false } = {}) {
  const root = await mkdtemp(path.join(tmpdir(), 'ape-cache-retention-test-'));
  temporaryRoots.push(root);
  const pluginRoot = path.join(root, 'plugin');
  const codexHome = path.join(root, 'codex-home');
  const cacheRoot = path.join(codexHome, 'plugins', 'cache', 'ape', 'ape');
  const oldVersion = '2.13.0+codex.old';
  const oldRoot = path.join(cacheRoot, oldVersion);
  const fakeCodex = path.join(root, 'fake-codex.mjs');
  const fakeCodexLog = path.join(root, 'fake-codex.log');

  await mkdir(path.join(pluginRoot, '.codex-plugin'), { recursive: true });
  for (const directory of ['dist', 'hooks', 'lib/runtime', 'prompts', 'skills/run']) {
    await mkdir(path.join(pluginRoot, directory), { recursive: true });
  }
  await mkdir(oldRoot, { recursive: true });
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
  await writeFile(path.join(pluginRoot, 'lib', 'runtime', 'spawn.js'), 'export const fixture = true;\n');
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
import { appendFileSync, cpSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
const args = process.argv.slice(2);
if (!statSync(process.env.CODEX_HOME).isDirectory()) process.exit(29);
appendFileSync(process.env.FAKE_CODEX_LOG, JSON.stringify(args) + '\\n');
if (args[0] === 'plugin' && args[1] === 'marketplace' && args[2] === 'add') {
  const marketplaceRoot = path.resolve(args[3]);
  const marketplace = JSON.parse(readFileSync(path.join(marketplaceRoot, '.agents', 'plugins', 'marketplace.json')));
  writeFileSync(path.join(process.env.CODEX_HOME, 'fake-marketplace.json'), JSON.stringify({ marketplaceRoot, marketplace }));
  process.exit(0);
}
if (args[0] === 'plugin' && args[1] === 'add') {
  if (process.env.FAKE_CODEX_FAIL === '1') process.exit(17);
  const [pluginName, marketplaceName] = args[2].split('@');
  const descriptor = JSON.parse(readFileSync(path.join(process.env.CODEX_HOME, 'fake-marketplace.json')));
  if (descriptor.marketplace.name !== marketplaceName) process.exit(19);
  const entry = descriptor.marketplace.plugins.find((candidate) => candidate.name === pluginName);
  const pluginRoot = path.resolve(descriptor.marketplaceRoot, entry.source.path);
  const manifest = JSON.parse(readFileSync(path.join(pluginRoot, '.codex-plugin', 'plugin.json')));
  const destination = path.join(process.env.CODEX_HOME, 'plugins', 'cache', marketplaceName, pluginName, manifest.version);
  mkdirSync(destination, { recursive: true });
  cpSync(pluginRoot, destination, { recursive: true });
  process.exit(0);
}
process.exit(23);
`,
  );
  await chmod(fakeCodex, 0o755);

  return { cacheRoot, codexHome, fail, fakeCodex, fakeCodexLog, oldRoot, oldVersion, pluginRoot };
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
    'retained-test',
  ];
  const env = {
    ...process.env,
    FAKE_CODEX_FAIL: context.fail ? '1' : '0',
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
  it('atomically installs an allowlisted cache while retaining prior versions', async () => {
    const context = await fixture();
    const result = await runFixture(context);
    const nextVersion = '2.13.0+codex.retained-test';

    expect(result.exitCode).toBe(0);
    expect(await readFile(path.join(context.oldRoot, 'old-task-sentinel.txt'), 'utf8')).toBe(
      'still available\n',
    );
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
    expect(JSON.parse(await readFile(path.join(installed, 'package.json'), 'utf8')).type).toBe('module');
    expect((await readdir(installed)).sort()).toEqual(
      ['.codex-plugin', '.mcp.json', 'LICENSE', 'THIRD_PARTY_NOTICES.md', 'dist', 'hooks', 'lib', 'package.json', 'prompts', 'skills'].sort(),
    );
    for (const forbidden of ['.git', '.ape', 'agents', 'assets', 'node_modules', '__tests__', 'docs']) {
      await expect(readFile(path.join(installed, forbidden, 'must-not-ship.txt'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
    }
    expect(result.stdout).toContain('Installed lean cache');
    expect((await readFile(context.fakeCodexLog, 'utf8')).trim().split('\n')).toHaveLength(2);
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
});
