import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// Dependency-shape pin for the reducer-property-testing adoption (properties
// half): fast-check joins this repository as a devDependency ONLY, and the
// production dependency surface stays exactly { zod } — the runtime ships no
// new production dependency (invariant 6: project and host agnosticism).
//
// Pure manifest reads in the style of runtime-v2-release-version-parity.test.js
// — never spawn npm, never import production entrypoints. This file is the
// deterministic red anchor for the run: it fails while fast-check is absent
// from package.json/package-lock.json and goes green when the implementer adds
// the devDependency and refreshes the lockfile.

const read = (rel) => readFileSync(new URL(`../${rel}`, import.meta.url), 'utf8');
const readJson = (rel) => JSON.parse(read(rel));

const packageJson = readJson('package.json');
const packageLock = readJson('package-lock.json');

describe('fast-check dependency shape: dev-only, production surface stays exactly zod', () => {
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

  it('keeps package.json "dependencies" exactly { zod } (invariant 6)', () => {
    expect(
      Object.keys(packageJson.dependencies ?? {}),
      'the production dependency surface must remain exactly ["zod"]; fast-check belongs in devDependencies only',
    ).toEqual(['zod']);
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

  it('keeps the lockfile root manifest aligned: dependencies exactly zod, devDependencies include fast-check', () => {
    const root = packageLock.packages?.[''] ?? {};
    expect(
      Object.keys(root.dependencies ?? {}),
      'package-lock.json packages[""].dependencies must remain exactly ["zod"]',
    ).toEqual(['zod']);
    expect(
      Object.keys(root.devDependencies ?? {}),
      'package-lock.json packages[""].devDependencies must include fast-check',
    ).toContain('fast-check');
  });
});
