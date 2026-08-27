#!/usr/bin/env node

import { readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

function parseArgs(argv) {
  if (argv.length === 0) return REPO_ROOT;
  if (argv.length === 2 && argv[0] === '--root' && argv[1]) return resolve(argv[1]);
  throw new Error('usage: node scripts/check-host-compatibility.mjs [--root <directory>]');
}

async function text(root, relative) {
  return readFile(join(root, relative), 'utf8');
}

function requireCondition(condition, message) {
  if (!condition) throw new Error(`compatibility drift: ${message}`);
}

function requireContains(value, expected, consumer) {
  requireCondition(value.includes(expected), `${consumer} must contain ${JSON.stringify(expected)}`);
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

function requireFullActionPins(yaml, consumer) {
  const uses = yaml.split(/\r?\n/u).filter((line) => /^\s*- uses:/u.test(line));
  requireCondition(uses.length > 0, `${consumer} must use at least one pinned action`);
  for (const line of uses) {
    requireCondition(/@[0-9a-f]{40}(?:\s+#.*)?$/u.test(line), `${consumer} action is not pinned to a full SHA: ${line.trim()}`);
  }
}

async function check(root) {
  const manifestText = await text(root, 'compatibility.json');
  const manifest = JSON.parse(manifestText);
  requireCondition(manifest.version === 2, 'compatibility.json version must be 2');
  requireCondition(manifest.node?.minimum === '22.12.0', 'Node.js minimum must be 22.12.0');
  requireCondition(manifest.node?.blocking === '24.15.0', 'blocking Node.js must be 24.15.0');
  requireCondition(manifest.hosts?.codex?.package === '@openai/codex', 'Codex package identity mismatch');
  requireCondition(manifest.hosts?.codex?.version === '0.147.0', 'Codex CLI pin mismatch');
  requireCondition(
    manifest.hosts?.codex?.live_certification === 'required',
    'Codex must be the required live-certification host',
  );
  requireCondition(manifest.hosts?.claude?.package === '@anthropic-ai/claude-code', 'Claude Code package identity mismatch');
  requireCondition(manifest.hosts?.claude?.version === '2.1.228', 'Claude Code pin mismatch');
  requireCondition(
    manifest.hosts?.claude?.live_certification === 'unverified',
    'Claude live certification must be marked unverified',
  );
  requireCondition(
    JSON.stringify(Object.keys(manifest.hosts ?? {}).sort()) === JSON.stringify(['claude', 'codex']),
    'host policy partition must contain exactly Codex and Claude',
  );
  requireCondition(
    JSON.stringify(manifest.platforms) === JSON.stringify(['linux', 'macos', 'windows']),
    'supported platforms must be linux, macos, and windows',
  );

  const pkg = JSON.parse(await text(root, 'package.json'));
  const lock = JSON.parse(await text(root, 'package-lock.json'));
  const engine = `>=${manifest.node.minimum}`;
  requireCondition(pkg.engines?.node === engine, `package.json engines.node must be ${engine}`);
  requireCondition(lock.packages?.['']?.engines?.node === engine, `package-lock.json root engines.node must be ${engine}`);
  requireCondition(pkg.scripts?.['compatibility:check'] === 'node scripts/check-host-compatibility.mjs', 'package.json must expose compatibility:check');

  const readme = await text(root, 'README.md');
  requireContains(readme, `Node.js ${manifest.node.minimum} or newer is required.`, 'README.md');
  requireContains(readme, '[`compatibility.json`](compatibility.json)', 'README.md');
  requireContains(readme, '(docs/compatibility.md)', 'README.md');
  requireContains(readme, 'Claude live operation is unverified', 'README.md');

  const compatibilityDocs = await text(root, 'docs/compatibility.md');
  for (const value of [manifest.node.minimum, manifest.node.blocking, manifest.hosts.codex.version, manifest.hosts.claude.version]) {
    requireContains(compatibilityDocs, value, 'docs/compatibility.md');
  }
  for (const platform of ['Linux', 'macOS', 'Windows']) requireContains(compatibilityDocs, platform, 'docs/compatibility.md');
  requireContains(compatibilityDocs, 'Codex is the sole required live release-certification host', 'docs/compatibility.md');
  requireContains(compatibilityDocs, 'Claude live operation is unverified', 'docs/compatibility.md');
  requireContains(await text(root, 'docs/README.md'), 'compatibility.md', 'docs/README.md');

  const ci = await text(root, '.github/workflows/ci.yml');
  for (const value of [manifest.node.minimum, manifest.node.blocking, manifest.hosts.codex.version, manifest.hosts.claude.version]) {
    requireContains(ci, value, '.github/workflows/ci.yml');
  }
  for (const platform of ['ubuntu-latest', 'macos-latest', 'windows-latest']) requireContains(ci, platform, '.github/workflows/ci.yml');
  requireContains(ci, 'name: Package smoke (${{ matrix.os }}, Node ${{ matrix.node.major }})', '.github/workflows/ci.yml');
  requireContains(ci, 'node-version: ${{ matrix.node.version }}', '.github/workflows/ci.yml');
  requireContains(ci, 'npm run compatibility:check', '.github/workflows/ci.yml');
  requireContains(ci, `@openai/codex@${manifest.hosts.codex.version}`, '.github/workflows/ci.yml');
  requireContains(ci, `@anthropic-ai/claude-code@${manifest.hosts.claude.version}`, '.github/workflows/ci.yml');
  requireFullActionPins(ci, '.github/workflows/ci.yml');

  const release = await text(root, '.github/workflows/release.yml');
  const validation = jobBlock(release, 'host-validation');
  const publish = jobBlock(release, 'publish');
  for (const value of [manifest.node.blocking, manifest.hosts.codex.version, manifest.hosts.claude.version]) {
    requireContains(validation, value, '.github/workflows/release.yml host-validation');
  }
  requireContains(validation, 'npm run compatibility:check', '.github/workflows/release.yml host-validation');
  requireCondition(/permissions:\n      contents: read/u.test(validation), 'host-validation must be contents-read-only');
  requireCondition(!/contents: write|id-token: write|attestations: write|gh release|npm publish|secrets\./u.test(validation), 'host-validation reaches a privileged release sink');
  requireContains(publish, 'needs: host-validation', '.github/workflows/release.yml publish');
  for (const permission of ['contents: write', 'id-token: write', 'attestations: write']) requireContains(publish, permission, '.github/workflows/release.yml publish');
  requireCondition(!/@openai\/codex|@anthropic-ai\/claude-code/u.test(publish), 'publish must not execute registry-fetched host CLIs');
  requireFullActionPins(release, '.github/workflows/release.yml');

  const edge = await text(root, '.github/workflows/host-edge.yml');
  requireCondition(/schedule:/u.test(edge) && /workflow_dispatch:/u.test(edge), 'edge workflow must support schedule and workflow_dispatch');
  requireCondition(/^permissions:\n  contents: read$/mu.test(edge), 'edge workflow must grant only contents: read');
  for (const platform of ['ubuntu-latest', 'macos-latest', 'windows-latest']) requireContains(edge, platform, '.github/workflows/host-edge.yml');
  requireContains(edge, '@openai/codex@latest', '.github/workflows/host-edge.yml');
  requireContains(edge, '@anthropic-ai/claude-code@latest', '.github/workflows/host-edge.yml');
  requireCondition(/smoke:marketplaces[^\n]*--[^\n]*edge/u.test(edge), 'edge workflow must use marketplace edge mode');
  requireCondition(!/contents: write|id-token: write|attestations: write|secrets\.|GH_TOKEN|NPM_TOKEN|gh release|npm publish|release:artifacts|attest-build-provenance|workflow_call:/u.test(edge), 'edge workflow reaches a release sink');
  requireCondition(!/^\s*uses:\s*\.\//mu.test(edge), 'edge workflow must not invoke a reusable local workflow');
  requireFullActionPins(edge, '.github/workflows/host-edge.yml');

  const smoke = await text(root, 'scripts/smoke-marketplace-install.mjs');
  requireContains(smoke, 'compatibility.json', 'scripts/smoke-marketplace-install.mjs');
  requireContains(smoke, 'host.version', 'scripts/smoke-marketplace-install.mjs');
  requireContains(smoke, "mode === 'edge'", 'scripts/smoke-marketplace-install.mjs');

  const exporter = await text(root, 'scripts/export-public-tree.mjs');
  requireContains(exporter, "'compatibility.json'", 'scripts/export-public-tree.mjs');
}

const root = parseArgs(process.argv.slice(2));
check(root).then(() => {
  process.stdout.write('host compatibility contract passed\n');
}).catch((error) => {
  process.stderr.write(`host compatibility check failed: ${error?.message ?? String(error)}\n`);
  process.exitCode = 1;
});
