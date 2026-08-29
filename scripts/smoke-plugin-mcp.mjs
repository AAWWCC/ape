#!/usr/bin/env node

import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const pkg = JSON.parse(await readFile(join(REPO_ROOT, 'package.json'), 'utf8'));
const VERSION = pkg.version;

const PACKAGES = Object.freeze([
  ['codex', join(REPO_ROOT, 'plugins', 'ape')],
  ['claude', join(REPO_ROOT, 'plugins', 'ape-claude')],
]);
const EXPECTED_TOOLS = Object.freeze([
  'ape_run',
  'ape_validate_receipt',
  'ape_status',
  'ape_history',
  'ape_config',
]);

function assertContract(condition, host, message) {
  if (!condition) throw new Error(`${host} package MCP contract mismatch: ${message}`);
}

function conditionalForAction(schema, action) {
  return (schema?.allOf ?? []).find((entry) =>
    entry?.if?.properties?.action?.const === action &&
    entry?.if?.required?.includes('action'))?.then;
}

function assertToolContract(host, tools) {
  const byName = new Map(tools.map((tool) => [tool.name, tool]));
  const runSchema = byName.get('ape_run')?.inputSchema;
  assertContract(runSchema?.type === 'object', host, 'ape_run has no object input schema');
  const actions = runSchema?.properties?.action?.enum ?? [];
  for (const action of ['preview', 'start', 'extend-budget']) {
    assertContract(actions.includes(action), host, `ape_run action enum is missing ${action}`);
  }

  const start = conditionalForAction(runSchema, 'start');
  assertContract(start?.required?.includes('execution_budget'), host, 'start does not require execution_budget');
  const budget = runSchema?.properties?.execution_budget;
  assertContract(budget?.type === 'object' && budget?.additionalProperties === false, host, 'execution_budget is not a closed object');
  assertContract(
    JSON.stringify([...(budget?.required ?? [])].sort()) ===
      JSON.stringify(['max_active_seconds', 'max_worker_dispatches']),
    host,
    'execution_budget does not require both max_worker_dispatches and max_active_seconds',
  );
  assertContract(
    budget?.properties?.max_worker_dispatches?.minimum === 1 &&
      budget?.properties?.max_active_seconds?.minimum === 1,
    host,
    'execution_budget caps are not positive integers',
  );

  const extend = conditionalForAction(runSchema, 'extend-budget');
  assertContract(extend?.required?.includes('reason'), host, 'extend-budget does not require reason');
  const extensionAlternatives = extend?.anyOf ?? [];
  const extensionFields = extensionAlternatives
    .flatMap((entry) => entry?.required ?? [])
    .sort();
  assertContract(
    JSON.stringify(extensionFields) ===
      JSON.stringify(['max_active_seconds', 'max_worker_dispatches']),
    host,
    'extend-budget does not require at least one replacement cap',
  );
  assertContract(runSchema?.properties?.reason?.minLength === 1, host, 'extend-budget reason is not nonblank');
  for (const field of ['max_worker_dispatches', 'max_active_seconds']) {
    const cap = runSchema?.properties?.[field];
    assertContract(cap?.type === 'integer' && cap?.minimum === 1, host, `${field} is not a positive integer`);
    assertContract(/current cap/i.test(cap?.description ?? ''), host, `${field} does not publish its monotonic current-cap contract`);
  }

  const capabilities = runSchema?.properties?.required_capabilities;
  assertContract(capabilities?.type === 'array' && capabilities?.maxItems === 64, host, 'required_capabilities is not a bounded array');
  const variants = capabilities?.items?.oneOf ?? [];
  const kinds = variants.map((variant) => variant?.properties?.kind?.const).sort();
  assertContract(
    JSON.stringify(kinds) === JSON.stringify([
      'command_profile',
      'evidence_command',
      'tool_claim',
      'verification_profile',
    ]),
    host,
    `required_capabilities variants are not exact: ${JSON.stringify(kinds)}`,
  );
  for (const variant of variants) {
    const kind = variant?.properties?.kind?.const ?? 'unknown';
    assertContract(variant?.type === 'object' && variant?.additionalProperties === false, host, `${kind} capability is not a closed object`);
    assertContract(
      JSON.stringify([...(variant?.required ?? [])].sort()) === JSON.stringify(['id', 'kind']),
      host,
      `${kind} capability does not require exactly kind and id`,
    );
  }
  const capabilityByKind = new Map(variants.map((variant) => [variant.properties.kind.const, variant]));
  assertContract(
    capabilityByKind.get('command_profile')?.properties?.id?.pattern ===
      '^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$' &&
      capabilityByKind.get('command_profile')?.properties?.role?.minLength === 1,
    host,
    'command_profile capability does not publish its exact ID/optional-role shape',
  );
  assertContract(
    capabilityByKind.get('verification_profile')?.properties?.id?.pattern ===
      '^[A-Za-z][A-Za-z0-9._-]{0,63}$',
    host,
    'verification_profile capability does not publish its exact ID shape',
  );
  assertContract(
    capabilityByKind.get('evidence_command')?.properties?.id?.minLength === 1,
    host,
    'evidence_command capability does not require a nonblank exact command ID',
  );
  assertContract(
    /read\|write\|execute/.test(capabilityByKind.get('tool_claim')?.properties?.id?.pattern ?? ''),
    host,
    'tool_claim capability does not publish the canonical access-ID grammar',
  );

  const validateSchema = byName.get('ape_validate_receipt')?.inputSchema;
  assertContract(validateSchema?.type === 'object' && validateSchema?.additionalProperties === false, host, 'ape_validate_receipt is not a closed object');
  assertContract(
    JSON.stringify([...(validateSchema?.required ?? [])].sort()) === JSON.stringify(['draft', 'ticket_id']),
    host,
    'ape_validate_receipt does not require exactly ticket_id and draft',
  );
  assertContract(validateSchema?.properties?.ticket_id?.minLength === 1, host, 'ape_validate_receipt ticket_id is not nonblank');
  assertContract(validateSchema?.properties?.draft?.type === 'object', host, 'ape_validate_receipt draft is not an object');
}

function assertPreviewContract(host, response) {
  assertContract(response?.result?.isError !== true, host, 'bounded preview call returned a tool error');
  const text = response?.result?.content?.find((entry) => entry?.type === 'text')?.text;
  let preview;
  try {
    preview = JSON.parse(text);
  } catch {
    throw new Error(`${host} package MCP contract mismatch: preview result is not JSON`);
  }
  const readiness = preview?.blueprint?.readiness;
  assertContract(
    readiness?.derived_capability_requirements &&
      Array.isArray(readiness.derived_capability_requirements.stage_roles) &&
      Array.isArray(readiness.derived_capability_requirements.stage_checks) &&
      Array.isArray(readiness.derived_capability_requirements.test_runner_profiles),
    host,
    'preview omits derived capability requirements',
  );
  const forecast = readiness?.execution_budget;
  assertContract(
    Number.isInteger(forecast?.minimum?.worker_dispatches) &&
      Number.isInteger(forecast?.worst_case?.worker_dispatches) &&
      Number.isInteger(forecast?.maximum_receipt_submissions) &&
      typeof forecast?.covers_minimum_worker_dispatches === 'boolean',
    host,
    'preview omits the bounded execution-budget forecast',
  );
}

function expandRoot(value, host, pluginRoot) {
  if (host === 'claude') return value.replaceAll('${CLAUDE_PLUGIN_ROOT}', pluginRoot);
  return isAbsolute(value) ? value : resolve(pluginRoot, value);
}

async function smoke(host, pluginRoot) {
  const config = JSON.parse(await readFile(join(pluginRoot, '.mcp.json'), 'utf8'));
  const server = config?.mcpServers?.ape;
  if (server?.command !== 'node' || !Array.isArray(server.args)) {
    throw new Error(`${host} package has no local node MCP declaration`);
  }
  const args = server.args.map((value, index) =>
    index === 0 ? expandRoot(value, host, pluginRoot) : value
  );
  const env = { ...process.env };
  delete env.CLAUDE_PROJECT_DIR;
  delete env.CODEX_CWD;
  if (host === 'claude') env.CLAUDE_PLUGIN_ROOT = pluginRoot;
  else env.PLUGIN_ROOT = pluginRoot;

  // The preview contract must not depend on this checkout's live APE config,
  // active state, Git dirt, or operator policy. A marker-only project with an
  // explicit empty config gives both packaged hosts the same deterministic,
  // disposable readiness surface.
  const fixture = await mkdtemp(join(tmpdir(), `ape-plugin-smoke-${host}-`));
  await mkdir(join(fixture, '.ape', 'runtime'), { recursive: true });
  await writeFile(join(fixture, '.ape', 'runtime', 'config.json'), '{}\n');

  let responses;
  try {
    responses = await new Promise((resolvePromise, reject) => {
      const child = spawn(process.execPath, args, {
        cwd: server.cwd ? resolve(pluginRoot, server.cwd) : pluginRoot,
        env,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      let stdout = '';
      let stderr = '';
      const timer = setTimeout(() => {
        child.kill();
        reject(new Error(`${host} package MCP smoke timed out`));
      }, 10_000);
      child.stdout.setEncoding('utf8');
      child.stderr.setEncoding('utf8');
      child.stdout.on('data', (chunk) => { stdout += chunk; });
      child.stderr.on('data', (chunk) => { stderr += chunk; });
      child.on('error', reject);
      child.on('close', (code) => {
        clearTimeout(timer);
        if (code !== 0) reject(new Error(`${host} package MCP exited ${code}: ${stderr}`));
        else resolvePromise(stdout.trim().split(/\r?\n/u).filter(Boolean).map((line) => JSON.parse(line)));
      });
      child.stdin.end([
        { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } },
        { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} },
        {
          jsonrpc: '2.0',
          id: 3,
          method: 'tools/call',
          params: {
            name: 'ape_run',
            arguments: {
              action: 'preview',
              project_dir: fixture,
              objective: 'Verify the packaged MCP readiness contract',
              mode: 'debug',
              lane: 'auto',
              host,
              claimed_paths: ['src/example.js'],
              tool_claims: [],
              test_paths: [],
              requirements: [],
              risk_triggers: [],
              behavioral: false,
              hooks_trusted: true,
              subagents_available: true,
              explicit_invocation: true,
              required_capabilities: [],
              execution_budget: {
                max_worker_dispatches: 4,
                max_active_seconds: 3_600,
              },
            },
          },
        },
      ].map((message) => JSON.stringify(message)).join('\n') + '\n');
    });
  } finally {
    await rm(fixture, { recursive: true, force: true });
  }
  const byId = new Map(responses.filter((response) => response?.id !== undefined).map((response) => [response.id, response]));
  if (byId.get(1)?.result?.serverInfo?.version !== VERSION) {
    throw new Error(`${host} package MCP returned the wrong server version`);
  }
  const tools = byId.get(2)?.result?.tools ?? [];
  const toolNames = tools.map((tool) => tool.name);
  if (JSON.stringify(toolNames) !== JSON.stringify(EXPECTED_TOOLS)) {
    throw new Error(`${host} package MCP returned the wrong tool surface: ${JSON.stringify(toolNames)}`);
  }
  assertToolContract(host, tools);
  assertPreviewContract(host, byId.get(3));
  process.stdout.write(`${host} package local stdio MCP initialized with the bounded run contract\n`);
}

for (const [host, pluginRoot] of PACKAGES) await smoke(host, pluginRoot);
