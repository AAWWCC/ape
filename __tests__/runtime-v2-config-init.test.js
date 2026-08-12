import { describe, it, expect, afterEach } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync, spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { configAction } from '../lib/runtime/service.js';
import { doctor } from '../lib/runtime/doctor.js';

// Foreign-repo onboarding (`ape_config init`): a project that has never used
// APE inspects its own manifests and proposes grounded gate commands, then
// persists them only on explicit `apply`. These tests drive the PUBLIC
// configAction/doctor surfaces against temp fixtures plus the MCP tool schema,
// deriving expectations from the contract (deterministic grounded proposals,
// no writes on propose, explicit_keys provenance on apply, an advisory doctor
// check) rather than any implementation detail. Grounded SUBSTRINGS ('vitest',
// '{paths}') and value/rationale SHAPE are asserted — never byte-exact whole
// commands — so any correct decision-table implementation passes.

const root = dirname(dirname(fileURLToPath(import.meta.url)));

// Self-contained MCP session (mirrors __tests__/runtime-v2-mcp.test.js): one
// child process per call over stdio, with the ambient host project pins
// stripped so tools/list is answered from the server's own tool table alone.
function mcpSession(messages) {
  return new Promise((resolve, reject) => {
    const env = { ...process.env };
    delete env.CLAUDE_PROJECT_DIR;
    delete env.CODEX_CWD;
    const child = spawn(process.execPath, [join(root, 'bin', 'ape-mcp.mjs')], {
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
      else resolve(stdout.trim().split(/\r?\n/).map((line) => JSON.parse(line)));
    });
    child.stdin.end(messages.map((message) => JSON.stringify(message)).join('\n') + '\n');
  });
}

// The onboarding slots `ape_config init` may PROPOSE: the whole-command
// templates PLUS the two composable serialize/shuffle MODIFIERS
// (onboarding-modifier-proposals). A superset of what any single runner
// grounds; the guard below asserts every proposed slot is a member.
const PROPOSABLE_SLOTS = [
  'targeted', 'targeted_template', 'impacted_template', 'full', 'full_serial', 'serialize', 'shuffle',
];

function vitestPackageJson() {
  return JSON.stringify({
    name: 'fixture-vitest',
    version: '1.0.0',
    scripts: { test: 'vitest run' },
    devDependencies: { vitest: '^2.0.0' },
  }, null, 2);
}

function nodeTestPackageJson() {
  return JSON.stringify({
    name: 'fixture-node-test',
    version: '1.0.0',
    scripts: { test: 'node --test' },
  }, null, 2);
}

describe('ape v2 config init onboarding', () => {
  const dirs = [];
  afterEach(() => dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })));

  const configFile = (dir) => join(dir, '.ape', 'runtime', 'config.json');
  const stored = (dir) => JSON.parse(readFileSync(configFile(dir), 'utf8'));

  function tempProject(prefix) {
    const dir = mkdtempSync(join(tmpdir(), prefix));
    dirs.push(dir);
    return dir;
  }
  function vitestProject() {
    const dir = tempProject('ape-init-vitest-');
    writeFileSync(join(dir, 'package.json'), vitestPackageJson());
    return dir;
  }
  function nodeTestProject() {
    const dir = tempProject('ape-init-node-');
    writeFileSync(join(dir, 'package.json'), nodeTestPackageJson());
    return dir;
  }
  function emptyProject() {
    return tempProject('ape-init-empty-');
  }
  // Fixtures asserting doctor health must git-init their temp dir so the
  // git-repository check passes (gitProject pattern from the doctor suite).
  function gitProject(prefix = 'ape-init-doctor-') {
    const dir = tempProject(prefix);
    execFileSync('git', ['init'], { cwd: dir, stdio: 'ignore' });
    return dir;
  }

  // The init result object is either returned top-level or under an `init`
  // wrapper; accept either so any faithful surface shape passes.
  const initResult = (res) => {
    expect(res.ok).toBe(true);
    return res.init ?? res;
  };

  // ---- PROPOSE (default: configAction(dir, 'init', {})) -----------------

  it('vitest project: proposes grounded, path-scoped commands, marks the proposal complete, and writes nothing', async () => {
    const dir = vitestProject();
    const r = initResult(await configAction(dir, 'init', {}));
    expect(r.applied).toBe(false);

    const tc = r.proposal.test_commands;
    // Every proposed slot is one of the five and carries {value, rationale}.
    for (const [slot, entry] of Object.entries(tc)) {
      expect(PROPOSABLE_SLOTS).toContain(slot);
      expect(typeof entry.value).toBe('string');
      expect(entry.value.length).toBeGreaterThan(0);
      expect(typeof entry.rationale).toBe('string');
      expect(entry.rationale.length).toBeGreaterThan(0);
    }

    // targeted_template: vitest-grounded and path-scoped ('{paths}' token).
    expect(tc.targeted_template).toBeDefined();
    expect(tc.targeted_template.value).toContain('vitest');
    expect(tc.targeted_template.value).toContain('{paths}');
    expect(tc.targeted_template.rationale).toContain('vitest');

    // full: a vitest command, never the bare npm-test wrapper — a recognized
    // runner outranks the bare script.
    expect(tc.full).toBeDefined();
    expect(tc.full.value).toContain('vitest');
    expect(tc.full.value).not.toBe('npm test');
    expect(tc.full.rationale).toContain('vitest');

    // full_serial: the serialized vitest variant.
    expect(tc.full_serial).toBeDefined();
    expect(tc.full_serial.value).toContain('vitest');

    // proposal_complete is true only with at least targeted_template AND full.
    expect(r.proposal.proposal_complete).toBe(true);
    expect(Array.isArray(r.proposal.undetected)).toBe(true);
    expect(r.proposal.undetected).not.toContain('full');
    expect(r.proposal.undetected).not.toContain('targeted_template');

    // Propose performs NO writes.
    expect(existsSync(join(dir, '.ape'))).toBe(false);
    expect(existsSync(configFile(dir))).toBe(false);
  });

  it('bare node --test project: proposes a full command grounded in the detected test script', async () => {
    const dir = nodeTestProject();
    const r = initResult(await configAction(dir, 'init', {}));
    expect(r.applied).toBe(false);

    const tc = r.proposal.test_commands;
    expect(tc.full).toBeDefined();
    expect(typeof tc.full.value).toBe('string');
    expect(tc.full.value.length).toBeGreaterThan(0);
    expect(tc.full.rationale).toMatch(/script/i);

    // targeted_template is not required here; IF present it must be path-scoped.
    if (tc.targeted_template) {
      expect(tc.targeted_template.value).toContain('{paths}');
    }
    expect(existsSync(join(dir, '.ape'))).toBe(false);
  });

  it('empty project: proposes nothing, stays incomplete, and refuses apply without writing', async () => {
    const dir = emptyProject();
    const r = initResult(await configAction(dir, 'init', {}));
    expect(r.applied).toBe(false);
    expect(Object.keys(r.proposal.test_commands)).toHaveLength(0);
    expect(r.proposal.undetected.length).toBeGreaterThan(0);
    expect(r.proposal.proposal_complete).toBe(false);
    expect(existsSync(join(dir, '.ape'))).toBe(false);

    // apply on an empty proposal fails loudly and creates no config.
    await expect(configAction(dir, 'init', { apply: true })).rejects.toThrow();
    expect(existsSync(configFile(dir))).toBe(false);
  });

  // ---- APPLY (configAction(dir, 'init', { apply: true, values? })) ------

  it('apply persists the proposal, reflects it through get, and records explicit_keys provenance', async () => {
    const dir = vitestProject();
    await configAction(dir, 'init', { apply: true });

    const { config } = await configAction(dir, 'get', {});
    expect(config.test_commands.full).toContain('vitest');
    expect(config.test_commands.targeted_template).toContain('{paths}');
    expect(typeof config.test_commands.full_serial).toBe('string');

    // The stored sparse config records the applied slots as explicit overrides.
    const raw = stored(dir);
    expect(Array.isArray(raw.explicit_keys)).toBe(true);
    expect(raw.explicit_keys).toContain('test_commands.full');
    expect(raw.explicit_keys).toContain('test_commands.targeted_template');
  });

  it('apply lets an operator-edited value win over the proposal and round-trip through get', async () => {
    const dir = vitestProject();
    await configAction(dir, 'init', { apply: true, values: { full: 'npm test' } });

    const { config } = await configAction(dir, 'get', {});
    expect(config.test_commands.full).toBe('npm test'); // operator value wins
    // The vitest-grounded template is still applied alongside the edited full.
    expect(config.test_commands.targeted_template).toContain('{paths}');

    const raw = stored(dir);
    expect(raw.explicit_keys).toContain('test_commands.full');
  });

  it('apply rejects a values key outside the five test_commands slots and persists nothing', async () => {
    const dir = vitestProject();
    await expect(configAction(dir, 'init', { apply: true, values: { bogus: 'x' } }))
      .rejects.toThrow();
    expect(existsSync(configFile(dir))).toBe(false);
  });

  // ---- DOCTOR (advisory gate-commands check) ----------------------------

  it('doctor surfaces an advisory gate-commands check on an unconfigured project without failing health', async () => {
    const dir = gitProject();
    const report = await doctor(dir, {});
    const gateCheck = report.checks.find((entry) => /gate|test-commands/.test(entry.name));
    expect(gateCheck).toBeDefined();
    expect(gateCheck.passed).not.toBe(false); // informational, never a hard fail
    expect(gateCheck.informational === true || gateCheck.warning === true).toBe(true);
    expect(gateCheck.detail).toMatch(/init/i); // points at ape_config init
    expect(report.healthy).toBe(true); // advisory never flips health
  });

  it('doctor reports the gate-commands check passing after a successful init apply', async () => {
    const dir = gitProject();
    writeFileSync(join(dir, 'package.json'), vitestPackageJson());
    await configAction(dir, 'init', { apply: true });
    const report = await doctor(dir, {});
    const gateCheck = report.checks.find((entry) => /gate|test-commands/.test(entry.name));
    expect(gateCheck).toBeDefined();
    expect(gateCheck.passed).toBe(true);
  });

  // ---- MCP TOOL SCHEMA (acceptance signal for the tool-schema change) ----

  it('ape_config MCP tool advertises the init action and the apply/values inputs', async () => {
    const responses = await mcpSession([
      { jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} },
    ]);
    const configTool = responses[0].result.tools.find((tool) => tool.name === 'ape_config');
    expect(configTool.inputSchema.properties.action.enum).toContain('init');
    expect(configTool.inputSchema.properties.apply).toBeDefined();
    expect(configTool.inputSchema.properties.values).toBeDefined();
  });
});
