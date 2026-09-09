#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { realpath } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const VERSION = '2.25.8';
const TAG = `v${VERSION}`;
const SOURCE = '2b902080bd6842adb185c3d17d68f323875f3859';
const RECORD_PATH = 'evals/release-owner-exception-2.25.8.json';
const RECORD_SHA256 = 'c822a2ad75fd222d958e2c088f0b8e8400d001bbac2bca13fe7512506f6f9ea2';
const INVENTORY_SHA256 = '79dafcbd0fc68911ea5f6629d1f7b6e6a6d9292b5acf6acf448bea928f95c002';
const HASH = /^[0-9a-f]{40}$/u;
const MAX_RECORD_BYTES = 64 * 1024;
const RELEASE_ONLY_PATHS = Object.freeze([
  '.github/workflows/release.yml',
  'CHANGELOG.md',
  'README.md',
  '__tests__/runtime-v2-live-certification-gate.test.js',
  'docs/operational-readiness.md',
  'docs/prevention-release-status.md',
  'docs/releases/2.25.8.md',
  RECORD_PATH,
  'scripts/verify-release-owner-exception.mjs',
]);

export class ReleaseOwnerExceptionError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ReleaseOwnerExceptionError';
  }
}

function reject(message) {
  throw new ReleaseOwnerExceptionError(message);
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

// Preserve Git's order, modes, object types, object identities, and exact paths.
// Only these nine publication paths can differ from the tested source.
export function protectedSourceInventorySha256(rawInventory) {
  if (!Buffer.isBuffer(rawInventory) || rawInventory.length === 0
      || rawInventory.at(-1) !== 0) reject('source inventory must be a NUL-terminated Git inventory');
  const inventoryText = rawInventory.toString('utf8');
  if (!Buffer.from(inventoryText, 'utf8').equals(rawInventory)) reject('source inventory is not valid UTF-8');
  const entries = inventoryText.split('\0');
  entries.pop();
  const protectedEntries = [];
  for (const entry of entries) {
    const match = /^([0-7]{6}) (blob|commit) ([0-9a-f]{40})\t([\s\S]+)$/u.exec(entry);
    if (!match) reject('source inventory has an invalid Git entry');
    if (!RELEASE_ONLY_PATHS.includes(match[4])) protectedEntries.push(entry);
  }
  return sha256(Buffer.from(`${protectedEntries.join('\0')}\0`, 'utf8'));
}

export function validateReleaseOwnerExceptionRecord(rawRecord) {
  if (!Buffer.isBuffer(rawRecord) || rawRecord.length === 0 || rawRecord.length > MAX_RECORD_BYTES) {
    reject('committed exception record exceeds its size limit or is empty');
  }
  if (sha256(rawRecord) !== RECORD_SHA256) reject('committed exception record does not match its authorized digest');
  let document;
  try { document = JSON.parse(rawRecord.toString('utf8')); }
  catch { reject('committed exception record is invalid JSON'); }
  if (document?.schema_version !== 1
      || document.record_type !== 'owner_authorized_release_exception'
      || document.version !== VERSION || document.tag !== TAG
      || document.tested_source_commit !== SOURCE
      || document.protected_source_inventory_sha256 !== INVENTORY_SHA256
      || JSON.stringify(document.release_only_paths) !== JSON.stringify(RELEASE_ONLY_PATHS)
      || document.strict_v5_uninterrupted_first_pass_qualified !== false
      || document.functional_campaign_complete !== true) {
    reject('committed exception record does not describe the exact authorized release');
  }
  return document;
}

export function validateReleaseOwnerExceptionProof({
  head, checkedOutHead, tag, tagType, tagCommit, packageVersion, rawRecord, inventorySha256,
}) {
  if (typeof head !== 'string' || !HASH.test(head)) reject('release head must be a full lowercase commit hash');
  if (checkedOutHead !== head) reject('release tag commit must be the checked-out HEAD');
  if (tag !== TAG) reject(`owner exception is authorized only for ${TAG}`);
  if (tagType !== 'tag') reject('release tag must be annotated');
  if (tagCommit !== head) reject('release tag does not point to the release head');
  if (packageVersion !== VERSION) reject(`tagged package.json version must be ${VERSION}`);
  validateReleaseOwnerExceptionRecord(rawRecord);
  if (inventorySha256 !== INVENTORY_SHA256) reject('protected source inventory differs from the tested product');
  return {
    version: VERSION,
    source_commit: SOURCE,
    authorization: 'owner_authorized_release_exception',
    strict_v5_uninterrupted_first_pass_qualified: false,
  };
}

function git(repo, args, label, maxBuffer = 4 * 1024 * 1024) {
  const result = spawnSync('git', ['-C', repo, ...args], {
    maxBuffer,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, GIT_NO_REPLACE_OBJECTS: '1' },
  });
  if (result.error || result.status !== 0) reject(`git could not ${label}`);
  return result.stdout;
}

export function verifyReleaseOwnerExceptionRepository({ repo = ROOT, head, tag }) {
  if (typeof head !== 'string' || !HASH.test(head)) reject('release head must be a full lowercase commit hash');
  if (tag !== TAG) reject(`owner exception is authorized only for ${TAG}`);
  const text = (args, label) => git(repo, args, label).toString('utf8').trim();
  const checkedOutHead = text(['rev-parse', '--verify', 'HEAD^{commit}'], 'resolve the checked-out head');
  if (checkedOutHead !== head) reject('release tag commit must be the checked-out HEAD');
  const tagRef = `refs/tags/${TAG}`;
  const tagType = text(['cat-file', '-t', tagRef], 'read the annotated release tag');
  if (tagType !== 'tag') reject('release tag must be annotated');
  const tagCommit = text(['rev-parse', '--verify', `${tagRef}^{commit}`], 'resolve the release tag');
  if (tagCommit !== head) reject('release tag does not point to the release head');
  const recordEntry = text(['ls-tree', head, '--', RECORD_PATH], 'inspect the exception record mode');
  if (!/^100644 blob [0-9a-f]{40}\tevals\/release-owner-exception-2\.25\.8\.json$/u.test(recordEntry)) {
    reject('committed exception record must be a regular non-executable file');
  }
  const recordSize = text(['cat-file', '-s', `${head}:${RECORD_PATH}`], 'inspect the exception record size');
  if (!/^[1-9][0-9]*$/u.test(recordSize) || Number(recordSize) > MAX_RECORD_BYTES) {
    reject('committed exception record exceeds its size limit or is empty');
  }
  const rawRecord = git(repo, ['show', `${head}:${RECORD_PATH}`], 'read the committed exception record', MAX_RECORD_BYTES);
  validateReleaseOwnerExceptionRecord(rawRecord);
  let packageVersion;
  try {
    packageVersion = JSON.parse(git(repo, ['show', `${head}:package.json`], 'read tagged package.json', MAX_RECORD_BYTES).toString('utf8'))?.version;
  } catch (error) {
    if (error instanceof ReleaseOwnerExceptionError) throw error;
    reject('tagged package.json is invalid JSON');
  }
  const inventorySha256 = protectedSourceInventorySha256(
    git(repo, ['ls-tree', '-r', '-z', '--full-tree', head], 'inspect the complete tagged source inventory'),
  );
  return validateReleaseOwnerExceptionProof({
    head, checkedOutHead, tag, tagType, tagCommit, packageVersion, rawRecord, inventorySha256,
  });
}

function parseArgs(argv) {
  /** @type {{ repo?: string, head?: string, tag?: string }} */
  const options = {};
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    if (!['--repo', '--head', '--tag'].includes(flag) || !argv[index + 1]
        || argv[index + 1].startsWith('--') || Object.hasOwn(options, flag.slice(2))) {
      reject('usage: verify-release-owner-exception [--repo PATH] --head SHA --tag v2.25.8');
    }
    options[flag.slice(2)] = argv[index + 1];
  }
  return options;
}

async function main() {
  try {
    const options = parseArgs(process.argv.slice(2));
    const result = verifyReleaseOwnerExceptionRepository({
      repo: options.repo ?? ROOT, head: options.head, tag: options.tag,
    });
    process.stdout.write(`release-owner-exception: verified owner-authorized APE ${result.version} release; not a strict schema-v5 first-pass certificate\n`);
  } catch (error) {
    const message = error instanceof ReleaseOwnerExceptionError ? error.message : 'unexpected verifier failure';
    process.stderr.write(`release-owner-exception: ${message}\n`);
    process.exitCode = 1;
  }
}

const invokedDirectly = typeof process.argv[1] === 'string'
  && await realpath(process.argv[1]).catch(() => null) === await realpath(fileURLToPath(import.meta.url));
if (invokedDirectly) await main();
