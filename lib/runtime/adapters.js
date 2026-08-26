import { lstatSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { TextDecoder } from 'node:util';
import { canonicalJson } from './canonical.js';
import {
  CODEX_DISPATCH_ENVELOPE_VERSION,
  CODEX_DISPATCH_PROTOCOL_VERSION,
} from './versions.js';

const CLAUDE_AGENT_NAMES = Object.freeze({
  preflight_analyst: 'ape:preflight-analyst',
  planner: 'ape:planner',
  plan_checker: 'ape:plan-checker',
  plan_critic: 'ape:plan-critic',
  plan_judge: 'ape:plan-judge',
  test_writer: 'ape:test-writer',
  implementer: 'ape:implementer',
  reviewer: 'ape:reviewer',
  security_reviewer: 'ape:security-reviewer',
  debugger: 'ape:debugger',
  spike_researcher: 'ape:spike-researcher',
});

const ROLE_NAME_PATTERN = /^[a-z][a-z0-9_]{0,63}$/;
const MAX_PACKAGED_PROMPT_BYTES = 64 * 1024;
const MAX_DISPATCH_INTENT_BYTES = 4 * 1024;
const TICKET_ID_PATTERN = /^[A-Za-z0-9:_-]{1,512}$/;
const TICKET_HASH_PATTERN = /^[a-f0-9]{64}$/i;

// The MCP response target is 48,000 JSON characters (projection.js). The
// self-contained message is correctness-bearing and cannot be compacted, so a
// whole returned dispatch group shares a conservative 18,000-character slice
// of that wire budget. Measure the JSON string, not raw UTF-8:
// quotes, backslashes, and newlines expand when the enclosing response is
// serialized. A ticket that cannot fit fails closed before a native launch
// capability is exposed rather than emitting an unbounded, truncated contract.
export const CODEX_DISPATCH_MESSAGE_WIRE_LIMIT = 18_000;

export const CODEX_DISPATCH_NEXT_CONTROL =
  'Record each returned receipt unchanged with ape_run action "record"; after the group is fully recorded, call ape_run action "next".';

function packagePromptRoot(moduleUrl = import.meta.url) {
  const moduleDirectory = path.dirname(fileURLToPath(moduleUrl));
  if (
    path.basename(moduleDirectory) === 'runtime' &&
    path.basename(path.dirname(moduleDirectory)) === 'lib'
  ) {
    return path.join(path.dirname(path.dirname(moduleDirectory)), 'prompts');
  }
  if (path.basename(moduleDirectory) === 'dist') {
    return path.join(path.dirname(moduleDirectory), 'prompts');
  }
  throw new Error('APE packaged prompt root is unavailable');
}

const PACKAGED_PROMPT_ROOT = packagePromptRoot();
const PROMPT_CACHE = new Map();

function packagedPrompt(name) {
  if (PROMPT_CACHE.has(name)) return PROMPT_CACHE.get(name);
  const publicPath = `prompts/${name}.md`;
  const file = path.join(PACKAGED_PROMPT_ROOT, `${name}.md`);
  try {
    const metadata = lstatSync(file);
    if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size > MAX_PACKAGED_PROMPT_BYTES) {
      throw new Error('invalid packaged prompt');
    }
    const bytes = readFileSync(file);
    if (bytes.length !== metadata.size || bytes.length > MAX_PACKAGED_PROMPT_BYTES) {
      throw new Error('unstable packaged prompt');
    }
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    if (text.includes('\0')) throw new Error('invalid packaged prompt');
    PROMPT_CACHE.set(name, text);
    return text;
  } catch {
    // Never expose the absolute installed-package path. Prompt names are from
    // the fixed role-name grammar, and the loader never consults the governed
    // project, cwd, environment, or another checkout.
    throw new Error(`APE packaged prompt is unavailable: ${publicPath}`);
  }
}

function boundedDispatchIntent(ticket, dispatchIntent) {
  const fallback = `Execute the immutable APE StageTicket ${ticket.ticket_id}.`;
  if (dispatchIntent === null) return fallback;
  if (
    typeof dispatchIntent?.prompt !== 'string' ||
    dispatchIntent.prompt.length === 0 ||
    Buffer.byteLength(dispatchIntent.prompt, 'utf8') > MAX_DISPATCH_INTENT_BYTES ||
    dispatchIntent.prompt.includes('\0')
  ) {
    throw new Error('Codex dispatch intent must carry a bounded text prompt');
  }
  return dispatchIntent.prompt;
}

function boundedTicketReference(ticket) {
  if (!TICKET_ID_PATTERN.test(ticket?.ticket_id ?? '')) {
    throw new Error('Codex bounded dispatch ticket carries an invalid ticket id');
  }
  if (!TICKET_HASH_PATTERN.test(ticket?.ticket_hash ?? '')) {
    throw new Error('Codex bounded dispatch ticket carries an invalid ticket hash');
  }
  return {
    projection: 'bounded-reference-v1',
    ticket_id: ticket.ticket_id,
    ticket_hash: ticket.ticket_hash,
    complete_ticket: {
      path: `.ape/runtime/tickets/${ticket.ticket_id.replaceAll(':', '_')}.json`,
      required: true,
    },
  };
}

function codexSpawnEnvelope(ticket, dispatchIntent, runObjective, dispatchGroupSize) {
  if (!ROLE_NAME_PATTERN.test(ticket?.role ?? '')) {
    throw new Error('Codex dispatch ticket carries an invalid role');
  }
  const taskName = dispatchIntent?.agent_name ?? ticket.role;
  if (
    typeof taskName !== 'string' ||
    taskName.length === 0 ||
    taskName.length > 512 ||
    /[\0\r\n]/u.test(taskName)
  ) {
    throw new Error('Codex dispatch intent carries an invalid task name');
  }
  const model = ticket?.model?.model;
  const reasoningEffort = ticket?.model?.reasoning_effort;
  if (typeof model !== 'string' || model.length === 0 || model.length > 512) {
    throw new Error('Codex dispatch ticket carries an invalid model');
  }
  if (
    reasoningEffort !== undefined &&
    (typeof reasoningEffort !== 'string' || reasoningEffort.length === 0 || reasoningEffort.length > 64)
  ) {
    throw new Error('Codex dispatch ticket carries an invalid reasoning effort');
  }

  const intentPrompt = boundedDispatchIntent(ticket, dispatchIntent);
  const commonPrompt = packagedPrompt('common');
  const rolePrompt = packagedPrompt(ticket.role);
  const groupSize = Number.isSafeInteger(dispatchGroupSize) && dispatchGroupSize > 0
    ? dispatchGroupSize
    : 1;
  const messageWireLimit = Math.floor(CODEX_DISPATCH_MESSAGE_WIRE_LIMIT / groupSize);
  const compose = (messageTicket) => [
    intentPrompt,
    'APE common contract',
    commonPrompt,
    `APE ${ticket.role} contract`,
    rolePrompt,
    'Immutable StageTicket',
    canonicalJson(messageTicket),
  ].join('\n\n');

  let ticketProjection = 'full';
  let message = compose(ticket);
  if (
    (groupSize > 1 || JSON.stringify(message).length > messageWireLimit) &&
    typeof runObjective === 'string' &&
    runObjective.length > 0
  ) {
    // The common contract sanctions exactly this ticket-file read. Keep only
    // the immutable id/hash/path reference in the launch message: every bulky
    // ticket field remains complete in the hash-bound on-disk record, so a
    // parallel group cannot multiply plans, findings, or preflight artifacts
    // past the MCP response budget.
    message = compose(boundedTicketReference(ticket));
    ticketProjection = 'bounded';
  }
  if (JSON.stringify(message).length > messageWireLimit) {
    throw new Error('Codex dispatch message exceeds the bounded launch envelope');
  }
  return {
    ticket_projection: ticketProjection,
    spawn_args: {
      task_name: taskName,
      // Model/reasoning overrides are rejected with the host's inherited
      // full-history fork. The envelope is self-contained, so no history is
      // needed and this exact native argument makes the override admissible.
      fork_turns: 'none',
      model,
      ...(reasoningEffort === undefined ? {} : { reasoning_effort: reasoningEffort }),
      message,
    },
  };
}

export function nativeDispatch(host, ticket, dispatchIntent = null, context = {}) {
  const promptPath = `prompts/${ticket.role}.md`;
  const promptPaths = ['prompts/common.md', promptPath];
  if (host === 'claude') {
    const dispatch = {
      host,
      native_tool: 'Agent',
      agent_type: CLAUDE_AGENT_NAMES[ticket.role] ?? `ape:${ticket.role.replaceAll('_', '-')}`,
      prompt_path: promptPath,
      prompt_paths: promptPaths,
      model: ticket.model,
      ticket,
    };
    if (dispatchIntent) dispatch.dispatch_intent = dispatchIntent;
    return dispatch;
  }
  if (host === 'codex') {
    const envelope = codexSpawnEnvelope(
      ticket,
      dispatchIntent,
      context.run_objective,
      context.dispatch_group_size,
    );
    const dispatch = {
      host,
      native_tool: 'spawn_agent',
      // Built-in worker/explorer profiles are available wherever the plugin is
      // installed. Project custom agents remain optional: plugins do not need
      // to distribute .codex/agents for the APE role prompt to take effect.
      agent_name: dispatchIntent?.agent_name ?? ticket.role,
      agent_type: ticket.writable ? 'worker' : 'explorer',
      prompt_path: promptPath,
      prompt_paths: promptPaths,
      model: ticket.model,
      protocol_version: CODEX_DISPATCH_PROTOCOL_VERSION,
      envelope_version: CODEX_DISPATCH_ENVELOPE_VERSION,
      ticket_id: ticket.ticket_id,
      ticket_projection: envelope.ticket_projection,
      spawn_args: envelope.spawn_args,
      next_control: CODEX_DISPATCH_NEXT_CONTROL,
      // Multi-Agent V2 encrypts message before PreToolUse. A one-time token in
      // agent_name/task_name is therefore the visible launch capability;
      // SubagentStart then binds Codex's host-issued child session and agent_id
      // to this ticket; its session_id is not the parent launch session.
      ticket,
    };
    if (dispatchIntent) dispatch.dispatch_intent = dispatchIntent;
    return dispatch;
  }
  throw new Error(`unsupported host: ${host}`);
}
