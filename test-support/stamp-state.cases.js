import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, readdirSync, existsSync, utimesSync, mkdirSync, unlinkSync, rmdirSync, symlinkSync, lstatSync, linkSync, rmSync } from 'node:fs';
import { join, dirname, basename } from 'node:path';
import { tmpdir, homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { runStamp, runStampAsync, isolatedDir, writeTranscript, stampSidecarPath, stampSidecars, waitForPath, writeClaim, readClaim } from './stamp-helpers.js';
import { runConcurrentBatches } from './process-batches.js';

export function registerStampStateCases() {
  it('throttle: a second stamp within MIN_INTERVAL is suppressed', () => {
    const dir = isolatedDir();
    const tp = writeTranscript(dir, 'claude-opus-4-7', 46_000);
    const throttle = join(dir, 'last-stamp.json');
    const first = runStamp(
      { session_id: 's', transcript_path: tp },
      { CAH_STAMP_THROTTLE_PATH: throttle, CAH_STAMP_MIN_INTERVAL_MS: '60000' },
    );
    assert.ok(first.stdout.trim().length > 0, 'first stamp should emit');
    const second = runStamp(
      { session_id: 's', transcript_path: tp },
      { CAH_STAMP_THROTTLE_PATH: throttle, CAH_STAMP_MIN_INTERVAL_MS: '60000' },
    );
    assert.equal(second.stdout, '', 'second stamp within interval should be suppressed');
  });

  it('throttle: after MIN_INTERVAL elapses, the next stamp emits again', () => {
    const dir = isolatedDir();
    const tp = writeTranscript(dir, 'claude-opus-4-7', 46_000);
    const throttle = join(dir, 'last-stamp.json');
    runStamp(
      { session_id: 's', transcript_path: tp },
      { CAH_STAMP_THROTTLE_PATH: throttle, CAH_STAMP_MIN_INTERVAL_MS: '1' },
    );
    // Pretend the last stamp happened well in the past by rewriting its
    // session-partitioned sidecar.
    const sidecar = stampSidecarPath(throttle, 's');
    const state = JSON.parse(readFileSync(sidecar, 'utf8'));
    assert.equal(state.deliveryState, 'delivered');
    state.lastStampedAt = Date.now() - 60_000;
    writeFileSync(sidecar, JSON.stringify(state));
    const second = runStamp(
      { session_id: 's', transcript_path: tp },
      { CAH_STAMP_THROTTLE_PATH: throttle, CAH_STAMP_MIN_INTERVAL_MS: '10000' },
    );
    assert.ok(second.stdout.trim().length > 0, 'second stamp after interval should emit');
  });

  it('per-message dedup: same requestId twice → second suppressed even past throttle', () => {
    const dir = isolatedDir();
    const tp = join(dir, 'transcript.jsonl');
    // Same requestId on the assistant entry → marks the same turn.
    writeFileSync(tp, JSON.stringify({
      type: 'assistant',
      requestId: 'req_dedup_same_turn',
      message: { role: 'assistant', model: 'claude-opus-4-7', usage: { input_tokens: 46_000, output_tokens: 10 } },
    }) + '\n');
    const throttle = join(dir, 'last-stamp.json');
    const first = runStamp(
      { session_id: 's', transcript_path: tp },
      { CAH_STAMP_THROTTLE_PATH: throttle, CAH_STAMP_MIN_INTERVAL_MS: '1' },
    );
    assert.ok(first.stdout.trim().length > 0, 'first stamp should emit');
    // Keep the delivered claim just inside its seven-day dedup window, far
    // beyond the ordinary time throttle.
    const sidecar = stampSidecarPath(throttle, 's');
    const state = JSON.parse(readFileSync(sidecar, 'utf8'));
    assert.equal(state.deliveryState, 'delivered');
    state.lastStampedAt = Date.now() - 6 * 24 * 60 * 60 * 1000;
    writeFileSync(sidecar, JSON.stringify(state));
    const second = runStamp(
      { session_id: 's', transcript_path: tp },
      { CAH_STAMP_THROTTLE_PATH: throttle, CAH_STAMP_MIN_INTERVAL_MS: '1' },
    );
    assert.equal(second.stdout, '', 'second stamp for the same requestId must be suppressed');
  });

  it('fresh pending claim suppresses a concurrent retry', () => {
    const dir = isolatedDir();
    const tp = join(dir, 'transcript.jsonl');
    writeFileSync(tp, JSON.stringify({
      type: 'assistant',
      requestId: 'req-pending',
      message: { role: 'assistant', model: 'claude-opus-4-7', usage: { input_tokens: 46_000 } },
    }) + '\n');
    const throttle = join(dir, 'last-stamp.json');
    writeFileSync(stampSidecarPath(throttle, 'pending-session'), JSON.stringify({
      version: 2,
      lastStampedAt: Date.now(),
      lastStampedRequestId: 'req-pending',
      lastStampedTranscript: null,
      deliveryState: 'pending',
    }));
    const result = runStamp(
      { session_id: 'pending-session', transcript_path: tp },
      {
        CAH_STAMP_THROTTLE_PATH: throttle,
        CAH_STAMP_MIN_INTERVAL_MS: '1',
        CAH_STAMP_PENDING_TTL_MS: '60000',
      },
    );
    assert.equal(result.stdout, '');
  });

  it('stale pending claim retries delivery instead of suppressing for 7 days', () => {
    const dir = isolatedDir();
    const tp = join(dir, 'transcript.jsonl');
    writeFileSync(tp, JSON.stringify({
      type: 'assistant',
      requestId: 'req-crashed',
      message: { role: 'assistant', model: 'claude-opus-4-7', usage: { input_tokens: 46_000 } },
    }) + '\n');
    const throttle = join(dir, 'last-stamp.json');
    const sidecar = stampSidecarPath(throttle, 'crashed-session');
    writeFileSync(sidecar, JSON.stringify({
      version: 2,
      lastStampedAt: Date.now() - 1000,
      lastStampedRequestId: 'req-crashed',
      lastStampedTranscript: null,
      deliveryState: 'pending',
    }));
    const result = runStamp(
      { session_id: 'crashed-session', transcript_path: tp },
      {
        CAH_STAMP_THROTTLE_PATH: throttle,
        CAH_STAMP_MIN_INTERVAL_MS: '60000',
        CAH_STAMP_PENDING_TTL_MS: '100',
      },
    );
    assert.ok(result.stdout.trim(), 'stale pending delivery must be retried');
    assert.equal(JSON.parse(readFileSync(sidecar, 'utf8')).deliveryState, 'delivered');
  });

  it('does not overwrite a successor when a paused stamp loses its lease', async () => {
    const dir = isolatedDir();
    const tp = join(dir, 'transcript.jsonl');
    writeFileSync(tp, JSON.stringify({
      type: 'assistant', requestId: 'stale-request',
      message: { role: 'assistant', model: 'claude-opus-4-7', usage: { input_tokens: 46_000 } },
    }) + '\n');
    const throttle = join(dir, 'last-stamp.json');
    const sessionId = 'stamp-lease-loss-publication';
    const interlock = join(dir, 'stamp-publication-interlock');
    const env = {
      CAH_STAMP_THROTTLE_PATH: throttle,
      CAH_STAMP_MIN_INTERVAL_MS: '1',
      CAH_STAMP_OWNER_MAX_LEASE_MS: '100',
      CAH_TEST_ONLY: '1',
      CAH_TEST_ONLY_FSUTIL_INTERLOCK: interlock,
      CAH_TEST_ONLY_FSUTIL_INTERLOCK_PHASE: 'write-before-final-publication',
    };
    const paused = runStampAsync(
      { session_id: sessionId, transcript_path: tp }, env,
    );
    await waitForPath(`${interlock}.ready`);
    await new Promise((resolve) => setTimeout(resolve, 150));
    writeFileSync(tp, JSON.stringify({
      type: 'assistant', requestId: 'successor-request',
      message: { role: 'assistant', model: 'claude-opus-4-7', usage: { input_tokens: 47_000 } },
    }) + '\n');
    const successor = runStamp(
      { session_id: sessionId, transcript_path: tp },
      {
        CAH_STAMP_THROTTLE_PATH: throttle,
        CAH_STAMP_MIN_INTERVAL_MS: '1',
        CAH_STAMP_OWNER_MAX_LEASE_MS: '100',
        CAH_TEST_ONLY: '1',
      },
    );
    assert.ok(successor.stdout.trim(), 'successor must publish while the stale hook is paused');
    writeFileSync(`${interlock}.go`, 'go');
    const stale = await paused;
    assert.equal(stale.stdout, '', 'stale hook must stop after losing its lease');
    const state = JSON.parse(readFileSync(stampSidecarPath(throttle, sessionId), 'utf8'));
    assert.equal(state.deliveryState, 'delivered');
    assert.equal(state.lastStampedRequestId,
      createHash('sha256').update('successor-request', 'utf8').digest('hex'));
  });

  it('per-message dedup: different requestId → new stamp emits (past throttle)', () => {
    const dir = isolatedDir();
    const tp = join(dir, 'transcript.jsonl');
    writeFileSync(tp, JSON.stringify({
      type: 'assistant',
      requestId: 'req_turn_A',
      message: { role: 'assistant', model: 'claude-opus-4-7', usage: { input_tokens: 46_000, output_tokens: 10 } },
    }) + '\n');
    const throttle = join(dir, 'last-stamp.json');
    const first = runStamp(
      { session_id: 's', transcript_path: tp },
      { CAH_STAMP_THROTTLE_PATH: throttle, CAH_STAMP_MIN_INTERVAL_MS: '1' },
    );
    assert.ok(first.stdout.trim().length > 0);
    // Pretend MIN_INTERVAL elapsed, and the next turn has a fresh requestId.
    const sidecar = stampSidecarPath(throttle, 's');
    const state = JSON.parse(readFileSync(sidecar, 'utf8'));
    state.lastStampedAt = Date.now() - 60_000;
    writeFileSync(sidecar, JSON.stringify(state));
    writeFileSync(tp, JSON.stringify({
      type: 'assistant',
      requestId: 'req_turn_B',
      message: { role: 'assistant', model: 'claude-opus-4-7', usage: { input_tokens: 50_000, output_tokens: 10 } },
    }) + '\n');
    const second = runStamp(
      { session_id: 's', transcript_path: tp },
      { CAH_STAMP_THROTTLE_PATH: throttle, CAH_STAMP_MIN_INTERVAL_MS: '1' },
    );
    assert.ok(second.stdout.trim().length > 0, 'new requestId → new stamp');
  });

  it('partitions throttle state into collision-safe hashed session sidecars', () => {
    const dir = isolatedDir();
    const tp = writeTranscript(dir, 'claude-opus-4-7', 46_000);
    const throttle = join(dir, 'last-stamp.json');
    const sessionA = `../${'a'.repeat(400)}`;
    const sessionB = `../${'b'.repeat(400)}`;
    const first = runStamp(
      { session_id: sessionA, transcript_path: tp },
      { CAH_STAMP_THROTTLE_PATH: throttle, CAH_STAMP_MIN_INTERVAL_MS: '60000' },
    );
    assert.ok(first.stdout.trim());
    const second = runStamp(
      { session_id: sessionB, transcript_path: tp },
      { CAH_STAMP_THROTTLE_PATH: throttle, CAH_STAMP_MIN_INTERVAL_MS: '60000' },
    );
    assert.ok(second.stdout.trim(), 'one session must not throttle another');
    const aPath = stampSidecarPath(throttle, sessionA);
    const bPath = stampSidecarPath(throttle, sessionB);
    assert.notEqual(aPath, bPath, 'long/unusual session IDs must not collide');
    assert.ok(existsSync(aPath));
    assert.ok(existsSync(bPath));
    assert.equal(stampSidecars(throttle).length, 2);
    assert.equal(existsSync(throttle), false, 'new writes must not use a shared sessions map');
  });

  it('bounds sidecar cleanup and hashes full untrusted request IDs', () => {
    const dir = isolatedDir();
    const tp = join(dir, 'transcript.jsonl');
    writeFileSync(tp, JSON.stringify({
      type: 'assistant',
      requestId: 'x'.repeat(1000),
      message: { role: 'assistant', model: 'claude-opus-4-7', usage: { input_tokens: 46_000 } },
    }) + '\n');
    const throttle = join(dir, 'last-stamp.json');
    const oldTime = Date.now() / 1000 - 60 * 60;
    for (let i = 0; i < 100; i++) {
      const fakeHash = i.toString(16).padStart(64, '0');
      const path = join(dirname(stampSidecarPath(throttle, 'new-session')), `last-stamp.json.session-${fakeHash}.json`);
      writeFileSync(path, JSON.stringify({ lastStampedAt: Date.now() - i }));
      utimesSync(path, oldTime, oldTime);
    }

    const sessionId = 'new-session';
    const result = runStamp(
      { session_id: sessionId, transcript_path: tp },
      { CAH_STAMP_THROTTLE_PATH: throttle, CAH_STAMP_MIN_INTERVAL_MS: '1' },
    );
    assert.ok(result.stdout.trim());
    assert.ok(stampSidecars(throttle).length <= 64);
    const state = JSON.parse(readFileSync(stampSidecarPath(throttle, sessionId), 'utf8'));
    assert.equal(state.lastStampedRequestId.length, 64);
    assert.equal(state.requestIdEncoding, 'sha256');
  });

  it('sidecar prune preserves a successor installed after stat', async () => {
    const dir = isolatedDir();
    const tp = writeTranscript(dir, 'claude-opus-4-7', 46_000);
    const throttle = join(dir, 'last-stamp.json');
    const stale = join(dirname(stampSidecarPath(throttle, 'sidecar-prune-successor')), `last-stamp.json.session-${'c'.repeat(64)}.json`);
    writeFileSync(stale, 'stale-sidecar');
    const old = Date.now() / 1000 - 30 * 24 * 60 * 60;
    utimesSync(stale, old, old);
    const interlock = join(dir, 'sidecar-prune-interlock');
    const running = runStampAsync(
      { session_id: 'sidecar-prune-successor', transcript_path: tp },
      {
        CAH_STAMP_THROTTLE_PATH: throttle,
        CAH_STAMP_MIN_INTERVAL_MS: '1',
        CAH_TEST_ONLY: '1',
        CAH_TEST_ONLY_OWNER_INTERLOCK: interlock,
        CAH_TEST_ONLY_OWNER_INTERLOCK_PHASE: 'sidecar-prune',
      },
    );
    await waitForPath(`${interlock}.ready`);
    unlinkSync(stale);
    writeFileSync(stale, 'fresh-successor');
    writeFileSync(`${interlock}.go`, 'go');
    const result = await running;
    assert.ok(result.stdout.trim());
    assert.equal(readFileSync(stale, 'utf8'), 'fresh-successor');
  });

  it('64-capacity sidecar prune preserves a successor installed after scan', async () => {
    const dir = isolatedDir();
    const tp = writeTranscript(dir, 'claude-opus-4-7', 46_000);
    const throttle = join(dir, 'last-stamp.json');
    const now = Date.now() / 1000;
    const sidecars = [];
    for (let i = 0; i < 64; i++) {
      const path = join(dirname(stampSidecarPath(throttle, 'sidecar-prune-capacity-successor')), `last-stamp.json.session-${i.toString(16).padStart(64, '0')}.json`);
      sidecars.push(path);
      writeFileSync(path, JSON.stringify({ lastStampedAt: Date.now() - i * 1000 }));
      // Keep every entry inside the TTL while making the first one the
      // oldest capacity candidate.
      utimesSync(path, now - (64 - i), now - (64 - i));
    }
    const capacityTarget = sidecars[0];
    const interlock = join(dir, 'sidecar-prune-capacity-interlock');
    const running = runStampAsync(
      { session_id: 'sidecar-prune-capacity-successor', transcript_path: tp },
      {
        CAH_STAMP_THROTTLE_PATH: throttle,
        CAH_STAMP_MIN_INTERVAL_MS: '1',
        CAH_TEST_ONLY: '1',
        CAH_TEST_ONLY_OWNER_INTERLOCK: interlock,
        CAH_TEST_ONLY_OWNER_INTERLOCK_PHASE: 'sidecar-prune-capacity',
      },
    );
    await waitForPath(`${interlock}.ready`);
    unlinkSync(capacityTarget);
    writeFileSync(capacityTarget, 'fresh-capacity-successor');
    writeFileSync(`${interlock}.go`, 'go');
    const result = await running;
    assert.ok(result.stdout.trim());
    assert.equal(readFileSync(capacityTarget, 'utf8'), 'fresh-capacity-successor');
  });

  it('does not publish the stamp migration sentinel after a truncated legacy scan', () => {
    const dir = isolatedDir();
    const throttle = join(dir, 'last-stamp.json');
    const tp = writeTranscript(dir, 'claude-opus-4-7', 46_000);
    for (let i = 0; i < 220; i += 1) writeFileSync(join(dir, `stamp-legacy-overflow-${i}`), 'foreign');
    const first = runStamp(
      { session_id: 'bounded-stamp-scan-a', transcript_path: tp },
      { CAH_STAMP_THROTTLE_PATH: throttle, CAH_STAMP_HINT_HOME: dir, CAH_STAMP_MIN_INTERVAL_MS: '1' },
    );
    assert.ok(first.stdout.trim());
    const sentinel = join(dir, 'stamp-state', '.migration-v1');
    assert.equal(existsSync(sentinel), false);
    for (const name of readdirSync(dir).filter((name) => name.startsWith('stamp-legacy-overflow-'))) {
      unlinkSync(join(dir, name));
    }
    const second = runStamp(
      { session_id: 'bounded-stamp-scan-b', transcript_path: tp },
      { CAH_STAMP_THROTTLE_PATH: throttle, CAH_STAMP_HINT_HOME: dir, CAH_STAMP_MIN_INTERVAL_MS: '1' },
    );
    assert.ok(second.stdout.trim());
    assert.equal(existsSync(sentinel), true);
  });

  it('sidecar pruning ignores directories, links, and multiply-linked files', (t) => {
    const dir = isolatedDir();
    const tp = writeTranscript(dir, 'claude-opus-4-7', 46_000);
    const throttle = join(dir, 'last-stamp.json');
    const suffix = 'd'.repeat(64);
    const sidecarDir = join(dirname(stampSidecarPath(throttle, 'non-file-sidecars')), `last-stamp.json.session-${suffix}.json`);
    const sidecarTarget = join(dir, 'sidecar-target');
    const stateDir = dirname(stampSidecarPath(throttle, 'non-file-sidecars'));
    const sidecarLink = join(stateDir, `last-stamp.json.session-${'e'.repeat(64)}.json`);
    const sidecarHardlink = join(stateDir, `last-stamp.json.session-${'f'.repeat(64)}.json`);
    mkdirSync(sidecarDir);
    writeFileSync(sidecarTarget, 'target');
    try {
      symlinkSync(sidecarTarget, sidecarLink, 'file');
    } catch (error) {
      if (process.platform === 'win32' && error && ['EPERM', 'EACCES', 'EINVAL'].includes(error.code)) {
        t.skip('file symlinks are unavailable on this Windows host');
        return;
      }
      throw error;
    }
    writeFileSync(sidecarHardlink, 'hard-linked');
    const hardlinkPeer = join(dir, 'hardlink-peer');
    // A hard link is a regular file but is not a single-link managed sidecar.
    // Keep the peer alive while the hook runs so nlink remains greater than 1.
    linkSync(sidecarHardlink, hardlinkPeer);
    const result = runStamp(
      { session_id: 'non-file-sidecars', transcript_path: tp },
      { CAH_STAMP_THROTTLE_PATH: throttle, CAH_STAMP_MIN_INTERVAL_MS: '1' },
    );
    assert.ok(result.stdout.trim());
    assert.equal(lstatSync(sidecarDir).isDirectory(), true);
    assert.equal(lstatSync(sidecarLink).isSymbolicLink(), true);
    assert.equal(lstatSync(sidecarHardlink).nlink > 1n, true);
  });

  it('atomic sidecar writes ignore a prepared legacy predictable temp symlink', (t) => {
    const dir = isolatedDir();
    const tp = writeTranscript(dir, 'claude-opus-4-7', 46_000);
    const throttle = join(dir, 'last-stamp.json');
    const sessionId = 'atomic-sidecar';
    const sidecar = stampSidecarPath(throttle, sessionId);
    const victim = join(dir, 'foreign-victim.txt');
    writeFileSync(victim, 'foreign-content');
    const legacyTemp = `${sidecar}.12345.1700000000000.1.tmp`;
    try {
      symlinkSync(victim, legacyTemp, 'file');
    } catch (error) {
      if (process.platform === 'win32' && error && ['EPERM', 'EACCES', 'EINVAL'].includes(error.code)) {
        t.skip('file symlinks are unavailable on this Windows host');
        return;
      }
      throw error;
    }
    const result = runStamp(
      { session_id: sessionId, transcript_path: tp },
      { CAH_STAMP_THROTTLE_PATH: throttle },
    );
    assert.ok(result.stdout.trim());
    assert.equal(readFileSync(victim, 'utf8'), 'foreign-content');
    assert.equal(lstatSync(legacyTemp).isSymbolicLink(), true);
    assert.equal(JSON.parse(readFileSync(sidecar, 'utf8')).deliveryState, 'delivered');
  });

  it('does not confuse distinct 1000-character request IDs with the same prefix', () => {
    const dir = isolatedDir();
    const tp = join(dir, 'transcript.jsonl');
    const prefix = 'p'.repeat(512);
    const throttle = join(dir, 'last-stamp.json');
    writeFileSync(tp, JSON.stringify({
      type: 'assistant',
      requestId: prefix + 'A'.repeat(488),
      message: { role: 'assistant', model: 'claude-opus-4-7', usage: { input_tokens: 46_000 } },
    }) + '\n');
    const first = runStamp(
      { session_id: 'long-request-id', transcript_path: tp },
      { CAH_STAMP_THROTTLE_PATH: throttle, CAH_STAMP_MIN_INTERVAL_MS: '1' },
    );
    assert.ok(first.stdout.trim());
    const sidecar = stampSidecarPath(throttle, 'long-request-id');
    const state = JSON.parse(readFileSync(sidecar, 'utf8'));
    state.lastStampedAt = Date.now() - 60_000;
    writeFileSync(sidecar, JSON.stringify(state));
    writeFileSync(tp, JSON.stringify({
      type: 'assistant',
      requestId: prefix + 'B'.repeat(488),
      message: { role: 'assistant', model: 'claude-opus-4-7', usage: { input_tokens: 50_000 } },
    }) + '\n');
    const second = runStamp(
      { session_id: 'long-request-id', transcript_path: tp },
      { CAH_STAMP_THROTTLE_PATH: throttle, CAH_STAMP_MIN_INTERVAL_MS: '1' },
    );
    assert.ok(second.stdout.trim(), 'different full request IDs must not dedupe');
  });

  it('24 concurrent same-session/request calls emit at most one stamp in bounded batches', async (t) => {
    const dir = isolatedDir();
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const tp = join(dir, 'transcript.jsonl');
    writeFileSync(tp, JSON.stringify({
      type: 'assistant',
      requestId: 'parallel-request',
      message: { role: 'assistant', model: 'claude-opus-4-7', usage: { input_tokens: 46_000 } },
    }) + '\n');
    const throttle = join(dir, 'last-stamp.json');
    const env = {
      CAH_STAMP_THROTTLE_PATH: throttle,
      CAH_STAMP_MIN_INTERVAL_MS: '1',
      CAH_RATE_LIMITS_CACHE: join(dir, 'missing-rate-limits.json'),
      CAH_UPDATE_CHECK_CACHE: join(dir, 'missing-update-cache.json'),
    };
    const payload = { session_id: 'parallel-stamp', transcript_path: tp };
    const results = await runConcurrentBatches(24, () => runStampAsync(payload, env));
    assert.equal(results.filter((result) => result.stdout.trim()).length, 1);
    assert.ok(results.every((result) => result.status === 0),
      results.filter((result) => result.status !== 0).map((result) => result.error?.code).join(', '));
  });

  it('recovers an abandoned stale stamp lock', () => {
    const dir = isolatedDir();
    const tp = writeTranscript(dir, 'claude-opus-4-7', 46_000);
    const throttle = join(dir, 'last-stamp.json');
    const lock = `${stampSidecarPath(throttle, 'stale-lock-session')}.lock`;
    writeClaim(lock, { pid: 99999999, nonce: 'dead-owner', startedAt: Date.now() - 60 * 60 * 1000 });
    const old = Date.now() / 1000 - 60 * 60;
    utimesSync(lock, old, old);
    const result = runStamp(
      { session_id: 'stale-lock-session', transcript_path: tp },
      { CAH_STAMP_THROTTLE_PATH: throttle },
    );
    assert.ok(result.stdout.trim());
    assert.equal(existsSync(lock), false);
  });

  it('does not steal a live lock within its maximum lease', () => {
    const dir = isolatedDir();
    const tp = writeTranscript(dir, 'claude-opus-4-7', 46_000);
    const throttle = join(dir, 'last-stamp.json');
    const lock = `${stampSidecarPath(throttle, 'live-lock-session')}.lock`;
    writeClaim(lock, { pid: process.pid, nonce: 'live-owner', startedAt: Date.now() });
    const old = Date.now() / 1000 - 60 * 60;
    utimesSync(lock, old, old);
    const result = runStamp(
      { session_id: 'live-lock-session', transcript_path: tp },
      { CAH_STAMP_THROTTLE_PATH: throttle },
    );
    assert.equal(result.stdout, '');
    assert.equal(existsSync(lock), true, 'live owner lock must remain intact');
  });

  it('reclaims a live-PID lock after its absolute lease expires', () => {
    const dir = isolatedDir();
    const tp = writeTranscript(dir, 'claude-opus-4-7', 46_000);
    const throttle = join(dir, 'last-stamp.json');
    const lock = `${stampSidecarPath(throttle, 'expired-live-lock')}.lock`;
    writeClaim(lock, { pid: process.pid, nonce: 'reused-pid', startedAt: Date.now() - 60_000 });
    const result = runStamp(
      { session_id: 'expired-live-lock', transcript_path: tp },
      {
        CAH_STAMP_THROTTLE_PATH: throttle,
        CAH_TEST_ONLY: '1',
        CAH_STAMP_OWNER_MAX_LEASE_MS: '100',
      },
    );
    assert.ok(result.stdout.trim());
    assert.equal(existsSync(lock), false);
  });

  it('does not reclaim a successor lock installed after the dead-owner check', async () => {
    const dir = isolatedDir();
    const tp = writeTranscript(dir, 'claude-opus-4-7', 46_000);
    const throttle = join(dir, 'last-stamp.json');
    const sessionId = 'lock-reclaim-toctou';
    const lock = `${stampSidecarPath(throttle, sessionId)}.lock`;
    writeClaim(lock, { pid: 99999999, nonce: 'dead-owner' });
    const updateCache = join(dir, 'update-check.json');
    writeFileSync(updateCache, JSON.stringify({ latestVersion: null, checkedAt: Date.now() }));
    const interlock = join(dir, 'lock-reclaim-interlock');
    const running = runStampAsync(
      { session_id: sessionId, transcript_path: tp },
      {
        CAH_STAMP_THROTTLE_PATH: throttle,
        CAH_RATE_LIMITS_CACHE: join(dir, 'missing-rate-limits.json'),
        CAH_UPDATE_CHECK_CACHE: updateCache,
        CAH_TEST_ONLY: '1',
        CAH_TEST_ONLY_OWNER_INTERLOCK: interlock,
        CAH_TEST_ONLY_OWNER_INTERLOCK_PHASE: 'lock-reclaim',
      },
    );
    await waitForPath(`${interlock}.ready`);
    unlinkSync(join(lock, 'owner.json'));
    rmdirSync(lock);
    const successor = { pid: process.pid, nonce: 'live-successor' };
    writeClaim(lock, successor);
    writeFileSync(`${interlock}.go`, 'go');
    const result = await running;
    assert.equal(result.stdout, '');
    assert.deepEqual(readClaim(lock), successor);
  });

  it('fences a three-party stamp-lock race while displaced owner B is restored', async () => {
    const dir = isolatedDir();
    const tp = writeTranscript(dir, 'claude-opus-4-7', 46_000);
    const throttle = join(dir, 'last-stamp.json');
    const sessionId = 'lock-three-party';
    const lock = `${stampSidecarPath(throttle, sessionId)}.lock`;
    writeClaim(lock, { pid: 99999999, nonce: 'stale-a' });
    const updateCache = join(dir, 'update-check.json');
    writeFileSync(updateCache, JSON.stringify({ latestVersion: null, checkedAt: Date.now() }));
    const baseEnv = {
      CAH_STAMP_THROTTLE_PATH: throttle,
      CAH_RATE_LIMITS_CACHE: join(dir, 'missing-rate-limits.json'),
      CAH_UPDATE_CHECK_CACHE: updateCache,
    };
    const interlock = join(dir, 'lock-three-party-interlock');
    const reclaimer = runStampAsync(
      { session_id: sessionId, transcript_path: tp },
      {
        ...baseEnv,
        CAH_TEST_ONLY: '1',
        CAH_TEST_ONLY_OWNER_INTERLOCK: interlock,
        CAH_TEST_ONLY_OWNER_INTERLOCK_PHASE: 'lock-reclaim-three-party',
      },
    );
    await waitForPath(`${interlock}.before.ready`);
    unlinkSync(join(lock, 'owner.json'));
    rmdirSync(lock);
    const ownerB = { pid: process.pid, nonce: 'live-b' };
    writeClaim(lock, ownerB);
    writeFileSync(`${interlock}.before.go`, 'go');
    await waitForPath(`${interlock}.vacancy.ready`);
    const contenderC = runStamp(
      { session_id: sessionId, transcript_path: tp },
      baseEnv,
    );
    assert.equal(contenderC.stdout, '', 'C must not acquire while B is fenced in a tombstone');
    writeFileSync(`${interlock}.vacancy.go`, 'go');
    const result = await reclaimer;
    assert.equal(result.stdout, '');
    assert.deepEqual(readClaim(lock), ownerB);
  });

  it('recovers an abandoned stamp-lock fence without losing its displaced owner', () => {
    const dir = isolatedDir();
    const tp = writeTranscript(dir, 'claude-opus-4-7', 46_000);
    const throttle = join(dir, 'last-stamp.json');
    const sessionId = 'lock-abandoned-fence';
    const lock = `${stampSidecarPath(throttle, sessionId)}.lock`;
    const fence = `${lock}.taken-99999999-dead-operation`;
    const ownerB = { pid: process.pid, nonce: 'restored-b' };
    writeClaim(fence, ownerB);
    const result = runStamp(
      { session_id: sessionId, transcript_path: tp },
      { CAH_STAMP_THROTTLE_PATH: throttle },
    );
    assert.equal(result.stdout, '');
    assert.deepEqual(readClaim(lock), ownerB);
    assert.equal(existsSync(fence), false);
  });

  it('old lock release cannot unlink a successor owner', async () => {
    const dir = isolatedDir();
    const tp = writeTranscript(dir, 'claude-opus-4-7', 46_000);
    const throttle = join(dir, 'last-stamp.json');
    const sessionId = 'lock-release-toctou';
    const lock = `${stampSidecarPath(throttle, sessionId)}.lock`;
    const updateCache = join(dir, 'update-check.json');
    writeFileSync(updateCache, JSON.stringify({ latestVersion: null, checkedAt: Date.now() }));
    const interlock = join(dir, 'lock-release-interlock');
    const running = runStampAsync(
      { session_id: sessionId, transcript_path: tp },
      {
        CAH_STAMP_THROTTLE_PATH: throttle,
        CAH_RATE_LIMITS_CACHE: join(dir, 'missing-rate-limits.json'),
        CAH_UPDATE_CHECK_CACHE: updateCache,
        CAH_TEST_ONLY: '1',
        CAH_TEST_ONLY_OWNER_INTERLOCK: interlock,
        CAH_TEST_ONLY_OWNER_INTERLOCK_PHASE: 'lock-release',
      },
    );
    await waitForPath(`${interlock}.ready`);
    unlinkSync(join(lock, 'owner.json'));
    rmdirSync(lock);
    const successor = { pid: process.pid, nonce: 'release-successor' };
    writeClaim(lock, successor);
    writeFileSync(`${interlock}.go`, 'go');
    const result = await running;
    assert.ok(result.stdout.trim());
    assert.deepEqual(readClaim(lock), successor);
  });

  it('honors a valid hook-envelope context window over model fallback', () => {
    const dir = isolatedDir();
    const tp = writeTranscript(dir, 'claude-opus-4-7', 46_000);
    const result = runStamp({
      session_id: 'envelope-context',
      transcript_path: tp,
      context_window: { context_window_size: 100_000 },
    });
    assert.match(JSON.parse(result.stdout.trim()).systemMessage, /46% \(46k\/100k\)/);
  });

  it('honors the 200k fallback when 1M context is disabled', () => {
    const dir = isolatedDir();
    const tp = writeTranscript(dir, 'claude-opus-4-7', 250_000);
    const result = runStamp(
      { session_id: 'disabled-1m', transcript_path: tp },
      { CLAUDE_CODE_DISABLE_1M_CONTEXT: '1' },
    );
    assert.match(JSON.parse(result.stdout.trim()).systemMessage, /125% \(250k\/200k\)/);
  });

  it('ignores stale rate_limits state file (>1h old)', () => {
    const dir = isolatedDir();
    const tp = writeTranscript(dir, 'claude-opus-4-7', 46_000);
    const cachePath = join(dir, 'rate-limits.json');
    const stale = Date.now() - 2 * 60 * 60 * 1000;
    writeFileSync(cachePath, JSON.stringify({
      fiveHour: { used: 23, resetsAt: new Date(stale + 5 * 60 * 60 * 1000).toISOString() },
      sevenDay: null,
      capturedAt: stale,
    }));
    const { stdout } = runStamp(
      { session_id: 's', transcript_path: tp },
      { CAH_RATE_LIMITS_CACHE: cachePath },
    );
    const parsed = JSON.parse(stdout.trim());
    assert.ok(!parsed.systemMessage.includes('5h'), `stale cache leaked: ${parsed.systemMessage}`);
  });
}
