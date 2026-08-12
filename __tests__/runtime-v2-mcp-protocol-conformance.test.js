import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createToolCallQueue } from '../bin/ape-mcp.mjs';

// MCP 2026-07-28 protocol conformance for the public server (bin/ape-mcp.mjs).
// Derivation of record: docs/research/2026-07-29-mcp-2026-07-28-stateless-spec.md
// ("Protocol-conformance defects"), traced to
// https://modelcontextprotocol.io/specification/2026-07-28/changelog.
//
// The five defects under test, with the changelog entry each rests on:
//  1. version echo    — the server returns whatever version it is asked for and
//     cannot refuse one it does not implement. Every modern request declares its
//     version in `_meta['io.modelcontextprotocol/protocolVersion']` (major 2) and
//     a mismatch MUST answer UnsupportedProtocolVersionError, code -32022
//     (renumbered by minor 12), listing the versions the server does support.
//  2. no `server/discover` — servers MUST implement it (major 3); it advertises
//     supportedVersions, capabilities and identity and is the STDIO
//     backward-compatibility probe.
//  3. no `resultType` — required on every result, `"complete"` for ordinary ones
//     (major 8).
//  4. the cacheable results carry no `ttlMs`/`cacheScope` — required via the
//     new CacheableResult interface, `cacheScope` being `"public"` or
//     `"private"` (minor 5). The obligation is stated PER OPERATION, not per
//     defect summary: "Servers MUST include caching hints on results with
//     resultType: "complete" returned by the following operations:
//     server/discover, tools/list, prompts/list, resources/list,
//     resources/templates/list, resources/read" (2026-07-28
//     server/utilities/caching, "Cacheable Results"). This server implements
//     two of those six — `server/discover`, which is FIRST in the list, and
//     `tools/list` — so BOTH are pinned below; the changelog's minor-5
//     enumeration omits `server/discover` only because that method is new in
//     this same revision. Deterministic tool order (minor 3) is already
//     satisfied by the frozen TOOLS literal and is pinned here as a guard.
//  5. the live `ping` handler asserts a MUST that major 5 deleted along with
//     `ping` itself. The handler stays (harmless backward compatibility); the
//     stale obligation in its comment must go.
//
// Two invariants of this file, both load-bearing:
//  - LEGACY RESULTS DO NOT CHANGE SHAPE. `initialize` and `ping` exist only for
//    pre-2026-07-28 clients, so their results stay byte-identical (in
//    particular `ping` answers exactly `{}` — independently pinned by
//    runtime-v2-mcp-interleaving.test.js). `resultType` is therefore asserted on
//    MODERN requests only, which leaves both sane implementations open: stamp it
//    on the modern methods, or stamp it whenever the request declares a modern
//    version.
//  - The request-scoped `notifications/progress` heartbeat survives this
//    revision untouched (major 4 is explicit), so the new `_meta` keys must
//    coexist with `_meta.progressToken` rather than displace it.
const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const pkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));

// The revision this run targets, and the pre-2026-07-28 revision the retained
// `initialize`/`ping` handlers speak. Both belong to the server's ONE declared
// supported set: a dual-era server that answers `initialize` genuinely supports
// the legacy revision, and the retained handler can only negotiate a version
// that set admits.
const MODERN = '2026-07-28';
const LEGACY = '2025-06-18';
// The spec's own worked example of a version no server implements.
const UNSUPPORTED = '1900-01-01';

const VERSION_META = 'io.modelcontextprotocol/protocolVersion';
const SERVER_INFO_META = 'io.modelcontextprotocol/serverInfo';

const scratches = [];

function scratchDir(prefix) {
  const dir = mkdtempSync(path.join(os.tmpdir(), prefix));
  scratches.push(dir);
  return dir;
}

afterEach(() => {
  vi.useRealTimers();
  for (const dir of scratches.splice(0)) rmSync(dir, { recursive: true, force: true });
});

// Batch stdio session: feed every frame, read every line written before the
// server exits (main() drains queued tool calls at EOF, so tool-call responses
// are always present). The ambient host pins are stripped so root resolution is
// driven by call arguments alone.
function session(messages) {
  return new Promise((resolve, reject) => {
    const env = { ...process.env };
    delete env.CLAUDE_PROJECT_DIR;
    delete env.CODEX_CWD;
    const child = spawn(process.execPath, [path.join(root, 'bin', 'ape-mcp.mjs')], {
      cwd: root,
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
      else {
        const lines = stdout.trim() ? stdout.trim().split(/\r?\n/) : [];
        resolve(lines.map((line) => JSON.parse(line)));
      }
    });
    child.stdin.end(`${messages.map((message) => JSON.stringify(message)).join('\n')}\n`);
  });
}

// Response order is not part of any contract here: a tool call settles on the
// queue while the read loop keeps answering protocol frames, so every
// assertion addresses its response by id.
const byId = (responses, id) => responses.find((entry) => entry.id === id);

// Bounded description of a response for a failure message: the tool schemas are
// enormous and dumping one buries the actual assertion.
const shape = (response) => {
  if (!response) return 'no response';
  if (response.error) return `error ${JSON.stringify(response.error).slice(0, 200)}`;
  return `result with keys [${Object.keys(response.result ?? {}).join(', ')}]`;
};

// The caching hints every cacheable `resultType: "complete"` result MUST carry.
// `ttlMs` is "an integer value in milliseconds specifying how long the client
// MAY consider the result fresh" and `cacheScope` "either `public` or
// `private`". A positive TTL is what the spec's own worked examples model for
// both of these operations (`ttlMs: 3600000` on the `server/discover` response,
// `ttlMs: 300000` on the `tools/list` sequence in "Caching"), and both of this
// server's cacheable results are process constants — a frozen tool literal, and
// a frozen version set plus identity read from package.json — so nothing here
// pushes either toward the stale-immediately `0`.
const expectCacheHints = (value, label) => {
  expect(
    Number.isInteger(value?.ttlMs) && value.ttlMs > 0,
    `${label} must return a positive integer ttlMs freshness hint in milliseconds ` +
      `(got ${JSON.stringify(value?.ttlMs)})`,
  ).toBe(true);
  expect(
    value.cacheScope,
    `${label}: cacheScope controls whether shared intermediaries may cache the response`,
  ).toMatch(/^(public|private)$/);
};

// A modern request: params carrying the per-request protocol version in `_meta`.
const modern = (version, params = {}) => ({
  ...params,
  _meta: { ...(params._meta ?? {}), [VERSION_META]: version },
});

const toolsList = (id, params) => ({ jsonrpc: '2.0', id, method: 'tools/list', params });
const discoverCall = (id, version = MODERN) => ({
  jsonrpc: '2.0',
  id,
  method: 'server/discover',
  params: modern(version),
});
const toolCall = (id, args, params = {}) => ({
  jsonrpc: '2.0',
  id,
  method: 'tools/call',
  params: { name: 'ape_run', arguments: args, ...params },
});

describe('MCP 2026-07-28: per-request protocol version negotiation (defect 1)', () => {
  it('refuses an unsupported _meta version with -32022 listing the versions it supports', async () => {
    const responses = await session([
      discoverCall(1),
      toolsList(2, modern(UNSUPPORTED)),
      toolsList(3, modern(MODERN)),
    ]);

    const refusal = byId(responses, 2);
    expect(
      refusal,
      'the server must answer a version-mismatched tools/list rather than drop it',
    ).toBeDefined();
    expect(
      refusal.error?.code,
      'an unsupported per-request protocol version MUST answer ' +
        `UnsupportedProtocolVersionError (-32022); got ${shape(refusal)}`,
    ).toBe(-32022);
    expect(refusal.error.message).toMatch(/unsupported\s*protocol\s*version/i);
    // "…MUST respond with an UnsupportedProtocolVersionError LISTING THE
    // VERSIONS IT DOES SUPPORT": the client's documented recovery is to pick a
    // mutually supported version off `data.supported` and retry.
    expect(
      Array.isArray(refusal.error.data?.supported),
      'the -32022 error data must carry a `supported` array of protocol versions',
    ).toBe(true);
    expect(refusal.error.data.supported).toContain(MODERN);
    expect(refusal.error.data.requested).toBe(UNSUPPORTED);

    // One declared supported set: the versions named in the refusal are the
    // versions server/discover advertises. A refusal offering a version
    // discovery denies (or vice versa) would send the client in circles.
    const advertised = byId(responses, 1).result?.supportedVersions;
    expect(
      Array.isArray(advertised),
      'server/discover must advertise supportedVersions before the two surfaces can be compared',
    ).toBe(true);
    for (const version of refusal.error.data.supported) {
      expect(advertised, `-32022 offered "${version}", which server/discover does not advertise`)
        .toContain(version);
    }

    // A version the server does implement is served normally.
    const accepted = byId(responses, 3);
    expect(accepted.error, 'a supported _meta version must not be refused').toBeUndefined();
    expect(accepted.result.tools.map((tool) => tool.name)).toEqual([
      'ape_run',
      'ape_status',
      'ape_history',
      'ape_config',
    ]);
  }, 20_000);

  it('refuses a version-mismatched tools/call WITHOUT executing the tool, and keeps serving', async () => {
    // project_dir aims the call at an empty scratch dir: if the gate regresses
    // and the tool runs, it runs against nothing instead of this repo's live
    // .ape state — and its result is the very thing this test forbids.
    const scratch = scratchDir('ape-mcp-conformance-version-');
    const responses = await session([
      toolCall(1, { action: 'status', project_dir: scratch }, modern(UNSUPPORTED)),
      toolsList(2, modern(MODERN)),
    ]);

    const refusal = byId(responses, 1);
    expect(refusal, 'a version-mismatched tools/call must still be answered').toBeDefined();
    expect(
      refusal.error?.code,
      `a version mismatch is a protocol error, not a tool result; got ${shape(refusal)}`,
    ).toBe(-32022);
    // executeToolCall ALWAYS produces a `result` (tool faults become isError
    // results), so the absence of `result` is the proof the tool never ran.
    expect(
      Object.hasOwn(refusal, 'result'),
      'a version-mismatched tools/call must not execute the tool',
    ).toBe(false);

    // The refusal is per-request: the server keeps answering afterwards.
    const after = byId(responses, 2);
    expect(after.error).toBeUndefined();
    expect(after.result.tools).toHaveLength(4);
  }, 20_000);

  it('answers an unsupported initialize with a LEGACY revision, never the modern one', async () => {
    // Three shapes of "a version this server does not implement", requested
    // through the retained handshake: the spec's worked nonsense date, and two
    // real pre-2026-07-28 revisions a legacy client can genuinely open with.
    const unsupportedRequests = [UNSUPPORTED, '2025-11-25', '2024-11-05'];
    const responses = await session([
      discoverCall(1),
      ...unsupportedRequests.map((protocolVersion, index) => ({
        jsonrpc: '2.0',
        id: index + 2,
        method: 'initialize',
        params: {
          protocolVersion,
          capabilities: {},
          clientInfo: { name: 'legacy-client', version: '0.0.1' },
        },
      })),
    ]);

    const advertised = byId(responses, 1).result?.supportedVersions;
    unsupportedRequests.forEach((requested, index) => {
      const handshake = byId(responses, index + 2);
      // A legacy client has no fall-forward mechanism, so the retained
      // handshake answers (it does not error) — but it must answer with a
      // version this server actually implements, never the caller's own string.
      expect(
        handshake?.error,
        `the retained legacy handshake must answer a legacy client requesting "${requested}"`,
      ).toBeUndefined();
      expect(
        handshake.result.protocolVersion,
        'initialize must not echo a protocol version the server does not implement',
      ).not.toBe(requested);
      expect(
        advertised,
        `initialize negotiated "${handshake.result.protocolVersion}" for requested ` +
          `"${requested}", which is not in the server's declared supported set`,
      ).toContain(handshake.result.protocolVersion);
      // …and the version it settles on must be one this handshake can actually
      // carry. 2026-07-28 has NO `initialize` at all: "an initialize request
      // selects legacy semantics, scoped to the stdio process (stdio) or the
      // session (HTTP), as specified by the negotiated legacy protocol
      // version" (2026-07-28 basic/versioning, "Backward Compatibility with
      // Initialization-Based Versions"), whose Terminology fixes MODERN as
      // 2026-07-28-and-later and LEGACY as 2025-11-25-and-earlier. Offering
      // the modern revision to a client that speaks only the handshake names a
      // revision it cannot speak, and 2025-06-18 lifecycle then has it
      // disconnect ("if the client does not support the version in the
      // server's response, it SHOULD disconnect") — strictly worse than the
      // verbatim echo this negotiation replaces. Protocol versions are ISO
      // dates, so the era test is an ordinal comparison.
      expect(
        handshake.result.protocolVersion < MODERN,
        `initialize negotiated "${handshake.result.protocolVersion}" for requested ` +
          `"${requested}": a legacy handshake must settle on a pre-${MODERN} revision, and ` +
          `${MODERN} carries no initialize for the client to continue with`,
      ).toBe(true);
    });
  }, 20_000);
});

describe('MCP 2026-07-28: server/discover (defect 2)', () => {
  it('advertises supported protocol versions, capabilities and identity', async () => {
    const responses = await session([
      discoverCall(1),
      // Adding server/discover must not turn the unknown-method fallthrough
      // into a version error: an unimplemented method is still -32601.
      { jsonrpc: '2.0', id: 2, method: 'resources/list', params: modern(MODERN) },
    ]);

    const discover = byId(responses, 1);
    expect(
      discover.error,
      `server/discover MUST be implemented; got ${shape(discover)}`,
    ).toBeUndefined();
    const value = discover.result;

    expect(Array.isArray(value.supportedVersions), 'DiscoverResult.supportedVersions must be an array').toBe(true);
    for (const version of value.supportedVersions) {
      expect(typeof version, 'every advertised protocol version must be a string').toBe('string');
    }
    expect(value.supportedVersions).toContain(MODERN);
    // The retained initialize handler makes this server dual-era, so the
    // legacy revision it speaks belongs to the same declared set — otherwise
    // the handshake could only ever negotiate a version the set denies.
    expect(
      value.supportedVersions,
      `a server that answers initialize supports ${LEGACY} and must advertise it`,
    ).toContain(LEGACY);

    expect(value.capabilities, 'DiscoverResult.capabilities must advertise the tools capability')
      .toMatchObject({ tools: {} });

    const identity = value._meta?.[SERVER_INFO_META];
    expect(
      identity,
      `DiscoverResult must carry identity at result._meta["${SERVER_INFO_META}"]`,
    ).toBeDefined();
    expect(identity.name).toBe('ape');
    // Read from package.json, never a literal a release bump has to chase.
    expect(identity.version).toBe(pkg.version);

    expect(byId(responses, 2).error?.code, 'an unimplemented method stays -32601').toBe(-32601);
  }, 20_000);
});

describe('MCP 2026-07-28: required resultType (defect 3)', () => {
  it('stamps resultType "complete" on modern discover, tools/list and tools/call results', async () => {
    const scratch = scratchDir('ape-mcp-conformance-result-');
    const responses = await session([
      discoverCall(1),
      toolsList(2, modern(MODERN)),
      toolCall(3, { action: 'status', project_dir: scratch }, modern(MODERN)),
      // An isError tool result is still an ORDINARY result: the interim
      // "input_required" type belongs to MRTR, which this server does not use.
      toolCall(
        4,
        { action: 'abort', operation: 'reset', reason: 'operator cleanup', project_dir: scratch },
        modern(MODERN),
      ),
    ]);

    for (const id of [1, 2, 3, 4]) {
      const response = byId(responses, id);
      expect(response.error, `id ${id} must return a result to carry resultType`).toBeUndefined();
      expect(
        response.result.resultType,
        `every 2026-07-28 result carries resultType "complete" (id ${id})`,
      ).toBe('complete');
    }

    // resultType is additive: the payload each result already carried is intact.
    expect(byId(responses, 2).result.tools).toHaveLength(4);
    const status = byId(responses, 3).result;
    expect(status.isError).toBeUndefined();
    expect(JSON.parse(status.content[0].text)).toMatchObject({ ok: true, active: false });
    const guarded = byId(responses, 4).result;
    expect(guarded.isError).toBe(true);
    expect(guarded.content[0].text).toMatch(/operation 'reset' belongs to action 'override'/);
  }, 20_000);
});

describe('MCP 2026-07-28: CacheableResult on every cacheable result (defect 4)', () => {
  it('returns ttlMs and cacheScope on tools/list, and keeps the tool order deterministic', async () => {
    const responses = await session([
      toolsList(1, modern(MODERN)),
      toolsList(2, modern(MODERN)),
    ]);

    for (const id of [1, 2]) expectCacheHints(byId(responses, id).result, `tools/list (id ${id})`);

    // The deterministic-order SHOULD (minor 3) is already satisfied by the
    // frozen TOOLS literal; cache fields must not disturb it.
    const first = byId(responses, 1).result;
    const second = byId(responses, 2).result;
    expect(second.tools).toEqual(first.tools);
    expect(first.tools.map((tool) => tool.name)).toEqual(['ape_run', 'ape_status', 'ape_history', 'ape_config']);
  }, 20_000);

  it('returns ttlMs and cacheScope on server/discover, which heads the MUST list', async () => {
    // `server/discover` is the FIRST operation named by "Cacheable Results",
    // and the spec's own worked `server/discover` response carries
    // `ttlMs: 3600000` with `cacheScope: "public"` beside its `resultType:
    // "complete"`. A newly-mandatory RPC that answers with `resultType:
    // "complete"` (pinned by the defect-3 case above) and no hints violates a
    // MUST on the very result this run introduces.
    const responses = await session([discoverCall(1)]);

    const discover = byId(responses, 1);
    expect(
      discover?.error,
      `server/discover must return a result to carry cache hints; got ${shape(discover)}`,
    ).toBeUndefined();
    expectCacheHints(discover.result, 'server/discover');

    // The hints are ADDITIVE: discovery still advertises everything defect 2
    // requires of it.
    expect(discover.result.supportedVersions).toContain(MODERN);
    expect(discover.result.capabilities).toMatchObject({ tools: {} });
    expect(discover.result._meta?.[SERVER_INFO_META]).toMatchObject({ name: 'ape' });
  }, 20_000);
});

describe('MCP 2026-07-28: retained pre-2026-07-28 surface (defect 5 and the era constraint)', () => {
  it('still serves a whole old-era handshake with byte-identical legacy results', async () => {
    const responses = await session([
      {
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: LEGACY,
          capabilities: {},
          clientInfo: { name: 'legacy-client', version: '0.0.1' },
        },
      },
      // The legacy handshake's second leg is an id-less notification: it is
      // answered by nothing, and must stay that way.
      { jsonrpc: '2.0', method: 'notifications/initialized', params: {} },
      // A legacy client declares no per-request `_meta` version. Absence is
      // not a mismatch: these requests must be served, not refused.
      toolsList(2, {}),
      { jsonrpc: '2.0', id: 3, method: 'ping' },
    ]);

    expect(
      responses,
      'an id-less notification must draw no response frame',
    ).toHaveLength(3);

    const handshake = byId(responses, 1);
    expect(handshake.error).toBeUndefined();
    // A requested version the server DOES support comes back unchanged.
    expect(handshake.result.protocolVersion).toBe(LEGACY);
    expect(handshake.result.capabilities).toMatchObject({ tools: {} });
    expect(handshake.result.serverInfo).toMatchObject({ name: 'ape', version: pkg.version });

    expect(byId(responses, 2).result.tools.map((tool) => tool.name)).toEqual([
      'ape_run',
      'ape_status',
      'ape_history',
      'ape_config',
    ]);

    // `ping` is REMOVED by this revision, so it has no resultType obligation:
    // it exists only for pre-2026-07-28 clients and its result stays exactly
    // the empty object they expect (independently pinned by
    // runtime-v2-mcp-interleaving.test.js). A resultType stamped
    // unconditionally inside result() would break both this and that.
    expect(
      byId(responses, 3).result,
      'the retained ping handler must keep answering the legacy empty result',
    ).toEqual({});
  }, 20_000);

  it('no longer states the deleted ping MUST in bin/ape-mcp.mjs', async () => {
    const source = readFileSync(path.join(root, 'bin', 'ape-mcp.mjs'), 'utf8');

    // The handler itself stays: this is the code half of "keep the code, fix
    // the comment". (Assertions on this file are written as booleans — a
    // regex matcher against a 400-line source dumps the whole file into the
    // failure report.)
    expect(
      /'ping'/.test(source),
      'the ping handler must be retained for pre-2026-07-28 clients',
    ).toBe(true);

    // The stale obligations. `ping` was removed by this revision, so no
    // receiver MUST answer it and no spec-compliant client uses it.
    expect(
      /MUST\s+answer\s+ping/i.test(source),
      'bin/ape-mcp.mjs still asserts that receivers MUST answer ping — an obligation 2026-07-28 deleted',
    ).toBe(false);
    expect(
      /spec-compliant\s+clients\s+use\s+it/i.test(source),
      'bin/ape-mcp.mjs still claims spec-compliant clients use ping — 2026-07-28 removed ping',
    ).toBe(false);

    // …and the truth is recorded where the reader of the handler will meet it:
    // some comment neighbouring a ping mention must name the revision, the
    // removal, and why the handler nonetheless stays.
    const lines = source.split('\n');
    const windows = lines
      .map((line, index) => (/ping/i.test(line) ? index : -1))
      .filter((index) => index >= 0)
      .map((index) => lines.slice(Math.max(0, index - 10), index + 4).join('\n'));
    const documented = windows.filter((window) =>
      /2026-07-28/.test(window) &&
      /remov|delet|no longer/i.test(window) &&
      /legacy|pre-2026|older|backward/i.test(window));
    expect(
      documented.length,
      'no comment beside the ping handler records that 2026-07-28 removed ping and that the ' +
        'handler is kept only for pre-2026-07-28 clients — a future reader takes the old MUST as current',
    ).toBeGreaterThan(0);
  });

  it('keeps the progress heartbeat alive when _meta also declares the protocol version', async () => {
    // Request-scoped notifications survive this revision (major 4). The new
    // `_meta` keys must therefore sit ALONGSIDE progressToken: a rewrite that
    // reads `_meta` as version-only would silently kill the anti-timeout
    // heartbeat for every long gate run.
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'Date'] });
    const lines = [];
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    const queue = createToolCallQueue({
      execute: async (message) => {
        await gate;
        return { jsonrpc: '2.0', id: message.id, result: { ok: true } };
      },
      writeLine: (payload) => lines.push(payload),
    });
    queue.enqueue({
      id: 1,
      method: 'tools/call',
      params: {
        name: 'ape_run',
        arguments: { action: 'regate' },
        _meta: { progressToken: 'tok-modern', [VERSION_META]: MODERN },
      },
    });

    await vi.advanceTimersByTimeAsync(10_000);
    const progress = lines.filter((line) => line.method === 'notifications/progress');
    expect(progress).toHaveLength(1);
    expect(progress[0].params).toMatchObject({
      progressToken: 'tok-modern',
      message: 'ape_run regate in progress (10s)',
    });

    release();
    await queue.drain();
    expect(lines.filter((line) => line.id === 1)).toHaveLength(1);
  });
});

describe('MCP 2026-07-28: documented handshake surface', () => {
  it('documents the negotiation, discovery, resultType and cache fields in docs/mcp-tools.md', () => {
    const doc = readFileSync(path.join(root, 'docs', 'mcp-tools.md'), 'utf8');
    const required = [
      'server/discover',
      'supportedVersions',
      VERSION_META,
      '-32022',
      'resultType',
      'ttlMs',
      'cacheScope',
      MODERN,
      LEGACY,
      'initialize',
      'ping',
    ];
    for (const token of required) {
      expect(
        doc.includes(token),
        `docs/mcp-tools.md must document the handshake surface: "${token}" is absent`,
      ).toBe(true);
    }
    expect(
      /legacy|pre-2026-07-28|backward/i.test(doc),
      'docs/mcp-tools.md must say why initialize/ping are retained (pre-2026-07-28 clients)',
    ).toBe(true);
  });
});
