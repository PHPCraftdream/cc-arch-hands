import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmdirSync,
  unlinkSync,
  writeFileSync,
  readFileSync,
  symlinkSync,
  lstatSync,
} from 'node:fs';
import { spawn } from 'node:child_process';
import { Worker } from 'node:worker_threads';
import { join, dirname, basename } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { isNewerVersion, getLatestVersion, CURRENT_VERSION } from '../lib/update-check.js';
import { writeFileAtomic } from '../lib/fsutil.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

function waitForPath(path, timeoutMs = 5000) {
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

async function resolveWithin(promise, timeoutMs, label) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} exceeded ${timeoutMs}ms`)), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function runUpdateWorker(cachePath, nowMs, fetchSpecPath, env = {}) {
  const updateCheckUrl = new URL('../lib/update-check.js', import.meta.url).href;
  const source = `
    const { parentPort, workerData } = require('node:worker_threads');
    (async () => {
      process.env.CAH_TEST_ONLY = '1';
      process.env.CAH_TEST_ONLY_UPDATE_FETCH = workerData.fetchSpecPath;
      for (const [key, value] of Object.entries(workerData.env)) process.env[key] = value;
      const { getLatestVersion } = await import(workerData.updateCheckUrl);
      const result = getLatestVersion(workerData.cachePath, workerData.ttlMs, workerData.nowMs);
      parentPort.postMessage(result);
    })().catch((error) => {
      setImmediate(() => { throw error; });
    });
  `;
  return new Promise((resolve, reject) => {
    const worker = new Worker(source, {
      eval: true,
      workerData: {
        cachePath,
        fetchSpecPath,
        nowMs,
        ttlMs: 10_000,
        updateCheckUrl,
        env,
      },
    });
    worker.once('message', resolve);
    worker.once('error', reject);
    worker.once('exit', (code) => {
      if (code !== 0) reject(new Error(`update-check worker exited with code ${code}`));
    });
  });
}

describe('isNewerVersion', () => {
  it('true when latest has a higher major/minor/patch', () => {
    assert.equal(isNewerVersion('0.5.2', '0.5.3'), true);
    assert.equal(isNewerVersion('0.5.2', '0.6.0'), true);
    assert.equal(isNewerVersion('0.5.2', '1.0.0'), true);
  });

  it('false when equal or older', () => {
    assert.equal(isNewerVersion('0.5.2', '0.5.2'), false);
    assert.equal(isNewerVersion('0.5.2', '0.5.1'), false);
    assert.equal(isNewerVersion('1.0.0', '0.9.9'), false);
  });

  it('false on malformed or missing input (fail safe — no false positive)', () => {
    assert.equal(isNewerVersion('0.5.2', 'not-a-version'), false);
    assert.equal(isNewerVersion(null, '0.5.3'), false);
    assert.equal(isNewerVersion('0.5.2', undefined), false);
    assert.equal(isNewerVersion('0.5.2', null), false);
  });
});

describe('getLatestVersion caching', () => {
  function isolatedCachePath() {
    const dir = mkdtempSync(join(tmpdir(), 'cah-update-check-'));
    return join(dir, 'update-check.json');
  }

  function makeSymlinkOrSkip(t, linkPath, targetPath) {
    try {
      symlinkSync(targetPath, linkPath, 'file');
      return true;
    } catch (e) {
      if (process.platform === 'win32' && (e.code === 'EPERM' || e.code === 'EACCES')) {
        t.skip('symbolic links are unavailable on this Windows runner');
        return false;
      }
      throw e;
    }
  }

  it('returns the cached value directly when within the TTL window (no network call)', () => {
    const cachePath = isolatedCachePath();
    const now = 1_000_000;
    writeFileSync(cachePath, JSON.stringify({ latestVersion: '9.9.9', checkedAt: now }));
    const result = getLatestVersion(cachePath, 24 * 60 * 60 * 1000, now + 1000);
    assert.equal(result, '9.9.9');
  });

  it('does not overwrite a pre-existing foreign .tmp file while refreshing', () => {
    const cachePath = isolatedCachePath();
    const tempPath = `${cachePath}.tmp`;
    const foreignTemp = '{"foreign":true}\n';
    writeFileSync(tempPath, foreignTemp);
    writeFileSync(cachePath, JSON.stringify({ latestVersion: '8.8.8', checkedAt: 0 }));
    const now = Date.now();

    const result = getLatestVersion(cachePath, 24 * 60 * 60 * 1000, now);

    assert.equal(readFileSync(tempPath, 'utf8'), foreignTemp);
    const published = JSON.parse(readFileSync(cachePath, 'utf8'));
    assert.equal(published.checkedAt, now);
    assert.equal(published.latestVersion, result);
  });

  it('does not follow a pre-existing .tmp symlink while refreshing JSON', (t) => {
    const cachePath = isolatedCachePath();
    const tempPath = `${cachePath}.tmp`;
    const victimPath = `${cachePath}.victim`;
    const victim = '{"victim":"untouched"}\n';
    writeFileSync(victimPath, victim);
    writeFileSync(cachePath, JSON.stringify({ latestVersion: '8.8.8', checkedAt: 0 }));
    if (!makeSymlinkOrSkip(t, tempPath, victimPath)) return;
    const now = Date.now();

    const result = getLatestVersion(cachePath, 24 * 60 * 60 * 1000, now);

    assert.equal(lstatSync(tempPath).isSymbolicLink(), true);
    assert.equal(readFileSync(tempPath, 'utf8'), victim);
    assert.equal(readFileSync(victimPath, 'utf8'), victim);
    const published = JSON.parse(readFileSync(cachePath, 'utf8'));
    assert.equal(published.checkedAt, now);
    assert.equal(published.latestVersion, result);
  });

  it('returns null on a cold cache read (missing file, no crash)', () => {
    const cachePath = join(tmpdir(), 'cah-update-check-missing-dir', 'nonexistent.json');
    // Do not assert on the fetch outcome (network-dependent) — only that a
    // stale/missing cache is read as "no cached value" rather than throwing.
    const cached = (() => {
      try {
        return JSON.parse(readFileSync(cachePath, 'utf8'));
      } catch {
        return null;
      }
    })();
    assert.equal(cached, null);
  });

  it('serializes stale refreshes: a slow failed fetch consumes the TTL once', async () => {
    const cachePath = isolatedCachePath();
    const dir = dirname(cachePath);
    const now = 2_000_000;
    writeFileSync(cachePath, JSON.stringify({ latestVersion: '8.8.8', checkedAt: 0 }));
    const slowSpec = join(dir, 'slow-fetch.json');
    const slowReady = join(dir, 'slow.ready');
    const slowGo = join(dir, 'slow.go');
    const waiterSpec = join(dir, 'waiter-fetch.json');
    const waiterFetched = join(dir, 'waiter.fetched');
    writeFileSync(slowSpec, JSON.stringify({ readyPath: slowReady, goPath: slowGo, result: null }));
    writeFileSync(waiterSpec, JSON.stringify({ readyPath: waiterFetched, result: '9.9.9' }));

    const slow = runUpdateWorker(cachePath, now, slowSpec);
    await waitForPath(slowReady);
    const waiterStartedAt = Date.now();
    const waiter = runUpdateWorker(cachePath, now, waiterSpec);
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(existsSync(waiterFetched), false, 'the waiter must not stampede into fetch');

    const waiterResult = await resolveWithin(waiter, 2_000, 'live-owner waiter');
    assert.ok(Date.now() - waiterStartedAt < 2_000, 'live-owner waiter must return promptly');
    assert.equal(waiterResult, '8.8.8');
    assert.equal(existsSync(waiterFetched), false);
    writeFileSync(slowGo, 'go\n');

    assert.equal(await slow, '8.8.8');
    assert.equal(existsSync(waiterFetched), false);
    assert.deepEqual(JSON.parse(readFileSync(cachePath, 'utf8')), {
      latestVersion: '8.8.8',
      checkedAt: now,
    });
  });

  it('keeps a successful publisher when a concurrent slow fetch fails', async () => {
    const cachePath = isolatedCachePath();
    const dir = dirname(cachePath);
    const now = 3_000_000;
    writeFileSync(cachePath, JSON.stringify({ latestVersion: '8.8.8', checkedAt: 0 }));
    const successSpec = join(dir, 'success-fetch.json');
    const successReady = join(dir, 'success.ready');
    const successGo = join(dir, 'success.go');
    const slowSpec = join(dir, 'slow-failed-fetch.json');
    const slowStarted = join(dir, 'slow-failed.started');
    writeFileSync(successSpec, JSON.stringify({
      readyPath: successReady,
      goPath: successGo,
      result: '9.9.9',
    }));
    writeFileSync(slowSpec, JSON.stringify({ readyPath: slowStarted, result: null }));

    const successfulPublisher = runUpdateWorker(cachePath, now, successSpec);
    await waitForPath(successReady);
    const waiterStartedAt = Date.now();
    const slowFailedFetcher = runUpdateWorker(cachePath, now, slowSpec);
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(existsSync(slowStarted), false, 'the failed fetch must wait behind the publisher');

    const waiterResult = await resolveWithin(slowFailedFetcher, 2_000, 'live-owner waiter');
    assert.ok(Date.now() - waiterStartedAt < 2_000, 'live-owner waiter must return promptly');
    assert.equal(waiterResult, '8.8.8');
    assert.equal(existsSync(slowStarted), false);
    writeFileSync(successGo, 'go\n');

    assert.equal(await successfulPublisher, '9.9.9');
    assert.equal(existsSync(slowStarted), false);

    const laterSpec = join(dir, 'later-fetch.json');
    const laterFetched = join(dir, 'later.fetched');
    writeFileSync(laterSpec, JSON.stringify({ readyPath: laterFetched, result: '10.10.10' }));
    assert.equal(await runUpdateWorker(cachePath, now + 1, laterSpec), '9.9.9');
    assert.equal(existsSync(laterFetched), false, 'a later call must use the published cache');
    assert.deepEqual(JSON.parse(readFileSync(cachePath, 'utf8')), {
      latestVersion: '9.9.9',
      checkedAt: now,
    });
  });

  it('does not publish a failed fetch over a fresher success', async () => {
    const cachePath = isolatedCachePath();
    const dir = dirname(cachePath);
    const now = 4_000_000;
    writeFileSync(cachePath, JSON.stringify({ latestVersion: '8.8.8', checkedAt: 0 }));
    const slowSpec = join(dir, 'slow-fetch.json');
    const slowReady = join(dir, 'slow.ready');
    const slowGo = join(dir, 'slow.go');
    writeFileSync(slowSpec, JSON.stringify({ readyPath: slowReady, goPath: slowGo, result: null }));

    const slow = runUpdateWorker(cachePath, now, slowSpec);
    await waitForPath(slowReady);
    writeFileAtomic(cachePath, JSON.stringify({ latestVersion: '9.9.9', checkedAt: now + 1 }) + '\n');
    writeFileSync(slowGo, 'go\n');

    assert.equal(await slow, '9.9.9');
    assert.deepEqual(JSON.parse(readFileSync(cachePath, 'utf8')), {
      latestVersion: '9.9.9',
      checkedAt: now + 1,
    });
  });

  it('recovers a refresh lock left by a crashed process', async () => {
    const cachePath = isolatedCachePath();
    const dir = dirname(cachePath);
    const now = 5_000_000;
    writeFileSync(cachePath, JSON.stringify({ latestVersion: '8.8.8', checkedAt: 0 }));

    const crashed = spawn(process.execPath, ['-e', ''], { stdio: 'ignore' });
    const deadPid = crashed.pid;
    await new Promise((resolve, reject) => {
      crashed.once('error', reject);
      crashed.once('exit', resolve);
    });
    const lockPath = `${cachePath}.lock`;
    mkdirSync(lockPath);
    writeFileSync(join(lockPath, 'owner.json'), JSON.stringify({
      kind: 'cc-arch-hands-update-check',
      pid: deadPid,
      token: 'crashed-owner',
      startedAt: Date.now() - 60_000,
    }));

    const fetchSpec = join(dir, 'recovery-fetch.json');
    writeFileSync(fetchSpec, JSON.stringify({ result: '9.9.9' }));
    assert.equal(await runUpdateWorker(cachePath, now, fetchSpec), '9.9.9');
    assert.equal(existsSync(lockPath), false);
  });

  it('reclaims a lock past the absolute lease even when its PID is live', async () => {
    const cachePath = isolatedCachePath();
    const dir = dirname(cachePath);
    const now = 6_000_000;
    writeFileSync(cachePath, JSON.stringify({ latestVersion: '8.8.8', checkedAt: 0 }));
    const lockPath = `${cachePath}.lock`;
    mkdirSync(lockPath);
    writeFileSync(join(lockPath, 'owner.json'), JSON.stringify({
      kind: 'cc-arch-hands-update-check',
      pid: process.pid,
      token: 'reused-pid-owner',
      startedAt: Date.now() - 6 * 60 * 1000,
    }));
    const fetchSpec = join(dir, 'lease-fetch.json');
    writeFileSync(fetchSpec, JSON.stringify({ result: '9.9.9' }));

    assert.equal(await runUpdateWorker(cachePath, now, fetchSpec), '9.9.9');
    assert.equal(existsSync(lockPath), false);
  });

  it('recovers an abandoned fence without displacing its live owner', async () => {
    const cachePath = isolatedCachePath();
    const dir = dirname(cachePath);
    const now = 6_500_000;
    writeFileSync(cachePath, JSON.stringify({ latestVersion: '8.8.8', checkedAt: 0 }));
    const lockPath = `${cachePath}.lock`;
    const fencePath = `${lockPath}.stale-99999999-abandoned-fence`;
    mkdirSync(fencePath);
    writeFileSync(join(fencePath, 'owner.json'), JSON.stringify({
      kind: 'cc-arch-hands-update-check',
      pid: process.pid,
      token: 'restored-b',
      startedAt: Date.now(),
    }));
    const fetchSpec = join(dir, 'abandoned-fence-fetch.json');
    const fetched = join(dir, 'abandoned-fence.fetched');
    writeFileSync(fetchSpec, JSON.stringify({ readyPath: fetched, result: '9.9.9' }));

    assert.equal(await runUpdateWorker(cachePath, now, fetchSpec), '8.8.8');
    assert.equal(existsSync(fencePath), false);
    assert.deepEqual(JSON.parse(readFileSync(join(lockPath, 'owner.json'), 'utf8')).token, 'restored-b');
    assert.equal(existsSync(fetched), false);
  });

  it('quarantines unexpected abandoned fence contents once and reacquires safely', async () => {
    const cachePath = isolatedCachePath();
    const dir = dirname(cachePath);
    const now = 6_750_000;
    writeFileSync(cachePath, JSON.stringify({ latestVersion: '8.8.8', checkedAt: 0 }));
    const lockPath = `${cachePath}.lock`;
    const fencePath = `${lockPath}.stale-99999999-unexpected-fence`;
    mkdirSync(fencePath);
    writeFileSync(join(fencePath, 'owner.json'), JSON.stringify({
      kind: 'cc-arch-hands-update-check',
      pid: process.pid,
      token: 'preserved-owner',
      startedAt: Date.now(),
    }));
    writeFileSync(join(fencePath, 'foreign-data.txt'), 'preserve me\n');
    const fetchSpec = join(dir, 'unexpected-fence-fetch.json');
    writeFileSync(fetchSpec, JSON.stringify({ result: '9.9.9' }));

    assert.equal(await runUpdateWorker(cachePath, now, fetchSpec), '9.9.9');
    const quarantineDir = join(dir, '.cah-lease-quarantine');
    const quarantined = join(quarantineDir, basename(fencePath));
    assert.equal(existsSync(fencePath), false);
    assert.equal(readFileSync(join(quarantined, 'foreign-data.txt'), 'utf8'), 'preserve me\n');
    assert.deepEqual(readdirSync(quarantineDir), [basename(fencePath)]);

    // Force a second refresh. The prior quarantine must not be rediscovered
    // as an active fence or trigger another suffixed quarantine.
    writeFileSync(cachePath, JSON.stringify({ latestVersion: '8.8.8', checkedAt: 0 }));
    assert.equal(await runUpdateWorker(cachePath, now + 1, fetchSpec), '9.9.9');
    assert.deepEqual(readdirSync(quarantineDir), [basename(fencePath)]);
  });

  it('fences a stale A/live B/contender C reclaim race', async () => {
    const cachePath = isolatedCachePath();
    const dir = dirname(cachePath);
    const now = 7_000_000;
    writeFileSync(cachePath, JSON.stringify({ latestVersion: '8.8.8', checkedAt: 0 }));
    const lockPath = `${cachePath}.lock`;
    mkdirSync(lockPath);
    writeFileSync(join(lockPath, 'owner.json'), JSON.stringify({
      kind: 'cc-arch-hands-update-check',
      pid: 99999999,
      token: 'stale-a',
      startedAt: Date.now() - 60_000,
    }));
    const aSpec = join(dir, 'reclaimer-fetch.json');
    const cSpec = join(dir, 'contender-fetch.json');
    const cFetched = join(dir, 'contender.fetched');
    writeFileSync(aSpec, JSON.stringify({ result: '9.9.9' }));
    writeFileSync(cSpec, JSON.stringify({ readyPath: cFetched, result: '10.10.10' }));
    const interlock = join(dir, 'reclaim-three-party-interlock');
    const reclaimer = runUpdateWorker(cachePath, now, aSpec, {
      CAH_TEST_ONLY_UPDATE_LOCK_INTERLOCK: interlock,
      CAH_TEST_ONLY_UPDATE_LOCK_INTERLOCK_PHASE: 'reclaim-three-party',
    });

    await waitForPath(`${interlock}.before.ready`);
    unlinkSync(join(lockPath, 'owner.json'));
    rmdirSync(lockPath);
    mkdirSync(lockPath);
    writeFileSync(join(lockPath, 'owner.json'), JSON.stringify({
      kind: 'cc-arch-hands-update-check',
      pid: process.pid,
      token: 'live-b',
      startedAt: Date.now(),
    }));
    writeFileSync(`${interlock}.before.go`, 'go');
    await waitForPath(`${interlock}.vacancy.ready`);

    assert.equal(await resolveWithin(
      runUpdateWorker(cachePath, now, cSpec),
      1_000,
      'fenced contender C',
    ), '8.8.8');
    assert.equal(existsSync(cFetched), false, 'C must not fetch while B is fenced');
    writeFileSync(`${interlock}.vacancy.go`, 'go');

    assert.equal(await reclaimer, '8.8.8');
    assert.deepEqual(JSON.parse(readFileSync(join(lockPath, 'owner.json'), 'utf8')), {
      kind: 'cc-arch-hands-update-check',
      pid: process.pid,
      token: 'live-b',
      startedAt: JSON.parse(readFileSync(join(lockPath, 'owner.json'), 'utf8')).startedAt,
    });
    assert.equal(readdirSync(dir).some((name) => name.startsWith('update-check.json.lock.stale-')), false);
  });

  it('does not overwrite a concurrent cache winner after the final reread', async () => {
    const cachePath = isolatedCachePath();
    const dir = dirname(cachePath);
    const now = 8_000_000;
    writeFileSync(cachePath, JSON.stringify({ latestVersion: '8.8.8', checkedAt: 0 }));
    const fetchSpec = join(dir, 'cas-fetch.json');
    writeFileSync(fetchSpec, JSON.stringify({ result: '9.9.9' }));
    const interlock = join(dir, 'cas-publication-interlock');
    const publisher = runUpdateWorker(cachePath, now, fetchSpec, {
      CAH_TEST_ONLY_FSUTIL_INTERLOCK: interlock,
      CAH_TEST_ONLY_FSUTIL_INTERLOCK_PHASE: 'write-before-rename',
    });
    await waitForPath(`${interlock}.ready`);
    writeFileAtomic(cachePath, JSON.stringify({ latestVersion: '10.10.10', checkedAt: now + 1 }) + '\n');
    writeFileSync(`${interlock}.go`, 'go');

    assert.equal(await publisher, '10.10.10');
    assert.deepEqual(JSON.parse(readFileSync(cachePath, 'utf8')), {
      latestVersion: '10.10.10',
      checkedAt: now + 1,
    });
  });
});

describe('CURRENT_VERSION', () => {
  it('stays in sync with package.json — bump both together on release', () => {
    const pkg = JSON.parse(readFileSync(join(__dirname, '..', 'package.json'), 'utf8'));
    assert.equal(CURRENT_VERSION, pkg.version);
  });
});
