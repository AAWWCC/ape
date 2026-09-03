import { createHash } from 'node:crypto';
import { execFileSync, spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { emptyOrchestrationTelemetry } from '../lib/runtime/orchestration-telemetry.js';
import { readDispatchReceiptAttestation } from '../lib/runtime/claude-dispatch.js';
import { runtimePaths } from '../lib/runtime/paths.js';
import { receiptOutputSchemaForTicket } from '../lib/runtime/receipt-validator.js';
import { normalizeReceiptInput, receiptInputHash } from '../lib/runtime/receipt-input.js';
import {
  executeApeRunTaskOperation,
  nextRun,
  recordReceipt,
  recoverReceipt,
  resumeRun,
  validateReceiptForDispatch,
} from '../lib/runtime/service.js';
import { atomicWriteJson, readJson } from '../lib/runtime/storage.js';
import { canonicalJson, sha256 } from '../lib/runtime/canonical.js';
import { finalizeTicket } from '../lib/runtime/schemas.js';

const repoRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const cleanups = [];

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((directory) =>
    rm(directory, { recursive: true, force: true })));
});

describe('live capability-recovery receipt contract', () => {
  it('attests the exact failed draft, preserves its receipt, and binds one fresh immutable successor', async () => {
    const value = await fixture('codex', {
      stage_id: 'build',
      role: 'implementer',
      writable: true,
      manifest_growth_contract_version: 1,
      manifest_roles: ['implementer', 'reviewer', 'security_reviewer'],
    });
    const exactDraft = {
      ...draft(value.ticket, value.capability, 'failed'),
      evidence: {
        failure_kind: 'capability',
        summary: 'the implementation needs one exact repository-local module',
        required_claims: {
          claimed_paths: ['src/helper.js'],
          required_role: 'implementer',
        },
      },
    };
    const requiredRoleSchema = value.ticket.output_schema.properties.evidence
      .properties.required_claims.properties.required_role;
    expect(requiredRoleSchema.enum).toEqual(['implementer']);

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
    });

    const recorded = await recordReceipt(value.directory, exactDraft);
    expect(recorded.ok, JSON.stringify(recorded.errors ?? [])).toBe(true);
    expect(recorded.run).toMatchObject({
      run_id: value.state.run_id,
      status: 'running',
      stage: 'build',
      claimed_paths: ['value.js', 'src/helper.js'],
      test_paths: [],
      attempts: {},
    });
    expect(recorded.receipt).toMatchObject({
      ticket_id: value.ticket.ticket_id,
      status: 'failed',
      evidence: exactDraft.evidence,
      receipt_hash: expect.stringMatching(/^[0-9a-f]{64}$/),
    });

    const successor = recorded.run.tickets.at(-1);
    expect(successor.ticket_id).not.toBe(value.ticket.ticket_id);
    expect(successor).toMatchObject({
      run_id: value.state.run_id,
      stage_id: value.ticket.stage_id,
      role: value.ticket.role,
      attempt: value.ticket.attempt,
      claimed_paths: ['value.js', 'src/helper.js'],
      test_paths: [],
      prior_attempts: [expect.stringMatching(/implementation needs.*src\/helper\.js/i)],
      ticket_hash: expect.stringMatching(/^[0-9a-f]{64}$/),
    });
    expect(successor).not.toHaveProperty('retry_of');
    expect(successor.capability_manifest.field_bounds)
      .toEqual(value.ticket.capability_manifest.field_bounds);
    expect(successor.output_schema.properties.ticket_id.const).toBe(successor.ticket_id);
    expect(successor.capability_manifest.receipt_schema.hash)
      .toBe(sha256(successor.output_schema));
    expect(recorded.actions.find((entry) =>
      entry.type === 'dispatch_agent' && entry.ticket?.ticket_id === successor.ticket_id,
    )).toMatchObject({
      recovery_kind: expect.stringMatching(/capability/i),
      source_ticket_id: value.ticket.ticket_id,
    });

    const successorPath = path.join(
      value.paths.tickets,
      `${successor.ticket_id.replaceAll(':', '_')}.json`,
    );
    expect(await readJson(successorPath)).toEqual(successor);
    const transactions = await readdir(value.paths.receiptTransactions);
    expect(transactions).toHaveLength(1);
    const transaction = await readJson(path.join(value.paths.receiptTransactions, transactions[0]));
    expect(transaction.status).toBe('committed');
    expect(JSON.stringify(transaction)).toContain(successor.ticket_id);
    expect(JSON.stringify(transaction)).toContain(successor.ticket_hash);
    expect(JSON.stringify(transaction)).toContain(recorded.run.updated_at);

    const audits = (await readFile(value.paths.overrideLog, 'utf8'))
      .trim().split('\n').map((line) => JSON.parse(line))
      .filter((entry) => /capability/.test(entry.operation ?? ''));
    expect(audits).toEqual([expect.objectContaining({
      run_id: value.state.run_id,
      source_ticket_id: value.ticket.ticket_id,
      added_claimed_paths: ['src/helper.js'],
      added_test_paths: [],
    })]);
  }, 30_000);
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
    deadline_at: options.deadline_at ?? new Date(Date.now() + 3_600_000).toISOString(),
    required_checks: options.required_checks ?? [],
    writable: options.writable ?? role === 'implementer',
    base_tree_sha: treeSha,
    parent_hash: null,
    attempt: 1,
    issued_at: new Date().toISOString(),
    receipt_contract_version: 1,
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
        validation_attempts_per_worker: 3,
        max_physical_workers_per_ticket: 2,
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
  const createdAt = new Date(Date.now() - 1_000).toISOString();
  const state = {
    run_id: runId,
    status: 'running',
    stage: stageId,
    host,
    binding_protocol: 'native-v1',
    objective,
    mode: 'phase',
    lane: options.lane ?? 'fast',
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
      ...(host === 'codex'
        ? { binding_agent_type: 'default', bound_session_id: 'session-1' }
        : { parent_session_id: 'session-1' }),
      status: 'bound',
      bound_agent_id: 'agent-1',
      capability_hash: rawDigest(capability),
      prepared_at: createdAt,
      bound_at: createdAt,
      ...(options.agent_stopped_at
        ? { agent_stopped_at: options.agent_stopped_at }
        : {}),
      expires_at: ticket.deadline_at,
      launch_attempts: 1,
      physical_worker_dispatches: 1,
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
    expect(JSON.stringify(stopped)).toContain('[receipt-capability-redacted]');

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
    expect(preSubmit.hookSpecificOutput.permissionDecision).toBe('allow');
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
    expect(preSubmit.hookSpecificOutput.permissionDecision).toBe('allow');
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
    expect(response.hookSpecificOutput).toMatchObject({
      hookEventName: 'PreToolUse',
      permissionDecision: 'allow',
    });
    expect(response.hookSpecificOutput.permissionDecisionReason).toMatch(/status.*not-a-status/i);
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
      expect(hook.hookSpecificOutput.permissionDecisionReason).toContain(correction.field);
      expect(hook.hookSpecificOutput.permissionDecisionReason).toContain(correction.issue);
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
      expect(hook.hookSpecificOutput.permissionDecisionReason)
        .toContain(validation.corrections[0].field);
      expect(hook.hookSpecificOutput.permissionDecisionReason)
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

    const prepared = await readJson(intentFile, null);
    await atomicWriteJson(intentFile, {
      ...prepared,
      status: 'bound',
      binding_agent_type: 'default',
      bound_session_id: 'session-2',
      bound_agent_id: 'agent-2',
      capability_hash: rawDigest(value.capability),
      bound_at: new Date().toISOString(),
    });
    const secondStop = (status) => ({
      ...stop(status),
      session_id: 'session-2',
      agent_id: 'agent-2',
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
      draft(value.ticket, value.capability, 'invalid-six'),
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

  it('gives stopped-worker receipt recovery precedence over the immutable ticket deadline', async () => {
    const value = await fixture('codex', {
      deadline_at: new Date(Date.now() - 1_000).toISOString(),
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

    const recovery = await nextRun(value.directory);
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
    expect(Date.parse(value.ticket.deadline_at)).toBeLessThanOrEqual(Date.now());

    // The recovery intent has its own bounded host-dispatch horizon, while the
    // immutable ticket (including its elapsed deadline and hash) remains exact.
    const [launch] = await runProcess('bin/ape-hook.mjs', {
      hook_event_name: 'PreToolUse',
      project_dir: value.directory,
      session_id: 'recovery-parent-session',
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
      session_id: 'session-2',
      agent_id: 'agent-2',
      agent_type: 'default',
    }, { APE_HOST: 'codex', CODEX_CWD: value.directory });
    const context = start.hookSpecificOutput?.additionalContext ?? '';
    const recoveryCapability = /APE_RECEIPT_CAPABILITY=([A-Za-z0-9_-]{32,256})/.exec(context)?.[1];
    expect(recoveryCapability).toBeTruthy();

    const secondStop = (status) => ({
      ...firstStop(status),
      session_id: 'session-2',
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
