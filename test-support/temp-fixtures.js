// Shared, TESTED resource-handling primitives extracted out of two
// merge-gate-flaking test fixtures (roadmap entries mcp-interleaving-temp-
// dir-race and gate-sweep-test-fd-pressure). Neither defect lives in
// `lib/runtime/` — both are test-fixture teardown/setup races — so this
// module is deliberately test-support code, imported only by `__tests__/**`
// files, never by anything under `bin/`. See
// `__tests__/runtime-v2-temp-fixtures.test.js` for the authoritative
// behavioral contract each export below satisfies.
//
// NAMING NOTE: this directory is named `test-support/`, not `test/support/`
// or `tests/`, so it deliberately falls outside `TEST_PATH_PATTERN`
// (lib/runtime/path-scope.js) — it is production-shaped source that an
// implementer stage may write, even though every one of its callers is a
// test file.

import { rm } from 'node:fs/promises';

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Apply `fn` to every item in `items`, resolving to the results in INPUT
 * order regardless of which call settles first. At no instant does this run
 * more than `limit` calls concurrently: a fixed-size pool of `min(limit,
 * items.length)` workers each pulls the next unclaimed index and awaits its
 * own `fn` call fully before pulling another, so peak in-flight calls is
 * bounded by construction, not by luck. Rejects as soon as any `fn` call
 * rejects (via `Promise.all` over the worker pool).
 */
export async function mapBounded(items, fn, limit) {
  if (!Number.isFinite(limit) || limit <= 0) {
    throw new TypeError(`mapBounded: limit must be a finite positive number, got ${limit}`);
  }
  const list = Array.from(items);
  const results = new Array(list.length);
  if (list.length === 0) return results;
  const workerCount = Math.max(1, Math.min(limit, list.length));
  let nextIndex = 0;
  async function worker() {
    for (;;) {
      const index = nextIndex;
      nextIndex += 1;
      if (index >= list.length) return;
      results[index] = await fn(list[index]);
    }
  }
  await Promise.all(Array.from({ length: workerCount }, () => worker()));
  return results;
}

// How long killAndWait waits for a signalled child to exit on its own before
// escalating to SIGKILL. Long enough to never race a well-behaved handler's
// graceful shutdown, short enough that a genuinely ignoring child is reaped
// promptly rather than wedging a caller's teardown.
const ESCALATE_AFTER_MS = 3_000;

/**
 * Send `signal` to `child` and resolve only once the child has ACTUALLY
 * exited (its `exit` event has fired), never merely after the signal is
 * sent — so no caller can touch the child's files while it may still be
 * alive. Resolves promptly if the child has already exited. If the child
 * ignores the signal, escalates to SIGKILL after a bounded wait so this
 * never hangs forever.
 */
export function killAndWait(child, signal) {
  return new Promise((resolve, reject) => {
    if (child.exitCode !== null || child.signalCode !== null) {
      resolve();
      return;
    }
    let settled = false;
    let escalateTimer = null;
    const finish = () => {
      if (settled) return;
      settled = true;
      if (escalateTimer) clearTimeout(escalateTimer);
      child.off('error', onError);
      resolve();
    };
    const onError = (error) => {
      if (settled) return;
      settled = true;
      if (escalateTimer) clearTimeout(escalateTimer);
      reject(error);
    };
    child.once('exit', finish);
    child.once('error', onError);
    try {
      child.kill(signal);
    } catch {
      // The child may already be gone (a race with its own exit); the
      // 'exit' listener above still resolves once node observes it, or the
      // already-exited fast path above already handled the common case.
    }
    if (signal !== 'SIGKILL') {
      escalateTimer = setTimeout(() => {
        try {
          child.kill('SIGKILL');
        } catch {
          // already gone
        }
      }, ESCALATE_AFTER_MS);
      escalateTimer.unref?.();
    }
  });
}

const REMOVE_TREE_MAX_ATTEMPTS = 6;
const REMOVE_TREE_RETRY_DELAY_MS = 25;

// The enumerable option set `removeTreeWithRetry` accepts, one entry per
// name: its default and an eager validator that must hold before ANY real
// filesystem call, mirroring maxAttempts' own pre-existing eager guard.
// readOptions() below is the ONLY code path that reads a caller's `options`
// object, so a new option added to this spec without a matching validator
// entry fails the spec itself rather than silently reaching raw, unguarded
// use (the gap retryDelayMs used to leave open, reaching sleep()/setTimeout
// with no validation at all: setTimeout coerces a NaN or negative delay to a
// silently-wrong ~1ms retry cadence rather than refusing it).
const REMOVE_TREE_OPTION_SPEC = {
  maxAttempts: {
    default: REMOVE_TREE_MAX_ATTEMPTS,
    valid: (value) => Number.isInteger(value) && value > 0,
    describe: (value) => `maxAttempts must be a positive integer, got ${value}`,
  },
  retryDelayMs: {
    default: REMOVE_TREE_RETRY_DELAY_MS,
    valid: (value) => Number.isFinite(value) && value >= 0,
    describe: (value) => `retryDelayMs must be a finite, non-negative number, got ${value}`,
  },
};

/**
 * Validate `options` against `spec` and return the resolved values (defaults
 * filled in), throwing a `TypeError` naming the offending value on the first
 * entry that fails its own validator. The sole reader of an options object
 * anywhere in this module: a caller-supplied value structurally cannot reach
 * a function's real work without first passing through here.
 */
function readOptions(fnName, spec, options) {
  const resolved = {};
  for (const [name, { default: fallback, valid, describe }] of Object.entries(spec)) {
    const value = options[name] ?? fallback;
    if (!valid(value)) throw new TypeError(`${fnName}: ${describe(value)}`);
    resolved[name] = value;
  }
  return resolved;
}

/**
 * Remove `dir` recursively, tolerating and retrying a bounded number of
 * times on ENOTEMPTY (a concurrently-dying writer recreating an entry mid-
 * walk) and ENOENT (the target — or a component of it — vanishing under a
 * concurrent remover), including a target that is already fully gone
 * (idempotent, mirroring the `rmSync({ force: true })` call sites this
 * replaces). Throws whatever the last attempt raised if it still cannot
 * remove the tree after its bounded attempts, so a genuine leak is never
 * silently hidden.
 */
export async function removeTreeWithRetry(dir, options = {}) {
  const { maxAttempts, retryDelayMs } = readOptions('removeTreeWithRetry', REMOVE_TREE_OPTION_SPEC, options);
  let lastError;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      await rm(dir, { recursive: true, force: true });
      return;
    } catch (error) {
      if (error?.code !== 'ENOTEMPTY' && error?.code !== 'ENOENT') throw error;
      lastError = error;
      if (attempt < maxAttempts) await sleep(retryDelayMs);
    }
  }
  throw lastError;
}
