import { access, lstat } from 'node:fs/promises';
import path from 'node:path';
import { readBoundedRegularFileUtf8 } from './spawn.js';

// Merge preflight runs in-process: an untrusted FIFO or unbounded JSON file
// must produce a validation failure instead of blocking the runtime worker.
const MAX_PLUGIN_JSON_BYTES = 1024 * 1024;
const readPluginJson = async (file) => JSON.parse(await readBoundedRegularFileUtf8(file, {
  maxBytes: MAX_PLUGIN_JSON_BYTES,
}));

async function exists(file) {
  try {
    await access(file);
    return true;
  } catch {
    return false;
  }
}

const PLUGIN_NAME_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

function insidePluginRoot(projectDir, resolved) {
  // Structural manifest-path validation is lexical, matching the existing
  // Claude component checks; this is not a filesystem symlink confinement boundary.
  const root = path.resolve(projectDir);
  return resolved === root || resolved.startsWith(`${root}${path.sep}`);
}

async function validateComponentPaths(projectDir, field, value, errors) {
  const entries = Array.isArray(value) ? value : [value];
  for (const entry of entries) {
    if (typeof entry !== 'string' || entry.length === 0) {
      errors.push(`invalid ${field} path`);
      continue;
    }
    const resolved = path.resolve(projectDir, entry);
    if (!insidePluginRoot(projectDir, resolved)) {
      errors.push(`${field} path escapes the plugin root`);
    } else if (!await exists(resolved)) {
      errors.push(`${field} path does not exist`);
    }
  }
}

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

async function validateMcpServerMap(projectDir, value, label, errors) {
  if (!isObject(value)) {
    errors.push(`${label} must contain an MCP server object`);
    return;
  }
  // Host companion formats support a direct server map and wrapped maps.
  const servers = Object.hasOwn(value, 'mcpServers') ? value.mcpServers
    : Object.hasOwn(value, 'mcp_servers') ? value.mcp_servers : value;
  if (!isObject(servers)) {
    errors.push(`${label} must contain an MCP server object`);
    return;
  }
  for (const [name, server] of Object.entries(servers)) {
    const entry = `${label}.${name}`;
    if (!name || !isObject(server)) {
      errors.push(`${entry} must be an MCP server object`);
      continue;
    }
    // Both stdio commands and remote HTTP/SSE servers are valid host inputs.
    // These are structural checks only; do not launch servers, resolve host
    // environment substitutions, or probe authenticated network endpoints.
    if (server.command !== undefined) {
      if (typeof server.command !== 'string' || !server.command.length) {
        errors.push(`${entry} has an invalid command`);
      } else if (server.command.startsWith('./') && !await exists(path.resolve(projectDir, server.command))) {
        errors.push(`${entry} command does not exist`);
      }
    } else if (typeof server.url !== 'string' || !server.url.length) {
      errors.push(`${entry} must declare a command or URL`);
    }
    if (server.url !== undefined && (typeof server.url !== 'string' || !server.url.length)) {
      errors.push(`${entry} has an invalid URL`);
    }
    if (server.args !== undefined && (!Array.isArray(server.args) || server.args.some((arg) => typeof arg !== 'string'))) {
      errors.push(`${entry} args must be an array of strings`);
    }
    if (server.env !== undefined && (!isObject(server.env) || Object.values(server.env).some((item) => typeof item !== 'string'))) {
      errors.push(`${entry} env must be an object of strings`);
    }
  }
}

async function validateMcpComponents(projectDir, declaration, errors, host) {
  const files = new Set();
  // Both hosts discover the conventional companion even when its optional
  // manifest field is absent. Malformed discovered bytes must still fail.
  try {
    await lstat(path.join(projectDir, '.mcp.json'));
    files.add('.mcp.json');
  } catch (error) {
    if (error.code !== 'ENOENT') errors.push('cannot inspect default MCP companion');
  }
  if (declaration !== undefined) {
    if (isObject(declaration)) {
      await validateMcpServerMap(projectDir, declaration, 'mcpServers', errors);
    } else {
      const entries = host === 'claude' && Array.isArray(declaration) ? declaration : [declaration];
      for (const entry of entries) {
        if (typeof entry !== 'string') {
          errors.push('invalid mcpServers path');
          continue;
        }
        const before = errors.length;
        await validateComponentPaths(projectDir, 'mcpServers', entry, errors);
        if (errors.length !== before) continue;
        if (host === 'codex' && path.normalize(entry) !== '.mcp.json') {
          errors.push('mcpServers companion path must resolve to .mcp.json');
          continue;
        }
        files.add(path.normalize(entry));
      }
    }
  }
  for (const file of files) {
    let parsed;
    try { parsed = await readPluginJson(path.resolve(projectDir, file)); }
    catch {
      // JSON parse errors can include companion contents such as credentials.
      errors.push(`MCP companion ${file} is not valid bounded regular JSON`);
      continue;
    }
    await validateMcpServerMap(projectDir, parsed, `MCP companion ${file}`, errors);
  }
}

// Fields the official Claude plugin manifest schema knows about; anything
// else is flagged (`claude plugin validate` warns, and `--strict` promotes
// the warning to a failure).
const CLAUDE_MANIFEST_FIELDS = new Set([
  '$schema', 'name', 'version', 'description', 'author', 'homepage',
  'repository', 'license', 'keywords', 'commands', 'agents', 'skills',
  'hooks', 'mcpServers',
]);

// Lifecycle events the official hook schema accepts as event-map keys.
// Calibrated empirically against `claude plugin validate [--strict]` 2.1.201
// and https://code.claude.com/docs/en/hooks: every event below passed the
// CLI probe with a valid hook entry, and unknown events fail in both modes.
const CLAUDE_HOOK_EVENTS = new Set([
  'SessionStart', 'Setup', 'UserPromptSubmit', 'UserPromptExpansion',
  'PreToolUse', 'PermissionRequest', 'PermissionDenied', 'PostToolUse',
  'PostToolUseFailure', 'PostToolBatch', 'Notification', 'MessageDisplay',
  'SubagentStart', 'SubagentStop', 'TaskCreated', 'TaskCompleted', 'Stop',
  'StopFailure', 'TeammateIdle', 'InstructionsLoaded', 'ConfigChange',
  'CwdChanged', 'FileChanged', 'WorktreeCreate', 'WorktreeRemove',
  'PreCompact', 'PostCompact', 'Elicitation', 'ElicitationResult',
  'SessionEnd',
]);

// Official hook handler types mapped to their type-specific REQUIRED string
// fields. Calibrated against CLI 2.1.201: the official validator enforces
// presence + string type only (an empty `command`/`prompt`/`server` string
// passes), except `http.url`, which must additionally parse as a URL — the
// docs just say "URL", but the CLI rejects unparseable strings, and the CLI
// verdict wins.
const CLAUDE_HOOK_ENTRY_TYPES = new Map([
  ['command', ['command']],
  ['prompt', ['prompt']],
  ['agent', ['prompt']],
  ['http', ['url']],
  ['mcp_tool', ['server', 'tool']],
]);

function parsesAsUrl(value) {
  try {
    new URL(value);
    return true;
  } catch {
    return false;
  }
}

// Validate an event map (`{ EventName: [ { matcher?, hooks: [entry] } ] }`)
// the way the official validator does: known event keys, arrays of matcher
// groups, each group carrying a `hooks` array of typed handler entries.
// Unknown extra keys inside groups/entries are tolerated, matching the
// official schema's passthrough behavior.
function validateHookEventMap(events, label, errors) {
  if (!events || typeof events !== 'object' || Array.isArray(events)) {
    errors.push(`${label}: hook events must be an object`);
    return;
  }
  for (const [event, groups] of Object.entries(events)) {
    if (!CLAUDE_HOOK_EVENTS.has(event)) {
      errors.push(`${label}: unknown hook event ${event}`);
      continue;
    }
    if (!Array.isArray(groups)) {
      errors.push(`${label}: hook event ${event} must be an array`);
      continue;
    }
    for (const group of groups) {
      if (!group || typeof group !== 'object' || Array.isArray(group)) {
        errors.push(`${label}: hook event ${event} contains a non-object matcher group`);
        continue;
      }
      if (group.matcher !== undefined && typeof group.matcher !== 'string') {
        errors.push(`${label}: hook event ${event} matcher must be a string`);
      }
      if (!Array.isArray(group.hooks)) {
        errors.push(`${label}: hook event ${event} group is missing its hooks array`);
        continue;
      }
      for (const entry of group.hooks) {
        if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
          errors.push(`${label}: hook event ${event} contains a non-object hook entry`);
          continue;
        }
        const required = CLAUDE_HOOK_ENTRY_TYPES.get(entry.type);
        if (!required) {
          errors.push(`${label}: hook event ${event} entry has invalid type`);
          continue;
        }
        for (const field of required) {
          if (typeof entry[field] !== 'string') {
            errors.push(`${label}: hook event ${event} entry is missing its ${field}`);
          }
        }
        // CLI 2.1.201 additionally requires http URLs to parse (any scheme,
        // including `${VAR}` interpolation hosts, is accepted).
        if (entry.type === 'http' && typeof entry.url === 'string' && !parsesAsUrl(entry.url)) {
          errors.push(`${label}: hook event ${event} entry url is not a parseable URL`);
        }
      }
    }
  }
}

// A hook manifest FILE wraps the event map under a top-level `hooks` key; an
// INLINE manifest `hooks` object is the bare event map itself. Both shapes
// mirror the official validator exactly.
async function validateClaudeHooks(projectDir, value, errors) {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    validateHookEventMap(value, 'hooks (inline)', errors);
    return;
  }
  const before = errors.length;
  await validateComponentPaths(projectDir, 'hooks', value, errors);
  if (errors.length > before) return;
  for (const entry of Array.isArray(value) ? value : [value]) {
    const resolved = path.resolve(projectDir, entry);
    let parsed;
    try {
      parsed = await readPluginJson(resolved);
    } catch (error) {
      errors.push(`hooks manifest ${entry} is not valid JSON: ${error.message}`);
      continue;
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)
      || !parsed.hooks || typeof parsed.hooks !== 'object' || Array.isArray(parsed.hooks)) {
      errors.push(`hooks manifest ${entry} must declare a top-level hooks object`);
      continue;
    }
    validateHookEventMap(parsed.hooks, `hooks manifest ${entry}`, errors);
  }
}

// In-process structural validation of the Claude plugin manifest. The merge
// gate must stay host-agnostic (invariant 6): it can never shell out to a
// `claude` binary that other hosts do not have. Behavior is calibrated
// against `claude plugin validate` (see the parity fixture suite): `errors`
// mirror the official load-blocking errors, `warnings` mirror the official
// warnings that only `--strict` promotes to failures.
export async function validateClaudePlugin(projectDir, { strict = false } = {}) {
  const manifestPath = path.join(projectDir, '.claude-plugin', 'plugin.json');
  const errors = [];
  const warnings = [];
  let manifest;
  try {
    manifest = await readPluginJson(manifestPath);
  } catch (error) {
    return { passed: false, errors: [`cannot read Claude manifest: ${error.message}`], warnings };
  }
  // A structurally wrong manifest must RESOLVE with the documented failure
  // shape, never reject: a literal `null` manifest parses fine and then throws a
  // raw TypeError on the first field dereference below. Every key the success
  // return carries is returned here too, so no consumer that destructures loses
  // one.
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) {
    return { passed: false, errors: ['Claude plugin manifest must be a JSON object'], warnings, manifest };
  }
  if (typeof manifest.name !== 'string' || !PLUGIN_NAME_PATTERN.test(manifest.name)) {
    errors.push('invalid plugin name');
  }
  if (manifest.version === undefined) warnings.push('missing plugin version');
  else if (typeof manifest.version !== 'string' || manifest.version.length === 0) {
    errors.push('invalid plugin version');
  }
  if (manifest.description === undefined) warnings.push('missing plugin description');
  for (const field of ['description', 'homepage', 'license']) {
    if (manifest[field] !== undefined && typeof manifest[field] !== 'string') errors.push(`invalid plugin ${field}`);
  }
  if (manifest.author === undefined) {
    warnings.push('missing plugin author');
  } else {
    const author = manifest.author;
    if (!author || typeof author !== 'object' || Array.isArray(author)
      || typeof author.name !== 'string' || author.name.length === 0) {
      errors.push('invalid plugin author');
    }
  }
  if (manifest.keywords !== undefined
    && (!Array.isArray(manifest.keywords) || manifest.keywords.some((keyword) => typeof keyword !== 'string'))) {
    errors.push('invalid plugin keywords');
  }
  for (const field of Object.keys(manifest)) {
    if (!CLAUDE_MANIFEST_FIELDS.has(field)) warnings.push(`unknown manifest field ${field}`);
  }
  // Component fields accept a relative path (or array of paths) into the
  // plugin; hooks and mcpServers additionally accept an inline object.
  for (const field of ['commands', 'agents', 'skills']) {
    if (manifest[field] !== undefined) await validateComponentPaths(projectDir, field, manifest[field], errors);
  }
  if (manifest.hooks !== undefined) await validateClaudeHooks(projectDir, manifest.hooks, errors);
  await validateMcpComponents(projectDir, manifest.mcpServers, errors, 'claude');
  const passed = errors.length === 0 && (!strict || warnings.length === 0);
  return { passed, errors, warnings, manifest };
}

export async function validateCodexPlugin(projectDir) {
  const manifestPath = path.join(projectDir, '.codex-plugin', 'plugin.json');
  const errors = [];
  let manifest;
  try {
    manifest = await readPluginJson(manifestPath);
  } catch (error) {
    return { passed: false, errors: [`cannot read Codex manifest: ${error.message}`] };
  }
  // Same structural guard as the Claude side: resolve with the documented
  // failure shape (including `manifest`) instead of dereferencing null.
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) {
    return { passed: false, errors: ['Codex plugin manifest must be a JSON object'], manifest };
  }
  if (typeof manifest.name !== 'string' || !PLUGIN_NAME_PATTERN.test(manifest.name)) {
    errors.push('invalid plugin name');
  }
  if (typeof manifest.version !== 'string' || manifest.version.length === 0) errors.push('missing plugin version');
  // `skills` is optional in the official schema (components are discovered by
  // convention); when declared it must be a real path inside the plugin.
  if (manifest.skills !== undefined) {
    if (typeof manifest.skills !== 'string' || manifest.skills.length === 0) {
      errors.push('invalid skills path');
    } else {
      await validateComponentPaths(projectDir, 'skills', manifest.skills, errors);
    }
  }
  await validateMcpComponents(projectDir, manifest.mcpServers, errors, 'codex');
  return { passed: errors.length === 0, errors, manifest };
}
