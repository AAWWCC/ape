import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { receiptAuditContains } from '../lib/runtime/receipt-audit.js';

const fixtures = [];
afterEach(async () => {
  await Promise.all(fixtures.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});
async function fixture() {
  const directory = await mkdtemp(path.join(tmpdir(), 'ape-fourth-audit-lines-'));
  fixtures.push(directory);
  return path.join(directory, 'overrides.ndjson');
}

describe('fourth-pass bounded complete receipt audit scanning', () => {
  it('finds both old and recent exact audits through malformed lines and a log larger than the line budget', async () => {
    const file = await fixture();
    const first = { operation: 'scope-expansion', run_id: 'run-old', added_paths: ['src/old.js'] };
    const last = { operation: 'recover-receipt', run_id: 'run-new', receipt_input_hash: 'a'.repeat(64) };
    await writeFile(file, `${JSON.stringify(first)}\n{torn\n${JSON.stringify({ ignored: 'x'.repeat(17 * 1024 * 1024) })}\n${JSON.stringify(last)}`);
    expect(await receiptAuditContains(file, (entry) => JSON.stringify(entry) === JSON.stringify(first))).toBe(true);
    expect(await receiptAuditContains(file, (entry) => JSON.stringify(entry) === JSON.stringify(last))).toBe(true);
    expect(await receiptAuditContains(file, (entry) => entry.run_id === 'run-absent')).toBe(false);
  });

  it('preserves Unicode JSON split across descriptor chunks and final lines without a newline', async () => {
    const file = await fixture();
    const entry = { padding: 'x'.repeat(65_519), reason: '日本語🙂', operation: 'scope-expansion' };
    await writeFile(file, JSON.stringify(entry));
    expect(await receiptAuditContains(file, (record) => record.reason === entry.reason && record.operation === entry.operation)).toBe(true);
  });

  it('does not use a symlinked external log as an audit', async () => {
    const file = await fixture();
    const target = `${file}.external`;
    await writeFile(target, '{"operation":"scope-expansion"}\n');
    await symlink(target, file);
    expect(await receiptAuditContains(file, () => true)).toBe(false);
  });

  it.skipIf(process.platform === 'win32')('returns no audit for a FIFO without waiting for a writer', async () => {
    const file = await fixture();
    execFileSync('mkfifo', [file]);
    const child = spawnSync(process.execPath, ['--input-type=module', '-e', `
      const { receiptAuditContains } = await import(process.argv[2]);
      process.stdout.write(JSON.stringify(await receiptAuditContains(process.argv[1], () => true)));
    `, file, new URL('../lib/runtime/receipt-audit.js', import.meta.url).href], { encoding: 'utf8', timeout: 3000 });
    expect(child.error?.code, child.stderr).not.toBe('ETIMEDOUT');
    expect(child.status, child.stderr).toBe(0);
    expect(child.stdout).toBe('false');
  });
});
