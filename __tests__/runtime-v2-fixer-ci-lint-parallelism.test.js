import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

async function read(relative) {
  return readFile(new URL(`../${relative}`, import.meta.url), 'utf8');
}

function jobBlock(yaml, jobName) {
  const lines = yaml.split(/\r?\n/);
  const start = lines.findIndex((line) => new RegExp(`^ {2}${jobName}:[ \\t]*$`).test(line));
  if (start === -1) return null;
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i += 1) {
    if (/^ {2}[A-Za-z][\w-]*:[ \t]*$/.test(lines[i])) { end = i; break; }
  }
  return lines.slice(start, end).join('\n');
}

describe('public cross-platform CI and release contract', () => {
  it('cancels superseded PR runs and exercises the locked OS/Node package matrix', async () => {
    const yaml = await read('.github/workflows/ci.yml');
    expect(yaml).toMatch(/concurrency:[\s\S]*cancel-in-progress:\s*\$\{\{ github\.event_name == 'pull_request' \}\}/);
    const packageSmoke = jobBlock(yaml, 'package-smoke');
    expect(packageSmoke).toContain('fail-fast: false');
    expect(packageSmoke).toContain('os: [ubuntu-latest, macos-latest, windows-latest]');
    expect(packageSmoke).toContain('node: [22, 24]');
    expect(packageSmoke).toContain('node-version: ${{ matrix.node }}');
  });

  it('runs deterministic package, public-safety, and direct MCP gates in every matrix cell', async () => {
    const yaml = await read('.github/workflows/ci.yml');
    const packageSmoke = jobBlock(yaml, 'package-smoke');
    for (const command of [
      'npm run typecheck',
      'npm run bundle',
      'git diff --exit-code -- dist/',
      'npm run package:check',
      'npm run package:reproducible',
      'npm run public:check',
      'npm run smoke:plugins',
    ]) {
      expect(packageSmoke).toContain(command);
    }
    expect(packageSmoke).toContain("APE_PUBLIC_REQUIRE_FORBIDDEN_HASHES: '1'");
  });

  it('keeps the credential-free prompt gate and full suite behind package and install smoke', async () => {
    const yaml = await read('.github/workflows/ci.yml');
    const full = jobBlock(yaml, 'full-suite');
    expect(full).toContain('needs: [package-smoke, marketplace-install-smoke]');
    expect(full).toContain('npm audit --audit-level=high');
    expect(full).toContain('npm run eval:prompts:check');
    expect(full).toContain('npm test');
  });

  it('installs both pinned host CLIs in an isolated clean-marketplace smoke', async () => {
    const yaml = await read('.github/workflows/ci.yml');
    const marketplace = jobBlock(yaml, 'marketplace-install-smoke');
    expect(marketplace).toContain('node-version: 24.15.0');
    expect(marketplace).toContain('@openai/codex@0.147.0');
    expect(marketplace).toContain('@anthropic-ai/claude-code@2.1.228');
    expect(marketplace).toContain('npm run smoke:marketplaces');
  });

  it('pins every third-party action by a full commit SHA', async () => {
    for (const workflow of [
      '.github/workflows/ci.yml',
      '.github/workflows/codeql.yml',
      '.github/workflows/release.yml',
    ]) {
      const yaml = await read(workflow);
      const uses = yaml.split(/\r?\n/u).filter((line) => /^\s*- uses:/u.test(line));
      expect(uses.length, workflow).toBeGreaterThan(0);
      for (const line of uses) expect(line, workflow).toMatch(/@[0-9a-f]{40}(?:\s+#.*)?$/u);
    }
  });

  it('preconfigures least-privilege CodeQL without a build or secret dependency', async () => {
    const codeql = await read('.github/workflows/codeql.yml');
    expect(codeql).toMatch(/push:[\s\S]*pull_request:[\s\S]*schedule:/u);
    expect(codeql).toContain('languages: javascript-typescript');
    expect(codeql).toContain('build-mode: none');
    expect(codeql).toContain("if: ${{ github.event.repository.visibility == 'public' }}");
    expect(codeql).toContain('actions: read');
    expect(codeql).toContain('security-events: write');
    expect(codeql.match(/github\/codeql-action\/(?:init|analyze)@[0-9a-f]{40}/gu)).toHaveLength(2);
    expect(codeql).not.toMatch(/secrets\./u);
    expect(codeql).not.toMatch(/npm (?:ci|run)|build-command|autobuild/u);
  });

  it('enables bounded weekly npm and GitHub Actions dependency updates', async () => {
    const dependabot = await read('.github/dependabot.yml');
    expect(dependabot).toMatch(/^version: 2$/mu);
    expect(dependabot.match(/package-ecosystem: (?:npm|github-actions)/gu)).toEqual([
      'package-ecosystem: npm',
      'package-ecosystem: github-actions',
    ]);
    expect(dependabot.match(/interval: weekly/gu)).toHaveLength(2);
    expect(dependabot.match(/open-pull-requests-limit: 0/gu)).toHaveLength(2);
  });

  it('pins the complete publication toolchain before release gates run', async () => {
    const release = await read('.github/workflows/release.yml');
    for (const marker of [
      'node-version: 24.15.0',
      'test "$(npm --version)" = "11.12.1"',
      '@openai/codex@0.147.0',
      '@anthropic-ai/claude-code@2.1.228',
      'GH_CLI_VERSION: 2.76.2',
      'sha256sum --check --strict',
      'SOURCE_DATE_EPOCH=',
    ]) {
      expect(release).toContain(marker);
    }
    expect(release.indexOf('SOURCE_DATE_EPOCH=')).toBeLessThan(release.indexOf('npm run package:check'));
    expect(release.indexOf('npm run eval:prompts:check')).toBeLessThan(release.indexOf('gh release create'));
  });

  it('isolates registry-fetched host CLIs from the privileged publication job', async () => {
    const release = await read('.github/workflows/release.yml');
    const hostValidation = jobBlock(release, 'host-validation');
    const publish = jobBlock(release, 'publish');

    expect(release).toMatch(/^permissions:\n  contents: read$/mu);
    expect(release).not.toContain('APE_PUBLIC_FORBIDDEN_HASHES:');
    expect(hostValidation).toMatch(/permissions:\n      contents: read/u);
    expect(hostValidation).toContain('npm install --global @openai/codex@0.147.0 @anthropic-ai/claude-code@2.1.228');
    expect(hostValidation).toContain('npm run smoke:marketplaces');
    expect(hostValidation).toContain('npm run validate');
    expect(hostValidation).not.toContain('contents: write');
    expect(hostValidation).not.toContain('attest-build-provenance');
    expect(hostValidation).not.toContain('gh release create');

    expect(publish).toContain('needs: host-validation');
    expect(publish).toContain('contents: write');
    expect(publish).toContain('id-token: write');
    expect(publish).toContain('attestations: write');
    expect(publish).toContain('npm ci');
    expect(publish).toContain('npm run release:artifacts');
    expect(publish).toContain('actions/attest-build-provenance@4d101475d8b20a2381f78447822ac1eab6504dd8');
    expect(publish).toContain('gh release create');
    expect(publish).not.toMatch(/@openai\/codex|@anthropic-ai\/claude-code/u);
    expect(publish).not.toMatch(/npm install(?:\s|$)/u);
    expect(publish).not.toContain('npm run smoke:marketplaces');
    expect(publish).not.toContain('npm run validate');
  });

  it('gives standalone runs six workers and exposes a three-worker agent-safe profile', async () => {
    const config = await read('vitest.config.js');
    const pkg = JSON.parse(await read('package.json'));
    expect(config).toMatch(/maxWorkers:\s*6/);
    expect(pkg.scripts['test:agent']).toMatch(/vitest run --maxWorkers=3/);
    expect(pkg.scripts['test:timings']).toBe('node scripts/update-test-durations.mjs');
    expect(await read('scripts/update-test-durations.mjs')).toContain("'--no-file-parallelism'");
  });
});
