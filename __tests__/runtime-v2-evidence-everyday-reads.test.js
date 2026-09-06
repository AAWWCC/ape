import { describe, expect, it } from 'vitest';
import {
  EVIDENCE_COMMAND_HEADS,
  evidenceOperandCandidates,
  gitEvidenceArgsSafe,
} from '../lib/runtime/evidence-policy.js';
import { evaluateLifecyclePolicy, normalizeLifecycleEvent } from '../lib/runtime/lifecycle-policy.js';

// Pure policy fixtures: no active run, host hook, or evidence command executes.
const projectDir = '/synthetic/project';
function decision(command, { writable = false, evidence } = {}) {
  const event = normalizeLifecycleEvent({
    hook_event_name: 'PreToolUse',
    tool_name: 'Bash',
    agent_id: 'synthetic-reviewer',
    cwd: projectDir,
    tool_input: { command },
  }, {});
  return evaluateLifecyclePolicy({
    ...event,
    host: 'claude',
    is_subagent: true,
    ape_managed: true,
    project_dir: projectDir,
    evidence,
  }, {
    state: { status: 'running' },
    ticket: {
      ticket_id: 'synthetic:read',
      role: writable ? 'implementer' : 'reviewer',
      writable,
      claimed_paths: ['src'],
      test_paths: ['tests'],
    },
  }).decision;
}

describe('ordinary evidence reads retain their actual argv and effects', () => {
  it('accepts in-project long option values in either equals or spaced form', () => {
    for (const option of ['--rootdir', '--config', '--dir', '--prefix']) {
      for (const operand of ['./tests', 'tests/unit', './tests/../src', `${projectDir}/tests`]) {
        expect(evidenceOperandCandidates(`${option}=${operand}`)).toEqual([operand]);
        expect(decision(`pytest ${option}=${operand}`), `${option}=${operand}`).toBe('allow');
        expect(decision(`pytest ${option} ${operand}`), `${option} ${operand}`).toBe('allow');
      }
    }
  });

  it('still contains absolute, traversal, and sticky short-option paths', () => {
    for (const operand of [
      '--rootdir=/outside/tests', '--rootdir=../outside', '--rootdir=tests/../../outside',
      '--config=/outside/config=value', '-C/outside', '-rC/outside', '-C../outside',
      '--bad/../../outside=value',
    ]) {
      expect(decision(`pytest ${operand}`), operand).toBe('deny');
    }
  });

  it('allows the ls-files untracked switch without permitting output-file flags', () => {
    expect(gitEvidenceArgsSafe(['git', 'ls-files', '-o'])).toBe(true);
    expect(decision('git ls-files -o --exclude-standard')).toBe('allow');
    for (const command of [
      'git diff -o result.txt', 'git log -oresult.txt', 'git ls-files -oresult.txt',
      'git diff --output=result.txt', 'git ls-files --output=result.txt',
      'git branch -D main', 'git branch newbranch',
    ]) expect(decision(command), command).toBe('deny');
  });

  it('admits routine search and bounded file inspection on read-only and writable tickets', () => {
    for (const writable of [false, true]) {
      for (const command of [
        'rg TODO src', 'rg -n -C 3 TODO src', 'rg --files src',
        'rg --hidden --no-ignore --files src', 'rg --no-config -n TODO src',
        'rg -e --pre src', 'rg --regexp --hostname-bin src', 'rg -- -z src',
        'rg -ez src', 'rg -r --pre TODO src',
        'grep -n TODO src/value.js', 'grep -r -n TODO src',
        'head -n 20 src/value.js', 'head -20 src/value.js',
        'tail -n 20 src/value.js', 'tail -c 200 src/value.js',
        'cd src && rg -n TODO .',
        '"rg" "-n" "TODO" "src"', "'grep' '-n' 'TODO' 'src/value.js'",
        '"head" "-n" "20" "src/value.js"', "'tail' '-n' '20' 'src/value.js'",
      ]) expect(decision(command, { writable }), command).toBe('allow');
    }
  });

  it('keeps search subprocess modes outside the inspection channel', () => {
    for (const command of [
      'rg --pre node TODO src', 'rg --pre=node TODO src',
      'rg --hostname-bin=node TODO src', 'rg --hostname-bin node TODO src',
      'rg --search-zip TODO src', 'rg -z TODO src', 'rg -nz TODO src',
      'rg --pre=node --no-pre TODO src',
      'rg -n -e TODO --pre=node src', 'rg --regexp=TODO --hostname-bin=node src',
      'rg -efoo -z src',
    ]) expect(decision(command, { writable: true }), command).toBe('deny');
  });

  it('preserves containment, exact executable names, and trusted executable checks', () => {
    for (const head of ['rg', 'grep', 'head', 'tail']) {
      expect(EVIDENCE_COMMAND_HEADS).toContain(head);
      const readCommand = ['rg', 'grep'].includes(head) ? `${head} TODO` : head;
      expect(decision(`${readCommand} /outside/input`), head).toBe('deny');
      expect(decision(`${readCommand} ../outside/input`), head).toBe('deny');
      expect(decision(`${head}-pwn src/value.js`), head).toBe('deny');
      expect(decision(`${head} src/value.js > result.txt`), head).toBe('deny');
      expect(decision(`${head} src/value.js && cp src/value.js result.txt`), head).toBe('deny');
      expect(decision(`${head} src/value.js`, { evidence: {
        executable_safe: false,
        executable_reason: 'synthetic trusted executable mismatch',
      } }), head).toBe('deny');
    }
  });
});
