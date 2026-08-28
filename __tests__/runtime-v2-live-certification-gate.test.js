import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import {
  TERMINAL_REASON_CODES,
  TERMINAL_REASON_TAXONOMY_VERSION,
} from '../lib/runtime/terminal-telemetry.js';
import {
  LIVE_CERTIFICATION_HOSTS,
  LIVE_CERTIFICATION_PIPELINES,
  LIVE_CERTIFICATION_UNVERIFIED_HOSTS,
  LiveCertificationError,
  parseLiveCertificationJson,
  validateLiveCertificationDocument as validateDocument,
  verifyLiveCertificationRepository,
} from '../scripts/verify-live-certification.mjs';
import {
  verifyLiveCertificationEnvironment,
} from '../scripts/check-live-certification-environment.mjs';
import {
  LiveCertificationParentError,
  buildCodexParentInvocation,
} from '../scripts/run-live-certification-parent.mjs';

const VERSION = '2.23.33';
const SOURCE = 'a'.repeat(40);
const HOST_VERSIONS = Object.freeze({ codex: '0.147.0', claude: '2.1.228' });
const temporaryRepositories = [];

function certificationParentFixture({
  zeroRetry = true,
  analyticsDisabled = true,
  remotePluginDisabled = true,
} = {}) {
  const root = mkdtempSync(path.join(tmpdir(), 'ape-live-parent-'));
  temporaryRepositories.push(root);
  const projectDir = path.join(root, 'project');
  const codexHome = path.join(root, 'codex-home');
  const promptPath = path.join(root, 'prompt.txt');
  mkdirSync(projectDir, { recursive: true });
  mkdirSync(path.join(codexHome, 'plugins', 'cache', 'ape', 'ape', VERSION), { recursive: true });
  const exactProject = realpathSync(projectDir);
  writeFileSync(promptPath, `$ape:run\nPass project_dir "${exactProject}" on every APE MCP call.\n`);
  writeFileSync(
    path.join(codexHome, 'config.toml'),
    [
      'model_provider = "openai-zero-retry"',
      zeroRetry ? 'request_max_retries = 0' : 'request_max_retries = 5',
      'stream_max_retries = 0',
      'supports_websockets = false',
      '[analytics]',
      analyticsDisabled ? 'enabled = false' : 'enabled = true',
      '[features]',
      remotePluginDisabled ? 'remote_plugin = false' : 'remote_plugin = true',
    ].join('\n'),
  );
  writeFileSync(
    path.join(codexHome, 'plugins', 'cache', 'ape', 'ape', VERSION, 'package.json'),
    `${JSON.stringify({ name: 'ape', version: VERSION })}\n`,
  );
  return {
    projectDir: exactProject,
    codexHome: realpathSync(codexHome),
    promptPath,
  };
}

function hash(number) {
  return number.toString(16).padStart(40, '0');
}

function runRecordHash(number) {
  return number.toString(16).padStart(64, '0');
}

function landProof(sequence) {
  const pushed = hash(100 + sequence);
  const merge = hash(300 + sequence);
  return {
    target_branch: 'main',
    merge_method: 'squash',
    auto_merge_required: true,
    pr_state: 'MERGED',
    pushed_head_commit: pushed,
    observed_merged_pr_head: pushed,
    merge_commit: merge,
    remote_head_after_merge: merge,
  };
}

function cleanAttempt({ sequence, host, pipeline, sourceCommit = SOURCE }) {
  return {
    sequence,
    attempt_id: `${host}-${pipeline}-${sequence}`,
    host,
    host_version: HOST_VERSIONS[host],
    plugin_version: VERSION,
    pipeline,
    source_commit: sourceCommit,
    run_record_sha256: runRecordHash(sequence),
    ticket_count: pipeline === 'mechanical' ? 3 : 9,
    duration_ms: 1_000 + sequence,
    outcome: 'success',
    terminal_reason_code: 'completed',
    manual_intervention: false,
    prompt_assembly_failure: false,
    worker_tool_failure: false,
    control_call_failure: false,
    host_transport_retry: false,
    receipt_repair: false,
    duplicate_dispatch: false,
    remediation: false,
    self_correction: false,
    abort_successor: false,
    protected_land: pipeline === 'protected-branch-land' ? landProof(sequence) : null,
  };
}

function validLedger(sourceCommit = SOURCE) {
  const attempts = [];
  for (const host of LIVE_CERTIFICATION_HOSTS) {
    for (const pipeline of LIVE_CERTIFICATION_PIPELINES) {
      for (let repetition = 0; repetition < 3; repetition += 1) {
        attempts.push(cleanAttempt({
          sequence: attempts.length + 1,
          host,
          pipeline,
          sourceCommit,
        }));
      }
    }
  }
  return {
    schema_version: 3,
    ape_version: VERSION,
    source_commit: sourceCommit,
    certified_hosts: [...LIVE_CERTIFICATION_HOSTS],
    unverified_hosts: [...LIVE_CERTIFICATION_UNVERIFIED_HOSTS],
    terminal_reason_taxonomy_version: TERMINAL_REASON_TAXONOMY_VERSION,
    attempts,
  };
}

function canonical(document) {
  return `${JSON.stringify(document, null, 2)}\n`;
}

function validateLiveCertificationDocument(document, options = {}) {
  return validateDocument(document, {
    packageVersion: VERSION,
    sourceCommit: SOURCE,
    hostVersions: HOST_VERSIONS,
    ...options,
  });
}

function git(repo, ...args) {
  return execFileSync('git', args, {
    cwd: repo,
    encoding: 'utf8',
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'APE Certification Test',
      GIT_AUTHOR_EMAIL: 'ape-certification@example.invalid',
      GIT_COMMITTER_NAME: 'APE Certification Test',
      GIT_COMMITTER_EMAIL: 'ape-certification@example.invalid',
    },
  }).trim();
}

function sourceRepository({
  codexCertification = 'required',
  claudeCertification = 'unverified',
  extraHost = false,
} = {}) {
  const repo = mkdtempSync(path.join(tmpdir(), 'ape-live-certification-'));
  temporaryRepositories.push(repo);
  git(repo, 'init', '--initial-branch=main');
  mkdirSync(path.join(repo, 'evals'));
  writeFileSync(path.join(repo, 'package.json'), canonical({ name: 'ape', version: VERSION }));
  writeFileSync(path.join(repo, 'compatibility.json'), canonical({
    version: 2,
    hosts: {
      codex: {
        package: '@openai/codex',
        version: HOST_VERSIONS.codex,
        live_certification: codexCertification,
      },
      claude: {
        package: '@anthropic-ai/claude-code',
        version: HOST_VERSIONS.claude,
        live_certification: claudeCertification,
      },
      ...(extraHost ? {
        other: {
          package: '@example/other-host',
          version: '1.0.0',
          live_certification: 'unverified',
        },
      } : {}),
    },
  }));
  writeFileSync(path.join(repo, 'source.txt'), 'tested source\n');
  git(repo, 'add', 'package.json', 'compatibility.json', 'source.txt');
  git(repo, 'commit', '-m', 'source candidate');
  return { repo, source: git(repo, 'rev-parse', 'HEAD') };
}

function certificationCommit({
  extraPath = null,
  sourceOverride = null,
  codexCertification = 'required',
  claudeCertification = 'unverified',
  extraHost = false,
} = {}) {
  const { repo, source } = sourceRepository({
    codexCertification,
    claudeCertification,
    extraHost,
  });
  const document = validLedger(sourceOverride ?? source);
  writeFileSync(path.join(repo, 'evals', 'live-certification.json'), canonical(document));
  git(repo, 'add', 'evals/live-certification.json');
  if (extraPath) {
    writeFileSync(path.join(repo, extraPath), 'not certification evidence\n');
    git(repo, 'add', extraPath);
  }
  git(repo, 'commit', '-m', 'certify live hosts');
  const head = git(repo, 'rev-parse', 'HEAD');
  git(repo, 'tag', `v${VERSION}`);
  return { repo, source, head };
}

afterEach(() => {
  for (const directory of temporaryRepositories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe('live certification Codex parent launcher', () => {
  it('always carries the vetted-hook flag and the isolated zero-retry home', () => {
    const fixture = certificationParentFixture();
    const invocation = buildCodexParentInvocation(fixture);
    expect(invocation.command).toBe('codex');
    expect(invocation.args).toEqual([
      'exec',
      '--dangerously-bypass-approvals-and-sandbox',
      '--dangerously-bypass-hook-trust',
      '--color',
      'never',
      '-C',
      fixture.projectDir,
      '-',
    ]);
    expect(invocation.env).toEqual({ CODEX_HOME: fixture.codexHome });
    expect(invocation.input).toBe(
      `$ape:run\nPass project_dir "${fixture.projectDir}" on every APE MCP call.\n`,
    );
  });

  it('fails closed before launch when automatic transport retries are enabled', () => {
    const fixture = certificationParentFixture({ zeroRetry: false });
    expect(() => buildCodexParentInvocation(fixture)).toThrow(LiveCertificationParentError);
    expect(() => buildCodexParentInvocation(fixture)).toThrow(/request_max_retries = 0/iu);
  });

  it('fails closed before launch when optional analytics transport is enabled', () => {
    const fixture = certificationParentFixture({ analyticsDisabled: false });
    expect(() => buildCodexParentInvocation(fixture)).toThrow(LiveCertificationParentError);
    expect(() => buildCodexParentInvocation(fixture)).toThrow(
      /disable analytics.*transport retries/iu,
    );
  });

  it('fails closed before launch when optional remote plugin catalog transport is enabled', () => {
    const fixture = certificationParentFixture({ remotePluginDisabled: false });
    expect(() => buildCodexParentInvocation(fixture)).toThrow(LiveCertificationParentError);
    expect(() => buildCodexParentInvocation(fixture)).toThrow(
      /disable remote_plugin.*catalog transport failures/iu,
    );
  });

  it('fails closed when the prompt omits or misstates the governed project root', () => {
    const fixture = certificationParentFixture();
    writeFileSync(fixture.promptPath, '$ape:run\n');
    expect(() => buildCodexParentInvocation(fixture)).toThrow(
      /prompt must declare the exact project_dir/iu,
    );

    const staleProject = path.join(path.dirname(fixture.projectDir), 'stale-project');
    mkdirSync(staleProject);
    writeFileSync(
      fixture.promptPath,
      `$ape:run\nPass project_dir "${staleProject}" on every APE MCP call.\n`,
    );
    expect(() => buildCodexParentInvocation(fixture)).toThrow(
      /does not match --project-dir/iu,
    );

    const missingProject = path.join(path.dirname(fixture.projectDir), 'missing-project');
    writeFileSync(
      fixture.promptPath,
      `$ape:run\nPass project_dir "${missingProject}" on every APE MCP call.\n`,
    );
    expect(() => buildCodexParentInvocation(fixture)).toThrow(
      /does not resolve to an existing path/iu,
    );
  });
});

describe('live release certification evidence', () => {
  it('requires a repository-local GitHub noreply identity before live attempts', () => {
    const { repo } = sourceRepository();
    expect(() => verifyLiveCertificationEnvironment(repo))
      .toThrow(/repository-local user\.name/u);
    git(repo, 'config', '--local', 'user.name', 'APE Certification');
    git(repo, 'config', '--local', 'user.email', 'developer@example.invalid');
    expect(() => verifyLiveCertificationEnvironment(repo))
      .toThrow(/repository-local GitHub noreply user\.email/u);
    git(repo, 'config', '--local', 'user.email', 'ape-certification@users.noreply.github.com');
    expect(verifyLiveCertificationEnvironment(repo)).toEqual({
      identity_scope: 'repository-local',
      email_domain: 'users.noreply.github.com',
    });

    const aliasRoot = mkdtempSync(path.join(tmpdir(), 'ape-live-certification-alias-'));
    temporaryRepositories.push(aliasRoot);
    const sourceAlias = path.join(aliasRoot, 'source');
    symlinkSync(
      fileURLToPath(new URL('..', import.meta.url)),
      sourceAlias,
      process.platform === 'win32' ? 'junction' : 'dir',
    );
    const output = execFileSync(process.execPath, [
      path.join(sourceAlias, 'scripts', 'check-live-certification-environment.mjs'),
      '--project-dir',
      repo,
    ], { encoding: 'utf8' });
    expect(output).toMatch(/live-certification environment passed/u);
  });

  it('requires three clean completed raw attempts for every certified host and pipeline', () => {
    const result = validateLiveCertificationDocument(validLedger(), {
      packageVersion: VERSION,
      sourceCommit: SOURCE,
    });
    expect(result).toEqual({ version: VERSION, attempt_count: 12, cohort_count: 4 });
  });

  it('rejects the candidate on its first failed attempt instead of accepting later clean runs', () => {
    const document = validLedger();
    const failed = {
      ...cleanAttempt({ sequence: 1, host: 'codex', pipeline: 'mechanical' }),
      attempt_id: 'codex-mechanical-failed-raw-attempt',
      outcome: 'failure',
      terminal_reason_code: 'aborted_dispatch',
      prompt_assembly_failure: true,
      run_record_sha256: runRecordHash(1_000),
    };
    document.attempts[0] = failed;
    expect(() => validateLiveCertificationDocument(document, {
      packageVersion: VERSION,
      sourceCommit: SOURCE,
    })).toThrow(/first-pass perfect/iu);
  });

  it.each([
    'worker_tool_failure',
    'control_call_failure',
    'host_transport_retry',
    'receipt_repair',
    'duplicate_dispatch',
    'remediation',
    'self_correction',
  ])('rejects a candidate whose first cycle records %s', (flag) => {
    const document = validLedger();
    document.attempts[0][flag] = true;
    expect(() => validateLiveCertificationDocument(document, {
      packageVersion: VERSION,
      sourceCommit: SOURCE,
    })).toThrow(/not first-pass perfect/iu);
  });

  it('fails closed on missing coverage, a dirty final run, or non-completed success', () => {
    const missing = validLedger();
    missing.attempts.splice(-3);
    missing.attempts.push(
      cleanAttempt({ sequence: 10, host: 'codex', pipeline: 'full' }),
      cleanAttempt({ sequence: 11, host: 'codex', pipeline: 'full' }),
      cleanAttempt({ sequence: 12, host: 'codex', pipeline: 'full' }),
    );
    expect(() => validateLiveCertificationDocument(missing, {
      packageVersion: VERSION,
      sourceCommit: SOURCE,
    })).toThrow(/three-run repeatability|protected-branch-land must contain exactly three/iu);

    const dirty = validLedger();
    dirty.attempts.at(-1).receipt_repair = true;
    expect(() => validateLiveCertificationDocument(dirty, {
      packageVersion: VERSION,
      sourceCommit: SOURCE,
    })).toThrow(/not first-pass perfect/iu);

    const contradictory = validLedger();
    contradictory.attempts[0].terminal_reason_code = 'test_failed';
    expect(() => validateLiveCertificationDocument(contradictory, {
      packageVersion: VERSION,
      sourceCommit: SOURCE,
    })).toThrow(/outcome and terminal reason code disagree/iu);
  });

  it('rejects Claude attempts because Claude is packaged but not live-certified', () => {
    const document = validLedger();
    document.attempts[0] = {
      ...document.attempts[0],
      attempt_id: 'claude-unverified-attempt',
      host: 'claude',
      host_version: HOST_VERSIONS.claude,
    };
    expect(() => validateLiveCertificationDocument(document, {
      packageVersion: VERSION,
      sourceCommit: SOURCE,
    })).toThrow(/unsupported host/iu);
  });

  it('fails closed when the ledger changes the certified or unverified host partition', () => {
    const noCertifiedHost = validLedger();
    noCertifiedHost.certified_hosts = [];
    expect(() => validateLiveCertificationDocument(noCertifiedHost, {
      packageVersion: VERSION,
      sourceCommit: SOURCE,
    })).toThrow(/exact required live-certified hosts/iu);

    const claimsClaude = validLedger();
    claimsClaude.unverified_hosts = [];
    expect(() => validateLiveCertificationDocument(claimsClaude, {
      packageVersion: VERSION,
      sourceCommit: SOURCE,
    })).toThrow(/exact unverified hosts/iu);
  });

  it('requires exact pushed-head merge proof for every successful protected land attempt', () => {
    const document = validLedger();
    const protectedAttempt = document.attempts.find((attempt) => attempt.pipeline === 'protected-branch-land');
    protectedAttempt.protected_land.observed_merged_pr_head = hash(999);
    expect(() => validateLiveCertificationDocument(document, {
      packageVersion: VERSION,
      sourceCommit: SOURCE,
    })).toThrow(/did not merge the exact pushed head/iu);

    const unprotected = validLedger();
    const unprotectedAttempt = unprotected.attempts
      .find((attempt) => attempt.pipeline === 'protected-branch-land');
    unprotectedAttempt.protected_land.auto_merge_required = false;
    expect(() => validateLiveCertificationDocument(unprotected, {
      packageVersion: VERSION,
      sourceCommit: SOURCE,
    })).toThrow(/required protected auto-merge path/iu);
  });

  it('rejects free-form fields, unsafe versions, mismatched source/version, and non-canonical JSON', () => {
    const withProse = validLedger();
    withProse.attempts[0].objective = 'unbounded private prose';
    expect(() => validateLiveCertificationDocument(withProse, {
      packageVersion: VERSION,
      sourceCommit: SOURCE,
    })).toThrow(/missing or unsupported fields/iu);

    const unsupportedVersion = validLedger();
    unsupportedVersion.attempts[0].host_version = 'banana';
    expect(() => validateLiveCertificationDocument(unsupportedVersion, {
      packageVersion: VERSION,
      sourceCommit: SOURCE,
    })).toThrow(/host version does not match compatibility\.json/iu);

    const reusedRecord = validLedger();
    reusedRecord.attempts[1].run_record_sha256 = reusedRecord.attempts[0].run_record_sha256;
    expect(() => validateLiveCertificationDocument(reusedRecord, {
      packageVersion: VERSION,
      sourceCommit: SOURCE,
    })).toThrow(/reuses an archived run-record digest/iu);

    expect(() => validateLiveCertificationDocument(validLedger(), {
      packageVersion: '9.9.9',
      sourceCommit: SOURCE,
    })).toThrow(/version does not match/iu);
    expect(() => validateLiveCertificationDocument(validLedger(), {
      packageVersion: VERSION,
      sourceCommit: 'b'.repeat(40),
    })).toThrow(/source commit/iu);
    expect(() => parseLiveCertificationJson(JSON.stringify(validLedger()))).toThrow(/canonical/iu);
    expect(() => parseLiveCertificationJson('x'.repeat(256 * 1024 + 1))).toThrow(/size limit/iu);
  });
});

describe('tagged certification-only commit gate', () => {
  it('verifies committed evidence from a single-child tag and ignores the working tree', () => {
    const { repo, head } = certificationCommit();
    writeFileSync(path.join(repo, 'evals', 'live-certification.json'), '{"fabricated":true}\n');
    expect(verifyLiveCertificationRepository({ repo, head, tag: `v${VERSION}` })).toEqual({
      version: VERSION,
      attempt_count: 12,
      cohort_count: 4,
    });
  });

  it('rejects a certification commit with any additional changed path', () => {
    const { repo, head } = certificationCommit({ extraPath: 'extra.txt' });
    expect(() => verifyLiveCertificationRepository({ repo, head, tag: `v${VERSION}` }))
      .toThrow(/only add or modify evals\/live-certification\.json/iu);
  });

  it('rejects evidence that names any source other than the certification commit parent', () => {
    const { repo, head } = certificationCommit({ sourceOverride: 'b'.repeat(40) });
    expect(() => verifyLiveCertificationRepository({ repo, head, tag: `v${VERSION}` }))
      .toThrow(/source commit is not the certification commit parent/iu);
  });

  it('rejects a tagged source whose required and unverified host statuses are swapped', () => {
    const { repo, head } = certificationCommit({
      codexCertification: 'unverified',
      claudeCertification: 'required',
    });
    expect(() => verifyLiveCertificationRepository({ repo, head, tag: `v${VERSION}` }))
      .toThrow(/invalid live-certification policy/iu);
  });

  it('rejects a tagged source that adds a host outside the exact policy partition', () => {
    const { repo, head } = certificationCommit({ extraHost: true });
    expect(() => verifyLiveCertificationRepository({ repo, head, tag: `v${VERSION}` }))
      .toThrow(/exact certification host partition/iu);
  });

  it('rejects a two-parent release head even when its first-parent diff only adds the ledger', () => {
    const { repo, source } = sourceRepository();
    const sourceTree = git(repo, 'rev-parse', `${source}^{tree}`);
    const secondParent = git(repo, 'commit-tree', sourceTree, '-p', source, '-m', 'empty side parent');
    writeFileSync(path.join(repo, 'evals', 'live-certification.json'), canonical(validLedger(source)));
    git(repo, 'add', 'evals/live-certification.json');
    const certificationTree = git(repo, 'write-tree');
    const head = git(
      repo,
      'commit-tree',
      certificationTree,
      '-p',
      source,
      '-p',
      secondParent,
      '-m',
      'invalid merge certification',
    );
    git(repo, 'update-ref', 'refs/heads/main', head);
    git(repo, 'tag', `v${VERSION}`, head);
    expect(() => verifyLiveCertificationRepository({ repo, head, tag: `v${VERSION}` }))
      .toThrow(/exactly one parent/iu);
  });

  it('requires the version tag itself to resolve to the certification head', () => {
    const { repo, source, head } = certificationCommit();
    git(repo, 'tag', '--force', `v${VERSION}`, source);
    expect(() => verifyLiveCertificationRepository({ repo, head, tag: `v${VERSION}` }))
      .toThrow(/tag does not point to the certification commit/iu);
  });

  it('refuses to verify a tag other than the commit currently checked out', () => {
    const { repo, head } = certificationCommit();
    writeFileSync(path.join(repo, 'after-tag.txt'), 'different checkout\n');
    git(repo, 'add', 'after-tag.txt');
    git(repo, 'commit', '-m', 'move checkout past certification');
    expect(() => verifyLiveCertificationRepository({ repo, head, tag: `v${VERSION}` }))
      .toThrow(/tag commit must be the checked-out HEAD/iu);
  });

  it('ships a strict privacy-safe schema but no fabricated live ledger', () => {
    const schema = JSON.parse(readFileSync(new URL('../evals/live-certification.schema.json', import.meta.url), 'utf8'));
    expect(schema.additionalProperties).toBe(false);
    expect(schema.$defs.attempt.additionalProperties).toBe(false);
    expect(schema.properties.terminal_reason_taxonomy_version.const)
      .toBe(TERMINAL_REASON_TAXONOMY_VERSION);
    expect(schema.properties.schema_version.const).toBe(3);
    expect(schema.properties.certified_hosts.const).toEqual(['codex']);
    expect(schema.properties.unverified_hosts.const).toEqual(['claude']);
    expect(schema.properties.attempts.minItems).toBe(12);
    expect(schema.properties.attempts.maxItems).toBe(12);
    expect(schema.$defs.attempt.required).toContain('host_transport_retry');
    expect(schema.$defs.attempt.properties.host.enum).toEqual(['codex']);
    expect(schema.$defs.attempt.properties.pipeline.enum).toEqual([
      'mechanical',
      'fast',
      'full',
      'protected-branch-land',
    ]);
    expect(schema.$defs.terminal_reason_code.enum).toEqual(TERMINAL_REASON_CODES);
    expect(LiveCertificationError).toBeTypeOf('function');
  });
});
