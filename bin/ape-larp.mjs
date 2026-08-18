#!/usr/bin/env node
// LARP MODE — the advisory notification-sound hook. Plays a platform-native
// .wav on a session lifecycle event so a watching human gets an audible cue.
//
// This entry is the fail-OPEN twin of `bin/ape-hook.mjs` (which fails CLOSED
// because it enforces policy). LARP enforces nothing: the entire body swallows
// every error, emits no decision, and always exits 0, so a broken audio path,
// config file, or payload can never wedge a session. Keep the two entries
// separate — merging LARP into the policy hook would force one entry to pick
// a single failure posture.
//
// Decision logic lives in lib/runtime/larp.js; this file is only I/O: read
// the payload, load the config fail-open, resolve the asset, spawn the player
// detached + unref'd so the hook returns inside its latency budget.

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  deriveLarpEvent,
  loadPackageSoundManifest,
  resolveLarpDecision,
  resolvePlayerCommand,
} from '../lib/runtime/larp.js';
import { loadRuntimeConfig } from '../lib/runtime/config.js';
import { resolveGovernedRoot, runtimePaths } from '../lib/runtime/paths.js';
import { normalizeGeminiHookInput } from '../lib/runtime/gemini-host.js';

// Works from both homes of this module: bin/ (dev source) and dist/ (bundle).
const PLUGIN_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PACKAGE_SOUNDS = loadPackageSoundManifest(
  join(PLUGIN_ROOT, 'assets', 'sounds', 'manifest.json'),
);
// PLUGIN_ROOT is Codex's host-specific plugin-root extension. Codex Stop and
// SubagentStop command hooks require valid JSON on stdout even for a neutral
// advisory result, while Claude's supplemental async hooks must stay silent.
const CODEX_HOOK = typeof process.env.PLUGIN_ROOT === 'string'
  && process.env.PLUGIN_ROOT.length > 0;
const JSON_HOOK = CODEX_HOOK || process.env.APE_HOST === 'gemini';

try {
  // Accumulate raw stdin Buffers and decode EXACTLY ONCE (Buffer.concat then a
  // single toString('utf8')): `body += chunk` re-decodes each Buffer on its own
  // and mangles a multibyte UTF-8 codepoint split across a pipe-read boundary
  // into U+FFFD (audit finding 1.8). The cap stays on BYTE length; the fail-OPEN
  // oversize path is unchanged — break out to silence, never throw a decision.
  const chunks = [];
  let bodyBytes = 0;
  for await (const chunk of process.stdin) {
    bodyBytes += Buffer.byteLength(chunk);
    if (bodyBytes > 256 * 1024) break; // oversized payload -> silence, not failure
    chunks.push(chunk);
  }
  const body = Buffer.concat(chunks).toString('utf8');
  const input = bodyBytes <= 256 * 1024 && body.trim() ? JSON.parse(body) : {};
  const cliEvent = process.argv.slice(2).find((arg) => !arg.startsWith('-'));
  if (cliEvent && !input.hook_event_name) {
    input.hook_event_name = cliEvent;
  }
  if (!input.hook_event_name && process.env.APE_HOOK_EVENT) {
    input.hook_event_name = process.env.APE_HOOK_EVENT;
  }
  if (input.toolCall && typeof input.toolCall === 'object') {
    input.tool_name ??= input.toolCall.name;
    input.tool_input ??= input.toolCall.args;
  }
  const isGeminiHost =
    process.env.APE_HOST === 'gemini' ||
    Boolean(cliEvent) ||
    input.toolCall !== undefined ||
    input.conversationId !== undefined ||
    input.stepIdx !== undefined ||
    input.artifactDirectoryPath !== undefined ||
    input.transcriptPath !== undefined ||
    input.workspacePaths !== undefined ||
    input.invocationNum !== undefined;
  if (isGeminiHost) {
    const activeHookEvent = cliEvent || process.env.APE_HOOK_EVENT || input.hook_event_name;
    const normalized = await normalizeGeminiHookInput(input, {
      ...process.env,
      APE_HOST: 'gemini',
      APE_HOOK_EVENT: activeHookEvent,
    });
    Object.assign(input, normalized);
    if (activeHookEvent === 'SessionStart' && input.invocationNum !== 0) {
      input.hook_event_name = 'unknown';
    }
    if (
      normalized.gemini_dispatch_nonce
      || input.is_subagent
      || input.isSubagent
      || input.subagent_id
      || input.subagentId
      || (typeof input.agent_id === 'string' && input.agent_id.length > 0)
      || (typeof input.agentId === 'string' && input.agentId.length > 0)
    ) {
      input.is_subagent = true;
      if (activeHookEvent === 'Stop') input.hook_event_name = 'SubagentStop';
      if (activeHookEvent === 'SessionStart') input.hook_event_name = 'unknown';
    }
  }

  const event = deriveLarpEvent(input);
  if (event) {
    let config = {};
    try {
      const projectDir = resolveGovernedRoot({
        explicitDir: input.project_dir,
        cwd: input.cwd,
      });
      config = await loadRuntimeConfig(runtimePaths(projectDir).config);
    } catch {
      // unreadable/hostile config -> env-only decision over shipped defaults
    }
    const decision = resolveLarpDecision({
      event,
      config,
      env: process.env,
      packageSounds: PACKAGE_SOUNDS,
    });
    if (decision.play) {
      const file = isAbsolute(decision.file)
        ? decision.file
        : join(PLUGIN_ROOT, decision.file);
      const player = existsSync(file) ? resolvePlayerCommand(process.platform, file) : null;
      if (player) {
        const child = spawn(player.command, player.args, {
          detached: true,
          stdio: 'ignore',
        });
        child.on('error', () => {});
        child.unref();
      }
    }
  }
} catch (cause) {
  process.stderr.write(`ape-larp: ${cause?.message ?? String(cause)}\n`);
}
if (JSON_HOOK) process.stdout.write('{}\n');
process.exit(0);
