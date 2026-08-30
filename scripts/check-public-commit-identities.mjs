#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import { readFileSync, realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ZERO_OID = /^0+$/u;
const COMMIT_OID = /^[0-9a-f]{40}$/u;
const TRAILER_HEAD = /^(co-authored-by|signed-off-by)\s*:/iu;
const TRAILER_IDENTITY = /^(co-authored-by|signed-off-by)\s*:\s*(.+?)\s*<([^<>]+)>\s*$/iu;
const EXISTING_ACCOUNT_DISPLAY_NAME = ['Ai', 'dan'].join('');
const CLAUDE_COAUTHOR_EMAIL = ['noreply', 'anthropic.com'].join('@');
const GITHUB_COMMITTER_EMAIL = ['noreply', 'github.com'].join('@');

function identityKey(name, email) {
  return `${name}\0${email.toLowerCase()}`;
}

// Public attribution is closed by default. Adding an identity is a reviewed
// repository-policy change, never an ambient consequence of local Git config
// or a model-authored commit trailer.
const ALLOWED = Object.freeze({
  author: new Set([
    identityKey('AAWWCC', '188276477+AAWWCC@users.noreply.github.com'),
    // Existing GitHub-authored commits use the account's display name while
    // retaining AAWWCC's account-bound noreply address.
    identityKey(EXISTING_ACCOUNT_DISPLAY_NAME, '188276477+AAWWCC@users.noreply.github.com'),
  ]),
  committer: new Set([
    identityKey('AAWWCC', '188276477+AAWWCC@users.noreply.github.com'),
    identityKey('GitHub', GITHUB_COMMITTER_EMAIL),
  ]),
  tagger: new Set([
    identityKey('AAWWCC', '188276477+AAWWCC@users.noreply.github.com'),
    identityKey('AAWWCC', 'AAWWCC@users.noreply.github.com'),
    identityKey(EXISTING_ACCOUNT_DISPLAY_NAME, '188276477+AAWWCC@users.noreply.github.com'),
  ]),
  'co-authored-by': new Set([
    identityKey('AAWWCC', 'AAWWCC@users.noreply.github.com'),
    identityKey('APE Certification', 'ape-certification@users.noreply.github.com'),
    identityKey('APE Release', 'ape-release@users.noreply.github.com'),
    identityKey('Claude Opus 4.6 (1M context)', CLAUDE_COAUTHOR_EMAIL),
  ]),
  'signed-off-by': new Set([
    identityKey('AAWWCC', '188276477+AAWWCC@users.noreply.github.com'),
    identityKey('AAWWCC', 'AAWWCC@users.noreply.github.com'),
  ]),
});

export class PublicCommitIdentityError extends Error {
  constructor(message) {
    super(message);
    this.name = 'PublicCommitIdentityError';
  }
}

function usage() {
  return [
    'usage: node scripts/check-public-commit-identities.mjs',
    '  [--project-dir <path>] [--rev <revision>]...',
    '  [--commit-message <path> | --pre-push | --all-public-refs]',
    '',
  ].join('\n');
}

function git(projectDir, args, label) {
  try {
    return execFileSync('git', args, {
      cwd: projectDir,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      maxBuffer: 64 * 1024 * 1024,
      env: { ...process.env, GIT_NO_REPLACE_OBJECTS: '1' },
    }).trimEnd();
  } catch {
    throw new PublicCommitIdentityError(`${label} failed`);
  }
}

function parseArgs(argv) {
  let projectDir = process.cwd();
  let prePush = false;
  let allPublicRefs = false;
  let commitMessage = null;
  const revisions = [];
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === '--pre-push') {
      prePush = true;
      continue;
    }
    if (flag === '--all-public-refs') {
      allPublicRefs = true;
      continue;
    }
    if (flag === '--project-dir' || flag === '--rev' || flag === '--commit-message') {
      const value = argv[index + 1];
      if (!value || value.startsWith('--')) {
        throw new PublicCommitIdentityError(`${flag} requires a value`);
      }
      if (flag === '--project-dir') projectDir = resolve(value);
      else if (flag === '--commit-message') commitMessage = resolve(value);
      else revisions.push(value);
      index += 1;
      continue;
    }
    throw new PublicCommitIdentityError(`unknown argument: ${flag}`);
  }
  const modes = Number(prePush) + Number(allPublicRefs) + Number(commitMessage !== null) +
    Number(revisions.length > 0);
  if (modes > 1) {
    throw new PublicCommitIdentityError(
      '--commit-message, --pre-push, --all-public-refs, and explicit --rev values are mutually exclusive',
    );
  }
  return { projectDir, prePush, allPublicRefs, commitMessage, revisions };
}

function ensureCompleteRepository(projectDir) {
  const inside = git(projectDir, ['rev-parse', '--is-inside-work-tree'], 'locate Git repository');
  if (inside !== 'true') throw new PublicCommitIdentityError('project is not a Git work tree');
  const shallow = git(
    projectDir,
    ['rev-parse', '--is-shallow-repository'],
    'inspect repository history depth',
  );
  if (shallow !== 'false') {
    throw new PublicCommitIdentityError(
      'public commit identity inspection requires complete Git history (fetch with depth 0)',
    );
  }
}

function findingLabel(kind) {
  if (kind === 'co-authored-by') return 'co-author';
  if (kind === 'signed-off-by') return 'sign-off';
  return kind;
}

function validateIdentity(findings, context, kind, name, email) {
  const allowed = ALLOWED[kind];
  if (!allowed?.has(identityKey(name, email))) {
    findings.push(`${context}: unapproved ${findingLabel(kind)} identity`);
  }
}

function validateTrailers(findings, context, message) {
  for (const line of message.split(/\r?\n/u)) {
    if (!TRAILER_HEAD.test(line)) continue;
    const match = line.match(TRAILER_IDENTITY);
    if (!match) {
      findings.push(`${context}: malformed public attribution trailer`);
      continue;
    }
    const kind = match[1].toLowerCase();
    validateIdentity(findings, context, kind, match[2].trim(), match[3].trim());
  }
}

function validateGitIdentityValue(findings, projectDir, variable, kind) {
  const value = git(projectDir, ['var', variable], `read ${kind} identity`);
  const match = value.match(/^(.+) <([^<>]+)> \d+ [+-]\d{4}$/u);
  if (!match) findings.push(`new commit: missing or malformed ${kind} identity`);
  else validateIdentity(findings, 'new commit', kind, match[1], match[2]);
}

function inspectCommitDraft(projectDir, messagePath) {
  const findings = [];
  validateGitIdentityValue(findings, projectDir, 'GIT_AUTHOR_IDENT', 'author');
  validateGitIdentityValue(findings, projectDir, 'GIT_COMMITTER_IDENT', 'committer');
  let message;
  try {
    message = readFileSync(messagePath, 'utf8');
  } catch {
    throw new PublicCommitIdentityError('read pending commit message failed');
  }
  validateTrailers(findings, 'new commit', message);
  return { findings, commits: 1, refs: 0 };
}

function resolveObject(projectDir, revision) {
  const oid = git(
    projectDir,
    ['rev-parse', '--verify', `${revision}^{object}`],
    'resolve revision',
  );
  const type = git(projectDir, ['cat-file', '-t', oid], 'inspect revision');
  return { oid, type };
}

function validateTag(findings, projectDir, oid) {
  const raw = git(projectDir, ['cat-file', '-p', oid], `read tag ${oid.slice(0, 12)}`);
  const separator = raw.indexOf('\n\n');
  const headers = separator === -1 ? raw : raw.slice(0, separator);
  const message = separator === -1 ? '' : raw.slice(separator + 2);
  const headerLines = headers.split('\n');
  const objectLines = headerLines.filter((line) => line.startsWith('object '));
  const target = objectLines.length === 1
    ? objectLines[0].match(/^object ([0-9a-f]{40,64})$/u)?.[1] ?? null
    : null;
  const taggerLines = headerLines.filter((line) => line.startsWith('tagger '));
  const context = `tag ${oid.slice(0, 12)}`;
  if (!target) findings.push(`${context}: missing or malformed target object`);
  if (taggerLines.length !== 1) {
    findings.push(`${context}: tag must contain exactly one tagger identity`);
  }
  for (const taggerLine of taggerLines) {
    const tagger = taggerLine.match(/^tagger (.+) <([^<>]+)> \d+ [+-]\d{4}$/u);
    if (!tagger) findings.push(`${context}: malformed tagger identity`);
    else validateIdentity(findings, context, 'tagger', tagger[1], tagger[2]);
  }
  validateTrailers(findings, context, message);
  return target;
}

function validateCommit(findings, projectDir, oid) {
  const raw = git(projectDir, ['cat-file', '-p', oid], `read commit ${oid.slice(0, 12)}`);
  const separator = raw.indexOf('\n\n');
  const headers = separator === -1 ? raw : raw.slice(0, separator);
  const message = separator === -1 ? '' : raw.slice(separator + 2);
  const headerLines = headers.split('\n');
  const context = `commit ${oid.slice(0, 12)}`;
  for (const kind of ['author', 'committer']) {
    const lines = headerLines.filter((line) => line.startsWith(`${kind} `));
    if (lines.length !== 1) {
      findings.push(`${context}: commit must contain exactly one ${kind} identity`);
    }
    for (const line of lines) {
      const identity = line.match(new RegExp(
        `^${kind} (.+) <([^<>]+)> \\d+ [+-]\\d{4}$`,
        'u',
      ));
      if (!identity) findings.push(`${context}: malformed ${kind} identity`);
      else validateIdentity(findings, context, kind, identity[1], identity[2]);
    }
  }
  validateTrailers(findings, context, message);
}

function revisionsFromPublicRefs(projectDir) {
  const output = git(projectDir, [
    'for-each-ref',
    '--format=%(refname)',
    'refs/heads',
    'refs/remotes/origin',
    'refs/tags',
  ], 'enumerate public refs');
  return output.split('\n').filter((value) => value && value !== 'refs/remotes/origin/HEAD');
}

function revisionsFromPrePushInput() {
  const input = readFileSync(0, 'utf8');
  const revisions = [];
  for (const [index, line] of input.split(/\r?\n/u).entries()) {
    if (!line.trim()) continue;
    const fields = line.trim().split(/\s+/u);
    if (fields.length !== 4) {
      throw new PublicCommitIdentityError(`malformed pre-push update at line ${index + 1}`);
    }
    const [, localOid] = fields;
    if (!ZERO_OID.test(localOid)) revisions.push(localOid);
  }
  return revisions;
}

function defaultRevisions() {
  const revision = process.env.APE_PUBLIC_IDENTITY_REVISION;
  if (revision === undefined || revision === '') return ['HEAD'];
  if (!COMMIT_OID.test(revision)) {
    throw new PublicCommitIdentityError(
      'APE_PUBLIC_IDENTITY_REVISION must be one full lowercase commit hash',
    );
  }
  return [revision];
}

function inspectRevisions(projectDir, revisions) {
  const findings = [];
  const commitRevisions = [];
  const seenObjects = new Set();
  for (const revision of revisions) {
    let object = resolveObject(projectDir, revision);
    while (object.type === 'tag') {
      if (seenObjects.has(object.oid)) break;
      seenObjects.add(object.oid);
      const target = validateTag(findings, projectDir, object.oid);
      if (!target) break;
      const type = git(projectDir, ['cat-file', '-t', target], 'inspect tag target');
      object = { oid: target, type };
    }
    if (seenObjects.has(object.oid)) continue;
    seenObjects.add(object.oid);
    if (object.type === 'commit') {
      commitRevisions.push(object.oid);
    } else if (object.type !== 'tag') {
      findings.push(`ref ${object.oid.slice(0, 12)}: public ref target must resolve to a commit`);
    }
  }
  if (commitRevisions.length === 0) return { findings, commits: 0, refs: revisions.length };

  const output = git(
    projectDir,
    ['rev-list', ...commitRevisions, '--'],
    'enumerate public commits',
  );
  const commits = output.split('\n').filter(Boolean);
  for (const oid of commits) validateCommit(findings, projectDir, oid);
  return { findings, commits: commits.length, refs: revisions.length };
}

export function verifyPublicCommitIdentities({
  projectDir = process.cwd(),
  revisions = ['HEAD'],
} = {}) {
  ensureCompleteRepository(projectDir);
  const result = inspectRevisions(projectDir, revisions);
  if (result.findings.length > 0) {
    throw new PublicCommitIdentityError(
      `public commit identity gate failed with ${result.findings.length} finding(s):\n` +
      result.findings.map((finding) => `- ${finding}`).join('\n'),
    );
  }
  return Object.freeze({ commits: result.commits, refs: result.refs });
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
    const args = parseArgs(process.argv.slice(2));
    let result;
    if (args.commitMessage !== null) {
      result = inspectCommitDraft(args.projectDir, args.commitMessage);
    } else {
      ensureCompleteRepository(args.projectDir);
      const revisions = args.prePush
        ? revisionsFromPrePushInput()
        : args.allPublicRefs
          ? revisionsFromPublicRefs(args.projectDir)
          : args.revisions.length > 0
            ? args.revisions
            : defaultRevisions();
      result = inspectRevisions(args.projectDir, revisions);
    }
    if (result.findings.length > 0) {
      throw new PublicCommitIdentityError(
        `public commit identity gate failed with ${result.findings.length} finding(s):\n` +
        result.findings.map((finding) => `- ${finding}`).join('\n'),
      );
    }
    process.stdout.write(
      `public commit identities passed: ${result.commits} commit(s) across ${result.refs} ref(s)\n`,
    );
  } catch (error) {
    if (
      error instanceof PublicCommitIdentityError &&
      /unknown argument|requires a value|mutually exclusive/u.test(error.message)
    ) process.stderr.write(usage());
    process.stderr.write(`check-public-commit-identities: ${error?.message ?? String(error)}\n`);
    process.exitCode = 1;
  }
}
