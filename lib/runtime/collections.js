// Bound parallel work while preserving input order.
export async function mapInBatches(values, batchSize, mapper) {
  const output = [];
  for (let offset = 0; offset < values.length; offset += batchSize) {
    output.push(...await Promise.all(values.slice(offset, offset + batchSize).map(mapper)));
  }
  return output;
}
