import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, existsSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { readRateLimitsCache, rateLimitsContextPath } from '../lib/transcript-stats.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const BIN = join(__dirname, '..', 'bin', 'cah-status.js');

function run(stdinData, env) {
  // Redirect both caches the status bin derives from homedir() to temp files
  // (or guaranteed-missing paths) so the host's real ~/.claude/cah-bin/cache/
  // stays untouched by tests and the exact-match assertions cannot be
  // influenced by whatever happens to sit in the user's update-check cache.
  const cacheOverride = (env && env.CAH_RATE_LIMITS_CACHE)
    || join(tmpdir(), `cah-status-test-${process.pid}-${Math.random().toString(36).slice(2)}.json`);
  const updateCacheOverride = (env && env.CAH_UPDATE_CHECK_CACHE)
    || join(tmpdir(), `cah-status-test-update-${process.pid}-${Math.random().toString(36).slice(2)}.json`);
  // A fresh cache recording an ancient version: no registry fetch is attempted
  // (checkedAt is inside the TTL) and no update suffix can appear regardless
  // of the real CURRENT_VERSION. Never clobber a cache the caller provided.
  if (!(env && env.CAH_UPDATE_CHECK_CACHE)) {
    writeFileSync(updateCacheOverride, JSON.stringify({ latestVersion: '0.0.1', checkedAt: Date.now() }));
  }
  const res = spawnSync(process.execPath, [BIN], {
    input: typeof stdinData === 'string' ? stdinData : JSON.stringify(stdinData),
    encoding: 'utf8',
    env: {
      ...process.env,
      CLAUDE_CODE_AUTO_COMPACT_WINDOW: '',
      CAH_CONTEXT_TRACE_DIR: '',
      ...(env || {}),
      CAH_RATE_LIMITS_CACHE: cacheOverride,
      CAH_UPDATE_CHECK_CACHE: updateCacheOverride,
    },
  });
  return {
    stdout: res.stdout.trimEnd(),
    status: res.status,
    cachePath: cacheOverride,
    updateCachePath: updateCacheOverride,
  };
}

function sessionHash(sessionId) {
  return createHash('sha256').update(`string:${sessionId}`, 'utf8').digest('hex');
}

function makePayload(overrides = {}) {
  return {
    hook_event_name: 'Status',
    session_id: 'test-session',
    model: { id: 'claude-opus-4-8', display_name: 'Opus 4.8' },
    context_window: {
      used_percentage: 67,
      remaining_percentage: 33,
      context_window_size: 1_000_000,
      total_input_tokens: 670_000,
      total_output_tokens: 1204,
    },
    ...overrides,
  };
}

describe('cah-status bin', () => {
  it('renders live context and quotas despite an unsupported cache publication fence', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cah-status-busy-cache-'));
    try {
      const cache = join(dir, 'rate-limits.json');
      const fence = `${cache}.cah-owned-publish`;
      const proof = JSON.stringify({ version: 2, ownerPid: process.pid });
      writeFileSync(cache, '{}\n');
      mkdirSync(fence);
      writeFileSync(join(fence, 'publication.json'), proof);
      const { stdout, status } = run(makePayload({ rate_limits: {
        five_hour: { used_percentage: 15 },
        seven_day: { used_percentage: 88 },
      } }), { CAH_RATE_LIMITS_CACHE: cache });
      assert.equal(status, 0);
      assert.match(stdout, /67% \(670k\/1M\)/);
      assert.match(stdout, /5h .*15%/);
      assert.match(stdout, /wk .*88%/);
      assert.equal(readFileSync(cache, 'utf8'), '{}\n');
      assert.equal(readFileSync(join(fence, 'publication.json'), 'utf8'), proof);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('keeps rendering when only the session context cache is blocked', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cah-status-busy-context-'));
    try {
      const cache = join(dir, 'rate-limits.json');
      const context = rateLimitsContextPath(cache, 'test-session');
      const fence = `${context}.cah-owned-publish`;
      mkdirSync(dirname(context), { recursive: true });
      writeFileSync(context, '{}\n');
      mkdirSync(fence);
      const proof = JSON.stringify({ version: 2, ownerPid: process.pid });
      writeFileSync(join(fence, 'publication.json'), proof);
      const { stdout, status } = run(makePayload({ rate_limits: {
        five_hour: { used_percentage: 0 },
        seven_day: { used_percentage: 88 },
      } }), { CAH_RATE_LIMITS_CACHE: cache });
      assert.equal(status, 0);
      assert.match(stdout, /67% \(670k\/1M\)/);
      assert.match(stdout, /5h .*0%/);
      assert.match(stdout, /wk .*88%/);
      assert.equal(JSON.parse(readFileSync(cache, 'utf8')).sevenDay.used, 88);
      assert.equal(readFileSync(context, 'utf8'), '{}\n');
      assert.equal(readFileSync(join(fence, 'publication.json'), 'utf8'), proof);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('full payload → "<model> · X% (Nk/Mk)" with no clock', () => {
    const { stdout, status } = run(makePayload());
    assert.equal(status, 0);
    assert.match(stdout, /^Opus 4\.8 · \[[█▏▎▍▌▋▊▉░]{10}\] 67% \(670k\/1M\)$/);
    assert.ok(!/^\d{2}:\d{2}/.test(stdout), 'must NOT start with HH:MM — clock was dropped to dodge Windows cold-start race');
  });

  it('traces context decisions without changing stdout or capturing private fields', (t) => {
    const dir = mkdtempSync(join(tmpdir(), 'cah-status-trace-'));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const path = join(dir, 'transcript.jsonl');
    const secret = 'private-trace-marker';
    writeFileSync(path, JSON.stringify({ type: 'assistant', message: {
      role: 'assistant', model: 'gpt-6-luna', content: secret, usage: { input_tokens: 50000 },
    } }) + '\n');
    const traceDir = join(dir, 'trace');
    const payload = makePayload({ model: { id: 'gpt-6-luna', display_name: 'Codex' },
      session_id: secret, transcript_path: path, content: secret, context_window: {
        context_window_size: 200000, current_usage: null,
      } });
    const env = { CAH_RATE_LIMITS_CACHE: join(dir, 'rates.json') };
    const plain = run(payload, env);
    assert.ok(!existsSync(traceDir));
    const traced = run(payload, { ...env, CAH_CONTEXT_TRACE_DIR: traceDir });
    assert.equal(traced.status, 0);
    assert.equal(traced.stdout, plain.stdout);
    const records = readdirSync(traceDir).map((name) => readFileSync(join(traceDir, name), 'utf8'));
    assert.ok(records.length > 0);
    for (const raw of records) {
      assert.doesNotMatch(raw, /private-trace-marker|transcript\.jsonl|gpt-6-luna/);
      const record = JSON.parse(raw);
      assert.equal(record.reason, 'measured');
      assert.equal(record.source, 'transcript');
      assert.equal(record.usedTokens, 50000);
      assert.equal(record.limit, 200000);
      assert.equal(record.usageType, 'null');
      assert.equal(record.contextRendered, true);
    }
    for (const [overrides, reason] of [
      [{ context_window: null }, 'window_invalid'],
      [{ model: { display_name: 'Codex' } }, 'model_missing'],
      [{ transcript_path: undefined }, 'path_missing'],
      [{ model: { id: 'other-model', display_name: 'Other' } }, 'model_mismatch'],
    ]) {
      const destination = join(dir, reason);
      const result = run({ ...payload, ...overrides }, { ...env, CAH_CONTEXT_TRACE_DIR: destination });
      assert.equal(result.status, 0);
      for (const name of readdirSync(destination)) {
        const record = JSON.parse(readFileSync(join(destination, name), 'utf8'));
        assert.equal(record.reason, reason);
        assert.equal(record.contextRendered, false);
      }
    }
    const blocked = join(dir, 'blocked');
    writeFileSync(blocked, 'preserved');
    assert.equal(run(payload, { ...env, CAH_CONTEXT_TRACE_DIR: blocked }).stdout, plain.stdout);
    assert.equal(readFileSync(blocked, 'utf8'), 'preserved');
  });

  it('traces quota decisions without changing panel output', (t) => {
    const dir = mkdtempSync(join(tmpdir(), 'cah-quota-trace-'));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const reset = new Date(Date.now() + 3_600_000).toISOString();
    const rates = { five_hour: { used_percentage: 15, resets_at: reset },
      seven_day: { used_percentage: 67, resets_at: reset } };
    for (const [index, item] of [
      { overrides: { rate_limits: rates }, reason: 'envelope', shown: true, weekly: true },
      { overrides: { rate_limits: rates, model: { display_name: 'Unknown' } }, reason: 'model_missing', shown: false, weekly: true },
      { overrides: { rate_limits: rates, model: { id: 'gpt-6-luna', display_name: 'Codex' } }, reason: 'model_not_claude', shown: false, weekly: true },
      { overrides: { rate_limits: null }, reason: 'cache_missing', shown: false, weekly: false },
      { overrides: { rate_limits: null }, reason: 'cache', shown: true, weekly: false, seed: true },
      { overrides: { rate_limits: { five_hour: { used_percentage: 15, resets_at: 1e20 } } },
        reason: 'cache_missing', shown: false, weekly: false, extractionFailed: true },
    ].entries()) {
      const cachePath = join(dir, `rates-${index}.json`);
      if (item.seed) writeFileSync(cachePath, JSON.stringify({ fiveHour: { used: 15, resetsAt: reset },
        fiveHourCapturedAt: Date.now(), fiveHourSessionHash: sessionHash('test-session'), capturedAt: Date.now() }));
      const payload = makePayload(item.overrides);
      const env = { CAH_RATE_LIMITS_CACHE: cachePath };
      const plain = run(payload, env);
      const trace = join(dir, `trace-${index}`);
      const traced = run(payload, { ...env, CAH_CONTEXT_TRACE_DIR: trace });
      assert.equal(plain.status, 0);
      assert.equal(traced.status, 0);
      assert.equal(traced.stdout, plain.stdout);
      assert.equal(traced.stdout.includes('5h '), item.shown);
      assert.equal(traced.stdout.includes('wk '), item.weekly);
      const records = readdirSync(trace).filter((name) => /^context-\d+\.json$/.test(name));
      assert.equal(records.length, 1);
      const record = JSON.parse(readFileSync(join(trace, records[0]), 'utf8'));
      assert.equal(record.fiveHour.reason, item.reason);
      assert.equal(record.fiveHour.rendered, item.shown);
      assert.equal(record.sevenDay.rendered, item.weekly);
      assert.equal(record.rateExtractionFailed, !!item.extractionFailed);
    }
  });

  it('caps the displayed window at the inherited compact window without rewriting the raw cache', () => {
    const { stdout, cachePath } = run(makePayload({ context_window: {
      context_window_size: 1000000, total_input_tokens: 831000,
    } }), { CLAUDE_CODE_AUTO_COMPACT_WINDOW: '922000' });
    assert.match(stdout, /90\.13% \(831k\/922k\)$/);
    assert.equal(readRateLimitsCache(cachePath, Date.now(), 'test-session').contextWindowSize, 1000000);
  });

  it('does not enlarge a smaller envelope window or accept an invalid compact window', () => {
    const small = run(makePayload({ context_window: {
      context_window_size: 200000, total_input_tokens: 100000,
    } }), { CLAUDE_CODE_AUTO_COMPACT_WINDOW: '922000' });
    assert.match(small.stdout, /50% \(100k\/200k\)$/);
    const invalid = run(makePayload(), { CLAUDE_CODE_AUTO_COMPACT_WINDOW: '922000tokens' });
    assert.match(invalid.stdout, /67% \(670k\/1M\)$/);
  });

  it('Sonnet 200K → correct format without clock', () => {
    const { stdout, status } = run(
      makePayload({
        model: { id: 'claude-sonnet-4-6', display_name: 'Sonnet 4.6' },
        context_window: {
          used_percentage: 92,
          remaining_percentage: 8,
          context_window_size: 200_000,
          total_input_tokens: 184_000,
          total_output_tokens: 500,
        },
      }),
    );
    assert.equal(status, 0);
    assert.match(stdout, /^Sonnet 4\.6 · \[[█▏▎▍▌▋▊▉░]{10}\] 92% \(184k\/200k\)$/);
  });

  it('context_window: null → only model name', () => {
    const { stdout, status } = run(makePayload({ context_window: null }));
    assert.equal(status, 0);
    assert.equal(stdout, 'Opus 4.8');
  });

  it('missing model entirely → fallback dash', () => {
    const { stdout, status } = run({ hook_event_name: 'Status', context_window: null });
    assert.equal(status, 0);
    assert.equal(stdout, '—', 'never produce empty stdout — harness would blank the statusbar');
  });

  it('empty stdin → fallback dash', () => {
    const { stdout, status } = run('');
    assert.equal(status, 0);
    assert.equal(stdout, '—');
  });

  it('malformed JSON stdin → fallback dash', () => {
    const { stdout, status } = run('{not valid json');
    assert.equal(status, 0);
    assert.equal(stdout, '—');
  });

  it('display_name "Claude Opus 4.6" → trimmed to "Opus 4.6"', () => {
    const { stdout, status } = run(
      makePayload({ model: { id: 'claude-opus-4-6', display_name: 'Claude Opus 4.6' } }),
    );
    assert.equal(status, 0);
    assert.match(stdout, /^Opus 4\.6 ·/);
    assert.ok(!stdout.includes('Claude Opus'), 'should not contain "Claude Opus"');
  });

  it('used_percentage with decimals (67.4) → rounded to 67%', () => {
    const payload = makePayload({
      context_window: {
        used_percentage: 67.4,
        remaining_percentage: 32.6,
        context_window_size: 1_000_000,
        total_input_tokens: 670_000,
        total_output_tokens: 1000,
      },
    });
    const { stdout, status } = run(payload);
    assert.equal(status, 0);
    assert.match(stdout, /\] 67% /);
    assert.ok(!stdout.includes('67.4'), 'should not include decimal percentage');
  });

  it('keeps a recent 5h meter through a temporary envelope omission', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cah-status-5h-fallback-'));
    try {
      const cachePath = join(dir, 'rate-limits.json');
      const capturedAt = Date.now();
      const reset = new Date(capturedAt + 20 * 60 * 1000).toISOString();
      writeFileSync(cachePath, JSON.stringify({
        version: 4,
        fiveHour: { used: 15, resetsAt: reset },
        fiveHourCapturedAt: capturedAt,
        fiveHourSessionHash: sessionHash('test-session'),
        sevenDay: null,
        sevenDayCapturedAt: null,
        sevenDaySessionHash: null,
        capturedAt,
      }));

      const { stdout, status } = run(makePayload({ rate_limits: {
        five_hour: null,
        seven_day: { used_percentage: 88, resets_at: new Date(capturedAt + 5 * 86400_000).toISOString() },
      } }), { CAH_RATE_LIMITS_CACHE: cachePath });
      assert.equal(status, 0);
      assert.match(stdout, /5h .*15%/);
      assert.match(stdout, /wk .*88%/);
      const cached = JSON.parse(readFileSync(cachePath, 'utf8'));
      assert.equal(cached.fiveHour.used, 15);
      assert.equal(cached.fiveHourCapturedAt, capturedAt, 'weekly refresh must not refresh 5h age');
      assert.equal(cached.fiveHourSessionHash, sessionHash('test-session'));
      assert.ok(cached.sevenDayCapturedAt > capturedAt);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('keeps its own 5h fallback after another session publishes quota', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cah-status-quota-sessions-'));
    try {
      const cachePath = join(dir, 'rate-limits.json');
      const env = { CAH_RATE_LIMITS_CACHE: cachePath };
      const reset = new Date(Date.now() + 3_600_000).toISOString();
      const rates = (used) => ({ five_hour: { used_percentage: used, resets_at: reset },
        seven_day: { used_percentage: 88, resets_at: reset } });
      assert.equal(run(makePayload({ session_id: 'session-a', rate_limits: rates(15) }), env).status, 0);
      assert.equal(run(makePayload({ session_id: 'session-b', rate_limits: rates(42) }), env).status, 0);
      const result = run(makePayload({ session_id: 'session-a', rate_limits: {
        five_hour: null, seven_day: rates(15).seven_day,
      } }), env);
      assert.equal(result.status, 0);
      assert.match(result.stdout, /5h .*15%/);
      assert.doesNotMatch(result.stdout, /5h .*42%/);
      const codex = run(makePayload({ session_id: 'session-a',
        model: { id: 'gpt-6-luna', display_name: 'GPT-6 Luna' }, rate_limits: null }), env);
      assert.equal(codex.status, 0);
      assert.doesNotMatch(codex.stdout, /5h /);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('does not show Claude 5h quota in a Codex session', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cah-status-codex-quota-'));
    try {
      const cachePath = join(dir, 'rate-limits.json');
      const now = Date.now();
      writeFileSync(cachePath, JSON.stringify({
        version: 4,
        fiveHour: { used: 15, resetsAt: new Date(now + 20 * 60 * 1000).toISOString() },
        fiveHourCapturedAt: now,
        fiveHourSessionHash: sessionHash('claude-session'),
        sevenDay: null,
        sevenDayCapturedAt: null,
        sevenDaySessionHash: null,
        capturedAt: now,
      }));
      const { stdout, status } = run(makePayload({
        session_id: 'codex-session',
        model: { id: 'gpt-6-luna', display_name: 'GPT-6 Luna' },
        rate_limits: {
          five_hour: { used_percentage: 15, resets_at: new Date(now + 20 * 60 * 1000).toISOString() },
          seven_day: { used_percentage: 88, resets_at: new Date(now + 5 * 86400_000).toISOString() },
        },
      }), { CAH_RATE_LIMITS_CACHE: cachePath });
      assert.equal(status, 0);
      assert.doesNotMatch(stdout, /5h /);
      assert.match(stdout, /wk .*88%/);
      const cached = JSON.parse(readFileSync(cachePath, 'utf8'));
      assert.equal(cached.fiveHour, null);
      assert.equal(cached.fiveHourSessionHash, null);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('does not reuse an expired 5h reset or a stale cached percentage', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cah-status-5h-expired-'));
    try {
      const cachePath = join(dir, 'rate-limits.json');
      const now = Date.now();
      const weekly = { used_percentage: 88, resets_at: new Date(now + 5 * 86400_000).toISOString() };
      const payload = makePayload({ rate_limits: { five_hour: null, seven_day: weekly } });
      const base = {
        version: 4,
        fiveHour: { used: 15, resetsAt: new Date(now - 1000).toISOString() },
        fiveHourCapturedAt: now,
        fiveHourSessionHash: sessionHash('test-session'),
        sevenDay: null,
        sevenDayCapturedAt: null,
        sevenDaySessionHash: null,
        capturedAt: now,
      };
      writeFileSync(cachePath, JSON.stringify(base));
      assert.doesNotMatch(run(payload, { CAH_RATE_LIMITS_CACHE: cachePath }).stdout, /5h /);

      base.fiveHour.resetsAt = new Date(now + 20 * 60 * 1000).toISOString();
      base.fiveHourCapturedAt = now - 5 * 60 * 1000 - 1;
      base.capturedAt = now;
      writeFileSync(cachePath, JSON.stringify(base));
      assert.doesNotMatch(run(payload, { CAH_RATE_LIMITS_CACHE: cachePath }).stdout, /5h /);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('rate_limits present → appends 5h / wk parts and writes the cache file', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cah-status-rl-'));
    const cachePath = join(dir, 'rate-limits.json');
    const now = Date.now();
    const inFourHours = new Date(now + 4 * 60 * 60 * 1000).toISOString();
    const inSixDays = new Date(now + 6 * 24 * 60 * 60 * 1000).toISOString();
    const payload = makePayload({
      rate_limits: {
        five_hour: { used_percentage: 23, resets_at: inFourHours },
        seven_day: { used_percentage: 67, resets_at: inSixDays },
      },
    });
    const { stdout, status } = run(payload, { CAH_RATE_LIMITS_CACHE: cachePath });
    assert.equal(status, 0);
    assert.match(stdout, /· 5h \[[█▏▎▍▌▋▊▉░]{10}\] 23% →[\dч м<]+ · wk \[[█▏▎▍▌▋▊▉░]{10}\] 67% →.+ \d{2}\.\d{2} \d{2}:\d{2}$/, stdout);
    assert.ok(existsSync(cachePath), 'cache file should be written');
    const cached = JSON.parse(readFileSync(cachePath, 'utf8'));
    assert.equal(cached.fiveHour.used, 23);
    assert.equal(cached.sevenDay.used, 67);
    assert.equal(typeof cached.capturedAt, 'number');
  });

  it('recovers cache-aware current usage when the total is a zero placeholder', () => {
    const { stdout } = run(makePayload({ context_window: {
      total_input_tokens: 0, context_window_size: 200000,
      current_usage: { input_tokens: 100, cache_read_input_tokens: 19900 },
    } }));
    assert.match(stdout, /10% \(20k\/200k\)/);
  });

  it('omits unavailable context at startup or compaction instead of a false zero', () => {
    const { stdout } = run(makePayload({ context_window: {
      total_input_tokens: 0, context_window_size: 200000, current_usage: null,
    } }));
    assert.equal(stdout, 'Opus 4.8');
  });

  it('renders a normal bar for transcript fallback and stops at compaction or a model switch', (t) => {
    const dir = mkdtempSync(join(tmpdir(), 'cah-status-context-'));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const path = join(dir, 'transcript.jsonl');
    const measured = { type: 'assistant', message: { role: 'assistant', model: 'claude-opus-4-8',
      usage: { input_tokens: 50000, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } } };
    writeFileSync(path, JSON.stringify(measured) + '\n');
    const payload = makePayload({ transcript_path: path, context_window: {
      total_input_tokens: 0, context_window_size: 200000,
      current_usage: { input_tokens: 0, output_tokens: 0 },
    } });
    assert.match(run(payload).stdout, /^Opus 4\.8 · \[[█▏▎▍▌▋▊▉░]{10}\] 25% \(50k\/200k\)$/);
    assert.equal(run({ ...payload, model: { id: 'claude-sonnet-4-6', display_name: 'Sonnet 4.6' } }).stdout,
      'Sonnet 4.6');
    assert.match(run({ ...payload, context_window: { ...payload.context_window, current_usage: null } }).stdout,
      /25% \(50k\/200k\)$/);
    writeFileSync(path, JSON.stringify(measured) + '\n'
      + JSON.stringify({ type: 'system', subtype: 'compact_boundary' }) + '\n');
    assert.equal(run(payload).stdout, 'Opus 4.8');
  });

  for (const [label, usage] of [
    ['null', { current_usage: null }],
    ['missing', {}],
    ['zero', { current_usage: { input_tokens: 0, output_tokens: 0 } }],
  ]) {
    it(`recovers Codex context with ${label} usage without crossing model or compaction boundaries`, (t) => {
      const dir = mkdtempSync(join(tmpdir(), 'cah-status-codex-context-'));
      t.after(() => rmSync(dir, { recursive: true, force: true }));
      const path = join(dir, 'transcript.jsonl');
      const model = 'gpt-6-luna';
      const measured = { type: 'assistant', message: { role: 'assistant', model,
        usage: { input_tokens: 1000, cache_read_input_tokens: 49000 } } };
      const compact = { type: 'system', subtype: 'compact_boundary' };
      const payload = makePayload({ model: { id: model, display_name: 'Codex' },
        transcript_path: path, context_window: {
          total_input_tokens: 0, context_window_size: 200000, ...usage,
        } });
      const env = { CAH_RATE_LIMITS_CACHE: join(dir, 'rates.json') };
      const writeRecords = (...records) => writeFileSync(path,
        records.map((record) => JSON.stringify(record)).join('\n') + '\n');

      writeRecords(measured);
      assert.match(run(payload, env).stdout, /25% \(50k\/200k\)$/);
      assert.doesNotMatch(run(payload, env).stdout, /5h /);
      assert.equal(run({ ...payload, model: { id: 'another-model', display_name: 'Other' } }, env).stdout,
        'Other');
      assert.equal(run({ ...payload, model: { id: '', display_name: 'Unknown' } }, env).stdout,
        'Unknown');
      for (const context_window of [null, { total_input_tokens: 0, ...usage },
        { context_window_size: 0, ...usage }]) {
        assert.equal(run({ ...payload, context_window }, env).stdout, 'Codex');
      }

      writeRecords(measured, { type: 'assistant', message: { role: 'assistant',
        model: 'another-model', usage: { input_tokens: 0 } } });
      assert.equal(run(payload, env).stdout, 'Codex');
      writeRecords(measured, { type: 'assistant', message: { role: 'assistant',
        usage: { input_tokens: 0 } } });
      assert.equal(run(payload, env).stdout, 'Codex');
      writeRecords(measured, compact);
      assert.equal(run(payload, env).stdout, 'Codex');
      writeRecords(measured, compact, measured);
      assert.match(run(payload, env).stdout, /25% \(50k\/200k\)$/);
      writeRecords({ ...measured, message: { ...measured.message, usage: { input_tokens: 0 } } });
      assert.equal(run(payload, env).stdout, 'Codex');
    });
  }

  it('renders split request usage from the last message iteration, not aggregate totals', (t) => {
    const dir = mkdtempSync(join(tmpdir(), 'cah-status-iterations-'));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const path = join(dir, 'transcript.jsonl');
    const iteration = (input_tokens, type = 'message') => ({ type, input_tokens,
      output_tokens: 100, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 });
    const records = [
      { type: 'assistant', requestId: 'req-split', message: { role: 'assistant', model: 'claude-opus-4-8' } },
      { type: 'assistant', requestId: 'req-split', message: { role: 'assistant', usage: {
        input_tokens: 180000, iterations: [iteration(80000), iteration(100000), iteration(5000, 'compaction')],
      } } },
    ];
    writeFileSync(path, records.map((record) => JSON.stringify(record)).join('\n') + '\n');
    const { stdout } = run(makePayload({ transcript_path: path, context_window: {
      total_input_tokens: 0, context_window_size: 200000,
      current_usage: { input_tokens: 0, output_tokens: 0 },
    } }));
    assert.match(stdout, /^Opus 4\.8 · \[[█▏▎▍▌▋▊▉░]{10}\] 50% \(100k\/200k\)$/);
  });

  it('ignores prompt cache statistics in the status line', () => {
    const { stdout } = run(makePayload({ prompt_cache: { hit_ratio: 0.85 } }));
    assert.match(stdout, /^Opus 4\.8 · \[[█▏▎▍▌▋▊▉░]{10}\] 67% \(670k\/1M\)$/);
  });

  it('no rate_limits → no 5h/wk parts but caches the valid context window', () => {
    const { stdout, cachePath } = run(makePayload());
    assert.ok(!stdout.includes('5h'), `should not contain 5h: ${stdout}`);
    assert.ok(!stdout.includes(' wk '), `should not contain wk: ${stdout}`);
    assert.ok(existsSync(cachePath), 'valid envelope context should be cached');
    assert.equal(
      JSON.parse(readFileSync(rateLimitsContextPath(cachePath, 'test-session'), 'utf8')).contextWindowSize,
      1_000_000,
    );
  });

  it('two sessions retain distinct context windows and do not share quota slots', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cah-status-sessions-'));
    const cachePath = join(dir, 'rate-limits.json');
    const rates = {
      five_hour: { used_percentage: 23, resets_at: new Date(Date.now() + 3_600_000).toISOString() },
      seven_day: { used_percentage: 67, resets_at: new Date(Date.now() + 86_400_000).toISOString() },
    };
    run(makePayload({ session_id: 'session-a', rate_limits: rates }), { CAH_RATE_LIMITS_CACHE: cachePath });
    run(makePayload({ session_id: 'session-b', rate_limits: null, context_window: {
      context_window_size: 200_000,
      total_input_tokens: 100_000,
    } }), { CAH_RATE_LIMITS_CACHE: cachePath });

    const a = readRateLimitsCache(cachePath, Date.now(), 'session-a');
    const b = readRateLimitsCache(cachePath, Date.now(), 'session-b');
    assert.equal(a.contextWindowSize, 1_000_000);
    assert.equal(b.contextWindowSize, 200_000);
    assert.equal(a.fiveHour.used, 23);
    assert.equal(b.fiveHour, null);
    assert.equal(b.sevenDay, null);
  });

  it('appends the update suffix from an isolated fixture cache with a newer latestVersion', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cah-status-update-'));
    const updateCache = join(dir, 'update-check.json');
    writeFileSync(updateCache, JSON.stringify({ latestVersion: '99.0.0', checkedAt: Date.now() }));
    const { stdout, status } = run(makePayload(), { CAH_UPDATE_CHECK_CACHE: updateCache });
    assert.equal(status, 0);
    assert.ok(stdout.endsWith('· 🔵 v99.0.0'), `update suffix missing: ${stdout}`);
    const withoutSuffix = stdout.slice(0, -' · 🔵 v99.0.0'.length);
    assert.match(withoutSuffix, /^Opus 4\.8 · \[[█▏▎▍▌▋▊▉░]{10}\] 67% \(670k\/1M\)$/);
  });

  it('never derives a path from the real home directory', () => {
    const fakeHome = mkdtempSync(join(tmpdir(), 'cah-status-fake-home-'));
    const { stdout, status } = run(makePayload(), { HOME: fakeHome, USERPROFILE: fakeHome });
    assert.equal(status, 0);
    assert.equal(existsSync(join(fakeHome, '.claude')), false,
      'the bin must not create anything under homedir() when both cache overrides are set');
    assert.match(stdout, /^Opus 4\.8 · \[[█▏▎▍▌▋▊▉░]{10}\] 67% \(670k\/1M\)$/);
  });
});
