import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, readdirSync, existsSync, utimesSync, mkdirSync, unlinkSync, rmdirSync, symlinkSync, lstatSync } from 'node:fs';
import { join, dirname, basename } from 'node:path';
import { tmpdir, homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { runStamp, runStampAsync, isolatedDir, writeTranscript, updateMarkerDir, waitForPath, writeClaim, readClaim, stampSidecarPath } from './stamp-helpers.js';

export function registerStampUpdateCases() {
  describe('update notice', () => {
    function freshUpdateCache(dir, latestVersion) {
      const p = join(dir, 'update-check.json');
      writeFileSync(p, JSON.stringify({ latestVersion, checkedAt: Date.now() }));
      return p;
    }

    it('Stop event + newer version cached → appends the notice once', () => {
      const dir = isolatedDir();
      const tp = writeTranscript(dir, 'claude-opus-4-7', 1000);
      const updateCache = freshUpdateCache(dir, '99.0.0');
      const hintHome = mkdtempSync(join(tmpdir(), 'cah-stamp-hinthome-'));
      const payload = { session_id: 'update-session', transcript_path: tp, hook_event_name: 'Stop' };
      const env = { CAH_UPDATE_CHECK_CACHE: updateCache, CAH_STAMP_HINT_HOME: hintHome };

      const first = runStamp(payload, env);
      const firstParsed = JSON.parse(first.stdout.trim());
      assert.match(firstParsed.systemMessage, /99\.0\.0/);
      assert.match(firstParsed.systemMessage, /npx cah reinstall/);

      // Second Stop in the same session (distinct throttle path so it isn't
      // suppressed by the time/requestId dedup) must NOT repeat the notice.
      const second = runStamp(
        { ...payload, transcript_path: writeTranscript(dir, 'claude-opus-4-7', 2000) },
        { ...env, CAH_STAMP_THROTTLE_PATH: join(tmpdir(), `cah-stamp-throttle-2nd-${process.pid}.json`) },
      );
      const secondParsed = JSON.parse(second.stdout.trim());
      assert.ok(!secondParsed.systemMessage.includes('99.0.0'), 'notice repeated in same session');
    });

    it('migrates a legacy update marker into the cache without duplicating delivery', () => {
      const dir = isolatedDir();
      const tp = writeTranscript(dir, 'claude-opus-4-7', 1000);
      const updateCache = freshUpdateCache(dir, '99.0.0');
      const hintHome = mkdtempSync(join(tmpdir(), 'cah-stamp-hinthome-'));
      const sessionId = 'legacy-update-marker';
      const hash = createHash('sha256').update(`string:${sessionId}`, 'utf8').digest('hex');
      const legacyDir = join(hintHome, '.claude');
      mkdirSync(legacyDir, { recursive: true });
      writeFileSync(join(legacyDir, `cah-update-shown-${hash}`), 'legacy');
      const result = runStamp(
        { session_id: sessionId, transcript_path: tp, hook_event_name: 'Stop' },
        {
          CAH_UPDATE_CHECK_CACHE: updateCache,
          CAH_STAMP_HINT_HOME: hintHome,
          CAH_STAMP_THROTTLE_PATH: join(dir, 'legacy-update-throttle.json'),
        },
      );
      assert.doesNotMatch(result.stdout, /99\.0\.0/);
      assert.equal(existsSync(join(legacyDir, `cah-update-shown-${hash}`)), false);
      assert.equal(existsSync(join(updateMarkerDir(hintHome), `cah-update-shown-${hash}`)), true);
    });

    it('migrates a raw legacy update marker for the current session into the hashed cache', () => {
      const dir = isolatedDir();
      const tp = writeTranscript(dir, 'claude-opus-4-7', 1000);
      const updateCache = freshUpdateCache(dir, '99.0.0');
      const hintHome = mkdtempSync(join(tmpdir(), 'cah-stamp-hinthome-'));
      const sessionId = '550e8400-e29b-41d4-a716-446655440000';
      const legacyDir = join(hintHome, '.claude');
      mkdirSync(legacyDir, { recursive: true });
      const legacy = join(legacyDir, `cah-update-shown-${sessionId}`);
      writeFileSync(legacy, 'legacy');
      const hash = createHash('sha256').update(`string:${sessionId}`, 'utf8').digest('hex');
      const result = runStamp(
        { session_id: sessionId, transcript_path: tp, hook_event_name: 'Stop' },
        {
          CAH_UPDATE_CHECK_CACHE: updateCache,
          CAH_STAMP_HINT_HOME: hintHome,
          CAH_STAMP_THROTTLE_PATH: join(dir, 'raw-update-throttle.json'),
        },
      );
      assert.doesNotMatch(result.stdout, /99\.0\.0/);
      assert.equal(existsSync(legacy), false);
      assert.equal(existsSync(join(updateMarkerDir(hintHome), `cah-update-shown-${hash}`)), true);
    });

    it('ignores a legacy update marker symlink and preserves stale unknown raw entries', (t) => {
      const dir = isolatedDir();
      const tp = writeTranscript(dir, 'claude-opus-4-7', 1000);
      const updateCache = freshUpdateCache(dir, '99.0.0');
      const hintHome = mkdtempSync(join(tmpdir(), 'cah-stamp-hinthome-'));
      const legacyDir = join(hintHome, '.claude');
      mkdirSync(legacyDir, { recursive: true });
      const target = join(hintHome, 'target-marker');
      const symlink = join(legacyDir, 'cah-update-shown-symlink-session');
      const stale = join(legacyDir, 'cah-update-shown-raw-uuid-not-a-64-hex-suffix');
      writeFileSync(target, 'target');
      writeFileSync(stale, 'stale');
      const old = Date.now() / 1000 - 30 * 24 * 60 * 60;
      utimesSync(stale, old, old);
      try {
        symlinkSync(target, symlink, 'file');
      } catch (error) {
        if (error && ['EPERM', 'EACCES', 'UNKNOWN'].includes(error.code)) {
          t.skip('file symlinks are unavailable on this host');
          return;
        }
        throw error;
      }
      const result = runStamp(
        { session_id: `../escape/${'x'.repeat(400)}`, transcript_path: tp, hook_event_name: 'Stop' },
        {
          CAH_UPDATE_CHECK_CACHE: updateCache,
          CAH_STAMP_HINT_HOME: hintHome,
          CAH_STAMP_THROTTLE_PATH: join(dir, 'raw-update-sweep-throttle.json'),
        },
      );
      assert.match(result.stdout, /99\.0\.0/);
      assert.equal(lstatSync(symlink).isSymbolicLink(), true);
      assert.equal(existsSync(stale), true);
      assert.equal(existsSync(join(hintHome, 'escape')), false);
    });

    it('PostToolUse event → never appends the notice, even with a newer version cached', () => {
      const dir = isolatedDir();
      const tp = writeTranscript(dir, 'claude-opus-4-7', 1000);
      const updateCache = freshUpdateCache(dir, '99.0.0');
      const hintHome = mkdtempSync(join(tmpdir(), 'cah-stamp-hinthome-'));
      const { stdout } = runStamp(
        { session_id: 'tool-session', transcript_path: tp, hook_event_name: 'PostToolUse' },
        { CAH_UPDATE_CHECK_CACHE: updateCache, CAH_STAMP_HINT_HOME: hintHome },
      );
      const parsed = JSON.parse(stdout.trim());
      assert.ok(!parsed.systemMessage.includes('99.0.0'));
    });

    it('hashes untrusted update-marker session IDs and keeps marker cleanup bounded', () => {
      const dir = isolatedDir();
      const tp = writeTranscript(dir, 'claude-opus-4-7', 1000);
      const updateCache = freshUpdateCache(dir, '99.0.0');
      const hintHome = mkdtempSync(join(tmpdir(), 'cah-stamp-hinthome-'));
      const markerDir = updateMarkerDir(hintHome);
      mkdirSync(markerDir, { recursive: true });
      const oldTime = Date.now() / 1000 - 60 * 60;
      for (let i = 0; i < 64; i++) {
        const marker = join(markerDir, `cah-update-shown-${i.toString(16).padStart(64, '0')}`);
        writeFileSync(marker, '');
        utimesSync(marker, oldTime, oldTime);
      }
      const sessionId = `../escape/${'x'.repeat(400)}`;
      const result = runStamp(
        { session_id: sessionId, transcript_path: tp, hook_event_name: 'Stop' },
        { CAH_UPDATE_CHECK_CACHE: updateCache, CAH_STAMP_HINT_HOME: hintHome },
      );
      assert.match(JSON.parse(result.stdout.trim()).systemMessage, /99\.0\.0/);
      const markers = readdirSync(markerDir).filter((name) => name.startsWith('cah-update-shown-'));
      assert.ok(markers.length <= 64);
      assert.ok(markers.every((name) => /^cah-update-shown-[a-f0-9]{64}$/.test(name)));
      assert.equal(existsSync(join(hintHome, 'escape')), false);
    });

    it('marker capacity cleanup restores a freshly replaced update marker', async () => {
      const dir = isolatedDir();
      const tp = writeTranscript(dir, 'claude-opus-4-7', 1000);
      const updateCache = freshUpdateCache(dir, '99.0.0');
      const hintHome = mkdtempSync(join(tmpdir(), 'cah-stamp-hinthome-'));
      const markerDir = updateMarkerDir(hintHome);
      mkdirSync(markerDir, { recursive: true });
      const now = Date.now() / 1000;
      const markers = [];
      for (let i = 0; i < 64; i += 1) {
        const marker = join(markerDir, `cah-update-shown-${i.toString(16).padStart(64, '0')}`);
        writeFileSync(marker, `old-${i}`);
        const mtime = now - (64 - i);
        utimesSync(marker, mtime, mtime);
        markers.push(marker);
      }
      const target = markers[0];
      const interlock = join(dir, 'update-marker-capacity-interlock');
      const running = runStampAsync(
        { session_id: 'update-marker-capacity', transcript_path: tp, hook_event_name: 'Stop' },
        {
          CAH_UPDATE_CHECK_CACHE: updateCache,
          CAH_STAMP_HINT_HOME: hintHome,
          CAH_STAMP_THROTTLE_PATH: join(dir, 'last-stamp.json'),
          CAH_TEST_ONLY: '1',
          CAH_TEST_ONLY_OWNER_INTERLOCK: interlock,
          CAH_TEST_ONLY_OWNER_INTERLOCK_PHASE: 'marker-capacity',
        },
      );
      await waitForPath(`${interlock}.ready`);
      unlinkSync(target);
      writeFileSync(target, 'fresh-capacity-successor');
      writeFileSync(`${interlock}.go`, 'go');
      const result = await running;
      assert.match(JSON.parse(result.stdout.trim()).systemMessage, /99\.0\.0/);
      assert.equal(readFileSync(target, 'utf8'), 'fresh-capacity-successor');
    });

    it('Stop delivers the notice after PostToolUse already deduped the same turn', () => {
      const dir = isolatedDir();
      const tp = join(dir, 'transcript.jsonl');
      writeFileSync(tp, JSON.stringify({
        type: 'assistant',
        requestId: 'req-stop-after-tool',
        message: { role: 'assistant', model: 'claude-opus-4-7', usage: { input_tokens: 1000 } },
      }) + '\n');
      const updateCache = freshUpdateCache(dir, '99.0.0');
      const hintHome = mkdtempSync(join(tmpdir(), 'cah-stamp-hinthome-'));
      const throttle = join(dir, 'last-stamp.json');
      const env = { CAH_UPDATE_CHECK_CACHE: updateCache, CAH_STAMP_HINT_HOME: hintHome, CAH_STAMP_THROTTLE_PATH: throttle };
      const post = runStamp({ session_id: 'stop-after-tool', transcript_path: tp, hook_event_name: 'PostToolUse' }, env);
      assert.ok(post.stdout.trim());
      const claimPath = stampSidecarPath(throttle, 'stop-after-tool');
      const priorClaim = readFileSync(claimPath, 'utf8');
      const stop = runStamp({ session_id: 'stop-after-tool', transcript_path: tp, hook_event_name: 'Stop' }, env);
      const message = JSON.parse(stop.stdout.trim()).systemMessage;
      assert.match(message, /99\.0\.0/);
      assert.doesNotMatch(message, /\d{2}:\d{2}:\d{2}/, 'notice-only output must not repeat timestamp');
      assert.doesNotMatch(message, /Opus|\(1k\//, 'notice-only output must not repeat model/context stamp');
      assert.equal(readFileSync(claimPath, 'utf8'), priorClaim, 'notice-only Stop must not alter stamp claim');
    });

    it('no newer version cached → no notice', () => {
      const dir = isolatedDir();
      const tp = writeTranscript(dir, 'claude-opus-4-7', 1000);
      const updateCache = freshUpdateCache(dir, '0.0.1');
      const hintHome = mkdtempSync(join(tmpdir(), 'cah-stamp-hinthome-'));
      const { stdout } = runStamp(
        { session_id: 'no-update-session', transcript_path: tp, hook_event_name: 'Stop' },
        { CAH_UPDATE_CHECK_CACHE: updateCache, CAH_STAMP_HINT_HOME: hintHome },
      );
      const parsed = JSON.parse(stdout.trim());
      assert.ok(!parsed.systemMessage.includes(String.fromCodePoint(0x1F535)));
    });

    it('Stop with no newer version preserves all 64 fresh markers at capacity', () => {
      const dir = isolatedDir();
      const tp = writeTranscript(dir, 'claude-opus-4-7', 1000);
      const updateCache = freshUpdateCache(dir, '0.0.1');
      const hintHome = mkdtempSync(join(tmpdir(), 'cah-stamp-hinthome-'));
      const markerDir = updateMarkerDir(hintHome);
      mkdirSync(markerDir, { recursive: true });
      for (let i = 0; i < 64; i += 1) {
        writeFileSync(join(markerDir, `cah-update-shown-${i.toString(16).padStart(64, '0')}`), `fresh-${i}`);
      }
      const result = runStamp(
        { session_id: 'update-at-capacity-none', transcript_path: tp, hook_event_name: 'Stop' },
        {
          CAH_UPDATE_CHECK_CACHE: updateCache,
          CAH_STAMP_HINT_HOME: hintHome,
          CAH_STAMP_THROTTLE_PATH: join(dir, 'capacity-none-throttle.json'),
        },
      );
      assert.ok(!JSON.parse(result.stdout.trim()).systemMessage.includes(String.fromCodePoint(0x1F535)));
      assert.equal(readdirSync(markerDir).filter((name) => /^cah-update-shown-[a-f0-9]{64}$/.test(name)).length, 64);
    });

    it('24 concurrent Stop calls emit at most one update notice', async () => {
      const dir = isolatedDir();
      const tp = writeTranscript(dir, 'claude-opus-4-7', 1000);
      const updateCache = freshUpdateCache(dir, '99.0.0');
      const hintHome = mkdtempSync(join(tmpdir(), 'cah-stamp-hinthome-'));
      const throttle = join(dir, 'last-stamp.json');
      const env = {
        CAH_UPDATE_CHECK_CACHE: updateCache,
        CAH_STAMP_HINT_HOME: hintHome,
        CAH_STAMP_THROTTLE_PATH: throttle,
        CAH_STAMP_MIN_INTERVAL_MS: '1',
        CAH_RATE_LIMITS_CACHE: join(dir, 'missing-rate-limits.json'),
      };
      const payload = { session_id: 'parallel-update', transcript_path: tp, hook_event_name: 'Stop' };
      const results = await Promise.all(Array.from({ length: 24 }, () => runStampAsync(payload, env)));
      assert.equal(results.filter((result) => result.stdout.includes('99.0.0')).length, 1);
      assert.ok(results.every((result) => result.status === 0));
    });

    it('recovers an abandoned update claim before delivery', () => {
      const dir = isolatedDir();
      const tp = writeTranscript(dir, 'claude-opus-4-7', 1000);
      const updateCache = freshUpdateCache(dir, '99.0.0');
      const hintHome = mkdtempSync(join(tmpdir(), 'cah-stamp-hinthome-'));
      const markerDir = updateMarkerDir(hintHome);
      mkdirSync(markerDir, { recursive: true });
      const sessionId = 'recovery-update-session';
      const hash = createHash('sha256').update(`string:${sessionId}`, 'utf8').digest('hex');
      const claim = join(markerDir, `.cah-marker-claim-cah-update-shown-${hash}`);
      writeClaim(claim, { pid: 99999999, nonce: 'dead-owner', claimedAt: Date.now() - 60_000 });
      const old = Date.now() / 1000 - 60;
      utimesSync(claim, old, old);
      const result = runStamp(
        { session_id: sessionId, transcript_path: tp, hook_event_name: 'Stop' },
        {
          CAH_UPDATE_CHECK_CACHE: updateCache,
          CAH_STAMP_HINT_HOME: hintHome,
          CAH_STAMP_THROTTLE_PATH: join(dir, 'last-stamp.json'),
        },
      );
      assert.match(JSON.parse(result.stdout.trim()).systemMessage, /99\.0\.0/);
      assert.equal(existsSync(join(markerDir, `cah-update-shown-${hash}`)), true);
    });

    it('does not reclaim a successor update claim installed after owner validation', async () => {
      const dir = isolatedDir();
      const tp = writeTranscript(dir, 'claude-opus-4-7', 1000);
      const updateCache = freshUpdateCache(dir, '99.0.0');
      const hintHome = mkdtempSync(join(tmpdir(), 'cah-stamp-hinthome-'));
      const markerDir = updateMarkerDir(hintHome);
      mkdirSync(markerDir, { recursive: true });
      const sessionId = 'update-reclaim-toctou';
      const hash = createHash('sha256').update(`string:${sessionId}`, 'utf8').digest('hex');
      const claim = join(markerDir, `.cah-marker-claim-cah-update-shown-${hash}`);
      writeClaim(claim, { pid: 99999999, nonce: 'dead-owner' });
      const interlock = join(dir, 'update-reclaim-interlock');
      const running = runStampAsync(
        { session_id: sessionId, transcript_path: tp, hook_event_name: 'Stop' },
        {
          CAH_UPDATE_CHECK_CACHE: updateCache,
          CAH_STAMP_HINT_HOME: hintHome,
          CAH_STAMP_THROTTLE_PATH: join(dir, 'last-stamp.json'),
          CAH_RATE_LIMITS_CACHE: join(dir, 'missing-rate-limits.json'),
          CAH_TEST_ONLY: '1',
          CAH_TEST_ONLY_OWNER_INTERLOCK: interlock,
          CAH_TEST_ONLY_OWNER_INTERLOCK_PHASE: 'claim-reclaim',
        },
      );
      await waitForPath(`${interlock}.ready`);
      unlinkSync(join(claim, 'owner.json'));
      rmdirSync(claim);
      const successor = { pid: process.pid, nonce: 'live-successor' };
      writeClaim(claim, successor);
      writeFileSync(`${interlock}.go`, 'go');
      const result = await running;
      assert.doesNotMatch(JSON.parse(result.stdout.trim()).systemMessage, /99\.0\.0/);
      assert.deepEqual(readClaim(claim), successor);
      assert.equal(existsSync(join(markerDir, `cah-update-shown-${hash}`)), false);
    });

    it('fences a three-party update-claim race while displaced owner B is restored', async () => {
      const dir = isolatedDir();
      const tp = writeTranscript(dir, 'claude-opus-4-7', 1000);
      const updateCache = freshUpdateCache(dir, '99.0.0');
      const hintHome = mkdtempSync(join(tmpdir(), 'cah-stamp-hinthome-'));
      const markerDir = updateMarkerDir(hintHome);
      mkdirSync(markerDir, { recursive: true });
      const sessionId = 'update-three-party';
      const hash = createHash('sha256').update(`string:${sessionId}`, 'utf8').digest('hex');
      const claim = join(markerDir, `.cah-marker-claim-cah-update-shown-${hash}`);
      writeClaim(claim, { pid: 99999999, nonce: 'stale-a' });
      const interlock = join(dir, 'update-three-party-interlock');
      const commonEnv = {
        CAH_UPDATE_CHECK_CACHE: updateCache,
        CAH_STAMP_HINT_HOME: hintHome,
        CAH_RATE_LIMITS_CACHE: join(dir, 'missing-rate-limits.json'),
      };
      const payload = { session_id: sessionId, transcript_path: tp, hook_event_name: 'Stop' };
      const reclaimer = runStampAsync(payload, {
        ...commonEnv,
        CAH_STAMP_THROTTLE_PATH: join(dir, 'reclaimer-stamp.json'),
        CAH_TEST_ONLY: '1',
        CAH_TEST_ONLY_OWNER_INTERLOCK: interlock,
        CAH_TEST_ONLY_OWNER_INTERLOCK_PHASE: 'claim-reclaim-three-party',
      });
      await waitForPath(`${interlock}.before.ready`);
      unlinkSync(join(claim, 'owner.json'));
      rmdirSync(claim);
      const ownerB = { pid: process.pid, nonce: 'live-b' };
      writeClaim(claim, ownerB);
      writeFileSync(`${interlock}.before.go`, 'go');
      await waitForPath(`${interlock}.vacancy.ready`);
      const contenderC = runStamp(payload, {
        ...commonEnv,
        CAH_STAMP_THROTTLE_PATH: join(dir, 'contender-stamp.json'),
      });
      assert.doesNotMatch(
        JSON.parse(contenderC.stdout.trim()).systemMessage,
        /99\.0\.0/,
        'C must not own the update claim while B is fenced',
      );
      writeFileSync(`${interlock}.vacancy.go`, 'go');
      const result = await reclaimer;
      assert.doesNotMatch(JSON.parse(result.stdout.trim()).systemMessage, /99\.0\.0/);
      assert.deepEqual(readClaim(claim), ownerB);
    });

    it('recovers an abandoned update-claim fence without losing its owner', () => {
      const dir = isolatedDir();
      const tp = writeTranscript(dir, 'claude-opus-4-7', 1000);
      const updateCache = freshUpdateCache(dir, '99.0.0');
      const hintHome = mkdtempSync(join(tmpdir(), 'cah-stamp-hinthome-'));
      const markerDir = updateMarkerDir(hintHome);
      mkdirSync(markerDir, { recursive: true });
      const sessionId = 'update-abandoned-fence';
      const hash = createHash('sha256').update(`string:${sessionId}`, 'utf8').digest('hex');
      const claim = join(markerDir, `.cah-marker-claim-cah-update-shown-${hash}`);
      const fence = `${claim}.taken-99999999-dead-operation`;
      const ownerB = { pid: process.pid, nonce: 'restored-b' };
      writeClaim(fence, ownerB);
      const result = runStamp(
        { session_id: sessionId, transcript_path: tp, hook_event_name: 'Stop' },
        {
          CAH_UPDATE_CHECK_CACHE: updateCache,
          CAH_STAMP_HINT_HOME: hintHome,
          CAH_STAMP_THROTTLE_PATH: join(dir, 'last-stamp.json'),
        },
      );
      assert.doesNotMatch(JSON.parse(result.stdout.trim()).systemMessage, /99\.0\.0/);
      assert.deepEqual(readClaim(claim), ownerB);
      assert.equal(existsSync(fence), false);
    });

    it('quarantines an abandoned update-claim fence with unexpected contents', () => {
      const dir = isolatedDir();
      const tp = writeTranscript(dir, 'claude-opus-4-7', 1000);
      const updateCache = freshUpdateCache(dir, '99.0.0');
      const hintHome = mkdtempSync(join(tmpdir(), 'cah-stamp-hinthome-'));
      const markerDir = updateMarkerDir(hintHome);
      mkdirSync(markerDir, { recursive: true });
      const sessionId = 'update-unexpected-fence';
      const hash = createHash('sha256').update(`string:${sessionId}`, 'utf8').digest('hex');
      const claim = join(markerDir, `.cah-marker-claim-cah-update-shown-${hash}`);
      const fence = `${claim}.taken-99999999-unexpected-fence`;
      writeClaim(fence, { pid: process.pid, nonce: 'preserve-owner' });
      writeFileSync(join(fence, 'foreign-data.txt'), 'preserve me\n');

      const result = runStamp(
        { session_id: sessionId, transcript_path: tp, hook_event_name: 'Stop' },
        {
          CAH_UPDATE_CHECK_CACHE: updateCache,
          CAH_STAMP_HINT_HOME: hintHome,
          CAH_STAMP_THROTTLE_PATH: join(dir, 'last-stamp.json'),
        },
      );
      assert.match(JSON.parse(result.stdout.trim()).systemMessage, /99\.0\.0/);
      const quarantineDir = join(markerDir, '.cah-lease-quarantine');
      const quarantined = join(quarantineDir, basename(fence));
      assert.equal(existsSync(fence), false);
      assert.equal(readFileSync(join(quarantined, 'foreign-data.txt'), 'utf8'), 'preserve me\n');
      assert.deepEqual(readdirSync(quarantineDir), [basename(fence)]);
    });

    it('old update-claim release cannot unlink a successor owner', async () => {
      const dir = isolatedDir();
      const tp = writeTranscript(dir, 'claude-opus-4-7', 1000);
      const updateCache = freshUpdateCache(dir, '99.0.0');
      const hintHome = mkdtempSync(join(tmpdir(), 'cah-stamp-hinthome-'));
      const markerDir = updateMarkerDir(hintHome);
      const sessionId = 'update-release-toctou';
      const hash = createHash('sha256').update(`string:${sessionId}`, 'utf8').digest('hex');
      const claim = join(markerDir, `.cah-marker-claim-cah-update-shown-${hash}`);
      const interlock = join(dir, 'update-release-interlock');
      const running = runStampAsync(
        { session_id: sessionId, transcript_path: tp, hook_event_name: 'Stop' },
        {
          CAH_UPDATE_CHECK_CACHE: updateCache,
          CAH_STAMP_HINT_HOME: hintHome,
          CAH_STAMP_THROTTLE_PATH: join(dir, 'last-stamp.json'),
          CAH_RATE_LIMITS_CACHE: join(dir, 'missing-rate-limits.json'),
          CAH_TEST_ONLY: '1',
          CAH_TEST_ONLY_OWNER_INTERLOCK: interlock,
          CAH_TEST_ONLY_OWNER_INTERLOCK_PHASE: 'claim-release',
        },
      );
      await waitForPath(`${interlock}.ready`);
      unlinkSync(join(claim, 'owner.json'));
      rmdirSync(claim);
      const successor = { pid: process.pid, nonce: 'release-successor' };
      writeClaim(claim, successor);
      writeFileSync(`${interlock}.go`, 'go');
      const result = await running;
      assert.match(JSON.parse(result.stdout.trim()).systemMessage, /99\.0\.0/);
      assert.deepEqual(readClaim(claim), successor);
      assert.equal(existsSync(join(markerDir, `cah-update-shown-${hash}`)), true);
    });

    it('update-marker cleanup restores a freshly replaced delivered marker', async () => {
      const dir = isolatedDir();
      const tp = writeTranscript(dir, 'claude-opus-4-7', 1000);
      const updateCache = freshUpdateCache(dir, '99.0.0');
      const hintHome = mkdtempSync(join(tmpdir(), 'cah-stamp-hinthome-'));
      const markerDir = updateMarkerDir(hintHome);
      mkdirSync(markerDir, { recursive: true });
      const sessionId = 'update-marker-toctou';
      const hash = createHash('sha256').update(`string:${sessionId}`, 'utf8').digest('hex');
      const marker = join(markerDir, `cah-update-shown-${hash}`);
      writeFileSync(marker, 'stale');
      const old = Date.now() / 1000 - 30 * 24 * 60 * 60;
      utimesSync(marker, old, old);
      const interlock = join(dir, 'update-marker-interlock');
      const running = runStampAsync(
        { session_id: sessionId, transcript_path: tp, hook_event_name: 'Stop' },
        {
          CAH_UPDATE_CHECK_CACHE: updateCache,
          CAH_STAMP_HINT_HOME: hintHome,
          CAH_STAMP_THROTTLE_PATH: join(dir, 'last-stamp.json'),
          CAH_RATE_LIMITS_CACHE: join(dir, 'missing-rate-limits.json'),
          CAH_TEST_ONLY: '1',
          CAH_TEST_ONLY_OWNER_INTERLOCK: interlock,
          CAH_TEST_ONLY_OWNER_INTERLOCK_PHASE: 'marker-remove',
        },
      );
      await waitForPath(`${interlock}.ready`);
      unlinkSync(marker);
      writeFileSync(marker, 'fresh-successor');
      writeFileSync(`${interlock}.go`, 'go');
      const result = await running;
      assert.doesNotMatch(JSON.parse(result.stdout.trim()).systemMessage, /99\.0\.0/);
      assert.equal(readFileSync(marker, 'utf8'), 'fresh-successor');
    });
  });
}
