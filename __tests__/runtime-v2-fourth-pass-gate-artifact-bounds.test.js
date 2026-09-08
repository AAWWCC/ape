import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { pollGateSuite } from '../lib/runtime/gate-watch.js';
import { RUNTIME_STATE_MAX_BYTES } from '../lib/runtime/resource-limits.js';

const fixtures = [];
afterEach(async () => {
  await Promise.all(fixtures.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
async function pollFixture(strategy, oversized) {
  const root = await mkdtemp(path.join(tmpdir(), 'ape-fourth-gate-artifact-'));
  fixtures.push(root);
  const artifact = path.join(root, 'result.json');
  await writeFile(artifact, JSON.stringify({
    run_id: 'run-fixture', nonce: 'fixture-nonce', passed: true,
    verification: { passed: true, exit_code: 0, duration_ms: 1 },
    ...(oversized ? { padding: 'x'.repeat(RUNTIME_STATE_MAX_BYTES) } : {}),
  }));
  return pollGateSuite(root, {}, { run_id: 'run-fixture', gates_watch: {
    nonce: 'fixture-nonce', cache_key: 'fixture-key', tree_sha: 'a'.repeat(40),
    artifact_file: artifact, host: 'absent-fixture-host', spawn_attempts: 2,
    runner_order: ['fixture'], runner_index: 0,
  } }, {}, {
    strategy, cacheKey: 'fixture-key', treeSha: 'a'.repeat(40), suiteCommand: 'fixture',
    participants: [{ id: 'fixture', keyR: 'fixture-key' }],
  });
}

describe('fourth-pass gate artifact byte budget', () => {
  it.each(['single', 'multi'])('rejects an oversized %s control artifact before adopting its pass', async (strategy) => {
    const result = await pollFixture(strategy, true);
    expect(result.ready).toBeUndefined();
    expect(result.failed).toMatch(/produced no result/);
  });
  it.each(['single', 'multi'])('preserves an ordinary %s completion artifact', async (strategy) => {
    const result = await pollFixture(strategy, false);
    expect(result.failed).toBeUndefined();
    expect(result.ready).toBeDefined();
  });
});
