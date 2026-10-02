import { createHash } from 'node:crypto';
import { execFileSync, spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as dispatchIntents from '../lib/runtime/claude-dispatch.js';
import { emptyOrchestrationTelemetry } from '../lib/runtime/orchestration-telemetry.js';
import { observeCodexSubagentStop, readDispatchReceiptAttestation } from '../lib/runtime/claude-dispatch.js';
import { codexBootstrapOrientation } from '../lib/runtime/codex-bootstrap.js';
import { runtimePaths } from '../lib/runtime/paths.js';
import { receiptOutputSchemaForTicket } from '../lib/runtime/receipt-validator.js';
import { normalizeReceiptInput, receiptInputHash } from '../lib/runtime/receipt-input.js';
import {
  abortRun,
  executeApeRunTaskOperation,
  nextRun,
  recordReceipt,
  recoverReceipt,
  resumeRun,
  validateReceiptForDispatch,
} from '../lib/runtime/service.js';
import { settleReceiptValidationSubagentStop } from '../lib/runtime/receipt-service.js';
import { atomicWriteJson, readJson } from '../lib/runtime/storage.js';
import { canonicalJson, sha256 } from '../lib/runtime/canonical.js';
import { finalizeTicket } from '../lib/runtime/schemas.js';
import { DEFAULT_CONFIG } from '../lib/runtime/config.js';
import { executionPolicySnapshot } from '../lib/runtime/pipeline-limits.js';
import { historicalExecutionPolicy } from './historical-execution-policy-helper.js';

const repoRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const cleanups = [];

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((directory) =>
    rm(directory, { recursive: true, force: true })));
});

function rawDigest(value) {
  return createHash('sha256').update(value).digest('hex');
}

function runProcess(file, input, env = {}) {
  return new Promise((resolve, reject) => {
    const childEnv = { ...process.env, ...env };
    delete childEnv.CLAUDE_PROJECT_DIR;
    delete childEnv.CODEX_CWD;
    Object.assign(childEnv, env);
    const child = spawn(process.execPath, [path.join(repoRoot, file)], {
      cwd: repoRoot,
      env: childEnv,
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
      else resolve(stdout.trim().split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line)));
    });
    const messages = Array.isArray(input) ? input : [input];
    child.stdin.end(`${messages.map((entry) => JSON.stringify(entry)).join('\n')}\n`);
  });
}

async function fixture(host = 'codex', options = {}) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'ape-receipt-contract-'));
  cleanups.push(directory);
  execFileSync('git', ['init', '-q'], { cwd: directory });
  execFileSync('git', ['config', 'user.email', 'ape@example.test'], { cwd: directory });
  execFileSync('git', ['config', 'user.name', 'APE Test'], { cwd: directory });
  await writeFile(path.join(directory, 'value.js'), 'export const value = 1;\n');
  execFileSync('git', ['add', 'value.js'], { cwd: directory });
  execFileSync('git', ['commit', '-qm', 'fixture'], { cwd: directory });
  const baseBranch = execFileSync('git', ['branch', '--show-current'], {
    cwd: directory,
    encoding: 'utf8',
  }).trim();
  const runBranch = 'ape/receipt-contract-live';
  execFileSync('git', ['switch', '-qc', runBranch], { cwd: directory });
  const treeSha = execFileSync('git', ['rev-parse', 'HEAD^{tree}'], {
    cwd: directory,
    encoding: 'utf8',
  }).trim();

  const paths = runtimePaths(directory);
  const capability = 'receipt-capability-secret-1234567890';
  const runId = 'run-receipt-live';
  const stageId = options.stage_id ?? 'build';
  const role = options.role ?? 'implementer';
  const ticketId = `${runId}:${stageId}:ticket-1`;
  const timerFree = options.execution_policy?.version >= 3;
  const objective = options.objective ?? 'Return one exact validated receipt';
  const claimedPaths = options.claimed_paths ?? ['value.js'];
  const testPaths = options.test_paths ?? [];
  const allowedEvidenceCommands = options.allowed_evidence_commands ?? [];
  const verificationProfiles = options.verification_profiles ?? [];
  const preflightArtifact = options.preflight_artifact ?? null;
  const preflightHash = preflightArtifact ? sha256(preflightArtifact) : null;
  const manifestBase = {
    allowed_evidence_commands: allowedEvidenceCommands,
    verification_profiles: verificationProfiles,
    preflight_hash: preflightHash,
    risk_triggers: [],
    design_assurance_required: false,
  };
  const ticketBase = {
    schema_version: '2.0.0',
    ticket_id: ticketId,
    run_id: runId,
    stage_id: stageId,
    parallel_group: null,
    role,
    objective,
    claimed_paths: claimedPaths,
    test_paths: testPaths,
    risk_triggers: [],
    model_tier: 'balanced',
    model: { model: 'gpt-5.4', reasoning_effort: 'medium' },
    deadline_at: timerFree ? null : options.deadline_at ?? new Date(Date.now() + 3_600_000).toISOString(),
    required_checks: options.required_checks ?? [],
    writable: options.writable ?? role === 'implementer',
    base_tree_sha: treeSha,
    parent_hash: null,
    attempt: 1,
    issued_at: new Date().toISOString(),
    receipt_contract_version: 1,
    ...(options.execution_policy ? { execution_limits: options.execution_policy.limits } : {}),
    ...(options.plan_contract_version
      ? { plan_contract_version: options.plan_contract_version }
      : {}),
    ...(preflightArtifact
      ? {
          preflight: {
            artifact_hash: preflightHash,
            artifact: preflightArtifact,
            trust: 'untrusted-evidence',
          },
        }
      : {}),
    capability_manifest: manifestBase,
  };
  const outputSchema = receiptOutputSchemaForTicket(ticketBase);
  const ticket = finalizeTicket({
    ...ticketBase,
    output_schema: outputSchema,
    capability_manifest: {
      version: 1,
      config_hash: 'c'.repeat(64),
      required_capabilities: [],
      allowed_evidence_commands: allowedEvidenceCommands,
      command_profiles: [],
      verification_profiles: verificationProfiles,
      objective_hash: sha256(objective),
      preflight_hash: preflightHash,
      risk_triggers: [],
      design_assurance_required: false,
      receipt_schema: { ref: 'ticket.output_schema', hash: sha256(outputSchema) },
      field_bounds: {
        ...(options.execution_policy?.version >= 4 ? {} : {
          validation_attempts_per_worker: options.execution_policy?.limits.max_validation_submissions_per_worker ?? 3,
          max_physical_workers_per_ticket: options.execution_policy?.limits.max_physical_workers_per_ticket ?? 2,
        }),
        corrections_per_validation: 20,
        ...(options.manifest_growth_contract_version === 1
          ? {
              dynamic_test_paths: {
                max_items: 64,
                max_serialized_utf8_bytes: 4_096,
              },
            }
          : {}),
      },
      byte_budgets: {
        candidate_plan_utf8_bytes: 16_384,
        preflight_artifact_utf8_bytes: 65_536,
        mcp_projection_utf8_bytes: 48_000,
      },
    },
  });
  const createdAt = new Date(Math.min(
    Date.now() - 1_000,
    timerFree ? Infinity : Date.parse(ticket.deadline_at) - 1_000,
    options.agent_stopped_at ? Date.parse(options.agent_stopped_at) - 1_000 : Infinity,
  )).toISOString();
  const state = {
    run_id: runId,
    status: 'running',
    stage: stageId,
    host,
    binding_protocol: 'native-v1',
    objective,
    mode: options.mode ?? 'phase',
    lane: options.lane ?? 'fast',
    ...(options.execution_policy ? { execution_policy: options.execution_policy } : {}),
    ...(options.plan_contract_version
      ? { plan_contract_version: options.plan_contract_version }
      : {}),
    claimed_paths: claimedPaths,
    test_paths: testPaths,
    requirements: [],
    risk_triggers: [],
    ...(options.manifest_growth_contract_version === 1
      ? {
          capability_snapshot: {
            version: 1,
            manifest_growth_contract_version: 1,
            manifest_roles: options.manifest_roles ?? [role],
            config_hash: 'c'.repeat(64),
            required_capabilities: [],
            evidence_scripts: [],
            command_profiles: [],
            verification_profiles: verificationProfiles,
            runners: [],
            test_commands: {
              targeted_template: 'npm test -- {paths}',
              full: 'npm test',
            },
          },
        }
      : {}),
    ...(preflightArtifact
      ? {
          preflight: {
            version: 1,
            artifact_hash: preflightHash,
            artifact: preflightArtifact,
            receipt_hash: 'e'.repeat(64),
          },
        }
      : {}),
    tickets: [ticket],
    receipts: [],
    expired_tickets: [],
    attempts: {},
    remediation_cycles: 0,
    tree_sha: treeSha,
    branch: runBranch,
    base_branch: baseBranch,
    base_commit_sha: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: directory, encoding: 'utf8' }).trim(),
    checkout_cleanup: {
      status: 'pending',
      base_branch: baseBranch,
      run_branch: runBranch,
      retained: true,
      deleted: false,
      updated_at: createdAt,
    },
    orchestration: emptyOrchestrationTelemetry(),
    created_at: createdAt,
    updated_at: createdAt,
  };
  await atomicWriteJson(paths.active, state);
  await atomicWriteJson(path.join(paths.runs, `${runId}.json`), state);
  await atomicWriteJson(
    path.join(paths.dispatchIntents, `${rawDigest(ticketId)}.json`),
    {
      version: 2,
      host,
      run_id: runId,
      ticket_id: ticketId,
      ticket_hash: ticket.ticket_hash,
      agent_type: role,
      parent_session_id: 'session-1',
      tool_use_id: 'spawn-worker-1',
      requested_model: ticket.model.model,
      ...(host === 'codex'
        ? {
            binding_agent_type: 'default',
            bound_session_id: 'session-1',
            launch_name_hash: rawDigest('fixture-worker-launch'),
          }
        : { nonce_hash: rawDigest('fixture-worker-launch') }),
      status: 'bound',
      bound_agent_id: 'agent-1',
      capability_hash: rawDigest(capability),
      prepared_at: createdAt,
      launched_at: createdAt,
      launch_expires_at: new Date(Math.min(
        Date.parse(createdAt) + 60_000,
        timerFree ? Infinity : Date.parse(ticket.deadline_at),
      )).toISOString(),
      bound_at: createdAt,
      ...(options.agent_stopped_at
        ? { agent_stopped_at: options.agent_stopped_at }
        : {}),
      expires_at: ticket.deadline_at,
      ...(timerFree ? { execution_policy_version: options.execution_policy.version } : {}),
      launch_attempts: 1,
      physical_worker_dispatches: 1,
      ...(options.execution_policy ? { receipt_limits: options.execution_policy.version >= 4
        ? options.execution_policy.limits : {
        max_physical_workers_per_ticket: options.execution_policy.limits.max_physical_workers_per_ticket,
        max_validation_submissions_per_worker: options.execution_policy.limits.max_validation_submissions_per_worker,
      } } : {}),
    },
  );
  return { directory, paths, state, ticket, capability };
}

function draft(ticket, capability, status = 'passed') {
  return {
    ticket_id: ticket.ticket_id,
    status,
    tests: [],
    findings: [],
    evidence: { summary: 'complete' },
    receipt_capability: capability,
  };
}

async function bindReceiptReplacement(value, launch, worker) {
  const session = `receipt-recovery-parent-${worker}`;
  const turn = `receipt-recovery-turn-${worker}`;
  const agent = `receipt-recovery-agent-${worker}`;
  const env = { APE_HOST: 'codex', CODEX_CWD: value.directory };
  const [pre] = await runProcess('bin/ape-hook.mjs', {
    hook_event_name: 'PreToolUse', project_dir: value.directory, session_id: session,
    turn_id: `receipt-recovery-parent-turn-${worker}`, tool_use_id: `receipt-recovery-spawn-${worker}`,
    tool_name: 'collaborationspawn_agent',
    tool_input: { ...launch.dispatch.spawn_args, message: 'gAAAAABencrypted-receipt-recovery-message' },
  }, env);
  expect(pre).toEqual({});
  const [start] = await runProcess('bin/ape-hook.mjs', {
    hook_event_name: 'SubagentStart', project_dir: value.directory, session_id: session,
    turn_id: turn, agent_id: agent, agent_type: 'default', model: launch.dispatch.model.model,
  }, env);
  expect(start.hookSpecificOutput?.additionalContext).toBe(codexBootstrapOrientation());
  const [bound] = await runProcess('bin/ape-hook.mjs', {
    hook_event_name: 'PreToolUse', project_dir: value.directory, session_id: session,
    turn_id: turn, tool_use_id: `receipt-recovery-bind-${worker}`, tool_name: 'ape_bind',
    tool_input: launch.dispatch.bootstrap_args, model: launch.dispatch.model.model,
  }, env);
  const capability = /APE_RECEIPT_CAPABILITY=([A-Za-z0-9_-]{32,256})/
    .exec(bound.hookSpecificOutput?.additionalContext ?? '')?.[1];
  expect(capability).toBeTruthy();
  return { capability, identity: { session_id: session, turn_id: turn,
    agent_id: agent, agent_type: 'default' } };
}

function maximalPlannerPlan(preflightHash, targetBytes = 16_384) {
  const filled = () => Array.from({ length: 16 }, () => 'x');
  const plan = {
    version: 2,
    preflight_hash: preflightHash,
    requirements: [{ id: 'requirement', requirement: 'synthetic requirement', workstreams: ['work'] }],
    workstreams: [{
      id: 'work',
      outcome: 'implement the synthetic requirement',
      paths: [{ path: 'value.js', action: 'modify' }],
      steps: filled(),
      acceptance: filled(),
      evidence_commands: ['git diff --check'],
      verification_profiles: [],
    }],
    risks: [],
    assurances: [],
    non_goals: filled(),
  };
  let bytes = Buffer.byteLength(canonicalJson(plan), 'utf8');
  for (const values of [plan.workstreams[0].steps, plan.workstreams[0].acceptance, plan.non_goals]) {
    for (let index = 0; index < values.length && bytes < targetBytes; index += 1) {
      while (values[index].length < 500 && bytes < targetBytes) {
        values[index] += targetBytes - bytes === 1 ? 'x' : 'é';
        bytes = Buffer.byteLength(canonicalJson(plan), 'utf8');
      }
    }
  }
  if (bytes !== targetBytes) throw new Error(`could not build ${targetBytes}-byte plan`);
  return plan;
}

describe('live receipt contract integration', () => {
  it('accepts five materially correcting drafts beyond the old validation quota and seals the exact sixth draft', async () => {
    const value = await fixture('codex', { execution_policy: executionPolicySnapshot(DEFAULT_CONFIG) });
    const payload = draft(value.ticket, value.capability);
    // Independent schema defects, all present at the start. Each submission
    // repairs one defect, so neither changing prose nor attempt count is the
    // reason continuation is justified.
    const defects = { status: 'success', tests: 'invalid', findings: 'invalid', evidence: 'invalid', extra_worker_note: true };
    Object.assign(payload, defects);
    for (const [key, replacement] of [
      ['status', 'passed'], ['tests', []], ['findings', []], ['evidence', { summary: 'complete' }],
      ['extra_worker_note', undefined],
    ]) {
      const result = await validateReceiptForDispatch(value.directory, payload);
      expect(result.valid).toBe(false);
      expect(result.validation.exhausted).toBe(false);
      if (replacement === undefined) delete payload[key];
      else payload[key] = replacement;
    }
    const valid = await validateReceiptForDispatch(value.directory, payload);
    expect(valid.valid).toBe(true);
    const intentFile = path.join(value.paths.dispatchIntents, `${rawDigest(value.ticket.ticket_id)}.json`);
    const sealed = await readJson(intentFile);
    const repeated = await Promise.all(Array.from({ length: 3 }, () =>
      validateReceiptForDispatch(value.directory, structuredClone(payload))));
    expect(repeated.every((result) => result.valid)).toBe(true);
    expect(await readJson(intentFile)).toEqual(sealed);
    const changed = await recordReceipt(value.directory, { ...payload, evidence: { summary: 'altered after attestation' } });
    expect(changed).toMatchObject({ ok: false, rejected: true });
    expect((await readJson(value.paths.active)).receipts).toHaveLength(0);
    const recorded = await recordReceipt(value.directory, payload);
    expect(recorded.ok, JSON.stringify(recorded.errors)).toBe(true);
    expect(recorded.run.receipts).toHaveLength(1);
  });

  it('accepts repaired validator errors with new independent errors but stops error-set cycles', async () => {
    const value = await fixture('codex', { execution_policy: executionPolicySnapshot(DEFAULT_CONFIG) });
    const base = draft(value.ticket, value.capability);
    const candidates = [
      { ...base, status: 'success', tests: 'bad' },
      { ...base, tests: 'bad', findings: 'bad' },
      { ...base, findings: 'bad', evidence: 'bad' },
      { ...base, evidence: 'bad', extra_worker_note: true },
    ];
    for (const candidate of candidates) {
      const result = await validateReceiptForDispatch(value.directory, candidate);
      expect(result.valid).toBe(false);
      expect(result.validation.exhausted).toBe(false);
    }
    // Disk-backed service re-entry must retain the episode; a fresh object and
    // different summary cannot erase a previously unresolved error state.
    const cycle = await validateReceiptForDispatch(value.directory, {
      ...candidates[0], evidence: { summary: 'different wording, same defects' },
    });
    expect(cycle.valid).toBe(false);
    expect(cycle.validation.exhausted).toBe(true);
    expect(JSON.stringify(cycle)).toMatch(/cycle|repeat|stall|progress/i);
  });

  it('does not purchase correction or replacement progress by reordering defects beyond the public correction cap', async () => {
    const value = await fixture('codex', { execution_policy: executionPolicySnapshot(DEFAULT_CONFIG),
      allowed_evidence_commands: ['npm test'] });
    const base = draft(value.ticket, value.capability);
    const test = { command: 'npm test', passed: true, exit_code: 0, duration_ms: 1 };
    const commandDefects = Array.from({ length: 20 }, () => ({ ...test, command: '' }));
    const passedDefects = Array.from({ length: 20 }, () => ({ ...test, passed: 'yes' }));
    const firstDraft = { ...base, tests: [...commandDefects, ...passedDefects] };
    const reorderedDraft = { ...base, tests: [...passedDefects, ...commandDefects] };
    const intentFile = path.join(value.paths.dispatchIntents, `${rawDigest(value.ticket.ticket_id)}.json`);
    const first = await validateReceiptForDispatch(value.directory, firstDraft);
    expect(first).toMatchObject({ valid: false, attested: false,
      validation: { exhausted: false } });
    expect(first.corrections).toHaveLength(20);
    expect(first.corrections.every((correction) => correction.field.endsWith('.command'))).toBe(true);
    expect((await readJson(intentFile)).recovery_progress[0].keys)
      .toEqual(['tests.*.command', 'tests.*.passed']);

    // The public response may show different first-page diagnostics, but the
    // complete defect multiset is identical after service re-entry.
    const reordered = await validateReceiptForDispatch(value.directory, reorderedDraft);
    expect(reordered).toMatchObject({ valid: false, attested: false,
      validation: { exhausted: true, recovery_decision: { resolved: [] } } });
    expect(reordered.corrections).toHaveLength(20);
    expect(reordered.corrections.every((correction) => correction.field.endsWith('.passed'))).toBe(true);
    for (const result of [first, reordered]) {
      expect(result).not.toHaveProperty('recovery_keys');
      expect(result).not.toHaveProperty('correction_locations');
      for (const correction of result.corrections) {
        expect(Object.keys(correction).sort()).toEqual(['correction', 'field', 'issue']);
      }
    }
    expect(await recordReceipt(value.directory, reorderedDraft)).toMatchObject({ ok: false, rejected: true });
    const beforeStop = await readJson(intentFile);
    expect(beforeStop.recovery_progress.map((entry) => entry.keys)).toEqual([
      ['tests.*.command', 'tests.*.passed'], ['tests.*.command', 'tests.*.passed'],
    ]);
    expect(beforeStop.physical_worker_dispatches).toBe(1);
    expect((await readJson(value.paths.active)).receipts).toHaveLength(0);

    // The first exhausted worker retains the existing one-time replacement
    // opportunity. Reordering again cannot renew that opportunity afterward.
    expect(await observeCodexSubagentStop(value.paths, await readJson(value.paths.active), {
      session_id: 'session-1', agent_id: 'agent-1', agent_type: 'default',
    })).toMatchObject({ observed: true });
    const next = await nextRun(value.directory);
    const launch = next.actions.find((entry) => entry.type === 'dispatch_agent');
    expect(launch.ticket).toEqual(value.ticket);
    const replacement = await bindReceiptReplacement(value, launch, 2);
    const unchanged = await validateReceiptForDispatch(value.directory, {
      ...firstDraft, receipt_capability: replacement.capability,
    });
    expect(unchanged).toMatchObject({ valid: false, attested: false,
      validation: { exhausted: true, recovery_decision: { resolved: [], replacement_allowed: false } },
      next_action: { kind: 'blocked', automatic_successor: false } });
    expect(await observeCodexSubagentStop(value.paths, await readJson(value.paths.active), replacement.identity))
      .toMatchObject({ observed: true });
    const settled = await settleReceiptValidationSubagentStop(value.directory);
    expect(settled).toMatchObject({ ok: true, settled: true, blocked: true,
      next_action: { kind: 'blocked', automatic_successor: false } });
    expect((settled.actions ?? []).some((entry) => entry.type === 'dispatch_agent')).toBe(false);
    expect((await readJson(intentFile)).physical_worker_dispatches).toBe(2);
    const finalState = await readJson(value.paths.active);
    expect(finalState.status).toBe('blocked');
    expect(finalState.tickets).toEqual([value.ticket]);
    expect(finalState.receipts).toHaveLength(0);
  });

  it('blocks a reintroduced receipt defect before a whole error set repeats or a replacement is purchased', async () => {
    const value = await fixture('codex', { execution_policy: executionPolicySnapshot(DEFAULT_CONFIG) });
    const base = draft(value.ticket, value.capability);
    const candidates = [
      { ...base, status: 'success', tests: 'bad' },
      { ...base, tests: 'bad', findings: 'bad' },
      { ...base, findings: 'bad', status: 'success' },
    ];
    for (const candidate of candidates.slice(0, 2)) {
      expect(await validateReceiptForDispatch(value.directory, candidate))
        .toMatchObject({ valid: false, attested: false, validation: { exhausted: false } });
    }
    const reintroduced = await validateReceiptForDispatch(value.directory, candidates[2]);
    expect(reintroduced).toMatchObject({ valid: false, attested: false,
      validation: { exhausted: true, recovery_decision: {
        reason_code: 'repeated_or_stalled_correction', replacement_allowed: false,
      } }, next_action: { kind: 'blocked', automatic_successor: false } });
    for (const correction of reintroduced.corrections) {
      expect(Object.keys(correction).sort()).toEqual(['correction', 'field', 'issue']);
    }
    const intentFile = path.join(value.paths.dispatchIntents, `${rawDigest(value.ticket.ticket_id)}.json`);
    const stopped = await readJson(intentFile);
    expect(stopped.recovery_progress.map((entry) => entry.keys))
      .toEqual([['status', 'tests'], ['findings', 'tests'], ['findings', 'status']]);
    expect(stopped.physical_worker_dispatches).toBe(1);
    expect(stopped.receipt_validation_exhaustions).toBe(1);
    expect(stopped.valid_draft_observed).not.toBe(true);
    expect(await recordReceipt(value.directory, candidates[2])).toMatchObject({ ok: false, rejected: true });
    expect(await observeCodexSubagentStop(value.paths, await readJson(value.paths.active), {
      session_id: 'session-1', agent_id: 'agent-1', agent_type: 'default',
    })).toMatchObject({ observed: true });
    const settled = await settleReceiptValidationSubagentStop(value.directory);
    expect(settled).toMatchObject({ ok: true, settled: true, blocked: true,
      next_action: { kind: 'blocked', automatic_successor: false } });
    expect((settled.actions ?? []).some((entry) => entry.type === 'dispatch_agent')).toBe(false);
    const finalState = await readJson(value.paths.active);
    expect(finalState.status).toBe('blocked');
    expect(finalState.tickets).toEqual([value.ticket]);
    expect(finalState.receipts).toHaveLength(0);
    expect((await readJson(intentFile)).physical_worker_dispatches).toBe(1);
  });

  it('continues after one of several repeated receipt defects is actually repaired', async () => {
    const value = await fixture('codex', { execution_policy: executionPolicySnapshot(DEFAULT_CONFIG),
      allowed_evidence_commands: ['npm test'] });
    const test = { command: 'npm test', passed: true, exit_code: 0, duration_ms: 1 };
    const payload = { ...draft(value.ticket, value.capability),
      tests: [{ ...test, command: '' }, { ...test, command: '' }] };
    const first = await validateReceiptForDispatch(value.directory, payload);
    expect(first).toMatchObject({ valid: false, attested: false, validation: { exhausted: false } });
    payload.tests[0].command = test.command;
    const partialRepair = await validateReceiptForDispatch(value.directory, payload);
    expect(partialRepair).toMatchObject({ valid: false, attested: false,
      validation: { exhausted: false }, next_action: { kind: 'continue_same_agent' } });
    expect(await recordReceipt(value.directory, payload)).toMatchObject({ ok: false, rejected: true });
    expect((await readJson(value.paths.active)).receipts).toHaveLength(0);
    payload.tests[1].command = test.command;
    const complete = await validateReceiptForDispatch(value.directory, payload);
    expect(complete).toMatchObject({ valid: true, attested: true, validation: { exhausted: false } });
    expect((await recordReceipt(value.directory, payload)).ok).toBe(true);
    expect((await readJson(value.paths.active)).receipts).toHaveLength(1);
    const intent = await readJson(path.join(value.paths.dispatchIntents, `${rawDigest(value.ticket.ticket_id)}.json`));
    expect(intent.physical_worker_dispatches).toBe(1);
    expect(intent.receipt_validation_exhaustions).toBe(0);
  });

  it('continues after removing one of two unknown top-level receipt properties', async () => {
    const value = await fixture('codex', { execution_policy: executionPolicySnapshot(DEFAULT_CONFIG) });
    const payload = { ...draft(value.ticket, value.capability), extra_one: true, extra_two: true };
    expect(await validateReceiptForDispatch(value.directory, payload))
      .toMatchObject({ valid: false, attested: false, validation: { exhausted: false } });
    delete payload.extra_one;
    const partialRepair = await validateReceiptForDispatch(value.directory, payload);
    expect(partialRepair).toMatchObject({ valid: false, attested: false,
      validation: { exhausted: false }, next_action: { kind: 'continue_same_agent' } });
    for (const correction of partialRepair.corrections) {
      expect(Object.keys(correction).sort()).toEqual(['correction', 'field', 'issue']);
    }
    expect(await recordReceipt(value.directory, payload)).toMatchObject({ ok: false, rejected: true });
    expect((await readJson(value.paths.active)).receipts).toHaveLength(0);
    delete payload.extra_two;
    expect(await validateReceiptForDispatch(value.directory, payload))
      .toMatchObject({ valid: true, attested: true, validation: { exhausted: false } });
    expect((await recordReceipt(value.directory, payload)).ok).toBe(true);
    const intent = await readJson(path.join(value.paths.dispatchIntents, `${rawDigest(value.ticket.ticket_id)}.json`));
    expect(intent.physical_worker_dispatches).toBe(1);
    expect(intent.receipt_validation_exhaustions).toBe(0);
  });

  it('blocks resurrected receipt defect counts even when another schema location is repaired', async () => {
    const value = await fixture('codex', { execution_policy: executionPolicySnapshot(DEFAULT_CONFIG),
      allowed_evidence_commands: ['npm test'] });
    const test = { command: 'npm test', passed: true, exit_code: 0, duration_ms: 1 };
    const payload = { ...draft(value.ticket, value.capability), tests: [
      { ...test, command: '', passed: 'yes' }, { ...test, command: '' },
    ] };
    expect((await validateReceiptForDispatch(value.directory, payload)).validation.exhausted).toBe(false);
    payload.tests[0].command = test.command;
    expect((await validateReceiptForDispatch(value.directory, payload)).validation.exhausted).toBe(false);
    payload.tests[0].command = '';
    payload.tests[0].passed = true;
    const recurrence = await validateReceiptForDispatch(value.directory, payload);
    expect(recurrence).toMatchObject({ valid: false, attested: false,
      validation: { exhausted: true, recovery_decision: { replacement_allowed: false } },
      next_action: { kind: 'blocked', automatic_successor: false } });
    const intentFile = path.join(value.paths.dispatchIntents, `${rawDigest(value.ticket.ticket_id)}.json`);
    const intent = await readJson(intentFile);
    expect(intent.recovery_progress.map((entry) => entry.counts)).toEqual([
      { 'tests.*.command': 2, 'tests.*.passed': 1 },
      { 'tests.*.command': 1, 'tests.*.passed': 1 },
      { 'tests.*.command': 2 },
    ]);
    expect(intent.physical_worker_dispatches).toBe(1);
    expect(await recordReceipt(value.directory, payload)).toMatchObject({ ok: false, rejected: true });
    expect((await readJson(value.paths.active)).receipts).toHaveLength(0);
  });

  it('keeps identical concurrent invalid submissions single-effect and cannot manufacture progress with prose', async () => {
    const value = await fixture('codex', { execution_policy: executionPolicySnapshot(DEFAULT_CONFIG) });
    const payload = draft(value.ticket, value.capability, 'success');
    const results = await Promise.all([1, 2, 3].map(() => validateReceiptForDispatch(value.directory, structuredClone(payload))));
    expect(results.every((result) => result.valid === false)).toBe(true);
    const intentFile = path.join(value.paths.dispatchIntents, `${rawDigest(value.ticket.ticket_id)}.json`);
    const after = await readJson(intentFile);
    expect(after.receipt_validation_exhaustions ?? 0).toBeLessThanOrEqual(1);
    expect(after.validation_attempts).toBeLessThanOrEqual(2);
    const changed = await validateReceiptForDispatch(value.directory, {
      ...payload, evidence: { summary: 'new worker prose is not a repaired error' },
    });
    expect(changed.valid).toBe(false);
    expect(changed.validation.exhausted).toBe(true);
    expect(JSON.stringify(changed)).toMatch(/repeat|stall|progress/i);
    expect((await readJson(intentFile)).physical_worker_dispatches).toBe(after.physical_worker_dispatches);
    expect((await readJson(value.paths.active)).receipts).toHaveLength(0);
  });

  it.each(['verdict-value', 'unknown-top-level-key', 'unknown-test-key'])(
    'exhausts unchanged validation defects despite changing %s text across service re-entry', async (kind) => {
      const value = await fixture('codex', { execution_policy: executionPolicySnapshot(DEFAULT_CONFIG),
        stage_id: 'review', role: 'reviewer', writable: false,
        allowed_evidence_commands: ['npm run typecheck'] });
      const base = draft(value.ticket, value.capability);
      base.evidence.verdict = 'pass';
      const malformed = (label) => {
        const payload = structuredClone(base);
        if (kind === 'verdict-value') {
          payload.evidence.verdict = `invalid-${label}`;
          payload.tests = 'the same additional invalid field';
        }
        if (kind === 'unknown-top-level-key') payload[`junk_${label}`] = true;
        if (kind === 'unknown-test-key') payload.tests = [{ command: 'npm run typecheck',
          passed: true, exit_code: 0, duration_ms: 1, [`junk_${label}`]: true }];
        return payload;
      };
      const first = await validateReceiptForDispatch(value.directory, malformed('one'));
      expect(first.valid).toBe(false);
      expect(first.validation.exhausted).toBe(false);
      const intentFile = path.join(value.paths.dispatchIntents, `${rawDigest(value.ticket.ticket_id)}.json`);
      const initial = await readJson(intentFile);
      // Each call reloads the durable dispatch intent. Renaming an offending
      // value/property has not corrected the schema defect at this sink.
      const second = await validateReceiptForDispatch(value.directory, malformed('two'));
      expect(second.valid).toBe(false);
      expect(second.validation.exhausted).toBe(true);
      expect(JSON.stringify(second)).toMatch(/repeat|stall|progress/i);
      const concurrent = await Promise.all(['three', 'four'].map((label) =>
        validateReceiptForDispatch(value.directory, malformed(label))));
      expect(concurrent.every((result) => result.valid === false && result.validation.exhausted)).toBe(true);
      const stopped = await readJson(intentFile);
      expect(stopped.receipt_validation_exhaustions).toBe(1);
      expect(stopped.physical_worker_dispatches).toBe(initial.physical_worker_dispatches);
      expect(stopped.valid_draft_observed).not.toBe(true);
      expect((await readJson(value.paths.active)).receipts).toHaveLength(0);
      expect(await recordReceipt(value.directory, malformed('five'))).toMatchObject({ ok: false, rejected: true });
      expect((await readJson(value.paths.active)).receipts).toHaveLength(0);
    });

  it('rechecks cancellation and write scope after a v4 correction attestation before persistence', async () => {
    for (const fault of ['scope', 'cancel']) {
      const value = await fixture('codex', { execution_policy: executionPolicySnapshot(DEFAULT_CONFIG) });
      const payload = draft(value.ticket, value.capability);
      expect((await validateReceiptForDispatch(value.directory, payload)).valid).toBe(true);
      if (fault === 'scope') await writeFile(path.join(value.directory, 'foreign.js'), 'export const foreign = true;\n');
      else await abortRun(value.directory, 'operator cancelled before receipt persistence');
      const before = await readJson(value.paths.active);
      const result = await recordReceipt(value.directory, payload);
      expect(result.ok).toBe(false);
      expect((await readJson(value.paths.active)).receipts).toEqual(before.receipts);
      expect((await readJson(value.paths.active)).tickets).toEqual(before.tickets);
    }
  });

  it('carries repaired receipt evidence across four stopped workers without accepting stale capabilities', async () => {
    const value = await fixture('codex', { execution_policy: executionPolicySnapshot(DEFAULT_CONFIG) });
    const originalTicket = structuredClone(value.ticket);
    const intentFile = path.join(value.paths.dispatchIntents, `${rawDigest(value.ticket.ticket_id)}.json`);
    let capability = value.capability;
    let session = 'session-1';
    let turn;
    const invalidFields = { status: 'success', tests: 'bad', findings: 'bad', evidence: 'bad' };
    for (let worker = 1; worker <= 3; worker += 1) {
      const invalid = { ...draft(value.ticket, capability), ...invalidFields };
      const first = await validateReceiptForDispatch(value.directory, invalid);
      expect(first.valid).toBe(false);
      // A second attempted stop has the same unresolved fields. Host transport
      // termination is observed independently; it cannot be inferred from a
      // worker's own claim to have stopped.
      await validateReceiptForDispatch(value.directory, invalid);
      const live = await nextRun(value.directory);
      expect((live.actions ?? []).some((a) => a.type === 'dispatch_agent')).toBe(false);
      expect(await observeCodexSubagentStop(value.paths, await readJson(value.paths.active), {
        session_id: session, ...(turn ? { turn_id: turn } : {}),
        agent_id: `agent-${worker}`, agent_type: 'default',
      })).toMatchObject({ observed: true });
      // Two competing NEXTs must adopt one persisted launch, including when
      // the first response could have been lost before the caller saw it.
      const results = await Promise.all([nextRun(value.directory), nextRun(value.directory)]);
      const launches = results.flatMap((result) => result.actions ?? []).filter((a) => a.type === 'dispatch_agent');
      expect(launches.length).toBeGreaterThan(0);
      const launch = launches[0];
      expect(launch.ticket).toEqual(originalTicket);
      const intent = await readJson(intentFile);
      expect(intent.physical_worker_dispatches).toBe(worker + 1);
      expect((await readJson(value.paths.active)).tickets).toEqual([originalTicket]);
      const stale = await validateReceiptForDispatch(value.directory, draft(value.ticket, capability));
      expect(stale.valid).toBe(false);
      session = `v4-parent-${worker + 1}`;
      turn = `v4-turn-${worker + 1}`;
      const env = { APE_HOST: 'codex', CODEX_CWD: value.directory };
      const [pre] = await runProcess('bin/ape-hook.mjs', {
        hook_event_name: 'PreToolUse', project_dir: value.directory, session_id: session,
        turn_id: `parent-turn-${worker + 1}`, tool_use_id: `v4-spawn-${worker + 1}`,
        tool_name: 'collaborationspawn_agent',
        tool_input: { ...launch.dispatch.spawn_args, message: 'gAAAAABencrypted-v2-message' },
      }, env);
      expect(pre).toEqual({});
      const [start] = await runProcess('bin/ape-hook.mjs', {
        hook_event_name: 'SubagentStart', project_dir: value.directory, session_id: session,
        turn_id: turn, agent_id: `agent-${worker + 1}`, agent_type: 'default', model: launch.dispatch.model.model,
      }, env);
      expect(start.hookSpecificOutput?.additionalContext).toBe(codexBootstrapOrientation());
      const [bound] = await runProcess('bin/ape-hook.mjs', {
        hook_event_name: 'PreToolUse', project_dir: value.directory, session_id: session,
        turn_id: turn, tool_use_id: `v4-bind-${worker + 1}`, tool_name: 'ape_bind',
        tool_input: launch.dispatch.bootstrap_args, model: launch.dispatch.model.model,
      }, env);
      capability = /APE_RECEIPT_CAPABILITY=([A-Za-z0-9_-]{32,256})/
        .exec(bound.hookSpecificOutput?.additionalContext ?? '')?.[1];
      expect(capability).toBeTruthy();
      // Fix one *existing* schema defect between generations; the episode's
      // progress is attributable and not a fresh worker ID or changed prose.
      delete invalidFields[['status', 'tests', 'findings'][worker - 1]];
    }
    const final = draft(value.ticket, capability);
    expect((await validateReceiptForDispatch(value.directory, final)).valid).toBe(true);
    expect((await recordReceipt(value.directory, final)).ok).toBe(true);
    expect((await readJson(intentFile)).physical_worker_dispatches).toBe(4);
    expect((await readJson(value.paths.active)).receipts).toHaveLength(1);
  }, 60_000);

  it('rechecks production ownership after exact capability-draft attestation and before receipt persistence', async () => {
    const value = await fixture();
    await writeFile(path.join(value.directory, 'value.js'), 'export const value = 22;\n');
    const payload = {
      ...draft(value.ticket, value.capability, 'failed'),
      evidence: {
        summary: 'The implementation requires an independent test writer.',
        failure_kind: 'capability',
        required_claims: { required_role: 'test_writer', test_paths: ['tests/value.test.js'] },
      },
    };
    expect(await validateReceiptForDispatch(value.directory, payload)).toMatchObject({ valid: true });
    // A genuine draft attestation is not a tree-ownership exemption. Inject
    // foreign production bytes after that check, immediately before the sink.
    await writeFile(path.join(value.directory, 'foreign.js'), 'export const foreign = true;\n');
    const before = await readJson(value.paths.active);
    const result = await recordReceipt(value.directory, payload);
    expect(result).toMatchObject({ ok: false, rejected: true });
    expect(result.errors.join(' ')).toMatch(/unclaimed|attribution|boundary/i);
    const after = await readJson(value.paths.active);
    expect(after.receipts).toEqual(before.receipts);
    expect(after.tickets).toEqual(before.tickets);
  });

  it.each([2, 3])('uses the frozen three-worker four-submission contract through version %s receipt recovery launches', async (version) => {
    const config = structuredClone(DEFAULT_CONFIG);
    config.policy.max_physical_workers_per_ticket = 3;
    config.policy.max_validation_submissions_per_worker = 4;
    config.deadlines_ms.debug = 123_456;
    const executionPolicy = historicalExecutionPolicy(version, {
      max_physical_workers_per_ticket: 3, max_validation_submissions_per_worker: 4,
    }, config);
    const value = await fixture('codex', { mode: 'debug', lane: 'full', stage_id: 'debug', role: 'debugger',
      writable: false, claimed_paths: [], deadline_at: new Date(Date.now() - 1_000).toISOString(),
      execution_policy: executionPolicy });
    await atomicWriteJson(value.paths.config, { policy: { max_physical_workers_per_ticket: 1,
      max_validation_submissions_per_worker: 1 }, deadlines_ms: { debug: 10 } });
    let capability = value.capability;
    let session = 'session-1';
    let turn = undefined;
    const intentFile = path.join(value.paths.dispatchIntents, `${rawDigest(value.ticket.ticket_id)}.json`);
    for (let worker = 1; worker <= 3; worker += 1) {
      for (let submission = 1; submission <= 4; submission += 1) {
        const result = await validateReceiptForDispatch(value.directory,
          draft(value.ticket, capability, `invalid-worker-${worker}-${submission}`));
        expect(result.validation).toMatchObject({ attempt: submission, max_attempts: 4, exhausted: submission === 4 });
      }
      expect(await observeCodexSubagentStop(value.paths, await readJson(value.paths.active), {
        session_id: session, ...(turn ? { turn_id: turn } : {}),
        agent_id: `agent-${worker}`, agent_type: 'default',
      })).toMatchObject({ observed: true });
      const beforeRecovery = Date.now();
      const result = await nextRun(value.directory);
      const afterRecovery = Date.now();
      if (worker === 3) {
        expect(result).toEqual({ ok: false, reason: 'run is blocked' });
        break;
      }
      let dispatched = result.actions.find((entry) => entry.type === 'dispatch_agent');
      expect(dispatched).toMatchObject({ recovery_kind: 'redispatch_same_ticket', ticket: value.ticket });
      const intent = await readJson(intentFile);
      expect(intent).toMatchObject({ physical_worker_dispatches: worker + 1,
        receipt_validation_exhaustions: worker });
      if (version === 3) {
        expect(intent).toMatchObject({ expires_at: null, execution_policy_version: 3 });
        expect(dispatched.ticket.deadline_at).toBeNull();
        expect(intent).not.toHaveProperty('receipt_protocol_recovery');
        expect(intent).not.toHaveProperty('immutable_ticket_deadline_at');
      } else {
        expect(intent).toMatchObject({ receipt_protocol_recovery: true,
          receipt_protocol_recovery_source: { physical_worker_dispatches: worker, validation_exhaustions: worker } });
        // Historical workers retain their exact frozen allowance even after
        // the live configuration changed. The calls use separate clocks.
        expect(Date.parse(intent.expires_at)).toBeGreaterThanOrEqual(beforeRecovery + 123_456);
        expect(Date.parse(intent.expires_at)).toBeLessThanOrEqual(afterRecovery + 123_456);
      }
      session = `parent-${worker + 1}`;
      turn = `child-turn-${worker + 1}`;
      const env = { APE_HOST: 'codex', CODEX_CWD: value.directory };
      const [launch] = await runProcess('bin/ape-hook.mjs', {
        hook_event_name: 'PreToolUse', project_dir: value.directory,
        session_id: session, turn_id: `parent-turn-${worker + 1}`,
        tool_use_id: `spawn-${worker + 1}`, tool_name: 'collaborationspawn_agent',
        tool_input: { ...dispatched.dispatch.spawn_args, message: 'gAAAAABencrypted-v2-message' },
      }, env);
      expect(launch).toEqual({});
      if (worker === 1) {
        // Codex accepted the pre-tool hook but rejected the native spawn.
        // Revoke the never-bound generation, then exercise ordinary resume
        // rather than inventing a receipt or widening the frozen allowance.
        await dispatchIntents.expireClaudeIntent(value.paths, value.ticket.ticket_id);
        const resumed = await resumeRun(value.directory);
        dispatched = resumed.actions.find((entry) => entry.type === 'dispatch_agent');
        expect(dispatched.ticket).toEqual(value.ticket);
        const replacement = await readJson(intentFile);
        expect(replacement).toMatchObject({ physical_worker_dispatches: worker + 1,
          receipt_validation_exhaustions: worker, launch_generation: intent.launch_generation + 1 });
        if (version === 2) {
          expect(replacement).toMatchObject({ receipt_protocol_recovery: true,
            immutable_ticket_deadline_at: value.ticket.deadline_at,
            receipt_protocol_recovery_source: intent.receipt_protocol_recovery_source });
        }
        const [relaunched] = await runProcess('bin/ape-hook.mjs', {
          hook_event_name: 'PreToolUse', project_dir: value.directory,
          session_id: session, turn_id: `parent-turn-${worker + 1}`,
          tool_use_id: `spawn-retry-${worker + 1}`, tool_name: 'collaborationspawn_agent',
          tool_input: { ...dispatched.dispatch.spawn_args, message: 'gAAAAABencrypted-v2-message' },
        }, env);
        expect(relaunched).toEqual({});
      }
      const [start] = await runProcess('bin/ape-hook.mjs', {
        hook_event_name: 'SubagentStart', project_dir: value.directory, session_id: session, turn_id: turn,
        agent_id: `agent-${worker + 1}`, agent_type: 'default', model: dispatched.dispatch.model.model,
      }, env);
      expect(start.hookSpecificOutput?.additionalContext).toBe(codexBootstrapOrientation());
      const [bootstrap] = await runProcess('bin/ape-hook.mjs', {
        hook_event_name: 'PreToolUse', project_dir: value.directory, session_id: session, turn_id: turn,
        tool_use_id: `bind-${worker + 1}`, tool_name: 'ape_bind',
        tool_input: dispatched.dispatch.bootstrap_args, model: dispatched.dispatch.model.model,
      }, env);
      capability = /APE_RECEIPT_CAPABILITY=([A-Za-z0-9_-]{32,256})/
        .exec(bootstrap.hookSpecificOutput?.additionalContext ?? '')?.[1];
      expect(capability).toBeTruthy();
    }
    const blocked = await readJson(value.paths.active);
    expect(blocked).toMatchObject({ status: 'blocked',
      receipt_contract_exhaustions: { [value.ticket.ticket_id]: 3 },
      orchestration: { receipt_record_attempts: 12, receipt_rejections: 12, protocol_redispatches: 2 } });
    expect(blocked.tickets).toEqual([value.ticket]);
    expect((await readJson(intentFile)).physical_worker_dispatches).toBe(3);
  }, 30_000);

  it('limits contract-v1 normalization to value-preserving JSON canonicalization', () => {
    const semanticRewriteCandidates = {
      ticket_id: 'ticket-normalization-v1',
      status: 'success',
      tests: { command: 'npm test', passed: true, exit_code: 0, duration_ms: 1 },
      findings: 'one finding',
      evidence: [{ summary: 'one evidence object' }],
    };
    const normalized = normalizeReceiptInput(semanticRewriteCandidates, {
      receipt_contract_version: 1,
    });
    expect(normalized).toEqual({
      input: semanticRewriteCandidates,
      normalized_fields: [],
      correction_deltas: [],
    });

    const canonicalA = {
      ticket_id: 'ticket-canonical-v1',
      status: 'passed',
      tests: [{ command: 'npm test', passed: true, exit_code: 0, duration_ms: -0 }],
      findings: [],
      evidence: { z: 1, a: 2 },
    };
    const canonicalB = {
      evidence: { a: 2, z: 1 },
      findings: [],
      tests: [{ duration_ms: 0, exit_code: 0, passed: true, command: 'npm test' }],
      status: 'passed',
      ticket_id: 'ticket-canonical-v1',
    };
    expect(receiptInputHash(canonicalA)).toBe(receiptInputHash(canonicalB));
  });

  it('preserves every contract-v1 semantic edge instead of trimming, wrapping, dropping, or reordering it', () => {
    const candidates = [
      {
        ticket_id: 'ticket-whitespace-v1',
        status: 'passed',
        tests: [],
        findings: [],
        evidence: { verdict: ' agree ', summary: '  exact evidence bytes  ' },
      },
      {
        ticket_id: 'ticket-null-v1',
        status: 'passed',
        tests: [{ command: 'npm test', passed: true, exit_code: 0, duration_ms: 1, output_hash: null }],
        findings: [],
        evidence: {},
      },
      {
        ticket_id: 'ticket-singletons-v1',
        status: 'passed',
        tests: { command: 'npm test', passed: true, exit_code: 0, duration_ms: 1 },
        findings: { id: 'finding-one' },
        evidence: ['not-an-object'],
      },
      {
        ticket_id: 'ticket-order-v1',
        status: 'passed',
        tests: [
          { command: 'npm run first', passed: true, exit_code: 0, duration_ms: 1 },
          { command: 'npm run second', passed: false, exit_code: 1, duration_ms: 2 },
        ],
        findings: [{ id: 'first' }, { id: 'second' }],
        evidence: { paths: ['b.js', 'a.js'] },
      },
    ];

    for (const candidate of candidates) {
      const normalized = normalizeReceiptInput(candidate, { receipt_contract_version: 1 });
      expect(normalized).toEqual({
        input: candidate,
        normalized_fields: [],
        correction_deltas: [],
      });
      expect(normalized.input).toBe(candidate);
    }
  });

  it('hashes only JSON-representation equivalents together and keeps semantic differences distinct', () => {
    const base = {
      ticket_id: 'ticket-hash-semantics-v1',
      status: 'passed',
      tests: [
        { command: 'npm run first', passed: true, exit_code: 0, duration_ms: 1 },
        { command: 'npm run second', passed: true, exit_code: 0, duration_ms: 2 },
      ],
      findings: [{ id: 'first' }, { id: 'second' }],
      evidence: { verdict: 'agree', summary: 'exact' },
    };
    const semanticVariants = [
      { ...base, status: 'success' },
      { ...base, evidence: { ...base.evidence, summary: ' exact ' } },
      { ...base, tests: [...base.tests].reverse() },
      { ...base, findings: [...base.findings].reverse() },
      { ...base, evidence: { ...base.evidence, verdict: 'AGREE' } },
    ];
    for (const variant of semanticVariants) {
      expect(receiptInputHash(variant)).not.toBe(receiptInputHash(base));
    }

    expect(receiptInputHash({ ...base, evidence: { summary: 'exact', verdict: 'agree' } }))
      .toBe(receiptInputHash(base));
  });

  it('returns exact bounded correction deltas without changing agent evidence', async () => {
    const value = await fixture();
    const invalid = {
      ...draft(value.ticket, value.capability),
      status: 'success',
      tests: 'not-an-array',
      extra_worker_note: 'remove only this unknown field',
      evidence: { summary: '  preserve these exact bytes  ' },
    };
    const result = await validateReceiptForDispatch(
      value.directory,
      invalid,
      value.ticket.ticket_id,
    );

    expect(result).toMatchObject({
      valid: false,
      correction_deltas: [
        {
          field: 'status',
          current_value: 'success',
          required_value: 'passed',
          operation: 'replace',
        },
        {
          field: 'extra_worker_note',
          current_value: 'remove only this unknown field',
          operation: 'remove',
        },
      ],
    });
    expect(result).not.toHaveProperty('normalized_draft');
    expect(invalid.evidence.summary).toBe('  preserve these exact bytes  ');
    expect(result.corrections).toContainEqual(expect.objectContaining({ field: 'tests' }));
    expect(result.correction_deltas).not.toContainEqual(
      expect.objectContaining({ field: 'tests' }),
    );
    expect(result.correction_deltas).not.toContainEqual(expect.objectContaining({
      required_value: expect.stringMatching(/^(?:set|use|provide|revise|include|return)\b/i),
    }));
    expect(result.correction_deltas.length).toBeLessThanOrEqual(20);
    expect(Buffer.byteLength(JSON.stringify(result.correction_deltas), 'utf8'))
      .toBeLessThanOrEqual(12_000);
  });

  it('does not reflect a bearer copied anywhere in an invalid public draft', async () => {
    const cases = [
      (value) => ({
        ...draft(value.ticket, value.capability),
        [`unknown_${value.capability}`]: 'remove this field',
      }),
      (value) => ({
        ...draft(value.ticket, value.capability),
        status: `invalid:${value.capability}`,
      }),
      (value) => ({
        ...draft(value.ticket, value.capability),
        ticket_id: `invalid:${value.capability}`,
      }),
      (value) => ({
        ...draft(value.ticket, value.capability),
        extra_worker_note: {
          nested_value: `copied:${value.capability}`,
        },
      }),
      (value) => ({
        ...draft(value.ticket, value.capability),
        extra_worker_note: {
          [`nested_${value.capability}`]: 'copied key',
        },
      }),
    ];

    for (const invalidDraft of cases) {
      const value = await fixture();
      const invalid = invalidDraft(value);
      const result = await validateReceiptForDispatch(
        value.directory,
        invalid,
        value.ticket.ticket_id,
      );

      expect(result.valid).not.toBe(true);
      expect(JSON.stringify(result)).not.toContain(value.capability);
      expect(result.correction_deltas ?? []).not.toContainEqual(
        expect.objectContaining({ field: expect.stringContaining(value.capability) }),
      );
    }
  });

  it('redacts the bearer from unsafe-input errors before MCP serialization', async () => {
    const value = await fixture();
    const invalid = {
      ...draft(value.ticket, value.capability),
      [`${value.capability}.constructor`]: 'forbidden dotted key',
    };
    const responses = await runProcess('bin/ape-mcp.mjs', {
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: {
        name: 'ape_validate_receipt',
        arguments: {
          project_dir: value.directory,
          ticket_id: value.ticket.ticket_id,
          draft: invalid,
        },
      },
    });

    expect(responses[0].result.isError).toBe(true);
    expect(responses[0].result.content[0].text).toContain('unsafe prototype key');
    expect(JSON.stringify(responses[0])).not.toContain(value.capability);
  });

  it('redacts copied bearers from stop, pre-submit, record, and task correction/error channels', async () => {
    const stoppedValue = await fixture();
    const stoppedDraft = {
      ...draft(stoppedValue.ticket, stoppedValue.capability),
      [`unknown_${stoppedValue.capability}`]: {
        nested: `copied:${stoppedValue.capability}`,
      },
      [`${stoppedValue.capability}.constructor`]: 'unsafe dotted key',
    };
    const [stopped] = await runProcess('bin/ape-hook.mjs', {
      hook_event_name: 'SubagentStop',
      project_dir: stoppedValue.directory,
      session_id: 'session-1',
      agent_id: 'agent-1',
      agent_type: 'default',
      is_subagent: true,
      last_assistant_message: JSON.stringify(stoppedDraft),
    }, { APE_HOST: 'codex', CODEX_CWD: stoppedValue.directory });
    expect(stopped).toMatchObject({ decision: 'block' });
    expect(JSON.stringify(stopped)).not.toContain(stoppedValue.capability);
    // Structural rejection precedes reflective field diagnostics: the copied
    // bearer is never echoed, so this path needs no redaction placeholder.
    expect(stopped.reason).toContain('receipt contains a forbidden prototype key');

    const preSubmitValue = await fixture('claude');
    const preSubmitDraft = {
      ...draft(preSubmitValue.ticket, preSubmitValue.capability),
      extra_worker_note: { nested: `copied:${preSubmitValue.capability}` },
    };
    const [preSubmit] = await runProcess('bin/ape-hook.mjs', {
      hook_event_name: 'PreToolUse',
      project_dir: preSubmitValue.directory,
      session_id: 'session-1',
      agent_id: 'agent-1',
      agent_type: 'implementer',
      tool_name: 'mcp__ape__ape_validate_receipt',
      tool_input: {
        ticket_id: preSubmitValue.ticket.ticket_id,
        draft: preSubmitDraft,
      },
    }, { APE_HOST: 'claude', CLAUDECODE: '1' });
    expect(preSubmit).toEqual({ hookSpecificOutput: {
      hookEventName: 'PreToolUse', additionalContext: expect.any(String),
    } });
    expect(JSON.stringify(preSubmit)).not.toContain(preSubmitValue.capability);

    const recordValue = await fixture();
    const recordDraft = {
      ...draft(recordValue.ticket, recordValue.capability),
      extra_worker_note: {
        nested_value: `copied:${recordValue.capability}`,
        [`nested_${recordValue.capability}`]: 'copied key',
      },
    };
    const recorded = await recordReceipt(recordValue.directory, recordDraft);
    expect(recorded).toMatchObject({ ok: false, rejected: true });
    expect(JSON.stringify(recorded)).not.toContain(recordValue.capability);

    const taskValue = await fixture();
    const taskDraft = {
      ...draft(taskValue.ticket, taskValue.capability),
      extra_worker_note: { nested: `copied:${taskValue.capability}` },
    };
    const taskResult = await executeApeRunTaskOperation(taskValue.directory, {
      operationId: `op-${'B'.repeat(43)}`,
      action: 'record',
      expectedRunId: taskValue.state.run_id,
      request: { action: 'record', receipt: taskDraft },
    });
    expect(JSON.stringify(taskResult)).not.toContain(taskValue.capability);

    const unsafeValue = await fixture();
    const unsafeDraft = {
      ...draft(unsafeValue.ticket, unsafeValue.capability),
      [`${unsafeValue.capability}.constructor`]: 'unsafe dotted key',
    };
    const responses = await runProcess('bin/ape-mcp.mjs', {
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: {
        name: 'ape_run',
        arguments: {
          action: 'record',
          project_dir: unsafeValue.directory,
          receipt: unsafeDraft,
        },
      },
    });
    expect(responses[0].result.isError).toBe(true);
    expect(responses[0].result.content[0].text).toContain('unsafe prototype key');
    expect(JSON.stringify(responses[0])).not.toContain(unsafeValue.capability);
  });

  it('redacts authenticated stop-validation results before ordinary and exhausted intent persistence', async () => {
    const value = await fixture();
    const invalid = {
      ...draft(value.ticket, value.capability),
      [`unknown_${value.capability}`]: {
        nested_value: `copied:${value.capability}`,
        [`nested_${value.capability}`]: 'copied key',
      },
    };
    const stop = {
      hook_event_name: 'SubagentStop',
      project_dir: value.directory,
      session_id: 'session-1',
      agent_id: 'agent-1',
      agent_type: 'default',
      is_subagent: true,
      last_assistant_message: JSON.stringify(invalid),
    };
    const intentFile = path.join(
      value.paths.dispatchIntents,
      `${rawDigest(value.ticket.ticket_id)}.json`,
    );

    const [first] = await runProcess(
      'bin/ape-hook.mjs',
      stop,
      { APE_HOST: 'codex', CODEX_CWD: value.directory },
    );
    expect(first).toMatchObject({ decision: 'block' });
    expect(JSON.stringify(first)).not.toContain(value.capability);
    expect(JSON.stringify(first)).toContain('[receipt-capability-redacted]');

    const firstIntent = await readJson(intentFile, null);
    expect(firstIntent).toMatchObject({
      status: 'bound',
      validation_attempts: 1,
      valid_draft_observed: false,
      receipt_validation: {
        attempts: 1,
        invalid_attempts: 1,
        exhausted: false,
        last_result: {
          valid: false,
          corrections: expect.arrayContaining([
            expect.objectContaining({
              field: expect.stringContaining('[receipt-capability-redacted]'),
            }),
          ]),
        },
      },
    });
    expect(JSON.stringify(firstIntent)).not.toContain(value.capability);
    expect(firstIntent).not.toHaveProperty('agent_stopped_at');

    const firstAttestation = await readDispatchReceiptAttestation(
      value.paths,
      value.ticket.ticket_id,
      receiptInputHash(invalid),
      value.capability,
      {
        contract_version: 1,
        ticket_hash: value.ticket.ticket_hash,
        output_schema_hash: value.ticket.capability_manifest.receipt_schema.hash,
      },
    );
    expect(firstAttestation).toMatchObject({
      valid: false,
      validation: {
        attempt: 1,
        corrections_remaining: 2,
        exhausted: false,
        next_action: { kind: 'continue_same_agent' },
      },
    });

    const [second] = await runProcess(
      'bin/ape-hook.mjs',
      stop,
      { APE_HOST: 'codex', CODEX_CWD: value.directory },
    );
    expect(second).toMatchObject({ decision: 'block' });
    expect(JSON.stringify(second)).not.toContain(value.capability);

    const [third] = await runProcess(
      'bin/ape-hook.mjs',
      stop,
      { APE_HOST: 'codex', CODEX_CWD: value.directory },
    );
    expect(third).toEqual({});

    const exhaustedIntent = await readJson(intentFile, null);
    expect(exhaustedIntent).toMatchObject({
      status: 'bound',
      validation_attempts: 3,
      valid_draft_observed: false,
      receipt_validation_exhaustions: 1,
      agent_stopped_at: expect.any(String),
      receipt_validation: {
        attempts: 3,
        invalid_attempts: 3,
        exhausted: true,
        exhaustion_count: 1,
        last_result: {
          valid: false,
          corrections: expect.arrayContaining([
            expect.objectContaining({
              field: expect.stringContaining('[receipt-capability-redacted]'),
            }),
          ]),
        },
      },
    });
    expect(JSON.stringify(exhaustedIntent)).not.toContain(value.capability);
  });

  it('uses dispatch authority rather than a missing, non-string, or substituted draft field', async () => {
    const withoutCanonical = (value) => {
      const invalid = {
        ...draft(value.ticket, value.capability),
        extra_worker_note: { nested: `copied:${value.capability}` },
      };
      delete invalid.receipt_capability;
      return invalid;
    };
    const withNonStringCanonical = (value) => ({
      ...draft(value.ticket, value.capability),
      receipt_capability: 7,
      extra_worker_note: { nested: `copied:${value.capability}` },
    });
    const withSubstitutedCanonical = (value) => ({
      ...draft(value.ticket, value.capability),
      receipt_capability: 'substituted-capability-value-1234567890',
      extra_worker_note: { nested: `copied:${value.capability}` },
    });

    const stoppedValue = await fixture();
    const [stopped] = await runProcess('bin/ape-hook.mjs', {
      hook_event_name: 'SubagentStop',
      project_dir: stoppedValue.directory,
      session_id: 'session-1',
      agent_id: 'agent-1',
      agent_type: 'default',
      is_subagent: true,
      last_assistant_message: JSON.stringify(withoutCanonical(stoppedValue)),
    }, { APE_HOST: 'codex', CODEX_CWD: stoppedValue.directory });
    expect(stopped).toMatchObject({ decision: 'block' });
    expect(JSON.stringify(stopped)).not.toContain(stoppedValue.capability);
    const stoppedIntent = await readJson(path.join(
      stoppedValue.paths.dispatchIntents,
      `${rawDigest(stoppedValue.ticket.ticket_id)}.json`,
    ));
    expect(JSON.stringify(stoppedIntent)).not.toContain(stoppedValue.capability);

    const preSubmitValue = await fixture('claude');
    const [preSubmit] = await runProcess('bin/ape-hook.mjs', {
      hook_event_name: 'PreToolUse',
      project_dir: preSubmitValue.directory,
      session_id: 'session-1',
      agent_id: 'agent-1',
      agent_type: 'implementer',
      tool_name: 'mcp__ape__ape_validate_receipt',
      tool_input: {
        ticket_id: preSubmitValue.ticket.ticket_id,
        draft: withSubstitutedCanonical(preSubmitValue),
      },
    }, { APE_HOST: 'claude', CLAUDECODE: '1' });
    expect(preSubmit).toEqual({ hookSpecificOutput: {
      hookEventName: 'PreToolUse', additionalContext: expect.any(String),
    } });
    expect(JSON.stringify(preSubmit)).not.toContain(preSubmitValue.capability);

    const validationValue = await fixture();
    const validation = await validateReceiptForDispatch(
      validationValue.directory,
      withNonStringCanonical(validationValue),
      validationValue.ticket.ticket_id,
    );
    expect(validation).toMatchObject({ ok: false, rejected: true, valid: false });
    expect(JSON.stringify(validation)).not.toContain(validationValue.capability);

    const recordValue = await fixture();
    const recorded = await recordReceipt(recordValue.directory, withoutCanonical(recordValue));
    expect(recorded).toMatchObject({ ok: false, rejected: true });
    expect(JSON.stringify(recorded)).not.toContain(recordValue.capability);

    const recoveryValue = await fixture();
    const recovered = await recoverReceipt(
      recoveryValue.directory,
      withSubstitutedCanonical(recoveryValue),
      { receipt_input_hash: 'a'.repeat(64), reason: 'recover the exact stopped draft' },
    );
    expect(recovered).toMatchObject({ ok: false, rejected: true });
    expect(JSON.stringify(recovered)).not.toContain(recoveryValue.capability);

    const taskValue = await fixture();
    const taskResult = await executeApeRunTaskOperation(taskValue.directory, {
      operationId: `op-${'C'.repeat(43)}`,
      action: 'record',
      expectedRunId: taskValue.state.run_id,
      request: { action: 'record', receipt: withoutCanonical(taskValue) },
    });
    expect(JSON.stringify(taskResult)).not.toContain(taskValue.capability);

    const mcpValue = await fixture();
    const mcpDraft = withNonStringCanonical(mcpValue);
    mcpDraft[`${mcpValue.capability}.constructor`] = 'unsafe copied bearer key';
    const responses = await runProcess('bin/ape-mcp.mjs', {
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: {
        name: 'ape_run',
        arguments: {
          action: 'record',
          project_dir: mcpValue.directory,
          receipt: mcpDraft,
        },
      },
    });
    expect(JSON.stringify(responses[0])).not.toContain(mcpValue.capability);
  });

  it('returns canonical corrections from the real MCP validation tool', async () => {
    const value = await fixture();
    const responses = await runProcess('bin/ape-mcp.mjs', {
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: {
        name: 'ape_validate_receipt',
        arguments: {
          project_dir: value.directory,
          ticket_id: value.ticket.ticket_id,
          draft: draft(value.ticket, value.capability, 'not-a-status'),
        },
      },
    });
    const payload = JSON.parse(responses[0].result.content[0].text);
    expect(responses[0].result.content[0].text).not.toContain(value.capability);
    expect(payload).not.toHaveProperty('normalized_draft');
    expect(payload).toMatchObject({
      ok: true,
      valid: false,
      validation: { attempt: 1, max_attempts: 3, exhausted: false },
      failure_domain: 'orchestration',
      next_action: { kind: 'continue_same_agent', failure_domain: 'orchestration' },
    });
    expect(payload.validation.next_action).toEqual({ kind: 'continue_same_agent' });
    expect(payload.corrections).toContainEqual(expect.objectContaining({ field: 'status' }));
  });

  it('charges each identical malformed MCP submission and reaches bounded exhaustion', async () => {
    const value = await fixture();
    const invalid = draft(value.ticket, value.capability, 'same-invalid-status');
    const call = (id) => ({
      jsonrpc: '2.0',
      id,
      method: 'tools/call',
      params: {
        name: 'ape_validate_receipt',
        arguments: {
          project_dir: value.directory,
          ticket_id: value.ticket.ticket_id,
          draft: invalid,
        },
      },
    });
    const responses = await runProcess('bin/ape-mcp.mjs', [call(1), call(2), call(3)]);
    const payloads = responses.map((response) =>
      JSON.parse(response.result.content[0].text));

    expect(payloads.map((payload) => payload.validation.attempt)).toEqual([1, 2, 3]);
    expect(payloads.slice(0, 2)).toEqual([
      expect.objectContaining({
        valid: false,
        idempotent: false,
        next_action: { kind: 'continue_same_agent', failure_domain: 'orchestration' },
      }),
      expect.objectContaining({
        valid: false,
        idempotent: false,
        next_action: { kind: 'continue_same_agent', failure_domain: 'orchestration' },
      }),
    ]);
    expect(payloads[2]).toMatchObject({
      valid: false,
      idempotent: false,
      recovery_kind: 'receipt_validation_exhausted',
      validation: { attempt: 3, max_attempts: 3, exhausted: true },
      next_action: {
        kind: 'redispatch_same_ticket',
        ticket_id: value.ticket.ticket_id,
      },
    });
    expect(await readJson(
      path.join(value.paths.dispatchIntents, `${rawDigest(value.ticket.ticket_id)}.json`),
      null,
    )).toMatchObject({
      validation_attempts: 3,
      receipt_validation_exhaustions: 1,
      receipt_validation: {
        attempts: 3,
        exhausted: true,
        last_input_hash: receiptInputHash(invalid),
      },
    });
  });

  it('binds an exact-draft attestation and safely replays its successful MCP response', async () => {
    const value = await fixture();
    const exactDraft = draft(value.ticket, value.capability);
    const call = (id) => ({
      jsonrpc: '2.0',
      id,
      method: 'tools/call',
      params: {
        name: 'ape_validate_receipt',
        arguments: {
          project_dir: value.directory,
          ticket_id: value.ticket.ticket_id,
          draft: exactDraft,
        },
      },
    });
    const responses = await runProcess('bin/ape-mcp.mjs', [call(1), call(2)]);
    const first = JSON.parse(responses[0].result.content[0].text);
    const replay = JSON.parse(responses[1].result.content[0].text);
    expect(responses[0].result.content[0].text).not.toContain(value.capability);
    expect(responses[1].result.content[0].text).not.toContain(value.capability);
    expect(first).toMatchObject({
      ok: true,
      valid: true,
      attested: true,
      validation_performed: true,
      idempotent: false,
      validation: { attempt: 1 },
    });
    expect(replay).toMatchObject({
      ok: true,
      valid: true,
      attested: true,
      validation_performed: false,
      idempotent: true,
      validation: { attempt: 1 },
    });
    expect(first).not.toHaveProperty('next_action');
    expect(first).not.toHaveProperty('normalized_draft');
    expect(first.validation).not.toHaveProperty('next_action');
    expect(replay).not.toHaveProperty('next_action');
    expect(replay).not.toHaveProperty('normalized_draft');
    expect(replay.validation).not.toHaveProperty('next_action');

    const binding = {
      contract_version: 1,
      ticket_hash: value.ticket.ticket_hash,
      output_schema_hash: value.ticket.capability_manifest.receipt_schema.hash,
    };
    const exactHash = receiptInputHash(exactDraft);
    expect(await readDispatchReceiptAttestation(
      value.paths,
      value.ticket.ticket_id,
      exactHash,
      value.capability,
      binding,
    )).toMatchObject({
      valid: true,
      attested_contract_version: 1,
      attested_ticket_hash: value.ticket.ticket_hash,
      attested_output_schema_hash: binding.output_schema_hash,
    });

    const modified = structuredClone(exactDraft);
    modified.evidence.summary = 'changed after validation';
    expect((await readDispatchReceiptAttestation(
      value.paths,
      value.ticket.ticket_id,
      receiptInputHash(modified),
      value.capability,
      binding,
    )).valid).toBe(false);

    const intentFile = path.join(
      value.paths.dispatchIntents,
      `${rawDigest(value.ticket.ticket_id)}.json`,
    );
    const intent = await readJson(intentFile, null);
    await atomicWriteJson(intentFile, {
      ...intent,
      receipt_validation: {
        ...intent.receipt_validation,
        attested_output_schema_hash: '0'.repeat(64),
      },
    });
    expect((await readDispatchReceiptAttestation(
      value.paths,
      value.ticket.ticket_id,
      exactHash,
      value.capability,
      binding,
    )).valid).toBe(false);
  });

  it('audits an exact stopped-dispatch operator recovery without weakening receipt validation', async () => {
    const stoppedAt = new Date().toISOString();
    const value = await fixture('codex', { agent_stopped_at: stoppedAt });
    const exactDraft = draft(value.ticket, value.capability);

    // The normal worker-owned path remains closed and gives the operator the
    // exact normalized hash it must explicitly confirm on the emergency path.
    const ordinary = await recordReceipt(value.directory, exactDraft);
    expect(ordinary).toMatchObject({
      ok: false,
      rejected: true,
      input_hash: receiptInputHash(exactDraft),
      errors: [expect.stringMatching(/not pre-validated and attested byte-for-byte/i)],
    });

    const reason = 'validator schema was absent from this bound worker tool surface';
    const recovered = await recoverReceipt(value.directory, exactDraft, {
      receipt_input_hash: ordinary.input_hash,
      reason,
    });
    expect(recovered).toMatchObject({
      ok: true,
      recovered: 'operator-receipt',
      operator_recovery: {
        ticket_id: value.ticket.ticket_id,
        receipt_input_hash: ordinary.input_hash,
        dispatch_identity_hash: expect.stringMatching(/^[0-9a-f]{64}$/),
        worker_attestation: 'operator-waived',
        validation: 'runtime-revalidated',
      },
      receipt: {
        ticket_id: value.ticket.ticket_id,
        agent: { identity: 'agent-1' },
        evidence: {
          operator_receipt_recovery: {
            version: 1,
            reason,
            receipt_input_hash: ordinary.input_hash,
            dispatch_identity_hash: expect.stringMatching(/^[0-9a-f]{64}$/),
            dispatch: {
              host: 'codex',
              run_id: value.state.run_id,
              ticket_id: value.ticket.ticket_id,
              ticket_hash: value.ticket.ticket_hash,
              session_id: 'session-1',
              agent_id: 'agent-1',
              worker_stopped_at: stoppedAt,
              physical_worker_dispatches: 1,
            },
            validation: {
              draft_contract: 'runtime-revalidated',
              authoritative_admission: 'runtime-validated',
              worker_attestation: 'operator-waived',
            },
          },
        },
      },
    });
    // A waiver is not counted as worker validation success.
    expect(recovered.run.orchestration).toMatchObject({
      receipt_accepts: 0,
      receipt_first_pass_accepts: 0,
    });

    const intent = await readJson(
      path.join(value.paths.dispatchIntents, `${rawDigest(value.ticket.ticket_id)}.json`),
      null,
    );
    expect(intent).toMatchObject({
      status: 'completed',
      bound_session_id: 'session-1',
      bound_agent_id: 'agent-1',
      receipt_input_hash: ordinary.input_hash,
      receipt_recording: {
        mode: 'operator-recovery',
        reason,
        receipt_input_hash: ordinary.input_hash,
        worker_attestation: 'operator-waived',
        validation: 'runtime-revalidated',
      },
    });

    const audit = (await readFile(value.paths.overrideLog, 'utf8'))
      .trim().split('\n').map((line) => JSON.parse(line))
      .filter((entry) => entry.operation === 'recover-receipt');
    expect(audit).toEqual([expect.objectContaining({
      run_id: value.state.run_id,
      ticket_id: value.ticket.ticket_id,
      ticket_hash: value.ticket.ticket_hash,
      receipt_id: recovered.receipt.receipt_id,
      receipt_hash: recovered.receipt.receipt_hash,
      receipt_input_hash: ordinary.input_hash,
      dispatch_identity_hash:
        recovered.receipt.evidence.operator_receipt_recovery.dispatch_identity_hash,
      host: 'codex',
      session_id: 'session-1',
      agent_id: 'agent-1',
      physical_worker_dispatches: 1,
      worker_attestation: 'operator-waived',
      validation: 'runtime-revalidated',
      reason,
    })]);

    // An identical replay stays content-addressed and does not duplicate the
    // override-class audit record.
    const replay = await recoverReceipt(value.directory, exactDraft, {
      receipt_input_hash: ordinary.input_hash,
      reason,
    });
    expect(replay).toMatchObject({ ok: true, idempotent: true });
    expect((await readFile(value.paths.overrideLog, 'utf8')).trim().split('\n')).toHaveLength(1);
  });

  it('executes recover-receipt through the durable task-operation schema and action branch', async () => {
    const value = await fixture('codex', { agent_stopped_at: new Date().toISOString() });
    const exactDraft = draft(value.ticket, value.capability);
    const inputHash = receiptInputHash(exactDraft);
    const result = await executeApeRunTaskOperation(value.directory, {
      operationId: `op-${'R'.repeat(43)}`,
      action: 'recover-receipt',
      expectedRunId: value.state.run_id,
      request: {
        action: 'recover-receipt',
        receipt: exactDraft,
        receipt_input_hash: inputHash,
        reason: 'task-wrapped validator provisioning recovery',
      },
    });

    expect(result).toMatchObject({
      ok: true,
      recovered: 'operator-receipt',
      operator_recovery: { receipt_input_hash: inputHash },
    });
    const taskTransactions = await readdir(
      path.join(value.paths.runtime, 'task-operation-transactions'),
    );
    expect(taskTransactions.filter((name) => name.endsWith('.json'))).toHaveLength(1);
  });

  it('preserves recover-receipt validation when a task operation omits recovery fields', async () => {
    const value = await fixture('codex', { agent_stopped_at: new Date().toISOString() });
    const result = await executeApeRunTaskOperation(value.directory, {
      operationId: `op-${'O'.repeat(43)}`,
      action: 'recover-receipt',
      expectedRunId: value.state.run_id,
      request: {
        action: 'recover-receipt',
        receipt: draft(value.ticket, value.capability),
      },
    });

    expect(result).toEqual({
      task_tool_error: 'recover-receipt requires a nonblank audit reason',
    });
    expect(result.task_tool_error).not.toMatch(/unsupported undefined data/iu);
  });

  it('fails operator recovery closed on a wrong hash, live worker, invalid draft, or missing reason', async () => {
    const value = await fixture();
    const exactDraft = draft(value.ticket, value.capability);
    const exactHash = receiptInputHash(exactDraft);

    await expect(recoverReceipt(value.directory, exactDraft, {
      receipt_input_hash: exactHash,
      reason: '   ',
    })).rejects.toThrow(/nonblank audit reason/i);

    expect(await recoverReceipt(value.directory, exactDraft, {
      receipt_input_hash: '0'.repeat(64),
      reason: 'confirm a deliberately mismatched draft',
    })).toMatchObject({
      ok: false,
      rejected: true,
      actual_receipt_input_hash: exactHash,
      failure_domain: 'operator',
    });

    expect(await recoverReceipt(value.directory, exactDraft, {
      receipt_input_hash: exactHash,
      reason: 'worker has not stopped',
    })).toMatchObject({
      ok: false,
      rejected: true,
      errors: [expect.stringMatching(/host-observed stop/i)],
    });

    const intentFile = path.join(
      value.paths.dispatchIntents,
      `${rawDigest(value.ticket.ticket_id)}.json`,
    );
    await atomicWriteJson(intentFile, {
      ...await readJson(intentFile, null),
      agent_stopped_at: new Date().toISOString(),
    });
    const invalid = draft(value.ticket, value.capability, 'invalid-status');
    expect(await recoverReceipt(value.directory, invalid, {
      receipt_input_hash: receiptInputHash(invalid),
      reason: 'invalid drafts must remain invalid',
    })).toMatchObject({
      ok: false,
      rejected: true,
      corrections: expect.arrayContaining([
        expect.objectContaining({ field: 'status' }),
      ]),
    });

    expect(await readdir(value.paths.receipts).catch((error) =>
      error?.code === 'ENOENT' ? [] : Promise.reject(error))).toEqual([]);
    expect(await readdir(value.paths.receiptTransactions).catch((error) =>
      error?.code === 'ENOENT' ? [] : Promise.reject(error))).toEqual([]);
    await expect(readFile(value.paths.overrideLog, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('refuses operator recovery for an already worker-attested draft and reserves its audit field', async () => {
    const value = await fixture('codex', { agent_stopped_at: new Date().toISOString() });
    const spoofed = {
      ...draft(value.ticket, value.capability),
      evidence: {
        summary: 'complete',
        operator_receipt_recovery: { reason: 'worker-authored spoof' },
      },
    };
    const spoofedValidation = await validateReceiptForDispatch(
      value.directory,
      spoofed,
      value.ticket.ticket_id,
    );
    expect(spoofedValidation).toMatchObject({
      valid: false,
      corrections: [expect.objectContaining({
        field: 'evidence.operator_receipt_recovery',
      })],
    });

    const exactDraft = draft(value.ticket, value.capability);
    expect(await validateReceiptForDispatch(
      value.directory,
      exactDraft,
      value.ticket.ticket_id,
    )).toMatchObject({ valid: true, attested: true });
    expect(await recoverReceipt(value.directory, exactDraft, {
      receipt_input_hash: receiptInputHash(exactDraft),
      reason: 'an attested draft does not need operator recovery',
    })).toMatchObject({
      ok: false,
      rejected: true,
      errors: [expect.stringMatching(/already has an exact worker attestation/i)],
      next_action: { required_control_action: 'record_exact_attested_receipt' },
    });
    await expect(readFile(value.paths.overrideLog, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('archives a valid draft replacement as non-first-pass without inventing a rejection', async () => {
    const value = await fixture();
    const timestampedDraft = {
      ...draft(value.ticket, value.capability),
      timing: {
        started_at: value.ticket.issued_at,
        completed_at: value.ticket.issued_at,
        duration_ms: 0,
      },
    };
    const finalDraft = draft(value.ticket, value.capability);

    const first = await validateReceiptForDispatch(
      value.directory,
      timestampedDraft,
      value.ticket.ticket_id,
    );
    const second = await validateReceiptForDispatch(
      value.directory,
      finalDraft,
      value.ticket.ticket_id,
    );
    expect(first).toMatchObject({
      valid: true,
      validation: {
        attempt: 1,
        invalid_attempts: 0,
        first_validation_valid: true,
      },
    });
    expect(second).toMatchObject({
      valid: true,
      validation: {
        attempt: 2,
        invalid_attempts: 0,
        first_validation_valid: true,
      },
    });
    expect(first).not.toHaveProperty('next_action');
    expect(first.validation).not.toHaveProperty('next_action');
    expect(second).not.toHaveProperty('next_action');
    expect(second.validation).not.toHaveProperty('next_action');
    expect(second.input_hash).not.toBe(first.input_hash);

    const recorded = await recordReceipt(value.directory, finalDraft);
    expect(recorded.receipt.timing).toMatchObject({
      started_at: value.ticket.issued_at,
      completed_at: expect.any(String),
      duration_ms: expect.any(Number),
    });
    expect(recorded.receipt.timing.duration_ms).toBeGreaterThanOrEqual(0);
    expect(recorded.run.orchestration).toMatchObject({
      receipt_record_attempts: 2,
      receipt_accepts: 1,
      receipt_first_pass_accepts: 0,
      receipt_rejections: 0,
      receipt_rejections_by_class: { contract: 0 },
    });
    expect(await readJson(
      path.join(value.paths.dispatchIntents, `${rawDigest(value.ticket.ticket_id)}.json`),
      null,
    )).toMatchObject({
      receipt_validation: {
        attempts: 2,
        invalid_attempts: 0,
        first_validation_valid: true,
      },
    });
  });

  it('counts only actually invalid validations as contract rejections', async () => {
    const value = await fixture();
    const invalidDraft = draft(value.ticket, value.capability, 'invalid-status');
    const finalDraft = draft(value.ticket, value.capability);

    expect(await validateReceiptForDispatch(
      value.directory,
      invalidDraft,
      value.ticket.ticket_id,
    )).toMatchObject({
      valid: false,
      validation: {
        attempt: 1,
        invalid_attempts: 1,
        first_validation_valid: false,
      },
    });
    expect(await validateReceiptForDispatch(
      value.directory,
      finalDraft,
      value.ticket.ticket_id,
    )).toMatchObject({
      valid: true,
      validation: {
        attempt: 2,
        invalid_attempts: 1,
        first_validation_valid: false,
      },
    });

    const recorded = await recordReceipt(value.directory, finalDraft);
    expect(recorded.run.orchestration).toMatchObject({
      receipt_record_attempts: 2,
      receipt_accepts: 1,
      receipt_first_pass_accepts: 0,
      receipt_rejections: 1,
      receipt_rejections_by_class: { contract: 1 },
    });
  });

  it('does not recount an exhausted physical summary when its earlier valid attestation records', async () => {
    const value = await fixture();
    const attestedDraft = draft(value.ticket, value.capability);
    expect(await validateReceiptForDispatch(
      value.directory,
      attestedDraft,
      value.ticket.ticket_id,
    )).toMatchObject({
      valid: true,
      validation: { attempt: 1, invalid_attempts: 0 },
    });

    await validateReceiptForDispatch(
      value.directory,
      draft(value.ticket, value.capability, 'first-invalid'),
      value.ticket.ticket_id,
    );
    const intentFile = path.join(
      value.paths.dispatchIntents,
      `${rawDigest(value.ticket.ticket_id)}.json`,
    );
    const legacyIntent = await readJson(intentFile, null);
    delete legacyIntent.receipt_validation.invalid_attempts;
    delete legacyIntent.receipt_validation.first_validation_valid;
    await atomicWriteJson(intentFile, legacyIntent);
    expect(await validateReceiptForDispatch(
      value.directory,
      draft(value.ticket, value.capability, 'second-invalid'),
      value.ticket.ticket_id,
    )).toMatchObject({
      valid: false,
      validation: {
        attempt: 3,
        invalid_attempts: 2,
        first_validation_valid: false,
        exhausted: true,
      },
    });
    expect((await readJson(value.paths.active, null)).orchestration).toMatchObject({
      receipt_record_attempts: 3,
      receipt_accepts: 0,
      receipt_rejections: 2,
      receipt_rejections_by_class: { contract: 2 },
      protocol_redispatches: 1,
    });

    const recorded = await recordReceipt(value.directory, attestedDraft);
    expect(recorded).toMatchObject({ ok: true, receipt: { ticket_id: value.ticket.ticket_id } });
    expect(recorded.run.orchestration).toMatchObject({
      receipt_record_attempts: 3,
      receipt_accepts: 1,
      receipt_first_pass_accepts: 0,
      receipt_rejections: 2,
      receipt_rejections_by_class: { contract: 2 },
      protocol_redispatches: 1,
    });
  });

  it('accepts a plain exact draft with string braces and escaped quotes at the first SubagentStop', async () => {
    const value = await fixture();
    const exactDraft = {
      ...draft(value.ticket, value.capability),
      evidence: {
        summary: 'expected } but observed { { near "quoted" and \\escaped text',
      },
    };

    const [stopped] = await runProcess('bin/ape-hook.mjs', {
      hook_event_name: 'SubagentStop',
      project_dir: value.directory,
      session_id: 'session-1',
      agent_id: 'agent-1',
      agent_type: 'default',
      is_subagent: true,
      last_assistant_message: JSON.stringify(exactDraft),
    }, { APE_HOST: 'codex', CODEX_CWD: value.directory });

    expect(stopped).toEqual({});
    expect(await readJson(
      path.join(value.paths.dispatchIntents, `${rawDigest(value.ticket.ticket_id)}.json`),
      null,
    )).toMatchObject({
      validation_attempts: 1,
      valid_draft_observed: true,
      agent_stopped_at: expect.any(String),
      receipt_validation: {
        attempts: 1,
        exhausted: false,
        attested_input_hash: receiptInputHash(exactDraft),
        last_result: { valid: true },
      },
    });
  });

  it('does not legacy-coerce a contract-v1 draft at the SubagentStop attestation boundary', async () => {
    const value = await fixture();
    const nonExactDraft = {
      ...draft(value.ticket, value.capability),
      status: 'success',
    };

    const [stopped] = await runProcess('bin/ape-hook.mjs', {
      hook_event_name: 'SubagentStop',
      project_dir: value.directory,
      session_id: 'session-1',
      agent_id: 'agent-1',
      agent_type: 'default',
      is_subagent: true,
      last_assistant_message: JSON.stringify(nonExactDraft),
    }, { APE_HOST: 'codex', CODEX_CWD: value.directory });

    expect(stopped).toMatchObject({ decision: 'block' });
    expect(stopped.reason).toMatch(/status.*success.*passed|status.*invalid/i);
    const intent = await readJson(
      path.join(value.paths.dispatchIntents, `${rawDigest(value.ticket.ticket_id)}.json`),
      null,
    );
    expect(intent).toMatchObject({
      validation_attempts: 1,
      valid_draft_observed: false,
      receipt_validation: {
        attempts: 1,
        exhausted: false,
        last_result: { valid: false },
      },
    });
    expect(intent.receipt_validation).not.toHaveProperty('attested_input_hash');
    expect(intent).not.toHaveProperty('agent_stopped_at');
  });

  it('validates and records a maximal compliant planner receipt on its first submission', async () => {
    const objective = 'Create a bounded synthetic plan without project-specific material';
    const preflightArtifact = {
      version: 1,
      objective,
      acceptance: ['The synthetic plan is complete and bounded'],
      non_goals: [],
      baseline: [{ command: 'git diff --check', observation: 'The synthetic tree is clean' }],
      impacted_paths: { read: ['value.js'], write: ['value.js'] },
      compatibility: 'Preserve the synthetic public behavior',
      rollback: 'Revert the synthetic change',
      verification_profiles: [],
      questions: [],
    };
    const preflightHash = sha256(preflightArtifact);
    const value = await fixture('codex', {
      stage_id: 'plan',
      role: 'planner',
      writable: false,
      plan_contract_version: 2,
      lane: 'full',
      preflight_artifact: preflightArtifact,
      allowed_evidence_commands: ['git diff --check'],
      objective,
    });
    const candidatePlan = maximalPlannerPlan(preflightHash);
    expect(Buffer.byteLength(canonicalJson(candidatePlan), 'utf8')).toBe(16_384);
    const exactDraft = {
      ...draft(value.ticket, value.capability),
      evidence: { candidate_plan: candidatePlan },
    };

    const validation = await validateReceiptForDispatch(
      value.directory,
      exactDraft,
      value.ticket.ticket_id,
    );
    expect(validation).toMatchObject({
      ok: true,
      valid: true,
      attested: true,
      validation: { attempt: 1 },
      budgets: {
        candidate_plan_utf8_bytes: {
          used_bytes: 16_384,
          max_bytes: 16_384,
          remaining_bytes: 0,
        },
      },
    });
    expect(validation).not.toHaveProperty('next_action');

    const recorded = await recordReceipt(value.directory, exactDraft);
    expect(recorded).toMatchObject({
      ok: true,
      receipt: {
        ticket_id: value.ticket.ticket_id,
        evidence: { candidate_plan: candidatePlan },
      },
    });
    expect(recorded.run.receipts).toHaveLength(1);
    expect(recorded.run.orchestration).toMatchObject({
      receipt_record_attempts: 1,
      receipt_accepts: 1,
      receipt_first_pass_accepts: 1,
    });
  }, 30_000);

  it('returns identical pre-submit growth corrections and never attests or persists an oversized runtime test diff', async () => {
    const value = await fixture('codex', {
      stage_id: 'test',
      role: 'test_writer',
      writable: true,
      claimed_paths: ['tests'],
      test_paths: ['tests'],
      manifest_growth_contract_version: 1,
      manifest_roles: ['test_writer', 'implementer', 'reviewer'],
    });
    await mkdir(path.join(value.directory, 'tests'), { recursive: true });
    await Promise.all(Array.from({ length: 65 }, (_, index) =>
      writeFile(
        path.join(value.directory, 'tests', `generated-${index}.test.js`),
        'export {};\n',
      )));
    const exactDraft = draft(value.ticket, value.capability);

    const [stopped] = await runProcess('bin/ape-hook.mjs', {
      hook_event_name: 'SubagentStop',
      project_dir: value.directory,
      session_id: 'session-1',
      agent_id: 'agent-1',
      agent_type: 'default',
      is_subagent: true,
      last_assistant_message: JSON.stringify(exactDraft),
    }, { APE_HOST: 'codex', CODEX_CWD: value.directory });
    expect(stopped).toMatchObject({ decision: 'block' });
    expect(stopped.reason).toMatch(/runtime\.test_paths.*contains 66 items.*at most 64/i);

    const validation = await validateReceiptForDispatch(
      value.directory,
      exactDraft,
      value.ticket.ticket_id,
    );
    expect(validation).toMatchObject({
      ok: true,
      valid: false,
      attested: false,
      failure_domain: 'orchestration',
      next_action: { kind: 'continue_same_agent', failure_domain: 'orchestration' },
      dynamic_test_paths: { used_items: 66, max_items: 64 },
      corrections: [expect.objectContaining({
        field: 'runtime.test_paths',
        issue: expect.stringMatching(/contains 66 items.*at most 64/i),
      })],
    });
    const correctionErrors = validation.corrections.map(
      (entry) => `${entry.field}: ${entry.issue}`,
    );

    const recorded = await recordReceipt(value.directory, exactDraft);
    expect(recorded).toMatchObject({
      ok: false,
      rejected: true,
      failure_domain: 'orchestration',
      next_action: { kind: 'continue_same_agent', failure_domain: 'orchestration' },
      dynamic_test_paths: { used_items: 66, max_items: 64 },
    });
    expect(recorded.errors).toEqual(correctionErrors);

    const active = await readJson(value.paths.active, null);
    expect(active.receipts).toEqual([]);
    expect(active.test_paths).toEqual(['tests']);
    expect(await readdir(value.paths.receipts).catch((error) =>
      error?.code === 'ENOENT' ? [] : Promise.reject(error))).toEqual([]);
    expect(await readdir(value.paths.receiptTransactions).catch((error) =>
      error?.code === 'ENOENT' ? [] : Promise.reject(error))).toEqual([]);
  }, 30_000);

  it('lets the real PreToolUse hook expose the same bounded field correction', async () => {
    const value = await fixture('claude');
    const [response] = await runProcess('bin/ape-hook.mjs', {
      hook_event_name: 'PreToolUse',
      project_dir: value.directory,
      session_id: 'session-1',
      agent_id: 'agent-1',
      agent_type: 'implementer',
      tool_name: 'mcp__ape__ape_validate_receipt',
      tool_input: {
        ticket_id: value.ticket.ticket_id,
        draft: draft(value.ticket, value.capability, 'not-a-status'),
      },
    }, { APE_HOST: 'claude', CLAUDECODE: '1' });
    expect(response).toEqual({ hookSpecificOutput: {
      hookEventName: 'PreToolUse', additionalContext: expect.any(String),
    } });
    expect(response.hookSpecificOutput.additionalContext).toMatch(/status.*not-a-status/i);
  });

  it('keeps validation, real hook, and record corrections identical', async () => {
    const value = await fixture('claude');
    const invalid = draft(value.ticket, value.capability, 'same-invalid-status');
    const validation = await validateReceiptForDispatch(
      value.directory,
      invalid,
      value.ticket.ticket_id,
    );
    const [hook] = await runProcess('bin/ape-hook.mjs', {
      hook_event_name: 'PreToolUse',
      project_dir: value.directory,
      session_id: 'session-1',
      agent_id: 'agent-1',
      agent_type: 'implementer',
      tool_name: 'mcp__ape__ape_validate_receipt',
      tool_input: { ticket_id: value.ticket.ticket_id, draft: invalid },
    }, { APE_HOST: 'claude', CLAUDECODE: '1' });
    const recorded = await recordReceipt(value.directory, invalid);

    expect(validation.valid).toBe(false);
    expect(recorded).toMatchObject({ ok: false, rejected: true });
    expect(recorded).toMatchObject({
      failure_domain: 'orchestration',
      next_action: { kind: 'continue_same_agent', failure_domain: 'orchestration' },
    });
    expect(recorded.corrections).toEqual(validation.corrections);
    for (const correction of validation.corrections) {
      expect(hook.hookSpecificOutput.additionalContext).toContain(correction.field);
      expect(hook.hookSpecificOutput.additionalContext).toContain(correction.issue);
    }
  });

  it('keeps nested plan, recovery, and scope errors identical across validation, hook, and record', async () => {
    async function plannerVariant({ objective, mutate, verificationProfiles = [] }) {
      const preflightArtifact = {
        version: 1,
        objective,
        acceptance: ['The synthetic plan stays mechanically valid'],
        non_goals: [],
        baseline: [{ command: 'git diff --check', observation: 'The synthetic tree is clean' }],
        impacted_paths: { read: ['value.js'], write: ['value.js'] },
        compatibility: 'Preserve the synthetic public behavior',
        rollback: 'Revert the synthetic change',
        verification_profiles: [],
        questions: [],
      };
      const value = await fixture('claude', {
        stage_id: 'plan',
        role: 'planner',
        writable: false,
        plan_contract_version: 2,
        lane: 'full',
        preflight_artifact: preflightArtifact,
        allowed_evidence_commands: ['git diff --check'],
        verification_profiles: verificationProfiles,
        objective,
      });
      const candidate = maximalPlannerPlan(
        sha256(preflightArtifact),
        mutate === 'oversized' ? 16_385 : 2_000,
      );
      if (mutate === 'command-profile') {
        candidate.workstreams[0].evidence_commands = ['npm run drifted-command'];
        candidate.workstreams[0].verification_profiles = ['unknown-profile'];
      }
      return {
        value,
        invalid: {
          ...draft(value.ticket, value.capability),
          evidence: { candidate_plan: candidate },
        },
      };
    }

    const variants = [
      await plannerVariant({
        objective: 'Reject a synthetic plan one byte above its contract',
        mutate: 'oversized',
      }),
      await plannerVariant({
        objective: 'Reject drifted command and verification profile identifiers',
        mutate: 'command-profile',
        verificationProfiles: [{ id: 'unit', required: true }],
      }),
    ];
    const recovery = await fixture('claude');
    variants.push({
      value: recovery,
      invalid: {
        ...draft(recovery.ticket, recovery.capability, 'failed'),
        evidence: {
          failure_kind: 'capability',
          required_claims: { claimed_paths: ['value.js'] },
        },
      },
    });
    const scope = await fixture('claude');
    variants.push({
      value: scope,
      invalid: {
        ...draft(scope.ticket, scope.capability),
        evidence: {
          summary: 'This role must not grow scope',
          scope_expansion: { claimed_paths: ['src/new.js'], reason: 'not authorized here' },
        },
      },
    });

    for (const { value, invalid } of variants) {
      const validation = await validateReceiptForDispatch(
        value.directory,
        invalid,
        value.ticket.ticket_id,
      );
      const [hook] = await runProcess('bin/ape-hook.mjs', {
        hook_event_name: 'PreToolUse',
        project_dir: value.directory,
        session_id: 'session-1',
        agent_id: 'agent-1',
        agent_type: value.ticket.role,
        tool_name: 'mcp__ape__ape_validate_receipt',
        tool_input: { ticket_id: value.ticket.ticket_id, draft: invalid },
      }, { APE_HOST: 'claude', CLAUDECODE: '1' });
      const recorded = await recordReceipt(value.directory, invalid);

      expect(validation.valid).toBe(false);
      expect(validation.corrections.length).toBeGreaterThan(0);
      expect(recorded).toMatchObject({
        ok: false,
        rejected: true,
        failure_domain: 'orchestration',
      });
      expect(recorded.corrections).toEqual(validation.corrections);
      expect(hook.hookSpecificOutput.additionalContext)
        .toContain(validation.corrections[0].field);
      expect(hook.hookSpecificOutput.additionalContext)
        .toContain(validation.corrections[0].issue);
    }
  }, 30_000);

  it('refuses a valid receipt modified after exact-draft attestation', async () => {
    const value = await fixture();
    const exact = draft(value.ticket, value.capability);
    const validation = await validateReceiptForDispatch(
      value.directory,
      exact,
      value.ticket.ticket_id,
    );
    expect(validation).toMatchObject({ ok: true, valid: true, attested: true });

    const modified = {
      ...exact,
      evidence: { ...exact.evidence, summary: 'modified after validation' },
    };
    const recorded = await recordReceipt(value.directory, modified);
    expect(recorded).toMatchObject({
      ok: false,
      rejected: true,
      next_action: { kind: 'continue_same_agent' },
    });
    expect(recorded.errors).toContain(
      'receipt draft was not pre-validated and attested byte-for-byte for this physical dispatch',
    );
    expect(recorded.input_hash).not.toBe(recorded.attested_input_hash);
  });

  it.each([
    { action: 'next', advance: nextRun, exhaustion: 1 },
    { action: 'resume', advance: resumeRun, exhaustion: 1 },
    { action: 'next', advance: nextRun, exhaustion: 2 },
    { action: 'resume', advance: resumeRun, exhaustion: 2 },
  ])('preserves an aborted run when $action encounters stopped worker exhaustion $exhaustion', async ({ advance, exhaustion }) => {
    const value = await fixture();
    const intentFile = path.join(value.paths.dispatchIntents, `${rawDigest(value.ticket.ticket_id)}.json`);
    if (exhaustion === 2) {
      const intent = await readJson(intentFile);
      await atomicWriteJson(intentFile, {
        ...intent,
        physical_worker_dispatches: 2,
        receipt_validation_exhaustions: 1,
      });
      value.state.receipt_contract_exhaustions = { [value.ticket.ticket_id]: 1 };
      await atomicWriteJson(value.paths.active, value.state);
    }
    const invalid = draft(value.ticket, value.capability, 'invalid-status');
    for (let attempt = 0; attempt < 3; attempt += 1) {
      await validateReceiptForDispatch(value.directory, invalid);
    }
    const observation = await observeCodexSubagentStop(value.paths, await readJson(value.paths.active), {
      session_id: 'session-1', agent_id: 'agent-1', agent_type: 'default',
    });
    expect(observation.observed).toBe(true);
    expect(await abortRun(value.directory, 'Synthetic operator abort before exhaustion settlement'))
      .toMatchObject({ ok: true, run: { status: 'aborted' } });

    const files = [value.paths.active, path.join(value.paths.runs, `${value.state.run_id}.json`), intentFile];
    const before = await Promise.all(files.map((file) => readFile(file, 'utf8')));
    expect(await advance(value.directory)).toMatchObject({ ok: false, reason: 'run is aborted' });
    expect(await Promise.all(files.map((file) => readFile(file, 'utf8')))).toEqual(before);
  });

  it.each(['receipt_retry', 'preflight', 'execution_budget'])(
    'settles stopped receipt evidence only when the %s hold can resume execution',
    async (hold) => {
      const value = await fixture();
      const invalid = draft(value.ticket, value.capability, 'invalid-status');
      for (let attempt = 0; attempt < 3; attempt += 1) {
        await validateReceiptForDispatch(value.directory, invalid);
      }
      const state = await readJson(value.paths.active);
      expect((await observeCodexSubagentStop(value.paths, state, {
        session_id: 'session-1', agent_id: 'agent-1', agent_type: 'default',
      })).observed).toBe(true);
      state.status = 'input_required';
      state.stage = hold === 'preflight' ? 'preflight' : 'input_required';
      state.input_required = hold === 'preflight'
        ? { questions: [] }
        : { kind: hold, ticket_id: value.ticket.ticket_id, resume_status: 'running', resume_stage: value.ticket.stage_id };
      await atomicWriteJson(value.paths.active, state);
      const before = await readFile(value.paths.active, 'utf8');
      const settlement = await settleReceiptValidationSubagentStop(value.directory);
      if (hold === 'execution_budget') {
        expect(settlement).toMatchObject({
          ok: true, settled: true,
          next_action: { kind: 'redispatch_same_ticket', ticket_id: value.ticket.ticket_id },
        });
        expect(await readJson(value.paths.active)).toMatchObject({
          status: 'running',
          receipt_contract_pending_redispatches: [value.ticket.ticket_id],
        });
      } else {
        expect(settlement).toEqual({ ok: true, settled: false });
        expect(await readFile(value.paths.active, 'utf8')).toBe(before);
      }
    },
  );

  it.each(['ordinary', 'task'])('settles an exhausted stopped worker through %s NEXT before redispatch', async (pathKind) => {
    const value = await fixture();
    const invalid = draft(value.ticket, value.capability, 'invalid-status');
    for (let attempt = 0; attempt < 3; attempt += 1) await validateReceiptForDispatch(value.directory, invalid);
    expect(await observeCodexSubagentStop(value.paths, await readJson(value.paths.active), {
      session_id: 'session-1', agent_id: 'agent-1', agent_type: 'default',
    })).toMatchObject({ observed: true });
    const operation = {
      operationId: `op-${'N'.repeat(43)}`, action: 'next', expectedRunId: value.state.run_id,
      request: { action: 'next', wait_ms: 1 },
    };
    if (pathKind === 'task') {
      const before = await readFile(value.paths.active, 'utf8');
      const stale = await executeApeRunTaskOperation(value.directory, {
        ...operation, operationId: `op-${'S'.repeat(43)}`, expectedRunId: 'run-stale-task',
      });
      expect(stale).toMatchObject({ ok: false });
      expect(await readFile(value.paths.active, 'utf8')).toBe(before);
    }
    const result = pathKind === 'task'
      ? await executeApeRunTaskOperation(value.directory, operation)
      : await nextRun(value.directory);
    expect(result.ok).toBe(true);
    expect(result.actions).toEqual(expect.arrayContaining([expect.objectContaining({
      type: 'dispatch_agent', recovery_kind: 'redispatch_same_ticket',
      ticket: expect.objectContaining({ ticket_id: value.ticket.ticket_id }),
    })]));
    expect(result.run.receipt_contract_exhaustions).toEqual({ [value.ticket.ticket_id]: 1 });
    expect(result.run.attempts).toEqual(value.state.attempts);
    expect(result.run.tickets).toHaveLength(1);
    if (pathKind === 'task') {
      const after = await readFile(value.paths.active, 'utf8');
      expect(await executeApeRunTaskOperation(value.directory, operation)).toEqual(result);
      expect(await readFile(value.paths.active, 'utf8')).toBe(after);
    }
  });

  it('blocks an identical malformed final draft twice, then retires and redispatches the same ticket once', async () => {
    const value = await fixture();
    const stop = (status) => ({
      hook_event_name: 'SubagentStop',
      project_dir: value.directory,
      session_id: 'session-1',
      agent_id: 'agent-1',
      agent_type: 'default',
      is_subagent: true,
      last_assistant_message: JSON.stringify(draft(value.ticket, value.capability, status)),
  });

    for (const status of ['same-invalid-status', 'same-invalid-status']) {
      const [response] = await runProcess(
        'bin/ape-hook.mjs',
        stop(status),
        { APE_HOST: 'codex', CODEX_CWD: value.directory },
      );
      expect(response).toMatchObject({ decision: 'block' });
      expect(response.reason).toMatch(/status.*invalid-/i);
    }
    const intentFile = path.join(
      value.paths.dispatchIntents,
      `${rawDigest(value.ticket.ticket_id)}.json`,
    );
    expect(await readJson(intentFile, null)).toMatchObject({
      status: 'bound',
      validation_attempts: 2,
      valid_draft_observed: false,
    });

    const [third] = await runProcess(
      'bin/ape-hook.mjs',
      stop('same-invalid-status'),
      { APE_HOST: 'codex', CODEX_CWD: value.directory },
    );
    expect(third).toEqual({});
    expect(await readJson(intentFile, null)).toMatchObject({
      status: 'bound',
      receipt_validation_exhaustions: 1,
      validation_attempts: 3,
      valid_draft_observed: false,
      agent_stopped_at: expect.any(String),
    });
    const exhaustedRecord = await recordReceipt(
      value.directory,
      draft(value.ticket, value.capability, 'same-invalid-status'),
    );
    expect(exhaustedRecord).toMatchObject({
      ok: false,
      rejected: true,
      recovery_kind: 'receipt_validation_exhausted',
      failure_domain: 'orchestration',
      next_action: {
        kind: 'redispatch_same_ticket',
        ticket_id: value.ticket.ticket_id,
      },
    });
    expect(exhaustedRecord.next_action.kind).not.toBe('continue_same_agent');

    // RESUME must reconcile the durable stopped-worker exhaustion exactly as
    // NEXT does; a host restart between SubagentStop and parent recovery must
    // not lose the same-ticket redispatch allowance.
    const recovery = await resumeRun(value.directory);
    const dispatch = recovery.actions.find((entry) => entry.type === 'dispatch_agent');
    expect(dispatch).toMatchObject({
      ticket: { ticket_id: value.ticket.ticket_id },
      recovery_kind: 'redispatch_same_ticket',
      source_ticket_id: value.ticket.ticket_id,
      failure_domain: 'orchestration',
    });
    expect(recovery.run.tickets).toHaveLength(1);
    expect(recovery.run.tickets[0]).toEqual(value.ticket);
    expect(await readJson(intentFile, null)).toMatchObject({
      status: 'prepared',
      receipt_validation_exhaustions: 1,
      launch_attempts: 0,
    });

    // Advance the replacement through the production launch/bind seam. A
    // direct status rewrite would omit the durable launch-generation ancestry.
    const [launch] = await runProcess('bin/ape-hook.mjs', {
      hook_event_name: 'PreToolUse',
      project_dir: value.directory,
      session_id: 'recovery-parent-session',
      turn_id: 'recovery-parent-turn',
      tool_use_id: 'spawn-recovery-worker',
      tool_name: 'collaborationspawn_agent',
      tool_input: {
        ...dispatch.dispatch.spawn_args,
        message: 'gAAAAABencrypted-v2-message',
      },
    }, { APE_HOST: 'codex', CODEX_CWD: value.directory });
    expect(launch).toEqual({});
    const [start] = await runProcess('bin/ape-hook.mjs', {
      hook_event_name: 'SubagentStart',
      project_dir: value.directory,
      session_id: 'recovery-parent-session',
      turn_id: 'recovery-child-turn',
      agent_id: 'agent-2',
      agent_type: 'default',
      model: dispatch.dispatch.model.model,
    }, { APE_HOST: 'codex', CODEX_CWD: value.directory });
    expect(start.hookSpecificOutput?.additionalContext).toBe(codexBootstrapOrientation());
    expect(await readJson(intentFile, null)).toMatchObject({ status: 'launched' });
    const [bootstrap] = await runProcess('bin/ape-hook.mjs', {
      hook_event_name: 'PreToolUse',
      project_dir: value.directory,
      session_id: 'recovery-parent-session',
      turn_id: 'recovery-child-turn',
      tool_use_id: 'bootstrap-recovery-worker',
      tool_name: 'ape_bind',
      tool_input: dispatch.dispatch.bootstrap_args,
      model: dispatch.dispatch.model.model,
    }, { APE_HOST: 'codex', CODEX_CWD: value.directory });
    const context = bootstrap.hookSpecificOutput?.additionalContext ?? '';
    const recoveryCapability = /APE_RECEIPT_CAPABILITY=([A-Za-z0-9_-]{32,256})/.exec(context)?.[1];
    expect(recoveryCapability).toBeTruthy();
    const secondStop = (status) => ({
      ...stop(status),
      session_id: 'recovery-parent-session',
      turn_id: 'recovery-child-turn',
      model: dispatch.dispatch.model.model,
      agent_id: 'agent-2',
      last_assistant_message: JSON.stringify(draft(value.ticket, recoveryCapability, status)),
    });
    for (const status of ['invalid-four', 'invalid-five']) {
      const [response] = await runProcess(
        'bin/ape-hook.mjs',
        secondStop(status),
        { APE_HOST: 'codex', CODEX_CWD: value.directory },
      );
      expect(response).toMatchObject({ decision: 'block' });
      expect(response.reason).toMatch(/status.*invalid-/i);
    }
    const [finalStop] = await runProcess(
      'bin/ape-hook.mjs',
      secondStop('invalid-six'),
      { APE_HOST: 'codex', CODEX_CWD: value.directory },
    );
    expect(finalStop).toEqual({});
    const terminalRecord = await recordReceipt(
      value.directory,
      draft(value.ticket, recoveryCapability, 'invalid-six'),
    );
    expect(terminalRecord).toMatchObject({
      ok: false,
      rejected: true,
      recovery_kind: 'receipt_validation_exhausted',
      failure_domain: 'orchestration',
      next_action: {
        kind: 'blocked',
        failure_domain: 'orchestration',
        automatic_successor: false,
      },
    });
    const terminal = await nextRun(value.directory);
    expect(terminal).toMatchObject({ ok: false, reason: 'run is blocked' });
    expect(terminal).not.toHaveProperty('actions');
    expect(await readJson(value.paths.active, null)).toMatchObject({
      status: 'blocked',
      terminal_reason_code: 'worker_protocol_failure',
      failure_domain: 'orchestration',
      receipt_contract_exhaustions: { [value.ticket.ticket_id]: 2 },
      orchestration: {
        receipt_record_attempts: 6,
        receipt_rejections: 6,
        protocol_redispatches: 1,
      },
    });
    expect((await readJson(value.paths.active, null)).tickets).toHaveLength(1);
    const blockedNext = await nextRun(value.directory);
    expect(blockedNext).toMatchObject({ ok: false, reason: 'run is blocked' });
    expect(blockedNext).not.toHaveProperty('actions');
  }, 30_000);

  it.each([
    { mode: 'phase', lane: 'fast', stage_id: 'build', role: 'implementer', expectedDeadline: 1_800_000 },
    { mode: 'debug', lane: 'full', stage_id: 'debug', role: 'debugger', expectedDeadline: 900_000 },
    { mode: 'spike', lane: 'full', stage_id: 'spike', role: 'spike_researcher', expectedDeadline: 900_000 },
  ])('preserves the historical $mode horizon when stopped-worker recovery replaces an expired ticket', async ({ expectedDeadline, ...options }) => {
    const value = await fixture('codex', {
      ...options,
      deadline_at: new Date(Date.now() - 1_000).toISOString(),
      execution_policy: historicalExecutionPolicy(2, {}, DEFAULT_CONFIG),
    });
    const originalTicket = structuredClone(value.ticket);
    const firstStop = (status) => ({
      hook_event_name: 'SubagentStop',
      project_dir: value.directory,
      session_id: 'session-1',
      agent_id: 'agent-1',
      agent_type: 'default',
      is_subagent: true,
      last_assistant_message: JSON.stringify(draft(value.ticket, value.capability, status)),
    });

    for (const status of ['invalid-deadline-one', 'invalid-deadline-two']) {
      const [response] = await runProcess(
        'bin/ape-hook.mjs',
        firstStop(status),
        { APE_HOST: 'codex', CODEX_CWD: value.directory },
      );
      expect(response).toMatchObject({ decision: 'block' });
    }
    const [firstExhausted] = await runProcess(
      'bin/ape-hook.mjs',
      firstStop('invalid-deadline-three'),
      { APE_HOST: 'codex', CODEX_CWD: value.directory },
    );
    expect(firstExhausted).toEqual({});

    // Recovery starts its deadline before the dispatch intent is prepared.
    // Exercise elapsed preparation time without sleeps or scheduler dependence.
    const recoveryStartedAt = Date.now();
    const prepareCodexIntent = dispatchIntents.prepareCodexIntent;
    vi.useFakeTimers({ toFake: ['Date'], now: recoveryStartedAt });
    const preparation = vi.spyOn(dispatchIntents, 'prepareCodexIntent').mockImplementation((...args) => {
      vi.setSystemTime(recoveryStartedAt + 25);
      return prepareCodexIntent(...args);
    });
    let recovery;
    try {
      recovery = await nextRun(value.directory);
      expect(preparation).toHaveBeenCalledTimes(1);
    } finally {
      preparation.mockRestore();
      vi.useRealTimers();
    }
    const recoveryDispatch = recovery.actions.find((entry) => entry.type === 'dispatch_agent');
    expect(recoveryDispatch).toMatchObject({
      ticket: { ticket_id: value.ticket.ticket_id },
      recovery_kind: 'redispatch_same_ticket',
      source_ticket_id: value.ticket.ticket_id,
      failure_domain: 'orchestration',
    });
    expect(recovery.run).toMatchObject({
      status: 'running',
      attempts: {},
      expired_tickets: [],
      receipt_contract_exhaustions: { [value.ticket.ticket_id]: 1 },
      receipt_contract_pending_redispatches: [value.ticket.ticket_id],
    });
    expect(recovery.run.tickets).toEqual([originalTicket]);

    const intentFile = path.join(
      value.paths.dispatchIntents,
      `${rawDigest(value.ticket.ticket_id)}.json`,
    );
    const recoveryIntent = await readJson(intentFile, null);
    expect(recoveryIntent).toMatchObject({
      status: 'prepared',
      physical_worker_dispatches: 2,
      receipt_validation_exhaustions: 1,
      receipt_protocol_recovery: true,
      immutable_ticket_deadline_at: value.ticket.deadline_at,
    });
    expect(Date.parse(recoveryIntent.expires_at)).toBeGreaterThan(Date.now());
    expect(Date.parse(recoveryIntent.prepared_at)).toBeGreaterThan(recoveryStartedAt);
    expect(Date.parse(recoveryIntent.expires_at) - recoveryStartedAt).toBe(expectedDeadline);
    expect(Date.parse(value.ticket.deadline_at)).toBeLessThanOrEqual(Date.now());

    // The recovery intent has its own bounded host-dispatch horizon, while the
    // immutable ticket (including its elapsed deadline and hash) remains exact.
    const [launch] = await runProcess('bin/ape-hook.mjs', {
      hook_event_name: 'PreToolUse',
      project_dir: value.directory,
      session_id: 'recovery-parent-session',
      turn_id: 'recovery-parent-turn',
      tool_use_id: 'spawn-recovery-worker',
      tool_name: 'collaborationspawn_agent',
      tool_input: {
        ...recoveryDispatch.dispatch.spawn_args,
        message: 'gAAAAABencrypted-v2-message',
      },
    }, { APE_HOST: 'codex', CODEX_CWD: value.directory });
    expect(launch).toEqual({});
    const [start] = await runProcess('bin/ape-hook.mjs', {
      hook_event_name: 'SubagentStart',
      project_dir: value.directory,
      session_id: 'recovery-parent-session',
      turn_id: 'recovery-child-turn',
      agent_id: 'agent-2',
      agent_type: 'default',
      model: recoveryDispatch.dispatch.model.model,
    }, { APE_HOST: 'codex', CODEX_CWD: value.directory });
    expect(start.hookSpecificOutput?.additionalContext).toBe(codexBootstrapOrientation());
    expect(await readJson(intentFile, null)).toMatchObject({ status: 'launched' });
    const [bootstrap] = await runProcess('bin/ape-hook.mjs', {
      hook_event_name: 'PreToolUse',
      project_dir: value.directory,
      session_id: 'recovery-parent-session',
      turn_id: 'recovery-child-turn',
      tool_use_id: 'bootstrap-recovery-worker',
      tool_name: 'ape_bind',
      tool_input: recoveryDispatch.dispatch.bootstrap_args,
      model: recoveryDispatch.dispatch.model.model,
    }, { APE_HOST: 'codex', CODEX_CWD: value.directory });
    const context = bootstrap.hookSpecificOutput?.additionalContext ?? '';
    const recoveryCapability = /APE_RECEIPT_CAPABILITY=([A-Za-z0-9_-]{32,256})/.exec(context)?.[1];
    expect(recoveryCapability).toBeTruthy();

    const secondStop = (status) => ({
      ...firstStop(status),
      session_id: 'recovery-parent-session',
      turn_id: 'recovery-child-turn',
      model: recoveryDispatch.dispatch.model.model,
      agent_id: 'agent-2',
      last_assistant_message: JSON.stringify(
        draft(value.ticket, recoveryCapability, status),
      ),
    });
    for (const status of ['invalid-deadline-four', 'invalid-deadline-five']) {
      const [response] = await runProcess(
        'bin/ape-hook.mjs',
        secondStop(status),
        { APE_HOST: 'codex', CODEX_CWD: value.directory },
      );
      expect(response).toMatchObject({ decision: 'block' });
    }
    const [secondExhausted] = await runProcess(
      'bin/ape-hook.mjs',
      secondStop('invalid-deadline-six'),
      { APE_HOST: 'codex', CODEX_CWD: value.directory },
    );
    expect(secondExhausted).toEqual({});

    const terminal = await nextRun(value.directory);
    expect(terminal).toEqual({ ok: false, reason: 'run is blocked' });
    const blocked = await readJson(value.paths.active, null);
    expect(blocked).toMatchObject({
      status: 'blocked',
      terminal_reason_code: 'worker_protocol_failure',
      failure_domain: 'orchestration',
      receipt_contract_exhaustions: { [value.ticket.ticket_id]: 2 },
      attempts: {},
      expired_tickets: [],
    });
    expect(blocked.receipt_contract_pending_redispatches).toBeUndefined();
    expect(blocked.tickets).toEqual([originalTicket]);
    expect(await nextRun(value.directory)).toEqual({ ok: false, reason: 'run is blocked' });
    expect((await readJson(intentFile, null)).physical_worker_dispatches).toBe(2);
  }, 30_000);

});
