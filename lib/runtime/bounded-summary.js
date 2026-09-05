// Construct invisible-character ranges from numeric code points so source
// remains printable and auditable.
export function codePointRange(startCodePoint, endCodePoint) {
  const start = String.fromCharCode(startCodePoint);
  return endCodePoint > startCodePoint ? `${start}-${String.fromCharCode(endCodePoint)}` : start;
}

export const REPLACEMENT_CHARACTER = String.fromCharCode(0xfffd);

// Roadmap entry bounded-summary-control-character-passthrough. THE CHARACTER
// SET this helper neutralizes, beyond the whitespace class it already
// flattens: C0 controls minus whitespace (U+0000-U+0008, U+000E-U+001F), DEL
// through the whole C1 block (U+007F-U+009F -- one RANGE, stopping exactly
// one code point below U+00A0 so a NBSP is never caught; see RESIDUALS
// below), soft hyphen (U+00AD), the Arabic Letter Mark (U+061C), the
// zero-width/bidi-mark block (U+200B-U+200F), the bidi embedding/override
// controls (U+202A-U+202E), the invisible-operator/deprecated-bidi block
// (U+2060-U+206F, which contains the LRI/RLI/FSI/PDI isolates U+2066-U+2069)
// and the interlinear-annotation trio (U+FFF9-U+FFFB, used to hide text
// between visible glyphs). U+061C and U+FFF9-U+FFFB EXTEND past the approved
// plan's mandated minimum (roadmap discussion point C6): both are BMP and
// length-safe (see CAP INVARIANCE below), squarely inside the stated
// bidi/hiding threat model, and already refused by this repo's sibling
// evidence-command character policy
// (__tests__/runtime-v2-evidence-character-allowlist.test.js:169's
// UNAUDITABLE_CATEGORY, which refuses the whole \p{Cf} class for the
// identical "invisible, so text becomes unauditable" reason).
//
// EXPLICIT CODE POINTS, NOT \p{C}/\p{Cf}. \p{Cf} would wrongly sweep up
// U+FEFF (BOM, an ordinary stream-start marker rather than a hiding
// technique) -- but the DECISIVE reason (discussion point C3) is CAP
// INVARIANCE: \p{Cf} also contains ASTRAL members (U+110BD, U+13430-U+13440,
// U+1BCA0-U+1BCA3, U+1D173-U+1D17A, U+E0001, U+E0020-U+E007F), each TWO
// UTF-16 units. Replacing a 2-unit match with the 1-unit REPLACEMENT_CHARACTER
// would SHORTEN the string and move the `max`-based slice boundary below --
// a length-changing "sanitizer" would reintroduce, one level up, exactly the
// kind of bug this fix exists to close. Every member of the set actually
// used here is BMP (max U+FFFB) and exactly one UTF-16 unit, matching
// REPLACEMENT_CHARACTER unit-for-unit, so a 1:1 replace can never move that
// boundary.
//
// REPLACE, never STRIP -- recorded here with the reasoning, per the ticket's
// deliverable:
//   - Stripping shortens the surrounding legitimate text with no trace;
//     replacing 1:1 with U+FFFD preserves both the position and the length
//     of everything around the neutralized byte (see CAP INVARIANCE).
//   - THE DECISIVE GROUND (discussion point C17): renderPlanArtifactEntry's
//     collision guard (isPlanArtifactMarkerShaped, below) neutralizes any
//     planner-derived entry that OPENS with the reserved brand
//     '[APE runtime]'. Under REPLACE, a planner value beginning
//     "ESC[APE runtime]..." renders as "U+FFFD[APE runtime]..." and still
//     does not open with the brand -- the guard is never triggered by a byte
//     this function itself introduces. Under STRIP that same input would be
//     PROMOTED into marker shape, wrongly caught by the guard, and wrapped
//     in the collision prefix: a SECOND, compounding byte change that
//     misrepresents a planner entry as the runtime's own omission marker.
//
// ORDER: replace -> flatten -> trim -> empty-to-null -> cap (the last four
// steps are unchanged from today). ORDER INVARIANCE holds: every member of
// this set is disjoint from JS `\s` at every boundary (U+200A|U+200B,
// U+202E|U+202F, U+205F|U+2060, U+009F|U+00A0 -- each exactly one code point
// apart), so replacing first can never change what the flatten step sees on
// input free of this set, and every existing caller's test stays green and
// unmodified.
//
// FIVE DISTINCT CHARACTER POLICIES COEXIST across this codebase -- four of
// them for agent-facing prose, enumerated here so a future reader -- and a
// future "single choke point" claim -- states the true count instead of
// rediscovering it (roadmap entry agent-facing-text-routes-bypassing-the-
// prose-bound: acme PR #397 asserted this helper was the ONE choke point every
// bounded agent-facing string flows through, and both the code reviewer and
// the conditional security reviewer of that entry independently proved the
// premise false). A comment that again under-enumerates this set reproduces
// the exact defect that entry exists to close -- keep the list current when
// any of the five changes:
//   1. BOUNDED_SUMMARY_CONTROL_CHARS (here, RENDER side) -- exact code
//      points, REPLACE with U+FFFD, includes U+200C/U+200D (ZWNJ/ZWJ).
//   2. SCOPE_EXPANSION_CONTROL_CHARS (below, ADMISSION side, and its
//      pipeline.js duplicate TEST_REMEDIATION_CONTROL_CHARS) -- the same
//      code points as policy 1, minus U+200C/U+200D. Deliberate siblings with
//      policy 1, never unify them (doing so starts refusing ZWNJ/ZWJ-bearing
//      paths valid today, or stops neutralizing them wherever policy 1
//      renders one later -- see the ONE-SIDED EXEMPTION residual below).
//   3. scheduler.js REVIEW_TEXT_FLATTEN (`/[\p{Cc}\p{Cf}\s]+/gu`) -- the
//      WHOLE Cc+Cf Unicode category, collapsed (not replaced) to a single
//      space, feeding review_findings. Broader and STRIP-shaped rather than
//      this file's explicit-range REPLACE. CORRECTED CLAIM (re-verified
//      against merged main at 69430ccd, scheduler.js IS claimed by this run):
//      attemptSummaryList (scheduler.js ~:78-85, feeding prior_attempts and
//      the block-reason diagnostic) now calls this SAME flattenReviewText
//      helper, not a bare `/\s+/` that neutralized no control/format
//      character -- the two routes in this module are consistent with each
//      other, not a fifth divergent one.
//   4. gates.js boundedTail -- ANSI/CSI plus C0/DEL only (no C1, no
//      bidi/format block), STRIPPED rather than replaced, feeding a gh output
//      tail into poll.pending.summary/poll.failed before either ever reaches
//      a boundedGateSummary call site below.
//   5. hooks.js WRITE_CONTENT_HAZARD_CHARS (the write-content byte gate) --
//      DELIBERATELY WIDER than policy 2, and NOT a duplicate of it (roadmap
//      entry authored-and-agent-facing-byte-integrity): it is not
//      agent-facing prose at all, but a gate on bytes entering TRACKED SOURCE
//      through a Write/Edit/MultiEdit/NotebookEdit/apply_patch payload, a
//      materially different threat model, so it is recorded here as its OWN
//      policy rather than filed under policy 2. Beyond policy 2's set it also
//      refuses U+2028/U+2029 (LINE/PARAGRAPH SEPARATOR, both ECMAScript
//      LineTerminators), U+FEFF (BOM, ECMAScript WhiteSpace), and the astral
//      TAGS block (U+E0001, U+E0020-U+E007F). Never re-sync it down to
//      policy 2's narrower set -- a maintainer who did would reopen the two
//      bypasses that widening closed. __tests__/runtime-v2-character-policy-
//      divergence.test.js pins this divergence against both the live exports
//      and the registry prose in this file and in pipeline.js.
//
// RESIDUALS RECORDED, NOT FIXED (roadmap discussion points C8/C9/C14, plus
// this entry's own follow-ons -- each asked to be recorded here, not closed):
//   - The `\s+` flatten below still carves out ordinary whitespace (newline,
//     NBSP) exactly as it always has; nothing here narrows that, so a claim
//     path or reason carrying one still lands verbatim wherever a caller
//     does not itself refuse it (e.g. the overrides.ndjson scope-expansion
//     audit line).
//   - ONE-SIDED EXEMPTION (policy 2 above): SCOPE_EXPANSION_CONTROL_CHARS
//     admits U+200C/U+200D whole, but this render-side set still maps them
//     to U+FFFD wherever the SAME path is later shown to an agent (e.g. an
//     inherited-base notice) -- a legitimately valid path admitted whole can
//     still be rendered mangled later. A new misrepresentation of VALID
//     input, left for a future ticket.
//   - extractScopeExpansion (below) and pipeline.js's extractTestRemediation
//     both now screen policy 2's admission set on their respective declared
//     paths; the test_writer `changed_files` route (feeding
//     state.test_paths at ~:3347, then ticketClaims above) needs no such
//     screen -- it is RUNTIME-DERIVED from a real git diff and stamped over
//     the agent-supplied value before either the receipt or state.test_paths
//     is touched (:3190/:3223 below), so it can never carry an injected byte
//     in the first place.
//   - Legacy/seeded state: bounding shipping_watch.last_checks_summary at its
//     assignment (poll_shipping action handler, below) covers only state
//     WRITTEN after this change. A pre-existing active.json persisted before
//     it still carries an unbounded summary, and scheduler.js's SHIP
//     rest-state refusal renders that persisted field verbatim (pinned at
//     __tests__/runtime-v2-rest-state-ship-self-disclosure.test.js:251,:451)
//     -- RE-CORRECTED CLAIM (review, this run): the prior text here ("scheduler.js
//     is claimed by later work — this file's abort_reason bind above") is not
//     evidence of anything: that bind lives in THIS file, below this comment,
//     and is not a scheduler.js change at all. The pinned test is not the
//     obstacle either — it pins CHECKS_SUMMARY, a short printable-ASCII literal
//     on which boundedGateSummary is provably identity, so binding at the
//     render site would not disturb it. The REAL obstacle is module structure:
//     boundedGateSummary is defined below and stays non-exported, and this
//     file already imports reduceRun from scheduler.js (see the import list at
//     the top of the file) — so scheduler.js's restStateGuidance importing it
//     back would create a cycle. Recorded, not closed, for THAT reason, not a
//     claim-set limit: scheduler.js IS claimed by this run.
export const BOUNDED_SUMMARY_CONTROL_CHARS = new RegExp(
  '[' +
    codePointRange(0x0000, 0x0008) +
    codePointRange(0x000e, 0x001f) +
    codePointRange(0x007f, 0x009f) +
    codePointRange(0x00ad, 0x00ad) +
    codePointRange(0x061c, 0x061c) +
    codePointRange(0x200b, 0x200f) +
    codePointRange(0x202a, 0x202e) +
    codePointRange(0x2060, 0x206f) +
    codePointRange(0xfff9, 0xfffb) +
  ']',
  'g',
);

// Bound a persisted gate-poll summary so the watch cursor never carries an
// unbounded blob (≤400): control/bidi-neutralized (see
// BOUNDED_SUMMARY_CONTROL_CHARS above), whitespace-flattened, hard-capped
// with an ellipsis.
export function boundedGateSummary(text, max = 400) {
  const neutralized = String(text ?? '').replace(BOUNDED_SUMMARY_CONTROL_CHARS, REPLACEMENT_CHARACTER);
  const flat = neutralized.replace(/\s+/g, ' ').trim();
  if (flat === '') return null;
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

