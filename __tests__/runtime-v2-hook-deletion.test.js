import { execFileSync, spawn } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { evaluateLifecyclePolicy, parseDeletionCommand } from '../lib/runtime/hooks.js';
import { runtimePaths } from '../lib/runtime/paths.js';
import { currentTreeSha } from '../lib/runtime/git.js';
import { atomicWriteJson } from '../lib/runtime/storage.js';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const hookBinary = path.join(root, 'bin', 'ape-hook.mjs');
const cleanups = [];

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

// File deletion is the one write the sanctioned edit tools cannot express —
// Edit/Write replace content but never remove a file — so a whole-file-deletion
// ticket was structurally unsatisfiable. The deletion channel admits exactly
// `rm` / `git rm` in an aggressively fail-closed grammar, path-checked against
// the ticket claims like every host edit.
describe('APE v2 parseDeletionCommand grammar', () => {
  it('parses plain rm and git rm forms with whitelisted flags', () => {
    expect(parseDeletionCommand('rm src/value.js')).toEqual({ targets: ['src/value.js'] });
    expect(parseDeletionCommand('rm -f src/a.js src/b.js')).toEqual({ targets: ['src/a.js', 'src/b.js'] });
    expect(parseDeletionCommand('rm -rf src/dir')).toEqual({ targets: ['src/dir'] });
    expect(parseDeletionCommand('rm -- src/value.js')).toEqual({ targets: ['src/value.js'] });
    expect(parseDeletionCommand('git rm --cached src/value.js')).toEqual({ targets: ['src/value.js'] });
    expect(parseDeletionCommand('git rm -q --force -r -- src/dir')).toEqual({ targets: ['src/dir'] });
  });

  it('fails closed on chaining, globs, quoting, substitution, and expansion', () => {
    for (const command of [
      'rm src/a.js; rm src/b.js',
      'rm src/a.js && rm src/b.js',
      'rm src/a.js | tee out',
      'rm src/*.js',
      'rm src/value.?s',
      'rm src/[ab].js',
      "rm 'src/value.js'",
      'rm "src/value.js"',
      'rm `which node`',
      'rm $(pwd)/src/value.js',
      'rm $HOME/x',
      'rm ~/x',
      'rm {src,lib}/a.js',
      'rm src/a.js > out.txt',
      'rm src/a.js\nrm src/b.js',
      // Backslash-escaped traversal: the shell de-escapes `\.\.` back to `..`
      // and deletes outside the claims, so a backslash fails closed at parse.
      'rm src/\\.\\./package.json',
      'rm -rf src/\\.\\./.git',
      'rm src/a\\ b.js',
    ]) {
      expect(parseDeletionCommand(command), command).toBe(null);
    }
  });

  it('fails closed on unrecognized leading tokens, flags, and empty target lists', () => {
    for (const command of [
      'rm',
      'rm -rf',
      'rm -v src/a.js',
      'rm --recursive src/a.js',
      'rm -- -f',
      'git rm -n src/a.js',
      'git rm',
      'git mv src/a.js src/b.js',
      'mv src/a.js src/b.js',
      'rmdir src/dir',
      'echo rm src/a.js',
      'sudo rm src/a.js',
      '',
    ]) {
      expect(parseDeletionCommand(command), command).toBe(null);
    }
  });
});

// ===========================================================================
// ROADMAP ENTRY evidence-metachar-refusal-is-still-a-blocklist, FINDING 3 —
// DELETION_UNSAFE_CHARS CARRIES THE SAME `=` GAP, AND IT IS NOT SAFE HERE.
//
// `DELETION_UNSAFE_CHARS` and the evidence gate's character refusal are
// described in lib/runtime/hooks.js as SHARING A SHAPE, and the evidence half
// was authored by REUSING this constant. That reuse transplanted a gap: this
// set carries no `=`, so `parseDeletionCommand('rm =node')` returns
// `{targets: ['=node']}`; bin/ape-hook.mjs resolves `<sessionCwd>/=node`, which
// is LEXICALLY INSIDE the project, so admission turns ONLY on
// `pathResolvesWithinClaims` — and with the session cwd inside a CLAIMED
// subdirectory that check PASSES, while zsh replaces the word `=node` with the
// absolute path of whatever `node` names on PATH and deletes THAT.
//
// CONFIRMED AGAINST THE DECISION FUNCTION, NEVER THE SHELL. Every arm here is a
// PARSE or a hook DECISION; no `rm` is executed, and no `rm =<anything>` was run
// at any point — an out-of-project delete is unrecoverable, so this finding was
// derived from `parseDeletionCommand` plus the claim check in bin/ape-hook.mjs
// and verified as a decision, exactly as the ticket requires.
//
// WHY THE ROUND-5 ARGUMENT DOES NOT COVER IT. lib/runtime/hooks.js records that
// this constant's shared `#` omission is SAFE here "because admission is
// MONOTONE under truncation" — dropping a trailing word only deletes LESS. That
// argument is sound for a COMMENT and unsound for `=`: EQUALS is a
// SUBSTITUTION, not a truncation. It does not drop a target, it REPLACES a
// contained relative target with an absolute out-of-project one, which is the
// opposite direction. The two constants share a SHAPE, not a threat model.
//
// SCOPE OF THESE ARMS. The derivation this run inherited was INTERNALLY
// INCONSISTENT about one point — its design answer said the deletion set
// refuses `=` WHOLESALE while its guard-arm list said `rm src/a=b.js` must
// still parse, which requires the refusal to be POSITIONAL — so the first cut
// of this suite deliberately abstained and pinned only the `=`-INITIAL target,
// on which both readings agree.
//
// THE CONTESTED CASE IS NOW SETTLED, AND IT IS SETTLED WHOLESALE. The shipped
// deletion alphabet refuses `~`, `=` and `^` in EVERY position of a target;
// docs/hooks.md and docs/research/2026-07-28-evidence-metachar-character-
// allowlist.md both resolve it that way, and the arms below pin it so the
// resolution stops being a sentence nothing executes. The reasons are
// per-character and do not generalize:
//
//   `=`  EQUALS expansion SUBSTITUTES rather than truncates, so the round-5
//        monotonicity argument that made the shared `#` omission harmless here
//        does not reach it — and unlike the evidence gate, this channel has no
//        `--rootdir=tests` form to protect, so there is nothing a positional
//        rule would buy.
//   `~`  a `rm ~/x` target is the operator's home directory, and `rm a~b` buys
//        the positional exception nothing: no deletion arm needs `~`, whereas
//        the EVIDENCE gate must keep `git log HEAD~3` alive and therefore
//        cannot refuse the character wholesale.
//   `^`  under `setopt extended_glob`, `rm ^a.js` expands to every file in the
//        directory EXCEPT `a.js` — an unrecoverable MULTI-FILE delete from a
//        token vector the gate read as ONE target.
//
// SO THE TWO ALPHABETS MUST NOT BE RE-SYNCED. The evidence alphabet keeps all
// three characters and refuses them BY POSITION; this one drops them outright.
// They share a SHAPE, not a threat model, and the paired over-block guard below
// (`%`, `,`, `+`, `:`, `@`, non-ASCII) is what proves this is not a blanket
// refusal of punctuation.
// ===========================================================================
describe('APE v2 parseDeletionCommand: the positive character allowlist', () => {
  // Exotic characters are built NUMERICALLY, never written as literals: a
  // literal U+00A0 or U+200B in a source file is one normalizing editor away
  // from a plain space or from nothing at all.
  const codepoint = (value) => String.fromCharCode(value);
  const NUL = codepoint(0x0000);
  const NBSP = codepoint(0x00a0);
  const ZERO_WIDTH_SPACE = codepoint(0x200b);
  const SOFT_HYPHEN = codepoint(0x00ad);
  const LONE_SURROGATE = codepoint(0xd800);

  it('REFUSES a `=`-initial target — zsh replaces the word with an out-of-tree path', () => {
    // FINDING 3, the security half. `=node` is a relative, dotdot-free token to
    // every check the deletion channel runs, and an absolute path to the shell.
    for (const command of [
      'rm =node',
      'rm =ls',
      'rm -f =node',
      'rm -rf =node',
      'rm -- =node',
      'rm src/value.js =node',
      'git rm =node',
      'git rm --cached =node',
    ]) {
      expect(parseDeletionCommand(command), command).toBe(null);
    }
  });

  it('REFUSES `=` in EVERY position of a target, not only at its start', () => {
    // The settled half of the contested question. A DECISION, never an `rm`:
    // an out-of-project or multi-file delete is unrecoverable, so every arm in
    // this describe is a parse and nothing here is ever executed.
    //
    // NON-VACUITY. The `=`-INITIAL arm above is satisfied by a POSITIONAL rule
    // (`^[~=^]`, the evidence gate's shape); only a WHOLESALE refusal satisfies
    // this one, so the pair separates the two candidate implementations that
    // the inherited derivation could not choose between.
    for (const command of [
      'rm src/a=b.js',
      'rm a=b',
      'rm -f src/a=b.js',
      'rm -rf src/dir=x',
      'rm -- src/a=b.js',
      'rm src/value.js src/a=b.js',
      'git rm src/a=b.js',
      'git rm --cached src/a=b.js',
    ]) {
      expect(parseDeletionCommand(command), command).toBe(null);
    }
  });

  it('REFUSES `~` anywhere in a target — the evidence gate\'s exception buys nothing here', () => {
    // `~` at token start is TILDE expansion (the operator's home directory, a
    // target outside the governed project by construction); mid-token it is a
    // glob operator under `setopt extended_glob`. The EVIDENCE alphabet keeps
    // the character because `git log HEAD~3` needs it; NO deletion form does,
    // so the refusal is wholesale and costs nothing. Decision only.
    for (const command of [
      'rm a~b',
      'rm src/a~b.js',
      'rm -rf src/dir~1',
      'rm -- src/a~b.js',
      'rm src/value.js src/a~b.js',
      'git rm src/a~b.js',
    ]) {
      expect(parseDeletionCommand(command), command).toBe(null);
    }
  });

  it('REFUSES `^` anywhere in a target — an EXTENDED_GLOB exclusion is a MULTI-file delete', () => {
    // The sharpest of the three: under `setopt extended_glob` a leading `^`
    // makes the pattern match every name in the directory EXCEPT the one
    // spelled — so the gate reads ONE target, checks ONE target against the
    // claims, and the shell removes everything else. The option is unset in the
    // observed session but common in shipped profiles, and the host sources the
    // operator's profile. NEVER EXECUTED, for exactly that reason.
    for (const command of [
      'rm ^a.js',
      'rm src/^a.js',
      'rm a^b',
      'rm -rf ^build',
      'rm -- ^a.js',
      'git rm ^a.js',
    ]) {
      expect(parseDeletionCommand(command), command).toBe(null);
    }
  });

  it('REFUSES the characters that make the shell or the kernel read a different command', () => {
    // The same three characters round 5 added to the EVIDENCE half, which this
    // constant never received: `#` (a comment drops that word and everything
    // after it), `!` (history expansion), U+0000 (execve truncates argv there).
    // Plus the whitespace narrowing: JS `/\s+/` splits on U+00A0 and the shell's
    // default IFS does not, so the gate counts TWO targets where the shell
    // deletes ONE file whose name carries the character — the gate and the
    // shell disagreeing about the token vector, which is the whole defect class.
    const cases = [
      ['rm src/a#b.js', 'rm src/a#b.js'],
      ['rm src/value.js #note', 'rm src/value.js #note'],
      ['rm src/a!b.js', 'rm src/a!b.js'],
      [`rm src/a${NUL}b.js`, 'rm src/a<U+0000>b.js'],
      [`rm src/a${NBSP}b.js`, 'rm src/a<U+00A0>b.js'],
      ['rm src/a\tb.js', 'rm src/a<TAB>b.js'],
    ];
    for (const [command, label] of cases) {
      expect(parseDeletionCommand(command), label).toBe(null);
    }
  });

  it('REFUSES an invisible format character or a lone surrogate in a target', () => {
    // \p{Cf} makes the target unauditable — the operator reading the deny reason
    // cannot see what would have been deleted — and \p{Cs} has no UTF-8
    // encoding, so the BYTES the shell receives are not the code points the gate
    // inspected. Both are admitted today.
    const cases = [
      [`rm src/a${ZERO_WIDTH_SPACE}b.js`, 'rm src/a<U+200B>b.js'],
      [`rm src/a${SOFT_HYPHEN}b.js`, 'rm src/a<U+00AD>b.js'],
      [`rm src/a${LONE_SURROGATE}b.js`, 'rm src/a<U+D800>b.js'],
    ];
    for (const [command, label] of cases) {
      expect(parseDeletionCommand(command), label).toBe(null);
    }
  });

  it('still PARSES the ordinary target alphabet (over-block guard)', () => {
    // The half that makes the conversion safe, and the half that keeps the
    // three wholesale refusals above from being read as "punctuation is
    // dangerous". `%`, `,` and `+` carry no meaning in either shell, sit in
    // BOTH alphabets, and REMAIN deletable; `:` and `@` likewise. A rule that
    // refused them would fail this arm, so the refusals above are pinned as
    // exactly three characters and not as a mood.
    expect(parseDeletionCommand('rm src/value.js')).toEqual({ targets: ['src/value.js'] });
    expect(parseDeletionCommand('rm src/a%b,c+d.js')).toEqual({ targets: ['src/a%b,c+d.js'] });
    expect(parseDeletionCommand('rm docs/notes/a:developer+23c2fecbe978@example.test')).toEqual({
      targets: ['docs/notes/a:developer+23c2fecbe978@example.test'],
    });
    expect(parseDeletionCommand('rm -rf src/dir')).toEqual({ targets: ['src/dir'] });
    expect(parseDeletionCommand('rm src/a-b_c.test.js')).toEqual({
      targets: ['src/a-b_c.test.js'],
    });
    expect(parseDeletionCommand('rm __tests__/runtime-v2-x.test.js')).toEqual({
      targets: ['__tests__/runtime-v2-x.test.js'],
    });
    expect(parseDeletionCommand('rm -f src/a.js src/b.js')).toEqual({
      targets: ['src/a.js', 'src/b.js'],
    });
    expect(parseDeletionCommand('git rm -q --force -r -- src/dir')).toEqual({
      targets: ['src/dir'],
    });
  });

  it('still PARSES a non-ASCII target — invariant 6, not a hypothetical', () => {
    // A positive character rule authored as ASCII-only is a total lockout for
    // any project under an accented or non-Latin path: that project could then
    // never satisfy a whole-file-deletion ticket at all, since the sanctioned
    // edit tools cannot remove a file. Admitted today, and it must stay so.
    expect(parseDeletionCommand('rm docs/日本語.md')).toEqual({ targets: ['docs/日本語.md'] });
    expect(parseDeletionCommand('rm src/café.js')).toEqual({ targets: ['src/café.js'] });
    expect(parseDeletionCommand('rm -rf tests/ünïcode')).toEqual({ targets: ['tests/ünïcode'] });
  });

  it('is TOTAL for every input shape, exactly as the evidence tokenizer is', () => {
    // A throw inside the synchronous policy reaches bin/ape-hook.mjs's
    // top-level catch, which while a run is live denies EVERY subsequent tool
    // event and bricks the session until dist/ is reverted by hand.
    for (const input of [null, undefined, 42, {}, [], true, '', '   ', `rm ${LONE_SURROGATE}`]) {
      const label = typeof input === 'string' ? JSON.stringify(input.length) : String(input);
      let parsed;
      expect(() => {
        parsed = parseDeletionCommand(input);
      }, label).not.toThrow();
      expect(parsed === null || Array.isArray(parsed?.targets), label).toBe(true);
    }
  });
});

describe('APE v2 lifecycle deletion channel (policy)', () => {
  const state = { status: 'running' };
  const buildTicket = {
    ticket_id: 'run-1:build:b',
    role: 'implementer',
    writable: true,
    test_paths: ['__tests__'],
    claimed_paths: ['src'],
  };
  const reviewTicket = {
    ticket_id: 'run-1:review:r',
    role: 'reviewer',
    writable: false,
    test_paths: ['__tests__'],
    claimed_paths: [],
  };
  const boundBash = (command, deletion) => ({
    host: 'claude',
    is_subagent: true,
    ape_managed: true,
    tool_name: 'Bash',
    command,
    ...(deletion ? { deletion } : {}),
  });

  it('allows a verified-safe deletion and names the authorizing ticket', () => {
    const result = evaluateLifecyclePolicy(
      boundBash('rm src/value.js', { targets: ['src/value.js'], safe: true }),
      { state, ticket: buildTicket },
    );
    expect(result.decision).toBe('allow');
    expect(result.reason).toBe('deletion authorized by run-1:build:b');
  });

  it('fails closed when the per-target verdict is missing or unsafe', () => {
    const unverified = evaluateLifecyclePolicy(
      boundBash('rm src/value.js'),
      { state, ticket: buildTicket },
    );
    expect(unverified.decision).toBe('deny');
    expect(unverified.reason).toMatch(/deletion denied/);

    const unsafe = evaluateLifecyclePolicy(
      boundBash('rm docs/readme.md', {
        targets: ['docs/readme.md'],
        safe: false,
        reason: 'deletion target docs/readme.md resolves outside the ticket claims',
      }),
      { state, ticket: buildTicket },
    );
    expect(unsafe.decision).toBe('deny');
    expect(unsafe.reason).toMatch(/outside the ticket claims/);
  });

  it('denies a read-only role even a verified-safe deletion', () => {
    const result = evaluateLifecyclePolicy(
      boundBash('rm src/value.js', { targets: ['src/value.js'], safe: true }),
      { state, ticket: reviewTicket },
    );
    expect(result.decision).toBe('deny');
    expect(result.reason).toMatch(/reviewer is read-only/);
  });

  it('denies a deletion while the run is not writing (blocked) or sealed', () => {
    const blocked = evaluateLifecyclePolicy(
      boundBash('rm src/value.js', { targets: ['src/value.js'], safe: true }),
      { state: { status: 'blocked' }, ticket: buildTicket },
    );
    expect(blocked.decision).toBe('deny');
    expect(blocked.reason).toMatch(/run is blocked/);
    // The blocked denial names its audited exits so the operator is not sent
    // hunting for a phantom "missing" run.
    expect(blocked.reason).toMatch(/REGATE/);
    expect(blocked.reason).toMatch(/OVERRIDE reset or ABORT/);

    const sealed = evaluateLifecyclePolicy(
      boundBash('rm src/value.js', { targets: ['src/value.js'], safe: true }),
      { state: { status: 'completed' }, ticket: buildTicket },
    );
    expect(sealed.decision).toBe('deny');
    expect(sealed.reason).toMatch(/sealed completed/);
  });

  it('never routes a parsed deletion through the evidence-command channel', () => {
    // `git rm` shares its leading token with the allowlisted read-only git
    // commands; a parsed deletion must be judged only on its own verdict.
    const result = evaluateLifecyclePolicy(
      boundBash('git rm --cached src/value.js'),
      { state, ticket: buildTicket },
    );
    expect(result.decision).toBe('deny');
    expect(result.reason).toMatch(/deletion denied/);
  });

  it('keeps an unparseable rm variant on the generic fail-closed path', () => {
    const result = evaluateLifecyclePolicy(
      boundBash('rm src/*.js'),
      { state, ticket: buildTicket },
    );
    expect(result.decision).toBe('deny');
    expect(result.reason).toMatch(/evidence commands/);
  });
});

function git(cwd, ...args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

async function project(status = 'running') {
  const dir = await mkdtemp(path.join(tmpdir(), 'ape-deletion-hook-'));
  cleanups.push(dir);
  await mkdir(path.join(dir, 'src'), { recursive: true });
  await mkdir(path.join(dir, 'docs'), { recursive: true });
  await mkdir(path.join(dir, '__tests__'), { recursive: true });
  await writeFile(path.join(dir, 'src', 'value.js'), 'export const value = 1;\n');
  await writeFile(path.join(dir, 'docs', 'readme.md'), '# readme\n');
  await writeFile(path.join(dir, '__tests__', 'sample.test.js'), 'test\n');
  git(dir, 'init', '-q');
  git(dir, 'config', 'user.email', 'ape@example.test');
  git(dir, 'config', 'user.name', 'APE Test');
  git(dir, 'add', '.');
  git(dir, 'commit', '-qm', 'test: baseline');
  const baseline = await currentTreeSha(dir);
  await atomicWriteJson(runtimePaths(dir).active, {
    run_id: 'run-del',
    status,
    tree_sha: baseline,
    tickets: [
      {
        ticket_id: 'run-del:build:b',
        role: 'implementer',
        writable: true,
        claimed_paths: ['src'],
        test_paths: ['__tests__'],
        base_tree_sha: baseline,
      },
      {
        ticket_id: 'run-del:test:t',
        role: 'test_writer',
        writable: true,
        claimed_paths: [],
        test_paths: ['__tests__'],
        base_tree_sha: baseline,
      },
    ],
    receipts: [],
  });
  return dir;
}

// Environment for the spawned binary: force the Claude host and strip any
// host-provided project hints so only the payload under test decides.
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

function boundBashCall(dir, ticketId, command) {
  return {
    hook_event_name: 'PreToolUse',
    project_dir: dir,
    session_id: 's1',
    is_subagent: true,
    ticket_id: ticketId,
    tool_name: 'Bash',
    tool_input: { command },
  };
}

describe('APE v2 hook binary deletion channel (path + role resolution)', () => {
  it('allows a bound implementer to rm a claimed file', async () => {
    const dir = await project();
    const response = await invokeHook(
      boundBashCall(dir, 'run-del:build:b', 'rm src/value.js'),
      dir,
    );
    expect(response.hookSpecificOutput.permissionDecision).toBe('allow');
    expect(response.hookSpecificOutput.permissionDecisionReason)
      .toBe('deletion authorized by run-del:build:b');
  });

  it('allows a bound implementer a git rm --cached of a claimed file', async () => {
    const dir = await project();
    const response = await invokeHook(
      boundBashCall(dir, 'run-del:build:b', 'git rm --cached src/value.js'),
      dir,
    );
    expect(response.hookSpecificOutput.permissionDecision).toBe('allow');
  });

  it('denies an rm outside the ticket claims', async () => {
    const dir = await project();
    const response = await invokeHook(
      boundBashCall(dir, 'run-del:build:b', 'rm docs/readme.md'),
      dir,
    );
    expect(response.hookSpecificOutput.permissionDecision).toBe('deny');
    expect(response.hookSpecificOutput.permissionDecisionReason)
      .toMatch(/outside the ticket claims/);
  });

  it('fails closed on chained, globbed, or quoted rm forms even inside claims', async () => {
    const dir = await project();
    for (const command of [
      'rm src/value.js; echo done',
      'rm src/*.js',
      "rm 'src/value.js'",
    ]) {
      const response = await invokeHook(boundBashCall(dir, 'run-del:build:b', command), dir);
      expect(response.hookSpecificOutput.permissionDecision, command).toBe('deny');
    }
  });

  it('denies an implementer deleting an authored test', async () => {
    const dir = await project();
    const response = await invokeHook(
      boundBashCall(dir, 'run-del:build:b', 'rm __tests__/sample.test.js'),
      dir,
    );
    expect(response.hookSpecificOutput.permissionDecision).toBe('deny');
    expect(response.hookSpecificOutput.permissionDecisionReason)
      .toMatch(/implementers may not delete authored tests/);
  });

  it('denies a test writer deleting a production path but allows its own test scope', async () => {
    const dir = await project();
    const production = await invokeHook(
      boundBashCall(dir, 'run-del:test:t', 'rm src/value.js'),
      dir,
    );
    expect(production.hookSpecificOutput.permissionDecision).toBe('deny');
    expect(production.hookSpecificOutput.permissionDecisionReason)
      .toMatch(/test writers may delete only claimed test paths/);

    const test = await invokeHook(
      boundBashCall(dir, 'run-del:test:t', 'rm __tests__/sample.test.js'),
      dir,
    );
    expect(test.hookSpecificOutput.permissionDecision).toBe('allow');
  });

  it('denies rm -rf on an out-of-project path', async () => {
    const dir = await project();
    // A relative `../` target exercises the deletion channel's out-of-project
    // branch on every platform: it is free of forbidden chars so it parses,
    // yet normalizes above the root. An OS-native absolute path would be
    // Windows-specific (its drive colon and backslashes fail closed at parse,
    // routing to the generic evidence deny rather than this path reason).
    const response = await invokeHook(
      boundBashCall(dir, 'run-del:build:b', 'rm -rf ../ape-deletion-outside-victim'),
      dir,
    );
    expect(response.hookSpecificOutput.permissionDecision).toBe('deny');
    expect(response.hookSpecificOutput.permissionDecisionReason)
      .toMatch(/outside the project/);
  });

  it('passes the tree-reconciliation guard once a claimed deletion has executed', async () => {
    // The drift guard diffs baseline→tree at post events; a deleted claimed
    // file must reconcile to its ticket (withinClaim on the deleted path) and
    // the executed deletion must not be blocked after the fact.
    const dir = await project();
    await rm(path.join(dir, 'src', 'value.js'));
    const response = await invokeHook(
      {
        ...boundBashCall(dir, 'run-del:build:b', 'rm src/value.js'),
        hook_event_name: 'PostToolUse',
      },
      dir,
    );
    // A PostToolUse allow is the empty response shape (no decision field).
    expect(response.decision).toBeUndefined();
  });

  it('resolves a relative rm target against the session cwd, not the project root', async () => {
    // The shell runs `rm value.js` in the session cwd; when that cwd is a
    // subdirectory of the project the target must resolve there. Checking it
    // against paths.root instead was a false deny of the claimed file.
    const dir = await project();
    const response = await invokeHook(
      { ...boundBashCall(dir, 'run-del:build:b', 'rm value.js'), cwd: path.join(dir, 'src') },
      dir,
    );
    expect(response.hookSpecificOutput.permissionDecision).toBe('allow');
    expect(response.hookSpecificOutput.permissionDecisionReason)
      .toBe('deletion authorized by run-del:build:b');
  });

  it('denies a relative rm whose cwd-resolved target escapes the ticket claims', async () => {
    // Same command, different cwd: `rm src/value.js` from the docs subtree
    // resolves to docs/src/value.js — outside the src claim. Resolving against
    // paths.root would have been a false allow of a path the shell never
    // touches (and left the real deletion undetected).
    const dir = await project();
    const response = await invokeHook(
      { ...boundBashCall(dir, 'run-del:build:b', 'rm src/value.js'), cwd: path.join(dir, 'docs') },
      dir,
    );
    expect(response.hookSpecificOutput.permissionDecision).toBe('deny');
    expect(response.hookSpecificOutput.permissionDecisionReason)
      .toMatch(/outside the ticket claims/);
  });

  it('denies a backslash-escaped upward traversal the shell would de-escape to ..', async () => {
    const dir = await project();
    for (const command of ['rm src/\\.\\./package.json', 'rm -rf src/\\.\\./.git']) {
      const response = await invokeHook(boundBashCall(dir, 'run-del:build:b', command), dir);
      expect(response.hookSpecificOutput.permissionDecision, command).toBe('deny');
    }
  });

  it('denies a deletion once the run is sealed', async () => {
    const dir = await project('completed');
    const response = await invokeHook(
      boundBashCall(dir, 'run-del:build:b', 'rm src/value.js'),
      dir,
    );
    expect(response.hookSpecificOutput.permissionDecision).toBe('deny');
    expect(response.hookSpecificOutput.permissionDecisionReason).toMatch(/sealed completed/);
  });
});

// Deletion is a production write (invariant 2), but the deletion grammar branch
// (lib/runtime/hooks.js) gates only on host + ticket + parse — unlike the
// WRITE_TOOLS branch it never checks event.is_subagent. Because event.ticket_id
// can be seeded from env.APE_TICKET_ID (normalizeLifecycleEvent), a MAIN session
// (is_subagent false, no agent identity, no payload ticket_id) that merely
// carries APE_TICKET_ID naming a writable running ticket resolves that ticket,
// gets event.deletion precomputed by bin/ape-hook.mjs, and — on the base tree —
// is AUTHORIZED to rm a claimed file. The fix adds the symmetric guard the write
// branch already has; a genuinely bound subagent's identical deletion still
// succeeds, since the two events differ only in is_subagent.

// Sibling of invokeHook that layers an env override on the same forced-Claude,
// hint-stripped base (claudeEnv also strips APE_TICKET_ID, so the override is
// the only source of the binding under test).
function invokeHookWithEnv(input, cwd, extraEnv = {}) {
  return new Promise((resolve, reject) => {
    const env = { ...process.env, CLAUDECODE: '1' };
    delete env.CLAUDE_PROJECT_DIR;
    delete env.CODEX_CWD;
    delete env.APE_TICKET_ID;
    Object.assign(env, extraEnv);
    const child = spawn(process.execPath, [hookBinary], {
      cwd,
      env,
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

// Main-session PreToolUse: no is_subagent, no agent identity, no payload
// ticket_id — the binding comes solely from env.APE_TICKET_ID.
function mainSessionBashCall(dir, command) {
  return {
    hook_event_name: 'PreToolUse',
    project_dir: dir,
    session_id: 's1',
    tool_name: 'Bash',
    tool_input: { command },
  };
}

describe('APE v2 hook binary deletion main-session guard (is_subagent)', () => {
  it('denies a main-session env-bound rm of a claimed file', async () => {
    // RED on the base tree: the deletion branch resolves the ticket from
    // APE_TICKET_ID, precomputes a safe verdict for the claimed src file, and
    // authorizes the deletion because it never checks is_subagent. Post-fix the
    // symmetric guard denies it as a main-session production write.
    const dir = await project();
    const response = await invokeHookWithEnv(
      mainSessionBashCall(dir, 'rm src/value.js'),
      dir,
      { APE_TICKET_ID: 'run-del:build:b' },
    );
    expect(response.hookSpecificOutput.permissionDecision).toBe('deny');
    expect(response.hookSpecificOutput.permissionDecisionReason)
      .toMatch(/main-session production writes are forbidden/);
  });

  it('still allows the identical rm from a bound subagent', async () => {
    // The guard keys on is_subagent alone, so a genuinely bound subagent
    // (is_subagent true + payload ticket_id, the same shape the passing tests
    // above use) keeps its claimed deletion — the fix narrows nothing for the
    // sanctioned actor.
    const dir = await project();
    const response = await invokeHook(
      boundBashCall(dir, 'run-del:build:b', 'rm src/value.js'),
      dir,
    );
    expect(response.hookSpecificOutput.permissionDecision).toBe('allow');
    expect(response.hookSpecificOutput.permissionDecisionReason)
      .toBe('deletion authorized by run-del:build:b');
  });
});

// ===========================================================================
// FINDING 3, END TO END — the claim check is the ONLY thing standing between
// `rm =node` and an unrecoverable out-of-project delete, and with the session
// cwd inside a claimed subdirectory it does not stand.
//
// The mechanism, step by step through the real binary:
//   parseDeletionCommand('rm =node')          -> {targets: ['=node']}
//   path.resolve('<dir>/src', '=node')        -> '<dir>/src/=node'
//   normalizePath(...)                        -> 'src/=node'      INSIDE
//   pathResolvesWithinClaims(root, ..., ['src']) -> TRUE
//   => ALLOW, and zsh deletes the absolute path of whatever `node` names.
//
// This is the same relative-target-resolves-against-the-session-cwd path the
// suite already pins two arms above ('resolves a relative rm target against the
// session cwd'), which is what makes the escape reachable rather than
// theoretical: the gate's own correct cwd handling is what puts the forged
// target inside the claim.
//
// DECISION ONLY. The hook is asked what it WOULD permit; nothing is deleted,
// and `rm =node` was never run anywhere in this run.
// ===========================================================================
describe('APE v2 hook binary deletion channel: `=`-initial targets (finding 3)', () => {
  it('DENIES `rm =node` when the session cwd puts the forged target inside a claim', async () => {
    const dir = await project();
    const response = await invokeHook(
      { ...boundBashCall(dir, 'run-del:build:b', 'rm =node'), cwd: path.join(dir, 'src') },
      dir,
    );
    expect(response.hookSpecificOutput.permissionDecision).toBe('deny');
  });

  it('DENIES it from the project root too, and for a test writer in its own test scope', async () => {
    // BOTH HALVES ARE PART OF THE CONTRACT, and they are NOT both red today —
    // said plainly because the difference is the whole shape of the finding.
    // From the project ROOT the forged target normalizes to `=node`, which is
    // outside the `src` claim, so the CLAIM check already refuses it; that is
    // the boundary holding by accident of where the shell happened to stand.
    // From a CLAIMED directory it does not hold: a test writer standing in
    // `__tests__` forges `__tests__/=node`, which is inside its own test scope,
    // and the deletion is AUTHORIZED. The refusal therefore has to be a
    // property of the COMMAND, not of the claim the forged target lands in.
    const dir = await project();
    const fromRoot = await invokeHook(
      boundBashCall(dir, 'run-del:build:b', 'rm =node'),
      dir,
    );
    expect(fromRoot.hookSpecificOutput.permissionDecision).toBe('deny');

    const testWriter = await invokeHook(
      {
        ...boundBashCall(dir, 'run-del:test:t', 'rm =node'),
        cwd: path.join(dir, '__tests__'),
      },
      dir,
    );
    expect(testWriter.hookSpecificOutput.permissionDecision).toBe('deny');
  });

  it('still ALLOWS the ordinary claimed deletion from that same cwd (non-vacuity)', async () => {
    // Without this half the refusal above could be explained by the cwd, the
    // role, or the claim rather than by the character rule. `rm value.js` from
    // `<dir>/src` is the arm the suite already pins as ALLOW, restated here so
    // the pair reads as one contract.
    const dir = await project();
    const response = await invokeHook(
      { ...boundBashCall(dir, 'run-del:build:b', 'rm value.js'), cwd: path.join(dir, 'src') },
      dir,
    );
    expect(response.hookSpecificOutput.permissionDecision).toBe('allow');
    expect(response.hookSpecificOutput.permissionDecisionReason)
      .toBe('deletion authorized by run-del:build:b');
  });
});
