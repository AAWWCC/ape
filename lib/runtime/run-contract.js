import path from 'node:path';
import {
  RECEIPT_MAX_PHYSICAL_WORKERS_PER_TICKET,
  RECEIPT_MAX_SUBMISSIONS_PER_WORKER,
} from './constants.js';
import { capabilityDynamicTestPathBounds } from './capability-contract.js';
import { sha256 } from './canonical.js';
import {
  PLAN_CONTRACT_MAX_BYTES,
  PREFLIGHT_ARTIFACT_MAX_BYTES,
} from './plan-contract.js';
import { atomicWriteJson, readJson } from './storage.js';

export const RUN_CONTRACT_VERSION = 1;

// These values are themselves part of the immutable run contract. Keep the
// object construction here so START and ticket issuance cannot silently bind
// different operational ceilings.
export function runContractFieldBounds({ include_dynamic_test_paths = true } = {}) {
  return {
    validation_attempts_per_worker: RECEIPT_MAX_SUBMISSIONS_PER_WORKER,
    max_physical_workers_per_ticket: RECEIPT_MAX_PHYSICAL_WORKERS_PER_TICKET,
    corrections_per_validation: 20,
    ...(include_dynamic_test_paths
      ? { dynamic_test_paths: capabilityDynamicTestPathBounds() }
      : {}),
  };
}

export function runContractByteBudgets() {
  return {
    candidate_plan_utf8_bytes: PLAN_CONTRACT_MAX_BYTES,
    preflight_artifact_utf8_bytes: PREFLIGHT_ARTIFACT_MAX_BYTES,
    mcp_projection_utf8_bytes: 48_000,
  };
}

function manifestRef(hash) {
  return `.ape/runtime/contracts/${hash}.json`;
}

function receiptSchemaRef(hash) {
  return `.ape/runtime/contracts/schemas/${hash}.json`;
}

function pointerFor(manifest) {
  const hash = sha256(manifest);
  return {
    version: RUN_CONTRACT_VERSION,
    revision: manifest.revision,
    ref: manifestRef(hash),
    hash,
  };
}

function assertPointer(pointer) {
  if (
    pointer?.version !== RUN_CONTRACT_VERSION ||
    !Number.isInteger(pointer.revision) ||
    pointer.revision < 1 ||
    !/^[0-9a-f]{64}$/.test(pointer.hash ?? '') ||
    pointer.ref !== manifestRef(pointer.hash)
  ) {
    throw new Error('invalid run-contract manifest pointer');
  }
}

async function writeContentAddressedManifest(paths, manifest) {
  const pointer = pointerFor(manifest);
  const file = path.join(paths.contracts, `${pointer.hash}.json`);
  const existing = await readJson(file, null);
  if (existing !== null) {
    if (sha256(existing) !== pointer.hash) {
      throw new Error(`run-contract content-address collision at ${pointer.ref}`);
    }
    return pointer;
  }
  await atomicWriteJson(file, manifest);
  return pointer;
}

async function writeContentAddressedReceiptSchema(paths, schema, expectedHash) {
  const hash = sha256(schema);
  if (hash !== expectedHash) {
    throw new Error('ticket receipt schema conflicts with its immutable schema hash');
  }
  const ref = receiptSchemaRef(hash);
  const file = path.join(paths.root, ref);
  const existing = await readJson(file, null);
  if (existing !== null) {
    if (sha256(existing) !== hash) {
      throw new Error(`receipt-schema content-address collision at ${ref}`);
    }
    return { ref, hash };
  }
  await atomicWriteJson(file, schema);
  return { ref, hash };
}

export async function readRunContractManifest(paths, pointer) {
  assertPointer(pointer);
  const manifest = await readJson(path.join(paths.contracts, `${pointer.hash}.json`));
  if (
    sha256(manifest) !== pointer.hash ||
    manifest?.version !== RUN_CONTRACT_VERSION ||
    manifest?.revision !== pointer.revision
  ) {
    throw new Error(`run-contract manifest does not match ${pointer.ref}`);
  }
  return manifest;
}

function capabilityCatalog(state) {
  const snapshot = state.capability_snapshot;
  return {
    ...(snapshot.manifest_growth_contract_version === 1
      ? {
          manifest_growth_contract_version: 1,
          manifest_roles: [...(snapshot.manifest_roles ?? [])],
          lane_policy: structuredClone(snapshot.lane_policy ?? {}),
        }
      : {}),
    evidence_scripts: structuredClone(snapshot.evidence_scripts ?? []),
    command_profiles: structuredClone(snapshot.command_profiles ?? []),
    verification_profiles: structuredClone(snapshot.verification_profiles ?? []),
    runners: structuredClone(snapshot.runners ?? []),
    test_commands: structuredClone(snapshot.test_commands ?? {}),
    tool_claims: [...(state.tool_claims ?? [])],
  };
}

/**
 * Starts the immutable chain only for runs admitted under the native
 * capability/receipt contract. Legacy and pre-upgrade state stays untouched.
 */
export async function initializeRunContractManifest(paths, state, at = state.created_at) {
  if (
    state.capability_snapshot?.version !== 1 ||
    state.binding_protocol !== 'native-v1' ||
    typeof state.capability_snapshot.config_hash !== 'string'
  ) return null;
  if (state.run_contract) {
    await readRunContractManifest(paths, state.run_contract);
    return state.run_contract;
  }

  const catalog = capabilityCatalog(state);
  const manifest = {
    version: RUN_CONTRACT_VERSION,
    revision: 1,
    previous: null,
    run_id: state.run_id,
    config_hash: state.capability_snapshot.config_hash,
    objective_hash: sha256(state.objective),
    preflight_hash: state.preflight?.artifact_hash ?? null,
    required_capabilities: structuredClone(
      state.capability_snapshot.required_capabilities ?? [],
    ),
    capability_catalog_hash: sha256(catalog),
    capability_catalog: catalog,
    receipt_contract: {
      version: 1,
      field_bounds: runContractFieldBounds(),
      byte_budgets: runContractByteBudgets(),
      ticket_contracts: [],
    },
    created_at: at,
    updated_at: at,
  };
  const pointer = await writeContentAddressedManifest(paths, manifest);
  state.run_contract = pointer;
  return pointer;
}

/**
 * Seals a newly accepted preflight artifact even when the run must pause for
 * operator questions and therefore issues no successor ticket yet.
 */
export async function appendPreflightRunContract(paths, state, at = state.updated_at) {
  if (!state.run_contract || typeof state.preflight?.artifact_hash !== 'string') return null;
  const previousPointer = structuredClone(state.run_contract);
  const previous = await readRunContractManifest(paths, previousPointer);
  const preflightHash = state.preflight.artifact_hash;
  if (previous.preflight_hash === preflightHash) return previousPointer;
  if (previous.preflight_hash !== null) {
    throw new Error('accepted preflight conflicts with the immutable run contract');
  }
  const manifest = {
    ...structuredClone(previous),
    revision: previous.revision + 1,
    previous: previousPointer,
    preflight_hash: preflightHash,
    updated_at: at,
  };
  const pointer = await writeContentAddressedManifest(paths, manifest);
  state.run_contract = pointer;
  return pointer;
}

function ticketRoleView(ticket, capabilityManifest) {
  return {
    required_capabilities: structuredClone(capabilityManifest.required_capabilities),
    allowed_evidence_commands: [...capabilityManifest.allowed_evidence_commands],
    command_profiles: structuredClone(capabilityManifest.command_profiles),
    ...(Array.isArray(capabilityManifest.planning_required_capabilities)
      ? {
          planning_required_capabilities: structuredClone(
            capabilityManifest.planning_required_capabilities,
          ),
        }
      : {}),
    ...(Array.isArray(capabilityManifest.plannable_evidence_commands)
      ? {
          plannable_evidence_commands: [
            ...capabilityManifest.plannable_evidence_commands,
          ],
        }
      : {}),
    ...(Array.isArray(capabilityManifest.planning_command_profiles)
      ? {
          planning_command_profiles: structuredClone(
            capabilityManifest.planning_command_profiles,
          ),
        }
      : {}),
    verification_profiles: structuredClone(capabilityManifest.verification_profiles),
    field_bounds: structuredClone(capabilityManifest.field_bounds),
    byte_budgets: structuredClone(capabilityManifest.byte_budgets),
  };
}

/**
 * Appends a ticket's exact role-filtered receipt contract to the chain. The
 * returned pointer is then sealed into the ticket, so one content hash binds
 * the run catalog, preflight, schema identity, allowlists, and all bounds.
 */
export async function appendTicketRunContract(
  paths,
  state,
  ticket,
  capabilityManifest,
  at = ticket.issued_at,
) {
  if (!capabilityManifest || !state.run_contract) return null;
  const previousPointer = structuredClone(state.run_contract);
  const previous = await readRunContractManifest(paths, previousPointer);
  if (
    previous.run_id !== state.run_id ||
    previous.config_hash !== capabilityManifest.config_hash ||
    previous.objective_hash !== capabilityManifest.objective_hash
  ) {
    throw new Error('ticket capability view conflicts with the immutable run contract');
  }
  const roleView = ticketRoleView(ticket, capabilityManifest);
  const receiptSchema = await writeContentAddressedReceiptSchema(
    paths,
    ticket.output_schema,
    capabilityManifest.receipt_schema.hash,
  );
  const ticketContract = {
    ticket_id: ticket.ticket_id,
    stage_id: ticket.stage_id,
    role: ticket.role,
    receipt_contract_version: ticket.receipt_contract_version,
    receipt_schema: {
      ...receiptSchema,
      ticket_ref: capabilityManifest.receipt_schema.ref,
    },
    role_view_hash: sha256(roleView),
    role_view: roleView,
  };
  const priorTickets = previous.receipt_contract?.ticket_contracts ?? [];
  if (priorTickets.some((entry) => entry.ticket_id === ticket.ticket_id)) {
    throw new Error(`run-contract already binds ticket ${ticket.ticket_id}`);
  }
  const manifest = {
    ...structuredClone(previous),
    revision: previous.revision + 1,
    previous: previousPointer,
    preflight_hash: capabilityManifest.preflight_hash,
    receipt_contract: {
      ...structuredClone(previous.receipt_contract),
      ticket_contracts: [...structuredClone(priorTickets), ticketContract],
    },
    updated_at: at,
  };
  const pointer = await writeContentAddressedManifest(paths, manifest);
  state.run_contract = pointer;
  return pointer;
}

/**
 * A successor ticket can be durable before the state write that follows it.
 * Recovery adopts that ticket's already-validated manifest pointer instead of
 * appending another semantic successor and duplicating side effects.
 */
export async function adoptRunContractPointer(paths, state, pointer) {
  if (!pointer) return state.run_contract ?? null;
  const manifest = await readRunContractManifest(paths, pointer);
  if (manifest.run_id !== state.run_id) {
    throw new Error('durable ticket references a run-contract manifest for another run');
  }
  const current = state.run_contract;
  if (
    current &&
    pointer.revision === current.revision &&
    pointer.hash !== current.hash
  ) {
    throw new Error('durable ticket references a conflicting run-contract revision');
  }
  if (!current || pointer.revision >= current.revision) state.run_contract = structuredClone(pointer);
  return state.run_contract;
}
