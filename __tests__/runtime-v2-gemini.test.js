import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { DEFAULT_MODELS } from '../lib/runtime/constants.js';
import { runtimeHost, resolveGovernedRoot, runtimePaths } from '../lib/runtime/paths.js';
import { nativeDispatch } from '../lib/runtime/adapters.js';
import { statuslineState, wireStatusline, unwireStatusline } from '../lib/runtime/statusline.js';
import {
  bindGeminiInvocation,
  launchGeminiIntent,
  prepareGeminiIntent,
} from '../lib/runtime/claude-dispatch.js';
import {
  encodeGeminiProjectDir,
  extractGeminiPromptContext,
  normalizeGeminiHookInput,
} from '../lib/runtime/gemini-host.js';
import {
  SAFE_SUBAGENT_TOOLS,
  isAgentDispatchTool,
  normalizeLifecycleEvent,
  evaluateLifecyclePolicy,
} from '../lib/runtime/hooks.js';
import { WRITE_TOOLS } from '../lib/runtime/write-policy.js';

const cleanups = [];

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('Gemini / Antigravity runtime integration', () => {
  describe('environment and host detection', () => {
    it('detects gemini from various environment markers', () => {
      expect(runtimeHost({ APE_HOST: 'gemini' })).toBe('gemini');
      expect(runtimeHost({ GEMINICODE: '1' })).toBe('gemini');
      expect(runtimeHost({ GEMINI_CODE: '1' })).toBe('gemini');
      expect(runtimeHost({ GEMINI_PROJECT_DIR: '/tmp/proj' })).toBe('gemini');
      expect(runtimeHost({ GEMINI_CONFIG_DIR: '/tmp/cfg' })).toBe('gemini');
      expect(runtimeHost({ ANTIGRAVITY: '1' })).toBe('gemini');
    });

    it('prefers explicit host in resolveGovernedRoot', () => {
      const root = resolveGovernedRoot({
        explicitDir: '/tmp/explicit',
        host: 'gemini',
        env: {},
      });
      expect(root).toBe('/tmp/explicit');
    });

    it('pins GEMINI_PROJECT_DIR in resolveGovernedRoot', () => {
      const root = resolveGovernedRoot({
        host: 'gemini',
        env: { GEMINI_PROJECT_DIR: '/tmp/gemini-root' },
      });
      expect(root).toBe('/tmp/gemini-root');
    });
  });

  describe('model tiers', () => {
    it('defines default model tiers for gemini', () => {
      expect(DEFAULT_MODELS.gemini).toBeDefined();
      expect(DEFAULT_MODELS.gemini.fast).toEqual({ model: 'flash' });
      expect(DEFAULT_MODELS.gemini.balanced).toEqual({ model: 'flash' });
      expect(DEFAULT_MODELS.gemini.deep).toEqual({ model: 'pro' });
    });
  });

  describe('subagent dispatch adapter', () => {
    const writableTicket = {
      role: 'implementer',
      model: { model: 'flash' },
      ticket_id: 'ticket-gemini-1',
      writable: true,
    };

    const readOnlyTicket = {
      role: 'reviewer',
      model: { model: 'pro' },
      ticket_id: 'ticket-gemini-2',
      writable: false,
    };

    it('dispatches writable roles to TypeName: "self" and invoke_subagent', () => {
      const dispatch = nativeDispatch('gemini', writableTicket);
      expect(dispatch).toMatchObject({
        host: 'gemini',
        native_tool: 'invoke_subagent',
        agent_name: 'implementer',
        agent_type: 'self',
        prompt_paths: ['prompts/common.md', 'prompts/implementer.md'],
        model: { model: 'flash' },
        ticket: writableTicket,
      });
    });

    it('dispatches read-only roles to TypeName: "research" and invoke_subagent', () => {
      const dispatch = nativeDispatch('gemini', readOnlyTicket);
      expect(dispatch).toMatchObject({
        host: 'gemini',
        native_tool: 'invoke_subagent',
        agent_name: 'reviewer',
        agent_type: 'research',
        prompt_paths: ['prompts/common.md', 'prompts/reviewer.md'],
        model: { model: 'pro' },
        ticket: readOnlyTicket,
      });
    });

    it('forwards dispatch_intent when provided', () => {
      const intent = { nonce: 'nonce-123', agent_name: 'ape_implementer_abc' };
      const dispatch = nativeDispatch('gemini', writableTicket, intent);
      expect(dispatch.dispatch_intent).toBe(intent);
      expect(dispatch.agent_name).toBe('ape_implementer_abc');
    });

    it('binds a real Antigravity child conversation during PreInvocation', async () => {
      const dir = await mkdtemp(path.join(tmpdir(), 'ape-gemini-binding-'));
      cleanups.push(dir);
      const paths = runtimePaths(dir);
      const ticket = {
        run_id: 'run-gemini-binding',
        ticket_id: 'ticket-gemini-binding',
        ticket_hash: 'a'.repeat(64),
        role: 'implementer',
        model: { model: 'flash' },
        deadline_at: new Date(Date.now() + 60_000).toISOString(),
      };
      const state = {
        run_id: ticket.run_id,
        status: 'running',
        tickets: [ticket],
        receipts: [],
      };
      const intent = await prepareGeminiIntent(paths, ticket, 'self');
      expect(extractGeminiPromptContext(intent.prompt)).toEqual({
        nonce: intent.nonce,
        project_dir: dir,
      });

      const parentInput = await normalizeGeminiHookInput({
        conversationId: 'gemini-parent-conversation',
        stepIdx: 7,
        workspacePaths: [dir],
        toolCall: {
          name: 'invoke_subagent',
          args: {
            Subagents: [{ TypeName: 'self', Model: 'flash', Prompt: intent.prompt }],
          },
        },
      }, { APE_HOST: 'gemini', APE_HOOK_EVENT: 'PreToolUse' });
      expect(await launchGeminiIntent(paths, state, parentInput)).toMatchObject({ valid: true });

      const artifactDir = path.join(dir, 'artifacts');
      const transcriptPath = path.join(artifactDir, 'child.jsonl');
      await mkdir(artifactDir, { recursive: true });
      await writeFile(transcriptPath, `${JSON.stringify({ content: intent.prompt })}\n`);
      const childInput = await normalizeGeminiHookInput({
        conversationId: 'gemini-child-conversation',
        transcriptPath,
        artifactDirectoryPath: artifactDir,
        invocationNum: 0,
        modelName: 'gemini-3.7-flash-tiered',
        workspacePaths: [],
      }, { APE_HOST: 'gemini', APE_HOOK_EVENT: 'PreInvocation' });
      expect(childInput).toMatchObject({
        hook_event_name: 'PreInvocation',
        session_id: 'gemini-child-conversation',
        project_dir: dir,
        gemini_dispatch_nonce: intent.nonce,
      });
      const bound = await bindGeminiInvocation(paths, state, childInput);
      expect(bound).toMatchObject({ matched: true, valid: true, ticket_id: ticket.ticket_id });
      expect(bound.additional_context).toMatch(/APE_RECEIPT_CAPABILITY=[A-Za-z0-9_-]{32,256}/);
    });
  });

  describe('statusline support', () => {
    it('reports native statusline mode for gemini without error', async () => {
      const state = await statuslineState({ host: 'gemini' });
      expect(state).toMatchObject({
        wired: false,
        mode: 'native',
        renderer: 'gemini-native',
        custom_renderer: false,
      });
      expect(state.limitation).toContain('Antigravity');
    });

    it('wire and unwire safely return native status without mutating files', async () => {
      const wired = await wireStatusline({ host: 'gemini' });
      expect(wired.wired).toBe(false);
      const unwired = await unwireStatusline({ host: 'gemini' });
      expect(unwired.wired).toBe(false);
    });
  });

  describe('tools and lifecycle policy normalization', () => {
    it('normalizes the current nested Antigravity tool payload and environment event', async () => {
      const input = await normalizeGeminiHookInput({
        conversationId: 'gemini-conversation',
        stepIdx: 3,
        workspacePaths: ['/tmp/ape-gemini-project'],
        toolCall: {
          name: 'replace_file_content',
          args: { TargetFile: '/tmp/ape-gemini-project/src/index.js' },
        },
      }, { APE_HOST: 'gemini', APE_HOOK_EVENT: 'PreToolUse' });
      expect(input).toMatchObject({
        hook_event_name: 'PreToolUse',
        tool_name: 'replace_file_content',
        session_id: 'gemini-conversation',
        tool_use_id: '3',
        project_dir: '/tmp/ape-gemini-project',
      });
      expect(input.tool_input).toEqual({ TargetFile: '/tmp/ape-gemini-project/src/index.js' });
    });

    it('round-trips an encoded absolute project root and rejects duplicate authority', () => {
      const encoded = encodeGeminiProjectDir('/tmp/ape-gemini-project');
      expect(extractGeminiPromptContext(
        `APE_PROJECT_DIR_B64=${encoded}\nAPE_DISPATCH_NONCE=${'n'.repeat(32)}`,
      )).toEqual({ nonce: 'n'.repeat(32), project_dir: '/tmp/ape-gemini-project' });
      expect(extractGeminiPromptContext(
        `APE_PROJECT_DIR_B64=${encoded}\nAPE_PROJECT_DIR_B64=${encoded}\nAPE_DISPATCH_NONCE=${'n'.repeat(32)}`,
      ).project_dir).toBeNull();
    });

    it('recognizes invoke_subagent as an agent dispatch tool', () => {
      expect(isAgentDispatchTool('invoke_subagent')).toBe(true);
    });

    it('includes Antigravity tools in SAFE_SUBAGENT_TOOLS and WRITE_TOOLS', () => {
      expect(SAFE_SUBAGENT_TOOLS.has('run_command')).toBe(true);
      expect(SAFE_SUBAGENT_TOOLS.has('view_file')).toBe(true);
      expect(SAFE_SUBAGENT_TOOLS.has('list_dir')).toBe(true);
      expect(SAFE_SUBAGENT_TOOLS.has('grep_search')).toBe(true);
      expect(SAFE_SUBAGENT_TOOLS.has('read_url_content')).toBe(true);

      expect(WRITE_TOOLS.has('write_to_file')).toBe(true);
      expect(WRITE_TOOLS.has('replace_file_content')).toBe(true);
      expect(WRITE_TOOLS.has('multi_replace_file_content')).toBe(true);
    });

    it('normalizes TargetFile from Antigravity tool payloads', () => {
      const event = normalizeLifecycleEvent(
        {
          hook_event_name: 'PreToolUse',
          project_dir: '/tmp/ape-gemini-project',
          tool_name: 'replace_file_content',
          tool_input: {
            TargetFile: '/tmp/ape-gemini-project/src/index.js',
            ReplacementContent: 'const x = 1;',
          },
        },
        { APE_HOST: 'gemini' },
      );
      expect(event.host).toBe('gemini');
      expect(event.tool_name).toBe('replace_file_content');
      expect(event.file).toBe('src/index.js');
    });

    it('normalizes CommandLine from Antigravity run_command payloads', () => {
      const event = normalizeLifecycleEvent(
        {
          hook_event_name: 'PreToolUse',
          project_dir: '/tmp/ape-gemini-project',
          tool_name: 'run_command',
          tool_input: {
            CommandLine: 'npm test',
          },
        },
        { APE_HOST: 'gemini' },
      );
      expect(event.host).toBe('gemini');
      expect(event.command).toBe('npm test');
    });

    it('denies unbound subagent write_to_file calls under running state', () => {
      const event = normalizeLifecycleEvent(
        {
          hook_event_name: 'PreToolUse',
          project_dir: '/tmp/ape-gemini-project',
          tool_name: 'write_to_file',
          tool_input: { TargetFile: '/tmp/ape-gemini-project/src/index.js' },
          agent_id: 'subagent-1',
        },
        { APE_HOST: 'gemini' },
      );
      const decision = evaluateLifecyclePolicy(event, {
        state: { status: 'running' },
        ticket: null,
      });
      expect(decision.decision).toBe('deny');
    });
  });
});
