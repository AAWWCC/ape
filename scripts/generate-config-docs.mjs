#!/usr/bin/env node

import { readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_CONFIG } from '../lib/runtime/config.js';
import { LANES, RISK_TRIGGERS } from '../lib/runtime/constants.js';
import { classifyLane } from '../lib/runtime/lane-policy.js';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const DOC = join(ROOT, 'docs', 'configuration.md');
const CONFIG_START = '<!-- BEGIN GENERATED CONFIG REFERENCE -->';
const CONFIG_END = '<!-- END GENERATED CONFIG REFERENCE -->';
const LANE_START = '<!-- BEGIN GENERATED LANE REFERENCE -->';
const LANE_END = '<!-- END GENERATED LANE REFERENCE -->';

class DocsError extends Error {}

function replaceBlock(document, startMarker, endMarker, body) {
  const start = document.indexOf(startMarker);
  const end = document.indexOf(endMarker);
  if (start === -1 || end === -1 || end < start) {
    throw new DocsError(`missing or disordered generated markers ${startMarker} / ${endMarker}`);
  }
  return `${document.slice(0, start)}${startMarker}\n${body.trim()}\n${endMarker}${document.slice(end + endMarker.length)}`;
}

function flatten(node, prefix = [], result = []) {
  if (!node || typeof node !== 'object' || Array.isArray(node) || Object.keys(node).length === 0) {
    result.push([prefix.join('.'), node]);
    return result;
  }
  for (const [key, value] of Object.entries(node)) flatten(value, [...prefix, key], result);
  return result;
}

function currentPurposes(document) {
  const result = new Map();
  for (const match of document.matchAll(/^\| `([^`]+)` \| [^|]+ \| [^|]+ \| (.+) \|$/gmu)) {
    result.set(match[1], match[2]);
  }
  return result;
}

function typeOf(key, value) {
  if (value === null) return 'string or null';
  if (Array.isArray(value)) return key === 'policy.evidence_scripts' ? 'string array' : 'object array';
  if (value && typeof value === 'object') return 'object';
  return typeof value;
}

function configReference(document) {
  const purposes = currentPurposes(document);
  const rows = flatten(DEFAULT_CONFIG).map(([key, value]) => {
    const purpose = purposes.get(key);
    if (!purpose) throw new DocsError(`missing human purpose text for generated config key ${key}`);
    return `| \`${key}\` | ${typeOf(key, value)} | \`${JSON.stringify(value)}\` | ${purpose} |`;
  });
  return [
    '## Complete key reference',
    '',
    '`DEFAULT_CONFIG` in `lib/runtime/config.js` is the source of truth. This generated table is',
    'checked byte-for-byte by `npm run docs:check`.',
    '',
    '| Key | Type | Default | Purpose |',
    '| --- | --- | --- | --- |',
    ...rows,
  ].join('\n');
}

function scenario(label, input) {
  const result = classifyLane(input, DEFAULT_CONFIG.policy);
  return `| ${label} | \`${input.requested_lane}\` | \`${result.lane}\` | ${result.reasons.map((reason) => `\`${reason}\``).join(', ')} |`;
}

function laneReference() {
  const sevenFiles = Array.from({ length: DEFAULT_CONFIG.policy.fast_max_files + 1 }, (_, index) =>
    `src/file-${index + 1}.js`
  );
  return [
    '## Generated lane classifier reference',
    '',
    `Accepted requested lanes: ${LANES.map((lane) => `\`${lane}\``).join(', ')}.`,
    '',
    '| Representative input | Requested | Classified | Runtime reasons |',
    '| --- | --- | --- | --- |',
    scenario('Non-behavioral documentation', { requested_lane: 'auto', behavioral: false, claimed_paths: ['README.md'], risk_triggers: [] }),
    scenario('Bounded behavioral source', { requested_lane: 'auto', behavioral: true, claimed_paths: ['src/app.js'], risk_triggers: [] }),
    scenario('Behavioral scope above fast limit', { requested_lane: 'auto', behavioral: true, claimed_paths: sevenFiles, risk_triggers: [] }),
    scenario('Explicit mechanical with behavioral source', { requested_lane: 'mechanical', behavioral: true, claimed_paths: ['src/app.js'], risk_triggers: [] }),
    scenario('Explicit fast above file limit', { requested_lane: 'fast', behavioral: true, claimed_paths: sevenFiles, risk_triggers: [] }),
    scenario('Explicit full', { requested_lane: 'full', behavioral: true, claimed_paths: ['src/app.js'], risk_triggers: [] }),
    scenario('Auto mechanical scope with recognized risk', { requested_lane: 'auto', behavioral: false, claimed_paths: ['README.md'], risk_triggers: [RISK_TRIGGERS[0]] }),
    '',
    'Canonical start-time `risk_triggers` are:',
    '',
    ...RISK_TRIGGERS.map((trigger) => `- \`${trigger}\``),
    '',
    'Unknown triggers are rejected. A recognized trigger normally selects the full lane and arms',
    'security review; auto-classified non-behavioral mechanical scope remains mechanical while',
    'retaining the risk trigger and conditional review.',
  ].join('\n');
}

async function main(argv) {
  if (argv.some((argument) => argument !== '--check')) {
    throw new DocsError('usage: node scripts/generate-config-docs.mjs [--check]');
  }
  const original = await readFile(DOC, 'utf8');
  let generated = replaceBlock(original, CONFIG_START, CONFIG_END, configReference(original));
  generated = replaceBlock(generated, LANE_START, LANE_END, laneReference());
  if (argv.includes('--check')) {
    if (generated !== original) throw new DocsError('docs/configuration.md is stale; run npm run docs:config');
    process.stdout.write('generated configuration documentation is current\n');
    return;
  }
  await writeFile(DOC, generated, 'utf8');
  process.stdout.write('updated generated configuration documentation\n');
}

main(process.argv.slice(2)).catch((error) => {
  process.stderr.write(`generate-config-docs: ${error?.message ?? String(error)}\n`);
  process.exitCode = 1;
});
