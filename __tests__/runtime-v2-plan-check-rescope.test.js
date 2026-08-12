import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

// The plan_checker role is scoped to mechanical verification while plan_critic
// owns feasibility judgment. Ticket objectives are immutable run intent, so the
// runtime coordination contract is now structural: stage_id/role select the
// plan-checker prompt, required_checks stays explicit, and output_schema carries
// the receipt contract without decorating the operator's objective.
//
// Ship (GitHub) is the only runtime-owned side effect this behavioral test must
// not perform for real; the run stops at plan-review and never reaches shipping,
// but the mock keeps the harness faithful to runtime-v2-service.test.js.
vi.mock('../lib/runtime/gates.js', async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, autoMergeGithub: vi.fn(), pollRemoteChecksAndMerge: vi.fn() };
});
import { recordReceipt, startRun } from '../lib/runtime/service.js';
import { autoMergeGithub, pollRemoteChecksAndMerge } from '../lib/runtime/gates.js';
import { runtimePaths } from '../lib/runtime/paths.js';
import { atomicWriteJson } from '../lib/runtime/storage.js';

const cleanups = [];
afterEach(async () => {
  pollRemoteChecksAndMerge.mockReset();
  autoMergeGithub.mockReset();
  await Promise.all(cleanups.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

function git(cwd, ...args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

async function project() {
  const dir = await mkdtemp(path.join(tmpdir(), 'ape-plan-check-rescope-'));
  cleanups.push(dir);
  await mkdir(path.join(dir, 'src'));
  await mkdir(path.join(dir, 'tests'));
  await writeFile(path.join(dir, 'src', 'value.js'), 'export const value = 1;\n');
  await writeFile(path.join(dir, 'tests', 'value.test.js'), 'throw new Error("red");\n');
  git(dir, 'init', '-q');
  git(dir, 'config', 'user.email', 'ape@example.test');
  git(dir, 'config', 'user.name', 'APE Test');
  git(dir, 'add', '.');
  git(dir, 'commit', '-qm', 'test: baseline');
  const paths = runtimePaths(dir);
  await atomicWriteJson(paths.config, {
    shipping: { auto_merge: false, provider: 'github', required_remote_checks: false },
    test_commands: { full: 'node --test' },
  });
  return dir;
}

function receipt(ticket, overrides = {}) {
  return {
    ticket_id: ticket.ticket_id,
    status: 'passed',
    agent_identity: `agent-${ticket.role}`,
    tests: [],
    findings: [],
    evidence: { verdict: 'pass' },
    timing: {
      started_at: ticket.issued_at,
      completed_at: new Date(Date.parse(ticket.issued_at) + 10).toISOString(),
      duration_ms: 10,
    },
    ...overrides,
  };
}

describe('APE v2 plan-check rescope to mechanical verification', () => {
  it('issues a full-lane plan-check ticket with verbatim intent and the plan-checker role/schema', async () => {
    const dir = await project();
    // A distinct harness objective that deliberately does NOT contain the phrase
    // 'completeness and feasibility', so the not-contains assertion is answered
    // solely by the plan-check prefix, never by the run objective suffix.
    const runObjective = 'Pin the rescoped plan-check ticket-objective prefix for this run';
    const started = await startRun(dir, {
      objective: runObjective,
      mode: 'phase',
      lane: 'full',
      host: 'codex',
      behavioral: true,
      claimed_paths: ['src/value.js'],
      test_paths: ['tests/value.test.js'],
      requirements: ['R1'],
      risk_triggers: [],
      hooks_trusted: true,
      subagents_available: true,
      explicit_invocation: true,
    });
    expect(started.ok).toBe(true);
    // Full lane requires non-empty test_paths and a clean tree; requested 'full'
    // always sticks. The first issued ticket is the read-only planner.
    expect(started.run.lane).toBe('full');
    const planTicket = started.run.tickets[0];
    expect(planTicket.stage_id).toBe('plan');
    expect(planTicket.role).toBe('planner');

    // Record a passed planner receipt. Codex host needs no capability token, and
    // no tree writes happen between start and record so the recomputed
    // changed_files stays empty and the read-only planner boundary holds.
    const recorded = await recordReceipt(dir, receipt(planTicket));
    expect(recorded.ok).toBe(true);

    // Completing the plan stage issues the plan-review pair (plan-check ∥
    // plan-critic). Inspect the plan-check ticket the real service emitted.
    const planCheck = recorded.run.tickets.find((ticket) => ticket.stage_id === 'plan-check');
    expect(planCheck).toBeDefined();
    expect(planCheck.role).toBe('plan_checker');

    expect(planCheck.objective).toBe(runObjective);
    expect(planCheck.objective).not.toContain('Run objective:');
    expect(planCheck.required_checks).toEqual([]);
    expect(planCheck.output_schema.required).toEqual(
      expect.arrayContaining(['ticket_id', 'status', 'tests', 'findings', 'evidence']),
    );
    expect(planCheck.claimed_paths).toEqual(['src/value.js', 'tests/value.test.js']);
  });
});
