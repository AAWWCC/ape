import { createHash } from 'node:crypto';
import { Buffer } from 'node:buffer';

const MAX_BYTES = 256 * 1024;
const MAX_DEPTH = 32;
const MAX_ENTRIES = 10_000;
const DOMAIN = 'APE certification protection policy v1\n';
const REPOSITORY = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}\/[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$/u;
// '*' denotes an actual array element, not a provider object key. Exact segment
// encoding prevents an unknown key containing '/' from imitating a known path.
const SET_PATHS = new Set([
  ['branch_rules'],
  ...['contexts', 'checks'].map((key) => ['classic_protection', 'required_status_checks', key]),
  ...['users', 'teams', 'apps'].flatMap((key) => [
    ['classic_protection', 'restrictions', key],
    ['classic_protection', 'required_pull_request_reviews', 'dismissal_restrictions', key],
    ['classic_protection', 'required_pull_request_reviews', 'bypass_pull_request_allowances', key],
  ]),
].map((segments) => JSON.stringify(segments)));
const RULE_CHECKS_PATH = JSON.stringify(['branch_rules', '*', 'parameters', 'required_status_checks']);

function reject() {
  throw new Error('certification protection policy must be a valid bounded version-1 GitHub observation');
}

function exactKeys(value, keys) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).length === keys.length
    && keys.every((key) => Object.hasOwn(value, key));
}

// JSON.parse accepts duplicate keys by discarding the earlier value. Evidence
// cannot use that lossy interpretation. Parsed-valid JSON makes this bounded
// string/container scanner sufficient; escaped key spellings compare decoded.
function inspectContainers(raw) {
  const stack = [];
  const tokens = /"(?:[^"\\]|\\.)*"|[{}\[\]]/gu;
  let token;
  while ((token = tokens.exec(raw)) !== null) {
    const value = token[0];
    if (value === '{' || value === '[') {
      stack.push(value === '{' ? new Set() : null);
      if (stack.length > MAX_DEPTH) reject();
    } else if (value === '}' || value === ']') stack.pop();
    else if (/^\s*:/u.test(raw.slice(tokens.lastIndex))) {
      const keys = stack.at(-1);
      const key = JSON.parse(value);
      if (!keys || keys.has(key)) reject();
      keys.add(key);
    }
  }
}

/**
 * Hash a retained observation, not external truth. Accept only raw JSON text:
 * {version:1,target:{origin,repository,base},classic_protection:object|null,
 * branch_rules:array}. No provider fields are projected away. Only SET_PATHS
 * arrays sort canonical elements, retaining duplicates; all others retain order.
 * Object keys use JS UTF-16 lexical ordering; strings/numbers use JSON.stringify.
 * Target spelling is retained. UTF-8 hash input is DOMAIN + compact JSON, no LF.
 * Limits include the envelope: 256KiB, 32 containers deep, 10000 value nodes.
 * No I/O or mutation. Callers retain the original observations outside the ledger.
 * @param {string} rawJson
 * @returns {string}
 */
export function certificationProtectionPolicyDigest(rawJson) {
  if (typeof rawJson !== 'string' || Buffer.byteLength(rawJson, 'utf8') > MAX_BYTES) reject();
  let observation;
  try { observation = JSON.parse(rawJson); } catch { reject(); }
  inspectContainers(rawJson);
  if (!exactKeys(observation, ['version', 'target', 'classic_protection', 'branch_rules'])
      || observation.version !== 1
      || !exactKeys(observation.target, ['origin', 'repository', 'base'])) reject();
  const { origin, repository, base } = observation.target;
  const originMatch = typeof origin === 'string' && origin.length <= 512
    && /^(?:https:\/\/github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+?)(?:\.git)?$/u.exec(origin);
  if (!originMatch || typeof repository !== 'string' || !REPOSITORY.test(repository)
      || !REPOSITORY.test(originMatch[1])
      || originMatch[1].toLowerCase() !== repository.toLowerCase() || base !== 'main') reject();
  const classic = observation.classic_protection;
  if ((classic !== null && (typeof classic !== 'object' || Array.isArray(classic)))
      || !Array.isArray(observation.branch_rules)
      || (classic === null && observation.branch_rules.length === 0)) reject();
  let entries = 0;
  function canonical(value, segments = [], ruleType = undefined) {
    if (++entries > MAX_ENTRIES) reject();
    if (typeof value === 'number'
        && (!Number.isFinite(value) || (Number.isInteger(value) && !Number.isSafeInteger(value)))) reject();
    if (Array.isArray(value)) {
      const elements = value.map((item) => canonical(item, [...segments, '*'],
        segments.length === 1 && segments[0] === 'branch_rules' ? item?.type : ruleType));
      const location = JSON.stringify(segments);
      if (SET_PATHS.has(location) || (location === RULE_CHECKS_PATH && ruleType === 'required_status_checks')) elements.sort();
      return `[${elements.join(',')}]`;
    }
    if (value !== null && typeof value === 'object') {
      return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key], [...segments, key], ruleType)}`).join(',')}}`;
    }
    return JSON.stringify(value);
  }
  return createHash('sha256').update(DOMAIN, 'utf8').update(canonical(observation), 'utf8').digest('hex');
}
