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

const BLOCK_SUMMARY_LIMIT = 120;

// The pure per-attempt summary list: one entry per recorded stage attempt,
// 'attempt N: <flattenReviewText-flattened, 120-char-capped summary>' with a
// '(no summary)' placeholder, plus whether ANY attempt carried an informative
// evidence.summary/reason. Receipt-derived and persisted-field-only. Two
// consumers share it: the block-reason wrapper below (diagnostics) and the
// retry/expiry arms, which thread the informative list onto the reissued
// ticket as prior_attempts so the retry agent knows why the prior attempt(s)
// failed instead of repeating them.
export function attemptSummaryList(state, stageId, currentTicketId = null, currentReceipt = null) {
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
export function attemptSummaries(state, stageId, currentTicketId = null, currentReceipt = null) {
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
function selectReviewFindings(state, receipts) {
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

export const reviewFindings = Object.freeze({
  select: selectReviewFindings,
  attemptSummaryList,
  attemptSummaries,
});

