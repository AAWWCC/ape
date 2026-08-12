import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { configAction } from '../lib/runtime/service.js';

// The MCP `value` field is loosely typed; some clients deliver structured values
// as JSON strings. Regression: `ape_config set models.claude.fast '{"model":"opus"}'`
// stored the literal string, corrupting the config (the runtime then read a
// string where it expected {model: ...}). configAction must coerce.
describe('ape v2 config set value coercion', () => {
  const dirs = [];
  afterEach(() => dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })));

  function project() {
    const dir = mkdtempSync(join(tmpdir(), 'ape-config-set-'));
    dirs.push(dir);
    return dir;
  }

  const setGet = async (dir, key, value) => {
    await configAction(dir, 'set', { key, value });
    const { config } = await configAction(dir, 'get', {});
    return config;
  };

  it('coerces a stringified object into a real object', async () => {
    const dir = project();
    const config = await setGet(dir, 'models.claude.fast', '{"model":"opus"}');
    expect(config.models.claude.fast).toEqual({ model: 'opus' });
    expect(typeof config.models.claude.fast).toBe('object');
  });

  it('coerces stringified scalars (number, boolean)', async () => {
    const dir = project();
    let config = await setGet(dir, 'policy.fast_max_files', '8');
    expect(config.policy.fast_max_files).toBe(8);
    config = await setGet(dir, 'shipping.auto_merge', 'false');
    expect(config.shipping.auto_merge).toBe(false);
  });

  it('leaves genuine strings untouched', async () => {
    const dir = project();
    let config = await setGet(dir, 'test_commands.full', 'npm test');
    expect(config.test_commands.full).toBe('npm test');
    config = await setGet(dir, 'models.claude.deep.model', 'opus');
    expect(config.models.claude.deep.model).toBe('opus');
  });

  it('passes through an already-typed object value', async () => {
    const dir = project();
    const config = await setGet(dir, 'models.claude.balanced', { model: 'sonnet' });
    expect(config.models.claude.balanced).toEqual({ model: 'sonnet' });
  });
});

// Stored type-invalid values detonate far from the set: `deadlines_ms.fast
// "30m"` passes doctor, then the next fast start throws RangeError in the
// ticket deadline math AFTER acquire_lock and before persist_state — wedging
// the run lock with no active run to abort. `set` must fail loudly instead.
describe('ape v2 config set type validation against the defaults tree', () => {
  const dirs = [];
  afterEach(() => dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })));

  function project() {
    const dir = mkdtempSync(join(tmpdir(), 'ape-config-validate-'));
    dirs.push(dir);
    return dir;
  }

  it('rejects a human-shaped deadline string, naming the key and expected type', async () => {
    const dir = project();
    await expect(configAction(dir, 'set', { key: 'deadlines_ms.fast', value: '30m' }))
      .rejects.toThrow(/deadlines_ms\.fast.*finite number/);
    // Nothing was persisted: the next load still sees the shipped default.
    const { config } = await configAction(dir, 'get', {});
    expect(typeof config.deadlines_ms.fast).toBe('number');
  });

  it('rejects replacing a known object subtree with a scalar', async () => {
    const dir = project();
    await expect(configAction(dir, 'set', { key: 'deadlines_ms', value: 'fast' }))
      .rejects.toThrow(/deadlines_ms.*object/);
  });

  it('rejects a wrong-typed leaf inside a known object value', async () => {
    const dir = project();
    await expect(configAction(dir, 'set', { key: 'shipping', value: { auto_merge: 'yes' } }))
      .rejects.toThrow(/shipping\.auto_merge.*boolean/);
  });

  it('accepts string and null for the nullable test_commands slots', async () => {
    const dir = project();
    let config = (await configAction(dir, 'set', { key: 'test_commands.targeted', value: 'npm test -- {paths}' })).config;
    expect(config.test_commands.targeted).toBe('npm test -- {paths}');
    config = (await configAction(dir, 'set', { key: 'test_commands.targeted', value: null })).config;
    expect(config.test_commands.targeted).toBeNull();
    await expect(configAction(dir, 'set', { key: 'test_commands.targeted', value: 42 }))
      .rejects.toThrow(/test_commands\.targeted.*string or null/);
  });

  it('rejects nesting beneath a known scalar leaf', async () => {
    const dir = project();
    await expect(configAction(dir, 'set', { key: 'policy.fast_max_files.max', value: 9 }))
      .rejects.toThrow(/policy\.fast_max_files/);
  });

  it('leaves unknown keys unvalidated (no shipped shape to enforce)', async () => {
    const dir = project();
    const { config } = await configAction(dir, 'set', { key: 'custom.anything', value: '30m' });
    expect(config.custom.anything).toBe('30m');
  });
});

// N-c: the shipped gate-runner knobs (config.gates.*) and the impacted-test
// template (test_commands.impacted_template) now live in DEFAULT_CONFIG, so
// `set` validates their types at set time. A gates knob is a finite number; the
// impacted template is a string-or-null slot exactly like the other
// test_commands.* templates. Without them in DEFAULT_CONFIG, set-time validation
// early-returns and silently accepts a type-invalid value that detonates later.
describe('ape v2 config set gates subtree and impacted_template validation (N-c)', () => {
  const dirs = [];
  afterEach(() => dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })));

  function project() {
    const dir = mkdtempSync(join(tmpdir(), 'ape-config-gates-'));
    dirs.push(dir);
    return dir;
  }

  it('rejects a non-number gates knob, naming the key and expected type', async () => {
    const dir = project();
    await expect(configAction(dir, 'set', { key: 'gates.max_spawns', value: 'thrice' }))
      .rejects.toThrow(/gates\.max_spawns.*finite number/);
    await expect(configAction(dir, 'set', { key: 'gates.poll_retry_delay_ms', value: 'soon' }))
      .rejects.toThrow(/gates\.poll_retry_delay_ms.*finite number/);
    // Nothing persisted: the next load still resolves the shipped default.
    const { config } = await configAction(dir, 'get', {});
    expect(typeof config.gates.max_spawns).toBe('number');
  });

  it('accepts a numeric gates knob', async () => {
    const dir = project();
    const { config } = await configAction(dir, 'set', { key: 'gates.stale_ms', value: 45000 });
    expect(config.gates.stale_ms).toBe(45000);
  });

  it('rejects a non-string/non-null test_commands.impacted_template', async () => {
    const dir = project();
    await expect(configAction(dir, 'set', { key: 'test_commands.impacted_template', value: 42 }))
      .rejects.toThrow(/test_commands\.impacted_template.*string or null/);
  });

  it('accepts a string or null impacted_template', async () => {
    const dir = project();
    let config = (await configAction(dir, 'set', {
      key: 'test_commands.impacted_template',
      value: 'npx vitest related --run {paths}',
    })).config;
    expect(config.test_commands.impacted_template).toBe('npx vitest related --run {paths}');
    config = (await configAction(dir, 'set', { key: 'test_commands.impacted_template', value: null })).config;
    expect(config.test_commands.impacted_template).toBeNull();
  });
});

// A dotted set beneath a stored array used to set a named property on the
// array object; JSON.stringify drops non-index array properties, so the call
// returned ok while persisting nothing — silent data loss on a success
// response.
describe('ape v2 config set beneath arrays', () => {
  const dirs = [];
  afterEach(() => dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })));

  function project() {
    const dir = mkdtempSync(join(tmpdir(), 'ape-config-array-'));
    dirs.push(dir);
    return dir;
  }

  it('errors on a named key beneath an array instead of silently persisting nothing', async () => {
    const dir = project();
    await configAction(dir, 'set', { key: 'custom.list', value: [1, 2] });
    await expect(configAction(dir, 'set', { key: 'custom.list.name', value: 'x' }))
      .rejects.toThrow(/custom\.list is an array; only numeric indices/);
    // The refused set persisted nothing extra.
    const { config } = await configAction(dir, 'get', {});
    expect(config.custom.list).toEqual([1, 2]);
  });

  it('keeps numeric-index sets beneath an array working', async () => {
    const dir = project();
    await configAction(dir, 'set', { key: 'custom.list', value: [1, 2] });
    await configAction(dir, 'set', { key: 'custom.list.0', value: 9 });
    const { config } = await configAction(dir, 'get', {});
    expect(config.custom.list).toEqual([9, 2]);
  });
});
