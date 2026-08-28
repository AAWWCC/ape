import { spawn } from 'node:child_process';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { EVIDENCE_COMMAND_FAMILIES, evaluateLifecyclePolicy } from '../lib/runtime/hooks.js';
import { DEFAULT_CONFIG } from '../lib/runtime/config.js';
import { configAction } from '../lib/runtime/service.js';

// Roadmap entries evidence-command-npm-run-arbitrary-script,
// evidence-command-families-under-description,
// evidence-command-shape-allowlist-mechanism-review, and the ENFORCEMENT half
// of evidence-allowlist-vets-head-not-operand — one coherent change.
//
// THE DEFECT (enforcement half, name channel). EVIDENCE_COMMAND in
// lib/runtime/hooks.js carries the arm
// `(?:npm|pnpm|yarn|bun)\s+(?:run\s+[\w:@./-]+|test|t)\b`. The `[\w:@./-]+`
// accepts ANY package.json script name, so one hop past that arm bypasses all
// three structural defenses at once: SHELL_WRITE (write verbs), COMMAND_CHAIN
// (chaining and redirects) and the inline-interpreter denial. In THIS
// repository `npm run validate` runs `claude plugin validate` plus a python3
// script out of $HOME — code execution wholly OUTSIDE the tree, where the drift
// guard and receipt-time diff recomputation have no reach. And package.json is
// an ordinary production file, so an implementer stage that legitimately claims
// it can DEFINE a script and hand every later stage of the same run — read-only
// reviewers included — an arbitrary-command primitive. Demonstrated: the
// read-only plan checker of run-fixture-0d04382162e5 ran
// `npm run bundle --dry-run` as a permission probe (npm ignores --dry-run for
// run-scripts, so a real build executed from a read-only ticket); self-disclosed
// in receipt d5f75074 D1, escalated by the security review of
// run-fixture-b1453c43be4d (receipt f9410f36, acme PR #367).
//
// THE DEFECT (published half). EVIDENCE_COMMAND_FAMILIES says only
// "npm/pnpm/yarn/bun test scripts" while the regex admits any script. That
// string is published in EVERY issued ticket objective (lib/runtime/service.js)
// and echoed in the shell-policy deny reason, so the rule agents are TOLD is
// narrower than the rule ENFORCED.
//
// THE DEFECT (mechanism). Three further review rounds each found a DIFFERENT
// bypass of the same gate, because they are THREE LAYERS, not three instances
// of one class:
//   L1 the host re-tokenizes and de-quotes before any program sees argv, so
//      `yarn t"ypecheck"` is admitted where `yarn typecheck` is denied, and
//      `yarn run test"-pwn"` membership-tests the PREFIX `test` while the
//      manager receives `test-pwn` (receipt c6fca60a);
//   L2 the gate's own `\b` / `[\w:@./-]` boundary is a BLOCKLIST of separators
//      inside an unanchored `.test()`, so `yarn test:e2e`, `pnpm test-ci`,
//      `bun test.unit` (receipt 49b349d7) and `yarn test+e2e` (receipt
//      c6fca60a) all match THROUGH the always-admitted bare alternative;
//   L3 npm and pnpm parse with nopt, which expands any unambiguous prefix of a
//      known key and expands short-flag clusters, so a refusal naming literal
//      flag spellings is incomplete BY CONSTRUCTION — `npm test --prefi
//      /other/repo` (receipt 08a79879) and `yarn test -rC /tmp` (receipt
//      c6fca60a).
// The replacement is TOKENIZE-THEN-ALLOWLIST: refuse the whole command if it
// carries a character outside a safe set, split on whitespace, recognize the
// head by EXACT TOKEN EQUALITY, and refuse any OPERAND that names a path
// outside the governed project. The head-table and metacharacter arms live in
// the sibling __tests__/runtime-v2-hook-shell-policy.test.js (writable tier,
// the permissive one — a denial proved there is strictly stronger); this file
// owns the tier-dependent contract and the arms that need a real project root.
//
// THE CONTRACT THESE ARMS PIN — a TWO-TIER, ROLE-AWARE gate:
//
//   READ-ONLY TICKET  `<pm> run <script>` is admitted only for OPERATOR-DECLARED
//                     script names. The admitted set is the floor {'test'},
//                     UNION the names derived from the project's configured
//                     test_commands slots and runners[].profile slots, UNION
//                     the new config key `policy.evidence_scripts` (string[],
//                     default []).
//   WRITABLE TICKET   today's full breadth is KEPT, explicitly dispositioned:
//                     the build stage of this very run must be able to run
//                     `npm run bundle` to regenerate dist/ after a
//                     lib/runtime/hooks.js edit. If that arm cannot be green
//                     the run cannot complete.
//   EVERY TIER        bare `<pm> test` and `<pm> t` stay admitted — as COMPLETE
//                     tokens, and only with contained operands.
//   MEMBERSHIP        EXACT STRING equality against a Set — never a composed
//                     regex alternation (an operator entry of `.*` or
//                     `test|validate` must admit NOTHING extra).
//   TIER SELECTION    FAILS CLOSED: read-only unless ticket.writable === true.
//   DEGRADATION       a malformed, unreadable or wrong-typed config degrades to
//                     the floor set and NEVER throws. Load-bearing: a throw
//                     inside the policy propagates to bin/ape-hook.mjs's
//                     top-level catch which, while a run is live, denies EVERY
//                     subsequent tool event and bricks the session until dist/
//                     is reverted by hand.
//   SYNCHRONY         evaluateLifecyclePolicy stays SYNCHRONOUS. Its callers
//                     (the deletion channel comment in hooks.js says so
//                     explicitly) consume a plain decision object.
//
// FIXTURE NOTE. The two-tier gate reads the project's config, so these arms
// need a real per-project `.ape/runtime/config.json`. Every fixture project is
// an os.tmpdir scratch directory — this suite must never write a byte inside
// the repository it gates. The pre-existing sibling suite
// __tests__/runtime-v2-hook-shell-policy.test.js cannot pin this boundary:
// every ticket fixture there is `writable: true` and its `boundSubagent`
// helper attaches no project_dir, so the whole file lands in the permissive
// tier and would stay green under the defect.

const state = { status: 'running' };

// Read-only ticket: a reviewer/plan-checker StageTicket. This is the tier the
// escalation is about — the role that ran `npm run bundle` for real.
const readOnlyTicket = Object.freeze({
  ticket_id: 'run-1:review:r',
  role: 'reviewer',
  writable: false,
  test_paths: ['__tests__'],
  claimed_paths: [],
});

// Writable ticket: the implementer/build stage that legitimately regenerates
// dist/ with `npm run bundle`.
const writableTicket = Object.freeze({
  ticket_id: 'run-1:build:b',
  role: 'implementer',
  writable: true,
  test_paths: ['__tests__'],
  claimed_paths: ['lib'],
});

const dirs = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) {
    // A fixture may have chmod'ed its config unreadable; restore before rm so
    // cleanup never leaves scratch behind.
    try {
      chmodSync(path.join(dir, '.ape', 'runtime', 'config.json'), 0o700);
    } catch {
      // no config, or already removable
    }
    rmSync(dir, { recursive: true, force: true });
  }
});

// A fixture project: an out-of-tree scratch root carrying a real
// `.ape/runtime/config.json`. `config` may be an object (serialized) or a raw
// string (to model a malformed file); `null` writes no config file at all.
// `sub/` and `packages/api/` exist so a `cd <dir> &&` arm is not sensitive to
// whether the implementation checks the prefix lexically or on disk.
function project(config = null) {
  const dir = mkdtempSync(path.join(tmpdir(), 'ape-evidence-scripts-'));
  dirs.push(dir);
  mkdirSync(path.join(dir, '.ape', 'runtime'), { recursive: true });
  mkdirSync(path.join(dir, 'sub'), { recursive: true });
  mkdirSync(path.join(dir, 'packages', 'api'), { recursive: true });
  if (config !== null) {
    writeFileSync(
      path.join(dir, '.ape', 'runtime', 'config.json'),
      typeof config === 'string' ? config : JSON.stringify(config),
      'utf8',
    );
  }
  return dir;
}

function configFile(dir) {
  return path.join(dir, '.ape', 'runtime', 'config.json');
}

// The bound-subagent Bash decision, evaluated SYNCHRONOUSLY. `projectDir` of
// `null` omits the field entirely (the no-project_dir event shape).
// `evidence` is the realpath-grade verdict bin/ape-hook.mjs precomputes; when
// omitted the event carries none, which is the fail-closed shape.
function decide(command, { ticket = readOnlyTicket, projectDir = null, evidence } = {}) {
  return evaluateLifecyclePolicy(
    {
      host: 'claude',
      is_subagent: true,
      ape_managed: true,
      tool_name: 'Bash',
      command,
      ...(projectDir === null ? {} : { project_dir: projectDir }),
      ...(evidence === undefined ? {} : { evidence }),
    },
    { state, ticket },
  );
}

function expectAllow(command, options) {
  expect(decide(command, options).decision, command).toBe('allow');
}

function expectDeny(command, options) {
  expect(decide(command, options).decision, command).toBe('deny');
}

describe('APE v2 evidence-command run-script allowlist (two-tier, role-aware)', () => {
  it('keeps every fixture project out of the governed tree', () => {
    // Guard on the guard: a red-test admission refuses side-effect writes to
    // the repository, so the fixtures must provably live elsewhere. (On win32
    // a temp dir on another volume makes path.relative return an absolute
    // path; both forms are out-of-tree.)
    const repoRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
    const dir = project({});
    const relative = path.relative(repoRoot, dir);
    expect(relative.startsWith('..') || path.isAbsolute(relative)).toBe(true);
  });

  describe('read-only tier: only operator-declared script names', () => {
    it('DENIES an undeclared package.json script to a read-only ticket, for every package manager', () => {
      // (a) The escalation itself. `validate` executes code outside the tree,
      // `bundle` writes dist/, `typecheck` is merely undeclared — none is in
      // the floor set, so a read-only ticket may run none of them.
      const dir = project({});
      for (const manager of ['npm', 'pnpm', 'yarn', 'bun']) {
        for (const script of ['validate', 'bundle', 'typecheck']) {
          expectDeny(`${manager} run ${script}`, { projectDir: dir });
        }
      }
    });

    it('ALLOWS the floor set to a read-only ticket: bare test, bare t, and `run test`', () => {
      // (b) The floor is non-empty and host-neutral: 'test' is admitted with
      // no configuration at all, and the bare `<pm> test` / `<pm> t` forms are
      // never narrowed by the tiering.
      const dir = project({});
      for (const command of [
        'npm test',
        'npm t',
        'npm run test',
        'pnpm test',
        'pnpm run test',
        'yarn test',
        'yarn run test',
        'bun test',
        'bun run test',
      ]) {
        expectAllow(command, { projectDir: dir });
      }
    });

    it('DENIES `<pm> test<sep><name>` and `<pm> t<sep><name>` — the bare arm is a COMPLETE token', () => {
      // (m) TOKEN BOUNDARY, deny half. The bare alternative ends on a WORD
      // boundary (`|test|t)\b`) and EVIDENCE_COMMAND is `.test()`ed with no end
      // anchor, so `\b` holds between `t` and every separator a package script
      // name actually uses — `:` `-` `.` `/` `@`. `yarn test:e2e` therefore
      // matches THROUGH the bare alternative: RUN_SCRIPT_INVOCATION requires a
      // literal `run`, so it never reaches the tier gate, and neither SHELL_WRITE
      // nor COMMAND_CHAIN sees anything wrong with it. That is escalation ground
      // (2) intact — an implementer stage that legitimately claims package.json
      // need only name its script `test:x` to hand every later read-only stage an
      // arbitrary-command primitive. This repository already ships `test:watch`
      // (a never-terminating watch a read-only stage can start) and `test:v2`.
      // yarn (1 and berry), pnpm and bun all execute `<pm> <script>` as the
      // package script; npm alone rejects the no-`run` form, and refusing it
      // there too keeps ONE rule across the four managers.
      //
      // Under tokenize-then-allowlist the refusal is EXACT TOKEN EQUALITY —
      // `tokens[1]` must be exactly `test`, `t` or `run` — not a widened
      // separator class. A lookahead like `(?![\w:@./-])` is another separator
      // class and is precisely the construct that produced round 3.
      const dir = project({});
      for (const command of [
        'yarn test:e2e',
        'pnpm test-ci',
        'yarn t-deploy',
        'bun test.unit',
        'npm test:v2',
        'pnpm test:watch',
        'bun t.smoke',
        'yarn t:release',
        'npm test/all',
        'pnpm test@ci',
        'bun t-publish',
        'yarn t/deploy',
      ]) {
        expectDeny(command, { projectDir: dir });
      }
    });

    it('still ALLOWS the bare forms, a flag tail, and bun\'s own file-operand runner', () => {
      // (n) TOKEN BOUNDARY, allow half — the over-match guard that keeps the
      // tightening from stranding real evidence. `bun test <path>` is BUN'S OWN
      // test runner taking a file operand, not a package script at all, so it
      // must stay admitted; so must a flag tail and the `-- <args>` pass-through
      // every runner needs. A boundary that refuses a complete token followed by
      // whitespace or end-of-string would deny every bun project its suite.
      const dir = project({});
      for (const command of [
        'npm test',
        'npm t',
        'pnpm test',
        'pnpm t',
        'yarn test',
        'yarn t',
        'bun test',
        'bun t',
        'npm test -- --silent',
        'yarn test --silent',
        'bun test src/x.test.ts',
        'bun test ./src/x.test.ts --coverage',
        'bun test test/unit',
      ]) {
        expectAllow(command, { projectDir: dir });
      }
    });

    it('derives the admitted names from the project\'s configured test_commands', () => {
      // (c) Invariant 6 (project agnosticism): a foreign project that names its
      // suite `npm run spec` must be able to run it without the runtime
      // hardcoding this repository's script names. The operator already
      // declared the real command in test_commands; the allowlist follows THAT.
      const dir = project({ test_commands: { full: 'npm run spec' } });
      expectAllow('npm run spec', { projectDir: dir });
      expectAllow('npm run test', { projectDir: dir });
      expectDeny('npm run validate', { projectDir: dir });
      expectDeny('npm run bundle', { projectDir: dir });
    });

    it('derives names from a `{paths}` test_commands template too', () => {
      // The stored slots are whole command strings, some carrying the red-phase
      // `{paths}` placeholder. The derivation must reduce those to the script
      // name rather than only matching a bare two-token command.
      const dir = project({
        test_commands: { targeted_template: 'yarn run check {paths}', full: 'yarn run check' },
      });
      expectAllow('yarn run check', { projectDir: dir });
      expectDeny('yarn run validate', { projectDir: dir });
    });

    it('derives names from the runners[].profile slots', () => {
      // The polyglot multi-runner config declares per-runner gate commands in
      // the same test_commands slot discipline; a monorepo whose suite runs
      // through a runner profile must not be locked out of its own evidence.
      const dir = project({
        runners: [
          { id: 'web', owns: ['web/**'], root: 'web', profile: { full: 'pnpm run suite' } },
        ],
      });
      expectAllow('pnpm run suite', { projectDir: dir });
      expectDeny('pnpm run validate', { projectDir: dir });
    });

    it('admits an operator-declared name from policy.evidence_scripts', () => {
      // (d) The explicit lever, for a script the test_commands derivation
      // cannot see (a lint/typecheck evidence command a gate requires).
      const dir = project({ policy: { evidence_scripts: ['typecheck'] } });
      expectAllow('npm run typecheck', { projectDir: dir });
      expectAllow('bun run typecheck', { projectDir: dir });
      expectDeny('npm run validate', { projectDir: dir });
      expectDeny('npm run bundle', { projectDir: dir });
    });

    it('matches evidence_scripts entries by EXACT string, never as a regex or a prefix', () => {
      // (j) The exact-membership canary. A composed regex alternation would
      // turn an operator entry into a hole: `.*` would admit everything and
      // `test|validate` would admit `validate` as an alternative. Membership is
      // Set equality, so both entries admit exactly the literal script names
      // `.*` and `test|validate`, which no package.json defines.
      const wildcards = project({ policy: { evidence_scripts: ['.*', 'test|validate'] } });
      expectDeny('npm run validate', { projectDir: wildcards });
      expectDeny('npm run bundle', { projectDir: wildcards });
      expectAllow('npm run test', { projectDir: wildcards });

      // A prefix is not a member either.
      const prefix = project({ policy: { evidence_scripts: ['bund'] } });
      expectDeny('npm run bundle', { projectDir: prefix });
      const exact = project({ policy: { evidence_scripts: ['bundle'] } });
      expectAllow('npm run bundle', { projectDir: exact });
    });

    it('treats a grammar-LEGAL metacharacter name as a LITERAL, never as a pattern', () => {
      // (o) The exact-membership canary that is not vacuous in EITHER half.
      // The `.*` / `test|validate` entries in the arm above never reach
      // membership at all: every policy.evidence_scripts entry is filtered
      // through the `^[\w:@./-]+$` name grammar BEFORE it joins the admitted set,
      // and neither entry passes it — so that half stays green even under a
      // composed ANCHORED alternation, which is precisely the composition an
      // exact-membership canary exists to kill. The prefix pair above is the
      // non-vacuous half today (it kills an UNANCHORED composition); this arm
      // supplies the other one.
      //
      // `.` IS inside the name grammar, so a dotted name survives the filter and
      // really reaches membership. Under Set equality it admits only the literal
      // characters it spells; under ANY regex composition — anchored or not,
      // and unescaped — its `.` matches any character and admits a script the
      // operator never declared.
      const dotted = project({ policy: { evidence_scripts: ['b.ndle', 'v.lidate'] } });
      expectDeny('npm run bundle', { projectDir: dotted });
      expectDeny('npm run validate', { projectDir: dotted });
      // Non-vacuity proof: the entries genuinely survived the name-grammar
      // filter and admit the literal names they spell, so the two denials above
      // are exact-membership results — not the entries being silently dropped.
      expectAllow('npm run b.ndle', { projectDir: dotted });
      expectAllow('npm run v.lidate', { projectDir: dotted });
      // The floor is unaffected either way.
      expectAllow('npm run test', { projectDir: dotted });

      // The same property spelled with the reviewer's own example name. Note the
      // direction: `t.st` cannot be canaried against `npm run test`, because
      // `test` is in the FLOOR and is admitted with or without any declaration —
      // the observable difference is the character the `.` would stand in for.
      const dottedTest = project({ policy: { evidence_scripts: ['t.st'] } });
      expectDeny('npm run t3st', { projectDir: dottedTest });
      expectDeny('npm run tXst', { projectDir: dottedTest });
      expectAllow('npm run t.st', { projectDir: dottedTest });
      expectAllow('npm run test', { projectDir: dottedTest });
    });
  });

  // =======================================================================
  // ENTRY C — readonly-run-script-tier-misses-the-bare-script-name-shape.
  //
  // THE TIER'S PREDICATE IS `parsed.tokens[1] === 'run'`, so its coverage is
  // exactly `<pm> run <script>` and nothing else. recognizeLintHead admits
  // `<pm> <linter>` at index 1 for pnpm / yarn / bun, and yarn 1 and pnpm
  // EXECUTE A PACKAGE.JSON SCRIPT BY BARE NAME — so on a read-only ticket
  // `yarn eslint` is admitted (the tool is a linter, not a formatter, so no
  // --check is demanded), and in a project that declares a script named
  // exactly `eslint` / `mypy` / `pylint` / `flake8` that script's arbitrary
  // content runs with the word `run` never appearing.
  //
  // THE COVERAGE IS DOCUMENTED, NOT ENFORCED — deliberately, and these arms
  // are what keep the two statements from drifting apart. Extending the tier
  // predicate to the bare-name shape cannot distinguish `yarn eslint`
  // resolving to a DECLARED SCRIPT from `yarn eslint` resolving to the
  // INSTALLED BINARY, so it would deny a legitimate read-only lint in every
  // project that has eslint installed and undeclared — a real over-block cost
  // against a residual that is STRICTLY NARROWER than pre-#368 main (which
  // admitted `yarn mypy-x` and every suffixed spelling) and is an instance of
  // the arbitrary-CONTENT class that published residual R1 already carries. It
  // is not new capability. docs/hooks.md states what the tier covers; the arms
  // below pin the behavior that statement describes, in BOTH directions, so a
  // silent predicate change turns them red and a silent doc change is
  // contradicted by a running test.
  // =======================================================================
  describe('entry C: the read-only run-script tier covers `<pm> run <script>` ONLY', () => {
    it('gates the `run` shape on the declared set, for a linter name like any other', () => {
      // A script named after a linter is still just a script when it is
      // reached through `run`: the tier decides it, and an undeclared name is
      // refused whatever it is called.
      const dir = project({});
      for (const command of [
        'yarn run eslint',
        'pnpm run eslint',
        'npm run mypy',
        'bun run pylint',
        'yarn run flake8',
      ]) {
        expectDeny(command, { projectDir: dir });
      }
    });

    it('does NOT reach the bare-name shape, which the LINT recognizer admits', () => {
      // The published coverage gap, pinned as behavior rather than left as a
      // sentence in a doc nothing executes. pnpm, yarn and bun run a declared
      // package.json script by bare name, so in a project declaring a script
      // called `eslint` these commands reach that script's arbitrary content —
      // and the gate cannot tell that from the installed binary, which is why
      // the entry's acceptance was discharged with DOCUMENTATION.
      const dir = project({});
      for (const command of ['yarn eslint', 'pnpm eslint', 'bun mypy', 'yarn pylint src/']) {
        expectAllow(command, { projectDir: dir });
      }
    });

    it('bounds the residual: the bare-name shape is inside the LINT gate, not beside it', () => {
      // What keeps this narrow, and the reason the entry calls it a
      // documentation defect rather than an escalation: the shape is reachable
      // only through an EXACT linter name with a check-only tail and a
      // contained operand. It is NOT a general `<pm> <script>` channel, `npm`
      // is not one of the managers that resolve a bare name, and every
      // suffixed spelling — the pre-#368 `yarn mypy-x` hole — is refused.
      const dir = project({});
      for (const command of [
        'yarn typecheck',
        'yarn mypy-x',
        'npm eslint',
        'pnpm eslint --fix src/',
        'yarn black src/',
        'bun eslint --config ./evil.js',
        'yarn eslint /outside-ape-probe/src',
      ]) {
        expectDeny(command, { projectDir: dir });
      }
    });
  });

  describe('writable tier: today\'s breadth is kept, explicitly', () => {
    it('ALLOWS `npm run bundle` to a writable ticket — the hard constraint', () => {
      // (e) Any lib/runtime change makes the committed dist/ bundles stale and
      // __tests__/runtime-v2-bundle-freshness.test.js fails the whole-suite
      // gate; the implementer regenerates with `npm run bundle`. THIS RUN is an
      // instance — it changes lib/runtime/hooks.js. If this arm is not green
      // the run cannot complete.
      const dir = project({});
      expectAllow('npm run bundle', { ticket: writableTicket, projectDir: dir });
      expectAllow('npm run typecheck', { ticket: writableTicket, projectDir: dir });
      expectAllow('npm test', { ticket: writableTicket, projectDir: dir });
    });

    it('FAILS CLOSED to the read-only tier when `writable` is absent or not exactly true', () => {
      // (f) Tier selection keys on `ticket.writable === true`. A ticket shape
      // that omits the field, or carries a truthy non-boolean, must NOT inherit
      // the permissive tier — an absent field is the shape a malformed or
      // partially-projected ticket arrives in.
      const dir = project({});
      const absent = { ticket_id: 'run-1:x:a', role: 'reviewer', test_paths: [], claimed_paths: [] };
      const stringy = { ...absent, ticket_id: 'run-1:x:s', writable: 'true' };
      const numeric = { ...absent, ticket_id: 'run-1:x:n', writable: 1 };
      for (const ticket of [absent, stringy, numeric]) {
        expectDeny('npm run bundle', { ticket, projectDir: dir });
        expectDeny('npm run validate', { ticket, projectDir: dir });
        // The floor still works, so failing closed never strands the role.
        expectAllow('npm test', { ticket, projectDir: dir });
        expectAllow('npm run test', { ticket, projectDir: dir });
      }
    });
  });

  describe('no project config to read', () => {
    it('yields the read-only tier with the floor set only when the event carries no project_dir', () => {
      // (g) An event with no project_dir has no config to derive from. It must
      // resolve to the floor — never widen, and never silently fall back to the
      // current working directory's project, which is a different project's
      // configuration than the one the event describes.
      for (const projectDir of [null, '']) {
        expectAllow('npm test', { projectDir });
        expectAllow('npm run test', { projectDir });
        expectDeny('npm run spec', { projectDir });
        expectDeny('npm run validate', { projectDir });
        expectDeny('npm run bundle', { projectDir });
      }
    });
  });

  describe('degraded config: floor set, and NEVER a throw', () => {
    // (h) A throw inside the policy propagates to bin/ape-hook.mjs's top-level
    // failure path which, while a run is live, denies EVERY subsequent tool
    // event and bricks the session until dist/ is reverted by hand. Each of
    // these must return an ordinary decision object.
    function expectFloorWithoutThrowing(dir, label) {
      let result;
      expect(() => {
        result = decide('npm run validate', { projectDir: dir });
      }, label).not.toThrow();
      expect(result, label).toBeTruthy();
      expect(typeof result, label).toBe('object');
      expect(['allow', 'deny'], label).toContain(result.decision);
      expect(result.decision, label).toBe('deny');

      let floor;
      expect(() => {
        floor = decide('npm run test', { projectDir: dir });
      }, label).not.toThrow();
      expect(floor.decision, label).toBe('allow');
    }

    it('degrades to the floor on malformed config JSON', () => {
      expectFloorWithoutThrowing(project('{ this is not json'), 'malformed json');
      expectFloorWithoutThrowing(project(''), 'empty file');
      expectFloorWithoutThrowing(project('[]'), 'array at the config root');
      expectFloorWithoutThrowing(project('null'), 'null at the config root');
    });

    it('degrades to the floor on an unreadable config', () => {
      // Two unreadable shapes: EACCES (chmod 000) and a config path that is a
      // DIRECTORY (EISDIR). The directory case is uid-independent, so it holds
      // even where chmod cannot remove read permission (root, win32) — and in
      // that case the chmod fixture simply reads back as an ordinary empty
      // config, which is the same floor outcome.
      const denied = project({});
      chmodSync(configFile(denied), 0o000);
      expectFloorWithoutThrowing(denied, 'EACCES config');

      const asDirectory = project();
      mkdirSync(configFile(asDirectory), { recursive: true });
      expectFloorWithoutThrowing(asDirectory, 'config path is a directory');
    });

    it('degrades to the floor on a wrong-typed policy.evidence_scripts or test_commands', () => {
      expectFloorWithoutThrowing(
        project({ policy: { evidence_scripts: 'validate' } }),
        'evidence_scripts is a string',
      );
      expectFloorWithoutThrowing(
        project({ policy: { evidence_scripts: { validate: true } } }),
        'evidence_scripts is an object',
      );
      expectFloorWithoutThrowing(
        project({ policy: { evidence_scripts: [42, null] } }),
        'evidence_scripts holds non-string elements',
      );
      expectFloorWithoutThrowing(project({ test_commands: 42 }), 'test_commands is a number');
      expectFloorWithoutThrowing(project({ runners: 'web' }), 'runners is a string');
      expectFloorWithoutThrowing(project({ policy: 7 }), 'policy is a number');
    });

    it('answers synchronously — the policy must not become async', () => {
      // The decision is consumed synchronously by every caller of
      // evaluateLifecyclePolicy; reading the project config must not turn it
      // into a promise-returning function.
      const dir = project({ policy: { evidence_scripts: ['typecheck'] } });
      const result = decide('npm run validate', { projectDir: dir });
      expect(result).not.toBeInstanceOf(Promise);
      expect(typeof result?.then).not.toBe('function');
      expect(result.decision).toBe('deny');
    });
  });

  describe('the `cd <dir> &&` prefix may not relocate the derivation', () => {
    it('ALLOWS a derived script behind a leading cd into a project subdirectory', () => {
      // (i, allow half) A nested test root is reached with `cd <dir> && <cmd>`;
      // that form stays admitted for an admitted script name.
      const dir = project({ test_commands: { full: 'npm run spec' } });
      expectAllow('cd sub && npm run test', { projectDir: dir });
      expectAllow('cd packages/api && npm run spec', { projectDir: dir });
      expectAllow('cd ./sub && npm run test', { projectDir: dir });
    });

    it('DENIES a leading cd that leaves the project the derivation came from', () => {
      // (i, deny half) The admitted set is derived from THIS project's config.
      // A cd to an absolute path, or one that escapes upward, runs a DIFFERENT
      // project's script under this project's allowlist — the derivation no
      // longer describes what would execute, so it fails closed.
      const dir = project({ test_commands: { full: 'npm run spec' } });
      for (const command of [
        'cd /abs && npm run test',
        'cd /tmp && npm run spec',
        'cd ../other && npm run test',
        'cd ../../ && npm run spec',
        'cd sub/../.. && npm run test',
      ]) {
        expectDeny(command, { projectDir: dir });
      }
    });

    it('DENIES a leaving cd on the BARE `<pm> test` / `<pm> t` arm exactly as on `run`', () => {
      // (p) The cd re-gate is not a run-script feature, it is not even a
      // package-manager feature: under containment the cd TARGET is subjected
      // to the same predicate for EVERY head. `cd <outside> && npm run test` is
      // refused because the derivation no longer describes what would execute —
      // but `npm test` runs the `test` script of whatever package.json the
      // package manager finds from the NEW cwd, which is the identical
      // out-of-tree execution with the word `run` dropped. Verified against the
      // live hook by the security review: `cd /nonexistent-ape-probe-dir && npm
      // run test` is DENIED while `cd /nonexistent-ape-probe-dir && npm test` is
      // ALLOWED, because the re-gate sat inside the `run`-only branch — round
      // 1a's bug shape. Reachable with no prior write (any other repo on the
      // machine) and self-contained with one, since an out-of-project Write is
      // allowed before the read-only deny is reached.
      const dir = project({});
      for (const command of [
        'cd /abs && npm test',
        'cd /nonexistent-ape-probe-dir && npm test',
        'cd /tmp && npm t',
        'cd ../other && pnpm test',
        'cd ../../ && yarn test',
        'cd sub/../.. && bun test',
        'cd /abs && bun test src/x.test.ts',
        'cd /abs && yarn t',
      ]) {
        expectDeny(command, { projectDir: dir });
      }
    });

    it('ALLOWS the bare arm behind a leading cd that stays inside the project', () => {
      // (q) The allow half of the same re-gate: a nested test root reached with
      // `cd <in-project dir> &&` is exactly the friction the cd prefix exists to
      // remove, and it must survive the tightening for the bare forms too.
      const dir = project({});
      for (const command of [
        'cd sub && npm test',
        'cd ./sub && npm t',
        'cd packages/api && pnpm test',
        'cd packages/api && bun test src/x.test.ts',
        'cd sub && yarn test --silent',
      ]) {
        expectAllow(command, { projectDir: dir });
      }
    });

    it('generalizes the cd containment to every head, not only the package managers', () => {
      // Round 1a's bug shape was PLACEMENT: the re-gate lived inside the
      // package-manager branch. `pytest`, `cargo test` and `npx vitest` relocate
      // just as effectively, so the cd target faces the containment predicate
      // for EVERY head.
      const dir = project({});
      for (const command of [
        'cd /other/repo && pytest',
        'cd .. && cargo test',
        'cd ../elsewhere && npx vitest run x',
        'cd /tmp && ruff check',
        'cd /tmp && git status',
        'cd /tmp && ls -la',
      ]) {
        expectDeny(command, { projectDir: dir });
      }
      for (const command of [
        'cd sub && pytest',
        'cd packages/api && cargo test',
        'cd sub && npx vitest run x',
        'cd sub && ruff check',
        'cd sub && git status',
      ]) {
        expectAllow(command, { projectDir: dir });
      }
    });

    it('keeps chaining, redirects and substitution denied on the run-script arm', () => {
      // (k) An admitted script name must not become a launcher. These are the
      // three structural defenses the `[\w:@./-]+` arm hops past today; they
      // stay in force on the narrowed arm, for admitted names and behind cd.
      const dir = project({ policy: { evidence_scripts: ['typecheck'] } });
      for (const command of [
        'npm run test && rm -rf build',
        'npm run typecheck && node -e "require(\'fs\').rmSync(\'package.json\')"',
        'npm run test > out.txt',
        'npm run test>out.txt',
        'npm run test | node evil.js',
        'npm run test; rm -rf .git',
        'npm run test $(node evil.js)',
        'npm run test `node evil.js`',
        'npm run test\nrm -rf .',
        'cd sub && npm run test && rm -rf .git',
      ]) {
        expectDeny(command, { projectDir: dir });
      }
    });
  });

  describe('a read-only package-manager command may not relocate its own working directory', () => {
    it('DENIES a directory-relocation flag in the tail, spaced and `=`, bare and `run`', () => {
      // (r) The second route out of the tree, with no `cd` at all and therefore
      // nothing for the cd re-gate to inspect: the package managers all take an
      // explicit directory flag in the tail. npm sets its localPrefix straight
      // from an explicit `--prefix` (@npmcli/config loadLocalPrefix) and runs the
      // script at that prefix; pnpm takes `-C`/`--dir`, yarn takes `--cwd`, bun
      // takes `--cwd`. None of these tokens is a shell metacharacter, so
      // SHELL_WRITE and COMMAND_CHAIN pass them untouched, and the tier gate
      // inspects only the script name near the head — so `npm run test --prefix
      // /outside` executes a FOREIGN package.json's `test` script under this
      // project's derived allowlist just as surely as a leaving `cd` would.
      //
      // Every target here is out-of-tree, and the closure is the OPERAND, never
      // the flag name: matching the flag is a literal-spelling blocklist that
      // round 4 (`--prefi`) and round 3 (`-rC`) already defeated.
      const dir = project({});
      for (const command of [
        'npm test --prefix /outside-ape-probe',
        'npm test --prefix=/outside-ape-probe',
        'npm run test --prefix /outside-ape-probe',
        'npm run test --prefix=/outside-ape-probe',
        'npm t --prefix ../outside-ape-probe',
        'pnpm test --dir /outside-ape-probe',
        'pnpm test --dir=/outside-ape-probe',
        'pnpm run test --dir /outside-ape-probe',
        'pnpm run test -C /outside-ape-probe',
        'pnpm test -C=/outside-ape-probe',
        'pnpm t -C ../outside-ape-probe',
        'yarn test --cwd /outside-ape-probe',
        'yarn run test --cwd=/outside-ape-probe',
        'bun test --cwd /outside-ape-probe',
        'bun run test --cwd=/outside-ape-probe',
      ]) {
        expectDeny(command, { projectDir: dir });
      }
    });

    it('leaves the plain forms and an ordinary flag tail admitted', () => {
      // (s) The over-block guard for (r): only an OUT-OF-TREE operand is
      // refused. A blanket "no flags in the tail" rule would take out the
      // ordinary reporter/verbosity flags and the `--` pass-through that every
      // runner needs, and would strand `bun test <path>` as collateral.
      const dir = project({});
      for (const command of [
        'npm test',
        'npm run test',
        'npm test --silent',
        'npm test -- --silent',
        'pnpm run test',
        'yarn test --verbose',
        'bun test src/x.test.ts',
        'cd sub && npm test --silent',
      ]) {
        expectAllow(command, { projectDir: dir });
      }
    });

    it('refuses the nopt ABBREVIATION and the short-flag CLUSTER by the operand alone', () => {
      // L3, the layer no string-side blocklist can close. nopt expands any
      // unambiguous prefix of a known key (`--prefi` IS `--prefix`) and expands
      // short-flag clusters (`-rC /tmp` becomes `-r -C /tmp`), so enumerating
      // spellings is incomplete BY CONSTRUCTION. The deny must come from the
      // OPERAND — which is why the reason names the path, not the flag.
      //
      // The last case is the STICKY form, and it needs one extra containment
      // rule that is still spelling-free: `-C/other/repo` is a single token, so
      // resolving it whole against the root yields `<root>/-C/other/repo` —
      // inside, and wrongly admitted. The rule that catches it names no flag:
      // a token that BEGINS with `-` and contains a path separator carries a
      // stuck-on operand, so the candidate path is the substring from its first
      // separator onward. No allow arm in either suite has a `-`-leading token
      // containing `/`, so this costs nothing and stays a positive rule over the
      // token rather than a blocklist over flag names.
      const dir = project({});
      for (const command of [
        'npm test --prefi /other/repo',
        'npm test --pref /other/repo',
        'npm test --pre=/other/repo',
        'yarn test -rC /tmp',
        'pnpm test -C/other/repo',
      ]) {
        expectDeny(command, { projectDir: dir });
      }
      const denied = decide('npm test --prefi /other/repo', { projectDir: dir });
      expect(denied.decision).toBe('deny');
      expect(denied.reason).toContain('/other/repo');
    });

    it('`--dir tests` is ADMITTED while `--dir /outside` is DENIED', () => {
      // The `--dir` collision: it is vitest's OWN real flag, so a
      // relocation-flag blocklist over-blocked `pnpm vitest --dir tests` with a
      // misleading reason. Under containment the two forms separate correctly —
      // a strict improvement that gets its own arm.
      const dir = project({});
      expectAllow('pnpm vitest --dir tests', { projectDir: dir });
      expectDeny('pnpm vitest --dir /outside', { projectDir: dir });
    });
  });

  describe('L1: the shell re-tokenizes and de-quotes before any program sees argv', () => {
    it('DENIES the quoted, escaped and out-of-class separator forms on a read-only ticket', () => {
      // The round-3 block. Every one of these is ADMITTED today with argv
      // identical to a form that is DENIED, because the gate pattern-matches
      // the raw string while the host shell de-escapes it first. The closure is
      // syntactic and total: any of these characters refuses the WHOLE command.
      const dir = project({ policy: { evidence_scripts: ['typecheck'] } });
      for (const manager of ['npm', 'pnpm', 'yarn', 'bun']) {
        for (const command of [
          `${manager} t"ypecheck"`,
          `${manager} test":e2e"`,
          `${manager} test\\:e2e`,
          `${manager} run test"-pwn"`,
          `${manager} test --cwd\\=/tmp`,
          `${manager} test+e2e`,
          `${manager} test -rC /tmp`,
        ]) {
          expectDeny(command, { projectDir: dir });
        }
      }
    });

    it('leaves the unquoted, unescaped forms of the same commands decided on their merits', () => {
      // Non-vacuity: the refusal above is about the CHARACTERS, so the plain
      // spellings still get their ordinary verdict — `typecheck` is declared
      // here and admitted, `test` is the floor, and `--cwd=/tmp` is refused by
      // its operand rather than by a quote.
      const dir = project({ policy: { evidence_scripts: ['typecheck'] } });
      expectAllow('npm run typecheck', { projectDir: dir });
      expectAllow('npm test', { projectDir: dir });
      expectAllow('npm run test', { projectDir: dir });
      expectDeny('npm test --cwd=/tmp', { projectDir: dir });
    });
  });

  describe('containment: every operand of an evidence command stays inside the tree', () => {
    it('DENIES a token, or a `=`-suffix, that names a path outside the governed project', () => {
      const dir = project({});
      for (const command of [
        'node --test /outside/x.test.mjs',
        'node --test ../outside/x.test.mjs',
        'npx vitest --config /outside/v.mjs',
        'npx vitest --config=/outside/v.mjs',
        'pytest --rootdir=/outside',
        'cargo test --manifest-path ../other/Cargo.toml',
        'cat /etc/passwd',
        'ls /etc',
        'git show --output=/tmp/x HEAD',
      ]) {
        expectDeny(command, { projectDir: dir });
      }
    });

    it('DENIES a tilde in an EXPANSION position, and only there', () => {
      // Tilde expansion fires at token start and after `=` or `:` inside a
      // word. A blanket refusal would permanently deny `git log HEAD~3`,
      // `git diff HEAD~1` and `git show HEAD~1:<path>` to every bound role —
      // commands this pipeline's own later stages run — so the rule is
      // POSITIONAL. Because quotes and metacharacters are already refused,
      // words ARE exactly the whitespace tokens, so the positional rule is
      // complete.
      //
      // THE DELETION-DETECTOR FOR THAT POSITIONAL CHECK, read-only half
      // (roadmap entry evidence-gate-self-policing-claims-overstated, A1).
      // EVIDENCE_TOKEN_CHAR_REFUSED admits a strict SUPERSET of what
      // DELETION_TOKEN_CHAR_REFUSED admits — three characters more, `~`, `=`
      // and `^` — and it KEEPS `~` rather than omitting it, because
      // EVIDENCE_EXPANSION_POSITION refuses that character POSITIONALLY here
      // while the deletion channel refuses all three WHOLESALE. So levelling
      // the two alphabets at each other, or deleting the positional check as
      // redundant, turns both halves of this arm red at once. The twin lives in
      // __tests__/runtime-v2-hook-shell-policy.test.js ('tilde is refused
      // POSITIONALLY, not wholesale'), in the permissive WRITABLE tier where a
      // denial is the stronger claim; this one runs on a READ-ONLY ticket with
      // a real project root. Two tiers, two arms — a THIRD copy adds no
      // coverage.
      const dir = project({});
      for (const command of [
        'bun test ~/x.test.ts',
        'npm test --prefix=~/other',
        'cat ~root/.ssh/id_rsa',
        'npx vitest --config=~/v.mjs',
        'cd ~ && npm test',
      ]) {
        expectDeny(command, { projectDir: dir });
      }
      for (const command of [
        'git log HEAD~3',
        'git diff HEAD~1',
        'git show HEAD~1:lib/runtime/hooks.js',
      ]) {
        expectAllow(command, { projectDir: dir });
      }
    });

    it('DENIES `=` and `^` in an EXPANSION position, and only there', () => {
      // ROADMAP ENTRY evidence-metachar-refusal-is-still-a-blocklist. `~` was
      // never a special case: it is one instance of the general shape of every
      // zsh word-level expansion, and treating it as a special case is why the
      // next two went unnoticed for six review rounds.
      //
      // `=` IS A LIVE BYPASS, AND THIS IS THE TIER WHERE IT BITES. Verified
      // live against the running gate, in this run and in the spike that
      // derived it (run-fixture-d578507b4795, receipt d121cd29):
      // `echo =ls` was ALLOWED and the shell printed `/bin/ls`; `ls -l =node`
      // was ALLOWED and the shell listed `/opt/homebrew/bin/node`. zsh replaces
      // a word BEGINNING with `=` by the full path of the command it names,
      // while `evidenceOperandNeedsRoot` reads `=node` as relative and
      // dotdot-free — so the synchronous containment check AND the async
      // realpath precompute both contain it LEXICALLY, and a READ-ONLY reviewer
      // reaches a path outside the governed tree through an operand the gate
      // believes it has proven. That is the exact sentence acme PR #368 publishes in
      // every issued ticket objective, falsified.
      //
      // `^` is the EXTENDED_GLOB exclusion operator. The option is unset in the
      // observed session but common in shipped profiles, and the host sources
      // the operator's profile, so refusing it at token start NARROWS the
      // exposure without closing it.
      //
      // THE ALLOW HALF IS NOT DECORATION. A wholesale `=` refusal deletes the
      // `=`-suffix operand form that the ENTIRE containment rule reads
      // (`--rootdir=tests`, `--workers=1`, `--pretty=format:%h`), and a
      // wholesale `^` refusal denies `git log HEAD^`. Positional or nothing.
      const dir = project({});
      for (const command of [
        'echo =ls',
        'ls -l =node',
        'cat =node',
        'npm test --prefix =node',
        'npx vitest run =node',
        'cd =x && npm test',
        'git log ^main master',
        'ls ^x',
        'cd ^x && npm test',
      ]) {
        expectDeny(command, { projectDir: dir });
      }
      for (const command of [
        'pytest --rootdir=tests',
        'npx playwright test --workers=1',
        'git log --pretty=format:%h',
        'npm test --prefix=sub',
        'git log HEAD^',
        'git show HEAD^:package.json',
        'git log main..HEAD',
      ]) {
        expectAllow(command, { projectDir: dir });
      }
    });

    it('ALLOWS in-tree operands and the read-only git forms this pipeline itself runs', () => {
      // The live Claude hook is the dist bundle THIS RUN regenerates, so the
      // run's own later stages depend on these surviving the new gate.
      const dir = project({});
      for (const command of [
        'npm test',
        'npm t',
        'npm test -- --silent',
        'bun test src/x.test.ts',
        'cd sub && npm test --silent',
        'pnpm vitest --dir tests',
        'npx vitest run __tests__/x.test.js',
        'node --test __tests__/x.test.mjs',
        'cat package.json',
        'ls -la',
        'git show 4f5e65d1 -- lib/runtime/hooks.js',
        'git show 4f5e65d1:lib/runtime/hooks.js',
        // The `...`-vs-`..` segment canary: the comparison must be segment-wise
        // (path.relative / normalizePath), never a `..` substring test, or Go's
        // own idiom breaks and the sloppy check becomes bypass #5.
        'go test ./...',
      ]) {
        expectAllow(command, { projectDir: dir });
      }
    });

    it('R1: containment proves WHERE a token points, never WHAT it contains', () => {
      // The published residual, pinned as behavior so nobody mistakes the gate
      // for a sandbox. An IN-TREE config an admitted runner loads — or one it
      // auto-discovers with no token at all (conftest.py, .npmrc, .yarnrc.yml,
      // bunfig.toml) — executes with the stage's privileges. These are ADMITTED
      // BY DESIGN. The tree is writable by a prior writer stage, so the trust
      // boundary is the WRITER-STAGE CLAIM SET, not the tree.
      const dir = project({});
      for (const command of [
        'npx vitest --config ./x.mjs',
        'npm test --userconfig ./x.npmrc',
        'pytest -c ./x.ini',
        'node --test --loader ./x.mjs',
      ]) {
        expectAllow(command, { projectDir: dir });
      }
    });
  });

  // =======================================================================
  // ROUND 5 — the comment character, pinned in the READ-ONLY tier because
  // that is where the consequence is an invariant-2 violation.
  //
  // `#` begins a comment in a non-interactive bash, so the shell drops the
  // word and everything after it. The refusal set omitted it, so the gate's
  // token vector was NOT the shell's — verified live on the inert case
  // `echo a #b`, which was ALLOWED and printed `a`.
  //
  // Truncation is harmless only where admission is MONOTONE in the tokens.
  // For a FORMATTER it is the opposite: lintCommandMutates clears black /
  // isort / prettier / `ruff format` on the PRESENCE of `--check` in the raw
  // string, so `black . # --check` was admitted while the shell ran
  // `black .` and rewrote every matching file IN PLACE. On a READ-ONLY
  // ticket that is an unproven production write (invariant 2) attributed to
  // nobody: it never touches the write gate, the drift guard's pattern
  // binding, or receipt-time diff attribution. That is why these arms live
  // in this suite, on the read-only fixtures, rather than only in the
  // permissive tier of the sibling shell-policy suite.
  //
  // The cd half is here for the mirror-image reason: `cd # && npm test` is
  // ALLOWED with `#` judged an in-tree relative operand while the shell runs
  // BARE `cd` -> $HOME. Under an explicit project_dir pin the cwd verdict
  // then denies every later bound Bash of the stage; with no pin the marker
  // walk from $HOME finds no `.ape` and the gate is off entirely (published
  // residual R7, reached with no `cd` the gate would refuse). Decisions only
  // — a bare `cd` relocates the session's persistent shell and is never run.
  //
  // THE REFUSAL SET IS STILL A BLOCKLIST. Adding `#`, `!` and U+0000 closes
  // the known instances, not the class; the positive per-token character
  // allowlist that would close it by construction is recorded as its own
  // roadmap entry rather than attempted inside one remediation cycle.
  // =======================================================================
  describe('round 5: a `#` truncates the command the shell actually runs', () => {
    it('DENIES a formatter whose `--check` the shell comments out, from a READ-ONLY ticket', () => {
      const dir = project({});
      for (const command of [
        'black . # --check',
        'isort . # --check',
        'ruff format . # --check',
        'prettier . # --check',
        'black . #x --check',
        'isort src/ # --check-only',
        'uv run black . # --check',
      ]) {
        expectDeny(command, { projectDir: dir });
      }
    });

    it('keeps DENYING the harmless direction, where the gate CAN see the mutating flag', () => {
      const dir = project({});
      for (const command of ['eslint . # --fix', 'ruff check . # --fix', 'prettier . # --write']) {
        expectDeny(command, { projectDir: dir });
      }
    });

    it('DENIES `cd # && <cmd>` — bare `cd` relocates the persistent shell to $HOME', () => {
      const dir = project({});
      for (const command of [
        'cd # && npm test',
        'cd # && npm run test',
        'cd # && pytest',
        'cd #sub && npm test',
      ]) {
        expectDeny(command, { projectDir: dir });
      }
    });

    it('DENIES the inert, live-verified instance and its siblings', () => {
      const dir = project({});
      for (const command of [
        'echo a #b',
        'cat package.json #note',
        'npm test #--silent',
        'git status # nothing to see here',
      ]) {
        expectDeny(command, { projectDir: dir });
      }
    });

    it('leaves the legitimate forms admitted on a read-only ticket (over-block guard)', () => {
      const dir = project({ test_commands: { full: 'npm run spec' } });
      for (const command of [
        'npm test',
        'npm run test',
        'npm run spec',
        'cd sub && npm test',
        'cd packages/api && npm run spec',
        'black --check .',
        'isort --check-only src/',
        'ruff format --check src/',
        'prettier --check src/',
        'echo a b',
        'cat package.json',
        'ls -la',
        'git status',
      ]) {
        expectAllow(command, { projectDir: dir });
      }
    });
  });

  describe('the session cwd is a PRECONDITION of containment, not defense in depth', () => {
    // WHY THIS ARM PASSES AN EXPLICIT project_dir. resolveGovernedRoot seeds
    // the `.ape` marker walk from explicitDir, then CLAUDE_PROJECT_DIR, then
    // CODEX_CWD, then input.cwd, and walks UP — so with no pin the resolved
    // root is an ancestor of cwd BY CONSTRUCTION and any "cwd is inside the
    // root" assertion is tautologically true; and with no `.ape` ancestor at
    // all the hook allows before any gate runs. Every fixture here is a real
    // tmpdir root, pinned explicitly.
    //
    // The verdict is a SEPARATE FIELD, `event.evidence.cwd_safe`, consulted for
    // EVERY bound-subagent evidence command — not folded into `safe`, and not
    // read only for path-bearing tokens. The policy denies iff it is exactly
    // `false` (the `event.path_safe === false` idiom, not
    // `deletion?.safe !== true`), so an ABSENT verdict degrades to the lexical
    // shortcut and the ~20 no-project_dir allow arms elsewhere stay green.
    it('DENIES every bound evidence command when the session cwd resolves outside the root', () => {
      const dir = project({});
      for (const command of ['npm test', 'pytest', 'git status', 'ls -la', 'cargo test', 'npm run test']) {
        const denied = decide(command, {
          projectDir: dir,
          evidence: {
            tokens: command.split(' '),
            safe: true,
            cwd_safe: false,
            reason: 'session cwd /other/repo resolves outside the governed project',
          },
        });
        expect(denied.decision, command).toBe('deny');
        expect(denied.reason, command).toMatch(/APE write denied/);
      }
    });

    it('ALLOWS the same commands when the cwd verdict is true', () => {
      const dir = project({});
      for (const command of ['npm test', 'pytest', 'git status', 'ls -la', 'cargo test', 'npm run test']) {
        expectAllow(command, {
          projectDir: dir,
          evidence: { tokens: command.split(' '), safe: true, cwd_safe: true, reason: null },
        });
      }
    });

    it('DENIES on the precompute\'s OWN failure verdict rather than swallowing it', () => {
      // POLARITY TRAP. pathResolvesOutsideProject returns FALSE for an
      // unresolvable path — "inside/safe" on the evidence polarity, the OPPOSITE
      // of its write-gate use — and it swallows only ENOENT, so an EACCES throw
      // would otherwise reach bin/ape-hook.mjs's top-level catch, which while a
      // run is live denies EVERY subsequent tool event. The mandated try/catch
      // must WRITE {tokens:null, safe:false, cwd_safe:false, reason} and the
      // policy must act on it.
      const dir = project({});
      const denied = decide('npm test', {
        projectDir: dir,
        evidence: {
          tokens: null,
          safe: false,
          cwd_safe: false,
          reason: 'evidence operand check failed: EACCES',
        },
      });
      expect(denied.decision).toBe('deny');
      expect(denied.reason).toContain('EACCES');
    });
  });

  describe('the published rule equals the enforced rule', () => {
    it('states the tiered run-script rule in EVIDENCE_COMMAND_FAMILIES', () => {
      // The published half of the defect. This constant is interpolated into
      // EVERY issued ticket objective (lib/runtime/service.js) and echoed in the
      // deny reason, so it must describe the rule that is actually enforced:
      // the run-script tier split and the operator lever that widens it. The
      // two pinned substrings are load-bearing elsewhere — 'read-only git' is
      // asserted against the issued objective by the UNCLAIMED
      // __tests__/runtime-v2-service.test.js, and 'cargo test' by the
      // deny-reason arm of the sibling shell-policy suite.
      expect(EVIDENCE_COMMAND_FAMILIES).toContain('read-only git');
      expect(EVIDENCE_COMMAND_FAMILIES).toContain('cargo test');
      expect(EVIDENCE_COMMAND_FAMILIES).toContain('sha256sum|shasum');
      expect(EVIDENCE_COMMAND_FAMILIES).toContain('policy.evidence_scripts');
      expect(EVIDENCE_COMMAND_FAMILIES).toMatch(/writable/i);
    });

    it('publishes the metacharacter refusal and the containment rule too', () => {
      // THIS STRING'S OWN RECORD, AND IT CARRIES NO FIGURE. Two DIFFERENT
      // sequences touch this surface: RESTATEMENTS of the published string, and
      // INSTANCES of published-vs-enforced drift (the metacharacter enumeration
      // that omitted `#` and `!`, then the `=` bypass the spike found by running
      // the enforced rule). THE TWO SEQUENCES ADVANCE SEPARATELY, and that
      // relationship is the whole of what this comment records: it does no
      // arithmetic over either one, and it copies no ordinal from anywhere.
      //
      // Deliberately, and not merely to avoid going stale. No ordinal for the
      // RESTATEMENT sequence is derivable from this history in the first place:
      // main is a pure squash chain, so restatements made inside one phase
      // collapse into the single landed commit that carried them, and unmerged
      // branch states hold restatements that a per-line census of main cannot
      // see. Any number written here would replace one unprovable figure with
      // another. The DRIFT-INSTANCE sequence is a different sequence with its
      // own narrative — beside the constant in lib/runtime/hooks.js, and in the
      // arm below — and this comment neither counts it nor mirrors it.
      //
      // Tokenize-then-allowlist adds two rules an agent cannot discover any
      // other way except by trial-and-error denial: a shell metacharacter
      // refuses the whole command, and no operand may name a path outside the
      // governed project.
      expect(EVIDENCE_COMMAND_FAMILIES).toMatch(/metacharacter/i);
      expect(EVIDENCE_COMMAND_FAMILIES).toMatch(/(?:outside|inside)[^;]{0,60}project/i);
    });

    it('publishes the ADMITTED character set, not an enumeration of refused ones', () => {
      // ROADMAP ENTRY evidence-metachar-refusal-is-still-a-blocklist, PUBLISHED
      // HALF. This arm used to assert that the string NAMED EVERY REFUSED
      // METACHARACTER it enumerates — an assertion ABOUT A BLOCKLIST, and it
      // could only ever be as complete as the blocklist was. It was green
      // through round 5's `#`/`!` gap for exactly one round, and green through
      // the `=` bypass the spike found by RUNNING the enforced rule
      // (run-fixture-d578507b4795, receipt d121cd29): `echo =ls` was
      // ALLOWED and the shell printed `/bin/ls`, so the published sentence "no
      // operand may name a path outside the governed project" was FALSE of the
      // tree that publishes it, in every issued ticket objective and every deny
      // reason. THAT IS THE SIXTH TIME this surface has published something
      // stronger than it enforces.
      //
      // An enumeration of refusals cannot be made complete by adding to it — it
      // has to be REPLACED by the positive statement, which is finite and can
      // be checked for completeness: an agent given the ADMITTED alphabet knows
      // what is refused without the string having to list it.

      // (1) THE FALSE SENTENCE IS GONE. "One shell metacharacter anywhere ...
      // refuses the WHOLE command" describes a rule whose completeness the tree
      // has now failed to hold six times, and the parenthesised enumeration
      // after it is what kept going short.
      expect(EVIDENCE_COMMAND_FAMILIES).not.toContain('one shell metacharacter anywhere');
      expect(EVIDENCE_COMMAND_FAMILIES).not.toContain('; | & < >');

      // (2) THE ADMITTED ALPHABET IS NAMED, character by character. This is the
      // half an agent cannot discover by trial and error, and the half that
      // makes the rule checkable rather than merely stronger-sounding: the
      // punctuation the gate admits is exactly this set, and `@`, `%`, `^` and
      // `+` are in it — three of which the roadmap entry's own proposed floor
      // omitted, which is why the floor could not be adopted on trust.
      for (const character of ['-', '_', '.', '/', ':', '=', '@', '~', ',', '%', '^', '+']) {
        expect(EVIDENCE_COMMAND_FAMILIES, `names ${character}`).toContain(character);
      }

      // (3) IT SAYS WHAT KIND OF RULE IT IS, and that non-ASCII is ADMITTED —
      // the single most consequential thing for a foreign project, since an
      // ASCII-only allowlist is a total lockout under an accented or non-Latin
      // path (invariant 6) and a regression against behavior verified live.
      expect(EVIDENCE_COMMAND_FAMILIES).toMatch(/allowlist/i);
      expect(EVIDENCE_COMMAND_FAMILIES).toMatch(/non-ASCII/i);

      // (4) THE POSITIONAL REFUSALS, which are the whole security content: the
      // alphabet says which characters may appear, and the positions say where
      // the three EXPANDING ones may not. `~` was already positional; `=` (zsh
      // EQUALS expansion — the live bypass) and `^` (EXTENDED_GLOB exclusion)
      // join it, and no agent can discover a positional rule by trial and error
      // on one command.
      expect(EVIDENCE_COMMAND_FAMILIES).toMatch(/token start|start of a token/i);
      // Named as a refusal, not incidentally — the constraint the ticket keeps.
      expect(EVIDENCE_COMMAND_FAMILIES).toMatch(/metacharacter/i);
    });

    it('keeps every load-bearing substring the rest of the tree reads out of it', () => {
      // The rewrite above may not break the four consumers that read this
      // string, all of which are asserted elsewhere and would otherwise fail
      // far from their cause: the UNCLAIMED __tests__/runtime-v2-service.test.js
      // anchors 'read-only git' plus a trailing `Run objective:` suffix with
      // `$` (so newline-freeness and position are load-bearing),
      // lib/runtime/projection.js's compactPendingTicket dedupes the objective
      // by EXACT SUFFIX MATCH and fails open on drift, and the deny-reason arms
      // in both evidence suites pin 'cargo test' and 'policy.evidence_scripts'.
      expect(typeof EVIDENCE_COMMAND_FAMILIES).toBe('string');
      expect(EVIDENCE_COMMAND_FAMILIES).not.toMatch(/[\r\n]/);
      expect(EVIDENCE_COMMAND_FAMILIES).toContain('read-only git');
      expect(EVIDENCE_COMMAND_FAMILIES).toContain('cargo test');
      expect(EVIDENCE_COMMAND_FAMILIES).toContain('policy.evidence_scripts');
      expect(EVIDENCE_COMMAND_FAMILIES).toContain('~');
      expect(EVIDENCE_COMMAND_FAMILIES).toMatch(/writable/i);
      expect(EVIDENCE_COMMAND_FAMILIES).toMatch(/(?:outside|inside)[^;]{0,60}project/i);
    });

    it('stays ONE flat newline-free string', () => {
      // lib/runtime/service.js interpolates it verbatim into every issued
      // ticket objective, ahead of a trailing `Run objective:` suffix that
      // __tests__/runtime-v2-service.test.js anchors with `$`. A newline breaks
      // that anchor AND lib/runtime/projection.js's compactPendingTicket, which
      // dedupes the objective by exact-suffix match and fails open on drift.
      expect(EVIDENCE_COMMAND_FAMILIES).not.toMatch(/[\r\n]/);
      expect(typeof EVIDENCE_COMMAND_FAMILIES).toBe('string');
    });

    it('names the refused script, the admitted names, and the lever in the deny reason', () => {
      // Friction #8: an agent must be able to read the rule out of the denial
      // instead of rediscovering it by trial and error — and, because the
      // admitted set is now per-project, the denial has to say what THIS ticket
      // may actually run and how the operator widens it.
      const dir = project({});
      const denied = decide('npm run validate', { projectDir: dir });
      expect(denied.decision).toBe('deny');
      expect(denied.reason).toContain('validate');
      expect(denied.reason).toContain('ape_config set policy.evidence_scripts');
      expect(denied.reason).toContain('read-only git');
      expect(denied.reason).toContain('cargo test');
    });

    it('enumerates the project\'s own derived names in the deny reason', () => {
      // The enumeration is the per-ticket admitted set, not a fixed sentence: a
      // project whose suite is `npm run spec` must see `spec` in the refusal.
      const dir = project({
        test_commands: { full: 'npm run spec' },
        policy: { evidence_scripts: ['typecheck'] },
      });
      const denied = decide('npm run validate', { projectDir: dir });
      expect(denied.decision).toBe('deny');
      expect(denied.reason).toContain('validate');
      expect(denied.reason).toContain('spec');
      expect(denied.reason).toContain('typecheck');
    });

    it('leaves the deny reason for an unrecognized non-run-script command unchanged', () => {
      // No collateral: a command that never reached the run-script arm keeps
      // the standard recognized-evidence deny reason.
      const dir = project({});
      const denied = decide('make bespoke-target', { projectDir: dir });
      expect(denied.decision).toBe('deny');
      expect(denied.reason).toContain('read-only git');
      expect(denied.reason).toContain('cargo test');
    });
  });

  describe('policy.evidence_scripts is a validated, documented config key', () => {
    it('ships as an empty array so an unconfigured install is the floor set', () => {
      expect(DEFAULT_CONFIG.policy.evidence_scripts).toEqual([]);
      expect(Array.isArray(DEFAULT_CONFIG.policy.evidence_scripts)).toBe(true);
    });

    it('rejects a non-string element at SET time through all three set routes', async () => {
      // (l) A type-invalid value stored here detonates far from the set — the
      // hook would read it on every Bash event of every later run — so
      // `ape_config set` must fail LOUDLY and persist nothing, through each
      // route that can reach the slot: the exact key, an ancestor object set,
      // and a numeric-index set beneath the array.
      const exact = project();
      await expect(
        configAction(exact, 'set', { key: 'policy.evidence_scripts', value: ['typecheck', 42] }),
      ).rejects.toThrow(/evidence_scripts/);
      expect((await configAction(exact, 'get', {})).config.policy.evidence_scripts).toEqual([]);

      const ancestor = project();
      await expect(
        configAction(ancestor, 'set', {
          key: 'policy',
          value: { evidence_scripts: ['typecheck', 42] },
        }),
      ).rejects.toThrow(/evidence_scripts/);
      expect((await configAction(ancestor, 'get', {})).config.policy.evidence_scripts).toEqual([]);

      const indexed = project();
      await expect(
        configAction(indexed, 'set', { key: 'policy.evidence_scripts.0', value: 42 }),
      ).rejects.toThrow(/evidence_scripts/);
      expect((await configAction(indexed, 'get', {})).config.policy.evidence_scripts).toEqual([]);
    });

    it('accepts a string list and the hook reads back exactly what the lever wrote', async () => {
      // End to end: the lever named in the deny reason is the lever that
      // actually widens the gate, through the real config store (locking,
      // sparse-overlay pruning and explicit-key provenance included).
      const dir = project();
      const { config } = await configAction(dir, 'set', {
        key: 'policy.evidence_scripts',
        value: ['typecheck'],
      });
      expect(config.policy.evidence_scripts).toEqual(['typecheck']);
      expectAllow('npm run typecheck', { projectDir: dir });
      expectDeny('npm run validate', { projectDir: dir });
    });
  });
});

// ===========================================================================
// END-TO-END through the real hook binary. The synchronous policy above can
// only READ a precomputed verdict; these arms prove bin/ape-hook.mjs actually
// COMPUTES one — with realpath semantics, from the event's own project_dir and
// the session's reported cwd — and that the async precompute's own failure can
// never brick the session.
// ===========================================================================
const repoRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const hookBinary = path.join(repoRoot, 'bin', 'ape-hook.mjs');

// realpathSync so the fixture root is already canonical: on macOS os.tmpdir()
// is a symlink (/var -> /private/var), and this arm is about the cwd verdict,
// not about which side of the containment check calls realpath first.
function hookProject() {
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), 'ape-evidence-hook-')));
  dirs.push(dir);
  mkdirSync(path.join(dir, '.ape', 'runtime'), { recursive: true });
  mkdirSync(path.join(dir, '__tests__'), { recursive: true });
  mkdirSync(path.join(dir, 'sub'), { recursive: true });
  writeFileSync(path.join(dir, '__tests__', 'x.test.mjs'), '// fixture\n', 'utf8');
  writeFileSync(path.join(dir, 'package.json'), '{"name":"fixture"}\n', 'utf8');
  writeFileSync(
    path.join(dir, '.ape', 'runtime', 'active.json'),
    JSON.stringify(
      {
        run_id: 'run-evidence',
        status: 'running',
        tickets: [
          {
            ticket_id: 'run-evidence:review:r',
            role: 'reviewer',
            writable: false,
            claimed_paths: [],
            test_paths: ['__tests__'],
          },
        ],
        receipts: [],
      },
      null,
      2,
    ),
    'utf8',
  );
  return dir;
}

// Force the Claude host and strip every host-provided project hint so only the
// payload under test decides.
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

function boundBashCall(dir, command, cwd) {
  return {
    hook_event_name: 'PreToolUse',
    project_dir: dir,
    session_id: 's1',
    is_subagent: true,
    ticket_id: 'run-evidence:review:r',
    tool_name: 'Bash',
    tool_input: { command },
    ...(cwd === undefined ? {} : { cwd }),
  };
}

describe('APE v2 hook binary evidence containment (cwd + operand precompute)', () => {
  it('allows an in-tree evidence command when the session cwd is inside the governed root', async () => {
    const dir = hookProject();
    for (const command of ['npm test', 'node --test __tests__/x.test.mjs']) {
      const response = await invokeHook(boundBashCall(dir, command, dir), dir);
      expect(response.hookSpecificOutput.permissionDecision, command).toBe('allow');
    }
  });

  it('ALLOWS the exact live reviewer `/dev/null` comparison through the async hook precompute', async () => {
    // 2.23.19 certification exposed this exact denial on the first fast-lane
    // review. This end-to-end arm is the discriminator: a synchronous-only
    // exception still fails because bin/ape-hook.mjs precomputes the external
    // `/dev/null` operand before evaluateLifecyclePolicy reads the event.
    const dir = hookProject();
    mkdirSync(path.join(dir, 'src'), { recursive: true });
    writeFileSync(path.join(dir, 'src', 'is-even-2319-1.js'), 'export const isEven = (n) => n % 2 === 0;\n', 'utf8');
    for (const command of [
      'git diff --no-index /dev/null src/is-even-2319-1.js',
      'git diff --no-index src/is-even-2319-1.js /dev/null',
      'git diff --no-index -- /dev/null src/is-even-2319-1.js',
      'git diff --no-index -- src/is-even-2319-1.js /dev/null',
    ]) {
      const response = await invokeHook(boundBashCall(dir, command, dir), dir);
      expect(response.hookSpecificOutput.permissionDecision, command).toBe('allow');
    }
  });

  it('DENIES near-miss sentinels, extra-tail shapes, and an external companion end to end', async () => {
    const dir = hookProject();
    for (const command of [
      'git diff --no-index /dev/nullish src/is-even-2319-1.js',
      'git diff --no-index /dev/null/../tmp/x src/is-even-2319-1.js',
      'git diff --no-index --stat /dev/null src/is-even-2319-1.js',
      'git diff --no-index -- -- /dev/null src/is-even-2319-1.js',
      'git diff --no-index -- /dev/null /tmp/outside.js',
      'git diff --no-index -- /dev/null /dev/null',
      'git diff --no-index /dev/null /tmp/outside.js',
      'git diff --no-index /dev/null /dev/null',
    ]) {
      const response = await invokeHook(boundBashCall(dir, command, dir), dir);
      expect(response.hookSpecificOutput.permissionDecision, command).toBe('deny');
    }
  });

  it('DENIES when the session cwd has drifted outside the governed root', async () => {
    // Claude's Bash tool keeps a persistent shell whose cwd drifts on `cd`, and
    // every relative operand resolves against THAT — with no token left for the
    // gate to inspect. A single earlier `cd` would otherwise relocate
    // everything. The deletion channel already learned this
    // (bin/ape-hook.mjs resolves relative rm targets against input.cwd).
    const dir = hookProject();
    const elsewhere = realpathSync(mkdtempSync(path.join(tmpdir(), 'ape-evidence-outside-')));
    dirs.push(elsewhere);
    const response = await invokeHook(boundBashCall(dir, 'npm test', elsewhere), dir);
    expect(response.hookSpecificOutput.permissionDecision).toBe('deny');
  });

  it('DENIES an out-of-tree operand end to end', async () => {
    // The realpath-grade half: the operand names a path that does not exist, and
    // pathResolvesOutsideProject reports FALSE ("inside") for anything it cannot
    // resolve — the OPPOSITE polarity from its write-gate use. The precompute
    // must therefore write an explicit verdict, not lean on that return value.
    const dir = hookProject();
    const response = await invokeHook(
      boundBashCall(dir, 'node --test /outside-ape-probe/x.test.mjs', dir),
      dir,
    );
    expect(response.hookSpecificOutput.permissionDecision).toBe('deny');
  });

  // =======================================================================
  // ROUND 5, FINDING 4 — THE CD TARGET IS THE SHARPEST INSTANCE OF R3, and
  // the residual as published understates it.
  //
  // R3 says "a relative, dotdot-free TOKEN traversing an in-tree symlink to
  // outside the root is admitted with no realpath check". That wording
  // technically covers the cd target and never names it, and no arm probed
  // it — yet the cd target is the one operand whose escape needs NO second
  // step. `cd <in-tree symlink to outside> && npm test` relocates the ENTIRE
  // execution in ONE admitted command: a foreign package.json's `test`
  // script runs, out of tree, where the drift guard and receipt-time diff
  // recomputation have no reach. evidenceOperandNeedsRoot returns false for
  // it on BOTH sides — the precompute skips it and the synchronous
  // containment check skips it — while the doc's own "Operand containment"
  // section says the cd target is UNCONDITIONALLY a path operand, which
  // reads stronger than the behavior.
  //
  // The correction is bounded and lives here, in the async precompute:
  // resolve the cd target with realpath UNCONDITIONALLY (one extra
  // pathResolvesOutsideProject call inside the existing try/catch), so the
  // target no longer depends on the two-trigger shortcut at all. The TOKEN
  // half of R3 is deliberately NOT closed by that change and stays a
  // published residual — these arms therefore assert nothing about tokens
  // traversing an in-tree symlink, in either direction.
  //
  // A read-only stage cannot create such a symlink itself (no `ln` head, and
  // in-tree writes are denied), so reaching this needs a prior writer stage
  // or R2 — which is exactly the trust boundary R1 already publishes: the
  // WRITER-STAGE CLAIM SET, not the tree.
  // =======================================================================
  function foreignProject(label) {
    const outside = realpathSync(mkdtempSync(path.join(tmpdir(), `ape-evidence-${label}-`)));
    dirs.push(outside);
    mkdirSync(path.join(outside, '__tests__'), { recursive: true });
    writeFileSync(path.join(outside, 'package.json'), '{"name":"foreign"}\n', 'utf8');
    return outside;
  }

  it('DENIES a cd target that is an IN-TREE symlink resolving outside the tree', async () => {
    const dir = hookProject();
    // Lexically `escape` is a relative, dotdot-free operand — indistinguishable
    // from `sub` — so only a realpath resolution can tell them apart.
    symlinkSync(foreignProject('foreign'), path.join(dir, 'escape'), 'dir');
    for (const command of ['cd escape && npm test', 'cd ./escape && pytest']) {
      const response = await invokeHook(boundBashCall(dir, command, dir), dir);
      expect(response.hookSpecificOutput.permissionDecision, command).toBe('deny');
    }
  });

  it('still ALLOWS a cd target that resolves INSIDE the tree, symlink or not', async () => {
    // The over-block guard, and the non-vacuity proof for the arm above: the
    // new resolution must separate the two symlinks, not refuse symlinks. A cd
    // prefix whose target is an ordinary in-tree directory, an in-tree symlink
    // to another in-tree directory, or a not-yet-created in-tree directory all
    // stay admitted — the last one because nearestExistingPath walks up to the
    // root, which is what keeps a monorepo's about-to-be-generated package dir
    // from failing closed.
    const dir = hookProject();
    symlinkSync(path.join(dir, 'sub'), path.join(dir, 'inside'), 'dir');
    for (const command of [
      'cd sub && npm test',
      'cd ./sub && npm test',
      'cd inside && npm test',
      'cd not-yet-created && npm test',
    ]) {
      const response = await invokeHook(boundBashCall(dir, command, dir), dir);
      expect(response.hookSpecificOutput.permissionDecision, command).toBe('allow');
    }
  });
});
