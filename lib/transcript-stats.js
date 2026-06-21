// transcript-stats.js — shared helpers for reading session transcript JSONL
// and formatting the HH:MM · model · X% status line.
// Used by cah-checkpoint-hint, cah-status, and cah-stamp.

import { readFileSync } from 'node:fs';

const OPUS_FABLE_LIMIT = 1_000_000;
const SONNET_HAIKU_LIMIT = 200_000;

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

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Walk a JSONL transcript from the end and return the latest
 * {usedTokens, modelId}, or null if neither is found / file missing.
 * Both fields are found independently (first match wins for each).
 */
export function readTranscriptStats(transcriptPath) {
  let raw;
  try {
    raw = readFileSync(transcriptPath, 'utf8');
  } catch {
    return null;
  }

  const lines = raw.split(/\r?\n/);
  let usedTokens = null;
  let modelId = null;

  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim();
    if (!line) continue;

    let obj;
    try {
      obj = JSON.parse(line);
    } catch {
      continue;
    }

    if (usedTokens === null) {
      const t = findContextTokens(obj);
      if (t !== null) usedTokens = t;
    }
    if (modelId === null) {
      const m = findModel(obj);
      if (m) modelId = m;
    }
    if (usedTokens !== null && modelId !== null) break;
  }

  if (usedTokens === null && modelId === null) return null;
  return { usedTokens, modelId };
}

/**
 * Return the context-window token limit for a given model id string.
 * Case-insensitive substring match: opus/fable → 1M, sonnet/haiku → 200k.
 */
export function modelLimit(modelId) {
  const m = (modelId || '').toLowerCase();
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
 * Format the one-line status string.
 *
 * @param {object} opts
 * @param {string} opts.time        - "HH:MM" string
 * @param {string|null} opts.displayName - raw model display name or model ID
 * @param {number|null} opts.usedTokens
 * @param {number|null} opts.limit
 * @returns {string}
 *
 * Output shapes:
 *   "HH:MM · <name> · X% (Nk/Mk)"   — all present
 *   "HH:MM · <name>"                 — tokens missing
 *   "HH:MM"                          — name missing too
 */
export function formatStatusLine({ time, displayName, usedTokens, limit }) {
  // Convert display name: strip "Claude " prefix or convert raw model ID
  const name = toDisplayName(displayName);

  let usagePart = null;
  if (
    usedTokens != null &&
    limit != null &&
    typeof usedTokens === 'number' &&
    typeof limit === 'number'
  ) {
    const pct = Math.round((usedTokens / limit) * 100);
    const usedK = Math.round(usedTokens / 1000);
    const limitStr = limit >= 1_000_000
      ? `${Math.round(limit / 1_000_000)}M`
      : `${Math.round(limit / 1000)}k`;
    usagePart = `${pct}% (${usedK}k/${limitStr})`;
  }

  const parts = [time];
  if (name) parts.push(name);
  if (usagePart) parts.push(usagePart);
  return parts.join(' · ');
}
