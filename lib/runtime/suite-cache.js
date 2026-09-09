import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { atomicWriteJson } from './storage.js';

export const SUITE_CACHE_MAX_ENTRIES = 256;
export const SUITE_CACHE_MAX_BYTES = 512 * 1024;
// Bounded migration allowance for old caches containing complete test output.
// Larger legacy files become safe misses without loading them into memory.
export const SUITE_CACHE_READ_MAX_BYTES = 8 * 1024 * 1024;

const emptyCache = () => ({ schema_version: '2.0.0', results: {} });
const boundedString = (value, max) => typeof value === 'string' && Buffer.byteLength(value) <= max;

function compactResult(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || typeof value.passed !== 'boolean') return null;
  const observed = value.verification;
  if (value.passed && (observed?.passed === false || observed?.tooling_failure === true ||
      observed?.timed_out === true || observed?.aborted === true ||
      (Number.isFinite(observed?.exit_code) && observed.exit_code !== 0))) return null;
  if (!boundedString(value.result_hash, 256)) return null;
  const result = { passed: value.passed, result_hash: value.result_hash };
  for (const [field, max] of [['tree_sha', 64], ['command', 8192], ['recorded_at', 64], ['executed_at', 64]]) {
    if (boundedString(value[field], max) || (field === 'command' && value[field] === null)) result[field] = value[field];
  }
  if (observed && typeof observed === 'object') {
    // Preserve failure classification for same-tree flake evidence; output and
    // runner descriptors are not needed to serve a pass or annotate a failure.
    result.verification = {};
    for (const field of ['passed', 'tooling_failure', 'timed_out', 'aborted']) {
      if (typeof observed[field] === 'boolean') result.verification[field] = observed[field];
    }
    for (const field of ['exit_code', 'duration_ms']) {
      if (Number.isFinite(observed[field])) result.verification[field] = observed[field];
    }
  }
  return result;
}

export function compactSuiteCache(value) {
  const cache = emptyCache();
  if (!value?.results || typeof value.results !== 'object' || Array.isArray(value.results)) return cache;
  const entries = Object.entries(value.results).flatMap(([key, value], index) => {
    if (!boundedString(key, 256) || ['__proto__', 'constructor', 'prototype'].includes(key)) return [];
    const result = compactResult(value);
    return result ? [{ key, result, index, timestamp: Date.parse(result.recorded_at ?? result.executed_at ?? '') || 0 }] : [];
  }).sort((a, b) => b.timestamp - a.timestamp || b.index - a.index);
  for (const { key, result } of entries) {
    if (Object.keys(cache.results).length >= SUITE_CACHE_MAX_ENTRIES) break;
    cache.results[key] = result;
    if (Buffer.byteLength(JSON.stringify(cache, null, 2)) + 1 > SUITE_CACHE_MAX_BYTES) delete cache.results[key];
  }
  return cache;
}

export async function writeSuiteCache(file, value) {
  const cache = compactSuiteCache(value);
  // Cache persistence is an optimization. Failure causes a rerun, never a
  // fabricated pass or a failure of otherwise valid gate evidence.
  await atomicWriteJson(file, cache).catch(() => {});
  return cache;
}

export async function readSuiteCache(file) {
  let handle;
  try {
    handle = await open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
    const metadata = await handle.stat();
    if (!metadata.isFile() || metadata.size > SUITE_CACHE_READ_MAX_BYTES) return emptyCache();
    const buffer = Buffer.alloc(Number(metadata.size) + 1);
    let offset = 0;
    while (offset < buffer.length) {
      const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, offset);
      if (!bytesRead) break;
      offset += bytesRead;
    }
    if (offset !== metadata.size) return emptyCache();
    const bytes = buffer.subarray(0, offset).toString('utf8');
    const cache = compactSuiteCache(JSON.parse(bytes));
    // Retire raw output and old entries once, so subsequent watch polls only
    // read the bounded representation. Oversized files above stay safe misses.
    if (bytes !== `${JSON.stringify(cache, null, 2)}\n`) await writeSuiteCache(file, cache);
    return cache;
  } catch {
    return emptyCache();
  } finally {
    await handle?.close();
  }
}
