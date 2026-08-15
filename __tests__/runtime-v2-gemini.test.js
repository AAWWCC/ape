import { describe, expect, it } from 'vitest';
import { DEFAULT_MODELS } from '../lib/runtime/constants.js';
import { runtimeHost, resolveGovernedRoot } from '../lib/runtime/paths.js';
import { nativeDispatch } from '../lib/runtime/adapters.js';
import { statuslineState, wireStatusline, unwireStatusline } from '../lib/runtime/statusline.js';
import {
  SAFE_SUBAGENT_TOOLS,
  isAgentDispatchTool,
  normalizeLifecycleEvent,
  evaluateLifecyclePolicy,
} from '../lib/runtime/hooks.js';
import { WRITE_TOOLS } from '../lib/runtime/write-policy.js';

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
