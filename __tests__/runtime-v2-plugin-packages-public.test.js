import { execFile } from 'node:child_process';
import { cp, mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';
import { verifyInstalledPackage } from '../scripts/smoke-marketplace-install.mjs';

const run = promisify(execFile);
const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const CODEX = path.join(ROOT, 'plugins', 'ape');
const CLAUDE = path.join(ROOT, 'plugins', 'ape-claude');

async function json(relative) {
  return JSON.parse(await readFile(path.join(ROOT, relative), 'utf8'));
}

async function files(root) {
  const found = [];
  async function visit(directory) {
    for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) =>
      a.name < b.name ? -1 : a.name > b.name ? 1 : 0
    )) {
      const target = path.join(directory, entry.name);
      if (entry.isDirectory()) await visit(target);
      else if (entry.isFile()) found.push(path.relative(root, target).split(path.sep).join('/'));
    }
  }
  await visit(root);
  return found;
}

function body(markdown) {
  const close = markdown.indexOf('\n---\n', 4);
  return markdown.slice(close + 5).trim();
}

describe('2.17 public plugin packages', () => {
  it('preserves unrelated ape output directories and supports repeat builds of recognized packages', async () => {
    const scratch = await mkdtemp(path.join(tmpdir(), 'ape-package-output-'));
    const build = () => run(process.execPath, [path.join(ROOT, 'scripts', 'build-plugin-packages.mjs'),
      '--output-root', scratch]);
    try {
      await mkdir(path.join(scratch, 'ape'));
      await writeFile(path.join(scratch, 'ape', 'notes.txt'), 'keep my notes');
      await expect(build()).rejects.toMatchObject({ stderr: expect.stringContaining('not recognized APE plugin artifacts') });
      expect(await readFile(path.join(scratch, 'ape', 'notes.txt'), 'utf8')).toBe('keep my notes');
      await rm(path.join(scratch, 'ape'), { recursive: true });
      await build();
      const manifestPath = path.join(scratch, 'ape', '.codex-plugin', 'plugin.json');
      const oldManifest = JSON.parse(await readFile(manifestPath, 'utf8'));
      await writeFile(manifestPath, JSON.stringify({ ...oldManifest, version: '1.0.0' }));
      await build();
      const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
      expect(manifest.name).toBe('ape');
      expect(manifest.version).toBe(oldManifest.version);
      await writeFile(path.join(scratch, 'ape', 'notes.txt'), 'keep added notes');
      await expect(build()).rejects.toMatchObject({ stderr: expect.stringContaining('not recognized APE plugin artifacts') });
      expect(await readFile(path.join(scratch, 'ape', 'notes.txt'), 'utf8')).toBe('keep added notes');
      await rm(path.join(scratch, 'ape', 'notes.txt'));
      for (const [directory, host] of [['ape', 'codex'], ['ape-claude', 'claude']]) {
        const file = path.join(scratch, directory, `.${host}-plugin`, 'plugin.json');
        const value = JSON.parse(await readFile(file, 'utf8'));
        await writeFile(file, JSON.stringify({ ...value, version: '1.0.0' }));
      }
      await writeFile(path.join(scratch, 'ape-claude', 'notes.txt'), 'preserve both previous packages');
      await expect(build()).rejects.toMatchObject({ stderr: expect.stringContaining('not recognized APE plugin artifacts') });
      for (const [directory, host] of [['ape', 'codex'], ['ape-claude', 'claude']]) {
        const value = JSON.parse(await readFile(path.join(scratch, directory, `.${host}-plugin`, 'plugin.json'), 'utf8'));
        expect(value.version).toBe('1.0.0');
      }
    } finally { await rm(scratch, { recursive: true, force: true }); }
  });

  it('refuses package output inside a source directory', async () => {
    await expect(run(process.execPath, [path.join(ROOT, 'scripts', 'build-plugin-packages.mjs'),
      '--output-root', path.join(ROOT, 'scripts')])).rejects.toMatchObject({
      stderr: expect.stringContaining('must not replace the source'),
    });
  });

  it('pins repository marketplaces to the two generated local package roots', async () => {
    const codex = await json('.agents/plugins/marketplace.json');
    expect(codex).toMatchObject({
      name: 'ape',
      plugins: [{
        name: 'ape',
        source: { source: 'local', path: './plugins/ape' },
        policy: { installation: 'AVAILABLE', authentication: 'ON_INSTALL' },
        category: 'Engineering',
      }],
    });
    const claude = await json('.claude-plugin/marketplace.json');
    expect(claude.owner).toEqual({ name: 'AAWWCC' });
    expect(claude.plugins[0].source).toBe('./plugins/ape-claude');
  });

  it('validates Codex through an isolated real marketplace install, not a maintainer-home helper', async () => {
    const pkg = await json('package.json');
    expect(pkg.scripts['validate:codex']).toBe(
      'node scripts/smoke-marketplace-install.mjs --host codex',
    );
    expect(pkg.scripts['validate:codex']).not.toMatch(/\$HOME|\.codex\/skills/u);
  });

  it('uses the AAWWCC public identity with no old personal author label or email', async () => {
    const identityFiles = [
      'LICENSE',
      'package.json',
      '.agents/plugins/marketplace.json',
      '.claude-plugin/marketplace.json',
      'plugins/ape/.codex-plugin/plugin.json',
      'plugins/ape-claude/.claude-plugin/plugin.json',
    ];
    for (const relative of identityFiles) {
      const value = await readFile(path.join(ROOT, relative), 'utf8');
      expect(value, relative).not.toMatch(new RegExp(`\\b${['Ai', 'dan'].join('')}\\b`, 'iu'));
      expect(value, relative).not.toMatch(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/iu);
    }
    for (const relative of identityFiles.filter((name) => name !== '.agents/plugins/marketplace.json')) {
      expect(await readFile(path.join(ROOT, relative), 'utf8'), relative).toContain('AAWWCC');
    }
  });

  it('ships companion-file local stdio MCP declarations with explicit host pins', async () => {
    const { version } = await json('package.json');
    const codexManifest = await json('plugins/ape/.codex-plugin/plugin.json');
    const claudeManifest = await json('plugins/ape-claude/.claude-plugin/plugin.json');
    expect(codexManifest).toMatchObject({ version, mcpServers: './.mcp.json' });
    expect(claudeManifest).toMatchObject({ version, hooks: './hooks/claude-hooks.json' });
    for (const manifest of [codexManifest, claudeManifest]) {
      expect(manifest.author).toEqual({ name: 'AAWWCC', url: 'https://github.com/AAWWCC' });
      expect(manifest.author).not.toHaveProperty('email');
    }
    expect(await json('plugins/ape/.mcp.json')).toEqual({
      mcpServers: { ape: { command: 'node', args: ['./dist/ape-mcp.bundle.mjs', '--host', 'codex'], cwd: '.' } },
    });
    expect(await json('plugins/ape-claude/.mcp.json')).toEqual({
      mcpServers: { ape: { command: 'node', args: ['${CLAUDE_PLUGIN_ROOT}/dist/ape-mcp.bundle.mjs', '--host', 'claude'] } },
    });
  });

  it('renders host-neutral skill bodies with host-specific invocation controls', async () => {
    for (const event of await readdir(path.join(ROOT, 'plugin-src', 'skills'), { withFileTypes: true })) {
      if (!event.isDirectory() || event.name === 'references') continue;
      const sourceRoot = path.join(ROOT, 'plugin-src', 'skills', event.name);
      const metadata = JSON.parse(await readFile(path.join(sourceRoot, 'metadata.json'), 'utf8'));
      let canonicalBody = (await readFile(path.join(sourceRoot, 'body.md'), 'utf8')).trim();
      if (event.name === 'run' || event.name === 'resume') {
        canonicalBody = canonicalBody.replaceAll(
          '../references/run-resume-protocol.md',
          'references/run-resume-protocol.md',
        );
      }
      const codexSkill = await readFile(path.join(CODEX, 'skills', event.name, 'SKILL.md'), 'utf8');
      const claudeSkill = await readFile(path.join(CLAUDE, 'skills', event.name, 'SKILL.md'), 'utf8');
      expect(body(codexSkill)).toBe(canonicalBody);
      expect(body(claudeSkill)).toBe(canonicalBody);
      expect(codexSkill).not.toContain('disable-model-invocation:');
      expect(codexSkill).not.toContain('argument-hint:');
      expect(
        codexSkill.slice(4, codexSkill.indexOf('\n---\n', 4)).split('\n').map((line) => line.split(':')[0]),
      ).toEqual(['name', 'description']);
      expect(claudeSkill).toContain(
        `disable-model-invocation: ${metadata.invocation === 'explicit' ? 'true' : 'false'}`,
      );
      const codexPolicy = await readFile(
        path.join(CODEX, 'skills', event.name, 'agents', 'openai.yaml'),
        'utf8',
      );
      expect(codexPolicy).toContain(
        `allow_implicit_invocation: ${metadata.invocation === 'implicit' ? 'true' : 'false'}`,
      );
      expect(codexPolicy).toContain(`$ape:${event.name}`);
    }
  });

  it('omits assets and every audio extension from both public packages', async () => {
    for (const pluginRoot of [CODEX, CLAUDE]) {
      const inventory = await files(pluginRoot);
      expect(inventory.some((name) => name === 'assets' || name.startsWith('assets/'))).toBe(false);
      expect(inventory.some((name) => /\.(?:aac|aiff|flac|m4a|mp3|ogg|wav|wma)$/iu.test(name))).toBe(false);
      for (const name of inventory) {
        const text = await readFile(path.join(pluginRoot, name), 'utf8');
        expect(text).not.toContain('\r\n');
        if (process.platform !== 'win32') {
          expect((await stat(path.join(pluginRoot, name))).mode & 0o777).toBe(0o644);
        }
      }
    }
  });

  it('is byte-identical to a fresh deterministic generator run', async () => {
    const result = await run(process.execPath, ['scripts/build-plugin-packages.mjs', '--check'], {
      cwd: ROOT,
      env: { ...process.env, SOURCE_DATE_EPOCH: '0', LC_ALL: 'C' },
    });
    expect(result.stdout).toContain('byte-identical');
  });
});


describe('installed marketplace package integrity', () => {
  it.each([false, true])('rejects invalid CLI options when the checkout is linked: %s', async (linked) => {
    const scratch = await mkdtemp(path.join(tmpdir(), 'ape-marketplace-entry-'));
    try {
      const checkout = linked ? path.join(scratch, 'checkout') : ROOT;
      if (linked) await symlink(ROOT, checkout, process.platform === 'win32' ? 'junction' : 'dir');
      await expect(run(process.execPath, [path.join(checkout, 'scripts', 'smoke-marketplace-install.mjs'), '--invalid-option']))
        .rejects.toMatchObject({ code: 1, stderr: expect.stringContaining('usage: node scripts/smoke-marketplace-install.mjs') });
    } finally { await rm(scratch, { recursive: true, force: true }); }
  });

  const hosts = [
    ['codex', CODEX, 'hooks/hooks.json'],
    ['claude', CLAUDE, 'hooks/claude-hooks.json'],
  ];

  async function installedCopy(source, check) {
    const scratch = await mkdtemp(path.join(tmpdir(), 'ape-installed-package-'));
    const installed = path.join(scratch, 'installed');
    try {
      await cp(source, installed, { recursive: true });
      await check(installed, scratch);
    } finally { await rm(scratch, { recursive: true, force: true }); }
  }

  it.each(hosts)('accepts a complete %s package and initializes its MCP server', async (host, source) => {
    await installedCopy(source, async (installed) => {
      await expect(verifyInstalledPackage(host, installed)).resolves.toBeUndefined();
    });
  });

  const damagedFiles = hosts.flatMap(([host, source, hooks]) =>
    [hooks, 'skills/run/SKILL.md'].flatMap((relative) =>
      ['missing', 'modified'].map((damage) => [host, source, relative, damage]),
    ),
  );

  it.each(damagedFiles)('rejects %s %s %s %s while its manifest version is unchanged', async (host, source, relative, damage) => {
    await installedCopy(source, async (installed) => {
      const manifest = path.join(`.${host}-plugin`, 'plugin.json');
      const before = await readFile(path.join(installed, manifest), 'utf8');
      const target = path.join(installed, relative);
      if (damage === 'missing') await rm(target);
      else {
        const bytes = await readFile(target);
        bytes[0] ^= 1;
        await writeFile(target, bytes);
      }
      expect(await readFile(path.join(installed, manifest), 'utf8')).toBe(before);
      await expect(verifyInstalledPackage(host, installed)).rejects.toThrow(relative);
    });
  });

  it.each(hosts)('rejects an additional file in the %s installed package', async (host, source) => {
    await installedCopy(source, async (installed) => {
      await writeFile(path.join(installed, 'unexpected.txt'), 'unexpected installed content');
      await expect(verifyInstalledPackage(host, installed)).rejects.toThrow('unexpected.txt');
    });
  });

  it.each(hosts)('rejects an additional empty directory in the %s installed package', async (host, source) => {
    await installedCopy(source, async (installed) => {
      await mkdir(path.join(installed, 'unexpected-directory'));
      await expect(verifyInstalledPackage(host, installed)).rejects.toThrow('unexpected-directory');
    });
  });

  it.each(hosts)('rejects linked hooks in the %s installed package even when bytes match', async (host, source) => {
    await installedCopy(source, async (installed) => {
      const target = path.join(installed, 'hooks');
      await rm(target, { recursive: true });
      await symlink(path.join(source, 'hooks'), target, process.platform === 'win32' ? 'junction' : 'dir');
      await expect(verifyInstalledPackage(host, installed)).rejects.toThrow('hooks');
    });
  });

  it.each(hosts)('rejects a linked %s package root even when bytes match', async (host, source) => {
    await installedCopy(source, async (installed) => {
      await rm(installed, { recursive: true });
      await symlink(source, installed, process.platform === 'win32' ? 'junction' : 'dir');
      await expect(verifyInstalledPackage(host, installed)).rejects.toThrow('package root');
    });
  });
});
