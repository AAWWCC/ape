import { spawn } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

const repository = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const roots = [];
const requiredFile = '__tests__/runtime-v2-synthetic-canary.test.js';
const focusId = 'codex-dispatch-envelope';
const focusName = 'required suite required leaf';
const baselineFiles = [
  '__tests__/runtime-v2-operational-replay.test.js',
  '__tests__/runtime-v2-binding-probe.test.js',
  '__tests__/runtime-v2-codex-binding-seam.test.js',
  '__tests__/runtime-v2-history-explain.test.js',
];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function put(root, file, content) {
  await mkdir(path.dirname(path.join(root, file)), { recursive: true });
  await writeFile(path.join(root, file), content);
}

// Exercise the public CLI in an isolated repository. Every fault is synthetic;
// no assertion relies on a missing or broken test in the live checkout.
async function fixture({ source, fake = false } = {}) {
  const root = await mkdtemp(path.join(tmpdir(), 'ape-canary-execution-'));
  roots.push(root);
  await mkdir(path.join(root, 'scripts'));
  await copyFile(path.join(repository, 'scripts/run-operational-canaries.mjs'),
    path.join(root, 'scripts/run-operational-canaries.mjs'));
  const corpus = JSON.parse(await readFile(path.join(repository, 'evals/operational-replay-corpus.json'), 'utf8'));
  corpus.cases = corpus.cases.map((entry, index) => ({
    ...entry,
    test_file: requiredFile,
    // Keep a legacy anchor to demonstrate that comments or a prefix cannot
    // stand in for the exact current-run leaf identity.
    test_anchor: index === 0 ? 'required leaf' : `support ${index}`,
    test_names: [index === 0 ? focusName : `support ${index}`],
  }));
  await put(root, 'evals/operational-replay-corpus.json', JSON.stringify(corpus));
  await put(root, 'package.json', '{"type":"module"}');
  await put(root, 'vitest.config.mjs', 'export default { test: { maxWorkers: 1 } };');
  const support = corpus.cases.slice(1).map((entry) => `it(${JSON.stringify(entry.test_names[0])}, () => {});`).join('\n');
  await put(root, requiredFile, `import { describe, it, expect } from 'vitest';\n${source ?? "describe('required suite', () => { it('required leaf', () => {}); });"}\n${support}\n`);
  for (const file of baselineFiles) {
    await put(root, file, "import { it } from 'vitest'; it('baseline executes', () => {});\n");
  }
  if (fake) {
    await put(root, 'node_modules/vitest/vitest.mjs', fakeRunner);
  } else {
    await symlink(path.join(repository, 'node_modules'), path.join(root, 'node_modules'), 'dir');
  }
  return { root, corpus };
}

function run(root, mode = 'pass') {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(root, 'scripts/run-operational-canaries.mjs')], {
      cwd: root, env: { ...process.env, APE_SYNTHETIC_REPORT_MODE: mode },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    child.stdout.on('data', (chunk) => { output += chunk; });
    child.stderr.on('data', (chunk) => { output += chunk; });
    child.once('error', reject);
    child.once('close', (status, signal) => resolve({ status, signal, output }));
  });
}

function expectRejected(result, identity = focusName) {
  expect(result.status, result.output).not.toBe(0);
  expect(result.output).toContain(focusId);
  expect(result.output).toContain(requiredFile);
  expect(result.output).toContain(identity);
  expect(result.output).toMatch(/missing|skip|pending|not executed|not passed|absent|failed/i);
}

// The official JSON reporter's result shape, delivered by a synthetic child
// process at the CLI output boundary. This lets us corrupt a report AFTER test
// execution but BEFORE the assurance decision without patching live source.
const fakeRunner = String.raw`
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
const args = process.argv.slice(2);
const root = process.cwd();
const corpus = JSON.parse(readFileSync(path.join(root, 'evals/operational-replay-corpus.json'), 'utf8'));
const mode = process.env.APE_SYNTHETIC_REPORT_MODE;
const now = Date.now();
const files = [...new Set(corpus.cases.map((entry) => entry.test_file))];
const assertions = corpus.cases.flatMap((entry) => entry.test_names.map((fullName) => ({
  ancestorTitles: fullName === 'required suite required leaf' ? ['required suite'] : [],
  fullName, title: fullName === 'required suite required leaf' ? 'required leaf' : fullName,
  status: 'passed', failureMessages: [], duration: 1, startAt: now,
})));
const baselineResults = args.filter((arg) => arg.endsWith('.test.js') && !files.includes(arg)).map((file) => ({
  name: path.join(root, file), status: 'passed', startTime: now, endTime: now + 1, message: '',
  assertionResults: [{ ancestorTitles: [], fullName: 'baseline executes', title: 'baseline executes',
    status: 'passed', failureMessages: [], duration: 1, startAt: now }],
}));
let report = {
  numTotalTestSuites: files.length + baselineResults.length, numPassedTestSuites: files.length + baselineResults.length,
  numFailedTestSuites: 0, numPendingTestSuites: 0,
  numTotalTests: assertions.length + baselineResults.length, numPassedTests: assertions.length + baselineResults.length, numFailedTests: 0,
  numPendingTests: 0, numTodoTests: 0, startTime: now, success: true,
  testResults: [...files.map((file) => ({ name: path.join(root, file), status: 'passed',
    startTime: now, endTime: now + 1, message: '', assertionResults: assertions })), ...baselineResults],
};
if (mode === 'missing-leaf') report.testResults[0].assertionResults = assertions.slice(1);
if (mode === 'skipped-leaf') assertions[0].status = 'pending';
if (mode === 'failed-leaf') assertions[0].status = 'failed';
if (mode === 'failed-file') report.testResults[0].status = 'failed';
if (mode === 'failed-report') report.success = false;
if (mode === 'zero') { report.testResults = []; report.numPassedTests = 0; report.numTotalTests = 0; }
if (mode === 'wrong-file') report.testResults[0].name = path.join(root, '__tests__/runtime-v2-unrelated.test.js');
if (mode === 'incomplete') delete report.testResults[0].assertionResults;
if (mode === 'crash') process.exit(2);
const bytes = mode === 'malformed' ? '{truncated' : JSON.stringify(report);
const outputs = [];
for (let i = 0; i < args.length; i++) {
  if (/^--outputFile(?:\.json)?$/.test(args[i])) outputs.push(args[++i]);
  else if (/^--outputFile(?:\.json)?=/.test(args[i])) outputs.push(args[i].slice(args[i].indexOf('=') + 1));
}
writeFileSync(path.join(root, 'runner-args.json'), JSON.stringify(args));
if (mode !== 'absent') {
  for (const output of outputs) { mkdirSync(path.dirname(output), { recursive: true }); writeFileSync(output, bytes); }
  process.stdout.write(bytes + '\n');
}
`;

describe('operational canary execution proof', () => {
  it('accepts exact passing identities reported by the installed Vitest runner', async () => {
    const { root } = await fixture();
    const result = await run(root);
    expect(result.status, result.output).toBe(0);
  }, 30_000);

  it.each([
    ['comment-only anchor', "// it('required leaf', () => {});\nit('unrelated green', () => {});"],
    ['skipped leaf', "// it('required leaf', () => {});\ndescribe('required suite', () => { it.skip('required leaf', () => {}); });"],
    ['skipped parent', "describe.skip('required suite', () => { it('required leaf', () => {}); });"],
    ['prefix collision', "describe('required suite', () => { it('required leaf extra', () => {}); });"],
    ['wrong parent', "describe('unrelated suite', () => { it('required leaf', () => {}); });"],
    ['todo leaf', "// it('required leaf', () => {});\ndescribe('required suite', () => { it.todo('required leaf'); });"],
  ])('rejects %s despite other passing tests and identifies the requirement', async (_label, source) => {
    const { root } = await fixture({ source });
    expectRejected(await run(root));
  }, 30_000);

  it('requires every enumerated suite descendant even when its sibling passes', async () => {
    const { root, corpus } = await fixture();
    corpus.cases[0].test_names.push('required suite promised second leaf');
    await put(root, 'evals/operational-replay-corpus.json', JSON.stringify(corpus));
    expectRejected(await run(root), 'required suite promised second leaf');
  }, 30_000);

  it('refuses a legacy anchor-only inventory rather than treating source text as proof', async () => {
    const { root, corpus } = await fixture();
    for (const entry of corpus.cases) delete entry.test_names;
    await put(root, 'evals/operational-replay-corpus.json', JSON.stringify(corpus));
    const result = await run(root);
    expect(result.status, result.output).not.toBe(0);
    expect(result.output).toMatch(/inventory|schema|test_names|identit|require/i);
  }, 30_000);

  it('retains the replay and three baseline selections alongside coverage files', async () => {
    const { root } = await fixture({ fake: true });
    const result = await run(root);
    expect(result.status, result.output).toBe(0);
    const args = JSON.parse(await readFile(path.join(root, 'runner-args.json'), 'utf8'));
    expect(args).toEqual(expect.arrayContaining([...baselineFiles, requiredFile]));
  });

  it.each(['missing-leaf', 'skipped-leaf', 'failed-leaf', 'wrong-file'])(
    'rejects structured %s evidence despite exit zero', async (mode) => {
      const { root } = await fixture({ fake: true });
      expectRejected(await run(root, mode));
    },
  );

  it.each(['absent', 'malformed', 'incomplete', 'failed-file', 'failed-report', 'zero'])(
    'fails closed on %s reports even when the runner exits zero', async (mode) => {
      const { root } = await fixture({ fake: true });
      const result = await run(root, mode);
      expect(result.status, result.output).not.toBe(0);
      expect(result.output).toMatch(/operational-canary/i);
    },
  );

  it('cannot reuse a prior passing report after interruption or absent output', async () => {
    const { root } = await fixture({ fake: true });
    const first = await run(root);
    expect(first.status, first.output).toBe(0);
    expect((await run(root, 'crash')).status).not.toBe(0);
    const recovered = await run(root, 'absent');
    expect(recovered.status, recovered.output).not.toBe(0);
    const next = await run(root);
    expect(next.status, next.output).toBe(0);
  });

  it('keeps concurrent invocations independent when one report lacks a required leaf', async () => {
    const { root } = await fixture({ fake: true });
    const [good, bad] = await Promise.all([run(root), run(root, 'missing-leaf')]);
    expect(good.status, good.output).toBe(0);
    expectRejected(bad);
  });
});
