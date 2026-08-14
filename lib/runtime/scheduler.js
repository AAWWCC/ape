import {
  AUTO_MERGE_HOLD_REASON,
  LANES,
  MAX_REGATE_ATTEMPTS,
  MAX_REMEDIATION_CYCLES,
  MAX_STAGE_ATTEMPTS,
  SCOPE_EXPANSION_REASONS_MAX,
  TERMINAL_STATUSES,
} from './constants.js';
import { initialStages, nextStages, pendingSecurityReviewStages } from './pipeline.js';
import {
  approvedPlan,
  CandidatePlanSchema,
  PLAN_CONTRACT_VERSION,
} from './plan-contract.js';

function action(type, payload = {}) {
  return Object.freeze({ type, ...payload });
}

function expiredTicketIds(state) {
  return new Set(state.expired_tickets ?? []);
}

function activeTickets(state, group) {
  const expired = expiredTicketIds(state);
  return state.tickets.filter(
    (ticket) =>
      ticket.parallel_group === group &&
      !expired.has(ticket.ticket_id) &&
      !state.receipts.some((receipt) => receipt.ticket_id === ticket.ticket_id),
  );
}

function completedForGroup(state, group) {
  const latestByStage = new Map();
  for (const ticket of state.tickets.filter((entry) => entry.parallel_group === group)) {
    latestByStage.set(ticket.stage_id, ticket);
  }
  // A remediation stage supersedes the stage it remediates: once the group has
  // been re-reviewed, the original disagreeing/failing receipt no longer votes.
  for (const stageId of [...latestByStage.keys()]) {
    if (stageId.startsWith('remediation-')) {
      latestByStage.delete(stageId.slice('remediation-'.length));
    }
  }
  return [...latestByStage.values()]
    .map((ticket) => state.receipts.find((receipt) => receipt.ticket_id === ticket.ticket_id))
    .filter(Boolean);
}

function stageFromTicket(ticket) {
  return {
    id: ticket.stage_id,
    role: ticket.role,
    model_tier: ticket.model_tier,
    writable: ticket.writable,
    parallel_group: ticket.parallel_group ?? null,
    required_checks: ticket.required_checks ?? [],
    output_schema: ticket.output_schema,
  };
}

const BLOCK_SUMMARY_LIMIT = 120;

// The pure per-attempt summary list: one entry per recorded stage attempt,
// 'attempt N: <flattenReviewText-flattened, 120-char-capped summary>' with a
// '(no summary)' placeholder, plus whether ANY attempt carried an informative
// evidence.summary/reason. Receipt-derived and persisted-field-only. Two
// consumers share it: the block-reason wrapper below (diagnostics) and the
// retry/expiry arms, which thread the informative list onto the reissued
// ticket as prior_attempts so the retry agent knows why the prior attempt(s)
// failed instead of repeating them.
function attemptSummaryList(state, stageId, currentTicketId = null, currentReceipt = null) {
  const entries = [];
  let informative = false;
  state.tickets
    .filter((ticket) => ticket.stage_id === stageId)
    .forEach((ticket, index) => {
      const receipt = currentTicketId !== null && currentTicketId === ticket.ticket_id
        ? currentReceipt
        : state.receipts.find((entry) => entry.ticket_id === ticket.ticket_id);
      if (!receipt) return;
      const text = [receipt.evidence?.summary, receipt.evidence?.reason]
        .find((value) => typeof value === 'string' && value.trim() !== '');
      if (text) informative = true;
      const flat = text ? flattenReviewText(text) : '(no summary)';
      const bounded = flat.length > BLOCK_SUMMARY_LIMIT
        ? `${flat.slice(0, BLOCK_SUMMARY_LIMIT)}…`
        : flat;
      entries.push(`attempt ${ticket.attempt ?? index + 1}: ${bounded}`);
    });
  return { entries, informative };
}

// Diagnostics only — invariant 5 is untouched: no extra attempt, no
// classification, no backoff. When exhausted attempts block the run, copy
// each recorded attempt's failure summary (evidence.summary, then
// evidence.reason — the prompts/common.md contract) into the block reason so
// an operator can see whether both attempts failed identically without
// receipt archaeology. Flattened via flattenReviewText (control/bidi-
// neutralizing, not just whitespace) and bounded per attempt so the reason
// stays one short line; empty when no attempt carries a summary so the bare
// reason string is preserved noise-free.
function attemptSummaries(state, stageId, currentTicketId = null, currentReceipt = null) {
  const { entries, informative } = attemptSummaryList(state, stageId, currentTicketId, currentReceipt);
  return informative ? `: ${entries.join('; ')}` : '';
}

// --- The remediation ticket's review-findings channel ----------------------
// Roadmap entry review-findings-truncated-on-remediation-ticket. prompts/
// implementer.md tells the remediation implementer to work from
// `review_findings` instead of rediscovering the defects from the diff, and
// prompts/common.md sanctions exactly ONE `.ape` read for a bound subagent —
// its own ticket file — so this array is the WHOLE channel; the reviewer's
// receipt is not a fallback the reader may use. Observed live
// (run-fixture-9107466a79ca): two blocking findings became one 200-char
// slice of the reviewer's prose naming no defect at all.
//
// Three ceilings, and every one of them DISCLOSES what it drops rather than
// swallowing it:
//   REVIEW_FINDING_LIMIT       — one rendered entry. The observed blocking
//                                finding's `detail` ran past 1,300 characters
//                                (the defect AND its remedy); 200 carried
//                                neither, 1,000 carries the defect and most of
//                                the remedy.
//   REVIEW_FINDINGS_MAX        — entries kept: one guaranteed per distinct
//                                dissenting receipt first (fairness, below),
//                                then a prefix of receipt-then-findings order
//                                for whatever budget remains.
//   REVIEW_FINDINGS_BLOCK_LIMIT — the whole field.
//
// THE WIRE BUDGET (C2), stated rather than assumed, and MEASURED THE WAY THE
// HOST MEASURES IT. The field crosses one ape_run response TWICE — the pending
// run.tickets[] entry and the canonical dispatch_agent action ticket
// (projection.js collapses the third copy, dispatch.ticket, to a bare
// ticket_id) — against the 48,000 RESPONSE_BUDGET_CHARS the size-triggered
// compaction defends (projection.js overBudget measures
// JSON.stringify(response).length, and two live host rejections at 71,183 and
// 71,534 chars bracket the real ceiling).
//
// So REVIEW_FINDINGS_BLOCK_LIMIT is spent in SERIALIZED characters, not raw
// ones: JSON escaping is not identity, and raw length would be a false ceiling.
// A C0 control character (U+0001-U+0008, U+000E-U+001F) renders as a
// six-character \uXXXX escape, an unpaired surrogate likewise, and `"` and `\`
// as two — so ~9 findings of raw-cheap control characters, comfortably
// admissible under the 64 KB input envelope (which already counts the ESCAPED
// form), used to cost ~105,000 wire characters across the two copies while a
// raw-counting bound believed it had spent ~20,000. boundReviewFinding now
// collapses control and format characters along with whitespace, so ordinary
// reviewer prose costs about what it reads; boundReviewFindingsBlock then
// charges every entry its exact serialized width, so whatever escaping remains
// is paid for out of the same 10,000. The worst case on the wire is therefore
// 2 x REVIEW_FINDINGS_BLOCK_LIMIT = 20,000 of 48,000 (up from 2 x 4,020
// before), leaving 28,000 for the single full run.objective copy and everything
// else, with the size pass still deduping the two duplicated ticket fields on
// top; the bound is a smaller share of the budget than the objective it sits
// beside. Bounding review_findings on the wire INSTEAD of here is not
// available: the bound is applied at issuance, the ticket_hash covers the
// field, and the on-disk ticket is the copy the subagent reads — so a wire-only
// trim would leave the disk copy unbounded and hash-divergent.
// skills/run/SKILL.md says so plainly.
const REVIEW_FINDING_LIMIT = 1_000;
// Exported (additive — every existing importer of this module still sees the
// same reduceRun-only surface it always did) so service.js's REVIEW_FINDINGS_
// NOTICE can interpolate the SAME two ceilings this module enforces, rather
// than a second, hand-copied pair of digits that could silently drift from
// them on a future retune.
export const REVIEW_FINDINGS_MAX = 40;
export const REVIEW_FINDINGS_BLOCK_LIMIT = 10_000;
// Fixed reserves, so both bounds are one-pass arithmetic rather than a
// fixed-point search over their own disclosure text: what is kept is always a
// verbatim prefix and the disclosure is the only text ever added.
// '… (+<=5 digits> chars cut)' is at most 20 characters (a finding's text is
// itself bounded by the 64 KB receipt input envelope), so 24 always fits.
const REVIEW_FINDING_CUT_RESERVE = 24;
// The disclosure entry's SERIALIZED width, accounted rather than assumed: 302
// characters of fixed ASCII prose (no JSON escape among them, the two
// interpolated constants included), at most 10 digits of counts, at most
// REVIEW_STAGE_LABEL_CHARS of stage label at the 6x worst case no JSON escape
// exceeds, and 3 for the quotes and the array separator — 603 at the very
// worst, inside 768 with room for the wording to move.
const REVIEW_FINDINGS_DISCLOSURE_RESERVE = 768;
// The stage label is the only NON-fixed text in that disclosure, and a stage_id
// is a bare non-empty string in StageTicketSchema (schemas.js) with no maximum,
// so bound it here: the reserve above is then structural, not an assumption
// about how a caller happened to name its stages. Long enough to carry every
// pipeline stage id whole ('remediation-build' is 17).
const REVIEW_STAGE_LABEL_CHARS = 48;

// The per-finding text keys the extractor reads, split into a headline and an
// explanation so a finding carrying both keeps both. MEASURED over
// .ape/runtime/history (2026-07-27): 4,110 finding objects across 629 receipts,
// key frequency note 3035, detail 387, summary 313, title 254, description 14 —
// `detail` and `title` together outnumber `summary`, and reading only
// {summary, note} rendered NOTHING for 762 findings (18.5%) and nothing at all
// for 107 of those receipts (17%), each of which then fell back to a single
// 200-character slice of evidence.summary.
//
// The extractor stays TOLERANT of every shape the archive already holds (C4):
// the receipt schema's findings record is free-form and hash-chained history
// must keep validating byte-identically, so tightening it is not an option.
// Making the shape CONTRACTUAL belongs in prompts/reviewer.md and
// prompts/security_reviewer.md, where reviewers actually read it.
const FINDING_TITLE_KEYS = ['title', 'summary', 'headline', 'message', 'issue'];
const FINDING_BODY_KEYS = [
  'detail', 'details', 'note', 'notes', 'description', 'observation', 'finding',
  'text', 'body', 'evidence', 'reason',
];

function findingValue(finding, keys) {
  if (finding === null || typeof finding !== 'object') return undefined;
  for (const key of keys) {
    const value = finding[key];
    if (typeof value === 'string' && value.trim() !== '') return value.trim();
  }
  return undefined;
}

// Headline plus explanation, joined only when the explanation does not already
// carry the headline — the observed reviewer's `detail` opened with its own
// `title`, so joining blindly would print the defect name twice.
function findingText(finding) {
  const title = findingValue(finding, FINDING_TITLE_KEYS);
  const body = findingValue(finding, FINDING_BODY_KEYS);
  if (!title) return body;
  if (!body) return title;
  return body.includes(title) ? body : `${title} — ${body}`;
}

// A finding's line anchor. Integers and numeric strings rendered before; a
// RANGE did not, so 37 of the 626 corpus findings that carry a `line` — the
// observed blocking V1 among them, which lost its '13-15' — degraded to the
// file-only rendering with the anchor silently gone. SCALARS ONLY, matched
// against one narrow pattern and hard-bounded: a crafted object/array line is
// inert (it renders no anchor at all, never '[object Object]') and no `line`
// value can widen the entry. Returns the normalized anchor string, or null.
const FINDING_LINE_ANCHOR = /^L?\d{1,9}(?:\s*[-–—:,]\s*L?\d{1,9})*$/i;
const FINDING_LINE_CHARS = 24;

function findingLineAnchor(line) {
  if (typeof line === 'number') return Number.isInteger(line) ? String(line) : null;
  if (typeof line !== 'string') return null;
  const flat = line.trim().replace(/\s+/g, ' ');
  return flat.length <= FINDING_LINE_CHARS && FINDING_LINE_ANCHOR.test(flat) ? flat : null;
}

// Flatten reviewer-authored text to one line of readable characters. Runs of
// whitespace collapse to a single space, and so do C0/C1 CONTROL (\p{Cc}) and
// FORMAT (\p{Cf}) characters, which are not whitespace and so survived a
// /\s+/ flatten untouched. Two reasons, both load-bearing on a field that
// carries untrusted prose onto a writing agent's ticket:
//   COST — a control character is one raw character and SIX serialized ones
//     (\uXXXX), so a raw-counting bound under-charges it ~6x against a wire
//     budget the host enforces on the serialized form. Collapsing them makes
//     the readable width and the wire width agree for ordinary prose.
//   READABILITY — \p{Cf} is where U+202A-U+202E and U+2066-U+2069 live: bidi
//     overrides that can reorder what a reader sees without changing the text
//     they act on. A review finding is read by an agent about to change code;
//     it has no legitimate use for either class.
// Unpaired surrogates (\p{Cs}) also serialize to six characters and are left to
// boundReviewFindingsBlock's serialized accounting rather than matched here.
const REVIEW_TEXT_FLATTEN = /[\p{Cc}\p{Cf}\s]+/gu;

function flattenReviewText(text) {
  return String(text).replace(REVIEW_TEXT_FLATTEN, ' ').trim();
}

// Flatten and hard-bound one rendered review-finding line so a crafted finding
// can never write an unbounded ticket field (C1). A cut states exactly how many
// characters it dropped instead of a bare U+2026 that discloses nothing about
// the size of the loss: the reader learns whether it lost a clause or a page,
// and knows to ask for the rest.
function boundReviewFinding(text) {
  const flat = flattenReviewText(text);
  if (flat.length <= REVIEW_FINDING_LIMIT) return flat;
  const kept = REVIEW_FINDING_LIMIT - REVIEW_FINDING_CUT_RESERVE;
  return `${flat.slice(0, kept)}… (+${flat.length - kept} chars cut)`;
}

// What one entry costs the field: its exact SERIALIZED width plus the array
// separator, so JSON.stringify(review_findings).length can never exceed
// REVIEW_FINDINGS_BLOCK_LIMIT and the wire ceiling above is arithmetic rather
// than hope. Raw .length was the false ceiling V1 found: escaping is not
// identity, and the characters that inflate most (controls, unpaired
// surrogates) are exactly the ones a crafted finding can carry cheapest.
// One entry can never exceed the budget on its own — REVIEW_FINDING_LIMIT is
// 1,000 characters and no character serializes past six, so 6,003 is the
// widest an entry can cost against a 9,232 budget — hence the fill always keeps
// at least the first entry and a wide finding costs its neighbours, disclosed,
// rather than the whole field.
function reviewFindingCost(text) {
  return JSON.stringify(text).length + 1;
}

// The whole-field bound. Roadmap entry review-findings-whole-field-prefix-
// starvation: a STRICT prefix of receipt-then-findings order let one
// serialization-heavy dissenting receipt processed first exhaust the entire
// budget before a later-processed dissenting receipt (e.g. security-review,
// issued after review) ever contributed a single entry of its own — the
// group's fairness then depended on dispatch/arrival order, which no reader
// of review_findings could see. So selection now runs in TWO passes over the
// same receipt-then-findings order:
//   FAIRNESS — walk `rendered` once and reserve, for every distinct
//     `entry.group` (one per disagreeing receipt, in the order that receipt's
//     findings first appear), its own FIRST entry, provided it individually
//     fits the shared budget and the count cap. This is what guarantees a
//     later-processed receipt's own dissent always lands at least once,
//     regardless of how much budget an earlier receipt's findings alone
//     would otherwise consume.
//   FILL — walk `rendered` again in the SAME original order and spend
//     whatever budget and count-cap headroom remain on every entry the
//     fairness pass did not already reserve.
// The final entries are then re-sorted back into original `rendered` index
// order, so the published invariant is now: each receipt's OWN findings that
// survive are still exactly a PREFIX of that receipt's own order (never a
// sample and never a reshuffle within one receipt, C3), and every distinct
// receipt's prefix starts no later than its own first entry — never zero
// entries merely because an earlier receipt in the group ran long.
//
// `recordedTotal` (roadmap entry mixed-receipts-unrenderable-findings-skip) is
// the TRUE count of findings this call is accountable for — every finding a
// disagreeing receipt actually recorded, renderable or not, plus one for
// each receipt whose own dissent rendered nothing and so fell back to a
// single synthesized entry — supplied by the caller rather than re-derived
// from `rendered.length`, because an unrenderable finding never becomes a
// `rendered` candidate at all: counting only what got AS FAR AS `rendered`
// silently dropped every one of those from the "X of Y" disclosure with no
// trace, understating the true drop by exactly that many. `unrenderableStage`
// is the fallback disclosure label for the case where every rendered entry
// was kept in full and the only drop was an unrenderable finding no
// `rendered` index can point at.
//
// Either way ONE final entry says how many were dropped and out of how many —
// a cap that silently swallows a blocking finding leaves the remediation
// agent believing it holds the whole list. The disclosure carries the stage
// label of the first BUDGET/COUNT-dropped entry when one exists (falling back
// to `unrenderableStage` when the only drop was an unrenderable finding), so
// every entry in the field keeps the `stage: ` shape, and it names the only
// channel that still holds the rest plus who may use it: a bound subagent may
// not read `.ape/runtime/receipts/`, so relaying is the orchestrator's job
// (skills/run/SKILL.md). That label is the disclosure's only non-fixed text,
// and it is flattened and bounded like every other entry, so this is the last
// place a ticket field could have widened without a ceiling. The fill runs
// against the reserved budget UNCONDITIONALLY, so the disclosure always fits
// without a second measuring pass.
function boundReviewFindingsBlock(rendered, recordedTotal = rendered.length, unrenderableStage = null) {
  const budget = REVIEW_FINDINGS_BLOCK_LIMIT - REVIEW_FINDINGS_DISCLOSURE_RESERVE;
  const included = new Set();
  let used = 0;

  // FAIRNESS PASS — one guaranteed entry per distinct dissenting receipt.
  const seenGroups = new Set();
  for (let index = 0; index < rendered.length; index += 1) {
    const entry = rendered[index];
    if (seenGroups.has(entry.group)) continue;
    seenGroups.add(entry.group);
    if (included.size >= REVIEW_FINDINGS_MAX) continue;
    const cost = reviewFindingCost(entry.text);
    if (used + cost > budget) continue;
    included.add(index);
    used += cost;
  }

  // FILL PASS — spend whatever remains, in original order, on entries the
  // fairness pass above did not already reserve.
  let firstDroppedIndex = -1;
  for (let index = 0; index < rendered.length; index += 1) {
    if (included.has(index)) continue;
    if (included.size >= REVIEW_FINDINGS_MAX) {
      firstDroppedIndex = index;
      break;
    }
    const cost = reviewFindingCost(rendered[index].text);
    if (used + cost > budget) {
      firstDroppedIndex = index;
      break;
    }
    included.add(index);
    used += cost;
  }

  const orderedIndices = [...included].sort((a, b) => a - b);
  const entries = orderedIndices.map((index) => rendered[index].text);
  const dropped = recordedTotal - entries.length;
  if (dropped > 0) {
    const labelStage = firstDroppedIndex >= 0
      ? rendered[firstDroppedIndex].stage
      : unrenderableStage ?? rendered[rendered.length - 1]?.stage ?? 'review';
    const label = flattenReviewText(labelStage).slice(0, REVIEW_STAGE_LABEL_CHARS);
    entries.push(
      `${label}: ${dropped} of ${recordedTotal} review findings were dropped by this ticket's bound ` +
        `(it holds at most ${REVIEW_FINDINGS_MAX} entries and ${REVIEW_FINDINGS_BLOCK_LIMIT} characters). ` +
        'The dropped findings survive only in the reviewer\'s receipt, which a bound subagent may not read: ' +
        'ask the orchestrator to relay them, and re-audit the diff for anything they would have named.',
    );
  }
  return entries;
}

function firstNonEmptyString(...values) {
  return values.find((value) => typeof value === 'string' && value.trim() !== '');
}

// The remediation ticket's grounded evidence: the review group's disagreeing
// receipts rendered as bounded, stage-labeled findings so the remediation agent
// works from the reviewer's pinpointed file:line evidence instead of
// rediscovering it from the diff. Deterministic and receipt-derived — persisted
// fields only (status, evidence.verdict/summary, findings[].{file,path,line}
// plus the title/body text keys above) — with the exact groupOutcome disagree
// predicate. Each finding renders 'stage: file:line — text' /
// 'stage: file — text' / 'stage: text'; a disagreeing receipt whose findings
// render nothing still contributes ONE entry ('stage: <evidence.summary>' or
// 'stage: (no summary)') so the remediation always knows which stage dissented.
// Ordered by receipt (group/state order) then findings order (C3), each entry
// bounded, the list bounded by count and by total width with any drop
// disclosed and every dissenting receipt fairness-guaranteed at least one
// entry (boundReviewFindingsBlock above). `group` on each rendered entry is
// the per-disagreeing-receipt index that fairness pass keys on: one value per
// receipt, assigned in receipt order, independent of the (possibly
// receipt-supplied) `stage` label, so two receipts that happened to carry the
// same stage label could never be fairness-merged into one guaranteed slot.
//
// recordedTotal (roadmap entry mixed-receipts-unrenderable-findings-skip) is
// the TRUE count this call is accountable for, tracked independently of
// `rendered.length`: a finding whose findingText renders empty is still one
// the receipt recorded — it simply never becomes a `rendered` candidate — so
// counting only `rendered.length` as "Y" in boundReviewFindingsBlock's "X of
// Y" disclosure silently understated the true count by exactly the
// unrenderable ones. Every finding a disagreeing receipt recorded counts
// toward it, and so does the one synthesized fallback entry added below for a
// receipt whose own findings rendered nothing at all (zero recorded, or every
// one unrenderable) — that fallback is the one thing such a receipt actually
// contributes, so it is counted as kept once it survives selection rather
// than leaving its receipt's true finding count permanently unreconciled.
function reviewFindings(state, receipts) {
  const positive = new Set(['agree', 'pass', 'passed']);
  const stageByTicket = new Map(
    (state.tickets ?? []).map((ticket) => [ticket.ticket_id, ticket.stage_id]),
  );
  const rendered = [];
  let recordedTotal = 0;
  let unrenderableStage = null;
  let group = -1;
  for (const receipt of receipts) {
    const disagree =
      String(receipt.status).toLowerCase() !== 'passed' ||
      !positive.has(String(receipt.evidence?.verdict ?? receipt.status).toLowerCase());
    if (!disagree) continue;
    group += 1;
    const stage = stageByTicket.get(receipt.ticket_id) ?? receipt.ticket_id;
    const before = rendered.length;
    const findings = receipt.findings ?? [];
    for (const finding of findings) {
      const text = findingText(finding);
      if (!text) {
        // Recorded, not rendered: still counted toward recordedTotal below,
        // and its stage is kept as the last-resort disclosure label for the
        // case where no BUDGET/COUNT drop ever occurs to supply one.
        unrenderableStage = stage;
        continue;
      }
      const file = firstNonEmptyString(finding?.file, finding?.path);
      const anchor = file ? findingLineAnchor(finding?.line) : null;
      const line = anchor
        ? `${stage}: ${file}:${anchor} — ${text}`
        : file
          ? `${stage}: ${file} — ${text}`
          : `${stage}: ${text}`;
      rendered.push({ stage, text: boundReviewFinding(line), group });
    }
    recordedTotal += findings.length;
    if (rendered.length === before) {
      const summary = firstNonEmptyString(receipt.evidence?.summary);
      rendered.push({
        stage,
        // prose-bound-exempt: the ${summary} template interpolation on this line is
        // a scanner artifact of masking `${...}` as live code (it matches the
        // shorthand `{summary}` shape) — it is not object-literal construction,
        // and the whole rendered string is passed through boundReviewFinding(...)
        // on this same line regardless.
        text: boundReviewFinding(summary ? `${stage}: ${summary}` : `${stage}: (no summary)`),
        group,
      });
      // The fallback entry itself is the one thing this receipt contributes;
      // count it so a receipt with zero renderable findings reconciles to
      // zero drop rather than leaving an untraceable -1 in the accounting.
      recordedTotal += 1;
    }
  }
  return boundReviewFindingsBlock(rendered, recordedTotal, unrenderableStage);
}

// The remediation ticket's scope-expansion channel, the STATE-DERIVED
// counterpart to reviewFindings above (and to declaredTestRemediationPaths,
// pipeline.js, for its structural sibling channel): a blocking review's
// evidence.scope_expansion is accepted and durably recorded onto
// state.pending_scope_expansions — keyed by the PROPOSING ticket's own
// ticket_id — by the SCOPE_EXPANDED transition below, the moment service.js
// validates it, independent of whether that receipt is also the one that
// completes its review group. Reading it back here from EVERY member of the
// completed group, rather than only the receipt this reduction happens to be
// processing, closes the order-dependent miss a single-receipt read left
// open: a two-member group's FIRST-arriving receipt can propose the growth
// while the SECOND is what actually completes the group and triggers this
// call. Multiple members proposing distinct growth is unioned by path, and
// each member's reason is kept SEPARATE: every entry read back here was
// already bounded individually where it was recorded (service.js's
// SCOPE_EXPANDED dispatch calls boundedGateSummary on the reviewer's reason
// before this module ever sees it), so joining them here cannot let one
// member's reason consume another's budget. That is the same bound-each-then-
// join order testRemediationNotice (service.js) uses, applied one step earlier
// because this module cannot import the helper without a cycle.
function groupScopeExpansion(state, receipts) {
  const pending = state.pending_scope_expansions ?? {};
  const claimedPaths = [];
  const reasons = [];
  for (const receipt of receipts) {
    const entry = pending[receipt.ticket_id];
    if (!entry) continue;
    for (const claim of entry.claimed_paths ?? []) {
      if (!claimedPaths.includes(claim)) claimedPaths.push(claim);
    }
    if (typeof entry.reason === 'string' && entry.reason.trim() !== '') reasons.push(entry.reason);
  }
  if (claimedPaths.length === 0) return null;
  const dropsReasons = reasons.length > SCOPE_EXPANSION_REASONS_MAX;
  const reasonSlots = dropsReasons ? SCOPE_EXPANSION_REASONS_MAX - 1 : SCOPE_EXPANSION_REASONS_MAX;
  const keptReasons = reasons.slice(0, reasonSlots);
  if (dropsReasons) {
    keptReasons.push(
      `[APE runtime] ${reasons.length - reasonSlots} further reviewer reason(s) not listed here`,
    );
  }
  return {
    claimed_paths: claimedPaths,
    // Every entry joined here is a review receipt's own
    // evidence.scope_expansion.reason, validated non-empty by
    // extractScopeExpansion AND bounded individually by the SCOPE_EXPANDED
    // dispatch (both service.js) before it was recorded onto
    // state.pending_scope_expansions, so each contributes at most its own
    // per-reason ceiling to this join and the count above is capped with the
    // runtime's own omission note in the last slot.
    // prose-bound-exempt: joins values that were each neutralized and cut at
    // their recording site, and the whole join is cut again by
    // boundedScopeExpansion (service.js) at a ceiling derived from those same
    // two constants before it reaches a ticket objective.
    reason: keptReasons.length > 0 ? keptReasons.join(' | ') : null,
  };
}

// The single exit for a pending ticket that will never produce a receipt:
// mark it expired, consume the stage attempt, and either issue the retry
// ticket or block with an honest reason. Shared by the NEXT deadline-timeout
// arm and the audited EXPIRE_DISPATCH lever so both exits stay identical.
function expirePendingTicket(state, ticket, blockReason) {
  const attempts = state.attempts[ticket.stage_id] ?? 1;
  const expiredIds = [...(state.expired_tickets ?? []), ticket.ticket_id];
  if (attempts < MAX_STAGE_ATTEMPTS) {
    // The expiring ticket has no receipt, so prior_attempts is receipt-derived
    // from any earlier recorded attempt only (typically absent); a
    // remediation-build or remediation-test ticket's review_findings and
    // scope_expansion are forwarded onto its retry unchanged. Keys attach
    // only when non-empty so an ordinary retry ticket stays byte-identical.
    const { entries: priorAttempts, informative } = attemptSummaryList(
      state,
      ticket.stage_id,
      ticket.ticket_id,
      null,
    );
    return [
      action('transition', {
        patch: {
          attempts: { ...state.attempts, [ticket.stage_id]: attempts + 1 },
          expired_tickets: expiredIds,
        },
      }),
      action('issue_ticket', {
        stage: stageFromTicket(ticket),
        retry_of: ticket.ticket_id,
        ...(informative && priorAttempts.length ? { prior_attempts: priorAttempts } : {}),
        ...(Array.isArray(ticket.review_findings) && ticket.review_findings.length
          ? { review_findings: ticket.review_findings }
          : {}),
        ...(ticket.scope_expansion ? { scope_expansion: ticket.scope_expansion } : {}),
      }),
      action('persist_state'),
    ];
  }
  return [
    action('transition', {
      patch: {
        status: 'blocked',
        stage: ticket.stage_id,
        expired_tickets: expiredIds,
        // prose-bound-exempt: blockReason is always one of this module's own fixed
        // diagnostic templates (see expirePendingTicket's callers); the only
        // agent-authored text this block_reason carries is what
        // attemptSummaries appends, which routes each entry through
        // flattenReviewText (defined below, function-declaration hoisted)
        // before its BLOCK_SUMMARY_LIMIT cap, so it is control/bidi-
        // neutralized and length-capped, never raw.
        block_reason: blockReason + attemptSummaries(state, ticket.stage_id),
      },
    }),
    // Blocked is a terminal status: every transition into it archives
    // immediately (F7), so the run is queryable in history without an
    // operator abort/reset. if_absent keeps a crash-retry a no-op.
    action('archive_history', { if_absent: true }),
    action('release_lock'),
    action('persist_state'),
  ];
}

function groupOutcome(receipts) {
  const positive = new Set(['agree', 'pass', 'passed']);
  // Truthful completion (invariant 8): a non-passed receipt always votes
  // disagree; a stray positive verdict string inside failed evidence must not
  // count as agreement.
  const verdicts = receipts.map((receipt) =>
    String(receipt.status).toLowerCase() !== 'passed'
      ? 'disagree'
      : String(receipt.evidence?.verdict ?? receipt.status).toLowerCase());
  return verdicts.length > 0 && verdicts.every((verdict) => positive.has(verdict))
    ? 'agreed'
    : 'disagreed';
}

function latestTicketForStage(state, stageId) {
  return [...(state.tickets ?? [])].reverse().find((ticket) => ticket.stage_id === stageId) ?? null;
}

function receiptForTicket(state, ticket) {
  return ticket
    ? (state.receipts ?? []).find((receipt) => receipt.ticket_id === ticket.ticket_id) ?? null
    : null;
}

function isExactPlanAgreement(receipt) {
  return receipt?.status === 'passed' && receipt?.evidence?.verdict === 'agree';
}

// Seal only the exact structured plan the reviewers saw. The checker and
// critic are ordered by role, never receipt arrival; judge approval appends the
// judge hash. A missing/mismatched candidate returns null so the reducer can
// block fail-closed instead of advancing under an invented authority.
function sealApprovedPlan(state, route, judgeReceipt = null) {
  if (state.plan_contract_version !== PLAN_CONTRACT_VERSION) return undefined;
  const checkTicket = latestTicketForStage(state, 'plan-check');
  const criticTicket = latestTicketForStage(state, 'plan-critic');
  const checkReceipt = receiptForTicket(state, checkTicket);
  const criticReceipt = receiptForTicket(state, criticTicket);
  const checkCandidate = CandidatePlanSchema.safeParse(checkTicket?.candidate_plan);
  const criticCandidate = CandidatePlanSchema.safeParse(criticTicket?.candidate_plan);
  if (!checkReceipt || !criticReceipt || !checkCandidate.success || !criticCandidate.success) return null;
  if (checkCandidate.data.plan_hash !== criticCandidate.data.plan_hash) return null;
  if (route === 'unanimous' && (!isExactPlanAgreement(checkReceipt) || !isExactPlanAgreement(criticReceipt))) {
    return null;
  }
  if (route === 'judge') {
    const judgeTicket = latestTicketForStage(state, 'plan-judge');
    const judgeCandidate = CandidatePlanSchema.safeParse(judgeTicket?.candidate_plan);
    if (
      !judgeReceipt ||
      !isExactPlanAgreement(judgeReceipt) ||
      judgeReceipt.ticket_id !== judgeTicket?.ticket_id ||
      !judgeCandidate.success ||
      judgeCandidate.data.plan_hash !== checkCandidate.data.plan_hash
    ) return null;
  }
  return approvedPlan(
    checkCandidate.data,
    route,
    [
      checkReceipt.receipt_hash,
      criticReceipt.receipt_hash,
      ...(route === 'judge' ? [judgeReceipt.receipt_hash] : []),
    ],
  );
}

function planSealFailureActions() {
  return [
    action('transition', {
      patch: {
        status: 'blocked',
        stage: 'plan-approval',
        block_reason: 'structured plan approval could not be sealed from identical reviewer-visible candidate plans',
      },
    }),
    action('archive_history', { if_absent: true }),
    action('release_lock'),
    action('persist_state'),
  ];
}

// Guidance for a recovery lever refused while the run RESTS in a non-blocking
// watch. 'gating' and 'shipping' are absent from TERMINAL_STATUSES, so the
// pre-switch terminal guard never answers in either state and control reaches
// the REGATE and SHIP arms, whose own validity guards refuse — correctly, since
// neither lever applies to a resting run — but whose stock advice ("recover ...
// through the audited OVERRIDE reset or ABORT") would kill a healthy detached
// gate suite ('gating') or abort a run whose PR is open with required remote
// checks mid-flight ('shipping'). Both rest states are the SHIPPED DEFAULT path
// (shipping.required_remote_checks defaults true; auto_merge is explicit opt-in),
// and both span the multi-minute window a lost response is re-issued across, so
// the refusal an operator most often reads must be SAFE TO FOLLOW: name the
// watch, repeat the evidence already on state, and point at the one lever that
// advances it. The wording mirrors the guidance resume already returns for these
// same two states (service.js resumeRun), so both surfaces answer alike.
//
// PURE, like every other reducer path: derived from the state object alone — no
// I/O and no wall-clock read — and it never interpolates an absent field. It
// returns null for every other state, so no other refusal changes, and it never
// admits an operation: the lever stays refused, only its prose becomes usable.
function restStateGuidance(state) {
  const detail = (value) => (typeof value === 'string' && value.trim() !== '' ? ` (${value})` : '');
  if (state.status === 'gating' && state.gates_watch) {
    return `this run rests in the non-blocking gating watch — the merge-gate suite is still running${detail(state.gates_watch.last_summary)}; call ape_run next to poll it`;
  }
  if (state.status === 'shipping' && state.shipping_watch) {
    const pr = typeof state.shipping_watch.pr_url === 'string' && state.shipping_watch.pr_url.trim() !== ''
      ? ` for ${state.shipping_watch.pr_url}`
      : '';
    return `this run rests in the non-blocking shipping watch — required remote checks are in progress${pr}${detail(state.shipping_watch.last_checks_summary)}; call ape_run next to poll it`;
  }
  return null;
}

export function reduceRun(state, event) {
  if (event.type !== 'START' && (!state || typeof state !== 'object')) {
    return [action('reject', { reason: 'run state is required' })];
  }
  if (state && TERMINAL_STATUSES.has(state.status)) {
    // `blocked` is terminal for scheduling — no receipts, no NEXT, no new
    // tickets — but it must be exitable: plain ABORT terminates and archives a
    // blocked run (F7), REGATE recovers a gate block (the REGATE arm rejects any
    // non-gate block), and SHIP recovers only the auto-merge-disabled hold at
    // stage 'merge' (the SHIP arm rejects every other block). completed/aborted
    // runs stay sealed except for STATUS/OVERRIDE.
    const allowed = state.status === 'blocked'
      ? ['STATUS', 'OVERRIDE', 'ABORT', 'REGATE', 'SHIP']
      : ['STATUS', 'OVERRIDE'];
    if (!allowed.includes(event.type)) {
      // prose-bound-exempt: fixed diagnostic template; ${state.status} is a
      // fixed enum run status, never agent- or attacker-controlled text.
      return [action('reject', { reason: `run is ${state.status}` })];
    }
  }

  switch (event.type) {
    case 'START': {
      if (state) return [action('reject', { reason: 'an active run already exists' })];
      return [
        action('acquire_lock'),
        action('transition', { patch: { status: 'running', stage: 'dispatch' } }),
        ...initialStages(event.run).map((stage) => action('issue_ticket', { stage })),
        action('persist_state'),
      ];
    }
    case 'NEXT': {
      const expired = expiredTicketIds(state);
      const pending = state.tickets.filter(
        (ticket) =>
          !expired.has(ticket.ticket_id) &&
          !state.receipts.some((receipt) => receipt.ticket_id === ticket.ticket_id),
      );
      const at = Date.parse(event.at ?? '');
      const timedOut = Number.isFinite(at)
        ? pending.find((ticket) => {
            const deadline = Date.parse(ticket.deadline_at ?? '');
            return Number.isFinite(deadline) && deadline <= at;
          })
        : undefined;
      if (timedOut) {
        return expirePendingTicket(
          state,
          timedOut,
          `stage ${timedOut.stage_id} ticket deadline expired after retry`,
        );
      }
      if (pending.length > 0) return pending.map((ticket) => action('dispatch_agent', { ticket_id: ticket.ticket_id }));
      // A run resting in the non-blocking gating watch: NEXT is ONE bounded
      // gate-suite poll slice (the service's poll_gates handler owns the artifact
      // read, the in-call evaluation, and the pass/fail/pending transition). A
      // 'gating' state with no persisted watch is degenerate — fall through.
      if (state.status === 'gating' && state.gates_watch) {
        return [action('poll_gates')];
      }
      // A run resting in the non-blocking shipping watch: NEXT is ONE bounded
      // remote-checks poll slice (the service's poll_shipping handler owns the
      // single gh call and the merge/pending/failed transition), not the idle
      // status echo. A 'shipping' state with no persisted watch block is
      // degenerate — fall through to the status action.
      if (state.status === 'shipping' && state.shipping_watch) {
        return [action('poll_shipping')];
      }
      return [action('status', { state })];
    }
    case 'RECEIPT_RECORDED': {
      const { ticket, receipt } = event;
      // friction #23: a non-passed receipt from a review-group stage falls through to
      // the parallel-group outcome below as a disagree vote instead of
      // consuming the verbatim retry. For code-review (review, security-review,
      // remediation-review, remediation-security-review) the receipt is a
      // verdict on the work, not a stage malfunction — retrying the identical
      // review against a byte-identical tree is provably futile — and dissent
      // enters the single remediation cycle. For plan-review (plan-check,
      // plan-critic) the runtime cannot distinguish a negative verdict from a
      // malfunction, so the vote routes to the plan-judge via the
      // plan-review-disagreed synthetic — the judge, not a verbatim re-check,
      // adjudicates — consuming no stage attempt and no remediation cycle.
      // The failure_kind carve-outs below are unreachable for review-group
      // receipts by design (friction #36 precedent): a capability- or
      // test-contradiction-marked review receipt still votes disagree, and for
      // plan-review the judge, not an early operator block, weighs the
      // reported malfunction. plan-judge itself has NO parallel group, so a
      // failed judge receipt keeps the verbatim retry. The explicit group list
      // is deliberate: a future parallel group must decide its routing here
      // rather than inherit it. The verbatim retry remains for stages whose
      // failure means the stage could not do its work.
      const reviewVote = ['code-review', 'plan-review'].includes(event.stage.parallel_group);
      if (receipt.status !== 'passed' && !reviewVote) {
        // A capability failure — evidence.failure_kind 'capability', reported
        // when APE policy itself denied a required operation — is a verdict on
        // the environment, not a stage malfunction: the retry would re-dispatch
        // an identical ticket against an identical gate and fail identically,
        // so it is skipped and the run blocks for operator intervention (same
        // futility reasoning as the friction #23 review carve-out above). Invariant 5's
        // one retry is an upper bound, not a quota; skipping a provably futile
        // retry tightens it, it does not violate it. A capability-marked
        // review receipt still falls through as a disagree vote, and the
        // marker is ignored on a passed receipt.
        const capabilityBlocked = receipt.evidence?.failure_kind === 'capability';
        // A test-contradiction failure — evidence.failure_kind
        // 'test-contradiction', reported when the independently authored
        // behavioral test is itself faulty (e.g. it asserts the same call
        // both succeeds and raises) — is a verdict on the authored test, not
        // on the implementer: invariant 3 makes authored tests read-only to
        // the implementer (the write guard hard-denies the edit and the
        // implementer prompt forbids it), so the verbatim retry would re-issue
        // an identical ticket against an identical authored test and meet an
        // identical refusal. Skip it and block — but the block reason must
        // ATTRIBUTE the fault claim to the implementer rather than assert it
        // in runtime voice: the marker is agent-supplied and nothing in the
        // runtime corroborates it (invariant 8; same discipline as
        // groupOutcome below refusing to trust verdict strings inside failed
        // evidence), and the reason is archived into immutable history where
        // a fabricated "the test is faulty" would permanently misdirect the
        // operator away from the implementation. The runtime deliberately
        // does NOT auto-re-dispatch the test stage: that would be a second
        // authoring cycle (invariant 5), so verifying the claim and choosing
        // between re-authoring the test and debugging the implementation
        // stays an operator decision. Same semantics as 'capability'
        // otherwise: a marked review receipt still falls through as a
        // disagree vote, and the marker is ignored on a passed receipt.
        const testContradiction = receipt.evidence?.failure_kind === 'test-contradiction';
        const noRetryFault = capabilityBlocked || testContradiction;
        const attempts = state.attempts[ticket.stage_id] ?? 1;
        if (!noRetryFault && attempts < MAX_STAGE_ATTEMPTS) {
          // Thread receipt-derived failure evidence onto the retry: the bounded
          // per-attempt summaries (this failing receipt included) as
          // prior_attempts when informative, and — for a remediation-build or
          // remediation-test retry — the review group's findings and any
          // accepted scope expansion the failed ticket carried, forwarded
          // unchanged so the grounded evidence survives the retry. Keys
          // attach only when non-empty so an ordinary retry stays
          // byte-identical.
          const { entries: priorAttempts, informative } = attemptSummaryList(
            state,
            ticket.stage_id,
            ticket.ticket_id,
            receipt,
          );
          return [
            action('transition', {
              patch: { attempts: { ...state.attempts, [ticket.stage_id]: attempts + 1 } },
            }),
            action('issue_ticket', {
              stage: event.stage,
              retry_of: ticket.ticket_id,
              ...(informative && priorAttempts.length ? { prior_attempts: priorAttempts } : {}),
              ...(Array.isArray(ticket.review_findings) && ticket.review_findings.length
                ? { review_findings: ticket.review_findings }
                : {}),
              ...(ticket.scope_expansion ? { scope_expansion: ticket.scope_expansion } : {}),
            }),
            action('persist_state'),
          ];
        }
        return [
          action('transition', {
            patch: {
              status: 'blocked',
              stage: ticket.stage_id,
              // prose-bound-exempt: every branch's fixed template text is never
              // agent-controlled; ${ticket.stage_id} is a fixed schema-declared
              // stage id. The only agent-authored text this block_reason
              // carries is what attemptSummaries appends, which routes each
              // entry through flattenReviewText (below) before its
              // BLOCK_SUMMARY_LIMIT cap, so it is control/bidi-neutralized and
              // length-capped, never raw.
              block_reason: testContradiction
                ? `stage ${ticket.stage_id} test-contradiction-blocked (implementer reported the authored test contradicts itself or the ticket — an unverified agent claim; confirm it before re-authoring the test or debugging the implementation)${attemptSummaries(state, ticket.stage_id, ticket.ticket_id, receipt)}`
                : capabilityBlocked
                  ? `stage ${ticket.stage_id} capability-blocked${attemptSummaries(state, ticket.stage_id, ticket.ticket_id, receipt)}`
                  // prose-bound-exempt: every branch above is a fixed
                  // diagnostic template; ${ticket.stage_id} is a fixed
                  // schema-declared stage id; attemptSummaries routes each
                  // entry through flattenReviewText (below) before its
                  // BLOCK_SUMMARY_LIMIT cap, so it is control/bidi-neutralized
                  // and length-capped, never raw agent free text.
                  : `stage ${ticket.stage_id} failed twice${attemptSummaries(state, ticket.stage_id, ticket.ticket_id, receipt)}`,
            },
          }),
          action('archive_history', { if_absent: true }),
          action('release_lock'),
          action('persist_state'),
        ];
      }

      if (event.stage.parallel_group) {
        const outstanding = activeTickets(event.next_state ?? state, event.stage.parallel_group);
        if (outstanding.length > 0) return [action('persist_state')];
        const receipts = completedForGroup(event.next_state ?? state, event.stage.parallel_group);
        const outcome = groupOutcome(receipts);
        const synthetic = event.stage.parallel_group === 'plan-review'
          ? `plan-review-${outcome}`
          : `review-${outcome}`;
        if (synthetic === 'plan-review-agreed') {
          const sealed = sealApprovedPlan(event.next_state ?? state, 'unanimous');
          if (sealed === null) return planSealFailureActions();
          return [
            ...(sealed ? [action('transition', { patch: { approved_plan: sealed } })] : []),
            ...nextStages(state, synthetic, receipt).map((stage) => action('issue_ticket', { stage })),
            action('persist_state'),
          ];
        }
        if (synthetic === 'review-agreed') {
          // A risk trigger (or scope expansion) reported on this final
          // agreeing receipt armed high_risk via SCOPE_EXPANDED after the last
          // point nextStages could schedule the security review. Entering the
          // gates now would arm conditional_audits with no schedulable path to
          // the receipt it requires — a REGATE-proof dead end — so the
          // armed-but-unsatisfied review is issued here and the group
          // re-converges through this same exit once its receipt lands
          // (agreed → gates; disagreed → the single remediation cycle). Also
          // covers mode land, whose review-only pipeline shares the gap:
          // security_reviewer is read-only, so the land no-writing-stage guard
          // stays silent.
          const pending = pendingSecurityReviewStages(event.next_state ?? state);
          if (pending.length > 0) {
            return [
              ...pending.map((stage) => action('issue_ticket', { stage })),
              action('persist_state'),
            ];
          }
          return [action('run_gates'), action('persist_state')];
        }
        if (synthetic === 'review-disagreed') {
          if (state.remediation_cycles < MAX_REMEDIATION_CYCLES) {
            // Embed the review group's grounded, stage-labeled findings onto the
            // remediation-build ticket so the remediation works from the
            // reviewer's pinpointed file:line evidence instead of rediscovering
            // it from the diff. Computed from the same completedForGroup receipts
            // that produced the disagreement; the key attaches only when non-empty.
            const findings = reviewFindings(event.next_state ?? state, receipts);
            // The identical state-derived read for any accepted scope
            // expansion — see groupScopeExpansion above for why reading the
            // whole completed group, rather than only this receipt, is what
            // makes the disclosure survive a multi-member group regardless of
            // arrival order.
            const scopeExpansion = groupScopeExpansion(event.next_state ?? state, receipts);
            return [
              action('transition', { patch: { remediation_cycles: state.remediation_cycles + 1 } }),
              ...nextStages(state, synthetic, receipt).map((stage) => action('issue_ticket', {
                stage,
                ...(findings.length ? { review_findings: findings } : {}),
                ...(scopeExpansion ? { scope_expansion: scopeExpansion } : {}),
              })),
              action('persist_state'),
            ];
          }
          return [
            action('transition', {
              patch: {
                status: 'blocked',
                stage: 'remediation',
                block_reason: 'review disagreement persists after the single remediation cycle',
              },
            }),
            action('archive_history', { if_absent: true }),
            action('release_lock'),
            action('persist_state'),
          ];
        }
        // Roadmap entry forwarded-evidence-and-judge-visibility. plan-judge has
        // no parallel group and spends no remediation cycle (friction #22
        // below), so it never reaches the review-disagreed arm above — but the
        // judge still adjudicates a plan-check/plan-critic disagreement whose
        // own dissent text no channel delivered it (prompts/plan_judge.md tells
        // the judge to weigh "the dissent" while nothing attached it). Reuse
        // the IDENTICAL grounded, stage-labeled findings machinery
        // (reviewFindings / boundReviewFinding / boundReviewFindingsBlock, the
        // same three ceilings) a remediation-build ticket already receives,
        // computed from the same completedForGroup receipts that produced this
        // disagreement — never a second, divergent implementation.
        if (synthetic === 'plan-review-disagreed') {
          const findings = reviewFindings(event.next_state ?? state, receipts);
          return [
            ...nextStages(state, synthetic, receipt).map((stage) => action('issue_ticket', {
              stage,
              ...(findings.length ? { review_findings: findings } : {}),
            })),
            action('persist_state'),
          ];
        }
        return [
          ...nextStages(state, synthetic, receipt).map((stage) => action('issue_ticket', { stage })),
          action('persist_state'),
        ];
      }

      // friction #22: plan-judge has no parallel group, so groupOutcome never sees its
      // verdict. A passed receipt whose evidence records a negative verdict means
      // the judge upheld the disagreement: the plan is unsound and the run must
      // block instead of advancing to the test stage. An absent verdict falls back
      // to the receipt status (groupOutcome semantics), so a plain passed receipt
      // still advances.
      if (ticket.stage_id === 'plan-judge' && groupOutcome([receipt]) === 'disagreed') {
        return [
          action('transition', {
            patch: {
              status: 'blocked',
              stage: 'plan-judge',
              block_reason: 'plan judged unsound by the disagreement judge',
            },
          }),
          action('archive_history', { if_absent: true }),
          action('release_lock'),
          action('persist_state'),
        ];
      }

      const following = nextStages(state, ticket.stage_id, receipt);
      if (following.length > 0) {
        const sealed = ticket.stage_id === 'plan-judge'
          ? sealApprovedPlan(event.next_state ?? state, 'judge', receipt)
          : undefined;
        if (sealed === null) return planSealFailureActions();
        return [
          ...(sealed ? [action('transition', { patch: { approved_plan: sealed } })] : []),
          ...following.map((stage) => action('issue_ticket', { stage })),
          action('persist_state'),
        ];
      }
      if (ticket.stage_id === 'build' && state.lane === 'mechanical') {
        // The mechanical lane schedules no review group, so a trigger declared
        // at start or reported on this build receipt has no build→review point
        // to schedule the security review its armed conditional_audits gate
        // requires. Issue it here instead of running gates that
        // deterministically fail; its receipt re-enters through the
        // code-review group outcome above.
        const pending = pendingSecurityReviewStages(event.next_state ?? state);
        if (pending.length > 0) {
          return [
            ...pending.map((stage) => action('issue_ticket', { stage })),
            action('persist_state'),
          ];
        }
        return [action('run_gates'), action('persist_state')];
      }
      return [
        action('transition', { patch: { status: 'completed', stage: 'complete' } }),
        action('archive_history'),
        action('release_lock'),
        action('persist_state'),
      ];
    }
    case 'GATES_PASSED':
      // 'shipping' is no longer only a transient in-call state: with required
      // remote checks, auto_merge pushes + opens the PR and rests the run HERE
      // (status 'shipping', stage 'merge', a persisted shipping_watch, lock
      // still held), and each later `ape_run next` polls once via the NEXT
      // poll_shipping arm above until the checks go green and the merge lands.
      // required_remote_checks:false still merges in-call, so auto_merge reaches
      // MERGED within this same chain.
      return [
        action('transition', { patch: { status: 'shipping', stage: 'merge' } }),
        action('auto_merge'),
        action('persist_state'),
      ];
    case 'MERGED':
      return [
        action('transition', { patch: { status: 'completed', stage: 'complete', merge: event.merge } }),
        // A run that was re-gated OR held-then-shipped already has an immutable
        // block-time record in history (F7): a re-gate archived a gate-block
        // record, a hold archived its block-at-merge record. Its eventual
        // completion must NOT mutate that record — it is appended as a
        // superseding record that references the block record. A run that
        // reached merge on the uninterrupted first evaluation (no re-gate, no
        // hold-then-ship) archives its first record normally.
        action('archive_history', { superseding: (state.regate_attempts ?? 0) > 0 || state.ship_requested === true }),
        action('release_lock'),
        action('persist_state'),
      ];
    case 'GATES_FAILED': {
      // A ship authorization covers exactly one gate evaluation: clear
      // ship_requested so a later REGATE that goes green re-enters the
      // auto-merge hold instead of silently merging under shipping.auto_merge
      // !== true. Capture it first — a red ship's failed re-gate must reach
      // immutable history truthfully.
      const shipped = state.ship_requested === true;
      return [
        action('transition', {
          // prose-bound-exempt: event.reason on GATES_FAILED is always one of this
          // runtime's own fixed gate-diagnostic strings (the service's
          // reduceRun(GATES_FAILED) callers and gates.js's pollGateSuite failure
          // messages), never agent- or attacker-controlled text.
          patch: { status: 'blocked', stage: 'gates', block_reason: event.reason ?? 'merge gates failed', ship_requested: null },
        }),
        // A gate-blocked run must reach immutable history at the moment it
        // blocks (F7), not only when an operator later aborts or resets it. A
        // red SHIP is the one gate failure whose block-time record already
        // exists — the hold record (status blocked, stage merge, PASSING
        // gates) archived when the run first held. if_absent would keep that
        // stale record and lose the ship's failing-gate evidence (invariants 4
        // and 8), so a shipped failure archives a SUPERSEDING record carrying
        // the real failed gates; a plain first gate block (and a REGATE
        // re-failure, whose block-time record is itself a truthful gate block)
        // stays if_absent.
        action('archive_history', shipped ? { superseding: true } : { if_absent: true }),
        action('release_lock'),
        action('persist_state'),
      ];
    }
    case 'REGATE': {
      // Runtime-owned recovery for a run that blocked at the merge gates: after
      // the operator fixes the environment, re-gate re-runs the FULL gate suite
      // with no bypass and no waiver (invariant 9) — it reacquires the run lock
      // and re-enters the same run_gates path the first evaluation used. It is
      // valid ONLY for a gate block (status 'blocked', stage 'gates'); a
      // stage-failure or remediation block is not recoverable this way. The
      // reject names the audited alternative so the dead end is
      // self-documenting for the operator who tried it. When
      // test_commands.full_serial is configured, the re-gate full-suite run
      // uses the serialized variant (serial re-gate, 2.0.32; gates.js) — same suite, no waiver.
      if (state.status !== 'blocked' || state.stage !== 'gates') {
        // A run resting in a non-blocking watch is refused here too (it is not
        // blocked), and that refusal must not steer the operator at a recovery
        // that destroys healthy in-flight work.
        const resting = restStateGuidance(state);
        if (resting) {
          // prose-bound-exempt: fixed diagnostic template; ${resting} is
          // restStateGuidance's own fixed prose, whose only variable substring
          // (the persisted gate/shipping last_summary) is already bounded via
          // boundedGateSummary at the point it was persisted (service.js).
          return [action('reject', { reason: `re-gate is valid only for a gate-blocked run; ${resting}` })];
        }
        // Point an operator who reflexively re-gated a merge-hold at the correct
        // lever (SHIP) rather than only at the audited abort/reset dead end.
        // Keyed on block_reason, which only a genuinely blocked run carries —
        // both rest states (block_reason null) already returned above, so this
        // key drops no hint that could have applied.
        const shipHint = state.stage === 'merge' && state.block_reason === AUTO_MERGE_HOLD_REASON
          ? '; a run held at merge by disabled auto-merge is gate-and-merged with the audited SHIP lever'
          : '';
        // prose-bound-exempt: fixed diagnostic template; ${shipHint} is one of two
        // fixed string literals set two lines above, never agent-authored text.
        return [action('reject', { reason: `re-gate is valid only for a gate-blocked run; recover any other block through the audited OVERRIDE reset or ABORT${shipHint}` })];
      }
      const regateAttempts = state.regate_attempts ?? 0;
      if (regateAttempts >= MAX_REGATE_ATTEMPTS) {
        return [action('reject', {
          // prose-bound-exempt: fixed diagnostic template; ${MAX_REGATE_ATTEMPTS}
          // is a fixed numeric runtime constant, never agent-authored text.
          reason: `re-gate attempt limit reached (${MAX_REGATE_ATTEMPTS}); the gate block is exhausted`,
        })];
      }
      return [
        action('acquire_lock'),
        action('activate_run_branch'),
        action('transition', {
          patch: {
            status: 'running',
            stage: 'gates',
            // Each recovery consumes one bounded re-gate attempt.
            regate_attempts: regateAttempts + 1,
            // Leaving the terminal 'blocked' status: drop the block reason and
            // the block-time terminal stamp so an eventual completion re-stamps
            // a fresh terminal moment (F40) rather than reusing the block's.
            block_reason: null,
            terminal_at: null,
          },
        }),
        action('run_gates'),
        action('persist_state'),
      ];
    }
    case 'SHIP': {
      // Runtime-owned recovery for a run HELD at the merge gate by disabled
      // auto-merge (shipping.auto_merge !== true): green gates, but real
      // acceptance is out-of-band (hardware validation, manual checks), so the
      // run produced-and-held rather than merged. Ship re-runs the FULL
      // merge-gate suite against the CURRENT tree with no bypass and no waiver
      // (invariant 9 — the tree may have drifted while held, so the gates must
      // re-prove) and, on green, takes the same auto-merge path the first
      // evaluation would have; on red it lands in the ordinary gate block
      // (GATES_FAILED) where REGATE applies. Valid ONLY for the
      // auto-merge-disabled hold at stage 'merge', keyed on the exact reason so
      // no other stage-'merge' block is shippable by construction; the reject
      // names REGATE for a gate block and the audited exits for everything
      // else, mirroring the REGATE arm's self-documenting dead end.
      //
      // No ship attempt cap exists, and that is invariant 5 satisfied, not
      // violated: a green ship terminates the run, and every red exit lands in
      // the MAX_REGATE_ATTEMPTS-bounded gate block, so the hold↔ship↔regate
      // loop is transitively bounded. regate_attempts is left untouched, so a
      // previously-regated run's ship still selects test_commands.full_serial
      // through the existing serial re-gate signal (2.0.32).
      //
      // ship_requested is a ONE-SHOT authorization consumed by exactly one gate
      // evaluation: the service's auto_merge hold passes only while it is set,
      // and GATES_FAILED clears it. On a sealed completed run it persists as a
      // spent marker ("this run was shipped by operator action"), never as a
      // pending ship — MERGED admits no reader of it.
      if (state.status !== 'blocked' || state.stage !== 'merge' || state.block_reason !== AUTO_MERGE_HOLD_REASON) {
        // Same rest-state safety as the REGATE arm: a run already resting in a
        // watch is refused without being pointed at a run-destroying recovery.
        // The 'shipping' rest state is exactly where a re-issued SHIP lands
        // after a lost response, and aborting there kills an open PR.
        const resting = restStateGuidance(state);
        if (resting) {
          // A 'shipping' rest state with ship_requested still true can ONLY be
          // explained by the caller's OWN prior ship: this arm, just below, is
          // the sole place that ever sets it, and only GATES_FAILED (never
          // MERGED, which retains it as a spent marker) ever clears it. The
          // re-issue this covers is the lost-response case: the FIRST ship
          // already succeeded — it set ship_requested, re-ran the gates, and
          // GATES_PASSED rested the run here — so the refusal must attribute
          // the rest state to that prior success rather than lead with the
          // invalid-target prose below, which reads as the ship having done
          // nothing. Derived from state.ship_requested alone, so the reducer
          // stays pure; the ordinary (never-shipped) shipping rest state
          // keeps the unweakened invalid-target prose.
          if (state.status === 'shipping' && state.ship_requested === true) {
            // prose-bound-exempt: fixed diagnostic template; ${resting} is
            // restStateGuidance's own fixed prose (see the REGATE arm above).
            return [action('reject', { reason: `a prior ship on this run already succeeded — ${resting}` })];
          }
          // The 'gating' SIBLING of the case just above, closed together rather
          // than left half-fixed (rest-state ship-self-disclosure ticket, defect
          // 1): SHIP sets ship_requested true and emits run_gates, and a
          // detached gate suite that outlives gates.inline_grace_ms rests the
          // run HERE, in 'gating', with ship_requested still true — the
          // identical lost-response re-issue the shipping case covers, only
          // caught a few seconds earlier, while the very gate re-run this ship
          // triggered is still in flight. Same explanation as above (SHIP is the
          // sole setter of ship_requested, only GATES_FAILED — which this rest
          // state has by definition not yet reached — ever clears it), so the
          // same attribution applies. NOT the same wording, though: unlike the
          // shipping case, GATES_PASSED/GATES_FAILED has not fired yet here, so
          // the very ship that rests the run in this state could still fail its
          // own re-run of the gates. Saying it "already succeeded" would itself
          // be an untruthful disclosure (invariant 8); this says only that a
          // prior ship is why the gate suite is running, never how it ends.
          // Derived from state.ship_requested alone, so the reducer stays pure;
          // the ordinary (never-shipped) gating rest state keeps the unweakened
          // invalid-target prose below, same as the shipping case.
          if (state.status === 'gating' && state.ship_requested === true) {
            // prose-bound-exempt: fixed diagnostic template; ${resting} is
            // restStateGuidance's own fixed prose (see the REGATE arm above).
            return [action('reject', { reason: `a prior ship on this run triggered the gate suite now in progress — ${resting}` })];
          }
          // prose-bound-exempt: fixed diagnostic template; ${resting} is
          // restStateGuidance's own fixed prose (see the REGATE arm above).
          return [action('reject', { reason: `ship is valid only for a run held at merge by disabled auto-merge (shipping.auto_merge); ${resting}` })];
        }
        return [action('reject', { reason: 'ship is valid only for a run held at merge by disabled auto-merge (shipping.auto_merge); recover a gate block with REGATE and any other block through the audited OVERRIDE reset or ABORT' })];
      }
      return [
        action('acquire_lock'),
        action('activate_run_branch'),
        // prose-bound-exempt: constructs the audit_override action at reducer
        // level; the actual persistence sink (service.js's audit_override
        // handler) applies boundedGateSummary before this reason reaches
        // overrides.ndjson.
        action('audit_override', { operation: 'ship', reason: event.reason }),
        action('transition', {
          patch: {
            status: 'running',
            stage: 'gates',
            // One-shot authorization that passes the service auto_merge hold.
            ship_requested: true,
            // Leaving the terminal 'blocked' status: drop the block reason and
            // the block-time terminal stamp so an eventual completion re-stamps
            // a fresh terminal moment (F40) rather than reusing the hold's.
            block_reason: null,
            terminal_at: null,
          },
        }),
        action('run_gates'),
        action('persist_state'),
      ];
    }
    case 'SCOPE_EXPANDED': {
      // Mid-run escalation is a reduced transition, not an ad-hoc state write:
      // the event carries the already-classified lane, validated risk
      // triggers, and (for a review-proposed scope expansion, D3) the
      // service-validated claim paths; this arm derives the full patch —
      // including arming the security machinery (high_risk) — so pipeline
      // security-review and the conditional_audits gate observe every
      // reported trigger.
      const scope = event.scope ?? {};
      const patch = {};
      // Escalate-only at the reducer level: a mid-run scope expansion may raise
      // the lane, never lower it, and a lane the runtime does not recognize is
      // refused outright (indexOf -1, so it never outranks anything). 'auto' is
      // the lowest rank, so the pre-classification sentinel is refused too.
      // Without this guard the patch would write lane_escalated:true over a
      // DOWNGRADE — a lie in durable state. Nothing legitimate is refused:
      // escalateLane only ever escalates strictly upward in LANES, and the sole
      // emitter passes either a strict escalation or the current lane (which an
      // equal rank already excludes).
      if (typeof scope.lane === 'string' && LANES.indexOf(scope.lane) > LANES.indexOf(state.lane)) {
        patch.lane = scope.lane;
        patch.lane_escalated = true;
        patch.lane_reasons = [
          ...new Set([...(state.lane_reasons ?? []), ...(scope.lane_reasons ?? [])]),
        ];
      }
      const mergedTriggers = [
        ...new Set([...(state.risk_triggers ?? []), ...(scope.risk_triggers ?? [])]),
      ];
      // Keyed on trigger NAMES, not array LENGTH: a duplicate already sitting in
      // state.risk_triggers makes the merged (deduped) list no longer than the
      // stored one, which would silently drop a genuinely new trigger. Assigning
      // the deduped merged list also cleans up that pre-existing duplicate.
      if (mergedTriggers.some((trigger) => !(state.risk_triggers ?? []).includes(trigger))) {
        patch.risk_triggers = mergedTriggers;
      }
      if (mergedTriggers.length > 0 && state.high_risk !== true) {
        patch.high_risk = true;
      }
      // Claim growth is an override-class operation: audited BEFORE the
      // transition (the override idiom), so overrides.ndjson carries the
      // reason and exact added paths even if the transition never persists.
      // The next issued writing ticket (remediation-build) inherits the
      // expanded set through ticketClaims, which the write-time hook and
      // drift guard then honor — no hook change needed.
      const addedPaths = [...new Set(scope.claimed_paths ?? [])].filter(
        (claim) => !(state.claimed_paths ?? []).includes(claim),
      );
      if (addedPaths.length > 0) {
        patch.claimed_paths = [...(state.claimed_paths ?? []), ...addedPaths];
        // Roadmap entry forwarded-evidence-and-judge-visibility: record the
        // accepted growth durably, keyed by the PROPOSING ticket's own
        // ticket_id, so groupScopeExpansion (above) can read it back at
        // group-completion time regardless of which receipt in the group
        // arrives last — the state-derived shape declaredTestRemediationPaths
        // (pipeline.js) already uses for its own structural sibling channel.
        if (event.ticket_id) {
          patch.pending_scope_expansions = {
            ...(state.pending_scope_expansions ?? {}),
            [event.ticket_id]: {
              claimed_paths: addedPaths,
              // scope.reason is the reviewer's own scope_expansion reason,
              // forwarded by service.js from extractScopeExpansion's own
              // validated (non-empty) result; its only consumer,
              // issueTicket's scopeExpansionNotice (service.js), passes it
              // through boundedGateSummary via boundedScopeExpansion before
              // it ever reaches a ticket objective.
              // prose-bound-exempt: downstream reuse into an already-bounded
              // sink, not a new one — mirrors the audit_override reason a
              // few lines below.
              reason: scope.reason ?? null,
            },
          };
        }
      }
      if (Object.keys(patch).length === 0) return [action('persist_state')];
      return [
        ...(addedPaths.length > 0
          ? [action('audit_override', {
              operation: 'scope-expansion',
              // prose-bound-exempt: constructs the audit_override action at
              // reducer level; the actual persistence sink (service.js's
              // audit_override handler) applies boundedGateSummary before this
              // reason reaches overrides.ndjson.
              reason: scope.reason ?? 'review-proposed scope expansion',
              added_paths: addedPaths,
            })]
          : []),
        action('transition', { patch }),
        action('persist_state'),
      ];
    }
    case 'EXPIRE_DISPATCH': {
      // Audited operator lever for a wedged dispatch (frictions #27/#30): a bound intent
      // whose parent session died, or whose agent ended with prose instead of
      // the receipt, leaves the ticket pending until its deadline. Expiry takes
      // the deadline-timeout exit early — same retry budget, same honest block
      // — and is valid only for a named pending ticket of a running run.
      if (state.status !== 'running') {
        // prose-bound-exempt: fixed diagnostic template; ${state.status} is a
        // fixed enum run status, never agent- or attacker-controlled text.
        return [action('reject', { reason: `expire-dispatch is valid only for a running run (run is ${state.status})` })];
      }
      const ticket = state.tickets.find((entry) => entry.ticket_id === event.ticket_id);
      if (!ticket) {
        // prose-bound-exempt: fixed diagnostic template echoing the caller's own
        // ticket_id operand back in an unknown-ticket refusal, a known residual
        // (recorded, not closed, by roadmap sink-guard-coverage-and-detection-
        // completeness) — the operand is never persisted and never neutralized
        // on this path.
        return [action('reject', { reason: `expire-dispatch: unknown ticket ${event.ticket_id ?? '(unset)'}` })];
      }
      if (expiredTicketIds(state).has(ticket.ticket_id)) {
        // prose-bound-exempt: fixed diagnostic template; ticket.ticket_id is this
        // run's own runtime-generated ticket id, never agent-authored free text.
        return [action('reject', { reason: `expire-dispatch: ticket ${ticket.ticket_id} is already expired` })];
      }
      if (state.receipts.some((receipt) => receipt.ticket_id === ticket.ticket_id)) {
        // prose-bound-exempt: fixed diagnostic template; ticket.ticket_id is this
        // run's own runtime-generated ticket id, never agent-authored free text.
        return [action('reject', { reason: `expire-dispatch: ticket ${ticket.ticket_id} already has a receipt` })];
      }
      return [
        action('audit_override', {
          operation: 'expire-dispatch',
          ticket_id: ticket.ticket_id,
          // prose-bound-exempt: constructs the audit_override action at reducer
          // level; the actual persistence sink (service.js's audit_override
          // handler) applies boundedGateSummary before this reason reaches
          // overrides.ndjson.
          reason: event.reason,
        }),
        ...expirePendingTicket(
          state,
          ticket,
          `stage ${ticket.stage_id} dispatch expired by operator after retry`,
        ),
      ];
    }
    case 'ABORT':
      return [
        action('transition', { patch: { status: 'aborted', stage: 'aborted', abort_reason: event.reason } }),
        // if_absent: aborting an already-blocked run must not duplicate or
        // conflict with the record archived when the run became blocked (F7);
        // the block-time record wins, matching the override abort/reset paths.
        action('archive_history', { if_absent: true }),
        action('release_lock'),
        action('persist_state'),
      ];
    case 'OVERRIDE': {
      // Override terminations are runtime-owned transitions too: they must
      // archive to history before the run's state is deleted or sealed (F7),
      // so validation happens here — never after an archive already ran. The
      // operation itself validates FIRST: an unknown (or missing) operation
      // used to fall through to [audit_override, apply_override], appending a
      // permanent overrides.ndjson line for an override that then threw and
      // was never applied — a falsified entry in an audit log. applyActions'
      // apply_override throw stays as defense in depth.
      if (event.operation !== 'reset' && event.operation !== 'abort') {
        const got = event.operation === undefined ? '(unset)' : `'${event.operation}'`;
        // prose-bound-exempt: fixed diagnostic template echoing the caller's own
        // invalid operation operand back in the refusal, a known residual
        // (recorded, not closed, by roadmap sink-guard-coverage-and-detection-
        // completeness) — the operand is never persisted and never neutralized
        // on this path.
        return [action('reject', { reason: `override operation must be 'abort' or 'reset'; got ${got} — override cannot bypass evidence or merge gates` })];
      }
      if (event.operation === 'reset' && !TERMINAL_STATUSES.has(state.status)) {
        // friction #29: a running run always has a forward path — name the real levers
        // instead of leaving a wedged operator with an unusable refusal.
        //
        // DECISION, recorded rather than left unexamined (rest-state
        // ship-self-disclosure ticket, defect 2): 'gating' and 'shipping' are
        // absent from TERMINAL_STATUSES, so an override reset issued from
        // either healthy rest state also lands here and reads this same
        // "for a running run use abort" advice — while a detached gate suite
        // is running healthily or an open PR's remote checks are mid-flight.
        // Left AS-IS, deliberately, unlike the REGATE/SHIP rest-state fix
        // above (restStateGuidance): those levers are refused for a run that
        // ISN'T asking to be destroyed, so pointing them at OVERRIDE/ABORT is
        // a misdirection restStateGuidance exists to remove. An override
        // RESET call is the opposite case — the caller has already asked for
        // a destructive exit — so naming abort as the way to get one for a
        // running run is an honest answer to the request actually made, not
        // a misdirection. Routing this refusal through restStateGuidance too
        // would instead suppress the one lever whose entire purpose is to
        // destroy the run, second-guessing an explicit operator choice rather
        // than protecting an operator who never asked to abort anything. An
        // operator who wants the run to keep advancing already has NEXT (and
        // simply not calling OVERRIDE) — this guard only ever answers a call
        // that already chose override reset.
        return [action('reject', { reason: 'override reset is allowed only for a terminal or blocked run; for a running run use abort, or expire-dispatch to void a wedged in-flight dispatch' })];
      }
      if (event.operation === 'abort' && state.status === 'completed') {
        return [action('reject', { reason: 'a completed run cannot be overridden to aborted; use override reset' })];
      }
      // prose-bound-exempt: constructs the audit_override action at reducer
      // level; the actual persistence sink (service.js's audit_override handler)
      // applies boundedGateSummary before this reason reaches overrides.ndjson.
      const audit = action('audit_override', { reason: event.reason, operation: event.operation });
      if (event.operation === 'reset') {
        // Archive before apply_override removes active.json: a reset run must
        // reach history before the only copy of its state is erased (F7).
        return [
          audit,
          action('archive_history', { if_absent: true }),
          action('apply_override', { operation: 'reset' }),
        ];
      }
      return [
        audit,
        action('apply_override', { operation: 'abort' }),
        action('archive_history', { if_absent: true }),
        action('release_lock'),
        action('persist_state'),
      ];
    }
    case 'STATUS':
      return [action('status', { state })];
    default:
      // prose-bound-exempt: fixed diagnostic template; ${event.type} is the
      // internal dispatch event's own type tag, never agent-authored free text.
      return [action('reject', { reason: `unknown event type: ${event.type}` })];
  }
}
