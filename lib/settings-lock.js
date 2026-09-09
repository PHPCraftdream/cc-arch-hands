// The shared cross-process lock for `<path>.settings.json` mutations.
//
// Every writer of the same settings.json takes the same named lock: the
// clock/checkpoint-watch skills and enable/disableProbe all contend on
// `<settingsPath>.lock`, so no cooperating read-modify-write cycle can
// interleave with another. Ownership and reclamation semantics are inherited
// from lib/lease-lock.js directory leases — an owner is PROVED by a live pid
// plus its recorded token/generation, never by the absence of an owner file.
// The one window the directory lease cannot distinguish is a crash between
// mkdir and the owner write; an ownerless claim therefore stays untouchable
// until its directory mtime ages past staleAfterMs. Reclamation goes through
// lease-lock's verified fence: rename aside, verify what moved, and
// quarantine anything unrecognized — never blind-delete. Release re-verifies
// the recorded token/generation before removing, so a successor's live claim
// is never deleted by a stale releaser.

import { readdirSync, statSync } from 'node:fs';
import { acquireLease, leaseOwned, releaseLease, renewLease } from './lease-lock.js';
import { sleepSyncWait } from './lease-clock.js';

export const SETTINGS_LOCK_SUFFIX = '.lock';
export const SETTINGS_LOCK_FENCE_SUFFIX = '.stale-';
const LEGACY_SETTINGS_FENCE_SUFFIXES = ['.stale.'];
export const SETTINGS_LOCK_KIND = 'cc-arch-hands-settings';
// Ownerless claims may be reclaimed only after their directory mtime ages
// past this; it bounds how long a crash between mkdir and owner write can
// block everyone. Mirrors acquireLease's own default.
export const SETTINGS_LOCK_OWNERLESS_STALE_MS = 30_000;

export function settingsLockPath(settingsPath) {
  return `${settingsPath}${SETTINGS_LOCK_SUFFIX}`;
}

// True when the lock directory exists with no owner.json and its mtime has
// NOT yet aged past staleAfterMs — the crash-between-mkdir-and-owner-write
// window, which must block everyone instead of being reclaimed early. Any
// read failure (dir vanished, became a file, unreadable) means "not gated":
// acquireLease owns the authoritative verdict for states we cannot see.
function ownerlessFreshClaim(lockPath, staleAfterMs) {
  let entries;
  try {
    entries = readdirSync(lockPath);
  } catch {
    return false;
  }
  if (entries.includes('owner.json')) return false;
  try {
    // A directory created microseconds ago can read a fraction of a
    // millisecond in the future against Date.now() (filesystem timestamp
    // granularity). Any mtime not older than the window is fresh — the same
    // treatment lib/fs-atomic-identity.js's isOlderThan gives future mtimes
    // in lease-lock's own reclaim rule.
    const age = Date.now() - statSync(lockPath).mtimeMs;
    return age < staleAfterMs;
  } catch {
    return false;
  }
}

export function acquireSettingsLock(settingsPath, options = {}) {
  if (options.fenceSuffix !== undefined && options.fenceSuffix !== SETTINGS_LOCK_FENCE_SUFFIX) {
    throw new TypeError('settings writers must use the shared fence namespace');
  }
  // Wait about 200 ms between attempts, give up after about 30 seconds; a
  // deadlineMs <= 0 means exactly one attempt (callers decide what "busy"
  // means for them).
  const deadlineMs = options.deadlineMs ?? 30_000;
  const waitStepMs = options.waitStepMs ?? 200;
  const forward = {};
  // Only forward what the caller actually supplied, so lease-lock defaults
  // (and future additions to it) keep applying to the rest.
  for (const key of [
    'staleAfterMs', 'interlockPhase', 'releaseInterlockPhase',
    'testInterlock', 'testLeaseEnv', 'pidIsAlive',
  ]) {
    if (options[key] !== undefined) forward[key] = options[key];
  }
  const staleAfterMs = options.staleAfterMs ?? SETTINGS_LOCK_OWNERLESS_STALE_MS;
  const waitDeadline = deadlineMs > 0 ? Date.now() + deadlineMs : 0;
  const lockPath = settingsLockPath(settingsPath);
  for (;;) {
    // Gate the ownerless initialization gap here: acquireLease() removes an
    // empty claim directory when mkdir loses the race, so a plain retry loop
    // would claim (rather than respect) a fresh ownerless reservation. Wait
    // WITHOUT re-attempting until the ownerless claim's directory mtime ages
    // past staleAfterMs; only then may the verified fence reclaim it.
    if (ownerlessFreshClaim(lockPath, staleAfterMs)) {
      if (deadlineMs <= 0 || Date.now() >= waitDeadline) return null;
      const remaining = waitDeadline - Date.now();
      sleepSyncWait(Math.min(waitStepMs, remaining));
      continue;
    }
    const lease = acquireLease(lockPath, {
      staleAfterMs, kind: SETTINGS_LOCK_KIND, ...forward,
      fenceSuffix: SETTINGS_LOCK_FENCE_SUFFIX,
      legacyFenceSuffixes: LEGACY_SETTINGS_FENCE_SUFFIXES,
    });
    if (lease) {
      return {
        path: lease.path,
        settingsPath,
        owner: lease.owner,
        token: lease.token,
        generation: lease.generation,
        lease,
      };
    }
    if (deadlineMs <= 0 || Date.now() >= waitDeadline) return null;
    const remaining = waitDeadline - Date.now();
    sleepSyncWait(Math.min(waitStepMs, remaining));
  }
}

export function settingsLockOwned(handle) {
  return Boolean(handle?.lease) && leaseOwned(handle.lease);
}

export function renewSettingsLock(handle) {
  return Boolean(handle?.lease) && renewLease(handle.lease);
}

export function releaseSettingsLock(handle) {
  // releaseLease() re-verifies the recorded owner (token + generation) and
  // fences before removing: a successor's live claim is never deleted. Its
  // boolean says whether THIS caller released; false means ownership was
  // already lost and nothing was deleted.
  return Boolean(handle?.lease) && releaseLease(handle.lease);
}

export function withSettingsLock(settingsPath, operation, options = {}) {
  const handle = acquireSettingsLock(settingsPath, options);
  if (!handle) return { ok: false, reason: 'lock-timeout' };
  try {
    return { ok: true, value: operation(handle) };
  } finally {
    // Release on EVERY exit path, including a throwing operation.
    releaseSettingsLock(handle);
  }
}
