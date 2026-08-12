import { describe, it, expect, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { doctor } from '../lib/runtime/doctor.js';

const REPO_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

// friction-18-self-release-gap (friction findings #18/#11 in
// .planning/pipeline-friction-2026-07-06.md): in APE's own repository the live
// MCP server and lifecycle hooks execute the installed plugin's dist/ bundle,
// so a session that builds a new APE release keeps running under the OLD
// runtime until the plugin reloads. Doctor must surface that bundle drift as
// an informational notice carrying the reload/fresh-session remediation —
// NEVER a health failure that could block a run start — and must pass
// silently in every managed project that carries no APE dist/ bundle.
//
// Contract under test (the check's name must match /bundle[-_ ]?drift/i):
//  (a) drift => a check entry with informational: true, passed !== false;
//  (b) drift never flips report.healthy to false, in diagnosis mode or with a
//      sound run-start context, on any host (host-neutral);
//  (c) no APE dist/ bundle in the project => no drift notice at all.
describe('ape v2 doctor bundle-drift notice (friction #18/#11)', () => {
  const dirs = [];
  afterEach(() => dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })));

  function gitProject() {
    const dir = mkdtempSync(join(tmpdir(), 'ape-bundle-drift-'));
    dirs.push(dir);
    execFileSync('git', ['init'], { cwd: dir, stdio: 'ignore' });
    return dir;
  }

  function commitAll(dir, message) {
    execFileSync('git', ['add', '--all'], { cwd: dir, stdio: 'ignore' });
    execFileSync(
      'git',
      [
        '-c',
        'user.email=ape@test.invalid',
        '-c',
        'user.name=ape-test',
        'commit',
        '--no-verify',
        '--no-gpg-sign',
        '-m',
        message,
      ],
      { cwd: dir, stdio: 'ignore' },
    );
  }

  // A project carrying tracked, committed APE dist/ bundles whose bytes cannot
  // match the runtime actually executing this test (the checkout this doctor
  // was loaded from builds the real bundles; these are drifted stand-ins).
  function driftedApeProject() {
    const dir = gitProject();
    mkdirSync(join(dir, 'dist'), { recursive: true });
    for (const bundle of ['ape-mcp.bundle.mjs', 'ape-hooks.bundle.mjs', 'ape-larp.bundle.mjs']) {
      writeFileSync(
        join(dir, 'dist', bundle),
        `// fake ${bundle}: bytes that deliberately differ from the executing runtime bundle\n`,
      );
    }
    commitAll(dir, 'seed drifted dist bundles');
    return dir;
  }

  const driftCheck = (report) => report.checks.find((entry) => /bundle[\s_.-]?drift/i.test(String(entry.name)));
  // "Silent" means no drift notice is surfaced: either no drift-named check
  // entry at all, or one that affirmatively passed (reported no drift).
  const driftNotices = (report) =>
    report.checks.filter((entry) => /bundle[\s_.-]?drift/i.test(String(entry.name)) && entry.passed !== true);

  it('reports drift as an informational notice when the tracked dist/ bundle differs from the executing runtime', async () => {
    const dir = driftedApeProject();
    const report = await doctor(dir, {});
    const entry = driftCheck(report);
    expect(entry).toBeDefined();
    expect(entry.informational).toBe(true);
    expect(entry.passed).not.toBe(false); // informational, never a failure
    expect(entry.detail).toMatch(/drift|differ|stale/i);
    // The notice must carry the release-verification remediation: a rebuilt
    // bundle governs only after a plugin reload, verified in a fresh session.
    expect(entry.detail).toMatch(/reload|fresh session|restart/i);
  });

  it('never marks the doctor unhealthy for bundle drift (diagnosis mode)', async () => {
    const dir = driftedApeProject();
    const report = await doctor(dir, {});
    expect(report.healthy).toBe(true);
    // The notice is present, yet health is untouched.
    expect(driftCheck(report)).toBeDefined();
  });

  it('never blocks a run start: a sound run-start context stays healthy under drift, host-neutrally', async () => {
    for (const host of ['claude', 'codex']) {
      const dir = driftedApeProject();
      const report = await doctor(dir, {
        explicit_invocation: true,
        hooks_trusted: true,
        subagents_available: true,
        host,
        behavioral: false,
      });
      expect(report.healthy).toBe(true);
      // Host-neutral: the same drift notice appears regardless of host.
      expect(driftCheck(report)).toBeDefined();
    }
  });

  it('passes silently in a managed project that carries no dist/ directory at all', async () => {
    const dir = gitProject();
    const report = await doctor(dir, {});
    expect(driftNotices(report)).toEqual([]);
    expect(report.healthy).toBe(true);
  });

  it('passes silently in a managed project whose dist/ holds only non-APE build output', async () => {
    const dir = gitProject();
    mkdirSync(join(dir, 'dist'), { recursive: true });
    writeFileSync(join(dir, 'dist', 'index.js'), 'export default 42;\n');
    commitAll(dir, 'seed non-APE dist output');
    const report = await doctor(dir, {});
    expect(driftNotices(report)).toEqual([]);
    expect(report.healthy).toBe(true);
  });

  it('reports no drift when the tracked dist/ bundle IS the executing runtime (the APE repo itself)', async () => {
    // Doctor was loaded from this checkout, whose built output is
    // REPO_ROOT/dist: identical bytes are not drift. Assert only drift
    // silence — overall health depends on live repo state this test does not
    // own, and the check must never be the thing that flips it anyway.
    const report = await doctor(REPO_ROOT, {});
    expect(driftNotices(report)).toEqual([]);
  });
});
