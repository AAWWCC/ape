#!/usr/bin/env node

import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const RELEASE_VERSION = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version;
const CATALOG_STUB = path.join(ROOT, 'scripts', 'live-certification-catalog-stub.mjs');
const FAIL_CLOSED_CATALOG_URL = 'http://127.0.0.1:1';

export class LiveCertificationParentError extends Error {
  constructor(message) {
    super(message);
    this.name = 'LiveCertificationParentError';
  }
}

function exactDirectory(value, label) {
  if (typeof value !== 'string' || value.length === 0) {
    throw new LiveCertificationParentError(`${label} is required`);
  }
  try {
    return realpathSync(value);
  } catch {
    throw new LiveCertificationParentError(`${label} does not resolve to an existing path`);
  }
}

function configTableBody(lines, table) {
  const start = lines.findIndex((line) => line.trim() === `[${table}]`);
  if (start === -1) {
    return [];
  }
  const nextTable = lines.findIndex(
    (line, index) => index > start && /^\s*\[\[?/u.test(line),
  );
  return lines.slice(start + 1, nextTable === -1 ? lines.length : nextTable);
}

function requireDeterministicConfig(codexHome) {
  const configPath = path.join(codexHome, 'config.toml');
  let config;
  try {
    config = readFileSync(configPath, 'utf8');
  } catch {
    throw new LiveCertificationParentError('isolated Codex home has no readable config.toml');
  }
  const requirements = [
    { pattern: /^model_provider\s*=\s*"[^"]+"\s*$/mu, description: 'an explicit model_provider' },
    { pattern: /^request_max_retries\s*=\s*0\s*$/mu, description: 'request_max_retries = 0' },
    { pattern: /^stream_max_retries\s*=\s*0\s*$/mu, description: 'stream_max_retries = 0' },
    { pattern: /^supports_websockets\s*=\s*false\s*$/mu, description: 'supports_websockets = false' },
  ];
  for (const { pattern, description } of requirements) {
    if (!pattern.test(config)) {
      throw new LiveCertificationParentError(
        `isolated Codex config must declare ${description} for first-pass-perfect certification`,
      );
    }
  }
  const lines = config.split(/\r?\n/u);
  const analyticsBody = configTableBody(lines, 'analytics');
  if (!analyticsBody.some((line) => /^\s*enabled\s*=\s*false\s*$/u.test(line))) {
    throw new LiveCertificationParentError(
      'isolated Codex config must disable analytics to prevent optional event transport retries',
    );
  }
  const featuresBody = configTableBody(lines, 'features');
  if (!featuresBody.some((line) => /^\s*plugins\s*=\s*true\s*$/u.test(line))) {
    throw new LiveCertificationParentError(
      'isolated Codex config must enable plugins so the installed local APE plugin is loaded',
    );
  }
  if (!featuresBody.some((line) => /^\s*apps\s*=\s*false\s*$/u.test(line))) {
    throw new LiveCertificationParentError(
      'isolated Codex config must disable apps so the catalog loopback cannot intercept the unrelated Apps MCP transport',
    );
  }
  if (!featuresBody.some((line) => /^\s*remote_plugin\s*=\s*true\s*$/u.test(line))) {
    throw new LiveCertificationParentError(
      'isolated Codex config must enable remote_plugin so Codex cannot fall back to legacy curated-plugin sync',
    );
  }
}

function requireExactPlugin(codexHome) {
  const packagePath = path.join(
    codexHome,
    'plugins',
    'cache',
    'ape',
    'ape',
    RELEASE_VERSION,
    'package.json',
  );
  let installed;
  try {
    installed = JSON.parse(readFileSync(packagePath, 'utf8'));
  } catch {
    throw new LiveCertificationParentError(
      `isolated Codex home does not contain cached ape@ape ${RELEASE_VERSION}`,
    );
  }
  if (installed.version !== RELEASE_VERSION) {
    throw new LiveCertificationParentError(
      `cached ape@ape version ${installed.version ?? '<missing>'} does not equal ${RELEASE_VERSION}`,
    );
  }
}

function requireReleaseShippingPolicy(project) {
  const configPath = path.join(project, '.ape', 'runtime', 'config.json');
  let config;
  try {
    config = JSON.parse(readFileSync(configPath, 'utf8'));
  } catch {
    throw new LiveCertificationParentError(
      'governed project has no readable .ape/runtime/config.json with release shipping enabled',
    );
  }
  if (config?.shipping?.auto_merge !== true) {
    throw new LiveCertificationParentError(
      'governed project must explicitly set shipping.auto_merge = true before first-pass-perfect certification',
    );
  }
  if (typeof config.shipping.required_remote_checks !== 'boolean') {
    throw new LiveCertificationParentError(
      'governed project must explicitly set shipping.required_remote_checks to match its CI topology before first-pass-perfect certification',
    );
  }
}

function requireExactPromptProject(prompt, project) {
  // The prompt deliberately contains both a prose directive (`project_dir
  // "/path"`) and exact JSON call templates (`"project_dir":"/path"`). A
  // regex beginning at the word inside the quoted JSON key mistakes the key's
  // closing quote for the value's opening quote and captures `:` as a path.
  // Keep the prose arm from starting immediately after a quote and recognize
  // the complete JSON key/value shape independently.
  const directives = [...prompt.matchAll(
    /(?:(?<!")\bproject_dir\b\s*(?::|=)?\s*|"project_dir"\s*:\s*)"([^"\r\n]+)"/gu,
  )];
  if (directives.length === 0) {
    throw new LiveCertificationParentError(
      '--prompt must declare the exact project_dir used for every APE control call',
    );
  }
  for (const directive of directives) {
    const declaredRaw = directive[1];
    let declared;
    try {
      declared = realpathSync(declaredRaw);
    } catch {
      throw new LiveCertificationParentError(
        `prompt project_dir ${declaredRaw} does not resolve to an existing path`,
      );
    }
    if (declared !== project) {
      throw new LiveCertificationParentError(
        `prompt project_dir ${declaredRaw} does not match --project-dir ${project}`,
      );
    }
  }
}

function exactLoopbackCatalogUrl(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new LiveCertificationParentError('catalog isolation URL must be a valid URL');
  }
  if (
    url.protocol !== 'http:'
    || url.hostname !== '127.0.0.1'
    || !url.port
    || url.username
    || url.password
    || url.pathname !== '/'
    || url.search
    || url.hash
  ) {
    throw new LiveCertificationParentError(
      'catalog isolation URL must be an exact loopback HTTP origin with an explicit port',
    );
  }
  return url.origin;
}

export function buildCodexParentInvocation({
  projectDir,
  codexHome,
  promptPath,
  catalogBaseUrl = FAIL_CLOSED_CATALOG_URL,
}) {
  const project = exactDirectory(projectDir, '--project-dir');
  const home = exactDirectory(codexHome, '--codex-home');
  if (typeof promptPath !== 'string' || !existsSync(promptPath)) {
    throw new LiveCertificationParentError('--prompt must name an existing file');
  }
  const prompt = readFileSync(promptPath, 'utf8');
  if (prompt.trim().length === 0) {
    throw new LiveCertificationParentError('--prompt must not be empty');
  }
  requireExactPromptProject(prompt, project);
  requireReleaseShippingPolicy(project);
  requireDeterministicConfig(home);
  requireExactPlugin(home);
  const catalogUrl = exactLoopbackCatalogUrl(catalogBaseUrl);
  return Object.freeze({
    command: 'codex',
    args: Object.freeze([
      'exec',
      '-c',
      `chatgpt_base_url=${JSON.stringify(catalogUrl)}`,
      '-c',
      'features.apps=false',
      '--dangerously-bypass-approvals-and-sandbox',
      '--dangerously-bypass-hook-trust',
      '--color',
      'never',
      '-C',
      project,
      '-',
    ]),
    cwd: project,
    env: Object.freeze({ CODEX_HOME: home }),
    input: prompt,
  });
}

export async function startCertificationCatalogStub(auditPath) {
  const child = spawn(process.execPath, [CATALOG_STUB, '--audit', auditPath], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stderr = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk) => {
    stderr = `${stderr}${chunk}`.slice(-4_000);
  });
  let baseUrl;
  try {
    baseUrl = await new Promise((resolve, reject) => {
      let stdout = '';
      const timeout = setTimeout(() => {
        reject(new LiveCertificationParentError('catalog isolation stub did not become ready'));
      }, 5_000);
      const fail = (message) => {
        clearTimeout(timeout);
        reject(new LiveCertificationParentError(`${message}${stderr ? `: ${stderr.trim()}` : ''}`));
      };
      child.once('error', (error) => fail(`catalog isolation stub failed to launch: ${error.message}`));
      child.once('exit', (code) => fail(`catalog isolation stub exited before ready with code ${code}`));
      child.stdout.setEncoding('utf8');
      child.stdout.on('data', (chunk) => {
        stdout += chunk;
        const newline = stdout.indexOf('\n');
        if (newline === -1) return;
        clearTimeout(timeout);
        try {
          const ready = JSON.parse(stdout.slice(0, newline));
          resolve(exactLoopbackCatalogUrl(ready.base_url));
        } catch (error) {
          reject(new LiveCertificationParentError(
            `catalog isolation stub returned invalid readiness data: ${error.message}`,
          ));
        }
      });
    });
  } catch (error) {
    child.kill('SIGKILL');
    throw error;
  }
  return Object.freeze({ child, baseUrl, stderr: () => stderr });
}

export async function stopCertificationCatalogStub(stub) {
  if (!stub || stub.child.exitCode !== null) return;
  await new Promise((resolve) => {
    const force = setTimeout(() => {
      stub.child.kill('SIGKILL');
    }, 1_000);
    stub.child.once('exit', () => {
      clearTimeout(force);
      resolve();
    });
    stub.child.kill('SIGTERM');
  });
}

export function validateCertificationCatalogAudit(auditPath) {
  let text;
  try {
    text = readFileSync(auditPath, 'utf8');
  } catch {
    throw new LiveCertificationParentError('catalog isolation stub produced no readable audit');
  }
  const lines = text.split(/\r?\n/u).filter(Boolean);
  if (lines.length === 0) {
    throw new LiveCertificationParentError('catalog isolation stub received no requests');
  }
  const records = lines.map((line, index) => {
    try {
      return JSON.parse(line);
    } catch {
      throw new LiveCertificationParentError(
        `catalog isolation audit line ${index + 1} is not valid JSON`,
      );
    }
  });
  const rejected = records.find((record) => record.known !== true || record.status !== 200);
  if (rejected) {
    throw new LiveCertificationParentError(
      `catalog isolation rejected unexpected request ${rejected.method ?? '<missing>'} ${rejected.url ?? '<missing>'}`,
    );
  }
  return Object.freeze({ request_count: records.length });
}

function parseArgs(argv) {
  const values = {};
  let dryRun = false;
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === '--dry-run') {
      dryRun = true;
      continue;
    }
    if (!['--project-dir', '--codex-home', '--prompt'].includes(token) || !argv[index + 1]) {
      throw new LiveCertificationParentError(
        'usage: node scripts/run-live-certification-parent.mjs --project-dir <path> --codex-home <path> --prompt <file> [--dry-run]',
      );
    }
    values[token.slice(2).replaceAll('-', '')] = argv[index + 1];
    index += 1;
  }
  return {
    dryRun,
    projectDir: values.projectdir,
    codexHome: values.codexhome,
    promptPath: values.prompt,
  };
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
  let catalogRoot;
  let catalogStub;
  try {
    const parsed = parseArgs(process.argv.slice(2));
    let invocation = buildCodexParentInvocation(parsed);
    if (parsed.dryRun) {
      process.stdout.write(`${JSON.stringify({
        command: invocation.command,
        args: invocation.args,
        cwd: invocation.cwd,
        codex_home: invocation.env.CODEX_HOME,
        prompt_bytes: Buffer.byteLength(invocation.input),
      })}\n`);
    } else {
      catalogRoot = mkdtempSync(path.join(tmpdir(), 'ape-live-catalog-'));
      const auditPath = path.join(catalogRoot, 'requests.jsonl');
      catalogStub = await startCertificationCatalogStub(auditPath);
      invocation = buildCodexParentInvocation({
        ...parsed,
        catalogBaseUrl: catalogStub.baseUrl,
      });
      const result = spawnSync(invocation.command, invocation.args, {
        cwd: invocation.cwd,
        env: { ...process.env, ...invocation.env },
        input: invocation.input,
        stdio: ['pipe', 'inherit', 'inherit'],
      });
      if (result.error) throw result.error;
      validateCertificationCatalogAudit(auditPath);
      process.exitCode = result.status ?? 1;
    }
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  } finally {
    await stopCertificationCatalogStub(catalogStub);
    if (catalogRoot) rmSync(catalogRoot, { recursive: true, force: true });
  }
}
