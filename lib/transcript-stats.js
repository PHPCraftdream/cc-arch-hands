// transcript-stats.js — shared helpers for reading session transcript JSONL
// and formatting the HH:MM · model · X% status line.
// Used by cah-checkpoint-hint, cah-status, and cah-stamp.

import {
  readFileSync,
  openSync,
  readSync,
  fstatSync,
  closeSync,
  readdirSync,
} from 'node:fs';
import { createHash } from 'node:crypto';
import { basename, dirname, join } from 'node:path';
import {
  removeOwnedRegularFile,
  regularFileIdentity,
  waitForTestInterlock,
  writeFileAtomic,
} from './fsutil.js';

// Transcript files can grow without bound. Scan only a bounded reverse window
// and read it in chunks so a hook never falls back to materialising the file.
// The limits are deliberately explicit: a request with unusually many records
// or a line larger than this window returns the fields observed so far.
const REVERSE_CHUNK_BYTES = 64 * 1024;
const MAX_SCAN_BYTES = 4 * 1024 * 1024;
const MAX_SCAN_RECORDS = 10_000;

const OPUS_FABLE_LIMIT = 1_000_000;
const SONNET_HAIKU_LIMIT = 200_000;

// rate_limits state captured by cah-status (statusLine envelope) and read by
// cah-stamp (Stop / PostToolUse envelope, which does not include rate_limits).
// Stale beyond this many ms — ignored.
const RATE_LIMITS_MAX_AGE_MS = 60 * 60 * 1000;
const RATE_CONTEXT_MAX_SESSIONS = 64;
const RATE_CONTEXT_PREFIX = '.context-';

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
// Documented transcript envelope fields
// ---------------------------------------------------------------------------

function contextTokensFromUsage(usage) {
  if (usage === null || typeof usage !== 'object' || Array.isArray(usage)) return null;
  // Context-window usage per official Anthropic API:
  // input_tokens + cache_creation_input_tokens + cache_read_input_tokens.
  // After the first turn most tokens are in cache_read, so input_tokens alone
  // (often 1) is NOT the size of the loaded context.
  // Reference: code.claude.com/docs/en/statusline.
  const hasInput = typeof usage.input_tokens === 'number';
  const hasCacheCreation = typeof usage.cache_creation_input_tokens === 'number';
  const hasCacheRead = typeof usage.cache_read_input_tokens === 'number';
  if (!hasInput && !hasCacheCreation && !hasCacheRead) return null;
  return (hasInput ? usage.input_tokens : 0)
    + (hasCacheCreation ? usage.cache_creation_input_tokens : 0)
    + (hasCacheRead ? usage.cache_read_input_tokens : 0);
}

function modelIdFromValue(model) {
  if (typeof model === 'string' && model) return model;
  // The documented envelope can carry the model descriptor as { id }.
  if (model && typeof model === 'object' && !Array.isArray(model)
    && typeof model.id === 'string' && model.id) {
    return model.id;
  }
  return null;
}

function entryStats(obj) {
  if (obj === null || typeof obj !== 'object' || Array.isArray(obj)) {
    return { usedTokens: null, modelId: null };
  }

  // Claude's transcript envelope uses message.usage/message.model. Older
  // supported transcript records put those same fields at the top level.
  // These are intentionally direct lookups: content, tool_use.input, and any
  // other arbitrary nested JSON are not transcript envelopes.
  const message = obj.message && typeof obj.message === 'object' && !Array.isArray(obj.message)
    ? obj.message
    : null;
  const messageTokens = message ? contextTokensFromUsage(message.usage) : null;
  const topLevelTokens = contextTokensFromUsage(obj.usage);
  const messageModel = message ? modelIdFromValue(message.model) : null;
  const topLevelModel = modelIdFromValue(obj.model);

  return {
    usedTokens: messageTokens !== null ? messageTokens : topLevelTokens,
    modelId: messageModel !== null ? messageModel : topLevelModel,
  };
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
 * Walk a JSONL transcript from the end and return the newest assistant turn's
 * {usedTokens, modelId, requestId}, or null if the file is missing or that
 * assistant boundary has none of those direct envelope fields. Older turns
 * are never used to fill an unidentified content-only assistant entry.
 * requestId is the per-turn API request id, used by cah-stamp to dedupe
 * the chat audit line so the same turn never produces two stamps even when
 * many PostToolUse hooks fire across a long turn.
 */
export function readTranscriptStats(transcriptPath, options = {}) {
  let fd;
  try {
    fd = openSync(transcriptPath, 'r');
    const size = fstatSync(fd).size;
    return scanTranscriptReverse(fd, size, options);
  } catch {
    return null;
  } finally {
    if (fd !== undefined) {
      try { closeSync(fd); } catch { /* best effort */ }
    }
  }
}

function optionLimit(value, fallback) {
  return Number.isSafeInteger(value) && value > 0 ? value : fallback;
}

function scanTranscriptReverse(fd, size, options) {
  const chunkBytes = optionLimit(options.chunkBytes, REVERSE_CHUNK_BYTES);
  const maxBytes = optionLimit(options.maxBytes, MAX_SCAN_BYTES);
  const maxRecords = optionLimit(options.maxRecords, MAX_SCAN_RECORDS);
  const lowerBound = Math.max(0, size - maxBytes);
  let position = size;
  let partial = Buffer.alloc(0);
  let result = null;
  let records = 0;
  const injectedRead = typeof options.readChunk === 'function' ? options.readChunk : null;

  const readChunk = (at, length) => {
    if (injectedRead) {
      const value = injectedRead(at, length, fd);
      if (Buffer.isBuffer(value)) return value;
      if (typeof value === 'string') return Buffer.from(value);
      throw new TypeError('readChunk must return a Buffer or string');
    }
    const buffer = Buffer.allocUnsafe(length);
    let offset = 0;
    while (offset < length) {
      const n = readSync(fd, buffer, offset, length - offset, at + offset);
      if (n === 0) break;
      offset += n;
    }
    return offset === length ? buffer : buffer.subarray(0, offset);
  };

  const consume = (lineBytes) => {
    if (records >= maxRecords) return true;
    records += 1;
    const line = lineBytes.toString('utf8').trim();
    if (!line) return false;

    let obj;
    try {
      obj = JSON.parse(line);
    } catch {
      return false;
    }

    // User entries contain tool results and never participate in the assistant
    // request boundary or its stats.
    if (obj.type === 'user' || !isAssistantEntry(obj)) return false;

    const entryRequestId = findRequestId(obj);
    const stats = entryStats(obj);

    if (result === null) {
      // A recognized assistant envelope is a turn boundary even when it is
      // anonymous and content-only. Non-message service records use distinct
      // top-level types and are filtered by isAssistantEntry; skipping an
      // actual assistant here would leak stale metrics from an older turn.
      if (entryRequestId === null && stats.usedTokens === null && stats.modelId === null) {
        return true;
      }
      result = {
        usedTokens: stats.usedTokens,
        modelId: stats.modelId,
        requestId: entryRequestId,
      };
      // An anonymous record cannot safely merge with any preceding record.
      return entryRequestId === null || (
        result.usedTokens !== null && result.modelId !== null
      );
    }

    // A different or unidentified assistant record proves that the preceding
    // record belongs to another turn. Never mix it into the current request.
    if (entryRequestId !== result.requestId) return true;
    if (result.usedTokens === null && stats.usedTokens !== null) result.usedTokens = stats.usedTokens;
    if (result.modelId === null && stats.modelId !== null) result.modelId = stats.modelId;
    return result.usedTokens !== null && result.modelId !== null;
  };

  while (position > lowerBound && records < maxRecords) {
    const length = Math.min(chunkBytes, position - lowerBound);
    position -= length;
    const chunk = readChunk(position, length);
    if (chunk.length === 0) break;
    const data = partial.length === 0 ? chunk : Buffer.concat([chunk, partial]);
    let end = data.length;

    // Work backwards over complete newline-delimited records. The prefix left
    // before the oldest newline is carried into the next (earlier) chunk.
    while (end > 0 && records < maxRecords) {
      const newline = data.lastIndexOf(0x0a, end - 1);
      if (newline < 0) break;
      if (consume(data.subarray(newline + 1, end))) return result;
      end = newline;
    }
    partial = data.subarray(0, end);
  }

  // Only a scan that reached byte zero may treat the carried prefix as a full
  // line. At the max-byte boundary it is intentionally left unparsed.
  if (position === 0 && partial.length > 0 && records < maxRecords) {
    consume(partial);
  }
  return result;
}

function isAssistantEntry(obj) {
  if (!obj || typeof obj !== 'object' || obj.type === 'user') return false;
  if (obj.message && typeof obj.message === 'object' && obj.message.role === 'user') return false;
  if (obj.type === 'assistant') return true;
  if (obj.message && typeof obj.message === 'object' && obj.message.role === 'assistant') return true;
  if (obj.type != null) return false;
  const stats = entryStats(obj);
  return stats.usedTokens !== null || stats.modelId !== null;
}

/**
 * Return the context-window token limit for a given model id string.
 * Case-insensitive substring match: opus/fable → 1M, sonnet/haiku → 200k,
 * except claude-sonnet-5 (the only 1M-context Sonnet so far).
 */
export function modelLimit(modelId) {
  const m = (modelId || '').toLowerCase();
  const disable1M = typeof process !== 'undefined'
    && process.env
    && process.env.CLAUDE_CODE_DISABLE_1M_CONTEXT
    && process.env.CLAUDE_CODE_DISABLE_1M_CONTEXT !== '0'
    && process.env.CLAUDE_CODE_DISABLE_1M_CONTEXT.toLowerCase() !== 'false';
  if (!disable1M && m.includes('sonnet-5')) return OPUS_FABLE_LIMIT;
  if (!disable1M && (m.includes('opus') || m.includes('fable'))) return OPUS_FABLE_LIMIT;
  if (m.includes('sonnet') || m.includes('haiku')) return SONNET_HAIKU_LIMIT;
  return SONNET_HAIKU_LIMIT;
}

export function validContextWindowSize(value) {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null;
}

// An actual context_window_size from a valid Claude Code envelope or matching
// session cache takes precedence over model-name heuristics. The latter is
// only a fallback and therefore honors CLAUDE_CODE_DISABLE_1M_CONTEXT.
export function contextWindowLimit(modelId, actualSize = null) {
  return validContextWindowSize(actualSize) || modelLimit(modelId);
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
// Claude Code sometimes sends display names like "Opus 4.8 (1M context)" —
// that's redundant once the usage part is already rendering "(Nk/1M)" right
// next to the name, so drop any parenthetical that's purely a context-size
// annotation ("1M", "200k", "1M context", "context 1M", ...). Parens with
// any other content are left alone.
function stripContextSize(s) {
  return s
    .replace(/\s*\(([^()]*)\)/g, (m, inner) => {
      return /^(?:context\s+)?\d+(?:\.\d+)?\s*[kKmM]?\s*(?:context)?$/i.test(inner.trim()) ? '' : m;
    })
    .replace(/\s{2,}/g, ' ')
    .trim();
}

export function toDisplayName(raw) {
  if (!raw || typeof raw !== 'string') return null;
  const trimmed = stripContextSize(raw.trim());
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

function rateContextHash(sessionId) {
  const identity = typeof sessionId === 'string' ? `string:${sessionId}` : 'missing:';
  return createHash('sha256').update(identity, 'utf8').digest('hex');
}

/**
 * Return the sidecar used for one session's context-window observation.
 * Session IDs never appear in a path: even long/unusual strings are SHA-256
 * hashed to distinct fixed-size names.
 */
export function rateLimitsContextPath(cachePath, sessionId) {
  return `${cachePath}${RATE_CONTEXT_PREFIX}${rateContextHash(sessionId)}.json`;
}

function readJson(path) {
  try {
    const obj = JSON.parse(readFileSync(path, 'utf8'));
    return obj && typeof obj === 'object' ? obj : null;
  } catch {
    return null;
  }
}

function isFresh(capturedAt, nowMs) {
  return typeof capturedAt === 'number'
    && nowMs - capturedAt <= RATE_LIMITS_MAX_AGE_MS;
}

function writeJsonAtomic(path, value) {
  try {
    writeFileAtomic(path, JSON.stringify(value) + '\n');
    return true;
  } catch {
    // Cache publication is best-effort for hook callers.
    return false;
  }
}

function pruneRateContextSidecars(cachePath, nowMs) {
  let names;
  try {
    names = readdirSync(dirname(cachePath));
  } catch {
    return;
  }
  const prefix = basename(cachePath) + RATE_CONTEXT_PREFIX;
  const candidates = [];
  const nowNs = BigInt(Math.trunc(nowMs)) * 1_000_000n;
  const maxAgeNs = BigInt(RATE_LIMITS_MAX_AGE_MS) * 1_000_000n;
  for (const name of names) {
    if (!name.startsWith(prefix) || !name.endsWith('.json')) continue;
    const sidecar = join(dirname(cachePath), name);
    try {
      const identity = regularFileIdentity(sidecar);
      if (!identity) continue;
      if (nowNs - identity.mtimeNs > maxAgeNs) {
        // stat/lstat is only an observation. The entry may be atomically
        // replaced by a fresh sidecar before removal, so remove only the
        // exact observed regular file after moving it to quarantine.
        waitForTestInterlock('prune-rate-context-before-remove');
        try { removeOwnedRegularFile(sidecar, identity); } catch { /* best effort */ }
        continue;
      }
      candidates.push({ path: sidecar, identity, mtimeNs: identity.mtimeNs });
    } catch {
      // A concurrent writer or cleanup may have removed it already.
    }
  }
  candidates.sort((a, b) => a.mtimeNs === b.mtimeNs ? 0 : a.mtimeNs > b.mtimeNs ? -1 : 1);
  for (const entry of candidates.slice(RATE_CONTEXT_MAX_SESSIONS)) {
    waitForTestInterlock('prune-rate-context-before-remove');
    try { removeOwnedRegularFile(entry.path, entry.identity); } catch { /* best effort */ }
  }
}

/**
 * Persist account-global rate state and this session's context window.
 *
 * The global file is intentionally session-independent. Context observations
 * live in hashed sidecars, so one session can never erase another session's
 * context through a read-modify-write race. All writes are atomic and cleanup
 * is bounded/stale-aware. Failures are deliberately silent for hook callers.
 */
export function persistRateLimitsCache(
  cachePath,
  fiveHour,
  sevenDay,
  effort,
  contextWindowSize,
  sessionId,
  nowMs = Date.now(),
) {
  const contextSize = validContextWindowSize(contextWindowSize);
  const existing = readJson(cachePath);
  const hasRateState = fiveHour !== null || sevenDay !== null;

  if (hasRateState || !existing) {
    const global = {
      version: 2,
      // A refreshed status envelope is authoritative for the slots it
      // reports. Do not carry a previously observed slot forward when the
      // current envelope omits it: that would re-stamp expired data as fresh.
      fiveHour: fiveHour || null,
      sevenDay: sevenDay || null,
      capturedAt: hasRateState
        ? nowMs
        : (existing && typeof existing.capturedAt === 'number' ? existing.capturedAt : nowMs),
    };
    // Keep reading old effort fields for compatibility, but do not claim that
    // cah-stamp renders them; effort is available only in the status envelope.
    if (typeof effort === 'string') global.effort = effort;
    writeJsonAtomic(cachePath, global);
  }

  if (contextSize !== null) {
    writeJsonAtomic(rateLimitsContextPath(cachePath, sessionId), {
      version: 1,
      contextWindowSize: contextSize,
      capturedAt: nowMs,
    });
  }
  pruneRateContextSidecars(cachePath, nowMs);
}

/**
 * Read account-global rates plus only the requested session's context window.
 * Older flat caches remain readable: their context is accepted only when they
 * have no session marker or the marker matches the requested session.
 *
 * @param {string} cachePath absolute path to the base cache JSON file
 * @param {number} [nowMs=Date.now()] injected for testability of staleness
 * @param {string|null} [sessionId=null] session whose context may be used
 */
export function readRateLimitsCache(cachePath, nowMs = Date.now(), sessionId = null) {
  const base = readJson(cachePath);
  const globalFresh = base && isFresh(base.capturedAt, nowMs);
  let contextWindowSize = null;

  const sidecar = readJson(rateLimitsContextPath(cachePath, sessionId));
  if (sidecar && isFresh(sidecar.capturedAt, nowMs)) {
    contextWindowSize = validContextWindowSize(sidecar.contextWindowSize);
  }

  if (contextWindowSize === null && base && isFresh(base.capturedAt, nowMs)) {
    const baseSessionMatches = sessionId == null
      || base.sessionId == null
      || base.sessionId === sessionId;
    if (baseSessionMatches) contextWindowSize = validContextWindowSize(base.contextWindowSize);
  }

  if (!globalFresh && contextWindowSize === null) return null;
  return {
    fiveHour: globalFresh ? (base.fiveHour || null) : null,
    sevenDay: globalFresh ? (base.sevenDay || null) : null,
    // Kept for compatibility with older cache readers. cah-stamp deliberately
    // omits effort because the hook payload does not identify its turn's level.
    effort: globalFresh && typeof base.effort === 'string' ? base.effort : null,
    contextWindowSize,
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
