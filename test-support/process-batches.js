// Keep process races broad while bounding OS child-process fan-out.
export async function runConcurrentBatches(count, task, batchSize = 6) {
  if (!Number.isSafeInteger(count) || count < 1
      || !Number.isSafeInteger(batchSize) || batchSize < 1) {
    throw new TypeError('runConcurrentBatches requires positive integer limits');
  }
  const results = [];
  for (let start = 0; start < count; start += batchSize) {
    const end = Math.min(start + batchSize, count);
    const batch = [];
    for (let index = start; index < end; index += 1) batch.push(task(index));
    results.push(...await Promise.all(batch));
  }
  return results;
}
