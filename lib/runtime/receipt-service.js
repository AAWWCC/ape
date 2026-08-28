import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { access, lstat, mkdir, readFile, readdir, realpath, rm } from 'node:fs/promises';
import { AUTO_MERGE_HOLD_REASON, CHECKS_REGISTRATION_RETRY_DELAY_MS, GATE_INLINE_GRACE_MS, GATE_NEXT_MAX_WAIT_MS, GATE_NEXT_POLL_FLOOR_MS, GATE_POLL_RETRY_DELAY_MS, RISK_TRIGGERS, ROLE_POLICIES, RUNTIME_VERSION, SCHEMA_VERSION, SCOPE_EXPANSION_REASONS_MAX, SEALED_STATUSES, TERMINAL_STATUSES } from './constants.js';
import { runtimePaths } from './paths.js';
import { atomicReplaceText, atomicWriteJson, appendJsonLine, readJson, replaceFile } from './storage.js';
import { acquireRunLock, inspectRunLock, releaseRunLock, stealLockFileByRename, withDirLock } from './lock.js';
import { assertRunnersValue, DEFAULT_CONFIG, loadRuntimeConfig, proposeTestCommands, resolveModel, setRuntimeConfig } from './config.js';
import { classifyLane, escalateLane } from './lane-policy.js';
import { declaredTestRemediationPaths, declaredTestRemediations, extractTestRemediation } from './pipeline.js';
import { REVIEW_FINDINGS_BLOCK_LIMIT, REVIEW_FINDINGS_MAX, reduceRun } from './scheduler.js';
import {
  finalizeReceipt,
  finalizeTicket,
  REVIEW_CONTRACT_VERSION,
  RunStartInputSchema,
  validateStructuredReviewReceipt,
  TaskOperationGcRecordSchema,
  TaskOperationIdSchema,
  TaskOperationTransactionSchema,
} from './schemas.js';
import { currentBranch, currentCommitSha, currentTreeSha, diffFiles, resolveBaseBranch, runGit, treeHasPath, treeShaSession, workingTreeStatus } from './git.js';
import { snapshotEvidenceExecutables } from './hooks.js';
import { TEST_PATH_PATTERN, looksLikeTest, normalizeClaimPath, withinClaims } from './path-scope.js';
import { validateStageReceipt } from './receipt-validator.js';
import { detectTestRunner, isPytestInvocation, runTestSuite, splitCommand, targetedInvocation, templateInvocation } from './runner.js';
import { archiveRun as archiveRunRecord, explainRun, queryHistory, selectEffectiveRecord } from './history.js';
import { importLegacyPlanning } from './importer.js';
import { doctor } from './doctor.js';
import { statuslineState, unwireStatusline, wireStatusline } from './statusline.js';
import { autoMergeGithub, evaluateGates, impactedMergeGuard, pollGateSuite, pollRemoteChecksAndMerge, runnerOwnsFile, startGateSuite } from './gates.js';
import { killProcessTree } from './spawn.js';
import { nativeDispatch } from './adapters.js';
import {
  completeClaudeReceiptBinding,
  dispatchIntentStatuses,
  expireClaudeIntent,
  expireClaudeIntentsForRun,
  prepareCodexIntent,
  prepareClaudeIntent,
  pruneClaudeIntents,
  validateClaudeReceiptBinding,
} from './claude-dispatch.js';
import { assertSafeInput } from './input-guard.js';
import { normalizeReceiptInput } from './receipt-input.js';
import { hashRecord, sha256 } from './canonical.js';
import { parseToolClaim, toolClaimAllows } from './external-tools.js';
import {
  candidatePlanForScope,
  CURRENT_PLAN_CONTRACT_VERSION,
  PLAN_CONTRACT_VERSION,
  validatePreflightArtifact,
  validatePlanDeviation,
} from './plan-contract.js';
import { renderStatusDoc } from './status-doc.js';
import { assertRoadmapRequirementsReady, deriveRoadmap, registerEntries, supersedeEntries } from './roadmap.js';
import {
  compactArchivedArtifacts,
  readArtifactRetentionStatus,
  recordArtifactRetentionStatus,
} from './retention.js';
import {
  acknowledgeBindingProbe,
  bindingProbeStatus,
  consumeBindingProbe,
  prepareBindingProbe,
} from './binding-probe.js';
import { BOUNDED_SUMMARY_CONTROL_CHARS, REPLACEMENT_CHARACTER, activeState, boundedGateSummary, codePointRange, now } from './status-service.js';

const RECEIPT_LOCK_STALE_MS = 60_000;
const RECEIPT_LOCK_HEARTBEAT_MS = 15_000;
const RECEIPT_LOCK_BUSY_MS = 15_000;

// Serializes every writer of receipt effects (receipt recording, abort,
// override) behind one on-disk lock. Staleness is judged by the lock's mtime,
// and the critical section legitimately runs for minutes (a full-suite gate
// run) — the remote-checks watch is no longer held here at all: it is now a
// bounded, resumable per-`next` poll (poll_shipping) that rests the run in
// 'shipping' between slices rather than parking this lock for the whole watch.
// A live holder refreshes a heartbeat on the lock, so only a genuinely dead
// holder — one whose heartbeat stopped — is stolen (F9).
// The steal/release protocol (rename tombstone + owner token) lives in the
// shared withDirLock so two contenders can never both enter (invariant 7).
// Exported for tests only; production callers go through the service API.
export async function withReceiptLock(paths, operation, options = {}) {
  const lockOptions = {
    staleMs: options.staleMs ?? RECEIPT_LOCK_STALE_MS,
    heartbeatMs: options.heartbeatMs ?? RECEIPT_LOCK_HEARTBEAT_MS,
    busyMs: options.busyMs ?? RECEIPT_LOCK_BUSY_MS,
    serializeLocal: true,
    busyMessage: options.busyMessage ?? 'receipt effects are busy; retry the identical receipt',
  };
  return withDirLock(paths.receiptLock, operation, lockOptions);
}

// MCP Tasks are durable independently of the process that executes them, but
// the APE effects they wrap are still serialized by receipt-effects.lock. The
// operation journal closes the response-loss window: once an effect returned,
// its exact service result is written before it is exposed to the task store.
// A replay of an effect-committed operation returns those bytes as data and
// never charges the underlying lever a second time.
const TASK_OPERATION_TTL_MS = 7 * 24 * 60 * 60_000;
const TASK_OPERATION_MAX_BYTES = 3 * 1_024 * 1_024;
export const TASK_OPERATION_MAX_LIVE_RECORDS = 4_096;
const TASK_OPERATION_MAX_GC_AUDITS = 4_096;
const TASK_OPERATION_GC_RETENTION_MS = 7 * 24 * 60 * 60_000;
const TASK_OPERATION_HASH_PLACEHOLDER = '0'.repeat(64);

function taskOperationStorePaths(paths) {
  const directory = path.join(paths.runtime, 'task-operation-transactions');
  return {
    directory,
    gc: path.join(directory, '.gc'),
  };
}

export function taskOperationTransactionPath(paths, operationId) {
  return path.join(taskOperationStorePaths(paths).directory, `${sha256(operationId)}.json`);
}

async function ensurePrivateTaskOperationDirectory(directory) {
  try {
    const metadata = await lstat(directory);
    if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
      throw new Error(`APE task operation store path is unsafe: ${directory}`);
    }
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
    try {
      await mkdir(directory, { mode: 0o700 });
    } catch (mkdirError) {
      if (mkdirError?.code !== 'EEXIST') throw mkdirError;
      const metadata = await lstat(directory);
      if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
        throw new Error(`APE task operation store path is unsafe: ${directory}`);
      }
    }
  }
}

export async function prepareGovernedRuntimeAncestor(paths) {
  const canonicalRoot = await realpath(paths.root);
  const apeDirectory = path.join(paths.root, '.ape');
  const expectedApe = path.join(canonicalRoot, '.ape');
  await ensurePrivateTaskOperationDirectory(apeDirectory);
  const apeMetadata = await lstat(apeDirectory);
  if (apeMetadata.isSymbolicLink() || await realpath(apeDirectory) !== expectedApe) {
    throw new Error('APE state path resolves outside the governed private path');
  }
  await ensurePrivateTaskOperationDirectory(paths.runtime);
  const runtimeMetadata = await lstat(paths.runtime);
  const expectedRuntime = path.join(expectedApe, 'runtime');
  if (
    runtimeMetadata.isSymbolicLink()
    || !runtimeMetadata.isDirectory()
    || await realpath(paths.runtime) !== expectedRuntime
  ) {
    throw new Error('APE runtime path resolves outside the governed private path');
  }
  return canonicalRoot;
}

export async function prepareTaskOperationStore(paths) {
  const store = taskOperationStorePaths(paths);
  const canonicalRoot = await prepareGovernedRuntimeAncestor(paths);
  // Only create extension-owned descendants after the existing runtime
  // ancestor is proven in-root; a planted parent symlink must have no effect.
  await ensurePrivateTaskOperationDirectory(store.directory);
  await ensurePrivateTaskOperationDirectory(store.gc);
  const expectedDirectory = path.join(canonicalRoot, '.ape', 'runtime', 'task-operation-transactions');
  if (
    await realpath(store.directory) !== expectedDirectory
    || await realpath(store.gc) !== path.join(expectedDirectory, '.gc')
  ) {
    throw new Error('APE task operation store resolves outside the governed private path');
  }
  return { ...store, rootBinding: sha256(`ape-task-operation-root-v1:${canonicalRoot}`) };
}

function finalizeTaskOperationTransaction(record, rootBinding) {
  const materialized = TaskOperationTransactionSchema.parse({
    ...record,
    version: 1,
    root_binding: rootBinding,
    expected_run_id: record.expected_run_id ?? null,
    expires_at: record.expires_at ?? new Date(Date.now() + TASK_OPERATION_TTL_MS).toISOString(),
    record_hash: TASK_OPERATION_HASH_PLACEHOLDER,
  });
  return TaskOperationTransactionSchema.parse({
    ...materialized,
    record_hash: hashRecord(materialized, ['record_hash']),
  });
}

function finalizeTaskOperationGcRecord(record, rootBinding) {
  const materialized = TaskOperationGcRecordSchema.parse({
    ...record,
    version: 1,
    root_binding: rootBinding,
    record_hash: TASK_OPERATION_HASH_PLACEHOLDER,
  });
  return TaskOperationGcRecordSchema.parse({
    ...materialized,
    record_hash: hashRecord(materialized, ['record_hash']),
  });
}

async function readBoundedTaskOperationJson(file, schema, rootBinding, label) {
  let raw;
  try {
    const metadata = await lstat(file);
    if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size > TASK_OPERATION_MAX_BYTES) {
      throw new Error(`${label} is unsafe or oversized`);
    }
    raw = JSON.parse(await readFile(file, 'utf8'));
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
  const parsed = schema.safeParse(raw);
  if (
    !parsed.success
    || parsed.data.root_binding !== rootBinding
    || hashRecord(parsed.data, ['record_hash']) !== parsed.data.record_hash
  ) {
    throw new Error(`${label} failed root, schema, or hash validation`);
  }
  return parsed.data;
}

export async function readTaskOperationTransaction(file, store) {
  return readBoundedTaskOperationJson(
    file,
    TaskOperationTransactionSchema,
    store.rootBinding,
    'APE task operation transaction',
  );
}

export async function writeTaskOperationTransaction(file, store, record) {
  const finalized = finalizeTaskOperationTransaction(record, store.rootBinding);
  await atomicWriteJson(file, finalized);
  return finalized;
}

async function pruneTaskOperationGc(store, timestamp) {
  const entries = await readdir(store.gc, { withFileTypes: true });
  const retained = [];
  for (const entry of entries) {
    if (!entry.isFile() || entry.isSymbolicLink() || !/^[0-9a-f]{64}\.json$/.test(entry.name)) {
      throw new Error(`APE task operation GC store contains an unexpected entry: ${entry.name}`);
    }
    const file = path.join(store.gc, entry.name);
    const record = await readBoundedTaskOperationJson(
      file,
      TaskOperationGcRecordSchema,
      store.rootBinding,
      'APE task operation GC record',
    );
    if (Date.parse(record.collected_at) + TASK_OPERATION_GC_RETENTION_MS <= timestamp) {
      await rm(file, { force: true });
    } else {
      retained.push({ file, record });
    }
  }
  retained.sort((left, right) => Date.parse(left.record.collected_at) - Date.parse(right.record.collected_at));
  for (const entry of retained.slice(0, Math.max(0, retained.length - TASK_OPERATION_MAX_GC_AUDITS))) {
    await rm(entry.file, { force: true });
  }
}

export async function collectExpiredTaskOperationTransactions(paths, store, timestamp = Date.now()) {
  await pruneTaskOperationGc(store, timestamp);
  const entries = await readdir(store.directory, { withFileTypes: true });
  let retained = 0;
  for (const entry of entries) {
    if (entry.name === '.gc' && entry.isDirectory() && !entry.isSymbolicLink()) continue;
    if (!entry.isFile() || entry.isSymbolicLink() || !/^[0-9a-f]{64}\.json$/.test(entry.name)) {
      throw new Error(`APE task operation store contains an unexpected entry: ${entry.name}`);
    }
    const file = path.join(store.directory, entry.name);
    const transaction = await readTaskOperationTransaction(file, store);
    if (Date.parse(transaction.expires_at) > timestamp) {
      retained += 1;
      continue;
    }
    const audit = finalizeTaskOperationGcRecord({
      operation_id: transaction.operation_id,
      action: transaction.action,
      status: transaction.status,
      transaction_hash: transaction.record_hash,
      expired_at: transaction.expires_at,
      collected_at: new Date(timestamp).toISOString(),
    }, store.rootBinding);
    await atomicWriteJson(path.join(store.gc, entry.name), audit);
    await rm(file, { force: true });
  }
  await pruneTaskOperationGc(store, timestamp);
  return retained;
}

export async function executeTaskOperationTransaction(projectDir, operation, effect) {
  const paths = runtimePaths(projectDir);
  const operationId = operation?.operationId;
  if (!TaskOperationIdSchema.safeParse(operationId).success) {
    throw new Error('task operation requires a valid operationId');
  }
  const inputHash = sha256(JSON.stringify({
    action: operation.action,
    request: operation.request,
    expected_run_id: operation.expectedRunId ?? null,
    preflight_refusal: operation.preflightRefusal ?? null,
  }));
  const transactionFile = taskOperationTransactionPath(paths, operationId);
  await prepareGovernedRuntimeAncestor(paths);
  return withReceiptLock(paths, async () => {
    const store = await prepareTaskOperationStore(paths);
    const retainedTransactions = await collectExpiredTaskOperationTransactions(paths, store);
    const existing = await readTaskOperationTransaction(transactionFile, store);
    if (existing) {
      if (existing.input_hash !== inputHash) {
        throw new Error(`task operation ${operationId} was replayed with different input`);
      }
      if (existing.status === 'effect-committed') {
        return existing.result;
      }
      // A process died after the durable prepare. We cannot prove whether its
      // charged effect ran, so recovery is fail-closed: never guess by running
      // it again. The task records this as a JSON-RPC execution failure.
      const error = Object.assign(
        new Error(`task operation ${operationId} has an indeterminate prepared transaction; refusing to rerun its charged effect`),
        { code: 'APE_TASK_OPERATION_INDETERMINATE' },
      );
      throw error;
    }
    if (retainedTransactions >= TASK_OPERATION_MAX_LIVE_RECORDS) {
      throw new Error('APE task operation store reached its bounded live-transaction capacity');
    }
    let prepared = await writeTaskOperationTransaction(transactionFile, store, {
      version: 1,
      operation_id: operationId,
      action: operation.action,
      input_hash: inputHash,
      expected_run_id: operation.expectedRunId ?? null,
      status: 'prepared',
      prepared_at: now(),
    });
    // effect MUST be a lock-free internal service body. Keeping it in this
    // callback is what makes a concurrent identical operation wait and replay,
    // rather than observe `prepared` and double-charge.
    const value = operation.isCancelled?.()
      ? { task_tool_error: 'task cancellation requested before effect start' }
      : await effect(paths);
    prepared = await writeTaskOperationTransaction(transactionFile, store, {
      ...prepared,
      status: 'effect-committed',
      result: value,
      effect_committed_at: now(),
    });
    return value;
  }, { busyMessage: 'receipt effects are busy; retry the task operation' });
}



async function archiveRun(paths, state, options = {}) {
  if (state.status === 'completed' && state.completes?.length) {
    await assertRoadmapRequirementsReady(paths, state.completes, { phase: 'completion' });
  }
  return archiveRunRecord(paths, state, options);
}

async function observedExternalToolEffects(paths, state, ticket) {
  let text;
  try {
    text = await readFile(paths.externalToolEffects, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') return [];
    throw error;
  }
  const effects = [];
  for (const [index, line] of text.split(/\r?\n/).entries()) {
    if (!line) continue;
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      throw new Error(`external tool effect audit is corrupt at line ${index + 1}`);
    }
    if (entry?.run_id !== state.run_id || entry?.ticket_id !== ticket.ticket_id) continue;
    effects.push({
      provider: entry.provider,
      operation: entry.operation,
      effect: entry.effect,
      resources: entry.resources,
      tool_use_id: entry.tool_use_id ?? null,
      status: entry.status,
      response_hash: entry.response_hash ?? null,
      occurred_at: entry.occurred_at,
    });
    if (effects.length > 256) throw new Error('external tool effect audit exceeds 256 operations for one ticket');
  }
  return effects;
}

// Bounded serialization for surfacing a malformed receipt payload in a warning
// or an audit line: JSON.stringify the offending value, fall back to String()
// for a non-serializable value, and hard-truncate so a crafted payload can never
// write an unbounded log line.
//
// Roadmap entry agent-facing-text-routes-bypassing-the-prose-bound, route (d).
// JSON.stringify escapes only U+0000-U+001F, so DEL, soft hyphen and every
// bidi/format code point pass through both the JSON.stringify branch and the
// String(value) fallback intact -- this is the ONE function feeding a
// malformed-risk-trigger receipt warning, its overrides.ndjson audit line, and
// echoRunId's abort/override refusal reasons (below), so a single fix here
// closes all three. Neutralize with the SAME render-side charset and
// replacement character boundedGateSummary uses (BOUNDED_SUMMARY_CONTROL_CHARS
// / REPLACEMENT_CHARACTER, declared below -- referencing them here is safe:
// both are module-level consts finished initializing before this function is
// ever CALLED) AFTER stringifying and BEFORE truncating, so a control/bidi
// byte can never survive into the slice this function hands back. The
// replacement is 1:1 BMP-for-BMP (see BOUNDED_SUMMARY_CONTROL_CHARS's own CAP
// INVARIANCE note), so neither the length comparison nor the slice boundary
// below moves and no message can shift position. No flatten/trim is added
// here -- unlike boundedGateSummary, this helper's callers want the value's
// shape (JSON punctuation included) intact, only its dangerous bytes closed.
const MALFORMED_RISK_TRIGGER_MAX = 512;

export function boundedSerialize(value, max) {
  let text;
  try {
    text = JSON.stringify(value);
  } catch {
    text = null;
  }
  if (typeof text !== 'string') text = String(value);
  const neutralized = text.replace(BOUNDED_SUMMARY_CONTROL_CHARS, REPLACEMENT_CHARACTER);
  return neutralized.length > max ? `${neutralized.slice(0, max)}...[truncated]` : neutralized;
}

// Runtime-measured timing provenance (T14): accumulate ONLY the runtime's OWN
// wall-clock measurements (red-test observation, the merge-gate suite incl.
// every regate, the shipping call) into run state so terminalRecord can archive
// a certification timing block. Agent-reported receipt timing is never fed here.
// The lazy default upgrades an in-flight active.json persisted before the field
// existed, and every capture accumulates (+=, never resets) so a regate ADDS to
// the block-time baseline instead of discarding it.
function accumulateTiming(state, key, ms) {
  state.timing ??= { test_ms: 0, remote_ci_ms: 0 };
  state.timing[key] += Math.max(0, Math.round(ms));
}

// A1: the detached gate artifact/job/heartbeat are consumed at evaluation —
// deleted after the transition persists. Best-effort (a leftover is inert; the
// next startGateSuite clears foreign files by nonce anyway), keyed on the watch
// descriptor's recorded file paths.
export async function cleanupGateSuite(watch) {
  if (!watch || typeof watch !== 'object') return;
  for (const file of [watch.artifact_file, watch.job_file, watch.heartbeat_file]) {
    if (typeof file === 'string' && file) await rm(file, { force: true }).catch(() => {});
  }
}

// route (b) (roadmap entry agent-facing-text-routes-bypassing-the-prose-
// bound): `run.test_paths` read here for the test_writer role carries
// whatever the SCOPE_EXPANSION_CONTROL_CHARS residual note above (~:222-229)
// describes -- bytes unioned in by recordReceiptLocked's state.test_paths
// union (~:3347), which are always RUNTIME-DERIVED from a real git diff and
// so need no character screen. See that residual note for the full
// argument; this is only the back-reference a reader arriving here first
// would otherwise lack.
function ticketClaims(run, stage) {
  if (stage.role === 'test_writer') return [...run.test_paths];
  if (stage.role === 'implementer') return [...run.claimed_paths];
  return [...new Set([...run.claimed_paths, ...run.test_paths])];
}

function ticketChecks(stage) {
  return [...stage.required_checks];
}

// Roadmap entry remediation-test-path-role-gap. The remediation-test ticket —
// and ONLY that ticket — is narrowed to the paths the blocking review declared
// (pipeline.js declaredTestRemediationPaths, unioned over the first code-review
// group). Narrowing test_paths ALONE does not enforce: receipt-validator.js:137
// falls back to withinClaims(file, ticket.claimed_paths) and its test-writer
// production check at :141 still passes for any test-patterned file, so an
// out-of-declaration write would be hook-denied yet receipt-ADMITTED. Both
// fields therefore carry the declared set.
//
// The set is derived from RUN STATE, never carried on the frozen stage object:
// stageFromTicket rebuilds a stage from schema fields only (scheduler.js:46-56,
// stageFromTicket above), so a stage-borne narrowing would vanish and silently
// re-widen on the retry ticket.
//
// state.test_paths is NEVER mutated by this — it feeds the friction #33
// production-change filter in recordReceiptLocked and must stay monotone — and
// an implementer ticket is never narrowed.
function narrowedTestClaims(state, stage) {
  if (stage.id === 'test-recheck') {
    const exact = state.test_contradiction_pending?.context?.test_paths;
    return Array.isArray(exact) && exact.length > 0 ? [...exact] : [];
  }
  if (stage.id !== 'remediation-test') return null;
  const structured = state.remediation_route?.test_paths;
  if (Array.isArray(structured) && structured.length > 0) return [...structured];
  const declared = declaredTestRemediationPaths(state);
  // THE FALLBACK IS FAIL-WIDE, AND ITS UNREACHABILITY IS ARGUED HERE — beside
  // the branch itself, not somewhere a reader has to reconstruct it from
  // (roadmap entry narrowed-test-claims-fail-wide-fallback). Returning null
  // hands issueTicket back to the FULL claim set (:675-676) on a ticket whose
  // own objective prefix asserts it "is narrowed to the declared test paths ...
  // and to no production path at all" — wider than the sentence the same ticket
  // publishes. Fail-EMPTY is not the safer-looking alternative it seems: an
  // empty narrowing issues a ticket that can write nothing at all, so a
  // declaration that had somehow evaporated would WEDGE the remediation rather
  // than widen it. The branch is therefore kept and shown to be dead, on TWO
  // legs — the first covers only the first issuance, so it is not enough alone:
  //   1. FIRST ISSUANCE — ONE SCAN, ONE STATE OBJECT. Routing (nextStages ->
  //      declaredTestRemediations), this narrowing, and testRemediationNotice
  //      all derive from the same declaredTestRemediations scan over the same
  //      state object within a single applyActions chain. The stage is only ever
  //      routed when that scan already found a declaration, and nothing mutates
  //      state between the routing decision and this call.
  //   2. RE-ISSUANCE — MONOTONICITY. A remediation-test ticket is issued a
  //      SECOND time on retry, from a LATER applyActions chain in which routing
  //      does NOT re-run and only this narrowing does: both scheduler.js retry
  //      arms (ticket expiry and a failed receipt) re-issue the stage rebuilt
  //      from the ticket itself. Leg 1 says nothing about that chain. What
  //      carries it is that the scan's inputs only ever GROW — state.receipts is
  //      appended to and state.test_paths is unioned, never rewritten or pruned
  //      (:2793-2796), and state.tickets is likewise append-only — so a
  //      declaration that satisfied the scan once still satisfies it at every
  //      later issuance, and the retry narrows exactly as the first issuance did.
  // NO BEHAVIORAL ARM PINS THIS BRANCH, said plainly instead of answered with a
  // manufactured one: reaching `declared.length === 0` here requires a
  // remediation-test stage routed with no declaration in state, which no public
  // entry point can produce. Only a hand-built state object passed directly to
  // this non-exported function reaches it, and such a test would pin the
  // fabrication rather than any runtime behavior. If a future change ever
  // separates routing from narrowing — or makes either input non-monotone — the
  // branch goes live and both legs must be re-argued before it does.
  return declared.length > 0 ? declared : null;
}

// The remediation-build ticket that FOLLOWS a remediation-test stage is issued
// by the plain nextStages arm, which carries no review_findings of its own (the
// scheduler attaches them only in the review-disagreed arm, and there they rode
// the remediation-test ticket). Forward them so the implementer still works
// from the reviewer's pinpointed file:line evidence. Narrowly keyed: only for
// remediation-build, only when the caller supplied none, and only from this
// run's newest remediation-test ticket.
function inheritedReviewFindings(state, stage) {
  if (stage.id !== 'remediation-build') return undefined;
  const source = [...state.tickets]
    .reverse()
    .find((ticket) => ticket.stage_id === 'remediation-test');
  return source?.review_findings;
}

function inheritedReviewFindingEvidence(state, stage) {
  if (stage.id !== 'remediation-build') return undefined;
  const source = [...state.tickets]
    .reverse()
    .find((ticket) => ticket.stage_id === 'remediation-test');
  return source?.review_finding_evidence;
}

// Mirrors inheritedReviewFindings exactly, for the identical reason: the
// remediation-build ticket that FOLLOWS a remediation-test stage is issued by
// the plain nextStages arm, which carries no scope_expansion of its own —
// scheduler.js attaches it only in the review-disagreed arm, and there it
// rode whichever ticket that arm actually routed to. When routing chose
// remediation-test (a declared test correction), the growth needs a SECOND
// carrier: narrowedTestClaims confines that ticket's own claimed_paths to
// authored test paths only, so the production path(s) a scope expansion
// actually adds belong on the ticket that can write them — the
// remediation-build issued next.
function inheritedScopeExpansion(state, stage) {
  if (stage.id !== 'remediation-build') return undefined;
  const source = [...state.tickets].reverse().find((ticket) => ticket.stage_id === 'remediation-test');
  return source?.scope_expansion;
}

// Roadmap entry expire-dispatch-orphan-blocks-red-admission. expirePendingTicket
// (scheduler.js) reissues a stage's ticket after the audited EXPIRE_DISPATCH
// lever or a deadline timeout WITHOUT rewinding the tree: the dead ticket's own
// writes are still on disk, so the retry's base_tree_sha (below, unchanged —
// still `tree.current()`) inherits them, on purpose (see the roadmap entry for
// why rebasing it out was rejected). Both call sites append the dead ticket_id
// to state.expired_tickets BEFORE issuing the retry (the transition action
// always precedes issue_ticket in the same reducer chain), so — for a given
// stage_id — "an earlier ticket of this stage sits in expired_tickets" is true
// exactly when the CURRENT ticket is such a retry, and false for a first
// attempt and for an ordinary non-expiry retry (a failed attempt still records
// a receipt; expiry never does, so it alone marks the ticket expired). ONE
// PROVENANCE predicate — never "a test path already exists in the base", which
// is also true of the common case of a first attempt adding a case to an
// existing suite file — called from both the retry ticket's own notice below
// and every red-test admission refusal that would otherwise misname this as a
// missing test_commands.targeted_template/targeted config, so a keying mistake
// can only happen once.
//
// ONE REMAINING CALLER, and the reason is recorded here (roadmap entry
// expiry-retry-disclosure-fidelity, defect c). This `stage_id`-first lookup is
// correct TODAY only because MAX_STAGE_ATTEMPTS = 2 (constants.js) caps a
// stage at one expiry, so "the first expired ticket of this stage_id" and "the
// one this retry actually follows" always coincide — but nothing here proves
// that, and admission refusal (emptyAuthoredTestPathsRefusal below) has no
// sharper signal available: it runs from the RECEIPT side, against the
// CURRENT ticket alone, with no `retryOf`/`retry_of` in scope at all — so it
// keeps this predicate. issueTicket, below, DOES have the exact predecessor
// (the reducer's own `retry_of: ticket.ticket_id`, scheduler.js
// expirePendingTicket) threaded into it as an argument, so it no longer needs
// to guess — see expiredPredecessorByRetryOf beside it.
function expiredPredecessorTicket(state, stageId) {
  const expired = new Set(state.expired_tickets ?? []);
  return state.tickets.find((entry) => entry.stage_id === stageId && expired.has(entry.ticket_id)) ?? null;
}

// Roadmap entry expiry-retry-disclosure-fidelity, defect (c). Selects the
// predecessor issueTicket's OWN retry actually follows — `retryOf` is the
// reducer's `retry_of: ticket.ticket_id` (scheduler.js expirePendingTicket and
// the RECEIPT_RECORDED retry arm both set it to the EXACT ticket that just
// expired or failed), never a stage_id guess. Gated on `expired_tickets`
// containing it, the same discipline expiredPredecessorTicket applies, so an
// ordinary (non-expiry) failed-receipt retry — which also carries a
// `retry_of` — still gets no "Inherited base" notice: only a receipt-less
// expiry ever orphans a tree write.
function expiredPredecessorByRetryOf(state, retryOf) {
  if (!retryOf) return null;
  const expired = new Set(state.expired_tickets ?? []);
  if (!expired.has(retryOf)) return null;
  return state.tickets.find((entry) => entry.ticket_id === retryOf) ?? null;
}

// Say so on the retry ticket itself (D2), the same discipline redTestNotice and
// TEST_REMEDIATION_NOTICE already apply to their own hard contracts: the
// alternative is exactly what run-fixture-75aad5182d37 hit — a careful
// retry that only verified the inherited content, never touched the tree
// again, and burned its last attempt on a refusal that (before this fix)
// blamed test_commands config instead of the inherited base. Composed from the
// dead predecessor's own claimed/test paths, so the notice never has to
// re-derive or restate what "its output" means.
// Security review (non-blocking, same tree as the two blocking findings this
// function's caller-side gate above closes): predecessor.claimed_paths and
// .test_paths are reachable by an earlier agent of THIS run (a test_writer's
// changed_files union into state.test_paths; a reviewer's
// evidence.scope_expansion.claimed_paths appended verbatim), so — unlike
// REVIEW_FINDINGS_NOTICE, a fixed constant that interpolates no agent-authored
// text at all — this function does splice agent-reachable data into a ticket
// OBJECTIVE. testRemediationNotice (above) already gives reviewer-authored
// prose the same treatment for the identical reason: whitespace-flattened and
// hard-bounded via boundedGateSummary, with the path list itself capped so an
// adversarially large claim set cannot balloon the objective.
const EXPIRED_PREDECESSOR_INHERITED_PATHS_MAX = 20;

// Roadmap entry expiry-retry-disclosure-fidelity, defect (b). Bound applied to
// EACH path BEFORE the join, mirroring testRemediationNotice (:204-211), which
// already bounds each reviewer reason at 200 chars INDIVIDUALLY for the
// identical reason. extractScopeExpansion (below) caps nothing on a proposed
// claim path's own length, so a single adversarially (or just accidentally)
// long inherited path used to consume the old WHOLE-STRING 200-char budget by
// itself and silently swallow every genuinely inherited path listed after it.
const EXPIRED_PREDECESSOR_PATH_MAX_CHARS = 200;

function structuredExpiredPredecessor(predecessor) {
  const inherited = [...new Set([...(predecessor.claimed_paths ?? []), ...(predecessor.test_paths ?? [])])];
  const dropsPaths = inherited.length > EXPIRED_PREDECESSOR_INHERITED_PATHS_MAX;
  // Reserve the last slot for the omission note itself when the cap bites —
  // the same reservation planArtifact makes for its own marker — so the
  // published cap never grows past EXPIRED_PREDECESSOR_INHERITED_PATHS_MAX
  // total entries even though one of them is now runtime-authored.
  const pathSlots = dropsPaths
    ? EXPIRED_PREDECESSOR_INHERITED_PATHS_MAX - 1
    : EXPIRED_PREDECESSOR_INHERITED_PATHS_MAX;
  const boundedPaths = inherited
    .slice(0, pathSlots)
    .map((entry) => boundedGateSummary(entry, EXPIRED_PREDECESSOR_PATH_MAX_CHARS))
    .filter((entry) => entry !== null);
  return {
    ticket_id: predecessor.ticket_id,
    ticket_hash: predecessor.ticket_hash,
    base_tree_sha: predecessor.base_tree_sha,
    inherited_paths: boundedPaths,
    omitted_path_count: dropsPaths ? inherited.length - pathSlots : 0,
  };
}

// Roadmap entry plan-artifact-not-forwarded-to-plan-review. The plan-review
// stages never received anything the planner recorded: the dispatch prompt
// carries only a ticket id, and reading `.ape/runtime/receipts/` is NOT
// sanctioned (prompts/common.md grants exactly one `.ape` read, the ticket file,
// and hooks.js enforces it), so both reviewers verified the design as embedded
// in the operator's run OBJECTIVE rather than the evidence the planner actually
// recorded. What is forwarded is the planner receipt's free-form `evidence`
// object — never the whole of what the planner planned, and never that receipt's
// `findings` array (see the severance record below) — and state.receipts carries
// full receipts, so the forwarding derives here from run state — exactly the
// shape inheritedReviewFindings above uses — with no scheduler, pipeline or
// dispatch change.
//
// Derived from RUN STATE at issue time, never carried on the frozen stage
// object: stageFromTicket rebuilds a stage from schema fields only, so a
// stage-borne artifact would silently vanish on the retry ticket — the same trap
// documented at narrowedTestClaims above.
//
// WHY 12 x 200, measured rather than inherited. plan-check and plan-critic issue
// in ONE parallel group, so the artifact crosses a single ape_run response FOUR
// times — both pending run.tickets[] entries and both dispatch_agent action
// tickets — because compactPendingTicket (projection.js) dedupes only
// `objective` and `output_schema` and will never drop a new ticket field. A
// plan-review response with no artifact projects to ~13.8 KB against
// RESPONSE_BUDGET_CHARS = 48,000, leaving ~34 KB. 12 entries x 200 chars is
// ~2.4 KB of text (~2.5 KB serialized) per copy, ~9.8 KB over four copies — a
// fifth of the budget, well inside that headroom. 12 entries also clears the
// largest observed planner evidence (9 keys, 6,872 bytes) without dropping a
// key, and 200 chars is the bound testRemediationNotice already applies to
// forwarded agent-authored text.
const PLAN_ARTIFACT_STAGES = new Set(['plan-check', 'plan-critic', 'plan-judge', 'plan-replan']);

export const PLAN_ARTIFACT_MAX_ENTRIES = 12;

export const PLAN_ARTIFACT_MAX_CHARS = 200;

// THE FINDINGS CHANNEL IS SEVERED, AND THAT IS RECORDED RATHER THAN HIDDEN
// (roadmap entry plan-artifact-forwards-evidence-not-findings). planArtifact
// below reads `source?.evidence` and nothing else, so a planner receipt's
// `findings` array — the structured, per-item channel where risks, traps, scope
// observations and objections naturally go — is forwarded to NO plan reviewer by
// ANY route. Unlike the truncation defect acme PR #366 closed there is no marker, no
// ellipsis and no disclosure of any kind: the material is simply absent.
// Observed twice, not hypothetically. The planner of
// run-fixture-5e50ee41888b recorded twelve findings, several bearing
// directly on the plan-check stage's own four mechanical checks, and its checker
// received none and said so. run-fixture-0d04382162e5 then recorded a
// severability finding that reached neither reviewer and would have mooted both
// of its critic's blocking grounds; it arrived at the judge only by out-of-band
// operator relay (judge receipt 232d2887, J13).
//
// FORWARDING THEM WAS WEIGHED AND REJECTED, on two independent grounds.
// (1) WIRE. It needs a NEW StageTicket field plus a SECOND bounded array on the
// four-copies-per-response channel measured directly above, whose budget PRs
// #361, #363, #364, #365 and #366 have each had to defend: a plan-review
// response with no artifact projects to ~13.8 KB, today's artifact adds ~9.8 KB
// over its four copies, and a second array of the same shape would add ~9.8 KB
// again — ~33.4 KB of RESPONSE_BUDGET_CHARS = 48,000 (projection.js).
// (2) SOUNDNESS. The runtime disclosure marker such an array would need was
// found unsound at the ENTRY-CAP BOUNDARY: the last slot is already reserved for
// the omission marker below, so a second runtime-authored marker would either
// contend for that one slot (a slot-reservation fixpoint) or publish a second
// runtime-authored entry under the single discriminator readers are given.
//
// SO THE CORRECTION IS PROSE ONLY. No entry, no array, no ticket field and no
// change to planArtifact's rendering, counting or fail-open behaviour were
// added, and the four-copies-per-response arithmetic above therefore does not
// move. THE HONEST CONSEQUENCE: the planner's findings STILL reach no reviewer.
// What changed is that no reader-facing surface claims otherwise —
// PLAN_ARTIFACT_NOTICE, prompts/common.md, prompts/plan_checker.md,
// prompts/plan_critic.md, prompts/plan_judge.md and docs/pipeline.md now
// describe the artifact as the receipt's recorded EVIDENCE and state the
// severance outright.
//
// THE ONE WIRE MOVEMENT, measured. Rewriting PLAN_ARTIFACT_NOTICE changed its
// length: 1,162 characters per copy before, 1,437 after, +275 per copy and
// +1,100 across the four copies — 2.29% of RESPONSE_BUDGET_CHARS. FOUR is the
// count because compactPendingTicket (projection.js) rewrites only the
// `Run objective:` suffix, so the stage prefix carrying the notice survives on
// BOTH pending run.tickets[] entries, and projectAction leaves BOTH
// dispatch_agent action tickets of the one plan-review parallel group whole.

// THE OMISSION MARKER (roadmap entry
// plan-artifact-truncation-not-disclosed-to-readers). The list cap used to drop
// keys with a bare loop `break` and no trace at all, so a planner that recorded
// more keys than fit handed the checker and critic an artifact every prose
// surface TOLD them was whole. The runtime now spends the LAST of the existing
// slots on this marker rather than adding a thirteenth entry: `entries.length <=
// PLAN_ARTIFACT_MAX_ENTRIES` stays a hard invariant and the four-copies-per-
// response arithmetic recorded above does not move.
//
// UNFORGEABLE BY CONSTRUCTION, not by convention — the marker's shape is a
// runtime GUARANTEE a planner cannot reproduce. renderPlanArtifactEntry always
// emits `${key}: ${rendered}` through boundedGateSummary, which only flattens
// whitespace, trims, and slices the TAIL, so the ':' at index key.length
// survives every path: every planner-derived entry either contains ': ', or ends
// ':' (an empty value, trimmed), or is exactly PLAN_ARTIFACT_MAX_CHARS long and
// ends U+2026 (the cut landed inside an oversized key, before the separator).
// This marker is COLON-FREE, shorter than the cap and never ends U+2026, so no
// key any planner can author — in any Unicode — is BYTE-EQUAL to it. The
// CONJUNCTION is what carries that: colon-freeness ALONE does not, because the
// third path above is itself colon-free. And byte-inequality is not the property
// a reader acts on, so the reservation below enforces the PUBLISHED rule
// directly. Position alone would not do either: at or under the cap a PLANNER
// entry occupies the last slot.
//
// Runtime-authored and FIXED except for one decimal, so it is neither an
// injection surface (C4) nor a source of nondeterminism (C5) — it never
// interpolates a dropped key's name or value, and the same recorded evidence
// always yields the same marker bytes.
export const PLAN_ARTIFACT_MARKER_BRAND = '[APE runtime]';

const PLAN_ARTIFACT_MARKER_PREFIX = `${PLAN_ARTIFACT_MARKER_BRAND} plan_artifact truncated — `;

const PLAN_ARTIFACT_MARKER_SUFFIX =
  ' further recorded evidence keys had no slot here and were dropped whole, not merely cut. Treat them as unseen, not as unmade decisions.';

// ONE definition of the marker text, assembled from the reserved brand the
// collision guard below keys on, so the emitted marker and the rule published to
// readers can never drift. The literal is 176 characters at a single-digit
// count, and staying well inside PLAN_ARTIFACT_MAX_CHARS is load-bearing rather
// than tidy: a marker AT the cap ending U+2026 would wear the one planner-entry
// shape that need carry no colon.
function planArtifactOmissionMarker(dropped) {
  return `${PLAN_ARTIFACT_MARKER_PREFIX}${dropped}${PLAN_ARTIFACT_MARKER_SUFFIX}`;
}

// THE BRAND IS RESERVED, and that — not byte-inequality — is the guarantee the
// readers are actually given. Every reader surface publishes one rule for telling
// the runtime's own entry apart: "the colon-free entry opening `[APE runtime]`".
// A two-sided prefix+suffix test does NOT enforce that rule, because the per-entry
// cap eats suffixes: a recorded key that overruns PLAN_ARTIFACT_MAX_CHARS on its
// own renders through the third path above to an entry that is exactly the cap,
// ends U+2026, carries no colon (the cut landed before the `: ` separator) and may
// open with the brand. Such an entry is never byte-equal to the marker, yet it
// satisfies the published rule VERBATIM — and it needs no marker to have fired, so
// it lands in an artifact where every slot is planner-derived. The direction of
// that error is LENIENCY: a reader who takes a planner line for the runtime saying
// "N keys were dropped" believes material sits past a cut that never happened.
//
// So the chokepoint neutralizes on the BRAND ALONE. No planner-derived entry may
// OPEN with `[APE runtime]`, which makes the rule the runtime publishes exactly
// the rule the runtime enforces (S1) — the same standard
// __tests__/runtime-v2-roadmap-response-bound.test.js:65-74 sets one channel over.
// The neutralization is a PREFIX because the cap eats suffixes, and a neutralized
// entry can never match again — it no longer opens with the brand. S2 records the
// carve-out this creates: such an entry is a deliberate act by the planner and is
// marked visibly instead of passed through.
const PLAN_ARTIFACT_COLLISION_PREFIX = '[planner-authored, not the runtime marker] ';

function isPlanArtifactMarkerShaped(entry) {
  return typeof entry === 'string' && entry.startsWith(PLAN_ARTIFACT_MARKER_BRAND);
}

// At most one entry per recorded evidence key — fewer once the marker above
// claims a slot: a string value is used raw (it is already the planner's prose),
// any other value is JSON-serialized so structure survives. boundedGateSummary
// flattens and caps the WHOLE entry — the key is agent-authored text too, so a
// crafted key can never escape the bound.
function renderPlanArtifactEntry(key, value) {
  let rendered;
  if (typeof value === 'string') {
    rendered = value;
  } else {
    try {
      rendered = JSON.stringify(value);
    } catch {
      rendered = null;
    }
    if (typeof rendered !== 'string') rendered = String(value);
  }
  const entry = boundedGateSummary(`${key}: ${rendered}`, PLAN_ARTIFACT_MAX_CHARS);
  // THE SINGLE CHOKEPOINT (S1): every planner-derived entry of the artifact is
  // produced right here, so the guarantee that none of them wears the runtime's
  // reserved shape is enforced right here too.
  return isPlanArtifactMarkerShaped(entry)
    ? boundedGateSummary(`${PLAN_ARTIFACT_COLLISION_PREFIX}${entry}`, PLAN_ARTIFACT_MAX_CHARS)
    : entry;
}

// FAIL-OPEN by construction: every miss — a non-plan-review stage, no planner
// stage at all (the mechanical, fast, land, debug and spike paths), no PASSED
// planner receipt, or evidence that renders to zero entries — returns undefined,
// so issueTicket omits the field ENTIRELY (never [] or null) and those tickets
// stay byte-identical and hash-stable.
function planArtifact(state, stage) {
  // The array-shaped artifact is the legacy compatibility path only. Every
  // structured contract run forwards the validated candidate below instead;
  // never publish two competing plan authorities on one review ticket.
  if ([PLAN_CONTRACT_VERSION, CURRENT_PLAN_CONTRACT_VERSION].includes(state.plan_contract_version)) {
    return undefined;
  }
  if (!PLAN_ARTIFACT_STAGES.has(stage.id)) return undefined;
  const planTicketIds = new Set(
    (state.tickets ?? [])
      .filter((ticket) => ['plan', 'plan-replan'].includes(ticket.stage_id))
      .map((ticket) => ticket.ticket_id),
  );
  if (planTicketIds.size === 0) return undefined;
  // The newest PASSED planner receipt of THIS run only (state.receipts is this
  // run's own chain): the evidence of a superseded failed attempt is not the
  // evidence the run went on to review, so it must never be forwarded.
  const source = [...(state.receipts ?? [])]
    .reverse()
    .find((receipt) => receipt.status === 'passed' && planTicketIds.has(receipt.ticket_id));
  const evidence = source?.evidence;
  if (!evidence || typeof evidence !== 'object' || Array.isArray(evidence)) return undefined;
  const recorded = Object.entries(evidence);
  // Count the recorded keys FIRST, then reserve the last slot when any of them
  // will not fit. Today's early `break` is kept, so a pathological receipt still
  // never flattens every value.
  const dropsKeys = recorded.length > PLAN_ARTIFACT_MAX_ENTRIES;
  const plannerSlots = dropsKeys ? PLAN_ARTIFACT_MAX_ENTRIES - 1 : PLAN_ARTIFACT_MAX_ENTRIES;
  const entries = [];
  for (const [key, value] of recorded) {
    if (entries.length >= plannerSlots) break;
    const entry = renderPlanArtifactEntry(key, value);
    if (entry !== null) entries.push(entry);
  }
  // COUNTED, never inferred from the cap: recorded keys minus the entries
  // actually emitted. At the cap + 1 boundary that is TWO keys gone, not one,
  // because reserving the slot costs a planner entry as well.
  if (dropsKeys) entries.push(planArtifactOmissionMarker(recorded.length - entries.length));
  return entries.length > 0 ? entries : undefined;
}

function structuredCandidatePlan(paths, state, stage) {
  if (![PLAN_CONTRACT_VERSION, CURRENT_PLAN_CONTRACT_VERSION].includes(state.plan_contract_version)) {
    return undefined;
  }
  if (!PLAN_ARTIFACT_STAGES.has(stage.id)) return undefined;
  const planTicketIds = new Set(
    (state.tickets ?? [])
      .filter((ticket) => ['plan', 'plan-replan'].includes(ticket.stage_id))
      .map((ticket) => ticket.ticket_id),
  );
  const source = [...(state.receipts ?? [])]
    .reverse()
    .find((receipt) => receipt.status === 'passed' && planTicketIds.has(receipt.ticket_id));
  const parsed = candidatePlanForScope(
    source?.evidence?.candidate_plan,
    [...(state.claimed_paths ?? []), ...(state.test_paths ?? [])],
    paths.root,
    state.plan_contract_version === CURRENT_PLAN_CONTRACT_VERSION
      ? {
          preflight_hash: state.preflight?.artifact_hash,
          verification_profiles: (state.preflight?.artifact?.verification_profiles ?? [])
            .map((profile) => ({ id: profile.id, required: profile.disposition === 'required' })),
        }
      : null,
  );
  // Admission guarantees this branch for a structured planner receipt. If persisted
  // state was hand-edited or partially upgraded, fail closed instead of
  // manufacturing a reviewer ticket over a different or unvalidated plan.
  if (!parsed.valid) {
    throw new Error(`validated candidate plan is unavailable: ${parsed.errors.join('; ')}`);
  }
  return parsed.value;
}

// The per-finding cut (REVIEW_FINDING_LIMIT, scheduler.js) is deliberately
// stated only by that closing mechanism clause above, never as a third
// interpolated digit beside the two already there: REVIEW_FINDINGS_MAX and
// REVIEW_FINDINGS_BLOCK_LIMIT are each exactly what boundReviewFindingsBlock's
// own drop-disclosure entry states verbatim as a bare number when it fires,
// but no rendered finding ever echoes REVIEW_FINDING_LIMIT that way —
// boundReviewFinding's own per-finding cut states only how many characters
// THAT finding lost, a number that varies per finding. Interpolating the
// shared ceiling here would add a digit no rendered finding corroborates; the
// mechanism sentence already satisfies this notice's own disclosure
// obligation without one.

// Disclosure for the scope_expansion forwarding channel. This closes the
// specific gap that an accepted claim-set growth reached the next writable
// ticket with no ticket-facing notice at all; it does not by itself satisfy
// the forwarded-evidence-and-judge-visibility roadmap entry, which spans
// every forwarding channel. extractScopeExpansion (below) validates a blocking
// reviewer's proposed claim-set growth strictly, but the ACCEPTED proposal
// admits an unbounded path count and unbounded per-path length; it then
// flows through the SCOPE_EXPANDED reducer arm (scheduler.js) into
// ticketClaims (above). The disclosure below is STATE-DERIVED, the pattern
// reviewFindings already uses for the identical class of receipt-derived,
// agent-authored evidence: scheduler.js's SCOPE_EXPANDED arm records the
// accepted growth onto state.pending_scope_expansions, keyed by the
// proposing review ticket's own ticket_id, and the review-disagreed reducer
// arm reads it back from EVERY member of the completed review group
// (groupScopeExpansion) rather than only the receipt that happens to
// complete it — so a multi-member group discloses the growth regardless of
// arrival order, a routing to remediation-test carries it forward onto the
// remediation-build that follows (inheritedScopeExpansion below, mirroring
// inheritedReviewFindings), and a retry of either ticket inherits it from
// the one it replaces (scheduler.js's two retry arms forward
// ticket.scope_expansion exactly as they already forward
// ticket.review_findings). Each added path is individually bounded, the
// list itself bounded by count with the LAST of those slots spent on the
// runtime's own omission marker when the cap bites — loud on overflow,
// never a silent drop, the same standard D3's own malformed-proposal arms
// already hold the admission side to.
export const SCOPE_EXPANSION_PATHS_MAX = 20;

// Mirrors EXPIRED_PREDECESSOR_PATH_MAX_CHARS/testRemediationNotice's own
// 200-char cut for this identical class of reviewer- or receipt-derived text.
export const SCOPE_EXPANSION_PATH_MAX_CHARS = 200;

export const SCOPE_EXPANSION_REASON_MAX_CHARS = 200;

// The ceiling for the JOINED reason block a multi-member review group
// produces. Derived from the two bounds that actually govern it rather than
// hand-picked, so it cannot drift when either moves: every joined entry is
// already cut to the per-reason ceiling and the count is capped, plus a small
// per-entry allowance for the ' | ' separator and the runtime's own omission
// note when the count cap bites.
const SCOPE_EXPANSION_REASON_BLOCK_MAX_CHARS =
  SCOPE_EXPANSION_REASONS_MAX * (SCOPE_EXPANSION_REASON_MAX_CHARS + 8);

// Mirrors expiredPredecessorOmittedPathsNote's wording for the identical
// omission shape: a path-count cap spending its last slot on a runtime-
// authored disclosure rather than a silent truncation.
function scopeExpansionOmittedPathsNote(dropped) {
  return `and ${dropped} more path(s) not listed here`;
}

// The bounded form of an accepted scope-expansion proposal — computed ONCE
// and used for BOTH the ticket-facing notice below and the value persisted
// onto the ticket itself (scope_expansion, StageTicketSchema), so the one
// `.ape` read a bound subagent is sanctioned to make (its own ticket file)
// can never disclose more than the rendered notice already did, and a retry
// or an inheriting remediation-build forwards the identical already-bounded
// text rather than re-deriving it from a wider source. Returns null when
// nothing expanded, so a ticket untouched by this channel stores and renders
// nothing.
function boundedScopeExpansion(expansion) {
  const addedPaths = expansion?.claimed_paths ?? [];
  if (addedPaths.length === 0) return null;
  const dropsPaths = addedPaths.length > SCOPE_EXPANSION_PATHS_MAX;
  const pathSlots = dropsPaths ? SCOPE_EXPANSION_PATHS_MAX - 1 : SCOPE_EXPANSION_PATHS_MAX;
  const boundedPaths = addedPaths
    .slice(0, pathSlots)
    .map((entry) => boundedGateSummary(entry, SCOPE_EXPANSION_PATH_MAX_CHARS))
    .filter((entry) => entry !== null);
  if (dropsPaths) boundedPaths.push(scopeExpansionOmittedPathsNote(addedPaths.length - pathSlots));
  return {
    claimed_paths: boundedPaths,
    // The value arriving here is groupScopeExpansion's join of reasons that
    // were EACH already cut to SCOPE_EXPANSION_REASON_MAX_CHARS at their
    // recording site, capped at SCOPE_EXPANSION_REASONS_MAX entries. Cutting
    // that join at the PER-REASON ceiling would let the first member's reason
    // consume the whole budget and delete a co-reviewer's justification whole,
    // so the ceiling applied here is the whole-block one derived from those
    // same two constants: every reason that survived the count cap survives
    // this cut too, and the bound stays real rather than nominal.
    reason:
      boundedGateSummary(expansion.reason, SCOPE_EXPANSION_REASON_BLOCK_MAX_CHARS) ??
      '(no reason recorded)',
  };
}

function stageFromTicket(ticket) {
  return {
    id: ticket.stage_id,
    role: ticket.role,
    model_tier: ticket.model_tier,
    writable: ticket.writable,
    parallel_group: ticket.parallel_group,
    required_checks: ticket.required_checks,
    output_schema: ticket.output_schema,
  };
}

function durableSuccessorMaterial(ticket) {
  const {
    ticket_id: _ticketId,
    deadline_at: _deadlineAt,
    issued_at: _issuedAt,
    ticket_hash: _ticketHash,
    ...material
  } = ticket;
  return material;
}

async function recoverDurableSuccessorTicket(paths, state, expectedTicket) {
  let entries;
  try {
    entries = await readdir(paths.tickets);
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
  const activeIds = new Set((state.tickets ?? []).map((ticket) => ticket.ticket_id));
  const candidates = [];
  for (const entry of entries) {
    if (!entry.endsWith('.json')) continue;
    const candidate = await readJson(path.join(paths.tickets, entry), null);
    if (
      !candidate ||
      candidate.run_id !== state.run_id ||
      candidate.objective !== state.objective ||
      activeIds.has(candidate.ticket_id) ||
      candidate.ticket_hash !== hashRecord(candidate, ['ticket_hash'])
    ) continue;
    const artifactHash = state.preflight?.artifact_hash;
    if (artifactHash && candidate.preflight?.artifact_hash !== artifactHash) continue;
    candidates.push(candidate);
  }
  candidates.sort((left, right) => Date.parse(right.issued_at) - Date.parse(left.issued_at));
  if (candidates.length === 0) return null;
  const expectedHash = hashRecord(durableSuccessorMaterial(expectedTicket));
  const matching = candidates.find(
    (candidate) => hashRecord(durableSuccessorMaterial(candidate)) === expectedHash,
  );
  if (matching) return matching;
  throw new Error(
    'answer-preflight conflicts with a durable successor from an earlier acceptance attempt',
  );
}

async function issueTicket(paths, state, stage, config, tree, retryOf = null, evidence = {}) {
  const issuedAt = now();
  // Receipt-derived failure evidence the scheduler threads onto a reissued or
  // remediation ticket (scheduler.js retry / expiry / review-disagreed arms).
  const priorAttempts = evidence.prior_attempts;
  const reviewFindings = evidence.review_findings
    ?? inheritedReviewFindings(state, stage)
    ?? state.carry_forward?.review_findings;
  const reviewFindingEvidence = evidence.review_finding_evidence
    ?? inheritedReviewFindingEvidence(state, stage);
  const planRecovery = evidence.plan_recovery;
  const testReconciliation = evidence.test_reconciliation;
  // ONE predicate for BOTH the review_findings field spread below and the
  // REVIEW_FINDINGS_NOTICE prepend: the framing is published exactly when the
  // prose it frames is attached, and neither can drift from the other. Keyed on
  // the RESOLVED value, so the scheduler's attachment, the remediation-build
  // inheritance and the retry forwarding are all covered by construction.
  const carriesReviewFindings = Array.isArray(reviewFindings) && reviewFindings.length > 0;
  // Receipt-derived planner EVIDENCE — that receipt's `evidence` object only,
  // never its `findings` — on the plan-review/plan-judge stages only.
  const forwardedPlanEvidence = planArtifact(state, stage);
  const forwardedCandidatePlan = structuredCandidatePlan(paths, state, stage);
  const forwardedApprovedPlan = state.approved_plan;
  const forwardedPreflight = stage.role !== 'preflight_analyst' && state.preflight?.artifact
    ? {
        artifact_hash: state.preflight.artifact_hash,
        artifact: state.preflight.artifact,
        trust: 'untrusted-evidence',
        ...(Array.isArray(state.preflight.answers)
          ? {
              operator_evidence: {
                trust: 'untrusted-evidence',
                answers: state.preflight.answers,
              },
            }
          : {}),
      }
    : null;
  const narrowedTestPaths = narrowedTestClaims(state, stage);
  const deadlineMs = config.deadlines_ms?.[state.lane] ?? 45 * 60_000;
  const resolvedScopeExpansion = evidence.scope_expansion ?? inheritedScopeExpansion(state, stage);
  const forwardsPlanningContractContext = state.plan_contract_version === 2 && [
    'preflight_analyst',
    'planner',
    'plan_checker',
    'plan_critic',
    'plan_judge',
  ].includes(stage.role);
  const boundedScope = resolvedScopeExpansion ? boundedScopeExpansion(resolvedScopeExpansion) : null;
  const expiredPredecessor =
    stage.writable === true ? expiredPredecessorByRetryOf(state, retryOf) : null;
  const expiredPredecessorRecord = expiredPredecessor
    ? structuredExpiredPredecessor(expiredPredecessor)
    : null;
  const expectedTicket = finalizeTicket({
    schema_version: SCHEMA_VERSION,
    ticket_id: `${state.run_id}:${stage.id}:${randomUUID()}`,
    run_id: state.run_id,
    stage_id: stage.id,
    parallel_group: stage.parallel_group,
    role: stage.role,
    // Objective is immutable run intent, not a transport for role instructions
    // or forwarding explanations. Stage/role/check/structured evidence fields
    // and the role prompts carry those contracts.
    objective: state.objective,
    ...(state.plan_contract_version
      ? { plan_contract_version: state.plan_contract_version }
      : {}),
    ...(forwardsPlanningContractContext
      ? { verification_profiles: structuredClone(state.verification_profiles ?? []) }
      : {}),
    ...(forwardsPlanningContractContext
      ? { risk_triggers: [...(state.risk_triggers ?? [])] }
      : {}),
    claimed_paths: narrowedTestPaths ? [...narrowedTestPaths] : ticketClaims(state, stage),
    ...(Array.isArray(state.tool_claims) && state.tool_claims.length
      ? { tool_claims: [...state.tool_claims] }
      : {}),
    test_paths: narrowedTestPaths ? [...narrowedTestPaths] : [...state.test_paths],
    model_tier: stage.model_tier,
    model: resolveModel(config, state.host, stage.model_tier, stage.role),
    deadline_at: new Date(Date.parse(issuedAt) + deadlineMs).toISOString(),
    output_schema: stage.output_schema,
    ...(stage.review_contract_version === REVIEW_CONTRACT_VERSION
      ? { review_contract_version: REVIEW_CONTRACT_VERSION }
      : {}),
    ...((stage.id === 'remediation-test' && state.remediation_route) || stage.id === 'test-recheck'
      ? { test_scope: 'exact' }
      : {}),
    required_checks: stage.id === 'remediation-test'
      ? (state.remediation_route?.route === 'test' ? ['targeted-tests'] : [])
      : ticketChecks(stage),
    parent_hash: state.receipts.at(-1)?.receipt_hash ?? null,
    // Session-memoized: tickets issued in one batch (plan-check + plan-critic)
    // and tickets issued right after a validated receipt share the section's
    // already-observed tree — nothing but .ape writes happens in between.
    // DELIBERATELY left as the live tree rather than rebased out from under an
    // expired predecessor's own orphaned writes (roadmap entry
    // expire-dispatch-orphan-blocks-red-admission): a synthetic base excluding
    // just that predecessor's claim would have to be intersected against THIS
    // ticket's own resolved claims to stay safe, and the wider defect (an
    // orphan the retry only verifies is never in receipt.changed_files, so it
    // also never joins the clean_tree gate's allowed-dirty set or the shipping
    // commit — gates.js) is not fixed by narrowing base_tree_sha alone. The
    // notice above (expiredPredecessorNotice) and the admission-refusal fix in
    // observeRedTest/observeRedTestPerRunner instead make the inherited base
    // KNOWN to the retry agent and correctly DIAGNOSED at admission, so the
    // retry is never wedged on a refusal that misnames the cause.
    base_tree_sha: await tree.current(),
    attempt: retryOf ? (state.attempts[stage.id] ?? 2) : 1,
    writable: stage.writable,
    issued_at: issuedAt,
    // Spread ONLY when a non-empty array so a first-issue ticket omits both
    // keys and stays byte-identical and hash-stable (the schema fields are
    // optional with no default for exactly this reason).
    ...(Array.isArray(priorAttempts) && priorAttempts.length ? { prior_attempts: priorAttempts } : {}),
    ...(carriesReviewFindings ? { review_findings: reviewFindings } : {}),
    ...(Array.isArray(reviewFindingEvidence) && reviewFindingEvidence.length
      ? { review_finding_evidence: reviewFindingEvidence }
      : {}),
    // Same discipline for the forwarded planner evidence: planArtifact returns
    // undefined (never an empty array) on every miss, so every ticket outside
    // the plan-review/plan-judge stages — and every plan-review ticket with
    // nothing to forward — omits the key entirely and stays hash-stable.
    ...(forwardedPlanEvidence ? { plan_artifact: forwardedPlanEvidence } : {}),
    ...(forwardedCandidatePlan ? { candidate_plan: forwardedCandidatePlan } : {}),
    // Once sealed by the reducer, the approved plan is copied verbatim onto
    // every later ticket. Automatic derivation here covers ordinary successors,
    // retries, remediation writers, and remediation reviewers uniformly.
    ...(forwardedApprovedPlan ? { approved_plan: forwardedApprovedPlan } : {}),
    ...(forwardedPreflight ? { preflight: forwardedPreflight } : {}),
    // Same discipline again for an accepted scope-expansion proposal:
    // boundedScope is null on every ticket this channel never touches, so a
    // ticket outside the two writable remediation stages stays hash-stable,
    // and a retry or an inheriting remediation-build forwards this exact
    // already-bounded value rather than a wider, re-derived one.
    ...(boundedScope ? { scope_expansion: boundedScope } : {}),
    ...(planRecovery ? { plan_recovery: planRecovery } : {}),
    ...(testReconciliation ? { test_reconciliation: testReconciliation } : {}),
    ...(expiredPredecessorRecord ? { expired_predecessor: expiredPredecessorRecord } : {}),
  });
  const recoveredTicket = await recoverDurableSuccessorTicket(
    paths,
    state,
    expectedTicket,
  );
  const ticket = recoveredTicket ?? expectedTicket;
  await atomicWriteJson(path.join(paths.tickets, `${ticket.ticket_id.replaceAll(':', '_')}.json`), ticket);
  state.tickets.push(ticket);
  state.stage = stage.id;
  return ticket;
}

export function statusDocPath(paths) {
  return path.join(paths.runtime, 'status.md');
}

export async function persist(paths, state, tree, { refreshTree = true } = {}) {
  state.updated_at = now();
  if (refreshTree) state.tree_sha = await tree.current();
  await atomicWriteJson(path.join(paths.runs, `${state.run_id}.json`), state);
  await atomicWriteJson(paths.active, state);
  // Best-effort human-readable projection; never break persist or atomicity.
  // status.md is the only state artifact that is plain text; it gets the same
  // temp-file-then-atomic-replace discipline as the JSON state so a crash
  // mid-write never leaves a truncated projection (F44) and a held-open
  // target on win32 never observes a deleted one (D1).
  try {
    // RM5: project the derived roadmap into status.md under the same
    // best-effort discipline. deriveRoadmap returns null when no roadmap.json
    // exists (RM7), so a roadmap-less run renders a byte-identical document.
    const roadmap = await deriveRoadmap(paths);
    await atomicReplaceText(statusDocPath(paths), renderStatusDoc(state, { roadmap }));
  } catch {
    // swallow: status.md is advisory only
  }
}

function apeOwnedBranch(branch) {
  return typeof branch === 'string' && branch.startsWith('ape/');
}

async function localBranchExists(projectDir, branch) {
  return runGit(projectDir, ['show-ref', '--verify', '--quiet', `refs/heads/${branch}`])
    .then(() => true, () => false);
}

async function terminalCheckoutBase(paths, state) {
  if (typeof state.base_branch === 'string' && state.base_branch.trim() !== '') {
    return state.base_branch;
  }
  return (await resolveBaseBranch(paths.root)).branch;
}

async function terminalDirtyPaths(paths) {
  return (await workingTreeStatus(paths.root))
    .map((line) => line.slice(3))
    .filter((file) => !file.startsWith('.ape/'));
}

// Terminal checkout reconciliation is deliberately separate from the immutable
// archive: history binds the run tree first, then this helper moves the clean
// checkout back to the run's persisted default base. A dirty or externally
// moved checkout is never stashed, reset, or carried across branches.
export async function reconcileTerminalCheckout(paths, state) {
  const at = now();
  const runBranch = state.branch;
  let baseBranch;
  try {
    baseBranch = await terminalCheckoutBase(paths, state);
    const dirtyPaths = await terminalDirtyPaths(paths);
    if (dirtyPaths.length > 0) {
      return {
        status: 'retained_dirty',
        base_branch: baseBranch,
        run_branch: runBranch,
        retained: true,
        deleted: false,
        dirty_paths: dirtyPaths,
        reason: 'tracked working-tree changes prevent a safe return to the default branch; clean or commit them on the run branch, then call ape_run resume',
        updated_at: at,
      };
    }

    const current = await currentBranch(paths.root);
    if (!current) throw new Error('HEAD is detached; checkout cleanup will not move it');
    if (current !== baseBranch && current !== runBranch) {
      throw new Error(`checkout moved to unrelated branch ${current}; expected ${runBranch} or ${baseBranch}`);
    }
    if (current !== baseBranch) {
      if (await localBranchExists(paths.root, baseBranch)) {
        await runGit(paths.root, ['switch', baseBranch]);
      } else {
        await runGit(paths.root, ['switch', '-c', baseBranch, state.base_commit_sha, '--no-track']);
      }
    }

    let deleted = false;
    if (state.status === 'completed' && apeOwnedBranch(runBranch)) {
      if (await localBranchExists(paths.root, runBranch)) {
        await runGit(paths.root, ['branch', '-D', runBranch]);
      }
      deleted = true;
    }
    return {
      status: 'returned',
      base_branch: baseBranch,
      run_branch: runBranch,
      retained: !deleted,
      deleted,
      updated_at: at,
    };
  } catch (error) {
    return {
      status: 'retained_error',
      ...(baseBranch ? { base_branch: baseBranch } : {}),
      run_branch: runBranch,
      retained: true,
      deleted: false,
      reason: boundedGateSummary(error?.message ?? String(error)),
      updated_at: at,
    };
  }
}

async function activateRunCheckout(paths, state) {
  // Legacy blocked states predate isolated branch lifecycle metadata and may
  // intentionally name a synthetic/nonexistent branch in imported fixtures.
  // Preserve their existing in-place recovery semantics.
  if (typeof state.base_branch !== 'string' || state.base_branch.trim() === '') return;
  if (!apeOwnedBranch(state.branch)) {
    throw new Error(`run branch ${state.branch ?? '(missing)'} is not APE-owned; refusing recovery checkout`);
  }
  const current = await currentBranch(paths.root);
  // Dirt already on the run branch is the work gates/ship must re-evaluate;
  // only cross-branch dirt is unsafe to carry.
  if (current === state.branch) return;
  const dirtyPaths = await terminalDirtyPaths(paths);
  if (dirtyPaths.length > 0) {
    throw new Error(`cannot reactivate run branch with tracked working-tree changes: ${dirtyPaths.join(', ')}`);
  }
  const baseBranch = await terminalCheckoutBase(paths, state);
  if (current !== baseBranch) {
    throw new Error(`cannot reactivate run branch from unrelated branch ${current || '(detached HEAD)'}; switch to ${baseBranch} and retry`);
  }
  if (!(await localBranchExists(paths.root, state.branch))) {
    throw new Error(`retained run branch ${state.branch} no longer exists`);
  }
  await runGit(paths.root, ['switch', state.branch]);
}

async function maintainArchivedArtifacts(paths) {
  try {
    const result = await compactArchivedArtifacts(paths);
    await recordArtifactRetentionStatus(paths, { trigger: 'automatic', result });
  } catch (error) {
    await recordArtifactRetentionStatus(paths, { trigger: 'automatic', error });
    // Retention is recoverable maintenance. The immutable history archive has
    // already succeeded and must never be turned into a failed run transition
    // by a compression, audit-log, cleanup, or status-projection fault.
  }
}

async function dispatchForTicket(paths, state, ticket, dispatchGroupSize = 1) {
  const context = {
    run_objective: state.objective,
    dispatch_group_size: dispatchGroupSize,
  };
  const basic = nativeDispatch(state.host, ticket, null, context);
  const intent = state.host === 'codex'
    ? await prepareCodexIntent(paths, ticket, basic.agent_type)
    : await prepareClaudeIntent(paths, ticket, basic.agent_type);
  return nativeDispatch(state.host, ticket, intent, context);
}

// `tree` is a treeShaSession scoped to the caller's critical section; callers
// that hold one (startRun, recordReceiptLocked) thread it so the whole action
// chain shares one observed tree, and the default covers the levers whose
// chains start with no prior read (next/abort/regate/ship/override) — their
// first current() is then the section's real read. Recursions MUST pass the
// session on: a fresh default session inside a recursion would resurrect a
// memo the outer chain just invalidated.
export async function applyActions(paths, state, actions, config, tree = treeShaSession(paths.root)) {
  const emitted = [];
  const dispatchGroupSize = actions.filter(
    (action) => action.type === 'issue_ticket' || action.type === 'dispatch_agent',
  ).length;
  let deferredTerminalRelease = null;
  for (const action of actions) {
    switch (action.type) {
      case 'acquire_lock':
        await acquireRunLock(paths.lock, state.run_id, {
          recoverStale: true,
          onRecover: (detail) => appendJsonLine(paths.overrideLog, lockRecoveryAuditLine(state.run_id, detail)),
        });
        emitted.push(action);
        break;
      case 'release_lock':
        if (TERMINAL_STATUSES.has(state.status)) {
          deferredTerminalRelease = action;
        } else {
          await releaseRunLock(paths.lock, state.run_id);
          emitted.push(action);
        }
        break;
      case 'transition':
        Object.assign(state, action.patch);
        state.updated_at = now();
        // Stamp the terminal moment exactly once: history derives its stable
        // completed_at from this instead of the volatile updated_at (F40).
        if (TERMINAL_STATUSES.has(state.status) && !state.terminal_at) {
          state.terminal_at = state.updated_at;
        }
        emitted.push(action);
        break;
      case 'activate_run_branch':
        await activateRunCheckout(paths, state);
        emitted.push(action);
        break;
      case 'clear_preflight_input':
        delete state.input_required;
        emitted.push(action);
        break;
      case 'issue_ticket': {
        const ticket = await issueTicket(paths, state, action.stage, config, tree, action.retry_of, {
          prior_attempts: action.prior_attempts,
          review_findings: action.review_findings,
          review_finding_evidence: action.review_finding_evidence,
          scope_expansion: action.scope_expansion,
          plan_recovery: action.plan_recovery,
          test_reconciliation: action.test_reconciliation,
        });
        emitted.push({
          type: 'dispatch_agent',
          dispatch: await dispatchForTicket(paths, state, ticket, dispatchGroupSize),
          ticket,
        });
        break;
      }
      case 'persist_state':
        await persist(paths, state, tree);
        if (deferredTerminalRelease) {
          state.checkout_cleanup = await reconcileTerminalCheckout(paths, state);
          // The first persist and archive bind the terminal run tree. Persist
          // only the cleanup metadata after switching branches so active state
          // never replaces that evidence with the base branch's tree.
          await persist(paths, state, tree, { refreshTree: false });
          emitted.push({ type: 'checkout_cleanup', result: state.checkout_cleanup });
          await releaseRunLock(paths.lock, state.run_id);
          emitted.push(deferredTerminalRelease);
          deferredTerminalRelease = null;
        }
        break;
      case 'archive_history':
        // Terminal archives run BEFORE persist_state, and persist is the only
        // other place state.tree_sha is refreshed from the live tree — without
        // a refresh here the first-write-wins immutable record copies a stale
        // pre-receipt tree into final_tree_sha. The session read IS the
        // terminal-moment tree: every tree-affecting effect in the chain
        // (gates, auto-merge, red-test execution) invalidates the session, so
        // this either reuses a read taken after the last effect or performs
        // the real one — and the persist that follows records the exact tree
        // the immutable record bound, instead of racing a second read.
        // final_tree_sha stays inside record_hash on purpose: the tree IS run
        // content. A crash-retry re-archives the same live tree and stays a
        // no-op; a "retry" whose tree moved is external interference — the
        // blocked/abort/override paths absorb it via if_absent (first write
        // wins) and the completed/merged paths recover idempotently from the
        // receipt transaction before ever re-archiving.
        state.tree_sha = await tree.current();
        {
          const record = await archiveRun(paths, state, {
            ifAbsent: action.if_absent === true,
            // A re-gated run's completion supersedes its immutable block-time
            // record instead of mutating it (F7); archiveRun resolves the block
            // record's hash from disk.
            superseding: action.superseding === true,
          });
          emitted.push({ type: 'history_archived', record });
          await maintainArchivedArtifacts(paths);
        }
        break;
      case 'run_gates': {
        const gatesStartedAt = Date.now();
        // Non-blocking gates (#261 shipping-watch precedent): run the bounded
        // targeted/plugin/tree preflight in-call, then START the full suite in
        // a detached runner only when that preflight is green. A red preflight,
        // suite-cache hit, or in-call tooling failure evaluates + transitions
        // synchronously; otherwise the run rests in 'gating' and each
        // `ape_run next` polls once via poll_gates.
        const start = await startGateSuite(paths.root, paths, state, config, undefined);
        if (start.hit) {
          // Synchronous evaluation (cache hit / tooling failure): identical to
          // today's path — evaluate, accumulate wall clock, recurse.
          const gates = await evaluateGates(paths.root, paths, state, config, {
            ...start.hit.ctx,
            full: start.hit.full,
            cached: start.hit.cached,
          });
          accumulateTiming(state, 'test_ms', Date.now() - gatesStartedAt);
          tree.invalidate();
          state.gates = gates;
          const next = reduceRun(state, gates.passed
            ? { type: 'GATES_PASSED' }
            : { type: 'GATES_FAILED', reason: 'one or more deterministic merge gates failed' });
          emitted.push({ type: 'gates', result: gates });
          emitted.push(...await applyActions(paths, state, next, config, tree));
          break;
        }
        // Detached suite running: rest in the non-terminal, non-sealed 'gating'
        // status with the run lock held. gates_watch is the sanctioned direct
        // assignment (the shipping_watch pattern); the trailing persist_state
        // action of this reducer chain writes it. Spawning the runner is the
        // only wall clock this handler measures.
        accumulateTiming(state, 'test_ms', Date.now() - gatesStartedAt);
        state.status = 'gating';
        state.stage = 'gates';
        state.gates_watch = start.watch;
        tree.invalidate();
        emitted.push({ type: 'gating_started', summary: 'detached merge-gate suite started' });
        // ONE bounded inline grace poll: a fast suite's artifact within the
        // grace window transitions in the same call (zero added latency);
        // gates.inline_grace_ms=0 disables it and every poll is an explicit
        // next. Bounded and best-effort — a slow suite simply rests.
        const graceMs = config.gates?.inline_grace_ms ?? GATE_INLINE_GRACE_MS;
        if (Number.isFinite(graceMs) && graceMs > 0) {
          const graceUntil = Date.now() + graceMs;
          let resolvedInline = false;
          while (Date.now() < graceUntil) {
            await new Promise((resolve) => setTimeout(resolve, Math.min(200, graceMs)));
            // N-b: the in-call evaluation slice starts AFTER the idle grace
            // sleep so only real work (the poll read + the in-call evaluateGates
            // post-suite mutation checks) is measured;
            // the idle sleep is never counted. Mirrors the explicit poll_gates
            // ready arm exactly: test_ms gets this slice PLUS the detached
            // suite's own artifact duration, each counted once.
            const sliceStartedAt = Date.now();
            const poll = await pollGateSuite(paths.root, paths, state, config, undefined);
            if (poll.ready) {
              tree.invalidate();
              const gates = await evaluateGates(paths.root, paths, state, config, {
                ...poll.ready.ctx,
                full: poll.ready.full,
                cached: poll.ready.cached,
              });
              accumulateTiming(state, 'test_ms', (Date.now() - sliceStartedAt) + (poll.ready.artifact_duration_ms ?? 0));
              tree.invalidate();
              state.gates = gates;
              state.gates_watch = null;
              await cleanupGateSuite(start.watch);
              emitted.push({ type: 'gates', result: gates });
              emitted.push(...await applyActions(paths, state, reduceRun(state, gates.passed
                ? { type: 'GATES_PASSED' }
                : { type: 'GATES_FAILED', reason: 'one or more deterministic merge gates failed' }), config, tree));
              resolvedInline = true;
              break;
            }
            if (poll.failed) {
              state.gates_watch = null;
              tree.invalidate();
              await cleanupGateSuite(start.watch);
              emitted.push(...await applyActions(paths, state, reduceRun(state, {
                type: 'GATES_FAILED',
                // prose-bound-exempt: poll.failed is always one of gates.js
                // pollGateSuite's own fixed tree-drift/exhausted-spawn
                // diagnostic templates, or — via the multi/polyglot strategy
                // — launchGateRunner's job-descriptor-write failure text
                // (gates.js:1194-1201, interpolating only its own fs-error
                // code/message) or its runner-command-resolution message
                // (gates.js:1464); all still runtime-derived, never agent- or
                // attacker-controlled text.
                reason: poll.failed,
              }), config, tree));
              resolvedInline = true;
              break;
            }
            if (poll.pending?.watch) {
              state.gates_watch = { ...state.gates_watch, ...poll.pending.watch };
            }
          }
          if (resolvedInline) break;
        }
        break;
      }
      case 'poll_gates': {
        // A run resting in the non-blocking gating watch: ONE bounded poll slice
        // per `ape_run next`. A ready artifact repeats the mutation/tree checks
        // in-call and transitions; pending records the cursor and rests; a
        // tree-drift or dead-runner failure blocks honestly.
        const pollStartedAt = Date.now();
        const poll = await pollGateSuite(paths.root, paths, state, config, undefined);
        if (poll.ready) {
          tree.invalidate();
          const gates = await evaluateGates(paths.root, paths, state, config, {
            ...poll.ready.ctx,
            full: poll.ready.full,
            cached: poll.ready.cached,
          });
          // Runtime-measured gate wall clock (T14): the in-call evaluation slice
          // plus the detached suite's own duration, counted exactly once, BEFORE
          // the recursion so the archives inside it observe it.
          accumulateTiming(state, 'test_ms', (Date.now() - pollStartedAt) + (poll.ready.artifact_duration_ms ?? 0));
          tree.invalidate();
          state.gates = gates;
          const watchFiles = state.gates_watch;
          state.gates_watch = null;
          await cleanupGateSuite(watchFiles);
          emitted.push({ type: 'gates', result: gates });
          emitted.push(...await applyActions(paths, state, reduceRun(state, gates.passed
            ? { type: 'GATES_PASSED' }
            : { type: 'GATES_FAILED', reason: 'one or more deterministic merge gates failed' }), config, tree));
        } else if (poll.failed) {
          const watchFiles = state.gates_watch;
          state.gates_watch = null;
          tree.invalidate();
          await cleanupGateSuite(watchFiles);
          emitted.push(...await applyActions(paths, state, reduceRun(state, {
            type: 'GATES_FAILED',
            // prose-bound-exempt: poll.failed is always one of gates.js
            // pollGateSuite's own fixed tree-drift/exhausted-spawn diagnostic
            // templates, or — via the multi/polyglot strategy —
            // launchGateRunner's job-descriptor-write failure text
            // (gates.js:1194-1201, interpolating only its own fs-error
            // code/message) or its runner-command-resolution message
            // (gates.js:1464); all still runtime-derived, never agent- or
            // attacker-controlled text.
            reason: poll.failed,
          }), config, tree));
        } else {
          // Still pending (or respawned): record the poll cursor, persist (lock
          // held, nothing archived), and return honest in-progress guidance.
          const summary = poll.pending?.summary ?? null;
          state.gates_watch = {
            ...state.gates_watch,
            ...(poll.pending?.watch ?? {}),
            last_poll_at: now(),
            poll_count: (state.gates_watch?.poll_count ?? 0) + 1,
            last_summary: boundedGateSummary(summary),
          };
          await persist(paths, state, tree);
          // N-a: the documented config.gates.poll_retry_delay_ms knob is now
          // honored here (was the bare constant), falling back to the shipped
          // default when unset — so the advisory retry cadence a project
          // configures actually reaches the pending-poll response.
          const retryAfterMs = config.gates?.poll_retry_delay_ms ?? GATE_POLL_RETRY_DELAY_MS;
          emitted.push({
            type: 'gating_pending',
            // prose-bound-exempt: known residual (recorded, not closed, by
            // roadmap sink-guard-coverage-and-detection-completeness) — unlike
            // the sibling shipping_pending arm below, this raw poll.pending.summary
            // is not yet routed through boundedGateSummary before it reaches the
            // wire; state.gates_watch.last_summary two lines above already is.
            summary,
            retry_after_ms: retryAfterMs,
            hint: `the merge-gate suite is still running; call ape_run next again to poll (each poll is one quick check; retry after ~${Math.round(retryAfterMs / 1000)}s)`,
          });
        }
        break;
      }
      case 'auto_merge': {
        // D6-L3 (strictly additive, top of the handler): refuse to auto-merge a
        // green gate whose LOCAL full suite ran impacted while the remote CI full
        // suite no longer exists for this merge (shipping.required_remote_checks
        // is false) and no audited ship re-ran the true full suite — the impacted
        // command must be incapable of standing in as the only full gate
        // (invariant 9). Conditional on full_suite.mode === 'impacted' (encoded
        // in impactedMergeGuard), so a full-suite gate reaches the unchanged
        // arms below exactly as before. On a fire, route the honest gate block.
        if (impactedMergeGuard(state, config)) {
          tree.invalidate();
          emitted.push(...await applyActions(paths, state, reduceRun(state, {
            type: 'GATES_FAILED',
            reason: 'refusing to auto-merge: the local full suite ran impacted but required remote checks are disabled, so the remote CI full suite is not the true full gate (invariant 9); re-gate with remote checks enabled, or ship after an audited full run',
          }), config, tree));
          break;
        }
        // The hold is passed by exactly one authorization: the audited SHIP
        // lever (state.ship_requested), which re-ran the FULL gate suite
        // synchronously in the same reducer chain that reaches this handler, so
        // invariant 9 holds with no bypass or waiver. Absent that flag,
        // shipping.auto_merge !== true holds the run at merge — gates are green
        // but real acceptance is out-of-band — as a RECOVERABLE block: ship (or
        // a leave-held abort/reset) exits it, no longer a terminal dead end.
        if (config.shipping?.auto_merge !== true && state.ship_requested !== true) {
          state.status = 'blocked';
          state.block_reason = AUTO_MERGE_HOLD_REASON;
          if (!state.terminal_at) state.terminal_at = now();
          // Blocked is terminal: archive at the moment of blocking (F7) so the
          // run reaches history without requiring a later abort/reset. Same
          // tree refresh as the archive_history action: the record must bind
          // the live tree — the session was invalidated after the gate run
          // that led here, so this read is real (or shares the post-gates one).
          state.tree_sha = await tree.current();
          {
            const record = await archiveRun(paths, state, { ifAbsent: true });
            emitted.push({ type: 'history_archived', record });
            await maintainArchivedArtifacts(paths);
          }
          await releaseRunLock(paths.lock, state.run_id);
          // prose-bound-exempt: state.block_reason was just set to the fixed
          // AUTO_MERGE_HOLD_REASON constant three lines above in this branch,
          // never agent-authored text.
          emitted.push({ type: 'blocked', reason: state.block_reason });
          break;
        }
        // Runtime-measured shipping wall clock feeds remote_ci_ms (T14/A7): this
        // wrap now measures PHASE 1 only (probe, push, PR create; or the no-CI
        // in-call merge) — the synchronous remote-checks watch is gone. A7:
        // remote_ci_ms is now the SUM of this phase-1 slice and every later
        // poll_shipping slice (accumulate-never-reset unchanged), so the
        // archived terminal record still reflects total runtime-owned ship time.
        // Accumulated on BOTH arms because a ship that throws still consumed
        // remote time, and before each chain so the MERGED/GATES_FAILED archives
        // observe it. The auto-merge-disabled hold arm above accumulates nothing.
        const shipStartedAt = Date.now();
        try {
          const merge = await autoMergeGithub(paths.root, state, config);
          accumulateTiming(state, 'remote_ci_ms', Date.now() - shipStartedAt);
          // A6: discriminate EXACTLY on the presence of the `watch` key. Phase 1
          // handed off a NON-BLOCKING watch (required remote checks): persist it
          // as state.shipping_watch and REST the run in 'shipping' with the run
          // lock still held for the poll phase — no MERGED transition, no
          // archive, no release_lock. The trailing persist_state (this GATES_
          // PASSED chain) writes the watch. The merge-shape and throw arms below
          // are unchanged: the ship/regate mocks return `{url, sha, method}`
          // (no watch), which keeps meaning merged-in-call.
          if (merge.watch) {
            state.shipping_watch = {
              provider: merge.watch.provider,
              pr_url: merge.watch.pr_url,
              branch: merge.watch.branch,
              base: merge.watch.base,
              head_oid: merge.watch.head_oid,
              created_at: merge.watch.created_at,
              last_poll_at: null,
              poll_count: 0,
              last_checks_summary: null,
            };
            emitted.push({ type: 'shipping_started', pr_url: merge.watch.pr_url });
            break;
          }
          // Shipping committed, merged, and switched branches in-call: the tree
          // the session observed pre-merge is gone. The MERGED chain's archive
          // must bind the post-merge tree with a real read.
          tree.invalidate();
          emitted.push(...await applyActions(paths, state, reduceRun(state, { type: 'MERGED', merge }), config, tree));
        } catch (error) {
          accumulateTiming(state, 'remote_ci_ms', Date.now() - shipStartedAt);
          // A failed ship may still have committed or switched branches
          // before throwing — invalidate on this arm too so the blocked
          // archive binds whatever tree the failure actually left.
          tree.invalidate();
          // Roadmap entry agent-facing-text-routes-bypassing-the-prose-bound
          // (security review): UNLIKE poll.failed below, error.message here is
          // NOT already boundedTail'd -- gates.js's phase-1 throws interpolate
          // raw, remote-controlled gh stdout/stderr (pr create/url-parse/squash
          // merge failures, gates.js ~:1897/:1904/:1935), none of which passes
          // through gates.js's own boundedTail (gates.js:1947) before reaching
          // here. So this bind is NOT a cap no-op the way the poll_shipping
          // sibling's is: it both neutralizes C0/C1/DEL/bidi/format bytes AND
          // genuinely truncates an oversized remote tail, six lines from the
          // pending arm this ticket exists to close and reaching the identical
          // durable sink (GATES_FAILED -> state.block_reason -> immutable
          // history -> status.md -> the wire).
          emitted.push(...await applyActions(paths, state, reduceRun(state, {
            type: 'GATES_FAILED',
            reason: `shipping failed: ${boundedGateSummary(error.message)}`,
          }), config, tree));
        }
        break;
      }
      case 'poll_shipping': {
        // A run resting in the non-blocking shipping watch: ONE bounded
        // remote-checks poll slice per `ape_run next`. A7: this slice's
        // wall-clock accumulates into remote_ci_ms on ALL arms BEFORE any
        // recursion, so remote_ci_ms is the SUM of the phase-1 slice and every
        // poll slice (accumulate-never-reset) and the MERGED/GATES_FAILED
        // archives inside the recursion observe it.
        const pollStartedAt = Date.now();
        const poll = await pollRemoteChecksAndMerge(paths.root, state, config);
        accumulateTiming(state, 'remote_ci_ms', Date.now() - pollStartedAt);
        if (poll.merged) {
          // Checks green and merged: clear the watch cursor and let the MERGED
          // transition complete the run, archive, and release the lock. The
          // merge switched branches, so the session's tree is gone.
          state.shipping_watch = null;
          tree.invalidate();
          emitted.push(...await applyActions(paths, state, reduceRun(state, { type: 'MERGED', merge: poll.merged }), config, tree));
        } else if (poll.failed) {
          // A real failed check (or a refused PR state) blocks the run at the
          // gates with the real tail; regate remains the recovery lever.
          // CAP-INVARIANCE HOLDS ONLY FOR SOME of poll.failed's sources
          // (security review correction): pollRemoteChecksAndMerge's own
          // boundedTail-derived returns (gates.js ~:2005, :2054) already
          // passed through boundedTail (policy 4 above: ANSI/CSI+C0/DEL
          // stripped, whitespace-flattened, capped at 400), so calling
          // boundedGateSummary with its DEFAULT 400 cap is a provable no-op
          // on length/whitespace for THOSE returns -- only the residual
          // C1/soft-hyphen/bidi/format neutralization this ticket adds
          // changes anything for them. The OTHER returns interpolate
          // watch.pr_url / pr.url / pr.head_oid parsed straight out of `gh pr
          // view` (parsePrProbe) or persisted from phase 1 (gates.js
          // ~:2040/:2043/:2049) -- never boundedTail'd and not fixed ASCII --
          // so for those the 400 cap is a GENUINE, desirable new bound, not a
          // no-op. Either way this block_reason becomes durable, six lines
          // from the pending arm this ticket exists to close.
          state.shipping_watch = null;
          tree.invalidate();
          emitted.push(...await applyActions(paths, state, reduceRun(state, {
            type: 'GATES_FAILED',
            reason: `shipping failed: ${boundedGateSummary(poll.failed)}`,
          }), config, tree));
        } else {
          // Still pending: record the poll cursor, persist (lock stays held,
          // nothing archived), and return honest in-progress guidance naming the
          // PR and that repeated polls are expected.
          //
          // Roadmap entry agent-facing-text-routes-bypassing-the-prose-bound,
          // route (c). ONE bind at the assignment closes BOTH the persisted
          // last_checks_summary below and the shipping_pending emission a few
          // lines down: both read this same `summary` binding, never the raw
          // poll result. CRITICAL CAP CONSTRAINT (plan-critic C1): poll.
          // pending.summary already passed through gates.js's boundedTail
          // (policy 4 above) or is one of this file's own fixed ASCII
          // strings -- boundedTail's cap is ALSO 400, so calling
          // boundedGateSummary with its DEFAULT max is a provable no-op on
          // length and whitespace for every value gates.js can produce; only
          // the residual C1/soft-hyphen/bidi/format neutralization changes.
          // A SMALLER cap would re-truncate a long-but-valid remote CI tail
          // that is valid input today, which this ticket's admission
          // invariant forbids.
          //
          // NOT REACHED BY THIS BIND, recorded rather than hidden: a
          // pre-existing active.json persisted BEFORE this change still
          // carries an unbounded summary, and scheduler.js's SHIP rest-state
          // refusal renders that persisted field verbatim (pinned at
          // __tests__/runtime-v2-rest-state-ship-self-disclosure.test.js:
          // 251,451) -- a fourth consumer outside this ticket's claim set.
          const summary = boundedGateSummary(poll.pending?.summary ?? null);
          state.shipping_watch = {
            ...state.shipping_watch,
            last_poll_at: now(),
            poll_count: (state.shipping_watch?.poll_count ?? 0) + 1,
            // prose-bound-exempt: summary was already passed through
            // boundedGateSummary two lines above; this is a downstream reuse,
            // not a new sink.
            last_checks_summary: summary,
          };
          await persist(paths, state, tree);
          emitted.push({
            type: 'shipping_pending',
            pr_url: state.shipping_watch.pr_url,
            // prose-bound-exempt: summary was already passed through
            // boundedGateSummary above; this is a downstream reuse, not a new sink.
            summary,
            // prose-bound-exempt: poll.pending.reason is always one of gates.js
            // pollRemoteChecksAndMerge's own fixed enum diagnostic strings
            // ('checks not yet registered'/'checks running'/'pr probe
            // unreadable'), never agent- or attacker-controlled text.
            ...(poll.pending?.reason ? { reason: poll.pending.reason } : {}),
            retry_after_ms: CHECKS_REGISTRATION_RETRY_DELAY_MS,
            hint: `remote checks still in progress for ${state.shipping_watch.pr_url}; call ape_run next again to poll (each poll is one quick check; retry after ~${Math.round(CHECKS_REGISTRATION_RETRY_DELAY_MS / 1000)}s)`,
          });
        }
        break;
      }
      case 'audit_override': {
        // Roadmap entry sink-guard-coverage-and-detection-completeness, ITEM 2:
        // this sink previously wrote the operator/reviewer-authored reason RAW.
        // boundedGateSummary is the same 400-char, control/bidi-neutralizing
        // helper the C5 hardening already applies to echoRunId on this same
        // dispatch path; a no-op on the short, control-character-free ASCII
        // reasons already pinned by service-recovery.test.js and
        // lock-protocol.test.js.
        //
        // review (this run): keep this a DIRECT boundedGateSummary(action.reason)
        // call rather than an intermediate variable — the unbounded-sink guard's
        // own documented gap list names "dataflow through an intermediate
        // variable" as a shape it cannot see, so a future edit of a shared const
        // could silently un-bind both sinks below at once with the guard still
        // green. A direct call at each site stays mechanically guard-visible.
        await appendJsonLine(paths.overrideLog, {
          run_id: state.run_id,
          at: now(),
          operation: action.operation,
          // expire-dispatch names the ticket it voided; scope-expansion names
          // the exact paths it added; abort/reset are run-scoped and keep
          // their historical line shape.
          ...(action.ticket_id ? { ticket_id: action.ticket_id } : {}),
          ...(action.added_paths ? { added_paths: action.added_paths } : {}),
          reason: boundedGateSummary(action.reason),
        });
        // Roadmap entry sink-guard-coverage-and-detection-completeness, ITEM 4:
        // the WIRE echo previously forwarded the reducer's own action object,
        // whose `reason` is the raw operand -- an asymmetry with the bounded
        // copy just persisted above. Checked before binding this: no existing
        // test pins this response's `actions[]` audit_override entry's reason
        // by exact value (every pinned assertion targets the PERSISTED
        // overrides.ndjson line, e.g. runtime-v2-fixer-expire-dispatch.test.js
        // and runtime-v2-ship.test.js), so this closes the asymmetry with no
        // pinned wire behavior to preserve. abort/override reasons are
        // caller-supplied, so echoing them back leaks nothing new; but
        // expire-dispatch/ship reasons can originate from a subagent's receipt
        // and this response is read by the orchestrator, so bind it. A new
        // object, never a mutation of the reducer's frozen action, and the SAME
        // direct boundedGateSummary(action.reason) call as the persisted line
        // above — both sites stay independently guard-visible, and both
        // necessarily agree because they call the same pure function on the
        // same input.
        emitted.push({ ...action, reason: boundedGateSummary(action.reason) });
        break;
      }
      case 'apply_override':
        if (action.operation === 'abort') {
          state.status = 'aborted';
          state.stage = 'aborted';
          if (!state.terminal_at) state.terminal_at = now();
        } else if (action.operation === 'reset') {
          if (!['blocked', 'aborted', 'completed'].includes(state.status)) {
            throw new Error('override reset is allowed only for a terminal or blocked run; for a running run use abort, or expire-dispatch to void a wedged in-flight dispatch');
          }
          // Stale-precondition guard (audit 1.9, invariant 7): startRun is not
          // serialized on the receipt-effects lock this chain holds — it
          // persists a NEW run's active.json under only the run lock — so a
          // reset that validated the PREVIOUS sealed state at the top of this
          // critical section can reach here after a concurrent start already
          // replaced the file. The rm below would then erase the new run's
          // ONLY state while its live lock and branch survive. Re-read
          // immediately before the destructive apply and refuse unless the
          // file still names the exact run this reset validated: an absent
          // file proceeds (every step below is already an idempotent no-op),
          // while a different run_id — or bytes that cannot be read — is not
          // the state this reset validated, so fail closed BEFORE the lock
          // release, leaving the newer run's state and lock untouched. A
          // non-racing reset re-reads its own unchanged state and proceeds
          // byte-identically.
          //
          // The three cases are told apart, because they need different
          // recoveries: readJson's fallback fires ONLY on ENOENT, so `null` is
          // genuinely "absent" and proceeds, while unreadable/corrupt bytes
          // throw and collapse to `undefined` — diagnosing THAT as a concurrent
          // start would name the wrong recovery entirely. The different-run_id
          // message stays byte-identical, and every arm still fails closed
          // before the lock release and both rm calls.
          const current = await readJson(paths.active, null).catch(() => undefined);
          if (current === undefined) {
            throw new Error(`override reset validated sealed run ${state.run_id}, but active.json is now unreadable or corrupt on the pre-deletion re-read; the reset was not applied and the bytes are exactly as they were — inspect the file, then re-issue the reset (a reset over corrupt state quarantines the bytes to a forensic copy and clears the lock) once you have preserved anything you need`);
          }
          if (current !== null && current?.run_id !== state.run_id) {
            throw new Error(`override reset validated sealed run ${state.run_id}, but active.json now names a different run (a concurrent start superseded it); the reset was not applied — re-issue it against the current run if that run should also be cleared`);
          }
          await releaseRunLock(paths.lock, state.run_id).catch(() => {});
          await rm(paths.active, { force: true });
          // status.md is a projection of the active run; a reset that deletes
          // the run must not leave it claiming a blocked/aborted run (F44).
          await rm(statusDocPath(paths), { force: true });
        } else {
          throw new Error('override cannot bypass evidence or merge gates; allowed operations: abort, reset');
        }
        emitted.push(action);
        break;
      case 'dispatch_agent': {
        const ticket = state.tickets.find((entry) => entry.ticket_id === action.ticket_id);
        if (!ticket) break;
        try {
          emitted.push({
            type: 'dispatch_agent',
            dispatch: await dispatchForTicket(paths, state, ticket, dispatchGroupSize),
            ticket,
          });
        } catch (error) {
          // A live launched/bound Claude intent means the subagent is already in
          // flight; next/resume must report that instead of throwing (F17). The
          // operator has two exits (frictions #27/#30) and must be told both: wait out
          // the ticket deadline, or void a dead/unreceipted flight now.
          if (!/is already (launched|bound)$/.test(error?.message ?? '')) throw error;
          emitted.push({
            type: 'dispatch_pending',
            ticket_id: ticket.ticket_id,
            deadline_at: ticket.deadline_at ?? null,
            // prose-bound-exempt: fixed diagnostic template; error.message is
            // matched two lines above against a fixed
            // /is already (launched|bound)$/ pattern, so it is always one of
            // claude-dispatch.js's own fixed messages, and ${ticket.deadline_at}
            // is a runtime-stamped ISO timestamp — never agent-authored text.
            reason: `${error.message}; the flight times out at ${ticket.deadline_at}, or void it now with ape_run action expire-dispatch (this ticket_id plus an audit reason) if the session died or the agent returned no receipt`,
          });
        }
        break;
      }
      case 'status':
      case 'reject':
        emitted.push(action);
        break;
      default:
        emitted.push(action);
    }
  }
  // Defense in depth for a malformed future reducer chain that releases a
  // terminal lock without a trailing persist: never leak the lock, but do not
  // move the checkout without first persisting the terminal tree.
  if (deferredTerminalRelease) {
    await releaseRunLock(paths.lock, state.run_id);
    emitted.push(deferredTerminalRelease);
  }
  return emitted;
}

// Stealing a stale or unreadable run lock is an ownership change, so it is
// audited like an override: one overrides.ndjson line naming the recovering
// run, why the steal was legal, and whose lock was taken.
export function lockRecoveryAuditLine(runId, detail) {
  return {
    run_id: runId,
    at: now(),
    operation: 'lock-recovered',
    // prose-bound-exempt: detail.kind is a fixed enum classification this
    // runtime's own lock-inspection logic assigns (e.g. a dead-pid or
    // unreadable-lock steal reason), never agent- or attacker-controlled text.
    reason: detail.kind,
    stale_run_id: detail.run_id ?? null,
  };
}

async function fileExists(file) {
  try {
    await access(file);
    return true;
  } catch {
    return false;
  }
}

// Roadmap entry expire-dispatch-orphan-blocks-red-admission. Four sites below
// refuse red-test admission on an empty runtime-verifiable authored-test set
// (service.js:1412, 1454, 1480 here and observeRedTestPerRunner's own site),
// and each one's stock advice — configure test_commands.targeted_template /
// targeted / a runner profile.targeted_template — is a DEAD END when the
// emptiness has a different cause: this ticket is a retry whose base_tree_sha
// already carries its expired predecessor's unattributed output (see
// expiredPredecessorTicket above), so receipt.changed_files — the diff from
// THIS ticket's own base — comes out empty no matter how the project is
// configured. CALLS expiredPredecessorTicket rather than restating its
// provenance predicate, so a project that genuinely has no targeted config and
// authored no test at all (no expired predecessor for this stage) keeps its
// exact existing, still-correct advice — the `fallbackMessage` each call site
// supplies unchanged, so this never has to know any one site's own wording.
//
// Roadmap entry expiry-retry-disclosure-fidelity, defect (d). The provenance
// predicate above (an expired predecessor of this stage_id exists) decides
// WHETHER to speak in inherited-base terms at all, and it stays content-blind
// ON PURPOSE — expiredPredecessorTicket's own comment already argues why a
// content predicate would misfire on the common case of a first attempt
// appending to an existing suite file, and this function still has no
// `retryOf` in scope to sharpen that decision (see the note on
// expiredPredecessorTicket). This is a narrower, ADDITIVE question asked only
// AFTER that decision is made: did the predecessor's dispatch window actually
// move the tree at all? Both base_tree_sha values are already on the ticket
// objects, so this costs no extra I/O: predecessor.base_tree_sha is the tree
// BEFORE it ran, and ticket.base_tree_sha (issueTicket, `base_tree_sha: await
// tree.current()`) is the live tree exactly as it left it. Equal means the
// tree never moved across the predecessor's whole dispatch window — it
// authored nothing before dying — so the inherited-base explanation below
// would be FALSE ("carries the unattributed output" of nothing), and the
// still-correct targeted-config advice must not be dropped. This APPENDS that
// advice rather than replacing the inherited-base explanation with it, so the
// primary provenance predicate above is untouched.
function expiredPredecessorLeftNoOutput(predecessor, ticket) {
  return predecessor.base_tree_sha === ticket.base_tree_sha;
}

function emptyAuthoredTestPathsRefusal(state, ticket, fallbackMessage) {
  const predecessor = expiredPredecessorTicket(state, ticket.stage_id);
  if (!predecessor) return fallbackMessage;
  if (expiredPredecessorLeftNoOutput(predecessor, ticket)) {
    return (
      'red-test admission found no runtime-verifiable authored test files: ' +
      `this ticket's expired predecessor ${predecessor.ticket_id} for this stage ` +
      '(expire-dispatch or a dispatch deadline timeout retried this stage without rewinding the tree) left the tree ' +
      'exactly as it found it — it never wrote anything before dying, so there is no unattributed inherited output ' +
      `to blame here. ${fallbackMessage}`
    );
  }
  return (
    'red-test admission found no runtime-verifiable authored test files: ' +
    `this ticket's base_tree_sha already carries the unattributed output of its expired predecessor ${predecessor.ticket_id} ` +
    '(expire-dispatch or a dispatch deadline timeout retried this stage without rewinding the tree), so a receipt that only ' +
    'verifies that inherited content — without writing to it again — reports an empty diff with no authored test path ' +
    'attributed to you. Configuring test_commands would not change this outcome: you must change the content of the ' +
    'authored test paths yourself — a byte-identical rewrite recomputes to the identical tree and the same unchanged, ' +
    'empty diff, and is refused again — so the runtime can observe and execute your own change.'
  );
}

// F12 (red phase): a test-writer receipt on a `red-test` required check is
// admitted only after the runtime itself executes the authored tests and
// observes them fail. Worker receipt.tests[] is empty for this check and can
// never carry the admission. Execution lives here in
// the service layer — inside the receipt-effects critical section — so the
// pure validator stays deterministic and side-effect free.
//
// Scope decision (documented, not silently expanded): the implementer's
// symmetric `targeted-tests` check stays advisory at admission. Shipping is
// already protected by the runtime-executed targeted_tests merge gate against
// the final tree, so admission-time execution there would add cost without a
// shipping guarantee. The red phase has no later gate that could observe it —
// once the build turns the tree green the evidence is gone — so it must be
// observed by the runtime here or never.
async function observeRedTest(paths, state, ticket, receipt, config, tree) {
  // Per-runner routing branch (roadmap: polyglot multi-runner red admission).
  // A non-empty config.runners list routes each authored test path to its
  // owning runner(s) and admits red per runner; the single path below stays
  // byte-identical when runners is empty/unset (this guard is simply false).
  if (Array.isArray(config.runners) && config.runners.length > 0)
    return observeRedTestPerRunner(paths, state, ticket, receipt, config, tree);
  const configuredRaw = config.test_commands?.targeted;
  const configured =
    typeof configuredRaw === 'string' && configuredRaw.trim() ? configuredRaw : null;
  const templateRaw = config.test_commands?.targeted_template;
  const template =
    typeof templateRaw === 'string' && templateRaw.trim() ? templateRaw : null;
  const shuffleTemplateRaw = config.test_commands?.targeted_shuffle_template;
  const shuffleTemplate =
    typeof shuffleTemplateRaw === 'string' && shuffleTemplateRaw.trim() ? shuffleTemplateRaw : null;
  const shuffleModifierRaw = config.test_commands?.shuffle;
  const shuffleModifier =
    typeof shuffleModifierRaw === 'string' && shuffleModifierRaw.trim() ? shuffleModifierRaw : null;
  // Command resolution order: targeted_template (rendered per authored path,
  // so the observation is provably about the authored tests), then the static
  // operator-attested targeted command, then a derived scoped invocation,
  // then refuse. There is deliberately NO whole-suite fallback: a failing
  // superset never proves the authored test is red (D2).
  let invocation = null;
  let detectedRunner = null;
  const testPaths = [];
  if (template || shuffleTemplate || !configured) {
    // Template rendering and derivation use runtime-validated evidence only:
    // receipt.changed_files is the independently recomputed git diff,
    // filtered to test paths that exist on disk (a deleted test must not
    // fabricate a red failure).
    for (const file of receipt.changed_files.filter((entry) => TEST_PATH_PATTERN.test(entry))) {
      if (await fileExists(path.join(paths.root, file))) testPaths.push(file);
    }
    testPaths.sort();
  }
  if (template) {
    if (testPaths.length === 0) {
      return {
        ok: false,
        errors: [
          emptyAuthoredTestPathsRefusal(
            state,
            ticket,
            'red-test admission found no runtime-verifiable authored test files to render into test_commands.targeted_template',
          ),
        ],
      };
    }
    try {
      invocation = templateInvocation(template, testPaths);
    } catch (error) {
      return {
        ok: false,
        errors: [`test_commands.targeted_template is malformed: ${error.message}`],
      };
    }
    if (!invocation) {
      return {
        ok: false,
        errors: [
          'test_commands.targeted_template must contain the {paths} placeholder so the runtime can scope the red phase to the authored test files',
        ],
      };
    }
  } else if (!configured) {
    detectedRunner = await detectTestRunner(paths.root);
    invocation = targetedInvocation(detectedRunner, testPaths);
    if (
      !invocation &&
      testPaths.length > 0 &&
      testPaths.every((file) => /\.(test|spec)\.(js|mjs|cjs)$/i.test(file))
    ) {
      // Last-resort derivation for a bare Node project without a manifest:
      // the built-in node:test runner over exactly the authored test files.
      // Scoped to red-test admission; the merge gate keeps its own policy.
      invocation = { command: process.execPath, args: ['--test', ...testPaths], scoped: true };
    }
    if (!invocation) {
      return {
        ok: false,
        errors: [
          testPaths.length === 0
            ? emptyAuthoredTestPathsRefusal(
                state,
                ticket,
                'red-test admission found no runtime-verifiable authored test files; configure test_commands.targeted_template or test_commands.targeted',
              )
            : 'red-test admission has no derivable test command; configure test_commands.targeted_template or test_commands.targeted',
        ],
      };
    }
    if (invocation.scoped !== true) {
      // The runner cannot select tests by path, so the only derivable command
      // is the whole suite — and a whole-suite failure is never proof the
      // AUTHORED test is red: any pre-existing or flaky failure would admit a
      // vacuous authored test as an observed red phase (F12). Fail closed
      // before spawning anything.
      return {
        ok: false,
        errors: [
          `red-test admission cannot scope the detected ${detectedRunner.runner} runner to the authored test paths; a whole-suite failure is not proof the authored test is red — configure test_commands.targeted_template ('{paths}' receives the authored test files)`,
        ],
      };
    }
  }
  // Order-shuffle seam (red-admission-flake-screen, config-only): when the
  // operator attests an order-varying command shape via
  // test_commands.targeted_shuffle_template, it renders the SECOND admission
  // run only. Unset, run B re-executes run A's exact invocation — absence
  // provably changes nothing beyond the plain double run.
  let shuffleInvocation = null;
  if (shuffleTemplate) {
    if (testPaths.length === 0) {
      return {
        ok: false,
        errors: [
          emptyAuthoredTestPathsRefusal(
            state,
            ticket,
            'red-test admission found no runtime-verifiable authored test files to render into test_commands.targeted_shuffle_template',
          ),
        ],
      };
    }
    try {
      shuffleInvocation = templateInvocation(shuffleTemplate, testPaths);
    } catch (error) {
      return {
        ok: false,
        errors: [`test_commands.targeted_shuffle_template is malformed: ${error.message}`],
      };
    }
    if (!shuffleInvocation) {
      return {
        ok: false,
        errors: [
          'test_commands.targeted_shuffle_template must contain the {paths} placeholder so the runtime can scope the red phase to the authored test files',
        ],
      };
    }
  }
  // Composable shuffle MODIFIER (test-command-modifiers, config-only): when the
  // operator sets test_commands.shuffle but NOT the fuller
  // targeted_shuffle_template escape hatch, run B is run A's exact invocation
  // with the shuffle-modifier tokens APPENDED — the operator attests the
  // appended shape varies execution order. The template retains precedence (the
  // block above already built shuffleInvocation, so this stays inert when it is
  // set: the slot neither renders nor tags). A malformed slot (one that fails
  // tokenization) refuses admission with a test_commands.shuffle-named error
  // BEFORE either run executes, rather than silently admitting.
  let shuffleModifierInvocation = null;
  let shuffleModifierCommand = null;
  if (!shuffleTemplate && shuffleModifier) {
    let modifierTokens;
    try {
      modifierTokens = splitCommand(shuffleModifier);
    } catch (error) {
      return {
        ok: false,
        errors: [`test_commands.shuffle is malformed: ${error.message}`],
      };
    }
    if (invocation) {
      // Append at argv level onto run A's pre-tokenized invocation so a rendered
      // path with spaces stays one argument (mirrors templateInvocation).
      shuffleModifierInvocation = {
        command: invocation.command,
        args: [...invocation.args, ...modifierTokens],
      };
    } else {
      // Run A ran the static test_commands.targeted string; run B appends the
      // modifier as a command string (re-tokenized by runTestSuite).
      shuffleModifierCommand = `${configured} ${shuffleModifier}`;
    }
  }
  const shuffleModifierApplied = shuffleModifierInvocation !== null || shuffleModifierCommand !== null;
  // Double-run red admission (red-admission-flake-screen): the authored tests
  // execute TWICE and admission requires BOTH invocations to fail at the
  // exit-code level — a red observed once and gone the next invocation is a
  // flaky red, not an observed red phase. Exit-code level only (invariant 6):
  // no output parsing, no assertion comparison, and differing nonzero codes
  // are both red. One admission performs at most these two bounded scoped
  // runs — never a retry loop (invariant 5).
  const runOptions = {
    ...(invocation ? { override: invocation } : { command: configured }),
    timeout_ms: config.deadlines_ms?.[state.lane],
  };
  const verification = await runTestSuite(paths.root, runOptions);
  // Per-run no-verdict guard: a run-A tooling fault, missing exit code, or
  // deadline kill proves nothing about the authored tests — and nothing about
  // writer flakiness — so run B never executes and the single-execution
  // no-verdict refusal below is preserved exactly.
  const noVerdict = (run) =>
    run.tooling_failure === true || run.exit_code === null || run.timed_out === true;
  // Run B gets its own timeout budget. Artifacts are deliberately NOT
  // restored between the runs: restoring would erase exactly the
  // marker/artifact toggle state a flaky red keys on, hiding the
  // nondeterminism this screen exists to catch. Restore still precedes every
  // verdict decision below.
  const runBOptions = shuffleInvocation
    ? { override: shuffleInvocation, timeout_ms: config.deadlines_ms?.[state.lane] }
    : shuffleModifierInvocation
      ? { override: shuffleModifierInvocation, timeout_ms: config.deadlines_ms?.[state.lane] }
      : shuffleModifierCommand
        ? { command: shuffleModifierCommand, timeout_ms: config.deadlines_ms?.[state.lane] }
        : runOptions;
  const verificationB = noVerdict(verification)
    ? null
    : await runTestSuite(paths.root, runBOptions);
  // Tree stability, handled BEFORE any verdict check so every exit path —
  // refusal or admission — leaves the tree the receipt attests. The executed
  // command ran with full filesystem access, so the observation is only
  // evidence for the attested tree; but ecosystem runners routinely write
  // side-effect artifacts (a package manager resolving a lockfile, generated
  // bytecode), and silently rejecting those used to wall the retry behind an
  // unclaimed-write rejection with a misleading external-writer hint. D2:
  // handle explicitly — a path ABSENT from the attested tree was created by
  // the command and is removed (deletion exactly restores the attested tree;
  // the removal is recorded in the sealed observation). A pre-existing path
  // the command modified or deleted is never auto-restored — rewriting
  // content is indistinguishable from clobbering a concurrent writer's work —
  // so it refuses, naming the real cause.
  const restoredArtifacts = [];
  // The executed command had full filesystem access, so whatever the session
  // memoized before the run is no longer evidence: reseed with a real read.
  tree.invalidate();
  let postExecutionTree = await tree.current();
  if (postExecutionTree !== receipt.head_tree_sha) {
    const mutated = await tree.diff(receipt.head_tree_sha, postExecutionTree);
    const modified = [];
    for (const file of mutated) {
      if (await treeHasPath(paths.root, receipt.head_tree_sha, file)) {
        modified.push(file);
      } else {
        // force rm: a failed removal (win32 held handle) is caught by the
        // recompute below and refuses — never silently admitted.
        await rm(path.join(paths.root, file), { force: true }).catch(() => {});
        restoredArtifacts.push(file);
      }
    }
    if (restoredArtifacts.length > 0) {
      // The removals just changed the tree again; the refuse-or-admit
      // decision below needs another real read, not the pre-removal memo.
      tree.invalidate();
      postExecutionTree = await tree.current();
    }
    if (postExecutionTree !== receipt.head_tree_sha) {
      const cause = modified.length > 0 ? modified : mutated;
      return {
        ok: false,
        errors: [
          `red-test execution modified pre-existing files (${cause.join(', ')}); runner side-effect artifacts must be committed or gitignored before the run — red evidence must be tree-stable`,
        ],
      };
    }
  }
  // No-verdict beats "failed" — and beats "flaky": a tooling fault, a run
  // with no exit code, or a deadline kill must never be admitted as an
  // observed red phase, and a deadline-killed run B must never read as
  // nondeterminism either — a kill proves nothing about writer flakiness.
  // timed_out matters on its own because a killed tree can still exit with a
  // code — a SIGTERM-trapping suite exiting nonzero, or win32's taskkill
  // exit 1 — which without the marker is indistinguishable from a genuine
  // red. verificationB is null exactly when run A produced no verdict.
  if (verificationB === null || noVerdict(verificationB)) {
    return {
      ok: false,
      errors: ['red-test execution did not produce a test verdict; configure test_commands.targeted_template or test_commands.targeted'],
    };
  }
  // Pytest documents exits 5 (no tests collected) and 4 (usage error) as
  // non-verdict outcomes: nothing ran, so nothing was observed red. A
  // misnamed test function (`def check_add`) exits 5 and used to seal a
  // vacuous red observation that only surfaced as a gates block after full
  // build+review spend. Scoped to provably-pytest invocations — these codes
  // are ordinary failures for other runners — and applied PER RUN against
  // that run's own invocation tokens (the shuffle seam can shape run B's
  // argv differently from run A's).
  for (const run of [verification, verificationB]) {
    if (!isPytestInvocation(detectedRunner?.runner ?? null, [run.runner.command, ...run.runner.args])) continue;
    if (run.exit_code === 5) {
      return {
        ok: false,
        errors: ['pytest collected no tests (exit 5): the authored tests were never executed — fix test naming/collection; the red phase was not observed'],
      };
    }
    if (run.exit_code === 4) {
      return {
        ok: false,
        errors: ['pytest usage error (exit 4): the red-test command did not run the authored tests — fix test_commands.targeted_template or test_commands.targeted; the red phase was not observed'],
      };
    }
  }
  if (verification.passed === true && verificationB.passed === true) {
    return {
      ok: false,
      errors: ['runtime-executed red-test passed: the red phase was not observed'],
    };
  }
  // Divergent pair: exactly one of the two verdicts is exit 0. A flaky red is
  // its own actionable refusal, never conflated with the vacuous-red message
  // above — the writer must make the authored tests fail deterministically,
  // not merely fail once.
  if (verification.passed !== verificationB.passed) {
    return {
      ok: false,
      errors: [
        `runtime-executed red-test is nondeterministic: the authored tests failed one invocation and passed the other (exit ${verification.exit_code} then exit ${verificationB.exit_code}); a flaky red is not an observed red phase — make the authored tests fail deterministically, then resubmit the receipt`,
      ],
    };
  }
  const commandA = invocation ? [invocation.command, ...invocation.args].join(' ') : configured;
  const commandB = shuffleInvocation
    ? [shuffleInvocation.command, ...shuffleInvocation.args].join(' ')
    : shuffleModifierInvocation
      ? [shuffleModifierInvocation.command, ...shuffleModifierInvocation.args].join(' ')
      : shuffleModifierCommand
        ? shuffleModifierCommand
        : commandA;
  return {
    ok: true,
    // Runtime-measured red-test wall clock is returned BESIDE the sealed
    // observation (never a key inside it) so the caller can accumulate it into
    // the certification timing block without perturbing evidence.red_test (T14).
    // Double-run admission reports the SUMMED cost of both invocations.
    duration_ms: verification.duration_ms + verificationB.duration_ms,
    observation: {
      observed: true,
      command: commandA,
      ...(invocation
        ? invocation.template === true
          ? { template: true, test_paths: testPaths }
          : { derived: true, test_paths: testPaths }
        : { configured: true }),
      passed: false,
      exit_code: verification.exit_code,
      result_hash: sha256(verification),
      tree_sha: receipt.head_tree_sha,
      // Both admission runs in execution order. Top-level fields stay sourced
      // from run A; runs[] carries the per-invocation evidence, and marks the
      // second entry when the operator-attested shuffle seam drove it.
      runs: [
        {
          command: commandA,
          exit_code: verification.exit_code,
          duration_ms: verification.duration_ms,
          result_hash: sha256(verification),
        },
        {
          command: commandB,
          exit_code: verificationB.exit_code,
          duration_ms: verificationB.duration_ms,
          result_hash: sha256(verificationB),
          ...(shuffleInvocation
            ? { shuffle_template: true }
            : shuffleModifierApplied
              ? { shuffle_modifier: true }
              : {}),
        },
      ],
      ...(restoredArtifacts.length > 0 ? { restored_artifacts: restoredArtifacts } : {}),
      executed_at: now(),
    },
  };
}

// Per-runner red-test admission (sibling to observeRedTest, reached only when
// config.runners is non-empty). Each runtime-verified authored test path routes
// to EVERY runner whose `owns` globs match (union ownership); a path owned by no
// runner is an ORPHAN. participants = runners owning >=1 authored test path. Each
// participant resolves a SCOPED invocation for its subset — targeted_template,
// then static targeted, then a derived scope at the runner's own root — and is
// then double-run through the same exit-code-only screen as the single path.
// Admission requires EVERY participant to be deterministically red. The whole
// receipt is atomic: any orphan, unscopeable owning runner, or malformed
// template refuses fail-closed BEFORE any spawn, naming only the offending
// runner id + its exact paths (and orphan paths), never a scopeable runner.
async function observeRedTestPerRunner(paths, state, ticket, receipt, config, tree) {
  const runners = config.runners;
  // Runtime-validated authored test subset — mirror the single path exactly:
  // the independently recomputed diff, filtered to test paths that exist on
  // disk (a deleted test must not fabricate a red failure), sorted.
  const testPaths = [];
  for (const file of receipt.changed_files.filter((entry) => TEST_PATH_PATTERN.test(entry))) {
    if (await fileExists(path.join(paths.root, file))) testPaths.push(file);
  }
  testPaths.sort();
  // AMENDMENT 1a (F12 vacuous-red, fail closed): an empty routed authored-test
  // set can never be admitted with nothing run. This precedes participant
  // resolution and the every-participant-red conjunction.
  if (testPaths.length === 0) {
    return {
      ok: false,
      errors: [
        emptyAuthoredTestPathsRefusal(
          state,
          ticket,
          'red-test admission found no runtime-verifiable authored test files; configure a runner profile.targeted_template or test_commands.targeted',
        ),
      ],
    };
  }
  // Route each authored test path to every owning runner (union ownership via
  // the shared owns-matcher); a path owned by no runner is an orphan.
  const owned = runners.map(() => []);
  const orphans = [];
  for (const file of testPaths) {
    const normalized = normalizeClaimPath(file);
    let anyOwner = false;
    runners.forEach((runner, index) => {
      if (runnerOwnsFile(runner, normalized)) {
        owned[index].push(file);
        anyOwner = true;
      }
    });
    if (!anyOwner) orphans.push(file);
  }
  // Spawn-free prologue: resolve a scoped invocation for each participating
  // runner (detection included) and collect every fail-closed refusal BEFORE
  // any run executes. subsetRel relativizes to the runner's own root so
  // detection cwd and execution cwd agree (AMENDMENT 2).
  const participants = [];
  const errors = [];
  for (let index = 0; index < runners.length; index += 1) {
    const runner = runners[index];
    const subset = owned[index];
    if (subset.length === 0) continue; // owns no authored test path — not a participant
    const runnerRoot = normalizeClaimPath(runner.root ?? '.');
    const subsetRel = subset
      .map((file) => path.posix.relative(runnerRoot, normalizeClaimPath(file)))
      .sort();
    const profile = runner.profile ?? {};
    const templateRaw = profile.targeted_template;
    const template = typeof templateRaw === 'string' && templateRaw.trim() ? templateRaw : null;
    const targetedRaw = profile.targeted;
    const targeted = typeof targetedRaw === 'string' && targetedRaw.trim() ? targetedRaw : null;
    let invocation = null;
    let detected = null;
    let command = null;
    if (template) {
      // (1) targeted_template rendered over the runner-root-relative subset.
      let rendered;
      try {
        rendered = templateInvocation(template, subsetRel);
      } catch (error) {
        errors.push(
          `runner '${runner.id}' targeted_template is malformed: ${error.message} (paths ${subset.join(', ')})`,
        );
        continue;
      }
      if (!rendered) {
        errors.push(
          `runner '${runner.id}' targeted_template must contain the {paths} placeholder to scope the red phase to its authored test files (paths ${subset.join(', ')})`,
        );
        continue;
      }
      invocation = rendered;
      command = [rendered.command, ...rendered.args].join(' ');
    } else if (targeted) {
      // (2) static operator-attested targeted command (used verbatim).
      command = targeted;
    } else {
      // (3) DERIVED at the runner's own root, plus the bare-Node last resort.
      detected = await detectTestRunner(path.join(paths.root, runner.root ?? '.'));
      invocation = targetedInvocation(detected, subsetRel);
      if (
        !invocation &&
        subsetRel.length > 0 &&
        subsetRel.every((file) => /\.(test|spec)\.(js|mjs|cjs)$/i.test(file))
      ) {
        invocation = { command: process.execPath, args: ['--test', ...subsetRel], scoped: true };
      }
      if (!invocation || invocation.scoped !== true) {
        errors.push(
          `runner '${runner.id}' cannot scope the detected ${detected?.runner ?? 'none'} runner to its authored test paths (${subset.join(', ')}); a whole-suite failure is not proof the authored test is red — configure its profile.targeted_template`,
        );
        continue;
      }
      command = [invocation.command, ...invocation.args].join(' ');
    }
    participants.push({ runner, subset, subsetRel, invocation, targeted, detected, command });
  }
  // Orphan refusal, folded into the whole-receipt-atomic pre-spawn refusal:
  // name each orphan path, never a scopeable runner.
  for (const orphan of orphans) {
    errors.push(
      `red-test admission authored test path '${orphan}' is owned by no configured runner; add an owns glob or a runner that owns it`,
    );
  }
  // REFUSE-BEFORE-SPAWN: any orphan, unscopeable owning runner, or malformed
  // template refuses now — before any runTestSuite spawn, nothing sealed.
  if (errors.length > 0) {
    return { ok: false, errors };
  }
  // AMENDMENT 1b (F12): the every-participant-red conjunction must never be
  // reached with zero participants. Orphan/empty-set refusals above precede
  // this; it is defence in depth.
  if (participants.length === 0) {
    return {
      ok: false,
      errors: [
        'red-test admission found no runtime-verifiable authored test files to route to any configured runner',
      ],
    };
  }
  // Per-run no-verdict guard, identical semantics to the single path: a tooling
  // fault, a missing exit code, or a deadline kill proves nothing.
  const noVerdict = (run) =>
    run.tooling_failure === true || run.exit_code === null || run.timed_out === true;
  const breakdown = [];
  let totalDuration = 0;
  // SPAWN/COLLECT phase — mirror the single path's "all runs, then the ONE
  // restore, then the verdicts" macro-structure. Per-runner double run
  // (exit-code only, invariant 6): each participant's subset runs TWICE at the
  // runner's own root with the exact same invocation (run B = run A). Artifacts
  // are NOT restored between a runner's two runs, so a flaky red keyed on a
  // marker is caught. <=2 runs per participant, no retry loop (invariant 5).
  // Every participant spawns here BEFORE any post-spawn verdict refusal; the
  // verdicts are applied in the VERDICT/BREAKDOWN phase after the restore.
  const results = [];
  for (const participant of participants) {
    const runnerCwd = path.join(paths.root, participant.runner.root ?? '.');
    const runOptions = {
      ...(participant.invocation ? { override: participant.invocation } : { command: participant.targeted }),
      timeout_ms: config.deadlines_ms?.[state.lane],
    };
    const verification = await runTestSuite(runnerCwd, runOptions);
    const verificationB = noVerdict(verification) ? null : await runTestSuite(runnerCwd, runOptions);
    results.push({ participant, verification, verificationB });
  }
  // RESTORE phase — AMENDMENT 2 (iv): the ONE whole-tree stability recompute
  // stays at REPO ROOT — git-in-root and cwd-independent — reusing the single
  // path's block verbatim. It now runs AFTER every participant has spawned and
  // BEFORE the per-runner verdict refusals, so every exit path (admission OR a
  // post-spawn refusal) leaves the tree the receipt attests, mirroring the
  // single path.
  const restoredArtifacts = [];
  tree.invalidate();
  let postExecutionTree = await tree.current();
  if (postExecutionTree !== receipt.head_tree_sha) {
    const mutated = await tree.diff(receipt.head_tree_sha, postExecutionTree);
    const modified = [];
    for (const file of mutated) {
      if (await treeHasPath(paths.root, receipt.head_tree_sha, file)) {
        modified.push(file);
      } else {
        await rm(path.join(paths.root, file), { force: true }).catch(() => {});
        restoredArtifacts.push(file);
      }
    }
    if (restoredArtifacts.length > 0) {
      tree.invalidate();
      postExecutionTree = await tree.current();
    }
    if (postExecutionTree !== receipt.head_tree_sha) {
      const cause = modified.length > 0 ? modified : mutated;
      return {
        ok: false,
        errors: [
          `red-test execution modified pre-existing files (${cause.join(', ')}); runner side-effect artifacts must be committed or gitignored before the run — red evidence must be tree-stable`,
        ],
      };
    }
  }
  // VERDICT/BREAKDOWN phase — apply the SAME four post-spawn refusals in the
  // SAME order with byte-identical shapes as the pre-split loop (returning on
  // the first failing participant), now AFTER the restore so every refusal
  // leaves the tree the receipt attests. Only deterministically-red
  // participants accumulate duration and push a per-runner breakdown entry.
  for (const { participant, verification, verificationB } of results) {
    if (verificationB === null || noVerdict(verificationB)) {
      return {
        ok: false,
        errors: [
          `runner '${participant.runner.id}' red-test execution did not produce a test verdict; configure its profile.targeted_template or test_commands.targeted`,
        ],
      };
    }
    // Pytest exits 5/4 are non-verdict outcomes — applied only on provably
    // pytest invocations, per run against that run's own argv tokens.
    for (const run of [verification, verificationB]) {
      if (!isPytestInvocation(participant.detected?.runner ?? null, [run.runner.command, ...run.runner.args])) continue;
      if (run.exit_code === 5) {
        return {
          ok: false,
          errors: [
            `runner '${participant.runner.id}' pytest collected no tests (exit 5): the authored tests were never executed — fix test naming/collection; the red phase was not observed`,
          ],
        };
      }
      if (run.exit_code === 4) {
        return {
          ok: false,
          errors: [
            `runner '${participant.runner.id}' pytest usage error (exit 4): the red-test command did not run the authored tests — fix its profile.targeted_template or test_commands.targeted; the red phase was not observed`,
          ],
        };
      }
    }
    if (verification.passed === true && verificationB.passed === true) {
      return {
        ok: false,
        errors: [
          `runner '${participant.runner.id}' runtime-executed red-test passed: the red phase was not observed`,
        ],
      };
    }
    if (verification.passed !== verificationB.passed) {
      return {
        ok: false,
        errors: [
          `runner '${participant.runner.id}' runtime-executed red-test is nondeterministic: the authored tests failed one invocation and passed the other (exit ${verification.exit_code} then exit ${verificationB.exit_code}); a flaky red is not an observed red phase — make the authored tests fail deterministically, then resubmit the receipt`,
        ],
      };
    }
    // This participant is deterministically red across both runs.
    totalDuration += verification.duration_ms + verificationB.duration_ms;
    breakdown.push({
      id: participant.runner.id,
      root: participant.runner.root ?? '.',
      command: participant.command,
      exit_code: verification.exit_code,
      test_paths: participant.subsetRel,
      runs: [
        {
          command: participant.command,
          exit_code: verification.exit_code,
          duration_ms: verification.duration_ms,
          result_hash: sha256(verification),
        },
        {
          command: participant.command,
          exit_code: verificationB.exit_code,
          duration_ms: verificationB.duration_ms,
          result_hash: sha256(verificationB),
        },
      ],
    });
  }
  // Every participant is deterministically red — admit. The observation superset
  // carries the per-runner breakdown; it is sealed into evidence.red_test by the
  // caller AFTER validateStageReceipt, so no schema/validator change is needed.
  return {
    ok: true,
    duration_ms: totalDuration,
    observation: {
      observed: true,
      passed: false,
      tree_sha: receipt.head_tree_sha,
      participants: breakdown,
      ...(restoredArtifacts.length > 0 ? { restored_artifacts: restoredArtifacts } : {}),
      executed_at: now(),
    },
  };
}

function receiptInputHash(raw) {
  const bounded = { ...raw };
  delete bounded.receipt_capability;
  delete bounded.receipt_id;
  return sha256(bounded);
}

function receiptTransactionPath(paths, ticketId) {
  return path.join(paths.receiptTransactions, `${sha256(ticketId)}.json`);
}

const REVIEW_RECEIPT_ROLES = new Set(['reviewer', 'security_reviewer']);

// Mirrors groupOutcome's positive set (scheduler.js): a proposal is admitted
// only from a receipt that will actually vote disagree and open remediation.
const POSITIVE_REVIEW_VERDICTS = new Set(['agree', 'pass', 'passed']);

// Roadmap entry bounded-summary-control-character-passthrough, ADMISSION
// half: a NEW refusal on a proposed scope_expansion claim path bearing the
// render-side BOUNDED_SUMMARY_CONTROL_CHARS set (above) MINUS U+200C/U+200D
// (ZWNJ, ZWJ) -- the approved plan's exemption, so a legitimately named
// Persian/Indic joining sequence or a ZWJ-emoji-bearing path is admitted here
// with its true bytes. OWN CONSTANT, never the render-side `/g` regex
// (discussion point C11): a `/g` regex driven through `.test()` carries
// `lastIndex` across calls and would alternate accept/refuse on the
// IDENTICAL input, which a shared instance would do here since this
// predicate runs once per claimed-path entry, in a loop, across possibly
// many receipts. Built the same NUMERIC-code-point way as the render set,
// for the identical reason: no literal byte, no `\u` escape ambiguity, in
// this file's own text.
//
// THIS EXEMPTION IS ONE-SIDED, and that residual is recorded rather than
// closed (discussion point C9): the render bound (boundedGateSummary, above)
// still maps U+200C/U+200D to the replacement character wherever this same
// path is later rendered into agent-facing text (e.g. an inherited-base
// notice), so a legitimately valid path admitted whole here can still be
// shown to a later agent mangled -- a NEW misrepresentation of VALID input
// this ticket's objective did not ask for, left for a future ticket to close.
// FIVE DISTINCT CHARACTER POLICIES COEXIST across this codebase; keep this
// enumeration current when ownership moves or any policy changes:
//   1. BOUNDED_SUMMARY_CONTROL_CHARS in status-service.js replaces bounded
//      render-side hazards and includes U+200C/U+200D.
//   2. SCOPE_EXPANSION_CONTROL_CHARS below, with pipeline.js's sibling,
//      screens admission while deliberately exempting U+200C/U+200D.
//   3. review-evidence.js REVIEW_TEXT_FLATTEN collapses the full Cc/Cf class
//      while bounding review findings and prior-attempt summaries.
//   4. github-shipping.js boundedTail strips its narrower command-output class.
//   5. write-policy.js WRITE_CONTENT_HAZARD_CHARS is deliberately WIDER than
//      policy 2 because it gates bytes entering executable tracked source. It
//      additionally refuses U+2028/U+2029, U+FEFF, and the astral TAGS block.
//      Never re-sync it down to policy 2's narrower set; doing so would reopen
//      the source-smuggling bypasses that widening closed.
// RESIDUALS RECORDED: these policies intentionally differ by threat model.
function scopeExpansionControlCharsPattern() {
  const parts = [
    codePointRange(0x0000, 0x0008),
    codePointRange(0x000e, 0x001f),
    codePointRange(0x007f, 0x009f),
    codePointRange(0x00ad, 0x00ad),
    codePointRange(0x061c, 0x061c),
    // U+200B-U+200F MINUS the U+200C/U+200D exemption: U+200B alone, then
    // U+200E-U+200F, skipping the two ZWNJ/ZWJ code points in between.
    codePointRange(0x200b, 0x200b),
    codePointRange(0x200e, 0x200f),
    codePointRange(0x202a, 0x202e),
    codePointRange(0x2060, 0x206f),
    codePointRange(0xfff9, 0xfffb),
  ];
  return `[${parts.join('')}]`;
}

const SCOPE_EXPANSION_CONTROL_CHARS = new RegExp(scopeExpansionControlCharsPattern());

// D3 (audited scope expansion): a blocking review may name the exact paths the
// fix needs but the run never claimed, as
// `evidence.scope_expansion: { claimed_paths, reason }`. Admission is strict
// and loud — every malformed or out-of-contract proposal rejects the receipt
// naming the offending field — because a silently dropped path recreates
// exactly the unfixable-by-design remediation this channel exists to kill
// (friction log #1/#2: the reviewer knew the five out-of-claims files and the
// machine had no way to use that knowledge). Growing a write allowlist mid-run
// is an override-class operation, so the accepted proposal is audited to
// overrides.ndjson by the SCOPE_EXPANDED reducer arm before the state
// transition applies.
function extractScopeExpansion(ticket, receipt) {
  const raw = receipt.evidence?.scope_expansion;
  // null proposes nothing, so it is absence, not a malformed proposal.
  if (raw === undefined || raw === null) return { errors: [], claimed_paths: [], reason: null };
  const errors = [];
  if (!REVIEW_RECEIPT_ROLES.has(ticket.role)) {
    return {
      errors: [
        `evidence.scope_expansion is a review-receipt channel (reviewer or security_reviewer); a ${ticket.role} receipt may not grow the claim set`,
      ],
      claimed_paths: [],
      reason: null,
    };
  }
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    return {
      errors: ['evidence.scope_expansion must be an object: { claimed_paths: [..], reason: ".." }'],
      claimed_paths: [],
      reason: null,
    };
  }
  // An agreeing review has no remediation to scope: accepting its proposal
  // would grow the allowlist with no finding driving the change. The reviewer
  // signals "the fix requires these paths" WITH the blocking verdict.
  const blocking =
    String(receipt.status).toLowerCase() !== 'passed' ||
    !POSITIVE_REVIEW_VERDICTS.has(String(receipt.evidence?.verdict ?? receipt.status).toLowerCase());
  if (!blocking) {
    errors.push('scope expansion requires a blocking review verdict: record the finding with evidence.verdict fail alongside the proposed paths');
  }
  if (typeof raw.reason !== 'string' || raw.reason.trim() === '') {
    errors.push('scope expansion requires a non-empty evidence.scope_expansion.reason naming why the fix needs the added paths');
  }
  const claimed = [];
  if (!Array.isArray(raw.claimed_paths) || raw.claimed_paths.length === 0) {
    errors.push('scope expansion requires evidence.scope_expansion.claimed_paths: a non-empty array of project-relative paths');
  } else {
    for (const entry of raw.claimed_paths) {
      // SELF-REFERENTIAL DEFECT, CLOSED (roadmap entry
      // agent-facing-text-routes-bypassing-the-prose-bound): every message
      // below used to interpolate `entry` raw -- including the non-string/
      // blank-entry message immediately below (a raw, unbounded
      // JSON.stringify: an object whose own string values carried bidi/DEL
      // bytes reached the wire verbatim, with NO length cap at all --
      // assertSafeInput (input-guard.js:3-9) admits 64 KB per field and
      // nothing on this path bounded it, against a wire response budget of
      // RESPONSE_BUDGET_CHARS = 48,000, projection.js:60) and the control-
      // character refusal a few lines down, so a reviewer-supplied bidi
      // override reached the operator's terminal in the very message
      // refusing that exact byte. `shown` renders `entry` through the SAME
      // neutralizer boundedGateSummary already gives every other bounded
      // agent-facing string (policy 1 above), at the 200-char cap
      // testRemediationNotice and EXPIRED_PREDECESSOR_PATH_MAX_CHARS already
      // use for this class of text (plan-critic C6 -- 120 would be a third,
      // unexplained number). A non-string value is JSON.stringify'd first so
      // its shape still reads (object/array/number/etc.); a string value
      // (including a blank one) is passed through unquoted so an ordinary
      // path is not mangled with stray quote characters. Computed ONCE, used
      // by EVERY message in this loop -- including the first, immediately
      // below -- so no sibling refusal is independently unguarded.
      // boundedGateSummary maps blank/whitespace-only input to null; mapped
      // to '' here so the message still reads rather than interpolating the
      // literal string 'undefined'.
      const shown = boundedGateSummary(typeof entry === 'string' ? entry : JSON.stringify(entry), 200) ?? '';
      if (typeof entry !== 'string' || entry.trim() === '') {
        errors.push(`scope_expansion.claimed_paths entries must be non-empty strings, got ${shown}`);
        continue;
      }
      // INSERTION POINT chosen deliberately (discussion point C11): right
      // after the non-empty-string check and BEFORE every path-STRUCTURE
      // predicate below (absolute/drive-letter, '..' segments, empty-after-
      // normalization, .ape, test-shaped). A control/bidi/format byte is a
      // CHARACTER-level defect, prior to and independent of whatever the
      // path's segments spell, so a doubly-invalid path (one that is both
      // control-character-bearing and, say, absolute) reports THIS refusal
      // first. Tested on the raw `entry`, since none of these code points is
      // touched by the backslash-to-slash normalization one line below.
      if (SCOPE_EXPANSION_CONTROL_CHARS.test(entry)) {
        errors.push(`scope_expansion path may not contain a control, DEL/C1, or bidi/format character: ${shown}`);
        continue;
      }
      const slashed = entry.replaceAll('\\', '/');
      if (slashed.startsWith('/') || /^[A-Za-z]:/.test(slashed)) {
        errors.push(`scope_expansion path must be relative to the project root: ${shown}`);
        continue;
      }
      if (slashed.split('/').includes('..')) {
        errors.push(`scope_expansion path may not contain '..' segments: ${shown}`);
        continue;
      }
      const normalized = normalizeClaimPath(slashed);
      if (normalized === '' || normalized === '.') {
        errors.push(`scope_expansion path is empty after normalization: ${shown}`);
        continue;
      }
      if (normalized === '.ape' || normalized.startsWith('.ape/')) {
        errors.push(`scope_expansion may not claim APE runtime state: ${shown}`);
        continue;
      }
      // A test-shaped claim would issue a remediation ticket the role
      // boundary then dooms: the write-time hook and receipt validator deny
      // every implementer touch on test-shaped paths (behavioral test
      // independence) regardless of claims, so admitting one manufactures a
      // wedge. Same predicate and inputs as those layers.
      if (looksLikeTest(normalized, ticket.test_paths ?? [])) {
        errors.push(`scope_expansion may not claim test-shaped path ${shown}: authored tests stay implementer-read-only; propose production paths only`);
        continue;
      }
      claimed.push(normalized);
    }
  }
  // prose-bound-exempt: raw.reason is the reviewer's own scope_expansion
  // reason text, returned here UNBOUNDED and deliberately so — this function
  // validates a proposal, it does not neutralize it. Its single caller cuts it
  // with boundedGateSummary before forwarding it onto the SCOPE_EXPANDED
  // event, which is what keeps it out of durable run state, off the ape_run
  // wire and out of the joined ticket notice; the audit_override line bounds
  // it again at its own persistence sink. The bound lives at that one call
  // site rather than here so the value cannot reach any sink un-cut.
  return { errors, claimed_paths: [...new Set(claimed)], reason: raw.reason ?? null };
}

// Is this exact scope-expansion already audited in overrides.ndjson? Used ONLY
// on the prepared-transaction replay path, where the identical expansion is
// recomputed from the identical receipt and would otherwise append a second,
// duplicate audit line. The key is (run_id, operation, added_paths) — the
// identity of the CLAIM GROWTH itself. `at` and `reason` are out of it for
// DIFFERENT reasons. `at` is now(), a fresh wall-clock stamp taken at append
// time, so keying on it would never match the earlier line and would re-append.
// `reason` does NOT vary that way: it is the receipt's own scope_expansion
// reason (extractScopeExpansion above, defaulted in the reducer's
// SCOPE_EXPANDED arm), and this guard runs only where a prepared transaction
// exists — "replay of this ticket with this input", as the caller establishes
// — so the replay recomputes an IDENTICAL `reason`, and keying on it would
// suppress exactly as today's key does. It stays out because the narrative
// attached to a claim growth is not part of the growth's identity, not
// because it would re-append. THE ACCEPTED COST, named so the exclusion does not
// read as an oversight: a STALE-ATTRIBUTION window — a later, DISTINCT expansion
// in the same run that proposes IDENTICAL added_paths and replays is suppressed
// against the earlier line, so `reason`/`at` can name the EARLIER expansion
// while the durable claim growth is the LATER one; the load-bearing invariant is
// unaffected, since a claim growth still always has an audit line naming
// run_id/operation/added_paths. Adding `reason` to the key would narrow that
// window to expansions that also share one, so the exclusion is a declined
// trade and not a forced one. FAILS OPEN — an unreadable log, or a
// line that will not parse, answers "not audited", because a duplicate audit
// line is strictly safer than a claim growth with none. The log is read whole
// on purpose: bounding it to a tail could answer "not audited" for a genuinely
// audited older line and re-append (recorded residual, not fixed here).
async function scopeExpansionAudited(file, runId, addedPaths) {
  const wanted = JSON.stringify(addedPaths);
  const text = await readFile(file, 'utf8').catch(() => '');
  for (const line of text.split('\n')) {
    if (!line) continue;
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      // A torn trailing line is not evidence of anything; skip it.
      continue;
    }
    if (
      entry?.run_id === runId &&
      entry?.operation === 'scope-expansion' &&
      JSON.stringify(entry?.added_paths) === wanted
    ) {
      return true;
    }
  }
  return false;
}

function canonicalRecoveryClaimPath(value) {
  if (
    typeof value !== 'string' || value.length === 0 || value.length > 512 ||
    /[\0-\x1f\x7f]/.test(value) || value.includes('\\') ||
    path.posix.isAbsolute(value) || /^[A-Za-z]:\//.test(value) ||
    value === '.' || value.endsWith('/') || value === '..' || value.startsWith('../') ||
    value === '.ape' || value.startsWith('.ape/') || path.posix.normalize(value) !== value
  ) return null;
  return value;
}

function validateRecoveryDeclarations(ticket, receipt) {
  const errors = [];
  const missing = receipt.evidence?.missing_assurances;
  if (missing !== undefined) {
    if (!['plan_checker', 'plan_critic', 'plan_judge'].includes(ticket.role)) {
      errors.push('evidence.missing_assurances is accepted only from a plan review or plan judge ticket');
    } else if (!Array.isArray(missing) || missing.length < 1 || missing.length > 16) {
      errors.push('evidence.missing_assurances must contain 1 through 16 bounded entries');
    } else {
      missing.forEach((entry, index) => {
        const object = entry !== null && typeof entry === 'object' && !Array.isArray(entry)
          ? entry
          : null;
        const summary = typeof entry === 'string'
          ? entry
          : [object?.summary, object?.assurance, object?.reason, object?.detail, object?.title]
              .find((value) => typeof value === 'string' && value.trim() !== '');
        if (typeof summary !== 'string' || summary.trim() === '' || summary.length > 500) {
          errors.push(`evidence.missing_assurances.${index} requires non-empty summary text of at most 500 characters`);
        }
        if (object?.evidence_anchor !== undefined && (
          typeof object.evidence_anchor !== 'string' ||
          object.evidence_anchor.trim() === '' ||
          object.evidence_anchor.length > 600
        )) {
          errors.push(`evidence.missing_assurances.${index}.evidence_anchor must be non-empty text of at most 600 characters`);
        }
        if (object?.risk_trigger !== undefined && !RISK_TRIGGERS.includes(object.risk_trigger)) {
          errors.push(`evidence.missing_assurances.${index}.risk_trigger is not a supported risk trigger`);
        }
      });
    }
  }

  const requiredClaims = receipt.evidence?.required_claims;
  const capabilityFailure =
    receipt.status === 'failed' && receipt.evidence?.failure_kind === 'capability';
  if (capabilityFailure && requiredClaims === undefined) {
    errors.push('a failed capability receipt requires evidence.required_claims with at least one exact additive claim or required_role');
  }
  if (requiredClaims !== undefined) {
    if (!capabilityFailure) {
      errors.push('evidence.required_claims is accepted only on a failed capability receipt');
    } else if (
      requiredClaims === null ||
      typeof requiredClaims !== 'object' ||
      Array.isArray(requiredClaims)
    ) {
      errors.push('evidence.required_claims must be an object of exact additive claim arrays');
    } else {
      let additiveClaims = 0;
      const allowed = new Set(['claimed_paths', 'test_paths', 'tool_claims', 'required_role']);
      for (const key of Object.keys(requiredClaims)) {
        if (!allowed.has(key)) errors.push(`evidence.required_claims contains unsupported key: ${key}`);
      }
      for (const [key, existing] of [
        ['claimed_paths', ticket.claimed_paths ?? []],
        ['test_paths', ticket.test_paths ?? []],
        ['tool_claims', ticket.tool_claims ?? []],
      ]) {
        const values = requiredClaims[key] ?? [];
        if (!Array.isArray(values) || values.length > 64) {
          errors.push(`evidence.required_claims.${key} must be an array of at most 64 exact additions`);
          continue;
        }
        const seen = new Set();
        for (const [index, value] of values.entries()) {
          if (typeof value !== 'string' || value.trim() === '' || value.length > 512) {
            errors.push(`evidence.required_claims.${key}.${index} must be non-empty text of at most 512 characters`);
            continue;
          }
          let identity;
          let parsedTool = null;
          if (key === 'tool_claims') {
            const parsed = parseToolClaim(value);
            const canonical = parsed
              ? `${parsed.provider}:${parsed.resource}:${parsed.access}`
              : null;
            if (canonical !== value) {
              errors.push(`evidence.required_claims.${key}.${index} must be a canonical provider:resource:read|write|execute claim`);
              continue;
            }
            parsedTool = parsed;
            identity = value;
          } else {
            const canonical = canonicalRecoveryClaimPath(value);
            if (canonical === null) {
              errors.push(`evidence.required_claims.${key}.${index} must be a canonical contained project-relative path`);
              continue;
            }
            identity = normalizeClaimPath(canonical);
          }
          const duplicate = seen.has(identity);
          if (duplicate) errors.push(`evidence.required_claims.${key}.${index} is a duplicate addition`);
          else seen.add(identity);
          const alreadyAuthorized = existing.some((entry) =>
            key === 'tool_claims'
              ? toolClaimAllows([entry], {
                  provider: parsedTool.provider,
                  effect: parsedTool.access,
                  resources: [parsedTool.resource],
                })
              : withinClaims(identity, [entry]));
          if (alreadyAuthorized) {
            errors.push(`evidence.required_claims.${key}.${index} is already on the immutable ticket and is not additive`);
          } else if (!duplicate) {
            additiveClaims += 1;
          }
        }
      }
      if (requiredClaims.required_role !== undefined) {
        if (
          typeof requiredClaims.required_role !== 'string' ||
          !/^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(requiredClaims.required_role)
        ) {
          errors.push('evidence.required_claims.required_role must be a bounded role identifier');
        } else if (!Object.hasOwn(ROLE_POLICIES, requiredClaims.required_role)) {
          errors.push('evidence.required_claims.required_role must name a dispatchable APE role');
        } else if (requiredClaims.required_role === ticket.role) {
          errors.push('evidence.required_claims.required_role is already the immutable ticket role and is not additive');
        } else {
          additiveClaims += 1;
        }
      }
      if (additiveClaims === 0) {
        errors.push('evidence.required_claims must contain at least one genuinely additive valid claim or required_role');
      }
    }
  }

  const contradiction = receipt.evidence?.test_contradiction;
  if (contradiction !== undefined) {
    if (
      ticket.role !== 'implementer' ||
      receipt.status !== 'failed' ||
      receipt.evidence?.failure_kind !== 'test-contradiction'
    ) {
      errors.push('evidence.test_contradiction is accepted only from a failed implementer test-contradiction receipt');
    } else if (contradiction === null || typeof contradiction !== 'object' || Array.isArray(contradiction)) {
      errors.push('evidence.test_contradiction must be a structured contradiction report');
    } else {
      const paths = contradiction.test_paths ?? [];
      if (!Array.isArray(paths) || paths.length > 64) {
        errors.push('evidence.test_contradiction.test_paths must be an array of at most 64 authorized paths');
      } else {
        for (const [index, testPath] of paths.entries()) {
          if (typeof testPath !== 'string' || !ticket.test_paths.includes(testPath)) {
            errors.push(`evidence.test_contradiction.test_paths.${index} is not an exact authorized ticket test path`);
          }
        }
      }
      for (const key of ['summary', 'incompatible_expectations']) {
        if (contradiction[key] !== undefined && (
          typeof contradiction[key] !== 'string' ||
          contradiction[key].trim() === '' ||
          contradiction[key].length > 2_000
        )) {
          errors.push(`evidence.test_contradiction.${key} must be non-empty text of at most 2000 characters`);
        }
      }
    }
  }

  if (ticket.stage_id === 'test-reconcile' && receipt.status === 'passed') {
    const verdict = String(receipt.evidence?.verdict ?? '').toLowerCase();
    const negative = new Set(['disagree', 'fail', 'failed']).has(verdict);
    const positive = new Set(['agree', 'pass', 'passed']).has(verdict);
    const blocking = (receipt.findings ?? []).filter((finding) => finding?.blocking === true);
    if (negative) {
      const authorized = new Set(ticket.test_reconciliation?.test_paths ?? []);
      const confirmed = new Set();
      for (const [index, finding] of blocking.entries()) {
        const owner = finding?.remediation?.owner;
        if (!['test', 'both'].includes(owner)) {
          errors.push(`findings.${index} on a negative test-reconcile receipt must be test- or both-owned`);
          continue;
        }
        for (const testPath of finding.remediation?.test_paths ?? []) {
          if (!authorized.has(testPath)) {
            errors.push(`findings.${index}.remediation.test_paths contains a path outside ticket.test_reconciliation.test_paths: ${boundedGateSummary(testPath, 200) ?? ''}`);
          } else {
            confirmed.add(testPath);
          }
        }
      }
      if (confirmed.size === 0) {
        errors.push('a negative test-reconcile verdict requires a blocking test- or both-owned finding that confirms at least one authorized reconciliation path');
      }
    } else if (positive && blocking.length > 0) {
      errors.push('a positive test-reconcile verdict may not carry a blocking contradiction finding');
    }
  }
  return errors;
}

function validatePlanContractReceipt(projectDir, state, ticket, receipt) {
  if (![PLAN_CONTRACT_VERSION, 2].includes(state.plan_contract_version)) return [];
  const errors = [];
  const candidate = receipt.evidence?.candidate_plan;
  if (['plan', 'plan-replan'].includes(ticket.stage_id)) {
    if (receipt.status === 'passed' && candidate === undefined) {
      errors.push(`a passed planner receipt on a plan_contract_version ${state.plan_contract_version} run requires evidence.candidate_plan`);
    }
    if (candidate !== undefined) {
      if (candidate?.version !== state.plan_contract_version) {
        errors.push(`evidence.candidate_plan.version must equal run plan_contract_version ${state.plan_contract_version}`);
        return errors;
      }
      const parsed = candidatePlanForScope(
        candidate,
        [...(state.claimed_paths ?? []), ...(state.test_paths ?? [])],
        projectDir,
        state.plan_contract_version === 2
          ? {
              preflight_hash: state.preflight?.artifact_hash,
              verification_profiles: (state.preflight?.artifact?.verification_profiles ?? [])
                .map((profile) => ({ id: profile.id, required: profile.disposition === 'required' })),
              require_design_assurance: state.policy?.design_assurance_required === true,
              risk_triggers: state.risk_triggers ?? [],
            }
          : null,
      );
      if (!parsed.valid) errors.push(...parsed.errors);
    }
  } else if (candidate !== undefined) {
    errors.push('evidence.candidate_plan is accepted only on a planner ticket');
  }

  const deviation = validatePlanDeviation(
    receipt.evidence?.plan_deviation,
    ticket.approved_plan,
    [...(ticket.claimed_paths ?? []), ...(ticket.test_paths ?? [])],
  );
  if (!deviation.valid) errors.push(...deviation.errors);
  return errors;
}

export async function recordReceiptLocked(projectDir, raw, normalizedFields = []) {
  // Input-edge coercions are audit-visible: sealed into the fresh receipt's
  // evidence and echoed on the response. Empty for valid input, so existing
  // response shapes and receipt hashes stay byte-identical.
  const normalizationNote =
    normalizedFields.length > 0 ? { normalized_fields: normalizedFields } : {};
  const paths = runtimePaths(projectDir);
  // One tree session for the whole receipt-effects critical section: the
  // admission read below, the validator's independent recompute, ticket
  // issuance, archive, and persist all observe the same tree unless a real
  // effect (red-test execution, gates, auto-merge) invalidates in between.
  // The audit measured 18-22 git spawns per receipt from re-deriving this
  // identical tree 4-6 times under the held lock.
  const tree = treeShaSession(paths.root);
  const state = await activeState(paths);
  if (!state) throw new Error('no active run');
  const ticket = state.tickets.find((entry) => entry.ticket_id === raw.ticket_id);
  if (!ticket) throw new Error('unknown ticket');
  // A ticket the deadline-timeout transition marked expired has been
  // superseded by its retry ticket (or blocked the run): admitting its late
  // receipt would advance the pipeline in parallel with the retry — duplicate
  // stage tickets and double progression. Deadline-aware admission
  // (deadline_overruns) applies only while the runtime has not yet moved on.
  // Tickets are marked expired only while receiptless, so this can never
  // shadow an idempotent retry of a committed receipt.
  if ((state.expired_tickets ?? []).includes(ticket.ticket_id)) {
    return {
      ok: false,
      rejected: true,
      errors: [`ticket ${ticket.ticket_id} expired and was superseded; the retry ticket owns this stage`],
    };
  }
  let agentIdentity = raw.agent?.identity ?? raw.agent_identity ?? ticket.ticket_id;
  const inputHash = receiptInputHash(raw);
  const transactionFile = receiptTransactionPath(paths, ticket.ticket_id);
  const transaction = await readJson(transactionFile, null);
  if (transaction && transaction.input_hash !== inputHash) {
    return {
      ok: false,
      rejected: true,
      errors: ['receipt replay conflicts with the durable ticket transaction'],
    };
  }
  const existingReceipt = state.receipts.find((entry) => entry.ticket_id === ticket.ticket_id);
  let dispatchBinding = null;
  const bindingRequired =
    state.host === 'claude' ||
    (state.host === 'codex' && state.binding_protocol === 'native-v1');
  if (bindingRequired) {
    dispatchBinding = await validateClaudeReceiptBinding(
      paths,
      state,
      ticket,
      raw.receipt_capability,
      inputHash,
    );
    if (
      transaction?.status === 'prepared' &&
      existingReceipt &&
      transaction.receipt?.receipt_id === existingReceipt.receipt_id &&
      transaction.receipt?.receipt_hash === existingReceipt.receipt_hash &&
      (dispatchBinding.valid || dispatchBinding.record)
    ) {
      if (dispatchBinding.record) {
        await completeClaudeReceiptBinding(
          paths,
          ticket,
          dispatchBinding,
          inputHash,
          existingReceipt,
        );
      }
      await atomicWriteJson(transactionFile, {
        ...transaction,
        status: 'committed',
        committed_at: now(),
      });
      return {
        ok: true,
        receipt: existingReceipt,
        run: state,
        actions: [],
        idempotent: true,
        recovered: true,
      };
    }
    if (!dispatchBinding.valid) {
      return {
        ok: false,
        rejected: true,
        errors: [`${state.host} receipt identity or one-time capability has no exact active ticket binding`],
      };
    }
    if (dispatchBinding.retry) {
      const existing = state.receipts.find((entry) =>
        entry.ticket_id === ticket.ticket_id &&
        entry.receipt_id === dispatchBinding.receipt_id &&
        entry.receipt_hash === dispatchBinding.receipt_hash);
      if (!existing) {
        return {
          ok: false,
          rejected: true,
          errors: [`${state.host} receipt retry cannot be recovered from active state`],
        };
      }
      return { ok: true, receipt: existing, run: state, actions: [], idempotent: true };
    }
  } else if (
    transaction &&
    ['prepared', 'committed'].includes(transaction.status) &&
    existingReceipt &&
    transaction.receipt?.receipt_id === existingReceipt.receipt_id &&
    transaction.receipt?.receipt_hash === existingReceipt.receipt_hash
  ) {
    // A prepared transaction is crash recovery (commit was interrupted); a
    // committed one is an identical retry of an already-recorded receipt (for
    // example a lost response after the busy-lock error told the caller to
    // retry). Both must return the recorded receipt idempotently instead of
    // building a fresh receipt that rejects (F15).
    const recovered = transaction.status === 'prepared';
    if (recovered) {
      await atomicWriteJson(transactionFile, {
        ...transaction,
        status: 'committed',
        committed_at: now(),
      });
    }
    return {
      ok: true,
      receipt: existingReceipt,
      run: state,
      actions: [],
      idempotent: true,
      recovered,
    };
  }
  // Reject a receipt against a terminal run before any durable side effect —
  // no receipt file, no state mutation, no transaction — and report the
  // rejection honestly instead of returning ok with it buried in actions
  // (F16). This mirrors the reducer's terminal-status guard; idempotent
  // retries of already-committed receipts are recovered above.
  if (TERMINAL_STATUSES.has(state.status)) {
    return { ok: false, rejected: true, errors: [`run is ${state.status}`] };
  }
  // A valid Claude binding carries the host-attested bound agent id; record it as
  // the receipt identity so completion is truthful rather than a subagent guess.
  if (dispatchBinding?.agent_identity) agentIdentity = dispatchBinding.agent_identity;
  // The host-observed Agent `model` parameter, validated against the ticket's
  // resolved model at launch time. Legacy in-flight intents (recorded before
  // the rename) carried it as launched_model.
  const requestedModelRaw =
    dispatchBinding?.record?.requested_model ?? dispatchBinding?.record?.launched_model ?? null;
  const requestedModel =
    typeof requestedModelRaw === 'string' && requestedModelRaw ? requestedModelRaw : null;
  const previousReceiptHash = state.receipts.at(-1)?.receipt_hash ?? null;
  const headTreeSha = await tree.current();
  const changedFiles = await tree.diff(ticket.base_tree_sha, headTreeSha);
  // Receipt provenance: completed_at is the runtime-observed record time, never
  // agent-reported — T5. The wire value is discarded and re-stamped here, the
  // same way head_tree_sha and agent identity are runtime-stamped rather than
  // wire-trusted. The validator's deadline_overrun_ms reads this field.
  const completedAt = now();
  const startedAt = raw.timing?.started_at ?? ticket.issued_at;
  const toolEffects = await observedExternalToolEffects(paths, state, ticket);
  let receipt = transaction?.status === 'prepared'
    ? transaction.receipt
    : finalizeReceipt({
    schema_version: SCHEMA_VERSION,
    receipt_id: randomUUID(),
    run_id: state.run_id,
    ticket_id: ticket.ticket_id,
    ticket_hash: ticket.ticket_hash,
    agent: {
      host: state.host,
      role: ticket.role,
      identity: agentIdentity,
      // Receipt provenance must never claim an unobserved model (F11). A
      // PreToolUse payload attests the *requested* Agent model parameter, not
      // the model that actually executed — provider availability or safety
      // fallback can substitute. `model` is reserved for an effective model
      // reported by a host lifecycle *result*; no Claude/Codex lifecycle
      // event reports one today, so it stays null rather than overstating.
      model: null,
      model_attested: false,
      requested_model: requestedModel,
      requested_model_attested: requestedModel !== null,
    },
    status: raw.status,
    base_tree_sha: ticket.base_tree_sha,
    head_tree_sha: headTreeSha,
    changed_files: changedFiles,
    tests: raw.tests ?? [],
    findings: raw.findings ?? [],
    ...(toolEffects.length ? { tool_effects: toolEffects } : {}),
    // Runtime-sealed: the normalization note wins over any agent-supplied key
    // of the same name (evidence.red_test precedent), and it survives the
    // red-test re-seal below because that path spreads body.evidence.
    evidence: { ...(raw.evidence ?? {}), ...normalizationNote },
    timing: {
      started_at: startedAt,
      completed_at: completedAt,
      duration_ms: raw.timing?.duration_ms ?? Math.max(0, Date.parse(completedAt) - Date.parse(startedAt)),
    },
    previous_receipt_hash: previousReceiptHash,
  });
  const validation = await validateStageReceipt({
    project_dir: paths.root,
    state,
    ticket,
    receipt,
    tree,
  });
  if (!validation.valid) {
    return { ok: false, rejected: true, errors: validation.errors, ...normalizationNote };
  }
  let preflight = null;
  if (ticket.role === 'preflight_analyst' && receipt.status === 'passed') {
    preflight = validatePreflightArtifact(receipt.evidence?.preflight_artifact, {
      objective: state.objective,
      claims: state.claimed_paths,
      test_paths: state.test_paths,
      profiles: state.verification_profiles ?? [],
      tests: receipt.tests,
    });
    if (!preflight.valid) {
      return { ok: false, rejected: true, errors: preflight.errors, ...normalizationNote };
    }
  }
  // The plan contract is enforced before any receipt/transaction/audit write.
  // Legacy runs omit plan_contract_version and never enter this path.
  const planContractErrors = validatePlanContractReceipt(projectDir, state, ticket, receipt);
  if (planContractErrors.length > 0) {
    return { ok: false, rejected: true, errors: planContractErrors, ...normalizationNote };
  }
  const structuredReviewErrors = validateStructuredReviewReceipt(ticket, receipt);
  if (structuredReviewErrors.length > 0) {
    return { ok: false, rejected: true, errors: structuredReviewErrors, ...normalizationNote };
  }
  const recoveryDeclarationErrors = validateRecoveryDeclarations(ticket, receipt);
  if (recoveryDeclarationErrors.length > 0) {
    return { ok: false, rejected: true, errors: recoveryDeclarationErrors, ...normalizationNote };
  }
  // D3: validate a review-proposed scope expansion BEFORE any durable side
  // effect — a rejected proposal leaves no receipt, no transaction, and no
  // audit line, so the reviewer can re-record a corrected receipt against the
  // same ticket.
  const scopeExpansion = extractScopeExpansion(ticket, receipt);
  if (scopeExpansion.errors.length > 0) {
    return { ok: false, rejected: true, errors: scopeExpansion.errors, ...normalizationNote };
  }
  // Roadmap entry remediation-test-path-role-gap, proven live by
  // run-fixture-0d6308c75933 (archived blocked): a blocking review finding
  // located in an authored TEST path had no remediable route, so that run spent
  // its one remediation cycle and blocked with the correction unlanded. A
  // blocking review now declares the target structurally as
  // `evidence.test_remediation { test_paths, reason }` and pipeline.js routes
  // one extra test_writer stage inside the SAME single remediation cycle.
  //
  // Validated HERE, the same pre-durable site as the scope expansion above and
  // BEFORE loadRuntimeConfig, the red-test observation and the transaction
  // write: a rejected declaration leaves no receipt, no transaction and no audit
  // line, so the reviewer can re-record a corrected receipt against the same
  // ticket. The refusal is loud on purpose — an unreachable finding must fail
  // visibly at review-record time rather than spend the cycle silently.
  //
  // OMISSION RESIDUAL, recorded verbatim: a reviewer who simply OMITS the
  // declaration gets today's behavior and the finding lands unremediated exactly
  // as before.
  const testRemediation = ticket.review_contract_version === REVIEW_CONTRACT_VERSION
    ? { errors: [], test_paths: [], reason: null }
    : extractTestRemediation(ticket, receipt);
  if (testRemediation.errors.length > 0) {
    return { ok: false, rejected: true, errors: testRemediation.errors, ...normalizationNote };
  }
  const config = await loadRuntimeConfig(paths.config);
  // Runtime-owned red-test execution (F12): before any durable side effect,
  // the runtime executes the authored tests and requires an observed failure,
  // then seals the observation into the receipt evidence (hash-bound, and
  // durable via the receipt transaction and receipt file). A prepared
  // transaction is crash recovery of an admission that already observed red
  // against this exact head tree (re-validated above), so it is not re-run —
  // its receipt, observation included, is replayed deterministically. A raw
  // caller cannot forge the observation: for a fresh admission the bound
  // evidence below overwrites whatever the agent self-reported.
  if (
    receipt.status === 'passed' &&
    ticket.required_checks.includes('red-test') &&
    transaction?.status !== 'prepared'
  ) {
    const redTest = await observeRedTest(paths, state, ticket, receipt, config, tree);
    if (!redTest.ok) return { ok: false, rejected: true, errors: redTest.errors };
    // Accumulate the runtime-measured red-test wall clock beside the sealed
    // observation (T14). The prepared-transaction replay path skips this whole
    // block, so a crash-recovered red observation's duration is never
    // accumulated — a conservative undercount, never a double count.
    accumulateTiming(state, 'test_ms', redTest.duration_ms);
    const { receipt_hash: _unsealed, ...body } = receipt;
    receipt = finalizeReceipt({
      ...body,
      evidence: { ...body.evidence, red_test: redTest.observation },
    });
  }
  // An unparseable deadline/completion stamp is recorded like a real overrun
  // (fail closed): the validator can no longer compute lateness, so the honest
  // record is "this stage's deadline could not be evaluated", not silence.
  // Admission is deliberately unchanged — see receipt-validator.js.
  if (validation.deadline_overrun_ms > 0 || validation.deadline_stamp_unparseable) {
    state.deadline_overruns = [
      ...(state.deadline_overruns ?? []),
      {
        ticket_id: ticket.ticket_id,
        stage_id: ticket.stage_id,
        overrun_ms: validation.deadline_overrun_ms,
        ...(validation.deadline_stamp_unparseable
          ? { unparseable: validation.deadline_stamp_unparseable }
          : {}),
      },
    ];
  }
  if (!transaction) {
    await atomicWriteJson(transactionFile, {
      version: 1,
      run_id: state.run_id,
      ticket_id: ticket.ticket_id,
      input_hash: inputHash,
      status: 'prepared',
      prepared_at: now(),
      receipt,
    });
  }
  await atomicWriteJson(path.join(paths.receipts, `${receipt.receipt_id}.json`), receipt);
  state.receipts.push(receipt);
  if (preflight) {
    state.preflight = {
      version: preflight.value.version,
      artifact_hash: preflight.artifact_hash,
      artifact: preflight.value,
      receipt_hash: receipt.receipt_hash,
    };
  }
  // Roadmap entry agent-facing-text-routes-bypassing-the-prose-bound,
  // route (b): RECORDED, not closed, because it is already true today and
  // needs no character screen. `receipt.changed_files` is never the agent's
  // own wire value -- it was overwritten above (:changedFiles, stamped onto
  // `receipt` at construction) with `tree.diff(ticket.base_tree_sha,
  // headTreeSha)`, a RUNTIME-COMPUTED real git diff, before this line ever
  // runs. So the bytes unioned into state.test_paths here, and later copied
  // verbatim onto every subsequent ticket's claims by ticketClaims (above,
  // reads state.test_paths for the test_writer role), can never carry an
  // agent-injected control/bidi byte in the first place -- there is no
  // agent-supplied value on this path left to screen.
  if (ticket.role === 'test_writer') {
    state.test_paths = [...new Set([...state.test_paths, ...receipt.changed_files])];
  }
  const receiptWarnings = [];
  // Loud, not fatal: the deadline record above is the durable half, this is the
  // response-visible one. Pushed HERE rather than beside that record because
  // receiptWarnings is declared on the line above — a push at the record site,
  // some twenty lines earlier, is a TDZ ReferenceError.
  if (validation.deadline_stamp_unparseable) {
    receiptWarnings.push({
      kind: 'unparseable_deadline_stamp',
      ticket_id: ticket.ticket_id,
      stage: ticket.stage_id,
      unparseable: validation.deadline_stamp_unparseable,
      message:
        `stage deadline lateness could not be evaluated: ${validation.deadline_stamp_unparseable} ` +
        'is not a parseable timestamp, so the recorded overrun_ms is 0 and that deadline_overruns ' +
        // prose-bound-exempt: fixed diagnostic template;
        // ${validation.deadline_stamp_unparseable} (above) is the ticket's own
        // runtime-issued deadline_at stamp, never agent-authored free text.
        'entry is marked unparseable rather than measured',
    });
  }
  const rawReceiptRiskTriggers = Array.isArray(receipt.evidence?.risk_triggers)
    ? receipt.evidence.risk_triggers
    : [];
  const receiptRiskTriggers = rawReceiptRiskTriggers
    .filter((value) => typeof value === 'string')
    .map((value) => value.toLowerCase());
  const mergedTriggers = [...new Set([...state.risk_triggers, ...receiptRiskTriggers])];
  const knownRisk = RISK_TRIGGERS.filter((trigger) => mergedTriggers.includes(trigger));
  // Risk-trigger receipt-surfacing hardening: both overrides.ndjson audit
  // appends below run on the FRESH admission path only (`if (!transaction)`,
  // matching the prepared-file write guard above) so a prepared-transaction
  // crash replay of recordReceipt never duplicates an audit line; the returned
  // warnings still fire on both the fresh and the replay path so the response
  // stays truthful either way.
  //
  // Malformed (non-string) entries — numbers, objects, null — cannot name a risk
  // trigger and were filtered out of receiptRiskTriggers above before they could
  // join mergedTriggers, arm high_risk, or hard-fail the run. They must NOT
  // vanish silently either: surface them loudly exactly like an unrecognized
  // string token, carrying a BOUNDED serialization (JSON.stringify, truncated)
  // of the offending entries so a crafted payload can never write an unbounded
  // log line.
  const malformedRiskTriggers = rawReceiptRiskTriggers
    .filter((value) => typeof value !== 'string')
    .map((value) => boundedSerialize(value, MALFORMED_RISK_TRIGGER_MAX));
  if (malformedRiskTriggers.length > 0) {
    const message =
      `receipt evidence.risk_triggers contained ${malformedRiskTriggers.length} non-string ` +
      `entr${malformedRiskTriggers.length === 1 ? 'y' : 'ies'} that cannot name a risk trigger ` +
      `and were ignored: ${malformedRiskTriggers.join(', ')}`;
    receiptWarnings.push({
      kind: 'malformed_risk_triggers',
      ticket_id: ticket.ticket_id,
      stage: ticket.stage_id,
      malformed_risk_triggers: malformedRiskTriggers,
      // prose-bound-exempt: message is built above entirely from
      // malformedRiskTriggers entries that were already passed through
      // boundedSerialize (route (d), roadmap
      // agent-facing-text-routes-bypassing-the-prose-bound); a downstream reuse,
      // not a new sink.
      message,
    });
    if (!transaction) {
      await appendJsonLine(paths.overrideLog, {
        run_id: state.run_id,
        at: now(),
        event: 'malformed_risk_triggers',
        stage: ticket.stage_id,
        ticket_id: ticket.ticket_id,
        malformed_risk_triggers: malformedRiskTriggers,
        // prose-bound-exempt: message is built entirely from
        // malformedRiskTriggers entries already passed through boundedSerialize
        // above; a downstream reuse, not a new sink.
        reason: message,
      });
    }
  }
  // Risk-trigger token hygiene (T9, #251): a receipt must NOT hard-fail the run
  // for naming an unrecognized risk trigger, but the token must not vanish
  // either. Surface every unknown token loudly — as a returned warning AND an
  // overrides.ndjson audit line — instead of letting the knownRisk filter above
  // drop it silently. An unrecognized token never arms high_risk and never
  // joins the persisted canonical set: only knownRisk feeds SCOPE_EXPANDED.
  const unrecognizedReceiptRiskTriggers = [
    ...new Set(receiptRiskTriggers.filter((trigger) => !RISK_TRIGGERS.includes(trigger))),
  ];
  if (unrecognizedReceiptRiskTriggers.length > 0) {
    // Roadmap entry agent-facing-text-routes-bypassing-the-prose-bound
    // (security review): unlike the malformed (non-string) branch above --
    // hardened by route (d)'s boundedSerialize -- an unrecognized STRING
    // token reaches this same warning/audit sink raw and unbounded: it
    // survives the typeof filter that built receiptRiskTriggers above and is
    // only lowercased, so a crafted token can carry a raw control/bidi byte
    // into the operator's terminal and, since assertSafeInput admits 64 KB
    // per field, grow this message and its audit line far past any sane
    // size. `shownTriggers` renders each token through boundedGateSummary
    // (policy 1 above) at MALFORMED_RISK_TRIGGER_MAX -- the cap already
    // established for this exact warning/audit pair immediately above, not a
    // new number -- before it is ever interpolated. `receiptRiskTriggers`
    // itself (and mergedTriggers/knownRisk derived from it above) stays the
    // raw set for every ADMISSION purpose; this rendering feeds nothing but
    // the warning and the audit line below.
    const shownTriggers = unrecognizedReceiptRiskTriggers.map(
      (trigger) => boundedGateSummary(trigger, MALFORMED_RISK_TRIGGER_MAX) ?? '',
    );
    const message =
      `receipt evidence.risk_triggers named unrecognized token(s): ${shownTriggers.join(', ')}; ` +
      `the canonical risk-trigger tokens are: ${RISK_TRIGGERS.join(', ')}`;
    receiptWarnings.push({
      kind: 'unrecognized_risk_triggers',
      ticket_id: ticket.ticket_id,
      stage: ticket.stage_id,
      unknown_risk_triggers: shownTriggers,
      // prose-bound-exempt: message is built above entirely from shownTriggers
      // entries already passed through boundedGateSummary; a downstream reuse,
      // not a new sink.
      message,
    });
    if (!transaction) {
      await appendJsonLine(paths.overrideLog, {
        run_id: state.run_id,
        at: now(),
        event: 'unrecognized_risk_triggers',
        stage: ticket.stage_id,
        ticket_id: ticket.ticket_id,
        unknown_risk_triggers: shownTriggers,
        // prose-bound-exempt: message is built entirely from shownTriggers
        // entries already passed through boundedGateSummary above; a downstream
        // reuse, not a new sink.
        reason: message,
      });
    }
  }
  // friction #33: authored test files are not production scope. state.test_paths was
  // grown by this receipt above when the writer was a test_writer, so the
  // filter sees the just-authored tests too; they stay bounded by test-writer
  // confinement instead of consuming the fast-lane file budget.
  const productionChanges = receipt.changed_files.filter(
    (file) => !withinClaims(file, state.test_paths),
  );
  // D3: the validated review proposal grows the persisted claim set — only
  // paths not already inside a claim, so a directory claim absorbs its files.
  // Observed productionChanges stay OUT of the proposal on purpose: feeding a
  // writer's own unclaimed writes into claimed_paths would launder the
  // boundary violation the validator just enforced.
  const proposedClaims = scopeExpansion.claimed_paths.filter(
    (file) => !withinClaims(file, state.claimed_paths),
  );
  const expansion = escalateLane(state.lane, {
    claimed_paths: [...new Set([...state.claimed_paths, ...productionChanges, ...proposedClaims])],
    // The persisted run-start intent, never reconstructed from mode: a
    // mechanical run must stay mechanical unless its scope really changed (F21).
    behavioral: state.behavioral ?? state.mode !== 'spike',
    risk_triggers: mergedTriggers,
  }, config.policy);
  const newRiskTriggers = knownRisk.some((trigger) => !state.risk_triggers.includes(trigger));
  if (expansion.escalated || newRiskTriggers || proposedClaims.length > 0) {
    // Escalation is dispatched through the reducer so the transition/action
    // architecture — not an ad-hoc write — owns the state change (F23), and so
    // reported risk triggers arm high_risk for security-review and the
    // conditional_audits gate (F8). A scope expansion rides the same event:
    // the reducer audits the added paths, then patches claimed_paths so the
    // remediation ticket issued by the RECEIPT_RECORDED reduction below
    // inherits the expanded allowlist (and lane/risk were re-classified over
    // it just above).
    //
    // SCOPE_EXPANDED receipt atomicity (audit 1.3, invariant 1): the chain's
    // trailing persist_state is DROPPED here so no durable active.json
    // snapshot exists between "receipt recorded" and "actions applied". The
    // receipt was pushed above, so persisting mid-chain would make it durable
    // while the pipeline consequences (successor tickets, group outcome,
    // remediation, gates) do not exist yet; a crash in that window strands the
    // run idle-in-'running' — the client's retry of the identical receipt hits
    // the idempotent-recovery arm, which finds the committed receipt in state
    // and returns empty actions, so the RECEIPT_RECORDED reduction never runs
    // and every exit but abort is gone. The scope patch stays in memory and
    // becomes durable through the RECEIPT_RECORDED chain applied below —
    // every arm of that reduction ends in persist_state — so the FIRST
    // receipt-bearing snapshot already carries both the scope patch and its
    // pipeline consequences, and the recovery arms' "committed receipt implies
    // its actions were applied" assumption holds by construction. The
    // override-class scope-expansion audit line keeps its documented
    // before-the-transition ordering (it is appended by this applyActions).
    //
    // REPLAY IDEMPOTENCY (audit 2026-07-24 item 5): this chain is reached again
    // on a prepared-transaction replay — a crash between the durable transaction
    // write and the first receipt-bearing persist leaves no receipt in
    // active.json, so the retry misses the idempotent-recovery arm above and
    // recomputes this identical expansion. The transition patch MUST keep
    // applying unconditionally (it is what makes the grown claimed_paths
    // durable), so the sibling `if (!transaction)` filter used by the
    // risk-trigger appends is WRONG here: it would leave an override-class claim
    // growth with ZERO audit lines, inverting the audit-before-transition
    // guarantee documented above. Instead the AUDIT action alone is dropped, and
    // only when this exact line is provably already in the log. The guard is
    // exact: transactionFile is per-ticket and a mismatched input_hash was
    // rejected above, so `transaction != null` means "replay of this ticket with
    // this input", and once the transition applies the path is filtered out of
    // proposedClaims, so a same-key line can only be a replay. The reducer stays
    // PURE — the filtering happens here, on its output.
    let scopeActions = reduceRun(state, {
      type: 'SCOPE_EXPANDED',
      // Threaded through so the reducer can record the accepted growth onto
      // state.pending_scope_expansions keyed by the PROPOSING ticket (this
      // review receipt's own ticket) — see scheduler.js's SCOPE_EXPANDED arm
      // and groupScopeExpansion for why the disclosure needs this identity to
      // survive to group-completion time, whichever receipt in the group
      // arrives last.
      ticket_id: ticket.ticket_id,
      scope: {
        lane: expansion.escalated ? expansion.lane : state.lane,
        lane_reasons: expansion.reasons,
        risk_triggers: knownRisk,
        ...(proposedClaims.length > 0
          // The reviewer's reason is neutralized and cut HERE, at the only
          // point it enters the runtime, because the SCOPE_EXPANDED event has
          // three downstream sinks and one of them is durable: the reducer
          // records it onto state.pending_scope_expansions, which is a
          // run-level key that persists and that projectRunState carries onto
          // the ape_run wire; groupScopeExpansion (scheduler.js) joins it with
          // the other members' reasons; and the audit_override line bounds it
          // again at its own sink. Bounding at the entry point rather than at
          // each sink is what lets that join stay per-reason truthful, since
          // scheduler.js cannot import this helper without a cycle.
          // This bounds THIS field only. A proposed PATH's length is still
          // uncapped by extractScopeExpansion, so state.claimed_paths remains
          // an independent unbounded wire vector; nothing here closes that.
          ? {
              claimed_paths: proposedClaims,
              reason: boundedGateSummary(scopeExpansion.reason, SCOPE_EXPANSION_REASON_MAX_CHARS),
            }
          : {}),
      },
    }).filter((entry) => entry.type !== 'persist_state');
    if (transaction) {
      const audit = scopeActions.find(
        (entry) => entry.type === 'audit_override' && entry.operation === 'scope-expansion',
      );
      if (audit && await scopeExpansionAudited(paths.overrideLog, state.run_id, audit.added_paths)) {
        scopeActions = scopeActions.filter((entry) => entry !== audit);
      }
    }
    await applyActions(paths, state, scopeActions, config, tree);
  }
  const stage = stageFromTicket(ticket);
  const event = preflight
    ? {
        type: 'PREFLIGHT_RECORDED',
        ticket,
        receipt,
        stage,
        preflight_hash: preflight.artifact_hash,
        questions: preflight.value.questions,
      }
    : { type: 'RECEIPT_RECORDED', ticket, receipt, stage, next_state: state };
  // Roadmap entry forwarded-evidence-and-judge-visibility: an accepted scope
  // expansion is disclosed onto the ticket it actually grows by scheduler.js's
  // own review-disagreed arm, state-derived from state.pending_scope_expansions
  // the SCOPE_EXPANDED transition above just recorded — never post-processed
  // here. That reads back EVERY member of the completed review group, not
  // only this receipt, so a two-member group's growth is disclosed regardless
  // of which receipt actually completes it (see groupScopeExpansion,
  // scheduler.js).
  let actions = reduceRun(state, event);
  // Land has no writing stage by construction, so the reducer's standard
  // review-disagreement remediation proposal (an implementer ticket) is
  // unsatisfiable there: convert it into an honest block instead of issuing a
  // writer — truthful completion over convenience (friction #32). Review
  // proposals are the only path that can ask for a writable stage on a land
  // run, and the whole list is replaced so the remediation budget stays
  // truthfully unspent.
  if (state.mode === 'land' && actions.some((entry) => entry.type === 'issue_ticket' && entry.stage?.writable === true)) {
    actions = [
      {
        type: 'transition',
        patch: {
          status: 'blocked',
          stage: 'review',
          block_reason: 'review disagreement on a land run cannot be remediated: mode land has no writing stage; revise the diff outside APE and start a new land run',
        },
      },
      { type: 'archive_history', if_absent: true },
      { type: 'release_lock' },
      { type: 'persist_state' },
    ];
  }
  const emitted = await applyActions(paths, state, actions, config, tree);
  if (bindingRequired) {
    await completeClaudeReceiptBinding(paths, ticket, dispatchBinding, inputHash, receipt);
  }
  const prepared = await readJson(transactionFile, null);
  await atomicWriteJson(transactionFile, {
    ...prepared,
    status: 'committed',
    committed_at: now(),
  });
  return {
    ok: true,
    receipt,
    run: state,
    actions: emitted,
    ...normalizationNote,
    ...(receiptWarnings.length > 0 ? { warnings: receiptWarnings } : {}),
  };
}

export async function recordReceipt(projectDir, raw) {
  assertSafeInput(raw);
  const { input, normalized_fields } = normalizeReceiptInput(raw);
  const paths = runtimePaths(projectDir);
  return withReceiptLock(paths, () => recordReceiptLocked(projectDir, input, normalized_fields));
}
