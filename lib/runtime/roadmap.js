import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { appendJsonLine, atomicWriteJson, readJson } from './storage.js';
import { queryEffectiveHistory, queryHistory } from './history.js';
import { sha256 } from './canonical.js';
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

const DECLARATION_KEYS = new Set(['id', 'title', 'description', 'acceptance', 'depends_on']);

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

export function normalizeRoadmapDeclaration(entry, { strict = true } = {}) {
  if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
    throw new Error('roadmap entry must be an object');
  }
  if (strict) {
    const unknown = Object.keys(entry).filter((key) => !DECLARATION_KEYS.has(key));
    if (unknown.length > 0) {
      throw new Error(`roadmap follow-up has unsupported key(s): ${unknown.join(', ')}`);
    }
  }
  if (Object.prototype.hasOwnProperty.call(entry, 'status')) {
    throw new Error('roadmap entry must not carry a status key: status is derived, never stored');
  }
  const id = requireString(entry.id, 'id', LIMITS.id);
  const title = requireString(entry.title, 'title', LIMITS.title);
  const description = requireString(entry.description, 'description', LIMITS.description);
  const acceptance = requireString(entry.acceptance, 'acceptance', LIMITS.acceptance);
  const dependsOnRaw = entry.depends_on ?? [];
  if (!Array.isArray(dependsOnRaw)) throw new Error('roadmap entry depends_on must be an array');
  if (dependsOnRaw.length > LIMITS.dependsOn) {
    throw new Error(`roadmap entry depends_on exceeds ${LIMITS.dependsOn} ids`);
  }
  const depends_on = dependsOnRaw.map((dep) => requireString(dep, 'depends_on entry', LIMITS.id));
  const duplicate = depends_on.find((dep, index) => depends_on.indexOf(dep) !== index);
  if (duplicate) throw new Error(`roadmap entry ${id} rejects duplicate dependency: ${duplicate}`);
  if (depends_on.includes(id)) throw new Error(`roadmap entry ${id} rejects self dependency: ${id}`);
  return { id, title, description, acceptance, depends_on };
}

function validateLiveGraph(entries) {
  const live = entries.filter((entry) => !entry.superseded);
  const byId = new Map(live.map((entry) => [entry.id, entry]));
  for (const entry of live) {
    const dependencies = Array.isArray(entry.depends_on) ? entry.depends_on : [];
    const seen = new Set();
    for (const dependency of dependencies) {
      if (seen.has(dependency)) {
        throw new Error(`roadmap entry ${entry.id} rejects duplicate dependency: ${dependency}`);
      }
      seen.add(dependency);
      if (dependency === entry.id) {
        throw new Error(`roadmap entry ${entry.id} rejects self dependency: ${dependency}`);
      }
      const target = byId.get(dependency);
      if (!target) {
        const stored = entries.find((candidate) => candidate.id === dependency);
        const state = stored?.superseded ? 'stale' : 'unknown';
        throw new Error(`roadmap entry ${entry.id} rejects ${state} dependency: ${dependency}`);
      }
    }
  }
  const visiting = new Set();
  const visited = new Set();
  const stack = [];
  const visit = (id) => {
    if (visited.has(id)) return;
    if (visiting.has(id)) {
      const start = stack.indexOf(id);
      throw new Error(`roadmap dependency cycle: ${[...stack.slice(start), id].join(' -> ')}`);
    }
    visiting.add(id);
    stack.push(id);
    for (const dependency of byId.get(id)?.depends_on ?? []) visit(dependency);
    stack.pop();
    visiting.delete(id);
    visited.add(id);
  };
  for (const id of byId.keys()) visit(id);
}

async function auditHasMutation(paths, mutationId) {
  const text = await readFile(paths.overrideLog, 'utf8').catch((error) => {
    if (error?.code === 'ENOENT') return '';
    throw error;
  });
  for (const line of text.split('\n')) {
    if (!line) continue;
    try {
      if (JSON.parse(line)?.mutation_id === mutationId) return true;
    } catch {
      // A malformed/torn audit line is not evidence that this mutation landed.
    }
  }
  return false;
}

function applyJournalMutation(store, journal) {
  if (journal.operation === 'roadmap-register') {
    const appended = journal.entries.map((entry) => ({
      ...entry,
      discovered_by: journal.discovered_by[entry.id] ?? 'operator',
      audit: [{ op: 'register', at: journal.at, reason: journal.reason, mutation_id: journal.mutation_id }],
    }));
    return { schema_version: SCHEMA_VERSION, entries: [...store.entries, ...appended] };
  }
  const targets = new Set(journal.ids);
  return {
    schema_version: SCHEMA_VERSION,
    entries: store.entries.map((entry) => targets.has(entry.id) ? {
      ...entry,
      superseded: { at: journal.at, reason: journal.reason, replaced_by: [...journal.replaced_by] },
      audit: [...(entry.audit ?? []), {
        op: 'supersede', at: journal.at, reason: journal.reason, mutation_id: journal.mutation_id,
      }],
    } : entry),
  };
}

function overrideAudit(journal) {
  return {
    operation: journal.operation,
    at: journal.at,
    ids: journal.operation === 'roadmap-register'
      ? journal.entries.map((entry) => entry.id)
      : [...journal.ids],
    reason: journal.reason,
    mutation_id: journal.mutation_id,
  };
}

async function recoverMutation(paths, expectedInputHash = null) {
  const journal = await readJson(paths.roadmapMutation, null);
  if (!journal) return null;
  const store = await readStore(paths);
  const storeHash = sha256(store);
  const audited = await auditHasMutation(paths, journal.mutation_id);
  if (storeHash !== journal.before_hash && storeHash !== journal.after_hash) {
    throw new Error(
      `roadmap mutation ${journal.mutation_id} is divergent: store hash ${storeHash} matches neither before ${journal.before_hash} nor after ${journal.after_hash}`,
    );
  }
  if (storeHash === journal.before_hash && audited) {
    throw new Error(`roadmap mutation ${journal.mutation_id} is divergent: override audit exists but store mutation did not land`);
  }
  if (journal.status !== 'committed' && expectedInputHash && journal.input_hash !== expectedInputHash) {
    throw new Error(`roadmap mutation ${journal.mutation_id} is pending for a different operation; retry its exact input first`);
  }
  let current = store;
  if (storeHash === journal.before_hash) {
    current = applyJournalMutation(store, journal);
    if (sha256(current) !== journal.after_hash) {
      throw new Error(`roadmap mutation ${journal.mutation_id} cannot reproduce its recorded after hash`);
    }
    await atomicWriteJson(roadmapFile(paths), current);
  }
  if (!audited) await appendJsonLine(paths.overrideLog, overrideAudit(journal));
  if (journal.status !== 'committed') {
    await atomicWriteJson(paths.roadmapMutation, { ...journal, status: 'committed' });
  }
  return { journal: { ...journal, status: 'committed' }, store: current };
}

async function acceptedProposalsForRun(paths, runId) {
  const receipts = [];
  const active = await readJson(paths.active, null).catch(() => null);
  if (active?.run_id === runId && Array.isArray(active.receipts)) receipts.push(...active.receipts);
  for (const record of await queryHistory(paths, { run_id: runId })) {
    if (Array.isArray(record?.receipts)) receipts.push(...record.receipts);
  }
  const proposals = new Set();
  for (const receipt of receipts) {
    const followups = receipt?.evidence?.roadmap_followups;
    if (!Array.isArray(followups)) continue;
    for (const followup of followups) {
      try {
        proposals.add(sha256(normalizeRoadmapDeclaration(followup)));
      } catch {
        // Grandfather malformed legacy evidence as inert, never as authority.
      }
    }
  }
  return proposals;
}

async function validateProvenance(paths, prepared, discoveredBy) {
  const byRun = new Map();
  for (const entry of prepared) {
    const runId = discoveredBy[entry.id] ?? 'operator';
    if (runId === 'operator') continue;
    if (!byRun.has(runId)) byRun.set(runId, await acceptedProposalsForRun(paths, runId));
    if (!byRun.get(runId).has(sha256(entry))) {
      throw new Error(`roadmap entry ${entry.id} discovered_by ${runId} has no exact accepted receipt roadmap_followups declaration`);
    }
  }
}

// registerEntries (RM1/RM4/RM6): validate the WHOLE prospective live graph
// before any write (all-or-nothing), prepare a bounded recovery journal, write
// the store, and only then append ONE overrides.ndjson audit line. A seeded
// batch and a per-entry follow-up captured from a discovering run flow through
// the same verb; non-operator provenance must match an accepted receipt.
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
  const normalizedInput = entries.map((entry) => ({
    declaration: normalizeRoadmapDeclaration(entry, { strict: false }),
    discovered_by: entry.discovered_by === undefined
      ? 'operator'
      : requireString(entry.discovered_by, 'discovered_by', LIMITS.discoveredBy),
  }));
  const inputHash = sha256({ operation: 'roadmap-register', entries: normalizedInput, reason });
  const recovered = await recoverMutation(paths, inputHash);
  if (recovered?.journal.input_hash === inputHash) return recovered.store;
  const store = await readStore(paths);
  const existingIds = new Set(store.entries.map((entry) => entry.id));
  const batchIds = new Set();
  const prepared = [];
  // Entry ids are caller-controlled; a null-prototype map keeps ids such as
  // "__proto__" as ordinary provenance keys rather than object metaproperties.
  const discoveredBy = Object.create(null);
  for (const normalized of normalizedInput) {
    const { declaration } = normalized;
    const { id } = declaration;
    if (existingIds.has(id) || batchIds.has(id)) {
      throw new Error(`roadmap register rejects duplicate id: ${id}`);
    }
    batchIds.add(id);
    prepared.push(declaration);
    discoveredBy[id] = normalized.discovered_by;
  }
  validateLiveGraph([...store.entries, ...prepared]);
  await validateProvenance(paths, prepared, discoveredBy);
  const journal = {
    version: 1,
    status: 'prepared',
    mutation_id: randomUUID(),
    operation: 'roadmap-register',
    input_hash: inputHash,
    at: now(),
    reason,
    entries: prepared,
    discovered_by: discoveredBy,
    before_hash: sha256(store),
  };
  const next = applyJournalMutation(store, journal);
  journal.after_hash = sha256(next);
  await atomicWriteJson(paths.roadmapMutation, journal);
  return (await recoverMutation(paths, inputHash)).store;
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
  if (ids.length > LIMITS.batch) throw new Error(`roadmap supersede batch exceeds ${LIMITS.batch} ids`);
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
  const normalizedIds = ids.map((value) => requireString(value, 'supersede id', LIMITS.id));
  const duplicateTarget = normalizedIds.find((id, index) => normalizedIds.indexOf(id) !== index);
  if (duplicateTarget) throw new Error(`roadmap supersede rejects duplicate target id: ${duplicateTarget}`);
  const duplicateReplacement = replacedBy.find((id, index) => replacedBy.indexOf(id) !== index);
  if (duplicateReplacement) throw new Error(`roadmap supersede rejects duplicate replacement id: ${duplicateReplacement}`);
  const overlap = normalizedIds.find((id) => replacedBy.includes(id));
  if (overlap) throw new Error(`roadmap supersede target and replacement ids must be disjoint: ${overlap}`);
  const inputHash = sha256({ operation: 'roadmap-supersede', ids: normalizedIds, reason, replaced_by: replacedBy });
  const recovered = await recoverMutation(paths, inputHash);
  if (recovered?.journal.input_hash === inputHash) return recovered.store;
  const store = await readStore(paths);
  const byId = new Map(store.entries.map((entry) => [entry.id, entry]));
  // Validate the whole batch before touching the store: an unknown or
  // already-superseded id refuses without any write.
  for (const id of normalizedIds) {
    const entry = byId.get(id);
    if (!entry) throw new Error(`roadmap supersede rejects unknown id: ${id}`);
    if (entry.superseded) throw new Error(`roadmap supersede rejects already-superseded id: ${id}`);
  }
  for (const id of replacedBy) {
    const replacement = byId.get(id);
    if (!replacement) throw new Error(`roadmap supersede rejects unknown replacement id: ${id}`);
    if (replacement.superseded) throw new Error(`roadmap supersede rejects stale replacement id: ${id}`);
  }
  const journal = {
    version: 1,
    status: 'prepared',
    mutation_id: randomUUID(),
    operation: 'roadmap-supersede',
    input_hash: inputHash,
    at: now(),
    reason,
    ids: normalizedIds,
    replaced_by: replacedBy,
    before_hash: sha256(store),
  };
  const next = applyJournalMutation(store, journal);
  validateLiveGraph(next.entries);
  journal.after_hash = sha256(next);
  await atomicWriteJson(paths.roadmapMutation, journal);
  return (await recoverMutation(paths, inputHash)).store;
}

export async function assertRoadmapRequirementsReady(paths, requirementIds, { phase = 'start' } = {}) {
  const roadmap = await deriveRoadmap(paths);
  if (roadmap === null) return;
  const store = await readStore(paths);
  const storedById = new Map(store.entries.map((entry) => [entry.id, entry]));
  const statusById = new Map(roadmap.entries.map((entry) => [entry.id, entry.status]));
  const checked = new Set();
  const check = (targetId, rootId) => {
    if (checked.has(`${rootId}\0${targetId}`)) return;
    checked.add(`${rootId}\0${targetId}`);
    const target = storedById.get(targetId);
    if (!target) return; // Ordinary non-roadmap requirement ids stay supported.
    if (target.superseded) {
      throw new Error(`roadmap ${phase} rejects stale target ${rootId}: ${targetId}`);
    }
    for (const dependency of Array.isArray(target.depends_on) ? target.depends_on : []) {
      const status = statusById.get(dependency) ?? 'unknown';
      if (status !== 'satisfied') {
        throw new Error(`roadmap ${phase} rejects requirement ${rootId}: dependency ${dependency} is ${status}, not satisfied`);
      }
      check(dependency, rootId);
    }
  };
  for (const requirement of new Set(requirementIds ?? [])) check(requirement, requirement);
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
