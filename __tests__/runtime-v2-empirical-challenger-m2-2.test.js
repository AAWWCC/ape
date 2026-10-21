// __tests__/runtime-v2-empirical-challenger-m2-2.test.js
import { afterEach, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { access, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { gitFixtureEnv } from '../test-support/git-fixtures.js';
import { runtimePaths } from '../lib/runtime/paths.js';
import { atomicWriteJson, readJson } from '../lib/runtime/storage.js';
import { sha256 } from '../lib/runtime/canonical.js';
import { receiptOutputSchemaForTicket } from '../lib/runtime/receipt-validator.js';
import { finalizeTicket } from '../lib/runtime/schemas.js';
import { emptyOrchestrationTelemetry } from '../lib/runtime/orchestration-telemetry.js';
import {
  stagedReceiptPath,
  stageReceiptDraft,
} from '../lib/runtime/receipt-service.js';
import {
  recordReceipt,
  resumeRun,
  startRun,
  validateReceiptForDispatch,
} from '../lib/runtime/service.js';
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
  const dir = await mkdtemp(path.join(tmpdir(), 'ape-challenger-m2-2-'));
  cleanups.push(dir);

  git(dir, 'init', '-q', '-b', 'main');
  git(dir, 'config', 'user.email', 'ape-test@example.invalid');
  git(dir, 'config', 'user.name', 'APE Test');
  git(dir, 'config', 'core.autocrlf', 'false');

  await writeFile(path.join(dir, '.gitignore'), '.ape/\n.env\n');
  await mkdir(path.join(dir, 'src'), { recursive: true });
  await writeFile(path.join(dir, 'src', 'index.js'), 'export const value = 1;\n');
  git(dir, 'add', '.');
  git(dir, 'commit', '-qm', 'initial commit');

  const baseBranch = git(dir, 'branch', '--show-current');
  const runBranch = 'ape/run-challenger-m2-2';
  git(dir, 'switch', '-qc', runBranch);
  const treeSha = git(dir, 'rev-parse', 'HEAD^{tree}');
  const commitSha = git(dir, 'rev-parse', 'HEAD');

  const paths = runtimePaths(dir);
  await mkdir(paths.runtime, { recursive: true });
  await mkdir(paths.runs, { recursive: true });
  await mkdir(paths.receipts, { recursive: true });
  await mkdir(paths.dispatchIntents, { recursive: true });

  await atomicWriteJson(paths.config, {
    version: 1,
    shipping: { auto_merge: false, required_remote_checks: false },
    test_commands: { full: 'npm test', targeted_template: 'npm test -- {paths}' },
    ...overrides.config,
  });

  const runId = overrides.runId ?? 'run-challenger-1';
  const stageId = overrides.stageId ?? 'build';
  const role = overrides.role ?? 'implementer';
  const ticketId = `${runId}:${stageId}:ticket-1`;
  const capabilityWorkerA = overrides.capabilityWorkerA ?? 'worker-a-capability-token-secret-11111111';
  const capabilityWorkerB = overrides.capabilityWorkerB ?? 'worker-b-capability-token-secret-22222222';
  const sessionId = overrides.sessionId ?? 'session-1';
  const agentId = overrides.agentId ?? 'agent-1';
  const turnId = overrides.turnId ?? 'turn-1';
  const now = new Date().toISOString();
  const deadlineAt = new Date(Date.now() + 300_000).toISOString();
  const launchExpiresAt = new Date(Date.now() + 60_000).toISOString();

  const ticketBase = {
    schema_version: '2.0.0',
    ticket_id: ticketId,
    run_id: runId,
    stage_id: stageId,
    role,
    objective: 'Implement feature and return validated receipt',
    claimed_paths: ['src/index.js'],
    test_paths: [],
    risk_triggers: [],
    model_tier: 'balanced',
    model: { model: 'gpt-5.4', reasoning_effort: 'medium' },
    deadline_at: deadlineAt,
    required_checks: [],
    writable: true,
    base_tree_sha: treeSha,
    parent_hash: null,
    attempt: 1,
    issued_at: now,
    receipt_contract_version: 1,
    capability_manifest: {
      allowed_evidence_commands: ['npm test'],
      verification_profiles: [],
      preflight_hash: null,
      risk_triggers: [],
      design_assurance_required: false,
    },
  };

  const outputSchema = receiptOutputSchemaForTicket(ticketBase);
  const ticket = finalizeTicket({
    ...ticketBase,
    output_schema: outputSchema,
    capability_manifest: {
      version: 1,
      config_hash: 'c'.repeat(64),
      required_capabilities: [],
      allowed_evidence_commands: ['npm test'],
      command_profiles: [],
      verification_profiles: [],
      objective_hash: sha256(ticketBase.objective),
      preflight_hash: null,
      risk_triggers: [],
      design_assurance_required: false,
      receipt_schema: { ref: 'ticket.output_schema', hash: sha256(outputSchema) },
      field_bounds: {
        validation_attempts_per_worker: 3,
        max_physical_workers_per_ticket: 2,
        corrections_per_validation: 20,
      },
      byte_budgets: {
        candidate_plan_utf8_bytes: 16_384,
        preflight_artifact_utf8_bytes: 65_536,
        mcp_projection_utf8_bytes: 48_000,
      },
    },
  });

  const state = {
    version: 2,
    schema_version: '2.0.0',
    run_id: runId,
    status: 'running',
    stage: stageId,
    host: 'codex',
    binding_protocol: 'native-v1',
    objective: ticketBase.objective,
    mode: 'phase',
    lane: 'fast',
    claimed_paths: ['src/index.js'],
    test_paths: [],
    requirements: [],
    risk_triggers: [],
    tickets: [ticket],
    receipts: [],
    expired_tickets: [],
    active_ticket_id: ticketId,
    attempts: { [stageId]: 1 },
    remediation_cycles: 0,
    tree_sha: treeSha,
    branch: runBranch,
    base_branch: baseBranch,
    base_commit_sha: commitSha,
    checkout_cleanup: {
      status: 'pending',
      base_branch: baseBranch,
      run_branch: runBranch,
      retained: true,
      deleted: false,
      updated_at: now,
    },
    orchestration: emptyOrchestrationTelemetry(),
    created_at: now,
    updated_at: now,
  };

  await atomicWriteJson(paths.active, state);
  await atomicWriteJson(path.join(paths.runs, `${runId}.json`), state);

  // Dispatch intent initially binding Worker A
  const intentFile = path.join(paths.dispatchIntents, `${sha256(ticketId)}.json`);
  const intentWorkerA = {
    version: 2,
    host: 'codex',
    run_id: runId,
    ticket_id: ticketId,
    ticket_hash: ticket.ticket_hash,
    agent_type: role,
    parent_session_id: sessionId,
    tool_use_id: 'spawn-worker-1',
    requested_model: ticket.model.model,
    binding_agent_type: 'default',
    bound_session_id: sessionId,
    launch_name_hash: sha256('fixture-worker-launch'),
    status: 'bound',
    bound_agent_id: agentId,
    capability_hash: sha256(capabilityWorkerA),
    prepared_at: now,
    launched_at: now,
    launch_expires_at: launchExpiresAt,
    bound_at: now,
    expires_at: deadlineAt,
    launch_attempts: 1,
    physical_worker_dispatches: 1,
    receipt_limits: {
      max_physical_workers_per_ticket: 2,
      max_validation_submissions_per_worker: 3,
    },
  };

  await atomicWriteJson(intentFile, intentWorkerA);

  const stagingFile = paths.receiptsStaging
    ? path.join(paths.receiptsStaging, `${ticketId}.json`)
    : path.join(paths.receipts, 'staging', `${ticketId}.json`);

  return {
    dir,
    paths,
    state,
    ticket,
    capabilityWorkerA,
    capabilityWorkerB,
    sessionId,
    agentId,
    turnId,
    intentFile,
    stagingFile,
    intentWorkerA,
  };
}

function makeValidDraft(ticket, capability, overrides = {}) {
  return {
    ticket_id: ticket.ticket_id,
    status: 'passed',
    tests: [{ command: 'npm test', passed: true, exit_code: 0, duration_ms: 50 }],
    findings: [],
    evidence: { summary: 'Implementation verified and all unit tests pass' },
    receipt_capability: capability,
    ...overrides,
  };
}

describe('Challenger M2_2: Security and Lifecycle Stress-Testing', () => {
  describe('Dimension 1: Cross-worker spoofing and capability binding', () => {
    it('SubagentStop blocks Worker B from adopting Worker A staged receipt when capability differs', async () => {
      const fix = await fixture();
      const draftA = makeValidDraft(fix.ticket, fix.capabilityWorkerA);

      // Worker A successfully validates and stages its receipt
      const valA = await validateReceiptForDispatch(fix.dir, draftA, fix.ticket.ticket_id);
      expect(valA.valid).toBe(true);

      // Verify staged file was created with Worker A's capability
      const staged = await readJson(fix.stagingFile, null);
      expect(staged).toBeTruthy();
      expect(staged.receipt_capability).toBe(fix.capabilityWorkerA);

      // Now Worker B is dispatched for the same ticket with a DIFFERENT capability
      // Update dispatch intent to reflect Worker B's bound capability
      const intentWorkerB = {
        ...fix.intentWorkerA,
        capability_hash: sha256(fix.capabilityWorkerB),
        bound_session_id: 'session-worker-b',
        bound_agent_id: 'agent-worker-b',
      };
      await atomicWriteJson(fix.intentFile, intentWorkerB);

      // Worker B finishes with conversational prose in SubagentStop hook
      const stopResponse = await invokeCodexHook(
        repoRoot,
        {
          hook_event_name: 'SubagentStop',
          project_dir: fix.dir,
          session_id: 'session-worker-b',
          agent_id: 'agent-worker-b',
          last_assistant_message: 'Worker B finished task. All tests passed in conversational prose.',
        },
      );

      // Worker B MUST NOT adopt Worker A's staged receipt; hook must block
      expect(stopResponse.decision).toBe('block');
      expect(stopResponse.reason).toContain('the canonical capability does not match the exact bound physical dispatch');
    });

    it('recordReceipt rejects Worker B when dispatch capability differs from Worker A staged receipt', async () => {
      const fix = await fixture();
      const draftA = makeValidDraft(fix.ticket, fix.capabilityWorkerA);

      // Worker A validates and stages receipt
      await validateReceiptForDispatch(fix.dir, draftA, fix.ticket.ticket_id);
      expect(await readJson(fix.stagingFile, null)).toBeTruthy();

      // Worker B is bound to dispatch intent
      const intentWorkerB = {
        ...fix.intentWorkerA,
        capability_hash: sha256(fix.capabilityWorkerB),
      };
      await atomicWriteJson(fix.intentFile, intentWorkerB);

      // Worker B attempts to record receipt by passing only ticket_id (relying on staged draft)
      const recordResult = await recordReceipt(fix.dir, {
        ticket_id: fix.ticket.ticket_id,
      });

      // recordReceipt must reject because staged draft's capability does not authenticate against Worker B's intent
      expect(recordResult.ok).toBe(false);
      expect(recordResult.rejected).toBe(true);
      expect(recordResult.errors).toEqual(
        expect.arrayContaining([
          expect.stringContaining('receipt capability does not match the exact bound physical dispatch'),
        ]),
      );

      // No receipt recorded in state
      const state = await readJson(fix.paths.active);
      expect(state.receipts.length).toBe(0);
    });

    it('cross-ticket isolation prevents Worker on Ticket B from adopting Ticket A staged receipt', async () => {
      const fix = await fixture();
      const draftA = makeValidDraft(fix.ticket, fix.capabilityWorkerA);
      await validateReceiptForDispatch(fix.dir, draftA, fix.ticket.ticket_id);

      // Add a second pending ticket (ticket-2) to active state
      const state = await readJson(fix.paths.active);
      const ticket2Id = `${fix.state.run_id}:build:ticket-2`;
      const ticket2 = finalizeTicket({
        ...fix.ticket,
        ticket_id: ticket2Id,
      });
      state.tickets.push(ticket2);
      await atomicWriteJson(fix.paths.active, state);

      // Worker on ticket-2 attempts to record receipt with conversational prose
      const recordResult = await recordReceipt(fix.dir, {
        ticket_id: ticket2Id,
      });

      // Staged receipt for ticket-1 must NOT be adopted for ticket-2
      expect(recordResult.ok).toBe(false);
      expect(recordResult.rejected).toBe(true);
      expect(await readJson(stagedReceiptPath(fix.paths, ticket2Id), null)).toBeNull();
    });
  });

  describe('Dimension 2: Staged receipt cleanup and replay prevention', () => {
    it('permanently deletes staged receipt on recordReceipt and prevents subsequent replay', async () => {
      const fix = await fixture();
      const draft = makeValidDraft(fix.ticket, fix.capabilityWorkerA);

      await validateReceiptForDispatch(fix.dir, draft, fix.ticket.ticket_id);
      expect(await readJson(fix.stagingFile, null)).toBeTruthy();

      // First recordReceipt adopts staged draft and completes successfully
      const firstRecord = await recordReceipt(fix.dir, {
        ticket_id: fix.ticket.ticket_id,
      });
      expect(firstRecord.ok).toBe(true);

      // Staging file must be permanently removed
      await expect(access(fix.stagingFile)).rejects.toThrow();

      // Replay attempt: caller tries to invoke recordReceipt again with only ticket_id
      const replayAttempt = await recordReceipt(fix.dir, {
        ticket_id: fix.ticket.ticket_id,
      });

      // Because staging file was deleted, ticket_id-only input has no staged receipt to adopt
      // and cannot authenticate capability, rejecting immediately
      expect(replayAttempt.ok).toBe(false);
      expect(replayAttempt.rejected).toBe(true);
      expect(replayAttempt.errors).toEqual(
        expect.arrayContaining([
          expect.stringContaining('receipt capability does not match the exact bound physical dispatch'),
        ]),
      );
    });
  });

  describe('Dimension 3: Lifecycle cleanup on supersession and single-step resume', () => {
    it('startRun wipes old staged receipts when superseding a blocked run', async () => {
      const fix = await fixture();
      const draft = makeValidDraft(fix.ticket, fix.capabilityWorkerA);
      await validateReceiptForDispatch(fix.dir, draft, fix.ticket.ticket_id);
      expect(await readJson(fix.stagingFile, null)).toBeTruthy();

      // Transition run to blocked
      const state = await readJson(fix.paths.active);
      state.status = 'blocked';
      state.stage = 'build';
      state.block_reason = 'Worker failed to complete before timeout';
      await atomicWriteJson(fix.paths.active, state);
      await atomicWriteJson(path.join(fix.paths.runs, `${state.run_id}.json`), state);

      // Supersede via startRun
      const startResult = await startRun(fix.dir, {
        objective: 'Replacement run for blocked run',
        mode: 'phase',
        lane: 'fast',
        host: 'codex',
        claimed_paths: ['src/index.js'],
        test_paths: [],
        requirements: [],
        risk_triggers: [],
        behavioral: false,
        hooks_trusted: true,
        subagents_available: true,
        explicit_invocation: true,
      });
      expect(startResult.ok).toBe(true);

      // Staging file of superseded run was wiped
      await expect(access(fix.stagingFile)).rejects.toThrow();
    });

    it('single-step resume wipes old staged receipts when replacing a blocked run', async () => {
      const dir = await mkdtemp(path.join(tmpdir(), 'ape-challenger-resume-'));
      cleanups.push(dir);

      git(dir, 'init', '-q', '-b', 'main');
      git(dir, 'config', 'user.name', 'APE Test');
      git(dir, 'config', 'user.email', 'ape@example.test');
      git(dir, 'config', 'core.autocrlf', 'false');
      await writeFile(path.join(dir, '.gitignore'), '.ape/\n.env\n');
      await writeFile(path.join(dir, 'README.md'), '# Base documentation\n');
      git(dir, 'add', '.');
      git(dir, 'commit', '-qm', 'baseline');

      const paths = runtimePaths(dir);
      await atomicWriteJson(paths.config, {
        shipping: { auto_merge: false, required_remote_checks: false },
        test_commands: { full: 'node -e "process.exit(0)"', targeted_template: 'node -e "process.exit(0)"' },
      });

      const startInput = {
        objective: 'Implement feature documentation',
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
      };

      const started = await startRun(dir, startInput);
      expect(started.ok).toBe(true);

      const state = await readJson(paths.active);
      const ticket = state.tickets[0];
      expect(ticket).toBeDefined();

      // Stage a receipt draft for this ticket
      const stagedFile = stagedReceiptPath(paths, ticket.ticket_id);
      await stageReceiptDraft(paths, ticket, {
        ticket_id: ticket.ticket_id,
        status: 'passed',
        receipt_capability: 'sample-bearer-token',
        summary: 'Staged before run blocked',
      });
      expect(await readJson(stagedFile, null)).toBeTruthy();

      // Transition run to blocked
      state.status = 'blocked';
      state.stage = 'build';
      state.block_reason = 'Worker hit unexpected blocker in index.js';
      await atomicWriteJson(paths.active, state);
      await atomicWriteJson(path.join(paths.runs, `${state.run_id}.json`), state);

      // Create unstaged/staged edits for work checkpoint
      await mkdir(path.join(dir, 'docs'), { recursive: true });
      await writeFile(path.join(dir, 'docs/feature.md'), '# Feature Documentation\n');

      // Invoke single-step resume
      const resumeResult = await resumeRun(dir, { explicit_invocation: true });
      expect(resumeResult.ok).toBe(true);

      // Defect: resumeRunLocked (lib/runtime/lifecycle-service.js:1547-1605) cleans up locks,
      // checkpoints, and intents, but omits cleanupStagedReceipts(paths, state.tickets).
      // When startRunLocked is called, paths.active was already deleted so existing is null,
      // skipping staged receipt cleanup.
      // Expected Invariant per Requirement 3: Staging file of superseded run must be wiped.
      await expect(access(stagedFile)).rejects.toThrow();
    });
  });
});
