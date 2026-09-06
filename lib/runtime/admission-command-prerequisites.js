import { lstatFile as lstat, statFileHandle } from './file-stats.js';
import path from 'node:path';
import { constants } from 'node:fs';
import { access, open, opendir, realpath } from 'node:fs/promises';
import { ancestorManifests, entryScripts, packageScript, packageShellInvocation, selectedPackageScript,
  packageInvocationEnvironment, packageLifecycleNames, selectPackageWorkspaces, selectPackageContext, npmAdmissionEnvironment } from './admission-baseline.js';
import { admissionEnvValue, admissionPathIdentity, resolveAdmissionExecutable, unwrapAdmissionEnv } from './admission-command-argv.js';
import { splitCommand } from './runner.js';
export { resolveAdmissionExecutable } from './admission-command-argv.js';

const MAX_COMMANDS = 2_048;
const MAX_INSPECTIONS = 256;
const MAX_MANIFEST_BYTES = 256 * 1024;
const MAX_TOTAL_BYTES = 4 * 1024 * 1024;
const HEADER_BYTES = 8_192;
const inside = (root, file) => file === root || file.startsWith(`${root}${path.sep}`);

/** Bounded static entry prerequisites only; never execute a command or inspect an import graph. */
export async function inspectAdmissionCommandPrerequisites(root, commands, executableFacts, { platform = process.platform, env: inheritedEnv = process.env } = {}) {
  const blocking = [];
  if (commands.length > MAX_COMMANDS) return [{ code: 'command-prerequisites-over-limit', message: 'Decompose the command prerequisite set before admission.' }];
  root = await realpath(root);
  let inspections = 0;
  let remaining = MAX_TOTAL_BYTES;
  const cache = new Map();
  const visited = new Set();
  const active = new Set();
  const failure = (cause, file = undefined, details = {}) => Object.assign(new Error(cause), {
    prerequisite_cause: cause,
    ...(file && inside(root, file) ? { expected_path: path.relative(root, file).split(path.sep).join('/').slice(0, 4096) } : {}),
    ...details,
  });
  const envInvocation = (input, inherited, file, kind = 'env') => {
    try { return unwrapAdmissionEnv(input, inherited, { recursive: false, kind }); }
    catch (error) { throw failure(error.prerequisite_cause ?? `${kind}-command-unrepresentable`, file); }
  };
  const read = async (file, manifest = false, projectScoped = true, kind = manifest ? 'package-manifest' : 'entry-script') => {
    try {
    if (++inspections > MAX_INSPECTIONS) throw failure('inspection-limit');
    const resolved = await realpath(file);
    if (projectScoped && inside(root, file) && !inside(root, resolved)) throw failure(`${kind}-unsafe-link`, file);
    const key = `${manifest}:${resolved}`;
    if (cache.has(key)) return cache.get(key);
    const metadata = await lstat(resolved);
    if (!metadata.isFile()) throw failure(`${kind}-not-regular`, file);
    await access(resolved, constants.R_OK);
    const handle = await open(resolved, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const before = await statFileHandle(handle);
      if (!before.isFile() || before.dev !== metadata.dev || before.ino !== metadata.ino) throw failure(`${kind}-changed`, file);
      const limit = manifest ? MAX_MANIFEST_BYTES : HEADER_BYTES;
      if (manifest && before.size > limit) throw failure('package-manifest-too-large', file);
      const amount = Math.min(before.size, limit);
      if (amount > remaining) throw failure('aggregate-byte-limit');
      const buffer = Buffer.alloc(amount);
      let offset = 0;
      while (offset < amount) {
        const { bytesRead } = await handle.read(buffer, offset, amount - offset, offset);
        if (!bytesRead) throw failure(`${kind}-changed`, file);
        offset += bytesRead;
      }
      remaining -= amount;
      const after = await statFileHandle(handle);
      const current = await lstat(resolved);
      if (await realpath(file) !== resolved || current.ino !== before.ino || current.dev !== before.dev ||
          ['size', 'mtimeMs', 'ctimeMs'].some((field) => current[field] !== before[field] || after[field] !== before[field])) throw failure(`${kind}-changed`, file);
      const value = buffer.toString('utf8');
      cache.set(key, value);
      return value;
    } finally { await handle.close(); }
    } catch (error) {
      if (error.prerequisite_cause) throw error;
      throw failure(`${kind}-${error.code === 'ENOENT' ? 'missing' : 'unreadable'}`, file);
    }
  };
  const readManifest = async (file) => {
    const exists = await lstat(file).then(() => true, (error) => { if (error.code === 'ENOENT') return false; throw error; });
    if (!exists) return null;
    const raw = await read(file, true);
    let manifest;
    try { manifest = JSON.parse(raw); } catch { throw failure('package-manifest-invalid', file); }
    if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) throw failure('package-manifest-invalid', file);
    return manifest;
  };
  const workspaceDirectories = async (directory) => {
    if (++inspections > MAX_INSPECTIONS) throw failure('inspection-limit');
    if (!inside(root, directory) || !inside(root, await realpath(directory))) throw failure('package-workspace-unsafe-link', directory);
    const children = [];
    let count = 0;
    for await (const entry of await opendir(directory)) {
      if (++count > 2048) throw failure('package-workspace-inspection-limit');
      if (entry.isDirectory()) children.push(entry.name);
      else if (entry.isSymbolicLink()) {
        try {
          if ((await lstat(await realpath(path.join(directory, entry.name)))).isDirectory()) children.push(entry.name);
        } catch (error) { if (error.code !== 'ENOENT') throw error; }
      }
    }
    return children;
  };
  const inspectExecutable = async (resolved, commandRoot, env, depth) => {
    if (depth > 8) throw failure('shebang-nesting-limit', resolved);
    const header = await read(resolved, false, false, 'executable');
    if (!header.startsWith('#!')) return;
    const newline = header.indexOf('\n');
    if (newline < 0 && Buffer.byteLength(header) >= HEADER_BYTES) throw failure('shebang-too-large', resolved);
    const argv = splitCommand(header.slice(2, newline < 0 ? undefined : newline).trim());
    if (!argv[0]) throw failure('shebang-unrepresentable', resolved);
    const interpreter = await resolveAdmissionExecutable(commandRoot, argv[0], { env, platform });
    if (!interpreter) throw failure('shebang-interpreter-missing', resolved);
    if (path.basename(argv[0]) === 'env') {
      const invocation = envInvocation(argv, env, resolved, 'shebang-env');
      const delegated = await resolveAdmissionExecutable(commandRoot, invocation.argv[0], { env: invocation.env, platform });
      if (!delegated) throw failure('shebang-env-interpreter-missing', resolved);
      await inspectExecutable(delegated, commandRoot, invocation.env, depth + 1);
    } else await inspectExecutable(interpreter, commandRoot, env, depth + 1);
  };
  const inspectCommand = async (command, commandRoot, env, depth = 0, resolvedOuter = undefined, shellScript = false, scriptShell = undefined) => {
    if (depth > 8) throw failure('package-script-nesting-limit');
    const key = `${commandRoot}\0${JSON.stringify(admissionPathIdentity(env, platform))}\0${admissionEnvValue(env, 'PATHEXT', platform) ?? ''}\0${JSON.stringify(npmAdmissionEnvironment(env))}\0${shellScript}\0${scriptShell ?? ''}\0${command}`;
    if (active.has(key)) throw failure('package-script-cycle');
    if (visited.has(key)) return;
    visited.add(key);
    active.add(key);
    let resolvedRoot;
    try { resolvedRoot = await realpath(commandRoot); } catch { throw failure('command-root-missing', commandRoot); }
    if (!inside(root, commandRoot) || !inside(root, resolvedRoot) || !(await lstat(resolvedRoot)).isDirectory()) throw failure('command-root-unsafe', commandRoot);
    if (shellScript && scriptShell) {
      const resolvedShell = await resolveAdmissionExecutable(commandRoot, scriptShell, { env, platform });
      if (!resolvedShell) throw failure('package-shell-missing');
      const declaredShell = /[\/\\]/.test(scriptShell) ? path.resolve(commandRoot, scriptShell) : null;
      if (declaredShell && inside(root, declaredShell) && !inside(root, resolvedShell)) throw failure('package-shell-unsafe-link', declaredShell);
      await inspectExecutable(resolvedShell, commandRoot, env, 0);
    }
    let argv = splitCommand(command);
    if (!argv[0]) throw failure('command-unrepresentable');
    // npm executes scripts in a shell. Literal assignment prefixes and simple
    // builtins are valid commands, not missing executables. Dynamic shell
    // expansions cannot be certified by static prerequisite inspection.
    if (shellScript) {
      const shell = packageShellInvocation(argv, env, { platform, scriptShell });
      argv = shell.argv;
      env = shell.env;
      if (shell.builtin) { active.delete(key); return; }
      if (['if', 'then', 'for', 'while', 'until', 'case', 'function', '(', '{'].includes(argv[0])) throw failure('shell-command-unrepresentable');
    }
    const resolved = resolvedOuter ?? await resolveAdmissionExecutable(commandRoot, argv[0], { env, platform, shell: shellScript });
    if (!resolved) throw failure('command-executable-missing');
    const declared = /[\/\\]/.test(argv[0]) ? path.resolve(commandRoot, argv[0]) : null;
    if (declared && inside(root, declared) && !inside(root, resolved)) throw failure('executable-unsafe-link', declared);
    await inspectExecutable(resolved, commandRoot, env, 0);
    if (path.basename(argv[0]).replace(/\.exe$/i, '') === 'env') {
      const invocation = envInvocation(argv, env, declared ?? undefined);
      await inspectCommand(invocation.argv.map((arg) => JSON.stringify(arg)).join(' '), commandRoot, invocation.env, depth + 1);
      active.delete(key);
      return;
    }
    for (const entry of entryScripts(argv)) {
      if (/[{}*?]/.test(entry)) continue;
      await read(path.resolve(commandRoot, entry));
    }
    let script = packageScript(argv, commandRoot, env, { platform });
    if (!script) { active.delete(key); return; }
    const files = ancestorManifests(root, script.root).map((file) => path.join(root, file));
    const context = await selectPackageContext(files, script, { directories: workspaceDirectories, readManifest });
    if (!context) throw failure('package-manifest-missing', path.join(script.root, 'package.json'), { package_script: script.name });
    const { file: manifestFile, manifest } = context;
    script = context.script;
    let packages;
    try { packages = await selectPackageWorkspaces(manifestFile, manifest, script, { directories: workspaceDirectories, readManifest }); }
    catch (error) { throw error.prerequisite_cause ? error : failure(/^package-workspace[a-z-]*$/.test(error.message) ? error.message : 'package-workspaces-unrepresentable', manifestFile, { package_script: script.name }); }
    for (const selectedPackage of packages) {
    const packageRoot = path.dirname(selectedPackage.file);
    const packageEnv = await packageInvocationEnvironment(packageRoot, script, env, platform, resolved);
    // npm's documented start default is node server.js. This is availability
    // evidence only, not a promise that running the script would pass.
    const selected = selectedPackageScript(selectedPackage.manifest, script);
    if (selected === undefined && script.ifPresent) continue;
    if (typeof selected !== 'string' || (!selected.trim() && script.manager !== 'npm')) throw failure('package-script-missing', selectedPackage.file, { package_script: script.name });
    for (const name of packageLifecycleNames(script, selectedPackage.manifest)) {
      const value = name === script.name ? selected : selectedPackage.manifest.scripts?.[name];
      if (value === undefined) continue;
      if (script.manager === 'npm' && value === '') continue;
      if (typeof value !== 'string' || (!value.trim() && script.manager !== 'npm')) throw failure('package-script-invalid', selectedPackage.file, { package_script: name });
      // Package script shell grammar is not an import graph or a second
      // scheduler. Inspect the leading simple command; the actual runner
      // retains responsibility for shell semantics and its eventual verdict.
      try {
        await inspectCommand(value, packageRoot, packageEnv, depth + 1, undefined, true, script.scriptShell);
      } catch (error) {
        error.package_script ??= name;
        error.expected_path ??= path.relative(root, selectedPackage.file).split(path.sep).join('/');
        throw error;
      }
    }
    }
    active.delete(key);
  };
  for (const command of commands) {
    if (blocking.length >= 64) break;
    const fact = executableFacts.find((entry) => entry.id === command.id);
    if (!fact?.resolved) continue; // Existing argv[0] diagnostic owns this case.
    try {
      await inspectCommand(command.command, path.resolve(root, command.root ?? '.'), inheritedEnv, 0, fact.resolved);
    } catch (error) {
      blocking.push({ code: 'command-prerequisite-unavailable', profile: command.id,
        cause: error.prerequisite_cause ?? 'command-unrepresentable',
        ...(error.expected_path ? { expected_path: error.expected_path } : {}),
        ...(error.package_script ? { package_script: error.package_script } : {}),
        message: 'Resolve the identified prerequisite before dispatch. This is read-only availability evidence; no command ran and no baseline test failure was certified as passing.' });
    }
  }
  return blocking;
}
