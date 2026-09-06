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
  lstatSync,
  statSync,
} from 'node:fs';
import { dirname } from 'node:path';
import {
  captureRegularFileSnapshot,
  removeOwnedRegularFile,
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
    contentDigest: snapshot.contentDigest,
    contentBytes: snapshot.contentBytes,
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

function writeJsonAtomic(path, data, indent = 2, expectedDestination, testInterlock = null) {
  const payload = JSON.stringify(data, null, indent) + '\n';
  return writeFileAtomic(path, payload, {
    expectedDestination,
    testInterlock,
  });
}

// A probe log is a declared destination, but its contents have no ownership
// sentinel. Treat an existing regular file as replaceable only after an
// lstat-based safety check: links, directories, special files, and hard-linked
// files may name user data outside this path. The returned snapshot supplies a
// digest-bearing CAS expectation to the atomic publisher, so a concurrent
// successor is rejected instead of being silently replaced.
function prepareProbeLog(logPath) {
  mkdirSync(dirname(logPath), { recursive: true });

  let observed;
  try {
    observed = lstatSync(logPath, { bigint: true });
  } catch (error) {
    if (error && error.code === 'ENOENT') {
      observed = null;
    } else {
      throw error;
    }
  }

  if (observed !== null) {
    if (!observed.isFile()) {
      throw new Error(`probe log path is not a regular file: ${logPath}`);
    }
    if (observed.nlink > 1n) {
      throw new Error(`probe log path has multiple links: ${logPath}`);
    }
  }

  const snapshot = captureRegularFileSnapshot(logPath);
  // A missing path may have been replaced by a non-regular entry between the
  // lstat above and the snapshot. Do not rely on regularFileIdentity (which
  // intentionally returns null for links/special files) to classify it.
  let current;
  try {
    current = lstatSync(logPath, { bigint: true });
  } catch (error) {
    if (error && error.code === 'ENOENT') current = null;
    else throw error;
  }
  if (current !== null && !current.isFile()) {
    throw new Error(`probe log path is not a regular file: ${logPath}`);
  }
  if (current !== null && current.nlink > 1n) {
    throw new Error(`probe log path has multiple links: ${logPath}`);
  }
  if ((observed === null) !== (current === null)) {
    throw new Error(`probe log path changed concurrently: ${logPath}`);
  }
  return snapshot;
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

function acquireProbeLease(settingsPath, testInterlock = null) {
  const lease = acquireLease(probeLockPath(settingsPath), {
    kind: 'cc-arch-hands-probe',
    // Probe rewiring is a multi-file transition. Leave a live or uncertain
    // operation fenced for the full conservative lease period rather than
    // allowing a second caller to guess that it is safe to continue.
    staleAfterMs: PROBE_LOCK_STALE_MS,
    fenceSuffix: '.stale-',
    interlockPhase: 'probe-lease-reclaim',
    releaseInterlockPhase: 'probe-lease-release',
    testInterlock,
  });
  if (!lease) throw new ProbeBusyError();
  return lease;
}

function withProbeLease(settingsPath, operation, testInterlock = null) {
  const lease = acquireProbeLease(settingsPath, testInterlock);
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
  try {
    assertExactFileSnapshot(backupPath, expectedSnapshot);
  } catch {
    throw new BackupChangedError(backupPath);
  }
}

function assertExactFileSnapshot(path, expectedSnapshot) {
  const expectedIdentity = expectedSnapshot.expectedDestination.identity;
  if (expectedIdentity === null) {
    try {
      // An absent expected leaf must remain genuinely absent. In particular,
      // a dangling symlink is not equivalent to a missing regular file.
      lstatSync(path, { bigint: true });
      throw new Error('file changed concurrently');
    } catch (error) {
      if (error && error.code !== 'ENOENT') throw error;
    }
    return;
  }
  const current = captureRegularFileSnapshot(path);
  if (!current.present
      || !sameFileIdentity(current.expectedDestination.identity, expectedIdentity)
      || current.contentDigest !== expectedSnapshot.contentDigest
      || current.contentBytes !== expectedSnapshot.contentBytes) {
    throw new Error('file changed concurrently');
  }
}

// Undo a publication only while the exact leaf produced by this transition
// is still at the destination. In particular, a writer which ignores the
// operation lease can install a successor between the check and the rename;
// the expected-destination CAS in writeFileAtomic then leaves that successor
// alone.
function rollbackExactPublication(path, beforeSnapshot, publishedSnapshot, testInterlock = null) {
  if (!publishedSnapshot) return false;
  try {
    assertExactFileSnapshot(path, publishedSnapshot);
    if (beforeSnapshot.expectedDestination.identity === null) {
      return removeOwnedRegularFile(path, publishedSnapshot.expectedDestination);
    }
    writeFileAtomic(path, beforeSnapshot.content, {
      expectedDestination: publishedSnapshot.expectedDestination,
      testInterlockPhase: 'probe-rollback-before-final',
      testInterlock,
    });
    return true;
  } catch {
    return false;
  }
}

function removeExactBackup(backupPath, snapshot) {
  try {
    assertExactFileSnapshot(backupPath, snapshot);
  } catch {
    return false;
  }
  return removeOwnedRegularFile(backupPath, snapshot.expectedDestination);
}

function settingsPublicationError() {
  return new Error('managed destination leaf changed concurrently; refusing operation');
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
export function enableProbe({ settingsPath, probeBinAbsPath, backupPath, logPath }, options = {}) {
  return withProbeLease(settingsPath, () => {
    const settingsSnapshot = readSettingsSnapshot(settingsPath);
    let settings = settingsSnapshot.value;
    if (settings === null) settings = {};

    if (isProbeEntry(settings.statusLine)) {
      throw new ProbeAlreadyActiveError();
    }

    const indent = detectIndent(settingsPath);
    // Prepare the log before publishing either side of the pairwise state
    // transition. A directory, link, hard link, unwritable path, or other log
    // failure must leave settings and backup untouched. The log has no
    // ownership sentinel, so an existing safe regular file is conservatively
    // treated as a replaceable foreign leaf and is never rollback-owned.
    const logSnapshot = prepareProbeLog(logPath);
    writeFileAtomic(logPath, '', {
      expectedDestination: logSnapshot.expectedDestination, testInterlock: options.testInterlock,
    });
    options.testInterlock?.('enable-after-read');
    const backupSnapshot = captureRegularFileSnapshot(backupPath);
    let writtenBackupSnapshot = null;
    let publishedSettingsSnapshot = null;
    try {
      writtenBackupSnapshot = writeJsonAtomic(
        backupPath,
        { previous: settings.statusLine || null },
        2, backupSnapshot.expectedDestination, options.testInterlock,
      );
      // Parsing the just-published body also keeps the backup validation on
      // the same path-specific error contract as stop.
      readBackupSnapshot(backupPath);

      settings.statusLine = buildProbeEntry(probeBinAbsPath);
      options.testInterlock?.('enable-before-settings-write');
      // This is deliberately immediately before the settings CAS. The lease
      // fences cooperating callers, while these checks fence writers that do
      // not use it.
      assertBackupUnchanged(backupPath, writtenBackupSnapshot);
      options.testInterlock?.(
        'enable-post-backup-check', 'enable-after-backup-check', 'post-backup-check',
      );
      options.testInterlock?.(
        'enable-pre-settings-rename', 'enable-before-settings-rename', 'pre-settings-rename',
      );
      assertBackupUnchanged(backupPath, writtenBackupSnapshot);
      publishedSettingsSnapshot = writeJsonAtomic(
        settingsPath,
        settings,
        indent, settingsSnapshot.expectedDestination, options.testInterlock,
      );
      options.testInterlock?.(
        'enable-post-settings-rename', 'enable-after-settings-rename', 'post-settings-rename',
      );

      // A settings CAS can succeed while an external writer replaces the
      // backup. Never leave an armed probe whose recovery data is not the
      // exact backup published by this enable.
      try {
        assertExactFileSnapshot(settingsPath, publishedSettingsSnapshot);
      } catch {
        throw settingsPublicationError();
      }
      assertBackupUnchanged(backupPath, writtenBackupSnapshot);
    } catch (error) {
      rollbackExactPublication(settingsPath, settingsSnapshot, publishedSettingsSnapshot, options.testInterlock);
      rollbackExactPublication(backupPath, backupSnapshot, writtenBackupSnapshot, options.testInterlock);
      throw error;
    }

  }, options.testInterlock);
}

/**
 * Reverse enableProbe: read backup, restore the original statusLine entry
 * (or remove the key if there was none), delete the backup.
 *
 * Returns { restored: originalStatusLineOrNull }.
 */
export function disableProbe({ settingsPath, backupPath }, options = {}) {
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
    options.testInterlock?.('disable-after-read');
    options.testInterlock?.('disable-before-settings-write');
    // A valid backup is only safe to use if the exact file and bytes captured
    // above are still present immediately before restoring settings.
    assertBackupUnchanged(backupPath, backupSnapshot);
    options.testInterlock?.(
      'disable-post-backup-check', 'disable-after-backup-check', 'post-backup-check',
    );
    options.testInterlock?.(
      'disable-pre-settings-rename', 'disable-before-settings-rename', 'pre-settings-rename',
    );
    assertBackupUnchanged(backupPath, backupSnapshot);

    let publishedSettingsSnapshot = null;
    try {
      publishedSettingsSnapshot = writeJsonAtomic(
        settingsPath, settings, indent, settingsSnapshot.expectedDestination, options.testInterlock,
      );
      options.testInterlock?.(
        'disable-post-settings-rename', 'disable-after-settings-rename', 'post-settings-rename',
      );

      // Stop has the mirror-image obligation: if the backup changes after
      // settings publication, restore only our exact settings leaf and keep
      // the successor backup for its writer to recover.
      try {
        assertExactFileSnapshot(settingsPath, publishedSettingsSnapshot);
      } catch {
        throw settingsPublicationError();
      }
      assertBackupUnchanged(backupPath, backupSnapshot);
    } catch (error) {
      rollbackExactPublication(settingsPath, settingsSnapshot, publishedSettingsSnapshot, options.testInterlock);
      throw error;
    }

    // The backup may have been replaced after it was read. Remove only the
    // exact regular-file leaf captured above; a successor backup is preserved.
    options.testInterlock?.('disable-before-backup-remove');
    if (backupSnapshot.expectedDestination.identity) removeExactBackup(backupPath, backupSnapshot);
    return { restored: previous };
  }, options.testInterlock);
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
    // Keep the public status value numeric for the CLI, while keeping the
    // filesystem identity lookup exact inside Node's bigint stat result.
    logSize = Number(statSync(logPath, { bigint: true }).size);
    logRecords = readProbeLog(logPath).length;
  } catch {
    logSize = 0;
    logRecords = 0;
  }
  return { active, backupExists, logSize, logRecords };
}
