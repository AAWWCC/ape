#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const GITHUB_NOREPLY = /^[A-Za-z0-9][A-Za-z0-9.+_-]*@users\.noreply\.github\.com$/iu;
const SAFE_NAME = /^[^\u0000-\u001f\u007f]+$/u;

export class LiveCertificationEnvironmentError extends Error {
  constructor(message) {
    super(message);
    this.name = 'LiveCertificationEnvironmentError';
  }
}

function localGitValue(projectDir, key) {
  try {
    return execFileSync('git', ['config', '--local', '--get', key], {
      cwd: projectDir,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return '';
  }
}

export function verifyLiveCertificationEnvironment(projectDir = process.cwd()) {
  const root = resolve(projectDir);
  const name = localGitValue(root, 'user.name');
  const email = localGitValue(root, 'user.email');
  if (!name || !SAFE_NAME.test(name)) {
    throw new LiveCertificationEnvironmentError(
      'disposable repository must set a safe repository-local user.name before live certification',
    );
  }
  if (!GITHUB_NOREPLY.test(email)) {
    throw new LiveCertificationEnvironmentError(
      'disposable repository must set a repository-local GitHub noreply user.email before live certification',
    );
  }
  return Object.freeze({
    identity_scope: 'repository-local',
    email_domain: 'users.noreply.github.com',
  });
}

function parseArgs(argv) {
  if (argv.length === 0) return process.cwd();
  if (argv.length === 2 && argv[0] === '--project-dir' && argv[1]) return argv[1];
  throw new LiveCertificationEnvironmentError(
    'usage: node scripts/check-live-certification-environment.mjs [--project-dir <path>]',
  );
}

function invokedDirectly(argvPath) {
  if (!argvPath) return false;
  try {
    return realpathSync(resolve(argvPath)) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (invokedDirectly(process.argv[1])) {
  try {
    verifyLiveCertificationEnvironment(parseArgs(process.argv.slice(2)));
    process.stdout.write(
      'live-certification environment passed: repository-local GitHub noreply identity is set\n',
    );
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}
