// __tests__/runtime-v2-empirical-challenger-m2-it2-2.test.js
import { afterEach, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { access, mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { gitFixtureEnv } from '../test-support/git-fixtures.js';
import { runtimePaths } from '../lib/runtime/paths.js';
import { atomicWriteJson, readJson } from '../lib/runtime/storage.js';
import { sha256 } from '../lib/runtime/canonical.js';
import {
  recordReceipt,
  resumeRun,
  startRun,
  validateReceiptForDispatch,
} from '../lib/runtime/service.js';
import {
  stagedReceiptPath,
  stageReceiptDraft,
} from '../lib/runtime/receipt-service.js';
import { invokeCodexHook } from './codex-native-test-helper.js';

const repoRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const cleanups = [];

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(cleanups.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

function git(cwd, ...args) {
  return execFileSync('git', args, { env: gitFixtureEnv(), cwd, encoding: 'utf8' }).trim();
}

async function fixture(overrides = {}) {
  const dir = await mkdtemp(path.join(tmpdir(), 'ape-challenger-m2-it2-2-'));
  cleanups.push(dir);

  git(dir, 'init', '-q', '-b', 'main');
  git(dir, 'config', 'user.email', 'ape-challenger-it2@example.invalid');
  git(dir, 'config', 'user.name', 'APE Challenger It2');
  git(dir, 'config', 'core.autocrlf', 'false');

  await writeFile(path.join(dir, '.gitignore'), '.ape/\n.env\n');
  await writeFile(path.join(dir, 'README.md'), '# Base documentation\n');
  git(dir, 'add', '.');
  git(dir, 'commit', '-qm', 'baseline');

  const paths = runtimePaths(dir);
  await atomicWriteJson(paths.config, {
    shipping: { auto_merge: false, required_remote_checks: false },
    test_commands: { full: 'node -e "process.exit(0)"', targeted_template: 'node -e "process.exit(0)"' },
    ...overrides.config,
  });

  return { dir, paths };
}

describe('Challenger M2 it2 2: Empirical Verification of Staged Receipt Purge & Replay Immunity', () => {
  it('E1: permanently purges unadopted staged receipts for ALL tickets in a multi-ticket blocked run during single-step resume', async () => {
    const { dir, paths } = await fixture();

    const startInput = {
      objective: 'Multi-ticket feature',
      mode: 'phase',
      lane: 'mechanical',
      host: 'claude',
      behavioral: false,
      claimed_paths: ['README.md', 'docs/api.md'],
      test_paths: [],
      requirements: [],
      risk_triggers: [],
      hooks_trusted: true,
      subagents_available: true,
      explicit_invocation: true,
    };

    const started = await startRun(dir, startInput);
    expect(started.ok).toBe(true);

    const state = await readJson(paths.active);
    const ticket1 = state.tickets[0];
    expect(ticket1).toBeDefined();

    // Add a second ticket to the active run
    const ticket2 = {
      ...ticket1,
      ticket_id: `${state.run_id}:${state.stage}:ticket-2`,
      claimed_paths: ['docs/api.md'],
    };
    state.tickets.push(ticket2);
    await atomicWriteJson(paths.active, state);

    // Stage receipts for BOTH tickets
    const stagedFile1 = stagedReceiptPath(paths, ticket1.ticket_id);
    const stagedFile2 = stagedReceiptPath(paths, ticket2.ticket_id);

    await stageReceiptDraft(paths, ticket1, {
      ticket_id: ticket1.ticket_id,
      status: 'passed',
      receipt_capability: 'bearer-token-1',
      summary: 'Staged draft 1',
    });
    await stageReceiptDraft(paths, ticket2, {
      ticket_id: ticket2.ticket_id,
      status: 'passed',
      receipt_capability: 'bearer-token-2',
      summary: 'Staged draft 2',
    });

    expect(await readJson(stagedFile1, null)).toBeTruthy();
    expect(await readJson(stagedFile2, null)).toBeTruthy();

    // Mark run blocked
    state.status = 'blocked';
    state.stage = 'build';
    state.block_reason = 'Worker hit unexpected failure in multi-ticket build';
    await atomicWriteJson(paths.active, state);
    await atomicWriteJson(path.join(paths.runs, `${state.run_id}.json`), state);

    // Modify a file so work checkpoint is captured
    await mkdir(path.join(dir, 'docs'), { recursive: true });
    await writeFile(path.join(dir, 'docs/api.md'), '# API Docs\n');

    // Execute single-step resume
    const resumed = await resumeRun(dir, { explicit_invocation: true });
    expect(resumed.ok).toBe(true);
    expect(resumed.run.run_id).not.toBe(state.run_id);

    // Invariant 1: Both staging files must be completely wiped from disk
    await expect(access(stagedFile1)).rejects.toThrow();
    await expect(access(stagedFile2)).rejects.toThrow();

    // Invariant 2: Staging directory must contain 0 leftover staging files for the old tickets
    const stagingDir = paths.receiptsStaging ?? path.join(paths.receipts, 'staging');
    let stagedEntries = [];
    try {
      stagedEntries = await readdir(stagingDir);
    } catch {
      stagedEntries = [];
    }
    expect(stagedEntries.filter((f) => f.endsWith('.json'))).toEqual([]);
  });

  it('E2: ensures new replacement run starts without staging leakage and strictly denies prose completion when no new draft is staged', async () => {
    const { dir, paths } = await fixture();

    const started = await startRun(dir, {
      objective: 'Feature with single-step resume replay check',
      mode: 'phase',
      lane: 'mechanical',
      host: 'codex',
      behavioral: false,
      claimed_paths: ['README.md', 'docs/feature.md'],
      test_paths: [],
      requirements: [],
      risk_triggers: [],
      hooks_trusted: true,
      subagents_available: true,
      explicit_invocation: true,
    });
    expect(started.ok).toBe(true);

    const oldState = await readJson(paths.active);
    const oldTicket = oldState.tickets[0];
    const oldCap = 'old-secret-capability-xyz';

    // Stage draft for old ticket
    await stageReceiptDraft(paths, oldTicket, {
      ticket_id: oldTicket.ticket_id,
      status: 'passed',
      receipt_capability: oldCap,
      summary: 'Old staged draft before block',
    });

    // Block run
    oldState.status = 'blocked';
    oldState.stage = 'build';
    oldState.block_reason = 'Flaky environment failure';
    await atomicWriteJson(paths.active, oldState);
    await atomicWriteJson(path.join(paths.runs, `${oldState.run_id}.json`), oldState);

    await mkdir(path.join(dir, 'docs'), { recursive: true });
    await writeFile(path.join(dir, 'docs/feature.md'), '# Updated docs\n');

    // Resume run
    const resumed = await resumeRun(dir, { explicit_invocation: true });
    expect(resumed.ok).toBe(true);

    const newState = await readJson(paths.active);
    const newTicket = newState.tickets[0];
    expect(newTicket.ticket_id).not.toBe(oldTicket.ticket_id);

    // Staging file for old ticket must NOT exist
    const oldStagedFile = stagedReceiptPath(paths, oldTicket.ticket_id);
    await expect(access(oldStagedFile)).rejects.toThrow();

    newTicket.receipt_contract_version = 1;
    newState.tickets[0] = newTicket;
    await atomicWriteJson(paths.active, newState);

    // Bind a dispatch intent for the replacement worker on newTicket
    const now = new Date().toISOString();
    await mkdir(paths.dispatchIntents, { recursive: true });
    const intentFile = path.join(paths.dispatchIntents, `${sha256(newTicket.ticket_id)}.json`);
    await atomicWriteJson(intentFile, {
      version: 2,
      host: 'codex',
      run_id: newState.run_id,
      ticket_id: newTicket.ticket_id,
      ticket_hash: newTicket.ticket_hash,
      agent_type: newTicket.role,
      parent_session_id: 'replacement-session-1',
      tool_use_id: 'spawn-worker-1',
      requested_model: newTicket.model?.model ?? 'gpt-5.4',
      binding_agent_type: 'default',
      bound_session_id: 'replacement-session-1',
      launch_name_hash: sha256('replacement-launch'),
      status: 'bound',
      bound_agent_id: 'replacement-agent-1',
      capability_hash: sha256('new-run-capability-abc'),
      prepared_at: now,
      launched_at: now,
      launch_expires_at: new Date(Date.now() + 60_000).toISOString(),
      bound_at: now,
      expires_at: new Date(Date.now() + 300_000).toISOString(),
      launch_attempts: 1,
      physical_worker_dispatches: 1,
      receipt_limits: {
        max_physical_workers_per_ticket: 2,
        max_validation_submissions_per_worker: 3,
      },
    });

    // Now test worker in replacement run:
    // If worker produces prose without staging a draft for the NEW ticket,
    // SubagentStop MUST deny termination (decision: 'block') and NOT leak/adopt any old draft.
    const hookResult = await invokeCodexHook(repoRoot, {
      hook_event_name: 'SubagentStop',
      project_dir: dir,
      session_id: 'replacement-session-1',
      agent_id: 'replacement-agent-1',
      turn_id: 'turn-1',
      agent_type: 'default',
      is_subagent: true,
      last_assistant_message: 'I have finished all tasks. Here is my final summary without raw JSON.',
    });

    expect(hookResult.decision).toBe('block');
    expect(hookResult.reason).toMatch(/no valid receipt draft has been staged|missing evidence|receipt|evidence/i);

    // Direct recordReceipt call without draft also rejects
    const recordResult = await recordReceipt(paths.root, {
      ticket_id: newTicket.ticket_id,
      summary: 'Conversational prose only',
    });
    expect(recordResult.ok).toBe(false);
  });

  it('E3: strictly denies replay of superseded ticket ID or capability against the new active run', async () => {
    const { dir, paths } = await fixture();

    const started = await startRun(dir, {
      objective: 'Testing anti-replay across resume',
      mode: 'phase',
      lane: 'mechanical',
      host: 'claude',
      behavioral: false,
      claimed_paths: ['README.md', 'docs/feature.md'],
      test_paths: [],
      requirements: [],
      risk_triggers: [],
      hooks_trusted: true,
      subagents_available: true,
      explicit_invocation: true,
    });
    expect(started.ok).toBe(true);

    const oldState = await readJson(paths.active);
    const oldTicket = oldState.tickets[0];
    const oldCap = 'old-cap-to-replay-999';

    await stageReceiptDraft(paths, oldTicket, {
      ticket_id: oldTicket.ticket_id,
      status: 'passed',
      receipt_capability: oldCap,
      summary: 'Old draft',
    });

    oldState.status = 'blocked';
    oldState.stage = 'build';
    oldState.block_reason = 'Intentional block for replay test';
    await atomicWriteJson(paths.active, oldState);
    await atomicWriteJson(path.join(paths.runs, `${oldState.run_id}.json`), oldState);

    await mkdir(path.join(dir, 'docs'), { recursive: true });
    await writeFile(path.join(dir, 'docs/feature.md'), '# Replay test\n');

    const resumed = await resumeRun(dir, { explicit_invocation: true });
    expect(resumed.ok).toBe(true);

    // Attempting to record receipt using the OLD superseded ticket_id
    const replayAttempt = await recordReceipt(paths.root, {
      ticket_id: oldTicket.ticket_id,
      status: 'passed',
      receipt_capability: oldCap,
      summary: 'Adversarial replay of old ticket',
    });

    expect(replayAttempt.ok).toBe(false);
    expect(replayAttempt.errors.some((e) => e.includes('does not match active run') || e.includes('inactive') || e.includes('ticket'))).toBe(true);
  });

  it('E4: cleanly cascades through sequential multi-generation self-healing resumes without staged receipt residue', async () => {
    const { dir, paths } = await fixture();

    // Gen 1
    const run1 = await startRun(dir, {
      objective: 'Gen 1 run',
      mode: 'phase',
      lane: 'mechanical',
      host: 'codex',
      behavioral: false,
      claimed_paths: ['README.md', 'docs/feature.md'],
      test_paths: [],
      requirements: [],
      risk_triggers: [],
      hooks_trusted: true,
      subagents_available: true,
      explicit_invocation: true,
    });
    expect(run1.ok).toBe(true);

    const state1 = await readJson(paths.active);
    const ticket1 = state1.tickets[0];
    const stagedFile1 = stagedReceiptPath(paths, ticket1.ticket_id);

    await stageReceiptDraft(paths, ticket1, {
      ticket_id: ticket1.ticket_id,
      status: 'passed',
      receipt_capability: 'cap-gen-1',
      summary: 'Gen 1 draft',
    });
    expect(await readJson(stagedFile1, null)).toBeTruthy();

    state1.status = 'blocked';
    state1.stage = 'build';
    state1.block_reason = 'Gen 1 blocked';
    await atomicWriteJson(paths.active, state1);
    await atomicWriteJson(path.join(paths.runs, `${state1.run_id}.json`), state1);

    await mkdir(path.join(dir, 'docs'), { recursive: true });
    await writeFile(path.join(dir, 'docs/feature.md'), '# Gen 1 edit\n');

    // Resume -> Gen 2
    const resume1 = await resumeRun(dir, { explicit_invocation: true });
    expect(resume1.ok).toBe(true);
    await expect(access(stagedFile1)).rejects.toThrow();

    const state2 = await readJson(paths.active);
    const ticket2 = state2.tickets[0];
    const stagedFile2 = stagedReceiptPath(paths, ticket2.ticket_id);

    // Gen 2 stages a draft
    await stageReceiptDraft(paths, ticket2, {
      ticket_id: ticket2.ticket_id,
      status: 'passed',
      receipt_capability: 'cap-gen-2',
      summary: 'Gen 2 draft',
    });
    expect(await readJson(stagedFile2, null)).toBeTruthy();

    // Gen 2 blocks
    state2.status = 'blocked';
    state2.stage = 'build';
    state2.block_reason = 'Gen 2 blocked';
    await atomicWriteJson(paths.active, state2);
    await atomicWriteJson(path.join(paths.runs, `${state2.run_id}.json`), state2);

    await writeFile(path.join(dir, 'docs/feature.md'), '# Gen 2 edit\n');

    // Resume -> Gen 3
    const resume2 = await resumeRun(dir, { explicit_invocation: true });
    expect(resume2.ok).toBe(true);

    // Both Gen 1 and Gen 2 staged drafts must be purged
    await expect(access(stagedFile1)).rejects.toThrow();
    await expect(access(stagedFile2)).rejects.toThrow();

    const state3 = await readJson(paths.active);
    const ticket3 = state3.tickets[0];
    expect(ticket3.ticket_id).not.toBe(ticket1.ticket_id);
    expect(ticket3.ticket_id).not.toBe(ticket2.ticket_id);

    // Staging directory must have 0 json files
    const stagingDir = paths.receiptsStaging ?? path.join(paths.receipts, 'staging');
    let stagedEntries = [];
    try {
      stagedEntries = await readdir(stagingDir);
    } catch {
      stagedEntries = [];
    }
    expect(stagedEntries.filter((f) => f.endsWith('.json'))).toEqual([]);
  });
});
