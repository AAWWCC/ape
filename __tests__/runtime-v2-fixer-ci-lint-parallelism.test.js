import { readFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
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
  it('documents qualified reproducible wall-clock and adjusted-p90 methods without claiming empty data certifies', async () => {
    const readme = await read('README.md');
    const guide = await read('docs/performance-baselines.md');
    expect(readme).toMatch(/performance-baselines\.md/u);
    for (const marker of [
      /commit/iu,
      /operating system|\bOS\b/iu,
      /Node(?:\.js)? version/iu,
      /lockfile/iu,
      /worker/iu,
      /monotonic/iu,
      /repeat/iu,
      /nearest.rank p90/iu,
      /raw_ms/iu,
      /test_ms/iu,
      /remote_ci_ms/iu,
      /adjusted/iu,
      /20 records/iu,
      /90% passing/iu,
      /18 of 20/iu,
      /36 of 40/iu,
    ]) expect(guide).toMatch(marker);
    expect(guide).toMatch(/empty|insufficient/iu);
    expect(guide).toMatch(/not (?:a )?certification|does not certify/iu);
  });

  it('documents the qualified cooperative writer and hybrid crash-recovery boundary', async () => {
    const guide = await read('docs/performance-baselines.md');
    for (const marker of [
      /cooperative.{0,80}(?:writer|lock)|(?:writer|lock).{0,80}cooperative/isu,
      /observable.{0,80}(?:validation|boundary)|(?:validation|boundary).{0,80}observable/isu,
      /confirmed.dead.{0,80}(?:PID|owner)|(?:PID|owner).{0,80}confirmed.dead/isu,
      /(?:live|EPERM|permission.ambiguous).{0,100}(?:retain|not.{0,20}(?:evict|reclaim|steal))/isu,
      /60.second.{0,100}(?:empty|malformed|pre.metadata|unidentifiable)/isu,
      /(?:empty|malformed|pre.metadata|unidentifiable).{0,100}60.second/isu,
      /live.{0,100}pre.metadata.{0,100}(?:lease|not.{0,30}indefinite)/isu,
      /final.{0,80}(?:validation.to.rename|syscall).{0,100}(?:gap|not protected|outside)/isu,
      /same.UID.{0,100}(?:gap|not protected|outside)|(?:gap|not protected|outside).{0,100}same.UID/isu,
    ]) expect(guide).toMatch(marker);
  });

  it('cancels superseded PR runs and exercises the locked OS/Node package matrix', async () => {
    const yaml = await read('.github/workflows/ci.yml');
    expect(yaml).toMatch(/concurrency:[\s\S]*cancel-in-progress:\s*\$\{\{ github\.event_name == 'pull_request' \}\}/);
    const packageSmoke = jobBlock(yaml, 'package-smoke');
    expect(packageSmoke).toContain('fail-fast: false');
    expect(packageSmoke).toContain('os: [ubuntu-latest, macos-latest, windows-latest]');
    expect(packageSmoke).toContain('version: 22.12.0');
    expect(packageSmoke).toContain('major: 22');
    expect(packageSmoke).toContain('version: 24.15.0');
    expect(packageSmoke).toContain('major: 24');
    expect(packageSmoke).toContain('name: Package smoke (${{ matrix.os }}, Node ${{ matrix.node.major }})');
    expect(packageSmoke).toContain('node-version: ${{ matrix.node.version }}');
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

  it('runs bounded native runtime coverage on all six supported OS/Node combinations using freshly checked packages', async () => {
    const native = jobBlock(await read('.github/workflows/ci.yml'), 'native-runtime');
    expect(native).toContain('os: [ubuntu-latest, macos-latest, windows-latest]');
    expect([...native.matchAll(/version: (\d+\.\d+\.\d+)/gu)].map((entry) => entry[1])).toEqual(['22.12.0', '24.15.0']);
    expect(native).toContain('runs-on: ${{ matrix.os }}');
    expect(native).toContain('node-version: ${{ matrix.node.version }}');
    expect(native).toContain('fail-fast: false');
    expect(native).not.toMatch(/exclude:|continue-on-error:/u);
    expect(native).toContain('node scripts/run-ci-tests.mjs native -- --maxWorkers=1');
    expect(native.indexOf('npm run bundle')).toBeLessThan(native.indexOf('npm run package:plugins'));
    expect(native.indexOf('npm run package:plugins')).toBeLessThan(native.indexOf('git diff --exit-code -- dist/ plugins/'));
    expect(native.indexOf('git diff --exit-code -- dist/ plugins/')).toBeLessThan(native.indexOf('run-ci-tests.mjs native'));
  });

  it('keeps the required aggregate name and fails it for failed, cancelled or skipped native checks', async () => {
    const full = jobBlock(await read('.github/workflows/ci.yml'), 'full-suite');
    expect(full).toContain('name: Full suite aggregate');
    expect(full).toContain('if: ${{ always() }}');
    expect(full).toContain('CI_NEEDS: ${{ toJSON(needs) }}');
    const dependencies = full.match(/needs: \[([^\]]+)\]/u)[1].split(',').map((entry) => entry.trim());
    expect(dependencies).toEqual(['package-smoke', 'marketplace-install-smoke', 'smoke', 'shard-1', 'shard-2', 'shard-3', 'native-runtime']);
    const command = full.match(/run: node -e "([^"\r\n]+)"/u)[1];
    expect(full.indexOf(command)).toBeLessThan(full.indexOf('actions/checkout@'));
    for (const status of ['success', 'failure', 'cancelled', 'skipped']) {
      const needs = Object.fromEntries(dependencies.map((name) => [name, { result: name === 'native-runtime' ? status : 'success' }]));
      const result = spawnSync(process.execPath, ['-e', command], { env: { ...process.env, CI_NEEDS: JSON.stringify(needs) }, encoding: 'utf8' });
      expect(result.status, `native result ${status}: ${result.stderr}`).toBe(status === 'success' ? 0 : 1);
    }
  });

  it('keeps automated lockfile installs free of lifecycle and incidental network side effects', async () => {
    for (const workflow of [
      '.github/workflows/ci.yml',
      '.github/workflows/host-edge.yml',
      '.github/workflows/release.yml',
    ]) {
      const yaml = await read(workflow);
      const installs = yaml.split(/\r?\n/u).filter((line) => /- run: npm ci(?:\s|$)/u.test(line));
      expect(installs.length, workflow).toBeGreaterThan(0);
      for (const line of installs) {
        expect(line, workflow).toContain('npm ci --ignore-scripts --no-audit --no-fund');
      }
    }
  });

  it('gates tagged publication on the complete source suite and every native platform cell', async () => {
    const release = await read('.github/workflows/release.yml');
    const full = jobBlock(release, 'source-tests');
    const native = jobBlock(release, 'native-runtime');
    const validation = jobBlock(release, 'host-validation');
    expect(full).toContain('npm run test:agent');
    expect(full).toContain('node-version: 22.12.0');
    expect(JSON.parse(await read('package.json')).scripts['test:agent'])
      .toBe('vitest run --maxWorkers=3');
    expect(native).toContain('os: [ubuntu-latest, macos-latest, windows-latest]');
    expect([...native.matchAll(/version: (\d+\.\d+\.\d+)/gu)].map((match) => match[1]))
      .toEqual(['22.12.0', '24.15.0']);
    expect(native).toContain('node scripts/run-ci-tests.mjs native -- --maxWorkers=1');
    expect(native).toContain('git diff --exit-code -- dist/ plugins/');
    expect(validation).toContain('needs: [source-tests, native-runtime]');
    expect(jobBlock(release, 'publish')).toContain('needs: host-validation');
    for (const block of [full, native, validation, jobBlock(release, 'publish')]) {
      expect(block).not.toMatch(/continue-on-error:|if:.*always\(\)|exclude:/u);
    }
  });

  it('keeps audit and both credential-free release gates while the full-suite aggregate depends on every partition', async () => {
    const yaml = await read('.github/workflows/ci.yml');
    const full = jobBlock(yaml, 'full-suite');
    expect(yaml.match(/npm audit --audit-level=high/gu)).toHaveLength(1);
    expect(yaml.match(/npm run eval:prompts:check/gu)).toHaveLength(1);
    expect(yaml.match(/npm run operational:canary/gu)).toHaveLength(1);
    for (const dependency of ['package-smoke', 'marketplace-install-smoke', 'smoke', 'shard']) {
      expect(full).toContain(dependency);
    }
    expect(full).not.toMatch(/npm test|vitest run/u);
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
    expect(release.match(/npm run operational:canary/gu)).toHaveLength(2);
    expect(release.match(/npm run release:live-certification/gu)).toHaveLength(2);
    expect(release).toContain('--head "${GITHUB_SHA}" --tag "${GITHUB_REF_NAME}"');
    expect(release.indexOf('npm run operational:canary')).toBeLessThan(release.indexOf('gh release create'));
    expect(release.indexOf('npm run release:live-certification')).toBeLessThan(release.indexOf('gh release create'));
  });

  it('isolates registry-fetched host CLIs from the privileged publication job', async () => {
    const release = await read('.github/workflows/release.yml');
    const hostValidation = jobBlock(release, 'host-validation');
    const publish = jobBlock(release, 'publish');

    expect(release).toMatch(/^permissions:\n  contents: read$/mu);
    expect(release).not.toContain('APE_PUBLIC_FORBIDDEN_HASHES:');
    expect(hostValidation).toMatch(/permissions:\n      contents: read/u);
    expect(hostValidation).toContain('npm audit --audit-level=high');
    expect(hostValidation).toContain('npm install --global @openai/codex@0.147.0 @anthropic-ai/claude-code@2.1.228');
    expect(hostValidation).toContain('npm run smoke:marketplaces -- --installed-hosts');
    expect(hostValidation).toContain('npm run validate:claude');
    expect(hostValidation).not.toMatch(/npm run validate\s*$/mu);
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
