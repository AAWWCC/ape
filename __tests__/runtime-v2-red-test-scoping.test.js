import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { recordReceipt, startRun } from '../lib/runtime/service.js';
import { runtimePaths } from '../lib/runtime/paths.js';
import { atomicWriteJson } from '../lib/runtime/storage.js';
import { isPytestInvocation, targetedInvocation, templateInvocation } from '../lib/runtime/runner.js';

// D2 (red-test strict): a whole-suite failure is never proof an authored test
// is red. Runners without per-path selection (cargo/rake/maven/gradle) used to
// fall back to the entire default suite at red admission, so any unrelated
// pre-existing or flaky failure admitted a vacuous authored test as an
// observed red phase. Admission now refuses those runners unless the operator
// configures test_commands.targeted_template ('{paths}' receives the authored
// files), and pytest's documented non-verdict exits (5: nothing collected,
// 4: usage error) are refused instead of sealed as red.

const cleanups = [];
afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

function git(cwd, ...args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

// A scratch project driven entirely through the public surface: extra fixture
// files land in the baseline commit, config goes through the runtime config
// file, and admission is exercised via startRun + recordReceipt. Refusals for
// unscopeable runners fire before any spawn, so no real cargo/mvn/gradle/rake
// toolchain is ever needed; template runs use `node <fixture>.mjs` fakes.
async function project({ files = {}, config = {} } = {}) {
  const dir = await mkdtemp(path.join(tmpdir(), 'ape-red-scope-'));
  cleanups.push(dir);
  await mkdir(path.join(dir, 'src'));
  await mkdir(path.join(dir, 'tests'));
  await writeFile(path.join(dir, 'src', 'value.js'), 'export const value = 1;\n');
  for (const [file, content] of Object.entries(files)) {
    await writeFile(path.join(dir, file), content);
  }
  git(dir, 'init', '-q');
  git(dir, 'config', 'user.email', 'ape@example.test');
  git(dir, 'config', 'user.name', 'APE Test');
  git(dir, 'add', '.');
  git(dir, 'commit', '-qm', 'baseline');
  await atomicWriteJson(runtimePaths(dir).config, {
    shipping: { auto_merge: false, provider: 'github', required_remote_checks: false },
    test_commands: { full: 'node --test' },
    ...config,
  });
  return dir;
}

function startInput(overrides = {}) {
  return {
    objective: 'Exercise red-test scoping refusals and templates',
    mode: 'phase',
    lane: 'fast',
    host: 'codex',
    claimed_paths: ['src/value.js'],
    test_paths: ['tests/value.test.js'],
    requirements: [],
    risk_triggers: [],
    behavioral: true,
    hooks_trusted: true,
    subagents_available: true,
    explicit_invocation: true,
    ...overrides,
  };
}

function rawReceipt(ticket, overrides = {}) {
  return {
    ticket_id: ticket.ticket_id,
    status: 'passed',
    agent_identity: `agent-${ticket.role}`,
    tests: [{ command: 'self-reported', passed: false, exit_code: 1, duration_ms: 1 }],
    findings: [],
    evidence: { verdict: 'pass' },
    timing: {
      started_at: ticket.issued_at,
      completed_at: new Date(Date.parse(ticket.issued_at) + 10).toISOString(),
      duration_ms: 10,
    },
    ...overrides,
  };
}

function expectStructuredRedTestTicket(ticket, expectedTestPaths) {
  expect(ticket).toMatchObject({
    role: 'test_writer',
    objective: startInput().objective,
    required_checks: ['red-test'],
    test_paths: expectedTestPaths,
  });
  expect(ticket.output_schema.required).toContain('tests');
  expect(ticket.objective).not.toContain('Run objective:');
}

describe('red-test admission refuses runners it cannot scope (D2)', () => {
  it.each([
    ['rust', 'Cargo.toml', '[package]\nname = "fixture"\nversion = "0.0.0"\n', 'tests/it.rs'],
    ['ruby', 'Gemfile', 'source "https://rubygems.org"\n', 'tests/it_test.rb'],
    ['maven', 'pom.xml', '<project/>\n', 'tests/ItTest.java'],
    ['gradle', 'build.gradle', '// fixture\n', 'tests/ItTest.kt'],
  ])('%s: refuses before spawning, naming targeted_template', async (family, marker, content, authored) => {
    const dir = await project({ files: { [marker]: content } });
    const started = await startRun(dir, startInput({ test_paths: [authored] }));
    expect(started.ok).toBe(true);
    const ticket = started.run.tickets[0];
    expect(ticket.role).toBe('test_writer');
    expect(ticket.required_checks).toContain('red-test');

    await writeFile(path.join(dir, authored), '// authored test placeholder\n');
    const result = await recordReceipt(dir, rawReceipt(ticket));
    expect(result).toMatchObject({ ok: false, rejected: true });
    const message = result.errors.join(' ');
    expect(message).toMatch(new RegExp(`cannot scope the detected ${family} runner`));
    expect(message).toMatch(/whole-suite failure is not proof the authored test is red/);
    expect(message).toMatch(/test_commands\.targeted_template/);
    // The refusal precedes any spawn: a missing cargo/mvn/gradle/rake binary
    // would have surfaced as the tooling-failure no-verdict message instead.
    expect(message).not.toMatch(/did not produce a test verdict/);

    // Fail closed with no durable side effects: no receipt, no transaction.
    const paths = runtimePaths(dir);
    expect(await readdir(paths.receipts).catch(() => [])).toHaveLength(0);
    expect(await readdir(paths.receiptTransactions).catch(() => [])).toHaveLength(0);
  });

  it('keeps an unscopeable runner ticket structured and the objective immutable', async () => {
    const dir = await project({
      files: { 'Cargo.toml': '[package]\nname = "fixture"\nversion = "0.0.0"\n' },
    });
    const started = await startRun(dir, startInput({ test_paths: ['tests/it.rs'] }));
    expect(started.ok).toBe(true);
    expectStructuredRedTestTicket(started.run.tickets[0], ['tests/it.rs']);
  });

  it('keeps a scopeable runner ticket structured and the objective immutable', async () => {
    const dir = await project({
      files: { 'package.json': '{"name":"fixture","scripts":{"test":"node --test"}}\n' },
    });
    const started = await startRun(dir, startInput());
    expect(started.ok).toBe(true);
    expectStructuredRedTestTicket(started.run.tickets[0], ['tests/value.test.js']);
  });
});

// Runner guidance is provided by prompts and admission errors. Tickets keep
// the immutable run objective and carry the executable contract structurally.
describe('red-test tickets keep runner-independent structured transport', () => {
  it('uses the same contract for an npm-script project without targeted config', async () => {
    const dir = await project({
      files: { 'package.json': '{"name":"fixture","scripts":{"test":"node --test"}}\n' },
    });
    const started = await startRun(dir, startInput());
    expect(started.ok).toBe(true);
    expectStructuredRedTestTicket(started.run.tickets[0], ['tests/value.test.js']);
  });

  it('uses the same contract once test_commands.targeted_template is configured', async () => {
    const dir = await project({
      files: { 'package.json': '{"name":"fixture","scripts":{"test":"node --test"}}\n' },
      config: {
        test_commands: { full: 'node --test', targeted_template: 'node red-runner.mjs {paths}' },
      },
    });
    const started = await startRun(dir, startInput());
    expect(started.ok).toBe(true);
    expectStructuredRedTestTicket(started.run.tickets[0], ['tests/value.test.js']);
  });

  it.each([
    ['python', 'pytest.ini', '[pytest]\n', 'tests/test_it.py'],
    ['go', 'go.mod', 'module fixture\n\ngo 1.22\n', 'tests/it_test.go'],
  ])('uses the same contract for the per-path %s runner', async (family, marker, content, authored) => {
    const dir = await project({ files: { [marker]: content } });
    const started = await startRun(dir, startInput({ test_paths: [authored] }));
    expect(started.ok).toBe(true);
    expectStructuredRedTestTicket(started.run.tickets[0], [authored]);
  });

  it('uses the same contract for the unscopeable rust runner', async () => {
    const dir = await project({
      files: { 'Cargo.toml': '[package]\nname = "fixture"\nversion = "0.0.0"\n' },
    });
    const started = await startRun(dir, startInput({ test_paths: ['tests/it.rs'] }));
    expect(started.ok).toBe(true);
    expectStructuredRedTestTicket(started.run.tickets[0], ['tests/it.rs']);
  });
});

describe('test_commands.targeted_template drives scoped red execution', () => {
  it('renders {paths} into argv, observes red, and seals template provenance', async () => {
    const dir = await project({
      files: { 'red-runner.mjs': 'process.exit(1);\n' },
      config: {
        test_commands: { full: 'node --test', targeted_template: 'node red-runner.mjs {paths}' },
      },
    });
    const started = await startRun(dir, startInput());
    const ticket = started.run.tickets[0];

    await writeFile(path.join(dir, 'tests', 'value.test.js'), 'throw new Error("red");\n');
    const result = await recordReceipt(dir, rawReceipt(ticket));
    expect(result.ok).toBe(true);
    expect(result.receipt.evidence.red_test).toMatchObject({
      observed: true,
      template: true,
      command: 'node red-runner.mjs tests/value.test.js',
      test_paths: ['tests/value.test.js'],
      passed: false,
      exit_code: 1,
      tree_sha: result.receipt.head_tree_sha,
    });
    expect(result.receipt.evidence.red_test.derived).toBeUndefined();
    expect(result.receipt.evidence.red_test.configured).toBeUndefined();
  });

  it('substitutes an embedded {paths} token in place (TEST={paths})', async () => {
    const dir = await project({
      files: { 'red-runner.mjs': 'process.exit(1);\n' },
      config: {
        test_commands: {
          full: 'node --test',
          targeted_template: 'node red-runner.mjs TEST={paths}',
        },
      },
    });
    const started = await startRun(dir, startInput());
    const ticket = started.run.tickets[0];

    await writeFile(path.join(dir, 'tests', 'value.test.js'), 'throw new Error("red");\n');
    const result = await recordReceipt(dir, rawReceipt(ticket));
    expect(result.ok).toBe(true);
    expect(result.receipt.evidence.red_test.command).toBe(
      'node red-runner.mjs TEST=tests/value.test.js',
    );
  });

  it('refuses a template that never mentions {paths}', async () => {
    const dir = await project({
      files: { 'red-runner.mjs': 'process.exit(1);\n' },
      config: {
        test_commands: { full: 'node --test', targeted_template: 'node red-runner.mjs' },
      },
    });
    const started = await startRun(dir, startInput());
    const ticket = started.run.tickets[0];

    await writeFile(path.join(dir, 'tests', 'value.test.js'), 'throw new Error("red");\n');
    const result = await recordReceipt(dir, rawReceipt(ticket));
    expect(result).toMatchObject({ ok: false, rejected: true });
    expect(result.errors.join(' ')).toMatch(/must contain the \{paths\} placeholder/);
  });

  it('a template run that exits 0 is not an observed red phase', async () => {
    const dir = await project({
      files: { 'green-runner.mjs': 'process.exit(0);\n' },
      config: {
        test_commands: { full: 'node --test', targeted_template: 'node green-runner.mjs {paths}' },
      },
    });
    const started = await startRun(dir, startInput());
    const ticket = started.run.tickets[0];

    await writeFile(path.join(dir, 'tests', 'value.test.js'), 'throw new Error("red");\n');
    const result = await recordReceipt(dir, rawReceipt(ticket));
    expect(result).toMatchObject({ ok: false, rejected: true });
    expect(result.errors.join(' ')).toMatch(/red phase was not observed/);
  });
});

describe('pytest non-verdict exit codes are refused, scoped to pytest only', () => {
  it('exit 5 from a pytest invocation is "no tests collected", never red', async () => {
    const dir = await project({
      files: { 'pytest.mjs': 'process.exit(5);\n' },
      config: {
        test_commands: { full: 'node --test', targeted_template: 'node pytest.mjs {paths}' },
      },
    });
    const started = await startRun(dir, startInput());
    const ticket = started.run.tickets[0];

    await writeFile(path.join(dir, 'tests', 'value.test.js'), 'throw new Error("red");\n');
    const result = await recordReceipt(dir, rawReceipt(ticket));
    expect(result).toMatchObject({ ok: false, rejected: true });
    expect(result.errors.join(' ')).toMatch(/collected no tests \(exit 5\)/);
    expect(result.errors.join(' ')).toMatch(/red phase was not observed/);
  });

  it('exit 5 from a non-pytest runner stays an ordinary red verdict (rule must not over-fire)', async () => {
    const dir = await project({
      files: { 'runner.mjs': 'process.exit(5);\n' },
      config: {
        test_commands: { full: 'node --test', targeted_template: 'node runner.mjs {paths}' },
      },
    });
    const started = await startRun(dir, startInput());
    const ticket = started.run.tickets[0];

    await writeFile(path.join(dir, 'tests', 'value.test.js'), 'throw new Error("red");\n');
    const result = await recordReceipt(dir, rawReceipt(ticket));
    expect(result.ok).toBe(true);
    expect(result.receipt.evidence.red_test).toMatchObject({ observed: true, exit_code: 5 });
  });

  it('exit 4 from a pytest invocation is a usage error, never red', async () => {
    const dir = await project({
      files: { 'pytest.mjs': 'process.exit(4);\n' },
      config: {
        test_commands: { full: 'node --test', targeted_template: 'node pytest.mjs {paths}' },
      },
    });
    const started = await startRun(dir, startInput());
    const ticket = started.run.tickets[0];

    await writeFile(path.join(dir, 'tests', 'value.test.js'), 'throw new Error("red");\n');
    const result = await recordReceipt(dir, rawReceipt(ticket));
    expect(result).toMatchObject({ ok: false, rejected: true });
    expect(result.errors.join(' ')).toMatch(/usage error \(exit 4\)/);
  });
});

describe('invocation derivation units', () => {
  it('marks per-path runners scoped and suite-only runners unscoped', () => {
    const scoped = [
      { runner: 'script-test', command: 'script/test', args: [] },
      { runner: 'python', command: 'python3', args: ['-m', 'pytest'] },
      { runner: 'python-uv', command: 'uv', args: ['run', 'pytest'] },
      { runner: 'javascript', command: 'npm', args: ['test'] },
    ];
    for (const runner of scoped) {
      expect(targetedInvocation(runner, ['tests/a.test.js']).scoped).toBe(true);
    }
    const unscoped = [
      { runner: 'rust', command: 'cargo', args: ['test'] },
      { runner: 'ruby', command: 'bundle', args: ['exec', 'rake', 'test'] },
      { runner: 'maven', command: 'mvn', args: ['test'] },
      { runner: 'gradle', command: 'gradle', args: ['test'] },
    ];
    for (const runner of unscoped) {
      const invocation = targetedInvocation(runner, ['tests/a.test.js']);
      expect(invocation.scoped).toBe(false);
      // The suite superset stays derivable for pass-required gates.
      expect(invocation.command).toBe(runner.command);
    }
  });

  it('go maps a root-level test to the root package, never the whole module', () => {
    const runner = { runner: 'go', command: 'go', args: ['test', './...'] };
    expect(targetedInvocation(runner, ['main_test.go'])).toMatchObject({
      args: ['test', '.'],
      scoped: true,
    });
    expect(targetedInvocation(runner, ['pkg/util/util_test.go'])).toMatchObject({
      args: ['test', './pkg/util'],
      scoped: true,
    });
  });

  it('templateInvocation expands at argv level and keeps spaced paths intact', () => {
    expect(templateInvocation('run {paths} --red', ['b.test.js', 'a dir/x.test.js'])).toEqual({
      command: 'run',
      args: ['a dir/x.test.js', 'b.test.js', '--red'],
      scoped: true,
      template: true,
    });
    expect(templateInvocation('rake test TEST={paths}', ['t/b.rb', 't/a.rb'])).toEqual({
      command: 'rake',
      args: ['test', 'TEST=t/a.rb t/b.rb'],
      scoped: true,
      template: true,
    });
    expect(templateInvocation('cargo test', ['t/a.rs'])).toBeNull();
  });

  it('isPytestInvocation matches families, basenames, and -m pytest; nothing else', () => {
    expect(isPytestInvocation('python', ['anything'])).toBe(true);
    expect(isPytestInvocation('python-uv', [])).toBe(true);
    expect(isPytestInvocation(null, ['pytest', 'tests/x.py'])).toBe(true);
    expect(isPytestInvocation(null, ['/usr/bin/py.test'])).toBe(true);
    expect(isPytestInvocation(null, ['C:\\python\\pytest.exe'])).toBe(true);
    expect(isPytestInvocation(null, ['python3', '-m', 'pytest', 'tests'])).toBe(true);
    expect(isPytestInvocation(null, ['uv', 'run', 'pytest', 'tests/x.py'])).toBe(true);
    expect(isPytestInvocation(null, ['node', 'runner.mjs'])).toBe(false);
    expect(isPytestInvocation(null, ['cargo', 'test'])).toBe(false);
    expect(isPytestInvocation('override', ['-m', 'unittest'])).toBe(false);
  });
});
