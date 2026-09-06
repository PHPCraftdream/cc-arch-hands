import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { runConcurrentBatches } from '../test-support/process-batches.js';

describe('test process lifecycle helpers', () => {
  it('aborts a timed-out batch task and waits for its close-confirmed cleanup', async () => {
    let cleaned = false;
    await assert.rejects(
      runConcurrentBatches(1, (_, { signal }) => new Promise((resolve) => {
        signal.addEventListener('abort', () => {
          setTimeout(() => {
            cleaned = true;
            resolve('closed');
          }, 25);
        }, { once: true });
      }), 1, 5),
      (error) => error?.code === 'ETIMEDOUT',
    );
    assert.equal(cleaned, true);
  });
});
