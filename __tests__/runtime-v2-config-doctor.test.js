import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';
import { hostname, tmpdir } from 'node:os';
import { join } from 'node:path';
import { doctor, validateCodexHookWiring } from '../lib/runtime/doctor.js';
import { configAction } from '../lib/runtime/service.js';

// F37: the documented `ape_config doctor` call carries no run-start fields.
// Doctor must then run in diagnosis mode — check what is checkable (state dir,
// config parse, lock health, git, bundle) and report run-start preconditions
// as informational instead of failing a healthy install. Supplied fields are
// still enforced, so ape_run start keeps its full precondition gate.
describe('ape v2 config doctor diagnosis mode', () => {
  const dirs = [];
  afterEach(() => dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })));

  function gitProject() {
    const dir = mkdtempSync(join(tmpdir(), 'ape-doctor-'));
    dirs.push(dir);
    execFileSync('git', ['init'], { cwd: dir, stdio: 'ignore' });
    return dir;
  }

  const check = (report, name) => report.checks.find((entry) => entry.name === name);

  it('reports healthy on a healthy install when no run-start fields are supplied', async () => {
    const dir = gitProject();
    const report = await doctor(dir, {});
    expect(report.healthy).toBe(true); // old behavior: five run-start checks failed
    for (const name of ['explicit-invocation', 'trusted-hooks', 'native-subagents', 'host', 'test-path-claims']) {
      const entry = check(report, name);
      expect(entry.informational).toBe(true);
      expect(entry.passed).toBe(null);
    }
    expect(check(report, 'state-dir').passed).toBe(true);
    expect(check(report, 'config-parse').passed).toBe(true);
    expect(check(report, 'lock-health').passed).toBe(true);
    expect(check(report, 'git-repository').passed).toBe(true);
  });

  it('still enforces run-start preconditions when the caller supplies them', async () => {
    const dir = gitProject();
    const report = await doctor(dir, {
      explicit_invocation: false,
      hooks_trusted: true,
      subagents_available: true,
      host: 'claude',
      behavioral: true,
      test_paths: [],
    });
    expect(report.healthy).toBe(false);
    expect(check(report, 'explicit-invocation')).toMatchObject({ passed: false });
    expect(check(report, 'test-path-claims')).toMatchObject({ passed: false });
    expect(check(report, 'host')).toMatchObject({ passed: true });
    expect(check(report, 'explicit-invocation').informational).toBeUndefined();
  });

  it('a run-start-shaped context with sound values is healthy', async () => {
    const dir = gitProject();
    const report = await doctor(dir, {
      explicit_invocation: true,
      hooks_trusted: true,
      subagents_available: true,
      host: 'codex',
      behavioral: false,
      test_paths: [],
    });
    expect(report.healthy).toBe(true);
  });

  it('reports the live Codex task-name and SubagentStart binding channel', async () => {
    const dir = gitProject();
    const report = await doctor(dir, {
      explicit_invocation: true,
      hooks_trusted: true,
      subagents_available: true,
      host: 'codex',
      behavioral: false,
    });
    expect(report.healthy).toBe(true);
    const entry = check(report, 'codex-write-enforcement');
    expect(entry).toMatchObject({ passed: true });
    expect(entry.informational).toBeUndefined();
    expect(entry.warning).toBeUndefined();
    expect(entry.detail).toMatch(/spawn_agent/i);
    expect(entry.detail).toMatch(/SubagentStart/i);
  });

  it('fails the Codex wiring proof when spawn_agent is absent from the shipped matcher', () => {
    const report = validateCodexHookWiring({
      hooks: {
        PreToolUse: [{ matcher: 'Agent', hooks: [{ command: 'node ape-hooks.bundle.mjs' }] }],
        PostToolUse: [{ matcher: 'Agent', hooks: [{ command: 'node ape-hooks.bundle.mjs' }] }],
        SubagentStart: [{ hooks: [{ command: 'node ape-hooks.bundle.mjs' }] }],
      },
    });
    expect(report.passed).toBe(false);
    expect(report.detail).toContain('PreToolUse spawn_agent matcher');
    expect(report.detail).toContain('PostToolUse spawn_agent matcher');
  });

  it('fails the Codex wiring proof when only the legacy bare name is matched', () => {
    const report = validateCodexHookWiring({
      hooks: {
        PreToolUse: [{ matcher: 'spawn_agent', hooks: [{ command: 'node ape-hooks.bundle.mjs' }] }],
        PostToolUse: [{ matcher: 'spawn_agent', hooks: [{ command: 'node ape-hooks.bundle.mjs' }] }],
        SubagentStart: [{ hooks: [{ command: 'node ape-hooks.bundle.mjs' }] }],
      },
    });
    expect(report.passed).toBe(false);
    expect(report.detail).toContain('collaborationspawn_agent');
  });

  it('makes no Codex write-enforcement claim on a Claude host', async () => {
    const dir = gitProject();
    for (const context of [{}, { host: 'claude' }]) {
      const report = await doctor(dir, context);
      expect(check(report, 'codex-write-enforcement')).toBeUndefined();
    }
  });

  it('fails config-parse on a corrupt runtime config', async () => {
    const dir = gitProject();
    mkdirSync(join(dir, '.ape', 'runtime'), { recursive: true });
    writeFileSync(join(dir, '.ape', 'runtime', 'config.json'), '{not json');
    const report = await doctor(dir, {});
    expect(report.healthy).toBe(false);
    expect(check(report, 'config-parse').passed).toBe(false);
  });

  it('fails lock-health on an unreadable active-run lock', async () => {
    const dir = gitProject();
    mkdirSync(join(dir, '.ape', 'runtime'), { recursive: true });
    writeFileSync(join(dir, '.ape', 'runtime', 'active.lock'), '{not json');
    const report = await doctor(dir, {});
    expect(report.healthy).toBe(false);
    expect(check(report, 'lock-health').passed).toBe(false);
    expect(check(report, 'lock-health').detail).toContain('override reset');
  });

  it('treats a stale lock from a dead holder as recoverable, and a live lock with its active run as held', async () => {
    const dir = gitProject();
    mkdirSync(join(dir, '.ape', 'runtime'), { recursive: true });
    const lockFile = join(dir, '.ape', 'runtime', 'active.lock');
    const deadPid = spawnSync(process.execPath, ['-e', '']).pid; // exited, so the pid is free
    writeFileSync(lockFile, JSON.stringify({ version: 1, run_id: 'run-x', pid: deadPid, host: hostname() }));
    let report = await doctor(dir, {});
    expect(check(report, 'lock-health').passed).toBe(true);
    expect(check(report, 'lock-health').detail).toContain('stale');

    writeFileSync(lockFile, JSON.stringify({ version: 1, run_id: 'run-x', pid: process.pid, host: hostname() }));
    // Held is healthy only alongside the run that holds it; without this
    // active.json the same fixture is the orphan state tested below.
    writeFileSync(join(dir, '.ape', 'runtime', 'active.json'), JSON.stringify({ run_id: 'run-x', status: 'running' }));
    report = await doctor(dir, {});
    expect(check(report, 'lock-health').passed).toBe(true);
    expect(check(report, 'lock-health').detail).toContain('run-x');
  });

  // A live-held lock with no (or another run's) active.json is the wedge a
  // crashed start leaves behind: starts are refused while every recovery
  // lever reports 'no active run'. Doctor must fail it with the remediation,
  // not bless it as healthy.
  it('fails lock-health on an orphaned live lock with no matching active run', async () => {
    const dir = gitProject();
    mkdirSync(join(dir, '.ape', 'runtime'), { recursive: true });
    const lockFile = join(dir, '.ape', 'runtime', 'active.lock');
    writeFileSync(lockFile, JSON.stringify({ version: 1, run_id: 'run-x', pid: process.pid, host: hostname() }));
    let report = await doctor(dir, {});
    expect(report.healthy).toBe(false);
    expect(check(report, 'lock-health').passed).toBe(false);
    expect(check(report, 'lock-health').detail).toContain('orphaned');
    expect(check(report, 'lock-health').detail).toContain('override reset');

    // Another run's active.json is equally orphaned: the holder never persisted.
    writeFileSync(join(dir, '.ape', 'runtime', 'active.json'), JSON.stringify({ run_id: 'run-y', status: 'running' }));
    report = await doctor(dir, {});
    expect(check(report, 'lock-health').passed).toBe(false);
  });

  it('the documented ape_config doctor call reports healthy alongside statusline state', async () => {
    const dir = gitProject();
    const res = await configAction(dir, 'doctor', {});
    expect(res.ok).toBe(true);
    expect(res.doctor.healthy).toBe(true);
  });

  // F36: a stored override without provenance that matches a default an older
  // release shipped is ambiguous — intentional override or legacy materialized
  // snapshot. Doctor must surface it (without failing health, and without
  // stripping the value) so the operator can claim it explicitly.
  it('warns about ambiguous legacy overrides that match an older shipped default (F36)', async () => {
    const dir = gitProject();
    mkdirSync(join(dir, '.ape', 'runtime'), { recursive: true });
    writeFileSync(
      join(dir, '.ape', 'runtime', 'config.json'),
      JSON.stringify({ models: { claude: { deep: { model: 'fable' } } } }),
    );
    const report = await doctor(dir, {});
    expect(report.healthy).toBe(true); // a warning, never a hard failure
    const provenance = check(report, 'config-override-provenance');
    expect(provenance).toMatchObject({
      passed: null,
      informational: true,
      warning: true,
      ambiguous_keys: ['models.claude.deep.model'],
    });
    expect(provenance.detail).toContain('2.0.21');
    expect(provenance.detail).toContain('ape_config set');
  });

  it('clears the provenance warning once the operator claims the override explicitly (F36)', async () => {
    const dir = gitProject();
    mkdirSync(join(dir, '.ape', 'runtime'), { recursive: true });
    writeFileSync(
      join(dir, '.ape', 'runtime', 'config.json'),
      JSON.stringify({ models: { claude: { deep: { model: 'fable' } } } }),
    );
    await configAction(dir, 'set', { key: 'models.claude.deep', value: { model: 'fable' } });
    const report = await doctor(dir, {});
    expect(check(report, 'config-override-provenance')).toMatchObject({ passed: true });
  });

  it('reports clean provenance on a fresh install and on never-shipped overrides', async () => {
    const dir = gitProject();
    let report = await doctor(dir, {});
    expect(check(report, 'config-override-provenance')).toMatchObject({ passed: true });

    mkdirSync(join(dir, '.ape', 'runtime'), { recursive: true });
    writeFileSync(
      join(dir, '.ape', 'runtime', 'config.json'),
      JSON.stringify({ models: { claude: { deep: { model: 'claude-fable-5' } } } }),
    );
    report = await doctor(dir, {});
    expect(check(report, 'config-override-provenance')).toMatchObject({ passed: true });
  });

  // Session-3 nit: the state-dir check calls readJson(active, null) and, when
  // active.json PARSES, reports 'runtime state directory is usable' — even for a
  // parseable-but-schema-invalid active.json ({} / 42 / an object with no string
  // run_id) that every ape_run lever refuses. It must shape-validate a parseable
  // active.json and surface a schema-invalid state as a diagnosis instead of the
  // misleading "usable" verdict. A present, VALID run state stays usable (guard).
  for (const body of ['{}', '42', JSON.stringify({ status: 'running' })]) {
    it(`surfaces a schema-invalid active.json (${body}) as a state-dir diagnosis, not "runtime state directory is usable"`, async () => {
      const dir = gitProject();
      mkdirSync(join(dir, '.ape', 'runtime'), { recursive: true });
      writeFileSync(join(dir, '.ape', 'runtime', 'active.json'), body);
      const report = await doctor(dir, {});
      const entry = check(report, 'state-dir');
      expect(entry.detail).not.toBe('runtime state directory is usable');
      expect(entry.detail).toMatch(
        /schema-invalid|not a run state|invalid|corrupt|override reset|recover|unreadable|unusable/i,
      );
    });
  }

  it('still reports the state dir usable for a present, valid run-state active.json', async () => {
    const dir = gitProject();
    mkdirSync(join(dir, '.ape', 'runtime'), { recursive: true });
    writeFileSync(
      join(dir, '.ape', 'runtime', 'active.json'),
      JSON.stringify({ run_id: 'run-x', status: 'running' }),
    );
    expect(check(await doctor(dir, {}), 'state-dir').passed).toBe(true);
  });
});
