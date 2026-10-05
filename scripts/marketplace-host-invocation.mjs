import { lstat, readFile, realpath, stat } from 'node:fs/promises';
import { extname, isAbsolute, relative, resolve, sep } from 'node:path';

const JAVASCRIPT_EXTENSIONS = new Set(['.cjs', '.js', '.mjs']);
const WINDOWS_NATIVE_EXTENSIONS = new Set(['.com', '.exe']);

/** @param {{ codexBin?: string, platform?: NodeJS.Platform, env?: NodeJS.ProcessEnv }} [options] */
export async function resolveCodexInvocation({ codexBin, platform = process.platform, env = process.env } = {}) {
  if (codexBin !== undefined) {
    if (JAVASCRIPT_EXTENSIONS.has(extname(codexBin).toLowerCase())) {
      return { command: process.execPath, args: [resolve(codexBin)], shell: false };
    }
    return { command: codexBin, args: [], shell: false };
  }
  // Preserve POSIX executable lookup by spawn, including ordinary executable shims.
  if (platform !== 'win32') return { command: 'codex', args: [], shell: false };

  const hint = 'Install Codex in a supported npm prefix on PATH, or use --codex-bin with a native executable or JavaScript entrypoint.';
  // Match Node's deterministic choice when Windows environment keys differ only
  // in case. Never invoke where/npm or interpret a batch shim as shell syntax.
  const pathKey = Object.keys(env).sort().find(key => key.toLowerCase() === 'path');
  const searchPath = pathKey === undefined ? '' : env[pathKey] ?? '';
  for (const directory of searchPath.split(';').filter(Boolean)) {
    const prefix = resolve(directory.replace(/^"(.*)"$/, '$1'));
    // PATH order wins; native executables precede the npm shim within a prefix.
    for (const name of ['codex.exe', 'codex.com', 'codex.cmd']) {
      const candidate = resolve(prefix, name);
      try {
        const entry = await lstat(candidate).catch(error => {
          if (error.code === 'ENOENT') return null;
          throw error;
        });
        if (entry === null) continue;
        if (!(await stat(candidate)).isFile()) throw new Error('launcher is not a regular file');
        if (name !== 'codex.cmd') {
          return { command: candidate, args: [], shell: false };
        }
        return await resolveMarketplaceHostInvocation({
          identity: 'codex', packageName: '@openai/codex',
          modulesRoot: resolve(prefix, 'node_modules'), args: [], platform,
        });
      } catch (error) {
        // An identified but invalid installation must not fall through to a
        // different executable later on PATH.
        throw new Error(`Cannot resolve Codex launcher at ${candidate}: ${error.message}. ${hint}`);
      }
    }
  }
  throw new Error(`Cannot find a supported Codex executable on PATH. ${hint}`);
}

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
