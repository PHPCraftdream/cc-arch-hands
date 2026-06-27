import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

import {
  readTranscriptStats,
  modelLimit,
  formatStatusLine,
  currentHhMm,
  currentHhMmSs,
  formatFiveHourReset,
  formatWeeklyReset,
  readRateLimitsCache,
  makeBar,
} from '../lib/transcript-stats.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

function isolatedDir() {
  return mkdtempSync(join(tmpdir(), 'cah-ts-'));
}

// ---------------------------------------------------------------------------
// readTranscriptStats
// ---------------------------------------------------------------------------

describe('readTranscriptStats', () => {
  it('returns null for missing file', () => {
    const dir = isolatedDir();
    const result = readTranscriptStats(join(dir, 'nonexistent.jsonl'));
    assert.equal(result, null);
  });

  it('finds usedTokens and modelId from separate lines', () => {
    const dir = isolatedDir();
    const tp = join(dir, 'transcript.jsonl');
    writeFileSync(
      tp,
      [
        JSON.stringify({ type: 'user', message: { role: 'user', content: 'hello' } }),
        JSON.stringify({
          type: 'assistant',
          message: {
            role: 'assistant',
            model: 'claude-opus-4-7',
            usage: { input_tokens: 75_000, output_tokens: 20 },
          },
        }),
      ].join('\n') + '\n',
    );
    const result = readTranscriptStats(tp);
    assert.ok(result !== null);
    assert.equal(result.usedTokens, 75_000);
    assert.equal(result.modelId, 'claude-opus-4-7');
  });

  it('sums input_tokens + cache_creation + cache_read for cache-heavy usage', () => {
    // Real-world post-first-turn shape: most context is cached, raw
    // input_tokens is tiny (often 1). The context size IS the sum.
    const dir = isolatedDir();
    const tp = join(dir, 'transcript.jsonl');
    writeFileSync(
      tp,
      JSON.stringify({
        type: 'assistant',
        message: {
          model: 'claude-opus-4-7',
          usage: {
            input_tokens: 1,
            cache_creation_input_tokens: 446,
            cache_read_input_tokens: 540_730,
            output_tokens: 1853,
          },
        },
      }) + '\n',
    );
    const result = readTranscriptStats(tp);
    assert.ok(result !== null);
    assert.equal(result.usedTokens, 1 + 446 + 540_730);
  });

  it('handles usage with only input_tokens (no cache fields)', () => {
    const dir = isolatedDir();
    const tp = join(dir, 'transcript.jsonl');
    writeFileSync(
      tp,
      JSON.stringify({ message: { usage: { input_tokens: 12_345 } } }) + '\n',
    );
    const result = readTranscriptStats(tp);
    assert.equal(result.usedTokens, 12_345);
  });

  it('handles usage with only cache_read_input_tokens (zero input_tokens)', () => {
    const dir = isolatedDir();
    const tp = join(dir, 'transcript.jsonl');
    writeFileSync(
      tp,
      JSON.stringify({ message: { usage: { cache_read_input_tokens: 500_000 } } }) + '\n',
    );
    const result = readTranscriptStats(tp);
    assert.equal(result.usedTokens, 500_000);
  });

  it('finds both fields even when on different lines (scans independently)', () => {
    const dir = isolatedDir();
    const tp = join(dir, 'transcript.jsonl');
    writeFileSync(
      tp,
      [
        JSON.stringify({ type: 'meta', model: 'claude-sonnet-4-6' }),
        JSON.stringify({
          type: 'usage',
          usage: { input_tokens: 50_000, output_tokens: 5 },
        }),
      ].join('\n') + '\n',
    );
    const result = readTranscriptStats(tp);
    assert.ok(result !== null);
    assert.equal(result.usedTokens, 50_000);
    assert.equal(result.modelId, 'claude-sonnet-4-6');
  });

  it('depth-bounded recursion: model 8 levels deep → found', () => {
    const dir = isolatedDir();
    const tp = join(dir, 'transcript.jsonl');
    // Build an object with model nested 8 levels deep (depth 0 through 7 → 8th call has depth=8 which is NOT > 8)
    // depth starts at 0. At depth 8, the check is `depth > 8` → false, so depth 8 is still searched.
    // The object: { a: { b: { c: { d: { e: { f: { g: { h: { model: '...' } } } } } } } } }
    // At each recursive call, depth increments. Root call = depth 0.
    // Finding model.model at level 8: traversal depths are 0,1,2,3,4,5,6,7,8 → 9 levels → depth 8 call has depth=8, 8>8 is false → searches.
    const nested8 = { a: { b: { c: { d: { e: { f: { g: { h: { model: 'claude-haiku-4-5' } } } } } } } } };
    writeFileSync(tp, JSON.stringify(nested8) + '\n');
    const result = readTranscriptStats(tp);
    assert.ok(result !== null);
    assert.equal(result.modelId, 'claude-haiku-4-5');
  });

  it('depth-bounded recursion: model 9 levels deep → NOT found', () => {
    const dir = isolatedDir();
    const tp = join(dir, 'transcript.jsonl');
    // 9 levels of nesting → depth=9 which IS > 8 → stops
    const nested9 = { a: { b: { c: { d: { e: { f: { g: { h: { i: { model: 'claude-haiku-4-5' } } } } } } } } } };
    writeFileSync(tp, JSON.stringify(nested9) + '\n');
    const result = readTranscriptStats(tp);
    // usedTokens and modelId both null → result is null
    assert.equal(result, null);
  });

  it('returns null when file has no parseable lines', () => {
    const dir = isolatedDir();
    const tp = join(dir, 'transcript.jsonl');
    writeFileSync(tp, 'not json\nalso not json\n');
    const result = readTranscriptStats(tp);
    assert.equal(result, null);
  });

  it('partial result: usedTokens found but no model → returns object with modelId null', () => {
    const dir = isolatedDir();
    const tp = join(dir, 'transcript.jsonl');
    writeFileSync(
      tp,
      JSON.stringify({ usage: { input_tokens: 30_000, output_tokens: 5 } }) + '\n',
    );
    const result = readTranscriptStats(tp);
    assert.ok(result !== null);
    assert.equal(result.usedTokens, 30_000);
    assert.equal(result.modelId, null);
  });

  it('ignores usage AND model nested in a user tool-result entry (review L16/P2a)', () => {
    const dir = isolatedDir();
    const tp = join(dir, 'transcript.jsonl');
    writeFileSync(
      tp,
      [
        // real session usage + model on the assistant turn
        JSON.stringify({
          type: 'assistant',
          message: { model: 'claude-sonnet-4-6', usage: { input_tokens: 120_000 } },
        }),
        // a later user entry whose tool result echoes an upstream API response
        // carrying BOTH a different model and a large usage object
        JSON.stringify({
          type: 'user',
          message: { role: 'user', content: 'x' },
          toolUseResult: {
            model: 'claude-opus-4-8',
            usage: { input_tokens: 5, cache_read_input_tokens: 999_000 },
          },
        }),
      ].join('\n') + '\n',
    );
    const result = readTranscriptStats(tp);
    assert.ok(result !== null);
    assert.equal(result.usedTokens, 120_000, 'must skip the user tool-result usage');
    assert.equal(result.modelId, 'claude-sonnet-4-6', 'must not pair with the user-entry model');
  });

  it('reads usage from the tail of a large transcript (review M7)', () => {
    const dir = isolatedDir();
    const tp = join(dir, 'transcript.jsonl');
    // Pad with many bulky non-usage user lines, then the real assistant turn
    // last, so a correct tail read still finds it.
    const filler = [];
    for (let i = 0; i < 5000; i++) {
      filler.push(JSON.stringify({ type: 'user', message: { role: 'user', content: 'x'.repeat(200) } }));
    }
    filler.push(JSON.stringify({
      type: 'assistant',
      message: { model: 'claude-sonnet-4-6', usage: { input_tokens: 42_000 } },
    }));
    writeFileSync(tp, filler.join('\n') + '\n');
    const result = readTranscriptStats(tp);
    assert.ok(result !== null);
    assert.equal(result.usedTokens, 42_000);
    assert.equal(result.modelId, 'claude-sonnet-4-6');
  });
});

// ---------------------------------------------------------------------------
// modelLimit
// ---------------------------------------------------------------------------

describe('modelLimit', () => {
  it('opus → 1_000_000', () => {
    assert.equal(modelLimit('claude-opus-4-8'), 1_000_000);
  });

  it('fable → 1_000_000', () => {
    assert.equal(modelLimit('claude-fable-5'), 1_000_000);
  });

  it('sonnet → 200_000', () => {
    assert.equal(modelLimit('claude-sonnet-4-6'), 200_000);
  });

  it('haiku → 200_000', () => {
    assert.equal(modelLimit('claude-haiku-4-5'), 200_000);
  });

  it('case-insensitive: OPUS → 1_000_000', () => {
    assert.equal(modelLimit('CLAUDE-OPUS-4-8'), 1_000_000);
  });

  it('case-insensitive: SONNET → 200_000', () => {
    assert.equal(modelLimit('Claude-Sonnet-4-6'), 200_000);
  });

  it('unknown model → 200_000 fallback', () => {
    assert.equal(modelLimit('some-mystery-model'), 200_000);
  });

  it('null/empty → 200_000 fallback', () => {
    assert.equal(modelLimit(null), 200_000);
    assert.equal(modelLimit(''), 200_000);
  });
});

// ---------------------------------------------------------------------------
// formatStatusLine
// ---------------------------------------------------------------------------

describe('formatStatusLine', () => {
  const TIME = '14:05';

  it('all four present → full format with usage', () => {
    const result = formatStatusLine({
      time: TIME,
      displayName: 'Opus 4.7',
      usedTokens: 46_000,
      limit: 1_000_000,
    });
    assert.match(result, /^14:05 · Opus 4\.7 · \[[█▏▎▍▌▋▊▉░]{10}\] 4\.6% \(46k\/1M\)$/);
  });

  it('tokens missing → HH:MM · name', () => {
    const result = formatStatusLine({
      time: TIME,
      displayName: 'Sonnet 4.6',
      usedTokens: null,
      limit: null,
    });
    assert.equal(result, '14:05 · Sonnet 4.6');
  });

  it('name and tokens both missing → HH:MM only', () => {
    const result = formatStatusLine({
      time: TIME,
      displayName: null,
      usedTokens: null,
      limit: null,
    });
    assert.equal(result, '14:05');
  });

  it('strips "Claude " prefix from displayName', () => {
    const result = formatStatusLine({
      time: TIME,
      displayName: 'Claude Opus 4.8',
      usedTokens: 670_000,
      limit: 1_000_000,
    });
    assert.match(result, /^14:05 · Opus 4\.8 · \[[█▏▎▍▌▋▊▉░]{10}\] 67% \(670k\/1M\)$/);
    assert.ok(!result.includes('Claude Opus'), 'should not contain "Claude Opus"');
  });

  it('limit 1M renders as "1M" not "1000k"', () => {
    const result = formatStatusLine({
      time: TIME,
      displayName: 'Opus 4.7',
      usedTokens: 50_000,
      limit: 1_000_000,
    });
    assert.ok(result.includes('/1M)'), `expected /1M) in "${result}"`);
    assert.ok(!result.includes('/1000k)'), `should not contain /1000k) in "${result}"`);
  });

  it('limit 200k renders as "200k" not "0M"', () => {
    const result = formatStatusLine({
      time: TIME,
      displayName: 'Sonnet 4.6',
      usedTokens: 100_000,
      limit: 200_000,
    });
    assert.ok(result.includes('/200k)'), `expected /200k) in "${result}"`);
  });

  it('percentage formatted to two decimals, trailing zeros trimmed', () => {
    const r1 = formatStatusLine({ time: TIME, displayName: 'Opus', usedTokens: 670_400, limit: 1_000_000 });
    assert.ok(r1.includes('67.04%'), `expected 67.04% in "${r1}"`);
    const r2 = formatStatusLine({ time: TIME, displayName: 'Opus', usedTokens: 670_000, limit: 1_000_000 });
    assert.ok(r2.includes('67%') && !r2.includes('67.'), `whole percent stays integer in "${r2}"`);
    const r3 = formatStatusLine({ time: TIME, displayName: 'Opus', usedTokens: 678_000, limit: 1_000_000 });
    assert.ok(r3.includes('67.8%') && !r3.includes('67.80'), `trailing zero stripped in "${r3}"`);
  });
});

// ---------------------------------------------------------------------------
// currentHhMm
// ---------------------------------------------------------------------------

describe('currentHhMm', () => {
  it('returns HH:MM format', () => {
    const result = currentHhMm();
    assert.match(result, /^\d{2}:\d{2}$/);
  });

  it('zero-pads hours and minutes', () => {
    const date = new Date(2024, 0, 1, 9, 5, 0); // 09:05
    assert.equal(currentHhMm(date), '09:05');
  });

  it('handles midnight', () => {
    const date = new Date(2024, 0, 1, 0, 0, 0); // 00:00
    assert.equal(currentHhMm(date), '00:00');
  });

  it('handles end of day', () => {
    const date = new Date(2024, 0, 1, 23, 59, 0); // 23:59
    assert.equal(currentHhMm(date), '23:59');
  });
});

describe('currentHhMmSs', () => {
  it('returns HH:MM:SS, zero-padded', () => {
    assert.equal(currentHhMmSs(new Date(2024, 0, 1, 9, 5, 3)), '09:05:03');
    assert.equal(currentHhMmSs(new Date(2024, 0, 1, 0, 0, 0)), '00:00:00');
    assert.equal(currentHhMmSs(new Date(2024, 0, 1, 23, 59, 59)), '23:59:59');
  });
});

// ---------------------------------------------------------------------------
// formatFiveHourReset / formatWeeklyReset
// ---------------------------------------------------------------------------

describe('formatFiveHourReset (remaining time)', () => {
  it('returns "Hч Mм" when more than an hour remains', () => {
    const now = new Date(2024, 5, 1, 10, 0, 0);
    const reset = new Date(2024, 5, 1, 13, 25, 0).toISOString();
    assert.equal(formatFiveHourReset(reset, now), '3ч 25м');
  });

  it('returns "Mм" when less than an hour remains', () => {
    const now = new Date(2024, 5, 1, 10, 0, 0);
    const reset = new Date(2024, 5, 1, 10, 23, 0).toISOString();
    assert.equal(formatFiveHourReset(reset, now), '23м');
  });

  it('returns "<1м" for sub-minute remainder', () => {
    const now = new Date(2024, 5, 1, 10, 0, 0);
    const reset = new Date(2024, 5, 1, 10, 0, 30).toISOString();
    assert.equal(formatFiveHourReset(reset, now), '<1м');
  });

  it('returns "0м" when reset is in the past', () => {
    const now = new Date(2024, 5, 1, 10, 0, 0);
    const reset = new Date(2024, 5, 1, 9, 50, 0).toISOString();
    assert.equal(formatFiveHourReset(reset, now), '0м');
  });

  it('returns null for null / undefined / empty / malformed', () => {
    assert.equal(formatFiveHourReset(null), null);
    assert.equal(formatFiveHourReset(undefined), null);
    assert.equal(formatFiveHourReset(''), null);
    assert.equal(formatFiveHourReset('not-a-date'), null);
  });
});

describe('formatWeeklyReset (weekday + date + time)', () => {
  it('returns "wd DD.MM HH:MM" with zero-padded fields', () => {
    const reset = new Date(2024, 0, 5, 3, 0, 0).toISOString();
    const result = formatWeeklyReset(reset);
    assert.match(result, /^.+ 05\.01 03:00$/, `got "${result}"`);
    assert.ok(result.includes(' '), 'must contain weekday + date');
  });

  it('returns null on malformed input', () => {
    assert.equal(formatWeeklyReset(null), null);
    assert.equal(formatWeeklyReset('x'), null);
  });
});

// ---------------------------------------------------------------------------
// formatStatusLine with rate_limits
// ---------------------------------------------------------------------------

describe('formatStatusLine rate_limits', () => {
  const now = new Date(2024, 5, 1, 10, 0, 0);
  const reset5h = new Date(2024, 5, 1, 14, 30, 0).toISOString(); // 14:30 same day
  const resetWk = new Date(2024, 5, 5, 3, 0, 0).toISOString(); // 4 days out, 03:00

  it('appends 5h and wk parts when both provided', () => {
    const line = formatStatusLine({
      time: null,
      displayName: 'claude-opus-4-7',
      usedTokens: 90_000,
      limit: 200_000,
      fiveHour: { used: 23, resetsAt: reset5h },
      sevenDay: { used: 67, resetsAt: resetWk },
      now,
    });
    assert.match(line, /^Opus 4\.7 · \[[█▏▎▍▌▋▊▉░]{10}\] 45% \(90k\/200k\) · 5h \[[█▏▎▍▌▋▊▉░]{10}\] 23% →[\dч м<]+ · wk \[[█▏▎▍▌▋▊▉░]{10}\] 67% →.+ 05\.06 03:00$/, line);
  });

  it('omits rate_limits parts when missing', () => {
    const line = formatStatusLine({
      time: null,
      displayName: 'claude-opus-4-7',
      usedTokens: 90_000,
      limit: 200_000,
    });
    assert.match(line, /^Opus 4\.7 · \[[█▏▎▍▌▋▊▉░]{10}\] 45% \(90k\/200k\)$/);
  });

  it('appends only one slot when only one is present', () => {
    const line = formatStatusLine({
      time: null,
      displayName: 'claude-opus-4-7',
      usedTokens: null,
      limit: null,
      fiveHour: { used: 0, resetsAt: reset5h },
      sevenDay: null,
      now,
    });
    assert.match(line, /^Opus 4\.7 · 5h \[░{10}\] 0% →[\dч м<]+$/);
  });

  it('formats slot without reset time when resetsAt is null', () => {
    const line = formatStatusLine({
      time: null,
      displayName: 'claude-opus-4-7',
      fiveHour: { used: 50, resetsAt: null },
      now,
    });
    assert.match(line, /^Opus 4\.7 · 5h \[[█▏▎▍▌▋▊▉░]{10}\] 50%$/);
  });

  it('formats percentages to two decimals (trailing zeros trimmed)', () => {
    const line = formatStatusLine({
      time: null,
      displayName: 'claude-opus-4-7',
      fiveHour: { used: 23.7, resetsAt: null },
      sevenDay: { used: 66.43, resetsAt: null },
      now,
    });
    assert.match(line, /^Opus 4\.7 · 5h \[[█▏▎▍▌▋▊▉░]{10}\] 23\.7% · wk \[[█▏▎▍▌▋▊▉░]{10}\] 66\.43%$/);
  });
});

// ---------------------------------------------------------------------------
// makeBar
// ---------------------------------------------------------------------------

describe('makeBar', () => {
  it('0% → 10 empty cells in square brackets, limit mode', () => {
    assert.equal(makeBar(0), '[░░░░░░░░░░]');
  });

  it('100% → 10 full block cells in square brackets, limit mode', () => {
    assert.equal(makeBar(100), '[██████████]');
  });

  it('limit mode uses 8-level subblock partial', () => {
    // 23% → 2 full + a partial near ▍ (round((3/10)*8)=2 → ▎)
    const bar = makeBar(23);
    assert.match(bar, /^\[██[▏▎▍▌▋▊▉]░{7}\]$/, bar);
  });

  it('time mode uses ▓ fill and ▒ partial inside round brackets', () => {
    const bar = makeBar(25, 'time');
    assert.match(bar, /^\(▓▓▒░{7}\)$/, bar);
  });

  it('time mode at 100% → 10 ▓ cells', () => {
    assert.equal(makeBar(100, 'time'), '(▓▓▓▓▓▓▓▓▓▓)');
  });

  it('clamps over-range and under-range', () => {
    assert.equal(makeBar(-5), '[░░░░░░░░░░]');
    assert.equal(makeBar(120), '[██████████]');
  });

  it('limit mode rounds remainder up to full block when ≥ 7.5/8', () => {
    // 99% → 9 full + remainder 9, eighths = round(9/10*8)=7 → ▉
    const bar = makeBar(99);
    assert.equal(bar, '[█████████▉]');
  });
});

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
    });
  });
});
