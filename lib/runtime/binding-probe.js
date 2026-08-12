import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { atomicWriteJson, readJson } from './storage.js';
import { withDirLock } from './lock.js';

const PROBE_TTL_MS = 5 * 60_000;
const LAUNCH_TTL_MS = 60_000;
const LOCK_STALE_MS = 10_000;
const LOCK_HEARTBEAT_MS = 2_500;
const LOCK_WAIT_MS = 2_000;
const CAPABILITY_PATTERN = /^[A-Za-z0-9_-]{32,256}$/;
const PROBE_ID_PATTERN = /^probe-[A-Za-z0-9_-]{8,128}$/;
const PROBE_TASK_NAME_PATTERN = /^ape_probe_[a-f0-9]{32}$/;

function digest(value) {
  return createHash('sha256').update(value).digest('hex');
}

function iso(ms = Date.now()) {
  return new Date(ms).toISOString();
}

function expired(value, at = Date.now()) {
  const parsed = Date.parse(value ?? '');
  return !Number.isFinite(parsed) || parsed <= at;
}

function bounded(value, max = 512) {
  return typeof value === 'string' && value.length > 0 && value.length <= max;
}

async function withProbeLock(paths, callback) {
  return withDirLock(paths.bindingProbeLock, callback, {
    staleMs: LOCK_STALE_MS,
    heartbeatMs: LOCK_HEARTBEAT_MS,
    busyMs: LOCK_WAIT_MS,
    serializeLocal: true,
    busyMessage: 'APE native binding probe is busy; retry the probe action',
  });
}

function effectiveStatus(record, at = Date.now()) {
  if (!record) return 'missing';
  if (record.status === 'consumed') return 'consumed';
  if (expired(record.expires_at, at)) return 'expired';
  return record.status;
}

// Capability-free diagnostics. The status is intentionally infrastructure
// language rather than stage language: nothing here is a run or attempt.
export function projectBindingProbe(record, at = Date.now()) {
  const status = effectiveStatus(record, at);
  const infrastructure_status = {
    missing: 'required',
    prepared: 'awaiting_launch',
    launched: 'awaiting_binding',
    bound: 'awaiting_acknowledgement',
    completed: 'ready',
    consumed: 'consumed',
    expired: 'failed',
  }[status] ?? 'failed';
  if (!record) {
    return {
      status,
      infrastructure_status,
      attempts_consumed: 0,
      reason: 'no native binding probe has been prepared',
    };
  }
  return {
    probe_id: record.probe_id,
    host: record.host,
    agent_type: record.agent_type,
    model: record.model,
    status,
    infrastructure_status,
    attempts_consumed: 0,
    launch_observations: record.launch_observations ?? 0,
    prepared_at: record.prepared_at,
    launched_at: record.launched_at ?? null,
    bound_at: record.bound_at ?? null,
    completed_at: record.completed_at ?? null,
    consumed_at: record.consumed_at ?? null,
    expires_at: record.expires_at,
    transitions: record.transitions ?? [],
    ...(status === 'expired'
      ? { reason: 'native binding probe expired before it was consumed by a run start' }
      : {}),
  };
}

export async function bindingProbeStatus(paths) {
  return projectBindingProbe(await readJson(paths.bindingProbe, null));
}

export async function prepareBindingProbe(paths, { host, model }) {
  if (host !== 'codex') throw new Error('native binding probe currently supports host codex only');
  if (!model || !bounded(model.model, 256)) throw new Error('native binding probe requires a resolved model');
  const probe_id = `probe-${randomUUID()}`;
  const agentName = `ape_probe_${randomBytes(16).toString('hex')}`;
  const preparedAt = Date.now();
  const record = {
    version: 1,
    probe_id,
    host,
    agent_type: 'explorer',
    model,
    launch_name_hash: digest(agentName),
    status: 'prepared',
    prepared_at: iso(preparedAt),
    expires_at: iso(preparedAt + PROBE_TTL_MS),
    launch_observations: 0,
    transitions: [{ status: 'prepared', at: iso(preparedAt) }],
  };
  await withProbeLock(paths, () => atomicWriteJson(paths.bindingProbe, record));
  const prompt = [
    'Execute the APE native binding infrastructure probe.',
    'Do not call tools and do not inspect or modify the project.',
    'After SubagentStart injects APE_PROBE_CAPABILITY, return only the JSON object requested there.',
    `APE_BINDING_PROBE_ID=${probe_id}`,
  ].join('\n');
  return {
    type: 'dispatch_probe',
    probe: projectBindingProbe(record),
    dispatch: {
      host,
      native_tool: 'spawn_agent',
      agent_name: agentName,
      agent_type: record.agent_type,
      model,
      message: prompt,
    },
  };
}

export function isBindingProbeTaskName(taskName) {
  return typeof taskName === 'string' && PROBE_TASK_NAME_PATTERN.test(taskName);
}

export async function launchBindingProbe(paths, input) {
  const toolInput = input.tool_input ?? input.toolInput ?? input.input ?? {};
  const taskName = toolInput.task_name ?? toolInput.taskName;
  const sessionId = input.session_id ?? input.sessionId;
  const toolUseId = input.tool_use_id ?? input.toolUseId;
  const agentType =
    toolInput.subagent_type ?? toolInput.subagentType ?? toolInput.agent_type ?? toolInput.agentType;
  const requestedModel = toolInput.model;
  const requestedEffort = toolInput.reasoning_effort ?? toolInput.reasoningEffort ?? null;
  if (!isBindingProbeTaskName(taskName) || !bounded(sessionId) || !bounded(toolUseId) || !bounded(agentType)) {
    return { valid: false, reason: 'APE binding probe launch denied: malformed or missing probe capability' };
  }
  return withProbeLock(paths, async () => {
    const record = await readJson(paths.bindingProbe, null);
    if (!record || record.launch_name_hash !== digest(taskName)) {
      return { valid: false, reason: 'APE binding probe launch denied: probe capability mismatch' };
    }
    if (expired(record.expires_at)) {
      return { valid: false, reason: 'APE binding probe launch denied: probe expired' };
    }
    if (record.status === 'launched') {
      const same = record.parent_session_id === sessionId && record.tool_use_id === toolUseId;
      return same
        ? { valid: true, reason: 'APE binding probe launch already authorized for this native tool call' }
        : { valid: false, reason: 'APE binding probe launch denied: probe capability replayed' };
    }
    if (record.status !== 'prepared') {
      return { valid: false, reason: `APE binding probe launch denied: probe is ${record.status}` };
    }
    if (agentType !== record.agent_type) {
      return { valid: false, reason: `APE binding probe launch denied: expected agent type ${record.agent_type}` };
    }
    if (requestedModel !== record.model.model) {
      return { valid: false, reason: `APE binding probe launch denied: expected model ${record.model.model}` };
    }
    if ((record.model.reasoning_effort ?? null) !== requestedEffort) {
      return { valid: false, reason: `APE binding probe launch denied: expected reasoning effort ${record.model.reasoning_effort ?? '(none)'}` };
    }
    const launchedAt = Date.now();
    await atomicWriteJson(paths.bindingProbe, {
      ...record,
      status: 'launched',
      parent_session_id: sessionId,
      tool_use_id: toolUseId,
      launched_at: iso(launchedAt),
      launch_expires_at: iso(Math.min(Date.parse(record.expires_at), launchedAt + LAUNCH_TTL_MS)),
      launch_observations: (record.launch_observations ?? 0) + 1,
      transitions: [...(record.transitions ?? []), { status: 'launched', at: iso(launchedAt) }],
    });
    return { valid: true, reason: `APE binding probe launch authorized for ${record.probe_id}` };
  });
}

export async function bindBindingProbe(paths, input) {
  const sessionId = input.session_id ?? input.sessionId;
  const agentId = input.agent_id ?? input.agentId;
  const agentType = input.agent_type ?? input.agentType;
  if (!bounded(sessionId) || !bounded(agentId) || !bounded(agentType)) {
    return { matched: false, valid: false, reason: 'APE binding probe binding denied: malformed native identity' };
  }
  return withProbeLock(paths, async () => {
    const record = await readJson(paths.bindingProbe, null);
    if (!record || record.status !== 'launched') return { matched: false };
    if (
      expired(record.expires_at) ||
      expired(record.launch_expires_at) ||
      record.agent_type !== agentType
    ) {
      return { matched: true, valid: false, reason: 'APE binding probe binding denied: no matching active launch' };
    }
    const capability = randomBytes(32).toString('base64url');
    const boundAt = Date.now();
    await atomicWriteJson(paths.bindingProbe, {
      ...record,
      status: 'bound',
      bound_session_id: sessionId,
      bound_agent_id: agentId,
      capability_hash: digest(capability),
      bound_at: iso(boundAt),
      transitions: [...(record.transitions ?? []), { status: 'bound', at: iso(boundAt) }],
    });
    return {
      matched: true,
      valid: true,
      reason: `APE native identity bound to infrastructure probe ${record.probe_id}`,
      additional_context: [
        `APE_BINDING_PROBE_ID=${record.probe_id}`,
        `APE_PROBE_CAPABILITY=${capability}`,
        `Return only {"probe_id":"${record.probe_id}","probe_capability":"${capability}"} as your final response. Do not call tools.`,
      ].join('\n'),
    };
  });
}

export async function resolvesBindingProbeIdentity(paths, input) {
  const sessionId = input.session_id ?? input.sessionId;
  const agentId = input.agent_id ?? input.agentId;
  const agentType = input.agent_type ?? input.agentType;
  if (!bounded(sessionId) || !bounded(agentId) || !bounded(agentType)) return false;
  const record = await readJson(paths.bindingProbe, null);
  return Boolean(
    record &&
    ['bound', 'completed', 'consumed'].includes(record.status) &&
    !expired(record.expires_at) &&
    (record.bound_session_id ?? record.parent_session_id) === sessionId &&
    record.bound_agent_id === agentId &&
    record.agent_type === agentType
  );
}

export async function acknowledgeBindingProbe(paths, input = {}) {
  const { probe_id, probe_capability } = input;
  if (!PROBE_ID_PATTERN.test(probe_id ?? '') || !CAPABILITY_PATTERN.test(probe_capability ?? '')) {
    throw new Error('probe acknowledgement requires a valid probe_id and probe_capability');
  }
  return withProbeLock(paths, async () => {
    const record = await readJson(paths.bindingProbe, null);
    if (!record || record.probe_id !== probe_id) {
      throw new Error('native binding probe acknowledgement does not match the current probe');
    }
    if (expired(record.expires_at)) throw new Error('native binding probe expired before acknowledgement');
    if (!['bound', 'completed'].includes(record.status)) {
      throw new Error(`native binding probe cannot be acknowledged while ${record.status}`);
    }
    if (record.capability_hash !== digest(probe_capability)) {
      throw new Error('native binding probe capability mismatch');
    }
    if (record.status === 'completed') return projectBindingProbe(record);
    const completedAt = Date.now();
    const completed = {
      ...record,
      status: 'completed',
      completed_at: iso(completedAt),
      transitions: [...(record.transitions ?? []), { status: 'completed', at: iso(completedAt) }],
    };
    await atomicWriteJson(paths.bindingProbe, completed);
    return projectBindingProbe(completed);
  });
}

export async function consumeBindingProbe(paths, host) {
  return withProbeLock(paths, async () => {
    const record = await readJson(paths.bindingProbe, null);
    if (!record || record.host !== host || record.status !== 'completed' || expired(record.expires_at)) {
      return { ok: false, probe: projectBindingProbe(record) };
    }
    const consumedAt = Date.now();
    const consumed = {
      ...record,
      status: 'consumed',
      consumed_at: iso(consumedAt),
      transitions: [...(record.transitions ?? []), { status: 'consumed', at: iso(consumedAt) }],
    };
    await atomicWriteJson(paths.bindingProbe, consumed);
    return { ok: true, probe: projectBindingProbe(consumed) };
  });
}
