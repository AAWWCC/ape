import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  DEFAULT_CONFIG, detectAmbiguousConfigOverrides, loadRuntimeConfig, resolveModel, setRuntimeConfig,
} from '../lib/runtime/config.js';
import { doctor } from '../lib/runtime/doctor.js';
import { ROLE_POLICIES } from '../lib/runtime/constants.js';
import { runtimePaths } from '../lib/runtime/paths.js';
import { prepareNativeBindingProbe } from '../lib/runtime/service.js';

const cleanups = [];
afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function project() {
  const dir = await mkdtemp(path.join(tmpdir(), 'ape-codex-model-defaults-'));
  cleanups.push(dir);
  execFileSync('git', ['init', '-q'], { cwd: dir });
  const paths = runtimePaths(dir);
  await mkdir(paths.runtime, { recursive: true });
  return paths;
}

const provenance = (report) => report.checks.find((entry) => entry.name === 'config-override-provenance');
const shipped253 = {
  fast: { model: 'gpt-5.4-mini', reasoning_effort: 'low' },
  balanced: { model: 'gpt-5.5', reasoning_effort: 'medium' },
  deep: { model: 'gpt-5.5', reasoning_effort: 'high' },
};

describe('Codex model defaults', () => {
  it('adopts Astra at tier-specific efforts without changing Claude or materializing defaults', async () => {
    const paths = await project();
    await setRuntimeConfig(paths.config, 'policy.fast_max_files', 9);
    const before = await readFile(paths.config, 'utf8');
    const config = await loadRuntimeConfig(paths.config);
    expect(config.models.codex).toEqual({
      fast: { model: 'gpt-6-astra', reasoning_effort: 'low' },
      balanced: { model: 'gpt-6-astra', reasoning_effort: 'medium' },
      deep: { model: 'gpt-6-astra', reasoning_effort: 'high' },
    });
    expect(config.models.claude).toEqual({ fast: { model: 'haiku' }, balanced: { model: 'sonnet' }, deep: { model: 'opus' } });
    expect(JSON.parse(before)).not.toHaveProperty('models');
    expect(await readFile(paths.config, 'utf8')).toBe(before);
  });

  it.each([
    ['plan_checker', 'fast', 'low'],
    ['preflight_analyst', 'balanced', 'medium'],
    ['implementer', 'balanced', 'medium'],
    ['planner', 'deep', 'high'],
    ['security_reviewer', 'deep', 'high'],
  ])('routes %s through its unchanged tier and Astra effort', (role, tier, reasoning_effort) => {
    expect(ROLE_POLICIES[role].model_tier).toBe(tier);
    expect(resolveModel(DEFAULT_CONFIG, 'codex', tier, role)).toEqual({ model: 'gpt-6-astra', reasoning_effort });
  });

  it.each([
    [null, 'gpt-6-astra'],
    ['gpt-5.4-mini', 'gpt-5.4-mini'],
    ['operator-custom-model', 'operator-custom-model'],
  ])('prepares a probe using the effective fast model with override %s', async (override, expected) => {
    const paths = await project();
    if (override) await setRuntimeConfig(paths.config, 'models.codex.fast.model', override);
    const result = await prepareNativeBindingProbe(paths.root, {
      host: 'codex', explicit_invocation: true, hooks_trusted: true, subagents_available: true,
    });
    expect(result.ok).toBe(true);
    expect(result.actions).toHaveLength(1);
    expect(result.actions[0].dispatch.spawn_args).toMatchObject({
      model: expected, reasoning_effort: 'low', fork_turns: 'none',
    });
    expect(result.probe.model).toEqual({ model: expected, reasoning_effort: 'low' });
  });

  it('reports the materialized 2.25.3 models as ambiguous and preserves them until an explicit choice', async () => {
    const paths = await project();
    const oldDefaults = structuredClone(DEFAULT_CONFIG);
    oldDefaults.models.codex = structuredClone(shipped253);
    await writeFile(paths.config, JSON.stringify(oldDefaults));
    const before = await readFile(paths.config, 'utf8');
    const warning = Object.entries(shipped253).map(([tier, mapping]) => ({
      key: `models.codex.${tier}.model`, value: mapping.model, matches_shipped_default_of: '2.25.3',
    }));
    expect(detectAmbiguousConfigOverrides(oldDefaults)).toEqual(warning);
    expect((await loadRuntimeConfig(paths.config)).models.codex).toEqual(shipped253);
    expect(provenance(await doctor(paths.root, {}))).toMatchObject({
      passed: null, informational: true, warning: true, ambiguous_keys: warning.map((entry) => entry.key),
    });
    expect(await readFile(paths.config, 'utf8')).toBe(before);

    await setRuntimeConfig(paths.config, 'policy.fast_max_files', 9);
    const afterUnrelatedSet = JSON.parse(await readFile(paths.config, 'utf8'));
    for (const [tier, mapping] of Object.entries(shipped253)) {
      expect(afterUnrelatedSet.models.codex[tier].model).toBe(mapping.model);
    }
    expect(detectAmbiguousConfigOverrides(afterUnrelatedSet)).toEqual(warning);

    // Claiming a historical model is not an instruction to migrate it.
    for (const [tier, mapping] of Object.entries(shipped253)) {
      await setRuntimeConfig(paths.config, `models.codex.${tier}.model`, mapping.model);
      expect(resolveModel(await loadRuntimeConfig(paths.config), 'codex', tier)).toEqual(mapping);
    }
    expect(provenance(await doctor(paths.root, {}))).toMatchObject({ passed: true });
    expect(detectAmbiguousConfigOverrides(JSON.parse(await readFile(paths.config, 'utf8')))).toEqual([]);
  });

  it.each(Object.entries(shipped253))('preserves explicit %s pins at tier or leaf scope', (tier, mapping) => {
    for (const key of [`models.codex.${tier}`, `models.codex.${tier}.model`]) {
      expect(detectAmbiguousConfigOverrides({
        models: { codex: { [tier]: mapping } },
        explicit_keys: [key],
      })).toEqual([]);
    }
  });

  it('does not invent a shipped Luna snapshot or flag current defaults', () => {
    expect(detectAmbiguousConfigOverrides(DEFAULT_CONFIG)).toEqual([]);
    expect(detectAmbiguousConfigOverrides({ models: { codex: {
      fast: { model: 'gpt-5.6-luna', reasoning_effort: 'low' },
    } } })).toEqual([]);
  });
});
