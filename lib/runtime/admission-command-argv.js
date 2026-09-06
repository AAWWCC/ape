import path from 'node:path';
import { constants } from 'node:fs';
import { access, lstat, readFile, realpath } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { buildSpawnPlan, splitCommand } from './runner.js';

export function admissionEnvValue(env, name, platform = process.platform) {
  if (platform !== 'win32') return env[name];
  const key = Object.keys(env).find((key) => key.toUpperCase() === name.toUpperCase());
  return key === undefined ? undefined : env[key];
}

/** Repeated PATH entries do not change lookup order. Preserve every spelling
 * and its order because npm merges aliases, but never rewrite the child env. */
export function admissionPathIdentity(env, platform = process.platform) {
  const delimiter = platform === 'win32' ? ';' : path.delimiter;
  return Object.entries(env).filter(([key]) => /^path$/i.test(key))
    .map(([key, value]) => [key, [...new Set((value ?? '').split(delimiter))]]);
}

/** Inspect the selected npm installation without loading or running its code. */
async function npmNodeGypBin(npmExecutable) {
  if (!npmExecutable) return null;
  const executableDirectory = path.dirname(npmExecutable);
  const candidates = [
    path.dirname(executableDirectory), // A resolved npm/bin/npm-cli.js symlink.
    path.join(executableDirectory, 'node_modules', 'npm'), // Standard npm.cmd shim.
  ];
  for (const root of candidates) {
    try {
      const manifestPath = path.join(root, 'package.json');
      const manifestStat = await lstat(manifestPath);
      if (!manifestStat.isFile() || manifestStat.size > 128 * 1024) continue;
      const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
      if (manifest.name !== 'npm' || typeof manifest.bin?.npm !== 'string') continue;
      const cli = await realpath(path.resolve(root, manifest.bin.npm));
      const isShim = /^(?:npm)(?:\.cmd|\.bat|\.exe)?$/i.test(path.basename(npmExecutable))
        && root === path.join(executableDirectory, 'node_modules', 'npm');
      if (cli !== npmExecutable && !isShim) continue;
      // npm resolves @npmcli/run-script from its own installation. It may be
      // vendored or hoisted; resolving metadata does not execute that module.
      const runScript = createRequire(manifestPath).resolve('@npmcli/run-script/package.json');
      const bin = await realpath(path.join(path.dirname(runScript), 'lib', 'node-gyp-bin'));
      if ((await lstat(bin)).isDirectory()) return bin;
    } catch { /* An unrecognized installation contributes no invented PATH. */ }
  }
  return null;
}

/** npm adds ancestor bins, then its bundled node-gyp shim, then inherited PATH. */
export async function packageScriptEnvironment(packageRoot, inherited, platform = process.platform, npmExecutable = null) {
  const directories = [];
  let cursor = path.resolve(packageRoot);
  for (let depth = 0; ; depth += 1) {
    if (depth >= 64) throw new Error('package-root-too-deep');
    directories.push(path.join(cursor, 'node_modules', '.bin'));
    const parent = path.dirname(cursor);
    if (parent === cursor) break;
    cursor = parent;
  }
  const nodeGypBin = await npmNodeGypBin(npmExecutable);
  if (nodeGypBin) directories.push(nodeGypBin);
  const delimiter = platform === 'win32' ? ';' : path.delimiter;
  const env = { ...inherited };
  // npm merges every PATH spelling in insertion order on all platforms.
  // Other managers retain the existing platform-specific inherited lookup.
  const pathKeys = Object.keys(inherited).filter((key) => /^path$/i.test(key));
  const inheritedPaths = npmExecutable
    ? pathKeys.filter((key) => inherited[key]).map((key) => inherited[key].split(delimiter))
      .reduce((seen, entries) => seen.concat(entries.filter((entry) => !seen.includes(entry))), [])
    : (admissionEnvValue(inherited, 'PATH', platform) ?? '').split(delimiter);
  const entries = [...directories, ...inheritedPaths];
  const value = (npmExecutable ? entries : [...new Set(entries)]).join(delimiter);
  if (platform === 'win32') {
    for (const key of pathKeys) delete env[key];
    env.PATH = value;
  } else if (npmExecutable) {
    for (const key of pathKeys) env[key] = value;
  } else {
    env.PATH = value;
  }
  return env;
}

/** Read-only resolution retains the selected lexical path for baseline checks. */
export async function resolveAdmissionExecutableFact(commandRoot, executable, { platform = process.platform, env = process.env, shell = false } = {}) {
  const windows = platform === 'win32';
  const usesShell = shell || buildSpawnPlan(executable, [], platform).shell;
  const directories = executable.includes('/') || executable.includes('\\')
    ? [path.resolve(commandRoot, executable)]
    : [...(windows ? ['.'] : []), ...(admissionEnvValue(env, 'PATH', platform) ?? '').split(windows ? ';' : path.delimiter)]
      .map((directory) => path.resolve(commandRoot, (windows ? directory.replace(/^"(.*)"$/, '$1') : directory) || '.', executable));
  // cmd.exe searches PATHEXT, not npm's adjacent extensionless Unix shim.
  // Direct Windows launches use native executable extensions instead of
  // admitting a .cmd that buildSpawnPlan would not route through the shell.
  const extensions = windows && !path.extname(executable)
    ? (usesShell ? (admissionEnvValue(env, 'PATHEXT', platform) ?? '.COM;.EXE;.BAT;.CMD').split(';') : ['.COM', '.EXE'])
      .filter((entry) => /^\.[A-Za-z0-9]+$/.test(entry))
    : [''];
  for (const stem of directories) for (const extension of extensions) {
    try {
      const declared = `${stem}${extension}`;
      const resolved = await realpath(declared);
      if (!(await lstat(resolved)).isFile()) continue;
      await access(resolved, constants.X_OK);
      return { declared, resolved };
    } catch { /* Existence only: never execute a tool to discover it. */ }
  }
  return null;
}

export async function resolveAdmissionExecutable(commandRoot, executable, options = {}) {
  return (await resolveAdmissionExecutableFact(commandRoot, executable, options))?.resolved ?? null;
}

/** Pure, bounded literal env parsing shared by current and base inspection. */
export function unwrapAdmissionEnv(input, inherited = {}, { recursive = true, kind = 'env' } = {}) {
  let argv = input.slice();
  let env = { ...inherited };
  const stages = [{ argv, env }];
  const fail = (suffix) => { throw Object.assign(new Error(`${kind}-${suffix}`), { prerequisite_cause: `${kind}-${suffix}` }); };
  for (let depth = 0; path.basename(argv[0] ?? '').replace(/\.exe$/i, '') === 'env'; depth += 1) {
    if (depth >= 8) fail('nesting-limit');
    let args = argv.slice(1);
    let optionsEnded = false;
    while (args.length) {
      const arg = args[0];
      if (!optionsEnded && arg === '--') { optionsEnded = true; args.shift(); continue; }
      if (!optionsEnded && ['-i', '--ignore-environment', '-'].includes(arg)) fail('environment-unrepresentable');
      if (!optionsEnded && (arg === '-S' || arg === '--split-string' || arg.startsWith('--split-string='))) {
        const inline = arg.startsWith('--split-string=');
        const value = inline ? arg.slice('--split-string='.length) : args[1];
        if (!value || /[$`]/.test(value)) fail('split-string-unrepresentable');
        args = [...splitCommand(value), ...args.slice(inline ? 1 : 2)];
        continue;
      }
      if (!optionsEnded && (arg === '-u' || arg === '--unset' || arg.startsWith('--unset='))) {
        const inline = arg.startsWith('--unset=');
        const name = inline ? arg.slice('--unset='.length) : args[1];
        if (!name || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(name) || name === 'PATH') fail('unset-unrepresentable');
        env = { ...env };
        delete env[name];
        args = args.slice(inline ? 1 : 2);
        continue;
      }
      if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(arg)) {
        if (/[$`]/.test(arg)) fail('assignment-unrepresentable');
        const split = arg.indexOf('=');
        env = { ...env, [arg.slice(0, split)]: arg.slice(split + 1) };
        args.shift();
        continue;
      }
      if (arg.startsWith('-')) fail('option-unrepresentable');
      break;
    }
    if (!args.length) fail('command-unrepresentable');
    argv = args;
    stages.push({ argv, env });
    if (!recursive) break;
  }
  return { argv, env, stages, wrapped: stages.length > 1 };
}
