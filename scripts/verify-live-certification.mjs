#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { Buffer } from 'node:buffer';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  TERMINAL_REASON_CODES,
  TERMINAL_REASON_TAXONOMY_VERSION,
} from '../lib/runtime/terminal-telemetry.js';

export const LIVE_CERTIFICATION_SCHEMA_VERSION = 1;
export const LIVE_CERTIFICATION_PATH = 'evals/live-certification.json';
export const LIVE_CERTIFICATION_HOSTS = Object.freeze(['codex', 'claude']);
export const LIVE_CERTIFICATION_PIPELINES = Object.freeze([
  'mechanical',
  'fast',
  'full',
  'protected-branch-land',
]);

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const MAX_LEDGER_BYTES = 256 * 1024;
const MAX_ATTEMPTS = 256;
const MAX_ATTEMPTS_PER_COHORT = 32;
const REQUIRED_CONSECUTIVE_SUCCESSES = 3;
const HASH = /^[0-9a-f]{40}$/u;
const SHA256 = /^[0-9a-f]{64}$/u;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/u;
const SAFE_VERSION = /^[A-Za-z0-9][A-Za-z0-9.+_-]{0,63}$/u;
const TERMINAL_REASON_CODE_SET = new Set(TERMINAL_REASON_CODES);
const ROOT_KEYS = Object.freeze([
  'schema_version',
  'ape_version',
  'source_commit',
  'terminal_reason_taxonomy_version',
  'attempts',
]);
const ATTEMPT_KEYS = Object.freeze([
  'sequence',
  'attempt_id',
  'host',
  'host_version',
  'plugin_version',
  'pipeline',
  'source_commit',
  'run_record_sha256',
  'ticket_count',
  'duration_ms',
  'outcome',
  'terminal_reason_code',
  'manual_intervention',
  'prompt_assembly_failure',
  'receipt_repair',
  'duplicate_dispatch',
  'abort_successor',
  'protected_land',
]);
const LAND_PROOF_KEYS = Object.freeze([
  'target_branch',
  'merge_method',
  'auto_merge_required',
  'pr_state',
  'pushed_head_commit',
  'observed_merged_pr_head',
  'merge_commit',
  'remote_head_after_merge',
]);
const CLEAN_RUN_FLAGS = Object.freeze([
  'manual_intervention',
  'prompt_assembly_failure',
  'receipt_repair',
  'duplicate_dispatch',
  'abort_successor',
]);

export class LiveCertificationError extends Error {
  constructor(message) {
    super(message);
    this.name = 'LiveCertificationError';
  }
}

function reject(message) {
  throw new LiveCertificationError(message);
}

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function requireExactKeys(value, expected, label) {
  if (!isObject(value)) reject(`${label} must be an object`);
  const actual = Object.keys(value).sort();
  const required = [...expected].sort();
  if (actual.length !== required.length || actual.some((key, index) => key !== required[index])) {
    reject(`${label} has missing or unsupported fields`);
  }
}

function requireHash(value, label) {
  if (typeof value !== 'string' || !HASH.test(value)) reject(`${label} must be a full lowercase commit hash`);
}

function requireBoolean(value, label) {
  if (typeof value !== 'boolean') reject(`${label} must be boolean`);
}

function requireBoundedInteger(value, minimum, maximum, label) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    reject(`${label} is outside its allowed integer range`);
  }
}

function validateLandProof(value, attemptNumber) {
  requireExactKeys(value, LAND_PROOF_KEYS, `attempt ${attemptNumber} protected_land`);
  if (value.target_branch !== 'main') {
    reject(`attempt ${attemptNumber} protected land must target the disposable main branch`);
  }
  if (
    value.merge_method !== 'squash'
    || value.auto_merge_required !== true
    || value.pr_state !== 'MERGED'
  ) reject(`attempt ${attemptNumber} protected land did not use the required protected auto-merge path`);
  for (const key of [
    'pushed_head_commit',
    'observed_merged_pr_head',
    'merge_commit',
    'remote_head_after_merge',
  ]) requireHash(value[key], `attempt ${attemptNumber} protected_land.${key}`);
  if (value.observed_merged_pr_head !== value.pushed_head_commit) {
    reject(`attempt ${attemptNumber} protected land did not merge the exact pushed head`);
  }
  if (
    value.merge_commit === value.pushed_head_commit
    || value.remote_head_after_merge !== value.merge_commit
  ) reject(`attempt ${attemptNumber} protected land proof is internally inconsistent`);
}

function cleanCompletedAttempt(attempt) {
  return attempt.outcome === 'success'
    && attempt.terminal_reason_code === 'completed'
    && CLEAN_RUN_FLAGS.every((key) => attempt[key] === false)
    && (attempt.pipeline !== 'protected-branch-land' || isObject(attempt.protected_land));
}

export function parseLiveCertificationJson(raw) {
  if (typeof raw !== 'string' || raw.length === 0) reject('certification ledger is empty');
  if (Buffer.byteLength(raw, 'utf8') > MAX_LEDGER_BYTES) reject('certification ledger exceeds the size limit');
  let document;
  try {
    document = JSON.parse(raw);
  } catch {
    reject('certification ledger is not valid JSON');
  }
  if (`${JSON.stringify(document, null, 2)}\n` !== raw) {
    reject('certification ledger must use canonical two-space JSON with one trailing newline');
  }
  return document;
}

export function validateLiveCertificationDocument(document, {
  packageVersion,
  sourceCommit,
  hostVersions,
}) {
  requireExactKeys(document, ROOT_KEYS, 'certification ledger');
  if (document.schema_version !== LIVE_CERTIFICATION_SCHEMA_VERSION) {
    reject('certification schema version is unsupported');
  }
  if (document.terminal_reason_taxonomy_version !== TERMINAL_REASON_TAXONOMY_VERSION) {
    reject('terminal reason taxonomy version is unsupported');
  }
  if (typeof packageVersion !== 'string' || document.ape_version !== packageVersion) {
    reject('certification version does not match package.json');
  }
  requireHash(sourceCommit, 'source commit');
  if (document.source_commit !== sourceCommit) {
    reject('certification source commit is not the certification commit parent');
  }
  if (!isObject(hostVersions)) reject('supported host versions are unavailable');
  for (const host of LIVE_CERTIFICATION_HOSTS) {
    if (typeof hostVersions[host] !== 'string' || !SAFE_VERSION.test(hostVersions[host])) {
      reject('supported host versions are invalid');
    }
  }
  if (
    !Array.isArray(document.attempts)
    || document.attempts.length < LIVE_CERTIFICATION_HOSTS.length
      * LIVE_CERTIFICATION_PIPELINES.length
      * REQUIRED_CONSECUTIVE_SUCCESSES
    || document.attempts.length > MAX_ATTEMPTS
  ) reject('certification attempts are missing or outside the bounded ledger size');

  const ids = new Set();
  const runRecordDigests = new Set();
  const cohorts = new Map();
  for (let index = 0; index < document.attempts.length; index += 1) {
    const attemptNumber = index + 1;
    const attempt = document.attempts[index];
    requireExactKeys(attempt, ATTEMPT_KEYS, `attempt ${attemptNumber}`);
    if (attempt.sequence !== attemptNumber) {
      reject(`attempt ${attemptNumber} sequence must preserve complete raw ordering`);
    }
    if (typeof attempt.attempt_id !== 'string' || !SAFE_ID.test(attempt.attempt_id)) {
      reject(`attempt ${attemptNumber} has an unsafe attempt identifier`);
    }
    if (ids.has(attempt.attempt_id)) reject(`attempt ${attemptNumber} duplicates an attempt identifier`);
    ids.add(attempt.attempt_id);
    if (!LIVE_CERTIFICATION_HOSTS.includes(attempt.host)) reject(`attempt ${attemptNumber} has an unsupported host`);
    if (!LIVE_CERTIFICATION_PIPELINES.includes(attempt.pipeline)) {
      reject(`attempt ${attemptNumber} has an unsupported pipeline`);
    }
    if (attempt.host_version !== hostVersions[attempt.host]) {
      reject(`attempt ${attemptNumber} host version does not match compatibility.json`);
    }
    if (attempt.plugin_version !== packageVersion) {
      reject(`attempt ${attemptNumber} plugin version does not match package.json`);
    }
    if (attempt.source_commit !== sourceCommit) {
      reject(`attempt ${attemptNumber} did not test the certification source commit`);
    }
    if (typeof attempt.run_record_sha256 !== 'string' || !SHA256.test(attempt.run_record_sha256)) {
      reject(`attempt ${attemptNumber} has an invalid archived run-record digest`);
    }
    if (runRecordDigests.has(attempt.run_record_sha256)) {
      reject(`attempt ${attemptNumber} reuses an archived run-record digest`);
    }
    runRecordDigests.add(attempt.run_record_sha256);
    requireBoundedInteger(attempt.ticket_count, 1, 10_000, `attempt ${attemptNumber} ticket_count`);
    requireBoundedInteger(attempt.duration_ms, 1, 86_400_000, `attempt ${attemptNumber} duration_ms`);
    if (!['success', 'failure'].includes(attempt.outcome)) reject(`attempt ${attemptNumber} has an unsupported outcome`);
    if (!TERMINAL_REASON_CODE_SET.has(attempt.terminal_reason_code)) {
      reject(`attempt ${attemptNumber} has an unsupported terminal reason code`);
    }
    if ((attempt.outcome === 'success') !== (attempt.terminal_reason_code === 'completed')) {
      reject(`attempt ${attemptNumber} outcome and terminal reason code disagree`);
    }
    for (const key of CLEAN_RUN_FLAGS) requireBoolean(attempt[key], `attempt ${attemptNumber} ${key}`);

    if (attempt.pipeline === 'protected-branch-land' && attempt.outcome === 'success') {
      validateLandProof(attempt.protected_land, attemptNumber);
    } else if (attempt.protected_land !== null) {
      reject(`attempt ${attemptNumber} must not carry a protected land proof`);
    }

    const cohortKey = `${attempt.host}/${attempt.pipeline}`;
    const cohort = cohorts.get(cohortKey) ?? [];
    cohort.push(attempt);
    if (cohort.length > MAX_ATTEMPTS_PER_COHORT) reject(`cohort ${cohortKey} exceeds the raw-attempt limit`);
    cohorts.set(cohortKey, cohort);
  }

  for (const host of LIVE_CERTIFICATION_HOSTS) {
    for (const pipeline of LIVE_CERTIFICATION_PIPELINES) {
      const cohortKey = `${host}/${pipeline}`;
      const cohort = cohorts.get(cohortKey) ?? [];
      if (cohort.length < REQUIRED_CONSECUTIVE_SUCCESSES) {
        reject(`cohort ${cohortKey} has fewer than three raw attempts`);
      }
      const latest = cohort.slice(-REQUIRED_CONSECUTIVE_SUCCESSES);
      if (latest.some((attempt) => !cleanCompletedAttempt(attempt))) {
        reject(`cohort ${cohortKey} does not end with three clean completed attempts`);
      }
    }
  }

  return {
    version: document.ape_version,
    attempt_count: document.attempts.length,
    cohort_count: cohorts.size,
  };
}

function git(repo, args, label) {
  const result = spawnSync('git', ['-C', repo, ...args], {
    encoding: 'utf8',
    maxBuffer: 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (result.error || result.status !== 0) reject(`git could not ${label}`);
  return result.stdout;
}

function parsePackageVersion(raw) {
  let manifest;
  try {
    manifest = JSON.parse(raw);
  } catch {
    reject('tagged package.json is invalid');
  }
  if (!isObject(manifest) || typeof manifest.version !== 'string' || !SAFE_VERSION.test(manifest.version)) {
    reject('tagged package.json has an invalid version');
  }
  return manifest.version;
}

function parseHostVersions(raw) {
  let compatibility;
  try {
    compatibility = JSON.parse(raw);
  } catch {
    reject('tagged compatibility.json is invalid');
  }
  if (!isObject(compatibility) || compatibility.version !== 1 || !isObject(compatibility.hosts)) {
    reject('tagged compatibility.json has an unsupported shape');
  }
  const hostVersions = {};
  for (const host of LIVE_CERTIFICATION_HOSTS) {
    const version = compatibility.hosts[host]?.version;
    if (typeof version !== 'string' || !SAFE_VERSION.test(version)) {
      reject('tagged compatibility.json has an invalid host version');
    }
    hostVersions[host] = version;
  }
  return hostVersions;
}

export function verifyLiveCertificationRepository({ repo = ROOT, head, tag }) {
  const requestedHead = head ?? 'HEAD';
  if (requestedHead !== 'HEAD' && (typeof requestedHead !== 'string' || !HASH.test(requestedHead))) {
    reject('release head must be a full lowercase commit hash');
  }
  const resolvedHead = git(repo, ['rev-parse', '--verify', `${requestedHead}^{commit}`], 'resolve the release head').trim();
  requireHash(resolvedHead, 'resolved release head');
  const checkedOutHead = git(repo, ['rev-parse', '--verify', 'HEAD^{commit}'], 'resolve the checked-out head').trim();
  if (checkedOutHead !== resolvedHead) reject('release tag commit must be the checked-out HEAD');

  const parentLine = git(repo, ['rev-list', '--parents', '-n', '1', resolvedHead], 'inspect release ancestry').trim();
  const ancestry = parentLine.split(/\s+/u);
  if (ancestry.length !== 2 || ancestry[0] !== resolvedHead) {
    reject('release head must be a dedicated certification commit with exactly one parent');
  }
  const sourceCommit = ancestry[1];
  requireHash(sourceCommit, 'certification source parent');

  const changes = git(
    repo,
    ['diff-tree', '--no-commit-id', '--name-status', '-r', '--no-renames', sourceCommit, resolvedHead, '--'],
    'inspect the certification commit diff',
  ).trim().split(/\r?\n/u).filter(Boolean);
  if (
    changes.length !== 1
    || !/^[AM]\tevals\/live-certification\.json$/u.test(changes[0])
  ) reject('certification commit may only add or modify evals/live-certification.json');

  const ledgerEntry = git(repo, ['ls-tree', resolvedHead, '--', LIVE_CERTIFICATION_PATH], 'inspect the certification ledger blob').trim();
  if (!/^100644 blob [0-9a-f]{40}\tevals\/live-certification\.json$/u.test(ledgerEntry)) {
    reject('certification ledger must be a regular non-executable file');
  }
  const packageVersion = parsePackageVersion(
    git(repo, ['show', `${resolvedHead}:package.json`], 'read tagged package.json'),
  );
  const hostVersions = parseHostVersions(
    git(repo, ['show', `${resolvedHead}:compatibility.json`], 'read tagged compatibility.json'),
  );
  if (typeof tag !== 'string' || tag !== `v${packageVersion}`) {
    reject('release tag must exactly match the package version');
  }
  const resolvedTag = git(repo, ['rev-parse', '--verify', `refs/tags/${tag}^{commit}`], 'resolve the release tag').trim();
  if (resolvedTag !== resolvedHead) reject('release tag does not point to the certification commit');

  const document = parseLiveCertificationJson(
    git(repo, ['show', `${resolvedHead}:${LIVE_CERTIFICATION_PATH}`], 'read the certification ledger'),
  );
  return validateLiveCertificationDocument(document, { packageVersion, sourceCommit, hostVersions });
}

function parseArgs(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (!['--repo', '--head', '--tag'].includes(flag) || index + 1 >= argv.length) {
      reject('usage: verify-live-certification [--repo PATH] [--head SHA] --tag vVERSION');
    }
    const value = argv[index + 1];
    if (flag === '--repo') options.repo = path.resolve(value);
    if (flag === '--head') options.head = value;
    if (flag === '--tag') options.tag = value;
    index += 1;
  }
  return options;
}

async function main() {
  try {
    const options = parseArgs(process.argv.slice(2));
    const result = verifyLiveCertificationRepository({
      repo: options.repo ?? ROOT,
      head: options.head ?? process.env.GITHUB_SHA,
      tag: options.tag ?? (process.env.GITHUB_REF_TYPE === 'tag' ? process.env.GITHUB_REF_NAME : undefined),
    });
    process.stdout.write(
      `live-certification: verified ${result.attempt_count} raw attempts across ${result.cohort_count} cohorts for APE ${result.version}\n`,
    );
  } catch (error) {
    const message = error instanceof LiveCertificationError ? error.message : 'unexpected verifier failure';
    process.stderr.write(`live-certification: ${message}\n`);
    process.exitCode = 1;
  }
}

if (path.resolve(process.argv[1] ?? '') === fileURLToPath(import.meta.url)) await main();
