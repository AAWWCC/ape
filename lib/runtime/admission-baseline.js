import path from 'node:path';
import { canonicalJson } from './canonical.js';
import { runGit } from './git.js';
import { splitCommand } from './runner.js';
import { resolveAdmissionExecutableFact, unwrapAdmissionEnv } from './admission-command-argv.js';

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
  const args = argv.slice(1);
  if (args.some((arg) => ['-e', '--eval', '-p', '--print', '-c', '-m'].includes(arg) || /^--(?:eval|print)=/.test(arg))) return [];
  const result = [];
  for (let i = 0; i < args.length; i += 1) {
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
    if (['--conditions', '-C', '--inspect-port', '--title', '--icu-data-dir', '-W', '-X'].includes(args[i])) { i += 1; continue; }
    if (args[i].startsWith('-')) continue;
    if (args.some((arg) => arg === '--test' || arg.startsWith('--test='))) continue;
    if (!/[{}*?]/.test(args[i])) {
      result.push(args[i]);
      break;
    }
  }
  return result;
}

export function packageScript(argv, commandRoot) {
  argv = unwrapAdmissionEnv(argv).argv;
  const executable = path.basename(argv[0] ?? '').replace(/\.(exe|cmd|bat)$/i, '');
  if (!['npm', 'pnpm', 'yarn', 'bun'].includes(executable)) return null;
  const args = [];
  let root = commandRoot;
  for (let i = 1; i < argv.length; i += 1) {
    if (['--prefix', '--dir', '--cwd', '-C'].includes(argv[i])) {
      if (!argv[i + 1]) return null;
      root = path.resolve(root, argv[++i]);
    } else if (/^--(?:prefix|dir|cwd)=/.test(argv[i])) root = path.resolve(root, argv[i].slice(argv[i].indexOf('=') + 1));
    else args.push(argv[i]);
  }
  const action = args.findIndex((arg) => !arg.startsWith('-'));
  const first = args[action];
  const name = ['run', 'run-script'].includes(first) ? args[action + 1] :
    ['test', 'start', 'stop', 'restart'].includes(first) && executable !== 'bun' ? first : null;
  return name && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(name) ? { root, name } : null;
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

function manifestContract(manifest, name) {
  return {
    scripts: Object.fromEntries([`pre${name}`, name, `post${name}`].map((key) => [key, manifest.scripts?.[key] ?? null])),
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
export async function inspectAdmissionBaseline(root, input, repository, commands, executableFacts) {
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
    const exactExecutables = async (rawArgv, commandRoot, target = direct, env = process.env) => {
      const invocation = unwrapAdmissionEnv(rawArgv, env);
      for (const stage of invocation.stages) {
        const executable = stage.argv[0] ?? '';
        if (/[\/\\]/.test(executable)) add(contained(root, path.resolve(commandRoot, executable)), target);
        if (invocation.wrapped) {
          const fact = await resolveAdmissionExecutableFact(commandRoot, executable, { env: stage.env });
          if (!fact) throw new Error('env-delegate-unavailable');
          add(contained(root, fact.declared), target);
          add(contained(root, fact.resolved), target);
        }
      }
      return invocation.argv;
    };
    for (const command of commands) {
      const commandRoot = path.resolve(root, command.root ?? '.');
      if (commandRoot !== root && !contained(root, commandRoot)) throw new Error('outside-command-root');
      if (commandRoot !== root) add(contained(root, commandRoot), commandRoots);
      const argv = await exactExecutables(splitCommand(command.command), commandRoot);
      const fact = executableFacts.find((entry) => entry.id === command.id);
      if (fact?.resolved) add(contained(root, fact.resolved));
      for (const operand of entryScripts(argv)) add(contained(root, path.resolve(commandRoot, operand)));
      const script = packageScript(argv, commandRoot);
      if (script) {
        const manifests = ancestorManifests(root, script.root);
        for (const file of manifests) add(file, new Set());
        scripts.push({ ...script, manifests });
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
    for (const script of scripts) {
      const headPath = script.manifests.find((file) => head.has(file));
      const basePath = script.manifests.find((file) => base.has(file));
      if (!headPath && !basePath) continue;
      if (headPath !== basePath) {
        if (headPath) changed.add(headPath);
        if (basePath) changed.add(basePath);
        continue;
      }
      const before = await readManifest(head.get(headPath));
      const after = await readManifest(base.get(basePath));
      if (canonicalJson(manifestContract(before, script.name)) !== canonicalJson(manifestContract(after, script.name))) changed.add(headPath);
      // A stable script can still lose its exact tracked interpreter entry.
      for (const value of [before, after]) for (const name of [`pre${script.name}`, script.name, `post${script.name}`]) {
        const command = value.scripts?.[name];
        if (typeof command !== 'string') continue;
        const commandRoot = path.resolve(root, path.dirname(headPath));
        const packageEnv = { ...process.env, PATH: [path.join(commandRoot, 'node_modules', '.bin'), process.env.PATH ?? ''].join(path.delimiter) };
        const argv = await exactExecutables(splitCommand(command), commandRoot, scriptEntries, packageEnv);
        for (const operand of entryScripts(argv)) {
          add(contained(root, path.resolve(root, path.dirname(headPath), operand)), scriptEntries);
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
