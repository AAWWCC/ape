import { createHash } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import { lstat, mkdir, open } from 'node:fs/promises';
import path from 'node:path';
import { withDirLock } from './lock.js';
import { validateGovernedRuntimeAncestor } from './paths.js';
import { atomicWriteJson } from './storage.js';
import { NATIVE_MODEL_MAX_CHARS } from './constants.js';

export const BOOTSTRAP_TOOL_PATTERN = /^(?:mcp__(?:ape|plugin_ape_ape)__)?ape_bind$/u;

// Static orientation only: never interpolate a candidate, launch, ticket,
// project path, or bearer. SubagentStart cannot associate a native child with
// a particular dispatch, so this reminder must remain conditional.
export function codexBootstrapOrientation() {
  return [
    'APE native-child orientation (not ticket authority)',
    'This hook attests only your native child identity. It does not associate you with a ticket or grant stage, receipt, or probe-acknowledgement authority.',
    'Execute the task already assigned by your parent; do not ask the human to restate an already supplied assignment.',
    'If your assigned task includes APE bootstrap arguments, follow these steps now:',
    '1. Before binding, authoritative ticket/receipt/probe context is expected to be absent. Do not stop for that absence. Tool discovery and ape_bind are permitted bootstrap operations, not stage work.',
    'For that APE bootstrap only, if the tool is deferred, you may make at most one host tool-catalog search using only the literal registered tool name ape_bind, not a host-qualified invocation alias. Never include a capability, project path, or task data in that search.',
    'For that APE bootstrap only, a functions.exec wrapper is permitted only to inspect exact-matching ALL_TOOLS metadata for ape_bind or invoke that one installed tool. This does not permit functions.exec_command, shell commands, file access, other MCP operations, or stage work.',
    '2. Call installed APE ape_bind once with the exact assigned arguments as your first APE operation. Invoke the returned namespace/function (mcp__ape.ape_bind; normalized alias mcp__ape__ape_bind), never a similarly named tool from another plugin.',
    '3. Only AFTER ape_bind returns, check for complete authenticated stage or probe context. If missing then, stop without claiming binding or acknowledgement. Otherwise follow that injected context.',
    'If your assigned task has no APE bootstrap arguments, do not infer, obtain, or request them; continue that non-APE assignment under the applicable rules.',
  ].join('\n');
}

const MAX_CANDIDATE_BYTES = 8192;
const bounded = (value, limit = 512) =>
  typeof value === 'string' && value.length > 0 && value.length <= limit &&
  !/[\u0000-\u001f\u007f]/u.test(value);
const digest = (value) => createHash('sha256').update(value).digest('hex');
function evidenceError(known = false) {
  const error = /** @type {any} */ (new Error('Codex bootstrap native identity evidence is unreadable or conflicting'));
  error.code = 'APE_CODEX_BOOTSTRAP_EVIDENCE_INVALID';
  error.bootstrap_identity_known = known;
  return error;
}

function candidateDirectory(paths) {
  return path.join(paths.runtime, 'codex-bootstrap-candidates');
}

function candidateFile(paths, sessionId, turnId) {
  return path.join(candidateDirectory(paths), `${digest(JSON.stringify([sessionId, turnId]))}.json`);
}

function knownChildFile(paths, agentId) {
  return path.join(paths.runtime, 'codex-bootstrap-known-children', `${digest(agentId)}.json`);
}

function validKnownChild(record) {
  return record && typeof record === 'object' && !Array.isArray(record) &&
    Object.keys(record).length === 3 && record.version === 1 &&
    record.status === 'known-child' && bounded(record.agent_id);
}

async function candidateContainer(paths, create = false) {
  return bootstrapContainer(paths, candidateDirectory(paths), create);
}

async function knownChildContainer(paths, create = false) {
  return bootstrapContainer(paths, path.join(paths.runtime, 'codex-bootstrap-known-children'), create);
}

async function bootstrapContainer(paths, directory, create = false) {
  if (!(await validateGovernedRuntimeAncestor(paths))) return false;
  let metadata;
  try {
    metadata = await lstat(directory);
  } catch (error) {
    if (error?.code !== 'ENOENT') throw evidenceError();
    if (!create) return false;
    await mkdir(directory, { mode: 0o700 }).catch((mkdirError) => {
      if (mkdirError?.code !== 'EEXIST') throw evidenceError();
    });
    metadata = await lstat(directory);
  }
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) throw evidenceError();
  return true;
}

function ordinaryFile(metadata) {
  return metadata.isFile() && !metadata.isSymbolicLink() && metadata.nlink === 1 &&
    metadata.size <= MAX_CANDIDATE_BYTES;
}

function sameSnapshot(left, right) {
  return left.dev === right.dev && left.ino === right.ino && left.size === right.size &&
    left.mtimeMs === right.mtimeMs && left.ctimeMs === right.ctimeMs;
}

function validCandidate(record) {
  return record && typeof record === 'object' && !Array.isArray(record) &&
    record.version === 1 && record.status === 'observed' &&
    bounded(record.parent_session_id) && bounded(record.agent_id) &&
    record.agent_id !== record.parent_session_id && bounded(record.turn_id) &&
    bounded(record.agent_type) && bounded(record.model, NATIVE_MODEL_MAX_CHARS.codex) &&
    typeof record.observed_at === 'string' && record.observed_at.length <= 32 &&
    Number.isFinite(Date.parse(record.observed_at)) &&
    new Date(record.observed_at).toISOString() === record.observed_at;
}

async function readCandidate(file, validate = validCandidate) {
  let before;
  try {
    before = await lstat(file);
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw evidenceError();
  }
  if (!ordinaryFile(before)) throw evidenceError(true);
  let handle;
  try {
    handle = await open(file, fsConstants.O_RDONLY |
      (fsConstants.O_NONBLOCK ?? 0) | (fsConstants.O_NOFOLLOW ?? 0));
    const opened = await handle.stat();
    if (!ordinaryFile(opened) || !sameSnapshot(before, opened)) throw evidenceError();
    const buffer = Buffer.alloc(Number(opened.size) + 1);
    let length = 0;
    while (length < buffer.length) {
      const { bytesRead } = await handle.read(buffer, length, buffer.length - length, length);
      if (!bytesRead) break;
      length += bytesRead;
    }
    const after = await handle.stat();
    const finalEntry = await lstat(file);
    if (length !== opened.size || !ordinaryFile(after) || !ordinaryFile(finalEntry) ||
        !sameSnapshot(opened, after) || !sameSnapshot(opened, finalEntry)) throw evidenceError();
    const record = JSON.parse(buffer.subarray(0, length).toString('utf8'));
    if (!validate(record)) throw evidenceError(true);
    return record;
  } catch {
    throw evidenceError(true);
  } finally {
    await handle?.close().catch(() => {});
  }
}

function sameCandidate(left, right) {
  return ['parent_session_id', 'agent_id', 'agent_type', 'model', 'turn_id']
    .every((key) => left[key] === right[key]);
}

// SubagentStart is evidence of a native child, never ticket authority. Its
// session names the parent, while a later child tool can name either that
// parent or the child's native id. Both aliases include the distinct CHILD
// turn; a parent tool's own turn cannot impersonate this observation.
export async function recordCodexBootstrapCandidate(paths, input) {
  const candidate = {
    version: 1,
    status: 'observed',
    parent_session_id: input.session_id ?? input.sessionId,
    agent_id: input.agent_id ?? input.agentId,
    agent_type: input.agent_type ?? input.agentType,
    turn_id: input.turn_id ?? input.turnId,
    // Only the native hook envelope attests the effective child model. Never
    // fall back to tool_input.model, the requested model, or model prose.
    model: input.model,
    observed_at: new Date().toISOString(),
  };
  const nativeIdentityPresent = bounded(candidate.parent_session_id) && bounded(candidate.agent_id) &&
    bounded(candidate.turn_id) && candidate.agent_id !== candidate.parent_session_id;
  if (!nativeIdentityPresent) return { recorded: false, reason: 'malformed native child evidence' };
  if (!(await knownChildContainer(paths, true))) return { recorded: false };
  return withDirLock(path.join(paths.runtime, 'codex-bootstrap-candidates.lock'), async () => {
    await knownChildContainer(paths);
    const knownFile = knownChildFile(paths, candidate.agent_id);
    const known = await readCandidate(knownFile, validKnownChild);
    if (known && known.agent_id !== candidate.agent_id) throw evidenceError(true);
    if (!known) await atomicWriteJson(knownFile, {
      version: 1, status: 'known-child', agent_id: candidate.agent_id,
    });
    await candidateContainer(paths, true);
    const files = [...new Set([
      candidateFile(paths, candidate.parent_session_id, candidate.turn_id),
      candidateFile(paths, candidate.agent_id, candidate.turn_id),
    ])];
    const existing = await Promise.all(files.map((file) => readCandidate(file)));
    if (!validCandidate(candidate)) {
      // A missing model is no authority, but forgetting a known native child
      // would let a session-only later tool masquerade as the orchestrator.
      // Persist an exact-turn refusal so every such later lookup fails closed.
      for (const file of files) {
        await atomicWriteJson(file, { version: 1, status: 'rejected', observed_at: candidate.observed_at });
      }
      return { recorded: false, reason: 'malformed native child evidence' };
    }
    if (existing.some((record) => record && !sameCandidate(record, candidate))) {
      // A later contradictory native observation permanently poisons these
      // aliases. It must not silently leave an earlier candidate authoritative.
      for (const file of files) {
        await atomicWriteJson(file, { version: 1, status: 'conflicting', observed_at: candidate.observed_at });
      }
      throw evidenceError();
    }
    const retained = existing.find(Boolean) ?? candidate;
    for (let index = 0; index < files.length; index += 1) {
      if (!existing[index]) await atomicWriteJson(files[index], retained);
    }
    return { recorded: true, candidate: retained };
  }, { serializeLocal: true, busyMs: 2000, staleMs: 10_000, heartbeatMs: 2500 });
}

export async function resolveCodexBootstrapCandidate(paths, input) {
  const sessionId = input.session_id ?? input.sessionId;
  const turnId = input.turn_id ?? input.turnId;
  if (!bounded(sessionId)) return null;
  let knownChild = false;
  try {
    if (await knownChildContainer(paths)) {
      const known = await readCandidate(knownChildFile(paths, sessionId), validKnownChild);
      if (known && known.agent_id !== sessionId) throw evidenceError(true);
      knownChild = Boolean(known);
    }
  } catch (error) {
    if (error?.bootstrap_identity_known) throw error;
    // A directory-wide outage alone cannot classify an unrelated integration
    // as a child. Exact-turn candidate evidence can still prove identity below.
  }
  try {
    if (!(await candidateContainer(paths))) {
      if (knownChild) throw evidenceError(true);
      return null;
    }
  } catch (error) {
    if (knownChild) throw evidenceError(true);
    throw error;
  }
  const candidate = bounded(turnId) ? await readCandidate(candidateFile(paths, sessionId, turnId)) : null;
  if (!candidate) {
    // Only native child ids enter this index, never parent-session ids. A
    // known child with no fresh turn observation must not become the main
    // orchestrator merely because its later tool omits agent_id.
    if (knownChild) throw evidenceError(true);
    return null;
  }
  if ((sessionId !== candidate.parent_session_id && sessionId !== candidate.agent_id) ||
      turnId !== candidate.turn_id) throw evidenceError(true);
  const otherSession = sessionId === candidate.parent_session_id
    ? candidate.agent_id : candidate.parent_session_id;
  const corroboration = await readCandidate(candidateFile(paths, otherSession, turnId));
  if (!corroboration || !sameCandidate(candidate, corroboration)) throw evidenceError(true);
  const agentId = input.agent_id ?? input.agentId;
  const agentType = input.agent_type ?? input.agentType;
  if (input.is_subagent === false ||
      (agentId !== undefined && agentId !== candidate.agent_id) ||
      (agentType !== undefined && agentType !== candidate.agent_type) ||
      (input.model !== undefined && input.model !== candidate.model)) throw evidenceError(true);
  return {
    parent_session_id: candidate.parent_session_id,
    agent_id: candidate.agent_id,
    agent_type: candidate.agent_type,
    model: candidate.model,
    turn_id: candidate.turn_id,
    observed_at: candidate.observed_at,
  };
}
