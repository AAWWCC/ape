#!/usr/bin/env node

import { createHash } from 'node:crypto';
import {
  cp,
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  utimes,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = dirname(SCRIPT_DIR);
const DEFAULT_OUTPUT_ROOT = join(REPO_ROOT, 'plugins');
const SKILL_SOURCE_ROOT = join(REPO_ROOT, 'plugin-src', 'skills');
const HOSTS = Object.freeze([
  { directory: 'ape', host: 'codex' },
  { directory: 'ape-claude', host: 'claude' },
  { directory: 'ape-gemini', host: 'gemini' },
]);
const DIST_FILES = Object.freeze([
  'ape-hooks.bundle.mjs',
  'ape-larp.bundle.mjs',
  'ape-mcp.bundle.mjs',
]);
const RUNTIME_FILES = Object.freeze(['runner.js', 'spawn.js']);
const SKILL_NAMES = Object.freeze(['config', 'history', 'override', 'resume', 'roadmap', 'run', 'status']);
const ROLE_NAMES = Object.freeze([
  'preflight_analyst',
  'planner',
  'plan_checker',
  'plan_critic',
  'plan_judge',
  'test_writer',
  'implementer',
  'reviewer',
  'security_reviewer',
  'debugger',
  'spike_researcher',
]);
const METADATA_KEYS = new Set(['name', 'description', 'argumentHint', 'invocation']);
const SOURCE_DATE_EPOCH = Number.parseInt(process.env.SOURCE_DATE_EPOCH ?? '0', 10);
const PINNED_TIME = new Date(
  Number.isSafeInteger(SOURCE_DATE_EPOCH) && SOURCE_DATE_EPOCH >= 0
    ? SOURCE_DATE_EPOCH * 1000
    : 0,
);
const SKILL_INTERFACE = Object.freeze({
  config: ['APE Config', 'Configure and diagnose the APE runtime', 'Use $ape:config to inspect or update APE runtime configuration.'],
  history: ['APE History', 'Inspect and maintain durable APE history', 'Use $ape:history to inspect or explicitly maintain APE run history.'],
  override: ['APE Override', 'Audit and recover blocked APE state', 'Use $ape:override to perform a reason-audited APE recovery action.'],
  resume: ['APE Resume', 'Resume an interrupted durable APE run', 'Use $ape:resume to continue the active APE run from persisted state.'],
  roadmap: ['APE Roadmap', 'Inspect and evolve the governed roadmap', 'Use $ape:roadmap to inspect or explicitly evolve the APE roadmap.'],
  run: ['APE Run', 'Start or advance a governed coding run', 'Use $ape:run to start or advance an explicit evidence-gated coding run.'],
  status: ['APE Status', 'Show the current APE run and gate state', 'Use $ape:status to show the active run, ticket, lane, and gate state.'],
});

class PackageError extends Error {}

function compareNames(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

async function ensureDirectory(path) {
  await mkdir(path, { recursive: true, mode: 0o755 });
  await chmod(path, 0o755);
}

function usage() {
  return 'usage: node scripts/build-plugin-packages.mjs [--output-root <path>] [--check]\n';
}

function parseArgs(argv) {
  const args = { outputRoot: DEFAULT_OUTPUT_ROOT, check: false };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === '--check') {
      args.check = true;
      continue;
    }
    if (token === '--output-root') {
      const value = argv[index + 1];
      if (!value || value.startsWith('--')) throw new PackageError('--output-root requires a path');
      args.outputRoot = resolve(value);
      index += 1;
      continue;
    }
    throw new PackageError(`unknown argument: ${token}`);
  }
  return args;
}

async function readJson(path) {
  return JSON.parse(await readFile(path, 'utf8'));
}

async function writeJson(path, value) {
  await ensureDirectory(dirname(path));
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  await chmod(path, 0o644);
}

async function assertRegularFile(path) {
  const metadata = await lstat(path);
  if (!metadata.isFile() || metadata.isSymbolicLink()) {
    throw new PackageError(`package input must be a regular non-symlink file: ${path}`);
  }
}

async function copyTextFile(source, destination) {
  await assertRegularFile(source);
  await ensureDirectory(dirname(destination));
  const text = await readFile(source, 'utf8');
  if (text.includes('\uFFFD')) throw new PackageError(`package text input is not valid UTF-8: ${source}`);
  await writeFile(destination, text.replace(/\r\n?/gu, '\n'), 'utf8');
  await chmod(destination, 0o644);
}

function validateSkillMetadata(metadata, path) {
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) {
    throw new PackageError(`${path} must contain an object`);
  }
  const extra = Object.keys(metadata).filter((key) => !METADATA_KEYS.has(key));
  if (extra.length > 0) throw new PackageError(`${path} contains unknown keys: ${extra.join(', ')}`);
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(metadata.name ?? '')) {
    throw new PackageError(`${path} has an invalid skill name`);
  }
  if (typeof metadata.description !== 'string' || !metadata.description.trim()) {
    throw new PackageError(`${path} has no description`);
  }
  if (metadata.argumentHint !== undefined && typeof metadata.argumentHint !== 'string') {
    throw new PackageError(`${path} argumentHint must be a string`);
  }
  if (!['explicit', 'implicit'].includes(metadata.invocation)) {
    throw new PackageError(`${path} invocation must be explicit or implicit`);
  }
}

function renderSkill(metadata, body, host) {
  const lines = [
    '---',
    `name: ${metadata.name}`,
    `description: ${JSON.stringify(metadata.description)}`,
  ];
  if (host === 'claude' && metadata.argumentHint) {
    lines.push(`argument-hint: ${JSON.stringify(metadata.argumentHint)}`);
  }
  if (host === 'claude') {
    lines.push(`disable-model-invocation: ${metadata.invocation === 'explicit' ? 'true' : 'false'}`);
  }
  lines.push('---', '', body.replace(/\r\n?/gu, '\n').trimEnd(), '');
  return lines.join('\n');
}

function renderOpenAiYaml(metadata) {
  const values = SKILL_INTERFACE[metadata.name];
  if (!values) throw new PackageError(`missing Codex interface metadata for skill ${metadata.name}`);
  const [displayName, shortDescription, defaultPrompt] = values;
  return [
    'interface:',
    `  display_name: ${JSON.stringify(displayName)}`,
    `  short_description: ${JSON.stringify(shortDescription)}`,
    `  default_prompt: ${JSON.stringify(defaultPrompt)}`,
    'policy:',
    `  allow_implicit_invocation: ${metadata.invocation === 'implicit' ? 'true' : 'false'}`,
    '',
  ].join('\n');
}

async function buildSkills(destination, host) {
  const entries = (await readdir(SKILL_SOURCE_ROOT, { withFileTypes: true }))
    .sort((left, right) => compareNames(left.name, right.name));
  const expectedEntries = [...SKILL_NAMES, 'references'].sort(compareNames);
  if (
    entries.some((entry) => !entry.isDirectory() || entry.isSymbolicLink()) ||
    entries.map((entry) => entry.name).join('\0') !== expectedEntries.join('\0')
  ) {
    throw new PackageError(`plugin-src/skills must contain exactly: ${expectedEntries.join(', ')}`);
  }
  const referenceEntries = (await readdir(join(SKILL_SOURCE_ROOT, 'references'), { withFileTypes: true }))
    .sort((left, right) => compareNames(left.name, right.name));
  if (
    referenceEntries.length !== 1 ||
    referenceEntries[0].name !== 'run-resume-protocol.md' ||
    !referenceEntries[0].isFile() ||
    referenceEntries[0].isSymbolicLink()
  ) {
    throw new PackageError('plugin-src/skills/references must contain only run-resume-protocol.md');
  }
  for (const name of SKILL_NAMES) {
    const source = join(SKILL_SOURCE_ROOT, name);
    const sourceEntries = (await readdir(source, { withFileTypes: true }))
      .sort((left, right) => compareNames(left.name, right.name));
    if (
      sourceEntries.length !== 2 ||
      sourceEntries.map((entry) => entry.name).join('\0') !== 'body.md\0metadata.json' ||
      sourceEntries.some((entry) => !entry.isFile() || entry.isSymbolicLink())
    ) {
      throw new PackageError(`${source} must contain only body.md and metadata.json`);
    }
    const metadataPath = join(source, 'metadata.json');
    const bodyPath = join(source, 'body.md');
    const metadata = await readJson(metadataPath);
    validateSkillMetadata(metadata, metadataPath);
    if (metadata.name !== name) {
      throw new PackageError(`${metadataPath} name must match directory ${name}`);
    }
    await assertRegularFile(bodyPath);
    let body = await readFile(bodyPath, 'utf8');
    if (!body.trim()) throw new PackageError(`${bodyPath} is empty`);
    if (name === 'run' || name === 'resume') {
      body = body.replaceAll(
        '../references/run-resume-protocol.md',
        'references/run-resume-protocol.md',
      );
    }
    const output = join(destination, name, 'SKILL.md');
    await ensureDirectory(dirname(output));
    await writeFile(output, renderSkill(metadata, body, host), 'utf8');
    await chmod(output, 0o644);
    if (host === 'codex') {
      const agentsPath = join(destination, name, 'agents', 'openai.yaml');
      await ensureDirectory(dirname(agentsPath));
      await writeFile(agentsPath, renderOpenAiYaml(metadata), 'utf8');
      await chmod(agentsPath, 0o644);
    }
    if (name === 'run' || name === 'resume') {
      await copyTextFile(
        join(SKILL_SOURCE_ROOT, 'references', 'run-resume-protocol.md'),
        join(destination, name, 'references', 'run-resume-protocol.md'),
      );
    }
  }
}

function baseMetadata(version) {
  return {
    name: 'ape',
    version,
    description: 'Durable, evidence-gated engineering runs for AI coding agents.',
    author: {
      name: 'AAWWCC',
      url: 'https://github.com/AAWWCC',
    },
    repository: 'https://github.com/AAWWCC/ape',
    homepage: 'https://github.com/AAWWCC/ape#readme',
    license: 'MIT',
    keywords: ['agents', 'claude', 'codex', 'mcp', 'resumable', 'tdd', 'verification'],
  };
}

function codexManifest(version) {
  return {
    ...baseMetadata(version),
    skills: './skills/',
    mcpServers: './.mcp.json',
    interface: {
      displayName: 'APE',
      shortDescription: 'Resumable, evidence-gated AI coding',
      longDescription:
        'APE coordinates durable coding runs with runtime-owned state, test-first behavioral implementation where applicable, independent review, and verified shipping.',
      developerName: 'AAWWCC',
      category: 'Engineering',
      capabilities: ['Read', 'Write'],
      websiteURL: 'https://github.com/AAWWCC/ape',
      defaultPrompt: ['Run this change as a resumable, evidence-gated APE workflow'],
      brandColor: '#F59E0B',
      screenshots: [],
    },
  };
}

function claudeManifest(version) {
  return {
    $schema: 'https://json.schemastore.org/claude-code-plugin-manifest.json',
    name: 'ape',
    version,
    description: 'APE — durable, evidence-gated engineering runs for AI coding agents.',
    author: {
      name: 'AAWWCC',
      url: 'https://github.com/AAWWCC',
    },
    repository: 'https://github.com/AAWWCC/ape',
    homepage: 'https://github.com/AAWWCC/ape#readme',
    license: 'MIT',
    hooks: './hooks/claude-hooks.json',
  };
}

function geminiManifest(version) {
  return {
    name: 'ape',
    version,
    description: 'APE — durable, evidence-gated engineering runs for AI coding agents.',
    author: {
      name: 'AAWWCC',
      url: 'https://github.com/AAWWCC',
    },
    repository: 'https://github.com/AAWWCC/ape',
    homepage: 'https://github.com/AAWWCC/ape#readme',
    license: 'MIT',
  };
}

function mcpConfig(host) {
  const bundle = host === 'claude'
    ? '${CLAUDE_PLUGIN_ROOT}/dist/ape-mcp.bundle.mjs'
    : './dist/ape-mcp.bundle.mjs';
  const server = {
    command: 'node',
    args: [bundle, '--host', host],
  };
  if (host === 'codex') server.cwd = '.';
  return { mcpServers: { ape: server } };
}

async function buildHostPackage(root, host, version) {
  await ensureDirectory(root);
  if (host === 'codex') {
    await writeJson(join(root, '.codex-plugin', 'plugin.json'), codexManifest(version));
  } else if (host === 'claude') {
    await writeJson(join(root, '.claude-plugin', 'plugin.json'), claudeManifest(version));
  } else if (host === 'gemini') {
    await writeJson(join(root, 'plugin.json'), geminiManifest(version));
    await writeJson(join(root, 'mcp_config.json'), mcpConfig(host));
    await copyTextFile(join(REPO_ROOT, 'hooks', 'gemini-hooks.json'), join(root, 'hooks.json'));
    await copyTextFile(
      join(REPO_ROOT, 'hooks', 'gemini-hooks.json'),
      join(root, 'hooks', 'gemini-hooks.json'),
    );
  }
  await writeJson(join(root, '.mcp.json'), mcpConfig(host));
  await buildSkills(join(root, 'skills'), host);

  for (const file of DIST_FILES) {
    await copyTextFile(join(REPO_ROOT, 'dist', file), join(root, 'dist', file));
  }
  await copyTextFile(join(REPO_ROOT, 'hooks', 'hooks.json'), join(root, 'hooks', 'hooks.json'));
  if (host === 'claude') {
    await copyTextFile(
      join(REPO_ROOT, 'hooks', 'claude-hooks.json'),
      join(root, 'hooks', 'claude-hooks.json'),
    );
    for (const role of ROLE_NAMES) {
      const file = `${role.replaceAll('_', '-')}.md`;
      await copyTextFile(join(REPO_ROOT, 'agents', file), join(root, 'agents', file));
    }
  }
  for (const file of ['common.md', ...ROLE_NAMES.map((role) => `${role}.md`)]) {
    await copyTextFile(join(REPO_ROOT, 'prompts', file), join(root, 'prompts', file));
  }
  for (const file of RUNTIME_FILES) {
    await copyTextFile(
      join(REPO_ROOT, 'lib', 'runtime', file),
      join(root, 'lib', 'runtime', file),
    );
  }
  for (const file of ['LICENSE', 'THIRD_PARTY_NOTICES.md']) {
    await copyTextFile(join(REPO_ROOT, file), join(root, file));
  }
  await writeJson(join(root, 'package.json'), {
    name: 'ape',
    version,
    type: 'module',
    private: true,
    license: 'MIT',
    repository: 'https://github.com/AAWWCC/ape',
  });
  await normalizeTreeMetadata(root);
}

async function normalizeTreeMetadata(root) {
  async function visit(directory) {
    const entries = (await readdir(directory, { withFileTypes: true }))
      .sort((left, right) => compareNames(left.name, right.name));
    for (const entry of entries) {
      const target = join(directory, entry.name);
      if (entry.isDirectory()) await visit(target);
      else if (entry.isFile()) {
        await chmod(target, 0o644);
        await utimes(target, PINNED_TIME, PINNED_TIME);
      }
    }
    await chmod(directory, 0o755);
    await utimes(directory, PINNED_TIME, PINNED_TIME);
  }
  await visit(root);
}

async function treeDigest(root) {
  const hash = createHash('sha256');
  async function visit(directory) {
    const entries = (await readdir(directory, { withFileTypes: true }))
      .sort((left, right) => compareNames(left.name, right.name));
    for (const entry of entries) {
      const target = join(directory, entry.name);
      const normalized = relative(root, target).split(sep).join('/');
      if (entry.isSymbolicLink()) throw new PackageError(`generated package contains symlink: ${target}`);
      if (entry.isDirectory()) {
        const metadata = await lstat(target);
        hash.update(`d\0${normalized}\0${metadata.mode & 0o777}\0`);
        await visit(target);
      } else if (entry.isFile()) {
        const metadata = await lstat(target);
        hash.update(`f\0${normalized}\0${metadata.mode & 0o777}\0`);
        hash.update(await readFile(target));
      } else {
        throw new PackageError(`generated package contains special file: ${target}`);
      }
    }
  }
  await visit(root);
  return hash.digest('hex');
}

async function replaceDirectory(source, destination) {
  await ensureDirectory(dirname(destination));
  const temporary = join(dirname(destination), `.${basename(destination)}.next-${process.pid}`);
  await rm(temporary, { recursive: true, force: true });
  await cp(source, temporary, { recursive: true, preserveTimestamps: true });
  await rm(destination, { recursive: true, force: true });
  await rename(temporary, destination);
}

async function build(argv) {
  const args = parseArgs(argv);
  const packageJson = await readJson(join(REPO_ROOT, 'package.json'));
  const version = packageJson.version;
  if (!/^\d+\.\d+\.\d+$/.test(version ?? '')) {
    throw new PackageError('package.json version must be a bare semantic version');
  }
  const scratch = await mkdtemp(join(tmpdir(), 'ape-plugin-packages-'));
  try {
    const generated = join(scratch, 'plugins');
    for (const target of HOSTS) {
      await buildHostPackage(join(generated, target.directory), target.host, version);
    }
    if (args.check) {
      for (const target of HOSTS) {
        const expected = join(args.outputRoot, target.directory);
        let actualDigest;
        try {
          actualDigest = await treeDigest(expected);
        } catch {
          throw new PackageError(`generated package is missing or unreadable: ${expected}`);
        }
        const freshDigest = await treeDigest(join(generated, target.directory));
        if (actualDigest !== freshDigest) {
          throw new PackageError(
            `${target.directory} is stale (${actualDigest} != ${freshDigest}); run npm run package:plugins`,
          );
        }
      }
      process.stdout.write('plugin packages are byte-identical to a fresh deterministic build\n');
      return;
    }
    for (const target of HOSTS) {
      await replaceDirectory(
        join(generated, target.directory),
        join(args.outputRoot, target.directory),
      );
    }
    process.stdout.write(`wrote deterministic plugin packages for ${version} under ${args.outputRoot}\n`);
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

build(process.argv.slice(2)).catch((error) => {
  if (error instanceof PackageError) process.stderr.write(usage());
  process.stderr.write(`build-plugin-packages: ${error?.message ?? String(error)}\n`);
  process.exitCode = 1;
});
