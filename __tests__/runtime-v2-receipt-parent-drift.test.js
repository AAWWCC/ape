import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

const crash = vi.hoisted(() => ({ afterPrepared: false, fired: 0 }));
vi.mock('../lib/runtime/storage.js', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    atomicWriteJson: async (file, value) => {
      await actual.atomicWriteJson(file, value);
      if (crash.afterPrepared && file.replaceAll('\\', '/').includes('/receipt-transactions/') && value?.status === 'prepared') {
        crash.afterPrepared = false;
        crash.fired += 1;
        throw new Error('synthetic crash after prepared receipt transaction');
      }
    },
  };
});

import { sha256 } from '../lib/runtime/canonical.js';
import { currentTreeSha } from '../lib/runtime/git.js';
import { runtimePaths } from '../lib/runtime/paths.js';
import { recordReceipt } from '../lib/runtime/service.js';
import { atomicWriteJson } from '../lib/runtime/storage.js';
import { checkTreeAttribution, recordRejectedParentChange } from '../lib/runtime/tree-attribution.js';
import { seedLegacyRun } from './legacy-run-test-helper.js';

const cleanups = [];
afterEach(async () => {
  crash.afterPrepared = false;
  crash.fired = 0;
  await Promise.all(cleanups.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function fixture() {
  const dir = await mkdtemp(path.join(tmpdir(), 'ape-receipt-parent-drift-'));
  cleanups.push(dir);
  const git = (...args) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' }).trim();
  await mkdir(path.join(dir, 'docs'));
  await writeFile(path.join(dir, 'docs/note.md'), '# note\n');
  await writeFile(path.join(dir, 'docs/other.md'), '# other\n');
  git('init', '-q');
  git('add', '.');
  git('-c', 'user.name=APE Fixture', '-c', 'user.email=ape@example.test', 'commit', '-qm', 'baseline');
  const paths = runtimePaths(dir);
  await atomicWriteJson(paths.config, {
    shipping: { auto_merge: false, provider: 'github', required_remote_checks: false },
    test_commands: { full: 'node --version' },
  });
  const started = await seedLegacyRun(dir, {
    objective: 'Update documentation with attributable worker changes',
    mode: 'phase', lane: 'mechanical', host: 'codex', behavioral: false,
    claimed_paths: ['docs/note.md', 'docs/other.md'], test_paths: [], requirements: [], risk_triggers: [],
  });
  const ticket = started.run.tickets[0];
  expect(ticket.role).toBe('implementer');
  const receipt = {
    ticket_id: ticket.ticket_id, status: 'passed', agent_identity: 'fixture-implementer',
    tests: [{ command: 'node --version', passed: true, exit_code: 0, duration_ms: 1 }],
    findings: [], evidence: { verdict: 'pass' },
  };
  return { dir, paths, state: started.run, ticket, receipt, baselineTree: await currentTreeSha(dir) };
}

async function runtimeSnapshot(paths) {
  const files = {};
  async function visit(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) await visit(file);
      else if (entry.isFile()) files[path.relative(paths.runtime, file).replaceAll('\\', '/')] = sha256(await readFile(file));
    }
  }
  await visit(paths.runtime);
  return files;
}

async function noteParentChange(value, beforeTree = value.baselineTree) {
  const afterTree = await currentTreeSha(value.dir);
  await recordRejectedParentChange(value.paths, value.state.run_id, beforeTree, afterTree, ['docs/note.md']);
  expect(await checkTreeAttribution(value.paths, value.state.run_id, afterTree))
    .toMatchObject({ blocked: true, affected_paths: ['docs/note.md'] });
  return afterTree;
}

function expectAttributionRefusal(result) {
  expect(result).toMatchObject({ ok: false, rejected: true });
  expect(result.errors.join(' ')).toMatch(/parent-tool|attribution/i);
  expect(result.errors.join(' ')).not.toMatch(/unreadable|corrupt/i);
}

describe('receipt admission preserves rejected parent-write attribution', () => {
  it('refuses a fresh in-scope receipt without publishing receipts, transactions, or changed active state', async () => {
    const value = await fixture();
    await writeFile(path.join(value.dir, 'docs/note.md'), '# parent-owned change\n');
    const tree = await noteParentChange(value);
    const before = await runtimeSnapshot(value.paths);
    const result = await recordReceipt(value.dir, value.receipt);
    expectAttributionRefusal(result);
    expect(await runtimeSnapshot(value.paths)).toEqual(before);
    expect(await currentTreeSha(value.dir)).toBe(tree);
    expect(await readFile(path.join(value.dir, 'docs/note.md'), 'utf8')).toBe('# parent-owned change\n');
  });

  it('refuses replay of an unchanged prepared transaction whose parent-write observation arrived before publication', async () => {
    const value = await fixture();
    await writeFile(path.join(value.dir, 'docs/note.md'), '# parent-owned change\n');
    const activeBefore = await readFile(value.paths.active, 'utf8');
    crash.afterPrepared = true;
    await expect(recordReceipt(value.dir, value.receipt)).rejects.toThrow('synthetic crash after prepared receipt transaction');
    expect(crash.fired).toBe(1);
    expect(await readFile(value.paths.active, 'utf8')).toBe(activeBefore);
    const transactionFile = path.join(value.paths.receiptTransactions, `${sha256(value.ticket.ticket_id)}.json`);
    const transaction = JSON.parse(await readFile(transactionFile, 'utf8'));
    expect(transaction.status).toBe('prepared');
    expect(await readdir(value.paths.receipts).catch((error) => { if (error.code === 'ENOENT') return []; throw error; })).toEqual([]);

    const tree = await noteParentChange(value);
    expect(transaction.receipt.head_tree_sha).toBe(tree);
    const before = await runtimeSnapshot(value.paths);
    expectAttributionRefusal(await recordReceipt(value.dir, value.receipt));
    expect(await runtimeSnapshot(value.paths)).toEqual(before);
    expect(await currentTreeSha(value.dir)).toBe(tree);
  });

  it('returns a committed identical receipt idempotently without adopting later parent drift', async () => {
    const value = await fixture();
    await writeFile(path.join(value.dir, 'docs/note.md'), '# legitimate worker change\n');
    const admitted = await recordReceipt(value.dir, value.receipt);
    expect(admitted.ok).toBe(true);
    const acceptedTree = await currentTreeSha(value.dir);
    await writeFile(path.join(value.dir, 'docs/note.md'), '# later parent change\n');
    await noteParentChange(value, acceptedTree);
    const before = await runtimeSnapshot(value.paths);
    const replayed = await recordReceipt(value.dir, value.receipt);
    expect(replayed).toMatchObject({ ok: true, idempotent: true, receipt: admitted.receipt, actions: [] });
    expect(await runtimeSnapshot(value.paths)).toEqual(before);
    expect(await checkTreeAttribution(value.paths, value.state.run_id, await currentTreeSha(value.dir)))
      .toMatchObject({ blocked: true, affected_paths: ['docs/note.md'] });
  });

  it('admits new worker changes after exact affected-path restoration is observed, preserving other legitimate work', async () => {
    const value = await fixture();
    await writeFile(path.join(value.dir, 'docs/note.md'), '# parent-owned change\n');
    await noteParentChange(value);
    await writeFile(path.join(value.dir, 'docs/other.md'), '# unrelated legitimate worker change\n');
    await writeFile(path.join(value.dir, 'docs/note.md'), '# note\n');
    const restoredTree = await currentTreeSha(value.dir);
    expect(restoredTree).not.toBe(value.baselineTree);
    expect(await checkTreeAttribution(value.paths, value.state.run_id, restoredTree))
      .toMatchObject({ blocked: false, affected_paths: [] });
    await writeFile(path.join(value.dir, 'docs/note.md'), '# new legitimate worker change\n');
    const admitted = await recordReceipt(value.dir, value.receipt);
    expect(admitted.ok).toBe(true);
    expect(admitted.receipt.changed_files).toEqual(['docs/note.md', 'docs/other.md']);
    expect(await readFile(path.join(value.dir, 'docs/other.md'), 'utf8')).toBe('# unrelated legitimate worker change\n');
  });
});
