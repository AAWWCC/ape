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
];

describe('operational replay corpus', () => {
  it('binds each declared synthetic failure family to an executable regression test', async () => {
    const corpus = JSON.parse(await readFile(corpusPath, 'utf8'));
    expect(corpus.schema_version).toBe(1);
    expect(corpus.cases.map((entry) => entry.id)).toEqual(requiredCases);

    const seen = new Set();
    for (const entry of corpus.cases) {
      expect(entry).toMatchObject({
        id: expect.any(String),
        category: expect.any(String),
        observed_failure: expect.any(String),
        recovery_contract: expect.any(String),
        test_file: expect.stringMatching(/^__tests__\/runtime-v2-[a-z0-9-]+\.test\.js$/),
        test_anchor: expect.any(String),
      });
      expect(seen.has(entry.id)).toBe(false);
      seen.add(entry.id);

      const source = await readFile(path.join(root, entry.test_file), 'utf8');
      const executableAnchor = ['it', 'test', 'describe'].some((declaration) =>
        source.includes(`${declaration}('${entry.test_anchor}`)
        || source.includes(`${declaration}(\"${entry.test_anchor}`));
      expect(executableAnchor, `${entry.id} must retain its declared executable test anchor`)
        .toBe(true);
    }
  });
});
