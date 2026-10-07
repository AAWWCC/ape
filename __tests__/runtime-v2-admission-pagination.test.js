import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { canonicalJson, sha256 } from '../lib/runtime/canonical.js';
import { previewRun, startRun } from '../lib/runtime/lifecycle-service.js';
import { ADMISSION_PAGE_BUDGET_BYTES, projectAdmissionPreview, projectRunResponse, RESPONSE_BUDGET_BYTES } from '../lib/runtime/projection.js';
import { handle as handleMcp } from '../bin/ape-mcp.mjs';

const roots = [];
const git = (root, ...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), 'ape-admission-pages-'));
  roots.push(root);
  git(root, 'init', '-q', '-b', 'main');
  git(root, 'config', 'user.name', 'Synthetic pagination');
  git(root, 'config', 'user.email', 'pagination@example.test');
  await writeFile(path.join(root, 'README.md'), 'Synthetic baseline\n');
  git(root, 'add', '.'); git(root, 'commit', '-qm', 'baseline');
  return root;
}
const input = (host = 'codex') => ({
  objective: `Review ${'\\\n🙂'.repeat(4000)}`, mode: 'phase', lane: 'mechanical', host,
  behavioral: false, claimed_paths: ['README.md'], test_paths: [], hooks_trusted: true,
  subagents_available: true, explicit_invocation: true, admission_contract_version: 1,
});
const frame = value => JSON.stringify({ resultType: 'complete', isError: false, content: [{ type: 'text', text: JSON.stringify(value) }] }, null, 2);
function assemble(pages) {
  expect(pages.length).toBeGreaterThan(0);
  let offset = 0;
  const first = pages[0].admission_delivery;
  const chunks = [];
  for (const [index, page] of pages.entries()) {
    expect(Buffer.byteLength(frame(page))).toBeLessThanOrEqual(ADMISSION_PAGE_BUDGET_BYTES);
    expect(page).not.toHaveProperty('admission');
    expect(page).not.toHaveProperty('admission_digest');
    const d = page.admission_delivery;
    expect(d).toMatchObject({ version: 1, kind: 'paged', digest: first.digest, total_utf8_bytes: first.total_utf8_bytes, offset });
    expect(d.sha256).toBe(sha256(d.text));
    offset += Buffer.byteLength(d.text);
    expect(d.next_offset).toBe(index === pages.length - 1 ? null : offset);
    chunks.push(d.text);
  }
  expect(offset).toBe(first.total_utf8_bytes);
  const text = chunks.join('');
  expect(sha256(text)).toBe(first.digest);
  const manifest = JSON.parse(text);
  expect(canonicalJson(manifest)).toBe(text);
  return manifest;
}
async function collect(read) {
  const pages = [];
  let request;
  do {
    const page = await read(request);
    pages.push(page);
    const d = page.admission_delivery;
    if (!d) throw Error(`Expected page: ${JSON.stringify(page)}`);
    expect(pages.length).toBeLessThan(100);
    request = d.next_offset === null ? null : { digest: d.digest, offset: d.next_offset };
  } while (request);
  return pages;
}
async function snapshot(root) {
  return { entries: (await readdir(root)).sort(), index: await readFile(path.join(root, '.git/index')),
    head: git(root, 'rev-parse', 'HEAD'), branches: git(root, 'for-each-ref', '--format=%(refname)', 'refs/heads'),
    runtime: await readFile(path.join(root, '.ape/runtime/config.json'), 'utf8').catch(() => null),
    runtimeEntries: await readdir(path.join(root, '.ape/runtime')).catch(() => null) };
}

describe('lossless read-only admission delivery', () => {
  it.each([
    { label: 'ASCII', detail: 'x'.repeat(196535) },
    { label: 'escaped text', detail: '\n\\"'.repeat(25000) },
    { label: 'Unicode', detail: '🙂漢é'.repeat(20000) },
  ])('reconstructs large $label without clipping', async ({ detail }) => {
    const admission = { version: 1, ready: true, detail };
    const response = { ok: true, advisory: true, admission, admission_digest: sha256(admission), blueprint: { stages: [] } };
    const before = structuredClone(response);
    const pages = await collect(page => projectAdmissionPreview(response, page));
    expect(assemble(pages)).toEqual(admission);
    expect(projectAdmissionPreview(response)).toEqual(pages[0]);
    for (const page of pages) expect(projectRunResponse(page)).toEqual(page);
    expect(response).toEqual(before);
    for (const invalid of [pages.slice(1), pages.slice(0, -1), [pages[0], ...pages], [...pages].reverse(),
      pages.map((p, i) => i === 0 ? { ...p, admission_delivery: { ...p.admission_delivery, text: 'corrupt' } } : p)]) {
      expect(() => assemble(invalid)).toThrow();
    }
  });

  it('keeps small previews inline and handles forced pages without a blueprint', () => {
    const admission = { version: 1, ready: false, detail: '🙂' };
    const response = { ok: true, advisory: true, admission, admission_digest: sha256(admission) };
    expect(projectAdmissionPreview(response)).toEqual(response);
    const page = projectAdmissionPreview(response, { digest: response.admission_digest, offset: 0 });
    expect(page.admission_summary.ready).toBe(false);
    expect(assemble([page])).toEqual(admission);
    const utf8 = Buffer.from(canonicalJson(admission));
    const insideEmoji = utf8.indexOf(Buffer.from('🙂')) + 1;
    for (const offset of [insideEmoji, utf8.length, utf8.length + 10]) {
      expect(projectAdmissionPreview(response, { digest: response.admission_digest, offset }).code).toBe('invalid-admission-page');
    }
  });

  it('pages previews below the general limit that exceed the default code-mode wrapper budget', () => {
    const admission = { version: 1, ready: true, detail: 'x'.repeat(42000) };
    const response = { ok: true, advisory: true, admission, admission_digest: sha256(admission) };
    expect(Buffer.byteLength(frame(response))).toBeLessThan(RESPONSE_BUDGET_BYTES);
    expect(projectRunResponse(response).admission_delivery.kind).toBe('paged');
  });

  it.each(['codex', 'claude'])('reviews all %s pages without writes and starts against the full digest', async host => {
    const root = await fixture();
    const request = input(host);
    const before = await snapshot(root);
    const pages = await collect(page => previewRun(root, { ...request, ...(page ? { admission_page: page } : {}) }));
    const manifest = assemble(pages);
    expect(manifest.ready).toBe(true);
    expect(manifest.request).not.toHaveProperty('admission_page');
    expect(await snapshot(root)).toEqual(before);
    const repeated = await previewRun(root, { ...request, admission_page: { digest: pages[0].admission_delivery.digest, offset: 0 } });
    expect(repeated).toEqual(pages[0]);
    const result = await startRun(root, { ...request, expected_admission_digest: sha256(manifest) });
    expect(result.ok).toBe(true);
    expect(result.run.admission.manifest).toEqual(manifest);
  });

  it.each(['input', 'repository', 'configuration'])('rejects %s drift between reads and before starting', async drift => {
    const root = await fixture();
    const request = input();
    const first = await previewRun(root, request);
    const d = first.admission_delivery;
    if (drift === 'input') request.objective += ' changed';
    if (drift === 'repository') await writeFile(path.join(root, 'README.md'), 'Changed baseline\n');
    if (drift === 'configuration') {
      await mkdir(path.join(root, '.ape/runtime'), { recursive: true });
      await writeFile(path.join(root, '.ape/runtime/config.json'), JSON.stringify({ policy: { high_risk_security_review: false } }));
    }
    const before = await snapshot(root);
    expect(await previewRun(root, { ...request, admission_page: { digest: d.digest, offset: d.next_offset } })).toMatchObject({ code: 'admission-drift', attempts_consumed: 0 });
    expect(await startRun(root, { ...request, expected_admission_digest: d.digest })).toMatchObject({ code: 'admission-drift', attempts_consumed: 0 });
    expect(await snapshot(root)).toEqual(before);
  });

  it('keeps genuine readiness failures authoritative for large manifests', async () => {
    const root = await fixture();
    await writeFile(path.join(root, 'README.md'), 'Dirty baseline\n');
    const request = input();
    const pages = await collect(page => previewRun(root, { ...request, ...(page ? { admission_page: page } : {}) }));
    const manifest = assemble(pages);
    expect(manifest.ready).toBe(false);
    const before = await snapshot(root);
    expect(await startRun(root, { ...request, expected_admission_digest: sha256(manifest) })).toMatchObject({ code: 'admission-not-ready', attempts_consumed: 0 });
    expect(await snapshot(root)).toEqual(before);
  });

  it('validates malformed cursors before reading the repository and rejects page fields on start', async () => {
    for (const admission_page of [null, [], {}, { digest: 'x', offset: 0 }, { digest: 'a'.repeat(64), offset: -1 },
      { digest: 'a'.repeat(64), offset: 0.5 }, { digest: 'a'.repeat(64), offset: 0, extra: true }]) {
      expect(await previewRun('/no/such/project', { ...input(), admission_page })).toMatchObject({ code: 'invalid-admission-page' });
    }
    await expect(startRun('/no/such/project', { ...input(), admission_page: { digest: 'a'.repeat(64), offset: 0 } })).rejects.toThrow(/only by preview/);
  });

  it.each(['codex', 'claude'])('delivers %s pages through the real MCP boundary', async host => {
    const root = await fixture();
    const args = { ...input(host), project_dir: root, action: 'preview' };
    const call = async arguments_ => {
      const r = await handleMcp({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'ape_run', arguments: arguments_ } });
      expect(r.error).toBeUndefined();
      return r.result;
    };
    const pages = await collect(async page => {
      const result = await call({ ...args, ...(page ? { admission_page: page } : {}) });
      expect(result.isError).not.toBe(true);
      expect(Buffer.byteLength(JSON.stringify(result, null, 2))).toBeLessThanOrEqual(ADMISSION_PAGE_BUDGET_BYTES);
      return JSON.parse(result.content[0].text);
    });
    expect(assemble(pages).request.objective).toBe(args.objective);
    for (const action of ['start', 'status', 'probe', 'resume']) {
      const result = await call({ ...args, action, admission_page: { digest: pages[0].admission_delivery.digest, offset: 0 } });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toMatch(/only by preview/);
    }
  });

  it.each(['codex', 'claude'])('delivers pages through the generated %s package', async host => {
    const root = await fixture();
    const entry = fileURLToPath(new URL(`../plugins/${host === 'codex' ? 'ape' : 'ape-claude'}/dist/ape-mcp.bundle.mjs`, import.meta.url));
    const env = { ...process.env };
    delete env.CLAUDE_PROJECT_DIR;
    delete env.CODEX_CWD;
    const args = { ...input(host), action: 'preview', project_dir: root };
    const pages = await collect(async page => {
      const message = { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'ape_run',
        arguments: { ...args, ...(page ? { admission_page: page } : {}) } } };
      const output = execFileSync(process.execPath, [entry, '--host', host], {
        cwd: root, env, encoding: 'utf8', input: JSON.stringify(message) + '\n', timeout: 10000,
      });
      const response = JSON.parse(output.trim());
      expect(response.result.isError).not.toBe(true);
      return JSON.parse(response.result.content[0].text);
    });
    expect(assemble(pages).request.objective).toBe(args.objective);
    expect((await snapshot(root)).entries).not.toContain('.ape');
  });
});
