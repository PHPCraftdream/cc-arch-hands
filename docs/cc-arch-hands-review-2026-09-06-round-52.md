# cc-arch-hands review — round 52

- Reviewed HEAD: `b31ca8c2bed9372a23f0271d398d7393b5713a13`
- Mode: strictly read-only
- P0/P2 findings: none
- Result: 3 P1, 2 P3

## Findings

### P1 — retired owner can poison a successor transaction

Validate current generation before creating retirement entries; recovery must tolerate and identity-safely remove multiple empty stale reservations.

### P1 — pre-proof crash temp wedges marker capacity

Resolve/quarantine exact transaction temps before retirement, or retain state until every accepted temp is gone. Cover a real process crash before proof creation.

### P1 — importer disabling removes dependencies first

Preflight all disables, apply reverse topological order, and protect dependency closure whenever an importer cannot be proven removable.

### P3 — README bins inventory omits two runtime leaves

Add `lib/fs-atomic-publication.js` and `lib/marker-capacity-stage.js`.

### P3 — dead and duplicate repair helpers remain

Remove unused `recordRepublishFailure()` and share one rollback-state predicate.

## Disposition

Round 52 is not clean. Close all findings and repeat the read-only review.
