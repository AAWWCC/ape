import { RUNTIME_VERSION } from './constants.js';

// Release provenance is durable run content. Keep this literal in parity with
// package.json: unlike a best-effort package.json read at archive time, a
// literal survives bundling, relocation, and a missing package manifest. The
// release parity suite makes a forgotten bump fail loudly.
export const APE_VERSION = '2.23.5';

// The Codex launch envelope is a versioned runtime/host contract. These values
// are shared by the adapter that emits the envelope and the run/history
// telemetry that records which contract governed the run.
export const CODEX_DISPATCH_PROTOCOL_VERSION = 'ape-codex-dispatch-v2';
export const CODEX_DISPATCH_ENVELOPE_VERSION = 2;

export const VERSION_PROVENANCE_FIELDS = Object.freeze([
  'ape_version',
  'runtime_version',
  'host_plugin_version',
  'protocol_version',
  'envelope_version',
]);

const SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]{1,32})?(?:\+[0-9A-Za-z.-]{1,32})?$/;
const DISPATCH_PROTOCOL = /^ape-[a-z0-9]+(?:-[a-z0-9]+)*-v[1-9]\d{0,5}$/;

export function isApeVersion(value) {
  return typeof value === 'string' && value.length <= 80 && SEMVER.test(value);
}

export function isRuntimeVersion(value) {
  return Number.isInteger(value) && value > 0 && value <= 1_000_000;
}

export function isDispatchProtocolVersion(value) {
  return typeof value === 'string' && value.length <= 80 && DISPATCH_PROTOCOL.test(value);
}

export function isDispatchEnvelopeVersion(value) {
  return Number.isInteger(value) && value > 0 && value <= 1_000_000;
}

// Copy provenance across a trust boundary only as a complete, bounded base
// cohort. Protocol/envelope provenance is an atomic pair: retaining only one
// would describe a launch contract that never actually existed.
export function validatedVersionProvenance(value) {
  if (
    !value
    || typeof value !== 'object'
    || Array.isArray(value)
    || !isApeVersion(value.ape_version)
    || !isRuntimeVersion(value.runtime_version)
  ) return {};
  const output = {
    ape_version: value.ape_version,
    runtime_version: value.runtime_version,
    ...(isApeVersion(value.host_plugin_version)
      ? { host_plugin_version: value.host_plugin_version }
      : {}),
  };
  const versionedDispatch = isDispatchProtocolVersion(value.protocol_version)
    && isDispatchEnvelopeVersion(value.envelope_version);
  return {
    ...output,
    ...(versionedDispatch
      ? {
          protocol_version: value.protocol_version,
          envelope_version: value.envelope_version,
        }
      : {}),
  };
}

export function runVersionProvenance(host) {
  return {
    ape_version: APE_VERSION,
    runtime_version: RUNTIME_VERSION,
    // Both supported host packages are built from, and versioned with, this
    // public checkout. Persist the package version separately so cohorts stay
    // explicit if the runtime and host package ever acquire independent
    // release cadences.
    host_plugin_version: APE_VERSION,
    ...(host === 'codex'
      ? {
          protocol_version: CODEX_DISPATCH_PROTOCOL_VERSION,
          envelope_version: CODEX_DISPATCH_ENVELOPE_VERSION,
        }
      : {}),
  };
}
