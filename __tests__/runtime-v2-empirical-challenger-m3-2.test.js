// __tests__/runtime-v2-empirical-challenger-m3-2.test.js
import { describe, expect, it } from 'vitest';
import { readFile, readdir } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { PlanContractSchema, validatePreflightArtifact } from '../lib/runtime/plan-contract.js';
import { receiptContractContext, codexInjectedDispatchContext } from '../lib/runtime/adapters.js';
import { receiptOutputSchemaForTicket, validateReceiptDraft } from '../lib/runtime/receipt-validator.js';
import { sha256 } from '../lib/runtime/canonical.js';
import { runContractFieldBounds, runContractByteBudgets } from '../lib/runtime/run-contract.js';

const repoRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const HASH = 'a'.repeat(64);

const ALL_ROLES = [
  'preflight_analyst',
  'planner',
  'plan_checker',
  'plan_critic',
  'plan_judge',
  'test_writer',
  'implementer',
  'reviewer',
  'security_reviewer',
  'debugger',
  'spike_researcher',
];

const STAGE_MAP = {
  planner: 'plan',
  preflight_analyst: 'preflight',
  plan_checker: 'plan-check',
  plan_critic: 'plan-critic',
  plan_judge: 'plan-judge',
  implementer: 'implementation',
  test_writer: 'test-authoring',
  reviewer: 'review',
  security_reviewer: 'review',
  debugger: 'debug',
  spike_researcher: 'spike',
};

function makeTicket(role, overrides = {}) {
  const isReview = ['reviewer', 'security_reviewer'].includes(role);
  const ticket = {
    ticket_id: `run-test:${role}:ticket`,
    ticket_hash: HASH,
    stage_id: STAGE_MAP[role] || 'test',
    role,
    objective: 'Implement authorized behavior and verify acceptance',
    claimed_paths: ['src/feature.js', 'src/example.js', 'src/api.js', 'src/value.js', 'candidate_plan.json'],
    test_paths: ['__tests__/focused.test.js', '__tests__/contradictory.test.js'],
    required_checks: [],
    receipt_contract_version: 1,
    plan_contract_version: 2,
    ...(isReview ? { review_contract_version: 1 } : {}),
    ...overrides,
  };
  ticket.capability_manifest = {
    version: 1,
    config_hash: HASH,
    required_capabilities: [],
    allowed_evidence_commands: [
      'npm test',
      'npm test __tests__/focused.test.js',
      'npm test __tests__/failing.test.js',
      'npm test __tests__/contradictory.test.js',
    ],
    plannable_evidence_commands: ['npm test'],
    command_profiles: [],
    verification_profiles: role === 'preflight_analyst' ? [{ id: 'unit', disposition: 'required', reason: 'behavioral' }] : [],
    objective_hash: sha256(ticket.objective),
    preflight_hash: HASH,
    risk_triggers: ['concurrency'],
    design_assurance_required: false,
    field_bounds: runContractFieldBounds(),
    byte_budgets: runContractByteBudgets(),
  };
  ticket.output_schema = receiptOutputSchemaForTicket(ticket);
  ticket.capability_manifest.receipt_schema = { ref: 'ticket.output_schema', hash: sha256(ticket.output_schema) };
  return ticket;
}

function digitRuns(text) {
  return text.match(/\d+/g) ?? [];
}

describe('Challenger M3 2: Adversarial Prompt Contract and Boundary Verification', () => {
  it('strictly proves no digit runs of 12 or 200 exist in prompts/common.md and plugin distributions', async () => {
    const targets = [
      path.join(repoRoot, 'prompts', 'common.md'),
      path.join(repoRoot, 'plugins', 'ape', 'prompts', 'common.md'),
      path.join(repoRoot, 'plugins', 'ape-claude', 'prompts', 'common.md'),
    ];

    for (const target of targets) {
      const text = await readFile(target, 'utf8');
      const runs = digitRuns(text);
      expect(runs, `${target} must not leak digit run 12`).not.toContain('12');
      expect(runs, `${target} must not leak digit run 200`).not.toContain('200');
    }
  });

  it('guarantees first JSON code block in planner.md and preflight_analyst.md is not displaced across all surfaces', async () => {
    const locations = [
      path.join(repoRoot, 'prompts'),
      path.join(repoRoot, 'plugins', 'ape', 'prompts'),
      path.join(repoRoot, 'plugins', 'ape-claude', 'prompts'),
    ];

    for (const loc of locations) {
      const preflight = await readFile(path.join(loc, 'preflight_analyst.md'), 'utf8');
      const preflightBlock = preflight.match(/```json\n([\s\S]*?)\n```/u);
      expect(preflightBlock, `Missing first JSON block in ${loc}/preflight_analyst.md`).not.toBeNull();
      const preflightArtifact = JSON.parse(preflightBlock[1]);
      expect(preflightArtifact.version).toBe(1);
      expect(preflightArtifact).toHaveProperty('baseline');
      expect(preflightArtifact).toHaveProperty('impacted_paths');
      expect(preflightArtifact).toHaveProperty('verification_profiles');

      const planner = await readFile(path.join(loc, 'planner.md'), 'utf8');
      const plannerBlock = planner.match(/```json\n([\s\S]*?)\n```/u);
      expect(plannerBlock, `Missing first JSON block in ${loc}/planner.md`).not.toBeNull();
      const candidatePlan = JSON.parse(plannerBlock[1]);
      expect(candidatePlan.version).toBe(2);
      expect(candidatePlan).toHaveProperty('requirements');
      expect(candidatePlan).toHaveProperty('workstreams');
      expect(candidatePlan).toHaveProperty('assurances');
      expect(PlanContractSchema.safeParse(candidatePlan).success).toBe(true);
    }
  });

  it('ensures lib/runtime/adapters.js and rendered scaffold contain exact substring receipt_capability:$APE_RECEIPT_CAPABILITY', async () => {
    const adaptersCode = await readFile(path.join(repoRoot, 'lib', 'runtime', 'adapters.js'), 'utf8');
    expect(adaptersCode).toContain("receipt_capability: '$APE_RECEIPT_CAPABILITY'");

    for (const role of ALL_ROLES) {
      const ticket = makeTicket(role);
      const rendered = receiptContractContext(ticket);
      expect(rendered).toContain('"receipt_capability":"$APE_RECEIPT_CAPABILITY"');
      expect(rendered).toContain('Receipt envelope scaffold');
      expect(rendered).toContain('Role-specific output_schema excerpt');

      const codexContext = codexInjectedDispatchContext(ticket);
      expect(codexContext).toContain('"receipt_capability":"$APE_RECEIPT_CAPABILITY"');
    }
  });

  it('proves limit-contract-repairs context splitting logic cleanly parses schema excerpt across all 11 roles and edge cases', () => {
    for (const role of ALL_ROLES) {
      const ticket = makeTicket(role);

      // 1. Direct excerpt mode
      const contextDirect = receiptContractContext(ticket, { reference_schema: false });
      const splitDirect = contextDirect.split('Role-specific output_schema excerpt\n\n');
      expect(splitDirect).toHaveLength(2);
      const excerptDirect = JSON.parse(splitDirect[1].split('\n\n')[0]);
      expect(excerptDirect).toBeTypeOf('object');
      expect(excerptDirect).toHaveProperty('required_top_level');
      expect(excerptDirect).toHaveProperty('role_evidence');

      // 2. Reference schema mode
      const contextRef = receiptContractContext(ticket, { reference_schema: true });
      const splitRef = contextRef.split('Role-specific output_schema excerpt\n\n');
      expect(splitRef).toHaveLength(2);
      const excerptRef = JSON.parse(splitRef[1].split('\n\n')[0]);
      expect(excerptRef).toMatchObject({
        projection: 'immutable-ticket-schema-reference-v1',
        ticket_id: ticket.ticket_id,
        json_pointer: '/output_schema',
        required: true,
      });
    }
  });

  it('validates every single JSON code block across all role prompts and common.md is valid JSON', async () => {
    const promptFiles = (await readdir(path.join(repoRoot, 'prompts'))).filter((f) => f.endsWith('.md'));
    let blockCount = 0;

    for (const file of promptFiles) {
      const content = await readFile(path.join(repoRoot, 'prompts', file), 'utf8');
      const matches = [...content.matchAll(/```json\n([\s\S]*?)\n```/g)];
      expect(matches.length).toBeGreaterThan(0);
      for (let i = 0; i < matches.length; i++) {
        blockCount++;
        expect(() => JSON.parse(matches[i][1]), `Invalid JSON in ${file} block #${i + 1}`).not.toThrow();
      }
    }
    expect(blockCount).toBe(37);
  });

  it('validates all 6 common.md receipt skeletons satisfy validateReceiptDraft when completed with bearer token', async () => {
    const content = await readFile(path.join(repoRoot, 'prompts', 'common.md'), 'utf8');
    const blocks = [...content.matchAll(/```json\n([\s\S]*?)\n```/g)].map((m) => JSON.parse(m[1]));
    expect(blocks).toHaveLength(6);

    const token = 'b'.repeat(48);

    // Skeleton 0: Non-review pass
    const s0 = { ...blocks[0], ticket_id: 'run-test:implementer:ticket', receipt_capability: token };
    expect(validateReceiptDraft(makeTicket('implementer'), s0).valid).toBe(true);

    // Skeleton 1: Review pass with approval
    const s1 = { ...blocks[1], ticket_id: 'run-test:reviewer:ticket', receipt_capability: token };
    expect(validateReceiptDraft(makeTicket('reviewer'), s1).valid).toBe(true);

    // Skeleton 2: Review pass with rejection (blocking defect)
    const s2 = { ...blocks[2], ticket_id: 'run-test:reviewer:ticket', receipt_capability: token };
    expect(validateReceiptDraft(makeTicket('reviewer'), s2).valid).toBe(true);

    // Skeleton 3: Plan review pass with rejection (disagree)
    const s3 = { ...blocks[3], ticket_id: 'run-test:plan_checker:ticket', receipt_capability: token };
    expect(validateReceiptDraft(makeTicket('plan_checker'), s3).valid).toBe(true);

    // Skeleton 4: Worker execution failure (missing capability)
    const s4 = { ...blocks[4], ticket_id: 'run-test:implementer:ticket', receipt_capability: token };
    expect(validateReceiptDraft(makeTicket('implementer'), s4).valid).toBe(true);

    // Skeleton 5: Worker execution failure (command shape denial)
    const s5 = { ...blocks[5], ticket_id: 'run-test:implementer:ticket', receipt_capability: token };
    expect(validateReceiptDraft(makeTicket('implementer'), s5).valid).toBe(true);
  });

  it('validates all role-specific pass and fail skeletons satisfy validateReceiptDraft for their respective roles', async () => {
    const promptFiles = (await readdir(path.join(repoRoot, 'prompts'))).filter(
      (f) => f.endsWith('.md') && f !== 'common.md',
    );
    const token = 'c'.repeat(64);

    for (const file of promptFiles) {
      const role = file.replace('.md', '');
      const content = await readFile(path.join(repoRoot, 'prompts', file), 'utf8');
      const blocks = [...content.matchAll(/```json\n([\s\S]*?)\n```/g)].map((m) => JSON.parse(m[1]));

      // Filter to receipt envelope blocks (contain ticket_id and status)
      const envelopes = blocks.filter((b) => b && typeof b === 'object' && 'ticket_id' in b && 'status' in b);
      expect(envelopes.length, `Expected at least 2 receipt skeletons in ${file}`).toBeGreaterThanOrEqual(2);

      const ticket = makeTicket(role);

      for (let i = 0; i < envelopes.length; i++) {
        const draft = JSON.parse(JSON.stringify(envelopes[i]));
        draft.ticket_id = ticket.ticket_id;
        draft.receipt_capability = token;

        if (role === 'preflight_analyst' && draft.evidence?.preflight_artifact) {
          draft.evidence.preflight_artifact.objective = ticket.objective;
        }

        const res = validateReceiptDraft(ticket, draft);
        expect(res.valid, `Skeleton #${i + 1} in ${file} failed validateReceiptDraft: ${JSON.stringify(res.corrections)}`).toBe(true);
      }
    }
  });

  it('confirms deterministic plugin packages build check passes without drift', () => {
    const output = execFileSync('node', ['scripts/build-plugin-packages.mjs', '--check'], {
      cwd: repoRoot,
      encoding: 'utf8',
    });
    expect(output).toContain('plugin packages are byte-identical to a fresh deterministic build');
  });
});
