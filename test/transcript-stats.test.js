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
    assert.equal(result, '14:05 · Opus 4.7 · 5% (46k/1M)');
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
    assert.equal(result, '14:05 · Opus 4.8 · 67% (670k/1M)');
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

  it('percentage is rounded', () => {
    const result = formatStatusLine({
      time: TIME,
      displayName: 'Opus',
      usedTokens: 670_400,
      limit: 1_000_000,
    });
    // 670400 / 1000000 * 100 = 67.04 → rounds to 67
    assert.ok(result.includes('67%'), `expected 67% in "${result}"`);
    assert.ok(!result.includes('67.'), 'should not include decimal percentage');
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
