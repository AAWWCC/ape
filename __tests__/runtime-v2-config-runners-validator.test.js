import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { configAction } from '../lib/runtime/service.js';
import { DEFAULT_CONFIG } from '../lib/runtime/config.js';

// runners-config-validator: `runners` is a new array-of-objects config list
// (the config foundation for the polyglot multi-runner gate). It ships as an
// empty list in DEFAULT_CONFIG, and `ape_config set runners <value>` must
// validate the whole list at SET TIME — mirroring the deadlines_ms set-time
// discipline — so a malformed list fails LOUDLY and never persists (invariant 7:
// atomic set-time validation; invariant 8: truthful). These behavioral tests
// exercise only the public config surface (DEFAULT_CONFIG + configAction
// set/get); they never reach into the validator's internals.

// A fully-valid runner element. Overrides let each test introduce exactly one
// fault while every other field stays valid, so a rejection can only be caused
// by the intended defect.
function runner(overrides = {}) {
  return {
    id: 'js',
    owns: ['packages/js/**'],
    root: 'packages/js',
    profile: { targeted_template: 'npx vitest run {paths}', full: 'npx vitest run', targeted: null },
    ...overrides,
  };
}

const dirs = [];
afterEach(() => dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })));

function project() {
  const dir = mkdtempSync(join(tmpdir(), 'ape-config-runners-'));
  dirs.push(dir);
  return dir;
}

const set = (dir, value) => configAction(dir, 'set', { key: 'runners', value });
const get = async (dir) => (await configAction(dir, 'get', {})).config;

describe('APE v2 runners config: shipped default', () => {
  it('exposes runners as an empty array on DEFAULT_CONFIG', () => {
    expect(DEFAULT_CONFIG.runners).toEqual([]);
  });

  it('surfaces an empty runners list on a fresh (unconfigured) project', async () => {
    const dir = project();
    const config = await get(dir);
    expect(config.runners).toEqual([]);
  });
});

describe('APE v2 runners config: valid lists persist and round-trip', () => {
  it('accepts a single well-formed runner and round-trips it verbatim', async () => {
    const dir = project();
    const runners = [runner()];
    await set(dir, runners);
    const config = await get(dir);
    expect(config.runners).toEqual(runners);
  });

  it('accepts multiple runners with distinct ids', async () => {
    const dir = project();
    const runners = [
      runner({ id: 'js' }),
      runner({ id: 'py', owns: ['packages/py/**'], root: 'packages/py', profile: { full: 'pytest' } }),
    ];
    await set(dir, runners);
    const config = await get(dir);
    expect(config.runners).toEqual(runners);
  });

  it('accepts an explicit empty list', async () => {
    const dir = project();
    await set(dir, []);
    const config = await get(dir);
    expect(config.runners).toEqual([]);
  });

  it('accepts a runner whose profile mixes string and null slots', async () => {
    const dir = project();
    const runners = [runner({ profile: { targeted: null, full: 'npx vitest run', targeted_template: null } })];
    await set(dir, runners);
    const config = await get(dir);
    expect(config.runners).toEqual(runners);
  });
});

describe('APE v2 runners config: malformed lists fail loudly at set time and never persist', () => {
  it('rejects a non-array runners value (object)', async () => {
    const dir = project();
    await expect(set(dir, { id: 'js' })).rejects.toThrow(/runner/i);
    expect((await get(dir)).runners).toEqual([]);
  });

  it('rejects a non-array runners value (string)', async () => {
    const dir = project();
    await expect(set(dir, 'packages/**')).rejects.toThrow(/runner/i);
    expect((await get(dir)).runners).toEqual([]);
  });

  it('rejects a list element that is not an object', async () => {
    const dir = project();
    await expect(set(dir, ['not-an-object'])).rejects.toThrow(/runner/i);
    expect((await get(dir)).runners).toEqual([]);
  });

  it('rejects an element with an empty-string id', async () => {
    const dir = project();
    await expect(set(dir, [runner({ id: '' })])).rejects.toThrow(/runner/i);
    expect((await get(dir)).runners).toEqual([]);
  });

  it('rejects an element with a non-string id', async () => {
    const dir = project();
    await expect(set(dir, [runner({ id: 42 })])).rejects.toThrow(/runner/i);
    expect((await get(dir)).runners).toEqual([]);
  });

  it('rejects an element whose owns is not an array', async () => {
    const dir = project();
    await expect(set(dir, [runner({ owns: 'packages/js/**' })])).rejects.toThrow(/runner/i);
    expect((await get(dir)).runners).toEqual([]);
  });

  it('rejects an element with an empty owns list', async () => {
    const dir = project();
    await expect(set(dir, [runner({ owns: [] })])).rejects.toThrow(/runner/i);
    expect((await get(dir)).runners).toEqual([]);
  });

  it('rejects an element whose owns contains a non-string entry', async () => {
    const dir = project();
    await expect(set(dir, [runner({ owns: ['packages/js/**', 42] })])).rejects.toThrow(/runner/i);
    expect((await get(dir)).runners).toEqual([]);
  });

  it('rejects an element with a non-string root', async () => {
    const dir = project();
    await expect(set(dir, [runner({ root: 42 })])).rejects.toThrow(/runner/i);
    expect((await get(dir)).runners).toEqual([]);
  });

  it('rejects an element whose profile slot is neither string nor null', async () => {
    const dir = project();
    await expect(set(dir, [runner({ profile: { full: 42 } })])).rejects.toThrow(/runner/i);
    expect((await get(dir)).runners).toEqual([]);
  });

  it('rejects two elements that share the same id', async () => {
    const dir = project();
    const runners = [runner({ id: 'dup' }), runner({ id: 'dup', owns: ['packages/py/**'], root: 'packages/py' })];
    await expect(set(dir, runners)).rejects.toThrow(/runner/i);
    expect((await get(dir)).runners).toEqual([]);
  });
});
