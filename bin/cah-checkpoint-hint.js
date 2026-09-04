#!/usr/bin/env node
// cah-checkpoint-hint — Claude Code Stop hook.
//
// Reads the hook JSON payload from stdin, inspects the session transcript,
// and emits ONE soft systemMessage suggesting /checkpoint when context usage
// crosses 90% of the model's limit. It is deliberately fail-silent: any error,
// missing input, or filesystem hiccup results in `exit 0` with no stdout, so it
// can never break the user's session.

import { mkdirSync, openSync, closeSync, readFileSync, readdirSync, statSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { createHash } from 'node:crypto';
import { readTranscriptStats, contextWindowLimit, readRateLimitsCache, validContextWindowSize } from '../lib/transcript-stats.js';

const THRESHOLD = 0.9;
const THRESHOLD_PCT = Math.round(THRESHOLD * 100);
// Derived from THRESHOLD so the displayed percentage can never drift out of
// sync with the value that actually triggers the hint.
const MESSAGE = JSON.stringify({
  continue: true,
  systemMessage: `[hint] Context at ${THRESHOLD_PCT}%. Run /checkpoint to save state before auto-compact.`,
});

// One marker file per session gates the one-shot hint. They are tiny but never
// removed otherwise, so we sweep stale ones (older than the TTL) on each run.
const MARKER_PREFIX = 'cah-hint-shown-';
const MARKER_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const MARKER_MAX_SESSIONS = 64;
const MARKER_NAME_RE = /^cah-hint-shown-[a-f0-9]{64}$/;
const RATE_LIMITS_CACHE =
  process.env.CAH_RATE_LIMITS_CACHE ||
  join(homedir(), '.claude', 'cah-bin', 'cache', 'rate-limits.json');

function pruneStaleMarkers(markerDir, nowMs) {
  let entries;
  try {
    entries = readdirSync(markerDir);
  } catch {
    return;
  }
  for (const name of entries) {
    if (!MARKER_NAME_RE.test(name)) continue;
    const p = join(markerDir, name);
    try {
      if (nowMs - statSync(p).mtimeMs > MARKER_TTL_MS) unlinkSync(p);
    } catch {
      // ignore individual failures — best-effort hygiene
    }
  }
  const fresh = [];
  for (const name of entries) {
    if (!MARKER_NAME_RE.test(name)) continue;
    const p = join(markerDir, name);
    try { fresh.push({ path: p, mtimeMs: statSync(p).mtimeMs }); } catch { /* best effort */ }
  }
  fresh.sort((a, b) => b.mtimeMs - a.mtimeMs);
  for (const entry of fresh.slice(MARKER_MAX_SESSIONS)) {
    try { unlinkSync(entry.path); } catch { /* best effort */ }
  }
}

function sessionHash(sessionId) {
  const identity = typeof sessionId === 'string' ? `string:${sessionId}` : 'missing:';
  return createHash('sha256').update(identity, 'utf8').digest('hex');
}

// The marker doubles as a durable one-shot claim. wx makes the decision and
// creation one filesystem operation, so concurrent Stop hooks cannot both
// reach stdout. Its mtime is the bounded claim TTL: a process killed after
// claiming cannot suppress this session forever.
function claimMarker(markerDir, sessionId, nowMs) {
  const marker = join(markerDir, `${MARKER_PREFIX}${sessionHash(sessionId)}`);
  try {
    mkdirSync(markerDir, { recursive: true });
    const fd = openSync(marker, 'wx');
    closeSync(fd);
    return true;
  } catch (error) {
    if (error && error.code === 'EEXIST') {
      try {
        if (nowMs - statSync(marker).mtimeMs > MARKER_TTL_MS) {
          unlinkSync(marker);
          const fd = openSync(marker, 'wx');
          closeSync(fd);
          return true;
        }
      } catch {
        // Another process may be claiming/reaping it. Fail silent.
      }
    }
    return false;
  }
}

function readStdin() {
  try {
    return readFileSync(0, 'utf8');
  } catch {
    return '';
  }
}

function main() {
  const input = readStdin();
  if (!input.trim()) return;

  let payload;
  try {
    payload = JSON.parse(input);
  } catch {
    return;
  }

  // Loop guard: don't react to our own continuation.
  if (payload.stop_hook_active === true) return;

  const sessionId = payload.session_id;
  const transcriptPath = payload.transcript_path;
  if (!sessionId || !transcriptPath) return;

  const home = process.env.CAH_HINT_HOME || homedir();
  const markerDir = join(home, '.claude');
  pruneStaleMarkers(markerDir, Date.now());

  let usedTokens = null;
  let modelId = null;
  try {
    const stats = readTranscriptStats(transcriptPath);
    if (!stats) return;
    ({ usedTokens, modelId } = stats);
  } catch {
    return; // transcript missing / unreadable
  }
  if (usedTokens === null) return;

  let envelopeLimit = null;
  try {
    const cw = payload.context_window;
    if (cw && typeof cw === 'object') envelopeLimit = validContextWindowSize(cw.context_window_size);
  } catch {
    // ignore malformed hook envelope
  }
  let cachedLimit = null;
  try {
    const cached = readRateLimitsCache(RATE_LIMITS_CACHE, Date.now(), sessionId);
    cachedLimit = cached && cached.contextWindowSize;
  } catch {
    // fail-silent — use the model fallback
  }
  const limit = contextWindowLimit(modelId, envelopeLimit || cachedLimit);
  const ratio = usedTokens / limit;
  if (ratio < THRESHOLD) return;

  // Threshold crossed: claim before emitting. A failed claim means another
  // process already owns the one-shot hint.
  if (!claimMarker(markerDir, sessionId, Date.now())) return;
  process.stdout.write(MESSAGE + '\n');
}

try {
  main();
} catch {
  // Fail-silent: a Stop hook must never break the session. Matches the other
  // companion bins (cah-stamp, cah-status, cah-status-probe).
}

process.exit(0);
