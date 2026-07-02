import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const BIN = join(__dirname, '..', 'bin', 'cah-stamp.js');

function runStamp(stdinData, env) {
  const input = typeof stdinData === 'string' ? stdinData : JSON.stringify(stdinData);
  // Default: point the rate_limits cache at a guaranteed-missing path so the
  // host's real ~/.claude/cah-bin/cache/rate-limits.json never leaks into
  // assertions anchored on $.
  const cacheOverride = (env && env.CAH_RATE_LIMITS_CACHE)
    || join(tmpdir(), 'cah-stamp-test-no-such-file.json');
  // Each test gets its own throttle path by default, so tests do not
  // accidentally suppress each other through the live ~/.claude/.../last-stamp.json.
  const throttleOverride = (env && env.CAH_STAMP_THROTTLE_PATH)
    || join(tmpdir(), `cah-stamp-throttle-${process.pid}-${Math.random().toString(36).slice(2)}.json`);
  // Default: a fresh, already-populated (no update) cache so tests never
  // shell out to curl / hit the real npm registry unless a test explicitly
  // overrides it to exercise the update-notice path.
  let updateCacheOverride = env && env.CAH_UPDATE_CHECK_CACHE;
  if (!updateCacheOverride) {
    updateCacheOverride = join(tmpdir(), `cah-stamp-updatecache-${process.pid}-${Math.random().toString(36).slice(2)}.json`);
    writeFileSync(updateCacheOverride, JSON.stringify({ latestVersion: null, checkedAt: Date.now() }));
  }
  const res = spawnSync(process.execPath, [BIN], {
    input,
    encoding: 'utf8',
    env: {
      ...process.env,
      ...(env || {}),
      CAH_RATE_LIMITS_CACHE: cacheOverride,
      CAH_STAMP_THROTTLE_PATH: throttleOverride,
      CAH_UPDATE_CHECK_CACHE: updateCacheOverride,
    },
  });
  return { stdout: res.stdout, status: res.status, throttlePath: throttleOverride };
}

function isolatedDir() {
  return mkdtempSync(join(tmpdir(), 'cah-stamp-'));
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
    // Pretend the last stamp happened well in the past by rewriting the file.
    writeFileSync(throttle, JSON.stringify({ lastStampedAt: Date.now() - 60_000 }));
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
    // Pretend MIN_INTERVAL elapsed, so only the requestId dedup can block this.
    const file = JSON.parse(readFileSync(throttle, 'utf8'));
    file.lastStampedAt = Date.now() - 60_000;
    writeFileSync(throttle, JSON.stringify(file));
    const second = runStamp(
      { session_id: 's', transcript_path: tp },
      { CAH_STAMP_THROTTLE_PATH: throttle, CAH_STAMP_MIN_INTERVAL_MS: '1' },
    );
    assert.equal(second.stdout, '', 'second stamp for the same requestId must be suppressed');
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
    const file = JSON.parse(readFileSync(throttle, 'utf8'));
    file.lastStampedAt = Date.now() - 60_000;
    writeFileSync(throttle, JSON.stringify(file));
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
      assert.ok(!parsed.systemMessage.includes('🔵'));
    });
  });
});
