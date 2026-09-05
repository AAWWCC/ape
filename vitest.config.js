import { defineConfig } from 'vitest/config';

/**
 * Spawn-heavy quarantine (roadmap: spawn-test-parallelism-isolation). These
 * files await REAL child node processes; when the forks pool schedules them
 * concurrently the host oversubscribes and the awaited children starve past
 * testTimeout, wedging the file-parallel run. They run in the serialized
 * `spawn-serial` project below — one file at a time — and are excluded from
 * the parallel `default` project so the two projects stay a disjoint,
 * covering partition of `__tests__/**\/*.test.js`. Keep this set minimal:
 * quarantining everything forfeits the parallel win.
 */
const SPAWN_SERIAL_FILES = [
  // Proven wedgers: in the 2026-07-20 spike (run-fixture-7e7287db5e67)
  // each exceeded its testTimeout and wedged ~266s when scheduled
  // concurrently — their gate+lock+spawn integration awaits real child node
  // test-command processes on an oversubscribed host.
  '__tests__/runtime-v2-core-land-lane.test.js',
  '__tests__/runtime-v2-round3-terminal-tree.test.js',
  '__tests__/runtime-v2-risk-trigger-receipt-surfacing.test.js',
  // Cold-spawn e2e peers: every session spawns the real MCP server
  // (bin/ape-mcp.mjs) as a fresh node child that cold-imports the whole
  // runtime (~5.2s on a cold runner — see the project timeout note below),
  // the same awaited-real-child starvation profile as the wedgers.
  '__tests__/runtime-v2-mcp.test.js',
  '__tests__/runtime-v2-mcp-interleaving.test.js',
  '__tests__/runtime-v2-mcp-progress.test.js',
  // Benchmark lock tests also await cold CLI children. Keep their existing
  // deadlines out of contention with parallel workers (PR #9 shard failure).
  '__tests__/runtime-v2-benchmark.test.js',
  // Contention quarantine: this audit sweep awaits REAL children today (line
  // refs into that file) — execFileSync `git` repos (:293-299) and a real
  // `mkfifo` (:1573), and decisively its fixture's `targeted: 'node
  // tests/value.test.js'` (:661), which the RUNTIME's own red-test observation
  // spawns and awaits twice per admission on each of three walkToReview paths.
  // Starving it is not merely slow: the POSIX-only item-13 arms (:1593-1649)
  // rendezvous with an in-flight reset through a FIFO under a hard 10s
  // wall-clock deadline that THROWS on expiry (:1546-1559, armed at :1579).
  // The item-3 escalate-once arms landing in the next run (not on this base)
  // deepen that profile further: they await a grandchild that ignores SIGTERM.
  '__tests__/runtime-v2-audit-2026-07-24-nits.test.js',
];

export default defineConfig({
  test: {
    globals: true,
    testTimeout: 15000,
    hookTimeout: 20000,
    // A standalone developer run gets six workers (measured ~101s versus
    // ~162s at three workers on the 2026-08-11 audit machine). Concurrent APE
    // agents MUST use `npm run test:agent`, whose CLI override caps the same
    // complete suite at three workers and prevents N agents from multiplying
    // this process count into resource-exhaustion hangs.
    //
    // Vitest 4 pool rework: `poolOptions.{threads,forks}.max*` was removed;
    // the single top-level `maxWorkers` caps whichever pool is active (v4's
    // default pool is `forks`, which also avoids the threads-pool RPC path
    // implicated in the Windows onTaskUpdate timeout flake).
    maxWorkers: 6,
    /**
     * Two projects partition `__tests__/**\/*.test.js` exactly: `default`
     * keeps file-parallel semantics for the bulk of the suite, and the
     * contention-isolated `spawn-serial` project (the one this array's shape
     * was kept for) runs the SPAWN_SERIAL_FILES one at a time. Every test
     * file runs in exactly one project — `default` excludes precisely the
     * `spawn-serial` include list, so nothing runs twice or is dropped.
     */
    projects: [
      {
        test: {
          name: 'default',
          globals: true,
          // Vitest project members do NOT inherit the root test.testTimeout/
          // hookTimeout — each project's own test block governs. Without these,
          // tests here silently fall back to vitest's 5000ms default and tight
          // cold-spawn e2e tests (e.g. ape-mcp-e2e tools/list parity, ~5.2s on a
          // cold CI runner) flakily time out. Mirror the intended root values.
          testTimeout: 15000,
          hookTimeout: 20000,
          include: ['__tests__/**/*.test.js'],
          exclude: SPAWN_SERIAL_FILES,
        },
      },
      {
        test: {
          name: 'spawn-serial',
          globals: true,
          // Same non-inheritance rule as above: mirror the intended root
          // timeout values here too.
          testTimeout: 15000,
          hookTimeout: 20000,
          include: SPAWN_SERIAL_FILES,
          // One file at a time. `fileParallelism: false` is project-scoped in
          // vitest 4 and forces this project's worker fan-out to 1, so the
          // spawn-heavy files never run concurrently with each other while
          // the `default` project stays parallel.
          fileParallelism: false,
        },
      },
    ],
  },
});
