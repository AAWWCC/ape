import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { AUTO_MERGE_HOLD_REASON, SCHEMA_VERSION } from '../lib/runtime/constants.js';
import { runtimePaths } from '../lib/runtime/paths.js';
import { compactStatus, resumeRun, startRun, statusRun } from '../lib/runtime/service.js';
import { deriveRunFacts } from '../lib/runtime/status-service.js';
import { atomicWriteJson, readJson } from '../lib/runtime/storage.js';
import { RESPONSE_BUDGET_CHARS } from '../lib/runtime/projection.js';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const cleanups = [];

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

function git(cwd, ...args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

async function createProject() {
  const dir = await mkdtemp(path.join(tmpdir(), 'ape-run-observability-'));
  cleanups.push(dir);
  await mkdir(path.join(dir, 'src'), { recursive: true });
  await mkdir(path.join(dir, 'tests'), { recursive: true });
  await writeFile(path.join(dir, 'src', 'calc.js'), 'export function add(a, b) { return a + b; }\n');
  await writeFile(path.join(dir, 'tests', 'calc.test.js'), 'import { add } from "../src/calc.js";\n');
  git(dir, 'init', '-q');
  git(dir, 'config', 'user.email', 'ape@example.test');
  git(dir, 'config', 'user.name', 'APE Observability Test');
  git(dir, 'add', '.');
  git(dir, 'commit', '-qm', 'initial');
  await atomicWriteJson(runtimePaths(dir).config, {
    shipping: { auto_merge: false, provider: 'github', required_remote_checks: false },
    test_commands: { full: 'node --test', targeted_template: 'node --test {paths}' },
  });
  return dir;
}

function baseStartInput(overrides = {}) {
  return {
    objective: 'Test run observability and operational facts derivation',
    mode: 'phase',
    lane: 'fast',
    host: 'codex',
    claimed_paths: ['src/calc.js'],
    test_paths: ['tests/calc.test.js'],
    requirements: ['R1'],
    risk_triggers: [],
    behavioral: true,
    plan_contract_version: 2,
    hooks_trusted: true,
    subagents_available: true,
    explicit_invocation: true,
    ...overrides,
  };
}

describe('APE v2 Run Observability & Per-Run Facts Derivation', () => {
  describe('deriveRunFacts operational fact extraction', () => {
    it('derives dispatch state, model tier, and stage facts from active tickets', () => {
      const state = {
        run_id: 'run-obs-1',
        mode: 'phase',
        lane: 'fast',
        stage: 'planner',
        status: 'running',
        tickets: [
          {
            ticket_id: 'run-obs-1:planner:1',
            stage_id: 'planner',
            role: 'planner',
            model_tier: 'deep',
            model: { model: 'opus' },
            attempt: 1,
            claimed_paths: ['src/calc.js'],
            test_paths: ['tests/calc.test.js'],
          },
        ],
        receipts: [],
        attempts: { planner: 1 },
      };

      const facts = deriveRunFacts(state, { dispatchState: 'live' });
      expect(facts).toMatchObject({
        dispatch_state: 'live',
        model_tier: 'deep',
        stage: 'planner',
        active_role: 'planner',
      });
    });

    it('derives retry attempt counts and expiration facts accurately', () => {
      const state = {
        run_id: 'run-obs-retry',
        mode: 'phase',
        lane: 'full',
        stage: 'test_writer',
        status: 'running',
        tickets: [
          {
            ticket_id: 'run-obs-retry:test:1',
            stage_id: 'test',
            role: 'test_writer',
            model_tier: 'balanced',
            attempt: 1,
          },
          {
            ticket_id: 'run-obs-retry:test:2',
            stage_id: 'test',
            role: 'test_writer',
            model_tier: 'balanced',
            attempt: 2,
          },
        ],
        expired_tickets: ['run-obs-retry:test:1'],
        receipts: [],
        attempts: { test: 2 },
      };

      const facts = deriveRunFacts(state, { dispatchState: 'needs-redispatch' });
      expect(facts.retry).toMatchObject({
        attempt: 2,
        retry_count: 1,
      });
      expect(facts.expiry).toMatchObject({
        expired_count: 1,
        expired_tickets: ['run-obs-retry:test:1'],
      });
    });

    it('derives remediation routing and cycle progression facts', () => {
      const state = {
        run_id: 'run-obs-remediation',
        mode: 'phase',
        lane: 'fast',
        stage: 'remediation-test',
        status: 'running',
        remediation_cycles: 2,
        remediation_route: {
          route: 'test',
          test_paths: ['tests/calc.test.js'],
          cycle: 2,
        },
        tickets: [],
        receipts: [],
      };

      const facts = deriveRunFacts(state);
      expect(facts.remediation).toMatchObject({
        active: true,
        route: 'test',
        cycle: 2,
        test_paths: ['tests/calc.test.js'],
      });
    });

    it('derives input-hold state and pending questions metadata', () => {
      const state = {
        run_id: 'run-obs-input-hold',
        mode: 'phase',
        lane: 'fast',
        stage: 'preflight',
        status: 'running',
        input_required: {
          preflight_hash: 'abc123hash',
          question_ids: ['Q1', 'Q2'],
          questions: [
            { id: 'Q1', question: 'Should we support floats?' },
            { id: 'Q2', question: 'Target Node version?' },
          ],
        },
        tickets: [],
        receipts: [],
      };

      const facts = deriveRunFacts(state);
      expect(facts.input_hold).toMatchObject({
        active: true,
        preflight_hash: 'abc123hash',
        question_count: 2,
        question_ids: ['Q1', 'Q2'],
      });
    });

    it('derives scope, verification profile, timing, and block details', () => {
      const state = {
        run_id: 'run-obs-scope-block',
        mode: 'phase',
        lane: 'mechanical',
        stage: 'gates',
        status: 'blocked',
        block_reason: 'deterministic gate failure: typecheck',
        created_at: '2026-08-01T10:00:00.000Z',
        updated_at: '2026-08-01T10:05:00.000Z',
        claimed_paths: ['src/calc.js', 'src/util.js'],
        test_paths: ['tests/calc.test.js'],
        preflight: {
          artifact: {
            verification_profiles: [
              { id: 'typecheck', disposition: 'required' },
              { id: 'lint', disposition: 'advisory' },
            ],
          },
        },
        tickets: [],
        receipts: [
          {
            receipt_id: 'r1',
            status: 'passed',
            timing: { duration_ms: 1250 },
          },
        ],
      };

      const facts = deriveRunFacts(state);
      expect(facts.scope).toMatchObject({
        claimed_path_count: 2,
        test_path_count: 1,
      });
      expect(facts.profile).toMatchObject({
        required_profile_count: 1,
        required_profile_ids: ['typecheck'],
      });
      expect(facts.timing).toMatchObject({
        started_at: '2026-08-01T10:00:00.000Z',
        elapsed_ms: 300_000,
      });
      expect(facts.block).toMatchObject({
        is_blocked: true,
        reason: 'deterministic gate failure: typecheck',
      });
    });
  });

  describe('compactStatus enriched facts integration', () => {
    it('surfaces derived operational facts in compact status for active runs', async () => {
      const dir = await createProject();
      await startRun(dir, baseStartInput());

      const compact = await compactStatus(dir);
      expect(compact.ok).toBe(true);
      expect(compact.active).toBe(true);
      expect(compact.facts).toBeDefined();
      expect(compact.facts).toMatchObject({
        dispatch_state: 'needs-redispatch',
        stage: 'preflight',
        model_tier: expect.any(String),
        scope: {
          claimed_path_count: 1,
          test_path_count: 1,
        },
      });
      expect(compact.diagnostic).toMatchObject({
        reason_code: 'dispatch_pending',
        next_safe_action: 'ape_run resume',
      });
    });

    it('returns empty/null facts safely when no run is active', async () => {
      const dir = await createProject();
      const compact = await compactStatus(dir);

      expect(compact.ok).toBe(true);
      expect(compact.active).toBe(false);
      expect(compact.facts ?? null).toBeNull();
    });

    it('enforces wire response bounds and character sanitization on facts payload', async () => {
      const dir = await createProject();
      await startRun(dir, baseStartInput());
      const paths = runtimePaths(dir);
      const state = await readJson(paths.active, null);

      // Inject large collections and dangerous bidi/control characters
      state.block_reason = `Block reason with \u202Ereversed text\u202C and \u0000control bytes ${'x'.repeat(5000)}`;
      state.tickets = Array.from({ length: 50 }, (_, i) => ({
        ticket_id: `run-unit:implement:${i}`,
        stage_id: 'implement',
        role: 'implementer',
        model_tier: 'balanced',
        attempt: 1,
      }));
      await atomicWriteJson(paths.active, state);

      const compact = await compactStatus(dir);
      const serialized = JSON.stringify(compact);
      expect(serialized.length).toBeLessThan(RESPONSE_BUDGET_CHARS);
      expect(compact.facts).toBeDefined();
      expect(compact.facts.block).not.toHaveProperty('reason');
      expect(compact.gate).not.toHaveProperty('blocker');
      expect(compact.diagnostic.recovery_rationale).not.toContain('\u0000');
      expect(compact.diagnostic.recovery_rationale).not.toContain('\u202E');
      expect(serialized).not.toContain('Block reason with');
    });

    it('never forwards malformed pending, receipt, retry, or remediation scalars', async () => {
      const dir = await createProject();
      await startRun(dir, baseStartInput());
      const paths = runtimePaths(dir);
      const state = await readJson(paths.active, null);
      const bidi = String.fromCharCode(0x202e);
      const secret = `PRIVATE_SCALAR_SENTINEL_${bidi}${'x'.repeat(5000)}`;
      state.stage = 'remediation-test';
      state.tickets = [{
        ticket_id: secret,
        stage_id: secret,
        role: secret,
        model_tier: secret,
        attempt: { private: secret },
        deadline_at: { private: secret },
      }];
      state.receipts = [{
        receipt_id: secret,
        ticket_id: 'run-safe:completed:ticket',
        stage_id: secret,
        role: secret,
        status: secret,
      }];
      state.remediation_route = {
        route: 'test',
        cycle: { private: secret },
        test_paths: [secret],
      };
      await atomicWriteJson(paths.active, state);

      const compact = await compactStatus(dir);
      const serialized = JSON.stringify(compact);
      expect(serialized.length).toBeLessThan(RESPONSE_BUDGET_CHARS);
      expect(serialized).not.toContain('PRIVATE_SCALAR_SENTINEL');
      expect(serialized).not.toContain(bidi);
      expect(['undefined', 'number']).toContain(typeof compact.facts?.retry?.attempt);
      expect(['undefined', 'number']).toContain(typeof compact.facts?.remediation?.cycle);
      if (compact.pending) {
        expect(JSON.stringify(compact.pending)).not.toContain('PRIVATE_SCALAR_SENTINEL');
      }
      if (compact.last_receipt) {
        expect(JSON.stringify(compact.last_receipt)).not.toContain('PRIVATE_SCALAR_SENTINEL');
      }
    });
  });
});
