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
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch (e) {
    if (e && e.code === 'ENOENT') return null;
    throw e;
  }
}

function writeJsonAtomic(path, data) {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = path + '.tmp';
  writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n');
  renameSync(tmp, path);
}

function isProbeEntry(entry) {
  return !!entry
    && entry['cah-sentinel'] === PROBE_SENTINEL
    && entry['cah-name'] === PROBE_NAME;
}

function buildProbeEntry(probeBinAbsPath) {
  return {
    type: 'command',
    command: `node "${probeBinAbsPath}"`,
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

  writeJsonAtomic(backupPath, { previous: settings.statusLine || null });
  settings.statusLine = buildProbeEntry(probeBinAbsPath);
  writeJsonAtomic(settingsPath, settings);

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

  if (previous === null) {
    delete settings.statusLine;
  } else {
    settings.statusLine = previous;
  }
  writeJsonAtomic(settingsPath, settings);
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
