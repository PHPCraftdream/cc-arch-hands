#!/usr/bin/env node
// cah-status-probe — diagnostic statusLine bin.
//
// Captures the raw stdin envelope to a JSONL log file so `cah probe statusline
// stop` can analyse exactly what Claude Code sends. Prints a placeholder so
// the statusbar does not blank out. Fail-silent, exit 0 — never breaks the
// session even if the log path is unwritable.
//
// Activated only via `cah probe statusline start` (which atomically rewires
// statusLine.command in settings.json), and removed by `cah probe statusline
// stop` (which restores the previous statusLine entry). This bin is shipped
// by the installer like the other companion bins but is otherwise dormant.

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';

const LOG_PATH =
  process.env.CAH_PROBE_LOG ||
  join(homedir(), '.claude', 'cah-bin', 'cache', 'envelope-probe.log');

const PLACEHOLDER = '(cah probe — run `cah probe statusline stop` to finish)';

function main() {
  let raw = '';
  try {
    raw = readFileSync(0, 'utf8');
  } catch {
    raw = '';
  }

  try {
    mkdirSync(dirname(LOG_PATH), { recursive: true });
    const record = JSON.stringify({
      capturedAt: new Date().toISOString(),
      raw,
    }) + '\n';
    writeFileSync(LOG_PATH, record, { flag: 'a' });
  } catch {
    // fail-silent — the bar must still render even if the log path is unwritable
  }

  process.stdout.write(PLACEHOLDER + '\n');
}

try {
  main();
} catch {
  try {
    process.stdout.write(PLACEHOLDER + '\n');
  } catch {
    /* ignore */
  }
}

process.exit(0);
