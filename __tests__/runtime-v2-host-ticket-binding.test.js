import { execFileSync, spawn } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
// End-to-end against the SOURCE hook binary (bin/ape-hook.mjs), not the stale
// dist bundle: a targeted run after a lib/runtime edit must exercise the
// edited code, matching the other hook e2e suites. Bundle byte-identity is
// attested by runtime-v2-bundle-freshness.test.js, and the smoke describe
// below still EXECUTES the shipped bundle hooks.json actually wires.
const hookBinary = path.join(root, 'bin', 'ape-hook.mjs');
const hookBundle = path.join(root, 'dist', 'ape-hooks.bundle.mjs');
const cleanups = [];

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function runningProject() {
  const dir = await mkdtemp(path.join(tmpdir(), 'ape-ticket-binding-'));
  cleanups.push(dir);
  await mkdir(path.join(dir, 'src'), { recursive: true });
  await writeFile(path.join(dir, 'src', 'value.js'), 'export const value = 1;\n');
  execFileSync('git', ['init', '-q'], { cwd: dir });
  execFileSync('git', ['config', 'user.email', 'ape@example.test'], { cwd: dir });
  execFileSync('git', ['config', 'user.name', 'APE Test'], { cwd: dir });
  execFileSync('git', ['add', '.'], { cwd: dir });
  execFileSync('git', ['commit', '-qm', 'baseline'], { cwd: dir });
  const baseTree = execFileSync('git', ['rev-parse', 'HEAD^{tree}'], {
    cwd: dir,
    encoding: 'utf8',
  }).trim();
  await mkdir(path.join(dir, '.ape', 'runtime'), { recursive: true });
  await writeFile(path.join(dir, '.ape', 'runtime', 'active.json'), JSON.stringify({
    run_id: 'run-1',
    status: 'running',
    tickets: [{
      ticket_id: 'run-1:build:ticket-1',
      role: 'implementer',
      writable: true,
      claimed_paths: ['src'],
      test_paths: ['tests'],
      base_tree_sha: baseTree,
    }],
    receipts: [],
  }));
  return dir;
}

function invokeHook(input, host, binary = hookBinary) {
  return new Promise((resolve, reject) => {
    const env = { ...process.env };
    delete env.CLAUDECODE;
    delete env.CLAUDE_CODE;
    // Strip the ambient host project hints so the payload's project_dir alone
    // names the scratch project, not the live session env of whoever runs
    // the suite.
    delete env.CLAUDE_PROJECT_DIR;
    delete env.CODEX_CWD;
    if (host === 'claude') env.CLAUDECODE = '1';
    const child = spawn(process.execPath, [binary], {
      cwd: root,
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code !== 0) reject(new Error(stderr));
      else resolve(JSON.parse(stdout));
    });
    child.stdin.end(`${JSON.stringify(input)}\n`);
  });
}

function decision(response, host) {
  const wireDecision = response?.hookSpecificOutput?.permissionDecision;
  if (wireDecision) return wireDecision;
  if (response?.decision === 'block') return 'deny';
  if (host === 'codex') return 'allow';
  return response?.decision;
}

describe('APE v2 installed hook ticket binding', () => {
  it(
    'retains Codex public-ticket binding for a claimed write',
    async () => {
      const dir = await runningProject();
      const response = await invokeHook({
        hook_event_name: 'PreToolUse',
        project_dir: dir,
        tool_name: 'Write',
        tool_input: { file_path: path.join(dir, 'src', 'value.js') },
        agent_id: 'native-agent-1',
        ticket_id: 'run-1:build:ticket-1',
      }, 'codex');

      expect(decision(response, 'codex')).toBe('allow');
    },
  );

  it('does not treat a public ticket id as Claude launch/binding proof', async () => {
    const dir = await runningProject();
    const response = await invokeHook({
      hook_event_name: 'PreToolUse',
      project_dir: dir,
      tool_name: 'Write',
      tool_input: { file_path: path.join(dir, 'src', 'value.js') },
      agent_id: 'native-agent-1',
      agent_type: 'ape:implementer',
      ticket_id: 'run-1:build:ticket-1',
    }, 'claude');

    expect(decision(response, 'claude')).toBe('deny');
  });

  it.each(['claude', 'codex'])(
    'denies an unbound %s subagent even when only one writable ticket is pending',
    async (host) => {
      const dir = await runningProject();
      const response = await invokeHook({
        hook_event_name: 'PreToolUse',
        project_dir: dir,
        tool_name: 'Write',
        tool_input: { file_path: path.join(dir, 'src', 'value.js') },
        agent_id: 'unbound-native-agent',
      }, host);

      expect(decision(response, host)).toBe('deny');
    },
  );

  it('denies a claimed lexical path whose symlink target escapes the claim', async () => {
    const dir = await runningProject();
    await mkdir(path.join(dir, 'outside'));
    await symlink('../outside', path.join(dir, 'src', 'escape'));
    const response = await invokeHook({
      hook_event_name: 'PreToolUse',
      project_dir: dir,
      tool_name: 'Write',
      tool_input: { file_path: path.join(dir, 'src', 'escape', 'value.js') },
      agent_id: 'native-agent-1',
      ticket_id: 'run-1:build:ticket-1',
    }, 'codex');

    expect(decision(response, 'codex')).toBe('deny');
  });

  // The drift guard binds write-capable tools and the result-bearing boundaries;
  // read-only tools stay governed by ordinary policy (see runtime-v2-hook-drift-recovery).
  it.each([
    ['PostToolUseFailure', 'Write'],
    ['SubagentStop', 'Read'],
    ['PreToolUse', 'Write'],
  ])(
    'reconciles an unattributed tree change at %s (%s) before allowing more work',
    async (hookEventName, toolName) => {
      const dir = await runningProject();
      await writeFile(path.join(dir, 'unclaimed.txt'), 'unattributed\n');
      const response = await invokeHook({
        hook_event_name: hookEventName,
        project_dir: dir,
        tool_name: toolName,
        tool_input: { file_path: path.join(dir, 'src', 'value.js') },
        agent_id: 'native-agent-1',
        ticket_id: 'run-1:build:ticket-1',
      }, 'codex');

      expect(decision(response, 'codex')).toBe('deny');
    },
  );

  it('quarantines a shared-tree change when multiple tickets could claim attribution', async () => {
    const dir = await runningProject();
    const activePath = path.join(dir, '.ape', 'runtime', 'active.json');
    const active = JSON.parse(await readFile(activePath, 'utf8'));
    active.tickets.push({
      ...active.tickets[0],
      ticket_id: 'run-1:build:ticket-2',
    });
    await writeFile(activePath, JSON.stringify(active));
    await writeFile(path.join(dir, 'src', 'value.js'), 'export const value = 2;\n');

    const response = await invokeHook({
      hook_event_name: 'PostToolUse',
      project_dir: dir,
      tool_name: 'Write',
      tool_input: { file_path: path.join(dir, 'src', 'value.js') },
      agent_id: 'native-agent-1',
      ticket_id: 'run-1:build:ticket-1',
    }, 'codex');

    expect(decision(response, 'codex')).toBe('deny');
  });

  it('exempts the APE control-plane MCP tools from the unattributed-tree guard', async () => {
    const dir = await runningProject();
    // An unattributed working-tree change (no receipt recorded yet) is exactly the
    // state that deadlocked recovery: the reconcile guard denies ordinary
    // main-session write tools...
    await writeFile(path.join(dir, 'src', 'value.js'), 'export const value = 2;\n');
    const base = { hook_event_name: 'PreToolUse', project_dir: dir };

    const blocked = await invokeHook(
      { ...base, tool_name: 'Write', tool_input: { file_path: path.join(dir, 'src', 'value.js') } },
      'claude',
    );
    expect(decision(blocked, 'claude')).toBe('deny');

    // ...but the sanctioned recovery path (record / abort / override) must always
    // get through, or the run can never be attributed or aborted from-session.
    for (const tool of ['mcp__plugin_ape_ape__ape_run', 'ape_run', 'mcp__plugin_ape_ape__ape_config']) {
      const allowed = await invokeHook({ ...base, tool_name: tool, tool_input: { action: 'record' } }, 'claude');
      expect(decision(allowed, 'claude'), tool).toBe('allow');
    }
  });
});

describe('APE v2 installed hook bundle smoke', () => {
  // The freshness test only byte-compares dist/ against a rebuild; this is
  // the one place the shipped bundle is actually EXECUTED, so a packaging
  // defect the byte comparison cannot see (broken entry wiring, an import
  // the bundler resolved wrongly) still fails a behavioral test.
  it.each(['claude', 'codex'])(
    'denies an unbound %s subagent through the shipped hook bundle',
    async (host) => {
      const dir = await runningProject();
      const response = await invokeHook({
        hook_event_name: 'PreToolUse',
        project_dir: dir,
        tool_name: 'Write',
        tool_input: { file_path: path.join(dir, 'src', 'value.js') },
        agent_id: 'unbound-native-agent',
      }, host, hookBundle);

      expect(decision(response, host)).toBe('deny');
    },
  );
});
