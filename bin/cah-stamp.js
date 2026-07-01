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

import { readFileSync, writeFileSync, mkdirSync, renameSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';
import {
  readTranscriptStats,
  modelLimit,
  formatStatusLine,
  currentHhMmSs,
  readRateLimitsCache,
} from '../lib/transcript-stats.js';

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

function readLastStamp(path) {
  try {
    const raw = readFileSync(path, 'utf8');
    const obj = JSON.parse(raw);
    return {
      ts: typeof obj.lastStampedAt === 'number' ? obj.lastStampedAt : null,
      requestId: typeof obj.lastStampedRequestId === 'string' ? obj.lastStampedRequestId : null,
    };
  } catch {
    return { ts: null, requestId: null };
  }
}

function writeLastStamp(path, ts, requestId) {
  try {
    mkdirSync(dirname(path), { recursive: true });
    const tmp = path + '.tmp';
    writeFileSync(
      tmp,
      JSON.stringify({ lastStampedAt: ts, lastStampedRequestId: requestId }) + '\n',
    );
    renameSync(tmp, path);
  } catch {
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

  // Throttle (time): skip if we just stamped within the min interval. This is
  // a safety net for unusual hook cadences; the primary dedup is per-message
  // via requestId below.
  const nowMs = Date.now();
  const last = readLastStamp(STAMP_THROTTLE_PATH);
  if (last.ts !== null && nowMs - last.ts < STAMP_MIN_INTERVAL_MS) return;

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
  // requestId (text + each tool_use block). If we already stamped this turn,
  // skip — even if the throttle window has elapsed (a long turn would
  // otherwise show a second stamp under the same assistant message). Falls
  // through to emit when requestId is unknown (e.g. very first turn).
  if (requestId !== null && requestId === last.requestId) return;

  let limit = null;
  if (modelId) {
    limit = modelLimit(modelId);
  }

  // If we have usedTokens but no modelId, we cannot compute a meaningful
  // percentage without knowing the limit, so degrade to HH:MM.
  // If we have modelId but no usedTokens, use model name without usage %.
  const displayName = modelId || null;
  const effectiveUsed = (usedTokens !== null && modelId !== null) ? usedTokens : null;
  const effectiveLimit = (usedTokens !== null && modelId !== null) ? limit : null;

  let fiveHour = null;
  let sevenDay = null;
  try {
    const cached = readRateLimitsCache(RATE_LIMITS_CACHE);
    if (cached) {
      fiveHour = cached.fiveHour;
      sevenDay = cached.sevenDay;
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
  writeLastStamp(STAMP_THROTTLE_PATH, nowMs, requestId);
  const out = JSON.stringify({ continue: true, systemMessage: line });
  process.stdout.write(out + '\n');
}

try {
  main();
} catch {
  /* fail silent */
}

process.exit(0);
