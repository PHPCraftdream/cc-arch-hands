#!/usr/bin/env node
// cah-status — Claude Code statusLine bin.
//
// Reads a JSON envelope from stdin (Claude Code statusLine protocol),
// then emits a single line:  <display_name> · X% (Nk/Mk)
// Falls back gracefully: if context_window is null → omit the usage part;
// if model is missing → output a single dash; on any error → "—".
//
// Time intentionally NOT included: a per-second tick is incompatible
// with Node cold-start on Windows (1–3s), which causes the harness to
// cancel in-flight scripts and the status bar to disappear. The chat
// audit-trail Stop hook (cah-stamp) carries the timestamp instead.
//
// Never crashes, never produces empty stdout (the harness would blank
// the bar), always exits 0.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import {
  formatStatusLine,
  validContextWindowSize,
  effectiveContextWindowSize,
  persistRateLimitsCache,
  statusContextUsage,
  readLastMeasuredContext,
  readStatusLineRateFallback,
  writeStatusContextTrace,
} from '../lib/transcript-stats.js';
import { CURRENT_VERSION, getLatestVersion, isNewerVersion } from '../lib/update-check.js';

const FALLBACK = '—';

// Shared with cah-stamp: whichever bin runs first populates this cache, so
// the npm registry is only ever hit once per UPDATE_CHECK_TTL_MS window.
const UPDATE_CHECK_CACHE =
  process.env.CAH_UPDATE_CHECK_CACHE ||
  join(homedir(), '.claude', 'cah-bin', 'cache', 'update-check.json');

// Pro/Max rate_limits (five_hour, seven_day) live only in the statusLine
// envelope. Persist account-global rates plus the current session's context
// window so Stop / PostToolUse can recover the data missing from its envelope.
// CAH_RATE_LIMITS_CACHE env override lets tests/CI redirect the write path.
const RATE_LIMITS_CACHE =
  process.env.CAH_RATE_LIMITS_CACHE ||
  join(homedir(), '.claude', 'cah-bin', 'cache', 'rate-limits.json');

function extractRateSlot(slot) {
  if (!slot || typeof slot !== 'object') return null;
  const used = typeof slot.used_percentage === 'number' ? slot.used_percentage : null;
  let resetsAt = null;
  if (typeof slot.resets_at === 'string') {
    resetsAt = slot.resets_at;
  } else if (typeof slot.resets_at === 'number') {
    // Claude Code sends resets_at as a Unix timestamp (seconds since epoch).
    resetsAt = new Date(slot.resets_at * 1000).toISOString();
  }
  if (used === null && resetsAt === null) return null;
  return { used, resetsAt };
}

function buildLine(data, contextState = null) {
  let displayName = null;
  try {
    displayName = data && data.model && data.model.display_name || null;
  } catch {
    // ignore
  }

  let usedTokens = null;
  let limit = null;
  try {
    const cw = data && data.context_window;
    if (cw && typeof cw === 'object') {
      usedTokens = statusContextUsage(cw);
      limit = effectiveContextWindowSize(cw.context_window_size);
    }
  } catch {
    // ignore
  }

  let source = usedTokens !== null ? 'envelope' : 'none';
  let reason = limit === null ? 'window_invalid'
    : usedTokens !== null ? 'envelope'
      : typeof data?.model?.id !== 'string' || !data.model.id ? 'model_missing'
        : 'path_missing';
  if (usedTokens === null && limit !== null
      && typeof data?.transcript_path === 'string' && typeof data.model?.id === 'string'
      && data.model.id.length > 0) {
    const scan = contextState ? {} : null;
    const previous = readLastMeasuredContext(data.transcript_path, data.model.id, scan);
    reason = scan?.reason || 'no_measurement';
    if (previous?.modelId === data.model.id && previous.usedTokens > 0) {
      usedTokens = previous.usedTokens;
      source = 'transcript';
      reason = 'measured';
    }
    if (contextState) contextState.scan = scan;
  }
  if (contextState) Object.assign(contextState, { usedTokens, limit, source, reason });

  const isClaudeModel = typeof data?.model?.id === 'string' && data.model.id.startsWith('claude-');
  let fiveHourObserved = null;
  let sevenDay = null;
  try {
    const rl = data && data.rate_limits;
    if (rl && typeof rl === 'object') {
      fiveHourObserved = isClaudeModel ? extractRateSlot(rl.five_hour) : null;
      sevenDay = extractRateSlot(rl.seven_day);
    }
  } catch {
    if (contextState) contextState.rateExtractionFailed = true;
  }

  // effort.level lives only in the statusLine envelope. cah-stamp intentionally
  // does not render cached effort because its hook payload has no turn-bound
  // effort value.
  let effort = null;
  try {
    const e = data && data.effort;
    if (e && typeof e === 'object' && typeof e.level === 'string') {
      effort = e.level;
    }
  } catch {
    // ignore
  }
  let contextWindowSize = null;
  try {
    contextWindowSize = validContextWindowSize(data && data.context_window && data.context_window.context_window_size);
  } catch {
    // ignore
  }
  const sessionId = data && typeof data.session_id === 'string' ? data.session_id : null;
  try {
    persistRateLimitsCache(
      RATE_LIMITS_CACHE,
      fiveHourObserved,
      sevenDay,
      effort,
      contextWindowSize,
      sessionId,
    );
  } catch {
    // Fail-silent: cache failures must never break the status bar.
  }

  let fiveHour = fiveHourObserved;
  let fiveHourSource = fiveHour ? 'envelope' : 'none';
  const quotaFallback = contextState ? { reason: 'not_needed' } : null;
  if (!fiveHour || !Number.isFinite(fiveHour.used) || fiveHour.used < 0 || fiveHour.used > 100) {
    try {
      const cached = readStatusLineRateFallback(
        RATE_LIMITS_CACHE, 'fiveHour', data?.session_id, data?.model?.id, undefined, quotaFallback,
      );
      if (cached) fiveHourSource = 'cache';
      fiveHour = cached || fiveHour;
    } catch {
      if (quotaFallback) quotaFallback.reason = 'read_error';
      // Cached quota is a best-effort fallback only.
    }
  }
  if (contextState) {
    contextState.fiveHour = { used: fiveHour?.used, source: fiveHourSource, fallback: quotaFallback };
    contextState.sevenDay = { used: sevenDay?.used, source: sevenDay ? 'envelope' : 'none',
      fallback: { reason: 'not_attempted' } };
  }
  // Reuse the shared formatter with time omitted (it's tolerant of null time).
  const line = formatStatusLine({
    time: null, displayName, usedTokens, limit, fiveHour, sevenDay, effort,
  });

  let updateSuffix = '';
  try {
    const latest = getLatestVersion(UPDATE_CHECK_CACHE);
    if (isNewerVersion(CURRENT_VERSION, latest)) {
      updateSuffix = ` · 🔵 v${latest}`;
    }
  } catch {
    // fail-silent — the bar must never break over an update check
  }

  return line ? line + updateSuffix : FALLBACK;
}

function main() {
  let raw = '';
  try {
    raw = readFileSync(0, 'utf8');
  } catch {
    // stdin unreadable
  }

  let data = null;
  if (raw && raw.trim()) {
    try {
      data = JSON.parse(raw);
    } catch {
      // malformed — fall through with no data
    }
  }

  const traceDirectory = process.env.CAH_CONTEXT_TRACE_DIR;
  const contextState = traceDirectory ? {} : null;
  const started = performance.now();
  let line;
  try {
    line = buildLine(data, contextState);
  } catch {
    line = FALLBACK;
    if (contextState) contextState.reason = 'render_error';
  }
  process.stdout.write(line + '\n');
  if (contextState) {
    contextState.elapsedMs = performance.now() - started;
    writeStatusContextTrace(traceDirectory, data, contextState);
  }
}

try {
  main();
} catch {
  try {
    process.stdout.write(FALLBACK + '\n');
  } catch {
    /* ignore */
  }
}

process.exit(0);
