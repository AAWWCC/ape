// __tests__/runtime-v2-staged-receipt-fallback.test.js
import { afterEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { access, mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { gitFixtureEnv } from '../test-support/git-fixtures.js';
import { runtimePaths } from '../lib/runtime/paths.js';
import { atomicWriteJson, readJson } from '../lib/runtime/storage.js';
import { sha256 } from '../lib/runtime/canonical.js';
import { receiptOutputSchemaForTicket } from '../lib/runtime/receipt-validator.js';
import { finalizeTicket } from '../lib/runtime/schemas.js';
import { receiptInputHash } from '../lib/runtime/receipt-input.js';
import { emptyOrchestrationTelemetry } from '../lib/runtime/orchestration-telemetry.js';
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
  await Promise.all(cleanups.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

function git(cwd, ...args) {
  return execFileSync('git', args, { env: gitFixtureEnv(), cwd, encoding: 'utf8' }).trim();
}

async function fixture(overrides = {}) {
  const dir = await mkdtemp(path.join(tmpdir(), 'ape-staged-receipt-'));
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
  const runBranch = 'ape/run-staged-receipt';
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

  const runId = overrides.runId ?? 'run-staged-receipt-1';
  const stageId = overrides.stageId ?? 'build';
  const role = overrides.role ?? 'implementer';
  const ticketId = `${runId}:${stageId}:ticket-1`;
  const capability = overrides.capability ?? 'test-receipt-capability-secret-1234567890';
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
    ...overrides.state,
  };

  await atomicWriteJson(paths.active, state);
  await atomicWriteJson(path.join(paths.runs, `${runId}.json`), state);

  const intentFile = path.join(paths.dispatchIntents, `${sha256(ticketId)}.json`);
  const intent = {
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
    capability_hash: sha256(capability),
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
    ...overrides.intent,
  };
  await atomicWriteJson(intentFile, intent);

  const stagingFile = paths.receiptsStaging
    ? path.join(paths.receiptsStaging, `${ticketId}.json`)
    : path.join(paths.receipts, 'staging', `${ticketId}.json`);

  return {
    dir,
    paths,
    state,
    ticket,
    capability,
    sessionId,
    agentId,
    turnId,
    intentFile,
    stagingFile,
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

describe('R3: Dual-Handoff Staged Receipt Fallback', () => {
  describe('happy path: atomic receipt staging during validation', () => {
    it('writes valid receipt draft atomically to staging file upon successful validation', async () => {
      const fix = await fixture();
      const draft = makeValidDraft(fix.ticket, fix.capability);

      const validation = await validateReceiptForDispatch(fix.dir, draft, fix.ticket.ticket_id);
      expect(validation).toMatchObject({ valid: true, attested: true });

      // Staging file must exist on disk and contain the validated draft
      const staged = await readJson(fix.stagingFile, null);
      expect(staged).not.toBeNull();
      expect(staged.ticket_id).toBe(fix.ticket.ticket_id);
      expect(staged.status).toBe('passed');
      expect(staged.evidence).toEqual(draft.evidence);
      expect(staged.receipt_capability).toBe(fix.capability);
    });

    it('updates staging file atomically when draft is revised and re-validated', async () => {
      const fix = await fixture();
      const draft1 = makeValidDraft(fix.ticket, fix.capability, {
        evidence: { summary: 'Initial draft version 1' },
      });

      const validation1 = await validateReceiptForDispatch(fix.dir, draft1, fix.ticket.ticket_id);
      expect(validation1.valid).toBe(true);

      const staged1 = await readJson(fix.stagingFile, null);
      expect(staged1.evidence.summary).toBe('Initial draft version 1');

      // Second validation with improved draft
      const draft2 = makeValidDraft(fix.ticket, fix.capability, {
        evidence: { summary: 'Refined draft version 2 with extra assertions' },
      });

      const validation2 = await validateReceiptForDispatch(fix.dir, draft2, fix.ticket.ticket_id);
      expect(validation2.valid).toBe(true);

      const staged2 = await readJson(fix.stagingFile, null);
      expect(staged2.evidence.summary).toBe('Refined draft version 2 with extra assertions');

      // Verify no temporary files remain in staging directory
      const stagingDir = path.dirname(fix.stagingFile);
      const files = await readdir(stagingDir);
      expect(files).toEqual([`${fix.ticket.ticket_id}.json`]);
    });
  });

  describe('prose final turn: SubagentStop fallback and receipt adoption', () => {
    it('SubagentStop hook adopts staged receipt when final turn is conversational prose', async () => {
      const fix = await fixture();
      const draft = makeValidDraft(fix.ticket, fix.capability);

      // 1. Worker validates draft via ape_validate_receipt
      const validation = await validateReceiptForDispatch(fix.dir, draft, fix.ticket.ticket_id);
      expect(validation.valid).toBe(true);
      expect(await readJson(fix.stagingFile, null)).toBeTruthy();

      // 2. Worker completes turn with conversational prose instead of JSON
      const conversationalProse =
        'I have finished implementing the required changes and verified that all unit tests pass cleanly. The receipt draft was validated.';

      const stopResponse = await invokeCodexHook(repoRoot, {
        hook_event_name: 'SubagentStop',
        project_dir: fix.dir,
        session_id: fix.sessionId,
        turn_id: fix.turnId,
        agent_id: fix.agentId,
        agent_type: 'default',
        is_subagent: true,
        last_assistant_message: conversationalProse,
      });

      // Hook permits subagent termination rather than denying for missing capability/evidence
      expect(stopResponse).toEqual({});

      // Attestation on disk records valid draft observation
      const intent = await readJson(fix.intentFile, null);
      expect(intent.agent_stopped_at).toBeDefined();
      expect(intent.valid_draft_observed).toBe(true);
      expect(intent.receipt_validation?.attested_input_hash).toBe(receiptInputHash(draft));
    });

    it('recordReceipt adopts staged receipt on conversational or partial input, fulfills ticket, and records receipt', async () => {
      const fix = await fixture();
      const draft = makeValidDraft(fix.ticket, fix.capability);

      // Pre-stage receipt
      await validateReceiptForDispatch(fix.dir, draft, fix.ticket.ticket_id);

      // Simulate SubagentStop
      await invokeCodexHook(repoRoot, {
        hook_event_name: 'SubagentStop',
        project_dir: fix.dir,
        session_id: fix.sessionId,
        turn_id: fix.turnId,
        agent_id: fix.agentId,
        agent_type: 'default',
        is_subagent: true,
        last_assistant_message: 'Completed work.',
      });

      // Advance by recording receipt using minimal ticket reference or conversational payload
      const recordResult = await recordReceipt(fix.dir, {
        ticket_id: fix.ticket.ticket_id,
        prose_message: 'Finished task and validated staged receipt',
      });

      expect(recordResult.ok).toBe(true);
      expect(recordResult.receipt).toBeDefined();
      expect(recordResult.receipt.ticket_id).toBe(fix.ticket.ticket_id);
      expect(recordResult.receipt.status).toBe('passed');
      expect(recordResult.receipt.evidence).toEqual(draft.evidence);

      // Ticket is fulfilled: recorded in state.receipts and active state
      const activeState = await readJson(fix.paths.active);
      expect(activeState.receipts).toHaveLength(1);
      expect(activeState.receipts[0].ticket_id).toBe(fix.ticket.ticket_id);
      expect(activeState.receipts[0].receipt_id).toBe(recordResult.receipt.receipt_id);

      // Receipt is permanently recorded in .ape/runtime/receipts/${receipt_id}.json
      const permanentReceipt = await readJson(
        path.join(fix.paths.receipts, `${recordResult.receipt.receipt_id}.json`),
        null,
      );
      expect(permanentReceipt).toBeTruthy();
      expect(permanentReceipt.receipt_id).toBe(recordResult.receipt.receipt_id);
    });
  });

  describe('missing evidence path: blocking behavior when no staged receipt exists', () => {
    it('SubagentStop denies termination when worker outputs prose without a staged receipt', async () => {
      const fix = await fixture();

      // Ensure no staging file exists
      await rm(fix.stagingFile, { force: true });

      const conversationalProse = 'All done with the tasks, no errors encountered!';

      const stopResponse = await invokeCodexHook(repoRoot, {
        hook_event_name: 'SubagentStop',
        project_dir: fix.dir,
        session_id: fix.sessionId,
        turn_id: fix.turnId,
        agent_id: fix.agentId,
        agent_type: 'default',
        is_subagent: true,
        last_assistant_message: conversationalProse,
      });

      // Hook refuses termination
      expect(stopResponse.decision).toBe('block');
      expect(stopResponse.reason).toMatch(/receipt|capability|evidence/i);
    });

    it('recordReceipt rejects incomplete receipt when validation exhausted or no staged draft exists', async () => {
      const fix = await fixture();

      // Ensure no staging file exists
      await rm(fix.stagingFile, { force: true });

      // Attempt to record receipt with conversational prose and no evidence
      const recordResult = await recordReceipt(fix.dir, {
        ticket_id: fix.ticket.ticket_id,
        summary: 'Done without staging',
      });

      expect(recordResult.ok).toBe(false);
      expect(recordResult.rejected).toBe(true);
      expect(recordResult.errors.some((err) => /evidence|capability/i.test(err))).toBe(true);

      // Active state receipts must remain empty
      const activeState = await readJson(fix.paths.active);
      expect(activeState.receipts).toHaveLength(0);
    });
  });

  describe('invalid draft: rejected during validation and never staged', () => {
    it('rejects draft with missing required fields and does NOT write staging file', async () => {
      const fix = await fixture();

      const invalidDraft = {
        ticket_id: fix.ticket.ticket_id,
        status: 'invalid_status_value',
        receipt_capability: fix.capability,
        // missing tests, findings, evidence
      };

      const validation = await validateReceiptForDispatch(fix.dir, invalidDraft, fix.ticket.ticket_id);
      expect(validation.valid).toBe(false);
      expect(validation.corrections?.length).toBeGreaterThan(0);

      // Staging file must NOT be created
      const staged = await readJson(fix.stagingFile, null);
      expect(staged).toBeNull();
    });

    it('rejects draft with invalid receipt capability and does NOT write staging file', async () => {
      const fix = await fixture();

      const invalidDraft = makeValidDraft(fix.ticket, 'wrong-bogus-capability-token');

      const validation = await validateReceiptForDispatch(fix.dir, invalidDraft, fix.ticket.ticket_id);
      expect(validation.valid).toBe(false);

      // Staging file must NOT be created
      const staged = await readJson(fix.stagingFile, null);
      expect(staged).toBeNull();
    });

    it('preserves existing valid staged receipt when a subsequent draft is invalid', async () => {
      const fix = await fixture();

      // 1. Stage valid draft v1
      const validDraft = makeValidDraft(fix.ticket, fix.capability, {
        evidence: { summary: 'Original valid draft' },
      });
      const validation1 = await validateReceiptForDispatch(fix.dir, validDraft, fix.ticket.ticket_id);
      expect(validation1.valid).toBe(true);

      // 2. Submit invalid draft v2
      const invalidDraft = {
        ticket_id: fix.ticket.ticket_id,
        status: 'passed',
        // missing tests, findings, evidence
        receipt_capability: fix.capability,
      };
      const validation2 = await validateReceiptForDispatch(fix.dir, invalidDraft, fix.ticket.ticket_id);
      expect(validation2.valid).toBe(false);

      // Staging file must still retain original valid draft v1
      const staged = await readJson(fix.stagingFile, null);
      expect(staged.evidence.summary).toBe('Original valid draft');
    });
  });

  describe('staged receipt lifecycle & cleanup', () => {
    it('cleans up staging file immediately upon successful receipt recording', async () => {
      const fix = await fixture();
      const draft = makeValidDraft(fix.ticket, fix.capability);

      // Stage receipt
      await validateReceiptForDispatch(fix.dir, draft, fix.ticket.ticket_id);
      expect(await readJson(fix.stagingFile, null)).toBeTruthy();

      // Simulate SubagentStop
      await invokeCodexHook(repoRoot, {
        hook_event_name: 'SubagentStop',
        project_dir: fix.dir,
        session_id: fix.sessionId,
        turn_id: fix.turnId,
        agent_id: fix.agentId,
        agent_type: 'default',
        is_subagent: true,
        last_assistant_message: 'All tests pass.',
      });

      // Record receipt
      const recordResult = await recordReceipt(fix.dir, {
        ticket_id: fix.ticket.ticket_id,
      });
      expect(recordResult.ok).toBe(true);

      // Staging file must be cleaned up (deleted)
      await expect(access(fix.stagingFile)).rejects.toThrow();
    });

    it('superseded run cleans up staged receipts and does not leak to replacement run', async () => {
      const fix = await fixture();
      const draft = makeValidDraft(fix.ticket, fix.capability);

      // Stage receipt in run 1
      await validateReceiptForDispatch(fix.dir, draft, fix.ticket.ticket_id);
      expect(await readJson(fix.stagingFile, null)).toBeTruthy();

      // Transition run 1 to blocked
      const state = await readJson(fix.paths.active);
      state.status = 'blocked';
      state.stage = 'build';
      state.block_reason = 'Worker failed to produce final receipt before timeout';
      await atomicWriteJson(fix.paths.active, state);
      await atomicWriteJson(path.join(fix.paths.runs, `${state.run_id}.json`), state);

      // Start replacement run (R1 auto-supersede)
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

      // The old run's staged receipt was cleaned up on supersession
      await expect(access(fix.stagingFile)).rejects.toThrow();

      // The new replacement run has a new ticket and run_id
      const newActive = await readJson(fix.paths.active);
      expect(newActive.run_id).not.toBe(fix.state.run_id);
      const newTicketId = newActive.tickets[0]?.ticket_id;
      expect(newTicketId).toBeDefined();
      expect(newTicketId).not.toBe(fix.ticket.ticket_id);

      // The new run has no staged receipt
      const newStagingFile = path.join(path.dirname(fix.stagingFile), `${newTicketId}.json`);
      expect(await readJson(newStagingFile, null)).toBeNull();
    });

    it('single-step resume cleans up staged receipts from the blocked run', async () => {
      const fix = await fixture({
        state: { behavioral: false },
        config: {
          test_commands: { full: 'node -e "process.exit(0)"', targeted_template: 'node -e "process.exit(0)"' },
        },
      });
      const draft = makeValidDraft(fix.ticket, fix.capability);

      // Stage receipt in run 1
      await validateReceiptForDispatch(fix.dir, draft, fix.ticket.ticket_id);
      expect(await readJson(fix.stagingFile, null)).toBeTruthy();

      // Transition run 1 to blocked
      const state = await readJson(fix.paths.active);
      state.status = 'blocked';
      state.stage = 'build';
      state.block_reason = 'Worker failed to produce final receipt before timeout';
      await atomicWriteJson(fix.paths.active, state);
      await atomicWriteJson(path.join(fix.paths.runs, `${state.run_id}.json`), state);

      // Invoke single-step resume (R2 single-step self-healing replacement)
      const resumeResult = await resumeRun(fix.dir, { explicit_invocation: true });
      expect(resumeResult.ok).toBe(true);

      // The old run's staged receipt was cleaned up on resume
      await expect(access(fix.stagingFile)).rejects.toThrow();

      // The new replacement run has a new ticket and run_id
      const newActive = await readJson(fix.paths.active);
      expect(newActive.run_id).not.toBe(fix.state.run_id);
      const newTicketId = newActive.tickets[0]?.ticket_id;
      expect(newTicketId).toBeDefined();
      expect(newTicketId).not.toBe(fix.ticket.ticket_id);

      // The new run has no staged receipt
      const newStagingFile = path.join(path.dirname(fix.stagingFile), `${newTicketId}.json`);
      expect(await readJson(newStagingFile, null)).toBeNull();
    });
  });
});
