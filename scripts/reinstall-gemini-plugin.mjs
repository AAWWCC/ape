#!/usr/bin/env node
/**
 * Reinstall/copy the local Gemini / Antigravity APE plugin package to ~/.gemini/config/plugins/ape/
 */

import { cp, mkdir, rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = dirname(SCRIPT_DIR);
const SOURCE_PLUGIN_ROOT = join(REPO_ROOT, 'plugins', 'ape-gemini');
const TARGET_PLUGIN_ROOT = join(homedir(), '.gemini', 'config', 'plugins', 'ape');

function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: REPO_ROOT, stdio: 'inherit' });
    child.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${command} ${args.join(' ')} failed with code ${code}`));
    });
    child.on('error', reject);
  });
}

async function main() {
  console.log('Building APE bundles and packages...');
  await run('node', ['scripts/build-plugin-packages.mjs']);

  console.log(`Installing APE Gemini plugin to ${TARGET_PLUGIN_ROOT}...`);
  await mkdir(TARGET_PLUGIN_ROOT, { recursive: true });

  const entries = [
    'plugin.json',
    'mcp_config.json',
    'hooks.json',
    '.mcp.json',
    'package.json',
    'LICENSE',
    'THIRD_PARTY_NOTICES.md',
    'dist',
    'hooks',
    'lib',
    'prompts',
    'skills',
  ];

  for (const entry of entries) {
    const src = join(SOURCE_PLUGIN_ROOT, entry);
    const dest = join(TARGET_PLUGIN_ROOT, entry);
    await rm(dest, { recursive: true, force: true });
    await cp(src, dest, { recursive: true });
  }

  console.log(`Successfully installed APE plugin for Gemini at ${TARGET_PLUGIN_ROOT}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
