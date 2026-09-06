# cc-arch-hands review — round 45

- Baseline: `v0.6.2` (`149b7d3`)
- Reviewed HEAD: `9d8a86462e144bb381278cc9557972415b80f097`
- Mode: strictly read-only; tests and installs were not run
- Result: 1 P1, 2 P2, 2 P3
- P0 findings: none

## Findings

### P1 — publication crashes can permanently wedge a destination and remove its canonical runtime leaf

`lib/fs-atomic-publication.js:218` moves the old destination into the fence before creating the replacement. A crash or lease loss between those operations leaves the canonical path absent; later crashes can leave it multi-linked beside an occupied fence. Successor writes cannot recover the persistent transaction, cleanup failures are swallowed, and generic maintenance lacks publication ownership proof. Persist enough generation/publication proof to restore or finish every crash boundary and do not report success while cleanup is incomplete.

### P2 — `writeFileAtomic()` now exposes a non-atomic canonical vacancy

`publishWithFence()` removes the existing canonical entry before recreating it. Concurrent readers can observe `ENOENT`, and a crash makes the vacancy permanent. Keep the old canonical entry visible until one atomic replacement operation; fencing must protect that operation rather than removing the destination first.

### P2 — companion publication order places an importer before its runtime dependencies

`lib/binstall.js` publishes `lease-lock.js` before `fs-atomic.js` and `fsutil.js`, although `lease-lock.js` imports `fsutil.js`, which imports `fs-atomic.js`. Correct the dependency order and derive or validate it against local-module imports rather than encoding a defective expected order.

### P3 — capacity-stage reconciliation is not fenced by the capacity-lease generation

`claimMarker()` invokes stage reconciliation without an ownership assertion. Reconciliation can mutate a successor's deterministic stage after lease loss and does not condition child deletion on the captured exact identity. Pass generation-aware ownership through current and legacy reconciliation, assert before every mutation, and use exact child identity.

### P3 — companion-runtime inventory documents `lease-lock.js` twice

`CLAUDE.md` lists `lib/lease-lock.js` twice. Remove the duplicate and align documentation with the corrected runtime dependency graph.

## Disposition

Round 45 is not clean. Apply another HL cycle and repeat HS review until `P1–P3 findings: none`.
