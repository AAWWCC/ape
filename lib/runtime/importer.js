import { readFile, readdir, rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { hashRecord, sha256 } from './canonical.js';
import { atomicWriteJson, readJson } from './storage.js';

// Hash the raw file bytes so the published digest is the file's true byte
// SHA-256 (matches `shasum -a 256`). Hashing body.toString('binary') instead
// latin1-decodes the buffer and then UTF-8 re-encodes every byte >= 0x80 into
// two bytes, corrupting the digest for any non-ASCII file.
const sha256Buffer = (buf) => createHash('sha256').update(buf).digest('hex');

const MACHINE_NAMES = new Set(['PROJECT.md', 'PHASES.md', 'BACKLOG.md', 'STATE.md']);
const MACHINE_SUFFIXES = ['-PLAN.md', '-SUMMARY.md'];
const RETAIN_MARKERS = ['research', 'proposal', 'rfc', 'decision', 'notes'];

async function walk(dir) {
  const output = [];
  let entries = [];
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch (error) {
    if (error?.code === 'ENOENT') return output;
    throw error;
  }
  // Invariant 4 (audit 1.12a): readdir order is filesystem-enumeration order,
  // which differs across machines. Sort each level by name (code-unit order,
  // never locale-dependent collation) so manifest.sources — and therefore
  // source_hash — is a pure function of the tree's contents.
  entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  for (const entry of entries) {
    const absolute = path.join(dir, entry.name);
    if (entry.isDirectory()) output.push(...await walk(absolute));
    else if (entry.isFile()) output.push(absolute);
  }
  return output;
}

function machineOwned(file) {
  const base = path.basename(file);
  const lower = base.toLowerCase();
  if (RETAIN_MARKERS.some((marker) => lower.includes(marker))) return false;
  return MACHINE_NAMES.has(base) || MACHINE_SUFFIXES.some((suffix) => base.endsWith(suffix)) || base === 'manifest.json';
}

function extractRequirements(content) {
  const ids = new Set();
  for (const match of content.matchAll(/\bR\d+\b/g)) ids.add(match[0]);
  return [...ids].sort();
}

// Classify an imported document from its explicit status line (`Status: …`,
// `**status**: …`) alone, never the whole text: a document-wide substring scan
// imported explicitly `Status: incomplete` plans and unexecuted "mark complete
// when done" templates as completed — inverting the answer the requirement
// query exists to give. On that line, `blocked` wins over completion words
// ("Status: blocked — R3 incomplete" is a block), \b keeps `complete` from
// matching `incomplete`, and a document without a recognizable status line is
// honestly 'unknown'.
function importedStatus(text) {
  const line = text.match(/^\s*(?:\*\*)?status(?:\*\*)?\s*:\s*(.+)$/im)?.[1] ?? '';
  if (/\bblocked\b/i.test(line)) return 'blocked';
  if (/\b(shipped|complete|completed|done)\b/i.test(line)) return 'completed';
  return 'unknown';
}

export async function importLegacyPlanning(projectDir, paths, options = {}) {
  const planningDir = path.join(projectDir, '.planning');
  const files = await walk(planningDir);
  const sources = [];
  const records = [];
  for (const file of files) {
    const body = await readFile(file);
    const relative = path.relative(projectDir, file).replaceAll('\\', '/');
    sources.push({ path: relative, bytes: body.length, sha256: sha256Buffer(body) });
    if (!machineOwned(file)) continue;
    const text = body.toString('utf8');
    records.push({
      source_path: relative,
      source_hash: sha256Buffer(body),
      // Deterministic synthetic run id: re-importing the same source updates
      // the same history record instead of accumulating duplicates. Never
      // collides with real run ids (run-<timestamp>-<uuid>), and the `0`
      // segment sorts below every real timestamp id (which starts with the
      // year digit) so the descending unfiltered history listing shows real
      // runs first and a large legacy import can never evict them from the
      // capped listing.
      history_run_id: `run-0-import-${sha256(relative).slice(0, 24)}`,
      requirements: extractRequirements(text),
      plan_id: path.basename(file).match(/^(\d+-\d+)-(?:PLAN|SUMMARY)\.md$/)?.[1] ?? null,
      status: importedStatus(text),
      evidence_references: [...text.matchAll(/(?:evidence|report|output):\s*([^\s]+)/gi)].map((match) => match[1]),
    });
  }
  const manifest = {
    schema_version: '2.0.0',
    imported_at: options.now ?? new Date().toISOString(),
    source_count: sources.length,
    source_hash: sha256(sources),
    sources,
    record_count: records.length,
    records,
  };
  await atomicWriteJson(paths.migration, manifest);

  // Round-trip the import into the ape_history query surface: archive each
  // machine-owned record under its synthetic run id and merge its requirement
  // IDs into the requirement index, so `ape_history query {requirement}`
  // resolves requirements that only appear in imported legacy plans.
  const index = await readJson(paths.requirementIndex, { schema_version: '2.0.0', requirements: {} });
  for (const record of records) {
    const archived = {
      schema_version: '2.0.0',
      run_id: record.history_run_id,
      imported: true,
      objective: `Imported legacy planning record ${record.source_path}`,
      mode: 'import',
      status: record.status,
      requirements: record.requirements,
      source_path: record.source_path,
      source_hash: record.source_hash,
      plan_id: record.plan_id,
      evidence_references: record.evidence_references,
      imported_at: manifest.imported_at,
    };
    // imported_at is wall-clock provenance, not record content (history.js's
    // F40 discipline, audit 1.12b): it stays on the record but outside
    // record_hash, so re-importing an unchanged source rewrites the same
    // record with the identical hash instead of manufacturing drift.
    await atomicWriteJson(
      path.join(paths.history, `${record.history_run_id}.json`),
      { ...archived, record_hash: hashRecord(archived, ['record_hash', 'imported_at']) },
    );
    for (const requirement of record.requirements) {
      const runs = new Set(index.requirements[requirement] ?? []);
      runs.add(record.history_run_id);
      index.requirements[requirement] = [...runs].sort();
    }
  }
  await atomicWriteJson(paths.requirementIndex, index);

  if (options.delete_legacy === true) {
    // Verify-and-delete per file in one pass (audit 1.12c): re-hash each
    // machine-owned source immediately before its own unlink, so a source
    // modified after any earlier verification is spared instead of deleted
    // (TOCTOU), and a crash mid-loop has only removed files whose
    // manifest-archived bytes were re-verified at their deletion instant.
    // The old shape — verify the whole tree, then delete in a second pass —
    // deleted files mutated between the passes. Changed files are collected
    // so every still-clean file is deleted before the refusal surfaces.
    const changed = [];
    for (const record of records) {
      const absolute = path.join(projectDir, record.source_path);
      const body = await readFile(absolute);
      if (sha256Buffer(body) !== record.source_hash) {
        changed.push(record.source_path);
        continue;
      }
      await rm(absolute);
    }
    if (changed.length > 0) {
      throw new Error(`legacy planning sources changed during import; refusing deletion of: ${changed.join(', ')}`);
    }
  }
  return manifest;
}
