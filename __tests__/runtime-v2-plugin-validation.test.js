import { afterEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateClaudePlugin, validateCodexPlugin } from '../lib/runtime/plugin-validation.js';
import { runtimeBundleCandidates } from '../lib/runtime/doctor.js';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const codexPackage = path.join(root, 'plugins', 'ape');
const claudePackage = path.join(root, 'plugins', 'ape-claude');

// Derive the release version from package.json so a bump never needs a manual
// edit here: the Codex manifest is that base plus an optional +codex.<build>
// build-metadata suffix.
const baseVersion = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8')).version;
const codexVersionPattern = new RegExp(
  `^${baseVersion.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?:\\+codex\\.[0-9A-Za-z.-]+)?$`,
);

const cleanups = [];
afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function pluginDir({ claude, codex } = {}) {
  const dir = await mkdtemp(path.join(tmpdir(), 'ape-plugin-'));
  cleanups.push(dir);
  if (claude !== undefined) {
    await mkdir(path.join(dir, '.claude-plugin'));
    await writeFile(path.join(dir, '.claude-plugin', 'plugin.json'), JSON.stringify(claude));
  }
  if (codex !== undefined) {
    await mkdir(path.join(dir, '.codex-plugin'));
    await writeFile(path.join(dir, '.codex-plugin', 'plugin.json'), JSON.stringify(codex));
  }
  return dir;
}

describe('APE v2 plugin package validation', () => {
  it('pins the package smoke to the complete six-tool public MCP surface', () => {
    const smoke = readFileSync(path.join(root, 'scripts', 'smoke-plugin-mcp.mjs'), 'utf8');
    const declaration = smoke.match(/const EXPECTED_TOOLS = Object\.freeze\(\[([\s\S]*?)\]\);/u);
    expect(declaration).not.toBeNull();
    expect([...declaration[1].matchAll(/'([^']+)'/gu)].map((match) => match[1])).toEqual([
      'ape_run',
      'ape_bind',
      'ape_validate_receipt',
      'ape_status',
      'ape_history',
      'ape_config',
    ]);
  });

  it('validates the checked-in Codex package without user-specific paths', async () => {
    const result = await validateCodexPlugin(codexPackage);
    expect(result.errors).toEqual([]);
    expect(result.manifest).toMatchObject({
      name: 'ape',
      mcpServers: './.mcp.json',
    });
    expect(result.manifest.version).toMatch(codexVersionPattern);
  });

  it('treats the Codex skills declaration as optional per the official schema', async () => {
    const dir = await pluginDir({
      codex: { name: 'ape-test', version: '1.0.0', mcpServers: { ape: { command: 'node' } } },
    });
    const result = await validateCodexPlugin(dir);
    expect(result.errors).toEqual([]);
    expect(result.passed).toBe(true);
  });

  it('still rejects a declared Codex skills path that does not exist', async () => {
    const dir = await pluginDir({
      codex: {
        name: 'ape-test',
        version: '1.0.0',
        skills: './skills/',
        mcpServers: { ape: { command: 'node' } },
      },
    });
    const result = await validateCodexPlugin(dir);
    expect(result.errors).toContain('skills path does not exist');
    expect(result.passed).toBe(false);
  });

  it('validates the checked-in Claude package in-process without any vendor CLI', async () => {
    const result = await validateClaudePlugin(claudePackage);
    expect(result.errors).toEqual([]);
    expect(result.passed).toBe(true);
    expect(result.manifest).toMatchObject({ name: 'ape', hooks: './hooks/claude-hooks.json' });
    // The shipped package must also survive strict validation: no warnings.
    const strict = await validateClaudePlugin(claudePackage, { strict: true });
    expect(strict.warnings).toEqual([]);
    expect(strict.passed).toBe(true);
  });

  it('accepts a minimal Claude manifest with only a valid name', async () => {
    const dir = await pluginDir({ claude: { name: 'my-plugin' } });
    const result = await validateClaudePlugin(dir);
    expect(result.errors).toEqual([]);
    expect(result.passed).toBe(true);
    // Mirrors `claude plugin validate` warnings; --strict promotes them.
    expect(result.warnings).toEqual([
      'missing plugin version',
      'missing plugin description',
      'missing plugin author',
    ]);
    const strict = await validateClaudePlugin(dir, { strict: true });
    expect(strict.errors).toEqual([]);
    expect(strict.passed).toBe(false);
  });

  it('warns on unknown top-level manifest fields and rejects them only in strict mode', async () => {
    const dir = await pluginDir({
      claude: { name: 'my-plugin', version: '1.0.0', description: 'd', author: { name: 'a' }, bogusField: true },
    });
    const relaxed = await validateClaudePlugin(dir);
    expect(relaxed.errors).toEqual([]);
    expect(relaxed.warnings).toEqual(['unknown manifest field bogusField']);
    expect(relaxed.passed).toBe(true);
    const strict = await validateClaudePlugin(dir, { strict: true });
    expect(strict.passed).toBe(false);
  });

  it('validates hook manifest contents, not just the file path', async () => {
    const dir = await pluginDir({ claude: { name: 'my-plugin', hooks: './hooks/hooks.json' } });
    await mkdir(path.join(dir, 'hooks'));
    await writeFile(path.join(dir, 'hooks', 'hooks.json'), JSON.stringify({
      hooks: {
        NotAnEvent: [{ hooks: [{ type: 'command', command: 'node x.js' }] }],
        PreToolUse: [
          { matcher: 5, hooks: [{ type: 'command', command: 'node x.js' }] },
          { matcher: '*', hooks: [{ type: 'command' }] },
          { matcher: '*', hooks: [{ type: 'weird', command: 'node x.js' }] },
          { matcher: '*' },
        ],
      },
    }));
    const result = await validateClaudePlugin(dir);
    expect(result.passed).toBe(false);
    expect(result.errors).toContain('hooks manifest ./hooks/hooks.json: unknown hook event NotAnEvent');
    expect(result.errors).toContain('hooks manifest ./hooks/hooks.json: hook event PreToolUse matcher must be a string');
    expect(result.errors).toContain('hooks manifest ./hooks/hooks.json: hook event PreToolUse entry is missing its command');
    expect(result.errors).toContain('hooks manifest ./hooks/hooks.json: hook event PreToolUse entry has invalid type');
    expect(result.errors).toContain('hooks manifest ./hooks/hooks.json: hook event PreToolUse group is missing its hooks array');
  });

  it('requires a hooks FILE to wrap its event map while inline hooks are the bare event map', async () => {
    const events = { PreToolUse: [{ matcher: '*', hooks: [{ type: 'command', command: 'node x.js' }] }] };
    const unwrappedFile = await pluginDir({ claude: { name: 'my-plugin', hooks: './hooks/hooks.json' } });
    await mkdir(path.join(unwrappedFile, 'hooks'));
    await writeFile(path.join(unwrappedFile, 'hooks', 'hooks.json'), JSON.stringify(events));
    const fileResult = await validateClaudePlugin(unwrappedFile);
    expect(fileResult.errors).toContain('hooks manifest ./hooks/hooks.json must declare a top-level hooks object');
    expect(fileResult.passed).toBe(false);

    const inline = await pluginDir({ claude: { name: 'my-plugin', hooks: events } });
    const inlineResult = await validateClaudePlugin(inline);
    expect(inlineResult.errors).toEqual([]);
    expect(inlineResult.passed).toBe(true);
  });

  it('rejects structural Claude manifest defects', async () => {
    const dir = await pluginDir({
      claude: {
        name: 'Bad Name',
        version: '',
        author: {},
        hooks: './hooks/missing.json',
        skills: '../outside',
      },
    });
    const result = await validateClaudePlugin(dir);
    expect(result.passed).toBe(false);
    expect(result.errors).toContain('invalid plugin name');
    expect(result.errors).toContain('invalid plugin version');
    expect(result.errors).toContain('invalid plugin author');
    expect(result.errors).toContain('hooks path does not exist');
    expect(result.errors).toContain('skills path escapes the plugin root');
  });

  it('reports an unreadable Claude manifest instead of throwing', async () => {
    const dir = await pluginDir({});
    const result = await validateClaudePlugin(dir);
    expect(result.passed).toBe(false);
    expect(result.errors[0]).toMatch(/cannot read Claude manifest/);
  });

  it('resolves the runtime bundle from source and bundled module locations', () => {
    const source = runtimeBundleCandidates(
      new URL('file:///plugin/lib/runtime/doctor.js'),
    ).map((candidate) => candidate.pathname);
    expect(source).toContain('/plugin/dist/ape-mcp.bundle.mjs');

    const bundled = runtimeBundleCandidates(
      new URL('file:///plugin/dist/ape-mcp.bundle.mjs'),
    ).map((candidate) => candidate.pathname);
    expect(bundled).toContain('/plugin/dist/ape-mcp.bundle.mjs');
  });
});
