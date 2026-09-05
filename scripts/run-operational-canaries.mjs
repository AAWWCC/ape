#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const CORPUS = path.join(ROOT, 'evals', 'operational-replay-corpus.json');
const TEST = '__tests__/runtime-v2-operational-replay.test.js';
const BASELINE_TESTS = Object.freeze([
  '__tests__/runtime-v2-binding-probe.test.js',
  '__tests__/runtime-v2-codex-binding-seam.test.js',
  '__tests__/runtime-v2-history-explain.test.js',
]);

function fail(message) {
  process.stderr.write(`operational-canary: ${message}\n`);
  process.exit(1);
}

let corpus;
try {
  corpus = JSON.parse(readFileSync(CORPUS, 'utf8'));
} catch (error) {
  fail(`cannot read replay corpus: ${error?.message ?? String(error)}`);
}

if (corpus?.schema_version !== 1 || !Array.isArray(corpus.cases) || corpus.cases.length === 0) {
  fail('replay corpus must use schema_version 1 and contain at least one case');
}

const requiredKeys = [
  'id',
  'category',
  'observed_failure',
  'recovery_contract',
  'test_file',
  'test_anchor',
];
const ids = new Set();
const coverageTests = new Set();
for (const entry of corpus.cases) {
  for (const key of requiredKeys) {
    if (typeof entry?.[key] !== 'string' || entry[key].trim().length === 0) {
      fail(`replay case ${entry?.id ?? '<missing-id>'} requires non-empty ${key}`);
    }
  }
  if (ids.has(entry.id)) fail(`duplicate replay case id: ${entry.id}`);
  ids.add(entry.id);

  if (!/^__tests__\/runtime-v2-[a-z0-9-]+\.test\.js$/.test(entry.test_file)) {
    fail(`replay case ${entry.id} carries an unsafe or non-runtime test_file`);
  }
  const testPath = path.join(ROOT, entry.test_file);
  let source;
  try {
    source = readFileSync(testPath, 'utf8');
  } catch (error) {
    fail(`replay case ${entry.id} cannot read ${entry.test_file}: ${error?.message ?? String(error)}`);
  }
  const executableAnchor = ["it", "test", "describe"].some((declaration) =>
    source.includes(`${declaration}('${entry.test_anchor}`)
    || source.includes(`${declaration}(\"${entry.test_anchor}`));
  if (!executableAnchor) {
    fail(`replay case ${entry.id} executable anchor is absent from ${entry.test_file}`);
  }
  coverageTests.add(entry.test_file);
}

const expected = new Set([
  'codex-dispatch-envelope',
  'plan-directed-replan',
  'test-contradiction-verification',
  'stable-review-finding-identity',
  'actionable-scope-denial',
  'protected-branch-shipping',
  'nonbehavioral-test-stage-omission',
  'versioned-terminal-diagnostics',
  'omitted-preflight-audit-reason',
  'native-bootstrap-phase-and-catalog-contract',
  'native-probe-failure-reporting',
  'native-canary-identity-isolation',
  'compiled-future-stage-contract',
  'reviewed-admission-drift',
  'scheduled-base-command-prerequisites',
  'admissible-receipt-rejection-guidance',
  'frozen-shipping-and-tested-tree',
  'current-command-prerequisites',
  'branch-exact-scheduler-review-checks',
  'supersession-prelock-admission',
  'codex-model-input-response-framing',
]);
for (const id of expected) {
  if (!ids.has(id)) fail(`replay corpus is missing required case: ${id}`);
}

const vitest = path.join(ROOT, 'node_modules', 'vitest', 'vitest.mjs');
const selectedTests = [...new Set([TEST, ...BASELINE_TESTS, ...coverageTests])];
const result = spawnSync(process.execPath, [
  vitest,
  'run',
  '--maxWorkers=3',
  ...selectedTests,
], {
  cwd: ROOT,
  stdio: 'inherit',
});
if (result.error) fail(result.error.message);
process.exitCode = result.status ?? 1;
