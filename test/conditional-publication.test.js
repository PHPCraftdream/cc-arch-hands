import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Worker } from 'node:worker_threads';
import { captureRegularFileSnapshot, writeFileAtomic } from '../lib/fs-atomic.js';

function waitForPath(path) {
  const deadline = Date.now() + 10_000;
  return new Promise((resolve, reject) => {
    const poll = () => {
      if (existsSync(path)) return resolve();
      if (Date.now() >= deadline) return reject(new Error(`timed out waiting for ${path}`));
      setTimeout(poll, 5);
    };
    poll();
  });
}

function runWrite(dest, interlock, payload, expected = true) {
  const fsutilUrl = new URL('../lib/fsutil.js', import.meta.url).href;
  const hooksUrl = new URL('../test-support/interlocks.js', import.meta.url).href;
  const source = `
    const { parentPort, workerData } = require('node:worker_threads');
    (async () => {
      process.env.CAH_TEST_ONLY = '1';
      const { makeInterlock } = await import(workerData.hooksUrl);
      const testInterlock = makeInterlock({ ...process.env,
        CAH_TEST_ONLY_FSUTIL_INTERLOCK: workerData.interlock,
        CAH_TEST_ONLY_FSUTIL_INTERLOCK_PHASE: 'write-before-final-publication',
      });
      const fs = await import(workerData.fsutilUrl);
      try {
        const snapshot = fs.captureRegularFileSnapshot(workerData.dest);
        const publication = fs.writeFileAtomic(workerData.dest, workerData.payload, {
          expectedDestination: workerData.expected ? snapshot.expectedDestination : { exists: false, identity: null },
          testInterlock,
        });
        parentPort.postMessage({ ok: true, publication });
      } catch (error) {
        parentPort.postMessage({ ok: false, message: error.message });
      }
    })();
  `;
  const worker = new Worker(source, {
    eval: true,
    workerData: { dest, expected, fsutilUrl, interlock, payload, hooksUrl },
  });
  return new Promise((resolve, reject) => {
    worker.once('message', resolve);
    worker.once('error', reject);
  });
}

describe('conditional atomic publication', () => {
  it('keeps the old leaf visible until atomic rename, then publishes new', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cah-conditional-'));
    const dest = join(dir, 'leaf');
    const interlock = join(dir, 'interlock');
    writeFileSync(dest, 'B\n');

    const running = runWrite(dest, interlock, 'new\n');
    await waitForPath(`${interlock}.ready`);
    assert.equal(readFileSync(dest, 'utf8'), 'B\n', 'publication must not create a canonical vacancy');
    writeFileSync(`${interlock}.go`, 'go');

    const result = await running;
    assert.equal(result.ok, true);
    assert.equal(readFileSync(dest, 'utf8'), 'new\n');
    assert.equal(readdirSync(dir).some((name) => name.startsWith('.cah-tmp-')), false);
    assert.equal(existsSync(`${dest}.cah-owned-publish`), false);
  });

  it('aborts when the expected leaf changes in place before rename', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cah-conditional-'));
    const dest = join(dir, 'leaf');
    const interlock = join(dir, 'interlock');
    writeFileSync(dest, 'B\n');

    const running = runWrite(dest, interlock, 'new\n');
    await waitForPath(`${interlock}.ready`);
    writeFileSync(dest, 'mutated old\n');
    writeFileSync(`${interlock}.go`, 'go');

    const result = await running;
    assert.equal(result.ok, false);
    assert.equal(readFileSync(dest, 'utf8'), 'mutated old\n');
  });

  it('does not overwrite C when the expected leaf was missing', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cah-conditional-'));
    const dest = join(dir, 'missing-leaf');
    const interlock = join(dir, 'interlock');

    const running = runWrite(dest, interlock, 'new\n', false);
    await waitForPath(`${interlock}.ready`);
    writeFileSync(dest, 'C\n');
    writeFileSync(`${interlock}.go`, 'go');

    const result = await running;
    assert.equal(result.ok, false);
    assert.equal(readFileSync(dest, 'utf8'), 'C\n');
  });

  it('cannot overwrite a successor that appears after the generation fence moves the old leaf', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cah-conditional-'));
    const dest = join(dir, 'leaf');
    writeFileSync(dest, 'B\n');
    const snapshot = captureRegularFileSnapshot(dest);
    let successorWritten = false;

    assert.throws(() => writeFileAtomic(dest, 'new\n', {
      expectedDestination: snapshot.expectedDestination,
      testInterlock: (phase) => {
        if (phase === 'write-before-final-rename' && !successorWritten) {
          successorWritten = true;
          writeFileSync(dest, 'C\n');
        }
      },
    }), /changed concurrently|refusing operation/);
    assert.equal(readFileSync(dest, 'utf8'), 'C\n');
    assert.equal(existsSync(`${dest}.cah-owned-publish`), false);
  });
});
