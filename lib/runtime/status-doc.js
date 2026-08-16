// Pure projection of an APE run's machine state into human-readable Markdown.
// No imports of runtime state (pure constants are fine), no file reads, no side
// effects. Given a plain `state` object it returns a Markdown string. The
// scheduler owns transitions; this module only renders whatever state it is
// handed.

import { AUTO_MERGE_HOLD_REASON, MAX_REGATE_ATTEMPTS } from './constants.js';

const STAGE_TO_MILESTONE = {
  // The START reducer persists a fresh run at stage 'dispatch' with its first
  // ticket issued and pending, and persist() writes status.md at that exact
  // moment. Left unmapped, that live run rendered as "stage 0 of 6" with every
  // box empty and `Next: await scheduler` — untruthful about queued work
  // (invariant 8) — so dispatch maps to the pipeline's first milestone, plan.
  // bin/ape-statusline.mjs milestoneOf maps 'dispatch' to 'plan' too; the two
  // renderers project one state and must not drift apart.
  dispatch: 'plan',
  plan: 'plan',
  'plan-check': 'plan',
  'plan-critic': 'plan',
  'plan-judge': 'plan',
  test: 'test',
  // The remediation cycle's optional first stage (roadmap entry
  // remediation-test-path-role-gap): a test_writer correcting the authored test
  // a blocking review named. Left unmapped it would render the same
  // invariant-8 defect this table records for 'dispatch' — 'stage 0 of 3' with
  // every box unchecked and 'Next: await scheduler' while a ticket is pending.
  // bin/ape-statusline.mjs milestoneOf folds it into 'test' too; the two
  // renderers project one state and must not drift apart.
  'remediation-test': 'test',
  build: 'build',
  'remediation-build': 'build',
  review: 'review',
  'security-review': 'review',
  'remediation-review': 'review',
  'remediation-security-review': 'review',
  gates: 'gates',
  merge: 'merge',
  debug: 'debug',
  spike: 'spike',
};

// Derive the ordered milestone list the same way the runtime lanes do.
function milestonesFor(state) {
  // Mode alone selects the debug/spike single-milestone lists: LANES is
  // auto|mechanical|fast|full and classifyLane never stamps lane 'debug' or
  // 'spike', so a lane check here is dead code (audit s2.2a) — a state
  // carrying such a lane takes the documented unrecognized-lane fall-through
  // to the plan-first FULL list below.
  if (state?.mode === 'debug') return ['debug'];
  if (state?.mode === 'spike') return ['spike'];
  // Mode outranks lane, mirroring pipeline.js: land is review-only plus the
  // merge gates, and classifyLane never yields 'land' — every land run carries
  // fast/full/mechanical, so falling into a lane arm would render test/build
  // (or plan) milestones as done that never existed in its pipeline
  // (invariant 8). Keep this list identical to the statusline renderer's.
  if (state?.mode === 'land') return ['review', 'gates', 'merge'];
  if (state?.lane === 'mechanical') return ['build'];
  // fast lane ships test -> build -> review.
  if (state?.lane === 'fast') return ['test', 'build', 'review'];
  // Any other lane — 'full' or unrecognized — takes the plan-first FULL
  // pipeline: pipeline.js initialStages falls through to `plan` for every
  // non-mechanical/non-fast lane, and that fall-through is the shared
  // scheduler truth both this projection and bin/ape-statusline.mjs mirror.
  return ['plan', 'test', 'build', 'review', 'gates', 'merge'];
}

// Global pipeline order, so a milestone can be judged done/pending even when the
// run's current stage maps outside a lane's displayed list (e.g. a fast run
// sitting at `gates`, past `review`, should still show test/build/review done).
const GLOBAL_ORDER = ['plan', 'test', 'build', 'review', 'gates', 'merge', 'debug', 'spike'];

function currentMilestone(state, milestones) {
  const mapped = STAGE_TO_MILESTONE[state?.stage];
  if (mapped && milestones.includes(mapped)) return mapped;
  return null;
}

function pendingTicketCount(state) {
  const tickets = Array.isArray(state?.tickets) ? state.tickets : [];
  const receipts = Array.isArray(state?.receipts) ? state.receipts : [];
  const done = new Set(receipts.map((receipt) => receipt?.ticket_id));
  // Expired tickets can never be satisfied (late receipts are rejected), so
  // counting them as pending diverges from the scheduler's own definition.
  const expired = new Set(Array.isArray(state?.expired_tickets) ? state.expired_tickets : []);
  return tickets.filter(
    (ticket) => !done.has(ticket?.ticket_id) && !expired.has(ticket?.ticket_id),
  ).length;
}

// Recovery guidance is derived at render time and NEVER stored in
// block_reason: the archived reason is tree-bound evidence of WHY the run
// blocked (invariant 4), while the audited exits it points at — REGATE for a
// gate block under invariant 9's bounded no-bypass re-run, OVERRIDE/ABORT for
// everything else — are runtime policy that must be free to improve without
// rewriting history. Branch order matters: stage 'gates' wins over mode 'land'
// so a land run blocked at the gates still gets the REGATE hint — but only
// while budget remains: at MAX_REGATE_ATTEMPTS the scheduler's REGATE arm
// categorically rejects, so the hint must not direct the operator to a
// guaranteed dead end (invariant 8: the rendered guidance is untruthful the
// moment it names an action the runtime will refuse). A run held at stage
// 'merge' by disabled auto-merge is green-but-held, not broken: its arm sits
// after the gates arm and names SHIP (re-prove the full suite against the
// current tree, then merge) or the leave-held audited exits. The land arm
// speaks only while the DIFF itself was judged at fault (review/remediation);
// its `stage !== 'merge'` carve-out defers a land run's merge-hold to the SHIP
// arm above rather than telling the operator to "revise the diff and start a
// new run", which would loop back to the identical hold.
export function blockRecoveryHint(state) {
  if (state?.stage === 'gates') {
    const used = state?.regate_attempts ?? 0;
    if (used < MAX_REGATE_ATTEMPTS) {
      return `re-gate with REGATE after fixing the environment — the full gate suite re-runs with no bypass or waiver (${used} of ${MAX_REGATE_ATTEMPTS} bounded attempts used)`;
    }
    return `the bounded re-gate budget is exhausted (${used} of ${MAX_REGATE_ATTEMPTS} attempts used) and REGATE will be rejected — recover through the audited path: ABORT the run or OVERRIDE reset with a reason`;
  }
  if (state?.stage === 'merge' && state?.block_reason === AUTO_MERGE_HOLD_REASON) {
    return 'every gate is green and the run is held by shipping.auto_merge — ship to re-run the full gate suite against the current tree and merge (no waiver), or leave it held; otherwise ABORT the run or OVERRIDE reset with a reason';
  }
  if (state?.mode === 'land' && state?.stage !== 'merge') {
    return 'mode land has no writing stage — revise the diff outside APE and start a new land run (clear this run with an audited ABORT or OVERRIDE reset)';
  }
  return 'this block is not re-gateable — recover through the audited path: ABORT the run or OVERRIDE reset with a reason';
}

// Objectives are frequently authored as one long line with inline enumeration
// markers — "Four workstreams. (1) … (2) … (3) …" — which renders as an
// unreadable wall of text. When markers (1) and (2) (and onward) appear in
// ascending order, re-project the enumeration as a real Markdown ordered list:
// the text before (1) stays as the intro paragraph, each marker becomes a
// numbered item. Anything else renders inline, unchanged. Pure formatting —
// the stored objective is never modified (invariant 4: the evidence is the
// state; this module only renders it).
function objectiveLines(objective) {
  const text = String(objective);
  const markers = [];
  let from = 0;
  for (let n = 1; ; n += 1) {
    const marker = `(${n})`;
    const idx = text.indexOf(marker, from);
    if (idx < 0) break;
    markers.push({ idx, end: idx + marker.length, n });
    from = idx + marker.length;
  }
  if (markers.length < 2) return [`**Objective:** ${text}`];
  const intro = text.slice(0, markers[0].idx).trim();
  const lines = [intro ? `**Objective:** ${intro}` : '**Objective:**'];
  lines.push('');
  for (let i = 0; i < markers.length; i += 1) {
    const bodyEnd = i + 1 < markers.length ? markers[i + 1].idx : text.length;
    lines.push(`${markers[i].n}. ${text.slice(markers[i].end, bodyEnd).trim()}`);
  }
  return lines;
}

export function renderStatusDoc(state = {}, options = {}) {
  const mode = state?.mode ?? 'unknown';
  const lane = state?.lane ?? 'unknown';
  const status = state?.status ?? 'unknown';
  const objective = state?.objective ?? '(no objective)';
  const branch = state?.branch ?? '(no branch)';

  const milestones = milestonesFor(state);
  const current = currentMilestone(state, milestones);
  const currentIndex = current ? milestones.indexOf(current) : -1;
  const completed = status === 'completed';
  // Global rank of the run's current stage, used to mark milestones done even
  // when the stage sits past the displayed list (e.g. `gates` for a fast run).
  const currentRank = GLOBAL_ORDER.indexOf(STAGE_TO_MILESTONE[state?.stage]);
  // When the current stage maps outside the displayed list — past it (a fast
  // run at `gates`) or unmapped entirely (`aborted`) — the truthful stage
  // number is the count of displayed milestones actually completed under the
  // same GLOBAL_ORDER/currentRank rule the checkboxes below use, never a
  // blanket N of N beside unchecked boxes (invariant 8, audit s2.3).
  const stageNumber = currentIndex >= 0
    ? currentIndex + 1
    : milestones.filter(
        (milestone) => completed || (currentRank >= 0 && GLOBAL_ORDER.indexOf(milestone) < currentRank),
      ).length;

  const lines = [];
  lines.push(`# APE run — ${mode}/${lane}`);
  lines.push('');
  lines.push(...objectiveLines(objective));
  lines.push('');
  lines.push(`**Status:** ${status} — stage ${stageNumber} of ${milestones.length}`);

  if (state?.remediation_route) {
    const route = state.remediation_route;
    const counts = route.ownership_counts ?? {};
    lines.push('');
    lines.push(
      `**Remediation route:** ${route.route} — cycle ${route.cycle}; ` +
        `production ${counts.production ?? 0}, test ${counts.test ?? 0}, both ${counts.both ?? 0}`,
    );
    if (Array.isArray(route.test_paths) && route.test_paths.length > 0) {
      lines.push(`**Remediation test paths:** ${route.test_paths.join(', ')}`);
    }
  }

  if (status === 'blocked' && state?.block_reason) {
    lines.push('');
    lines.push(`**Blocked:** ${state.block_reason}`);
    lines.push('');
    lines.push(`**Recovery:** ${blockRecoveryHint(state)}`);
  }

  // The non-blocking gating watch: the detached merge-gate suite is running and
  // the run rests here between polls. A bounded, dedicated section so an
  // operator sees the poll count and the last summary without hunting the raw
  // state (mirrors the shipping-watch precedent).
  if (status === 'gating' && state?.gates_watch) {
    const watch = state.gates_watch;
    lines.push('');
    lines.push(`**Gating:** the detached merge-gate suite is running (poll ${watch.poll_count ?? 0})`);
    if (typeof watch.last_summary === 'string' && watch.last_summary.trim() !== '') {
      lines.push(`- ${watch.last_summary}`);
    }
    lines.push('');
    lines.push('**Next:** call `ape_run next` to poll the gate suite, or ABORT to abandon the run');
  }

  lines.push('');
  lines.push('## Milestones');
  lines.push('');
  for (let i = 0; i < milestones.length; i += 1) {
    const milestone = milestones[i];
    const isCurrent = i === currentIndex;
    // Done if the whole run completed, or this milestone ranks before the
    // current stage globally (so review reads done once the run reaches gates).
    const isDone = completed
      || (currentRank >= 0 && GLOBAL_ORDER.indexOf(milestone) < currentRank);
    const box = isDone ? '[x]' : '[ ]';
    const marker = isCurrent && !completed ? ' ◀ you are here' : '';
    lines.push(`- ${box} ${milestone}${marker}`);
  }

  const pending = pendingTicketCount(state);
  lines.push('');
  lines.push(`**Pending tickets:** ${pending} pending`);
  lines.push('');

  const merged = state?.merge ? ' (merged)' : '';
  lines.push(`**Branch:** ${branch}${merged}`);
  if (state?.checkout_cleanup && state.checkout_cleanup.status !== 'returned') {
    const cleanup = state.checkout_cleanup;
    lines.push(
      `**Checkout cleanup:** ${cleanup.status} — still on ${cleanup.run_branch ?? branch}; ` +
        `clean or commit retained work, then call \`ape_run resume\``,
    );
  }
  lines.push('');

  let next;
  if (state?.checkout_cleanup && state.checkout_cleanup.status !== 'returned') {
    next = 'call `ape_run resume` to retry checkout cleanup';
  } else if (completed) {
    next = 'run complete';
  } else if (status === 'blocked') {
    next = `resolve block: ${state?.block_reason ?? 'unknown'}`;
  } else if (status === 'aborted') {
    // Terminal and sealed: the lock is released and the run archived, and —
    // unlike the OVERRIDE reset path — status.md is NOT removed, so this
    // document outlives the run. No scheduler will ever act on it again, so it
    // must not promise one (invariant 8). The arm sits after the block arms so
    // a blocked run keeps its `resolve block:` guidance, and before the advance
    // arm so a stage that still maps to a milestone cannot promise progress.
    next = 'run aborted, no further scheduling';
  } else if (currentIndex >= 0 && currentIndex + 1 < milestones.length) {
    next = `advance to ${milestones[currentIndex + 1]}`;
  } else {
    next = 'await scheduler';
  }
  lines.push(`Next: ${next}`);
  lines.push('');

  // RM5 cold-boot projection: append the derived roadmap picture ONLY when a
  // non-null roadmap is supplied. A roadmap-less project (RM7) passes null (or
  // nothing) and the output stays byte-identical to the pre-roadmap document.
  const roadmap = options?.roadmap;
  if (roadmap) {
    const counts = roadmap.counts ?? {};
    lines.push('## Roadmap');
    lines.push('');
    lines.push(
      `**Requirements:** ${counts.satisfied ?? 0} satisfied · ${counts.in_progress ?? 0} in progress · ` +
        `${counts.ready ?? 0} ready · ${counts.pending ?? 0} pending · ${counts.stale ?? 0} stale`,
    );
    lines.push('');
    for (const entry of Array.isArray(roadmap.entries) ? roadmap.entries : []) {
      // Each follow-up is linked to its originating run (RM5): operator-seeded
      // entries carry no provenance suffix.
      const provenance =
        entry?.discovered_by && entry.discovered_by !== 'operator' ? ` (from ${entry.discovered_by})` : '';
      lines.push(`- ${entry?.id} — ${entry?.title} — ${entry?.status}${provenance}`);
    }
    lines.push('');
  }

  return lines.join('\n');
}
