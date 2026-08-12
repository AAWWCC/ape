import { describe, it, expect, afterEach } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { configAction } from '../lib/runtime/service.js';

// Polyglot onboarding (`ape_config init`): extending foreign-repo onboarding to
// PROPOSE (and, on apply, persist) a `runners` list for a POLYGLOT tree — two or
// more distinct runner FAMILIES across subdirectories. Today proposeTestCommands
// inspects ONLY the repo root and never emits a `runners` key (config.js), so the
// polyglot/persist/determinism assertions below FAIL now (RED) and pass once the
// implementation lands.
//
// These drive the PUBLIC configAction('init') surface used by
// runtime-v2-config-init.test.js and runtime-v2-config-init-modifiers.test.js:
// init (no apply) returns the grounded proposal under `init.proposal`; init
// apply:true persists through the config set/merge machinery (explicit_keys
// provenance, the existing runners set-time validator). Expectations are derived
// from the public contract — a per-runner {id, owns, root, profile} entry, sorted
// by root, grounded family profiles as FLAT string|null slots (never the
// {value,rationale} proposal wrapper), deterministic across calls, no writes on
// propose — never from implementation detail. Grounded SUBSTRINGS ('vitest',
// 'pytest', '{paths}') and shape are asserted, never byte-exact whole commands.
// All fixtures live under os.tmpdir() mkdtemp so the project tree SHA is
// untouched; temp dirs are removed in afterEach.

const VITEST_PKG = JSON.stringify({
  name: 'fixture-web',
  version: '1.0.0',
  scripts: { test: 'vitest run' },
  devDependencies: { vitest: '^2.0.0' },
}, null, 2);

// A genuine non-JS pytest manifest (matches the modifier suite's pytestProject):
// a pyproject.toml with a pytest table and NO package.json, so detectTestRunner
// resolves the `python` family rather than `javascript`.
const PYTEST_TOML = '[tool.pytest.ini_options]\naddopts = ""\n';

const dirs = [];
afterEach(() => dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })));

const configFile = (dir) => join(dir, '.ape', 'runtime', 'config.json');
const stored = (dir) => JSON.parse(readFileSync(configFile(dir), 'utf8'));

function tempProject(prefix) {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

function writeNested(dir, rel, content) {
  const full = join(dir, rel);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, content);
}

// POLYGLOT: subdir web/ (vitest package.json) + subdir api/ (pytest pyproject),
// NO root manifest — two distinct runner families across subdirectories. This is
// also the "repo ROOT has no manifest" case: apply must still persist its runners
// (the empty-test_commands proposal must not refuse).
function polyglotProject(prefix = 'ape-onboard-polyglot-') {
  const dir = tempProject(prefix);
  writeNested(dir, join('web', 'package.json'), VITEST_PKG);
  writeNested(dir, join('api', 'pyproject.toml'), PYTEST_TOML);
  return dir;
}

// A polyglot tree that also carries package.json manifests inside excluded dirs
// (node_modules/, dist/): those are dependency/build artifacts, never runner
// roots, so traversal must skip them.
function polyglotWithExcludedDirs() {
  const dir = polyglotProject('ape-onboard-excluded-');
  writeNested(dir, join('node_modules', 'leftpad', 'package.json'), VITEST_PKG);
  writeNested(dir, join('dist', 'package.json'), VITEST_PKG);
  return dir;
}

// SINGLE-RUNNER / non-polyglot: a JS runner at the repo root only.
function jsRootProject() {
  const dir = tempProject('ape-onboard-jsroot-');
  writeFileSync(join(dir, 'package.json'), VITEST_PKG);
  return dir;
}

// SINGLE-FAMILY monorepo: two vitest subdirs, one family — NOT polyglot, so it
// must NOT emit a runners key.
function sameFamilyMonorepo() {
  const dir = tempProject('ape-onboard-monorepo-');
  writeNested(dir, join('web', 'package.json'), VITEST_PKG);
  writeNested(dir, join('admin', 'package.json'), JSON.stringify({
    name: 'fixture-admin',
    version: '1.0.0',
    scripts: { test: 'vitest run' },
    devDependencies: { vitest: '^2.0.0' },
  }, null, 2));
  return dir;
}

// init (no apply) returns the grounded proposal under `init.proposal`; unwrap it
// (mirrors runtime-v2-config-init.test.js's initResult) and confirm propose never
// applies/writes.
async function proposeInit(dir) {
  const res = await configAction(dir, 'init', {});
  expect(res.ok).toBe(true);
  const init = res.init ?? res;
  expect(init.applied).toBe(false);
  return init.proposal;
}

const byRoot = (runners, root) => runners.find((entry) => entry.root === root);

describe('ape v2 polyglot onboarding: runners proposal', () => {
  // ---- 1. POLYGLOT PROPOSAL (RED anchor) --------------------------------
  it('proposes a sorted runners list of {id,owns,root,profile} entries grounded per subdir family, writing nothing', async () => {
    const dir = polyglotProject();
    const proposal = await proposeInit(dir);

    // The proposal ALSO carries a runners array alongside test_commands.
    expect(Array.isArray(proposal.runners)).toBe(true);
    expect(proposal.runners.length).toBeGreaterThanOrEqual(2);

    // Deterministic order: sorted by root, so 'api' precedes 'web'.
    const roots = proposal.runners.map((entry) => entry.root);
    expect(roots).toEqual([...roots].sort());
    expect(roots).toContain('api');
    expect(roots).toContain('web');
    expect(roots.indexOf('api')).toBeLessThan(roots.indexOf('web'));

    const api = byRoot(proposal.runners, 'api');
    const web = byRoot(proposal.runners, 'web');

    // id: a non-empty stable slug, distinct per runner.
    for (const entry of [api, web]) {
      expect(typeof entry.id).toBe('string');
      expect(entry.id.length).toBeGreaterThan(0);
    }
    expect(api.id).not.toBe(web.id);

    // owns: a glob list covering the runner's subtree.
    expect(Array.isArray(api.owns)).toBe(true);
    expect(api.owns).toContain('api/**');
    expect(Array.isArray(web.owns)).toBe(true);
    expect(web.owns).toContain('web/**');

    // profile: a FLAT test_commands-shaped object (string|null slots), grounded
    // in the detected family — never the {value, rationale} proposal wrapper.
    expect(web.profile).toBeTruthy();
    expect(typeof web.profile).toBe('object');
    expect(typeof web.profile.full).toBe('string'); // not a {value,rationale} wrapper
    expect(web.profile.full).toContain('vitest');
    expect(typeof web.profile.targeted_template).toBe('string');
    expect(web.profile.targeted_template).toContain('vitest');
    expect(web.profile.targeted_template).toContain('{paths}');

    expect(typeof api.profile.full).toBe('string');
    expect(api.profile.full).toContain('pytest');

    // Propose performs NO writes.
    expect(existsSync(join(dir, '.ape'))).toBe(false);
  });

  // ---- 2. SINGLE-RUNNER PROPOSAL: no runners key ------------------------
  it('a JS-at-root single-runner tree proposes NO runners key and an unchanged test_commands proposal', async () => {
    const dir = jsRootProject();
    const proposal = await proposeInit(dir);

    // Non-polyglot: byte-identical to today's single-suite proposal — no runners.
    expect('runners' in proposal).toBe(false);

    // The grounded test_commands proposal is still present and unchanged.
    expect(proposal.test_commands.full.value).toContain('vitest');
    expect(proposal.test_commands.targeted_template.value).toContain('{paths}');
  });

  it('a same-family monorepo (two vitest subdirs) is not polyglot and proposes NO runners key', async () => {
    const proposal = await proposeInit(sameFamilyMonorepo());
    expect('runners' in proposal).toBe(false);
  });

  // ---- 3. APPLY PERSISTS (RED anchor) -----------------------------------
  it('apply persists the proposed runners into config (round-trip + explicit_keys) even when the root has no manifest', async () => {
    const dir = polyglotProject();
    const proposal = await proposeInit(dir);
    const proposedRunners = proposal.runners;

    // The root carries no manifest, so test_commands is empty; apply must STILL
    // persist runners rather than refuse with 'nothing to apply'.
    await configAction(dir, 'init', { apply: true });

    const { config } = await configAction(dir, 'get', {});
    expect(Array.isArray(config.runners)).toBe(true);
    expect(config.runners.length).toBeGreaterThanOrEqual(2);
    expect(config.runners).toEqual(proposedRunners);

    // Recorded in explicit_keys provenance, and survives set-time validation
    // (it round-trips through get as a well-formed [{id,owns,root,profile}] list).
    const raw = stored(dir);
    expect(Array.isArray(raw.explicit_keys)).toBe(true);
    expect(raw.explicit_keys).toContain('runners');

    // A second get confirms persistence.
    const second = (await configAction(dir, 'get', {})).config;
    expect(second.runners).toEqual(proposedRunners);
  });

  // ---- 4. SINGLE-RUNNER APPLY: byte-identical (no runners) --------------
  it('apply on a single-runner tree persists NO runners key and no runners provenance', async () => {
    const dir = jsRootProject();
    await configAction(dir, 'init', { apply: true });

    const raw = stored(dir);
    // The single-suite test_commands proposal still persists as today...
    expect(raw.explicit_keys).toContain('test_commands.full');
    // ...but no runners key and no runners provenance are written.
    expect('runners' in raw).toBe(false);
    expect(raw.explicit_keys).not.toContain('runners');
  });

  // ---- 5. DETERMINISM (RED anchor) + excluded-dir traversal -------------
  it('two consecutive init calls on the polyglot tree return deep-equal proposals including runners', async () => {
    const dir = polyglotProject();
    const first = await proposeInit(dir);
    const second = await proposeInit(dir);

    expect(Array.isArray(first.runners)).toBe(true);
    expect(first.runners.length).toBeGreaterThanOrEqual(2);
    expect(second).toEqual(first);
    expect(second.runners).toEqual(first.runners);
  });

  it('node_modules/ and dist/ manifests are not treated as runner roots', async () => {
    const proposal = await proposeInit(polyglotWithExcludedDirs());

    expect(Array.isArray(proposal.runners)).toBe(true);
    const roots = proposal.runners.map((entry) => entry.root);
    for (const root of roots) {
      const first = root.split('/')[0];
      expect(['node_modules', 'dist', '.git']).not.toContain(first);
    }
    // The genuine subdir runners are still detected.
    expect(roots).toContain('api');
    expect(roots).toContain('web');
  });

  // ---- 6. ROBUSTNESS: an unknown apply override is rejected, nothing persists
  it('apply on the polyglot tree rejects an unknown values key loudly and persists nothing (no partial apply)', async () => {
    const dir = polyglotProject();
    await expect(configAction(dir, 'init', { apply: true, values: { bogus: 'x' } }))
      .rejects.toThrow();
    expect(existsSync(configFile(dir))).toBe(false);
  });
});
