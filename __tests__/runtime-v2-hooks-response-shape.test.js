import { describe, expect, it } from 'vitest';
import { formatHookResponse } from '../lib/runtime/hooks.js';

// Regression guard for F5: Claude honors `permissionDecision` only on
// PreToolUse. Post-event denials (PostToolUse, PostToolUseFailure,
// SubagentStop) must use the top-level `{decision: "block", reason}` shape or
// the host silently ignores them — every tree-reconciliation denial computed
// on those events was being dropped.
describe('APE v2 host-compatible hook response shapes', () => {
  const claudeEvent = (event) => ({ host: 'claude', event });

  it('keeps the permissionDecision shape on PreToolUse', () => {
    const deny = formatHookResponse(claudeEvent('PreToolUse'), {
      decision: 'deny',
      reason: 'nope',
    });
    expect(deny).toEqual({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: 'nope',
      },
    });

    const allow = formatHookResponse(claudeEvent('PreToolUse'), {
      decision: 'allow',
      reason: 'fine',
    });
    expect(allow.hookSpecificOutput.permissionDecision).toBe('allow');
  });

  it.each(['PostToolUse', 'PostToolUseFailure', 'SubagentStop'])(
    'blocks %s via the top-level decision shape Claude honors',
    (event) => {
      const denied = formatHookResponse(claudeEvent(event), {
        decision: 'deny',
        reason: 'APE result denied: tree change has no exact active ticket attribution',
      });
      expect(denied).toEqual({
        decision: 'block',
        reason: 'APE result denied: tree change has no exact active ticket attribution',
      });
      expect(denied.hookSpecificOutput).toBeUndefined();
    },
  );

  it.each(['PostToolUse', 'PostToolUseFailure', 'SubagentStop'])(
    'emits no decision at all when %s is allowed so the host proceeds unchanged',
    (event) => {
      const allowed = formatHookResponse(claudeEvent(event), {
        decision: 'allow',
        reason: 'tree unchanged',
      });
      expect(allowed).toEqual({});
    },
  );

  it('keeps the SubagentStart additional-context branch', () => {
    const response = formatHookResponse(claudeEvent('SubagentStart'), {
      decision: 'allow',
      reason: 'bound',
      additional_context: 'APE_RECEIPT_CAPABILITY=abc',
    });
    expect(response).toEqual({
      hookSpecificOutput: {
        hookEventName: 'SubagentStart',
        additionalContext: 'APE_RECEIPT_CAPABILITY=abc',
      },
    });
  });

  it('blocks a denied Claude SubagentStart binding', () => {
    const response = formatHookResponse(claudeEvent('SubagentStart'), {
      decision: 'deny',
      reason: 'no prepared intent',
    });
    expect(response).toEqual({ decision: 'block', reason: 'no prepared intent' });
  });

  it('surfaces a denied Codex SubagentStart binding as a system warning', () => {
    const response = formatHookResponse({ host: 'codex', event: 'SubagentStart' }, {
      decision: 'deny',
      reason: 'no prepared intent',
    });
    expect(response).toEqual({ systemMessage: 'no prepared intent' });
  });

  it('uses the current Codex-compatible PreToolUse and post-event shapes', () => {
    expect(formatHookResponse({ host: 'codex', event: 'PostToolUse' }, {
      decision: 'deny',
      reason: 'nope',
    })).toEqual({ decision: 'block', reason: 'nope' });
    expect(formatHookResponse({ host: 'codex', event: 'PreToolUse' }, {
      decision: 'allow',
      reason: 'fine',
    })).toEqual({});
  });

  it('delivers trusted bootstrap context without changing Codex permission decisions', () => {
    const event = { host: 'codex', event: 'PreToolUse' };
    const response = formatHookResponse(event, {
      decision: 'allow',
      additional_context: 'Authoritative native bootstrap context',
    });
    expect(response).toEqual({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        additionalContext: 'Authoritative native bootstrap context',
      },
    });
    expect(formatHookResponse(event, {
      decision: 'deny', reason: 'bootstrap rejected', additional_context: 'must not leak',
    }).hookSpecificOutput.additionalContext).toBeUndefined();
  });
});
