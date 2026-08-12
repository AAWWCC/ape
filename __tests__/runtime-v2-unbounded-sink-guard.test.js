import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// Roadmap entry sink-guard-coverage-and-detection-completeness (follow-up to
// agent-facing-text-routes-bypassing-the-prose-bound). A prior mechanical
// guard (preserved at `git show wip/sink-guard-blocked-review:
// __tests__/runtime-v2-unbounded-sink-guard.test.js`, never landed) computed
// candidate sink sites with a LINE-ORIENTED, start-anchored, colon-only match
// (`/^(reason|summary|message|block_reason|last_checks_summary)\s*:\s*(.+?),?
// \s*$/` applied to `rawLine.trim()`). Both reviewers of that diff
// independently proved that shape sees a sink key ONLY as the first token of
// a trimmed line -- blind to an inline object literal (the DOMINANT `reason`
// shape in scheduler.js and gates.js) and to ES6 shorthand. Measured on main
// at 5d0a46d8, comment lines excluded: service.js 49 code-line sink keys
// (guard saw 24), scheduler.js 29 (saw 9), gates.js 18 (saw 6), pipeline.js 6
// (saw 2) -- 41 of 102, 40% of the class it claimed to compute. The shorthand
// gap hid a LIVE defect: two shorthand-shaped sinks (the corrupt-state and
// orphaned-lock override-reset audit lines) write the operator's `reason`
// raw and unbounded, pinned RED independently at
// runtime-v2-override-reason-audit-bound.test.js.
//
// THIS FILE replaces the line-oriented match with MASK-THEN-SCAN: first mask
// comments and the interiors of string/template literals (leaving `${...}`
// interpolation spans as CODE, since they can themselves construct a sink
// object), then scan the masked text as ONE buffer with a key pattern that
// admits both the colon form and ES6 shorthand construction, so `\s` can span
// a newline and a multi-line value is handled. The candidate's value span
// then runs from right after the key to the first depth-0 `,` or closing
// brace/bracket/paren, and literal-ness/neutralizer analysis reads the
// ORIGINAL (unmasked) text of that span.
//
// WHAT COUNTS AS A CANDIDATE, restated for the widened shape:
//   1. A SINK_KEYS ('reason', 'summary', 'message', 'block_reason',
//      'last_checks_summary') token that opens an object-literal property --
//      preceded by `{` or `,` (skipping whitespace/newlines), and followed by
//      either `:` (colon form) or, with no colon, a following `,`/`}`
//      (ES6 shorthand: `{ reason }` is `{ reason: reason }`).
//   2. Whose value expression is NOT a pure literal (a bare string/
//      template-with-no-interpolation/number/boolean/null) -- a shorthand
//      candidate's "value" is the key name itself, a bare identifier
//      reference, so it can NEVER be a pure literal and can never itself
//      contain a neutralizer call (there is no call syntax in `{ reason }`);
//      it is a candidate every time, exactly like a colon-form `{ reason:
//      someIdentifier }`.
// A candidate is ACCEPTED (not flagged) when EITHER:
//   (a) its value expression calls one of this codebase's established
//       neutralizers (boundedGateSummary, boundedSerialize,
//       renderTestRemediationEntry, renderPlanArtifactEntry, boundedTail,
//       flattenReviewText, boundReviewFinding, trimProse), or
//   (b) it carries an explicit `prose-bound-exempt: <reason>` marker, on the
//       trailing comment of the line its value span ends on, or on a
//       comment line immediately above its key -- checked at BOTH anchors,
//       independently, so a marker placed exactly where this rule says (on a
//       comment line immediately above the key) is honored even when the
//       value itself spans several physical lines below it -- with a
//       NON-EMPTY reason.
// Anything else is FLAGGED.
//
// DESTRUCTURING, NOT SILENTLY SKIPPED. `const { pid, launched, reason } =
// await launchGateRunner(...)` is TEXTUALLY IDENTICAL to shorthand
// object-literal construction -- this scan cannot and does not try to tell
// them apart. A destructuring binding therefore FLAGS exactly like a real
// shorthand sink and must be closed the same way, with a
// `prose-bound-exempt: <reason>` marker naming it as a binding, not a sink.
// No silent "this looks like destructuring, skip it" heuristic is added: one
// would make a REAL shorthand sink sharing its shape invisible.
//
// NO SILENT NARROWING, restated (the prior version's own list here made a
// false claim -- "this codebase's dominant style is one key per line" --
// that scheduler.js and gates.js falsify, and is dropped). This scan is
// still a SYNTACTIC match on the tracked source text; it does NOT and CANNOT
// see:
//   - a quoted or computed key (`'reason': x`, `obj['reason'] = x`,
//     `obj[dynamicKey] = x`);
//   - a value assembled by POST-HOC mutation after its property is built
//     (`entry.reason += extra`);
//   - dataflow through an intermediate variable with no sink-key name of its
//     own, several lines or functions away from where it is finally written;
//   - the SINK_KEYS list itself is a HAND-PICKED set of field names, not a
//     computed one, so it can never see a field this list has never named.
//     `abort_reason: event.reason` (scheduler.js's ABORT case) was exactly
//     such a site -- CORRECTED CLAIM (this run re-verified it against merged
//     main rather than trusting the prior round's framing): the raw operator
//     string reached active.json and the persisted per-run record
//     (`.ape/runtime/runs/<run_id>.json`), NOT the hash-chained immutable
//     history record archiveRun/immutableRunRecord writes under
//     `.ape/runtime/history/` (history.js never reads state.abort_reason at
//     all). It is now bound with boundedGateSummary at the ABORT dispatch
//     path (service.js's abortRun), independently verified behaviorally by
//     the ABORT arm in runtime-v2-override-reason-audit-bound.test.js --
//     CLOSED, even though this scan still cannot see it, because SINK_KEYS
//     still does not name `abort_reason` (widening SINK_KEYS remains
//     explicitly OUT OF SCOPE for this run, roadmap entry
//     sink-guard-coverage-and-detection-completeness);
//   - callsNeutralizer matches a neutralizer name ANYWHERE in the value
//     span, not only as the value's WHOLE expression -- `reason: cond ?
//     boundedGateSummary(a) : b` is accepted whole, with `b` left raw and
//     unbounded; this scan cannot tell a value fully routed through a
//     neutralizer from one only partly routed through one;
//   - findExemption matches EXEMPT_MARKER against the UNMASKED source lines,
//     not the masked buffer that key/value candidates are found in, so a
//     `prose-bound-exempt:`-shaped substring sitting inside a STRING LITERAL
//     (not a real comment) reads as a marker and exempts a real sink; only
//     the candidate scan itself is mask-protected, the exemption lookup is
//     not;
//   - a `prose-bound-exempt: <reason>` marker is accepted identically
//     whether it records that a site is actually safe (already neutralized
//     upstream, or a fixed constant) or that it is a KNOWN,
//     disclosed-not-fixed residual (this codebase has markers of that
//     second kind too); a green emptiness assertion therefore means "every
//     visible candidate is neutralized or marked," never "every marked
//     site is itself bounded".
// A scan with these gaps is still strictly more than the zero-recomputation,
// hand-maintained line list every predecessor round in this task used, and
// its gaps are named here rather than left for a future round to
// rediscover.
//
// FILE SCOPE. This scan covers exactly CLAIMED_SOURCE_FILES (service.js,
// scheduler.js, gates.js, pipeline.js) -- the four files this run's claim set
// (and the two runs before it) actually claims. It is NOT a lib/runtime-wide
// claim; the emptiness assertion's own failure message says so explicitly and
// names how many other tracked lib/runtime/*.js files were never scanned, so
// a reader can never mistake "flags nothing in these four files" for "no
// unbounded sink exists anywhere in lib/runtime". An unscoped scan surfaces
// ~40 further dynamic sites in hooks.js, claude-dispatch.js, history.js and
// projection.js -- not claimed here.
//
// AUTHORING HAZARD (run objective, stated three times over this task): this
// file's OWN text must never carry a literal control/bidi/format code point.
// It needs none -- every fixture below is built from ordinary printable ASCII
// source-code syntax, including the one fixture whose whole POINT is a
// regex literal containing an apostrophe (still just an ordinary `'` byte,
// not a control/bidi one) -- so nothing here uses
// String.fromCharCode/fromCodePoint because nothing here needs to.

const REPO_ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

const SINK_KEYS = ['reason', 'summary', 'message', 'block_reason', 'last_checks_summary'];

// Lookbehind anchors the key to an object-literal position (right after `{`
// or `,`, whitespace/newlines skipped by the `\s*` that follows -- scanning
// the MASKED text as one buffer, not line by line, is exactly what lets this
// `\s*` span a newline). The trailing alternation admits both forms: a
// literal `:` (colon form, consumed) or a zero-width lookahead onto `,`/`}`
// with no colon at all (ES6 shorthand, left unconsumed).
const SINK_KEY_PATTERN = new RegExp(
  `(?<=[{,])\\s*(${SINK_KEYS.join('|')})\\s*(?::|(?=\\s*[,}]))`,
  'g',
);

const NEUTRALIZER_NAMES = [
  'boundedGateSummary',
  'boundedSerialize',
  'renderTestRemediationEntry',
  'renderPlanArtifactEntry',
  'boundedTail',
  'flattenReviewText',
  'boundReviewFinding',
  'trimProse',
];

const EXEMPT_MARKER = /prose-bound-exempt:\s*(.*)$/;

function isPureLiteralValue(text) {
  const value = text.trim();
  if (/^(null|true|false|-?\d+(\.\d+)?)$/.test(value)) return true;
  // A single/double-quoted string with no unescaped quote of its own kind
  // inside it, and nothing else in the value.
  if (/^(['"])(?:(?!\1)[^\\]|\\.)*\1$/.test(value)) return true;
  // A template literal with no `${` interpolation anywhere in it.
  if (/^`(?:[^`\\$]|\\.|\$(?!\{))*`$/.test(value)) return true;
  return false;
}

function callsNeutralizer(text) {
  return NEUTRALIZER_NAMES.some((name) => new RegExp(`\\b${name}\\s*\\(`).test(text));
}

// Defensive carry-over from the prior detector: a same-line trailing
// `// ...` comment on a value with no terminating comma (the value span
// still stops at the enclosing `}`/`)`/`]`, which sits AFTER the comment) is
// stripped before literal/neutralizer analysis so it can never be mistaken
// for part of the expression.
function stripTrailingComment(value) {
  const at = value.indexOf(' // ');
  return at === -1 ? value : value.slice(0, at);
}

// Looks for a `prose-bound-exempt:` marker on the given (own) line or on a
// `//`/`*`-prefixed comment line immediately above it, walking upward while
// the lines stay comments, bounded so an unrelated comment block far above
// can never be mistaken for this site's justification. Returns the marker's
// reason text (possibly '', which the caller must treat as MALFORMED, not
// exempt) or undefined when no marker is present at all. The caller invokes
// this at up to two independent anchor lines -- the value-end line, and,
// only when it differs, the key's own line -- so a marker placed immediately
// above the key (per the accept rule above) is reachable even when the value
// itself spans several physical lines below the key.
function findExemption(lines, index) {
  const own = lines[index]?.match(EXEMPT_MARKER);
  if (own) return own[1].trim();
  for (let cursor = index - 1; cursor >= 0 && cursor >= index - 8; cursor -= 1) {
    const line = lines[cursor].trim();
    if (line === '') continue;
    if (!line.startsWith('//') && !line.startsWith('*') && !line.startsWith('/*')) break;
    const match = line.match(EXEMPT_MARKER);
    if (match) return match[1].trim();
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// MASKER. Walks the source once, character by character, replacing the
// interior of every comment and every string/template literal with spaces
// (newlines are preserved so line numbers never shift), so a sink-key-shaped
// substring inside a comment or a string can never be mistaken for a real
// object-literal property. `${...}` interpolation inside a template is left
// as live CODE (its own nested strings/comments/templates/regexes are masked
// recursively via the same state machine), since an interpolation can itself
// construct a sink object.
//
// SELF-CHECK (this is the assertion, not a comment): a masker that mis-lexes
// a regex literal containing a quote falls into STRING mode at the wrong
// position and everything after it narrows SILENTLY -- the exact failure
// this guard's own charter (fail closed, never silently narrow) forbids in
// itself. maskAndAssert below refuses to let that pass quietly: it requires
// the walk to end back in CODE mode with no open string/comment/template and
// no un-closed `${...}` interpolation, and THROWS (a loud, visible failure)
// when it does not. The fixture 'does not derail on a regex literal
// containing an apostrophe' below pins exactly this.
const REGEX_PRECEDING_PUNCTUATION = /[({[,;:=&|!?+\-*%^~<>]/;
const REGEX_ALLOWED_KEYWORDS = new Set([
  'return', 'typeof', 'instanceof', 'in', 'of', 'new', 'delete', 'void',
  'throw', 'yield', 'case', 'do', 'else', 'await', 'default', 'extends',
]);

function maskSource(text) {
  const n = text.length;
  const out = text.split('');
  let mode = 'CODE';
  const interpolationStack = [];
  let regexAllowed = true;
  let wordBuffer = '';
  let i = 0;

  function maskChar(index) {
    if (out[index] !== '\n') out[index] = ' ';
  }

  while (i < n) {
    const c = text[i];
    if (mode === 'CODE') {
      if (c === '/' && text[i + 1] === '/') {
        maskChar(i);
        maskChar(i + 1);
        mode = 'LINE_COMMENT';
        i += 2;
        continue;
      }
      if (c === '/' && text[i + 1] === '*') {
        maskChar(i);
        maskChar(i + 1);
        mode = 'BLOCK_COMMENT';
        i += 2;
        continue;
      }
      if (c === "'" || c === '"') {
        maskChar(i);
        mode = c === "'" ? 'STRING_SINGLE' : 'STRING_DOUBLE';
        wordBuffer = '';
        i += 1;
        continue;
      }
      if (c === '`') {
        maskChar(i);
        mode = 'TEMPLATE';
        wordBuffer = '';
        i += 1;
        continue;
      }
      if (c === '/' && regexAllowed) {
        let j = i + 1;
        let inClass = false;
        let closed = false;
        while (j < n) {
          const cj = text[j];
          if (cj === '\\') { j += 2; continue; }
          if (cj === '\n') break;
          if (cj === '[') { inClass = true; j += 1; continue; }
          if (cj === ']') { inClass = false; j += 1; continue; }
          if (cj === '/' && !inClass) { j += 1; closed = true; break; }
          j += 1;
        }
        if (closed) {
          while (j < n && /[a-z]/i.test(text[j])) j += 1;
          for (let k = i; k < j; k += 1) maskChar(k);
          i = j;
          regexAllowed = false;
          wordBuffer = '';
          continue;
        }
        // Unterminated on this line: not actually a regex literal; fall
        // through and treat `/` as ordinary (division) punctuation below.
      }
      if (interpolationStack.length > 0) {
        const top = interpolationStack[interpolationStack.length - 1];
        if (c === '{') {
          top.depth += 1;
        } else if (c === '}') {
          top.depth -= 1;
          if (top.depth === 0) {
            interpolationStack.pop();
            mode = 'TEMPLATE';
            regexAllowed = false;
            wordBuffer = '';
            i += 1;
            continue;
          }
        }
      }
      if (/[A-Za-z0-9_$]/.test(c)) {
        wordBuffer += c;
        regexAllowed = false;
      } else {
        if (wordBuffer && REGEX_ALLOWED_KEYWORDS.has(wordBuffer)) regexAllowed = true;
        wordBuffer = '';
        if (!/\s/.test(c)) regexAllowed = REGEX_PRECEDING_PUNCTUATION.test(c);
      }
      i += 1;
      continue;
    }
    if (mode === 'LINE_COMMENT') {
      if (c === '\n') { mode = 'CODE'; regexAllowed = true; i += 1; continue; }
      maskChar(i);
      i += 1;
      continue;
    }
    if (mode === 'BLOCK_COMMENT') {
      if (c === '*' && text[i + 1] === '/') {
        maskChar(i);
        maskChar(i + 1);
        mode = 'CODE';
        i += 2;
        continue;
      }
      maskChar(i);
      i += 1;
      continue;
    }
    if (mode === 'STRING_SINGLE' || mode === 'STRING_DOUBLE') {
      const quote = mode === 'STRING_SINGLE' ? "'" : '"';
      if (c === '\\') { maskChar(i); maskChar(i + 1); i += 2; continue; }
      if (c === '\n') { mode = 'CODE'; regexAllowed = false; continue; } // defensive: real JS never does this
      if (c === quote) { maskChar(i); mode = 'CODE'; regexAllowed = false; i += 1; continue; }
      maskChar(i);
      i += 1;
      continue;
    }
    if (mode === 'TEMPLATE') {
      if (c === '\\') { maskChar(i); maskChar(i + 1); i += 2; continue; }
      if (c === '`') { maskChar(i); mode = 'CODE'; regexAllowed = false; i += 1; continue; }
      if (c === '$' && text[i + 1] === '{') {
        maskChar(i); // mask the '$'; the '{' is left as real, unmasked code
        interpolationStack.push({ depth: 1 });
        mode = 'CODE';
        regexAllowed = true;
        wordBuffer = '';
        i += 2;
        continue;
      }
      maskChar(i);
      i += 1;
      continue;
    }
    i += 1;
  }
  return { masked: out.join(''), finalMode: mode, openInterpolations: interpolationStack.length };
}

function maskAndAssert(file, text) {
  const { masked, finalMode, openInterpolations } = maskSource(text);
  if (finalMode !== 'CODE' || openInterpolations !== 0) {
    throw new Error(
      `masker did not terminate cleanly for ${file}: ended in ${finalMode} with ` +
        `${openInterpolations} open template interpolation(s) -- a derailed mask ` +
        'narrows this scan silently, exactly what this guard must never do',
    );
  }
  return masked;
}

// Runs from just past the key (immediately after the colon, or immediately
// after a shorthand key with no colon) to the first depth-0 `,` or the
// closing bracket that must belong to the ENCLOSING structure (a closing
// bracket seen at depth 0 cannot be this value's own -- it was never opened
// within the span). Scans the MASKED text so a bracket inside a nested
// string/comment/regex can never desync the count.
function valueSpanEnd(masked, start) {
  let depth = 0;
  let i = start;
  while (i < masked.length) {
    const c = masked[i];
    if (c === '{' || c === '[' || c === '(') {
      depth += 1;
    } else if (c === '}' || c === ']' || c === ')') {
      if (depth === 0) return i;
      depth -= 1;
    } else if (c === ',' && depth === 0) {
      return i;
    }
    i += 1;
  }
  return masked.length;
}

function buildLineIndex(text) {
  const starts = [0];
  for (let i = 0; i < text.length; i += 1) {
    if (text[i] === '\n') starts.push(i + 1);
  }
  return starts;
}

function lineForIndex(starts, index) {
  let lo = 0;
  let hi = starts.length - 1;
  let answer = 0;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (starts[mid] <= index) {
      answer = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return answer;
}

/**
 * Optional third argument (roadmap entry
 * sink-guard-coverage-and-detection-completeness, ITEM 5): when the caller
 * passes an array, every ACCEPTED candidate (a real SINK_KEYS structural
 * match that is NOT a pure literal, and IS either neutralized or carries a
 * well-formed prose-bound-exempt marker) is appended to it. Purely additive
 * and opt-in -- every existing call site (every fixture test below, and
 * every caller that passes no third argument) observes the identical return
 * value it always has, so this cannot change what any pinned fixture
 * asserts.
 *
 * @returns {{ file: string, line: number, key: string, value: string, defect: string }[]}
 */
function collectCandidates(file, text, acceptedOut) {
  const masked = maskAndAssert(file, text);
  const lines = text.split('\n');
  const lineStarts = buildLineIndex(text);
  const flagged = [];
  SINK_KEY_PATTERN.lastIndex = 0;
  let match;
  // eslint-disable-next-line no-cond-assign
  while ((match = SINK_KEY_PATTERN.exec(masked)) !== null) {
    const key = match[1];
    const keyStart = masked.indexOf(key, match.index);
    const isColonForm = match[0].endsWith(':');
    let rawValue;
    let valueEndIndex;
    if (isColonForm) {
      const valueStart = match.index + match[0].length;
      valueEndIndex = valueSpanEnd(masked, valueStart);
      rawValue = stripTrailingComment(text.slice(valueStart, valueEndIndex)).trim();
    } else {
      // ES6 shorthand: `{ reason }` is `{ reason: reason }` -- the value IS
      // the key's own identifier text, which can never be a pure literal and
      // can never itself carry a neutralizer call.
      valueEndIndex = keyStart + key.length;
      rawValue = key;
    }
    const keyLine = lineForIndex(lineStarts, keyStart);
    const valueEndLine = lineForIndex(lineStarts, Math.max(valueEndIndex - 1, keyStart));
    if (isPureLiteralValue(rawValue)) continue;
    if (callsNeutralizer(rawValue)) {
      acceptedOut?.push({ file, line: keyLine + 1, key, value: rawValue, accepted_via: 'neutralizer' });
      continue;
    }
    // Two independent anchors, per the accept rule above: the value-end
    // line (own trailing comment, or walking upward from it), and, only
    // when it differs from the value-end line (a value spanning more than
    // one physical line), the key's own line. Anchoring ONLY at
    // valueEndLine would make a marker placed exactly where the accept
    // rule promises -- immediately above the key -- unreachable whenever
    // the value is multi-line, since the walk upward from valueEndLine
    // hits the value's own (non-comment) lines first and stops there.
    const exemption =
      findExemption(lines, valueEndLine) ??
      (keyLine !== valueEndLine ? findExemption(lines, keyLine) : undefined);
    if (exemption !== undefined) {
      if (exemption !== '') {
        acceptedOut?.push({ file, line: keyLine + 1, key, value: rawValue, accepted_via: 'marker' });
        continue;
      }
      flagged.push({
        file,
        line: keyLine + 1,
        key,
        value: rawValue,
        defect: 'malformed prose-bound-exempt marker: empty reason',
      });
      continue;
    }
    flagged.push({
      file,
      line: keyLine + 1,
      key,
      value: rawValue,
      defect: 'no recognized neutralizer call and no prose-bound-exempt marker',
    });
  }
  return flagged;
}

// SCOPED to this run's own claim set (see FILE SCOPE above). Still computed
// via `git ls-files`, so a rename or a file this list omits is a visible,
// re-checked assertion below rather than a silent drift.
const CLAIMED_SOURCE_FILES = [
  'lib/runtime/service.js',
  'lib/runtime/scheduler.js',
  'lib/runtime/pipeline.js',
  'lib/runtime/gates.js',
];

function trackedRuntimeJsFiles() {
  const listing = execFileSync('git', ['ls-files', 'lib/runtime'], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
  });
  return listing.split('\n').filter((entry) => entry.endsWith('.js'));
}

function trackedRuntimeSourceFiles() {
  const tracked = new Set(trackedRuntimeJsFiles());
  return CLAIMED_SOURCE_FILES.filter((file) => tracked.has(file));
}

function scanTree() {
  const files = trackedRuntimeSourceFiles();
  const flagged = [];
  const accepted = [];
  for (const file of files) {
    const text = readFileSync(path.join(REPO_ROOT, file), 'utf8');
    flagged.push(...collectCandidates(file, text, accepted));
  }
  return { files, flagged, accepted };
}

function describeFlagged(flagged) {
  return flagged
    .map((entry) => `${entry.file}:${entry.line} [${entry.key}] ${entry.value} — ${entry.defect}`)
    .join('\n');
}

// FILE SCOPE preamble (see above): the emptiness assertion's own failure
// message must never read as a lib/runtime-wide claim.
function scopePreamble(files) {
  const total = trackedRuntimeJsFiles().length;
  const unscanned = Math.max(total - files.length, 0);
  return (
    `Scanned ${files.length} claimed lib/runtime file(s) (${files.join(', ')}) -- ` +
    `this is NOT a lib/runtime-wide claim: ${unscanned} other tracked lib/runtime/*.js ` +
    'file(s) were not scanned by this guard.'
  );
}

describe('unbounded-sink guard: scanner mechanics (synthetic fixtures, never the real tree)', () => {
  // These pin the ALGORITHM itself against hand-built fixtures, independent
  // of whatever the live tree currently contains, so a future change to the
  // real source can never accidentally turn this suite's own logic
  // unfalsifiable (the satisfiability self-check prompts/test_writer.md
  // requires of every arm: each of these is a plain accept/reject fact about
  // the scanner, never two contradictory outcomes of the same input).

  it('does not flag a pure string literal sink value (colon form)', () => {
    const fixture = "function f() {\n  return {\n    reason: 'run is running',\n  };\n}\n";
    expect(collectCandidates('fixture.js', fixture)).toEqual([]);
  });

  it('does not flag a value routed through a recognized neutralizer (colon form)', () => {
    const fixture = 'const x = {\n  summary: boundedGateSummary(poll.pending.summary),\n};\n';
    expect(collectCandidates('fixture.js', fixture)).toEqual([]);
  });

  it('flags a bare identifier reference on a sink key with no neutralizer and no marker (colon form)', () => {
    const fixture = 'await appendJsonLine(log, {\n  reason: action.reason,\n});\n';
    const flagged = collectCandidates('fixture.js', fixture);
    expect(flagged).toHaveLength(1);
    expect(flagged[0]).toMatchObject({ key: 'reason', value: 'action.reason' });
  });

  it('accepts a candidate carrying a well-formed prose-bound-exempt marker on the line above', () => {
    const fixture =
      'const x = {\n' +
      '  // prose-bound-exempt: AUTO_MERGE_HOLD_REASON is a fixed runtime constant\n' +
      '  reason: AUTO_MERGE_HOLD_REASON,\n' +
      '};\n';
    expect(collectCandidates('fixture.js', fixture)).toEqual([]);
  });

  it('accepts a candidate carrying a well-formed prose-bound-exempt marker as a trailing comment', () => {
    const fixture =
      'const x = {\n' +
      '  reason: AUTO_MERGE_HOLD_REASON, // prose-bound-exempt: fixed runtime constant\n' +
      '};\n';
    expect(collectCandidates('fixture.js', fixture)).toEqual([]);
  });

  it('still flags a candidate whose marker is present but carries no reason (malformed, not exempt)', () => {
    const fixture =
      'const x = {\n' +
      '  // prose-bound-exempt:\n' +
      '  reason: action.reason,\n' +
      '};\n';
    const flagged = collectCandidates('fixture.js', fixture);
    expect(flagged).toHaveLength(1);
    expect(flagged[0].defect).toMatch(/malformed/);
  });

  it('does not let an unrelated comment several lines above stand in as a marker', () => {
    const fixture =
      '// prose-bound-exempt: this justifies something else entirely\n' +
      '\n' +
      'function unrelated() {}\n' +
      '\n' +
      'const x = {\n' +
      '  reason: action.reason,\n' +
      '};\n';
    const flagged = collectCandidates('fixture.js', fixture);
    expect(flagged).toHaveLength(1);
  });

  it('does not flag a ticket_id- or stage-shaped sink field carrying no colon-value candidate keys', () => {
    const fixture = 'const x = {\n  ticket_id: ticket.ticket_id,\n  stage: ticket.stage_id,\n};\n';
    expect(collectCandidates('fixture.js', fixture)).toEqual([]);
  });

  // --- widened shapes, the whole point of this run -------------------------

  it('flags a sink key inside an INLINE object literal sharing a line with another property', () => {
    // The dominant shape in scheduler.js/gates.js the start-anchored
    // predecessor detector could never see: `reason` is not the first token
    // of its trimmed line.
    const fixture = "audit_override({ operation: 'ship', reason: event.reason });\n";
    const flagged = collectCandidates('fixture.js', fixture);
    expect(flagged).toHaveLength(1);
    expect(flagged[0]).toMatchObject({ key: 'reason', value: 'event.reason' });
  });

  it('accepts an inline object literal candidate carrying a trailing marker on the same line', () => {
    const fixture =
      "audit_override({ operation: 'ship', reason: AUTO_MERGE_HOLD_REASON }); // prose-bound-exempt: fixed runtime constant\n";
    expect(collectCandidates('fixture.js', fixture)).toEqual([]);
  });

  it('flags an ES6 SHORTHAND construction with no neutralizer and no marker', () => {
    const fixture = 'function f(reason) {\n  return { reason };\n}\n';
    const flagged = collectCandidates('fixture.js', fixture);
    expect(flagged).toHaveLength(1);
    expect(flagged[0]).toMatchObject({ key: 'reason', value: 'reason' });
  });

  it('accepts an ES6 shorthand construction carrying a well-formed marker', () => {
    const fixture =
      'function f(reason) {\n' +
      '  // prose-bound-exempt: reason here is a fixed literal alias, never agent text\n' +
      '  return { reason };\n' +
      '}\n';
    expect(collectCandidates('fixture.js', fixture)).toEqual([]);
  });

  it('flags a DESTRUCTURING binding sharing shorthand syntax, with no silent skip', () => {
    // Textually identical to shorthand construction (the run objective's own
    // point): a destructuring binding of a function's return value is
    // syntactically indistinguishable from `{ reason }` building an object,
    // so this scan does not and must not try to tell them apart.
    const fixture = 'const { pid, launched, reason } = await launchGateRunner(cmd, cwd);\n';
    const flagged = collectCandidates('fixture.js', fixture);
    expect(flagged).toHaveLength(1);
    expect(flagged[0]).toMatchObject({ key: 'reason', value: 'reason' });
  });

  it('accepts a destructuring binding once marked exempt (closed the same way as any other shorthand)', () => {
    const fixture =
      'const { pid, launched, reason } = await launchGateRunner(cmd, cwd); ' +
      '// prose-bound-exempt: destructuring binding of launchGateRunner\'s return, not a sink\n';
    expect(collectCandidates('fixture.js', fixture)).toEqual([]);
  });

  it('masking kills the false positive of a sink key spelled out inside a STRING LITERAL', () => {
    // Verified real shape (pipeline.js:244): an error-message string whose
    // own prose happens to read like an object literal.
    const fixture =
      "const errors = ['evidence.test_remediation must be an object: " +
      "{ test_paths: [..], reason: \"..\" }'];\n";
    expect(collectCandidates('fixture.js', fixture)).toEqual([]);
  });

  it('masking kills the false positive of a sink-shaped JSDoc @returns annotation', () => {
    // Verified real shape (pipeline.js:226, gates.js:1972): a JSDoc type
    // annotation reads exactly like an inline object literal to a scan that
    // does not mask comments.
    const fixture =
      '/**\n' +
      ' * @returns {{ errors: string[], test_paths: string[], reason: string|null }}\n' +
      ' */\n' +
      'function f() { return { errors: [], test_paths: [], reason: null }; }\n';
    // The JSDoc contributes nothing; the REAL object literal on the last line
    // carries only pure-literal values (`[]`, `[]`, `null`), so nothing here
    // is a candidate either.
    expect(collectCandidates('fixture.js', fixture)).toEqual([]);
  });

  it('masking kills the false positive of sink-key words spelled out as individual array string entries', () => {
    // Verified real shape (scheduler.js:191/195): quoted entries in an array
    // of field names, not object-literal properties.
    const fixture = "const KEYS = ['title', 'summary', 'headline', 'message', 'reason'];\n";
    expect(collectCandidates('fixture.js', fixture)).toEqual([]);
  });

  it('does not derail on a regex literal containing an apostrophe (masker self-check)', () => {
    // If the masker fails to recognize this `/` as opening a regex literal,
    // the apostrophe inside it is mistaken for the start of a single-quoted
    // string, and the masking of everything after it narrows SILENTLY. This
    // fixture is exactly the hazard the masker's own self-check exists to
    // catch: the regex literal itself contains an ordinary apostrophe byte
    // (never a control/bidi one), and a real, unexempted sink candidate
    // follows it on the next statement.
    const fixture =
      "const CANT_STOP = /can't stop/;\n" +
      'const x = {\n' +
      '  reason: action.reason,\n' +
      '};\n';
    expect(() => maskAndAssert('fixture.js', fixture)).not.toThrow();
    const flagged = collectCandidates('fixture.js', fixture);
    expect(flagged).toHaveLength(1);
    expect(flagged[0]).toMatchObject({ key: 'reason', value: 'action.reason' });
  });

  it('handles a value expression spanning multiple physical lines when it calls a neutralizer', () => {
    const fixture =
      'const x = {\n' +
      '  reason: boundedGateSummary(\n' +
      '    action.reason,\n' +
      '  ),\n' +
      '};\n';
    expect(collectCandidates('fixture.js', fixture)).toEqual([]);
  });

  it('flags a value expression spanning multiple physical lines when it is not neutralized', () => {
    const fixture =
      'const x = {\n' +
      '  reason: String(\n' +
      '    action.reason,\n' +
      '  ),\n' +
      '};\n';
    const flagged = collectCandidates('fixture.js', fixture);
    expect(flagged).toHaveLength(1);
    expect(flagged[0].key).toBe('reason');
  });

  it('honors a prose-bound-exempt marker on a comment line immediately above the key, even when the value spans multiple physical lines below it', () => {
    // The accept-rule/implementation mismatch this fixture pins: anchoring
    // findExemption ONLY at the value-end line makes its own upward walk hit
    // the value's own (non-comment) lines before it can ever reach a marker
    // placed immediately above the KEY -- exactly where the accept rule's
    // own words say it is honored. gates.js:112-115 places its marker there
    // for a multi-line value, so this shape is real, not hypothetical.
    const fixture =
      'const x = {\n' +
      '  // prose-bound-exempt: FIXED_DIAGNOSTIC is a fixed runtime constant\n' +
      '  reason: String(\n' +
      '    FIXED_DIAGNOSTIC,\n' +
      '  ),\n' +
      '};\n';
    expect(collectCandidates('fixture.js', fixture)).toEqual([]);
  });

  it('scans an interpolation inside a template literal as live code, not masked-out text', () => {
    // `${...}` is CODE per this masker's own design (an interpolation can
    // itself construct a sink object), so a sink key built inside one is
    // still a candidate.
    const fixture = 'const x = `prefix ${JSON.stringify({ reason: action.reason })} suffix`;\n';
    const flagged = collectCandidates('fixture.js', fixture);
    expect(flagged).toHaveLength(1);
    expect(flagged[0]).toMatchObject({ key: 'reason', value: 'action.reason' });
  });
});

describe('unbounded-sink guard: computed scan of the tracked runtime source', () => {
  it('finds every claimed tracked runtime source file to scan', () => {
    const { files } = scanTree();
    expect(files).toEqual(CLAIMED_SOURCE_FILES);
  });

  // RED (run objective): the two shorthand-shaped override-reset audit sinks
  // (service.js's quarantineCorruptState and its orphaned-lock reset arm) and
  // the sibling audit_override sink's raw `reason: action.reason` are exactly
  // the class this widened scan can see and the predecessor detector could
  // not. Their fix is pinned behaviorally, independently, at
  // runtime-v2-override-reason-audit-bound.test.js; this arm is expected --
  // required -- to fail here too, on the SAME unfixed tree, until those sinks
  // are closed with a neutralizer call or an explicit, reasoned
  // prose-bound-exempt marker.
  it('flags no unneutralized, unexempted agent-facing sink site in the claimed, covered file set', () => {
    const { files, flagged } = scanTree();
    const message = `${scopePreamble(files)}\n${describeFlagged(flagged)}`;
    expect(flagged, message).toEqual([]);
  });

  // Roadmap entry sink-guard-coverage-and-detection-completeness, ITEM 5: the
  // emptiness assertion above can go green VACUOUSLY -- a future edit that
  // makes SINK_KEY_PATTERN or maskSource match nothing, while still
  // terminating cleanly, leaves `flagged` empty over ZERO examined sites, the
  // exact silent narrowing this file's own charter (fail closed, never
  // silently narrow) forbids in itself. A sibling arm above already closes
  // FILE-level vacuity (`files` must equal CLAIMED_SOURCE_FILES) and
  // maskAndAssert's own self-check closes masker-derailment vacuity; this
  // closes the remaining SCAN-level gap with a floor on ACCEPTED
  // (neutralized-or-marked) candidates, never on FLAGGED -- a floor on
  // FLAGGED is the inverting shape the red-phase-arms lesson forbids (it
  // would go RED the moment a real defect is closed, exactly backwards) and
  // it terminally blocked an earlier round of this task. A floor on ACCEPTED
  // has no such inversion: closing a flagged site adds a neutralizer call or
  // a marker, which is counted as ACCEPTED either way, so ACCEPTED only ever
  // grows (or holds steady) as defects close. The floor itself is a generous
  // margin under the live count (81 at authoring time) -- comfortably above
  // zero, so the scan cannot go green by matching nothing, without being so
  // tight that ordinary refactoring inside the claimed files trips it.
  it('accepts at least a floor of neutralized-or-marked candidates in the claimed, covered file set (never zero, so the scan cannot go green by examining nothing)', () => {
    const { accepted } = scanTree();
    expect(accepted.length).toBeGreaterThanOrEqual(30);
  });

  // NOTE ON WHAT DELIBERATELY IS *NOT* ASSERTED HERE.
  //
  // A predecessor version of this file asserted BOTH that scanTree() found
  // the live tree empty AND that it named specific real sites by value --
  // over the SAME deterministic observation. No implementation can satisfy
  // both, and the contradiction terminally blocked a run at its build stage
  // (recorded in the history this file's own header cites). The rule this
  // file follows: assert the DETECTOR's behaviour against fixtures (above),
  // and assert only EMPTINESS against the live tree (here). Evidence that
  // the guard once named a specific real site belongs in the run receipts,
  // which are immutable, not in an assertion that must be deleted to go
  // green the moment that site is closed.
});
