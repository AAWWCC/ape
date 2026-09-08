// One build contract for generation, freshness checks and reachability reports.
export const BUNDLE_ENTRIES = Object.freeze([
  {
    label: 'mcp', entry: 'bin/ape-mcp.mjs', artifact: 'dist/ape-mcp.bundle.mjs',
    banner: '// @generated AUTO-GENERATED build artifact by scripts/bundle-mcp.mjs — DO NOT EDIT BY HAND; it mirrors the source tree (bin/ape-mcp.mjs, lib/runtime/) and a hand edit is LOST on the next build. Regenerate with `npm run bundle`.',
  },
  {
    label: 'hooks', entry: 'bin/ape-hook.mjs', artifact: 'dist/ape-hooks.bundle.mjs',
    banner: '// @generated AUTO-GENERATED build artifact by scripts/bundle-mcp.mjs — DO NOT EDIT BY HAND; it mirrors bin/ape-hook.mjs and lib/runtime/. Regenerate with `npm run bundle`.',
  },
  {
    label: 'larp', entry: 'bin/ape-larp.mjs', artifact: 'dist/ape-larp.bundle.mjs',
    banner: '// @generated AUTO-GENERATED build artifact by scripts/bundle-mcp.mjs — DO NOT EDIT BY HAND; it mirrors bin/ape-larp.mjs and lib/runtime/. Regenerate with `npm run bundle`.',
  },
].map((entry) => Object.freeze(entry)));

/** @type {Readonly<import('esbuild').BuildOptions>} */
export const BUNDLE_OPTIONS = Object.freeze({
  bundle: true, platform: 'node', format: 'esm', target: 'node22', minifyWhitespace: true,
});
