import path from 'node:path';
import { constants } from 'node:fs';
import { access, lstat, open, realpath } from 'node:fs/promises';
import { ancestorManifests, entryScripts, packageScript } from './admission-baseline.js';
import { resolveAdmissionExecutable, unwrapAdmissionEnv } from './admission-command-argv.js';
import { splitCommand } from './runner.js';
export { resolveAdmissionExecutable } from './admission-command-argv.js';

const MAX_COMMANDS = 2_048;
const MAX_INSPECTIONS = 256;
const MAX_MANIFEST_BYTES = 256 * 1024;
const MAX_TOTAL_BYTES = 4 * 1024 * 1024;
const HEADER_BYTES = 8_192;
const inside = (root, file) => file === root || file.startsWith(`${root}${path.sep}`);

/** Bounded static entry prerequisites only; never execute a command or inspect an import graph. */
export async function inspectAdmissionCommandPrerequisites(root, commands, executableFacts) {
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
      const before = await handle.stat();
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
      const after = await handle.stat();
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
  const inspectExecutable = async (resolved, commandRoot, env, depth) => {
    if (depth > 8) throw failure('shebang-nesting-limit', resolved);
    const header = await read(resolved, false, false, 'executable');
    if (!header.startsWith('#!')) return;
    const newline = header.indexOf('\n');
    if (newline < 0 && Buffer.byteLength(header) >= HEADER_BYTES) throw failure('shebang-too-large', resolved);
    const argv = splitCommand(header.slice(2, newline < 0 ? undefined : newline).trim());
    if (!argv[0]) throw failure('shebang-unrepresentable', resolved);
    const interpreter = await resolveAdmissionExecutable(commandRoot, argv[0], { env });
    if (!interpreter) throw failure('shebang-interpreter-missing', resolved);
    if (path.basename(argv[0]) === 'env') {
      const invocation = envInvocation(argv, env, resolved, 'shebang-env');
      const delegated = await resolveAdmissionExecutable(commandRoot, invocation.argv[0], { env: invocation.env });
      if (!delegated) throw failure('shebang-env-interpreter-missing', resolved);
      await inspectExecutable(delegated, commandRoot, invocation.env, depth + 1);
    } else await inspectExecutable(interpreter, commandRoot, env, depth + 1);
  };
  const inspectCommand = async (command, commandRoot, env, depth = 0, resolvedOuter = undefined, shellScript = false) => {
    if (depth > 8) throw failure('package-script-nesting-limit');
    const key = `${commandRoot}\0${env.PATH ?? ''}\0${env.PATHEXT ?? ''}\0${shellScript}\0${command}`;
    if (active.has(key)) throw failure('package-script-cycle');
    if (visited.has(key)) return;
    visited.add(key);
    active.add(key);
    let resolvedRoot;
    try { resolvedRoot = await realpath(commandRoot); } catch { throw failure('command-root-missing', commandRoot); }
    if (!inside(root, commandRoot) || !inside(root, resolvedRoot) || !(await lstat(resolvedRoot)).isDirectory()) throw failure('command-root-unsafe', commandRoot);
    const argv = splitCommand(command);
    if (!argv[0]) throw failure('command-unrepresentable');
    // npm executes scripts in a shell. Literal assignment prefixes and simple
    // builtins are valid commands, not missing executables. Dynamic shell
    // expansions cannot be certified by static prerequisite inspection.
    if (shellScript) {
      while (/^[A-Za-z_][A-Za-z0-9_]*=/.test(argv[0] ?? '')) {
        const assignment = argv.shift();
        if (/[$`]/.test(assignment)) throw failure('shell-environment-unrepresentable');
        const split = assignment.indexOf('=');
        env = { ...env, [assignment.slice(0, split)]: assignment.slice(split + 1) };
      }
      if (!argv.length || [':', 'true', 'false', 'echo', 'printf', 'test', '[', 'pwd', 'cd', 'exit', 'export', 'unset', 'set', 'shift', 'return', 'readonly', 'umask', 'read', 'type'].includes(argv[0])) { active.delete(key); return; }
      if (['if', 'then', 'for', 'while', 'until', 'case', 'function', '(', '{'].includes(argv[0])) throw failure('shell-command-unrepresentable');
    }
    const resolved = resolvedOuter ?? await resolveAdmissionExecutable(commandRoot, argv[0], { env });
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
    const script = packageScript(argv, commandRoot);
    if (!script) { active.delete(key); return; }
    let manifestFile = null;
    for (const relative of ancestorManifests(root, script.root)) {
      const file = path.join(root, relative);
      const exists = await lstat(file).then(() => true, (error) => { if (error.code === 'ENOENT') return false; throw error; });
      if (exists) { manifestFile = file; break; }
    }
    if (!manifestFile) throw failure('package-manifest-missing', path.join(script.root, 'package.json'), { package_script: script.name });
    const raw = await read(manifestFile, true);
    let manifest;
    try { manifest = JSON.parse(raw); } catch { throw failure('package-manifest-invalid', manifestFile); }
    if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) throw failure('package-manifest-invalid', manifestFile);
    const packageRoot = path.dirname(manifestFile);
    const packageEnv = { ...env, PATH: [...new Set([path.join(packageRoot, 'node_modules', '.bin'), ...(env.PATH ?? '').split(path.delimiter)])].join(path.delimiter) };
    let selected = manifest.scripts?.[script.name];
    // npm's documented start default is node server.js. This is availability
    // evidence only, not a promise that running the script would pass.
    if (selected === undefined && script.name === 'start' && /^npm(?:\.cmd|\.exe)?$/i.test(path.basename(argv[0]))) selected = 'node server.js';
    if (typeof selected !== 'string' || !selected.trim()) throw failure('package-script-missing', manifestFile, { package_script: script.name });
    for (const name of [`pre${script.name}`, script.name, `post${script.name}`]) {
      const value = name === script.name ? selected : manifest.scripts?.[name];
      if (value === undefined) continue;
      if (typeof value !== 'string' || !value.trim()) throw failure('package-script-invalid', manifestFile, { package_script: name });
      // Package script shell grammar is not an import graph or a second
      // scheduler. Inspect the leading simple command; the actual runner
      // retains responsibility for shell semantics and its eventual verdict.
      try {
        await inspectCommand(value, packageRoot, packageEnv, depth + 1, undefined, true);
      } catch (error) {
        error.package_script ??= name;
        error.expected_path ??= path.relative(root, manifestFile).split(path.sep).join('/');
        throw error;
      }
    }
    active.delete(key);
  };
  for (const command of commands) {
    if (blocking.length >= 64) break;
    const fact = executableFacts.find((entry) => entry.id === command.id);
    if (!fact?.resolved) continue; // Existing argv[0] diagnostic owns this case.
    try {
      await inspectCommand(command.command, path.resolve(root, command.root ?? '.'), process.env, 0, fact.resolved);
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
