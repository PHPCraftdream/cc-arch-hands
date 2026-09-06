# cc-arch-hands review — round 39

- Date: 2026-09-06
- Reviewer: HS (Locke), read-only review; tests were not run by the reviewer
- Reviewed HEAD: `1b8a237`
- Result: 1 P2, 5 P3

## Findings

### P2 — bin install and uninstall lack one lifecycle fence

Concurrent cooperative install/remove transactions can interleave and leave a partial runtime despite per-leaf snapshots.

Required fix: hold one recoverable operation lease across complete preflight, publication/removal, maintenance, and rollback for both operations.

### P3 — recovery output limits are computed but not enforced

Small requested limits can still return thousands of recovery rows.

Required fix: enforce independent bucket limits while retaining displaced-first visitation.

### P3 — exact-cap recovery scans report false truncation

A scan that visits exactly the cap cannot distinguish EOF and reports `truncated` persistently.

Required fix: use one bounded lookahead read to distinguish exact EOF from additional entries.

### P3 — maintenance metadata is dropped by generic callers

Commands, agents, skills, and bin-root pruning can discard `incomplete/truncated/visits/failures` and succeed without warning.

Required fix: aggregate maintenance metadata through every result and CLI report path.

### P3 — marker capacity eviction is not failure-atomic

The old marker is deleted before stdout/new marker durability; crash or write failure can lose dedupe without replacement. Fence cleanup failures can also leave unbounded prune artifacts.

Required fix: use a recoverable two-phase capacity transaction and evict only after durable replacement, restoring every uncommitted victim.

### P3 — hook maintenance enumerates the shared cache without a bound

Marker and sidecar sweeps materialize the entire cache directory on routine hook invocations.

Required fix: place bounded marker/sidecar families in dedicated owned directories and stream/cap maintenance inside each namespace.

## Disposition

Round 39 is not clean. Apply another HL cycle and repeat HS review until `P1–P3 findings: none`.
