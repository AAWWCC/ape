import { INPUT_LIMITS } from './input-guard.js';

// Admission producers and archive readers must agree on how much repository
// evidence a supported run can carry. This is a path inspection budget, not
// the smaller collection limit used by public diagnostic projections.
export const MAX_ADMISSION_CHANGED_PATHS = 2_048;

// Shared live-state/immutable-observer serialized-size ceiling. Collection counts
// are validated within this budget; public summaries have smaller display caps.
export const RUNTIME_STATE_MAX_BYTES = 8 * 1024 * 1024;

// An ingress receipt is nested at state.receipts[index]; a retained preflight
// artifact is nested at state.preflight.artifact. Both add exactly two object/
// array levels to an independently validated input. Preserve that full input
// contract when inspecting the enclosing state instead of subtracting wrappers
// from the caller's depth allowance.
export const RUNTIME_STATE_MAX_DEPTH = INPUT_LIMITS.maxDepth + 2;
