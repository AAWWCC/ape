import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG } from '../lib/runtime/config.js';
import { LANES, RISK_TRIGGERS } from '../lib/runtime/constants.js';

// config-docs-parity: DEFAULT_CONFIG in lib/runtime/config.js is the sole
// config-shape surface, but nothing enforces docs/configuration.md against it,
// so the reference can lag reality. This suite is
// the self-enforcing parity gate: it derives the full key list from the
// IMPORTED DEFAULT_CONFIG — never a hardcoded copy — and fails whenever any
// key, including nested leaf slots, lacks a row in the doc's "Complete key
// reference" tables, or the tables carry a stale row for a key that no longer
// exists. A config key cannot ship undocumented, and a removed or renamed key
// cannot leave its stale documentation behind, without turning this red.

async function readDoc() {
  return readFile(new URL('../docs/configuration.md', import.meta.url), 'utf8');
}

// Enumerate every leaf slot of the config tree as a dotted path. A leaf is any
// non-object value (scalars, null, arrays-as-a-whole) or an empty object slot
// (e.g. notifications.larp.files, an operator-populated map whose default is
// empty — the slot itself must be documented).
function leafPaths(node, prefix = []) {
  if (!node || typeof node !== 'object' || Array.isArray(node)) {
    return [prefix.join('.')];
  }
  const entries = Object.keys(node);
  if (entries.length === 0) {
    return prefix.length > 0 ? [prefix.join('.')] : [];
  }
  return entries.flatMap((key) => leafPaths(node[key], [...prefix, key]));
}

// A key counts as documented only when it appears as the first cell of a
// reference-table row — "| `full.dotted.path` | type | default | ..." — inside
// the "Complete key reference" section (its heading up to the next same-level
// heading). First-cell exact-span matching is boundary-proof in both
// directions, and section scoping keeps a backticked mention elsewhere in the
// doc (prose, other sections) from standing in for a reference entry.
const REFERENCE_HEADING = '## Complete key reference';

function referenceRows(doc) {
  const start = doc.indexOf(REFERENCE_HEADING);
  if (start === -1) return null;
  const body = doc.slice(start + REFERENCE_HEADING.length);
  const nextHeading = body.search(/^## /m);
  const section = nextHeading === -1 ? body : body.slice(0, nextHeading);
  const rows = new Map();
  for (const match of section.matchAll(/^\|\s*`([^`]+)`\s*\|([^|]*)\|([^|]*)\|/gm)) {
    rows.set(match[1], { type: match[2].trim(), default: match[3].trim() });
  }
  return rows;
}

function documentedDefault(cell) {
  const trimmed = cell.trim();
  return trimmed.startsWith('`') && trimmed.endsWith('`')
    ? trimmed.slice(1, -1)
    : trimmed;
}

function renderedDefault(value) {
  return JSON.stringify(value);
}

function sectionBullets(doc, heading) {
  const start = doc.indexOf(heading);
  if (start === -1) return null;
  const body = doc.slice(start + heading.length);
  const nextHeading = body.search(/^## /m);
  const section = nextHeading === -1 ? body : body.slice(0, nextHeading);
  return [...section.matchAll(/^- `([^`]+)`$/gm)].map((match) => match[1]);
}

describe('APE v2 config docs parity (DEFAULT_CONFIG <-> docs/configuration.md)', () => {
  const paths = leafPaths(DEFAULT_CONFIG);

  it('derives a non-trivial nested key list from the imported DEFAULT_CONFIG', () => {
    // Derivation sanity, not a shape pin: the list must come from the real
    // imported tree, be non-empty, unique, and include nested (dotted) slots.
    expect(paths.length).toBeGreaterThan(0);
    expect(new Set(paths).size).toBe(paths.length);
    for (const path of paths) {
      expect(typeof path).toBe('string');
      expect(path.length).toBeGreaterThan(0);
    }
    expect(paths.some((path) => path.includes('.'))).toBe(true);
  });

  it('documents every DEFAULT_CONFIG key, including nested leaf slots, as a reference row with a type and default', async () => {
    const rows = referenceRows(await readDoc());
    expect(rows, `docs/configuration.md must keep its "${REFERENCE_HEADING}" section`).not.toBeNull();
    const missing = paths.filter((path) => !rows.has(path));
    expect(
      missing,
      `docs/configuration.md is missing ${missing.length} DEFAULT_CONFIG key(s): ${missing.join(', ')} — ` +
        'every DEFAULT_CONFIG leaf slot must appear as the backticked first cell of a table row ' +
        '(key | type | default | what it controls) in the "Complete key reference" section'
    ).toEqual([]);
    const incomplete = paths.filter(
      (path) => rows.has(path) && (!rows.get(path).type || !rows.get(path).default)
    );
    expect(
      incomplete,
      `reference rows missing a type or default cell: ${incomplete.join(', ')}`
    ).toEqual([]);
  });

  it('carries no stale reference row for a key absent from DEFAULT_CONFIG', async () => {
    const rows = referenceRows(await readDoc());
    expect(rows, `docs/configuration.md must keep its "${REFERENCE_HEADING}" section`).not.toBeNull();
    const stale = [...rows.keys()].filter((key) => !paths.includes(key));
    expect(
      stale,
      `docs/configuration.md documents ${stale.length} key(s) that no longer exist in DEFAULT_CONFIG: ` +
        `${stale.join(', ')} — a removed or renamed config key must drop or rename its reference row`
    ).toEqual([]);
  });

  it('renders every documented default from the imported DEFAULT_CONFIG value', async () => {
    const rows = referenceRows(await readDoc());
    const flattened = new Map();
    function visit(node, prefix = []) {
      if (!node || typeof node !== 'object' || Array.isArray(node) || Object.keys(node).length === 0) {
        flattened.set(prefix.join('.'), node);
        return;
      }
      for (const [key, value] of Object.entries(node)) visit(value, [...prefix, key]);
    }
    visit(DEFAULT_CONFIG);
    const mismatches = [...flattened].flatMap(([path, value]) => {
      const actual = documentedDefault(rows.get(path)?.default ?? '');
      const expected = renderedDefault(value);
      return actual === expected ? [] : [`${path}: docs=${actual} runtime=${expected}`];
    });
    expect(mismatches, mismatches.join('\n')).toEqual([]);
  });

  it('documents the exact classifier lanes and canonical risk-trigger tokens', async () => {
    const doc = await readDoc();
    for (const lane of LANES) expect(doc).toMatch(new RegExp(`\\b${lane}\\b`, 'u'));
    expect(sectionBullets(doc, 'Canonical start-time `risk_triggers` are:')).toEqual([
      ...RISK_TRIGGERS,
    ]);
  });

  it('documents verification profiles as exact shell-free snapshotted merge gates', async () => {
    const doc = await readDoc();
    expect(doc).toContain('`verification.profiles`');
    expect(doc).toMatch(/verification\.profiles[\s\S]*unique[\s\S]*description/iu);
    expect(doc).toMatch(/exact[\s\S]*(?:argv|shell-free)[\s\S]*root[\s\S]*timeout/iu);
    expect(doc).toMatch(/snapshot[\s\S]*start[\s\S]*live config/iu);
    expect(doc).toMatch(/required[\s\S]*fail.closed[\s\S]*merge gate/iu);
  });
});
