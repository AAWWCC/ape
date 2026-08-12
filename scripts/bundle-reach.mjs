#!/usr/bin/env node
/**
 * Report which committed dist/ artifacts one or more source paths reach —
 * MECHANICALLY, by building each entry point with esbuild and reading
 * `metafile.outputs[…].inputs[path].bytesInOutput`, never by reading or
 * grepping a committed bundle.
 *
 * WHY THIS EXISTS. run-fixture-494d93e8fd2f declared `lib/runtime/
 * runner.js` reached `dist/ape-mcp.bundle.mjs` ONLY, derived by grepping the
 * committed minified bundles for two chosen symbols and finding them absent
 * from `dist/ape-larp.bundle.mjs`. That method is invalid: esbuild
 * tree-shakes, so an absent symbol proves only that ONE export is unused in
 * that bundle, never that the module is absent — and a module with a
 * top-level side effect (see `lib/runtime/runner.js`'s
 * `if (invokedAsGateRunner()) {…}`) lands in full regardless of which export
 * is used. See docs/architecture.md ("Bundle reachability") for the
 * verified record this incident produced and skills/run/SKILL.md ("Scope
 * fields") for the authoring guidance this tool exists to satisfy.
 *
 * Mirrors scripts/bundle-mcp.mjs's three entry points and their exact build
 * options (bundle/platform/format/target/minifyWhitespace) — keep the two in
 * step rather than duplicating a divergent option set. This script never
 * writes an outfile: every build here runs `write: false`, so running it
 * never touches dist/ or anywhere else in the tree.
 *
 * Usage: node scripts/bundle-reach.mjs <source-path> [source-path...]
 * Each path is project-relative or absolute and must name an existing file
 * inside this repository; zero arguments, a path outside the repo, a
 * nonexistent path, or a path that exists but is not a file (e.g. a
 * directory) is a usage error (exit 1, message on stderr naming that
 * specific cause) rather than a silent empty report. On success (exit 0)
 * stdout prints one line per given path naming the dist/ artifacts it
 * contributes bytes to, or that it reaches none.
 *
 * This is a run author's AID, not enforcement: nothing wires it into
 * `ape_run start`, the hook, the gates, or receipt validation, and no run
 * fails because it was not run.
 */

import { build } from 'esbuild';
import { statSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = dirname(__dirname);

// Mirrors scripts/bundle-mcp.mjs's ENTRY / HOOKS_ENTRY / LARP_ENTRY and their
// build options exactly (see that file's header comment); the label is this
// tool's own vocabulary for reporting, not a bundle-mcp.mjs concept.
const ENTRIES = [
  { label: 'mcp', entry: 'bin/ape-mcp.mjs', artifact: 'dist/ape-mcp.bundle.mjs' },
  { label: 'hooks', entry: 'bin/ape-hook.mjs', artifact: 'dist/ape-hooks.bundle.mjs' },
  { label: 'larp', entry: 'bin/ape-larp.mjs', artifact: 'dist/ape-larp.bundle.mjs' },
];

/** @type {import('esbuild').BuildOptions} */
const BUILD_OPTIONS = {
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  minifyWhitespace: true,
};

class UsageError extends Error {}

/**
 * Resolve a CLI-supplied path to the repo-relative, forward-slash form
 * esbuild's metafile keys its `inputs` map by. Throws UsageError for a path
 * outside this repository, one that does not exist on disk, or one that
 * exists but is not a file (e.g. a directory) — each left "undefined...
 * yours to define sensibly" by the ticket, defined here as loud usage
 * errors, each naming its own cause, rather than a silently empty report.
 */
function toRepoRelative(rawArg) {
  const resolved = resolve(process.cwd(), rawArg);
  const rel = relative(REPO_ROOT, resolved);
  if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new UsageError(`path is outside the repository: ${rawArg}`);
  }
  let stat;
  try {
    stat = statSync(resolved);
  } catch {
    throw new UsageError(`no such file: ${rawArg}`);
  }
  if (!stat.isFile()) {
    throw new UsageError(`not a file: ${rawArg}`);
  }
  return rel.split(sep).join('/');
}

async function buildMetafile(entry) {
  const result = await build({
    ...BUILD_OPTIONS,
    entryPoints: [join(REPO_ROOT, entry)],
    write: false,
    metafile: true,
    absWorkingDir: REPO_ROOT,
    logLevel: 'silent',
  });
  return result.metafile;
}

/** Which of ENTRIES' artifacts `sourceRelPath` contributes bytes to. */
function reachedEntries(metafiles, sourceRelPath) {
  const reached = [];
  for (const info of ENTRIES) {
    const metafile = metafiles[info.label];
    const [outputKey] = Object.keys(metafile.outputs);
    const inputInfo = metafile.outputs[outputKey].inputs[sourceRelPath];
    if (inputInfo && inputInfo.bytesInOutput > 0) reached.push(info);
  }
  return reached;
}

async function main(argv) {
  if (argv.length === 0) {
    process.stderr.write(
      'bundle-reach: usage: node scripts/bundle-reach.mjs <source-path> [source-path...]\n',
    );
    process.exitCode = 1;
    return;
  }

  let relPaths;
  try {
    relPaths = argv.map(toRepoRelative);
  } catch (err) {
    if (err instanceof UsageError) {
      process.stderr.write(`bundle-reach: ${err.message}\n`);
      process.exitCode = 1;
      return;
    }
    throw err;
  }

  const metafiles = {};
  for (const { label, entry } of ENTRIES) {
    metafiles[label] = await buildMetafile(entry);
  }

  for (const relPath of relPaths) {
    const reached = reachedEntries(metafiles, relPath);
    if (reached.length === 0) {
      process.stdout.write(`${relPath}: reaches no dist/ artifact\n`);
    } else {
      process.stdout.write(`${relPath}: ${reached.map((info) => info.artifact).join(', ')}\n`);
    }
  }
}

main(process.argv.slice(2)).catch((err) => {
  process.stderr.write(`bundle-reach: FAILED — ${err?.message ?? String(err)}\n`);
  process.exit(1);
});
