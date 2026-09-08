import { afterEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { sha256 } from '../lib/runtime/canonical.js';
import { ticketCapabilityManifest } from '../lib/runtime/capability-manifest.js';
import { parseEvidenceCommand } from '../lib/runtime/evidence-policy.js';
import { receiptOutputSchemaForTicket, validateReceiptDraft } from '../lib/runtime/receipt-validator.js';
import { renderCommand, splitCommand, templateInvocation } from '../lib/runtime/runner.js';

const directories = [];
afterEach(() => {
  for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function project() {
  const dir = mkdtempSync(path.join(tmpdir(), 'ape-command-roundtrip-'));
  directories.push(dir);
  return dir;
}

function ticketFor(testPath, template = 'node --test {paths}') {
  const state = {
    binding_protocol: 'native-v1', objective: 'Validate exact test command evidence',
    test_paths: [testPath], claimed_paths: [testPath],
    capability_snapshot: {
      version: 1, config_hash: 'a'.repeat(64), manifest_roles: ['planner', 'implementer'],
      manifest_growth_contract_version: 2, command_profiles: [], required_capabilities: [],
      verification_profiles: [], test_commands: { targeted_template: template },
      runners: [], evidence_scripts: [],
    },
  };
  const ticket = {
    objective: state.objective, ticket_id: 'run-command:build:ticket-1', run_id: 'run-command',
    stage_id: 'build', role: 'implementer', claimed_paths: [testPath], test_paths: [testPath],
    required_checks: [], receipt_contract_version: 1,
    capability_manifest: ticketCapabilityManifest(state, { role: 'implementer' }, state.test_paths),
  };
  ticket.output_schema = receiptOutputSchemaForTicket(ticket);
  ticket.capability_manifest.receipt_schema = { ref: 'ticket.output_schema', hash: sha256(ticket.output_schema) };
  return { ticket, state };
}

function draftFor(ticket, command, result) {
  return {
    ticket_id: ticket.ticket_id, status: 'passed', receipt_capability: 'r'.repeat(32),
    tests: [{ command, passed: result.status === 0, exit_code: result.status, duration_ms: 1 }],
    findings: [], evidence: {},
  };
}

describe('capability command argv preservation', () => {
  it('preserves empty arguments and literal shell syntax through the execution tokenizer', () => {
    const argv = ['node', '', 'value with spaces', "it's", 'both\'\"quotes', '$HOME', '\\value',
      'tests/[id]/value.test.cjs', '=node', '^name', '--key==literal', '%PATH%'];
    expect(splitCommand(renderCommand(argv))).toEqual(argv);
    expect(renderCommand(['node', '--test', '--test-name-pattern=literal', 'test.cjs']))
      .toBe('node --test --test-name-pattern=literal test.cjs');
    const dir = project();
    writeFileSync(path.join(dir, 'argv.cjs'), 'process.stdout.write(JSON.stringify(process.argv.slice(2)))');
    const invocation = splitCommand(renderCommand(['node', 'argv.cjs', ...argv.slice(1)]));
    const result = spawnSync(process.execPath, invocation.slice(1), { cwd: dir, encoding: 'utf8', timeout: 5_000 });
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual(argv.slice(1));
  });

  it.skipIf(process.platform === 'win32')('also preserves literal argv through a POSIX shell', () => {
    const dir = project();
    writeFileSync(path.join(dir, 'argv.cjs'), 'process.stdout.write(JSON.stringify(process.argv.slice(2)))');
    const args = ['', 'space value', "it's", '$HOME', '`pwd`', '\\backslash', 'a;b', '[id]', '=node', '^name'];
    const result = spawnSync('/bin/sh', ['-c', renderCommand([process.execPath, 'argv.cjs', ...args])], {
      cwd: dir, encoding: 'utf8', timeout: 5_000,
    });
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual(args);
  });

  it.each(['value with spaces.test.cjs', 'tests/[id]/value.test.cjs', "it's.test.cjs"])(
    'publishes executable targeted and planning commands for %s and accepts their actual receipt', (testPath) => {
      const dir = project();
      mkdirSync(path.dirname(path.join(dir, testPath)), { recursive: true });
      writeFileSync(path.join(dir, testPath), "require('node:test').test('actual authored test',()=>{});\n");
      const { ticket, state } = ticketFor(testPath, testPath.includes('[id]') ? 'node {paths}' : 'node --test {paths}');
      const [command] = ticket.capability_manifest.allowed_evidence_commands;
      const expected = templateInvocation(state.capability_snapshot.test_commands.targeted_template, [testPath]);
      expect(splitCommand(command)).toEqual([expected.command, ...expected.args]);
      const planning = ticketCapabilityManifest(state, { role: 'planner' }, [testPath]);
      expect(planning.plannable_evidence_commands).toContain(command);
      const result = spawnSync(process.execPath, splitCommand(command).slice(1), {
        cwd: dir, encoding: 'utf8', timeout: 5_000,
      });
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toContain('actual authored test');
      expect(validateReceiptDraft(ticket, draftFor(ticket, command, result))).toMatchObject({ valid: true });
      expect(validateReceiptDraft(ticket, draftFor(ticket, `node --test ${testPath}`, result)))
        .toMatchObject({ valid: false });
    },
  );

  it('retains the literal bracket path already accepted by the hook parser', () => {
    const testPath = 'tests/[id]/value.test.cjs';
    const { ticket } = ticketFor(testPath);
    const [command] = ticket.capability_manifest.allowed_evidence_commands;
    expect(parseEvidenceCommand(command)).toEqual({ cdTarget: null, tokens: ['node', '--test', testPath] });
  });
});
