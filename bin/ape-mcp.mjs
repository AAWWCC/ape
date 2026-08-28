#!/usr/bin/env node
import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { createInterface } from 'node:readline';
import {
  abortRun,
  answerPreflight,
  ackNativeBindingProbe,
  compactStatus,
  configAction,
  cleanupAttributedTaskGate,
  executeApeRunTaskOperation,
  expireDispatch,
  historyAction,
  nextRun,
  nativeBindingProbeStatus,
  overrideRun,
  prepareNativeBindingProbe,
  recordReceipt,
  regateRun,
  resumeRun,
  shipRun,
  shouldTaskWrapApeRun,
  startRun,
  statusRun,
} from '../lib/runtime/service.js';
import { previewRun } from '../lib/runtime/lifecycle-service.js';
import {
  acknowledgeTaskUpdate,
  appendTaskGeneration,
  collectExpiredTasks,
  createOperationId,
  createTask,
  getTask,
  isTaskId,
  listOwnedTasks,
  requestTaskCancellation,
} from '../lib/runtime/task-store.js';
import { resolveGovernedRoot } from '../lib/runtime/paths.js';
import { projectHistoryResponse, projectRunResponse } from '../lib/runtime/projection.js';
import { LANES } from '../lib/runtime/constants.js';
import { START_MODES } from '../lib/runtime/schemas.js';
import { TERMINAL_REASON_CODES } from '../lib/runtime/terminal-telemetry.js';

// Plugin manifests pin the launching host on argv. Environment markers are
// inherited process state and can be stale when one host starts inside the
// other's shell, so they are only the compatibility fallback for direct
// developer launches that omit --host.
function configuredMcpHost(argv = process.argv.slice(2)) {
  const index = argv.indexOf('--host');
  if (index === -1) return null;
  const host = argv[index + 1];
  if (host !== 'claude' && host !== 'codex') {
    throw new Error(`APE MCP --host must be 'claude' or 'codex'; got '${host ?? ''}'`);
  }
  return host;
}

const MCP_HOST = configuredMcpHost();
const resolveMcpRoot = (explicitDir = null) => resolveGovernedRoot({ explicitDir, host: MCP_HOST });

const TOOLS = Object.freeze([
  {
    name: 'ape_run',
    description: 'Start and advance the deterministic APE runtime. For a Codex probe, the first call must include host: "codex", explicit_invocation: true, hooks_trusted: true, and subagents_available: true. Codex start is fail-closed until probe, native canary launch, probe-status, and probe-ack prove live child binding; the completed proof is consumed exactly once before Git mutation.',
    inputSchema: {
      type: 'object',
      required: ['action'],
      properties: {
        action: {
          type: 'string',
          enum: ['probe', 'probe-status', 'probe-ack', 'preview', 'start', 'next', 'record', 'answer-preflight', 'status', 'resume', 'regate', 'ship', 'expire-dispatch', 'abort', 'override'],
          description: 'For the initial call of Codex action probe, include host: "codex", explicit_invocation: true, hooks_trusted: true, and subagents_available: true. For action status, send only action and project_dir; never send run_id.',
        },
        project_dir: {
          type: 'string',
          description: 'Exact governed project root.',
        },
        objective: { type: 'string' },
        mode: { type: 'string', enum: [...START_MODES] },
        lane: {
          type: 'string',
          enum: [...LANES],
          description: 'Requested lane; the runtime validates and may escalate with explicit reasons. mechanical: behavioral:false and every claimed path is docs/config/generated — ANY production code path (even a pure deletion) escalates as non-mechanical-scope, because mechanical means "no runtime surface", not "low effort". fast: behavioral, bounded claim set (default ≤6 files), requires test_paths. full: everything else. auto: let the runtime classify.',
        },
        host: { type: 'string', enum: ['claude', 'codex'] },
        claimed_paths: {
          type: 'array',
          items: { type: 'string' },
          description: 'PRODUCTION files the run may write. Never list test files here — tests go in test_paths. Empty means unbounded scope, which forces the full lane.',
        },
        tool_claims: {
          type: 'array',
          items: { type: 'string' },
          description: 'Structured external-tool capabilities in provider:resource:read|write|execute form, for example unity:console:read, blender:scene:execute, or playwright:origin:https://example.com:execute.',
        },
        test_paths: {
          type: 'array',
          items: { type: 'string' },
          description: 'Test files the independent test writer will author (its write allowlist). Required for behavioral lanes (fast/full); leave empty only for mechanical/debug/spike scopes with behavioral:false.',
        },
        requirements: {
          type: 'array',
          items: { type: 'string' },
          description: 'Requirements this run advances. When an id names a live roadmap entry, every transitive roadmap dependency must currently be satisfied and the target must not be stale; ordinary non-roadmap ids remain allowed.',
        },
        completes: {
          type: 'array',
          items: { type: 'string' },
          description: 'Optional on start: the subset of requirements this run FINISHES (not just advances). Must be a subset of requirements. Roadmap prerequisites are rechecked immediately before completed archival; satisfaction is derived only after a declaring run is archived completed.',
        },
        supersedes_run: {
          type: 'string',
          description: 'Optional on start: run_id of an abandoned/blocked run this run supersedes; recorded in the immutable history record so one converged task does not read as repeated failures.',
        },
        auto_merge_authorized: {
          type: 'boolean',
          description: 'Required true on each public start when shipping.auto_merge is enabled. Set it only after the operator explicitly authorizes this run to push, open a pull request, and merge; persistent config alone is not consent.',
        },
        plan_contract_version: {
          type: 'integer',
          enum: [1, 2],
          description: 'Structured planning contract version. New behavioral fast/full phase runs default to 2; explicit 1 retains the legacy planner-first contract.',
        },
        preflight_hash: { type: 'string', pattern: '^[0-9a-fA-F]{64}$' },
        answers: {
          type: 'array',
          items: {
            type: 'object', additionalProperties: false, required: ['id', 'answer'],
            properties: { id: { type: 'string' }, answer: { type: 'string' } },
          },
        },
        risk_triggers: { type: 'array', items: { type: 'string' } },
        behavioral: {
          type: 'boolean',
          description: 'True when the change alters runtime behavior (needs a failing-then-passing test). False for docs/config/generated-only scopes; behavioral:true always escalates a mechanical request.',
        },
        hooks_trusted: { type: 'boolean', description: 'Required true on the initial Codex probe call after the operator has trusted the installed hooks.' },
        subagents_available: { type: 'boolean', description: 'Required true on the initial Codex probe call after confirming native subagents are available.' },
        explicit_invocation: { type: 'boolean', description: 'Required true on the initial Codex probe call and start call only after an explicit operator invocation.' },
        wait_ms: { type: 'number', description: 'Optional on next: best-effort max ms to server-side wait for a run resting in gating/shipping to resolve in one call; clamped to GATE_NEXT_MAX_WAIT_MS (300000); the receipt lock is released between internal polls; a non-number/<=0/omitted value = one poll (unchanged). A gating run that resolves into required-remote-checks shipping stops at shipping_started; call next again (with wait_ms) to drive shipping to merged.' },
        receipt: { type: 'object' },
        probe_id: {
          type: 'string',
          description: 'probe-ack only: the probe id returned by the bound canary agent.',
        },
        probe_capability: {
          type: 'string',
          description: 'probe-ack only: the capability injected at SubagentStart and returned by the canary agent.',
        },
        operation: { type: 'string', enum: ['abort', 'reset'] },
        ticket_id: { type: 'string' },
        reason: { type: 'string' },
        run_id: {
          type: 'string',
          description: 'Optional CONFIRMATION for the abort/override levers only (roadmap id abort-cannot-be-aimed) — never a selector, since at most one run is ever active. Key-absent is unaimed and byte-identical to today. A value matching the active run proceeds exactly as today; one that does not, refuses fail-closed before any effect and names both ids. An explicit null is an INVALID AIM, not an omission, and is refused the same way. Corrupt/schema-invalid active.json and an aimed override reset against an orphaned lock cannot be confirmed and always refuse when aimed — retry without run_id. Sending run_id on any action other than abort/override is rejected before the action runs.',
        },
      },
    },
  },
  {
    name: 'ape_status',
    description: 'Read compact privacy-safe APE run diagnostics with a stable reason code, next safe action, failed deterministic check identifiers, and validated stage timing. Returns no ticket/receipt bodies or sensitive run prose and only roadmap counts; ape_run action status remains the legacy full-status channel.',
    annotations: { readOnlyHint: true },
    inputSchema: {
      type: 'object',
      properties: {
        project_dir: {
          type: 'string',
          description: 'Exact governed project root.',
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'ape_history',
    description:
      'Query, privacy-safely explain with the shared stable diagnostics, aggregate project metrics, or import APE machine history; inspect latest retention maintenance status; explicitly compact redundant old run artifacts with a required audit reason; and drive the runtime-owned roadmap: roadmap-status (derived cold-boot picture), roadmap-register (validated, receipt-provenanced, journaled batch), roadmap-supersede (validated journaled staleness mutation). Explain returns a bounded safe projection rather than the full immutable record. Inputs are bounded at 64 KB.',
    inputSchema: {
      type: 'object',
      required: ['action'],
      properties: {
        action: {
          type: 'string',
          enum: ['query', 'explain', 'metrics', 'import', 'maintenance-status', 'compact-artifacts', 'roadmap-status', 'roadmap-register', 'roadmap-supersede'],
        },
        project_dir: {
          type: 'string',
          description: 'Exact governed project root.',
        },
        run_id: { type: 'string' },
        requirement: { type: 'string' },
        since: { type: 'string', format: 'date-time', description: 'metrics only: inclusive ISO timestamp start of date range filter.' },
        until: { type: 'string', format: 'date-time', description: 'metrics only: inclusive ISO timestamp end of date range filter; must not precede since.' },
        lane: { type: 'string', enum: [...LANES], description: 'metrics only: filter by lane.' },
        mode: { type: 'string', enum: [...START_MODES, 'patch'], description: 'metrics only: filter by current or legacy run mode.' },
        host: { type: 'string', enum: ['claude', 'codex'], description: 'metrics only: filter by host.' },
        status: { type: 'string', enum: ['completed', 'blocked', 'aborted'], description: 'metrics only: filter by terminal run status.' },
        ape_version: { type: 'string', description: 'metrics only: exact APE release-version cohort.' },
        runtime_version: { type: 'integer', minimum: 1, maximum: 1000000, description: 'metrics only: exact runtime-version cohort.' },
        host_plugin_version: { type: 'string', description: 'metrics only: exact host-plugin release-version cohort.' },
        protocol_version: { type: 'string', description: 'metrics only: exact Codex dispatch-protocol cohort.' },
        envelope_version: { type: 'integer', minimum: 1, maximum: 1000000, description: 'metrics only: exact Codex dispatch-envelope cohort.' },
        terminal_reason_taxonomy_version: { type: 'integer', minimum: 1, maximum: 1000000, description: 'metrics only: exact terminal-reason taxonomy cohort.' },
        terminal_reason_code: { type: 'string', enum: [...TERMINAL_REASON_CODES], description: 'metrics only: exact privacy-safe terminal outcome class.' },
        delete_legacy: { type: 'boolean' },
        keep_recent_runs: {
          type: 'integer',
          minimum: 0,
          maximum: 10000,
          description: 'compact-artifacts only: retain at least this many newest immutable runs in directly addressable artifact directories (default 32).',
        },
        max_runs: {
          type: 'integer',
          minimum: 1,
          maximum: 256,
          description: 'compact-artifacts only: maximum successful run compactions in this bounded sweep (default 64).',
        },
        // roadmap-register: a batch (≤64) of plan entries. Each entry is written
        // for a cold reader — id, title, description, acceptance, optional
        // depends_on and discovered_by (a run id, else defaults to 'operator').
        // Never supply a status: status is derived, never stored.
        entries: {
          type: 'array',
          maxItems: 64,
          items: {
            type: 'object',
            additionalProperties: false,
            required: ['id', 'title', 'description', 'acceptance'],
            properties: {
              id: { type: 'string', minLength: 1, maxLength: 128 },
              title: { type: 'string', minLength: 1, maxLength: 200 },
              description: { type: 'string', minLength: 1, maxLength: 4000 },
              acceptance: { type: 'string', minLength: 1, maxLength: 2000 },
              depends_on: { type: 'array', maxItems: 32, items: { type: 'string', minLength: 1, maxLength: 128 } },
              discovered_by: { type: 'string', minLength: 1, maxLength: 128, description: "Omit for operator provenance. A non-operator run id is accepted only when that active or archived run contains an accepted receipt with an exact normalized evidence.roadmap_followups declaration." },
            },
          },
        },
        // roadmap-supersede: the entry ids to mark stale, plus optional
        // replacement ids. reason is required for register, supersede, and
        // the explicit compact-artifacts maintenance action.
        ids: { type: 'array', maxItems: 64, items: { type: 'string', minLength: 1, maxLength: 128 } },
        replaced_by: { type: 'array', maxItems: 32, items: { type: 'string', minLength: 1, maxLength: 128 } },
        reason: {
          type: 'string',
          description: 'Required non-empty audit reason for compact-artifacts, roadmap-register, and roadmap-supersede.',
        },
        status_filter: {
          type: 'array',
          items: { type: 'string', enum: ['satisfied', 'in_progress', 'ready', 'pending', 'stale'] },
          description: 'roadmap-status only: return only entries whose derived status is in this list. Omit for all entries.',
        },
      },
    },
  },
  {
    name: 'ape_config',
    description: 'Read, update, diagnose, wire the host statusline for, or init (onboard a foreign repo with grounded gate commands) APE runtime configuration.',
    inputSchema: {
      type: 'object',
      required: ['action'],
      properties: {
        action: { type: 'string', enum: ['get', 'set', 'doctor', 'wire', 'unwire', 'init'] },
        project_dir: {
          type: 'string',
          description: 'Exact governed project root.',
        },
        key: { type: 'string' },
        value: {},
        apply: { type: 'boolean' },
        values: { type: 'object' },
        host: { type: 'string', enum: ['claude', 'codex'] },
        hooks_trusted: { type: 'boolean' },
        subagents_available: { type: 'boolean' },
        explicit_invocation: { type: 'boolean' },
        behavioral: { type: 'boolean' },
        test_paths: { type: 'array', items: { type: 'string' } },
      },
    },
  },
]);

// MCP 2026-07-28 made the protocol stateless: the initialize handshake is gone
// and every request declares its protocol version in `params._meta`. This
// server is dual-era in the spec's own terms — MODERN is 2026-07-28 and later,
// LEGACY is anything earlier, and the retained initialize/ping handlers
// genuinely implement 2025-06-18 — so the two revisions form ONE declared
// supported set, newest first. That single set answers `server/discover` and is
// what an unsupported-version refusal offers, so no surface can point a client
// at a version another surface denies. The retained handshake is narrower: it
// can only ever answer the set's LEGACY member, because 2026-07-28 carries no
// `initialize` for a client to continue the conversation with.
const LATEST_PROTOCOL_VERSION = '2026-07-28';
const LEGACY_PROTOCOL_VERSION = '2025-06-18';
const SUPPORTED_PROTOCOL_VERSIONS = Object.freeze([
  LATEST_PROTOCOL_VERSION,
  LEGACY_PROTOCOL_VERSION,
]);
// Per-request `_meta` keys, and the error code for a version this server does
// not implement (UnsupportedProtocolVersionError, renumbered -32004 → -32022 by
// the 2026-07-28 error-code allocation policy).
const PROTOCOL_VERSION_META = 'io.modelcontextprotocol/protocolVersion';
const SERVER_INFO_META = 'io.modelcontextprotocol/serverInfo';
const CLIENT_CAPABILITIES_META = 'io.modelcontextprotocol/clientCapabilities';
const TASKS_EXTENSION = 'io.modelcontextprotocol/tasks';
const MISSING_REQUIRED_CLIENT_CAPABILITY_ERROR = -32003;
const UNSUPPORTED_PROTOCOL_VERSION_ERROR = -32022;
// Caching hints for the CacheableResult operations. The obligation is stated per
// OPERATION, not per field — "Servers MUST include caching hints on results with
// resultType: "complete" returned by the following operations: server/discover,
// tools/list, prompts/list, resources/list, resources/templates/list,
// resources/read" — and this server implements the first two, so ONE constructor
// stamps both (audit: server/discover shipped hintless because tools/list was
// fixed field-by-field instead of by operation class).
// Both results are process constants — a frozen tool literal, and a frozen
// version set plus identity read from package.json — so neither can change
// without restarting the server and an hour of freshness is honest. The scope is
// `public` because both are identical for every caller and carry nothing
// caller-scoped or governed-root specific that a shared intermediary could leak.
const CACHEABLE_RESULT_TTL_MS = 3_600_000;
const CACHEABLE_RESULT_CACHE_SCOPE = 'public';

function packageInfo() {
  try {
    const file = fileURLToPath(new URL('../package.json', import.meta.url));
    const pkg = JSON.parse(readFileSync(file, 'utf8'));
    return { name: 'ape', version: pkg.version };
  } catch {
    return { name: 'ape', version: '2.23.52' };
  }
}

function result(id, value) {
  return { jsonrpc: '2.0', id, result: value };
}

// Every 2026-07-28 result carries a required `resultType`; `complete` is the
// ordinary kind (`input_required` belongs to the MRTR pattern, which this
// server does not use). Stamped on the modern surface only — server/discover,
// tools/list, tools/call — because the retained initialize/ping results exist
// solely for pre-2026-07-28 clients and must stay exactly what they expect
// (`ping` in particular answers the bare empty object). A client on an
// earlier revision reads an omitted field as `complete` anyway.
function completeResult(id, value) {
  return result(id, { resultType: 'complete', ...value });
}

// A cacheable ordinary result: every operation on the CacheableResult list gets
// its hints from here, so a third one cannot be added with them half-applied.
// Built on completeResult because the MUST is scoped to `resultType: "complete"`
// — an interim `input_required` result is explicitly not cacheable and carries
// no hints — so the hints are unreachable except through the complete kind.
function cacheableResult(id, value) {
  return completeResult(id, {
    ...value,
    ttlMs: CACHEABLE_RESULT_TTL_MS,
    cacheScope: CACHEABLE_RESULT_CACHE_SCOPE,
  });
}

function error(id, code, message, data) {
  return {
    jsonrpc: '2.0',
    id,
    error: { code, message, ...(data !== undefined ? { data } : {}) },
  };
}

// The protocol version the request declares (2026-07-28 and later). Absence is
// NOT a mismatch: a pre-2026-07-28 client declares nothing and must keep being
// served, so only a DECLARED version the server does not implement is refused.
function protocolVersionRefusal(message) {
  if (message === null || typeof message !== 'object') return null;
  // A notification draws no response frame at all, refusal included.
  if (!Object.hasOwn(message, 'id')) return null;
  // server/discover is exempt by design: it is how a client LEARNS the
  // supported set (and is the STDIO backward-compatibility probe), so refusing
  // it over a version would send the client round in circles.
  if (message.method === 'server/discover') return null;
  const requested = message.params?._meta?.[PROTOCOL_VERSION_META];
  if (requested === undefined || requested === null) return null;
  if (SUPPORTED_PROTOCOL_VERSIONS.includes(requested)) return null;
  // The refusal MUST list the versions the server does support: the client's
  // documented recovery is to pick a mutual one off `data.supported` and
  // re-issue as a new request.
  return error(
    message.id,
    UNSUPPORTED_PROTOCOL_VERSION_ERROR,
    `unsupported protocol version: ${requested}`,
    { requested, supported: [...SUPPORTED_PROTOCOL_VERSIONS] },
  );
}

function declaresModernProtocol(message) {
  return message?.params?._meta?.[PROTOCOL_VERSION_META] === LATEST_PROTOCOL_VERSION;
}

function declaresTasksCapability(message) {
  const extensions = message?.params?._meta?.[CLIENT_CAPABILITIES_META]?.extensions;
  if (extensions === null || typeof extensions !== 'object') return false;
  const declaration = extensions[TASKS_EXTENSION];
  return declaration !== null && typeof declaration === 'object' && !Array.isArray(declaration);
}

function missingTasksCapability(id) {
  return error(id, MISSING_REQUIRED_CLIENT_CAPABILITY_ERROR, 'Missing required client capability', {
    requiredCapabilities: { extensions: { [TASKS_EXTENSION]: {} } },
  });
}

function taskWireProjection(task) {
  const projected = {
    taskId: task.taskId,
    status: task.status,
    createdAt: task.createdAt,
    lastUpdatedAt: task.lastUpdatedAt,
    ttlMs: task.ttlMs,
  };
  for (const key of ['statusMessage', 'pollIntervalMs', 'inputRequests', 'result', 'error']) {
    if (task[key] !== undefined && task[key] !== null) projected[key] = task[key];
  }
  return projected;
}

async function dispatchApeRun(projectDir, input) {
  const action = input.action;
  if (action === 'answer-preflight') {
    return projectRunResponse(await answerPreflight(projectDir, {
      ...(input.run_id !== undefined ? { run_id: input.run_id } : {}),
      reason: input.reason,
      preflight_hash: input.preflight_hash,
      answers: input.answers,
      ...(input.claimed_paths !== undefined ? { claimed_paths: input.claimed_paths } : {}),
      ...(input.test_paths !== undefined ? { test_paths: input.test_paths } : {}),
      ...(input.risk_triggers !== undefined ? { risk_triggers: input.risk_triggers } : {}),
    }));
  }
  // Misroute guard (C4, roadmap id abort-cannot-be-aimed): run_id confirms
  // the abort/override levers only. Every arm below (start, next, record,
  // status, resume, regate, ship, expire-dispatch) RETURNS from inside its
  // own branch, all of them ahead of abort's own operation guard — so a
  // run_id guard placed where that operation guard sits would be dead code
  // for every action it exists to protect. It must PRECEDE the whole arm
  // chain instead. Silently dropping run_id on an unrelated action would sell
  // unchecked aiming to start/regate/ship while doing nothing. Keyed on
  // `!== undefined` so an explicit `run_id: null` on start/next also throws,
  // consistent with the decided null semantics (null is never an omission).
  if (input.run_id !== undefined && action !== 'abort' && action !== 'override') {
    throw new Error(`action '${action}' does not take a run_id; run_id is a confirmation for actions 'abort'/'override' only, sent to action '${action}'`);
  }
  if (action === 'probe') {
    return prepareNativeBindingProbe(projectDir, {
      host: input.host,
      hooks_trusted: input.hooks_trusted ?? false,
      subagents_available: input.subagents_available ?? false,
      explicit_invocation: input.explicit_invocation ?? false,
    });
  }
  if (action === 'probe-status') return nativeBindingProbeStatus(projectDir);
  if (action === 'probe-ack') {
    return ackNativeBindingProbe(projectDir, {
      probe_id: input.probe_id,
      probe_capability: input.probe_capability,
    });
  }
  if (action === 'preview') {
    return previewRun(projectDir, {
      objective: input.objective,
      mode: input.mode ?? 'phase',
      lane: input.lane ?? 'auto',
      host: input.host,
      claimed_paths: input.claimed_paths ?? [],
      tool_claims: input.tool_claims ?? [],
      test_paths: input.test_paths ?? [],
      requirements: input.requirements ?? [],
      ...(input.completes !== undefined ? { completes: input.completes } : {}),
      ...(input.supersedes_run !== undefined ? { supersedes_run: input.supersedes_run } : {}),
      ...(input.auto_merge_authorized !== undefined ? { auto_merge_authorized: input.auto_merge_authorized } : {}),
      plan_contract_version: input.plan_contract_version ?? (
        (input.mode ?? 'phase') === 'phase' &&
        (input.behavioral ?? true) === true
          ? 2
          : 1
      ),
      risk_triggers: input.risk_triggers ?? [],
      behavioral: input.behavioral ?? true,
      hooks_trusted: input.hooks_trusted ?? false,
      subagents_available: input.subagents_available ?? false,
      explicit_invocation: input.explicit_invocation ?? false,
    });
  }
  if (action === 'start') {
    return startRun(projectDir, {
      objective: input.objective,
      mode: input.mode ?? 'phase',
      lane: input.lane ?? 'auto',
      host: input.host,
      claimed_paths: input.claimed_paths ?? [],
      tool_claims: input.tool_claims ?? [],
      test_paths: input.test_paths ?? [],
      requirements: input.requirements ?? [],
      // Strict start schema: forward the optional advances-vs-completes subset
      // and the cross-run supersession marker only when the caller sent them.
      ...(input.completes !== undefined ? { completes: input.completes } : {}),
      ...(input.supersedes_run !== undefined ? { supersedes_run: input.supersedes_run } : {}),
      ...(input.auto_merge_authorized !== undefined ? { auto_merge_authorized: input.auto_merge_authorized } : {}),
      plan_contract_version: input.plan_contract_version ?? (
        (input.mode ?? 'phase') === 'phase' &&
        (input.behavioral ?? true) === true
          ? 2
          : 1
      ),
      risk_triggers: input.risk_triggers ?? [],
      behavioral: input.behavioral ?? true,
      hooks_trusted: input.hooks_trusted ?? false,
      subagents_available: input.subagents_available ?? false,
      explicit_invocation: input.explicit_invocation ?? false,
      binding_protocol: 'native-v1',
      // Codex must prove the live host actually delivers APE's launch and
      // child-binding lifecycle before a real run may mutate Git or state.
      // Claude uses its separately attested native binding path.
      ...(input.host === 'codex' ? { binding_probe: 'required-v1' } : {}),
    });
  }
  if (action === 'next') return nextRun(projectDir, { wait_ms: input.wait_ms });
  if (action === 'record') return recordReceipt(projectDir, input.receipt ?? {});
  if (action === 'status') return statusRun(projectDir);
  if (action === 'resume') return resumeRun(projectDir);
  if (action === 'regate') return regateRun(projectDir);
  if (action === 'ship') return shipRun(projectDir, input.reason);
  if (action === 'expire-dispatch') return expireDispatch(projectDir, input.ticket_id, input.reason);
  if (action === 'abort') {
    // operation is override's parameter; silently dropping it would misroute a
    // requested reset into a bare abort (or worse, a no-op the caller trusts).
    if (input.operation !== undefined) {
      throw new Error(`action 'abort' does not take an operation; operation '${input.operation}' belongs to action 'override' — send {"action":"override","operation":"${input.operation}","reason":"..."}`);
    }
    return abortRun(projectDir, input.reason, input.run_id);
  }
  if (action === 'override') return overrideRun(projectDir, input.operation, input.reason, input.run_id);
  throw new Error(`unknown tool or action: ape_run/${action ?? ''}`);
}

async function callTool(name, input) {
  // Shared resolver with the hook and statusline: an explicit project_dir
  // outranks the host env pin, and both SEED the walk up to the nearest
  // `.ape/` marker (with no hint the walk starts at the server's cwd) — so a
  // server launched from, or pinned to, a subdirectory still addresses the
  // same runtime root the policy hook governs.
  const projectDir = resolveMcpRoot(input.project_dir);
  if (name === 'ape_run') {
    // Every ape_run result crosses the wire through the bounded projection
    // exactly once (friction #26); the internal service result stays full.
    return projectRunResponse(await dispatchApeRun(projectDir, input));
  }
  if (name === 'ape_status') return compactStatus(projectDir);
  if (name === 'ape_history') {
    // Bulk listings cross the wire summarized (same bound as ape_run);
    // explain stays the full-record channel and import passes through.
    return projectHistoryResponse(await historyAction(projectDir, input.action, input));
  }
  if (name === 'ape_config') {
    return configAction(projectDir, input.action, input);
  }
  throw new Error(`unknown tool or action: ${name}/${input.action ?? ''}`);
}

const PROGRESS_INTERVAL_MS = 10_000;
const TASK_OWNER = Object.freeze({
  processId: process.pid,
  processStartedAt: new Date().toISOString(),
  instanceId: randomUUID(),
});
const runningTasks = new Map();
const ownedTaskRoots = new Set();

// record/gate actions run the configured full suite in-process, bounded only
// by deadlines_ms[lane]; without heartbeats a host cannot distinguish a long
// gate from a hang. When the request carries params._meta.progressToken (MCP
// base-protocol progress — no server capability flag exists for it), emit a
// notifications/progress line every interval. clearInterval runs in `finally`,
// synchronously before the caller can write the response, so no notification
// ever follows the result — on success or error — and a call without a token
// emits nothing.
export async function withProgressHeartbeat(progressToken, label, work, options = {}) {
  if (progressToken === undefined || progressToken === null) return work();
  const intervalMs = options.intervalMs ?? PROGRESS_INTERVAL_MS;
  const writeLine = options.writeLine ?? ((payload) => process.stdout.write(`${JSON.stringify(payload)}\n`));
  const startedAt = Date.now();
  const timer = setInterval(() => {
    const seconds = Math.round((Date.now() - startedAt) / 1000);
    writeLine({
      jsonrpc: '2.0',
      method: 'notifications/progress',
      params: { progressToken, progress: seconds, message: `${label} in progress (${seconds}s)` },
    });
  }, intervalMs);
  timer.unref?.();
  try {
    return await work();
  } finally {
    clearInterval(timer);
  }
}

// The tool-execution plane: everything a tools/call does once dequeued.
// Never rejects — tool faults become isError results so a failed call can
// never poison the FIFO chain behind it.
async function executeToolPayload(name, args) {
  if (!TOOLS.some((tool) => tool.name === name)) {
    return {
      resultType: 'complete',
      isError: true,
      content: [{ type: 'text', text: `unknown tool: ${name}` }],
    };
  }
  try {
    const value = await callTool(name, args);
    return {
      resultType: 'complete',
      ...(value?.ok === false ? { isError: true } : {}),
      content: [{ type: 'text', text: JSON.stringify(value) }],
    };
  } catch (cause) {
    // An isError tool result is still an ORDINARY result: a tool fault is not
    // the MRTR interim kind, so it too carries resultType `complete`.
    return {
      resultType: 'complete',
      isError: true,
      content: [{ type: 'text', text: cause?.message ?? String(cause) }],
    };
  }
}

function apeRunPayloadFromServiceValue(value) {
  if (value?.task_tool_error !== undefined) {
    return {
      resultType: 'complete',
      isError: true,
      content: [{ type: 'text', text: value.task_tool_error }],
    };
  }
  return {
    resultType: 'complete',
    ...(value?.ok === false ? { isError: true } : {}),
    content: [{ type: 'text', text: JSON.stringify(projectRunResponse(value)) }],
  };
}

function gateAttribution(before, after) {
  const beforeWatch = before?.run?.gates_watch;
  const afterWatch = after?.run?.gates_watch;
  if (!afterWatch || afterWatch === beforeWatch) return null;
  if (beforeWatch && beforeWatch.pid === afterWatch.pid && beforeWatch.nonce === afterWatch.nonce) return null;
  return { runId: after.run.run_id, watch: afterWatch };
}

async function settleCancelledTask(projectDir, task, attribution = null, reason = 'task cancellation requested') {
  if (attribution) await cleanupAttributedTaskGate(projectDir, attribution).catch(() => {});
  return appendTaskGeneration(projectDir, task.taskId, {
    allowedStatuses: ['working', 'input_required'],
    status: 'cancelled',
    statusMessage: reason,
  }).catch(() => getTask(projectDir, task.taskId));
}

async function runCreatedTask(projectDir, task, name, args) {
  let attribution = null;
  const runtime = runningTasks.get(task.taskId);
  try {
    const initial = await getTask(projectDir, task.taskId);
    if (!initial) return;
    if (initial.cancellation || runtime?.cancelRequested) {
      const requested = await (runtime?.cancellationPromise ?? Promise.resolve(initial));
      // Cross the service lock before publishing cancellation. This waits out
      // any already-entered effect and gives it a chance to persist an exact
      // gate watch that can be attributed and cleaned; the empty attribution
      // itself never authorizes a signal.
      await settleCancelledTask(projectDir, requested ?? initial, {});
      return;
    }
    const before = await statusRun(projectDir).catch(() => null);
    if (runtime) runtime.before = before;
    // A cancellation handler sets cancelRequested synchronously before its
    // first durable-write await. Re-check after the status read so cancellation
    // cannot land in that window and still let an expensive effect begin.
    if (runtime?.cancelRequested) {
      const requested = await runtime.cancellationPromise;
      await settleCancelledTask(projectDir, requested ?? initial, null);
      return;
    }
    const serviceValue = await executeApeRunTaskOperation(projectDir, {
      operationId: task.operationId,
      action: task.action,
      request: args,
      expectedRunId: runtime?.expectedRunId ?? null,
      preflightRefusal: runtime?.preflightRefusal ?? null,
      isCancelled: () => runtime?.cancelRequested === true,
    });
    const payload = apeRunPayloadFromServiceValue(serviceValue);
    const after = await statusRun(projectDir).catch(() => null);
    attribution = gateAttribution(before, after);
    if (runtime) runtime.attribution = attribution;
    if (runtime?.cancelRequested) {
      const requested = await runtime.cancellationPromise;
      if (requested) await settleCancelledTask(projectDir, requested, attribution);
      return;
    }
    const latest = await getTask(projectDir, task.taskId);
    if (!latest) return;
    if (latest.cancellation) {
      await settleCancelledTask(projectDir, latest, attribution);
      return;
    }
    await appendTaskGeneration(projectDir, task.taskId, {
      expectedGeneration: latest.generation,
      allowedStatuses: ['working', 'input_required'],
      status: 'completed',
      // Exact underlying CallToolResult, including resultType and isError.
      result: payload,
      statusMessage: payload.isError ? 'tool execution completed with an error result' : 'tool execution completed',
    });
  } catch (cause) {
    if (runtime?.cancelRequested) {
      const requested = await runtime.cancellationPromise;
      if (requested) await settleCancelledTask(projectDir, requested, attribution);
      return;
    }
    const latest = await getTask(projectDir, task.taskId).catch(() => null);
    if (!latest) return;
    if (latest.cancellation) {
      await settleCancelledTask(projectDir, latest, attribution);
      return;
    }
    // A JSON-RPC execution error is not a successful tool result. Preserve its
    // error object verbatim and expose it through the failed task variant.
    const rpcError = cause?.jsonRpcError ?? {
      code: -32603,
      message: cause?.message ?? String(cause),
    };
    await appendTaskGeneration(projectDir, task.taskId, {
      expectedGeneration: latest.generation,
      allowedStatuses: ['working', 'input_required'],
      status: 'failed',
      error: rpcError,
      statusMessage: rpcError.message,
    }).catch(() => {});
  } finally {
    runningTasks.delete(task.taskId);
  }
}

async function cancelRunningTask(projectDir, task, running, reason) {
  let attribution = running?.attribution ?? null;
  if (!attribution && running?.before) {
    const current = await statusRun(projectDir).catch(() => null);
    attribution = gateAttribution(running.before, current);
    if (attribution) running.attribution = attribution;
  }
  if (!attribution) {
    // Wait behind any already-entered service effect, then re-read the exact
    // persisted watch. This catches a gate created while cancellation was
    // waiting without ever authorizing a signal from pid alone.
    await cleanupAttributedTaskGate(projectDir, {}).catch(() => {});
    const current = await statusRun(projectDir).catch(() => null);
    attribution = gateAttribution(running?.before, current);
    if (attribution && running) running.attribution = attribution;
  }
  return settleCancelledTask(projectDir, task, attribution, reason);
}

async function createToolTask(message, projectDir, name, args) {
  const activeBeforeCreation = await statusRun(projectDir).catch(() => null);
  // Opportunistic bounded collection keeps both terminal and abandoned task
  // journals from accumulating merely because clients never poll them again.
  await collectExpiredTasks(projectDir, { limit: 100 });
  const task = await createTask(projectDir, {
    operationId: createOperationId(),
    action: args.action,
    request: args,
    owner: TASK_OWNER,
    statusMessage: `${name} ${args.action ?? ''}`.trim(),
  });
  ownedTaskRoots.add(projectDir);
  let begin;
  const promise = new Promise((resolve) => { begin = resolve; });
  const running = {
    promise,
    projectDir,
    task,
    resolve: begin,
    started: false,
    timer: null,
    expectedRunId: activeBeforeCreation?.run?.run_id ?? null,
    preflightRefusal: activeBeforeCreation?.ok === false && activeBeforeCreation?.corrupt_state
      ? activeBeforeCreation
      : null,
    cancelRequested: false,
    cancellationPromise: null,
  };
  runningTasks.set(task.taskId, running);
  const execute = async () => {
    running.started = true;
    if (!existsSync(path.join(projectDir, '.ape'))) {
      runningTasks.delete(task.taskId);
      begin();
      return;
    }
    await runCreatedTask(projectDir, task, name, args);
    begin();
  };
  if (activeBeforeCreation?.run) {
    // An existing run may create a gate immediately; begin after ownership is
    // registered so cancellation can always find the runner context.
    queueMicrotask(execute);
  } else {
    // A no-run lever is only an immediate refusal. Defer it one timer turn so
    // EOF can durably cancel first and temporary-root embeddings can dispose
    // the root without a late writer recreating it.
    running.timer = setTimeout(execute, 0);
  }
  return result(message.id, { resultType: 'task', ...taskWireProjection(task) });
}

export async function shutdownOwnedTasks(reason = 'MCP server shutdown requested') {
  // Phase one is intentionally global and effect-free: persist cancellation
  // on every in-memory owned task before waiting on any receipt lock or gate
  // cleanup. One slow task can therefore never let a later task settle first.
  const live = [...runningTasks.values()];
  const requestedLive = [];
  for (const running of live) {
    running.cancelRequested = true;
    running.cancellationPromise = requestTaskCancellation(running.projectDir, running.task.taskId, {
      requester: TASK_OWNER,
      reason,
    }).catch(() => null);
    const requested = await running.cancellationPromise;
    if (requested) requestedLive.push({ running, requested });
  }
  // Phase two performs attributable cleanup for runners far enough along to
  // have a before-state. Deferred runners observe the cancellation at their
  // first checkpoint and cross the service-lock barrier there.
  for (const { running, requested } of requestedLive) {
    if (running.attribution || running.before) {
      await cancelRunningTask(running.projectDir, requested, running, reason);
    } else if (!running.started) {
      clearTimeout(running.timer);
      // Keep the request observably working+cancellation until the cleanup
      // turn, then publish cancelled and resolve shutdown. This mirrors an
      // already-running task's cooperative two-phase ordering.
      running.timer = setTimeout(async () => {
        await settleCancelledTask(running.projectDir, requested, {}, reason);
        runningTasks.delete(requested.taskId);
        running.resolve?.();
      }, 0);
    }
  }
  // Recover process-owned tasks whose in-memory runner already disappeared.
  for (const projectDir of ownedTaskRoots) {
    const tasks = await listOwnedTasks(projectDir, TASK_OWNER).catch(() => []);
    for (const task of tasks) {
      if (!['working', 'input_required'].includes(task.status)) continue;
      if (runningTasks.has(task.taskId)) continue;
      const requested = await requestTaskCancellation(projectDir, task.taskId, {
        requester: TASK_OWNER,
        reason,
      }).catch(() => null);
      if (requested) {
        await settleCancelledTask(projectDir, requested, null, reason);
      }
    }
  }
  await Promise.allSettled([...runningTasks.values()].map((entry) => entry.promise));
}

// The tool-execution plane: everything a tools/call does once dequeued.
// Never rejects — tool faults become isError results so a failed call can
// never poison the FIFO chain behind it.
export async function executeToolCall(message) {
  const name = message.params?.name;
  const args = message.params?.arguments ?? {};
  if (name === 'ape_run' && declaresModernProtocol(message)) {
    const projectDir = resolveMcpRoot(args.project_dir);
    if (await shouldTaskWrapApeRun(projectDir, args)) {
      if (declaresTasksCapability(message)) return createToolTask(message, projectDir, name, args);
    }
  }
  return result(message.id, await executeToolPayload(name, args));
}

// The protocol plane: everything the server must keep answering even while a
// tool call runs a multi-minute gate suite. main() routes id-bearing
// tools/call messages onto the FIFO queue before consulting this handler, so
// the tools/call arm here only serves direct callers (tests, embedding).
export async function handle(message) {
  if (!Object.hasOwn(message, 'id')) return null;
  // Negotiation first: a declared version this server does not implement is a
  // protocol error, answered before any method runs. (main() applies the same
  // gate ahead of the tool-call queue, so a mismatched tools/call never
  // executes; this arm covers direct callers.)
  const refusal = protocolVersionRefusal(message);
  if (refusal) return refusal;
  // `ping` was REMOVED by 2026-07-28 along with every obligation to answer it,
  // so nothing here rests on a live MUST. The handler stays regardless: it is
  // harmless backward compatibility for pre-2026-07-28 clients, which do use it
  // as a liveness probe during long gate runs and may drop a server that
  // answers -32601. Its result stays the bare empty object those clients
  // expect, which is also why `resultType` is not stamped on it.
  if (message.method === 'ping') return result(message.id, {});
  if (message.method === 'initialize') {
    // Retained for the same reason as the ping handler above: 2026-07-28
    // deleted this handshake, and pre-2026-07-28 clients still open with it.
    // It no longer ECHOES the requested version, which was the defect: it
    // answers the one LEGACY revision this server implements, whatever it was
    // asked for. Both 2025-06-18 lifecycle rules land on that single value —
    // "if the server supports the requested protocol version, it MUST respond
    // with the same version" (satisfied whenever the request IS 2025-06-18) and
    // otherwise "respond with another protocol version it supports", the latest
    // being 2025-06-18 among the revisions this handshake can carry.
    // The modern revision is deliberately NOT offered here even though the
    // server implements it: 2026-07-28 has no `initialize` at all, and its
    // versioning page scopes this route to the legacy era — "an initialize
    // request selects legacy semantics […] as specified by the negotiated
    // legacy protocol version". Naming 2026-07-28 to a client that speaks only
    // the handshake would name a revision it cannot speak, and 2025-06-18
    // lifecycle then has it disconnect ("if the client does not support the
    // version in the server's response, it SHOULD disconnect") — worse than the
    // echo, not better. A modern client is served by `_meta` negotiation and
    // `server/discover`, which advertise the whole set.
    return result(message.id, {
      protocolVersion: LEGACY_PROTOCOL_VERSION,
      capabilities: { tools: {} },
      serverInfo: packageInfo(),
    });
  }
  if (message.method === 'server/discover') {
    // Newly a MUST, and the replacement for the deleted handshake: the whole
    // supported set, the server capabilities, and identity in the result
    // `_meta` under the well-known serverInfo key. It heads the CacheableResult
    // operation list, so it is built by the cacheable constructor.
    return cacheableResult(message.id, {
      supportedVersions: [...SUPPORTED_PROTOCOL_VERSIONS],
      capabilities: { tools: {}, extensions: { [TASKS_EXTENSION]: {} } },
      _meta: { [SERVER_INFO_META]: packageInfo() },
    });
  }
  if (message.method === 'tools/list') {
    return cacheableResult(message.id, { tools: TOOLS });
  }
  if (message.method === 'tools/call') return executeToolCall(message);
  if (['tasks/get', 'tasks/update', 'tasks/cancel'].includes(message.method)) {
    if (!declaresModernProtocol(message)) {
      return error(message.id, -32601, `method not found: ${message.method}`);
    }
    // Capabilities are per request in the stateless protocol. A declaration on
    // the original tools/call never authorizes a later task operation.
    if (!declaresTasksCapability(message)) return missingTasksCapability(message.id);
    const projectDir = resolveMcpRoot(message.params?.project_dir);
    const taskId = message.params?.taskId;
    if (!isTaskId(taskId)) return error(message.id, -32602, 'invalid taskId');
    await collectExpiredTasks(projectDir, { limit: 100 });
    if (message.method === 'tasks/get') {
      const task = await getTask(projectDir, taskId);
      if (!task) return error(message.id, -32602, 'Failed to retrieve task: Task not found');
      return completeResult(message.id, taskWireProjection(task));
    }
    if (message.method === 'tasks/update') {
      const task = await acknowledgeTaskUpdate(projectDir, taskId, {
        inputResponses: message.params?.inputResponses ?? {},
      });
      if (!task) return error(message.id, -32602, 'Failed to update task: Task not found');
      return completeResult(message.id, {});
    }
    const running = runningTasks.get(taskId);
    if (running) running.cancelRequested = true;
    const cancellationPromise = requestTaskCancellation(projectDir, taskId, {
      requester: TASK_OWNER,
      reason: 'client requested task cancellation',
    });
    if (running) running.cancellationPromise = cancellationPromise;
    const task = await cancellationPromise;
    if (!task) return error(message.id, -32602, 'Failed to cancel task: Task not found');
    if (running && (running.attribution || running.before)) {
      await cancelRunningTask(projectDir, task, running, 'client requested task cancellation');
    } else if (!running) {
      // Persisted work owned by another/dead process is never signalled: doing
      // so would turn a recycled pid into a cancellation capability. It can be
      // terminalized safely because no attributable local effect is touched.
      await settleCancelledTask(projectDir, task, null, 'cancellation recorded; no attributable local process was signalled');
    }
    return completeResult(message.id, {});
  }
  return error(message.id, -32601, `method not found: ${message.method}`);
}

// Strict-FIFO tool-call queue (audit: the fully serial read loop starved
// concurrent requests — a status or even a protocol ping queued unprocessed
// behind a multi-minute record/regate/ship, and a queued call's progress
// heartbeat never started, defeating the anti-timeout mechanism). Tool calls
// stay strictly serialized in arrival order: dispatching them concurrently
// would surface 15s receipt-lock busy errors to callers today's queueing
// absorbs, and WRITER serialization itself remains owned by the receipt lock
// — this queue must never weaken it (invariant 7). What changes: the
// heartbeat now starts at ENQUEUE (a queued call emits progress while it
// waits) and the response writes on settle, freeing the read loop to answer
// ping/tools/list/initialize between frames. Exported for unit tests, like
// withProgressHeartbeat.
/**
 * @param {{
 *   execute?: (message: any) => Promise<any>,
 *   writeLine?: (payload: any) => boolean | void,
 *   intervalMs?: number,
 * }} [options]
 */
export function createToolCallQueue({
  execute = executeToolCall,
  writeLine = (payload) => process.stdout.write(`${JSON.stringify(payload)}\n`),
  intervalMs,
} = {}) {
  let chain = Promise.resolve();
  return {
    enqueue(message) {
      const args = message.params?.arguments ?? {};
      const label = args.action ? `${message.params?.name} ${args.action}` : message.params?.name;
      const turn = chain;
      const taskCapableApeRun = declaresModernProtocol(message) && declaresTasksCapability(message) &&
        message.params?.name === 'ape_run';
      const definitelyCreatesTask = taskCapableApeRun && (
        ['record', 'regate', 'ship'].includes(args.action) ||
        (args.action === 'next' && Number.isFinite(args.wait_ms) && args.wait_ms > 0)
      );
      const gateDependentNext = taskCapableApeRun && args.action === 'next' && !definitelyCreatesTask;
      const runQueuedCall = async () => {
        await turn;
        return execute(message);
      };
      const settledWork = gateDependentNext
        ? (async () => {
            // Whether a plain opted-in next crosses a gate depends on the
            // state left by earlier FIFO calls. Decide only after they settle;
            // otherwise a queued call can emit progress and then become a task.
            await turn;
            let createsTask = false;
            try {
              const projectDir = resolveMcpRoot(args.project_dir);
              createsTask = await shouldTaskWrapApeRun(projectDir, args);
            } catch {
              createsTask = false;
            }
            return withProgressHeartbeat(
              createsTask ? undefined : message.params?._meta?.progressToken,
              label,
              () => execute(message),
              { writeLine, ...(intervalMs !== undefined ? { intervalMs } : {}) },
            );
          })()
        : withProgressHeartbeat(
          // Task execution never uses the progress notification channel. The
          // durable task state is its only progress surface.
          definitelyCreatesTask ? undefined : message.params?._meta?.progressToken,
          label,
          runQueuedCall,
          { writeLine, ...(intervalMs !== undefined ? { intervalMs } : {}) },
        );
      const settled = settledWork.then(
        (response) => { if (response) { writeLine(response); } },
        (cause) => { writeLine(error(message.id ?? null, -32603, cause?.message ?? String(cause))); },
      ).catch(() => {
        // A writeLine fault (client hung up mid-write) must not wedge the
        // chain: later calls still execute and fail their own writes loudly.
      });
      chain = settled;
      return settled;
    },
    // Truthful completion at EOF: the last enqueued call's settled promise
    // transitively awaits every predecessor, so the chain tail IS "all tool
    // calls executed and their responses written".
    drain: () => chain,
  };
}

function isToolCall(message) {
  // An id-less tools/call is a notification: today's handler neither executes
  // nor answers it (the id guard returns null first), and enqueueing it would
  // silently change that contract.
  return message !== null && typeof message === 'object' &&
    message.method === 'tools/call' && Object.hasOwn(message, 'id');
}

async function main() {
  const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
  const queue = createToolCallQueue();
  const stop = () => lines.close();
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  for await (const line of lines) {
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      process.stdout.write(`${JSON.stringify(error(null, -32700, 'parse error'))}\n`);
      continue;
    }
    try {
      if (isToolCall(message)) {
        // Version negotiation happens BEFORE the queue: a mismatched call is a
        // protocol error, so the tool must not run at all (no result frame, no
        // state touched) and the refusal must not wait behind a long gate.
        const refusal = protocolVersionRefusal(message);
        if (refusal) {
          process.stdout.write(`${JSON.stringify(refusal)}\n`);
          continue;
        }
        // Enqueue without awaiting: the read loop stays free to answer
        // protocol messages while the call (and any queued behind it) runs.
        queue.enqueue(message);
        continue;
      }
      const response = await handle(message);
      if (response) process.stdout.write(`${JSON.stringify(response)}\n`);
    } catch (cause) {
      process.stdout.write(`${JSON.stringify(error(message.id ?? null, -32603, cause?.message ?? String(cause)))}\n`);
    }
  }
  // stdin closed with calls still in flight: finish and answer them all
  // before exiting — dropping a queued mutation's response would leave the
  // caller unable to distinguish "not run" from "response lost".
  await queue.drain();
  await shutdownOwnedTasks('MCP server input closed or process shutdown requested');
  process.removeListener('SIGINT', stop);
  process.removeListener('SIGTERM', stop);
}

// Importable for unit tests without starting the stdio loop; realpath both
// sides so an npm bin symlink still counts as direct invocation.
function invokedDirectly() {
  if (!process.argv[1]) return false;
  try {
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (invokedDirectly()) await main();
