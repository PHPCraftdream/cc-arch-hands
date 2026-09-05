import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, readdirSync, existsSync, utimesSync, mkdirSync, unlinkSync, rmdirSync, symlinkSync, lstatSync } from 'node:fs';
import { join, dirname, basename } from 'node:path';
import { tmpdir, homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

const __dirname = dirname(fileURLToPath(import.meta.url));
const BIN = join(__dirname, '..', 'bin', 'cah-stamp.js');

function stampInvocationEnv(env = {}) {
  const hintHome = env.CAH_STAMP_HINT_HOME
    || mkdtempSync(join(tmpdir(), 'cah-stamp-hinthome-'));
  const cacheOverride = env.CAH_RATE_LIMITS_CACHE
    || join(hintHome, 'missing-rate-limits.json');
  const throttleOverride = env.CAH_STAMP_THROTTLE_PATH
    || join(hintHome, 'last-stamp.json');
  let updateCacheOverride = env.CAH_UPDATE_CHECK_CACHE;
  if (!updateCacheOverride) {
    updateCacheOverride = join(hintHome, 'update-check.json');
    writeFileSync(updateCacheOverride, JSON.stringify({ latestVersion: null, checkedAt: Date.now() }));
  }
  return {
    hintHome,
    cacheOverride,
    throttleOverride,
    updateCacheOverride,
    env: {
      ...process.env,
      ...env,
      CAH_STAMP_HINT_HOME: hintHome,
      CAH_RATE_LIMITS_CACHE: cacheOverride,
      CAH_STAMP_THROTTLE_PATH: throttleOverride,
      CAH_UPDATE_CHECK_CACHE: updateCacheOverride,
    },
  };
}

function runStamp(stdinData, env) {
  const input = typeof stdinData === 'string' ? stdinData : JSON.stringify(stdinData);
  const invocation = stampInvocationEnv(env);
  const res = spawnSync(process.execPath, [BIN], {
    input,
    encoding: 'utf8',
    env: invocation.env,
  });
  return {
    stdout: res.stdout,
    status: res.status,
    hintHome: invocation.hintHome,
    cachePath: invocation.cacheOverride,
    throttlePath: invocation.throttleOverride,
    updateCachePath: invocation.updateCacheOverride,
  };
}

function runStampAsync(stdinData, env) {
  const input = typeof stdinData === 'string' ? stdinData : JSON.stringify(stdinData);
  const invocation = stampInvocationEnv(env);
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [BIN], {
      env: invocation.env,
      stdio: ['pipe', 'pipe', 'ignore'],
    });
    let stdout = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.on('close', (status) => resolve({
      stdout,
      status,
      hintHome: invocation.hintHome,
      cachePath: invocation.cacheOverride,
      throttlePath: invocation.throttleOverride,
      updateCachePath: invocation.updateCacheOverride,
    }));
    child.stdin.end(input);
  });
}

function isolatedDir() {
  return mkdtempSync(join(tmpdir(), 'cah-stamp-'));
}

function updateMarkerDir(home) {
  return join(home, '.claude', 'cah-bin', 'cache');
}

async function waitForPath(path, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (existsSync(path)) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.fail(`timed out waiting for ${path}`);
}

function sessionHash(sessionId) {
  const identity = typeof sessionId === 'string' ? `string:${sessionId}` : 'missing:';
  return createHash('sha256').update(identity, 'utf8').digest('hex');
}

function stampSidecarPath(base, sessionId) {
  return `${base}.session-${sessionHash(sessionId)}.json`;
}

function stampSidecars(base) {
  const prefix = basename(base) + '.session-';
  return readdirSync(dirname(base))
    .filter((name) => name.startsWith(prefix) && name.endsWith('.json'))
    .map((name) => join(dirname(base), name));
}

function writeClaim(path, owner) {
  mkdirSync(path);
  writeFileSync(join(path, 'owner.json'), JSON.stringify(owner));
}

function replaceClaim(path, owner) {
  unlinkSync(join(path, 'owner.json'));
  rmdirSync(path);
  writeClaim(path, owner);
}

function readClaim(path) {
  return JSON.parse(readFileSync(join(path, 'owner.json'), 'utf8'));
}

function writeTranscript(dir, model, usedTokens) {
  const path = join(dir, 'transcript.jsonl');
  const lines = [
    JSON.stringify({ type: 'user', message: { role: 'user', content: 'hi' } }),
    JSON.stringify({
      type: 'assistant',
      message: {
        role: 'assistant',
        model,
        usage: { input_tokens: usedTokens, output_tokens: 10 },
      },
    }),
  ];
  writeFileSync(path, lines.join('\n') + '\n');
  return path;
}

const TIME_RE = /^\d{2}:\d{2}/;

describe('cah-stamp bin', () => {
  it('empty stdin → no output, exit 0', () => {
    const { stdout, status } = runStamp('');
    assert.equal(stdout, '');
    assert.equal(status, 0);
  });

  it('malformed JSON → no output, exit 0', () => {
    const { stdout, status } = runStamp('{not valid json');
    assert.equal(stdout, '');
    assert.equal(status, 0);
  });

  it('default harness paths isolate marker and rate-limit access from homedir', () => {
    const dir = isolatedDir();
    const tp = writeTranscript(dir, 'claude-opus-4-7', 1000);
    const updateCache = join(dir, 'update-check.json');
    writeFileSync(updateCache, JSON.stringify({ latestVersion: '99.0.0', checkedAt: Date.now() }));
    const sessionId = `harness-home-isolation-${process.pid}-${Math.random().toString(36).slice(2)}`;
    const result = runStamp({ session_id: sessionId, transcript_path: tp, hook_event_name: 'Stop' }, {
      CAH_UPDATE_CHECK_CACHE: updateCache,
    });
    const realCache = join(homedir(), '.claude', 'cah-bin', 'cache', 'rate-limits.json');
    assert.notEqual(result.hintHome, homedir());
    assert.notEqual(result.cachePath, realCache);
    assert.equal(result.cachePath, join(result.hintHome, 'missing-rate-limits.json'));
    const marker = join(updateMarkerDir(result.hintHome), `cah-update-shown-${createHash('sha256').update(`string:${sessionId}`, 'utf8').digest('hex')}`);
    const realMarker = join(updateMarkerDir(homedir()), `cah-update-shown-${createHash('sha256').update(`string:${sessionId}`, 'utf8').digest('hex')}`);
    assert.equal(existsSync(marker), true);
    assert.equal(existsSync(realMarker), false);
  });

  it('stop_hook_active: true → no output, exit 0', () => {
    const dir = isolatedDir();
    const tp = writeTranscript(dir, 'claude-opus-4-7', 46_000);
    const { stdout, status } = runStamp({
      session_id: 'loop-session',
      transcript_path: tp,
      stop_hook_active: true,
    });
    assert.equal(stdout, '');
    assert.equal(status, 0);
  });

  it('missing transcript_path → no output, exit 0', () => {
    const { stdout, status } = runStamp({ session_id: 'no-tp' });
    assert.equal(stdout, '');
    assert.equal(status, 0);
  });

  it('transcript path does not exist → emits HH:MM only (no model/usage), exit 0', () => {
    const dir = isolatedDir();
    const { stdout, status } = runStamp({
      session_id: 's-missing',
      transcript_path: join(dir, 'nonexistent.jsonl'),
    });
    // Still emits a systemMessage (with just HH:MM since no transcript data)
    assert.equal(status, 0);
    let parsed;
    try {
      parsed = JSON.parse(stdout.trim());
    } catch {
      // If nothing was emitted because transcriptPath returned null and we returned early
      // that's also acceptable — spec says "exit 0 silent" for missing transcript
      assert.equal(stdout, '');
      return;
    }
    assert.equal(parsed.continue, true);
    assert.match(parsed.systemMessage, TIME_RE);
  });

  it('valid envelope + Opus 4.7 transcript (46k tokens) → correct systemMessage', () => {
    const dir = isolatedDir();
    const tp = writeTranscript(dir, 'claude-opus-4-7', 46_000);
    const { stdout, status } = runStamp({
      session_id: 'opus-session',
      transcript_path: tp,
    });
    assert.equal(status, 0);
    const parsed = JSON.parse(stdout.trim());
    assert.equal(parsed.continue, true);
    // HH:MM · Opus 4.7 · X% (46k/1M)
    assert.match(parsed.systemMessage, TIME_RE);
    assert.match(parsed.systemMessage, /· Opus 4\.7 · [\d.]+% \(46k\/1M\)$/);
    assert.ok(!parsed.systemMessage.includes('['), `stamp should not contain bars: ${parsed.systemMessage}`);
  });

  it('Sonnet variant → correct systemMessage with 200k limit', () => {
    const dir = isolatedDir();
    const tp = writeTranscript(dir, 'claude-sonnet-4-6', 100_000);
    const { stdout, status } = runStamp({
      session_id: 'sonnet-session',
      transcript_path: tp,
    });
    assert.equal(status, 0);
    const parsed = JSON.parse(stdout.trim());
    assert.equal(parsed.continue, true);
    // 100k/200k = 50%
    assert.match(parsed.systemMessage, /· Sonnet 4\.6 · 50% \(100k\/200k\)$/);
    assert.ok(!parsed.systemMessage.includes('['), 'stamp should not contain bars');
  });

  it('"Claude " prefix is stripped from model name', () => {
    const dir = isolatedDir();
    const tp = writeTranscript(dir, 'claude-opus-4-8', 200_000);
    const { stdout, status } = runStamp({
      session_id: 'prefix-session',
      transcript_path: tp,
    });
    assert.equal(status, 0);
    const parsed = JSON.parse(stdout.trim());
    // Model in transcript is "claude-opus-4-8". formatStatusLine trims "Claude " prefix.
    // "claude-opus-4-8" does not start with "Claude " (lowercase), so it stays as is.
    // The trim only strips the exact prefix "Claude " (capital C).
    assert.match(parsed.systemMessage, TIME_RE);
    assert.ok(parsed.systemMessage.includes('claude-opus-4-8') || parsed.systemMessage.includes('Opus'));
  });

  it('usedTokens present but no model → systemMessage is HH:MM only (degrade)', () => {
    const dir = isolatedDir();
    // Write transcript with usage but no model field
    const tp = join(dir, 'transcript.jsonl');
    writeFileSync(
      tp,
      JSON.stringify({
        type: 'assistant',
        message: {
          role: 'assistant',
          usage: { input_tokens: 50_000, output_tokens: 10 },
        },
      }) + '\n',
    );
    const { stdout, status } = runStamp({
      session_id: 'no-model-session',
      transcript_path: tp,
    });
    assert.equal(status, 0);
    const parsed = JSON.parse(stdout.trim());
    assert.equal(parsed.continue, true);
    // No model → no display name → no usage → just HH:MM
    assert.match(parsed.systemMessage, TIME_RE);
    assert.ok(!parsed.systemMessage.includes('%'), 'should not include percentage without model');
    assert.ok(!parsed.systemMessage.includes('·'), 'should not include separator without model');
  });

  it('model present but no usedTokens → HH:MM · modelName (no usage)', () => {
    const dir = isolatedDir();
    // Write transcript with model but no usage
    const tp = join(dir, 'transcript.jsonl');
    writeFileSync(
      tp,
      JSON.stringify({
        type: 'assistant',
        message: {
          role: 'assistant',
          model: 'claude-sonnet-4-6',
        },
      }) + '\n',
    );
    const { stdout, status } = runStamp({
      session_id: 'no-usage-session',
      transcript_path: tp,
    });
    assert.equal(status, 0);
    const parsed = JSON.parse(stdout.trim());
    assert.equal(parsed.continue, true);
    assert.match(parsed.systemMessage, TIME_RE);
    assert.ok(parsed.systemMessage.includes('sonnet-4-6') || parsed.systemMessage.includes('Sonnet'));
    assert.ok(!parsed.systemMessage.includes('%'), 'should not include percentage without usedTokens');
  });

  it('reads rate_limits state file and appends 5h/wk to systemMessage', () => {
    const dir = isolatedDir();
    const tp = writeTranscript(dir, 'claude-opus-4-7', 46_000);
    const cachePath = join(dir, 'rate-limits.json');
    const now = Date.now();
    const inFourHours = new Date(now + 4 * 60 * 60 * 1000).toISOString();
    const inSixDays = new Date(now + 6 * 24 * 60 * 60 * 1000).toISOString();
    writeFileSync(cachePath, JSON.stringify({
      fiveHour: { used: 23, resetsAt: inFourHours },
      sevenDay: { used: 67, resetsAt: inSixDays },
      capturedAt: now,
    }));
    const { stdout, status } = runStamp(
      { session_id: 's', transcript_path: tp },
      { CAH_RATE_LIMITS_CACHE: cachePath },
    );
    assert.equal(status, 0);
    const parsed = JSON.parse(stdout.trim());
    assert.match(parsed.systemMessage, /· 5h 23% →[\dч м<]+ · wk 67% →.+ \d{2}\.\d{2} \d{2}:\d{2}$/, parsed.systemMessage);
    assert.ok(!/[█▓░▒▏▎▍▌▋▊▉]/.test(parsed.systemMessage),
      `stamp should be bar-free: ${parsed.systemMessage}`);
  });

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
      const path = `${throttle}.session-${fakeHash}.json`;
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
    const stale = `${throttle}.session-${'c'.repeat(64)}.json`;
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

  it('24 concurrent same-session/request calls emit at most one stamp', async () => {
    const dir = isolatedDir();
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
    const results = await Promise.all(Array.from({ length: 24 }, () => runStampAsync(payload, env)));
    assert.equal(results.filter((result) => result.stdout.trim()).length, 1);
    assert.ok(results.every((result) => result.status === 0));
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

    it('ignores a legacy update marker symlink and sweeps stale raw entries', (t) => {
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
      assert.equal(existsSync(stale), false);
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
      for (let i = 0; i < 70; i++) {
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
});
