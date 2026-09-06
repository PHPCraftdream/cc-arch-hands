# cc-arch-hands review — round 40

- Date: 2026-09-06
- Reviewer: HS (Maxwell), read-only review; tests were not run by the reviewer
- Reviewed HEAD: `2f62854`
- Result: 4 P3

## Findings

### P3 — marker capacity transaction lacks reconciliation

Crash or unlink failure after publishing a new marker can leave 65 markers or orphaned capacity fences; repeated sessions can accumulate them.

Required fix: use one recoverable capacity transaction slot and reconcile it before every publication, restoring uncommitted victims and finishing committed eviction.

### P3 — legacy marker claim migration is unreachable/incomplete

Migration scans only marker filenames, so old `.cah-marker-claim-*` entries can be missed, especially after the migration sentinel or scan cap.

Required fix: address the current session's legacy claim on every invocation independently of bulk migration/sentinel completion.

### P3 — legacy stamp lock migration is unreachable and uses the wrong custom directory

The state filter excludes `.json.lock`; old and new hooks can acquire distinct locks. Custom throttle paths are scanned under the default cache root instead of their own directory.

Required fix: migrate the current session lock directly from `dirname(throttlePath)` before new acquisition and separate state/lock predicates.

### P3 — cache maintenance metadata is merged twice

`visits` and failures are duplicated by layered merge calls, causing inaccurate metrics and repeated CLI warnings.

Required fix: perform one structured metadata merge and project only required top-level recovery paths separately.

## Disposition

Round 40 is not clean. Apply another HL cycle and repeat HS review until `P1–P3 findings: none`.
