import { createHash } from 'node:crypto';

function normalize(value) {
  if (Array.isArray(value)) return value.map(normalize);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .filter((key) => value[key] !== undefined)
        .map((key) => [key, normalize(value[key])]),
    );
  }
  return value;
}

export function canonicalJson(value) {
  return JSON.stringify(normalize(value));
}

// WARNING — deliberate domain collision on the string fast-path: a string is
// hashed as its raw bytes while every structured value is hashed as its
// canonical JSON encoding, so the string domain and the structured domain
// collide whenever a string IS a canonical JSON encoding —
// sha256('[1]') === sha256([1]) by design. Callers must never mix string and
// structured values in one comparison space.
export function sha256(value) {
  const bytes = typeof value === 'string' ? value : canonicalJson(value);
  return createHash('sha256').update(bytes).digest('hex');
}

export function hashRecord(value, omittedFields = ['hash']) {
  const copy = { ...value };
  for (const field of omittedFields) delete copy[field];
  return sha256(copy);
}
