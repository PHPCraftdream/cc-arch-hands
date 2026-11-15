import { afterEach } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { Worker } from 'node:worker_threads';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { runWorker } from './process-batches.js';

const scratchDirs = new Set();

afterEach(() => {
  for (const dir of scratchDirs) rmSync(dir, { recursive: true, force: true });
  scratchDirs.clear();
});

// A scratch directory, removed after the test that asked for it.
export function isolatedDir() {
  const dir = mkdtempSync(join(tmpdir(), 'cah-ts-'));
  scratchDirs.add(dir);
  return dir;
}

export { waitForPath } from './process-batches.js';

export function runRateCacheWorker(cachePath, nowMs, interlock) {
  const transcriptStatsUrl = new URL('../lib/transcript-stats.js', import.meta.url).href;
  const hooksUrl = new URL('./interlocks.js', import.meta.url).href;
  const source = `
    const { parentPort, workerData } = require('node:worker_threads');
    (async () => {
      process.env.CAH_TEST_ONLY = '1';
      const { makeInterlock } = await import(workerData.hooksUrl);
      const testInterlock = makeInterlock({ ...process.env,
        CAH_TEST_ONLY_FSUTIL_INTERLOCK: workerData.interlock,
        CAH_TEST_ONLY_FSUTIL_INTERLOCK_PHASE: 'prune-rate-context-before-remove',
      });
      const { persistRateLimitsCache } = await import(workerData.transcriptStatsUrl);
      persistRateLimitsCache(workerData.cachePath, null, null, null, null, 'cleanup', workerData.nowMs,
        { testInterlock });
      parentPort.postMessage('done');
    })().catch((error) => {
      setImmediate(() => { throw error; });
    });
  `;
  const worker = new Worker(source, {
    eval: true,
    workerData: { cachePath, interlock, nowMs, transcriptStatsUrl, hooksUrl },
  });
  return runWorker(worker, { label: 'rate-cache worker' });
}
