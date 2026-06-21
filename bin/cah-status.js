#!/usr/bin/env node
// cah-status — Claude Code statusLine bin.
//
// Reads a JSON envelope from stdin (Claude Code statusLine protocol),
// then emits a single line:  HH:MM · <display_name> · X% (Nk/Mk)
// Falls back gracefully: if context_window is null → omit the usage part;
// if model is missing → omit it too; on any error → just HH:MM.
// Never crashes, never blanks, always exits 0.

import { readFileSync } from 'node:fs';
import { currentHhMm, formatStatusLine } from '../lib/transcript-stats.js';

function buildLine(data) {
  const time = currentHhMm();

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

  return formatStatusLine({ time, displayName, usedTokens, limit });
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
      // malformed — fall back to clock only
    }
  }

  const line = buildLine(data);
  process.stdout.write(line + '\n');
}

try {
  main();
} catch {
  // last-resort fallback
  try {
    process.stdout.write(currentHhMm() + '\n');
  } catch {
    /* ignore */
  }
}

process.exit(0);
