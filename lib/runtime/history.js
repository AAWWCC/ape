import path from 'node:path';
import { readdir } from 'node:fs/promises';
import { atomicWriteJson, readJson } from './storage.js';
import { hashRecord } from './canonical.js';
import { MAX_DIAGNOSTIC_NUMBER, isCanonicalRunId, isValidMergeEvidence, projectRunDiagnostic, safeDiagnosticText, safeModelTier, validatedArchiveSnapshot } from './diagnostics.js';

const MAX_HISTORY_RECORDS = 256;
const METRICS_MODES = new Set(['phase', 'debug', 'spike', 'patch']);
const METRICS_LANES = new Set(['auto', 'mechanical', 'fast', 'full']);
const METRICS_HOSTS = new Set(['claude', 'codex']);
const METRICS_STATUSES = new Set(['completed', 'blocked', 'aborted']);
const ISO_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/;

function safeRunId(value) {
  return isCanonicalRunId(value);
}

// The unfiltered listing's active stub must degrade truthfully when active.json
// is present but not a run state (a non-object, an array, or an object with no
// string run_id). Kept local (no service.js import) so the one read site below
// can classify a parseable value without pulling in the reducer choke point.
function isValidActiveState(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value) && typeof value.run_id === 'string';
}

// The volatile provenance fields of a merge object, excluded from record_hash
// (audit 1.2, invariants 7/8): merged_at is wall-clock provenance — a
// runtime-performed merge stamps it from the local clock while a crash-retry
// that re-observes the already-merged PR adopts GitHub's second-resolution
// mergedAt — and provenance ('observed-external') marks WHICH path observed
// the merge, not what merged. The stable merge identity (provider, url,
// branch, base) stays inside the hash, so a retry carrying a DIFFERENT PR
// still fails closed at archiveRun's immutability check.
function stableMergeFields(merge) {
  if (!merge || typeof merge !== 'object') return merge;
  const { merged_at, provenance, ...stable } = merge;
  return stable;
}

function immutableRunRecord(state, supersedes = null) {
  const validMerge = hasMergeEvidence(state.merge);
  const record = {
    schema_version: '2.0.0',
    run_id: state.run_id,
    objective: state.objective,
    mode: state.mode,
    lane: state.lane,
    // The host the run executed under is run content (it decides certification
    // buckets and is crash-retry stable), so it participates in record_hash.
    // Pre-schema/host-less runs omit the key entirely (conditional spread, like
    // supersedes below) so their record_hash is unchanged; benchmark import then
    // falls back to receipts[0].agent.host (T14).
    ...(state.host ? { host: state.host } : {}),
    // Versioned structured planning is additive. Omit both keys for every
    // legacy run so its immutable record_hash is byte-for-byte unchanged.
    ...(state.plan_contract_version
      ? { plan_contract_version: state.plan_contract_version }
      : {}),
    ...(state.approved_plan ? { approved_plan: state.approved_plan } : {}),
    requirements: state.requirements,
    // Advances vs completes (RM2): the subset of requirements this run FINISHED,
    // the upward extension of truthful completion the roadmap derives satisfied
    // status from. Run content, so it participates in record_hash — but omitted
    // entirely when empty/absent (conditional spread, like host/supersedes
    // above) so every pre-completes record_hash stays byte-identical.
    ...(state.completes?.length ? { completes: state.completes } : {}),
    status: state.status,
    // A blocked post-gate merge hold is terminal but intentionally unshipped.
    // Preserve just the canonical stage discriminator needed to diagnose that
    // immutable record later; older records remain compatible without it.
    ...(state.status === 'blocked' && state.stage === 'merge' && state.gates?.passed === true
      ? { stage: 'merge' }
      : {}),
    // A blocked run archives at the moment it blocks (F7); without the reason
    // the record would say only "blocked" and the why would die with the
    // active state on reset.
    block_reason: state.block_reason ?? null,
    // Abort reasons are already bounded at the abort/override boundary before
    // they reach state. Persist them as immutable run content so a later
    // active run cannot hide why this run ended.
    ...(state.abort_reason ? { abort_reason: state.abort_reason } : {}),
    created_at: state.created_at,
    // The stable terminal timestamp (stamped once, when the run first entered
    // a terminal status), never the volatile updated_at that every later
    // persist refreshes (F40).
    completed_at: state.completed_at ?? state.terminal_at ?? state.updated_at,
    ...(state.base_branch ? { base_branch: state.base_branch } : {}),
    base_commit_sha: state.base_commit_sha,
    // Refreshed from the live tree by the caller at the terminal moment
    // (service archive paths recompute it before archiving); it participates
    // in record_hash because the tree is run content — see the archive_history
    // handler for why crash-retries still converge.
    final_tree_sha: state.tree_sha,
    tickets: state.tickets,
    receipts: state.receipts,
    gates: state.gates ?? null,
    // Persist merge presence only when the complete allowlisted provenance is
    // valid. Invalid/private evidence is discarded at the archive boundary;
    // direct inspection of malformed legacy records still diagnoses them as
    // incomplete without echoing their values.
    merge: validMerge ? state.merge : null,
    // Minimal runtime-owned lifecycle provenance that cannot be reconstructed
    // after active.json is replaced. Ticket attempts/roles remain the durable
    // source for retries and remediation inference; these fields preserve only
    // expiration, explicit route/recovery levers, and the fact that a preflight
    // hold was answered (never the operator's answer text).
    ...(state.expired_tickets?.length
      ? { expired_tickets: [...state.expired_tickets] }
      : {}),
    ...(state.remediation_route ? { remediation_route: state.remediation_route } : {}),
    ...(Number.isInteger(state.remediation_cycles) && state.remediation_cycles > 0
      ? { remediation_cycles: state.remediation_cycles }
      : {}),
    ...(Number.isInteger(state.regate_attempts) && state.regate_attempts > 0
      ? { regate_attempts: state.regate_attempts }
      : {}),
    ...(state.ship_requested === true ? { ship_requested: true } : {}),
    ...(Array.isArray(state.preflight?.answers) && state.preflight.answers.length > 0
      ? {
          input_hold: {
            occurred: true,
            question_count: state.preflight.answers.length,
            question_ids: state.preflight.answers
              .slice(0, 32)
              .map((answer) => answer?.id)
              .filter((id) => typeof id === 'string'),
          },
        }
      : {}),
    // A superseding completion record (re-gate recovery, F7) references the
    // immutable block-time record it supersedes; the reference is run content,
    // so it participates in record_hash. Omitted entirely for first records so
    // their hash is unchanged.
    ...(supersedes ? { supersedes } : {}),
    // Cross-run supersession (friction #10): a successor run started to
    // converge an abandoned/blocked one carries the predecessor's run id, so
    // one logical task no longer reads as N unrelated failures. Present only
    // when the start declared it — absent, the hash of every existing record
    // is unchanged.
    ...(state.supersedes_run ? { supersedes_run: state.supersedes_run } : {}),
  };
  // Runtime-measured timing provenance (T14): raw_ms is the run's own
  // created_at -> completed_at wall clock (derived from the SAME stable stamp
  // completed_at uses, so archived raw_ms can never diverge from the archived
  // timestamps); test_ms/remote_ci_ms are the runtime's accumulated gate/red-
  // test and shipping measurements, defaulted 0 for runs that predate timing.
  const rawStart = Date.parse(record.created_at);
  const rawEnd = Date.parse(record.completed_at);
  const raw_ms =
    Number.isFinite(rawStart) && Number.isFinite(rawEnd) && rawEnd - rawStart >= 0
      ? rawEnd - rawStart
      : null;
  const timing = {
    raw_ms,
    test_ms: state.timing?.test_ms ?? 0,
    remote_ci_ms: state.timing?.remote_ci_ms ?? 0,
  };
  // completed_at AND timing are wall-clock provenance, not run content: a crash
  // between archive_history and persist_state loses the in-memory terminal
  // stamp and the accumulated timing, so the retried terminal transition
  // re-stamps and re-measures. Attaching timing OUTSIDE the hashed record (and
  // excluding completed_at) makes that retry archive-identical — a no-op with
  // first-write-wins on the timing block — instead of a wedge (F40), and keeps
  // every pre-timing record_hash unchanged.
  // merge.merged_at / merge.provenance are the same class of volatile
  // provenance (audit 1.2): the MERGED chain's crash-retry re-observes the
  // SAME merge with a different timestamp (and, on the poll path, an
  // 'observed-external' marker), so hashing only the stable merge fields makes
  // that retry converge first-write-wins on the runtime-stamped record instead
  // of wedging on the immutability check, while stable-field drift (a
  // different PR) still fails closed.
  const hashed = record.merge ? { ...record, merge: stableMergeFields(record.merge) } : record;
  return { ...record, timing, record_hash: hashRecord(hashed, ['record_hash', 'completed_at', 'timing']) };
}

async function indexRequirements(paths, state) {
  const index = await readJson(paths.requirementIndex, { schema_version: '2.0.0', requirements: {} });
  for (const requirement of state.requirements ?? []) {
    const runs = new Set(index.requirements[requirement] ?? []);
    runs.add(state.run_id);
    index.requirements[requirement] = [...runs].sort();
  }
  await atomicWriteJson(paths.requirementIndex, index);
}

// The block-time record's hash to supersede: given explicitly (an operator/test
// caller passing options.supersedes), or resolved from the on-disk block-time
// record when the service asks for a superseding archive (options.superseding).
async function resolveSupersedes(paths, state, options) {
  if (typeof options.supersedes === 'string' && options.supersedes) return options.supersedes;
  if (options.superseding === true) {
    const existing = await readJson(path.join(paths.history, `${state.run_id}.json`), null);
    return existing?.record_hash ?? null;
  }
  return null;
}

export async function archiveRun(paths, state, options = {}) {
  if (!safeRunId(state.run_id)) throw new Error('history run id is invalid');
  const supersedes = await resolveSupersedes(paths, state, options);
  const record = immutableRunRecord(state, supersedes);
  const destination = path.join(paths.history, `${state.run_id}.json`);
  if (supersedes) {
    // F7: the block-time record is immutable. A re-gated run's eventual
    // completion is appended as a NEW record that references the block-time
    // record, written to a distinct hash-suffixed path so the primary record is
    // never mutated. Re-archiving the same completion is idempotent.
    const supersedingPath = path.join(paths.history, `${state.run_id}.${record.record_hash}.json`);
    if (!(await readJson(supersedingPath, null))) await atomicWriteJson(supersedingPath, record);
    await indexRequirements(paths, state);
    return record;
  }
  const existing = await readJson(destination, null);
  // ifAbsent: the caller only needs the run to be in history (override
  // abort/reset of an already-archived run); first write wins and a record
  // that drifted afterwards (e.g. tree_sha refreshed by a later persist) is
  // not an integrity violation.
  if (existing && existing.record_hash !== record.record_hash && options.ifAbsent !== true) {
    throw new Error(`immutable history record already exists for ${state.run_id}`);
  }
  if (!existing) await atomicWriteJson(destination, record);
  await indexRequirements(paths, state);
  return existing ?? record;
}

// Pick the record that tells the run's current truth. Supersession is a STAR,
// not a chain: every superseding record references the primary block-time
// record (resolveSupersedes always reads `${run_id}.json`), so after a failed
// ship followed by a re-gated completion TWO superseding records exist and
// their readdir order is hash-alphabetical — "the last record" is meaningless.
// Prefer completed over non-completed (the recovery this mechanism exists
// for), then the latest completed_at, then the lexicographically larger
// record_hash so the choice is deterministic under timestamp ties.
export function selectEffectiveRecord(primary, superseding = []) {
  const candidates = [primary, ...superseding].filter(Boolean);
  if (candidates.length === 0) return null;
  return candidates.reduce((best, record) => {
    const bestCompleted = best.status === 'completed';
    const recordCompleted = record.status === 'completed';
    if (recordCompleted !== bestCompleted) return recordCompleted ? record : best;
    const bestAt = Date.parse(best.completed_at ?? '');
    const recordAt = Date.parse(record.completed_at ?? '');
    const bestTime = Number.isFinite(bestAt) ? bestAt : -Infinity;
    const recordTime = Number.isFinite(recordAt) ? recordAt : -Infinity;
    if (recordTime !== bestTime) return recordTime > bestTime ? record : best;
    return String(record.record_hash ?? '') > String(best.record_hash ?? '') ? record : best;
  });
}

async function listHistoryFiles(paths, metrics = null) {
  if (metrics && typeof metrics === 'object') {
    metrics.directory_listings = (metrics.directory_listings ?? 0) + 1;
  }
  try {
    return (await readdir(paths.history)).filter((file) => file.endsWith('.json'));
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
    return [];
  }
}

function partitionHistoryFiles(files) {
  const primaries = [];
  const supersedingByRun = new Map();
  for (const file of files) {
    const stem = file.slice(0, -5);
    if (isCanonicalRunId(stem)) {
      primaries.push(file);
      continue;
    }
    const separator = stem.indexOf('.');
    if (separator === -1) continue;
    const id = stem.slice(0, separator);
    if (!isCanonicalRunId(id)) continue;
    supersedingByRun.set(id, [...(supersedingByRun.get(id) ?? []), file]);
  }
  primaries.sort().reverse();
  for (const superseding of supersedingByRun.values()) superseding.sort();
  return { primaries, supersedingByRun };
}

async function readHistoryJson(paths, file, metrics = null) {
  const record = await readJson(path.join(paths.history, file), null);
  if (metrics && typeof metrics === 'object') {
    metrics.records_read = (metrics.records_read ?? 0) + 1;
  }
  return record;
}

async function mapInBatches(values, batchSize, mapper) {
  const output = [];
  for (let offset = 0; offset < values.length; offset += batchSize) {
    output.push(...await Promise.all(values.slice(offset, offset + batchSize).map(mapper)));
  }
  return output;
}

// Resolve effective records for an arbitrary run-id set from ONE history
// inventory. This is intentionally separate from queryHistory's filtered RAW
// audit view: callers such as roadmap derivation need one completed-over-
// blocked record per run, while queryHistory({ run_id }) must continue to
// expose the primary and every superseding record individually.
export async function queryEffectiveHistory(paths, runIds, { metrics = null } = {}) {
  const ids = [...new Set(runIds)].filter(safeRunId);
  if (ids.length === 0) return new Map();
  const { supersedingByRun } = partitionHistoryFiles(await listHistoryFiles(paths, metrics));
  const pairs = await mapInBatches(ids, 32, async (id) => {
    const primary = await readHistoryJson(paths, `${id}.json`, metrics);
    const superseding = await mapInBatches(
      supersedingByRun.get(id) ?? [],
      32,
      (file) => readHistoryJson(paths, file, metrics),
    );
    return [
      id,
      selectEffectiveRecord(
        primary,
        superseding.filter((record) => record?.supersedes),
      ),
    ];
  });
  return new Map(pairs.filter(([, record]) => record));
}

export async function queryHistory(paths, query = {}) {
  const index = await readJson(paths.requirementIndex, { schema_version: '2.0.0', requirements: {} });
  let ids = query.requirement ? index.requirements[query.requirement] ?? [] : [];
  if (query.run_id) ids = safeRunId(query.run_id) ? [query.run_id] : [];
  if (!query.requirement && !query.run_id) {
    const files = await listHistoryFiles(paths);
    // Partition ONE listing instead of a readdir per run: primary records are
    // `<run_id>.json`; superseding completions are `<run_id>.<hash>.json` (F7)
    // whose embedded dot always fails SAFE_RUN_ID — before they were folded in
    // here, a re-gated/shipped run listed as 'blocked' forever (invariant 8).
    const { primaries, supersedingByRun } = partitionHistoryFiles(files);
    const records = [];
    // Resolve the prepended active stub locally so a corrupt or schema-invalid
    // active.json degrades to a corrupt-state stub instead of throwing the whole
    // unfiltered listing (follow-up 1). A JSON.parse SyntaxError (corrupt bytes)
    // and a parseable-but-invalid value both prepend the same corrupt-state stub
    // (mirroring statusRun's structured corrupt_state diagnosis); a valid active
    // entry keeps its pinned { run_id, status, active: true } shape; a literal
    // `null`/absent file (readJson's null fallback) means no active run.
    let activeStub = null;
    try {
      const active = await readJson(paths.active, null);
      if (active !== null) {
        activeStub = isValidActiveState(active)
          ? { run_id: active.run_id, status: active.status, active: true }
          : { run_id: 'unknown', status: 'corrupt_state', active: true };
      }
    } catch (error) {
      if (!(error instanceof SyntaxError)) throw error;
      activeStub = { run_id: 'unknown', status: 'corrupt_state', active: true };
    }
    // The cap counts listed RUNS (primaries; the active stub consumes one
    // slot), not record files: a run's superseding completions only decide
    // which single effective record represents it.
    const remaining = activeStub ? MAX_HISTORY_RECORDS - 1 : MAX_HISTORY_RECORDS;
    for (const file of primaries.slice(0, remaining)) {
      const record = await readHistoryJson(paths, file);
      if (!record) continue;
      const superseding = [];
      for (const supersedingFile of supersedingByRun.get(file.slice(0, -5)) ?? []) {
        const supersedingRecord = await readHistoryJson(paths, supersedingFile);
        if (supersedingRecord) superseding.push(supersedingRecord);
      }
      records.push(selectEffectiveRecord(record, superseding));
    }
    return activeStub ? [activeStub, ...records] : records;
  }
  // ONE readdir of the history dir for the whole filtered query, partitioned
  // by `${id}.` prefix — the same pattern the unfiltered branch above uses —
  // never a listing per matching id (audit s2.4b). SAFE_RUN_ID admits no dots,
  // so the first-dot prefix keeps `run-1` from matching `run-10`'s records.
  const { supersedingByRun } = partitionHistoryFiles(await listHistoryFiles(paths));
  const records = [];
  for (const id of ids.filter(safeRunId).slice(0, MAX_HISTORY_RECORDS)) {
    const record = await readHistoryJson(paths, `${id}.json`);
    if (record) records.push(record);
    // A re-gated run's completion lives beside its immutable block-time record
    // as `${id}.<hash>.json` (F7); surface those superseding records too so the
    // eventual completion is queryable without the block record being mutated.
    // DELIBERATE ASYMMETRY vs the unfiltered listing above (recorded audit
    // decision s2.4a): the unfiltered listing collapses each run to ONE
    // effective record via selectEffectiveRecord, while this filtered query
    // returns the RAW audit view — the primary block-time record first, then
    // every superseding record in listing order — so the F7 record and its
    // superseding completion(s) stay individually inspectable. Do not
    // normalize this shape.
    for (const file of supersedingByRun.get(id) ?? []) {
      const supersedingRecord = await readHistoryJson(paths, file);
      if (supersedingRecord) records.push(supersedingRecord);
    }
  }
  return records;
}

// Derive archived lifecycle facts from immutable ticket/receipt content, plus
// the few terminal provenance fields archiveRun preserves above. This keeps
// explain output truthful for real archived runs instead of depending on
// fixture-only properties that ordinary history records never carried.
export function deriveArchivedRunFacts(record, options = {}) {
  if (options.trustedSnapshot !== true) {
    const validated = validatedArchiveSnapshot(record);
    if (!validated) return null;
    record = validated.snapshot;
  }
  const tickets = Array.isArray(record.tickets) ? record.tickets : [];
  const receipts = Array.isArray(record.receipts) ? record.receipts : [];
  const receiptedIds = new Set(receipts.map((receipt) => receipt?.ticket_id).filter(Boolean));
  const expiredIds = new Set(
    Array.isArray(record.expired_tickets) ? record.expired_tickets.filter((id) => typeof id === 'string') : [],
  );
  const pendingCount = tickets.filter(
    (ticket) => !receiptedIds.has(ticket?.ticket_id) && !expiredIds.has(ticket?.ticket_id),
  ).length;

  const maxAttemptByStage = new Map();
  for (const ticket of tickets) {
    const stage = typeof ticket?.stage_id === 'string' ? ticket.stage_id : 'unknown';
    const attempt = Number.isInteger(ticket?.attempt) && ticket.attempt > 0 ? ticket.attempt : 1;
    maxAttemptByStage.set(stage, Math.max(maxAttemptByStage.get(stage) ?? 0, attempt));
  }
  const derivedRetryCount = [...maxAttemptByStage.values()]
    .reduce((total, attempt) => total + Math.max(0, attempt - 1), 0);
  const rawRetryCount = typeof record.retries_count === 'number'
    ? record.retries_count
    : typeof record.retry_count === 'number'
      ? record.retry_count
      : derivedRetryCount;
  const retryCount = Number.isInteger(rawRetryCount) && rawRetryCount >= 0 ? rawRetryCount : derivedRetryCount;

  const remediationStages = new Set(
    tickets
      .map((ticket) => ticket?.stage_id)
      .filter((stage) => typeof stage === 'string' && stage.startsWith('remediation-')),
  );
  const inferredRoute = remediationStages.has('remediation-test')
    ? (remediationStages.has('remediation-build') ? 'test-production' : 'test')
    : remediationStages.has('remediation-build')
      ? 'production'
      : null;
  const remediationRoute = record.remediation_route?.route ?? inferredRoute;
  const rawRemediationCycle = record.remediation_route?.cycle ?? record.remediation_cycles ?? 0;
  const remediationCycle = Number.isInteger(rawRemediationCycle) && rawRemediationCycle >= 0
    ? rawRemediationCycle
    : 0;

  const explicitInputHold = record.input_hold && typeof record.input_hold === 'object'
    ? record.input_hold
    : null;
  const preflightAnswers = Array.isArray(record.preflight?.answers) ? record.preflight.answers : [];
  const inputQuestionIds = Array.isArray(explicitInputHold?.question_ids)
    ? explicitInputHold.question_ids.filter((id) => typeof id === 'string')
    : preflightAnswers
        .map((answer) => answer?.id)
        .filter((id) => typeof id === 'string');
  const inputOccurred = explicitInputHold?.occurred === true || inputQuestionIds.length > 0;
  const rawQuestionCount = explicitInputHold?.questions_answered
    ?? explicitInputHold?.question_count
    ?? inputQuestionIds.length;
  const questionCount = Number.isInteger(rawQuestionCount) && rawQuestionCount >= 0
    ? rawQuestionCount
    : inputQuestionIds.length;

  const regateAttempts = Number.isInteger(record.regate_attempts) && record.regate_attempts > 0
    ? record.regate_attempts
    : 0;
  const recoveryType = record.recovery?.type
    ?? (regateAttempts > 0
      ? 'regate'
      : record.ship_requested === true
        ? 'ship'
        : record.supersedes
          ? 'terminal-recovery'
          : null);

  return {
    dispatch: {
      ticket_count: tickets.length,
      receipted_count: tickets.filter((ticket) => receiptedIds.has(ticket?.ticket_id)).length,
      expired_count: expiredIds.size,
      pending_count: pendingCount,
    },
    retry: { retry_count: retryCount },
    expiry: { expired_count: expiredIds.size, expired_tickets: [...expiredIds].slice(0, 32) },
    remediation: {
      active: remediationRoute !== null || remediationStages.size > 0,
      route: remediationRoute,
      cycle: remediationCycle,
      test_paths: Array.isArray(record.remediation_route?.test_paths)
        ? record.remediation_route.test_paths.slice(0, 32)
        : [],
    },
    input_hold: {
      occurred: inputOccurred,
      question_count: questionCount,
      question_ids: inputQuestionIds.slice(0, 32),
    },
    recovery: {
      active: recoveryType !== null,
      type: recoveryType,
      regate_attempts: regateAttempts,
      ...(record.recovery?.original_block
        ? { original_block: record.recovery.original_block }
        : {}),
    },
  };
}

const hasMergeEvidence = isValidMergeEvidence;

export function explainRun(record) {
  if (!record) return 'Run not found.';
  if (typeof record !== 'object' || Array.isArray(record)) {
    const diagnostic = projectRunDiagnostic({}, { archived: true });
    return [
      'Run unknown',
      'Status: unknown; lane: none; mode: none.',
      `Reason code: ${diagnostic.reason_code}`,
      `Next safe action: ${diagnostic.next_safe_action}`,
      `Recovery rationale: ${diagnostic.recovery_rationale}`,
      'Failed checks: none',
      'Timing: unavailable',
    ].join('\n');
  }
  const validated = validatedArchiveSnapshot(record);
  const inspected = validated?.snapshot ?? null;
  const diagnostic = projectRunDiagnostic(inspected, {
    archived: true,
    trustedSnapshot: true,
    archiveVerified: validated?.hashVerified === true,
  });
  if (diagnostic.reason_code === 'incomplete_record') {
    const runId = typeof inspected?.run_id === 'string' && /^run-[A-Za-z0-9][A-Za-z0-9_-]{0,123}$/.test(inspected.run_id)
      ? inspected.run_id
      : 'unknown';
    const incompleteMerge = inspected?.merge;
    let credentialBearingGithubMerge = false;
    if (incompleteMerge && typeof incompleteMerge === 'object' && !Array.isArray(incompleteMerge)
      && incompleteMerge.provider === 'github' && typeof incompleteMerge.url === 'string') {
      try {
        const parsed = new URL(incompleteMerge.url);
        credentialBearingGithubMerge = Boolean(parsed.username || parsed.password);
      } catch {
        credentialBearingGithubMerge = false;
      }
    }
    return [
      `Run ${runId}`,
      'Status: unknown; lane: none; mode: none.',
      'Reason code: incomplete_record',
      `Next safe action: ${diagnostic.next_safe_action}`,
      `Recovery rationale: ${diagnostic.recovery_rationale}`,
      'Failed checks: none',
      'Agents: 0 passed receipts, 0 non-passing receipts.',
      credentialBearingGithubMerge ? 'Merged: not recorded.' : 'Merge: not recorded.',
      'Dispatch: unavailable.',
      'Timing: unavailable',
      'Retries: 0',
    ].join('\n');
  }
  record = inspected;
  const facts = deriveArchivedRunFacts(record, { trustedSnapshot: true });
  const tickets = Array.isArray(record.tickets) ? record.tickets : [];
  const receipts = Array.isArray(record.receipts) ? record.receipts : [];
  const passed = receipts.filter((receipt) => receipt?.status === 'passed').length;
  const failed = receipts.length - passed;
  const dispatchState = ['pending', 'needs-redispatch', 'live', 'none'].includes(record.dispatch_state)
    ? record.dispatch_state
    : record.stage === 'dispatch' && record.status === 'running' && facts.dispatch.pending_count > 0
      ? 'pending'
      : 'none';
  const effectiveDiagnostic = projectRunDiagnostic(record, {
    archived: true,
    dispatchState,
    trustedSnapshot: true,
    archiveVerified: validated.hashVerified,
  });
  const safeRunId = safeDiagnosticText(record.run_id, 128) ?? 'unknown';
  const safeStatus = safeDiagnosticText(record.status, 64) ?? 'unknown';
  const safeLane = safeDiagnosticText(record.lane, 32) ?? 'none';
  const safeMode = safeDiagnosticText(record.mode, 32) ?? 'none';
  const lines = [
    `Run ${safeRunId}`,
    // Imported legacy records carry no lane; render that honestly instead of
    // the literal "undefined".
    `Status: ${safeStatus}; lane: ${safeLane}; mode: ${safeMode}.`,
    `Reason code: ${effectiveDiagnostic.reason_code}`,
    `Next safe action: ${effectiveDiagnostic.next_safe_action}`,
    `Recovery rationale: ${effectiveDiagnostic.recovery_rationale}`,
    `Failed checks: ${effectiveDiagnostic.failed_checks.length > 0 ? effectiveDiagnostic.failed_checks.join(', ') : 'none'}`,
    `Agents: ${passed} passed receipts, ${failed} non-passing receipts.`,
    hasMergeEvidence(record.merge) ? 'Merged: recorded.' : 'Merge: not recorded.',
  ];

  // Tiers
  const tiers = [...new Set(tickets.map((t) => safeModelTier(t?.model_tier)).filter(Boolean))];
  const recordTier = safeModelTier(record.model_tier);
  if (recordTier && !tiers.includes(recordTier)) {
    tiers.push(recordTier);
  }
  if (tiers.length > 0) {
    const safeTiers = tiers
      .map((tier) => safeModelTier(tier))
      .filter(Boolean)
      .slice(0, 16);
    if (safeTiers.length > 0) lines.push(`Tiers: ${safeTiers.join(', ')}`);
  }

  lines.push(
    `Dispatch: ${facts.dispatch.ticket_count} tickets; ${facts.dispatch.receipted_count} receipted; ` +
    `${facts.dispatch.expired_count} expired; ${facts.dispatch.pending_count} pending.`,
  );

  // Timing / Duration comes from the shared validated diagnostic projection.
  const durationMs = effectiveDiagnostic.stage_timing.available && 'duration_ms' in effectiveDiagnostic.stage_timing
    ? effectiveDiagnostic.stage_timing.duration_ms ?? null
    : null;
  if (durationMs !== null) {
    const totalSecs = Math.round(durationMs / 1000);
    const mins = Math.floor(totalSecs / 60);
    const secs = totalSecs % 60;
    const durationFormatted = mins > 0
      ? (secs > 0 ? `${mins}m ${secs}s (${durationMs}ms)` : `${mins}m (${durationMs}ms)`)
      : `${totalSecs}s (${durationMs}ms)`;
    lines.push(`Timing: ${durationFormatted}; source: ${effectiveDiagnostic.stage_timing.source}`);
  } else lines.push('Timing: unavailable');

  // Gates
  if (record.gates && typeof record.gates === 'object') {
    const gateStatus = record.gates.passed === true ? 'passed' : record.gates.passed === false ? 'failed' : 'not_run';
    const checksCount = Number.isInteger(record.gates.checks_count) && record.gates.checks_count >= 0 && record.gates.checks_count <= MAX_DIAGNOSTIC_NUMBER
      ? record.gates.checks_count
      : null;
    const checksStr = checksCount !== null ? ` (${checksCount} checks)` : '';
    lines.push(`Gates: ${gateStatus}${checksStr}`);
  }

  // Supersession is part of the run's truth: a recovery completion must say it
  // replaced the block-time record, and a successor run must name the
  // abandoned run it converged (friction #10).
  if (record.supersedes) {
    const supersedes = safeDiagnosticText(record.supersedes, 128);
    if (supersedes) lines.push(`Supersedes this run's block-time record (${supersedes}).`);
  }
  if (record.supersedes_run) {
    const supersedesRun = safeDiagnosticText(record.supersedes_run, 128);
    if (supersedesRun) lines.push(`Supersedes abandoned run ${supersedesRun}.`);
  }

  // Recovery
  if (facts.recovery.active) {
    const attempts = facts.recovery.regate_attempts > 0
      ? `; regate attempts: ${facts.recovery.regate_attempts}`
      : '';
    const recoveryType = safeDiagnosticText(facts.recovery.type, 64) ?? 'recorded';
    lines.push(`Recovery: ${recoveryType}${attempts}`);
  }

  // Remediation route
  if (facts.remediation.active) {
    const route = safeDiagnosticText(facts.remediation.route, 64) ?? 'unknown';
    const cycle = facts.remediation.cycle ? ` (cycle ${facts.remediation.cycle})` : '';
    lines.push(`Remediation route: ${route}${cycle}`);
  }

  lines.push(`Retries: ${facts.retry.retry_count}`);
  if (facts.expiry.expired_count > 0) lines.push(`Expired tickets: ${facts.expiry.expired_count}`);

  // Input hold
  if (facts.input_hold.occurred) {
    const count = facts.input_hold.question_count;
    lines.push(`Input-hold: answered ${count} question${count === 1 ? '' : 's'}`);
  }

  return lines.join('\n');
}

function validatedMetricsQuery(query) {
  const output = {};
  for (const key of ['since', 'until']) {
    if (query[key] === undefined) continue;
    if (
      typeof query[key] !== 'string'
      || !ISO_TIMESTAMP.test(query[key])
      || !Number.isFinite(Date.parse(query[key]))
    ) {
      throw new Error(`metrics ${key} must be a valid ISO timestamp`);
    }
    output[key] = query[key];
  }
  if (output.since && output.until && Date.parse(output.since) > Date.parse(output.until)) {
    throw new Error('metrics since must be earlier than or equal to until');
  }
  const enumFilters = {
    lane: METRICS_LANES,
    mode: METRICS_MODES,
    host: METRICS_HOSTS,
    status: METRICS_STATUSES,
  };
  for (const [key, allowed] of Object.entries(enumFilters)) {
    if (query[key] === undefined) continue;
    if (typeof query[key] !== 'string' || !allowed.has(query[key])) {
      throw new Error(`metrics ${key} must be one of: ${[...allowed].join(', ')}`);
    }
    output[key] = query[key];
  }
  return output;
}

export async function calculateProjectMetrics(paths, query = {}) {
  const filters = validatedMetricsQuery(query);
  const files = await listHistoryFiles(paths);
  const { primaries, supersedingByRun } = partitionHistoryFiles(files);
  const effectiveRecords = [];
  const selectedPrimaries = primaries.slice(0, MAX_HISTORY_RECORDS);
  for (const file of selectedPrimaries) {
    const primary = await readHistoryJson(paths, file);
    if (!primary) continue;
    const superseding = [];
    for (const supersedingFile of supersedingByRun.get(file.slice(0, -5)) ?? []) {
      const supersedingRecord = await readHistoryJson(paths, supersedingFile);
      if (supersedingRecord) superseding.push(supersedingRecord);
    }
    const effective = selectEffectiveRecord(primary, superseding);
    if (effective) effectiveRecords.push(effective);
  }

  const sinceMs = filters.since ? Date.parse(filters.since) : -Infinity;
  const untilMs = filters.until ? Date.parse(filters.until) : Infinity;

  const matching = effectiveRecords.filter((record) => {
    if (filters.lane !== undefined && record.lane !== filters.lane) return false;
    if (filters.mode !== undefined && record.mode !== filters.mode) return false;
    if (filters.host !== undefined && record.host !== filters.host) return false;
    if (filters.status !== undefined && record.status !== filters.status) return false;

    if (filters.since || filters.until) {
      const recordDateStr = record.created_at ?? record.completed_at ?? record.terminal_at;
      if (!recordDateStr) return false;
      const recordMs = Date.parse(recordDateStr);
      if (!Number.isFinite(recordMs)) return false;
      if (recordMs < sinceMs || recordMs > untilMs) return false;
    }

    return true;
  });

  const totalRuns = matching.length;
  const outcomes = {
    completed: 0,
    blocked: 0,
    aborted: 0,
  };

  for (const record of matching) {
    if (record.status === 'completed') outcomes.completed += 1;
    else if (record.status === 'blocked') outcomes.blocked += 1;
    else if (record.status === 'aborted') outcomes.aborted += 1;
    else if (record.status) {
      outcomes[record.status] = (outcomes[record.status] ?? 0) + 1;
    }
  }

  const successRate = totalRuns > 0 ? outcomes.completed / totalRuns : 0;
  const blockedRate = totalRuns > 0 ? outcomes.blocked / totalRuns : 0;
  const abortedRate = totalRuns > 0 ? outcomes.aborted / totalRuns : 0;

  const validDurations = [];
  let legacyUnknownLane = 0;
  let legacyUnknownHost = 0;
  let legacyUnknownDuration = 0;

  for (const record of matching) {
    if (!record.lane || record.lane === 'none') {
      legacyUnknownLane += 1;
    }
    if (!record.host) {
      legacyUnknownHost += 1;
    }

    let duration = null;
    const startMs = Date.parse(record.created_at ?? '');
    const endMs = Date.parse(record.completed_at ?? record.terminal_at ?? '');
    if (Number.isFinite(startMs) && Number.isFinite(endMs) && endMs >= startMs) {
      duration = endMs - startMs;
    } else if (typeof record.timing?.raw_ms === 'number' && Number.isFinite(record.timing.raw_ms) && record.timing.raw_ms >= 0) {
      duration = record.timing.raw_ms;
    }

    if (duration !== null) {
      validDurations.push(duration);
    } else {
      legacyUnknownDuration += 1;
    }
  }

  validDurations.sort((a, b) => a - b);

  function percentile(sorted, p) {
    if (sorted.length === 0) return null;
    const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
    return sorted[index];
  }

  const durations = {
    p50: percentile(validDurations, 50),
    p90: percentile(validDurations, 90),
    p95: percentile(validDurations, 95),
    p99: percentile(validDurations, 99),
  };

  return {
    coverage: {
      available_runs: primaries.length,
      processed_runs: selectedPrimaries.length,
      limit: MAX_HISTORY_RECORDS,
      truncated: primaries.length > selectedPrimaries.length,
    },
    total_runs: totalRuns,
    outcomes,
    success_rate: successRate,
    blocked_rate: blockedRate,
    aborted_rate: abortedRate,
    durations,
    legacy_unknown: {
      lane: legacyUnknownLane,
      host: legacyUnknownHost,
      duration: legacyUnknownDuration,
    },
  };
}
