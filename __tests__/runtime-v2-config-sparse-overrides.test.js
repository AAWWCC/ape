import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { configAction } from '../lib/runtime/service.js';
import {
  DEFAULT_CONFIG,
  detectAmbiguousConfigOverrides,
  loadRuntimeConfig,
  setRuntimeConfig,
} from '../lib/runtime/config.js';
import {
  GATE_INLINE_GRACE_MS,
  GATE_POLL_RETRY_DELAY_MS,
  GATE_RUNNER_HEARTBEAT_MS,
  GATE_RUNNER_MAX_SPAWNS,
  GATE_RUNNER_STALE_MS,
  RUNTIME_VERSION,
} from '../lib/runtime/constants.js';

// F36: config.json must stay a sparse overlay of explicit overrides, merged
// with the shipped defaults at load time. The old `set` materialized the whole
// default-merged object, so shipped-default fixes never reached existing
// installs. Every new write also records explicit-override provenance
// (explicit_keys) so a stored value can always be distinguished from a default
// materialized by an older release.
describe('ape v2 config sparse override persistence', () => {
  const dirs = [];
  afterEach(() => dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })));

  function project() {
    const dir = mkdtempSync(join(tmpdir(), 'ape-config-sparse-'));
    dirs.push(dir);
    return dir;
  }

  const configFile = (dir) => join(dir, '.ape', 'runtime', 'config.json');
  const stored = (dir) => JSON.parse(readFileSync(configFile(dir), 'utf8'));

  it('set persists only the explicit override plus its provenance, not materialized defaults', async () => {
    const dir = project();
    const { config } = await configAction(dir, 'set', { key: 'policy.fast_max_files', value: 8 });
    expect(config.policy.fast_max_files).toBe(8); // merged view is complete
    expect(config.models).toEqual(DEFAULT_CONFIG.models);
    expect(config.explicit_keys).toBeUndefined(); // ledger is disk-only metadata
    expect(stored(dir)).toEqual({
      policy: { fast_max_files: 8 },
      explicit_keys: ['policy.fast_max_files'],
    });
  });

  it('an explicit set equal to the shipped default persists as a claimed pin (F36)', async () => {
    const dir = project();
    await configAction(dir, 'set', { key: 'shipping.auto_merge', value: true });
    // The operator deliberately chose this value: it must survive a future
    // shipped-default change instead of being pruned as noise, and the
    // provenance records that it is intentional rather than materialized.
    expect(stored(dir)).toEqual({
      shipping: { auto_merge: true },
      explicit_keys: ['shipping.auto_merge'],
    });
    const { config } = await configAction(dir, 'get', {});
    expect(config.shipping.auto_merge).toBe(true);
  });

  it('migrates a previously materialized full config to sparse on the next set', async () => {
    const dir = project();
    mkdirSync(join(dir, '.ape', 'runtime'), { recursive: true });
    // Simulate an install whose first `set` (old behavior) baked in every
    // then-current default plus one deliberate project override.
    const materialized = structuredClone(DEFAULT_CONFIG);
    materialized.models.claude.deep = { model: 'fable' };
    writeFileSync(configFile(dir), JSON.stringify(materialized, null, 2));

    await configAction(dir, 'set', { key: 'test_commands.full', value: 'npm test' });

    // Legacy leaves equal to the current defaults are pruned; the divergent
    // fable leaf is preserved (never strip possible intent) but carries no
    // provenance — it is surfaced as ambiguous, not silently blessed.
    expect(stored(dir)).toEqual({
      models: { claude: { deep: { model: 'fable' } } },
      test_commands: { full: 'npm test' },
      explicit_keys: ['test_commands.full'],
    });
  });

  it('future shipped-default changes reach an install after it has set a key', async () => {
    const dir = project();
    await setRuntimeConfig(configFile(dir), 'policy.fast_max_files', 9);
    // Nothing besides the override and its provenance is on disk, so any key
    // the next release changes in DEFAULT_CONFIG is resolved from the shipped
    // defaults.
    const raw = stored(dir);
    expect(Object.keys(raw).sort()).toEqual(['explicit_keys', 'policy']);
    const loaded = await loadRuntimeConfig(configFile(dir));
    expect(loaded.deadlines_ms).toEqual(DEFAULT_CONFIG.deadlines_ms);
    expect(loaded.policy.fast_max_files).toBe(9);
    expect(loaded.explicit_keys).toBeUndefined();
  });

  it('a stale materialized version cannot shadow the shipped runtime version', async () => {
    const dir = project();
    mkdirSync(join(dir, '.ape', 'runtime'), { recursive: true });
    writeFileSync(configFile(dir), JSON.stringify({ version: 0, policy: { fast_max_files: 4 } }));

    const loaded = await loadRuntimeConfig(configFile(dir));
    expect(loaded.version).toBe(RUNTIME_VERSION);

    const next = await setRuntimeConfig(configFile(dir), 'policy.fast_max_files', 5);
    expect(next.version).toBe(RUNTIME_VERSION);
    expect(stored(dir)).toEqual({
      policy: { fast_max_files: 5 },
      explicit_keys: ['policy.fast_max_files'],
    }); // no version key persisted
  });

  it('rejects setting the runtime-owned reserved keys', async () => {
    const dir = project();
    await expect(configAction(dir, 'set', { key: 'explicit_keys', value: ['models.claude.deep'] }))
      .rejects.toThrow(/runtime-owned/);
    await expect(configAction(dir, 'set', { key: 'version', value: 99 }))
      .rejects.toThrow(/runtime-owned/);
  });
});

// N-c: the shipped gate-runner defaults and test_commands.impacted_template
// live in DEFAULT_CONFIG, sourced from the GATE_* constants (the single source
// of the default VALUES). ape_config get surfaces them; an override persists
// sparsely with provenance, exactly like every other subtree.
describe('ape v2 config gates subtree defaults and provenance (N-c)', () => {
  const dirs = [];
  afterEach(() => dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })));

  function project() {
    const dir = mkdtempSync(join(tmpdir(), 'ape-config-gates-sparse-'));
    dirs.push(dir);
    return dir;
  }

  const configFile = (dir) => join(dir, '.ape', 'runtime', 'config.json');
  const stored = (dir) => JSON.parse(readFileSync(configFile(dir), 'utf8'));

  it('ships the five gate knobs and impacted_template from the constants', () => {
    expect(DEFAULT_CONFIG.gates.inline_grace_ms).toBe(GATE_INLINE_GRACE_MS);
    expect(DEFAULT_CONFIG.gates.heartbeat_ms).toBe(GATE_RUNNER_HEARTBEAT_MS);
    expect(DEFAULT_CONFIG.gates.stale_ms).toBe(GATE_RUNNER_STALE_MS);
    expect(DEFAULT_CONFIG.gates.max_spawns).toBe(GATE_RUNNER_MAX_SPAWNS);
    expect(DEFAULT_CONFIG.gates.poll_retry_delay_ms).toBe(GATE_POLL_RETRY_DELAY_MS);
    expect(DEFAULT_CONFIG.test_commands.impacted_template).toBeNull();
  });

  it('ape_config get surfaces the gates defaults on a fresh install', async () => {
    const dir = project();
    const { config } = await configAction(dir, 'get', {});
    expect(config.gates.inline_grace_ms).toBe(GATE_INLINE_GRACE_MS);
    expect(config.gates.heartbeat_ms).toBe(GATE_RUNNER_HEARTBEAT_MS);
    expect(config.gates.stale_ms).toBe(GATE_RUNNER_STALE_MS);
    expect(config.gates.max_spawns).toBe(GATE_RUNNER_MAX_SPAWNS);
    expect(config.gates.poll_retry_delay_ms).toBe(GATE_POLL_RETRY_DELAY_MS);
    expect(config.test_commands.impacted_template).toBeNull();
  });

  it('persists a gates override sparsely and resolves the other knobs from the constants', async () => {
    const dir = project();
    const { config } = await configAction(dir, 'set', { key: 'gates.max_spawns', value: 5 });
    // Merged view: the override plus the constant-sourced defaults.
    expect(config.gates.max_spawns).toBe(5);
    expect(config.gates.heartbeat_ms).toBe(GATE_RUNNER_HEARTBEAT_MS);
    expect(config.gates.stale_ms).toBe(GATE_RUNNER_STALE_MS);
    expect(config.gates.inline_grace_ms).toBe(GATE_INLINE_GRACE_MS);
    expect(config.gates.poll_retry_delay_ms).toBe(GATE_POLL_RETRY_DELAY_MS);
    // Only the explicit override plus its provenance is on disk (sparse overlay).
    expect(stored(dir)).toEqual({ gates: { max_spawns: 5 }, explicit_keys: ['gates.max_spawns'] });
  });
});

// F36: values materialized under an OLDER shipped default cannot be told apart
// from intentional overrides by comparing with current defaults alone. The
// versioned legacy-default table detects them; provenance disambiguates them.
describe('ape v2 ambiguous legacy override detection (F36)', () => {
  const dirs = [];
  afterEach(() => dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })));

  function project() {
    const dir = mkdtempSync(join(tmpdir(), 'ape-config-legacy-'));
    dirs.push(dir);
    return dir;
  }

  const configFile = (dir) => join(dir, '.ape', 'runtime', 'config.json');
  const stored = (dir) => JSON.parse(readFileSync(configFile(dir), 'utf8'));

  it('flags an unclaimed leaf that matches a 2.0.21 shipped default but not the current one', () => {
    const ambiguous = detectAmbiguousConfigOverrides({
      models: { claude: { deep: { model: 'fable' } } },
    });
    expect(ambiguous).toEqual([
      { key: 'models.claude.deep.model', value: 'fable', matches_shipped_default_of: '2.0.21' },
    ]);
  });

  it('does not flag explicit overrides, current defaults, or never-shipped values', () => {
    // Claimed via provenance: intentional by construction.
    expect(detectAmbiguousConfigOverrides({
      models: { claude: { deep: { model: 'fable' } } },
      explicit_keys: ['models.claude.deep'],
    })).toEqual([]);
    // Equal to the current shipped default: a no-op, not ambiguous.
    expect(detectAmbiguousConfigOverrides({
      models: { claude: { deep: { model: 'opus' } } },
    })).toEqual([]);
    // Never shipped as a default: unambiguously an intentional override.
    expect(detectAmbiguousConfigOverrides({
      models: { claude: { deep: { model: 'claude-fable-5' } } },
    })).toEqual([]);
  });

  it('an ambiguous legacy value is never stripped, and re-setting it claims it permanently', async () => {
    const dir = project();
    mkdirSync(join(dir, '.ape', 'runtime'), { recursive: true });
    // A snapshot materialized while 2.0.21 shipped fable-on-deep.
    writeFileSync(configFile(dir), JSON.stringify({
      models: {
        claude: {
          fast: { model: 'sonnet' },
          balanced: { model: 'opus' },
          deep: { model: 'fable' },
        },
      },
    }));

    // Unrelated writes preserve the ambiguous leaves (never silently strip).
    await configAction(dir, 'set', { key: 'policy.fast_max_files', value: 7 });
    expect(stored(dir).models.claude.deep).toEqual({ model: 'fable' });
    expect(detectAmbiguousConfigOverrides(stored(dir)).map((entry) => entry.key)).toEqual([
      'models.claude.fast.model',
      'models.claude.balanced.model',
      'models.claude.deep.model',
    ]);

    // The operator claims the intentional override; provenance disambiguates.
    await configAction(dir, 'set', { key: 'models.claude.deep', value: { model: 'fable' } });
    const raw = stored(dir);
    expect(raw.models.claude.deep).toEqual({ model: 'fable' });
    expect(raw.explicit_keys).toContain('models.claude.deep');
    expect(detectAmbiguousConfigOverrides(raw).map((entry) => entry.key)).toEqual([
      'models.claude.fast.model',
      'models.claude.balanced.model',
    ]);
  });
});

// F36 fidelity for the retired gates.inline_grace_ms=10000 shipped default:
// #308 retuned the shipped inline grace from 10000 to 300000 while 2.6.2 was
// the released carrier of the old value. A pre-sparse install whose
// config.json still carries a provenance-less materialized
// `gates.inline_grace_ms: 10000` is therefore ambiguous — a frozen old
// default or a deliberate 10s override — and must be surfaced by
// detectAmbiguousConfigOverrides (the doctor's config-override-provenance
// source) as matching the '2.6.2' shipped default, while an explicitly
// provenanced 10000 stays honored verbatim.
describe('ape v2 retired gates.inline_grace_ms=10000 legacy-default detection (F36)', () => {
  const dirs = [];
  afterEach(() => dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })));

  function project() {
    const dir = mkdtempSync(join(tmpdir(), 'ape-config-grace-legacy-'));
    dirs.push(dir);
    return dir;
  }

  const configFile = (dir) => join(dir, '.ape', 'runtime', 'config.json');
  const stored = (dir) => JSON.parse(readFileSync(configFile(dir), 'utf8'));

  it('flags a provenance-less materialized inline_grace_ms of 10000 as the frozen 2.6.2 shipped default', () => {
    expect(detectAmbiguousConfigOverrides({
      gates: { inline_grace_ms: 10000 },
    })).toEqual([
      { key: 'gates.inline_grace_ms', value: 10000, matches_shipped_default_of: '2.6.2' },
    ]);
  });

  it('honors an explicit 10000 override set via config set verbatim and never flags it', async () => {
    const dir = project();
    await configAction(dir, 'set', { key: 'gates.inline_grace_ms', value: 10000 });
    // Provenance is recorded, the value survives on disk, and detection stays
    // silent: the operator claimed the 10s grace deliberately (strict
    // per-call-timeout hosts).
    const raw = stored(dir);
    expect(raw.gates.inline_grace_ms).toBe(10000);
    expect(raw.explicit_keys).toContain('gates.inline_grace_ms');
    expect(detectAmbiguousConfigOverrides(raw)).toEqual([]);
    // The merged view resolves the override, not the current shipped default.
    const { config } = await configAction(dir, 'get', {});
    expect(config.gates.inline_grace_ms).toBe(10000);
  });

  it('an explicit_keys ledger entry alone disambiguates an already-stored 10000', () => {
    expect(detectAmbiguousConfigOverrides({
      gates: { inline_grace_ms: 10000 },
      explicit_keys: ['gates.inline_grace_ms'],
    })).toEqual([]);
  });

  it('does not flag the current shipped grace default or a never-shipped grace value', () => {
    // Equal to the current shipped default: a no-op, not ambiguous.
    expect(detectAmbiguousConfigOverrides({
      gates: { inline_grace_ms: GATE_INLINE_GRACE_MS },
    })).toEqual([]);
    // Never shipped as a default: unambiguously an intentional override.
    expect(detectAmbiguousConfigOverrides({
      gates: { inline_grace_ms: 45000 },
    })).toEqual([]);
  });

  it('pins the ambiguity precondition: 10000 is no longer the shipped inline grace', () => {
    // If a future retune ever ships 10000 again, the '2.6.2' legacy snapshot
    // would collide with the current default and detection would be
    // unreachable for this leaf — this guard makes that drift loud.
    expect(GATE_INLINE_GRACE_MS).not.toBe(10000);
    expect(DEFAULT_CONFIG.gates.inline_grace_ms).toBe(GATE_INLINE_GRACE_MS);
  });
});
