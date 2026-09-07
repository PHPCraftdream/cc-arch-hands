import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { Worker } from 'node:worker_threads';
import { runConcurrentBatches, runWorker } from '../test-support/process-batches.js';

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

  it('does not settle a worker from its message before termination', async () => {
    const worker = new Worker(`
      const { parentPort } = require('node:worker_threads');
      parentPort.postMessage('ready');
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
    `, { eval: true });
    await assert.rejects(
      runWorker(worker, { label: 'message-hung worker', timeoutMs: 25, graceMs: 10 }),
      (error) => error?.code === 'ETIMEDOUT',
    );
  });
});
