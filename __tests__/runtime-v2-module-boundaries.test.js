import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const REPO_ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

const OWNER_MANIFEST = [
  {
    domain: 'service lifecycle orchestration',
    owner: 'lib/runtime/lifecycle-service.js',
    facade: 'lib/runtime/service.js',
    symbols: [
      'prepareNativeBindingProbe', 'nativeBindingProbeStatus', 'ackNativeBindingProbe',
      'shouldTaskWrapApeRun', 'cleanupAttributedTaskGate', 'startRun', 'nextRun',
      'executeApeRunTaskOperation', 'resumeRun', 'abortRun', 'regateRun', 'shipRun',
      'expireDispatch', 'overrideRun',
    ],
    consumes: ['lib/runtime/receipt-service.js', 'lib/runtime/status-service.js'],
  },
  {
    domain: 'receipt admission and finalization',
    owner: 'lib/runtime/receipt-service.js',
    facade: 'lib/runtime/service.js',
    symbols: ['recordReceipt', 'executeTaskOperationTransaction', 'withReceiptLock'],
  },
  {
    domain: 'service-facing status and query orchestration',
    owner: 'lib/runtime/status-service.js',
    facade: 'lib/runtime/service.js',
    symbols: ['statusRun', 'compactStatus', 'historyAction', 'configAction'],
  },
  {
    domain: 'evidence command policy',
    owner: 'lib/runtime/evidence-policy.js',
    facade: 'lib/runtime/hooks.js',
    symbols: [
      'EVIDENCE_COMMAND_FAMILIES', 'EVIDENCE_COMMAND_HEADS', 'EVIDENCE_SHELL_BUILTINS',
      'resolveEvidenceExecutable', 'snapshotEvidenceExecutables',
      'verifyEvidenceExecutableSnapshot', 'EVIDENCE_SECOND_POSITION_PROBES',
      'gitEvidenceArgsSafe', 'parseEvidenceCommand', 'evidenceOperandNeedsRoot',
      'evidenceOperandCandidates', 'evidenceOperandEscapes',
    ],
  },
  {
    domain: 'write and tree policy',
    owner: 'lib/runtime/write-policy.js',
    facade: 'lib/runtime/hooks.js',
    symbols: [
      'parseDeletionCommand', 'WRITE_CONTENT_UNREACHABLE_ROUTE',
      'WRITE_CONTENT_UNREACHABLE_TOOLS', 'evaluateWriteContentPolicy', 'normalizePath',
      'extractApplyPatchPaths', 'pathResolvesWithinClaims', 'resolveOutOfProjectTarget',
      'pathResolvesOutsideProject', 'driftGuardApplies', 'evaluateTreePolicy',
    ],
  },
  {
    domain: 'hook lifecycle policy',
    owner: 'lib/runtime/lifecycle-policy.js',
    facade: 'lib/runtime/hooks.js',
    symbols: [
      'SAFE_SUBAGENT_TOOLS', 'SAFE_CLAUDE_SUBAGENT_TOOLS', 'CONTROL_PLANE_TOOLS',
      'isAgentDispatchTool', 'normalizeLifecycleEvent', 'evaluateLifecyclePolicy',
      'evaluateStartBinding', 'formatHookResponse',
    ],
    consumes: ['lib/runtime/evidence-policy.js', 'lib/runtime/write-policy.js'],
  },
  {
    domain: 'test path scope classification',
    owner: 'lib/runtime/path-scope.js',
    facade: 'lib/runtime/hooks.js',
    symbols: ['looksLikeTest', 'withinTestScope'],
    requiredOwner: false,
  },
  {
    domain: 'gate evaluation',
    owner: 'lib/runtime/gate-evaluation.js',
    facade: 'lib/runtime/gates.js',
    symbols: [
      'evaluateMergePrerequisites', 'ownsGlobToRegExp', 'runnerOwnsFile',
      'resolveRunnerSet', 'impactedMergeGuard', 'runMergeGates',
      'evaluateTargetedRunners', 'evaluateGates',
    ],
    mustNotConsume: ['lib/runtime/gate-watch.js', 'lib/runtime/github-shipping.js'],
  },
  {
    domain: 'detached gate watch and polling',
    owner: 'lib/runtime/gate-watch.js',
    facade: 'lib/runtime/gates.js',
    symbols: ['startGateSuite', 'pollGateSuite'],
  },
  {
    domain: 'guarded GitHub shipping',
    owner: 'lib/runtime/github-shipping.js',
    facade: 'lib/runtime/gates.js',
    symbols: ['autoMergeGithub', 'pollRemoteChecksAndMerge'],
  },
  {
    domain: 'deterministic scheduler reducer',
    owner: 'lib/runtime/reducer.js',
    facade: 'lib/runtime/scheduler.js',
    symbols: ['reduceRun'],
    consumes: [{ file: 'lib/runtime/review-evidence.js', symbols: ['reviewFindings'], exact: true }],
  },
  {
    domain: 'bounded review evidence pipeline',
    owner: 'lib/runtime/review-evidence.js',
    facade: 'lib/runtime/scheduler.js',
    symbols: ['REVIEW_FINDINGS_MAX', 'REVIEW_FINDINGS_BLOCK_LIMIT'],
    domainSymbols: ['reviewFindings'],
    ownedDeclarations: [
      'attemptSummaryList', 'attemptSummaries', 'REVIEW_FINDING_LIMIT',
      'REVIEW_FINDINGS_MAX', 'REVIEW_FINDINGS_BLOCK_LIMIT', 'REVIEW_FINDING_CUT_RESERVE',
      'REVIEW_FINDINGS_DISCLOSURE_RESERVE', 'REVIEW_STAGE_LABEL_CHARS',
      'FINDING_TITLE_KEYS', 'FINDING_BODY_KEYS', 'findingValue', 'findingText',
      'FINDING_LINE_ANCHOR', 'FINDING_LINE_CHARS', 'findingLineAnchor',
      'REVIEW_TEXT_FLATTEN', 'flattenReviewText', 'boundReviewFinding',
      'reviewFindingCost', 'boundReviewFindingsBlock', 'firstNonEmptyString',
      'reviewFindings',
    ],
  },
];

const REQUIRED_OWNER_FILES = OWNER_MANIFEST
  .filter((entry) => entry.requiredOwner !== false)
  .map((entry) => entry.owner);

const FACADE_EXPORT_COUNTS = Object.freeze({
  'lib/runtime/service.js': 21,
  'lib/runtime/hooks.js': 33,
  'lib/runtime/gates.js': 12,
  'lib/runtime/scheduler.js': 3,
});

const TASK_OPERATIONS_COMPATIBILITY = Object.freeze({
  file: 'lib/runtime/task-operations.js',
  owner: 'lib/runtime/receipt-service.js',
  movedSymbols: ['executeTaskOperationTransaction', 'withReceiptLock'],
  exactSurface: [
    'executeNextTaskOperation',
    'executeTaskOperationTransaction',
    'taskToolError',
    'withReceiptLock',
  ],
});

function hasExportModifier(node) {
  return Boolean(node.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword));
}

function bindingNames(name, names = []) {
  if (!name) return names;
  if (ts.isIdentifier(name)) {
    names.push(name.text);
    return names;
  }
  if (ts.isBindingElement(name)) {
    return bindingNames(name.name, names);
  }
  if (ts.isObjectBindingPattern(name) || ts.isArrayBindingPattern(name)) {
    for (const element of name.elements) {
      if (!element || ts.isOmittedExpression(element)) continue;
      if (ts.isBindingElement(element)) bindingNames(element.name, names);
    }
  }
  return names;
}

function declarationBindingNames(node, names = []) {
  if (!node) return names;
  if (ts.isIdentifier(node) || ts.isBindingElement(node) ||
      ts.isObjectBindingPattern(node) || ts.isArrayBindingPattern(node)) {
    return bindingNames(node, names);
  }
  if (ts.isVariableDeclaration(node) || ts.isParameter(node)) {
    return bindingNames(node.name, names);
  }
  if (ts.isVariableDeclarationList(node)) {
    for (const declaration of node.declarations) declarationBindingNames(declaration, names);
    return names;
  }
  if (ts.isFunctionDeclaration(node) || ts.isFunctionExpression(node) ||
      ts.isClassDeclaration(node) || ts.isClassExpression(node)) {
    if (node.name) bindingNames(node.name, names);
    if ('parameters' in node) {
      for (const parameter of node.parameters ?? []) declarationBindingNames(parameter, names);
    }
    return names;
  }
  if (ts.isImportClause(node)) {
    if (node.name) bindingNames(node.name, names);
    if (node.namedBindings) declarationBindingNames(node.namedBindings, names);
    return names;
  }
  if (ts.isNamedImports(node)) {
    for (const element of node.elements) declarationBindingNames(element, names);
    return names;
  }
  if (ts.isImportSpecifier(node) || ts.isNamespaceImport(node)) {
    return bindingNames(node.name, names);
  }
  if (ts.isCatchClause(node)) {
    if (node.variableDeclaration) declarationBindingNames(node.variableDeclaration, names);
    return names;
  }
  if (ts.isForOfStatement(node) || ts.isForInStatement(node)) {
    declarationBindingNames(node.initializer, names);
    return names;
  }
  return names;
}

function parseSource(file, text) {
  return ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
}

function callName(expression) {
  if (!expression) return '';
  if (ts.isIdentifier(expression)) return expression.text;
  if (ts.isPropertyAccessExpression(expression)) return expression.name.text;
  return '';
}

function delegationTarget(expression) {
  if (!expression) return false;
  if (ts.isIdentifier(expression)) return expression.text;
  if (ts.isPropertyAccessExpression(expression)) return delegationTarget(expression.expression);
  if (ts.isCallExpression(expression) || ts.isNewExpression(expression)) return delegationTarget(expression.expression);
  if (ts.isAwaitExpression(expression)) return delegationTarget(expression.expression);
  return '';
}

function isPassthroughFunction(node, importedBindings) {
  const body = node.body;
  if (!body) return false;
  if (!ts.isBlock(body)) return importedBindings.has(delegationTarget(body));
  if (body.statements.length !== 1) return false;
  const statement = body.statements[0];
  if (ts.isReturnStatement(statement)) return importedBindings.has(delegationTarget(statement.expression));
  return ts.isExpressionStatement(statement) && importedBindings.has(delegationTarget(statement.expression));
}

function inspectSource(file, text) {
  const source = parseSource(file, text);
  const declarations = new Map();
  const directExports = new Map();
  const reexports = [];
  const imports = [];
  const importEntries = [];
  const importedBindings = new Set();
  const forbiddenDelegation = [];

  for (const statement of source.statements) {
    if (!ts.isImportDeclaration(statement)) continue;
    const clause = statement.importClause;
    if (clause?.name) importedBindings.add(clause.name.text);
    const bindings = clause?.namedBindings;
    if (bindings && ts.isNamespaceImport(bindings)) importedBindings.add(bindings.name.text);
    if (bindings && ts.isNamedImports(bindings)) {
      for (const element of bindings.elements) importedBindings.add(element.name.text);
    }
  }

  function record(name, node, topLevel, exported) {
    if (!name) return;
    const entry = { name, node, topLevel, exported, passthrough: false };
    if (ts.isFunctionDeclaration(node)) entry.passthrough = isPassthroughFunction(node, importedBindings);
    if (ts.isVariableDeclaration(node) && node.initializer) {
      if (ts.isArrowFunction(node.initializer) || ts.isFunctionExpression(node.initializer)) {
        entry.passthrough = isPassthroughFunction(node.initializer, importedBindings);
      } else {
        entry.passthrough = importedBindings.has(delegationTarget(node.initializer));
      }
    }
    if (!declarations.has(name)) declarations.set(name, []);
    declarations.get(name).push(entry);
    if (topLevel && exported) directExports.set(name, entry);
  }

  for (const statement of source.statements) {
    if (ts.isImportDeclaration(statement) && statement.moduleSpecifier && ts.isStringLiteral(statement.moduleSpecifier)) {
      imports.push(statement.moduleSpecifier.text);
      const names = [];
      const clause = statement.importClause;
      if (clause?.name) names.push(clause.name.text);
      const bindings = clause?.namedBindings;
      if (bindings && ts.isNamespaceImport(bindings)) names.push(bindings.name.text);
      if (bindings && ts.isNamedImports(bindings)) {
        for (const element of bindings.elements) names.push(element.name.text);
      }
      importEntries.push({ from: statement.moduleSpecifier.text, names });
    }
    if (ts.isExportDeclaration(statement)) {
      const from = statement.moduleSpecifier && ts.isStringLiteral(statement.moduleSpecifier)
        ? statement.moduleSpecifier.text
        : null;
      if (!statement.exportClause || !ts.isNamedExports(statement.exportClause)) {
        reexports.push({ exported: '*', local: '*', from });
      } else {
        for (const element of statement.exportClause.elements) {
          reexports.push({
            exported: element.name.text,
            local: element.propertyName?.text ?? element.name.text,
            from,
          });
        }
      }
    }
    if (ts.isFunctionDeclaration(statement) || ts.isClassDeclaration(statement)) {
      record(statement.name?.text, statement, true, hasExportModifier(statement));
    }
    if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        for (const name of declarationBindingNames(declaration)) {
          record(name, declaration, true, hasExportModifier(statement));
        }
        // VariableDeclaration.initializer is optional for `let x`, loop bindings,
        // and destructuring. Never pass it to a TypeScript predicate unguarded.
        if (declaration.initializer) ts.forEachChild(declaration.initializer, () => {});
      }
    }
  }

  function visit(node) {
    if (ts.isVariableDeclaration(node)) {
      declarationBindingNames(node);
      if (node.initializer) ts.forEachChild(node.initializer, () => {});
    }
    if (ts.isCatchClause(node) && node.variableDeclaration) {
      declarationBindingNames(node);
    }
    if (ts.isForOfStatement(node) || ts.isForInStatement(node) ||
        ts.isFunctionDeclaration(node) || ts.isFunctionExpression(node) ||
        ts.isClassDeclaration(node) || ts.isClassExpression(node) ||
        ts.isImportDeclaration(node)) {
      declarationBindingNames(ts.isImportDeclaration(node) ? node.importClause : node);
    }
    if (ts.isFunctionLike(node)) {
      for (const parameter of node.parameters ?? []) {
        const names = bindingNames(parameter.name);
        for (const name of names) {
          if (/^(callback|callbacks|implementation|implementations|delegate|delegates|installer|handlers?)$/i.test(name)) {
            forbiddenDelegation.push({ type: 'parameter', functionName: node.name?.text ?? '', name });
          }
        }
      }
    }
    if (ts.isCallExpression(node)) {
      const name = callName(node.expression);
      const firstArgument = node.arguments[0];
      const isDynamicImport = node.expression.kind === ts.SyntaxKind.ImportKeyword;
      const isRequire = ts.isIdentifier(node.expression) && node.expression.text === 'require';
      if ((isDynamicImport || isRequire) && firstArgument && ts.isStringLiteral(firstArgument)) {
        imports.push(firstArgument.text);
        importEntries.push({ from: firstArgument.text, names: [] });
      }
      if (/^(configure|install|inject|register|set)(Implementation|Implementations|Handler|Handlers|Delegate|Delegates|Owner|Owners)?$/i.test(name)) {
        const identifiers = new Set();
        for (const argument of node.arguments) {
          function collect(current) {
            if (ts.isIdentifier(current)) identifiers.add(current.text);
            ts.forEachChild(current, collect);
          }
          collect(argument);
        }
        forbiddenDelegation.push({ type: 'call', name, identifiers: [...identifiers] });
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(source);

  return { file, source, declarations, directExports, reexports, imports, importEntries, forbiddenDelegation };
}

function resolveLocal(fromFile, specifier) {
  if (!specifier?.startsWith('.')) return null;
  const resolved = path.posix.normalize(path.posix.join(path.posix.dirname(fromFile), specifier));
  return path.posix.extname(resolved) ? resolved : `${resolved}.js`;
}

function findCycle(graph) {
  const state = new Map();
  const stack = [];
  function visit(file) {
    if (state.get(file) === 'done') return null;
    if (state.get(file) === 'visiting') {
      const start = stack.indexOf(file);
      return [...stack.slice(start), file];
    }
    state.set(file, 'visiting');
    stack.push(file);
    for (const dependency of graph.get(file) ?? []) {
      const cycle = visit(dependency);
      if (cycle) return cycle;
    }
    stack.pop();
    state.set(file, 'done');
    return null;
  }
  for (const file of graph.keys()) {
    const cycle = visit(file);
    if (cycle) return cycle;
  }
  return null;
}

function analyzeBoundaries({
  files,
  manifest,
  graphFiles = [...files.keys()],
  taskOperationsCompatibility = null,
}) {
  const findings = [];
  const inspections = new Map();
  const missing = manifest.filter((entry) => !files.has(entry.owner)).map((entry) => entry.owner);
  for (const owner of missing) findings.push({ code: 'missing-owner', file: owner });
  if (missing.length > 0) return { findings, missing, inspections };

  for (const [file, text] of files) inspections.set(file, inspectSource(file, text));
  for (const [file, inspection] of inspections) {
    for (const diagnostic of inspection.source.parseDiagnostics) {
      findings.push({ code: 'source-parse-error', file, start: diagnostic.start ?? null });
    }
  }

  for (const entry of manifest) {
    const owner = inspections.get(entry.owner);
    for (const symbol of [...entry.symbols, ...(entry.domainSymbols ?? [])]) {
      const implementation = owner.directExports.get(symbol);
      if (!implementation) {
        findings.push({ code: 'missing-direct-owner-symbol', file: entry.owner, symbol, domain: entry.domain });
      } else if (implementation.passthrough) {
        findings.push({ code: 'passthrough-owner-symbol', file: entry.owner, symbol, domain: entry.domain });
      }
    }
    for (const symbol of entry.ownedDeclarations ?? []) {
      const implementations = owner.declarations.get(symbol) ?? [];
      if (implementations.length === 0) {
        findings.push({ code: 'missing-owned-domain-declaration', file: entry.owner, symbol, domain: entry.domain });
      } else if (implementations.some((implementation) => implementation.passthrough)) {
        findings.push({ code: 'passthrough-owned-domain-declaration', file: entry.owner, symbol, domain: entry.domain });
      }
    }
    for (const detail of owner.forbiddenDelegation) {
      const applies = detail.type === 'parameter'
        ? entry.symbols.includes(detail.functionName)
        : detail.identifiers.some((name) => entry.symbols.includes(name));
      if (applies) findings.push({ code: 'configured-or-injected-owner', file: entry.owner, detail, domain: entry.domain });
    }
    for (const requested of entry.consumes ?? []) {
      const dependency = typeof requested === 'string' ? requested : requested.file;
      const matchingImports = owner.importEntries.filter((item) => resolveLocal(entry.owner, item.from) === dependency);
      const importsDependency = matchingImports.length > 0;
      if (!importsDependency) {
        findings.push({ code: 'missing-direct-owner-import', file: entry.owner, dependency, domain: entry.domain });
      } else if (typeof requested !== 'string') {
        const importedNames = [...new Set(matchingImports.flatMap((item) => item.names))].sort();
        const expectedNames = [...requested.symbols].sort();
        const namesMatch = requested.exact
          ? JSON.stringify(importedNames) === JSON.stringify(expectedNames)
          : expectedNames.every((name) => importedNames.includes(name));
        if (!namesMatch) {
          findings.push({
            code: 'owner-domain-import-parity', file: entry.owner, dependency,
            expected: expectedNames, actual: importedNames,
          });
        }
      }
    }
    for (const dependency of entry.mustNotConsume ?? []) {
      const importsDependency = owner.importEntries.some(
        (item) => resolveLocal(entry.owner, item.from) === dependency,
      );
      if (importsDependency) {
        findings.push({
          code: 'forbidden-owner-dependency', file: entry.owner, dependency, domain: entry.domain,
        });
      }
    }

    for (const symbol of [...entry.symbols, ...(entry.domainSymbols ?? [])]) {
      for (const [file, inspection] of inspections) {
        if (file === entry.owner || file === entry.facade) continue;
        if (inspection.directExports.has(symbol)) {
          findings.push({
            code: 'duplicate-owner-symbol', file, owner: entry.owner, symbol, domain: entry.domain,
          });
        }
      }
    }
  }

  const grouped = new Map();
  for (const entry of manifest) {
    if (!grouped.has(entry.facade)) grouped.set(entry.facade, []);
    grouped.get(entry.facade).push(entry);
  }
  for (const [facadeFile, entries] of grouped) {
    const facade = inspections.get(facadeFile);
    if (!facade) {
      findings.push({ code: 'missing-facade', file: facadeFile });
      continue;
    }
    const nonFacadeStatements = facade.source.statements.filter(
      (statement) => !ts.isExportDeclaration(statement) && !ts.isEmptyStatement(statement),
    );
    if (nonFacadeStatements.length > 0) {
      findings.push({ code: 'former-owner-retains-implementation', file: facadeFile, count: nonFacadeStatements.length });
    }
    const expected = entries.flatMap((entry) => entry.symbols).sort();
    const actual = facade.reexports.map((entry) => entry.exported).sort();
    const expectedCount = FACADE_EXPORT_COUNTS[facadeFile];
    if (expectedCount !== undefined && expected.length !== expectedCount) {
      findings.push({
        code: 'facade-manifest-baseline-count', file: facadeFile,
        expected: expectedCount, actual: expected.length,
      });
    }
    if (JSON.stringify(actual) !== JSON.stringify(expected)) {
      findings.push({ code: 'facade-export-parity', file: facadeFile, expected, actual });
    }
    const ownerForSymbol = new Map(entries.flatMap((entry) => entry.symbols.map((symbol) => [symbol, entry.owner])));
    for (const exported of facade.reexports) {
      const expectedOwner = ownerForSymbol.get(exported.exported);
      const actualOwner = resolveLocal(facadeFile, exported.from);
      if (exported.local !== exported.exported || actualOwner !== expectedOwner || !inspections.get(expectedOwner)?.directExports.has(exported.local)) {
        findings.push({
          code: 'facade-export-not-real-owner', file: facadeFile, symbol: exported.exported,
          expectedOwner, actualOwner,
        });
      }
    }
  }

  if (taskOperationsCompatibility) {
    const compatibility = inspections.get(taskOperationsCompatibility.file);
    const owner = inspections.get(taskOperationsCompatibility.owner);
    if (!compatibility) {
      findings.push({ code: 'missing-task-operations-compatibility', file: taskOperationsCompatibility.file });
    } else {
      const actualSurface = [
        ...compatibility.directExports.keys(),
        ...compatibility.reexports.map((entry) => entry.exported),
      ].sort();
      if (JSON.stringify(actualSurface) !== JSON.stringify([...taskOperationsCompatibility.exactSurface].sort())) {
        findings.push({
          code: 'task-operations-export-parity',
          file: taskOperationsCompatibility.file,
          expected: [...taskOperationsCompatibility.exactSurface].sort(),
          actual: actualSurface,
        });
      }
      for (const symbol of taskOperationsCompatibility.movedSymbols) {
        const direct = compatibility.directExports.get(symbol);
        const declarations = compatibility.declarations.get(symbol) ?? [];
        const reexports = compatibility.reexports.filter((entry) => entry.exported === symbol);
        const valid = reexports.length === 1 &&
          reexports[0].local === symbol &&
          resolveLocal(taskOperationsCompatibility.file, reexports[0].from) === taskOperationsCompatibility.owner &&
          owner?.directExports.has(symbol);
        if (direct || declarations.length > 0) {
          findings.push({
            code: 'task-operations-retains-receipt-owner',
            file: taskOperationsCompatibility.file,
            symbol,
          });
        }
        if (!valid) {
          findings.push({
            code: 'task-operations-invalid-direct-reexport',
            file: taskOperationsCompatibility.file,
            owner: taskOperationsCompatibility.owner,
            symbol,
          });
        }
      }
    }
  }

  const graphNodes = new Set(graphFiles.filter((file) => files.has(file)));
  for (const entry of manifest) {
    graphNodes.add(entry.owner);
    graphNodes.add(entry.facade);
  }
  const graph = new Map();
  for (const file of [...graphNodes].sort()) {
    const inspection = inspections.get(file);
    if (!inspection) continue;
    const edges = [...inspection.imports, ...inspection.reexports.map((entry) => entry.from)]
      .map((specifier) => resolveLocal(file, specifier))
      .filter((dependency) => dependency && graphNodes.has(dependency));
    graph.set(file, [...new Set(edges)].sort());
  }
  const cycle = findCycle(graph);
  if (cycle) findings.push({ code: 'runtime-import-cycle', cycle });

  return { findings, missing, inspections, graph };
}

function productionInput() {
  const missing = REQUIRED_OWNER_FILES.filter((file) => !existsSync(path.join(REPO_ROOT, file)));
  const tracked = execFileSync('git', ['ls-files', 'lib/runtime'], { cwd: REPO_ROOT, encoding: 'utf8' })
    .split('\n')
    .filter((file) => file.endsWith('.js'));
  const graphFiles = [...new Set([...tracked, ...REQUIRED_OWNER_FILES])].sort();
  const required = [...new Set([
    ...graphFiles,
    ...OWNER_MANIFEST.map((entry) => entry.facade),
    TASK_OPERATIONS_COMPATIBILITY.file,
  ])];
  const files = new Map();
  for (const file of required) {
    if (missing.includes(file)) continue;
    const absolute = path.join(REPO_ROOT, file);
    if (existsSync(absolute)) files.set(file, readFileSync(absolute, 'utf8'));
  }
  return { files, graphFiles, missing };
}

function oneDomainInput(
  ownerSource,
  facadeSource = "export { run } from './owner.js';\n",
  additionalFiles = {},
) {
  const files = new Map([
    ['fixture/owner.js', ownerSource],
    ['fixture/facade.js', facadeSource],
    ...Object.entries(additionalFiles),
  ]);
  const manifest = [{ domain: 'fixture domain', owner: 'fixture/owner.js', facade: 'fixture/facade.js', symbols: ['run'] }];
  return analyzeBoundaries({ files, manifest });
}

function completeSyntheticArchitecture() {
  const files = new Map();
  for (const entry of OWNER_MANIFEST) {
    const lines = [];
    for (const [index, requested] of (entry.consumes ?? []).entries()) {
      const dependency = typeof requested === 'string' ? requested : requested.file;
      const specifier = `./${path.posix.basename(dependency)}`;
      if (typeof requested === 'string') {
        lines.push(`import * as consumedDomain${index} from '${specifier}';`, `void consumedDomain${index};`);
      } else {
        lines.push(`import { ${requested.symbols.join(', ')} } from '${specifier}';`, `void ${requested.symbols[0]};`);
      }
    }
    const directExports = new Set([...entry.symbols, ...(entry.domainSymbols ?? [])]);
    const declarations = new Set([...directExports, ...(entry.ownedDeclarations ?? [])]);
    for (const symbol of declarations) {
      const exported = directExports.has(symbol) ? 'export ' : '';
      if (/^[A-Z0-9_]+$/.test(symbol)) {
        lines.push(`${exported}const ${symbol} = 1;`);
      } else {
        lines.push(`${exported}function ${symbol}() { const owned = 1; return owned; }`);
      }
    }
    files.set(entry.owner, `${lines.join('\n')}\n`);
  }
  const grouped = new Map();
  for (const entry of OWNER_MANIFEST) {
    if (!grouped.has(entry.facade)) grouped.set(entry.facade, []);
    grouped.get(entry.facade).push(entry);
  }
  for (const [facade, entries] of grouped) {
    const lines = entries.map((entry) =>
      `export { ${entry.symbols.join(', ')} } from './${path.posix.basename(entry.owner)}';`);
    files.set(facade, `${lines.join('\n')}\n`);
  }
  files.set(
    TASK_OPERATIONS_COMPATIBILITY.file,
    "export { executeTaskOperationTransaction, withReceiptLock } from './receipt-service.js';\n" +
      'export function executeNextTaskOperation() { return 1; }\n' +
      'export function taskToolError() { return 1; }\n',
  );
  return analyzeBoundaries({
    files,
    manifest: OWNER_MANIFEST,
    taskOperationsCompatibility: TASK_OPERATIONS_COMPATIBILITY,
  });
}

describe('runtime-v2 module boundaries: valid JavaScript declaration regression fixtures', () => {
  const cases = [
    ['initializer-less declaration', 'let x;'],
    ['for-of binding', 'for (const { value = 1, ...rest } of xs) { void value; void rest; }'],
    ['for-in binding', 'for (const key in obj) { void key; }'],
    ['nested object, array, rest, and default bindings', 'const { a: { b = 1 }, c: [d, , ...rest] = [] } = value;'],
    ['function bindings', 'function named({ value = 1 }, ...rest) { return [value, rest]; } const arrow = ([item]) => item;'],
    ['class bindings', 'class Named { method({ value }) { return value; } } const Expression = class Inner {};'],
    ['import bindings', "import defaultValue, { named as alias, other } from './dependency.js'; import * as namespace from './namespace.js';"],
    ['catch binding', 'try { work(); } catch ({ message = "", ...rest }) { void message; void rest; }'],
  ];
  for (const [name, source] of cases) {
    it(`does not throw or create ownership findings for ${name}`, () => {
      const files = new Map([['fixture/declarations.js', source]]);
      expect(() => analyzeBoundaries({ files, manifest: [] })).not.toThrow();
      expect(analyzeBoundaries({ files, manifest: [] }).findings).toEqual([]);
    });
  }
});

describe('runtime-v2 module boundaries: forbidden ownership fixtures use the production analyzer', () => {
  it('rejects an alias/re-export-only owner', () => {
    const result = oneDomainInput("export { implementation as run } from './implementation.js';\n");
    expect(result.findings.map((finding) => finding.code)).toContain('missing-direct-owner-symbol');
  });

  it('rejects a local passthrough wrapper', () => {
    const result = oneDomainInput("import { implementation } from './implementation.js';\nexport function run(...args) { return implementation(...args); }\n");
    expect(result.findings.map((finding) => finding.code)).toContain('passthrough-owner-symbol');
  });

  it.each([
    ['callback injection', 'export function run(callback) { return callback(); }'],
    ['function injection', 'export function run(implementation) { return implementation(); }'],
    ['configured installer', 'export function run() { return 1; }\ninstallImplementation(run);'],
    ['configure-and-delegate', 'export function run() { return 1; }\nconfigureDelegate(run);'],
  ])('rejects %s', (_name, source) => {
    const result = oneDomainInput(`${source}\n`);
    expect(result.findings.map((finding) => finding.code)).toContain('configured-or-injected-owner');
  });

  it('rejects object-property injection', () => {
    const result = oneDomainInput('export function run() { return 1; }\ninstall({ run });\n');
    expect(result.findings.map((finding) => finding.code)).toContain('configured-or-injected-owner');
  });

  it('rejects duplicate physical owners of the same domain symbol', () => {
    const result = oneDomainInput(
      'export function run() { return 1; }\n',
      "export { run } from './owner.js';\n",
      { 'fixture/duplicate.js': 'export function run() { return 2; }\n' },
    );
    expect(result.findings.map((finding) => finding.code)).toContain('duplicate-owner-symbol');
  });

  it('rejects every dependency cycle in the analyzed graph', () => {
    const result = oneDomainInput(
      "import { helper } from './dependency.js';\nexport function run() { return helper(); }\n",
      "export { run } from './owner.js';\n",
      { 'fixture/dependency.js': "import { run } from './owner.js';\nexport function helper() { return run(); }\n" },
    );
    expect(result.findings.map((finding) => finding.code)).toContain('runtime-import-cycle');
  });

  it('rejects a prohibited one-way owner back-edge even when it is not cyclic', () => {
    const files = new Map([
      ['fixture/evaluation.js', "import { ship } from './shipping.js';\nexport function run() { return ship(); }\n"],
      ['fixture/shipping.js', 'export function ship() { return 1; }\n'],
      ['fixture/facade.js', "export { run } from './evaluation.js';\n"],
    ]);
    const manifest = [{
      domain: 'evaluation', owner: 'fixture/evaluation.js', facade: 'fixture/facade.js',
      symbols: ['run'], mustNotConsume: ['fixture/shipping.js'],
    }];
    const result = analyzeBoundaries({ files, manifest });
    expect(result.findings.map((finding) => finding.code)).toContain('forbidden-owner-dependency');
  });

  it('rejects a renamed former implementation retained in the facade', () => {
    const result = oneDomainInput(
      'export function run() { const values = [1, 2, 3]; return values.reduce((a, b) => a + b, 0); }\n',
      "export { run } from './owner.js';\nfunction retainedFormerRun() { const values = [1, 2, 3]; return values.reduce((a, b) => a + b, 0); }\n",
    );
    expect(result.findings.map((finding) => finding.code)).toContain('former-owner-retains-implementation');
  });

  it('allows a compatibility re-export only when the real owner defines the symbol', () => {
    const valid = oneDomainInput('export function run() { const values = [1, 2, 3]; return values.reduce((a, b) => a + b, 0); }\n');
    expect(valid.findings).toEqual([]);
    const invalid = oneDomainInput('export function other() { return 1; }\n');
    expect(invalid.findings.map((finding) => finding.code)).toContain('facade-export-not-real-owner');
  });

  it('rejects task-operations when moved receipt symbols are defined, aliased, wrapped, or re-exported from the wrong owner', () => {
    const owner = [
      'export function executeTaskOperationTransaction() { return 1; }',
      'export function withReceiptLock() { return 1; }',
    ].join('\n');
    const cases = [
      'export function executeTaskOperationTransaction() { return 1; }',
      "export { executeTaskOperationTransaction as withReceiptLock, withReceiptLock as executeTaskOperationTransaction } from './receipt-service.js';",
      "import { executeTaskOperationTransaction as owned } from './receipt-service.js'; export function executeTaskOperationTransaction(...args) { return owned(...args); }",
      "export { executeTaskOperationTransaction, withReceiptLock } from './wrong-owner.js';",
    ];
    for (const source of cases) {
      const files = new Map([
        ['lib/runtime/receipt-service.js', `${owner}\n`],
        ['lib/runtime/task-operations.js', `${source}\nexport function executeNextTaskOperation() { return 1; }\nexport function taskToolError() { return 1; }\n`],
        ['lib/runtime/wrong-owner.js', `${owner}\n`],
      ]);
      const result = analyzeBoundaries({
        files,
        manifest: [],
        taskOperationsCompatibility: TASK_OPERATIONS_COMPATIBILITY,
      });
      expect(result.findings.map((finding) => finding.code)).toContain(
        source.startsWith('export function') || source.startsWith('import ')
          ? 'task-operations-retains-receipt-owner'
          : 'task-operations-invalid-direct-reexport',
      );
    }
  });
});

describe('runtime-v2 module boundaries: expected GREEN is reachable', () => {
  it('accepts a complete synthetic architecture satisfying the exact production manifest', () => {
    expect(completeSyntheticArchitecture().findings).toEqual([]);
  });
});

describe('runtime-v2 module boundaries: required physical owners', () => {
  const input = productionInput();
  it('declares exactly eleven new genuine owner files', () => {
    expect(REQUIRED_OWNER_FILES).toHaveLength(11);
    expect(new Set(REQUIRED_OWNER_FILES).size).toBe(11);
  });
  for (const entry of OWNER_MANIFEST) {
    it(`${entry.owner} exists as the ${entry.domain} owner`, () => {
      expect(input.missing, `missing required owner: ${entry.owner}`).not.toContain(entry.owner);
    });
  }
});

describe('runtime-v2 module boundaries: genuine ownership, facade parity, and graph', () => {
  it('uses the explicit owner-symbol manifest and has an acyclic tracked-plus-required runtime graph', () => {
    const input = productionInput();
    if (input.missing.length > 0) return;
    const result = analyzeBoundaries({
      files: input.files,
      manifest: OWNER_MANIFEST,
      graphFiles: input.graphFiles,
      taskOperationsCompatibility: TASK_OPERATIONS_COMPATIBILITY,
    });
    expect(result.findings).toEqual([]);
  });

  it('preserves every facade export identity, including task-operations receipt compatibility', async () => {
    const input = productionInput();
    if (input.missing.length > 0) return;
    for (const entry of OWNER_MANIFEST) {
      const facade = await import(new URL(`../${entry.facade}`, import.meta.url));
      const owner = await import(new URL(`../${entry.owner}`, import.meta.url));
      for (const symbol of entry.symbols) {
        expect(facade[symbol], `${entry.facade}:${symbol}`).toBe(owner[symbol]);
      }
    }
    const receiptOwner = await import('../lib/runtime/receipt-service.js');
    const taskOperations = await import('../lib/runtime/task-operations.js');
    for (const symbol of TASK_OPERATIONS_COMPATIBILITY.movedSymbols) {
      expect(taskOperations[symbol], `task-operations compatibility identity: ${symbol}`)
        .toBe(receiptOwner[symbol]);
    }
  });
});
