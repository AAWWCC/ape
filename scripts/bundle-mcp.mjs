#!/usr/bin/env node
/**
 * Produce the committed, self-contained APE v2 MCP server and lifecycle-hook
 * bundles via esbuild.
 *
 * The installed plugin's `.mcp.json` spawns `node dist/ape-mcp.bundle.mjs` with
 * NO `npm install` step: the server source (`bin/ape-mcp.mjs`), runtime
 * dependencies (`zod` and `smol-toml`), and the `lib/` domain tree are inlined into one ESM
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
import { BUNDLE_ENTRIES, BUNDLE_OPTIONS } from './bundle-definition.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = dirname(__dirname);
async function main() {
  // Separate artifacts preserve the policy hook's fail-closed behavior and
  // the sound hook's fail-open behavior. All entry points share build options.
  for (const bundle of BUNDLE_ENTRIES) {
    const outfile = join(REPO_ROOT, bundle.artifact);
    mkdirSync(dirname(outfile), { recursive: true });
    await build({
      ...BUNDLE_OPTIONS,
      entryPoints: [join(REPO_ROOT, bundle.entry)],
      outfile,
      banner: { js: bundle.banner },
      logLevel: 'info',
    });
    process.stdout.write(`bundle-mcp: wrote ${outfile}\n`);
  }
}

main().catch((err) => {
  process.stderr.write(`bundle-mcp: FAILED — ${err?.message ?? String(err)}\n`);
  process.exit(1);
});
