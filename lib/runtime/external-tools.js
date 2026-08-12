import path from 'node:path';

const APE_CONTROL = /(?:^|__)ape_(run|config|history)$/;
const ACCESS = new Set(['read', 'write', 'execute']);
const MUTATING = /(?:^|_)(?:add|apply|create|delete|duplicate|edit|import|manage|modify|move|open|refresh|remove|rename|save|set|start|stop|update)(?:_|$)/i;
const EXECUTING = /(?:^|_)(?:build|compile|execute|play|render|run|run_tests?|test|tests)(?:_|$)/i;
const READING = /(?:^|_)(?:active|capabilities|check|exists|find|get|hierarchy|info|inspect|list|ping|query|read|search|status|version)(?:_|$)/i;
const PATH_KEY = /(?:^|_)(?:(?:asset|file|output|prefab|project|scene|target)(?:_?path)?s?|(?:input_?)?image_?paths?|(?:code|script)_?paths?|file_?name|paths?)$/i;
const MAX_RESOURCES = 32;
const PLAYWRIGHT_READ = new Set([
  'browser_annotate',
  'browser_console_messages',
  'browser_find',
  'browser_get_config',
  'browser_hide_highlight',
  'browser_highlight',
  'browser_network_request',
  'browser_network_requests',
  'browser_route_list',
  'browser_snapshot',
  'browser_take_screenshot',
  'browser_generate_locator',
  'browser_verify_element_visible',
  'browser_verify_list_visible',
  'browser_verify_text_visible',
  'browser_verify_value',
]);
const PLAYWRIGHT_EXECUTE = /^(?:browser_(?:click|close|drag|drop|evaluate|file_upload|fill_form|handle_dialog|hover|navigate|navigate_back|navigate_forward|press_key|reload|resize|resume|run_code|select_option|set_storage_state|start_tracing|start_video|tabs|type|video_chapter|wait_for)|browser_mouse_(?:click_xy|down|drag_xy|move_xy|up|wheel)|browser_(?:cookie|localstorage|sessionstorage)_(?:clear|delete|set)|browser_(?:route|unroute|network_state_set))$/;
const PLAYWRIGHT_STORAGE_READ = /^browser_(?:cookie|localstorage|sessionstorage)_(?:get|list)$/;
const PLAYWRIGHT_FILE_OUTPUT = new Set([
  'browser_pdf_save',
  'browser_storage_state',
  'browser_stop_tracing',
  'browser_stop_video',
]);
const PLAYWRIGHT_PRIVILEGED_EXECUTION = new Set(['browser_run_code_unsafe']);
const PRIVILEGED_RESOURCE = 'server-rce';
// Reviewed against the official github/github-mcp-server tool snapshots. Only
// tools whose server declares readOnlyHint=true are admitted here. GitHub's
// mutation tools deliberately remain unknown: APE's runtime owns commits,
// pushes, PR publication, and merge, and an MCP annotation must never widen
// that shipping authority.
const GITHUB_READ = new Set([
  'actions_get',
  'actions_list',
  'find_duplicate',
  'get_code_quality_finding',
  'get_code_scanning_alert',
  'get_commit',
  'get_dependabot_alert',
  'get_discussion',
  'get_discussion_comments',
  'get_file_blame',
  'get_file_contents',
  'get_gist',
  'get_global_security_advisory',
  'get_job_logs',
  'get_label',
  'get_latest_release',
  'get_me',
  'get_notification_details',
  'get_release_by_tag',
  'get_repository_tree',
  'get_secret_scanning_alert',
  'get_tag',
  'get_team_members',
  'get_teams',
  'issue_dependency_read',
  'issue_read',
  'list_branches',
  'list_code_scanning_alerts',
  'list_commits',
  'list_dependabot_alerts',
  'list_discussion_categories',
  'list_discussions',
  'list_gists',
  'list_global_security_advisories',
  'list_issue_fields',
  'list_issue_types',
  'list_issues',
  'list_label',
  'list_notifications',
  'list_org_repository_security_advisories',
  'list_pull_requests',
  'list_releases',
  'list_repository_collaborators',
  'list_repository_security_advisories',
  'list_secret_scanning_alerts',
  'list_starred_repositories',
  'list_tags',
  'projects_get',
  'projects_list',
  'pull_request_read',
  'search_code',
  'search_commits',
  'search_issues',
  'search_orgs',
  'search_pull_requests',
  'search_repositories',
  'search_users',
  'ui_get',
]);
// ChatGPT-authenticated Codex sessions expose the GitHub plugin through the
// shared `codex_apps` server and prefix every operation with `github_`. This
// exact read list is intentionally separate from the hosted GitHub MCP list:
// the connector and github/github-mcp-server are different reviewed surfaces.
const GITHUB_CODEX_APP_READ = new Set([
  'compare_commits',
  'download_user_content',
  'download_workflow_artifact',
  'fetch',
  'fetch_blob',
  'fetch_commit',
  'fetch_commit_workflow_runs',
  'fetch_file',
  'fetch_issue',
  'fetch_issue_comments',
  'fetch_pr',
  'fetch_pr_comments',
  'fetch_pr_file_patch',
  'fetch_pr_patch',
  'fetch_workflow_job_logs',
  'fetch_workflow_job_steps',
  'fetch_workflow_run_artifacts',
  'fetch_workflow_run_jobs',
  'get_commit_combined_status',
  'get_issue_comment_reactions',
  'get_pr_diff',
  'get_pr_info',
  'get_pr_reactions',
  'get_pr_review_comment_reactions',
  'get_profile',
  'get_repo',
  'get_repo_collaborator_permission',
  'get_user_login',
  'get_users_recent_prs_in_repo',
  'list_installations',
  'list_installed_accounts',
  'list_pr_changed_filenames',
  'list_pull_request_review_threads',
  'list_pull_request_reviews',
  'list_recent_issues',
  'list_repositories',
  'list_repositories_by_affiliation',
  'list_repositories_by_installation',
  'list_user_org_memberships',
  'list_user_orgs',
  'search',
  'search_branches',
  'search_commits',
  'search_installed_reposito_be740b6e4965',
  'search_installed_repositories_v2',
  'search_issues',
  'search_prs',
  'search_repositories',
]);
const CODEX_SECURITY_READ = new Set([
  // The Codex Security plugin marks this model-visible operation read-only.
  // Starting scans and updating scan/remediation state remain unclassified.
  'open_codex_security_triage_results',
]);
// Trusted-provider operations that directly invoke caller-supplied code or a
// named editor command run with the MCP/editor process's authority, not merely
// inside the governed scene/page. Keep ordinary test execution and browser
// page-context JavaScript out of this tier.
const RAW_HOST_CODE_OPERATION = /(?:^|_)(?:execute|run)(?:_[a-z0-9]+)*_(?:code|script|method|csharp)(?:_|$)/i;

// Provider identity is authority: only exact, reviewed server IDs may borrow
// the built-in Unity/Blender/Playwright/GitHub/Codex Security effect
// classifiers and their compact
// claim namespaces. In particular, never inspect the operation name (or use a
// substring match on the server): `mcp__untrusted__unity_save_scene` must stay
// an unknown `untrusted` provider instead of inheriting `unity:*` claims.
//
// Claude's plugin MCP namespace is part of the explicit alias list because it
// exposes the official Playwright plugin as `plugin_playwright_playwright`.
// Other aliases cover the canonical names emitted by the supported standalone
// bridges. Adding a provider/server combination is therefore a deliberate
// reviewable code change rather than an accidental string collision.
const TRUSTED_PROVIDER_BY_SERVER = new Map([
  ['unity', 'unity'],
  // The Unity MCP package's documented/default server key is `UnityMCP`;
  // matching is case-insensitive, hence this exact lower-case entry.
  ['unitymcp', 'unity'],
  ['blender', 'blender'],
  ['playwright', 'playwright'],
  // Claude's official Playwright plugin namespaces plugin + MCP server.
  ['plugin_playwright_playwright', 'playwright'],
  ['github', 'github'],
  // Claude-style plugin namespaces are accepted only as an exact alias. Codex
  // currently exposes the plugin's declared MCP server name (`github`).
  ['plugin_github_github', 'github'],
  ['codex-security', 'codex-security'],
  ['plugin_codex_security_codex_security', 'codex-security'],
]);

export function parseMcpToolName(toolName) {
  if (typeof toolName !== 'string' || APE_CONTROL.test(toolName)) return null;
  if (!toolName.startsWith('mcp__')) return null;
  const rest = toolName.slice(5);
  const separator = rest.indexOf('__');
  if (separator <= 0 || separator === rest.length - 2) return null;
  return { server: rest.slice(0, separator), operation: rest.slice(separator + 2) };
}

function collectPaths(value, output, key = '', depth = 0) {
  if (depth > 5 || output.length >= MAX_RESOURCES) return;
  if (typeof value === 'string') {
    if (PATH_KEY.test(key) && value.length > 0 && value.length <= 4096) output.push(value);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectPaths(item, output, key, depth + 1);
    return;
  }
  if (!value || typeof value !== 'object') return;
  for (const [childKey, childValue] of Object.entries(value)) {
    collectPaths(childValue, output, childKey, depth + 1);
  }
}

function normalizedResourcePath(value) {
  const normalized = value.replaceAll('\\', '/').replace(/^\.\//, '');
  if (
    path.posix.isAbsolute(normalized) ||
    /^[A-Za-z]:\//.test(normalized) ||
    normalized.startsWith('../') ||
    normalized.includes('/../')
  ) {
    return null;
  }
  return normalized;
}

function unityResources(operation, input) {
  const lower = operation.toLowerCase();
  const resources = new Set();
  if (lower.includes('console')) resources.add('console');
  if (lower.includes('test')) resources.add('tests');
  if (lower.includes('build') || lower.includes('compile')) resources.add('build');
  if (lower.includes('play')) resources.add('play-mode');
  const candidates = [];
  collectPaths(input, candidates);
  const explicitFilename = input?.filename ?? input?.output_path ?? input?.outputPath;
  if (typeof explicitFilename === 'string' && !candidates.includes(explicitFilename)) {
    candidates.push(explicitFilename);
  }
  for (const candidate of candidates) {
    const relative = normalizedResourcePath(candidate);
    if (!relative) {
      resources.add('external-path');
      continue;
    }
    if (/\.unity$/i.test(relative)) resources.add(`scene:${relative}`);
    else if (/\.prefab$/i.test(relative)) resources.add(`prefab:${relative}`);
    else resources.add(`asset:${relative}`);
  }
  if (resources.size === 0) {
    if (lower.includes('scene')) resources.add('scene:*');
    else if (lower.includes('prefab')) resources.add('prefab:*');
    else resources.add('editor');
  }
  return [...resources].slice(0, MAX_RESOURCES);
}

function effectFromWords(words) {
  if (EXECUTING.test(words)) return 'execute';
  if (MUTATING.test(words)) return 'write';
  if (READING.test(words)) return 'read';
  return 'unknown';
}

function unityEffect(operation, input) {
  // Several Unity providers expose multiplexed `manage_*` tools whose `action`
  // determines the real effect. Inspect that verb first so `manage_scene` with
  // `action: get_hierarchy` stays a read instead of being over-classified as a
  // mutation. Never let caller-controlled action-like fields downgrade a
  // single-purpose tool such as `save_scene`: only a `manage_*` operation is
  // multiplexed, and everything else is classified from the privileged tool
  // name itself.
  if (/(?:^|_)manage(?:_|$)/i.test(operation)) {
    const action = input?.action ?? input?.operation ?? input?.command;
    if (typeof action === 'string') {
      const actionEffect = effectFromWords(action);
      if (actionEffect !== 'unknown') return actionEffect;
    }
  }
  const operationEffect = effectFromWords(operation);
  if (operationEffect !== 'unknown') return operationEffect;
  return 'unknown';
}

function safeIdentifier(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > 1024 || /[\0-\x1f\x7f]/.test(trimmed)) return null;
  return encodeURIComponent(trimmed);
}

function safeScalarIdentifier(value) {
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) {
    return String(value);
  }
  return safeIdentifier(value);
}

function addResource(resources, resource) {
  if (resource && resources.size < MAX_RESOURCES) resources.add(resource);
}

function privilegedInputResources(input) {
  const resources = new Set([PRIVILEGED_RESOURCE]);
  const candidates = [];
  collectPaths(input, candidates);
  for (const candidate of candidates) {
    const relative = normalizedResourcePath(candidate);
    addResource(resources, relative ? `file:${relative}` : 'external-file');
  }
  return [...resources];
}

function unityPrivilegedExecution(operation) {
  const lower = operation.toLowerCase();
  return lower === 'execute_menu_item' || RAW_HOST_CODE_OPERATION.test(lower);
}

function unityPrivilegedResources(operation, input) {
  // `menu_path` is a Unity menu identifier (for example Assets/Refresh), not a
  // filesystem input. Raw code/script operations still collect real file-path
  // parameters through the shared privileged input scanner.
  return operation.toLowerCase() === 'execute_menu_item'
    ? [PRIVILEGED_RESOURCE]
    : privilegedInputResources(input);
}

function blenderPrivilegedExecution(operation) {
  return RAW_HOST_CODE_OPERATION.test(operation.toLowerCase());
}

function blenderEffect(operation) {
  if (/(?:^|_)(?:execute|generate|render)(?:_|$)/i.test(operation)) return 'execute';
  if (/(?:^|_)(?:add|apply|create|delete|download|duplicate|edit|import|modify|move|remove|rename|save|set|update)(?:_|$)/i.test(operation)) return 'write';
  if (/(?:^|_)(?:capture|get|inspect|list|poll|preview|read|search|status)(?:_|$)/i.test(operation)) return 'read';
  return 'unknown';
}

function blenderResources(operation, input) {
  const lower = operation.toLowerCase();
  if (blenderPrivilegedExecution(lower)) return privilegedInputResources(input);
  const resources = new Set();
  const objectName = safeIdentifier(input?.object_name ?? input?.objectName);
  const assetId = safeIdentifier(input?.asset_id ?? input?.assetId ?? input?.texture_id ?? input?.textureId ?? input?.uid);
  const generatedName = safeIdentifier(input?.name ?? input?.task_uuid ?? input?.taskUuid ?? input?.request_id ?? input?.requestId);
  if (objectName) addResource(resources, `object:${objectName}`);
  if (assetId) addResource(resources, `asset:${assetId}`);
  if (lower.includes('polyhaven')) addResource(resources, 'catalog:polyhaven');
  if (lower.includes('sketchfab')) addResource(resources, 'catalog:sketchfab');
  if (lower.includes('hyper3d') || lower.includes('rodin')) addResource(resources, 'service:hyper3d');
  if (lower.includes('hunyuan')) addResource(resources, 'service:hunyuan3d');
  if (lower.includes('viewport') || lower.includes('screenshot')) addResource(resources, 'viewport');
  if (lower.includes('object') && !objectName) addResource(resources, 'object:*');
  if (
    lower.includes('scene') ||
    lower.includes('execute_blender_code') ||
    lower.includes('set_texture') ||
    lower.includes('download_') ||
    lower.includes('import_')
  ) addResource(resources, 'scene');
  if (generatedName && (lower.includes('generate') || lower.includes('import') || lower.includes('poll'))) {
    addResource(resources, `job:${generatedName}`);
  }
  const candidates = [];
  collectPaths(input, candidates);
  for (const candidate of candidates) {
    const relative = normalizedResourcePath(candidate);
    addResource(resources, relative ? `file:${relative}` : 'external-file');
  }
  if (resources.size === 0) addResource(resources, lower.includes('render') ? 'render' : 'editor');
  return [...resources];
}

function playwrightEffect(operation, input) {
  const lower = operation.toLowerCase();
  // The official unsafe runner's `filename` is INPUT code loaded into the MCP
  // server process, never an output artifact. Classify privileged execution
  // before the generic filename=>write rule.
  if (PLAYWRIGHT_PRIVILEGED_EXECUTION.has(lower)) return 'execute';
  const filename = input?.filename ?? input?.output_path ?? input?.outputPath;
  if (typeof filename === 'string' && filename.length > 0) return 'write';
  if (PLAYWRIGHT_FILE_OUTPUT.has(lower)) return 'write';
  if (PLAYWRIGHT_READ.has(lower) || PLAYWRIGHT_STORAGE_READ.test(lower)) return 'read';
  if (lower === 'browser_tabs') {
    return input?.action === 'list' ? 'read' : 'execute';
  }
  if (PLAYWRIGHT_EXECUTE.test(lower)) return 'execute';
  return 'unknown';
}

function playwrightResources(operation, input) {
  const lower = operation.toLowerCase();
  if (PLAYWRIGHT_PRIVILEGED_EXECUTION.has(lower)) return privilegedInputResources(input);
  const resources = new Set();
  if (lower.includes('console')) addResource(resources, 'console');
  if (lower.includes('network') || lower.includes('route')) addResource(resources, 'network');
  if (lower.includes('cookie') || lower.includes('storage')) addResource(resources, 'storage');
  if (lower.includes('screenshot')) addResource(resources, 'screenshot');
  if (lower.includes('tab')) addResource(resources, 'tabs');
  if (lower.includes('pdf')) addResource(resources, 'pdf');
  if (lower.includes('tracing')) addResource(resources, 'trace');
  if (lower.includes('video')) addResource(resources, 'video');
  const url = typeof input?.url === 'string' ? input.url : null;
  if (url) {
    try {
      const parsed = new URL(url);
      if (['http:', 'https:'].includes(parsed.protocol)) addResource(resources, `origin:${parsed.origin}`);
      else addResource(resources, `url-scheme:${parsed.protocol.slice(0, -1)}`);
    } catch {
      addResource(resources, 'invalid-url');
    }
  }
  const candidates = [];
  collectPaths(input, candidates);
  const explicitFilename = input?.filename ?? input?.output_path ?? input?.outputPath;
  if (typeof explicitFilename === 'string' && !candidates.includes(explicitFilename)) {
    candidates.push(explicitFilename);
  }
  for (const candidate of candidates) {
    const relative = normalizedResourcePath(candidate);
    const output = candidate === input?.filename || candidate === input?.output_path || candidate === input?.outputPath;
    addResource(resources, relative
      ? `${output ? 'artifact' : 'file'}:${relative}`
      : `${output ? 'external-artifact' : 'external-file'}`);
  }
  if (resources.size === 0) addResource(resources, 'page');
  return [...resources];
}

function githubResources(operation, input) {
  const lower = operation.toLowerCase();
  const fullName = input?.repository_full_name ?? input?.repo_full_name;
  const fullNameParts = typeof fullName === 'string' ? fullName.split('/') : [];
  const fullNameOwner = fullNameParts.length === 2 ? safeIdentifier(fullNameParts[0]) : null;
  const fullNameRepo = fullNameParts.length === 2 ? safeIdentifier(fullNameParts[1]) : null;
  const owner = fullNameOwner ?? safeIdentifier(input?.owner ?? input?.organization ?? input?.org);
  const repo = fullNameRepo ?? safeIdentifier(
    input?.repo ?? input?.repository ?? input?.repo_name ??
    (typeof input?.repository_name === 'string' ? input.repository_name : null),
  );
  const repository = owner && repo ? `${owner}/${repo}` : null;
  const number = safeScalarIdentifier(
    input?.issue_number ?? input?.issueNumber ??
    input?.pull_number ?? input?.pullNumber ??
    input?.pr_number ?? input?.prNumber ??
    input?.discussion_number ?? input?.discussionNumber ??
    input?.number,
  );
  if (lower === 'get_me' || lower === 'list_starred_repositories') return ['account'];
  if (lower === 'get_teams' || lower === 'get_team_members') {
    return [owner ? `organization:${owner}` : 'account'];
  }
  if (lower.includes('notification')) return ['notifications'];
  if (lower.includes('gist')) return ['gists'];
  if (lower === 'search' || lower.startsWith('search_')) {
    return [repository ? `repo:${repository}` : 'search'];
  }
  if (lower === 'ui_get') return ['ui'];
  if (
    lower.includes('security') ||
    lower.includes('scanning') ||
    lower.includes('dependabot') ||
    lower.includes('quality')
  ) {
    return [repository ? `security:${repository}` : 'security:global'];
  }
  if (
    lower.startsWith('actions_') ||
    lower.includes('workflow') ||
    lower.includes('job_logs')
  ) {
    return [repository ? `actions:${repository}` : 'actions'];
  }
  if (
    lower.includes('pull_request') ||
    /(?:^|_)prs?(?:_|$)/.test(lower)
  ) {
    return [repository
      ? `pull:${repository}${number ? `#${number}` : ''}`
      : 'pulls'];
  }
  if (lower.includes('issue') || lower === 'find_duplicate') {
    return [repository
      ? `issue:${repository}${number ? `#${number}` : ''}`
      : 'issues'];
  }
  if (lower.includes('discussion')) {
    return [repository
      ? `discussion:${repository}${number ? `#${number}` : ''}`
      : 'discussions'];
  }
  if (lower.startsWith('projects_')) {
    return [repository ? `projects:${repository}` : owner ? `projects:${owner}` : 'projects'];
  }
  return [repository ? `repo:${repository}` : 'github'];
}

function codexSecurityResources(input) {
  const scanId = safeScalarIdentifier(input?.scan_id ?? input?.scanId);
  return [scanId ? `triage:${scanId}` : 'triage'];
}

export function classifyExternalTool(toolName, input = {}) {
  const parsed = parseMcpToolName(toolName);
  if (!parsed) return null;
  const server = parsed.server.toLowerCase();
  const provider = TRUSTED_PROVIDER_BY_SERVER.get(server);
  if (server === 'codex_apps' && parsed.operation.startsWith('github_')) {
    const operation = parsed.operation.slice('github_'.length);
    return {
      provider: 'github',
      reviewed_provider: true,
      source_server: 'codex_apps',
      operation,
      effect: GITHUB_CODEX_APP_READ.has(operation.toLowerCase()) ? 'read' : 'unknown',
      resources: githubResources(operation, input),
    };
  }
  if (provider === 'unity') {
    return {
      provider: 'unity',
      reviewed_provider: true,
      operation: parsed.operation,
      effect: unityEffect(parsed.operation, input),
      resources: unityPrivilegedExecution(parsed.operation)
        ? unityPrivilegedResources(parsed.operation, input)
        : unityResources(parsed.operation, input),
    };
  }
  if (provider === 'blender') {
    return {
      provider: 'blender',
      reviewed_provider: true,
      operation: parsed.operation,
      effect: blenderEffect(parsed.operation),
      resources: blenderResources(parsed.operation, input),
    };
  }
  if (provider === 'playwright') {
    return {
      provider: 'playwright',
      reviewed_provider: true,
      operation: parsed.operation,
      effect: playwrightEffect(parsed.operation, input),
      resources: playwrightResources(parsed.operation, input),
    };
  }
  if (provider === 'github') {
    return {
      provider: 'github',
      reviewed_provider: true,
      operation: parsed.operation,
      effect: GITHUB_READ.has(parsed.operation.toLowerCase()) ? 'read' : 'unknown',
      resources: githubResources(parsed.operation, input),
    };
  }
  if (provider === 'codex-security') {
    return {
      provider: 'codex-security',
      reviewed_provider: true,
      operation: parsed.operation,
      effect: CODEX_SECURITY_READ.has(parsed.operation.toLowerCase()) ? 'read' : 'unknown',
      resources: codexSecurityResources(input),
    };
  }
  return {
    provider: server,
    reviewed_provider: false,
    operation: parsed.operation,
    effect: 'unknown',
    resources: ['unknown'],
  };
}

// A Codex plugin is a capability container, not a security principal. For an
// MCP server without a reviewed adapter, a sealed ticket may opt into ONE
// exact operation as read-only with `<server>:tool:<operation>:read`. Wildcard,
// prefix, write, and execute claims never upgrade an unknown operation. The
// conservative drift marker keeps post-call tree reconciliation enabled even
// though the caller has explicitly attested that exact operation as a read.
export function resolveClaimedPluginRead(classification, claims) {
  if (
    !classification ||
    classification.effect !== 'unknown' ||
    classification.reviewed_provider === true ||
    !Array.isArray(claims)
  ) return classification;
  const requiredResource = `tool:${classification.operation}`;
  const authorized = claims.map(parseToolClaim).filter(Boolean).some((claim) =>
    claim.provider === classification.provider &&
    claim.resource === requiredResource &&
    claim.access === 'read');
  if (!authorized) return classification;
  return {
    ...classification,
    effect: 'read',
    resources: [requiredResource],
    claimed_plugin_read: true,
    conservative_drift: true,
  };
}

export function parseToolClaim(claim) {
  if (typeof claim !== 'string' || claim.length === 0 || claim.length > 4096) return null;
  const first = claim.indexOf(':');
  const last = claim.lastIndexOf(':');
  if (first <= 0 || last <= first) return null;
  const provider = claim.slice(0, first).toLowerCase();
  const resource = claim.slice(first + 1, last);
  const access = claim.slice(last + 1).toLowerCase();
  if (
    !/^[a-z0-9][a-z0-9._-]*$/.test(provider) ||
    !resource ||
    resource.trim() !== resource ||
    /[\0-\x1f\x7f]/.test(resource) ||
    (resource.includes('*') && !/^(?:\*|[^*]+\*)$/.test(resource)) ||
    !ACCESS.has(access)
  ) return null;
  return { provider, resource, access };
}

function accessAllows(claimed, requested) {
  if (claimed === requested) return true;
  return claimed === 'write' && requested === 'read';
}

function resourceAllows(claimed, requested) {
  if (claimed === '*') return true;
  if (claimed === requested) return true;
  if (!claimed.endsWith('*')) return false;
  return requested.startsWith(claimed.slice(0, -1));
}

function hasExactPrivilegedClaim(parsedClaims, classification) {
  return parsedClaims.some((claim) =>
    claim.provider === classification.provider &&
    claim.resource === PRIVILEGED_RESOURCE &&
    claim.access === 'execute');
}

export function toolClaimAllows(claims, classification) {
  if (!Array.isArray(claims) || !classification || classification.effect === 'unknown') return false;
  const parsed = claims.map(parseToolClaim).filter(Boolean);
  if (
    classification.resources.includes(PRIVILEGED_RESOURCE) &&
    !hasExactPrivilegedClaim(parsed, classification)
  ) return false;
  return classification.resources.every((resource) => parsed.some((claim) =>
    claim.provider === classification.provider &&
    accessAllows(claim.access, classification.effect) &&
    resourceAllows(claim.resource, resource)));
}

export function externalToolPolicy(classification, { state, ticket, isSubagent }) {
  if (!classification) return null;
  if (!state) {
    return { decision: 'allow', reason: 'no active APE run governs the external MCP tool' };
  }
  if (state.status !== 'running') {
    if (classification.effect === 'read') {
      return { decision: 'allow', reason: `read-only ${classification.provider} MCP operation does not alter the frozen run` };
    }
    return {
      decision: 'deny',
      reason: `APE external tool denied: run is ${state.status} and external mutation is frozen`,
    };
  }
  if (!isSubagent) {
    if (classification.effect === 'read') {
      return { decision: 'allow', reason: `main session may read through ${classification.provider} MCP` };
    }
    return {
      decision: 'deny',
      reason: `APE external tool denied: the main session may not perform ${classification.effect} ${classification.provider} operations during an active run`,
    };
  }
  if (!ticket) {
    return {
      decision: 'deny',
      reason: `APE external tool denied: subagent is not bound to an active ticket with ${classification.provider} tool claims`,
    };
  }
  if (classification.effect === 'unknown') {
    return {
      decision: 'deny',
      reason: `APE external tool denied: ${classification.provider}.${classification.operation} has no trusted effect classification`,
    };
  }
  if (classification.resources.includes(PRIVILEGED_RESOURCE)) {
    if (ticket.writable !== true) {
      return {
        decision: 'deny',
        reason: `APE external tool denied: read-only ${ticket.role} cannot execute code in an editor/MCP server process`,
      };
    }
    if (state.high_risk !== true) {
      return {
        decision: 'deny',
        reason: 'APE external tool denied: privileged editor/MCP server code execution requires a high-risk run',
      };
    }
    const parsedClaims = Array.isArray(ticket.tool_claims)
      ? ticket.tool_claims.map(parseToolClaim).filter(Boolean)
      : [];
    if (!hasExactPrivilegedClaim(parsedClaims, classification)) {
      return {
        decision: 'deny',
        reason: `APE external tool denied: ${classification.provider}.${classification.operation} requires the exact non-wildcard claim ${classification.provider}:${PRIVILEGED_RESOURCE}:execute`,
      };
    }
  }
  if (classification.effect === 'write' && ticket.writable !== true) {
    return { decision: 'deny', reason: `APE external tool denied: read-only ${ticket.role} cannot mutate editor state` };
  }
  if (!toolClaimAllows(ticket.tool_claims, classification)) {
    return {
      decision: 'deny',
      reason: `APE external tool denied: ${classification.provider}.${classification.operation} requires ${classification.resources.map((resource) => `${classification.provider}:${resource}:${classification.effect}`).join(', ')}`,
    };
  }
  return {
    decision: 'allow',
    reason: `external ${classification.provider} ${classification.effect} authorized by ${ticket.ticket_id}`,
  };
}
