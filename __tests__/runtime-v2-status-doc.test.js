import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { blockRecoveryHint, renderStatusDoc } from '../lib/runtime/status-doc.js';

// Behavioral test for the pure status-doc projector. Expectations are derived
// from the objective's public contract: renderStatusDoc(state) returns a
// human-readable Markdown string projecting an APE run's machine state.
// The fast lane milestone order is: test -> build -> review.
describe('ape v2 renderStatusDoc', () => {
  const runningState = {
    mode: 'phase',
    lane: 'fast',
    status: 'running',
    stage: 'build',
    objective: 'Add a status doc',
    branch: 'ape/phase-abc',
    tickets: [{ ticket_id: 't1' }, { ticket_id: 't2' }],
    receipts: [{ ticket_id: 't1' }],
  };

  it('returns a Markdown string without surfacing the objective', () => {
    const doc = renderStatusDoc(runningState);
    expect(typeof doc).toBe('string');
    expect(doc).not.toContain('Add a status doc');
    expect(doc).not.toContain('**Objective:**');
  });

  it('surfaces the mode and lane as phase/fast', () => {
    const doc = renderStatusDoc(runningState);
    expect(doc).toContain('phase/fast');
  });

  it('does not render an enumerated objective as a side channel', () => {
    const doc = renderStatusDoc({
      ...runningState,
      objective:
        'Two workstreams. (1) Fix the parser so nested markers survive. (2) Release 2.3.3 with a changelog entry.',
    });
    expect(doc).not.toContain('Two workstreams');
    expect(doc).not.toContain('Fix the parser');
    expect(doc).not.toContain('Release 2.3.3');
  });

  it('does not render an objective made only of list items', () => {
    const doc = renderStatusDoc({
      ...runningState,
      objective: '(1) First thing. (2) Second thing.',
    });
    expect(doc).not.toContain('First thing');
    expect(doc).not.toContain('Second thing');
  });

  it('does not render a lone objective marker', () => {
    const doc = renderStatusDoc({
      ...runningState,
      objective: 'Honor invariant (1) everywhere it applies.',
    });
    expect(doc).not.toContain('Honor invariant');
  });

  it('does not render out-of-order objective markers', () => {
    const doc = renderStatusDoc({
      ...runningState,
      objective: 'Compare case (2) against case (1) before deciding.',
    });
    expect(doc).not.toContain('Compare case');
  });

  it('shows stage N of M progress (build is 2 of 3 in the fast lane)', () => {
    const doc = renderStatusDoc(runningState);
    expect(doc).toMatch(/2\s+of\s+3/i);
  });

  it('renders a milestone checklist with completed, pending, and here markers', () => {
    const doc = renderStatusDoc(runningState);
    // test milestone completed
    expect(doc).toMatch(/\[x\][^\n]*test/i);
    // build is the current milestone: pending + "you are here" marker
    expect(doc).toMatch(/\[ \][^\n]*build[^\n]*◀/i);
    // review still pending
    expect(doc).toMatch(/\[ \][^\n]*review/i);
  });

  it('reflects the single pending ticket', () => {
    const doc = renderStatusDoc(runningState);
    expect(doc).toMatch(/1[^\n]*pending/i);
  });

  it('does not include the repository branch name', () => {
    const doc = renderStatusDoc(runningState);
    expect(doc).not.toContain('ape/phase-abc');
  });

  it('includes a Next: line', () => {
    const doc = renderStatusDoc(runningState);
    expect(doc).toMatch(/Next:/);
  });

  it.each([
    ['schema_version', 'PRIVATE_STATUS_DOC_SCHEMA'],
    ['mode', 'PRIVATE_STATUS_DOC_MODE'],
    ['lane', 'PRIVATE_STATUS_DOC_LANE'],
    ['status', 'PRIVATE_STATUS_DOC_STATUS'],
    ['stage', 'PRIVATE_STATUS_DOC_STAGE'],
    ['host', 'PRIVATE_STATUS_DOC_HOST'],
    ['dispatch_state', 'PRIVATE_STATUS_DOC_DISPATCH'],
  ])('validates %s before rendering status.md and never echoes its invalid value', (field, secret) => {
    const state = {
      schema_version: '2.0.0',
      run_id: 'run-status-doc-no-echo',
      objective: 'PRIVATE_STATUS_DOC_OBJECTIVE',
      mode: 'phase',
      lane: 'fast',
      host: 'codex',
      status: 'running',
      stage: 'build',
      dispatch_state: 'none',
      tickets: [],
      receipts: [],
      expired_tickets: [],
      [field]: secret,
    };
    const doc = renderStatusDoc(state);
    expect(doc).toContain('corrupt_state');
    expect(doc).toContain('ape_run override reset');
    expect(doc).not.toContain(secret);
    expect(doc).not.toContain('PRIVATE_STATUS_DOC_OBJECTIVE');
    expect(doc.length).toBeLessThan(8192);
  });

  it('fails status.md closed on max-plus-one collections before reading a getter-backed tail', () => {
    let reads = 0;
    const tickets = Array.from({ length: 257 }, (_, index) => ({
      ticket_id: `run-status-doc-tail:build:${index}`,
      stage_id: 'build',
      role: 'implementer',
    }));
    Object.defineProperty(tickets, 256, {
      enumerable: true,
      get() {
        reads += 1;
        throw new Error('PRIVATE_STATUS_DOC_TAIL_READ');
      },
    });
    const doc = renderStatusDoc({
      schema_version: '2.0.0',
      run_id: 'run-status-doc-tail',
      objective: 'PRIVATE_STATUS_DOC_OBJECTIVE',
      mode: 'phase',
      lane: 'fast',
      host: 'codex',
      status: 'running',
      stage: 'build',
      dispatch_state: 'none',
      tickets,
      receipts: [],
      expired_tickets: [],
    });
    expect(reads).toBe(0);
    expect(doc).toContain('corrupt_state');
    expect(doc).toContain('ape_run override reset');
    expect(doc).not.toContain('PRIVATE_STATUS_DOC_TAIL_READ');
    expect(doc).not.toContain('PRIVATE_STATUS_DOC_OBJECTIVE');
    expect(doc.length).toBeLessThan(8192);
  });

  it('surfaces stable recovery semantics without the raw block reason', () => {
    const doc = renderStatusDoc({
      mode: 'phase',
      lane: 'fast',
      status: 'blocked',
      stage: 'review',
      objective: 'Add a status doc',
      branch: 'ape/phase-abc',
      block_reason: 'review gate failed',
      tickets: [{ ticket_id: 't1' }],
      receipts: [],
    });
    expect(doc).not.toContain('review gate failed');
    expect(doc.toLowerCase()).toContain('blocked');
    expect(doc).toContain('Reason code: blocked');
    expect(doc).toContain('ape_run abort or ape_run override reset');
  });

  it('marks earlier milestones done when the stage sits past the displayed list', () => {
    // A fast run blocked at `gates` is past review, which is not a displayed
    // fast-lane milestone — test/build/review should all read done regardless.
    const doc = renderStatusDoc({
      mode: 'phase',
      lane: 'fast',
      status: 'blocked',
      stage: 'gates',
      objective: 'Add a status doc',
      branch: 'ape/phase-abc',
      block_reason: 'one or more deterministic merge gates failed',
      tickets: [],
      receipts: [],
    });
    expect(doc).toMatch(/\[x\][^\n]*test/i);
    expect(doc).toMatch(/\[x\][^\n]*build/i);
    expect(doc).toMatch(/\[x\][^\n]*review/i);
    expect(doc).not.toContain('◀'); // no "you are here" — gates isn't a displayed milestone
  });

  it('renders the land pipeline (review/gates/merge) whatever lane classification stamped', () => {
    // pipeline.js branches on mode 'land' before any lane check, and
    // classifyLane never returns 'land' — a land run carries fast/full/
    // mechanical. The renderer must not paint test/build (or plan) milestones
    // as done that never existed in the land pipeline (invariant 8).
    for (const lane of ['fast', 'full', 'mechanical']) {
      const doc = renderStatusDoc({
        mode: 'land',
        lane,
        status: 'running',
        stage: 'review',
        objective: 'Gate and land the finished diff',
        branch: 'ape/land-abc',
        tickets: [{ ticket_id: 't1' }],
        receipts: [],
      });
      expect(doc).toMatch(/1\s+of\s+3/i);
      expect(doc).toMatch(/\[ \][^\n]*review[^\n]*◀/i);
      expect(doc).toMatch(/- \[ \] gates/i);
      expect(doc).toMatch(/- \[ \] merge/i);
      expect(doc).not.toMatch(/- \[.\] test\b/i);
      expect(doc).not.toMatch(/- \[.\] build\b/i);
      expect(doc).not.toMatch(/- \[.\] plan\b/i);
    }
  });

  it('shows all milestones done for a completed state', () => {
    const doc = renderStatusDoc({
      mode: 'phase',
      lane: 'fast',
      status: 'completed',
      stage: 'review',
      objective: 'Add a status doc',
      branch: 'ape/phase-abc',
      tickets: [{ ticket_id: 't1' }],
      receipts: [{ ticket_id: 't1' }],
    });
    // every fast-lane milestone is checked off
    expect(doc).toMatch(/\[x\][^\n]*test/i);
    expect(doc).toMatch(/\[x\][^\n]*build/i);
    expect(doc).toMatch(/\[x\][^\n]*review/i);
    expect(doc.toLowerCase()).toContain('completed');
    expect(doc).toContain('Reason code: completed');
  });
});
// The recovery hint is derived at render time, never persisted in
// block_reason: the archived reason stays immutable evidence (invariant 4)
// while the guidance can name whichever audited exit fits the block.
describe('ape v2 status-doc block recovery hint', () => {
  const blockedBase = {
    mode: 'phase',
    lane: 'full',
    status: 'blocked',
    objective: 'Add a status doc',
    branch: 'ape/phase-abc',
    tickets: [],
    receipts: [],
  };

  it('names REGATE and the bounded attempt budget for a gate block', () => {
    const doc = renderStatusDoc({
      ...blockedBase,
      stage: 'gates',
      block_reason: 'one or more deterministic merge gates failed',
    });
    expect(doc).toContain('**Recovery:**');
    expect(doc).toContain('REGATE');
    expect(doc).toContain('0 of 3 bounded attempts used');
  });

  it('counts consumed re-gate attempts in the hint', () => {
    const doc = renderStatusDoc({
      ...blockedBase,
      stage: 'gates',
      regate_attempts: 2,
      block_reason: 'one or more deterministic merge gates failed',
    });
    expect(doc).toContain('2 of 3 bounded attempts used');
  });

  it('drops the REGATE directive once the bounded budget is exhausted', () => {
    // At MAX_REGATE_ATTEMPTS the scheduler's REGATE arm categorically rejects
    // ("re-gate attempt limit reached"), so the hint must stop directing the
    // operator there (invariant 8) and name the audited exits instead.
    const doc = renderStatusDoc({
      ...blockedBase,
      stage: 'gates',
      regate_attempts: 3,
      block_reason: 'one or more deterministic merge gates failed',
    });
    expect(doc).toContain('**Recovery:**');
    expect(doc).not.toContain('re-gate with REGATE');
    expect(doc).toContain('exhausted');
    expect(doc).toContain('3 of 3 attempts used');
    expect(doc).toContain('ABORT the run or OVERRIDE reset');
  });

  it('tells a blocked land run the diff is revised outside APE', () => {
    const doc = renderStatusDoc({
      ...blockedBase,
      mode: 'land',
      lane: 'land',
      stage: 'review',
      block_reason: 'review disagreement on a land run cannot be remediated: mode land has no writing stage; revise the diff outside APE and start a new land run',
    });
    expect(doc).toContain('**Recovery:**');
    expect(doc).toContain('no writing stage');
    expect(doc).toContain('revise the diff outside APE');
  });

  it('sends a land run held at merge (auto-merge disabled) to the ship arm, not the land arm', () => {
    // A land run blocked at stage 'merge' by 'auto-merge is disabled by
    // configuration' passed review and every gate — it is green-but-held, so
    // "revise the diff and start a new land run" would loop back to the
    // identical hold. The hint names SHIP (re-prove and merge) plus the
    // leave-held audited exits instead.
    const doc = renderStatusDoc({
      ...blockedBase,
      mode: 'land',
      lane: 'land',
      stage: 'merge',
      block_reason: 'auto-merge is disabled by configuration',
    });
    expect(doc).toContain('**Recovery:**');
    expect(doc).not.toContain('revise the diff outside APE');
    expect(doc).toContain('ABORT the run or OVERRIDE reset');
    expect(doc).toContain('ship');
  });

  it('names ship and the leave-held option for a run held at merge by disabled auto-merge', () => {
    const hint = blockRecoveryHint({
      ...blockedBase,
      mode: 'phase',
      lane: 'mechanical',
      stage: 'merge',
      block_reason: 'auto-merge is disabled by configuration',
    });
    expect(hint).toContain('ship');
    expect(hint).toContain('leave it held');
    expect(hint).toContain('ABORT the run or OVERRIDE reset');
  });

  it('offers the audited ABORT/OVERRIDE path for a non-gate, non-land block', () => {
    const doc = renderStatusDoc({
      ...blockedBase,
      stage: 'build',
      block_reason: 'stage build failed twice',
    });
    expect(doc).toContain('**Recovery:**');
    expect(doc).toContain('ABORT the run or OVERRIDE reset');
  });

  it('gives a land run blocked at the gates the REGATE hint, not the land hint (branch order)', () => {
    const hint = blockRecoveryHint({
      ...blockedBase,
      mode: 'land',
      lane: 'land',
      stage: 'gates',
      block_reason: 'one or more deterministic merge gates failed',
    });
    expect(hint).toContain('REGATE');
    expect(hint).not.toContain('outside APE');
  });

  it('renders no recovery line for a running state', () => {
    const doc = renderStatusDoc({
      mode: 'phase',
      lane: 'fast',
      status: 'running',
      stage: 'build',
      objective: 'Add a status doc',
      branch: 'ape/phase-abc',
      tickets: [],
      receipts: [],
    });
    expect(doc).not.toContain('**Recovery:**');
  });
});

// The document's single top-level guidance line — `Next: <...>`. The gating
// watch emits a bolded `**Next:**` line of its own, so anchor on the bare form
// the renderer always appends.
const nextLine = (doc) => doc.split('\n').find((line) => line.startsWith('Next:')) ?? '';

// A run is persisted (and status.md written) the instant START reduces, at
// status 'running' / stage 'dispatch' with the first ticket issued and pending
// dispatch. The projection must render that live moment truthfully (invariant
// 8): the full pipeline's first milestone is plan, so a just-started full-lane
// run sits AT plan — not at "stage 0 of 6" with every box empty and nothing to
// do.
describe('ape v2 status-doc dispatch stage', () => {
  const dispatchState = {
    mode: 'phase',
    lane: 'full',
    status: 'running',
    stage: 'dispatch',
    objective: 'Render dispatch and aborted truthfully',
    branch: 'ape/phase-abc',
    tickets: [{ ticket_id: 't1' }],
    receipts: [],
  };

  it('places a just-started full-lane run at the first milestone, not at stage 0', () => {
    const doc = renderStatusDoc(dispatchState);
    expect(doc).toMatch(/stage 1 of 6/i);
    expect(doc).not.toMatch(/stage 0 of 6/i);
  });

  it('marks plan as the current milestone while the plan ticket awaits dispatch', () => {
    const doc = renderStatusDoc(dispatchState);
    // plan is where the run IS: unchecked, carrying the you-are-here marker.
    expect(doc).toMatch(/- \[ \] plan[^\n]*◀/);
    // Nothing has been produced yet, so no milestone may read done.
    expect(doc).not.toContain('[x]');
  });

  it('does not tell the reader to await the scheduler while a ticket is pending', () => {
    const doc = renderStatusDoc(dispatchState);
    // The one pending ticket IS the queued work; "await scheduler" denies it.
    expect(doc).toMatch(/\*\*Pending tickets:\*\* 1 pending/);
    expect(nextLine(doc)).not.toMatch(/await scheduler/i);
    expect(nextLine(doc).trim()).not.toBe('Next:');
  });
});

describe('ape v2 status-doc bounded recovery stages', () => {
  it.each([
    ['plan-replan', 'full', 'plan', 6],
    ['test-reconcile', 'fast', 'test', 3],
    ['test-recheck', 'fast', 'test', 3],
  ])('renders active %s at the %s milestone instead of corrupt or stage zero', (stage, lane, milestone, total) => {
    const doc = renderStatusDoc({
      mode: 'phase',
      lane,
      status: 'running',
      stage,
      tickets: [{ ticket_id: `ticket-${stage}` }],
      receipts: [],
    });
    expect(doc).not.toContain('corrupt_state');
    expect(doc).not.toMatch(new RegExp(`stage 0 of ${total}`, 'i'));
    expect(doc).toMatch(new RegExp(`- \\[ \\] ${milestone}[^\\n]*◀`, 'i'));
  });
});

// A terminal `aborted` run is sealed: the lock is released, history is
// archived, and no scheduler will ever act on it again. Unlike the override
// reset path, status.md survives — so it must not tell its reader to wait for
// a scheduler that is done with this run (invariant 8).
describe('ape v2 status-doc terminal aborted run', () => {
  const abortedState = {
    mode: 'phase',
    lane: 'full',
    status: 'aborted',
    stage: 'aborted',
    objective: 'Render dispatch and aborted truthfully',
    branch: 'ape/phase-abc',
    abort_reason: 'operator abort: superseded by a newer run',
    tickets: [{ ticket_id: 't1' }],
    receipts: [],
  };

  it('states the run is aborted instead of promising more scheduling', () => {
    const next = nextLine(renderStatusDoc(abortedState));
    expect(next).not.toMatch(/await scheduler/i);
    expect(next).toMatch(/abort/i);
  });

  it('does not dress the sealed run up as completed or in progress', () => {
    const doc = renderStatusDoc(abortedState);
    expect(doc.toLowerCase()).toContain('aborted');
    // Aborted is not completed: no milestone is checked off by the abort, and
    // a dead run has no "you are here".
    expect(doc).not.toContain('[x]');
    expect(doc).not.toContain('◀');
    expect(nextLine(doc)).not.toMatch(/run complete/i);
  });

  it('keeps the blocked-run guidance ahead of any terminal wording', () => {
    // The aborted arm must not swallow the block arms: a blocked run still
    // reads "resolve block: <reason>" with its recovery hint.
    const doc = renderStatusDoc({
      ...abortedState,
      status: 'blocked',
      stage: 'gates',
      abort_reason: undefined,
      block_reason: 'one or more deterministic merge gates failed',
    });
    expect(nextLine(doc)).toContain('ape_run regate');
    expect(nextLine(doc)).not.toContain('one or more deterministic merge gates failed');
    expect(doc).toContain('**Recovery:**');
  });
});

// status-doc.js and bin/ape-statusline.mjs are two renderers of ONE machine
// state, and status-doc.js:40 claims their milestone view is identical. Pin
// that claim for the dispatch stage by asking the statusline itself — spawned
// exactly as a host spawns it — which milestone a dispatch-stage run occupies,
// then requiring the status-doc projection to place the run at that same
// milestone. Neither renderer can drift alone.
const STATUSLINE = fileURLToPath(new URL('../bin/ape-statusline.mjs', import.meta.url));
// eslint-disable-next-line no-control-regex
const stripAnsi = (text) => text.replace(/\x1b\[[0-9;]*m/g, '');

function statuslineMilestoneWord(run) {
  const dir = mkdtempSync(join(tmpdir(), 'ape-status-doc-parity-'));
  try {
    mkdirSync(join(dir, '.ape', 'runtime'), { recursive: true });
    writeFileSync(join(dir, '.ape', 'runtime', 'active.json'), JSON.stringify(run));
    const env = {
      ...process.env,
      APE_STATUSLINE_CHARSET: 'unicode',
      APE_STATUSLINE_GIT_TIMEOUT_MS: '5000',
    };
    // The renderer honours host project pins; strip the ambient ones so this
    // repo cannot leak into the scratch project's root resolution.
    delete env.CLAUDE_PROJECT_DIR;
    delete env.CODEX_CWD;
    const out = stripAnsi(execFileSync('node', [STATUSLINE], {
      input: JSON.stringify({ workspace: { current_dir: dir } }),
      encoding: 'utf8',
      env,
    }));
    // unicode charset joins every segment with ' · '; the milestone-carrying
    // stage box is the segment right after the `APE <mode>/<lane>` identity box.
    const parts = out.split(' · ').map((part) => part.trim());
    const identity = parts.findIndex((part) => part.startsWith('APE '));
    return identity >= 0 ? parts[identity + 1] ?? null : null;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe('ape v2 status-doc / statusline dispatch parity', () => {
  it('places a dispatch-stage run at the same milestone both renderers report', () => {
    const run = {
      mode: 'phase',
      lane: 'full',
      status: 'running',
      stage: 'dispatch',
      tickets: [{ ticket_id: 't1' }],
      receipts: [],
    };
    const word = statuslineMilestoneWord(run);
    // The statusline's own answer for the dispatch stage — the plan milestone.
    expect(word).toBe('plan');
    const doc = renderStatusDoc({ ...run, objective: 'Parity', branch: 'ape/phase-abc' });
    // …and the status doc must put the run at exactly that milestone.
    expect(doc).toMatch(new RegExp(`- \\[ \\] ${word}[^\\n]*◀`));
  });

  it.each([
    ['pending', 'dispatch_pending', 'ape_run resume'],
    ['live', 'dispatch_live', 'wait for pending receipt'],
  ])('renders %s dispatch semantics supplied by the shared projection context', (dispatchState, reason, action) => {
    const run = {
      mode: 'phase',
      lane: 'full',
      status: 'running',
      stage: 'dispatch',
      tickets: [{ ticket_id: 't1' }],
      receipts: [],
    };
    const doc = renderStatusDoc(run, { dispatchState });
    expect(doc).toContain(`Reason code: ${reason}`);
    expect(doc).toContain(`Next safe action: ${action}`);
  });

  it.each([
    ['absent', undefined],
    ['not returned', {
      status: 'retained',
      base_branch: 'main',
      run_branch: 'ape/phase-terminal-cleanup',
      retained: true,
      deleted: false,
    }],
  ])('projects ape_run resume when terminal checkout cleanup is %s', (_label, cleanup) => {
    const run = {
      schema_version: '2.0.0',
      run_id: 'run-terminal-cleanup-doc',
      objective: 'Return the retained checkout',
      mode: 'phase',
      lane: 'fast',
      host: 'codex',
      status: 'completed',
      stage: 'completed',
      dispatch_state: 'none',
      base_branch: 'main',
      branch: 'ape/phase-terminal-cleanup',
      tickets: [],
      receipts: [],
      ...(cleanup === undefined ? {} : { checkout_cleanup: cleanup }),
    };
    const doc = renderStatusDoc(run);
    expect(doc).toMatch(/Next:.*ape_run resume/);
    expect(doc).not.toContain('ape_run start');
  });
});
