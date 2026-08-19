#!/usr/bin/env node

import { createHash } from 'node:crypto';
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = dirname(SCRIPT_DIR);
const DEFAULT_OUTPUT = join(REPO_ROOT, 'release');
const PACKAGE_NAMES = Object.freeze([
  ['ape', 'codex'],
  ['ape-claude', 'claude'],
]);

class ReleaseError extends Error {}

function compareNames(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function parseArgs(argv) {
  let output = DEFAULT_OUTPUT;
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] !== '--output-root') throw new ReleaseError(`unknown argument: ${argv[index]}`);
    const value = argv[index + 1];
    if (!value || value.startsWith('--')) throw new ReleaseError('--output-root requires a path');
    output = resolve(value);
    index += 1;
  }
  return output;
}

function sourceDateEpoch() {
  const raw = process.env.SOURCE_DATE_EPOCH ?? '0';
  if (!/^(?:0|[1-9]\d*)$/u.test(raw)) {
    throw new ReleaseError('SOURCE_DATE_EPOCH must be a non-negative integer');
  }
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value > 0xFFFF_FFFF) {
    throw new ReleaseError('SOURCE_DATE_EPOCH is outside the gzip timestamp range');
  }
  return value;
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function sha1(bytes) {
  return createHash('sha1').update(bytes).digest('hex');
}

function packageVerificationCode(entries) {
  const checksums = entries.map((entry) => sha1(entry.bytes)).sort(compareNames);
  return createHash('sha1').update(checksums.join('')).digest('hex');
}

async function inventory(root) {
  const entries = [];
  async function visit(directory) {
    const children = (await readdir(directory, { withFileTypes: true }))
      .sort((left, right) => compareNames(left.name, right.name));
    for (const child of children) {
      const target = join(directory, child.name);
      const name = relative(root, target).split(sep).join('/');
      if (child.isSymbolicLink()) throw new ReleaseError(`release input refuses symlink: ${target}`);
      if (child.isDirectory()) {
        entries.push({ name: `${name}/`, type: 'directory', bytes: null });
        await visit(target);
      } else if (child.isFile()) {
        entries.push({ name, type: 'file', bytes: await readFile(target) });
      } else throw new ReleaseError(`release input refuses special file: ${target}`);
    }
  }
  await visit(root);
  return entries;
}

function writeString(buffer, offset, length, value) {
  const bytes = Buffer.from(value, 'utf8');
  if (bytes.length > length) throw new ReleaseError(`tar field is too long: ${value}`);
  bytes.copy(buffer, offset);
}

function writeOctal(buffer, offset, length, value) {
  const octal = value.toString(8);
  if (octal.length > length - 1) throw new ReleaseError(`tar numeric field is too large: ${value}`);
  writeString(buffer, offset, length, `${octal.padStart(length - 1, '0')}\0`);
}

function tarName(name) {
  if (Buffer.byteLength(name) <= 100) return { name, prefix: '' };
  const slashPositions = [...name.matchAll(/\//gu)].map((match) => match.index);
  for (const index of slashPositions.reverse()) {
    const prefix = name.slice(0, index);
    const leaf = name.slice(index + 1);
    if (Buffer.byteLength(prefix) <= 155 && Buffer.byteLength(leaf) <= 100) {
      return { name: leaf, prefix };
    }
  }
  throw new ReleaseError(`tar path is too long for ustar: ${name}`);
}

function tarHeader(name, type, size, epoch) {
  const header = Buffer.alloc(512);
  const split = tarName(name);
  writeString(header, 0, 100, split.name);
  writeOctal(header, 100, 8, type === 'directory' ? 0o755 : 0o644);
  writeOctal(header, 108, 8, 0);
  writeOctal(header, 116, 8, 0);
  writeOctal(header, 124, 12, size);
  writeOctal(header, 136, 12, epoch);
  header.fill(0x20, 148, 156);
  writeString(header, 156, 1, type === 'directory' ? '5' : '0');
  writeString(header, 257, 6, 'ustar\0');
  writeString(header, 263, 2, '00');
  writeString(header, 345, 155, split.prefix);
  const checksum = header.reduce((total, byte) => total + byte, 0);
  writeString(header, 148, 8, `${checksum.toString(8).padStart(6, '0')}\0 `);
  return header;
}

async function archivePackage(packageRoot, archiveRoot, epoch) {
  const chunks = [tarHeader(`${archiveRoot}/`, 'directory', 0, epoch)];
  for (const entry of await inventory(packageRoot)) {
    const archiveName = `${archiveRoot}/${entry.name}`;
    const size = entry.bytes?.length ?? 0;
    chunks.push(tarHeader(archiveName, entry.type, size, epoch));
    if (entry.bytes) {
      chunks.push(entry.bytes);
      const padding = (512 - (entry.bytes.length % 512)) % 512;
      if (padding > 0) chunks.push(Buffer.alloc(padding));
    }
  }
  chunks.push(Buffer.alloc(1024));
  const compressed = gzipSync(Buffer.concat(chunks), { level: 9 });
  // Node emits a deterministic zero gzip timestamp. Set the four-byte MTIME
  // field explicitly so both gzip and ustar timestamps derive from the pinned
  // SOURCE_DATE_EPOCH; the payload CRC does not cover the gzip header.
  compressed.writeUInt32LE(epoch, 4);
  return compressed;
}

function spdxId(host, name) {
  return `SPDXRef-File-${host}-${sha256(Buffer.from(name)).slice(0, 16)}`;
}

async function spdx(version, epoch) {
  const packageLock = JSON.parse(await readFile(join(REPO_ROOT, 'package-lock.json'), 'utf8'));
  const zodVersion = packageLock.packages?.['node_modules/zod']?.version;
  if (typeof zodVersion !== 'string' || !zodVersion) {
    throw new ReleaseError('package-lock.json has no pinned node_modules/zod version');
  }
  const packages = [];
  const files = [];
  const relationships = [];
  for (const [directory, host] of PACKAGE_NAMES) {
    const packageId = `SPDXRef-Package-APE-${host}`;
    const packageFiles = (await inventory(join(REPO_ROOT, 'plugins', directory)))
      .filter((entry) => entry.type === 'file');
    packages.push({
      SPDXID: packageId,
      name: `ape-${host}`,
      versionInfo: version,
      downloadLocation: 'NOASSERTION',
      filesAnalyzed: true,
      licenseConcluded: 'MIT',
      licenseDeclared: 'MIT',
      copyrightText: 'NOASSERTION',
      packageVerificationCode: {
        packageVerificationCodeValue: packageVerificationCode(packageFiles),
      },
    });
    relationships.push({
      spdxElementId: 'SPDXRef-DOCUMENT',
      relationshipType: 'DESCRIBES',
      relatedSpdxElement: packageId,
    });
    relationships.push({
      spdxElementId: packageId,
      relationshipType: 'DEPENDS_ON',
      relatedSpdxElement: 'SPDXRef-Package-Zod',
    });
    for (const entry of packageFiles) {
      const fileId = spdxId(host, entry.name);
      files.push({
        SPDXID: fileId,
        fileName: `./plugins/${directory}/${entry.name}`,
        checksums: [
          { algorithm: 'SHA256', checksumValue: sha256(entry.bytes) },
          { algorithm: 'SHA1', checksumValue: sha1(entry.bytes) },
        ],
        licenseConcluded: 'NOASSERTION',
        copyrightText: 'NOASSERTION',
      });
      relationships.push({
        spdxElementId: packageId,
        relationshipType: 'CONTAINS',
        relatedSpdxElement: fileId,
      });
    }
  }
  packages.push({
    SPDXID: 'SPDXRef-Package-Zod',
    name: 'zod',
    versionInfo: zodVersion,
    downloadLocation: 'NOASSERTION',
    filesAnalyzed: false,
    licenseConcluded: 'MIT',
    licenseDeclared: 'MIT',
    copyrightText: 'Copyright (c) 2025 Colin McDonnell',
  });
  return {
    spdxVersion: 'SPDX-2.3',
    dataLicense: 'CC0-1.0',
    SPDXID: 'SPDXRef-DOCUMENT',
    name: `ape-${version}-plugin-packages`,
    documentNamespace: `https://github.com/AAWWCC/ape/releases/download/v${version}/ape-${version}.spdx.json`,
    creationInfo: {
      created: new Date(epoch * 1000).toISOString().replace('.000Z', 'Z'),
      creators: ['Organization: AAWWCC', 'Tool: APE deterministic release builder'],
    },
    packages,
    files,
    relationships,
  };
}

async function writeArtifact(root, name, bytes) {
  const target = join(root, name);
  await writeFile(target, bytes);
  await chmod(target, 0o644);
  const metadata = await stat(target);
  return { name, bytes: metadata.size, sha256: sha256(bytes) };
}

async function replaceDirectory(source, destination) {
  await mkdir(dirname(destination), { recursive: true });
  const temporary = join(dirname(destination), `.${basename(destination)}.next-${process.pid}`);
  await rm(temporary, { recursive: true, force: true });
  await rename(source, temporary);
  await rm(destination, { recursive: true, force: true });
  await rename(temporary, destination);
}

async function main(argv) {
  const output = parseArgs(argv);
  const epoch = sourceDateEpoch();
  const packageJson = JSON.parse(await readFile(join(REPO_ROOT, 'package.json'), 'utf8'));
  const version = packageJson.version;
  const scratch = await mkdtemp(join(tmpdir(), 'ape-release-artifacts-'));
  const generated = join(scratch, 'release');
  await mkdir(generated, { recursive: true });
  try {
    const artifacts = [];
    for (const [directory, host] of PACKAGE_NAMES) {
      const name = `ape-${host}-${version}.tar.gz`;
      artifacts.push(await writeArtifact(
        generated,
        name,
        await archivePackage(join(REPO_ROOT, 'plugins', directory), directory, epoch),
      ));
    }
    const sbomName = `ape-${version}.spdx.json`;
    artifacts.push(await writeArtifact(
      generated,
      sbomName,
      Buffer.from(`${JSON.stringify(await spdx(version, epoch), null, 2)}\n`),
    ));
    const manifest = {
      version: 1,
      release: version,
      source_date_epoch: epoch,
      transport: 'local-stdio',
      artifacts,
    };
    const manifestArtifact = await writeArtifact(
      generated,
      'release-manifest.json',
      Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`),
    );
    const checksummed = [...artifacts, manifestArtifact].sort((left, right) =>
      compareNames(left.name, right.name)
    );
    await writeArtifact(
      generated,
      'SHA256SUMS',
      Buffer.from(checksummed.map((artifact) => `${artifact.sha256}  ${artifact.name}`).join('\n') + '\n'),
    );
    await replaceDirectory(generated, output);
    process.stdout.write(`wrote deterministic ${version} release artifacts to ${output}\n`);
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

main(process.argv.slice(2)).catch((error) => {
  process.stderr.write(`build-release-artifacts: ${error?.message ?? String(error)}\n`);
  process.exitCode = 1;
});
