#!/usr/bin/env node

import childProcess, { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { accessSync, closeSync, constants, existsSync, fstatSync, lstatSync, mkdtempSync, openSync, opendirSync, readFileSync, readSync, realpathSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseToml } from 'smol-toml';
import { verifyLiveCertificationEnvironment } from './check-live-certification-environment.mjs';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const RELEASE_VERSION = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version;
const CODEX_HOST_VERSION = JSON.parse(readFileSync(path.join(ROOT, 'compatibility.json'), 'utf8')).hosts?.codex?.version;
const CATALOG_STUB = path.join(ROOT, 'scripts', 'live-certification-catalog-stub.mjs');
const FAIL_CLOSED_CATALOG_URL = 'http://127.0.0.1:1';
const MAX_CODEX_CONFIG_BYTES = 256 * 1024;
const MAX_HOST_VERSION_BYTES = 4_096;

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

function requirePinnedCodexExecutable(codexBin, project, home) {
  if (typeof codexBin !== 'string' || !path.isAbsolute(codexBin)) {
    throw new LiveCertificationParentError('an explicit absolute --codex-bin path is required; PATH lookup is not accepted');
  }
  let command;
  let before;
  try {
    command = realpathSync(codexBin);
    before = statSync(command);
    if (!before.isFile()) throw new Error('not a regular executable');
    accessSync(command, process.platform === 'win32' ? constants.F_OK : constants.X_OK);
  } catch {
    throw new LiveCertificationParentError('--codex-bin must resolve to an accessible regular executable file');
  }
  if (typeof CODEX_HOST_VERSION !== 'string' || !/^\d+\.\d+\.\d+$/u.test(CODEX_HOST_VERSION)) {
    throw new LiveCertificationParentError('the source compatibility.json Codex version pin is invalid; correct it before launch');
  }
  const refusal = `Codex version check must report exactly codex-cli ${CODEX_HOST_VERSION} within 5 seconds and 4096 output bytes; select the pinned executable without upgrading the host`;
  try {
    const result = childProcess.spawnSync(command, ['--version'], {
      cwd: project,
      env: { ...process.env, CODEX_HOME: home },
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 5_000,
      killSignal: 'SIGKILL',
      maxBuffer: MAX_HOST_VERSION_BYTES,
      windowsHide: true,
      shell: false,
    });
    if (!result || result.error || result.status !== 0 || result.signal
      || !Buffer.isBuffer(result.stdout) || !Buffer.isBuffer(result.stderr)
      || result.stdout.length + result.stderr.length > MAX_HOST_VERSION_BYTES) throw new Error('invalid version result');
    const version = new TextDecoder('utf-8', { fatal: true }).decode(result.stdout);
    const expected = `codex-cli ${CODEX_HOST_VERSION}`;
    if (![expected, `${expected}\n`, `${expected}\r\n`].includes(version)) throw new Error('wrong version');
    const after = statSync(command);
    if (!after.isFile() || ['dev', 'ino', 'size', 'mode', 'mtimeMs', 'ctimeMs'].some((key) => before[key] !== after[key])) {
      throw new Error('executable changed during version check');
    }
  } catch {
    // Never include executable output, an OS error, or a user-controlled path.
    throw new LiveCertificationParentError(refusal);
  }
  // A resolved path and self-reported version are not host-loaded byte attestation.
  // In-place replacement after this check remains a race; no atomic exec-by-digest is claimed.
  return command;
}

function readCertificationConfig(codexHome) {
  const configPath = path.join(codexHome, 'config.toml');
  let fd;
  let contents;
  try {
    const before = lstatSync(configPath);
    if (!before.isFile() || before.size > MAX_CODEX_CONFIG_BYTES) throw new Error();
    fd = openSync(configPath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
    const opened = fstatSync(fd);
    if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino || opened.size !== before.size) {
      throw new Error();
    }
    // One extra byte detects growth without an unbounded read or a FIFO wait.
    const bytes = Buffer.alloc(before.size + 1);
    let count = 0;
    while (count < bytes.length) {
      const read = readSync(fd, bytes, count, bytes.length - count, null);
      if (read === 0) break;
      count += read;
    }
    const after = fstatSync(fd);
    if (count !== before.size || after.size !== before.size ||
        after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs) throw new Error();
    contents = new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, count));
  } catch {
    throw new LiveCertificationParentError(
      'isolated Codex config.toml must be a readable, stable UTF-8 regular file of at most 262144 bytes; symlinks are not accepted',
    );
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
  try {
    // Keep TOML integer types: 0.0 and 0e0 are not u64 retry counts in Codex.
    const parsed = parseToml(contents, { maxDepth: 32, integersAsBigInt: true });
    // The parser's recursion bound covers values; also bound dotted/header
    // table nesting and the complete graph before selecting authority fields.
    /** @type {Array<{ value: unknown, depth: number }>} */
    const pending = [{ value: parsed, depth: 0 }];
    let nodes = 0;
    while (pending.length > 0) {
      const { value, depth } = pending.pop();
      if (++nodes > 10_000 || depth > 32) throw new Error();
      if (value !== null && typeof value === 'object') {
        for (const child of Object.values(value)) pending.push({ value: child, depth: depth + 1 });
      }
    }
    return parsed;
  } catch {
    // Parser messages can contain configuration lines (including credentials).
    throw new LiveCertificationParentError(
      'isolated Codex config.toml must be valid TOML without duplicate keys or excessive nesting; correct the file before launch',
    );
  }
}

function configTable(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value) && !(value instanceof Date)
    ? value : null;
}

function ownConfigValue(value, key) {
  return configTable(value) && Object.hasOwn(value, key) ? value[key] : undefined;
}

function requireDeterministicConfig(codexHome) {
  const config = readCertificationConfig(codexHome);
  // This bounded launcher uses one isolated file, not partial profile merging.
  if (Object.hasOwn(config, 'profile') || Object.hasOwn(config, 'profiles')) {
    throw new LiveCertificationParentError(
      'isolated Codex certification does not accept profile overrides; flatten the reviewed settings into config.toml before launch',
    );
  }
  const providerId = ownConfigValue(config, 'model_provider');
  if (typeof providerId !== 'string' || providerId.trim().length === 0) {
    throw new LiveCertificationParentError('isolated Codex config must declare an explicit top-level model_provider');
  }
  if (['openai', 'ollama', 'lmstudio', 'amazon-bedrock'].includes(providerId)) {
    throw new LiveCertificationParentError(
      'isolated Codex certification requires a custom model_provider with explicit zero retries; built-in provider definitions cannot establish this contract',
    );
  }
  const providers = ownConfigValue(config, 'model_providers');
  if (['openai', 'ollama', 'lmstudio'].some((id) => ownConfigValue(providers, id) !== undefined)) {
    throw new LiveCertificationParentError(
      'isolated Codex model_providers must not redefine reserved built-in providers, even when inactive; use a custom provider name',
    );
  }
  const provider = configTable(ownConfigValue(providers, providerId));
  if (!provider) {
    throw new LiveCertificationParentError(
      'isolated Codex model_provider must select its own declared model_providers table with explicit transport settings',
    );
  }
  if (typeof ownConfigValue(provider, 'name') !== 'string' || provider.name.trim().length === 0) {
    throw new LiveCertificationParentError('the selected Codex model_providers table must declare a non-empty name');
  }
  const requirements = [
    { key: 'request_max_retries', value: 0n, description: 'request_max_retries = 0 (TOML integer)' },
    { key: 'stream_max_retries', value: 0n, description: 'stream_max_retries = 0 (TOML integer)' },
    { key: 'supports_websockets', value: false, description: 'supports_websockets = false (TOML boolean)' },
  ];
  for (const { key, value, description } of requirements) {
    if (ownConfigValue(provider, key) !== value) {
      throw new LiveCertificationParentError(
        `the selected Codex model_providers table must declare ${description} for first-pass-perfect certification`,
      );
    }
  }
  if (ownConfigValue(ownConfigValue(config, 'analytics'), 'enabled') !== false) {
    throw new LiveCertificationParentError(
      'isolated Codex config must disable analytics to prevent optional event transport retries',
    );
  }
  const features = ownConfigValue(config, 'features');
  if (ownConfigValue(features, 'plugins') !== true) {
    throw new LiveCertificationParentError(
      'isolated Codex config must enable plugins so the installed local APE plugin is loaded',
    );
  }
  if (ownConfigValue(features, 'apps') !== false) {
    throw new LiveCertificationParentError(
      'isolated Codex config must disable apps so the catalog loopback cannot intercept the unrelated Apps MCP transport',
    );
  }
  if (ownConfigValue(features, 'remote_plugin') !== true) {
    throw new LiveCertificationParentError(
      'isolated Codex config must enable remote_plugin so Codex cannot fall back to legacy curated-plugin sync',
    );
  }
}

// Version labels alone do not identify plugin code. Compare the complete staged
// tree to this source checkout's packaged candidate, without following links or
// opening a FIFO. Bounds apply before reads; the digest contains no source text.
function candidatePackageInventory(base, relativeRoot) {
  const refuse = () => {
    throw new LiveCertificationParentError('candidate package parity requires a bounded regular-file tree without symlinks');
  };
  let root = base;
  for (const segment of relativeRoot.split('/')) {
    root = path.join(root, segment);
    if (!lstatSync(root).isDirectory()) refuse();
  }
  const entries = [];
  let bytes = 0;
  let fileCount = 0;
  /** @type {{version?: unknown} | null} */
  let packageJson = null;
  function visit(directory, prefix = '', depth = 0) {
    if (depth > 32 || !lstatSync(directory).isDirectory()) refuse();
    const handle = opendirSync(directory);
    try {
      for (let entry; (entry = handle.readSync()) !== null;) {
        if (entries.length >= 10_000) refuse();
        const name = `${prefix}${entry.name}`;
        const target = path.join(directory, entry.name);
        const before = lstatSync(target);
        if (before.isDirectory()) {
          entries.push([name, 'directory']);
          visit(target, `${name}/`, depth + 1);
        } else if (before.isFile()) {
          if (before.size > 64 * 1024 * 1024 || bytes + before.size > 256 * 1024 * 1024) refuse();
          const fd = openSync(target, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
          let contents;
          try {
            const opened = fstatSync(fd);
            if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino || opened.size !== before.size) refuse();
            contents = Buffer.alloc(before.size + 1);
            let count = 0;
            while (count < contents.length) {
              const read = readSync(fd, contents, count, contents.length - count, null);
              if (read === 0) break;
              count += read;
            }
            const after = fstatSync(fd);
            if (count !== before.size || after.size !== before.size || after.mtimeMs !== before.mtimeMs) refuse();
            contents = contents.subarray(0, count);
          } finally {
            closeSync(fd);
          }
          bytes += contents.length;
          fileCount += 1;
          entries.push([name, 'file', before.mode & 0o111, contents.length,
            createHash('sha256').update(contents).digest('hex')]);
          if (name === 'package.json') packageJson = JSON.parse(contents.toString('utf8'));
        } else refuse();
      }
    } finally {
      handle.closeSync();
    }
  }
  visit(root);
  entries.sort((a, b) => a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0);
  return { sha256: createHash('sha256').update(JSON.stringify(entries)).digest('hex'),
    file_count: fileCount, version: packageJson?.version };
}

function requireExactPlugin(codexHome) {
  let candidate;
  let installed;
  try {
    candidate = candidatePackageInventory(ROOT, 'plugins/ape');
    installed = candidatePackageInventory(codexHome, `plugins/cache/ape/ape/${RELEASE_VERSION}`);
  } catch (error) {
    if (error instanceof LiveCertificationParentError) throw error;
    throw new LiveCertificationParentError('candidate package parity could not be verified from bounded regular files');
  }
  if (candidate.version !== RELEASE_VERSION || installed.version !== RELEASE_VERSION ||
      candidate.sha256 !== installed.sha256) {
    throw new LiveCertificationParentError(`candidate package byte parity failed for cached ape@ape ${RELEASE_VERSION}`);
  }
  // This is staged parity, not a claim that a persistent host loaded this tree.
  return Object.freeze({ ...candidate, staged_parity: true });
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
  codexBin,
  operatorAuthorized = false,
  catalogBaseUrl = FAIL_CLOSED_CATALOG_URL,
}) {
  if (operatorAuthorized !== true) {
    throw new LiveCertificationParentError(
      '--operator-authorized requires explicit user approval for this exact attempt and its requested shipping actions; obtain that approval before launch',
    );
  }
  const project = exactDirectory(projectDir, '--project-dir');
  const home = exactDirectory(codexHome, '--codex-home');
  try {
    verifyLiveCertificationEnvironment(project);
  } catch (error) {
    throw new LiveCertificationParentError(error?.message ?? String(error));
  }
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
  const candidatePackage = requireExactPlugin(home);
  const command = requirePinnedCodexExecutable(codexBin, project, home);
  const catalogUrl = exactLoopbackCatalogUrl(catalogBaseUrl);
  // Carry an existing approval across the parent-process boundary. The flag is
  // caller attestation, not a source of permission or authenticated provenance.
  const authorizationHandoff = [
    'Separate operator authorization handoff (caller-attested):',
    `The invoking operator confirms that the user has explicitly approved this exact attempt in project_dir ${JSON.stringify(project)}.`,
    'That approval covers only the work and shipping actions described below for this project, not an arbitrary remote target.',
    'This handoff is not independent proof of human provenance and does not grant hook trust, repository permissions, or a gate waiver.',
    'Do not request this same approval again; stop if the scope or required safety prerequisites do not match.',
    'The unchanged generated prompt follows; it is not itself the separate approval.',
  ].join(' ');
  return Object.freeze({
    command,
    host_version: CODEX_HOST_VERSION,
    args: Object.freeze([
      'exec',
      '-c',
      `chatgpt_base_url=${JSON.stringify(catalogUrl)}`,
      '-c',
      'features.apps=false',
      '--sandbox',
      'workspace-write',
      '--color',
      'never',
      '-C',
      project,
      '-',
    ]),
    cwd: project,
    env: Object.freeze({
      CODEX_HOME: home,
      GIT_AUTHOR_NAME: 'APE Certification',
      GIT_AUTHOR_EMAIL: 'ape-certification@users.noreply.github.com',
      GIT_COMMITTER_NAME: 'APE Certification',
      GIT_COMMITTER_EMAIL: 'ape-certification@users.noreply.github.com',
    }),
    input: `${authorizationHandoff}\n\n${prompt}`,
    operator_authorized: true,
    candidate_package: candidatePackage,
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
  let operatorAuthorized = false;
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === '--dry-run') {
      dryRun = true;
      continue;
    }
    if (token === '--operator-authorized') {
      operatorAuthorized = true;
      continue;
    }
    if (!['--project-dir', '--codex-home', '--prompt', '--codex-bin'].includes(token) || !argv[index + 1]) {
      throw new LiveCertificationParentError(
        'usage: node scripts/run-live-certification-parent.mjs --project-dir <path> --codex-home <path> --prompt <file> --codex-bin <absolute-executable> --operator-authorized [--dry-run]',
      );
    }
    values[token.slice(2).replaceAll('-', '')] = argv[index + 1];
    index += 1;
  }
  return {
    dryRun,
    operatorAuthorized,
    projectDir: values.projectdir,
    codexHome: values.codexhome,
    promptPath: values.prompt,
    codexBin: values.codexbin,
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
        host_version: invocation.host_version,
        args: invocation.args,
        cwd: invocation.cwd,
        codex_home: invocation.env.CODEX_HOME,
        prompt_bytes: Buffer.byteLength(invocation.input),
        operator_authorized: invocation.operator_authorized,
        candidate_package: invocation.candidate_package,
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
