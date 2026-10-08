import { createHmac, randomUUID } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { hostname, tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { pollGateSuite } from '../lib/runtime/gate-watch.js';
import { runtimePaths } from '../lib/runtime/paths.js';
import { atomicWriteJson } from '../lib/runtime/storage.js';

const fixtures = [];
afterEach(async () => {
  await Promise.all(fixtures.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
async function pollFixture(strategy, oversized) {
  // Keep collection possible on the pre-ownership baseline. The runtime owns
  // red admission before this new production module is restored.
  const ownershipModule = new URL('../lib/runtime/gate-launch-ownership.js', import.meta.url).href;
  const { gateGenerationFiles, gateOwnershipPath, reserveGateOwnership } = await import(/* @vite-ignore */ ownershipModule);
  const root = await mkdtemp(path.join(tmpdir(), 'ape-fourth-gate-artifact-'));
  fixtures.push(root);
  const paths = runtimePaths(root);
  const state = { run_id: 'run-fixture' };
  const generation = randomUUID();
  const files = gateGenerationFiles(paths, generation);
  const watch = {
    nonce: generation, generation, cache_key: 'fixture-key', tree_sha: 'a'.repeat(40),
    ownership_file: gateOwnershipPath(paths, state.run_id), host: hostname(),
    job_file: files.job, artifact_file: files.artifact, heartbeat_file: files.heartbeat,
    command: 'fixture', plan: { command: 'fixture', args: [] },
    runner_order: ['fixture'], runner_index: 0,
  };
  // Synthetic completed work: no process is launched or declared retired by
  // observation. Model the authenticated disk protocol to isolate its byte cap.
  const record = await reserveGateOwnership(root, paths, state, watch);
  await atomicWriteJson(files.job, {
    nonce: generation, run_id: state.run_id, ownership_file: watch.ownership_file,
    project_dir: realpathSync(root), plan: watch.plan, cache_key: watch.cache_key,
  });
  const payload = {
    cleanup: { status: 'confirmed' },
    producers: { result_published: true, heartbeat_drained: true },
    artifact: {
      run_id: state.run_id, nonce: generation, cache_key: watch.cache_key, passed: true,
      verification: { passed: true, exit_code: 0, duration_ms: 1 },
      // Completion proof reads have a 1 MiB cap, including their result payload.
      ...(oversized ? { padding: 'x'.repeat(1024 * 1024) } : {}),
    },
  };
  await atomicWriteJson(files.proof, {
    generation, payload,
    mac: createHmac('sha256', record.secret).update(JSON.stringify(payload)).digest('hex'),
  });
  const proofBefore = await readFile(files.proof);
  const result = await pollGateSuite(root, paths, { ...state, gates_watch: watch }, {}, {
    strategy, cacheKey: 'fixture-key', treeSha: 'a'.repeat(40), suiteCommand: 'fixture',
    participants: [{ id: 'fixture', keyR: 'fixture-key' }],
  });
  // Rejection must retain recoverable ownership and completion evidence.
  const proofAfter = await readFile(files.proof);
  expect(proofAfter.length).toBe(proofBefore.length);
  expect(proofAfter.equals(proofBefore), 'completion proof bytes changed during polling').toBe(true);
  expect(JSON.parse(await readFile(watch.ownership_file, 'utf8')).generation).toBe(generation);
  return result;
}

describe('fourth-pass gate artifact byte budget', () => {
  it.each(['single', 'multi'])('rejects an oversized %s control artifact before adopting its pass', async (strategy) => {
    const result = await pollFixture(strategy, true);
    expect(result.ready).toBeUndefined();
    expect(result.pending?.summary).toMatch(/retirement is unknown/);
  });
  it.each(['single', 'multi'])('preserves an ordinary %s completion artifact', async (strategy) => {
    const result = await pollFixture(strategy, false);
    expect(result.failed).toBeUndefined();
    expect(result.ready).toBeDefined();
    if (strategy === 'single') expect(result.ready.full.passed).toBe(true);
    else expect(result.ready.ctx.runnerResults).toEqual([expect.objectContaining({ id: 'fixture', passed: true })]);
  });
});
