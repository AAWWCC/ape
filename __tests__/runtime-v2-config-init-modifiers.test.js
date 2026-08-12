import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { configAction } from '../lib/runtime/service.js';

// onboarding-modifier-proposals: `ape_config init` proposes the COMPOSABLE
// serialize/shuffle test-command MODIFIERS (the landed test-command-modifiers
// slots) for recognized runners, and — critically — closes the pytest-xdist
// serialize gap so python / python-uv gain a serial variant they never had.
//
// These drive the PUBLIC configAction('init') propose surface against temp
// fixtures. A modifier is the DRY FLAG FORM the runtime APPENDS to `full` /
// run-A (per the DEFAULT_CONFIG serialize/shuffle slot contract), never a whole
// runner invocation — so we assert grounded flag SUBSTRINGS plus modifier SHAPE
// (a leading-flag token, distinct from the full_serial whole-command escape
// hatch), never byte-exact commands. Any correct decision-table implementation
// passes; the proposals stay deterministic and write nothing.

const dirs = [];
afterEach(() => dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })));

function tempProject(prefix, files) {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(dir);
  for (const [name, content] of Object.entries(files)) {
    writeFileSync(join(dir, name), content);
  }
  return dir;
}

// init (no apply) returns the grounded proposal under `init.proposal`; unwrap to
// the test_commands map (mirrors runtime-v2-config-init.test.js's initResult).
async function proposedCommands(dir) {
  const res = await configAction(dir, 'init', {});
  expect(res.ok).toBe(true);
  const init = res.init ?? res;
  expect(init.applied).toBe(false); // propose never writes/applies
  return init.proposal.test_commands;
}

// A composable modifier carries {value, rationale} like every proposed slot AND
// is the DRY flag form: a shell-token string whose first token is a flag
// (leading '-') because it is APPENDED to the already-grounded full command,
// never a second copy of the runner invocation.
function expectModifierShape(entry) {
  expect(entry).toBeDefined();
  expect(typeof entry.value).toBe('string');
  expect(entry.value.trim().length).toBeGreaterThan(0);
  expect(typeof entry.rationale).toBe('string');
  expect(entry.rationale.length).toBeGreaterThan(0);
  expect(entry.value.trim().startsWith('-')).toBe(true);
}

function vitestProject() {
  return tempProject('ape-mod-vitest-', {
    'package.json': JSON.stringify({
      name: 'fixture-vitest',
      version: '1.0.0',
      scripts: { test: 'vitest run' },
      devDependencies: { vitest: '^2.0.0' },
    }, null, 2),
  });
}

function jestProject() {
  return tempProject('ape-mod-jest-', {
    'package.json': JSON.stringify({
      name: 'fixture-jest',
      version: '1.0.0',
      scripts: { test: 'jest' },
      devDependencies: { jest: '^29.0.0' },
    }, null, 2),
  });
}

// A genuine non-JS python repo: a pytest manifest and NO package.json, so
// detectTestRunner resolves the `python` family rather than `javascript`.
function pytestProject() {
  return tempProject('ape-mod-pytest-', {
    'pyproject.toml': '[tool.pytest.ini_options]\naddopts = ""\n',
  });
}

// A uv-managed python repo: a uv.lock and NO package.json → the `python-uv`
// family.
function uvProject() {
  return tempProject('ape-mod-uv-', {
    'uv.lock': 'version = 1\n',
  });
}

describe('ape v2 config init serialize/shuffle modifier proposals', () => {
  it('vitest: proposes serialize (--no-file-parallelism) and shuffle (--sequence.shuffle) modifiers', async () => {
    const tc = await proposedCommands(vitestProject());

    // New serialize modifier: the grounded vitest serial flag, in DRY form.
    expectModifierShape(tc.serialize);
    expect(tc.serialize.value).toContain('--no-file-parallelism');

    // New shuffle modifier: the grounded vitest order-shuffle flag.
    expectModifierShape(tc.shuffle);
    expect(tc.shuffle.value).toContain('--sequence.shuffle');

    // The modifier is APPENDED to `full`, so it is not the whole-command
    // full_serial escape hatch and never repeats the runner binary.
    expect(tc.full_serial).toBeDefined();
    expect(tc.serialize.value).not.toBe(tc.full_serial.value);
    expect(tc.serialize.value).not.toContain('vitest');

    // Additive & non-breaking: the pre-existing proposals still land.
    expect(tc.full_serial.value).toContain('vitest');
    expect(tc.targeted_template).toBeDefined();
    expect(tc.targeted_template.value).toContain('{paths}');
    expect(tc.full).toBeDefined();
    expect(tc.full.value).toContain('vitest');
  });

  it('jest: proposes a serialize modifier grounded in --runInBand', async () => {
    const tc = await proposedCommands(jestProject());

    expectModifierShape(tc.serialize);
    expect(tc.serialize.value).toContain('--runInBand');
    expect(tc.serialize.value).not.toContain('jest');

    // Additive: the whole-command full_serial proposal survives.
    expect(tc.full_serial).toBeDefined();
    expect(tc.full_serial.value).toContain('jest');
  });

  it('python (pytest): closes the xdist gap with a serialize modifier disabling randomly+xdist', async () => {
    const tc = await proposedCommands(pytestProject());

    // The critical pytest-xdist gap this entry exists to close: python
    // previously proposed NO serial variant at all. The serialize modifier
    // disables the randomly and xdist plugins so re-gate runs deterministically.
    expectModifierShape(tc.serialize);
    expect(tc.serialize.value).toContain('no:randomly');
    expect(tc.serialize.value).toContain('no:xdist');

    // Additive: the pre-existing pytest proposals survive.
    expect(tc.full).toBeDefined();
    expect(tc.full.value).toContain('pytest');
    expect(tc.targeted_template).toBeDefined();
    expect(tc.targeted_template.value).toContain('{paths}');
  });

  it('python-uv: closes the xdist gap with a serialize modifier disabling randomly+xdist', async () => {
    const tc = await proposedCommands(uvProject());

    expectModifierShape(tc.serialize);
    expect(tc.serialize.value).toContain('no:randomly');
    expect(tc.serialize.value).toContain('no:xdist');

    // Additive: the uv-grounded full proposal survives.
    expect(tc.full).toBeDefined();
    expect(tc.full.value).toContain('pytest');
  });

  it('modifier proposals are deterministic across repeated init calls', async () => {
    const dir = vitestProject();
    const first = await proposedCommands(dir);
    const second = await proposedCommands(dir);

    // Same tree → byte-identical proposal (no env / platform / timestamp / apply
    // influence), and the modifier slots are present and stable.
    expect(second).toEqual(first);
    expectModifierShape(first.serialize);
    expectModifierShape(first.shuffle);
    expect(second.serialize).toEqual(first.serialize);
    expect(second.shuffle).toEqual(first.shuffle);
  });
});
