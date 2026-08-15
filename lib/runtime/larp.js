// LARP MODE — the advisory notification-sound engine. Pure decision logic for
// the `bin/ape-larp.mjs` hook: given a host lifecycle payload, the runtime
// config, the process env, and an optional package-local sound manifest, decide
// which operator-owned or package-owned file (if any) to play.
//
// LARP is UX, not policy. It makes no transitions, writes nothing, and gates
// nothing (invariant 1 stays with the runtime; invariant 8 is why the PLAN/
// BUILD/SHIP cues are FAIL-SAFE: they play only on a positively parsed
// runtime-owned outcome, never on a guess). Every ambiguity resolves to
// silence.
//
// Events (a package may map any subset through assets/sounds/manifest.json):
//   BOOT                      SessionStart (main session only)
//   ASK                       PreToolUse of AskUserQuestion
//   STOP                      Stop (main session only)
//   SUBAGENT                  SubagentStop (DEFAULT OFF)
//   ERROR                     PostToolUseFailure, or an ape_run response that
//                              reports a FAILED checkpoint: run status 'blocked',
//                              a red merge gate, or a failed plan / reviewer /
//                              implementer receipt (the green phase failing).
//                              The test_writer red phase is NOT an error.
//   PLAN                      ape_run response: a passed planning-role receipt
//                              that dispatches a writing role (plan approved)
//   BUILD                     ape_run response: a passed implementer receipt
//                              (the build/green phase completed)
//   SHIP                      ape_run response: run status 'completed'
//
// BOOT, STOP, and the PostToolUseFailure ERROR cue are MAIN-SESSION ONLY: the
// host fires SessionStart/Stop/PostToolUseFailure once for the main session and
// again for EACH native subagent, so a payload carrying a non-empty agent
// identity (agent_id/agentId, agent_type/agentType, subagent_id/subagentId) or
// a truthy is_subagent/isSubagent flag — the same subagent attestation hooks.js
// normalizeLifecycleEvent reads — is subagent context and those three cues
// resolve to silence there. SubagentStop keeps its dedicated (default-off)
// SUBAGENT channel; the ape_run outcome cues are main-session-only by
// construction (subagents are denied the control plane).
//
// Toggle precedence, most specific wins, absent falls through:
//   file:    LARP_FILE_<EVENT> env  ->  notifications.larp.files.<event>  ->  package manifest -> silence
//   event:   LARP_<EVENT> env       ->  notifications.larp.events.<event> ->  default (SUBAGENT off, rest on)
//   global:  LARP_MODE env          ->  notifications.larp.enabled        ->  off

import { readFileSync, realpathSync, statSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';

export const LARP_EVENTS = Object.freeze([
  'BOOT',
  'ASK',
  'STOP',
  'SUBAGENT',
  'ERROR',
  'PLAN',
  'BUILD',
  'SHIP',
]);

const LARP_EVENT_SET = new Set(LARP_EVENTS);
const MANIFEST_EVENT_KEYS = new Set(LARP_EVENTS.map((event) => event.toLowerCase()));
const MANIFEST_KEYS = new Set(['version', 'files']);

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function containedBy(root, candidate) {
  const rel = relative(root, candidate);
  return rel === '' || (!isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${sep}`));
}

// The optional package-local manifest is deliberately closed: accepting an
// unknown top-level or event key would let a typo appear configured while the
// hook silently used a different file. Path and filesystem failures are still
// fail-open at the individual event boundary — that event simply has no cue.
export function parsePackageSoundManifest(value) {
  if (!isPlainObject(value)) return null;
  if (Object.keys(value).some((key) => !MANIFEST_KEYS.has(key))) return null;
  if (value.version !== 1 || !isPlainObject(value.files)) return null;
  if (Object.keys(value.files).some((key) => !MANIFEST_EVENT_KEYS.has(key))) return null;
  if (
    Object.values(value.files).some(
      (file) => typeof file !== 'string' || file.length === 0,
    )
  ) {
    return null;
  }
  return value.files;
}

// Resolve manifest entries relative to the manifest directory, never the
// process cwd or project. Both lexical and realpath containment are required,
// so `..` and an in-tree symlink to an external file are equally silent.
export function loadPackageSoundManifest(manifestPath) {
  try {
    const files = parsePackageSoundManifest(JSON.parse(readFileSync(manifestPath, 'utf8')));
    if (!files) return {};
    const manifestRoot = realpathSync(dirname(manifestPath));
    const sounds = {};
    for (const [eventKey, configuredPath] of Object.entries(files)) {
      if (isAbsolute(configuredPath)) continue;
      const lexical = resolve(manifestRoot, configuredPath);
      if (!containedBy(manifestRoot, lexical)) continue;
      let real;
      try {
        real = realpathSync(lexical);
        if (!containedBy(manifestRoot, real) || !statSync(real).isFile()) continue;
      } catch {
        continue;
      }
      sounds[eventKey.toUpperCase()] = real;
    }
    return Object.freeze(sounds);
  } catch {
    return {};
  }
}

// SUBAGENT fires on every subagent exit — far too chatty for a default.
const DEFAULT_OFF_EVENTS = new Set(['SUBAGENT']);

// BOOT/STOP/ERROR are main-session-only lifecycle cues: the host fires
// SessionStart/Stop/PostToolUseFailure once per session AND once per native
// subagent, so deriveLarpEvent silences them when the payload carries an agent
// identity (see deriveLarpEvent).
const SUBAGENT_SUPPRESSED_EVENTS = new Set(['SessionStart', 'Stop', 'PostToolUseFailure']);

const FALSY_TOGGLES = new Set(['0', 'false', 'off', '']);

// ape_run actions that can carry a run outcome. `status` is a read-only poll:
// replaying SHIP on every status check would turn a truthful cue into noise.
const OUTCOME_ACTIONS = new Set(['start', 'next', 'record', 'resume', 'regate', 'ship']);

const PLANNING_ROLES = new Set(['planner', 'plan_checker', 'plan_critic', 'plan_judge']);
const WRITING_ROLES = new Set(['test_writer', 'implementer']);
const REVIEW_ROLES = new Set(['reviewer', 'security_reviewer']);

const APE_RUN_TOOL = /(?:^|__)ape_run$/;
const ASK_TOOLS = new Set(['AskUserQuestion', 'request_user_input', 'ask_question']);

// Tri-state toggle parse: explicit truthy -> true, explicit falsy -> false,
// absent/non-scalar -> null (fall through to the next precedence level).
export function parseToggle(value) {
  if (value === undefined || value === null) return null;
  if (typeof value === 'boolean') return value;
  if (typeof value !== 'string' && typeof value !== 'number') return null;
  return !FALSY_TOGGLES.has(String(value).trim().toLowerCase());
}

// An MCP tool response arrives as {content:[{type:'text',text:<json>}]} from
// the server, but hosts may hand the hook the parsed object, a
// structuredContent mirror, or the BARE content-block array — Claude Code's
// PostToolUse tool_response for MCP tools is exactly that
// [{type:'text',text:<json>}] shape. Anything unparseable is silence.
function parseApeRunResponse(toolResponse) {
  let candidate = toolResponse;
  if (Array.isArray(candidate)) candidate = { content: candidate };
  if (candidate && typeof candidate === 'object' && Array.isArray(candidate.content)) {
    const text = candidate.content.find(
      (entry) => entry?.type === 'text' && typeof entry.text === 'string',
    )?.text;
    if (candidate.structuredContent && typeof candidate.structuredContent === 'object') {
      candidate = candidate.structuredContent;
    } else if (typeof text === 'string') {
      try {
        candidate = JSON.parse(text);
      } catch {
        return null;
      }
    }
  }
  if (typeof candidate === 'string') {
    try {
      candidate = JSON.parse(candidate);
    } catch {
      return null;
    }
  }
  return candidate && typeof candidate === 'object' && !Array.isArray(candidate)
    ? candidate
    : null;
}

// FAIL-SAFE outcome gating: each cue requires a positive parse of the
// runtime's own response, and exactly ONE cue fires per response — a precedence
// ladder, most significant first (SHIP > ERROR > BUILD > PLAN). A response that
// chains straight through (e.g. gates + merge in one call with remote checks
// off) plays only SHIP; a stage-fail response plays only ERROR.
export function classifyApeRunOutcome(toolInput, toolResponse) {
  const requested = typeof toolInput?.action === 'string' ? toolInput.action : null;
  if (!requested || !OUTCOME_ACTIONS.has(requested)) return null;
  const response = parseApeRunResponse(toolResponse);
  if (!response) return null;
  const status = response.run?.status;
  const actions = Array.isArray(response.actions) ? response.actions : [];
  // Canonical receipts nest the acting role under agent.role (schemas.js);
  // tolerate a flattened top-level mirror as well.
  const receiptRole = response.receipt?.agent?.role ?? response.receipt?.role;
  const receiptStatus = response.receipt?.status;

  // SHIP — the whole run completed (merged).
  if (status === 'completed') return 'SHIP';

  // ERROR — a checkpoint FAILED and wants attention: the run blocked, a red
  // merge gate, or a failed receipt for a role whose failure is a real problem —
  // a rejected plan, a blocking reviewer/security reviewer, or an implementer
  // that could not make the authored test pass (the GREEN phase failing).
  // test_writer is deliberately excluded: its red test is the EXPECTED outcome
  // of the red phase (invariant 3), which is a PASSED receipt, never an error.
  if (status === 'blocked') return 'ERROR';
  if (actions.some((entry) => entry?.type === 'gates' && entry?.result?.passed === false)) return 'ERROR';
  if (
    receiptStatus === 'failed' &&
    (PLANNING_ROLES.has(receiptRole) || REVIEW_ROLES.has(receiptRole) || receiptRole === 'implementer')
  ) {
    return 'ERROR';
  }

  // BUILD — the implementer finished the build stage (the green phase passed).
  if (receiptStatus === 'passed' && receiptRole === 'implementer') return 'BUILD';

  // PLAN — a passed planning receipt handed off to a writing role (plan approved).
  if (
    response.ok === true &&
    receiptStatus === 'passed' &&
    PLANNING_ROLES.has(receiptRole) &&
    actions.some(
      (entry) => entry?.type === 'dispatch_agent' && WRITING_ROLES.has(entry?.ticket?.role),
    )
  ) {
    return 'PLAN';
  }
  return null;
}

// Map a raw host hook payload to a LARP event key, or null for silence.
export function deriveLarpEvent(input) {
  if (!input || typeof input !== 'object') return null;
  const event = input.hook_event_name ?? input.hookEventName ?? input.event ?? null;
  const toolName = input.tool_name ?? input.toolName ?? input.toolCall?.name ?? '';
  // Subagent context silences the three main-session lifecycle cues
  // (BOOT/STOP/ERROR) so N background agents don't storm N Start.wav plays.
  // The predicate matches hooks.js normalizeLifecycleEvent's identity fields
  // (audit 1.13 nit 10): a non-empty string in ANY identity field —
  // agent_id/agentId, agent_type/agentType, subagent_id/subagentId — OR a
  // truthy is_subagent/isSubagent flag. An empty string is not an identity,
  // and an explicit `is_subagent: false` is NOT subagent context. One known
  // divergence from normalizeLifecycleEvent's ??-chain: there an earlier
  // empty-string field (agent_id: '') shadows a later non-empty one
  // (agent_type), while this .some() still counts the later field — in that
  // pathological payload the predicate errs toward SUPPRESSING a sound,
  // never toward playing one. SubagentStop, AskUserQuestion (ASK), and the
  // ape_run outcome cues are unaffected.
  const subagentContext =
    [
      input.agent_id,
      input.agentId,
      input.agent_type,
      input.agentType,
      input.subagent_id,
      input.subagentId,
    ].some((value) => typeof value === 'string' && value.length > 0) ||
    Boolean(input.is_subagent || input.isSubagent);
  if (subagentContext && SUBAGENT_SUPPRESSED_EVENTS.has(event)) {
    return null;
  }
  switch (event) {
    case 'SessionStart':
      return 'BOOT';
    case 'Stop':
      return 'STOP';
    case 'SubagentStop':
      return 'SUBAGENT';
    case 'PostToolUseFailure':
      return 'ERROR';
    case 'PreToolUse':
      return ASK_TOOLS.has(toolName) ? 'ASK' : null;
    case 'PostToolUse':
      return APE_RUN_TOOL.test(toolName)
        ? classifyApeRunOutcome(
            input.tool_input ?? input.toolInput ?? input.toolCall?.args ?? {},
            input.tool_response ?? input.toolResponse ?? null,
          )
        : null;
    default:
      return null;
  }
}

function larpConfig(config) {
  const larp = config?.notifications?.larp;
  return larp && typeof larp === 'object' && !Array.isArray(larp) ? larp : {};
}

// Decide whether `event` plays and which file it plays. Operator env/config
// paths outrank a validated package-manifest path. No resolved file is silence.
/**
 * @param {{
 *   event: string | null,
 *   config?: Record<string, any>,
 *   env?: Record<string, string | undefined>,
 *   packageSounds?: Record<string, string>,
 * }} input
 */
export function resolveLarpDecision({ event, config = {}, env = {}, packageSounds = {} }) {
  if (!event || !LARP_EVENT_SET.has(event)) return { play: false, file: null };
  const larp = larpConfig(config);

  const globalToggle = parseToggle(env.LARP_MODE) ?? parseToggle(larp.enabled) ?? false;
  if (!globalToggle) return { play: false, file: null };

  const eventKey = event.toLowerCase();
  const defaultOn = !DEFAULT_OFF_EVENTS.has(event);
  const eventToggle =
    parseToggle(env[`LARP_${event}`]) ?? parseToggle(larp.events?.[eventKey]) ?? defaultOn;
  if (!eventToggle) return { play: false, file: null };

  const envFile = env[`LARP_FILE_${event}`];
  const configFile = larp.files?.[eventKey];
  const file =
    (typeof envFile === 'string' && envFile.length > 0 && envFile) ||
    (typeof configFile === 'string' && configFile.length > 0 && configFile) ||
    (typeof packageSounds[event] === 'string' && packageSounds[event].length > 0
      ? packageSounds[event]
      : null);
  if (!file) return { play: false, file: null };
  return { play: true, file };
}

// Platform-native detached player invocation, or null for a silent no-op
// platform. The PowerShell path passes the file as a positional argument —
// never interpolated into the command string.
export function resolvePlayerCommand(platform, file) {
  if (platform === 'darwin') return { command: 'afplay', args: [file] };
  if (platform === 'win32') {
    return {
      command: 'powershell.exe',
      args: [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        '(New-Object System.Media.SoundPlayer($args[0])).PlaySync()',
        file,
      ],
    };
  }
  return null;
}
