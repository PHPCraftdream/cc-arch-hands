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

import { readFileSync, mkdirSync, writeFileSync, renameSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';
import { formatStatusLine } from '../lib/transcript-stats.js';
import { CURRENT_VERSION, getLatestVersion, isNewerVersion } from '../lib/update-check.js';

const FALLBACK = '—';

// Shared with cah-stamp: whichever bin runs first populates this cache, so
// the npm registry is only ever hit once per UPDATE_CHECK_TTL_MS window.
const UPDATE_CHECK_CACHE =
  process.env.CAH_UPDATE_CHECK_CACHE ||
  join(homedir(), '.claude', 'cah-bin', 'cache', 'update-check.json');

// Pro/Max rate_limits (five_hour, seven_day) live ONLY in the statusLine
// envelope. Persist the last seen values so the Stop / PostToolUse hook bin
// (cah-stamp) — which receives a different envelope without rate_limits —
// can include them in the chat audit trail.
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

function persistSessionState(fiveHour, sevenDay, effort) {
  if (!fiveHour && !sevenDay && !effort) return;
  try {
    mkdirSync(dirname(RATE_LIMITS_CACHE), { recursive: true });
    const tmp = RATE_LIMITS_CACHE + '.tmp';
    writeFileSync(
      tmp,
      JSON.stringify({ fiveHour, sevenDay, effort, capturedAt: Date.now() }) + '\n',
    );
    renameSync(tmp, RATE_LIMITS_CACHE);
  } catch {
    // Fail-silent: the statusLine bin must never break the bar over a cache miss.
  }
}

function buildLine(data) {
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
      usedTokens = cw.total_input_tokens ?? null;
      limit = cw.context_window_size ?? null;
    }
  } catch {
    // ignore
  }

  let fiveHour = null;
  let sevenDay = null;
  try {
    const rl = data && data.rate_limits;
    if (rl && typeof rl === 'object') {
      fiveHour = extractRateSlot(rl.five_hour);
      sevenDay = extractRateSlot(rl.seven_day);
    }
  } catch {
    // ignore
  }

  // effort.level lives only in the statusLine envelope. Persist it next to
  // rate_limits so cah-stamp (Stop / PostToolUse hook, different envelope
  // without effort) can echo it into the chat audit trail.
  let effort = null;
  try {
    const e = data && data.effort;
    if (e && typeof e === 'object' && typeof e.level === 'string') {
      effort = e.level;
    }
  } catch {
    // ignore
  }
  persistSessionState(fiveHour, sevenDay, effort);

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

  const line = buildLine(data);
  process.stdout.write(line + '\n');
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
