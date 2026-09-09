import { afterEach, describe, expect, it } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readBoundedJsonSync } from '../lib/runtime/bounded-file.js';

const root = fileURLToPath(new URL('..', import.meta.url));
const directories = [];
afterEach(() => { for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true }); });
function fixture() {
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), 'ape-legacy-bounded-')));
  directories.push(dir);
  const runtime = path.join(dir, '.ape', 'runtime');
  mkdirSync(runtime, { recursive: true });
  writeFileSync(path.join(runtime, 'active.json'), JSON.stringify({ run_id: 'run-evidence', status: 'running',
    tickets: [{ ticket_id: 'run-evidence:review:r', stage_id: 'review', role: 'reviewer', writable: false,
      claimed_paths: [], test_paths: ['__tests__'] }], receipts: [] }));
  writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'fixture', scripts: { build: 'node --check src/value.js' } }));
  return { dir, config: path.join(runtime, 'config.json'), packageFile: path.join(dir, 'package.json') };
}
function hook(f, command) {
  const env = { ...process.env, CLAUDECODE: '1' };
  delete env.CLAUDE_PROJECT_DIR; delete env.CODEX_CWD; delete env.APE_TICKET_ID;
  return spawnSync(process.execPath, [path.join(root, 'bin', 'ape-hook.mjs')], {
    cwd: f.dir, env, encoding: 'utf8', timeout: 4_000, killSignal: 'SIGKILL',
    input: JSON.stringify({ hook_event_name: 'PreToolUse', project_dir: f.dir, session_id: 's1',
      is_subagent: true, ticket_id: 'run-evidence:review:r', tool_name: 'Bash', tool_input: { command } }),
  });
}
function decision(result) {
  expect(result.error).toBeUndefined();
  expect(result.status, result.stderr).toBe(0);
  return JSON.parse(result.stdout).hookSpecificOutput.permissionDecision;
}
function plan(f) {
  const candidate = { version: 1, requirements: [{ id: 'R1', requirement: 'Build the value', workstreams: ['build'] }],
    workstreams: [{ id: 'build', outcome: 'Value is built', paths: [{ path: 'src/value.js', action: 'modify' }],
      steps: ['Build value'], acceptance: ['Build succeeds'], evidence_commands: ['npm run build'] }], risks: [], non_goals: [] };
  return spawnSync(process.execPath, ['--input-type=module', '-e',
    `import {candidatePlanForScope} from ${JSON.stringify(new URL('../lib/runtime/plan-contract.js', import.meta.url).href)};
console.log(JSON.stringify(candidatePlanForScope(${JSON.stringify(candidate)},['src/value.js'],${JSON.stringify(f.dir)})));`],
  { encoding: 'utf8', timeout: 4_000, killSignal: 'SIGKILL' });
}

describe('bounded reads on legacy authority policy paths', () => {
  it('keeps valid legacy command profiles and declared scripts working', () => {
    const f = fixture();
    writeFileSync(f.config, JSON.stringify({ policy: { evidence_scripts: ['verify'], command_profiles: [
      { id: 'measure', command: 'node tool.js --measure', roles: ['reviewer'], effect: 'read' },
    ] } }));
    expect(decision(hook(f, 'node tool.js --measure'))).toBe('allow');
    expect(decision(hook(f, 'npm run verify'))).toBe('allow');
    expect(decision(hook(f, 'npm run unknown'))).toBe('deny');
  });

  it.skipIf(process.platform === 'win32')('returns the restrictive floor for FIFO config on the real hook', () => {
    const f = fixture();
    execFileSync('mkfifo', [f.config]);
    expect(decision(hook(f, 'npm run test'))).toBe('allow');
    expect(decision(hook(f, 'npm run unknown'))).toBe('deny');
  });

  it.skipIf(process.platform === 'win32')('rejects unavailable FIFO package evidence promptly after accepting the regular legacy plan', () => {
    const f = fixture();
    const before = plan(f);
    expect(before.status, before.stderr).toBe(0);
    expect(JSON.parse(before.stdout)).toMatchObject({ valid: true });
    rmSync(f.packageFile); execFileSync('mkfifo', [f.packageFile]);
    const after = plan(f);
    expect(after.error).toBeUndefined();
    expect(after.status, after.stderr).toBe(0);
    expect(JSON.parse(after.stdout)).toMatchObject({ valid: false });
  });

  it('bounds file bytes before parsing JSON', () => {
    const f = fixture();
    writeFileSync(f.config, '{"a":1}');
    expect(readBoundedJsonSync(f.config, 7)).toEqual({ a: 1 });
    expect(() => readBoundedJsonSync(f.config, 6)).toThrow(/bounded regular file/);
  });
});
