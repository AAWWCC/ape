import { execFileSync, spawn } from 'node:child_process';
import { access, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { hostname, tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { startGateSuite, pollGateSuite } from '../lib/runtime/gates.js';
import { currentTreeSha } from '../lib/runtime/git.js';
import { runtimePaths } from '../lib/runtime/paths.js';
import { atomicWriteJson } from '../lib/runtime/storage.js';
import { readGateProof } from '../lib/runtime/spawn.js';

// All executable fixtures are synthetic and live outside the governed project.
// No assertion reads production source. Faults intercept final ownership and
// state-file renames after validation/fsync, or pause before the real poll.
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
setTimeout(() => process.exit(93), 180_000);
`;
const descendantSource = String.raw`
const fs = require('node:fs');
const path = require('node:path');
const outside = process.argv[2];
process.on('SIGTERM', () => {});
fs.writeFileSync(path.join(outside, 'descendant-' + process.pid + '.ready'), 'ready');
setInterval(() => fs.appendFileSync(path.join(outside, 'descendant-' + process.pid + '.beats'), 'x'), 20);
setTimeout(() => process.exit(94), 180_000);
`;

async function fixture(options = {}) {
  const base = await mkdtemp(path.join(tmpdir(), 'ape invalidated generation '));
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
  deadlines_ms: { mechanical: 150_000 }, test_commands: { full: command('one') } };
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

// The loader substitutes remote GitHub work and adds a poll-entry barrier.
// The frozen-target validator,
// admission digest, local Git, actual gate launches and all OS containment run
// unchanged. An unexpected GitHub side effect is therefore never sent.
async function serviceHarness(f) {
  const loader = `
const spawnUrl = ${JSON.stringify(moduleUrl('spawn.js'))};
const gatesUrl = ${JSON.stringify(moduleUrl('gates.js'))};
const barrierUrl = ${JSON.stringify(pathToFileURL(path.join(f.outside, 'poll-barrier.mjs')).href)};
export async function load(url, context, next) {
  if (url === spawnUrl) return { format: 'module', shortCircuit: true, source:
    'export * from ' + JSON.stringify(url + '?fixture-real') + '; import { spawnWithTimeout as real } from ' + JSON.stringify(url + '?fixture-real') + ';' +
    'export function spawnWithTimeout(command, args, options) { if (command !== "gh") return real(command, args, options); if (!(args[0] === "--version" || (args[0] === "api" && args[1] === "repos/acme/repo"))) throw new Error("unexpected offline GitHub call"); return Promise.resolve({exit_code:0,timed_out:false,spawn_error:null,combined:args[0] === "--version" ? "gh version offline" : JSON.stringify({full_name:"acme/repo",archived:false,disabled:false,permissions:{pull:true,push:true},allow_squash_merge:true})}); }' };
  if (url === gatesUrl) return { format: 'module', shortCircuit: true, source:
    'export * from ' + JSON.stringify(url + '?fixture-real') + '; import { pollGateSuite as realPoll } from ' + JSON.stringify(url + '?fixture-real') + '; import { beforePoll } from ' + JSON.stringify(barrierUrl) + '; export async function pollGateSuite(...args) { await beforePoll(args); return realPoll(...args); } export async function autoMergeGithub() { return {url:"https://github.com/acme/repo/pull/1",sha:"' + 'f'.repeat(40) + '",method:"squash"}; }' };
  return next(url, context);
}
`;
  await writeFile(path.join(f.outside, 'offline-loader.mjs'), loader);
  await writeFile(path.join(f.outside, 'poll-barrier.mjs'), pollBarrierSource);
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
globalThis.fixtureRequest = request;
let armed = false, tripped = false;
const rename = fs.promises.rename.bind(fs.promises);
fs.promises.rename = async (from, to, ...rest) => {
  const target = String(to);
  if (armed && request.journalBoundary && !tripped && target.endsWith('.ownership.json')) {
    tripped = true;
    if (request.journalBoundary === 'after') await rename(from, to, ...rest);
    fs.writeFileSync(path.join(request.outside, 'journal-barrier.ready'), request.journalBoundary);
    await new Promise(() => { setInterval(() => {}, 1000); });
  }
  const selected = request.sink === 'run' ? target.startsWith(paths.runs + path.sep) : target === paths.active;
  if (armed && request.fault && !tripped && selected && target.endsWith('.json')) {
    const state = JSON.parse(fs.readFileSync(from, 'utf8'));
    const boundary = request.invalidationSink ? state.status === 'blocked' && /changed|invalidat/i.test(state.block_reason ?? '') : request.consume ? state.gates?.checks?.full_suite?.passed === true :
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
  } else if (request.action === 'poll-fault') {
    armed = true;
    result = await service.nextRun(request.project);
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
  if ((request.secondRunner || request.consume) && request.action === 'launch' && !request.pollBarrier) {
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

// This hook pauses immediately before the real poll, without changing its
// return value, authentication, cancellation, or persistence behavior. Both
// inline and explicit service routes therefore exercise the production poll.
const pollBarrierSource = String.raw`
import fs from 'node:fs';
import path from 'node:path';
let stopped = false;
export async function beforePoll(args) {
  const request = globalThis.fixtureRequest;
  if (!request?.pollBarrier || stopped) return;
  const [project, , state, config] = args;
  if (request.multiple && (state.gates_watch?.runner_index ?? 0) === 0) {
    fs.writeFileSync(path.join(request.outside, 'one.release'), 'go');
    return;
  }
  stopped = true;
  const ready = path.join(request.outside, 'poll-barrier.json');
  fs.writeFileSync(ready + '.tmp', JSON.stringify({ watch: state.gates_watch }));
  fs.renameSync(ready + '.tmp', ready);
  const proceed = path.join(request.outside, 'poll-proceed.json');
  while (!fs.existsSync(proceed)) await new Promise((r) => setTimeout(r, 10));
  const instruction = JSON.parse(fs.readFileSync(proceed, 'utf8'));
  // Configuration snapshots are mutable inputs to pollGateSuite. Inject at
  // this boundary so inline polling (whose config was loaded before launch)
  // observes exactly the same changed resolved input as an explicit poll.
  if (instruction.cause === 'preflight') config.test_commands.targeted = 'node --version';
  if (instruction.cause === 'suite') {
    if (request.multiple) config.runners[1].profile.full += ' changed';
    else config.test_commands.full += ' changed';
  }
  if (instruction.release) fs.writeFileSync(path.join(request.outside, request.multiple ? 'two.release' : 'one.release'), 'go');
}
`;

async function setup({ route = 'explicit', multiple = false } = {}) {
  const f = await fixture({ grace: route === 'inline' ? 30_000 : 0 });
  f.multiple = multiple;
  if (multiple) f.config.runners = [
    { id: 'a', root: '.', owns: ['notes/**'], profile: { full: f.command('one') } },
    { id: 'b', root: '.', owns: ['notes/**'], profile: { full: f.command('two') } },
    { id: 'c', root: '.', owns: ['notes/**'], profile: { full: f.command('three') } },
  ];
  await atomicWriteJson(f.paths.config, f.config);
  await serviceHarness(f);
  const sentinel = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
  children.push(sentinel);
  await new Promise((resolve, reject) => { sentinel.once('spawn', resolve); sentinel.once('error', reject); });
  f.sentinel = sentinel.pid;
  return f;
}
async function response(call) {
  const value = await call.result();
  await call.exited;
  expect(value.error).toBeUndefined();
  return value.result;
}
async function active(f) { return json(f.paths.active); }
async function launch(f, options = {}) {
  const call = await invoke(f, { action: 'launch', entry: 'regate', ...options });
  if (!options.pollBarrier) await response(call);
  return call;
}
async function reachSecond(f) {
  if (!f.multiple) return;
  await until(async () => (await records(f)).some((r) => r.label === 'one'), 'first suite ready');
  await writeFile(path.join(f.outside, 'one.release'), 'go');
  await until(async () => {
    await response(await invoke(f, { action: 'next' }));
    return (await records(f)).some((r) => r.label === 'two');
  }, 'second suite ready');
}
async function expectLive(f, watch) {
  const label = f.multiple ? 'two' : 'one';
  const row = await until(async () => (await records(f)).find((r) => r.label === label), label + ' readiness');
  for (const pid of [watch.pid, row.pid, row.descendant, f.sentinel]) expect(alive(pid)).toBe(true);
  await expectNoOverlap(f);
  return row;
}
async function cacheBytes(f) {
  return readFile(path.join(f.paths.runtime, 'suite-cache.json'), 'utf8').catch((e) => {
    if (e.code === 'ENOENT') return null;
    throw e;
  });
}
async function expectRetired(f, row) {
  // No release signal or fixture teardown is used here: the poll itself must
  // obtain bounded authenticated cancellation of SIGTERM-resistant members.
  await until(() => !alive(row.pid) && !alive(row.descendant), 'owned suite and descendant retirement', 15_000);
  expect(alive(row.pid)).toBe(false);
  expect(alive(row.descendant)).toBe(false);
  expect(alive(f.sentinel)).toBe(true);
  await expectNoOverlap(f);
}
async function settleInvalidation(f) {
  return until(async () => {
    const state = await active(f);
    if (state.status === 'blocked' && /changed|invalidat/i.test(state.block_reason ?? '')) return state;
    await response(await invoke(f, { action: 'next' }));
    return false;
  }, 'persisted invalidation failure', 20_000);
}
describe('invalidation journal crash and proof faults', () => {
  it.each(['before', 'after'])('recovers a controller crash %s the durable ownership invalidation rename', async (journalBoundary) => {
    const f = await setup();
    await launch(f);
    const watch = (await active(f)).gates_watch;
    const row = await expectLive(f, watch);
    await writeFile(path.join(f.project, 'notes/note.md'), '# drift\n');
    const controller = await invoke(f, { action: 'poll-fault', journalBoundary });
    await until(() => exists(path.join(f.outside, 'journal-barrier.ready')), 'ownership invalidation rename');
    // Intent must be made durable before signaling or deleting the live job.
    expect(alive(row.pid)).toBe(true);
    expect(alive(row.descendant)).toBe(true);
    expect(await exists(watch.job_file)).toBe(true);
    expect((await json(watch.ownership_file)).phase).not.toBe('consumed');
    controller.child.kill('SIGKILL');
    await controller.exited;
    if (journalBoundary === 'after') await writeFile(path.join(f.project, 'notes/note.md'), '# note\n');
    await response(await invoke(f, { action: 'resume' }));
    await response(await invoke(f, { action: 'next' }));
    await expectRetired(f, row);
    await settleInvalidation(f);
    expect(await records(f)).toHaveLength(1);
    expect(await cacheBytes(f)).toBe(null);
    expect(alive(f.sentinel)).toBe(true);
  }, 65_000);

  it('ignores an unsigned confirmed proof and retires through the actual broker', async () => {
    const f = await setup();
    await launch(f);
    const watch = (await active(f)).gates_watch;
    const row = await expectLive(f, watch);
    const record = await json(watch.ownership_file);
    await atomicWriteJson(record.proof_file, { generation: record.generation,
      payload: { cleanup: { status: 'confirmed' }, artifact: { passed: true } }, mac: 'forged' });
    expect(await readGateProof(record)).toBeNull();
    await writeFile(path.join(f.project, 'notes/note.md'), '# drift\n');
    await response(await invoke(f, { action: 'next' }));
    await expectRetired(f, row);
    await settleInvalidation(f);
    expect(await cacheBytes(f)).toBe(null);
    expect(await records(f)).toHaveLength(1);
  }, 65_000);

  it.skipIf(process.platform === 'win32')('keeps signed unknown cleanup terminal and recoverable across drift and repeated recovery', async () => {
    const f = await setup();
    const preload = path.join(f.outside, 'unknown-proof.cjs');
    await writeFile(preload, [
      'const kill = process.kill.bind(process);',
      'process.kill = (pid, signal) => {',
      '  if (pid < -1 && signal === 0) throw Object.assign(new Error("fixture proof query denied"), {code:"EPERM"});',
      '  return kill(pid, signal);',
      '};',
    ].join('\n'));
    await response(await invoke(f, { action: 'launch', entry: 'regate' },
      { NODE_OPTIONS: '--require=' + JSON.stringify(preload) }));
    const watch = (await active(f)).gates_watch;
    await expectLive(f, watch);
    const record = await json(watch.ownership_file);
    await writeFile(path.join(f.project, 'notes/note.md'), '# drift\n');
    await response(await invoke(f, { action: 'next' }));
    await until(async () => (await readGateProof(record))?.cleanup?.status === 'unknown', 'authenticated unknown cleanup', 35_000);
    const proofBytes = await readFile(record.proof_file);
    const jobBytes = await readFile(watch.job_file);
    await writeFile(path.join(f.project, 'notes/note.md'), '# note\n');
    for (const action of ['resume', 'next', 'regate', 'next']) {
      await response(await invoke(f, { action }));
      const state = await active(f);
      expect(state.status).toBe('blocked');
      expect(state.block_reason).toMatch(/unknown|retire|cleanup/i);
      expect(state.gates?.checks?.full_suite?.passed).not.toBe(true);
      expect((await json(watch.ownership_file)).phase).not.toBe('consumed');
      expect((await readFile(record.proof_file)).equals(proofBytes)).toBe(true);
      expect((await readFile(watch.job_file)).equals(jobBytes)).toBe(true);
      expect(await records(f)).toHaveLength(1);
      expect(alive(f.sentinel)).toBe(true);
    }
    expect(await cacheBytes(f)).toBe(null);
  }, 80_000);
});

const combinations = ['inline', 'explicit'].flatMap((route) =>
  [false, true].flatMap((multiple) => ['tree', 'preflight', 'suite'].map((cause) => ({ route, multiple, cause }))));

describe('invalidated owned gate generations', () => {
  it('serializes concurrent drift polls while the original suite and descendant are still alive', async () => {
    const f = await setup();
    await launch(f);
    const watch = (await active(f)).gates_watch;
    const row = await expectLive(f, watch);
    await writeFile(path.join(f.project, 'notes/note.md'), '# concurrent drift\n');
    const calls = await Promise.all([invoke(f, { action: 'next' }), invoke(f, { action: 'next' })]);
    for (const call of calls) await response(call);
    await expectRetired(f, row);
    await settleInvalidation(f);
    expect(await records(f)).toHaveLength(1);
    expect(await cacheBytes(f)).toBe(null);
    expect(alive(f.sentinel)).toBe(true);
    await expectNoOverlap(f);
  }, 65000);

  it('keeps broker-death cleanup recoverable during drift without inferring proof from absent PIDs', async () => {
    const f = await setup();
    await launch(f);
    const watch = (await active(f)).gates_watch;
    await expectLive(f, watch);
    const record = await json(watch.ownership_file);
    process.kill(record.broker_pid, 'SIGKILL');
    await until(() => !alive(record.broker_pid), 'broker death');
    await writeFile(path.join(f.project, 'notes/note.md'), '# drift after broker death\n');
    for (const action of ['next', 'resume', 'regate', 'next']) {
      await response(await invoke(f, { action }));
      const state = await active(f);
      expect(state.gates?.checks?.full_suite?.passed).not.toBe(true);
      expect((await json(watch.ownership_file)).phase).not.toBe('consumed');
      expect(await exists(watch.job_file)).toBe(true);
      expect(await records(f)).toHaveLength(1);
      expect(alive(f.sentinel)).toBe(true);
    }
    expect(await cacheBytes(f)).toBe(null);
    await expectNoOverlap(f);
  }, 65000);

  it.each(combinations)('$route multiple=$multiple retires $cause drift before accepting failure or replacement', async ({ route, multiple, cause }) => {
    const f = await setup({ route, multiple });
    let call;
    if (route === 'inline') call = await launch(f, { pollBarrier: true, multiple });
    else {
      await launch(f);
      await reachSecond(f);
      call = await invoke(f, { action: 'next', pollBarrier: true, multiple });
    }
    await until(() => exists(path.join(f.outside, 'poll-barrier.json')), 'poll entry barrier');
    const { watch } = await json(path.join(f.outside, 'poll-barrier.json'));
    const row = await expectLive(f, watch);
    if (multiple) {
      const first = (await records(f)).find((r) => r.label === 'one');
      expect(alive(first.pid)).toBe(false);
      expect(alive(first.descendant)).toBe(false);
      expect(watch.runner_index).toBe(1);
    }
    const before = await cacheBytes(f);
    if (cause === 'tree') await writeFile(path.join(f.project, 'notes/note.md'), '# changed during gate\n');
    await atomicWriteJson(path.join(f.outside, 'poll-proceed.json'), { cause });
    await response(call);
    // A terminal failed result is not sufficient: it must follow real exit.
    await expectRetired(f, row);
    const state = await settleInvalidation(f);
    expect(state.stage).toBe('gates');
    expect(state.gates?.checks?.full_suite?.passed).not.toBe(true);
    expect(await cacheBytes(f)).toBe(before);
    const count = multiple ? 2 : 1;
    expect(await records(f)).toHaveLength(count);
    // Independent controllers concurrently re-enter after the in-memory
    // drift injection has disappeared. Invalidation must remain monotonic.
    const polls = await Promise.all(['next', 'resume'].map((action) => invoke(f, { action })));
    for (const poll of polls) await response(poll);
    expect((await active(f)).status).toBe('blocked');
    expect((await active(f)).gates?.checks?.full_suite?.passed).not.toBe(true);
    expect(await records(f)).toHaveLength(count);
    expect(await cacheBytes(f)).toBe(before);
    expect(alive(f.sentinel)).toBe(true);
    await expectNoOverlap(f);
  }, 65_000);

  it.each(['run', 'active'])('retains retirement evidence before the %s invalidation state sink and recovers after controller death', async (sink) => {
    const f = await setup();
    await launch(f);
    const watch = (await active(f)).gates_watch;
    const row = await expectLive(f, watch);
    const initial = await json(watch.ownership_file);
    await writeFile(path.join(f.project, 'notes/note.md'), '# drift\n');
    const controller = await invoke(f, { action: 'poll-fault', invalidationSink: true, sink, fault: 'crash' });
    await until(() => exists(path.join(f.outside, 'publication-barrier.json')), 'invalidation state sink');
    await expectRetired(f, row);
    const retained = await json(watch.ownership_file);
    expect(retained.generation).toBe(initial.generation);
    expect(retained.phase, 'neither sink has acknowledged complete persistence yet').not.toBe('consumed');
    expect(await exists(watch.job_file)).toBe(true);
    expect(await exists(initial.proof_file)).toBe(true);
    expect((await readGateProof(retained))?.cleanup?.status).toBe('confirmed');
    controller.child.kill('SIGKILL');
    await controller.exited;
    // Remove the transient drift before restarting. The same watch nonce in
    // active state must not suppress recovery of durable invalidation.
    await writeFile(path.join(f.project, 'notes/note.md'), '# note\n');
    await response(await invoke(f, { action: 'resume' }));
    await response(await invoke(f, { action: 'next' }));
    const recovered = await settleInvalidation(f);
    const saved = await json(path.join(f.paths.runs, recovered.run_id + '.json'));
    for (const state of [saved, recovered]) {
      expect(state.status).toBe('blocked');
      expect(state.gates?.checks?.full_suite?.passed).not.toBe(true);
    }
    expect(await cacheBytes(f)).toBe(null);
    expect(await records(f)).toHaveLength(1);
    expect(alive(f.sentinel)).toBe(true);
    await expectNoOverlap(f);
  }, 65_000);

  it.each(['run', 'active'])('retries an EIO at the %s invalidation state sink without resurrecting the result', async (sink) => {
    const f = await setup();
    await launch(f);
    const watch = (await active(f)).gates_watch;
    const row = await expectLive(f, watch);
    await writeFile(path.join(f.project, 'notes/note.md'), '# drift\n');
    const controller = await invoke(f, { action: 'poll-fault', invalidationSink: true, sink, fault: 'write-failure' });
    const failed = await controller.result();
    await controller.exited;
    expect(failed.error).toContain('fixture state publication EIO');
    await expectRetired(f, row);
    expect((await json(watch.ownership_file)).phase).not.toBe('consumed');
    await writeFile(path.join(f.project, 'notes/note.md'), '# note\n');
    await response(await invoke(f, { action: 'resume' }));
    await settleInvalidation(f);
    expect(await records(f)).toHaveLength(1);
    expect(await cacheBytes(f)).toBe(null);
    expect(alive(f.sentinel)).toBe(true);
  }, 65_000);

  it('allows an audited re-gate only after invalidation retirement, without overlapping either descendant', async () => {
    const f = await setup();
    await launch(f);
    const watch = (await active(f)).gates_watch;
    const row = await expectLive(f, watch);
    await writeFile(path.join(f.project, 'notes/note.md'), '# drift\n');
    await response(await invoke(f, { action: 'next' }));
    await expectRetired(f, row);
    await settleInvalidation(f);
    await writeFile(path.join(f.project, 'notes/note.md'), '# note\n');
    await response(await invoke(f, { action: 'regate' }));
    const second = await until(async () => (await records(f)).find((r) => r.pid !== row.pid), 'audited replacement');
    expect((await active(f)).gates_watch.nonce).not.toBe(watch.nonce);
    expect(second.overlapping).toEqual([]);
    expect(alive(second.pid)).toBe(true);
    expect(alive(second.descendant)).toBe(true);
    expect(alive(row.pid)).toBe(false);
    expect(alive(row.descendant)).toBe(false);
    expect(alive(f.sentinel)).toBe(true);
    await expectNoOverlap(f);
  }, 65_000);

  it('keeps a completion racing drift invalid, even when the suite returns zero', async () => {
    const f = await setup();
    await launch(f);
    const watch = (await active(f)).gates_watch;
    const row = await expectLive(f, watch);
    const call = await invoke(f, { action: 'next', pollBarrier: true });
    await until(() => exists(path.join(f.outside, 'poll-barrier.json')), 'racing poll');
    await writeFile(path.join(f.project, 'notes/note.md'), '# drift\n');
    await atomicWriteJson(path.join(f.outside, 'poll-proceed.json'), { cause: 'tree', release: true });
    await response(call);
    await expectRetired(f, row);
    await settleInvalidation(f);
    await writeFile(path.join(f.project, 'notes/note.md'), '# note\n');
    await response(await invoke(f, { action: 'next' }));
    expect((await active(f)).status).toBe('blocked');
    expect(await cacheBytes(f)).toBe(null);
    expect(await records(f)).toHaveLength(1);
  }, 65_000);

  it.each(['foreign-host', 'wrong-generation', 'wrong-job', 'stale-pid', 'reused-pid', 'missing-job', 'legacy'])(
    '%s evidence never grants drift cancellation or replacement authority over an unrelated process', async (variant) => {
      const f = await setup();
      await launch(f);
      const state = await active(f);
      const watch = state.gates_watch;
      await expectLive(f, watch);
      const original = await readFile(watch.ownership_file);
      const job = await readFile(watch.job_file);
      const record = JSON.parse(original);
      let supplied = { ...watch };
      if (variant === 'foreign-host') record.host = hostname() + '-foreign';
      if (variant === 'wrong-generation') record.generation = '00000000-0000-4000-8000-000000000000';
      if (variant === 'wrong-job') record.watch.job_file = path.join(f.outside, 'foreign-job.json');
      if (variant === 'stale-pid') record.watch.pid = 2147483647;
      if (variant === 'reused-pid') { record.watch.pid = f.sentinel; record.broker_pid = f.sentinel; }
      if (variant === 'legacy') { delete supplied.ownership_file; delete supplied.generation; supplied.pid = f.sentinel; }
      if (variant === 'missing-job') await rm(watch.job_file);
      else if (variant !== 'legacy') await writeFile(watch.ownership_file, JSON.stringify(record));
      await writeFile(path.join(f.project, 'notes/note.md'), '# drift\n');
      for (let n = 0; n < 2; n++) {
        const result = await pollGateSuite(f.project, f.paths, { ...state, gates_watch: supplied }, f.config);
        expect(result.ready).toBeUndefined();
        expect(result.pending?.summary ?? result.failed).toMatch(/unknown|ownership|proof|unavailable|retire|match/i);
        expect(alive(f.sentinel)).toBe(true);
        expect(await exists(watch.ownership_file)).toBe(true);
        expect((await json(watch.ownership_file)).phase).not.toBe('consumed');
        expect(await records(f)).toHaveLength(1);
      }
      if (variant !== 'legacy') {
        const replacement = await startGateSuite(f.project, f.paths, { ...state, regate_attempts: 2 }, f.config);
        expect(replacement.watch?.nonce === undefined || replacement.watch.nonce === watch.nonce).toBe(true);
        expect(alive(f.sentinel)).toBe(true);
        expect(await records(f)).toHaveLength(1);
      }
      // Restore the exact synthetic disk bytes only after all refusal evidence.
      await writeFile(watch.ownership_file, original);
      await writeFile(watch.job_file, job);
      await response(await invoke(f, { action: 'next' }));
      await expectRetired(f, (await records(f))[0]);
      expect(alive(f.sentinel)).toBe(true);
    }, 65_000,
  );

  it.each(['running', 'completed'])('retains reverted drift across broker transport loss with a %s suite', async (completion) => {
    const f = await setup();
    await launch(f);
    const watch = (await active(f)).gates_watch;
    const row = await expectLive(f, watch);
    const original = await readFile(watch.ownership_file);
    const record = JSON.parse(original);
    // Change only the connection endpoint; retain the actual authenticated
    // broker and restore it later. No fake proof or simulated exit is used.
    expect(Number.isInteger(record.port)).toBe(true);
    await writeFile(watch.ownership_file, JSON.stringify({ ...record, port: 1 }));
    await writeFile(path.join(f.project, 'notes/note.md'), '# drift\n');
    for (const action of ['next', 'resume', completion === 'running' ? 'regate' : 'next']) {
      await response(await invoke(f, { action }));
      const pending = await active(f);
      expect(pending.gates?.checks?.full_suite?.passed).not.toBe(true);
      expect(JSON.stringify({ reason: pending.block_reason, summary: pending.gates_watch?.last_summary }))
        .toMatch(/unknown|ownership|broker|retire|cleanup|prior/i);
      expect(await exists(watch.job_file)).toBe(true);
      expect((await json(watch.ownership_file)).phase).not.toBe('consumed');
      expect(await records(f)).toHaveLength(1);
      expect(alive(f.sentinel)).toBe(true);
      expect(alive(row.pid)).toBe(true);
      expect(alive(row.descendant)).toBe(true);
    }
    // The drift is gone before transport recovers. Restore only the endpoint:
    // replacing the whole record with the old bytes would erase the runtime's
    // durable invalidation intent and invalidate this recovery experiment.
    await writeFile(path.join(f.project, 'notes/note.md'), '# note\n');
    expect(await currentTreeSha(f.project)).toBe(watch.tree_sha);
    if (completion === 'completed') {
      // Produce a real authenticated successful result while the controller
      // cannot reach the broker. Recovery must reject it despite matching keys.
      await writeFile(path.join(f.outside, 'one.release'), 'go');
      await until(async () => {
        const proof = await readGateProof(record);
        return proof?.cleanup?.status === 'confirmed' && proof.artifact?.passed === true;
      }, 'signed successful completion during transport loss');
      expect(alive(row.pid)).toBe(false);
      expect(alive(row.descendant)).toBe(false);
    }
    const retained = await json(watch.ownership_file);
    expect(retained.generation).toBe(record.generation);
    await atomicWriteJson(watch.ownership_file, { ...retained, port: record.port });
    // Every invoke starts a fresh controller. Recovery and an audited attempt
    // must both honor the invalidation observed before the drift disappeared.
    await response(await invoke(f, { action: 'resume' }));
    await response(await invoke(f, { action: 'next' }));
    await expectRetired(f, row);
    const recovered = await settleInvalidation(f);
    const saved = await json(path.join(f.paths.runs, recovered.run_id + '.json'));
    for (const state of [saved, recovered]) {
      expect(state.status).toBe('blocked');
      expect(state.gates?.checks?.full_suite?.passed).not.toBe(true);
    }
    await response(await invoke(f, { action: 'next' }));
    expect((await active(f)).status).toBe('blocked');
    expect(await records(f)).toHaveLength(1);
    expect(await cacheBytes(f)).toBe(null);
    expect(alive(f.sentinel)).toBe(true);
    await expectNoOverlap(f);
  }, 65_000);
});
