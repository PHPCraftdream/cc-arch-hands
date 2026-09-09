import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { readTranscriptStats } from '../lib/transcript-stats.js';
import { isolatedDir } from './transcript-test-helpers.js';

// ---------------------------------------------------------------------------
// readTranscriptStats
// ---------------------------------------------------------------------------

describe('readTranscriptStats', () => {
  it('skips non-object JSON records without losing the newest assistant stats', () => {
    const dir = isolatedDir();
    const path = join(dir, 'transcript.jsonl');
    const turn = { type: 'assistant', requestId: 'newest', message: {
      model: 'claude-opus-4-7', usage: { input_tokens: 42 },
    } };
    for (const noise of [null, false, 42, 'noise', []]) {
      writeFileSync(path, `${JSON.stringify(turn)}\n${JSON.stringify(noise)}\n`);
      assert.deepEqual(readTranscriptStats(path), {
        usedTokens: 42, modelId: 'claude-opus-4-7', requestId: 'newest',
      });
    }
  });

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

  it('does not mix usage and model from different assistant turns', () => {
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
    assert.equal(result, null);
  });

  it('merges split model and usage records from the newest requestId', () => {
    const dir = isolatedDir();
    const tp = join(dir, 'transcript.jsonl');
    writeFileSync(tp, [
      JSON.stringify({
        type: 'assistant',
        requestId: 'req-split',
        message: { role: 'assistant', model: 'claude-sonnet-4-6' },
      }),
      JSON.stringify({
        type: 'assistant',
        requestId: 'req-split',
        message: { role: 'assistant', usage: { input_tokens: 51_000 } },
      }),
    ].join('\n') + '\n');
    assert.deepEqual(readTranscriptStats(tp), {
      usedTokens: 51_000,
      modelId: 'claude-sonnet-4-6',
      requestId: 'req-split',
    });
  });

  it('merges one request across multiple small reverse chunks', () => {
    const dir = isolatedDir();
    const tp = join(dir, 'transcript.jsonl');
    const lines = [JSON.stringify({
      type: 'assistant',
      requestId: 'req-many-chunks',
      message: { role: 'assistant', model: { id: 'claude-opus-4-7' } },
    })];
    for (let i = 0; i < 20; i++) {
      lines.push(JSON.stringify({ type: 'user', message: { role: 'user', content: 'x'.repeat(80) } }));
    }
    lines.push(JSON.stringify({
      type: 'assistant',
      requestId: 'req-many-chunks',
      message: { role: 'assistant', usage: { input_tokens: 53_000 } },
    }));
    writeFileSync(tp, lines.join('\n') + '\n');
    assert.deepEqual(readTranscriptStats(tp, { chunkBytes: 37, maxBytes: 4096 }), {
      usedTokens: 53_000,
      modelId: 'claude-opus-4-7',
      requestId: 'req-many-chunks',
    });
  });

  it('does not fill a newest request from a preceding different requestId', () => {
    const dir = isolatedDir();
    const tp = join(dir, 'transcript.jsonl');
    writeFileSync(tp, [
      JSON.stringify({
        type: 'assistant',
        requestId: 'req-old',
        message: { role: 'assistant', model: 'claude-opus-4-7', usage: { input_tokens: 40_000 } },
      }),
      JSON.stringify({
        type: 'assistant',
        requestId: 'req-new',
        message: { role: 'assistant', usage: { input_tokens: 50_000 } },
      }),
    ].join('\n') + '\n');
    assert.deepEqual(readTranscriptStats(tp), {
      usedTokens: 50_000,
      modelId: null,
      requestId: 'req-new',
    });
  });

  it('content-only newest request blocks stale usage and model', () => {
    const dir = isolatedDir();
    const tp = join(dir, 'transcript.jsonl');
    writeFileSync(tp, [
      JSON.stringify({
        type: 'assistant',
        requestId: 'req-old',
        message: { role: 'assistant', model: 'claude-opus-4-7', usage: { input_tokens: 40_000 } },
      }),
      JSON.stringify({
        type: 'assistant',
        requestId: 'req-content-only',
        message: { role: 'assistant', content: [{ type: 'text', text: 'still generating' }] },
      }),
    ].join('\n') + '\n');
    assert.deepEqual(readTranscriptStats(tp), {
      usedTokens: null,
      modelId: null,
      requestId: 'req-content-only',
    });
  });

  it('content-only newest assistant without requestId blocks stale older stats', () => {
    const dir = isolatedDir();
    const tp = join(dir, 'transcript.jsonl');
    writeFileSync(tp, [
      JSON.stringify({
        type: 'assistant',
        requestId: 'req-old',
        message: { role: 'assistant', model: 'claude-opus-4-7', usage: { input_tokens: 40_000 } },
      }),
      JSON.stringify({
        type: 'assistant',
        message: { role: 'assistant', content: [{ type: 'text', text: 'anonymous newest turn' }] },
      }),
    ].join('\n') + '\n');
    assert.equal(readTranscriptStats(tp), null);
  });

  it('ignores fake usage/model under content tool_use input', () => {
    const dir = isolatedDir();
    const tp = join(dir, 'transcript.jsonl');
    writeFileSync(tp, [
      JSON.stringify({
        type: 'assistant',
        requestId: 'req-real',
        message: { role: 'assistant', model: 'claude-sonnet-4-6', usage: { input_tokens: 44_000 } },
      }),
      JSON.stringify({
        type: 'assistant',
        requestId: 'req-fake-only',
        message: {
          role: 'assistant',
          content: [{ type: 'tool_use', input: {
            usage: { input_tokens: 999_000 },
            model: 'claude-opus-4-8',
          } }],
        },
      }),
    ].join('\n') + '\n');
    assert.deepEqual(readTranscriptStats(tp), {
      usedTokens: null,
      modelId: null,
      requestId: 'req-fake-only',
    });
  });

  it('returns null requestId for the newest context-bearing turn', () => {
    const dir = isolatedDir();
    const tp = join(dir, 'transcript.jsonl');
    writeFileSync(tp, [
      JSON.stringify({
        type: 'assistant',
        requestId: 'old-request',
        message: { role: 'assistant', model: 'claude-opus-4-7', usage: { input_tokens: 40_000 } },
      }),
      JSON.stringify({
        type: 'assistant',
        message: { role: 'assistant', model: 'claude-opus-4-7', usage: { input_tokens: 50_000 } },
      }),
    ].join('\n') + '\n');
    const result = readTranscriptStats(tp);
    assert.deepEqual(result, { usedTokens: 50_000, modelId: 'claude-opus-4-7', requestId: null });
  });

  it('does not inherit missing fields when the newest context record has no requestId', () => {
    const dir = isolatedDir();
    const tp = join(dir, 'transcript.jsonl');
    writeFileSync(tp, [
      JSON.stringify({
        type: 'assistant',
        requestId: 'req-old',
        message: { role: 'assistant', model: 'claude-opus-4-7', usage: { input_tokens: 40_000 } },
      }),
      JSON.stringify({
        type: 'assistant',
        message: { role: 'assistant', usage: { input_tokens: 50_000 } },
      }),
    ].join('\n') + '\n');
    assert.deepEqual(readTranscriptStats(tp), {
      usedTokens: 50_000,
      modelId: null,
      requestId: null,
    });
  });

  it('scans across chunk boundaries only to merge the same requestId', () => {
    const dir = isolatedDir();
    const tp = join(dir, 'transcript.jsonl');
    const lines = [JSON.stringify({
      type: 'assistant',
      requestId: 'req-tail-split',
      message: { role: 'assistant', model: 'claude-opus-4-7' },
    })];
    for (let i = 0; i < 500; i++) {
      lines.push(JSON.stringify({ type: 'user', message: { role: 'user', content: 'x'.repeat(200) } }));
    }
    lines.push(JSON.stringify({
      type: 'assistant',
      requestId: 'req-tail-split',
      message: { role: 'assistant', usage: { input_tokens: 52_000 } },
    }));
    const raw = lines.join('\n') + '\n';
    writeFileSync(tp, raw);
    let fullRead = false;
    const result = readTranscriptStats(tp, {
      readWholeFile() {
        fullRead = true;
        return raw;
      },
    });
    assert.equal(fullRead, false, 'the scanner must not fall back to a whole-file read');
    assert.deepEqual(result, {
      usedTokens: 52_000,
      modelId: 'claude-opus-4-7',
      requestId: 'req-tail-split',
    });
  });

  it('does not fall back to the prefix only for an optional missing requestId', () => {
    const dir = isolatedDir();
    const tp = join(dir, 'transcript.jsonl');
    const prefix = Array.from({ length: 5000 }, (_, i) =>
      JSON.stringify({ type: 'user', message: { role: 'user', content: `${i}-${'x'.repeat(200)}` } }));
    prefix.push(JSON.stringify({
      type: 'assistant',
      message: { role: 'assistant', model: 'claude-sonnet-4-6', usage: { input_tokens: 42_000 } },
    }));
    writeFileSync(tp, prefix.join('\n') + '\n');
    let fullRead = false;
    const result = readTranscriptStats(tp, {
      readWholeFile() {
        fullRead = true;
        return '';
      },
    });
    assert.deepEqual(result, { usedTokens: 42_000, modelId: 'claude-sonnet-4-6', requestId: null });
    assert.equal(fullRead, false, 'missing optional requestId must not read the transcript prefix');
  });

  it('does not recurse into arbitrary nested JSON for model extraction', () => {
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
    assert.equal(result, null);
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

  it('keeps reverse reads within the configured byte budget', () => {
    const dir = isolatedDir();
    const tp = join(dir, 'transcript.jsonl');
    const prefix = Array.from({ length: 2000 }, () =>
      JSON.stringify({ type: 'user', message: { role: 'user', content: 'padding' } }));
    const raw = prefix.concat(JSON.stringify({
      type: 'assistant',
      requestId: 'req-bounded',
      message: { role: 'assistant', model: 'claude-haiku-4-5', usage: { input_tokens: 12_000 } },
    })).join('\n') + '\n';
    writeFileSync(tp, raw);
    const result = readTranscriptStats(tp, {
      chunkBytes: 97,
      maxBytes: 512,
    });
    assert.deepEqual(result, {
      usedTokens: 12_000,
      modelId: 'claude-haiku-4-5',
      requestId: 'req-bounded',
    });
  });
});
