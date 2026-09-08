// The shared lease heartbeat/expiry rule.
//
// lease-lock.js (the lease owner) and fs-atomic-publication.js (committed-
// fence recovery deferral) both need "is this recorded heartbeat still
// alive" arithmetic, but neither may import the other: the companion runtime
// publication order derives from the local import graph, and lease-lock.js
// sits downstream of fs-atomic-publication.js (lease-lock -> fsutil ->
// fs-atomic -> fs-atomic-publication). This dependency-free leaf keeps one
// implementation of the expiry rule importable from both sides.

export const LEASE_MAX_MS = 5 * 60 * 1000;

// A reclaiming process captures its own nowMs once, at the start of its
// acquire/renew attempt (lease-lock.js's acquireLease/renewLease). Under
// real concurrent contention (many processes racing to claim the same
// marker), that process can be descheduled long enough for a DIFFERENT,
// still-legitimate owner to write a *later* timestamp before the comparison
// actually runs — nowMs then reads as "before" a perfectly fresh lease with
// no actual clock rollback involved. This tolerance absorbs that ordinary
// scheduling jitter while staying far below both LEASE_MAX_MS and the
// hours-scale backward jump (NTP correction, VM snapshot restore) this rule
// exists to catch.
export const FUTURE_SKEW_TOLERANCE_MS = 5000;

export function ownerTimestamp(owner) {
  for (const key of ['timestamp', 'startedAt', 'claimedAt']) {
    if (Number.isFinite(owner?.[key])) return owner[key];
  }
  return null;
}

// Exact renewLease() semantics: a missing or future-dated (beyond ordinary
// scheduling skew) heartbeat is expired, and so is one older than the lease
// period. A live publisher keeps its heartbeat fresh via renewLease(); only
// an abandoned lease fails this.
export function leaseExpired(owner, nowMs, maxLeaseMs = LEASE_MAX_MS) {
  const timestamp = ownerTimestamp(owner);
  return timestamp === null
    || nowMs < timestamp - FUTURE_SKEW_TOLERANCE_MS
    || nowMs - timestamp > maxLeaseMs;
}
