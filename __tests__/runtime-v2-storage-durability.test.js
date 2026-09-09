import { mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

const faults = vi.hoisted(() => ({ rename: false, syncFile: null, events: [] }));
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    rename: async (...args) => {
      faults.events.push(['rename', ...args]);
      if (faults.rename) throw Object.assign(new Error('injected sharing violation'), { code: 'EPERM' });
      return actual.rename(...args);
    },
    open: async (file, ...args) => {
      const handle = await actual.open(file, ...args);
      const sync = handle.sync.bind(handle);
      vi.spyOn(handle, 'sync').mockImplementation(async () => {
        faults.events.push(['sync', file]);
        if (faults.syncFile?.(file)) throw Object.assign(new Error('injected sync failure'), { code: 'EIO' });
        return sync();
      });
      return handle;
    },
  };
});
import { appendJsonLine, atomicReplaceText, atomicWriteJson, publishImmutableJson } from '../lib/runtime/storage.js';

const platformDescriptor = Object.getOwnPropertyDescriptor(process, 'platform');
const cleanups = [];
afterEach(async () => {
  Object.defineProperty(process, 'platform', platformDescriptor);
  faults.rename = false;
  faults.syncFile = null;
  faults.events = [];
  vi.restoreAllMocks();
  await Promise.all(cleanups.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});
async function fixture() {
  const dir = await mkdtemp(path.join(tmpdir(), 'ape-storage-durability-'));
  cleanups.push(dir);
  return { dir, file: path.join(dir, 'state.json') };
}

describe('durable writes retain complete state on failures', () => {
  it('exhausted Windows sharing violations preserve caller settings and clean staging files', async () => {
    const { dir, file } = await fixture();
    await writeFile(file, 'original caller settings\n');
    Object.defineProperty(process, 'platform', { ...platformDescriptor, value: 'win32' });
    faults.rename = true;
    await expect(atomicReplaceText(file, 'replacement settings\n')).rejects.toMatchObject({ code: 'EPERM' });
    expect(await readFile(file, 'utf8')).toBe('original caller settings\n');
    expect(await readdir(dir)).toEqual(['state.json']);
    expect(faults.events.filter(([kind]) => kind === 'rename')).toHaveLength(11);
  });

  it('a staged-content sync failure preserves the previous JSON and leaves no partial temporary', async () => {
    const { dir, file } = await fixture();
    await atomicWriteJson(file, { generation: 1 });
    faults.syncFile = (entry) => String(entry).endsWith('.tmp');
    await expect(atomicWriteJson(file, { generation: 2 })).rejects.toMatchObject({ code: 'EIO' });
    expect(JSON.parse(await readFile(file, 'utf8'))).toEqual({ generation: 1 });
    expect(await readdir(dir)).toEqual(['state.json']);
  });

  it('audit writes await content sync and surface durability failures', async () => {
    const { dir, file } = await fixture();
    await appendJsonLine(file, { event: 'first' });
    expect(faults.events).toContainEqual(['sync', file]);
    if (process.platform !== 'win32') expect(faults.events).toContainEqual(['sync', dir]);
    faults.syncFile = (entry) => entry === file;
    await expect(appendJsonLine(file, { event: 'second' })).rejects.toMatchObject({ code: 'EIO' });
    expect((await readFile(file, 'utf8')).trim().split('\n').map(JSON.parse)).toEqual([
      { event: 'first' }, { event: 'second' },
    ]);
  });

  it.skipIf(process.platform === 'win32')('a directory sync failure is reported after atomic replacement', async () => {
    const { dir, file } = await fixture();
    await atomicWriteJson(file, { generation: 1 });
    faults.syncFile = (entry) => entry === dir;
    await expect(atomicWriteJson(file, { generation: 2 })).rejects.toMatchObject({ code: 'EIO' });
    expect(JSON.parse(await readFile(file, 'utf8'))).toEqual({ generation: 2 });
    expect(await readdir(dir)).toEqual(['state.json']);
  });

  it('immutable selectors have one link before their publication directory is synced', async () => {
    const { dir, file } = await fixture();
    faults.syncFile = (entry) => entry === dir;
    if (process.platform === 'win32') {
      await expect(publishImmutableJson(file, { generation: 1 })).resolves.toBe(true);
    } else {
      await expect(publishImmutableJson(file, { generation: 1 })).rejects.toMatchObject({ code: 'EIO' });
    }
    expect((await stat(file)).nlink).toBe(1);
    expect(JSON.parse(await readFile(file, 'utf8'))).toEqual({ generation: 1 });
    expect(await readdir(dir)).toEqual(['state.json']);
  });
});
