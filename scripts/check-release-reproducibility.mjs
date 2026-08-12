#!/usr/bin/env node

import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const run = promisify(execFile);
const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const BUILDER = join(SCRIPT_DIR, 'build-release-artifacts.mjs');

async function digests(root) {
  const result = {};
  for (const name of (await readdir(root)).sort((a, b) => a < b ? -1 : a > b ? 1 : 0)) {
    const bytes = await readFile(join(root, name));
    result[name] = createHash('sha256').update(bytes).digest('hex');
  }
  return result;
}

async function main() {
  const scratch = await mkdtemp(join(tmpdir(), 'ape-release-reproducibility-'));
  try {
    const first = join(scratch, 'first');
    const second = join(scratch, 'second');
    const env = { ...process.env, SOURCE_DATE_EPOCH: process.env.SOURCE_DATE_EPOCH ?? '0', LC_ALL: 'C' };
    await run(process.execPath, [BUILDER, '--output-root', first], { cwd: SCRIPT_DIR, env });
    await run(process.execPath, [BUILDER, '--output-root', second], { cwd: SCRIPT_DIR, env: { ...env, LANG: 'C.UTF-8' } });
    const firstDigests = await digests(first);
    const secondDigests = await digests(second);
    if (JSON.stringify(firstDigests) !== JSON.stringify(secondDigests)) {
      throw new Error('two release builds produced different artifact bytes');
    }
    process.stdout.write(`release reproducibility passed: ${Object.keys(firstDigests).length} byte-identical artifacts\n`);
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

main().catch((error) => {
  process.stderr.write(`check-release-reproducibility: ${error?.message ?? String(error)}\n`);
  process.exitCode = 1;
});
