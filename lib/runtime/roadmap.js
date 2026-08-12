import path from 'node:path';
import { appendJsonLine, atomicWriteJson, readJson } from './storage.js';
import { queryEffectiveHistory } from './history.js';
import { SCHEMA_VERSION, TERMINAL_STATUSES } from './constants.js';

// The runtime-owned roadmap (RM1): a durable plan-of-runs beside
// requirement-index.json, mutated only through the audited register/supersede
// verbs and never hand-edited. Status is NEVER stored — it is derived at read
// time (RM2) from this store, the requirement index + history, and any active
// run. The absence of the file is the documented default (RM7), so every read
// path treats a missing store as "no roadmap", not an error. This module owns
// the store and the derivation only: it imports storage and the bulk history
// projection it needs (queryEffectiveHistory) and never the
// scheduler, pipeline, or lane policy — the roadmap is a ledger above the
// scheduler, not a super-scheduler.

const now = () => new Date().toISOString();

function roadmapFile(paths) {
  return path.join(paths.runtime, 'roadmap.json');
}

// Bounds (RM1): a register batch and its per-entry fields are hard-capped so a
// crafted payload can never write an unbounded store, mirroring the input
// envelope discipline the rest of the runtime enforces (assertSafeInput).
const LIMITS = Object.freeze({
  batch: 64,
  id: 128,
  title: 200,
  description: 4000,
  acceptance: 2000,
  dependsOn: 32,
  replacedBy: 32,
  discoveredBy: 128,
});

function requireString(value, field, max) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`roadmap entry ${field} must be a non-empty string`);
  }
  if (value.length > max) {
    throw new Error(`roadmap entry ${field} exceeds ${max} characters`);
  }
  return value;
}

async function readStore(paths) {
  return readJson(roadmapFile(paths), { schema_version: SCHEMA_VERSION, entries: [] });
}

// registerEntries (RM1/RM4/RM6): validate the WHOLE batch before any write
// (all-or-nothing), then append ONE overrides.ndjson audit line
// (audit-before-mutation), then ONE atomic store write. A seeded batch and a
// per-entry follow-up captured from a discovering run flow through the same
// verb; provenance is per entry (`discovered_by`), defaulting to `operator`.
export async function registerEntries(paths, { entries = [], reason = '' } = {}) {
  if (typeof reason !== 'string' || reason.trim() === '') {
    throw new Error('roadmap register requires a non-empty reason');
  }
  if (!Array.isArray(entries) || entries.length === 0) {
    throw new Error('roadmap register requires a non-empty entries array');
  }
  if (entries.length > LIMITS.batch) {
    throw new Error(`roadmap register batch exceeds ${LIMITS.batch} entries`);
  }
  const store = await readStore(paths);
  const existingIds = new Set(store.entries.map((entry) => entry.id));
  const at = now();
  const batchIds = new Set();
  const prepared = [];
  for (const entry of entries) {
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new Error('roadmap entry must be an object');
    }
    // Status is derived, never asserted (RM1): a supplied status key rejects the
    // whole batch rather than being silently dropped.
    if (Object.prototype.hasOwnProperty.call(entry, 'status')) {
      throw new Error('roadmap entry must not carry a status key: status is derived, never stored');
    }
    const id = requireString(entry.id, 'id', LIMITS.id);
    if (existingIds.has(id) || batchIds.has(id)) {
      throw new Error(`roadmap register rejects duplicate id: ${id}`);
    }
    batchIds.add(id);
    const title = requireString(entry.title, 'title', LIMITS.title);
    const description = requireString(entry.description, 'description', LIMITS.description);
    const acceptance = requireString(entry.acceptance, 'acceptance', LIMITS.acceptance);
    const dependsOnRaw = entry.depends_on ?? [];
    if (!Array.isArray(dependsOnRaw)) {
      throw new Error('roadmap entry depends_on must be an array');
    }
    if (dependsOnRaw.length > LIMITS.dependsOn) {
      throw new Error(`roadmap entry depends_on exceeds ${LIMITS.dependsOn} ids`);
    }
    const depends_on = dependsOnRaw.map((dep) => requireString(dep, 'depends_on entry', LIMITS.id));
    let discovered_by = 'operator';
    if (entry.discovered_by !== undefined) {
      discovered_by = requireString(entry.discovered_by, 'discovered_by', LIMITS.discoveredBy);
    }
    prepared.push({
      id,
      title,
      description,
      acceptance,
      depends_on,
      discovered_by,
      audit: [{ op: 'register', at, reason }],
    });
  }
  // Audit-before-mutation: the audited verb records intent before the store
  // changes, consistent with overrides.ndjson practice.
  await appendJsonLine(paths.overrideLog, {
    operation: 'roadmap-register',
    at,
    ids: prepared.map((entry) => entry.id),
    reason,
  });
  const next = { schema_version: SCHEMA_VERSION, entries: [...store.entries, ...prepared] };
  await atomicWriteJson(roadmapFile(paths), next);
  return next;
}

// supersedeEntries (RM3): mark entries stale with a required reason and optional
// replacement ids; never delete. All-or-nothing — an unknown or
// already-superseded id rejects the whole batch, leaving the store untouched.
// The project-level analogue of history's immutable superseding records.
export async function supersedeEntries(paths, { ids = [], reason = '', replaced_by = [] } = {}) {
  if (typeof reason !== 'string' || reason.trim() === '') {
    throw new Error('roadmap supersede requires a non-empty reason');
  }
  if (!Array.isArray(ids) || ids.length === 0) {
    throw new Error('roadmap supersede requires a non-empty ids array');
  }
  if (!Array.isArray(replaced_by)) {
    throw new Error('roadmap supersede replaced_by must be an array');
  }
  if (replaced_by.length > LIMITS.replacedBy) {
    throw new Error(`roadmap supersede replaced_by exceeds ${LIMITS.replacedBy} ids`);
  }
  // Per-element validation BEFORE the audit append and the store write
  // (all-or-nothing, audit 1.13 nit 3) — the same discipline depends_on gets
  // at register time: every element must be a non-empty string within the id
  // bound, or the whole batch is refused with nothing recorded.
  const replacedBy = replaced_by.map((value) => requireString(value, 'replaced_by entry', LIMITS.id));
  const store = await readStore(paths);
  const byId = new Map(store.entries.map((entry) => [entry.id, entry]));
  // Validate the whole batch before touching the store: an unknown or
  // already-superseded id refuses without any write.
  for (const id of ids) {
    const entry = byId.get(id);
    if (!entry) throw new Error(`roadmap supersede rejects unknown id: ${id}`);
    if (entry.superseded) throw new Error(`roadmap supersede rejects already-superseded id: ${id}`);
  }
  const at = now();
  const targets = new Set(ids);
  const entriesNext = store.entries.map((entry) => {
    if (!targets.has(entry.id)) return entry;
    return {
      ...entry,
      superseded: { at, reason, replaced_by: [...replacedBy] },
      audit: [...(entry.audit ?? []), { op: 'supersede', at, reason }],
    };
  });
  await appendJsonLine(paths.overrideLog, {
    operation: 'roadmap-supersede',
    at,
    ids: [...ids],
    reason,
  });
  const next = { schema_version: SCHEMA_VERSION, entries: entriesNext };
  await atomicWriteJson(roadmapFile(paths), next);
  return next;
}

// The active run's requirement set for in_progress derivation. A missing or
// corrupt active.json degrades to "no active run" (never throws): status is a
// read surface and must survive a corrupt live slot.
async function activeRequirements(paths) {
  let active;
  try {
    active = await readJson(paths.active, null);
  } catch {
    return new Set();
  }
  if (active === null || typeof active !== 'object' || Array.isArray(active)) return new Set();
  if (typeof active.run_id !== 'string') return new Set();
  if (TERMINAL_STATUSES.has(active.status)) return new Set();
  return new Set(Array.isArray(active.requirements) ? active.requirements : []);
}

// deriveRoadmap (RM2/RM5/RM7): compute each requirement's status at read time.
// Returns null when no roadmap.json exists (single ENOENT probe — the RM7 fast
// path) so a roadmap-less project surfaces nothing anywhere.
export async function deriveRoadmap(paths, { historyMetrics = null } = {}) {
  const store = await readJson(roadmapFile(paths), null);
  if (store === null) return null;
  const entries = Array.isArray(store.entries) ? store.entries : [];

  // Read requirement-index.json ONCE and resolve each serving run's effective
  // record ONCE (dedup the run set across entries), so derivation stays away
  // from O(entries × history) file reads.
  const index = await readJson(paths.requirementIndex, { schema_version: SCHEMA_VERSION, requirements: {} });
  const requirements = index.requirements ?? {};
  const runIds = new Set();
  for (const entry of entries) {
    for (const runId of requirements[entry.id] ?? []) runIds.add(runId);
  }
  const effectiveByRun = await queryEffectiveHistory(paths, runIds, { metrics: historyMetrics });

  const activeReqs = await activeRequirements(paths);

  // A requirement is satisfied iff SOME serving run's effective record reached
  // archived 'completed' AND explicitly declared the id complete (advances vs
  // completes; no early flip across runs, never from a legacy completed record
  // that carries no completes array — truthful completion, extended upward).
  const completed = new Set();
  for (const entry of entries) {
    for (const runId of requirements[entry.id] ?? []) {
      const record = effectiveByRun.get(runId);
      if (
        record &&
        record.status === 'completed' &&
        Array.isArray(record.completes) &&
        record.completes.includes(entry.id)
      ) {
        completed.add(entry.id);
        break;
      }
    }
  }

  const superseded = new Set(entries.filter((entry) => entry.superseded).map((entry) => entry.id));
  // A superseded entry is stale regardless of any completing run, so a
  // dependency on it is unmet; "satisfied-final" is the only met-dependency
  // state (RM2): a known, not-superseded, completed entry.
  const satisfiedFinal = (id) => completed.has(id) && !superseded.has(id);

  const derived = [];
  const counts = { satisfied: 0, in_progress: 0, ready: 0, pending: 0, stale: 0 };
  for (const entry of entries) {
    // Precedence: superseded → stale, then satisfied, then in_progress, then
    // ready/pending. A dependency on an unknown or superseded entry is unmet.
    let status;
    if (entry.superseded) {
      status = 'stale';
    } else if (completed.has(entry.id)) {
      status = 'satisfied';
    } else if (activeReqs.has(entry.id)) {
      status = 'in_progress';
    } else {
      const dependsOn = Array.isArray(entry.depends_on) ? entry.depends_on : [];
      status = dependsOn.every((dep) => satisfiedFinal(dep)) ? 'ready' : 'pending';
    }
    counts[status] += 1;
    derived.push({
      id: entry.id,
      title: entry.title,
      status,
      discovered_by: entry.discovered_by ?? 'operator',
      depends_on: Array.isArray(entry.depends_on) ? entry.depends_on : [],
      ...(entry.superseded ? { superseded: entry.superseded } : {}),
    });
  }
  return { schema_version: SCHEMA_VERSION, counts, entries: derived };
}
