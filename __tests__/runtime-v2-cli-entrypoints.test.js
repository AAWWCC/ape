import { spawnSync } from 'node:child_process';
import { mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const CASES = [
  { script: 'scripts/run-ci-tests.mjs', args: () => ['invalid-entrypoint-mode'], error: "unknown mode 'invalid-entrypoint-mode'" },
  { script: 'evals/prompt-evals.mjs', args: () => ['verify'], error: 'verify requires --results <dir>' },
  { script: 'scripts/benchmark-v2.mjs', args: (root) => ['verify', path.join(root, 'invalid-benchmark.json')], error: 'benchmark ledger contains an invalid record' },
  { script: 'scripts/export-public-tree.mjs', args: () => [], error: '--out is required' },
  { script: 'scripts/live-certification-catalog-stub.mjs', args: () => [], error: '--audit <path>' },
  { script: 'scripts/report-prompt-budgets.mjs', args: () => ['--json'], advisory: true },
  { script: 'scripts/verify-live-certification.mjs', args: () => ['--unsupported-option'], error: 'usage: verify-live-certification' },
];

let fixture;
let canonicalRoot;
let directoryAlias;

beforeAll(async () => {
  fixture = await realpath(await mkdtemp(path.join(tmpdir(), 'ape-cli-entrypoint-')));
  canonicalRoot = await realpath(ROOT);
  directoryAlias = path.join(fixture, 'checkout-alias');
  await symlink(canonicalRoot, directoryAlias, process.platform === 'win32' ? 'junction' : 'dir');
  await writeFile(path.join(fixture, 'invalid-benchmark.json'), '[{"host":"codex"}]\n');
});

afterAll(async () => {
  if (fixture) await rm(fixture, { recursive: true, force: true });
});

function invoke(args) {
  const env = { ...process.env };
  delete env.NODE_OPTIONS;
  return spawnSync(process.execPath, args, {
    cwd: fixture,
    env,
    encoding: 'utf8',
    timeout: 10_000,
    maxBuffer: 1024 * 1024,
  });
}

function expectCliExecuted(result, entry) {
  expect(result.error).toBeUndefined();
  expect(result.signal).toBeNull();
  if (entry.advisory) {
    expect(result.status).toBe(0);
    expect(result.stderr).toBe('');
    const report = JSON.parse(result.stdout);
    expect(report.advisory).toBe(true);
    expect(report.files.length).toBeGreaterThan(0);
  } else {
    expect(result.status).toBe(1);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain(entry.error);
  }
}

describe.each(CASES)('$script CLI entrypoint', (entry) => {
  it('handles inert validation or advisory inputs through its canonical path', () => {
    expectCliExecuted(invoke([path.join(canonicalRoot, entry.script), ...entry.args(fixture)]), entry);
  });

  it('executes through a checkout directory alias', () => {
    expectCliExecuted(invoke([path.join(directoryAlias, entry.script), ...entry.args(fixture)]), entry);
  });

  it('executes a directory alias with --preserve-symlinks-main', () => {
    expectCliExecuted(invoke(['--preserve-symlinks-main', path.join(directoryAlias, entry.script), ...entry.args(fixture)]), entry);
  });

  // Directory junction coverage above also runs on Windows without symlink privileges.
  it.skipIf(process.platform === 'win32')('executes through an individual script symlink', async () => {
    const link = path.join(fixture, path.basename(entry.script));
    await symlink(path.join(canonicalRoot, entry.script), link, 'file');
    expectCliExecuted(invoke([link, ...entry.args(fixture)]), entry);
  });

  it('keeps importing the module inert', () => {
    const url = pathToFileURL(path.join(canonicalRoot, entry.script)).href;
    const result = invoke(['--input-type=module', '-e', `await import(${JSON.stringify(url)}); process.stdout.write('import completed\\n');`]);
    expect(result.error).toBeUndefined();
    expect(result.signal).toBeNull();
    expect(result.status).toBe(0);
    expect(result.stdout).toBe('import completed\n');
    expect(result.stderr).toBe('');
  });

  it('keeps importing inert when argv names a nonexistent entrypoint', () => {
    const url = pathToFileURL(path.join(canonicalRoot, entry.script)).href;
    const result = invoke([
      '--input-type=module', '-e',
      `await import(${JSON.stringify(url)}); process.stdout.write('import completed\\n');`,
      path.join(fixture, 'nonexistent-entrypoint.mjs'),
    ]);
    expect(result.error).toBeUndefined();
    expect(result.signal).toBeNull();
    expect(result.status).toBe(0);
    expect(result.stdout).toBe('import completed\n');
    expect(result.stderr).toBe('');
  });
});
