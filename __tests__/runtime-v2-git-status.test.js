import { describe, it, expect, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { workingTreeStatus } from '../lib/runtime/git.js';

// Regression: runGit used to .trim() all output, stripping the leading space of
// the first `git status --porcelain` entry (a worktree-only change, ` M path`).
// The clean_tree merge gate then did line.slice(3) and recovered a path missing
// its first character (`ib/runtime/service.js`), flagging a legitimately-changed
// file as "unexpected" and blocking auto-merge. workingTreeStatus must preserve
// the fixed-column porcelain prefix.
describe('workingTreeStatus porcelain column fidelity', () => {
  const dirs = [];
  afterEach(() => dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })));

  function repo() {
    const dir = mkdtempSync(join(tmpdir(), 'ape-gitstatus-'));
    dirs.push(dir);
    const git = (...a) => execFileSync('git', ['-C', dir, ...a], {
      encoding: 'utf8',
      env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' },
    });
    git('init', '-q');
    git('config', 'user.email', 't@t');
    git('config', 'user.name', 't');
    return { dir, git };
  }

  it('preserves the leading status space so slice(3) recovers the full path', async () => {
    const { dir, git } = repo();
    writeFileSync(join(dir, 'tracked.js'), 'export const v = 1;\n');
    git('add', '.');
    git('commit', '-qm', 'baseline');
    // Worktree-only modification → porcelain ` M tracked.js` (leading space).
    writeFileSync(join(dir, 'tracked.js'), 'export const v = 2;\n');

    const status = await workingTreeStatus(dir);
    expect(status).toHaveLength(1);
    expect(status[0]).toBe(' M tracked.js');
    // The clean_tree gate parses paths as line.slice(3):
    expect(status[0].slice(3)).toBe('tracked.js'); // not "racked.js"
  });

  it('keeps the modified entry parseable even as the first of several changes', async () => {
    const { dir, git } = repo();
    writeFileSync(join(dir, 'a-tracked.js'), 'export const v = 1;\n');
    git('add', '.');
    git('commit', '-qm', 'baseline');
    writeFileSync(join(dir, 'a-tracked.js'), 'export const v = 2;\n'); // ' M' — sorts first
    writeFileSync(join(dir, 'z-new.js'), 'export const n = 1;\n'); // '??'

    const status = await workingTreeStatus(dir);
    const paths = status.map((line) => line.slice(3));
    expect(paths).toContain('a-tracked.js'); // would be "-tracked.js" under the bug
    expect(paths).toContain('z-new.js');
  });
});
