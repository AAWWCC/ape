import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { BUNDLE_ENTRIES as BUNDLES, BUNDLE_OPTIONS } from '../scripts/bundle-definition.mjs';

const REPO_ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

// Rebuild the generator's shared contract outside the tree and compare bytes.
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
    it(`${bundle.artifact} is byte-identical to a fresh build of ${bundle.entry}`, async () => {
      const outfile = path.join(scratch, path.basename(bundle.artifact));
      await build({
        entryPoints: [path.join(REPO_ROOT, bundle.entry)],
        outfile,
        ...BUNDLE_OPTIONS,
        banner: { js: bundle.banner },
        logLevel: 'silent',
      });
      const fresh = await readFile(outfile);
      const committed = await readFile(path.join(REPO_ROOT, bundle.artifact));
      expect(
        { bytes: committed.length, sha256: sha256(committed) },
        `${bundle.artifact} is stale — regenerate with \`npm run bundle\``,
      ).toEqual({ bytes: fresh.length, sha256: sha256(fresh) });
    });
  }
});
