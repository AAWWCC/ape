import { execFileSync, spawn } from 'node:child_process';
import { access, link, mkdir, mkdtemp, readFile, readdir, rm, utimes, writeFile } from 'node:fs/promises';
import { hostname, tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { startGateSuite, pollGateSuite } from '../lib/runtime/gates.js';
import { currentTreeSha } from '../lib/runtime/git.js';
import { runtimePaths } from '../lib/runtime/paths.js';
import { atomicWriteJson } from '../lib/runtime/storage.js';
import { spawnWithTimeout } from '../lib/runtime/spawn.js';
import { withReceiptLock } from '../lib/runtime/service.js';

// All executable fixtures are synthetic and live outside the governed project.
// No assertion reads production source. The only intercepted runtime sink is
// the final rename of a complete state file, after its validation and fsync.
// Suites, runners, supervision, locks, receipt replay and recovery remain real.
const runtime = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../lib/runtime');
const moduleUrl = (name) => pathToFileURL(path.join(runtime, name)).href;
const roots = [];
const children = [];
let invocationSequence = 0;
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const exists = (file) => access(file).then(() => true, () => false);
const json = (file) => readFile(file, 'utf8').then(JSON.parse);
function alive(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 1) return false;
  try { process.kill(pid, 0); return true; } catch (error) { return error.code === 'EPERM'; }
}
async function until(check, label, timeout = 20_000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    const value = await check();
    if (value) return value;
    await delay(25);
  }
  throw new Error(`Fixture did not reach ${label}`);
}
async function records(f) {
  const names = await readdir(f.outside);
  return Promise.all(names.filter((name) => /^suite-\d+\.json$/.test(name)).map((name) => json(path.join(f.outside, name))));
}
async function members(f) {
  return (await records(f)).flatMap((row) => [row.pid, row.descendant]);
}
afterEach(async () => {
  // Fallback cleanup is deliberately last. No assertion below obtains its
  // retirement evidence from these signals, and each suite has a bounded TTL.
  for (const child of children.splice(0)) {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  }
  for (const f of roots.splice(0)) {
    for (const pid of await members(f).catch(() => [])) {
      try { process.kill(pid, 'SIGKILL'); } catch {}
    }
    for (const file of await readdir(path.join(f.paths.runtime, 'gate-suite')).catch(() => [])) {
      if (file.endsWith('.json')) {
        const record = await json(path.join(f.paths.runtime, 'gate-suite', file)).catch(() => null);
        if (Number.isSafeInteger(record?.broker_pid) && record.broker_pid > 1) {
          try { process.kill(record.broker_pid, 'SIGKILL'); } catch {}
        }
      }
      if (!file.endsWith('.heartbeat')) continue;
      const beat = await json(path.join(f.paths.runtime, 'gate-suite', file)).catch(() => null);
      if (beat && alive(beat.pid)) { try { process.kill(beat.pid, 'SIGKILL'); } catch {} }
    }
    await rm(f.base, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  }
});

const suiteSource = String.raw`
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const [outside, label = 'one'] = process.argv.slice(2);
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };
const entry = path.join(outside, 'entry-' + process.pid + '.json');
fs.writeFileSync(entry + '.tmp', JSON.stringify({pid:process.pid}));
fs.renameSync(entry + '.tmp', entry);
const prior = fs.readdirSync(outside).filter((name) => /^suite-\d+\.json$/.test(name))
  .map((name) => JSON.parse(fs.readFileSync(path.join(outside, name), 'utf8')));
const starting = fs.readdirSync(outside).filter((name) => /^entry-\d+\.json$/.test(name))
  .map((name) => JSON.parse(fs.readFileSync(path.join(outside, name), 'utf8')))
  .filter((row) => row.pid !== process.pid && alive(row.pid)).map((row) => row.pid);
const overlapping = [...new Set([...starting, ...prior.filter((row) => alive(row.pid) || alive(row.descendant)).map((row) => row.pid)])];
const child = spawn(process.execPath, [path.join(outside, 'descendant.cjs'), outside], { stdio: 'ignore' });
process.on('SIGTERM', () => {});
const timer = setInterval(() => {
  if (!fs.existsSync(path.join(outside, 'descendant-' + child.pid + '.ready'))) return;
  const record = path.join(outside, 'suite-' + process.pid + '.json');
  if (!fs.existsSync(record)) {
    fs.writeFileSync(record + '.tmp', JSON.stringify({ pid: process.pid, descendant: child.pid, label, overlapping, cwd: process.cwd() }));
    fs.renameSync(record + '.tmp', record);
  }
  if (fs.existsSync(path.join(outside, label + '.release'))) {
    clearInterval(timer);
    // Leave the ordinary child alive, with all output pipes closed. A passing
    // suite result is safe only after supervision proves its retirement.
    process.exit(0);
  }
}, 20);
setTimeout(() => process.exit(93), 90_000);
`;
const descendantSource = String.raw`
const fs = require('node:fs');
const path = require('node:path');
const outside = process.argv[2];
process.on('SIGTERM', () => {});
fs.writeFileSync(path.join(outside, 'descendant-' + process.pid + '.ready'), 'ready');
setInterval(() => fs.appendFileSync(path.join(outside, 'descendant-' + process.pid + '.beats'), 'x'), 20);
setTimeout(() => process.exit(94), 90_000);
`;

async function fixture(options = {}) {
  const base = await mkdtemp(path.join(tmpdir(), 'ape durable ownership '));
  const project = path.join(base, 'project');
  const outside = path.join(base, 'outside');
  await mkdir(path.join(project, 'notes'), { recursive: true });
  await mkdir(outside);
  await writeFile(path.join(project, 'notes/note.md'), '# note\n');
  const git = (...args) => execFileSync('git', args, { cwd: project, encoding: 'utf8', env: {
    ...process.env, GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null',
    GIT_CONFIG_SYSTEM: process.platform === 'win32' ? 'NUL' : '/dev/null',
  } });
  git('init', '-q');
  git('symbolic-ref', 'HEAD', 'refs/heads/main');
  git('config', 'user.email', 'ape@example.test');
  git('config', 'user.name', 'APE Test');
  git('config', 'commit.gpgsign', 'false');
  git('add', '.');
  git('commit', '-qm', 'fixture');
  git('remote', 'add', 'origin', 'https://github.com/acme/repo.git');
  git('update-ref', 'refs/remotes/origin/main', 'HEAD');
  git('symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/main');
  const paths = runtimePaths(project);
  const f = { base, project, outside, paths, git };
  roots.push(f);
  await writeFile(path.join(outside, 'suite.cjs'), suiteSource);
  await writeFile(path.join(outside, 'descendant.cjs'), descendantSource);
  const command = (label) => `node "${path.join(outside, 'suite.cjs')}" "${outside}" ${label}`;
  f.command = command;
  f.config = { shipping: { auto_merge: false, provider: 'github', required_remote_checks: false,
    target: { origin: 'https://github.com/acme/repo.git', repository: 'acme/repo', base: 'main' } },
  policy: { full_suite_cache: false }, gates: { inline_grace_ms: options.grace ?? 0, heartbeat_ms: 50 },
  deadlines_ms: { mechanical: 60_000 }, test_commands: { full: command('one') } };
  await atomicWriteJson(paths.config, f.config);
  f.tree = await currentTreeSha(project);
  f.state = { version: 2, schema_version: '2.0.0', run_id: 'run-durable-fixture', mode: 'phase',
    lane: 'mechanical', requested_lane: 'mechanical', status: 'blocked', stage: 'gates',
    block_reason: 'one or more deterministic merge gates failed', objective: 'Prove launch ownership',
    host: 'codex', behavioral: false, high_risk: false, policy: {}, claimed_paths: ['notes/note.md'],
    test_paths: [], requirements: [], risk_triggers: [], branch: 'main', base_commit_sha: git('rev-parse', 'HEAD').trim(),
    tickets: [], attempts: {}, remediation_cycles: 0, regate_attempts: 0,
    tree_sha: f.tree, gates: { passed: false, tree_sha: f.tree },
    created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
    receipts: [{ receipt_hash: 'a', previous_receipt_hash: null, status: 'passed',
      agent: { host: 'codex', role: 'implementer' }, tests: [{ passed: true }],
      changed_files: ['notes/note.md'], head_tree_sha: f.tree }] };
  return f;
}

// The loader substitutes only remote GitHub work. The frozen-target validator,
// admission digest, local Git, actual gate launches and all OS containment run
// unchanged. An unexpected GitHub side effect is therefore never sent.
async function serviceHarness(f) {
  const loader = `
const spawnUrl = ${JSON.stringify(moduleUrl('spawn.js'))};
const gatesUrl = ${JSON.stringify(moduleUrl('gates.js'))};
export async function load(url, context, next) {
  if (url === spawnUrl) return { format: 'module', shortCircuit: true, source:
    'export * from ' + JSON.stringify(url + '?fixture-real') + '; import { spawnWithTimeout as real } from ' + JSON.stringify(url + '?fixture-real') + ';' +
    'export function spawnWithTimeout(command, args, options) { if (command !== "gh") return real(command, args, options); if (!(args[0] === "--version" || (args[0] === "api" && args[1] === "repos/acme/repo"))) throw new Error("unexpected offline GitHub call"); return Promise.resolve({exit_code:0,timed_out:false,spawn_error:null,combined:args[0] === "--version" ? "gh version offline" : JSON.stringify({full_name:"acme/repo",archived:false,disabled:false,permissions:{pull:true,push:true},allow_squash_merge:true})}); }' };
  if (url === gatesUrl) return { format: 'module', shortCircuit: true, source:
    'export * from ' + JSON.stringify(url + '?fixture-real') + '; export async function autoMergeGithub() { return {url:"https://github.com/acme/repo/pull/1",sha:"' + 'f'.repeat(40) + '",method:"squash"}; }' };
  return next(url, context);
}
`;
  await writeFile(path.join(f.outside, 'offline-loader.mjs'), loader);
  const owner = `
import fs from 'node:fs';
import path from 'node:path';
import { syncBuiltinESMExports, register } from 'node:module';
import { pathToFileURL } from 'node:url';
const request = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
register(pathToFileURL(path.join(request.outside, 'offline-loader.mjs')));
const service = await import(${JSON.stringify(moduleUrl('service.js'))});
const { runtimePaths } = await import(${JSON.stringify(moduleUrl('paths.js'))});
const { atomicWriteJson } = await import(${JSON.stringify(moduleUrl('storage.js'))});
const { sha256 } = await import(${JSON.stringify(moduleUrl('canonical.js'))});
const { admittedStartIdentityHash } = await import(${JSON.stringify(moduleUrl('admitted-start-identity.js'))});
const paths = runtimePaths(request.project);
let armed = false, tripped = false;
const rename = fs.promises.rename.bind(fs.promises);
fs.promises.rename = async (from, to, ...rest) => {
  const target = String(to);
  const selected = request.sink === 'run' ? target.startsWith(paths.runs + path.sep) : target === paths.active;
  if (armed && !tripped && selected && target.endsWith('.json')) {
    const state = JSON.parse(fs.readFileSync(from, 'utf8'));
    const boundary = request.consume ? state.gates?.checks?.full_suite?.passed === true :
      state.gates_watch?.pid > 1 && (!request.secondRunner || state.gates_watch.runner_index === 1);
    if (boundary) {
      tripped = true;
      const end = Date.now() + 20000;
      while (!fs.readdirSync(request.outside).filter((name) => /^suite-\\d+\\.json$/.test(name)).some((name) => !request.secondRunner || JSON.parse(fs.readFileSync(path.join(request.outside, name), 'utf8')).label === 'two')) {
        if (Date.now() > end) throw new Error('suite never reached the state-publication barrier');
        await new Promise((r) => setTimeout(r, 20));
      }
      const barrier = path.join(request.outside, 'publication-barrier.json');
      fs.writeFileSync(barrier + '.tmp', JSON.stringify({ owner: process.pid, watch: state.gates_watch, sink: target, gates: state.gates }));
      fs.renameSync(barrier + '.tmp', barrier);
      if (request.fault === 'write-failure') throw Object.assign(new Error('fixture state publication EIO'), {code:'EIO'});
      // Keep the owner alive while the parent checks all three process roles,
      // then SIGKILL only the owner. No normal exit/finally can hide the gap.
      await new Promise(() => { setInterval(() => {}, 1000); });
    }
  }
  return rename(from, to, ...rest);
};
syncBuiltinESMExports();
try {
  let result;
  if (request.action === 'launch') {
    if (request.entry === 'receipt') {
      const started = await service.startRun(request.project, { objective:'Update the note', mode:'phase', lane:'mechanical', host:'codex', claimed_paths:['notes/note.md'], test_paths:[], requirements:[], risk_triggers:[], behavioral:false, hooks_trusted:true, subagents_available:true, explicit_invocation:true });
      if (!started.ok) throw new Error(JSON.stringify(started));
      const build = started.run.tickets[0];
      fs.writeFileSync(path.join(request.project, 'notes/note.md'), '# note\\nUpdated.\\n');
      const receipt = { ticket_id:build.ticket_id,status:'passed',agent_identity:'agent-implementer',tests:[{command:'node --version',passed:true,exit_code:0,duration_ms:1}],findings:[],evidence:{verdict:'pass'},timing:{started_at:build.issued_at,completed_at:new Date(Date.parse(build.issued_at)+10).toISOString(),duration_ms:10} };
      fs.writeFileSync(path.join(request.outside, 'receipt.json'), JSON.stringify(receipt));
      armed = true;
      result = await service.recordReceipt(request.project, receipt);
    } else {
      let state = request.state;
      if (request.entry === 'ship') {
        state.stage = 'merge'; state.block_reason = 'auto-merge is disabled by configuration'; state.gates.passed = true;
        state.base_branch = 'main'; state.start_request_hash = 'a'.repeat(64); state.admitted_start_identity_version = 1;
        state.shipping_target = {version:1,provider:'github',origin:'https://github.com/acme/repo.git',repository:'acme/repo',base:'main',required_remote_checks:false};
        const manifest = {version:1,ready:true,shipping_target:state.shipping_target,repository:{base_branch:state.base_branch,base_commit:state.base_commit_sha}};
        state.admission = {version:1,manifest,digest:sha256(manifest)};
        state.admitted_start_identity_hash = admittedStartIdentityHash(state);
      }
      await atomicWriteJson(paths.active, state);
      armed = true;
      result = request.entry === 'ship' ? await service.shipRun(request.project, 'fixture explicit ship') : await service.regateRun(request.project);
    }
  } else if (request.action === 'abort') {
    result = await service.abortRun(request.project, 'fixture explicit abort');
  } else if (request.action === 'resume') {
    result = await service.resumeRun(request.project);
  } else if (request.action === 'regate') {
    result = await service.regateRun(request.project);
  } else if (request.action === 'ship') {
    result = await service.shipRun(request.project, 'fixture post-abort ship');
  } else if (request.action === 'recover') {
    // Ordinary stale-lock recovery and public API replay; never repair or
    // erase a lock, journal, watch, heartbeat or result in the fixture.
    await service.resumeRun(request.project);
    const state = JSON.parse(fs.readFileSync(paths.active, 'utf8'));
    if (request.entry === 'receipt') result = await service.recordReceipt(request.project, JSON.parse(fs.readFileSync(path.join(request.outside, 'receipt.json'), 'utf8')));
    else if (state.status === 'blocked') result = request.entry === 'ship' ? await service.shipRun(request.project, 'fixture recovery ship') : await service.regateRun(request.project);
    else result = await service.nextRun(request.project);
  } else result = await service.nextRun(request.project);
  if ((request.secondRunner || request.consume) && request.action === 'launch') {
    fs.writeFileSync(path.join(request.outside, 'one.release'), 'go');
    for (let attempts = 0; attempts < 400; attempts++) {
      result = await service.nextRun(request.project);
      await new Promise((r) => setTimeout(r, 25));
    }
    throw new Error('second runner did not reach publication barrier');
  }
  fs.writeFileSync(request.response + '.tmp', JSON.stringify({result}));
} catch(error) { fs.writeFileSync(request.response + '.tmp', JSON.stringify({error:error.message,code:error.code})); }
fs.renameSync(request.response + '.tmp', request.response);
process.exit(0);
`;
  await writeFile(path.join(f.outside, 'owner.mjs'), owner);
}

async function invoke(f, request, childEnv = {}) {
  const id = `${Date.now()}-${invocationSequence++}`;
  const response = path.join(f.outside, `${id}.response.json`);
  const input = path.join(f.outside, `${id}.request.json`);
  await writeFile(input, JSON.stringify({ project: f.project, outside: f.outside, state: f.state, response, ...request }));
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (/^(APE_|CODEX_CWD$|CLAUDE_PROJECT_DIR$|NODE_OPTIONS$)/.test(key)) delete env[key];
  Object.assign(env, childEnv);
  const child = spawn(process.execPath, [path.join(f.outside, 'owner.mjs'), input], { cwd: f.project, env, stdio: ['ignore', 'ignore', 'pipe'] });
  children.push(child);
  let stderr = '';
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  const exited = new Promise((resolve, reject) => { child.once('exit', resolve); child.once('error', reject); });
  return { child, exited, response, result: async () => {
    await until(() => exists(response), `service response (${stderr})`);
    return json(response);
  } };
}
async function expectNoOverlap(f) {
  const rows = await records(f);
  expect(rows.length).toBeGreaterThan(0);
  for (const row of rows) expect(row.overlapping, `generation ${row.pid} launched while old suite/descendant lived`).toEqual([]);
  expect(rows.filter((row) => alive(row.pid) || alive(row.descendant)).length).toBeLessThanOrEqual(1);
}
function safeArtifactDiagnostic(artifact) {
  if (!artifact) return null;
  const verification = artifact.verification;
  return { run_id: artifact.run_id, nonce: artifact.nonce, cache_key: artifact.cache_key,
    passed: artifact.passed, verification: verification && { exit_code: verification.exit_code,
      tooling_failure: verification.tooling_failure, timed_out: verification.timed_out, aborted: verification.aborted } };
}
async function finishService(f, entry) {
  await writeFile(path.join(f.outside, 'one.release'), 'go');
  await writeFile(path.join(f.outside, 'two.release'), 'go');
  const end = Date.now() + 25_000;
  let state;
  const observations = [];
  while (Date.now() < end) {
    const poll = await invoke(f, { action: 'next', entry });
    const response = await poll.result();
    expect(response.error).toBeUndefined();
    await poll.exited;
    state = await json(f.paths.active);
    observations.push({ status: state.status, cause: state.block_reason, run_id: state.run_id,
      nonce: state.gates_watch?.nonce,
      full_suite: safeArtifactDiagnostic(state.gates?.checks?.full_suite),
      summaries: response.result?.actions?.map((action) => action.summary).filter(Boolean),
      last_summary: state.gates_watch?.last_summary });
    if (observations.length > 8) observations.shift();
    if (state.gates?.checks?.full_suite?.passed === true && state.status !== 'gating') break;
    await delay(50);
  }
  if (state.gates?.checks?.full_suite?.passed !== true) {
    // Capture only non-secret ownership/proof fields before fallback cleanup.
    // Keep the original deadline and passing assertion; this diagnoses a real
    // recovery stall without turning a retry into acceptance.
    const files = await readdir(path.join(f.paths.runtime, 'gate-suite')).catch(() => []);
    const evidence = [];
    for (const file of files.filter((name) => /\.(ownership|proof)\.json$/.test(name))) {
      const record = await json(path.join(f.paths.runtime, 'gate-suite', file)).catch(() => null);
      evidence.push({ status: record?.phase, nonce: record?.generation,
        cleanup: record?.payload?.cleanup && { status: record.payload.cleanup.status, cause: record.payload.cleanup.cause },
        retry: record?.payload?.retry, artifact: safeArtifactDiagnostic(record?.payload?.artifact) });
    }
    expect(state.gates?.checks?.full_suite?.passed, JSON.stringify({ observations, evidence })).toBe(true);
  }
  await expectNoOverlap(f);
  await until(async () => (await members(f)).every((pid) => !alive(pid)), 'confirmed descendant retirement');
}

describe('durable gate ownership at the state-publication sink (native)', () => {
  it.each(['receipt', 'regate', 'ship'])('abort retires unpublished %s work and stays sealed through every recovery entry', async (entry) => {
    const f = await fixture();
    if (entry === 'ship') {
      f.state.branch = 'ape/phase-durable-fixture';
      f.git('switch', '-c', f.state.branch, f.state.base_commit_sha, '--no-track');
    }
    await serviceHarness(f);
    const owner = await invoke(f, { action: 'launch', entry, sink: 'active', fault: 'crash' });
    const barrierFile = path.join(f.outside, 'publication-barrier.json');
    await until(() => exists(barrierFile), 'unpublished work before abort');
    const barrier = await json(barrierFile);
    const first = (await records(f))[0];
    for (const pid of [barrier.watch.pid, first.pid, first.descendant]) expect(alive(pid)).toBe(true);
    expect((await json(f.paths.active)).gates_watch?.nonce).not.toBe(barrier.watch.nonce);
    owner.child.kill('SIGKILL');
    await owner.exited;
    const abort = await invoke(f, { action: 'abort' });
    const response = await abort.result();
    expect(response.error).toBeUndefined();
    expect(response.result.ok).toBe(true);
    await abort.exited;
    expect((await json(f.paths.active)).status).toBe('aborted');
    await until(() => [barrier.watch.pid, first.pid, first.descendant].every((pid) => !alive(pid)),
      'abort retirement of unpublished runner, suite and descendant');
    for (const action of ['next', 'resume', 'regate', 'ship']) {
      const recovery = await invoke(f, { action });
      expect((await recovery.result()).error).toBeUndefined();
      await recovery.exited;
      expect((await json(f.paths.active)).status, `${action} must preserve the explicit abort`).toBe('aborted');
      expect(await records(f), `${action} must not start a replacement`).toHaveLength(1);
    }
    await expectNoOverlap(f);
  }, 80_000);

  it('keeps an abort sealed and ownership recoverable when unpublished retirement cannot be authenticated', async () => {
    const f = await fixture();
    await serviceHarness(f);
    const owner = await invoke(f, { action: 'launch', entry: 'receipt', sink: 'active', fault: 'crash' });
    const barrierFile = path.join(f.outside, 'publication-barrier.json');
    await until(() => exists(barrierFile), 'unpublished work before broker loss');
    const barrier = await json(barrierFile);
    const first = (await records(f))[0];
    for (const pid of [barrier.watch.pid, first.pid, first.descendant]) expect(alive(pid)).toBe(true);
    const ownership = await json(barrier.watch.ownership_file);
    owner.child.kill('SIGKILL');
    await owner.exited;
    process.kill(ownership.broker_pid, 'SIGKILL');
    await until(() => !alive(ownership.broker_pid), 'broker loss before abort');
    const abort = await invoke(f, { action: 'abort' });
    expect((await abort.result()).error).toBeUndefined();
    await abort.exited;
    expect((await json(f.paths.active)).status).toBe('aborted');
    for (const action of ['next', 'resume', 'regate', 'ship']) {
      const recovery = await invoke(f, { action });
      expect((await recovery.result()).error).toBeUndefined();
      await recovery.exited;
      expect((await json(f.paths.active)).status).toBe('aborted');
      expect(await records(f)).toHaveLength(1);
      const retained = await json(barrier.watch.ownership_file);
      expect(retained.generation).toBe(ownership.generation);
      expect(retained.phase, 'unknown retirement cannot be acknowledged as consumed').not.toBe('consumed');
      expect(await exists(barrier.watch.job_file)).toBe(true);
    }
    await expectNoOverlap(f);
  }, 80_000);

  it.each(['run', 'active'])('replays confirmed result consumption after the %s state sink crashes', async (sink) => {
    const f = await fixture();
    await serviceHarness(f);
    const owner = await invoke(f, { action: 'launch', entry: 'receipt', sink, fault: 'crash', consume: true });
    const barrierFile = path.join(f.outside, 'publication-barrier.json');
    await until(() => exists(barrierFile), 'confirmed result consumption');
    const barrier = await json(barrierFile);
    expect(barrier.gates.checks.full_suite.passed).toBe(true);
    expect(await records(f)).toHaveLength(1);
    expect((await members(f)).every((pid) => !alive(pid)), 'consumption may follow only confirmed retirement').toBe(true);
    owner.child.kill('SIGKILL');
    await owner.exited;
    const recovery = await invoke(f, { action: 'recover', entry: 'receipt' });
    expect((await recovery.result()).error).toBeUndefined();
    await recovery.exited;
    await finishService(f, 'receipt');
    expect(await records(f), 'replayed consumption must not run an already proven suite twice').toHaveLength(1);
  }, 70_000);

  it('recovers a second-runner owner crash without repeating the consumed first result', async () => {
    const f = await fixture();
    f.config.runners = [
      { id: 'a', root: '.', owns: ['notes/**'], profile: { full: f.command('one') } },
      { id: 'b', root: '.', owns: ['notes/**'], profile: { full: f.command('two') } },
    ];
    await atomicWriteJson(f.paths.config, f.config);
    await serviceHarness(f);
    const owner = await invoke(f, { action: 'launch', entry: 'regate', sink: 'active', fault: 'crash', secondRunner: true });
    const barrierFile = path.join(f.outside, 'publication-barrier.json');
    await until(() => exists(barrierFile), 'second-runner publication');
    const barrier = await json(barrierFile);
    const rows = await records(f);
    expect(rows.map((row) => row.label).sort()).toEqual(['one', 'two']);
    const first = rows.find((row) => row.label === 'one');
    const second = rows.find((row) => row.label === 'two');
    expect(alive(first.pid)).toBe(false);
    expect(alive(first.descendant)).toBe(false);
    expect(alive(second.pid)).toBe(true);
    expect(alive(second.descendant)).toBe(true);
    expect(alive(barrier.watch.pid)).toBe(true);
    owner.child.kill('SIGKILL');
    await owner.exited;
    const recovery = await invoke(f, { action: 'recover', entry: 'regate' });
    expect((await recovery.result()).error).toBeUndefined();
    await recovery.exited;
    await expectNoOverlap(f);
    await finishService(f, 'regate');
    expect((await records(f)).filter((row) => row.label === 'one')).toHaveLength(1);
    const state = await json(f.paths.active);
    expect(state.gates.checks.full_suite.runners).toEqual([
      expect.objectContaining({ id: 'a', passed: true }), expect.objectContaining({ id: 'b', passed: true }),
    ]);
  }, 80_000);

  it.each([
    ['receipt', 'run', 0], ['receipt', 'active', 50],
    ['regate', 'run', 50], ['regate', 'active', 0],
    ['ship', 'run', 0], ['ship', 'active', 50],
  ])('%s survives owner death before %s publication, grace=%i, without overlapping work', async (entry, sink, grace) => {
    const f = await fixture({ grace });
    if (entry === 'ship') {
      // SHIP reactivates an APE-owned run checkout. Establish the real branch
      // before the owner hashes admission or publishes either state sink.
      f.state.branch = 'ape/phase-durable-fixture';
      f.git('switch', '-c', f.state.branch, f.state.base_commit_sha, '--no-track');
      expect(f.git('branch', '--show-current').trim()).toBe(f.state.branch);
      expect(f.git('rev-parse', 'main').trim()).toBe(f.state.base_commit_sha);
    }
    await serviceHarness(f);
    const owner = await invoke(f, { action: 'launch', entry, sink, fault: 'crash' });
    const barrierFile = path.join(f.outside, 'publication-barrier.json');
    await until(() => exists(barrierFile), 'live suite before watch publication');
    const barrier = await json(barrierFile);
    const first = (await records(f))[0];
    expect(alive(owner.child.pid)).toBe(true);
    expect(alive(barrier.watch.pid), 'runner must be live at the crash barrier').toBe(true);
    expect(alive(first.pid), 'suite must be live at the crash barrier').toBe(true);
    expect(alive(first.descendant), 'ordinary descendant must be live at the crash barrier').toBe(true);
    owner.child.kill('SIGKILL');
    await owner.exited;
    expect(alive(owner.child.pid)).toBe(false);
    const recovery = await invoke(f, { action: 'recover', entry });
    const response = await recovery.result();
    expect(response.error, 'normal public recovery must discover the orphan generation').toBeUndefined();
    await recovery.exited;
    const state = await json(f.paths.active);
    if (alive(first.pid) || alive(first.descendant)) {
      expect(state.status).toBe('gating');
      expect(state.gates_watch?.nonce, 'live work must be adopted with its original identity').toBe(barrier.watch.nonce);
      expect(state.gates_watch?.pid).toBe(barrier.watch.pid);
      expect(alive(barrier.watch.pid)).toBe(true);
    }
    await expectNoOverlap(f);
    await finishService(f, entry);
  }, 70_000);

  it.each(['run', 'active'])('retains recoverable ownership after the %s state write fails', async (sink) => {
    const f = await fixture();
    await serviceHarness(f);
    const owner = await invoke(f, { action: 'launch', entry: 'receipt', sink, fault: 'write-failure' });
    await until(() => exists(path.join(f.outside, 'publication-barrier.json')), 'injected EIO after suite start');
    await owner.result();
    await owner.exited;
    const recovery = await invoke(f, { action: 'recover', entry: 'receipt' });
    expect((await recovery.result()).error).toBeUndefined();
    await recovery.exited;
    await expectNoOverlap(f);
    await finishService(f, 'receipt');
  }, 70_000);
});

async function start(f, state = f.state, config = f.config) {
  const result = await startGateSuite(f.project, f.paths, state, config);
  expect(result.watch, JSON.stringify(result.hit)).toBeDefined();
  await until(async () => (await records(f)).length > 0, 'real suite start');
  return result.watch;
}
async function pollToEnd(f, watch, state = f.state, config = f.config) {
  let current = watch;
  const observations = [];
  try {
    return await until(async () => {
      const result = await pollGateSuite(f.project, f.paths, { ...state, gates_watch: current }, config);
      if (result.pending?.watch) current = { ...current, ...result.pending.watch };
      observations.push({ nonce: current.nonce, runner_index: current.runner_index,
        runner_alive: alive(current.pid), pending: Boolean(result.pending), ready: Boolean(result.ready),
        failed: Boolean(result.failed), pending_summary: result.pending?.summary });
      if (observations.length > 8) observations.shift();
      expect(result.failed).toBeUndefined();
      return result.ready ? result : false;
    }, 'gate result');
  } catch (error) {
    // Observe the stalled generation before fallback cleanup. Explicit field
    // selection keeps ownership secrets and proof authentication out of logs.
    // Neither diagnostics nor a vanished PID substitutes for completion proof.
    const ownership = await json(current.ownership_file).catch(() => null);
    const proof = ownership?.proof_file ? await json(ownership.proof_file).catch(() => null) : null;
    const heartbeat = await json(current.heartbeat_file).catch(() => null);
    const suites = (await records(f)).map((row) => ({ label: row.label, pid: row.pid,
      suite_alive: alive(row.pid), descendant: row.descendant, descendant_alive: alive(row.descendant),
      overlapping: row.overlapping }));
    const diagnostic = { observations, nonce: current.nonce, generation: current.generation,
      ownership: ownership && { generation: ownership.generation, phase: ownership.phase,
        broker_alive: alive(ownership.broker_pid), runner_alive: alive(ownership.watch?.pid) },
      proof: proof && { generation: proof.generation, cleanup_status: proof.payload?.cleanup?.status },
      heartbeat: heartbeat && { pid: heartbeat.pid, alive: alive(heartbeat.pid), beat_at: heartbeat.beat_at },
      job_exists: await exists(current.job_file), artifact_exists: await exists(current.artifact_file), suites };
    throw new Error(`${error.message}; gate diagnostics: ${JSON.stringify(diagnostic)}`, { cause: error });
  }
}
describe('generation identity and conservative legacy recovery', () => {
  it('gives repeated cache-equivalent generations distinct scratch paths and nonces', async () => {
    const f = await fixture();
    const first = await start(f);
    await writeFile(path.join(f.outside, 'one.release'), 'go');
    await pollToEnd(f, first);
    await until(async () => (await members(f)).every((pid) => !alive(pid)), 'first tree retirement');
    await rm(path.join(f.outside, 'one.release'));
    // A fresh audited attempt changes logical generation while leaving the
    // full command and tree (and therefore the ordinary cache key) identical.
    const secondState = { ...f.state, regate_attempts: 1 };
    const second = await start(f, secondState);
    expect(second.nonce).not.toBe(first.nonce);
    for (const key of ['job_file', 'artifact_file', 'heartbeat_file']) expect(second[key], key).not.toBe(first[key]);
    await until(async () => (await records(f)).length === 2, 'second suite start');
    await expectNoOverlap(f);
    await writeFile(path.join(f.outside, 'one.release'), 'go');
    await pollToEnd(f, second, secondState);
    expect((await members(f)).every((pid) => !alive(pid)),
      'the second proven generation must retire its suite and ordinary descendant before cleanup').toBe(true);
    expect(await records(f)).toHaveLength(2);
    await expectNoOverlap(f);
  }, 45_000);

  it('serializes concurrent starts and reuses authenticated live work rather than overwriting its job', async () => {
    const f = await fixture();
    const first = await start(f);
    const bytes = await readFile(first.job_file);
    const repeat = () => withReceiptLock(f.paths, () => startGateSuite(f.project, f.paths, f.state, f.config));
    const repeated = await Promise.all([repeat(), repeat()]);
    for (const result of repeated) {
      if (result.watch) expect(result.watch.nonce).toBe(first.nonce);
    }
    expect(await readFile(first.job_file)).toEqual(bytes);
    await delay(200);
    expect(await records(f)).toHaveLength(1);
    await expectNoOverlap(f);
    await writeFile(path.join(f.outside, 'one.release'), 'go');
    await pollToEnd(f, first);
  }, 40_000);

  it('loads a legacy watch but cannot infer retirement from an absent PID and missing heartbeat', async () => {
    const f = await fixture();
    const watch = await start(f);
    const legacy = { ...watch, pid: null, created_at: '2000-01-01T00:00:00.000Z', heartbeat_file: path.join(f.outside, 'missing-heartbeat') };
    delete legacy.ownership_file;
    delete legacy.generation;
    const result = await pollGateSuite(f.project, f.paths, { ...f.state, gates_watch: legacy }, f.config);
    expect(result.ready?.full?.passed).not.toBe(true);
    expect(result.pending?.watch?.spawn_attempts, 'unknown legacy retirement must not authorize respawn').toBeUndefined();
    await delay(200);
    expect(await records(f)).toHaveLength(1);
    await expectNoOverlap(f);
    await writeFile(path.join(f.outside, 'one.release'), 'go');
    await pollToEnd(f, watch);
  }, 40_000);

  it('does not use a foreign host watch and fresh numeric-PID witness as adoption or kill authority', async () => {
    const f = await fixture();
    const watch = await start(f);
    const first = (await records(f))[0];
    const foreign = { ...watch, host: `${hostname()}-foreign`, pid: first.descendant,
      heartbeat_file: path.join(f.outside, 'foreign-heartbeat'), created_at: '2000-01-01T00:00:00.000Z' };
    await atomicWriteJson(foreign.heartbeat_file, { pid: first.descendant, beat_at: Date.now() });
    await utimes(foreign.heartbeat_file, new Date(0), new Date(0));
    const result = await pollGateSuite(f.project, f.paths, { ...f.state, gates_watch: foreign }, f.config);
    expect(result.ready?.full?.passed).not.toBe(true);
    expect(result.pending?.watch?.spawn_attempts).toBeUndefined();
    expect(alive(first.descendant)).toBe(true);
    await delay(200);
    expect(await records(f)).toHaveLength(1);
    await expectNoOverlap(f);
    await writeFile(path.join(f.outside, 'one.release'), 'go');
    await pollToEnd(f, watch);
  }, 40_000);

  it('does not consume a nonce-matching passing artifact without descendant-retirement proof', async () => {
    const f = await fixture();
    const watch = await start(f);
    const first = (await records(f))[0];
    await atomicWriteJson(watch.artifact_file, { version: 1, run_id: f.state.run_id,
      nonce: watch.nonce, cache_key: watch.cache_key, passed: true, duration_ms: 1,
      verification: { passed: true, exit_code: 0, duration_ms: 1, output: 'closed pipes', tooling_failure: false } });
    const result = await pollGateSuite(f.project, f.paths, { ...f.state, gates_watch: watch }, f.config);
    expect(result.ready, 'a valid command result does not prove the living descendant retired').toBeUndefined();
    expect(alive(first.descendant)).toBe(true);
    expect(await exists(watch.job_file), 'unconfirmed ownership must remain recoverable').toBe(true);
    await rm(watch.artifact_file);
    await writeFile(path.join(f.outside, 'one.release'), 'go');
    await pollToEnd(f, watch);
  }, 40_000);

  it('keeps unknown broker-death ownership recoverable and vetoes a replacement', async () => {
    const f = await fixture();
    const watch = await start(f);
    expect(typeof watch.ownership_file).toBe('string');
    const journal = await json(watch.ownership_file);
    expect(Number.isSafeInteger(journal.broker_pid)).toBe(true);
    expect(journal.broker_pid).toBeGreaterThan(1);
    expect(alive(journal.broker_pid)).toBe(true);
    process.kill(journal.broker_pid, 'SIGKILL');
    await until(() => !alive(journal.broker_pid), 'proof broker death');
    // Allow whatever real containment does on handle/lifeline loss, but a
    // killed broker cannot turn that observation into an authenticated proof.
    const result = await pollGateSuite(f.project, f.paths, { ...f.state, gates_watch: watch }, f.config);
    expect(result.ready).toBeUndefined();
    expect(result.pending?.watch?.spawn_attempts).toBeUndefined();
    expect(await exists(watch.ownership_file)).toBe(true);
    const replacement = await startGateSuite(f.project, f.paths, f.state, f.config);
    expect(replacement.watch?.nonce === undefined || replacement.watch.nonce === watch.nonce).toBe(true);
    expect(await records(f)).toHaveLength(1);
    expect(await exists(watch.ownership_file)).toBe(true);
    await expectNoOverlap(f);
  }, 40_000);

  it.each(['foreign-host', 'wrong-run', 'wrong-generation', 'corrupt', 'oversized', 'hardlink'])(
    'rejects %s ownership without replacing work or signaling the numeric PID named by disk data', async (variant) => {
      const f = await fixture();
      const watch = await start(f);
      const first = (await records(f))[0];
      expect(typeof watch.ownership_file, 'a watch must retain its discoverable journal reference').toBe('string');
      const original = await readFile(watch.ownership_file);
      const journal = JSON.parse(original);
      const other = path.join(f.outside, 'foreign-record.json');
      if (variant === 'foreign-host') journal.host = `${hostname()}-foreign`;
      if (variant === 'wrong-run') journal.run_id = 'run-foreign';
      if (variant === 'wrong-generation') { journal.generation = 'foreign-generation'; journal.nonce = 'foreign-nonce'; }
      journal.pid = first.descendant;
      if (variant === 'hardlink') {
        await writeFile(other, JSON.stringify(journal));
        await rm(watch.ownership_file);
        await link(other, watch.ownership_file);
      } else await writeFile(watch.ownership_file, variant === 'corrupt' ? '{invalid' :
        variant === 'oversized' ? ' '.repeat(9 * 1024 * 1024) : JSON.stringify(journal));
      const before = await readFile(watch.ownership_file);
      const outcome = await startGateSuite(f.project, f.paths, f.state, f.config);
      expect(outcome.watch, 'untrusted ownership cannot authorize adoption or replacement').toBeUndefined();
      expect(await readFile(watch.ownership_file)).toEqual(before);
      expect(alive(first.pid)).toBe(true);
      expect(alive(first.descendant)).toBe(true);
      expect(await records(f)).toHaveLength(1);
      // Restore only the deliberately corrupted fixture after the refusal and
      // liveness assertions, so ordinary cleanup can complete without leaks.
      await rm(watch.ownership_file);
      await writeFile(watch.ownership_file, original);
      await writeFile(path.join(f.outside, 'one.release'), 'go');
      await pollToEnd(f, watch);
    }, 40_000,
  );
});

describe('authenticated unknown completion through public recovery', () => {
  it.skipIf(process.platform === 'win32').each([
    ['run', false], ['active', false], ['run', true], ['active', true],
  ])('blocks without polling or replacing after %s publication loss, retry=%s', async (sink, retry) => {
    const f = await fixture();
    // Two real participants make accidental cursor advancement observable.
    f.config.runners = [
      { id: 'a', root: '.', owns: ['notes/**'], profile: { full: f.command('one') } },
      { id: 'b', root: '.', owns: ['notes/**'], profile: { full: f.command('two') } },
    ];
    await atomicWriteJson(f.paths.config, f.config);
    await serviceHarness(f);
    const preload = path.join(f.outside, 'deny-lifecycle-proof.cjs');
    await writeFile(preload, [
      'const kill = process.kill.bind(process);',
      'process.kill = (pid, signal) => {',
      '  if (pid < -1 && signal === 0) throw Object.assign(new Error("fixture retirement query denied"), {code:"EPERM"});',
      '  return kill(pid, signal);',
      '};',
    ].join('\n'));
    // Child-only environment propagation reaches the actual runner and broker.
    // No runtime module, ownership record or signed proof is substituted.
    const owner = await invoke(f, { action: 'launch', entry: 'regate', sink, fault: 'crash' },
      { NODE_OPTIONS: '--require=' + JSON.stringify(preload) });
    const barrierFile = path.join(f.outside, 'publication-barrier.json');
    await until(() => exists(barrierFile), 'live owned suite before publication loss');
    const barrier = await json(barrierFile);
    const watch = barrier.watch;
    const initial = await json(watch.ownership_file);
    const first = (await records(f))[0];
    for (const pid of [owner.child.pid, watch.pid, initial.broker_pid, first.pid, first.descendant]) {
      expect(alive(pid), 'all real process roles must exist before the injected fault').toBe(true);
    }
    expect(first.label).toBe('one');
    expect(watch.runner_index).toBe(0);
    owner.child.kill('SIGKILL');
    await owner.exited;
    if (retry) {
      // Real IPC lifeline loss produces broker retry=true; the fixture never
      // forges this flag or signals the suite/descendant to manufacture proof.
      process.kill(watch.pid, 'SIGKILL');
    } else await writeFile(path.join(f.outside, 'one.release'), 'go');
    await until(async () => await exists(initial.proof_file) && !alive(initial.broker_pid),
      'signed unknown proof followed by broker exit', 30_000);
    const proofBytes = await readFile(initial.proof_file);
    const record = await json(watch.ownership_file);
    const { readGateProof } = await import('../lib/runtime/spawn.js');
    const proof = await readGateProof(record);
    const cause = 'process-group query failed (EPERM)';
    expect(proof?.cleanup).toEqual({ status: 'unknown', cause });
    expect(proof?.retry).toBe(retry);
    expect(safeArtifactDiagnostic(proof?.artifact)).toMatchObject({ run_id: f.state.run_id, nonce: watch.nonce,
      cache_key: watch.cache_key, passed: false });
    // Even if every numeric PID has disappeared, the authenticated unknown
    // result must remain unknown. Only the signed proof decides authority.
    const retained = async (response, action, sealed = false) => {
      expect(response.error).toBeUndefined();
      expect(response.result?.actions?.some((item) => item.type === 'gating_pending'),
        action + ' must not request another poll of a finished unknown generation: ' + JSON.stringify({
          cleanup: { status: proof.cleanup.status, cause: proof.cleanup.cause }, retry: proof.retry,
          artifact: safeArtifactDiagnostic(proof.artifact),
          summaries: response.result?.actions?.map((item) => item.summary).filter(Boolean),
        })).not.toBe(true);
      const active = await json(f.paths.active);
      const saved = await json(path.join(f.paths.runs, active.run_id + '.json'));
      for (const state of [active, saved]) {
        expect(state.status, action + ' must persist a terminal state in both sinks').toBe(sealed ? 'aborted' : 'blocked');
        if (!sealed) {
          expect(state.stage).toBe('gates');
          expect(state.block_reason).toContain(cause);
          expect(state.gates_watch?.nonce).toBe(watch.nonce);
          expect(state.gates_watch?.runner_index).toBe(0);
          expect(state.gates_watch?.spawn_attempts ?? 1).toBe(watch.spawn_attempts ?? 1);
        }
        expect(state.gates?.checks?.full_suite?.passed).not.toBe(true);
      }
      const journal = await json(watch.ownership_file);
      expect(journal.generation).toBe(record.generation);
      expect(journal.phase).not.toBe('consumed');
      expect(journal.phase).not.toBe('no-start');
      expect(await readFile(watch.job_file)).toEqual(jobBytes);
      expect((await readFile(initial.proof_file)).equals(proofBytes), 'signed proof must remain byte-identical').toBe(true);
      expect((await readGateProof(journal))?.cleanup).toEqual({ status: 'unknown', cause });
      expect(await records(f), action + ' must not start a replacement or second participant').toHaveLength(1);
      await expectNoOverlap(f);
      return active;
    };
    const jobBytes = await readFile(watch.job_file);
    const recovery = await invoke(f, { action: 'recover', entry: 'regate' });
    const recovered = await recovery.result();
    await recovery.exited;
    let state = await retained(recovered, 'recovery');
    // The first public recovery must terminate immediately in a block, not a
    // timeout loop. Repeated and concurrent public writers cannot rearm it.
    const pollCount = state.gates_watch?.poll_count ?? 0;
    const calls = await Promise.all(['next', 'resume'].map((action) => invoke(f, { action })));
    for (const [index, call] of calls.entries()) {
      const response = await call.result();
      await call.exited;
      state = await retained(response, ['next', 'resume'][index]);
      expect(state.gates_watch?.poll_count ?? 0).toBe(pollCount);
    }
    for (const action of ['next', 'resume', 'regate', 'ship', 'recover']) {
      const call = await invoke(f, { action, entry: 'regate' });
      const response = await call.result();
      await call.exited;
      await retained(response, action);
    }
    const abort = await invoke(f, { action: 'abort' });
    const aborted = await abort.result();
    await abort.exited;
    await retained(aborted, 'abort', true);
    for (const action of ['next', 'resume', 'regate', 'ship', 'recover']) {
      const call = await invoke(f, { action, entry: 'regate' });
      const response = await call.result();
      await call.exited;
      await retained(response, 'sealed ' + action, true);
    }
  }, 80_000);
});

describe('confirmed cleanup is separate from command settlement', () => {
  it.skipIf(process.platform === 'win32').each(['run', 'active'])(
    'recovers confirmed broker proof after a transient probe denial and %s publication loss', async (sink) => {
      const f = await fixture();
      await serviceHarness(f);
      const observationsFile = path.join(f.outside, 'retirement-probes.jsonl');
      const preload = path.join(f.outside, 'transient-proof.cjs');
      await writeFile(preload, `
        const fs = require('node:fs');
        // Only the actual proof broker probes the owned group here. Leave
        // supervisor containment, suite execution and all real signals intact.
        if (process.argv[2] === '--ape-gate-proof-broker') {
          const kill = process.kill.bind(process);
          let denied = false;
          const record = (group, outcome) => fs.appendFileSync(${JSON.stringify(observationsFile)},
            JSON.stringify({ broker: process.pid, group, outcome }) + '\\n');
          process.kill = (pid, signal) => {
            if (pid >= -1 || signal !== 0) return kill(pid, signal);
            if (!denied) {
              denied = true;
              record(pid, 'injected EPERM');
              throw Object.assign(new Error('fixture transient retirement query denied'), {code:'EPERM'});
            }
            // Never synthesize ESRCH or infer it from PID liveness: the OS
            // must supply the observation which authorizes confirmation.
            try { const result = kill(pid, signal); record(pid, 'present'); return result; }
            catch (error) { record(pid, 'OS ' + error.code); throw error; }
          };
        }
      `);
      const owner = await invoke(f, { action: 'launch', entry: 'regate', sink, fault: 'crash' },
        { NODE_OPTIONS: '--require=' + JSON.stringify(preload) });
      const barrierFile = path.join(f.outside, 'publication-barrier.json');
      await until(() => exists(barrierFile), 'live generation before transient-probe recovery');
      const { watch } = await json(barrierFile);
      const initial = await json(watch.ownership_file);
      const first = (await records(f))[0];
      for (const pid of [owner.child.pid, watch.pid, initial.broker_pid, first.pid, first.descendant]) {
        expect(alive(pid), 'real owner, runner, broker, suite and descendant must precede release').toBe(true);
      }
      owner.child.kill('SIGKILL');
      await owner.exited;
      await writeFile(path.join(f.outside, 'one.release'), 'go');
      await until(async () => await exists(initial.proof_file) && !alive(initial.broker_pid),
        'broker proof and exit after bounded transient denial', 30_000);
      const probes = (await readFile(observationsFile, 'utf8')).trim().split('\n').map(JSON.parse);
      expect(probes[0]).toMatchObject({ broker: initial.broker_pid, outcome: 'injected EPERM' });
      expect(probes.filter((probe) => probe.outcome === 'injected EPERM')).toHaveLength(1);
      expect(probes.slice(1).some((probe) => probe.outcome === 'OS ESRCH'),
        'a real OS ESRCH after the denial is mandatory retirement evidence').toBe(true);
      for (const probe of probes) {
        expect(probe.broker).toBe(initial.broker_pid);
        expect(probe.group).toBe(probes[0].group);
        expect(probe.group).toBeLessThan(-1);
      }
      const { readGateProof } = await import('../lib/runtime/spawn.js');
      const proof = await readGateProof(await json(watch.ownership_file));
      expect(proof?.cleanup).toEqual({ status: 'confirmed', cause: 'owned process group is empty' });
      expect(proof?.retry).toBe(false);
      expect(safeArtifactDiagnostic(proof?.artifact)).toMatchObject({ run_id: f.state.run_id,
        nonce: watch.nonce, cache_key: watch.cache_key, passed: true, verification: { exit_code: 0, tooling_failure: false } });
      const proofBytes = await readFile(initial.proof_file);
      expect(alive(first.pid)).toBe(false);
      expect(alive(first.descendant), 'real descendant retirement must precede fallback cleanup').toBe(false);
      const recovery = await invoke(f, { action: 'recover', entry: 'regate' });
      expect((await recovery.result()).error).toBeUndefined();
      await recovery.exited;
      await finishService(f, 'regate');
      for (const action of ['next', 'resume', 'next']) {
        const call = await invoke(f, { action });
        const response = await call.result();
        await call.exited;
        expect(response.error).toBeUndefined();
        expect(response.result?.actions?.some((item) => item.type === 'gating_pending')).not.toBe(true);
        const active = await json(f.paths.active);
        const saved = await json(path.join(f.paths.runs, active.run_id + '.json'));
        for (const state of [active, saved]) {
          expect(state.status).not.toBe('gating');
          expect(state.gates?.checks?.full_suite?.passed).toBe(true);
        }
        const journal = await json(watch.ownership_file);
        expect(journal.generation).toBe(initial.generation);
        expect(journal.phase).toBe('consumed');
        expect(await readFile(initial.proof_file)).toEqual(proofBytes);
        expect(await records(f), 'recovery must consume the proven generation without replacement').toHaveLength(1);
        await expectNoOverlap(f);
      }
    }, 70_000,
  );

  it.skipIf(process.platform === 'win32')('reports unknown when the OS denies the final group-retirement probe', async () => {
    const f = await fixture();
    const preload = path.join(f.outside, 'deny-proof.cjs');
    await writeFile(preload, `
      const kill = process.kill.bind(process);
      process.kill = (pid, signal) => {
        if (pid < -1 && signal === 0) throw Object.assign(new Error('fixture retirement query denied'), {code:'EPERM'});
        return kill(pid, signal);
      };
    `);
    const output = path.join(f.outside, 'cleanup-result.json');
    const harness = path.join(f.outside, 'unknown.mjs');
    await writeFile(harness, `
      import {writeFileSync} from 'node:fs';
      import {spawnWithTimeout} from ${JSON.stringify(moduleUrl('spawn.js'))};
      const result = await spawnWithTimeout(process.execPath, [${JSON.stringify(path.join(f.outside, 'suite.cjs'))}, ${JSON.stringify(f.outside)}, 'one'], {
        cwd:${JSON.stringify(f.project)},supervise:true,timeout_ms:15000,kill_grace_ms:100,drain_ms:100,
      });
      writeFileSync(${JSON.stringify(output)}, JSON.stringify(result));
    `);
    const child = spawn(process.execPath, [harness], { cwd: f.project, stdio: 'ignore',
      env: { ...process.env, NODE_OPTIONS: `--require=${JSON.stringify(preload)}` } });
    children.push(child);
    await until(async () => (await records(f)).length === 1, 'real descendants before denied proof');
    await writeFile(path.join(f.outside, 'one.release'), 'go');
    await until(() => exists(output), 'bounded unknown cleanup result', 25_000);
    const result = await json(output);
    expect(result.cleanup).toMatchObject({ status: 'unknown' });
    expect(typeof result.cleanup.cause).toBe('string');
    expect(result.cleanup.cause.length).toBeGreaterThan(0);
  }, 40_000);

  it('reports confirmed cleanup only after a normally exited leader and its closed-pipe descendant retire', async () => {
    const f = await fixture();
    const execution = spawnWithTimeout(process.execPath, [path.join(f.outside, 'suite.cjs'), f.outside, 'one'], {
      cwd: f.project, supervise: true, timeout_ms: 30_000, kill_grace_ms: 100, drain_ms: 100,
    });
    await until(async () => (await records(f)).length === 1, 'suite and descendant');
    const first = (await records(f))[0];
    expect(alive(first.descendant)).toBe(true);
    await writeFile(path.join(f.outside, 'one.release'), 'go');
    const result = await execution;
    expect(result.exit_code).toBe(0);
    expect(result.cleanup).toMatchObject({ status: 'confirmed' });
    expect(alive(first.pid)).toBe(false);
    expect(alive(first.descendant), 'promise settlement and pipe closure alone are not proof').toBe(false);
  }, 40_000);
});
