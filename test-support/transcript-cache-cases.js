import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  existsSync,
  mkdirSync,
  lstatSync,
  readFileSync,
  readdirSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';

import {
  readRateLimitsCache,
  persistRateLimitsCache,
  rateLimitsContextPath,
} from '../lib/transcript-stats.js';
import { writeFileAtomic } from '../lib/fsutil.js';
import {
  isolatedDir,
  runRateCacheWorker,
  waitForPath,
} from './transcript-test-helpers.js';

// ---------------------------------------------------------------------------
// readRateLimitsCache
// ---------------------------------------------------------------------------

describe('readRateLimitsCache', () => {
  it('returns null when file missing', () => {
    const dir = isolatedDir();
    assert.equal(readRateLimitsCache(join(dir, 'nope.json')), null);
  });

  it('returns null on malformed JSON', () => {
    const dir = isolatedDir();
    const path = join(dir, 'rl.json');
    writeFileSync(path, '{not json');
    assert.equal(readRateLimitsCache(path), null);
  });

  it('returns null when capturedAt missing', () => {
    const dir = isolatedDir();
    const path = join(dir, 'rl.json');
    writeFileSync(path, JSON.stringify({ fiveHour: { used: 1, resetsAt: null } }));
    assert.equal(readRateLimitsCache(path), null);
  });

  it('returns null when older than 1h', () => {
    const dir = isolatedDir();
    const path = join(dir, 'rl.json');
    const oldMs = 1_700_000_000_000;
    writeFileSync(path, JSON.stringify({
      fiveHour: { used: 10, resetsAt: null },
      sevenDay: null,
      capturedAt: oldMs,
    }));
    assert.equal(readRateLimitsCache(path, oldMs + 60 * 60 * 1000 + 1), null);
  });

  it('returns slots when fresh', () => {
    const dir = isolatedDir();
    const path = join(dir, 'rl.json');
    const t = 1_700_000_000_000;
    writeFileSync(path, JSON.stringify({
      fiveHour: { used: 10, resetsAt: '2024-06-01T14:30:00Z' },
      sevenDay: { used: 50, resetsAt: '2024-06-05T03:00:00Z' },
      capturedAt: t,
    }));
    const got = readRateLimitsCache(path, t + 60 * 1000);
    assert.deepEqual(got, {
      fiveHour: { used: 10, resetsAt: '2024-06-01T14:30:00Z' },
      sevenDay: { used: 50, resetsAt: '2024-06-05T03:00:00Z' },
      effort: null,
      contextWindowSize: null,
    });
  });

  it('reads effort field when present in cache', () => {
    const dir = isolatedDir();
    const path = join(dir, 'rl.json');
    const t = 1_700_000_000_000;
    writeFileSync(path, JSON.stringify({
      fiveHour: { used: 10, resetsAt: '2024-06-01T14:30:00Z' },
      sevenDay: null,
      effort: 'max',
      capturedAt: t,
    }));
    const got = readRateLimitsCache(path, t);
    assert.equal(got.effort, 'max');
  });

  it('returns global rates while rejecting another session context', () => {
    const dir = isolatedDir();
    const path = join(dir, 'rl.json');
    const t = 1_700_000_000_000;
    writeFileSync(path, JSON.stringify({
      sessionId: 'session-a',
      contextWindowSize: 1_000_000,
      fiveHour: { used: 10, resetsAt: null },
      capturedAt: t,
    }));
    assert.equal(readRateLimitsCache(path, t, 'session-a').contextWindowSize, 1_000_000);
    const other = readRateLimitsCache(path, t, 'session-b');
    assert.equal(other.contextWindowSize, null);
    assert.equal(other.fiveHour.used, 10);
  });

  it('publishes the cache without following a legacy predictable temp symlink', (t) => {
    const dir = isolatedDir();
    const path = join(dir, 'rate-limits.json');
    const victim = join(dir, 'victim.txt');
    const fixedNow = 1_700_000_123_456;
    const predictable = `${path}.${process.pid}.${fixedNow}.1.tmp`;
    writeFileSync(victim, 'victim stays intact\n');
    try {
      symlinkSync(victim, predictable, 'file');
    } catch (e) {
      if (process.platform === 'win32' && ['EPERM', 'EACCES'].includes(e.code)) {
        t.skip('file symlink creation is unavailable in this Windows test environment');
        return;
      }
      throw e;
    }

    const realDateNow = Date.now;
    try {
      let legacyTimestampPending = true;
      Date.now = () => {
        if (legacyTimestampPending) {
          legacyTimestampPending = false;
          return fixedNow;
        }
        return realDateNow();
      };
      persistRateLimitsCache(
        path,
        { used: 17, resetsAt: null },
        null,
        null,
        null,
        'symlink-session',
        fixedNow,
      );
    } finally {
      Date.now = realDateNow;
    }

    assert.equal(readFileSync(victim, 'utf8'), 'victim stays intact\n');
    assert.ok(lstatSync(predictable).isSymbolicLink(), 'foreign temp symlink must remain a symlink');
    assert.equal(readFileSync(predictable, 'utf8'), 'victim stays intact\n');
    assert.equal(JSON.parse(readFileSync(path, 'utf8')).fiveHour.used, 17);
  });

  it('publishes the cache without replacing legacy predictable foreign temps', () => {
    const dir = isolatedDir();
    const path = join(dir, 'rate-limits.json');
    const fixedNow = 1_700_000_234_567;
    // Cover both possible legacy counters depending on whether the preceding
    // symlink test was skipped on a platform without symlink privileges.
    const predictable = [1, 2].map((counter) =>
      `${path}.${process.pid}.${fixedNow}.${counter}.tmp`);
    for (const temp of predictable) writeFileSync(temp, `foreign:${temp}\n`);

    const realDateNow = Date.now;
    try {
      let legacyTimestampPending = true;
      Date.now = () => {
        if (legacyTimestampPending) {
          legacyTimestampPending = false;
          return fixedNow;
        }
        return realDateNow();
      };
      persistRateLimitsCache(
        path,
        { used: 23, resetsAt: null },
        null,
        null,
        null,
        'foreign-temp-session',
        fixedNow,
      );
    } finally {
      Date.now = realDateNow;
    }

    for (const temp of predictable) {
      assert.equal(readFileSync(temp, 'utf8'), `foreign:${temp}\n`);
    }
    assert.equal(JSON.parse(readFileSync(path, 'utf8')).fiveHour.used, 23);
  });

  it('persists session contexts in hashed sidecars without cross-session loss', () => {
    const dir = isolatedDir();
    const path = join(dir, 'rate-limits.json');
    const t = 1_700_000_000_000;
    const sessionA = `../${'a'.repeat(400)}`;
    const sessionB = `../${'b'.repeat(400)}`;
    persistRateLimitsCache(path, { used: 10, resetsAt: null }, { used: 50, resetsAt: null }, null, 1_000_000, sessionA, t);
    persistRateLimitsCache(path, null, null, null, 200_000, sessionB, t + 1);

    const a = readRateLimitsCache(path, t + 1, sessionA);
    const b = readRateLimitsCache(path, t + 1, sessionB);
    assert.equal(a.contextWindowSize, 1_000_000);
    assert.equal(b.contextWindowSize, 200_000);
    assert.equal(b.fiveHour.used, 10);
    assert.match(rateLimitsContextPath(path, sessionA), /[\\/]rate-context[\\/][a-f0-9]{64}\.json$/);
    assert.notEqual(rateLimitsContextPath(path, sessionA), rateLimitsContextPath(path, sessionB));
    assert.doesNotMatch(rateLimitsContextPath(path, sessionA), /\.\.\/|a{20}/);
  });

  it('directly migrates the current legacy sidecar and keeps the newer collision', () => {
    const dir = isolatedDir();
    const path = join(dir, 'rate-limits.json');
    const session = 'legacy-current-session';
    const hash = createHash('sha256').update(`string:${session}`).digest('hex');
    const legacy = `${path}.context-${hash}.json`;
    const target = rateLimitsContextPath(path, session);
    mkdirSync(join(dir, 'rate-context'), { recursive: true });

    writeFileSync(legacy, JSON.stringify({
      version: 1, contextWindowSize: 1_000_000, capturedAt: 200,
    }));
    writeFileSync(target, JSON.stringify({
      version: 1, contextWindowSize: 200_000, capturedAt: 100,
    }));
    const migrated = readRateLimitsCache(path, 201, session);
    assert.equal(migrated.contextWindowSize, 1_000_000);
    assert.equal(existsSync(legacy), false, 'newer legacy state must be consumed');
    assert.equal(JSON.parse(readFileSync(target, 'utf8')).contextWindowSize, 1_000_000);

    writeFileSync(legacy, JSON.stringify({
      version: 1, contextWindowSize: 1_000_000, capturedAt: 150,
    }));
    const retained = readRateLimitsCache(path, 201, session);
    assert.equal(retained.contextWindowSize, 1_000_000);
    assert.equal(existsSync(legacy), false, 'older legacy collision must be removed safely');
    assert.equal(JSON.parse(readFileSync(target, 'utf8')).capturedAt, 200);
  });

  it('keeps unrelated cache files outside bounded rate-context maintenance', () => {
    const dir = isolatedDir();
    const path = join(dir, 'rate-limits.json');
    for (let i = 0; i < 2_000; i++) {
      writeFileSync(join(dir, `unrelated-${i}.json`), 'foreign\n');
    }

    persistRateLimitsCache(path, null, null, null, 1_000_000, 'bounded-session', Date.now());

    assert.equal(readdirSync(dir).filter((name) => name.startsWith('unrelated-')).length, 2_000);
    assert.equal(readdirSync(join(dir, 'rate-context')).length, 1);
  });

  it('caps fresh rate-context namespace entries', () => {
    const dir = isolatedDir();
    const path = join(dir, 'rate-limits.json');
    const namespace = join(dir, 'rate-context');
    const now = Date.now();
    mkdirSync(namespace, { recursive: true });
    for (let i = 0; i < 100; i++) {
      const session = `preexisting-${i}`;
      const hash = createHash('sha256').update(`string:${session}`).digest('hex');
      writeFileSync(join(namespace, `${hash}.json`), JSON.stringify({
        version: 1, contextWindowSize: 200_000, capturedAt: now,
      }));
    }

    persistRateLimitsCache(path, null, null, null, 200_000, 'capacity-session', now);

    assert.ok(readdirSync(namespace).length <= 64);
  });

  it('expires a rate slot that disappears while preserving session context', () => {
    const dir = isolatedDir();
    const path = join(dir, 'rate-limits.json');
    const first = 1_700_000_000_000;
    const refreshed = first + 60_000;

    persistRateLimitsCache(
      path,
      { used: 10, resetsAt: null },
      { used: 50, resetsAt: null },
      null,
      1_000_000,
      'session-a',
      first,
    );
    // The next status envelope still reports five_hour but no longer has a
    // seven_day slot. The missing slot must not be inherited at the refreshed
    // timestamp.
    persistRateLimitsCache(
      path,
      { used: 20, resetsAt: null },
      null,
      null,
      1_000_000,
      'session-a',
      refreshed,
    );

    assert.deepEqual(JSON.parse(readFileSync(path, 'utf8')), {
      version: 2,
      fiveHour: { used: 20, resetsAt: null },
      sevenDay: null,
      capturedAt: refreshed,
    });
    assert.deepEqual(readRateLimitsCache(path, refreshed, 'session-a'), {
      fiveHour: { used: 20, resetsAt: null },
      sevenDay: null,
      effort: null,
      contextWindowSize: 1_000_000,
    });
  });

  it('does not prune a fresh sidecar successor after the stale-file check', async () => {
    const dir = isolatedDir();
    const path = join(dir, 'rate-limits.json');
    const sidecar = rateLimitsContextPath(path, 'stale-session');
    const now = Date.now();
    const staleMtime = now - 60 * 60 * 1000 - 1000;
    persistRateLimitsCache(path, null, null, null, 200_000, 'stale-session', staleMtime);
    utimesSync(sidecar, staleMtime / 1000, staleMtime / 1000);

    const interlock = join(dir, 'prune-rate-context-interlock');
    const running = runRateCacheWorker(path, now, interlock);
    await waitForPath(`${interlock}.ready`);
    writeFileAtomic(sidecar, JSON.stringify({
      version: 1,
      contextWindowSize: 1_000_000,
      capturedAt: now,
    }) + '\n');
    writeFileSync(`${interlock}.go`, 'go\n');
    assert.equal(await running, 'done');

    assert.equal(readRateLimitsCache(path, now, 'stale-session').contextWindowSize, 1_000_000);
  });
});
