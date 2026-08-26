import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// Durable release-discipline test (not a one-release pin): every version
// surface must carry the SAME version string, the mcp bundle's serverInfo
// fallback must agree, that shared version must be at least the 2.7.0
// release floor, and CHANGELOG.md must carry the matching entry heading.
// Pure file reads only — no child processes, no imports of production
// entrypoints (importing bin/ape-mcp.mjs would start the stdio server).

const read = (rel) => readFileSync(new URL(`../${rel}`, import.meta.url), 'utf8');
const readJson = (rel) => JSON.parse(read(rel));

// Semver build metadata (everything after '+', e.g. the codex manifest's
// `+codex.<timestamp>` suffix) is ignored for semver equality — normalize to
// the semver base before comparing surfaces.
const semverBase = (version) => String(version).split('+')[0];

const packageJson = readJson('package.json');
const packageLock = readJson('package-lock.json');
const claudeManifest = readJson('plugins/ape-claude/.claude-plugin/plugin.json');
const codexManifest = readJson('plugins/ape/.codex-plugin/plugin.json');
const versionsSource = read('lib/runtime/versions.js');
const durableVersionMatch = versionsSource.match(/export const APE_VERSION = '([^']+)'/u);

// The anchor every other surface must match.
const sharedVersion = packageJson.version;

describe('release version parity across every version surface', () => {
  it('declares a plain semver base version in package.json', () => {
    expect(typeof sharedVersion, 'package.json must declare a string version').toBe('string');
    expect(
      sharedVersion,
      `package.json version "${sharedVersion}" must be a bare X.Y.Z numeric triple`,
    ).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it('keeps every version surface on the identical version string', () => {
    const surfaces = {
      'package-lock.json (root version)': semverBase(packageLock.version),
      'package-lock.json (packages[""].version)': semverBase(packageLock.packages[''].version),
      'plugins/ape-claude manifest (version)': semverBase(claudeManifest.version),
      'plugins/ape manifest (version, semver base)': semverBase(codexManifest.version),
      'durable run provenance (APE_VERSION)': semverBase(durableVersionMatch?.[1]),
    };
    for (const [surface, version] of Object.entries(surfaces)) {
      expect(
        version,
        `${surface} must equal package.json's version "${sharedVersion}"`,
      ).toBe(sharedVersion);
    }
  });

  it("carries the shared version in bin/ape-mcp.mjs's serverInfo fallback literal", () => {
    // Read the entrypoint AS TEXT: importing it would execute the stdio
    // server. The quoted literal appears only in packageInfo()'s catch-block
    // fallback (the success path uses the unquoted pkg.version expression).
    const source = read('bin/ape-mcp.mjs');
    const match = source.match(/return\s*\{\s*name:\s*'ape',\s*version:\s*'([^']+)'\s*\};/);
    expect(
      match,
      "bin/ape-mcp.mjs no longer contains the serverInfo fallback literal " +
        "`return { name: 'ape', version: '<X.Y.Z>' };` — packageInfo()'s catch-block " +
        'fallback changed shape, so this test cannot verify the fallback version',
    ).not.toBeNull();
    expect(
      match[1],
      `bin/ape-mcp.mjs serverInfo fallback version "${match[1]}" must equal the shared version "${sharedVersion}"`,
    ).toBe(sharedVersion);
  });

  it('is at or beyond the 2.7.0 release floor', () => {
    const FLOOR = [2, 7, 0];
    const triple = sharedVersion.split('.').map(Number);
    expect(triple, `version "${sharedVersion}" must split into exactly three parts`).toHaveLength(3);
    for (const part of triple) {
      expect(
        Number.isInteger(part) && part >= 0,
        `version "${sharedVersion}" must be numeric X.Y.Z (got part ${part})`,
      ).toBe(true);
    }
    const [major, minor, patch] = triple;
    const atLeastFloor =
      major !== FLOOR[0]
        ? major > FLOOR[0]
        : minor !== FLOOR[1]
          ? minor > FLOOR[1]
          : patch >= FLOOR[2];
    expect(
      atLeastFloor,
      `shared version ${sharedVersion} ([${triple.join(', ')}]) must be >= ${FLOOR.join('.')} ` +
        `([${FLOOR.join(', ')}]) — the 2.7.0 release bump has not landed`,
    ).toBe(true);
  });

  it('has a CHANGELOG.md entry heading for exactly the shared version', () => {
    const changelog = read('CHANGELOG.md');
    const escaped = sharedVersion.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    // Repo convention: `## X.Y.Z — YYYY-MM-DD` (em dash separator).
    const heading = new RegExp(`^## ${escaped} — `, 'm');
    expect(
      changelog,
      `CHANGELOG.md must contain an entry heading \`## ${sharedVersion} — <date>\` (em dash) for the released version`,
    ).toMatch(heading);
  });
});
