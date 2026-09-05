import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  modelLimit,
  formatStatusLine,
  currentHhMm,
  currentHhMmSs,
  formatFiveHourReset,
  formatWeeklyReset,
  contextWindowLimit,
  validContextWindowSize,
  makeBar,
  toDisplayName,
} from '../lib/transcript-stats.js';

// ---------------------------------------------------------------------------
// toDisplayName — context-size annotation stripping
// ---------------------------------------------------------------------------

describe('toDisplayName', () => {
  it('strips a trailing context-size annotation ("(1M context)", "(1M)", "(200k)")', () => {
    assert.equal(toDisplayName('Opus 4.8 (1M context)'), 'Opus 4.8');
    assert.equal(toDisplayName('Opus 4.8 (1M)'), 'Opus 4.8');
    assert.equal(toDisplayName('Sonnet 4.6 (200k)'), 'Sonnet 4.6');
    assert.equal(toDisplayName('Fable (Context 1M)'), 'Fable');
  });

  it('strips the "Claude " prefix before stripping the annotation', () => {
    assert.equal(toDisplayName('Claude Opus 4.8 (1M context)'), 'Opus 4.8');
  });

  it('leaves non-size parentheticals alone', () => {
    assert.equal(toDisplayName('Opus (beta)'), 'Opus (beta)');
  });

  it('leaves names without any parenthetical unchanged', () => {
    assert.equal(toDisplayName('Sonnet 5'), 'Sonnet 5');
  });

  it('still converts a raw model id', () => {
    assert.equal(toDisplayName('claude-opus-4-8'), 'Opus 4.8');
  });

  it('converts the current top Fable model id', () => {
    assert.equal(toDisplayName('claude-fable-5-1'), 'Fable 5.1');
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

  it('honors CLAUDE_CODE_DISABLE_1M_CONTEXT only for model-name fallback', () => {
    const old = process.env.CLAUDE_CODE_DISABLE_1M_CONTEXT;
    try {
      process.env.CLAUDE_CODE_DISABLE_1M_CONTEXT = '1';
      assert.equal(modelLimit('claude-opus-5'), 200_000);
      assert.equal(contextWindowLimit('claude-opus-5', 1_000_000), 1_000_000);
    } finally {
      if (old === undefined) delete process.env.CLAUDE_CODE_DISABLE_1M_CONTEXT;
      else process.env.CLAUDE_CODE_DISABLE_1M_CONTEXT = old;
    }
  });

  it('accepts only finite positive actual context sizes', () => {
    assert.equal(validContextWindowSize(1_000_000), 1_000_000);
    assert.equal(validContextWindowSize(0), null);
    assert.equal(validContextWindowSize(Infinity), null);
    assert.equal(contextWindowLimit('claude-opus-5', -1), 1_000_000);
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
