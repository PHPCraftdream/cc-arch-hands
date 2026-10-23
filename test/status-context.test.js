import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, appendFileSync, readFileSync, readdirSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { formatStatusLine, statusContextUsage, readLastMeasuredContext, readTranscriptStats,
  effectiveContextWindowSize, statusContextTraceRecord, writeStatusContextTrace, readStatusLineRateFallback, statusMeasuredContext } from '../lib/transcript-stats.js';

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

describe('measured envelope retention', () => {
  function fixture(t) {
    const path = transcript(t, [assistant(0, 'model-a')]);
    return { path, cache: `${path}.rates.json`, data: { session_id: 'private-session',
      model: { id: 'model-a' }, transcript_path: path } };
  }

  it('retains measured usage across anonymous zero chunks, without refreshing its age', (t) => {
    const { path, cache, data } = fixture(t);
    const now = Date.now();
    assert.equal(statusMeasuredContext(cache, data, 50000, 200000, null, now), 50000);
    appendFileSync(path, JSON.stringify({ type: 'assistant', message: { usage: { input_tokens: 0 } } }) + '\n');
    const diagnostic = {};
    assert.equal(statusMeasuredContext(cache, data, null, 200000, diagnostic, now + 1000), 50000);
    assert.equal(diagnostic.reason, 'cached_measurement');
    assert.equal(statusMeasuredContext(cache, { ...data, session_id: 'other' }, null, 200000, null, now + 1000), null);
    const namespace = join(path, '..', 'context-measured-' + createHash('sha256')
      .update('transcript.jsonl.rates.json').digest('hex'));
    const raw = readdirSync(namespace).filter((name) => /^[a-f0-9]{64}\.json$/.test(name))
      .map((name) => readFileSync(join(namespace, name), 'utf8')).join('');
    assert.doesNotMatch(raw, /private-session|model-a|transcript\.jsonl/);
    assert.equal(statusMeasuredContext(cache, data, null, 200000, diagnostic, now + 3_600_001), null);
    assert.equal(diagnostic.reason, 'stale');
  });

  it('invalidates at compaction and requires a new positive envelope', (t) => {
    const { path, cache, data } = fixture(t);
    statusMeasuredContext(cache, data, 50000, 200000);
    appendFileSync(path, JSON.stringify({ type: 'system', subtype: 'compact_boundary' }) + '\n');
    const diagnostic = {};
    assert.equal(statusMeasuredContext(cache, data, null, 200000, diagnostic), null);
    assert.equal(diagnostic.reason, 'compaction');
    assert.equal(statusMeasuredContext(cache, data, null, 200000), null);
    assert.equal(statusMeasuredContext(cache, data, 10000, 200000), 10000);
    assert.equal(statusMeasuredContext(cache, data, null, 200000), 10000);
  });

  it('invalidates a model switch even when switching back without measurements', (t) => {
    const { cache, data } = fixture(t);
    statusMeasuredContext(cache, data, 50000, 200000);
    assert.equal(statusMeasuredContext(cache, { ...data, model: { id: 'model-b' } }, null, 200000), null);
    assert.equal(statusMeasuredContext(cache, data, null, 200000), null);
  });

  it('rejects changed windows, truncated files, partial records, and scan overflow', (t) => {
    for (const change of ['window', 'truncate', 'partial', 'bytes', 'records', 'model']) {
      const { path, cache, data } = fixture(t);
      statusMeasuredContext(cache, data, 50000, 200000);
      if (change === 'truncate') writeFileSync(path, '');
      if (change === 'partial') appendFileSync(path, '{"type":');
      if (change === 'bytes') appendFileSync(path, ' '.repeat(4 * 1024 * 1024 + 1));
      if (change === 'records') appendFileSync(path, '{}\n'.repeat(10001));
      if (change === 'model') appendFileSync(path, JSON.stringify(assistant(0, 'model-b')) + '\n');
      assert.equal(statusMeasuredContext(cache, data, null, change === 'window' ? 100000 : 200000), null, change);
      assert.equal(statusMeasuredContext(cache, data, null, 200000), null, `${change} stays invalid`);
    }
  });
});

describe('context trace', () => {
  it('reports reader reasons without changing results or exposing record fields', (t) => {
    const measured = assistant(30000);
    const unknown = { type: 'assistant', requestId: 'private-request', message: {
      role: 'assistant', content: 'private-content', usage: { input_tokens: 0 } } };
    const compact = { type: 'system', subtype: 'compact_boundary' };
    for (const [entries, reason] of [
      [[measured], 'measured'],
      [[measured, unknown], 'unknown_model'],
      [[measured, assistant(0, 'other-model')], 'model_mismatch'],
      [[measured, compact], 'compaction'],
      [[assistant(0)], 'no_measurement'],
    ]) {
      const path = transcript(t, entries);
      const diagnostics = {};
      assert.deepEqual(readLastMeasuredContext(path, 'claude-opus-5-5', diagnostics),
        readLastMeasuredContext(path, 'claude-opus-5-5'));
      assert.equal(diagnostics.reason, reason);
      assert.ok(diagnostics.bytes > 0);
      assert.ok(Object.keys(diagnostics).every((key) =>
        ['bytes', 'reason', 'records', 'model', 'modelsMatch'].includes(key)));
      if (reason === 'model_mismatch') {
        assert.equal(diagnostics.modelsMatch, false);
        assert.equal(diagnostics.model.class, 'other');
        assert.match(diagnostics.model.hash, /^[a-f0-9]{64}$/);
      }
      assert.doesNotMatch(JSON.stringify(diagnostics), /private-request|private-content|other-model|claude-opus/);
    }
    const missing = {};
    assert.equal(readLastMeasuredContext(`${transcript(t, [])}.missing`, null, missing), null);
    assert.equal(missing.reason, 'read_error');
  });

  it('distinguishes scan budgets and an unfinished request at EOF', (t) => {
    const path = transcript(t, [assistant(30000), assistant(0)]);
    for (const [limits, reason] of [[{ maxRecords: 1 }, 'record_limit'], [{ maxBytes: 10 }, 'byte_limit']]) {
      const diagnostics = {};
      assert.equal(readTranscriptStats(path, { lastMeasuredContext: true, diagnostics, ...limits }), null);
      assert.equal(diagnostics.reason, reason);
    }
    const diagnostics = {};
    readLastMeasuredContext(transcript(t, [{ type: 'assistant', requestId: 'request',
      message: { usage: { input_tokens: 0 } } }]), null, diagnostics);
    assert.equal(diagnostics.reason, 'unknown_model');
  });

  it('serializes only allowlisted technical data', () => {
    const secret = 'must-not-appear';
    const record = statusContextTraceRecord({ session_id: secret, transcript_path: secret,
      model: { id: secret }, content: secret, context_window: {
        context_window_size: 200000, total_input_tokens: 0, used_percentage: 25,
        current_usage: { input_tokens: 0, content: secret },
      } }, { usedTokens: null, limit: 200000, source: secret, reason: secret,
      scan: { records: 2, bytes: 100, content: secret, model: { class: secret, hash: secret } },
      fiveHour: { used: secret, source: secret, fallback: { reason: secret, ageMs: secret } },
      elapsedMs: 3 }, 60000);
    assert.doesNotMatch(JSON.stringify(record), /must-not-appear/);
    assert.match(record.sessionHash, /^[a-f0-9]{64}$/);
    assert.equal(record.source, 'none');
    assert.equal(record.reason, 'render_error');
    assert.equal(record.usageType, 'object');
    assert.equal(record.usedPercentage, 25);
    assert.equal(statusContextTraceRecord({}, {}).usageType, 'missing');
    assert.equal(statusContextTraceRecord({ context_window: { current_usage: null } }, {}).usageType, 'null');
  });

  it('reports quota fallback decisions without changing the returned slot', (t) => {
    const dir = mkdtempSync(join(tmpdir(), 'cah-quota-decisions-'));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const now = Date.now();
    const hash = createHash('sha256').update('string:session').digest('hex');
    for (const [index, item] of [
      { reason: 'cache_missing', missing: true },
      { reason: 'session_missing', session: '' },
      { reason: 'model_missing', model: '' },
      { reason: 'model_not_claude', model: 'gpt-6-luna' },
      { reason: 'session_mismatch', session: 'other' },
      { reason: 'slot_invalid', used: 101 },
      { reason: 'capture_invalid', at: null },
      { reason: 'stale', at: now - 300_001 },
      { reason: 'stale', at: now - 3_600_001 },
      { reason: 'stale', at: now + 86400_000 },
      { reason: 'reset_missing', reset: null },
      { reason: 'reset_invalid', reset: 'invalid' },
      { reason: 'reset_elapsed', reset: new Date(now).toISOString() },
      { reason: 'cache' },
    ].entries()) {
      const path = join(dir, `rates-${index}.json`);
      if (!item.missing) writeFileSync(path, JSON.stringify({
        fiveHour: { used: item.used ?? 15, resetsAt: Object.hasOwn(item, 'reset')
          ? item.reset : new Date(now + 3_600_000).toISOString() },
        fiveHourCapturedAt: Object.hasOwn(item, 'at') ? item.at : now,
        fiveHourSessionHash: hash, capturedAt: now,
      }));
      const session = item.session ?? 'session';
      const model = item.model ?? 'claude-opus-5-5';
      const diagnostics = {};
      const plain = readStatusLineRateFallback(path, 'fiveHour', session, model, now);
      const traced = readStatusLineRateFallback(path, 'fiveHour', session, model, now, diagnostics);
      assert.deepEqual(traced, plain, item.reason);
      assert.equal(diagnostics.reason, item.reason);
      assert.equal(traced !== null, item.reason === 'cache');
      assert.deepEqual(Object.keys(diagnostics).sort(), ['ageMs', 'reason']);
    }
  });

  it('records quota visibility and model pseudonyms without raw identifiers', () => {
    const record = statusContextTraceRecord({ model: { id: 'private-model' }, rate_limits: {
      five_hour: { used_percentage: 25, resets_at: 'private-reset' },
    } }, { reason: 'model_mismatch', scan: { model: { class: 'claude', hash: 'a'.repeat(64) }, modelsMatch: false },
      fiveHour: { source: 'none', fallback: { reason: 'model_not_claude' } },
      sevenDay: { used: 30, source: 'envelope' } });
    assert.doesNotMatch(JSON.stringify(record), /private-model|private-reset/);
    assert.equal(record.modelsMatch, false);
    assert.equal(record.envelopeModel.class, 'other');
    assert.match(record.envelopeModel.hash, /^[a-f0-9]{64}$/);
    assert.equal(record.fiveHour.modelAllowed, false);
    assert.equal(record.fiveHour.reason, 'model_not_claude');
    assert.equal(record.fiveHour.rendered, false);
    assert.equal(record.sevenDay.rendered, true);
    assert.equal(record.sevenDay.reason, 'envelope');
  });

  it('separates sessions in different buckets at the same minute', (t) => {
    const dir = mkdtempSync(join(tmpdir(), 'cah-session-trace-'));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    let session;
    for (let i = 0; i < 1024; i++) {
      const value = `session-${i}`;
      const hash = createHash('sha256').update(`string:${value}`).digest('hex');
      if (Number.parseInt(hash.slice(0, 2), 16) % 8 !== 0) { session = value; break; }
    }
    assert.ok(session);
    assert.equal(writeStatusContextTrace(dir, {}, {}, 0), true);
    assert.equal(writeStatusContextTrace(dir, { session_id: session }, {}, 0), true);
    const files = readdirSync(dir).filter((name) => /^context-\d+\.json$/.test(name));
    assert.equal(files.length, 2);
    assert.ok(files.every((name) => Number(name.match(/\d+/)[0]) < 256));
  });

  it('keeps 32 bounded slots and preserves foreign or blocked destinations', (t) => {
    const dir = mkdtempSync(join(tmpdir(), 'cah-context-trace-'));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const state = { source: 'none', reason: 'unknown_model' };
    for (let i = 0; i <= 32; i++) {
      assert.equal(writeStatusContextTrace(dir, {}, state, i * 60000), true);
    }
    const slots = readdirSync(dir).filter((name) => /^context-\d+\.json$/.test(name));
    assert.equal(slots.length, 32);
    assert.equal(JSON.parse(readFileSync(join(dir, 'context-0.json'), 'utf8')).capturedAt, 32 * 60000);
    for (const name of slots) assert.ok(readFileSync(join(dir, name)).length < 8192);
    const foreign = join(dir, 'context-0.json');
    writeFileSync(foreign, 'foreign data');
    assert.equal(writeStatusContextTrace(dir, {}, state, 0), false);
    assert.equal(readFileSync(foreign, 'utf8'), 'foreign data');
    const blocked = join(dir, 'not-a-directory');
    writeFileSync(blocked, 'preserved');
    assert.equal(writeStatusContextTrace(blocked, {}, state, 0), false);
    const fence = join(dir, 'context-1.json.cah-owned-publish');
    mkdirSync(fence);
    writeFileSync(join(fence, 'publication.json'), JSON.stringify({ version: 2, ownerPid: process.pid }));
    const before = readFileSync(join(dir, 'context-1.json'), 'utf8');
    assert.equal(writeStatusContextTrace(dir, {}, state, 60000), false);
    assert.equal(readFileSync(join(dir, 'context-1.json'), 'utf8'), before);
  });
});

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
