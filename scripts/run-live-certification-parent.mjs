#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const RELEASE_VERSION = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version;

export class LiveCertificationParentError extends Error {
  constructor(message) {
    super(message);
    this.name = 'LiveCertificationParentError';
  }
}

function exactDirectory(value, label) {
  if (typeof value !== 'string' || value.length === 0) {
    throw new LiveCertificationParentError(`${label} is required`);
  }
  try {
    return realpathSync(value);
  } catch {
    throw new LiveCertificationParentError(`${label} does not resolve to an existing path`);
  }
}

function configTableBody(lines, table) {
  const start = lines.findIndex((line) => line.trim() === `[${table}]`);
  if (start === -1) {
    return [];
  }
  const nextTable = lines.findIndex(
    (line, index) => index > start && /^\s*\[\[?/u.test(line),
  );
  return lines.slice(start + 1, nextTable === -1 ? lines.length : nextTable);
}

function requireZeroRetryConfig(codexHome) {
  const configPath = path.join(codexHome, 'config.toml');
  let config;
  try {
    config = readFileSync(configPath, 'utf8');
  } catch {
    throw new LiveCertificationParentError('isolated Codex home has no readable config.toml');
  }
  const requirements = [
    { pattern: /^model_provider\s*=\s*"[^"]+"\s*$/mu, description: 'an explicit model_provider' },
    { pattern: /^request_max_retries\s*=\s*0\s*$/mu, description: 'request_max_retries = 0' },
    { pattern: /^stream_max_retries\s*=\s*0\s*$/mu, description: 'stream_max_retries = 0' },
    { pattern: /^supports_websockets\s*=\s*false\s*$/mu, description: 'supports_websockets = false' },
  ];
  for (const { pattern, description } of requirements) {
    if (!pattern.test(config)) {
      throw new LiveCertificationParentError(
        `isolated Codex config must declare ${description} for first-pass-perfect certification`,
      );
    }
  }
  const lines = config.split(/\r?\n/u);
  const analyticsBody = configTableBody(lines, 'analytics');
  if (!analyticsBody.some((line) => /^\s*enabled\s*=\s*false\s*$/u.test(line))) {
    throw new LiveCertificationParentError(
      'isolated Codex config must disable analytics to prevent optional event transport retries',
    );
  }
  const featuresBody = configTableBody(lines, 'features');
  if (!featuresBody.some((line) => /^\s*remote_plugin\s*=\s*false\s*$/u.test(line))) {
    throw new LiveCertificationParentError(
      'isolated Codex config must disable remote_plugin to prevent optional catalog transport failures',
    );
  }
}

function requireExactPlugin(codexHome) {
  const packagePath = path.join(
    codexHome,
    'plugins',
    'cache',
    'ape',
    'ape',
    RELEASE_VERSION,
    'package.json',
  );
  let installed;
  try {
    installed = JSON.parse(readFileSync(packagePath, 'utf8'));
  } catch {
    throw new LiveCertificationParentError(
      `isolated Codex home does not contain cached ape@ape ${RELEASE_VERSION}`,
    );
  }
  if (installed.version !== RELEASE_VERSION) {
    throw new LiveCertificationParentError(
      `cached ape@ape version ${installed.version ?? '<missing>'} does not equal ${RELEASE_VERSION}`,
    );
  }
}

function requireExactPromptProject(prompt, project) {
  const directives = [...prompt.matchAll(/\bproject_dir\b\s*(?::|=)?\s*"([^"\r\n]+)"/gu)];
  if (directives.length === 0) {
    throw new LiveCertificationParentError(
      '--prompt must declare the exact project_dir used for every APE control call',
    );
  }
  for (const directive of directives) {
    const declaredRaw = directive[1];
    let declared;
    try {
      declared = realpathSync(declaredRaw);
    } catch {
      throw new LiveCertificationParentError(
        `prompt project_dir ${declaredRaw} does not resolve to an existing path`,
      );
    }
    if (declared !== project) {
      throw new LiveCertificationParentError(
        `prompt project_dir ${declaredRaw} does not match --project-dir ${project}`,
      );
    }
  }
}

export function buildCodexParentInvocation({ projectDir, codexHome, promptPath }) {
  const project = exactDirectory(projectDir, '--project-dir');
  const home = exactDirectory(codexHome, '--codex-home');
  if (typeof promptPath !== 'string' || !existsSync(promptPath)) {
    throw new LiveCertificationParentError('--prompt must name an existing file');
  }
  const prompt = readFileSync(promptPath, 'utf8');
  if (prompt.trim().length === 0) {
    throw new LiveCertificationParentError('--prompt must not be empty');
  }
  requireExactPromptProject(prompt, project);
  requireZeroRetryConfig(home);
  requireExactPlugin(home);
  return Object.freeze({
    command: 'codex',
    args: Object.freeze([
      'exec',
      '--dangerously-bypass-approvals-and-sandbox',
      '--dangerously-bypass-hook-trust',
      '--color',
      'never',
      '-C',
      project,
      '-',
    ]),
    cwd: project,
    env: Object.freeze({ CODEX_HOME: home }),
    input: prompt,
  });
}

function parseArgs(argv) {
  const values = {};
  let dryRun = false;
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === '--dry-run') {
      dryRun = true;
      continue;
    }
    if (!['--project-dir', '--codex-home', '--prompt'].includes(token) || !argv[index + 1]) {
      throw new LiveCertificationParentError(
        'usage: node scripts/run-live-certification-parent.mjs --project-dir <path> --codex-home <path> --prompt <file> [--dry-run]',
      );
    }
    values[token.slice(2).replaceAll('-', '')] = argv[index + 1];
    index += 1;
  }
  return {
    dryRun,
    projectDir: values.projectdir,
    codexHome: values.codexhome,
    promptPath: values.prompt,
  };
}

function invokedDirectly(argvPath) {
  if (!argvPath) return false;
  try {
    return realpathSync(argvPath) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (invokedDirectly(process.argv[1])) {
  try {
    const parsed = parseArgs(process.argv.slice(2));
    const invocation = buildCodexParentInvocation(parsed);
    if (parsed.dryRun) {
      process.stdout.write(`${JSON.stringify({
        command: invocation.command,
        args: invocation.args,
        cwd: invocation.cwd,
        codex_home: invocation.env.CODEX_HOME,
        prompt_bytes: Buffer.byteLength(invocation.input),
      })}\n`);
    } else {
      const result = spawnSync(invocation.command, invocation.args, {
        cwd: invocation.cwd,
        env: { ...process.env, ...invocation.env },
        input: invocation.input,
        stdio: ['pipe', 'inherit', 'inherit'],
      });
      if (result.error) throw result.error;
      process.exitCode = result.status ?? 1;
    }
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}
