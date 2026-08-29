import { execFileSync, spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { LANES } from '../lib/runtime/constants.js';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

const verificationProfiles = [{
  id: 'api-contract',
  description: 'Verify the fixture API contract.',
  command: 'node --test',
  timeout_ms: 30_000,
}];

function session(messages) {
  return new Promise((resolve, reject) => {
    // Strip the ambient host project pins so root resolution is driven by
    // the call arguments alone, not the live session env of whoever runs
    // the suite.
    const env = { ...process.env };
    delete env.CLAUDE_PROJECT_DIR;
    delete env.CODEX_CWD;
    const child = spawn(process.execPath, [path.join(root, 'bin', 'ape-mcp.mjs')], {
      cwd: root,
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code !== 0) reject(new Error(stderr));
      else resolve(stdout.trim().split(/\r?\n/).map((line) => JSON.parse(line)));
    });
    child.stdin.end(messages.map((message) => JSON.stringify(message)).join('\n') + '\n');
  });
}

describe('APE v2 MCP public surface', () => {
  it('exposes ape_status beside the legacy control-plane tools', async () => {
    const responses = await session([
      { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } },
      { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} },
    ]);
    // The advertised version is read from package.json, never a literal a
    // release bump has to chase.
    const pkg = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
    expect(responses[0].result.serverInfo.version).toBe(pkg.version);
    expect(responses[1].result.tools.map((tool) => tool.name)).toEqual([
      'ape_run',
      'ape_validate_receipt',
      'ape_status',
      'ape_history',
      'ape_config',
    ]);
    const status = responses[1].result.tools.find((tool) => tool.name === 'ape_status');
    expect(status.annotations).toMatchObject({ readOnlyHint: true });
    expect(status.inputSchema).toMatchObject({
      type: 'object',
      additionalProperties: false,
    });
    const receiptValidator = responses[1].result.tools.find(
      (tool) => tool.name === 'ape_validate_receipt',
    );
    expect(receiptValidator.description).toMatch(
      /valid result is terminal[\s\S]*no continuation action[\s\S]*exact validated draft unchanged[\s\S]*do not validate it again/iu,
    );
    expect(receiptValidator.inputSchema).toMatchObject({
      required: ['ticket_id', 'draft'],
      additionalProperties: false,
      properties: {
        ticket_id: { type: 'string' },
        draft: { type: 'object' },
      },
    });
  });

  it('serves ape_status as the compact channel while ape_run status remains available', async () => {
    const scratch = await mkdtemp(path.join(os.tmpdir(), 'ape-mcp-status-'));
    try {
      const responses = await session([
        {
          jsonrpc: '2.0',
          id: 1,
          method: 'tools/call',
          params: { name: 'ape_status', arguments: { project_dir: scratch } },
        },
        {
          jsonrpc: '2.0',
          id: 2,
          method: 'tools/call',
          params: { name: 'ape_run', arguments: { action: 'status', project_dir: scratch } },
        },
      ]);
      const compact = JSON.parse(responses[0].result.content[0].text);
      const legacy = JSON.parse(responses[1].result.content[0].text);
      expect(compact).toMatchObject({
        active: false,
        pending: null,
        gate: { state: 'inactive' },
        next_safe_action: 'ape_run start',
      });
      expect(legacy).toMatchObject({ active: false, run: null });
      expect(legacy).not.toHaveProperty('pending');
    } finally {
      await rm(scratch, { recursive: true, force: true });
    }
  });

  it('advertises every runtime lane — including mechanical — on the ape_run start schema (F43)', async () => {
    const responses = await session([
      { jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} },
    ]);
    const run = responses[0].result.tools.find((tool) => tool.name === 'ape_run');
    // The MCP surface must mirror the runtime's LANES constant so a caller can
    // request the mechanical lane that RunStartInputSchema accepts.
    expect(run.inputSchema.properties.lane.enum).toEqual([...LANES]);
    expect(run.inputSchema.properties.lane.enum).toContain('mechanical');
    expect(run.inputSchema.properties.tool_claims).toMatchObject({
      type: 'array',
      items: { type: 'string' },
    });
    expect(run.inputSchema.properties.tool_claims.description).toMatch(/provider:resource:read\|write\|execute/);
    expect(run.inputSchema.properties.action.enum).toEqual(expect.arrayContaining([
      'probe',
      'probe-status',
      'probe-ack',
      'preview',
      'start',
    ]));
    expect(run.inputSchema.allOf).toContainEqual({
      if: {
        properties: { action: { enum: ['preview', 'start'] } },
        required: ['action'],
      },
      then: { required: ['objective', 'host'] },
    });
    expect(run.inputSchema.properties).not.toHaveProperty('execution_budget');
    expect(run.inputSchema.properties).not.toHaveProperty('max_worker_dispatches');
    expect(run.inputSchema.properties).not.toHaveProperty('max_active_seconds');
    expect(run.inputSchema.properties.action.enum).not.toContain('extend-budget');
    const capabilityVariants = run.inputSchema.properties.required_capabilities.items.oneOf;
    expect(capabilityVariants.map((variant) => variant.properties.kind.const)).toEqual([
      'command_profile',
      'verification_profile',
      'evidence_command',
      'tool_claim',
    ]);
    const toolClaim = capabilityVariants.find(
      (variant) => variant.properties.kind.const === 'tool_claim',
    );
    expect(toolClaim.properties.id).toMatchObject({
      minLength: 3,
      maxLength: 4096,
      pattern: expect.stringContaining('read|write|execute'),
    });
    expect(run.inputSchema.properties.probe_id).toMatchObject({ type: 'string' });
    expect(run.inputSchema.properties.probe_capability).toMatchObject({ type: 'string' });
    expect(run.description).toMatch(/Preview and start require the same complete prospective run facts[\s\S]*objective and host/iu);
    expect(run.description).toMatch(/first call must include[\s\S]*explicit_invocation: true[\s\S]*hooks_trusted: true[\s\S]*subagents_available: true/i);
    expect(run.inputSchema.properties.action.description)
      .toMatch(/Preview and start require identical complete prospective facts[\s\S]*objective and host/iu);
    expect(run.inputSchema.properties.action.description).toMatch(/initial call[\s\S]*explicit_invocation: true[\s\S]*hooks_trusted: true[\s\S]*subagents_available: true/i);
    expect(run.inputSchema.properties.action.description).toMatch(/action status[\s\S]*only action and project_dir[\s\S]*never send run_id/i);
    for (const field of ['explicit_invocation', 'hooks_trusted', 'subagents_available']) {
      expect(run.inputSchema.properties[field].description).toMatch(/initial Codex probe call/i);
    }
  });

  it('advertises aimed answer-preflight with a mandatory audit reason and canonical additive-only scope fields', async () => {
    const responses = await session([
      { jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} },
    ]);
    const run = responses[0].result.tools.find((tool) => tool.name === 'ape_run');
    expect(run.inputSchema.properties.action.enum).toContain('answer-preflight');
    for (const field of [
      'reason', 'preflight_hash', 'answers', 'claimed_paths', 'test_paths', 'risk_triggers',
    ]) {
      expect(run.inputSchema.properties).toHaveProperty(field);
    }
    for (const legacyField of ['add_claimed_paths', 'add_test_paths', 'add_risk_triggers']) {
      expect(run.inputSchema.properties).not.toHaveProperty(legacyField);
    }
    expect(run.inputSchema.properties).not.toHaveProperty('remove_claimed_paths');
    expect(run.inputSchema.properties).not.toHaveProperty('remove_test_paths');
    expect(run.inputSchema.properties).not.toHaveProperty('remove_risk_triggers');
  });

  it('advertises bounded audited artifact maintenance on ape_history', async () => {
    const responses = await session([
      { jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} },
    ]);
    const history = responses[0].result.tools.find((tool) => tool.name === 'ape_history');
    expect(history.inputSchema.properties.action.enum).toContain('compact-artifacts');
    expect(history.inputSchema.properties.action.enum).toContain('maintenance-status');
    expect(history.inputSchema.properties.keep_recent_runs).toMatchObject({
      type: 'integer',
      minimum: 0,
      maximum: 10000,
    });
    expect(history.inputSchema.properties.max_runs).toMatchObject({
      type: 'integer',
      minimum: 1,
      maximum: 256,
    });
    expect(history.inputSchema.properties.reason.description).toMatch(/compact-artifacts/);
  });

  it('rejects abort carrying an operation instead of silently dropping it', async () => {
    // The guard throws before abortRun runs. project_dir additionally aims
    // the mutating call at an empty scratch dir so a guard regression fails
    // against nothing instead of this repo's live .ape state.
    const scratch = await mkdtemp(path.join(os.tmpdir(), 'ape-mcp-guard-'));
    const responses = await session([
      {
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: {
          name: 'ape_run',
          arguments: {
            action: 'abort',
            operation: 'reset',
            reason: 'operator cleanup',
            project_dir: scratch,
          },
        },
      },
    ]);
    expect(responses[0].result.isError).toBe(true);
    const text = responses[0].result.content[0].text;
    expect(text).toMatch(/operation 'reset' belongs to action 'override'/);
    expect(text).toMatch(/"action":"override"/);
    expect(text).toMatch(/"operation":"reset"/);
  });

  it('keeps malformed input from killing the server loop', async () => {
    const responses = await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [path.join(root, 'bin', 'ape-mcp.mjs')], {
        cwd: root,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      let stdout = '';
      child.stdout.on('data', (chunk) => { stdout += chunk; });
      child.on('error', reject);
      child.on('close', () => resolve(stdout.trim().split(/\r?\n/).map((line) => JSON.parse(line))));
      child.stdin.end('{bad json}\n{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}\n');
    });
    expect(responses[0].error.code).toBe(-32700);
    expect(responses[1].result.tools).toHaveLength(5);
  });

  it.each(['claude', 'codex'])('applies the correct native binding precondition for %s', async (host) => {
    const scratch = await mkdtemp(path.join(os.tmpdir(), `ape-mcp-${host}-start-`));
    try {
      await writeFile(path.join(scratch, 'README.md'), '# fixture\n');
      execFileSync('git', ['init', '-q'], { cwd: scratch });
      execFileSync('git', ['config', 'user.email', 'ape@example.test'], { cwd: scratch });
      execFileSync('git', ['config', 'user.name', 'APE Test'], { cwd: scratch });
      execFileSync('git', ['add', '.'], { cwd: scratch });
      execFileSync('git', ['commit', '-qm', 'test: baseline'], { cwd: scratch });
      const responses = await session([
        {
          jsonrpc: '2.0',
          id: 1,
          method: 'tools/call',
          params: {
            name: 'ape_run',
            arguments: {
              action: 'start',
              project_dir: scratch,
              objective: 'Update the fixture documentation',
              mode: 'phase',
              lane: 'mechanical',
              host,
              claimed_paths: ['README.md'],
              behavioral: false,
              hooks_trusted: true,
              subagents_available: true,
              explicit_invocation: true,
            },
          },
        },
      ]);
      const started = JSON.parse(responses[0].result.content[0].text);
      if (host === 'claude') {
        expect(responses[0].result.isError).not.toBe(true);
        expect(started.run.plan_contract_version).toBe(1);
        expect(started).not.toHaveProperty('binding_probe');
      } else {
        expect(responses[0].result.isError).toBe(true);
        expect(started).toMatchObject({
          ok: false,
          blocked: true,
          infrastructure_failure: true,
          attempts_consumed: 0,
          probe: { status: 'missing', infrastructure_status: 'required' },
        });
      }
    } finally {
      await rm(scratch, { recursive: true, force: true });
    }
  });

  it('defaults omitted mode and version for Claude fast behavioral starts before selecting preflight', async () => {
    const scratch = await mkdtemp(path.join(os.tmpdir(), 'ape-mcp-claude-preflight-'));
    try {
      await mkdir(path.join(scratch, '.ape', 'runtime'), { recursive: true });
      await writeFile(path.join(scratch, '.ape', 'runtime', 'config.json'), JSON.stringify({
        shipping: { auto_merge: false, provider: 'github', required_remote_checks: false },
        test_commands: { targeted_template: 'node --test {paths}', full: 'node --test' },
        verification: { profiles: verificationProfiles },
      }));
      await writeFile(path.join(scratch, 'value.js'), 'export const value = 1;\n');
      await writeFile(path.join(scratch, 'value.test.js'), 'import "./value.js";\n');
      execFileSync('git', ['init', '-q'], { cwd: scratch });
      execFileSync('git', ['config', 'user.email', 'ape@example.test'], { cwd: scratch });
      execFileSync('git', ['config', 'user.name', 'APE Test'], { cwd: scratch });
      execFileSync('git', ['add', '.'], { cwd: scratch });
      execFileSync('git', ['commit', '-qm', 'test: baseline'], { cwd: scratch });

      const responses = await session([{
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: {
          name: 'ape_run',
          arguments: {
            action: 'start',
            project_dir: scratch,
            objective: 'Change the fixture behavior.',
            lane: 'fast',
            host: 'claude',
            claimed_paths: ['value.js'],
            test_paths: ['value.test.js'],
            behavioral: true,
            hooks_trusted: true,
            subagents_available: true,
            explicit_invocation: true,
          },
        },
      }]);
      expect(responses[0].result.isError).not.toBe(true);
      const started = JSON.parse(responses[0].result.content[0].text);
      expect(started.run.mode).toBe('phase');
      expect(started.run.plan_contract_version).toBe(2);
      expect(started.run.verification_profiles).toEqual(verificationProfiles);
      const ticket = started.actions.find((action) => action.type === 'dispatch_agent')?.ticket;
      expect(ticket).toMatchObject({
        stage_id: 'preflight',
        role: 'preflight_analyst',
        writable: false,
        plan_contract_version: 2,
        verification_profiles: verificationProfiles,
      });
    } finally {
      await rm(scratch, { recursive: true, force: true });
    }
  }, 30_000);

  it('defaults omitted mode to phase and plan v2 when behavioral mechanical escalates to full', async () => {
    const scratch = await mkdtemp(path.join(os.tmpdir(), 'ape-mcp-claude-mechanical-escalation-'));
    try {
      await mkdir(path.join(scratch, '.ape', 'runtime'), { recursive: true });
      await writeFile(path.join(scratch, '.ape', 'runtime', 'config.json'), JSON.stringify({
        shipping: { auto_merge: false, provider: 'github', required_remote_checks: false },
        test_commands: { targeted_template: 'node --test {paths}', full: 'node --test' },
        verification: { profiles: verificationProfiles },
      }));
      await writeFile(path.join(scratch, 'value.js'), 'export const value = 1;\n');
      await writeFile(path.join(scratch, 'value.test.js'), 'import "./value.js";\n');
      execFileSync('git', ['init', '-q'], { cwd: scratch });
      execFileSync('git', ['config', 'user.email', 'ape@example.test'], { cwd: scratch });
      execFileSync('git', ['config', 'user.name', 'APE Test'], { cwd: scratch });
      execFileSync('git', ['add', '.'], { cwd: scratch });
      execFileSync('git', ['commit', '-qm', 'test: baseline'], { cwd: scratch });

      const responses = await session([{
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: {
          name: 'ape_run',
          arguments: {
            action: 'start',
            project_dir: scratch,
            objective: 'Change behavior despite a mechanical lane request.',
            lane: 'mechanical',
            host: 'claude',
            claimed_paths: ['value.js'],
            test_paths: ['value.test.js'],
            risk_triggers: ['public-api'],
            behavioral: true,
            hooks_trusted: true,
            subagents_available: true,
            explicit_invocation: true,
          },
        },
      }]);

      expect(responses[0].result.isError).not.toBe(true);
      const started = JSON.parse(responses[0].result.content[0].text);
      expect(started.run).toMatchObject({
        mode: 'phase',
        lane: 'full',
        plan_contract_version: 2,
        verification_profiles: verificationProfiles,
      });
      expect(started.run.risk_triggers).toEqual(['public-api']);
      const ticket = started.actions.find((action) => action.type === 'dispatch_agent')?.ticket;
      expect(ticket).toMatchObject({
        stage_id: 'preflight',
        role: 'preflight_analyst',
        writable: false,
        plan_contract_version: 2,
        verification_profiles: verificationProfiles,
      });
    } finally {
      await rm(scratch, { recursive: true, force: true });
    }
  }, 30_000);

  it('forwards explicit-v1 context to the legacy Claude full-run planner without preflight profiles', async () => {
    const scratch = await mkdtemp(path.join(os.tmpdir(), 'ape-mcp-claude-plan-v1-'));
    try {
      await mkdir(path.join(scratch, '.ape', 'runtime'), { recursive: true });
      await writeFile(path.join(scratch, '.ape', 'runtime', 'config.json'), JSON.stringify({
        shipping: { auto_merge: false, provider: 'github', required_remote_checks: false },
        test_commands: { targeted_template: 'node --test {paths}', full: 'node --test' },
        verification: { profiles: verificationProfiles },
      }));
      await writeFile(path.join(scratch, 'value.js'), 'export const value = 1;\n');
      await writeFile(path.join(scratch, 'value.test.js'), 'import "./value.js";\n');
      execFileSync('git', ['init', '-q'], { cwd: scratch });
      execFileSync('git', ['config', 'user.email', 'ape@example.test'], { cwd: scratch });
      execFileSync('git', ['config', 'user.name', 'APE Test'], { cwd: scratch });
      execFileSync('git', ['add', '.'], { cwd: scratch });
      execFileSync('git', ['commit', '-qm', 'test: baseline'], { cwd: scratch });

      const responses = await session([{
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: {
          name: 'ape_run',
          arguments: {
            action: 'start',
            project_dir: scratch,
            objective: 'Change the fixture behavior through the legacy plan contract.',
            mode: 'phase',
            lane: 'full',
            host: 'claude',
            claimed_paths: ['value.js'],
            test_paths: ['value.test.js'],
            behavioral: true,
            hooks_trusted: true,
            subagents_available: true,
            explicit_invocation: true,
            plan_contract_version: 1,
          },
        },
      }]);
      expect(responses[0].result.isError).not.toBe(true);
      const started = JSON.parse(responses[0].result.content[0].text);
      expect(started.run.plan_contract_version).toBe(1);
      const ticket = started.actions.find((action) => action.type === 'dispatch_agent')?.ticket;
      expect(ticket).toMatchObject({
        stage_id: 'plan',
        role: 'planner',
        writable: false,
        plan_contract_version: 1,
      });
      expect(ticket).not.toHaveProperty('verification_profiles');
    } finally {
      await rm(scratch, { recursive: true, force: true });
    }
  }, 30_000);

  it('accepts answer-preflight without optional fields over the MCP wire', async () => {
    const scratch = await mkdtemp(path.join(os.tmpdir(), 'ape-mcp-answer-'));
    try {
      await mkdir(path.join(scratch, '.ape', 'runtime'), { recursive: true });
      await writeFile(path.join(scratch, '.ape', 'runtime', 'config.json'), JSON.stringify({
        shipping: { auto_merge: false, provider: 'github', required_remote_checks: false },
        test_commands: { targeted_template: 'node --test {paths}', full: 'node --test' },
      }));
      await writeFile(path.join(scratch, 'value.js'), 'export const value = 1;\n');
      await writeFile(path.join(scratch, 'value.test.js'), 'import "./value.js";\n');
      execFileSync('git', ['init', '-q'], { cwd: scratch });
      execFileSync('git', ['config', 'user.email', 'ape@example.test'], { cwd: scratch });
      execFileSync('git', ['config', 'user.name', 'APE Test'], { cwd: scratch });
      execFileSync('git', ['add', '.'], { cwd: scratch });
      execFileSync('git', ['commit', '-qm', 'test: baseline'], { cwd: scratch });
      const branch = execFileSync('git', ['branch', '--show-current'], { cwd: scratch, encoding: 'utf8' }).trim();
      const commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: scratch, encoding: 'utf8' }).trim();
      const tree = execFileSync('git', ['rev-parse', 'HEAD^{tree}'], { cwd: scratch, encoding: 'utf8' }).trim();

      const preflightHash = 'a'.repeat(64);
      await writeFile(path.join(scratch, '.ape', 'runtime', 'active.json'), JSON.stringify({
        schema_version: '2.0.0', run_id: 'run-mcp-answer', status: 'input_required', stage: 'preflight',
        mode: 'phase', lane: 'fast', behavioral: true, plan_contract_version: 2,
        objective: 'Answer the material preflight questions over MCP', host: 'claude',
        branch, base_commit_sha: commit, tree_sha: tree,
        policy: { high_risk_security_review: true },
        claimed_paths: ['value.js'], test_paths: ['value.test.js'], risk_triggers: [],
        tickets: [], receipts: [], expired_tickets: [], audit: [],
        preflight: {
          version: 1, artifact_hash: preflightHash,
          questions: [
            { id: 'api-name', question: 'Which API name stays stable?', rationale: 'Compatibility' },
          ],
          artifact: {
            questions: [
              { id: 'api-name', question: 'Which API name stays stable?', rationale: 'Compatibility' },
            ],
          },
        },
        input_required: { preflight_hash: preflightHash, question_ids: ['api-name'] },
      }));

      const responses = await session([{
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: {
          name: 'ape_run',
          arguments: {
            action: 'answer-preflight',
            project_dir: scratch,
            preflight_hash: preflightHash,
            reason: 'Operator answering question over MCP wire without optional fields',
            answers: [
              { id: 'api-name', answer: 'Keep value export unchanged.' },
            ],
          },
        },
      }]);
      expect(responses[0].result.isError).not.toBe(true);
      const result = JSON.parse(responses[0].result.content[0].text);
      expect(result.run.status).toBe('running');
      expect(result.run.lane).toBe('fast');
      expect(result.run.stage).toBe('test');
      expect(result.run.claimed_paths).toEqual(['value.js']);
    } finally {
      await rm(scratch, { recursive: true, force: true });
    }
  }, 30_000);
});
