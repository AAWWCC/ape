import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { gitEvidenceArgsSafe, parseEvidenceCommand } from '../lib/runtime/evidence-policy.js';
import { evaluateLifecyclePolicy, normalizeLifecycleEvent } from '../lib/runtime/lifecycle-policy.js';

// Only synthetic repositories and pure policy calls; no host hooks or active
// APE state. A real Git process establishes the option semantics independently
// of the policy implementation, including the branch-creation counterexamples.
const repositories = [];
afterEach(() => {
  for (const directory of repositories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function git(directory, args) {
  return spawnSync('git', args, {
    cwd: directory,
    encoding: 'utf8',
    env: {
      ...Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith('GIT_'))),
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_PAGER: 'cat',
      GIT_TERMINAL_PROMPT: '0',
    },
  });
}

function repository() {
  const directory = realpathSync(mkdtempSync(path.join(tmpdir(), 'ape-git-inspection-')));
  repositories.push(directory);
  for (const args of [
    ['init', '-b', 'main'],
    ['config', 'user.name', 'Synthetic Fixture'],
    ['config', 'user.email', 'synthetic@example.invalid'],
    ['config', 'commit.gpgsign', 'false'],
    // Fixture commits must not leave detached maintenance racing metadata snapshots.
    ['config', 'maintenance.auto', 'false'],
  ]) expect(git(directory, args).status).toBe(0);
  writeFileSync(path.join(directory, 'fixture.txt'), 'first\n');
  expect(git(directory, ['add', 'fixture.txt']).status).toBe(0);
  expect(git(directory, ['commit', '-m', 'first fixture']).status).toBe(0);
  expect(git(directory, ['branch', 'feature/topic']).status).toBe(0);
  writeFileSync(path.join(directory, 'fixture.txt'), 'second\n');
  expect(git(directory, ['commit', '-am', 'second fixture']).status).toBe(0);
  return directory;
}

function metadata(directory, root = '.git') {
  const result = {};
  function walk(relative) {
    const absolute = path.join(directory, relative);
    const stat = statSync(absolute);
    result[relative] = {
      mode: stat.mode, mtimeMs: stat.mtimeMs, ctimeMs: stat.ctimeMs,
      ...(stat.isFile() ? { sha256: createHash('sha256').update(readFileSync(absolute)).digest('hex') } : {}),
    };
    if (stat.isDirectory()) {
      for (const entry of readdirSync(absolute).sort()) walk(path.join(relative, entry));
    }
  }
  walk(root);
  return result;
}

function decision(command, projectDir, writable = false) {
  const event = normalizeLifecycleEvent({
    hook_event_name: 'PreToolUse', tool_name: 'Bash',
    agent_id: 'synthetic-git-reader', cwd: projectDir, tool_input: { command },
  }, {});
  return evaluateLifecyclePolicy({
    ...event, host: 'claude', is_subagent: true, ape_managed: true, project_dir: projectDir,
  }, {
    state: { status: 'running' },
    ticket: {
      ticket_id: 'synthetic:git-read', role: writable ? 'implementer' : 'reviewer',
      writable, claimed_paths: ['src'], test_paths: ['tests'],
    },
  }).decision;
}

describe('Git branch inspection parses option values and listing modes', () => {
  it('allows real listing/filter/format commands while preserving all Git metadata', () => {
    const directory = repository();
    const before = metadata(directory);
    for (const command of [
      'git branch', 'git branch -avv', 'git branch --show-current',
      'git branch --contains HEAD', 'git branch --contains=HEAD', 'git branch --contains',
      'git branch --no-contains HEAD', 'git branch --no-contains=HEAD',
      'git branch --merged HEAD', 'git branch --merged=HEAD', 'git branch --merged',
      'git branch --no-merged HEAD~1', 'git branch --no-merged=HEAD~1',
      'git branch --points-at HEAD', 'git branch --points-at=refs/heads/main',
      'git branch --list main', 'git branch -l main', 'git branch -al main',
      "git branch --list 'feature/*'", 'git branch --contains HEAD main',
      'git branch --list main --sort=-refname',
      'git branch --sort refname', 'git branch --sort -refname',
      "git branch --format '%(refname:short)'",
      "git branch '--format=%(refname:short) %(objectname:short)'",
      "git branch --list main --format '%(refname:short) %(subject)'",
      "git branch --format '--delete'", 'git branch --format --output=result.txt',
      'git branch --list -- main --delete --output=result.txt',
      'git branch --show-current -- newbranch',
      'git branch --color=never --column=never --abbrev=10 --no-verbose',
      'git branch --list --no-list', 'git branch --no-list --list main',
      'git branch --points-at HEAD --no-points-at --list main',
      'git branch --contains HEAD --list --no-list main',
      'git branch --show-current --no-show-current --list main',
    ]) {
      const parsed = parseEvidenceCommand(command);
      expect(parsed, command).not.toBeNull();
      expect(gitEvidenceArgsSafe(parsed.tokens), command).toBe(true);
      for (const writable of [false, true]) {
        expect(decision(command, directory, writable), command).toBe('allow');
      }
      const actual = git(directory, parsed.tokens.slice(1));
      expect(actual.status, `${command}: ${actual.stderr}`).toBe(0);
      expect(metadata(directory), command).toEqual(before);
    }
  });

  it('requires listing mode for positionals left after option values are consumed', () => {
    for (const command of [
      'git branch newbranch', 'git branch -- newbranch',
      'git branch --sort refname newbranch', 'git branch --sort=refname newbranch',
      "git branch --format '%(refname:short)' newbranch", 'git branch --format=x newbranch',
      'git branch --list --no-list newbranch',
      'git branch --points-at HEAD --no-points-at newbranch',
      'git branch --show-current --no-show-current newbranch',
      'git branch --format --list newbranch',
      'git branch --sort --list newbranch',
      'git branch --color never', 'git branch --column always', 'git branch --abbrev 10',
    ]) {
      const parsed = parseEvidenceCommand(command);
      expect(gitEvidenceArgsSafe(parsed.tokens), command).toBe(false);
      expect(decision(command, '/synthetic/project'), command).toBe('deny');
    }
  });

  it('rejects mutations, abbreviated/unknown options, and mixed mutating short groups', () => {
    for (const tail of [
      '-d feature/topic', '-D feature/topic', '-dr origin/main', '-f newbranch',
      '-m main renamed', '-M renamed', '-c main copied', '-C copied',
      '-vuorigin/main', '-t newbranch', '--track=direct newbranch',
      '--set-upstream-to=feature/topic', '--unset-upstream',
      '--edit-description', '--create-reflog newbranch', '--recurse-submodules newbranch',
      '--list --delete feature/topic', '--list --force newbranch',
      '--contains HEAD --delete feature/topic', '--merged HEAD -D feature/topic',
      '--points-at HEAD --move main renamed',
      '--del feature/topic', '--set-up=feature/topic', '--future-option main',
      '--list=main', '--sort', '--format', '--points-at',
    ]) {
      const command = `git branch ${tail}`;
      const parsed = parseEvidenceCommand(command);
      expect(gitEvidenceArgsSafe(parsed.tokens), command).toBe(false);
      expect(decision(command, '/synthetic/project', true), command).toBe('deny');
    }
  });

  it('proves dangerous mode/value lookalikes really create branches in isolated repositories', () => {
    const directory = repository();
    const cases = [
      ['--list', '--no-list', 'created-from-reset'],
      ['--points-at', 'HEAD', '--no-points-at', 'created-from-filter-reset'],
      ['--show-current', '--no-show-current', 'created-from-current-reset'],
      ['--format=unused', 'created-from-format'],
      ['--sort', 'refname', 'created-from-sort'],
      ['--format', '--list', 'created-from-consumed-list'],
      ['--color', 'never'],
      ['--column', 'always'],
      ['--abbrev', '10'],
    ];
    for (const args of cases) {
      expect(gitEvidenceArgsSafe(['git', 'branch', ...args]), args.join(' ')).toBe(false);
      const before = metadata(directory);
      const actual = git(directory, ['branch', ...args]);
      expect(actual.status, actual.stderr).toBe(0);
      expect(metadata(directory), args.join(' ')).not.toEqual(before);
      expect(git(directory, ['show-ref', '--verify', '--quiet', `refs/heads/${args.at(-1)}`]).status).toBe(0);
    }
  });
});

describe('Git path separators and ls-files short groups preserve inspection effects', () => {
  it('reads output-shaped paths and grouped file listings without changing repository files or metadata', () => {
    const directory = repository();
    for (const name of ['--output=result.txt', '-oresult.txt']) {
      writeFileSync(path.join(directory, name), 'tracked inspection fixture\n');
    }
    writeFileSync(path.join(directory, '.gitignore'), 'ignored.txt\n');
    expect(git(directory, ['add', '--', '--output=result.txt', '-oresult.txt', '.gitignore']).status).toBe(0);
    expect(git(directory, ['commit', '-m', 'output-shaped path fixtures']).status).toBe(0);
    writeFileSync(path.join(directory, '--output=result.txt'), 'changed inspection fixture\n');
    writeFileSync(path.join(directory, 'ignored.txt'), 'ignored fixture\n');
    writeFileSync(path.join(directory, 'untracked.txt'), 'untracked fixture\n');
    const before = metadata(directory, '.');
    for (const command of [
      'git diff -- --output=result.txt',
      'git diff --stat -- --output=result.txt -oresult.txt',
      'git diff HEAD -- --output=result.txt',
      'git log --oneline -- --output=result.txt',
      'git show HEAD -- --output=result.txt',
      'git ls-files -- --output=result.txt -oresult.txt',
      'git ls-files -oi --exclude-standard',
      'git ls-files -oz --exclude-standard',
      'git ls-files -otz --exclude-standard',
      'git ls-files -ov --exclude-standard',
      'git ls-files -of --exclude-standard',
      'git ls-files -ocdmsku --exclude-standard',
      'git ls-files -oxignored.txt',
      'git ls-files -ox--output=result.txt',
      'git ls-files -oX .gitignore',
      'git ls-files -oX.gitignore',
    ]) {
      const parsed = parseEvidenceCommand(command);
      expect(gitEvidenceArgsSafe(parsed.tokens), command).toBe(true);
      for (const writable of [false, true]) {
        expect(decision(command, directory, writable), command).toBe('allow');
      }
      const actual = git(directory, parsed.tokens.slice(1));
      expect(actual.status, `${command}: ${actual.stderr}`).toBe(0);
      expect(metadata(directory, '.'), command).toEqual(before);
      if (command === 'git ls-files -oi --exclude-standard') expect(actual.stdout).toBe('ignored.txt\n');
      if (command === 'git ls-files -oz --exclude-standard') expect(actual.stdout).toBe('untracked.txt\0');
      if (command === 'git diff -- --output=result.txt') expect(actual.stdout).toContain('+changed inspection fixture');
    }
  });

  it('still denies real output options before the separator and unknown ls-files short groups', () => {
    for (const command of [
      'git diff --output=result.txt -- fixture.txt',
      'git diff --output result.txt -- fixture.txt',
      'git log --format --output=result.txt',
      'git log --format --output=result.txt -- fixture.txt',
      'git log -L -- --output=result.txt', 'git show -L -- --output=result.txt',
      'git log --future-value-option -- --output=result.txt',
      'git diff --src-prefix -- --output=result.txt',
      'git diff -oresult.txt -- fixture.txt',
      'git ls-files -oresult.txt', 'git ls-files -oir',
      'git ls-files --output=result.txt -- fixture.txt',
    ]) {
      const parsed = parseEvidenceCommand(command);
      expect(gitEvidenceArgsSafe(parsed.tokens), command).toBe(false);
      expect(decision(command, '/synthetic/project', true), command).toBe('deny');
    }
  });

  it('proves output before -- and an invalid log format can write before Git exits', () => {
    const directory = repository();
    for (const args of [
      ['diff', '--output=output-before-separator.txt', '--', 'fixture.txt'],
      ['log', '--format', '--output=output-before-format-error.txt'],
      ['log', '-L', '--', '--output=output-before-line-range-error.txt'],
      ['show', '-L', '--', '--output=output-before-show-line-range-error.txt'],
    ]) {
      expect(gitEvidenceArgsSafe(['git', ...args])).toBe(false);
      const before = metadata(directory, '.');
      const actual = git(directory, args);
      expect(actual.status).toBe(args[0] === 'diff' ? 0 : 128);
      expect(metadata(directory, '.')).not.toEqual(before);
      const output = args.find((arg) => arg.startsWith('--output=')).slice('--output='.length);
      expect(statSync(path.join(directory, output)).isFile()).toBe(true);
    }
  });

  it('verifies diff/log/show stop before a later output option when -- follows a value-taking option', () => {
    const directory = repository();
    const before = metadata(directory, '.');
    for (const [verb, option] of [
      ['diff', '-S'], ['diff', '-O'], ['diff', '--src-prefix'],
      ['diff', '--line-prefix'], ['diff', '--word-diff-regex'],
      ['log', '--grep'], ['log', '--author'], ['log', '--format'], ['show', '--format'],
    ]) {
      const args = [verb, option, '--', '--output=must-not-exist.txt'];
      const actual = git(directory, args);
      expect(actual.status, args.join(' ')).not.toBe(0);
      expect(metadata(directory, '.'), args.join(' ')).toEqual(before);
    }
  });
});
