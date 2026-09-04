#!/usr/bin/env node
// cah-stamp — Claude Code Stop hook installed by /clock.
//
// After each assistant turn, reads the hook JSON payload from stdin,
// inspects the session transcript for the latest usage.input_tokens and model,
// then emits a systemMessage with the current time/model/context status so
// the chat scrollback contains a timestamped audit trail.
//
// It is deliberately fail-silent: any error, missing input, or filesystem
// hiccup results in `exit 0` with no stdout, so it can never break the session.

import { readFileSync, writeFileSync, mkdirSync, renameSync, existsSync, readdirSync, statSync, unlinkSync } from 'node:fs';
import { join, dirname, basename } from 'node:path';
import { homedir } from 'node:os';
import { createHash } from 'node:crypto';
import {
  readTranscriptStats,
  contextWindowLimit,
  validContextWindowSize,
  formatStatusLine,
  currentHhMmSs,
  readRateLimitsCache,
} from '../lib/transcript-stats.js';
import { CURRENT_VERSION, getLatestVersion, isNewerVersion } from '../lib/update-check.js';

// Pro/Max rate_limits are only in the statusLine envelope; cah-status
// persists them here so we can include them in the chat audit trail.
// CAH_RATE_LIMITS_CACHE env override lets tests/CI redirect the read path.
const RATE_LIMITS_CACHE =
  process.env.CAH_RATE_LIMITS_CACHE ||
  join(homedir(), '.claude', 'cah-bin', 'cache', 'rate-limits.json');

// Throttle state for the chat audit-trail. The primary dedup is per-message
// via requestId (every assistant entry of the same turn shares it), so this
// time-throttle is a safety net only. Default 10s — short enough to never
// suppress the next real turn, long enough to ignore odd hook bursts.
const STAMP_THROTTLE_PATH =
  process.env.CAH_STAMP_THROTTLE_PATH ||
  join(homedir(), '.claude', 'cah-bin', 'cache', 'last-stamp.json');
const STAMP_MIN_INTERVAL_MS =
  parseInt(process.env.CAH_STAMP_MIN_INTERVAL_MS || '', 10) || 10_000;
const MAX_STAMP_SESSIONS = 64;
const MAX_REQUEST_ID_LENGTH = 512;
const FALLBACK_SESSION_KEY = '__no_session__';
const STAMP_STATE_PREFIX = '.session-';
const STAMP_STATE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
let stampWriteCounter = 0;

// Shared with cah-status: whichever bin runs first populates this cache, so
// the npm registry is only ever hit once per TTL window (see lib/update-check.js).
const UPDATE_CHECK_CACHE =
  process.env.CAH_UPDATE_CHECK_CACHE ||
  join(homedir(), '.claude', 'cah-bin', 'cache', 'update-check.json');

// One marker file per session gates the one-shot "new version" notice —
// same pattern as cah-checkpoint-hint. Stale markers (older than the TTL)
// are swept on each run so they never accumulate.
const UPDATE_MARKER_PREFIX = 'cah-update-shown-';
const UPDATE_MARKER_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const UPDATE_MARKER_MAX_SESSIONS = 64;

function pruneStaleMarkers(markerDir, nowMs) {
  let entries;
  try {
    entries = readdirSync(markerDir);
  } catch {
    return;
  }
  const candidates = [];
  for (const name of entries) {
    if (!name.startsWith(UPDATE_MARKER_PREFIX)) continue;
    const p = join(markerDir, name);
    try {
      const stat = statSync(p);
      if (nowMs - stat.mtimeMs > UPDATE_MARKER_TTL_MS) {
        unlinkSync(p);
        continue;
      }
      candidates.push({ path: p, mtimeMs: stat.mtimeMs });
    } catch {
      // ignore individual failures — best-effort hygiene
    }
  }
  candidates.sort((a, b) => b.mtimeMs - a.mtimeMs);
  for (const entry of candidates.slice(UPDATE_MARKER_MAX_SESSIONS)) {
    try { unlinkSync(entry.path); } catch { /* best effort */ }
  }
}

function sessionHash(sessionId) {
  const identity = typeof sessionId === 'string' ? `string:${sessionId}` : 'missing:';
  return createHash('sha256').update(identity, 'utf8').digest('hex');
}

// Builds the one-shot "new version available" notice, or '' if none is due:
// only on a real Stop event (never PostToolUse, which fires per tool call),
// only once per session, and only when the cached registry check found a
// newer version than CURRENT_VERSION.
function buildUpdateNotice(payload, nowMs) {
  if (payload.hook_event_name !== 'Stop') return '';
  const sessionId = payload.session_id;
  if (!sessionId) return '';

  const home = process.env.CAH_STAMP_HINT_HOME || homedir();
  const markerDir = join(home, '.claude');
  const marker = join(markerDir, `${UPDATE_MARKER_PREFIX}${sessionHash(sessionId)}`);
  pruneStaleMarkers(markerDir, nowMs);
  if (existsSync(marker)) return '';

  let latest = null;
  try {
    latest = getLatestVersion(UPDATE_CHECK_CACHE);
  } catch {
    return '';
  }
  if (!isNewerVersion(CURRENT_VERSION, latest)) return '';

  try {
    mkdirSync(markerDir, { recursive: true });
    writeFileSync(marker, '');
    pruneStaleMarkers(markerDir, nowMs);
  } catch {
    // best-effort — worst case the notice repeats next turn
  }

  return (
    `\n🔵 cc-arch-hands v${latest} is out (you're on v${CURRENT_VERSION}). Update:\n` +
    '  global: npm install -g cc-arch-hands@latest && npx cah reinstall\n' +
    '  local:  npm install cc-arch-hands@latest && npx cah reinstall --local'
  );
}

function sessionKey(sessionId) {
  return typeof sessionId === 'string' ? sessionId : FALLBACK_SESSION_KEY;
}

function sessionStatePath(path, sessionId) {
  return `${path}${STAMP_STATE_PREFIX}${sessionHash(sessionId)}.json`;
}

function stampRecord(value) {
  if (!value || typeof value !== 'object') return { ts: null, requestId: null };
  return {
    ts: typeof value.lastStampedAt === 'number' ? value.lastStampedAt : null,
    requestId: typeof value.lastStampedRequestId === 'string'
      ? value.lastStampedRequestId.slice(0, MAX_REQUEST_ID_LENGTH)
      : null,
  };
}

function readLastStamp(path, sessionId) {
  const sidecar = sessionStatePath(path, sessionId);
  try {
    const sidecarState = JSON.parse(readFileSync(sidecar, 'utf8'));
    return stampRecord(sidecarState);
  } catch {
    // Fall through to the pre-sidecar state for one-way compatibility.
  }
  try {
    const obj = JSON.parse(readFileSync(path, 'utf8'));
    if (obj && typeof obj.sessions === 'object' && obj.sessions !== null) {
      return stampRecord(obj.sessions[sessionKey(sessionId)]);
    }
    // Compatibility fallback for the pre-session-partition flat state.
    return stampRecord(obj);
  } catch {
    return { ts: null, requestId: null };
  }
}

function pruneStampSidecars(path, nowMs) {
  let names;
  try {
    names = readdirSync(dirname(path));
  } catch {
    return;
  }
  const prefix = basename(path) + STAMP_STATE_PREFIX;
  const candidates = [];
  for (const name of names) {
    if (!name.startsWith(prefix) || !name.endsWith('.json')) continue;
    const sidecar = join(dirname(path), name);
    try {
      const stat = statSync(sidecar);
      if (nowMs - stat.mtimeMs > STAMP_STATE_TTL_MS) {
        unlinkSync(sidecar);
        continue;
      }
      candidates.push({ path: sidecar, mtimeMs: stat.mtimeMs });
    } catch {
      // Best-effort cleanup; concurrent hook processes may be writing it.
    }
  }
  candidates.sort((a, b) => b.mtimeMs - a.mtimeMs);
  for (const entry of candidates.slice(MAX_STAMP_SESSIONS)) {
    try { unlinkSync(entry.path); } catch { /* best effort */ }
  }
}

function writeLastStamp(path, sessionId, ts, requestId) {
  const sidecar = sessionStatePath(path, sessionId);
  let tmp = null;
  try {
    mkdirSync(dirname(sidecar), { recursive: true });
    stampWriteCounter = (stampWriteCounter + 1) % 1_000_000;
    tmp = `${sidecar}.${process.pid}.${Date.now()}.${stampWriteCounter}.tmp`;
    writeFileSync(
      tmp,
      JSON.stringify({
        version: 1,
        lastStampedAt: ts,
        lastStampedRequestId: typeof requestId === 'string'
          ? requestId.slice(0, MAX_REQUEST_ID_LENGTH)
          : null,
      }) + '\n',
    );
    renameSync(tmp, sidecar);
    tmp = null;
    pruneStampSidecars(path, ts);
  } catch {
    if (tmp) {
      try { unlinkSync(tmp); } catch { /* best effort */ }
    }
    // fail-silent — throttling is best-effort
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
    return; // malformed JSON — exit silent
  }

  // Loop guard: don't stamp during agent-continue loops.
  if (payload.stop_hook_active === true) return;

  const transcriptPath = payload.transcript_path;
  if (!transcriptPath) return;

  // Compute the notice before deciding whether the stamp itself is suppressed.
  // A Stop can be the second hook for a turn already stamped by PostToolUse;
  // in that case the notice must be delivered without replaying the stamp.
  const nowMs = Date.now();
  let updateNotice = '';
  try {
    updateNotice = buildUpdateNotice(payload, nowMs);
  } catch {
    // fail-silent — the stamp itself must still ship without the notice
  }
  const last = readLastStamp(STAMP_THROTTLE_PATH, payload.session_id);
  const timeSuppressed = last.ts !== null && nowMs - last.ts < STAMP_MIN_INTERVAL_MS;

  // HH:MM:SS so cadence bugs (e.g. throttle not honoured, dual-hook spam)
  // are diagnosable from the chat scrollback alone.
  const time = currentHhMmSs();

  let usedTokens = null;
  let modelId = null;
  let requestId = null;
  try {
    const stats = readTranscriptStats(transcriptPath);
    if (stats) {
      usedTokens = stats.usedTokens;
      modelId = stats.modelId;
      requestId = stats.requestId;
    }
  } catch {
    // transcript missing / unreadable — still emit with time only
  }

  // Per-message dedup: every assistant entry of the same turn shares the same
  // requestId (text + each tool_use block). If either this or the time guard
  // suppresses the stamp, a due update notice is the only allowed output.
  const requestSuppressed = requestId !== null && requestId === last.requestId;
  if (timeSuppressed || requestSuppressed) {
    if (updateNotice) {
      process.stdout.write(JSON.stringify({ continue: true, systemMessage: updateNotice }) + '\n');
    }
    return;
  }

  let cachedState = null;
  try {
    cachedState = readRateLimitsCache(RATE_LIMITS_CACHE, Date.now(), payload.session_id);
  } catch {
    // fail-silent — proceed without session cache
  }
  let envelopeLimit = null;
  try {
    const cw = payload.context_window;
    if (cw && typeof cw === 'object') envelopeLimit = validContextWindowSize(cw.context_window_size);
  } catch {
    // ignore malformed hook envelope
  }
  const limit = modelId
    ? contextWindowLimit(modelId, envelopeLimit || (cachedState && cachedState.contextWindowSize))
    : null;

  // If we have usedTokens but no modelId, we cannot compute a meaningful
  // percentage without knowing the limit, so degrade to HH:MM.
  // If we have modelId but no usedTokens, use model name without usage %.
  const displayName = modelId || null;
  const effectiveUsed = (usedTokens !== null && modelId !== null) ? usedTokens : null;
  const effectiveLimit = (usedTokens !== null && modelId !== null) ? limit : null;

  let fiveHour = null;
  let sevenDay = null;
  try {
    if (cachedState) {
      fiveHour = cachedState.fiveHour;
      sevenDay = cachedState.sevenDay;
    }
  } catch {
    // fail-silent — proceed without rate_limits
  }

  // Effort is deliberately omitted here: Claude Code only ever exposes
  // effort.level in the statusLine envelope, never in the Stop/PostToolUse
  // hook payload or the transcript. Echoing the cached statusLine value into
  // the chat stamp can show the previous turn's effort for one turn after a
  // model/effort switch — better to omit it than show a value that isn't
  // reliably tied to the turn being stamped.
  const line = formatStatusLine({
    time,
    displayName,
    usedTokens: effectiveUsed,
    limit: effectiveLimit,
    fiveHour,
    sevenDay,
    bars: false, // chat audit trail stays compact — bars belong on the statusLine
  });
  writeLastStamp(STAMP_THROTTLE_PATH, payload.session_id, nowMs, requestId);

  const out = JSON.stringify({ continue: true, systemMessage: line + updateNotice });
  process.stdout.write(out + '\n');
}

try {
  main();
} catch {
  /* fail silent */
}

process.exit(0);
