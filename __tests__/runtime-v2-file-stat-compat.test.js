import { lstat, mkdtemp, open, realpath, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { activeState } from '../lib/runtime/active-state.js';
import { inspectAdmissionCommandPrerequisites } from '../lib/runtime/admission-command-prerequisites.js';
import { lstatFile, statFileHandle } from '../lib/runtime/file-stats.js';
import { readBoundedRegularFileUtf8 } from '../lib/runtime/spawn.js';

const scenario = vi.hoisted(() => ({ root: null, otherDevice: false, otherInode: false,
  zeroDevice: false, swappedHandle: false, opens: 0, disappearOnce: null }));
vi.mock('node:fs/promises', async (original) => {
  const actual = await original();
  const identity = (metadata, descriptor, ordinal = 0) => {
    // libuv before #4698 reports a 64-bit pathname volume serial but a
    // 32-bit descriptor serial. Numbers lose its low bits before masking.
    const device = descriptor
      ? 0xabcdef01n + BigInt(scenario.otherDevice || (scenario.swappedHandle && ordinal % 2 === 0))
      : scenario.zeroDevice ? 0n : 0x12345678abcdef01n;
    const inode = (1n << 60n) + 1n + BigInt(descriptor && scenario.otherInode);
    return Object.assign(Object.create(Object.getPrototypeOf(metadata)), metadata, {
      dev: typeof metadata.dev === 'bigint' ? device : Number(device),
      ino: typeof metadata.ino === 'bigint' ? inode : Number(inode),
    });
  };
  const selected = (file) => scenario.root && String(file).startsWith(scenario.root);
  return { ...actual,
    lstat: async (file, ...args) => {
      if (selected(file) && scenario.disappearOnce === 'recheck' && scenario.opens > 0) {
        scenario.disappearOnce = null;
        throw Object.assign(new Error('synthetic pathname replacement'), { code: 'ENOENT' });
      }
      const metadata = await actual.lstat(file, ...args);
      return selected(file) ? identity(metadata, false) : metadata;
    },
    open: async (file, ...args) => {
      if (selected(file) && scenario.disappearOnce === 'open') {
        scenario.disappearOnce = null;
        throw Object.assign(new Error('synthetic pathname replacement'), { code: 'ENOENT' });
      }
      const handle = await actual.open(file, ...args);
      if (selected(file)) {
        const ordinal = ++scenario.opens;
        const stat = handle.stat.bind(handle);
        handle.stat = async (...options) => identity(await stat(...options), true, ordinal);
      }
      return handle;
    },
  };
});

const platform = Object.getOwnPropertyDescriptor(process, 'platform');
const roots = [];
afterEach(async () => {
  Object.defineProperty(process, 'platform', platform);
  Object.assign(scenario, { root: null, otherDevice: false, otherInode: false,
    zeroDevice: false, swappedHandle: false, opens: 0, disappearOnce: null });
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

async function fixture() {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), 'ape-stat-compat-')));
  roots.push(root);
  const file = path.join(root, 'active.json');
  const state = { run_id: 'run-stat', status: 'running', stage: 'test', tickets: [], receipts: [] };
  await writeFile(file, JSON.stringify(state));
  await writeFile(path.join(root, 'fixture'), 'ordinary executable header');
  scenario.root = root;
  Object.defineProperty(process, 'platform', { ...platform, value: 'win32' });
  return { root, file, state };
}

describe('Windows descriptor and pathname file identity compatibility', () => {
  it('matches native pathname and descriptor identities for a real ordinary file', async () => {
    const root = await realpath(await mkdtemp(path.join(tmpdir(), 'ape-native-stat-')));
    roots.push(root);
    const file = path.join(root, 'ordinary.json');
    await writeFile(file, '{}');
    const handle = await open(file, 'r');
    const identity = (metadata) => ({ dev: String(metadata.dev), ino: String(metadata.ino) });
    try {
      const entry = await lstatFile(file);
      const descriptor = await statFileHandle(handle);
      const rawEntry = await lstat(file, { bigint: true });
      const rawDescriptor = await handle.stat({ bigint: true });
      expect(identity(entry), JSON.stringify({ node: process.version, platform: process.platform,
        rawEntry: identity(rawEntry), rawDescriptor: identity(rawDescriptor),
      })).toEqual(identity(descriptor));
    } finally {
      await handle.close();
    }
  });

  it('reads stable state despite the old libuv volume-serial representation difference', async () => {
    const value = await fixture();
    expect(await activeState({ active: value.file })).toEqual(value.state);
  });

  it('inspects a stable executable without executing it or dropping identity checks', async () => {
    const value = await fixture();
    expect(await inspectAdmissionCommandPrerequisites(value.root,
      [{ id: 'fixture', command: 'fixture', root: '.' }],
      [{ id: 'fixture', resolved: path.join(value.root, 'fixture') }],
    )).toEqual([]);
  });

  it('reads stable state and executable metadata when native pathname stats omit the device', async () => {
    const value = await fixture();
    scenario.zeroDevice = true;
    expect(await activeState({ active: value.file })).toEqual(value.state);
    expect(await inspectAdmissionCommandPrerequisites(value.root,
      [{ id: 'fixture', command: 'fixture', root: '.' }],
      [{ id: 'fixture', resolved: path.join(value.root, 'fixture') }],
    )).toEqual([]);
  });

  it('rejects a cross-device substitution between handles even when pathname devices are missing', async () => {
    const value = await fixture();
    Object.assign(scenario, { zeroDevice: true, swappedHandle: true });
    await expect(activeState({ active: value.file })).rejects.toMatchObject({ code: 'APE_ACTIVE_STATE_BUSY' });
    expect(await inspectAdmissionCommandPrerequisites(value.root,
      [{ id: 'fixture', command: 'fixture', root: '.' }],
      [{ id: 'fixture', resolved: path.join(value.root, 'fixture') }],
    )).toContainEqual(expect.objectContaining({ cause: 'executable-changed' }));
  });

  it('rejects a substituted inode while recovering missing pathname device metadata', async () => {
    const value = await fixture();
    Object.assign(scenario, { zeroDevice: true, otherInode: true });
    await expect(activeState({ active: value.file })).rejects.toMatchObject({ code: 'APE_ACTIVE_STATE_BUSY' });
  });

  it.each(['open', 'recheck'])('retries a replacement during device recovery %s without reporting no active run', async (point) => {
    const value = await fixture();
    Object.assign(scenario, { zeroDevice: true, disappearOnce: point });
    expect(await activeState({ active: value.file })).toEqual(value.state);
    expect(scenario.disappearOnce).toBeNull();
  });

  it.each(['otherDevice', 'otherInode'])('still rejects an actual %s mismatch', async (field) => {
    const value = await fixture();
    scenario[field] = true;
    await expect(activeState({ active: value.file })).rejects.toMatchObject({ code: 'APE_ACTIVE_STATE_BUSY' });
    expect(await inspectAdmissionCommandPrerequisites(value.root,
      [{ id: 'fixture', command: 'fixture', root: '.' }],
      [{ id: 'fixture', resolved: path.join(value.root, 'fixture') }],
    )).toContainEqual(expect.objectContaining({ cause: 'executable-changed' }));
  });
});


describe('standalone runner bounded manifest reader uses normalized file identities', () => {
  it.each([false, true])('reads exact bytes with zero pathname device=%s', async (zeroDevice) => {
    const value = await fixture();
    scenario.zeroDevice = zeroDevice;
    expect(JSON.parse(await readBoundedRegularFileUtf8(value.file))).toEqual(value.state);
  });

  it.each(['otherDevice', 'otherInode', 'swappedHandle'])('rejects substituted %s', async (field) => {
    const value = await fixture();
    scenario.zeroDevice = field === 'swappedHandle';
    scenario[field] = true;
    await expect(readBoundedRegularFileUtf8(value.file)).rejects.toThrow();
  });
});
