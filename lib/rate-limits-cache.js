// Session-scoped quota and context-window cache, shared through transcript-stats.
import { readFileSync, opendirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { basename, dirname, join } from 'node:path';
import { FUTURE_SKEW_TOLERANCE_MS } from './lease-clock.js';
import { lstatMaybe } from './fs-atomic-identity.js';
import { removeOwnedRegularFile, captureRegularFileSnapshot, regularFileIdentity, writeFileAtomic } from './fsutil.js';

// rate_limits state captured by cah-status and read by cah-stamp. Quota slots
// are session-scoped so a Codex session cannot inherit another session's 5h cap.
// Stale beyond this many ms — ignored.
const RATE_LIMITS_MAX_AGE_MS = 60 * 60 * 1000;
const STATUSLINE_RATE_FALLBACK_MAX_AGE_MS = 5 * 60 * 1000;
const RATE_CONTEXT_MAX_SESSIONS = 64;
const RATE_CONTEXT_PREFIX = '.context-';
const RATE_CONTEXT_NAMESPACE = 'rate-context';
const RATE_CONTEXT_NAME_RE = /^[a-f0-9]{64}\.json$/;
// The namespace is owned by this cache family. Keep routine status renders
// bounded even if a damaged/shared cache has accumulated many leaves.
const RATE_CONTEXT_VISIT_LIMIT = 256;

export function validContextWindowSize(value) {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null;
}

function rateContextHash(sessionId) {
  const identity = typeof sessionId === 'string' ? `string:${sessionId}` : 'missing:';
  return createHash('sha256').update(identity, 'utf8').digest('hex');
}

/**
 * Return the sidecar used for one session's context-window observation.
 * Session IDs never appear in a path: even long/unusual strings are SHA-256
 * hashed to distinct fixed-size names.
 */
export function rateLimitsContextPath(cachePath, sessionId) {
  return join(rateContextNamespace(cachePath), `${rateContextHash(sessionId)}.json`);
}

export function rateContextNamespace(cachePath, prefix = RATE_CONTEXT_NAMESPACE) {
  const name = basename(cachePath);
  const key = process.platform === 'win32' ? name.toLowerCase() : name;
  const namespace = key === 'rate-limits.json' ? prefix
    : `${prefix}-${createHash('sha256').update(key).digest('hex')}`;
  return join(dirname(cachePath), namespace);
}

function legacyRateLimitsContextPath(cachePath, sessionId) {
  return `${cachePath}${RATE_CONTEXT_PREFIX}${rateContextHash(sessionId)}.json`;
}

function readJson(path) {
  try {
    const obj = JSON.parse(readFileSync(path, 'utf8'));
    return obj && typeof obj === 'object' ? obj : null;
  } catch {
    return null;
  }
}

export function isFresh(capturedAt, nowMs) {
  return Number.isFinite(capturedAt)
    && capturedAt <= nowMs + FUTURE_SKEW_TOLERANCE_MS
    && nowMs - capturedAt <= RATE_LIMITS_MAX_AGE_MS;
}

export function rateQuotaSessionHash(sessionId) {
  return typeof sessionId === 'string' && sessionId
    ? createHash('sha256').update(`string:${sessionId}`, 'utf8').digest('hex')
    : null;
}

function rateSlotSessionMatches(cache, key, sessionId) {
  if (sessionId == null) return true;
  const expected = rateQuotaSessionHash(sessionId);
  return expected !== null && cache?.[`${key}SessionHash`] === expected;
}

export function rateLimitsQuotaPath(cachePath, sessionId) {
  const hash = rateQuotaSessionHash(sessionId);
  return hash ? join(rateContextNamespace(cachePath, 'rate-quota'), `${hash}.json`) : null;
}

function sessionRateState(cachePath, sessionId, base, nowMs, diagnostics = null) {
  const path = rateLimitsQuotaPath(cachePath, sessionId);
  if (!path) return base;
  const local = readJson(path);
  const result = {};
  for (const key of ['fiveHour', 'sevenDay']) {
    const candidates = [local, base].filter((state) =>
      rateSlotSessionMatches(state, key, sessionId) && usableRateSlot(state?.[key])
      && isFresh(rateSlotCapturedAt(state, key), nowMs));
    candidates.sort((a, b) => (rateSlotCapturedAt(b, key) ?? -Infinity)
      - (rateSlotCapturedAt(a, key) ?? -Infinity));
    const selected = candidates[0];
    if (diagnostics?.key === key) {
      const matching = [local, base].filter((state) => rateSlotSessionMatches(state, key, sessionId));
      matching.sort((a, b) => (rateSlotCapturedAt(b, key) ?? -Infinity)
        - (rateSlotCapturedAt(a, key) ?? -Infinity));
      const observed = selected || matching[0];
      const capturedAt = rateSlotCapturedAt(observed, key);
      diagnostics.ageMs = Number.isFinite(capturedAt) ? nowMs - capturedAt : null;
      diagnostics.reason = ![local, base].some((state) => state?.[key] != null) ? 'cache_missing'
        : !matching.length ? 'session_mismatch'
          : !usableRateSlot(observed?.[key]) ? 'slot_invalid'
            : !Number.isFinite(capturedAt) ? 'capture_invalid'
              : !isFresh(capturedAt, nowMs) ? 'stale' : 'cache';
    }
    result[key] = selected?.[key] ?? null;
    result[`${key}CapturedAt`] = rateSlotCapturedAt(selected, key);
    result[`${key}SessionHash`] = selected?.[`${key}SessionHash`] ?? null;
  }
  return result;
}

function rateSlotCapturedAt(cache, key) {
  const field = `${key}CapturedAt`;
  if (cache && Object.prototype.hasOwnProperty.call(cache, field)) {
    return Number.isFinite(cache[field]) ? cache[field] : null;
  }
  return Number.isFinite(cache?.capturedAt) ? cache.capturedAt : null;
}

function usableRateSlot(slot) {
  return slot && typeof slot === 'object' && !Array.isArray(slot)
    && Number.isFinite(slot.used) && slot.used >= 0 && slot.used <= 100
    && (slot.resetsAt == null || typeof slot.resetsAt === 'string');
}

function validRateState(value) {
  const keys = ['fiveHour', 'sevenDay'];
  return value && keys.some((key) => Object.prototype.hasOwnProperty.call(value, key))
    && keys.every((key) => {
      const slot = value[key];
      return slot == null || (typeof slot === 'object' && !Array.isArray(slot)
        && ['used', 'resetsAt'].some((field) => Object.prototype.hasOwnProperty.call(slot, field))
        && (slot.used == null || Number.isFinite(slot.used))
        && (slot.resetsAt == null || typeof slot.resetsAt === 'string'));
    });
}

function writeJsonAtomic(path, value) {
  try {
    const entry = lstatMaybe(path);
    if (entry && !entry.isFile()) return false;
    const snapshot = captureRegularFileSnapshot(path);
    let previous = null;
    try { if (snapshot.present) previous = JSON.parse(snapshot.content.toString('utf8')); } catch { /* replace malformed cache */ }
    const validPrevious = value.contextWindowSize !== undefined
      ? validContextWindowSize(previous?.contextWindowSize) !== null
      : validRateState(previous);
    if (validPrevious && Number.isFinite(previous?.capturedAt)
        && previous.capturedAt <= Date.now() + FUTURE_SKEW_TOLERANCE_MS
        && previous.capturedAt > value.capturedAt) return false;
    writeFileAtomic(path, JSON.stringify(value) + '\n', {
      expectedDestination: snapshot.expectedDestination,
      // Cache publication must not delay the panel on a busy fence.
      waitForFence: false,
    });
    return true;
  } catch {
    // Cache publication is best-effort for hook callers.
    return false;
  }
}

function contextSidecar(path) {
  try {
    if (!regularFileIdentity(path)) return null;
    const snapshot = captureRegularFileSnapshot(path);
    if (!snapshot.present) return null;
    const raw = snapshot.content;
    let value = null;
    try {
      const parsed = JSON.parse(raw.toString('utf8'));
      value = parsed && typeof parsed === 'object' ? parsed : null;
    } catch { /* malformed legacy state remains safely readable as null */ }
    return {
      expectedDestination: snapshot.expectedDestination,
      raw,
      value,
    };
  } catch {
    return null;
  }
}

function contextCapturedAt(sidecar) {
  return typeof sidecar?.value?.capturedAt === 'number'
    && Number.isFinite(sidecar.value.capturedAt)
    ? sidecar.value.capturedAt
    : null;
}

function legacyContextIsNewer(legacy, current) {
  const legacyAt = contextCapturedAt(legacy);
  const currentAt = contextCapturedAt(current);
  if (legacyAt === null) return false;
  if (currentAt === null) return true;
  return legacyAt > currentAt;
}

// Copy into the namespace with an atomic publication, then remove only the
// exact legacy inode that was read. This avoids rename-overwrite races on
// platforms where a legacy file can be refreshed while migration is running.
function publishMigratedContext(sourcePath, targetPath, source, targetExpected) {
  try {
    writeFileAtomic(targetPath, source.raw, {
      expectedDestination: targetExpected || null,
    });
    try { removeOwnedRegularFile(sourcePath, source.expectedDestination); } catch { /* retry next call */ }
    return true;
  } catch {
    return false;
  }
}

function usableContext(sidecar, nowMs) {
  return !!sidecar && isFresh(sidecar.value?.capturedAt, nowMs)
    && validContextWindowSize(sidecar.value?.contextWindowSize) !== null;
}

function migrateLegacyRateContext(cachePath, sessionId, nowMs) {
  const sourcePath = legacyRateLimitsContextPath(cachePath, sessionId);
  const targetPath = rateLimitsContextPath(cachePath, sessionId);
  if (sourcePath === targetPath) return;

  const source = contextSidecar(sourcePath);
  if (!usableContext(source, nowMs)) return;
  const target = contextSidecar(targetPath);
  if (!target) {
    publishMigratedContext(sourcePath, targetPath, source, null);
    return;
  }

  // A collision is resolved by the captured timestamp, not by path age or
  // directory order. Never discard a newer legacy observation merely because
  // the new leaf was published first.
  if (!usableContext(target, nowMs) || legacyContextIsNewer(source, target)) {
    publishMigratedContext(sourcePath, targetPath, source, target.expectedDestination);
  } else {
    try { removeOwnedRegularFile(sourcePath, source.expectedDestination); } catch { /* retry next call */ }
  }
}

function readContextSidecar(cachePath, sessionId, nowMs) {
  migrateLegacyRateContext(cachePath, sessionId, nowMs);
  const current = contextSidecar(rateLimitsContextPath(cachePath, sessionId));
  const legacy = contextSidecar(legacyRateLimitsContextPath(cachePath, sessionId));
  const candidates = [current, legacy].filter((entry) => usableContext(entry, nowMs));
  candidates.sort((a, b) => {
    const left = contextCapturedAt(a) ?? -Infinity;
    const right = contextCapturedAt(b) ?? -Infinity;
    return right - left;
  });
  return validContextWindowSize(candidates[0]?.value?.contextWindowSize);
}

export function pruneRateContextSidecars(cachePath, nowMs, testInterlock = null, prefix = RATE_CONTEXT_NAMESPACE) {
  const namespace = rateContextNamespace(cachePath, prefix);
  let handle;
  try {
    handle = opendirSync(namespace);
  } catch (error) {
    return { incomplete: error.code !== 'ENOENT', truncated: false, visits: 0 };
  }
  const candidates = [];
  const nowNs = BigInt(Math.trunc(nowMs)) * 1_000_000n;
  const maxAgeNs = BigInt(RATE_LIMITS_MAX_AGE_MS) * 1_000_000n;
  let visits = 0;
  let incomplete = false;
  let truncated = false;
  try {
    while (visits < RATE_CONTEXT_VISIT_LIMIT) {
      let entry;
      try { entry = handle.readSync(); } catch { incomplete = true; break; }
      if (entry === null) break;
      visits += 1;
      if (!RATE_CONTEXT_NAME_RE.test(entry.name) || !entry.isFile()) continue;
      const sidecar = join(namespace, entry.name);
      try {
        const identity = regularFileIdentity(sidecar);
        if (!identity) continue;
        if (nowNs - identity.mtimeNs > maxAgeNs) {
          // stat/lstat is only an observation. The entry may be atomically
          // replaced by a fresh sidecar before removal, so remove only the
          // exact observed regular file after moving it to quarantine.
          testInterlock?.('prune-rate-context-before-remove');
          try { removeOwnedRegularFile(sidecar, identity, { testInterlock }); } catch { /* best effort */ }
          continue;
        }
        candidates.push({ path: sidecar, identity, mtimeNs: identity.mtimeNs });
      } catch {
        // A concurrent writer or cleanup may have removed it already.
      }
    }
    if (visits >= RATE_CONTEXT_VISIT_LIMIT) {
      try { truncated = handle.readSync() !== null; } catch { incomplete = true; }
    }
  } finally {
    try { handle.closeSync(); } catch { incomplete = true; }
  }
  candidates.sort((a, b) => a.mtimeNs === b.mtimeNs ? 0 : a.mtimeNs > b.mtimeNs ? -1 : 1);
  for (const entry of candidates.slice(RATE_CONTEXT_MAX_SESSIONS)) {
    testInterlock?.('prune-rate-context-before-remove');
    try { removeOwnedRegularFile(entry.path, entry.identity, { testInterlock }); } catch { /* best effort */ }
  }
  return { incomplete, truncated, visits };
}

/**
 * Persist rate state scoped to this session and its context window.
 *
 * Context and quota observations live in separate hashed sidecars, so another
 * session cannot erase their fallback values. The shared quota file remains
 * readable by older runtimes; each slot still carries its session hash and
 * original observation time. Writes and bounded cleanup are best-effort.
 */
export function persistRateLimitsCache(
  cachePath,
  fiveHour,
  sevenDay,
  effort,
  contextWindowSize,
  sessionId,
  nowMs = Date.now(),
  options = {},
) {
  const contextSize = validContextWindowSize(contextWindowSize);
  const existing = readJson(cachePath);
  const existingRates = sessionRateState(cachePath, sessionId,
    validRateState(existing) ? existing : null, nowMs);
  const sessionHash = rateQuotaSessionHash(sessionId);
  const retainRateSlot = (key, incoming) => {
    if (usableRateSlot(incoming)) return { slot: incoming, capturedAt: nowMs, sessionHash };
    const previous = existingRates?.[key];
    const capturedAt = rateSlotCapturedAt(existingRates, key);
    const sameSession = sessionHash !== null
      && existingRates?.[`${key}SessionHash`] === sessionHash;
    return sameSession && usableRateSlot(previous) && isFresh(capturedAt, nowMs)
      ? { slot: previous, capturedAt, sessionHash }
      : { slot: null, capturedAt: null, sessionHash: null };
  };
  const nextFiveHour = retainRateSlot('fiveHour', fiveHour);
  const nextSevenDay = retainRateSlot('sevenDay', sevenDay);
  const hasRateState = usableRateSlot(fiveHour) || usableRateSlot(sevenDay);

  if (hasRateState || !existing) {
    const global = {
      version: 4,
      // Preserve an omitted window only within its session and with its
      // original observation time; another session cannot inherit its quota.
      fiveHour: nextFiveHour.slot,
      fiveHourCapturedAt: nextFiveHour.capturedAt,
      fiveHourSessionHash: nextFiveHour.sessionHash,
      sevenDay: nextSevenDay.slot,
      sevenDayCapturedAt: nextSevenDay.capturedAt,
      sevenDaySessionHash: nextSevenDay.sessionHash,
      capturedAt: hasRateState
        ? nowMs
        : (existing && typeof existing.capturedAt === 'number' ? existing.capturedAt : nowMs),
    };
    // Keep reading old effort fields for compatibility, but do not claim that
    // cah-stamp renders them; effort is available only in the status envelope.
    if (typeof effort === 'string') global.effort = effort;
    const quotaPath = rateLimitsQuotaPath(cachePath, sessionId);
    if (hasRateState && quotaPath) writeJsonAtomic(quotaPath, global);
    writeJsonAtomic(cachePath, global);
  }

  if (contextSize !== null) {
    writeJsonAtomic(rateLimitsContextPath(cachePath, sessionId), {
      version: 1,
      contextWindowSize: contextSize,
      capturedAt: nowMs,
    });
  }
  migrateLegacyRateContext(cachePath, sessionId, nowMs);
  pruneRateContextSidecars(cachePath, nowMs, options.testInterlock);
  pruneRateContextSidecars(cachePath, nowMs, null, 'rate-quota');
}

/**
 * Read quota slots for the requested session plus its context window.
 * Legacy quota records without a session hash are not reused for a named
 * session; old context entries retain their existing compatibility rules.
 *
 * @param {string} cachePath absolute path to the base cache JSON file
 * @param {number} [nowMs=Date.now()] injected for testability of staleness
 * @param {string|null} [sessionId=null] session whose context may be used
 */
export function readRateLimitsCache(cachePath, nowMs = Date.now(), sessionId = null, options = {}) {
  const base = readJson(cachePath);
  const globalFresh = base && isFresh(base.capturedAt, nowMs);
  let contextWindowSize = readContextSidecar(cachePath, sessionId, nowMs);

  if (contextWindowSize === null && globalFresh) {
    const baseSessionMatches = sessionId == null
      || base.sessionId == null
      || base.sessionId === sessionId;
    if (baseSessionMatches) contextWindowSize = validContextWindowSize(base.contextWindowSize);
  }

  const rates = sessionRateState(cachePath, sessionId, base, nowMs);
  const fiveHourFresh = rates && rateSlotSessionMatches(rates, 'fiveHour', sessionId)
    && isFresh(rateSlotCapturedAt(rates, 'fiveHour'), nowMs);
  const sevenDayFresh = rates && rateSlotSessionMatches(rates, 'sevenDay', sessionId)
    && isFresh(rateSlotCapturedAt(rates, 'sevenDay'), nowMs);
  if (!globalFresh && contextWindowSize === null && !fiveHourFresh && !sevenDayFresh) return null;
  return {
    fiveHour: fiveHourFresh ? (rates.fiveHour || null) : null,
    sevenDay: sevenDayFresh ? (rates.sevenDay || null) : null,
    // Kept for compatibility with older cache readers. cah-stamp deliberately
    // omits effort because the hook payload does not identify its turn's level.
    effort: globalFresh && typeof base.effort === 'string' ? base.effort : null,
    contextWindowSize,
  };
}

// A brief upstream omission must not make the statusLine quota flicker. Reuse
// only a recent same-session Claude observation whose reset is still future.
export function readStatusLineRateFallback(cachePath, key, sessionId, modelId, nowMs = Date.now(), diagnostics = null) {
  const reject = (reason) => {
    if (diagnostics) diagnostics.reason = reason;
    return null;
  };
  if (diagnostics) Object.assign(diagnostics, { reason: 'not_attempted', ageMs: null });
  if (key !== 'fiveHour' && key !== 'sevenDay') return reject('not_attempted');
  if (typeof sessionId !== 'string' || !sessionId) return reject('session_missing');
  if (typeof modelId !== 'string' || !modelId) return reject('model_missing');
  if (!modelId.startsWith('claude-')) return reject('model_not_claude');
  const observation = diagnostics ? { key } : null;
  const cache = sessionRateState(cachePath, sessionId, readJson(cachePath), nowMs, observation);
  if (diagnostics) Object.assign(diagnostics, { reason: observation.reason, ageMs: observation.ageMs });
  if (!rateSlotSessionMatches(cache, key, sessionId)) return null;
  const capturedAt = rateSlotCapturedAt(cache, key);
  const slot = cache?.[key];
  if (!usableRateSlot(slot)) return reject('slot_invalid');
  if (!isFresh(capturedAt, nowMs)
      || nowMs - capturedAt > STATUSLINE_RATE_FALLBACK_MAX_AGE_MS) return reject('stale');
  if (typeof slot.resetsAt !== 'string') return reject('reset_missing');
  const resetAt = Date.parse(slot.resetsAt);
  if (!Number.isFinite(resetAt)) return reject('reset_invalid');
  if (resetAt <= nowMs) return reject('reset_elapsed');
  if (diagnostics) diagnostics.reason = 'cache';
  return slot;
}
