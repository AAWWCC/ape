import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import {
  LiveCertificationPromptError,
  buildLiveCertificationPrompt,
  writeLiveCertificationPrompts,
} from '../scripts/prepare-live-certification-prompts.mjs';

const PIPELINES = ['mechanical', 'fast', 'full', 'land'];
const SCRIPT = fileURLToPath(new URL('../scripts/prepare-live-certification-prompts.mjs', import.meta.url));
const temporaryDirectories = [];

function campaign(omit) {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), 'ape-prompt-preparation-')));
  temporaryDirectories.push(root);
  for (const pipeline of PIPELINES) {
    if (pipeline !== omit) mkdirSync(path.join(root, pipeline));
  }
  return root;
}

function expectCompletePrompts(root, files) {
  const promptsDir = path.join(root, 'prompts');
  expect(files).toEqual(PIPELINES.map((pipeline) => path.join(promptsDir, `${pipeline}-1.txt`)));
  expect(Object.isFrozen(files)).toBe(true);
  expect(readdirSync(promptsDir).sort()).toEqual(PIPELINES.map((pipeline) => `${pipeline}-1.txt`).sort());
  for (const [index, pipeline] of PIPELINES.entries()) {
    expect(readFileSync(files[index], 'utf8')).toBe(buildLiveCertificationPrompt(root, pipeline, 1));
    if (process.platform !== 'win32') expect(statSync(files[index]).mode & 0o777).toBe(0o600);
  }
  if (process.platform !== 'win32') expect(statSync(promptsDir).mode & 0o777).toBe(0o700);
}

afterEach(() => {
  for (const dir of temporaryDirectories.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('live-certification prompt preparation admission', () => {
  it.each(PIPELINES)('does not create output when %s is missing, then succeeds after correction', (pipeline) => {
    const root = campaign(pipeline);
    expect(() => writeLiveCertificationPrompts(root)).toThrow(LiveCertificationPromptError);
    expect(existsSync(path.join(root, 'prompts'))).toBe(false);
    mkdirSync(path.join(root, pipeline));
    expectCompletePrompts(root, writeLiveCertificationPrompts(root));
  });

  it.each(PIPELINES)('requires %s to be a directory before creating output', (pipeline) => {
    const root = campaign(pipeline);
    const projectPath = path.join(root, pipeline);
    writeFileSync(projectPath, 'not a project directory\n');
    expect(() => writeLiveCertificationPrompts(root)).toThrow(LiveCertificationPromptError);
    expect(existsSync(path.join(root, 'prompts'))).toBe(false);
    expect(readFileSync(projectPath, 'utf8')).toBe('not a project directory\n');
    rmSync(projectPath);
    mkdirSync(projectPath);
    expectCompletePrompts(root, writeLiveCertificationPrompts(root));
  });

  it('rejects a regular-file campaign root with the directory-contract error', () => {
    const root = campaign();
    const file = path.join(root, 'not-a-directory');
    writeFileSync(file, 'campaign sentinel\n');
    expect(() => writeLiveCertificationPrompts(file)).toThrow(LiveCertificationPromptError);
    expect(readFileSync(file, 'utf8')).toBe('campaign sentinel\n');
    expect(existsSync(path.join(root, 'prompts'))).toBe(false);
  });

  it.skipIf(process.platform === 'win32')('rejects an aliased later project without partial output', () => {
    const root = campaign('full');
    const alias = path.join(root, 'full');
    symlinkSync(path.join(root, 'mechanical'), alias, 'dir');
    expect(() => writeLiveCertificationPrompts(root)).toThrow(/campaign project does not resolve exactly/);
    expect(existsSync(path.join(root, 'prompts'))).toBe(false);
    rmSync(alias);
    mkdirSync(alias);
    expectCompletePrompts(root, writeLiveCertificationPrompts(root));
  });

  it('refuses to reuse existing output and preserves every existing byte', () => {
    const root = campaign();
    const files = writeLiveCertificationPrompts(root);
    const originals = files.map((file) => readFileSync(file));
    const sentinel = path.join(root, 'prompts', 'operator-note.txt');
    writeFileSync(sentinel, 'keep this existing output\n');
    expect(() => writeLiveCertificationPrompts(root)).toThrow(/refusing to reuse existing prompt directory/);
    expect(files.map((file) => readFileSync(file))).toEqual(originals);
    expect(readFileSync(sentinel, 'utf8')).toBe('keep this existing output\n');
    expect(readdirSync(path.join(root, 'prompts'))).toHaveLength(5);
  });

  it('refuses to overwrite an existing regular file at the output path', () => {
    const root = campaign();
    const promptsPath = path.join(root, 'prompts');
    writeFileSync(promptsPath, 'keep this file\n');
    expect(() => writeLiveCertificationPrompts(root)).toThrow(/refusing to reuse existing prompt directory/);
    expect(readFileSync(promptsPath, 'utf8')).toBe('keep this file\n');
  });

  it('the CLI leaves no partial output after a later missing project and accepts the corrected campaign', () => {
    const root = campaign('land');
    const invoke = () => spawnSync(process.execPath, [SCRIPT, '--campaign-root', root], {
      encoding: 'utf8',
      timeout: 5_000,
    });
    const refused = invoke();
    expect(refused.error).toBeUndefined();
    expect(refused.status).toBe(1);
    expect(refused.stderr).toMatch(/campaign project does not resolve exactly/);
    expect(refused.stdout).toBe('');
    expect(existsSync(path.join(root, 'prompts'))).toBe(false);
    mkdirSync(path.join(root, 'land'));
    const accepted = invoke();
    expect(accepted.error).toBeUndefined();
    expect(accepted.status).toBe(0);
    expect(accepted.stderr).toBe('');
    expect(accepted.stdout).toMatch(/^wrote 4 live-certification prompts for /);
    expect(readdirSync(path.join(root, 'prompts'))).toHaveLength(4);
  });
});
