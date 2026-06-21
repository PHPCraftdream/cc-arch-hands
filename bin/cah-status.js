#!/usr/bin/env node
// cah-status — Claude Code statusLine bin.
//
// Reads a JSON envelope from stdin (Claude Code statusLine protocol),
// then emits a single line:  HH:MM · <display_name> · X% (Nk/Mk)
// Falls back gracefully: if context_window is null → omit the usage part;
// if model is missing → omit it too; on any error → just HH:MM.
// Never crashes, never blanks, always exits 0.

import { readFileSync } from 'node:fs';

function clock() {
  const d = new Date();
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  return `${hh}:${mm}`;
}

function trimModelName(displayName) {
  if (!displayName || typeof displayName !== 'string') return null;
  const trimmed = displayName.trim();
  if (trimmed.startsWith('Claude ')) return trimmed.slice(7);
  return trimmed;
}

function formatTokens(total, windowSize) {
  const xk = Math.round(total / 1000);
  let yk;
  if (windowSize >= 1_000_000) {
    yk = `${Math.round(windowSize / 1_000_000)}M`;
  } else {
    yk = `${Math.round(windowSize / 1000)}k`;
  }
  return `${xk}k/${yk}`;
}

function buildLine(data) {
  const time = clock();

  let model = null;
  try {
    model = trimModelName(data && data.model && data.model.display_name);
  } catch {
    // ignore
  }

  let usage = null;
  try {
    const cw = data && data.context_window;
    if (cw && typeof cw === 'object') {
      const pct = Math.round(cw.used_percentage);
      const tokens = formatTokens(cw.total_input_tokens, cw.context_window_size);
      usage = `${pct}% (${tokens})`;
    }
  } catch {
    // ignore
  }

  const parts = [time];
  if (model) parts.push(model);
  if (usage) parts.push(usage);
  return parts.join(' · ');
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
    process.stdout.write(clock() + '\n');
  } catch {
    /* ignore */
  }
}

process.exit(0);
