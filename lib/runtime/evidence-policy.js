import path from 'node:path';
import { createHash } from 'node:crypto';
import {
  accessSync,
  constants as fsConstants,
  readdirSync,
  realpathSync,
  statSync,
} from 'node:fs';
import { NON_ASCII_HAZARD, normalizePath } from './write-policy.js';
import { literalCdPrefix, literalInspectionWords } from './inspection-command.js';
import { readBoundedFileSync } from './bounded-file.js';

// Published in issued ticket objectives and shell-policy denial reasons so
// callers can discover the actual grammar without trial-and-error denials.
// Keep the ordinary alphabet, literal inspection exception, Git argument
// rules, relocation grammar, containment and per-ticket script tier aligned
// with their parsers below. The string must stay newline-free and precede the
// trailing `Run objective:` suffix used by service/projection deduplication.
export const EVIDENCE_COMMAND_FAMILIES =
  'npm/pnpm/yarn/bun: bare `test` and `t` in every tier, but only as COMPLETE tokens (`test:e2e`, `test-ci`, `t-deploy`, `test.unit` are package scripts, not the bare form, and are refused); `run <script>` permits arbitrary script names on a WRITABLE ticket, while known writer profiles still require the ticket capability and output scope; on a read-only ticket only the script names this project itself declares (its configured test_commands and runners[].profile commands, plus policy.evidence_scripts) — the deny reason names the exact set admitted for your ticket; vitest/jest/mocha/ava/playwright/tap/tsc/pytest runners, bare or via npx/pnpm/yarn/bun; node --test|--check|--version; python -m pytest|unittest; uv/poetry/pdm/hatch/rye/pipenv/pixi run with a pytest or python -m test tail; hatch|rye test; tox; go test; cargo test; read-only git (status|diff|log|show|rev-parse|branch|describe|ls-files|ls-tree — branch listing includes --contains/--no-contains, --merged/--no-merged, --points-at with commit values, --list with patterns, and --format/--sort with values; display and sort flags alone do not authorize branch creation, and mutating or unknown branch options are refused; no --output/-o file flags; output-shaped paths after exact -- are admitted when preceding flags have modeled no-value or inline-value forms, otherwise the full argv is checked; ls-files read-only short groups such as -o, -oi and -oz are admitted); ls|pwd|cat|echo|true|which plus sha256sum|shasum checksum evidence; rg|grep searches and head|tail file reads (rg subprocess modes --pre, --hostname-bin, -z/--search-zip are refused); bare env (no operands); check-only linters (ruff|flake8|mypy|pylint|black|isort|eslint|prettier); every command head is matched as an EXACT decoded argv token, so `<head>-pwn`, `<head>.pwn` and `<head>:pwn` are different programs and are refused; ordinary unquoted words use a positive ALLOWLIST: A-Za-z0-9, the punctuation `- _ . / : = @ ~ , % ^ +`, and non-ASCII code points by range, with plain spaces as separators; NUL, invisible format characters and whitespace other than plain spaces are refused; cat|ls|rg|grep|head|tail|git additionally admit complete literal single- or double-quoted words mixed with ordinary words, including spaces, bracketed paths, regex punctuation and shell metacharacters as quoted data — for example `cat \'app/trace/[traceId]/page.tsx\'`; double-quoted words may not contain backslashes, dollar signs, backticks or exclamation marks, and partial quote concatenation, unquoted brackets and shell operators remain refused; outside literal inspection, a complete uniformly quoted, escape-free argv vector using the ordinary alphabet is canonicalized, and the narrow single-quoted complete dynamic-route path forms remain admitted; three unquoted-token characters EXPAND at token start, so a token beginning with `~`, `=` or `^` is refused there, and `~` and `=` are refused straight after an `=` or a `:` inside a token as well; at most one leading `cd <dir> &&` prefix is admitted, with a single contained directory word that may be completely single- or double-quoted to preserve spaces, brackets and literal punctuation; a `cd` target may not begin with `-` or `+`, and an unquoted target additionally excludes `~` and `^` anywhere; no operand — a bare token, the `=`-suffix of a flag, or a path stuck onto a short flag — may name a path outside the governed project, except the exact `/dev/null` comparison operand in `git diff --no-index <path> <path>` with an optional exact `--` end-of-options separator before the two paths; a relocation flag is refused by its OPERAND and never by its spelling; additional chaining, redirects and inline interpreters are denied';

// ---------------------------------------------------------------------------
// TOKENIZE-THEN-ALLOWLIST. parseEvidenceCommand decodes complete literal words
// for the inspection heads before reaching the ordinary-token fallback. That
// decoder preserves quoted spaces and punctuation as argv data while refusing
// interpolation, partial quoting and shell syntax outside literal words.
// The fallback below splits on plain spaces and admits only the positive
// alphabet or its narrow complete quoted forms. Both paths recognize exact
// decoded heads, check option effects and contain operands using the same argv.
// A single leading cd prefix is decoded separately by leadingEvidenceCd, with
// its quoted target retained as one directory operand for containment.
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
// The positional rule is COMPLETE for ordinary tokens because (1) refuses
// quotes and metacharacters there. Both quoted operand forms are marked by
// decodeEvidenceToken and skip this unquoted-word expansion rule: their actual
// shell quotes suppress word-level expansion.
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

// Next.js dynamic routes put brackets in path segments. Unquoted brackets are
// shell glob syntax, so adding them to EVIDENCE_TOKEN_CHAR_REFUSED would make
// the gate inspect a different path from the one zsh expands. Admit only a
// complete single-quoted token whose bracket-bearing segments are complete
// Next.js forms. Removing the outer quotes then yields the exact argv token
// received by the evidence program and by the containment checks below.
const EVIDENCE_BRACKET_PATH_CHAR_REFUSED = /[^A-Za-z0-9\-_.\/:=@~,%^+\[\]\u{80}-\u{10FFFF}]/u;
const EVIDENCE_DYNAMIC_ROUTE_SEGMENT = /^(?:\[(?:\.\.\.)?[A-Za-z0-9_-]+\]|\[\[\.\.\.[A-Za-z0-9_-]+\]\])$/;
const STATIC_QUOTED_OPERAND_HEAD = new Set(['cat', 'ls']);

// One owner for the positive alphabets used both by the evidence parser and
// by lifecycle argv-wrapper canonicalization. The wrapper may remove only
// syntax-free quote pairs: a space or a refused/hazardous character would make
// its de-quoted spelling observably different to the shell. Brackets are an
// explicit opt-in for the single-quoted route path that decodeEvidenceToken
// validates segment-by-segment below.
export function evidenceTokenUsesPositiveAlphabet(token, { allowBrackets = false } = {}) {
  if (typeof token !== 'string' || token.length === 0 || token.includes(' ')) return false;
  const refused = allowBrackets
    ? EVIDENCE_BRACKET_PATH_CHAR_REFUSED
    : EVIDENCE_TOKEN_CHAR_REFUSED;
  return !refused.test(token) && !NON_ASCII_HAZARD.test(token);
}

function decodeEvidenceToken(rawToken, { allowStaticQuotedOperand = false } = {}) {
  if (
    !rawToken.includes("'") &&
    !rawToken.includes('"') &&
    !rawToken.includes('[') &&
    !rawToken.includes(']')
  ) {
    if (!evidenceTokenUsesPositiveAlphabet(rawToken)) return null;
    return { token: rawToken, quoted: false };
  }
  const quote = rawToken[0];
  const isCompleteStaticQuote =
    rawToken.length >= 3 &&
    (quote === "'" || quote === '"') &&
    rawToken.endsWith(quote);
  if (allowStaticQuotedOperand && isCompleteStaticQuote) {
    const token = rawToken.slice(1, -1);
    if (
      evidenceTokenUsesPositiveAlphabet(token)
    ) {
      return { token, quoted: true };
    }
  }
  if (
    rawToken.length < 3 ||
    !rawToken.startsWith("'") ||
    !rawToken.endsWith("'")
  ) {
    return null;
  }
  const token = rawToken.slice(1, -1);
  if (
    !evidenceTokenUsesPositiveAlphabet(token, { allowBrackets: true })
  ) {
    return null;
  }
  let sawDynamicRoute = false;
  for (const segment of token.split('/')) {
    if (!segment.includes('[') && !segment.includes(']')) continue;
    if (!EVIDENCE_DYNAMIC_ROUTE_SEGMENT.test(segment)) return null;
    sawDynamicRoute = true;
  }
  return sawDynamicRoute ? { token, quoted: true } : null;
}

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
export const PACKAGE_MANAGER_HEAD = new Set(['npm', 'pnpm', 'yarn', 'bun']);

// Runners a package manager (or npx) may execute directly. `npm` is excluded
// from this arm on purpose — `npm vitest` is not a thing — and reaches its
// runners through `npm test` / `npm run <script>`.
export const PACKAGE_MANAGER_RUNNER = new Set(['vitest', 'jest', 'mocha', 'ava', 'playwright', 'tap', 'tsc']);

export const BARE_TEST_RUNNER = new Set(['vitest', 'jest', 'mocha', 'ava', 'tap', 'pytest', 'tsc']);

export const NODE_EVIDENCE_FLAG = new Set(['--test', '--check', '--version']);

export const PYTHON_HEAD = new Set(['python', 'python3']);

export const PYTHON_TEST_MODULE = new Set(['pytest', 'unittest']);

export const PYTHON_MANAGER_HEAD = new Set(['uv', 'poetry', 'pdm', 'hatch', 'rye', 'pipenv', 'pixi']);

export const PYTHON_MANAGER_TEST_HEAD = new Set(['hatch', 'rye']);

export const GIT_EVIDENCE_VERB_TOKEN = new Set([
  'status', 'diff', 'log', 'show', 'rev-parse', 'branch', 'describe', 'ls-files', 'ls-tree',
]);

export const INSPECTION_BUILTIN = new Set([
  'ls', 'pwd', 'cat', 'echo', 'true', 'which', 'sha256sum', 'shasum',
  'rg', 'grep', 'head', 'tail',
]);

// Ripgrep's ordinary search/listing flags do not write files. Its preprocessor,
// hostname command, and compressed-file search modes launch other executables,
// however, whose identity/effects are not covered by the admitted `rg` head.
// Inspect argv flags, including grouped -z, without treating a pattern supplied
// through -e/--regexp (or an operand after --) as an executable option.
const RG_SUBPROCESS_OPTION = new Set(['--pre', '--hostname-bin', '--search-zip']);
const RG_VALUE_OPTION = new Set([
  '--regexp', '--file', '--glob', '--iglob', '--type', '--type-not', '--replace',
  '--after-context', '--before-context', '--context', '--encoding', '--threads',
  '--max-count', '--max-columns', '--ignore-file', '--color', '--colors',
  '--max-depth', '--max-filesize', '--sort', '--sortr', '--type-add', '--type-clear',
  '--dfa-size-limit', '--regex-size-limit', '--engine', '--context-separator',
  '--field-context-separator', '--field-match-separator', '--hyperlink-format',
  '--path-separator', '--pre-glob', '--generate',
]);
const RG_SHORT_VALUE_OPTION = new Set('defgtTrABCEjmM');

// Separate search data from filesystem operands. Both lexical policy and the
// hook's realpath check consume this list, including attached pattern-file flags.
export function evidencePathOperands(tokens) {
  const data = new Set();
  const paths = new Map();
  if (tokens[0] === 'rg' || tokens[0] === 'grep') {
    const rg = tokens[0] === 'rg';
    const values = rg ? RG_VALUE_OPTION : new Set([
      '--regexp', '--file', '--after-context', '--before-context', '--context',
      '--max-count', '--binary-files', '--devices', '--directories', '--label',
      '--include', '--exclude', '--exclude-dir', '--exclude-from', '--color', '--colour',
    ]);
    const shortValues = rg ? RG_SHORT_VALUE_OPTION : new Set('efABCmDd');
    const pathOptions = new Set(['--file', '--ignore-file', '--exclude-from']);
    const positional = [];
    let explicitPattern = false;
    let listing = false;
    let options = true;
    for (let index = 1; index < tokens.length; index += 1) {
      const token = tokens[index];
      if (options && token === '--') { options = false; continue; }
      if (options && token.startsWith('--')) {
        const separator = token.indexOf('=');
        const option = separator < 0 ? token : token.slice(0, separator);
        if (option === '--regexp' || option === '--file') explicitPattern = true;
        if (rg && (option === '--files' || option === '--type-list')) listing = true;
        // grep's optional long values must be attached with '='; a following
        // token is the pattern, including for bare --context (default 2).
        if (!values.has(option) || (!rg && separator < 0 && ['--color', '--colour', '--context'].includes(option))) continue;
        const valueIndex = separator < 0 ? ++index : index;
        const value = separator < 0 ? tokens[index] : token.slice(separator + 1);
        if (value === undefined) continue;
        if (pathOptions.has(option)) paths.set(valueIndex, [value]);
        else data.add(valueIndex);
      } else if (options && token.startsWith('-') && token !== '-') {
        for (let position = 1; position < token.length; position += 1) {
          const option = token[position];
          if (!shortValues.has(option)) continue;
          if (option === 'e' || option === 'f') explicitPattern = true;
          const attached = position < token.length - 1;
          const valueIndex = attached ? index : ++index;
          const value = attached ? token.slice(position + 1) : tokens[index];
          if (value !== undefined) {
            if (option === 'f') paths.set(valueIndex, [value]);
            else data.add(valueIndex);
          }
          break;
        }
      } else positional.push(index);
    }
    if (!explicitPattern && !listing && positional.length > 0) data.add(positional[0]);
  }
  return tokens.flatMap((token, tokenIndex) => data.has(tokenIndex) ? [] :
    (paths.get(tokenIndex) ?? evidenceOperandCandidates(token)).map((candidate) => ({ tokenIndex, candidate })));
}

export function inspectionEvidenceArgsSafe(tokens) {
  if (tokens?.[0] !== 'rg') return true;
  for (let index = 1; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token === '--') break;
    if (token.startsWith('--')) {
      const option = token.split('=', 1)[0];
      if (RG_SUBPROCESS_OPTION.has(option)) return false;
      if (!token.includes('=') && RG_VALUE_OPTION.has(option)) index += 1;
    } else if (token.startsWith('-')) {
      for (let position = 1; position < token.length; position += 1) {
        const option = token[position];
        if (option === 'z') return false;
        if (RG_SHORT_VALUE_OPTION.has(option)) {
          if (position === token.length - 1) index += 1;
          break;
        }
      }
    }
  }
  return true;
}

// The LINT head table. Converting it to exact-token recognition is not
// cosmetic: it carried the IDENTICAL unanchored word-boundary defect, and
// because pnpm/yarn/bun run package.json scripts by bare name, `yarn mypy-x`
// was the very arbitrary-declared-script channel this gate exists to close.
export const LINT_TOOL = new Set([
  'ruff', 'flake8', 'mypy', 'pylint', 'black', 'isort', 'eslint', 'prettier',
]);

export const RUFF_EVIDENCE_VERB = new Set(['check', 'format', '--version']);

export const LINT_EXEC_PREFIX = new Set(['exec', 'x']);

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
    // Search permission on a directory satisfies X_OK, but the shell skips
    // directories (and links to them) when resolving an executable on PATH.
    return statSync(candidate).isFile();
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
        // The pathname can change after stat: opening nonblocking/no-follow
        // and bounding the descriptor read prevents a FIFO swap from hanging
        // the hook and a growing shim from exceeding this byte allowance.
        sha256: createHash('sha256')
          .update(readBoundedFileSync(realpathValue, EVIDENCE_EXECUTABLE_HASH_MAX_BYTES))
          .digest('hex'),
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
      // prose-bound-exempt: head is an allowlisted evidence-command token.
      : { safe: false, reason: `shell builtin ${head} is missing from the trusted-start snapshot` };
  }
  if (!expected || !['missing', 'executable'].includes(expected.kind)) {
    return {
      safe: false,
      // prose-bound-exempt: head is an allowlisted evidence-command token.
      reason: `evidence executable ${head} is missing from the trusted-start snapshot`,
    };
  }
  const current = resolveEvidenceExecutable(head, { ...options, platform });
  if (expected.kind === 'missing') {
    return current === null
      ? { safe: true, reason: null }
      : {
          safe: false,
          // prose-bound-exempt: head is an allowlisted evidence-command token.
          reason: `evidence executable ${head} appeared on PATH after the trusted run start`,
        };
  }
  const unchanged =
    executableComparisonKey(expected.realpath, platform) !== null &&
    executableComparisonKey(expected.realpath, platform) === executableComparisonKey(current, platform);
  if (!unchanged) {
    return {
      safe: false,
      // prose-bound-exempt: head is an allowlisted evidence-command token.
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
        // prose-bound-exempt: head is an allowlisted evidence-command token.
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

// `--output`/`--output-directory` in spaced or `=` form, and any single-dash
// `-o…` (covers sticky `-o<path>`). `--oneline` starts `--o`, not `-o`, so it
// stays allowed; `-O<orderfile>` is git's read-only order-file option and the
// cosmetic `--output-indicator-*` flags do not write, so both stay allowed.
// `git ls-files -o` lists untracked files; its recognized short groups are
// checked separately without weakening output-file refusals for diff/log/show.
const GIT_OUTPUT_FLAG = /^(?:--output(?:=.*)?|--output-directory(?:=.*)?|-o.*)$/;

// ls-files' short options are read-only. Parse groups rather than treating any
// spelling beginning with -o as an output file: -oi lists ignored untracked
// files, and -oz prints untracked paths with NUL separators. -x/-X consume the
// rest of their word as an exclude pattern/file (or the following word), so
// those values must not be interpreted as more option letters. Unknown option
// letters still fail closed; notably -oresult.txt is not a recognized group.
function gitLsFilesShortOptionsSafe(token) {
  if (!token.startsWith('-') || token.startsWith('--') || token.length === 1) return false;
  for (let index = 1; index < token.length; index += 1) {
    if (token[index] === 'x' || token[index] === 'X') return true;
    if (!'ztvfcdmoisku'.includes(token[index])) return false;
  }
  return true;
}

// A separator is trusted only after an explicitly modeled prefix. Git's
// revision parser can consume `--` as an option value: `log -L -- --output=x`
// writes x before reporting the invalid line range. Unknown or value-taking
// options retain the original full-tail output scan instead of assuming the
// next `--` is a separator. This intentionally models ordinary inspection
// prefixes, not all of Git's options.
const GIT_SEPARATOR_NO_VALUE_OPTION = new Set([
  '--stat', '--shortstat', '--numstat', '--name-only', '--name-status',
  '--summary', '--raw', '--patch', '--no-patch', '--oneline',
  '--no-ext-diff', '--no-textconv', '--no-renames', '--cached', '--staged',
  '--no-index', '--check', '--exit-code', '--quiet', '--exclude-standard', '--full-name',
]);
const GIT_SEPARATOR_INLINE_VALUE_OPTION = new Set([
  '--stat', '--format', '--pretty', '--abbrev', '--color', '--date', '--decorate',
]);

function gitProvenOptionPrefix(verb, tail) {
  const separator = tail.indexOf('--');
  if (separator === -1) return tail;
  const prefix = tail.slice(0, separator);
  const proven = prefix.every((token) => {
    if (!token.startsWith('-') || token === '-') return true;
    if (GIT_SEPARATOR_NO_VALUE_OPTION.has(token)) return true;
    const equals = token.indexOf('=');
    if (equals !== -1 && GIT_SEPARATOR_INLINE_VALUE_OPTION.has(token.slice(0, equals))) return true;
    if (verb === 'ls-files') return /^-[ztvfcdmoisku]+$/.test(token);
    if (verb === 'ls-tree') return /^-[rdtlz]+$/.test(token);
    if (verb === 'status') return /^-[sbzv]+$/.test(token);
    if (verb === 'diff' || verb === 'log' || verb === 'show') return /^-[pucsrRabwzW]+$/.test(token);
    return false;
  });
  return proven ? prefix : tail;
}

const GIT_BRANCH_DISPLAY_OPTION = new Set([
  '--all', '--remotes', '--verbose', '--no-verbose', '--quiet', '--no-quiet',
  '--ignore-case', '--no-ignore-case', '--omit-empty', '--no-omit-empty',
  '--no-color', '--no-column', '--no-abbrev', '--no-format', '--no-sort',
]);
const GIT_BRANCH_OPTIONAL_INLINE_VALUE = new Set(['--color', '--column', '--abbrev']);
const GIT_BRANCH_COMMIT_FILTER = new Set(['--contains', '--no-contains', '--merged', '--no-merged']);

// Branch needs argv interpretation: `--contains HEAD` consumes a commit,
// `--format --delete` consumes literal display text, and `--list main` consumes
// a pattern. Display/sort options alone do NOT force listing: `--format=x new`
// creates a branch. Track the independent listing modes and their resets, so
// `--list --no-list new` and `--points-at HEAD --no-points-at new` still deny.
//
// Every option must be an exact known read option. Unknown flags (including
// Git's abbreviations), creation/configuration options, and mutating short
// groups fail closed. Option values and operands after `--` are data, so they
// must not be rescanned as flags. Options may follow a pattern, just as in Git.
// This receives only the complete decoded argv; a raw-string presence check
// for `--list` would lose both shell boundaries and Git's mode changes.
function gitBranchEvidenceArgsSafe(tail) {
  let explicitList = false;
  let commitFilter = false;
  let pointsAt = false;
  let showCurrent = false;
  let positionalCount = 0;
  let endOfOptions = false;
  for (let index = 0; index < tail.length; index += 1) {
    const token = tail[index];
    if (endOfOptions || !token.startsWith('-') || token === '-') {
      positionalCount += 1;
      continue;
    }
    if (token === '--') {
      endOfOptions = true;
      continue;
    }
    if (!token.startsWith('--')) {
      if (!/^-[arvliqh]+$/.test(token)) return false;
      if (token.includes('l')) explicitList = true;
      continue;
    }
    const equals = token.indexOf('=');
    const option = equals === -1 ? token : token.slice(0, equals);
    if (GIT_BRANCH_OPTIONAL_INLINE_VALUE.has(option)) continue;
    if (GIT_BRANCH_COMMIT_FILTER.has(option)) {
      commitFilter = true;
      // Git defaults these filters to HEAD only at the end of argv. A next
      // word, including one beginning with '-', is consumed as the commit.
      if (equals === -1 && index + 1 < tail.length) index += 1;
      continue;
    }
    if (option === '--format' || option === '--sort' || option === '--points-at') {
      if (equals === -1) {
        if (index + 1 === tail.length) return false;
        index += 1;
      }
      if (option === '--points-at') pointsAt = true;
      continue;
    }
    if (equals !== -1) return false;
    if (option === '--list' || option === '--no-list') {
      explicitList = option === '--list';
    } else if (option === '--show-current' || option === '--no-show-current') {
      showCurrent = option === '--show-current';
    } else if (option === '--no-points-at') {
      pointsAt = false;
    } else if (!GIT_BRANCH_DISPLAY_OPTION.has(option)) {
      return false;
    }
  }
  return positionalCount === 0 || explicitList || commitFilter || pointsAt || showCurrent;
}

// Takes the full parsed argv, including `git <verb>`. Non-git evidence returns
// true and is checked by its own recognizer. Branch uses its bounded parser;
// other recognized Git verbs refuse output-file flags before the path separator.
export function gitEvidenceArgsSafe(tokens) {
  const verb = tokens?.[0] === 'git' ? tokens[1] : undefined;
  if (!GIT_EVIDENCE_VERB_TOKEN.has(verb)) return true;
  const tail = tokens.slice(2);
  if (verb === 'branch') return gitBranchEvidenceArgsSafe(tail);
  // Check every word of the proven option prefix, including values: log
  // --format --output=file can create the file before its format error.
  const options = gitProvenOptionPrefix(verb, tail);
  if (options.some((token) =>
    GIT_OUTPUT_FLAG.test(token) && !(verb === 'ls-files' && gitLsFilesShortOptionsSafe(token)),
  )) return false;
  return true;
}

// The following regex handles UNQUOTED directory targets. Complete quoted
// targets use literalCdPrefix through leadingEvidenceCd below; their quoted
// characters are literal data rather than shell expansions.
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
// A directory whose name contains `~` or `^` requires literal quoting through
// leadingEvidenceCd; adding `./` alone does not suppress expansion. Under
// `extended_glob` the exposure this buys back is BOUNDED
// rather than closed everywhere — `~`/`^` still carry pattern meaning mid-token
// in ORDINARY operands, which is published residual R8 in docs/hooks.md.
export const LEADING_CD = /^\s*cd\s+([A-Za-z0-9\-_.\/:=@,%+\u{80}-\u{10FFFF}]+)\s*&&\s*(.+)$/su;

// Both the policy's remainder check and the hook's cwd check use this same
// prefix boundary. Quoted targets are literal directory names; unquoted targets
// retain their existing restricted spelling and expansion checks.
export function leadingEvidenceCd(command) {
  if (typeof command !== 'string') return null;
  const literal = literalCdPrefix(command);
  if (literal) return literal;
  const match = LEADING_CD.exec(command);
  return match ? { target: match[1], remainder: match[2], quoted: false } : null;
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
// `cd <dir> &&` prefix was stripped. It uses the same leadingEvidenceCd helper
// as the policy's stripLeadingCd, so both agree where the prefix ends. The target
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
  const relocation = leadingEvidenceCd(command);
  const cdTarget = relocation?.target ?? null;
  const remainder = relocation?.remainder ?? command;
  // The unquoted cd target faces the same predicate as the remainder: alphabet, hazard
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
  // costs nothing and keeps ONE predicate answering for both unquoted halves.
  // A complete quoted target has already passed literalCdPrefix; only hazard
  // checks remain here, followed by the same path and realpath containment.
  if (
    cdTarget !== null &&
    (NON_ASCII_HAZARD.test(cdTarget) ||
      (!relocation.quoted && (EVIDENCE_TOKEN_CHAR_REFUSED.test(cdTarget) ||
        EVIDENCE_EXPANSION_POSITION.test(cdTarget))))
  ) {
    return null;
  }
  const literalWords = literalInspectionWords(remainder);
  if (
    literalWords &&
    ['cat', 'ls', 'rg', 'grep', 'head', 'tail', 'git'].includes(literalWords[0].value) &&
    literalWords.every(({ value, quoted }) => quoted
      ? !NON_ASCII_HAZARD.test(value)
      : evidenceTokenUsesPositiveAlphabet(value) && !EVIDENCE_EXPANSION_POSITION.test(value))
  ) {
    return { cdTarget, tokens: literalWords.map((word) => word.value), literal_inspection: true };
  }
  const rawTokens = remainder.trim().split(/ +/).filter(Boolean);
  if (rawTokens.length === 0) return null;
  const tokens = [];
  // The expansion positions (see the note above the head tables): `~`, `=` or
  // `^` at token start, and BOTH `~` and `=` straight after `=` or `:`.
  for (const [index, rawToken] of rawTokens.entries()) {
    const decoded = decodeEvidenceToken(rawToken, {
      allowStaticQuotedOperand:
        index > 0 && STATIC_QUOTED_OPERAND_HEAD.has(rawTokens[0]),
    });
    if (!decoded) return null;
    // Expansion positions apply only to unquoted words. A narrowly admitted
    // bracket path was single-quoted in the actual shell command, so zsh hands
    // the program this literal token and performs no word-level expansion.
    if (!decoded.quoted && EVIDENCE_EXPANSION_POSITION.test(decoded.token)) return null;
    tokens.push(decoded.token);
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
// `--`) cost nothing. A conventional long --option=value has an explicit value
// boundary: resolve that complete value once. Treating its first slash as a
// second sticky operand would turn --config=./x.mjs into the invented absolute
// path /x.mjs. Malformed long option names and sticky short flags still face
// the conservative extraction below; no particular flag name is privileged.
export function evidenceOperandCandidates(token) {
  if (typeof token !== 'string' || token.length === 0) return [];
  const candidates = [];
  const equals = token.indexOf('=');
  if (equals >= 0 && equals + 1 < token.length) candidates.push(token.slice(equals + 1));
  if (/^--[A-Za-z0-9][A-Za-z0-9_-]*=/.test(token)) return candidates;
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

// `git diff` does not include an untracked file in its ordinary tree diff, so
// an independent reviewer naturally renders that file with:
//
//   git diff --no-index /dev/null <in-tree-path>
//
// `/dev/null` is outside every governed project, but in this one exact position
// it is a read-only empty-file sentinel rather than project input. Keep the
// exception command-shaped and operand-shaped: exactly five tokens, or exactly
// six with one `--` end-of-options separator before the operands; exactly
// `git diff --no-index`; exactly one `/dev/null` comparison operand; and a
// non-option companion operand. The companion still traverses the ordinary
// lexical and realpath containment checks. `/dev/nullish`, traversal through
// `/dev/null`, redirects, extra flags, and every other external path therefore
// remain denied. Exported so the synchronous policy and async hook precompute
// skip the same candidate and cannot disagree before execution.
export function evidenceOperandIsGitNoIndexDevNull(tokens, tokenIndex, candidate) {
  const operandStart = tokens?.length === 5
    ? 3
    : tokens?.length === 6 && tokens[3] === '--'
      ? 4
      : null;
  if (
    !Array.isArray(tokens) ||
    operandStart === null ||
    tokens[0] !== 'git' ||
    tokens[1] !== 'diff' ||
    tokens[2] !== '--no-index' ||
    (tokenIndex !== operandStart && tokenIndex !== operandStart + 1) ||
    tokens[tokenIndex] !== '/dev/null' ||
    candidate !== '/dev/null'
  ) {
    return false;
  }
  const companion = tokens[tokenIndex === operandStart ? operandStart + 1 : operandStart];
  return companion !== '/dev/null' && !companion.startsWith('-');
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
