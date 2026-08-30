import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const CHECKER = path.join(ROOT, 'scripts', 'check-public-commit-identities.mjs');
const SAFE_NAME = 'AAWWCC';
const SAFE_EMAIL = '188276477+AAWWCC@users.noreply.github.com';
const PERSONAL_NAME = `${['Ai', 'dan'].join('')} Codex`;
const PERSONAL_LOGIN = ['ai', 'dan'].join('');
const PERSONAL_EMAIL = `${PERSONAL_LOGIN}@users.noreply.github.com`;
const CLAUDE_COAUTHOR_EMAIL = ['noreply', 'anthropic.com'].join('@');
const GITHUB_COMMITTER_EMAIL = ['noreply', 'github.com'].join('@');
const EXPORTER = path.join(ROOT, 'scripts', 'export-public-tree.mjs');
const HOOK_INSTALLER = path.join(ROOT, 'scripts', 'install-public-hooks.mjs');
const temporaryRepositories = [];

afterEach(() => {
  for (const repository of temporaryRepositories.splice(0)) {
    rmSync(repository, { recursive: true, force: true });
  }
});

function git(repository, ...args) {
  return execFileSync('git', args, {
    cwd: repository,
    encoding: 'utf8',
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: SAFE_NAME,
      GIT_AUTHOR_EMAIL: SAFE_EMAIL,
      GIT_COMMITTER_NAME: SAFE_NAME,
      GIT_COMMITTER_EMAIL: SAFE_EMAIL,
    },
  }).trim();
}

function repository() {
  const directory = mkdtempSync(path.join(tmpdir(), 'ape-public-identity-'));
  temporaryRepositories.push(directory);
  git(directory, 'init', '--initial-branch=main');
  git(directory, 'config', '--local', 'user.name', SAFE_NAME);
  git(directory, 'config', '--local', 'user.email', SAFE_EMAIL);
  git(directory, 'commit', '--allow-empty', '-m', 'initial public commit');
  return directory;
}

function commit(repositoryRoot, message, identity = {}) {
  execFileSync('git', ['commit', '--allow-empty', '-m', message], {
    cwd: repositoryRoot,
    encoding: 'utf8',
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: identity.authorName ?? SAFE_NAME,
      GIT_AUTHOR_EMAIL: identity.authorEmail ?? SAFE_EMAIL,
      GIT_COMMITTER_NAME: identity.committerName ?? SAFE_NAME,
      GIT_COMMITTER_EMAIL: identity.committerEmail ?? SAFE_EMAIL,
    },
  });
  return git(repositoryRoot, 'rev-parse', 'HEAD');
}

function check(repositoryRoot, args = [], input = undefined, env = {}) {
  return spawnSync(process.execPath, [CHECKER, ...args], {
    cwd: repositoryRoot,
    encoding: 'utf8',
    input,
    env: { ...process.env, ...env },
  });
}

describe('public commit identity gate', () => {
  it('keeps canonical-origin validation ahead of the versioned pre-push identity check', () => {
    const hookPath = path.join(ROOT, '.githooks', 'pre-push');
    const commitHookPath = path.join(ROOT, '.githooks', 'commit-msg');
    const hook = readFileSync(hookPath, 'utf8');
    const commitHook = readFileSync(commitHookPath, 'utf8');
    expect(hook).toContain('https://github.com/AAWWCC/ape.git');
    expect(hook).toContain('git@github.com:AAWWCC/ape.git');
    expect(hook).toContain('ssh://git@github.com/AAWWCC/ape.git');
    expect(hook.indexOf('case "${remote_url}"')).toBeLessThan(
      hook.indexOf('check-public-commit-identities.mjs --pre-push'),
    );
    expect(statSync(hookPath).mode & 0o111).not.toBe(0);
    expect(commitHook).toContain('check-public-commit-identities.mjs --commit-message "$1"');
    expect(statSync(commitHookPath).mode & 0o111).not.toBe(0);
  });

  it('installs stable wrappers that fail closed when old code lacks the checker', () => {
    const directory = repository();
    const installed = spawnSync(process.execPath, [
      HOOK_INSTALLER,
      '--project-dir',
      directory,
    ], { encoding: 'utf8' });
    expect(installed.status).toBe(0);
    const configured = git(directory, 'config', '--local', '--get', 'core.hooksPath');
    expect(configured).toBe('.git/ape-public-hooks');
    const hookPath = path.join(directory, configured, 'pre-push');
    expect(statSync(hookPath).mode & 0o111).not.toBe(0);

    const oid = git(directory, 'rev-parse', 'HEAD');
    const result = spawnSync(
      hookPath,
      ['origin', 'https://github.com/AAWWCC/ape.git'],
      {
        cwd: directory,
        encoding: 'utf8',
        input: `refs/heads/main ${oid} refs/heads/main ${oid}\n`,
      },
    );
    expect(result.status).not.toBe(0);
  });

  it('checks the exact PR source commit in CI and the annotated tag in release jobs', () => {
    const ci = readFileSync(path.join(ROOT, '.github', 'workflows', 'ci.yml'), 'utf8');
    const release = readFileSync(path.join(ROOT, '.github', 'workflows', 'release.yml'), 'utf8');
    expect(ci).toContain('APE_PUBLIC_IDENTITY_REVISION: ${{ github.event.pull_request.head.sha || github.sha }}');
    expect(ci).toContain('fetch-depth: 0');
    expect(release.match(/public:identity -- --rev "\$\{GITHUB_REF\}"/gu)).toHaveLength(2);
  });

  it('preserves approved service identities in the sanitized public export', () => {
    const directory = repository();
    commit(
      directory,
      `service identities\n\nCo-authored-by: Claude Opus 4.6 (1M context) <${CLAUDE_COAUTHOR_EMAIL}>`,
      { committerName: 'GitHub', committerEmail: GITHUB_COMMITTER_EMAIL },
    );
    const exportRoot = mkdtempSync(path.join(tmpdir(), 'ape-public-identity-export-'));
    temporaryRepositories.push(exportRoot);
    const exported = path.join(exportRoot, 'public');
    const exportResult = spawnSync(process.execPath, [
      EXPORTER,
      '--out',
      exported,
      '--allow-dirty',
    ], { cwd: ROOT, encoding: 'utf8' });
    expect(exportResult.status).toBe(0);

    const result = spawnSync(process.execPath, [
      path.join(exported, 'scripts', 'check-public-commit-identities.mjs'),
      '--project-dir',
      directory,
    ], { encoding: 'utf8' });
    expect(result.status).toBe(0);
  });

  it('rejects unsafe identities before a commit object is created', () => {
    const directory = repository();
    const messagePath = path.join(directory, 'commit-message.txt');
    writeFileSync(
      messagePath,
      `unsafe draft\n\nCo-authored-by: ${PERSONAL_NAME} <${PERSONAL_EMAIL}>\n`,
    );
    const result = check(directory, ['--commit-message', messagePath], undefined, {
      GIT_AUTHOR_NAME: PERSONAL_NAME,
      GIT_AUTHOR_EMAIL: PERSONAL_EMAIL,
      GIT_COMMITTER_NAME: PERSONAL_NAME,
      GIT_COMMITTER_EMAIL: PERSONAL_EMAIL,
    });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('unapproved author identity');
    expect(result.stderr).toContain('unapproved committer identity');
    expect(result.stderr).toContain('unapproved co-author identity');
    expect(result.stderr).not.toContain(PERSONAL_EMAIL);
  });

  it('does not echo a malformed effective Git identity', () => {
    const directory = repository();
    const messagePath = path.join(directory, 'commit-message.txt');
    const privateEmail = 'private.person@example.com';
    writeFileSync(messagePath, 'malformed identity fixture\n');
    const result = check(directory, ['--commit-message', messagePath], undefined, {
      GIT_AUTHOR_NAME: '',
      GIT_AUTHOR_EMAIL: privateEmail,
    });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('read author identity failed');
    expect(result.stderr).not.toContain(privateEmail);
  });

  it('accepts the closed public author, committer, co-author, signer, and tagger set', () => {
    const directory = repository();
    commit(directory, [
      'allowed public attribution',
      '',
      'Co-authored-by: APE Release <ape-release@users.noreply.github.com>',
      `Co-authored-by: Claude Opus 4.6 (1M context) <${CLAUDE_COAUTHOR_EMAIL}>`,
      `Signed-off-by: ${SAFE_NAME} <${SAFE_EMAIL}>`,
    ].join('\n'));
    git(directory, 'tag', '-a', 'v1.0.0', '-m', 'allowed public tag');

    const result = check(directory, ['--rev', 'v1.0.0']);
    expect(result.status).toBe(0);
    expect(result.stdout).toMatch(/public commit identities passed: 2 commit\(s\)/u);
  });

  it('rejects unapproved author and committer identities without echoing them', () => {
    const directory = repository();
    commit(directory, 'unapproved author', {
      authorName: PERSONAL_NAME,
      authorEmail: PERSONAL_EMAIL,
      committerName: PERSONAL_NAME,
      committerEmail: PERSONAL_EMAIL,
    });

    const result = check(directory);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('unapproved author identity');
    expect(result.stderr).toContain('unapproved committer identity');
    expect(result.stderr).not.toContain(PERSONAL_NAME);
    expect(result.stderr).not.toContain(PERSONAL_EMAIL);
  });

  it('rejects duplicate raw commit identities instead of trusting Git normalization', () => {
    const directory = repository();
    const parent = git(directory, 'rev-parse', 'HEAD');
    const tree = git(directory, 'rev-parse', 'HEAD^{tree}');
    const rawCommit = [
      `tree ${tree}`,
      `parent ${parent}`,
      `author ${SAFE_NAME} <${SAFE_EMAIL}> 1700000000 +0000`,
      `author ${PERSONAL_NAME} <${PERSONAL_EMAIL}> 1700000000 +0000`,
      `committer ${SAFE_NAME} <${SAFE_EMAIL}> 1700000000 +0000`,
      '',
      'duplicate author fixture',
      '',
    ].join('\n');
    const written = spawnSync(
      'git',
      ['hash-object', '--literally', '-t', 'commit', '-w', '--stdin'],
      {
      cwd: directory,
      encoding: 'utf8',
      input: rawCommit,
      },
    );
    expect(written.status).toBe(0);

    const result = check(directory, ['--rev', written.stdout.trim()]);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('commit must contain exactly one author identity');
    expect(result.stderr).toContain('unapproved author identity');
    expect(result.stderr).not.toContain(PERSONAL_EMAIL);
  });

  it('rejects unapproved and malformed attribution trailers', () => {
    const directory = repository();
    commit(directory, [
      'unsafe trailers',
      '',
      `Co-authored-by: ${PERSONAL_NAME} <${PERSONAL_EMAIL}>`,
      `Signed-off-by: ${PERSONAL_NAME}`,
    ].join('\n'));

    const result = check(directory);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('unapproved co-author identity');
    expect(result.stderr).toContain('malformed public attribution trailer');
    expect(result.stderr).not.toContain(PERSONAL_EMAIL);
  });

  it('scans complete ancestry instead of checking HEAD alone', () => {
    const directory = repository();
    commit(directory, `unsafe ancestor\n\nCo-authored-by: ${PERSONAL_NAME} <${PERSONAL_EMAIL}>`);
    commit(directory, 'safe descendant');

    const result = check(directory);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('unapproved co-author identity');
  });

  it('checks the exact branch and tag objects supplied by pre-push', () => {
    const directory = repository();
    git(directory, 'checkout', '--orphan', 'legacy');
    commit(directory, `unsafe tagged history\n\nCo-authored-by: ${PERSONAL_NAME} <${PERSONAL_EMAIL}>`);
    git(directory, 'tag', '-a', 'v0.9.0', '-m', 'legacy public tag');
    const tagOid = git(directory, 'rev-parse', 'refs/tags/v0.9.0');
    git(directory, 'checkout', 'main');

    expect(check(directory).status).toBe(0);
    const update = `refs/tags/v0.9.0 ${tagOid} refs/tags/v0.9.0 ${'0'.repeat(40)}\n`;
    const result = check(directory, ['--pre-push'], update);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('unapproved co-author identity');
  });

  it('validates every annotated tag object in a nested tag chain', () => {
    const directory = repository();
    execFileSync('git', ['tag', '-a', 'v1.0.0', '-m', 'unsafe inner tag'], {
      cwd: directory,
      encoding: 'utf8',
      env: {
        ...process.env,
        GIT_COMMITTER_NAME: PERSONAL_NAME,
        GIT_COMMITTER_EMAIL: PERSONAL_EMAIL,
      },
    });
    const innerTag = git(directory, 'rev-parse', 'refs/tags/v1.0.0');
    git(directory, 'config', 'advice.nestedTag', 'false');
    git(directory, 'tag', '-a', 'v1.0.0-envelope', innerTag, '-m', 'safe outer tag');

    const result = check(directory, ['--rev', 'v1.0.0-envelope']);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('unapproved tagger identity');
    expect(result.stderr).not.toContain(PERSONAL_EMAIL);
  });

  it('rejects duplicate taggers even when the first tagger is approved', () => {
    const directory = repository();
    const target = git(directory, 'rev-parse', 'HEAD');
    const rawTag = [
      `object ${target}`,
      'type commit',
      'tag v1.0.0-duplicate-tagger',
      `tagger ${SAFE_NAME} <${SAFE_EMAIL}> 1700000000 +0000`,
      `tagger ${PERSONAL_NAME} <${PERSONAL_EMAIL}> 1700000000 +0000`,
      '',
      'duplicate tagger fixture',
      '',
    ].join('\n');
    const written = spawnSync('git', ['hash-object', '-t', 'tag', '-w', '--stdin'], {
      cwd: directory,
      encoding: 'utf8',
      input: rawTag,
    });
    expect(written.status).toBe(0);

    const result = check(directory, ['--rev', written.stdout.trim()]);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('tag must contain exactly one tagger identity');
    expect(result.stderr).toContain('unapproved tagger identity');
    expect(result.stderr).not.toContain(PERSONAL_EMAIL);
  });

  it('fails closed in a shallow clone so CI cannot inspect a partial ancestry', () => {
    const source = repository();
    commit(source, 'second safe commit');
    const shallow = mkdtempSync(path.join(tmpdir(), 'ape-public-identity-shallow-'));
    temporaryRepositories.push(shallow);
    execFileSync('git', ['clone', '--depth', '1', `file://${source}`, shallow], {
      encoding: 'utf8',
    });

    const result = check(shallow);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('requires complete Git history');
  });
});
