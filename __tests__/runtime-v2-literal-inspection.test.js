import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { evaluateLifecyclePolicy, normalizeLifecycleEvent } from '../lib/runtime/lifecycle-policy.js';
import { parseEvidenceCommand } from '../lib/runtime/evidence-policy.js';

const root = '/synthetic/literal-inspection';
const cleanups = [];
afterEach(async () => Promise.all(cleanups.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))));
function policy(command, evidence = {}) {
  const event = normalizeLifecycleEvent({
    hook_event_name: 'PreToolUse', tool_name: 'Bash', agent_id: 'synthetic-reviewer',
    project_dir: root, tool_input: { command },
  }, {});
  return evaluateLifecyclePolicy({ ...event, host: 'codex', evidence }, {
    state: { status: 'running' },
    ticket: { ticket_id: 'synthetic-review', role: 'reviewer', writable: false },
  });
}

describe('literal inspection words preserve read-only command semantics', () => {
  it.each([
    ["cd 'my package' && cat README.md", 'my package', ['cat', 'README.md']],
    ['cd "my package" && npm test', 'my package', ['npm', 'test']],
    ["cd 'src/[route]' && rg -n foo .", 'src/[route]', ['rg', '-n', 'foo', '.']],
    ["cd 'src/~literal' && cat README.md", 'src/~literal', ['cat', 'README.md']],
    ["cd './+build' && node --test", './+build', ['node', '--test']],
    ["cd 'src/a;b' && cat README.md", 'src/a;b', ['cat', 'README.md']],
    ["cd 'src/$literal' && cat README.md", 'src/$literal', ['cat', 'README.md']],
    ["cd 'src/foo^bar'&&cat README.md", 'src/foo^bar', ['cat', 'README.md']],
  ])('admits a literal working directory in %s', (command, cdTarget, tokens) => {
    expect(parseEvidenceCommand(command)).toMatchObject({ cdTarget, tokens });
    expect(policy(command).decision).toBe('allow');
  });

  it.each([
    'cd "$(touch unwanted)" && cat README.md', 'cd "$HOME" && cat README.md',
    'cd "`pwd`" && cat README.md', "cd '' && cat README.md",
    "cd 'src'/outside && cat README.md", "cd 'src' extra && cat README.md",
    "cd 'src' && cd other && cat README.md", "cd 'src' || cat README.md",
    "cd 'src' && cat README.md > unwanted", "cd 'src' && rm README.md",
    "cd '/outside folder' && cat README.md", "cd '../outside folder' && cat README.md",
    "cd '+1' && cat README.md", "cd '-' && cat README.md",
  ])('retains relocation and command boundaries for %s', (command) => {
    expect(policy(command).decision).toBe('deny');
  });

  it.each([
    ["cat 'src/file with spaces.js'", ['cat', 'src/file with spaces.js']],
    ['cat "src/file with spaces.js"', ['cat', 'src/file with spaces.js']],
    ["rg -n 'foo|bar' src", ['rg', '-n', 'foo|bar', 'src']],
    ["grep -E 'foo|bar' 'src/file with spaces.js'", ['grep', '-E', 'foo|bar', 'src/file with spaces.js']],
    ["rg -e '$HOME|foo' src", ['rg', '-e', '$HOME|foo', 'src']],
    ["rg -n '\\bfoo\\b' src", ['rg', '-n', '\\bfoo\\b', 'src']],
    ["'rg' '-n' '^foo' 'src'", ['rg', '-n', '^foo', 'src']],
    ["'cat' '~literal'", ['cat', '~literal']],
    ["head -n 10 'src/file with spaces.js'", ['head', '-n', '10', 'src/file with spaces.js']],
    ["tail -n 10 'src/file with spaces.js'", ['tail', '-n', '10', 'src/file with spaces.js']],
    ['git diff -- "src/file with spaces.js"', ['git', 'diff', '--', 'src/file with spaces.js']],
    ["ls 'src/[literal]'", ['ls', 'src/[literal]']],
    ["cd src && cat 'file with spaces.js'", ['cat', 'file with spaces.js']],
  ])('admits %s as literal argv', (command, argv) => {
    expect(parseEvidenceCommand(command)?.tokens).toEqual(argv);
    expect(policy(command).decision).toBe('allow');
  });

  it.each([
    "cat 'src/file with spaces.js' > output.js",
    "cat 'src/file with spaces.js' && rm src/value.js",
    "cat 'src/file with spaces.js'; rm src/value.js",
    "cat 'src/file with spaces.js' | sh",
    'cat "$(touch output.js)"', 'cat "$HOME/config"', 'cat "`pwd`/file"',
    "cat src/'file with spaces.js'", "cat 'unterminated", 'cat "src/escaped\\ name"',
    "rg --pre=node 'foo|bar' src", "rg '--hostname-bin=node' foo src", "rg -z 'foo|bar' src",
    "git diff '--output=output.js' 'src/file with spaces.js'", "git branch -D 'main'",
    "cat '/outside/file with spaces.js'", "cat '../outside/file with spaces.js'",
    "python -c 'print(1)'", "'cat src/file; touch output.js'",
  ])('does not admit shell effects or out-of-scope operands: %s', (command) => {
    expect(policy(command).decision).toBe('deny');
  });

  it('still requires the pinned executable for a quoted read', () => {
    expect(policy("cat 'src/file with spaces.js'", {
      executable_safe: false, executable_reason: 'synthetic executable drift',
    }).decision).toBe('deny');
  });

  it('lets the parent inspect literal data without permitting production-write commands', () => {
    for (const [command, expected] of [
      ["rg -n 'foo|bar' src", 'allow'],
      ["cat 'src/file with spaces.js'", 'allow'],
      ["cat 'src/file with spaces.js' > output.js", 'deny'],
    ]) {
      expect(evaluateLifecyclePolicy({
        host: 'codex', event: 'PreToolUse', is_subagent: false,
        tool_name: 'Bash', project_dir: root, command,
      }, { state: { status: 'running' }, ticket: null }).decision, command).toBe(expected);
    }
  });

  it.skipIf(process.platform === 'win32')('the admitted quoting reads the literal file without executing the quoted payload', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'ape-literal-inspection-'));
    cleanups.push(dir);
    await mkdir(path.join(dir, 'src'));
    const filename = 'src/file; touch unwanted';
    await writeFile(path.join(dir, filename), 'literal file contents\n');
    const command = `cat '${filename}'`;
    expect(policy(command).decision).toBe('allow');
    expect(execFileSync('/bin/sh', ['-c', command], { cwd: dir, encoding: 'utf8' }))
      .toBe('literal file contents\n');
    expect(execFileSync('/bin/sh', ['-c', 'test ! -e unwanted'], { cwd: dir }).length).toBe(0);
  });

  it.skipIf(process.platform === 'win32')('a quoted relocation enters the literal folder and preserves shell boundaries', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'ape-literal-cd-'));
    cleanups.push(dir);
    const folder = 'package; touch unwanted';
    await mkdir(path.join(dir, folder));
    await writeFile(path.join(dir, folder, 'README.md'), 'from the literal directory\n');
    const command = `cd '${folder}' && cat README.md`;
    expect(policy(command).decision).toBe('allow');
    expect(execFileSync('/bin/sh', ['-c', command], { cwd: dir, encoding: 'utf8' }))
      .toBe('from the literal directory\n');
    expect(execFileSync('/bin/sh', ['-c', 'test ! -e unwanted'], { cwd: dir }).length).toBe(0);
  });
});
