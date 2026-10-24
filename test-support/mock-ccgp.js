import { createServer } from 'node:http';

// An isolated metadata-only proxy; never starts ccgp or accesses its config.
export async function mockCcgp(t) {
  const state = { mode: 'ok', requests: [], redirectHits: 0, routes: {
    codex: { 'claude-opus-5-5': 'mock-codex-opus', 'claude-sonnet-5-5': 'mock-codex-sonnet' },
    zai: { 'claude-opus-5-5': 'mock-zai-opus', 'claude-sonnet-5-5': 'mock-zai-sonnet' },
  } };
  const server = createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    if (url.pathname === '/redirect-target') { state.redirectHits++; res.end('{}'); return; }
    const match = /^\/call\/unit-secret-(codex|zai)\/model$/.exec(url.pathname);
    const requested = url.searchParams.get('requested');
    state.requests.push({ path: url.pathname, requested });
    if (!match || !requested) { res.writeHead(404); res.end(); return; }
    if (state.mode === 'hang') return;
    if (state.mode === 'disconnect') { req.socket.destroy(); return; }
    if (state.mode === 'missing' || state.mode === 'unavailable') {
      res.writeHead(state.mode === 'missing' ? 404 : 503); res.end(); return;
    }
    if (state.mode === 'redirect') {
      res.writeHead(302, { Location: '/redirect-target' }); res.end(); return;
    }
    if (state.mode === 'invalid-json') { res.end('{invalid'); return; }
    const result = { kind: 'ccgp:model-route:v1', requestedModel: requested,
      backendModel: state.routes[match[1]][requested] ?? requested };
    if (state.mode === 'invalid-contract') result.kind = 'unknown';
    if (state.mode === 'mismatch') result.requestedModel = 'different-model';
    if (state.mode === 'unsafe-label') result.backendModel = '\u001b[31mspoof';
    if (state.mode === 'oversized') result.padding = 'x'.repeat(4096);
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify(result));
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  t.after(() => new Promise((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
    server.closeAllConnections();
  }));
  return { state, baseURL: (profile = 'codex') =>
    `http://127.0.0.1:${server.address().port}/call/unit-secret-${profile}` };
}
