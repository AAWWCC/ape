import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const REPO_ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

// These options and banners mirror scripts/bundle-mcp.mjs exactly: the test attests
// that the committed dist/ artifacts are what that script would produce from the
// current sources, so a lib/ or bin/ change shipped without `npm run bundle` fails
// here instead of in CI's freshness check (`npm run bundle && git diff -- dist/`).
const BUNDLES = [
  {
    entry: 'bin/ape-mcp.mjs',
    committed: 'dist/ape-mcp.bundle.mjs',
    banner:
      '// @generated AUTO-GENERATED build artifact by scripts/bundle-mcp.mjs — DO NOT EDIT BY HAND; it mirrors the source tree (bin/ape-mcp.mjs, lib/runtime/) and a hand edit is LOST on the next build. Regenerate with `npm run bundle`.',
  },
  {
    entry: 'bin/ape-hook.mjs',
    committed: 'dist/ape-hooks.bundle.mjs',
    banner:
      '// @generated AUTO-GENERATED build artifact by scripts/bundle-mcp.mjs — DO NOT EDIT BY HAND; it mirrors bin/ape-hook.mjs and lib/runtime/. Regenerate with `npm run bundle`.',
  },
  {
    entry: 'bin/ape-larp.mjs',
    committed: 'dist/ape-larp.bundle.mjs',
    banner:
      '// @generated AUTO-GENERATED build artifact by scripts/bundle-mcp.mjs — DO NOT EDIT BY HAND; it mirrors bin/ape-larp.mjs and lib/runtime/. Regenerate with `npm run bundle`.',
  },
];

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

// The rebuild happens strictly out-of-tree (an os.tmpdir mkdtemp directory): this
// test must never mutate the repository it is attesting.
let scratch;

beforeAll(async () => {
  scratch = await mkdtemp(path.join(tmpdir(), 'ape-bundle-freshness-'));
});

afterAll(async () => {
  if (scratch) await rm(scratch, { recursive: true, force: true });
});

describe('committed dist bundles are fresh', () => {
  it('rebuilds out-of-tree, never inside the repository', () => {
    // On Windows a temp dir on another drive makes path.relative return an
    // absolute path instead of a ..-prefixed one; both forms are out-of-tree.
    const relative = path.relative(REPO_ROOT, scratch);
    expect(relative.startsWith('..') || path.isAbsolute(relative)).toBe(true);
  });

  for (const bundle of BUNDLES) {
    it(`${bundle.committed} is byte-identical to a fresh build of ${bundle.entry}`, async () => {
      const outfile = path.join(scratch, path.basename(bundle.committed));
      await build({
        entryPoints: [path.join(REPO_ROOT, bundle.entry)],
        outfile,
        bundle: true,
        platform: 'node',
        format: 'esm',
        target: 'node22',
        minifyWhitespace: true,
        banner: { js: bundle.banner },
        logLevel: 'silent',
      });
      const fresh = await readFile(outfile);
      const committed = await readFile(path.join(REPO_ROOT, bundle.committed));
      expect(
        { bytes: committed.length, sha256: sha256(committed) },
        `${bundle.committed} is stale — regenerate with \`npm run bundle\``,
      ).toEqual({ bytes: fresh.length, sha256: sha256(fresh) });
    });
  }
});
