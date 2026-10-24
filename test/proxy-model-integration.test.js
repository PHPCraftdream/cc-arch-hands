import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { DEFAULT_CHILD_DEADLINE_MS } from '../test-support/process-batches.js';
import { mockCcgp } from '../test-support/mock-ccgp.js';

function fixture(t, proxy) {
  const home = mkdtempSync(join(tmpdir(), 'cah-proxy-integration-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const cache = join(home, '.claude', 'cah-bin', 'cache');
  mkdirSync(cache, { recursive: true });
  const update = join(cache, 'update-check.json');
  writeFileSync(update, JSON.stringify({ latestVersion: null, checkedAt: Date.now() }));
  const transcript = join(home, 'transcript.jsonl');
  const payload = { session_id: 'mock-session', transcript_path: transcript,
    model: { id: 'claude-opus-5-5', display_name: 'Original Opus' },
    context_window: { context_window_size: 200000, total_input_tokens: 20000 } };
  const env = { ...process.env, HOME: home, USERPROFILE: home, PATH: '',
    ANTHROPIC_AUTH_TOKEN: 'ccgp', ANTHROPIC_BASE_URL: proxy.baseURL(),
    CAH_TEST_ONLY: '0', CLAUDE_CODE_AUTO_COMPACT_WINDOW: '', CAH_CONTEXT_TRACE_DIR: '',
    CLAUDE_CONFIG_DIR: join(home, 'claude-config'),
    CAH_STAMP_HINT_HOME: home, CAH_RATE_LIMITS_CACHE: join(cache, 'rate-limits.json'),
    CAH_STAMP_THROTTLE_PATH: join(cache, 'stamp-state', 'last-stamp.json'), CAH_STAMP_MIN_INTERVAL_MS: '1',
    CAH_UPDATE_CHECK_CACHE: update };
  for (const key of Object.keys(env)) {
    if (key !== 'PATH' && key.toUpperCase() === 'PATH') delete env[key];
  }
  let turn = 0;
  const setModel = (model) => {
    payload.model = { id: model, display_name: model.includes('sonnet') ? 'Original Sonnet' : 'Original Opus' };
    writeFileSync(transcript, JSON.stringify({ type: 'assistant', requestId: `mock-request-${++turn}`,
      message: { role: 'assistant', model, usage: { input_tokens: 20000 } } }) + '\n');
  };
  setModel(payload.model.id);
  const run = (kind, event = 'Stop', overrides = {}) => new Promise((resolve, reject) => {
    const file = fileURLToPath(new URL(`../bin/cah-${kind}.js`, import.meta.url));
    const child = execFile(process.execPath, [file], { env: { ...env, ...overrides },
      timeout: DEFAULT_CHILD_DEADLINE_MS, maxBuffer: 64 * 1024 }, (error, stdout, stderr) => {
      if (error) { reject(error); return; }
      resolve({ stdout: stdout.trim(), stderr });
    });
    child.stdin.on('error', () => {});
    child.stdin.end(JSON.stringify({ ...payload, hook_event_name: event }));
  });
  return { home, cache, payload, env, run, setModel };
}

function stampLine(result) {
  assert.equal(result.stderr, '');
  return JSON.parse(result.stdout).systemMessage;
}

function labelRecords(cache) {
  return readdirSync(cache).filter((name) => /^proxy-model-\d+\.json$/.test(name))
    .map((name) => readFileSync(join(cache, name), 'utf8'));
}

describe('ccgp metadata mock through companion binaries', () => {
  it('shares a fetched statusLine label with both hook events without duplicate requests', async (t) => {
    const proxy = await mockCcgp(t);
    const f = fixture(t, proxy);
    const status = await f.run('status');
    assert.equal(status.stderr, '');
    assert.match(status.stdout, /^mock-codex-opus · .*10% \(20k\/200k\)/);
    assert.equal(proxy.state.requests.length, 1);
    const first = stampLine(await f.run('stamp', 'PostToolUse'));
    assert.match(first, / · mock-codex-opus · 10% \(20k\/200k\)/);
    assert.doesNotMatch(first, /\[(?:l|m|h|x|xx)\]|5h |wk /);
    assert.equal((await f.run('stamp', 'Stop')).stdout, '');
    assert.equal(proxy.state.requests.length, 1);
    const raw = labelRecords(f.cache).join('');
    assert.doesNotMatch(raw, /unit-secret-|127\.0\.0\.1|requestedModel|ANTHROPIC_AUTH_TOKEN/);
  });

  it('fetches for a cold Stop hook and reuses its label in the statusLine', async (t) => {
    const proxy = await mockCcgp(t);
    const f = fixture(t, proxy);
    assert.match(stampLine(await f.run('stamp')), / · mock-codex-opus · /);
    assert.match((await f.run('status')).stdout, /^mock-codex-opus · /);
    assert.equal(proxy.state.requests.length, 1);
  });

  it('resolves a changed model and a different profile without inheriting another route', async (t) => {
    const proxy = await mockCcgp(t);
    const f = fixture(t, proxy);
    assert.match((await f.run('status')).stdout, /^mock-codex-opus · /);
    f.setModel('claude-sonnet-5-5');
    assert.match((await f.run('status')).stdout, /^mock-codex-sonnet · /);
    assert.match((await f.run('status', 'Stop', { ANTHROPIC_BASE_URL: proxy.baseURL('zai') })).stdout,
      /^mock-zai-sonnet · /);
    assert.equal(proxy.state.requests.length, 3);
    assert.deepEqual(proxy.state.requests.map((request) => request.requested),
      ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-sonnet-5-5']);
  });

  it('keeps native labels without contacting ccgp even when its metadata cache is populated', async (t) => {
    const proxy = await mockCcgp(t);
    const f = fixture(t, proxy);
    await f.run('status');
    assert.equal(proxy.state.requests.length, 1);
    const status = await f.run('status', 'Stop', { ANTHROPIC_AUTH_TOKEN: '' });
    assert.match(status.stdout, /^Original Opus · /);
    const stamp = stampLine(await f.run('stamp', 'Stop', { ANTHROPIC_AUTH_TOKEN: '' }));
    assert.match(stamp, /Opus/);
    assert.doesNotMatch(stamp, /mock-codex/);
    assert.equal(proxy.state.requests.length, 1);
  });

  it('falls back for old, unavailable, malformed, oversized, or redirecting proxy responses', async (t) => {
    for (const mode of ['missing', 'unavailable', 'invalid-json', 'invalid-contract',
      'mismatch', 'unsafe-label', 'oversized', 'redirect', 'disconnect', 'hang']) {
      await t.test(mode, async (t) => {
        const proxy = await mockCcgp(t);
        proxy.state.mode = mode;
        const f = fixture(t, proxy);
        const status = await f.run('status');
        assert.equal(status.stderr, '');
        assert.match(status.stdout, /^Original Opus · .*10% \(20k\/200k\)/);
        assert.match(stampLine(await f.run('stamp')), /Opus/);
        assert.equal(proxy.state.requests.length, 1, 'the hook must reuse the negative metadata cache');
        assert.equal(proxy.state.redirectHits, 0);
        const records = labelRecords(f.cache).map((raw) => JSON.parse(raw));
        assert.equal(records.length, 1);
        assert.equal(records[0].label, null);
      });
    }
  });

  it('recovers from an old proxy after negative-cache expiry', async (t) => {
    const proxy = await mockCcgp(t);
    proxy.state.mode = 'missing';
    const f = fixture(t, proxy);
    assert.match((await f.run('status')).stdout, /^Original Opus · /);
    proxy.state.mode = 'ok';
    assert.match((await f.run('status')).stdout, /^Original Opus · /);
    assert.equal(proxy.state.requests.length, 1);
    for (const name of readdirSync(f.cache).filter((name) => /^proxy-model-\d+\.json$/.test(name))) {
      const path = join(f.cache, name);
      const record = JSON.parse(readFileSync(path, 'utf8'));
      writeFileSync(path, JSON.stringify({ ...record, capturedAt: 0 }));
    }
    assert.match(stampLine(await f.run('stamp')), /mock-codex-opus/);
    assert.match((await f.run('status')).stdout, /^mock-codex-opus · /);
    assert.equal(proxy.state.requests.length, 2);
  });

  it('does not query metadata for a deduplicated hook, even after its cache expires', async (t) => {
    const proxy = await mockCcgp(t);
    const f = fixture(t, proxy);
    assert.match(stampLine(await f.run('stamp', 'PostToolUse')), /mock-codex-opus/);
    for (const name of readdirSync(f.cache).filter((name) => /^proxy-model-\d+\.json$/.test(name))) {
      const path = join(f.cache, name);
      const record = JSON.parse(readFileSync(path, 'utf8'));
      writeFileSync(path, JSON.stringify({ ...record, capturedAt: 0 }));
    }
    assert.equal((await f.run('stamp', 'Stop')).stdout, '');
    assert.equal(proxy.state.requests.length, 1);
  });
});
