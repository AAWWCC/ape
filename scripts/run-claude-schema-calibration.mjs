#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const vitest = join(root, 'node_modules', 'vitest', 'vitest.mjs');
const result = spawnSync(process.execPath, [
  vitest,
  'run',
  '__tests__/runtime-v2-gates-plugin-parity.test.js',
  '__tests__/runtime-v2-round3-parity-hook-types.test.js',
  '--no-file-parallelism',
  ...process.argv.slice(2),
], {
  cwd: root,
  env: { ...process.env, APE_CLAUDE_SCHEMA_CALIBRATION: '1' },
  stdio: 'inherit',
});

if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
