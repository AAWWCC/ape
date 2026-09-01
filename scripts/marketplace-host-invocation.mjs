import { readFile, realpath, stat } from 'node:fs/promises';
import { extname, isAbsolute, relative, resolve, sep } from 'node:path';

const JAVASCRIPT_EXTENSIONS = new Set(['.cjs', '.js', '.mjs']);
const WINDOWS_NATIVE_EXTENSIONS = new Set(['.com', '.exe']);

function isContained(root, target) {
  const rel = relative(root, target);
  return rel !== '' && !isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${sep}`);
}

export async function resolveMarketplaceHostInvocation({
  identity,
  packageName,
  modulesRoot,
  args,
  platform = process.platform,
}) {
  const resolvedModulesRoot = resolve(modulesRoot);
  const packageRoot = resolve(resolvedModulesRoot, ...packageName.split('/'));
  if (!isContained(resolvedModulesRoot, packageRoot)) {
    throw new Error(`invalid host package name: ${packageName}`);
  }

  const manifest = JSON.parse(await readFile(resolve(packageRoot, 'package.json'), 'utf8'));
  if (manifest.name !== packageName) {
    throw new Error(`host package identity mismatch for ${identity}`);
  }
  const declaredBin = typeof manifest.bin === 'string' ? manifest.bin : manifest.bin?.[identity];
  if (typeof declaredBin !== 'string' || !declaredBin.trim()) {
    throw new Error(`host package has no ${identity} executable`);
  }

  const [realPackageRoot, realExecutable] = await Promise.all([
    realpath(packageRoot),
    realpath(resolve(packageRoot, declaredBin)),
  ]);
  if (!isContained(realPackageRoot, realExecutable)) {
    throw new Error(`host package executable escapes its package root: ${identity}`);
  }
  if (!(await stat(realExecutable)).isFile()) {
    throw new Error(`host package executable is not a regular file: ${identity}`);
  }

  const extension = extname(realExecutable).toLowerCase();
  if (JAVASCRIPT_EXTENSIONS.has(extension)) {
    return { command: process.execPath, args: [realExecutable, ...args], shell: false };
  }
  if (platform === 'win32' && !WINDOWS_NATIVE_EXTENSIONS.has(extension)) {
    throw new Error(`host package executable is not a native Windows binary: ${identity}`);
  }
  return { command: realExecutable, args: [...args], shell: false };
}
