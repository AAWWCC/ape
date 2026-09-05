import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  __fsRaceControl,
  lstat,
  mkdtemp,
  mkdir,
  open,
  readFile,
  readdir,
  rename,
  rm,
  utimes,
  writeFile,
} from 'node:fs/promises';
import { hostname, tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal();
  const control = {
    arm: null,
    fired: 0,
    seen: 0,
    openSeen: 0,
    memberReadCalls: 0,
    generationReaddirCalls: 0,
    selectorReaddirCalls: 0,
    selectorOpendirReads: 0,
    selectorMutationCalls: 0,
    memberFstatCalls: 0,
    memberBoundedReadCalls: 0,
    destination: null,
  };
  const normalizedPath = (file) => String(file).replaceAll('\\', '/');
  const matchesRecoveryMember = (file, relative = null) => {
    const normalized = normalizedPath(file);
    return normalized.includes('/recovery-generations/') &&
      (relative === null
        ? !normalized.endsWith('/manifest.json')
        : normalized.endsWith(`/${relative}`));
  };
  const matchesArmedMember = (file) => {
    return control.arm?.kind === 'same-bytes-after-lstat' &&
      matchesRecoveryMember(file, control.arm.relative);
  };
  const rebindSameBytes = async (file) => {
    const bytes = await actual.readFile(file);
    const displaced = `${file}.race-original`;
    await actual.rename(file, displaced);
    await actual.writeFile(file, bytes);
    control.arm = null;
    control.fired += 1;
  };
  return {
    ...actual,
    __fsRaceControl: control,
    open: async (file, ...args) => {
      const handle = await actual.open(file, ...args);
      if (matchesArmedMember(file)) {
        control.openSeen += 1;
        // A corrected verifier opens the member and derives bytes plus identity
        // from that handle. Rebind the pathname after the open so its required
        // post-read/path identity check observes the attack too.
        await rebindSameBytes(file);
      }
      if (
        control.arm?.kind === 'forbid-member-read' &&
        matchesRecoveryMember(file, control.arm.relative ?? null)
      ) {
        return new Proxy(handle, {
          get(target, property) {
            if (property === 'stat') {
              return async (...statArgs) => {
                control.memberFstatCalls += 1;
                return target.stat(...statArgs);
              };
            }
            if (property === 'read') {
              return async () => {
                control.memberBoundedReadCalls += 1;
                control.fired += 1;
                const error = new Error('APE_TEST_MEMBER_READ_BEFORE_DECLARED_SIZE_CHECK');
                error.code = 'APE_TEST_MEMBER_READ_BEFORE_DECLARED_SIZE_CHECK';
                throw error;
              };
            }
            const value = Reflect.get(target, property, target);
            return typeof value === 'function' ? value.bind(target) : value;
          },
        });
      }
      if (
        control.arm?.kind === 'forbid-member-read-file' &&
        matchesRecoveryMember(file, control.arm.relative ?? null)
      ) {
        return new Proxy(handle, {
          get(target, property) {
            if (property === 'readFile') {
              return async () => {
                control.memberReadCalls += 1;
                control.fired += 1;
                const error = new Error('APE_TEST_UNBOUNDED_MEMBER_READ');
                error.code = 'APE_TEST_UNBOUNDED_MEMBER_READ';
                throw error;
              };
            }
            const value = Reflect.get(target, property, target);
            return typeof value === 'function' ? value.bind(target) : value;
          },
        });
      }
      return handle;
    },
    readdir: async (directory, ...args) => {
      if (
        control.arm?.kind === 'forbid-generation-readdir' &&
        normalizedPath(directory) === normalizedPath(control.arm.directory)
      ) {
        control.generationReaddirCalls += 1;
        control.fired += 1;
        const error = new Error('APE_TEST_UNBOUNDED_GENERATION_READDIR');
        error.code = 'APE_TEST_UNBOUNDED_GENERATION_READDIR';
        throw error;
      }
      if (
        control.arm?.kind === 'forbid-selector-readdir' &&
        normalizedPath(directory) === normalizedPath(control.arm.directory)
      ) {
        control.selectorReaddirCalls += 1;
        control.fired += 1;
        const error = new Error('APE_TEST_UNBOUNDED_SELECTOR_READDIR');
        error.code = 'APE_TEST_UNBOUNDED_SELECTOR_READDIR';
        throw error;
      }
      return actual.readdir(directory, ...args);
    },
    opendir: async (directory, ...args) => {
      const opened = await actual.opendir(directory, ...args);
      if (
        control.arm?.kind !== 'forbid-selector-readdir' ||
        normalizedPath(directory) !== normalizedPath(control.arm.directory)
      ) {
        return opened;
      }
      const observe = (entry) => {
        if (entry === null || entry === undefined) return entry;
        control.selectorOpendirReads += 1;
        if (control.selectorOpendirReads > 129) {
          control.fired += 1;
          const error = new Error('APE_TEST_UNBOUNDED_SELECTOR_OPENDIR');
          error.code = 'APE_TEST_UNBOUNDED_SELECTOR_OPENDIR';
          throw error;
        }
        return entry;
      };
      return new Proxy(opened, {
        get(target, property) {
          if (property === 'read') {
            return async (...readArgs) => observe(await target.read(...readArgs));
          }
          if (property === Symbol.asyncIterator) {
            return () => {
              const iterator = target[Symbol.asyncIterator]();
              return {
                async next() {
                  const next = await iterator.next();
                  if (!next.done) observe(next.value);
                  return next;
                },
                async return() {
                  return typeof iterator.return === 'function'
                    ? iterator.return()
                    : { done: true, value: undefined };
                },
                [Symbol.asyncIterator]() {
                  return this;
                },
              };
            };
          }
          const value = Reflect.get(target, property, target);
          return typeof value === 'function' ? value.bind(target) : value;
        },
      });
    },
    link: async (source, destination, ...args) => {
      const armed = control.arm;
      if (
        armed?.kind === 'forbid-selector-mutation' &&
        [source, destination].some((file) => normalizedPath(file) === normalizedPath(armed.file))
      ) {
        control.selectorMutationCalls += 1;
        control.fired += 1;
        const error = new Error('APE_TEST_SELECTOR_PATH_MUTATION:link');
        error.code = 'APE_TEST_SELECTOR_PATH_MUTATION';
        throw error;
      }
      const selectorMove = armed &&
        normalizedPath(source) === normalizedPath(armed.file) &&
        normalizedPath(destination).includes('/recovery-selector-quarantine/');
      if (armed?.kind === 'selector-tombstone-collision' && selectorMove) {
        await actual.writeFile(destination, armed.sentinel, { flag: 'wx' });
        control.destination = destination;
        control.fired += 1;
      }
      const linked = await actual.link(source, destination, ...args);
      if (armed?.kind === 'selector-rebind-before-remove' && selectorMove) {
        await actual.rename(source, `${source}.race-original`);
        await actual.writeFile(source, armed.replacement);
        control.destination = destination;
        control.fired += 1;
      }
      if (armed?.kind === 'selector-post-move-rebind' && selectorMove) {
        control.destination = destination;
      }
      return linked;
    },
    rm: async (file, ...args) => {
      const armed = control.arm;
      if (
        armed?.kind === 'forbid-selector-mutation' &&
        normalizedPath(file) === normalizedPath(armed.file)
      ) {
        control.selectorMutationCalls += 1;
        control.fired += 1;
        const error = new Error('APE_TEST_SELECTOR_PATH_MUTATION:rm');
        error.code = 'APE_TEST_SELECTOR_PATH_MUTATION';
        throw error;
      }
      const selectorRemove = armed?.kind === 'selector-post-move-rebind' &&
        normalizedPath(file) === normalizedPath(armed.file) &&
        typeof control.destination === 'string';
      const removed = await actual.rm(file, ...args);
      if (selectorRemove) {
        const bytes = await actual.readFile(control.destination);
        await actual.rename(control.destination, `${control.destination}.race-original`);
        await actual.writeFile(control.destination, bytes);
        control.fired += 1;
      }
      return removed;
    },
    unlink: async (file, ...args) => {
      if (
        control.arm?.kind === 'forbid-selector-mutation' &&
        normalizedPath(file) === normalizedPath(control.arm.file)
      ) {
        control.selectorMutationCalls += 1;
        control.fired += 1;
        const error = new Error('APE_TEST_SELECTOR_PATH_MUTATION:unlink');
        error.code = 'APE_TEST_SELECTOR_PATH_MUTATION';
        throw error;
      }
      return actual.unlink(file, ...args);
    },
    rename: async (source, destination, ...args) => {
      if (
        control.arm?.kind === 'forbid-selector-mutation' &&
        [source, destination].some((file) => normalizedPath(file) === normalizedPath(control.arm.file))
      ) {
        control.selectorMutationCalls += 1;
        control.fired += 1;
        const error = new Error('APE_TEST_SELECTOR_PATH_MUTATION:rename');
        error.code = 'APE_TEST_SELECTOR_PATH_MUTATION';
        throw error;
      }
      return actual.rename(source, destination, ...args);
    },
    copyFile: async (source, destination, ...args) => {
      if (
        control.arm?.kind === 'forbid-selector-mutation' &&
        [source, destination].some((file) => normalizedPath(file) === normalizedPath(control.arm.file))
      ) {
        control.selectorMutationCalls += 1;
        control.fired += 1;
        const error = new Error('APE_TEST_SELECTOR_PATH_MUTATION:copyFile');
        error.code = 'APE_TEST_SELECTOR_PATH_MUTATION';
        throw error;
      }
      return actual.copyFile(source, destination, ...args);
    },
    symlink: async (target, file, ...args) => {
      if (
        control.arm?.kind === 'forbid-selector-mutation' &&
        normalizedPath(file) === normalizedPath(control.arm.file)
      ) {
        control.selectorMutationCalls += 1;
        control.fired += 1;
        const error = new Error('APE_TEST_SELECTOR_PATH_MUTATION:symlink');
        error.code = 'APE_TEST_SELECTOR_PATH_MUTATION';
        throw error;
      }
      return actual.symlink(target, file, ...args);
    },
    writeFile: async (file, ...args) => {
      if (
        control.arm?.kind === 'forbid-selector-mutation' &&
        normalizedPath(file) === normalizedPath(control.arm.file)
      ) {
        control.selectorMutationCalls += 1;
        control.fired += 1;
        const error = new Error('APE_TEST_SELECTOR_PATH_MUTATION:writeFile');
        error.code = 'APE_TEST_SELECTOR_PATH_MUTATION';
        throw error;
      }
      return actual.writeFile(file, ...args);
    },
    lstat: async (file, ...args) => {
      const metadata = await actual.lstat(file, ...args);
      if (
        matchesArmedMember(file)
      ) {
        control.seen += 1;
        if (control.seen === control.arm.fireOn) {
          await rebindSameBytes(file);
        }
      }
      return metadata;
    },
  };
});

vi.mock('../lib/runtime/lock.js', async (importOriginal) => {
  const actual = await importOriginal();
  const control = { arm: null, fired: 0, mutationCalls: 0 };
  const replaceHeldDirectory = async (lockPath) => {
    const fs = await import('node:fs/promises');
    const os = await import('node:os');
    const nodePath = await import('node:path');
    const displaced = `${lockPath}.displaced.${control.fired}`;
    await fs.rename(lockPath, displaced);
    await fs.mkdir(lockPath);
    await fs.writeFile(nodePath.join(lockPath, 'owner'), 'rival-owner-token');
    await fs.writeFile(nodePath.join(lockPath, 'process'), `${JSON.stringify({
      version: 1,
      token: 'rival-owner-token',
      pid: process.pid,
      host: os.hostname(),
      state: 'active',
    })}\n`);
    control.arm = null;
    control.fired += 1;
  };
  return {
    ...actual,
    __receiptLeaseFault: control,
    withDirLock: async (lockPath, callback, options) => actual.withDirLock(
      lockPath,
      async (lease) => {
        if (
          control.arm?.kind === 'replace-held-directory' &&
          String(lockPath) === String(control.arm.lockPath)
        ) {
          await replaceHeldDirectory(lockPath);
        }
        return callback(lease);
      },
      options,
    ),
    withDirLockLeaseMutation: async (lockPath, lease, mutation) => {
      control.mutationCalls += 1;
      if (
        control.arm?.kind === 'replace-before-post-selector-sink' &&
        String(lockPath) === String(control.arm.lockPath) &&
        control.mutationCalls === control.arm.fireOn
      ) {
        await replaceHeldDirectory(lockPath);
      }
      return actual.withDirLockLeaseMutation(lockPath, lease, mutation);
    },
  };
});

// SCOPE_EXPANDED persist crash window (roadmap scope-expanded-receipt-atomicity;
// MEDIUM finding 1.3 in docs/research/2026-07-19-runtime-audit.md; invariant 1).
//
// Public contract under test, derived from the ticket objective:
//
//   Recording a receipt that reports lane escalation, new risk triggers, or a
//   review-proposed scope expansion is one runtime-owned transition. If the
//   process dies after the receipt has become durable in active.json but
//   before the pipeline consequences of RECEIPT_RECORDED (successor ticket,
//   group outcome, remediation, gates) are durable, the client's retry of the
//   IDENTICAL receipt — the runtime's own documented recovery lever — must
//   resume the pipeline: after the retry the run holds a dispatchable
//   successor (or has honestly transitioned), never an idle 'running' run
//   whose every ticket is receipted, where NEXT can only echo status and the
//   sole exit is abort.
//
// The acceptance contract permits two implementations and these tests accept
// both: (a) no durable active.json snapshot exists between 'receipt recorded'
// and 'actions applied' (the scope patch folds into the RECEIPT_RECORDED
// chain, so the one receipt-bearing persist already carries the successor), or
// (b) the idempotent-recovery arm re-derives and applies the RECEIPT_RECORDED
// actions when state shows the committed receipt but no successor progress.
// The crash is therefore anchored to the CONTRACT event, not a code line: the
// FIRST durable active.json snapshot that contains the receipt. Under (a) that
// snapshot already carries the consequences; under (b) the retry derives them;
// on the current tree the retry returns { idempotent, recovered, actions: [] }
// and the run idles — the red anchor.
//
// Crash simulation follows the merged-archive-idempotency suite's discipline:
// everything is the real runtime (real reducers, persistence, red-test
// observation, git evidence) in a temp git repo. The only seam is storage's
// atomicWriteJson, wrapped so that ONE armed write COMPLETES on disk and then
// throws — byte-equivalent to SIGKILL immediately after that write landed:
// every earlier write (receipt file, prepared transaction, audit lines) is
// durable, nothing later happens, in-memory state dies with the call, and the
// retry is a fresh entry that re-reads disk. Idempotency is convergence, not
// amnesia: 'committed receipt' must imply 'consequences applied or reachable'.
vi.mock('../lib/runtime/storage.js', async (importOriginal) => {
  const actual = await importOriginal();
  const control = { arm: null, fired: 0 };
  const publication = { arm: null, fired: 0 };
  const substituteMemberWithHardLink = async (directory, relative) => {
    const fs = await import('node:fs/promises');
    const nodePath = await import('node:path');
    const member = nodePath.join(directory, relative);
    const original = `${member}.fault-original`;
    await fs.rename(member, original);
    await fs.link(original, member);
  };
  return {
    ...actual,
    __crashControl: control,
    __publicationFault: publication,
    atomicWriteJson: async (file, value) => {
      await actual.atomicWriteJson(file, value);
      const arm = control.arm;
      const normalizedFile = file.replaceAll('\\', '/');
      const normalizedDirectory = arm?.directory?.replaceAll('\\', '/');
      const directChild = normalizedDirectory &&
        normalizedFile.startsWith(`${normalizedDirectory}/`) &&
        !normalizedFile.slice(normalizedDirectory.length + 1).includes('/');
      const matched = arm?.kind === 'prepared-transaction'
        ? normalizedFile.includes('/receipt-transactions/') && value?.status === 'prepared'
        : arm?.kind === 'dispatch-status'
          ? normalizedFile.includes('/dispatch-intents/') && value?.status === arm.status
        : arm?.kind === 'canonical-recovery-file'
          ? directChild
          : arm &&
            file === arm.file &&
            Array.isArray(value?.receipts) &&
            value.receipts.some((entry) => entry?.ticket_id === arm.ticket_id);
      if (
        matched
      ) {
        control.arm = null;
        control.fired += 1;
        const crash = new Error(
          'simulated crash: the process died immediately after this durable write',
        );
        crash.code = 'APE_TEST_SIMULATED_CRASH';
        throw crash;
      }
    },
    publishImmutableDirectory: async (...args) => {
      const [temporary, directory] = args;
      const arm = publication.arm;
      if (arm?.kind === 'hardlink-before-rename') {
        await substituteMemberWithHardLink(temporary, arm.relative);
        publication.arm = null;
        publication.fired += 1;
      }
      const published = await actual.publishImmutableDirectory(...args);
      if (arm?.kind === 'hardlink-after-rename' && published) {
        await substituteMemberWithHardLink(directory, arm.relative);
        publication.arm = null;
        publication.fired += 1;
      }
      return published;
    },
    publishImmutableJson: async (...args) => {
      const [file] = args;
      const published = await actual.publishImmutableJson(...args);
      if (
        publication.arm?.kind === 'crash-after-selector-publish' &&
        published === true &&
        String(file).replaceAll('\\', '/').includes('/recovery-selectors/')
      ) {
        publication.arm = null;
        publication.fired += 1;
        const crash = new Error('APE_TEST_CRASH_AFTER_SELECTOR_PUBLISH');
        crash.code = 'APE_TEST_CRASH_AFTER_SELECTOR_PUBLISH';
        throw crash;
      }
      return published;
    },
  };
});

vi.mock('../lib/runtime/run-contract.js', async (importOriginal) => {
  const actual = await importOriginal();
  const control = { arm: null, calls: 0 };
  return {
    ...actual,
    __runContractFault: control,
    prepareTicketRunContract: async (...args) => {
      const prepared = await actual.prepareTicketRunContract(...args);
      if (control.arm !== 'rebind-first-pointer' || !prepared) return prepared;
      control.calls += 1;
      if (control.calls !== 1) return prepared;
      return {
        ...prepared,
        pointer: {
          ...prepared.pointer,
          hash: '0'.repeat(64),
        },
      };
    },
  };
});
import {
  __crashControl,
  __publicationFault,
  atomicWriteJson,
  readJson,
} from '../lib/runtime/storage.js';
import {
  nextRun,
  recordReceipt,
  startRun,
  validateReceiptForDispatch,
} from '../lib/runtime/service.js';
import { runtimePaths } from '../lib/runtime/paths.js';
import { __runContractFault, readRunContractManifest } from '../lib/runtime/run-contract.js';
import {
  bindCodexSubagent,
  bootstrapCodexSubagent,
  launchCodexIntent,
  prepareCodexIntent,
} from '../lib/runtime/claude-dispatch.js';
import { validateTicket } from '../lib/runtime/schemas.js';
import { bindCodexDispatch } from './codex-native-test-helper.js';
import { projectRunResponse } from '../lib/runtime/projection.js';
import {
  __receiptLeaseFault,
  withDirLock,
  withDirLockLeaseMutation,
} from '../lib/runtime/lock.js';
import { sha256 } from '../lib/runtime/canonical.js';

// Real filesystem + git + spawned red-test observation; keep the honest tests
// off the default timeout, and let teardown ride out win32 EBUSY.
vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

const cleanups = [];
const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
afterEach(async () => {
  __fsRaceControl.arm = null;
  __fsRaceControl.fired = 0;
  __fsRaceControl.seen = 0;
  __fsRaceControl.openSeen = 0;
  __fsRaceControl.memberReadCalls = 0;
  __fsRaceControl.generationReaddirCalls = 0;
  __fsRaceControl.selectorReaddirCalls = 0;
  __fsRaceControl.selectorOpendirReads = 0;
  __fsRaceControl.selectorMutationCalls = 0;
  __fsRaceControl.memberFstatCalls = 0;
  __fsRaceControl.memberBoundedReadCalls = 0;
  __fsRaceControl.destination = null;
  __crashControl.arm = null;
  __crashControl.fired = 0;
  __publicationFault.arm = null;
  __publicationFault.fired = 0;
  __runContractFault.arm = null;
  __runContractFault.calls = 0;
  __receiptLeaseFault.arm = null;
  __receiptLeaseFault.fired = 0;
  __receiptLeaseFault.mutationCalls = 0;
  vi.useRealTimers();
  await Promise.all(
    cleanups
      .splice(0)
      .map((dir) => rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })),
  );
});

function git(cwd, ...args) {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' },
  }).trim();
}

// CJS on purpose: the scratch project has no package.json, so .js files run as
// CommonJS under the configured `node tests/value.test.js` targeted command
// (the runtime-owned red-test observation executes it).
const VALUE_V1 = 'module.exports = { value: 1 };\n';
const VALUE_V2 = 'module.exports = { value: 2 };\n';
const AUTHORED_TEST =
  "const { value } = require('../src/value.js');\n" +
  "if (value !== 2) { throw new Error('red: value is ' + value); }\n";

async function project() {
  const dir = await mkdtemp(path.join(tmpdir(), 'ape-scope-atomicity-'));
  cleanups.push(dir);
  await mkdir(path.join(dir, 'src'));
  await mkdir(path.join(dir, 'tests'));
  await writeFile(path.join(dir, 'src', 'value.js'), VALUE_V1);
  await writeFile(path.join(dir, 'tests', 'value.test.js'), 'throw new Error("placeholder");\n');
  git(dir, 'init', '-q');
  git(dir, 'config', 'user.email', 'ape@example.test');
  git(dir, 'config', 'user.name', 'APE Test');
  git(dir, 'add', '.');
  git(dir, 'commit', '-qm', 'test: baseline');
  await atomicWriteJson(runtimePaths(dir).config, {
    shipping: { auto_merge: false, provider: 'github', required_remote_checks: false },
    test_commands: {
      full: 'node -e "process.exit(0)"',
      targeted: 'node tests/value.test.js',
    },
  });
  return dir;
}

function startInput(overrides = {}) {
  return {
    objective: 'Exercise SCOPE_EXPANDED receipt atomicity across a crash',
    mode: 'phase',
    lane: 'auto',
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

function receipt(ticket, overrides = {}) {
  return {
    ticket_id: ticket.ticket_id,
    status: 'passed',
    agent_identity: `agent-${ticket.role}`,
    tests: [],
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

function capabilityReceipt(ticket, capability, requiredClaims) {
  return {
    ticket_id: ticket.ticket_id,
    status: 'failed',
    tests: [],
    findings: [],
    evidence: {
      failure_kind: 'capability',
      summary: 'The immutable worker contract lacks one exact required test path.',
      required_claims: requiredClaims,
    },
    receipt_capability: capability,
  };
}

async function nativeCapabilityTicket(dir, overrides = {}) {
  const started = await startRun(dir, startInput({
    binding_protocol: 'native-v1',
    capability_contract_required: true,
    ...overrides,
  }));
  expect(started.ok).toBe(true);
  const dispatch = started.actions.find((action) => action.type === 'dispatch_agent');
  expect(dispatch).toBeTruthy();
  const capability = await bindCodexDispatch(root, dir, dispatch);
  return { started, ticket: dispatch.ticket, capability };
}

async function runtimeSnapshot(directory, relative = '') {
  const absolute = path.join(directory, relative);
  let entries;
  try {
    entries = await readdir(absolute, { withFileTypes: true });
  } catch (error) {
    if (error?.code === 'ENOENT') return {};
    throw error;
  }
  const snapshot = {};
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    const child = relative ? path.join(relative, entry.name) : entry.name;
    if (entry.isDirectory()) {
      Object.assign(snapshot, await runtimeSnapshot(directory, child));
    } else {
      snapshot[child] = (await readFile(path.join(directory, child))).toString('base64');
    }
  }
  return snapshot;
}

function boundedTestPath(index, bytes) {
  const prefix = `tests/${index}/`;
  const suffix = '.test.js';
  const bodyBytes = bytes - Buffer.byteLength(prefix + suffix, 'utf8');
  return `${prefix}${bodyBytes % 2 === 0 ? '' : 'x'}${'é'.repeat(Math.floor(bodyBytes / 2))}${suffix}`;
}

function testPathsAt4096Bytes() {
  const paths = [
    ...Array.from({ length: 7 }, (_, index) => boundedTestPath(index, 511)),
    boundedTestPath(7, 494),
  ];
  expect(Buffer.byteLength(JSON.stringify(paths), 'utf8')).toBe(4_096);
  return paths;
}

function rawSha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

async function relativeFiles(directory, relative = '') {
  const absolute = path.join(directory, relative);
  const entries = await readdir(absolute, { withFileTypes: true });
  const files = [];
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    const child = relative ? path.join(relative, entry.name) : entry.name;
    if (entry.isDirectory()) files.push(...await relativeFiles(directory, child));
    else files.push(child);
  }
  return files;
}

async function onlyRecoveryGeneration(paths) {
  const entries = await readdir(paths.recoveryGenerations, { withFileTypes: true });
  const directories = entries.filter((entry) => entry.isDirectory());
  expect(directories).toHaveLength(1);
  return path.join(paths.recoveryGenerations, directories[0].name);
}

function selectorArtifacts(snapshot) {
  return Object.entries(snapshot)
    .filter(([name]) => {
      const normalized = name.replaceAll('\\', '/');
      return normalized.includes('recovery-selectors/') && normalized.endsWith('.json');
    })
    .map(([name, encoded]) => ({
      name,
      bytes: Buffer.from(encoded, 'base64').toString('utf8'),
      value: JSON.parse(Buffer.from(encoded, 'base64').toString('utf8')),
    }));
}

function snapshotTexts(snapshot) {
  return Object.values(snapshot).map((encoded) => Buffer.from(encoded, 'base64').toString('utf8'));
}

function semanticQuarantineContains(snapshot, { bytes, descriptor, lineageHash }) {
  const texts = snapshotTexts(snapshot);
  const joined = texts.join('\n');
  const base64 = Buffer.from(bytes).toString('base64');
  const preservesBytes = texts.includes(bytes) || joined.includes(bytes) || joined.includes(base64);
  const lineageHashes = Array.isArray(lineageHash) ? lineageHash : [lineageHash];
  return preservesBytes &&
    joined.includes(rawSha256(Buffer.from(bytes))) &&
    joined.includes(descriptor.identity.dev) &&
    joined.includes(descriptor.identity.ino) &&
    lineageHashes.some((hash) => joined.includes(hash));
}

function collectDispatchGenerations(value, ticketId, records = []) {
  if (!value || typeof value !== 'object') return records;
  if (
    value.ticket_id === ticketId &&
    Number.isSafeInteger(value.generation) &&
    typeof value.status === 'string'
  ) {
    records.push(value);
  }
  for (const child of Object.values(value)) collectDispatchGenerations(child, ticketId, records);
  return records;
}

async function dispatchGenerations(paths, ticketId) {
  const snapshot = await runtimeSnapshot(paths.dispatchIntents);
  const records = [];
  for (const text of snapshotTexts(snapshot)) {
    try {
      collectDispatchGenerations(JSON.parse(text), ticketId, records);
    } catch {
      // An unparseable intent is not a valid durable generation.
    }
  }
  return records;
}

async function preparedNativeDispatch(dir) {
  const started = await startRun(dir, startInput({
    binding_protocol: 'native-v1',
    capability_contract_required: true,
  }));
  expect(started.ok).toBe(true);
  const action = started.actions.find((candidate) => candidate.type === 'dispatch_agent');
  expect(action).toBeTruthy();
  return { started, action, paths: runtimePaths(dir) };
}

function codexLaunchInput(action, {
  sessionId = 'native-parent',
  turnId = 'native-turn-1',
  toolUseId = 'native-spawn-1',
} = {}) {
  return {
    session_id: sessionId,
    turn_id: turnId,
    tool_use_id: toolUseId,
    tool_input: {
      task_name: action.dispatch.agent_name,
      fork_turns: 'none',
      model: action.dispatch.model.model,
      reasoning_effort: action.dispatch.model.reasoning_effort,
    },
  };
}

function codexStartInput({
  sessionId = 'native-parent',
  turnId = 'native-child-turn-1',
  agentId = 'native-agent-1',
  model,
} = {}) {
  return {
    session_id: sessionId,
    turn_id: turnId,
    agent_id: agentId,
    agent_type: 'default',
    model,
  };
}

function codexBootstrapInput(action, start) {
  return {
    ...start,
    session_id: start.agent_id,
    tool_name: 'mcp__ape__ape_bind',
    tool_use_id: `bootstrap-${start.agent_id}`,
    tool_input: action.dispatch.bootstrap_args,
  };
}

async function publishCapabilityRecovery(dir, requiredClaims = { claimed_paths: ['src/generated.js'] }) {
  const { ticket, capability } = await nativeCapabilityTicket(dir);
  const payload = capabilityReceipt(ticket, capability, requiredClaims);
  const validation = await validateReceiptForDispatch(dir, payload, ticket.ticket_id);
  expect(validation).toMatchObject({ ok: true, valid: true });
  const result = await recordReceipt(dir, payload);
  expect(result.ok).toBe(true);
  return { ticket, payload, result, paths: runtimePaths(dir) };
}

async function capturedRecord(dir, payload) {
  return recordReceipt(dir, payload).then(
    (value) => ({ value, error: null }),
    (error) => ({ value: null, error }),
  );
}

function capturedMessage(outcome) {
  return outcome.error?.message ?? outcome.value?.errors?.join(' ') ?? '';
}

async function recoveryDescriptor(file) {
  const bytes = await readFile(file);
  const metadata = await lstat(file);
  return {
    raw_sha256: rawSha256(bytes),
    bytes: bytes.length,
    identity: { dev: String(metadata.dev), ino: String(metadata.ino) },
  };
}

async function replaceRecoveryManifestAndSelector(paths, generation, manifestBody) {
  const manifestFile = path.join(generation, 'manifest.json');
  const manifest = { ...manifestBody, hash: sha256(manifestBody) };
  await atomicWriteJson(manifestFile, manifest);
  const [selector] = selectorArtifacts(await runtimeSnapshot(paths.runtime));
  expect(selector).toBeTruthy();
  const { hash: _selectorHash, ...selectorBody } = selector.value;
  const reboundBody = {
    ...selectorBody,
    generation: manifest.generation,
    manifest_hash: manifest.hash,
    manifest_binding: await recoveryDescriptor(manifestFile),
    prepared_effect_hash: manifest.prepared_effect_hash,
  };
  const rebound = { ...reboundBody, hash: sha256(reboundBody) };
  const oldSlot = path.join(paths.runtime, selector.name);
  const newSlot = path.join(paths.recoverySelectors, `${rebound.hash}.json`);
  await atomicWriteJson(newSlot, rebound);
  if (newSlot !== oldSlot) await rm(oldSlot, { force: true });
  return rebound;
}

async function forgeAdoptedRecoveryModel(paths, model) {
  const generation = await onlyRecoveryGeneration(paths);
  const manifestFile = path.join(generation, 'manifest.json');
  const manifest = await readJson(manifestFile);
  const memberNames = Object.keys(manifest.members);
  const transactionName = memberNames.find((name) =>
    name.startsWith('receipt-transactions/'));
  const ticketName = memberNames.find((name) => name.startsWith('tickets/'));
  const runName = memberNames.find((name) => name.startsWith('runs/'));
  expect(transactionName).toBeTruthy();
  expect(ticketName).toBeTruthy();
  expect(runName).toBeTruthy();

  const transaction = await readJson(path.join(generation, transactionName));
  const effect = structuredClone(transaction.prepared_effect);
  const { ticket_hash: _ticketHash, ...successorBody } = effect.successor_contract;
  const successorMaterial = { ...successorBody, model: structuredClone(model) };
  const successor = { ...successorMaterial, ticket_hash: sha256(successorMaterial) };
  const { hash: _generationHash, ...generationBody } = effect.recovery_generation;
  const nextGenerationBody = {
    ...generationBody,
    successor_ticket_hash: successor.ticket_hash,
  };
  const nextGeneration = {
    ...nextGenerationBody,
    hash: sha256(nextGenerationBody),
  };
  effect.policy.model = structuredClone(model);
  effect.successor_contract = successor;
  effect.recovery_generation = nextGeneration;
  const forgedTransaction = {
    ...transaction,
    prepared_effect: effect,
    prepared_effect_hash: sha256(effect),
  };
  const active = await readJson(path.join(generation, 'active.json'));
  const forgedActive = {
    ...active,
    recovery_generation: nextGeneration,
    tickets: active.tickets.map((entry) =>
      entry.ticket_id === successor.ticket_id ? successor : entry),
  };
  const changedMembers = {
    'active.json': forgedActive,
    [runName]: forgedActive,
    [ticketName]: successor,
    [transactionName]: forgedTransaction,
  };
  for (const [name, value] of Object.entries(changedMembers)) {
    await atomicWriteJson(path.join(generation, name), value);
  }
  const members = structuredClone(manifest.members);
  for (const name of Object.keys(changedMembers)) {
    members[name] = await recoveryDescriptor(path.join(generation, name));
  }
  const { hash: _manifestHash, ...manifestBody } = manifest;
  const rebound = await replaceRecoveryManifestAndSelector(paths, generation, {
    ...manifestBody,
    generation: nextGeneration,
    prepared_effect_hash: forgedTransaction.prepared_effect_hash,
    members,
  });
  const { hash: _reboundHash, ...reboundBody } = rebound;
  const reboundWithTarget = {
    ...reboundBody,
    target: {
      ...reboundBody.target,
      successor_ticket_hash: successor.ticket_hash,
    },
  };
  const finalSelector = {
    ...reboundWithTarget,
    hash: sha256(reboundWithTarget),
  };
  const reboundSlot = path.join(paths.recoverySelectors, `${rebound.hash}.json`);
  const finalSlot = path.join(paths.recoverySelectors, `${finalSelector.hash}.json`);
  await atomicWriteJson(finalSlot, finalSelector);
  if (finalSlot !== reboundSlot) await rm(reboundSlot, { force: true });

  await atomicWriteJson(paths.active, forgedActive);
  await atomicWriteJson(path.join(paths.runs, path.basename(runName)), forgedActive);
  await atomicWriteJson(path.join(paths.tickets, path.basename(ticketName)), successor);
  await atomicWriteJson(
    path.join(paths.receiptTransactions, path.basename(transactionName)),
    forgedTransaction,
  );
  const renamedGeneration = path.join(
    paths.recoveryGenerations,
    [String(nextGeneration.generation).padStart(8, '0'), nextGeneration.hash].join('-'),
  );
  await rename(generation, renamedGeneration);
  return { forgedActive, forgedTransaction, generation: renamedGeneration };
}

const redTest = [{ command: 'node tests/value.test.js', passed: false, exit_code: 1, duration_ms: 1 }];
const greenTest = [{ command: 'node tests/value.test.js', passed: true, exit_code: 0, duration_ms: 1 }];

// Tickets awaiting a receipt: the run's forward path. An idle wedged run has
// none while still 'running'.
function pendingTickets(state) {
  const receipted = new Set(state.receipts.map((entry) => entry.ticket_id));
  const expired = new Set(state.expired_tickets ?? []);
  return state.tickets.filter(
    (ticket) => !receipted.has(ticket.ticket_id) && !expired.has(ticket.ticket_id),
  );
}

// Drive a clean fast-lane run to its review stage: authored red test (the
// runtime observes it), green build. Mirrors the scope-expansion suite.
async function walkToReview(dir) {
  const started = await startRun(dir, startInput());
  expect(started.ok).toBe(true);
  expect(started.run.lane).toBe('fast');
  const testTicket = started.run.tickets[0];
  expect(testTicket.role).toBe('test_writer');
  await writeFile(path.join(dir, 'tests', 'value.test.js'), AUTHORED_TEST);
  const tested = await recordReceipt(dir, receipt(testTicket, { tests: redTest }));
  expect(tested.ok).toBe(true);
  const buildTicket = tested.run.tickets.at(-1);
  expect(buildTicket.role).toBe('implementer');
  await writeFile(path.join(dir, 'src', 'value.js'), VALUE_V2);
  const built = await recordReceipt(dir, receipt(buildTicket, { tests: greenTest }));
  expect(built.ok).toBe(true);
  const reviewTicket = built.run.tickets.at(-1);
  expect(reviewTicket.stage_id).toBe('review');
  return { reviewTicket };
}

// Record the receipt with the crash armed on the first active.json snapshot
// that contains it. The armed write COMPLETES, then the call dies — the exact
// SIGKILL-after-persist window. Returns the crashed call's outcome.
async function recordWithCrash(dir, ticketId, payload) {
  const paths = runtimePaths(dir);
  __crashControl.arm = { file: paths.active, ticket_id: ticketId };
  const outcome = await recordReceipt(dir, payload).then(
    (value) => ({ resolved: true, value }),
    (error) => ({ resolved: false, error }),
  );
  // Harness sanity, true for any implementation of the contract: recording a
  // receipt must at some point make it durable in active.json, so the armed
  // crash fires exactly once and the client never saw a success.
  expect(__crashControl.fired).toBe(1);
  expect(__crashControl.arm).toBe(null);
  if (outcome.resolved) expect(outcome.value.ok).not.toBe(true);
  return outcome;
}

describe('APE v2 SCOPE_EXPANDED receipt atomicity across a crash (audit 1.3, invariant 1)', () => {
  it('risk-trigger escalation on the test receipt: the identical retry after the crash resumes the pipeline instead of resting the run idle', async () => {
    const dir = await project();
    const paths = runtimePaths(dir);
    const started = await startRun(dir, startInput());
    expect(started.ok).toBe(true);
    expect(started.run.lane).toBe('fast');
    const testTicket = started.run.tickets[0];
    expect(testTicket.role).toBe('test_writer');
    await writeFile(path.join(dir, 'tests', 'value.test.js'), AUTHORED_TEST);

    // The test receipt reports a canonical risk trigger: new risk + lane
    // escalation, the SCOPE_EXPANDED route with no scheduling side channel.
    const payload = receipt(testTicket, {
      tests: redTest,
      evidence: { verdict: 'pass', risk_triggers: ['security'] },
    });
    await recordWithCrash(dir, testTicket.ticket_id, payload);

    // The crash left the receipt durable in active state — the client's ONLY
    // sanctioned recovery is retrying the identical record call.
    const crashedState = await readJson(paths.active);
    expect(crashedState.receipts.some((entry) => entry.ticket_id === testTicket.ticket_id)).toBe(true);

    const retry = await recordReceipt(dir, payload);
    expect(retry.ok).toBe(true);
    expect(retry.receipt.ticket_id).toBe(testTicket.ticket_id);

    // Scope consequences are durable: trigger recorded, high_risk armed, lane
    // escalated over the reported risk.
    const active = await readJson(paths.active);
    expect(active.risk_triggers).toContain('security');
    expect(active.high_risk).toBe(true);
    expect(active.lane).toBe('full');

    // The red anchor — pipeline consequences too: the run is 'running' WITH a
    // dispatchable successor (the implementer stage that follows the test
    // stage), never every-ticket-receipted idle. On the current tree the
    // retry returns recovered/actions:[] and no successor ever exists.
    expect(active.status).toBe('running');
    const pending = pendingTickets(active);
    expect(pending.length).toBeGreaterThan(0);
    expect(
      pending.some((ticket) => ticket.stage_id === 'build' && ticket.role === 'implementer'),
    ).toBe(true);

    // NEXT dispatches the successor rather than echoing an idle run.
    const next = await nextRun(dir);
    expect(next.ok).toBe(true);
    const kinds = next.actions.map((action) => action.type);
    expect(kinds.some((kind) => kind === 'dispatch_agent' || kind === 'dispatch_pending')).toBe(true);
    expect(kinds).not.toContain('status');

    // Convergence is at-most-once: a further identical retry must not issue a
    // duplicate successor or duplicate the receipt (invariants 5/7).
    const before = await readJson(paths.active);
    const retryAgain = await recordReceipt(dir, payload);
    expect(retryAgain.ok).toBe(true);
    const after = await readJson(paths.active);
    expect(after.tickets.length).toBe(before.tickets.length);
    expect(after.receipts.length).toBe(before.receipts.length);
  });

  it('review-proposed scope expansion: the identical retry after the crash opens the remediation cycle with the grown claim set', async () => {
    const dir = await project();
    const paths = runtimePaths(dir);
    const { reviewTicket } = await walkToReview(dir);

    // Blocking review naming an out-of-claims path: the D3 proposedClaims
    // route into SCOPE_EXPANDED, whose RECEIPT_RECORDED consequence is the
    // remediation-build ticket inheriting the expanded allowlist.
    const payload = receipt(reviewTicket, {
      tests: greenTest,
      findings: [{
        file: 'lib/helper.js',
        line: 1,
        title: 'expand production scope',
        detail: 'the fix must also touch lib/helper.js',
        blocking: true,
        remediation: { owner: 'production' },
      }],
      evidence: {
        verdict: 'fail',
        scope_expansion: { claimed_paths: ['lib/helper.js'], reason: 'the fix requires this module' },
      },
    });
    await recordWithCrash(dir, reviewTicket.ticket_id, payload);

    const retry = await recordReceipt(dir, payload);
    expect(retry.ok).toBe(true);

    // The run converges: grown claims durable AND the single remediation
    // cycle opened with its ticket inheriting the expansion — not a
    // recovered-empty response over an idle run with zero cycles consumed.
    const active = await readJson(paths.active);
    expect(active.status).toBe('running');
    expect(active.claimed_paths).toContain('lib/helper.js');
    expect(active.remediation_cycles).toBe(1);
    const remediation = pendingTickets(active).find(
      (ticket) => ticket.stage_id === 'remediation-build',
    );
    expect(remediation).toBeTruthy();
    expect(remediation.claimed_paths).toContain('lib/helper.js');

    // The override-class audit of the claim growth survived the crash.
    const audits = (await readFile(paths.overrideLog, 'utf8').catch(() => ''))
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line))
      .filter((line) => line.operation === 'scope-expansion');
    expect(audits.length).toBeGreaterThanOrEqual(1);
    expect(audits[0].added_paths).toEqual(['lib/helper.js']);

    // At-most-once: another identical retry must not double-consume the
    // single remediation cycle or issue a duplicate remediation ticket.
    const retryAgain = await recordReceipt(dir, payload);
    expect(retryAgain.ok).toBe(true);
    const after = await readJson(paths.active);
    expect(after.remediation_cycles).toBe(1);
    expect(after.tickets.length).toBe(active.tickets.length);
    expect(after.receipts.length).toBe(active.receipts.length);
  });
});

describe('APE v2 bounded capability-recovery publication', () => {
  it.each([
    [
      'the 65th canonical test path',
      Array.from({ length: 64 }, (_, index) => `tests/generated-${String(index).padStart(2, '0')}.test.js`),
      'tests/generated-64.test.js',
      /64|test_paths.*bound/i,
    ],
    [
      'the 4097th serialized UTF-8 byte',
      testPathsAt4096Bytes(),
      'tests/one-byte-too-many.test.js',
      /4096|test_paths.*bound/i,
    ],
    [
      'an absolute out-of-project test path',
      ['tests/value.test.js'],
      '/tmp/ape-outside.test.js',
      /canonical|contained|project.relative|outside/i,
    ],
    [
      'a parent-relative out-of-project test path',
      ['tests/value.test.js'],
      '../outside.test.js',
      /canonical|contained|project.relative|outside/i,
    ],
    [
      'a reserved runtime test path',
      ['tests/value.test.js'],
      '.ape/runtime/forged.test.js',
      /canonical|reserved|\.ape|runtime/i,
    ],
    [
      'an option-like test-runner argument',
      ['tests/value.test.js'],
      '--runInBand',
      /canonical|option|project.relative|test.path/i,
    ],
    [
      'the project root rather than a test path',
      ['tests/value.test.js'],
      '.',
      /canonical|project.relative|root|test.path/i,
    ],
    [
      'a canonical alias duplicate',
      ['tests/value.test.js'],
      'tests/./value.test.js',
      /canonical|duplicate|unique/i,
    ],
    [
      'a Windows drive-relative path',
      ['tests/value.test.js'],
      'C:relative.test.js',
      /canonical|drive|windows|project.relative|contained/i,
    ],
    [
      'a Windows UNC path',
      ['tests/value.test.js'],
      String.raw`\\server\share\added.test.js`,
      /canonical|UNC|windows|project.relative|contained/i,
    ],
    [
      'a Windows device path',
      ['tests/value.test.js'],
      String.raw`\\?\C:\tests\added.test.js`,
      /canonical|device|windows|project.relative|contained/i,
    ],
    [
      'a Windows alternate-data-stream path',
      ['tests/value.test.js'],
      'tests/added.test.js:payload',
      /canonical|alternate.data|stream|windows|project.relative/i,
    ],
    [
      'a case-folded Windows alias of the reserved runtime directory',
      ['tests/value.test.js'],
      '.APE/runtime/forged.test.js',
      /canonical|reserved|\.ape|runtime/i,
    ],
    [
      'a control-character path',
      ['tests/value.test.js'],
      `tests/added${String.fromCharCode(1)}.test.js`,
      /control|canonical|project.relative/i,
    ],
  ])('rejects %s before every persistent sink', async (
    _label,
    initialTestPaths,
    addedPath,
    expectedError,
  ) => {
    const dir = await project();
    const { ticket, capability } = await nativeCapabilityTicket(dir, {
      test_paths: initialTestPaths,
    });
    const payload = capabilityReceipt(ticket, capability, {
      test_paths: [addedPath],
    });
    const validation = await validateReceiptForDispatch(dir, payload, ticket.ticket_id);
    expect(validation).toMatchObject({
      ok: true,
      valid: false,
      attested: false,
      dynamic_test_paths: expect.objectContaining({
        max_items: 64,
        max_bytes: 4_096,
      }),
    });
    expect(validation.corrections.map((entry) => entry.issue).join(' '))
      .toMatch(expectedError);
    const paths = runtimePaths(dir);
    const before = await runtimeSnapshot(paths.runtime);

    const attempted = await recordReceipt(dir, payload);

    expect(attempted).toMatchObject({ ok: false, rejected: true });
    expect(attempted.errors.join(' ')).toMatch(expectedError);
    expect(await runtimeSnapshot(paths.runtime)).toEqual(before);
  });

  it.each([
    [
      'an existing production claim by case only',
      ['src/Feature.js'],
      ['src/feature.js'],
    ],
    [
      'two additive production claims that collide by case only',
      ['src/value.js'],
      ['src/Generated.js', 'src/generated.js'],
    ],
  ])('rejects %s in the portable canonical namespace before persistence', async (
    _label,
    sourceClaims,
    addedClaims,
  ) => {
    const dir = await project();
    const { ticket, capability } = await nativeCapabilityTicket(dir, {
      claimed_paths: sourceClaims,
    });
    const payload = capabilityReceipt(ticket, capability, {
      claimed_paths: addedClaims,
    });

    const validation = await validateReceiptForDispatch(dir, payload, ticket.ticket_id);
    expect(validation).toMatchObject({
      ok: true,
      valid: false,
      attested: false,
    });
    expect(validation.corrections.map((entry) => entry.issue).join(' '))
      .toMatch(/case|collision|duplicate|canonical|portable/i);
    const paths = runtimePaths(dir);
    const before = await runtimeSnapshot(paths.runtime);

    const attempted = await recordReceipt(dir, payload);

    expect(attempted).toMatchObject({ ok: false, rejected: true });
    expect(attempted.errors.join(' '))
      .toMatch(/case|collision|duplicate|canonical|portable/i);
    expect(await runtimeSnapshot(paths.runtime)).toEqual(before);
  });

  it('requires the genuine exact dispatch attestation before capability recovery mutates a sink', async () => {
    const dir = await project();
    const { ticket, capability } = await nativeCapabilityTicket(dir);
    const payload = capabilityReceipt(ticket, capability, {
      claimed_paths: ['src/requires-real-attestation.js'],
    });
    const paths = runtimePaths(dir);
    const before = await runtimeSnapshot(paths.runtime);

    // A schema-valid draft and the real bearer are still only untrusted input.
    // Deliberately skip validateReceiptForDispatch: record must not synthesize
    // the missing exact-input attestation on behalf of the worker.
    const attempted = await capturedRecord(dir, payload);

    expect(attempted.value?.ok).not.toBe(true);
    expect(capturedMessage(attempted)).toMatch(/attest|pre-validat|dispatch|exact input/i);
    expect(await runtimeSnapshot(paths.runtime)).toEqual(before);
  });

  it('rejects a runtime-derived run-contract rebind before persisting the prepared transaction', async () => {
    const dir = await project();
    const { ticket, capability } = await nativeCapabilityTicket(dir);
    const payload = capabilityReceipt(ticket, capability, {
      claimed_paths: ['src/generated.js'],
    });
    const validation = await validateReceiptForDispatch(dir, payload, ticket.ticket_id);
    expect(validation).toMatchObject({ ok: true, valid: true });
    const paths = runtimePaths(dir);
    const before = await runtimeSnapshot(paths.runtime);

    // The first canonical run-contract derivation is made self-consistent but
    // false. A second derivation from durable inputs exposes the mismatch. The
    // detector must run before the prepared-transaction sink, so rejection is
    // byte-for-byte inert even though every outer hash can be recomputed.
    __runContractFault.arm = 'rebind-first-pointer';
    const attempted = await recordReceipt(dir, payload);
    __runContractFault.arm = null;

    expect(__runContractFault.calls).toBeGreaterThanOrEqual(2);
    expect(attempted).toMatchObject({ ok: false, rejected: true });
    expect(attempted.errors.join(' ')).toMatch(/run contract|runtime-derived|binding/i);
    expect(await runtimeSnapshot(paths.runtime)).toEqual(before);
  });

  it('preserves source test-path bytes and order before the exact additive order', async () => {
    const dir = await project();
    const source = ['tests/source-z.test.js', 'tests/source-a.test.js'];
    const added = ['tests/add-z.test.js', 'tests/add-a.test.js'];
    const { ticket, capability } = await nativeCapabilityTicket(dir, { test_paths: source });
    const payload = capabilityReceipt(ticket, capability, { test_paths: added });
    expect(await validateReceiptForDispatch(dir, payload, ticket.ticket_id))
      .toMatchObject({ ok: true, valid: true });

    const recovered = await recordReceipt(dir, payload);
    expect(recovered.ok).toBe(true);
    const successor = recovered.actions.find((action) => action.type === 'dispatch_agent')?.ticket;
    expect(successor?.test_paths).toEqual([...source, ...added]);
    expect((await readJson(runtimePaths(dir).active)).test_paths).toEqual([...source, ...added]);
  });

  it('publishes the prospective full lane when additive scope exceeds the frozen fast bound', async () => {
    const dir = await project();
    const { ticket, capability } = await nativeCapabilityTicket(dir, {
      lane: 'fast',
      claimed_paths: ['src/value.js'],
    });
    const added = Array.from({ length: 6 }, (_, index) => `src/generated-${index}.js`);
    const payload = capabilityReceipt(ticket, capability, { claimed_paths: added });
    const validation = await validateReceiptForDispatch(dir, payload, ticket.ticket_id);
    expect(validation).toMatchObject({ ok: true, valid: true });

    const recovered = await recordReceipt(dir, payload);
    expect(recovered.ok).toBe(true);
    const active = await readJson(runtimePaths(dir).active);
    const successor = recovered.actions.find((action) => action.type === 'dispatch_agent')?.ticket;
    const transactionFiles = await readdir(runtimePaths(dir).receiptTransactions);
    expect(transactionFiles).toHaveLength(1);
    const transaction = await readJson(
      path.join(runtimePaths(dir).receiptTransactions, transactionFiles[0]),
    );

    expect(active.lane).toBe('full');
    expect(recovered.run.lane).toBe('full');
    expect(transaction.prepared_effect.lane).toBe('full');
    expect(successor?.claimed_paths).toEqual(['src/value.js', ...added]);
    expect(successor?.required_checks).toEqual(ticket.required_checks);
    expect(successor?.capability_manifest.risk_triggers)
      .toEqual(active.risk_triggers);
  });

  it.each(['contracts', 'receipts', 'tickets'])(
    'a crash on a separately published canonical %s file exposes only an old or new complete generation',
    async (directoryKey) => {
      const dir = await project();
      const { ticket, capability } = await nativeCapabilityTicket(dir);
      const payload = capabilityReceipt(ticket, capability, {
        claimed_paths: ['src/generated.js'],
      });
      const validation = await validateReceiptForDispatch(dir, payload, ticket.ticket_id);
      expect(validation).toMatchObject({ ok: true, valid: true });
      const paths = runtimePaths(dir);
      const before = {
        active: await readJson(paths.active),
        contracts: await runtimeSnapshot(paths.contracts),
        receipts: await runtimeSnapshot(paths.receipts),
        tickets: await runtimeSnapshot(paths.tickets),
      };

      __crashControl.arm = {
        kind: 'canonical-recovery-file',
        directory: paths[directoryKey],
      };
      const outcome = await recordReceipt(dir, payload).then(
        (value) => ({ value, error: null }),
        (error) => ({ value: null, error }),
      );
      const crashed = __crashControl.fired === 1;
      __crashControl.arm = null;
      if (crashed) expect(outcome.error).toBeInstanceOf(Error);
      else expect(outcome.value).toMatchObject({ ok: true });

      const observed = await readJson(paths.active);
      const adopted = observed.receipts.some((entry) => entry.ticket_id === ticket.ticket_id);
      if (!adopted) {
        expect(observed).toEqual(before.active);
        expect(await runtimeSnapshot(paths.contracts)).toEqual(before.contracts);
        expect(await runtimeSnapshot(paths.receipts)).toEqual(before.receipts);
        expect(await runtimeSnapshot(paths.tickets)).toEqual(before.tickets);
      } else {
        const sourceReceipt = observed.receipts.find(
          (entry) => entry.ticket_id === ticket.ticket_id,
        );
        const successor = observed.tickets.find(
          (entry) => entry.ticket_id !== ticket.ticket_id,
        );
        expect(sourceReceipt).toBeTruthy();
        expect(successor).toBeTruthy();
        expect(observed.recovery_generation).toMatchObject({
          source_ticket_hash: ticket.ticket_hash,
          successor_ticket_id: successor.ticket_id,
          successor_ticket_hash: successor.ticket_hash,
        });
        expect(await readJson(
          path.join(paths.receipts, `${sourceReceipt.receipt_id}.json`),
          null,
        )).toEqual(sourceReceipt);
        expect(await readJson(
          path.join(paths.tickets, `${successor.ticket_id.replaceAll(':', '_')}.json`),
          null,
        )).toEqual(successor);
        expect(validateTicket(successor)).toMatchObject({ valid: true });
        await expect(
          readRunContractManifest(paths, successor.capability_manifest.run_contract),
        ).resolves.toBeTruthy();
      }

      const replay = await recordReceipt(dir, payload);
      expect(replay.ok).toBe(true);
      const converged = await readJson(paths.active);
      expect(converged.receipts.filter((entry) => entry.ticket_id === ticket.ticket_id))
        .toHaveLength(1);
      expect(converged.tickets.filter((entry) => entry.ticket_id !== ticket.ticket_id))
        .toHaveLength(1);
    },
  );

  it('serializes two cooperating writers into one successor contract and one generation', async () => {
    const dir = await project();
    const { ticket, capability } = await nativeCapabilityTicket(dir);
    const payload = capabilityReceipt(ticket, capability, {
      test_paths: ['tests/generated.test.js'],
    });
    const firstInvalid = await validateReceiptForDispatch(
      dir,
      { ...payload, status: 'success' },
      ticket.ticket_id,
    );
    const secondInvalid = await validateReceiptForDispatch(
      dir,
      { ...payload, unsupported_worker_field: true },
      ticket.ticket_id,
    );
    expect(firstInvalid).toMatchObject({ ok: true, valid: false });
    expect(secondInvalid).toMatchObject({ ok: true, valid: false });
    const validation = await validateReceiptForDispatch(dir, payload, ticket.ticket_id);
    expect(validation).toMatchObject({ ok: true, valid: true });

    const results = await Promise.all([
      recordReceipt(dir, payload),
      recordReceipt(dir, payload),
    ]);
    expect(results.every((result) => result.ok === true)).toBe(true);

    const active = await readJson(runtimePaths(dir).active);
    const sourceReceipts = active.receipts.filter((entry) => entry.ticket_id === ticket.ticket_id);
    const successors = active.tickets.filter((entry) => entry.ticket_id !== ticket.ticket_id);
    expect(sourceReceipts).toHaveLength(1);
    expect(successors).toHaveLength(1);
    const successorDispatches = results.flatMap((result) =>
      result.actions.filter((action) => action.type === 'dispatch_agent'));
    expect(successorDispatches.length).toBeGreaterThan(0);
    expect([...new Set(successorDispatches.map((action) => action.ticket.ticket_id))])
      .toEqual([successors[0].ticket_id]);
    expect(successorDispatches[0]).toMatchObject({
      recovery_kind: 'capability_scope_expansion',
      source_ticket_id: ticket.ticket_id,
      ticket: successors[0],
    });
    expect(projectRunResponse(
      results.find((result) => result.actions.some((action) => action.type === 'dispatch_agent')),
    ).next_action).toMatchObject({
      kind: 'capability_recovery',
      recovery_kind: 'capability_scope_expansion',
      ticket_ids: [successors[0].ticket_id],
      consumes_product_attempt: false,
    });
    expect(active.status).toBe('running');
    expect(active.test_paths).toContain('tests/generated.test.js');
    expect(successors[0]).toMatchObject({
      schema_version: ticket.schema_version,
      run_id: active.run_id,
      stage_id: ticket.stage_id,
      role: ticket.role,
      objective: ticket.objective,
      claimed_paths: ticket.claimed_paths,
      attempt: ticket.attempt,
      base_tree_sha: ticket.base_tree_sha,
      parent_hash: sourceReceipts[0].receipt_hash,
      receipt_contract_version: ticket.receipt_contract_version,
      test_paths: expect.arrayContaining(['tests/generated.test.js']),
      required_checks: ticket.required_checks,
      risk_triggers: ticket.risk_triggers,
      model_tier: ticket.model_tier,
      model: ticket.model,
      issued_at: expect.any(String),
      deadline_at: expect.any(String),
      writable: ticket.writable,
      recovery_lineage: {
        source_ticket_id: ticket.ticket_id,
        validation_submissions: 3,
        physical_workers: 1,
        validation_submissions_per_worker: 3,
        max_physical_workers: 2,
      },
      recovery_provenance: {
        authority: 'runtime',
        source_ticket_id: ticket.ticket_id,
        source_ticket_hash: ticket.ticket_hash,
        source_receipt_id: sourceReceipts[0].receipt_id,
        source_receipt_hash: sourceReceipts[0].receipt_hash,
        receipt_input_hash: expect.stringMatching(/^[0-9a-f]{64}$/),
        source_issued_at: ticket.issued_at,
        source_deadline_at: ticket.deadline_at,
        derived_at: expect.any(String),
      },
      capability_manifest: {
        field_bounds: {
          validation_attempts_per_worker: 3,
          max_physical_workers_per_ticket: 2,
          corrections_per_validation: 20,
          dynamic_test_paths: {
            max_items: 64,
            max_serialized_utf8_bytes: 4_096,
          },
        },
        byte_budgets: ticket.capability_manifest.byte_budgets,
        run_contract: expect.any(Object),
      },
    });
    expect(validateTicket(successors[0])).toMatchObject({ valid: true });
    expect(Date.parse(successors[0].deadline_at))
      .toBeGreaterThan(Date.parse(successors[0].issued_at));
    expect(successors[0].ticket_id).toMatch(
      new RegExp(`^${active.run_id}:${ticket.stage_id}:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$`),
    );
    expect(active.recovery_generation).toMatchObject({
      version: 1,
      generation: 1,
      previous: null,
      source_ticket_hash: ticket.ticket_hash,
      successor_ticket_id: successors[0].ticket_id,
      successor_ticket_hash: successors[0].ticket_hash,
      hash: expect.stringMatching(/^[0-9a-f]{64}$/),
    });
    expect(active.run_contract).toEqual(successors[0].capability_manifest.run_contract);
    const runContract = await readRunContractManifest(runtimePaths(dir), active.run_contract);
    expect(
      runContract.receipt_contract.ticket_contracts
        .filter((entry) => entry.ticket_id === successors[0].ticket_id),
    ).toHaveLength(1);

    const ticketFiles = (await readdir(runtimePaths(dir).tickets))
      .filter((entry) => entry.endsWith('.json'));
    expect(ticketFiles).toContain(`${successors[0].ticket_id.replaceAll(':', '_')}.json`);
    expect(ticketFiles.filter((entry) => entry !== `${ticket.ticket_id.replaceAll(':', '_')}.json`))
      .toHaveLength(1);
  });

  it('replays a crash after the complete prepared envelope without regenerating its successor', async () => {
    const dir = await project();
    const { ticket, capability } = await nativeCapabilityTicket(dir);
    const payload = capabilityReceipt(ticket, capability, {
      claimed_paths: ['src/generated.js'],
    });
    const validation = await validateReceiptForDispatch(dir, payload, ticket.ticket_id);
    expect(validation).toMatchObject({ ok: true, valid: true });
    const paths = runtimePaths(dir);
    const before = await readJson(paths.active);

    __crashControl.arm = { kind: 'prepared-transaction' };
    const crashed = await recordReceipt(dir, payload).then(
      (value) => ({ value }),
      (error) => ({ error }),
    );
    expect(__crashControl.fired).toBe(1);
    expect(crashed.error).toBeInstanceOf(Error);
    expect(crashed.error.message).toMatch(/simulated crash/);
    expect(await readJson(paths.active)).toEqual(before);

    const transactions = await readdir(paths.receiptTransactions);
    expect(transactions).toHaveLength(1);
    const prepared = await readJson(path.join(paths.receiptTransactions, transactions[0]));
    expect(prepared).toMatchObject({
      version: 2,
      run_id: before.run_id,
      ticket_id: ticket.ticket_id,
      input_hash: expect.stringMatching(/^[0-9a-f]{64}$/),
      status: 'prepared',
      prepared_at: expect.any(String),
      receipt: expect.objectContaining({
        ticket_id: ticket.ticket_id,
        ticket_hash: ticket.ticket_hash,
        receipt_hash: expect.stringMatching(/^[0-9a-f]{64}$/),
      }),
      prepared_effect: {
        source: {
          run_id: before.run_id,
          ticket_id: ticket.ticket_id,
          ticket_hash: ticket.ticket_hash,
          stage_id: ticket.stage_id,
          role: ticket.role,
          attempt: ticket.attempt,
        },
        scope: {
          source: {
            claimed_paths: ticket.claimed_paths,
            test_paths: ticket.test_paths,
          },
          successor: {
            claimed_paths: [...ticket.claimed_paths, 'src/generated.js'],
            test_paths: ticket.test_paths,
          },
        },
        policy: {
          role: ticket.role,
          writable: ticket.writable,
          required_checks: ticket.required_checks,
          model_tier: ticket.model_tier,
          model: ticket.model,
        },
        lane: before.lane,
        risk_triggers: before.risk_triggers,
        orchestration: expect.any(Object),
        timing: {
          source_issued_at: ticket.issued_at,
          source_deadline_at: ticket.deadline_at,
          successor_issued_at: expect.any(String),
          successor_deadline_at: expect.any(String),
          prepared_at: expect.any(String),
        },
        byte_budgets: ticket.capability_manifest.byte_budgets,
        field_bounds: ticket.capability_manifest.field_bounds,
        capability_manifest: expect.any(Object),
        run_contract: expect.any(Object),
        recovery: {
          validation_submissions: 1,
          physical_workers: 1,
        },
        successor_contract: expect.objectContaining({
          run_id: before.run_id,
          stage_id: ticket.stage_id,
          role: ticket.role,
          parent_hash: prepared.receipt.receipt_hash,
          claimed_paths: [...ticket.claimed_paths, 'src/generated.js'],
          test_paths: ticket.test_paths,
          issued_at: expect.any(String),
          deadline_at: expect.any(String),
          recovery_lineage: {
            source_ticket_id: ticket.ticket_id,
            validation_submissions: 1,
            physical_workers: 1,
            validation_submissions_per_worker: 3,
            max_physical_workers: 2,
          },
          recovery_provenance: {
            authority: 'runtime',
            source_ticket_id: ticket.ticket_id,
            source_ticket_hash: ticket.ticket_hash,
            source_receipt_id: prepared.receipt.receipt_id,
            source_receipt_hash: prepared.receipt.receipt_hash,
            receipt_input_hash: prepared.input_hash,
            source_issued_at: ticket.issued_at,
            source_deadline_at: ticket.deadline_at,
            derived_at: expect.any(String),
          },
          capability_manifest: expect.objectContaining({
            run_contract: expect.any(Object),
          }),
          ticket_hash: expect.stringMatching(/^[0-9a-f]{64}$/),
        }),
      },
      prepared_effect_hash: expect.stringMatching(/^[0-9a-f]{64}$/),
    });
    const preparedSuccessor = prepared.prepared_effect.successor_contract;
    expect(prepared.prepared_effect.capability_manifest)
      .toEqual(preparedSuccessor.capability_manifest);
    expect(prepared.prepared_effect.run_contract)
      .toEqual(preparedSuccessor.capability_manifest.run_contract);
    expect(prepared.prepared_effect.timing.successor_issued_at)
      .toBe(preparedSuccessor.issued_at);
    expect(prepared.prepared_effect.timing.successor_deadline_at)
      .toBe(preparedSuccessor.deadline_at);
    expect(preparedSuccessor.ticket_id).toMatch(
      new RegExp(`^${before.run_id}:${ticket.stage_id}:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$`),
    );
    expect(validateTicket(preparedSuccessor)).toMatchObject({ valid: true });

    const replay = await recordReceipt(dir, payload);
    expect(replay.ok).toBe(true);
    const active = await readJson(paths.active);
    expect(active.status).toBe('running');
    expect(active.receipts.filter((entry) => entry.ticket_id === ticket.ticket_id)).toHaveLength(1);
    const successors = active.tickets.filter((entry) => entry.ticket_id !== ticket.ticket_id);
    expect(successors).toHaveLength(1);
    expect(successors[0]).toEqual(preparedSuccessor);
    expect(await readJson(
      path.join(paths.tickets, `${preparedSuccessor.ticket_id.replaceAll(':', '_')}.json`),
    )).toEqual(preparedSuccessor);

    const replayAgain = await recordReceipt(dir, payload);
    expect(replayAgain.ok).toBe(true);
    const converged = await readJson(paths.active);
    expect(converged.tickets).toEqual(active.tickets);
    expect(converged.receipts).toEqual(active.receipts);
    expect(converged.recovery_generation).toEqual(active.recovery_generation);
  });

  it('adopts the one published capability generation after response-loss instead of minting again', async () => {
    const dir = await project();
    const { ticket, capability } = await nativeCapabilityTicket(dir);
    const payload = capabilityReceipt(ticket, capability, {
      claimed_paths: ['src/recovered.js'],
    });
    const validation = await validateReceiptForDispatch(dir, payload, ticket.ticket_id);
    expect(validation).toMatchObject({ ok: true, valid: true });

    await recordWithCrash(dir, ticket.ticket_id, payload);
    const paths = runtimePaths(dir);
    const published = await readJson(paths.active);
    expect(published.receipts.filter((entry) => entry.ticket_id === ticket.ticket_id)).toHaveLength(1);

    const replay = await recordReceipt(dir, payload);
    expect(replay.ok).toBe(true);
    const adopted = await readJson(paths.active);
    const successors = adopted.tickets.filter((entry) => entry.ticket_id !== ticket.ticket_id);
    expect(adopted.status).toBe('running');
    expect(successors).toHaveLength(1);
    expect(successors[0].claimed_paths).toContain('src/recovered.js');
    expect(adopted.recovery_generation).toEqual(published.recovery_generation);

    const replayAgain = await recordReceipt(dir, payload);
    expect(replayAgain.ok).toBe(true);
    const finalState = await readJson(paths.active);
    expect(finalState.tickets).toEqual(adopted.tickets);
    expect(finalState.receipts).toEqual(adopted.receipts);
    expect(finalState.recovery_generation).toEqual(adopted.recovery_generation);
  });
});

describe('APE v2 exact recovery generations and selector authority', () => {
  it('binds an exact bounded regular-file manifest to raw bytes, hashes, and filesystem identity', async () => {
    const dir = await project();
    const { ticket, result, paths } = await publishCapabilityRecovery(dir);
    const successor = result.actions.find((action) => action.type === 'dispatch_agent')?.ticket;
    expect(successor).toBeTruthy();
    const generation = await onlyRecoveryGeneration(paths);
    const manifest = await readJson(path.join(generation, 'manifest.json'));
    const members = manifest.members ?? manifest.files;
    expect(members).toBeTruthy();

    const actualMembers = (await relativeFiles(generation))
      .map((name) => name.replaceAll('\\', '/'))
      .filter((name) => name !== 'manifest.json')
      .sort();
    const expectedMembers = [
      'active.json',
      `contracts/${successor.capability_manifest.run_contract.hash}.json`,
      `contracts/schemas/${successor.capability_manifest.receipt_schema.hash}.json`,
      `receipt-transactions/${ticket.ticket_id.replaceAll(':', '_')}.json`,
      `receipts/${result.receipt.receipt_id}.json`,
      `runs/${ticket.run_id}.json`,
      `tickets/${successor.ticket_id.replaceAll(':', '_')}.json`,
    ].sort();
    // manifest.json is immutable metadata over these seven authority-bearing
    // members; it is not an eighth member that the manifest may self-describe.
    expect(actualMembers).toEqual(expectedMembers);
    expect(Object.keys(members).sort()).toEqual(expectedMembers);

    for (const name of actualMembers) {
      expect(path.posix.isAbsolute(name)).toBe(false);
      expect(name).not.toMatch(/(?:^|\/)\.\.(?:\/|$)|\/\//);
      const member = path.join(generation, name);
      const metadata = await lstat(member);
      expect(metadata.isFile()).toBe(true);
      expect(metadata.isSymbolicLink()).toBe(false);
      const bytes = await readFile(member);
      const descriptor = members[name];
      const digest = descriptor?.raw_sha256 ?? descriptor?.raw_hash ?? descriptor?.byte_hash ??
        descriptor?.content_hash ?? descriptor?.sha256 ?? descriptor?.hash;
      const byteLength = descriptor?.bytes ?? descriptor?.byte_length ?? descriptor?.size;
      const identity = descriptor?.identity ?? descriptor?.file_identity ?? (
        descriptor && Object.hasOwn(descriptor, 'dev') && Object.hasOwn(descriptor, 'ino')
          ? { dev: descriptor.dev, ino: descriptor.ino }
          : null
      );
      expect(digest).toBe(rawSha256(bytes));
      expect(byteLength).toBe(bytes.length);
      expect(identity).toBeTruthy();
    }
  });

  it('rejects an unlisted eighth generation member before selector adoption or projection', async () => {
    const dir = await project();
    const { payload, paths } = await publishCapabilityRecovery(dir);
    const generation = await onlyRecoveryGeneration(paths);
    const activeBefore = await readJson(paths.active);
    const edgesBefore = selectorArtifacts(await runtimeSnapshot(paths.runtime));
    await writeFile(path.join(generation, 'caller-selected.json'), '{"authority":true}\n');

    const attempted = await recordReceipt(dir, payload).then(
      (value) => ({ value, error: null }),
      (error) => ({ value: null, error }),
    );
    const message = attempted.error?.message ?? attempted.value?.errors?.join(' ') ?? '';

    expect(attempted.value?.ok).not.toBe(true);
    expect(message).toMatch(/exact|manifest|member|generation|unexpected|extra/i);
    expect(await readJson(paths.active)).toEqual(activeBefore);
    expect(selectorArtifacts(await runtimeSnapshot(paths.runtime))).toEqual(edgesBefore);
  });

  it('rejects a self-hashed manifest with extra authority instead of trusting its member subset', async () => {
    const dir = await project();
    const { ticket, payload, paths } = await publishCapabilityRecovery(dir);
    const activeBefore = await readJson(paths.active);
    const generation = await onlyRecoveryGeneration(paths);
    const manifestFile = path.join(generation, 'manifest.json');
    const manifest = await readJson(manifestFile);
    const { hash: _hash, ...body } = manifest;
    const forgedBody = {
      ...body,
      forged_authority: {
        ticket_id: `${ticket.run_id}:${ticket.stage_id}:caller-selected`,
        claimed_paths: ['private/escape.js'],
      },
    };
    await atomicWriteJson(manifestFile, { ...forgedBody, hash: sha256(forgedBody) });

    const attempted = await recordReceipt(dir, payload).then(
      (value) => ({ value, error: null }),
      (error) => ({ value: null, error }),
    );
    const message = attempted.error?.message ?? attempted.value?.errors?.join(' ') ?? '';
    expect(attempted.value?.ok).not.toBe(true);
    expect(message).toMatch(/manifest|schema|binding|generation|selector/i);
    expect(await readJson(paths.active)).toEqual(activeBefore);
  });

  it.each(['hardlink-before-rename', 'hardlink-after-rename'])(
    'fails loudly at the %s substitution seam, preserves the predecessor, and converges once on replay',
    async (kind) => {
      const dir = await project();
      const { ticket, capability } = await nativeCapabilityTicket(dir);
      const payload = capabilityReceipt(ticket, capability, {
        claimed_paths: ['src/generated.js'],
      });
      const paths = runtimePaths(dir);
      const predecessor = await readJson(paths.active);
      const validation = await validateReceiptForDispatch(dir, payload, ticket.ticket_id);
      expect(validation).toMatchObject({ ok: true, valid: true });
      __publicationFault.arm = { kind, relative: 'active.json' };

      const attempted = await recordReceipt(dir, payload).then(
        (value) => ({ value, error: null }),
        (error) => ({ value: null, error }),
      );
      const message = attempted.error?.message ?? attempted.value?.errors?.join(' ') ?? '';
      expect(__publicationFault.fired).toBe(1);
      expect(attempted.value?.ok).not.toBe(true);
      expect(message).toMatch(/identity|manifest|member|generation|substitut|regular.file/i);
      expect(await readJson(paths.active)).toEqual(predecessor);

      const replay = await recordReceipt(dir, payload);
      expect(replay.ok).toBe(true);
      const converged = await readJson(paths.active);
      expect(converged.receipts.filter((entry) => entry.ticket_id === ticket.ticket_id))
        .toHaveLength(1);
      expect(converged.tickets.filter((entry) => entry.ticket_id !== ticket.ticket_id))
        .toHaveLength(1);
    },
  );

  it('rejects a same-byte member path rebound between lstat and read instead of blessing mixed evidence', async () => {
    const dir = await project();
    const { ticket, capability } = await nativeCapabilityTicket(dir);
    const payload = capabilityReceipt(ticket, capability, {
      claimed_paths: ['src/lstat-read-race.js'],
    });
    const paths = runtimePaths(dir);
    const predecessor = await readJson(paths.active);
    const validation = await validateReceiptForDispatch(dir, payload, ticket.ticket_id);
    expect(validation).toMatchObject({ ok: true, valid: true });
    // active.json is described once while building the manifest, once during
    // pre-rename validation, and a third time at the durable destination. The
    // third lstat/read seam is the security boundary under test.
    __fsRaceControl.arm = {
      kind: 'same-bytes-after-lstat',
      relative: 'active.json',
      fireOn: 3,
    };

    const attempted = await recordReceipt(dir, payload).then(
      (value) => ({ value, error: null }),
      (error) => ({ value: null, error }),
    );
    const message = attempted.error?.message ?? attempted.value?.errors?.join(' ') ?? '';

    expect(__fsRaceControl.fired).toBe(1);
    expect(attempted.value?.ok).not.toBe(true);
    expect(message).toMatch(/identity|manifest|member|generation|rebound|substitut/i);
    expect(await readJson(paths.active)).toEqual(predecessor);
  });

  it('uses the content-addressed selector edge, not mutable active-state generation bytes, as the head', async () => {
    const dir = await project();
    const { ticket, payload, result, paths } = await publishCapabilityRecovery(dir);
    const successor = result.actions.find((action) => action.type === 'dispatch_agent')?.ticket;
    expect(successor).toBeTruthy();
    const active = await readJson(paths.active);
    const snapshot = await runtimeSnapshot(paths.runtime);
    const edges = selectorArtifacts(snapshot);
    expect(edges).toHaveLength(1);
    expect(path.basename(edges[0].name)).toMatch(/[0-9a-f]{64}\.json$/i);
    expect(edges[0].bytes).toContain(ticket.ticket_hash);
    expect(edges[0].bytes).toContain(successor.ticket_hash);
    const edgeBytes = new Map(edges.map((edge) => [edge.name, edge.bytes]));

    const forgedProjection = {
      ...active,
      recovery_generation: {
        ...active.recovery_generation,
        hash: '0'.repeat(64),
      },
    };
    await atomicWriteJson(paths.active, forgedProjection);
    await atomicWriteJson(path.join(paths.runs, `${active.run_id}.json`), forgedProjection);

    const replay = await recordReceipt(dir, payload);
    expect(replay.ok).toBe(true);
    expect(await readJson(paths.active)).toEqual(active);
    const afterEdges = selectorArtifacts(await runtimeSnapshot(paths.runtime));
    expect(new Map(afterEdges.map((edge) => [edge.name, edge.bytes]))).toEqual(edgeBytes);
  });

  it('records semantic quarantine evidence without mutating the live selector pathname', async () => {
    const dir = await project();
    const { payload, paths } = await publishCapabilityRecovery(dir);
    const edges = selectorArtifacts(await runtimeSnapshot(paths.runtime));
    expect(edges).toHaveLength(1);
    const edgeFile = path.join(paths.runtime, edges[0].name);
    const invalidSlot = path.join(path.dirname(edgeFile), `${'0'.repeat(64)}.json`);
    await writeFile(invalidSlot, edges[0].bytes, 'utf8');
    const before = await recoveryDescriptor(invalidSlot);
    __fsRaceControl.arm = { kind: 'forbid-selector-mutation', file: invalidSlot };

    const replay = await recordReceipt(dir, payload);
    __fsRaceControl.arm = null;

    expect(replay.ok).toBe(true);
    expect(__fsRaceControl.selectorMutationCalls).toBe(0);
    expect(await readFile(invalidSlot, 'utf8')).toBe(edges[0].bytes);
    expect(await recoveryDescriptor(invalidSlot)).toEqual(before);
    const quarantine = await runtimeSnapshot(paths.recoverySelectorQuarantine);
    expect(Object.keys(quarantine).length).toBeGreaterThan(0);
    expect(semanticQuarantineContains(quarantine, {
      bytes: edges[0].bytes,
      descriptor: before,
      lineageHash: [edges[0].value.hash, edges[0].value.generation.hash],
    })).toBe(true);
    const retained = selectorArtifacts(await runtimeSnapshot(paths.runtime))
      .filter((entry) => entry.name === edges[0].name);
    expect(retained).toHaveLength(1);
    expect(retained[0].bytes).toBe(edges[0].bytes);

    const exactReplay = await recordReceipt(dir, payload);
    expect(exactReplay.ok).toBe(true);
    expect(await runtimeSnapshot(paths.recoverySelectorQuarantine)).toEqual(quarantine);
    expect(await recoveryDescriptor(invalidSlot)).toEqual(before);
  });

  it('retains a self-hashed selector with the wrong owner as immutable forensic evidence', async () => {
    const dir = await project();
    const { payload, paths } = await publishCapabilityRecovery(dir);
    const activeBefore = await readJson(paths.active);
    const [valid] = selectorArtifacts(await runtimeSnapshot(paths.runtime));
    expect(valid).toBeTruthy();
    const { hash: _hash, ...body } = valid.value;
    const forgedBody = {
      ...body,
      owner_source: {
        ...body.owner_source,
        source_ticket_hash: 'f'.repeat(64),
      },
    };
    const forged = { ...forgedBody, hash: sha256(forgedBody) };
    const forgedSlot = path.join(paths.recoverySelectors, `${forged.hash}.json`);
    await atomicWriteJson(forgedSlot, forged);
    const forgedBytes = await readFile(forgedSlot, 'utf8');
    const forgedDescriptor = await recoveryDescriptor(forgedSlot);
    __fsRaceControl.arm = { kind: 'forbid-selector-mutation', file: forgedSlot };

    const replay = await recordReceipt(dir, payload);
    __fsRaceControl.arm = null;

    expect(replay.ok).toBe(true);
    expect(await readJson(paths.active)).toEqual(activeBefore);
    expect(__fsRaceControl.selectorMutationCalls).toBe(0);
    expect(await readFile(forgedSlot, 'utf8')).toBe(forgedBytes);
    expect(await recoveryDescriptor(forgedSlot)).toEqual(forgedDescriptor);
    expect(semanticQuarantineContains(
      await runtimeSnapshot(paths.recoverySelectorQuarantine),
      {
        bytes: forgedBytes,
        descriptor: forgedDescriptor,
        lineageHash: [forged.hash, forged.generation.hash],
      },
    )).toBe(true);
    expect(selectorArtifacts(await runtimeSnapshot(paths.runtime)))
      .toEqual(expect.arrayContaining([valid]));
  });

  it('rejects a fully rehashed generation whose durable state is not the complete prepared nextState', async () => {
    const dir = await project();
    const { payload, paths } = await publishCapabilityRecovery(dir);
    const activeBefore = await readJson(paths.active);
    const generation = await onlyRecoveryGeneration(paths);
    const activeFile = path.join(generation, 'active.json');
    const manifestFile = path.join(generation, 'manifest.json');
    const manifest = await readJson(manifestFile);
    const members = manifest.members ?? manifest.files;
    const forgedActive = { ...await readJson(activeFile), lane: 'mechanical' };
    await atomicWriteJson(activeFile, forgedActive);
    const activeBytes = await readFile(activeFile);
    const activeMetadata = await lstat(activeFile);
    const activeIdentity = members['active.json'].identity;
    members['active.json'] = {
      raw_sha256: rawSha256(activeBytes),
      bytes: activeBytes.length,
      identity: {
        dev: typeof activeIdentity.dev === 'string'
          ? String(activeMetadata.dev)
          : activeMetadata.dev,
        ino: typeof activeIdentity.ino === 'string'
          ? String(activeMetadata.ino)
          : activeMetadata.ino,
      },
    };
    const { hash: _manifestHash, ...manifestBody } = manifest;
    const forgedManifest = { ...manifestBody, hash: sha256(manifestBody) };
    await atomicWriteJson(manifestFile, forgedManifest);
    const manifestBytes = await readFile(manifestFile);
    const manifestMetadata = await lstat(manifestFile);

    const [originalEdge] = selectorArtifacts(await runtimeSnapshot(paths.runtime));
    const originalSlot = path.join(paths.runtime, originalEdge.name);
    const edgeIdentity = originalEdge.value.manifest_binding.identity;
    const { hash: _edgeHash, ...edgeBody } = originalEdge.value;
    const forgedEdgeBody = {
      ...edgeBody,
      manifest_hash: forgedManifest.hash,
      manifest_binding: {
        raw_sha256: rawSha256(manifestBytes),
        bytes: manifestBytes.length,
        identity: {
          dev: typeof edgeIdentity.dev === 'string'
            ? String(manifestMetadata.dev)
            : manifestMetadata.dev,
          ino: typeof edgeIdentity.ino === 'string'
            ? String(manifestMetadata.ino)
            : manifestMetadata.ino,
        },
      },
    };
    const forgedEdge = { ...forgedEdgeBody, hash: sha256(forgedEdgeBody) };
    const forgedSlot = path.join(path.dirname(originalSlot), `${forgedEdge.hash}.json`);
    await atomicWriteJson(forgedSlot, forgedEdge);
    await rm(originalSlot, { force: true });

    const attempted = await recordReceipt(dir, payload).then(
      (value) => ({ value, error: null }),
      (error) => ({ value: null, error }),
    );
    const message = attempted.error?.message ?? attempted.value?.errors?.join(' ') ?? '';

    expect(attempted.value?.ok).not.toBe(true);
    expect(message).toMatch(/prepared|next state|durable state|generation|binding/i);
    expect(await readJson(paths.active)).toEqual(activeBefore);
  });

  it('derives a second edge predecessor from the validated selector head, not mutable active bytes', async () => {
    const dir = await project();
    const first = await publishCapabilityRecovery(dir, {
      claimed_paths: ['src/first-generation.js'],
    });
    const firstAction = first.result.actions.find((action) => action.type === 'dispatch_agent');
    expect(firstAction).toBeTruthy();
    const successorCapability = await bindCodexDispatch(root, dir, firstAction);
    const secondPayload = capabilityReceipt(firstAction.ticket, successorCapability, {
      claimed_paths: ['src/second-generation.js'],
    });
    const validation = await validateReceiptForDispatch(
      dir,
      secondPayload,
      firstAction.ticket.ticket_id,
    );
    expect(validation).toMatchObject({ ok: true, valid: true });
    const active = await readJson(first.paths.active);
    const forgedProjection = {
      ...active,
      recovery_generation: {
        version: 1,
        generation: 999,
        previous: null,
        source_ticket_hash: 'a'.repeat(64),
        successor_ticket_id: 'caller:selected',
        successor_ticket_hash: 'b'.repeat(64),
        hash: 'c'.repeat(64),
      },
    };
    await atomicWriteJson(first.paths.active, forgedProjection);
    await atomicWriteJson(
      path.join(first.paths.runs, `${active.run_id}.json`),
      forgedProjection,
    );

    const second = await recordReceipt(dir, secondPayload);

    expect(second.ok).toBe(true);
    const edges = selectorArtifacts(await runtimeSnapshot(first.paths.runtime));
    expect(edges).toHaveLength(2);
    const roots = edges.filter((edge) => edge.value.predecessor === null);
    expect(roots).toHaveLength(1);
    const children = edges.filter((edge) => edge.value.predecessor === roots[0].value.hash);
    expect(children).toHaveLength(1);
    expect((await readJson(first.paths.active)).recovery_generation.generation).toBe(2);
  });

  it('seeds a selectorless legacy anchor without rewriting any generation member bytes', async () => {
    const dir = await project();
    const { payload, paths } = await publishCapabilityRecovery(dir);
    const generation = await onlyRecoveryGeneration(paths);
    const generationBefore = await runtimeSnapshot(generation);
    const selectorBefore = selectorArtifacts(await runtimeSnapshot(paths.runtime));
    const selectorRoots = new Set(selectorBefore.map((edge) => {
      const segments = edge.name.replaceAll('\\', '/').split('/');
      const selectorIndex = segments.findIndex((segment) => /selector/i.test(segment));
      return segments.slice(0, selectorIndex + 1).join('/');
    }));
    for (const relative of selectorRoots) {
      await rm(path.join(paths.runtime, relative), { recursive: true, force: true });
    }

    const replay = await recordReceipt(dir, payload);
    expect(replay.ok).toBe(true);
    expect(await runtimeSnapshot(generation)).toEqual(generationBefore);
    const anchored = selectorArtifacts(await runtimeSnapshot(paths.runtime));
    expect(anchored).toHaveLength(1);
  });
});

describe('APE v2 frozen recovery authority and receipt-lock ownership', () => {
  it('fails closed without the frozen run-contract manifest and leaves every remaining byte unchanged', async () => {
    const dir = await project();
    const { ticket, capability } = await nativeCapabilityTicket(dir);
    const paths = runtimePaths(dir);
    const contract = path.join(
      paths.contracts,
      `${ticket.capability_manifest.run_contract.hash}.json`,
    );
    await rm(contract, { force: true });
    const before = await runtimeSnapshot(paths.runtime);
    const payload = capabilityReceipt(ticket, capability, {
      claimed_paths: ['src/missing-authority.js'],
    });

    const attempted = await recordReceipt(dir, payload).then(
      (value) => ({ value, error: null }),
      (error) => ({ value: null, error }),
    );
    const message = attempted.error?.message ?? attempted.value?.errors?.join(' ') ?? '';
    expect(attempted.value?.ok).not.toBe(true);
    expect(message).toMatch(/frozen|run contract|authority|manifest|missing/i);
    expect(await runtimeSnapshot(paths.runtime)).toEqual(before);
  });

  it('derives successor timing from frozen ticket authority after live configuration changes', async () => {
    const dir = await project();
    const { ticket, capability } = await nativeCapabilityTicket(dir);
    const sourceDuration = Date.parse(ticket.deadline_at) - Date.parse(ticket.issued_at);
    expect(sourceDuration).toBeGreaterThan(1);
    await atomicWriteJson(runtimePaths(dir).config, {
      deadlines_ms: { fast: 1, full: 1 },
    });
    const payload = capabilityReceipt(ticket, capability, {
      claimed_paths: ['src/frozen-authority.js'],
    });
    const validation = await validateReceiptForDispatch(dir, payload, ticket.ticket_id);
    expect(validation).toMatchObject({ ok: true, valid: true });

    const recovered = await recordReceipt(dir, payload);
    expect(recovered.ok).toBe(true);
    const successor = recovered.actions.find((action) => action.type === 'dispatch_agent')?.ticket;
    expect(successor).toBeTruthy();
    expect(Date.parse(successor.deadline_at) - Date.parse(successor.issued_at))
      .toBe(sourceDuration);
  });

  it('derives a requested-role successor model from frozen authority, not changed live config', async () => {
    const dir = await project();
    const { ticket, capability } = await nativeCapabilityTicket(dir);
    await atomicWriteJson(runtimePaths(dir).config, {
      role_models: {
        implementer: {
          codex: {
            model: 'caller-selected-live-model',
            reasoning_effort: 'low',
          },
        },
      },
    });
    const payload = capabilityReceipt(ticket, capability, {
      claimed_paths: ['src/frozen-model.js'],
      required_role: 'implementer',
    });
    const validation = await validateReceiptForDispatch(dir, payload, ticket.ticket_id);
    expect(validation).toMatchObject({ ok: true, valid: true });

    const recovered = await recordReceipt(dir, payload);

    expect(recovered.ok).toBe(true);
    const successor = recovered.actions.find((action) => action.type === 'dispatch_agent')?.ticket;
    expect(successor?.role).toBe('implementer');
    expect(successor?.model?.model).not.toBe('caller-selected-live-model');
    expect((await readJson(runtimePaths(dir).active)).tickets)
      .toContainEqual(successor);
  });

  it('treats EPERM as proof that a stale receipt-lock owner is still alive', async () => {
    const dir = await project();
    const lockPath = runtimePaths(dir).receiptLock;
    let releaseOwner;
    let ownerEntered;
    const ownerReady = new Promise((resolve) => { ownerEntered = resolve; });
    const ownerHeld = new Promise((resolve) => { releaseOwner = resolve; });
    const options = {
      staleMs: 5,
      heartbeatMs: 60_000,
      busyMs: 50,
      busyMessage: 'receipt effect lock is busy',
      serializeLocal: false,
    };
    const owner = withDirLock(lockPath, async () => {
      const stale = new Date(Date.now() - 60_000);
      await utimes(lockPath, stale, stale);
      ownerEntered();
      await ownerHeld;
    }, options);
    await ownerReady;

    const kill = vi.spyOn(process, 'kill').mockImplementation(() => {
      const error = new Error('operation not permitted');
      error.code = 'EPERM';
      throw error;
    });
    let rivalEntered = false;
    try {
      const rival = await withDirLock(lockPath, async () => {
        rivalEntered = true;
      }, options).then(
        (value) => ({ value, error: null }),
        (error) => ({ value: null, error }),
      );
      expect(rivalEntered).toBe(false);
      expect(rival.error?.message).toMatch(/receipt effect lock is busy/i);
    } finally {
      kill.mockRestore();
      releaseOwner();
      await owner;
    }
  });

  it.each([
    ['a missing process record', null],
    ['a malformed process record', 'not-json\n'],
    [
      'a process record bound to a different owner token',
      `${JSON.stringify({
        version: 1,
        token: 'different-owner-token',
        pid: 2_147_483_647,
        host: hostname(),
        state: 'active',
      })}\n`,
    ],
    [
      'an untrusted retiring process record',
      `${JSON.stringify({
        version: 1,
        token: 'legacy-owner-token',
        pid: 2_147_483_647,
        host: hostname(),
        state: 'retiring',
      })}\n`,
    ],
  ])('fails closed on %s instead of retiring the legacy owner directory', async (
    _label,
    processRecord,
  ) => {
    const dir = await project();
    const lockPath = runtimePaths(dir).receiptLock;
    const ownerToken = 'legacy-owner-token';
    await mkdir(lockPath, { recursive: true });
    await writeFile(path.join(lockPath, 'owner'), ownerToken);
    if (processRecord !== null) {
      await writeFile(path.join(lockPath, 'process'), processRecord);
    }
    const stale = new Date(Date.now() - 60_000);
    await utimes(lockPath, stale, stale);

    let rivalEntered = false;
    const outcome = await withDirLock(lockPath, async () => {
      rivalEntered = true;
    }, {
      staleMs: 5,
      heartbeatMs: 60_000,
      busyMs: 50,
      busyMessage: 'receipt effect lock owner is unverifiable',
      serializeLocal: false,
    }).then(
      (value) => ({ value, error: null }),
      (error) => ({ value: null, error }),
    );

    expect(rivalEntered).toBe(false);
    expect(outcome.error?.message).toMatch(/unverifiable|busy|owner|process/i);
    expect(await readFile(path.join(lockPath, 'owner'), 'utf8').catch(() => null))
      .toBe(ownerToken);
  });

  it('retires exactly the observed owner directory after ESRCH proves its bound process dead', async () => {
    const dir = await project();
    const lockPath = runtimePaths(dir).receiptLock;
    const ownerToken = 'dead-owner-token';
    const deadPid = 2_147_483_647;
    await mkdir(lockPath, { recursive: true });
    await writeFile(path.join(lockPath, 'owner'), ownerToken);
    await writeFile(path.join(lockPath, 'process'), `${JSON.stringify({
      version: 1,
      token: ownerToken,
      pid: deadPid,
      host: hostname(),
      state: 'active',
    })}\n`);
    const stale = new Date(Date.now() - 60_000);
    await utimes(lockPath, stale, stale);
    const kill = vi.spyOn(process, 'kill').mockImplementation((pid) => {
      if (pid === deadPid) {
        const error = new Error('no such process');
        error.code = 'ESRCH';
        throw error;
      }
      return true;
    });
    let rivalEntered = false;
    try {
      await withDirLock(lockPath, async () => {
        rivalEntered = true;
      }, {
        staleMs: 5,
        heartbeatMs: 60_000,
        busyMs: 250,
        busyMessage: 'receipt effect lock is busy',
        serializeLocal: false,
      });
    } finally {
      kill.mockRestore();
    }

    expect(rivalEntered).toBe(true);
    expect(await lstat(lockPath).then(() => true, () => false)).toBe(false);
  });
});

describe('APE v2 second-review recovery closure', () => {
  it('derives the complete successor authority from the immutable run contract, never mutable active state', async () => {
    const dir = await project();
    const { ticket, capability } = await nativeCapabilityTicket(dir);
    const added = Array.from({ length: 6 }, (_, index) => `src/authority-${index}.js`);
    const payload = capabilityReceipt(ticket, capability, {
      claimed_paths: added,
      required_role: 'implementer',
    });
    expect(await validateReceiptForDispatch(dir, payload, ticket.ticket_id))
      .toMatchObject({ ok: true, valid: true });
    const paths = runtimePaths(dir);
    const active = await readJson(paths.active);
    const immutableContract = await readRunContractManifest(
      paths,
      ticket.capability_manifest.run_contract,
    );
    const immutableAuthority = immutableContract.capability_catalog.frozen_recovery_authority;
    const immutableTicketAuthority = immutableContract.receipt_contract.ticket_contracts
      .find((entry) => entry.ticket_id === ticket.ticket_id)?.recovery_authority;
    expect(ticket.binding_protocol).toBe('native-v1');
    expect(
      immutableAuthority.binding_protocol ?? immutableAuthority.run_scope?.binding_protocol,
    ).toBe(ticket.binding_protocol);
    expect(
      immutableTicketAuthority.binding_protocol ?? immutableTicketAuthority.run_scope?.binding_protocol,
    ).toBe(ticket.binding_protocol);
    const immutableHost = active.host;
    const alternateHost = Object.keys(immutableAuthority.models)
      .find((host) => host !== immutableHost);
    const expectedModel = immutableAuthority.role_models?.implementer?.[immutableHost] ??
      immutableAuthority.models?.[immutableHost]?.[ticket.model_tier];
    expect(alternateHost).toBeTruthy();
    expect(expectedModel).toBeTruthy();
    const attacker = 'caller-selected-active-authority';
    const corrupted = {
      ...active,
      host: alternateHost,
      binding_protocol: 'caller-selected-legacy-binding',
      claimed_paths: [...active.claimed_paths, 'private/escape.js'],
      risk_triggers: ['security'],
      capability_snapshot: {
        ...active.capability_snapshot,
        evidence_scripts: [attacker],
        command_profiles: [{ id: attacker, command: `node ${attacker}`, roles: ['implementer'] }],
        verification_profiles: [{
          id: attacker,
          description: attacker,
          command: `node ${attacker}`,
          root: '.',
          timeout_ms: 1,
          required: true,
        }],
        runners: [{ root: '.', profile: { full: `node ${attacker}` } }],
        test_commands: { full: `node ${attacker}`, targeted: `node ${attacker}` },
        frozen_recovery_authority: {
          ...active.capability_snapshot.frozen_recovery_authority,
          models: { codex: { balanced: { model: attacker, reasoning_effort: 'low' } } },
          role_models: { implementer: { codex: { model: attacker, reasoning_effort: 'low' } } },
          deadlines_ms: { fast: 1, full: 1 },
          role_policies: { implementer: { writable: false, model_tier: 'balanced' } },
          stages: [{ id: ticket.stage_id, role: 'implementer', required_checks: [] }],
        },
      },
    };
    await atomicWriteJson(paths.active, corrupted);

    const recovered = await recordReceipt(dir, payload);

    expect(recovered.ok).toBe(true);
    const successor = recovered.actions.find((action) => action.type === 'dispatch_agent')?.ticket;
    expect(successor).toBeTruthy();
    expect(successor.claimed_paths).toEqual([...ticket.claimed_paths, ...added]);
    expect(successor.risk_triggers).toEqual(ticket.risk_triggers);
    expect(successor.model).toEqual(expectedModel);
    expect(successor.binding_protocol).toBe(ticket.binding_protocol);
    expect(JSON.stringify(successor)).not.toContain(attacker);
    expect(JSON.stringify(successor)).not.toContain('private/escape.js');
  });

  it('runs full prepared-runtime validation when replay adopts an already published receipt', async () => {
    const dir = await project();
    const { ticket, capability } = await nativeCapabilityTicket(dir);
    const payload = capabilityReceipt(ticket, capability, {
      claimed_paths: ['src/adopted-runtime-validation.js'],
    });
    expect(await validateReceiptForDispatch(dir, payload, ticket.ticket_id))
      .toMatchObject({ ok: true, valid: true });
    await recordWithCrash(dir, ticket.ticket_id, payload);
    const paths = runtimePaths(dir);
    const adoptedBefore = await readJson(paths.active);
    __runContractFault.arm = 'rebind-first-pointer';
    __runContractFault.calls = 0;

    const attempted = await capturedRecord(dir, payload);

    expect(__runContractFault.calls).toBeGreaterThan(0);
    expect(attempted.value?.ok).not.toBe(true);
    expect(capturedMessage(attempted))
      .toMatch(/prepared|runtime|run.contract|pointer|binding|authority/i);
    expect(await readJson(paths.active)).toEqual(adoptedBefore);
  });

  it('advances a validated selectorless legacy generation N to a new immutable N+1', async () => {
    const dir = await project();
    const { payload, paths } = await publishCapabilityRecovery(dir);
    const firstState = await readJson(paths.active);
    const firstGeneration = await onlyRecoveryGeneration(paths);
    const firstBytes = await runtimeSnapshot(firstGeneration);
    await rm(paths.recoverySelectors, { recursive: true, force: true });
    const corruptedProjection = {
      ...firstState,
      recovery_generation: null,
      claimed_paths: [...firstState.claimed_paths, 'private/mutable-projection-authority.js'],
    };
    await atomicWriteJson(paths.active, corruptedProjection);
    await atomicWriteJson(
      path.join(paths.runs, `${firstState.run_id}.json`),
      corruptedProjection,
    );
    __publicationFault.arm = { kind: 'crash-after-selector-publish' };

    const crashed = await capturedRecord(dir, payload);

    expect(__publicationFault.fired).toBe(1);
    expect(capturedMessage(crashed)).toContain('APE_TEST_CRASH_AFTER_SELECTOR_PUBLISH');
    expect(await readJson(paths.active)).toEqual(corruptedProjection);
    expect(selectorArtifacts(await runtimeSnapshot(paths.runtime))).toHaveLength(1);

    const replay = await recordReceipt(dir, payload);

    expect(replay.ok).toBe(true);
    const advanced = await readJson(paths.active);
    expect(advanced.recovery_generation).toMatchObject({
      generation: firstState.recovery_generation.generation + 1,
      previous: {
        generation: firstState.recovery_generation.generation,
        hash: firstState.recovery_generation.hash,
      },
    });
    expect(advanced.claimed_paths).not.toContain('private/mutable-projection-authority.js');
    const generations = (await readdir(paths.recoveryGenerations, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory());
    expect(generations).toHaveLength(2);
    expect(await runtimeSnapshot(firstGeneration)).toEqual(firstBytes);
    const selectors = selectorArtifacts(await runtimeSnapshot(paths.runtime));
    expect(selectors).toHaveLength(1);
    expect(selectors[0].value.generation).toEqual(advanced.recovery_generation);
  });

  it('rejects a replaced receipt-effect lease before publishing any selector', async () => {
    const dir = await project();
    const { ticket, capability } = await nativeCapabilityTicket(dir);
    const payload = capabilityReceipt(ticket, capability, {
      claimed_paths: ['src/stale-lease.js'],
    });
    expect(await validateReceiptForDispatch(dir, payload, ticket.ticket_id))
      .toMatchObject({ ok: true, valid: true });
    const paths = runtimePaths(dir);
    const before = await readJson(paths.active);
    __receiptLeaseFault.arm = {
      kind: 'replace-held-directory',
      lockPath: paths.receiptLock,
    };

    const attempted = await capturedRecord(dir, payload);

    expect(__receiptLeaseFault.fired).toBe(1);
    expect(attempted.value?.ok).not.toBe(true);
    expect(capturedMessage(attempted)).toMatch(/lease|lock|owner|identity|replaced/i);
    expect(await readJson(paths.active)).toEqual(before);
    expect(selectorArtifacts(await runtimeSnapshot(paths.runtime))).toEqual([]);
  });

  it('guards every post-selector compatibility, active, binding, and dispatch sink with the held lease', async () => {
    const calibrationDir = await project();
    await publishCapabilityRecovery(calibrationDir, {
      claimed_paths: ['src/lease-calibration.js'],
    });
    const sinkCount = __receiptLeaseFault.mutationCalls;
    expect(sinkCount).toBeGreaterThanOrEqual(4);

    for (let fireOn = 1; fireOn <= sinkCount; fireOn += 1) {
      const dir = await project();
      const { ticket, capability } = await nativeCapabilityTicket(dir);
      const payload = capabilityReceipt(ticket, capability, {
        claimed_paths: [`src/lease-sink-${fireOn}.js`],
      });
      expect(await validateReceiptForDispatch(dir, payload, ticket.ticket_id))
        .toMatchObject({ ok: true, valid: true });
      const paths = runtimePaths(dir);
      const intentsBefore = (await readdir(paths.dispatchIntents)).sort();
      __receiptLeaseFault.mutationCalls = 0;
      __receiptLeaseFault.fired = 0;
      __receiptLeaseFault.arm = {
        kind: 'replace-before-post-selector-sink',
        lockPath: paths.receiptLock,
        fireOn,
      };

      const attempted = await capturedRecord(dir, payload);

      expect(__receiptLeaseFault.fired).toBe(1);
      expect(attempted.value?.ok).not.toBe(true);
      expect(capturedMessage(attempted)).toMatch(/lease|lock|owner|identity|replaced/i);
      expect(selectorArtifacts(await runtimeSnapshot(paths.runtime))).toHaveLength(1);
      expect((await readdir(paths.dispatchIntents)).sort()).toEqual(intentsBefore);
    }
  }, 30_000);

  it('detects an out-of-protocol lease rebind during a sink before any successor sink runs', async () => {
    const dir = await project();
    const paths = runtimePaths(dir);
    let laterSinkRan = false;
    let observed = null;

    await withDirLock(paths.receiptLock, async (lease) => {
      try {
        await withDirLockLeaseMutation(paths.receiptLock, lease, async () => {
          const displaced = `${paths.receiptLock}.direct-rebind`;
          await rename(paths.receiptLock, displaced);
          await mkdir(paths.receiptLock);
          await writeFile(path.join(paths.receiptLock, 'owner'), 'direct-rival');
          await writeFile(path.join(paths.receiptLock, 'process'), `${JSON.stringify({
            version: 1,
            token: 'direct-rival',
            pid: process.pid,
            host: hostname(),
            state: 'active',
          })}\n`);
        });
        laterSinkRan = true;
      } catch (error) {
        observed = error;
      }
    }, {
      staleMs: 60_000,
      heartbeatMs: 15_000,
      busyMs: 1_000,
      busyMessage: 'receipt effect lock is busy',
      serializeLocal: false,
    });

    expect(observed?.message).toMatch(/lease|lock|owner|identity|replaced/i);
    expect(laterSinkRan).toBe(false);
  });

  it('treats an already reachable non-head edge as idempotent without rolling projections backward', async () => {
    const dir = await project();
    const first = await publishCapabilityRecovery(dir, {
      claimed_paths: ['src/first-edge.js'],
    });
    const firstAction = first.result.actions.find((action) => action.type === 'dispatch_agent');
    expect(firstAction).toBeTruthy();
    const secondCapability = await bindCodexDispatch(root, dir, firstAction);
    const secondPayload = capabilityReceipt(firstAction.ticket, secondCapability, {
      claimed_paths: ['src/second-edge.js'],
    });
    expect(await validateReceiptForDispatch(dir, secondPayload, firstAction.ticket.ticket_id))
      .toMatchObject({ ok: true, valid: true });
    const second = await recordReceipt(dir, secondPayload);
    expect(second.ok).toBe(true);
    const head = await readJson(first.paths.active);
    expect(head.recovery_generation.generation).toBe(2);
    const runProjection = await readJson(path.join(first.paths.runs, `${head.run_id}.json`));

    const replay = await recordReceipt(dir, first.payload);

    expect(replay).toMatchObject({ ok: true, idempotent: true });
    expect(replay.actions).toEqual([]);
    expect(await readJson(first.paths.active)).toEqual(head);
    expect(await readJson(path.join(first.paths.runs, `${head.run_id}.json`)))
      .toEqual(runProjection);
  });

  it('never selects a topological child that reuses its predecessor generation lineage', async () => {
    const dir = await project();
    const recovery = await publishCapabilityRecovery(dir, {
      claimed_paths: ['src/selector-lineage.js'],
    });
    const [rootEdge] = selectorArtifacts(await runtimeSnapshot(recovery.paths.runtime));
    expect(rootEdge).toBeTruthy();
    expect(rootEdge.value.predecessor).toBe(null);
    const { hash: _rootHash, ...rootBody } = rootEdge.value;
    const forgedBody = {
      ...rootBody,
      predecessor: rootEdge.value.hash,
    };
    const forgedEdge = { ...forgedBody, hash: sha256(forgedBody) };
    const forgedSlot = path.join(
      recovery.paths.recoverySelectors,
      `${forgedEdge.hash}.json`,
    );
    await atomicWriteJson(forgedSlot, forgedEdge);
    const forgedBefore = await recoveryDescriptor(forgedSlot);
    const activeBefore = await readJson(recovery.paths.active);
    __fsRaceControl.arm = { kind: 'forbid-selector-mutation', file: forgedSlot };

    const attempted = await capturedRecord(dir, recovery.payload);
    __fsRaceControl.arm = null;

    expect(await readJson(recovery.paths.active)).toEqual(activeBefore);
    expect(__fsRaceControl.selectorMutationCalls).toBe(0);
    expect(await recoveryDescriptor(forgedSlot)).toEqual(forgedBefore);
    if (attempted.value?.ok === true) {
      expect(attempted.value.actions).toEqual([]);
    } else {
      expect(capturedMessage(attempted))
        .toMatch(/selector|lineage|predecessor|generation|successor/i);
    }
  });

  it('enforces member, cumulative, and directory-entry bounds before allocation', async () => {
    const declaredDir = await project();
    const declared = await publishCapabilityRecovery(declaredDir);
    const declaredGeneration = await onlyRecoveryGeneration(declared.paths);
    const declaredManifest = await readJson(path.join(declaredGeneration, 'manifest.json'));
    const mismatchedMembers = structuredClone(declaredManifest.members);
    mismatchedMembers['active.json'] = {
      ...mismatchedMembers['active.json'],
      bytes: 1,
    };
    const { hash: _declaredHash, ...declaredBody } = declaredManifest;
    await replaceRecoveryManifestAndSelector(declared.paths, declaredGeneration, {
      ...declaredBody,
      members: mismatchedMembers,
    });
    __fsRaceControl.memberFstatCalls = 0;
    __fsRaceControl.memberBoundedReadCalls = 0;
    __fsRaceControl.arm = { kind: 'forbid-member-read', relative: 'active.json' };
    const declaredAttempt = await capturedRecord(declaredDir, declared.payload);
    __fsRaceControl.arm = null;
    expect(__fsRaceControl.memberFstatCalls).toBeGreaterThan(0);
    expect(__fsRaceControl.memberBoundedReadCalls).toBe(0);
    expect(capturedMessage(declaredAttempt)).toMatch(/actual|declared|member|byte|size|bound/i);
    expect(capturedMessage(declaredAttempt))
      .not.toContain('APE_TEST_MEMBER_READ_BEFORE_DECLARED_SIZE_CHECK');

    const sparseDir = await project();
    const sparse = await publishCapabilityRecovery(sparseDir);
    const sparseGeneration = await onlyRecoveryGeneration(sparse.paths);
    const sparseMember = path.join(sparseGeneration, 'active.json');
    const sparseHandle = await open(sparseMember, 'r+');
    await sparseHandle.truncate(512 * 1_024 * 1_024);
    await sparseHandle.close();
    __fsRaceControl.arm = {
      kind: 'forbid-member-read-file',
      relative: 'active.json',
    };
    const sparseAttempt = await capturedRecord(sparseDir, sparse.payload);
    __fsRaceControl.arm = null;
    expect(__fsRaceControl.memberReadCalls).toBe(0);
    expect(capturedMessage(sparseAttempt)).toMatch(/member|byte|size|bound|generation/i);
    expect(capturedMessage(sparseAttempt)).not.toContain('APE_TEST_UNBOUNDED_MEMBER_READ');

    const cumulativeDir = await project();
    const cumulative = await publishCapabilityRecovery(cumulativeDir);
    const cumulativeGeneration = await onlyRecoveryGeneration(cumulative.paths);
    const cumulativeManifest = await readJson(path.join(cumulativeGeneration, 'manifest.json'));
    const declaredMembers = Object.fromEntries(
      Object.entries(cumulativeManifest.members).map(([name, descriptor]) => [name, {
        ...descriptor,
        bytes: 64 * 1_024 * 1_024,
      }]),
    );
    const { hash: _cumulativeHash, ...cumulativeBody } = cumulativeManifest;
    await replaceRecoveryManifestAndSelector(cumulative.paths, cumulativeGeneration, {
      ...cumulativeBody,
      members: declaredMembers,
    });
    __fsRaceControl.memberReadCalls = 0;
    __fsRaceControl.arm = { kind: 'forbid-member-read-file', relative: null };
    const cumulativeAttempt = await capturedRecord(cumulativeDir, cumulative.payload);
    __fsRaceControl.arm = null;
    expect(__fsRaceControl.memberReadCalls).toBe(0);
    expect(capturedMessage(cumulativeAttempt)).toMatch(/cumulative|total|member|byte|bound/i);
    expect(capturedMessage(cumulativeAttempt)).not.toContain('APE_TEST_UNBOUNDED_MEMBER_READ');

    const crowdedDir = await project();
    const crowded = await publishCapabilityRecovery(crowdedDir);
    const crowdedGeneration = await onlyRecoveryGeneration(crowded.paths);
    await Promise.all(Array.from({ length: 257 }, (_, index) =>
      writeFile(path.join(crowdedGeneration, `extra-${String(index).padStart(3, '0')}.json`), '{}\n')));
    __fsRaceControl.generationReaddirCalls = 0;
    __fsRaceControl.arm = {
      kind: 'forbid-generation-readdir',
      directory: crowdedGeneration,
    };
    const crowdedAttempt = await capturedRecord(crowdedDir, crowded.payload);
    __fsRaceControl.arm = null;
    expect(__fsRaceControl.generationReaddirCalls).toBe(0);
    expect(capturedMessage(crowdedAttempt)).toMatch(/entry|member|count|bound|generation/i);
    expect(capturedMessage(crowdedAttempt)).not.toContain('APE_TEST_UNBOUNDED_GENERATION_READDIR');
  });

  it('rolls selector publication beyond the flat reader bound without losing a readable unique head', async () => {
    const dir = await project();
    const first = await publishCapabilityRecovery(dir, {
      claimed_paths: ['src/rollover-first.js'],
    });
    const action = first.result.actions
      .find((candidate) => candidate.type === 'dispatch_agent');
    expect(action).toBeTruthy();

    // One real edge plus 127 retained, invalid source slots fills the flat
    // reader's 128-entry admission boundary. Publishing the next real edge
    // must roll over instead of creating a 129-entry flat store.
    await Promise.all(Array.from({ length: 127 }, (_, index) =>
      writeFile(
        path.join(
          first.paths.recoverySelectors,
          `${index.toString(16).padStart(64, '0')}.json`,
        ),
        '{}\n',
      )));
    expect(await readdir(first.paths.recoverySelectors)).toHaveLength(128);

    const capability = await bindCodexDispatch(root, dir, action, 2);
    const payload = capabilityReceipt(action.ticket, capability, {
      claimed_paths: ['src/rollover-second.js'],
    });
    const validation = await validateReceiptForDispatch(
      dir,
      payload,
      action.ticket.ticket_id,
    );
    expect(validation).toMatchObject({ ok: true, valid: true });
    const second = await recordReceipt(dir, payload);
    expect(second.ok).toBe(true);

    const active = await readJson(first.paths.active);
    expect(active.recovery_generation.generation).toBe(2);
    const generationDirectories = (await readdir(
      first.paths.recoveryGenerations,
      { withFileTypes: true },
    )).filter((entry) => entry.isDirectory());
    expect(generationDirectories).toHaveLength(2);
    expect(selectorArtifacts(await runtimeSnapshot(first.paths.runtime))).toHaveLength(129);

    const selectorBytes = await runtimeSnapshot(first.paths.recoverySelectors);
    const replay = await recordReceipt(dir, payload);
    expect(replay.ok).toBe(true);
    expect(await readJson(first.paths.active)).toEqual(active);
    expect(await runtimeSnapshot(first.paths.recoverySelectors)).toEqual(selectorBytes);
  });

  it('caps selector enumeration with opendir before allocating the untrusted directory', async () => {
    const dir = await project();
    const recovery = await publishCapabilityRecovery(dir, {
      claimed_paths: ['src/bounded-selectors.js'],
    });
    await Promise.all(Array.from({ length: 129 }, (_, index) =>
      writeFile(
        path.join(
          recovery.paths.recoverySelectors,
          `${String(index).padStart(64, '0')}.json`,
        ),
        '{}\n',
      )));
    const selectorsBefore = await runtimeSnapshot(recovery.paths.recoverySelectors);
    __fsRaceControl.selectorReaddirCalls = 0;
    __fsRaceControl.selectorOpendirReads = 0;
    __fsRaceControl.arm = {
      kind: 'forbid-selector-readdir',
      directory: recovery.paths.recoverySelectors,
    };

    const attempted = await capturedRecord(dir, recovery.payload);
    __fsRaceControl.arm = null;

    expect(__fsRaceControl.selectorReaddirCalls).toBe(0);
    expect(__fsRaceControl.selectorOpendirReads).toBeGreaterThan(0);
    expect(__fsRaceControl.selectorOpendirReads).toBeLessThanOrEqual(129);
    expect(capturedMessage(attempted)).toMatch(/selector|entry|slot|count|bound/i);
    expect(capturedMessage(attempted)).not.toContain('APE_TEST_UNBOUNDED_SELECTOR');
    expect(await runtimeSnapshot(recovery.paths.recoverySelectors)).toEqual(selectorsBefore);
  });

  it('rescans a quarantined pathname after an identity rebound or byte change', async () => {
    const dir = await project();
    const { payload, paths } = await publishCapabilityRecovery(dir);
    const [valid] = selectorArtifacts(await runtimeSnapshot(paths.runtime));
    const invalidSlot = path.join(paths.recoverySelectors, `${'0'.repeat(64)}.json`);
    await writeFile(invalidSlot, valid.bytes, 'utf8');
    const originalDescriptor = await recoveryDescriptor(invalidSlot);

    expect((await recordReceipt(dir, payload)).ok).toBe(true);
    const firstQuarantine = await runtimeSnapshot(paths.recoverySelectorQuarantine);
    expect(semanticQuarantineContains(firstQuarantine, {
      bytes: valid.bytes,
      descriptor: originalDescriptor,
      lineageHash: [valid.value.hash, valid.value.generation.hash],
    })).toBe(true);

    await rename(invalidSlot, path.join(dir, 'selector-before-rebind.json'));
    await writeFile(invalidSlot, valid.bytes, 'utf8');
    const reboundDescriptor = await recoveryDescriptor(invalidSlot);
    expect(reboundDescriptor.identity).not.toEqual(originalDescriptor.identity);
    __fsRaceControl.arm = { kind: 'forbid-selector-mutation', file: invalidSlot };
    expect((await recordReceipt(dir, payload)).ok).toBe(true);
    __fsRaceControl.arm = null;
    expect(__fsRaceControl.selectorMutationCalls).toBe(0);
    const reboundQuarantine = await runtimeSnapshot(paths.recoverySelectorQuarantine);
    expect(reboundQuarantine).not.toEqual(firstQuarantine);
    expect(semanticQuarantineContains(reboundQuarantine, {
      bytes: valid.bytes,
      descriptor: reboundDescriptor,
      lineageHash: [valid.value.hash, valid.value.generation.hash],
    })).toBe(true);

    const changedBytes = '{"attacker":"changed payload"}\n';
    await writeFile(invalidSlot, changedBytes, 'utf8');
    const changedDescriptor = await recoveryDescriptor(invalidSlot);
    __fsRaceControl.arm = { kind: 'forbid-selector-mutation', file: invalidSlot };
    expect((await recordReceipt(dir, payload)).ok).toBe(true);
    __fsRaceControl.arm = null;
    expect(__fsRaceControl.selectorMutationCalls).toBe(0);
    expect(await readFile(invalidSlot, 'utf8')).toBe(changedBytes);
    const changedQuarantine = await runtimeSnapshot(paths.recoverySelectorQuarantine);
    expect(changedQuarantine).not.toEqual(reboundQuarantine);
    expect(semanticQuarantineContains(changedQuarantine, {
      bytes: changedBytes,
      descriptor: changedDescriptor,
      lineageHash: [valid.value.hash, valid.value.generation.hash],
    })).toBe(true);
  });

  it('fails closed on a semantic-quarantine record collision without changing the source slot', async () => {
    const dir = await project();
    const { payload, paths } = await publishCapabilityRecovery(dir);
    const [valid] = selectorArtifacts(await runtimeSnapshot(paths.runtime));
    const invalidSlot = path.join(paths.recoverySelectors, `${'0'.repeat(64)}.json`);
    await writeFile(invalidSlot, valid.bytes, 'utf8');
    expect((await recordReceipt(dir, payload)).ok).toBe(true);
    const sourceBefore = await recoveryDescriptor(invalidSlot);
    const quarantineFiles = await relativeFiles(paths.recoverySelectorQuarantine);
    expect(quarantineFiles.length).toBeGreaterThan(0);
    const evidenceFile = quarantineFiles[0];
    await writeFile(
      path.join(paths.recoverySelectorQuarantine, evidenceFile),
      'conflicting semantic quarantine bytes\n',
    );
    __fsRaceControl.arm = { kind: 'forbid-selector-mutation', file: invalidSlot };

    const attempted = await capturedRecord(dir, payload);
    __fsRaceControl.arm = null;

    expect(attempted.value?.ok).not.toBe(true);
    expect(capturedMessage(attempted)).toMatch(/quarantine|collision|record|hash|evidence/i);
    expect(__fsRaceControl.selectorMutationCalls).toBe(0);
    expect(await readFile(invalidSlot, 'utf8')).toBe(valid.bytes);
    expect(await recoveryDescriptor(invalidSlot)).toEqual(sourceBefore);
  });
});

describe('APE v2 authenticated recovery and native launch generations', () => {
  it('rejects a substituted receipt bearer before selector scanning or any durable effect', async () => {
    const dir = await project();
    const recovery = await publishCapabilityRecovery(dir);
    const successor = recovery.result.actions
      .find((action) => action.type === 'dispatch_agent')?.ticket;
    expect(successor).toBeTruthy();
    const [valid] = selectorArtifacts(await runtimeSnapshot(recovery.paths.runtime));
    const invalidSlot = path.join(
      recovery.paths.recoverySelectors,
      `${'0'.repeat(64)}.json`,
    );
    await writeFile(invalidSlot, valid.bytes, 'utf8');
    const before = await runtimeSnapshot(recovery.paths.runtime);
    const invalidBearer = capabilityReceipt(
      successor,
      'substituted_receipt_bearer_00000000000000000000000000000000',
      { claimed_paths: ['src/must-not-be-published.js'] },
    );

    const attempted = await capturedRecord(dir, invalidBearer);

    expect(attempted.value?.ok).not.toBe(true);
    expect(capturedMessage(attempted)).toMatch(/capability|bearer|binding|receipt/i);
    expect(await runtimeSnapshot(recovery.paths.runtime)).toEqual(before);
  });

  it('re-emits the exact prepared launch generation after response loss without replacing its authority', async () => {
    const dir = await project();
    const { action, paths } = await preparedNativeDispatch(dir);
    const ticketId = action.ticket.ticket_id;
    const before = await runtimeSnapshot(paths.dispatchIntents);

    const replay = await nextRun(dir);

    expect(replay.ok).toBe(true);
    const replayAction = replay.actions
      .find((candidate) => candidate.type === 'dispatch_agent');
    expect(replayAction).toMatchObject({
      idempotent_replay: true,
      ticket: { ticket_id: ticketId, ticket_hash: action.ticket.ticket_hash },
    });
    expect(replayAction.dispatch.agent_name).toBe(action.dispatch.agent_name);
    expect(await runtimeSnapshot(paths.dispatchIntents)).toEqual(before);
    expect(await dispatchGenerations(paths, ticketId)).toEqual([
      expect.objectContaining({
        generation: 1,
        status: 'prepared',
      }),
    ]);
    const intentFiles = await readdir(paths.dispatchIntents);
    expect(intentFiles).toHaveLength(1);
    expect(await readJson(path.join(paths.dispatchIntents, intentFiles[0])))
      .toMatchObject({ physical_worker_dispatches: 1 });

    const launch = codexLaunchInput(replayAction, {
      sessionId: 'prepared-replay-parent',
      turnId: 'prepared-replay-turn',
      toolUseId: 'prepared-replay-spawn',
    });
    expect(await launchCodexIntent(paths, replay.run, launch))
      .toMatchObject({ valid: true });
    const authorized = await runtimeSnapshot(paths.dispatchIntents);
    expect(await launchCodexIntent(paths, replay.run, launch))
      .toMatchObject({ valid: true });
    expect(await runtimeSnapshot(paths.dispatchIntents)).toEqual(authorized);
    expect(await launchCodexIntent(paths, replay.run, {
      ...launch,
      tool_use_id: 'substituted-replay-spawn',
    })).toMatchObject({ valid: false });
    expect(await runtimeSnapshot(paths.dispatchIntents)).toEqual(authorized);
  });

  it('persists prepared -> authorized -> bound and keeps authorized-unbound pending', async () => {
    const dir = await project();
    const { started, action, paths } = await preparedNativeDispatch(dir);
    const ticketId = action.ticket.ticket_id;
    expect(await dispatchGenerations(paths, ticketId)).toEqual([
      expect.objectContaining({ generation: 1, status: 'prepared' }),
    ]);
    const turnId = 'durable-authorized-turn';
    const launch = codexLaunchInput(action, { turnId });

    expect(await launchCodexIntent(paths, started.run, launch))
      .toMatchObject({ valid: true });
    const authorized = (await dispatchGenerations(paths, ticketId))
      .find((record) => record.generation === 1 && record.status === 'authorized');
    expect(authorized).toBeTruthy();
    expect(
      authorized.turn_id_hash ?? authorized.turn_hash ?? authorized.host_turn_hash,
    ).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(authorized)).not.toContain(turnId);
    const authorizedBytes = await runtimeSnapshot(paths.dispatchIntents);

    const pending = await nextRun(dir);
    expect(pending.ok).toBe(true);
    expect((pending.actions ?? []).filter((entry) => entry.type === 'dispatch_agent'))
      .toHaveLength(0);
    expect(await runtimeSnapshot(paths.dispatchIntents)).toEqual(authorizedBytes);

    const start = codexStartInput({ turnId: `${turnId}-child`, model: action.dispatch.model.model });
    expect(await bindCodexSubagent(
      paths,
      await readJson(paths.active),
      start,
    )).toMatchObject({ valid: true, bootstrap_required: true });
    expect(await dispatchGenerations(paths, ticketId)).toEqual([
      expect.objectContaining({ generation: 1, status: 'authorized' }),
    ]);
    const bound = await bootstrapCodexSubagent(paths, await readJson(paths.active), codexBootstrapInput(action, start));
    expect(bound).toMatchObject({ valid: true, ticket_id: ticketId });
    expect(await dispatchGenerations(paths, ticketId)).toEqual([
      expect.objectContaining({ generation: 1, status: 'bound' }),
    ]);
  });

  it('adopts authorized and bound writes after response loss without duplicating a generation', async () => {
    const dir = await project();
    const { started, action, paths } = await preparedNativeDispatch(dir);
    const ticketId = action.ticket.ticket_id;
    const turnId = 'response-loss-turn';
    const launch = codexLaunchInput(action, { turnId });
    __crashControl.arm = { kind: 'dispatch-status', status: 'authorized' };

    const launchCrash = await launchCodexIntent(paths, started.run, launch).then(
      (value) => ({ value, error: null }),
      (error) => ({ value: null, error }),
    );
    expect(__crashControl.fired).toBe(1);
    expect(launchCrash.error).toBeTruthy();
    expect(await launchCodexIntent(paths, started.run, launch))
      .toMatchObject({ valid: true });
    expect(new Set((await dispatchGenerations(paths, ticketId)).map((entry) => entry.generation)))
      .toEqual(new Set([1]));

    __crashControl.arm = { kind: 'dispatch-status', status: 'bound' };
    const start = codexStartInput({ turnId: `${turnId}-child`, model: action.dispatch.model.model });
    expect(await bindCodexSubagent(paths, await readJson(paths.active), start))
      .toMatchObject({ valid: true, bootstrap_required: true });
    const bootstrap = codexBootstrapInput(action, start);
    const bindCrash = await bootstrapCodexSubagent(paths, await readJson(paths.active), bootstrap).then(
      (value) => ({ value, error: null }),
      (error) => ({ value: null, error }),
    );
    expect(__crashControl.fired).toBe(2);
    expect(bindCrash.error).toBeTruthy();
    expect(await bootstrapCodexSubagent(paths, await readJson(paths.active), bootstrap))
      .toMatchObject({ valid: true, ticket_id: ticketId });
    expect(await dispatchGenerations(paths, ticketId)).toEqual([
      expect.objectContaining({ generation: 1, status: 'bound' }),
    ]);
  });

  it('orphans an expired authorization, rejects its late turn, and issues only one fresh generation', async () => {
    const dir = await project();
    const { started, action, paths } = await preparedNativeDispatch(dir);
    const ticketId = action.ticket.ticket_id;
    const oldTurn = 'expired-authorized-turn';
    expect(await launchCodexIntent(paths, started.run, codexLaunchInput(action, {
      turnId: oldTurn,
    }))).toMatchObject({ valid: true });
    // Expire only the synthetic launch window. Advancing Date while native
    // filesystem mtimes remain real can falsely age a new lock directory and
    // confound the concurrent single-generation assertion below.
    const [intentName] = (await readdir(paths.dispatchIntents)).filter((name) => name.endsWith('.json'));
    const intentFile = path.join(paths.dispatchIntents, intentName);
    const intent = await readJson(intentFile);
    const elapsed = {
      prepared_at: new Date(Date.now() - 62_000).toISOString(),
      launched_at: new Date(Date.now() - 61_000).toISOString(),
      authorized_at: new Date(Date.now() - 61_000).toISOString(),
      launch_expires_at: new Date(Date.now() - 1).toISOString(),
    };
    await atomicWriteJson(intentFile, {
      ...intent,
      ...elapsed,
      launch_generations: intent.launch_generations.map((entry) => (
        entry.generation === intent.launch_generation ? { ...entry, ...elapsed } : entry
      )),
    });

    const oldStart = codexStartInput({ turnId: `${oldTurn}-child`, model: action.dispatch.model.model });
    expect(await bindCodexSubagent(
      paths,
      await readJson(paths.active),
      oldStart,
    )).toMatchObject({ valid: true, bootstrap_required: true });
    const lateBootstrap = codexBootstrapInput(action, oldStart);
    expect(await bootstrapCodexSubagent(paths, await readJson(paths.active), lateBootstrap))
      .toMatchObject({ valid: false, binding_observation: { code: 'ticket_deadline_elapsed' } });
    expect((await dispatchGenerations(paths, ticketId)).some((record) => record.status === 'bound')).toBe(false);
    expect(Date.parse(action.ticket.deadline_at)).toBeGreaterThan(Date.now());

    const prepared = await Promise.allSettled([
      prepareCodexIntent(paths, action.ticket, action.ticket.role, { bootstrap_protocol: 1 }),
      prepareCodexIntent(paths, action.ticket, action.ticket.role, { bootstrap_protocol: 1 }),
    ]);
    const fulfilled = prepared
      .filter((entry) => entry.status === 'fulfilled')
      .map((entry) => entry.value);
    expect(fulfilled.length).toBeGreaterThan(0);
    if (fulfilled.length > 1) {
      expect(new Set(fulfilled.map((entry) => entry.agent_name)).size).toBe(1);
    }
    const generations = await dispatchGenerations(paths, ticketId);
    const expired = generations.find((record) => record.generation === 1);
    expect(expired).toBeTruthy();
    expect(
      ['expired', 'orphaned'].includes(expired.status) || typeof expired.orphaned_at === 'string',
    ).toBe(true);
    expect(new Set(generations.map((entry) => entry.generation))).toEqual(new Set([1, 2]));
    expect(generations.some((entry) => entry.generation === 2 && entry.status === 'prepared'))
      .toBe(true);

    const freshAction = {
      ...action,
      dispatch: {
        ...action.dispatch,
        agent_name: fulfilled[0].agent_name,
        bootstrap_args: fulfilled[0].bootstrap_args,
      },
    };
    const freshTurn = 'fresh-authorized-turn';
    expect(await launchCodexIntent(
      paths,
      await readJson(paths.active),
      codexLaunchInput(freshAction, {
        sessionId: 'fresh-parent',
        toolUseId: 'fresh-spawn',
        turnId: freshTurn,
      }),
    )).toMatchObject({ valid: true });
    expect(await bootstrapCodexSubagent(paths, await readJson(paths.active), lateBootstrap))
      .toMatchObject({ valid: false });
    const freshStart = codexStartInput({
      sessionId: 'fresh-parent',
      agentId: 'fresh-agent',
      turnId: `${freshTurn}-child`,
      model: action.dispatch.model.model,
    });
    expect(await bindCodexSubagent(
      paths,
      await readJson(paths.active),
      freshStart,
    )).toMatchObject({ valid: true, bootstrap_required: true });
    expect(await bootstrapCodexSubagent(paths, await readJson(paths.active), codexBootstrapInput(freshAction, freshStart)))
      .toMatchObject({ valid: true, ticket_id: ticketId });
  });
});
