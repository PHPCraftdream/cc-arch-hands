import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { formatStatusLine, statusContextUsage, readLastMeasuredContext, readTranscriptStats,
  effectiveContextWindowSize } from '../lib/transcript-stats.js';

function transcript(t, entries) {
  const dir = mkdtempSync(join(tmpdir(), 'cah-context-observation-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, 'transcript.jsonl');
  writeFileSync(path, entries.map((entry) => JSON.stringify(entry)).join('\n') + '\n');
  return path;
}

function assistant(tokens, model = 'claude-opus-5-5') {
  return { type: 'assistant', message: { role: 'assistant', model, usage: {
    input_tokens: tokens, cache_read_input_tokens: 0, cache_creation_input_tokens: 0,
  } } };
}

function iteration(type, inputTokens, overrides = {}) {
  return { type, input_tokens: inputTokens, output_tokens: 1,
    cache_creation_input_tokens: 0, cache_read_input_tokens: 0, ...overrides };
}

describe('effective context window', () => {
  it('caps the model window without enlarging a smaller actual window', () => {
    assert.equal(effectiveContextWindowSize(1000000, '922000'), 922000);
    assert.equal(effectiveContextWindowSize(200000, '922000'), 200000);
    assert.equal(effectiveContextWindowSize(922000, '1000000'), 922000);
    assert.equal(effectiveContextWindowSize(1000000, ' 922000 '), 922000);
    assert.equal(effectiveContextWindowSize(1000000, '100000'), 100000);
    assert.equal(effectiveContextWindowSize(1000000, '1000000'), 1000000);
  });

  it('preserves native limits for absent, invalid or unsupported overrides', () => {
    for (const value of [null, '', ' ', 'NaN', 'Infinity', '0', '-1', '99999', '1000001',
      '922000tokens', '922000.5', '0xE1190', '1e6', '9007199254740993', 922000]) {
      assert.equal(effectiveContextWindowSize(1000000, value), 1000000);
    }
  });

  it('does not invent a window when the actual limit is unknown or invalid', () => {
    for (const value of [null, undefined, 0, -1, Infinity, NaN, '1000000']) {
      assert.equal(effectiveContextWindowSize(value, '922000'), null);
    }
  });
});

describe('status context observations', () => {
  it('uses the last message iteration instead of aggregate usage for context', (t) => {
    const measured = assistant(180000);
    measured.message.usage.iterations = [iteration('message', 80000), iteration('message', 100000),
      iteration('advisor_message', 900000), iteration('compaction', 5000)];
    const path = transcript(t, [measured, assistant(0)]);
    assert.equal(statusContextUsage({ current_usage: measured.message.usage }), 100000);
    assert.equal(readLastMeasuredContext(path).usedTokens, 100000);
    assert.equal(readTranscriptStats(transcript(t, [measured])).usedTokens, 180000);
  });

  it('counts cached input in the last fallback_message iteration, not its output', (t) => {
    const measured = assistant(180000);
    measured.message.usage.iterations = [iteration('message', 80000),
      iteration('fallback_message', 1000, { cache_creation_input_tokens: 2000,
        cache_read_input_tokens: 17000, output_tokens: 5000 })];
    assert.equal(readLastMeasuredContext(transcript(t, [measured])).usedTokens, 20000);
  });

  it('keeps aggregate usage when the last non-service iteration is invalid', () => {
    for (const last of [{}, iteration('other', 1000), iteration('message', 0),
      { type: 'message', input_tokens: 1000 }, iteration('message', NaN)]) {
      assert.equal(statusContextUsage({ current_usage: { input_tokens: 180000,
        iterations: [iteration('message', 80000), last] } }), 180000);
    }
    assert.equal(statusContextUsage({ current_usage: { input_tokens: 0,
      iterations: [iteration('message', 80000)] } }), null);
  });

  it('merges model and usage from one requestId in either order', (t) => {
    const model = { type: 'assistant', requestId: 'req-split',
      message: { role: 'assistant', model: 'claude-opus-5-5' } };
    const usage = { type: 'assistant', requestId: 'req-split',
      message: { role: 'assistant', usage: { input_tokens: 51000 } } };
    for (const entries of [[model, usage], [usage, model]]) {
      const path = transcript(t, [...entries, assistant(0)]);
      assert.deepEqual(readLastMeasuredContext(path, 'claude-opus-5-5'), {
        usedTokens: 51000, modelId: 'claude-opus-5-5', requestId: 'req-split',
      });
    }
  });

  it('merges iterations and model across reverse chunks of the same request', (t) => {
    const path = transcript(t, [
      { type: 'assistant', requestId: 'req-chunks', message: { role: 'assistant', model: 'claude-opus-5-5' } },
      { type: 'user', message: { role: 'user', content: 'tool result' } },
      { type: 'assistant', requestId: 'req-chunks', message: { role: 'assistant', usage: {
        input_tokens: 180000, iterations: [iteration('message', 80000), iteration('message', 100000)],
      } } },
    ]);
    assert.deepEqual(readTranscriptStats(path, { lastMeasuredContext: true,
      contextModelId: 'claude-opus-5-5', chunkBytes: 37 }), {
      usedTokens: 100000, modelId: 'claude-opus-5-5', requestId: 'req-chunks',
    });
  });

  it('skips a fully identified zero-usage request without carrying its partial fields backward', (t) => {
    const path = transcript(t, [assistant(30000),
      { type: 'assistant', requestId: 'req-zero', message: { role: 'assistant', model: 'claude-opus-5-5' } },
      { type: 'assistant', requestId: 'req-zero', message: { role: 'assistant', usage: { input_tokens: 0 } } },
    ]);
    assert.equal(readLastMeasuredContext(path, 'claude-opus-5-5').usedTokens, 30000);
  });

  it('does not merge partial fields across requestId, anonymous, or compaction boundaries', (t) => {
    const model = { type: 'assistant', requestId: 'req-model',
      message: { role: 'assistant', model: 'claude-opus-5-5' } };
    const usage = { type: 'assistant', requestId: 'req-usage',
      message: { role: 'assistant', usage: { input_tokens: 51000 } } };
    for (const entries of [[model, usage], [usage, model],
      [model, { ...usage, requestId: undefined }],
      [{ ...model, requestId: undefined }, usage],
      [model, { type: 'system', subtype: 'compact_boundary' }, { ...usage, requestId: model.requestId }]]) {
      assert.equal(readLastMeasuredContext(transcript(t, entries), 'claude-opus-5-5'), null);
    }
  });

  it('does not publish an incomplete request or cross an unknown model', (t) => {
    const path = transcript(t, [assistant(30000),
      { type: 'assistant', requestId: 'req-unknown', message: { role: 'assistant', usage: { input_tokens: 0 } } },
    ]);
    assert.equal(readLastMeasuredContext(path, 'claude-opus-5-5'), null);
    const partial = transcript(t, [
      { type: 'assistant', requestId: 'req-partial', message: { role: 'assistant', model: 'claude-opus-5-5' } },
      { type: 'assistant', requestId: 'req-partial', message: { role: 'assistant', usage: { input_tokens: 51000 } } },
    ]);
    assert.equal(readTranscriptStats(partial, { lastMeasuredContext: true, maxRecords: 2 }), null);
  });

  it('does not accept conflicting models from the same requestId', (t) => {
    const path = transcript(t, [
      { type: 'assistant', requestId: 'req-conflict', message: { role: 'assistant',
        model: 'claude-opus-5-5', usage: { input_tokens: 30000 } } },
      { type: 'assistant', requestId: 'req-conflict', message: { role: 'assistant', model: 'claude-sonnet-5-5' } },
    ]);
    assert.equal(readLastMeasuredContext(path), null);
  });

  it('reads the latest measured context without changing the normal transcript reader', (t) => {
    const path = transcript(t, [assistant(30000), assistant(0)]);
    assert.equal(readTranscriptStats(path).usedTokens, 0);
    assert.equal(readLastMeasuredContext(path).usedTokens, 30000);
  });

  it('does not cross a compaction boundary', (t) => {
    const path = transcript(t, [assistant(30000), { type: 'system', subtype: 'compact_boundary' }, assistant(0)]);
    assert.equal(readLastMeasuredContext(path), null);
  });

  it('can use measurements after compaction and ignores sidechain context', (t) => {
    const path = transcript(t, [assistant(30000), { type: 'system', subtype: 'compact_boundary' },
      assistant(10000), { ...assistant(90000), isSidechain: true }, assistant(0)]);
    assert.equal(readLastMeasuredContext(path).usedTokens, 10000);
  });

  it('returns the last measured model rather than skipping back to a different model', (t) => {
    const path = transcript(t, [assistant(30000), assistant(10000, 'claude-sonnet-5-5'), assistant(0)]);
    assert.equal(readLastMeasuredContext(path).modelId, 'claude-sonnet-5-5');
  });

  it('does not cross an unknown or different model boundary', (t) => {
    const switched = transcript(t, [assistant(30000), assistant(0, 'claude-sonnet-5-5')]);
    assert.equal(readLastMeasuredContext(switched, 'claude-opus-5-5'), null);
    const anonymous = transcript(t, [assistant(30000), { type: 'assistant', message: { role: 'assistant' } }]);
    assert.equal(readLastMeasuredContext(anonymous, 'claude-opus-5-5'), null);
  });

  it('renders measured context without service labels', () => {
    assert.equal(formatStatusLine({ displayName: 'Opus', usedTokens: 20000, limit: 200000,
      bars: false }), 'Opus · 10% (20k/200k)');
  });

  it('preserves native totals and counts all current input components', () => {
    assert.equal(statusContextUsage({ total_input_tokens: 670000 }), 670000);
    assert.equal(statusContextUsage({ current_usage: { input_tokens: 100, cache_read_input_tokens: 20000,
      cache_creation_input_tokens: 3000, output_tokens: 5000 } }), 23100);
  });

  it('recovers a zero total only from a current positive observation', () => {
    assert.equal(statusContextUsage({ total_input_tokens: 0,
      current_usage: { input_tokens: 120, cache_read_input_tokens: 15000 } }), 15120);
  });

  it('does not claim empty context at startup, compaction or invalid usage', () => {
    for (const data of [null, {}, { total_input_tokens: 0 },
      { total_input_tokens: 0, current_usage: null },
      { total_input_tokens: -1 }, { total_input_tokens: Infinity },
      { current_usage: { input_tokens: -1, cache_read_input_tokens: 15000 } },
      { current_usage: { input_tokens: 0 } }]) {
      assert.equal(statusContextUsage(data), null);
    }
  });

  it('preserves the compact native chat-stamp format by default', () => {
    assert.equal(formatStatusLine({ time: '12:30:00', displayName: 'Opus', usedTokens: 20000,
      limit: 200000, fiveHour: { used: 23, resetsAt: null },
      sevenDay: { used: 67, resetsAt: null }, bars: false }),
    '12:30:00 · Opus · 10% (20k/200k) · 5h 23% · wk 67%');
  });

  it('shows quota usage without a redundant remaining percentage', () => {
    const line = formatStatusLine({ displayName: 'Opus', bars: false,
      fiveHour: { used: 23.5, resetsAt: null }, sevenDay: { used: 67, resetsAt: null } });
    assert.equal(line, 'Opus · 5h 23.5% · wk 67%');
  });

  it('does not invent missing quotas', () => {
    assert.equal(formatStatusLine({ displayName: 'Opus' }), 'Opus');
    assert.equal(formatStatusLine({ displayName: 'Opus', usedTokens: null, limit: 200000 }), 'Opus');
    assert.equal(formatStatusLine({ displayName: 'Opus', usedTokens: null, limit: 200000,
      fiveHour: { used: 25, resetsAt: null }, bars: false }), 'Opus · 5h 25%');
  });
});
