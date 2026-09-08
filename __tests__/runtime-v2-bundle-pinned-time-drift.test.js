import { build } from 'esbuild';
import { mkdtemp, mkdir, readFile, rename, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { runGit } from '../lib/runtime/git.js';

const fixtures = [];
afterEach(async () => {
  await Promise.all(fixtures.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('loaded bundle identity under reproducible package timestamps', () => {
  it.each(['rewrite', 'replace'])('detects a same-size %s with the same pinned mtime', async (publication) => {
    const root = await mkdtemp(path.join(tmpdir(), 'ape-bundle-pinned-time-'));
    fixtures.push(root);
    const sourceRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
    const bundle = path.join(root, 'dist', 'ape-mcp.bundle.mjs');
    await mkdir(path.dirname(bundle));
    const built = await build({
      stdin: { contents: `export { doctor } from ${JSON.stringify(path.join(sourceRoot, 'lib/runtime/doctor.js'))};`, resolveDir: sourceRoot },
      bundle: true, platform: 'node', format: 'esm', target: 'node22', write: false, logLevel: 'silent',
    });
    const original = built.outputFiles[0].text;
    await writeFile(bundle, original);
    await utimes(bundle, 0, 0);
    await runGit(root, ['init', '-q']);
    await runGit(root, ['add', 'dist']);
    await runGit(root, ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'fixture']);
    const { doctor } = await import(/* @vite-ignore */ pathToFileURL(bundle).href);
    const loaded = await stat(bundle);
    // Idempotent publication must not report stale code solely from metadata.
    await writeFile(bundle, original);
    await utimes(bundle, 0, 0);
    expect((await doctor(root)).checks.some((check) => check.name === 'loaded-module-drift')).toBe(false);

    const changed = original.replace('explicit-invocation', 'explicit-invocati0n');
    expect(changed).not.toBe(original);
    if (publication === 'replace') {
      const temporary = `${bundle}.fixture`;
      await writeFile(temporary, changed);
      await utimes(temporary, 0, 0);
      await rename(temporary, bundle);
    } else {
      await writeFile(bundle, changed);
      await utimes(bundle, 0, 0);
    }
    const current = await stat(bundle);
    expect(current.size).toBe(loaded.size);
    expect(current.mtimeMs).toBe(loaded.mtimeMs);
    expect(await readFile(bundle, 'utf8')).toBe(changed);
    const drift = (await doctor(root)).checks.find((check) => check.name === 'loaded-module-drift');
    expect(drift?.informational).toBe(true);
    expect(drift?.loaded_sha256).not.toBe(drift?.on_disk_sha256);
  });
});
