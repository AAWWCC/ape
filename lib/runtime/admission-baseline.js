import path from 'node:path';
import { canonicalJson } from './canonical.js';
import { runGit } from './git.js';
import { splitCommand } from './runner.js';
import { admissionEnvValue, admissionPathIdentity, packageScriptEnvironment, resolveAdmissionExecutableFact, unwrapAdmissionEnv } from './admission-command-argv.js';

const MAX_DEPENDENCIES = 2_048;
const MAX_MANIFEST_BYTES = 256 * 1024;
const MAX_TOTAL_MANIFEST_BYTES = 4 * 1024 * 1024;
const SHA = /^[a-f0-9]{40,64}$/;
const gitRead = (root, args) => runGit(root, args, { raw: true, env: { GIT_OPTIONAL_LOCKS: '0' } });
const regularBlob = (entry) => entry?.type === 'blob' && /^100[67][0-7]{2}$/.test(entry.mode);

function contained(root, absolute) {
  const relative = path.relative(root, absolute).split(path.sep).join('/');
  return relative && relative !== '..' && !relative.startsWith('../') && !path.isAbsolute(relative) &&
    !/[\0\r\n]/.test(relative) ? relative : null;
}

// These are entrypoint dependencies, not an inferred import graph. Test paths
// may be deliberately absent until their authoring stage and are not inputs
// to availability of `node --test`, pytest, or another test-collection tool.
export function entryScripts(argv) {
  argv = unwrapAdmissionEnv(argv).argv;
  const executable = path.basename(argv[0] ?? '').replace(/\.(exe|cmd|bat)$/i, '');
  if (!/^(?:node|nodejs|python[\d.]*|ruby|perl|bash|sh|zsh)$/.test(executable)) return [];
  const node = ['node', 'nodejs'].includes(executable);
  const python = /^python[\d.]*$/.test(executable);
  const shell = ['bash', 'sh', 'zsh'].includes(executable);
  const ruby = executable === 'ruby';
  const perl = executable === 'perl';
  const args = argv.slice(1);
  const result = [];
  let inline = false;
  let collectsTests = false;
  for (let i = 0; i < args.length; i += 1) {
    // Node's own help/version options exit before loading a script or preload.
    // Once a script or -- has been reached, the same bytes are script arguments.
    if (node && ['--help', '-h', '--version', '-v'].includes(args[i])) return [];
    if (args[i] === '--') {
      const entry = args[i + 1];
      if (!inline && !collectsTests && entry && entry !== '-' && !/[{}*?]/.test(entry)) result.push(entry);
      break;
    }
    if (node && (args[i] === '--test' || args[i].startsWith('--test='))) collectsTests = true;
    const preload = /^--(?:require|import|loader|experimental-loader)=(.+)$/.exec(args[i]);
    if (preload) {
      if (preload[1].startsWith('.') || path.isAbsolute(preload[1])) result.push(preload[1]);
      continue;
    }
    if (['-r', '--require', '--import', '--loader', '--experimental-loader'].includes(args[i])) {
      if (args[i + 1]?.startsWith('.') || (args[i + 1] && path.isAbsolute(args[i + 1]))) result.push(args[i + 1]);
      i += 1;
      continue;
    }
    // Each interpreter assigns different meanings to the same letters: shell
    // -e and Ruby/Perl -p are switches, while Node -c checks a real script.
    const inlineOption = (node && ['-e', '--eval', '-p', '--print'].includes(args[i])) ||
      (python && ['-c', '-m'].includes(args[i])) ||
      ((ruby || perl) && args[i] === '-e') || (perl && args[i] === '-E') ||
      (shell && /^-[a-zA-Z]*c[a-zA-Z]*$/.test(args[i]));
    if (inlineOption) { inline = true; i += 1; continue; }
    if (node && /^--(?:eval|print)=/.test(args[i])) { inline = true; continue; }
    const valueOption = (node && ['--conditions', '-C', '--inspect-port', '--title', '--icu-data-dir',
      '--input-type', '--stack-trace-limit', '--max-old-space-size', '--max-semi-space-size',
      '--unhandled-rejections', '--dns-result-order'].includes(args[i])) ||
      (python && ['-W', '-X', '--check-hash-based-pycs'].includes(args[i])) ||
      (ruby && ['-I', '-C', '-F', '-E', '--encoding', '--external-encoding', '--internal-encoding'].includes(args[i])) ||
      (perl && args[i] === '-I') ||
      (shell && ['-o', '+o', '-O', '+O', '--rcfile', '--init-file'].includes(args[i]));
    if (valueOption) { i += 1; continue; }
    if (args[i].startsWith('-')) continue;
    if (collectsTests) break; // Remaining test operands are not Node options.
    if (inline) break; // Inline code/module operands are not entry filenames.
    if (!/[{}*?]/.test(args[i])) {
      result.push(args[i]);
      break;
    }
  }
  return result;
}

// npm normalizes environment config names case-insensitively and resolves
// duplicate spellings in environment iteration order; CLI values win later.
// Keep only the supported selectors, both for parsing and traversal identity.
const SUPPORTED_NPM_CONFIG = new Set(['ignore-scripts', 'if-present', 'workspaces', 'workspace', 'include-workspace-root', 'script-shell']);
const npmConfigKey = (rawKey) => /^npm_config_/i.test(rawKey)
  ? rawKey.slice('npm_config_'.length).replace(/(?!^)_/g, '-').toLowerCase() : null;
export function npmAdmissionEnvironment(env) {
  // Retain aliases and empty entries in traversal identity: npm's child env
  // export updates a lowercase key in place, preserving its original order.
  return Object.fromEntries(Object.entries(env).filter(([key]) => SUPPORTED_NPM_CONFIG.has(npmConfigKey(key))));
}
export function npmAdmissionConfig(env) {
  const config = {};
  for (const [rawKey, value] of Object.entries(npmAdmissionEnvironment(env))) {
    if (value === '' || value === undefined) continue;
    config[npmConfigKey(rawKey)] = typeof value === 'string' ? value.trim() : value;
  }
  return config;
}

export function packageScript(argv, commandRoot, env = process.env, { platform = process.platform } = {}) {
  argv = unwrapAdmissionEnv(argv).argv;
  const basename = path.basename(argv[0] ?? '').replace(/\.(exe|cmd|bat)$/i, '');
  const executable = platform === 'win32' ? basename.toLowerCase() : basename;
  if (!['npm', 'pnpm', 'yarn', 'bun'].includes(executable)) return null;
  // npm parses options throughout the invocation, until --. Positional action
  // and script names may themselves follow that separator (npm run -- test).
  const separator = argv.indexOf('--');
  const forwarded = separator >= 0 ? argv.slice(separator + 1) : [];
  if (separator >= 0) argv = argv.slice(0, separator);
  const args = [];
  const unknownOptions = [];
  let root = commandRoot;
  let prefixSpecified = false;
  let workspaceDiscoveryDisabled = false;
  let informational = false;
  const boolean = (value) => value === true || value === 'true' || value === '';
  const npmConfig = npmAdmissionConfig(env);
  let ignoreScripts = boolean(npmConfig['ignore-scripts']);
  let ifPresent = boolean(npmConfig['if-present']);
  let allWorkspaces = boolean(npmConfig.workspaces);
  let workspaceDisabled = npmConfig.workspaces === false || npmConfig.workspaces === 'false';
  let includeWorkspaceRoot = boolean(npmConfig['include-workspace-root']);
  let workspaces = [];
  const appendWorkspace = (selector) => {
    if (typeof selector !== 'string' || !selector || selector.length > 4096 || /[\0\r\n]/.test(selector) || workspaces.length >= 256) throw new Error('workspace-selection-unrepresentable');
    workspaces.push(selector);
  };
  if (executable === 'npm' && npmConfig.workspace !== undefined) {
    if (typeof npmConfig.workspace !== 'string') throw new Error('workspace-selection-unrepresentable');
    for (const selector of npmConfig.workspace.split('\n\n')) appendWorkspace(selector.trim());
  }
  let cliWorkspaces = false;
  const cliNpmConfig = new Set();
  let scriptShell = npmConfig['script-shell'];
  for (let i = 1; i < argv.length; i += 1) {
    if ((executable === 'npm' ? ['--prefix', '-C'] : ['--prefix', '--dir', '--cwd', '-C']).includes(argv[i])) {
      if (!argv[i + 1] || argv[i + 1].startsWith('-')) throw new Error('package-option-unrepresentable');
      prefixSpecified = true;
      root = path.resolve(commandRoot, argv[++i]);
    } else if ((executable === 'npm' ? /^--prefix=/ : /^--(?:prefix|dir|cwd)=/).test(argv[i])) {
      prefixSpecified = true;
      root = path.resolve(commandRoot, argv[i].slice(argv[i].indexOf('=') + 1));
    } else if (executable === 'npm' && /^(?:--workspace|-w)(?:=|$)/.test(argv[i])) {
      const selector = argv[i].includes('=') ? argv[i].slice(argv[i].indexOf('=') + 1) : argv[++i];
      if (!cliWorkspaces) { workspaces = []; cliWorkspaces = true; }
      appendWorkspace(selector);
    } else if (executable === 'npm' && /^(?:--(?:ignore-scripts|if-present|workspaces|include-workspace-root)|-ws)(?:=|$)/.test(argv[i])) {
      const separator = argv[i].indexOf('=');
      const option = separator < 0 ? argv[i] : argv[i].slice(0, separator);
      const inline = separator < 0 ? undefined : argv[i].slice(separator + 1);
      const value = inline ?? (['true', 'false'].includes(argv[i + 1]) ? argv[++i] : 'true');
      if (!['true', 'false'].includes(value)) throw new Error('package-option-unrepresentable');
      cliNpmConfig.add(option.slice(2));
      if (option === '--ignore-scripts') ignoreScripts = boolean(value);
      else if (option === '--if-present') ifPresent = boolean(value);
      else if (option === '--include-workspace-root') includeWorkspaceRoot = boolean(value);
      else { allWorkspaces = boolean(value); workspaceDisabled = !allWorkspaces; workspaceDiscoveryDisabled = !allWorkspaces; }
    } else if (executable === 'npm' && ['--no-ignore-scripts', '--no-if-present', '--no-workspaces', '--no-include-workspace-root'].includes(argv[i])) {
      cliNpmConfig.add(argv[i].slice('--no-'.length));
      if (argv[i] === '--no-ignore-scripts') ignoreScripts = false;
      else if (argv[i] === '--no-if-present') ifPresent = false;
      else if (argv[i] === '--no-workspaces') { allWorkspaces = false; workspaceDisabled = true; workspaceDiscoveryDisabled = true; }
      else includeWorkspaceRoot = false;
    } else if (executable === 'npm' && /^(?:--script-shell)(?:=|$)/.test(argv[i])) {
      cliNpmConfig.add('script-shell');
      scriptShell = argv[i].includes('=') ? argv[i].slice(argv[i].indexOf('=') + 1) : argv[++i];
      if (!scriptShell) throw new Error('package-shell-unrepresentable');
    } else if (executable === 'npm' && ['--help', '-h', '--usage', '--version', '-v'].includes(argv[i])) informational = true;
    else if (executable === 'npm' && ['--silent', '-s', '--quiet', '-q', '--verbose', '-d', '-dd', '-ddd'].includes(argv[i])) {
      // npm expands these logging shorthands before selecting the command.
    } else if (executable === 'npm' && /^--(?:loglevel|logs-max|logs-dir)(?:=|$)/.test(argv[i])) {
      const value = argv[i].includes('=') ? argv[i].slice(argv[i].indexOf('=') + 1) : argv[++i];
      if (!value || value.startsWith('-')) throw new Error('package-option-unrepresentable');
    } else if (executable === 'npm' && /^--(?:no-)?(?:color|foreground-scripts|json|parseable|timing|progress|unicode|audit|fund|update-notifier)(?:=|$)/.test(argv[i])) {
      const value = argv[i].includes('=') ? argv[i].slice(argv[i].indexOf('=') + 1) : (['true', 'false'].includes(argv[i + 1]) ? argv[++i] : 'true');
      if (!['true', 'false'].includes(value)) throw new Error('package-option-unrepresentable');
    } else if (executable === 'npm' && argv[i].startsWith('-')) unknownOptions.push(argv[i]);
    else args.push(argv[i]);
  }
  args.push(...forwarded);
  if (executable === 'npm' && informational) return null;
  const npmAliases = { t: 'test', tst: 'test', rum: 'run', urn: 'run', 'run-script': 'run' };
  const scriptActions = ['run', 'run-script', 'test', 'start', 'stop', 'restart', ...Object.keys(npmAliases)];
  if (unknownOptions.length && args.some((arg) => scriptActions.includes(arg))) throw new Error('package-option-unrepresentable');
  if (executable === 'npm' && workspaceDisabled && workspaces.length) throw new Error('package-workspace-disabled');
  const action = args.findIndex((arg) => !arg.startsWith('-'));
  const verb = executable === 'npm' ? args[action]?.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`) : args[action];
  const first = executable === 'npm' && Object.hasOwn(npmAliases, verb) ? npmAliases[verb] : verb;
  // npm accepts unambiguous prefixes using its full command/alias catalog.
  // Refuse unsupported script prefixes instead of silently omitting their
  // prerequisites. Exact non-script commands/aliases that overlap remain valid.
  if (executable === 'npm' && verb && !['r', 's', 'star'].includes(verb) && !scriptActions.includes(verb)
      && scriptActions.some((name) => name.startsWith(verb))) throw new Error('package-command-unrepresentable');
  if (unknownOptions.length && scriptActions.includes(first)) throw new Error('package-option-unrepresentable');
  const name = ['run', 'run-script'].includes(first) ? args[action + 1] :
    ['test', 'start', 'stop', 'restart'].includes(first) && executable !== 'bun' ? first : null;
  const npmEnvOverrides = {};
  for (const [key, value, defaultValue] of [
    ['ignore-scripts', ignoreScripts, false], ['if-present', ifPresent, false],
    ['include-workspace-root', includeWorkspaceRoot, false], ['script-shell', scriptShell ?? null, null],
  ]) {
    const inherited = key === 'script-shell' ? npmConfig[key] ?? null : boolean(npmConfig[key]);
    if (value === defaultValue ? inherited !== value : cliNpmConfig.has(key) || !Object.hasOwn(npmConfig, key)) {
      // npm exports false/default resets as empty strings. A child ignores
      // that empty key while loading config; inherited case aliases survive.
      npmEnvOverrides[`npm_config_${key.replaceAll('-', '_')}`] = value === false || value === null ? '' : String(value);
    }
  }
  if (name && (name.length > 128 || /[\0\r\n]/.test(name))) throw new Error('package-script-unrepresentable');
  return name
    ? { root, name, manager: executable,
      ...(executable === 'npm' ? { ignoreScripts, ifPresent, allWorkspaces, workspaces, includeWorkspaceRoot, scriptShell, npmEnvOverrides,
        prefixSpecified, workspaceDiscoveryDisabled, workspaceDisabled, workspaceSelectionExplicit: cliWorkspaces || npmConfig.workspace !== undefined } : {}),
      ...(executable === 'npm' && name === 'start' ? { default_command: 'node server.js' } : {}) }
    : null;
}

/** The same literal shell prefixes accepted by current prerequisite inspection.
 * @param {string[]} input
 * @param {NodeJS.ProcessEnv} inherited
 * @param {{ platform?: NodeJS.Platform, scriptShell?: string }} options
 */
export function packageShellInvocation(input, inherited, { platform = process.platform, scriptShell } = {}) {
  const argv = input.slice();
  let env = inherited;
  const shellName = scriptShell ? path.basename(scriptShell.replaceAll('\\', '/')).replace(/\.exe$/i, '').toLowerCase() : null;
  const cmd = shellName === 'cmd' || (!shellName && platform === 'win32');
  const posix = !cmd && (!shellName || ['sh', 'bash', 'zsh', 'dash', 'ksh'].includes(shellName));
  while (posix && /^[A-Za-z_][A-Za-z0-9_]*=/.test(argv[0] ?? '')) {
    const assignment = argv.shift();
    if (/[$`]/.test(assignment)) throw Object.assign(new Error('shell-environment-unrepresentable'), { prerequisite_cause: 'shell-environment-unrepresentable' });
    const split = assignment.indexOf('=');
    env = { ...env, [assignment.slice(0, split)]: assignment.slice(split + 1) };
  }
  const builtins = cmd
    ? ['assoc', 'break', 'call', 'cd', 'chdir', 'cls', 'color', 'copy', 'date', 'del', 'dir', 'echo', 'endlocal', 'erase', 'exit', 'for', 'ftype', 'goto', 'if', 'md', 'mkdir', 'mklink', 'move', 'path', 'pause', 'popd', 'prompt', 'pushd', 'rd', 'rem', 'ren', 'rename', 'rmdir', 'set', 'setlocal', 'shift', 'start', 'time', 'title', 'type', 'ver', 'verify', 'vol']
    : posix ? [':', 'true', 'false', 'echo', 'printf', 'test', '[', 'pwd', 'cd', 'exit', 'export', 'unset', 'set', 'shift', 'return', 'readonly', 'umask', 'read', 'type'] : [];
  const builtin = !argv.length || builtins.includes(cmd ? argv[0].toLowerCase() : argv[0]);
  return { argv, env, builtin };
}

export function packageLifecycleNames(script, manifest = undefined) {
  if (manifest && script.ifPresent && selectedPackageScript(manifest, script) === undefined) return [];
  const names = script.ignoreScripts ? [script.name] : [`pre${script.name}`, script.name, `post${script.name}`];
  return script.manager === 'npm' && manifest ? names.filter((name) => name === script.name || manifest.scripts?.[name]) : names;
}

export async function packageInvocationEnvironment(packageRoot, script, env, platform = process.platform, npmExecutable = null) {
  const inherited = script.manager === 'npm'
    ? { ...env, ...script.npmEnvOverrides }
    : env;
  return packageScriptEnvironment(packageRoot, inherited, platform, script.manager === 'npm' ? npmExecutable : null);
}

/** Expand only declared workspace directories, with bounded read-only adapters
 * for the current filesystem and each immutable Git tree. No package manager
 * is executed and no node_modules/import graph is traversed. */
export async function selectPackageWorkspaces(manifestFile, manifest, script, { directories, readManifest }) {
  if (!script.allWorkspaces && !script.workspaces?.length) return [{ file: manifestFile, manifest }];
  const packageRoot = path.dirname(manifestFile);
  const patterns = Array.isArray(manifest.workspaces) ? manifest.workspaces : manifest.workspaces?.packages;
  if (!Array.isArray(patterns) || patterns.length > 256) throw new Error('package-workspaces-unrepresentable');
  const matches = new Set();
  const directoryCache = new Map();
  let steps = 0;
  const walk = async (cursor, segments, index) => {
    if (++steps > 2048 || index > 64) throw new Error('package-workspace-inspection-limit');
    if (index === segments.length) { matches.add(cursor); return; }
    if (segments[index] === '**') await walk(cursor, segments, index + 1);
    let children = directoryCache.get(cursor);
    if (!children) {
      children = await directories(cursor);
      if (children.length > 2048) throw new Error('package-workspace-inspection-limit');
      directoryCache.set(cursor, children);
    }
    for (const child of children) {
      if (['node_modules', '.git', '.ape'].includes(child)) continue;
      if (segments[index] === '**' || path.matchesGlob(child, segments[index])) {
        await walk(path.join(cursor, child), segments, segments[index] === '**' ? index : index + 1);
      }
    }
  };
  const excluded = [];
  const included = [];
  for (const raw of patterns) {
    if (typeof raw !== 'string' || raw.length > 4096 || /[\0\r\n\\:]/.test(raw)) throw new Error('package-workspaces-unrepresentable');
    const bangs = raw.match(/^!+/)?.[0].length ?? 0;
    const negate = bangs % 2 === 1;
    const pattern = raw.slice(bangs).replace(/^(?:\.\/)+/, '').replace(/\/+$/, '');
    const segments = pattern.split('/');
    if (!pattern || pattern.startsWith('/') || segments.some((part) => !part || part === '.' || part === '..') || segments.length > 64 || /[{}()]/.test(pattern)) throw new Error('package-workspaces-unrepresentable');
    if (negate) excluded.push(pattern);
    else {
      // npm's map-workspaces removes earlier exclusions matched by a later
      // positive pattern before expanding the remaining declarations.
      for (let i = excluded.length - 1; i >= 0; i -= 1) {
        if (path.matchesGlob(pattern, excluded[i])) excluded.splice(i, 1);
      }
      included.push(pattern);
    }
  }
  for (const pattern of included) {
    if (!excluded.some((exclusion) => path.matchesGlob(pattern, exclusion))) {
      await walk(packageRoot, pattern.split('/'), 0);
    }
  }
  const packages = [];
  const selectors = script.workspaces ?? [];
  for (const directory of [...matches].sort()) {
    if (directory === packageRoot) continue;
    const relative = path.relative(packageRoot, directory).split(path.sep).join('/');
    if (excluded.some((pattern) => path.matchesGlob(relative, pattern))) continue;
    const file = path.join(directory, 'package.json');
    const value = await readManifest(file);
    if (!value) continue;
    const matching = selectors.some((selector) => {
      const target = path.resolve(script.root, selector);
      return selector === value.name || target === directory || directory.startsWith(`${target}${path.sep}`);
    });
    // --workspaces enables workspace mode, but explicit filters still select
    // their union. npm only rejects when that union (including the root when
    // requested) is empty; one unmatched filter does not invalidate another.
    if (!selectors.length || matching) packages.push({ file, manifest: value });
  }
  if (script.includeWorkspaceRoot) packages.unshift({ file: manifestFile, manifest });
  if (!packages.length) throw new Error('package-workspace-missing');
  return packages;
}

/** npm discovers an ancestor workspace root from a workspace cwd. CLI prefix
 * and --no-workspaces prevent that discovery. Share the same bounded reads
 * for the working tree and each immutable baseline tree. */
export async function selectPackageContext(files, script, { directories, readManifest }) {
  let nearest = null;
  for (const file of script.prefixSpecified ? files.slice(0, 1) : files) {
    const manifest = await readManifest(file);
    if (!manifest) continue;
    if (!nearest) {
      nearest = { file, manifest, script };
      if (script.manager !== 'npm' || script.prefixSpecified || script.workspaceDiscoveryDisabled) return nearest;
      continue;
    }
    if (!manifest.workspaces) continue;
    let packages;
    try {
      packages = await selectPackageWorkspaces(file, manifest,
        { ...script, allWorkspaces: true, workspaces: [], includeWorkspaceRoot: false }, { directories, readManifest });
    } catch (error) {
      if (error.message === 'package-workspace-missing') continue;
      throw error;
    }
    if (packages.some((entry) => entry.file === nearest.file)) {
      if (script.workspaceDisabled) throw new Error('package-workspace-disabled');
      return { file, manifest, script: script.workspaceSelectionExplicit
        ? script : { ...script, workspaces: [path.dirname(nearest.file)] } };
    }
  }
  return nearest;
}

export function selectedPackageScript(manifest, script) {
  const command = manifest.scripts?.[script.name];
  return command === undefined ? script.default_command : command;
}

export function ancestorManifests(root, commandRoot) {
  const result = [];
  let cursor = commandRoot;
  for (let depth = 0; depth < 64; depth += 1) {
    const file = contained(root, path.join(cursor, 'package.json'));
    if (!file) throw new Error('invalid-command-root');
    result.push(file);
    if (cursor === root) return result;
    cursor = path.dirname(cursor);
  }
  throw new Error('command-root-too-deep');
}

async function treeEntries(root, commit, files) {
  const entries = new Map();
  // Fixed batches bound argv and stdout independently of repository size.
  for (let offset = 0; offset < files.length; offset += 64) {
    const selected = files.slice(offset, offset + 64);
    const output = await gitRead(root, ['ls-tree', '-z', commit, '--', ...selected]);
    if (Buffer.byteLength(output) > 128 * 1024) throw new Error('tree-result-over-limit');
    for (const record of output.split('\0').filter(Boolean)) {
      const tab = record.indexOf('\t');
      const file = record.slice(tab + 1);
      if (!selected.includes(file)) continue;
      const [mode, type, object] = record.slice(0, tab).split(' ');
      if (!SHA.test(object ?? '')) throw new Error('invalid-tree-entry');
      entries.set(file, { mode, type, object });
    }
  }
  return entries;
}

function manifestContract(manifest, script, includeScripts = true) {
  return {
    scripts: includeScripts ? Object.fromEntries(packageLifecycleNames(script, manifest).map((key) => [key, manifest.scripts?.[key] ?? null])) : null,
    dependencies: manifest.dependencies ?? null,
    devDependencies: manifest.devDependencies ?? null,
    optionalDependencies: manifest.optionalDependencies ?? null,
    engines: manifest.engines ?? null,
    packageManager: manifest.packageManager ?? null,
    workspaces: manifest.workspaces ?? null,
    type: manifest.type ?? null,
  };
}

/**
 * Compare exact tracked entry prerequisites with the commit START will use.
 * Immutable Git objects only: no checkout, index writes, package execution,
 * arbitrary import discovery, or invented future test files.
 */
export async function inspectAdmissionBaseline(root, input, repository, commands, executableFacts, { platform = process.platform, env: inheritedEnv = process.env } = {}) {
  if (!repository || input.mode === 'land' || repository.unborn || repository.head === repository.base_commit) return [];
  try {
    if (!SHA.test(repository.head ?? '') || !SHA.test(repository.base_commit ?? '') || commands.length > MAX_DEPENDENCIES) throw new Error('invalid-baseline');
    root = path.resolve(repository.root ?? root);
    const dependencies = new Set();
    const direct = new Set();
    const commandRoots = new Set();
    const scripts = [];
    const add = (file, target = direct) => {
      if (!file) return;
      if (file.length > 4_096) throw new Error('path-over-limit');
      dependencies.add(file);
      target.add(file);
      if (dependencies.size > MAX_DEPENDENCIES) throw new Error('dependency-limit');
    };
    const exactExecutables = async (rawArgv, commandRoot, target = direct, env = inheritedEnv, resolveSelected = false, shell = false) => {
      const invocation = unwrapAdmissionEnv(rawArgv, env);
      let executableFact = null;
      for (const stage of invocation.stages) {
        const executable = stage.argv[0] ?? '';
        if (/[\/\\]/.test(executable)) add(contained(root, path.resolve(commandRoot, executable)), target);
        if (invocation.wrapped || resolveSelected) {
          const fact = await resolveAdmissionExecutableFact(commandRoot, executable, { env: stage.env, platform, shell });
          executableFact = fact;
          if (!fact) {
            if (invocation.wrapped) throw new Error('env-delegate-unavailable');
            continue; // Current availability owns this case; exact lexical entries still compare below.
          }
          add(contained(root, fact.declared), target);
          add(contained(root, fact.resolved), target);
        }
      }
      return { argv: invocation.argv, env: /** @type {NodeJS.ProcessEnv} */ (invocation.env), executableFact };
    };
    for (const command of commands) {
      const commandRoot = path.resolve(root, command.root ?? '.');
      if (commandRoot !== root && !contained(root, commandRoot)) throw new Error('outside-command-root');
      if (commandRoot !== root) add(contained(root, commandRoot), commandRoots);
      const invocation = await exactExecutables(splitCommand(command.command), commandRoot);
      const argv = invocation.argv;
      const fact = executableFacts.find((entry) => entry.id === command.id);
      if (fact?.resolved) add(contained(root, fact.resolved));
      for (const operand of entryScripts(argv)) add(contained(root, path.resolve(commandRoot, operand)));
      const script = packageScript(argv, commandRoot, invocation.env, { platform });
      if (script) {
        const manifests = ancestorManifests(root, script.root);
        for (const file of manifests) add(file, new Set());
        scripts.push({ ...script, manifests, env: invocation.env, depth: 0,
          npmExecutable: invocation.executableFact?.resolved ?? fact?.resolved ?? null });
      }
    }
    let files = [...dependencies].sort();
    const [head, base] = await Promise.all([
      treeEntries(root, repository.head, files), treeEntries(root, repository.base_commit, files),
    ]);
    const changed = new Set();
    const compare = (file) => {
      if (canonicalJson(head.get(file) ?? null) !== canonicalJson(base.get(file) ?? null)) changed.add(file);
    };
    for (const file of direct) compare(file);
    // A runner working directory must survive checkout, but changing files
    // inside that directory is not itself a command-prerequisite change.
    for (const file of commandRoots) {
      const before = head.get(file);
      const after = base.get(file);
      if ((before?.type === 'tree') !== (after?.type === 'tree') ||
          (before?.type !== 'tree' && canonicalJson(before ?? null) !== canonicalJson(after ?? null))) changed.add(file);
    }
    const manifests = new Map();
    let remaining = MAX_TOTAL_MANIFEST_BYTES;
    const readManifest = async (entry) => {
      if (!regularBlob(entry)) throw new Error('manifest-not-regular-blob');
      if (manifests.has(entry.object)) return manifests.get(entry.object);
      const size = Number((await gitRead(root, ['cat-file', '-s', entry.object])).trim());
      if (!Number.isSafeInteger(size) || size < 0 || size > MAX_MANIFEST_BYTES || size > remaining) throw new Error('manifest-over-limit');
      remaining -= size;
      const raw = await gitRead(root, ['cat-file', 'blob', entry.object]);
      if (Buffer.byteLength(raw) !== size) throw new Error('manifest-size-mismatch');
      const value = JSON.parse(raw);
      if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('manifest-invalid');
      manifests.set(entry.object, value);
      return value;
    };
    const scriptEntries = new Set();
    const visitedScripts = new Set();
    const inspectedTreePaths = new Set(files);
    let workspaceReads = 0;
    const workspaceDirectories = new Map();
    const workspaceAdapters = (commit, entries) => ({
      directories: async (directory) => {
        const relative = directory === root ? '' : contained(root, directory);
        if (relative === null) throw new Error('outside-workspace-root');
        const key = `${commit}:${relative}`;
        if (workspaceDirectories.has(key)) return workspaceDirectories.get(key);
        if (++workspaceReads > 256) throw new Error('package-workspace-inspection-limit');
        const output = await gitRead(root, ['ls-tree', '-z', relative ? key : commit]);
        if (Buffer.byteLength(output) > 128 * 1024) throw new Error('tree-result-over-limit');
        const records = output.split('\0').filter(Boolean);
        if (records.length > 2048) throw new Error('package-workspace-inspection-limit');
        const directories = records.filter((record) => /^040000 tree /.test(record)).map((record) => record.slice(record.indexOf('\t') + 1));
        workspaceDirectories.set(key, directories);
        return directories;
      },
      readManifest: async (absolute) => {
        const relative = contained(root, absolute);
        if (!relative) throw new Error('outside-workspace-root');
        add(relative, new Set());
        if (!entries.has(relative)) {
          const found = await treeEntries(root, commit, [relative]);
          if (!found.has(relative)) return null;
          entries.set(relative, found.get(relative));
        }
        return readManifest(entries.get(relative));
      },
    });
    for (const script of scripts) {
      const key = canonicalJson({ root: script.root, name: script.name, default_command: script.default_command ?? null,
        ignoreScripts: script.ignoreScripts ?? false, ifPresent: script.ifPresent ?? false, workspaces: script.workspaces ?? [], allWorkspaces: script.allWorkspaces ?? false,
        includeWorkspaceRoot: script.includeWorkspaceRoot ?? false, scriptShell: script.scriptShell ?? null,
        prefixSpecified: script.prefixSpecified ?? false, workspaceDiscoveryDisabled: script.workspaceDiscoveryDisabled ?? false,
        workspaceSelectionExplicit: script.workspaceSelectionExplicit ?? false, npmExecutable: script.npmExecutable,
        npmEnv: Object.entries(npmAdmissionEnvironment(script.env)), npmEnvOverrides: script.npmEnvOverrides ?? {},
        PATH: admissionPathIdentity(script.env, platform), PATHEXT: admissionEnvValue(script.env, 'PATHEXT', platform) ?? '' });
      if (visitedScripts.has(key)) continue;
      if (script.depth > 8 || visitedScripts.size >= 256) throw new Error('package-script-nesting-limit');
      visitedScripts.add(key);
      const missingTreePaths = script.manifests.filter((file) => !inspectedTreePaths.has(file));
      if (missingTreePaths.length) {
        for (const file of missingTreePaths) { add(file, new Set()); inspectedTreePaths.add(file); }
        const [headManifests, baseManifests] = await Promise.all([
          treeEntries(root, repository.head, missingTreePaths), treeEntries(root, repository.base_commit, missingTreePaths),
        ]);
        for (const [file, entry] of headManifests) head.set(file, entry);
        for (const [file, entry] of baseManifests) base.set(file, entry);
      }
      // Compare presence before parsing, retaining a precise drift diagnostic
      // for a newly introduced non-regular manifest without following it.
      const candidateManifests = script.prefixSpecified ? script.manifests.slice(0, 1) : script.manifests;
      const headNearest = candidateManifests.find((file) => head.has(file));
      const baseNearest = candidateManifests.find((file) => base.has(file));
      if (headNearest !== baseNearest) {
        if (headNearest) changed.add(headNearest);
        if (baseNearest) changed.add(baseNearest);
        continue;
      }
      const headContext = await selectPackageContext(script.manifests.map((file) => path.join(root, file)), script, workspaceAdapters(repository.head, head));
      const baseContext = await selectPackageContext(script.manifests.map((file) => path.join(root, file)), script, workspaceAdapters(repository.base_commit, base));
      const headPath = headContext ? contained(root, headContext.file) : null;
      const basePath = baseContext ? contained(root, baseContext.file) : null;
      if (!headPath && !basePath) continue;
      if (headPath !== basePath) {
        if (headPath) changed.add(headPath);
        if (basePath) changed.add(basePath);
        continue;
      }
      const before = headContext.manifest;
      const after = baseContext.manifest;
      const headScript = headContext.script;
      const baseScript = baseContext.script;
      const usesWorkspaces = (selected) => selected.allWorkspaces || selected.workspaces?.length;
      if (canonicalJson(manifestContract(before, headScript, !usesWorkspaces(headScript))) !== canonicalJson(manifestContract(after, baseScript, !usesWorkspaces(baseScript)))) changed.add(headPath);
      let headPackages;
      let basePackages;
      try {
        headPackages = await selectPackageWorkspaces(headContext.file, before, headScript, workspaceAdapters(repository.head, head));
        basePackages = await selectPackageWorkspaces(baseContext.file, after, baseScript, workspaceAdapters(repository.base_commit, base));
      } catch (error) {
        if (error.message !== 'package-workspace-missing') throw error;
        changed.add(headPath);
        continue;
      }
      const selectedBefore = new Map(headPackages.map((item) => [contained(root, item.file), item.manifest]));
      const selectedAfter = new Map(basePackages.map((item) => [contained(root, item.file), item.manifest]));
      for (const file of new Set([...selectedBefore.keys(), ...selectedAfter.keys()])) {
        if (!selectedBefore.has(file) || !selectedAfter.has(file) ||
            canonicalJson(manifestContract(selectedBefore.get(file), headScript)) !== canonicalJson(manifestContract(selectedAfter.get(file), baseScript))) changed.add(file);
      }
      // A stable script can still lose its exact tracked interpreter entry.
      for (const { packages, selectedScript } of [{ packages: headPackages, selectedScript: headScript }, { packages: basePackages, selectedScript: baseScript }])
      for (const selected of packages) for (const name of packageLifecycleNames(selectedScript, selected.manifest)) {
        const value = selected.manifest;
        const command = name === selectedScript.name ? selectedPackageScript(value, selectedScript) : value.scripts?.[name];
        if (typeof command !== 'string' || (selectedScript.manager === 'npm' && command === '')) continue;
        const commandRoot = path.dirname(selected.file);
        const packageEnv = await packageInvocationEnvironment(commandRoot, selectedScript, script.env, platform, script.npmExecutable);
        if (selectedScript.scriptShell) await exactExecutables([selectedScript.scriptShell], commandRoot, scriptEntries, packageEnv, true);
        const shell = packageShellInvocation(splitCommand(command), packageEnv, { platform, scriptShell: selectedScript.scriptShell });
        if (shell.builtin) continue;
        const invocation = await exactExecutables(shell.argv, commandRoot, scriptEntries, shell.env, true, true);
        const argv = invocation.argv;
        for (const operand of entryScripts(argv)) {
          add(contained(root, path.resolve(commandRoot, operand)), scriptEntries);
        }
        const nested = packageScript(argv, commandRoot, invocation.env, { platform });
        if (nested) {
          scripts.push({ ...nested, manifests: ancestorManifests(root, nested.root), env: invocation.env, depth: script.depth + 1,
            npmExecutable: invocation.executableFact?.resolved ?? null });
          if (scripts.length > MAX_DEPENDENCIES) throw new Error('package-script-inspection-limit');
        }
      }
    }
    files = [...scriptEntries].sort();
    if (files.length) {
      const [headScripts, baseScripts] = await Promise.all([
        treeEntries(root, repository.head, files), treeEntries(root, repository.base_commit, files),
      ]);
      for (const [file, entry] of headScripts) head.set(file, entry);
      for (const [file, entry] of baseScripts) base.set(file, entry);
      for (const file of files) compare(file);
    }
    if (!changed.size) return [];
    return [{
      code: 'baseline-command-prerequisite-drift', paths: [...changed].sort().slice(0, 64), path_count: changed.size,
      message: 'These tracked command prerequisites differ from the resolved base that this run will use. Review the base checkout and configure prerequisites available there before previewing again. Use land only when the existing feature diff is finished and approved; APE did not change branches or widen authority.',
    }];
  } catch {
    return [{ code: 'baseline-prerequisites-unavailable',
      message: 'The bounded read-only comparison could not verify command prerequisites on the resolved base. Inspect the exact runner configuration and tracked package manifests before retrying preview; no prerequisite command was executed.' }];
  }
}
