#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
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

if (corpus?.schema_version !== 2 || !Array.isArray(corpus.cases) || corpus.cases.length === 0) {
  fail('replay corpus must use schema_version 2 and contain at least one case');
}

const requiredKeys = [
  'id',
  'category',
  'observed_failure',
  'recovery_contract',
  'test_file',
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
  if (!Array.isArray(entry.test_names) || entry.test_names.length === 0
    || entry.test_names.some((name) => typeof name !== 'string' || !name || name.trim() !== name)
    || new Set(entry.test_names).size !== entry.test_names.length) {
    fail(`replay case ${entry.id} requires a nonempty unique test_names inventory of exact leaf identities`);
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
  'post-build-test-correction',
  'override-abort-terminal-reason',
]);
for (const id of expected) {
  if (!ids.has(id)) fail(`replay corpus is missing required case: ${id}`);
}

const vitest = path.join(ROOT, 'node_modules', 'vitest', 'vitest.mjs');
const selectedTests = [...new Set([TEST, ...BASELINE_TESTS, ...coverageTests])];
// A fresh private directory binds evidence to this invocation, including concurrent
// invocations and retries after a child crash. Never consume a prior report.
const reportDirectory = mkdtempSync(path.join(tmpdir(), 'ape-operational-canary-'));
let failure;
try {
  const reportFile = path.join(reportDirectory, 'results.json');
  const result = spawnSync(process.execPath, [
    vitest, 'run', '--maxWorkers=3', '--reporter=default', '--reporter=json',
    `--outputFile.json=${reportFile}`, ...selectedTests,
  ], { cwd: ROOT, stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`runner failed (${result.signal ?? result.status ?? 'unknown exit'})`);
  const report = JSON.parse(readFileSync(reportFile, 'utf8'));
  if (!Array.isArray(report?.testResults)) throw new Error('missing structured testResults');
  // Check identities before aggregate counters so missing/skipped diagnostics name
  // the exact requirement even when the rest of the run is green.
  for (const entry of corpus.cases) {
    const files = report.testResults.filter((file) => file.name === path.join(ROOT, entry.test_file));
    for (const name of entry.test_names) {
      const label = `replay case ${entry.id}: ${entry.test_file} :: ${name}`;
      if (files.length !== 1 || !Array.isArray(files[0].assertionResults)) {
        throw new Error(`${label} missing or incomplete file execution evidence`);
      }
      const assertions = files[0].assertionResults.filter((assertion) => assertion.fullName === name);
      if (assertions.length !== 1) throw new Error(`${label} missing or ambiguous test execution evidence`);
      if (assertions[0].status !== 'passed') {
        throw new Error(`${label} not passed (${assertions[0].status ?? 'missing status'}; skipped/pending cases do not execute)`);
      }
    }
  }
  for (const file of selectedTests) {
    const results = report.testResults.filter((result) => result.name === path.join(ROOT, file));
    if (results.length !== 1 || results[0].status !== 'passed'
      || !Array.isArray(results[0].assertionResults) || results[0].assertionResults.length === 0) {
      throw new Error(`missing, incomplete or failed report for ${file}`);
    }
  }
  const assertions = report.testResults.flatMap((file) => file.assertionResults ?? []);
  if (report.success !== true || report.numFailedTests !== 0 || report.numFailedTestSuites !== 0
    || !Number.isInteger(report.numTotalTests) || report.numTotalTests !== assertions.length
    || !Number.isInteger(report.numPassedTests) || report.numPassedTests <= 0
    || report.numPassedTests !== assertions.filter((assertion) => assertion.status === 'passed').length
    || assertions.some((assertion) => !['passed', 'pending', 'todo', 'skipped'].includes(assertion.status))) {
    throw new Error('incomplete or failed structured runner report');
  }
  process.stdout.write(`operational-canary: all ${corpus.cases.reduce((total, entry) => total + entry.test_names.length, 0)} required identities executed and passed\n`);
} catch (error) {
  failure = error?.message ?? String(error);
} finally {
  rmSync(reportDirectory, { recursive: true, force: true });
}
if (failure) fail(failure);
