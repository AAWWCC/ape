#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import { chmodSync, copyFileSync, mkdirSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const HOOK_NAMES = Object.freeze(['commit-msg', 'pre-push']);

class PublicHookInstallError extends Error {}

function git(projectDir, args, label) {
  try {
    return execFileSync('git', args, {
      cwd: projectDir,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    throw new PublicHookInstallError(`${label} failed`);
  }
}

function parseArgs(argv) {
  if (argv.length === 0) return process.cwd();
  if (argv.length === 2 && argv[0] === '--project-dir' && argv[1]) return argv[1];
  throw new PublicHookInstallError(
    'usage: node scripts/install-public-hooks.mjs [--project-dir <path>]',
  );
}

export function installPublicHooks(projectDir = process.cwd()) {
  const requested = realpathSync(projectDir);
  const root = realpathSync(git(requested, ['rev-parse', '--show-toplevel'], 'locate work tree'));
  const gitDir = realpathSync(git(root, [
    'rev-parse',
    '--path-format=absolute',
    '--git-common-dir',
  ], 'locate Git metadata'));
  const hooksDir = path.join(gitDir, 'ape-public-hooks');
  mkdirSync(hooksDir, { recursive: true, mode: 0o700 });
  for (const name of HOOK_NAMES) {
    const destination = path.join(hooksDir, name);
    copyFileSync(path.join(ROOT, '.githooks', name), destination);
    chmodSync(destination, 0o755);
  }

  const relativeHooksDir = path.relative(root, hooksDir);
  const configuredPath = relativeHooksDir !== '..' && !relativeHooksDir.startsWith(`..${path.sep}`)
    ? relativeHooksDir.split(path.sep).join('/')
    : hooksDir;
  git(root, ['config', '--local', 'core.hooksPath', configuredPath], 'configure public hooks');
  if (git(root, ['config', '--local', '--get', 'core.hooksPath'], 'verify public hooks') !== configuredPath) {
    throw new PublicHookInstallError('verify public hook configuration failed');
  }
  return Object.freeze({ hooksDir, configuredPath });
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
    installPublicHooks(parseArgs(process.argv.slice(2)));
    process.stdout.write('installed stable public commit hooks\n');
  } catch (error) {
    process.stderr.write(`install-public-hooks: ${error?.message ?? String(error)}\n`);
    process.exitCode = 1;
  }
}
