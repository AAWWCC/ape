import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, it, expect, afterEach } from 'vitest';
import {
  extractObjectivePaths,
  isTestPath,
  inferMatchingTestPaths,
} from '../lib/runtime/scope.js';

describe('APE Smart Scope Discovery & Directive Parser', () => {
  const tempDirs = [];

  function createTempProject() {
    const dir = mkdtempSync(path.join(tmpdir(), 'ape-scope-test-'));
    tempDirs.push(dir);
    return dir;
  }

  afterEach(() => {
    while (tempDirs.length > 0) {
      try {
        rmSync(tempDirs.pop(), { recursive: true, force: true });
      } catch {}
    }
  });

  it('correctly classifies test paths and production paths', () => {
    expect(isTestPath('tests/test_auth.py')).toBe(true);
    expect(isTestPath('__tests__/auth.test.ts')).toBe(true);
    expect(isTestPath('pkg/store_test.go')).toBe(true);
    expect(isTestPath('src/components/button.spec.tsx')).toBe(true);
    expect(isTestPath('src/auth.ts')).toBe(false);
    expect(isTestPath('backend/memory.py')).toBe(false);
  });

  it('resolves bare filenames to real repository paths and infers matching test paths', () => {
    const projectDir = createTempProject();
    mkdirSync(path.join(projectDir, 'src', 'auth'), { recursive: true });
    mkdirSync(path.join(projectDir, '__tests__'), { recursive: true });

    writeFileSync(path.join(projectDir, 'src', 'auth', 'session.ts'), 'export const session = {};', 'utf8');
    writeFileSync(path.join(projectDir, '__tests__', 'session.test.ts'), 'test("session", () => {});', 'utf8');

    const result = extractObjectivePaths(projectDir, 'Fix the expiration bug in session.ts and prevent leaks');
    expect(result.production_scope).toContain('src/auth/session.ts');
    expect(result.test_scope).toContain('__tests__/session.test.ts');
  });

  it('extracts explicit relative paths mentioned in the directive', () => {
    const projectDir = createTempProject();
    mkdirSync(path.join(projectDir, 'backend'), { recursive: true });
    mkdirSync(path.join(projectDir, 'tests'), { recursive: true });

    writeFileSync(path.join(projectDir, 'backend', 'memory.py'), 'def get_mem(): pass', 'utf8');
    writeFileSync(path.join(projectDir, 'tests', 'test_memory.py'), 'def test_mem(): pass', 'utf8');

    const result = extractObjectivePaths(projectDir, 'Audit backend/memory.py to eliminate swallowed exceptions with tests/test_memory.py');
    expect(result.production_scope).toEqual(['backend/memory.py']);
    expect(result.test_scope).toEqual(['tests/test_memory.py']);
  });

  it('synthesizes canonical candidate test path when no test file exists yet', () => {
    const projectDir = createTempProject();
    mkdirSync(path.join(projectDir, 'lib'), { recursive: true });
    writeFileSync(path.join(projectDir, 'lib', 'validator.js'), 'export function val() {}', 'utf8');

    const result = extractObjectivePaths(projectDir, 'Add boundary validation in validator.js');
    expect(result.production_scope).toContain('lib/validator.js');
    expect(result.test_scope).toContain('__tests__/validator.test.js');
  });

  it('excludes hidden and internal engine directories like .git and .ape', () => {
    const projectDir = createTempProject();
    mkdirSync(path.join(projectDir, '.ape', 'internal'), { recursive: true });
    writeFileSync(path.join(projectDir, '.ape', 'internal', 'state.json'), '{}', 'utf8');

    const result = extractObjectivePaths(projectDir, 'Inspect state.json');
    expect(result.production_scope).not.toContain('.ape/internal/state.json');
  });
});
