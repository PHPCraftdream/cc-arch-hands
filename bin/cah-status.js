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
import { formatStatusLine } from '../lib/transcript-stats.js';

const FALLBACK = '—';

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

  // Reuse the shared formatter with time omitted (it's tolerant of null time).
  const line = formatStatusLine({ time: null, displayName, usedTokens, limit });
  return line || FALLBACK;
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
