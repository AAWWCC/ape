import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { evaluateLifecyclePolicy } from '../lib/runtime/hooks.js';
// NAMESPACE import, deliberately, for the same reason the sibling shell-policy
// suite uses one: a named ESM import of a binding this module may not export yet
// is a LINK-time error that takes the whole file down with one opaque message,
// while a namespace property read is `undefined` and only the arms that depend
// on the new surface go red.
import * as hooks from '../lib/runtime/hooks.js';

// ===========================================================================
// ROADMAP ENTRY evidence-metachar-refusal-is-still-a-blocklist.
//
// THE DEFECT, and it is a LIVE BYPASS, not a hygiene complaint. Step (1) of the
// bound-subagent evidence gate refuses a command carrying any character in
// EVIDENCE_UNSAFE_CHARS. That is a NEGATIVE assertion over a CHARACTER space —
// the same failure shape as the four bypasses the tokenize-then-allowlist
// rebuild closed, one level down — and round 5 already caught it
// under-enumerating by three (`#`, `!`, U+0000). The spike commissioned to
// derive the positive replacement (run-fixture-d578507b4795, receipt
// d121cd29) found the SIXTH instance by RUNNING the enforced rule:
//
//   echo =ls     ALLOWED, and the shell printed  /bin/ls
//   echo =node   ALLOWED, and the shell printed  /opt/homebrew/bin/node
//   ls -l =node  ALLOWED, and the shell listed a path OUTSIDE the governed tree
//
// MECHANISM: zsh EQUALS expansion. A word beginning with `=` is replaced by the
// full path of the command it names. `evidenceOperandNeedsRoot` sees `=node` as
// relative and dotdot-free, so BOTH the synchronous containment check and the
// async realpath precompute contain it LEXICALLY — while the shell hands the
// program an absolute path outside the project. acme PR #368's published rule ("no
// operand of an evidence command may name a path outside the governed project")
// is FALSE of the tree that publishes it.
//
// Re-verified live in THIS run, on the inert `echo` head only:
//   `echo =ls` printed `/bin/ls`; `echo a=ls --rootdir=ls a:=ls HEAD^ ^x`
//   printed itself verbatim, so the expansion really is POSITIONAL.
//   `git log ^main master --oneline -n 2` was ADMITTED (git itself then
//   rejected the missing `master` ref), so `^` at token start is admitted today.
//   `echo café-naïve-Ω tests/日本語/a🙂b.test.js` was ADMITTED, so non-ASCII is
//   admitted today and refusing it would be a REGRESSION, not a hypothetical.
//
// WHAT THIS SUITE PINS: the replacement of that blocklist with a POSITIVE
// PER-TOKEN CHARACTER ALLOWLIST, and — the half that makes the replacement safe
// — the over-block corpus it may not take down. A positive rule closes the
// under-enumeration class BY CONSTRUCTION (an unforeseen character now DENIES),
// so the whole risk moves to over-blocking, and every arm below is paired:
// nothing is refused without the legitimate command that must survive it.
//
// THE ADMITTED SET, derived by the spike and VERIFIED here rather than taken on
// trust — every row of CHARACTER_INVENTORY carries the concrete admitted
// command that earns its character a place:
//
//   A-Za-z0-9  and  - _ . / : = @ ~ , % ^ +
//   U+0020, the sole structural separator (runs of it are fine)
//   every code point >= U+0080 EXCEPT non-space whitespace, \p{Cc}, \p{Cf},
//   \p{Cs}
//
// plus POSITIONAL refusals on top, which is where the whole security content
// sits: `^[~=^]` — a token BEGINNING with `~`, `=` or `^` — and `[=:][~=]`,
// which refuses BOTH `~` and `=` straight after a `=` or a `:` inside a token.
// Each of the three stays admitted in every OTHER position, which is what keeps
// `git log HEAD~3`, `git log HEAD^` and `pytest --rootdir=tests` alive.
//
// THE `cd` RELOCATION TARGET IS NOT GOVERNED BY THAT ONE ALPHABET. It is the
// single operand that moves the WHOLE execution in one admitted command, so it
// carries two refusals on top of everything above, and this suite models it as
// its OWN set rather than reusing the token predicate for both halves of a
// `cd <target> && <command>`:
//
//   * ITS ALPHABET DROPS `~` AND `^` OUTRIGHT. Both are admitted mid-token in
//     an ordinary operand and refused ANYWHERE in a target, because under
//     `setopt EXTENDED_GLOB` they are PATTERN operators there — the gate would
//     resolve the LITERAL target while the shell resolved a GLOB.
//   * A TARGET MAY NOT BEGIN WITH `-` OR `+`. That one is POSITIONAL, not a
//     membership question: `-`/`+` name zsh directory-stack entries rather than
//     paths, and `cd ./+build && npm test` stays admitted.
//
// Both are pinned, with their paired over-block guards, in the `cd` relocation
// describe below.
//
// THE ENTRY'S OWN PROPOSED FLOOR (`- _ . / : @ = + , %`) IS NOT THE ANSWER, and
// this is the reason the spike was worth running. It OMITS `~` (three pinned
// allow arms in two suites), omits `^` (`git log HEAD^`, admitted today), and is
// ASCII by construction, so it would lock out every project under an accented or
// CJK path — an invariant-6 violation AND a regression against verified
// behavior. And it CONTAINS one member that is not safe as given: `=`, which is
// exactly the live bypass above. A phase that took that floor on trust would
// have shipped the same bypass under a stronger-sounding name.
//
// WHAT THIS CANNOT CLAIM, and the docs arms at the bottom pin the disclosure:
// the set was derived against ONE host shell (zsh, via an `eval` wrapper in a
// persistent session — the `(eval):1:` error prefix is zsh's format), and zsh's
// word-level expansion set is a strict SUPERSET of bash's. Under
// `setopt EXTENDED_GLOB` — UNSET in the observed session, but common in shipped
// profiles, and the host sources the operator's profile — `^`, `#` and `~`
// become glob operators. The special-character set is therefore partly
// OPERATOR-CONFIGURABLE. `~` and `^` mid-token are NARROWED, not closed.
// ===========================================================================

const state = { status: 'running' };

// The WRITABLE tier, and no project_dir — the same posture the sibling
// shell-policy suite uses and for the same reason: the character rule is
// TIER-INDEPENDENT, so proving a DENIAL in the permissive tier is the strictly
// stronger claim, and proving an ALLOW here says nothing a read-only ticket
// could contradict except through the run-script tier, which no arm below
// exercises. The read-only half of Finding 1 is pinned once, against a real
// project root, in __tests__/runtime-v2-evidence-command-script-allowlist.test.js.
const writableTicket = Object.freeze({
  ticket_id: 'run-1:build:b',
  role: 'implementer',
  writable: true,
  test_paths: ['__tests__'],
  claimed_paths: ['lib'],
});

const decide = (command) =>
  evaluateLifecyclePolicy(
    {
      host: 'claude',
      is_subagent: true,
      ape_managed: true,
      tool_name: 'Bash',
      command,
    },
    { state, ticket: writableTicket },
  );

// Every arm takes an EXPLICIT label instead of interpolating the command into
// the assertion message: several deny arms carry a lone surrogate or an
// invisible format character, and a message built from those is either
// unreadable or re-encoded by the reporter, which turns a real failure into an
// unactionable one.
const expectAllow = (command, label = command) =>
  expect(decide(command).decision, label).toBe('allow');
const expectDeny = (command, label = command) =>
  expect(decide(command).decision, label).toBe('deny');

// ---------------------------------------------------------------------------
// The admitted alphabet, expressed as a PREDICATE rather than as a copy of any
// production constant. These arms are behavioral: they assert what the gate
// ADMITS and REFUSES, never how the refusal is spelled, so an implementation
// that reaches the same verdicts with different regexes is green.
// ---------------------------------------------------------------------------
const ADMITTED_ASCII_ALPHANUMERIC =
  'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
const ADMITTED_ASCII_PUNCTUATION = '-_./:=@~,%^+';
// THE `cd` RELOCATION TARGET GETS ITS OWN ALPHABET, and modeling it as one
// rather than reusing the token alphabet for both halves is what keeps the
// corpus-consistency guard below HONEST. `~` and `^` are admitted MID-TOKEN in
// an ordinary operand — `git log HEAD~3` and `git log HEAD^` are pinned rows of
// the inventory — and refused ANYWHERE in a relocation target, because under
// `setopt EXTENDED_GLOB` they are PATTERN operators there. One predicate
// answering for both halves would certify a corpus entry carrying `~` in its
// target as "in the admitted set" while the gate denies it, which is precisely
// the two-halves drift the guard exists to catch.
//
// The target's OTHER refusal — a leading `-` or `+`, the zsh directory-stack
// form — is POSITIONAL rather than a membership question, so both characters
// stay in this alphabet and `cd ./+build && npm test` stays admitted.
const CD_TARGET_ADMITTED_PUNCTUATION = [...ADMITTED_ASCII_PUNCTUATION]
  .filter((character) => !'~^'.includes(character))
  .join('');
const ADMITTED_ASCII = ADMITTED_ASCII_ALPHANUMERIC + ADMITTED_ASCII_PUNCTUATION;
const CD_TARGET_ADMITTED_ASCII =
  ADMITTED_ASCII_ALPHANUMERIC + CD_TARGET_ADMITTED_PUNCTUATION;
const NON_SPACE_WHITESPACE = /[^\S ]/u;
const UNAUDITABLE_CATEGORY = /[\p{Cc}\p{Cf}\p{Cs}]/u;

// ONE predicate, parameterized by the ASCII alphabet in force AT THAT POSITION.
// The non-ASCII half is deliberately IDENTICAL on both sides: a package
// directory under an accented or CJK path has to be reachable with `cd` too, or
// the narrowing becomes an invariant-6 lockout by the back door.
function admittedBy(asciiAlphabet) {
  return function admitted(character) {
    if (character === ' ') return true;
    if (asciiAlphabet.includes(character)) return true;
    // Below U+0080 the ASCII list above is exhaustive by construction.
    if (character.codePointAt(0) < 0x80) return false;
    // ADMIT BY RANGE, with three carve-outs, each for a reason that is about the
    // BYTES the shell receives rather than about the character's appearance:
    // non-space whitespace tokenizes differently from the shell; \p{Cc} carries
    // U+0000, which truncates argv at execve; \p{Cf} (U+200B, U+00AD, U+202E) is
    // invisible, so operands and deny reasons become unauditable; \p{Cs} is a
    // LONE SURROGATE, whose UTF-8 encoding substitutes U+FFFD — the bytes the
    // shell receives are then not the code points the gate inspected.
    if (NON_SPACE_WHITESPACE.test(character)) return false;
    if (UNAUDITABLE_CATEGORY.test(character)) return false;
    return true;
  };
}
const characterAdmitted = admittedBy(ADMITTED_ASCII);
const cdTargetCharacterAdmitted = admittedBy(CD_TARGET_ADMITTED_ASCII);

// Split a corpus command into the strings the alphabet rule applies to, EACH
// PAIRED WITH THE PREDICATE THAT GOVERNS IT. `&&` is NOT in the admitted
// alphabet: the leading `cd <target> &&` prefix is consumed LITERALLY before
// the alphabet check, so the check is only ever applicable to the two halves
// separately — and the two halves do NOT answer to the same set (see
// CD_TARGET_ADMITTED_PUNCTUATION above). This split is the test's own, built
// from the literal shape the corpus uses, so nothing here re-implements
// LEADING_CD.
const LEADING_CD_SHAPE = /^ *cd +([^ ]+) +&& +/;
function alphabetParts(command) {
  const relocation = LEADING_CD_SHAPE.exec(command);
  return relocation
    ? [
        { text: relocation[1], admits: cdTargetCharacterAdmitted, label: 'the `cd` target of' },
        {
          text: command.slice(relocation[0].length),
          admits: characterAdmitted,
          label: 'the post-`cd` remainder of',
        },
      ]
    : [{ text: command, admits: characterAdmitted, label: 'the command' }];
}

// Exotic characters are built NUMERICALLY, never written as literals: a literal
// U+00A0 or U+200B in a source file is one normalizing editor away from a plain
// space or from nothing at all, which would silently turn a deny arm into a
// contradiction of its own allow half. Same discipline as the NBSP helper in
// __tests__/runtime-v2-hook-shell-policy.test.js.
const codepoint = (value) => String.fromCharCode(value);
const ZERO_WIDTH_SPACE = codepoint(0x200b); // Cf — invisible, not \s
const SOFT_HYPHEN = codepoint(0x00ad); // Cf — invisible, not \s
const RIGHT_TO_LEFT_OVERRIDE = codepoint(0x202e); // Cf — reorders the display
const LONE_SURROGATE = codepoint(0xd800); // Cs — no UTF-8 encoding
const CONTROL_SOH = codepoint(0x0001); // Cc, and not whitespace
const NBSP = codepoint(0x00a0); // non-space whitespace, already refused

describe('APE v2 evidence commands: a POSITIVE per-token character allowlist', () => {
  // =========================================================================
  // THE INVENTORY. One row per admitted character, each carrying the CONCRETE
  // command that earns it a place, so nothing is admitted on faith and a future
  // narrowing of the set names the evidence it costs. The rows are the whole of
  // the over-block argument: the set was chosen because every one of these is
  // ADMITTED TODAY and must stay admitted.
  // =========================================================================
  const CHARACTER_INVENTORY = Object.freeze([
    Object.freeze({
      character: 'A-Za-z',
      commands: Object.freeze(['npm test', 'git show HEAD']),
    }),
    Object.freeze({
      character: '0-9',
      commands: Object.freeze([
        'git log --oneline -n 5',
        'tox -e py312',
        'git show 4f5e65d1:lib/runtime/hooks.js',
      ]),
    }),
    Object.freeze({
      character: '-',
      commands: Object.freeze([
        'ls -la',
        'git rev-parse HEAD',
        'npx vitest run --no-file-parallelism',
      ]),
    }),
    Object.freeze({
      character: '_',
      commands: Object.freeze(['npx vitest run __tests__/x.test.js']),
    }),
    Object.freeze({
      character: '.',
      commands: Object.freeze(['go test ./...', 'cargo test --manifest-path ./Cargo.toml']),
    }),
    Object.freeze({
      character: '/',
      commands: Object.freeze(['ruff check src/', 'git show HEAD~1:lib/runtime/hooks.js']),
    }),
    Object.freeze({
      character: ':',
      commands: Object.freeze([
        'git show 4f5e65d1:lib/runtime/hooks.js',
        'uv run pytest -p no:randomly',
      ]),
    }),
    // MID-TOKEN ONLY. The `^=` position is the live bypass this entry closes;
    // see the positional arms below.
    Object.freeze({
      character: '=',
      commands: Object.freeze(['pytest --rootdir=tests', 'npx playwright test --workers=1']),
    }),
    // Already positional today, and the reason a wholesale `~` refusal was
    // rejected when the tokenize-then-allowlist gate shipped.
    Object.freeze({
      character: '~',
      commands: Object.freeze(['git log HEAD~3', 'git diff HEAD~1']),
    }),
    // Both name grammars are `^[\w:@./][\w:@./-]*$`, so a scoped script name is
    // a legitimate `<pm> run` operand.
    Object.freeze({
      character: '@',
      commands: Object.freeze(['npm run @scope/build']),
    }),
    Object.freeze({
      character: '%',
      commands: Object.freeze(['git log --pretty=format:%h']),
    }),
    Object.freeze({
      character: ',',
      commands: Object.freeze(['git log --pretty=format:%h,%s', 'cargo test --features a,b']),
    }),
    // The WEAKEST attestation in the table, and said so rather than dressed up:
    // no allow arm in either suite needs `+` today. It is admitted because
    // SemVer build-metadata tags are legal git refs, so a project that tags
    // `v2.10.1+ci.4` cannot otherwise `git show` its own release.
    Object.freeze({
      character: '+',
      commands: Object.freeze(['git show v2.10.1+ci.4']),
    }),
    // MID/END-TOKEN ONLY, for the same reason as `=`.
    Object.freeze({
      character: '^',
      commands: Object.freeze(['git log HEAD^ --oneline -n 1', 'git show HEAD^:package.json']),
    }),
    Object.freeze({
      character: 'U+0020',
      commands: Object.freeze(['npm  test', 'cd sub   &&   mypy src/']),
    }),
    // ADMITTED BY RANGE. Refusing this is a total lockout for any project under
    // an accented or non-Latin path — invariant 6 — and a regression against
    // behavior verified live in this run.
    Object.freeze({
      character: 'non-ASCII',
      commands: Object.freeze(['echo café-naïve-Ω', 'echo tests/日本語/a🙂b.test.js']),
    }),
  ]);

  const ALLOW_CORPUS = Object.freeze([
    ...new Set([
      ...CHARACTER_INVENTORY.flatMap((row) => row.commands),
      // The union with the pre-existing allow arms of both evidence suites.
      // THIS IS THE HALF THAT MAKES THE CHANGE SAFE: a positive character rule
      // can only fail by over-blocking, and the measured over-block cost is the
      // difference between this corpus and the set the rule admits. It was
      // measured at ZERO — no allow arm anywhere carries a `=`-initial,
      // `^`-initial or `~`-initial token, and every legitimate `=` in the
      // corpus is mid-token.
      'npm t',
      'npm test -- --silent',
      'npm run bundle',
      'npm run test',
      'pnpm test',
      'yarn test',
      'bun test',
      'bun test src/x.test.ts',
      'bun test ./src/x.test.ts --coverage',
      'npx vitest run runtime-v2-statusline',
      'pnpm vitest --dir tests',
      'npx vitest --config ./x.mjs',
      'node --test __tests__/x.test.mjs',
      'node --check src/index.js',
      'python3 -m pytest',
      'uv run pytest tests/test_foo.py -q',
      'uv run python -m pytest',
      'poetry run pytest',
      'hatch test',
      'rye test',
      'tox',
      'go test ./...',
      'cargo test',
      'git status',
      'git diff --stat',
      'git branch --show-current',
      'git ls-files',
      'git ls-tree --name-only HEAD src/index.js',
      'git show 4f5e65d1 -- lib/runtime/hooks.js',
      'git log main..HEAD',
      'cat package.json',
      'ls -la',
      'echo hi',
      'pwd',
      'which node',
      'true',
      'env',
      'ruff check',
      'ruff format --check src/',
      'ruff --version',
      'mypy src/',
      'pylint src/module.py',
      'black --check .',
      'isort --check-only src/',
      'npx eslint src/',
      'pnpm exec eslint .',
      'bun x prettier --check src/',
      'flake8 --version',
      'cd packages/api && uv run pytest',
      'cd ./nested/pkg && pytest -q',
      'cd services/web && ruff check src/',
      'cd sub && npm test --silent',
      // The `cd`-target over-block guards, in the corpus so the whole-corpus
      // allow arm and the position-aware consistency guard both cover them: a
      // directory whose NAME carries `+` or `-` is still reachable, and the
      // remainder of a relocated command still gets the FULL token alphabet
      // (`~` mid-token) that the target itself does not.
      'cd ./+build && npm test',
      'cd ./-build && npm test',
      'cd sub && git log HEAD~3',
    ]),
  ]);

  describe('the inventory: every admitted character earns its place', () => {
    it('ADMITS the concrete command named for every row of the inventory', () => {
      // GUARD (2). Row by row, so a narrowing of the set names exactly which
      // evidence form it costs instead of failing as one opaque corpus.
      for (const { character, commands } of CHARACTER_INVENTORY) {
        for (const command of commands) {
          expectAllow(command, `${character}: ${command}`);
        }
      }
    });

    it('ADMITS the whole frozen allow corpus — the measured over-block cost is ZERO', () => {
      // GUARD (1). The union of the inventory and the pre-existing allow arms
      // of both evidence suites. Every entry is admitted TODAY; the positive
      // rule must admit all of them still, which is the entire content of "the
      // over-block risk was discharged" rather than deferred again.
      for (const command of ALLOW_CORPUS) expectAllow(command);
    });

    it('is INTERNALLY CONSISTENT: every character of the corpus is in its position\'s set', () => {
      // Non-vacuity for the predicate itself. If the corpus quietly relied on a
      // character the set does not name, the two halves of this suite would be
      // asserting different rules and the deny arms below would be unsound.
      //
      // POSITION-AWARE, and that is load-bearing rather than fussy: the `cd`
      // relocation target answers to a NARROWER alphabet than the remainder, so
      // a guard that applied one predicate to both halves would certify a
      // corpus entry carrying `~` or `^` in its target as admitted while the
      // gate denies it — the guard would then be endorsing exactly the drift it
      // exists to detect.
      for (const command of ALLOW_CORPUS) {
        for (const { text, admits, label } of alphabetParts(command)) {
          for (const character of text) {
            expect(
              admits(character),
              `${label} ${JSON.stringify(command)} carries ${JSON.stringify(character)}, ` +
                'which the admitted set for that position does not name',
            ).toBe(true);
          }
        }
      }
    });

    it('names `~`, `^` and non-ASCII, which the roadmap entry\'s proposed floor omits', () => {
      // The entry proposed the floor `- _ . / : @ = + , %`. Adopting it verbatim
      // would turn six pinned assertions red (`git log HEAD~3`, `git diff
      // HEAD~1`, `git show HEAD~1:<path>` in two suites each), deny `git log
      // HEAD^` (admitted today), and lock out every project under a non-ASCII
      // path. This arm is the derivation's disagreement with the entry, pinned
      // as behavior so the floor cannot be adopted silently.
      for (const character of ['~', '^']) {
        expect(ADMITTED_ASCII_PUNCTUATION).toContain(character);
      }
      expectAllow('git log HEAD~3');
      expectAllow('git log HEAD^ --oneline -n 1');
      expectAllow('echo café-naïve-Ω');
    });
  });

  // =========================================================================
  // FINDING 1 — THE LIVE BYPASS, and the shape of its closure.
  //
  // THE CLOSURE IS POSITIONAL, exactly like the existing tilde rule, because
  // the expansion is. Verified inert and literal in this run:
  //     echo a=ls          -> a=ls          (not mid-token)
  //     echo --rootdir=ls  -> --rootdir=ls  (not after a flag name)
  //     echo a:=ls         -> a:=ls         (not after `:`)
  // Only a token that BEGINS with `=` expands. So the refusal is `^=`, and the
  // paired allow half proves it is positional rather than a `=` blocklist —
  // which would deny `pytest --rootdir=tests`, `npx playwright test
  // --workers=1` and every `=`-suffixed operand the containment rule is built
  // to read.
  // =========================================================================
  describe('finding 1: a token beginning with `=` is refused (zsh EQUALS expansion)', () => {
    it('DENIES a `=`-initial token, which the shell replaces with an out-of-tree path', () => {
      for (const command of [
        // The inert instances the spike VERIFIED LIVE against the running gate.
        'echo =ls',
        'echo =node',
        'ls -l =node',
        // The same character in the positions where it is a real escape: an
        // operand of a recognized runner, and a relocation the containment rule
        // believes it has contained.
        'cat =node',
        'pytest =node',
        'npm test --prefix =node',
        'npx vitest run =node',
        'node --test =node',
        // The `cd` target, which is the sharpest instance: LEADING_CD's negated
        // class admits `=`, so `=x` reads as a relative dotdot-free target that
        // needs no root — NEITHER the lexical containment check NOR the realpath
        // precompute ever resolves it — while the shell relocates the persistent
        // session shell to the directory of whatever program `x` names. Pinned
        // as a DECISION only; never executed.
        'cd =x && npm test',
        'cd =node && pytest',
      ]) {
        expectDeny(command);
      }
    });

    it('points a positional refusal back to the published token alphabet', () => {
      // The full family contract remains in the immutable ticket; the hook
      // keeps its denial compact so retry summaries retain the exact command.
      const denied = decide('ls -l =node');
      expect(denied.decision).toBe('deny');
      expect(denied.reason).toContain('APE command-shape denied');
      expect(denied.reason).toContain('published token alphabet');
    });

    it('ALLOWS every MID-TOKEN `=`, so the refusal is provably positional', () => {
      // The non-vacuity half. Without it, refusing `=` wholesale would satisfy
      // the arm above while deleting the `=`-suffix operand form that the whole
      // containment rule reads.
      for (const command of [
        'pytest --rootdir=tests',
        'npx playwright test --workers=1',
        'git log --pretty=format:%h',
        'npm test --prefix=sub',
        'npx vitest --dir=tests',
        'cargo test --features a,b',
      ]) {
        expectAllow(command);
      }
    });

    // =======================================================================
    // THE OTHER HALF OF THE SAME zsh RULE — raised as BLOCKING by the review
    // group of this phase, by both the review and the security review, at
    // lib/runtime/hooks.js:412.
    //
    // The positional rule shipped as `^[~=^] | [=:]~`: it refuses `~` straight
    // after `=` or `:` and ADMITS `=` in those same two positions. Those are
    // not two rules that happen to look alike. They are ONE rule, and zsh's
    // manual states it for both characters at once:
    //
    //   FILENAME EXPANSION — the value of an assignment "will be treated as a
    //   colon-separated list in the manner of the PATH parameter, so that a
    //   `~` or an `=` following a `:` is eligible for expansion".
    //   MAGIC_EQUAL_SUBST — extends that same treatment to "any unquoted shell
    //   argument in the form identifier=expression".
    //
    // So the expansion-eligible positions are `^~`, `^=`, `=~`, `==`, `:~` and
    // `:=`, and the tree implements four of the six. The two it admits are the
    // MECHANISM OF FINDING 1 MOVED ONE POSITION OVER, with the same ending:
    // `pytest --rootdir==node` passes the alphabet, passes `^[~=^]`, passes
    // `[=:]~`, and then `evidenceOperandCandidates` yields the `=`-suffix
    // candidate `=node` — relative and dotdot-free, so BOTH the synchronous
    // containment check and the hook's realpath precompute contain it
    // LEXICALLY, while zsh substitutes the absolute path of whatever `node`
    // names. The published rule "no operand may name a path outside the
    // governed project" is false for exactly the same reason it was false
    // before, one character to the left.
    //
    // OPTION-DEPENDENT, AND SAID SO. MAGIC_EQUAL_SUBST is unset in the observed
    // session — `echo a:=ls` printed itself verbatim, which is what let the
    // spike record the position as literal — and the host sources the
    // operator's profile, so this NARROWS the exposure exactly as the `^` half
    // does rather than closing it. The refusal is a cheap over-block bought for
    // a MEASURED cost of ZERO: no row of the inventory, no entry of the frozen
    // allow corpus and no allow arm in either evidence suite carries `==` or
    // `:=` in any position.
    // =======================================================================
    it('DENIES `=` in EVERY expansion position, not only at token start', () => {
      for (const command of [
        // MAGIC_EQUAL_SUBST: the value half of an `identifier=expression`
        // argument, in both the flag spelling and the bare one.
        'pytest --rootdir==node',
        'pytest rootdir==node',
        'npx vitest --dir==node',
        'npm test --prefix==node',
        // The colon-list half: `=` following a `:` inside that value.
        'npx vitest --dir=a:=node',
        'pytest --rootdir=tests:=node',
        'npm test --prefix=sub:=node',
        // Inert instances, the shape the spike probed for the `~` half.
        'echo a==ls',
        'echo a:=ls',
        // The `cd` target, which faces the same predicate as the remainder and
        // is the one operand where the substitution relocates the whole
        // execution rather than needing a second step. DECISION ONLY; never
        // executed.
        'cd a==x && npm test',
        'cd a:=x && npm test',
      ]) {
        expectDeny(command);
      }
    });

    it('ALLOWS a single `=` and a `:` followed by anything else — provably POSITIONAL', () => {
      // The paired half, and the reason the closure may not be "refuse a `=`
      // that follows any punctuation". Every command here is an operand form
      // the containment rule itself reads, and the `:`-bearing ones —
      // `format:%h`, `no:randomly`, `HEAD~1:<path>` — are commands this
      // pipeline's own later stages run. A wholesale refusal of `=` after `:`
      // would take none of them down; a wholesale refusal of `=` after any
      // separator would take all of the first group down. Both halves are
      // asserted so only the positional rule satisfies the pair.
      for (const command of [
        'pytest --rootdir=tests',
        'npx playwright test --workers=1',
        'git log --pretty=format:%h',
        'git log --pretty=format:%h,%s',
        'npm test --prefix=sub',
        'npx vitest --dir=tests',
        'npx vitest --dir=a:b',
        'uv run pytest -p no:randomly',
        'git show 4f5e65d1:lib/runtime/hooks.js',
        'git show HEAD~1:lib/runtime/hooks.js',
        'cd sub && pytest --rootdir=tests',
      ]) {
        expectAllow(command);
      }
    });
  });

  // =========================================================================
  // `^` AT TOKEN START. Under `setopt EXTENDED_GLOB` — unset in the observed
  // session (`echo ^x` printed `^x`) but common in shipped profiles, and the
  // host sources the operator's profile — a leading `^` is a glob EXCLUSION
  // operator. This NARROWS the exposure; it does not close it, because `^`
  // stays admitted mid-token where the same option also gives it meaning, and
  // it cannot be refused there without denying `git log HEAD^`.
  //
  // NAMED REAL COST, so the over-block is a decision rather than an accident:
  // `git log ^main master` is ADMITTED today (verified: the gate passed it and
  // git itself answered) and becomes DENIED. `git log main..HEAD` stays
  // admitted, because the `..` containment check is segment-wise.
  // =========================================================================
  describe('`^` is refused at token start and admitted mid-token', () => {
    it('DENIES a `^`-initial token', () => {
      for (const command of [
        'git log ^main master',
        'git log ^main',
        'git diff ^HEAD',
        'ls ^x',
        'echo ^x',
        'cd ^x && npm test',
      ]) {
        expectDeny(command);
      }
    });

    it('ALLOWS `^` mid-token and end-of-token — git revision syntax', () => {
      for (const command of [
        'git log HEAD^',
        'git log HEAD^ --oneline -n 1',
        'git log HEAD^^',
        'git show HEAD^:package.json',
        'git rev-parse HEAD^',
        // The segment-wise `..` canary, re-pinned here because the caret arms
        // are the ones most likely to be "fixed" with a sloppy substring test.
        'git log main..HEAD',
      ]) {
        expectAllow(command);
      }
    });
  });

  // =========================================================================
  // THE `cd` RELOCATION TARGET — the ONE operand that moves the WHOLE
  // execution in a single admitted command, and therefore the one that carries
  // refusals the rest of the alphabet does not.
  //
  // (A) A TARGET MAY NOT BEGIN WITH `-` OR `+`. zsh's `cd` has a THIRD form,
  //     `cd {+|-}n`, which "extracts an entry from the directory stack, and
  //     changes to that directory": `+n` counts from the LEFT of `dirs`, `-n`
  //     from the RIGHT, and PUSHD_MINUS SWAPS the two spellings — so refusing
  //     one and admitting the other refuses NOTHING AT ALL. Both spellings are
  //     invisible to every containment check the gate runs: `+1` and `-` are
  //     relative and dotdot-free, so the lexical check passes them, and the
  //     hook's unconditional `cd` realpath precompute resolves `<cwd>/+1`,
  //     which nearestExistingPath walks up to a directory INSIDE the root —
  //     ALLOW, while the shell relocates to a stack entry the gate never saw.
  //     The stack must be non-empty for the form to resolve (AUTO_PUSHD, or an
  //     explicit `pushd` in the operator's profile, is what fills it), so this
  //     is OPERATOR-CONFIGURABLE and PRE-EXISTING — but `+` is an ENUMERATED
  //     member of the evidence alphabet now, so admitting it as a relocation
  //     target would be a decision rather than an oversight.
  //
  //     ENFORCEMENT IS CORRECT AND ONLY THE COVERAGE WAS MISSING, which is the
  //     entire reason these arms exist: at the pre-allowlist base the negated
  //     `cd` class admitted `+` and `-`, so BOTH spellings were ADMITTED and no
  //     arm in any of the four evidence suites goes red if the refusal is
  //     deleted today. A refusal nothing pins is a refusal that leaves on the
  //     next refactor.
  //
  // (B) THE TARGET ALPHABET IS NARROWER THAN THE TOKEN ALPHABET: `~` and `^`
  //     are admitted MID-TOKEN in an ordinary operand (`git log HEAD~3`,
  //     `git log HEAD^` — two pinned rows of the inventory above) and refused
  //     ANYWHERE in a relocation target. Under `setopt EXTENDED_GLOB` a
  //     mid-token `~`/`^` is a PATTERN operator, so the gate resolves the
  //     LITERAL target while the shell resolves a GLOB: the realpath precompute
  //     is then computed for a path the shell never visits, and published
  //     residual R3 becomes reachable at the one operand that relocates the
  //     whole execution with no second step.
  //
  //     MEASURED, NOT ASSERTED: no row of CHARACTER_INVENTORY, no entry of
  //     ALLOW_CORPUS and no allow arm in any of the four evidence suites
  //     carries `~` or `^` in a `cd` target, so the over-block cost of (B) is
  //     ZERO. The paired allow half below is what keeps it from sliding into a
  //     wholesale refusal of two characters the ordinary token alphabet needs.
  //
  // EVERY COMMAND IN THIS DESCRIBE IS HANDED TO THE DECISION FUNCTION AND
  // NEVER EXECUTED, exactly as the `cd =x` and `cd ^x` arms above are: `cd -`,
  // `cd +1` and a glob-expanding target each relocate the session's PERSISTENT
  // shell, and an out-of-tree relocation is not recoverable by re-running.
  // =========================================================================
  describe('the `cd` relocation target answers to its own, narrower rules', () => {
    it('DENIES the zsh directory-stack forms — `cd +n`, `cd +<name>` and `cd -`', () => {
      // `+n` and `-n` are the SAME form under PUSHD_MINUS, so these stand or
      // fall together; `cd -` (the previous directory) names a location the
      // gate cannot see for the same reason.
      for (const command of [
        'cd +1 && npm test',
        'cd +2 && pytest',
        'cd +build && npm test',
        'cd - && npm test',
        'cd - && pytest -q',
        'cd -1 && npm test',
      ]) {
        expectDeny(command);
      }
    });

    it('refuses them AS A RELOCATION TARGET, and says so in the deny reason', () => {
      // THE DISCRIMINATOR, and what keeps the arm above from passing for the
      // wrong reason. `npm test` behind the prefix is a recognized command, so
      // a denial reading merely "unrecognized command" would mean the PREFIX
      // was mis-parsed rather than that the TARGET was refused — and a future
      // change that broke `cd` parsing outright would then satisfy the deny arm
      // while stranding every legitimate `cd <dir> &&` form. Friction #8 wants
      // the same thing for the agent: a refusal it cannot attribute to an
      // operand is one it cannot act on.
      for (const command of ['cd +1 && npm test', 'cd +build && npm test', 'cd - && npm test']) {
        const denied = decide(command);
        expect(denied.decision, command).toBe('deny');
        expect(denied.reason, command).toContain('is not proven inside it');
      }
      // The refused operand is NAMED. Pinned for the `+` spellings only, and
      // said so rather than papered over: the deny reason embeds
      // EVIDENCE_COMMAND_FAMILIES, which itself contains `` `-` `` (it
      // publishes "a `cd` relocation target additionally may not begin with `-`
      // or `+`"), so the same assertion for `cd -` would be VACUOUS. The clause
      // above carries that case.
      expect(decide('cd +1 && npm test').reason).toContain('`+1`');
      expect(decide('cd +build && npm test').reason).toContain('`+build`');
    });

    it('ALLOWS a directory whose NAME merely begins with `+` or `-` behind a `./`', () => {
      // THE OVER-BLOCK GUARD for (A), and the proof that the refusal is
      // POSITIONAL on the FIRST character of the target rather than a `+`/`-`
      // blocklist. docs/hooks.md publishes exactly this as the named cost of
      // the refusal — "a directory whose name begins with `+` or `-` cannot be
      // a `cd` target here; `cd ./+build && npm test` still works" — so a
      // wholesale refusal would falsify the published escape hatch.
      for (const command of [
        'cd ./+build && npm test',
        'cd ./-build && npm test',
        'cd ./+build && pytest -q',
        'cd packages/+api && npm test',
        'cd sub/-legacy && ruff check src/',
      ]) {
        expectAllow(command);
      }
    });

    it('DENIES `~` and `^` ANYWHERE in a relocation target, not only at its start', () => {
      // (B). The token alphabet admits both characters mid-token; the target
      // alphabet does not admit them at all. `cd a~b && npm test` is the sharp
      // one: it was DENIED before the positive alphabet landed (the previous
      // negated `cd` class excluded `~` wholesale) and re-admitting it would be
      // the ONLY net widening in the whole conversion — at the one operand
      // where a gate/shell disagreement relocates everything that follows.
      for (const command of [
        // `a~b` leads because it is the one that MOVED TWICE: DENIED at the
        // pre-allowlist base, where the negated `cd` class excluded `~`
        // wholesale; ADMITTED for exactly as long as the relocation target
        // answered to the full token alphabet; and DENIED again here, because
        // (B) took `~` and `^` back out of LEADING_CD. `a^b` was admitted at
        // that base too and is refused here for the same reason. THE WIDENING
        // IS GONE, so this is a settled note rather than a red-authoring one —
        // the `expectDeny` below is the statement, and re-admitting either
        // spelling at this one operand is the net widening (B) exists to
        // prevent.
        'cd a~b && npm test',
        'cd a^b && npm test',
        'cd sub~1 && pytest',
        'cd pkg^2 && npm test',
        'cd packages/a~b && npm test',
        'cd packages/a^b && ruff check src/',
        'cd a~b && pytest -q',
        // Already refused at token START by the expansion-position rule, and
        // kept here so the two halves of the target rule read as ONE rule.
        'cd ~ && npm test',
        'cd ~sub && npm test',
        'cd ^x && npm test',
      ]) {
        expectDeny(command);
      }
    });

    it('keeps `~` and `^` admitted MID-TOKEN elsewhere — the narrowing is TARGET-only', () => {
      // The paired half, and the reason (B) may not be spelled as a wholesale
      // character refusal. The last two rows are the sharpest: ONE command that
      // carries `~`/`^` in the remainder and an ordinary target, so the two
      // halves are proven to answer to DIFFERENT alphabets rather than to one
      // relaxed or one tightened alphabet.
      for (const command of [
        'git log HEAD~3',
        'git diff HEAD~1',
        'git show HEAD~1:lib/runtime/hooks.js',
        'git log HEAD^',
        'git show HEAD^:package.json',
        'cd sub && git log HEAD~3',
        'cd packages/api && git log HEAD^',
      ]) {
        expectAllow(command);
      }
    });

    it('keeps every ordinary relocation target admitted (over-block guard)', () => {
      // The whole point of the `cd <dir> &&` prefix is that a nested test root
      // can run its own runner. Neither refusal above may cost any of these,
      // and the non-ASCII pair is invariant 6: a project under an accented or
      // CJK path must be able to relocate into its own package directory.
      for (const command of [
        'cd sub && npm test',
        'cd ./sub && npm t',
        'cd packages/api && uv run pytest',
        'cd ./nested/pkg && pytest -q',
        'cd services/web && ruff check src/',
        'cd sub   &&   mypy src/',
        'cd tests/日本語 && npm test',
        'cd packages/café && pytest -q',
      ]) {
        expectAllow(command);
      }
    });

    it('models the target alphabet as ITS OWN set, so the corpus guard stays honest', () => {
      // The suite's own non-vacuity, and the counterpart of the position-aware
      // consistency guard above. The two alphabets differ by EXACTLY `~` and
      // `^` — everything else the token alphabet names is still a legal
      // character in a directory name — and the model is then checked against
      // the gate on both sides of one `&&`, so a model that drifted from
      // enforcement cannot go unnoticed.
      for (const character of ['~', '^']) {
        expect(ADMITTED_ASCII_PUNCTUATION, `token alphabet keeps ${character}`).toContain(character);
        expect(CD_TARGET_ADMITTED_PUNCTUATION, `target alphabet drops ${character}`).not.toContain(
          character,
        );
        expect(characterAdmitted(character), `token predicate admits ${character}`).toBe(true);
        expect(cdTargetCharacterAdmitted(character), `target predicate refuses ${character}`).toBe(
          false,
        );
      }
      for (const character of [...ADMITTED_ASCII_PUNCTUATION]) {
        if (character === '~' || character === '^') continue;
        expect(
          CD_TARGET_ADMITTED_PUNCTUATION,
          `the target alphabet drops ONLY \`~\` and \`^\`, not ${character}`,
        ).toContain(character);
      }
      // The model, checked against the gate: same character, two positions,
      // two verdicts.
      expectDeny('cd a~b && npm test');
      expectAllow('git log HEAD~3');
      expectDeny('cd a^b && npm test');
      expectAllow('git log HEAD^');
    });
  });

  // =========================================================================
  // NON-ASCII. ADMITTED BY RANGE, with three carve-outs decided by what the
  // SHELL and the KERNEL receive, never by how the character looks.
  //
  // NORMALIZING IS REJECTED and must stay rejected: normalizing makes the gate
  // inspect a different string from the one the shell receives, which IS the
  // defect class this entry closes.
  // =========================================================================
  describe('non-ASCII is admitted BY RANGE, with three named carve-outs', () => {
    it('ALLOWS accented Latin, CJK, and astral code points', () => {
      // Verified live in this run: `echo café-naïve-Ω tests/日本語/a🙂b.test.js`
      // was ADMITTED. Refusing these is a REGRESSION, not a hypothetical, and
      // an invariant-6 violation for every project under a non-ASCII path.
      for (const command of [
        'echo café-naïve-Ω',
        'echo tests/日本語/a🙂b.test.js',
        'npx vitest run __tests__/日本語.test.js',
        'pytest tests/ünïcode',
        'cat docs/notes/Ω.md',
        // The `cd` target faces the same predicate as the remainder, so a
        // non-ASCII package directory has to survive it too.
        'cd tests/日本語 && npm test',
        'cd packages/café && pytest -q',
      ]) {
        expectAllow(command);
      }
    });

    it('DENIES an INVISIBLE format character (\\p{Cf}) anywhere in the command', () => {
      // U+200B, U+00AD and U+202E are not whitespace, so the negated-whitespace
      // arm never saw them, and they are not shell metacharacters either. They
      // cannot forge a recognized HEAD — exact-token equality already denies a
      // head carrying one — but they make OPERANDS and DENY REASONS
      // unauditable: an operator reading the denial cannot see what was refused,
      // and U+202E reverses the rendered direction of the tail outright.
      const cases = [
        [`echo a${ZERO_WIDTH_SPACE}b`, 'echo a<U+200B>b'],
        [`npm test ${ZERO_WIDTH_SPACE}`, 'npm test <U+200B>'],
        [`cat package${SOFT_HYPHEN}.json`, 'cat package<U+00AD>.json'],
        [`ls -la src${SOFT_HYPHEN}/`, 'ls -la src<U+00AD>/'],
        [`ls -la ${RIGHT_TO_LEFT_OVERRIDE}gpj.exe`, 'ls -la <U+202E>gpj.exe'],
        [`cd sub${ZERO_WIDTH_SPACE} && npm test`, 'cd sub<U+200B> && npm test'],
      ];
      for (const [command, label] of cases) expectDeny(command, label);
    });

    it('DENIES a LONE SURROGATE (\\p{Cs}), whose UTF-8 encoding is not the code point', () => {
      // DERIVED, not verified in vivo — the tool transport re-encodes, so no
      // live probe can carry one through. A JS string may hold an unpaired
      // surrogate; encoding it as UTF-8 substitutes U+FFFD, so the BYTES the
      // shell receives are not the code points the gate inspected. That is the
      // gate/shell disagreement this whole entry exists to make inexpressible,
      // one layer below the shell — the same place U+0000 sits. Admitted today.
      const cases = [
        [`echo a${LONE_SURROGATE}b`, 'echo a<U+D800>b'],
        [`npm test ${LONE_SURROGATE}`, 'npm test <U+D800>'],
        [`cd ${LONE_SURROGATE} && npm test`, 'cd <U+D800> && npm test'],
      ];
      for (const [command, label] of cases) expectDeny(command, label);
    });

    it('DENIES a non-NUL control character (\\p{Cc}) too', () => {
      // U+0000 is already refused by name. The REST of \p{Cc} is not, and it is
      // refused by the same argument: a control character in argv is not the
      // token an operator can audit, and the category is what makes the rule a
      // construction rather than another enumeration.
      expectDeny(`echo a${CONTROL_SOH}b`, 'echo a<U+0001>b');
      expectDeny(`npm test ${CONTROL_SOH}`, 'npm test <U+0001>');
    });

    it('keeps DENYING non-space whitespace, which the range rule must not re-admit', () => {
      // Regression guard on the conversion itself. U+00A0 is >= U+0080, so a
      // naive "admit everything non-ASCII" rule re-admits it — and JS `/\s+/`
      // splits on it while the shell's default IFS does not, which is the L1
      // defect wearing a different hat. EVIDENCE_NON_SPACE_WHITESPACE must keep
      // its position ahead of `trim()` and ahead of the `cd` split.
      expectDeny(`npm${NBSP}test`, 'npm<U+00A0>test');
      expectDeny(`cd${NBSP}sub && npm test`, 'cd<U+00A0>sub && npm test');
      expectDeny('ruff\tcheck', 'ruff<TAB>check');
    });
  });

  // =========================================================================
  // TOTALITY. The predicate runs inside the SYNCHRONOUS policy, which
  // bin/ape-hook.mjs consumes with no `await`: a throw reaches the binary's
  // top-level catch, which while a run is live denies EVERY subsequent tool
  // event and bricks the session until dist/ is reverted by hand; and a Promise
  // return yields `.decision === undefined`, so formatHookResponse emits `deny`
  // for every PreToolUse — a silent total lockout.
  //
  // The two implementation constraints that keep it total are pinned by the
  // inputs rather than by reading the source: a 1 MB command (bounded by the
  // hook's own 8 MB stdin cap) must not backtrack, and repeated calls on the
  // same input must agree — a `/g` regex is lastIndex-STATEFUL, so a rule built
  // with one answers differently on its second call.
  // =========================================================================
  describe('the character rule is TOTAL: it never throws and never yields a Promise', () => {
    const TOTALITY_INPUTS = Object.freeze([
      [null, 'null'],
      [undefined, 'undefined'],
      [42, 'number'],
      [{}, 'object'],
      [[], 'array'],
      [true, 'boolean'],
      ['', 'empty string'],
      ['   ', 'whitespace only'],
      ['npm test', 'an ordinary admitted command'],
      [`echo ${LONE_SURROGATE}`, 'a lone surrogate'],
      ['x'.repeat(1024 * 1024), 'a 1 MB command'],
    ]);

    it('answers every input shape without throwing, tokenizer included', () => {
      for (const [input, label] of TOTALITY_INPUTS) {
        let parsed;
        expect(() => {
          parsed = hooks.parseEvidenceCommand?.(input);
        }, label).not.toThrow();
        expect(parsed === null || typeof parsed === 'object', label).toBe(true);
      }
    });

    it('answers every input shape with a synchronous allow/deny decision', () => {
      for (const [input, label] of TOTALITY_INPUTS) {
        let result;
        expect(() => {
          result = decide(input);
        }, label).not.toThrow();
        expect(result, label).toBeTruthy();
        expect(result, label).not.toBeInstanceOf(Promise);
        expect(typeof result?.then, label).not.toBe('function');
        expect(['allow', 'deny'], label).toContain(result.decision);
        expect(typeof result.reason, label).toBe('string');
      }
    });

    it('is STATELESS across repeated calls on the same input (no /g lastIndex)', () => {
      // A `/g` regex reused with `.test()` advances lastIndex, so the SECOND
      // call on the same string can answer differently. The reason is already
      // recorded in lib/runtime/hooks.js for DEV_NULL_REDIRECT; the character
      // rule is `.test()`ed at least twice per command (the remainder and the
      // `cd` target), so it is the site where that bug would be silent.
      for (const command of ['echo =ls', 'ls ^x', 'npm test', 'pytest --rootdir=tests']) {
        const first = decide(command).decision;
        const second = decide(command).decision;
        const third = decide(command).decision;
        expect([second, third], command).toEqual([first, first]);
      }
    });
  });

  // =========================================================================
  // THE PUBLISHED RECORD. Six rounds of "the published rule is stronger than
  // the enforced rule" on this one surface, and the sixth was found by the very
  // spike sent to prevent the seventh. The docs are therefore part of the
  // change, not commentary on it: an allowlist described as closing a class it
  // only NARROWS is the seventh instance of the same defect.
  // =========================================================================
  const hooksDoc = () => readFile(new URL('../docs/hooks.md', import.meta.url), 'utf8');
  const researchNoteUrl = new URL(
    '../docs/research/2026-07-28-evidence-metachar-character-allowlist.md',
    import.meta.url,
  );
  const researchNote = () =>
    readFile(researchNoteUrl, 'utf8');

  describe('docs/hooks.md publishes the rule that is enforced, and its ceiling', () => {
    it('carries a SHELL ASSUMPTION paragraph naming the shell and the options it assumes unset', async () => {
      // FINDING 2. The whole soundness argument is written against non-interactive
      // BASH while the executing shell is ZSH: `=ls` -> `/bin/ls` is zsh-only, and
      // the error prefix `(eval):1:` is zsh's format, which also shows the host
      // wraps the command in `eval` inside a persistent shell. zsh's word-level
      // expansion set is a strict SUPERSET of bash's, so an argument discharged
      // against bash does not transfer. The honest ceiling on ANY character rule
      // is that the special-character set is partly OPERATOR-CONFIGURABLE —
      // under EXTENDED_GLOB, `^`, `#` and `~` become glob operators — and that
      // has to be published, not inferred by the next reviewer.
      const doc = await hooksDoc();
      expect(doc).toMatch(/shell assumption/i);
      expect(doc).toMatch(/\bzsh\b/i);
      expect(doc).toMatch(/EXTENDED_?GLOB/i);
    });

    it('states the ADMITTED set and the positional refusals, not a refused-character list', async () => {
      const doc = await hooksDoc();
      // The section that argued the refusal set was a blocklist is retitled and
      // rewritten: the class it named is CLOSED BY CONSTRUCTION now, so a
      // heading that still says "blocklist" describes the previous tree.
      expect(doc).not.toContain('### The refusal set is a blocklist');
      expect(doc).toMatch(/character allowlist/i);
      // The mechanism of the live bypass, named, with the probe that verified it.
      expect(doc).toMatch(/equals expansion/i);
      expect(doc).toContain('=node');
    });

    it('NAMES the zsh option that makes `=` expand after `=` or `:`', async () => {
      // The disclosure half of the review group's blocking finding: the rule
      // refused `~` after `=`/`:` and admitted `=` there, and NO doc line named
      // the option that decides it. `~` after `:` expands under zsh's default
      // PATH-style treatment of an assignment value; `=` in that position, and
      // both characters in an ordinary `identifier=expression` ARGUMENT, are
      // MAGIC_EQUAL_SUBST. Naming the option is what makes the residual
      // legible: like EXTENDED_GLOB it is OPERATOR-CONFIGURABLE, so the refusal
      // NARROWS the exposure rather than closing it, and a reader who cannot
      // see which option is in play cannot tell which of the two this is.
      const doc = await hooksDoc();
      expect(doc).toMatch(/MAGIC_?EQUAL_?SUBST/i);
    });

    it('publishes the `^`-at-token-start over-block with the command it costs', async () => {
      // "Accepted over-blocks" is an ENUMERATION with a stated price per entry.
      // `git log ^main master` is admitted today and becomes denied; that is the
      // price, and it belongs in the doc rather than in a reviewer's memory.
      const doc = await hooksDoc();
      expect(doc).toMatch(/accepted over-blocks/i);
      expect(doc).toContain('git log ^main master');
    });

    it('records that the two character constants share a SHAPE, not a threat model', async () => {
      // The reuse hazard, extended. Round 5 already recorded that
      // DELETION_UNSAFE_CHARS omits `#` and is SAFE there because admission is
      // MONOTONE UNDER TRUNCATION. That argument does NOT extend to `=`: EQUALS
      // is a SUBSTITUTION, not a truncation — it replaces a contained relative
      // target with an absolute out-of-project one. The doc must carry the
      // extension, or the next reader re-derives the harmless-there conclusion
      // and re-syncs the constants.
      //
      // The pin is the CONCRETE instance rather than a wording: under the
      // retired blocklist `DELETION_UNSAFE_CHARS`, which carried no `=`,
      // `rm =node` PARSED and resolved to `<cwd>/=node` — LEXICALLY INSIDE the
      // project — so admission turned only on `pathResolvesWithinClaims`, while
      // zsh deletes the absolute path of whatever `node` names. The shipped
      // constant is `DELETION_TOKEN_CHAR_REFUSED` and it refuses `~`, `=` and
      // `^` wholesale, so that instance no longer parses; the doc paragraph
      // this arm pins states it in exactly that PAST tense and names the
      // RETIRED constant on purpose, which is why the assertions below still
      // look for that name and that instance. A doc that records the
      // monotonicity argument without recording where it stops is the same
      // publication defect this surface has now produced six times.
      const doc = await hooksDoc();
      expect(doc).toMatch(/monotone/i);
      expect(doc).toContain('DELETION_UNSAFE_CHARS');
      expect(doc).toContain('rm =node');
    });

    it('claims NARROWING, never closure, for the operator-configurable residual', async () => {
      // THE BOUND THE DOCS MAY NOT OVERSTATE. The accurate sentence is "no
      // character the gate admits can make the shell read the command
      // differently, FOR THE SHELL AND SHELL OPTIONS THE NOTE NAMES" — the
      // qualification is the whole of the claim's honesty. And the class no
      // character rule reaches at all (aliases, shell functions, PATH shadowing,
      // BASH_ENV/ENV/ZDOTDIR) is published residual R2, untouched by this
      // change and named as such.
      const doc = await hooksDoc();
      expect(doc).toMatch(/shell options/i);
      expect(doc).toMatch(/ZDOTDIR/);
      expect(doc).toMatch(/alias/i);
    });
  });

  // The clean public export intentionally excludes private research/history.
  // Keep all executable security assertions in this suite, and run only this
  // provenance block when its private-source note is actually present.
  describe.skipIf(!existsSync(researchNoteUrl))('the research note records the derivation and its provenance', () => {
    it('exists, in the shape of the sibling note', async () => {
      const note = await researchNote();
      expect(note.length).toBeGreaterThan(0);
      for (const heading of ['## Bounds', '## Provenance']) {
        expect(note, `the note must carry a ${heading} section`).toContain(heading);
      }
      expect(note).toContain('evidence-metachar-refusal-is-still-a-blocklist');
    });

    it('names the spike run and receipt the derivation came from, and why that run could not write it', async () => {
      // The derivation is NOT this run's work: spike run-fixture-d578507b4795
      // completed its research and then blocked on a capability defect — the
      // operator claimed a docs/research path on a SPIKE ticket, and
      // spike_researcher carries `writable: false` and has no write tool, so the
      // note could never be written. Attribution is the point of a provenance
      // section, and the capability defect is the reason this run exists.
      const note = await researchNote();
      expect(note).toContain('run-fixture-d578507b4795');
      expect(note).toContain('d121cd29');
      expect(note).toMatch(/writable|read-only|write tool/i);
    });

    it('carries the finding, the derivation, and the bounds the change may not overstate', async () => {
      const note = await researchNote();
      // The live bypass, with the probe that verified it.
      expect(note).toContain('=node');
      expect(note).toMatch(/zsh/i);
      // The ceiling: NARROWS, does not close.
      expect(note).toMatch(/EXTENDED_?GLOB/i);
      expect(note).toMatch(/narrow/i);
    });
  });
});
