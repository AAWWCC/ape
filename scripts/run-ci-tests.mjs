#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { readFile, readdir, stat } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const TEST_ROOT = join(ROOT, '__tests__');

// These host/locking/protocol cases run in the fast Windows smoke job. Full
// shards exclude them, so a green smoke result is never paid for twice.
export const WINDOWS_SMOKE_TEST_FILES = Object.freeze([
  '__tests__/runtime-v2-codex-windows-launchers.test.js',
  '__tests__/runtime-v2-lock-protocol.test.js',
  '__tests__/runtime-v2-mcp.test.js',
  '__tests__/runtime-v2-mcp-tasks-storage.test.js',
  '__tests__/runtime-v2-mcp-tasks-protocol.test.js',
  '__tests__/runtime-v2-mcp-tasks-cancellation.test.js',
  '__tests__/runtime-v2-mcp-tasks-reissue.test.js',
  '__tests__/runtime-v2-plugin-validation.test.js',
  '__tests__/runtime-v2-gates-plugin-parity.test.js',
]);

export async function listTestFiles() {
  const entries = await readdir(TEST_ROOT, { recursive: true });
  return entries
    .map((entry) => `__tests__/${String(entry).replaceAll('\\', '/')}`)
    .filter((entry) => entry.endsWith('.test.js'))
    .sort();
}

async function loadDurations() {
  try {
    return JSON.parse(await readFile(join(ROOT, '.github', 'test-durations.json'), 'utf8'));
  } catch {
    return {};
  }
}

// Longest-processing-time scheduling is deterministic and gives each Windows
// runner a similar historical workload. New files use source size as a stable
// cost proxy until the duration snapshot is refreshed.
export async function balancedShards(files, shardCount, durations = {}) {
  if (!Number.isInteger(shardCount) || shardCount < 1) throw new Error('shard count must be a positive integer');
  const weighted = await Promise.all(files.map(async (file) => {
    const measured = Number(durations[file]);
    const fallback = Math.max(50, Math.round((await stat(join(ROOT, file))).size / 16));
    return { file, weight: Number.isFinite(measured) && measured > 0 ? measured : fallback };
  }));
  weighted.sort((a, b) => b.weight - a.weight || a.file.localeCompare(b.file));
  const bins = Array.from({ length: shardCount }, (_, index) => ({ index, total: 0, files: [] }));
  for (const item of weighted) {
    bins.sort((a, b) => a.total - b.total || a.index - b.index);
    bins[0].files.push(item.file);
    bins[0].total += item.weight;
  }
  bins.sort((a, b) => a.index - b.index);
  return bins.map((bin) => ({ ...bin, files: bin.files.sort() }));
}

export async function selectCiTests(mode, shardNumber = 1, shardCount = 1) {
  if (mode === 'smoke') return [...WINDOWS_SMOKE_TEST_FILES];
  if (mode !== 'shard') throw new Error(`unknown mode '${mode}'; expected smoke or shard`);
  if (!Number.isInteger(shardNumber) || shardNumber < 1 || shardNumber > shardCount) {
    throw new Error(`shard number must be between 1 and ${shardCount}`);
  }
  const smoke = new Set(WINDOWS_SMOKE_TEST_FILES);
  const files = (await listTestFiles()).filter((file) => !smoke.has(file));
  const bins = await balancedShards(files, shardCount, await loadDurations());
  return bins[shardNumber - 1].files;
}

async function main() {
  const argv = process.argv.slice(2);
  const mode = argv.shift();
  let shardNumber = 1;
  let shardCount = 1;
  if (mode === 'shard') {
    shardNumber = Number(argv.shift());
    shardCount = Number(argv.shift());
  }
  if (argv[0] === '--') argv.shift();
  const files = await selectCiTests(mode, shardNumber, shardCount);
  if (files.length === 0) throw new Error('selected CI test set is empty');
  const vitest = join(ROOT, 'node_modules', 'vitest', 'vitest.mjs');
  const result = spawnSync(process.execPath, [vitest, 'run', ...files, ...argv], {
    cwd: ROOT,
    stdio: 'inherit',
  });
  if (result.error) throw result.error;
  process.exitCode = result.status ?? 1;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) await main();
