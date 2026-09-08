import { readJson } from './storage.js';

// Requirement IDs are opaque strings, including Object.prototype names.
// Restore a safe dictionary after every JSON parse, not just on first use.
export async function readRequirementIndex(paths) {
  const index = await readJson(paths.requirementIndex, { schema_version: '2.0.0', requirements: {} });
  if (!index || typeof index !== 'object' || Array.isArray(index) ||
      (index.requirements !== undefined &&
        (!index.requirements || typeof index.requirements !== 'object' || Array.isArray(index.requirements)))) {
    throw new Error('requirement index must contain a requirements object');
  }
  return { ...index, requirements: Object.assign(Object.create(null), index.requirements ?? {}) };
}
