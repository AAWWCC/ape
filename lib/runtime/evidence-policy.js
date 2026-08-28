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
import { NON_ASCII_HAZARD, normalizePath } from './write-policy.js';

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
  'npm/pnpm/yarn/bun: bare `test` and `t` in every tier, but only as COMPLETE tokens (`test:e2e`, `test-ci`, `t-deploy`, `test.unit` are package scripts, not the bare form, and are refused); `run <script>` unrestricted on a WRITABLE ticket, and on a read-only ticket only the script names this project itself declares (its configured test_commands and runners[].profile commands, plus policy.evidence_scripts) — the deny reason names the exact set admitted for your ticket; vitest/jest/mocha/ava/playwright/tap/tsc/pytest runners, bare or via npx/pnpm/yarn/bun; node --test|--check|--version; python -m pytest|unittest; uv/poetry/pdm/hatch/rye/pipenv/pixi run with a pytest or python -m test tail; hatch|rye test; tox; go test; cargo test; read-only git (status|diff|log|show|rev-parse|branch|describe|ls-files|ls-tree — listing-only branch, no --output/-o file flags); ls|pwd|cat|echo|true|which plus sha256sum|shasum checksum evidence; bare env (no operands); check-only linters (ruff|flake8|mypy|pylint|black|isort|eslint|prettier); at most one leading `cd <dir> &&` prefix; every command head is matched as an EXACT whitespace token, so `<head>-pwn`, `<head>.pwn` and `<head>:pwn` are different programs and are refused; every character is checked against a positive ALLOWLIST, so anything outside it — every shell metacharacter, a NUL byte, an invisible format character, any whitespace other than a plain space — refuses the WHOLE command: the admitted alphabet is A-Za-z0-9, the punctuation `- _ . / : = @ ~ , % ^ +`, and non-ASCII code points by range (so an accented or CJK path is admitted), with a single plain space as the only separator; three of those characters EXPAND at the start of a token, so a token beginning with `~`, `=` or `^` is refused there, and `~` and `=` are refused straight after a `=` or a `:` inside a token as well, while each of them stays admitted in every other position; a `cd` relocation target additionally may not begin with `-` or `+`, which name directory-stack entries rather than paths; a `cd` target may not carry `~` or `^` ANYWHERE either — in a path both are EXTENDED_GLOB pattern operators and the target is the one operand that relocates the whole command — so its alphabet is the token alphabet minus those two; no operand — a bare token, the `=`-suffix of a flag, or a path stuck onto a short flag — may name a path outside the governed project, except the exact `/dev/null` comparison operand in the exact five-token `git diff --no-index <path> <path>` form; a relocation flag is refused by its OPERAND and never by its spelling; chaining, redirects, and inline interpreters are denied';

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
]);

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
export const LEADING_CD = /^\s*cd\s+([A-Za-z0-9\-_.\/:=@,%+\u{80}-\u{10FFFF}]+)\s*&&\s*(.+)$/su;

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

// `git diff` does not include an untracked file in its ordinary tree diff, so
// an independent reviewer naturally renders that file with:
//
//   git diff --no-index /dev/null <in-tree-path>
//
// `/dev/null` is outside every governed project, but in this one exact position
// it is a read-only empty-file sentinel rather than project input. Keep the
// exception command-shaped and operand-shaped: exactly five tokens, exactly
// `git diff --no-index`, exactly one `/dev/null` comparison operand, and a
// non-option companion operand. The companion still traverses the ordinary
// lexical and realpath containment checks. `/dev/nullish`, traversal through
// `/dev/null`, redirects, extra flags, and every other external path therefore
// remain denied. Exported so the synchronous policy and async hook precompute
// skip the same candidate and cannot disagree before execution.
export function evidenceOperandIsGitNoIndexDevNull(tokens, tokenIndex, candidate) {
  if (
    !Array.isArray(tokens) ||
    tokens.length !== 5 ||
    tokens[0] !== 'git' ||
    tokens[1] !== 'diff' ||
    tokens[2] !== '--no-index' ||
    (tokenIndex !== 3 && tokenIndex !== 4) ||
    tokens[tokenIndex] !== '/dev/null' ||
    candidate !== '/dev/null'
  ) {
    return false;
  }
  const companion = tokens[tokenIndex === 3 ? 4 : 3];
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
