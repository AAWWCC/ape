#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const LIVE_CERTIFICATION_NAME = 'APE Certification';
const LIVE_CERTIFICATION_EMAIL = 'ape-certification@users.noreply.github.com';

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

function effectiveGitIdentity(projectDir, variable) {
  let value;
  try {
    value = execFileSync('git', ['var', variable], {
      cwd: projectDir,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return null;
  }
  const match = value.match(/^(.+) <([^<>]+)> \d+ [+-]\d{4}$/u);
  return match ? { name: match[1], email: match[2] } : null;
}

export function verifyLiveCertificationEnvironment(projectDir = process.cwd()) {
  const root = resolve(projectDir);
  const name = localGitValue(root, 'user.name');
  const email = localGitValue(root, 'user.email');
  if (name !== LIVE_CERTIFICATION_NAME) {
    throw new LiveCertificationEnvironmentError(
      'disposable repository must set the exact APE Certification repository-local user.name before live certification',
    );
  }
  if (email.toLowerCase() !== LIVE_CERTIFICATION_EMAIL) {
    throw new LiveCertificationEnvironmentError(
      'disposable repository must set the exact APE Certification repository-local GitHub noreply user.email before live certification',
    );
  }
  for (const [variable, kind] of [
    ['GIT_AUTHOR_IDENT', 'author'],
    ['GIT_COMMITTER_IDENT', 'committer'],
  ]) {
    const identity = effectiveGitIdentity(root, variable);
    if (
      identity?.name !== LIVE_CERTIFICATION_NAME ||
      identity.email.toLowerCase() !== LIVE_CERTIFICATION_EMAIL
    ) {
      throw new LiveCertificationEnvironmentError(
        `live certification effective ${kind} identity must be the exact repository-local APE Certification service identity without a Git environment override`,
      );
    }
  }
  return Object.freeze({
    identity_scope: 'repository-local',
    identity: LIVE_CERTIFICATION_NAME,
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
      'live-certification environment passed: exact repository-local and effective service identity is set\n',
    );
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}
