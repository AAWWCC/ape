import { execFileSync, spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { sha256 } from '../lib/runtime/canonical.js';
import { SCHEMA_VERSION } from '../lib/runtime/constants.js';
import { runtimePaths } from '../lib/runtime/paths.js';
import { resolveReceiptBaseline } from '../lib/runtime/receipt-validator.js';
import { finalizeReceipt, finalizeTicket } from '../lib/runtime/schemas.js';
import { prepareTaskOperationStore, readTaskOperationTransaction, writeTaskOperationTransaction } from '../lib/runtime/receipt-service.js';

const fixtures = [];
const validatorUrl = new URL('../lib/runtime/receipt-validator.js', import.meta.url).href;
afterEach(async () => {
  await Promise.all(fixtures.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function recoveryFixture() {
  const directory = await mkdtemp(path.join(tmpdir(), 'ape-fourth-recovery-'));
  fixtures.push(directory);
  const paths = runtimePaths(directory);
  await mkdir(paths.receiptTransactions, { recursive: true });
  const source = finalizeTicket({
    schema_version: SCHEMA_VERSION, ticket_id: 'run-fourth:build:source', run_id: 'run-fourth',
    stage_id: 'build', role: 'implementer', objective: 'Recover exact file authority',
    claimed_paths: ['src/value.js'], test_paths: [], model_tier: 'balanced', model: { model: 'opus' },
    deadline_at: '2026-09-07T21:00:00.000Z', issued_at: '2026-09-07T20:00:00.000Z',
    output_schema: {}, required_checks: [], parent_hash: null, base_tree_sha: 'a'.repeat(40), attempt: 1, writable: true,
  });
  const receipt = finalizeReceipt({
    schema_version: SCHEMA_VERSION, receipt_id: 'receipt-fourth', run_id: source.run_id,
    ticket_id: source.ticket_id, ticket_hash: source.ticket_hash,
    agent: { host: 'claude', role: source.role, identity: 'source-agent', model: 'opus' },
    status: 'failed', base_tree_sha: source.base_tree_sha, head_tree_sha: 'b'.repeat(40),
    changed_files: [], tests: [], findings: [], evidence: {
      summary: 'Need an exact new production path', failure_kind: 'capability', required_claims: { claimed_paths: ['src/extra.js'] },
    }, timing: { started_at: source.issued_at, completed_at: source.issued_at, duration_ms: 0 }, previous_receipt_hash: null,
  });
  const inputHash = 'c'.repeat(64);
  const ticket = finalizeTicket({ ...source, ticket_id: 'run-fourth:build:successor',
    claimed_paths: [...source.claimed_paths, 'src/extra.js'], issued_at: '2026-09-07T20:01:00.000Z',
    parent_hash: receipt.receipt_hash, recovery_lineage: {
      source_ticket_id: source.ticket_id, validation_submissions: 1, physical_workers: 1,
      validation_submissions_per_worker: 3, max_physical_workers: 2,
    }, recovery_provenance: {
      authority: 'runtime', source_ticket_id: source.ticket_id, source_ticket_hash: source.ticket_hash,
      source_receipt_id: receipt.receipt_id, source_receipt_hash: receipt.receipt_hash,
      receipt_input_hash: inputHash, source_issued_at: source.issued_at, source_deadline_at: source.deadline_at,
      derived_at: '2026-09-07T20:01:00.000Z',
    },
  });
  const effect = { successor_contract: ticket };
  const transaction = { status: 'committed', run_id: source.run_id, ticket_id: source.ticket_id,
    input_hash: inputHash, receipt, prepared_effect: effect, prepared_effect_hash: sha256(effect), prepared_at: ticket.issued_at };
  const file = path.join(paths.receiptTransactions, `${sha256(source.ticket_id)}.json`);
  await writeFile(file, JSON.stringify(transaction));
  const request = { project_dir: directory, ticket, state: { run_id: source.run_id, tickets: [source, ticket], receipts: [receipt] } };
  // Supply the existing tree seam: this fixture isolates sealed evidence reads,
  // and no production paths changed across the source/successor handoff.
  expect(await resolveReceiptBaseline({ ...request, tree: { diff: async () => [] } })).toBe(receipt.head_tree_sha);
  const requestFile = path.join(directory, 'request.json');
  await writeFile(requestFile, JSON.stringify(request));
  return { directory, file, requestFile };
}

describe('fourth-pass receipt recovery evidence reads', () => {
  it.skipIf(process.platform === 'win32')('rejects a task transaction replaced with a FIFO after its lstat', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'ape-fourth-task-read-'));
    fixtures.push(directory);
    const store = await prepareTaskOperationStore(runtimePaths(directory));
    const file = path.join(store.directory, `${'d'.repeat(64)}.json`);
    const written = await writeTaskOperationTransaction(file, store, {
      operation_id: `op-${'a'.repeat(43)}`, action: 'next', input_hash: 'b'.repeat(64),
      status: 'prepared', prepared_at: new Date().toISOString(),
    });
    expect(await readTaskOperationTransaction(file, store)).toEqual(written);
    const child = spawnSync(process.execPath, ['--input-type=module', '-e', `
      import fs from 'node:fs/promises';
      import { unlinkSync } from 'node:fs';
      import { execFileSync } from 'node:child_process';
      import { syncBuiltinESMExports } from 'node:module';
      const file = process.argv[1];
      const original = fs.lstat;
      let replaced = false;
      fs.lstat = async function(target, options) {
        const result = await original(target, options);
        if (!replaced && String(target) === file) {
          replaced = true;
          unlinkSync(file);
          execFileSync('mkfifo', [file]);
        }
        return result;
      };
      syncBuiltinESMExports();
      const { readTaskOperationTransaction } = await import(process.argv[2]);
      try {
        await readTaskOperationTransaction(file, JSON.parse(process.argv[3]));
        process.stdout.write(JSON.stringify({ replaced, rejected: false }));
      } catch { process.stdout.write(JSON.stringify({ replaced, rejected: true })); }
    `, file, new URL('../lib/runtime/receipt-service.js', import.meta.url).href, JSON.stringify(store)],
    { encoding: 'utf8', timeout: 3000 });
    expect(child.error?.code, child.stderr).not.toBe('ETIMEDOUT');
    expect(child.status, child.stderr).toBe(0);
    expect(JSON.parse(child.stdout)).toEqual({ replaced: true, rejected: true });
  });

  it.skipIf(process.platform === 'win32')('rejects a FIFO source transaction without hanging receipt validation', async () => {
    const { file, requestFile } = await recoveryFixture();
    await rm(file);
    execFileSync('mkfifo', [file]);
    const child = spawnSync(process.execPath, ['--input-type=module', '-e', `
      import { readFileSync } from 'node:fs';
      const { resolveReceiptBaseline } = await import(process.argv[2]);
      const request = JSON.parse(readFileSync(process.argv[1], 'utf8'));
      try {
        await resolveReceiptBaseline({ ...request, tree: { diff: async () => [] } });
        process.stdout.write(JSON.stringify({ rejected: false }));
      } catch { process.stdout.write(JSON.stringify({ rejected: true })); }
    `, requestFile, validatorUrl], { encoding: 'utf8', timeout: 3000 });
    expect(child.error?.code, child.stderr).not.toBe('ETIMEDOUT');
    expect(child.status, child.stderr).toBe(0);
    expect(JSON.parse(child.stdout)).toEqual({ rejected: true });
  });
});
