import { createHash } from 'node:crypto';
import { get } from 'node:http';
import { join } from 'node:path';
import { captureRegularFileSnapshot, writeFileAtomic } from './fsutil.js';
import { lstatMaybe } from './fs-atomic-identity.js';

const TTL_MS = 60_000;
const TIMEOUT_MS = 200;
const MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._:/@+\[\]\-]{0,255}$/;

// Only the explicit ccgp launcher context enables this optional integration.
export function proxyModelEndpoint(env, requested) {
  if (env?.ANTHROPIC_AUTH_TOKEN !== 'ccgp' || typeof requested !== 'string' || !MODEL_ID.test(requested)) return null;
  try {
    const url = new URL(env.ANTHROPIC_BASE_URL);
    if (url.protocol !== 'http:' || !['127.0.0.1', '[::1]', 'localhost'].includes(url.hostname)
        || url.username || url.password || url.search || url.hash
        || !/^\/call\/[A-Za-z0-9_-]+\/?$/.test(url.pathname)) return null;
    url.pathname = url.pathname.replace(/\/$/, '') + '/model';
    url.searchParams.set('requested', requested);
    return url;
  } catch {
    return null;
  }
}

function fetchRoute(url) {
  return new Promise((resolve) => {
    let request;
    let timer;
    let finished = false;
    const finish = (value) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      resolve(value);
    };
    timer = setTimeout(() => { finish(null); request?.destroy(); }, TIMEOUT_MS);
    try {
      request = get(url, { agent: false }, (response) => {
        if (response.statusCode !== 200) { finish(null); response.destroy(); return; }
        let size = 0;
        const chunks = [];
        response.on('data', (chunk) => {
          size += chunk.length;
          if (size > 4096) { finish(null); response.destroy(); return; }
          chunks.push(chunk);
        });
        response.on('error', () => finish(null));
        response.on('end', () => {
          try { finish(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
          catch { finish(null); }
        });
      });
      request.on('error', () => finish(null));
    } catch {
      finish(null);
    }
  });
}

// Cache only a label and a hash of the authenticated endpoint, never its URL.
export async function proxyModelDisplayName(requested, directory, options = {}) {
  const url = proxyModelEndpoint(options.env ?? process.env, requested);
  if (!url) return null;
  const now = options.nowMs ?? Date.now();
  const key = createHash('sha256').update(url.href).digest('hex');
  const path = join(directory, `proxy-model-${Number.parseInt(key.slice(0, 2), 16) % 64}.json`);
  let snapshot;
  try {
    const entry = lstatMaybe(path);
    if (entry && (!entry.isFile() || entry.size > 4096n)) return null;
    snapshot = captureRegularFileSnapshot(path);
    if (snapshot.present && snapshot.content.length > 4096) return null;
    if (snapshot.present) {
      const record = JSON.parse(snapshot.content.toString('utf8'));
      if (record?.kind !== 'cah-proxy-model:v1') return null;
      if (record.key === key && Number.isFinite(record.capturedAt)
          && record.capturedAt <= now && now - record.capturedAt < TTL_MS
          && (record.label === null || (typeof record.label === 'string' && MODEL_ID.test(record.label)))) return record.label;
    }
  } catch {
    return null;
  }
  let label = null;
  try {
    const result = await (options.fetchRoute ?? fetchRoute)(url);
    if (result?.kind === 'ccgp:model-route:v1' && result.requestedModel === requested
        && typeof result.backendModel === 'string' && MODEL_ID.test(result.backendModel)) label = result.backendModel;
  } catch { /* leave the original label */ }
  try {
    writeFileAtomic(path, JSON.stringify({ kind: 'cah-proxy-model:v1', key, label, capturedAt: now }) + '\n', {
      expectedDestination: snapshot.expectedDestination, waitForFence: false, mode: 0o600,
    });
  } catch { /* best effort */ }
  return label;
}
