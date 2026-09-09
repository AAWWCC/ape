import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { withDirLock } from '../lib/runtime/lock.js';
import { splitCommand, templateInvocation, runTestSuite } from '../lib/runtime/runner.js';
import { runtimePaths } from '../lib/runtime/paths.js';
import { activeState, ACTIVE_STATE_MAX_BYTES } from '../lib/runtime/active-state.js';
import { persist } from '../lib/runtime/receipt-service.js';
import { renderStatusDoc } from '../lib/runtime/status-doc.js';
import { setRuntimeConfig } from '../lib/runtime/config.js';
import { RunStartInputSchema } from '../lib/runtime/schemas.js';
import { classifyLane } from '../lib/runtime/lane-policy.js';
import { pipelineRunSpec, projectedPipeline } from '../lib/runtime/pipeline.js';
import { evaluateRunReadiness } from '../lib/runtime/readiness.js';
import { archiveRun, queryHistory, queryHistoryPage } from '../lib/runtime/history.js';
import { registerEntries, deriveRoadmap, attestRequirements } from '../lib/runtime/roadmap.js';

const directories = [];
afterEach(async () => Promise.all(directories.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))));
async function fixture() {
  const dir = await mkdtemp(path.join(tmpdir(), 'ape-release-lifecycle-'));
  directories.push(dir);
  return runtimePaths(dir);
}

describe('receipt lock retirement recovery', () => {
  it('recovers a proven-dead holder that crashed after persisting retirement', async () => {
    const paths = await fixture();
    const lock = path.join(paths.root, 'receipt-effects.lock');
    const childFile = path.join(paths.root, 'crash-at-release.mjs');
    const lockModule = new URL('../lib/runtime/lock.js', import.meta.url).href;
    await writeFile(childFile, `
      import fs from 'node:fs/promises';
      import { syncBuiltinESMExports } from 'node:module';
      const rename = fs.rename;
      fs.rename = async (source, target) => {
        if (source === process.argv[2] && target.includes('.release.')) process.exit(87);
        return rename(source, target);
      };
      syncBuiltinESMExports();
      const { withDirLock } = await import(${JSON.stringify(lockModule)});
      await withDirLock(process.argv[2], async () => {}, {
        staleMs: 100, heartbeatMs: 10, busyMs: 1000, busyMessage: 'busy'
      });
    `);
    const child = spawnSync(process.execPath, [childFile, lock], { encoding: 'utf8', timeout: 10_000 });
    expect(child.status, child.stderr).toBe(87);
    const owner = JSON.parse(await readFile(path.join(lock, 'process'), 'utf8'));
    expect(owner.state).toBe('retiring');
    expect(() => process.kill(owner.pid, 0)).toThrow();
    const old = new Date(Date.now() - 10_000);
    await utimes(lock, old, old);
    await expect(withDirLock(lock, async () => 'recovered', {
      staleMs: 100, heartbeatMs: 10, busyMs: 1000, busyMessage: 'dead retiring owner stayed busy',
    })).resolves.toBe('recovered');
    await expect(readFile(path.join(lock, 'owner'))).rejects.toMatchObject({ code: 'ENOENT' });
  });
});

describe('exact configured command argv', () => {
  it('preserves empty, adjacent, and whitespace quoted arguments in command templates', () => {
    expect(splitCommand(`node '' "" ' ' x''y`)).toEqual(['node', '', '', ' ', 'xy']);
    expect(templateInvocation(`node driver.js '' {paths} ""`, ['checks/a b.js'])).toMatchObject({
      command: 'node', args: ['driver.js', '', 'checks/a b.js', ''],
    });
  });

  it('executes the configured empty argument instead of manufacturing a usage-error verdict', async () => {
    const paths = await fixture();
    await writeFile(path.join(paths.root, 'driver.cjs'),
      `process.exit(process.argv.length === 3 && process.argv[2] === '' ? 0 : 9);\n`);
    const command = `"${process.execPath}" driver.cjs ""`;
    const config = await setRuntimeConfig(paths.config, 'test_commands.targeted', command);
    expect(config.test_commands.targeted).toBe(command);
    expect(await runTestSuite(paths.root, { command, timeout_ms: 5000 })).toMatchObject({
      passed: true, exit_code: 0, tooling_failure: false,
      runner: { args: ['driver.cjs', ''] },
    });
  });
});

describe('admitted execution policy and durable state budgets', () => {
  it('keeps larger configured ticket, receipt and expiry histories readable and renderable', async () => {
    const paths = await fixture();
    const config = await setRuntimeConfig(paths.config, 'policy.max_stage_attempts', 300);
    const input = RunStartInputSchema.parse({ mode: 'debug', host: 'codex', lane: 'full',
      objective: 'Investigate the admitted scoped issue', claimed_paths: ['src/main.js'],
      hooks_trusted: true, subagents_available: true, explicit_invocation: true });
    const classification = classifyLane({ ...input, requested_lane: input.lane }, config.policy);
    const projection = projectedPipeline(pipelineRunSpec(input, classification, config));
    expect(evaluateRunReadiness({ input, config, classification, projection }).ready).toBe(true);
    expect(projection.dispatch_bounds.logical_ticket_upper_bound).toBe(300);
    const tickets = Array.from({ length: 300 }, (_, i) => ({
      ticket_id: `ticket-${i + 1}`, stage_id: 'debug', role: 'debugger', attempt: i + 1,
    }));
    const state = { schema_version: '2.0.0', run_id: 'run-large-admitted', status: 'running',
      mode: 'debug', lane: 'full', host: 'codex', stage: 'debug', dispatch_state: 'pending',
      tickets, receipts: tickets.slice(0, -1).map((ticket) => ({ ticket_id: ticket.ticket_id, status: 'failed' })),
      expired_tickets: tickets.slice(0, -1).map((ticket) => ticket.ticket_id), policy: config.policy,
      tree_sha: 'a'.repeat(40) };
    await persist(paths, state, null, { refreshTree: false });
    expect((await activeState(paths)).tickets).toHaveLength(300);
    expect(renderStatusDoc(state)).toContain('1 pending');
    expect(renderStatusDoc(state)).not.toContain('corrupt_state');
    const before = await readFile(paths.active, 'utf8');
    await expect(persist(paths, { ...state, objective: 'x'.repeat(ACTIVE_STATE_MAX_BYTES) }, null,
      { refreshTree: false })).rejects.toThrow(/budget/);
    expect(await readFile(paths.active, 'utf8')).toBe(before);
    expect(await readFile(path.join(paths.runs, `${state.run_id}.json`), 'utf8')).toBe(before);
  });
});

describe('opaque requirement identifiers across durable index consumers', () => {
  it('registers, archives, queries and attests inherited names across JSON round trips', async () => {
    const paths = await fixture();
    const ids = ['constructor', 'toString', '__proto__'];
    await registerEntries(paths, { entries: ids.map((id) => ({ id, title: id,
      description: 'Verify opaque requirement identity', acceptance: 'Complete the requirement' })), reason: 'Register requirements' });
    expect((await deriveRoadmap(paths)).counts.ready).toBe(3);
    const state = { run_id: 'run-opaque-requirements', mode: 'debug', lane: 'full', host: 'codex',
      status: 'completed', stage: 'completed', requirements: ids, completes: ids.slice(0, 2),
      tickets: [], receipts: [], created_at: '2026-01-01T00:00:00.000Z',
      updated_at: '2026-01-01T00:01:00.000Z' };
    await archiveRun(paths, state);
    for (const requirement of ids) {
      expect(await queryHistory(paths, { requirement })).toEqual([expect.objectContaining({ run_id: state.run_id })]);
      expect((await queryHistoryPage(paths, { requirement })).records).toHaveLength(1);
    }
    await attestRequirements(paths, { requirement_ids: ['__proto__'], run_id: state.run_id, reason: 'Attest remaining requirement' });
    expect((await deriveRoadmap(paths)).counts.satisfied).toBe(3);
    await archiveRun(paths, state);
    const stored = JSON.parse(await readFile(paths.requirementIndex, 'utf8'));
    for (const id of ids) expect(Object.getOwnPropertyDescriptor(stored.requirements, id)?.value).toEqual([state.run_id]);
  });
});
