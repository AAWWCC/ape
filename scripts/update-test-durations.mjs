#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const scratch = await mkdtemp(join(tmpdir(), 'ape-test-timings-'));
const report = join(scratch, 'vitest.json');
const destination = join(root, '.github', 'test-durations.json');
const staged = `${destination}.${process.pid}.tmp`;

try {
  const vitest = join(root, 'node_modules', 'vitest', 'vitest.mjs');
  const run = spawnSync(process.execPath, [
    vitest,
    'run',
    '--no-file-parallelism',
    '--reporter=json',
    `--outputFile=${report}`,
    ...process.argv.slice(2),
  ], { cwd: root, stdio: 'inherit' });
  if (run.error) throw run.error;
  if (run.status !== 0) {
    throw new Error(`timing suite failed with exit code ${run.status}; existing shard weights were not changed`);
  }

  const payload = JSON.parse(await readFile(report, 'utf8'));
  const durations = {};
  for (const result of payload.testResults ?? []) {
    const file = relative(root, resolve(result.name)).split(sep).join('/');
    const duration = Math.max(1, Math.round(Number(result.endTime) - Number(result.startTime)));
    if (file.startsWith('__tests__/') && Number.isFinite(duration)) durations[file] = duration;
  }
  const sorted = Object.fromEntries(Object.entries(durations).sort(([a], [b]) => a.localeCompare(b)));
  if (Object.keys(sorted).length === 0) throw new Error('timing suite produced no test-file durations');
  await writeFile(staged, `${JSON.stringify(sorted, null, 2)}\n`, { mode: 0o600 });
  await rename(staged, destination);
  process.stdout.write(`Updated ${relative(root, destination)} with ${Object.keys(sorted).length} test-file durations.\n`);
} finally {
  await rm(staged, { force: true }).catch(() => {});
  await rm(scratch, { recursive: true, force: true });
}
