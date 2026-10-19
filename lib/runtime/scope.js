import { existsSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';

const VALID_CODE_EXTENSIONS = new Set([
  '.py', '.ts', '.js', '.jsx', '.tsx', '.zig', '.rs', '.go', '.c', '.h', '.cpp', '.json', '.toml', '.md',
]);

const EXCLUDED_DIRS = new Set([
  '.git', 'node_modules', '.ape', '.venv', 'dist', 'build', '.cache',
]);

function findFilesByName(dir, targetName, rootDir = dir, depth = 0) {
  if (depth > 6) return [];
  const results = [];
  try {
    const entries = readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (!EXCLUDED_DIRS.has(entry.name) && !entry.name.startsWith('.')) {
          results.push(...findFilesByName(path.join(dir, entry.name), targetName, rootDir, depth + 1));
        }
      } else if (entry.isFile() && entry.name === targetName) {
        results.push(path.relative(rootDir, path.join(dir, entry.name)));
      }
    }
  } catch {
    // Ignore unreadable directories
  }
  return results;
}

export function isTestPath(filePath) {
  const normalized = filePath.replace(/\\/g, '/');
  return (
    normalized.startsWith('tests/') ||
    normalized.startsWith('test/') ||
    normalized.startsWith('__tests__/') ||
    normalized.includes('/__tests__/') ||
    normalized.includes('/tests/') ||
    normalized.includes('/test/') ||
    normalized.startsWith('test_') ||
    normalized.includes('/test_') ||
    normalized.endsWith('_test.py') ||
    normalized.endsWith('_test.go') ||
    /\.(test|spec)\.[a-zA-Z0-9]+$/.test(normalized)
  );
}

export function inferMatchingTestPaths(projectDir, productionFiles) {
  const tests = [];
  for (const prodFile of productionFiles) {
    const ext = path.extname(prodFile);
    const stem = path.basename(prodFile, ext);
    const relDir = path.dirname(prodFile);

    const candidates = [];
    if (ext === '.py') {
      candidates.push(
        path.join('tests', `test_${stem}.py`),
        path.join('tests', relDir, `test_${stem}.py`),
        path.join(relDir, `test_${stem}.py`)
      );
    } else if (['.ts', '.tsx', '.js', '.jsx'].includes(ext)) {
      candidates.push(
        path.join('__tests__', `${stem}.test${ext}`),
        path.join('tests', `${stem}.test${ext}`),
        path.join('test', `${stem}.test${ext}`),
        path.join(relDir, '__tests__', `${stem}.test${ext}`),
        path.join(relDir, `${stem}.test${ext}`),
        path.join(relDir, `${stem}.spec${ext}`)
      );
    } else if (ext === '.go') {
      candidates.push(path.join(relDir, `${stem}_test.go`));
    }

    let found = false;
    for (const cand of candidates) {
      if (existsSync(path.join(projectDir, cand))) {
        tests.push(cand.replace(/\\/g, '/'));
        found = true;
        break;
      }
    }

    if (!found && candidates.length > 0) {
      // Use the canonical default candidate
      tests.push(candidates[0].replace(/\\/g, '/'));
    }
  }

  return [...new Set(tests)];
}

export function extractObjectivePaths(projectDir, objective) {
  if (!objective || typeof objective !== 'string' || !objective.trim()) {
    return { production_scope: [], test_scope: [] };
  }

  const words = objective.match(/[a-zA-Z0-9_\-./]+/g) || [];
  const detected = [];

  for (const word of words) {
    const clean = word.replace(/^[.,;:"'`()\[\]{}]+|[.,;:"'`()\[\]{}]+$/g, '');
    if (!clean || clean.startsWith('/') || clean.startsWith('.')) continue;

    const fullPath = path.join(projectDir, clean);
    const ext = path.extname(clean);

    if (existsSync(fullPath)) {
      try {
        if (statSync(fullPath).isFile()) {
          detected.push(clean.replace(/\\/g, '/'));
          continue;
        }
      } catch {}
    }

    // Bare filename or prospective path with valid extension
    if (VALID_CODE_EXTENSIONS.has(ext)) {
      if (clean.includes('/')) {
        detected.push(clean.replace(/\\/g, '/'));
      } else {
        const matches = findFilesByName(projectDir, clean);
        if (matches.length > 0) {
          detected.push(matches[0].replace(/\\/g, '/'));
        } else {
          detected.push(clean.replace(/\\/g, '/'));
        }
      }
    }
  }

  const unique = [...new Set(detected)];
  const testPaths = unique.filter((p) => isTestPath(p));
  const prodScope = unique.filter((p) => !isTestPath(p));

  // If production files were found but no tests, infer matching test paths
  if (prodScope.length > 0 && testPaths.length === 0) {
    const inferred = inferMatchingTestPaths(projectDir, prodScope);
    testPaths.push(...inferred);
  }

  return {
    production_scope: prodScope,
    test_scope: testPaths,
  };
}
