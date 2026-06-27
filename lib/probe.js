// probe.js — enable/disable cah-status-probe via settings.json edits.
//
// The probe captures the raw statusLine envelope to a JSONL log so we can
// inspect what Claude Code actually sends (field names, values, presence of
// rate_limits.resets_at and friends). Wiring it in is a settings.json change,
// which is the installer's job — users never edit the file by hand.
//
// Enable backs up the current statusLine entry to a sidecar JSON file and
// writes the probe entry (with a sentinel pair so disable can detect it).
// Disable reads the backup and restores it verbatim.

import {
  readFileSync,
  writeFileSync,
  mkdirSync,
  renameSync,
  unlinkSync,
  existsSync,
  statSync,
} from 'node:fs';
import { dirname } from 'node:path';

export const PROBE_SENTINEL = 'cah-probe-statusline:v1';
export const PROBE_NAME = 'probe';

function readJsonMaybe(path) {
  let text;
  try {
    text = readFileSync(path, 'utf8');
  } catch (e) {
    if (e && e.code === 'ENOENT') return null;
    throw e;
  }
  // readFileSync('utf8') does NOT strip a leading UTF-8 BOM; some editors add
  // one, which would otherwise make JSON.parse throw. A genuinely malformed
  // body still throws SyntaxError — callers surface a recovery hint.
  return JSON.parse(text.replace(/^﻿/, ''));
}

// Best-effort detection of the indentation used in an existing JSON file so we
// can preserve it on rewrite instead of forcing 2-space (which pollutes diffs
// of version-controlled settings.json). Returns a number of spaces or '\t';
// defaults to 2 when the file is absent / single-line / unreadable.
function detectIndent(path) {
  let text;
  try {
    text = readFileSync(path, 'utf8');
  } catch {
    return 2;
  }
  const m = text.match(/\n([ \t]+)\S/);
  if (!m) return 2;
  return m[1][0] === '\t' ? '\t' : m[1].length;
}

function writeJsonAtomic(path, data, indent = 2) {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = path + '.tmp';
  writeFileSync(tmp, JSON.stringify(data, null, indent) + '\n');
  renameSync(tmp, path);
}

function isProbeEntry(entry) {
  return !!entry
    && entry['cah-sentinel'] === PROBE_SENTINEL
    && entry['cah-name'] === PROBE_NAME;
}

function buildProbeEntry(probeBinAbsPath) {
  // node accepts forward slashes on every platform; normalizing keeps the
  // command working under POSIX-like shells on Windows and across synced
  // dotfiles. Escape any embedded double-quote so a crafted path (e.g. a
  // hostile $HOME) cannot break out of the quoted argument in settings.json.
  const safe = probeBinAbsPath.replace(/\\/g, '/').replace(/"/g, '\\"');
  return {
    type: 'command',
    command: `node "${safe}"`,
    padding: 0,
    'cah-sentinel': PROBE_SENTINEL,
    'cah-name': PROBE_NAME,
  };
}

export class ProbeAlreadyActiveError extends Error {
  constructor() {
    super('probe already active — run `cah probe statusline stop` first');
    this.name = 'ProbeAlreadyActiveError';
  }
}

export class ProbeNotActiveError extends Error {
  constructor() {
    super('probe is not active');
    this.name = 'ProbeNotActiveError';
  }
}

export class MissingBackupError extends Error {
  constructor(backupPath) {
    super(`probe is active but backup file is missing: ${backupPath}`);
    this.name = 'MissingBackupError';
  }
}

/**
 * Atomically rewire settings.statusLine to the probe bin.
 *
 * - If settings.json does not exist, it is created with just the probe entry
 *   and an empty backup ({ previous: null }) is saved.
 * - If statusLine is missing, backup records { previous: null } and probe is
 *   added.
 * - If statusLine is already the probe (sentinel match), ProbeAlreadyActiveError
 *   is thrown (do NOT overwrite the existing backup — it would erase the real
 *   original).
 * - Otherwise the existing statusLine is saved verbatim into backup and replaced.
 *
 * Also truncates the log file so each session starts with a clean dump.
 */
export function enableProbe({ settingsPath, probeBinAbsPath, backupPath, logPath }) {
  let settings = readJsonMaybe(settingsPath);
  if (settings === null) settings = {};

  if (isProbeEntry(settings.statusLine)) {
    throw new ProbeAlreadyActiveError();
  }

  const indent = detectIndent(settingsPath);
  writeJsonAtomic(backupPath, { previous: settings.statusLine || null });
  settings.statusLine = buildProbeEntry(probeBinAbsPath);
  writeJsonAtomic(settingsPath, settings, indent);

  // Truncate the log so the new session starts clean. mkdir first in case
  // ~/.claude/cah-bin/cache does not exist yet.
  mkdirSync(dirname(logPath), { recursive: true });
  writeFileSync(logPath, '');
}

/**
 * Reverse enableProbe: read backup, restore the original statusLine entry
 * (or remove the key if there was none), delete the backup.
 *
 * Returns { restored: originalStatusLineOrNull }.
 */
export function disableProbe({ settingsPath, backupPath }) {
  const settings = readJsonMaybe(settingsPath);
  if (!settings || !isProbeEntry(settings.statusLine)) {
    throw new ProbeNotActiveError();
  }
  const backup = readJsonMaybe(backupPath);
  if (backup === null) throw new MissingBackupError(backupPath);

  const previous = Object.prototype.hasOwnProperty.call(backup, 'previous')
    ? backup.previous
    : null;

  const indent = detectIndent(settingsPath);
  if (previous === null) {
    delete settings.statusLine;
  } else {
    settings.statusLine = previous;
  }
  writeJsonAtomic(settingsPath, settings, indent);
  try {
    unlinkSync(backupPath);
  } catch {
    // ignore — we already restored
  }
  return { restored: previous };
}

/** Read the JSONL probe log; returns array of records (best-effort). */
export function readProbeLog(logPath) {
  let raw;
  try {
    raw = readFileSync(logPath, 'utf8');
  } catch {
    return [];
  }
  const out = [];
  for (const line of raw.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line));
    } catch {
      // skip malformed line
    }
  }
  return out;
}

/** Quick inspection: is probe wired, does backup exist, how big is the log. */
export function probeStatus({ settingsPath, backupPath, logPath }) {
  const settings = readJsonMaybe(settingsPath);
  const active = !!(settings && isProbeEntry(settings.statusLine));
  let backupExists = false;
  try {
    backupExists = existsSync(backupPath);
  } catch {
    backupExists = false;
  }
  let logSize = 0;
  let logRecords = 0;
  try {
    logSize = statSync(logPath).size;
    logRecords = readProbeLog(logPath).length;
  } catch {
    logSize = 0;
    logRecords = 0;
  }
  return { active, backupExists, logSize, logRecords };
}
