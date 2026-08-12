#!/usr/bin/env node
/**
 * Produce the committed, self-contained APE v2 MCP server and lifecycle-hook
 * bundles via esbuild.
 *
 * The installed plugin's `.mcp.json` spawns `node dist/ape-mcp.bundle.mjs` with
 * NO `npm install` step: the server source (`bin/ape-mcp.mjs`), the sole runtime
 * dependency (`zod`), and the whole `lib/` domain tree are inlined into one ESM
 * file. The server speaks JSON-RPC over stdio by hand — there is no MCP SDK to
 * bundle. `bin/ape-mcp.mjs` remains the unbundled dev source the test suites
 * spawn directly; this script keeps the committed artifact in lockstep with it.
 *
 * Wired as `npm run bundle`. esbuild is a DEV-only dependency. node22 target,
 * esm format, platform node.
 *
 * Run with NO arguments. Exits non-zero (LOUD) on any build failure so a broken
 * bundle never silently ships.
 */

import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { mkdirSync } from 'node:fs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = dirname(__dirname);
const ENTRY = join(REPO_ROOT, 'bin', 'ape-mcp.mjs');
const OUT_DIR = join(REPO_ROOT, 'dist');
const OUT_FILE = join(OUT_DIR, 'ape-mcp.bundle.mjs');
const HOOKS_ENTRY = join(REPO_ROOT, 'bin', 'ape-hook.mjs');
const HOOKS_OUT_FILE = join(OUT_DIR, 'ape-hooks.bundle.mjs');
const LARP_ENTRY = join(REPO_ROOT, 'bin', 'ape-larp.mjs');
const LARP_OUT_FILE = join(OUT_DIR, 'ape-larp.bundle.mjs');

async function main() {
  mkdirSync(OUT_DIR, { recursive: true });

  await build({
    entryPoints: [ENTRY],
    outfile: OUT_FILE,
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node22',
    minifyWhitespace: true,
    // The server reads package.json relative to import.meta.url to advertise its
    // serverInfo.version. esbuild rewrites import.meta.url in the bundle; the
    // server's packageInfo() falls back to a static name/version when the
    // anchor misses, so the bundle still handshakes as 'ape'. Keep import.meta
    // live so any same-dir reads resolve against the bundle's own location.
    banner: {
      js: '// @generated AUTO-GENERATED build artifact by scripts/bundle-mcp.mjs — DO NOT EDIT BY HAND; it mirrors the source tree (bin/ape-mcp.mjs, lib/runtime/) and a hand edit is LOST on the next build. Regenerate with `npm run bundle`.',
    },
    logLevel: 'info',
  });

  process.stdout.write(`bundle-mcp: wrote ${OUT_FILE}\n`);

  // The lifecycle hook is installed as a self-contained artifact so neither
  // supported host needs package installation before enforcing ticket policy.
  await build({
    entryPoints: [HOOKS_ENTRY],
    outfile: HOOKS_OUT_FILE,
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node22',
    minifyWhitespace: true,
    banner: {
      js: '// @generated AUTO-GENERATED build artifact by scripts/bundle-mcp.mjs — DO NOT EDIT BY HAND; it mirrors bin/ape-hook.mjs and lib/runtime/. Regenerate with `npm run bundle`.',
    },
    logLevel: 'info',
  });

  process.stdout.write(`bundle-mcp: wrote ${HOOKS_OUT_FILE}\n`);

  // LARP MODE is a second, deliberately separate hook artifact: the policy
  // hook fails closed, the sound hook fails open, and one bundle cannot hold
  // both failure postures.
  await build({
    entryPoints: [LARP_ENTRY],
    outfile: LARP_OUT_FILE,
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node22',
    minifyWhitespace: true,
    banner: {
      js: '// @generated AUTO-GENERATED build artifact by scripts/bundle-mcp.mjs — DO NOT EDIT BY HAND; it mirrors bin/ape-larp.mjs and lib/runtime/. Regenerate with `npm run bundle`.',
    },
    logLevel: 'info',
  });

  process.stdout.write(`bundle-mcp: wrote ${LARP_OUT_FILE}\n`);
}

main().catch((err) => {
  process.stderr.write(`bundle-mcp: FAILED — ${err?.message ?? String(err)}\n`);
  process.exit(1);
});
