import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { evaluateWriteContentPolicy } from '../lib/runtime/hooks.js';

// ===========================================================================
// NEW SUITE, authored by acme PR #402 (it did not exist on any earlier tree).
// Defect E of acme PR #402's objective: lib/runtime/service.js's
// SCOPE_EXPANSION_CONTROL_CHARS comment and lib/runtime/pipeline.js's
// TEST_REMEDIATION_CONTROL_CHARS comment both describe those two registries
// as carrying "the identical code points" as lib/runtime/hooks.js's
// WRITE_CONTENT_HAZARD_CHARS (the write-content byte gate), "MINUS
// U+200C/U+200D", and instruct a maintainer to keep all three registries
// hand-synced. That claim is FALSE and LOAD-BEARING: acme PR #402's restore
// deliberately widened the hooks.js copy alone (it alone gates bytes
// entering EXECUTABLE SOURCE — a materially different threat model from the
// other two, which bound OPERATOR-FACING text) to also refuse U+2028/U+2029
// (ECMAScript LineTerminators that can smuggle executable content past a
// `//` comment) and the invisible-text channels U+FEFF and the astral TAGS
// block (U+E0001, U+E0020-U+E007F). A maintainer who obeyed the "keep in
// lockstep by hand" instruction and re-narrowed the hooks.js copy to match
// its two siblings would REOPEN both bypasses acme PR #402's work closed.
//
// THIS SUITE PROVES THE DIVERGENCE FROM TWO INDEPENDENT DIRECTIONS, so
// EITHER a stale comment or a code regression reddens it on its own:
//   (1) SOURCE TEXT — service.js and pipeline.js must no longer claim the
//       three registries are identical, and must instead record, in their
//       own prose, that the hooks.js copy is deliberately WIDER and must not
//       be re-synced downward; hooks.js's OWN registry-count prose is now
//       checked too (a third FILE inside this same direction, never a third
//       direction -- there are still exactly two proof directions below), so
//       it cannot under-enumerate the same policy list service.js names, or
//       drop its own wider/do-not-re-sync-down instruction about itself.
//   (2) LIVE BEHAVIOR — hooks.js's own exported evaluateWriteContentPolicy
//       must actually refuse each hooks.js-only widened code point/range
//       named in the `cases` list below, one assertion per range (a count is
//       never hard-coded here either, for the identical reason: the list IS
//       the count), so a PARTIAL narrowing (e.g. widening restored for
//       U+2028 but not for the TAGS block) reddens exactly the dropped range
//       rather than being masked by a single combined assertion.
//
// DELIBERATELY ONE-DIRECTIONAL (plan-critic review of acme PR #402's plan).
// service.js's extractScopeExpansion is NOT exported (verified against this
// tree's own source — no `export` keyword precedes its declaration) and
// pipeline.js's extractTestRemediation IS exported, but this suite asserts
// NOTHING about either sibling admitting or refusing these four ranges.
// Asserting that a sibling ADMITS U+FEFF/U+2028/TAGS would pin the siblings'
// present NARROWNESS as a contract: both siblings are driveable (one
// directly, one only through the public service.js surface), which makes
// that assertion easy to write and wrong to make — it would redden on a
// future, CORRECT widening of the operator-facing copies, the mirror image
// of the very defect this suite exists to catch. So this suite checks only
// that the GATE refuses what its own restored comments say it refuses, and
// that neither sibling's prose misdescribes that gate as matching itself.
// ===========================================================================

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

function readRepoFile(...segments) {
  return readFileSync(path.join(ROOT, ...segments), 'utf8');
}

function readRequiredOwner(file) {
  const absolute = path.join(ROOT, 'lib', 'runtime', file);
  expect(existsSync(absolute), `missing required owner: lib/runtime/${file}`).toBe(true);
  return existsSync(absolute) ? readFileSync(absolute, 'utf8') : '';
}

// This repo hand-wraps `//` line comments at a fixed column (the same
// technique __tests__/runtime-v2-shipped-surface-truthfulness.test.js's own
// flattenWhitespace note describes for docs/ prose), so a literal phrase
// pinned below can straddle a source newline AND the next line's own `//`
// comment-marker without ceasing to be one sentence a reader sees. Strips a
// line-leading `//` marker (only where a line actually starts with one,
// after indentation — an ordinary code line is left untouched) before
// flattening every run of whitespace to a single space, so the check answers
// about the rendered PROSE, not about where a rewrap happens to break the
// line or which comment style carries it.
function flattenCommentProse(text) {
  return text
    .split('\n')
    .map((line) => line.replace(/^\s*\/\/[ \t]?/, ''))
    .join(' ')
    .replace(/\s+/g, ' ');
}

describe('receipt-service.js and pipeline.js no longer misdescribe their character-policy registries as identical to the write-policy.js write-content gate', () => {
  it('receipt-service.js does not claim its SCOPE_EXPANSION_CONTROL_CHARS registry carries "the identical code points" as write-policy.js, minus U+200C/U+200D', () => {
    const text = flattenCommentProse(readRequiredOwner('receipt-service.js'));
    expect(text).not.toMatch(/identical code points MINUS U\+200C\/U\+200D/);
  });

  it('pipeline.js does not instruct a maintainer to keep its TEST_REMEDIATION_CONTROL_CHARS registry hand-synced with the other two as though they were one set', () => {
    const text = flattenCommentProse(readRepoFile('lib', 'runtime', 'pipeline.js'));
    expect(text).not.toMatch(/keep (the two|all three) in lockstep by hand/i);
  });

  it('both files instead record that the write-policy.js write-content gate is deliberately WIDER than its two siblings', () => {
    for (const [label, segments] of [
      ['receipt-service.js', null],
      ['pipeline.js', ['lib', 'runtime', 'pipeline.js']],
    ]) {
      const text = flattenCommentProse(segments ? readRepoFile(...segments) : readRequiredOwner(label));
      expect(text, `${label} must describe the write-policy.js copy as deliberately wider than this file's own registry`).toMatch(
        /write-policy\.js[^\n]{0,400}\bwider\b|\bwider\b[^\n]{0,400}write-policy\.js/i,
      );
    }
  });

  it('both files warn against re-narrowing (re-syncing downward) the write-policy.js copy to match its siblings', () => {
    for (const [label, segments] of [
      ['receipt-service.js', null],
      ['pipeline.js', ['lib', 'runtime', 'pipeline.js']],
    ]) {
      const text = flattenCommentProse(segments ? readRepoFile(...segments) : readRequiredOwner(label));
      expect(
        text,
        `${label} must warn a future maintainer against re-narrowing/re-syncing the write-policy.js copy downward`,
      ).toMatch(/re-sync\w*[^\n]{0,120}down|must not be re-synced downward|never (re-)?narrow\w*[^\n]{0,120}write-policy\.js/i);
    }
  });
});

// ===========================================================================
// R3 (roadmap entry doc-and-comment-accuracy-sweep, residual R3). This suite
// used to read service.js's and pipeline.js's own prose about the hooks.js
// divergence but never hooks.js's OWN registry-count comment about itself --
// exactly why hooks.js's stale "policy 2 of the FOUR" wording once survived
// review while this whole suite stayed green (a divergence check that never
// reads one of the diverging files cannot catch that file going stale). This
// is a THIRD FILE checked under the existing SOURCE TEXT direction above,
// never a third proof direction. The count is DERIVED from service.js's own
// numbered enumeration rather than pinned to a literal word: pinning a
// literal here would reproduce the identical stale-count defect class this
// arm exists to close, the moment a sixth policy is ever added.
// ===========================================================================
const POLICY_COUNT_WORDS = Object.freeze({
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
});

// Scoped to the numbered list under service.js's "FIVE DISTINCT CHARACTER
// POLICIES" comment alone (never the whole multi-thousand-line file), so an
// unrelated numbered list elsewhere in the file can never be mistaken for
// this enumeration.
function countReceiptServiceEnumeratedPolicies(receiptServiceText) {
  const block = receiptServiceText.match(/DISTINCT CHARACTER POLICIES[\s\S]*?RESIDUALS RECORDED/);
  if (!block) return 0;
  const numbered = [...block[0].matchAll(/\/\/\s*(\d+)\.\s/g)].map((entry) => Number(entry[1]));
  return numbered.length ? Math.max(...numbered) : 0;
}

describe("write-policy.js's own registry-count prose does not under-enumerate receipt-service.js's character-policy count, and still records its own wider/do-not-re-sync-down instruction", () => {
  it("names a policy count at least as large as receipt-service.js's own numbered enumeration (derived, never a pinned literal)", () => {
    const receiptServiceText = readRequiredOwner('receipt-service.js');
    const trueCount = countReceiptServiceEnumeratedPolicies(receiptServiceText);
    expect(trueCount, "receipt-service.js's own numbered policy list was not found").toBeGreaterThan(0);

    const writePolicyText = flattenCommentProse(readRequiredOwner('write-policy.js'));
    const claim = writePolicyText.match(/\bpolicy 2 of the (\w+)\b/i);
    expect(claim, 'write-policy.js no longer names how many character policies receipt-service.js enumerates').not.toBeNull();
    const claimedCount = POLICY_COUNT_WORDS[claim[1].toLowerCase()];
    expect(claimedCount, `write-policy.js names an unrecognized count word "${claim[1]}"`).toBeDefined();
    expect(
      claimedCount,
      `write-policy.js under-enumerates: it names ${claim[1]} but receipt-service.js's own list now enumerates ${trueCount}`,
    ).toBeGreaterThanOrEqual(trueCount);
  });

  it('still records that its own WRITE_CONTENT_HAZARD_CHARS set is deliberately wider than policy 2 at the genuine write-policy.js owner', () => {
    const writePolicyText = flattenCommentProse(readRequiredOwner('write-policy.js'));
    expect(writePolicyText).toMatch(/\bwider\b.{0,300}\bpolicy 2\b|\bpolicy 2\b.{0,300}\bwider\b/i);
  });

  it("still warns against re-narrowing (re-syncing downward) its own set to policy 2's at the genuine write-policy.js owner", () => {
    const writePolicyText = flattenCommentProse(readRequiredOwner('write-policy.js'));
    expect(writePolicyText).toMatch(/re-sync\w*[^\n]{0,120}down|must not be re-synced downward|never (re-)?narrow\w*[^\n]{0,120}write-policy\.js/i);
  });
});

describe('evaluateWriteContentPolicy (hooks.js, live export) refuses each hooks.js-only widened code point/range in the cases list below, one assertion per range', () => {
  // Every hazard byte below is synthesized numerically (String.fromCharCode/
  // fromCodePoint), never a literal character or a `\u` escape in this
  // file's own source text, per the authoring hazard binding every file this
  // gate touches: this gate would deny the write of a literal instance.
  const cases = [
    ['U+2028 LINE SEPARATOR', String.fromCharCode(0x2028), /U\+2028/],
    ['U+2029 PARAGRAPH SEPARATOR', String.fromCharCode(0x2029), /U\+2029/],
    ['U+FEFF ZERO WIDTH NO-BREAK SPACE (byte order mark)', String.fromCharCode(0xfeff), /U\+FEFF/],
    // U+E0021 TAG EXCLAMATION MARK sits inside the astral TAGS block
    // (U+E0020-U+E007F) and, like every TAGS member, is outside the BMP, so
    // it needs fromCodePoint rather than fromCharCode to synthesize
    // correctly.
    ['U+E0021 TAG EXCLAMATION MARK (astral TAGS block)', String.fromCodePoint(0xe0021), /U\+E0021/],
    // U+E0001 LANGUAGE TAG is its OWN standalone range(0xe0001, 0xe0001) in
    // hooks.js's writeContentHazardPattern, separate from the
    // U+E0020-U+E007F TAG-character range above -- a single-line deletion of
    // that one range would leave the U+E0021 case above green while this
    // gate silently stopped refusing U+E0001, so it needs its own case
    // rather than being folded into the U+E0021 arm.
    ['U+E0001 LANGUAGE TAG (astral TAGS block, standalone code point)', String.fromCodePoint(0xe0001), /U\+E0001/],
  ];

  for (const [label, hazardChar, reasonPattern] of cases) {
    it(`refuses a Write.content that decodes to ${label} -- a range hooks.js's own restored comments say it refuses but its two siblings deliberately do not`, () => {
      const result = evaluateWriteContentPolicy('Write', { content: `before${hazardChar}after` });
      expect(
        result?.safe,
        `evaluateWriteContentPolicy did not refuse ${label}: ${JSON.stringify(result)}`,
      ).toBe(false);
      expect(result?.reason).toMatch(reasonPattern);
    });
  }
});
