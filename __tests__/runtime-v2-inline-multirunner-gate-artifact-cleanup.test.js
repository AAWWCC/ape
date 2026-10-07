import { gitFixtureEnv } from '../test-support/git-fixtures.js';
import { execFileSync, spawn } from 'node:child_process';
import { access, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { currentTreeSha } from '../lib/runtime/git.js';
import { runtimePaths } from '../lib/runtime/paths.js';
import { atomicWriteJson } from '../lib/runtime/storage.js';
import { readGateProof } from '../lib/runtime/spawn.js';
import { pollGateSuite } from '../lib/runtime/gates.js';
import { cleanupGateSuite } from '../lib/runtime/receipt-service.js';

// These fixtures run the actual controller, runner, broker and suite. The
// preload observes filesystem boundaries, never replaces their algorithms.
// Everything it writes is in a fresh synthetic repository or its sibling.
const runtime = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../lib/runtime');
const url = (name) => pathToFileURL(path.join(runtime, name)).href;
const roots = [], children = [];
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const exists = (file) => access(file).then(() => true, () => false);
const json = (file) => readFile(file, 'utf8').then(JSON.parse);
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };
async function until(check, label, timeout = 20000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) { const value = await check(); if (value) return value; await delay(20); }
  throw new Error(`Fixture did not reach ${label}`);
}
async function records(f) {
  const names = await readdir(f.outside);
  return Promise.all(names.filter((n) => /^owned-.*\.json$/.test(n)).map((n) => json(path.join(f.outside, n))));
}
async function executions(f) {
  return (await readdir(f.outside)).filter((n) => /^executed-/.test(n)).sort();
}
const active = (f) => json(f.paths.active);
const scratch = (r) => [r.watch.job_file, r.watch.artifact_file, r.watch.heartbeat_file];

// A common preload is inherited by the detached processes. The final rename
// is after write/fsync/validation, so this pauses an actual started write.
const preload = String.raw`
const fs = require('node:fs');
const path = require('node:path');
const { syncBuiltinESMExports } = require('node:module');
const request = JSON.parse(fs.readFileSync(process.env.APE_CLEANUP_FIXTURE, 'utf8'));
const root = request.outside;
const controller = process.argv[1] === path.join(root, 'controller.mjs');
const rename = fs.promises.rename.bind(fs.promises);
const remove = fs.promises.rm.bind(fs.promises);
const read = (p) => JSON.parse(fs.readFileSync(p, 'utf8'));
const put = (name, data) => {
  const p = path.join(root, name), tmp = p + '.' + process.pid + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data)); fs.renameSync(tmp, p);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let tripped = false;
async function barrier(kind, data) {
  put(kind + '.barrier.json', {pid:process.pid, ...data});
  while (!fs.existsSync(path.join(root, kind + '.release'))) await sleep(10);
}
async function fault(data) {
  tripped = true;
  put('fault.barrier.json', {pid:process.pid, ...data});
  if (request.fault === 'eio') throw Object.assign(new Error('fixture final sink EIO'), {code:'EIO'});
  await new Promise(() => setInterval(() => {}, 1000));
}
fs.promises.rename = async (from, to, ...rest) => {
  const target = String(to);
  if (!target.startsWith(request.project + path.sep)) return rename(from, to, ...rest);
  let data;
  try { data = read(from); } catch {}
  if (target.endsWith('.ownership.json') && data?.watch?.pid > 1) {
    put('owned-' + data.generation + '.json', data);
  }
  if (controller && !tripped && request.boundary) {
    const terminal = data?.gates?.checks?.full_suite && !data.gates_watch;
    const selectedSink = request.boundary === 'run' ? target.startsWith(request.runs + path.sep) :
      request.boundary === 'active' && target === request.active;
    if (terminal && selectedSink) await fault({target, data});
    if (request.boundary === 'reservation' && target.endsWith('.ownership.json') &&
        data?.phase === 'reserved' && data.watch?.runner_index === 1) {
      await rename(from, to, ...rest);
      await fault({target, data});
      return;
    }
    if (request.boundary === 'consumed' && target.endsWith('.ownership.json') && data?.phase === 'consumed') {
      await rename(from, to, ...rest);
      await fault({target, data});
      return;
    }
  }
  const producerSelected = !controller && request.pause && fs.readdirSync(root)
    .filter((name) => /^owned-.*\.json$/.test(name)).some((name) => {
      const record = read(path.join(root,name));
      return record.watch.runner_index === request.pauseIndex &&
        [record.watch.artifact_file,record.watch.heartbeat_file].includes(target);
    });
  if (producerSelected && request.pause === 'result' && target.endsWith('.result.json') &&
      !fs.existsSync(path.join(root, 'result.release'))) await barrier('result', {target});
  if (producerSelected && request.pause === 'heartbeat' && target.endsWith('.heartbeat') &&
      fs.existsSync(path.join(root, 'heartbeat.arm')) &&
      !fs.existsSync(path.join(root, 'heartbeat.release'))) await barrier('heartbeat', {target});
  const result = await rename(from, to, ...rest);
  if (controller && target === request.active && data) {
    put('transition-' + (++globalThis.fixtureTransitions || (globalThis.fixtureTransitions = 1)) + '-' + process.pid + '.json',
      {status:data.status, watch:data.gates_watch, gates:data.gates});
  }
  return result;
};
fs.promises.rm = async (file, ...rest) => {
  const target = String(file);
  const selected = controller && !tripped && request.boundary === 'unlink' &&
    target.startsWith(request.project + path.sep) &&
    target.endsWith(request.unlinkSuffix);
  if (selected) { await remove(file, ...rest); await fault({target}); return; }
  return remove(file, ...rest);
};
// The synthetic suite leaves no child behind. Denying the real process-group
// query makes the broker publish its real authenticated unknown result.
if (request.unknown && !controller) {
  const kill = process.kill.bind(process);
  process.kill = (pid, signal) => {
    if (pid < -1 && signal === 0 && fs.existsSync(path.join(root, 'unknown.arm')))
      throw Object.assign(new Error('fixture retirement query unavailable'), {code:'EPERM'});
    return kill(pid, signal);
  };
}
syncBuiltinESMExports();
`;

async function fixture({ grace = 8000, exit = 0, pause, pauseIndex = 0, unknown } = {}) {
  const base = await mkdtemp(path.join(tmpdir(), 'ape inline cleanup '));
  const project = path.join(base, 'project'), outside = path.join(base, 'outside');
  await mkdir(path.join(project, 'notes'), { recursive: true });
  await mkdir(outside);
  await writeFile(path.join(project, 'notes/note.md'), '# fixture\n');
  const git = (...args) => execFileSync('git', args, {cwd:project, encoding:'utf8', env: gitFixtureEnv()});
  git('init', '-q'); git('symbolic-ref', 'HEAD', 'refs/heads/main');
  git('config', 'user.email', 'ape@example.test'); git('config', 'user.name', 'APE Fixture');
  git('config', 'commit.gpgsign', 'false'); git('add', '.'); git('commit', '-qm', 'fixture');
  git('remote', 'add', 'origin', 'https://github.com/acme/repo.git');
  git('update-ref', 'refs/remotes/origin/main', 'HEAD');
  git('symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/main');
  const paths = runtimePaths(project), tree = await currentTreeSha(project);
  const f = {base, project, outside, paths, tree, pause, pauseIndex, unknown, sequence:0}; roots.push(f);
  await writeFile(path.join(outside, 'suite.cjs'), String.raw`
const fs = require('node:fs'), path = require('node:path');
const [root, label, exit] = process.argv.slice(2);
fs.writeFileSync(path.join(root, 'executed-' + label + '-' + process.pid), 'executed');
const timer = setInterval(() => {
  if (fs.existsSync(path.join(root, label + '.release'))) { clearInterval(timer); process.exit(Number(exit)); }
}, 10);
setTimeout(() => process.exit(97), 45000).unref();
`);
  const command = (label, code) => `node "${path.join(outside, 'suite.cjs')}" "${outside}" ${label} ${code}`;
  f.config = { shipping:{auto_merge:false, provider:'github', required_remote_checks:false,
    target:{origin:'https://github.com/acme/repo.git', repository:'acme/repo', base:'main'}},
    policy:{full_suite_cache:false}, gates:{inline_grace_ms:grace, heartbeat_ms:40},
    deadlines_ms:{mechanical:30000}, test_commands:{full:command('a', 0)},
    runners:[{id:'a',root:'.',owns:['notes/**'],profile:{full:command('a', 0)}},
      {id:'b',root:'.',owns:['notes/**'],profile:{full:command('b', exit)}}] };
  f.state = {version:2,schema_version:'2.0.0',run_id:'run-inline-cleanup',mode:'phase',lane:'mechanical',
    requested_lane:'mechanical',status:'blocked',stage:'gates',
    block_reason:'one or more deterministic merge gates failed',objective:'Exercise owned cleanup',host:'codex',
    behavioral:false,high_risk:false,policy:{},claimed_paths:['notes/note.md'],test_paths:[],requirements:[],risk_triggers:[],
    branch:'main',base_commit_sha:git('rev-parse','HEAD').trim(),tickets:[],attempts:{},remediation_cycles:0,regate_attempts:0,
    tree_sha:tree,gates:{passed:false,tree_sha:tree},created_at:new Date().toISOString(),updated_at:new Date().toISOString(),
    receipts:[{receipt_hash:'a',previous_receipt_hash:null,status:'passed',agent:{host:'codex',role:'implementer'},
      tests:[{passed:true}],changed_files:['notes/note.md'],head_tree_sha:tree}]};
  await atomicWriteJson(paths.config, f.config);
  await atomicWriteJson(paths.active, f.state);
  await atomicWriteJson(path.join(paths.runs, f.state.run_id + '.json'), f.state);
  await writeFile(path.join(outside, 'preload.cjs'), preload);
  // Only remote discovery is stubbed. Gate planning, local Git, locking,
  // evaluation and persistence remain the production public API.
  await writeFile(path.join(outside, 'offline.mjs'), `
export async function load(u,c,next) {
  if(u === ${JSON.stringify(url('spawn.js'))}) return {format:'module',shortCircuit:true,source:
    'export * from '+JSON.stringify(u+'?real')+';import {spawnWithTimeout as real} from '+JSON.stringify(u+'?real')+';'+
    'export function spawnWithTimeout(cmd,args,opts){if(cmd!=="gh")return real(cmd,args,opts);'+
    'if(!(args[0]==="--version"||(args[0]==="api"&&args[1]==="repos/acme/repo")))throw Error("unexpected remote call");'+
    'return Promise.resolve({exit_code:0,timed_out:false,spawn_error:null,combined:args[0]==="--version"?"gh version fixture":JSON.stringify({full_name:"acme/repo",archived:false,disabled:false,permissions:{pull:true,push:true},allow_squash_merge:true})});}'};
  return next(u,c);
}`);
  await writeFile(path.join(outside, 'controller.mjs'), `
import fs from 'node:fs';
import {register} from 'node:module';
import {pathToFileURL} from 'node:url';
const r=JSON.parse(fs.readFileSync(process.env.APE_CLEANUP_FIXTURE,'utf8'));
register(pathToFileURL(r.outside+'/offline.mjs'));
const service=await import(${JSON.stringify(url('service.js'))});
try {
  const result= r.action==='launch' ? await service.regateRun(r.project) :
    r.action==='resume' ? await service.resumeRun(r.project) : await service.nextRun(r.project);
  fs.writeFileSync(r.response,JSON.stringify({result}));
} catch(e) {fs.writeFileSync(r.response,JSON.stringify({error:e.message,code:e.code}));}
process.exit(0);
`);
  return f;
}

async function invoke(f, action = 'next', fault = {}) {
  const request = path.join(f.outside, `request-${++f.sequence}.json`);
  const response = path.join(f.outside, `response-${f.sequence}.json`);
  await writeFile(request, JSON.stringify({project:f.project,outside:f.outside,active:f.paths.active,runs:f.paths.runs,
    pause:f.pause,pauseIndex:f.pauseIndex,unknown:f.unknown,action,response,...fault}));
  const env = gitFixtureEnv();
  for (const key of Object.keys(env)) if (/^(APE_|NODE_OPTIONS$|CODEX_CWD$|CLAUDE_PROJECT_DIR$)/.test(key)) delete env[key];
  env.APE_CLEANUP_FIXTURE = request;
  env.NODE_OPTIONS = '--require=' + JSON.stringify(path.join(f.outside, 'preload.cjs'));
  const child = spawn(process.execPath, [path.join(f.outside,'controller.mjs')], {cwd:f.project,env,stdio:['ignore','ignore','pipe']});
  children.push(child);
  let stderr = '';
  child.stderr.on('data', (chunk) => { if (stderr.length < 4096) stderr += chunk; });
  const exited = new Promise((resolve,reject) => { child.once('exit',resolve);child.once('error',reject); });
  return {child,exited,response,result:async () => {
    await until(() => exists(response), `controller response: ${stderr}`, 25000);
    await exited;
    return json(response);
  }};
}
async function call(f, action = 'next', fault) {
  const reply = await (await invoke(f, action, fault)).result();
  expect(reply.error).toBeUndefined(); return reply.result;
}
async function boundaryOrResponse(f, invocation) {
  const outcome = await until(async () => {
    if (await exists(path.join(f.outside,'fault.barrier.json'))) return 'barrier';
    if (await exists(invocation.response)) return 'response';
    return false;
  },'controller response or injected boundary',25000);
  if (outcome === 'response') expect((await invocation.result()).error).toBeUndefined();
  return outcome;
}
const release = (f, name) => writeFile(path.join(f.outside, name + '.release'), 'go');
async function releaseSuites(f) { await release(f,'a'); await release(f,'b'); }
async function finish(f, expected = true) {
  await until(async () => {
    const state = await active(f);
    if (state.gates?.checks?.full_suite && !state.gates_watch && state.status !== 'gating') return true;
    await call(f); return false;
  }, 'terminal evaluation');
  const state = await active(f);
  expect(state.gates.checks.full_suite.passed).toBe(expected);
  expect(state.gates_watch).toBeNull();
  expect(state.gates.checks.full_suite.runners).toEqual([
    expect.objectContaining({id:'a',passed:true}), expect.objectContaining({id:'b',passed:expected}),
  ]);
  expect(await executions(f)).toHaveLength(2);
  return state;
}
async function assertClean(f) {
  const owned = await records(f);
  expect(owned).toHaveLength(2);
  for (const record of owned) {
    expect((await readGateProof(record))?.cleanup?.status).toBe('confirmed');
    expect(await exists(record.proof_file)).toBe(true);
    expect(await exists(record.watch.ownership_file)).toBe(true);
    for (const file of scratch(record)) expect(await exists(file), path.basename(file)).toBe(false);
  }
  // This is an observation window after producer completion, not the mechanism
  // permitting cleanup. Assert twice before any fallback process/file teardown.
  await delay(160);
  for (const record of owned) for (const file of scratch(record)) expect(await exists(file)).toBe(false);
}
async function sentinel(f) {
  const dir = path.join(f.paths.runtime, 'gate-suite'); await mkdir(dir,{recursive:true});
  const files = ['unrelated.job.json','unrelated.result.json','unrelated.heartbeat'];
  for (const name of files) await writeFile(path.join(dir,name), 'unrelated evidence');
  return async () => { for (const name of files) expect(await readFile(path.join(dir,name),'utf8')).toBe('unrelated evidence'); };
}
afterEach(async () => {
  // No acceptance observation depends on these emergency signals or removals.
  for (const child of children.splice(0)) if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  for (const f of roots.splice(0)) {
    for (const name of ['a','b','result','heartbeat']) await release(f,name).catch(() => {});
    const retained = await records(f).catch(() => []);
    const dir = path.join(f.paths.runtime,'gate-suite');
    for (const name of await readdir(dir).catch(() => [])) if (name.endsWith('.ownership.json')) {
      const record = await json(path.join(dir,name)).catch(() => null);
      if (record?.watch) retained.push(record);
    }
    for (const r of retained) for (const pid of [r.watch.pid,r.broker_pid]) {
      if (Number.isInteger(pid) && pid > 1) { try { process.kill(pid,'SIGKILL'); } catch {} }
    }
    for (const name of await executions(f).catch(() => [])) {
      const pid = Number(name.split('-').at(-1));
      if (Number.isInteger(pid) && pid > 1) { try { process.kill(pid,'SIGKILL'); } catch {} }
    }
    await delay(50);
    await rm(f.base,{recursive:true,force:true,maxRetries:20,retryDelay:50});
  }
});

describe('owned inline multi-runner artifact cleanup', () => {
  it.each([0,7])('clears the current inline watch and cleans both real generations for exit %i', async (exit) => {
    const f = await fixture({exit}); const untouched = await sentinel(f);
    await releaseSuites(f); await call(f,'launch');
    // Nonzero grace must resolve both fast runners in this call. A later poll
    // cannot hide stale current-watch capture at the inline transition.
    const state = await active(f);
    expect(state.gates_watch).toBeNull();
    expect(state.gates.checks.full_suite.passed).toBe(exit === 0);
    await finish(f,exit === 0); await assertClean(f); await untouched();
  },45000);

  it.each([0,7])('uses explicit polls when grace is zero for exit %i', async (exit) => {
    const f = await fixture({grace:0,exit});
    await releaseSuites(f); await call(f,'launch');
    const first = await active(f);
    expect(first.status).toBe('gating'); expect(first.gates_watch.runner_index).toBe(0);
    await finish(f,exit === 0); await assertClean(f);
  },45000);

  it.each(['result','heartbeat'].flatMap((pause) => [0,1].map((pauseIndex) => ({pause,pauseIndex}))))(
    'withholds advancement/consumption while runner $pauseIndex real $pause writer is paused', async ({pause,pauseIndex}) => {
    const f = await fixture({grace:0,pause,pauseIndex});
    await call(f,'launch');
    if (pauseIndex === 1) {
      await release(f,'a');
      await until(async () => { await call(f); return (await active(f)).gates_watch?.runner_index === 1; },'second owned runner');
    }
    const first = (await active(f)).gates_watch;
    const record = await json(first.ownership_file);
    if (pause === 'heartbeat') {
      await writeFile(path.join(f.outside,'heartbeat.arm'),'armed');
      await until(() => exists(path.join(f.outside,'heartbeat.barrier.json')), 'in-flight owned heartbeat');
    }
    await release(f,pauseIndex === 0 ? 'a' : 'b');
    await until(() => exists(path.join(f.outside,pause+'.barrier.json')), 'paused producer rename');
    await until(async () => (await readGateProof(record))?.cleanup?.status === 'confirmed', 'real signed descendant retirement');
    const polls = await Promise.all([invoke(f),invoke(f)]);
    for (const poll of polls) expect((await poll.result()).error).toBeUndefined();
    expect((await active(f)).gates_watch?.nonce).toBe(first.nonce);
    expect(await executions(f)).toHaveLength(pauseIndex + 1);
    expect(await exists(first.job_file)).toBe(true);
    expect((await json(first.ownership_file)).phase).not.toBe('consumed');
    await release(f,pause); await release(f,'b');
    await finish(f); await assertClean(f);
    await call(f,'resume'); await call(f); await assertClean(f);
  },55000);

  it.skipIf(process.platform === 'win32')('retains the current second watch on inline poll.failed with unknown retirement', async () => {
    const f = await fixture({unknown:true,grace:40000});
    await release(f,'a');
    const owner = await invoke(f,'launch');
    await until(async () => (await executions(f)).some((n) => n.startsWith('executed-b-')), 'second real suite');
    const second = (await records(f)).find((r) => r.watch.runner_index === 1);
    expect(second).toBeDefined();
    await writeFile(path.join(f.outside,'unknown.arm'),'armed'); await release(f,'b');
    expect((await owner.result()).error).toBeUndefined();
    const state = await active(f);
    expect(state.status).toBe('blocked'); expect(state.gates_watch?.nonce).toBe(second.generation);
    expect((await readGateProof(second))?.cleanup?.status).toBe('unknown');
    await until(() => !alive(second.watch.pid),'finished unknown-proof producer');
    const predecessor = (await records(f)).find((r) => r.watch.runner_index === 0);
    expect((await readGateProof(predecessor))?.cleanup?.status).toBe('confirmed');
    for (const file of scratch(predecessor)) expect(await exists(file)).toBe(false);
    const before = await readFile(second.proof_file);
    await call(f,'resume'); await call(f);
    expect((await active(f)).gates_watch?.nonce).toBe(second.generation);
    expect(await exists(second.watch.job_file)).toBe(true);
    expect((await readFile(second.proof_file)).equals(before)).toBe(true);
    expect(await executions(f)).toHaveLength(2);
  },45000);

  it.each(['run','active'])('keeps terminal results unconsumed until the %s sink succeeds', async (boundary) => {
    const f = await fixture({grace:0}); await releaseSuites(f); await call(f,'launch');
    let failed;
    await until(async () => {
      const reply = await (await invoke(f,'next',{boundary,fault:'eio'})).result();
      if (reply.error) { failed = reply; return true; } return false;
    },'injected terminal sink failure');
    expect(failed.error).toContain('fixture final sink EIO');
    const owned = await records(f), last = owned.find((r) => r.watch.runner_index === 1);
    expect((await json(last.watch.ownership_file)).phase).not.toBe('consumed');
    expect(await exists(last.watch.artifact_file)).toBe(true);
    await call(f,'resume'); await finish(f); await assertClean(f);
  },55000);

  it.each(['run','active','reservation','consumed'])('recovers controller death at the %s boundary without repeating a runner', async (boundary) => {
    const f = await fixture({grace:0}); await releaseSuites(f); await call(f,'launch');
    let victim;
    await until(async () => {
      victim = await invoke(f,'next',{boundary,fault:'crash'});
      const outcome = await boundaryOrResponse(f,victim);
      return outcome === 'barrier';
    }, 'controller at crash boundary',30000);
    const barrier = await json(path.join(f.outside,'fault.barrier.json'));
    expect(barrier.pid).toBe(victim.child.pid);
    victim.child.kill('SIGKILL'); await victim.exited;
    await call(f,'resume'); await finish(f); await assertClean(f);
    await call(f); expect(await executions(f)).toHaveLength(2);
  },65000);

  it.each(['.job.json','.result.json','.heartbeat'])('retries cleanup interrupted after deleting %s', async (unlinkSuffix) => {
    const f = await fixture({grace:0}); const untouched = await sentinel(f);
    await releaseSuites(f); await call(f,'launch');
    let victim;
    await until(async () => {
      victim = await invoke(f,'next',{boundary:'unlink',unlinkSuffix,fault:'crash'});
      const outcome = await boundaryOrResponse(f,victim);
      if (outcome === 'response' && (await active(f)).gates_watch === null) {
        // Baseline has no owned unlink: report that missing behavior directly.
        expect(await exists(path.join(f.outside,'fault.barrier.json')),'owned scratch deletion must occur').toBe(true);
      }
      return outcome === 'barrier';
    },'interrupted deletion',30000);
    victim.child.kill('SIGKILL'); await victim.exited;
    await call(f,'resume'); await finish(f); await assertClean(f); await untouched();
  },65000);

  it.each(['missing','invalid','legacy'])('does not clean or advance with %s producer proof', async (variant) => {
    const f = await fixture({grace:0}); await call(f,'launch');
    const state = await active(f), watch = state.gates_watch;
    const record = await json(watch.ownership_file);
    await release(f,'a');
    await until(async () => !alive(watch.pid) && (await readGateProof(record))?.cleanup?.status === 'confirmed', 'finished real producer');
    const proof = await readFile(record.proof_file);
    if (variant === 'missing') await rm(record.proof_file);
    if (variant === 'invalid') await writeFile(record.proof_file,JSON.stringify({generation:record.generation,payload:{cleanup:{status:'confirmed'}},mac:'invalid'}));
    if (variant === 'legacy') {
      // An authentic old-generation envelope remains readable for retirement,
      // but contains no new writer-completion acknowledgement.
      const {createHmac} = await import('node:crypto');
      const full = JSON.parse(proof), payload = {cleanup:full.payload.cleanup,artifact:full.payload.artifact,retry:full.payload.retry};
      full.payload = payload;
      full.mac = createHmac('sha256',record.secret).update(JSON.stringify(payload)).digest('hex');
      await writeFile(record.proof_file,JSON.stringify(full));
    }
    const result = await pollGateSuite(f.project,f.paths,state,f.config);
    expect(result.ready).toBeUndefined(); expect(result.pending?.watch).toBeUndefined();
    await cleanupGateSuite(watch);
    expect(await exists(watch.job_file)).toBe(true);
    expect(await executions(f)).toHaveLength(1);
    await writeFile(record.proof_file,proof);
    await release(f,'b'); await finish(f); await assertClean(f);
  },55000);

  it('preserves recovery evidence when a producer dies before acknowledging its paused heartbeat', async () => {
    const f = await fixture({grace:0,pause:'heartbeat'}); await call(f,'launch');
    const first = (await active(f)).gates_watch;
    const record = await json(first.ownership_file);
    await writeFile(path.join(f.outside,'heartbeat.arm'),'armed');
    const barrier = await until(async () => await json(path.join(f.outside,'heartbeat.barrier.json')).catch(() => null),'paused heartbeat');
    await release(f,'a');
    await until(async () => (await readGateProof(record))?.cleanup?.status === 'confirmed','retired suite');
    process.kill(barrier.pid,'SIGKILL'); await until(() => !alive(barrier.pid),'writer death');
    await call(f); await call(f,'resume'); await call(f);
    expect(await executions(f)).toHaveLength(1);
    expect((await active(f)).gates_watch?.nonce).toBe(first.nonce);
    expect(await exists(first.job_file)).toBe(true);
    expect(await exists(record.proof_file)).toBe(true);
    expect((await json(first.ownership_file)).phase).not.toBe('consumed');
  },55000);

  it('cannot use a stale predecessor watch to delete a newer owned generation', async () => {
    const f = await fixture({grace:0}); await call(f,'launch');
    const old = (await active(f)).gates_watch;
    await release(f,'a');
    await until(async () => { await call(f); return (await active(f)).gates_watch?.runner_index === 1; },'second watch');
    const current = (await active(f)).gates_watch;
    const bytes = await readFile(current.ownership_file);
    await cleanupGateSuite(old);
    expect((await readFile(current.ownership_file)).equals(bytes)).toBe(true);
    expect(await exists(current.job_file)).toBe(true);
    expect((await active(f)).gates_watch.nonce).toBe(current.nonce);
    await release(f,'b'); await finish(f); await assertClean(f);
  },45000);
});
