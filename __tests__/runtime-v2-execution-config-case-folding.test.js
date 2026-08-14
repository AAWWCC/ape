import { execFileSync, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { evaluateLifecyclePolicy } from '../lib/runtime/hooks.js';
import { runtimePaths } from '../lib/runtime/paths.js';
import { currentTreeSha } from '../lib/runtime/git.js';
import { atomicWriteJson } from '../lib/runtime/storage.js';

// Roadmap entry execution-config-case-folding-vs-tolowercase.
//
// THE PREMISE, WHICH ARRIVED EXPLICITLY UNVERIFIED AND IS VERIFIED HERE. The
// out-of-project execution-redirecting-configuration refusal compares whole path
// SEGMENTS after `String.prototype.toLowerCase`. toLowerCase is Unicode case
// MAPPING, not case FOLDING, and the two disagree: `'ſ'` (LATIN SMALL
// LETTER LONG S, `ſ`) maps to ITSELF under toLowerCase and FOLDS to `s`. A
// case-insensitive filesystem resolves by FOLDING, so a spelling the compare
// treats as a different name is the same file to `open(2)`.
//
// METHOD, AND THE ANSWER (re-derived here rather than taken on trust; every
// probe below is an mkdtemp fixture and nothing under $HOME is touched):
//
//   1. PURE-JS half — `'ſ'.toLowerCase() !== 's'`, so the compare cannot
//      see the folded spelling. Host-neutral, pinned unconditionally below.
//   2. FILESYSTEM half — in an mkdtemp fixture, a file CREATED as `.zſhenv`
//      is opened successfully through `.zshenv`, and one created as
//      `.claude/ſettings.json` through `.claude/settings.json`. The
//      direction matters and the operator evidence had it the other way round:
//      the exploit is create-folded / open-canonical, because a bound write
//      CREATES the startup file the shell then reads. VERDICT ON THIS HOST
//      (darwin, APFS): the premise HOLDS.
//   3. POLICY half — at the tree this file was FIRST authored against, the hook
//      ALLOWED `<outside>/.zſhenv` and `<outside>/.claude/ſettings.json`, so
//      the bypass was live end to end, not merely arguable. That half has since
//      LANDED — every simple-fold arm below is green at this tree — and the half
//      still LIVE here is the MULTI-CHARACTER one derived after (5).
//   4. THE `U+212A` (KELVIN SIGN) HALF IS REFUTED as a distinct vector, on ONE
//      ground and not the two this comment used to give.
//      `'K'.toLowerCase() === 'k'` — toLowerCase ALREADY
//      normalizes it — so the observation that the filesystem resolves
//      `.Kfile` to `.kfile` changes the exposed set by NOTHING. The
//      SECOND ground this comment used to give — "and no shipped table entry
//      contains a `k` anyway" — held by ACCIDENT and no longer holds:
//      `.claude-plugin/marketplace.json` landed in this same phase and carries a
//      `k`. The refutation does not move, which is precisely why it is rested on
//      toLowerCase and not on the table's contents. The arms below are
//      data-driven from the shipped tables, so they range over that entry today
//      without being rewritten.
//   5. THE ALREADY-CLOSED HALF, stated so the fix is not sold wider than it is:
//      when the canonical file ALREADY EXISTS, macOS `realpath` returns the
//      on-disk spelling, so the REALPATH-RESOLVED half of the lookup catches the
//      folded target on its own. The live hole is the CREATE case — the target
//      does not exist yet, realpath cannot canonicalize what is not there, and
//      only the raw tail is consulted. That is the stronger case anyway: a
//      machine with no `~/.zlogin` is where planting one wins.
//
// THE EXPOSED SET, re-derived AGAINST THE TABLES AS THEY STAND AT THIS TREE —
// an earlier revision of this paragraph enumerated the PRE-diff tree while
// claiming to describe the shipped one, which is exactly the drift the derived
// arms below exist to make impossible. SIMPLE case folding — what a `u`-flagged
// RegExp canonicalizes with — maps exactly two non-ASCII code points onto ASCII
// letters: U+017F onto `s` and U+212A onto `k`. U+212A is already handled (4).
// U+017F therefore exposes every table entry containing an `s`, and at this tree
// that is most of the enumeration rather than a corner of it:
//   - the bash and zsh startup files that carry one — `.bashrc`,
//     `.bash_profile`, `.bash_login`, `.zshrc`, `.zshenv`, but NOT `.profile`,
//     `.zprofile` or `.zlogin`;
//   - `sitecustomize.py` and `usercustomize.py`;
//   - every `eslint.config.*` spelling (`s` twice each — the head and the
//     extension);
//   - every prettier spelling whose extension carries one, in BOTH the
//     `.prettierrc.*` and `prettier.config.*` forms: `.json`, `.json5` and the
//     `.js`/`.mjs`/`.cjs`/`.ts`/`.mts`/`.cts` module extensions — but not bare
//     `.prettierrc`, `.prettierrc.yml`, `.prettierrc.yaml` or
//     `.prettierrc.toml`;
//   - every `.mocharc.*` spelling except `.mocharc.yaml` and `.mocharc.yml`;
//   - the host-agent JSON `.claude.json` and BOTH `.claude/settings*.json`
//     entries — the settings pair declares PreToolUse hook COMMANDS and can
//     disable this very gate;
//   - ALL THREE plugin manifests — `.claude-plugin/plugin.json`,
//     `.claude-plugin/marketplace.json` and `.codex-plugin/plugin.json` — whose
//     `.json` extension carries one on its own.
// No list written here is the authority and none of it is a census: the arms
// range over the shipped tables rather than a copy of them, so an entry is
// covered the day it lands and not the day someone remembers this file. The
// `.mocharc.*` and `.codex-plugin/plugin.json` entries the readonly suite LANDED
// in this same cycle are that property's own proof, and the literal arm below
// carries two of their folded spellings as this ticket's red, because "the
// derivation will pick it up" is a claim nothing checks until the tail exists.
//
// AND THE HALF SIMPLE FOLDING DOES NOT REACH, verified here rather than left to
// prose. FULL case folding maps a further handful of code points onto
// MULTI-CHARACTER ASCII: U+00DF onto `ss`, and the U+FB00..U+FB06 ligatures onto
// `ff`, `fi`, `fl`, `ffi`, `ffl` and `st`. Two claims have been made about that
// residual and NEITHER survives contact with this host:
//   "no table entry contains the expansion" — FALSE. Every `config` and
//   `profile` entry carries `fi`: at this tree `.bunfig.toml`, `.gitconfig`,
//   `.profile`, `.bash_profile`, `.zprofile`, `prettier.config.*`,
//   `eslint.config.*`, `git/config`, `mypy/config`, `.cargo/config*`,
//   `.config/pylintrc` and `.codex/config.toml`.
//   `sitecustomize.py` and `usercustomize.py` carry `st`. No count is given
//   here on purpose: the arm below derives the set from the shipped tables.
//   "it is checked by the data-driven arms" — FALSE until this revision. The
//   fold generator below substituted ONE code point for ONE character, so no arm
//   could ever produce a multi-character expansion.
// METHOD AND ANSWER (mkdtemp fixture, nothing under `$HOME` touched): a file
// CREATED under a folded spelling opens through the canonical one on this host
// (darwin, APFS) for `ss`, `fi` and both `st` ligatures. Nothing under `$HOME`
// is probed, but the inference about it is the point: a `$HOME/.profile` spelled
// with U+FB01, a `$HOME/.cargo/config.toml` likewise, and a
// `$HOME/sitecustomize.py` spelled with U+FB05 WOULD BE the same files to
// `open(2)` as their covered spellings, while a simple-fold compare reads them
// as unrelated names. That is the same defect one fold-strength over, not a
// hypothetical. The arm below re-derives the observation per shipped tail
// instead of trusting this note, and states the same host-neutral implication
// the U+017F arms use, so an `ss`-bearing entry is covered the day it lands.
//
// AND THE THIRD MECHANISM, WHICH IS NEITHER FOLDING NOR NORMALIZATION:
// DEFAULT-IGNORABLE CODE POINTS. The previous revision's "What this does NOT
// close" listed NFC/NFD and stopped there, and the security review flagged the
// omission EXPLICITLY UNVERIFIED because a bound read-only ticket cannot author a
// probe. It is probed here rather than argued. U+00AD, U+200B..U+200F, U+2060 and
// U+FEFF render as nothing, are left alone by simple AND full folding, and are
// left alone by all four normalization forms — so if a filesystem ignored them in
// name comparison, NEITHER pass above could see the spelling and the NFC/NFD
// residual would not cover them by implication either.
// METHOD AND ANSWER (mkdtemp fixture, nothing under `$HOME` touched; a control
// probe pins that an absent name does NOT read back, so a positive cannot be an
// open() that succeeds for every argument): this host (darwin, APFS) does NOT
// ignore them — a file created as `.ba<U+00AD>shrc` is a DIFFERENT file from
// `.bashrc` to `open(2)` — so there is no bypass to close here, and the residual
// is a DISCLOSURE published with the same needs-its-own-derivation framing NFC/NFD
// carries rather than a claim that it is fixed. The arm states the same
// host-neutral implication the fold arms do, so a host where the answer differs
// turns it RED instead of silently inheriting this one's measurement.
//
// THE SHAPE THESE ARMS PIN, AND THE SHAPE THEY REFUSE. Refusing every segment
// that merely CONTAINS a non-ASCII character is NOT the fix: an out-of-project
// scratch file with a legitimately accented or CJK name would be refused, and
// this refusal's whole design constraint is that the scratchpad stays open. The
// pinned shape is FOLD-THEN-COMPARE — a segment is additionally matched against
// the same table under case folding — which is:
//   MONOTONE      a second match attempt can only ever ADD denials, so no
//                 non-ASCII segment becomes MORE admissible than it is today
//                 (the monotonicity constraint above gitEvidenceArgsSafe);
//   SYNCHRONOUS   evaluateLifecyclePolicy must stay synchronous, so the rule may
//                 not consult the filesystem — and it must not anyway;
//   TOTAL         it decides every string without throwing;
//   HOST-NEUTRAL  (invariant 6) the verdict is a property of the SPELLING, not
//                 of the filesystem the runtime happens to be on. Probing the
//                 host for case-insensitivity would make the same payload decide
//                 differently on darwin and on Linux, which is precisely what
//                 invariant 6 forbids; the accepted price is that on a
//                 case-sensitive filesystem the refusal over-blocks a filename
//                 nobody legitimately writes.
// A folding primitive is available in plain JS with no table of its own — a
// `u`-flagged case-insensitive RegExp canonicalizes by simple case folding — and
// that is pinned below as an existence fact, not as an implementation mandate.
// It reaches the SIMPLE half only, which is exactly why the multi-character arm
// is stated as a VERDICT and not as a mechanism: `ß`/`ss` and the `ﬁ`/`fi`
// ligatures are FULL-fold mappings that a `u`-flagged RegExp does not
// canonicalize, so closing them needs something more (a compatibility
// normalization, a small explicit expansion table, or a base-sensitivity
// collator). Which one is the implementation's choice; that it decides the same
// way on every host is not.
//
// HARD FIXTURE RULE. Nothing under $HOME is created, edited or truncated. Unit
// arms are pure calls with literal paths never touched on disk; filesystem arms
// use mkdtemp fixtures removed in afterEach; end-to-end arms are PreToolUse
// permission checks, which decide and write nothing. The fold probes create the
// FOLDED spelling only — never the canonical tool-config filename — one
// throwaway box per exposure, and read the canonical spelling back to observe
// what the filesystem does with it.

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const hookBinary = path.join(root, 'bin', 'ape-hook.mjs');
const cleanups = [];

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

// LATIN SMALL LETTER LONG S. Folds to `s`; toLowerCase leaves it alone.
const LONG_S = 'ſ';
// KELVIN SIGN. Folds to `k`, and toLowerCase already maps it to `k`.
const KELVIN = 'K';

// A lexically-outside home, never created and never written.
const HOME = '/outside/home';

const readOnlyTicket = Object.freeze({
  ticket_id: 'run-1:review:r',
  role: 'reviewer',
  writable: false,
  claimed_paths: [],
  test_paths: ['__tests__'],
});

const writableTicket = Object.freeze({
  ticket_id: 'run-1:build:b',
  role: 'implementer',
  writable: true,
  claimed_paths: ['lib'],
  test_paths: ['__tests__'],
});

const REFUSES_TOOL_CONFIG = /configur/i;
const OUT_OF_PROJECT_ALLOW = /outside the project root/;
const running = { status: 'running' };

function outsideWrite(tail, overrides = {}) {
  return {
    host: 'claude',
    event: 'PreToolUse',
    tool_name: 'Write',
    is_subagent: true,
    ape_managed: true,
    file: null,
    target_path: `${HOME}/${tail}`,
    out_of_project: true,
    ...overrides,
  };
}

function verdict(tail, ticket = readOnlyTicket) {
  return evaluateLifecyclePolicy(outsideWrite(tail), { state: running, ticket });
}

// The shipped tables, read as TEXT. They are module-private, and a suite that
// imported them would assert the implementation against itself; reading the
// source keeps the expectation independently authored while still letting the
// fold arms RANGE over whatever is shipped, so a future `s`-bearing entry is
// covered the day it lands instead of the day someone remembers this file.
function shippedSetLiteral(source, name) {
  const declaration = new RegExp(`^const ${name} = new Set\\(\\[`, 'm').exec(source);
  expect(
    declaration,
    `lib/runtime/write-policy.js genuinely declares ${name}`,
  ).not.toBeNull();
  const start = declaration.index + declaration[0].length;
  const end = source.indexOf(']);', start);
  expect(end, `lib/runtime/write-policy.js closes ${name}`).toBeGreaterThan(start);
  return source
    .slice(start, end)
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('//'))
    .flatMap((line) => [...line.matchAll(/'([^']+)'/g)].map((match) => match[1]));
}

async function shippedTails() {
  const ownerFiles = {
    evidence: path.join(root, 'lib', 'runtime', 'evidence-policy.js'),
    write: path.join(root, 'lib', 'runtime', 'write-policy.js'),
    lifecycle: path.join(root, 'lib', 'runtime', 'lifecycle-policy.js'),
  };
  for (const [domain, ownerFile] of Object.entries(ownerFiles)) {
    expect(existsSync(ownerFile), `${domain} policy owner exists`).toBe(true);
  }
  const evidenceSource = await readFile(ownerFiles.evidence, 'utf8');
  const lifecycleSource = await readFile(ownerFiles.lifecycle, 'utf8');
  expect(evidenceSource).toMatch(/^export function gitEvidenceArgsSafe\s*\(/m);
  expect(lifecycleSource).toMatch(/^export function evaluateLifecyclePolicy\s*\(/m);
  const source = await readFile(ownerFiles.write, 'utf8');
  return [
    ...shippedSetLiteral(source, 'EXECUTION_CONFIG_TAIL'),
    ...shippedSetLiteral(source, 'EXECUTION_CONFIG_TAIL_PAIR'),
  ];
}

// Every spelling of `tail` in which exactly one ASCII letter is replaced by the
// non-ASCII code point that FOLDS to it. One substitution per spelling, so each
// failure names a single character rather than a soup of them.
function foldedSpellings(tail, ascii, folded) {
  const spellings = [];
  for (let index = 0; index < tail.length; index += 1) {
    if (tail[index] !== ascii) continue;
    spellings.push(`${tail.slice(0, index)}${folded}${tail.slice(index + 1)}`);
  }
  return spellings;
}

// FULL case folding, the multi-character half. This is every full-fold mapping
// in CaseFolding.txt whose expansion is pure ASCII — U+00DF and U+1E9E onto
// `ss`, and the seven U+FB00..U+FB06 ligatures — and they are the only ones that
// can collide with a table entry, since no entry is non-ASCII. Every other
// multi-character mapping expands to a sequence that is itself non-ASCII (U+0130
// and U+01F0 onto a letter plus a combining mark, U+0149, the U+1E96..U+1E9A
// group, the Greek and Armenian ligatures), so it is vacuous against this table
// by CONSTRUCTION rather than by luck — which is the distinction the `k` bound
// in the header got wrong.
const FULL_FOLD_EXPANSIONS = [
  ['ß', 'ss'],
  ['ẞ', 'ss'],
  ['ﬀ', 'ff'],
  ['ﬁ', 'fi'],
  ['ﬂ', 'fl'],
  ['ﬃ', 'ffi'],
  ['ﬄ', 'ffl'],
  ['ﬅ', 'st'],
  ['ﬆ', 'st'],
];

// Every spelling of `tail` in which exactly ONE occurrence of one multi-character
// expansion is replaced by the single code point that FULL-folds to it. One
// substitution per spelling, for the same reason the simple-fold generator does
// it: a failure names one character and one entry.
function fullFoldSpellings(tail) {
  const spellings = [];
  for (const [ligature, expansion] of FULL_FOLD_EXPANSIONS) {
    for (let index = tail.indexOf(expansion); index >= 0; index = tail.indexOf(expansion, index + 1)) {
      spellings.push({
        canonical: tail,
        folded: `${tail.slice(0, index)}${ligature}${tail.slice(index + expansion.length)}`,
        ligature,
        expansion,
      });
    }
  }
  return spellings;
}

describe('PREMISE — the pure-JS half, pinned so the argument cannot rot', () => {
  it('toLowerCase is case MAPPING: U+017F does not become `s`', () => {
    expect(LONG_S.toLowerCase()).not.toBe('s');
    expect(LONG_S.toLowerCase()).toBe(LONG_S);
    // Which is the whole defect in one line: the segment compare lowercases and
    // then asks for equality, so `.ba<U+017F>hrc` is simply a different string.
    expect('.bashrc'.toLowerCase()).not.toBe(`.ba${LONG_S}hrc`.toLowerCase());
  });

  it('U+212A is ALREADY normalized by toLowerCase, which refutes the Kelvin half', () => {
    expect(KELVIN.toLowerCase()).toBe('k');
    expect('.kfile'.toLowerCase()).toBe(`.${KELVIN}file`.toLowerCase());
  });

  it('a synchronous, total, table-free folding primitive exists in plain JS', () => {
    // A `u`-flagged case-insensitive RegExp canonicalizes by SIMPLE CASE
    // FOLDING, so the fix needs no Unicode table of its own and can stay inside
    // the synchronous policy. Pinned as an existence fact: the arms below assert
    // VERDICTS, never a mechanism.
    expect(new RegExp('^\\.bashrc$', 'iu').test(`.ba${LONG_S}hrc`)).toBe(true);
    expect(new RegExp('^\\.kfile$', 'iu').test(`.${KELVIN}file`)).toBe(true);
    // And it does not fold an unrelated non-ASCII name onto anything.
    expect(new RegExp('^notes\\.md$', 'iu').test('notés.md')).toBe(false);
  });
});

describe('PREMISE — the filesystem half, re-derived on the host that runs this suite', () => {
  it('resolves a folded spelling onto the canonical file, or the compare has nothing to miss', async () => {
    // HOST-NEUTRAL BY CONSTRUCTION. The assertion is the implication, not the
    // observation: EITHER this filesystem does not fold U+017F onto `s` (and the
    // folded spelling is simply a different file, so there is no bypass to
    // close) OR the policy refuses the folded spelling. On darwin/APFS the left
    // side is false, so the right side carries the arm; on a case-sensitive
    // filesystem the arm is satisfied either way and asserts nothing false.
    const dir = await mkdtemp(path.join(tmpdir(), 'ape-fold-fixture-'));
    cleanups.push(dir);

    // The EXPLOIT direction: create through the folded spelling, then open
    // through the canonical one — what a shell startup read actually does.
    await writeFile(path.join(dir, `.z${LONG_S}henv`), 'probe\n');
    let filesystemFolds = false;
    try {
      await readFile(path.join(dir, '.zshenv'), 'utf8');
      filesystemFolds = true;
    } catch {
      filesystemFolds = false;
    }

    const policyRefuses = verdict(`.z${LONG_S}henv`).decision === 'deny';
    expect(
      !filesystemFolds || policyRefuses,
      `filesystem folds U+017F onto s: ${filesystemFolds}; policy refuses the folded spelling: ${policyRefuses}`,
    ).toBe(true);
  });

  it('reaches the host-agent settings file the same way, or has nothing to miss there either', async () => {
    // The highest-value entry in the table: `.claude/settings.json` declares
    // PreToolUse hook COMMANDS, so a write that lands there can disable this
    // very gate. The directory segment is ASCII; only the filename is folded.
    const dir = await mkdtemp(path.join(tmpdir(), 'ape-fold-fixture-'));
    cleanups.push(dir);
    await mkdir(path.join(dir, '.claude'), { recursive: true });
    await writeFile(path.join(dir, '.claude', `${LONG_S}ettings.json`), '{}\n');

    let filesystemFolds = false;
    try {
      await readFile(path.join(dir, '.claude', 'settings.json'), 'utf8');
      filesystemFolds = true;
    } catch {
      filesystemFolds = false;
    }

    const policyRefuses = verdict(`.claude/${LONG_S}ettings.json`).decision === 'deny';
    expect(
      !filesystemFolds || policyRefuses,
      `filesystem folds U+017F onto s: ${filesystemFolds}; policy refuses the folded spelling: ${policyRefuses}`,
    ).toBe(true);
  });
});

describe('RED — a folded spelling of a covered tail is refused for a BOUND ticket', () => {
  it('refuses the literal U+017F spellings of the shell, python, host-agent and newly-covered entries', () => {
    // Literals, not derivation, so this arm keeps its meaning even if the
    // table-reading helper below ever stops finding anything.
    //
    // RED (this ticket) for the last two rows. They are the folded spellings of
    // the tails the readonly suite LANDED in this same cycle — `.mocharc.json`
    // and `.codex-plugin/plugin.json` — and they were ALLOWED at the tree this
    // arm was authored against, so the bypass this file exists to close was live
    // one entry over. They are recorded as LITERALS here for the reason the rest
    // of this arm is: the derived arm below covers them the moment the tables
    // carry them, and a literal is what proves the derivation is not the only
    // thing holding them.
    for (const tail of [
      `.ba${LONG_S}hrc`,
      `.ba${LONG_S}h_profile`,
      `.ba${LONG_S}h_login`,
      `.z${LONG_S}hrc`,
      `.z${LONG_S}henv`,
      `${LONG_S}itecustomize.py`,
      `u${LONG_S}ercustomize.py`,
      `.claude/${LONG_S}ettings.json`,
      `.claude/${LONG_S}ettings.local.json`,
      `.mocharc.j${LONG_S}on`,
      `.codex-plugin/plugin.j${LONG_S}on`,
    ]) {
      const result = verdict(tail);
      expect(result.decision, `${HOME}/${tail}`).toBe('deny');
      expect(result.reason, `${HOME}/${tail}`).toMatch(REFUSES_TOOL_CONFIG);
    }
  });

  it('refuses EVERY folded spelling of EVERY shipped tail, one substitution at a time', async () => {
    const tails = await shippedTails();
    // The generator must not be able to go vacuous and pass by finding nothing.
    for (const floor of ['.bashrc', '.zshenv', 'sitecustomize.py', '.claude/settings.json']) {
      expect(tails, 'the shipped tables still carry the floor entries').toContain(floor);
    }
    const spellings = tails.flatMap((tail) => [
      ...foldedSpellings(tail, 's', LONG_S),
      // Vacuous while no entry contains a `k`, and self-maintaining the moment
      // one does — see the Kelvin refutation in the header.
      ...foldedSpellings(tail, 'k', KELVIN),
    ]);
    // Non-vacuity floor, not a census: the count moves whenever the table does,
    // and the four floor entries above already guarantee the generator bites.
    expect(spellings.length, 'the fold generator is not vacuous').toBeGreaterThanOrEqual(12);
    for (const tail of spellings) {
      const result = verdict(tail);
      expect(result.decision, `${HOME}/${tail}`).toBe('deny');
      expect(result.reason, `${HOME}/${tail}`).toMatch(REFUSES_TOOL_CONFIG);
    }
  });

  it('refuses a folded spelling that is ALSO uppercased, so folding composes with the existing lowercase', () => {
    for (const tail of [`.BA${LONG_S}HRC`, `.Claude/${LONG_S}ettings.JSON`]) {
      const result = verdict(tail);
      expect(result.decision, `${HOME}/${tail}`).toBe('deny');
    }
  });

  it('binds a WRITABLE ticket exactly as it binds a read-only one', () => {
    // Same reasoning as the ASCII refusal: a claim set governs project paths and
    // never $HOME, so the folded spelling is refused for the BINDING, not the
    // role — and the reason is the configuration one, not the read-only one.
    const result = verdict(`.z${LONG_S}henv`, writableTicket);
    expect(result.decision).toBe('deny');
    expect(result.reason).toMatch(REFUSES_TOOL_CONFIG);
    expect(result.reason).not.toMatch(/is read-only/);
  });

  it('inherits the tool-channel, write-tool and binding terms rather than growing its own', () => {
    // The folded refusal is the SAME branch, so a Read is not a write, a
    // lifecycle boundary must keep carrying the receipt-bearing final message,
    // and the unbound main session stays exempt. The write arm is the only one
    // that changes; the other three are green before AND after.
    expect(verdict(`.z${LONG_S}henv`).decision, 'write tool').toBe('deny');
    expect(
      evaluateLifecyclePolicy(
        outsideWrite(`.z${LONG_S}henv`, { tool_name: 'Read' }),
        { state: running, ticket: readOnlyTicket },
      ).decision,
      'Read',
    ).toBe('allow');
    expect(
      evaluateLifecyclePolicy(
        outsideWrite(`.z${LONG_S}henv`, { event: 'SubagentStop', tool_name: '' }),
        { state: running, ticket: readOnlyTicket },
      ).decision,
      'SubagentStop',
    ).toBe('allow');
    expect(
      evaluateLifecyclePolicy(
        outsideWrite(`.z${LONG_S}henv`, { is_subagent: false, ape_managed: undefined }),
        { state: running, ticket: null },
      ).decision,
      'unbound main session',
    ).toBe('allow');
  });

  it('names a table entry in the reason, never the caller-supplied folded text', () => {
    // The deny reason interpolates the matched tail unbounded because the value
    // is always a TABLE ENTRY. A fold that echoed the attacker's spelling back
    // would put caller-controlled text into a hook response.
    const result = verdict(`.z${LONG_S}henv`);
    expect(result.decision).toBe('deny');
    expect(result.reason).toContain('.zshenv');
    expect(result.reason).not.toContain(LONG_S);
  });
});

describe('RED — the MULTI-CHARACTER half of folding, observed on this host and not assumed', () => {
  it('refuses every full-fold spelling of every shipped tail that this filesystem actually resolves', async () => {
    // SAME IMPLICATION SHAPE as the U+017F premise arms, and host-neutral for
    // the same reason: EITHER this filesystem does not resolve the folded
    // spelling onto the canonical file (nothing to close) OR the policy refuses
    // the folded spelling. On darwin/APFS the left side is false for `ss`, `fi`
    // and `st`, so the right side carries the arm; on a case-sensitive
    // filesystem the arm is satisfied either way and asserts nothing false.
    //
    // It ranges over the SHIPPED tables, so the answer stays true as the
    // enumeration moves — including for an `ss`-bearing entry, which the
    // one-character generator above can never reach.
    const tails = await shippedTails();
    const exposures = tails.flatMap((tail) => fullFoldSpellings(tail));
    // Non-vacuity floor, not a census: `config`/`profile` carry `fi` and the
    // `*customize.py` pair carries `st`, so a generator that found nothing would
    // be broken rather than reassuring.
    expect(exposures.length, 'the full-fold generator is not vacuous').toBeGreaterThanOrEqual(10);

    const dir = await mkdtemp(path.join(tmpdir(), 'ape-fullfold-fixture-'));
    cleanups.push(dir);

    // The probe measures something: an unrelated name in the same fixture does
    // NOT resolve, so a `true` below is folding and not an open() that succeeds
    // for every argument.
    await writeFile(path.join(dir, 'control-present.txt'), 'probe\n');
    await expect(readFile(path.join(dir, 'control-absent.txt'), 'utf8')).rejects.toThrow();

    for (const [index, exposure] of exposures.entries()) {
      // One box per exposure. The probe CREATES the folded spelling only and
      // READS the canonical one — the exploit direction, and the reason no
      // canonical tool-config filename is ever created by this suite. Every path
      // is inside an mkdtemp fixture removed in afterEach; nothing under $HOME is
      // touched.
      const box = path.join(dir, `probe-${index}`);
      await mkdir(path.join(box, path.dirname(exposure.folded)), { recursive: true });
      await writeFile(path.join(box, exposure.folded), 'probe\n');
      let filesystemResolves = false;
      try {
        await readFile(path.join(box, exposure.canonical), 'utf8');
        filesystemResolves = true;
      } catch {
        filesystemResolves = false;
      }

      const result = verdict(exposure.folded);
      const policyRefuses = result.decision === 'deny' && REFUSES_TOOL_CONFIG.test(result.reason);
      expect(
        !filesystemResolves || policyRefuses,
        `${exposure.ligature} folds to ${exposure.expansion}: filesystem resolves ${exposure.folded} onto ${exposure.canonical}: ${filesystemResolves}; policy refuses the folded spelling: ${policyRefuses}`,
      ).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// DEFAULT-IGNORABLE CODE POINTS — a THIRD resolution mechanism, distinct from
// both of the above, MEASURED here rather than asserted either way. The security
// review of the previous cycle flagged it EXPLICITLY UNVERIFIED because a bound
// READ-ONLY ticket cannot author a probe; this is that probe.
//
// WHY IT IS A THIRD MECHANISM AND NOT A CASE OF EITHER. U+00AD, U+200B..U+200F,
// U+2060 and U+FEFF are not case variants — folding, simple or full, leaves every
// one of them exactly as it found it, so neither pass above can see them — and
// they are not decompositions either: NFC, NFD, NFKC and NFKD all leave U+00AD
// and U+FEFF in place, so the NFC/NFD residual does not cover them by
// implication. Their Unicode property is DEFAULT_IGNORABLE_CODE_POINT, which is
// an instruction to RENDERERS, and the open question — the only one that matters
// here — is whether the FILESYSTEM's name comparison ignores them too. If it
// does, `.ba<U+00AD>shrc` is `.bashrc` to open(2) and an unrelated string to
// every compare this policy makes.
//
// THE SAME HOST-NEUTRAL IMPLICATION SHAPE the fold arms use, for the same
// reason: EITHER this filesystem does not ignore the code point (nothing to
// close) OR the policy refuses the spelling. Nothing is claimed FIXED on the
// strength of prose, and nothing is claimed BROKEN on a host where it is not.
// ---------------------------------------------------------------------------
const DEFAULT_IGNORABLE = [
  ['­', 'U+00AD SOFT HYPHEN'],
  ['​', 'U+200B ZERO WIDTH SPACE'],
  ['‌', 'U+200C ZERO WIDTH NON-JOINER'],
  ['‍', 'U+200D ZERO WIDTH JOINER'],
  ['‎', 'U+200E LEFT-TO-RIGHT MARK'],
  ['‏', 'U+200F RIGHT-TO-LEFT MARK'],
  ['⁠', 'U+2060 WORD JOINER'],
  ['﻿', 'U+FEFF ZERO WIDTH NO-BREAK SPACE'],
];

// Insert one code point inside the FINAL segment of `tail`, never in a directory
// segment: one variable at a time, so a failure names a single code point in a
// single entry — the discipline both fold generators above follow.
function ignorableSpelling(tail, code) {
  const cut = tail.lastIndexOf('/');
  const directory = cut < 0 ? '' : tail.slice(0, cut + 1);
  const name = tail.slice(cut + 1);
  const at = Math.min(2, name.length);
  return `${directory}${name.slice(0, at)}${code}${name.slice(at)}`;
}

describe('RESIDUAL PROBE — default-ignorable code points, measured on this host', () => {
  it('is not a resolution mechanism here, or the policy refuses the spelling', async () => {
    // Four covered entries rather than the whole table: this arm's job is to
    // MEASURE a filesystem property, which does not vary per entry, and the
    // floor check keeps it from going vacuous if the tables move. `.bashrc` and
    // `.zshenv` are shells, `.npmrc` is the demonstrated instance, and
    // `.claude/settings.json` exercises the two-segment path.
    const tails = await shippedTails();
    const floor = ['.bashrc', '.zshenv', '.npmrc', '.claude/settings.json'];
    for (const entry of floor) {
      expect(tails, 'the shipped tables still carry the probed entries').toContain(entry);
    }

    const dir = await mkdtemp(path.join(tmpdir(), 'ape-ignorable-fixture-'));
    cleanups.push(dir);
    // The probe measures something: an absent name in the same fixture does NOT
    // read back, so a `true` below is the filesystem ignoring a code point and
    // not an open() that succeeds for every argument.
    await writeFile(path.join(dir, 'control-present.txt'), 'probe\n');
    await expect(readFile(path.join(dir, 'control-absent.txt'), 'utf8')).rejects.toThrow();

    let index = 0;
    for (const canonical of floor) {
      for (const [code, label] of DEFAULT_IGNORABLE) {
        // One box per exposure, CREATE the ignorable-bearing spelling only and
        // READ the canonical one — the exploit direction, and the reason no
        // canonical tool-config filename is ever created by this suite. Every
        // path is inside an mkdtemp fixture removed in afterEach; nothing under
        // $HOME is touched.
        const spelling = ignorableSpelling(canonical, code);
        const box = path.join(dir, `probe-${index}`);
        index += 1;
        await mkdir(path.join(box, path.dirname(spelling)), { recursive: true });
        await writeFile(path.join(box, spelling), 'probe\n');
        // The create landed under the name it was given. Without this a create
        // that silently failed, or a spelling the OS rejected outright, would
        // make the measurement below read as "does not ignore" for the wrong
        // reason. It holds under EITHER answer: if the filesystem ignores the
        // code point, this reads the same file back through the same spelling.
        await expect(readFile(path.join(box, spelling), 'utf8')).resolves.toContain('probe');
        let filesystemIgnores = false;
        try {
          await readFile(path.join(box, canonical), 'utf8');
          filesystemIgnores = true;
        } catch {
          filesystemIgnores = false;
        }

        const result = verdict(spelling);
        const policyRefuses = result.decision === 'deny' && REFUSES_TOOL_CONFIG.test(result.reason);
        expect(
          !filesystemIgnores || policyRefuses,
          `${label}: filesystem resolves the ignorable-bearing spelling of ${canonical}: ${filesystemIgnores}; policy refuses it: ${policyRefuses}`,
        ).toBe(true);
      }
    }
  });

  it('leaves an ordinary scratch name carrying one of them ADMITTED', () => {
    // The over-block this residual must not turn into. An invisible code point in
    // a scratch filename is not a tool-config write, and a rule that refused every
    // name carrying one would strand the scratchpad exactly as the
    // refuse-all-non-ASCII rule the header rejects would. Green before AND after,
    // whatever a future host measurement forces.
    for (const [code, label] of DEFAULT_IGNORABLE) {
      const result = verdict(`no${code}tes.md`);
      expect(result.decision, label).toBe('allow');
      expect(result.reason, label).toMatch(OUT_OF_PROJECT_ALLOW);
    }
  });
});

describe('GREEN GUARD — a legitimately non-ASCII scratch name stays admitted', () => {
  it('admits ordinary out-of-project files whose names are simply not ASCII', () => {
    // The refusal that must NOT be built: "any segment containing a non-ASCII
    // character is refused" would close the fold and strand every subagent whose
    // scratch file has an accent, a CJK name or an emoji in it. These names fold
    // to themselves and match no table entry, so they stay admitted.
    for (const tail of [
      'café.md',
      'notes-日本語.md',
      'résumé/notes.txt',
      'Über/plan.md',
      'σχέδιο.txt',
      'notes-🙂.md',
      `${LONG_S}cratch.md`,
      `.z${LONG_S}henv-notes.md`,
      `café/.gitignore`,
    ]) {
      const result = verdict(tail);
      expect(result.decision, `${HOME}/${tail}`).toBe('allow');
      expect(result.reason, `${HOME}/${tail}`).toMatch(OUT_OF_PROJECT_ALLOW);
    }
  });

  it('leaves every ASCII verdict exactly where it was (the change is monotone and additive)', () => {
    for (const tail of ['.npmrc', '.bashrc', '.claude/settings.json']) {
      expect(verdict(tail).decision, `${HOME}/${tail}`).toBe('deny');
    }
    for (const tail of ['notes.md', 'settings.json', 'scratch/env', 'tmp/config.toml']) {
      expect(verdict(tail).decision, `${HOME}/${tail}`).toBe('allow');
    }
  });

  it('keeps the fail-closed shapes on their own reasons for a folded tail', () => {
    for (const flag of [undefined, false]) {
      const result = evaluateLifecyclePolicy(
        outsideWrite(`.z${LONG_S}henv`, { out_of_project: flag }),
        { state: running, ticket: readOnlyTicket },
      );
      expect(result.decision, String(flag)).toBe('deny');
      expect(result.reason, String(flag)).toMatch(/aliases a path inside the project/);
    }
  });
});

function git(cwd, ...args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

async function project() {
  const dir = await mkdtemp(path.join(tmpdir(), 'ape-fold-project-'));
  cleanups.push(dir);
  await mkdir(path.join(dir, '__tests__'), { recursive: true });
  await writeFile(path.join(dir, '__tests__', 'sample.test.js'), 'test\n');
  git(dir, 'init', '-q');
  git(dir, 'config', 'user.email', 'ape@example.test');
  git(dir, 'config', 'user.name', 'APE Test');
  git(dir, 'add', '.');
  git(dir, 'commit', '-qm', 'test: baseline');
  const baseline = await currentTreeSha(dir);
  await atomicWriteJson(runtimePaths(dir).active, {
    run_id: 'run-fold',
    status: 'running',
    tree_sha: baseline,
    tickets: [
      {
        ticket_id: 'run-fold:review:r',
        role: 'reviewer',
        writable: false,
        claimed_paths: [],
        test_paths: ['__tests__'],
        base_tree_sha: baseline,
      },
    ],
    receipts: [],
  });
  return dir;
}

async function outsideDir() {
  const dir = await mkdtemp(path.join(tmpdir(), 'ape-fold-scratch-'));
  cleanups.push(dir);
  return dir;
}

function claudeEnv() {
  const env = { ...process.env, CLAUDECODE: '1' };
  delete env.CLAUDE_PROJECT_DIR;
  delete env.CODEX_CWD;
  delete env.APE_TICKET_ID;
  return env;
}

function invokeHook(input, cwd) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [hookBinary], {
      cwd,
      env: claudeEnv(),
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code !== 0) reject(new Error(stderr));
      else resolve(JSON.parse(stdout));
    });
    child.stdin.end(`${JSON.stringify(input)}\n`);
  });
}

function writeCall(dir, filePath) {
  return {
    hook_event_name: 'PreToolUse',
    project_dir: dir,
    session_id: 's1',
    tool_name: 'Write',
    tool_input: { file_path: filePath, content: 'scratch' },
    is_subagent: true,
    ticket_id: 'run-fold:review:r',
  };
}

describe('APE v2 hook binary — folded execution-config spellings end to end', () => {
  it('RED: refuses CREATING a startup file through a folded spelling (the live half)', async () => {
    // The case realpath cannot rescue: `.zlogin` does not exist, so there is
    // nothing to canonicalize and only the RAW tail is consulted. This is also
    // the strongest case — a machine with no `~/.zlogin` is exactly where
    // planting one wins. Nothing is written: a PreToolUse permission check only
    // decides.
    const dir = await project();
    const scratch = await outsideDir();

    const response = await invokeHook(writeCall(dir, path.join(scratch, `.zlogin`)), dir);
    expect(response.hookSpecificOutput.permissionDecision, 'ASCII control').toBe('deny');

    const folded = await invokeHook(writeCall(dir, path.join(scratch, `.z${LONG_S}henv`)), dir);
    expect(folded.hookSpecificOutput.permissionDecision).toBe('deny');
    expect(folded.hookSpecificOutput.permissionDecisionReason).toMatch(REFUSES_TOOL_CONFIG);
  });

  it('RED: refuses CREATING the host-agent settings file through a folded spelling', async () => {
    const dir = await project();
    const scratch = await outsideDir();
    await mkdir(path.join(scratch, '.claude'), { recursive: true });

    const response = await invokeHook(
      writeCall(dir, path.join(scratch, '.claude', `${LONG_S}ettings.json`)),
      dir,
    );
    expect(response.hookSpecificOutput.permissionDecision).toBe('deny');
    expect(response.hookSpecificOutput.permissionDecisionReason).toMatch(REFUSES_TOOL_CONFIG);
  });

  it('GREEN: the already-closed half — an EXISTING canonical file is caught by realpath alone', async () => {
    // Stated so the fix is not sold wider than it is. When `.bashrc` already
    // exists, macOS realpath returns the on-disk spelling and the RESOLVED half
    // of the lookup denies on its own; this arm is green before and after. On a
    // case-sensitive filesystem the folded name is a different file that does
    // not exist, realpath cannot resolve it, and the RAW half — which the arms
    // above require — is what denies. Either way: deny.
    const dir = await project();
    const scratch = await outsideDir();
    await writeFile(path.join(scratch, '.bashrc'), 'existing\n');

    const response = await invokeHook(writeCall(dir, path.join(scratch, `.ba${LONG_S}hrc`)), dir);
    expect(response.hookSpecificOutput.permissionDecision).toBe('deny');
    expect(response.hookSpecificOutput.permissionDecisionReason).toMatch(REFUSES_TOOL_CONFIG);
  });

  it('GREEN: an ordinary out-of-project scratch file with a non-ASCII name is still admitted', async () => {
    const dir = await project();
    const scratch = await outsideDir();

    for (const name of ['café.md', 'notes-日本語.md', `${LONG_S}cratch.md`]) {
      const response = await invokeHook(writeCall(dir, path.join(scratch, name)), dir);
      expect(response.hookSpecificOutput.permissionDecision, name).toBe('allow');
      expect(response.hookSpecificOutput.permissionDecisionReason, name).toMatch(
        OUT_OF_PROJECT_ALLOW,
      );
    }
  });
});
