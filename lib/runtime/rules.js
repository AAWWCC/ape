import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

export const DEFAULT_RULES = Object.freeze([
  {
    id: 'no-manual-retry',
    title: 'No Manual Retry Loops',
    description:
      'Never manually implement retry or backoff loops with while-loops and sleeps (e.g. time.sleep, setTimeout, or busy loops). Use framework retry utilities or scheduling policies with bounded attempts.',
    severity: 'error',
    source_file: 'built-in',
  },
  {
    id: 'no-swallowed-exceptions',
    title: 'No Swallowed Exceptions',
    description:
      'Never catch exceptions with an empty pass, empty catch block, or blank error discard. Always log, reraise, or explicitly recover from unexpected errors.',
    severity: 'error',
    source_file: 'built-in',
  },
  {
    id: 'no-redundant-wrappers',
    title: 'No Redundant Wrapper Functions',
    description:
      'Do not introduce thin wrapper helper functions whose body merely forwards arguments to an underlying library call without adding real logic or transforming inputs.',
    severity: 'warn',
    source_file: 'built-in',
  },
  {
    id: 'direct-property-access',
    title: 'Direct Property Access Over Destructuring',
    description:
      'For simple callbacks or transforms that select properties, prefer direct access (e.g. v => v.id or item.name) over unnecessary parameter destructuring.',
    severity: 'warn',
    source_file: 'built-in',
  },
]);

export const RULE_TEMPLATES = Object.freeze({
  default: DEFAULT_RULES,
  'typescript-effect': Object.freeze([
    {
      id: 'no-manual-retry',
      title: 'No Manual Retry Loops',
      description:
        'Never use setTimeout or manual loops for retry or backoff. Use Effect.retry or Schedule policies with bounded limits.',
      severity: 'error',
      source_file: 'template:typescript-effect',
    },
    {
      id: 'no-redundant-wrappers',
      title: 'No Redundant Wrapper Functions',
      description:
        'Do not create single-line wrapper functions that merely pass arguments through to Effect or library methods without transforming inputs.',
      severity: 'warn',
      source_file: 'template:typescript-effect',
    },
    {
      id: 'prefer-pattern-matching',
      title: 'Prefer Pattern Matching',
      description:
        'Prefer Match.value or structural pattern matching over deeply nested if-else ladders and type assertion switches.',
      severity: 'warn',
      source_file: 'template:typescript-effect',
    },
    {
      id: 'no-swallowed-exceptions',
      title: 'No Swallowed Exceptions',
      description:
        'Never catch errors with empty catch blocks or discard Effect failures without explicit recovery or defect logging.',
      severity: 'error',
      source_file: 'template:typescript-effect',
    },
    {
      id: 'no-unsafe-type-casts',
      title: 'No Unsafe Type Casts',
      description:
        "Avoid unchecked 'as any' or unsafe type casts. Model domain types or use Schema validation instead.",
      severity: 'warn',
      source_file: 'template:typescript-effect',
    },
  ]),
  'python-async': Object.freeze([
    {
      id: 'no-blocking-in-async',
      title: 'No Blocking Calls in Async Code',
      description:
        'Never call blocking synchronous functions (such as time.sleep, requests.get, or heavy file I/O) inside async functions. Use asyncio.sleep, httpx, or run_in_executor.',
      severity: 'error',
      source_file: 'template:python-async',
    },
    {
      id: 'no-manual-retry',
      title: 'No Manual Retry Loops',
      description:
        'Never write manual while-loops with time.sleep or asyncio.sleep for retrying network operations. Use tenacity or structured retry decorators with bounded limits.',
      severity: 'error',
      source_file: 'template:python-async',
    },
    {
      id: 'no-swallowed-exceptions',
      title: 'No Swallowed Exceptions',
      description:
        'Never use bare except: or except Exception: pass without logging, reraising, or explicit recovery.',
      severity: 'error',
      source_file: 'template:python-async',
    },
    {
      id: 'explicit-exception-causes',
      title: 'Explicit Exception Causes',
      description:
        "When raising a new exception from an except block, always use 'raise ... from exc' to preserve the exception cause trace.",
      severity: 'warn',
      source_file: 'template:python-async',
    },
    {
      id: 'no-redundant-wrappers',
      title: 'No Redundant Wrapper Functions',
      description:
        'Avoid creating passthrough wrapper functions that add no logic beyond calling another function with identical parameters.',
      severity: 'warn',
      source_file: 'template:python-async',
    },
  ]),
  'go-idioms': Object.freeze([
    {
      id: 'explicit-error-wrapping',
      title: 'Explicit Error Wrapping',
      description:
        'When propagating errors, always wrap them with context using fmt.Errorf("...: %w", err) rather than discarding or returning bare errors.',
      severity: 'warn',
      source_file: 'template:go-idioms',
    },
    {
      id: 'no-naked-goroutines',
      title: 'No Unmanaged Goroutines',
      description:
        "Do not spawn unmanaged goroutines ('go func()') without lifecycle management via context.Context or sync.WaitGroup.",
      severity: 'error',
      source_file: 'template:go-idioms',
    },
    {
      id: 'no-manual-retry',
      title: 'No Manual Retry Loops',
      description:
        'Do not write busy-wait retry loops with time.Sleep. Use exponential backoff libraries or ticker/select with context cancellation.',
      severity: 'error',
      source_file: 'template:go-idioms',
    },
    {
      id: 'no-swallowed-errors',
      title: 'No Swallowed Errors',
      description:
        "Never discard error return values with blank identifier '_ = fn()' or empty 'if err != nil' blocks without logging or cleanup.",
      severity: 'error',
      source_file: 'template:go-idioms',
    },
  ]),
});

export function parseMarkdownRule(filePath, content = null) {
  const text = (content !== null ? content : readFileSync(filePath, 'utf8')).trim();
  const ruleId = path.basename(filePath, path.extname(filePath));
  let title = ruleId.replace(/[-_]/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
  let severity = 'error';
  const descLines = [];

  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed.startsWith('# ')) {
      title = trimmed.slice(2).trim();
    } else if (trimmed.toLowerCase().startsWith('severity:')) {
      const parsedSeverity = trimmed.split(':', 2)[1]?.trim().toLowerCase();
      if (parsedSeverity === 'warn' || parsedSeverity === 'warning') {
        severity = 'warn';
      } else if (parsedSeverity === 'error' || parsedSeverity === 'block') {
        severity = 'error';
      }
    } else if (trimmed.length > 0) {
      descLines.push(trimmed);
    }
  }

  const description = descLines.length > 0 ? descLines.join(' ') : text;
  return {
    id: ruleId,
    title,
    description,
    severity,
    source_file: filePath,
  };
}

export function loadProjectRules(projectRoot) {
  if (!projectRoot || typeof projectRoot !== 'string') {
    return Array.from(DEFAULT_RULES);
  }

  const searchDirs = [
    path.join(projectRoot, '.ape', 'rules'),
    path.join(projectRoot, '.rules'),
    path.join(projectRoot, 'rules'),
  ];

  const discoveredRules = [];
  const seenIds = new Set();

  for (const dir of searchDirs) {
    try {
      const stat = statSync(dir);
      if (!stat.isDirectory()) continue;
      const entries = readdirSync(dir).sort();
      for (const entry of entries) {
        if (!entry.endsWith('.md')) continue;
        const filePath = path.join(dir, entry);
        try {
          const rule = parseMarkdownRule(filePath);
          if (!seenIds.has(rule.id)) {
            discoveredRules.push(rule);
            seenIds.add(rule.id);
          }
        } catch {
          // Ignore unreadable or corrupt rule files
        }
      }
    } catch {
      // Directory absent
    }
  }

  return discoveredRules.length > 0 ? discoveredRules : Array.from(DEFAULT_RULES);
}

export function formatRulesForPrompt(rules) {
  if (!Array.isArray(rules) || rules.length === 0) return '';
  const lines = [
    '### Active Engineering Rules (Anti-Slop Guardrails)',
    'These rules enforce codebase idioms and prohibit AI code slop. Violations marked with severity `error` block receipt acceptance.',
    '',
  ];
  for (const rule of rules) {
    const badge = rule.severity === 'error' ? '🚫 ERROR' : '⚠️ WARN';
    lines.push(`- **${rule.title}** (\`${rule.id}\` — ${badge}): ${rule.description}`);
  }
  return lines.join('\n');
}

/**
 * Deterministic AST / Regex Desloppifier.
 * Inspects added lines in unified diffs for common AI slop anti-patterns.
 */
export function auditDiffAstAndPatterns(diffText, rules = DEFAULT_RULES) {
  if (!diffText || typeof diffText !== 'string' || !diffText.trim()) {
    return { passed: true, violations: [] };
  }

  const violations = [];
  const activeRuleMap = new Map((rules ?? DEFAULT_RULES).map((r) => [r.id, r]));

  // Extract added lines from diff (+ lines, excluding header +++ lines)
  const lines = diffText.split(/\r?\n/);
  const addedLinesWithIndex = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.startsWith('+') && !line.startsWith('+++')) {
      addedLinesWithIndex.push({ text: line.slice(1), lineNum: i + 1 });
    }
  }

  const addedBody = addedLinesWithIndex.map((item) => item.text).join('\n');

  // 1. Check for swallowed exceptions (Python except: pass or JS/TS empty catch)
  if (activeRuleMap.has('no-swallowed-exceptions') || activeRuleMap.has('no-swallowed-errors')) {
    const rule = activeRuleMap.get('no-swallowed-exceptions') || activeRuleMap.get('no-swallowed-errors');
    // Python empty except blocks: except ...: \n pass
    const pythonSwallowedRegex = /except(\s+\w+)?:\s*(\n\s*)?(pass|\.\.\.)/g;
    // JS/TS empty catch blocks: catch (...) {} or catch {}
    const jsSwallowedRegex = /catch\s*(\([^)]*\))?\s*\{\s*\}/g;
    // Go discarded error return: _ = err or _ = fnWithError()
    const goSwallowedRegex = /if\s+err\s*!=\s*nil\s*\{\s*\}/g;

    if (pythonSwallowedRegex.test(addedBody)) {
      violations.push({
        rule_id: rule.id,
        rule_title: rule.title,
        severity: rule.severity,
        explanation: 'Swallowed Python exception: caught error with empty `pass` or `...` block without logging or recovery.',
      });
    } else if (jsSwallowedRegex.test(addedBody)) {
      violations.push({
        rule_id: rule.id,
        rule_title: rule.title,
        severity: rule.severity,
        explanation: 'Swallowed JavaScript/TypeScript error: empty `catch {}` block without logging, reraising, or defect handling.',
      });
    } else if (goSwallowedRegex.test(addedBody)) {
      violations.push({
        rule_id: rule.id,
        rule_title: rule.title,
        severity: rule.severity,
        explanation: 'Swallowed Go error: empty `if err != nil {}` block without error handling.',
      });
    }
  }

  // 2. Check for manual retry loops with sleeps
  if (activeRuleMap.has('no-manual-retry')) {
    const rule = activeRuleMap.get('no-manual-retry');
    const whileWithSleepRegex = /while\s*\(?.*(attempt|retry|count|true|1).*\)?\s*[\s\S]*?(time\.sleep|asyncio\.sleep|setTimeout|time\.Sleep)/i;
    if (whileWithSleepRegex.test(addedBody)) {
      violations.push({
        rule_id: rule.id,
        rule_title: rule.title,
        severity: rule.severity,
        explanation: 'Manual retry loop detected: while loop using sleep/setTimeout instead of structured framework retry utilities.',
      });
    }
  }

  const hasBlockingViolation = violations.some((v) => v.severity === 'error');
  return {
    passed: !hasBlockingViolation,
    violations,
  };
}
