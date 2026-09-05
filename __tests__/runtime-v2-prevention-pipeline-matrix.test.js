import { describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG } from '../lib/runtime/config.js';
import { classifyLane } from '../lib/runtime/lane-policy.js';
import { pipelineRunSpec, projectedPipeline } from '../lib/runtime/pipeline.js';
import { compileRunAdmissionContract } from '../lib/runtime/admission-compiler.js';
import { candidatePlanForScope } from '../lib/runtime/plan-contract.js';
import { reduceRun } from '../lib/runtime/scheduler.js';
import { RunStartInputSchema } from '../lib/runtime/schemas.js';
import { sha256 } from '../lib/runtime/canonical.js';

// Semantic scheduler coverage, not a native-host or receipt-I/O certification.
// Like core-remediation-convergence, this applies actual reducer actions to an
// in-memory state and submits synthetic already-admitted receipts. Structured
// candidates still pass the real consumer and exact unanimous sealing path.
// Real runtime-owned red/green execution, filesystem receipt admission, v2
// artifact forwarding, and actual merge gates remain covered by their focused
// service suites; we do not assert they ran once for every matrix row here.
const config = structuredClone(DEFAULT_CONFIG);
config.test_commands.full = 'node --test';
config.test_commands.targeted_template = 'node --test {paths}';

const rows = [];
for (const mode of ['phase', 'debug', 'spike', 'land']) {
  for (const requested of ['auto', 'mechanical', 'fast', 'full']) {
    for (const behavioral of [false, true]) {
      for (const intent of ['red-first', 'green-maintenance']) {
        for (const version of [undefined, 1, 2]) {
          for (const testOnly of intent === 'green-maintenance' ? [false, true] : [false]) {
            if (intent === 'green-maintenance' && (mode !== 'phase' || !behavioral)) continue;
            const input = RunStartInputSchema.parse({
              objective: 'Synthetic scheduler matrix', mode, lane: requested, host: 'claude',
              behavioral, test_intent: intent,
              claimed_paths: testOnly ? [] : behavioral ? ['src/value.js'] : ['README.md'],
              test_paths: behavioral && mode !== 'land' ? ['tests/value.test.js'] : [],
              hooks_trusted: true, subagents_available: true, explicit_invocation: true,
              ...(version === undefined ? {} : { plan_contract_version: version }),
            });
            const classification = classifyLane({ ...input, requested_lane: requested }, config.policy);
            // Same eligibility invariant as lifecycle admission: v2 requires
            // an actually schedulable behavioral phase preflight.
            if (version === 2 && (mode !== 'phase' || !behavioral || !['fast', 'full'].includes(classification.lane))) continue;
            rows.push({
              name: `${mode}/${requested}->${classification.lane}/${behavioral ? intent : 'nonbehavioral'}/v${version ?? 'legacy'}${testOnly ? '/test-only' : ''}`,
              input, classification,
            });
          }
        }
      }
    }
  }
}

function expectedRoute(input, lane) {
  if (input.mode === 'debug' || input.mode === 'spike') return [input.mode];
  if (input.mode === 'land') return ['review'];
  if (lane === 'mechanical') return ['build'];
  return [
    ...(input.plan_contract_version === 2 ? ['preflight'] : []),
    ...(lane === 'full' ? ['plan', 'plan-check', 'plan-critic'] : []),
    ...(input.behavioral ? ['test'] : []),
    ...(input.test_intent !== 'green-maintenance' || input.claimed_paths.length ? ['build'] : []),
    'review',
  ];
}

function runMatrix({ input, classification, escalate = false }) {
  const spec = pipelineRunSpec(input, classification, config);
  const projection = projectedPipeline(spec);
  const contract = compileRunAdmissionContract({ input, config, classification, projection, planning_commands: ['node --test'] });
  expect(contract.valid, JSON.stringify(contract.blocking)).toBe(true);
  let candidate;
  if (contract.planner.applicable) {
    const accepted = candidatePlanForScope(contract.planner.template, [...input.claimed_paths, ...input.test_paths], null, {
      preflight_hash: contract.planner.template.preflight_hash,
      plannable_evidence_commands: ['node --test'], verification_profiles: [], risk_triggers: [], require_design_assurance: true,
    });
    expect(accepted.valid, JSON.stringify(accepted.errors)).toBe(true);
    candidate = accepted.value;
  }
  const state = {
    ...spec, run_id: 'run-matrix', objective: input.objective, status: 'starting', stage: 'start',
    tickets: [], receipts: [], attempts: {}, remediation_cycles: 0, risk_triggers: [],
  };
  const pending = [];
  const issued = [];
  let gates = 0;
  let merges = 0;
  const apply = (actions) => {
    expect(actions.some((action) => action.type === 'reject')).toBe(false);
    for (const action of actions) {
      if (action.type === 'transition') Object.assign(state, action.patch);
      if (action.type === 'run_gates') gates += 1;
      if (action.type === 'auto_merge') merges += 1;
      if (action.type !== 'issue_ticket') continue;
      const stage = action.stage;
      const declared = projection.stages.find((entry) => entry.id === stage.id);
      expect(declared, `compiler omitted ${stage.id}`).toBeDefined();
      expect(stage.role).toBe(declared.role);
      expect(stage.writable).toBe(declared.writable);
      expect(stage.model_tier).toBe(declared.model_tier);
      expect(stage.parallel_group).toBe(declared.parallel_group);
      expect(stage.output_schema).toEqual(declared.output_schema);
      const variants = declared.required_check_variants ?? [declared.required_checks];
      expect(variants).toContainEqual(stage.required_checks);
      expect([...new Set(variants.flat())].sort()).toEqual([...declared.required_checks].sort());
      const ticket = {
        ...stage, stage_id: stage.id, ticket_id: `ticket-${state.tickets.length + 1}`,
        ...(candidate && ['plan-check', 'plan-critic', 'plan-judge'].includes(stage.id) ? { candidate_plan: candidate } : {}),
      };
      state.tickets.push(ticket);
      pending.push(ticket);
      issued.push(stage.id);
    }
  };
  apply(reduceRun(null, { type: 'START', run: state }));
  let consumed = 0;
  while (pending.length) {
    expect(consumed++).toBeLessThan(20);
    const ticket = pending.shift();
    const receipt = {
      receipt_id: `receipt-${consumed}`, ticket_id: ticket.ticket_id, stage_id: ticket.stage_id,
      status: 'passed', evidence: { verdict: 'agree' }, findings: [],
      receipt_hash: sha256({ ticket: ticket.ticket_id, verdict: 'agree' }),
    };
    state.receipts.push(receipt);
    if (ticket.stage_id === 'preflight') {
      if (escalate) {
        // Emulate the already-validated preflight lane event. No claim or
        // capability is added; this observes the alternate projected branch.
        apply(reduceRun(state, { type: 'SCOPE_EXPANDED', scope: {
          lane: 'full', lane_reasons: ['preflight-complexity'], risk_triggers: [],
        } }));
      }
      apply(reduceRun(state, { type: 'PREFLIGHT_RECORDED', preflight_hash: '0'.repeat(64), questions: [], receipt }));
    } else {
      apply(reduceRun(state, { type: 'RECEIPT_RECORDED', ticket, receipt, stage: ticket, next_state: state }));
    }
    expect(state.status).not.toBe('blocked');
  }
  expect(issued).toEqual(expectedRoute(input, state.lane));
  const terminalReadOnly = ['debug', 'spike'].includes(input.mode);
  expect(gates).toBe(terminalReadOnly ? 0 : 1);
  expect(merges).toBe(0); // A receipt alone never implies passing gates or merge.
  if (terminalReadOnly) {
    expect(state.status).toBe('completed');
    expect(state.tickets.every((ticket) => !ticket.writable)).toBe(true);
  } else {
    expect(state.status).not.toBe('completed');
    apply(reduceRun(state, { type: 'GATES_PASSED' }));
    expect(state.status).toBe('shipping');
    expect(merges).toBe(1);
    apply(reduceRun(state, { type: 'MERGED', merge: { synthetic_observation: true } }));
    expect(state.status).toBe('completed');
  }
  if (input.mode === 'land') expect(state.tickets.every((ticket) => !ticket.writable)).toBe(true);
  if (!input.behavioral) expect(state.tickets.some((ticket) => ticket.role === 'test_writer')).toBe(false);
  const test = state.tickets.find((ticket) => ticket.stage_id === 'test');
  if (test) expect(test.required_checks).toEqual([input.test_intent === 'green-maintenance' ? 'green-test' : 'red-test']);
  if (issued.includes('plan-check') && candidate) {
    expect(state.approved_plan.plan_hash).toBe(candidate.plan_hash);
    expect(state.approved_plan.reviewer_receipt_hashes).toEqual(state.receipts
      .filter((receipt) => ['plan-check', 'plan-critic'].includes(receipt.stage_id)).map((receipt) => receipt.receipt_hash));
  }
}

describe('prevention compiler against actual successful reducer transitions', () => {
  for (const row of rows) it(row.name, () => runMatrix(row));
  for (const row of rows.filter((entry) => entry.input.mode === 'phase' &&
      entry.input.lane === 'fast' && entry.input.plan_contract_version === 2)) {
    it(`${row.name}/preflight-escalates`, () => runMatrix({ ...row, escalate: true }));
  }
});
