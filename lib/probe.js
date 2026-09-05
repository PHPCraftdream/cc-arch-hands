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
  existsSync,
  statSync,
} from 'node:fs';
import { dirname } from 'node:path';
import {
  captureRegularFileSnapshot,
  removeOwnedRegularFile,
  regularFileIdentity,
  sameFileIdentity,
  writeFileAtomic,
} from './fsutil.js';
import { acquireLease, LEASE_MAX_MS, releaseLease } from './lease-lock.js';

export const PROBE_SENTINEL = 'cah-probe-statusline:v1';
export const PROBE_NAME = 'probe';
const PROBE_LOCK_SUFFIX = '.probe-lock';
const PROBE_LOCK_STALE_MS = LEASE_MAX_MS;
const TEST_INTERLOCK_TIMEOUT_MS = 10_000;

function parseJsonText(text) {
  // Keep compatibility with older files/tests containing the UTF-8 BOM
  // decoded once as Latin-1, as well as a real U+FEFF prefix.
  if (text.startsWith('ï»¿')) text = text.slice(3);
  return JSON.parse(text.replace(/^\uFEFF/, ''));
}

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

function readJsonSnapshot(path) {
  const snapshot = captureRegularFileSnapshot(path);
  let value = null;
  if (snapshot.present) {
    try {
      value = parseJsonText(snapshot.content.toString('utf8'));
    } catch (cause) {
      throw new MalformedJsonError(path, cause);
    }
  }
  return {
    value,
    expectedDestination: snapshot.expectedDestination,
    content: snapshot.content,
  };
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

function writeJsonAtomic(path, data, indent = 2, expectedDestination) {
  writeFileAtomic(path, JSON.stringify(data, null, indent) + '\n', {
    expectedDestination,
  });
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

export class MalformedSettingsError extends Error {
  constructor(settingsPath, cause) {
    super(`could not parse settings.json at ${settingsPath}: ${cause.message}`);
    this.name = 'MalformedSettingsError';
    this.path = settingsPath;
    this.cause = cause;
  }
}

export class MalformedBackupError extends Error {
  constructor(backupPath, cause) {
    super(`could not parse probe backup at ${backupPath}: ${cause.message}`);
    this.name = 'MalformedBackupError';
    this.path = backupPath;
    this.cause = cause;
  }
}

class MalformedJsonError extends Error {
  constructor(path, cause) {
    super(cause.message, { cause });
    this.name = 'MalformedJsonError';
    this.path = path;
    this.cause = cause;
  }
}

export class BackupChangedError extends Error {
  constructor(backupPath) {
    super(`probe backup changed concurrently: ${backupPath}`);
    this.name = 'BackupChangedError';
    this.path = backupPath;
  }
}

export class ProbeBusyError extends Error {
  constructor() {
    super('probe settings are busy — another start or stop operation is in progress; try again');
    this.name = 'ProbeBusyError';
  }
}

function probeLockPath(settingsPath) {
  return `${settingsPath}${PROBE_LOCK_SUFFIX}`;
}

function acquireProbeLease(settingsPath) {
  const lease = acquireLease(probeLockPath(settingsPath), {
    kind: 'cc-arch-hands-probe',
    // Probe rewiring is a multi-file transition. Leave a live or uncertain
    // operation fenced for the full conservative lease period rather than
    // allowing a second caller to guess that it is safe to continue.
    staleAfterMs: PROBE_LOCK_STALE_MS,
    fenceSuffix: '.stale-',
    interlockPhase: 'probe-lease-reclaim',
    releaseInterlockPhase: 'probe-lease-release',
  });
  if (!lease) throw new ProbeBusyError();
  return lease;
}

function waitForProbeTestInterlock(phase) {
  if (process.env.CAH_TEST_ONLY !== '1') return;
  const base = process.env.CAH_TEST_ONLY_PROBE_INTERLOCK;
  const configured = process.env.CAH_TEST_ONLY_PROBE_INTERLOCK_PHASE;
  if (!base || configured !== phase) return;

  try {
    writeFileSync(`${base}.ready`, phase, { flag: 'wx' });
  } catch {
    // A pre-existing ready marker is not permission to skip the deadline.
    // This keeps stale test artifacts from turning the interlock into a race.
  }
  const deadline = Date.now() + TEST_INTERLOCK_TIMEOUT_MS;
  const signal = new Int32Array(new SharedArrayBuffer(4));
  while (true) {
    try {
      readFileSync(`${base}.go`);
      return;
    } catch (error) {
      if (!error || error.code !== 'ENOENT') throw error;
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        throw new Error(`probe test interlock timed out for ${phase}`);
      }
      Atomics.wait(signal, 0, 0, Math.min(25, remaining));
    }
  }
}

function withProbeLease(settingsPath, operation) {
  const lease = acquireProbeLease(settingsPath);
  try {
    return operation();
  } finally {
    releaseLease(lease);
  }
}

function readSettingsSnapshot(settingsPath) {
  try {
    return readJsonSnapshot(settingsPath);
  } catch (error) {
    if (error instanceof MalformedJsonError) {
      throw new MalformedSettingsError(settingsPath, error.cause);
    }
    throw error;
  }
}

function readBackupSnapshot(backupPath) {
  let snapshot;
  try {
    snapshot = readJsonSnapshot(backupPath);
  } catch (error) {
    if (error instanceof MalformedJsonError) {
      throw new MalformedBackupError(backupPath, error.cause);
    }
    throw error;
  }
  if (snapshot.value === null) return snapshot;
  if (typeof snapshot.value !== 'object' || Array.isArray(snapshot.value)
      || !Object.prototype.hasOwnProperty.call(snapshot.value, 'previous')) {
    throw new MalformedBackupError(
      backupPath,
      new Error('expected an object containing a "previous" property'),
    );
  }
  return snapshot;
}

function assertBackupUnchanged(backupPath, expectedSnapshot) {
  const expectedIdentity = expectedSnapshot.expectedDestination.identity;
  const currentIdentity = regularFileIdentity(backupPath);
  if (!sameFileIdentity(currentIdentity, expectedIdentity)) {
    throw new BackupChangedError(backupPath);
  }

  let currentContent;
  try {
    currentContent = readFileSync(backupPath);
  } catch {
    throw new BackupChangedError(backupPath);
  }
  const afterRead = regularFileIdentity(backupPath);
  if (!sameFileIdentity(afterRead, expectedIdentity)
      || !currentContent.equals(expectedSnapshot.content)) {
    throw new BackupChangedError(backupPath);
  }
}

function removeExactBackup(backupPath, snapshot) {
  try {
    assertBackupUnchanged(backupPath, snapshot);
  } catch {
    return false;
  }
  return removeOwnedRegularFile(backupPath, snapshot.expectedDestination.identity);
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
  return withProbeLease(settingsPath, () => {
    const settingsSnapshot = readSettingsSnapshot(settingsPath);
    let settings = settingsSnapshot.value;
    if (settings === null) settings = {};

    if (isProbeEntry(settings.statusLine)) {
      throw new ProbeAlreadyActiveError();
    }

    const indent = detectIndent(settingsPath);
    waitForProbeTestInterlock('enable-after-read');
    const backupSnapshot = captureRegularFileSnapshot(backupPath);
    writeJsonAtomic(
      backupPath,
      { previous: settings.statusLine || null },
      2,
      backupSnapshot.expectedDestination,
    );
    const writtenBackupSnapshot = readBackupSnapshot(backupPath);
    settings.statusLine = buildProbeEntry(probeBinAbsPath);
    waitForProbeTestInterlock('enable-before-settings-write');
    try {
      // The backup and settings are a pair. Do not publish settings if an
      // external writer replaced the newly-written backup in the meantime.
      assertBackupUnchanged(backupPath, writtenBackupSnapshot);
      writeJsonAtomic(settingsPath, settings, indent, settingsSnapshot.expectedDestination);
    } catch (error) {
      // Only remove the exact backup this transition published. A successor
      // remains untouched and therefore cannot be mistaken for our recovery
      // data by a later stop operation.
      removeExactBackup(backupPath, writtenBackupSnapshot);
      throw error;
    }

    // Truncate the log so the new session starts clean. mkdir first in case
    // ~/.claude/cah-bin/cache does not exist yet.
    mkdirSync(dirname(logPath), { recursive: true });
    writeFileSync(logPath, '');
  });
}

/**
 * Reverse enableProbe: read backup, restore the original statusLine entry
 * (or remove the key if there was none), delete the backup.
 *
 * Returns { restored: originalStatusLineOrNull }.
 */
export function disableProbe({ settingsPath, backupPath }) {
  return withProbeLease(settingsPath, () => {
    const settingsSnapshot = readSettingsSnapshot(settingsPath);
    const settings = settingsSnapshot.value;
    if (!settings || !isProbeEntry(settings.statusLine)) {
      throw new ProbeNotActiveError();
    }
    const backupSnapshot = readBackupSnapshot(backupPath);
    if (backupSnapshot.value === null) throw new MissingBackupError(backupPath);

    const previous = Object.prototype.hasOwnProperty.call(backupSnapshot.value, 'previous')
      ? backupSnapshot.value.previous
      : null;

    const indent = detectIndent(settingsPath);
    if (previous === null) {
      delete settings.statusLine;
    } else {
      settings.statusLine = previous;
    }
    waitForProbeTestInterlock('disable-after-read');
    waitForProbeTestInterlock('disable-before-settings-write');
    // A valid backup is only safe to use if the exact file and bytes captured
    // above are still present immediately before restoring settings.
    assertBackupUnchanged(backupPath, backupSnapshot);
    writeJsonAtomic(settingsPath, settings, indent, settingsSnapshot.expectedDestination);

    // The backup may have been replaced after it was read. Remove only the
    // exact regular-file leaf captured above; a successor backup is preserved.
    waitForProbeTestInterlock('disable-before-backup-remove');
    if (backupSnapshot.expectedDestination.identity) removeExactBackup(backupPath, backupSnapshot);
    return { restored: previous };
  });
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
