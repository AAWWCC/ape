import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const corpusPath = path.join(root, 'evals', 'operational-replay-corpus.json');
const requiredCases = [
  'codex-dispatch-envelope',
  'plan-directed-replan',
  'test-contradiction-verification',
  'stable-review-finding-identity',
  'actionable-scope-denial',
  'protected-branch-shipping',
  'nonbehavioral-test-stage-omission',
  'versioned-terminal-diagnostics',
  'omitted-preflight-audit-reason',
  'native-bootstrap-phase-and-catalog-contract',
  'native-probe-failure-reporting',
  'native-canary-identity-isolation',
  'compiled-future-stage-contract',
  'reviewed-admission-drift',
  'scheduled-base-command-prerequisites',
  'admissible-receipt-rejection-guidance',
  'frozen-shipping-and-tested-tree',
  'current-command-prerequisites',
  'branch-exact-scheduler-review-checks',
  'supersession-prelock-admission',
  'codex-model-input-response-framing',
  'post-build-test-correction',
  'override-abort-terminal-reason',
];

describe('operational replay corpus', () => {
  it('binds each declared synthetic failure family to an executable regression test', async () => {
    const corpus = JSON.parse(await readFile(corpusPath, 'utf8'));
    expect([1, 2]).toContain(corpus.schema_version);
    expect(corpus.cases.map((entry) => entry.id)).toEqual(requiredCases);

    const seen = new Set();
    for (const entry of corpus.cases) {
      expect(entry).toMatchObject({
        id: expect.any(String),
        category: expect.any(String),
        observed_failure: expect.any(String),
        recovery_contract: expect.any(String),
        test_file: expect.stringMatching(/^__tests__\/runtime-v2-[a-z0-9-]+\.test\.js$/),
        test_names: expect.any(Array),
      });
      expect(seen.has(entry.id)).toBe(false);
      seen.add(entry.id);

      expect(entry.test_names.length, `${entry.id} must enumerate exact executed leaf identities`).toBeGreaterThan(0);
      expect(new Set(entry.test_names).size).toBe(entry.test_names.length);
      for (const name of entry.test_names) {
        expect(typeof name).toBe('string');
        expect(name.trim()).toBe(name);
        expect(name.length).toBeGreaterThan(0);
      }
    }
  });

  it('retains every promised native probe diagnostic descendant', async () => {
    const corpus = JSON.parse(await readFile(corpusPath, 'utf8'));
    const entry = corpus.cases.find(({ id }) => id === 'native-probe-failure-reporting');
    const leaves = [
      'reads legacy failure status without publishing quarantine during read-only session guidance',
      'records an early hook failure without claiming authority even if native evidence has recovered',
      'ignores diagnostic writes without an exact launched probe token or fixed typed code',
      'reports the elapsed launch deadline as failed without expiring or replacing its live reservation',
      'distinguishes completed proof expiry from expiry before acknowledgement without changing proof',
      'retains a bounded exact-token production rejection in probe status',
      'distinguishes missing and conflicting native candidate evidence after the exact current token is presented',
      'does not erase successful binding and acknowledgement proof when unrelated candidate evidence is malformed',
      'does not assign an unbound malformed or zero-tool candidate to the newest probe without its token',
      'does not write stale A diagnostic failure into replacement B',
    ];
    expect(entry.test_file).toBe('__tests__/runtime-v2-probe-diagnostics.test.js');
    expect(entry.test_names).toEqual(leaves.map((leaf) => `offline native probe failure reporting ${leaf}`));
  });

  it('retains each expanded command prerequisite scenario, not just its suite label', async () => {
    const corpus = JSON.parse(await readFile(corpusPath, 'utf8'));
    const entry = corpus.cases.find(({ id }) => id === 'current-command-prerequisites');
    const suite = 'current command prerequisites before dispatch';
    const missing = [
      'missing interpreter entry', 'missing Node syntax-check entry', 'missing Node long syntax-check entry',
      'missing package script', 'missing package script entry', 'missing shebang interpreter',
      'missing env shebang interpreter', 'missing env-wrapped interpreter entry',
      'missing preload before inline evaluation', 'missing preload after inline evaluation',
      'missing import before inline print',
    ];
    const interpreterOptions = [
      'bash -lc "exit 1"', 'bash -o pipefail -c "exit 1"',
      'node --input-type module -e "process.exit(1)"', 'node --stack-trace-limit 100 -e "process.exit(1)"',
    ];
    const informational = [
      'node --help missing.js', 'node --version --require ./missing.js', 'node --require ./missing.js --help',
      'npm run missing --help', 'npm --version run missing', 'npm run check -- --prefix ../outside',
    ];
    const ordinary = [
      'charges shared executable content once across many distinct admitted aliases',
      'admits a present script that would fail and mutate a marker, without executing it',
      'admits available package scripts and npm start default while inspecting no imports',
      'accepts literal shell environment prefixes and failing builtins without executing them',
      'identifies the exact selected package script for missing executables and cycles',
      'admits a present env shebang interpreter without executing the failing script',
      'admits a present literal env-wrapped entry in real preview without executing it',
      'honors literal env PATH and refuses ambiguous environment resets or flags',
      'keeps intentionally absent future node test paths separate from explicit preloads',
      'accepts an available preload without treating inline code as a filename or running it',
      'retains required script and preload checks after interpreter option values',
      'retains real entry and package prerequisites when help is a script argument',
      'allows an internal script symlink but rejects an escaping script link',
      'bounds malformed, special, and oversized package manifests without leaking their bytes',
    ];
    expect(entry.test_file).toBe('__tests__/runtime-v2-admission-command-prerequisites.test.js');
    expect(entry.test_names).toEqual(expect.arrayContaining([
      ...ordinary.map((leaf) => `${suite} ${leaf}`),
      ...missing.map((label) => `${suite} blocks ${label} on HEAD=base before creating a branch or worker`),
      ...interpreterOptions.map((command) => `${suite} does not invent an entry file from interpreter options in ${command}`),
      ...informational.map((command) => `${suite} does not invent execution prerequisites for informational or forwarded arguments in ${command}`),
    ]));
    expect(entry.test_names).not.toContain(suite);
  });
});
