import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import {
  classifyExternalTool,
  externalToolPolicy,
  parseMcpToolName,
  parseToolClaim,
  resolveClaimedPluginRead,
  toolClaimAllows,
} from '../lib/runtime/external-tools.js';
import {
  driftGuardApplies,
  evaluateLifecyclePolicy,
  normalizeLifecycleEvent,
} from '../lib/runtime/hooks.js';
import { DEFAULT_CONFIG, setRuntimeConfig } from '../lib/runtime/config.js';
import { finalizeReceipt, finalizeTicket, RunStartInputSchema } from '../lib/runtime/schemas.js';
import { runtimePaths } from '../lib/runtime/paths.js';
import { recordReceipt, startRun } from '../lib/runtime/service.js';
import { doctor } from '../lib/runtime/doctor.js';
import { bindCodexDispatchContext, invokeCodexHook } from './codex-native-test-helper.js';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

const cleanups = [];
afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function project() {
  const dir = await mkdtemp(path.join(tmpdir(), 'ape-external-tools-'));
  cleanups.push(dir);
  await mkdir(path.join(dir, '.ape', 'runtime'), { recursive: true });
  return dir;
}

const state = { run_id: 'run-1', status: 'running' };
const highRiskState = { ...state, high_risk: true };
const ticket = {
  ticket_id: 'run-1:build:ticket-1',
  role: 'implementer',
  writable: true,
  tool_claims: [
    'unity:console:read',
    'unity:tests:execute',
    'unity:scene:Assets/Scenes/Main.unity:write',
  ],
};

describe('APE v2 external MCP classification and claims', () => {
  it('parses MCP names without confusing underscores in the server id', () => {
    expect(parseMcpToolName('mcp__official_unity__read_console')).toEqual({
      server: 'official_unity',
      operation: 'read_console',
    });
    expect(parseMcpToolName('mcp__ape__ape_run')).toBe(null);
    expect(parseMcpToolName('Read')).toBe(null);
  });

  it('classifies Unity reads, writes, execution, resources, and unknown operations', () => {
    expect(classifyExternalTool('mcp__unity__read_console', {})).toMatchObject({
      provider: 'unity', effect: 'read', resources: ['console'],
    });
    expect(classifyExternalTool('mcp__unity__run_tests', {})).toMatchObject({
      provider: 'unity', effect: 'execute', resources: ['tests'],
    });
    expect(classifyExternalTool('mcp__unity__execute_menu_item', {})).toMatchObject({
      provider: 'unity', effect: 'execute', resources: ['server-rce'],
    });
    const rawCode = classifyExternalTool('mcp__unity__execute_csharp_code', {
      script_path: 'Editor/Unsafe.cs',
    });
    expect(rawCode).toMatchObject({
      provider: 'unity', effect: 'execute',
      resources: ['server-rce', 'file:Editor/Unsafe.cs'],
    });
    expect(toolClaimAllows(['unity:server-rce:execute'], rawCode)).toBe(false);
    expect(toolClaimAllows([
      'unity:server-rce:execute', 'unity:file:Editor/Unsafe.cs:execute',
    ], rawCode)).toBe(true);
    expect(classifyExternalTool('mcp__unity__manage_scene', { action: 'get_hierarchy' })).toMatchObject({
      provider: 'unity', effect: 'read', resources: ['scene:*'],
    });
    expect(classifyExternalTool('mcp__unity__manage_scene', { action: 'save' })).toMatchObject({
      provider: 'unity', effect: 'write', resources: ['scene:*'],
    });
    expect(classifyExternalTool('mcp__unity__save_scene', {
      scene_path: 'Assets/Scenes/Main.unity',
    })).toMatchObject({
      provider: 'unity', effect: 'write', resources: ['scene:Assets/Scenes/Main.unity'],
    });
    expect(classifyExternalTool('mcp__unity__save_scene', {
      command: 'get_hierarchy',
      scene_path: 'Assets/Scenes/Main.unity',
    })).toMatchObject({
      provider: 'unity', effect: 'write', resources: ['scene:Assets/Scenes/Main.unity'],
    });
    expect(classifyExternalTool('mcp__unity__teleport', {})).toMatchObject({ effect: 'unknown' });
    expect(classifyExternalTool('mcp__database__query', {})).toMatchObject({
      provider: 'database', effect: 'unknown',
    });
  });

  it('grants built-in provider semantics only to exact reviewed server aliases', () => {
    for (const toolName of [
      'mcp__unity__read_console',
      'mcp__unityMCP__read_console',
    ]) {
      expect(classifyExternalTool(toolName, {}), toolName).toMatchObject({
        provider: 'unity', effect: 'read', resources: ['console'],
      });
    }
    expect(classifyExternalTool(
      'mcp__plugin_playwright_playwright__browser_snapshot', {},
    )).toMatchObject({ provider: 'playwright', effect: 'read' });
    expect(classifyExternalTool('mcp__blender__get_scene_info', {})).toMatchObject({
      provider: 'blender', effect: 'read', resources: ['scene'],
    });
  });

  it('does not let server or operation substrings borrow trusted provider claims', () => {
    const spoofed = [
      ['mcp__evil__unity_save_scene', 'evil'],
      ['mcp__evil_unity__save_scene', 'evil_unity'],
      ['mcp__unity_evil__save_scene', 'unity_evil'],
      ['mcp__evil__blender_execute_code', 'evil'],
      ['mcp__not_playwright__browser_snapshot', 'not_playwright'],
      ['mcp__official_unity__read_console', 'official_unity'],
      ['mcp__playwright_mcp__browser_snapshot', 'playwright_mcp'],
    ];
    for (const [toolName, provider] of spoofed) {
      const classification = classifyExternalTool(toolName, {});
      expect(classification, toolName).toMatchObject({ provider, effect: 'unknown' });
      expect(toolClaimAllows([
        'unity:*:write', 'blender:*:execute', 'playwright:*:read',
      ], classification), toolName).toBe(false);
    }
  });

  it('matches exact and wildcard structured claims without widening access', () => {
    const scene = classifyExternalTool('mcp__unity__save_scene', {
      scene_path: 'Assets/Scenes/Main.unity',
    });
    expect(parseToolClaim('unity:scene:Assets/Scenes/Main.unity:write')).toEqual({
      provider: 'unity', resource: 'scene:Assets/Scenes/Main.unity', access: 'write',
    });
    expect(toolClaimAllows(ticket.tool_claims, scene)).toBe(true);
    expect(toolClaimAllows(['unity:scene:Assets/Scenes/*:write'], scene)).toBe(true);
    expect(toolClaimAllows(['unity:scene:Assets/Scenes/Main.unity:read'], scene)).toBe(false);
    expect(parseToolClaim(' unity:console:read')).toBe(null);
    expect(parseToolClaim('unity:scene:*:nested:write')).toBe(null);
  });

  it('allows claimed calls, denies unknown/unclaimed calls, and freezes the main session', () => {
    const read = classifyExternalTool('mcp__unity__read_console', {});
    const write = classifyExternalTool('mcp__unity__save_scene', {
      scene_path: 'Assets/Scenes/Main.unity',
    });
    const unknown = classifyExternalTool('mcp__unity__teleport', {});
    expect(externalToolPolicy(read, { state, ticket, isSubagent: true }).decision).toBe('allow');
    expect(externalToolPolicy(write, { state, ticket, isSubagent: true }).decision).toBe('allow');
    expect(externalToolPolicy(unknown, { state, ticket, isSubagent: true }).decision).toBe('deny');
    expect(externalToolPolicy(write, { state, ticket: null, isSubagent: false }).decision).toBe('deny');
    expect(externalToolPolicy(read, { state, ticket: null, isSubagent: false }).decision).toBe('allow');
    expect(externalToolPolicy(read, { state, ticket: null, isSubagent: true })).toMatchObject({
      decision: 'deny',
      reason: expect.stringContaining('not bound'),
    });
    expect(externalToolPolicy(write, {
      state: { ...state, status: 'gating' }, ticket, isSubagent: true,
    }).decision).toBe('deny');
    expect(externalToolPolicy(read, {
      state: { ...state, status: 'gating' }, ticket, isSubagent: true,
    }).decision).toBe('allow');
  });

  it.each(['claude', 'codex'])('enforces the same external-tool policy on %s', (host) => {
    const event = normalizeLifecycleEvent({
      hook_event_name: 'PreToolUse',
      project_dir: '/tmp/project',
      tool_name: 'mcp__unity__save_scene',
      tool_input: { scene_path: 'Assets/Scenes/Other.unity' },
      agent_id: 'native-agent',
    }, host === 'claude' ? { CLAUDECODE: '1' } : {});
    const result = evaluateLifecyclePolicy(event, { state, ticket });
    expect(result.decision).toBe('deny');
    expect(result.reason).toMatch(/requires unity:scene:Assets\/Scenes\/Other\.unity:write/);
  });

  it.each(['claude', 'codex'])('denies an unbound subagent external read on %s', (host) => {
    const event = normalizeLifecycleEvent({
      hook_event_name: 'PreToolUse',
      project_dir: '/tmp/project',
      tool_name: 'mcp__unity__read_console',
      tool_input: {},
      agent_id: 'unbound-native-agent',
    }, host === 'claude' ? { CLAUDECODE: '1' } : {});
    const result = evaluateLifecyclePolicy(event, { state, ticket: null });
    expect(result.decision).toBe('deny');
    expect(result.reason).toMatch(/not bound|binding/i);
  });

  it.each(['claude', 'codex'])(
    'requires explicit high-risk writable authority for Unity editor command execution on %s',
    (host) => {
      const event = normalizeLifecycleEvent({
        hook_event_name: 'PreToolUse', project_dir: '/tmp/project',
        tool_name: 'mcp__unity__execute_menu_item',
        tool_input: { menu_path: 'Assets/Run Arbitrary Command' }, agent_id: 'native-agent',
      }, host === 'claude' ? { CLAUDECODE: '1' } : {});
      const generic = { ...ticket, tool_claims: ['unity:editor:execute', 'unity:*:execute'] };
      const exact = { ...ticket, tool_claims: ['unity:server-rce:execute'] };
      const readOnly = { ...exact, role: 'reviewer', writable: false };
      expect(evaluateLifecyclePolicy(event, { state: highRiskState, ticket: generic }).decision).toBe('deny');
      expect(evaluateLifecyclePolicy(event, { state, ticket: exact }).decision).toBe('deny');
      expect(evaluateLifecyclePolicy(event, { state: highRiskState, ticket: readOnly }).decision).toBe('deny');
      expect(evaluateLifecyclePolicy(event, { state: highRiskState, ticket: exact }).decision).toBe('allow');
    },
  );
});

describe('APE v2 Blender MCP adapter', () => {
  it('separates scene inspection, scene mutation, arbitrary execution, and catalog access', () => {
    expect(classifyExternalTool('mcp__blender__get_scene_info', {})).toMatchObject({
      provider: 'blender', effect: 'read', resources: ['scene'],
    });
    expect(classifyExternalTool('mcp__blender__get_object_info', { object_name: 'Hero Rig' })).toMatchObject({
      provider: 'blender', effect: 'read', resources: ['object:Hero%20Rig'],
    });
    expect(classifyExternalTool('mcp__blender__execute_blender_code', { code: 'bpy.ops.wm.save_mainfile()' })).toMatchObject({
      provider: 'blender', effect: 'execute', resources: ['server-rce'],
    });
    expect(classifyExternalTool('mcp__blender__download_polyhaven_asset', {
      asset_id: 'brick_wall', asset_type: 'textures',
    })).toMatchObject({
      provider: 'blender', effect: 'write',
      resources: ['asset:brick_wall', 'catalog:polyhaven', 'scene'],
    });
    expect(classifyExternalTool('mcp__blender__teleport_mesh', {})).toMatchObject({ effect: 'unknown' });
    const imageGeneration = classifyExternalTool('mcp__blender__generate_hyper3d_model_via_images', {
      input_image_paths: ['references/front.png', '/tmp/outside.png'],
    });
    expect(imageGeneration).toMatchObject({
      provider: 'blender', effect: 'execute',
      resources: expect.arrayContaining([
        'service:hyper3d', 'file:references/front.png', 'external-file',
      ]),
    });
    expect(toolClaimAllows(['blender:service:hyper3d:execute'], imageGeneration)).toBe(false);
  });

  it.each(['claude', 'codex'])('enforces privileged Blender code claims on %s', (host) => {
    const event = normalizeLifecycleEvent({
      hook_event_name: 'PreToolUse', project_dir: '/tmp/project',
      tool_name: 'mcp__blender__execute_blender_code',
      tool_input: { code: 'print(bpy.context.scene)' }, agent_id: 'native-agent',
    }, host === 'claude' ? { CLAUDECODE: '1' } : {});
    const generic = { ...ticket, tool_claims: ['blender:scene:execute', 'blender:*:execute'] };
    const exact = { ...ticket, tool_claims: ['blender:server-rce:execute'] };
    const readOnly = { ...exact, role: 'reviewer', writable: false };
    expect(toolClaimAllows(['blender:*:execute'], event.external_tool)).toBe(false);
    expect(evaluateLifecyclePolicy(event, { state: highRiskState, ticket: generic }).decision).toBe('deny');
    expect(evaluateLifecyclePolicy(event, { state, ticket: exact }).decision).toBe('deny');
    expect(evaluateLifecyclePolicy(event, { state: highRiskState, ticket: readOnly }).decision).toBe('deny');
    expect(evaluateLifecyclePolicy(event, { state: highRiskState, ticket: exact }).decision).toBe('allow');
  });
});

describe('APE v2 GitHub and Codex plugin MCP adapters', () => {
  const officialGithubMcpReads = [
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
  ];
  const codexGithubConnectorReads = [
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
  ];

  it.each(officialGithubMcpReads)('classifies current official GitHub MCP read %s', (operation) => {
    expect(classifyExternalTool(`mcp__github__${operation}`, {
      owner: 'octo-org', repo: 'hello-world',
    })).toMatchObject({
      provider: 'github', reviewed_provider: true, operation, effect: 'read',
    });
  });

  it('admits reviewed GitHub reads under exact standalone and plugin aliases', () => {
    for (const server of ['github', 'plugin_github_github']) {
      expect(classifyExternalTool(`mcp__${server}__get_file_contents`, {
        owner: 'octo-org', repo: 'hello-world', path: 'README.md',
      })).toMatchObject({
        provider: 'github',
        reviewed_provider: true,
        effect: 'read',
        resources: ['repo:octo-org/hello-world'],
      });
    }
    expect(classifyExternalTool('mcp__github__issue_read', {
      owner: 'octo-org', repo: 'hello-world', issue_number: 17,
    })).toMatchObject({ effect: 'read', resources: ['issue:octo-org/hello-world#17'] });
    expect(classifyExternalTool('mcp__github__pull_request_read', {
      owner: 'octo-org', repo: 'hello-world', pullNumber: 23,
    })).toMatchObject({ effect: 'read', resources: ['pull:octo-org/hello-world#23'] });
    expect(classifyExternalTool('mcp__github__list_code_scanning_alerts', {
      owner: 'octo-org', repo: 'hello-world',
    })).toMatchObject({ effect: 'read', resources: ['security:octo-org/hello-world'] });
  });

  it('keeps GitHub mutations and future unreviewed tools fail-closed', () => {
    for (const operation of [
      'create_or_update_file',
      'push_files',
      'create_pull_request',
      'merge_pull_request',
      'issue_write',
      'future_read_sounding_tool',
    ]) {
      const classification = classifyExternalTool(`mcp__github__${operation}`, {
        owner: 'octo-org', repo: 'hello-world',
      });
      expect(classification, operation).toMatchObject({
        provider: 'github', reviewed_provider: true, effect: 'unknown',
      });
      expect(resolveClaimedPluginRead(
        classification,
        [`github:tool:${operation}:read`],
      ), operation).toBe(classification);
    }
  });

  it.each(codexGithubConnectorReads)(
    'classifies current Codex GitHub connector read %s',
    (operation) => {
      expect(classifyExternalTool(`mcp__codex_apps__github_${operation}`, {
        repository_full_name: 'octo-org/hello-world',
      })).toMatchObject({
        provider: 'github',
        reviewed_provider: true,
        source_server: 'codex_apps',
        operation,
        effect: 'read',
      });
    },
  );

  it('maps Codex GitHub connector resources and denies connector mutations', () => {
    expect(classifyExternalTool('mcp__codex_apps__github_fetch_issue', {
      repository_full_name: 'octo-org/hello-world', issue_number: 31,
    })).toMatchObject({
      provider: 'github', effect: 'read',
      resources: ['issue:octo-org/hello-world#31'],
    });
    expect(classifyExternalTool('mcp__codex_apps__github_fetch_pr', {
      repo_full_name: 'octo-org/hello-world', pr_number: 7,
    })).toMatchObject({
      provider: 'github', effect: 'read',
      resources: ['pull:octo-org/hello-world#7'],
    });
    for (const operation of [
      'create_file',
      'create_pull_request',
      'label_pr',
      'merge_pull_request',
      'update_issue',
    ]) {
      const classification = classifyExternalTool(
        `mcp__codex_apps__github_${operation}`,
        { repository_full_name: 'octo-org/hello-world' },
      );
      expect(classification, operation).toMatchObject({
        provider: 'github', reviewed_provider: true, effect: 'unknown',
      });
      expect(resolveClaimedPluginRead(
        classification,
        [`github:tool:${operation}:read`],
      )).toBe(classification);
    }
  });

  it('allows only the reviewed Codex Security result viewer', () => {
    expect(classifyExternalTool(
      'mcp__codex-security__open_codex_security_triage_results',
      { scan_id: 'scan-123' },
    )).toMatchObject({
      provider: 'codex-security',
      reviewed_provider: true,
      effect: 'read',
      resources: ['triage:scan-123'],
    });
    for (const operation of [
      'open_codex_security_workspace',
      'complete_codex_security_scan',
      'set_codex_security_finding_remediation',
    ]) {
      expect(classifyExternalTool(
        `mcp__codex-security__${operation}`,
        {},
      )).toMatchObject({ provider: 'codex-security', effect: 'unknown' });
    }
  });

  it('supports generic plugin reads only through an exact sealed operation claim', () => {
    const unknown = classifyExternalTool('mcp__acme_plugin__get_status', {});
    expect(resolveClaimedPluginRead(unknown, ['acme_plugin:tool:get_status:read'])).toMatchObject({
      provider: 'acme_plugin',
      effect: 'read',
      resources: ['tool:get_status'],
      claimed_plugin_read: true,
      conservative_drift: true,
    });
    for (const claims of [
      ['acme_plugin:*:read'],
      ['acme_plugin:tool:get_*:read'],
      ['other:tool:get_status:read'],
    ]) {
      expect(resolveClaimedPluginRead(unknown, claims), claims[0]).toBe(unknown);
    }
  });

  it.each(['claude', 'codex'])('enforces a generic exact plugin read claim on %s', (host) => {
    const event = normalizeLifecycleEvent({
      hook_event_name: 'PreToolUse',
      project_dir: '/tmp/project',
      tool_name: 'mcp__acme_plugin__get_status',
      tool_input: {},
      agent_id: 'native-agent',
    }, host === 'claude' ? { CLAUDECODE: '1' } : {});
    const claimedTicket = {
      ...ticket,
      writable: false,
      role: 'reviewer',
      tool_claims: ['acme_plugin:tool:get_status:read'],
    };
    expect(evaluateLifecyclePolicy(event, { state, ticket: claimedTicket })).toMatchObject({
      decision: 'allow',
      reason: expect.stringContaining('authorized'),
    });
    expect(evaluateLifecyclePolicy(event, {
      state,
      ticket: { ...claimedTicket, tool_claims: ['acme_plugin:*:read'] },
    })).toMatchObject({ decision: 'deny' });

    event.external_tool = resolveClaimedPluginRead(
      event.external_tool,
      claimedTicket.tool_claims,
    );
    expect(driftGuardApplies(event)).toBe(true);
  });
});

describe('APE v2 generic plugin write and execute claim resolution', () => {
  it('resolves write claims for unreviewed providers', () => {
    const unknown = classifyExternalTool('mcp__acme_plugin__update_config', {});
    expect(unknown).toMatchObject({ provider: 'acme_plugin', effect: 'unknown', reviewed_provider: false });
    const resolved = resolveClaimedPluginRead(unknown, ['acme_plugin:tool:update_config:write']);
    expect(resolved).toMatchObject({
      provider: 'acme_plugin',
      effect: 'write',
      resources: ['tool:update_config'],
      conservative_drift: true,
    });
    expect(resolved).not.toHaveProperty('claimed_plugin_read');
  });

  it('resolves execute claims for unreviewed providers', () => {
    const unknown = classifyExternalTool('mcp__acme_plugin__run_task', {});
    expect(unknown).toMatchObject({ provider: 'acme_plugin', effect: 'unknown', reviewed_provider: false });
    const resolved = resolveClaimedPluginRead(unknown, ['acme_plugin:tool:run_task:execute']);
    expect(resolved).toMatchObject({
      provider: 'acme_plugin',
      effect: 'execute',
      resources: ['tool:run_task'],
      conservative_drift: true,
    });
    expect(resolved).not.toHaveProperty('claimed_plugin_read');
  });

  it('prioritizes the highest access level when multiple claims match', () => {
    const unknown = classifyExternalTool('mcp__acme_plugin__multi_op', {});
    // execute > write > read
    expect(resolveClaimedPluginRead(unknown, [
      'acme_plugin:tool:multi_op:read',
      'acme_plugin:tool:multi_op:write',
      'acme_plugin:tool:multi_op:execute',
    ])).toMatchObject({ effect: 'execute' });
    // write > read (no execute claim)
    expect(resolveClaimedPluginRead(unknown, [
      'acme_plugin:tool:multi_op:read',
      'acme_plugin:tool:multi_op:write',
    ])).toMatchObject({ effect: 'write' });
    // read only (no write or execute claim)
    expect(resolveClaimedPluginRead(unknown, [
      'acme_plugin:tool:multi_op:read',
    ])).toMatchObject({ effect: 'read', claimed_plugin_read: true });
  });

  it('does not resolve write or execute claims for reviewed providers', () => {
    const githubUnknown = classifyExternalTool('mcp__github__future_mutation', {
      owner: 'org', repo: 'repo',
    });
    expect(githubUnknown.reviewed_provider).toBe(true);
    expect(githubUnknown.effect).toBe('unknown');
    expect(resolveClaimedPluginRead(githubUnknown, ['github:tool:future_mutation:write'])).toBe(githubUnknown);
    expect(resolveClaimedPluginRead(githubUnknown, ['github:tool:future_mutation:execute'])).toBe(githubUnknown);
  });

  it('does not resolve wildcard or prefix write/execute claims', () => {
    const unknown = classifyExternalTool('mcp__acme_plugin__do_action', {});
    for (const claim of [
      'acme_plugin:*:write',
      'acme_plugin:tool:do_*:write',
      'acme_plugin:*:execute',
      'acme_plugin:tool:do_*:execute',
    ]) {
      expect(resolveClaimedPluginRead(unknown, [claim]), claim).toBe(unknown);
    }
  });

  it('sets conservative_drift true for resolved read, write, and execute effects', () => {
    const readTarget = classifyExternalTool('mcp__acme_plugin__get_info', {});
    const writeTarget = classifyExternalTool('mcp__acme_plugin__set_value', {});
    const execTarget = classifyExternalTool('mcp__acme_plugin__run_job', {});
    expect(resolveClaimedPluginRead(readTarget, ['acme_plugin:tool:get_info:read']).conservative_drift).toBe(true);
    expect(resolveClaimedPluginRead(writeTarget, ['acme_plugin:tool:set_value:write']).conservative_drift).toBe(true);
    expect(resolveClaimedPluginRead(execTarget, ['acme_plugin:tool:run_job:execute']).conservative_drift).toBe(true);
  });

  it('exports resolveClaimedPluginEffect as the canonical name with resolveClaimedPluginRead as backward-compat alias', async () => {
    const mod = await import('../lib/runtime/external-tools.js');
    expect(mod.resolveClaimedPluginEffect).toBeDefined();
    expect(mod.resolveClaimedPluginRead).toBe(mod.resolveClaimedPluginEffect);
  });

  it.each(['claude', 'codex'])('allows a claimed plugin write on a writable ticket via lifecycle policy on %s', (host) => {
    const event = normalizeLifecycleEvent({
      hook_event_name: 'PreToolUse',
      project_dir: '/tmp/project',
      tool_name: 'mcp__acme_plugin__update_config',
      tool_input: {},
      agent_id: 'native-agent',
    }, host === 'claude' ? { CLAUDECODE: '1' } : {});
    const writableTicket = {
      ...ticket,
      writable: true,
      tool_claims: ['acme_plugin:tool:update_config:write'],
    };
    expect(evaluateLifecyclePolicy(event, { state, ticket: writableTicket })).toMatchObject({
      decision: 'allow',
      reason: expect.stringContaining('authorized'),
    });
  });

  it.each(['claude', 'codex'])('denies a claimed plugin write on a read-only ticket via lifecycle policy on %s', (host) => {
    const event = normalizeLifecycleEvent({
      hook_event_name: 'PreToolUse',
      project_dir: '/tmp/project',
      tool_name: 'mcp__acme_plugin__update_config',
      tool_input: {},
      agent_id: 'native-agent',
    }, host === 'claude' ? { CLAUDECODE: '1' } : {});
    const readOnlyTicket = {
      ...ticket,
      writable: false,
      role: 'reviewer',
      tool_claims: ['acme_plugin:tool:update_config:write'],
    };
    expect(evaluateLifecyclePolicy(event, { state, ticket: readOnlyTicket })).toMatchObject({
      decision: 'deny',
      reason: expect.stringContaining('mutate'),
    });
  });

  it.each(['claude', 'codex'])('applies drift guard to resolved write and execute plugin effects on %s', (host) => {
    const writeEvent = normalizeLifecycleEvent({
      hook_event_name: 'PreToolUse',
      project_dir: '/tmp/project',
      tool_name: 'mcp__acme_plugin__update_config',
      tool_input: {},
      agent_id: 'native-agent',
    }, host === 'claude' ? { CLAUDECODE: '1' } : {});
    writeEvent.external_tool = resolveClaimedPluginRead(
      writeEvent.external_tool,
      ['acme_plugin:tool:update_config:write'],
    );
    expect(writeEvent.external_tool.conservative_drift).toBe(true);
    expect(driftGuardApplies(writeEvent)).toBe(true);

    const execEvent = normalizeLifecycleEvent({
      hook_event_name: 'PreToolUse',
      project_dir: '/tmp/project',
      tool_name: 'mcp__acme_plugin__run_task',
      tool_input: {},
      agent_id: 'native-agent',
    }, host === 'claude' ? { CLAUDECODE: '1' } : {});
    execEvent.external_tool = resolveClaimedPluginRead(
      execEvent.external_tool,
      ['acme_plugin:tool:run_task:execute'],
    );
    expect(execEvent.external_tool.conservative_drift).toBe(true);
    expect(driftGuardApplies(execEvent)).toBe(true);
  });
});

describe('APE v2 Playwright MCP adapter', () => {
  const officialReadOperations = [
    'browser_annotate',
    'browser_console_messages',
    'browser_cookie_get',
    'browser_cookie_list',
    'browser_find',
    'browser_get_config',
    'browser_hide_highlight',
    'browser_highlight',
    'browser_localstorage_get',
    'browser_localstorage_list',
    'browser_network_request',
    'browser_network_requests',
    'browser_route_list',
    'browser_sessionstorage_get',
    'browser_sessionstorage_list',
    'browser_snapshot',
    'browser_take_screenshot',
  ];
  const officialExecuteOperations = [
    'browser_click',
    'browser_close',
    'browser_cookie_clear',
    'browser_cookie_delete',
    'browser_cookie_set',
    'browser_drag',
    'browser_drop',
    'browser_evaluate',
    'browser_file_upload',
    'browser_fill_form',
    'browser_handle_dialog',
    'browser_hover',
    'browser_localstorage_clear',
    'browser_localstorage_delete',
    'browser_localstorage_set',
    'browser_navigate',
    'browser_navigate_back',
    'browser_network_state_set',
    'browser_press_key',
    'browser_resize',
    'browser_resume',
    'browser_route',
    'browser_run_code_unsafe',
    'browser_select_option',
    'browser_sessionstorage_clear',
    'browser_sessionstorage_delete',
    'browser_sessionstorage_set',
    'browser_set_storage_state',
    'browser_start_tracing',
    'browser_start_video',
    'browser_tabs',
    'browser_type',
    'browser_unroute',
    'browser_wait_for',
  ];
  const officialWriteOperations = [
    'browser_stop_tracing',
    'browser_stop_video',
    'browser_storage_state',
  ];

  it.each(officialReadOperations)('classifies current official read tool %s', (operation) => {
    expect(classifyExternalTool(`mcp__playwright__${operation}`, {})).toMatchObject({
      provider: 'playwright', effect: 'read',
    });
  });

  it.each(officialExecuteOperations)('classifies current official execute tool %s', (operation) => {
    const input = operation === 'browser_tabs' ? { action: 'new' } : {};
    expect(classifyExternalTool(`mcp__playwright__${operation}`, input)).toMatchObject({
      provider: 'playwright', effect: 'execute',
    });
  });

  it.each(officialWriteOperations)('classifies current official artifact tool %s', (operation) => {
    expect(classifyExternalTool(`mcp__playwright__${operation}`, {})).toMatchObject({
      provider: 'playwright', effect: 'write',
    });
  });

  it('separates inspection, interaction, code execution, storage changes, and file output', () => {
    expect(classifyExternalTool('mcp__playwright__browser_snapshot', {})).toMatchObject({
      provider: 'playwright', effect: 'read', resources: ['page'],
    });
    expect(classifyExternalTool('mcp__playwright__browser_console_messages', {})).toMatchObject({
      provider: 'playwright', effect: 'read', resources: ['console'],
    });
    expect(classifyExternalTool('mcp__playwright__browser_navigate', { url: 'https://example.com/docs' })).toMatchObject({
      provider: 'playwright', effect: 'execute', resources: ['origin:https://example.com'],
    });
    expect(classifyExternalTool('mcp__playwright__browser_run_code', { code: 'async page => page.title()' })).toMatchObject({
      provider: 'playwright', effect: 'execute', resources: ['page'],
    });
    expect(classifyExternalTool('mcp__playwright__browser_run_code_unsafe', {
      filename: 'tools/server-script.js',
    })).toMatchObject({
      provider: 'playwright', effect: 'execute',
      resources: ['server-rce', 'file:tools/server-script.js'],
    });
    expect(classifyExternalTool('mcp__playwright__browser_cookie_list', {})).toMatchObject({
      provider: 'playwright', effect: 'read', resources: ['storage'],
    });
    expect(classifyExternalTool('mcp__playwright__browser_cookie_set', {})).toMatchObject({
      provider: 'playwright', effect: 'execute', resources: ['storage'],
    });
    expect(classifyExternalTool('mcp__playwright__browser_verify_text_visible', {})).toMatchObject({
      provider: 'playwright', effect: 'read', resources: ['page'],
    });
    expect(classifyExternalTool('mcp__playwright__browser_start_tracing', {})).toMatchObject({
      provider: 'playwright', effect: 'execute', resources: ['trace'],
    });
    expect(classifyExternalTool('mcp__playwright__browser_stop_tracing', {})).toMatchObject({
      provider: 'playwright', effect: 'write', resources: ['trace'],
    });
    expect(classifyExternalTool('mcp__playwright__browser_pdf_save', {})).toMatchObject({
      provider: 'playwright', effect: 'write', resources: ['pdf'],
    });
    expect(classifyExternalTool('mcp__playwright__browser_take_screenshot', {
      filename: 'artifacts/page.png',
    })).toMatchObject({
      provider: 'playwright', effect: 'write',
      resources: ['screenshot', 'artifact:artifacts/page.png'],
    });
    expect(classifyExternalTool('mcp__playwright__browser_magic', {})).toMatchObject({ effect: 'unknown' });
  });

  it.each(['claude', 'codex'])('enforces Playwright origin claims on %s', (host) => {
    const event = normalizeLifecycleEvent({
      hook_event_name: 'PreToolUse', project_dir: '/tmp/project',
      tool_name: 'mcp__playwright__browser_navigate',
      tool_input: { url: 'https://example.com/login' }, agent_id: 'native-agent',
    }, host === 'claude' ? { CLAUDECODE: '1' } : {});
    const claimed = { ...ticket, tool_claims: ['playwright:origin:https://example.com:execute'] };
    expect(evaluateLifecyclePolicy(event, { state, ticket: claimed }).decision).toBe('allow');
    expect(evaluateLifecyclePolicy(event, { state, ticket }).decision).toBe('deny');
  });

  it.each(['claude', 'codex'])(
    'requires explicit high-risk writable authority for Playwright server code on %s',
    (host) => {
      const event = normalizeLifecycleEvent({
        hook_event_name: 'PreToolUse', project_dir: '/tmp/project',
        tool_name: 'mcp__playwright__browser_run_code_unsafe',
        tool_input: { code: 'require("node:child_process").execSync("whoami")' },
        agent_id: 'native-agent',
      }, host === 'claude' ? { CLAUDECODE: '1' } : {});
      const generic = {
        ...ticket,
        tool_claims: ['playwright:page:execute', 'playwright:*:execute'],
      };
      const exact = { ...ticket, tool_claims: ['playwright:server-rce:execute'] };
      const readOnly = { ...exact, role: 'reviewer', writable: false };
      expect(toolClaimAllows(['playwright:*:execute'], event.external_tool)).toBe(false);
      expect(evaluateLifecyclePolicy(event, { state: highRiskState, ticket: generic }).decision).toBe('deny');
      expect(evaluateLifecyclePolicy(event, { state, ticket: exact }).decision).toBe('deny');
      expect(evaluateLifecyclePolicy(event, { state: highRiskState, ticket: readOnly }).decision).toBe('deny');
      expect(evaluateLifecyclePolicy(event, { state: highRiskState, ticket: exact }).decision).toBe('allow');
    },
  );

  it('treats the unsafe Playwright filename as an input file requiring separate authority', () => {
    const classification = classifyExternalTool(
      'mcp__playwright__browser_run_code_unsafe',
      { filename: 'tools/server-script.js' },
    );
    expect(toolClaimAllows(['playwright:server-rce:execute'], classification)).toBe(false);
    expect(toolClaimAllows([
      'playwright:server-rce:execute',
      'playwright:file:tools/server-script.js:execute',
    ], classification)).toBe(true);
    expect(classification.resources).not.toContain('artifact:tools/server-script.js');
  });
});

describe('APE v2 exact command profiles', () => {
  it.each(['claude', 'codex'])('admits an exact role-authorized Unity batch profile on %s', async (host) => {
    const dir = await project();
    const command = '/Applications/Unity/Unity -batchmode -quit -runTests';
    await writeFile(runtimePaths(dir).config, JSON.stringify({
      policy: {
        command_profiles: [{ id: 'unity-tests', command, roles: ['implementer'], effect: 'execute' }],
      },
    }));
    const event = normalizeLifecycleEvent({
      hook_event_name: 'PreToolUse', project_dir: dir, tool_name: 'Bash',
      tool_input: { command }, agent_id: 'native-agent',
    }, host === 'claude' ? { CLAUDECODE: '1' } : {});
    expect(evaluateLifecyclePolicy(event, { state, ticket }).decision).toBe('allow');
    const drifted = { ...event, command: `${command} -executeMethod Build.Player` };
    expect(evaluateLifecyclePolicy(drifted, { state, ticket }).decision).toBe('deny');
  });

  it('validates command profiles at config-set time', async () => {
    const dir = await project();
    const paths = runtimePaths(dir);
    await expect(setRuntimeConfig(paths.config, 'policy.command_profiles', [{
      id: 'unity-tests', command: 'unity -batchmode -runTests', roles: ['test_writer'], effect: 'execute',
    }])).resolves.toBeDefined();
    await expect(setRuntimeConfig(paths.config, 'policy.command_profiles', [{
      id: 'unsafe', command: 'unity\nrm -rf x', roles: ['implementer'], effect: 'write',
    }])).rejects.toThrow(/single-line command/);
    expect(DEFAULT_CONFIG.policy.command_profiles).toEqual([]);
  });
});

describe('APE v2 external-tool schema surfaces', () => {
  it('threads tool claims through start and ticket schemas', () => {
    const start = RunStartInputSchema.parse({
      objective: 'Edit one scene', mode: 'phase', lane: 'fast', host: 'codex',
      claimed_paths: ['Assets/Scenes/Main.unity'], test_paths: ['Assets/Tests'],
      tool_claims: ['unity:scene:Assets/Scenes/Main.unity:write'],
      requirements: [], risk_triggers: [], behavioral: true,
      hooks_trusted: true, subagents_available: true, explicit_invocation: true,
    });
    expect(start.tool_claims).toEqual(['unity:scene:Assets/Scenes/Main.unity:write']);
    expect(() => RunStartInputSchema.parse({ ...start, tool_claims: ['unity:anything:admin'] })).toThrow();

    const finalized = finalizeTicket({
      schema_version: '2.0.0', ticket_id: 'ticket-1', run_id: 'run-1', stage_id: 'build',
      parallel_group: null, role: 'implementer', objective: 'Edit scene',
      claimed_paths: ['Assets/Scenes/Main.unity'], test_paths: [],
      tool_claims: start.tool_claims, model_tier: 'balanced', model: {},
      deadline_at: new Date().toISOString(), output_schema: {}, required_checks: [],
      parent_hash: null, base_tree_sha: 'a'.repeat(40), attempt: 1, writable: true,
      issued_at: new Date().toISOString(),
    });
    expect(finalized.tool_claims).toEqual(start.tool_claims);
  });

  it('carries an exact server-rce claim and recognized risk trigger from start into the ticket', async () => {
    const dir = await project();
    await mkdir(path.join(dir, 'docs'), { recursive: true });
    await writeFile(path.join(dir, 'docs', 'notes.md'), '# Notes\n');
    await writeFile(path.join(dir, 'package.json'), JSON.stringify({
      scripts: { test: 'node --test' },
    }));
    execFileSync('git', ['init', '-q'], { cwd: dir });
    execFileSync('git', ['config', 'user.email', 'ape@example.test'], { cwd: dir });
    execFileSync('git', ['config', 'user.name', 'APE Test'], { cwd: dir });
    execFileSync('git', ['add', '.'], { cwd: dir });
    execFileSync('git', ['commit', '-qm', 'baseline'], { cwd: dir });
    const privilegedClaim = 'playwright:server-rce:execute';
    const started = await startRun(dir, {
      objective: 'Run a privileged Playwright server-side diagnostic',
      mode: 'phase', lane: 'full', host: 'claude',
      claimed_paths: ['docs/notes.md'], tool_claims: [privilegedClaim],
      test_paths: ['tests/security.test.js'],
      requirements: [], risk_triggers: ['security'], behavioral: true,
      hooks_trusted: true, subagents_available: true, explicit_invocation: true,
    });
    expect(started.ok).toBe(true);
    expect(started.run.high_risk).toBe(true);
    expect(started.run.risk_triggers).toEqual(['security']);
    expect(started.run.tool_claims).toEqual([privilegedClaim]);
    const issued = started.run.tickets.at(-1);
    expect(issued).toMatchObject({ writable: false, tool_claims: [privilegedClaim] });
    const unsafe = classifyExternalTool(
      'mcp__playwright__browser_run_code_unsafe',
      { code: 'console.log(process.version)' },
    );
    expect(externalToolPolicy(unsafe, {
      state: started.run, ticket: issued, isSubagent: true,
    }).decision).toBe('deny');
  });

  it('seals runtime-observed tool effects into receipt hashes', () => {
    const receipt = finalizeReceipt({
      schema_version: '2.0.0', receipt_id: 'receipt-1', run_id: 'run-1', ticket_id: 'ticket-1',
      ticket_hash: 'b'.repeat(64),
      agent: { host: 'codex', role: 'implementer', identity: 'agent-1', model: null },
      status: 'passed', base_tree_sha: 'a'.repeat(40), head_tree_sha: 'c'.repeat(40), changed_files: [],
      tests: [], findings: [], evidence: {},
      tool_effects: [{
        provider: 'unity', operation: 'save_scene', effect: 'write',
        resources: ['scene:Assets/Scenes/Main.unity'], tool_use_id: 'tool-1',
        status: 'completed', response_hash: 'd'.repeat(64), occurred_at: new Date().toISOString(),
      }],
      timing: { started_at: new Date().toISOString(), completed_at: new Date().toISOString(), duration_ms: 1 },
      previous_receipt_hash: null,
    });
    expect(receipt.tool_effects).toHaveLength(1);
    expect(receipt.receipt_hash).toHaveLength(64);
  });
});

describe('APE v2 editor and browser doctor discovery', () => {
  it('detects a Unity project and declared provider without claiming live connectivity', async () => {
    const dir = await project();
    await mkdir(path.join(dir, 'Assets'), { recursive: true });
    await mkdir(path.join(dir, 'Packages'), { recursive: true });
    await mkdir(path.join(dir, 'ProjectSettings'), { recursive: true });
    await writeFile(path.join(dir, 'Packages', 'manifest.json'), JSON.stringify({
      dependencies: { 'com.ivanmurzak.unity.mcp': '1.0.0' },
    }));
    await writeFile(path.join(dir, 'ProjectSettings', 'ProjectVersion.txt'), 'm_EditorVersion: 6000.0.1f1\n');
    const report = await doctor(dir, {});
    const unityProject = report.checks.find((check) => check.name === 'unity-project');
    const provider = report.checks.find((check) => check.name === 'unity-mcp-provider');
    expect(unityProject).toMatchObject({ passed: true, informational: true });
    expect(provider).toMatchObject({ passed: true, informational: true });
    expect(provider.detail).toMatch(/live Editor connectivity still requires/);
  });

  it('detects Blender and Playwright projects plus provider configuration', async () => {
    const blender = await project();
    await writeFile(path.join(blender, 'scene.blend'), 'BLENDER');
    await writeFile(path.join(blender, '.mcp.json'), JSON.stringify({
      mcpServers: { blender: { command: 'uvx', args: ['blender-mcp'] } },
    }));
    const blenderReport = await doctor(blender, {});
    expect(blenderReport.checks.find((check) => check.name === 'blender-project')).toMatchObject({ passed: true });
    expect(blenderReport.checks.find((check) => check.name === 'blender-mcp-provider')).toMatchObject({ passed: true });

    const playwright = await project();
    await writeFile(path.join(playwright, 'package.json'), JSON.stringify({
      devDependencies: { '@playwright/test': '^1.0.0' },
    }));
    await writeFile(path.join(playwright, '.mcp.json'), JSON.stringify({
      mcpServers: { playwright: { command: 'npx', args: ['@playwright/mcp@latest'] } },
    }));
    const playwrightReport = await doctor(playwright, {});
    expect(playwrightReport.checks.find((check) => check.name === 'playwright-project')).toMatchObject({ passed: true });
    expect(playwrightReport.checks.find((check) => check.name === 'playwright-mcp-provider')).toMatchObject({ passed: true });
  });

  it('detects project-scoped GitHub and Codex Security MCP declarations', async () => {
    const dir = await project();
    await mkdir(path.join(dir, '.codex'), { recursive: true });
    await writeFile(path.join(dir, '.codex', 'config.toml'), [
      '[mcp_servers.github]',
      'url = "https://api.githubcopilot.com/mcp/"',
      '[mcp_servers.codex-security]',
      'command = "codex-security"',
      '',
    ].join('\n'));
    const report = await doctor(dir, {});
    expect(report.checks.find((check) => check.name === 'github-mcp-provider')).toMatchObject({
      passed: true,
      informational: true,
      detail: expect.stringContaining('read-only GitHub'),
    });
    expect(report.checks.find((check) => check.name === 'codex-security-mcp-provider')).toMatchObject({
      passed: true,
      informational: true,
      detail: expect.stringContaining('triage-result inspection only'),
    });
  });
});

describe('APE v2 runtime-observed external tool effects', () => {
  it('seals claimed Unity and current Playwright MCP effects from Pre/Post hooks into the receipt', async () => {
    const dir = await project();
    await mkdir(path.join(dir, 'docs'), { recursive: true });
    await writeFile(path.join(dir, 'docs', 'Main.md'), 'asset: before\n');
    execFileSync('git', ['init', '-q'], { cwd: dir });
    execFileSync('git', ['config', 'user.email', 'ape@example.test'], { cwd: dir });
    execFileSync('git', ['config', 'user.name', 'APE Test'], { cwd: dir });
    execFileSync('git', ['add', '.'], { cwd: dir });
    execFileSync('git', ['commit', '-qm', 'baseline'], { cwd: dir });
    const started = await startRun(dir, {
      objective: 'Update the claimed Unity asset through MCP', mode: 'phase', lane: 'mechanical',
      host: 'codex', binding_protocol: 'native-v1', claimed_paths: ['docs/Main.md'],
      tool_claims: [
        'unity:asset:docs/Main.md:write',
        'playwright:page:read',
        'github:repo:octo-org/hello-world:read',
        'acme_plugin:tool:get_status:read',
      ],
      test_paths: [], requirements: [],
      risk_triggers: [], behavioral: false, hooks_trusted: true,
      subagents_available: true, explicit_invocation: true,
    });
    const action = started.actions.find((entry) => entry.type === 'dispatch_agent');
    const binding = await bindCodexDispatchContext(root, dir, action);
    const base = {
      project_dir: dir,
      session_id: binding.sessionId,
      turn_id: 'turn-1',
      agent_id: binding.agentId,
      agent_type: action.dispatch.agent_type,
      tool_name: 'mcp__unity__save_asset',
      tool_input: { asset_path: 'docs/Main.md' },
      tool_use_id: 'unity-save-1',
    };
    const pluginBase = {
      ...base,
      tool_name: 'mcp__acme_plugin__get_status',
      tool_input: {},
      tool_use_id: 'acme-status-1',
    };
    expect(await invokeCodexHook(root, {
      ...pluginBase,
      hook_event_name: 'PreToolUse',
    })).toEqual({});
    expect((await invokeCodexHook(root, {
      ...pluginBase,
      hook_event_name: 'PostToolUse',
      tool_response: { status: 'ok' },
    })).decision).not.toBe('block');

    const githubBase = {
      ...base,
      tool_name: 'mcp__codex_apps__github_fetch_file',
      tool_input: { repository_full_name: 'octo-org/hello-world', path: 'README.md' },
      tool_use_id: 'github-read-1',
    };
    expect(await invokeCodexHook(root, {
      ...githubBase,
      hook_event_name: 'PreToolUse',
    })).toEqual({});
    expect((await invokeCodexHook(root, {
      ...githubBase,
      hook_event_name: 'PostToolUse',
      tool_response: { content: '# hello' },
    })).decision).not.toBe('block');

    const pre = await invokeCodexHook(root, { ...base, hook_event_name: 'PreToolUse' });
    expect(pre).toEqual({});
    await writeFile(path.join(dir, 'docs', 'Main.md'), 'asset: after\n');
    const post = await invokeCodexHook(root, {
      ...base,
      hook_event_name: 'PostToolUse',
      tool_response: { saved: true },
    });
    expect(post.decision, JSON.stringify(post)).not.toBe('block');

    const playwrightBase = {
      ...base,
      tool_name: 'mcp__playwright__browser_find',
      tool_input: { text: 'Dashboard' },
      tool_use_id: 'playwright-find-1',
    };
    const playwrightPre = await invokeCodexHook(root, {
      ...playwrightBase,
      hook_event_name: 'PreToolUse',
    });
    expect(playwrightPre).toEqual({});
    const playwrightPost = await invokeCodexHook(root, {
      ...playwrightBase,
      hook_event_name: 'PostToolUse',
      tool_response: { matches: ['Dashboard'] },
    });
    expect(playwrightPost.decision, JSON.stringify(playwrightPost)).not.toBe('block');

    const receipt = await recordReceipt(dir, {
      ticket_id: action.ticket.ticket_id,
      receipt_capability: binding.capability,
      status: 'passed', tests: [], findings: [], evidence: { verdict: 'pass' },
      timing: { started_at: action.ticket.issued_at, duration_ms: 1 },
      tool_effects: [{ provider: 'forged' }],
    });
    expect(receipt.ok).toBe(true);
    expect(receipt.receipt.tool_effects).toEqual([
      expect.objectContaining({
        provider: 'acme_plugin', operation: 'get_status', effect: 'read',
        resources: ['tool:get_status'], status: 'completed',
      }),
      expect.objectContaining({
        provider: 'github', operation: 'fetch_file', effect: 'read',
        resources: ['repo:octo-org/hello-world'], status: 'completed',
      }),
      expect.objectContaining({
        provider: 'unity', operation: 'save_asset', effect: 'write',
        resources: ['asset:docs/Main.md'], status: 'completed',
      }),
      expect.objectContaining({
        provider: 'playwright', operation: 'browser_find', effect: 'read',
        resources: ['page'], status: 'completed',
      }),
    ]);
    expect(receipt.receipt.tool_effects.every((effect) => effect.provider !== 'forged')).toBe(true);
  });
});
