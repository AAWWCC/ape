import { access, mkdir, open, readFile, rename, rm } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { spawnWithTimeout } from './spawn.js';

async function exists(file) {
  try {
    await access(file);
    return true;
  } catch {
    return false;
  }
}

function descriptor(runner, command, args, source) {
  return { runner, command, args, source };
}

export async function detectTestRunner(projectDir, options = {}) {
  const platform = options.platform ?? process.platform;
  const win = platform === 'win32';
  const override = options.override;
  if (override?.command) {
    return descriptor('override', override.command, override.args ?? [], 'config');
  }

  const scriptTest = path.join(projectDir, 'script', 'test');
  if (await exists(scriptTest)) return descriptor('script-test', scriptTest, [], 'script/test');

  const packageJson = path.join(projectDir, 'package.json');
  if (await exists(packageJson)) {
    try {
      const pkg = JSON.parse(await readFile(packageJson, 'utf8'));
      if (pkg.scripts?.test) return descriptor('javascript', win ? 'npm.cmd' : 'npm', ['test'], 'package.json');
    } catch {
      // A malformed manifest is not a confident runner signal.
    }
  }
  // A uv-managed project runs its suite through `uv run pytest`; bare pytest and
  // `python -m pytest` are not on PATH outside the managed venv, so detect uv
  // first. The `uv` binary is the same name on every platform (shell:false spawn).
  if (await exists(path.join(projectDir, 'uv.lock'))) {
    return descriptor('python-uv', 'uv', ['run', 'pytest'], 'uv.lock');
  }
  if (await exists(path.join(projectDir, 'pytest.ini')) ||
      await exists(path.join(projectDir, 'pyproject.toml')) ||
      await exists(path.join(projectDir, 'setup.cfg'))) {
    return descriptor('python', win ? 'py' : 'python3', ['-m', 'pytest'], 'python-config');
  }
  if (await exists(path.join(projectDir, 'go.mod'))) {
    return descriptor('go', 'go', ['test', './...'], 'go.mod');
  }
  if (await exists(path.join(projectDir, 'Cargo.toml'))) {
    return descriptor('rust', 'cargo', ['test'], 'Cargo.toml');
  }
  if (await exists(path.join(projectDir, 'Gemfile'))) {
    return descriptor('ruby', win ? 'bundle.bat' : 'bundle', ['exec', 'rake', 'test'], 'Gemfile');
  }
  if (await exists(path.join(projectDir, 'pom.xml'))) {
    const wrapper = win ? 'mvnw.cmd' : './mvnw';
    return descriptor('maven', await exists(path.join(projectDir, win ? 'mvnw.cmd' : 'mvnw')) ? wrapper : 'mvn', ['test'], 'pom.xml');
  }
  if (await exists(path.join(projectDir, 'build.gradle')) ||
      await exists(path.join(projectDir, 'build.gradle.kts'))) {
    const wrapperName = win ? 'gradlew.bat' : 'gradlew';
    const wrapper = win ? 'gradlew.bat' : './gradlew';
    return descriptor('gradle', await exists(path.join(projectDir, wrapperName)) ? wrapper : 'gradle', ['test'], 'gradle-build');
  }
  return descriptor('none', null, [], 'undetected');
}

// Derive a bounded, deterministic targeted invocation from a detected runner
// and a set of runtime-validated test paths. Runners with per-path selection
// get exactly those paths appended and return scoped:true. Runners without a
// path-selection syntax (cargo/rake/maven/gradle select by test NAME, not
// file path) fall back to their default suite invocation with scoped:false:
// the superset is sound evidence ONLY for pass-required gates — a passing
// superset implies the targeted subset passed — never for red admission,
// where a failing superset proves nothing about the authored tests (any
// unrelated red or flaky test fails it). Red admission must reject
// scoped:false and demand test_commands.targeted_template instead.
export function targetedInvocation(runner, testPaths) {
  if (!runner?.command) return null;
  const paths = [...new Set(testPaths)].sort();
  if (paths.length === 0) return null;
  switch (runner.runner) {
    // FAITH-BASED SCOPING (T7) — `script/test <paths>` (here) and `npm test --
    // <paths>` (the javascript case below) are marked scoped:true ON THE
    // ASSUMPTION that the aggregate script forwards its file arguments to a
    // path-filtering runner. If the script ignores its positional arguments it
    // runs the WHOLE suite, and an unrelated pre-existing failure can seal a
    // VACUOUS red at red-test admission. This is a documented limitation, NOT a
    // demotion: demoting scoped:true would break every correctly-forwarding
    // script/test (and npm→vitest/jest) project. The remedy for an aggregate
    // script is test_commands.targeted_template ('{paths}' receives the authored
    // test files); redTestNotice() in service.js warns the test writer at
    // issuance. (python-uv/python share this return but are genuinely sound:
    // `-m pytest <paths>` selects by path natively — no forwarding assumption.)
    case 'script-test':
    case 'python-uv':
    case 'python':
      return { command: runner.command, args: [...runner.args, ...paths], scoped: true };
    case 'javascript':
      // `npm test -- <paths>` forwards the paths to the underlying script — see
      // the faith-based scoping note above: scoped:true here TRUSTS the npm/pnpm/
      // yarn/bun test script to forward its arguments to a path-filtering runner.
      // An aggregate script that ignores them runs the whole suite (possible
      // vacuous red at admission); remedy is test_commands.targeted_template.
      return { command: runner.command, args: [...runner.args, '--', ...paths], scoped: true };
    case 'go': {
      // Package-level is the finest path scope go offers. A root-level
      // *_test.go maps to `.` — the root package only — never `./...`,
      // which silently widens to the entire module (whole-suite-equivalent,
      // exactly what scoped:true must exclude).
      const dirs = [...new Set(paths.map((file) => {
        const dir = path.posix.dirname(file.replaceAll('\\', '/'));
        return dir === '.' ? '.' : `./${dir}`;
      }))].sort();
      return { command: runner.command, args: ['test', ...dirs], scoped: true };
    }
    default:
      return { command: runner.command, args: [...runner.args], scoped: false };
  }
}

// Render the operator-configured red-phase template against the runtime-
// validated authored test paths. Expansion happens at argv level after
// tokenization — never by re-tokenizing a substituted string — so a path
// with spaces stays one argument and the result composes with buildSpawnPlan
// (win32 batch quoting included). A token that IS `{paths}` expands to one
// argv entry per path; a token CONTAINING `{paths}` (env-var shapes like
// `TEST={paths}`) receives the space-joined list in place. Returns null when
// the template never mentions `{paths}`: a path-blind command cannot scope
// the red phase, which is the template's entire purpose.
export function templateInvocation(template, testPaths) {
  const paths = [...new Set(testPaths)].sort();
  const tokens = splitCommand(template);
  if (!tokens.some((token) => token.includes('{paths}'))) return null;
  const rendered = [];
  for (const token of tokens) {
    if (token === '{paths}') rendered.push(...paths);
    else if (token.includes('{paths}')) rendered.push(token.replaceAll('{paths}', paths.join(' ')));
    else rendered.push(token);
  }
  const [command, ...args] = rendered;
  return { command, args, scoped: true, template: true };
}

// Pytest reserves exit 5 for "no tests collected" and 4 for usage errors —
// non-verdict outcomes that red admission must reject — but those same codes
// are ordinary failure exits for other runners, so the rule may only fire on
// invocations that are provably pytest: the detected python families, an
// argv token whose basename is pytest/py.test (any extension: pytest.exe,
// a pytest wrapper script), or the `-m pytest` module form.
export function isPytestInvocation(runnerFamily, argvTokens) {
  if (runnerFamily === 'python' || runnerFamily === 'python-uv') return true;
  const tokens = Array.isArray(argvTokens) ? argvTokens.map(String) : [];
  return tokens.some((token, index) => {
    if (token === '-m' && tokens[index + 1] === 'pytest') return true;
    const base = path.posix.basename(token.replaceAll('\\', '/'));
    const bare = base.replace(/\.[^.]+$/, '');
    return base === 'pytest' || base === 'py.test' || bare === 'pytest' || bare === 'py.test';
  });
}

export function splitCommand(command) {
  const tokens = [];
  let current = '';
  let quote = null;
  for (let index = 0; index < command.length; index += 1) {
    const char = command[index];
    if (quote) {
      if (char === quote) quote = null;
      else current += char;
    } else if (char === '"' || char === "'") {
      quote = char;
    } else if (/\s/.test(char)) {
      if (current) tokens.push(current);
      current = '';
    } else {
      current += char;
    }
  }
  if (quote) throw new Error('unterminated quote in test command');
  if (current) tokens.push(current);
  return tokens;
}

// Windows cannot spawn .cmd/.bat batch scripts with shell:false — Node's
// CVE-2024-27980 hardening raises EINVAL — yet npm/bundle/gradle resolve to
// exactly those shims there. Batch scripts therefore go through the shell as
// one cmd.exe-quoted string; real executables keep the safer shell:false
// argv spawn on every platform.
// A '%' inside a double-quoted cmd.exe token is still expanded: the percent
// phase runs BEFORE caret removal, so '^' cannot escape it, and a caret inside a
// quoted run is not removed at all (it would corrupt the value). What DOES
// defeat expansion is splitting the token on '%' and quoting each non-empty
// segment separately: the injected quotes land inside the candidate variable
// name (%"NAME"% names an undefined variable, which the command-line parser
// leaves verbatim), while MSVCRT's argv parser strips them and hands the program
// back the literal %NAME%. The safety precondition is quote PARITY — every
// emitted token carries an EVEN number of quotes, so every '%' sits OUTSIDE a
// quoted run and cmd's quote state still closes at each token end. An
// all-percent token emits a BARE, zero-quote '%' (zero is even).
//
// The trailing-backslash doubling ships WITH the split, and this is why:
// MSVCRT's backslash rule is separate from cmd's quote state — an odd run of
// '\' immediately before a quote escapes that quote. Token-final, that already
// corrupted argv today ('tests/some dir\' came back as 'tests/some dir"'), and
// giving every '%'-segment its own closing quote WIDENS the same hazard to each
// interior segment boundary (a segment ending in an odd backslash run would lose
// the backslash and gain a spurious quote; with a space it can split one token
// into two). Doubling each segment's trailing run makes it even, so MSVCRT emits
// half the backslashes literally and leaves the quote to close — which also
// repairs the pre-existing token-final case. It adds no quotes, so parity is
// untouched. The EMBEDDED-quote half is CLOSED as well (2026-07-25 sweep): a
// backslash run immediately before ANY quote is doubled along with that quote,
// so the run reaches MSVCRT EVEN, MSVCRT emits the intended backslashes, and the
// doubled '""' decodes as ONE literal quote. Parity survives because quotes are
// still only ever added in PAIRS — the canonical MSVCRT '\"' escape is
// deliberately NOT used, since it adds ONE quote, breaks parity and re-opens the
// '%' hole.
//
// A '%'-free token is a single segment, so its rendering is unchanged except for
// that trailing backslash run, which is exactly the case whose old output was
// provably wrong on win32.
//
// RESIDUAL, recorded not fixed — the CROSS-TOKEN one, which this quoting does
// not address: a rendering that ENDS with a bare '%' pairs with the NEXT '%' ON
// THE LINE, and the candidate variable name cmd.exe looks up is the RENDERING in
// between. The closer is that next '%' on the line, not necessarily the
// following token's leading one — an intervening all-'%' token supplies its own,
// so ['a%','%','%b'] renders `npm.cmd "a"% % %"b"` and the candidate is ' ', not
// ' % '. The candidate is QUOTE-FREE whenever every intervening token renders
// unquoted, and two token classes render unquoted: a NON-EMPTY token with no
// character from /[\s"&<>|^%()!]/, returned verbatim by the early return below,
// and a token of only '%' characters, whose split segments are all empty so none
// is wrapped. The counter-example is an EMPTY token — quoteForCmd('') returns
// '""', so an empty intervening token makes the candidate quoted. Before the
// split shipped, every '%'-bearing token was ONE quoted run, so the equivalent
// candidate always carried a quote: same class, different wording. EXPLOITATION
// PRECONDITION, so this reads as a shape and not a new hazard: it needs a
// variable of exactly that name — leading and trailing spaces included — DEFINED
// in the environment the runtime hands the spawned child, i.e. control of that
// environment, which already implies code execution via PATH.
//
// argv[0] goes through this same quoting (buildSpawnPlan maps it over
// [command, ...args]; that line is unchanged by the '%'-split — argv[0] always
// went THROUGH quoteForCmd, and a '%'-bearing launcher path was always emitted
// as ONE quoted run, so only HOW that path is quoted changed. A
// metacharacter-free argv[0] such as 'npm.cmd' takes the early return below and
// is emitted BARE, before and after). So a win32 launcher path holding a
// literal '%' is emitted SPLIT ACROSS QUOTES: 'C:\tools\100%\npm.cmd' renders as
// "C:\tools\100"%"\npm.cmd", and cmd.exe strips those quotes before resolving
// the executable. argv[0] is deliberately not exempted, because exempting it
// would restore '%'-substitution of the gate's own executable — the most severe
// form of the defect this quoting closes. What cmd.exe's executable-name
// resolution makes of the split form is NOT verified by the covering suites,
// which model the percent phase and MSVCRT argv parsing only.
//
// DELAYED EXPANSION (!VAR!) IS A RECORDED WON'T-FIX, NOT A GAP LEFT UNSAID
// (roadmap entry cmd-delayed-expansion-residual). Everything above neutralizes
// the PERCENT phase and nothing else. Delayed expansion is a separate, later
// phase: it is off by default, and Node spawns the child as `cmd /d /s /c`, but
// /d suppresses AutoRun, NOT delayed expansion — an operator carrying
// HKCU\Software\Microsoft\Command Processor\DelayedExpansion has it on for every
// non-interactive cmd.exe, this gate's included. BOTH halves, because
// "off by default" alone would have dismissed the percent case too:
//   WHY THE PRECONDITION IS ACCEPTABLE TO LEAVE OPEN. It is a machine-wide
//   registry value the operator set, reachable by no run: not by project config,
//   not by a test path, not by any agent-supplied token. The percent case needed
//   nothing but a '%' in a path and fired on a stock machine; this one cannot be
//   acquired without the operator's own prior act, so no un-consented input
//   arrives at it.
//   WHAT IT COSTS WHEN IT IS SET. Quoting buys NOTHING there — delayed expansion
//   runs after quote processing, so the quotes this function adds are already
//   gone. A '!VAR!' anywhere in a configured test command, a test path, or a
//   {paths} rendering is substituted before the program sees it, and an
//   undefined name collapses to the empty string, so the gate can execute a
//   command line the operator did not configure. That is the same class of
//   defect the '%'-split closed, not a lesser one; what differs is only how the
//   precondition is reached.
// REACHABILITY IS DERIVED, NOT OBSERVED: every statement here follows from
// documented cmd.exe behavior plus the spawn shape this file builds, and none of
// it was reproduced on a real win32 host.
function quoteForCmd(token) {
  if (token === '') return '""';
  // SCOPED TO '%', and this trigger set reads otherwise at a glance: '!' is in
  // it, so a '!VAR!'-bearing token IS quoted below. That is incidental, never
  // treatment — see the delayed-expansion won't-fix above. Only the '%' split
  // neutralizes anything; the quotes are for whitespace and cmd metacharacters.
  if (!/[\s"&<>|^%()!]/.test(token)) return token;
  return token
    .split('%')
    .map((segment) =>
      segment === ''
        ? ''
        : `"${segment.replace(/(\\*)"/g, '$1$1""').replace(/(\\+)$/, '$1$1')}"`,
    )
    .join('%');
}

// Bare launcher NAMES that ship as .cmd/.bat/.ps1 shims on Windows (npm-family
// package managers, common node_modules/.bin test runners, and JVM/Ruby build
// tools). A shell:false spawn of these raises EINVAL there (the CVE-2024-27980
// hardening) — and unlike a real executable, `spawn('npx', …)` never resolves
// npx.cmd because CreateProcess only appends .exe. buildSpawnPlan cannot
// PATH-resolve a bare name to learn its real extension, so on win32 it routes a
// bare shim launcher through cmd.exe exactly like an explicit .cmd/.bat, while
// real .exe launchers (node, python, cargo, go, uv, deno) keep the safer argv
// spawn. Extend this set as new shim-shaped launchers appear.
const WINDOWS_SHIM_LAUNCHERS = new Set([
  'npm', 'npx', 'yarn', 'pnpm', 'pnpx', 'bunx',
  'vitest', 'jest', 'mocha', 'ava', 'tap', 'playwright', 'cypress', 'tsc', 'eslint', 'prettier', 'biome',
  'mvn', 'gradle', 'bundle', 'rake',
]);

function windowsNeedsShell(command) {
  if (/\.(cmd|bat)$/i.test(command)) return true;
  // A bare launcher with no explicit extension may resolve to a .cmd/.ps1 shim.
  const base = command.replace(/^.*[\\/]/, '').toLowerCase();
  return WINDOWS_SHIM_LAUNCHERS.has(base);
}

export function buildSpawnPlan(command, args, platform = process.platform) {
  if (platform === 'win32' && windowsNeedsShell(command)) {
    return { command: [command, ...args].map(quoteForCmd).join(' '), args: [], shell: true };
  }
  return { command, args, shell: false };
}

export async function runTestSuite(projectDir, options = {}) {
  let runner;
  if (typeof options.command === 'string' && options.command.trim()) {
    let tokens;
    try {
      tokens = splitCommand(options.command);
    } catch (error) {
      // A malformed configured command (unbalanced quote in test_commands.*)
      // is a tooling failure to report, not an exception to throw: this runs
      // inside the receipt-effects critical section, where an escaping
      // rejection used to abandon the run mid-transition.
      return {
        passed: false,
        runner: descriptor('override', null, [], 'config'),
        exit_code: null,
        duration_ms: 0,
        output: error.message,
        tooling_failure: true,
      };
    }
    const [command, ...args] = tokens;
    runner = descriptor('override', command, args, 'config');
  } else {
    runner = await detectTestRunner(projectDir, options);
  }
  if (!runner.command) {
    return {
      passed: false,
      runner,
      exit_code: null,
      duration_ms: 0,
      output: 'No test runner detected. Configure test_commands.full.',
      tooling_failure: true,
    };
  }

  const started = Date.now();
  const plan = buildSpawnPlan(runner.command, runner.args, options.platform ?? process.platform);
  const result = await spawnWithTimeout(plan.command, plan.args, {
    cwd: projectDir,
    shell: plan.shell,
    collect: 'combined',
    max_output: 200_000,
    timeout_ms: options.timeout_ms ?? 30 * 60_000,
    kill_grace_ms: options.kill_grace_ms,
    drain_ms: options.drain_ms,
  });
  if (result.spawn_error) {
    return {
      passed: false,
      runner,
      exit_code: null,
      duration_ms: Date.now() - started,
      output: result.spawn_error.message,
      tooling_failure: true,
    };
  }
  return {
    // A run that hit the deadline can never pass, even when the killed tree
    // manages to exit 0 (a SIGTERM-trapping suite shutting down "cleanly"):
    // no verdict was observed before the deadline, so nothing may be cached
    // or admitted as one.
    passed: result.exit_code === 0 && result.timed_out !== true,
    runner,
    exit_code: result.exit_code,
    duration_ms: Date.now() - started,
    output: result.combined,
    tooling_failure: false,
    // Absent-when-false, never `timed_out: false`, and no other new keys:
    // sha256(verification) feeds the red-test/gate result hashes and the
    // suite cache, so every non-timeout verification must keep its
    // historical hash byte-identical.
    ...(result.timed_out === true ? { timed_out: true } : {}),
  };
}

// The detached gate-suite runner (CLI mode). The parent (gates.js startGateSuite)
// spawns THIS module as its own `node lib/runtime/runner.js --ape-gate-runner`
// process with APE_GATE_RUNNER_JOB pointing at a job descriptor, then rests the
// run in 'gating'. The child heartbeats, runs the operator-configured full suite
// under the job's armed deadline, and atomically writes a result artifact a later
// poll consumes. It NEVER runs git and NEVER touches the project tree — the
// parent computed the tree sha and built the spawn plan; the child only executes
// it. Imports stay limited to ./spawn.js so this file runs UNBUNDLED from the
// installed plugin cache even when the parent is the bundled MCP server.
export const GATE_RUNNER_SENTINEL = '--ape-gate-runner';

// Atomic private write (temp + rename, 0600) without importing storage.js:
// keeping the runner's runtime-module imports to ./spawn.js only is what lets
// the parent spawn this unbundled entry from the plugin cache. It carries BOTH
// the result artifact below and every HEARTBEAT beat. The beat belongs here
// because that file is the IDENTITY WITNESS killProcessTree keys a SIGKILL on
// (spawn.js): temp+rename makes a concurrent reader's view whole-or-nothing, so
// a read racing a beat can no longer see a truncated witness and veto a kill
// against a live runner, and 0600 gives it the same privacy the artifact beside
// it already had. What that swap TRADED is argued once, at false-negative
// ledger entry (b) in spawn.js, and deliberately not restated here so the two
// records cannot drift.
//
// THE ORPHANED TEMP — WHAT THIS RUN CLOSES, AND WHAT GENUINELY REMAINS. A
// write that never reaches the rename below leaves `<file>.<pid>.<ms>.tmp`
// behind. Three producers were ever possible:
//   (1) THIS PROCESS'S OWN NORMAL EXIT, racing an untracked beat — CLOSED.
//       runGateJob used to drive beats through `setInterval` and discard each
//       returned promise, so a beat that entered its write before
//       `clearInterval` could still complete its rename AFTER the finish
//       path's `rm(heartbeatFile)` below, republishing a fresh witness for a
//       runner about to `process.exit(0)` (the untracked-beat-promise
//       resurrection this run exists to close). runGateJob now tracks at most
//       one in-flight beat write (a beat is SKIPPED, not queued, while one is
//       already running — closing, as a side effect, the out-of-order-publish
//       hazard two overlapping renames could otherwise produce too) and its
//       finish path awaits that tracked write before the `rm`, so the removal
//       is provably this process's last write to heartbeatFile.
//   (2) AN EXTERNAL SIGKILL MID-WRITE — REMAINS, unreachable from inside this
//       process by construction: SIGKILL runs no catch, no finally and no exit
//       handler, so nothing here can unlink on that path.
//   (3) A FAILED/THROWN WRITE — REMAINS, and IS reachable from inside this
//       process: a rejected writeFile/sync/rename (the win32 antivirus/indexer
//       locks argued at spawn.js's false-negative ledger entry (b), which this
//       helper's rename carries none of replaceFile's bounded EPERM/EACCES/
//       EBUSY retry against) orphans its temp the same way, and startBeat's
//       `.catch(() => {})` swallows the rejection rather than surfacing it.
//       Declined for PREVENTION, not merely left: an unlink in a catch is the
//       only cover, and the caller already swallows the rejection — exactly
//       as storage.js's atomicWriteJson and atomicReplaceText decline it, on
//       the same shape of temp, for the same reason.
//   What closes producers (2) and (3)'s residue is not prevention but
//   cleanup: a bounded sweep of stale temps of both shapes this runtime
//   produces, run in the gate-suite directory at every launchGateRunner
//   chokepoint in gates.js (initial start, respawn, and each multi-runner
//   advance). See that function for the bound and its own residual: the
//   sweep fires only at a LAUNCH, so a kill against the last launch of a
//   run leaves its orphan on disk until some future gate evaluation
//   launches again.
async function atomicWriteFile600(file, text) {
  await mkdir(path.dirname(file), { recursive: true }).catch(() => {});
  const temporary = `${file}.${process.pid}.${Date.now()}.tmp`;
  const handle = await open(temporary, 'wx', 0o600);
  try {
    await handle.writeFile(text, 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(temporary, file);
}

// Exported so a test can drive its ordering deterministically (runGateJob's
// beats cannot otherwise be raced across a real detached child process
// boundary). `options.writeHeartbeat(file, text) => Promise<void>` overrides
// ONLY the heartbeat write — never the result artifact — and defaults to the
// real atomic write below when omitted, so an unconfigured (production) call
// stays byte-identical to today: the same "injected by tests" convention
// spawn.js's killProcessTree already uses (stale_ms / kill_grace_ms /
// platform).
export async function runGateJob(options = {}) {
  const writeHeartbeat = typeof options.writeHeartbeat === 'function'
    ? options.writeHeartbeat
    : atomicWriteFile600;
  const jobFile = process.env.APE_GATE_RUNNER_JOB;
  if (!jobFile) return;
  let job;
  try {
    job = JSON.parse(await readFile(jobFile, 'utf8'));
  } catch {
    // No readable job: nothing to run. The parent's respawn fence recovers.
    return;
  }
  const heartbeatFile = job.heartbeat_file;
  const artifactFile = job.artifact_file;
  const plan = job.plan ?? {};
  // A5: a hung suite must never pend gating forever behind a fresh heartbeat.
  // The parent already resolves a finite deadline into the job; guard again here.
  const timeoutMs = Number.isFinite(job.timeout_ms) ? job.timeout_ms : 30 * 60_000;
  const heartbeatMs = Number.isFinite(job.heartbeat_ms) ? job.heartbeat_ms : 5_000;

  // Track AT MOST one in-flight beat write (serialize-by-skipping) rather than
  // discarding it: `inFlight`, when set, is always the CATCH-WRAPPED promise
  // below (never rejects) — the finish path awaits it before removing the
  // heartbeat, and a raw (unwrapped) promise there would make that await
  // reject on a failed write, skip the `rm`, and leave behind a heartbeat a
  // beat already renamed into place on exit — the exact resurrection this
  // closes, reached from the write-error path instead of the timing one.
  // `stopped` makes a beat that would start after the finish path begins a
  // no-op rather than a write, even though `clearInterval` below already
  // stops future ticks from firing one.
  let inFlight = null;
  let stopped = false;
  const startBeat = () => {
    if (stopped || inFlight) return inFlight;
    const attempt = writeHeartbeat(heartbeatFile, JSON.stringify({ pid: process.pid, beat_at: Date.now() }))
      .catch(() => {});
    inFlight = attempt;
    // A beat is SKIPPED, not queued, while one is already in flight — cadence
    // (setInterval still fires every heartbeatMs) is unchanged, only an
    // overlapping WRITE is; this is also what makes "await the tracked slot"
    // equivalent to "await every started beat": at most one is ever in flight,
    // so there is never an earlier one left unawaited behind a newer one.
    attempt.then(() => {
      if (inFlight === attempt) inFlight = null;
    });
    return attempt;
  };
  await startBeat();
  const heartbeat = setInterval(startBeat, heartbeatMs);
  heartbeat.unref?.();

  const started = Date.now();
  const result = await spawnWithTimeout(plan.command, plan.args ?? [], {
    // A polyglot runner's suite runs at its OWN root (suite_cwd) so a subdir
    // command resolves its manifest/config from cwd; older jobs without the
    // field fall back to project_dir (the repo root).
    cwd: job.suite_cwd ?? job.project_dir,
    shell: plan.shell === true,
    collect: 'combined',
    max_output: 200_000,
    timeout_ms: timeoutMs,
    // Keep the suite in THIS runner's process group so an ABORT that signals the
    // runner's group also reaches the suite (A6). A4: scrub APE_GATE_RUNNER_JOB
    // from the suite grandchild's environment — spawnWithTimeout merges env over
    // process.env, and an undefined value is omitted from the child env.
    detached: false,
    env: { APE_GATE_RUNNER_JOB: undefined },
  });
  stopped = true;
  clearInterval(heartbeat);
  const durationMs = Date.now() - started;

  const passed = !result.spawn_error && result.exit_code === 0 && result.timed_out !== true;
  const verification = {
    passed,
    exit_code: result.spawn_error ? null : result.exit_code,
    duration_ms: durationMs,
    output: result.spawn_error ? result.spawn_error.message : result.combined,
    tooling_failure: Boolean(result.spawn_error),
    ...(result.timed_out === true ? { timed_out: true } : {}),
  };
  const artifact = {
    version: 1,
    run_id: job.run_id ?? null,
    nonce: job.nonce ?? null,
    cache_key: job.cache_key ?? null,
    passed,
    duration_ms: durationMs,
    ...(result.timed_out === true ? { timed_out: true } : {}),
    verification,
    recorded_at: new Date().toISOString(),
  };
  await atomicWriteFile600(artifactFile, JSON.stringify(artifact)).catch(() => {});
  // Await any beat genuinely in flight across the stop — including one still
  // parked behind an injected test writer — BEFORE the removal below, so the
  // removal is provably this process's last write to heartbeatFile and no
  // beat can rename over or after it. `inFlight` is already catch-wrapped
  // (see startBeat above), so this can never itself throw and skip the `rm`.
  if (inFlight) await inFlight;
  await rm(heartbeatFile, { force: true }).catch(() => {});
}

// Engage CLI mode ONLY on the dedicated argv sentinel (never env alone), and
// only when this module IS the invoked main script (realpath'd STRING forms —
// never a URL object compared to a string). A normal import (the MCP server, a
// test) carries no sentinel, so this stays inert.
function invokedAsGateRunner() {
  if (!process.argv.includes(GATE_RUNNER_SENTINEL)) return false;
  if (!process.argv[1]) return false;
  try {
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (invokedAsGateRunner()) {
  runGateJob().finally(() => process.exit(0));
}
