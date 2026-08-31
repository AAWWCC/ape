#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const VALIDATOR_NAMES = Object.freeze([
  'mcp__ape__ape_validate_receipt',
  'mcp__plugin_ape_ape__ape_validate_receipt',
]);
const VALIDATOR_NAME_SET = new Set(VALIDATOR_NAMES);
const ROLE_PATTERN = /^[a-z][a-z0-9-]{0,63}$/u;
const DIGEST_PATTERN = /^[0-9a-f]{64}$/u;
const DEFAULT_TIMEOUT_MS = 120_000;

export class WorkerValidatorReachabilityError extends Error {
  constructor(message) {
    super(message);
    this.name = 'WorkerValidatorReachabilityError';
  }
}

export function canonicalWorkerRoles(agentsDir = path.join(ROOT, 'agents')) {
  const roles = readdirSync(agentsDir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.md'))
    .map((entry) => entry.name.slice(0, -3))
    .sort();
  if (roles.length === 0 || roles.some((role) => !ROLE_PATTERN.test(role))) {
    throw new WorkerValidatorReachabilityError('canonical worker role manifests are missing or malformed');
  }
  return Object.freeze(roles);
}

function hashLabeledFiles(entries) {
  const digest = createHash('sha256');
  for (const [label, file] of [...entries].sort(([left], [right]) => left.localeCompare(right))) {
    const bytes = readFileSync(file);
    digest.update(`${Buffer.byteLength(label, 'utf8')}:${label}`);
    digest.update(`${bytes.length}:`);
    digest.update(bytes);
  }
  return digest.digest('hex');
}

// Bind the retained proof to the exact role manifests, packaged MCP server
// declaration, plugin identity, and canary implementation that produced it.
// Logical labels keep the digest independent of the checkout's absolute path.
export function candidateValidatorSurfaceHash({
  pluginDir = path.join(ROOT, 'plugins', 'ape-claude'),
} = {}) {
  const canonical = canonicalWorkerRoles();
  const packaged = canonicalWorkerRoles(path.join(pluginDir, 'agents'));
  if (JSON.stringify(packaged) !== JSON.stringify(canonical)) {
    throw new WorkerValidatorReachabilityError(
      'packaged Claude worker roles do not match the canonical role set',
    );
  }
  return hashLabeledFiles([
    ...canonical.map((role) => [
      `canonical/agents/${role}.md`,
      path.join(ROOT, 'agents', `${role}.md`),
    ]),
    ...packaged.map((role) => [
      `package/agents/${role}.md`,
      path.join(pluginDir, 'agents', `${role}.md`),
    ]),
    ['package/.mcp.json', path.join(pluginDir, '.mcp.json')],
    ['package/.claude-plugin/plugin.json', path.join(pluginDir, '.claude-plugin', 'plugin.json')],
    ['canary/run-worker-validator-reachability.mjs', fileURLToPath(import.meta.url)],
  ]);
}

function textFromToolResult(value) {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.map(textFromToolResult).join('\n');
  if (!value || typeof value !== 'object') return '';
  return Object.values(value).map(textFromToolResult).join('\n');
}

// Validate host-emitted stream-json, not the model's final prose. A passing
// transcript must contain a real tool_use for one exact supported server name,
// the exact sentinel input for this role, and its linked tool_result from the
// APE service. The fixed no-active-run result proves the schema resolved and
// the call crossed the MCP transport; merely mentioning the tool cannot pass.
export function inspectWorkerValidatorTranscript(raw, expected) {
  const calls = new Map();
  const results = new Map();
  const lines = String(raw ?? '').split(/\r?\n/u).filter(Boolean);
  for (const line of lines) {
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      throw new WorkerValidatorReachabilityError(
        `role ${expected.role} returned non-JSON stream output`,
      );
    }
    const visit = (value) => {
      if (!value || typeof value !== 'object') return;
      if (
        value.type === 'tool_use' &&
        typeof value.id === 'string' &&
        VALIDATOR_NAME_SET.has(value.name)
      ) {
        calls.set(value.id, { name: value.name, input: value.input });
      }
      if (value.type === 'tool_result' && typeof value.tool_use_id === 'string') {
        results.set(value.tool_use_id, textFromToolResult(value.content));
      }
      for (const child of Object.values(value)) {
        if (child && typeof child === 'object') visit(child);
      }
    };
    visit(event);
  }

  const matching = [...calls.entries()].filter(([, call]) => (
    call.input?.project_dir === expected.project_dir &&
    call.input?.ticket_id === expected.ticket_id &&
    call.input?.draft?.ticket_id === expected.ticket_id
  ));
  if (matching.length !== 1) {
    throw new WorkerValidatorReachabilityError(
      `role ${expected.role} did not emit exactly one exact validator call`,
    );
  }
  const [[toolUseId, call]] = matching;
  if (!results.get(toolUseId)?.includes('no active run')) {
    throw new WorkerValidatorReachabilityError(
      `role ${expected.role} validator call did not return the sentinel APE service response`,
    );
  }
  return Object.freeze({
    role: expected.role,
    agent: `ape:${expected.role}`,
    validator_tool: call.name,
    service_response: 'no-active-run',
    transcript_sha256: createHash('sha256').update(String(raw ?? '')).digest('hex'),
  });
}

export function buildWorkerValidatorInvocation({
  role,
  projectDir,
  pluginDir = path.join(ROOT, 'plugins', 'ape-claude'),
  claudeBin = 'claude',
  model = 'haiku',
}) {
  if (!ROLE_PATTERN.test(role)) {
    throw new WorkerValidatorReachabilityError(`unsafe worker role: ${role}`);
  }
  const project = realpathSync(projectDir);
  const plugin = realpathSync(pluginDir);
  const ticketId = `ape-validator-reachability:${role}`;
  const draft = {
    ticket_id: ticketId,
    status: 'failed',
    tests: [],
    findings: [],
    evidence: { summary: 'validator reachability canary' },
    receipt_capability: 'validator_reachability_capability_00000000',
  };
  const call = { project_dir: project, ticket_id: ticketId, draft };
  const prompt = [
    `APE release validator-reachability canary for role ${role}.`,
    'Resolve and call ape_validate_receipt exactly once with the exact JSON arguments below.',
    'Use ToolSearch only if the schema is deferred. Do not simulate or describe the call.',
    'After the tool returns, stop immediately; do not call any other MCP tool.',
    `APE_VALIDATOR_REACHABILITY_CALL=${JSON.stringify(call)}`,
  ].join('\n');
  return Object.freeze({
    command: claudeBin,
    args: Object.freeze([
      '--print',
      '--plugin-dir', plugin,
      '--agent', `ape:${role}`,
      '--model', model,
      '--effort', 'low',
      '--permission-mode', 'dontAsk',
      '--setting-sources', 'project',
      '--output-format', 'stream-json',
      '--verbose',
      '--no-session-persistence',
      '--max-budget-usd', '0.25',
      prompt,
    ]),
    cwd: project,
    expected: Object.freeze({ role, project_dir: project, ticket_id: ticketId }),
  });
}

export function runWorkerValidatorReachability({
  claudeBin = 'claude',
  pluginDir = path.join(ROOT, 'plugins', 'ape-claude'),
  model = 'haiku',
  spawn = spawnSync,
  timeoutMs = DEFAULT_TIMEOUT_MS,
} = {}) {
  const scratch = mkdtempSync(path.join(tmpdir(), 'ape-validator-reachability-'));
  try {
    mkdirSync(path.join(scratch, '.ape', 'runtime'), { recursive: true, mode: 0o700 });
    const canonical = canonicalWorkerRoles();
    const packaged = canonicalWorkerRoles(path.join(pluginDir, 'agents'));
    if (JSON.stringify(packaged) !== JSON.stringify(canonical)) {
      throw new WorkerValidatorReachabilityError(
        'packaged Claude worker roles do not match the canonical role set',
      );
    }
    const observations = [];
    for (const role of canonical) {
      const invocation = buildWorkerValidatorInvocation({
        role,
        projectDir: scratch,
        pluginDir,
        claudeBin,
        model,
      });
      const child = spawn(invocation.command, invocation.args, {
        cwd: invocation.cwd,
        encoding: 'utf8',
        maxBuffer: 16 * 1024 * 1024,
        timeout: timeoutMs,
        env: {
          ...process.env,
          APE_HOST: 'claude',
          CLAUDE_PROJECT_DIR: scratch,
        },
      });
      if (child.error || child.status !== 0) {
        const detail = (
          String(child.stderr ?? '').trim() ||
          String(child.stdout ?? '').trim()
        ).slice(-1_000);
        const status = child.error?.message ??
          (child.signal ? `signal ${child.signal}` : `exit ${child.status}`);
        throw new WorkerValidatorReachabilityError(
          `role ${role} host launch failed (${status})${detail ? `: ${detail}` : ''}`,
        );
      }
      observations.push(inspectWorkerValidatorTranscript(child.stdout, invocation.expected));
    }
    return Object.freeze({
      version: 1,
      host: 'claude',
      checked_at: new Date().toISOString(),
      candidate_validator_surface_sha256: candidateValidatorSurfaceHash({ pluginDir }),
      validator_names: VALIDATOR_NAMES,
      roles: Object.freeze(observations),
    });
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

export function verifyWorkerValidatorReachabilityProof(proof, {
  pluginDir = path.join(ROOT, 'plugins', 'ape-claude'),
} = {}) {
  if (!proof || typeof proof !== 'object' || Array.isArray(proof)) {
    throw new WorkerValidatorReachabilityError('worker validator proof must be a JSON object');
  }
  if (proof.version !== 1 || proof.host !== 'claude') {
    throw new WorkerValidatorReachabilityError('worker validator proof version or host is invalid');
  }
  if (!Number.isFinite(Date.parse(proof.checked_at ?? ''))) {
    throw new WorkerValidatorReachabilityError('worker validator proof checked_at is invalid');
  }
  const expectedSurface = candidateValidatorSurfaceHash({ pluginDir });
  if (proof.candidate_validator_surface_sha256 !== expectedSurface) {
    throw new WorkerValidatorReachabilityError(
      'worker validator proof does not match this candidate validator surface',
    );
  }
  if (JSON.stringify(proof.validator_names) !== JSON.stringify(VALIDATOR_NAMES)) {
    throw new WorkerValidatorReachabilityError('worker validator proof names an unsupported validator set');
  }
  const expectedRoles = canonicalWorkerRoles();
  if (!Array.isArray(proof.roles) || proof.roles.length !== expectedRoles.length) {
    throw new WorkerValidatorReachabilityError('worker validator proof does not cover every role');
  }
  for (let index = 0; index < expectedRoles.length; index += 1) {
    const role = expectedRoles[index];
    const observation = proof.roles[index];
    if (
      observation?.role !== role ||
      observation?.agent !== `ape:${role}` ||
      !VALIDATOR_NAME_SET.has(observation?.validator_tool) ||
      observation?.service_response !== 'no-active-run' ||
      !DIGEST_PATTERN.test(observation?.transcript_sha256 ?? '')
    ) {
      throw new WorkerValidatorReachabilityError(
        `worker validator proof observation is invalid for role ${role}`,
      );
    }
  }
  return Object.freeze({
    ok: true,
    checked_at: proof.checked_at,
    candidate_validator_surface_sha256: expectedSurface,
    roles_verified: expectedRoles.length,
  });
}

function parseArgs(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (!value) {
      throw new WorkerValidatorReachabilityError(
        'usage: run-worker-validator-reachability.mjs [--claude-bin <path>] [--plugin-dir <path>] [--model <model>] [--verify-proof <path>]',
      );
    }
    if (flag === '--claude-bin') options.claudeBin = value;
    else if (flag === '--plugin-dir') options.pluginDir = value;
    else if (flag === '--model') options.model = value;
    else if (flag === '--verify-proof') options.verifyProof = value;
    else throw new WorkerValidatorReachabilityError(`unknown option: ${flag}`);
  }
  if (
    options.verifyProof &&
    (options.claudeBin !== undefined || options.model !== undefined)
  ) {
    throw new WorkerValidatorReachabilityError(
      '--verify-proof cannot be combined with --claude-bin or --model',
    );
  }
  return options;
}

function invokedDirectly(argvPath) {
  if (!argvPath) return false;
  try {
    return realpathSync(argvPath) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (invokedDirectly(process.argv[1])) {
  try {
    const options = parseArgs(process.argv.slice(2));
    const result = options.verifyProof
      ? verifyWorkerValidatorReachabilityProof(
          JSON.parse(readFileSync(options.verifyProof, 'utf8')),
          { pluginDir: options.pluginDir },
        )
      : runWorkerValidatorReachability(options);
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } catch (error) {
    process.stderr.write(`${error?.message ?? String(error)}\n`);
    process.exitCode = 1;
  }
}
