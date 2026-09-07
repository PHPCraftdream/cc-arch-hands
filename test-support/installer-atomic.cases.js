import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, writeFileSync, readFileSync, readdirSync, statSync, existsSync, symlinkSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { Worker } from 'node:worker_threads';
import { tmpDir, waitForWorker, waitForPath, runOwnedRemovalWorker, runAtomicRetryWorker } from './installer-test-helpers.js';
import { runWorker } from './process-batches.js';
import { SentinelModelCommand } from '../lib/sentinel.js';
import { enumerateRecoveryArtifacts, removeOwnedRegularFile, regularFileIdentity, sameFileIdentity, sweepRecoveryArtifacts, writeFileAtomic } from '../lib/fsutil.js';

// ---------------------------------------------------------------------------
// Atomic file writes
// ---------------------------------------------------------------------------

describe('writeFileAtomic', { concurrency: false }, () => {
  it('returns the inode identity published by the private temp', () => {
    const dir = tmpDir();
    const dest = join(dir, 'published.txt');
    const publication = writeFileAtomic(dest, 'published body\n');

    assert.equal(publication.present, true);
    assert.equal(publication.path, dest);
    assert.ok(publication.identity);
    assert.equal(typeof publication.identity.dev, 'bigint');
    assert.equal(typeof publication.identity.ino, 'bigint');
    assert.equal(typeof publication.identity.size, 'bigint');
    assert.equal(typeof publication.identity.mtimeNs, 'bigint');
    assert.equal(typeof publication.contentDigest, 'string');
    assert.equal(publication.contentBytes, Buffer.byteLength('published body\n'));
    assert.equal(sameFileIdentity(regularFileIdentity(dest), publication.identity), true);
    assert.equal(publication.expectedDestination.identity, publication.identity);
  });

  it('keeps normal umask/default modes and preserves an existing mode', (t) => {
    if (process.platform === 'win32') {
      t.skip('POSIX mode bits are not portable on Windows');
      return;
    }
    const dir = tmpDir();
    const created = join(dir, 'created.txt');
    const existing = join(dir, 'existing.txt');
    writeFileAtomic(created, 'created\n');
    assert.equal(statSync(created).mode & 0o777, 0o666 & ~process.umask());
    writeFileSync(existing, 'before\n', { mode: 0o640 });
    writeFileAtomic(existing, 'after\n');
    assert.equal(statSync(existing).mode & 0o777, 0o640);
  });

  it('applies an explicit mode to the private temp before publication', (t) => {
    if (process.platform === 'win32') {
      t.skip('POSIX mode bits are not portable on Windows');
      return;
    }
    const dir = tmpDir();
    const dest = join(dir, 'executable');
    writeFileAtomic(dest, '#!/usr/bin/env node\n', { mode: 0o755 });
    assert.equal(statSync(dest).mode & 0o777, 0o755);
  });

  it('does not follow or replace a predictable temp symlink', (t) => {
    const dir = tmpDir();
    const dest = join(dir, 'target.txt');
    const victim = join(dir, 'victim.txt');
    const predictable = `${dest}.cah-tmp`;
    writeFileSync(victim, 'outside stays intact\n');

    try {
      symlinkSync(victim, predictable, 'file');
    } catch (e) {
      if (process.platform === 'win32' && ['EPERM', 'EACCES'].includes(e.code)) {
        t.skip('file symlink creation is unavailable in this Windows test environment');
        return;
      }
      throw e;
    }

    writeFileAtomic(dest, 'complete payload\n');
    assert.equal(readFileSync(dest, 'utf8'), 'complete payload\n');
    assert.equal(readFileSync(victim, 'utf8'), 'outside stays intact\n');
    assert.equal(readFileSync(predictable, 'utf8'), 'outside stays intact\n');
  });

  it('leaves a foreign predictable temp untouched', () => {
    const dir = tmpDir();
    const dest = join(dir, 'target.txt');
    const predictable = `${dest}.cah-tmp`;
    writeFileSync(predictable, 'belongs to someone else\n');

    writeFileAtomic(dest, 'ours\n');
    assert.equal(readFileSync(dest, 'utf8'), 'ours\n');
    assert.equal(readFileSync(predictable, 'utf8'), 'belongs to someone else\n');
  });

  it('concurrent writers publish one complete payload and leave no owned temps', async () => {
    const dir = tmpDir();
    const dest = join(dir, 'shared.bin');
    const payloads = ['A', 'B', 'C', 'D'].map((byte) => Buffer.alloc(256 * 1024, byte));
    const barrier = new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT);
    const moduleUrl = new URL('../lib/fsutil.js', import.meta.url).href;
    const workerSource = `
      const { parentPort, workerData } = require('node:worker_threads');
      (async () => {
        process.env.CAH_TEST_ONLY = '1';
        const { writeFileAtomic } = await import(workerData.moduleUrl);
        const state = new Int32Array(workerData.barrier);
        Atomics.add(state, 0, 1);
        Atomics.notify(state, 0);
        while (Atomics.load(state, 0) < workerData.total) {
          const observed = Atomics.load(state, 0);
          Atomics.wait(state, 0, observed);
        }
        writeFileAtomic(workerData.dest, Buffer.from(workerData.payload));
      })().catch((error) => {
        parentPort.postMessage({ error: error.message });
      });
    `;
    const workers = payloads.map((payload) => new Worker(workerSource, {
      eval: true,
      workerData: { barrier, dest, moduleUrl, payload, total: payloads.length },
    }));

    await Promise.all(workers.map(waitForWorker));
    const result = readFileSync(dest);
    assert.ok(payloads.some((payload) => payload.equals(result)));
    assert.deepEqual(
      readdirSync(dir).filter((name) => name.includes('.cah-tmp-')),
      [],
    );
  });

  it('rejects a byte-identical successor installed immediately after rename', async () => {
    const dir = tmpDir();
    const dest = join(dir, 'successor.txt');
    const interlock = join(dir, 'after-rename-interlock');
    const payload = 'byte-identical successor\n';
    writeFileSync(dest, 'old body\n');
    const fsutilUrl = new URL('../lib/fsutil.js', import.meta.url).href;
    const hooksUrl = new URL('./interlocks.js', import.meta.url).href;
    const source = `
      const { parentPort, workerData } = require('node:worker_threads');
      (async () => {
        process.env.CAH_TEST_ONLY = '1';
        const { makeInterlock } = await import(workerData.hooksUrl);
        const testInterlock = makeInterlock({ ...process.env,
          CAH_TEST_ONLY_FSUTIL_INTERLOCK: workerData.interlock,
          CAH_TEST_ONLY_FSUTIL_INTERLOCK_PHASE: 'write-after-rename',
        });
        const fsutil = await import(workerData.fsutilUrl);
        const before = fsutil.captureRegularFileSnapshot(workerData.dest);
        try {
          fsutil.writeFileAtomic(workerData.dest, workerData.payload, {
            expectedDestination: before.expectedDestination, testInterlock,
          });
          parentPort.postMessage({ ok: true });
        } catch (error) {
          parentPort.postMessage({ ok: false, message: error.message });
        }
      })();
    `;
    const worker = new Worker(source, {
      eval: true,
      workerData: { dest, fsutilUrl, interlock, payload, hooksUrl },
    });
    const resultPromise = runWorker(worker, { label: 'successor worker' });

    await waitForPath(`${interlock}.ready`);
    unlinkSync(dest);
    writeFileSync(dest, payload);
    writeFileSync(`${interlock}.go`, 'go');
    const result = await resultPromise;
    assert.equal(result.ok, false);
    assert.match(result.message, /destination leaf changed concurrently|refusing operation/);
    assert.equal(readFileSync(dest, 'utf8'), payload);
  });

  it('rejects a mode-only successor before rename', async (t) => {
    if (process.platform === 'win32') {
      t.skip('POSIX mode bits are not portable on Windows');
      return;
    }
    const dir = tmpDir();
    const dest = join(dir, 'mode-successor.txt');
    const interlock = join(dir, 'mode-successor-interlock');
    writeFileSync(dest, 'old body\n', { mode: 0o640 });
    const fsutilUrl = new URL('../lib/fsutil.js', import.meta.url).href;
    const hooksUrl = new URL('./interlocks.js', import.meta.url).href;
    const source = `
      const { parentPort, workerData } = require('node:worker_threads');
      (async () => {
        const { makeInterlock } = await import(workerData.hooksUrl);
        const testInterlock = makeInterlock({ ...process.env,
          CAH_TEST_ONLY_FSUTIL_INTERLOCK: workerData.interlock,
          CAH_TEST_ONLY_FSUTIL_INTERLOCK_PHASE: 'write-before-final-publication',
        });
        const fsutil = await import(workerData.fsutilUrl);
        const snapshot = fsutil.captureRegularFileSnapshot(workerData.dest);
        try {
          fsutil.writeFileAtomic(workerData.dest, 'new body\\n', {
            expectedDestination: snapshot.expectedDestination, testInterlock,
          });
          parentPort.postMessage({ ok: true });
        } catch (error) {
          parentPort.postMessage({ ok: false, message: error.message });
        }
      })();
    `;
    const worker = new Worker(source, {
      eval: true,
      workerData: { dest, fsutilUrl, interlock, hooksUrl },
    });
    const resultPromise = runWorker(worker, { label: 'mode successor worker' });
    await waitForPath(`${interlock}.ready`);
    chmodSync(dest, 0o600);
    writeFileSync(`${interlock}.go`, 'go');
    const result = await resultPromise;
    assert.equal(result.ok, false);
    assert.equal(readFileSync(dest, 'utf8'), 'old body\n');
    assert.equal(statSync(dest).mode & 0o777, 0o600);
  });

  it('cleans up its unique temp when publication fails', () => {
    const dir = tmpDir();
    const dest = join(dir, 'occupied-directory');
    mkdirSync(dest);

    assert.throws(() => writeFileAtomic(dest, 'cannot publish here'));
    assert.deepEqual(
      readdirSync(dir).filter((name) => name.includes('.cah-tmp-')),
      [],
    );
  });

  it('revalidates the expected leaf after an injected transient rename failure', async () => {
    const dir = tmpDir();
    const dest = join(dir, 'retry-target.txt');
    const interlock = join(dir, 'rename-retry-interlock');
    writeFileSync(dest, 'old managed body\n');
    const running = runAtomicRetryWorker(dest, interlock);
    await waitForPath(`${interlock}.ready`);
    unlinkSync(dest);
    writeFileSync(dest, 'foreign successor\n', { mode: 0o640 });
    writeFileSync(`${interlock}.go`, 'go');
    await assert.rejects(running, /destination leaf changed concurrently|refusing operation/);
    assert.equal(readFileSync(dest, 'utf8'), 'foreign successor\n');
    if (process.platform !== 'win32') assert.equal(statSync(dest).mode & 0o777, 0o640);
  });

  it('retries transient owned-file removal without leaving quarantine', () => {
    const dir = tmpDir();
    const dest = join(dir, 'remove-target.txt');
    writeFileSync(dest, 'owned\n');
    const identity = regularFileIdentity(dest);
    const old = process.env.CAH_TEST_ONLY;
    const oldFailures = process.env.CAH_TEST_ONLY_FSUTIL_REMOVE_TRANSIENT_FAILURES;
    process.env.CAH_TEST_ONLY = '1';
    process.env.CAH_TEST_ONLY_FSUTIL_REMOVE_TRANSIENT_FAILURES = '2';
    try {
      assert.equal(removeOwnedRegularFile(dest, identity), true);
    } finally {
      if (old === undefined) delete process.env.CAH_TEST_ONLY; else process.env.CAH_TEST_ONLY = old;
      if (oldFailures === undefined) delete process.env.CAH_TEST_ONLY_FSUTIL_REMOVE_TRANSIENT_FAILURES;
      else process.env.CAH_TEST_ONLY_FSUTIL_REMOVE_TRANSIENT_FAILURES = oldFailures;
    }
    assert.ok(!existsSync(dest));
    assert.deepEqual(readdirSync(dir).filter((name) => name.includes('.cah-owned-remove-')), []);
  });

  it('releases an empty quarantine after ownership is lost following payload unlink', async () => {
    const dir = tmpDir();
    const dest = join(dir, 'lease-loss-after-unlink.txt');
    const interlock = join(dir, 'lease-loss-after-unlink-interlock');
    const ownershipLoss = join(dir, 'ownership-lost');
    writeFileSync(dest, 'owned\n');

    const running = runOwnedRemovalWorker(
      dest, interlock, 'remove-after-unlink', undefined, ownershipLoss,
    );
    await waitForPath(`${interlock}.ready`);
    writeFileSync(ownershipLoss, 'lease replaced\n');
    writeFileSync(`${interlock}.go`, 'go');

    assert.equal(await running, true);
    assert.equal(existsSync(dest), false);
    assert.equal(existsSync(`${dest}.cah-owned-remove`), false);
  });

  it('preserves a successor added to the empty quarantine reservation', async () => {
    const dir = tmpDir();
    const dest = join(dir, 'successor-after-unlink.txt');
    const interlock = join(dir, 'successor-after-unlink-interlock');
    const payload = join(`${dest}.cah-owned-remove`, 'payload');
    writeFileSync(dest, 'owned\n');

    const running = runOwnedRemovalWorker(dest, interlock, 'remove-after-unlink');
    await waitForPath(`${interlock}.ready`);
    writeFileSync(payload, 'successor data\n');
    writeFileSync(`${interlock}.go`, 'go');

    const result = await running;
    assert.equal(result.removed, false);
    assert.equal(result.preservedPath, payload);
    assert.equal(readFileSync(payload, 'utf8'), 'successor data\n');
    assert.equal(existsSync(dest), false);
  });

  it('reserves an occupied quarantine namespace before touching the canonical leaf', () => {
    const dir = tmpDir();
    const dest = join(dir, 'occupied-quarantine.txt');
    const quarantine = `${dest}.cah-owned-remove`;
    writeFileSync(dest, 'owned A\n');
    const expected = regularFileIdentity(dest);
    mkdirSync(quarantine);
    writeFileSync(join(quarantine, 'payload'), `${SentinelModelCommand}\n`);

    const result = removeOwnedRegularFile(dest, expected);
    assert.equal(result.removed, false);
    assert.equal(result.preservedPath, join(quarantine, 'payload'));
    assert.equal(readFileSync(dest, 'utf8'), 'owned A\n');
    assert.equal(readFileSync(join(quarantine, 'payload'), 'utf8'), `${SentinelModelCommand}\n`);
    assert.deepEqual(readdirSync(dir), ['occupied-quarantine.txt', 'occupied-quarantine.txt.cah-owned-remove']);
  });

  it('preserves B when B is displaced and C occupies the canonical name', async () => {
    const dir = tmpDir();
    const dest = join(dir, 'three-party-remove.txt');
    const interlock = join(dir, 'three-party-remove-interlock');
    writeFileSync(dest, 'owned A\n');

    const running = runOwnedRemovalWorker(
      dest,
      interlock,
      'remove-before-rename,remove-after-rename',
    );
    await waitForPath(`${interlock}.remove-before-rename.ready`);
    unlinkSync(dest);
    writeFileSync(dest, 'foreign B\n');
    writeFileSync(`${interlock}.remove-before-rename.go`, 'go');

    await waitForPath(`${interlock}.remove-after-rename.ready`);
    writeFileSync(dest, 'successor C\n');
    writeFileSync(`${interlock}.remove-after-rename.go`, 'go');

    const result = await running;
    assert.equal(result.removed, false);
    assert.equal(
      result.preservedPath,
      `${dest}.cah-owned-remove\\payload`,
    );
    assert.equal(readFileSync(dest, 'utf8'), 'successor C\n');
    const quarantines = readdirSync(dir).filter((name) => name.includes('.cah-owned-remove'));
    assert.equal(quarantines.length, 1);
    assert.equal(readFileSync(result.preservedPath, 'utf8'), 'foreign B\n');
  });

  it('bounds repeated three-party races to one reported quarantine without hard links', async () => {
    const dir = tmpDir();
    const dest = join(dir, 'repeated-three-party-remove.txt');
    const interlock = join(dir, 'repeated-three-party-remove-interlock');
    writeFileSync(dest, 'owned A\n');

    const running = runOwnedRemovalWorker(
      dest,
      interlock,
      'remove-before-rename,remove-after-rename',
    );
    await waitForPath(`${interlock}.remove-before-rename.ready`);
    unlinkSync(dest);
    writeFileSync(dest, 'foreign B\n');
    writeFileSync(`${interlock}.remove-before-rename.go`, 'go');
    await waitForPath(`${interlock}.remove-after-rename.ready`);
    writeFileSync(dest, 'successor C\n');
    writeFileSync(`${interlock}.remove-after-rename.go`, 'go');

    const first = await running;
    assert.equal(first.preservedPath, `${dest}.cah-owned-remove\\payload`);
    assert.equal(readFileSync(first.preservedPath, 'utf8'), 'foreign B\n');

    // Repeated reclaim attempts must refuse to move a new canonical inode
    // over the preserved slot. The same path is reported every time and B
    // remains recoverable; no hard-link restoration is involved.
    for (let attempt = 0; attempt < 3; attempt++) {
      unlinkSync(dest);
      writeFileSync(dest, `managed retry ${attempt}\n`);
      const retry = removeOwnedRegularFile(dest, regularFileIdentity(dest));
      assert.equal(retry.removed, false);
      assert.equal(retry.preservedPath, first.preservedPath);
      assert.equal(readFileSync(first.preservedPath, 'utf8'), 'foreign B\n');
      assert.equal(readFileSync(dest, 'utf8'), `managed retry ${attempt}\n`);
    }
    assert.deepEqual(
      readdirSync(dir).filter((name) => name.includes('.cah-owned-remove')),
      ['repeated-three-party-remove.txt.cah-owned-remove'],
    );
  });

  it('reports missing-canonical recovery and sweeps only proven empty/owned artifacts', () => {
    const dir = tmpDir();
    const dest = join(dir, 'crashed.txt');
    const quarantine = `${dest}.cah-owned-remove`;
    const publication = `${dest}.cah-owned-publish`;
    const temp = join(dir, '.cah-tmp-crashed-owned');
    const foreignTemp = join(dir, '.cah-tmp-user-data');
    mkdirSync(quarantine);
    writeFileSync(join(quarantine, 'payload'), 'displaced data\n');
    mkdirSync(publication);
    writeFileSync(temp, 'owned temp\n');
    writeFileSync(foreignTemp, 'user data\n');

    const artifacts = enumerateRecoveryArtifacts(dir);
    const displaced = artifacts.find((entry) => entry.path === join(quarantine, 'payload'));
    assert.ok(displaced);
    assert.equal(displaced.canonicalPresent, false);
    assert.equal(displaced.displacedData, true);

    const swept = sweepRecoveryArtifacts(dir, {
      ownedPublicationPaths: [publication],
      ownedTempPaths: [temp],
    });
    assert.ok(swept.swept.includes(temp));
    assert.ok(!existsSync(temp));
    assert.ok(existsSync(foreignTemp), 'unproven temp data must survive');
    assert.ok(existsSync(join(quarantine, 'payload')));
    assert.ok(!existsSync(publication), 'empty publication namespace is bounded cleanup');
  });

  it('does not let more than 128 abandoned temps hide a recovery payload', () => {
    const dir = tmpDir();
    const quarantine = join(dir, 'missing.txt.cah-owned-remove');
    mkdirSync(quarantine);
    writeFileSync(join(quarantine, 'payload'), 'must remain recoverable\n');
    for (let i = 0; i < 129; i++) {
      writeFileSync(join(dir, `.cah-tmp-noise-${String(i).padStart(3, '0')}`), 'noise\n');
    }

    const artifacts = enumerateRecoveryArtifacts(dir);
    const payload = join(quarantine, 'payload');
    assert.ok(artifacts.some((artifact) => artifact.path === payload));
    const maintenance = sweepRecoveryArtifacts(dir);
    assert.ok(maintenance.preserved.includes(payload));
    assert.equal(readFileSync(payload, 'utf8'), 'must remain recoverable\n');
  });
});
