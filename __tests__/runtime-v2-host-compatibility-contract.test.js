import { execFile } from 'node:child_process';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';

const run = promisify(execFile);
const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const CHECKER = path.join(ROOT, 'scripts', 'check-host-compatibility.mjs');
const scratchRoots = [];
const CONTRACT_FILES = [
  'compatibility.json',
  'package.json',
  'package-lock.json',
  'README.md',
  'docs/compatibility.md',
  'docs/README.md',
  '.github/workflows/ci.yml',
  '.github/workflows/release.yml',
  '.github/workflows/host-edge.yml',
  'scripts/smoke-marketplace-install.mjs',
  'scripts/export-public-tree.mjs',
];

afterEach(async () => {
  await Promise.all(scratchRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function read(relative) {
  return readFile(path.join(ROOT, relative), 'utf8');
}

async function checker(root = ROOT) {
  try {
    const result = await run(process.execPath, [CHECKER, '--root', root], { cwd: ROOT });
    return { exitCode: 0, stdout: result.stdout, stderr: result.stderr };
  } catch (error) {
    return {
      exitCode: Number.isInteger(error.code) ? error.code : 1,
      stdout: error.stdout ?? '',
      stderr: error.stderr ?? error.message,
    };
  }
}

async function mutatedFixture(relative, mutate) {
  const fixture = await mkdtemp(path.join(tmpdir(), 'ape-host-compatibility-'));
  scratchRoots.push(fixture);
  for (const file of CONTRACT_FILES) {
    const destination = path.join(fixture, file);
    await mkdir(path.dirname(destination), { recursive: true });
    await cp(path.join(ROOT, file), destination, { recursive: true });
  }
  const target = path.join(fixture, relative);
  const original = await readFile(target, 'utf8');
  const changed = mutate(original);
  expect(changed, `mutation for ${relative} must alter its fixture`).not.toBe(original);
  await writeFile(target, changed);
  return fixture;
}

function jobBlock(yaml, jobName) {
  const lines = yaml.split(/\r?\n/u);
  const start = lines.findIndex((line) => new RegExp(`^ {2}${jobName}:[ \\t]*$`, 'u').test(line));
  if (start === -1) return '';
  let end = lines.length;
  for (let index = start + 1; index < lines.length; index += 1) {
    if (/^ {2}[A-Za-z][\w-]*:[ \t]*$/u.test(lines[index])) {
      end = index;
      break;
    }
  }
  return lines.slice(start, end).join('\n');
}

describe('host compatibility contract', () => {
  it('defines one versioned contract with the accepted floor, exact blocking pins, hosts, and platforms', async () => {
    const manifest = JSON.parse(await read('compatibility.json'));
    const serialized = JSON.stringify(manifest);

    expect(manifest.version).toBe(2);
    expect(manifest.hosts.codex.live_certification).toBe('required');
    expect(manifest.hosts.claude.live_certification).toBe('unverified');
    for (const value of ['22.12.0', '24.15.0', '0.147.0', '2.1.228']) {
      expect(serialized).toContain(value);
    }
    for (const identity of ['node', 'codex', 'claude', 'linux', 'macos', 'windows']) {
      expect(serialized.toLowerCase()).toContain(identity);
    }
    expect((serialized.match(/22\.12\.0/gu) ?? [])).toHaveLength(1);
    expect((serialized.match(/24\.15\.0/gu) ?? [])).toHaveLength(1);
    expect((serialized.match(/0\.147\.0/gu) ?? [])).toHaveLength(1);
    expect((serialized.match(/2\.1\.228/gu) ?? [])).toHaveLength(1);
  });

  it('accepts the unmodified repository contract', async () => {
    const result = await checker();
    expect(result.exitCode, result.stderr).toBe(0);
    expect(result.stdout).toMatch(/compatibility.{0,40}passed/iu);
  });

  const drifts = [
    ['manifest', 'compatibility.json', (text) => text.replace('22.12.0', '22.13.0')],
    ['live-certification policy', 'compatibility.json', (text) => text.replace('"required"', '"unverified"')],
    ['package metadata', 'package.json', (text) => text.replace('>=22.12.0', '>=22.13.0')],
    ['lock metadata', 'package-lock.json', (text) => text.replace('>=22.12.0', '>=22.13.0')],
    ['README', 'README.md', (text) => text.replace('22.12.0', '22.13.0')],
    ['compatibility documentation', 'docs/compatibility.md', (text) => text.replace('24.15.0', '24.16.0')],
    ['documentation index', 'docs/README.md', (text) => text.replace('compatibility.md', 'compatibility-broken.md')],
    ['pull-request CI', '.github/workflows/ci.yml', (text) => text.replace('0.147.0', '0.148.0')],
    ['tagged release', '.github/workflows/release.yml', (text) => text.replace('2.1.228', '2.1.229')],
    ['edge authority', '.github/workflows/host-edge.yml', (text) => text.replace('contents: read', 'contents: write')],
    ['marketplace smoke', 'scripts/smoke-marketplace-install.mjs', (text) => text.replace('compatibility.json', 'compatibility-broken.json')],
    ['public export', 'scripts/export-public-tree.mjs', (text) => text.replace("'compatibility.json'", "'compatibility-broken.json'")],
  ];

  it.each(drifts)('rejects independent %s drift in an isolated fixture', async (_name, relative, mutate) => {
    const fixture = await mutatedFixture(relative, mutate);
    const result = await checker(fixture);
    expect(result.exitCode, `${relative} drift was accepted\n${result.stdout}`).not.toBe(0);
    expect(result.stderr).toMatch(/compatib|drift|invalid|mismatch/iu);
  });

  it('keeps blocking CI and release pins exact and release publication privilege isolated', async () => {
    const ci = await read('.github/workflows/ci.yml');
    const release = await read('.github/workflows/release.yml');
    const validation = jobBlock(release, 'host-validation');
    const publish = jobBlock(release, 'publish');

    for (const value of ['22.12.0', '24.15.0', '0.147.0', '2.1.228']) expect(ci).toContain(value);
    for (const value of ['24.15.0', '0.147.0', '2.1.228']) expect(validation).toContain(value);
    for (const platform of ['ubuntu-latest', 'macos-latest', 'windows-latest']) expect(ci).toContain(platform);
    expect(ci).toContain('name: Package smoke (${{ matrix.os }}, Node ${{ matrix.node.major }})');
    expect(ci).toContain('node-version: ${{ matrix.node.version }}');
    expect(ci).toContain('npm run compatibility:check');
    expect(validation).toContain('npm run compatibility:check');
    expect(validation).toMatch(/permissions:\n      contents: read/u);
    expect(validation).not.toMatch(/contents: write|id-token: write|attestations: write|gh release|npm publish|secrets\./u);
    expect(publish).toContain('needs: host-validation');
    expect(publish).toContain('contents: write');
    expect(publish).toContain('id-token: write');
    expect(publish).toContain('attestations: write');
    expect(publish).not.toMatch(/@openai\/codex|@anthropic-ai\/claude-code/u);
  });

  it('keeps the current-version edge workflow informational and unable to reach release sinks', async () => {
    const edge = await read('.github/workflows/host-edge.yml');

    expect(edge).toMatch(/schedule:/u);
    expect(edge).toMatch(/workflow_dispatch:/u);
    expect(edge).toMatch(/^permissions:\n  contents: read$/mu);
    for (const platform of ['ubuntu-latest', 'macos-latest', 'windows-latest']) expect(edge).toContain(platform);
    expect(edge).toMatch(/node-version:\s*(?:node|latest|['"]?\*['"]?)/u);
    expect(edge).toContain('@openai/codex@latest');
    expect(edge).toContain('@anthropic-ai/claude-code@latest');
    expect(edge).toMatch(/smoke:marketplaces[^\n]*--[^\n]*edge/u);
    expect(edge).not.toMatch(/contents: write|id-token: write|attestations: write|secrets\.|GH_TOKEN|NPM_TOKEN/u);
    expect(edge).not.toMatch(/gh release|npm publish|release:artifacts|attest-build-provenance|workflow_call:/u);
    expect(edge).not.toMatch(/^\s*uses:\s*\.\//mu);
  });

  it('pins every third-party action in every compatibility workflow to a full SHA', async () => {
    for (const workflow of ['.github/workflows/ci.yml', '.github/workflows/release.yml', '.github/workflows/host-edge.yml']) {
      const yaml = await read(workflow);
      const uses = yaml.split(/\r?\n/u).filter((line) => /^\s*- uses:/u.test(line));
      expect(uses.length, workflow).toBeGreaterThan(0);
      for (const line of uses) expect(line, workflow).toMatch(/@[0-9a-f]{40}(?:\s+#.*)?$/u);
    }
  });
});
