const FORBIDDEN_KEYS = new Set(['__proto__', 'prototype', 'constructor']);

const INPUT_LIMITS = Object.freeze({
  maxBytes: 64 * 1024,
  maxDepth: 32,
  maxNodes: 10_000,
  maxArrayLength: 2_048,
  maxObjectKeys: 2_048,
});

function rejectPrototypeKey(key) {
  if (FORBIDDEN_KEYS.has(key) || key.split('.').some((part) => FORBIDDEN_KEYS.has(part))) {
    throw new Error(`unsafe prototype key: ${key}`);
  }
}

export function assertSafeInput(value, limits = INPUT_LIMITS) {
  let encoded;
  try {
    encoded = JSON.stringify(value);
  } catch {
    throw new Error('input must be finite JSON data');
  }
  if (encoded === undefined || Buffer.byteLength(encoded, 'utf8') > limits.maxBytes) {
    throw new Error(`input exceeds ${limits.maxBytes} UTF-8 bytes`);
  }

  let nodes = 0;
  const visit = (current, depth) => {
    nodes += 1;
    if (nodes > limits.maxNodes) throw new Error('input contains too many values');
    if (depth > limits.maxDepth) throw new Error('input nesting is too deep');
    if (current === null) return;
    if (typeof current === 'number' && !Number.isFinite(current)) {
      throw new Error('input contains a non-finite number');
    }
    if (['undefined', 'function', 'symbol', 'bigint'].includes(typeof current)) {
      throw new Error(`input contains unsupported ${typeof current} data`);
    }
    if (typeof current !== 'object') return;
    if (Array.isArray(current)) {
      if (current.length > limits.maxArrayLength) throw new Error('input array is too large');
      for (const item of current) visit(item, depth + 1);
      return;
    }
    const keys = Object.keys(current);
    if (keys.length > limits.maxObjectKeys) throw new Error('input object has too many keys');
    for (const key of keys) {
      rejectPrototypeKey(key);
      visit(current[key], depth + 1);
    }
  };
  visit(value, 0);
  return value;
}

export function assertSafeDottedKey(key) {
  if (typeof key !== 'string' || key.length === 0 || Buffer.byteLength(key, 'utf8') > 512) {
    throw new Error('config key must be a bounded non-empty string');
  }
  for (const part of key.split('.')) {
    if (!part) throw new Error('config key contains an empty segment');
    rejectPrototypeKey(part);
  }
  return key;
}
