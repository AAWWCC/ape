import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile, copyFile, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import { writeExportedTestDurations } from '../scripts/export-public-tree.mjs';
import { SMOKE_TEST_FILES } from '../scripts/run-ci-tests.mjs';
import { capabilityTestPathBoundErrors } from '../lib/runtime/capability-contract.js';

const run = promisify(execFile);
const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const CHECKER = path.join(ROOT, 'scripts', 'check-public-surface.mjs');
const directories = [];
afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});
async function fixture() {
  const directory = await mkdtemp(path.join(tmpdir(), 'ape-public-tooling-test-'));
  directories.push(directory);
  return directory;
}
async function put(root, name, text) {
  const file = path.join(root, name);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, text);
}
async function sourceCheck(root) {
  try {
    const result = await run(process.execPath, [CHECKER, '--tracked-source', root]);
    return { code: 0, ...result };
  } catch (error) {
    return { code: error.code, stdout: error.stdout, stderr: error.stderr };
  }
}

describe('public source and exported CI regressions', () => {
  it('executes exported shard selection using only the exported test timing inventory', async () => {
    const root = await fixture();
    const extras = ['kept', 'new-one', 'new-two', 'new-three'].map((name) => `__tests__/${name}.test.js`);
    const tests = [...SMOKE_TEST_FILES, ...extras].sort();
    for (const file of tests) await put(root, file, '// synthetic test inventory fixture\n');
    await put(root, '.github/test-durations.json', JSON.stringify({
      ...Object.fromEntries(SMOKE_TEST_FILES.map((file) => [file, 10])),
      [extras[0]]: 123,
      '__tests__/omitted.test.js': 999,
    }));
    await put(root, 'scripts/placeholder', '');
    await copyFile(path.join(ROOT, 'scripts/run-ci-tests.mjs'), path.join(root, 'scripts/run-ci-tests.mjs'));
    await writeExportedTestDurations(root);
    const durations = JSON.parse(await readFile(path.join(root, '.github/test-durations.json'), 'utf8'));
    expect(Object.keys(durations)).toEqual(tests);
    expect(durations[extras[0]]).toBe(123);
    expect(durations[extras[1]]).toBeGreaterThan(0);
    const moduleUrl = pathToFileURL(path.join(root, 'scripts/run-ci-tests.mjs')).href;
    const result = await run(process.execPath, ['--input-type=module', '-e',
      `const {selectCiTests}=await import(${JSON.stringify(moduleUrl)}); console.log(JSON.stringify(await Promise.all([1,2,3].map(n=>selectCiTests('shard',n,3)))));`,
    ], { cwd: root });
    const selected = JSON.parse(result.stdout).flat().sort();
    expect(selected).toEqual(extras.sort());
    expect(new Set(selected).size).toBe(selected.length);
  });

  it('scans tracked docs and tests even when ignore rules try to hide them, without echoing private values', async () => {
    const root = await fixture();
    await run('git', ['init', '-q'], { cwd: root });
    const privateEmail = ['fixture-person', 'private-domain.dev'].join('@');
    const privatePath = ['docs', 'private-fixture.md'].join('/');
    await put(root, privatePath, `Synthetic detector input: ${privateEmail}\n`);
    await put(root, '__tests__/fixture.test.js', `const detectorInput = ${JSON.stringify(privateEmail)};\n`);
    await run('git', ['add', '.'], { cwd: root });
    await put(root, '.gitignore', 'docs/\n__tests__/\n.ape/\n');
    await put(root, '.ape/local-secret', privateEmail);
    const result = await sourceCheck(root);
    expect(result.code).not.toBe(0);
    expect(result.stderr.match(/personal\/non-fixture email address/gu)).toHaveLength(2);
    expect(result.stderr).not.toContain(privateEmail);
    expect(result.stderr).not.toContain(privatePath);
  });

  it('includes new nonignored source files but accepts explicitly assembled negative-test fixtures', async () => {
    const root = await fixture();
    await run('git', ['init', '-q'], { cwd: root });
    await put(root, '__tests__/fixture.test.js', "const negativeFixture = ['fixture-person', 'private-domain.dev'].join('@');\n");
    expect((await sourceCheck(root)).code).toBe(0);
    const syntheticSecret = ['ghp_', 'x'.repeat(32)].join('');
    await put(root, 'docs/new-file.md', syntheticSecret);
    const result = await sourceCheck(root);
    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain('secret/private-key pattern');
    expect(result.stderr).not.toContain(syntheticSecret);
  });

  it('retains audio and runtime-path protections for tracked source', async () => {
    const root = await fixture();
    await run('git', ['init', '-q'], { cwd: root });
    await put(root, 'docs/renamed-fixture.bin', Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WAVEdata')]));
    await put(root, '.ape/fixture.json', '{}');
    await run('git', ['add', '-f', '.'], { cwd: root });
    const result = await sourceCheck(root);
    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain('audio file signature');
    expect(result.stderr).toContain('private/runtime path');
  });

  it('does not echo parser excerpts from malformed tracked MCP declarations', async () => {
    const root = await fixture();
    await run('git', ['init', '-q'], { cwd: root });
    const marker = 'synthetic-sensitive-parser-content';
    await put(root, '.mcp.json', `{"mcpServers": ${marker}`);
    const result = await sourceCheck(root);
    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain('invalid public MCP or plugin contract');
    expect(result.stderr).not.toContain(marker);
  });

  it.skipIf(process.platform === 'win32')('rejects a tracked symlink without reading its external target', async () => {
    const root = await fixture();
    const external = await fixture();
    await run('git', ['init', '-q'], { cwd: root });
    await put(external, 'target.txt', ['fixture-person', 'private-domain.dev'].join('@'));
    await symlink(path.join(external, 'target.txt'), path.join(root, 'link.txt'));
    await run('git', ['add', '.'], { cwd: root });
    const result = await sourceCheck(root);
    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain('symlink');
    expect(result.stderr).not.toContain('personal/non-fixture email');
  });

  it('keeps historical recovery bounds distinct from the current valid resource contract in shipped instructions', async () => {
    const paths = Array.from({ length: 65 }, (_, index) => `tests/fixture-${index}.test.js`);
    expect(capabilityTestPathBoundErrors(paths).valid).toBe(true);
    expect(capabilityTestPathBoundErrors(paths, { version: 1 }).valid).toBe(false);
    const resume = await readFile(path.join(ROOT, 'plugin-src/skills/resume/body.md'), 'utf8');
    expect(resume).toMatch(/growth\s+contract v2[\s\S]*actual rendered[\s\S]*command and manifest budgets/iu);
    expect(resume).toMatch(/Historical growth contract v1 retains its 64-item\/4096-byte bounds/u);
    const roadmap = await readFile(path.join(ROOT, 'plugin-src/skills/roadmap/body.md'), 'utf8');
    expect(roadmap).toMatch(/shared input-byte and\s+structural guards/u);
    expect(roadmap).not.toContain('at most 64 entries');
  });
});
