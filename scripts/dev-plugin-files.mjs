import { createHash } from 'node:crypto';
import { access, cp, lstat, mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join, relative, sep } from 'node:path';

export class DevPluginError extends Error {}
export const STRICT_SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-(?:[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

export async function exists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

export async function assertRegularTree(root) {
  const entries = await readdir(root, { withFileTypes: true });
  for (const entry of entries) {
    const target = join(root, entry.name);
    const metadata = await lstat(target);
    if (metadata.isSymbolicLink()) {
      throw new DevPluginError(`staged plugin refuses symbolic link: ${target}`);
    }
    if (metadata.isDirectory()) await assertRegularTree(target);
    else if (!metadata.isFile()) throw new DevPluginError(`staged plugin refuses special file: ${target}`);
  }
}

export async function atomicWrite(file, contents) {
  await mkdir(dirname(file), { recursive: true });
  const transaction = await mkdtemp(join(dirname(file), '.ape-write-'));
  try {
    const prepared = join(transaction, 'prepared');
    await writeFile(prepared, contents);
    await rename(prepared, file);
  } finally {
    await rm(transaction, { recursive: true, force: true });
  }
}

export async function treeDigest(root) {
  const hash = createHash('sha256');
  async function visit(directory) {
    const entries = (await readdir(directory, { withFileTypes: true }))
      .sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0);
    for (const entry of entries) {
      const target = join(directory, entry.name);
      const normalized = relative(root, target).split(sep).join('/');
      const metadata = await lstat(target);
      if (metadata.isSymbolicLink()) throw new DevPluginError(`installed plugin contains symbolic link: ${target}`);
      if (metadata.isDirectory()) {
        hash.update(`d\0${normalized}\0`);
        await visit(target);
      } else if (metadata.isFile()) {
        hash.update(`f\0${normalized}\0`);
        hash.update(await readFile(target));
      } else {
        throw new DevPluginError(`installed plugin contains special file: ${target}`);
      }
    }
  }
  await visit(root);
  return hash.digest('hex');
}

export async function promoteInstalledTree(installedRoot, cacheRoot, nextVersion) {
  await mkdir(cacheRoot, { recursive: true });
  const destination = join(cacheRoot, nextVersion);
  if (await exists(destination)) {
    const [installedDigest, destinationDigest] = await Promise.all([
      treeDigest(installedRoot),
      treeDigest(destination),
    ]);
    if (installedDigest !== destinationDigest) {
      throw new DevPluginError(`cache version ${nextVersion} already exists with different content; use a new cachebuster`);
    }
    return { destination, reused: true };
  }
  const transactionRoot = await mkdtemp(join(cacheRoot, '.ape-install-'));
  const prepared = join(transactionRoot, 'plugin');
  try {
    await cp(installedRoot, prepared, { recursive: true, preserveTimestamps: true });
    if (await treeDigest(prepared) !== await treeDigest(installedRoot)) {
      throw new Error('prepared cache tree failed content verification');
    }
    try {
      await rename(prepared, destination);
      return { destination, reused: false };
    } catch (error) {
      if (!['EEXIST', 'ENOTEMPTY'].includes(error?.code) || !(await exists(destination))) throw error;
      const [preparedDigest, destinationDigest] = await Promise.all([
        treeDigest(prepared),
        treeDigest(destination),
      ]);
      if (preparedDigest !== destinationDigest) {
        throw new DevPluginError(`cache version ${nextVersion} was concurrently installed with different content; use a new cachebuster`);
      }
      return { destination, reused: true };
    }
  } finally {
    await rm(transactionRoot, { recursive: true, force: true });
  }
}
