// transcript-stats.js — shared helpers for reading session transcript JSONL
// and formatting the HH:MM · model · X% status line.
// Used by cah-checkpoint-hint, cah-status, and cah-stamp.

import { readFileSync, openSync, readSync, fstatSync, closeSync } from 'node:fs';

// The model + usage we need live in the final assistant entry, so we read only
// the tail of the transcript instead of the whole file on every hook call. A
// heavy session can grow to tens of MB; reading 64 KB keeps the Stop/PostToolUse
// hook fast. If the tail does not contain a complete answer we fall back to a
// full read (see readTranscriptStats).
const TAIL_BYTES = 64 * 1024;

function readTail(path) {
  const fd = openSync(path, 'r');
  try {
    const size = fstatSync(fd).size;
    const start = Math.max(0, size - TAIL_BYTES);
    const len = size - start;
    const buf = Buffer.allocUnsafe(len);
    let off = 0;
    while (off < len) {
      const n = readSync(fd, buf, off, len - off, start + off);
      if (n === 0) break;
      off += n;
    }
    // partial === true when we did not start at byte 0, so the first line may
    // be a truncated fragment (it gets skipped by the JSON.parse guard).
    return { text: buf.toString('utf8', 0, off), partial: start > 0 };
  } finally {
    closeSync(fd);
  }
}

const OPUS_FABLE_LIMIT = 1_000_000;
const SONNET_HAIKU_LIMIT = 200_000;

// rate_limits state captured by cah-status (statusLine envelope) and read by
// cah-stamp (Stop / PostToolUse envelope, which does not include rate_limits).
// Stale beyond this many ms — ignored.
const RATE_LIMITS_MAX_AGE_MS = 60 * 60 * 1000;

// Effort level → short code that matches the slash-command suffix convention
// (/sl, /sm, /sh, /sx, /sxx). Rendered in brackets after the model name:
// "Opus 4.7 [xx]". Unknown levels yield null and are simply omitted.
const EFFORT_SHORT = Object.freeze({
  low: 'l',
  medium: 'm',
  high: 'h',
  xhigh: 'x',
  max: 'xx',
});

export function effortCode(level) {
  if (typeof level !== 'string') return null;
  const v = level.toLowerCase();
  return EFFORT_SHORT[v] || null;
}

// ---------------------------------------------------------------------------
// Recursive finders (depth-bounded at 8, matching cah-checkpoint-hint)
// ---------------------------------------------------------------------------

function findContextTokens(node, depth = 0) {
  if (node === null || typeof node !== 'object' || depth > 8) return null;
  if (node.usage && typeof node.usage === 'object') {
    // Context-window usage per official Anthropic API:
    // input_tokens + cache_creation_input_tokens + cache_read_input_tokens.
    // After the first turn most tokens are in cache_read, so input_tokens
    // alone (often 1) is NOT the size of the loaded context.
    // Reference: code.claude.com/docs/en/statusline.
    const u = node.usage;
    const it = typeof u.input_tokens === 'number' ? u.input_tokens : 0;
    const cc = typeof u.cache_creation_input_tokens === 'number' ? u.cache_creation_input_tokens : 0;
    const cr = typeof u.cache_read_input_tokens === 'number' ? u.cache_read_input_tokens : 0;
    const sum = it + cc + cr;
    // Only return if we actually had at least one of the three fields.
    if (
      typeof u.input_tokens === 'number' ||
      typeof u.cache_creation_input_tokens === 'number' ||
      typeof u.cache_read_input_tokens === 'number'
    ) {
      return sum;
    }
  }
  for (const key of Object.keys(node)) {
    const found = findContextTokens(node[key], depth + 1);
    if (found !== null) return found;
  }
  return null;
}

function findModel(node, depth = 0) {
  if (node === null || typeof node !== 'object' || depth > 8) return null;
  if (typeof node.model === 'string' && node.model) return node.model;
  // Also accept model as object with id field
  if (node.model && typeof node.model === 'object' && typeof node.model.id === 'string' && node.model.id) {
    return node.model.id;
  }
  for (const key of Object.keys(node)) {
    const found = findModel(node[key], depth + 1);
    if (found !== null) return found;
  }
  return null;
}

// Per-turn API request id. Every assistant entry of the same turn (text +
// tool_use blocks) shares this `req_...` value, so it's the natural key for
// per-message dedup of the chat-stamp audit line. Top-level field only —
// no recursive search needed, no chance of capturing a tool result's req id.
function findRequestId(obj) {
  if (obj && typeof obj === 'object' && typeof obj.requestId === 'string' && obj.requestId) {
    return obj.requestId;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Walk a JSONL transcript from the end and return the latest
 * {usedTokens, modelId, requestId}, or null if NONE are found / file missing.
 * All three fields are found independently (first match wins for each).
 * requestId is the per-turn API request id, used by cah-stamp to dedupe
 * the chat audit line so the same turn never produces two stamps even when
 * many PostToolUse hooks fire across a long turn.
 */
export function readTranscriptStats(transcriptPath) {
  let tail;
  try {
    tail = readTail(transcriptPath);
  } catch {
    return null;
  }

  let result = scanTranscript(tail.text);
  // If we only read the tail and didn't find a complete {usedTokens, modelId,
  // requestId} triplet, the missing field may live in an earlier entry —
  // re-scan the whole file. Small transcripts read fully on the first pass
  // (partial === false).
  if (tail.partial && (result === null || result.usedTokens === null || result.modelId === null || result.requestId === null)) {
    try {
      result = scanTranscript(readFileSync(transcriptPath, 'utf8'));
    } catch {
      // keep the tail result
    }
  }
  return result;
}

function scanTranscript(raw) {
  const lines = raw.split(/\r?\n/);
  let usedTokens = null;
  let modelId = null;
  let requestId = null;

  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim();
    if (!line) continue;

    let obj;
    try {
      obj = JSON.parse(line);
    } catch {
      continue;
    }

    // Skip user entries entirely: tool results live there, and an MCP tool that
    // echoes an upstream API response would otherwise leak its `usage` (mistaken
    // for session context) or its `model` (mispaired with assistant usage,
    // skewing the limit lookup and the checkpoint-hint threshold).
    if (obj.type === 'user') continue;

    if (usedTokens === null) {
      const t = findContextTokens(obj);
      if (t !== null) usedTokens = t;
    }
    if (modelId === null) {
      const m = findModel(obj);
      if (m) modelId = m;
    }
    if (requestId === null) {
      const r = findRequestId(obj);
      if (r) requestId = r;
    }
    if (usedTokens !== null && modelId !== null && requestId !== null) break;
  }

  if (usedTokens === null && modelId === null && requestId === null) return null;
  return { usedTokens, modelId, requestId };
}

/**
 * Return the context-window token limit for a given model id string.
 * Case-insensitive substring match: opus/fable → 1M, sonnet/haiku → 200k,
 * except claude-sonnet-5 (the only 1M-context Sonnet so far).
 */
export function modelLimit(modelId) {
  const m = (modelId || '').toLowerCase();
  if (m.includes('sonnet-5')) return OPUS_FABLE_LIMIT;
  if (m.includes('opus') || m.includes('fable')) return OPUS_FABLE_LIMIT;
  if (m.includes('sonnet') || m.includes('haiku')) return SONNET_HAIKU_LIMIT;
  return SONNET_HAIKU_LIMIT;
}

/**
 * Return the current time as "HH:MM" (24-hour, zero-padded).
 * Accepts an optional Date for test injection.
 */
export function currentHhMm(date = new Date()) {
  const hh = String(date.getHours()).padStart(2, '0');
  const mm = String(date.getMinutes()).padStart(2, '0');
  return `${hh}:${mm}`;
}

/**
 * Return the current time as "HH:MM:SS" (24-hour, zero-padded).
 * Used by cah-stamp so chat audit lines are precise enough to debug
 * throttling / hook-cadence issues.
 */
export function currentHhMmSs(date = new Date()) {
  const ss = String(date.getSeconds()).padStart(2, '0');
  return `${currentHhMm(date)}:${ss}`;
}

/**
 * Convert a raw model ID (e.g. "claude-opus-4-7") to a short display name
 * (e.g. "Opus 4.7"). Also handles display names that already have "Claude "
 * prefix (e.g. "Claude Opus 4.8" → "Opus 4.8") and plain display names
 * (e.g. "Opus 4.8" → "Opus 4.8").
 *
 * Conversion rules for raw model IDs (lowercase `claude-` prefix):
 *   claude-{family}-{major}-{minor} → {Family} {major}.{minor}
 *   claude-{family}-{major}         → {Family} {major}
 *   claude-{family}                 → {Family}
 * For display names with "Claude " prefix: strip the prefix.
 */
export function toDisplayName(raw) {
  if (!raw || typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;

  // Strip "Claude " prefix (capital C) — for pre-formatted display names
  if (trimmed.startsWith('Claude ')) return trimmed.slice(7) || null;

  // Convert raw model ID: "claude-opus-4-7" → "Opus 4.7"
  // Pattern: claude-{family}[-{major}[-{minor}]]
  const match = trimmed.match(/^claude-([a-z]+)(?:-(\d+))?(?:-(\d+))?$/i);
  if (match) {
    const family = match[1].charAt(0).toUpperCase() + match[1].slice(1).toLowerCase();
    const major = match[2];
    const minor = match[3];
    if (major && minor) return `${family} ${major}.${minor}`;
    if (major) return `${family} ${major}`;
    return family;
  }

  // Fallback: return as-is (may be a plain display name like "Opus 4.8")
  return trimmed;
}

/**
 * Read the rate_limits state file written by cah-status. Returns
 * { fiveHour, sevenDay } if the file exists, parses, and is no older than
 * RATE_LIMITS_MAX_AGE_MS; otherwise null. Fail-silent on every error path.
 *
 * @param {string} path  absolute path to the cache JSON file
 * @param {number} [nowMs=Date.now()] injected for testability of staleness
 */
export function readRateLimitsCache(path, nowMs = Date.now()) {
  let raw;
  try {
    raw = readFileSync(path, 'utf8');
  } catch {
    return null;
  }
  let obj;
  try {
    obj = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!obj || typeof obj !== 'object') return null;
  const capturedAt = typeof obj.capturedAt === 'number' ? obj.capturedAt : null;
  if (capturedAt === null) return null;
  if (nowMs - capturedAt > RATE_LIMITS_MAX_AGE_MS) return null;
  return {
    fiveHour: obj.fiveHour || null,
    sevenDay: obj.sevenDay || null,
    // Effort level (e.g. "max", "high") captured from the statusLine envelope
    // so cah-stamp can include it in the chat audit trail too. null for
    // pre-effort cache files and for models that don't support effort (Haiku).
    effort: typeof obj.effort === 'string' ? obj.effort : null,
  };
}

// Short weekday in the user's locale. Default ru-RU (matches the original
// preview); override via CAH_WEEKDAY_LOCALE for any other language.
let _weekdayShort = null;
function weekdayShort(date) {
  if (_weekdayShort === null) {
    const locale = (typeof process !== 'undefined' && process.env && process.env.CAH_WEEKDAY_LOCALE)
      || 'ru-RU';
    try {
      const fmt = new Intl.DateTimeFormat(locale, { weekday: 'short' });
      _weekdayShort = (d) => fmt.format(d).replace(/\.$/, '').toLowerCase();
    } catch {
      const ru = ['вс', 'пн', 'вт', 'ср', 'чт', 'пт', 'сб'];
      _weekdayShort = (d) => ru[d.getDay()];
    }
  }
  return _weekdayShort(date);
}

// 5h reset → compact "remaining time": "1ч 23м" / "23м" / "<1м" / "0м" if
// the moment has already passed. Returns null on malformed/missing input.
export function formatFiveHourReset(resetsAt, now = new Date()) {
  if (!resetsAt) return null;
  const d = new Date(resetsAt);
  if (Number.isNaN(d.getTime())) return null;
  let remainingMs = d.getTime() - now.getTime();
  if (remainingMs < 0) remainingMs = 0;
  const totalMin = Math.floor(remainingMs / 60_000);
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  if (h > 0) return `${h}ч ${m}м`;
  if (totalMin === 0 && remainingMs > 0) return '<1м';
  return `${m}м`;
}

// Weekly reset → "wd DD.MM HH:MM" so you can see both the day name and the
// exact wall clock. Returns null on malformed/missing input.
export function formatWeeklyReset(resetsAt /* , now */) {
  if (!resetsAt) return null;
  const d = new Date(resetsAt);
  if (Number.isNaN(d.getTime())) return null;
  const dd = String(d.getDate()).padStart(2, '0');
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  return `${weekdayShort(d)} ${dd}.${mm} ${currentHhMm(d)}`;
}

// Trim trailing zeros after the decimal but keep the dot if a non-zero
// decimal is present: 12.34 → "12.34", 12.30 → "12.3", 12.00 → "12".
function fmtPct(n) {
  return n.toFixed(2).replace(/\.?0+$/, '');
}

// 10-cell Unicode progress bar with two visually distinct styles so a glance
// is enough to tell what's being measured:
//   mode 'limit' — solid █ + 8-level subblock partial (▏▎▍▌▋▊▉), in square
//                  brackets [████▍░░░░░]. This is the "how much used" axis.
//   mode 'time'  — dark-shade ▓ + medium-shade ▒ partial, in round brackets
//                  (▓▓▓▓▒░░░░░). This is the "how much window elapsed" axis.
// Empty cells: ░. The combination of fill character AND bracket shape makes
// the two bars trivially distinguishable when they appear back-to-back.
const BAR_WIDTH = 10;
const SUBBLOCKS = ['', '▏', '▎', '▍', '▌', '▋', '▊', '▉'];

export function makeBar(pct, mode = 'limit') {
  const clamped = Math.max(0, Math.min(100, Number(pct) || 0));
  const fullCells = Math.floor(clamped / 10);
  const remainder = clamped - fullCells * 10; // 0..<10
  const isLimit = mode !== 'time';
  const fill = isLimit ? '█' : '▓';
  let bar = fill.repeat(Math.min(fullCells, BAR_WIDTH));
  if (fullCells < BAR_WIDTH && remainder > 0) {
    if (isLimit) {
      const eighths = Math.round((remainder / 10) * 8);
      if (eighths === 8) bar += '█';
      else if (eighths > 0) bar += SUBBLOCKS[eighths];
    } else {
      bar += '▒';
    }
  }
  while (bar.length < BAR_WIDTH) bar += '░';
  bar = bar.slice(0, BAR_WIDTH);
  return isLimit ? `[${bar}]` : `(${bar})`;
}


function rateLimitPart(label, slot, resetFmt, now, bars) {
  if (!slot || typeof slot.used !== 'number') return null;
  const pct = fmtPct(slot.used);
  const reset = resetFmt(slot.resetsAt, now);
  let out = `${label} `;
  if (bars) out += `${makeBar(slot.used, 'limit')} `;
  out += `${pct}%`;
  if (reset) out += ` →${reset}`;
  return out;
}

/**
 * Format the one-line status string.
 *
 * @param {object} opts
 * @param {string|null} opts.time   - "HH:MM" string, or null to omit the clock
 * @param {string|null} opts.displayName - raw model display name or model ID
 * @param {number|null} opts.usedTokens
 * @param {number|null} opts.limit
 * @param {{used:number|null, resetsAt:string|null}|null} [opts.fiveHour]
 *        Pro/Max 5-hour quota — used = percentage 0..100, resetsAt = ISO.
 * @param {{used:number|null, resetsAt:string|null}|null} [opts.sevenDay]
 *        Pro/Max weekly quota — used = percentage 0..100, resetsAt = ISO.
 * @param {Date} [opts.now=new Date()] - injected for testability of reset formatting.
 * @returns {string}
 *
 * Output shapes (parts joined by " · ", missing parts omitted):
 *   "HH:MM · <name> · X% (Nk/Mk) · 5h 23% (→14:30) · wk 67% (→вс 03:00)"
 *   "<name> · X% (Nk/Mk)"            — no rate_limits (free tier / pre-API)
 *   "<name>"                          — name only
 *   ""                                — nothing at all (caller decides fallback)
 */
export function formatStatusLine({ time, displayName, usedTokens, limit, fiveHour, sevenDay, effort, now, bars = true }) {
  // Convert display name: strip "Claude " prefix or convert raw model ID
  const baseName = toDisplayName(displayName);
  const code = effortCode(effort);
  // Render effort as a one-letter bracketed suffix matching the slash-command
  // shortcut convention (e.g. "Opus 4.7 [xx]" → /oxx). If effort is absent (no
  // envelope value, or the model doesn't support effort) the name stays bare.
  const name = baseName && code ? `${baseName} [${code}]` : baseName;
  const _now = now || new Date();

  let usagePart = null;
  if (
    usedTokens != null &&
    limit != null &&
    typeof usedTokens === 'number' &&
    typeof limit === 'number' &&
    limit > 0
  ) {
    const rawPct = (usedTokens / limit) * 100;
    const pct = fmtPct(rawPct);
    const usedK = Math.round(usedTokens / 1000);
    const limitStr = limit >= 1_000_000
      ? `${Math.round(limit / 1_000_000)}M`
      : `${Math.round(limit / 1000)}k`;
    usagePart = bars
      ? `${makeBar(rawPct, 'limit')} ${pct}% (${usedK}k/${limitStr})`
      : `${pct}% (${usedK}k/${limitStr})`;
  }

  const fiveHourPart = rateLimitPart('5h', fiveHour, formatFiveHourReset, _now, bars);
  const sevenDayPart = rateLimitPart('wk', sevenDay, formatWeeklyReset, _now, bars);

  const parts = [];
  if (time) parts.push(time);
  if (name) parts.push(name);
  if (usagePart) parts.push(usagePart);
  if (fiveHourPart) parts.push(fiveHourPart);
  if (sevenDayPart) parts.push(sevenDayPart);
  return parts.join(' · ');
}
