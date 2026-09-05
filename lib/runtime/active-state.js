import { constants as fsConstants } from 'node:fs';
import { lstat, open } from 'node:fs/promises';
import { RECEIPT_STATUSES, SCHEMA_VERSION } from './constants.js';
import { isCanonicalRunId, strictIsoMs } from './diagnostics.js';
import { boundedGateSummary } from './bounded-summary.js';

// active.json is the single live ownership selector, so every caller must be
// able to inspect it without following a repository-planted redirect, opening
// a blocking special file, or retaining an unbounded payload. Eight MiB is far
// above the largest valid state produced by the bounded runtime schemas while
// keeping status/SessionStart memory use finite under a damaged or hostile
// artifact.
export const ACTIVE_STATE_MAX_BYTES = 8 * 1024 * 1024;
const MISSING_ACTIVE_STATE = Symbol('missing-active-state');
const ACTIVE_STATE_OPEN_RACE_CODES = new Set(['ELOOP', 'ENOENT', 'ENXIO', 'EISDIR']);

function ordinaryActiveStateFile(metadata) {
  return metadata.isFile() &&
    !metadata.isSymbolicLink() &&
    metadata.nlink === 1;
}

function activeStateFileSnapshot(metadata) {
  return Object.freeze({
    dev: String(metadata.dev),
    ino: String(metadata.ino),
    mode: Number(metadata.mode),
    nlink: Number(metadata.nlink),
    size: Number(metadata.size),
    mtime_ms: Number(metadata.mtimeMs),
    ctime_ms: Number(metadata.ctimeMs),
  });
}

function sameActiveStateFileSnapshot(left, right) {
  const leftSnapshot = left?.mtime_ms === undefined ? activeStateFileSnapshot(left) : left;
  const rightSnapshot = right?.mtime_ms === undefined ? activeStateFileSnapshot(right) : right;
  return leftSnapshot.dev === rightSnapshot.dev &&
    leftSnapshot.ino === rightSnapshot.ino &&
    leftSnapshot.mode === rightSnapshot.mode &&
    leftSnapshot.nlink === rightSnapshot.nlink &&
    leftSnapshot.size === rightSnapshot.size &&
    leftSnapshot.mtime_ms === rightSnapshot.mtime_ms &&
    leftSnapshot.ctime_ms === rightSnapshot.ctime_ms;
}

// Override reset uses the exact snapshot diagnosed by activeState before it
// renames the directory entry. This prevents a stale diagnosis from moving a
// newly replaced valid run while still allowing symlinks/FIFOs to be moved
// without ever opening or following them.
export function activeStateDiagnosisMatchesEntry(metadata, corruptError, { afterRename = false } = {}) {
  if (!corruptError?.entry_snapshot) return false;
  const snapshot = { ...activeStateFileSnapshot(metadata) };
  // A rename may change ctime even when the captured inode and payload are
  // unchanged. All other properties must still match the diagnosed entry.
  if (afterRename) snapshot.ctime_ms = corruptError.entry_snapshot.ctime_ms;
  return sameActiveStateFileSnapshot(snapshot, corruptError.entry_snapshot);
}

function tagActiveStateError(error, file, variant, detail, metadata = null) {
  error.code = 'APE_CORRUPT_ACTIVE_STATE';
  error.file = file;
  error.parse_error = detail;
  error.variant = variant;
  if (metadata) error.entry_snapshot = activeStateFileSnapshot(metadata);
  return error;
}

function unsafeStateError(file, metadata = null, changed = false) {
  const detail = changed
    ? 'unsafe: active state entry changed while it was being inspected'
    : 'unsafe: active state path is not a regular single-link file';
  return tagActiveStateError(
    new Error(
      `active run state at ${file} is unsafe (${detail}); no run operation can read it — recover with ape_run override operation reset (an audit reason is required), which quarantines the unsafe entry without following it and leaves the runtime startable`,
    ),
    file,
    'unsafe',
    detail,
    metadata,
  );
}

function oversizedStateError(file, metadata = null) {
  const detail = `oversized: active state exceeds the ${ACTIVE_STATE_MAX_BYTES}-byte limit`;
  return tagActiveStateError(
    new Error(
      `active run state at ${file} is oversized (${detail}); no run operation can read it — recover with ape_run override operation reset (an audit reason is required), which quarantines the oversized entry and leaves the runtime startable`,
    ),
    file,
    'oversized',
    detail,
    metadata,
  );
}

// Descriptor-bound read of the live ownership selector. The lstat/open/fstat
// sequence refuses symlinks and special files before they can be followed or
// block, while the final fstat+lstat pair proves the path still names the same
// immutable-sized, single-link regular file that was opened. Atomic APE writes
// satisfy this naturally; an external in-place or rename race fails closed.
async function readActiveStateArtifact(file) {
  let before;
  try {
    before = await lstat(file);
  } catch (error) {
    if (error?.code === 'ENOENT') return MISSING_ACTIVE_STATE;
    throw error;
  }
  if (!ordinaryActiveStateFile(before)) throw unsafeStateError(file, before);
  if (before.size > ACTIVE_STATE_MAX_BYTES) throw oversizedStateError(file, before);

  const flags = fsConstants.O_RDONLY |
    (fsConstants.O_NONBLOCK ?? 0) |
    (fsConstants.O_NOFOLLOW ?? 0);
  let handle;
  try {
    handle = await open(file, flags);
  } catch (error) {
    if (ACTIVE_STATE_OPEN_RACE_CODES.has(error?.code)) {
      throw unsafeStateError(file, before, true);
    }
    throw error;
  }

  try {
    const opened = await handle.stat();
    if (!ordinaryActiveStateFile(opened)) throw unsafeStateError(file, before, true);
    if (opened.size > ACTIVE_STATE_MAX_BYTES) throw oversizedStateError(file, before);
    if (!sameActiveStateFileSnapshot(before, opened)) {
      throw unsafeStateError(file, before, true);
    }

    // One byte beyond the opened size detects growth without allocating the
    // full global cap for every ordinary status read. A file already at the cap
    // gets cap+1 bytes so growth crosses into the explicit oversized variant.
    const buffer = Buffer.allocUnsafe(Math.max(1, Number(opened.size) + 1));
    let bytesRead = 0;
    while (bytesRead < buffer.length) {
      const result = await handle.read(
        buffer,
        bytesRead,
        buffer.length - bytesRead,
        bytesRead,
      );
      if (result.bytesRead === 0) break;
      bytesRead += result.bytesRead;
    }
    if (bytesRead > ACTIVE_STATE_MAX_BYTES) throw oversizedStateError(file, opened);

    const openedAfter = await handle.stat();
    let after;
    try {
      after = await lstat(file);
    } catch (error) {
      if (error?.code === 'ENOENT') throw unsafeStateError(file, opened, true);
      throw error;
    }
    if (!ordinaryActiveStateFile(openedAfter) || !ordinaryActiveStateFile(after)) {
      throw unsafeStateError(file, before, true);
    }
    if (
      openedAfter.size > ACTIVE_STATE_MAX_BYTES ||
      after.size > ACTIVE_STATE_MAX_BYTES
    ) throw oversizedStateError(file, before);
    if (
      bytesRead !== opened.size ||
      !sameActiveStateFileSnapshot(opened, openedAfter) ||
      !sameActiveStateFileSnapshot(opened, after)
    ) throw unsafeStateError(file, before, true);

    return {
      encoded: buffer.subarray(0, bytesRead).toString('utf8'),
      metadata: after,
    };
  } finally {
    await handle.close();
  }
}

// A present-but-unparseable active.json is an in-session recovery condition,
// not a crash: tag the parse fault (code APE_CORRUPT_ACTIVE_STATE) with an
// actionable message naming the one lever that clears it — override reset — so
// every entry point below can react to the tag instead of leaking a bare
// SyntaxError before its reset/null-check arm (invariant 8, follow-up to #241).
function corruptStateError(file, parseError, metadata = null) {
  // Roadmap entry sink-guard-coverage-and-detection-completeness, ITEM 3:
  // modern V8 embeds a snippet of the OFFENDING INPUT BYTES (the malformed
  // active.json content) in a JSON.parse SyntaxError's own message, so this
  // text is not purely runtime-derived.
  //
  // BLOCKING (security-review, this run): an earlier version of this comment
  // claimed the thrown Error's own human-readable message (just below) is
  // "not a persisted or wire sink" -- that claim was FALSE. statusRun and
  // overrideRun catch APE_CORRUPT_ACTIVE_STATE and build their own wording
  // from error.parse_error, never from error.message -- but every OTHER entry
  // point (resumeRun, abortRun, regateRun, shipRun, expireDispatch, and
  // nextRun by way of resumeRun) does not special-case this code at all and
  // lets the thrown error propagate UNCAUGHT. bin/ape-mcp.mjs's generic
  // tool-fault handling then echoes a thrown error's .message VERBATIM onto
  // the wire (executeToolCall's isError tool result, createToolCallQueue's
  // -32603 frame) -- bypassing projection.js's bounding entirely. That IS a
  // wire sink. Fixed HERE instead of there (bin/ape-mcp.mjs is not claimed by
  // this run): the shared text is bounded ONCE, below, before either the
  // thrown message or error.parse_error embeds it, so it no longer matters
  // which consumer reaches it, caught or uncaught -- nothing downstream needs
  // its own bind.
  //
  // The fixed template wording around the parenthetical stays byte-stable
  // (pinned by the R1-R6/S1-S5/T16/W3 suites, every one of which matches by
  // substring, never the exact embedded snippet) -- only the parenthetical
  // itself is now routed through the same bound, and boundedGateSummary is
  // provably identity on an ordinary V8 SyntaxError message (short, printable
  // ASCII, no repeated internal whitespace), so no currently pinned message is
  // disturbed.
  const boundedParseError = boundedGateSummary(parseError.message);
  const error = /** @type {any} */ (new Error(
    `active run state at ${file} is unparseable (${boundedParseError}); no run operation can read it — recover with ape_run override operation reset (an audit reason is required), which quarantines the corrupt state and leaves the runtime startable`,
  ));
  return tagActiveStateError(error, file, 'unparseable', boundedParseError, metadata);
}

// A parseable-but-schema-invalid active.json (valid JSON that is NOT a run
// state: a non-object like 42, an array, or an object with no string run_id
// like {}) reads cleanly, so it slips past the SyntaxError arm and drives the
// reducers into a misleading refusal instead of the honest corrupt-state path.
// Tag it with the SAME code and file as the unparseable arm so every consumer
// (statusRun diagnosis, next/resume/abort refusal, override reset quarantine)
// reacts identically, but with a distinct schema-invalid message and a
// synthetic parse_error — the unparseable message above stays byte-stable
// (pinned by the T16 suite).
function schemaInvalidStateError(file, metadata = null) {
  const parseError = 'schema-invalid: not a run state object';
  const error = /** @type {any} */ (new Error(
    `active run state at ${file} is schema-invalid (not a run state object carrying a string run_id); no run operation can read it — recover with ape_run override operation reset (an audit reason is required), which quarantines the corrupt state and leaves the runtime startable`,
  ));
  return tagActiveStateError(error, file, 'schema-invalid', parseError, metadata);
}

// The minimal run-state shape every reducer assumes: a plain object (not null,
// not an array) carrying a string run_id. A literal `null` payload is NOT a
// shape violation — it is the ENOENT-equivalent "no active run" sentinel and is
// checked before this guard runs.
function isRunStateShape(value) {
  const maxCollection = 256;
  const canonicalStages = new Set([
    'plan', 'plan-replan', 'preflight', 'plan-check', 'plan-critic', 'plan-judge',
    'test', 'test-reconcile', 'test-recheck', 'build', 'implement',
    'review', 'security-review', 'remediation-test', 'remediation-build',
    'remediation-review', 'remediation-security-review', 'gates', 'merge',
    'dispatch', 'start', 'complete', 'completed', 'aborted', 'debug', 'spike',
  ]);
  const canonicalRoles = new Set([
    'test_writer', 'implementer', 'reviewer', 'security_reviewer', 'planner',
    'preflight_analyst', 'plan_checker', 'plan_critic', 'plan_judge', 'debugger',
    'spike_researcher',
  ]);
  const safeIdentifier = (item) =>
    typeof item === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(item);
  const safeOptionalIdentifier = (item) => item === undefined || safeIdentifier(item);
  const objectArray = (items, validate) =>
    items === undefined || (
      Array.isArray(items) &&
      items.length <= maxCollection &&
      items.every((item) =>
        item && typeof item === 'object' && !Array.isArray(item) && validate(item))
    );
  const ticketArray = (items) => objectArray(items, (ticket) =>
    safeIdentifier(ticket.ticket_id) &&
    canonicalStages.has(ticket.stage_id) &&
    canonicalRoles.has(ticket.role) &&
    safeOptionalIdentifier(ticket.model_tier) &&
    (ticket.attempt === undefined || (Number.isInteger(ticket.attempt) && ticket.attempt > 0)) &&
    (ticket.deadline_at === undefined || strictIsoMs(ticket.deadline_at) !== null));
  const receiptArray = (items) => objectArray(items, (receipt) =>
    safeOptionalIdentifier(receipt.receipt_id) &&
    safeOptionalIdentifier(receipt.ticket_id) &&
    safeOptionalIdentifier(receipt.stage_id) &&
    safeOptionalIdentifier(receipt.role) &&
    RECEIPT_STATUSES.includes(receipt.status));
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    isCanonicalRunId(value.run_id) &&
    ticketArray(value.tickets) &&
    receiptArray(value.receipts) &&
    (value.expired_tickets === undefined || (
      Array.isArray(value.expired_tickets) &&
      value.expired_tickets.length <= maxCollection &&
      value.expired_tickets.every(safeIdentifier)
    ))
  );
}

function isActionableRunStateShape(value) {
  const plain = (item) => item && typeof item === 'object' && !Array.isArray(item);
  const strings = (items) => Array.isArray(items) && items.every((item) => typeof item === 'string');
  const identifier = (item) =>
    typeof item === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(item);
  const questions = value?.preflight?.questions ?? value?.preflight?.artifact?.questions;
  return isRunStateShape(value) &&
    value.schema_version === SCHEMA_VERSION &&
    ['planning', 'running', 'input_required', 'gating', 'blocked', 'shipping', 'completed', 'aborted']
      .includes(value.status) &&
    ['phase', 'debug', 'spike', 'land'].includes(value.mode) &&
    ['auto', 'mechanical', 'fast', 'full'].includes(value.lane) &&
    ['claude', 'codex'].includes(value.host) &&
    Array.isArray(value.tickets) &&
    Array.isArray(value.receipts) &&
    strings(value.claimed_paths) &&
    strings(value.test_paths) &&
    strings(value.risk_triggers) &&
    Array.isArray(value.audit) &&
    plain(value.preflight) &&
    /^[a-f0-9]{64}$/iu.test(value.preflight.artifact_hash ?? '') &&
    Array.isArray(questions) &&
    questions.length > 0 &&
    questions.length <= 256 &&
    questions.every((question) => plain(question) && identifier(question.id)) &&
    plain(value.input_required);
}

export async function activeState(paths, { requireActionable = false } = {}) {
  const artifact = await readActiveStateArtifact(paths.active);
  // Preserve the historical ENOENT sentinel without conflating it with the
  // literal JSON payload `null`, which remains the explicit no-active-run
  // value below.
  if (artifact === MISSING_ACTIVE_STATE) return null;

  let state;
  try {
    state = JSON.parse(artifact.encoded);
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw corruptStateError(paths.active, error, artifact.metadata);
    }
    throw error;
  }
  // null is "no active run" (ENOENT fallback or a literal `null` payload) — keep
  // its current semantics. A non-null value that is not a run state is
  // schema-invalid corruption: tag it identically to the unparseable arm so the
  // same consumers recover it (follow-up 2).
  if (
    state !== null &&
    (!isRunStateShape(state) || (requireActionable && !isActionableRunStateShape(state)))
  ) throw schemaInvalidStateError(paths.active, artifact.metadata);
  return state;
}

