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

export function ownerTimestamp(owner) {
  for (const key of ['timestamp', 'startedAt', 'claimedAt']) {
    if (Number.isFinite(owner?.[key])) return owner[key];
  }
  return null;
}

// Exact renewLease() semantics: a missing or future-dated heartbeat is
// expired, and so is one older than the lease period. A live publisher keeps
// its heartbeat fresh via renewLease(); only an abandoned lease fails this.
export function leaseExpired(owner, nowMs, maxLeaseMs = LEASE_MAX_MS) {
  const timestamp = ownerTimestamp(owner);
  return timestamp === null || nowMs < timestamp || nowMs - timestamp > maxLeaseMs;
}
