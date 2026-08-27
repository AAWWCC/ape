import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// Keep the original tracked filename so unstaged release work remains readable
// to index-based source-integrity guards; assertions pin the current release.

const read = (relative) => readFileSync(new URL(`../${relative}`, import.meta.url), 'utf8');
const readJson = (relative) => JSON.parse(read(relative));

describe('release 2.23.1 public packaging', () => {
  it('pins source and generated package surfaces to 2.23.1', () => {
    for (const relative of [
      'package.json',
      'plugins/ape/package.json',
      'plugins/ape/.codex-plugin/plugin.json',
      'plugins/ape-claude/package.json',
      'plugins/ape-claude/.claude-plugin/plugin.json',
    ]) {
      expect(readJson(relative).version, relative).toBe('2.23.1');
    }
    expect(read('bin/ape-mcp.mjs')).toContain("version: '2.23.1'");
  });

  it('pins every executable that controls the public release', () => {
    const workflow = read('.github/workflows/release.yml');
    const packageJson = readJson('package.json');
    expect(workflow).toContain('GH_CLI_VERSION: 2.76.2');
    expect(workflow).toMatch(/GH_CLI_SHA256: [0-9a-f]{64}/u);
    expect(workflow).toContain('sha256sum --check --strict');
    expect(workflow).toContain('test "$(gh --version | head -n 1)"');
    expect(workflow).toContain('npm run eval:prompts:check');
    expect(workflow).toContain('npm run operational:canary');
    expect(workflow).toContain('npm run release:live-certification');
    expect(packageJson.scripts['release:live-certification'])
      .toBe('node scripts/verify-live-certification.mjs');
    expect(read('scripts/verify-live-certification.mjs'))
      .toContain("export const LIVE_CERTIFICATION_PATH = 'evals/live-certification.json'");
    expect(readJson('evals/live-certification.schema.json').additionalProperties).toBe(false);
  });

  it('documents deterministic packages, local stdio, audio omission, and explicit invocation', () => {
    const changelog = read('CHANGELOG.md');
    const section = changelog.slice(
      changelog.indexOf('## 2.17.0'),
      changelog.indexOf('## 2.16.0'),
    );
    for (const expected of [
      'deterministic',
      'plugins/ape',
      'plugins/ape-claude',
      'locally over stdio',
      'neither package contains',
      'explicit-only',
      'assets/sounds/manifest.json',
      'omit the entire `assets` directory',
      'source manifest remains at `2.17.0`',
    ]) {
      expect(section).toContain(expected);
    }
  });
});
