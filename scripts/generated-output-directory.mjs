import { cp, lstat, mkdir, mkdtemp, readdir, realpath, rename, rm } from 'node:fs/promises';
import path from 'node:path';

function contains(parent, child) {
  const relative = path.relative(parent, child);
  return relative === '' || (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`));
}

async function canonicalLocation(value) {
  try { return await realpath(value); }
  catch (error) {
    if (error.code !== 'ENOENT') throw error;
    const parent = path.dirname(value);
    if (parent === value) throw error;
    return path.join(await canonicalLocation(parent), path.basename(value));
  }
}

export async function assertGeneratedOutputLocation(destination, sourceRoot, allowedOutputs) {
  const target = await canonicalLocation(path.resolve(destination));
  const source = await realpath(sourceRoot);
  const allowed = allowedOutputs.map((output) => path.resolve(source, path.relative(sourceRoot, output)));
  if (contains(target, source) || (contains(source, target) && !allowed.includes(target))) {
    throw new Error('generated output must not replace the source checkout or its source directories');
  }
  const metadata = await lstat(destination).catch((error) => {
    if (error.code === 'ENOENT') return null;
    throw error;
  });
  if (metadata && (!metadata.isDirectory() || metadata.isSymbolicLink())) {
    throw new Error('generated output destination must be a plain directory');
  }
}

// Enumerate without following links or reading special files. Callers use the
// inventory plus their own generated manifest to recognize previous output.
export async function generatedOutputInventory(root) {
  const metadata = await lstat(root);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw new Error('existing generated output must be a plain directory');
  }
  const result = new Map();
  async function visit(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name);
      const relative = path.relative(root, file).split(path.sep).join('/');
      if (entry.isSymbolicLink() || (!entry.isFile() && !entry.isDirectory())) {
        throw new Error('existing generated output contains a symlink or special file');
      }
      result.set(relative, entry.isDirectory() ? 'directory' : 'file');
      if (entry.isDirectory()) await visit(file);
    }
  }
  await visit(root);
  return result;
}

export async function validateGeneratedOutputContents(directory, validateExisting) {
  const inventory = await generatedOutputInventory(directory).catch((error) => {
    if (error.code === 'ENOENT') return null;
    throw error;
  });
  if (inventory?.size) await validateExisting(directory, inventory);
  return inventory !== null;
}

export async function replaceGeneratedDirectory(source, destination, { sourceRoot, allowedOutputs, validateExisting }) {
  const validate = (directory) => validateGeneratedOutputContents(directory, validateExisting);
  await assertGeneratedOutputLocation(destination, sourceRoot, allowedOutputs);
  await validate(destination);
  await mkdir(path.dirname(destination), { recursive: true });
  const staging = await mkdtemp(path.join(path.dirname(destination), `.${path.basename(destination)}.next-`));
  const next = path.join(staging, 'next');
  const previous = path.join(staging, 'previous');
  let retained = false;
  let published = false;
  try {
    // Staging beside the destination also supports --output-root on another
    // filesystem, where renaming a system-temp directory fails with EXDEV.
    await cp(source, next, { recursive: true, preserveTimestamps: true });
    await assertGeneratedOutputLocation(destination, sourceRoot, allowedOutputs);
    if (await validate(destination)) {
      await rename(destination, previous);
      retained = true;
      // Validate the moved directory too; never discard unexpected contents
      // which arrived between inspection and the atomic rename.
      await validate(previous);
    }
    await rename(next, destination);
    published = true;
    if (retained) {
      await validate(previous);
      await rm(previous, { recursive: true });
      retained = false;
    }
  } catch (error) {
    if (retained && !published) {
      try { await rename(previous, destination); retained = false; }
      catch { /* A concurrent destination wins; preserve the prior directory. */ }
    }
    if (retained) error.message += `; previous output retained at ${previous}`;
    throw error;
  } finally {
    if (retained) await rm(next, { recursive: true, force: true });
    else await rm(staging, { recursive: true, force: true });
  }
}
