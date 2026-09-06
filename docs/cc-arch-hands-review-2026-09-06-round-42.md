# cc-arch-hands review — round 42

- Date: 2026-09-06
- Reviewer: HS (Heisenberg), read-only review; tests were not run by the reviewer
- Reviewed HEAD: `9721447`
- Result: 2 P2, 2 P3

## Findings

### P2 — default stamp migration can unlink its own destination

The default throttle path already resides in the new namespace. Migration receives identical source/target paths and can remove active state.

Required fix: treat normalized-equal paths as already migrated and exclude destination namespaces from legacy roots.

### P2 — bin lifecycle lease is not checked inside atomic publication

A stale publisher can lose its lease while atomic write retries/pauses and still perform the final rename under a successor operation.

Required fix: pass a generation-aware ownership callback into atomic helpers and check after waits and before every mutation/retry.

### P3 — empty marker transaction directory wedges the namespace

Crash before state write or between state unlink and directory removal leaves an empty transaction directory classified indeterminate forever.

Required fix: atomically publish the complete transaction state or reconcile a proven-empty directory while holding capacity ownership.

### P3 — migration recovery lacks persisted publication proof

After full-capacity legacy marker publication, a crash before the in-memory key update can leave a timestamped/nonce marker that recovery cannot recognize.

Required fix: persist expected payload digest/semantic proof before publication and validate it during recovery.

## Disposition

Round 42 is not clean. Apply another HL cycle and repeat HS review until `P1–P3 findings: none`.
