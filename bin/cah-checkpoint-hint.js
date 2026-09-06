#!/usr/bin/env node
// cah-checkpoint-hint — Claude Code Stop hook.

import { readFileSync, writeSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
import { readTranscriptStats, contextWindowLimit, readRateLimitsCache, validContextWindowSize } from '../lib/transcript-stats.js';
import {
  sessionHash, markerNamespace, migrateMarkerState, pruneMarkers, claimMarker,
  markerClaimOwned, releaseMarkerClaim, publishMarker, finishMarkerTransaction,
  abortMarkerTransaction,
} from '../lib/marker-state.js';

const THRESHOLD = 0.9;
const THRESHOLD_PCT = Math.round(THRESHOLD * 100);
const MESSAGE = JSON.stringify({
  continue: true,
  systemMessage: `[hint] Context at ${THRESHOLD_PCT}%. Run /checkpoint to save state before auto-compact.`,
});
const MARKER_PREFIX = 'cah-hint-shown-';
const MARKER_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const MARKER_CLAIM_TTL_MS = 30_000;
const MARKER_MAX_SESSIONS = 64;
const MARKER_NAME_RE = /^cah-hint-shown-[a-f0-9]{64}$/;
const MARKER_SCAN_CAP = MARKER_MAX_SESSIONS * 3 + 8;
const MARKER_NAMESPACE = 'hint-markers';
const RATE_LIMITS_CACHE = process.env.CAH_RATE_LIMITS_CACHE
  || join(homedir(), '.claude', 'cah-bin', 'cache', 'rate-limits.json');

function markerOptions(markerDir, testHooks = {}) {
  return { markerDir, namespace: MARKER_NAMESPACE, prefix: MARKER_PREFIX,
    ttlMs: MARKER_TTL_MS, claimTtlMs: MARKER_CLAIM_TTL_MS,
    maxSessions: MARKER_MAX_SESSIONS, scanCap: MARKER_SCAN_CAP,
    markerNameRe: MARKER_NAME_RE, ownerTestEnv: 'CAH_HINT_OWNER_MAX_LEASE_MS',
    testInterlock: testHooks.testInterlock };
}

function markDelivered(claim, markerDir, testHooks = {}) {
  if (!markerClaimOwned(claim)) return false;
  if (process.env.CAH_TEST_ONLY === '1'
      && (process.env.CAH_TEST_ONLY_MARKER_CRASH === 'before-durable'
        || process.env.CAH_TEST_ONLY_MARKER_CRASH === 'before-marker'
        || process.env.CAH_TEST_ONLY_MARKER_WRITE_FAILURE === 'crash')) {
    abortMarkerTransaction(claim);
    process.exit(91);
  }
  const ok = publishMarker(claim,
    JSON.stringify({ nonce: claim.owner.nonce || claim.owner.token, deliveredAt: Date.now() }) + '\n',
    markerOptions(markerDir, testHooks));
  if (ok && process.env.CAH_TEST_ONLY === '1'
      && (process.env.CAH_TEST_ONLY_CAPACITY_CRASH === 'after-marker-publish'
        || process.env.CAH_TEST_ONLY_MARKER_CRASH === 'after-marker-publish')) process.exit(94);
  return ok;
}

export function main(testHooks = {}) {
  let payload;
  try { payload = JSON.parse(readFileSync(0, 'utf8')); } catch { return; }
  if (payload.stop_hook_active === true) return;
  const sessionId = payload.session_id;
  const transcriptPath = payload.transcript_path;
  if (!sessionId || !transcriptPath) return;

  const home = process.env.CAH_HINT_HOME || homedir();
  const markerDir = markerNamespace(home, MARKER_NAMESPACE);
  const options = markerOptions(markerDir, testHooks);
  const migration = migrateMarkerState({ ...options, home, sessionId });
  if (migration?.blocked) return;
  const protectedMarker = testHooks.protectMarker
    ? null : join(markerDir, `${MARKER_PREFIX}${sessionHash(sessionId)}`);
  pruneMarkers({ ...options, nowMs: Date.now(), protectedMarker });

  let stats;
  try { stats = readTranscriptStats(transcriptPath); } catch { return; }
  if (!stats || stats.usedTokens === null) return;
  let envelopeLimit = null;
  try {
    if (payload.context_window && typeof payload.context_window === 'object') {
      envelopeLimit = validContextWindowSize(payload.context_window.context_window_size);
    }
  } catch { /* malformed envelope */ }
  let cachedLimit = null;
  try {
    const cached = readRateLimitsCache(RATE_LIMITS_CACHE, Date.now(), sessionId, testHooks);
    cachedLimit = cached?.contextWindowSize;
  } catch { /* best effort */ }
  const limit = stats.modelId === null
    ? envelopeLimit || cachedLimit : contextWindowLimit(stats.modelId, envelopeLimit || cachedLimit);
  if (!validContextWindowSize(limit) || stats.usedTokens / limit < THRESHOLD) return;

  const claim = claimMarker({ ...options, sessionId, nowMs: Date.now() });
  if (!claim) return;
  try {
    if (!markerClaimOwned(claim)) return;
    writeSync(1, MESSAGE + '\n');
    if (markDelivered(claim, markerDir, testHooks)) {
      finishMarkerTransaction(claim);
      pruneMarkers({ ...options, nowMs: Date.now() });
    } else abortMarkerTransaction(claim);
  } finally { releaseMarkerClaim(claim); }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try { main(); } catch { /* fail-silent Stop hook */ }
  process.exit(0);
}
