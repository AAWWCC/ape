import { execFileSync, spawnSync } from 'node:child_process';
import { build } from 'esbuild';
import { link, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { hostname, tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { doctor } from '../lib/runtime/doctor.js';
import { ACTIVE_STATE_MAX_BYTES } from '../lib/runtime/active-state.js';
import { runtimePaths } from '../lib/runtime/paths.js';

const fixtures = [];
const sourceRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const doctorUrl = new URL('../lib/runtime/doctor.js', import.meta.url).href;
afterEach(async () => {
  await Promise.all(fixtures.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function fixture() {
  const directory = await mkdtemp(path.join(tmpdir(), 'ape-fourth-doctor-'));
  fixtures.push(directory);
  await mkdir(path.join(directory, 'dist'));
  execFileSync('git', ['init', '-q'], { cwd: directory });
  return directory;
}

function childReport(directory, script) {
  return spawnSync(process.execPath, ['--input-type=module', '-e', script,
    directory, doctorUrl], { encoding: 'utf8', timeout: 3000 });
}

function checkedReport(child) {
  expect(child.error?.code, child.stderr).not.toBe('ETIMEDOUT');
  expect(child.status, child.stderr).toBe(0);
  return JSON.parse(child.stdout);
}

async function buildDoctor(directory, name = 'ape-mcp.bundle.mjs') {
  const file = path.join(directory, 'dist', name);
  await build({
    stdin: { contents: `export { doctor, LOADED_BUNDLE_STAMP } from ${JSON.stringify(path.join(sourceRoot, 'lib/runtime/doctor.js'))};`, resolveDir: sourceRoot },
    bundle: true, platform: 'node', format: 'esm', target: 'node22', outfile: file, logLevel: 'silent',
  });
  return file;
}

describe('fourth-pass doctor diagnostic file boundaries', () => {
  it.skipIf(process.platform === 'win32')('finishes diagnosis when a tracked bundle becomes a FIFO', async () => {
    const directory = await fixture();
    const bundle = path.join(directory, 'dist', 'ape-mcp.bundle.mjs');
    await writeFile(bundle, 'export {};\n');
    execFileSync('git', ['add', 'dist'], { cwd: directory });
    await rm(bundle);
    execFileSync('mkfifo', [bundle]);
    const report = checkedReport(childReport(directory, `
      const { doctor } = await import(process.argv[2]);
      process.stdout.write(JSON.stringify(await doctor(process.argv[1])));
    `));
    expect(report.healthy).toBe(true);
    expect(report.checks.some((check) => check.name === 'bundle-drift')).toBe(false);
  });

  it.skipIf(process.platform === 'win32')('does not block module initialization on a FIFO bundle candidate', async () => {
    const directory = await fixture();
    const auditor = await buildDoctor(directory, 'auditor.mjs');
    execFileSync('mkfifo', [path.join(directory, 'dist', 'ape-mcp.bundle.mjs')]);
    const child = childReport(directory, `
      const { LOADED_BUNDLE_STAMP } = await import(${JSON.stringify(pathToFileURL(auditor).href)});
      process.stdout.write(JSON.stringify({ stamp: LOADED_BUNDLE_STAMP }));
    `);
    expect(checkedReport(child)).toEqual({ stamp: null });
  });

  it.skipIf(process.platform === 'win32')('finishes the loaded-module check after the executing bundle becomes a FIFO', async () => {
    const directory = await fixture();
    const bundle = await buildDoctor(directory);
    await writeFile(path.join(directory, 'dist', 'ape-hooks.bundle.mjs'), 'export {};\n');
    execFileSync('git', ['add', 'dist/ape-hooks.bundle.mjs'], { cwd: directory });
    const report = checkedReport(childReport(directory, `
      import { unlinkSync } from 'node:fs';
      import { execFileSync } from 'node:child_process';
      const { doctor } = await import(${JSON.stringify(pathToFileURL(bundle).href)});
      unlinkSync(${JSON.stringify(bundle)});
      execFileSync('mkfifo', [${JSON.stringify(bundle)}]);
      process.stdout.write(JSON.stringify(await doctor(process.argv[1])));
    `));
    expect(report.healthy).toBe(true);
    expect(report.checks.some((check) => check.name === 'loaded-module-drift')).toBe(false);
  });

  it('still compares ordinary symlinked bundle deployments', async () => {
    const directory = await fixture();
    const ordinary = path.join(directory, 'ordinary.mjs');
    await writeFile(ordinary, '// an ordinary symlinked deployment with different bytes\n');
    await symlink(ordinary, path.join(directory, 'dist', 'ape-mcp.bundle.mjs'));
    execFileSync('git', ['add', 'dist'], { cwd: directory });
    const report = await doctor(directory);
    expect(report.healthy).toBe(true);
    expect(report.checks.find((check) => check.name === 'bundle-drift'))
      .toMatchObject({ passed: null, informational: true });
  });

  it.each(['symlink', 'hardlink', 'oversized', 'invalid ticket'])('diagnoses %s active state with the same boundary as run operations', async (fault) => {
    const directory = await fixture();
    const paths = runtimePaths(directory);
    await mkdir(paths.runtime, { recursive: true });
    const ordinary = path.join(directory, 'ordinary.json');
    await writeFile(ordinary, JSON.stringify({ run_id: 'run-doctor', status: 'running' }));
    if (fault === 'symlink') await symlink(ordinary, paths.active);
    else if (fault === 'hardlink') await link(ordinary, paths.active);
    else if (fault === 'oversized') {
      await writeFile(paths.active, JSON.stringify({ run_id: 'run-doctor', padding: 'x'.repeat(ACTIVE_STATE_MAX_BYTES) }));
    } else {
      await writeFile(paths.active, JSON.stringify({ run_id: 'run-doctor', tickets: [null] }));
    }
    const report = await doctor(directory);
    const state = report.checks.find((check) => check.name === 'state-dir');
    if (fault === 'invalid ticket') {
      expect(state).toMatchObject({ passed: null, informational: true, warning: true });
      expect(state.detail).toContain('schema-invalid');
    } else {
      expect(state.passed).toBe(false);
      expect(state.detail).toMatch(/unsafe|oversized/);
    }
    await writeFile(paths.lock, JSON.stringify({ version: 1, run_id: 'run-doctor', pid: process.pid, host: hostname() }));
    expect((await doctor(directory)).checks.find((check) => check.name === 'lock-health').passed).toBe(false);
  });
});
