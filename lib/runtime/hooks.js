import path from 'node:path';
import { createHash } from 'node:crypto';
import {
  accessSync,
  constants as fsConstants,
  readFileSync,
  readdirSync,
  realpathSync,
  statSync,
} from 'node:fs';
import { lstat, realpath } from 'node:fs/promises';
import { resolveGovernedRoot, runtimeHost, runtimePaths } from './paths.js';
import { SEALED_STATUSES } from './constants.js';
import { looksLikeTest, withinClaim, withinTestScope } from './path-scope.js';
import {
  classifyExternalTool,
  externalToolPolicy,
  resolveClaimedPluginRead,
} from './external-tools.js';

// Claim/test-path matching is the shared path-scope module so the write-time
// policy here and the receipt-time validator agree byte-for-byte on the same
// claim. Re-exported because bin/ape-hook.mjs and the behavioral tests reach
// these predicates through the hooks surface.
export { looksLikeTest, withinTestScope } from './path-scope.js';

const WRITE_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit', 'apply_patch']);
// Exported so bin/ape-hook.mjs (which narrows its pre-policy exemption to the
// main session) and the agent-surface tests assert against one host-neutral
// safe set.
export const SAFE_SUBAGENT_TOOLS = new Set([
  'Bash',
  'Glob',
  'Grep',
  'LS',
  'Read',
  'TodoWrite',
  'WebFetch',
  'WebSearch',
]);
// Compatibility export for callers written before Codex reached policy parity.
export const SAFE_CLAUDE_SUBAGENT_TOOLS = SAFE_SUBAGENT_TOOLS;
// The runtime's own control-plane MCP tools, matched bare or MCP-namespaced
// (mcp__<server>__ape_run etc.). Shared with bin/ape-hook.mjs so the main-
// session stage-guard exemption and the subagent one-owner deny key off one
// pattern (friction #13).
export const CONTROL_PLANE_TOOLS = /(?:^|__)ape_(run|config|history)$/;
const NON_TOOL_LIFECYCLE_EVENTS = new Set(['Stop', 'SubagentStop']);

// Claude exposes its native subagent launcher as `Agent`. Codex exposes the
// same lifecycle boundary as `spawn_agent`. Multi-Agent V2 flattens the
// namespace for hooks to `collaborationspawn_agent`; older hosts may preserve
// it as a dotted or double-underscore prefix. Keep the accepted set explicit:
// treating every tool whose name merely ends in `spawn_agent` as a launch
// would let an unrelated MCP tool consume a dispatch capability.
export function isAgentDispatchTool(toolName) {
  return [
    'Agent',
    'spawn_agent',
    'collaborationspawn_agent',
    'collaboration.spawn_agent',
    'collaboration__spawn_agent',
  ].includes(toolName);
}

// A lifecycle boundary event (Stop, SubagentStop) or any event that carries no
// tool name is not a tool call: there is no tool channel to police, so it must
// never be evaluated as one — denying it eats the agent's receipt-bearing final
// message (read-only subagents were blocked at every Stop). Tree integrity at
// these boundaries is enforced separately: bin/ape-hook.mjs runs the
// tree-reconciliation guard (evaluateTreePolicy) BEFORE this policy and still
// denies unattributed tree changes at SubagentStop.
function isToolChannelEvent(event) {
  return Boolean(event.tool_name) && !NON_TOOL_LIFECYCLE_EVENTS.has(event.event);
}
// Main-session shell gating is a BLOCKLIST (defense in depth), not a sandbox:
// it enumerates the write channels an orchestrator session naturally reaches
// — file verbs (including the touch/truncate/ln/install/patch family), the
// git working-tree mutators (apply, restore, checkout, switch, reset, stash,
// am, cherry-pick, revert, merge, rebase, pull, clean; audit finding 1.7),
// sed -i, redirects (spaced or not), inline interpreters, dd. A write verb
// the blocklist still does not enumerate is caught by the backstops: every
// main-session Bash POST event runs tree reconciliation while a run is
// writing (driftGuardApplies no longer keys solely off this pattern for the
// main session, so an unenumerated mutation surfaces as an unattributed tree
// change at its own post event instead of being laundered into a pending
// ticket), and receipt-time diff recomputation rejects any unclaimed write
// before it can ride into an accepted run. See docs/hooks.md. Pattern notes:
// over-blocking is the safe direction for a blocklist — `git stash list` and
// the quoted-`>` false positive (`grep 'a>b'`) are accepted denials, while
// the operator's read-only recovery verbs (git status|diff|log ...) stay
// deliberately outside the git-mutation arm. The no-space redirect arm
// excludes `->` (git log --format="%h -> %p") and `2>&1`-style fd dups. The
// interpreter arm anchors on a separator so `ssh -c cipher` never matches
// `sh -c`, and the git arm anchors both `git` and its verb so `git log
// --grep reset` never matches `git reset`.
const SHELL_WRITE = /(?:^|[\s;&|])(?:rm|mv|cp|tee|touch|truncate|ln|install|patch)\s|(?:^|[\s;&|])git\s+(?:apply|restore|checkout|switch|reset|stash|am|cherry-pick|revert|merge|rebase|pull|clean)\b|(?:^|[\s;&|])sed\s+[^\n]*-[a-z]*i|\s(?:>|>>)\s*\S+|(?:^|[^<>-])>{1,2}(?!&)|(?:^|[\s;&|])(?:node\s+(?:-e|--eval)|python3?\s+-c|perl\s+-e|ruby\s+-e|(?:ba|z)?sh\s+-c)|(?:^|[\s;&|])dd\s[^\n]*\bof=/i;
// Main-session /dev/null fail-safe. SHELL_WRITE is a fail-closed BLOCKLIST, so a
// pure read that merely routes an fd to the bit-bucket (`ls 2>/dev/null`) trips
// it and is denied — friction with no security value, since /dev/null cannot be
// written to. onlyDevNullRedirects reports whether the SOLE reason a command
// matched SHELL_WRITE is one or more redirects to EXACTLY /dev/null: strip every
// such redirect and re-test — if the residual no longer matches, the command has
// no other write channel and is safe to allow; if a real write co-occurs it
// survives the strip and stays denied. The trailing lookahead is the load-bearing
// security anchor: /dev/null must be the COMPLETE target (end-of-string,
// whitespace, `;`, `|`, `&`, or `)`), never followed by `/`, `.`, or a word char,
// so `>/dev/null/../etc/passwd`, `>/dev/nullish`, `>/dev/null.bak`, `>/dev/null2`
// are real writes left intact and denied. DEV_NULL_REDIRECT carries /g and is
// used ONLY via String.replace (never .test()/.exec(), which are lastIndex-
// stateful); SHELL_WRITE stays /i-only for the same reason — it is .test()'d
// twice in a row (the line-~475 guard, then here).
const DEV_NULL_REDIRECT = /(?:\d+|&)?>{1,2}\s*\/dev\/null(?=$|[\s;|&)])/g;
function onlyDevNullRedirects(command) {
  return SHELL_WRITE.test(command) && !SHELL_WRITE.test(command.replace(DEV_NULL_REDIRECT, ' '));
}
// Deletion channel. The sanctioned WRITE_TOOLS can only replace content, never
// remove a file, so a whole-file-deletion ticket is unsatisfiable without a
// shell channel. `rm` / `git rm` get their own aggressively fail-closed grammar:
// no chaining, no globs, no quoting, no substitution, no expansion — a single
// forbidden character rejects the whole command — and flags come from a fixed
// whitelist. Parsing yields only the target tokens; bin/ape-hook.mjs resolves
// each target against the ticket claims (same claims selection and realpath
// semantics as the host edit tool) and the role rules, and the policy consumes
// the precomputed event.deletion. A parsed deletion never falls through to the
// generic evidence-command channel.
// ---------------------------------------------------------------------------
// THE CHARACTER HAZARD CLASS, shared by BOTH gated shell channels — this one and
// the evidence allowlist below. It refuses a code point whose presence makes the
// STRING THIS FILE INSPECTS differ from the BYTES THE SHELL AND THE KERNEL
// RECEIVE. It is stated as CATEGORIES, never as an enumeration, and that is
// exactly why sharing THIS constant between the two channels is sound while
// sharing an ALPHABET is not (the DELETION TARGET ALPHABET note directly below
// says where the two alphabets must differ, and why): a category refusal only
// ever REFUSES MORE, and the argument for each category is about BYTES, which is
// identical in both threat models.
//   [^\S ]   any whitespace but U+0020. JS `/\s+/` (and `\b`) split on CR, VT,
//            FF, U+00A0, U+2028, U+2029 and U+FEFF while the shell's default IFS
//            does not, so the gate would tokenize DIFFERENTLY from the shell.
//   \p{Cc}   control characters. U+0000 truncates argv at execve, so the KERNEL
//            runs a shorter command than the one that was vetted.
//   \p{Cf}   invisible format characters (U+200B, U+00AD, U+202E). They cannot
//            forge a recognized head — head recognition is exact-token equality,
//            so a head carrying one is simply not the head — but they make
//            OPERANDS and DENY REASONS unauditable, and U+202E reverses the
//            rendered direction of everything after it.
//   \p{Cs}   a LONE SURROGATE. A JS string may hold one; encoding it as UTF-8
//            substitutes U+FFFD, so the bytes the shell receives are not the code
//            points this file inspected. DERIVED, NOT verified in vivo — the host
//            tool transport re-encodes, so no live probe can carry one through.
// NAMED FOR THE RANGE WHERE IT IS LOAD-BEARING. Below U+0080 both alphabets
// already refuse every character outside their own set, so this class only ever
// ADDS refusals at or above U+0080; it is applied to the whole string anyway
// because a category test is cheaper than a range-restricted one.
// TOTALITY: two single character classes under one alternation — no quantifier,
// so no backtracking, and no /g, so no lastIndex state (see DEV_NULL_REDIRECT).
const NON_ASCII_HAZARD = /[^\S ]|[\p{Cc}\p{Cf}\p{Cs}]/u;
// THE DELETION TARGET ALPHABET IS A POSITIVE ALLOWLIST. It replaces
// `DELETION_UNSAFE_CHARS`, which was a BLOCKLIST of shell metacharacters
// (`/[\n;|&<>`$(){}*?[\]~"'\\]/`) — converted in the SAME phase as the evidence
// gate's, because leaving one channel a blocklist and the other an allowlist
// while this file calls them "the same shape" is precisely the reuse trap round
// 5 fell into. A backslash is still refused, now by construction rather than by
// name: a backslash-escaped `\.\.` reads as literal path segments to
// normalizePath (which never equals `..`) yet the host shell de-escapes it back
// to `..` and deletes outside the claims.
//
// THE TWO ALPHABETS SHARE A SHAPE, NOT A THREAT MODEL, and they DIFFER ON
// PURPOSE. This one is the evidence alphabet MINUS the three characters that
// carry a zsh WORD-LEVEL EXPANSION — `~`, `=`, `^` — refused WHOLESALE here
// rather than by POSITION as the evidence gate refuses them, because every `rm`
// operand is a path and the effect is unrecoverable:
//   `~`  tilde expansion. Never the harmless `git log HEAD~3` it is over there.
//        Refused wholesale by the blocklist too; unchanged.
//   `=`  zsh EQUALS expansion replaces a word BEGINNING with `=` by the full path
//        of the command it names. The blocklist omitted it, so `rm =node` parsed
//        to the target `=node`, bin/ape-hook.mjs resolved `<sessionCwd>/=node` —
//        LEXICALLY INSIDE the project — and admission turned only on
//        pathResolvesWithinClaims, which PASSES whenever the session cwd sits in
//        a claimed subdirectory, while the shell deletes the absolute path of
//        whatever `node` names. The round-5 note that this constant's shared `#`
//        omission was safe here "because admission is MONOTONE under truncation"
//        DOES NOT EXTEND TO IT: EQUALS is a SUBSTITUTION, not a truncation — it
//        does not drop a target, it REPLACES a contained relative one with an
//        absolute out-of-project one, which is the opposite direction.
//   `^`  the EXTENDED_GLOB exclusion operator. `rm ^a.js` under `setopt
//        extended_glob` expands to every file in the directory EXCEPT `a.js` —
//        an unrecoverable multi-file delete from a token vector the gate read as
//        one target. The option is unset in the observed session but is common in
//        shipped profiles, and the host sources the operator profile.
// NAMED OVER-BLOCK COST, so the refusal is a decision rather than an accident: a
// filename containing `#`, `!`, `~`, `=`, `^`, a TAB, a U+00A0, a control or an
// invisible format character cannot be deleted through this channel at all. The
// blocklist already refused a quote, a backslash and `*?[]~;|&<>$(){}`, and a
// name carrying a space was never expressible here (the split makes it two
// targets). `%`, `,` and `+` REMAIN deletable — they carry no shell meaning in
// either shell and sit in both alphabets, and the derivation this phase
// inherited listed them as costs in error.
// DO NOT RE-SYNC THE TWO ALPHABETS. They must differ on `~`, `=` and `^`.
const DELETION_TOKEN_CHAR_REFUSED = /[^ A-Za-z0-9\-_.\/:@,%+\u{80}-\u{10FFFF}]/u;
const RM_FLAGS = new Set(['-f', '-r', '-rf', '-fr']);
const GIT_RM_FLAGS = new Set(['-f', '--force', '-q', '--quiet', '--cached', '-r']);

export function parseDeletionCommand(command) {
  if (typeof command !== 'string') return null;
  if (DELETION_TOKEN_CHAR_REFUSED.test(command) || NON_ASCII_HAZARD.test(command)) return null;
  const tokens = command.trim().split(/\s+/).filter(Boolean);
  let flags;
  // Narrow a copy, not tokens[0]: shift/splice do not reset tsc's element
  // narrowing, so comparing tokens[0] against '--' below would be flagged as
  // an impossible '"rm" | "git"' comparison.
  const head = tokens[0];
  if (head === 'rm') {
    flags = RM_FLAGS;
    tokens.shift();
  } else if (head === 'git' && tokens[1] === 'rm') {
    flags = GIT_RM_FLAGS;
    tokens.splice(0, 2);
  } else {
    return null;
  }
  while (tokens.length > 0 && tokens[0] !== '--' && flags.has(tokens[0])) tokens.shift();
  if (tokens[0] === '--') tokens.shift();
  if (tokens.length === 0 || tokens.some((token) => token.startsWith('-'))) return null;
  return { targets: tokens };
}
// ---------------------------------------------------------------------------
// WRITE-CONTENT BYTE GATE (roadmap entry authored-and-agent-facing-byte-
// integrity, WRITE side). Every gate above this point inspects a write-tool
// call's TARGET PATH (event.file / event.path_safe) or a Bash COMMAND string
// (event.command, event.deletion) — never the CONTENT a Write/Edit/MultiEdit/
// NotebookEdit call carries — so a decoded control, DEL/C1, or bidi/format
// code point in that content reached tracked source untouched by a gate that
// believes it is inspecting a safe operation.
//
// ROUTE TABLE, enumerated rather than an ad hoc per-tool if-chain — the same
// self-policing idiom EVIDENCE_COMMAND_HEADS below states: each entry names
// the tool and reads every content-bearing string out of THAT tool's own
// tool_input shape, so a tool added here with no route is a one-line miss
// rather than a buried branch. Every WRITE_TOOLS member (above) has an entry
// below EXCEPT Bash heredoc content, which is not a WRITE_TOOLS member at all
// but a SIXTH content-bearing channel the run objective names beside the five
// tool routes: this gate structurally cannot see it, because
// normalizeLifecycleEvent (below) extracts only `tool_input.command` for a
// Bash event, never a heredoc body piped in on stdin, and no JSON field of a
// PreToolUse Bash event carries one for this hook to read. Recorded here
// rather than silently unguarded.
// Exported (never merely a local constant) so the residual is PUBLISHED
// rather than only commented: a reader of this module's surface — or a future
// coverage arm built on the EVIDENCE_COMMAND_HEADS idiom — can see the one
// content-bearing route this gate structurally cannot reach without
// re-deriving it from prose.
export const WRITE_CONTENT_UNREACHABLE_ROUTE =
  "Bash heredoc content is not covered: bin/ape-hook.mjs's Bash channel reads only tool_input.command, never a heredoc body, so no JSON field of a PreToolUse Bash event carries it for this gate to inspect";
// Security review, non-blocking: a coverage arm that tests a WRITE_TOOLS
// member's membership in the residual above with String#includes is a
// SUBSTRING match against an English sentence — one that happens to contain
// the word "Bash" and would rubber-stamp a future WRITE_TOOLS member spelled
// literally as "Bash" as covered by the residual even though it names no such
// tool. Exported here as an exact, enumerable Set so a coverage arm can match
// membership instead: EMPTY today, because every current WRITE_TOOLS member
// (Edit, Write, MultiEdit, NotebookEdit, apply_patch) has its own
// WRITE_CONTENT_ROUTES entry — the prose above describes a channel outside
// WRITE_TOOLS entirely (Bash heredoc content), not a WRITE_TOOLS member left
// uncovered, so nothing belongs in this Set until that changes.
// Review, non-blocking: Object.freeze here seals the Set OBJECT's own
// properties (and the exported binding is a `const`), never its internal
// [[SetData]] — `.add()`/`.delete()` still succeed on a frozen Set, so this
// is discipline this module observes (nothing in this file ever calls `.add`
// on it; only `.has()` reads it), not a runtime-enforced immutability
// guarantee.
export const WRITE_CONTENT_UNREACHABLE_TOOLS = Object.freeze(new Set());
const WRITE_CONTENT_ROUTES = Object.freeze([
  Object.freeze({ tool: 'Write', extract: (input) => [input?.content] }),
  Object.freeze({ tool: 'Edit', extract: (input) => [input?.new_string] }),
  Object.freeze({
    tool: 'MultiEdit',
    extract: (input) => (Array.isArray(input?.edits) ? input.edits.map((edit) => edit?.new_string) : []),
  }),
  Object.freeze({ tool: 'NotebookEdit', extract: (input) => [input?.new_source] }),
  // apply_patch is a governed WRITE_TOOLS member and one of only three write
  // tools the shipped Codex host matcher (hooks/hooks.json) registers, so
  // leaving it out of this table (as a prior revision did) closes the gate
  // for a third of the registered write surface with no recorded reason —
  // unlike Bash heredoc content above, this channel really does carry its
  // payload in the PreToolUse event; the gap was an omission, not a
  // structural limit. Its tool_input SHAPE is DERIVED-NOT-VERIFIED, in the
  // same sense docs/hooks.md uses that label elsewhere: the vendor tool has
  // shipped at least two shapes (an older function-style call with a single
  // `input` string carrying the whole patch document, and a newer freeform
  // tool that some hosts surface as a shell-style `{command: ['apply_patch',
  // <patch text>]}`), and this project has not verified which one this
  // runtime's own host delivers. Rather than assert one schema, every
  // plausible content-bearing field is scanned — extracting more candidates
  // than the real shape needs only ADDS scanning coverage, it can never
  // narrow it, and an absent field simply yields `undefined`, which
  // firstWriteContentHazard (below) already treats as no hazard. A host that
  // delivers the patch body under some OTHER field name stays uncovered by
  // this route, same as any undiscovered field would.
  //
  // REACH, recorded rather than implied: this route is hardened, not a
  // closed bypass, and this extractor is NOT skipped for any shape below.
  // bin/ape-hook.mjs computes event.write_content_hazard for every
  // bound-ticket event whether or not an explicit path field is present —
  // content is orthogonal to path. normalizeLifecycleEvent accepts the legacy
  // `file_path`/`filePath`/`path` fields (including input.file_path), and for
  // Codex's native freeform shape it derives every target from the patch's
  // Add/Update/Delete/Move headers. Every derived target is then checked
  // against the ticket; only a malformed patch with no valid target header
  // retains the fail-closed missing-path verdict. The content verdict is still
  // consumed only after path, claim, role, and scope authorization succeeds.
  Object.freeze({
    tool: 'apply_patch',
    extract: (input) => {
      // A tool_input that is itself a string (one more DERIVED-NOT-VERIFIED
      // shape: a caller that hands the whole patch document as the
      // top-level value rather than nesting it under `input`/`patch`/
      // `command`) was scanned nowhere before this — `input?.input` and
      // `input?.patch` are both undefined on a string, so it fell through
      // silently. typeof input === 'string' catches it the same way the
      // `command` string arm below catches its own shape.
      const candidates = typeof input === 'string' ? [input] : [input?.input, input?.patch];
      // Security review, non-blocking: a THIRD shell-style shape carries
      // `command` as a bare STRING (`{command: 'apply_patch <patch text>'}`)
      // rather than the array form `{command: ['apply_patch', <patch
      // text>]}` the comment above already scans. Array.isArray is false for
      // a string, so that shape reached no candidate at all until now — one
      // more DERIVED-NOT-VERIFIED shape scanned defensively, same as the
      // other two, never a narrowing.
      // A caller-supplied `command` array is walked with a bounded for-of,
      // never spread into Array#push: bin/ape-hook.mjs admits up to
      // INPUT_CAP_BYTES (8 MB) of stdin, so a `command` array of roughly one
      // to two million short elements exceeds V8's spread-argument call
      // limit and throws a RangeError. The top-level catch in
      // bin/ape-hook.mjs still fails closed on that throw, so this was
      // robustness rather than an admitted bypass, but the deny reason it
      // produced misattributed the cause to the wrong check; a for-of has no
      // such argument-count limit.
      if (Array.isArray(input?.command)) {
        for (const item of input.command) candidates.push(item);
      } else if (typeof input?.command === 'string') {
        candidates.push(input.command);
      }
      return candidates;
    },
  }),
]);

// The hazard class this gate refuses STARTED as the identical code-point set
// service.js's SCOPE_EXPANSION_CONTROL_CHARS / pipeline.js's
// TEST_REMEDIATION_CONTROL_CHARS use (character policy 2 of the FIVE
// enumerated at service.js's own comment naming all five — deliberately NOT
// unified with policy 1, BOUNDED_SUMMARY_CONTROL_CHARS, which additionally
// neutralizes U+200C/U+200D; see that enumeration for why unifying them would
// reverse a recorded decision), and is still DUPLICATED rather than imported,
// for the same reason: hooks.js is imported BY service.js (service.js's own
// acyclicity note — it already imports this file, so the reverse edge would
// cycle) and by pipeline.js's own sibling copy's reasoning.
//
// SECURITY REVIEW, BOTH BLOCKING — WIDENED THIS COPY ONLY, ON PURPOSE. This
// gate alone governs bytes that become part of the SOURCE THIS RUNTIME
// EXECUTES; the other two copies bound OPERATOR-FACING TEXT (a bounded
// evidence summary), a materially different threat model, so a hand-picked
// Cf subset that misses a live bypass is a strictly worse trade here than
// there. Two findings, both against the class this gate already claimed to
// refuse:
//   - U+2028 LINE SEPARATOR / U+2029 PARAGRAPH SEPARATOR were admitted (their
//     own Unicode General_Category is Zl/Zp, not Cc/Cf/Cs, so the numeric
//     enumeration below jumped over them). Both are ECMAScript
//     LineTerminators: `// ordinary comment<U+2028>maliciousCall();` ends the
//     single-line comment and EXECUTES `maliciousCall()`, while `git diff`
//     and a terminal still render one visual comment line — exactly the
//     read-differs-from-executes class this gate exists to refuse.
//   - U+FEFF (invisible, and WhiteSpace in ECMAScript, so it can split an
//     identifier a reviewer reads as one token) and the whole astral TAGS
//     block (U+E0001, U+E0020-U+E007F — the canonical invisible-text
//     instruction-smuggling channel) were admitted: the enumeration below was
//     a hand-picked SUBSET of \p{Cf}, not the category itself, so it missed
//     both. This is the direct threat to this gate's own AGENT-FACING half —
//     a bound implementer could embed TAG-encoded instructions in a source
//     comment that a later agent reads as raw bytes while every human
//     reviewer and diff view sees nothing.
//
// SECURITY REVIEW, NON-BLOCKING, NOT CLOSED HERE. Both findings above are
// fixed, but the enumeration below is still an ENUMERATION, never \p{Cf} the
// category itself, and closing two hand-picked gaps does not close the class:
// it still ADMITS eleven further \p{Cf} ranges (U+0600-U+0605, U+06DD,
// U+070F, U+0890-U+0891, U+08E2, U+180E, U+110BD, U+110CD, U+13430-U+1343F,
// U+1BCA0-U+1BCA3, U+1D173-U+1D17A), \p{Cs} LONE SURROGATES (near-zero
// impact here: a lone surrogate arriving over JSON is re-encoded to U+FFFD
// by a UTF-8 write before it ever reaches tracked source, and
// NON_ASCII_HAZARD above already refuses \p{Cs} outright on both gated shell
// channels — a distinct threat model this gate does not share), and,
// outside \p{Cf} entirely, both variation-selector families (U+FE00-U+FE0F
// and U+E0100-U+E01EF, both \p{Mn}) — the OTHER documented invisible-byte
// smuggling channel, and one this comment's own threat model above already
// names in its own words. The remainder was NOT closed by this run: the
// tracked-source scanner's own isHazardCodePoint in
// __tests__/runtime-v2-authored-byte-integrity.test.js is an AUTHORED TEST
// path, and this gate is deliberately kept no wider than that scanner can
// backstop — an implementer may never write an authored test, so widening
// this production copy past what the scanner covers would ship a hazard
// class with no regression fixture watching it. Recorded as a residual (see
// docs/hooks.md's own record of it) rather than silently implied closed by
// this comment's own past framing.
// This set is therefore now WIDER than policy 2's pair; keep it that way
// rather than re-syncing it back down to their narrower set — it is recorded
// as its own policy (policy 5 at service.js's enumeration), not a third copy
// of policy 2 to be kept in lockstep with it. Built from NUMERIC code
// points via String.fromCodePoint (String.fromCharCode cannot represent the
// astral TAGS members correctly — see the 'u' flag note below), never a
// literal byte or a `\u` escape in this file's own text, per the authoring
// hazard binding every file this gate touches.
function writeContentHazardPattern() {
  const codePoint = (value) => String.fromCodePoint(value);
  const range = (from, to) => (to > from ? `${codePoint(from)}-${codePoint(to)}` : codePoint(from));
  const parts = [
    range(0x0000, 0x0008),
    range(0x000e, 0x001f),
    range(0x007f, 0x009f),
    range(0x00ad, 0x00ad),
    range(0x061c, 0x061c),
    // U+200B-U+200F MINUS the U+200C/U+200D (ZWNJ/ZWJ) exemption — the SAME
    // one-sided exemption policy 2 makes, so a legitimately-named joining
    // sequence stays admitted here too.
    range(0x200b, 0x200b),
    range(0x200e, 0x200f),
    // U+2028/U+2029 (security review, BLOCKING) — see the class comment above.
    range(0x2028, 0x2029),
    range(0x202a, 0x202e),
    range(0x2060, 0x206f),
    // U+FEFF (security review, BLOCKING) — see the class comment above.
    range(0xfeff, 0xfeff),
    range(0xfff9, 0xfffb),
    // The astral TAGS block (security review, BLOCKING) — see the class
    // comment above. U+E0001 LANGUAGE TAG stands alone; U+E0020-U+E007F are
    // the TAG characters proper.
    range(0xe0001, 0xe0001),
    range(0xe0020, 0xe007f),
  ];
  return `[${parts.join('')}]`;
}
// 'u' flag, added by this same widening: required syntactically for a class
// member above U+FFFF (the TAGS block) to be treated as one code point rather
// than a lone UTF-16 surrogate half. It changes nothing below U+FFFF — every
// other member here was already a single BMP code unit either way.
const WRITE_CONTENT_HAZARD_CHARS = new RegExp(writeContentHazardPattern(), 'u');

// The first hazard code point in `text`, named as an uppercase 'U+XXXX'
// string (never the raw byte, and never fewer than 4 hex digits), or null.
// Iterates by CODE POINT (`for...of` over a string), not UTF-16 code unit, so
// a surrogate pair is never split — load-bearing for correctness of BOTH the
// scan AND the match now that the astral TAGS block is in the hazard set: a
// `for...of` element for one of those members is the full two-unit code
// point, and WRITE_CONTENT_HAZARD_CHARS's own 'u' flag (see above) is what
// lets `.test()` match it as one code point rather than one surrogate half.
// No `/g` flag on WRITE_CONTENT_HAZARD_CHARS: each `.test()` call here
// is independent and single-character, so there is no lastIndex state to
// drift (the same hazard DEV_NULL_REDIRECT's own comment names).
function firstWriteContentHazard(text) {
  if (typeof text !== 'string') return null;
  // FAST PATH (security review, non-blocking performance finding). Content
  // reaching this scan is bounded only by bin/ape-hook.mjs's INPUT_CAP_BYTES
  // (8 MB — its own comment records a package-lock.json edit carrying the
  // whole hunk inline) against the host's 30s PreToolUse hook timeout
  // (hooks/hooks.json), and the overwhelmingly common call carries no hazard
  // code point at all. One native whole-string `.test()` answers that common
  // case in a single pass; the per-code-point loop below then runs ONLY to
  // NAME the offending code point once the fast path has already proven one
  // exists. Safe to call `.test()` twice in a row: WRITE_CONTENT_HAZARD_CHARS
  // carries no `/g` flag (see above), so it has no `lastIndex` state for
  // this call and the loop's own per-character calls to desynchronize.
  if (!WRITE_CONTENT_HAZARD_CHARS.test(text)) return null;
  for (const ch of text) {
    if (WRITE_CONTENT_HAZARD_CHARS.test(ch)) {
      return `U+${ch.codePointAt(0).toString(16).toUpperCase().padStart(4, '0')}`;
    }
  }
  return null;
}

// Evaluates the write-content byte gate for one PreToolUse event's tool_input.
// Pure and synchronous (string scanning only, no I/O) — bin/ape-hook.mjs
// calls it as a precompute beside the existing deletion and evidence
// precomputes, and evaluateLifecyclePolicy (below) only READS the verdict it
// produces, keeping the policy itself synchronous. Returns `{ safe: true }`
// for a tool with no route (every tool but the five above) or content with no
// hazard code point, and `{ safe: false, reason }` — naming the DECODED code
// point, never the literal escape text — otherwise.
export function evaluateWriteContentPolicy(toolName, toolInput) {
  const route = WRITE_CONTENT_ROUTES.find((entry) => entry.tool === toolName);
  if (!route) return { safe: true };
  for (const text of route.extract(toolInput)) {
    const hazard = firstWriteContentHazard(text);
    if (hazard) {
      return {
        safe: false,
        reason: `${toolName} content decodes to a refused control, DEL/C1, line/paragraph separator, or bidi/format code point (${hazard}); authored and agent-facing source may not carry one`,
      };
    }
  }
  return { safe: true };
}
// Recognized non-mutating evidence commands a bound subagent may run to gather
// test/verify results. Deliberately narrow: inline interpreters (`node -e`,
// `python -c`), arbitrary binaries, and anything matching SHELL_WRITE still fail
// closed, so a subagent cannot mutate production through an unprovable shell
// channel — production edits must go through the path-checked host edit tool.
//
// Python environment managers (uv, poetry, pdm, hatch, rye, pipenv, pixi) run
// tests through a `run` wrapper — the canonical `uv run pytest`. Bare `pytest`
// is not on PATH in a managed venv, so without these a uv/poetry project could
// produce no red/targeted evidence at all. Their `run` form is admitted ONLY
// when the tail is itself a recognized test runner (pytest / python -m
// pytest|unittest); `<mgr> run python -c ...` and other arbitrary tails stay
// denied. `tox` and the `hatch test` / `rye test` subcommands are test drivers
// by definition.
//
// `env` is a process launcher, not a read-only inspection command, so only its
// BARE form (no operands) is recognized: the `env\s*$` arm sits INSIDE the
// anchored `^\s*(...)` group, so a program whose name merely ends in `env`
// (`printenv`, `make env`) is not admitted, and `env <operand>` (a command, a
// NAME=VALUE assignment, or a flag) denies like any unrecognized command.
//
// ===========================================================================
// READ THIS BEFORE YOU EDIT THE REGEX BELOW.
//
// This pattern is NO LONGER the admission boundary. It is a residual shape
// check that runs AFTER the tokenize-then-allowlist gate (parseEvidenceCommand
// + recognizeEvidenceHead + recognizeLintHead + evidence containment, all
// below). FOUR review rounds each found a DIFFERENT bypass of this one regex,
// because the bypasses are THREE LAYERS, not four instances of one class —
// which is exactly why three locally-correct patches each left the class open:
//
//   L1 SHELL TOKENIZATION. The host re-tokenizes and de-quotes before any
//      program sees argv, so one quote or backslash splits the token this
//      regex inspected: `yarn typecheck` DENIED but `yarn t"ypecheck"` ALLOWED
//      with identical argv; `yarn run test-pwn` DENIED but `yarn run
//      test"-pwn"` ALLOWED, because the greedy class stopped at the quote and
//      the gate membership-tested the PREFIX while the manager receives the
//      whole name.
//   L2 THIS REGEX'S OWN TOKEN BOUNDARY. `\b` and the `[\w:@./-]` separator
//      class are a BLOCKLIST of separators inside a pattern `.test()`ed with
//      no end anchor, so any character outside the class ends the match early:
//      `yarn test:e2e`, `pnpm test-ci`, `bun test.unit`, `yarn test+e2e`.
//   L3 THE PACKAGE MANAGER'S OWN PARSER. npm and pnpm parse with nopt, which
//      expands any unambiguous prefix of a known key and expands short-flag
//      clusters, so a refusal naming literal flag spellings is incomplete BY
//      CONSTRUCTION: `npm test --prefi /other/repo`, `yarn test -rC /tmp`.
//
// Rounds 1-4 (receipts 49b349d7, cb0109c4, 0caa5f91, 08a79879, c6fca60a) all
// asserted a NEGATIVE over an adversarial space. The replacement asserts a
// POSITIVE over the actual command: refuse the whole command if it carries any
// character outside a safe set, split on whitespace, recognize the head by
// EXACT TOKEN EQUALITY, and refuse any OPERAND that names a path outside the
// governed project. Widening THIS regex therefore widens nothing on its own —
// and NARROWING the token gate to re-add a separator class or a flag-spelling
// blocklist reopens the class. Full record, with the four bypasses, the five
// receipts, the abandoned fourth patch and the deciding spike:
// docs/research/2026-07-28-evidence-command-shape-allowlist.md.
// ===========================================================================
const EVIDENCE_COMMAND =
  /^\s*(?:(?:npm|pnpm|yarn|bun)\s+(?:run\s+[\w:@./-]+|test|t)\b|(?:npx|pnpm|yarn|bun)\s+(?:vitest|jest|mocha|ava|playwright|tap|tsc)\b|(?:vitest|jest|mocha|ava|tap|pytest|tsc)\b|node\s+--(?:test|check|version)\b|python3?\s+-m\s+(?:pytest|unittest)\b|(?:uv|poetry|pdm|hatch|rye|pipenv|pixi)\s+run\s+(?:pytest|python3?\s+-m\s+(?:pytest|unittest))\b|(?:hatch|rye)\s+test\b|tox\b|(?:go|cargo)\s+test\b|git\s+(?:status|diff|log|show|rev-parse|branch|describe|ls-files)\b|(?:ls|pwd|cat|echo|true|which)\b|env\s*$)/;
// Human-readable rendering of the recognized evidence families above, kept
// beside the regexes so they evolve together. Published in every issued
// ticket objective and in the shell-policy deny reason (friction #8): agents
// must discover the allowlist from the ticket, not by trial-and-error denial.
//
// It states the RULE, never any one project's script names: the admitted
// run-script set is per-project and per-tier, so the deny reason (which names
// the exact set for THAT ticket) is the concrete half. Keep it ONE FLAT
// NEWLINE-FREE string and keep it AHEAD of the trailing `Run objective:`
// suffix — lib/runtime/service.js interpolates it verbatim into every issued
// ticket objective, __tests__/runtime-v2-service.test.js anchors that suffix
// with `$`, and lib/runtime/projection.js's compactPendingTicket dedupes the
// objective by exact-suffix match and fails open on drift. NO ORDINAL IS
// CLAIMED FOR THIS REVISION, and the absence is DERIVED rather than lazy: no
// ordinal for the RESTATEMENT sequence is provable from this history at all.
// `git log --oneline --parents` shows main is a pure SQUASH chain — every
// commit has exactly one parent — so a landed-commit census (`git log -L` over
// this constant's own line) collapses every restatement made INSIDE a phase
// into the single squash that carried it, and this file records one such
// restatement outright: the `cd`-target sentence below "moved once INSIDE this
// phase". Worse for a census, `git log --all -S EVIDENCE_COMMAND_FAMILIES --
// lib/runtime/hooks.js` surfaces unmerged branch commits (4f5e65d1, d6273368)
// that a census of main cannot see at all, and `git diff --stat 4f5e65d1
// 1efac4f4 -- lib/runtime/hooks.js` shows real intra-phase state between them
// (687 insertions / 296 deletions). Any figure written here would replace one
// unprovable number with another, so what is recorded instead is what survives
// derivation: this string HAS been republished NARROWER than enforcement more
// than once — most sharply as the enumerated-metacharacter text against which
// the spike found the `=` bypass — which is why the clause below states the
// ADMITTED ALPHABET rather than a list of refusals. That restatement sequence
// is NOT the drift-INSTANCE counter directly below, which counts the whole
// surface rather than restatements of this string; the two sequences advance
// separately.
// So every rule the gate enforces that an agent cannot discover any other way
// (the exact-token head, the character rule, the positional expansion
// refusals, the `cd` target's smaller alphabet, operand containment, the
// run-script tier) is stated here.
//
// WHY THE CHARACTER CLAUSE IS NOW A POSITIVE STATEMENT. Round 5 caught the FIFTH
// instance of the published/enforced drift: the ENUMERATION of refused
// metacharacters omitted `#` and `!`, so the sentence "one shell metacharacter
// anywhere ... refuses the WHOLE command" was FALSE of the tree that published
// it. The SIXTH instance was found by the spike commissioned to prevent a
// seventh (run-fixture-d578507b4795, receipt d121cd29), which ran the
// enforced rule: `echo =ls` was ALLOWED and the shell printed `/bin/ls`, so the
// clause below about operands and the governed project was false too. An
// enumeration of refusals cannot be completed by adding to it — every addition
// leaves the same shape — so the clause states the ADMITTED ALPHABET and the
// POSITIONAL refusals instead. That statement is FINITE and CHECKABLE against
// EVIDENCE_TOKEN_CHAR_REFUSED and EVIDENCE_EXPANSION_POSITION, and an agent
// given the alphabet knows what is refused without the string listing it.
// The `cd` TARGET's own, SMALLER alphabet is published here for the same reason
// (LEADING_CD, below): an agent that cannot discover "no `~` or `^` in a
// relocation target" from this string can only discover it by being denied.
// Whenever either constant moves, this sentence moves with it — and it moved
// once INSIDE this phase, when the review group found EVIDENCE_EXPANSION_POSITION
// refusing `~` after `=`/`:` while admitting `=` in those same positions. Being
// checkable is what made that catchable: the clause and the constant can be read
// against each other, which an enumeration of refusals never allowed.
export const EVIDENCE_COMMAND_FAMILIES =
  'npm/pnpm/yarn/bun: bare `test` and `t` in every tier, but only as COMPLETE tokens (`test:e2e`, `test-ci`, `t-deploy`, `test.unit` are package scripts, not the bare form, and are refused); `run <script>` unrestricted on a WRITABLE ticket, and on a read-only ticket only the script names this project itself declares (its configured test_commands and runners[].profile commands, plus policy.evidence_scripts) — the deny reason names the exact set admitted for your ticket; vitest/jest/mocha/ava/playwright/tap/tsc/pytest runners, bare or via npx/pnpm/yarn/bun; node --test|--check|--version; python -m pytest|unittest; uv/poetry/pdm/hatch/rye/pipenv/pixi run with a pytest or python -m test tail; hatch|rye test; tox; go test; cargo test; read-only git (status|diff|log|show|rev-parse|branch|describe|ls-files — listing-only branch, no --output/-o file flags); ls|pwd|cat|echo|true|which; bare env (no operands); check-only linters (ruff|flake8|mypy|pylint|black|isort|eslint|prettier); at most one leading `cd <dir> &&` prefix; every command head is matched as an EXACT whitespace token, so `<head>-pwn`, `<head>.pwn` and `<head>:pwn` are different programs and are refused; every character is checked against a positive ALLOWLIST, so anything outside it — every shell metacharacter, a NUL byte, an invisible format character, any whitespace other than a plain space — refuses the WHOLE command: the admitted alphabet is A-Za-z0-9, the punctuation `- _ . / : = @ ~ , % ^ +`, and non-ASCII code points by range (so an accented or CJK path is admitted), with a single plain space as the only separator; three of those characters EXPAND at the start of a token, so a token beginning with `~`, `=` or `^` is refused there, and `~` and `=` are refused straight after a `=` or a `:` inside a token as well, while each of them stays admitted in every other position; a `cd` relocation target additionally may not begin with `-` or `+`, which name directory-stack entries rather than paths; a `cd` target may not carry `~` or `^` ANYWHERE either — in a path both are EXTENDED_GLOB pattern operators and the target is the one operand that relocates the whole command — so its alphabet is the token alphabet minus those two; no operand — a bare token, the `=`-suffix of a flag, or a path stuck onto a short flag — may name a path outside the governed project, so a relocation flag is refused by its OPERAND and never by its spelling; chaining, redirects, and inline interpreters are denied';
// ---------------------------------------------------------------------------
// TOKENIZE-THEN-ALLOWLIST — the admission mechanism (see the pointer comment
// above EVIDENCE_COMMAND for the L1/L2/L3 layer analysis and the doc path).
//
// (1) Refuse the whole command outright unless EVERY character of it is in a
//     POSITIVE ALPHABET. Rounds 1-5 all asserted a NEGATIVE over an adversarial
//     space; until this phase step (1) still did, one level down (a list of
//     forbidden characters), and it under-enumerated twice — round 5 by `#`,
//     `!` and U+0000, and the spike that derived this replacement by `=`. A
//     positive alphabet closes that class BY CONSTRUCTION: a character nobody
//     foresaw now DENIES instead of being admitted. One character outside the
//     alphabet rejects the WHOLE command, so there is no partial parse for a
//     later stage to mis-trust.
// (2) Split on whitespace. After (1) that split PROVABLY equals the shell's
//     word splitting, which is the entire content of "the gate inspects the
//     same tokens the program receives".
// (3) Recognize the head by EXACT TOKEN EQUALITY against a finite table —
//     never by a regex boundary. There is then no separator class to get
//     wrong: an unrecognized head DENIES.
// (4) Refuse the OPERAND, never the flag spelling (evidenceOperandCandidates /
//     evidenceContainment, below).
//
// "PER-TOKEN" NAMES THE ALPHABET, NOT THE POSITION, and that is why the check
// runs on the RAW string rather than after tokenization: U+0020 is the only
// structural character inside a command, so "every character of the raw command
// is in the token alphabet or is U+0020" is simultaneously a whole-command and a
// per-token statement, with no second view of the string to drift. Exactly
// two things need treatment outside the alphabet, and both are handled here:
// runs of U+0020 (admitted, and the shell collapses them exactly as `/\s+/`
// does), and the `&&` of the leading `cd <dir> &&` prefix, which LEADING_CD
// consumes LITERALLY BEFORE the alphabet check — with the captured target then
// facing the SAME per-token predicate as the remainder. Round 5's site 1 was
// exactly the drift between those two halves; the structure that prevents it
// recurring is that ONE predicate answers for both.
//
// THREE CHARACTERS ARE REFUSED BY POSITION, NOT BY MEMBERSHIP, because they
// carry a zsh WORD-LEVEL EXPANSION at SOME positions of a word and not at
// others. This is where the whole security content of the character rule sits —
// the alphabet says WHICH characters may appear, the positions say WHERE the
// expanding ones may not — and each is positional rather than wholesale because
// a wholesale refusal would delete a form this pipeline's own later stages run:
//   `~`  TILDE expansion, at token start and immediately after `=` or `:`
//        inside a word. A blanket refusal would permanently deny
//        `git log HEAD~3`, `git diff HEAD~1` and `git show HEAD~1:<path>`.
//   `=`  EQUALS expansion: zsh replaces a word BEGINNING with `=` by the full
//        path of the command it names. This was a LIVE BYPASS, verified against
//        the running gate by the spike that derived this alphabet
//        (run-fixture-d578507b4795, receipt d121cd29) and re-verified on
//        the inert `echo` head: `echo =ls` was ALLOWED and the shell printed
//        `/bin/ls`; `ls -l =node` was ALLOWED and the shell listed
//        `/opt/homebrew/bin/node`, OUTSIDE the governed project.
//        evidenceOperandNeedsRoot reads `=node` as relative and dotdot-free, so
//        BOTH the synchronous containment check AND the async realpath
//        precompute contained it LEXICALLY while the shell handed the program an
//        absolute out-of-tree path — which falsified the rule acme PR #368 publishes
//        in every issued ticket objective. A wholesale refusal would delete the
//        `=`-suffix operand form the ENTIRE containment rule reads
//        (`--rootdir=tests`, `--workers=1`, `--pretty=format:%h`). `=` is ALSO
//        refused at the SAME two in-word positions as `~`, because zsh states
//        one rule for both characters and this phase's review group found the
//        `=` half admitted while the `~` half was refused — see
//        EVIDENCE_EXPANSION_POSITION for the manual's own sentence, the
//        MAGIC_EQUAL_SUBST dependence, and the measured cost.
//   `^`  the EXTENDED_GLOB exclusion operator. A wholesale refusal would deny
//        `git log HEAD^`. NAMED REAL COST of the token-start half, so the
//        over-block is a decision and not an accident: `git log ^main master` is
//        admitted today and becomes DENIED. `git log main..HEAD` stays admitted,
//        because the `..` containment check is segment-wise.
// The positional rule is COMPLETE only because (1) already refuses quotes and
// metacharacters, so words ARE exactly the whitespace tokens.
//
// THE SHELL THE ARGUMENT IS DISCHARGED AGAINST IS ZSH, and this is the honest
// ceiling on what any character rule delivers. The prior revision of this
// comment argued about non-interactive BASH; the executing shell is zsh (`=ls`
// -> `/bin/ls` is zsh-only, and the `(eval):1:` error prefix is zsh's format,
// which also shows the host wraps the command in `eval` inside a persistent
// shell). zsh's word-level expansion set is a strict SUPERSET of bash's. Under
// `setopt EXTENDED_GLOB` — UNSET in the observed session (`echo ^x` printed
// `^x`) but common in shipped profiles, and the host sources the operator's
// profile — `^`, `#` and `~` become glob operators, so the special-character set
// is partly OPERATOR-CONFIGURABLE. `~` and `^` MID-TOKEN IN AN ORDINARY TOKEN
// are therefore NARROWED, not closed — that qualifier is load-bearing, because
// in a `cd` TARGET both are refused ANYWHERE and the exposure is CLOSED for
// that ONE operand (the target-alphabet note above LEADING_CD). The accurate
// claim is: no character the gate ADMITS can make the shell read the command
// differently, FOR THE SHELL AND THE SHELL OPTIONS docs/hooks.md names — never
// "the shell runs exactly what the gate read".
//
// NON-ASCII IS ADMITTED BY RANGE, with the three category carve-outs
// NON_ASCII_HAZARD makes (see it above parseDeletionCommand). Refusing it is a
// REGRESSION, not a hypothetical — `echo café-naïve-Ω` and
// `echo tests/日本語/a🙂b.test.js` are admitted today — and an ASCII-only
// alphabet is a total lockout for any project under an accented or non-Latin
// path, i.e. an invariant-6 violation. NORMALIZING IS REJECTED: it would make
// the gate inspect a DIFFERENT STRING from the one the shell receives, which is
// the defect class this rule exists to close. Private-use and unassigned code
// points stay admitted — no shell meaning, and not durably expressible.
//
// THE TWO CONSTANTS BELOW ARE `.test()`ED AT LEAST TWICE PER COMMAND (the
// remainder and the `cd` target), so NEITHER MAY CARRY /g: lastIndex is
// stateful and the second call would answer differently (the reason is already
// recorded at DEV_NULL_REDIRECT). Single negated character classes only, never
// an alternation under a quantifier — the policy is synchronous and a
// backtracking blowup on an 8 MB stdin is a session-wide denial of service.
//
// EVIDENCE_NON_SPACE_WHITESPACE IS NOT REDUNDANT — DO NOT DELETE IT AS COVERED
// BY THE ALPHABET. It runs over the WHOLE RAW command BEFORE `trim()` and BEFORE
// `LEADING_CD.exec` (parseEvidenceCommand, below), and LEADING_CD matches with
// `\s`, which absorbs NBSP/CR/VT/FF/U+2028/U+2029/U+FEFF. Without it,
// `cd<NBSP>sub && npm test` would split into two halves that each pass the
// alphabet check, and the command the gate reports would not be the one the
// shell runs.
const EVIDENCE_NON_SPACE_WHITESPACE = /[^\S ]/;
// The POSITIVE per-token alphabet, expressed as the single negated class of
// everything it does not admit: U+0020, A-Za-z0-9, the punctuation
// `- _ . / : = @ ~ , % ^ +`, and every code point at or above U+0080.
// Each punctuation member earns its place with a concrete ADMITTED command, and
// __tests__/runtime-v2-evidence-character-allowlist.test.js pins one per row:
//   -  `ls -la`, `git rev-parse HEAD`      _  `npx vitest run __tests__/x.test.js`
//   .  `go test ./...`                     /  `ruff check src/`
//   :  `git show <sha>:<path>`             =  `pytest --rootdir=tests`
//   @  `npm run @scope/build`              ~  `git log HEAD~3`
//   ,  `cargo test --features a,b`         %  `git log --pretty=format:%h`
//   ^  `git log HEAD^`                     +  `git show v2.10.1+ci.4`
// `+` is the WEAKEST attestation in the table, and is said so rather than
// dressed up: no allow arm in any suite needed it before this phase. It is
// admitted because SemVer build-metadata tags are legal git refs, so a project
// that tags `v2.10.1+ci.4` could not otherwise `git show` its own release.
// THIS IS THE ORDINARY-TOKEN ALPHABET AND NOT THE ONLY ONE. A `cd` relocation
// target answers to a strictly smaller class inside LEADING_CD (this set minus
// `~` and `^`), and an `rm` target to DELETION_TOKEN_CHAR_REFUSED (this set
// minus `~`, `=` and `^`). Three sets, on purpose; do not re-sync them.
const EVIDENCE_TOKEN_CHAR_REFUSED = /[^ A-Za-z0-9\-_.\/:=@~,%^+\u{80}-\u{10FFFF}]/u;
// The expansion POSITIONS — `^~`, `^=`, `^^`, and BOTH `~` and `=` straight
// after `=` or `:` — applied per token and to the `cd` target.
//
// `[=:][~=]`, NOT `[=:]~`, AND THE DIFFERENCE IS A REVIEW FINDING OF THIS PHASE.
// The first cut of this constant closed the `~` half of zsh's filename-expansion
// rule and admitted the `=` half OF THE SAME SENTENCE; the review and the
// security review both caught it, at this line. zsh states ONE rule for both
// characters: an assignment's value "will be treated as a colon-separated list
// in the manner of the PATH parameter, so that a `~` or an `=` following a `:`
// is eligible for expansion", and MAGIC_EQUAL_SUBST extends that treatment to
// "any unquoted shell argument in the form identifier=expression". The eligible
// positions are therefore `^~`, `^=`, `=~`, `==`, `:~` and `:=`, and admitting
// the last two was FINDING 1'S MECHANISM MOVED ONE POSITION OVER:
// `pytest --rootdir==node` passed the alphabet, passed `^[~=^]` and passed
// `[=:]~`, and then evidenceOperandCandidates yielded the `=`-suffix candidate
// `=node` — relative and dotdot-free, so BOTH the synchronous containment check
// and the hook's realpath precompute contained it LEXICALLY while zsh
// substitutes the absolute path of whatever `node` names.
//
// OPTION-DEPENDENT, AND SAID SO RATHER THAN DRESSED UP AS A CLOSURE. In an
// ARGUMENT — which is all this gate can reach, since no admitted head takes an
// assignment and both script-name grammars refuse `=` — the `[=:]` positions
// need MAGIC_EQUAL_SUBST, and it is UNSET in the observed session: `echo a:=ls`,
// `echo a==ls` and `echo --rootdir==node` each printed themselves VERBATIM. Both
// halves are refused anyway, because the option is operator-configurable and the
// host sources the operator's profile — the same family as the EXTENDED_GLOB
// dependence of `^`, and NARROWING rather than closure for the same reason.
// MEASURED OVER-BLOCK COST: ZERO. No allow arm in any evidence suite and no row
// of the character inventory carries `==` or `:=` in any position.
const EVIDENCE_EXPANSION_POSITION = /^[~=^]|[=:][~=]/;

// The head tables. Membership is EXACT STRING equality against a Set in every
// position — head, verb, subcommand and linter alike. `cargo` makes the stakes
// concrete: `cargo test-pwn` resolves through cargo's `cargo-<name>` PATH
// extension mechanism, so the NAME is the program; and pnpm/yarn/bun execute a
// package.json script by BARE NAME, so `yarn mypy-x` invokes an arbitrary
// declared script. A head recognized on a word boundary instead of by equality
// is therefore an arbitrary-program primitive, not a typo.
const PACKAGE_MANAGER_HEAD = new Set(['npm', 'pnpm', 'yarn', 'bun']);
// Runners a package manager (or npx) may execute directly. `npm` is excluded
// from this arm on purpose — `npm vitest` is not a thing — and reaches its
// runners through `npm test` / `npm run <script>`.
const PACKAGE_MANAGER_RUNNER = new Set(['vitest', 'jest', 'mocha', 'ava', 'playwright', 'tap', 'tsc']);
const BARE_TEST_RUNNER = new Set(['vitest', 'jest', 'mocha', 'ava', 'tap', 'pytest', 'tsc']);
const NODE_EVIDENCE_FLAG = new Set(['--test', '--check', '--version']);
const PYTHON_HEAD = new Set(['python', 'python3']);
const PYTHON_TEST_MODULE = new Set(['pytest', 'unittest']);
const PYTHON_MANAGER_HEAD = new Set(['uv', 'poetry', 'pdm', 'hatch', 'rye', 'pipenv', 'pixi']);
const PYTHON_MANAGER_TEST_HEAD = new Set(['hatch', 'rye']);
const GIT_EVIDENCE_VERB_TOKEN = new Set([
  'status', 'diff', 'log', 'show', 'rev-parse', 'branch', 'describe', 'ls-files',
]);
const INSPECTION_BUILTIN = new Set(['ls', 'pwd', 'cat', 'echo', 'true', 'which']);
// The LINT head table. Converting it to exact-token recognition is not
// cosmetic: it carried the IDENTICAL unanchored word-boundary defect, and
// because pnpm/yarn/bun run package.json scripts by bare name, `yarn mypy-x`
// was the very arbitrary-declared-script channel this gate exists to close.
const LINT_TOOL = new Set([
  'ruff', 'flake8', 'mypy', 'pylint', 'black', 'isort', 'eslint', 'prettier',
]);
const RUFF_EVIDENCE_VERB = new Set(['check', 'format', '--version']);
const LINT_EXEC_PREFIX = new Set(['exec', 'x']);

// Names-only view of every POSITION-0 command head — the evidence table and the
// lint table in ONE list, so a head added to either TABLE is automatically
// covered by the suite's data-driven `<head>-pwn` / `<head>.pwn` / `<head>:pwn`
// probe. Adding a head on a word boundary instead of by exact equality turns
// that arm red automatically; that self-policing property is the point of
// exporting it.
//
// THE CLAIM IS EXACTLY POSITION 0 AND NO WIDER. It used to read "a head added
// to either is automatically covered", which was false of three things this
// list structurally cannot reach, all now published rather than papered over:
//   * a token recognized in a LATER position — `playwright` after `npx`, a git
//     verb after `git`, a `node` flag, a `ruff` subcommand, an exec prefix, a
//     linter after a manager — is not a position-0 head, so it is correctly
//     ABSENT here (bare `playwright` is not an admitted command and listing it
//     would describe a head the gate never recognizes at position 0). Those
//     slots are covered by EVIDENCE_SECOND_POSITION_PROBES below instead;
//   * a token spelled as an INLINE LITERAL rather than as a table member — a
//     HEAD (`head === 'deno'`), a VERB or a SUBCOMMAND — belongs to no
//     recognition Set, so NEITHER export DERIVES it. Both exports therefore
//     spell today's literals out BY HAND, and that hand-written half is the
//     standing gap: EVIDENCE_COMMAND_HEADS carries the seven position-0
//     literals (`npx`, `node`, `tox`, `go`, `cargo`, `git`, `env`) beside its
//     six spread tables, and secondPositionProbes() carries the
//     later-position ones — `test` after `go`/`cargo`/`hatch`/`rye`,
//     `test`/`t` after a package manager, `-m` after `python`/`python3`,
//     `run` after a Python manager (spelled TWICE, once in
//     recognizeEvidenceHead and once in recognizeLintHead), `pytest` after
//     `<pymgr> run`, and the `python` and `-m` slots of
//     `<pymgr> run python -m <module>`. Those slots ARE probed; a NEW literal
//     at ANY position is reached by NOTHING until it is added here too. Add
//     the token to a TABLE instead of to a literal comparison — that is what
//     buys the self-policing;
//   * the `<pm> run <script>` phrase, excluded at BOTH its slots and for two
//     different reasons. The SCRIPT name is the role-aware TIER decision
//     below, not exact-token recognition, and on a writable ticket the tier
//     admits ANY name, so a probe row for it would be unsatisfiable. The
//     `run` VERB could only be paired with an admitted command whose
//     admission is itself TIER-dependent (`<pm> run <script>` is admitted
//     exactly where the tier admits that script name), while every row in the
//     probe table is admitted in EVERY tier — that gate is the policy's ONLY
//     writable-conditional branch, and no row renders a `<pm> run` phrase.
//     Both slots carry NAMED arms
//     instead — the verb in __tests__/runtime-v2-hook-shell-policy.test.js,
//     the script name in
//     __tests__/runtime-v2-evidence-command-script-allowlist.test.js.
export const EVIDENCE_COMMAND_HEADS = Object.freeze([
  ...new Set([
    ...PACKAGE_MANAGER_HEAD,
    'npx',
    ...BARE_TEST_RUNNER,
    'node',
    ...PYTHON_HEAD,
    ...PYTHON_MANAGER_HEAD,
    'tox',
    'go',
    'cargo',
    'git',
    ...INSPECTION_BUILTIN,
    'env',
    ...LINT_TOOL,
  ]),
]);

// Evidence commands are admitted by exact argv head, but the shell resolves
// that head through PATH only after the hook has returned. A writable agent
// can create a previously-absent executable in an earlier PATH directory and
// thereby make the shell execute different bytes than the trusted run start
// resolved. Fresh runs therefore persist one realpath snapshot for every
// admitted position-0 head and each bound Bash event re-resolves its actual
// head against the hook's current environment.
//
// These three names are Bash builtins on every supported host, including the
// Bash surface Claude/Codex expose on Windows. They never consult PATH, so they
// are represented explicitly instead of being accidentally grandfathered by
// a missing executable. `cd` is also a builtin, but it is grammar-only (the
// optional leading relocation) rather than an evidence-command head. `ls`,
// `cat`, `which`, and `env` are deliberately NOT listed: Bash normally finds
// them through PATH and a shadow must be detected.
export const EVIDENCE_SHELL_BUILTINS = Object.freeze(['echo', 'pwd', 'true']);
const EVIDENCE_SHELL_BUILTIN_SET = new Set(EVIDENCE_SHELL_BUILTINS);
const WINDOWS_DEFAULT_PATHEXT = '.COM;.EXE;.BAT;.CMD';
// Small shims/scripts are hashed completely. Large native binaries use stable
// filesystem identity instead, keeping both run start and every hook bounded:
// a same-path in-place write changes ctime, while an atomic replacement changes
// inode/file-index. Small package-manager shims (including npm.cmd and the
// realpath-target npm CLI script) get the stronger content digest.
const EVIDENCE_EXECUTABLE_HASH_MAX_BYTES = 8 * 1024 * 1024;

function environmentValue(env, name, platform) {
  if (typeof env?.[name] === 'string') return env[name];
  if (platform !== 'win32' || !env || typeof env !== 'object') return undefined;
  const folded = name.toLowerCase();
  for (const [key, value] of Object.entries(env)) {
    if (key.toLowerCase() === folded && typeof value === 'string') return value;
  }
  return undefined;
}

function windowsExtensions(env, platform) {
  if (platform !== 'win32') return [''];
  const configured = environmentValue(env, 'PATHEXT', platform);
  const value = configured === undefined ? WINDOWS_DEFAULT_PATHEXT : configured;
  const extensions = value
    .split(';')
    .map((extension) => extension.trim())
    .filter(Boolean)
    .map((extension) => extension.startsWith('.') ? extension : `.${extension}`);
  // Windows tries an exact filename too. It matters for extensionless shims
  // under Git Bash, while PATHEXT preserves cmd.exe/PowerShell precedence for
  // the normal npm.cmd/python.exe forms.
  return [...extensions, ''];
}

function unquotePathEntry(entry) {
  if (entry.length >= 2 && entry.startsWith('"') && entry.endsWith('"')) {
    return entry.slice(1, -1);
  }
  return entry;
}

// On real Windows, exists/access are already case-insensitive. The directory
// scan makes that property explicit and lets the Windows contract be tested on
// a case-sensitive CI filesystem too. Only the basename needs folding: PATH
// supplied the directory and Windows itself resolves that directory without
// case sensitivity.
function caseAwareCandidate(
  directory,
  basename,
  platform,
  nativePlatform,
  readDirectoryEntries,
) {
  const direct = path.join(directory, basename);
  if (platform !== 'win32') return direct;
  try {
    accessSync(direct, fsConstants.F_OK);
    return direct;
  } catch {
    // A native Windows filesystem already performs this lookup
    // case-insensitively. Re-enumerating the directory after every missing
    // head/PATHEXT candidate is redundant there and turns one trusted-start
    // snapshot into thousands of synchronous directory scans. Keep the scan
    // only for tests and callers simulating win32 on a case-sensitive host.
    if (nativePlatform === 'win32') return direct;
    try {
      const match = readDirectoryEntries(directory).find((entry) =>
        entry.toLowerCase() === basename.toLowerCase());
      return match ? path.join(directory, match) : direct;
    } catch {
      return direct;
    }
  }
}

function usableExecutable(candidate, platform) {
  try {
    accessSync(candidate, platform === 'win32' ? fsConstants.F_OK : fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
}

// Resolve exactly as the supported shell surfaces do for a simple command
// head: PATH order first, then PATHEXT order on Windows. The return is the
// filesystem realpath, not the lexical shim path, so replacing a symlink with
// a shadow elsewhere changes the observation. This helper is exported for the
// start snapshot and for platform-specific regression tests.
export function resolveEvidenceExecutable(
  head,
  {
    env = process.env,
    cwd = process.cwd(),
    platform = process.platform,
    nativePlatform = process.platform,
    readDirectoryEntries = readdirSync,
  } = {},
) {
  if (typeof head !== 'string' || !EVIDENCE_COMMAND_HEADS.includes(head)) return null;
  if (EVIDENCE_SHELL_BUILTIN_SET.has(head)) return null;
  const pathValue = environmentValue(env, 'PATH', platform);
  if (pathValue === undefined) return null;
  const delimiter = platform === 'win32' ? ';' : path.delimiter;
  const extensions = windowsExtensions(env, platform);
  for (const rawEntry of pathValue.split(delimiter)) {
    const entry = unquotePathEntry(rawEntry);
    const directory = path.resolve(cwd, entry || '.');
    for (const extension of extensions) {
      const candidate = caseAwareCandidate(
        directory,
        `${head}${extension}`,
        platform,
        nativePlatform,
        readDirectoryEntries,
      );
      if (!usableExecutable(candidate, platform)) continue;
      try {
        return realpathSync.native(candidate);
      } catch {
        // A path may disappear between access and realpath. Continue exactly
        // like a fresh shell lookup would; if nothing remains, the observation
        // is `missing` and comparison fails closed against a prior executable.
      }
    }
  }
  return null;
}

// Run start snapshots every admitted evidence head at once. Resolving each
// head independently multiplies synchronous filesystem probes by
// heads × PATH entries × PATHEXT (tens of thousands on a typical Windows
// runner). Inventory each PATH directory once, then preserve the shell's
// ordering exactly: directories outermost, PATHEXT candidates in order for
// each still-unresolved head. The later usability/realpath/fingerprint checks
// retain the same fail-closed race behavior as the single-head resolver.
function resolveEvidenceExecutableHeads(
  heads,
  {
    env = process.env,
    cwd = process.cwd(),
    platform = process.platform,
    readDirectoryEntries = readdirSync,
  } = {},
) {
  const result = new Map(heads.map((head) => [head, null]));
  const unresolved = new Set(heads);
  const pathValue = environmentValue(env, 'PATH', platform);
  if (pathValue === undefined) return result;
  const delimiter = platform === 'win32' ? ';' : path.delimiter;
  const extensions = windowsExtensions(env, platform);

  for (const rawEntry of pathValue.split(delimiter)) {
    if (unresolved.size === 0) break;
    const entry = unquotePathEntry(rawEntry);
    const directory = path.resolve(cwd, entry || '.');
    let entries;
    try {
      entries = readDirectoryEntries(directory);
    } catch {
      continue;
    }
    const names = new Map();
    for (const name of entries) {
      const key = platform === 'win32' ? name.toLowerCase() : name;
      if (!names.has(key)) names.set(key, name);
    }
    for (const head of [...unresolved]) {
      for (const extension of extensions) {
        const basename = `${head}${extension}`;
        const key = platform === 'win32' ? basename.toLowerCase() : basename;
        const actualName = names.get(key);
        if (actualName === undefined) continue;
        const candidate = path.join(directory, actualName);
        if (!usableExecutable(candidate, platform)) continue;
        try {
          result.set(head, realpathSync.native(candidate));
          unresolved.delete(head);
          break;
        } catch {
          // The candidate disappeared after inventory. Keep looking through
          // later PATHEXT/PATH candidates just as the shell would.
        }
      }
    }
  }
  return result;
}

function executableComparisonKey(value, platform) {
  if (typeof value !== 'string') return null;
  const normalized = platform === 'win32'
    ? path.win32.normalize(value.replaceAll('/', '\\')).toLowerCase()
    : path.normalize(value);
  return normalized;
}

function executableFingerprint(realpathValue) {
  try {
    const stat = statSync(realpathValue, { bigint: true });
    if (!stat.isFile()) return null;
    if (stat.size <= BigInt(EVIDENCE_EXECUTABLE_HASH_MAX_BYTES)) {
      return {
        strategy: 'sha256-v1',
        size: stat.size.toString(),
        sha256: createHash('sha256').update(readFileSync(realpathValue)).digest('hex'),
      };
    }
    return {
      strategy: 'file-identity-v1',
      dev: stat.dev.toString(),
      ino: stat.ino.toString(),
      size: stat.size.toString(),
      mtime_ns: stat.mtimeNs.toString(),
      ctime_ns: stat.ctimeNs.toString(),
    };
  } catch {
    return null;
  }
}

function sameExecutableFingerprint(expected, current) {
  if (!expected || !current || expected.strategy !== current.strategy) return false;
  if (expected.strategy === 'sha256-v1') {
    return expected.size === current.size && expected.sha256 === current.sha256;
  }
  if (expected.strategy === 'file-identity-v1') {
    return ['dev', 'ino', 'size', 'mtime_ns', 'ctime_ns'].every(
      (field) => expected[field] === current[field],
    );
  }
  return false;
}

export function snapshotEvidenceExecutables(options = {}) {
  const platform = options.platform ?? process.platform;
  const heads = {};
  const fingerprints = new Map();
  const resolvedHeads = resolveEvidenceExecutableHeads(
    EVIDENCE_COMMAND_HEADS.filter((head) => !EVIDENCE_SHELL_BUILTIN_SET.has(head)),
    { ...options, platform },
  );
  for (const head of EVIDENCE_COMMAND_HEADS) {
    if (EVIDENCE_SHELL_BUILTIN_SET.has(head)) {
      heads[head] = { kind: 'shell-builtin' };
      continue;
    }
    const resolved = resolvedHeads.get(head) ?? null;
    if (resolved === null) {
      heads[head] = { kind: 'missing' };
      continue;
    }
    const key = executableComparisonKey(resolved, platform);
    let fingerprint = fingerprints.get(key);
    if (fingerprint === undefined) {
      fingerprint = executableFingerprint(resolved);
      fingerprints.set(key, fingerprint);
    }
    heads[head] = { kind: 'executable', realpath: resolved, fingerprint };
  }
  return {
    version: 'realpath-v1',
    platform,
    heads,
  };
}

export function verifyEvidenceExecutableSnapshot(snapshot, head, options = {}) {
  // Active runs created before this policy existed cannot retroactively take a
  // trusted-start snapshot. Preserve their existing behavior; every fresh run
  // carries the field, and malformed/partial fresh snapshots fail closed below.
  if (snapshot === undefined || snapshot === null) {
    return { safe: true, reason: null, legacy_snapshot_absent: true };
  }
  const platform = options.platform ?? process.platform;
  if (
    snapshot?.version !== 'realpath-v1' ||
    snapshot.platform !== platform ||
    !snapshot.heads ||
    typeof snapshot.heads !== 'object'
  ) {
    return {
      safe: false,
      reason: 'the trusted-start evidence executable snapshot is invalid or belongs to another platform',
    };
  }
  const expected = snapshot.heads[head];
  if (EVIDENCE_SHELL_BUILTIN_SET.has(head)) {
    return expected?.kind === 'shell-builtin'
      ? { safe: true, reason: null }
      : { safe: false, reason: `shell builtin ${head} is missing from the trusted-start snapshot` };
  }
  if (!expected || !['missing', 'executable'].includes(expected.kind)) {
    return {
      safe: false,
      reason: `evidence executable ${head} is missing from the trusted-start snapshot`,
    };
  }
  const current = resolveEvidenceExecutable(head, { ...options, platform });
  if (expected.kind === 'missing') {
    return current === null
      ? { safe: true, reason: null }
      : {
          safe: false,
          reason: `evidence executable ${head} appeared on PATH after the trusted run start`,
        };
  }
  const unchanged =
    executableComparisonKey(expected.realpath, platform) !== null &&
    executableComparisonKey(expected.realpath, platform) === executableComparisonKey(current, platform);
  if (!unchanged) {
    return {
      safe: false,
      reason: `evidence executable ${head} resolves to a different realpath than at the trusted run start`,
    };
  }
  const fingerprintUnchanged = sameExecutableFingerprint(
    expected.fingerprint,
    executableFingerprint(current),
  );
  return fingerprintUnchanged
    ? { safe: true, reason: null }
    : {
        safe: false,
        reason: `evidence executable ${head} changed content or file identity after the trusted run start`,
      };
}

// ---------------------------------------------------------------------------
// The SECOND-POSITION probe table — the other half of the self-policing claim
// (roadmap entry evidence-gate-self-policing-claims-overstated, A2).
//
// EVIDENCE_COMMAND_HEADS makes position 0 self-policing. Every OTHER recognized
// slot had no data-driven arm at all: a new PACKAGE_MANAGER_RUNNER, a new
// GIT_EVIDENCE_VERB_TOKEN, a new NODE_EVIDENCE_FLAG, a new PYTHON_TEST_MODULE,
// a new RUFF_EVIDENCE_VERB, a new LINT_EXEC_PREFIX or a new LINT_TOOL was
// probed by NOTHING, and `playwright` is the standing proof — a token the gate
// recognizes only after a package manager, so it is correctly absent from the
// head table and was consequently reached by no arm.
//
// Each row names one recognized slot POSITIONALLY:
//   prefix  the tokens BEFORE the slot ('npx', 'git', 'python3 -m',
//           'pnpm exec', 'uv run'). NEVER empty — position 0 is the other
//           table's job, and an empty prefix would silently re-probe it.
//   token   the EXACT token recognized AT that slot.
//   tail    the tokens AFTER it that make the row a legitimate, ADMITTED
//           command ('' when none). A formatter carries its check flag here and
//           an exec prefix carries the linter that follows it, so a suite can
//           assert BOTH halves per row — the suffixed spellings DENY and the
//           paired command ALLOWS. Without the allow half a probe table is
//           vacuous: a junk row denies merely because its base form is
//           unrecognized.
//
// DERIVATION IS PER-SLOT, AND SO IS THE SELF-POLICING IT BUYS. Wherever the
// recognizer reads a Set, this table reads the SAME Set — the runner after a
// manager, the git verb, the node flag, the python module, the ruff
// subcommand, the exec prefix and the linter are all derived, as are the
// prefixes that range over PACKAGE_MANAGER_HEAD, PYTHON_HEAD and
// PYTHON_MANAGER_HEAD. A token added to any of those Sets gets its rows for
// free; a token added with no admitted invocation (a new formatter with no
// entry in LINT_TOOL_PROBE_TAIL, a new package-manager head
// recognizeLintHead's inline literals do not spell) renders a row whose paired
// command is DENIED and turns the probe arm red, which is the mechanism
// working rather than a defect in it.
//
// WHAT IS WRITTEN OUT BY HAND, stated because the claim here used to read
// "EVERY ROW IS DERIVED FROM THE RECOGNITION TABLES, never hand-listed" and
// that was FALSE. The recognizers spell some slots as `===` against a LITERAL,
// and no derivation can reach a literal: `test` after `go`/`cargo`/`hatch`/
// `rye`, `test`/`t` after a package manager, `-m` after `python`/`python3`,
// `run` after a Python manager (spelled TWICE, once in recognizeEvidenceHead
// and once in recognizeLintHead), `pytest` after `<pymgr> run`, and the
// `python` and `-m` slots of `<pymgr> run python -m <module>`. Those tokens —
// and the literal prefixes `npx`, `git`, `node`, `ruff`, `go` and `cargo`,
// which are position-0 heads EVIDENCE_COMMAND_HEADS hand-lists for the same
// reason — are typed out below. They ARE probed; a NEW literal is probed by
// NOTHING until its row is added here too, and that residual is published in
// the same words at EVIDENCE_COMMAND_HEADS above and in docs/hooks.md.
//
// ONLY HEAD / VERB / SUBCOMMAND SLOTS BELONG HERE. An OPERAND slot does not:
// `cat package.json-pwn` is ALLOWED and correctly so — the builtin is
// recognized regardless of its tail and the operand is lexically contained — so
// probing an operand would assert a refusal the gate does not make and should
// never make. And the `<pm> run <script>` phrase is DELIBERATELY EXCLUDED AT
// BOTH SLOTS, for the two reasons the carve-out above states: the SCRIPT name
// is a TIER decision and a row for it would be unsatisfiable on a writable
// ticket, and the `run` VERB has no tier-independent paired command, while
// every row here is admitted in EVERY tier.
// ---------------------------------------------------------------------------
// The managers that execute a bare tool name. `npm` is excluded from BOTH arms
// on purpose: `npm vitest` is not a thing (recognizeEvidenceHead excludes it
// explicitly), and recognizeLintHead spells the other three as inline literals.
const TOOL_RUNNING_MANAGER = [...PACKAGE_MANAGER_HEAD].filter((head) => head !== 'npm');
// The tail that makes a LINT_TOOL row a legitimate ADMITTED command: `ruff` is
// recognized only with its exact subcommand, and the three in-place formatters
// must carry an explicit check-mode flag. Every other linter is read-only bare.
const LINT_TOOL_PROBE_TAIL = new Map([
  ['ruff', 'check'],
  ['black', '--check'],
  ['isort', '--check'],
  ['prettier', '--check'],
]);
// Every prefix that reaches the LINT_TOOL slot, in the order recognizeLintHead
// tests them: a Python manager's `run`, `npx`, a bare manager, a manager plus
// an exec prefix.
const LINT_TOOL_PROBE_PREFIXES = [
  ...[...PYTHON_MANAGER_HEAD].map((head) => `${head} run`),
  'npx',
  ...TOOL_RUNNING_MANAGER.flatMap((head) => [
    head,
    ...[...LINT_EXEC_PREFIX].map((exec) => `${head} ${exec}`),
  ]),
];

function secondPositionProbes() {
  const rows = [];
  const probe = (prefix, token, tail = '') => rows.push(Object.freeze({ prefix, token, tail }));
  // PACKAGE_MANAGER_RUNNER after npx / pnpm / yarn / bun.
  for (const head of ['npx', ...TOOL_RUNNING_MANAGER]) {
    for (const runner of PACKAGE_MANAGER_RUNNER) probe(head, runner);
  }
  // GIT_EVIDENCE_VERB_TOKEN after `git`.
  for (const verb of GIT_EVIDENCE_VERB_TOKEN) probe('git', verb);
  // NODE_EVIDENCE_FLAG after `node`.
  for (const flag of NODE_EVIDENCE_FLAG) probe('node', flag);
  // PYTHON_TEST_MODULE after `python -m` / `python3 -m`.
  for (const head of PYTHON_HEAD) {
    for (const module of PYTHON_TEST_MODULE) probe(`${head} -m`, module);
  }
  // RUFF_EVIDENCE_VERB after `ruff` — the subcommand slot, where `check` is
  // read-only and `format` is a formatter, decided positionally.
  for (const verb of RUFF_EVIDENCE_VERB) probe('ruff', verb, verb === 'format' ? '--check' : '');
  // `test` after go / cargo / hatch / rye. `cargo test-pwn` resolves through
  // cargo's `cargo-<name>` PATH extension, so the NAME is the program.
  for (const head of ['go', 'cargo', ...PYTHON_MANAGER_TEST_HEAD]) probe(head, 'test');
  // LINT_EXEC_PREFIX after pnpm / yarn / bun ...
  for (const head of TOOL_RUNNING_MANAGER) {
    for (const exec of LINT_EXEC_PREFIX) probe(head, exec, 'eslint');
  }
  // ... and the LINT_TOOL that follows that prefix, follows a manager directly
  // (the bare-name shape docs/hooks.md's tier section documents), follows npx,
  // or follows a Python manager's `run`.
  for (const prefix of LINT_TOOL_PROBE_PREFIXES) {
    for (const tool of LINT_TOOL) probe(prefix, tool, LINT_TOOL_PROBE_TAIL.get(tool) ?? '');
  }
  // THE REMAINING INLINE-LITERAL SLOTS — the hand-written half named in the
  // header above (the `test` after `go`/`cargo`/`hatch`/`rye` a few lines up is
  // one of them too). The TOKEN is typed out because the recognizer compares it
  // with `===`; the PREFIX still ranges over a Set, which is what keeps a NEW
  // package manager or Python manager probed here for free.
  //
  // `tokens[1] === 'test'` is the most bug-dense position in the whole gate —
  // rounds 1b and 3 found `test:e2e`, `test+e2e`, `test-ci` and `test.unit` at
  // it — so it is the last slot that should have been reached by no data-driven
  // arm. `cargo test-pwn` was probed while `pnpm test-pwn` was not.
  for (const head of PACKAGE_MANAGER_HEAD) {
    probe(head, 'test');
    probe(head, 't');
  }
  // `-m` after python / python3 (the module after it is already derived above).
  for (const head of PYTHON_HEAD) probe(head, '-m', 'pytest');
  for (const manager of PYTHON_MANAGER_HEAD) {
    // The `run` VERB, which recognizeEvidenceHead and recognizeLintHead spell
    // SEPARATELY: a boundary regression in one is invisible to a row that
    // exercises the other, so the verb gets one row per recognizer, told apart
    // by whether the tail is a test runner or a linter.
    probe(manager, 'run', 'pytest');
    probe(manager, 'run', 'mypy');
    // `pytest` after `<pymgr> run` ...
    probe(`${manager} run`, 'pytest');
    // ... and every slot of the longer `<pymgr> run python -m <module>` form,
    // whose module Set is the same one probed above but behind a prefix no
    // derived row reaches.
    for (const pyHead of PYTHON_HEAD) {
      probe(`${manager} run`, pyHead, '-m pytest');
      probe(`${manager} run ${pyHead}`, '-m', 'pytest');
      for (const module of PYTHON_TEST_MODULE) probe(`${manager} run ${pyHead} -m`, module);
    }
  }
  return Object.freeze(rows);
}

export const EVIDENCE_SECOND_POSITION_PROBES = secondPositionProbes();

// How many leading tokens the recognized evidence head phrase consumes, or 0
// when the token vector does not begin with one. Every comparison is `===` or
// Set membership on a COMPLETE token, so `<head>-pwn`, `<head>.pwn`,
// `<head>:pwn`, `test:e2e`, `test+e2e` and `t"ypecheck"` (already dead at the
// metacharacter refusal) are all simply not the head.
function recognizeEvidenceHead(tokens) {
  const [head, second, third, fourth, fifth] = tokens;
  if (PACKAGE_MANAGER_HEAD.has(head)) {
    // The bare arm is a COMPLETE token: `tokens[1]` must be exactly `test` or
    // `t`. That single equality is round 1b's fix and round 3's `test+e2e` fix
    // with no separator class left in it. A lookahead like `(?![\w:@./-])` is
    // another separator class and is precisely the construct that produced
    // round 3.
    if (second === 'test' || second === 't') return 2;
    // `run <script>` consumes the script name; WHICH names are admitted is the
    // role-aware tier decision below, not a head-table question.
    if (second === 'run' && typeof third === 'string') return 3;
    if (head !== 'npm' && PACKAGE_MANAGER_RUNNER.has(second)) return 2;
    return 0;
  }
  if (head === 'npx') return PACKAGE_MANAGER_RUNNER.has(second) ? 2 : 0;
  if (BARE_TEST_RUNNER.has(head)) return 1;
  if (head === 'node') return NODE_EVIDENCE_FLAG.has(second) ? 2 : 0;
  if (PYTHON_HEAD.has(head)) {
    return second === '-m' && PYTHON_TEST_MODULE.has(third) ? 3 : 0;
  }
  if (PYTHON_MANAGER_HEAD.has(head)) {
    if (second === 'run') {
      if (third === 'pytest') return 3;
      if (PYTHON_HEAD.has(third) && fourth === '-m' && PYTHON_TEST_MODULE.has(fifth)) return 5;
      return 0;
    }
    return PYTHON_MANAGER_TEST_HEAD.has(head) && second === 'test' ? 2 : 0;
  }
  if (head === 'tox') return 1;
  if (head === 'go' || head === 'cargo') return second === 'test' ? 2 : 0;
  if (head === 'git') return GIT_EVIDENCE_VERB_TOKEN.has(second) ? 2 : 0;
  if (INSPECTION_BUILTIN.has(head)) return 1;
  // `env` is a process launcher, not an inspection command: only the BARE form
  // (no operands at all) is recognized, exactly as the shape regex's `env\s*$`
  // arm intends.
  if (head === 'env') return tokens.length === 1 ? 1 : 0;
  return 0;
}

// The LINT head phrase, same exact-token discipline: an optional invocation
// prefix ({uv,poetry,pdm,hatch,rye,pipenv,pixi} + `run` | `npx` |
// {pnpm,yarn,bun} + optional {exec,x}), then an EXACT linter name, and for
// `ruff` an exact subcommand. The tail vetting (lintCommandMutates,
// lintArgsSafe, LINT_SAFE_FLAG and the token sets beside them) now reads the
// SAME token vector this returns a length into — see the round-5 note there.
function recognizeLintHead(tokens) {
  const head = tokens[0];
  let index = 0;
  if (PYTHON_MANAGER_HEAD.has(head) && tokens[1] === 'run') index = 2;
  else if (head === 'npx') index = 1;
  else if (head === 'pnpm' || head === 'yarn' || head === 'bun') {
    index = LINT_EXEC_PREFIX.has(tokens[1]) ? 2 : 1;
  }
  const tool = tokens[index];
  if (!LINT_TOOL.has(tool)) return 0;
  if (tool === 'ruff') {
    return RUFF_EVIDENCE_VERB.has(tokens[index + 1]) ? index + 2 : 0;
  }
  return index + 1;
}
// `--output`/`--output-directory` in spaced or `=` form, and any single-dash
// `-o…` (covers sticky `-o<path>`). `--oneline` starts `--o`, not `-o`, so it
// stays allowed; `-O<orderfile>` is git's read-only order-file option and the
// cosmetic `--output-indicator-*` flags do not write, so both stay allowed.
// `git ls-files -o` (untracked listing) is an accepted over-block: `git
// status --porcelain` answers the same question inside the allowlist.
const GIT_OUTPUT_FLAG = /^(?:--output(?:=.*)?|--output-directory(?:=.*)?|-o.*)$/;
// Mutating long options for `git branch`. `--set-upstream-to=<ref>` and
// `--unset-upstream` mutate ref config with no operand, so prefix-matching
// is required, not just exact tokens.
const GIT_BRANCH_MUTATING_OPTION = /^--(?:delete|force|move|copy|track|edit-description|unset-upstream(?:=.*)?|set-upstream-to(?:=.*)?)$/;
// Single-dash `git branch` tokens are grouped short flags with optional
// sticky args (`-dr origin/x`, `-vuorigin/main`), so any mutating letter
// anywhere in the token denies it: d/D delete, f force, m/M move, c/C copy,
// u set-upstream, t track. The listing letters (-a -r -v -vv -l -i -q) stay
// allowed.
const GIT_BRANCH_MUTATING_SHORT = /^-[^-]*[dDfmMcCut]/;

// The recognized read-only git verbs carry no flag allowlist in the shape
// regex, and two argument families turn them into writers: `--output`
// (`git diff --output=<path>` writes attacker-shaped bytes to ANY path,
// including .ape/runtime/, which the tree-sha drift guard deliberately
// excludes) and `git branch` mutations (`-D`, `-f`, `-m`, an operand creating
// a branch). Mirror of the lintArgsSafe posture: vet the tail before the
// evidence allow. Non-git evidence returns true — its own shape regex plus
// SHELL_WRITE/COMMAND_CHAIN gate the tail.
//
// TAKES THE FULL TOKEN VECTOR — parsed.tokens, head included — and slices the
// `git <verb>` phrase off inside. It is NOT handed a pre-sliced tail: the
// non-git-returns-true contract is decided FROM the head (`--output=x` is
// refused only under a recognized `git <verb>` phrase; every other head is
// gated by its own recognizer and its own tail rules), so a caller that sliced
// first would hand this `['--output=x']` for `npx vitest --output=x` and could
// not preserve it.
//
// ROUND 5, SITE 3 — WHY THIS READS parsed.tokens AND NOT THE RAW STRING. It
// used to re-split the raw post-cd remainder with its own `^\s*git\s+(verb)`
// regex: the same shape that, at the LINT tail, admitted `black . # --check`
// (the gate saw a `--check` the shell never received, so the formatter ran
// WITHOUT it and rewrote the tree from a read-only ticket). It was SAFE here
// because it is reachable only after parseEvidenceCommand already succeeded on
// the same string — at which point the remainder carries no metacharacter and
// no whitespace but U+0020, so the raw split was token-for-token identical to
// parsed.tokens — and because BOTH its rules are MONOTONE in the safe
// direction: the output-flag arm denies on PRESENCE (a gate-superset can only
// over-deny) and the branch arm requires EVERY token to be non-mutating
// (holding on a superset implies holding on any prefix the shell executes).
//
// THE CONSTRAINT THAT REPLACES THAT ARGUMENT, and it survives the conversion:
// every rule this function carries must remain MONOTONE — deny-on-presence, or
// require-of-all. An ADMISSION-ON-PRESENCE rule ("admit `git branch` only when
// `--list` is present") is what made `black . # --check` a live in-place write
// channel, and it is exactly the shape that must not be added here. Reading the
// same vector the head recognizer read removes the raw-string half of that
// hazard structurally; the monotonicity requirement is the half a future rule
// can still violate.
export function gitEvidenceArgsSafe(tokens) {
  const verb = tokens?.[0] === 'git' ? tokens[1] : undefined;
  if (!GIT_EVIDENCE_VERB_TOKEN.has(verb)) return true;
  const tail = tokens.slice(2);
  if (tail.some((token) => GIT_OUTPUT_FLAG.test(token))) return false;
  if (verb === 'branch') {
    // Listing forms only: every token must be a flag (a bare operand is a
    // branch creation or a mutation target) outside the mutating families.
    // `git branch --contains <sha>` is an accepted over-block; `--list`,
    // `-a`, `-vv`, `--show-current`, `--format=…`, `--sort=…` remain.
    return tail.every(
      (token) =>
        token.startsWith('-') &&
        !GIT_BRANCH_MUTATING_OPTION.test(token) &&
        !GIT_BRANCH_MUTATING_SHORT.test(token),
    );
  }
  return true;
}
// Read-only lint/typecheck evidence. A stage whose gate requires lint evidence
// must be able to produce it, so the recognized linters (ruff check / ruff
// format --check, flake8, mypy, pylint, black --check, isort --check/
// --check-only, eslint, prettier --check) are admitted in check-only form —
// bare, through the Python manager `run` wrappers, or through npx / pnpm /
// yarn / bun exec — plus a bare `--version` probe for each. Admission is
// two-step so each half stays reviewable: recognizeLintHead (above) matches
// only the invocation shape — by EXACT TOKEN EQUALITY since this run, because
// the previous `^\s*(...)` regex carried the same unanchored word-boundary
// defect as the evidence shape and `yarn mypy-x` is an arbitrary declared
// script, not a typo — then lintCommandMutates denies any mutating flag
// (--fix, --unsafe-fixes, --fix-only, --write, -w, --in-place) and, for the
// formatters (black, isort, prettier, ruff format), the absence of an explicit
// check-mode flag. SHELL_WRITE is still consulted afterwards, so redirects
// stay denied.
//
// ROUND 5, SITE 2 — WHY THE TAIL IS READ FROM parsed.tokens AND NOT FROM THE
// RAW STRING. This vetting used three unanchored regexes over the command TEXT,
// so the gate and the tokenizer could disagree about what the tokens even are:
// `black . # --check` matched LINT_CHECK_MODE, cleared the formatter, and was
// ALLOWED — while the shell commented `# --check` out and ran `black .`,
// rewriting every matching file in place. That is an unproven production write
// (invariant 2) from a read-only ticket, attributed to nobody, and it is the
// ANTI-MONOTONE half of the truncation defect: admission was CONDITIONAL ON THE
// PRESENCE of a token the shell never receives. Refusing `#` closes that known
// instance; reading the tail from the SAME token vector the head recognizer
// used closes the disagreement structurally, so no future character can split
// the two views again. Membership is exact-token, which is not a widening: a
// suffixed spelling (`--fix=1`, `--check=x`) is a `-`-leading token outside
// LINT_SAFE_FLAG, and lintArgsSafe — an allowlist — refuses it anyway.
const LINT_MUTATING_TOKEN = new Set([
  '--fix', '--unsafe-fixes', '--fix-only', '--write', '-w', '--in-place',
]);
const LINT_CHECK_MODE_TOKEN = new Set(['--check', '--check-only']);
// The in-place rewriters. `ruff` is a formatter only under its `format`
// subcommand (`ruff check` is read-only), so it is decided positionally below
// rather than by name.
const LINT_FORMATTER_TOOL = new Set(['black', 'isort', 'prettier']);
// Shell control operators that turn a recognized leading evidence/lint command
// into a launcher for a second, unvetted command: chaining (; && || |),
// command/parameter substitution (`...`, $(...), ${...}), and redirects
// (< >, including the no-space `cmd>file` form SHELL_WRITE's whitespace-
// anchored pattern misses). One occurrence fails the whole line closed — the
// allowlisted head is only trustworthy when it is the ENTIRE command.
const COMMAND_CHAIN = /[\n;|&`<>]|\$[({]/;
// A recognized evidence/lint command is sometimes reachable only from a
// subdirectory (a monorepo package, a nested test root), and the natural
// `cd <dir> && <test runner>` tripped COMMAND_CHAIN's `&` and failed closed —
// a silent, cross-role trap (a bound role that used `cd` was denied a command
// its sibling role ran bare). Admit EXACTLY a leading `cd <path> &&` prefix and
// re-gate the tail: the path must be a single token drawn from a STRICTLY
// SMALLER POSITIVE ALPHABET than every other token — EVIDENCE_TOKEN_CHAR_REFUSED's
// members MINUS `~` and `^` (the target-alphabet note below says why), spelled
// out here because this class runs BEFORE the alphabet check can see the two
// halves separately — which rejects substitution, quoting, globbing,
// redirects and a second operator inside the path by construction rather than by
// enumeration, and the captured remainder is then run back through the same
// gate below: EVIDENCE_COMMAND plus the git tail vetter for the evidence half,
// recognizeLintHead + lintCommandMutates + lintArgsSafe for the lint half
// (which reads parsed.tokens, not the raw remainder — LINT_COMMAND, the regex
// this comment used to name, was deleted with the round-5 conversion), and
// SHELL_WRITE / COMMAND_CHAIN over both. `cd` carries no write power of its
// own — it only relocates a command that must still be a recognized
// non-mutating one — so this widens *where* evidence runs, not *what* may run.
// The `s` flag is load-bearing: without it `.+` would stop at a newline and a
// second line (`cd x && pytest\nrm -rf .`) would be excluded from the remainder
// and silently pass; with it the remainder captures the newline and
// COMMAND_CHAIN denies it. Only one prefix is stripped — `cd a && cd b && ...`
// leaves `cd b && ...` as the remainder, which is not a recognized command and
// fails closed.
//
// ROUND 5, SITE 1, AND WHY ONE PREDICATE NOW ANSWERS FOR BOTH HALVES. This class
// was once the ONLY thing vetting the cd target: `&&` is itself outside the
// alphabet, so the character check can only ever be applied to the two halves
// SEPARATELY, and the two drifted apart. While `#` was admitted here,
// `cd # && npm test` parsed as {cdTarget:'#', tokens:['npm','test']} and `#`
// read as a relative, dotdot-free operand that needs no root, so NEITHER the
// lexical containment check NOR the realpath precompute ever resolved it —
// while the shell commented out `# && npm test` and ran BARE `cd`, relocating
// the persistent session shell to $HOME. That is the anti-monotone half of the
// truncation defect: dropping a token turned a relocation the gate can see into
// one it cannot. parseEvidenceCommand therefore runs the captured target through
// the SAME EVIDENCE_TOKEN_CHAR_REFUSED / NON_ASCII_HAZARD /
// EVIDENCE_EXPANSION_POSITION predicate as every other token, so the two halves
// can never again disagree about a character or a position. The class here is
// the primary vet and the parser's checks are the structural backstop: the
// hazard categories are caught ONLY there, since this class admits the whole
// non-ASCII range, and so are the `=` expansion positions — `cd =x && npm test`,
// `cd a==b && npm test`, `cd a:=b && npm test` — since a character class cannot
// express a position. `cd ~ && npm test` and `cd ^x && npm test` are caught by
// BOTH now: `~` and `^` left this class entirely (next paragraph), so the
// position rule is their SECOND refusal rather than their only one.
//
// THE `cd` TARGET ANSWERS TO A STRICTLY SMALLER ALPHABET THAN EVERY OTHER TOKEN,
// and the difference is exactly `~` and `^`. Both stay admitted MID-TOKEN in an
// ordinary operand — `git log HEAD~3` and `git log HEAD^` are pinned inventory
// rows — and both are refused ANYWHERE in a relocation target, because under
// `setopt extended_glob` they are PATTERN operators inside a path: the gate would
// resolve the LITERAL target while the shell resolved a GLOB. That divergence is
// residual R3's shape at the ONE operand where it needs no second step — a `cd`
// target relocates the WHOLE execution in a single admitted command — so the
// unconditional cd-target realpath precompute in bin/ape-hook.mjs would be
// resolving a different path from the one the shell enters.
//
// NARROWING THE PRIMARY VET CANNOT REOPEN ROUND 5, SITE 1, and the DIRECTION is
// the whole argument. Site 1 was this class being LOOSER than the remainder
// check, so the two halves disagreed about `#`. STRICTER is safe by
// construction: with `~`/`^` gone, `cd a~b && npm test` no longer matches
// LEADING_CD at all, so no prefix is stripped, the WHOLE string faces
// EVIDENCE_TOKEN_CHAR_REFUSED, `&` is outside that alphabet,
// parseEvidenceCommand returns null and the command DENIES. Fail-closed, not
// fall-through.
//
// MEASURED OVER-BLOCK COST: ZERO. No allow arm in any suite, no
// CHARACTER_INVENTORY row and no ALLOW_CORPUS entry carries `~` or `^` in a `cd`
// target. NAMED PRICE, so the refusal is a decision rather than an accident: a
// directory whose name contains `~` or `^` cannot be a `cd` target here at all,
// and unlike the leading `-`/`+` refusal there is no `./`-prefixed spelling that
// recovers it. Under `extended_glob` the exposure this buys back is BOUNDED
// rather than closed everywhere — `~`/`^` still carry pattern meaning mid-token
// in ORDINARY operands, which is published residual R8 in docs/hooks.md.
const LEADING_CD = /^\s*cd\s+([A-Za-z0-9\-_.\/:=@,%+\u{80}-\u{10FFFF}]+)\s*&&\s*(.+)$/su;

function stripLeadingCd(command) {
  const match = LEADING_CD.exec(command);
  return match ? match[2] : command;
}
// Read-only lint admission is an allowlist, not a blocklist. After the
// recognized invocation head, the only permitted tokens are these known
// check/probe flags and non-flag path arguments; every other flag is refused.
// That refusal is load-bearing: the code-loading flags (--config, --config-file,
// --rcfile, --load-plugins, --plugin) make a linter execute attacker-authored
// JavaScript/Python as a pure side effect of "linting", and the file-writing
// flags (--output-file, --junit-xml, --output, --add-noqa, plus the mutating
// flags above) rewrite the tree with no proven path. Blocklisting these misses
// the next one; allowlisting fails closed by construction.
const LINT_SAFE_FLAG = new Set([
  '--check', '--check-only', '--version', '--quiet', '-q', '--diff', '--color', '--no-color',
]);

// `tokens` is parsed.tokens (the cd prefix is already stripped by the parser)
// and `lintHead` is how many of them recognizeLintHead consumed, so the tool
// is identified from the RECOGNIZED INVOCATION rather than from a name appearing
// anywhere in the text: `eslint black` lints a file called `black`, it does not
// invoke the formatter.
function lintCommandMutates(tokens, lintHead) {
  if (tokens.some((token) => LINT_MUTATING_TOKEN.has(token))) return true;
  const phrase = tokens.slice(0, lintHead);
  const last = phrase[phrase.length - 1];
  // recognizeLintHead consumes the TOOL as its last token for every linter
  // except `ruff`, where it also consumes the exact subcommand. `check`,
  // `format` and `--version` are not linter names, so "is the last token a
  // linter?" disambiguates the two shapes with no second parse.
  const tool = LINT_TOOL.has(last) ? last : phrase[phrase.length - 2];
  if (!LINT_FORMATTER_TOOL.has(tool) && !(tool === 'ruff' && last === 'format')) return false;
  return (
    !tokens.some((token) => LINT_CHECK_MODE_TOKEN.has(token)) && !tokens.includes('--version')
  );
}

function lintArgsSafe(tokens) {
  return tokens.every((token) => !token.startsWith('-') || LINT_SAFE_FLAG.has(token));
}

export function normalizePath(value, projectDir) {
  if (typeof value !== 'string' || value.length === 0) return null;
  const absolute = path.resolve(projectDir, value);
  const relative = path.relative(projectDir, absolute).replaceAll('\\', '/');
  if (relative.startsWith('../') || relative === '..') return null;
  return relative;
}

// Tokenize a bound-subagent evidence command. Modeled on (and deliberately
// shaped like) the exported parseDeletionCommand: TOTAL and NON-THROWING for
// every input — a non-string, an empty or whitespace-only string, a command
// carrying a refused character — because a throw inside the synchronous policy
// reaches bin/ape-hook.mjs's top-level catch, which while a run is live denies
// EVERY subsequent tool event and bricks the session until dist/ is reverted
// by hand.
//
// Returns `{cdTarget, tokens}` or null. `cdTarget` is null when no leading
// `cd <dir> &&` prefix was stripped. It RE-EXECS the same LEADING_CD the
// policy's stripLeadingCd uses (whose signature is unchanged — it discards the
// target), so the two always agree on where the prefix ends, and the cd TARGET
// reaches the containment predicate through this parser.
//
// Exported because bin/ape-hook.mjs precomputes the realpath-grade operand
// verdict with it — evaluateLifecyclePolicy is synchronous and must stay so —
// and because a tokenizer reachable only through the policy cannot be pinned
// independently of the policy's other refusals.
export function parseEvidenceCommand(command) {
  if (typeof command !== 'string' || command.length === 0) return null;
  // BEFORE trim(): trim() itself strips the exotic whitespace this refuses, so
  // checking afterwards would silently admit a leading U+00A0.
  if (EVIDENCE_NON_SPACE_WHITESPACE.test(command)) return null;
  const relocation = LEADING_CD.exec(command);
  const cdTarget = relocation ? relocation[1] : null;
  const remainder = relocation ? relocation[2] : command;
  if (EVIDENCE_TOKEN_CHAR_REFUSED.test(remainder) || NON_ASCII_HAZARD.test(remainder)) return null;
  // THE CD TARGET FACES THE SAME PREDICATE AS THE REMAINDER — alphabet, hazard
  // categories AND expansion position — so a character or a position closed on
  // one side of the `&&` can never again be open on the other (round 5, site 1).
  // It cannot be ONE check over the whole command: `&&` is itself outside the
  // alphabet, so the check is only ever applicable to the two halves separately.
  // LEADING_CD's own class is the primary vet, and this is the structural
  // backstop that keeps the two in agreement — the hazard categories are caught
  // HERE and nowhere else (that class admits the whole non-ASCII range), and so
  // are the `=` expansion positions (`^=`, `==`, `:=`), which no character class
  // can express. The `~` and `^` positions are DOUBLY covered since that class
  // dropped both characters: a target carrying one never reaches this check,
  // because LEADING_CD then fails to match and the whole command falls to the
  // remainder alphabet, where `&&` is refused. Keeping them in this predicate
  // costs nothing and keeps ONE predicate answering for both halves.
  if (
    cdTarget !== null &&
    (EVIDENCE_TOKEN_CHAR_REFUSED.test(cdTarget) ||
      NON_ASCII_HAZARD.test(cdTarget) ||
      EVIDENCE_EXPANSION_POSITION.test(cdTarget))
  ) {
    return null;
  }
  const tokens = remainder.trim().split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return null;
  // The expansion positions (see the note above the head tables): `~`, `=` or
  // `^` at token start, and BOTH `~` and `=` straight after `=` or `:`.
  for (const token of tokens) {
    if (EVIDENCE_EXPANSION_POSITION.test(token)) return null;
  }
  return { cdTarget, tokens };
}

const EVIDENCE_PATH_SEPARATOR = /[/\\]/;

function hasDotDotSegment(value) {
  return value.split(EVIDENCE_PATH_SEPARATOR).includes('..');
}

// The two triggers of containment: a candidate needs a project ROOT to be
// judged only when it is ABSOLUTE or carries a `..` SEGMENT. Everything else
// is either not a path at all (`test`, `HEAD`, `--silent`, `4f5e65d1`) or a
// relative, dotdot-free path, which is contained lexically. Exported so the
// hook's realpath-grade precompute and this synchronous policy agree exactly
// on which operands need resolving — and so the residual is legible: a
// relative dotdot-free token is judged LEXICALLY on both sides, which is
// published residual R3 (an in-tree symlink pointing outside is admitted).
export function evidenceOperandNeedsRoot(value) {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    (path.isAbsolute(value) || value.startsWith('/') || hasDotDotSegment(value))
  );
}

// The path-shaped substrings hiding inside ONE token. This is the whole of
// "do not match the flag — refuse its operand": nothing here names a flag, so
// there is no spelling to under-enumerate and nopt's prefix expansion
// (`--prefi` IS `--prefix`) and short-flag clustering (`-rC /tmp` IS
// `-r -C /tmp`) need no modeling at all.
//
//   * the `=`-suffix of any token (`--cwd=/tmp`, `--pre=/other/repo`);
//   * for a token that BEGINS with `-`, the substring from its first path
//     separator or first `..` — a stuck-on operand (`-C/other/repo` is ONE
//     token, so resolving it whole against the root yields `<root>/-C/other/
//     repo`, which is INSIDE and would be wrongly admitted);
//   * otherwise the whole token.
//
// A `-`-leading token with no separator and no `..` names no path, which is
// why the ordinary reporter/verbosity tails (`--silent`, `-q`, `--coverage`,
// `--`) cost nothing. ACCEPTED OVER-BLOCK: a `-`-leading token that carries a
// relative path after an `=` (`--config=./x.mjs`) yields BOTH candidates, and
// the stuck-on one reads as absolute, so the `=` spelling of an in-tree path
// operand is refused while the spaced spelling (`--config ./x.mjs`) is
// admitted. Keeping the rule spelling-free is worth that; see docs/hooks.md.
export function evidenceOperandCandidates(token) {
  if (typeof token !== 'string' || token.length === 0) return [];
  const candidates = [];
  const equals = token.indexOf('=');
  if (equals >= 0 && equals + 1 < token.length) candidates.push(token.slice(equals + 1));
  if (token.startsWith('-')) {
    const separator = token.search(EVIDENCE_PATH_SEPARATOR);
    const dotdot = token.indexOf('..');
    const stuck = [separator, dotdot].filter((index) => index > 0).sort((a, b) => a - b)[0];
    if (stuck !== undefined) candidates.push(token.slice(stuck));
  } else {
    candidates.push(token);
  }
  return candidates;
}

// Does this candidate path escape the governed project?
//
// TWO-TRIGGER CONTAINMENT. A candidate needs a ROOT only when it is absolute
// or carries a `..` SEGMENT; a relative, dotdot-free candidate is contained
// lexically and needs no root at all. That shortcut is what keeps the ~20
// pre-existing allow arms that pass no project_dir green — and it is SOUND
// only because the session cwd is separately proven inside the root
// (event.evidence.cwd_safe): with cwd at /other/repo a relative dotdot-free
// token resolves OUTSIDE. The cwd check is therefore a PRECONDITION of this
// shortcut, not defense in depth.
//
// The `..` comparison is SEGMENT-WISE (split, then compare whole segments —
// normalizePath does the same with path.relative), NEVER a `..` substring
// test: `go test ./...` is Go's own idiom and a substring test breaks it, at
// which point the sloppy check becomes the next bypass.
export function evidenceOperandEscapes(value, projectDir) {
  if (!evidenceOperandNeedsRoot(value)) return false;
  // Needs a root and has none: fail closed.
  if (typeof projectDir !== 'string' || projectDir.length === 0) return true;
  return normalizePath(value, projectDir) === null;
}

// Every operand of the command — the cd target and every token — must stay
// inside the governed project. Returns the first escaping candidate so the
// deny reason can name the PATH rather than the flag.
function evidenceContainment(parsed, projectDir) {
  const { cdTarget, tokens } = parsed;
  if (cdTarget !== null) {
    // A cd target is unconditionally a path operand, so it gets no `-`-leading
    // exemption: `cd -` (the previous directory) names a location the gate
    // cannot see and is refused with it.
    //
    // `+` IS REFUSED WITH `-`, AND THE ASYMMETRY WAS A REVIEW FINDING OF THIS
    // PHASE (raised by the review and the security review, both here). zsh's
    // `cd` has a THIRD FORM, `cd {+|-}n`, which "extracts an entry from the
    // directory stack, and changes to that directory" — `+n` counts from the
    // left of `dirs`, `-n` from the right, and PUSHD_MINUS SWAPS the two
    // spellings, so refusing one and admitting the other refuses nothing at all.
    // `+1` is relative and dotdot-free, so the lexical check passes and the
    // unconditional `cd` realpath precompute in bin/ape-hook.mjs resolves
    // `<sessionCwd>/+1`, which nearestExistingPath walks up to a directory
    // INSIDE the root — ALLOW, while the shell relocates to a stack entry the
    // gate never saw. The stack has to be non-empty for the form to resolve at
    // all (AUTO_PUSHD, or an explicit `pushd` in the operator's profile, is what
    // fills it), so this is OPERATOR-CONFIGURABLE and PRE-EXISTING — but `+` is
    // now an ENUMERATED member of the evidence alphabet, so admitting it as a
    // relocation target would be a decision rather than an oversight.
    // NAMED OVER-BLOCK COST: a directory whose name begins with `+` or `-`
    // cannot be a `cd` target here. `cd ./+build && npm test` still works.
    if (
      cdTarget.startsWith('-') ||
      cdTarget.startsWith('+') ||
      evidenceOperandEscapes(cdTarget, projectDir)
    ) {
      return { safe: false, operand: cdTarget };
    }
  }
  for (const token of tokens) {
    for (const candidate of evidenceOperandCandidates(token)) {
      if (evidenceOperandEscapes(candidate, projectDir)) return { safe: false, operand: candidate };
    }
  }
  return { safe: true, operand: null };
}

// ---------------------------------------------------------------------------
// Role-aware `<pm> run <script>` tier (roadmap entry
// evidence-command-npm-run-arbitrary-script).
//
// `<pm> run <script>` used to accept ANY package.json script name, which
// bypassed all three structural defenses at once — SHELL_WRITE, COMMAND_CHAIN
// and the inline-interpreter denial — because the script BODY is not part of
// the command line the gate reads. In this repository `npm run validate`
// executes code wholly OUTSIDE the tree, where the drift guard and
// receipt-time diff recomputation have no reach; and package.json is an
// ordinary claimable production file, so an implementer stage can DEFINE a
// script and hand every later read-only stage of the same run an
// arbitrary-command primitive. Raised by the security review of
// run-fixture-b1453c43be4d (receipt f9410f36, acme PR #367); DEMONSTRATED by
// the read-only plan checker of run-fixture-0d04382162e5, which ran
// `npm run bundle --dry-run` as a permission probe — npm ignores --dry-run for
// run-scripts, so a real build executed from a read-only ticket.
//
// Two tiers, selected FAIL-CLOSED on `ticket.writable === true`:
//   WRITABLE  keeps today's full breadth, explicitly dispositioned — the build
//             stage must be able to run `npm run bundle` to regenerate dist/
//             after any lib/runtime change, or the pipeline cannot complete.
//   READ-ONLY admits only OPERATOR-DECLARED names: the floor {'test'}, UNION
//             the names derived from the project's own configured commands,
//             UNION the explicit `policy.evidence_scripts` lever.
// Membership is EXACT STRING equality against a Set, never a composed regex
// alternation: an operator entry of `.*` or `test|validate` must admit nothing
// beyond those literal names, which no package.json defines.
//
// HOST-NEUTRAL BY CONSTRUCTION (invariant 6): a hardcoded literal list would
// bake this repository's script names into the runtime, so the allowlist
// follows what the operator already declared for THIS project.
//
// SYNCHRONY IS LOAD-BEARING. evaluateLifecyclePolicy must stay SYNCHRONOUS:
// bin/ape-hook.mjs consumes its return value with no await, so an async policy
// would yield a Promise whose `.decision` is undefined and formatHookResponse
// would emit `deny` for EVERY PreToolUse — a silent total lockout. Hence
// readFileSync, read LAZILY (only once the run-script arm matched on a
// read-only ticket) and resolved from event.project_dir, never process.cwd().
// ---------------------------------------------------------------------------
// The DERIVATION grammar, and ONLY that: it reads the script name out of an
// operator-authored CONFIG STRING, an input that never passes through a shell,
// so an anchored regex is correct there. It is deliberately NOT the matcher
// for the command being gated — that is token indexing above, because a regex
// over a shell-de-escapable string is the L1 defect.
//
// Anchoring is required on the config side: an unanchored scan mis-parses the
// real values stored in these slots (`{paths}` templates, bare flag fragments,
// `npx`/`pytest` heads), so a configured command with its own `cd` prefix, a
// `--` separator or a multi-word head yields NOTHING and silently narrows the
// operator's own allowlist (documented in docs/hooks.md).
const RUN_SCRIPT_INVOCATION = /^\s*(?:npm|pnpm|yarn|bun)\s+run\s+([\w:@./-]+)/;
// The name grammar every declared name passes through before it can join the
// admitted set. A declared entry outside it (`.*`, `test|validate`) could never
// equal a real script name, so it is dropped rather than carried into the
// deny-reason enumeration. A LEADING `-` is excluded — mirrored by
// EVIDENCE_SCRIPT_NAME in config.js — so an operator cannot declare a FLAG as a
// script name: `npm run --silent validate` has npm consume `--silent` as config
// and run a different, never-checked script.
const RUN_SCRIPT_NAME = /^[\w:@./][\w:@./-]*$/;
// Host-neutral floor: `run test` is admitted with no configuration at all, so
// failing closed never strands a role that has no config to read.
const EVIDENCE_SCRIPT_FLOOR = Object.freeze(['test']);
// Bounds on the deny-reason enumeration so a large declared list cannot blow
// up a hook response. DENY_REASON_MAX_TOKEN bounds the echoed-back operator
// tokens (the refused script name, the cd target, the refused operand) for the
// same reason: they come from the command line, which is not otherwise
// length-limited.
const DENY_REASON_MAX_SCRIPTS = 12;
const DENY_REASON_MAX_CHARS = 240;
const DENY_REASON_MAX_TOKEN = 80;

function boundedToken(value, max = DENY_REASON_MAX_TOKEN) {
  const text = typeof value === 'string' ? value : String(value ?? '');
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

function collectRunScriptNames(slots, names) {
  if (!slots || typeof slots !== 'object' || Array.isArray(slots)) return;
  for (const value of Object.values(slots)) {
    if (typeof value !== 'string') continue;
    const match = RUN_SCRIPT_INVOCATION.exec(value);
    // Same name filter the explicit lever uses, so a configured `npm run
    // --silent spec` contributes a flag to nobody's allowlist.
    if (match && RUN_SCRIPT_NAME.test(match[1])) names.add(match[1]);
  }
}

// Synchronously read the governed project's OWN declared script names. Reads
// the raw `.ape/runtime/config.json` overlay rather than the merged config:
// every shipped default here is null/empty, so the overlay is the complete set
// of declarations, and this stays free of the async config loader.
//
// TOTAL try/catch, degrading restrictively to the floor: missing `.ape/`, a
// missing/unreadable/EACCES/EISDIR config, malformed JSON, a non-object root, a
// non-object `policy`, a non-array `policy.evidence_scripts`, non-string
// elements, a non-object `test_commands`, a non-array `runners`. This must
// NEVER throw — see the SYNCHRONY note above.
function declaredRunScripts(projectDir) {
  const names = new Set(EVIDENCE_SCRIPT_FLOOR);
  if (typeof projectDir !== 'string' || projectDir.length === 0) return names;
  try {
    const stored = JSON.parse(readFileSync(runtimePaths(projectDir).config, 'utf8'));
    if (!stored || typeof stored !== 'object' || Array.isArray(stored)) return names;
    // One parser walks BOTH slot families: `runners[].profile` reuses the
    // identical test_commands slot shape (see RUNNERS_ELEMENT_SHAPE).
    collectRunScriptNames(stored.test_commands, names);
    if (Array.isArray(stored.runners)) {
      for (const runner of stored.runners) {
        if (runner && typeof runner === 'object' && !Array.isArray(runner)) {
          collectRunScriptNames(runner.profile, names);
        }
      }
    }
    const policy = stored.policy;
    const declared =
      policy && typeof policy === 'object' && !Array.isArray(policy) ? policy.evidence_scripts : null;
    if (Array.isArray(declared)) {
      for (const entry of declared) {
        if (typeof entry === 'string' && RUN_SCRIPT_NAME.test(entry)) names.add(entry);
      }
    }
  } catch {
    // Unreadable or malformed config is not a declaration: keep the floor.
  }
  return names;
}

function declaredCommandProfiles(projectDir) {
  if (typeof projectDir !== 'string' || projectDir.length === 0) return [];
  try {
    const stored = JSON.parse(readFileSync(runtimePaths(projectDir).config, 'utf8'));
    const profiles = stored?.policy?.command_profiles;
    if (!Array.isArray(profiles)) return [];
    return profiles.filter((profile) =>
      profile &&
      typeof profile === 'object' &&
      !Array.isArray(profile) &&
      typeof profile.id === 'string' &&
      typeof profile.command === 'string' &&
      profile.command.length > 0 &&
      profile.command.length <= 8192 &&
      !/[\r\n\0]/.test(profile.command) &&
      Array.isArray(profile.roles) &&
      profile.roles.every((role) => typeof role === 'string' && role.length > 0) &&
      ['read', 'write', 'execute'].includes(profile.effect));
  } catch {
    return [];
  }
}

function matchingCommandProfile(projectDir, command) {
  return declaredCommandProfiles(projectDir).find((profile) => profile.command === command) ?? null;
}

function renderAdmittedScripts(names) {
  const sorted = [...names].sort();
  const shown = [];
  let used = 0;
  for (const name of sorted) {
    if (shown.length >= DENY_REASON_MAX_SCRIPTS) break;
    // The budget applies to EVERY element including the first, and each name is
    // bounded like the command-derived tokens are: nothing caps a declared
    // name's length (RUN_SCRIPT_NAME and EVIDENCE_SCRIPT_NAME are shape-only,
    // and formatHookResponse bounds no reason), so a single long entry must not
    // be able to push the reason past the budget on its own. boundedToken caps
    // each at 80 chars, so the loop always shows at least one name and the
    // remainder falls through to the `(+N more)` marker.
    const token = boundedToken(name);
    if (used + token.length > DENY_REASON_MAX_CHARS) break;
    shown.push(token);
    used += token.length + 2;
  }
  const omitted = sorted.length - shown.length;
  return omitted > 0 ? `${shown.join(', ')} (+${omitted} more)` : shown.join(', ');
}

function extractPath(input) {
  const toolInput = input.tool_input ?? input.toolInput ?? input.input ?? {};
  return toolInput.file_path ?? toolInput.filePath ?? toolInput.path ?? input.file_path ?? null;
}

// Codex's native apply_patch tool is freeform: the lifecycle payload carries
// the patch document itself, not a synthetic file_path field. Keep the parser
// deliberately narrower than a general diff parser and aligned with the
// apply_patch envelope. Each operation header contributes its source/target;
// a move contributes its destination as an additional governed write. Lines
// in hunk content begin with a diff marker, so they cannot forge one of these
// column-zero headers.
function applyPatchDocuments(toolInput) {
  if (typeof toolInput === 'string') return [toolInput];
  if (!toolInput || typeof toolInput !== 'object') return [];
  const documents = [];
  for (const candidate of [toolInput.input, toolInput.patch]) {
    if (typeof candidate === 'string') documents.push(candidate);
  }
  if (typeof toolInput.command === 'string') {
    documents.push(toolInput.command);
  } else if (Array.isArray(toolInput.command)) {
    for (const candidate of toolInput.command) {
      if (typeof candidate === 'string') documents.push(candidate);
    }
  }
  return documents;
}

export function extractApplyPatchPaths(toolInput) {
  const paths = [];
  const seen = new Set();
  const operationHeader = /^\*\*\* (?:Add|Update|Delete) File: (.+)$/;
  const moveHeader = /^\*\*\* Move to: (.+)$/;
  for (const document of applyPatchDocuments(toolInput)) {
    let insidePatch = false;
    for (const rawLine of document.split('\n')) {
      const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine;
      if (line === '*** Begin Patch') {
        insidePatch = true;
        continue;
      }
      if (line === '*** End Patch') {
        insidePatch = false;
        continue;
      }
      if (!insidePatch) continue;
      const match = operationHeader.exec(line) ?? moveHeader.exec(line);
      const candidate = match?.[1]?.trim();
      if (!candidate || seen.has(candidate)) continue;
      seen.add(candidate);
      paths.push(candidate);
    }
  }
  return paths;
}

function extractPaths(input, toolName) {
  const explicit = extractPath(input);
  if (toolName !== 'apply_patch') {
    return typeof explicit === 'string' && explicit.length > 0 ? [explicit] : [];
  }
  const toolInput = input.tool_input ?? input.toolInput ?? input.input ?? {};
  const derived = extractApplyPatchPaths(toolInput);
  // An adapter-supplied explicit path is a compatibility hint, never authority
  // to hide additional files in the freeform document. Govern their union.
  if (typeof explicit !== 'string' || explicit.length === 0) return derived;
  return [explicit, ...derived.filter((candidate) => candidate !== explicit)];
}

export function normalizeLifecycleEvent(input, env = process.env) {
  // Claude payloads carry `cwd` (the session's *current* dir, which drifts on
  // cd) and no `project_dir`; CLAUDE_PROJECT_DIR names the *launch* dir, which
  // may itself sit below the governed root. Trusting either verbatim made the
  // guard compute a wrong `.ape/runtime` root, find no active run, and fail
  // open — so every hint only seeds the shared `.ape` marker walk: the
  // explicit dir (payload field, then env pin) outranks the drifting cwd, and
  // the stable CODEX_CWD outranks the per-event payload cwd.
  const host = runtimeHost(env);
  const projectDir = resolveGovernedRoot({
    explicitDir: input.project_dir ?? null,
    cwd: input.cwd ?? null,
    env,
    host,
  });
  const toolName = input.tool_name ?? input.toolName ?? input.tool ?? '';
  const toolInput = input.tool_input ?? input.toolInput ?? input.input ?? {};
  const rawTargets = extractPaths(input, toolName);
  const targets = rawTargets.map((raw) => ({
    raw,
    file: normalizePath(raw, projectDir),
    target_path: path.resolve(projectDir, raw),
  }));
  const primaryTarget = targets[0] ?? null;
  const agentIdentity =
    input.agent_id ??
    input.agentId ??
    input.subagent_id ??
    input.subagentId ??
    input.agent_type ??
    input.agentType ??
    null;
  return {
    host,
    event: input.hook_event_name ?? input.hookEventName ?? input.event ?? 'unknown',
    tool_name: toolName,
    external_tool: classifyExternalTool(toolName, toolInput),
    project_dir: projectDir,
    file: primaryTarget?.file ?? null,
    files: targets.map((target) => target.file).filter((file) => file !== null),
    targets,
    // Absolute, unresolved candidate path; null only when the payload carries
    // no path at all. Disambiguates "no path" (file null, target_path null,
    // fails closed) from "path present but lexically outside the project"
    // (file null, target_path non-null, candidate for the out-of-project
    // exemption).
    target_path: primaryTarget?.target_path ?? null,
    agent_identity: agentIdentity,
    is_subagent: Boolean(agentIdentity || input.is_subagent || input.isSubagent),
    ticket_id: input.ticket_id ?? input.ticketId ?? env.APE_TICKET_ID ?? null,
    command: toolInput?.command ?? null,
    raw: input,
  };
}

// ---------------------------------------------------------------------------
// OUT-OF-PROJECT EXECUTION-REDIRECTING CONFIGURATION
// (roadmap entry `readonly-out-of-project-tool-config-write`).
//
// THE DEFECT THIS NARROWS. The out-of-project allow below returns before the
// read-only deny, so a BOUND subagent — read-only roles included — could write
// ANY file outside the governed project. `$HOME/.npmrc` carrying
// `script-shell=<binary>` changes what the admitted `npm test` EXECUTES with no
// token anywhere on the command line, so no command-string check can see it:
// not the evidence allowlist, not the operand containment of acme PR #368. Sources:
// spike run-fixture-e9d0b87e839d receipt c0b04edd finding 2-RESIDUAL R2,
// and security receipt cb0109c4.
//
// WHY THIS IS NOT A REORDER. Moving the out-of-project allow behind the
// read-only deny closes the family in three lines, and that spike REJECTED it:
// the Claude host injects a per-session scratchpad directive telling subagents
// — read-only roles included — to write their temp files OUTSIDE the project,
// so a blanket deny strands every role that obeys it. The refusal is
// TARGET-SHAPED instead: it refuses the out-of-project targets that REDIRECT
// EXECUTION of an already-admitted evidence command and leaves ordinary
// scratchpad writes admitted. Gated on `out_of_project === true`, it is a pure
// NARROWING of that one allow branch: no in-project verdict moves, and nothing
// denied today becomes allowed.
//
// KEYED ON THE FILENAME, CONTENT-BLIND, AND MONOTONE. Deny-on-presence of a
// covered tail is the only shape this gate is allowed to grow (the monotonicity
// constraint stated above `gitEvidenceArgsSafe`): an admission conditional on
// some token being PRESENT is what made `black . # --check` a live in-place
// write channel. Content is never consulted, and it need not be — the rule sees
// exactly the tools whose payload exposes a path and that the host matcher
// fires on. Ordinary write tools use `file_path`/`filePath`/`path`; apply_patch
// additionally derives every path from its freeform operation headers. A
// malformed patch carrying no valid header remains fail-closed.
//
// SEGMENTS, NEVER A STRING SUFFIX. `endsWith('git/config')` also matches every
// `<anything>/.git/config` — denying writes to any out-of-project repository's
// git config — and `legacy-git/config`; `endsWith('.cargo/config.toml')`
// matches `vendor.cargo/config.toml`. (`foonpm/npmrc` is NOT an instance of
// that class and was cited as one here: bare `npmrc` is itself a single-segment
// entry, so it denies under either scheme.) The separator-blocklist class those
// two real examples belong to has bitten this gate four times. The comparison
// is therefore over whole SEGMENTS, and it is LOWERCASED because APFS is
// case-insensitive: `$HOME/.NPMRC` IS `$HOME/.npmrc`.
//
// THE INCLUSION CRITERION, so the table can be argued with rather than guessed
// at, is THREE SUFFICIENT GROUNDS AND NOT ONE — docs/hooks.md publishes all
// three, labelled (A), (B) and (C), and this comment is kept in step with it
// because a divergent copy of a SECURITY inclusion rule is what a future run
// reads when deciding whether a newly-derived file earns a row. The single
// sentence that used to stand alone here published only (A) and then attributed
// the plugin-manifest and shell-startup rows to it, which (A) never reached.
//
// GROUND (A), the original and the widest: an entry earns its place when a head
// this runtime ALREADY ADMITS as evidence reads that file out of an
// out-of-project home and the file can name a program or import a module. (A)
// governs 48 of the 64 rows — every package-manager, git, cargo, go,
// `*customize.py`, linter and runner entry below. That is why `go/env` sits
// beside `.cargo/config.toml` (`go env -w GOFLAGS=-toolexec=/x`, read by the
// admitted `go test`), why `.mypy.ini` and `mypy/config` are in at all
// (`plugins =` imports arbitrary Python into the admitted `mypy`), why
// `pylint`'s rc files and the user-level config of `prettier`, `eslint` and
// `mocha` sit beside them (`load-plugins =`, `plugins`, a flat config that is
// IMPORTED WHOLE and mocha's `require` bring arbitrary code into four heads
// admitted on exactly the same footing, and each of the four reaches a file at
// `$HOME` for a project that ships none — by a DIFFERENT route per head, stated
// one head at a time because the single sweeping version of this sentence was
// false for two of them: `pylint` performs no find-up walk at all, it reads the
// NAMED user-level locations `~/.pylintrc` and `~/.config/pylintrc`;
// `prettier`'s cosmiconfig search starts at the FILE BEING FORMATTED — not at
// the cwd — and walks up to the HOME DIRECTORY
// (prettier.io/docs/configuration), which is the same statement this file makes
// beside prettier's own entries below and the same one docs/hooks.md publishes;
// `mocha` starts at the cwd and `eslint` at the cwd in v9 and at the LINTED
// FILE from v10, and those two are the ones that walk to the FILESYSTEM ROOT.
// Not one of the four has a project-root stop, and the governed project lives
// under the home directory).
//
// GROUND (B) — THE HOST reads it, and it NAMES A PROGRAM THE HOST THEN RUNS.
// The 7 host-agent and plugin rows are in on this, NOT on (A): `.claude.json`,
// `.claude/settings.json`, `.claude/settings.local.json`, `.codex/config.toml`
// and BOTH hosts' plugin manifests. No admitted EVIDENCE head reads a host or
// plugin manifest — the host does — so (A) never reached any of them, and
// attributing them to it (as this comment once did) published a criterion that
// does not hold. The mechanism: the hook file whose contents declare PreToolUse
// hook COMMANDS, or an `mcpServers` entry's `command`; "declares MCP servers by
// `command`" is ONE INSTANCE of (B) rather than the whole of it, since the other
// five name hook COMMANDS, plugin ENABLEMENT or an install manifest instead.
//
// GROUND (C) — IT REDEFINES THE EXECUTION ENVIRONMENT AN ADMITTED HEAD RUNS IN,
// rather than configuring the head. The 9 shell-startup rows are in on this and
// not on (A) either: `.bashrc`, `.bash_profile`, `.bash_login`, `.profile`,
// `.zshrc`, `.zshenv`, `.zprofile`, `.zlogin` and `.envrc`. No admitted evidence
// head READS a shell rc — the shell is the EXECUTOR of an admitted head rather
// than a head itself — and direnv is not an admitted head at all, so `.envrc`
// sits outside (A)'s reach twice over. This ground was RUNNING in the tree
// unpublished: it is the REDEFINE-rather-than-configure pairing already stated
// beside those entries below, and it is why bash's `.bash_login` and zsh's
// `.zlogin` are in beside their covered siblings — bash runs the FIRST EXISTING
// of `.bash_profile`, `.bash_login`, `.profile`, so covering the outer two and
// not the middle one covers nothing on a machine that has only the middle one.
//
// 48 + 7 + 9 = 64, so no row is left with no published ground. Any ONE ground is
// sufficient; none is necessary.
//
// THE TABLE IS AN ENUMERATION, NOT A CONSTRUCTION. Applying the criterion above
// is a judgment call per head, so absence from this table is NOT evidence that a
// file is harmless: what is deliberately NOT covered — the
// `uv`/`poetry`/`pdm`/`hatch`/`rye`/`pipenv`/`pixi` wrappers' user config, never
// audited entry by entry for an execution-naming key; the `prettier` and
// `mocha` KEYS of a `package.json`, because refusing every out-of-project
// `package.json` is an over-block far larger than the hole it closes; eslint's
// LEGACY `.eslintrc.*` family, which ESLint 9 loads only under
// `ESLINT_USE_FLAT_CONFIG=false` and which therefore needs a derivation of its
// own; the FILES a plugin manifest names — the hook file on the Claude side, the
// `mcpServers` `command` on the codex one, each of whose filename the manifest
// itself chooses, WITH ONE FORM EXCEPTED and it is a NARROWING of that clause
// rather than a hole in it: lib/runtime/plugin-validation.js's
// validateCodexPlugin normalizes a STRING `mcpServers` companion and errors
// unless it is exactly `.mcp.json`, so for THAT form the filename is pinned
// rather than chosen. The pin binds APE'S OWN validator and NOT what a host
// loads from a manifest an attacker overwrote, and it reaches nothing else: a
// string `mcpServers` on the CLAUDE side goes through validateComponentPaths
// with NO name pin, and every INLINE `mcpServers` object names its own
// `command` freely — which is the form this tree's own
// `.codex-plugin/plugin.json` actually uses, so the name-pinned string
// companion is a form nothing here ships. A flat "the companion is name-pinned"
// would overstate the tree in the other direction. `.mcp.json` is RECORDED as a
// residual in docs/hooks.md on a REACHABILITY-CLASS ground stated there rather
// than covered by an entry below. The official Claude MCP documentation
// (https://code.claude.com/docs/en/mcp) documents project-root/current-project
// scope and `CLAUDE_PROJECT_DIR` for plugin-provided MCP configuration; neither
// it nor this tree verifies ancestor-walk discovery. The checked-in declaration
// argv proof establishes APE's host-hint precedence, not Claude's discovery
// algorithm. The `pytest` INI FAMILY, which is the
// find-up shape that earned `eslint`, `prettier` and `mocha` their places and
// is UNCOVERED anyway:
// `pytest.toml`, `.pytest.toml`, `pytest.ini`, `.pytest.ini`, `pyproject.toml`,
// `tox.ini` and `setup.cfg` are searched through ANCESTOR directories to the
// filesystem root (docs.pytest.org/en/stable/reference/customize.html),
// `addopts` and `pythonpath` reach execution from any of them, and an ini
// planted at `$HOME` moves rootdir there and pulls a home-level `conftest.py`
// — a module pytest IMPORTS — into scope. It is not an entry appended here:
// four of those eight names are among the most ordinary filenames in a scratch
// directory, so refusing them on a bare segment is the over-block this refusal
// is shaped to avoid, and the family needs a derivation of its own — is named at
// residual R2 in docs/hooks.md.
//
// AND THE PROMISE THAT LIST MAKES IS BOUNDED. This comment used to end "rather
// than left to a generic caveat", which reads as a guarantee that EVERY admitted
// head absent from the table is named in R2. It is not one, and asserting it is
// how this surface over-read its own diff three times running (`eslint`, then
// `mocha`, then `pytest`, each found missing from both the table and the
// residuals while the sentence was being republished as now-true). R2 names what
// has been DERIVED and left out, and separately names `vitest`, `jest`, `ava`,
// `playwright`, `tap`, `tsc`, `node`, `tox`, `ruff`, `flake8`, `black` and
// `isort` as admitted heads whose user-level configuration has never been
// derived at all — unaudited, which is weaker than cleared. Absence from the
// table remains no evidence that a file is harmless.
//
// Every tail shipped here carries an arm in
// __tests__/runtime-v2-readonly-tool-config-write.test.js, and
// that suite checks the correspondence MECHANICALLY and in both directions,
// against these two Sets and against the list docs/hooks.md publishes: an entry
// with no arm can be deleted with every suite green while the docs still publish
// it, which is how an enumeration silently shrinks.
//
// BOTH LOOKUPS ARE REQUIRED, AND NEITHER SUBSUMES THE OTHER. The refusal
// consults the RAW target and the hook's realpath-RESOLVED one, and the two
// catch OPPOSITE symlink layouts. The RAW half is what catches the
// dotfile-manager layout — under stow/chezmoi `$HOME/.cargo` is a symlink INTO a
// managed store, so resolution ERASES the match (the resolved tail is
// `cargo/config.toml`, which no table carries) and only the raw tail matches at
// all. The RESOLVED half catches the mirror layout, where an ordinary-named path
// (`link/config.toml`) resolves ONTO a covered directory. Deleting either lookup
// silently drops a whole layout; both directions carry an end-to-end arm in
// __tests__/runtime-v2-readonly-tool-config-write.test.js, the raw one paired
// with an ADMIT arm on the store path itself so the erasure is a pinned fact.
//
// The enumeration is durable only while no bound channel can CREATE a link or
// rename a path: `ln` is not a recognized evidence head, `SHELL_WRITE` matches
// it on the main-session arm, and no WRITE_TOOL creates links. Both halves
// therefore cover PRE-EXISTING links only, in either direction, and
// never attacker-made ones — and admitting a rename- or link-capable channel
// later silently reopens the whole family. What stays open (PATH shadowing, the
// `BASH_ENV`/`ENV` half, the codex R6 fallthrough, hardlinks and TOCTOU, a
// relocated host config dir, the uncovered heads above) is published by name at
// residual R2 in docs/hooks.md.
const CONFIG_TAIL_SEPARATOR = /[/\\]/;
// The covered FINAL SEGMENT, lowercased.
const EXECUTION_CONFIG_TAIL = new Set([
  // Package-manager and runtime configuration: these CONFIGURE an admitted
  // head. `.npmrc` `script-shell` is the demonstrated instance; bare `npmrc` is
  // npm's own prefix-level spelling of the same file.
  '.npmrc',
  'npmrc',
  '.yarnrc',
  '.yarnrc.yml',
  '.bunfig.toml',
  // Read-only git IS an admitted evidence family, and `core.pager`, aliases and
  // `core.hooksPath` each redirect an admitted `git status`.
  '.gitconfig',
  // Shell startup: these REDEFINE an admitted head rather than configure it.
  // This is the FILE half of that family only — the `BASH_ENV`/`ENV` half is not
  // a file-write channel at all and no filename rule reaches it. The bash trio
  // is listed in bash's OWN order: it runs the first EXISTING of `.bash_profile`,
  // `.bash_login`, `.profile`, so the middle entry is the one that actually runs
  // on a machine without the first — an enumeration that skipped it would be
  // bypassed by the sibling between two covered entries.
  '.bashrc',
  '.bash_profile',
  '.bash_login',
  '.profile',
  '.zshrc',
  '.zshenv',
  '.zprofile',
  '.zlogin',
  // direnv sources this on entering the directory.
  '.envrc',
  // Imported by `site` at interpreter start, the admitted `python -m pytest`
  // included: `sitecustomize` when it lands anywhere on `sys.path`
  // (site-packages, `PYTHONPATH` — NOT a bare `$HOME/sitecustomize.py` for a run
  // started from the project dir), and `usercustomize` from the user site
  // directory whenever user site is enabled, which is the stronger of the two.
  // Both are keyed on the FILENAME, so each is caught wherever out-of-project it
  // lands, including the site directories that make it load.
  'sitecustomize.py',
  'usercustomize.py',
  // `mypy` is an admitted check-only linter head and its config's `plugins =`
  // key IMPORTS ARBITRARY PYTHON. With no config in the project, mypy falls back
  // to `$XDG_CONFIG_HOME/mypy/config`, `~/.config/mypy/config` and this file.
  '.mypy.ini',
  // `pylint` is an admitted check-only head on exactly the same footing, and its
  // `load-plugins =` key imports arbitrary Python the same way. With no config in
  // the project it reads `~/.pylintrc` and `~/.config/pylintrc` (the pair entry
  // below).
  '.pylintrc',
  // `prettier` is an admitted check-only head too, and its cosmiconfig search
  // walks UP from the linted file to `$HOME`, so a user-level config governs a
  // project that ships none. `plugins` imports arbitrary modules in every
  // spelling, and the `.js`/`.mjs`/`.cjs` AND `.ts`/`.mts`/`.cts` forms ARE
  // arbitrary modules. This is EVERY documented search place
  // (prettier.io/docs/configuration) except the `prettier` KEY of a
  // `package.json`, which is deliberately not covered — refusing every
  // out-of-project `package.json` is an over-block far larger than the hole it
  // closes — and that one residual is published rather than implied. Shipping
  // the `.js` trio without the `.ts` trio was a bypass of entries that ARE
  // covered, on the same argument that puts `.cargo/config` beside
  // `.cargo/config.toml`.
  '.prettierrc',
  '.prettierrc.json',
  '.prettierrc.json5',
  '.prettierrc.yml',
  '.prettierrc.yaml',
  '.prettierrc.toml',
  '.prettierrc.js',
  '.prettierrc.mjs',
  '.prettierrc.cjs',
  '.prettierrc.ts',
  '.prettierrc.mts',
  '.prettierrc.cts',
  'prettier.config.js',
  'prettier.config.mjs',
  'prettier.config.cjs',
  'prettier.config.ts',
  'prettier.config.mts',
  'prettier.config.cts',
  // `eslint` is an admitted check-only head on the identical footing to
  // `prettier`, and its FLAT CONFIG is IMPORTED as a module.
  //
  // THE SEARCH ORIGIN, STATED PRECISELY — the previous revision of this comment
  // had it wrong in the direction that flattered the conclusion. ESLint 9
  // searches from the CURRENT WORKING DIRECTORY by default and walks ancestors
  // upward until it finds an `eslint.config.*`; starting from the directory of
  // the FILE BEING LINTED is what the `v10_config_lookup_from_file` feature flag
  // (earlier `unstable_config_lookup_from_file`) opts into, and it is the
  // DEFAULT only from ESLint 10, where the flag itself was removed. The security
  // conclusion is UNCHANGED under either origin, which is why the entries do not
  // move: NEITHER has a project-root stop, both walk up ancestors to the
  // FILESYSTEM ROOT, and the cwd of an evidence command is inside the governed
  // project — which lives under the home directory — so a config planted at
  // `$HOME` governs every project beneath it that ships none. THIS repository
  // ships none, which makes it one of those projects. These six are the whole
  // flat-config search list, cited at the version this paragraph is ABOUT
  // rather than at `latest`, which now documents ESLint 10 and would undercut
  // the v9 DEFAULT sentence it supports (eslint.org/docs/v9.x/use/configure/
  // configuration-files). The LEGACY `.eslintrc.*` family is deliberately NOT
  // here: ESLint 9 does not load it unless `ESLINT_USE_FLAT_CONFIG=false`, so it
  // is a version-gated surface with a derivation of its own, and it is published
  // at residual R2 rather than smuggled in behind this one.
  'eslint.config.js',
  'eslint.config.mjs',
  'eslint.config.cjs',
  'eslint.config.ts',
  'eslint.config.mts',
  'eslint.config.cts',
  // `mocha` is an admitted runner head in TWO positions — bare, and after
  // npx/pnpm/yarn/bun — and it resolves its rc file with exactly the find-up
  // walk that earns `eslint` and `prettier` their places: mocha looks in the cwd
  // and, failing that, searches parent directories until one is found or the
  // FILESYSTEM ROOT is reached (mochajs.org/running/configuring). No
  // project-root stop, so a file at the home directory governs every project
  // below it that ships none, and this repository ships none.
  //
  // ALL SEVEN DOCUMENTED SPELLINGS, in mocha's own priority order, and not only
  // the three that are JavaScript: `.mocharc.cjs`, `.mocharc.js` and
  // `.mocharc.mjs` are MODULES mocha loads, while the YAML and JSON spellings
  // are data that reaches arbitrary execution anyway — an rc file may set ANY
  // command-line option, and `require` names a module loaded before the test
  // files, so `{"require": "<path>"}` in `.mocharc.json` runs arbitrary code
  // exactly as `plugins` does from `.prettierrc.json`. Shipping the module
  // spellings without the data ones would be the trivially equivalent bypass
  // this table already refuses for `.cargo/config` beside `.cargo/config.toml`.
  //
  // NOT here, named rather than left implied: the `mocha` KEY of a
  // `package.json` (the same residual, for the same over-block reason, as
  // prettier's `prettier` key) and the extension-less `.mocharc`, which mocha
  // does not search for at all.
  '.mocharc.cjs',
  '.mocharc.js',
  '.mocharc.mjs',
  '.mocharc.yaml',
  '.mocharc.yml',
  '.mocharc.jsonc',
  '.mocharc.json',
  // HOST-AGENT configuration, named rather than left to a generic "this is an
  // enumeration" caveat: `~/.claude.json` declares MCP servers by `command`.
  '.claude.json',
]);
// The covered FINAL TWO SEGMENTS, lowercased and joined with `/`. A bare
// `config`, `config.toml` or `settings.json` is far too ordinary a scratch
// filename to refuse on its own, so each is keyed on the directory that gives
// it its meaning.
const EXECUTION_CONFIG_TAIL_PAIR = new Set([
  // XDG spellings of files already covered in their dotfile form.
  'npm/npmrc',
  'git/config',
  'mypy/config',
  // cargo still honors the extension-less spelling, so covering only the
  // `.toml` one would leave a trivially equivalent bypass of an entry that IS
  // covered.
  '.cargo/config.toml',
  '.cargo/config',
  // The exact peer of the cargo entries: `go env -w GOFLAGS=-toolexec=/x` writes
  // `os.UserConfigDir()/go/env` (`~/Library/Application Support/go/env`,
  // `$XDG_CONFIG_HOME/go/env`) and the admitted `go test` reads it, so an
  // arbitrary program runs for every tool invocation. Two-segment: a bare `env`
  // is one of the most ordinary scratch filenames there is.
  'go/env',
  // pylint's XDG location, keyed on its directory: a bare `pylintrc` outside a
  // config directory is an ordinary scratch filename, and stays admitted.
  '.config/pylintrc',
  // Host-agent configuration, and the highest-value target on the host this
  // runtime actually runs on: the Claude settings file declares PreToolUse hook
  // COMMANDS — arbitrary execution on every tool call, and the one file that can
  // disable this very gate — and the codex `config.toml` is its peer. Keyed on
  // the DIRECTORY NAME, so a host config dir relocated by `CLAUDE_CONFIG_DIR`
  // (or `CODEX_HOME`) is NOT covered; that residual is published with the rest.
  '.claude/settings.json',
  '.claude/settings.local.json',
  '.codex/config.toml',
  // THE PLUGIN MANIFEST SURFACE, on BOTH hosts, which reaches arbitrary
  // execution through the SAME mechanism that puts `.claude/settings.json` and
  // `~/.claude.json` in this table: a plugin manifest NAMES A PROGRAM the host
  // then runs — the hook file whose contents declare PreToolUse hook COMMANDS,
  // or an `mcpServers` entry's `command`. This repository is registered exactly
  // that way on both: its own `.claude-plugin/plugin.json` carries `"hooks":
  // "./hooks/claude-hooks.json"`, `.claude-plugin/marketplace.json` is the
  // manifest it is installed by, and `.codex-plugin/plugin.json` — shipped in
  // this very tree — declares `mcpServers.ape.command` =
  // `./dist/ape-mcp.bundle.mjs`.
  //
  // The codex manifest is here on the host-agent entries' OWN stated criterion,
  // "declares MCP servers by `command`", which it meets literally. Covering the
  // Claude pair alone was a host-SPECIFIC closure advertised as a host-neutral
  // one, and invariant 6 is why it cannot be dispositioned as a residual: a rule
  // that closes one host's manifest and leaves the other's open is host policy
  // in a host-neutral runtime.
  //
  // The FILES a manifest points at — the hook file, the `command` binary — are
  // arbitrarily NAMED by that manifest, so no enumeration reaches them; the
  // manifests that name them can be enumerated, which is why these three entries
  // are the manifests and not the files they point at. Plugin ENABLEMENT needs
  // no entry of its own: it lives in the already-covered
  // `.claude/settings.json` and `~/.claude.json`.
  //
  // ONE FORM IS EXCEPTED FROM "arbitrarily NAMED", and it is a narrowing of that
  // sentence rather than a hole in it. lib/runtime/plugin-validation.js's
  // validateCodexPlugin normalizes a STRING `mcpServers` companion and errors
  // unless it is exactly `.mcp.json`, so for THAT one form the filename is
  // pinned rather than chosen. The pin binds APE'S OWN validator, not what a
  // host loads from a manifest an attacker overwrote, and it reaches nothing
  // else: a string `mcpServers` on the CLAUDE side goes through
  // validateComponentPaths with NO name pin, and every INLINE `mcpServers`
  // object names its own `command` freely — the form this tree's own
  // `.codex-plugin/plugin.json` uses, so the name-pinned string companion is a
  // form nothing here ships. `.mcp.json` is deliberately NOT an entry below: it
  // is RECORDED as a residual in docs/hooks.md on a REACHABILITY-CLASS ground
  // whose one surviving half is PROJECT SCOPE — a `.mcp.json` at another project
  // ROOT governs THAT project, whereas every row in this table is reachable from
  // the CURRENT one. The SESSION half is NOT part of that ground, and stating it
  // here as one would diverge from docs/hooks.md, which now says why: rows
  // already IN this table pay off on a LATER load — an INSTALL manifest, the
  // hook file a manifest names, plugin ENABLEMENT — so "every row redirects the
  // CURRENT session" is false of the table itself. Official Claude MCP docs at
  // https://code.claude.com/docs/en/mcp document project-root/current-project
  // scope and plugin-provided `CLAUDE_PROJECT_DIR`, not ancestor-walk
  // discovery; the checked-in argv proof likewise establishes APE's hint
  // precedence, not host discovery. That ground is DERIVED, NOT VERIFIED and
  // is labelled so where it is stated in full.
  '.claude-plugin/plugin.json',
  '.claude-plugin/marketplace.json',
  '.codex-plugin/plugin.json',
]);

// LOWERCASING IS CASE MAPPING; A CASE-INSENSITIVE FILESYSTEM RESOLVES BY CASE
// FOLDING, AND THE TWO DISAGREE. `String.prototype.toLowerCase` leaves U+017F
// (LATIN SMALL LETTER LONG S) exactly as it found it, while simple case folding
// maps it onto `s` — so `$HOME/.ba<U+017F>hrc` is a name the segment compare
// below reads as unrelated to `.bashrc` and `open(2)` on a folding filesystem
// resolves to the real file. The premise was verified rather than assumed;
// docs/research/2026-07-29-execution-config-case-folding.md records the method
// and the answer, and __tests__/runtime-v2-execution-config-case-folding.test.js
// re-derives both halves on whatever host runs the suite. The live half is
// CREATE, not overwrite: realpath cannot canonicalize a file that does not exist
// yet, so the resolved lookup rescues nothing there — and a machine with no
// `~/.zlogin` is exactly where planting one wins. U+212A (KELVIN SIGN) is NOT a
// second vector: `toLowerCase` already maps it to `k`.
//
// THE SHAPE IS FOLD-THEN-COMPARE, AS A SECOND ATTEMPT AND NEVER A REPLACEMENT.
// Refusing every segment that merely CONTAINS a non-ASCII character is the fix
// this must not be: an out-of-project scratch file with an accented or CJK name
// is ordinary, and keeping the scratchpad open is this whole refusal's design
// constraint. Matching the same tables a second time under case folding is
// MONOTONE (a second attempt can only ADD denials — the lowercase compare is
// untouched and still runs first, so no segment becomes MORE admissible than it
// is today; the monotonicity constraint stated above `gitEvidenceArgsSafe`),
// SYNCHRONOUS (it consults no filesystem, so `evaluateLifecyclePolicy` stays
// synchronous), TOTAL (it decides every string without throwing), and
// HOST-NEUTRAL (invariant 6): the verdict is a property of the SPELLING, not of
// the filesystem underneath. Probing the host for case-insensitivity would make
// one payload decide differently on darwin and on Linux, which is exactly what
// invariant 6 forbids; the accepted price is that on a case-sensitive filesystem
// this over-blocks a filename nobody legitimately writes.
//
// The folding primitive is a `u`-flagged case-insensitive RegExp, which
// canonicalizes by SIMPLE CASE FOLDING, so no Unicode table of its own is
// needed. The patterns are built ONCE from the tables above, and the fold pass
// runs only for a segment that actually carries a non-ASCII code point — for
// pure ASCII, folding and lowercasing agree by construction, so the common path
// is byte-for-byte the compare it always was.
//
// FULL FOLDING IS THE OTHER HALF, AND A REGEXP DOES NOT REACH IT. Simple folding
// maps one code point onto one; FULL folding maps a handful onto MULTI-CHARACTER
// sequences, and a `u`-flagged RegExp performs the simple mapping only — so
// `.bunﬁg.toml` (U+FB01) and `.gitconﬁg` stayed unrelated strings to the pattern
// above while the filesystem resolved them onto the covered names (observed on
// darwin/APFS by the authored suite, which re-derives it per shipped tail rather
// than trusting this note). The claim that this "cannot bite while no table
// entry contains the expansion" was simply FALSE: every `config` and `profile`
// entry carries `fi`, and `sitecustomize.py`/`usercustomize.py` carry `st`.
//
// The closure is an EXPANSION TABLE consulted before the same pattern match, and
// it is small and CLOSED rather than a normalization pass: of every full-fold
// mapping in CaseFolding.txt, exactly nine expand to pure ASCII — U+00DF and
// U+1E9E onto `ss`, and the seven U+FB00..U+FB06 ligatures. Every other
// multi-character mapping expands to a sequence that is itself non-ASCII (U+0130
// and U+01F0 onto a letter plus a combining mark, U+0149, the U+1E96..U+1E9A
// group, the Greek and Armenian ligatures), so it cannot collide with a table in
// which no entry is non-ASCII — by CONSTRUCTION, not by luck. Expanding is
// MONOTONE for the same reason the RegExp pass is (it is a third attempt, after
// both compares that already ran) and it can never LOSE a match either, since no
// entry contains a ligature for the expansion to destroy. NFKC normalization was
// rejected: it rewrites far more than these nine and would make the gate inspect
// a materially different string from the one the OS receives.
const NON_ASCII_SEGMENT = /\P{ASCII}/u;
const REGEXP_META = /[.*+?^${}()|[\]\\]/g;
const FULL_FOLD_ASCII_EXPANSION = new Map([
  ['ß', 'ss'], // U+00DF LATIN SMALL LETTER SHARP S
  ['ẞ', 'ss'], // U+1E9E LATIN CAPITAL LETTER SHARP S
  ['ﬀ', 'ff'], // U+FB00 LATIN SMALL LIGATURE FF
  ['ﬁ', 'fi'], // U+FB01 LATIN SMALL LIGATURE FI
  ['ﬂ', 'fl'], // U+FB02 LATIN SMALL LIGATURE FL
  ['ﬃ', 'ffi'], // U+FB03 LATIN SMALL LIGATURE FFI
  ['ﬄ', 'ffl'], // U+FB04 LATIN SMALL LIGATURE FFL
  ['ﬅ', 'st'], // U+FB05 LATIN SMALL LIGATURE LONG S T
  ['ﬆ', 'st'], // U+FB06 LATIN SMALL LIGATURE ST
]);
// DERIVED from the Map rather than written out beside it, so the scanner and the
// expansion cannot drift apart and substitute an `undefined`. No key is a RegExp
// metacharacter, so no escaping is required and none is silently skipped.
const FULL_FOLD_ASCII_SOURCE = new RegExp(
  `[${[...FULL_FOLD_ASCII_EXPANSION.keys()].join('')}]`,
  'gu',
);
function expandFullFolds(segment) {
  return segment.replace(
    FULL_FOLD_ASCII_SOURCE,
    (char) => FULL_FOLD_ASCII_EXPANSION.get(char) ?? char,
  );
}
function foldedTailPatterns(table) {
  return [...table].map((entry) => [
    new RegExp(`^${entry.replace(REGEXP_META, '\\$&')}$`, 'iu'),
    entry,
  ]);
}
const EXECUTION_CONFIG_TAIL_FOLDED = foldedTailPatterns(EXECUTION_CONFIG_TAIL);
const EXECUTION_CONFIG_TAIL_PAIR_FOLDED = foldedTailPatterns(EXECUTION_CONFIG_TAIL_PAIR);
// Simple folding first (the RegExp), then the same patterns against the
// full-fold expansion of the same candidate. Two attempts, both additive.
function foldedTailMatch(patterns, candidate) {
  const expanded = expandFullFolds(candidate);
  for (const [pattern, entry] of patterns) {
    if (pattern.test(candidate) || pattern.test(expanded)) return entry;
  }
  return null;
}

// The matched tail, or null. Pure, total and synchronous: it takes an already
// absolute path (the raw `target_path`, or the hook's realpath-resolved one) and
// compares whole lowercased segments against the two tables above, then — only
// for a segment carrying a non-ASCII code point — the same segments again under
// case folding, simple and full. The returned value is always a TABLE ENTRY,
// never caller-supplied text, so a deny reason can interpolate it unbounded and
// a folded spelling never echoes the caller's own bytes back into a hook
// response.
function executionConfigTail(target) {
  if (typeof target !== 'string' || target.length === 0) return null;
  const segments = target.split(CONFIG_TAIL_SEPARATOR).filter((segment) => segment.length > 0);
  if (segments.length === 0) return null;
  const rawLast = segments[segments.length - 1];
  const last = rawLast.toLowerCase();
  if (EXECUTION_CONFIG_TAIL.has(last)) return last;
  const rawPair = segments.length < 2 ? null : `${segments[segments.length - 2]}/${rawLast}`;
  if (rawPair !== null && EXECUTION_CONFIG_TAIL_PAIR.has(rawPair.toLowerCase())) {
    return rawPair.toLowerCase();
  }
  if (NON_ASCII_SEGMENT.test(rawLast)) {
    const folded = foldedTailMatch(EXECUTION_CONFIG_TAIL_FOLDED, rawLast);
    if (folded) return folded;
  }
  if (rawPair !== null && NON_ASCII_SEGMENT.test(rawPair)) {
    return foldedTailMatch(EXECUTION_CONFIG_TAIL_PAIR_FOLDED, rawPair);
  }
  return null;
}

// A sealed terminal run is history on display, not a live governor. Truthful
// completion keeps the completed/aborted state in active.json indefinitely,
// and startRun already treats those statuses as no obstacle — the hook must
// agree, or every main-session write in the project stays denied ("no active
// writing run") from the moment a phase completes until the next run starts.
// Blocked is deliberately NOT sealed: a blocked run holds unresolved tickets
// awaiting remediation or an audited abort/reset, and routing intervention
// through the APE surface is the point of failing closed there. A sealed run
// stands aside for the host, but a subagent still bound to it holds a voided
// capability, so its write-capable tool calls into the project fail closed;
// unbound activity is untouched.

// dispatch-deny-reason-is-non-discriminating (roadmap entry). Switches on the
// SAME plain string literals lib/runtime/claude-dispatch.js's
// resolveClaudeBindingOutcome returns (documented there) — kept as function-
// local literals rather than a shared top-level exported table on EITHER side,
// because both files are already bundled into dist/ape-mcp.bundle.mjs (via
// service.js's imports) as well as dist/ape-hooks.bundle.mjs, and a new
// top-level `Object.freeze(...)`-backed export would ship into the mcp bundle
// too even though nothing reachable from that entry point ever calls this
// function — esbuild's tree shaking removes an unused FUNCTION wholesale
// (this one, exactly like evaluateLifecyclePolicy itself, never appears
// there) but is conservative about a top-level call expression's side
// effects, so an unused frozen object is not guaranteed to be shaken out.
// Every returned sentence is a FIXED, non-interpolated string: no session id,
// agent id, or ticket id is ever named (NO IDENTITY LEAK), and each names
// only its own class of cause so an operator (or a later run copying
// evidence.summary verbatim per prompts/common.md) does not have to guess.
// The historic, non-discriminating sentence stays the FALLBACK: it is what a
// direct evaluateLifecyclePolicy call with no hook-computed cause still gets
// (__tests__/runtime-v2-stop-lifecycle.test.js,
// __tests__/runtime-v2-hook-out-of-project.test.js pin this literal on
// exactly that call shape), and it is also what the live hook path itself
// still reports when even a relaxed filter observes nothing more specific.
function claudeBindingDenialReason(cause) {
  switch (cause) {
    case 'no_session_id':
      return 'APE tool denied: Claude subagent tool call carries no usable session id';
    case 'no_agent_id':
      return 'APE tool denied: Claude subagent tool call carries no usable agent id';
    case 'no_agent_type':
      return 'APE tool denied: Claude subagent tool call carries no usable agent type';
    case 'different_agent_id':
      return 'APE tool denied: a different agent id is already bound for this run, session and agent type';
    case 'ticket_not_pending':
      return "APE tool denied: Claude subagent's bound ticket is not active and pending";
    case 'deadline_elapsed':
      return "APE tool denied: Claude subagent's ticket deadline has elapsed";
    case 'ambiguous':
      return 'APE tool denied: Claude subagent binding is ambiguous for this identity';
    default:
      return 'APE tool denied: Claude subagent has no exact active binding';
  }
}

export function evaluateLifecyclePolicy(event, context) {
  if (!context?.state) {
    return { decision: 'allow', reason: 'no active APE run; host behavior is unchanged' };
  }
  const external = resolveClaimedPluginRead(event.external_tool ?? classifyExternalTool(
    event.tool_name,
    event.raw?.tool_input ?? event.raw?.toolInput ?? event.raw?.input ?? {},
  ), context.ticket?.tool_claims);
  // Control-plane ownership (friction #13; phantom-dispatch incident). The
  // orchestrator (main session) owns ape_run/ape_config/ape_history; a
  // bound-or-identifiable APE-managed subagent of EITHER host must never call
  // them. bin/ape-hook.mjs keeps the stage-guard exemption for the MAIN
  // session only (recovery would deadlock otherwise) and lets a subagent's
  // control-plane call fall through to here. The deny is deliberately
  // status-independent — placed before the sealed branch so a sealed run's
  // orphan cannot start or advance a new run, and before the no-exact-binding
  // deny so a blocked run's formerly-bound subagent (binding unresolvable,
  // ape_managed from the ape:* agent_type) is still routed to the recovery
  // contract rather than a stale "no binding" reason. The load-bearing
  // protection is launch-capability acquisition denial: ape_run next returns
  // a live Claude prompt nonce or Codex task-name token, so denying the
  // subagent's own control-plane call is what stops it minting the capability
  // that created the phantom
  // binding — the isApeLaunch branch in bin/ape-hook.mjs routes an ape:*
  // Agent call straight to launchClaudeIntent, so the indirect-channel Agent
  // deny below is unreachable for launches and is NOT the backstop here; the
  // independent second backstop is the agents/*.md tools: allowlist (layer 2),
  // which omits Agent and every ape_* tool. All three tools are denied, not
  // just ape_run: ape_config set/wire and ape_history import are writers, and
  // even the reads couple a role's output to runtime state its ticket does
  // not grant (behavioral independence, invariant 3; the ticket file is the
  // sole sanctioned .ape read per prompts/common.md).
  //
  // A host-attested subagent identity OR a truthy host-delivered ticket binding
  // is enough to disqualify a control-plane call on both hosts. This is
  // intentionally host-neutral: an unbound Codex subagent is still a
  // subagent, not the orchestrator. `ape_managed === false` remains the escape
  // for explicitly unmanaged host activity. isToolChannelEvent is
  // load-bearing: Stop/SubagentStop must keep carrying the receipt-bearing
  // final message.
  if (
    isToolChannelEvent(event) &&
    CONTROL_PLANE_TOOLS.test(event.tool_name) &&
    (event.is_subagent || Boolean(event.ticket_id)) &&
    event.ape_managed !== false
  ) {
    return {
      decision: 'deny',
      reason: 'APE control plane denied: the orchestrator owns ape_run/ape_config/ape_history; finish the ticket and return your receipt JSON as your final message',
    };
  }
  // Execution-redirecting out-of-project configuration (table and rationale
  // above). ONE SITE, ABOVE THE SEALED BRANCH, so running, blocked, gating,
  // shipping AND sealed are governed once — a sealed run's orphan still holds a
  // live shell, and a second copy of this rule below the seal would be a second
  // thing to keep in sync.
  //
  // THE TOOL-CHANNEL AND WRITE-TOOL TERMS ARE LOAD-BEARING AT THIS HEIGHT.
  // __tests__/runtime-v2-abort-quarantine.test.js requires a sealed run's bound
  // orphan out-of-project Write to stay ALLOW and its Stop event to stay allow,
  // and denying a lifecycle boundary eats the agent's receipt-bearing final
  // message (see isToolChannelEvent). For a non-matching tail — and for every
  // non-write tool and every boundary event — this branch is a strict no-op.
  //
  // IT BINDS EVERY BOUND TICKET, writable and read-only alike: a claim set
  // governs project paths and never `$HOME`, so a writable ticket holds no
  // authority out there either, and keying on the binding rather than the role
  // also keeps this refusal from being mistaken for the read-only deny it sits
  // above. The UNBOUND MAIN SESSION is deliberately exempt, and the cost is
  // stated rather than implied: the family is closed against a mistaken or
  // misaligned STAGE, not against a compromised orchestrator, which keeps an
  // unrestricted out-of-project write at the allow branch below.
  //
  // Both the UNRESOLVED target and the hook's realpath-RESOLVED one are
  // consulted. The resolved half is absent whenever the async precompute did not
  // run (every direct unit call into this policy), and its absence degrades to
  // the unresolved tail alone rather than failing either way.
  if (
    context.ticket &&
    event.out_of_project === true &&
    isToolChannelEvent(event) &&
    WRITE_TOOLS.has(event.tool_name)
  ) {
    const targetPairs = Array.isArray(event.targets) && event.targets.length > 0
      ? event.targets.map((target) => [target.target_path, target.resolved_target_path])
      : [[event.target_path, event.resolved_target_path]];
    let tail = null;
    for (const [unresolved, resolved] of targetPairs) {
      tail = executionConfigTail(unresolved) ?? executionConfigTail(resolved);
      if (tail) break;
    }
    if (tail) {
      return {
        decision: 'deny',
        reason: `APE write denied: \`${tail}\` is execution-redirecting tool CONFIGURATION, which a bound ticket may not write outside the project — such a file changes what an already-admitted evidence command (npm test, git status, the login shell) EXECUTES with no token on the command line. Ordinary out-of-project scratchpad writes are still admitted: keep using the scratchpad, under a filename that is not tool configuration`,
      };
    }
  }
  if (SEALED_STATUSES.has(context.state.status)) {
    if (
      context.ticket &&
      isToolChannelEvent(event) &&
      event.out_of_project !== true &&
      (WRITE_TOOLS.has(event.tool_name) ||
        (event.tool_name === 'Bash' && SHELL_WRITE.test(event.command ?? '')) ||
        (external && external.effect !== 'read'))
    ) {
      return {
        decision: 'deny',
        reason: `APE write denied: run is sealed ${context.state.status} and the subagent binding is void`,
      };
    }
    return { decision: 'allow', reason: `APE run is sealed ${context.state.status}; host behavior is unchanged` };
  }
  if (!isToolChannelEvent(event)) {
    return { decision: 'allow', reason: 'lifecycle event is not a tool call; tool policy does not apply' };
  }
  if (
    event.host === 'claude' &&
    event.is_subagent &&
    event.ape_managed !== false &&
    !context?.ticket
  ) {
    return { decision: 'deny', reason: claudeBindingDenialReason(context?.claudeBindingDenialCause) };
  }
  if (external) {
    return externalToolPolicy(external, {
      state: context.state,
      ticket: context.ticket,
      isSubagent: event.is_subagent,
    });
  }
  if (event.tool_name === 'Bash') {
    const command = event.command ?? '';
    // A bound subagent must be able to run its evidence commands — a test
    // writer runs the narrow tests, an implementer runs a build/verify — but a
    // shell command's write effects cannot be proven before execution, so only a
    // recognized non-mutating evidence command is allowed; everything else fails
    // closed and production edits go through the path-checked host edit tool.
    if (context?.ticket) {
      // Deletion is its own channel and never falls through to the generic
      // evidence allow/deny: the policy is synchronous, so it consumes only
      // event.deletion, the per-target claims/role verdict precomputed with
      // realpath semantics by bin/ape-hook.mjs. A parsed deletion with no
      // precomputed verdict fails closed.
      if (parseDeletionCommand(command)) {
        if (!event.is_subagent) {
          return { decision: 'deny', reason: 'APE deletion denied: main-session production writes are forbidden' };
        }
        const ticket = context.ticket;
        if (context.state.status !== 'running') {
          // A blocked run fails closed on purpose — see the sealed-status
          // comment above — but 'no active writing run' while active.json
          // plainly holds one sends the operator hunting for a phantom;
          // naming the state and the audited exits is guidance, not a guard
          // relaxation. Sealed statuses already returned earlier, so
          // 'blocked' is the only live special case here.
          if (context.state.status === 'blocked') {
            return { decision: 'deny', reason: 'APE deletion denied: the run is blocked, so recovery is audited — REGATE for a gate block, otherwise OVERRIDE reset or ABORT — not a manual deletion' };
          }
          if (context.state.status === 'gating') {
            return { decision: 'deny', reason: 'APE deletion denied: the run is gating — the detached merge-gate suite is running and the tree is frozen until it lands; poll with ape_run next, or ABORT to abandon the gating run' };
          }
          return { decision: 'deny', reason: 'APE deletion denied: no active writing run' };
        }
        if (!ticket.writable) {
          return { decision: 'deny', reason: `APE deletion denied: ${ticket.role} is read-only` };
        }
        if (event.deletion?.safe !== true) {
          return {
            decision: 'deny',
            reason: `APE deletion denied: ${event.deletion?.reason ?? 'target path safety was not verified'}`,
          };
        }
        return { decision: 'allow', reason: `deletion authorized by ${ticket.ticket_id}` };
      }
      const commandProfile = matchingCommandProfile(event.project_dir, command);
      if (commandProfile) {
        if (!commandProfile.roles.includes(context.ticket.role)) {
          return {
            decision: 'deny',
            reason: `APE command profile denied: ${commandProfile.id} does not authorize role ${context.ticket.role}`,
          };
        }
        if (commandProfile.effect === 'write' && context.ticket.writable !== true) {
          return {
            decision: 'deny',
            reason: `APE command profile denied: read-only ${context.ticket.role} cannot run write profile ${commandProfile.id}`,
          };
        }
        return {
          decision: 'allow',
          reason: `exact command profile ${commandProfile.id} authorizes ${commandProfile.effect} execution`,
        };
      }
      const unrecognized = {
        decision: 'deny',
        reason: `APE write denied: a bound subagent may run only recognized non-mutating evidence commands (${EVIDENCE_COMMAND_FAMILIES}); production edits must use the host edit tool`,
      };
      // (0) The precomputed realpath-grade verdict. bin/ape-hook.mjs is async
      // and computes it beside the existing deletion/path_safe precomputes;
      // this policy is synchronous and only READS it. Consulted with the
      // `event.path_safe === false` idiom, NOT `deletion?.safe !== true`: an
      // ABSENT verdict must degrade to the lexical containment below rather
      // than blanket-deny, or every event that carries no project_dir — the
      // shape ~20 pre-existing arms use — would fail closed.
      //
      // cwd_safe is its own field and is consulted for EVERY bound evidence
      // command, including path-free ones: Claude's Bash tool keeps a
      // persistent shell whose cwd drifts on `cd`, every relative operand
      // resolves against THAT, and the lexical shortcut below is only sound
      // while cwd is inside the root. The catch-written failure verdict
      // ({tokens:null, safe:false, cwd_safe:false, reason}) lands here too, and
      // its reason is surfaced rather than swallowed.
      const verdict = event.evidence;
      if (verdict?.cwd_safe === false) {
        return {
          decision: 'deny',
          reason: `APE write denied: ${boundedToken(verdict.reason ?? 'the session working directory was not verified inside the governed project', DENY_REASON_MAX_CHARS)}`,
        };
      }
      if (verdict?.safe === false) {
        return {
          decision: 'deny',
          reason: `APE write denied: ${boundedToken(verdict.reason ?? 'an evidence operand was not verified inside the governed project', DENY_REASON_MAX_CHARS)}`,
        };
      }
      if (verdict?.executable_safe === false) {
        return {
          decision: 'deny',
          reason: `APE write denied: ${boundedToken(verdict.executable_reason ?? 'the evidence executable no longer matches the trusted run-start resolution', DENY_REASON_MAX_CHARS)}`,
        };
      }
      // (1)-(2) Refuse every shell metacharacter and every whitespace that is
      // not U+0020, then split. A null parse is an unrecognized command.
      const parsed = parseEvidenceCommand(command);
      if (!parsed) return unrecognized;
      // (3) EXACT-TOKEN head recognition, evidence table then lint table.
      const evidenceHead = recognizeEvidenceHead(parsed.tokens);
      const lintHead = evidenceHead > 0 ? 0 : recognizeLintHead(parsed.tokens);
      if (evidenceHead === 0 && lintHead === 0) return unrecognized;
      // Role-aware run-script tier. Fails closed on `!== true`, so a ticket
      // shape that omits `writable`, or carries a truthy non-boolean, lands in
      // the narrow tier.
      if (
        PACKAGE_MANAGER_HEAD.has(parsed.tokens[0]) &&
        parsed.tokens[1] === 'run' &&
        context.ticket.writable !== true
      ) {
        const admitted = declaredRunScripts(event.project_dir);
        if (!admitted.has(parsed.tokens[2])) {
          return {
            decision: 'deny',
            reason: `APE write denied: a read-only ticket may run \`<pm> run <script>\` only for a script this project declares, and ${boundedToken(parsed.tokens[2])} is not one of them (admitted here: ${renderAdmittedScripts(admitted)}); declare it with \`ape_config set policy.evidence_scripts\`, or run one of the recognized evidence commands (${EVIDENCE_COMMAND_FAMILIES}); production edits must use the host edit tool`,
          };
        }
      }
      // (4) CONTAINMENT — refuse the OPERAND, never the flag spelling. Applies
      // to the cd target and every token, for EVERY head: `pytest`,
      // `cargo test` and `npx vitest` relocate exactly as effectively as a
      // package manager does, and a re-gate placed inside the package-manager
      // branch was round 1a's bug shape.
      const containment = evidenceContainment(parsed, event.project_dir);
      if (!containment.safe) {
        return {
          decision: 'deny',
          reason: `APE write denied: no operand of an evidence command may name a path outside the governed project, and \`${boundedToken(containment.operand)}\` is not proven inside it — the refusal is on the PATH, not on any flag spelling (recognized evidence commands: ${EVIDENCE_COMMAND_FAMILIES})`,
        };
      }
      // (5) The surviving shape/tail gate. The command is re-gated with at most
      // one leading `cd <path> &&` prefix stripped, so a nested test root can
      // run its recognized runner; the stripped remainder faces the identical
      // evidence/write/chain checks. The LINT tail is vetted against
      // parsed.tokens instead — the same vector the head recognizer read — so
      // the gate and the tokenizer can never again disagree about what the
      // tokens are (round 5, site 2: `black . # --check`). The GIT tail is
      // vetted from parsed.tokens for the same reason (site 3), and takes the
      // FULL vector so it can answer `true` for a non-git head.
      const evidenceCommand = stripLeadingCd(command);
      if (
        ((evidenceHead > 0 && EVIDENCE_COMMAND.test(evidenceCommand) && gitEvidenceArgsSafe(parsed.tokens)) ||
          (lintHead > 0 &&
            !lintCommandMutates(parsed.tokens, lintHead) &&
            lintArgsSafe(parsed.tokens))) &&
        !SHELL_WRITE.test(evidenceCommand) &&
        !COMMAND_CHAIN.test(evidenceCommand)
      ) {
        return { decision: 'allow', reason: 'recognized non-mutating evidence command' };
      }
      return unrecognized;
    }
    if (!SHELL_WRITE.test(command)) return { decision: 'allow', reason: 'non-writing shell command' };
    if (!event.is_subagent) {
      // Fail-safe carve-out: when the SOLE reason this command matched
      // SHELL_WRITE is a redirect to exactly /dev/null it has no write effect
      // under any status, so allow it (status-independent). A real write
      // co-occurring with the /dev/null sink survives the strip and still fails
      // closed below; the bound-subagent arm is unaffected — its Bash is already
      // limited to the recognized evidence allowlist.
      if (onlyDevNullRedirects(command)) {
        return { decision: 'allow', reason: 'main-session shell command redirects only to /dev/null (no write effect)' };
      }
      // Message precision (roadmap hook-denial-message-precision): SHELL_WRITE
      // also matches commands that are NOT writes but that the guard cannot
      // prove are read-only — a compound `&&`-chain, a stderr redirect (`ls
      // 2>errs`), a quoted `>`, an inline interpreter — so the reason names
      // the fail-closed classification (invariant 2: no provable absence of a
      // write effect) instead of falsely asserting the command IS a write. This
      // is reason-only: the decision stays 'deny' and the denial set is
      // unchanged. Status-aware poll hint, mirroring the deletion-channel gating
      // message (hooks.js:439-441): the resting, tree-frozen watches that advance
      // only via `ape_run next` append it — 'gating' (the detached merge-gate
      // suite) and 'shipping' (the shipping-watch; NOT in SEALED_STATUSES, so it
      // reaches this arm rather than the sealed allow) — while 'running' has
      // nothing to poll and appends no hint.
      const status = context.state.status;
      let hint = '';
      if (status === 'gating') {
        hint = '; the detached merge-gate suite is running and the tree is frozen — poll with ape_run next';
      } else if (status === 'shipping') {
        hint = '; the run is shipping and the tree is frozen — poll with ape_run next';
      }
      return {
        decision: 'deny',
        reason: `APE denied: main-session shell command is not provably read-only during an active run (fail-closed: cannot verify it has no write effect; invariant 2)${hint}`,
      };
    }
    return {
      decision: 'deny',
      reason: 'APE write denied: use the host edit tool so the ticket path can be verified before write',
    };
  }
  if (!WRITE_TOOLS.has(event.tool_name)) {
    if (
      event.is_subagent &&
      event.ape_managed !== false &&
      !SAFE_SUBAGENT_TOOLS.has(event.tool_name)
    ) {
      return { decision: 'deny', reason: `APE tool denied: indirect channel ${event.tool_name || 'unknown'} is not authorized` };
    }
    return { decision: 'allow', reason: 'explicitly safe non-writing tool' };
  }
  // A write whose target genuinely resolves outside the project root is outside
  // APE's governance (invariant 2 protects *production* paths). The flag is
  // precomputed by the async hook entrypoint with realpath semantics — a raw
  // out-of-project path whose realpath lands inside the project never sets it,
  // and a missing flag fails closed below, mirroring event.path_safe.
  if (event.out_of_project === true) {
    return { decision: 'allow', reason: 'target resolves outside the project root; APE governs only project writes' };
  }
  if (!context?.state || context.state.status !== 'running') {
    // A blocked run fails closed on purpose — see the sealed-status comment
    // above — but 'no active writing run' while active.json plainly holds one
    // sends the operator hunting for a phantom; naming the state and the
    // audited exits is guidance, not a guard relaxation. Sealed statuses
    // already returned earlier, so 'blocked' and the resting 'gating' state are
    // the live special cases (the resting 'shipping' state — persistable since
    // #261 — keeps the generic message).
    if (context?.state?.status === 'blocked') {
      return { decision: 'deny', reason: 'APE write denied: the run is blocked, so recovery is audited — REGATE for a gate block, otherwise OVERRIDE reset or ABORT — not a manual edit' };
    }
    if (context?.state?.status === 'gating') {
      return { decision: 'deny', reason: 'APE write denied: the run is gating — the detached merge-gate suite is running and the tree is frozen until it lands; poll with ape_run next, or ABORT to abandon the gating run' };
    }
    return { decision: 'deny', reason: 'APE write denied: no active writing run' };
  }
  if (!event.is_subagent) {
    return { decision: 'deny', reason: 'APE write denied: main-session production writes are forbidden' };
  }
  const files = Array.isArray(event.files) && event.files.length > 0
    ? event.files
    : event.file
      ? [event.file]
      : [];
  // A parsed multi-file patch is one atomic authorization decision. Any target
  // that could not be normalized inside the project must not disappear merely
  // because another target did normalize successfully.
  if (
    files.length === 0 ||
    (Array.isArray(event.targets) && event.targets.some((target) => !target.file))
  ) {
    return { decision: 'deny', reason: 'APE write denied: target path is missing or aliases a path inside the project' };
  }
  if (event.path_safe === false) {
    return { decision: 'deny', reason: 'APE write denied: target resolves outside the ticket claims' };
  }

  const ticket = context.ticket;
  if (!ticket) return { decision: 'deny', reason: 'APE write denied: subagent is not bound to an active ticket' };
  if (event.ticket_id && event.ticket_id !== ticket.ticket_id) {
    return { decision: 'deny', reason: 'APE write denied: lifecycle ticket does not match the active ticket' };
  }
  if (!ticket.writable) return { decision: 'deny', reason: `APE write denied: ${ticket.role} is read-only` };
  if (ticket.role === 'test_writer' && files.some((file) => !withinTestScope(file, ticket.test_paths))) {
    return { decision: 'deny', reason: 'APE write denied: test writers may modify only claimed test paths' };
  }
  if (ticket.role === 'implementer' && files.some((file) => looksLikeTest(file, ticket.test_paths))) {
    return { decision: 'deny', reason: 'APE write denied: implementers may not modify authored tests' };
  }
  if (ticket.role !== 'test_writer') {
    const unclaimed = files.find(
      (file) => !ticket.claimed_paths.some((claim) => withinClaim(file, claim)),
    );
    if (unclaimed) {
      return { decision: 'deny', reason: `APE write denied: ${unclaimed} is outside the ticket claims` };
    }
  }
  // Write-content byte gate (roadmap entry authored-and-agent-facing-byte-
  // integrity, WRITE side; see the WRITE_CONTENT_ROUTES comment above). This
  // is the LAST check IN THIS WRITE-TOOL BRANCH, narrowing only a write every
  // earlier rule in this branch already admits: the target path, claim, role
  // and scope are all proven safe by the point this is consulted, so a
  // hazard byte in CONTENT can only turn an otherwise-allowed write into a
  // denial, never widen any deny path above. This does NOT hold for the
  // out-of-project branch above (event.out_of_project === true returns allow
  // before this branch is ever reached): that write is EXEMPT from this gate
  // entirely, never narrowed by it, so a scratchpad or other out-of-project
  // write carries no content check at all (docs/hooks.md's own byte-gate
  // section states this same limit).
  // event.write_content_hazard is precomputed synchronously by
  // bin/ape-hook.mjs (evaluateWriteContentPolicy, exported above) beside the
  // deletion and evidence precomputes; an absent verdict (every direct unit
  // call into this policy, and any event the precompute has no reason to run
  // for) degrades to safe, exactly like event.path_safe's own absence
  // convention elsewhere in this function.
  //
  // CONSEQUENCE FOR A KNOWN FIXTURE, recorded rather than left for a future
  // agent to rediscover as a mystery denial: this gate is content-blind to
  // INTENT, so it denies any write through a ROUTED tool — Write, Edit,
  // MultiEdit, NotebookEdit, apply_patch (see WRITE_CONTENT_ROUTES above) —
  // whose payload LITERALLY carries a hazard code point, even where that byte
  // is the whole point of the edit. __tests__/runtime-v2-execution-config-case-folding
  // .test.js is exactly that case — it embeds literal soft-hyphen/zero-width/
  // bidi code points directly in its own source as FIXTURE DATA proving the
  // out-of-project case-folding guard against them (its own file-level
  // exemption from the tracked-source scan in
  // __tests__/runtime-v2-authored-byte-integrity.test.js says as much) — so
  // while it keeps those bytes typed literally, no bound subagent can touch
  // it through a host edit tool again: every Write/Edit/MultiEdit call
  // carrying one in `content`/`new_string` is denied here, with no escape
  // hatch, exactly the over-block hazard the roadmap entry warns a gate like
  // this one must not become. MAINTENANCE PATH: a future edit to that file
  // must stop typing the hazard code points literally in the tool payload
  // and instead build them the way the authored suites in __tests__ do —
  // `String.fromCodePoint(0x...)` inside the test source (never
  // `String.fromCharCode`, which cannot represent the astral TAGS members
  // this gate also refuses), so the BYTES the host edit tool transmits stay
  // ordinary ASCII and the hazard code point exists only once the test
  // runs, in memory, never in the diff this gate inspects. That is a
  // rewrite of that file's own fixture construction, out of scope for this
  // ticket (the file is not in claimed_paths), recorded here at the gate's
  // own site as the run objective requires.
  if (event.write_content_hazard?.safe === false) {
    return { decision: 'deny', reason: `APE write denied: ${event.write_content_hazard.reason}` };
  }
  return { decision: 'allow', reason: `write authorized by ${ticket.ticket_id}` };
}

// Bounded native identity, mirroring the boundedIdentity check in
// lib/runtime/claude-dispatch.js (reimplemented locally: the dispatch module
// carries the Claude nonce/intent machinery this policy-only seam must not
// depend on).
function boundedStartIdentity(value, max = 512) {
  return typeof value === 'string' && value.length > 0 && value.length <= max;
}

// SubagentStart handshake seam, host-neutral form. Validates a start-derived
// binding payload — an explicit ticket_id field or an APE_TICKET_ID-equivalent
// value the host event delivered (already normalized onto event.ticket_id) —
// with the same POLICY checks bindClaudeSubagent applies, minus the Claude
// nonce/intent machinery: (a) bounded native identity (agent_id and agent_type
// both non-empty strings ≤512 chars), (b) a running run, (c) a pending ticket
// (named in state.tickets, not expired, no receipt — pendingTicket semantics
// reimplemented locally so this stays a pure, synchronous evaluator), and
// (d) an unelapsed ticket deadline: a finite Date.parse(deadline_at) at or
// before the injectable clock `at` denies (inclusive <=, matching the
// scheduler's deadline-timeout predicate and the Claude launch handshake's
// deadline deny in claude-dispatch.js). Absent or unparseable deadlines
// deliberately fail OPEN via the Number.isFinite guard — deadline_at is
// schema-required on real tickets, so only synthetic fixtures lack one — not
// expired()'s unparseable-means-elapsed posture. It mints
// nothing and writes nothing: it answers only whether the host-delivered
// binding is one the runtime would accept, so a real Codex binding channel can
// later land as pure host wiring with no policy rework. Callers never invoke
// it without a binding payload — a start event with no binding has nothing to
// validate and must fall through unchanged (never fabricate a binding
// out-of-band; unbound writes keep failing closed downstream).
export function evaluateStartBinding(state, event, at = Date.now()) {
  const raw = event.raw ?? {};
  const agentId = raw.agent_id ?? raw.agentId;
  const agentType = raw.agent_type ?? raw.agentType;
  if (!boundedStartIdentity(agentId) || !boundedStartIdentity(agentType)) {
    return { valid: false, reason: 'APE start binding denied: malformed native identity' };
  }
  if (state?.status !== 'running') {
    return { valid: false, reason: `APE start binding denied: run status is ${state?.status ?? 'unknown'}, not running` };
  }
  const ticketId = event.ticket_id;
  const ticket = state.tickets?.find((entry) => entry.ticket_id === ticketId);
  const pending =
    Boolean(ticket) &&
    !(state.expired_tickets ?? []).includes(ticketId) &&
    !state.receipts?.some((receipt) => receipt.ticket_id === ticketId);
  if (!pending) {
    return { valid: false, reason: 'APE start binding denied: ticket is not active and pending' };
  }
  const deadline = Date.parse(ticket.deadline_at ?? '');
  if (Number.isFinite(deadline) && deadline <= at) {
    return { valid: false, reason: 'APE start binding denied: ticket deadline elapsed' };
  }
  return { valid: true, reason: `APE start binding validated for ${ticketId}` };
}

async function nearestExistingPath(absolute) {
  let candidate = absolute;
  const suffix = [];
  for (;;) {
    try {
      await lstat(candidate);
      const resolved = await realpath(candidate);
      return path.join(resolved, ...suffix.reverse());
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
      const parent = path.dirname(candidate);
      if (parent === candidate) return null;
      suffix.push(path.basename(candidate));
      candidate = parent;
    }
  }
}

export async function pathResolvesWithinClaims(projectDir, file, claims) {
  if (!file || !Array.isArray(claims) || claims.length === 0) return false;
  const root = await realpath(projectDir);
  const target = await nearestExistingPath(path.resolve(projectDir, file));
  if (!target) return false;
  const relativeToRoot = path.relative(root, target);
  if (relativeToRoot === '..' || relativeToRoot.startsWith(`..${path.sep}`)) return false;
  for (const claim of claims) {
    const claimTarget = await nearestExistingPath(path.resolve(projectDir, claim));
    if (!claimTarget) continue;
    const relative = path.relative(claimTarget, target);
    if (relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))) {
      return true;
    }
  }
  return false;
}

// The out-of-project verdict AND the realpath-resolved target from ONE walk.
// bin/ape-hook.mjs precomputes both onto the event: the boolean drives the
// long-standing out-of-project exemption, and the RESOLVED path gives the
// execution-redirecting-configuration refusal its SECOND lookup. That refusal
// consults the RAW target and this resolved one, and NEITHER SUBSUMES the other,
// because the two catch OPPOSITE symlink layouts. THIS half sees a tail only
// resolution reveals: an ordinary-named path that resolves ONTO a covered
// directory (`link/config.toml` landing on `.cargo/config.toml`). The RAW half
// sees the layout a dotfile manager produces — under stow or chezmoi
// `$HOME/.cargo` is a symlink INTO a managed store, so resolution ERASES the
// match and the resolved tail is `cargo/config.toml`, which is in no table.
//
// `resolved` is null exactly when nothing on the path exists, which is also the
// input for which `outside` is false and the write keeps failing closed.
export async function resolveOutOfProjectTarget(projectDir, absoluteTarget) {
  if (typeof absoluteTarget !== 'string' || absoluteTarget.length === 0) {
    return { outside: false, resolved: null };
  }
  const root = await realpath(projectDir);
  const resolved = await nearestExistingPath(path.resolve(projectDir, absoluteTarget));
  if (!resolved) return { outside: false, resolved: null }; // unresolvable: fail closed, keep the governed deny
  const relative = path.relative(root, resolved);
  return {
    outside: relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative),
    resolved,
  };
}

// The boolean half, unchanged in signature and semantics — including the
// polarity trap documented at its bin/ape-hook.mjs call sites: FALSE for a path
// it cannot resolve, and it swallows only ENOENT.
export async function pathResolvesOutsideProject(projectDir, absoluteTarget) {
  return (await resolveOutOfProjectTarget(projectDir, absoluteTarget)).outside;
}

// Scope of the tree-drift lockdown (bin/ape-hook.mjs). An unattributed tree
// change is dangerous only where it could be extended — a write-capable tool,
// or a shell command that fails the read-only heuristic — or laundered into an
// accepted result: SubagentStop and the post events of the Agent tool. A
// read-only tool can do neither, and denying it blocks exactly the diagnosis
// and recovery the drift calls for, so everything else stays governed by the
// ordinary lifecycle policy alone — with one decoupled backstop. SHELL_WRITE
// is a blocklist, so keying the guard solely off it meant a main-session
// shell write it did not enumerate landed silently and was laundered into the
// next drift-guarded event's sole-candidate attribution (audit finding 1.7,
// invariant 2). Main-session Bash POST events therefore always reconcile: an
// unattributed change is DENIED at the very event that produced it (a loud,
// operator-visible refusal) rather than landing silently. The deny does NOT
// revert the bytes, though: a persisted drift that happens to fall within a
// pending writer ticket's claims can still be re-attributed at that ticket's
// Agent post-event, because author-blind receipt admission cannot tell the
// drift from the writer's own work. That residual is a known, tracked gap —
// see docs/research/2026-07-22-main-session-write-laundering.md — not a closed
// one. Pre events stay pattern-bound so the operator's read-only
// diagnosis (`git status` during drift) keeps working, and bound subagents
// stay pattern-bound because their Bash channel is already restricted to the
// non-mutating evidence allowlist.
export function driftGuardApplies(event) {
  if (event.event === 'SubagentStop') return true;
  if (
    (event.event === 'PostToolUse' || event.event === 'PostToolUseFailure') &&
    isAgentDispatchTool(event.tool_name)
  ) {
    return true;
  }
  if (WRITE_TOOLS.has(event.tool_name)) return true;
  const external = event.external_tool ?? classifyExternalTool(
    event.tool_name,
    event.raw?.tool_input ?? event.raw?.toolInput ?? event.raw?.input ?? {},
  );
  if (
    external &&
    (external.conservative_drift === true || ['write', 'execute', 'unknown'].includes(external.effect))
  ) return true;
  if (event.tool_name !== 'Bash') return false;
  const profile = matchingCommandProfile(event.project_dir, event.command ?? '');
  if (profile && ['write', 'execute'].includes(profile.effect)) return true;
  if (SHELL_WRITE.test(event.command ?? '')) return true;
  return (
    (event.event === 'PostToolUse' || event.event === 'PostToolUseFailure') &&
    !event.is_subagent
  );
}

export function evaluateTreePolicy(event, context, changedFiles) {
  if (!context?.state || context.state.status !== 'running' || changedFiles.length === 0) {
    return { decision: 'allow', reason: 'tree unchanged' };
  }
  const ticket = context.ticket;
  if (event.path_safe === false) {
    return { decision: 'deny', reason: 'APE result denied: changed target resolves outside ticket claims' };
  }
  if (!event.is_subagent || !ticket) {
    return { decision: 'deny', reason: 'APE result denied: tree changed without one active writing ticket' };
  }
  for (const file of changedFiles) {
    if (!ticket.writable) return { decision: 'deny', reason: `APE result denied: ${ticket.role} changed ${file}` };
    if (
      ticket.role !== 'test_writer' &&
      !ticket.claimed_paths.some((claim) => withinClaim(file, claim))
    ) {
      return { decision: 'deny', reason: `APE result denied: unclaimed change ${file}` };
    }
    if (ticket.role === 'test_writer' && !withinTestScope(file, ticket.test_paths)) {
      return { decision: 'deny', reason: `APE result denied: test writer changed production path ${file}` };
    }
    if (ticket.role === 'implementer' && looksLikeTest(file, ticket.test_paths)) {
      return { decision: 'deny', reason: `APE result denied: implementer changed authored test ${file}` };
    }
  }
  return { decision: 'allow', reason: `tree changes authorized by ${ticket.ticket_id}` };
}

export function formatHookResponse(event, result) {
  if (event.event === 'SubagentStart') {
    if (result.additional_context) {
      return {
        hookSpecificOutput: {
          hookEventName: event.event,
          additionalContext: result.additional_context,
        },
      };
    }
    if (result.decision === 'allow') return {};
    // Claude can reject a subagent at this boundary. Codex 0.145 parses
    // `continue: false` for compatibility but explicitly does not stop the
    // subagent, so surface the failure and rely on the identity-bound
    // PreToolUse gate to deny every subsequent write.
    return event.host === 'claude'
      ? { decision: 'block', reason: result.reason }
      : { systemMessage: result.reason };
  }
  // permissionDecision is honored only on PreToolUse. Post events use the
  // top-level block shape because their side effect has already occurred.
  if (event.event === 'PreToolUse') {
    // Codex accepts permissionDecision: "allow" only when the hook also
    // supplies updatedInput to rewrite the call. APE never rewrites inputs, so
    // ordinary Codex success must be neutral JSON; emitting "allow" without
    // updatedInput makes Codex report the hook run as failed. Claude supports
    // the explicit allow shape and keeps it for its existing contract.
    if (event.host === 'codex' && result.decision === 'allow') return {};
    return {
      hookSpecificOutput: {
        hookEventName: event.event,
        permissionDecision: result.decision === 'allow' ? 'allow' : 'deny',
        permissionDecisionReason: result.reason,
      },
    };
  }
  if (result.decision === 'allow') return {};
  return { decision: 'block', reason: result.reason };
}
