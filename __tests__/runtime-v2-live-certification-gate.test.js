import childProcess, { execFileSync, spawnSync } from 'node:child_process';
import { cpSync, mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  TERMINAL_REASON_CODES,
  TERMINAL_REASON_TAXONOMY_VERSION,
} from '../lib/runtime/terminal-telemetry.js';
import {
  LIVE_CERTIFICATION_HOSTS,
  LIVE_CERTIFICATION_PIPELINES,
  LIVE_CERTIFICATION_SCHEMA_VERSION,
  LIVE_CERTIFICATION_UNVERIFIED_HOSTS,
  LiveCertificationError,
  parseLiveCertificationJson,
  validateLiveCertificationDocument as validateDocument,
  verifyLiveCertificationRepository,
} from '../scripts/verify-live-certification.mjs';
import {
  verifyLiveCertificationEnvironment,
} from '../scripts/check-live-certification-environment.mjs';
import {
  CERTIFICATION_APE_TOOLS,
  LiveCertificationParentError,
  buildCodexParentInvocation,
  startCertificationCatalogStub,
  stopCertificationCatalogStub,
  validateCertificationCatalogAudit,
} from '../scripts/run-live-certification-parent.mjs';
import {
  LiveCertificationPromptError,
  buildLiveCertificationPrompt,
  writeLiveCertificationPrompts,
} from '../scripts/prepare-live-certification-prompts.mjs';

const VERSION = '2.24.10';
const VERSION_SUFFIX = VERSION.split('.').slice(1).join('');
const SOURCE = 'a'.repeat(40);
const HOST_VERSIONS = Object.freeze({ codex: '0.147.0', claude: '2.1.228' });
const temporaryRepositories = [];
const realSpawnSync = spawnSync;

function codexVersionResult(overrides = {}) {
  return { status: 0, signal: null, stdout: Buffer.from(`codex-cli ${HOST_VERSIONS.codex}\n`),
    stderr: Buffer.alloc(0), ...overrides };
}

function certificationParentFixture({
  zeroRetry = true,
  analyticsDisabled = true,
  pluginsEnabled = true,
  appsDisabled = true,
  remotePluginEnabled = true,
  mcpPolicy = true,
  autoMergeEnabled = true,
  requiredRemoteChecks = false,
  includeRequiredRemoteChecks = true,
} = {}) {
  const root = mkdtempSync(path.join(tmpdir(), 'ape-live-parent-'));
  temporaryRepositories.push(root);
  const projectDir = path.join(root, 'project');
  const codexHome = path.join(root, 'codex-home');
  const promptPath = path.join(root, 'prompt.txt');
  mkdirSync(projectDir, { recursive: true });
  execFileSync('git', ['init', '--initial-branch=main'], { cwd: projectDir, stdio: 'ignore' });
  execFileSync('git', ['config', '--local', 'user.name', 'APE Certification'], { cwd: projectDir });
  execFileSync(
    'git',
    ['config', '--local', 'user.email', 'ape-certification@users.noreply.github.com'],
    { cwd: projectDir },
  );
  mkdirSync(path.join(projectDir, '.ape', 'runtime'), { recursive: true });
  writeFileSync(
    path.join(projectDir, '.ape', 'runtime', 'config.json'),
    `${JSON.stringify({
      shipping: {
        auto_merge: autoMergeEnabled,
        ...(includeRequiredRemoteChecks
          ? { required_remote_checks: requiredRemoteChecks }
          : {}),
      },
    })}\n`,
  );
  mkdirSync(path.join(codexHome, 'plugins', 'cache', 'ape', 'ape', VERSION), { recursive: true });
  const exactProject = realpathSync(projectDir);
  writeFileSync(promptPath, `$ape:run\nPass project_dir "${exactProject}" on every APE MCP call.\n`);
  writeFileSync(
    path.join(codexHome, 'config.toml'),
    [
      'model_provider = "openai-zero-retry"',
      '[model_providers.openai-zero-retry]',
      'name = "OpenAI zero retry"',
      'wire_api = "responses"',
      'requires_openai_auth = true',
      zeroRetry ? 'request_max_retries = 0' : 'request_max_retries = 5',
      'stream_max_retries = 0',
      'supports_websockets = false',
      '[analytics]',
      analyticsDisabled ? 'enabled = false' : 'enabled = true',
      '[features]',
      pluginsEnabled ? 'plugins = true' : 'plugins = false',
      appsDisabled ? 'apps = false' : 'apps = true',
      remotePluginEnabled ? 'remote_plugin = true' : 'remote_plugin = false',
      '[plugins."ape@ape"]',
      'enabled = true',
      ...(mcpPolicy ? [
        '[plugins."ape@ape".mcp_servers.ape]',
        'default_tools_approval_mode = "approve"',
      ] : []),
    ].join('\n'),
  );
  cpSync(fileURLToPath(new URL('../plugins/ape', import.meta.url)),
    path.join(codexHome, 'plugins', 'cache', 'ape', 'ape', VERSION), { recursive: true });
  vi.spyOn(childProcess, 'spawnSync').mockReturnValue(codexVersionResult());
  return {
    projectDir: exactProject,
    codexHome: realpathSync(codexHome),
    promptPath,
    codexBin: realpathSync(process.execPath),
    operatorAuthorized: true,
  };
}

function certificationParentWithConfig(update) {
  const fixture = certificationParentFixture();
  const configPath = path.join(fixture.codexHome, 'config.toml');
  writeFileSync(configPath, update(readFileSync(configPath, 'utf8')));
  return fixture;
}

function expectCertificationConfigRefusal(fixture) {
  let failure;
  try {
    buildCodexParentInvocation(fixture);
  } catch (error) {
    failure = error;
  }
  expect(failure).toBeInstanceOf(LiveCertificationParentError);
  expect(failure.message.length).toBeLessThan(1024);
  expect(failure.message).toMatch(/config|provider|retries|analytics|features|plugins|apps|websockets|TOML|MCP/iu);
  return failure;
}

function hash(number) {
  return number.toString(16).padStart(40, '0');
}

function runRecordHash(number) {
  return number.toString(16).padStart(64, '0');
}

function landProof(sequence) {
  const pushed = hash(100 + sequence);
  const merge = hash(300 + sequence);
  return {
    target_branch: 'main',
    merge_method: 'squash',
    merge_path: 'immediate',
    bypass_used: false,
    required_checks_passed: true,
    checked_head_commit: pushed,
    gate_tree: hash(400 + sequence),
    merged_tree: hash(400 + sequence),
    branch_protection: {
      pull_request_required: true,
      required_checks_strict: true,
      required_checks_count: 1,
      admins_enforced: true,
      force_pushes_allowed: false,
      deletions_allowed: false,
      before_sha256: runRecordHash(500 + sequence),
      after_sha256: runRecordHash(500 + sequence),
    },
    pr_state: 'MERGED',
    pushed_head_commit: pushed,
    observed_merged_pr_head: pushed,
    merge_commit: merge,
    remote_head_after_merge: merge,
  };
}

function cleanAttempt({ sequence, host, pipeline, sourceCommit = SOURCE }) {
  return {
    sequence,
    attempt_id: `${host}-${pipeline}-${sequence}`,
    host,
    host_version: HOST_VERSIONS[host],
    plugin_version: VERSION,
    pipeline,
    source_commit: sourceCommit,
    run_record_sha256: runRecordHash(sequence),
    ticket_count: pipeline === 'mechanical' ? 3 : 9,
    duration_ms: 1_000 + sequence,
    outcome: 'success',
    terminal_reason_code: 'completed',
    manual_intervention: false,
    prompt_assembly_failure: false,
    worker_tool_failure: false,
    control_call_failure: false,
    host_transport_retry: false,
    receipt_repair: false,
    duplicate_dispatch: false,
    remediation: false,
    self_correction: false,
    abort_successor: false,
    protected_land: pipeline === 'protected-branch-land' ? landProof(sequence) : null,
  };
}

function validLedger(sourceCommit = SOURCE) {
  const attempts = [];
  for (const host of LIVE_CERTIFICATION_HOSTS) {
    for (const pipeline of LIVE_CERTIFICATION_PIPELINES) {
      attempts.push(cleanAttempt({
        sequence: attempts.length + 1,
        host,
        pipeline,
        sourceCommit,
      }));
    }
  }
  return {
    schema_version: 5,
    ape_version: VERSION,
    source_commit: sourceCommit,
    certified_hosts: [...LIVE_CERTIFICATION_HOSTS],
    unverified_hosts: [...LIVE_CERTIFICATION_UNVERIFIED_HOSTS],
    terminal_reason_taxonomy_version: TERMINAL_REASON_TAXONOMY_VERSION,
    attempts,
  };
}

function canonical(document) {
  return `${JSON.stringify(document, null, 2)}\n`;
}

function validateLiveCertificationDocument(document, options = {}) {
  return validateDocument(document, {
    packageVersion: VERSION,
    sourceCommit: SOURCE,
    hostVersions: HOST_VERSIONS,
    ...options,
  });
}

function git(repo, ...args) {
  return execFileSync('git', args, {
    cwd: repo,
    encoding: 'utf8',
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'APE Certification Test',
      GIT_AUTHOR_EMAIL: 'ape-certification@example.invalid',
      GIT_COMMITTER_NAME: 'APE Certification Test',
      GIT_COMMITTER_EMAIL: 'ape-certification@example.invalid',
    },
  }).trim();
}

function sourceRepository({
  codexCertification = 'required',
  claudeCertification = 'unverified',
  extraHost = false,
} = {}) {
  const repo = mkdtempSync(path.join(tmpdir(), 'ape-live-certification-'));
  temporaryRepositories.push(repo);
  git(repo, 'init', '--initial-branch=main');
  mkdirSync(path.join(repo, 'evals'));
  writeFileSync(path.join(repo, 'package.json'), canonical({ name: 'ape', version: VERSION }));
  writeFileSync(path.join(repo, 'compatibility.json'), canonical({
    version: 2,
    hosts: {
      codex: {
        package: '@openai/codex',
        version: HOST_VERSIONS.codex,
        live_certification: codexCertification,
      },
      claude: {
        package: '@anthropic-ai/claude-code',
        version: HOST_VERSIONS.claude,
        live_certification: claudeCertification,
      },
      ...(extraHost ? {
        other: {
          package: '@example/other-host',
          version: '1.0.0',
          live_certification: 'unverified',
        },
      } : {}),
    },
  }));
  writeFileSync(path.join(repo, 'source.txt'), 'tested source\n');
  git(repo, 'add', 'package.json', 'compatibility.json', 'source.txt');
  git(repo, 'commit', '-m', 'source candidate');
  return { repo, source: git(repo, 'rev-parse', 'HEAD') };
}

function certificationCommit({
  extraPath = null,
  sourceOverride = null,
  codexCertification = 'required',
  claudeCertification = 'unverified',
  extraHost = false,
} = {}) {
  const { repo, source } = sourceRepository({
    codexCertification,
    claudeCertification,
    extraHost,
  });
  const document = validLedger(sourceOverride ?? source);
  writeFileSync(path.join(repo, 'evals', 'live-certification.json'), canonical(document));
  git(repo, 'add', 'evals/live-certification.json');
  if (extraPath) {
    writeFileSync(path.join(repo, extraPath), 'not certification evidence\n');
    git(repo, 'add', extraPath);
  }
  git(repo, 'commit', '-m', 'certify live hosts');
  const head = git(repo, 'rev-parse', 'HEAD');
  git(repo, 'tag', `v${VERSION}`);
  return { repo, source, head };
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const directory of temporaryRepositories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe('live certification Codex parent launcher', () => {
  it('MCP permission requirements name actual mutable tools from the canonical MCP catalog', async () => {
    const { handle } = await import('../bin/ape-mcp.mjs');
    const catalog = await handle({ jsonrpc: '2.0', id: 'approval-catalog', method: 'tools/list', params: {} });
    for (const name of CERTIFICATION_APE_TOOLS) {
      const tool = catalog.result.tools.find((entry) => entry.name === name);
      expect(tool).toBeDefined();
      expect(tool.annotations?.readOnlyHint).not.toBe(true);
    }
  });

  it('MCP permission refuses the historical missing-policy setup before a host subprocess', () => {
    const fixture = certificationParentFixture({ mcpPolicy: false });
    const configPath = path.join(fixture.codexHome, 'config.toml');
    const before = readFileSync(configPath, 'utf8');
    expect(() => buildCodexParentInvocation(fixture)).toThrow(/MCP.*approval/iu);
    expect(childProcess.spawnSync).not.toHaveBeenCalled();
    expect(readFileSync(configPath, 'utf8')).toBe(before);
  });

  it.each(CERTIFICATION_APE_TOOLS)(
    'MCP permission refuses a later prompt for required tool %s', (tool) => {
      const fixture = certificationParentWithConfig((config) => `${config}\n[plugins."ape@ape".mcp_servers.ape.tools.${tool}]\napproval_mode = "prompt"\n`);
      expect(() => buildCodexParentInvocation(fixture)).toThrow(new RegExp(`MCP.*${tool}`, 'iu'));
      expect(childProcess.spawnSync).not.toHaveBeenCalled();
    },
  );

  it.each([
    ['plugin disabled', (c) => c.replace('[plugins."ape@ape"]\nenabled = true', '[plugins."ape@ape"]\nenabled = false')],
    ['wrong plugin', (c) => c.replaceAll('"ape@ape"', '"other@other"')],
    ['wrong server', (c) => c.replaceAll('mcp_servers.ape]', 'mcp_servers.other]')],
    ['server disabled', (c) => `${c}\nenabled = false`],
    ['missing server policy', (c) => c.replace('[plugins."ape@ape".mcp_servers.ape]', '[unrelated]')],
    ['shadowing server', (c) => `${c}\n[mcp_servers.ape]\ndefault_tools_approval_mode = "approve"`],
    ['auto approval', (c) => c.replace('= "approve"', '= "auto"')],
    ['write approval prompts', (c) => c.replace('= "approve"', '= "writes"')],
    ['invalid approval value', (c) => c.replace('= "approve"', '= "SYNTHETIC_SECRET"')],
    ['missing worker from allowlist', (c) => `${c}\nenabled_tools = ["ape_config", "ape_run"]`],
    ['disabled worker tool', (c) => `${c}\ndisabled_tools = ["ape_validate_receipt"]`],
    ['malformed allowlist', (c) => `${c}\nenabled_tools = "SYNTHETIC_SECRET"`],
    ['malformed denylist entry', (c) => `${c}\ndisabled_tools = [1]`],
    ['malformed tool table', (c) => `${c}\ntools = ["SYNTHETIC_SECRET"]`],
    ['malformed worker policy', (c) => `${c}\ntools.ape_bind = false`],
  ])('MCP permission rejects %s without mutating config or running a host', (_name, update) => {
    const fixture = certificationParentWithConfig(update);
    const configPath = path.join(fixture.codexHome, 'config.toml');
    const before = readFileSync(configPath, 'utf8');
    const failure = expectCertificationConfigRefusal(fixture);
    expect(failure.message).toMatch(/MCP.*approval/iu);
    expect(failure.message).not.toContain('SYNTHETIC_SECRET');
    expect(childProcess.spawnSync).not.toHaveBeenCalled();
    expect(readFileSync(configPath, 'utf8')).toBe(before);
  });

  it.each(['prompt', 'missing'])('MCP permission accepts exact per-tool approval over a %s server default', (mode) => {
    const fixture = certificationParentWithConfig((c) => [
      c.replace('default_tools_approval_mode = "approve"', mode === 'missing' ? '' : 'default_tools_approval_mode = "prompt"'),
      ...CERTIFICATION_APE_TOOLS.map((name) => `[plugins."ape@ape".mcp_servers.ape.tools.${name}]\napproval_mode = "approve"`),
    ].join('\n'));
    expect(buildCodexParentInvocation(fixture).command).toBe(fixture.codexBin);
  });

  it('MCP permission accepts a complete allowlist and unrelated denied tool', () => {
    const fixture = certificationParentWithConfig((c) => `${c}\nenabled_tools = ${JSON.stringify(CERTIFICATION_APE_TOOLS)}\ndisabled_tools = ["ape_history"]`);
    expect(buildCodexParentInvocation(fixture).command).toBe(fixture.codexBin);
  });

  it.each([{ extraArgs: [] }, { extraArgs: ['--dry-run'] }])('MCP permission real CLI rejects missing policy before any host subprocess ($extraArgs)', ({ extraArgs }) => {
    const fixture = certificationParentFixture({ mcpPolicy: false });
    const checked = realSpawnSync(process.execPath, [
      fileURLToPath(new URL('../scripts/run-live-certification-parent.mjs', import.meta.url)),
      '--project-dir', fixture.projectDir, '--codex-home', fixture.codexHome,
      '--prompt', fixture.promptPath, '--codex-bin', process.execPath, '--operator-authorized', ...extraArgs,
    ], { encoding: 'utf8', timeout: 5_000, maxBuffer: 4_096 });
    expect(checked.status).toBe(1);
    expect(checked.stdout).toBe('');
    expect(checked.stderr).toMatch(/MCP.*approval/iu);
    expect(checked.stderr).not.toMatch(/version check/iu);
  });

  it.each([undefined, false, 'true', 1])('operator authorization rejects %s before any host subprocess', (operatorAuthorized) => {
    const fixture = certificationParentFixture();
    expect(() => buildCodexParentInvocation({ ...fixture, operatorAuthorized }))
      .toThrow(/--operator-authorized.*explicit.*approval/iu);
    expect(childProcess.spawnSync).not.toHaveBeenCalled();
  });

  it('operator authorization reaches the parent separately from the unchanged generated prompt', () => {
    const fixture = certificationParentFixture();
    const prompt = `${readFileSync(fixture.promptPath, 'utf8')}This generated prompt is not evidence of operator approval.\n`;
    writeFileSync(fixture.promptPath, prompt);
    const invocation = buildCodexParentInvocation(fixture);
    expect(invocation.input).toContain('Separate operator authorization handoff');
    expect(invocation.input).toContain(`project_dir ${JSON.stringify(fixture.projectDir)}`);
    expect(invocation.input).toContain('the user has explicitly approved this exact attempt');
    expect(invocation.input).toContain('not independent proof of human provenance');
    expect(invocation.input).toContain('does not grant hook trust, repository permissions, or a gate waiver');
    expect(invocation.input.endsWith(`\n\n${prompt}`)).toBe(true);
    expect(readFileSync(fixture.promptPath, 'utf8')).toBe(prompt);
  });

  it('operator authorization is required by the real CLI before project or host checks', () => {
    const checked = realSpawnSync(process.execPath, [
      fileURLToPath(new URL('../scripts/run-live-certification-parent.mjs', import.meta.url)),
      '--dry-run',
    ], { encoding: 'utf8', timeout: 5_000, maxBuffer: 4_096 });
    expect(checked.error).toBeUndefined();
    expect(checked.status).toBe(1);
    expect(checked.stdout).toBe('');
    expect(checked.stderr).toMatch(/--operator-authorized.*explicit.*approval/iu);
  });

  it('host pin binds the explicitly selected resolved executable before producing a parent invocation', () => {
    const fixture = certificationParentFixture();
    const invocation = buildCodexParentInvocation(fixture);
    expect(invocation.command).toBe(fixture.codexBin);
    expect(childProcess.spawnSync).toHaveBeenCalledExactlyOnceWith(fixture.codexBin, ['--version'], {
      cwd: fixture.projectDir,
      env: { ...process.env, CODEX_HOME: fixture.codexHome },
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 5_000,
      killSignal: 'SIGKILL',
      maxBuffer: 4_096,
      windowsHide: true,
      shell: false,
    });
    expect(invocation.host_version).toBe(HOST_VERSIONS.codex);
  });

  it.each([undefined, '', 'codex', './codex', 7, null])('host pin rejects missing or non-absolute executable %s without running it', (codexBin) => {
    const fixture = certificationParentFixture();
    expect(() => buildCodexParentInvocation({ ...fixture, codexBin })).toThrow(/absolute.*--codex-bin/iu);
    expect(childProcess.spawnSync).not.toHaveBeenCalled();
  });

  it.each(['missing', 'directory', 'non-executable'])('host pin rejects a %s executable before probing', (kind) => {
    const fixture = certificationParentFixture();
    const codexBin = path.join(path.dirname(fixture.projectDir), 'invalid-codex');
    if (kind === 'directory') mkdirSync(codexBin);
    if (kind === 'non-executable') writeFileSync(codexBin, 'not executable\n', { mode: 0o600 });
    // Windows executable validity is established by CreateProcess, not POSIX mode bits.
    if (kind === 'non-executable' && process.platform === 'win32') {
      childProcess.spawnSync.mockReturnValue(codexVersionResult({ error: new Error('EACCES'), status: null }));
    }
    expect(() => buildCodexParentInvocation({ ...fixture, codexBin })).toThrow(/--codex-bin|version check/iu);
  });

  it.each([
    ['wrong pin', { stdout: Buffer.from('codex-cli 0.148.0\n') }],
    ['missing version', { stdout: Buffer.alloc(0) }],
    ['malformed version', { stdout: Buffer.from('0.147.0\n') }],
    ['extra version lines', { stdout: Buffer.from('codex-cli 0.147.0\ncodex-cli 0.148.0\n') }],
    ['invalid UTF-8', { stdout: Buffer.from([0xff]) }],
    ['failed process', { status: 1 }],
    ['terminated process', { status: null, signal: 'SIGKILL' }],
    ['timeout', { status: null, error: Object.assign(new Error('SYNTHETIC_SECRET'), { code: 'ETIMEDOUT' }) }],
    ['spawn failure', { status: null, error: Object.assign(new Error('SYNTHETIC_SECRET'), { code: 'ENOENT' }) }],
    ['oversized stdout', { stdout: Buffer.alloc(4_097, 120) }],
    ['oversized stderr', { stderr: Buffer.alloc(4_097, 120) }],
    ['oversized combined output', { stdout: Buffer.from(`codex-cli ${HOST_VERSIONS.codex}\n`), stderr: Buffer.alloc(4_090, 120) }],
    ['unexpected result shape', { stdout: undefined }],
  ])('host pin refuses %s with bounded sanitized guidance', (_name, result) => {
    const fixture = certificationParentFixture();
    childProcess.spawnSync.mockReturnValue(codexVersionResult(result));
    let failure;
    try { buildCodexParentInvocation(fixture); } catch (error) { failure = error; }
    expect(failure).toBeInstanceOf(LiveCertificationParentError);
    expect(failure.message).toMatch(/Codex.*version|Codex.*0\.147\.0/iu);
    expect(failure.message.length).toBeLessThan(400);
    expect(failure.message).not.toContain('SYNTHETIC_SECRET');
    expect(failure.message).not.toContain(fixture.codexBin);
  });

  it('host pin accepts CRLF version output from the exact supported host', () => {
    const fixture = certificationParentFixture();
    childProcess.spawnSync.mockReturnValue(codexVersionResult({ stdout: Buffer.from(`codex-cli ${HOST_VERSIONS.codex}\r\n`) }));
    expect(buildCodexParentInvocation(fixture).host_version).toBe(HOST_VERSIONS.codex);
  });

  it.skipIf(process.platform === 'win32')('host pin resolves a symlink once and invokes its absolute target', () => {
    const fixture = certificationParentFixture();
    const link = path.join(path.dirname(fixture.projectDir), 'codex-link');
    symlinkSync(fixture.codexBin, link);
    expect(buildCodexParentInvocation({ ...fixture, codexBin: link }).command).toBe(fixture.codexBin);
    expect(childProcess.spawnSync.mock.calls[0][0]).toBe(fixture.codexBin);
  });

  it('host pin checks the real executable in CLI dry-run without starting a parent', () => {
    const fixture = certificationParentFixture();
    const checked = realSpawnSync(process.execPath, [
      fileURLToPath(new URL('../scripts/run-live-certification-parent.mjs', import.meta.url)),
      '--project-dir', fixture.projectDir, '--codex-home', fixture.codexHome,
      '--prompt', fixture.promptPath, '--codex-bin', process.execPath, '--operator-authorized', '--dry-run',
    ], { encoding: 'utf8', timeout: 10_000, maxBuffer: 4_096 });
    expect(checked.error).toBeUndefined();
    expect(checked.status).toBe(1);
    expect(checked.stdout).toBe('');
    expect(checked.stderr).toMatch(/Codex.*0\.147\.0/iu);
  });

  it('host pin rejects executable metadata drift during the version check', () => {
    const fixture = certificationParentFixture();
    const codexBin = path.join(path.dirname(fixture.projectDir), 'changed-codex');
    writeFileSync(codexBin, 'synthetic executable\n', { mode: 0o700 });
    childProcess.spawnSync.mockImplementation(() => {
      writeFileSync(codexBin, 'replacement synthetic executable\n');
      return codexVersionResult();
    });
    expect(() => buildCodexParentInvocation({ ...fixture, codexBin })).toThrow(/Codex version check/iu);
  });

  it.skipIf(process.platform === 'win32' || /\s/u.test(process.execPath)).each([
    ['success', `process.stdout.write('codex-cli ${HOST_VERSIONS.codex}\\n');`, 0],
    ['oversized diagnostics', "process.stderr.write('SYNTHETIC_SECRET'.repeat(10000)); setInterval(() => {}, 1000);", 1],
    ['timeout despite ignored SIGTERM', "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000);", 1],
  ])('host pin CLI subprocess handles %s before any parent launch', (_name, body, expectedStatus) => {
    const fixture = certificationParentFixture();
    const codexBin = path.join(path.dirname(fixture.projectDir), 'synthetic-codex.mjs');
    // Direct Node shebang, not a shell shim; Windows uses the portable mocked boundary above.
    writeFileSync(codexBin, `#!${process.execPath}\nif (process.argv.length !== 3 || process.argv[2] !== '--version') process.exit(77);\n${body}\n`, { mode: 0o700 });
    const checked = realSpawnSync(process.execPath, [
      fileURLToPath(new URL('../scripts/run-live-certification-parent.mjs', import.meta.url)),
      '--project-dir', fixture.projectDir, '--codex-home', fixture.codexHome,
      '--prompt', fixture.promptPath, '--codex-bin', codexBin, '--operator-authorized', '--dry-run',
    ], { encoding: 'utf8', timeout: 10_000, maxBuffer: 4_096 });
    expect(checked.error).toBeUndefined();
    expect(checked.status).toBe(expectedStatus);
    expect(checked.stderr).not.toContain('SYNTHETIC_SECRET');
    if (expectedStatus === 0) {
      expect(JSON.parse(checked.stdout)).toMatchObject({ command: realpathSync(codexBin), host_version: HOST_VERSIONS.codex });
      expect(checked.stderr).toBe('');
    } else {
      expect(checked.stdout).toBe('');
      expect(checked.stderr).toMatch(/Codex version check.*5 seconds.*4096/iu);
    }
  }, 12_000);

  it('preserves sandbox and hook trust while using the exact staged candidate and zero-retry home', () => {
    const fixture = certificationParentFixture();
    const invocation = buildCodexParentInvocation(fixture);
    expect(invocation.command).toBe(fixture.codexBin);
    expect(invocation.args).toEqual([
      'exec',
      '-c',
      'chatgpt_base_url="http://127.0.0.1:1"',
      '-c',
      'features.apps=false',
      '--sandbox',
      'workspace-write',
      '--color',
      'never',
      '-C',
      fixture.projectDir,
      '-',
    ]);
    expect(invocation.env).toEqual({
      CODEX_HOME: fixture.codexHome,
      GIT_AUTHOR_NAME: 'APE Certification',
      GIT_AUTHOR_EMAIL: 'ape-certification@users.noreply.github.com',
      GIT_COMMITTER_NAME: 'APE Certification',
      GIT_COMMITTER_EMAIL: 'ape-certification@users.noreply.github.com',
    });
    expect(invocation.input.endsWith(
      `\n\n$ape:run\nPass project_dir "${fixture.projectDir}" on every APE MCP call.\n`,
    )).toBe(true);
    expect(invocation.operator_authorized).toBe(true);
    expect(invocation.candidate_package).toMatchObject({ version: VERSION, staged_parity: true });
    expect(invocation.candidate_package.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(invocation.candidate_package.file_count).toBeGreaterThan(1);
    expect(invocation.candidate_package).not.toHaveProperty('loaded');
    expect(invocation.args.join(' ')).not.toMatch(/bypass|danger-full-access|approval_policy="never"/);
  });

  it.each(['changed', 'missing', 'extra', 'symlink'])('rejects same-version candidate bytes that are %s', (kind) => {
    const fixture = certificationParentFixture();
    const cached = path.join(fixture.codexHome, 'plugins', 'cache', 'ape', 'ape', VERSION);
    const manifest = path.join(cached, '.codex-plugin', 'plugin.json');
    if (kind === 'changed') writeFileSync(manifest, `${readFileSync(manifest, 'utf8')} `);
    if (kind === 'missing' || kind === 'symlink') rmSync(manifest);
    if (kind === 'extra') writeFileSync(path.join(cached, 'extra-authority.json'), '{}');
    if (kind === 'symlink') symlinkSync(path.join(cached, 'package.json'), manifest);
    expect(() => buildCodexParentInvocation(fixture)).toThrow(/candidate package.*(?:parity|regular|symlink)/i);
  });

  it('fails closed before launch when automatic transport retries are enabled', () => {
    const fixture = certificationParentFixture({ zeroRetry: false });
    expect(() => buildCodexParentInvocation(fixture)).toThrow(LiveCertificationParentError);
    expect(() => buildCodexParentInvocation(fixture)).toThrow(/request_max_retries = 0/iu);
  });

  it.each([
    ['selected retries are nonzero', (config) => config.replace('request_max_retries = 0', 'request_max_retries = 5')],
    ['selected retry fields are absent', (config) => config.replace(/^(?:request_max_retries|stream_max_retries|supports_websockets) = .*\n/gmu, '')],
    ['selected provider is absent', (config) => config.replace('[model_providers.openai-zero-retry]', '[model_providers.another-provider]')],
  ])('does not borrow zero-retry declarations from an inactive provider when %s', (_name, update) => {
    const fixture = certificationParentWithConfig((config) => `${update(config)}\n${[
      '[model_providers.inactive-zero-retry]',
      'name = "Inactive provider"',
      'wire_api = "responses"',
      'request_max_retries = 0',
      'stream_max_retries = 0',
      'supports_websockets = false',
    ].join('\n')}\n`);
    expectCertificationConfigRefusal(fixture);
  });

  it('does not borrow zero-retry declarations from the top level', () => {
    const fixture = certificationParentWithConfig((config) => [
      'request_max_retries = 0',
      'stream_max_retries = 0',
      'supports_websockets = false',
      config.replace(/^(?:request_max_retries|stream_max_retries|supports_websockets) = .*\n/gmu, ''),
    ].join('\n'));
    expectCertificationConfigRefusal(fixture);
  });

  it('requires model_provider at the top level, not under an unrelated table', () => {
    const fixture = certificationParentWithConfig((config) => `[unrelated]\n${config}`);
    expectCertificationConfigRefusal(fixture);
  });

  it.each(['"""', "'''"])('does not interpret assignments in a %s multiline string as configuration', (delimiter) => {
    const fixture = certificationParentWithConfig((config) => [
      `notes = ${delimiter}`,
      'model_provider = "openai-zero-retry"',
      'request_max_retries = 0',
      'stream_max_retries = 0',
      'supports_websockets = false',
      '[analytics]',
      'enabled = false',
      '[features]',
      'plugins = true',
      'apps = false',
      'remote_plugin = true',
      delimiter,
      config.replace('request_max_retries = 0', 'request_max_retries = 5'),
    ].join('\n'));
    expectCertificationConfigRefusal(fixture);
  });

  it.each([
    ['malformed table', (config) => `${config}\n[broken\n`],
    ['duplicate scalar key', (config) => config.replace('request_max_retries = 0', 'request_max_retries = 0\nrequest_max_retries = 0')],
    ['duplicate quoted key', (config) => config.replace('request_max_retries = 0', 'request_max_retries = 0\n"request_max_retries" = 0')],
    ['duplicate table', (config) => `${config}\n[analytics]\nenabled = false\n`],
    ['numeric model_provider', (config) => config.replace('model_provider = "openai-zero-retry"', 'model_provider = 7')],
    ['missing model_provider', (config) => config.replace('model_provider = "openai-zero-retry"\n', '')],
    ['empty model_provider', (config) => config.replace('model_provider = "openai-zero-retry"', 'model_provider = ""')],
    ['missing selected provider name', (config) => config.replace('name = "OpenAI zero retry"\n', '')],
    ['numeric selected provider name', (config) => config.replace('name = "OpenAI zero retry"', 'name = 7')],
    ['empty selected provider name', (config) => config.replace('name = "OpenAI zero retry"', 'name = "  "')],
    ['string request retry count', (config) => config.replace('request_max_retries = 0', 'request_max_retries = "0"')],
    ['boolean request retry count', (config) => config.replace('request_max_retries = 0', 'request_max_retries = false')],
    ['float zero request retry count', (config) => config.replace('request_max_retries = 0', 'request_max_retries = 0.0')],
    ['exponent zero stream retry count', (config) => config.replace('stream_max_retries = 0', 'stream_max_retries = 0e0')],
    ['array stream retry count', (config) => config.replace('stream_max_retries = 0', 'stream_max_retries = [0]')],
    ['fractional stream retry count', (config) => config.replace('stream_max_retries = 0', 'stream_max_retries = 0.5')],
    ['string websocket flag', (config) => config.replace('supports_websockets = false', 'supports_websockets = "false"')],
    ['missing request retry count', (config) => config.replace('request_max_retries = 0\n', '')],
    ['missing stream retry count', (config) => config.replace('stream_max_retries = 0\n', '')],
    ['missing websocket flag', (config) => config.replace('supports_websockets = false\n', '')],
    ['string analytics flag', (config) => config.replace('enabled = false', 'enabled = "false"')],
    ['missing analytics flag', (config) => config.replace('enabled = false\n', '')],
    ['string plugin flag', (config) => config.replace('plugins = true', 'plugins = "true"')],
    ['string apps flag', (config) => config.replace('apps = false', 'apps = "false"')],
    ['string remote plugin flag', (config) => config.replace('remote_plugin = true', 'remote_plugin = "true"')],
  ])('rejects invalid or incomplete TOML configuration: %s', (_name, update) => {
    expectCertificationConfigRefusal(certificationParentWithConfig(update));
  });

  it.each([
    ['an unrelated provider with retries enabled', (config) => `${config}\n${[
      '[model_providers.unrelated]',
      'name = "Unrelated provider"',
      'wire_api = "responses"',
      'request_max_retries = 5',
      'stream_max_retries = 5',
      'supports_websockets = true',
    ].join('\n')}\n`],
    ['quoted table and field names', (config) => config
      .replace('[model_providers.openai-zero-retry]', '["model_providers"."openai-zero-retry"]')
      .replace('[analytics]', '["analytics"]')
      .replace('[features]', '["features"]')
      .replace(/^([a-z_]+)(\s*=)/gmu, '"$1"$2')],
    ['dotted keys and literal strings', () => [
      "model_provider = 'openai-zero-retry'",
      "model_providers.openai-zero-retry.name = 'OpenAI zero retry'",
      "model_providers.openai-zero-retry.wire_api = 'responses'",
      'model_providers.openai-zero-retry.requires_openai_auth = true',
      'model_providers.openai-zero-retry.request_max_retries = 0',
      'model_providers.openai-zero-retry.stream_max_retries = 0',
      'model_providers.openai-zero-retry.supports_websockets = false',
      'analytics.enabled = false',
      'features.plugins = true',
      'features.apps = false',
      'features.remote_plugin = true',
      'plugins."ape@ape".enabled = true',
      'plugins."ape@ape".mcp_servers.ape.default_tools_approval_mode = "approve"',
    ].join('\n')],
    ['inline tables', () => [
      'model_provider = "openai-zero-retry"',
      'model_providers = { openai-zero-retry = { name = "OpenAI zero retry", wire_api = "responses", requires_openai_auth = true, request_max_retries = 0, stream_max_retries = 0, supports_websockets = false } }',
      'analytics = { enabled = false }',
      'features = { plugins = true, apps = false, remote_plugin = true }',
      'plugins = { "ape@ape" = { enabled = true, mcp_servers = { ape = { default_tools_approval_mode = "approve" } } } }',
    ].join('\n')],
    ['valid trailing comments', (config) => config.split('\n').map((line) => `${line} # certification setting`).join('\n')],
  ])('accepts the actual selected zero-retry provider with %s', (_name, update) => {
    const invocation = buildCodexParentInvocation(certificationParentWithConfig(update));
    expect(invocation.command).toBe(realpathSync(process.execPath));
    expect(invocation.candidate_package.staged_parity).toBe(true);
  });

  it.each(['openai', 'ollama', 'lmstudio', 'amazon-bedrock'])('rejects reserved built-in provider %s with custom-provider guidance', (providerId) => {
    const fixture = certificationParentWithConfig((config) => config.replaceAll('openai-zero-retry', providerId));
    const failure = expectCertificationConfigRefusal(fixture);
    expect(failure.message).toMatch(/custom model_provider.*zero retries.*built-in/iu);
  });

  it.each(['openai', 'ollama', 'lmstudio'])('rejects a redefined inactive built-in provider %s before host loading', (providerId) => {
    const fixture = certificationParentWithConfig((config) => `${config}\n${[
      `[model_providers.${providerId}]`,
      'name = "Inactive built-in override"',
      'wire_api = "responses"',
      'request_max_retries = 0',
      'stream_max_retries = 0',
      'supports_websockets = false',
    ].join('\n')}\n`);
    const failure = expectCertificationConfigRefusal(fixture);
    expect(failure.message).toMatch(/reserved built-in.*inactive.*custom provider name/iu);
  });

  it('allows supported inactive Bedrock AWS overrides without borrowing their settings', () => {
    const fixture = certificationParentWithConfig((config) => `${config}\n${[
      '[model_providers.amazon-bedrock.aws]',
      'region = "us-east-1"',
      'profile = "synthetic"',
    ].join('\n')}\n`);
    expect(buildCodexParentInvocation(fixture).command).toBe(fixture.codexBin);
  });

  it.each([
    ['selected profile', (config) => `profile = "certification"\n${config}`],
    ['profile definitions', (config) => `${config}\n[profiles.certification]\nmodel_provider = "openai-zero-retry"\n`],
  ])('rejects %s with explicit flattening guidance', (_name, update) => {
    const failure = expectCertificationConfigRefusal(certificationParentWithConfig(update));
    expect(failure.message).toMatch(/profile.*flatten.*config\.toml/iu);
  });

  it.each(['symlink', 'directory'])('rejects a config.toml %s before reading it', (kind) => {
    const fixture = certificationParentFixture();
    const configPath = path.join(fixture.codexHome, 'config.toml');
    const contents = readFileSync(configPath);
    rmSync(configPath);
    if (kind === 'symlink') {
      const target = path.join(fixture.codexHome, 'reviewed-source.toml');
      writeFileSync(target, contents);
      symlinkSync(target, configPath);
    } else {
      mkdirSync(configPath);
    }
    const failure = expectCertificationConfigRefusal(fixture);
    expect(failure.message).toMatch(/regular file.*symlinks/iu);
  });

  it.skipIf(process.platform === 'win32')('rejects a config.toml FIFO without blocking on its contents', () => {
    const fixture = certificationParentFixture();
    const configPath = path.join(fixture.codexHome, 'config.toml');
    rmSync(configPath);
    execFileSync('mkfifo', [configPath], { timeout: 2_000 });
    // Isolate the real synchronous admission call so a broken reader cannot hang Vitest.
    const launcher = new URL('../scripts/run-live-certification-parent.mjs', import.meta.url).href;
    const checked = spawnSync(process.execPath, ['--input-type=module', '-e', [
      `import { buildCodexParentInvocation } from ${JSON.stringify(launcher)};`,
      'try {',
      '  buildCodexParentInvocation(JSON.parse(process.argv[1]));',
      '  process.exitCode = 2;',
      '} catch (error) {',
      '  process.stdout.write(JSON.stringify({ name: error.name, message: error.message }));',
      '  process.exitCode = 1;',
      '}',
    ].join('\n'), JSON.stringify(fixture)], {
      encoding: 'utf8', timeout: 2_000, maxBuffer: 4_096,
    });
    expect(checked.error).toBeUndefined();
    expect(checked.signal).toBeNull();
    expect(checked.status).toBe(1);
    expect(JSON.parse(checked.stdout)).toMatchObject({
      name: 'LiveCertificationParentError',
      message: expect.stringMatching(/regular file/iu),
    });
  });

  it.each([0, 1])('enforces the 256 KiB byte boundary at limit plus %i', (extraBytes) => {
    const fixture = certificationParentWithConfig((config) => {
      const prefix = `${config}\n#`;
      return `${prefix}${'x'.repeat((256 * 1024) + extraBytes - Buffer.byteLength(prefix))}`;
    });
    expect(readFileSync(path.join(fixture.codexHome, 'config.toml')).length).toBe((256 * 1024) + extraBytes);
    if (extraBytes === 0) {
      expect(buildCodexParentInvocation(fixture).command).toBe(fixture.codexBin);
    } else {
      expect(expectCertificationConfigRefusal(fixture).message).toMatch(/262144 bytes/iu);
    }
  });

  it('rejects invalid UTF-8 even in a TOML comment', () => {
    const fixture = certificationParentFixture();
    const configPath = path.join(fixture.codexHome, 'config.toml');
    writeFileSync(configPath, Buffer.concat([
      readFileSync(configPath), Buffer.from('\n#'), Buffer.from([0xff]),
    ]));
    expect(expectCertificationConfigRefusal(fixture).message).toMatch(/UTF-8/iu);
  });

  it('does not leak configuration lines through a TOML parser error', () => {
    const sentinel = 'SYNTHETIC_NOT_A_REAL_CREDENTIAL_8a6c';
    const fixture = certificationParentWithConfig((config) => `${config}\nsecret = "${sentinel}" trailing-invalid-token\n`);
    const failure = expectCertificationConfigRefusal(fixture);
    expect(failure.message).toMatch(/valid TOML.*correct.*before launch/iu);
    expect(failure.message).not.toContain(sentinel);
    expect(failure.message).not.toContain('secret =');
    expect(failure.message).not.toContain('trailing-invalid-token');
  });

  it.each([
    ['dotted-key depth', (config) => `${Array(34).fill('nested').join('.')} = true\n${config}`],
    ['inline-table depth', (config) => `nested = ${'{ nested = '.repeat(34)}true${' }'.repeat(34)}\n${config}`],
    ['parsed node count', (config) => `many_nodes = [${Array(10_001).fill('true').join(',')}]\n${config}`],
  ])('rejects excessive %s before launcher admission', (_name, update) => {
    const failure = expectCertificationConfigRefusal(certificationParentWithConfig(update));
    expect(failure.message).toMatch(/nesting|depth|nodes|bounded/iu);
  });

  it('fails closed before launch when optional analytics transport is enabled', () => {
    const fixture = certificationParentFixture({ analyticsDisabled: false });
    expect(() => buildCodexParentInvocation(fixture)).toThrow(LiveCertificationParentError);
    expect(() => buildCodexParentInvocation(fixture)).toThrow(
      /disable analytics.*transport retries/iu,
    );
  });

  it('fails closed before launch when local plugins are disabled', () => {
    const fixture = certificationParentFixture({ pluginsEnabled: false });
    expect(() => buildCodexParentInvocation(fixture)).toThrow(LiveCertificationParentError);
    expect(() => buildCodexParentInvocation(fixture)).toThrow(
      /enable plugins.*local APE plugin/iu,
    );
  });

  it('fails closed before launch when the unrelated Apps MCP transport is enabled', () => {
    const fixture = certificationParentFixture({ appsDisabled: false });
    expect(() => buildCodexParentInvocation(fixture)).toThrow(LiveCertificationParentError);
    expect(() => buildCodexParentInvocation(fixture)).toThrow(
      /disable apps.*Apps MCP transport/iu,
    );
  });

  it('fails closed before launch when Codex could fall back to legacy curated-plugin sync', () => {
    const fixture = certificationParentFixture({ remotePluginEnabled: false });
    expect(() => buildCodexParentInvocation(fixture)).toThrow(LiveCertificationParentError);
    expect(() => buildCodexParentInvocation(fixture)).toThrow(
      /enable remote_plugin.*legacy curated-plugin sync/iu,
    );
  });

  it('fails closed before launch when APE automatic shipping is not explicitly enabled', () => {
    const fixture = certificationParentFixture({ autoMergeEnabled: false });
    expect(() => buildCodexParentInvocation(fixture)).toThrow(LiveCertificationParentError);
    expect(() => buildCodexParentInvocation(fixture)).toThrow(
      /shipping\.auto_merge = true.*first-pass-perfect/iu,
    );
  });

  it('fails closed before launch when the effective Git identity is overridden', () => {
    const fixture = certificationParentFixture();
    execFileSync('git', ['config', '--local', 'user.email', 'developer@example.invalid'], {
      cwd: fixture.projectDir,
    });
    expect(() => buildCodexParentInvocation(fixture)).toThrow(
      /exact APE Certification repository-local GitHub noreply user\.email/iu,
    );
  });

  it('fails closed before launch when the repository remote-check policy is implicit', () => {
    const fixture = certificationParentFixture({ includeRequiredRemoteChecks: false });
    expect(() => buildCodexParentInvocation(fixture)).toThrow(LiveCertificationParentError);
    expect(() => buildCodexParentInvocation(fixture)).toThrow(
      /shipping\.required_remote_checks.*CI topology.*first-pass-perfect/iu,
    );
  });

  it('serves only deterministic empty catalog responses and audits every request', async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'ape-live-catalog-test-'));
    temporaryRepositories.push(root);
    const auditPath = path.join(root, 'requests.jsonl');
    const stub = await startCertificationCatalogStub(auditPath);
    try {
      const requests = [
        '/api/codex/settings/user',
        '/ps/plugins/suggested?scope=GLOBAL',
        '/ps/plugins/list?scope=GLOBAL&limit=200',
        '/ps/plugins/installed?scope=GLOBAL&includeDownloadUrls=true',
        '/ps/plugins/workspace/shared?limit=200',
        '/plugins/featured?platform=codex',
      ];
      const responses = await Promise.all(requests.map((request) => fetch(`${stub.baseUrl}${request}`)));
      expect(responses.every((response) => response.status === 200)).toBe(true);
      expect(await responses[0].json()).toEqual({ commit_attribution_enabled: false });
      expect(await responses[1].json()).toEqual({ enabled: true, plugins: [] });
      expect(await responses[2].json()).toEqual({
        plugins: [],
        pagination: { next_page_token: null },
      });
      expect(await responses[5].json()).toEqual([]);
      expect(validateCertificationCatalogAudit(auditPath)).toEqual({ request_count: 6 });
    } finally {
      await stopCertificationCatalogStub(stub);
    }
  });

  it('rejects any catalog request outside the pinned Codex startup contract', async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'ape-live-catalog-reject-'));
    temporaryRepositories.push(root);
    const auditPath = path.join(root, 'requests.jsonl');
    const stub = await startCertificationCatalogStub(auditPath);
    try {
      const response = await fetch(`${stub.baseUrl}/unknown`);
      expect(response.status).toBe(404);
      expect(() => validateCertificationCatalogAudit(auditPath)).toThrow(
        /rejected unexpected request GET \/unknown/iu,
      );
    } finally {
      await stopCertificationCatalogStub(stub);
    }
  });

  it('fails closed when the prompt omits or misstates the governed project root', () => {
    const fixture = certificationParentFixture();
    writeFileSync(fixture.promptPath, '$ape:run\n');
    expect(() => buildCodexParentInvocation(fixture)).toThrow(
      /prompt must declare the exact project_dir/iu,
    );

    const staleProject = path.join(path.dirname(fixture.projectDir), 'stale-project');
    mkdirSync(staleProject);
    writeFileSync(
      fixture.promptPath,
      `$ape:run\nPass project_dir "${staleProject}" on every APE MCP call.\n`,
    );
    expect(() => buildCodexParentInvocation(fixture)).toThrow(
      /does not match --project-dir/iu,
    );

    const missingProject = path.join(path.dirname(fixture.projectDir), 'missing-project');
    writeFileSync(
      fixture.promptPath,
      `$ape:run\nPass project_dir "${missingProject}" on every APE MCP call.\n`,
    );
    expect(() => buildCodexParentInvocation(fixture)).toThrow(
      /does not resolve to an existing path/iu,
    );
  });

  it('accepts the exact governed root in both prose and quoted JSON call templates', () => {
    const fixture = certificationParentFixture();
    const preview = JSON.stringify({
      action: 'preview',
      project_dir: fixture.projectDir,
      objective: 'synthetic certification fixture',
      host: 'codex',
    });
    const start = JSON.stringify({
      action: 'start',
      project_dir: fixture.projectDir,
      objective: 'synthetic certification fixture',
      host: 'codex',
    });
    writeFileSync(
      fixture.promptPath,
      [
        '$ape:run',
        `Pass project_dir "${fixture.projectDir}" on every APE MCP call.`,
        `APE_PREVIEW_CALL=${preview}`,
        `APE_START_CALL=${start}`,
      ].join('\n'),
    );

    expect(buildCodexParentInvocation(fixture).input)
      .toContain(`"project_dir":"${fixture.projectDir}"`);
  });
});

describe('live certification prompt preparation', () => {
  function exactControlCall(prompt, label) {
    const matches = [...prompt.matchAll(
      new RegExp(`^APE_${label}_CALL=(\\{[^\\r\\n]+\\})$`, 'gmu'),
    )];
    expect(matches).toHaveLength(1);
    return JSON.parse(matches[0][1]);
  }

  function promptCampaign() {
    const root = mkdtempSync(path.join(tmpdir(), 'ape-live-prompts-'));
    temporaryRepositories.push(root);
    for (const pipeline of ['mechanical', 'fast', 'full', 'land']) {
      mkdirSync(path.join(root, pipeline));
    }
    return realpathSync(root);
  }

  it('derives all attempt paths and version strings from one canonical campaign root', () => {
    const root = promptCampaign();
    const files = writeLiveCertificationPrompts(root);
    expect(files).toHaveLength(4);
    expect(files.map((file) => path.basename(file))).toEqual([
      'mechanical-1.txt',
      'fast-1.txt',
      'full-1.txt',
      'land-1.txt',
    ]);
    for (const file of files) {
      const prompt = readFileSync(file, 'utf8');
      expect(prompt).toContain(`APE ${VERSION}`);
      expect(prompt).toContain(root);
      expect(prompt).not.toMatch(/2\.23\.(?:3[0-9]|4[01])/u);
    }
    expect(readFileSync(path.join(root, 'prompts', 'fast-1.txt'), 'utf8'))
      .toContain(`src/is-even-${VERSION_SUFFIX}-1.js`);
    expect(readFileSync(path.join(root, 'prompts', 'land-1.txt'), 'utf8'))
      .toContain(`docs/codex-${VERSION_SUFFIX}-protected-land-1.md`);
  });

  it('pins complete identical first-pass preview and start calls for every synthetic cohort', () => {
    const root = promptCampaign();
    const expected = {
      mechanical: {
        mode: 'phase',
        lane: 'mechanical',
        behavioral: false,
        claimed_paths: [`docs/codex-${VERSION_SUFFIX}-mechanical-1.md`],
        test_paths: [],
      },
      fast: {
        mode: 'phase',
        lane: 'fast',
        behavioral: true,
        plan_contract_version: 2,
        claimed_paths: [`src/is-even-${VERSION_SUFFIX}-1.js`],
        test_paths: [`test/is-even-${VERSION_SUFFIX}-1.test.js`],
      },
      full: {
        mode: 'phase',
        lane: 'full',
        behavioral: true,
        plan_contract_version: 2,
        claimed_paths: [`src/normalize-label-${VERSION_SUFFIX}-1.js`],
        test_paths: [`test/normalize-label-${VERSION_SUFFIX}-1.test.js`],
      },
      land: {
        mode: 'land',
        lane: 'mechanical',
        behavioral: false,
        claimed_paths: [`docs/codex-${VERSION_SUFFIX}-protected-land-1.md`],
        test_paths: [],
      },
    };
    const forbidden = ['run_id', 'supersedes_run', 'binding_protocol', 'binding_probe'];
    const exactBaseKeys = [
      'action',
      'project_dir',
      'objective',
      'mode',
      'lane',
      'host',
      'claimed_paths',
      'test_paths',
      'requirements',
      'completes',
      'risk_triggers',
      'required_capabilities',
      'behavioral',
      'hooks_trusted',
      'subagents_available',
      'explicit_invocation',
      'auto_merge_authorized',
    ];

    for (const [pipeline, cohort] of Object.entries(expected)) {
      const prompt = buildLiveCertificationPrompt(root, pipeline, 1);
      const preview = exactControlCall(prompt, 'PREVIEW');
      const start = exactControlCall(prompt, 'START');
      expect(start).toEqual({ ...preview, action: 'start' });
      expect(start).not.toHaveProperty('expected_admission_digest');
      expect(prompt).toContain("expected_admission_digest copied unchanged from the preview's top-level admission_digest");
      expect(prompt).toContain('never use a placeholder, guess a digest, or send the digest on preview');
      expect(preview.action).toBe('preview');
      expect(preview.project_dir).toBe(path.join(root, pipeline));
      expect(preview.objective).toBeTruthy();
      expect(prompt).toContain(`Start one run with this complete objective: ${preview.objective}`);
      expect(preview).toMatchObject({
        mode: cohort.mode,
        lane: cohort.lane,
        host: 'codex',
        claimed_paths: cohort.claimed_paths,
        test_paths: cohort.test_paths,
        requirements: [],
        completes: [],
        risk_triggers: [],
        required_capabilities: [],
        behavioral: cohort.behavioral,
        hooks_trusted: true,
        subagents_available: true,
        explicit_invocation: true,
        auto_merge_authorized: true,
      });
      const expectedKeys = [
        ...exactBaseKeys,
        ...('plan_contract_version' in cohort ? ['plan_contract_version'] : []),
      ];
      expect(Object.keys(preview)).toEqual(expectedKeys);
      expect(Object.keys(start)).toEqual(expectedKeys);
      if ('plan_contract_version' in cohort) {
        expect(preview.plan_contract_version).toBe(2);
      } else {
        expect(preview).not.toHaveProperty('plan_contract_version');
      }
      for (const field of forbidden) {
        expect(preview).not.toHaveProperty(field);
        expect(start).not.toHaveProperty(field);
      }
      expect(prompt).toMatch(/preview exactly once[\s\S]*start exactly once/iu);
      expect(prompt).toMatch(/stop immediately[\s\S]*Never correct or retry one of those control calls/iu);
      expect(prompt).toContain('SubagentStart is provisional native identity evidence only');
      expect(prompt).toContain('first APE operation is ape_bind');
      expect(prompt).toContain('literal registered tool name ape_bind');
      if (pipeline === 'land') {
        expect(prompt).toContain('Protected land may complete by immediate or automatic squash');
        expect(prompt).toContain('Do not force the automatic path');
        expect(prompt).toContain('Require observed MERGED state at the exact pushed head and the passed-gate tree');
        expect(prompt).not.toContain('enable protected auto-merge, and squash-merge');
      }
      expect(prompt).toContain('never include bootstrap arguments or capabilities in discovery');
      expect(prompt).toContain('For the probe only, follow its injected acknowledgement-only contract');
      expect(prompt).not.toContain('Require the trusted SubagentStart context before stage work');
    }
  });

  it('refuses stale prompt-directory reuse and non-canonical attempt inputs', () => {
    const root = promptCampaign();
    writeLiveCertificationPrompts(root);
    expect(() => writeLiveCertificationPrompts(root)).toThrow(LiveCertificationPromptError);
    expect(() => buildLiveCertificationPrompt(root, 'unknown', 1))
      .toThrow(/pinned certification attempt/iu);
    expect(() => buildLiveCertificationPrompt(root, 'mechanical', 2))
      .toThrow(/pinned certification attempt/iu);
  });
});

describe('live release certification evidence', () => {
  it.each([
    [1, 0, 2, 3],
    [0, 2, 1, 3],
    [0, 1, 3, 2],
    [3, 2, 1, 0],
  ])('rejects out-of-order clean campaigns (%s, %s, %s, %s)', (...order) => {
    const document = validLedger();
    const original = document.attempts;
    document.attempts = order.map((index, sequence) => ({
      ...original[index], sequence: sequence + 1,
    }));
    expect(() => validateLiveCertificationDocument(document, {
      packageVersion: VERSION,
      sourceCommit: SOURCE,
    })).toThrow(/campaign order.*mechanical.*fast.*full.*protected-branch-land/iu);
  });

  it('requires the exact repository-local service identity before live attempts', () => {
    const { repo } = sourceRepository();
    expect(() => verifyLiveCertificationEnvironment(repo))
      .toThrow(/exact APE Certification repository-local user\.name/u);
    git(repo, 'config', '--local', 'user.name', 'APE Certification');
    git(repo, 'config', '--local', 'user.email', 'developer@example.invalid');
    expect(() => verifyLiveCertificationEnvironment(repo))
      .toThrow(/exact APE Certification repository-local GitHub noreply user\.email/u);
    git(repo, 'config', '--local', 'user.email', 'unapproved@users.noreply.github.com');
    expect(() => verifyLiveCertificationEnvironment(repo))
      .toThrow(/exact APE Certification repository-local GitHub noreply user\.email/u);
    git(repo, 'config', '--local', 'user.email', 'ape-certification@users.noreply.github.com');
    expect(verifyLiveCertificationEnvironment(repo)).toEqual({
      identity_scope: 'repository-local',
      identity: 'APE Certification',
      email_domain: 'users.noreply.github.com',
    });

    const checker = path.join(
      fileURLToPath(new URL('..', import.meta.url)),
      'scripts',
      'check-live-certification-environment.mjs',
    );
    const overridden = spawnSync(process.execPath, [checker, '--project-dir', repo], {
      encoding: 'utf8',
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: 'Unapproved Service',
        GIT_AUTHOR_EMAIL: 'unapproved@users.noreply.github.com',
      },
    });
    expect(overridden.status).not.toBe(0);
    expect(overridden.stderr).toMatch(/effective author identity/iu);
    expect(overridden.stderr).not.toContain('unapproved@users.noreply.github.com');

    const aliasRoot = mkdtempSync(path.join(tmpdir(), 'ape-live-certification-alias-'));
    temporaryRepositories.push(aliasRoot);
    const sourceAlias = path.join(aliasRoot, 'source');
    symlinkSync(
      fileURLToPath(new URL('..', import.meta.url)),
      sourceAlias,
      process.platform === 'win32' ? 'junction' : 'dir',
    );
    const output = execFileSync(process.execPath, [
      path.join(sourceAlias, 'scripts', 'check-live-certification-environment.mjs'),
      '--project-dir',
      repo,
    ], { encoding: 'utf8' });
    expect(output).toMatch(/live-certification environment passed/u);
  });

  it('requires one first-pass-perfect completed attempt for every certified host and pipeline', () => {
    const result = validateLiveCertificationDocument(validLedger(), {
      packageVersion: VERSION,
      sourceCommit: SOURCE,
    });
    expect(result).toEqual({ version: VERSION, attempt_count: 4, cohort_count: 4 });
  });

  it('rejects the candidate on its first failed attempt instead of accepting later clean runs', () => {
    const document = validLedger();
    const failed = {
      ...cleanAttempt({ sequence: 1, host: 'codex', pipeline: 'mechanical' }),
      attempt_id: 'codex-mechanical-failed-raw-attempt',
      outcome: 'failure',
      terminal_reason_code: 'aborted_dispatch',
      prompt_assembly_failure: true,
      run_record_sha256: runRecordHash(1_000),
    };
    document.attempts[0] = failed;
    expect(() => validateLiveCertificationDocument(document, {
      packageVersion: VERSION,
      sourceCommit: SOURCE,
    })).toThrow(/first-pass perfect/iu);
  });

  it.each([
    'worker_tool_failure',
    'control_call_failure',
    'host_transport_retry',
    'receipt_repair',
    'duplicate_dispatch',
    'remediation',
    'self_correction',
  ])('rejects a candidate whose first cycle records %s', (flag) => {
    const document = validLedger();
    document.attempts[0][flag] = true;
    expect(() => validateLiveCertificationDocument(document, {
      packageVersion: VERSION,
      sourceCommit: SOURCE,
    })).toThrow(/not first-pass perfect/iu);
  });

  it('fails closed on missing coverage, a dirty final run, or non-completed success', () => {
    const missing = validLedger();
    missing.attempts.splice(-1, 1,
      cleanAttempt({ sequence: 4, host: 'codex', pipeline: 'full' }));
    expect(() => validateLiveCertificationDocument(missing, {
      packageVersion: VERSION,
      sourceCommit: SOURCE,
    })).toThrow(/one release-gating attempt|protected-branch-land must contain exactly one/iu);

    const dirty = validLedger();
    dirty.attempts.at(-1).receipt_repair = true;
    expect(() => validateLiveCertificationDocument(dirty, {
      packageVersion: VERSION,
      sourceCommit: SOURCE,
    })).toThrow(/not first-pass perfect/iu);

    const contradictory = validLedger();
    contradictory.attempts[0].terminal_reason_code = 'test_failed';
    expect(() => validateLiveCertificationDocument(contradictory, {
      packageVersion: VERSION,
      sourceCommit: SOURCE,
    })).toThrow(/outcome and terminal reason code disagree/iu);
  });

  it('rejects Claude attempts because Claude is packaged but not live-certified', () => {
    const document = validLedger();
    document.attempts[0] = {
      ...document.attempts[0],
      attempt_id: 'claude-unverified-attempt',
      host: 'claude',
      host_version: HOST_VERSIONS.claude,
    };
    expect(() => validateLiveCertificationDocument(document, {
      packageVersion: VERSION,
      sourceCommit: SOURCE,
    })).toThrow(/unsupported host/iu);
  });

  it('fails closed when the ledger changes the certified or unverified host partition', () => {
    const noCertifiedHost = validLedger();
    noCertifiedHost.certified_hosts = [];
    expect(() => validateLiveCertificationDocument(noCertifiedHost, {
      packageVersion: VERSION,
      sourceCommit: SOURCE,
    })).toThrow(/exact required live-certified hosts/iu);

    const claimsClaude = validLedger();
    claimsClaude.unverified_hosts = [];
    expect(() => validateLiveCertificationDocument(claimsClaude, {
      packageVersion: VERSION,
      sourceCommit: SOURCE,
    })).toThrow(/exact unverified hosts/iu);
  });

  it('requires exact pushed-head merge proof for every successful protected land attempt', () => {
    const document = validLedger();
    const protectedAttempt = document.attempts.find((attempt) => attempt.pipeline === 'protected-branch-land');
    protectedAttempt.protected_land.observed_merged_pr_head = hash(999);
    expect(() => validateLiveCertificationDocument(document, {
      packageVersion: VERSION,
      sourceCommit: SOURCE,
    })).toThrow(/did not merge the exact pushed head/iu);

    const unprotected = validLedger();
    const unprotectedAttempt = unprotected.attempts
      .find((attempt) => attempt.pipeline === 'protected-branch-land');
    unprotectedAttempt.protected_land.branch_protection.admins_enforced = false;
    expect(() => validateLiveCertificationDocument(unprotected, {
      packageVersion: VERSION,
      sourceCommit: SOURCE,
    })).toThrow(/protected branch policy/iu);
  });

  it.each(['immediate', 'auto'])('accepts fully attested protected %s squash without forcing a different merge path', (mergePath) => {
    const document = validLedger();
    document.attempts.at(-1).protected_land.merge_path = mergePath;
    expect(() => validateLiveCertificationDocument(document)).not.toThrow();
  });

  it.each([
    ['bypass_used', true],
    ['required_checks_passed', false],
    ['merge_path', 'queued'],
    ['pr_state', 'OPEN'],
    ['merge_method', 'merge'],
    ['checked_head_commit', hash(999)],
    ['merged_tree', hash(999)],
    ['gate_tree', 'not-a-tree'],
  ])('rejects missing or contradictory protected land evidence: %s', (field, value) => {
    const document = validLedger();
    document.attempts.at(-1).protected_land[field] = value;
    expect(() => validateLiveCertificationDocument(document)).toThrow();
  });

  it.each([
    ['pull_request_required', false],
    ['required_checks_strict', false],
    ['required_checks_count', 0],
    ['required_checks_count', 101],
    ['required_checks_count', 1.5],
    ['admins_enforced', false],
    ['force_pushes_allowed', true],
    ['deletions_allowed', true],
    ['before_sha256', 'unretained'],
    ['after_sha256', runRecordHash(999)],
  ])('rejects absent, bypassable or drifted protection: %s=%s', (field, value) => {
    const document = validLedger();
    document.attempts.at(-1).protected_land.branch_protection[field] = value;
    expect(() => validateLiveCertificationDocument(document)).toThrow();
  });

  it('keeps old certificate JSON readable without upgrading its weaker merge proof', () => {
    const old = validLedger();
    old.schema_version = 4;
    const proof = old.attempts.at(-1).protected_land;
    old.attempts.at(-1).protected_land = {
      target_branch: proof.target_branch,
      merge_method: proof.merge_method,
      auto_merge_required: true,
      pr_state: proof.pr_state,
      pushed_head_commit: proof.pushed_head_commit,
      observed_merged_pr_head: proof.observed_merged_pr_head,
      merge_commit: proof.merge_commit,
      remote_head_after_merge: proof.remote_head_after_merge,
    };
    expect(parseLiveCertificationJson(canonical(old))).toEqual(old);
    expect(() => validateLiveCertificationDocument(old)).toThrow(/schema version is unsupported/iu);
    expect(old.schema_version).toBe(4);
  });

  it.each(['immediate', 'auto'])('rejects missing, extra and forged-legacy fields for the %s path', (mergePath) => {
    for (const field of Object.keys(landProof(4))) {
      const document = validLedger();
      const proof = document.attempts.at(-1).protected_land;
      proof.merge_path = mergePath;
      delete proof[field];
      expect(() => validateLiveCertificationDocument(document), field).toThrow();
    }
    for (const field of Object.keys(landProof(4).branch_protection)) {
      const document = validLedger();
      const proof = document.attempts.at(-1).protected_land;
      proof.merge_path = mergePath;
      delete proof.branch_protection[field];
      expect(() => validateLiveCertificationDocument(document), field).toThrow();
    }
    for (const mutation of [
      (proof) => { proof.auto_merge_required = true; },
      (proof) => { proof.branch_protection.prose = 'synthetic unsupported evidence'; },
      (proof) => { proof.bypass_used = true; },
      (proof) => { proof.required_checks_passed = false; },
      (proof) => { proof.checked_head_commit = hash(999); },
      (proof) => { proof.merged_tree = hash(999); },
      (proof) => { proof.branch_protection.admins_enforced = false; },
      (proof) => { proof.branch_protection.after_sha256 = runRecordHash(999); },
    ]) {
      const document = validLedger();
      const proof = document.attempts.at(-1).protected_land;
      proof.merge_path = mergePath;
      mutation(proof);
      expect(() => validateLiveCertificationDocument(document)).toThrow();
    }
  });

  it('rejects free-form fields, unsafe versions, mismatched source/version, and non-canonical JSON', () => {
    const withProse = validLedger();
    withProse.attempts[0].objective = 'unbounded private prose';
    expect(() => validateLiveCertificationDocument(withProse, {
      packageVersion: VERSION,
      sourceCommit: SOURCE,
    })).toThrow(/missing or unsupported fields/iu);

    const unsupportedVersion = validLedger();
    unsupportedVersion.attempts[0].host_version = 'banana';
    expect(() => validateLiveCertificationDocument(unsupportedVersion, {
      packageVersion: VERSION,
      sourceCommit: SOURCE,
    })).toThrow(/host version does not match compatibility\.json/iu);

    const reusedRecord = validLedger();
    reusedRecord.attempts[1].run_record_sha256 = reusedRecord.attempts[0].run_record_sha256;
    expect(() => validateLiveCertificationDocument(reusedRecord, {
      packageVersion: VERSION,
      sourceCommit: SOURCE,
    })).toThrow(/reuses an archived run-record digest/iu);

    expect(() => validateLiveCertificationDocument(validLedger(), {
      packageVersion: '9.9.9',
      sourceCommit: SOURCE,
    })).toThrow(/version does not match/iu);
    expect(() => validateLiveCertificationDocument(validLedger(), {
      packageVersion: VERSION,
      sourceCommit: 'b'.repeat(40),
    })).toThrow(/source commit/iu);
    expect(() => parseLiveCertificationJson(JSON.stringify(validLedger()))).toThrow(/canonical/iu);
    expect(() => parseLiveCertificationJson('x'.repeat(256 * 1024 + 1))).toThrow(/size limit/iu);
  });
});

describe('tagged certification-only commit gate', () => {
  it('verifies committed evidence from a single-child tag and ignores the working tree', () => {
    const { repo, head } = certificationCommit();
    writeFileSync(path.join(repo, 'evals', 'live-certification.json'), '{"fabricated":true}\n');
    expect(verifyLiveCertificationRepository({ repo, head, tag: `v${VERSION}` })).toEqual({
      version: VERSION,
      attempt_count: 4,
      cohort_count: 4,
    });
  });

  it('rejects a certification commit with any additional changed path', () => {
    const { repo, head } = certificationCommit({ extraPath: 'extra.txt' });
    expect(() => verifyLiveCertificationRepository({ repo, head, tag: `v${VERSION}` }))
      .toThrow(/only add or modify evals\/live-certification\.json/iu);
  });

  it('rejects evidence that names any source other than the certification commit parent', () => {
    const { repo, head } = certificationCommit({ sourceOverride: 'b'.repeat(40) });
    expect(() => verifyLiveCertificationRepository({ repo, head, tag: `v${VERSION}` }))
      .toThrow(/source commit is not the certification commit parent/iu);
  });

  it('rejects a tagged source whose required and unverified host statuses are swapped', () => {
    const { repo, head } = certificationCommit({
      codexCertification: 'unverified',
      claudeCertification: 'required',
    });
    expect(() => verifyLiveCertificationRepository({ repo, head, tag: `v${VERSION}` }))
      .toThrow(/invalid live-certification policy/iu);
  });

  it('rejects a tagged source that adds a host outside the exact policy partition', () => {
    const { repo, head } = certificationCommit({ extraHost: true });
    expect(() => verifyLiveCertificationRepository({ repo, head, tag: `v${VERSION}` }))
      .toThrow(/exact certification host partition/iu);
  });

  it('rejects a two-parent release head even when its first-parent diff only adds the ledger', () => {
    const { repo, source } = sourceRepository();
    const sourceTree = git(repo, 'rev-parse', `${source}^{tree}`);
    const secondParent = git(repo, 'commit-tree', sourceTree, '-p', source, '-m', 'empty side parent');
    writeFileSync(path.join(repo, 'evals', 'live-certification.json'), canonical(validLedger(source)));
    git(repo, 'add', 'evals/live-certification.json');
    const certificationTree = git(repo, 'write-tree');
    const head = git(
      repo,
      'commit-tree',
      certificationTree,
      '-p',
      source,
      '-p',
      secondParent,
      '-m',
      'invalid merge certification',
    );
    git(repo, 'update-ref', 'refs/heads/main', head);
    git(repo, 'tag', `v${VERSION}`, head);
    expect(() => verifyLiveCertificationRepository({ repo, head, tag: `v${VERSION}` }))
      .toThrow(/exactly one parent/iu);
  });

  it('requires the version tag itself to resolve to the certification head', () => {
    const { repo, source, head } = certificationCommit();
    git(repo, 'tag', '--force', `v${VERSION}`, source);
    expect(() => verifyLiveCertificationRepository({ repo, head, tag: `v${VERSION}` }))
      .toThrow(/tag does not point to the certification commit/iu);
  });

  it('refuses to verify a tag other than the commit currently checked out', () => {
    const { repo, head } = certificationCommit();
    writeFileSync(path.join(repo, 'after-tag.txt'), 'different checkout\n');
    git(repo, 'add', 'after-tag.txt');
    git(repo, 'commit', '-m', 'move checkout past certification');
    expect(() => verifyLiveCertificationRepository({ repo, head, tag: `v${VERSION}` }))
      .toThrow(/tag commit must be the checked-out HEAD/iu);
  });

  it('ships a strict privacy-safe schema but no fabricated live ledger', () => {
    const schema = JSON.parse(readFileSync(new URL('../evals/live-certification.schema.json', import.meta.url), 'utf8'));
    expect(TERMINAL_REASON_TAXONOMY_VERSION).toBe(2);
    expect(TERMINAL_REASON_CODES).toContain('land_review_disagreement');
    expect(schema.additionalProperties).toBe(false);
    expect(schema.$defs.attempt.additionalProperties).toBe(false);
    expect(schema.properties.terminal_reason_taxonomy_version.const)
      .toBe(TERMINAL_REASON_TAXONOMY_VERSION);
    expect(schema.properties.schema_version.const).toBe(5);
    expect(schema.properties.schema_version.const).toBe(LIVE_CERTIFICATION_SCHEMA_VERSION);
    const proof = landProof(4);
    expect(schema.$defs.protected_land.required.toSorted()).toEqual(Object.keys(proof).sort());
    expect(Object.keys(schema.$defs.protected_land.properties).sort()).toEqual(Object.keys(proof).sort());
    expect(schema.$defs.protected_land.additionalProperties).toBe(false);
    expect(schema.$defs.protected_land.properties.merge_path.enum).toEqual(['immediate', 'auto']);
    expect(schema.$defs.protected_land.properties.bypass_used.const).toBe(false);
    expect(schema.$defs.protected_land.properties.required_checks_passed.const).toBe(true);
    expect(schema.$defs.branch_protection.required.toSorted()).toEqual(Object.keys(proof.branch_protection).sort());
    expect(Object.keys(schema.$defs.branch_protection.properties).sort()).toEqual(Object.keys(proof.branch_protection).sort());
    expect(schema.$defs.branch_protection.additionalProperties).toBe(false);
    for (const [field, value] of Object.entries(proof.branch_protection)) {
      if (typeof value === 'boolean') expect(schema.$defs.branch_protection.properties[field].const).toBe(value);
    }
    expect(schema.$defs.branch_protection.properties.required_checks_count).toEqual({ type: 'integer', minimum: 1, maximum: 100 });
    expect(schema.properties.certified_hosts.const).toEqual(['codex']);
    expect(schema.properties.unverified_hosts.const).toEqual(['claude']);
    expect(schema.properties.attempts.minItems).toBe(4);
    expect(schema.properties.attempts.maxItems).toBe(4);
    expect(schema.$defs.attempt.required).toContain('host_transport_retry');
    expect(schema.$defs.attempt.properties.host.enum).toEqual(['codex']);
    expect(schema.$defs.attempt.properties.pipeline.enum).toEqual([
      'mechanical',
      'fast',
      'full',
      'protected-branch-land',
    ]);
    expect(schema.$defs.terminal_reason_code.enum).toEqual(TERMINAL_REASON_CODES);
    expect(LiveCertificationError).toBeTypeOf('function');
  });
});
