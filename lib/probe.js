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
import { LEASE_MAX_MS } from './lease-clock.js';
import { acquireSettingsLock, releaseSettingsLock, settingsLockOwned } from './settings-lock.js';

export const PROBE_SENTINEL = 'cah-probe-statusline:v1';
export const PROBE_NAME = 'probe';
const PROBE_LOCK_STALE_MS = LEASE_MAX_MS;

function parseJsonText(text) {
  // Keep compatibility with older files/tests containing the UTF-8 BOM
  // decoded once as Latin-1, as well as a real U+FEFF prefix.
  if (text.startsWith('ï»¿')) text = text.slice(3);
  return JSON.parse(text.replace(/^\uFEFF/, ''));
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
    present: snapshot.present,
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

// The generated statusLine command string is executed by a shell, not by an
// argv array. Inside double quotes POSIX shells still expand $var, $(command)
// and backticks, cmd.exe still expands %VAR%, and a literal double-quote ends
// the argument outright. No escaping covers every shell that can run this
// string, so generation refuses any path carrying shell-active characters
// instead of silently installing a command that breaks or executes expanded
// content. Direct argv-array invocation of the same path is unaffected.
export const UNSAFE_STATUSLINE_CHARS = /["`$&<>|;^!%]|[\u0000-\u001f]/;

function buildProbeEntry(probeBinAbsPath) {
  if (UNSAFE_STATUSLINE_CHARS.test(probeBinAbsPath)) {
    throw new ProbePathUnsafeError(probeBinAbsPath);
  }
  // node accepts forward slashes on every platform; normalizing keeps the
  // command working under POSIX-like shells on Windows and across synced
  // dotfiles.
  const safe = probeBinAbsPath.replace(/\\/g, '/');
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

export class ProbePathUnsafeError extends Error {
  constructor(probeBinAbsPath) {
    super('probe path contains characters a shell would interpret in the '
      + `generated statusLine command: ${probeBinAbsPath}. `
      + 'Move the cah-bin tree to a path built from plain filesystem characters.');
    this.name = 'ProbePathUnsafeError';
    this.path = probeBinAbsPath;
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

export class ProbeLeaseLostError extends Error {
  constructor(cause) {
    super('probe settings lease was lost mid-transition — a successor operation owns the '
      + 'settings transition; refusing to change settings, backup, or log', { cause });
    this.name = 'ProbeLeaseLostError';
    this.cause = cause;
  }
}

function acquireProbeLease(settingsPath, testInterlock = null) {
  // Probe rewiring shares the skills' settings.json.lock namespace: enable or
  // disable must never interleave with a cooperating skill's read-modify-write
  // cycle. The lease primitives themselves stay identical (owner token +
  // generation, verified fence, fail-fast busy) — only the name converges.
  const handle = acquireSettingsLock(settingsPath, {
    kind: 'cc-arch-hands-probe',
    // Probe rewiring is a multi-file transition. Leave a live or uncertain
    // operation fenced for the full conservative lease period rather than
    // allowing a second caller to guess that it is safe to continue.
    staleAfterMs: PROBE_LOCK_STALE_MS,
    fenceSuffix: '.stale-',
    deadlineMs: 0, // fail fast: a busy settings lock surfaces as ProbeBusyError
    interlockPhase: 'probe-lease-reclaim',
    releaseInterlockPhase: 'probe-lease-release',
    testInterlock,
  });
  if (!handle) throw new ProbeBusyError();
  return handle;
}

function withProbeLease(settingsPath, operation, testInterlock = null) {
  const handle = acquireProbeLease(settingsPath, testInterlock);
  try {
    return operation(handle);
  } finally {
    releaseSettingsLock(handle);
  }
}

// Every mutating stage of the multi-file transition gates on the SAME lease
// generation captured once at acquire time. A destination-snapshot CAS only
// proves a leaf still matches what this operation last saw; it cannot tell a
// successor's committed work from this operation's own stale leftover. Once
// the lease is gone, the stale owner must neither publish nor clean up —
// including rolling back its own earlier stages, because a successor may
// already depend on the current on-disk state.
function assertProbeLeaseHeld(handle) {
  if (!settingsLockOwned(handle)) throw new ProbeLeaseLostError();
}

function readSettingsSnapshot(settingsPath) {
  let snapshot;
  try {
    snapshot = readJsonSnapshot(settingsPath);
  } catch (error) {
    if (error instanceof MalformedJsonError) {
      throw new MalformedSettingsError(settingsPath, error.cause);
    }
    throw error;
  }
  // A valid JSON document whose root is not a plain object cannot carry a
  // statusLine key: enabling against one would silently drop the probe entry
  // on serialization (JSON.stringify drops named properties of arrays and
  // returns primitives verbatim), report success, and strand an orphan
  // backup no command path can remove. Refuse before any log, backup, or
  // settings mutation. An ABSENT file stays legal (present false, value
  // null) — enable creates it.
  if (snapshot.present
      && (typeof snapshot.value !== 'object' || snapshot.value === null
        || Array.isArray(snapshot.value))) {
    throw new MalformedSettingsError(settingsPath, new Error(
      `expected a JSON object at the document root, found ${describeJsonRoot(snapshot.value)}`));
  }
  return snapshot;
}

function describeJsonRoot(value) {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'an array';
  return `a ${typeof value}`;
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

// A writeJsonAtomic() call whose canonical rename already committed attaches
// the exact published identity to the thrown error (committedPublication,
// from writeFileAtomic). The local publishedSnapshot variable stays null in
// exactly that case, so rollback decisions must fall back to the error's
// record; rollbackExactPublication() re-verifies the destination against the
// snapshot before touching anything, so a concurrent successor is never
// clobbered by a rollback built from stale expectations.
function committedPublicationSnapshot(path, error) {
  const committed = error?.committedPublication;
  if (!committed || committed.path !== path
      || !committed.expectedDestination?.identity) return null;
  return {
    expectedDestination: committed.expectedDestination,
    contentDigest: committed.contentDigest ?? null,
    contentBytes: committed.contentBytes ?? null,
  };
}

function currentSettingsCarryProbeEntry(settingsPath) {
  let text;
  try {
    text = readFileSync(settingsPath, 'utf8');
  } catch (error) {
    if (error && error.code === 'ENOENT') return false;
    return true;
  }
  let parsed;
  try {
    parsed = parseJsonText(text);
  } catch {
    return true;
  }
  return !!parsed && typeof parsed === 'object' && !Array.isArray(parsed)
    && isProbeEntry(parsed.statusLine);
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
  return withProbeLease(settingsPath, (lease) => {
    const settingsSnapshot = readSettingsSnapshot(settingsPath);
    let settings = settingsSnapshot.value;
    if (settings === null) settings = {};

    if (isProbeEntry(settings.statusLine)) {
      throw new ProbeAlreadyActiveError();
    }

    // Reject an unusable probe path before any state transition: the log and
    // the backup are published below, and neither may be created for an
    // enable that cannot produce a safe statusLine command.
    const probeEntry = buildProbeEntry(probeBinAbsPath);

    const indent = detectIndent(settingsPath);
    // Prepare the log before publishing either side of the pairwise state
    // transition. A directory, link, hard link, unwritable path, or other log
    // failure must leave settings and backup untouched. The log has no
    // ownership sentinel, so an existing safe regular file is conservatively
    // treated as a replaceable foreign leaf and is never rollback-owned.
    assertProbeLeaseHeld(lease);
    const logSnapshot = prepareProbeLog(logPath);
    writeFileAtomic(logPath, '', {
      expectedDestination: logSnapshot.expectedDestination, testInterlock: options.testInterlock,
    });
    options.testInterlock?.('enable-after-read');
    assertProbeLeaseHeld(lease);
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

      settings.statusLine = probeEntry;
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
      assertProbeLeaseHeld(lease);
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
      // A stale owner must not rewrite anything after a successor reclaimed
      // the lease — not even its own earlier stages.
      if (!settingsLockOwned(lease)) throw new ProbeLeaseLostError(error);
      // The settings write may have committed its rename before throwing, in
      // which case the exact published identity lives on the error, not in
      // the local snapshot variable. Rolling back against it (after
      // exact-identity verification) restores the original settings instead
      // of leaving an armed probe whose backup the backup rollback below
      // would then delete - the one outcome that loses the user's original
      // statusLine for good.
      const settingsCommitted = publishedSettingsSnapshot
        || committedPublicationSnapshot(settingsPath, error);
      const settingsReverted = settingsCommitted
        ? rollbackExactPublication(
          settingsPath, settingsSnapshot, settingsCommitted, options.testInterlock,
        )
        : false;
      // The transition's own backup is removed only when no armed probe can
      // still depend on it: either this catch reverted the settings leaf to
      // its pre-enable content (the rollback re-proved the exact identity
      // first, so the probe entry is gone), or the CURRENT settings content
      // provably lacks the probe entry. An identity change alone — an
      // external editor's re-save, byte-identical or with an unrelated key —
      // keeps the backup, because the probe it recovers is still armed.
      const backupStillNeeded = !settingsReverted
        && currentSettingsCarryProbeEntry(settingsPath);
      if (!backupStillNeeded) {
        rollbackExactPublication(
          backupPath, backupSnapshot, writtenBackupSnapshot
            || committedPublicationSnapshot(backupPath, error),
          options.testInterlock,
        );
      }
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
  return withProbeLease(settingsPath, (lease) => {
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
      assertProbeLeaseHeld(lease);
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
      // A stale owner must not rewrite anything after a successor reclaimed
      // the lease — not even its own earlier stages.
      if (!settingsLockOwned(lease)) throw new ProbeLeaseLostError(error);
      // Mirror of enable: the restoration write may have committed its rename
      // before throwing, with the exact published identity only on the error.
      // Reverting the verified publication keeps the probe armed with its
      // backup intact, so the failure is honest and a retry can succeed.
      const settingsCommitted = publishedSettingsSnapshot
        || committedPublicationSnapshot(settingsPath, error);
      if (settingsCommitted) {
        rollbackExactPublication(
          settingsPath, settingsSnapshot, settingsCommitted, options.testInterlock,
        );
      }
      throw error;
    }

    // The backup may have been replaced after it was read. Remove only the
    // exact regular-file leaf captured above; a successor backup is preserved.
    options.testInterlock?.('disable-before-backup-remove');
    assertProbeLeaseHeld(lease);
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
  const settings = readSettingsSnapshot(settingsPath).value;
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
