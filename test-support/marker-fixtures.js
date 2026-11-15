import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

// Environment of a child process that exercises the marker capacity code in
// `markerDir` under `home`, with the short test lease the tests rely on.
export function markerEnv(home, markerDir) {
  return {
    ...process.env, HOME: home, USERPROFILE: home, CAH_TEST_ONLY: '1',
    CAH_TEST_MARKER_DIR: markerDir, CAH_TEST_ONLY_MARKER_CAPACITY_LEASE_MS: '100',
  };
}

// The hashed per-session name the hook bins use for markers and sidecars.
export function sessionHash(sessionId) {
  const identity = typeof sessionId === 'string' ? `string:${sessionId}` : 'missing:';
  return createHash('sha256').update(identity, 'utf8').digest('hex');
}

export function writeClaim(path, owner) {
  mkdirSync(path);
  writeFileSync(join(path, 'owner.json'), JSON.stringify(owner));
}

export function readClaim(path) {
  return JSON.parse(readFileSync(join(path, 'owner.json'), 'utf8'));
}

// A JSONL transcript with one assistant line carrying model + usage.input_tokens.
export function writeTranscript(dir, model, usedTokens) {
  const path = join(dir, 'transcript.jsonl');
  const lines = [
    JSON.stringify({ type: 'user', message: { role: 'user', content: 'hi' } }),
    JSON.stringify({
      type: 'assistant',
      message: {
        role: 'assistant',
        model,
        usage: { input_tokens: usedTokens, output_tokens: 10 },
      },
    }),
  ];
  writeFileSync(path, lines.join('\n') + '\n');
  return path;
}
