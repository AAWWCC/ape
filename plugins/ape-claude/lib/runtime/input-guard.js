const FORBIDDEN_KEYS = new Set(['__proto__', 'prototype', 'constructor']);

export const GENERAL_INPUT_MAX_BYTES = 64 * 1024;
// A preflight artifact alone can occupy the entire ordinary input allowance.
// Retain that artifact contract and reserve the existing allowance again for
// the receipt's identity, observations and recovery metadata. This exception
// is only for receipt ingress; ordinary control/configuration input stays small.
export const RECEIPT_INPUT_MAX_BYTES = GENERAL_INPUT_MAX_BYTES * 2;
// Durable tool requests retain the receipt plus the ordinary control envelope.
export const TASK_REQUEST_MAX_BYTES = RECEIPT_INPUT_MAX_BYTES + GENERAL_INPUT_MAX_BYTES;

export const INPUT_LIMITS = Object.freeze({
  maxBytes: GENERAL_INPUT_MAX_BYTES,
  maxDepth: 32,
  maxNodes: 10_000,
  maxArrayLength: 2_048,
  maxObjectKeys: 2_048,
});
const RECEIPT_INPUT_LIMITS = Object.freeze({ ...INPUT_LIMITS, maxBytes: RECEIPT_INPUT_MAX_BYTES });

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

export function assertSafeReceiptInput(value) {
  return assertSafeInput(value, RECEIPT_INPUT_LIMITS);
}

export function assertSafeReceiptRecoveryInput(receipt, recovery) {
  // Recovery must accept the same exact draft as validation and recording.
  // Charge control metadata and JSON wrapping to the ordinary input allowance
  // instead of subtracting them from the receipt allowance. Each independently
  // retains the prototype, depth, node and collection checks; the combined
  // durable task request remains subject to TASK_REQUEST_MAX_BYTES.
  assertSafeReceiptInput(receipt);
  assertSafeInput({ receipt: null, recovery });
  return { receipt, recovery };
}
