#!/usr/bin/env node

import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  access,
  chmod,
  lstat,
  mkdir,
  readFile,
  readdir,
  writeFile,
} from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const run = promisify(execFile);
const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = dirname(SCRIPT_DIR);
const PUBLIC_VERSION = '2.23.47';
const PUBLIC_FILES = Object.freeze([
  '.gitattributes',
  'compatibility.json',
  'LICENSE',
  'README.md',
  'SECURITY.md',
  'THIRD_PARTY_NOTICES.md',
  'jsconfig.json',
  'package-lock.json',
  'package.json',
  'public-asset-fingerprints.json',
  'vitest.config.js',
]);
const PUBLIC_DIRECTORIES = Object.freeze([
  '.agents',
  '.claude-plugin',
  '.github',
  '__tests__',
  'agents',
  'bin',
  'dist',
  'docs',
  'evals',
  'hooks',
  'lib',
  'plugin-src',
  'plugins',
  'prompts',
  'scripts',
  'test-support',
]);

class ExportError extends Error {}

function compareNames(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function usage() {
  return 'usage: node scripts/export-public-tree.mjs --out <new-directory> [--allow-dirty]\n';
}

function parseArgs(argv) {
  const args = { output: null, allowDirty: false };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === '--allow-dirty') {
      args.allowDirty = true;
      continue;
    }
    if (token === '--out') {
      const value = argv[index + 1];
      if (!value || value.startsWith('--')) throw new ExportError('--out requires a path');
      args.output = resolve(value);
      index += 1;
      continue;
    }
    throw new ExportError(`unknown argument: ${token}`);
  }
  if (!args.output) throw new ExportError('--out is required');
  const rel = relative(REPO_ROOT, args.output);
  if (rel === '' || (!isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${sep}`))) {
    throw new ExportError('public export destination must be outside the private source checkout');
  }
  return args;
}

async function exists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

function includePath(normalized) {
  if (normalized.startsWith('evals/results/') && normalized !== 'evals/results/.gitignore') return false;
  if (normalized === 'docs/research' || normalized.startsWith('docs/research/')) return false;
  if (normalized === 'benchmarks' || normalized.startsWith('benchmarks/')) return false;
  if (/^__tests__\/runtime-v2-release-(?!2-17-1|artifacts|version-parity)[^/]*\.test\.js$/u.test(normalized)) {
    return false;
  }
  if (/^__tests__\/runtime-v2-audit-/u.test(normalized)) return false;
  if (normalized === '__tests__/runtime-v2-private-sound-overlay.test.js') return false;
  if (normalized === '__tests__/runtime-v2-shipped-surface-truthfulness.test.js') return false;
  if (normalized === '.github/test-durations.json') return false;
  if (normalized === '.claude-plugin/plugin.json') return false;
  return true;
}

function stableFixture(value) {
  return createHash('sha256').update(value).digest('hex').slice(0, 12);
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

function sanitizePublicText(text) {
  let sanitized = text.replace(/\brun-20\d{10,20}-[0-9a-f]{8}\b/gu, (value) =>
    `run-fixture-${stableFixture(value)}`
  );
  sanitized = sanitized
    .replace(/https:\/\/github\.com\/AAWWCC\/ape\/pull\/(\d+)/giu, 'https://github.com/acme/project/pull/$1')
    .replace(/https:\/\/github\.com\/AAWWCC\/ape\/issues\/(\d+)/giu, 'https://github.com/acme/project/issues/$1')
    .replace(/\bAAWWCC\/ape#(\d+)\b/giu, 'acme/project#$1')
    .replace(/\b(PR|pull request|issue)\s+#(\d+)\b/giu, 'acme $1 #$2')
    .replace(/(?:\/Users\/[^/\s]+|[A-Z]:\\Users\\[^\\\s]+)/gu, '/workspace/user')
    .replace(/\bape-private\b/gu, 'private-source-overlay');
  sanitized = sanitized.replace(
    /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/giu,
    (value) => allowedEmail(value) ? value : `developer+${stableFixture(value)}@example.test`,
  );
  return sanitized.replace(/\r\n?/gu, '\n');
}

async function copyPublicFile(source, destination) {
  const bytes = await readFile(source);
  const text = bytes.toString('utf8');
  if (text.includes('\uFFFD')) throw new ExportError(`public export input is not valid UTF-8: ${source}`);
  await mkdir(dirname(destination), { recursive: true, mode: 0o755 });
  await chmod(dirname(destination), 0o755);
  await writeFile(destination, sanitizePublicText(text), 'utf8');
  await chmod(destination, 0o644);
}

async function copyRegularTree(source, destination) {
  const entries = (await readdir(source, { withFileTypes: true }))
    .sort((left, right) => compareNames(left.name, right.name));
  await mkdir(destination, { recursive: true, mode: 0o755 });
  await chmod(destination, 0o755);
  for (const entry of entries) {
    const from = join(source, entry.name);
    const normalized = relative(REPO_ROOT, from).split(sep).join('/');
    if (!includePath(normalized)) continue;
    const to = join(destination, entry.name);
    if (entry.isSymbolicLink()) throw new ExportError(`public export refuses symlink: ${from}`);
    if (entry.isDirectory()) await copyRegularTree(from, to);
    else if (entry.isFile()) {
      const metadata = await lstat(from);
      if (!metadata.isFile()) throw new ExportError(`public export refuses special file: ${from}`);
      await copyPublicFile(from, to);
    } else throw new ExportError(`public export refuses special file: ${from}`);
  }
}

async function publicChangelog() {
  const changelog = await readFile(join(REPO_ROOT, 'CHANGELOG.md'), 'utf8');
  const heading = `## ${PUBLIC_VERSION}`;
  const start = changelog.indexOf(heading);
  if (start === -1) throw new ExportError(`CHANGELOG.md has no ${PUBLIC_VERSION} release section`);
  const tail = changelog.slice(start);
  const next = tail.slice(heading.length).search(/^## /mu);
  const section = next === -1 ? tail : tail.slice(0, heading.length + next);
  return `# Changelog\n\n${section.trim()}\n`;
}

async function assertClean() {
  const { stdout } = await run('git', ['status', '--porcelain=v1'], { cwd: REPO_ROOT });
  if (stdout.trim()) {
    throw new ExportError('private source checkout is dirty; commit an immutable source snapshot first');
  }
}

async function main(argv) {
  const args = parseArgs(argv);
  if (await exists(args.output)) throw new ExportError(`destination already exists: ${args.output}`);
  if (!args.allowDirty) await assertClean();

  const packageJson = JSON.parse(await readFile(join(REPO_ROOT, 'package.json'), 'utf8'));
  if (packageJson.version !== PUBLIC_VERSION) {
    throw new ExportError(`package version must be ${PUBLIC_VERSION}, got ${packageJson.version}`);
  }
  await run(process.execPath, [join(SCRIPT_DIR, 'build-plugin-packages.mjs'), '--check'], {
    cwd: REPO_ROOT,
  });

  await mkdir(args.output, { recursive: false });
  await chmod(args.output, 0o755);
  for (const file of PUBLIC_FILES) {
    const source = join(REPO_ROOT, file);
    const metadata = await lstat(source);
    if (!metadata.isFile() || metadata.isSymbolicLink()) {
      throw new ExportError(`public export input must be a regular file: ${source}`);
    }
    await copyPublicFile(source, join(args.output, file));
  }
  for (const directory of PUBLIC_DIRECTORIES) {
    await copyRegularTree(join(REPO_ROOT, directory), join(args.output, directory));
  }
  await writeFile(join(args.output, '.gitignore'), [
    'node_modules/',
    '.ape/',
    '.planning/',
    'coverage/',
    'release/',
    '.env',
    '.env.*',
    '*.log',
    '*.tmp',
    '',
  ].join('\n'), 'utf8');
  await chmod(join(args.output, '.gitignore'), 0o644);
  await writeFile(join(args.output, 'CHANGELOG.md'), await publicChangelog(), 'utf8');
  await chmod(join(args.output, 'CHANGELOG.md'), 0o644);

  await run(process.execPath, [join(args.output, 'scripts', 'build-plugin-packages.mjs')], {
    cwd: args.output,
    env: { ...process.env, SOURCE_DATE_EPOCH: process.env.SOURCE_DATE_EPOCH ?? '0', LC_ALL: 'C' },
  });
  await run(process.execPath, [join(args.output, 'scripts', 'build-plugin-packages.mjs'), '--check'], {
    cwd: args.output,
    env: { ...process.env, SOURCE_DATE_EPOCH: process.env.SOURCE_DATE_EPOCH ?? '0', LC_ALL: 'C' },
  });
  await run(process.execPath, [join(SCRIPT_DIR, 'check-public-surface.mjs'), '--root', args.output], {
    cwd: REPO_ROOT,
  });
  process.stdout.write(`exported verified public ${PUBLIC_VERSION} tree to ${args.output}\n`);
}

main(process.argv.slice(2)).catch((error) => {
  if (error instanceof ExportError) process.stderr.write(usage());
  process.stderr.write(`export-public-tree: ${error?.message ?? String(error)}\n`);
  process.exitCode = 1;
});
