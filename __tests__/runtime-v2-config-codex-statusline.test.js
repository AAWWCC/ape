import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { configAction } from '../lib/runtime/service.js';
import { parse as parseToml } from 'smol-toml';

describe('ape v2 Codex-native statusline wiring', () => {
  let codexHome;
  let project;
  let previousCodexHome;
  const configFile = () => join(codexHome, 'config.toml');
  const stateFile = () => join(codexHome, 'ape-statusline-wire.json');

  beforeEach(() => {
    codexHome = mkdtempSync(join(tmpdir(), 'ape-codex-home-'));
    project = mkdtempSync(join(tmpdir(), 'ape-codex-project-'));
    previousCodexHome = process.env.CODEX_HOME;
    process.env.CODEX_HOME = codexHome;
  });

  afterEach(() => {
    if (previousCodexHome === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = previousCodexHome;
    rmSync(codexHome, { recursive: true, force: true });
    rmSync(project, { recursive: true, force: true });
  });

  it('wires the closest native Codex footer and reports the renderer limitation', async () => {
    writeFileSync(configFile(), 'model = "gpt-5.5"\n');

    const result = await configAction(project, 'wire', { host: 'codex' });

    expect(result.statusline).toMatchObject({
      wired: true,
      mode: 'native',
      renderer: 'codex-native',
      custom_renderer: false,
    });
    expect(result.statusline.limitation).toMatch(/built-in status-line items only/i);
    expect(result.statusline.items).toEqual([
      'model-with-reasoning',
      'current-dir',
      'git-branch',
      'task-progress',
      'context-used',
    ]);

    const config = readFileSync(configFile(), 'utf8');
    expect(config).toContain('model = "gpt-5.5"');
    expect(config).toContain('[tui]');
    expect(config).toContain('# APE managed Codex-native status line');
    expect(config).toContain('status_line = ["model-with-reasoning","current-dir","git-branch","task-progress","context-used"]');
    expect(config).toContain('status_line_use_colors = true');
    expect(readFileSync(`${configFile()}.bak`, 'utf8')).toBe('model = "gpt-5.5"\n');
    expect(existsSync(stateFile())).toBe(true);
  });

  it('unwire restores prior multiline values while preserving later unrelated edits', async () => {
    const original = [
      'model = "gpt-5.5"',
      '',
      '[tui]',
      '# user preference',
      'status_line = [',
      '  "current-dir",',
      '  "weekly-limit",',
      ']',
      'status_line_use_colors = false',
      'theme = "tokyo-night"',
      '',
      '[features]',
      'multi_agent = true',
      '',
    ].join('\n');
    writeFileSync(configFile(), original);
    await configAction(project, 'wire', { host: 'codex' });

    const withLaterEdit = readFileSync(configFile(), 'utf8').replace(
      'theme = "tokyo-night"',
      'theme = "tokyo-night"\nnotifications = true',
    );
    writeFileSync(configFile(), withLaterEdit);
    const result = await configAction(project, 'unwire', { host: 'codex' });

    expect(result.statusline).toMatchObject({ wired: false, removed: true, modified: false });
    const restored = readFileSync(configFile(), 'utf8');
    expect(restored).toContain('status_line = [\n  "current-dir",\n  "weekly-limit",\n]');
    expect(restored).toContain('status_line_use_colors = false');
    expect(restored).toContain('notifications = true');
    expect(restored).not.toContain('APE managed');
    expect(existsSync(stateFile())).toBe(false);
  });

  it('removes a [tui] table that APE created when no user keys were added', async () => {
    const original = 'model = "gpt-5.5"\n';
    writeFileSync(configFile(), original);
    await configAction(project, 'wire', { host: 'codex' });

    await configAction(project, 'unwire', { host: 'codex' });

    expect(readFileSync(configFile(), 'utf8')).toBe(original);
  });

  it.each([
    ['"status_line"', '"status_line_use_colors"'],
    ["'status_line'", "'status_line_use_colors'"],
    ['"status\\u005fline"', '"status_line_use\\u005fcolors"'],
  ])('rewrites and restores equivalent quoted TOML keys %s', async (lineKey, colorsKey) => {
    const original = `[tui]\n${lineKey} = [\n  "weekly-limit",\n]\n${colorsKey} = false\ntheme = "dark"\n`;
    writeFileSync(configFile(), original);
    expect(parseToml(original).tui.status_line).toEqual(['weekly-limit']);

    await configAction(project, 'wire', { host: 'codex' });
    const installed = readFileSync(configFile(), 'utf8');
    expect(parseToml(installed).tui).toMatchObject({
      status_line_use_colors: true,
      theme: 'dark',
    });
    expect(parseToml(installed).tui.status_line).toContain('task-progress');
    expect((await configAction(project, 'wire', { host: 'codex' })).statusline.unchanged).toBe(true);

    await configAction(project, 'unwire', { host: 'codex' });
    expect(readFileSync(configFile(), 'utf8')).toBe(original);
    expect(parseToml(readFileSync(configFile(), 'utf8')).tui.status_line).toEqual(['weekly-limit']);
  });

  it('keeps a user key added to an APE-created [tui] table during unwire', async () => {
    writeFileSync(configFile(), 'model = "gpt-5.5"\n');
    await configAction(project, 'wire', { host: 'codex' });
    writeFileSync(
      configFile(),
      readFileSync(configFile(), 'utf8').replace(
        'status_line_use_colors = true',
        'status_line_use_colors = true\ntheme = "dark"',
      ),
    );

    await configAction(project, 'unwire', { host: 'codex' });

    const restored = readFileSync(configFile(), 'utf8');
    expect(restored).toContain('[tui]');
    expect(restored).toContain('theme = "dark"');
    expect(restored).not.toContain('status_line =');
  });

  it.each([
    '[tui]\nnotes = """\n"status_line" = ["fake"]\n"""\n',
    'notes = """\n[tui]\n"""\n',
    '[tui]\nnotes = """\n# APE managed Codex-native status line\n"""\n',
  ])('refuses edits that would change unrelated multiline string data', async (original) => {
    writeFileSync(configFile(), original);
    expect(() => parseToml(original)).not.toThrow();

    await expect(configAction(project, 'wire', { host: 'codex' })).rejects.toThrow(/unrelated configuration would change/);

    expect(readFileSync(configFile(), 'utf8')).toBe(original);
    expect(existsSync(`${configFile()}.bak`)).toBe(false);
    expect(existsSync(stateFile())).toBe(false);
  });

  it('refuses unwire when text removal would change an unrelated value added later', async () => {
    writeFileSync(configFile(), '[tui]\n');
    await configAction(project, 'wire', { host: 'codex' });
    const backup = readFileSync(`${configFile()}.bak`, 'utf8');
    const changed = `${readFileSync(configFile(), 'utf8')}notes = """\n# APE managed Codex-native status line\n"""\n`;
    writeFileSync(configFile(), changed);

    await expect(configAction(project, 'unwire', { host: 'codex' })).rejects.toThrow(/unrelated configuration would change/);

    expect(readFileSync(configFile(), 'utf8')).toBe(changed);
    expect(readFileSync(`${configFile()}.bak`, 'utf8')).toBe(backup);
    expect(existsSync(stateFile())).toBe(true);
  });

  it('rewire is idempotent and does not destroy the original ownership record', async () => {
    const original = '[tui]\nstatus_line = ["weekly-limit"]\n';
    writeFileSync(configFile(), original);
    await configAction(project, 'wire', { host: 'codex' });
    const firstState = readFileSync(stateFile(), 'utf8');
    const firstConfig = readFileSync(configFile(), 'utf8');

    const rewired = await configAction(project, 'wire', { host: 'codex' });

    expect(rewired.statusline.unchanged).toBe(true);
    expect(readFileSync(stateFile(), 'utf8')).toBe(firstState);
    expect(readFileSync(configFile(), 'utf8')).toBe(firstConfig);
    await configAction(project, 'unwire', { host: 'codex' });
    expect(readFileSync(configFile(), 'utf8')).toContain('status_line = ["weekly-limit"]');
  });

  it('refuses to remove a managed value the user changed', async () => {
    writeFileSync(configFile(), '[tui]\ntheme = "dark"\n');
    await configAction(project, 'wire', { host: 'codex' });
    const changed = readFileSync(configFile(), 'utf8').replace('context-used', 'weekly-limit');
    writeFileSync(configFile(), changed);

    const result = await configAction(project, 'unwire', { host: 'codex' });

    expect(result.statusline).toMatchObject({ wired: false, removed: false, modified: true });
    expect(readFileSync(configFile(), 'utf8')).toBe(changed);
    expect(existsSync(stateFile())).toBe(true);
  });

  it('doctor reports the Codex-native wiring state', async () => {
    await configAction(project, 'wire', { host: 'codex' });

    const result = await configAction(project, 'doctor', { host: 'codex' });

    expect(result.statusline).toMatchObject({ wired: true, renderer: 'codex-native' });
  });

  it.each([
    'tui = { status_line = ["current-dir"] }\n',
    'tui.status_line = ["current-dir"]\n',
    '["tui"]\nstatus_line = ["current-dir"]\n',
    '["t\\u0075i"]\nstatus_line = ["current-dir"]\n',
    '"tui"."status_line" = ["current-dir"]\n',
  ])('fails safely for unsupported TOML shape: %s', async (config) => {
    writeFileSync(configFile(), config);

    await expect(configAction(project, 'wire', { host: 'codex' })).rejects.toThrow(/standard \[tui\]/);

    expect(readFileSync(configFile(), 'utf8')).toBe(config);
    expect(existsSync(`${configFile()}.bak`)).toBe(false);
    expect(existsSync(stateFile())).toBe(false);
  });
});
