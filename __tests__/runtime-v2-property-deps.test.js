import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// Runtime imports must survive a production-only source installation. Test
// harnesses remain development dependencies; both shipped parsers are runtime
// dependencies and are also inlined into the standalone plugin bundles.

const read = (rel) => readFileSync(new URL(`../${rel}`, import.meta.url), 'utf8');
const readJson = (rel) => JSON.parse(read(rel));

const packageJson = readJson('package.json');
const packageLock = readJson('package-lock.json');

describe('runtime parsers and development test dependency classification', () => {
  it('declares fast-check in package.json devDependencies with a semver range', () => {
    const range = packageJson.devDependencies?.['fast-check'];
    expect(
      range,
      'package.json devDependencies must declare fast-check (dev-only adoption of the property-testing harness)',
    ).toBeTypeOf('string');
    expect(
      range,
      `fast-check devDependency range "${range}" must reference a concrete semver version`,
    ).toMatch(/\d+\.\d+\.\d+/);
  });

  it('declares both imported runtime parsers as production dependencies', () => {
    expect(
      Object.keys(packageJson.dependencies ?? {}),
      'runtime parsers belong in dependencies; fast-check belongs in devDependencies only',
    ).toEqual(['smol-toml', 'zod']);
    expect(packageJson.devDependencies).not.toHaveProperty('smol-toml');
    expect(packageLock.packages['node_modules/smol-toml'].dev).not.toBe(true);
  });

  it('resolves fast-check in package-lock.json as a dev-only package', () => {
    const entry = packageLock.packages?.['node_modules/fast-check'];
    expect(
      entry,
      'package-lock.json must carry a resolved packages["node_modules/fast-check"] entry — refresh the lockfile alongside the devDependency',
    ).toBeTruthy();
    expect(
      entry?.dev,
      'the resolved fast-check lockfile entry must be dev-scoped (dev: true), never a production install',
    ).toBe(true);
  });

  it('keeps the lockfile root aligned with runtime and test dependency scopes', () => {
    const root = packageLock.packages?.[''] ?? {};
    expect(
      Object.keys(root.dependencies ?? {}),
      'package-lock.json packages[""].dependencies must include both runtime parsers',
    ).toEqual(['smol-toml', 'zod']);
    expect(root.dependencies).toEqual(packageJson.dependencies);
    expect(root.devDependencies).toEqual(packageJson.devDependencies);
    expect(
      Object.keys(root.devDependencies ?? {}),
      'package-lock.json packages[""].devDependencies must include fast-check',
    ).toContain('fast-check');
  });
});
