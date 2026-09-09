#!/usr/bin/env node

import { appendFileSync, realpathSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

function parseArgs(argv) {
  if (argv.length !== 2 || argv[0] !== '--audit' || !argv[1]) {
    throw new Error('usage: node scripts/live-certification-catalog-stub.mjs --audit <path>');
  }
  return path.resolve(argv[1]);
}

function hasOnly(searchParams, names) {
  const allowed = new Set(names);
  const keys = [...searchParams.keys()];
  return keys.length === new Set(keys).size && keys.every((name) => allowed.has(name));
}

function directoryPage() {
  return { plugins: [], pagination: { next_page_token: null } };
}

export function catalogResponseFor(method, requestUrl) {
  let url;
  try {
    url = new URL(requestUrl, 'http://127.0.0.1');
  } catch {
    return { known: false, status: 400, body: { error: 'invalid request URL' } };
  }
  if (method !== 'GET') {
    return { known: false, status: 405, body: { error: 'method not allowed' } };
  }

  // Pinned Codex 0.153.4, commit 3d2ee51ca2d5db578f328aa75e20aa22c0197c9a:
  // core-plugins/src/remote.rs and remote_legacy.rs construct each query key
  // once; backend-client/src/client.rs uses the root-base user-settings route.
  const { pathname, searchParams } = url;
  if (pathname === '/api/codex/settings/user') {
    const valid = hasOnly(searchParams, []) && [...searchParams.keys()].length === 0;
    return valid
      ? { known: true, status: 200, body: { commit_attribution_enabled: false } }
      : { known: false, status: 400, body: { error: 'unexpected user-settings query' } };
  }
  // Codex 0.153.4 core-plugins/src/remote.rs fetch_recommended_plugins.
  if (pathname === '/ps/plugins/suggested/codex') {
    const valid = searchParams.size === 1 && searchParams.get('scope') === 'GLOBAL';
    return valid
      ? { known: true, status: 200, body: { enabled: true, plugins: [] } }
      : { known: false, status: 400, body: { error: 'unexpected suggested-plugin query' } };
  }
  if (pathname === '/ps/plugins/list') {
    const scope = searchParams.get('scope');
    const valid = hasOnly(searchParams, ['scope', 'limit', 'collection', 'pageToken'])
      && scope !== null
      && ['GLOBAL', 'USER', 'WORKSPACE'].includes(scope)
      && searchParams.get('limit') === '200';
    return valid
      ? { known: true, status: 200, body: directoryPage() }
      : { known: false, status: 400, body: { error: 'unexpected plugin-list query' } };
  }
  if (pathname === '/ps/plugins/installed') {
    const scope = searchParams.get('scope');
    const limit = searchParams.get('limit');
    const includeDownloadUrls = searchParams.get('includeDownloadUrls');
    // remote.rs get_remote_plugin_installed_page: All emits only limit=200;
    // Single emits only scope. Never combine or omit both selectors.
    const validScope = (scope === null && limit === '200')
      || (scope !== null && limit === null && ['GLOBAL', 'USER', 'WORKSPACE'].includes(scope));
    const valid = hasOnly(searchParams, ['scope', 'limit', 'includeDownloadUrls', 'pageToken'])
      && validScope
      && (includeDownloadUrls === null || includeDownloadUrls === 'true');
    return valid
      ? { known: true, status: 200, body: directoryPage() }
      : { known: false, status: 400, body: { error: 'unexpected installed-plugin query' } };
  }
  if (pathname === '/ps/plugins/workspace/shared') {
    const valid = hasOnly(searchParams, ['limit', 'pageToken'])
      && searchParams.get('limit') === '200';
    return valid
      ? { known: true, status: 200, body: directoryPage() }
      : { known: false, status: 400, body: { error: 'unexpected shared-plugin query' } };
  }
  if (pathname === '/plugins/featured') {
    const platform = searchParams.get('platform');
    const valid = hasOnly(searchParams, ['platform'])
      && platform !== null
      // protocol/src/protocol.rs Product::to_app_platform, consumed by
      // remote_legacy.rs fetch_remote_featured_plugin_ids.
      && ['codex', 'chat', 'atlas'].includes(platform);
    return valid
      ? { known: true, status: 200, body: [] }
      : { known: false, status: 400, body: { error: 'unexpected featured-plugin query' } };
  }
  return { known: false, status: 404, body: { error: 'unknown certification catalog route' } };
}

function invokedDirectly(argvPath) {
  if (!argvPath) return false;
  try {
    return realpathSync(argvPath) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (invokedDirectly(process.argv[1])) {
  try {
    const auditPath = parseArgs(process.argv.slice(2));
    writeFileSync(auditPath, '', { flag: 'wx', mode: 0o600 });
    let sequence = 0;
    const server = http.createServer((request, response) => {
      const result = catalogResponseFor(request.method, request.url ?? '');
      const record = {
        sequence: ++sequence,
        method: request.method ?? null,
        url: request.url ?? null,
        status: result.status,
        known: result.known,
      };
      appendFileSync(auditPath, `${JSON.stringify(record)}\n`);
      response.writeHead(result.status, {
        'content-type': 'application/json',
        'cache-control': 'no-store',
        connection: 'close',
      });
      response.end(`${JSON.stringify(result.body)}\n`);
    });
    server.requestTimeout = 5_000;
    server.headersTimeout = 5_000;
    server.keepAliveTimeout = 1;
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        throw new Error('catalog stub did not bind an IPv4 port');
      }
      process.stdout.write(`${JSON.stringify({
        base_url: `http://127.0.0.1:${address.port}`,
      })}\n`);
    });
    process.on('SIGTERM', () => server.close(() => process.exit(0)));
    process.on('SIGINT', () => server.close(() => process.exit(0)));
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}
