import { existsSync, mkdtempSync } from 'node:fs';
import { Worker } from 'node:worker_threads';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

export function isolatedDir() {
  return mkdtempSync(join(tmpdir(), 'cah-ts-'));
}

export function waitForPath(path, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const poll = () => {
      if (existsSync(path)) {
        resolve();
        return;
      }
      if (Date.now() >= deadline) {
        reject(new Error(`timed out waiting for ${path}`));
        return;
      }
      setTimeout(poll, 5);
    };
    poll();
  });
}

export function runRateCacheWorker(cachePath, nowMs, interlock) {
  const transcriptStatsUrl = new URL('../lib/transcript-stats.js', import.meta.url).href;
  const source = `
    const { parentPort, workerData } = require('node:worker_threads');
    (async () => {
      process.env.CAH_TEST_ONLY = '1';
      process.env.CAH_TEST_ONLY_FSUTIL_INTERLOCK = workerData.interlock;
      process.env.CAH_TEST_ONLY_FSUTIL_INTERLOCK_PHASE = 'prune-rate-context-before-remove';
      const { persistRateLimitsCache } = await import(workerData.transcriptStatsUrl);
      persistRateLimitsCache(workerData.cachePath, null, null, null, null, 'cleanup', workerData.nowMs);
      parentPort.postMessage('done');
    })().catch((error) => {
      setImmediate(() => { throw error; });
    });
  `;
  return new Promise((resolve, reject) => {
    const worker = new Worker(source, {
      eval: true,
      workerData: { cachePath, interlock, nowMs, transcriptStatsUrl },
    });
    worker.once('message', resolve);
    worker.once('error', reject);
    worker.once('exit', (code) => {
      if (code !== 0) reject(new Error(`rate-cache worker exited with code ${code}`));
    });
  });
}
