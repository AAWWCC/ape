// __tests__/challenger-m2-staged-receipt-stress.test.js
import { afterEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { access, chmod, mkdir, mkdtemp, readdir, rm, stat, writeFile } from 'node:fs/promises';
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
  cleanupStagedReceipt,
  cleanupStagedReceipts,
  readStagedReceipt,
  stageReceiptDraft,
  stagedReceiptPath,
} from '../lib/runtime/receipt-service.js';
import {
  recordReceipt,
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
  const dir = await mkdtemp(path.join(tmpdir(), 'ape-challenger-m2-'));
  cleanups.push(dir);

  git(dir, 'init', '-q', '-b', 'main');
  git(dir, 'config', 'user.email', 'ape-challenger@example.invalid');
  git(dir, 'config', 'user.name', 'APE Challenger');
  git(dir, 'config', 'core.autocrlf', 'false');

  await writeFile(path.join(dir, '.gitignore'), '.ape/\n.env\n');
  await mkdir(path.join(dir, 'src'), { recursive: true });
  await writeFile(path.join(dir, 'src', 'index.js'), 'export const value = 1;\n');
  git(dir, 'add', '.');
  git(dir, 'commit', '-qm', 'initial commit');

  const baseBranch = git(dir, 'branch', '--show-current');
  const runBranch = 'ape/run-challenger-m2';
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

  const runId = overrides.runId ?? 'run-challenger-m2-1';
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

  function buildTicket(tId, claimed = ['src/index.js']) {
    const base = {
      schema_version: '2.0.0',
      ticket_id: tId,
      run_id: runId,
      stage_id: stageId,
      role,
      objective: 'Implement feature and return validated receipt',
      claimed_paths: claimed,
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
    const schema = receiptOutputSchemaForTicket(base);
    return finalizeTicket({
      ...base,
      output_schema: schema,
      capability_manifest: {
        version: 1,
        config_hash: 'c'.repeat(64),
        required_capabilities: [],
        allowed_evidence_commands: ['npm test'],
        command_profiles: [],
        verification_profiles: [],
        objective_hash: sha256(base.objective),
        preflight_hash: null,
        risk_triggers: [],
        design_assurance_required: false,
        receipt_schema: { ref: 'ticket.output_schema', hash: sha256(schema) },
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
  }

  const ticket = buildTicket(ticketId);
  const tickets = overrides.extraTickets
    ? [ticket, ...overrides.extraTickets.map((id, idx) => buildTicket(id, [`src/extra_${idx}.js`]))]
    : [ticket];

  const state = {
    version: 2,
    schema_version: '2.0.0',
    run_id: runId,
    status: 'running',
    stage: stageId,
    host: 'codex',
    binding_protocol: 'native-v1',
    objective: ticket.objective,
    mode: 'phase',
    lane: 'fast',
    claimed_paths: ['src/index.js'],
    test_paths: [],
    requirements: [],
    risk_triggers: [],
    tickets,
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
    tickets,
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

describe('Challenger M2: Empirical Adversarial Stress Test Suite', () => {
  describe('1. Malformed and Truncated Staged JSON Resilience', () => {
    it('readStagedReceipt returns null for truncated JSON without throwing uncaught exception', async () => {
      const fix = await fixture();
      await mkdir(path.dirname(fix.stagingFile), { recursive: true });
      await writeFile(fix.stagingFile, '{"ticket_id": "' + fix.ticket.ticket_id + '", "status": ', 'utf8');

      const result = await readStagedReceipt(fix.paths, fix.ticket.ticket_id);
      expect(result).toBeNull();
    });

    it('readStagedReceipt returns null for arbitrary binary / non-JSON data without throwing', async () => {
      const fix = await fixture();
      await mkdir(path.dirname(fix.stagingFile), { recursive: true });
      await writeFile(fix.stagingFile, Buffer.from([0x00, 0xff, 0xfe, 0x01, 0x7b, 0x22, 0x00]));

      const result = await readStagedReceipt(fix.paths, fix.ticket.ticket_id);
      expect(result).toBeNull();
    });

    it('readStagedReceipt returns null for empty (0-byte) staging file', async () => {
      const fix = await fixture();
      await mkdir(path.dirname(fix.stagingFile), { recursive: true });
      await writeFile(fix.stagingFile, '', 'utf8');

      const result = await readStagedReceipt(fix.paths, fix.ticket.ticket_id);
      expect(result).toBeNull();
    });

    it('readStagedReceipt returns null when staging path is a directory', async () => {
      const fix = await fixture();
      await mkdir(fix.stagingFile, { recursive: true });

      const result = await readStagedReceipt(fix.paths, fix.ticket.ticket_id);
      expect(result).toBeNull();
    });

    it('recordReceipt rejects cleanly when staging file contains truncated JSON and prose is submitted', async () => {
      const fix = await fixture();
      await mkdir(path.dirname(fix.stagingFile), { recursive: true });
      await writeFile(fix.stagingFile, '{"ticket_id": "' + fix.ticket.ticket_id + '", "status": ', 'utf8');

      const result = await recordReceipt(fix.dir, 'Done with the task, all tests passed.');
      expect(result.ok).toBe(false);
      expect(result.rejected).toBe(true);
      expect(result.errors.length).toBeGreaterThan(0);
    });

    it('recordReceipt rejects cleanly when staging file contains binary garbage and prose is submitted', async () => {
      const fix = await fixture();
      await mkdir(path.dirname(fix.stagingFile), { recursive: true });
      await writeFile(fix.stagingFile, Buffer.from([0xde, 0xad, 0xbe, 0xef, 0x00]));

      const result = await recordReceipt(fix.dir, 'Done with task.');
      expect(result.ok).toBe(false);
      expect(result.rejected).toBe(true);
    });

    it('SubagentStop hook refuses termination when staging file is truncated JSON and worker outputs prose', async () => {
      const fix = await fixture();
      await mkdir(path.dirname(fix.stagingFile), { recursive: true });
      await writeFile(fix.stagingFile, '{"ticket_id": "' + fix.ticket.ticket_id + '", "status": ', 'utf8');

      const stopResponse = await invokeCodexHook(repoRoot, {
        hook_event_name: 'SubagentStop',
        project_dir: fix.dir,
        session_id: fix.sessionId,
        turn_id: fix.turnId,
        agent_id: fix.agentId,
        agent_type: 'default',
        is_subagent: true,
        last_assistant_message: 'Finished task cleanly in prose.',
      });

      expect(stopResponse.decision).toBe('block');
      expect(stopResponse.reason).toMatch(/receipt|capability|evidence/i);
    });

    it('SubagentStop hook refuses termination when staging file is empty (0 bytes)', async () => {
      const fix = await fixture();
      await mkdir(path.dirname(fix.stagingFile), { recursive: true });
      await writeFile(fix.stagingFile, '', 'utf8');

      const stopResponse = await invokeCodexHook(repoRoot, {
        hook_event_name: 'SubagentStop',
        project_dir: fix.dir,
        session_id: fix.sessionId,
        turn_id: fix.turnId,
        agent_id: fix.agentId,
        agent_type: 'default',
        is_subagent: true,
        last_assistant_message: 'Finished task cleanly in prose.',
      });

      expect(stopResponse.decision).toBe('block');
      expect(stopResponse.reason).toMatch(/receipt|capability|evidence/i);
    });
  });

  describe('2. Staged Draft with Mismatched Ticket ID & Isolation', () => {
    it('recordReceipt strictly rejects when staged draft contains a mismatched ticket ID', async () => {
      const fix = await fixture();
      const mismatchedTicketId = 'mismatched-ticket-id-999';

      // Stage a draft whose internal ticket_id does not match the file's ticket_id
      const draft = makeValidDraft(fix.ticket, fix.capability, { ticket_id: mismatchedTicketId });
      await mkdir(path.dirname(fix.stagingFile), { recursive: true });
      await writeFile(fix.stagingFile, JSON.stringify(draft, null, 2), 'utf8');

      const result = await recordReceipt(fix.dir, 'Done with feature implementation.');
      expect(result.ok).toBe(false);
      expect(result.rejected).toBe(true);
      // Mismatched draft was rejected and not adopted
    });

    it('SubagentStop hook strictly rejects when staged draft contains a mismatched ticket ID', async () => {
      const fix = await fixture();
      const mismatchedTicketId = 'mismatched-ticket-id-999';

      const draft = makeValidDraft(fix.ticket, fix.capability, { ticket_id: mismatchedTicketId });
      await mkdir(path.dirname(fix.stagingFile), { recursive: true });
      await writeFile(fix.stagingFile, JSON.stringify(draft, null, 2), 'utf8');

      const stopResponse = await invokeCodexHook(repoRoot, {
        hook_event_name: 'SubagentStop',
        project_dir: fix.dir,
        session_id: fix.sessionId,
        turn_id: fix.turnId,
        agent_id: fix.agentId,
        agent_type: 'default',
        is_subagent: true,
        last_assistant_message: 'Completed work in prose.',
      });

      expect(stopResponse.decision).toBe('block');
      expect(stopResponse.reason).toMatch(/receipt|capability|evidence/i);
    });

    it('recordReceipt strictly rejects when staged draft is missing ticket_id entirely', async () => {
      const fix = await fixture();
      const draft = makeValidDraft(fix.ticket, fix.capability);
      delete draft.ticket_id;

      await mkdir(path.dirname(fix.stagingFile), { recursive: true });
      await writeFile(fix.stagingFile, JSON.stringify(draft, null, 2), 'utf8');

      const result = await recordReceipt(fix.dir, 'Done with feature implementation.');
      expect(result.ok).toBe(false);
      expect(result.rejected).toBe(true);
    });

    it('multi-ticket isolation: prose submission does NOT adopt draft if multiple pending tickets exist', async () => {
      const ticket2Id = 'run-challenger-m2-1:build:ticket-2';
      const fix = await fixture({ extraTickets: [ticket2Id] });

      // Only Ticket 1 has a valid staged draft
      const draft = makeValidDraft(fix.ticket, fix.capability);
      await stageReceiptDraft(fix.paths, fix.ticket, draft);

      // Worker invokes recordReceipt with ambiguous conversational prose and no ticket_id
      const result = await recordReceipt(fix.dir, 'Done with all work!');
      // Must be rejected because target ticket cannot be safely inferred
      expect(result.ok).toBe(false);
      expect(result.rejected).toBe(true);
      expect(result.errors).toContain('unknown ticket');
    });

    it('multi-ticket isolation: worker specifying ticket 2 cannot adopt ticket 1 staged draft', async () => {
      const ticket2Id = 'run-challenger-m2-1:build:ticket-2';
      const fix = await fixture({ extraTickets: [ticket2Id] });

      // Ticket 1 has a staged draft
      const draft1 = makeValidDraft(fix.ticket, fix.capability);
      await stageReceiptDraft(fix.paths, fix.ticket, draft1);

      // Now stage Ticket 1's draft under Ticket 2's staging file (simulating cross-ticket spoofing)
      const ticket2Staging = stagedReceiptPath(fix.paths, ticket2Id);
      await mkdir(path.dirname(ticket2Staging), { recursive: true });
      await writeFile(ticket2Staging, JSON.stringify(draft1, null, 2), 'utf8');

      // Worker invokes recordReceipt targeting ticket 2 with prose or partial object
      const result = await recordReceipt(fix.dir, { ticket_id: ticket2Id });
      expect(result.ok).toBe(false);
      expect(result.rejected).toBe(true);
    });
  });

  describe('3. Rapid Concurrent Validations and Writes', () => {
    it('50 parallel stageReceiptDraft calls on the same ticket never corrupt JSON or throw', async () => {
      const fix = await fixture();

      const promises = Array.from({ length: 50 }, (_, i) => {
        const draft = makeValidDraft(fix.ticket, fix.capability, {
          evidence: { summary: `Concurrent draft revision ${i}`, iteration: i },
        });
        return stageReceiptDraft(fix.paths, fix.ticket, draft);
      });

      const results = await Promise.all(promises);
      expect(results.every((r) => r === true)).toBe(true);

      // File on disk must be completely valid JSON and readable
      const staged = await readStagedReceipt(fix.paths, fix.ticket.ticket_id);
      expect(staged).not.toBeNull();
      expect(staged.ticket_id).toBe(fix.ticket.ticket_id);
      expect(staged.status).toBe('passed');
      expect(staged.evidence).toBeDefined();
      expect(typeof staged.evidence.iteration).toBe('number');
    });

    it('interleaved concurrent writes and reads never return corrupt or partial data', async () => {
      const fix = await fixture();

      let syntaxErrorsCaught = 0;
      let validReads = 0;
      let nullReads = 0;

      const writers = Array.from({ length: 30 }, (_, i) => {
        const draft = makeValidDraft(fix.ticket, fix.capability, {
          evidence: { summary: `Revision ${i}`, index: i },
        });
        return stageReceiptDraft(fix.paths, fix.ticket, draft);
      });

      const readers = Array.from({ length: 50 }, async () => {
        try {
          const res = await readStagedReceipt(fix.paths, fix.ticket.ticket_id);
          if (res === null) {
            nullReads += 1;
          } else {
            expect(res.ticket_id).toBe(fix.ticket.ticket_id);
            validReads += 1;
          }
        } catch {
          syntaxErrorsCaught += 1;
        }
      });

      await Promise.all([...writers, ...readers]);

      // There must be ZERO syntax errors or uncaught JSON exceptions during concurrent read/write
      expect(syntaxErrorsCaught).toBe(0);
      expect(validReads + nullReads).toBe(50);
    });

    it('concurrent stageReceiptDraft and cleanupStagedReceipt never crash or throw', async () => {
      const fix = await fixture();

      const operations = Array.from({ length: 40 }, (_, i) => {
        if (i % 2 === 0) {
          const draft = makeValidDraft(fix.ticket, fix.capability, {
            evidence: { summary: `Race draft ${i}` },
          });
          return stageReceiptDraft(fix.paths, fix.ticket, draft);
        } else {
          return cleanupStagedReceipt(fix.paths, fix.ticket.ticket_id);
        }
      });

      // Must complete cleanly without unhandled rejection
      await expect(Promise.all(operations)).resolves.toBeDefined();
    });
  });

  describe('4. File Permissions and Path Boundaries', () => {
    it('stageReceiptDraft writes staging file with private 0o600 permissions', async () => {
      const fix = await fixture();
      const draft = makeValidDraft(fix.ticket, fix.capability);

      await stageReceiptDraft(fix.paths, fix.ticket, draft);

      const fileStats = await stat(fix.stagingFile);
      // On POSIX systems, check private mode (0o600)
      if (process.platform !== 'win32') {
        const mode = fileStats.mode & 0o777;
        expect(mode).toBe(0o600);
      }
    });

    it('stageReceiptDraft cleanly ignores invalid ticket objects', async () => {
      const fix = await fixture();
      const draft = makeValidDraft(fix.ticket, fix.capability);

      expect(await stageReceiptDraft(fix.paths, null, draft)).toBe(false);
      expect(await stageReceiptDraft(fix.paths, {}, draft)).toBe(false);
      expect(await stageReceiptDraft(fix.paths, { ticket_id: null }, draft)).toBe(false);
      expect(await stageReceiptDraft(fix.paths, { ticket_id: '' }, draft)).toBe(false);
    });

    it('readStagedReceipt returns null for non-string or empty ticket IDs', async () => {
      const fix = await fixture();
      expect(await readStagedReceipt(fix.paths, null)).toBeNull();
      expect(await readStagedReceipt(fix.paths, undefined)).toBeNull();
      expect(await readStagedReceipt(fix.paths, '')).toBeNull();
      expect(await readStagedReceipt(fix.paths, 12345)).toBeNull();
    });

    it('cleanupStagedReceipt ignores invalid ticket IDs without throwing', async () => {
      const fix = await fixture();
      await expect(cleanupStagedReceipt(fix.paths, null)).resolves.toBeUndefined();
      await expect(cleanupStagedReceipt(fix.paths, undefined)).resolves.toBeUndefined();
      await expect(cleanupStagedReceipt(fix.paths, '')).resolves.toBeUndefined();
    });
  });
});
