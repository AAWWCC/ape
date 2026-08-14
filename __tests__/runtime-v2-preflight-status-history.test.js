import { describe, expect, it } from 'vitest';
import { projectRunState, summarizeHistoryRecord } from '../lib/runtime/projection.js';

const artifact = {
  version: 1, objective: 'Bounded objective',
  acceptance: ['A'], non_goals: ['N'], baseline: [],
  impacted_paths: { read: ['package.json'], write: ['src/value.js'] },
  compatibility: 'Keep callers stable.', rollback: 'Revert.',
  verification_profiles: [{ id: 'unit', disposition: 'required', reason: 'behavioral' }],
  questions: [{ id: 'api', question: 'Which name?', rationale: 'compatibility' }],
};

function run() {
  return {
    schema_version: '2.0.0', run_id: 'run-status', status: 'input_required',
    mode: 'phase', lane: 'full', stage: 'preflight', objective: 'Bounded objective',
    tickets: [], receipts: [],
    preflight: { version: 1, artifact_hash: 'a'.repeat(64), receipt_hash: 'b'.repeat(64), artifact },
    input_required: { preflight_hash: 'a'.repeat(64), question_ids: ['api'] },
  };
}

describe('bounded preflight status and history', () => {
  it('projects hashes, counts, ids, and dispositions without forwarding untrusted prose', () => {
    const projected = projectRunState(run());
    expect(projected.preflight).toEqual({
      version: 1, artifact_hash: 'a'.repeat(64), receipt_hash: 'b'.repeat(64),
      acceptance_count: 1, non_goal_count: 1,
      required_profile_ids: ['unit'], question_ids: ['api'],
    });
    expect(JSON.stringify(projected)).not.toContain('Which name?');
    expect(JSON.stringify(projected)).not.toContain('Keep callers stable');
  });

  it('keeps the same bounded preflight summary in bulk history records', () => {
    const record = { ...run(), completed_at: '2026-08-14T00:00:00.000Z', record_hash: 'c'.repeat(64) };
    expect(summarizeHistoryRecord(record).preflight).toEqual({
      version: 1, artifact_hash: 'a'.repeat(64), receipt_hash: 'b'.repeat(64),
      acceptance_count: 1, non_goal_count: 1,
      required_profile_ids: ['unit'], question_ids: ['api'],
    });
  });
});

