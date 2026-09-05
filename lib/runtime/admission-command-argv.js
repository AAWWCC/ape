import path from 'node:path';
import { constants } from 'node:fs';
import { access, lstat, realpath } from 'node:fs/promises';
import { splitCommand } from './runner.js';

/** Read-only resolution retains the selected lexical path for baseline checks. */
export async function resolveAdmissionExecutableFact(commandRoot, executable, { platform = process.platform, env = process.env } = {}) {
  const directories = executable.includes('/') || executable.includes('\\')
    ? [path.resolve(commandRoot, executable)]
    : (env.PATH ?? '').split(platform === 'win32' ? ';' : path.delimiter)
      .map((directory) => path.resolve(commandRoot, directory || '.', executable));
  const extensions = platform === 'win32' && !path.extname(executable)
    ? ['', ...(env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD').split(';').filter((entry) => /^\.[A-Za-z0-9]+$/.test(entry))]
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
