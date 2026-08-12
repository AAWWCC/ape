import { access, cp, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { executeTaskOperationTransaction } from '../lib/runtime/service.js';
import { hashRecord, sha256 } from '../lib/runtime/canonical.js';

const scratches = [];
const operationId = (character) => `op-${character.repeat(43)}`;

async function scratchDir(prefix) {
  const dir = await mkdtemp(path.join(os.tmpdir(), prefix));
  scratches.push(dir);
  return dir;
}

afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(scratches.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('APE v2 MCP task reissue and crash reconciliation', () => {
  it('serializes one operation id and replays exactly one charged result', async () => {
    const projectDir = await scratchDir('ape-task-operation-');
    let charged = 0;
    let secondEntered;
    const concurrentEffect = new Promise((resolve) => { secondEntered = resolve; });
    const operation = {
      operationId: operationId('A'),
      action: 'regate',
      request: { action: 'regate', reason: 'task test' },
    };

    const effect = async () => {
      const chargeNumber = ++charged;
      if (chargeNumber === 2) secondEntered();
      // Hold the first effect open long enough for the same-operation caller
      // to encounter the durable `prepared` transaction. A correct ownership
      // protocol waits/reconciles; it does not enter the effect concurrently.
      await Promise.race([
        concurrentEffect,
        new Promise((resolve) => setTimeout(resolve, 500)),
      ]);
      return { ok: true, charged: chargeNumber, marker: 'exact committed result' };
    };
    const first = executeTaskOperationTransaction(projectDir, operation, effect);
    const concurrentReplay = executeTaskOperationTransaction(projectDir, operation, effect);

    const [left, right] = await Promise.all([first, concurrentReplay]);
    expect(charged, 'one operation id must never charge the reducer effect twice').toBe(1);
    expect(left).toEqual({ ok: true, charged: 1, marker: 'exact committed result' });
    expect(right, 'the concurrent recovery path must project the committed bytes').toEqual(left);

    const afterCrash = await executeTaskOperationTransaction(projectDir, operation, async () => {
      throw new Error('an effect-committed operation must not run again');
    });
    expect(afterCrash).toEqual(left);
    expect(charged).toBe(1);
  }, 60_000);

  it('treats each fresh operation id as fresh intent while repeated identity is idempotent', async () => {
    const projectDir = await scratchDir('ape-task-fresh-intent-');
    let charged = 0;
    const run = (operationId) => executeTaskOperationTransaction(projectDir, {
      operationId,
      action: 'next',
      request: { action: 'next', wait_ms: 1 },
    }, async () => ({ sequence: ++charged }));

    expect(await run(operationId('B'))).toEqual({ sequence: 1 });
    expect(await run(operationId('B'))).toEqual({ sequence: 1 });
    expect(await run(operationId('C'))).toEqual({ sequence: 2 });
    expect(charged).toBe(2);
  });

  it('fails closed on a prepared-only crash record instead of guessing whether to recharge', async () => {
    const projectDir = await scratchDir('ape-task-prepared-crash-');
    const operation = {
      operationId: operationId('D'),
      action: 'ship',
      request: { action: 'ship', reason: 'uncertain effect' },
    };
    const transactionDir = path.join(projectDir, '.ape', 'runtime', 'task-operation-transactions');
    await mkdir(transactionDir, { recursive: true });
    const rootBinding = sha256(`ape-task-operation-root-v1:${await realpath(projectDir)}`);
    const prepared = {
      version: 1,
      root_binding: rootBinding,
      operation_id: operation.operationId,
      action: operation.action,
      input_hash: sha256(JSON.stringify({
        action: operation.action,
        request: operation.request,
        expected_run_id: null,
        preflight_refusal: null,
      })),
      expected_run_id: null,
      status: 'prepared',
      prepared_at: '2026-08-10T12:00:00.000Z',
      expires_at: '2026-08-17T12:00:00.000Z',
      record_hash: '0'.repeat(64),
    };
    prepared.record_hash = hashRecord(prepared, ['record_hash']);
    await writeFile(path.join(transactionDir, `${sha256(operation.operationId)}.json`), `${JSON.stringify(prepared, null, 2)}\n`, { mode: 0o600 });

    let effectCalled = false;
    await expect(executeTaskOperationTransaction(projectDir, operation, async () => {
      effectCalled = true;
      return { charged: 'again' };
    })).rejects.toThrow(/prepared|indeterminate|cannot safely|reconcil/i);
    expect(effectCalled, 'a prepared-only crash record cannot prove the effect is safe to rerun').toBe(false);
  });

  it('refuses an operation-id replay whose action or request identity changed', async () => {
    const projectDir = await scratchDir('ape-task-conflict-');
    await executeTaskOperationTransaction(projectDir, {
      operationId: operationId('E'),
      action: 'next',
      request: { action: 'next', wait_ms: 10 },
    }, async () => ({ ok: true }));

    await expect(executeTaskOperationTransaction(projectDir, {
      operationId: operationId('E'),
      action: 'next',
      request: { action: 'next', wait_ms: 20 },
    }, async () => ({ ok: false }))).rejects.toThrow(/different input/i);
  });

  it('fails closed when a committed operation transaction is tampered', async () => {
    const projectDir = await scratchDir('ape-task-operation-tamper-');
    const id = operationId('F');
    const operation = { operationId: id, action: 'regate', request: { action: 'regate' } };
    await executeTaskOperationTransaction(projectDir, operation, async () => ({ ok: true, charged: 1 }));
    const file = path.join(
      projectDir,
      '.ape',
      'runtime',
      'task-operation-transactions',
      `${sha256(id)}.json`,
    );
    const tampered = JSON.parse(await readFile(file, 'utf8'));
    tampered.result = { ok: true, charged: 999 };
    await writeFile(file, `${JSON.stringify(tampered, null, 2)}\n`, { mode: 0o600 });

    let effectCalled = false;
    await expect(executeTaskOperationTransaction(projectDir, operation, async () => {
      effectCalled = true;
      return { ok: true };
    })).rejects.toThrow(/root|schema|hash|validation/i);
    expect(effectCalled).toBe(false);
  });

  it('rejects an operation transaction copied from another governed root', async () => {
    const left = await scratchDir('ape-task-operation-root-left-');
    const right = await scratchDir('ape-task-operation-root-right-');
    const id = operationId('I');
    const operation = { operationId: id, action: 'regate', request: { action: 'regate' } };
    await executeTaskOperationTransaction(left, operation, async () => ({ ok: true }));
    const name = `${sha256(id)}.json`;
    const relative = path.join('.ape', 'runtime', 'task-operation-transactions', name);
    await mkdir(path.dirname(path.join(right, relative)), { recursive: true });
    await cp(path.join(left, relative), path.join(right, relative));

    await expect(executeTaskOperationTransaction(right, operation, async () => ({ ok: false })))
      .rejects.toThrow(/root|schema|hash|validation/i);
  });

  it.skipIf(process.platform === 'win32')('refuses a symlinked runtime parent before creating operation state outside the root', async () => {
    const projectDir = await scratchDir('ape-task-operation-parent-link-');
    const outside = await scratchDir('ape-task-operation-parent-target-');
    await mkdir(path.join(projectDir, '.ape'), { recursive: true });
    await symlink(outside, path.join(projectDir, '.ape', 'runtime'), 'dir');

    await expect(executeTaskOperationTransaction(projectDir, {
      operationId: operationId('J'),
      action: 'regate',
      request: { action: 'regate' },
    }, async () => ({ ok: true }))).rejects.toThrow(/unsafe|outside|governed|runtime path/i);
    await expect(access(path.join(outside, 'task-operation-transactions')))
      .rejects.toMatchObject({ code: 'ENOENT' });
    await expect(access(path.join(outside, 'receipt-effects.lock')))
      .rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('collects expired operation transactions into bounded audit tombstones', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-08-10T12:00:00.000Z'));
    const projectDir = await scratchDir('ape-task-operation-gc-');
    const expiredId = operationId('G');
    await executeTaskOperationTransaction(projectDir, {
      operationId: expiredId,
      action: 'regate',
      request: { action: 'regate' },
    }, async () => ({ ok: true }));

    vi.setSystemTime(new Date('2026-08-18T12:00:00.000Z'));
    await executeTaskOperationTransaction(projectDir, {
      operationId: operationId('H'),
      action: 'ship',
      request: { action: 'ship', reason: 'trigger collection' },
    }, async () => ({ ok: true }));

    const directory = path.join(projectDir, '.ape', 'runtime', 'task-operation-transactions');
    const name = `${sha256(expiredId)}.json`;
    await expect(access(path.join(directory, name))).rejects.toMatchObject({ code: 'ENOENT' });
    const audit = JSON.parse(await readFile(path.join(directory, '.gc', name), 'utf8'));
    expect(audit).toMatchObject({ operation_id: expiredId, status: 'effect-committed' });
    expect(audit.transaction_hash).toMatch(/^[0-9a-f]{64}$/);
  });
});
