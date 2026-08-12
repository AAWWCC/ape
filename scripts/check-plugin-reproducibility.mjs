#!/usr/bin/env node

import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstat, mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const run = promisify(execFile);
const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const BUILDER = join(SCRIPT_DIR, 'build-plugin-packages.mjs');

async function inventory(root) {
  const result = new Map();
  async function visit(directory) {
    const entries = (await readdir(directory, { withFileTypes: true }))
      .sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0);
    for (const entry of entries) {
      const path = join(directory, entry.name);
      const normalized = relative(root, path).split(sep).join('/');
      if (entry.isSymbolicLink()) throw new Error(`reproducibility check refuses symlink: ${path}`);
      if (entry.isDirectory()) {
        result.set(`${normalized}/`, { mode: (await lstat(path)).mode & 0o777 });
        await visit(path);
      }
      else if (entry.isFile()) {
        const bytes = await readFile(path);
        result.set(normalized, {
          mode: (await lstat(path)).mode & 0o777,
          bytes: bytes.length,
          sha256: createHash('sha256').update(bytes).digest('hex'),
        });
      } else throw new Error(`reproducibility check refuses special file: ${path}`);
    }
  }
  await visit(root);
  return result;
}

function comparable(map) {
  return JSON.stringify([...map.entries()].sort(([left], [right]) =>
    left < right ? -1 : left > right ? 1 : 0
  ));
}

async function main() {
  const scratch = await mkdtemp(join(tmpdir(), 'ape-package-reproducibility-'));
  try {
    const first = join(scratch, 'first');
    const second = join(scratch, 'second');
    const env = { ...process.env, SOURCE_DATE_EPOCH: process.env.SOURCE_DATE_EPOCH ?? '0' };
    await run(process.execPath, [BUILDER, '--output-root', first], {
      cwd: SCRIPT_DIR,
      env: { ...env, LC_ALL: 'C', LANG: 'C' },
    });
    await run(process.execPath, [BUILDER, '--output-root', second], {
      cwd: SCRIPT_DIR,
      env: { ...env, LC_ALL: 'C.UTF-8', LANG: 'C.UTF-8' },
    });
    const [firstInventory, secondInventory] = await Promise.all([
      inventory(first),
      inventory(second),
    ]);
    if (comparable(firstInventory) !== comparable(secondInventory)) {
      throw new Error('two isolated plugin-package builds produced different inventories or bytes');
    }
    process.stdout.write(
      `plugin package reproducibility passed: ${firstInventory.size} byte-identical files/directories\n`,
    );
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

main().catch((error) => {
  process.stderr.write(`check-plugin-reproducibility: ${error?.message ?? String(error)}\n`);
  process.exitCode = 1;
});
