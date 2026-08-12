import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  LARP_EVENTS,
  classifyApeRunOutcome,
  deriveLarpEvent,
  loadPackageSoundManifest,
  parseToggle,
  parsePackageSoundManifest,
  resolveLarpDecision,
  resolvePlayerCommand,
} from '../lib/runtime/larp.js';
import { projectRunResponse } from '../lib/runtime/projection.js';

const REPO_ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const HOOK_BIN = path.join(REPO_ROOT, 'bin', 'ape-larp.mjs');
const run = promisify(execFile);

const mcpText = (value) => ({ content: [{ type: 'text', text: JSON.stringify(value) }] });

describe('larp toggle parsing', () => {
  it('parses explicit truthy and falsy scalars and falls through otherwise', () => {
    expect(parseToggle('1')).toBe(true);
    expect(parseToggle('on')).toBe(true);
    expect(parseToggle(true)).toBe(true);
    expect(parseToggle('0')).toBe(false);
    expect(parseToggle('FALSE')).toBe(false);
    expect(parseToggle('off')).toBe(false);
    expect(parseToggle('')).toBe(false);
    expect(parseToggle(undefined)).toBeNull();
    expect(parseToggle(null)).toBeNull();
    expect(parseToggle({ nested: true })).toBeNull();
  });
});

describe('package-local sound manifest', () => {
  it('accepts only the closed version-1 event schema', () => {
    expect(parsePackageSoundManifest({ version: 1, files: { stop: 'Stop.wav' } })).toEqual({
      stop: 'Stop.wav',
    });
    expect(parsePackageSoundManifest({ version: 2, files: {} })).toBeNull();
    expect(parsePackageSoundManifest({ version: 1, files: {}, extra: true })).toBeNull();
    expect(parsePackageSoundManifest({ version: 1, files: { workflow: 'x.wav' } })).toBeNull();
    expect(parsePackageSoundManifest({ version: 1, files: { stop: '' } })).toBeNull();
  });

  it('resolves only existing files contained by the manifest directory', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'ape-sound-manifest-'));
    try {
      const soundDir = path.join(root, 'assets', 'sounds');
      await mkdir(soundDir, { recursive: true });
      const inside = path.join(soundDir, 'inside.sound');
      const outside = path.join(root, 'outside.sound');
      await writeFile(inside, 'inside');
      await writeFile(outside, 'outside');
      const manifest = path.join(soundDir, 'manifest.json');
      await writeFile(
        manifest,
        JSON.stringify({
          version: 1,
          files: {
            stop: 'inside.sound',
            ask: '../outside.sound',
            boot: 'missing.sound',
          },
        }),
      );
      expect(loadPackageSoundManifest(manifest)).toEqual({ STOP: await realpath(inside) });
      expect(loadPackageSoundManifest(path.join(soundDir, 'absent.json'))).toEqual({});
      await writeFile(manifest, '{broken');
      expect(loadPackageSoundManifest(manifest)).toEqual({});
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe('larp host-event derivation', () => {
  it('maps ambient lifecycle events to their cue', () => {
    expect(deriveLarpEvent({ hook_event_name: 'SessionStart' })).toBe('BOOT');
    expect(deriveLarpEvent({ hook_event_name: 'Stop' })).toBe('STOP');
    expect(deriveLarpEvent({ hook_event_name: 'SubagentStop' })).toBe('SUBAGENT');
    expect(deriveLarpEvent({ hook_event_name: 'PostToolUseFailure' })).toBe('ERROR');
  });

  it('maps PreToolUse to ASK for each host question tool', () => {
    expect(
      deriveLarpEvent({ hook_event_name: 'PreToolUse', tool_name: 'AskUserQuestion' }),
    ).toBe('ASK');
    expect(
      deriveLarpEvent({ hook_event_name: 'PreToolUse', tool_name: 'request_user_input' }),
    ).toBe('ASK');
    expect(deriveLarpEvent({ hook_event_name: 'PreToolUse', tool_name: 'Bash' })).toBeNull();
  });

  it('is silent for unknown events and malformed payloads', () => {
    expect(deriveLarpEvent({ hook_event_name: 'UserPromptSubmit' })).toBeNull();
    expect(deriveLarpEvent({})).toBeNull();
    expect(deriveLarpEvent(null)).toBeNull();
  });

  it('routes PostToolUse of ape_run through outcome classification', () => {
    expect(
      deriveLarpEvent({
        hook_event_name: 'PostToolUse',
        tool_name: 'mcp__plugin_ape_ape__ape_run',
        tool_input: { action: 'next' },
        tool_response: mcpText({ ok: true, run: { status: 'completed' } }),
      }),
    ).toBe('SHIP');
    expect(
      deriveLarpEvent({
        hook_event_name: 'PostToolUse',
        tool_name: 'Bash',
        tool_input: { action: 'next' },
        tool_response: mcpText({ ok: true, run: { status: 'completed' } }),
      }),
    ).toBeNull();
  });
});

describe('larp subagent-context suppression', () => {
  it('suppresses the main-session lifecycle cues when a subagent agent_id is present', () => {
    expect(
      deriveLarpEvent({ hook_event_name: 'SessionStart', agent_id: 'agent-123' }),
    ).toBeNull();
    expect(deriveLarpEvent({ hook_event_name: 'Stop', agent_id: 'agent-123' })).toBeNull();
    expect(
      deriveLarpEvent({ hook_event_name: 'PostToolUseFailure', agent_id: 'agent-123' }),
    ).toBeNull();
  });

  it('normalizes the identity field: camelCase agentId is subagent context', () => {
    expect(deriveLarpEvent({ hook_event_name: 'SessionStart', agentId: 'x' })).toBeNull();
  });

  it('treats a bare agent_type as a fallback subagent-context signal', () => {
    expect(
      deriveLarpEvent({ hook_event_name: 'SessionStart', agent_type: 'ape:reviewer' }),
    ).toBeNull();
  });

  it('leaves main-session lifecycle cues unchanged when no agent identity is present', () => {
    expect(deriveLarpEvent({ hook_event_name: 'SessionStart' })).toBe('BOOT');
    expect(deriveLarpEvent({ hook_event_name: 'Stop' })).toBe('STOP');
    expect(deriveLarpEvent({ hook_event_name: 'PostToolUseFailure' })).toBe('ERROR');
    expect(deriveLarpEvent({ hook_event_name: 'SessionStart', agent_id: '' })).toBe('BOOT');
  });

  it('never swallows the dedicated SubagentStop channel', () => {
    expect(deriveLarpEvent({ hook_event_name: 'SubagentStop', agent_id: 'agent-123' })).toBe(
      'SUBAGENT',
    );
  });

  it('leaves the AskUserQuestion ASK cue intact even in subagent context', () => {
    expect(
      deriveLarpEvent({
        hook_event_name: 'PreToolUse',
        tool_name: 'AskUserQuestion',
        agent_id: 'agent-123',
      }),
    ).toBe('ASK');
  });
});

describe('larp outcome gating (fail-safe)', () => {
  it('plays SHIP only on a positively parsed completed run', () => {
    expect(
      classifyApeRunOutcome({ action: 'record' }, mcpText({ ok: true, run: { status: 'completed' } })),
    ).toBe('SHIP');
    expect(
      classifyApeRunOutcome({ action: 'record' }, mcpText({ ok: true, run: { status: 'running' } })),
    ).toBeNull();
  });

  it('plays ERROR on a blocked run, a red merge gate, or a failed plan/reviewer/implementer receipt', () => {
    expect(
      classifyApeRunOutcome({ action: 'next' }, mcpText({ ok: true, run: { status: 'blocked' } })),
    ).toBe('ERROR');
    expect(
      classifyApeRunOutcome({ action: 'next' }, mcpText({
        ok: true, run: { status: 'running' }, actions: [{ type: 'gates', result: { passed: false } }],
      })),
    ).toBe('ERROR');
    // A rejected plan, a blocking reviewer/security-reviewer, and an implementer
    // that could not make the authored test pass (the green phase failing).
    for (const role of ['plan_judge', 'reviewer', 'security_reviewer', 'implementer']) {
      expect(
        classifyApeRunOutcome({ action: 'record' }, mcpText({
          ok: true, run: { status: 'running' }, receipt: { status: 'failed', role },
        })),
        `a failed ${role} receipt must play ERROR`,
      ).toBe('ERROR');
    }
  });

  it('does NOT play ERROR for the test_writer red phase (a red test is the expected outcome)', () => {
    // A valid red phase is a PASSED test_writer receipt — the happy path, no cue.
    expect(
      classifyApeRunOutcome({ action: 'record' }, mcpText({
        ok: true, run: { status: 'running' }, receipt: { status: 'passed', role: 'test_writer' },
      })),
    ).toBeNull();
    // Even a FAILED test_writer receipt is not announced as an error (excluded).
    expect(
      classifyApeRunOutcome({ action: 'record' }, mcpText({
        ok: true, run: { status: 'running' }, receipt: { status: 'failed', role: 'test_writer' },
      })),
    ).toBeNull();
  });

  it('plays BUILD when the implementer receipt passes; a bare gates pass is silent', () => {
    expect(
      classifyApeRunOutcome({ action: 'record' }, mcpText({
        ok: true, run: { status: 'running' }, receipt: { status: 'passed', role: 'implementer' },
      })),
    ).toBe('BUILD');
    // Gates passing is an intermediate step toward SHIP, no longer the build cue.
    expect(
      classifyApeRunOutcome({ action: 'next' }, mcpText({
        ok: true, run: { status: 'shipping' }, actions: [{ type: 'gates', result: { passed: true } }],
      })),
    ).toBeNull();
  });

  it('precedence: a chained-through completed response plays SHIP only, never SHIP+BUILD', () => {
    // CI off — gates + merge resolve in one call: status completed WITH a passed
    // gates action. SHIP wins the ladder; BUILD never also fires.
    expect(
      classifyApeRunOutcome({ action: 'record' }, mcpText({
        ok: true, run: { status: 'completed' }, actions: [{ type: 'gates', result: { passed: true } }],
      })),
    ).toBe('SHIP');
  });

  it('plays PLAN when a passed planning receipt hands off to a writing role', () => {
    const response = mcpText({
      ok: true,
      receipt: { status: 'passed', role: 'plan_judge' },
      run: { status: 'running' },
      actions: [{ type: 'dispatch_agent', ticket: { role: 'test_writer' } }],
    });
    expect(classifyApeRunOutcome({ action: 'record' }, response)).toBe('PLAN');
    const stillPlanning = mcpText({
      ok: true,
      receipt: { status: 'passed', role: 'planner' },
      run: { status: 'running' },
      actions: [{ type: 'dispatch_agent', ticket: { role: 'plan_checker' } }],
    });
    expect(classifyApeRunOutcome({ action: 'record' }, stillPlanning)).toBeNull();
    // A FAILED planning receipt is a rejected plan: ERROR wins over PLAN (which
    // requires a PASSED planning receipt), so it never mis-fires the plan cue.
    const failedReceipt = mcpText({
      ok: true,
      receipt: { status: 'failed', role: 'plan_judge' },
      run: { status: 'running' },
      actions: [{ type: 'dispatch_agent', ticket: { role: 'implementer' } }],
    });
    expect(classifyApeRunOutcome({ action: 'record' }, failedReceipt)).toBe('ERROR');
  });

  it('plays PLAN through the WIRE projection, not only on a raw receipt (review Finding E)', () => {
    // In production the LARP PostToolUse hook receives the PROJECTED ape_run
    // response (bin/ape-larp.mjs -> projectRunResponse), never the raw
    // recordReceipt result. A canonical receipt nests the acting role under
    // agent.role (schemas.js); projectRunResponse must carry that role onto the
    // wire receipt or the PLAN cue can never fire. Before the fix,
    // summarizeReceipt dropped the role and this classified as null.
    const projected = projectRunResponse({
      ok: true,
      receipt: { status: 'passed', receipt_id: 'r1', ticket_id: 't1', agent: { role: 'plan_judge' } },
      run: { status: 'running', tickets: [] },
      actions: [{ type: 'dispatch_agent', ticket: { role: 'test_writer', ticket_id: 't2' } }],
    });
    expect(classifyApeRunOutcome({ action: 'record' }, mcpText(projected))).toBe('PLAN');
  });

  it('parses the bare content-block array Claude Code hands PostToolUse for MCP tools', () => {
    // The live host payload: tool_response is the content array itself, not
    // the {content:[...]} server wrapper — [{type:'text',text:<json>}].
    const bare = (value) => [{ type: 'text', text: JSON.stringify(value) }];
    expect(
      classifyApeRunOutcome({ action: 'next' }, bare({ ok: true, run: { status: 'completed' } })),
    ).toBe('SHIP');
    expect(
      classifyApeRunOutcome({ action: 'next' }, bare({ ok: true, run: { status: 'blocked' } })),
    ).toBe('ERROR');
    expect(
      classifyApeRunOutcome(
        { action: 'record' },
        bare({
          ok: true,
          run: { status: 'running' },
          receipt: { status: 'passed', role: 'implementer' },
        }),
      ),
    ).toBe('BUILD');
    // A bare array with no parseable text entry is still silence.
    expect(classifyApeRunOutcome({ action: 'record' }, [])).toBeNull();
    expect(classifyApeRunOutcome({ action: 'record' }, [{ type: 'text', text: '{broken' }])).toBeNull();
  });

  it('reads the planning role from the canonical receipt agent.role nesting', () => {
    // Real receipts nest the acting role under agent (schemas.js); the
    // flattened top-level role accepted above is only a tolerated mirror.
    const response = mcpText({
      ok: true,
      receipt: { status: 'passed', agent: { role: 'plan_critic' } },
      run: { status: 'running' },
      actions: [{ type: 'dispatch_agent', ticket: { role: 'test_writer' } }],
    });
    expect(classifyApeRunOutcome({ action: 'record' }, response)).toBe('PLAN');
    const failed = mcpText({
      ok: true,
      receipt: { status: 'failed', agent: { role: 'plan_critic' } },
      run: { status: 'running' },
      actions: [{ type: 'dispatch_agent', ticket: { role: 'implementer' } }],
    });
    // A failed plan receipt (read from the canonical agent.role) is a rejected
    // plan — ERROR, not a mis-fired PLAN and not silence.
    expect(classifyApeRunOutcome({ action: 'record' }, failed)).toBe('ERROR');
    const nonPlanning = mcpText({
      ok: true,
      receipt: { status: 'passed', agent: { role: 'reviewer' } },
      run: { status: 'running' },
      actions: [{ type: 'dispatch_agent', ticket: { role: 'implementer' } }],
    });
    expect(classifyApeRunOutcome({ action: 'record' }, nonPlanning)).toBeNull();
  });

  it('never plays a completion cue from a read-only status poll', () => {
    expect(
      classifyApeRunOutcome({ action: 'status' }, mcpText({ ok: true, run: { status: 'completed' } })),
    ).toBeNull();
  });

  it('resolves every parse ambiguity to silence', () => {
    expect(classifyApeRunOutcome({ action: 'record' }, null)).toBeNull();
    expect(classifyApeRunOutcome({ action: 'record' }, 'not json')).toBeNull();
    expect(
      classifyApeRunOutcome({ action: 'record' }, { content: [{ type: 'text', text: '{broken' }] }),
    ).toBeNull();
    expect(classifyApeRunOutcome({}, mcpText({ ok: true, run: { status: 'completed' } }))).toBeNull();
  });

  it('accepts a direct object response and precedence picks the strongest cue', () => {
    const chained = {
      ok: true,
      run: { status: 'completed' },
      actions: [{ type: 'gates', result: { passed: true } }],
    };
    expect(classifyApeRunOutcome({ action: 'record' }, chained)).toBe('SHIP');
  });
});

describe('larp decision precedence', () => {
  const enabled = { notifications: { larp: { enabled: true } } };
  const packageSounds = Object.freeze(
    Object.fromEntries(LARP_EVENTS.map((event) => [event, `/package/${event.toLowerCase()}.sound`])),
  );

  it('is silent by default: no config, no env', () => {
    expect(resolveLarpDecision({ event: 'STOP' })).toEqual({ play: false, file: null });
  });

  it('config enables; default-on events use a validated package-manifest file', () => {
    expect(resolveLarpDecision({ event: 'STOP', config: enabled, packageSounds })).toEqual({
      play: true,
      file: packageSounds.STOP,
    });
  });

  it('is silent when enabled without an override or package-manifest file', () => {
    expect(resolveLarpDecision({ event: 'STOP', config: enabled })).toEqual({
      play: false,
      file: null,
    });
  });

  it('env LARP_MODE outranks config in both directions', () => {
    expect(
      resolveLarpDecision({ event: 'STOP', config: enabled, env: { LARP_MODE: '0' } }).play,
    ).toBe(false);
    expect(
      resolveLarpDecision({
        event: 'STOP',
        config: {},
        env: { LARP_MODE: '1', LARP_FILE_STOP: '/operator/stop.sound' },
      }).play,
    ).toBe(true);
  });

  it('SUBAGENT is default-off and needs an explicit opt-in', () => {
    expect(resolveLarpDecision({ event: 'SUBAGENT', config: enabled, packageSounds }).play).toBe(false);
    expect(
      resolveLarpDecision({
        event: 'SUBAGENT',
        config: enabled,
        env: { LARP_SUBAGENT: '1' },
        packageSounds,
      }).play,
    ).toBe(true);
    expect(
      resolveLarpDecision({
        event: 'SUBAGENT',
        config: { notifications: { larp: { enabled: true, events: { subagent: true } } } },
        packageSounds,
      }).play,
    ).toBe(true);
  });

  it('per-event mutes work from config and env, env winning', () => {
    const muted = { notifications: { larp: { enabled: true, events: { stop: false } } } };
    expect(resolveLarpDecision({ event: 'STOP', config: muted }).play).toBe(false);
    expect(
      resolveLarpDecision({
        event: 'STOP',
        config: muted,
        env: { LARP_STOP: 'on' },
        packageSounds,
      }).play,
    ).toBe(true);
  });

  it('file override precedence: env beats config beats package manifest', () => {
    const config = {
      notifications: { larp: { enabled: true, files: { stop: '/opt/sounds/config.wav' } } },
    };
    expect(resolveLarpDecision({ event: 'STOP', config }).file).toBe('/opt/sounds/config.wav');
    expect(
      resolveLarpDecision({ event: 'STOP', config, env: { LARP_FILE_STOP: '/opt/sounds/env.wav' } })
        .file,
    ).toBe('/opt/sounds/env.wav');
    expect(resolveLarpDecision({ event: 'STOP', config: enabled, packageSounds }).file).toBe(
      packageSounds.STOP,
    );
  });

  it('unknown events and hostile config shapes resolve to silence', () => {
    expect(resolveLarpDecision({ event: 'WORKFLOW', config: enabled }).play).toBe(false);
    expect(resolveLarpDecision({ event: null, config: enabled }).play).toBe(false);
    expect(
      resolveLarpDecision({ event: 'STOP', config: { notifications: { larp: [] } } }).play,
    ).toBe(false);
  });
});

describe('larp player command', () => {
  it('uses afplay on macOS and an argument-passed SoundPlayer on Windows', () => {
    expect(resolvePlayerCommand('darwin', '/x/a.wav')).toEqual({
      command: 'afplay',
      args: ['/x/a.wav'],
    });
    const win = resolvePlayerCommand('win32', 'C:\\x\\a.wav');
    expect(win.command).toBe('powershell.exe');
    expect(win.args.at(-1)).toBe('C:\\x\\a.wav');
    expect(win.args.join(' ')).not.toContain('C:\\x\\a.wav ');
  });

  it('is a silent no-op elsewhere', () => {
    expect(resolvePlayerCommand('linux', '/x/a.wav')).toBeNull();
  });
});

describe('larp hook entry (fail-open)', () => {
  let scratch;

  beforeAll(async () => {
    scratch = await mkdtemp(path.join(tmpdir(), 'ape-larp-'));
  });

  afterAll(async () => {
    if (scratch) await rm(scratch, { recursive: true, force: true });
  });

  const invoke = async (payload, env = {}) => {
    const child = run('node', [HOOK_BIN], {
      cwd: scratch,
      env: { ...process.env, LARP_MODE: '', ...env },
    });
    child.child.stdin.end(typeof payload === 'string' ? payload : JSON.stringify(payload));
    return child;
  };

  it('exits 0 and stays silent on a disabled event', async () => {
    const { stdout } = await invoke({ hook_event_name: 'Stop', cwd: scratch });
    expect(stdout).toBe('');
  });

  it('returns neutral JSON for Codex hook contracts', async () => {
    const { stdout } = await invoke(
      { hook_event_name: 'Stop', cwd: scratch },
      { PLUGIN_ROOT: REPO_ROOT },
    );
    expect(JSON.parse(stdout)).toEqual({});
  });

  it('exits 0 on malformed JSON instead of failing the session', async () => {
    const { stderr } = await invoke('{not json');
    expect(stderr).toContain('ape-larp:');
  });

  it('exits 0 when enabled but the override file is missing', async () => {
    await invoke(
      { hook_event_name: 'Stop', cwd: scratch },
      { LARP_MODE: '1', LARP_FILE_STOP: path.join(scratch, 'missing.wav') },
    );
  });

  it('exits 0 with an unreadable runtime config (fail-open to env)', async () => {
    const project = path.join(scratch, 'proj');
    const runtime = path.join(project, '.ape', 'runtime');
    await run('mkdir', ['-p', runtime]);
    await writeFile(path.join(runtime, 'config.json'), '{broken');
    await invoke(
      { hook_event_name: 'Stop', cwd: project },
      { LARP_MODE: '1', LARP_FILE_STOP: path.join(scratch, 'missing.wav') },
    );
  });
});
