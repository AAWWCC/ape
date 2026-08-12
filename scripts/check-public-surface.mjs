#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { readFile, readdir, stat } from 'node:fs/promises';
import { basename, dirname, extname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = dirname(SCRIPT_DIR);
const DEFAULT_ROOT = join(REPO_ROOT, 'plugins');
const DEFAULT_PRIVATE_HASH_FILE = join(REPO_ROOT, '.public-forbidden-hashes');
const DEFAULT_FINGERPRINT_FILE = join(REPO_ROOT, 'public-asset-fingerprints.json');
const FINGERPRINT_DOMAIN = 'APE-public-forbidden-v1';
const MAX_PUBLIC_FILE_BYTES = 5 * 1024 * 1024;
const AUDIO_EXTENSIONS = new Set(['.aac', '.aiff', '.flac', '.m4a', '.mp3', '.ogg', '.wav', '.wma']);
const FORBIDDEN_BASENAMES = new Set(['.gitleaksignore', '.gitmodules', '.app.json']);
const FORBIDDEN_SEGMENTS = new Set(['.ape', '.claude', '.codex', '.git', '.planning', 'node_modules']);
const EMAIL = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/iu;
const PRIVATE_RUN_ID = /\brun-20\d{10,20}-[0-9a-f]{8}\b/u;
const QUALIFIED_PRIVATE_REFERENCE = /(?:github\.com\/AAWWCC\/ape\/(?:pull|issues)\/\d+|\bAAWWCC\/ape#\d+\b)/iu;
const LOCAL_PRIVATE_REFERENCE = /\b(?:PR|pull request|issue)\s+#\d+\b/iu;
const SYNTHETIC_REFERENCE = /\b(?:acme|example|fixture|synthetic)\b/iu;
const ABSOLUTE_USER_PATH = /(?:\/Users\/[^/\s]+|[A-Z]:\\Users\\[^\\\s]+)/u;
const SECRET = /(?:-----BEGIN [A-Z ]*PRIVATE KEY-----|\bghp_[A-Za-z0-9]{20,}\b|\bgithub_pat_[A-Za-z0-9_]{20,}\b|\bsk-[A-Za-z0-9]{20,}\b)/u;
const OLD_PERSONAL_AUTHOR = new RegExp(`\\b${['Ai', 'dan'].join('')}\\b`, 'iu');

class SurfaceError extends Error {}

function compareNames(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function usage() {
  return 'usage: node scripts/check-public-surface.mjs [--root <path>]... [--forbidden-hash-file <path>]...\n';
}

function parseArgs(argv) {
  const roots = [];
  const forbiddenHashFiles = [];
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (!['--root', '--forbidden-hash-file'].includes(flag)) {
      throw new SurfaceError(`unknown argument: ${flag}`);
    }
    const value = argv[index + 1];
    if (!value || value.startsWith('--')) throw new SurfaceError(`${flag} requires a path`);
    if (flag === '--root') roots.push(resolve(value));
    else forbiddenHashFiles.push(resolve(value));
    index += 1;
  }
  return { roots: roots.length > 0 ? roots : [DEFAULT_ROOT], forbiddenHashFiles };
}

function parseForbiddenHashes(value, source) {
  const tokens = value.split(/[\s,]+/u).filter(Boolean);
  for (const token of tokens) {
    if (!/^[0-9a-f]{64}$/iu.test(token)) {
      throw new SurfaceError(`${source} contains a value that is not a SHA-256 hex digest`);
    }
  }
  return tokens.map((token) => token.toLowerCase());
}

async function loadForbiddenHashes(paths) {
  const hashes = new Set(parseForbiddenHashes(
    process.env.APE_PUBLIC_FORBIDDEN_HASHES ?? '',
    'APE_PUBLIC_FORBIDDEN_HASHES',
  ));
  for (const [path, optional] of [[DEFAULT_PRIVATE_HASH_FILE, true], ...paths.map((path) => [path, false])]) {
    let contents;
    try {
      contents = await readFile(path, 'utf8');
    } catch (error) {
      if (optional && error?.code === 'ENOENT') continue;
      throw error;
    }
    for (const hash of parseForbiddenHashes(contents, path)) hashes.add(hash);
  }
  return hashes;
}

async function loadForbiddenFingerprints() {
  let contents;
  try {
    contents = await readFile(DEFAULT_FINGERPRINT_FILE, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') return new Set();
    throw error;
  }
  let document;
  try {
    document = JSON.parse(contents);
  } catch (error) {
    throw new SurfaceError(`${DEFAULT_FINGERPRINT_FILE} is not valid JSON (${error.message})`);
  }
  if (
    !document ||
    typeof document !== 'object' ||
    Array.isArray(document) ||
    document.version !== 1 ||
    document.domain !== FINGERPRINT_DOMAIN ||
    !Array.isArray(document.fingerprints) ||
    Object.keys(document).sort(compareNames).join(',') !== 'domain,fingerprints,version'
  ) {
    throw new SurfaceError(`${DEFAULT_FINGERPRINT_FILE} has an invalid closed schema`);
  }
  return new Set(parseForbiddenHashes(
    document.fingerprints.join('\n'),
    `${DEFAULT_FINGERPRINT_FILE} fingerprints`,
  ));
}

function fingerprint(rawDigest) {
  return createHash('sha256')
    .update(`${FINGERPRINT_DOMAIN}\0`, 'utf8')
    .update(Buffer.from(rawDigest, 'hex'))
    .digest('hex');
}

function audioMagic(bytes) {
  const ascii = bytes.subarray(0, 12).toString('ascii');
  return (
    (ascii.startsWith('RIFF') && ascii.slice(8, 12) === 'WAVE') ||
    ascii.startsWith('ID3') ||
    ascii.startsWith('OggS') ||
    ascii.startsWith('fLaC') ||
    ascii.startsWith('FORM')
  );
}

function allowedEmail(value) {
  if (value.toLowerCase() === 'git@github.com') return true;
  const domain = value.slice(value.lastIndexOf('@') + 1).toLowerCase();
  return (
    ['example.com', 'example.net', 'example.org'].includes(domain) ||
    domain.endsWith('.test') ||
    domain.endsWith('.invalid') ||
    domain === 'users.noreply.github.com'
  );
}

function contentFindings(text, forbiddenHashes, forbiddenFingerprints) {
  const findings = [];
  for (const match of text.matchAll(new RegExp(EMAIL.source, `${EMAIL.flags}g`))) {
    if (!allowedEmail(match[0])) findings.push('personal/non-fixture email address');
  }
  if (PRIVATE_RUN_ID.test(text)) findings.push('private date-shaped run id');
  if (QUALIFIED_PRIVATE_REFERENCE.test(text)) findings.push('qualified private AAWWCC/ape reference');
  for (const line of text.split(/\r?\n/u)) {
    if (LOCAL_PRIVATE_REFERENCE.test(line) && !SYNTHETIC_REFERENCE.test(line)) {
      findings.push('unqualified private PR/issue reference');
      break;
    }
  }
  if (ABSOLUTE_USER_PATH.test(text)) findings.push('absolute user path');
  if (/\bape-private\b/u.test(text)) findings.push('private repository name');
  if (OLD_PERSONAL_AUTHOR.test(text)) findings.push('old personal author identity');
  if (SECRET.test(text)) findings.push('secret/private-key pattern');
  const lower = text.toLowerCase();
  if ([...forbiddenHashes].some((hash) => lower.includes(hash))) {
    findings.push('forbidden private blob hash');
  }
  for (const match of lower.matchAll(/\b[0-9a-f]{64}\b/gu)) {
    if (forbiddenFingerprints.has(fingerprint(match[0]))) {
      findings.push('forbidden private blob hash');
      break;
    }
  }
  return findings;
}

function pathFailures(normalized) {
  const failures = [];
  const parts = normalized.split('/');
  if (parts.some((part) => FORBIDDEN_SEGMENTS.has(part))) failures.push('private/runtime path');
  if (FORBIDDEN_BASENAMES.has(basename(normalized))) failures.push('forbidden metadata file');
  if (normalized === 'assets' || normalized.startsWith('assets/')) failures.push('root assets directory');
  if (/^plugins\/[^/]+\/assets(?:\/|$)/u.test(normalized)) failures.push('packaged assets directory');
  if (normalized === 'docs/research' || normalized.startsWith('docs/research/')) failures.push('private research history');
  if (normalized === 'benchmarks' || normalized.startsWith('benchmarks/')) failures.push('private benchmark history');
  if (/runtime-v2-release-(?!2-17-0|artifacts|version-parity)[^/]*\.test\.js$/u.test(normalized)) failures.push('private release-history test');
  if (AUDIO_EXTENSIONS.has(extname(normalized).toLowerCase())) failures.push('audio extension');
  return failures;
}

async function validateMcp(path, failures) {
  let config;
  try {
    config = JSON.parse(await readFile(path, 'utf8'));
  } catch (error) {
    failures.push(`${path}: invalid MCP JSON (${error.message})`);
    return;
  }
  const servers = config?.mcpServers;
  if (!servers || typeof servers !== 'object' || Array.isArray(servers)) {
    failures.push(`${path}: missing mcpServers object`);
    return;
  }
  for (const [name, server] of Object.entries(servers)) {
    if (!server || typeof server !== 'object' || Array.isArray(server)) {
      failures.push(`${path}: invalid MCP server ${name}`);
      continue;
    }
    if (server.command !== 'node') failures.push(`${path}: ${name} must use local node stdio`);
    if ('url' in server || server.type === 'http' || server.type === 'sse') {
      failures.push(`${path}: ${name} declares a hosted MCP transport`);
    }
    if (!Array.isArray(server.args) || !server.args.includes('--host')) {
      failures.push(`${path}: ${name} must pass an explicit local host argument`);
    }
  }
}

async function validateManifest(path, failures) {
  let manifest;
  try {
    manifest = JSON.parse(await readFile(path, 'utf8'));
  } catch (error) {
    failures.push(`${path}: invalid manifest JSON (${error.message})`);
    return;
  }
  if (manifest?.author && 'email' in manifest.author) failures.push(`${path}: author email is forbidden`);
  if (manifest?.mcpServers && manifest.mcpServers !== './.mcp.json') {
    failures.push(`${path}: packaged MCP declaration must reference ./.mcp.json`);
  }
}

async function validateMarketplaces(root, failures) {
  const codexPath = join(root, '.agents', 'plugins', 'marketplace.json');
  const claudePath = join(root, '.claude-plugin', 'marketplace.json');
  for (const [path, kind] of [[codexPath, 'codex'], [claudePath, 'claude']]) {
    try {
      const marketplace = JSON.parse(await readFile(path, 'utf8'));
      const entry = marketplace.plugins?.find((candidate) => candidate?.name === 'ape');
      if (!entry) {
        failures.push(`${path}: missing ape marketplace entry`);
        continue;
      }
      if (kind === 'codex') {
        if (entry.source?.source !== 'local' || entry.source?.path !== './plugins/ape') {
          failures.push(`${path}: Codex source must be local ./plugins/ape`);
        }
        if (!entry.policy?.installation || !entry.policy?.authentication || !entry.category) {
          failures.push(`${path}: Codex entry must declare installation, authentication, and category`);
        }
      } else if (entry.source !== './plugins/ape-claude') {
        failures.push(`${path}: Claude source must be ./plugins/ape-claude`);
      }
    } catch (error) {
      if (error?.code !== 'ENOENT') failures.push(`${path}: invalid marketplace (${error.message})`);
    }
  }
}

async function scanRoot(root, forbiddenHashes, forbiddenFingerprints) {
  const failures = [];
  let files = 0;
  async function visit(directory) {
    const entries = (await readdir(directory, { withFileTypes: true }))
      .sort((left, right) => compareNames(left.name, right.name));
    for (const entry of entries) {
      const path = join(directory, entry.name);
      const normalized = relative(root, path).split(sep).join('/');
      for (const reason of pathFailures(normalized)) failures.push(`${normalized}: ${reason}`);
      if (entry.isSymbolicLink()) {
        failures.push(`${normalized}: symlink`);
        continue;
      }
      if (entry.isDirectory()) {
        await visit(path);
        continue;
      }
      if (!entry.isFile()) {
        failures.push(`${normalized}: special file`);
        continue;
      }
      files += 1;
      const metadata = await stat(path);
      if (metadata.size > MAX_PUBLIC_FILE_BYTES) failures.push(`${normalized}: exceeds 5 MiB`);
      const bytes = await readFile(path);
      if (audioMagic(bytes)) failures.push(`${normalized}: audio file signature`);
      const digest = createHash('sha256').update(bytes).digest('hex');
      if (forbiddenHashes.has(digest) || forbiddenFingerprints.has(fingerprint(digest))) {
        failures.push(`${normalized}: forbidden private blob hash`);
      }
      const text = bytes.toString('utf8');
      for (const finding of contentFindings(text, forbiddenHashes, forbiddenFingerprints)) {
        failures.push(`${normalized}: ${finding}`);
      }
      if (entry.name === '.mcp.json') await validateMcp(path, failures);
      if (normalized.endsWith('/plugin.json')) await validateManifest(path, failures);
    }
  }
  await visit(root);
  await validateMarketplaces(root, failures);
  if (failures.length > 0) {
    throw new SurfaceError(
      `public surface ${root} failed with ${failures.length} finding(s):\n${failures.map((failure) => `- ${failure}`).join('\n')}`,
    );
  }
  return files;
}

async function main(argv) {
  const { roots, forbiddenHashFiles } = parseArgs(argv);
  const [forbiddenHashes, forbiddenFingerprints] = await Promise.all([
    loadForbiddenHashes(forbiddenHashFiles),
    loadForbiddenFingerprints(),
  ]);
  if (
    process.env.APE_PUBLIC_REQUIRE_FORBIDDEN_HASHES === '1' &&
    forbiddenHashes.size === 0 &&
    forbiddenFingerprints.size === 0
  ) {
    throw new SurfaceError('no forbidden private blob protections are configured');
  }
  let files = 0;
  for (const root of roots) files += await scanRoot(root, forbiddenHashes, forbiddenFingerprints);
  process.stdout.write(`public surface passed: ${files} files across ${roots.length} root(s)\n`);
}

main(process.argv.slice(2)).catch((error) => {
  if (error instanceof SurfaceError && /unknown argument|requires a path/u.test(error.message)) {
    process.stderr.write(usage());
  }
  process.stderr.write(`check-public-surface: ${error?.message ?? String(error)}\n`);
  process.exitCode = 1;
});
