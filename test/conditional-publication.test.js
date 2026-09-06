import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync,
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

  it('recovers a proof fence left after the atomic replacement boundary', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cah-conditional-recovery-'));
    const dest = join(dir, 'leaf');
    writeFileSync(dest, 'old\n');
    const before = captureRegularFileSnapshot(dest);

    assert.throws(() => writeFileAtomic(dest, 'new\n', {
      expectedDestination: before.expectedDestination,
      testInterlock: (phase) => {
        if (phase === 'write-after-final-rename') throw new Error('simulated crash');
      },
    }), /simulated crash/);
    assert.equal(readFileSync(dest, 'utf8'), 'new\n');
    assert.ok(existsSync(`${dest}.cah-owned-publish`));

    const successorBefore = captureRegularFileSnapshot(dest);
    writeFileAtomic(dest, 'successor\n', { expectedDestination: successorBefore.expectedDestination });
    assert.equal(readFileSync(dest, 'utf8'), 'successor\n');
    assert.equal(existsSync(`${dest}.cah-owned-publish`), false);
  });

  it('reclaims an occupied proof-write fence before a successor publishes', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cah-conditional-fence-'));
    const dest = join(dir, 'leaf');
    writeFileSync(dest, 'old\n');
    mkdirSync(`${dest}.cah-owned-publish`);
    writeFileSync(`${dest}.cah-owned-publish/publication.json.tmp`, '{"partial":');

    const before = captureRegularFileSnapshot(dest);
    writeFileAtomic(dest, 'successor\n', { expectedDestination: before.expectedDestination });
    assert.equal(readFileSync(dest, 'utf8'), 'successor\n');
    assert.equal(existsSync(`${dest}.cah-owned-publish`), false);
  });

  it('selects the complete abandoned proof when proof replacement crashed', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cah-conditional-two-proof-'));
    const dest = join(dir, 'leaf');
    writeFileSync(dest, 'old\n');
    const before = captureRegularFileSnapshot(dest);

    assert.throws(() => writeFileAtomic(dest, 'new\n', {
      expectedDestination: before.expectedDestination,
      testInterlock: (phase) => {
        if (phase === 'write-after-final-rename') throw new Error('simulated crash');
      },
    }), /simulated crash/);

    const fence = `${dest}.cah-owned-publish`;
    const proofPath = join(fence, 'publication.json');
    const abandoned = JSON.parse(readFileSync(proofPath, 'utf8'));
    abandoned.ownerState = 'abandoned';
    abandoned.createdAtMs = 0;
    abandoned.updatedAtMs = 1;
    writeFileSync(join(fence, 'publication.json.tmp'), `${JSON.stringify(abandoned)}\n`);

    const successor = captureRegularFileSnapshot(dest);
    writeFileAtomic(dest, 'successor\n', { expectedDestination: successor.expectedDestination });
    assert.equal(readFileSync(dest, 'utf8'), 'successor\n');
    assert.equal(existsSync(fence), false);
  });

  it('recovers a canonical proof beside a partial proof staging file', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cah-conditional-partial-proof-'));
    const dest = join(dir, 'leaf');
    writeFileSync(dest, 'old\n');
    const before = captureRegularFileSnapshot(dest);

    assert.throws(() => writeFileAtomic(dest, 'new\n', {
      expectedDestination: before.expectedDestination,
      testInterlock: (phase) => {
        if (phase === 'write-after-final-rename') throw new Error('simulated crash');
      },
    }), /simulated crash/);

    const fence = `${dest}.cah-owned-publish`;
    writeFileSync(join(fence, 'publication.json.tmp'), '{"partial":');

    const successor = captureRegularFileSnapshot(dest);
    writeFileAtomic(dest, 'successor\n', { expectedDestination: successor.expectedDestination });
    assert.equal(readFileSync(dest, 'utf8'), 'successor\n');
    assert.equal(existsSync(fence), false);
  });

  it('lets a verified lifecycle successor recover a live-PID publication', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cah-conditional-generation-'));
    const dest = join(dir, 'leaf');
    const leasePath = join(dir, 'lifecycle.lock');
    mkdirSync(leasePath);
    writeFileSync(join(leasePath, 'owner.json'), JSON.stringify({
      pid: process.pid, token: 'old-token', generation: 'old-generation',
    }));
    writeFileSync(dest, 'old\n');
    const before = captureRegularFileSnapshot(dest);

    assert.throws(() => writeFileAtomic(dest, 'new\n', {
      expectedDestination: before.expectedDestination,
      lifecycleLease: { path: leasePath, token: 'old-token', generation: 'old-generation' },
      testInterlock: (phase) => {
        if (phase === 'write-after-final-rename') throw new Error('simulated crash');
      },
    }), /simulated crash/);

    writeFileSync(join(leasePath, 'owner.json'), JSON.stringify({
      pid: process.pid, token: 'new-token', generation: 'new-generation',
    }));
    const successor = captureRegularFileSnapshot(dest);
    writeFileAtomic(dest, 'successor\n', {
      expectedDestination: successor.expectedDestination,
      lifecycleLease: { path: leasePath, token: 'new-token', generation: 'new-generation' },
    });
    assert.equal(readFileSync(dest, 'utf8'), 'successor\n');
    assert.equal(existsSync(`${dest}.cah-owned-publish`), false);
  });
});
