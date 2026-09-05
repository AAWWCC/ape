import { execFileSync, spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { cp, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const read = (rel) => readFileSync(path.join(root, rel), 'utf8');
const readJson = (rel) => JSON.parse(read(rel));
const cleanups = [];

const codexHookManifest = readJson('hooks/hooks.json');
const codexHookEntries = Object.entries(codexHookManifest.hooks).flatMap(([event, groups]) =>
  groups.flatMap((group) =>
    group.hooks.map((hook) => ({ event, matcher: group.matcher ?? '*', hook })),
  ),
);
const claudeHookEntries = Object.entries(readJson('hooks/claude-hooks.json').hooks).flatMap(
  ([event, groups]) =>
    groups.flatMap((group) =>
      group.hooks.map((hook) => ({ event, matcher: group.matcher ?? '*', hook })),
    ),
);

const PORTABLE_HOOK_COMMAND =
  'node --input-type=module -e "import{join}from\'node:path\';import{pathToFileURL}from\'node:url\';const r=process.env.PLUGIN_ROOT,c=process.env.CLAUDE_PLUGIN_ROOT,p=r||c;if(!p)throw new Error(\'APE hook could not resolve its plugin root\');if(r){delete process.env.APE_HOST;delete process.env.CLAUDECODE;delete process.env.CLAUDE_CODE;delete process.env.CLAUDE_PLUGIN_ROOT;delete process.env.CLAUDE_PROJECT_DIR}else{process.env.CLAUDECODE=\'1\';delete process.env.CLAUDE_CODE;delete process.env.CODEX_CWD}await import(pathToFileURL(join(p,\'dist\',\'ape-hooks.bundle.mjs\')))"';
const PORTABLE_CANARY_COMMAND =
  'node --input-type=module -e "import{join}from\'node:path\';import{pathToFileURL}from\'node:url\';const r=process.env.PLUGIN_ROOT,c=process.env.CLAUDE_PLUGIN_ROOT;if(!r){for await(const _ of process.stdin){};if(!c)throw new Error(\'APE canary hook could not resolve its plugin root\');process.stdout.write(\'{}\\n\')}else{process.argv.push(\'--ape-canary-only\');delete process.env.APE_HOST;delete process.env.CLAUDECODE;delete process.env.CLAUDE_CODE;delete process.env.CLAUDE_PLUGIN_ROOT;delete process.env.CLAUDE_PROJECT_DIR;await import(pathToFileURL(join(r,\'dist\',\'ape-hooks.bundle.mjs\')))}"';
const PORTABLE_LARP_COMMAND =
  'node --input-type=module -e "import{join}from\'node:path\';import{pathToFileURL}from\'node:url\';const p=process.env.PLUGIN_ROOT,c=process.env.CLAUDE_PLUGIN_ROOT;if(!p){for await(const _ of process.stdin){};if(!c)throw new Error(\'APE LARP hook could not resolve its plugin root\')}else{delete process.env.APE_HOST;delete process.env.CLAUDECODE;delete process.env.CLAUDE_CODE;delete process.env.CLAUDE_PLUGIN_ROOT;delete process.env.CLAUDE_PROJECT_DIR;await import(pathToFileURL(join(p,\'dist\',\'ape-larp.bundle.mjs\')))}"';

const isLarpHook = (hook) => hook.command.includes('ape-larp.bundle.mjs');
const isCanaryHook = (hook) => hook.command.includes("process.argv.push('--ape-canary-only')");

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function fixture() {
  // A space in the plugin root proves the command passes the path through the
  // environment and Node's path API instead of interpolating it into a shell
  // command. The same test runs under cmd.exe in the Windows CI shard.
  const pluginRoot = await mkdtemp(path.join(tmpdir(), 'ape plugin root-'));
  const projectDir = await mkdtemp(path.join(tmpdir(), 'ape-hook-project-'));
  cleanups.push(pluginRoot, projectDir);
  await mkdir(path.join(pluginRoot, 'dist'), { recursive: true });
  await Promise.all(
    ['ape-hooks.bundle.mjs', 'ape-larp.bundle.mjs'].map((bundle) =>
      cp(path.join(root, 'dist', bundle), path.join(pluginRoot, 'dist', bundle)),
    ),
  );
  return { pluginRoot, projectDir };
}

function git(cwd, ...args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

async function activeFixture() {
  const value = await fixture();
  await writeFile(path.join(value.projectDir, 'README.md'), '# hook fixture\n');
  git(value.projectDir, 'init', '-q');
  git(value.projectDir, 'config', 'user.email', 'ape@example.test');
  git(value.projectDir, 'config', 'user.name', 'APE Test');
  git(value.projectDir, 'add', '.');
  git(value.projectDir, 'commit', '-qm', 'test: baseline');
  const treeSha = git(value.projectDir, 'rev-parse', 'HEAD^{tree}');
  await mkdir(path.join(value.projectDir, '.ape', 'runtime'), { recursive: true });
  await writeFile(path.join(value.projectDir, '.ape', 'runtime', 'active.json'), JSON.stringify({
    run_id: 'run-windows-hook',
    status: 'running',
    tree_sha: treeSha,
    tickets: [],
    receipts: [],
  }));
  return value;
}

function payload(event, projectDir, matcher = '*') {
  const common = {
    session_id: 'hook-session',
    turn_id: 'hook-turn',
    transcript_path: null,
    cwd: projectDir,
    project_dir: projectDir,
    hook_event_name: event,
    permission_mode: 'default',
  };
  if (event === 'PreToolUse') {
    if (matcher.includes('request_user_input')) {
      return {
        ...common,
        tool_name: 'request_user_input',
        tool_use_id: 'hook-tool-call',
        tool_input: { questions: [] },
      };
    }
    return {
      ...common,
      tool_name: 'Bash',
      tool_use_id: 'hook-tool-call',
      tool_input: { command: 'git status --short' },
    };
  }
  if (event === 'PostToolUse') {
    if (matcher.includes('ape_run')) {
      return {
        ...common,
        tool_name: 'mcp__ape__ape_run',
        tool_use_id: 'hook-tool-call',
        tool_input: { action: 'status' },
        tool_response: {
          content: [{ type: 'text', text: JSON.stringify({ ok: true, run: { status: 'running' } }) }],
        },
      };
    }
    return {
      ...common,
      tool_name: 'Bash',
      tool_use_id: 'hook-tool-call',
      tool_input: { command: 'git status --short' },
      tool_response: { exit_code: 0, output: '' },
    };
  }
  if (event === 'SubagentStart') {
    return { ...common, agent_id: 'agent-1', agent_type: 'explorer' };
  }
  if (event === 'PostToolUseFailure') {
    return {
      ...common,
      tool_name: 'Bash',
      tool_use_id: 'hook-tool-call',
      tool_input: { command: 'false' },
      error: 'command failed',
      is_interrupt: false,
    };
  }
  if (event === 'SessionStart') {
    return { ...common, source: 'startup', model: 'claude-test' };
  }
  if (event === 'Stop') {
    return { ...common, stop_hook_active: false, last_assistant_message: 'done' };
  }
  return {
    ...common,
    agent_id: 'agent-1',
    agent_type: 'explorer',
    agent_transcript_path: null,
    stop_hook_active: false,
    last_assistant_message: 'done',
  };
}

function pluginHostEnv(overrides = {}) {
  const hostEnv = { ...process.env };
  for (const key of Object.keys(hostEnv)) {
    if (/^(?:PLUGIN_ROOT|CLAUDE_PLUGIN_ROOT|CLAUDECODE|CLAUDE_CODE|CLAUDE_PROJECT_DIR|CODEX_CWD|APE_HOST)$/i.test(key)) {
      delete hostEnv[key];
    }
  }
  return { ...hostEnv, ...overrides };
}

function runShellHook(command, input, cwd, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, {
      cwd,
      env,
      shell: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.once('error', reject);
    child.stdin.once('error', reject);
    child.once('exit', (code, signal) => resolve({ code, signal, stdout, stderr }));
    child.stdin.end(`${JSON.stringify(input)}\n`);
  });
}

function runClaudeHook(hook, input, cwd, pluginRoot) {
  const args = hook.args.map((arg) => arg.replaceAll('${CLAUDE_PLUGIN_ROOT}', pluginRoot));
  return new Promise((resolve, reject) => {
    const child = spawn(hook.command, args, {
      cwd,
      env: pluginHostEnv({ CLAUDECODE: '1', CLAUDE_PLUGIN_ROOT: pluginRoot }),
      shell: false,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.once('error', reject);
    child.once('exit', (code, signal) => resolve({ code, signal, stdout, stderr }));
    child.stdin.end(`${JSON.stringify(input)}\n`);
  });
}

describe('every Codex plugin hook launcher is host-portable', () => {
  it('uses one shell-neutral Node command for every Unix and Windows hook entry', () => {
    expect(codexHookEntries.map(({ event }) => event)).toEqual([
      'PreToolUse',
      'PreToolUse',
      'PreToolUse',
      'SubagentStart',
      'PostToolUse',
      'PostToolUse',
      'SubagentStop',
      'SubagentStop',
      'SessionStart',
      'SessionStart',
      'Stop',
    ]);
    for (const { event, hook } of codexHookEntries) {
      expect(hook.type, `${event} hook type`).toBe('command');
      const expected = isLarpHook(hook)
        ? PORTABLE_LARP_COMMAND
        : isCanaryHook(hook) ? PORTABLE_CANARY_COMMAND : PORTABLE_HOOK_COMMAND;
      expect(hook.command, `${event} default command`).toBe(expected);
      expect(hook.commandWindows, `${event} Windows command`).toBe(expected);
    }
  });

  it('does not interpolate plugin paths through either shell syntax', () => {
    const serialized = JSON.stringify(codexHookManifest);
    expect(serialized).toContain('process.env.PLUGIN_ROOT');
    expect(serialized).toContain('process.env.CLAUDE_PLUGIN_ROOT');
    expect(serialized).toContain('process.env.CLAUDECODE');
    expect(serialized).toContain('process.env.CLAUDE_CODE');
    expect(serialized).not.toContain('$PLUGIN_ROOT');
    expect(serialized).not.toContain('%PLUGIN_ROOT%');
    expect(serialized).not.toContain('CODEX_PLUGIN_ROOT');
    expect(serialized).not.toContain('${');
  });

  it.each(codexHookEntries)(
    '$event launches, accepts its documented payload, and exits zero',
    async ({ event, matcher, hook }) => {
      const { pluginRoot, projectDir } = await fixture();
      const command = process.platform === 'win32' ? hook.commandWindows : hook.command;
      const result = await runShellHook(
        command,
        payload(event, projectDir, matcher),
        projectDir,
        pluginHostEnv({ PLUGIN_ROOT: pluginRoot }),
      );
      expect(result.signal).toBeNull();
      expect(result.code, result.stderr || result.stdout).toBe(0);
      expect(result.stderr).toBe('');
      expect(result.stdout.trim()).toBe('{}');
    },
  );

  it.each(codexHookEntries)(
    '$event executes the shared policy when Claude auto-discovers the conventional manifest',
    async ({ event, matcher, hook }) => {
      const { pluginRoot, projectDir } = await fixture();
      const command = hook.command;
      const result = await runShellHook(
        command,
        payload(event, projectDir, matcher),
        projectDir,
        pluginHostEnv({ CLAUDECODE: '1', CLAUDE_PLUGIN_ROOT: pluginRoot }),
      );
      expect(result.signal).toBeNull();
      expect(result.code, result.stderr || result.stdout).toBe(0);
      expect(result.stderr).toBe('');
      if (isLarpHook(hook)) expect(result.stdout).toBe('');
      else expect(JSON.parse(result.stdout)).toBeTypeOf('object');
    },
  );

  it.each(codexHookEntries)(
    '$event fails with a controlled diagnostic when neither host root exists',
    async ({ event, matcher, hook }) => {
      const { projectDir } = await fixture();
      const command = process.platform === 'win32' ? hook.commandWindows : hook.command;
      const result = await runShellHook(
        command,
        payload(event, projectDir, matcher),
        projectDir,
        pluginHostEnv(),
      );
      expect(result.signal).toBeNull();
      expect(result.code).not.toBe(0);
      expect(result.stderr).toMatch(/APE(?: LARP| canary)? hook could not resolve its plugin root/);
      expect(result.stderr).not.toMatch(/ERR_INVALID_ARG_TYPE|node:path:\d+/);
    },
  );

  it.each(codexHookEntries)(
    '$event keeps Codex enforcement authoritative whenever PLUGIN_ROOT exists',
    async ({ event, matcher, hook }) => {
      const { pluginRoot, projectDir } = await fixture();
      const command = process.platform === 'win32' ? hook.commandWindows : hook.command;
      const result = await runShellHook(
        command,
        payload(event, projectDir, matcher),
        projectDir,
        pluginHostEnv({
          PLUGIN_ROOT: pluginRoot,
          CLAUDE_PLUGIN_ROOT: path.join(pluginRoot, 'ambient-claude-root'),
          CLAUDECODE: '1',
        }),
      );
      expect(result.signal).toBeNull();
      expect(result.code, result.stderr || result.stdout).toBe(0);
      expect(result.stderr).toBe('');
      expect(result.stdout.trim()).toBe('{}');
    },
  );

  it('uses the Codex root when the launcher inherits a complete stale Claude environment', async () => {
    const { pluginRoot, projectDir } = await activeFixture();
    const foreign = await mkdtemp(path.join(tmpdir(), 'ape-hook-stale-claude-root-'));
    cleanups.push(foreign);
    const { hook } = codexHookEntries.find((entry) => entry.event === 'PreToolUse');
    const input = payload('PreToolUse', foreign);
    delete input.project_dir;
    input.cwd = foreign;
    input.tool_name = 'Write';
    input.tool_input = {
      file_path: path.join(projectDir, 'README.md'),
      content: 'stale Claude markers must not disable Codex governance',
    };
    const result = await runShellHook(
      process.platform === 'win32' ? hook.commandWindows : hook.command,
      input,
      foreign,
      pluginHostEnv({
        PLUGIN_ROOT: pluginRoot,
        CODEX_CWD: projectDir,
        CLAUDECODE: '1',
        CLAUDE_PLUGIN_ROOT: path.join(pluginRoot, 'ambient-claude-root'),
        CLAUDE_PROJECT_DIR: foreign,
      }),
    );
    expect(result.signal).toBeNull();
    expect(result.code, result.stderr || result.stdout).toBe(0);
    expect(result.stderr).toBe('');
    const response = JSON.parse(result.stdout);
    expect(response.hookSpecificOutput.permissionDecision).toBe('deny');
    expect(response.hookSpecificOutput.permissionDecisionReason).toMatch(
      /main-session production writes are forbidden/,
    );
  });

  it.each(codexHookEntries)(
    '$event keeps Codex enforcement active when a Claude root is merely ambient',
    async ({ event, matcher, hook }) => {
      const { pluginRoot, projectDir } = await fixture();
      const command = process.platform === 'win32' ? hook.commandWindows : hook.command;
      const result = await runShellHook(
        command,
        payload(event, projectDir, matcher),
        projectDir,
        pluginHostEnv({
          PLUGIN_ROOT: pluginRoot,
          CLAUDE_PLUGIN_ROOT: path.join(pluginRoot, 'ambient-claude-root'),
        }),
      );
      expect(result.signal).toBeNull();
      expect(result.code, result.stderr || result.stdout).toBe(0);
      expect(result.stderr).toBe('');
      expect(result.stdout.trim()).toBe('{}');
    },
  );

  it.each(codexHookEntries)(
    '$event selects a lone Claude plugin root and establishes the host marker itself',
    async ({ event, matcher, hook }) => {
      const { pluginRoot, projectDir } = await fixture();
      const result = await runShellHook(
        hook.command,
        payload(event, projectDir, matcher),
        projectDir,
        pluginHostEnv({ CLAUDE_PLUGIN_ROOT: pluginRoot }),
      );
      expect(result.signal).toBeNull();
      expect(result.code, result.stderr || result.stdout).toBe(0);
      expect(result.stderr).toBe('');
      if (isLarpHook(hook)) expect(result.stdout).toBe('');
      else expect(JSON.parse(result.stdout)).toBeTypeOf('object');
    },
  );

  it('enforces Claude policy with only CLAUDE_PLUGIN_ROOT and no inherited marker', async () => {
    const { pluginRoot, projectDir } = await activeFixture();
    const { hook } = codexHookEntries.find((entry) => entry.event === 'PreToolUse');
    const input = payload('PreToolUse', projectDir);
    input.tool_name = 'Write';
    input.tool_input = {
      file_path: path.join(projectDir, 'README.md'),
      content: 'a missing inherited marker must not disable Claude governance',
    };
    const result = await runShellHook(
      hook.command,
      input,
      projectDir,
      pluginHostEnv({ CLAUDE_PLUGIN_ROOT: pluginRoot }),
    );
    expect(result.signal).toBeNull();
    expect(result.code, result.stderr || result.stdout).toBe(0);
    expect(result.stderr).toBe('');
    const response = JSON.parse(result.stdout);
    expect(response.hookSpecificOutput.permissionDecision).toBe('deny');
    expect(response.hookSpecificOutput.permissionDecisionReason).toMatch(
      /main-session production writes are forbidden/,
    );
  });

  it('accepts the legacy Claude marker even when the primary marker is false', async () => {
    const { pluginRoot, projectDir } = await fixture();
    const { event, hook } = codexHookEntries.find((entry) => entry.event === 'PreToolUse');
    const result = await runShellHook(
      hook.command,
      payload(event, projectDir),
      projectDir,
      pluginHostEnv({
        CLAUDECODE: '0',
        CLAUDE_CODE: '1',
        CLAUDE_PLUGIN_ROOT: pluginRoot,
      }),
    );
    expect(result.signal).toBeNull();
    expect(result.code, result.stderr || result.stdout).toBe(0);
    expect(result.stderr).toBe('');
    expect(JSON.parse(result.stdout)).toBeTypeOf('object');
  });

  it('overrides a false inherited marker when the Claude plugin root is authoritative', async () => {
    const { pluginRoot, projectDir } = await fixture();
    const { event, hook } = codexHookEntries.find((entry) => entry.event === 'PreToolUse');
    const result = await runShellHook(
      hook.command,
      payload(event, projectDir),
      projectDir,
      pluginHostEnv({ CLAUDECODE: '0', CLAUDE_PLUGIN_ROOT: pluginRoot }),
    );
    expect(result.signal).toBeNull();
    expect(result.code, result.stderr || result.stdout).toBe(0);
    expect(result.stderr).toBe('');
    expect(JSON.parse(result.stdout)).toBeTypeOf('object');
  });

  it('does not let an inherited canary-like environment variable disable ordinary policy', async () => {
    const { pluginRoot, projectDir } = await activeFixture();
    const { event, hook } = codexHookEntries.find(
      (entry) =>
        entry.event === 'PreToolUse' &&
        !isCanaryHook(entry.hook) &&
        !isLarpHook(entry.hook),
    );
    const input = payload(event, projectDir);
    input.tool_input.command = 'touch forbidden-by-policy';
    const result = await runShellHook(
      hook.command,
      input,
      projectDir,
      pluginHostEnv({ PLUGIN_ROOT: pluginRoot, APE_CANARY_ONLY: '1' }),
    );
    expect(result.code, result.stderr || result.stdout).toBe(0);
    const response = JSON.parse(result.stdout);
    expect(response.hookSpecificOutput?.permissionDecision ?? response.decision).toBe('deny');
  });

  it('does not let an inherited APE_HOST misclassify a Codex wrapper as Claude', async () => {
    const { pluginRoot, projectDir } = await fixture();
    await mkdir(path.join(projectDir, '.ape', 'runtime'), { recursive: true });
    const { event, hook } = codexHookEntries.find(
      (entry) =>
        entry.event === 'SessionStart' &&
        !isCanaryHook(entry.hook) &&
        !isLarpHook(entry.hook),
    );
    const result = await runShellHook(
      hook.command,
      payload(event, projectDir),
      projectDir,
      pluginHostEnv({ PLUGIN_ROOT: pluginRoot, APE_HOST: 'claude' }),
    );
    expect(result.code, result.stderr || result.stdout).toBe(0);
    const response = JSON.parse(result.stdout);
    expect(response.hookSpecificOutput?.additionalContext).toContain('complete ape_run probe');
    expect(response.hookSpecificOutput?.additionalContext)
      .toContain('send ape_run probe-ack, then ape_run start');
  });

  it('processes the largest supported Claude hook payload through the shared policy entry', async () => {
    const { pluginRoot, projectDir } = await fixture();
    const { event, hook } = codexHookEntries.find((entry) => entry.event === 'PreToolUse');
    const command = hook.command;
    const input = payload(event, projectDir);
    input.tool_input.command = 'x'.repeat(8 * 1024 * 1024);
    const result = await runShellHook(
      command,
      input,
      projectDir,
      pluginHostEnv({ CLAUDECODE: '1', CLAUDE_PLUGIN_ROOT: pluginRoot }),
    );
    expect(result.signal).toBeNull();
    expect(result.code, result.stderr || result.stdout).toBe(0);
    expect(result.stderr).toBe('');
    expect(JSON.parse(result.stdout)).toBeTypeOf('object');
  });

  it('keeps every shipped MCP JavaScript entry behind the Node executable', () => {
    const codexMcp = readJson('plugins/ape/.mcp.json').mcpServers.ape;
    expect(codexMcp).toMatchObject({
      command: 'node',
      args: ['./dist/ape-mcp.bundle.mjs', '--host', 'codex'],
      cwd: '.',
    });

    const claudeMcp = readJson('plugins/ape-claude/.mcp.json').mcpServers.ape;
    expect(claudeMcp.command).toBe('node');
    expect(claudeMcp.args).toEqual([
      '${CLAUDE_PLUGIN_ROOT}/dist/ape-mcp.bundle.mjs', '--host', 'claude',
    ]);
  });

  it('keeps all seven supplemental Claude-manifest handlers behind Node command-plus-args launchers', () => {
    expect(claudeHookEntries).toHaveLength(7);
    for (const { hook } of claudeHookEntries) {
      expect(hook.command).toBe('node');
      expect(hook.command).not.toMatch(/\.mjs$/);
      expect(hook.args).toHaveLength(1);
      expect(hook.args[0]).toMatch(
        /^\$\{CLAUDE_PLUGIN_ROOT\}\/dist\/ape-(?:hooks|larp)\.bundle\.mjs$/,
      );
    }
  });

  it.each(claudeHookEntries)(
    'runs the shipped Claude $event/$matcher handler without a shell or launcher error',
    async ({ event, matcher, hook }) => {
      const { pluginRoot, projectDir } = await fixture();
      const result = await runClaudeHook(
        hook,
        payload(event, projectDir, matcher),
        projectDir,
        pluginRoot,
      );
      expect(result.signal).toBeNull();
      expect(result.code, result.stderr || result.stdout).toBe(0);
      expect(result.stderr).toBe('');
      if (result.stdout.trim()) expect(JSON.parse(result.stdout)).toBeTypeOf('object');
    },
  );

  it.each(['PreToolUse', 'PostToolUse'])(
    'runs the shared %s Bash policy hook under Claude with an active run',
    async (event) => {
      const { pluginRoot, projectDir } = await activeFixture();
      const group = codexHookManifest.hooks[event][0];
      const hook = group.hooks[0];
      const result = await runShellHook(
        hook.command,
        payload(event, projectDir),
        projectDir,
        pluginHostEnv({ CLAUDECODE: '1', CLAUDE_PLUGIN_ROOT: pluginRoot }),
      );
      expect(result.signal).toBeNull();
      expect(result.code, result.stderr || result.stdout).toBe(0);
      expect(result.stderr).toBe('');
      const response = JSON.parse(result.stdout);
      if (event === 'PreToolUse') {
        expect(response.hookSpecificOutput).toMatchObject({
          hookEventName: 'PreToolUse',
          permissionDecision: 'allow',
        });
      } else {
        expect(response).toEqual({});
      }
    },
  );
});
