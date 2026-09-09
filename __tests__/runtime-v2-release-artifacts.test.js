import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { cp, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { gunzipSync } from 'node:zlib';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { build } from 'esbuild';
import { replaceGeneratedDirectory } from '../scripts/generated-output-directory.mjs';
import { BUNDLE_ENTRIES, BUNDLE_OPTIONS } from '../scripts/bundle-definition.mjs';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const VERSION = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version;
const run = promisify(execFile);
let scratch;
let RELEASE;

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function packageVerificationCode(files) {
  const checksums = files
    .map((file) => file.checksums.find((checksum) => checksum.algorithm === 'SHA1')?.checksumValue)
    .sort();
  expect(checksums.every(Boolean)).toBe(true);
  return createHash('sha1').update(checksums.join('')).digest('hex');
}

function tarEntries(archive) {
  const tar = gunzipSync(archive);
  const entries = [];
  for (let offset = 0; offset + 512 <= tar.length;) {
    const header = tar.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) break;
    const field = (start, length) => header.subarray(start, start + length).toString('utf8').replace(/\0.*$/u, '');
    const leaf = field(0, 100);
    const prefix = field(345, 155);
    const size = Number.parseInt(field(124, 12).trim() || '0', 8);
    const mode = Number.parseInt(field(100, 8).trim() || '0', 8);
    const type = field(156, 1);
    const dataStart = offset + 512;
    entries.push({
      name: prefix ? `${prefix}/${leaf}` : leaf,
      size,
      mode,
      type,
      payload: Buffer.from(tar.subarray(dataStart, dataStart + size)),
    });
    offset += 512 + Math.ceil(size / 512) * 512;
  }
  return entries;
}

async function packageFiles(root) {
  const files = [];
  async function visit(directory) {
    const entries = (await readdir(directory, { withFileTypes: true }))
      .sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0);
    for (const entry of entries) {
      const target = path.join(directory, entry.name);
      if (entry.isDirectory()) await visit(target);
      else if (entry.isFile()) files.push(path.relative(root, target).split(path.sep).join('/'));
    }
  }
  await visit(root);
  return files;
}

describe('2.17 deterministic release artifacts', () => {
  beforeAll(async () => {
    scratch = await mkdtemp(path.join(tmpdir(), 'ape-release-test-'));
    RELEASE = path.join(scratch, 'release');
    await run(process.execPath, [
      path.join(ROOT, 'scripts', 'build-release-artifacts.mjs'),
      '--output-root',
      RELEASE,
    ], {
      cwd: ROOT,
      env: {
        ...process.env,
        LC_ALL: 'C',
        SOURCE_DATE_EPOCH: '0',
        TZ: 'UTC',
      },
    });
  });

  afterAll(async () => {
    if (scratch) await rm(scratch, { recursive: true, force: true });
  });

  it('ships one sound-free ustar package for each host with normalized modes', async () => {
    for (const [host, rootName] of [['codex', 'ape'], ['claude', 'ape-claude']]) {
      const archive = await readFile(path.join(RELEASE, `ape-${host}-${VERSION}.tar.gz`));
      expect(archive.readUInt32LE(4)).toBe(0);
      const entries = tarEntries(archive);
      expect(entries[0]).toMatchObject({ name: `${rootName}/`, size: 0, mode: 0o755, type: '5' });
      expect(entries.some((entry) => entry.name.includes('/assets/'))).toBe(false);
      for (const entry of entries) {
        expect(entry.mode).toBe(entry.type === '5' ? 0o755 : 0o644);
      }
      const packageRoot = path.join(ROOT, 'plugins', rootName);
      const archivedFiles = entries.filter((entry) => entry.type !== '5');
      const expectedFiles = await packageFiles(packageRoot);
      expect(archivedFiles.map((entry) => entry.name.slice(rootName.length + 1)))
        .toEqual(expectedFiles);
      for (const entry of archivedFiles) {
        const relative = entry.name.slice(rootName.length + 1);
        expect(sha256(entry.payload), relative).toBe(sha256(await readFile(path.join(packageRoot, relative))));
      }
    }
  });

  it('binds release manifest and checksum ledger to exact artifact bytes', async () => {
    const manifest = JSON.parse(await readFile(path.join(RELEASE, 'release-manifest.json'), 'utf8'));
    expect(manifest).toMatchObject({
      version: 1,
      release: VERSION,
      source_date_epoch: 0,
      transport: 'local-stdio',
    });
    expect(manifest.artifacts.map((artifact) => artifact.name)).toEqual([
      `ape-codex-${VERSION}.tar.gz`,
      `ape-claude-${VERSION}.tar.gz`,
      `ape-${VERSION}.spdx.json`,
    ]);
    for (const artifact of manifest.artifacts) {
      const bytes = await readFile(path.join(RELEASE, artifact.name));
      expect(artifact.bytes).toBe(bytes.length);
      expect(artifact.sha256).toBe(sha256(bytes));
    }
    const sums = await readFile(path.join(RELEASE, 'SHA256SUMS'), 'utf8');
    for (const name of [...manifest.artifacts.map((artifact) => artifact.name), 'release-manifest.json']) {
      const bytes = await readFile(path.join(RELEASE, name));
      expect(sums).toContain(`${sha256(bytes)}  ${name}`);
    }
  });

  it('publishes an SPDX 2.3 SBOM with both package inventories', async () => {
    const sbom = JSON.parse(await readFile(path.join(RELEASE, `ape-${VERSION}.spdx.json`), 'utf8'));
    const lock = JSON.parse(await readFile(path.join(ROOT, 'package-lock.json'), 'utf8'));
    expect(sbom).toMatchObject({ spdxVersion: 'SPDX-2.3', dataLicense: 'CC0-1.0' });
    expect(sbom.packages.map((item) => item.name).sort()).toEqual(['ape-claude', 'ape-codex', 'smol-toml', 'zod']);
    expect(sbom.packages.find((item) => item.name === 'zod')).toMatchObject({
      versionInfo: lock.packages['node_modules/zod'].version,
      licenseDeclared: 'MIT',
      copyrightText: 'Copyright (c) 2025 Colin McDonnell',
    });
    expect(
      sbom.relationships.filter((item) => item.relatedSpdxElement === 'SPDXRef-Package-Zod'),
    ).toHaveLength(2);
    expect(sbom.packages.find((item) => item.name === 'smol-toml')).toMatchObject({
      versionInfo: lock.packages['node_modules/smol-toml'].version,
      licenseDeclared: 'BSD-3-Clause',
    });
    expect(sbom.relationships.filter((item) => item.relatedSpdxElement === 'SPDXRef-Package-SmolToml')).toHaveLength(2);
    expect(sbom.files.length).toBeGreaterThan(50);
    expect(sbom.files.some((file) => file.fileName.includes('/assets/'))).toBe(false);
    expect(sbom.files.every((file) => file.checksums[0].algorithm === 'SHA256')).toBe(true);
    for (const [packageName, directory] of [['ape-codex', 'ape'], ['ape-claude', 'ape-claude']]) {
      const packageEntry = sbom.packages.find((item) => item.name === packageName);
      const files = sbom.files.filter((file) => file.fileName.startsWith(`./plugins/${directory}/`));
      expect(packageEntry.filesAnalyzed).toBe(true);
      expect(packageEntry.packageVerificationCode).toEqual({
        packageVerificationCodeValue: packageVerificationCode(files),
      });
    }
  });

  it('discloses every external package included by the actual runtime bundle graph', async () => {
    const bundled = new Set();
    for (const bundle of BUNDLE_ENTRIES) {
      const result = await build({ ...BUNDLE_OPTIONS, absWorkingDir: ROOT, entryPoints: [bundle.entry],
        write: false, metafile: true });
      for (const input of Object.keys(result.metafile.inputs).filter((file) => file.startsWith('node_modules/'))) {
        const parts = input.split('/');
        bundled.add(parts.slice(1, parts[1].startsWith('@') ? 3 : 2).join('/'));
      }
    }
    const sbom = JSON.parse(await readFile(path.join(RELEASE, `ape-${VERSION}.spdx.json`), 'utf8'));
    expect(sbom.packages.filter((item) => !item.filesAnalyzed).map((item) => item.name).sort())
      .toEqual([...bundled].sort());
    const notices = await readFile(path.join(ROOT, 'THIRD_PARTY_NOTICES.md'), 'utf8');
    const license = await readFile(path.join(ROOT, 'node_modules', 'smol-toml', 'LICENSE'), 'utf8');
    expect(notices).toContain(license.trim());
  });

  it('ships the locked bundled dependency license in both host packages', async () => {
    const lock = JSON.parse(await readFile(path.join(ROOT, 'package-lock.json'), 'utf8'));
    expect(Object.keys(lock.packages[''].dependencies)).toEqual(['smol-toml', 'zod']);
    for (const packageRoot of ['ape', 'ape-claude']) {
      const notice = await readFile(
        path.join(ROOT, 'plugins', packageRoot, 'THIRD_PARTY_NOTICES.md'),
        'utf8',
      );
      expect(notice).toContain(`Zod ${lock.packages['node_modules/zod'].version}`);
      expect(notice).toContain('Copyright (c) 2025 Colin McDonnell');
      expect(notice).toContain('Permission is hereby granted, free of charge');
    }
  });

  it('refuses source-root, ancestor, and source-subdirectory output without removing source files', async () => {
    const repository = path.join(scratch, 'source-copy');
    await mkdir(path.join(repository, 'scripts'), { recursive: true });
    for (const file of ['build-release-artifacts.mjs', 'generated-output-directory.mjs']) {
      await cp(path.join(ROOT, 'scripts', file), path.join(repository, 'scripts', file));
    }
    await writeFile(path.join(repository, 'sentinel.txt'), 'source stays');
    for (const output of [repository, scratch, path.join(repository, 'scripts')]) {
      await expect(run(process.execPath, [path.join(repository, 'scripts', 'build-release-artifacts.mjs'),
        '--output-root', output])).rejects.toMatchObject({ stderr: expect.stringContaining('must not replace the source') });
      expect(await readFile(path.join(repository, 'sentinel.txt'), 'utf8')).toBe('source stays');
    }
  });

  it('preserves an unrelated output directory and unexpected files in an otherwise valid release', async () => {
    const output = path.join(scratch, 'unrelated-output');
    await mkdir(output);
    await writeFile(path.join(output, 'notes.txt'), 'keep my notes');
    const build = (destination) => run(process.execPath, [path.join(ROOT, 'scripts', 'build-release-artifacts.mjs'),
      '--output-root', destination]);
    await expect(build(output)).rejects.toMatchObject({ stderr: expect.stringContaining('not recognized APE release artifacts') });
    expect(await readFile(path.join(output, 'notes.txt'), 'utf8')).toBe('keep my notes');
    const owned = path.join(scratch, 'repeat-output');
    await build(owned);
    const before = await readFile(path.join(owned, 'SHA256SUMS'), 'utf8');
    await build(owned);
    expect(await readFile(path.join(owned, 'SHA256SUMS'), 'utf8')).toBe(before);
    await writeFile(path.join(owned, 'notes.txt'), 'keep my notes too');
    await expect(build(owned)).rejects.toMatchObject({ stderr: expect.stringContaining('not recognized APE release artifacts') });
    expect(await readFile(path.join(owned, 'notes.txt'), 'utf8')).toBe('keep my notes too');
  });

  it.skipIf(process.platform === 'win32')('refuses a destination symlink without touching its external contents', async () => {
    const outside = path.join(scratch, 'outside-output');
    const linked = path.join(scratch, 'linked-output');
    await mkdir(outside);
    await writeFile(path.join(outside, 'notes.txt'), 'outside stays');
    await symlink(outside, linked);
    await expect(run(process.execPath, [path.join(ROOT, 'scripts', 'build-release-artifacts.mjs'),
      '--output-root', linked])).rejects.toMatchObject({ stderr: expect.stringContaining('plain directory') });
    expect(await readFile(path.join(outside, 'notes.txt'), 'utf8')).toBe('outside stays');
  });

  it('restores previous output after a staged publication fails', async () => {
    const source = path.join(scratch, 'publication-source');
    const output = path.join(scratch, 'publication-output');
    await mkdir(source); await mkdir(output);
    await writeFile(path.join(source, 'new.txt'), 'new output');
    await writeFile(path.join(output, 'old.txt'), 'old output');
    await expect(replaceGeneratedDirectory(source, output, {
      sourceRoot: ROOT, allowedOutputs: [],
      async validateExisting(directory) {
        if (path.basename(directory) === 'previous') {
          // Lose staged files after the old directory has been moved aside,
          // forcing the real rename to fail before it can replace old output.
          await rm(path.join(path.dirname(directory), 'next'), { recursive: true });
        }
      },
    })).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await readdir(output)).toEqual(['old.txt']);
    expect(await readFile(path.join(output, 'old.txt'), 'utf8')).toBe('old output');
    expect((await readdir(scratch)).some((entry) => entry.startsWith('.publication-output.next-'))).toBe(false);
  });
});
