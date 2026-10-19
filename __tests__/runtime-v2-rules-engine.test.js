import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, it, expect, afterEach } from 'vitest';
import {
  DEFAULT_RULES,
  RULE_TEMPLATES,
  loadProjectRules,
  parseMarkdownRule,
  formatRulesForPrompt,
  auditDiffAstAndPatterns,
} from '../lib/runtime/rules.js';

describe('APE Engineering Rules Engine & Desloppifier', () => {
  const tempDirs = [];

  function createTempProject() {
    const dir = mkdtempSync(path.join(tmpdir(), 'ape-rules-test-'));
    tempDirs.push(dir);
    return dir;
  }

  afterEach(() => {
    while (tempDirs.length > 0) {
      try {
        rmSync(tempDirs.pop(), { recursive: true, force: true });
      } catch {
        // Cleanup best effort
      }
    }
  });

  it('exports built-in default anti-slop rules with expected IDs and error severities', () => {
    expect(DEFAULT_RULES.length).toBeGreaterThanOrEqual(4);
    const ruleIds = DEFAULT_RULES.map((r) => r.id);
    expect(ruleIds).toContain('no-manual-retry');
    expect(ruleIds).toContain('no-swallowed-exceptions');
    expect(ruleIds).toContain('no-redundant-wrappers');
    expect(ruleIds).toContain('direct-property-access');

    const errorRules = DEFAULT_RULES.filter((r) => r.severity === 'error');
    expect(errorRules.map((r) => r.id)).toContain('no-swallowed-exceptions');
    expect(errorRules.map((r) => r.id)).toContain('no-manual-retry');
  });

  it('provides specialized template packs for typescript-effect, python-async, and go-idioms', () => {
    expect(RULE_TEMPLATES['typescript-effect']).toBeDefined();
    expect(RULE_TEMPLATES['python-async']).toBeDefined();
    expect(RULE_TEMPLATES['go-idioms']).toBeDefined();

    const effectRules = RULE_TEMPLATES['typescript-effect'].map((r) => r.id);
    expect(effectRules).toContain('prefer-pattern-matching');
    expect(effectRules).toContain('no-unsafe-type-casts');

    const pyAsyncRules = RULE_TEMPLATES['python-async'].map((r) => r.id);
    expect(pyAsyncRules).toContain('no-blocking-in-async');
    expect(pyAsyncRules).toContain('explicit-exception-causes');
  });

  it('discovers custom rules in .ape/rules/*.md', () => {
    const projectDir = createTempProject();
    const rulesDir = path.join(projectDir, '.ape', 'rules');
    mkdirSync(rulesDir, { recursive: true });

    writeFileSync(
      path.join(rulesDir, 'prefer-effect-map.md'),
      '# Prefer Effect.map Over Array.map\nseverity: error\nAlways use Effect.map(items, fn) instead of standard JS items.map(fn) inside Effect workflows.\n',
      'utf8'
    );

    const rules = loadProjectRules(projectDir);
    expect(rules).toHaveLength(1);
    expect(rules[0].id).toBe('prefer-effect-map');
    expect(rules[0].title).toBe('Prefer Effect.map Over Array.map');
    expect(rules[0].severity).toBe('error');
    expect(rules[0].description).toContain('Always use Effect.map');
  });

  it('falls back to DEFAULT_RULES when project has no custom rules defined', () => {
    const projectDir = createTempProject();
    const rules = loadProjectRules(projectDir);
    expect(rules).toEqual(DEFAULT_RULES);
  });

  it('formats active rules cleanly for injection into model prompts', () => {
    const markdown = formatRulesForPrompt(DEFAULT_RULES);
    expect(markdown).toContain('### Active Engineering Rules (Anti-Slop Guardrails)');
    expect(markdown).toContain('No Manual Retry Loops');
    expect(markdown).toContain('No Swallowed Exceptions');
    expect(markdown).toContain('🚫 ERROR');
    expect(markdown).toContain('⚠️ WARN');
  });

  describe('auditDiffAstAndPatterns (Deterministic Desloppifier)', () => {
    it('passes clean, idiomatic diffs without false positives', () => {
      const cleanDiff = `
diff --git a/src/math.js b/src/math.js
--- a/src/math.js
+++ b/src/math.js
@@ -1,3 +1,3 @@
 function add(a, b) {
-  return a - b;
+  return a + b;
 }
`;
      const result = auditDiffAstAndPatterns(cleanDiff, DEFAULT_RULES);
      expect(result.passed).toBe(true);
      expect(result.violations).toHaveLength(0);
    });

    it('flags swallowed Python exceptions (except: pass)', () => {
      const sloppyPythonDiff = `
diff --git a/backend/worker.py b/backend/worker.py
--- a/backend/worker.py
+++ b/backend/worker.py
@@ -10,3 +10,6 @@
 def process_queue():
+    try:
+        sync_database()
+    except Exception:
+        pass
`;
      const result = auditDiffAstAndPatterns(sloppyPythonDiff, DEFAULT_RULES);
      expect(result.passed).toBe(false);
      expect(result.violations.some((v) => v.rule_id === 'no-swallowed-exceptions')).toBe(true);
      expect(result.violations[0].severity).toBe('error');
    });

    it('flags swallowed JavaScript empty catch blocks', () => {
      const sloppyJsDiff = `
diff --git a/src/client.ts b/src/client.ts
--- a/src/client.ts
+++ b/src/client.ts
@@ -20,3 +20,7 @@
 async function fetchUser(id: string) {
+  try {
+    return await api.getUser(id);
+  } catch (err) {}
 }
`;
      const result = auditDiffAstAndPatterns(sloppyJsDiff, DEFAULT_RULES);
      expect(result.passed).toBe(false);
      expect(result.violations.some((v) => v.rule_id === 'no-swallowed-exceptions')).toBe(true);
    });

    it('flags manual retry while-loops with sleep', () => {
      const retryDiff = `
diff --git a/network.py b/network.py
--- a/network.py
+++ b/network.py
@@ -5,3 +5,10 @@
 def fetch_with_retry(url):
+    attempts = 0
+    while attempts < 3:
+        try:
+            return http.get(url)
+        except Exception as e:
+            attempts += 1
+            time.sleep(1)
`;
      const result = auditDiffAstAndPatterns(retryDiff, DEFAULT_RULES);
      expect(result.passed).toBe(false);
      expect(result.violations.some((v) => v.rule_id === 'no-manual-retry')).toBe(true);
    });
  });
});
