import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createServer } from 'node:http';
import { proxyModelEndpoint, proxyModelDisplayName } from '../lib/proxy-model.js';

const env = { ANTHROPIC_AUTH_TOKEN: 'ccgp', ANTHROPIC_BASE_URL: 'http://127.0.0.1:60093/call/private-token' };
const route = (requestedModel, backendModel = 'backend-model') => ({ kind: 'ccgp:model-route:v1', requestedModel, backendModel });
function directory(t) {
  const path = mkdtempSync(join(tmpdir(), 'cah-proxy-model-'));
  t.after(() => rmSync(path, { recursive: true, force: true }));
  return path;
}

describe('optional proxy display model', () => {
  it('does nothing without ccgp, including when no CLI or cache directory exists', async () => {
    let called = false;
    assert.equal(await proxyModelDisplayName('opus', '/missing/cache', {
      env: {}, fetchRoute: () => { called = true; throw Error('must not run'); },
    }), null);
    assert.equal(called, false);
  });

  it('rejects remote, redirected, credential-bearing, and malformed endpoint contexts', () => {
    for (const base of ['https://example.test/call/token', 'http://example.test/call/token',
      'http://user:pass@127.0.0.1/call/token', 'http://127.0.0.1/other/token',
      'http://127.0.0.1/call/token?secret=x', 'not a URL']) {
      assert.equal(proxyModelEndpoint({ ...env, ANTHROPIC_BASE_URL: base }, 'opus'), null);
    }
    assert.equal(proxyModelEndpoint(env, 'bad\nmodel'), null);
    assert.equal(proxyModelEndpoint({ ...env, ANTHROPIC_AUTH_TOKEN: 'other' }, 'opus'), null);
  });

  it('caches labels by proxy and alias, without credentials or endpoint URLs', async (t) => {
    const dir = directory(t);
    let calls = 0;
    const fetchRoute = async (url) => { calls++; return route(url.searchParams.get('requested')); };
    const options = { env, nowMs: 1000, fetchRoute };
    assert.equal(await proxyModelDisplayName('opus', dir, options), 'backend-model');
    assert.equal(await proxyModelDisplayName('opus', dir, { ...options, nowMs: 2000 }), 'backend-model');
    assert.equal(calls, 1);
    assert.equal(await proxyModelDisplayName('sonnet', dir, options), 'backend-model');
    assert.equal(calls, 2);
    await proxyModelDisplayName('opus', dir, { ...options, env: { ...env,
      ANTHROPIC_BASE_URL: 'http://127.0.0.1:60093/call/another-private-token' } });
    assert.equal(calls, 3);
    await proxyModelDisplayName('opus', dir, { ...options, nowMs: 62000 });
    assert.equal(calls, 4);
    const raw = readdirSync(dir).filter((name) => /^proxy-model-\d+\.json$/.test(name))
      .map((name) => readFileSync(join(dir, name), 'utf8')).join('');
    assert.doesNotMatch(raw, /private-token|127\.0\.0\.1|60093|requestedModel/);
  });

  it('rejects old or invalid metadata and caches failure briefly', async (t) => {
    for (const result of [{}, route('wrong'), route('opus', '\u001b[31mspoof'), null]) {
      const dir = directory(t);
      let calls = 0;
      const options = { env, nowMs: 1000, fetchRoute: async () => { calls++; return result; } };
      assert.equal(await proxyModelDisplayName('opus', dir, options), null);
      assert.equal(await proxyModelDisplayName('opus', dir, options), null);
      assert.equal(calls, 1);
    }
    assert.equal(await proxyModelDisplayName('opus', directory(t), {
      env, fetchRoute: async () => { throw Error('private-token'); },
    }), null);
  });

  it('recovers from a negative cache after the TTL without real-time waiting', async (t) => {
    const dir = directory(t);
    let calls = 0;
    let available = false;
    const fetchRoute = async () => { calls++; return available ? route('opus') : null; };
    assert.equal(await proxyModelDisplayName('opus', dir, { env, fetchRoute, nowMs: 1000 }), null);
    available = true;
    assert.equal(await proxyModelDisplayName('opus', dir, { env, fetchRoute, nowMs: 60999 }), null);
    assert.equal(calls, 1);
    assert.equal(await proxyModelDisplayName('opus', dir, { env, fetchRoute, nowMs: 61000 }), 'backend-model');
    assert.equal(calls, 2);
  });

  it('uses the local authenticated endpoint without following redirects', async (t) => {
    let redirect = false;
    const server = createServer((req, res) => {
      if (redirect) { res.writeHead(302, { Location: 'http://example.test/' }); res.end(); return; }
      assert.equal(req.url, '/call/private-token/model?requested=opus');
      res.end(JSON.stringify(route('opus')));
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    t.after(() => new Promise((resolve) => server.close(resolve)));
    const localEnv = { ...env, ANTHROPIC_BASE_URL: `http://127.0.0.1:${server.address().port}/call/private-token` };
    assert.equal(await proxyModelDisplayName('opus', directory(t), { env: localEnv }), 'backend-model');
    redirect = true;
    assert.equal(await proxyModelDisplayName('opus', directory(t), { env: localEnv }), null);
  });
});
