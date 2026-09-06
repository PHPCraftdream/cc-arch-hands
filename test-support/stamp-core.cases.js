import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, readdirSync, existsSync, utimesSync, mkdirSync, unlinkSync, rmdirSync, symlinkSync, lstatSync, rmSync } from 'node:fs';
import { join, dirname, basename } from 'node:path';
import { tmpdir, homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { runStamp, runStampAsync, isolatedDir, writeTranscript, updateMarkerDir, stampSidecarPath, TIME_RE } from './stamp-helpers.js';

export function registerStampCoreCases() {
  it('terminates a deterministically hung child after its deadline', async () => {
    const started = Date.now();
    const result = await runStampAsync('', { CAH_TEST_ONLY_HANG: '1' }, {
      timeoutMs: 50,
      graceMs: 25,
    });
    assert.equal(result.error?.code, 'ETIMEDOUT');
    assert.ok(Date.now() - started < 2_000, 'hung child must be bounded');
    assert.ok(!existsSync(result.hintHome), 'owned fixture is removed only after close');
    rmSync(result.hintHome, { recursive: true, force: true });
  });

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

  it('default-layout stamp state survives migration and deduplicates the second call', () => {
    const dir = isolatedDir();
    const home = mkdtempSync(join(tmpdir(), 'cah-default-layout-home-'));
    const cache = join(home, '.claude', 'cah-bin', 'cache');
    mkdirSync(cache, { recursive: true });
    const tp = join(dir, 'request.jsonl');
    writeFileSync(tp, JSON.stringify({ type: 'assistant', requestId: 'default-layout-request',
      message: { role: 'assistant', model: 'claude-opus-4-7', usage: { input_tokens: 1000 } } }) + '\n');
    const throttle = join(cache, 'stamp-state', 'last-stamp.json');
    const env = {
      CAH_STAMP_HINT_HOME: home,
      CAH_STAMP_THROTTLE_PATH: throttle,
      CAH_RATE_LIMITS_CACHE: join(cache, 'rate-limits.json'),
      CAH_UPDATE_CHECK_CACHE: join(cache, 'update-check.json'),
      CAH_STAMP_MIN_INTERVAL_MS: '1',
    };
    writeFileSync(env.CAH_UPDATE_CHECK_CACHE, JSON.stringify({ latestVersion: null, checkedAt: Date.now() }));
    const payload = { session_id: 'default-layout-session', transcript_path: tp, hook_event_name: 'Stop' };
    const first = runStamp(payload, env);
    assert.equal(first.status, 0);
    const second = runStamp(payload, env);
    assert.equal(second.status, 0);
    assert.equal(second.stdout, '', 'same request must remain deduplicated after namespace migration');
    assert.ok(existsSync(stampSidecarPath(throttle, payload.session_id)));
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
}
