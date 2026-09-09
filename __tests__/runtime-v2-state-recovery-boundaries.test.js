import { spawnSync } from 'node:child_process';
import { gzipSync } from 'node:zlib';
import { hostname, tmpdir } from 'node:os';
import { link, mkdir, mkdtemp, readFile, readdir, rm, symlink, truncate, utimes, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { sha256 } from '../lib/runtime/canonical.js';
import { appendTaskGeneration, collectExpiredTasks, createOperationId, createTask, getTask, listOwnedTasks,
  recoverTaskCreationStaging, taskStorePaths } from '../lib/runtime/task-store.js';
import { runtimePaths } from '../lib/runtime/paths.js';
import { archiveRun, queryHistory, queryHistoryPage } from '../lib/runtime/history.js';
import { compactArchivedArtifacts } from '../lib/runtime/retention.js';
import { releaseRunLock, withDirLock } from '../lib/runtime/lock.js';
import { atomicWriteJson, readJson } from '../lib/runtime/storage.js';

const roots = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });
async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), 'ape-state-recovery-'));
  roots.push(root);
  return root;
}
const options = () => ({ operationId: createOperationId(), action: 'next', request: { action: 'next' },
  // Deliberately belongs to the parent. Creation recovery must use the actual
  // creator, not caller-supplied execution ownership stored in generation zero.
  owner: { processId: process.pid, processStartedAt: new Date().toISOString(), instanceId: 'boundary-fixture' } });
const moduleUrl = (name) => new URL(`../lib/runtime/${name}.js`, import.meta.url).href;
const child = (source) => spawnSync(process.execPath, ['--input-type=module', '-e', source], { encoding: 'utf8', timeout: 10_000 });
async function ageTaskLock(root) {
  const old = new Date(Date.now() - 120_000);
  await utimes(taskStorePaths(root).lock, old, old).catch((error) => { if (error.code !== 'ENOENT') throw error; });
}

function terminalRun(runId) {
  return { schema_version: '2.0.0', run_id: runId, objective: 'bounded recovery', mode: 'phase', lane: 'fast', host: 'codex',
    requirements: [], status: 'completed', stage: 'completed', dispatch_state: 'none', created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:01:00.000Z', terminal_at: '2026-01-01T00:01:00.000Z',
    base_commit_sha: 'a'.repeat(40), tree_sha: 'b'.repeat(40), tickets: [], receipts: [] };
}
async function retentionFixture() {
  const paths = runtimePaths(await fixture());
  const run = terminalRun('run-recovery-retention');
  await archiveRun(paths, run);
  const source = path.join(paths.runs, `${run.run_id}.json`);
  await atomicWriteJson(source, run);
  return { paths, run, source, archive: path.join(paths.runtime, 'artifact-archives', `${run.run_id}.json.gz`) };
}

describe('task deletion commits before recursive cleanup', () => {
  it.each(['before-quarantine', 'after-quarantine', 'partial-remove', 'delayed-before-quarantine'])('recovers a process exit at %s', async (checkpoint) => {
    const root = await fixture();
    const task = await createTask(root, options());
    const tail = await appendTaskGeneration(root, task.taskId, { statusMessage: 'progress' });
    const now = Date.parse(task.expiresAt) + 1;
    const crashAt = checkpoint === 'delayed-before-quarantine' ? 'before-quarantine' : checkpoint;
    const script = `import fs from 'node:fs/promises'; import path from 'node:path'; import {syncBuiltinESMExports} from 'node:module';
      const rename=fs.rename; const remove=fs.rm;
      fs.rename=async(from,to)=>{if(path.basename(path.dirname(String(to)))==='.gc' && path.basename(String(to))===${JSON.stringify(task.taskId)}){
        if(${JSON.stringify(crashAt)}==='before-quarantine')process.exit(87);
        if(${JSON.stringify(crashAt)}==='after-quarantine'){await rename(from,to);process.exit(87);}}
        return rename(from,to);};
      fs.rm=async(file,settings)=>{if(${JSON.stringify(checkpoint)}==='partial-remove' && path.basename(String(file))===${JSON.stringify(task.taskId)} && settings?.recursive){
        const entries=await fs.readdir(file); await remove(path.join(file,entries.find(name=>name.endsWith('.json')))); process.exit(87);}
        return remove(file,settings);}; syncBuiltinESMExports();
      const{collectExpiredTasks}=await import(${JSON.stringify(moduleUrl('task-store'))}); await collectExpiredTasks(${JSON.stringify(root)},{now:${now}});`;
    const result = child(script);
    expect(result.status, result.stderr).toBe(87);
    await ageTaskLock(root);
    expect(await getTask(root, task.taskId)).toBeNull();
    // Deletion intent is already durable before the directory move. A live
    // worker cannot resurrect the expired task by advancing its journal.
    expect(await appendTaskGeneration(root, task.taskId, { statusMessage: 'late progress' })).toBeNull();
    expect(await listOwnedTasks(root, task.owner)).toEqual([]);
    const auditFile = path.join(taskStorePaths(root).gc, `${task.taskId}.json`);
    const audit = JSON.parse(await readFile(auditFile, 'utf8'));
    const collected = await collectExpiredTasks(root, { now: checkpoint === 'delayed-before-quarantine' ? now + 8 * 24 * 60 * 60_000 : now });
    if (checkpoint === 'delayed-before-quarantine') expect(collected[0].collectedAt).toBe(audit.collectedAt);
    expect(await getTask(root, task.taskId)).toBeNull();
    expect(audit).toMatchObject({ taskId: task.taskId, terminalHash: tail.hash, generations: 2 });
    expect(await readdir(taskStorePaths(root).gc)).toEqual(checkpoint === 'delayed-before-quarantine' ? [] : [`${task.taskId}.json`]);
    const independent = await createTask(root, options());
    expect((await getTask(root, independent.taskId)).hash).toBe(independent.hash);
  });

  it.each(['sibling', 'foreign'])('does not turn a %s audit into deletion authority for another journal', async (variant) => {
    const auditRoot = await fixture();
    const oldTask = await createTask(auditRoot, options());
    await collectExpiredTasks(auditRoot, { now: Date.parse(oldTask.expiresAt) + 1 });
    const root = variant === 'sibling' ? auditRoot : await fixture();
    const current = await createTask(root, options());
    const journal = path.join(taskStorePaths(root).tasks, current.taskId, '000000.json');
    const original = await readFile(journal);
    const audit = await readFile(path.join(taskStorePaths(auditRoot).gc, `${oldTask.taskId}.json`));
    await writeFile(path.join(taskStorePaths(root).gc, `${current.taskId}.json`), audit, { mode: 0o600 });
    await expect(getTask(root, current.taskId)).rejects.toThrow(/GC audit/);
    expect(await readFile(journal)).toEqual(original);
  });
});

describe('unpublished task creation recovery proves the creator is dead', () => {
  it.each(['empty', 'partial-generation', 'complete-generation'])('recovers %s staging after actual process exit', async (checkpoint) => {
    const root = await fixture();
    const script = `import fs from 'node:fs/promises';import{syncBuiltinESMExports}from'node:module';
      const mkdir=fs.mkdir,rename=fs.rename;
      fs.mkdir=async(file,settings)=>{const result=await mkdir(file,settings);if(${JSON.stringify(checkpoint)}==='empty'&&String(file).includes('.task-create.'))process.exit(87);return result;};
      fs.rename=async(from,to)=>{if(String(from).includes('.task-create.')){
        if(${JSON.stringify(checkpoint)}==='partial-generation'&&String(to).endsWith('000000.json'))process.exit(87);
        if(${JSON.stringify(checkpoint)}==='complete-generation'&&!String(from).endsWith('.tmp'))process.exit(87);}
        return rename(from,to);};syncBuiltinESMExports();const{createTask}=await import(${JSON.stringify(moduleUrl('task-store'))});
      await createTask(${JSON.stringify(root)},${JSON.stringify(options())});`;
    const result = child(script);
    expect(result.status, result.stderr).toBe(87);
    const runtime = taskStorePaths(root).runtime;
    expect((await readdir(runtime)).filter((name) => name.startsWith('.task-create.'))).toHaveLength(1);
    await ageTaskLock(root);
    const next = await createTask(root, options());
    expect((await getTask(root, next.taskId)).hash).toBe(next.hash);
    expect((await readdir(runtime)).filter((name) => name.startsWith('.task-create.'))).toEqual([]);
  });

  it('preserves live, foreign, legacy, and unexpectedly populated staging with actionable diagnosis', async () => {
    const root = await fixture();
    const task = await createTask(root, options());
    const runtime = taskStorePaths(root).runtime;
    const host = sha256(hostname()).slice(0, 16);
    const departed = child('process.exit(0)');
    expect(departed.status).toBe(0);
    const names = [`.task-create.v1.${host}.${process.pid}.${task.taskId}`,
      `.task-create.v1.${'0'.repeat(16)}.${departed.pid}.${task.taskId}`,
      `.task-create.${task.taskId}`, `.task-create.v1.${host}.${departed.pid}.${task.taskId}`];
    for (const name of names) await mkdir(path.join(runtime, name), { mode: 0o700 });
    const sentinel = path.join(runtime, names[3], 'notes');
    await writeFile(sentinel, 'retain unrelated data');
    const result = await recoverTaskCreationStaging(root);
    expect(result.removed).toBe(0);
    expect(result.retained.map((item) => item.name).sort()).toEqual(names.sort());
    expect(result.retained.find((item) => item.name === `.task-create.${task.taskId}`).reason).toMatch(/stop all APE hosts.*manually/);
    expect(await readFile(sentinel, 'utf8')).toBe('retain unrelated data');
    expect((await getTask(root, task.taskId)).hash).toBe(task.hash);
  });
});

describe('governed writer locks retain live ownership', () => {
  it('rejects a contender when the opted-in holder is alive despite stale heartbeat metadata', async () => {
    const root = await fixture();
    const lock = path.join(root, 'tasks.lock');
    const settings = { requireProcessIdentity: true, staleMs: 10, heartbeatMs: 60_000, busyMs: 100, busyMessage: 'bounded contention' };
    let release;
    let entered;
    const ready = new Promise((resolve) => { entered = resolve; });
    const barrier = new Promise((resolve) => { release = resolve; });
    const holder = withDirLock(lock, async () => { entered(); await barrier; }, settings);
    await ready;
    try {
      const old = new Date(Date.now() - 120_000);
      await utimes(lock, old, old);
      const token = await readFile(path.join(lock, 'owner'), 'utf8');
      let secondEntered = false;
      await expect(withDirLock(lock, async () => { secondEntered = true; }, settings)).rejects.toThrow('bounded contention');
      expect(secondEntered).toBe(false);
      expect(await readFile(path.join(lock, 'owner'), 'utf8')).toBe(token);
    } finally { release(); await holder; }
  });
});

describe('metadata reads finish within bounded file work', () => {
  it('preserves generic JSON ledger size and missing-file contracts', async () => {
    const root = await fixture();
    const file = path.join(root, 'ledger.json');
    const value = { data: 'x'.repeat(9 * 1024 * 1024) };
    await writeFile(file, JSON.stringify(value));
    expect(await readJson(file)).toEqual(value);
    expect(await readJson(path.join(root, 'absent'), null)).toBeNull();
    await expect(readJson(path.join(root, 'absent'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it.skipIf(process.platform === 'win32')('preserves generic symlink-to-regular-file compatibility', async () => {
    const root = await fixture();
    const file = path.join(root, 'ledger.json');
    await writeFile(file, '{"compatible":true}');
    const linked = path.join(root, 'linked.json');
    await symlink(file, linked);
    expect(await readJson(linked)).toEqual({ compatible: true });
  });

  it.skipIf(process.platform === 'win32')('public status terminates when the roadmap ledger is a FIFO', async () => {
    const paths = runtimePaths(await fixture());
    await mkdir(paths.runtime, { recursive: true });
    expect(spawnSync('mkfifo', [path.join(paths.runtime, 'roadmap.json')]).status).toBe(0);
    const result = child(`import{statusRun}from${JSON.stringify(moduleUrl('status-service'))};
      try{console.log(JSON.stringify(await statusRun(${JSON.stringify(paths.root)})))}catch(error){console.log(JSON.stringify({error:error.message}))}`);
    expect(result.error, result.stderr).toBeUndefined();
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({ ok: true, active: false,
      roadmap: { corrupt: true, reason: 'JSON storage entry is not a regular file' } });
  });
  it('preserves unreadable owner metadata during automatic release', async () => {
    const file = path.join(await fixture(), 'active.lock');
    const bytes = JSON.stringify({ run_id: 'run-other-owner', detail: 'x'.repeat(64 * 1024) });
    await writeFile(file, bytes);
    await expect(releaseRunLock(file, 'run-current')).rejects.toThrow(/refusing to release.*unreadable/);
    expect(await readFile(file, 'utf8')).toBe(bytes);
  });
  it.skipIf(process.platform === 'win32').each(['active', 'history', 'run-lock', 'owner', 'process'])(
    'does not block on %s FIFO metadata', async (kind) => {
      const root = await fixture();
      const paths = runtimePaths(root);
      const lock = path.join(root, 'writer.lock');
      const file = kind === 'active' ? paths.active : kind === 'history' ? path.join(paths.history, 'run-fifo.json') :
        kind === 'run-lock' ? paths.lock : path.join(lock, kind);
      await mkdir(path.dirname(file), { recursive: true });
      expect(spawnSync('mkfifo', [file]).status).toBe(0);
      const old = new Date(Date.now() - 120_000);
      if (['owner', 'process'].includes(kind)) await utimes(lock, old, old);
      const expression = kind === 'active' || kind === 'history'
        ? `await compactArchivedArtifacts(runtimePaths(${JSON.stringify(root)}),{keepRecentRuns:0})`
        : kind === 'run-lock' ? `await inspectRunLock(${JSON.stringify(file)})`
          : `await withDirLock(${JSON.stringify(lock)},()=>{throw new Error('entered malformed owner')},{requireProcessIdentity:true,staleMs:1,heartbeatMs:1000,busyMs:50,busyMessage:'bounded contention'})`;
      const result = child(`import{runtimePaths}from${JSON.stringify(moduleUrl('paths'))};import{compactArchivedArtifacts}from${JSON.stringify(moduleUrl('retention'))};
        import{inspectRunLock,withDirLock}from${JSON.stringify(moduleUrl('lock'))};try{console.log(JSON.stringify(${expression}))}catch(error){console.log(JSON.stringify({error:error.message}))}`);
      expect(result.error, result.stderr).toBeUndefined();
      expect(result.status, result.stderr).toBe(0);
      if (kind === 'active') expect(JSON.parse(result.stdout).skipped).toBe('current-run-state-unreadable');
      else if (kind === 'history') expect(JSON.parse(result.stdout).error).toMatch(/bounded single-link/);
      else if (kind === 'run-lock') expect(JSON.parse(result.stdout)).toEqual({ present: true, readable: false });
      else expect(JSON.parse(result.stdout).error).toBe('bounded contention');
    });

  it('bounds both history active projections and refuses an oversized history write before publication', async () => {
    const paths = runtimePaths(await fixture());
    await mkdir(paths.runtime, { recursive: true });
    await writeFile(paths.active, '');
    await truncate(paths.active, 8 * 1024 * 1024 + 1);
    expect((await queryHistory(paths))[0]).toEqual({ run_id: 'unknown', status: 'corrupt_state', active: true });
    expect((await queryHistoryPage(paths)).records[0]).toEqual({ run_id: 'unknown', status: 'corrupt_state', active: true });
    const run = { ...terminalRun('run-history-oversized'), objective: 'x'.repeat(16 * 1024 * 1024) };
    await expect(archiveRun(paths, run)).rejects.toThrow(/durable file bound/);
    await expect(readFile(path.join(paths.history, `${run.run_id}.json`))).rejects.toMatchObject({ code: 'ENOENT' });
  });
});

describe('retention archive publication and byte budgets', () => {
  it('resumes an actual exit immediately after archive link publication', async () => {
    const { paths, run, source, archive } = await retentionFixture();
    const result = child(`import fs from'node:fs/promises';import{syncBuiltinESMExports}from'node:module';const link=fs.link;
      fs.link=async(from,to)=>{await link(from,to);if(String(to).endsWith('.json.gz'))process.exit(87);};syncBuiltinESMExports();
      const{runtimePaths}=await import(${JSON.stringify(moduleUrl('paths'))});const{compactArchivedArtifacts}=await import(${JSON.stringify(moduleUrl('retention'))});
      await compactArchivedArtifacts(runtimePaths(${JSON.stringify(paths.root)}),{keepRecentRuns:0});`);
    expect(result.status, result.stderr).toBe(87);
    expect(JSON.parse(await readFile(source, 'utf8')).run_id).toBe(run.run_id);
    expect((await compactArchivedArtifacts(paths, { keepRecentRuns: 0 })).removed_files).toBe(1);
    expect(await readdir(path.dirname(archive))).toEqual([path.basename(archive)]);
  });

  it('retains source artifacts when syncing the staged archive fails', async () => {
    const { paths, source, archive } = await retentionFixture();
    const result = child(`import fs from'node:fs/promises';import{syncBuiltinESMExports}from'node:module';const open=fs.open;
      fs.open=async(file,...args)=>{const handle=await open(file,...args);if(String(file).includes('artifact-archives')&&String(file).endsWith('.tmp'))handle.sync=async()=>{throw Object.assign(new Error('archive sync failed'),{code:'EIO'});};return handle;};syncBuiltinESMExports();
      const{runtimePaths}=await import(${JSON.stringify(moduleUrl('paths'))});const{compactArchivedArtifacts}=await import(${JSON.stringify(moduleUrl('retention'))});
      console.log(JSON.stringify(await compactArchivedArtifacts(runtimePaths(${JSON.stringify(paths.root)}),{keepRecentRuns:0})));`);
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({ removed_files: 0, failures: [{ code: 'EIO', reason: 'archive sync failed' }] });
    expect(await readFile(source, 'utf8')).toContain('run-recovery-retention');
    await expect(readFile(archive)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('bounds decompression before parsing an oversized existing archive', async () => {
    const { paths, source, archive } = await retentionFixture();
    await mkdir(path.dirname(archive), { recursive: true });
    await writeFile(archive, gzipSync(Buffer.alloc(64 * 1024 * 1024 + 1, 120)));
    const result = await compactArchivedArtifacts(paths, { keepRecentRuns: 0 });
    expect(result.removed_files).toBe(0);
    expect(result.failures[0].reason).toMatch(/larger than|size limit|length/i);
    expect(await readFile(source, 'utf8')).toContain('run-recovery-retention');
  });

  it('retains every loose artifact when their combined archive would exceed the expansion budget', async () => {
    const { paths, source, run, archive } = await retentionFixture();
    const receipts = [];
    for (let index = 0; index < 9; index += 1) {
      const receiptId = `receipt-budget-${index}`;
      const file = path.join(paths.receipts, `${receiptId}.json`);
      await atomicWriteJson(file, { run_id: run.run_id, receipt_id: receiptId, detail: 'x'.repeat(8 * 1024 * 1024 - 1024) });
      receipts.push(file);
    }
    const result = await compactArchivedArtifacts(paths, { keepRecentRuns: 0 });
    expect(result.removed_files).toBe(0);
    expect(result.failures[0].reason).toMatch(/bounded expanded size; source files retained/);
    expect(await readFile(source, 'utf8')).toContain(run.run_id);
    for (const file of receipts) expect((await readFile(file)).length).toBeGreaterThan(7 * 1024 * 1024);
    await expect(readFile(archive)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('refuses an oversized compressed file before decompression while preserving its sources', async () => {
    const { paths, source, archive } = await retentionFixture();
    await mkdir(path.dirname(archive), { recursive: true });
    await writeFile(archive, '');
    await truncate(archive, 65 * 1024 * 1024 + 1);
    const result = await compactArchivedArtifacts(paths, { keepRecentRuns: 0 });
    expect(result.removed_files).toBe(0);
    expect(result.failures[0].reason).toMatch(/bounded single-link/);
    expect(await readFile(source, 'utf8')).toContain('run-recovery-retention');
  });

  it('preserves an unrelated archive hardlink instead of treating it as recoverable publication', async () => {
    const { paths, source, archive } = await retentionFixture();
    expect((await compactArchivedArtifacts(paths, { keepRecentRuns: 0 })).removed_files).toBe(1);
    const run = terminalRun('run-recovery-retention');
    await atomicWriteJson(source, run);
    const other = path.join(path.dirname(archive), 'operator-copy');
    await link(archive, other);
    const result = await compactArchivedArtifacts(paths, { keepRecentRuns: 0 });
    expect(result.removed_files).toBe(0);
    expect(result.failures[0].reason).toMatch(/single-link/);
    expect(await readFile(other)).toEqual(await readFile(archive));
    expect(await readFile(source, 'utf8')).toContain(run.run_id);
  });
});
