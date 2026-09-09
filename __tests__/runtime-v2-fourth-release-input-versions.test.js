import { execFile } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { gunzipSync } from 'node:zlib';
import { afterEach, describe, expect, it } from 'vitest';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const VERSION = '2.25.1';
const INPUTS = [
  'plugins/ape/.codex-plugin/plugin.json',
  'plugins/ape/package.json',
  'plugins/ape-claude/.claude-plugin/plugin.json',
  'plugins/ape-claude/package.json',
];
const run = promisify(execFile);
const fixtures = [];

afterEach(async () => {
  await Promise.all(fixtures.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function put(root, name, value) {
  const target = path.join(root, name);
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, `${JSON.stringify(value)}\n`);
}

async function fixture(version = VERSION) {
  const root = await mkdtemp(path.join(tmpdir(), 'ape-fourth-release-inputs-test-'));
  fixtures.push(root);
  await mkdir(path.join(root, 'scripts'));
  for (const name of ['build-release-artifacts.mjs', 'generated-output-directory.mjs']) {
    await copyFile(path.join(ROOT, 'scripts', name), path.join(root, 'scripts', name));
  }
  await put(root, 'package.json', { version });
  await put(root, 'package-lock.json', { packages: {
    'node_modules/zod': { version: '4.4.3', license: 'MIT' },
    'node_modules/smol-toml': { version: '1.8.0', license: 'BSD-3-Clause' },
  } });
  for (const name of INPUTS) await put(root, name, { name: 'ape', version });
  return root;
}

function build(root) {
  return run(process.execPath, [path.join(root, 'scripts/build-release-artifacts.mjs')], {
    cwd: root,
    env: { ...process.env, SOURCE_DATE_EPOCH: '0' },
    timeout: 10000,
  });
}

async function outputSnapshot(root) {
  const output = path.join(root, 'release');
  const names = (await readdir(output)).sort();
  return Promise.all(names.map(async (name) => [name, await readFile(path.join(output, name))]));
}

function archivedJson(archive, name) {
  const tar = gunzipSync(archive);
  for (let offset = 0; offset + 512 <= tar.length;) {
    const header = tar.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) break;
    const text = (start, length) => header.subarray(start, start + length).toString('utf8').replace(/\0.*$/u, '');
    const size = Number.parseInt(text(124, 12).trim() || '0', 8);
    if (text(0, 100) === name) return JSON.parse(tar.subarray(offset + 512, offset + 512 + size));
    offset += 512 + Math.ceil(size / 512) * 512;
  }
  throw new Error(`archive is missing ${name}`);
}

describe('release artifact input version validation', () => {
  it.each(['0.0.0', VERSION, '12.34.56'])('keeps matching %s package identities in deterministic artifacts', async (version) => {
    const root = await fixture(version);
    await build(root);
    const before = await outputSnapshot(root);
    const manifest = JSON.parse(await readFile(path.join(root, 'release/release-manifest.json'), 'utf8'));
    expect(manifest.release).toBe(version);
    for (const [directory, host] of [['ape', 'codex'], ['ape-claude', 'claude']]) {
      const archive = await readFile(path.join(root, 'release', `ape-${host}-${version}.tar.gz`));
      for (const name of [`${directory}/.${host}-plugin/plugin.json`, `${directory}/package.json`]) {
        expect(archivedJson(archive, name).version).toBe(version);
      }
    }
    await build(root);
    expect(await outputSnapshot(root)).toEqual(before);
  });

  it('refuses stale host inputs before creating mislabeled output', async () => {
    const root = await fixture();
    await put(root, 'package.json', { version: '2.25.99' });
    await expect(build(root)).rejects.toMatchObject({
      stderr: expect.stringContaining('plugins/ape/.codex-plugin/plugin.json version must equal package.json version 2.25.99'),
    });
    await expect(readdir(path.join(root, 'release'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it.each([
    ['missing', undefined], ['null', null], ['number', 2251], ['array', [VERSION]],
    ['prefix', `v${VERSION}`], ['prerelease', `${VERSION}-rc.1`], ['build metadata', `${VERSION}+codex.1`],
    ['leading zero', '02.25.1'], ['trailing newline', `${VERSION}\n`], ['path', '../2.25.1'],
  ])('preserves old artifacts when the root version has %s', async (_label, version) => {
    const root = await fixture();
    await build(root);
    const before = await outputSnapshot(root);
    await put(root, 'package.json', { version });
    await expect(build(root)).rejects.toMatchObject({
      stderr: expect.stringContaining('package.json version must be a bare semantic version'),
    });
    expect(await outputSnapshot(root)).toEqual(before);
  });

  it.each(INPUTS)('preserves old artifacts when %s declares another version', async (name) => {
    const root = await fixture();
    await build(root);
    const before = await outputSnapshot(root);
    for (const version of ['2.25.99', `${VERSION}+codex.1`, undefined, [VERSION]]) {
      await put(root, name, { name: 'ape', version });
      await expect(build(root)).rejects.toMatchObject({
        stderr: expect.stringContaining(`${name} version must equal package.json version ${VERSION}`),
      });
      expect(await outputSnapshot(root)).toEqual(before);
    }
  });

  it.each(INPUTS)('preserves old artifacts when %s is missing or malformed', async (name) => {
    const root = await fixture();
    await build(root);
    const before = await outputSnapshot(root);
    await writeFile(path.join(root, name), '{');
    await expect(build(root)).rejects.toMatchObject({ stderr: expect.stringContaining(`${name} is not valid JSON`) });
    expect(await outputSnapshot(root)).toEqual(before);
    await rm(path.join(root, name));
    await expect(build(root)).rejects.toMatchObject({
      stderr: expect.stringContaining(`${name} must be a regular JSON manifest`),
    });
    expect(await outputSnapshot(root)).toEqual(before);
  });
});
