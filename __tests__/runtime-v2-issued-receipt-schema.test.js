import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { seedLegacyRun } from './legacy-run-test-helper.js';
import { sha256 } from '../lib/runtime/canonical.js';
import { receiptOutputSchemaForTicket, validateReceiptDraft } from '../lib/runtime/receipt-validator.js';
import { runtimePaths } from '../lib/runtime/paths.js';
import { atomicWriteJson } from '../lib/runtime/storage.js';

const cleanups = [];
afterEach(async () => Promise.all(cleanups.splice(0).map((dir) =>
  rm(dir, { recursive: true, force: true }))));

async function issuedTicket(overrides = {}) {
  const dir = await mkdtemp(path.join(tmpdir(), 'ape-issued-receipt-schema-'));
  cleanups.push(dir);
  await mkdir(path.join(dir, 'src'));
  await mkdir(path.join(dir, 'tests'));
  await writeFile(path.join(dir, 'src/value.js'), 'export const value = 1;\n');
  await writeFile(path.join(dir, 'tests/value.test.js'), 'export {};\n');
  const git = (...args) => execFileSync('git', args, { cwd: dir, stdio: 'ignore' });
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 'ape@example.test');
  git('config', 'user.name', 'APE Test');
  git('add', '.');
  git('commit', '-qm', 'synthetic baseline');
  await atomicWriteJson(runtimePaths(dir).config, {
    test_commands: { full: 'node --test', targeted_template: 'node --test {paths}' },
  });
  // Exercise production ticket issuance with a frozen capability catalog in a
  // disposable historical-state fixture. No native worker or probe is launched.
  const started = await seedLegacyRun(dir, {
    objective: 'Update the value while preserving the declared test contract',
    host: 'codex', binding_protocol: 'native-v1',
    mode: 'phase', lane: 'mechanical', behavioral: false,
    plan_contract_version: 1,
    claimed_paths: ['src/value.js'], test_paths: ['tests/value.test.js'],
    ...overrides,
  }, { nativeReceiptContract: true });
  return started.run.tickets[0];
}

function draft(ticket, overrides = {}) {
  return {
    ticket_id: ticket.ticket_id, status: 'passed', tests: [], findings: [],
    evidence: { summary: 'complete' }, receipt_capability: 'a'.repeat(32),
    ...overrides,
  };
}

describe('runtime-issued immutable receipt schemas', () => {
  it.each([
    ['implementer', {}],
    ['preflight_analyst', { lane: 'full', behavioral: true, plan_contract_version: 2 }],
    ['planner', { lane: 'full' }],
    ['test_writer', { lane: 'fast', behavioral: true }],
  ])('publishes the exact specialized contract for %s', async (role, overrides) => {
    const ticket = await issuedTicket(overrides);
    expect(ticket.role).toBe(role);
    expect(ticket.output_schema).toEqual(receiptOutputSchemaForTicket(ticket));
    expect(ticket.capability_manifest.receipt_schema.hash).toBe(sha256(ticket.output_schema));
  });

  it('discloses required passing tests and the authorized contradiction paths to the implementer', async () => {
    const ticket = await issuedTicket();
    expect(ticket.required_checks).toEqual(['targeted-tests']);
    const passingRule = ticket.output_schema.allOf.find((rule) => rule.then?.properties?.tests?.contains);
    expect(passingRule).toBeDefined();
    const missingTests = validateReceiptDraft(ticket, draft(ticket));
    expect(missingTests.valid).toBe(false);
    expect(missingTests.corrections.some((entry) => entry.field === 'tests')).toBe(true);
    const contradiction = ticket.output_schema.properties.evidence.properties.test_contradiction;
    expect(contradiction.properties.test_paths.items.enum).toEqual(ticket.test_paths);
    expect(validateReceiptDraft(ticket, draft(ticket, {
      status: 'failed',
      evidence: {
        failure_kind: 'test-contradiction',
        test_contradiction: { test_paths: ticket.test_paths, summary: 'Declared fixture contradicts its acceptance condition.' },
      },
    })).valid).toBe(true);
  });
});
